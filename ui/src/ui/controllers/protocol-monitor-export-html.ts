import type { SessionsUsageResult } from "../types.js";
import type { NetworkDirection, ProtocolMonitorSubTab } from "../views/protocol-monitor.ts";
import type { CoalescedGroup, ProtocolTraceRecord } from "./protocol-monitor.ts";
import { snapshotLatencyCaches } from "./protocol-monitor.ts";

/**
 * Host surface required to build a standalone HTML report of the Protocol
 * Monitor page. This is a superset of the live `ProtocolMonitorHost` — it also
 * needs the usage result and UI state fields that drive what's on screen.
 */
export type ProtocolMonitorExportHost = {
  protocolTraces: ProtocolTraceRecord[];
  protocolMonitoringPaused: boolean;
  protocolSubTab: ProtocolMonitorSubTab;
  protocolModelFilter: string | null;
  protocolDisabledTypes: Set<string>;
  protocolNetworkDirection: NetworkDirection;
  protocolSelectedTrace: ProtocolTraceRecord | CoalescedGroup | null;
  usageResult: SessionsUsageResult | null;
};

const VIEWER_PUBLIC_PATH = "pm-export-viewer.js";
const SNAPSHOT_ELEMENT_ID = "__openclaw_pm_snapshot__";
const MOUNT_ELEMENT_ID = "openclaw-pm-export-root";

function resolveViewerUrl(): string {
  // The viewer is emitted alongside the main UI bundle, so it lives at the
  // same base path as the current control UI document. Using a base-relative
  // URL keeps this working under both the dev server and the packaged gateway.
  const base = document.baseURI || window.location.href;
  return new URL(VIEWER_PUBLIC_PATH, base).toString();
}

async function fetchViewerBundle(): Promise<string> {
  const url = resolveViewerUrl();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch Protocol Monitor export viewer bundle (${res.status})`);
  }
  return await res.text();
}

function buildSnapshot(host: ProtocolMonitorExportHost, capturedAt: number) {
  return {
    version: 1 as const,
    capturedAt,
    traces: host.protocolTraces,
    latencyCaches: snapshotLatencyCaches(),
    usageTotals: host.usageResult?.totals ?? null,
    usageAggregates: host.usageResult?.aggregates ?? null,
    usageSessions: host.usageResult?.sessions ?? [],
    ui: {
      subTab: host.protocolSubTab,
      modelFilter: host.protocolModelFilter,
      disabledTypes: [...host.protocolDisabledTypes],
      networkDirection: host.protocolNetworkDirection,
    },
  };
}

// JSON embedded in a <script type="application/json"> tag cannot contain the
// byte sequence "</script" verbatim — the HTML parser terminates the script
// element on the first </ it sees, and matching is case-insensitive. Escape
// the forward slash so the result is indistinguishable as JSON but safe to
// inline. Also guard against U+2028/U+2029 which crash some older tools
// consuming the raw text.
function escapeJsonForHtmlScript(json: string): string {
  return json
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Same hazard as above, but for JavaScript inlined into a <script> block.
// String literals in the bundle may legitimately contain "</script" (e.g. HTML
// fragments in lit-html templates); splitting the tag keeps the host parser
// from mistaking them for the closing script tag.
function escapeJsForHtmlScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1");
}

function buildExportHtml(params: {
  snapshotJson: string;
  viewerJs: string;
  capturedAt: number;
}): string {
  const safeSnapshot = escapeJsonForHtmlScript(params.snapshotJson);
  const safeViewer = escapeJsForHtmlScript(params.viewerJs);
  const title = `OpenClaw Protocol Monitor — ${new Date(params.capturedAt).toISOString()}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<!-- Empty data-URI favicon stops Chromium from auto-probing a favicon, which
     logs "Unsafe attempt to load URL … from frame with URL …" on file:// since
     every file: URL is treated as a unique security origin. -->
<link rel="icon" href="data:," />
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #f8f9fc; color: #1a1a2e; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  /* The live view's .pm-root uses height:100% + overflow:hidden, so the mount
     needs a bounded height — otherwise the sequence diagram's overflow-y:auto
     container expands to fit all rows and the page itself becomes the scroller. */
  #${MOUNT_ELEMENT_ID} { height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  .openclaw-pm-export-loading { padding: 24px; font-size: 13px; color: #6b7280; }
  .openclaw-pm-export-error { padding: 24px; font-size: 13px; color: #991b1b; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="${MOUNT_ELEMENT_ID}"><div class="openclaw-pm-export-loading">Loading snapshot…</div></div>
<script id="${SNAPSHOT_ELEMENT_ID}" type="application/json">${safeSnapshot}</script>
<script>
try {
${safeViewer}
} catch (err) {
  var root = document.getElementById(${JSON.stringify(MOUNT_ELEMENT_ID)});
  if (root) {
    root.innerHTML = "";
    var pre = document.createElement("div");
    pre.className = "openclaw-pm-export-error";
    pre.textContent = "Failed to render Protocol Monitor export: " + (err && err.stack || err);
    root.appendChild(pre);
  }
  throw err;
}
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function triggerDownload(html: string, filename: string) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Build and download a standalone HTML report of the current Protocol Monitor
 * state. If monitoring was not already paused, it is paused first so the
 * snapshot is stable for the duration of serialization. It stays paused after
 * the download — the user clicked export because they wanted to inspect the
 * exact state, and silently resuming would race with that inspection.
 */
export async function exportProtocolMonitorHtml(
  host: ProtocolMonitorExportHost & { protocolMonitoringPaused: boolean },
): Promise<void> {
  // Direct assignment on the Lit @state() field triggers reactivity, which
  // flips handleProtocolTraceEvent's short-circuit guard and freezes both the
  // trace buffer and the latency caches before we serialize.
  if (!host.protocolMonitoringPaused) {
    host.protocolMonitoringPaused = true;
  }

  const capturedAt = Date.now();
  const snapshot = buildSnapshot(host, capturedAt);
  const snapshotJson = JSON.stringify(snapshot);

  const viewerJs = await fetchViewerBundle();
  const html = buildExportHtml({ snapshotJson, viewerJs, capturedAt });

  const ts = new Date(capturedAt).toISOString().replace(/[:.]/g, "-");
  triggerDownload(html, `protocol-monitor-${ts}.html`);
}
