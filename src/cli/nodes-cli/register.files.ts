import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

async function downloadFile(
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

async function uploadFile(
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
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function collectLocalFiles(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  const SKIP = new Set(["node_modules", ".git", "__pycache__", ".DS_Store"]);
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(dirent.name)) {
      continue;
    }
    const relPath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isFile()) {
      results.push(relPath);
    } else if (dirent.isDirectory()) {
      results.push(...collectLocalFiles(path.join(dir, dirent.name), relPath));
    }
  }
  return results;
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

  // ── openclaw nodes copy ────────────────────────────────────────────
  //
  // Copies files between the gateway (local) and a remote node.
  //   --from node:<path>   --to <local-path>     (download from node)
  //   --from <local-path>  --to node:<path>      (upload to node)
  //
  // The "node:" prefix on either --from or --to indicates the remote side.

  nodesCallOpts(
    nodes
      .command("copy")
      .description("Copy files between gateway and a remote node (prefix remote paths with node:)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--from <source>", "Source path (prefix with node: for remote)")
      .requiredOption("--to <destination>", "Destination path (prefix with node: for remote)")
      .option("--overwrite", "Overwrite existing files", false)
      .action(
        async (
          opts: NodesRpcOpts & {
            from: string;
            to: string;
            overwrite: boolean;
          },
        ) => {
          await runNodesCommand("copy", async () => {
            const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
            if (!nodeId) {
              const { error } = getNodesTheme();
              defaultRuntime.error(error("--node required"));
              defaultRuntime.exit(1);
              return;
            }

            const fromRemote = opts.from.startsWith("node:");
            const toRemote = opts.to.startsWith("node:");

            if (fromRemote === toRemote) {
              throw new Error(
                'exactly one of --from or --to must have a "node:" prefix (e.g. --from node:C:\\path --to ./local)',
              );
            }

            if (fromRemote) {
              // Download: node → gateway
              const remotePath = opts.from.slice("node:".length);
              const localPath = opts.to;
              await copyFromNode(opts, nodeId, remotePath, localPath, opts.overwrite);
            } else {
              // Upload: gateway → node
              const localPath = opts.from;
              const remotePath = opts.to.slice("node:".length);
              await copyToNode(opts, nodeId, localPath, remotePath, opts.overwrite);
            }
          });
        },
      ),
    { timeoutMs: 120_000 },
  );
}

async function copyFromNode(
  opts: NodesRpcOpts,
  nodeId: string,
  remotePath: string,
  localPath: string,
  overwrite: boolean,
): Promise<void> {
  const stat = await invokeNodeFs<FsStatResult>(opts, nodeId, "fs.stat", {
    path: remotePath,
  });
  if (!stat.exists) {
    throw new Error(`remote path does not exist: ${remotePath}`);
  }

  if (stat.isFile) {
    if (fs.existsSync(localPath) && !overwrite) {
      throw new Error(`local file already exists: ${localPath} (use --overwrite)`);
    }
    const bytes = await downloadFile(opts, nodeId, remotePath, localPath, stat.size ?? 0);
    defaultRuntime.log(`Copied ${remotePath} → ${localPath} (${formatBytes(bytes)})`);
  } else if (stat.isDirectory) {
    const listing = await invokeNodeFs<FsListResult>(opts, nodeId, "fs.list", {
      path: remotePath,
      recursive: true,
    });
    const files = listing.entries.filter((e) => e.isFile);
    let totalBytes = 0;
    for (const entry of files) {
      const dest = path.join(localPath, entry.relativePath);
      if (fs.existsSync(dest) && !overwrite) {
        defaultRuntime.error(`  skip (exists): ${entry.relativePath}`);
        continue;
      }
      const remoteFilePath = remotePath + "/" + entry.relativePath;
      const bytes = await downloadFile(opts, nodeId, remoteFilePath, dest, entry.size);
      totalBytes += bytes;
      defaultRuntime.log(`  ${entry.relativePath} (${formatBytes(bytes)})`);
    }
    defaultRuntime.log(`\nCopied ${files.length} files (${formatBytes(totalBytes)}) to ${localPath}`);
  }
}

async function copyToNode(
  opts: NodesRpcOpts,
  nodeId: string,
  localPath: string,
  remotePath: string,
  overwrite: boolean,
): Promise<void> {
  const localStat = fs.statSync(localPath);

  if (localStat.isFile()) {
    if (!overwrite) {
      const remoteStat = await invokeNodeFs<FsStatResult>(opts, nodeId, "fs.stat", {
        path: remotePath,
      });
      if (remoteStat.exists) {
        throw new Error(`remote file already exists: ${remotePath} (use --overwrite)`);
      }
    }
    const bytes = await uploadFile(opts, nodeId, localPath, remotePath);
    defaultRuntime.log(`Copied ${localPath} → ${remotePath} (${formatBytes(bytes)})`);
  } else if (localStat.isDirectory()) {
    const localFiles = collectLocalFiles(localPath);
    let totalBytes = 0;
    for (const relPath of localFiles) {
      const fullLocal = path.join(localPath, relPath);
      const fullRemote = remotePath + "/" + relPath.replace(/\\/g, "/");
      const bytes = await uploadFile(opts, nodeId, fullLocal, fullRemote);
      totalBytes += bytes;
      defaultRuntime.log(`  ${relPath} (${formatBytes(bytes)})`);
    }
    defaultRuntime.log(
      `\nCopied ${localFiles.length} files (${formatBytes(totalBytes)}) to ${remotePath}`,
    );
  } else {
    throw new Error(`unsupported local path type: ${localPath}`);
  }
}
