import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GatewayClient } from "../gateway/client.js";
import {
  ensureExecApprovals,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  saveExecApprovals,
  type ExecAsk,
  type ExecApprovalsFile,
  type ExecApprovalsResolved,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import {
  requestExecHostViaSocket,
  type ExecHostRequest,
  type ExecHostResponse,
} from "../infra/exec-host.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../infra/windows-encoding.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { buildSystemRunApprovalPlan, handleSystemRunInvoke } from "./invoke-system-run.js";
import type {
  ExecEventPayload,
  ExecFinishedEventParams,
  RunResult,
  SkillBinsProvider,
  SystemRunParams,
} from "./invoke-types.js";
import { invokeRegisteredNodeHostCommand } from "./plugin-node-host.js";

const FS_READ_CHUNK_SIZE = 16 * 1024 * 1024; // 16MB raw → ~21MB base64, fits 25MB WS limit
const FS_LIST_SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".DS_Store"]);

const OUTPUT_CAP = 200_000;
const OUTPUT_EVENT_TAIL = 20_000;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const execHostEnforced =
  normalizeLowercaseStringOrEmpty(process.env.OPENCLAW_NODE_EXEC_HOST ?? "") === "app";
const execHostFallbackAllowed =
  normalizeLowercaseStringOrEmpty(process.env.OPENCLAW_NODE_EXEC_FALLBACK ?? "") !== "0";
const preferMacAppExecHost = process.platform === "darwin" && execHostEnforced;

/**
 * Wrap a command string in double quotes for use as a bash -c argument that
 * passes through cmd.exe (shell:true on Windows).  Only double quotes inside
 * the command need escaping — cmd.exe does not treat backslashes specially
 * inside quoted strings.
 */
function wrapForCmdBash(arg: string): string {
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

/**
 * Convert a Git Bash / MSYS2 path like `/c/Users/...` to Windows `C:\Users\...`.
 * Also normalizes forward slashes to backslashes on Windows. Non-matching paths
 * are returned unchanged.
 */
function normalizeNodeFsPath(p: string): string {
  if (process.platform !== "win32") {
    return p;
  }
  const trimmed = p.trim();
  const match = /^\/([a-zA-Z])(\/.*)?$/.exec(trimmed);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = (match[2] ?? "").replace(/\//g, "\\");
    return `${drive}:${rest || "\\"}`;
  }
  return trimmed;
}

/** Recursively collect directory entries up to a maximum count. */
function collectDirectoryEntries(
  rootDir: string,
  currentDir: string,
  recursive: boolean,
  maxEntries: number,
  entries: Array<{ relativePath: string; isFile: boolean; size: number }>,
): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (entries.length >= maxEntries) {
      return;
    }
    if (FS_LIST_SKIP_DIRS.has(dirent.name)) {
      continue;
    }
    const fullPath = path.join(currentDir, dirent.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
    const isFile = dirent.isFile();
    const isDir = dirent.isDirectory();
    if (isFile) {
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        // skip files we can't stat
      }
      entries.push({ relativePath, isFile: true, size });
    } else if (isDir) {
      entries.push({ relativePath, isFile: false, size: 0 });
      if (recursive) {
        collectDirectoryEntries(rootDir, fullPath, true, maxEntries, entries);
      }
    }
  }
}

type SystemWhichParams = {
  bins: string[];
};

type SystemExecApprovalsSetParams = {
  file: ExecApprovalsFile;
  baseHash?: string | null;
};

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

type NodeInvokeRequestPayload = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  idempotencyKey?: string | null;
};

export type { SkillBinsProvider } from "./invoke-types.js";

function resolveExecSecurity(value?: string): ExecSecurity {
  return value === "deny" || value === "allowlist" || value === "full" ? value : "allowlist";
}

function isCmdExeInvocation(argv: string[]): boolean {
  const token = argv[0]?.trim();
  if (!token) {
    return false;
  }
  const base = normalizeLowercaseStringOrEmpty(path.win32.basename(token));
  return base === "cmd.exe" || base === "cmd";
}

function resolveExecAsk(value?: string): ExecAsk {
  return value === "off" || value === "on-miss" || value === "always" ? value : "on-miss";
}

export function sanitizeEnv(overrides?: Record<string, string> | null): Record<string, string> {
  return sanitizeHostExecEnv({ overrides, blockPathOverrides: true });
}

function truncateOutput(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false };
  }
  return { text: `... (truncated) ${raw.slice(raw.length - maxChars)}`, truncated: true };
}

export function decodeCapturedOutputBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  return decodeWindowsOutputBuffer(params);
}

function redactExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  return {
    ...file,
    socket: socketPath ? { path: socketPath } : undefined,
  };
}

