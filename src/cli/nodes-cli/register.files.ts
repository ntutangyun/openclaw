import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { buildNodeInvokeParams, callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

// 16MB raw chunks → ~21MB base64, within the 25MB WebSocket limit.
const CHUNK_SIZE = 16 * 1024 * 1024;

type FsStatResult = {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
};

type FsListResult = {
  entries: Array<{ relativePath: string; isFile: boolean; size: number }>;
};

type FsReadResult = {
  data: string;
  totalSize: number;
  offset: number;
  length: number;
};

async function invokeNodeFs<T>(
  opts: NodesRpcOpts,
  nodeId: string,
  command: string,
  params: Record<string, unknown>,
): Promise<T> {
  const result = await callGatewayCli(
    "node.invoke",
    opts,
    buildNodeInvokeParams({
      nodeId,
      command,
      params,
      timeoutMs: 60_000,
      idempotencyKey: randomUUID(),
    }),
    { transportTimeoutMs: 120_000 },
  );
  if (result && typeof result === "object" && "payload" in result) {
    return (result as { payload: T }).payload;
  }
  return result as T;
}

async function pullFile(
  opts: NodesRpcOpts,
  nodeId: string,
  remotePath: string,
  localPath: string,
  totalSize: number,
): Promise<number> {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  let offset = 0;
  let first = true;
  while (offset < totalSize) {
    const chunk = await invokeNodeFs<FsReadResult>(opts, nodeId, "fs.read", {
      path: remotePath,
      offset,
      length: CHUNK_SIZE,
    });
    const buf = Buffer.from(chunk.data, "base64");
    if (first) {
      fs.writeFileSync(localPath, buf);
      first = false;
    } else {
      fs.appendFileSync(localPath, buf);
    }
    offset += chunk.length;
  }
  // Handle zero-byte files
  if (first) {
    fs.writeFileSync(localPath, Buffer.alloc(0));
  }
  return offset;
}

async function pushFile(
  opts: NodesRpcOpts,
  nodeId: string,
  localPath: string,
  remotePath: string,
): Promise<number> {
  const stat = fs.statSync(localPath);
  const totalSize = stat.size;

  if (totalSize === 0) {
    await invokeNodeFs(opts, nodeId, "fs.write", {
      path: remotePath,
      data: "",
      mkdirp: true,
    });
    return 0;
  }

  const fd = fs.openSync(localPath, "r");
  try {
    let offset = 0;
    let first = true;
    while (offset < totalSize) {
      const readLen = Math.min(CHUNK_SIZE, totalSize - offset);
      const buf = Buffer.alloc(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, offset);
      await invokeNodeFs(opts, nodeId, "fs.write", {
        path: remotePath,
        data: buf.subarray(0, bytesRead).toString("base64"),
        append: !first,
        mkdirp: first,
      });
      offset += bytesRead;
      first = false;
    }
    return offset;
  } finally {
    fs.closeSync(fd);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerNodesFilesCommands(nodes: Command) {
  // ── openclaw nodes ls ──────────────────────────────────────────────

  nodesCallOpts(
    nodes
      .command("ls")
      .description("List files on a remote node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--path <remotePath>", "Remote path to list")
      .option("--recursive", "Recurse into subdirectories", true)
      .option("--no-recursive", "Do not recurse")
      .action(async (opts: NodesRpcOpts & { path: string; recursive: boolean }) => {
        await runNodesCommand("ls", async () => {
          const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
          const remotePath = opts.path;
          if (!nodeId || !remotePath) {
            const { error } = getNodesTheme();
            defaultRuntime.error(error("--node and --path required"));
            defaultRuntime.exit(1);
            return;
          }
          const result = await invokeNodeFs<FsListResult>(opts, nodeId, "fs.list", {
            path: remotePath,
            recursive: opts.recursive,
          });
          for (const entry of result.entries) {
            const suffix = entry.isFile ? ` (${formatBytes(entry.size)})` : "/";
            defaultRuntime.log(`${entry.relativePath}${suffix}`);
          }
          defaultRuntime.log(`\n${result.entries.length} entries`);
        });
      }),
    { timeoutMs: 60_000 },
  );

  // ── openclaw nodes pull ────────────────────────────────────────────

  nodesCallOpts(
    nodes
      .command("pull")
      .description("Pull files from a remote node to the local workspace")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--remote <remotePath>", "Remote path on the node")
      .option("--local <localPath>", "Local destination path")
      .option("--overwrite", "Overwrite existing local files", false)
      .action(
        async (
          opts: NodesRpcOpts & {
            remote: string;
            local?: string;
            overwrite: boolean;
          },
        ) => {
          await runNodesCommand("pull", async () => {
            const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
            const remotePath = opts.remote;
            if (!nodeId || !remotePath) {
              const { error } = getNodesTheme();
              defaultRuntime.error(error("--node and --remote required"));
              defaultRuntime.exit(1);
              return;
            }

            const stat = await invokeNodeFs<FsStatResult>(opts, nodeId, "fs.stat", {
              path: remotePath,
            });
            if (!stat.exists) {
              throw new Error(`remote path does not exist: ${remotePath}`);
            }

            if (stat.isFile) {
              // Pull single file
              const localPath = opts.local ?? path.basename(remotePath);
              if (fs.existsSync(localPath) && !opts.overwrite) {
                throw new Error(`local file already exists: ${localPath} (use --overwrite)`);
              }
              const bytes = await pullFile(opts, nodeId, remotePath, localPath, stat.size ?? 0);
              defaultRuntime.log(`Pulled ${localPath} (${formatBytes(bytes)})`);
            } else if (stat.isDirectory) {
              // Pull directory
              const localDir = opts.local ?? path.basename(remotePath);
              const listing = await invokeNodeFs<FsListResult>(opts, nodeId, "fs.list", {
                path: remotePath,
                recursive: true,
              });
              const files = listing.entries.filter((e) => e.isFile);
              let totalBytes = 0;
              for (const entry of files) {
                const localPath = path.join(localDir, entry.relativePath);
                if (fs.existsSync(localPath) && !opts.overwrite) {
                  defaultRuntime.error(`  skip (exists): ${entry.relativePath}`);
                  continue;
                }
                const remoteFilePath = remotePath + "/" + entry.relativePath;
                const bytes = await pullFile(opts, nodeId, remoteFilePath, localPath, entry.size);
                totalBytes += bytes;
                defaultRuntime.log(`  ${entry.relativePath} (${formatBytes(bytes)})`);
              }
              defaultRuntime.log(
                `\nPulled ${files.length} files (${formatBytes(totalBytes)}) to ${localDir}`,
              );
            }
          });
        },
      ),
    { timeoutMs: 120_000 },
  );

  // ── openclaw nodes push ────────────────────────────────────────────

  nodesCallOpts(
    nodes
      .command("push")
      .description("Push files from the local workspace to a remote node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--local <localPath>", "Local source path")
      .requiredOption("--remote <remotePath>", "Remote destination path on the node")
      .option("--overwrite", "Overwrite existing remote files", false)
      .action(
        async (
          opts: NodesRpcOpts & {
            local: string;
            remote: string;
            overwrite: boolean;
          },
        ) => {
          await runNodesCommand("push", async () => {
            const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
            const localPath = opts.local;
            const remotePath = opts.remote;
            if (!nodeId || !localPath || !remotePath) {
              const { error } = getNodesTheme();
              defaultRuntime.error(error("--node, --local, and --remote required"));
              defaultRuntime.exit(1);
              return;
            }

            const localStat = fs.statSync(localPath);

            if (localStat.isFile()) {
              // Push single file
              if (!opts.overwrite) {
                const remoteStat = await invokeNodeFs<FsStatResult>(opts, nodeId, "fs.stat", {
                  path: remotePath,
                });
                if (remoteStat.exists) {
                  throw new Error(
                    `remote file already exists: ${remotePath} (use --overwrite)`,
                  );
                }
              }
              const bytes = await pushFile(opts, nodeId, localPath, remotePath);
              defaultRuntime.log(`Pushed ${localPath} → ${remotePath} (${formatBytes(bytes)})`);
            } else if (localStat.isDirectory()) {
              // Push directory
              const localFiles = collectLocalFiles(localPath);
              let totalBytes = 0;
              for (const relPath of localFiles) {
                const fullLocal = path.join(localPath, relPath);
                const fullRemote = remotePath + "/" + relPath.replace(/\\/g, "/");
                const bytes = await pushFile(opts, nodeId, fullLocal, fullRemote);
                totalBytes += bytes;
                defaultRuntime.log(`  ${relPath} (${formatBytes(bytes)})`);
              }
              defaultRuntime.log(
                `\nPushed ${localFiles.length} files (${formatBytes(totalBytes)}) to ${remotePath}`,
              );
            } else {
              throw new Error(`unsupported local path type: ${localPath}`);
            }
          });
        },
      ),
    { timeoutMs: 120_000 },
  );
}

function collectLocalFiles(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  const SKIP = new Set(["node_modules", ".git", "__pycache__", ".DS_Store"]);
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(dirent.name)) continue;
    const relPath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isFile()) {
      results.push(relPath);
    } else if (dirent.isDirectory()) {
      results.push(...collectLocalFiles(path.join(dir, dirent.name), relPath));
    }
  }
  return results;
}
