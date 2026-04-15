import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

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

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
    plugins: [
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