function requireExecApprovalsBaseHash(
  params: SystemExecApprovalsSetParams,
  snapshot: ExecApprovalsSnapshot,
) {
  if (!snapshot.exists) {
    return;
  }
  if (!snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash unavailable; reload and retry");
  }
  const baseHash = typeof params.baseHash === "string" ? params.baseHash.trim() : "";
  if (!baseHash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash required; reload and retry");
  }
  if (baseHash !== snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
  }
}

async function runCommand(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
): Promise<RunResult> {
  return await new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const windowsEncoding = resolveWindowsConsoleEncoding();

    // On Windows with shell:true, Node.js already routes through cmd.exe.
    // If the argv was pre-wrapped as ["cmd.exe", "/d", "/s", "/c", <command>]
    // by the gateway, unwrap it to avoid double cmd.exe invocation which
    // destroys quoting for PowerShell, Python, and other nested commands.
    let spawnCmd: string;
    let spawnArgs: string[];
    const isWindowsCmdWrap =
      process.platform === "win32" &&
      argv.length >= 4 &&
      argv[0].toLowerCase().endsWith("cmd.exe") &&
      argv
        .slice(1, -1)
        .map((a) => a.toLowerCase())
        .join(" ") === "/d /s /c";

    // OPENCLAW_NODE_SHELL overrides the default Windows shell (cmd.exe) with a
    // custom shell such as Git Bash.  When set, we spawn the shell directly with
    // -c instead of relying on Node.js shell:true (which always uses cmd.exe
    // flags /d /s /c that are incompatible with bash-like shells).
    const customShell =
      process.platform === "win32" ? process.env.OPENCLAW_NODE_SHELL?.trim() || null : null;

    if (customShell && (isWindowsCmdWrap || argv.length === 1)) {
      // Extract the raw command string and route it through the custom shell.
      // We keep shell:true (which uses cmd.exe) and let cmd.exe launch the
      // custom shell — this avoids ENOENT on paths with spaces like
      // "C:\Program Files\Git\bin\bash.exe" that spawn without shell:true
      // cannot handle on Windows.
      const rawCommand = isWindowsCmdWrap ? argv[argv.length - 1] : argv[0];
      spawnCmd = `"${customShell}" -c ${wrapForCmdBash(rawCommand)}`;
      spawnArgs = [];
    } else if (isWindowsCmdWrap) {
      // Pass the raw command string to shell:true which handles it natively
      spawnCmd = argv[argv.length - 1];
      spawnArgs = [];
    } else {
      spawnCmd = argv[0];
      spawnArgs = argv.slice(1);
    }

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(process.platform === "win32" ? { shell: true } : {}),
    });

    const onChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (outputLen >= OUTPUT_CAP) {
        truncated = true;
        return;
      }
      const remaining = OUTPUT_CAP - outputLen;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      outputLen += slice.length;
      if (target === "stdout") {
        stdoutChunks.push(slice);
      } else {
        stderrChunks.push(slice);
      }
      if (chunk.length > remaining) {
        truncated = true;
      }
    };

    child.stdout?.on("data", (chunk) => onChunk(chunk as Buffer, "stdout"));
    child.stderr?.on("data", (chunk) => onChunk(chunk as Buffer, "stderr"));

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    const finalize = (exitCode?: number, error?: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      const stdout = decodeCapturedOutputBuffer({
        buffer: Buffer.concat(stdoutChunks),
        windowsEncoding,
      });
      const stderr = decodeCapturedOutputBuffer({
        buffer: Buffer.concat(stderrChunks),
        windowsEncoding,
      });
      resolve({
        exitCode,
        timedOut,
        success: exitCode === 0 && !timedOut && !error,
        stdout,
        stderr,
        error: error ?? null,
        truncated,
      });
    };

    child.on("error", (err) => {
      finalize(undefined, err.message);
    });
    child.on("exit", (code) => {
      finalize(code === null ? undefined : code, null);
    });
  });
}

function resolveEnvPath(env?: Record<string, string>): string[] {
  const raw =
    env?.PATH ??
    (env as Record<string, string>)?.Path ??
    process.env.PATH ??
    process.env.Path ??
    DEFAULT_NODE_PATH;
  return raw.split(path.delimiter).filter(Boolean);
}

