import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { defineConfig, type Plugin } from "vite";
import { controlUiManualChunk } from "./config/control-ui-chunking.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outDir = path.resolve(here, "../dist/control-ui");
const require = createRequire(import.meta.url);
const json5EsmPath = require.resolve("json5/dist/index.mjs");
type ControlUiViteAlias = {
  find: string | RegExp;
  replacement: string;
};
const commonJsOptimizeDeps = [
  "highlight.js/lib/core",
  "highlight.js/lib/languages/bash",
  "highlight.js/lib/languages/cpp",
  "highlight.js/lib/languages/css",
  "highlight.js/lib/languages/diff",
  "highlight.js/lib/languages/go",
  "highlight.js/lib/languages/java",
  "highlight.js/lib/languages/javascript",
  "highlight.js/lib/languages/json",
  "highlight.js/lib/languages/markdown",
  "highlight.js/lib/languages/python",
  "highlight.js/lib/languages/rust",
  "highlight.js/lib/languages/typescript",
  "highlight.js/lib/languages/xml",
  "highlight.js/lib/languages/yaml",
] as const;

const PM_EXPORT_VIEWER_ENTRY = path.resolve(here, "src/ui/protocol-monitor-export-viewer.ts");
const PM_EXPORT_VIEWER_PUBLIC_PATH = "/pm-export-viewer.js";

async function bundleProtocolMonitorExportViewer(
  opts: { minify: boolean } = { minify: false },
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [PM_EXPORT_VIEWER_ENTRY],
    bundle: true,
    format: "iife",
    globalName: "__openclawPmExportViewer",
    platform: "browser",
    target: "es2022",
    write: false,
    minify: opts.minify,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
  return result.outputFiles[0]?.text ?? "";
}

/**
 * Bundles the Protocol Monitor export viewer entry into a single self-contained
 * IIFE. In dev, it is served over a Vite middleware at /pm-export-viewer.js and
 * rebuilt on each request so source edits are picked up without restarting.
 * In production, it is emitted alongside the main bundle so the export handler
 * can fetch it (same-origin) and inline it into the standalone HTML report.
 */
function protocolMonitorExportViewerPlugin(): Plugin {
  let isDev = false;
  return {
    name: "openclaw:pm-export-viewer",
    configResolved(config) {
      isDev = config.command === "serve";
    },
    configureServer(server) {
      server.middlewares.use(PM_EXPORT_VIEWER_PUBLIC_PATH, async (_req, res, next) => {
        try {
          const code = await bundleProtocolMonitorExportViewer({ minify: false });
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(code);
        } catch (err) {
          next(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    async closeBundle() {
      if (isDev) {
        return;
      }
      const outDir = path.resolve(here, "../dist/control-ui");
      const code = await bundleProtocolMonitorExportViewer({ minify: true });
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "pm-export-viewer.js"), code, "utf-8");
    },
  };
}

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

function normalizeBuildId(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.slice(0, 96) || "dev";
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "dev";
  } catch {
    return "dev";
  }
}

function readGitShortSha(): string | null {
  try {
    const raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function resolveControlUiBuildId(): string {
  const explicit =
    process.env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim() || process.env.OPENCLAW_VERSION?.trim();
  if (explicit) {
    return normalizeBuildId(explicit);
  }
  const version = readPackageVersion();
  const gitSha = readGitShortSha();
  return normalizeBuildId(gitSha ? `${version}-${gitSha}` : version);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortTsconfigPathEntries(entries: Array<[string, unknown]>): Array<[string, unknown]> {
  return entries.toSorted(([left], [right]) => {
    const leftPrefixLength = left.includes("*") ? left.indexOf("*") : left.length;
    const rightPrefixLength = right.includes("*") ? right.indexOf("*") : right.length;
    if (leftPrefixLength !== rightPrefixLength) {
      return rightPrefixLength - leftPrefixLength;
    }
    return right.length - left.length || left.localeCompare(right);
  });
}

function resolveTsconfigTargetPath(target: string): string {
  return path.resolve(repoRoot, target.replace(/^\.\//, ""));
}

function resolveTsconfigPathAlias(key: string, target: string): ControlUiViteAlias | null {
  const keyWildcardIndex = key.indexOf("*");
  const targetWildcardIndex = target.indexOf("*");
  if (keyWildcardIndex === -1 || targetWildcardIndex === -1) {
    if (keyWildcardIndex !== -1 || targetWildcardIndex !== -1) {
      return null;
    }
    return {
      find: key,
      replacement: resolveTsconfigTargetPath(target),
    };
  }

  if (
    key.slice(keyWildcardIndex + 1).includes("*") ||
    target.slice(targetWildcardIndex + 1).includes("*")
  ) {
    return null;
  }

  const prefix = key.slice(0, keyWildcardIndex);
  const suffix = key.slice(keyWildcardIndex + 1);
  return {
    find: new RegExp(`^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`),
    replacement: resolveTsconfigTargetPath(target).replace("*", "$1"),
  };
}

export function resolveTsconfigPathAliasesForVite(): ControlUiViteAlias[] {
  const raw = fs.readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    compilerOptions?: { paths?: Record<string, unknown> };
  };
  const paths = parsed.compilerOptions?.paths;
  if (!paths) {
    return [];
  }

  return sortTsconfigPathEntries(Object.entries(paths)).flatMap(([key, targets]) => {
    if (!Array.isArray(targets) || typeof targets[0] !== "string") {
      return [];
    }
    const alias = resolveTsconfigPathAlias(key, targets[0]);
    return alias ? [alias] : [];
  });
}

function controlUiServiceWorkerBuildIdPlugin(buildId: string): Plugin {
  return {
    name: "control-ui-service-worker-build-id",
    apply: "build",
    closeBundle() {
      const swPath = path.join(outDir, "sw.js");
      const publicSwPath = path.join(here, "public/sw.js");
      const source = fs.readFileSync(fs.existsSync(swPath) ? swPath : publicSwPath, "utf8");
      const placeholder = '"__OPENCLAW_CONTROL_UI_BUILD_ID__"';
      const updated = source.replace(placeholder, JSON.stringify(buildId));
      if (updated === source) {
        throw new Error(`Control UI service worker build id placeholder missing in ${swPath}`);
      }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(swPath, updated);
    },
  };
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  const controlUiBuildId = resolveControlUiBuildId();
  return {
    base,
    define: {
      OPENCLAW_CONTROL_UI_BUILD_ID: JSON.stringify(controlUiBuildId),
    },
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: [
        "ipaddr.js",
        "lit/directives/repeat.js",
        "markdown-it-task-lists",
        ...commonJsOptimizeDeps,
      ],
    },
    resolve: {
      alias: [{ find: "json5", replacement: json5EsmPath }, ...resolveTsconfigPathAliasesForVite()],
    },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: controlUiManualChunk,
        },
      },
      // Keep CI/onboard logs clean; the app chunk is split into stable runtime buckets above.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
    plugins: [
      controlUiServiceWorkerBuildIdPlugin(controlUiBuildId),
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use("/__openclaw/control-ui-config.json", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                basePath: "/",
                assistantName: "",
                assistantAvatar: "",
              }),
            );
          });
        },
      },
      protocolMonitorExportViewerPlugin(),
    ],
  };
});
