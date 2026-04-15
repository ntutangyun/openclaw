// Exported Protocol Monitor HTML viewer entry.
//
// This file is bundled into a single self-contained IIFE and inlined into the
// .html report produced by `exportProtocolMonitorHtml`. It re-uses the exact
// same Lit view code as the live control UI, driven by a frozen JSON snapshot
// embedded in the HTML document.
//
// Live-only controls (refresh, export, reset, pause, auto-scroll) are hidden
// via `exportMode=true`. Interactivity for tab switching, filter toggles,
// trace-detail modals, and explainer overlays is preserved.

import { render } from "lit";
import type { ProtocolTraceRecord } from "./controllers/protocol-monitor.ts";
import {
  rehydrateLatencyCaches,
  type LatencyCacheSnapshot,
} from "./controllers/protocol-monitor.ts";
import type { NetworkDirection, ProtocolMonitorSubTab } from "./views/protocol-monitor.ts";
import { renderProtocolMonitor } from "./views/protocol-monitor.ts";
import type { UsageAggregates, UsageTotals } from "./views/usageTypes.ts";

type ProtocolTrace = ProtocolTraceRecord;
type CoalescedGroup = import("./controllers/protocol-monitor.ts").CoalescedGroup;

const SNAPSHOT_ELEMENT_ID = "__openclaw_pm_snapshot__";
const MOUNT_ELEMENT_ID = "openclaw-pm-export-root";

export type ProtocolMonitorExportSnapshot = {
  version: 1;
  capturedAt: number;
  traces: ProtocolTrace[];
  latencyCaches: LatencyCacheSnapshot;
  usageTotals: UsageTotals | null;
  usageAggregates: UsageAggregates | null;
  usageSessions: unknown[];
  ui: {
    subTab: ProtocolMonitorSubTab;
    modelFilter: string | null;
    disabledTypes: string[];
    networkDirection: NetworkDirection;
  };
};

type LocalState = {
  subTab: ProtocolMonitorSubTab;
  selectedTrace: ProtocolTrace | CoalescedGroup | null;
  disabledTypes: Set<string>;
  modelFilter: string | null;
  usageExplainer: string | null;
  networkDirection: NetworkDirection;
  networkExplainer: string | null;
};

function parseSnapshot(): ProtocolMonitorExportSnapshot {
  const el = document.getElementById(SNAPSHOT_ELEMENT_ID);
  if (!el) {
    throw new Error(`Protocol Monitor export snapshot (#${SNAPSHOT_ELEMENT_ID}) not found`);
  }
  const raw = el.textContent ?? "";
  const parsed = JSON.parse(raw) as ProtocolMonitorExportSnapshot;
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
    throw new Error("Unsupported Protocol Monitor export snapshot version");
  }
  return parsed;
}

function noop() {
  // Placeholder for live-only callbacks that are hidden in export mode.
}

function mount(snapshot: ProtocolMonitorExportSnapshot) {
  const host = document.getElementById(MOUNT_ELEMENT_ID);
  if (!host) {
    throw new Error(`Mount point #${MOUNT_ELEMENT_ID} not found`);
  }

  // Lit's render() appends its own marker-delimited content into the container
  // and does not strip pre-existing children. The host currently holds the
  // "Loading snapshot…" placeholder; clear it so the live view is what the
  // user sees (otherwise the placeholder stays pinned to the top of the page).
  while (host.firstChild) {
    host.removeChild(host.firstChild);
  }

  const state: LocalState = {
    subTab: snapshot.ui.subTab,
    selectedTrace: null,
    disabledTypes: new Set(snapshot.ui.disabledTypes),
    modelFilter: snapshot.ui.modelFilter,
    usageExplainer: null,
    networkDirection: snapshot.ui.networkDirection,
    networkExplainer: null,
  };

  const draw = () => {
    render(
      renderProtocolMonitor({
        traces: snapshot.traces,
        loading: false,
        selectedTrace: state.selectedTrace,
        autoScroll: false,
        disabledTypes: state.disabledTypes,
        subTab: state.subTab,
        modelFilter: state.modelFilter,
        usageTotals: snapshot.usageTotals,
        usageAggregates: snapshot.usageAggregates,
        usageSessions: snapshot.usageSessions,
        usageLoading: false,
        usageExplainer: state.usageExplainer,
        monitoringPaused: true,
        networkDirection: state.networkDirection,
        networkExplainer: state.networkExplainer,
        exportMode: true,
        exportCapturedAt: snapshot.capturedAt,
        onOpenUsageExplainer: (key) => {
          state.usageExplainer = key;
          draw();
        },
        onCloseUsageExplainer: () => {
          state.usageExplainer = null;
          draw();
        },
        onToggleMonitoring: noop,
        onNetworkDirectionChange: (dir) => {
          state.networkDirection = dir;
          draw();
        },
        onOpenNetworkExplainer: (key) => {
          state.networkExplainer = key;
          draw();
        },
        onCloseNetworkExplainer: () => {
          state.networkExplainer = null;
          draw();
        },
        onSubTabChange: (t) => {
          state.subTab = t;
          draw();
        },
        onToggleAutoScroll: noop,
        onSelectTrace: (t) => {
          state.selectedTrace = t;
          draw();
        },
        onClearSelection: () => {
          state.selectedTrace = null;
          draw();
        },
        onRefresh: noop,
        onExport: noop,
        onReset: noop,
        onModelFilterChange: (model) => {
          state.modelFilter = model;
          draw();
        },
        onToggleType: (key) => {
          const next = new Set(state.disabledTypes);
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }
          state.disabledTypes = next;
          draw();
        },
      }),
      host,
    );
  };

  rehydrateLatencyCaches(snapshot.latencyCaches);
  draw();
}

function boot() {
  const snapshot = parseSnapshot();
  mount(snapshot);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