function resolveExecutable(bin: string, env?: Record<string, string>) {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((ext) => normalizeLowercaseStringOrEmpty(ext))
      : [""];
  for (const dir of resolveEnvPath(env)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function handleSystemWhich(params: SystemWhichParams, env?: Record<string, string>) {
  const bins = params.bins.map((bin) => bin.trim()).filter(Boolean);
  const found: Record<string, string> = {};
  for (const bin of bins) {
    const path = resolveExecutable(bin, env);
    if (path) {
      found[bin] = path;
    }
  }
  return { bins: found };
}

function buildExecEventPayload(payload: ExecEventPayload): ExecEventPayload {
  if (!payload.output) {
    return payload;
  }
  const trimmed = payload.output.trim();
  if (!trimmed) {
    return payload;
  }
  const { text } = truncateOutput(trimmed, OUTPUT_EVENT_TAIL);
  return { ...payload, output: text };
}

async function sendExecFinishedEvent(
  params: ExecFinishedEventParams & {
    client: GatewayClient;
  },
) {
  const combined = [params.result.stdout, params.result.stderr, params.result.error]
    .filter(Boolean)
    .join("\n");
  await sendNodeEvent(
    params.client,
    "exec.finished",
    buildExecEventPayload({
      sessionKey: params.sessionKey,
      runId: params.runId,
      host: "node",
      command: params.commandText,
      exitCode: params.result.exitCode ?? undefined,
      timedOut: params.result.timedOut,
      success: params.result.success,
      output: combined,
      suppressNotifyOnExit: params.suppressNotifyOnExit,
    }),
  );
}

async function runViaMacAppExecHost(params: {
  approvals: ExecApprovalsResolved;
  request: ExecHostRequest;
}): Promise<ExecHostResponse | null> {
  const { approvals, request } = params;
  return await requestExecHostViaSocket({
    socketPath: approvals.socketPath,
    token: approvals.token,
    request,
  });
}

async function sendJsonPayloadResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  payload: unknown,
) {
  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON: JSON.stringify(payload),
  });
}

async function sendRawPayloadResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  payloadJSON: string,
) {
  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON,
  });
}

async function sendErrorResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  code: string,
  message: string,
) {
  await sendInvokeResult(client, frame, {
    ok: false,
    error: { code, message },
  });
}

async function sendInvalidRequestResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  err: unknown,
) {
  await sendErrorResult(client, frame, "INVALID_REQUEST", String(err));
}

export async function handleInvoke(
  frame: NodeInvokeRequestPayload,
  client: GatewayClient,
  skillBins: SkillBinsProvider,
) {
  const command = frame.command ?? "";
  if (command === "system.execApprovals.get") {
    try {
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: snapshot.path,
        exists: snapshot.exists,
        hash: snapshot.hash,
        file: redactExecApprovals(snapshot.file),
      };
      await sendJsonPayloadResult(client, frame, payload);
    } catch (err) {
      const message = String(err);
      const code = normalizeLowercaseStringOrEmpty(message).includes("timed out")
        ? "TIMEOUT"
        : "INVALID_REQUEST";
      await sendErrorResult(client, frame, code, message);
    }
    return;
  }

  if (command === "system.execApprovals.set") {
    try {
      const params = decodeParams<SystemExecApprovalsSetParams>(frame.paramsJSON);
      if (!params.file || typeof params.file !== "object") {
        throw new Error("INVALID_REQUEST: exec approvals file required");
      }
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      requireExecApprovalsBaseHash(params, snapshot);
      const normalized = normalizeExecApprovals(params.file);
      const next = mergeExecApprovalsSocketDefaults({ normalized, current: snapshot.file });
      saveExecApprovals(next);
      const nextSnapshot = readExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: nextSnapshot.path,
        exists: nextSnapshot.exists,
        hash: nextSnapshot.hash,
        file: redactExecApprovals(nextSnapshot.file),
      };
      await sendJsonPayloadResult(client, frame, payload);
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command === "system.which") {
    try {
      const params = decodeParams<SystemWhichParams>(frame.paramsJSON);
      if (!Array.isArray(params.bins)) {
        throw new Error("INVALID_REQUEST: bins required");
      }
      const env = sanitizeEnv(undefined);
      const payload = await handleSystemWhich(params, env);
      await sendJsonPayloadResult(client, frame, payload);
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  // ── fs.* file transfer commands ──────────────────────────────────────

  if (command === "fs.stat") {
    try {
      const params = decodeParams<{ path: string }>(frame.paramsJSON);
      const filePath = normalizeNodeFsPath(params.path);
      try {
        const stat = fs.statSync(filePath);
        await sendJsonPayloadResult(client, frame, {
          exists: true,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch {
        await sendJsonPayloadResult(client, frame, { exists: false });
      }
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command === "fs.list") {
    try {
      const params = decodeParams<{
        path: string;
        recursive?: boolean;
        maxEntries?: number;
      }>(frame.paramsJSON);
      const dirPath = normalizeNodeFsPath(params.path);
      const maxEntries = params.maxEntries ?? 10_000;
      const entries: Array<{ relativePath: string; isFile: boolean; size: number }> = [];
      collectDirectoryEntries(dirPath, dirPath, params.recursive !== false, maxEntries, entries);
      await sendJsonPayloadResult(client, frame, { entries });
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command === "fs.read") {
    try {
      const params = decodeParams<{
        path: string;
        offset?: number;
        length?: number;
      }>(frame.paramsJSON);
      const filePath = normalizeNodeFsPath(params.path);
      const stat = fs.statSync(filePath);
      const totalSize = stat.size;
      const offset = params.offset ?? 0;
      const length = Math.min(params.length ?? totalSize, FS_READ_CHUNK_SIZE, totalSize - offset);
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, offset);
        await sendJsonPayloadResult(client, frame, {
          data: buf.subarray(0, bytesRead).toString("base64"),
          totalSize,
          offset,
          length: bytesRead,
        });
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command === "fs.write") {
    try {
      const params = decodeParams<{
        path: string;
        data: string;
        append?: boolean;
        mkdirp?: boolean;
      }>(frame.paramsJSON);
      const filePath = normalizeNodeFsPath(params.path);
      if (params.mkdirp) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      }
      const buf = Buffer.from(params.data, "base64");
      if (params.append) {
        fs.appendFileSync(filePath, buf);
      } else {
        fs.writeFileSync(filePath, buf);
      }
      await sendJsonPayloadResult(client, frame, {
        ok: true,
        bytesWritten: buf.length,
        path: filePath,
      });
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  // ── Plugin commands ────────────────────────────────────────────────

  try {
    const pluginNodeHostResult = await invokeRegisteredNodeHostCommand(command, frame.paramsJSON);
    if (pluginNodeHostResult !== null) {
      await sendRawPayloadResult(client, frame, pluginNodeHostResult);
      return;
    }
  } catch (err) {
    await sendInvalidRequestResult(client, frame, err);
    return;
  }

  if (command === "system.run.prepare") {
    try {
      const params = decodeParams<{
        command?: unknown;
        rawCommand?: unknown;
        cwd?: unknown;
        agentId?: unknown;
        sessionKey?: unknown;
      }>(frame.paramsJSON);
      const prepared = buildSystemRunApprovalPlan(params);
      if (!prepared.ok) {
        await sendErrorResult(client, frame, "INVALID_REQUEST", prepared.message);
        return;
      }
      await sendJsonPayloadResult(client, frame, {
        plan: prepared.plan,
      });
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command !== "system.run") {
    await sendErrorResult(client, frame, "UNAVAILABLE", "command not supported");
    return;
  }

  let params: SystemRunParams;
  try {
    params = decodeParams<SystemRunParams>(frame.paramsJSON);
  } catch (err) {
    await sendInvalidRequestResult(client, frame, err);
    return;
  }

  if (!Array.isArray(params.command) || params.command.length === 0) {
    await sendErrorResult(client, frame, "INVALID_REQUEST", "command required");
    return;
  }

  await handleSystemRunInvoke({
    client,
    params,
    skillBins,
    execHostEnforced,
    execHostFallbackAllowed,
    resolveExecSecurity,
    resolveExecAsk,
    isCmdExeInvocation,
    sanitizeEnv,
    runCommand,
    runViaMacAppExecHost,
    sendNodeEvent,
    buildExecEventPayload,
    sendInvokeResult: async (result) => {
      await sendInvokeResult(client, frame, result);
    },
    sendExecFinishedEvent: async ({ sessionKey, runId, commandText, result }) => {
      await sendExecFinishedEvent({ client, sessionKey, runId, commandText, result });
    },
    preferMacAppExecHost,
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- CLI JSON params are typed by the invoked method.
function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

export function coerceNodeInvokePayload(payload: unknown): NodeInvokeRequestPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!id || !nodeId || !command) {
    return null;
  }
  const paramsJSON =
    typeof obj.paramsJSON === "string"
      ? obj.paramsJSON
      : obj.params !== undefined
        ? JSON.stringify(obj.params)
        : null;
  const timeoutMs = typeof obj.timeoutMs === "number" ? obj.timeoutMs : null;
  const idempotencyKey = typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : null;
  return {
    id,
    nodeId,
    command,
    paramsJSON,
    timeoutMs,
    idempotencyKey,
  };
}

async function sendInvokeResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
) {
  try {
    await client.request("node.invoke.result", buildNodeInvokeResultParams(frame, result));
  } catch {
    // ignore: node invoke responses are best-effort
  }
}

export function buildNodeInvokeResultParams(
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
): {
  id: string;
  nodeId: string;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
} {
  const params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string;
    error?: { code?: string; message?: string };
  } = {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: result.ok,
  };
  if (result.payload !== undefined) {
    params.payload = result.payload;
  }
  if (typeof result.payloadJSON === "string") {
    params.payloadJSON = result.payloadJSON;
  }
  if (result.error) {
    params.error = result.error;
  }
  return params;
}

async function sendNodeEvent(client: GatewayClient, event: string, payload: unknown) {
  try {
    await client.request("node.event", {
      event,
      payloadJSON: payload ? JSON.stringify(payload) : null,
    });
  } catch {
    // ignore: node events are best-effort
  }
}
