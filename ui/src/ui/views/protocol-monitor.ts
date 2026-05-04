import { html, svg, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import type {
  ProtocolTraceRecord,
  CoalescedGroup,
  CoalescedEntry,
  MessageTypeStats,
  AgentLlmEventBar,
  AgentLlmEventCategory,
  MessageBar,
  MessagesDirection,
  NetworkStats,
  PayloadByteStats,
  ThroughputDirectionStats,
  ThroughputSample,
  LatencyStats,
  LatencySample,
  ChatMessage,
  ToolCallMessage,
} from "../controllers/protocol-monitor.ts";
import {
  coalesceTraces,
  filterTraces,
  computeMessageTypes,
  computeNetworkStats,
  extractChatMessages,
  extractToolCalls,
  extractModels,
  buildRunModelMap,
  filterTracesByModel,
} from "../controllers/protocol-monitor.ts";
import { renderProtocolMonitorDetail } from "./protocol-monitor-detail.ts";
import { renderTerminologyPane } from "./protocol-monitor-terminology.ts";
import {
  type UsageInsightStats,
  buildUsageInsightStats,
  formatCost,
  formatTokens,
} from "./usage-metrics.ts";
import type { UsageTotals, UsageAggregates } from "./usageTypes.ts";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ProtocolMonitorSubTab = "protocol" | "terminology" | "settings";

export type NetworkDirection = "op-to-gw" | "gw-to-op" | "gw-to-node" | "node-to-gw" | "agent-llm";

export type ProtocolMonitorProps = {
  traces: ProtocolTraceRecord[];
  loading: boolean;
  selectedTrace: ProtocolTraceRecord | CoalescedGroup | null;
  autoScroll: boolean;
  disabledTypes: Set<string>;
  subTab: ProtocolMonitorSubTab;
  modelFilter: string | null;
  usageTotals: UsageTotals | null;
  usageAggregates: UsageAggregates | null;
  usageSessions: unknown[];
  usageLoading: boolean;
  usageExplainer: string | null;
  monitoringPaused: boolean;
  networkDirection: NetworkDirection;
  networkExplainer: string | null;
  onOpenUsageExplainer: (key: string) => void;
  onCloseUsageExplainer: () => void;
  onToggleMonitoring: (paused: boolean) => void;
  onNetworkDirectionChange: (dir: NetworkDirection) => void;
  onOpenNetworkExplainer: (key: string) => void;
  onCloseNetworkExplainer: () => void;
  onSubTabChange: (tab: ProtocolMonitorSubTab) => void;
  onToggleAutoScroll: (v: boolean) => void;
  onSelectTrace: (t: ProtocolTraceRecord | CoalescedGroup) => void;
  onClearSelection: () => void;
  onRefresh: () => void;
  onExport: () => void;
  onReset: () => void;
  onToggleType: (key: string) => void;
  onModelFilterChange: (model: string | null) => void;
  /**
   * When rendered inside a standalone exported HTML report, `exportMode` hides
   * live-only controls (refresh, export, reset, pause toggle, auto-scroll) and
   * shows a "frozen at <timestamp>" banner. Interactivity for tab switching,
   * filter toggles, trace-detail modals, and explainer overlays is preserved.
   */
  exportMode?: boolean;
  /** Wall-clock ms of when the snapshot was taken. Only used when exportMode. */
  exportCapturedAt?: number;
  /**
   * Optional re-render hook. Called by view-local interactive widgets that
   * mutate module-level state Lit can't observe directly (e.g. the bar
   * charts' wheel-zoom range, kept in `barChartZoom`). When omitted (or in
   * the export viewer where re-renders aren't useful), those widgets still
   * update the DOM directly so the visual stays in sync until the next
   * natural re-render.
   */
  onRequestUpdate?: () => void;
};

// ---------------------------------------------------------------------------
// Column layout (5 columns now including LLM)
// ---------------------------------------------------------------------------

type Column = "operator" | "gateway" | "node" | "agent" | "llm";
const COLUMNS: Column[] = ["operator", "gateway", "node", "agent", "llm"];
const COL_INDEX: Record<Column, number> = { operator: 0, gateway: 1, node: 2, agent: 3, llm: 4 };
const COL_LABELS: Record<Column, string> = {
  operator: "Operator (STA)",
  gateway: "Gateway (AP)",
  node: "Node (PC)",
  agent: "Agent (AP)",
  llm: "Model",
};

// SVG icons for column headers — larger, displayed on a separate row above the label
const COL_ICONS: Record<Column, string> = {
  // Mobile phone
  operator: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><circle cx="12" cy="18" r="1" fill="currentColor"/><line x1="9" y1="5" x2="15" y2="5" opacity="0.5"/></svg>`,
  // WiFi router
  gateway: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9.5C5.5 5 18.5 5 22 9.5"/><path d="M5 13c2.5-3 11.5-3 14 0"/><path d="M8.5 16.5c1.5-2 5.5-2 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/></svg>`,
  // Laptop
  node: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/><line x1="7" y1="16" x2="7" y2="20"/><line x1="17" y1="16" x2="17" y2="20"/></svg>`,
  // Robot
  agent: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="3"/><circle cx="9" cy="15" r="1.5" fill="currentColor"/><circle cx="15" cy="15" r="1.5" fill="currentColor"/><path d="M12 2v4"/><circle cx="12" cy="2" r="1.5"/><path d="M4 14H2"/><path d="M22 14h-2"/></svg>`,
  // Brain / AI chip
  llm: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.5" y1="4.5" x2="6.5" y2="6.5"/><line x1="17.5" y1="17.5" x2="19.5" y2="19.5"/><line x1="4.5" y1="19.5" x2="6.5" y2="17.5"/><line x1="17.5" y1="6.5" x2="19.5" y2="4.5"/></svg>`,
};

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

function kindColor(entry: CoalescedEntry): string {
  if (entry.type === "group") {
    return "#f59e0b";
  }
  if (entry.kind === "req") {
    return "#3b82f6";
  }
  if (entry.kind === "res") {
    return entry.ok === false ? "#ef4444" : "#22c55e";
  }
  return "#f59e0b";
}

function entryLabel(entry: CoalescedEntry): string {
  if (entry.type === "group") {
    return entry.label;
  }
  return entry.method ?? entry.event ?? entry.kind;
}

/** Max chars for detail text in the sequence diagram row. */
const MAX_DETAIL_LEN = 250;

function truncateDetail(s: string): string {
  return s.length > MAX_DETAIL_LEN ? s.slice(0, MAX_DETAIL_LEN - 1) + "\u2026" : s;
}

/**
 * Extract a human-readable string from tool args at start phase.
 * Each tool type has specific args that are most useful to display.
 */
function resolveToolStartDetail(
  name: string,
  args: Record<string, unknown> | null,
  meta: string | undefined,
): string | null {
  if (!args && !meta) {
    return null;
  }

  // exec / bash / shell: show the command
  if (name === "exec" || name === "bash" || name === "shell") {
    const cmd = args?.command ?? meta;
    if (typeof cmd === "string" && cmd.trim()) {
      return `$ ${cmd.trim()}`;
    }
    return null;
  }

  // read: show file path
  if (name === "read" || name === "Read") {
    const path = args?.path ?? args?.file_path ?? meta;
    if (typeof path === "string") {
      return `read ${path}`;
    }
    return null;
  }

  // write: show file path
  if (name === "write" || name === "Write") {
    const path = args?.path ?? args?.file_path ?? meta;
    if (typeof path === "string") {
      return `write ${path}`;
    }
    return null;
  }

  // edit: show file path
  if (name === "edit" || name === "Edit") {
    const path = args?.path ?? args?.file_path ?? meta;
    if (typeof path === "string") {
      return `edit ${path}`;
    }
    return null;
  }

  // glob: show pattern
  if (name === "glob" || name === "Glob") {
    const pattern = args?.pattern ?? meta;
    const dir = args?.path;
    if (typeof pattern === "string") {
      return typeof dir === "string" ? `glob ${pattern} in ${dir}` : `glob ${pattern}`;
    }
    return null;
  }

  // grep: show pattern and optional path
  if (name === "grep" || name === "Grep") {
    const pattern = args?.pattern ?? meta;
    const path = args?.path;
    if (typeof pattern === "string") {
      return typeof path === "string" ? `grep "${pattern}" in ${path}` : `grep "${pattern}"`;
    }
    return null;
  }

  // web_search / WebSearch: show query
  if (name === "web_search" || name === "WebSearch") {
    const query = args?.query ?? meta;
    if (typeof query === "string") {
      return `search: "${query}"`;
    }
    return null;
  }

  // web_fetch / WebFetch: show URL
  if (name === "web_fetch" || name === "WebFetch") {
    const url = args?.url ?? meta;
    if (typeof url === "string") {
      return `fetch ${url}`;
    }
    return null;
  }

  // Agent (subagent): show prompt
  if (name === "agent" || name === "Agent") {
    const prompt = args?.prompt ?? args?.message ?? meta;
    if (typeof prompt === "string" && prompt.trim()) {
      return `agent: "${prompt.trim()}"`;
    }
    return null;
  }

  // notebook_edit / NotebookEdit
  if (name === "notebook_edit" || name === "NotebookEdit") {
    const path = args?.path ?? args?.notebook ?? meta;
    if (typeof path === "string") {
      return `notebook ${path}`;
    }
    return null;
  }

  // Fallback: use meta if available
  if (meta) {
    return `${name}: ${meta}`;
  }

  // Try common arg patterns
  const path = args?.path ?? args?.file_path;
  if (typeof path === "string") {
    return `${name}: ${path}`;
  }
  const query = args?.query;
  if (typeof query === "string") {
    return `${name}: "${query}"`;
  }
  const cmd = args?.command;
  if (typeof cmd === "string") {
    return `${name}: ${cmd}`;
  }

  return null;
}

/**
 * Extract text from a tool result payload.
 * Results can be: string, { content: [{ text }] }, or other shapes.
 */
function extractResultText(result: unknown): string | null {
  if (!result) {
    return null;
  }
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    // { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(r.content)) {
      for (const block of r.content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).text) {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string" && text.trim()) {
            return text.trim();
          }
        }
      }
    }
    // { text: "..." }
    if (typeof r.text === "string" && r.text.trim()) {
      return r.text.trim();
    }
  }
  return null;
}

/**
 * Generate a human-readable description for a trace entry.
 * Displayed below the method name in the message box.
 */
function entryDetail(entry: CoalescedEntry): string {
  if (entry.type === "group") {
    const dur =
      entry.events.length > 1
        ? `${((entry.events[entry.events.length - 1].ts - entry.events[0].ts) / 1000).toFixed(1)}s`
        : "";
    return truncateDetail(`${entry.events.length} chunks${dur ? ` over ${dur}` : ""}`);
  }

  const t = entry;
  const p =
    t.payload && typeof t.payload === "object" ? (t.payload as Record<string, unknown>) : null;

  // --- Agent streaming events ---
  if (t.kind === "event" && t.stream === "assistant") {
    // Resolve text from either flattened or nested payload shape
    const text =
      p?.text ??
      (p?.data && typeof p.data === "object" ? (p.data as Record<string, unknown>).text : null);
    if (typeof text === "string" && text.trim()) {
      return truncateDetail(`assistant: "${text.trim()}"`);
    }
    return "assistant: (token)";
  }
  if (t.kind === "event" && t.stream === "tool") {
    const data = p?.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : p;
    const phase = data?.phase as string | undefined;
    const name = data?.name as string | undefined;
    const meta = typeof data?.meta === "string" ? data.meta : undefined;
    const args =
      data?.args && typeof data.args === "object" ? (data.args as Record<string, unknown>) : null;

    if (phase === "start" && name) {
      // Extract tool-specific detail from args (available in start phase)
      const toolDetail = resolveToolStartDetail(name, args, meta);
      if (toolDetail) {
        return truncateDetail(toolDetail);
      }
      return truncateDetail(`run ${name}`);
    }
    if ((phase === "end" || phase === "result") && name) {
      const isErr = data?.isError === true;
      const result = data?.result;
      if (isErr) {
        const errText = extractResultText(result);
        return truncateDetail(`${name} failed${errText ? `: ${errText}` : ""}`);
      }
      const resultText = extractResultText(result);
      if (meta && resultText) {
        return truncateDetail(`${name} (${meta}) -> ${resultText}`);
      }
      if (resultText) {
        return truncateDetail(`${name} -> ${resultText}`);
      }
      if (meta) {
        return truncateDetail(`${name} done: ${meta}`);
      }
      return truncateDetail(`${name} done`);
    }
    if (phase === "update" && name) {
      const partial = data?.partialResult;
      const partialText = typeof partial === "string" ? partial.trim() : null;
      if (partialText) {
        return truncateDetail(`${name}: ${partialText}`);
      }
      return truncateDetail(`${name} running...`);
    }
    if (name) {
      return truncateDetail(`${phase ?? "tool"}: ${name}${meta ? ` ${meta}` : ""}`);
    }
    return phase ?? "tool call";
  }
  if (t.kind === "event" && t.stream === "lifecycle") {
    const data = p?.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : p;
    const phase = data?.phase as string | undefined;
    if (phase === "start") {
      return "LLM inference started";
    }
    if (phase === "end") {
      return "LLM inference complete";
    }
    if (phase === "error") {
      const err = data?.error;
      return truncateDetail(`error: ${typeof err === "string" ? err : "unknown"}`);
    }
    return phase ?? "lifecycle";
  }

  // --- Chat / session.message events (non-streaming) ---
  if (t.kind === "event" && (t.event === "chat" || t.event === "session.message")) {
    const state = p?.state as string | undefined;
    const msg =
      p?.message && typeof p.message === "object" ? (p.message as Record<string, unknown>) : null;
    const role = msg?.role as string | undefined;
    // Extract text from message.content array or direct text field
    let text: string | null = null;
    if (msg) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === "object" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            text = ((block as Record<string, unknown>).text as string).trim();
            if (text) {
              break;
            }
          }
        }
      }
      if (!text && typeof msg.text === "string" && msg.text.trim()) {
        text = msg.text.trim();
      }
    }
    // Error state
    if (state === "error") {
      const errMsg = p?.errorMessage;
      return truncateDetail(`error: ${typeof errMsg === "string" ? errMsg : "chat error"}`);
    }
    // Delta or final with text
    if (text) {
      const prefix =
        role === "assistant" ? "assistant" : role === "user" ? "user" : (role ?? "chat");
      const suffix = state === "delta" ? " ..." : "";
      return truncateDetail(`${prefix}: "${text}"${suffix}`);
    }
    if (state === "final") {
      return "chat complete";
    }
    if (state === "delta") {
      return "chat streaming...";
    }
    return t.event === "session.message" ? "session message" : "chat event";
  }

  // --- RPC methods ---
  const method = t.method;
  if (!method) {
    if (t.event) {
      // Other event types: sessions.changed, presence, etc.
      return t.event;
    }
    return t.kind;
  }

  const isReq = t.kind === "req";
  const isRes = t.kind === "res";

  // Node methods
  if (method === "node.list") {
    if (isRes && p) {
      const nodes = Array.isArray(p.nodes) ? p.nodes : Array.isArray(p) ? p : null;
      if (nodes) {
        return `${nodes.length} node${nodes.length !== 1 ? "s" : ""} connected`;
      }
    }
    return "list connected nodes";
  }
  if (method === "node.describe") {
    return isReq ? "describe node" : "node info";
  }
  if (method === "node.invoke") {
    return isReq ? "invoke node action" : "invoke result";
  }

  // Session methods
  if (method === "sessions.list") {
    if (isRes && p) {
      const sessions = Array.isArray(p.sessions) ? p.sessions : Array.isArray(p) ? p : null;
      if (sessions) {
        return `${sessions.length} session${sessions.length !== 1 ? "s" : ""}`;
      }
    }
    return "list sessions";
  }
  if (method === "sessions.send") {
    if (isReq && p) {
      const text = p.text ?? p.message ?? p.content;
      if (typeof text === "string" && text.trim()) {
        return truncateDetail(`user: "${text.trim()}"`);
      }
    }
    if (isRes) {
      return t.ok === false ? "send failed" : "message sent";
    }
    return "send message";
  }
  if (method === "sessions.create") {
    return isReq ? "create session" : "session created";
  }
  if (method === "sessions.abort") {
    return isReq ? "abort generation" : "generation aborted";
  }
  if (method === "sessions.delete") {
    return isReq ? "delete session" : "session deleted";
  }
  if (method === "sessions.subscribe") {
    return "subscribe to session";
  }
  if (method === "sessions.unsubscribe") {
    return "unsubscribe from session";
  }
  if (method === "sessions.preview") {
    return "preview session";
  }
  if (method === "sessions.patch") {
    return "update session";
  }
  if (method === "sessions.reset") {
    return "reset session";
  }

  // Chat methods
  if (method === "chat.send") {
    if (isReq && p) {
      const text = p.text ?? p.message ?? p.content;
      if (typeof text === "string" && text.trim()) {
        return truncateDetail(`user: "${text.trim()}"`);
      }
    }
    if (isRes) {
      return t.ok === false ? "chat failed" : "chat sent";
    }
    return "send chat";
  }
  if (method === "chat.history") {
    return "fetch chat history";
  }
  if (method === "chat.abort") {
    return "abort chat";
  }

  // Send (direct message)
  if (method === "send") {
    if (isReq && p) {
      const text = p.text ?? p.message ?? p.body;
      if (typeof text === "string" && text.trim()) {
        return truncateDetail(`user: "${text.trim()}"`);
      }
    }
    return isReq ? "send message" : "message sent";
  }

  // Config
  if (method === "config.get") {
    return "get config";
  }
  if (method === "config.set" || method === "config.apply" || method === "config.patch") {
    return isReq ? "update config" : "config updated";
  }

  // Usage
  if (method === "usage.status") {
    return "usage status";
  }
  if (method === "usage.cost") {
    return "usage cost";
  }

  // Status
  if (method === "health") {
    return "health check";
  }
  if (method === "status") {
    return "gateway status";
  }
  if (method === "channels.status") {
    return "channels status";
  }

  // Models / tools
  if (method === "models.list") {
    return "list models";
  }
  if (method === "tools.catalog") {
    return "list available tools";
  }
  if (method === "tools.effective") {
    return "effective tool config";
  }

  // Agents
  if (method === "agents.list") {
    return "list agents";
  }
  if (method === "agents.create") {
    return isReq ? "create agent" : "agent created";
  }

  // Pairing
  if (method.startsWith("node.pair.")) {
    const action = method.split(".").pop();
    return `node pairing: ${action}`;
  }
  if (method.startsWith("device.pair.")) {
    const action = method.split(".").pop();
    return `device pairing: ${action}`;
  }

  // Approvals
  if (method.startsWith("exec.approval")) {
    return method.replace("exec.approval.", "exec approval: ");
  }

  // Connect
  if (method === "connect") {
    return isReq ? "handshake" : "connected";
  }

  // Protocol traces
  if (method === "protocol-traces.list") {
    return "list traces";
  }
  if (method === "protocol-traces.clear") {
    return "clear traces";
  }

  // Default: humanize the method name
  return method.replace(/\./g, " ");
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Number(bytes.toFixed(2))} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const ROW_HEIGHT = 80;

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

const SUB_TABS: { id: ProtocolMonitorSubTab; label: string }[] = [
  { id: "protocol", label: "Protocol & Network" },
  { id: "terminology", label: "Terminology" },
  { id: "settings", label: "Settings" },
];

export function renderProtocolMonitor(props: ProtocolMonitorProps): TemplateResult {
  return html`
    <style>
      ${STYLES}
    </style>
    <div class="pm-root">
      <div class="pm-tab-bar">
        ${SUB_TABS.map(
          (t) => html`
            <button
              class="pm-tab-btn ${props.subTab === t.id ? "active" : ""}"
              @click=${() => props.onSubTabChange(t.id)}
            >
              ${t.label}
            </button>
          `,
        )}
        <span style="flex:1"></span>
        ${renderControlButtons(props)}
      </div>
      <div class="pm-tab-content">
        ${props.subTab === "protocol" ? renderProtocolAndNetworkPane(props) : nothing}
        ${props.subTab === "terminology" ? renderTerminologyPane() : nothing}
        ${props.subTab === "settings" ? renderSettingsPane(props) : nothing}
      </div>
      ${props.selectedTrace
        ? html`<div
            class="pm-detail-overlay"
            @click=${(e: Event) => {
              if ((e.target as HTMLElement).classList.contains("pm-detail-overlay")) {
                props.onClearSelection();
              }
            }}
          >
            <div class="pm-detail-modal">
              ${renderProtocolMonitorDetail({
                trace: props.selectedTrace,
                onClose: props.onClearSelection,
                onToggleType: (key) => {
                  props.onToggleType(key);
                  props.onClearSelection();
                },
              })}
            </div>
          </div>`
        : nothing}
      ${renderUsageExplainerOverlay(props)}
    </div>
  `;
}

type ExplainerStat = { label: string; value: string };
type ExplainerContent = {
  title: string;
  stats: ExplainerStat[];
  intro: TemplateResult;
  sections: Array<{ title: string; badge?: { kind: string; label: string }; body: TemplateResult }>;
};

function buildExplainerContent(key: string, props: ProtocolMonitorProps): ExplainerContent | null {
  const agg = props.usageAggregates;

  const modelFilter = props.modelFilter;
  let totals = props.usageTotals;
  if (modelFilter && agg) {
    const byModel = (agg as Record<string, unknown>).byModel as
      | Array<{ provider?: string; model?: string; count: number; totals: Record<string, unknown> }>
      | undefined;
    if (byModel) {
      const match = byModel.find(
        (m) => m.model === modelFilter || `${m.provider ?? ""}/${m.model ?? ""}` === modelFilter,
      );
      if (match) {
        totals = match.totals as typeof totals;
      }
    }
  }

  const sessions = props.usageSessions;
  const insightStats: UsageInsightStats | null =
    agg && totals ? buildUsageInsightStats(sessions as never[], totals, agg) : null;

  const msgTotal = agg?.messages.total ?? 0;
  const userMsgs = agg?.messages.user ?? 0;
  const assistantMsgs = agg?.messages.assistant ?? 0;
  const toolCalls = agg?.tools.totalCalls ?? 0;
  const uniqueTools = agg?.tools.uniqueTools ?? 0;
  const toolResults = agg?.messages.toolResults ?? 0;
  const errors = agg?.messages.errors ?? 0;
  const assistantErrors = agg?.messages.assistantErrors ?? 0;
  const toolErrors = agg?.messages.toolErrors ?? 0;
  const totalTokens = totals?.totalTokens ?? 0;
  const totalCost = totals?.totalCost ?? 0;
  const inputTokens = totals?.input ?? 0;
  const outputTokens = totals?.output ?? 0;
  const cacheRead = totals?.cacheRead ?? 0;
  const cacheWrite = totals?.cacheWrite ?? 0;
  const cacheBase = inputTokens + cacheRead;
  const cacheHitRate = cacheBase > 0 ? (cacheRead / cacheBase) * 100 : 0;
  const errorRate = msgTotal > 0 ? (errors / msgTotal) * 100 : 0;
  const avgTokens = msgTotal > 0 ? Math.round(totalTokens / msgTotal) : 0;
  const throughput = insightStats?.throughputTokensPerMin;
  const durationSumMs = insightStats?.durationSumMs ?? 0;
  const durationCount = insightStats?.durationCount ?? 0;
  const avgDurationMs = insightStats?.avgDurationMs ?? 0;
  const totalMinutes = durationSumMs / 60000;

  const costPerMsg = msgTotal > 0 ? totalCost / msgTotal : 0;
  const missingCost = totals?.missingCostEntries ?? 0;

  switch (key) {
    case "messages":
      return {
        title: "Messages",
        stats: [
          { label: "Total", value: String(msgTotal) },
          { label: "User", value: String(userMsgs) },
          { label: "Assistant", value: String(assistantMsgs) },
        ],
        intro: html`这些数字来自读取每个 session 在磁盘上保存的 transcript 文件 —— 并不是来自实时
          网络流量。每一行 transcript 都会被逐条检查,并按 <em>role</em> 分类计数。`,
        sections: [
          {
            title: `什么算一条 "user" message`,
            badge: { kind: "user", label: "User" },
            body: html`<p>
              每一条 <code>message.role === "user"</code> 的 transcript 记录记 1 次。
              也就是说,无论你(或请求方)发出的这一轮内容多长、包含多少 content block, 都只记作一条
              user message。
            </p>`,
          },
          {
            title: `什么算一条 "assistant" message`,
            badge: { kind: "assistant", label: "Assistant" },
            body: html`<p>
              每一条 <code>message.role === "assistant"</code> 的 transcript 记录记 1 次。
              哪怕这一次 assistant 回复里包含多个 tool call、长篇推理、或多个段落, 也只算一条
              message —— 其中的 tool call 会单独在 <strong>Tool Calls</strong>
              卡片里统计。
            </p>`,
          },
          {
            title: `什么会计入 "Total"`,
            badge: { kind: "total", label: "Total" },
            body: html`<p>
              <code>Total = User + Assistant</code>。system prompt、tool role 的 message,
              以及任何其它 role 都 <em>不</em> 计入。tool call、tool result、error
              都有各自独立的计数器。
            </p>`,
          },
          {
            title: "一些容易踩坑的地方",
            body: html`<ul>
              <li>
                这里的计数只覆盖当前 usage 时间窗口内的 session。如果启用了
                <strong>model 过滤</strong>,数字会只基于匹配该 model 的 session 重新聚合。
              </li>
              <li>
                聚合发生在 gateway 方法 <code>sessions.usage</code>,它把
                <code>scanTranscriptFile</code> 产出的每个 session 的计数累加起来。
              </li>
              <li>一条 transcript 记录 = 一次计数。单轮里的多段内容不会让数字膨胀。</li>
            </ul>`,
          },
        ],
      };

    case "throughput":
      return {
        title: "Throughput",
        stats: [
          {
            label: "Tokens / min",
            value: throughput !== undefined ? formatTokens(Math.round(throughput)) : "—",
          },
          { label: "Total tokens", value: formatTokens(totalTokens) },
          {
            label: "Active duration",
            value:
              durationSumMs > 0
                ? (formatDurationCompact(durationSumMs, { spaced: true }) ?? "—")
                : "—",
          },
        ],
        intro: html`Throughput 衡量的是在 session <em>活跃</em> 时间内 token 流动的速度。
          <strong>不是</strong>整个时间窗口的自然时间 —— 只算每个 session 实际在工作的那段时间。`,
        sections: [
          {
            title: "计算公式",
            body: html`<p>
                <code>throughput = totalTokens / (durationSumMs / 60000)</code> &mdash; 总 token 数
                除以总活跃时长(分钟)。
              </p>
              <p class="pm-explainer-mini">
                当前:${formatTokens(totalTokens)} tokens ÷
                ${totalMinutes > 0 ? `${totalMinutes.toFixed(1)} min` : "0 min"} ≈
                ${throughput !== undefined
                  ? `${formatTokens(Math.round(throughput))} tok/min`
                  : "—"}。
              </p>`,
          },
          {
            title: "活跃时长从哪来",
            body: html`<p>
              每个 session 会汇报自己的 <code>usage.durationMs</code> —— 也就是 transcript 活动跨
              越的时间。把 ${durationCount} 个有正时长的 session 累加起来,就得到了
              <code>durationSumMs</code>。
            </p>`,
          },
          {
            title: `副标题里的 "avg session" 是什么意思`,
            body: html`<p>
              <code>durationSumMs / durationCount</code> —— 每个有活动记录的 session
              的平均活跃时长。 当前值:
              <strong
                >${avgDurationMs > 0
                  ? (formatDurationCompact(avgDurationMs, { spaced: true }) ?? "—")
                  : "—"}</strong
              >。
            </p>`,
          },
          {
            title: "注意事项",
            body: html`<ul>
              <li>没有可测量时长的 session 会被跳过 —— 没法算速率。</li>
              <li>session 内部的空闲间隙仍然计入它的时长。</li>
              <li>
                Token 包含 input、output,以及 cache read / cache write —— 跟
                <strong>Total Tokens</strong> 卡片使用的是同一个 total。
              </li>
            </ul>`,
          },
        ],
      };

    case "toolcalls":
      return {
        title: "Tool Calls",
        stats: [
          { label: "Total calls", value: String(toolCalls) },
          { label: "Unique tools", value: String(uniqueTools) },
          { label: "Tool results", value: String(toolResults) },
        ],
        intro: html`每当一次 assistant 回复调用了 tool,就会被计入。一次 assistant 回复里 调用了 3 个
          tool,就给这个数字贡献 <strong>3</strong>(但对 assistant message 数仍然只贡献
          <strong>1</strong>)。`,
        sections: [
          {
            title: "单次调用是怎么被计数的",
            body: html`<p>
              对每一条 assistant 的 transcript 记录,<code>scanTranscriptFile</code> 会提取出它用到的
              tool 名列表(<code>entry.toolNames</code>),然后把列表长度 加到
              <code>messageCounts.toolCalls</code> 上。每个 tool 名字也会在一张 per-tool 的 map
              里计数。
            </p>`,
          },
          {
            title: `"unique tools" 是什么意思`,
            body: html`<p>
              就是那张 per-tool map 的 size —— 也就是当前时间窗口里,所有 session 中出现过的 不同
              tool 名的数量。当前观察到 <strong>${uniqueTools}</strong> 个不同的 tool。
            </p>`,
          },
          {
            title: "tool call 和 tool result 的区别",
            body: html`<p>
              call 是 assistant <em>请求</em> 调用 tool;result 是 tool <em>回复</em> 的结果。
              正常情况下是 1 对 1,但流式取消、出错或 aborted 的回合会让两个数字对不上。
            </p>`,
          },
        ],
      };

    case "avgtokens":
      return {
        title: "Avg Tokens",
        stats: [
          { label: "Avg / message", value: formatTokens(avgTokens) },
          { label: "Total tokens", value: formatTokens(totalTokens) },
          { label: "Messages", value: String(msgTotal) },
        ],
        intro: html`在当前 usage 时间窗口内,每一条 user + assistant message 平均搬运了多少 token。`,
        sections: [
          {
            title: "计算公式",
            body: html`<p><code>avgTokens = round(totalTokens / messages.total)</code>。</p>
              <p class="pm-explainer-mini">
                当前:${formatTokens(totalTokens)} tokens ÷ ${msgTotal} message ≈
                ${formatTokens(avgTokens)} / msg。
              </p>`,
          },
          {
            title: "分子是什么",
            body: html`<p>
              <code>totalTokens = input + output + cacheRead + cacheWrite</code>, 是把窗口内所有
              model-usage 记录加和得到的。缓存读入和新读入的 prompt token 都算。
            </p>`,
          },
          {
            title: "分母是什么",
            body: html`<p>
              <code>messages.total = user + assistant</code>。所以这里的"每条 message"指的是 每一轮
              <em>transcript turn</em>,而不是每次 tool call、每个 content block 或每次 model 调用。
            </p>`,
          },
          {
            title: "为什么有时候数字会让人意外",
            body: html`<ul>
              <li>
                大量的 cache read 会让 <code>totalTokens</code> 快速上涨 —— 一个带大量缓存上下文 的
                agent 可能显示非常高的平均值。
              </li>
              <li>如果 <code>messages.total</code> 为 0,卡片显示 0(不会有除零错误)。</li>
            </ul>`,
          },
        ],
      };

    case "cachehit":
      return {
        title: "Cache Hit",
        stats: [
          { label: "Hit rate", value: `${cacheHitRate.toFixed(1)}%` },
          { label: "Cache read", value: formatTokens(cacheRead) },
          { label: "Prompt base", value: formatTokens(cacheBase) },
        ],
        intro: html`prompt 侧的 token 中,有多少比例是从 model 的 prompt cache 中读出来的,
        而不是作为全新的 input 被重新计费。`,
        sections: [
          {
            title: "计算公式",
            body: html`<p>
                <code>cacheHitRate = cacheRead / (input + cacheRead)</code> &mdash; 以百分比表示。
              </p>
              <p class="pm-explainer-mini">
                当前:${formatTokens(cacheRead)} cached ÷ ${formatTokens(cacheBase)} prompt =
                <strong>${cacheHitRate.toFixed(1)}%</strong>。
              </p>`,
          },
          {
            title: "为什么分母是 input + cacheRead",
            body: html`<p>
              prompt token 送到 model 只有两条路:要么被重新 tokenize(<code>input</code>),
              要么从缓存读出(<code>cacheRead</code>)。output 和 cacheWrite 的 token
              <em>不</em> 参与命中率的分母计算。
            </p>`,
          },
          {
            title: `卡片颜色(tone)代表什么`,
            body: html`<ul>
              <li><strong>Good(绿):</strong>高于 60% —— 大部分 prompt 都被缓存命中了。</li>
              <li><strong>Warn(黄):</strong>30&ndash;60% —— 命中一般。</li>
              <li>
                <strong>Bad(红):</strong>低于 30% —— 基本没命中缓存;检查一下 prompt 前缀
                是不是在每一轮里都被改动了。
              </li>
            </ul>`,
          },
          {
            title: "跟 cache write 不是一回事",
            body: html`<p>
              <code>cacheWrite</code>(${formatTokens(cacheWrite)})是单独统计的 —— 这是
              为了后续轮次复用而 <em>写入</em> 缓存的 token,不是读出来的。
            </p>`,
          },
        ],
      };

    case "errorrate":
      return {
        title: "Error Rate",
        stats: [
          { label: "Error rate", value: `${errorRate.toFixed(2)}%` },
          { label: "Errors", value: String(errors) },
          { label: "Assistant errors", value: String(assistantErrors) },
          { label: "Tool errors", value: String(toolErrors) },
          { label: "Messages", value: String(msgTotal) },
        ],
        intro: html`带有 error 信号的 message 数相对于 message 总数的比例。`,
        sections: [
          {
            title: "计算公式",
            body: html`<p>
                <code>errorRate = errors / messages.total</code> &mdash; 以百分比表示。 其中
                <code>errors = assistantErrors + toolErrors</code>。
              </p>
              <p class="pm-explainer-mini">
                当前:${errors} errors (${assistantErrors} assistant + ${toolErrors} tool) ÷
                ${msgTotal} messages = <strong>${errorRate.toFixed(2)}%</strong>。
              </p>`,
          },
          {
            title: "哪些情况会让 error 计数 +1",
            body: html`<p>在 <code>scanTranscriptFile</code> 内部,error 有两个来源:</p>
              <ul>
                <li>
                  <strong>tool result 错误 → <code>toolErrors</code></strong
                  >:每一条被标记为 error 的 tool result(<code>isError === true</code> 或内联
                  <code>tool_result</code> block 带 <code>is_error: true</code>)。
                </li>
                <li>
                  <strong>终止态 stopReason → <code>assistantErrors</code></strong
                  >:assistant 的一轮回复,如果 <code>stopReason</code> 是 <code>"error"</code>、
                  <code>"aborted"</code> 或 <code>"timeout"</code>,+1。
                </li>
              </ul>`,
          },
          {
            title: "颜色(tone)阈值",
            body: html`<ul>
              <li><strong>Good:</strong>≤ 1%。</li>
              <li><strong>Warn:</strong>1&ndash;5%。</li>
              <li><strong>Bad:</strong>大于 5%。</li>
            </ul>`,
          },
          {
            title: "为什么比率有可能超过 100%",
            body: html`<p>
              一次 message turn 里可能同时记录多个 tool result error <em>再加上</em> 一个 error
              stopReason,所以极端情况下 <code>errors</code> 会超过
              <code>messages.total</code>。这里仍然直接按比值计算。
            </p>`,
          },
        ],
      };

    case "totalcost":
      return {
        title: "Total Cost",
        stats: [
          { label: "Total", value: formatCost(totalCost) },
          { label: "Per message", value: formatCost(costPerMsg, 4) },
          { label: "Messages", value: String(msgTotal) },
        ],
        intro: html`当前时间窗口内,每一条 model usage 记录所报告的 per-session 费用总和。 币种为
        USD。`,
        sections: [
          {
            title: "每个 session 的 cost 是怎么算的",
            body: html`<p>
              每一条 assistant message 的 usage 都带有 cost 拆分(<code>input</code>、
              <code>output</code>、<code>cacheRead</code>、<code>cacheWrite</code>)。 它们在
              <code>applyCostBreakdown</code> 里被累加到该 session 的 <code>totalCost</code>。
            </p>`,
          },
          {
            title: "session 之间怎么聚合",
            body: html`<p>
              gateway 方法 <code>sessions.usage</code> 会把所有匹配的 session 的
              <code>totalCost</code> 加起来。如果启用了 model 过滤,只有该 model 的 cost 会被计入。
            </p>`,
          },
          {
            title: "每条 message 的 cost",
            body: html`<p>
              副标题的值是 <code>totalCost / messages.total</code>,保留 4 位小数。 当前:<strong
                >${formatCost(costPerMsg, 4)} / msg</strong
              >。
            </p>`,
          },
          {
            title: "缺失 cost 的记录",
            body:
              missingCost > 0
                ? html`<p>
                    时间窗口内有 <strong>${missingCost}</strong> 条 usage 记录没有 cost 拆分
                    (价格未知,或是本地运行的 model)。这些记录会计入 token 总量,但不会计入 cost。
                  </p>`
                : html`<p>时间窗口内每一条 usage 记录都带有 cost 拆分 —— 没有没法计价的条目。</p>`,
          },
        ],
      };

    case "totaltokens":
      return {
        title: "Total Tokens",
        stats: [
          { label: "Total", value: formatTokens(totalTokens) },
          { label: "Input", value: formatTokens(inputTokens) },
          { label: "Output", value: formatTokens(outputTokens) },
        ],
        intro: html`归属到当前 usage 时间窗口内的全部 token,按四种 token 类别累加得到。`,
        sections: [
          {
            title: "计算公式",
            body: html`<p><code>totalTokens = input + output + cacheRead + cacheWrite</code>。</p>
              <p class="pm-explainer-mini">
                当前:${formatTokens(inputTokens)} in + ${formatTokens(outputTokens)} out +
                ${formatTokens(cacheRead)} cache-read + ${formatTokens(cacheWrite)} cache-write =
                <strong>${formatTokens(totalTokens)}</strong>。
              </p>`,
          },
          {
            title: "每一项的含义",
            body: html`<ul>
              <li><strong>Input</strong>:为请求重新 tokenize 的 prompt token。</li>
              <li>
                <strong>Output</strong>:model 生成出来的 token —— assistant 真正的回复内容, 包括
                tool call 的参数。
              </li>
              <li>
                <strong>Cache read</strong>:命中 model 的 prompt cache、不用重新 tokenize 的 prompt
                token。
              </li>
              <li><strong>Cache write</strong>:为了之后复用而被 model 写入缓存的 prompt token。</li>
            </ul>`,
          },
          {
            title: "每个 session 的 total 是怎么来的",
            body: html`<p>
              在 <code>applyUsageTotals</code> 里:如果一条 usage 记录自己报告了
              <code>total</code>,就直接用;否则就把四个分量加起来。之后 gateway 再把每个 session 的
              total 累加起来。
            </p>`,
          },
          {
            title: "跟其它卡片的关系",
            body: html`<ul>
              <li><strong>Avg Tokens</strong> = 这个 total ÷ 总 message 数。</li>
              <li>
                <strong>Cache Hit</strong> 只用 <code>input + cacheRead</code> —— output 和
                cacheWrite 不参与命中率计算。
              </li>
              <li><strong>Throughput</strong> = 这个 total ÷ 活跃分钟数。</li>
            </ul>`,
          },
        ],
      };

    default:
      return null;
  }
}

function renderUsageExplainerOverlay(props: ProtocolMonitorProps): TemplateResult | typeof nothing {
  const key = props.usageExplainer;
  if (!key) {
    return nothing;
  }
  const content = buildExplainerContent(key, props);
  if (!content) {
    return nothing;
  }
  return html`
    <div
      class="pm-detail-overlay"
      @click=${(e: Event) => {
        if ((e.target as HTMLElement).classList.contains("pm-detail-overlay")) {
          props.onCloseUsageExplainer();
        }
      }}
    >
      <div class="pm-detail-modal pm-explainer-modal">
        <div class="pm-explainer-header">
          <h3>${content.title} — 如何计算</h3>
          <button
            class="pm-explainer-close"
            @click=${props.onCloseUsageExplainer}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div class="pm-explainer-body">
          <div
            class="pm-explainer-values"
            style="grid-template-columns: repeat(${content.stats.length}, 1fr);"
          >
            ${content.stats.map(
              (s) => html`
                <div class="pm-explainer-stat">
                  <div class="pm-explainer-stat-value">${s.value}</div>
                  <div class="pm-explainer-stat-label">${s.label}</div>
                </div>
              `,
            )}
          </div>
          <p class="pm-explainer-intro">${content.intro}</p>
          ${content.sections.map(
            (sec) => html`
              <div class="pm-explainer-section">
                <div class="pm-explainer-section-title">
                  ${sec.badge
                    ? html`<span class="pm-explainer-badge pm-badge-${sec.badge.kind}"
                        >${sec.badge.label}</span
                      >`
                    : nothing}
                  ${sec.title}
                </div>
                ${sec.body}
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Network / latency card explainer overlay (Chinese)
// ---------------------------------------------------------------------------

function buildNetworkExplainerContent(
  key: string,
  net: NetworkStats,
  props: ProtocolMonitorProps,
): ExplainerContent | null {
  const meta = getDirectionMeta(props.networkDirection);
  const samples = selectDirectionThroughput(net, props.networkDirection);
  const peak = samples.length > 0 ? Math.max(...samples.map((s) => s.bytesPerSec)) : 0;
  const avg =
    samples.length > 0 ? samples.reduce((a, s) => a + s.bytesPerSec, 0) / samples.length : 0;
  const totalBytes = samples.reduce((a, s) => a + s.rawBytes, 0);
  const lastSample = samples[samples.length - 1];

  const directionLabel = html`<strong>${meta.longLabel}</strong>`;

  switch (key) {
    case "throughput-peak":
      return {
        title: `${meta.shortLabel} · Peak Throughput`,
        stats: [
          { label: "Peak", value: `${formatBytes(peak)}/s` },
          { label: "Samples", value: String(samples.length) },
        ],
        intro: html`这是 ${directionLabel} 这条方向上,<em>所有单条 message</em> 的 throughput
          中最大的一个。每条 message 的 throughput =
          <code>payloadBytes / oneWayMs × 1000</code> bytes/s,其中 <code>oneWayMs</code> 是这条
          message <em>真实测得</em> 的单向传输延迟,而不是用最近一次 ping 估算。`,
        sections: [
          transportSection(props.networkDirection),
          {
            title: "oneWayMs 是怎么测的",
            body: html`<p>
                两个方向各自直接测,都用同一套
                <code>time.sync</code> 4-timestamp NTP 时钟偏移把 peer 时钟投影到 gateway 时钟,
                所以两端报出来的时间戳是可比的:
              </p>
              <ul>
                <li>
                  <strong>peer → gateway</strong>(op→gw / node→gw):peer 在每个 WS 帧上 stamp
                  <code>sentAt</code>(本地 wall-clock + clockOffset → gateway 时钟), gateway
                  收到帧时记 <code>recvTs = Date.now()</code>,
                  <code>oneWayLatencyMs = recvTs − sentAt</code> 直接写在 trace record 上, UI
                  拿来用。
                </li>
                <li>
                  <strong>gateway → peer</strong>(gw→op / gw→node):peer 收到每一帧时 自己算
                  <code>latencyMs = (recvTs + clockOffset) − frame.sentAt</code> 和
                  <code>payloadSize = JSON.stringify(payload).length</code>,把这两个数字 连同
                  ts/kind/method/event 一起塞进 rx-sample 里。 每 <code>5s</code> 通过
                  <code>protocol-traces.rx-report</code> 批量回传给 gateway,gateway 广播
                  <code>protocol.rx.samples</code> 到所有 UI。UI 拿到 rx-sample 之后直接
                  <code>bytesPerSec = payloadSize / latencyMs × 1000</code> —— <em>不需要</em>
                  和 trace join,也不需要 ts 匹配,因为 payload 大小已经在 rx-sample 里了。
                </li>
              </ul>
              <p>
                兜底:peer→gw 方向上若某条 trace 的 <code>oneWayLatencyMs</code> 缺失 (旧版 peer 没
                stamp <code>sentAt</code>),回退到最近一次 ping latency。 gw→peer 方向上若 rx-sample
                缺 <code>payloadSize</code>(旧版 peer),那条 sample 就跳过 —— 一旦 peer 升级,所有
                sample 都是真实 per-message。
              </p>`,
          },
          {
            title: "Peak 高 ≠ 一直高",
            body: html`<p>
              Peak 只反映 "最大的那一条 message"。要看链路常态压力,看
              <strong>Average</strong>;要看分布形状,看 <strong>Total Bytes</strong> 和样本计数。
            </p>`,
          },
        ],
      };

    case "throughput-avg":
      return {
        title: `${meta.shortLabel} · Average Throughput`,
        stats: [
          { label: "Avg", value: `${formatBytes(avg)}/s` },
          { label: "Total bytes", value: formatBytes(totalBytes) },
          { label: "Samples", value: String(samples.length) },
        ],
        intro: html`${directionLabel} 这条方向上所有 per-message throughput 的算术平均 —— 每条
          message 都按 <code>payloadBytes / oneWayMs × 1000</code> 算出一个 bytes/s (oneWayMs 是这条
          message 实测的单向延迟,不是 ping 估算),然后求平均。`,
        sections: [
          {
            title: "计算公式",
            body: html`<p>
                <code>average = sum(perMessageBytesPerSec) / message count</code>。 分母是
                <em>消息数</em>,不是总秒数 —— 空闲段没有消息,因此不会拉低均值。
              </p>
              <p class="pm-explainer-mini">
                当前:${formatBytes(samples.reduce((a, s) => a + s.bytesPerSec, 0))} ÷
                ${samples.length} messages ≈ <strong>${formatBytes(avg)}/s</strong>。
              </p>`,
          },
          {
            title: "和 Total Bytes 的关系",
            body: html`<p>
              如果你想算 "自 session 开始的真实平均吞吐",更准确的算法是
              <code>totalBytes / 实际持续时长</code>。本卡片显示的 average 是 per-message
              速率的算术均值,会忽略空闲间隙。
            </p>`,
          },
          {
            title: "和 Latency 的耦合",
            body: html`<p>
              分母是 <em>这条 message 自己</em> 的单向 latency,所以 latency 抖动 (Wi-Fi 重传、GC
              pause) 只会拖慢 <em>受影响的那几条 message</em> 的 throughput,不会像旧的 "用最近一次
              ping 当除数" 那样把同一份抖动平摊到一整段时间窗里的所有 message 上。
            </p>`,
          },
        ],
      };

    case "throughput-total":
      return {
        title: `${meta.shortLabel} · Total Bytes`,
        stats: [
          { label: "Total", value: formatBytes(totalBytes) },
          { label: "Samples", value: String(samples.length) },
        ],
        intro: html`${directionLabel} 这条方向上,所有 trace 的 payload 字节累加和。 一条 trace =
        一个 WebSocket 帧(req / res / event)。`,
        sections: [
          transportSection(props.networkDirection),
          {
            title: "数据从哪来",
            body: html`<p>
              每条 trace record 上都带有 <code>payloadSize</code>(这一帧的 payload 字节数)。
              对方向匹配(<code>source</code> + <code>target</code>)的 trace,把
              <code>payloadSize</code> 累加起来即得到 Total Bytes。 这部分计算<em>不依赖 ping</em
              >,所以哪怕还没收到第一个 ping 样本, Total Bytes 也是准确的。
            </p>`,
          },
          {
            title: "为什么可以「自 session 开始」累计",
            body: html`<p>
              UI 的 trace buffer 只保留最近 <code>${1000}</code> 条 trace(MAX_VISIBLE), 但 Total
              Bytes 由 controller 侧的持久 accumulator 维护 —— 每条 trace 按 id 去重累加一次,与 ring
              buffer eviction 解耦。所以即使旧 trace 被挤出 buffer, Total 也不会回落。注意这是 UI
              自进程启动以来的累计,不是 gateway 端的计费。
            </p>`,
          },
        ],
      };

    case "throughput-min":
      return {
        title: `${meta.shortLabel} · Min Throughput`,
        stats: [
          {
            label: "Min",
            value: `${formatBytes(samples.length > 0 ? Math.min(...samples.map((s) => s.bytesPerSec)) : 0)}/s`,
          },
          { label: "Samples", value: String(samples.length) },
        ],
        intro: html`${directionLabel} 这条方向上,<em>所有单条 message</em> 的 throughput
          中最小的一个。 通常对应一条 payload 很小但单向延迟相对偏高的 message。`,
        sections: [],
      };

    case "throughput-median":
      return {
        title: `${meta.shortLabel} · Median Throughput`,
        stats: [
          {
            label: "Median",
            value: `${formatBytes(median(samples.map((s) => s.bytesPerSec)) ?? 0)}/s`,
          },
          { label: "Samples", value: String(samples.length) },
        ],
        intro: html`${directionLabel} 这条方向上 per-message throughput 的中位数 (p50)。 比 average
        更能反映 "常态" 下链路的真实吞吐 —— 不被极端样本拖动。`,
        sections: [],
      };

    case "throughput-bytes-min":
      return {
        title: `${meta.shortLabel} · Min Payload`,
        stats: [
          {
            label: "Min",
            value: formatBytes(
              samples.length > 0 ? Math.min(...samples.map((s) => s.rawBytes)) : 0,
            ),
          },
          { label: "Messages", value: String(samples.length) },
        ],
        intro: html`${directionLabel} 这条方向上单条 message payload 的最小值。`,
        sections: [],
      };

    case "throughput-bytes-max":
      return {
        title: `${meta.shortLabel} · Max Payload`,
        stats: [
          {
            label: "Max",
            value: formatBytes(
              samples.length > 0 ? Math.max(...samples.map((s) => s.rawBytes)) : 0,
            ),
          },
          { label: "Messages", value: String(samples.length) },
        ],
        intro: html`${directionLabel} 这条方向上单条 message payload 的最大值 ——
        链路上跑过的最大帧。`,
        sections: [],
      };

    case "throughput-bytes-avg":
      return {
        title: `${meta.shortLabel} · Avg Payload`,
        stats: [
          {
            label: "Avg",
            value: formatBytes(samples.length > 0 ? totalBytes / samples.length : 0),
          },
          { label: "Total", value: formatBytes(totalBytes) },
          { label: "Messages", value: String(samples.length) },
        ],
        intro: html`${directionLabel} 这条方向上单条 message payload 的算术平均 = total bytes /
        message count。`,
        sections: [],
      };

    case "throughput-bytes-median":
      return {
        title: `${meta.shortLabel} · Median Payload`,
        stats: [
          { label: "Median", value: formatBytes(median(samples.map((s) => s.rawBytes)) ?? 0) },
          { label: "Messages", value: String(samples.length) },
        ],
        intro: html`${directionLabel} 这条方向上单条 message payload 的中位数。 比 average 更能反映
        "常态消息有多大" —— 一条特别大的 message 不会把这个数字拉走。`,
        sections: [],
      };

    case "throughput-last":
      return {
        title: `${meta.shortLabel} · Last Activity`,
        stats: [
          {
            label: "When",
            value: lastSample
              ? new Date(lastSample.ts).toLocaleTimeString("en-US", { hour12: false })
              : "—",
          },
          {
            label: "Bytes/s",
            value: lastSample ? `${formatBytes(lastSample.bytesPerSec)}/s` : "—",
          },
          {
            label: "Payload",
            value: lastSample ? formatBytes(lastSample.rawBytes) : "—",
          },
        ],
        intro: html`${directionLabel} 这条方向上 <em>最后一条</em> message 的时间戳、 它的
          per-message throughput、以及那条 message 的 payload 大小。
          可以快速判断链路是否还活着、最近一笔流量长什么样。`,
        sections: [
          {
            title: "时间含义",
            body: html`<p>
              显示的是 <em>这一条 message</em> 的本地接收时间(controller 看到 trace 的瞬间)。
              如果链路当前很闲,这个时间可能比 "现在" 早不少。
            </p>`,
          },
          {
            title: "Bytes/s 是怎么算的",
            body: html`<p>
              和 Average / Peak 同一套口径:<code>payloadBytes / oneWayMs × 1000</code>, 其中
              <code>oneWayMs</code> 是 <em>这条 message</em> 自己实测的单向延迟 (peer→gw 来自
              trace.oneWayLatencyMs;gw→peer 来自 join 上的 rx-sample)。 所以这一栏只反映 "这条
              message 在它发出/收到的那一刻在链路上的有效吞吐", 不会被全局 ping 抖动污染。
            </p>`,
          },
          {
            title: "什么时候这里会显示 —",
            body: html`<p>
              ① 还没有 trace;② per-message latency join 没找到匹配且 ping 兜底也没数据
              (启动初期罕见)。
            </p>`,
          },
        ],
      };
  }

  // Messages section: per-type cards (count + min/max bytes) + bar chart.
  if (key.startsWith("messages-")) {
    const data = selectDirectionMessages(net, props.networkDirection);
    if (!data) {
      return null;
    }
    const type = key.slice("messages-".length);
    const card = data.cards.find((c) => c.type === type);
    if (!card) {
      return null;
    }
    const totalBars = data.bars.filter((b) => b.type === type).length;
    return {
      title: `${meta.shortLabel} · ${type}`,
      stats: [
        { label: "Count", value: String(card.count) },
        { label: "Min", value: formatBytes(card.minBytes) },
        { label: "Max", value: formatBytes(card.maxBytes) },
      ],
      intro: html`${directionLabel} 这条方向上,自 trace buffer 起点到现在, 类型为
        <code>${type}</code> 的 WebSocket 帧总共出现了 <strong>${card.count}</strong> 次, payload 在
        <strong>${formatBytes(card.minBytes)}</strong> 到
        <strong>${formatBytes(card.maxBytes)}</strong> 之间。`,
      sections: [
        {
          title: "卡片上的数字怎么算的",
          body: html`<p>
            <code>computePerDirectionMessages</code> 遍历方向匹配 (<code>source</code> +
            <code>target</code>)的 trace,按 <code>resolveMessageType</code> 拿出类型标签 (<code
              >event.&lt;name&gt;</code
            >
            或 <code>&lt;kind&gt;.&lt;method&gt;</code>), 按类型分组累加 count、追踪 min / max
            payload 大小。
          </p>`,
        },
        {
          title: "和 bar chart 怎么对应",
          body: html`<p>
            条形图里的每一根细柱 = 一条 message,横轴是时间,纵轴是 payload 大小,颜色按类型
            稳定分配(同一类型的所有柱子是同一颜色,与卡片左边的色条、底部 legend 对齐)。
            这条卡片对应的类型在条形图上一共有
            <strong>${totalBars}</strong> 根柱子。
          </p>`,
        },
        {
          title: "和 Throughput 的关系",
          body: html`<p>
            Throughput 是按时间维度看 "整条链路的速率",Messages 是按类型维度看
            "都是哪些消息在跑、各自有多大"。 两者用的都是 <code>payloadSize</code> 字段,所以
            <code>Sum(per-type bytes) ≈ Total Bytes</code>(忽略 trace ID 去重导致的 微小差异)。
          </p>`,
        },
      ],
    };
  }

  // Per-category card click on the merged agent|model tab — a short blurb
  // describing what that event category represents and how it's measured.
  if (key.startsWith("llm-event-")) {
    const cat = key.slice("llm-event-".length) as AgentLlmEventCategory;
    const card = net.agentLlm.cards.find((c) => c.category === cat);
    if (!card) {
      return null;
    }
    const blurbs: Record<AgentLlmEventCategory, string> = {
      request:
        "Each bar = one LLM HTTP request. Captured at the agent→llm lifecycle 'request' event; bar height = serialized request body size. One bar per LLM call.",
      sse: "Each bar = one assistant SSE delta from the model. Captured at the llm→agent assistant stream event; bar height = the delta's serialized payload. Hundreds to thousands per call.",
      "tool-call":
        "Each bar = one tool invocation the agent dispatched on behalf of the model. Captured at the agent→gateway tool 'start' event; height = invocation payload (args).",
      "tool-result": "Each bar = one tool result echoed back. Height = result payload size.",
      complete:
        "Each bar = the lifecycle 'end' event for an LLM call. Height = end-event payload (small).",
      other: "Other agent↔llm events that didn't match a more specific category.",
    };
    return {
      title: `Agent ↔ Model · ${AGENT_LLM_CATEGORY_LABELS[cat] ?? cat}`,
      stats: [
        { label: "Count", value: String(card.count) },
        { label: "Min", value: formatBytes(card.minBytes) },
        { label: "Max", value: formatBytes(card.maxBytes) },
        { label: "Total", value: formatBytes(card.totalBytes) },
      ],
      intro: html`${blurbs[cat]}`,
      sections: [
        {
          title: "Decoupled from the trace ring buffer",
          body: html`<p>
            Counts come from a dedicated 10000-entry agent|model event store populated at trace
            ingest time, not from the shared
            <code>MAX_VISIBLE=1000</code> trace ring buffer. SSE deltas (typically 70–95% of the
            trace buffer) can no longer evict sparser event types like requests or tool calls.
          </p>`,
        },
      ],
    };
  }

  // Agent ↔ Model throughput section cards (per-call generation throughput).
  // Per-event-bytes cards were removed because the Events-by-category cards
  // above the chart already cover the same min/max/total information per
  // category — no need for a separate "summed across all categories" row.
  if (key.startsWith("agentllm-throughput-")) {
    const tpt = net.agentLlm.callThroughput;
    const labels: Record<string, { title: string; value: string; sub: string }> = {
      "agentllm-throughput-min": {
        title: "Min generation throughput",
        value: tpt.count > 0 ? `${formatBytes(tpt.minBytesPerSec ?? 0)}/s` : "—",
        sub: "slowest LLM call",
      },
      "agentllm-throughput-peak": {
        title: "Peak generation throughput",
        value: tpt.count > 0 ? `${formatBytes(tpt.peakBytesPerSec ?? 0)}/s` : "—",
        sub: "fastest LLM call",
      },
      "agentllm-throughput-avg": {
        title: "Average generation throughput",
        value: tpt.count > 0 ? `${formatBytes(tpt.avgBytesPerSec ?? 0)}/s` : "—",
        sub: `${tpt.count} calls`,
      },
      "agentllm-throughput-median": {
        title: "Median generation throughput",
        value: tpt.count > 0 ? `${formatBytes(tpt.p50BytesPerSec ?? 0)}/s` : "—",
        sub: "p50 across calls",
      },
    };
    const entry = labels[key];
    if (!entry) {
      return null;
    }
    return {
      title: `Agent ↔ Model · ${entry.title}`,
      stats: [
        { label: "Value", value: entry.value },
        { label: "Detail", value: entry.sub },
      ],
      intro: html`Per-LLM-call generation throughput =
        <code>responseBytes / generationDurationMs × 1000</code>. Each call contributes one sample
        once it has streamed at least two SSE deltas (so there's a measurable duration between first
        and last token).`,
      sections: [],
    };
  }

  // Headline overview card (TTFT subtotal, total bytes, etc.)
  if (key === "llm-overview-total") {
    return {
      title: "Agent ↔ Model · Overview",
      stats: [
        { label: "Total bytes", value: formatBytes(net.agentLlm.totalBytes) },
        { label: "Total events", value: String(net.agentLlm.totalEvents) },
        { label: "LLM calls", value: String(net.agentLlm.totalCalls) },
      ],
      intro: html`Sum of every recorded agent↔llm event payload. Includes requests, SSE deltas, tool
      invocations, results, and lifecycle ends.`,
      sections: [],
    };
  }

  // Agent|Model TTFT latency cards click through to the same handler the
  // wire-pair latency cards use, but the agent-llm tab doesn't go through
  // selectDirectionLatency (which returns null for it). Surface stats from
  // net.agentLlm.ttft directly.
  if (props.networkDirection === "agent-llm" && key.startsWith("lat-ttft")) {
    const stats = net.agentLlm.ttft;
    const latencyName = "TTFT — time-to-first-token";
    if (key.endsWith("-min")) {
      return {
        title: `${latencyName} · Min`,
        stats: [
          { label: "Min", value: formatMs(stats.minMs) },
          { label: "Samples", value: String(stats.count) },
        ],
        intro: html`所有 TTFT sample 中最快的一次。每次 LLM call 贡献一个 sample (<code
            >firstAssistantTs − requestTs</code
          >)。`,
        sections: [],
      };
    }
    if (key.endsWith("-avg")) {
      return {
        title: `${latencyName} · Avg`,
        stats: [
          { label: "Avg", value: formatMs(stats.avgMs) },
          { label: "Samples", value: String(stats.count) },
        ],
        intro: html`所有 TTFT sample 的算术平均。`,
        sections: [],
      };
    }
    if (key.endsWith("-p50")) {
      return {
        title: `${latencyName} · p50`,
        stats: [{ label: "p50", value: formatMs(stats.p50Ms) }],
        intro: html`TTFT 中位数 —— 比 avg 更能反映 "常态" 下 model 多久开始流式输出。`,
        sections: [],
      };
    }
    if (key.endsWith("-p95")) {
      return {
        title: `${latencyName} · p95`,
        stats: [{ label: "p95", value: formatMs(stats.p95Ms) }],
        intro: html`TTFT 95% 百分位。100 次 call 里有 95 次比这个值快、5 次比这个值慢。`,
        sections: [],
      };
    }
    if (key.endsWith("-peak")) {
      return {
        title: `${latencyName} · Peak`,
        stats: [{ label: "Peak", value: formatMs(stats.peakMs) }],
        intro: html`所有 TTFT sample 中最慢的一次 —— 通常是 cold start 或 provider 拥塞。`,
        sections: [],
      };
    }
  }

  // Latency keys (wire-pair tabs)
  const latency = selectDirectionLatency(net, props.networkDirection);
  if (latency && key.startsWith(latency.latencyKey)) {
    const stats = latency.stats;
    const latencyName = latency.label;

    if (key.endsWith("-min")) {
      return {
        title: `${latencyName} · Min`,
        stats: [
          { label: "Min", value: formatMs(stats.minMs) },
          { label: "Avg", value: formatMs(stats.avgMs) },
          { label: "Samples", value: String(stats.count) },
        ],
        intro: html`所有 sample 中最快的那一个 —— 通常最接近 <em>真实物理层 latency</em>:
          抖动只会让单次 ping 变慢(GC pause、send queue 堆积、tab throttling),不会比
          实际链路更快。${latencyExplainerIntro(latency.latencyKey)}`,
        sections: [
          {
            title: "怎么解读",
            body: html`<p>
              Min 是物理链路本身的 "下限" 估计。如果 Min 接近 Avg / p50,说明链路稳定; 如果 Avg / p50
              远高于 Min,说明经常被抖动拉慢(典型情况:event loop 拥堵、 Wi-Fi 重传、Tailscale
              中继切换)。
            </p>`,
          },
          latencySourceSection(latency.latencyKey),
        ],
      };
    }
    if (key.endsWith("-avg")) {
      return {
        title: `${latencyName} · Average`,
        stats: [
          { label: "Avg", value: formatMs(stats.avgMs) },
          { label: "Samples", value: String(stats.count) },
        ],
        intro: html`所有采样的算术平均。${latencyExplainerIntro(latency.latencyKey)}`,
        sections: [
          {
            title: "计算公式",
            body: html`<p>
                <code>avg = sum(oneWayMs) / count</code>,其中每个 <code>oneWayMs</code> = 一次 ping
                的 <code>(t3 − t0) / 2</code>。
              </p>
              <p class="pm-explainer-mini">
                当前:${stats.count} 个 ping sample,平均 <strong>${formatMs(stats.avgMs)}</strong>。
              </p>`,
          },
          latencySourceSection(latency.latencyKey),
          {
            title: "什么时候 avg 会失真",
            body: html`<p>
              如果有少量极慢的 ping(GC pause、网络抖动),avg 会被它们拉高很多。 这种情况看
              <strong>p50</strong>(中位数)或 <strong>Min</strong> 更能反映 "常态" 的链路质量。
            </p>`,
          },
        ],
      };
    }
    if (key.endsWith("-p50")) {
      return {
        title: `${latencyName} · p50`,
        stats: [
          { label: "p50", value: formatMs(stats.p50Ms) },
          { label: "Avg", value: formatMs(stats.avgMs) },
          { label: "Samples", value: String(stats.count) },
        ],
        intro: html`p50 = 中位数。把所有 sample 按 latency 升序排,中间那个点的值。
        ${latencyExplainerIntro(latency.latencyKey)}`,
        sections: [
          {
            title: "为什么看 p50 而不只是 avg",
            body: html`<p>
              p50 不会被极端值拉偏。如果 p50 ≪ avg,说明分布有长尾(少量很慢的请求); p50 ≈
              avg,说明分布相对平稳。
            </p>`,
          },
          latencySourceSection(latency.latencyKey),
        ],
      };
    }
    if (key.endsWith("-p95")) {
      return {
        title: `${latencyName} · p95`,
        stats: [
          { label: "p95", value: formatMs(stats.p95Ms) },
          { label: "p50", value: formatMs(stats.p50Ms) },
          { label: "Samples", value: String(stats.count) },
        ],
        intro: html`p95 = 95% 百分位数。100 个请求里有 95 个比这个值快、5 个比这个值慢。
        ${latencyExplainerIntro(latency.latencyKey)}`,
        sections: [
          {
            title: "为什么 p95 重要",
            body: html`<p>
              p95 反映 "尾部" 体验。即使 avg / p50 都很好,p95 高也意味着用户偶尔会遇到
              明显的卡顿。性能优化通常优先压低 p95,而不是 avg。
            </p>`,
          },
          {
            title: "Sample 太少时不准",
            body: html`<p>
              当前共 <strong>${stats.count}</strong> 个 sample。
              ${stats.count < 20
                ? "数量太少,p95 抖动会很大,主要看趋势,不要看绝对值。"
                : "样本足够,p95 数字相对可靠。"}
            </p>`,
          },
          latencySourceSection(latency.latencyKey),
        ],
      };
    }
    if (key.endsWith("-peak")) {
      return {
        title: `${latencyName} · Peak`,
        stats: [
          { label: "Peak", value: formatMs(stats.peakMs) },
          { label: "p95", value: formatMs(stats.p95Ms) },
          { label: "Samples", value: String(stats.count) },
        ],
        intro: html`所有 sample 中最慢的那一个。${latencyExplainerIntro(latency.latencyKey)}`,
        sections: [
          {
            title: "Peak ≠ 系统当前的实际延迟",
            body: html`<p>
              这是历史最慢的一笔,可能来自冷启动、网络抖动或一次特别大的 prompt。
              用作"知道一下最坏到过多少"的参考,不要拿来当作 SLA。
            </p>`,
          },
          latencySourceSection(latency.latencyKey),
        ],
      };
    }
  }

  return null;
}

function transportSection(direction: NetworkDirection): {
  title: string;
  body: TemplateResult;
} {
  switch (direction) {
    case "op-to-gw":
    case "gw-to-op":
      return {
        title: "这条方向用什么 transport",
        body: html`<p>
          Operator(浏览器或 Mac/Windows 客户端)和 Gateway 之间是
          <strong>WebSocket</strong> 长连接。每一次 RPC 请求、事件推送、或一段流式输出
          都是一个或多个 WS 帧。Throughput 卡片里的字节数就是这些 WS 帧的 payload 累加。
        </p>`,
      };
    case "gw-to-node":
    case "node-to-gw":
      return {
        title: "这条方向用什么 transport",
        body: html`<p>
          Gateway 和 Node(本机或远端 PC)之间也是 <strong>WebSocket</strong> 长连接, 带有 OpenClaw
          自己的 RPC / event 协议。Throughput 卡片统计的是这些 WS 帧的 payload 字节。
        </p>`,
      };
    case "agent-llm":
      return {
        title: "这条方向用什么 transport",
        body: html`<p>
          Agent ↔ Model 走的是 <strong>HTTP/HTTPS</strong> + <strong>SSE</strong>。 每次 LLM 调用 =
          一次 HTTPS POST(请求体里有 system prompt、transcript、tool schema 等), response 通过
          Server-Sent Events 流回(每帧 = 一段 assistant delta)。 这一页把请求 + 整个 SSE 流当作
          <em>一次 call</em> 一起统计。
        </p>`,
      };
    default:
      return { title: "", body: html`` };
  }
}

function latencyExplainerIntro(latencyKey: string): TemplateResult {
  switch (latencyKey) {
    case "lat-ttft":
      return html`这里测量的是 <strong>TTFT(time-to-first-token)</strong>:agent 把请求 发出去之后,到
        model 第一次回流 assistant 内容之间的等待时间。`;
    case "lat-gen":
      return html`这里测量的是 assistant 流式输出本身的 <strong>持续时间</strong>:从 model
        回出第一段 assistant 内容,到下一个 tool call(或 lifecycle end)之间的窗口。`;
    case "lat-op-gw":
      return html`这里测量的是 <strong>Operator → Gateway</strong> 方向的单向 latency, 来源是专用的
        <code>ping.peer-to-gw</code> RPC:operator 每 10s 发起一次 ping, 用自己的时钟测出 RTT,再除以
        2 作为单向延迟估计 —— <em>不依赖</em> 双方时钟同步, 也不假设上下行对称。`;
    case "lat-gw-op":
      return html`这里测量的是 <strong>Gateway → Operator</strong> 方向的单向 latency, 来源是专用的
        <code>ping.gw-to-peer</code> 事件 + <code>ping.gw-to-peer.ack</code> 回执: gateway 每 10s
        推一条 ping,用自己的时钟测出 RTT,再除以 2。 与正向独立测量,不再靠 "对称估计"。`;
    case "lat-node-gw":
      return html`这里测量的是 <strong>Node → Gateway</strong> 方向的单向 latency, 来源是专用的
        <code>ping.peer-to-gw</code> RPC:node 每 10s 发起一次 ping, 用自己的时钟测出 RTT,再除以 2。`;
    case "lat-gw-node":
      return html`这里测量的是 <strong>Gateway → Node</strong> 方向的单向 latency, 来源是专用的
        <code>ping.gw-to-peer</code> 事件 + <code>ping.gw-to-peer.ack</code> 回执: gateway 每 10s
        推一条 ping,用自己的时钟测出 RTT,再除以 2。 两个方向互相独立,各自用自己的时钟测量。`;
    default:
      return html``;
  }
}

function latencySourceSection(latencyKey: string): {
  title: string;
  body: TemplateResult;
} {
  switch (latencyKey) {
    case "lat-ttft":
      return {
        title: "TTFT 是怎么打点的",
        body: html`<p>
          在 <code>computeAgentLlmTtft</code> 里:对每个 <code>runId</code>, 以 lifecycle start
          或上一次 tool end/result 为起点,以下一条 <code>stream === "assistant"</code> 的 trace
          为终点,差值即一次 TTFT。 多个 LLM 调用会被分别打点为 TTFT #1、#2、…
        </p>`,
      };
    case "lat-gen":
      return {
        title: "Generation 是怎么打点的",
        body: html`<p>
          在 <code>computeAgentLlmGeneration</code> 里:从一段 assistant burst 的
          <em>第一</em> 条流式事件到 <em>最后</em> 一条之间的时间(在下一个 tool call 或 lifecycle
          end 之前)。一次 burst = 一次 generation 样本。
        </p>`,
      };
    case "lat-op-gw":
    case "lat-node-gw":
      return {
        title: "One-way 是怎么算出来的",
        body: html`<p>
            来源是专用的
            <strong>peer → gateway ping</strong>(<code>src/gateway/protocol/schema/ping.ts</code>)。
            Peer(operator 或 node)每
            <strong>${Math.round(/* PING_INTERVAL_MS */ 10000 / 1000)} 秒</strong>
            发起一次 <code>ping.peer-to-gw</code> RPC:记下发送时刻 <code>t0</code>, gateway
            立刻回包,peer 收到回包时记下 <code>t3</code>。 单向延迟 = <code>(t3 − t0) / 2</code>。
          </p>
          <p>
            <strong>不依赖时钟同步</strong>:整个 RTT 都用 peer 自己的时钟测, 两次读时间差只跟 peer
            的 monotonic clock 有关,跟 gateway 端时钟差多少无关。
          </p>
          <p>
            样本点放在 controller 侧的 <code>pingSamples[source].forward</code> 缓冲里, UI 端的
            <code>computePingLatencyStats</code> 再算出 min / avg / p50 / p95 / peak。
          </p>`,
      };
    case "lat-gw-op":
    case "lat-gw-node":
      return {
        title: "One-way 是怎么算出来的",
        body: html`<p>
            来源是专用的
            <strong>gateway → peer ping</strong>(<code>src/gateway/protocol/schema/ping.ts</code>)。
            Gateway 每
            <strong>${Math.round(/* PING_INTERVAL_MS */ 10000 / 1000)} 秒</strong>
            广播一条 <code>ping.gw-to-peer</code> 事件:记下发送时刻 <code>t0</code>, peer
            收到后立刻发回 <code>ping.gw-to-peer.ack</code>,gateway 收到 ack 时记下
            <code>t3</code>。 单向延迟 = <code>(t3 − t0) / 2</code>。
          </p>
          <p>
            <strong>与正向独立测量,不再靠对称估计</strong>:这个方向所有时间戳都用 gateway
            自己的时钟,所以不依赖时钟同步,也不假设上下行对称 —— 适合
            链路非对称的场景(例如上下行带宽差异、Tailscale 中继路径不一致)。
          </p>
          <p>
            Peer 收到 ping 的处理时间会从 RTT 里减掉(peer 在 ack 里上报
            <code>peerProcessingMs</code>),所以 peer 端 GC pause / event-loop
            阻塞不会被算成网络延迟。
          </p>`,
      };
    default:
      return { title: "", body: html`` };
  }
}

function renderNetworkExplainerOverlay(
  net: NetworkStats,
  props: ProtocolMonitorProps,
): TemplateResult | typeof nothing {
  const key = props.networkExplainer;
  if (!key) {
    return nothing;
  }
  const content = buildNetworkExplainerContent(key, net, props);
  if (!content) {
    return nothing;
  }
  return html`
    <div
      class="pm-detail-overlay"
      @click=${(e: Event) => {
        if ((e.target as HTMLElement).classList.contains("pm-detail-overlay")) {
          props.onCloseNetworkExplainer();
        }
      }}
    >
      <div class="pm-detail-modal pm-explainer-modal">
        <div class="pm-explainer-header">
          <h3>${content.title} — 如何计算</h3>
          <button
            class="pm-explainer-close"
            @click=${props.onCloseNetworkExplainer}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div class="pm-explainer-body">
          <div
            class="pm-explainer-values"
            style="grid-template-columns: repeat(${content.stats.length}, 1fr);"
          >
            ${content.stats.map(
              (s) => html`
                <div class="pm-explainer-stat">
                  <div class="pm-explainer-stat-value">${s.value}</div>
                  <div class="pm-explainer-stat-label">${s.label}</div>
                </div>
              `,
            )}
          </div>
          <p class="pm-explainer-intro">${content.intro}</p>
          ${content.sections.map(
            (sec) => html`
              <div class="pm-explainer-section">
                <div class="pm-explainer-section-title">
                  ${sec.badge
                    ? html`<span class="pm-explainer-badge pm-badge-${sec.badge.kind}"
                        >${sec.badge.label}</span
                      >`
                    : nothing}
                  ${sec.title}
                </div>
                ${sec.body}
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}

function renderProtocolAndNetworkPane(props: ProtocolMonitorProps): TemplateResult {
  const allModels = extractModels(props.traces);
  const runModelMap = buildRunModelMap(props.traces);
  const modelFiltered = filterTracesByModel(props.traces, props.modelFilter, runModelMap);
  const filtered = filterTraces(modelFiltered, props.disabledTypes);
  const coalesced = coalesceTraces(filtered);
  const netStats = computeNetworkStats(modelFiltered, props.modelFilter, runModelMap);
  const chatMessages = extractChatMessages(modelFiltered).slice(-5);
  const toolCalls = extractToolCalls(modelFiltered).slice(-5);
  return html`
    <div class="pm-protocol-layout">
      <!-- Left half: messages, tool calls, sequence diagram -->
      <div class="pm-left-half">
        <details class="pm-live-cards-details">
          <summary class="pm-live-cards-summary">
            Latest Messages (${chatMessages.length}) · Latest Tool Calls (${toolCalls.length})
          </summary>
          <div class="pm-left-top">
            <div class="pm-live-card-col">
              <div class="pm-section-title">Latest Messages</div>
              ${renderChatCards(chatMessages)}
            </div>
            <div class="pm-live-card-col">
              <div class="pm-section-title">Latest Tool Calls</div>
              ${renderToolCallCards(toolCalls)}
            </div>
          </div>
        </details>
        <div class="pm-diagram-section">
          <div
            class="pm-section-title"
            style="display:flex;justify-content:space-between;align-items:center;"
          >
            Sequence Diagram
            ${props.exportMode
              ? nothing
              : html`<label
                  class="pm-check"
                  style="font-weight:400;text-transform:none;letter-spacing:0;"
                >
                  <input
                    type="checkbox"
                    .checked=${props.autoScroll}
                    @change=${(e: Event) =>
                      props.onToggleAutoScroll((e.target as HTMLInputElement).checked)}
                  />
                  Auto-scroll
                </label>`}
          </div>
          ${renderSequenceDiagram(coalesced, props)}
        </div>
      </div>
      <!-- Right half: model filter, usage, directional network/latency tabs -->
      <div class="pm-right-half">
        ${renderModelFilter(allModels, props)}
        <details class="pm-usage-details">
          <summary class="pm-usage-summary">Usage Overview</summary>
          <div class="pm-usage-banner">${renderUsageOverview(props)}</div>
        </details>
        ${renderDirectionalNetworkPane(netStats, props)}
      </div>
    </div>
    ${renderNetworkExplainerOverlay(netStats, props)}
  `;
}

function renderModelFilter(models: string[], props: ProtocolMonitorProps): TemplateResult {
  if (models.length === 0) {
    return html``;
  }
  return html`
    <div class="pm-model-filter">
      <span class="pm-model-filter-label">Model:</span>
      <button
        class="pm-model-btn ${props.modelFilter === null ? "active" : ""}"
        @click=${() => props.onModelFilterChange(null)}
      >
        All
      </button>
      ${models.map(
        (m) => html`
          <button
            class="pm-model-btn ${props.modelFilter === m ? "active" : ""}"
            @click=${() => props.onModelFilterChange(m)}
          >
            ${m}
          </button>
        `,
      )}
    </div>
  `;
}

function renderSettingsPane(props: ProtocolMonitorProps): TemplateResult {
  const msgTypes = computeMessageTypes(props.traces, props.disabledTypes);
  return html`
    <div class="pm-pane" style="display:flex;flex-direction:column;">
      <div class="pm-section-title" style="flex-shrink:0;">Message Filters</div>
      <p class="pm-muted" style="padding:0 10px;flex-shrink:0;">
        Toggle message types to show/hide in the sequence diagram. Agentic task-unrelated messages
        are hidden by default.
      </p>
      ${renderMessageTypeFilters(msgTypes, props)}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Live chat / tool call cards
// ---------------------------------------------------------------------------

function renderChatCards(messages: ChatMessage[]): TemplateResult {
  if (messages.length === 0) {
    return html`<div class="pm-live-cards-empty">No chat messages yet</div>`;
  }
  return html`
    <div class="pm-live-cards">
      ${messages.map(
        (m) => html`
          <div class="pm-live-card ${m.role === "user" ? "pm-card-user" : "pm-card-assistant"}">
            <div class="pm-card-role">${m.role === "user" ? "User" : "Assistant"}</div>
            <div class="pm-card-text">
              ${m.text.slice(0, 200)}${m.text.length > 200 ? "\u2026" : ""}
            </div>
            <div class="pm-card-time">
              ${new Date(m.ts).toLocaleTimeString("en-US", { hour12: false })}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderToolCallCards(calls: ToolCallMessage[]): TemplateResult {
  if (calls.length === 0) {
    return html`<div class="pm-live-cards-empty">No tool calls yet</div>`;
  }
  return html`
    <div class="pm-live-cards">
      ${calls.map(
        (c) => html`
          <div
            class="pm-live-card pm-card-tool ${c.phase === "start"
              ? "pm-card-tool-start"
              : c.phase === "result" || c.phase === "end"
                ? "pm-card-tool-end"
                : ""}"
          >
            <div class="pm-card-role">
              <strong>${c.name}</strong>
              <span class="pm-card-phase">${c.phase}</span>
              ${c.agentId ? html`<span class="pm-card-agent">${c.agentId}</span>` : nothing}
            </div>
            <div class="pm-card-text">
              ${c.detail.slice(0, 150)}${c.detail.length > 150 ? "\u2026" : ""}
            </div>
            <div class="pm-card-time">
              ${new Date(c.ts).toLocaleTimeString("en-US", { hour12: false })}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Section 1: Usage overview (top)
// ---------------------------------------------------------------------------

function renderUsageOverview(props: ProtocolMonitorProps): TemplateResult {
  const agg = props.usageAggregates;

  if (props.usageLoading && !props.usageTotals) {
    return html`<div class="pm-stats-bar">
      <span class="pm-muted">Loading usage data...</span>
    </div>`;
  }

  // When a model filter is active, use the per-model breakdown from aggregates
  const modelFilter = props.modelFilter;
  let totals = props.usageTotals;
  if (modelFilter && agg) {
    const byModel = (agg as Record<string, unknown>).byModel as
      | Array<{ provider?: string; model?: string; count: number; totals: Record<string, unknown> }>
      | undefined;
    if (byModel) {
      const match = byModel.find(
        (m) => m.model === modelFilter || `${m.provider ?? ""}/${m.model ?? ""}` === modelFilter,
      );
      if (match) {
        totals = match.totals as typeof totals;
      }
    }
  }

  // Compute insight stats from usage data
  const sessions = props.usageSessions;
  const insightStats: UsageInsightStats | null =
    agg && totals ? buildUsageInsightStats(sessions as never[], totals, agg) : null;

  const msgTotal = agg?.messages.total ?? 0;
  const userMsgs = agg?.messages.user ?? 0;
  const assistantMsgs = agg?.messages.assistant ?? 0;
  const toolCalls = agg?.tools.totalCalls ?? 0;
  const uniqueTools = agg?.tools.uniqueTools ?? 0;
  const errors = agg?.messages.errors ?? 0;
  const assistantErrors = agg?.messages.assistantErrors ?? 0;
  const toolErrors = agg?.messages.toolErrors ?? 0;
  const totalTokens = totals?.totalTokens ?? 0;
  const totalCost = totals?.totalCost ?? 0;
  const avgTokens = msgTotal > 0 ? Math.round(totalTokens / msgTotal) : 0;
  const cacheBase = (totals?.input ?? 0) + (totals?.cacheRead ?? 0);
  const cacheHitRate = cacheBase > 0 ? ((totals?.cacheRead ?? 0) / cacheBase) * 100 : 0;
  const errorRate = msgTotal > 0 ? (errors / msgTotal) * 100 : 0;
  const throughput = insightStats?.throughputTokensPerMin;
  const avgDuration =
    insightStats && insightStats.durationCount > 0
      ? (formatDurationCompact(insightStats.avgDurationMs, { spaced: true }) ?? "—")
      : "—";

  const cacheTone = cacheHitRate > 60 ? "good" : cacheHitRate > 30 ? "warn" : "bad";
  const errorTone = errorRate > 5 ? "bad" : errorRate > 1 ? "warn" : "good";

  const modelLabel = modelFilter
    ? html`<span class="pm-model-filter-active">${modelFilter}</span>`
    : nothing;

  // When the gateway returned a result (not loading, no error) and every
  // rolled-up metric is zero, the usage window almost certainly does not
  // cover the user's active sessions. Render a short hint instead of a grid
  // of zeros — the date picker lives on the Usage tab.
  const hasResult = totals !== null || agg !== null;
  const allZero =
    msgTotal === 0 && toolCalls === 0 && totalTokens === 0 && (totals?.totalCost ?? 0) === 0;
  if (!props.usageLoading && hasResult && allZero) {
    return html`
      <div class="pm-overview">
        <div class="pm-filters-title">Usage Overview ${modelLabel}</div>
        <div class="pm-usage-empty">
          No activity in the currently selected usage window. Open the
          <strong>Usage</strong> tab and widen the date range (the picker defaults to "today"; if
          you have left this page open past midnight, bump the end-date to today's date). The Usage
          Overview and the Usage tab share the same query.
        </div>
      </div>
    `;
  }

  return html`
    <div class="pm-overview">
      <div class="pm-filters-title">Usage Overview ${modelLabel}</div>
      <div class="pm-overview-grid">
        ${usageCard(
          "Messages",
          String(msgTotal),
          `${userMsgs} user · ${assistantMsgs} assistant`,
          "hero",
          () => props.onOpenUsageExplainer("messages"),
        )}
        ${usageCard(
          "Throughput",
          throughput !== undefined ? `${formatTokens(Math.round(throughput))} tok/min` : "—",
          `${avgDuration} avg session`,
          "hero",
          () => props.onOpenUsageExplainer("throughput"),
        )}
        ${usageCard("Tool Calls", String(toolCalls), `${uniqueTools} unique tools`, "half", () =>
          props.onOpenUsageExplainer("toolcalls"),
        )}
        ${usageCard(
          "Avg Tokens",
          formatTokens(avgTokens),
          `across ${msgTotal} messages`,
          "half",
          () => props.onOpenUsageExplainer("avgtokens"),
        )}
        ${usageCard(
          "Cache Hit",
          `${cacheHitRate.toFixed(1)}%`,
          `${formatTokens(totals?.cacheRead ?? 0)} cached · ${formatTokens(cacheBase)} prompt`,
          cacheTone,
          () => props.onOpenUsageExplainer("cachehit"),
        )}
        ${usageCard(
          "Error Rate",
          `${errorRate.toFixed(2)}%`,
          `${assistantErrors} assistant · ${toolErrors} tool`,
          errorTone,
          () => props.onOpenUsageExplainer("errorrate"),
        )}
        ${usageCard(
          "Total Cost",
          formatCost(totalCost),
          `${formatCost(msgTotal > 0 ? totalCost / msgTotal : 0, 4)}/msg`,
          "compact",
          () => props.onOpenUsageExplainer("totalcost"),
        )}
        ${usageCard(
          "Total Tokens",
          formatTokens(totalTokens),
          `in ${formatTokens(totals?.input ?? 0)} · out ${formatTokens(totals?.output ?? 0)}`,
          "compact",
          () => props.onOpenUsageExplainer("totaltokens"),
        )}
      </div>
    </div>
  `;
}

function renderControlButtons(props: ProtocolMonitorProps): TemplateResult {
  if (props.exportMode) {
    const captured = props.exportCapturedAt
      ? new Date(props.exportCapturedAt).toLocaleString()
      : "unknown time";
    return html`
      <div class="pm-controls-inline">
        <span
          class="pm-export-banner"
          title="This is a frozen snapshot exported from the live Protocol Monitor."
        >
          Exported snapshot · ${captured}
        </span>
      </div>
    `;
  }
  const paused = props.monitoringPaused;
  return html`
    <div class="pm-controls-inline">
      <button
        type="button"
        class="pm-monitor-switch ${paused ? "pm-monitor-switch--paused" : ""}"
        role="switch"
        aria-checked=${paused ? "false" : "true"}
        title=${paused
          ? "Monitoring paused — incoming events are dropped. Click to resume."
          : "Monitoring live — incoming events are captured. Click to pause."}
        @click=${() => props.onToggleMonitoring(!paused)}
      >
        <span class="pm-monitor-switch-track">
          <span class="pm-monitor-switch-thumb"></span>
        </span>
        <span class="pm-monitor-switch-label"> ${paused ? "Paused" : "Live"} </span>
      </button>
      <button class="pm-btn" @click=${props.onRefresh}>Refresh</button>
      <button class="pm-btn" @click=${props.onExport}>Export</button>
      <button
        class="pm-btn danger"
        @click=${() => props.onReset()}
        title="Permanently wipe the gateway trace buffer, persistent latency caches, and all session transcripts on disk. Shows a confirmation with exact counts before deleting."
      >
        Reset
      </button>
    </div>
  `;
}

function usageCard(
  title: string,
  value: string,
  sub: string,
  tone?: string,
  onClick?: () => void,
): TemplateResult {
  const toneClass = tone === "good" || tone === "warn" || tone === "bad" ? `pm-ucard--${tone}` : "";
  const sizeClass =
    tone === "hero"
      ? "pm-ucard--hero"
      : tone === "half"
        ? "pm-ucard--half"
        : tone === "compact"
          ? "pm-ucard--compact"
          : "";
  const clickableClass = onClick ? "pm-ucard--clickable" : "";
  if (onClick) {
    return html`
      <div
        class="pm-ucard ${toneClass} ${sizeClass} ${clickableClass}"
        role="button"
        tabindex="0"
        title="Click for explanation"
        @click=${onClick}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <div class="pm-ucard-title">${title}<span class="pm-ucard-info">ⓘ</span></div>
        <div class="pm-ucard-value">${value}</div>
        <div class="pm-ucard-sub">${sub}</div>
      </div>
    `;
  }
  return html`
    <div class="pm-ucard ${toneClass} ${sizeClass}">
      <div class="pm-ucard-title">${title}</div>
      <div class="pm-ucard-value">${value}</div>
      <div class="pm-ucard-sub">${sub}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Section 2: Message type filters (left-middle)
// ---------------------------------------------------------------------------

function renderMessageTypeFilters(
  types: MessageTypeStats[],
  props: ProtocolMonitorProps,
): TemplateResult {
  return html`
    <div class="pm-filters">
      <div class="pm-filters-title">
        Message Types
        <span style="font-weight:400;font-size:9px;color:#6b7280;">${types.length} types</span>
      </div>
      <div class="pm-type-cards">
        ${types.map((t) => renderTypeCard(t, props))}
        ${types.length === 0 ? html`<div class="pm-muted">No messages yet</div>` : nothing}
      </div>
    </div>
  `;
}

function renderTypeCard(t: MessageTypeStats, props: ProtocolMonitorProps): TemplateResult {
  const kindHint = t.key.split(".")[0] ?? "";
  const dotColor = kindHint === "req" ? "#3b82f6" : kindHint === "res" ? "#22c55e" : "#f59e0b";

  return html`
    <div
      class="pm-type-card ${t.enabled ? "" : "disabled"}"
      @click=${() => props.onToggleType(t.key)}
    >
      <div class="pm-type-card-header">
        <span class="pm-type-dot" style="background:${dotColor};"></span>
        <span class="pm-type-card-key">${t.key}</span>
        <label class="pm-type-switch" @click=${(e: Event) => e.stopPropagation()}>
          <input type="checkbox" .checked=${t.enabled} @change=${() => props.onToggleType(t.key)} />
          <span class="pm-type-slider"></span>
        </label>
      </div>
      <div class="pm-type-card-stats">
        <div class="pm-type-metric">
          <span class="pm-type-metric-val">${t.count}</span>
          <span class="pm-type-metric-label">count</span>
        </div>
        <div class="pm-type-metric">
          <span class="pm-type-metric-val">${t.avgPerMin !== null ? t.avgPerMin : "—"}</span>
          <span class="pm-type-metric-label">/min</span>
        </div>
        <div class="pm-type-metric">
          <span class="pm-type-metric-val">${formatBytes(t.totalBytes)}</span>
          <span class="pm-type-metric-label">total</span>
        </div>
        <div class="pm-type-metric">
          <span class="pm-type-metric-val"
            >${t.bytesPerMin !== null ? formatBytes(t.bytesPerMin) : "—"}</span
          >
          <span class="pm-type-metric-label">B/min</span>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Section 3: Live sequence diagram (left-bottom)
// ---------------------------------------------------------------------------

// Track whether user is near bottom so auto-scroll doesn't fight manual scrolling
let userNearBottom = true;

function renderSequenceDiagram(
  coalesced: CoalescedEntry[],
  props: ProtocolMonitorProps,
): TemplateResult {
  const totalHeight = coalesced.length * ROW_HEIGHT;

  // Schedule auto-scroll after this render if enabled and user hasn't scrolled away
  if (props.autoScroll && userNearBottom) {
    requestAnimationFrame(() => {
      const el = document.getElementById("pm-diagram-scroll");
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  return html`
    <div class="pm-diagram" id="pm-diagram-scroll" @scroll=${handleDiagramScroll}>
      <div class="pm-columns-header">
        <div class="pm-ts-header">Time</div>
        ${COLUMNS.map(
          (col) =>
            html`<div class="pm-col-header">
              <span class="pm-col-icon">${unsafeHTML(COL_ICONS[col])}</span>
              <span class="pm-col-label-text">${COL_LABELS[col]}</span>
            </div>`,
        )}
      </div>
      ${coalesced.length === 0
        ? html`<div class="pm-empty">
            ${props.loading ? "Loading..." : "No messages match filters."}
          </div>`
        : html`
            <div class="pm-rows-wrap" style="height:${totalHeight}px;">
              <div class="pm-vlines">
                ${COLUMNS.map(
                  (_, i) =>
                    html`<div
                      class="pm-vline"
                      style="left:${((i + 0.5) / COLUMNS.length) * 100}%;"
                    ></div>`,
                )}
              </div>
              ${coalesced.map((entry, idx) => renderRow(entry, idx, props))}
            </div>
          `}
    </div>
  `;
}

function handleDiagramScroll(e: Event) {
  const el = e.target as HTMLElement;
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  userNearBottom = distFromBottom < 60;
}

/** No longer used internally but kept for external callers. */
export function scheduleAutoScroll(autoScroll: boolean) {
  if (!autoScroll) {
    return;
  }
  requestAnimationFrame(() => {
    const el = document.getElementById("pm-diagram-scroll");
    if (!el) {
      return;
    }
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 80) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

// ---------------------------------------------------------------------------
// Protocol badge — labels the application-layer protocol for each message
// ---------------------------------------------------------------------------

type ProtocolTag = { label: string; bg: string; fg: string };

function resolveProtocolTag(entry: CoalescedEntry): ProtocolTag {
  if (entry.type === "group") {
    // Coalesced LLM stream group — originates from HTTP API, relayed via WS
    return { label: "HTTP/SSE", bg: "#fef3c7", fg: "#92400e" };
  }
  const t = entry;
  // Agent streaming events (assistant, tool, lifecycle)
  // These originate from HTTP API calls to the LLM (Anthropic/OpenAI),
  // streamed back as SSE, then relayed to the UI over WebSocket.
  if (t.kind === "event" && t.stream) {
    const src = t.source;
    const tgt = t.target;
    if ((src === "agent" && tgt === "llm") || (src === "llm" && tgt === "agent")) {
      return { label: "HTTP/SSE", bg: "#fef3c7", fg: "#92400e" };
    }
    if (src === "agent" && tgt === "gateway") {
      return { label: "IPC", bg: "#e0e7ff", fg: "#3730a3" };
    }
    return { label: "WS/Stream", bg: "#fce7f3", fg: "#9d174d" };
  }
  // Request-response RPC over WebSocket
  if (t.kind === "req" || t.kind === "res") {
    return { label: "WS/RPC", bg: "#dbeafe", fg: "#1e40af" };
  }
  // Broadcast events (non-streaming)
  if (t.kind === "event") {
    return { label: "WS/Event", bg: "#dcfce7", fg: "#166534" };
  }
  return { label: "WS", bg: "#f1f3f9", fg: "#6b7280" };
}

function renderProtocolBadge(entry: CoalescedEntry): TemplateResult {
  const tag = resolveProtocolTag(entry);
  return html`<span class="pm-proto-badge" style="background:${tag.bg};color:${tag.fg};"
    >${tag.label}</span
  >`;
}

function renderRow(
  entry: CoalescedEntry,
  idx: number,
  props: ProtocolMonitorProps,
): TemplateResult {
  const ts = entry.ts;
  const source: Column = entry.source as Column;
  const target: Column = entry.target as Column;
  const color = kindColor(entry);
  const label = entryLabel(entry);
  const detail = entryDetail(entry);
  const isGroup = entry.type === "group";
  const isSelected =
    props.selectedTrace && "id" in props.selectedTrace && props.selectedTrace.id === entry.id;

  const srcIdx = COL_INDEX[source] ?? 1;
  const tgtIdx = COL_INDEX[target] ?? 1;
  const colCount = COLUMNS.length;

  // Percentages for column centers
  const srcPct = ((srcIdx + 0.5) / colCount) * 100;
  const tgtPct = ((tgtIdx + 0.5) / colCount) * 100;

  if (srcIdx === tgtIdx) {
    // Self-referencing: show box centered on column
    return html`
      <div
        class="pm-row ${isSelected ? "selected" : ""}"
        style="top:${idx * ROW_HEIGHT}px;position:absolute;width:100%;"
        @click=${() => props.onSelectTrace(entry)}
      >
        <div class="pm-ts">${formatTs(ts)}</div>
        <div style="position:relative;grid-column:2/-1;height:100%;">
          <div class="pm-msg-box" style="left:${srcPct}%;border-color:${color};">
            <span class="pm-msg-method" style="color:${color};"
              >${label} ${renderProtocolBadge(entry)}</span
            >
            <span class="pm-msg-detail">${detail}</span>
          </div>
        </div>
      </div>
    `;
  }

  const goingRight = tgtIdx > srcIdx;
  // Box anchored at source column; arrow from box edge to target column line
  // Box position: centered on source column
  // Arrow: from box edge toward target
  const boxLeft = srcPct;

  // Arrow endpoints: from the edge of the box toward the target column center
  // We use two elements: the box (positioned at source) and the arrow (spanning to target)
  const arrowLeft = goingRight ? srcPct : tgtPct;
  const arrowRight = goingRight ? tgtPct : srcPct;
  const arrowWidthPct = arrowRight - arrowLeft;

  return html`
    <div
      class="pm-row ${isSelected ? "selected" : ""}"
      style="top:${idx * ROW_HEIGHT}px;position:absolute;width:100%;"
      @click=${() => props.onSelectTrace(entry)}
    >
      <div class="pm-ts">${formatTs(ts)}</div>
      <div style="position:relative;grid-column:2/-1;height:100%;">
        <!-- Arrow line from source to target -->
        <div
          class="pm-arrow-container ${isGroup ? "group-arrow" : ""}"
          style="left:${arrowLeft}%;width:${arrowWidthPct}%;"
        >
          ${goingRight
            ? html`
                <div class="pm-arrow-line" style="background:${color};"></div>
                <div class="pm-arrow-head right" style="border-left-color:${color};"></div>
              `
            : html`
                <div class="pm-arrow-head left" style="border-right-color:${color};"></div>
                <div class="pm-arrow-line" style="background:${color};"></div>
              `}
        </div>
        <!-- Message box anchored at source column -->
        <div class="pm-msg-box" style="left:${boxLeft}%;border-color:${color};">
          <span class="pm-msg-method" style="color:${color};">
            ${label}
            ${isGroup ? html`<span class="pm-arrow-badge">${entry.events.length}</span>` : nothing}
            ${renderProtocolBadge(entry)}
          </span>
          <span class="pm-msg-detail">${detail}</span>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Section 4: Directional network + latency tabs (right pane)
// ---------------------------------------------------------------------------

type DirectionMeta = {
  id: NetworkDirection;
  shortLabel: string;
  longLabel: string;
  color: string;
};

const DIRECTION_META: DirectionMeta[] = [
  {
    id: "op-to-gw",
    shortLabel: "Operator → Gateway",
    longLabel: "Operator (STA) → Gateway (AP)",
    color: "#3b82f6",
  },
  {
    id: "gw-to-op",
    shortLabel: "Gateway → Operator",
    longLabel: "Gateway (AP) → Operator (STA)",
    color: "#0ea5e9",
  },
  {
    id: "gw-to-node",
    shortLabel: "Gateway → Node",
    longLabel: "Gateway (AP) → Node (PC)",
    color: "#22c55e",
  },
  {
    id: "node-to-gw",
    shortLabel: "Node → Gateway",
    longLabel: "Node (PC) → Gateway (AP)",
    color: "#16a34a",
  },
  {
    id: "agent-llm",
    shortLabel: "Agent ↔ Model",
    longLabel: "Agent ↔ Model (LLM call lifecycle)",
    color: "#a855f7",
  },
];

function getDirectionMeta(id: NetworkDirection): DirectionMeta {
  return DIRECTION_META.find((d) => d.id === id) ?? DIRECTION_META[0];
}

function selectDirectionThroughput(net: NetworkStats, id: NetworkDirection): ThroughputSample[] {
  // Per-MESSAGE throughput samples (one ThroughputSample per frame).
  //
  // Source split by direction:
  //   - peer→gw (op-to-gw, node-to-gw): use messages.throughputSamples from
  //     the messageStore. The store sees the WIDER message set (health,
  //     polls, presence, etc.) — *ThroughputStats.forward iterates the
  //     blocklist-filtered trace ring buffer, so on sessions whose op→gw
  //     traffic is nearly all polls (Control UI sitting idle), it would
  //     report 0 measured messages while the Messages section above shows
  //     dozens. Sourcing from the store instead keeps the "N measured
  //     messages" count consistent with the Messages totals.
  //   - gw→peer (gw-to-op, gw-to-node): keep using *ThroughputStats.reverse
  //     because the gateway-side trace records for outbound frames don't
  //     carry oneWayLatencyMs (it can't observe its own arrival times). The
  //     reverse stats are built from peer-reported rxSamples, which DO have
  //     latencyMs.
  switch (id) {
    case "op-to-gw":
      return net.operatorGatewayMessages.forward.throughputSamples;
    case "gw-to-op":
      return net.operatorGatewayThroughputStats.reverse.samples;
    case "node-to-gw":
      return net.gatewayNodeMessages.forward.throughputSamples;
    case "gw-to-node":
      return net.gatewayNodeThroughputStats.reverse.samples;
    default:
      // agent-llm has its own dedicated renderer (renderAgentLlmContent)
      // and does not flow through this wire-pair throughput selector.
      return [];
  }
}

function selectDirectionLatency(
  net: NetworkStats,
  id: NetworkDirection,
): { stats: LatencyStats; label: string; latencyKey: string; estimated?: boolean } | null {
  switch (id) {
    case "op-to-gw":
      return {
        stats: net.operatorGatewayOneWayLatency,
        label: "Operator → Gateway · one-way",
        latencyKey: "lat-op-gw",
      };
    case "gw-to-op":
      // Peer-measured: the operator client measures rx latency for each frame
      // it receives from the gateway and reports samples back via
      // `protocol-traces.rx-report`. Requires `time.sync` to have converged
      // for the offset correction to be meaningful.
      return {
        stats: net.gatewayOperatorOneWayLatency,
        label: "Gateway → Operator · one-way (peer-measured)",
        latencyKey: "lat-gw-op",
      };
    case "node-to-gw":
      return {
        stats: net.nodeGatewayOneWayLatency,
        label: "Node → Gateway · one-way",
        latencyKey: "lat-node-gw",
      };
    case "gw-to-node":
      // Peer-measured: same mechanism as gateway → operator above.
      return {
        stats: net.gatewayNodeOneWayLatency,
        label: "Gateway → Node · one-way (peer-measured)",
        latencyKey: "lat-gw-node",
      };
    default:
      // agent-llm has its own renderer; latency lives in net.agentLlm.ttft.
      return null;
  }
}

function renderDirectionalNetworkPane(
  net: NetworkStats,
  props: ProtocolMonitorProps,
): TemplateResult {
  return html`
    <div class="pm-net-pane">
      <div class="pm-net-tabs">
        ${DIRECTION_META.map(
          (d) => html`
            <button
              class="pm-net-tab ${props.networkDirection === d.id ? "active" : ""}"
              style="--pm-net-tab-color: ${d.color};"
              @click=${() => props.onNetworkDirectionChange(d.id)}
              title=${d.longLabel}
            >
              ${d.shortLabel}
            </button>
          `,
        )}
      </div>
      <div class="pm-net-direction-content">${renderDirectionContent(net, props)}</div>
    </div>
  `;
}

/**
 * Pick the matching `MessagesDirection` for a given chart direction tab. Only
 * wire pairs (op-gw, gw-op, node-gw, gw-node) have message data; agent-llm
 * directions return null because they're internal flows, not wire traffic.
 */
function selectDirectionMessages(
  net: NetworkStats,
  id: NetworkDirection,
): MessagesDirection | null {
  switch (id) {
    case "op-to-gw":
      return net.operatorGatewayMessages.forward;
    case "gw-to-op":
      return net.operatorGatewayMessages.reverse;
    case "node-to-gw":
      return net.gatewayNodeMessages.forward;
    case "gw-to-node":
      return net.gatewayNodeMessages.reverse;
    default:
      return null;
  }
}

/**
 * Shared x-axis (time) domain for the throughput / latency / messages charts.
 * Spans every direction tab so switching tabs preserves the same x-axis range
 * (events on op→gw line up vertically with events on node→gw, etc.).
 */
type TimeWindow = { minTs: number; maxTs: number };

/**
 * Compute one TimeWindow that covers every chart series across every direction
 * tab. Each series is already sorted by ts, so first/last entries give the
 * local min/max — no full scan needed.
 */
function computeGlobalTimeWindow(net: NetworkStats): TimeWindow | undefined {
  const tsValues: number[] = [];
  const pushSeries = (arr: { ts: number }[] | undefined) => {
    if (arr && arr.length > 0) {
      tsValues.push(arr[0].ts, arr[arr.length - 1].ts);
    }
  };
  // Wire-pair throughput samples (forward + reverse for each pair).
  pushSeries(net.operatorGateway.forward);
  pushSeries(net.operatorGateway.reverse);
  pushSeries(net.gatewayNode.forward);
  pushSeries(net.gatewayNode.reverse);
  // Wire-pair latency samples (one stats object per direction).
  pushSeries(net.operatorGatewayOneWayLatency.samples);
  pushSeries(net.gatewayOperatorOneWayLatency.samples);
  pushSeries(net.nodeGatewayOneWayLatency.samples);
  pushSeries(net.gatewayNodeOneWayLatency.samples);
  // Wire-pair messages bars.
  pushSeries(net.operatorGatewayMessages.forward.bars);
  pushSeries(net.operatorGatewayMessages.reverse.bars);
  pushSeries(net.gatewayNodeMessages.forward.bars);
  pushSeries(net.gatewayNodeMessages.reverse.bars);
  // Agent ↔ Model: per-call TTFT samples + per-call generation throughput +
  // the unified event bars.
  pushSeries(net.agentLlm.ttft.samples);
  pushSeries(net.agentLlm.bars);
  pushSeries(net.agentLlm.callThroughput.samples);
  if (tsValues.length === 0) {
    return undefined;
  }
  return { minTs: Math.min(...tsValues), maxTs: Math.max(...tsValues) };
}

/**
 * Stable color palette for message-type bars. Index assigned by the type's
 * position in the cards list (sorted by count, so the most common type gets
 * the first color — consistent across renders for a given snapshot).
 */
const MESSAGE_TYPE_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
  "#06b6d4",
  "#d946ef",
] as const;

function buildMessageTypeColorMap(types: string[]): Map<string, string> {
  const map = new Map<string, string>();
  types.forEach((t, i) => {
    map.set(t, MESSAGE_TYPE_COLORS[i % MESSAGE_TYPE_COLORS.length] ?? "#64748b");
  });
  return map;
}

/**
 * Module-level x-axis zoom state for the bar charts, keyed by chart id.
 * Current keys:
 *   - `messages-${direction}` for each wire-pair Messages bar chart
 *   - `agent-llm-events`      for the agent|model Events-by-category chart
 *
 * Each entry is the user's currently chosen visible time range; absent = auto
 * (use the computed timeWindow). Lives at module scope so it persists across
 * Lit re-renders and across tab switches.
 *
 * The zoom only affects the x-axis (time) — the y-axis (bar height = bytes)
 * stays auto-scaled to the visible bars so bars within the zoom window are
 * always sized relative to each other, not to off-screen extremes.
 */
const barChartZoom = new Map<string, { minTs: number; maxTs: number }>();

/** Min visible time span (ms) — clamps zoom-in so we don't over-scroll. */
const MIN_ZOOM_SPAN_MS = 50;

function renderMessagesBarChartSvg(
  data: MessagesDirection,
  colorMap: Map<string, string>,
  timeWindow: TimeWindow | undefined,
  zoomKey: string,
  onRequestUpdate?: () => void,
): TemplateResult {
  // pm-chart-block is full-width with the shorter (460/195) aspect ratio
  // applied globally to .pm-chart-svg--tall, so no per-call class is needed.
  const blockClass = "pm-chart-block";
  if (data.bars.length === 0) {
    return html`
      <div class="${blockClass}">
        <div class="pm-chart-empty" style="height:195px;line-height:195px;">
          Waiting for first message...
        </div>
      </div>
    `;
  }
  const PAD_L = 64;
  const PAD_R = 24;
  const PAD_T = 14;
  const PAD_B = 28;
  const W = 460;
  const H = 195;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const bars = data.bars;
  const localMin = bars[0]?.ts ?? 0;
  const localMax = bars.length > 1 ? (bars[bars.length - 1]?.ts ?? localMin + 1) : localMin + 1;
  const autoMinTs = timeWindow?.minTs ?? localMin;
  const autoMaxTs = timeWindow?.maxTs ?? localMax;
  const zoom = barChartZoom.get(zoomKey);
  // Clamp a stale zoom to the data bounds (e.g. user reset traces while zoomed
  // in — the saved range may now lie entirely outside the new data). If the
  // clamp would collapse the range to nothing, drop the zoom and fall back to
  // auto.
  let viewMinTs = autoMinTs;
  let viewMaxTs = autoMaxTs;
  let isZoomed = false;
  if (zoom) {
    const clampedMin = Math.max(zoom.minTs, autoMinTs);
    const clampedMax = Math.min(zoom.maxTs, autoMaxTs);
    if (clampedMax - clampedMin >= MIN_ZOOM_SPAN_MS) {
      viewMinTs = clampedMin;
      viewMaxTs = clampedMax;
      isZoomed = true;
    } else {
      barChartZoom.delete(zoomKey);
    }
  }
  const tsRange = Math.max(1, viewMaxTs - viewMinTs);
  // Filter to bars actually inside the visible range. Out-of-range bars don't
  // contribute to maxSize either so the y-axis stays scaled to what's visible.
  const visibleBars = isZoomed ? bars.filter((b) => b.ts >= viewMinTs && b.ts <= viewMaxTs) : bars;
  const maxSize = Math.max(...visibleBars.map((b) => b.size), 1);
  const toX = (ts: number) => PAD_L + ((ts - viewMinTs) / tsRange) * plotW;
  const toY = (s: number) => PAD_T + plotH - (s / maxSize) * plotH;
  const yGridCount = 4;
  const yGridLines = Array.from({ length: yGridCount }, (_, i) => {
    const val = (maxSize / yGridCount) * (i + 1);
    return { y: toY(val), label: formatBytes(val) };
  });
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const ts = viewMinTs + (tsRange / (xTickCount - 1)) * i;
    return { x: toX(ts), label: chartTimeLabel(ts) };
  });
  // Each bar is a 2 px-wide vertical rect from baseline up to the size value.
  const barWidth = 2;
  const chartId = `bars-${(bars[0]?.ts ?? 0).toString(36)}`;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    handleBarChartZoom(e, zoomKey, viewMinTs, viewMaxTs, autoMinTs, autoMaxTs, PAD_L, plotW, W);
    onRequestUpdate?.();
  };
  const onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    if (barChartZoom.has(zoomKey)) {
      barChartZoom.delete(zoomKey);
      onRequestUpdate?.();
    }
  };
  return html`
    <div class="${blockClass}">
      <div class="pm-chart-zoom-bar">
        <span class="pm-chart-zoom-hint">
          ${isZoomed
            ? html`<strong>Zoomed:</strong> ${chartTimeLabel(viewMinTs)} –
                ${chartTimeLabel(viewMaxTs)} · ${visibleBars.length} of ${bars.length} bars`
            : html`<span class="pm-muted"
                >Scroll on the chart to zoom on time, double-click to reset</span
              >`}
        </span>
        ${isZoomed
          ? html`<button
              type="button"
              class="pm-chart-zoom-reset"
              @click=${() => {
                barChartZoom.delete(zoomKey);
                onRequestUpdate?.();
              }}
            >
              Reset zoom
            </button>`
          : nothing}
      </div>
      <div
        class="pm-chart-wrap"
        @mousemove=${(e: MouseEvent) =>
          handleBarChartHover(
            e,
            visibleBars,
            colorMap,
            viewMinTs,
            tsRange,
            maxSize,
            PAD_L,
            plotW,
            plotH,
            PAD_T,
            H,
            W,
          )}
        @mouseleave=${handleChartLeave}
        @wheel=${onWheel}
        @dblclick=${onDblClick}
      >
        <svg viewBox="0 0 ${W} ${H}" class="pm-chart-svg pm-chart-svg--tall">
          ${yGridLines.map(
            (g) => svg`
              <line x1="${PAD_L}" y1="${g.y}" x2="${W - PAD_R}" y2="${g.y}"
                stroke="#d4d8e8" stroke-width="0.6" stroke-dasharray="3,3" />
              <text x="${PAD_L - 6}" y="${g.y + 4}" text-anchor="end"
                fill="#6b7280" font-size="11" font-family="monospace">${g.label}</text>
            `,
          )}
          <line
            x1="${PAD_L}"
            y1="${PAD_T + plotH}"
            x2="${W - PAD_R}"
            y2="${PAD_T + plotH}"
            stroke="#c4c9d6"
            stroke-width="0.6"
          />
          ${xTicks.map(
            (t) => svg`
              <text x="${t.x}" y="${H - 8}" text-anchor="middle"
                fill="#6b7280" font-size="11" font-family="monospace">${t.label}</text>
            `,
          )}
          ${visibleBars.map((b) => {
            const x = toX(b.ts) - barWidth / 2;
            const y = toY(b.size);
            const h = PAD_T + plotH - y;
            const fill = colorMap.get(b.type) ?? "#64748b";
            return svg`<rect x="${x}" y="${y}" width="${barWidth}" height="${h}"
              fill="${fill}" opacity="0.85" />`;
          })}
        </svg>
        <div class="pm-chart-tooltip" id="${chartId}-tip"></div>
        <div class="pm-chart-crosshair" id="${chartId}-cross"></div>
      </div>
    </div>
  `;
}

function handleBarChartHover(
  e: MouseEvent,
  bars: MessageBar[],
  colorMap: Map<string, string>,
  minTs: number,
  tsRange: number,
  maxSize: number,
  padL: number,
  plotW: number,
  plotH: number,
  padT: number,
  chartH: number,
  chartW: number,
) {
  const wrap = e.currentTarget as HTMLElement;
  const rect = wrap.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const svgW = rect.width;

  const xRatio = (mouseX - (padL / chartW) * svgW) / ((plotW / chartW) * svgW);
  if (xRatio < 0 || xRatio > 1) {
    handleChartLeave(e);
    return;
  }
  const hoverTs = minTs + xRatio * tsRange;

  let nearest = bars[0];
  let nearestDist = Infinity;
  for (const b of bars) {
    const d = Math.abs(b.ts - hoverTs);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = b;
    }
  }

  const tip = wrap.querySelector(".pm-chart-tooltip") as HTMLElement | null;
  const cross = wrap.querySelector(".pm-chart-crosshair") as HTMLElement | null;
  if (!tip || !cross || !nearest) {
    return;
  }

  const nearestXPct = ((nearest.ts - minTs) / tsRange) * 100;
  const padLPct = (padL / chartW) * 100;
  const plotWPct = (plotW / chartW) * 100;
  const crossLeftPct = padLPct + (nearestXPct / 100) * plotWPct;

  cross.style.display = "block";
  cross.style.left = `${crossLeftPct}%`;

  tip.style.display = "block";
  const time = new Date(nearest.ts).toLocaleTimeString("en-US", {
    hour12: false,
    fractionalSecondDigits: 1,
  });
  const swatch = colorMap.get(nearest.type) ?? "#64748b";
  tip.innerHTML =
    `<b>${formatBytes(nearest.size)}</b><br/>` +
    `<span style="display:inline-block;width:8px;height:8px;background:${swatch};border-radius:2px;margin-right:4px;vertical-align:middle;"></span>` +
    `${nearest.type}<br/>` +
    `<span style="color:#9ca3af;">${time}</span>`;

  const tipLeft = crossLeftPct > 70 ? crossLeftPct - 22 : crossLeftPct + 3;
  tip.style.left = `${tipLeft}%`;
  const nearestYPct = padT + plotH - (nearest.size / maxSize) * plotH;
  tip.style.top = `${(nearestYPct / chartH) * 100 - 12}%`;
}

/**
 * Wheel-zoom on the messages bar chart's x-axis. Zooms in (deltaY < 0) /
 * out (deltaY > 0) around the cursor's time position so the bar under the
 * cursor stays under the cursor through the zoom step. Updates the module-
 * level `barChartZoom` map for the given key; the caller is expected to
 * trigger a re-render so the chart picks up the new range.
 *
 * Pan with shift+wheel: shifts the visible range left/right by ~10% per
 * tick. Auto-resets to no-zoom if the user zooms out past the data bounds.
 */
function handleBarChartZoom(
  e: WheelEvent,
  zoomKey: string,
  curMinTs: number,
  curMaxTs: number,
  autoMinTs: number,
  autoMaxTs: number,
  padL: number,
  plotW: number,
  chartW: number,
) {
  const wrap = e.currentTarget as HTMLElement;
  const rect = wrap.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const svgW = rect.width;
  // Cursor's position within the plot area, [0, 1]. Outside the plot area we
  // anchor at 0.5 (center) so axis-label hovers still produce a sensible zoom.
  const xRatioRaw = (mouseX - (padL / chartW) * svgW) / ((plotW / chartW) * svgW);
  const xRatio = xRatioRaw >= 0 && xRatioRaw <= 1 ? xRatioRaw : 0.5;
  const curSpan = curMaxTs - curMinTs;
  const autoSpan = autoMaxTs - autoMinTs;
  if (e.shiftKey) {
    // Pan: shift the visible range by 10% of the current span per wheel tick.
    // Direction follows scroll wheel sign (deltaY > 0 = scroll down = pan
    // forward in time, mirroring how OS scroll typically maps to "forward").
    const dir = Math.sign(e.deltaY) || 1;
    const delta = curSpan * 0.1 * dir;
    let nextMin = curMinTs + delta;
    let nextMax = curMaxTs + delta;
    if (nextMin < autoMinTs) {
      nextMax += autoMinTs - nextMin;
      nextMin = autoMinTs;
    }
    if (nextMax > autoMaxTs) {
      nextMin -= nextMax - autoMaxTs;
      nextMax = autoMaxTs;
    }
    nextMin = Math.max(nextMin, autoMinTs);
    nextMax = Math.min(nextMax, autoMaxTs);
    if (nextMax - nextMin >= MIN_ZOOM_SPAN_MS) {
      barChartZoom.set(zoomKey, { minTs: nextMin, maxTs: nextMax });
    }
    return;
  }
  // Zoom: scale the visible span by 0.8 (zoom in) / 1.25 (zoom out) per tick,
  // anchored at the cursor's current ts so the bar under the cursor is fixed.
  const factor = e.deltaY < 0 ? 0.8 : 1.25;
  const cursorTs = curMinTs + xRatio * curSpan;
  let nextSpan = curSpan * factor;
  // Cap at the auto span — zooming out past the data bounds reverts to auto.
  if (nextSpan >= autoSpan) {
    barChartZoom.delete(zoomKey);
    return;
  }
  if (nextSpan < MIN_ZOOM_SPAN_MS) {
    nextSpan = MIN_ZOOM_SPAN_MS;
  }
  let nextMin = cursorTs - xRatio * nextSpan;
  let nextMax = cursorTs + (1 - xRatio) * nextSpan;
  // Clamp into the auto bounds, sliding the window so the span stays the same
  // (so the cursor's anchored ts may shift slightly when near the edges).
  if (nextMin < autoMinTs) {
    nextMax += autoMinTs - nextMin;
    nextMin = autoMinTs;
  }
  if (nextMax > autoMaxTs) {
    nextMin -= nextMax - autoMaxTs;
    nextMax = autoMaxTs;
  }
  nextMin = Math.max(nextMin, autoMinTs);
  nextMax = Math.min(nextMax, autoMaxTs);
  barChartZoom.set(zoomKey, { minTs: nextMin, maxTs: nextMax });
}

function renderMessagesSection(
  net: NetworkStats,
  direction: NetworkDirection,
  color: string,
  openExp: (key: string) => () => void,
  timeWindow: TimeWindow | undefined,
  onRequestUpdate: (() => void) | undefined,
): TemplateResult | typeof nothing {
  const data = selectDirectionMessages(net, direction);
  if (!data) {
    return nothing;
  }
  const totalCount = data.cards.reduce((a, c) => a + c.count, 0);
  if (data.cards.length === 0) {
    return html`
      <div class="pm-net-section-title">Messages · ${totalCount} total</div>
      <div class="pm-chart-empty" style="height:80px;line-height:80px;">
        No messages observed yet on this direction.
      </div>
    `;
  }
  // Stable color per type so bars and legend (and cards' left border) align.
  const colorMap = buildMessageTypeColorMap(data.cards.map((c) => c.type));
  // Chart first (full width), then the legend (always visible — it's a key
  // for the chart so collapsing it would defeat the chart), then a
  // collapsed-by-default <details> wrapping the per-type cards. Wire-pair
  // tabs can have 20+ distinct types (health/heartbeat/presence/poll/etc.),
  // so showing every card up-front crowds the panel — keep them one click
  // away while the legend stays visible.
  return html`
    <div class="pm-net-section-title">
      Messages · ${totalCount} total · ${data.cards.length}
      ${data.cards.length === 1 ? "type" : "types"}
    </div>
    ${renderMessagesBarChartSvg(
      data,
      colorMap,
      timeWindow,
      `messages-${direction}`,
      onRequestUpdate,
    )}
    <div class="pm-message-legend">
      ${data.cards.map(
        (c) => html`
          <span class="pm-message-legend-item">
            <span
              class="pm-message-legend-swatch"
              style="background:${colorMap.get(c.type) ?? color};"
            ></span>
            <span class="pm-message-legend-label">${c.type}</span>
          </span>
        `,
      )}
    </div>
    <details class="pm-message-types-details">
      <summary class="pm-message-types-summary">
        Show ${data.cards.length} message ${data.cards.length === 1 ? "type" : "types"} (cards)
      </summary>
      <div class="pm-message-cards" style="margin-top:6px;">
        ${data.cards.map(
          (c) => html`
            <button
              class="pm-message-card"
              style="border-left-color:${colorMap.get(c.type) ?? color};"
              @click=${openExp(`messages-${c.type}`)}
            >
              <div class="pm-message-card-type" title=${c.type}>${c.type}</div>
              <div class="pm-message-card-count">${c.count}</div>
              <div class="pm-message-card-sub">
                ${formatBytes(c.minBytes)} – ${formatBytes(c.maxBytes)}
              </div>
            </button>
          `,
        )}
      </div>
    </details>
  `;
}

/**
 * Stable color per agent|model event category. Picked to be visually distinct
 * (request green, sse blue gradient, tool orange/red, complete grey).
 */
const AGENT_LLM_CATEGORY_COLORS: Record<AgentLlmEventCategory, string> = {
  request: "#10b981",
  sse: "#3b82f6",
  "tool-call": "#f59e0b",
  "tool-result": "#a855f7",
  complete: "#6b7280",
  other: "#94a3b8",
};

const AGENT_LLM_CATEGORY_LABELS: Record<AgentLlmEventCategory, string> = {
  request: "request",
  sse: "sse",
  "tool-call": "tool call",
  "tool-result": "tool result",
  complete: "complete",
  other: "other",
};

function renderAgentLlmContent(net: NetworkStats, props: ProtocolMonitorProps): TemplateResult {
  const meta = getDirectionMeta(props.networkDirection);
  const openExp = (key: string) => () => props.onOpenNetworkExplainer(key);
  const timeWindow = computeGlobalTimeWindow(net);
  const stats = net.agentLlm;
  const ttft = stats.ttft;
  const colorMap = new Map<string, string>(
    (Object.entries(AGENT_LLM_CATEGORY_COLORS) as Array<[AgentLlmEventCategory, string]>).map(
      ([cat, color]) => [cat, color],
    ),
  );

  return html`
    <div class="pm-net-direction-header">
      <span class="pm-dot" style="background:${meta.color};"></span>
      <strong>${meta.longLabel}</strong>
    </div>

    <!-- 1. Events by category — chart first, legend always visible, cards collapsed -->
    <div class="pm-net-section-title">
      Events by category · ${stats.totalEvents} total · ${stats.cards.length}
      ${stats.cards.length === 1 ? "type" : "types"}
    </div>
    ${renderAgentLlmEventChartSvg(stats.bars, colorMap, timeWindow, props.onRequestUpdate)}
    <div class="pm-message-legend">
      ${stats.cards.map((c) => {
        const cat = c.category;
        const color = colorMap.get(cat) ?? meta.color;
        return html`
          <span class="pm-message-legend-item">
            <span class="pm-message-legend-swatch" style="background:${color};"></span>
            <span class="pm-message-legend-label">${AGENT_LLM_CATEGORY_LABELS[cat]}</span>
          </span>
        `;
      })}
    </div>
    ${stats.cards.length === 0
      ? nothing
      : html`
          <details class="pm-message-types-details">
            <summary class="pm-message-types-summary">
              Show ${stats.cards.length} event
              ${stats.cards.length === 1 ? "category" : "categories"} (cards)
            </summary>
            <div class="pm-message-cards" style="margin-top:6px;">
              ${stats.cards.map((c) => {
                const cat = c.category;
                const color = colorMap.get(cat) ?? meta.color;
                return html`
                  <button
                    class="pm-message-card"
                    style="border-left-color:${color};"
                    @click=${openExp(`llm-event-${cat}`)}
                  >
                    <div class="pm-message-card-type" title=${AGENT_LLM_CATEGORY_LABELS[cat]}>
                      ${AGENT_LLM_CATEGORY_LABELS[cat]}
                    </div>
                    <div class="pm-message-card-count">${c.count}</div>
                    <div class="pm-message-card-sub">
                      ${formatBytes(c.minBytes)} – ${formatBytes(c.maxBytes)}
                    </div>
                  </button>
                `;
              })}
            </div>
          </details>
        `}

    <!-- 2. TTFT — single merged row of distribution stats (no chart) -->
    <div class="pm-net-section-title" style="margin-top:14px;">
      TTFT · ${ttft.count} ${ttft.count === 1 ? "call" : "calls"}
    </div>
    ${renderNetStatRow([
      {
        title: "Min",
        value: formatMs(ttft.minMs),
        sub: "best",
        onClick: openExp("lat-ttft-min"),
      },
      {
        title: "Avg",
        value: formatMs(ttft.avgMs),
        sub: `${ttft.count} samples`,
        onClick: openExp("lat-ttft-avg"),
      },
      {
        title: "p50",
        value: formatMs(ttft.p50Ms),
        sub: "median",
        onClick: openExp("lat-ttft-p50"),
      },
      {
        title: "p95",
        value: formatMs(ttft.p95Ms),
        sub: "tail",
        onClick: openExp("lat-ttft-p95"),
      },
      {
        title: "Peak",
        value: formatMs(ttft.peakMs),
        sub: "worst",
        onClick: openExp("lat-ttft-peak"),
      },
    ])}

    <!-- 3. Throughput — metrics only (no chart) -->
    ${renderAgentLlmThroughputSection(stats.callThroughput, stats.eventByteStats, openExp)}
  `;
}

function renderAgentLlmEventChartSvg(
  bars: AgentLlmEventBar[],
  colorMap: Map<string, string>,
  timeWindow: TimeWindow | undefined,
  onRequestUpdate?: () => void,
): TemplateResult {
  const zoomKey = "agent-llm-events";
  if (bars.length === 0) {
    return html`<div class="pm-chart-empty" style="height:195px;line-height:195px;">
      Waiting for first agent ↔ model event...
    </div>`;
  }
  const PAD_L = 64;
  const PAD_R = 24;
  const PAD_T = 14;
  const PAD_B = 28;
  const W = 460;
  const H = 195;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const localMin = bars[0]?.ts ?? 0;
  const localMax = bars.length > 1 ? (bars[bars.length - 1]?.ts ?? localMin + 1) : localMin + 1;
  const autoMinTs = timeWindow?.minTs ?? localMin;
  const autoMaxTs = timeWindow?.maxTs ?? localMax;
  // Apply persisted zoom state, with the same stale-clamp logic as the
  // messages chart: if the saved range no longer overlaps current data,
  // self-evict and fall back to auto.
  const zoom = barChartZoom.get(zoomKey);
  let viewMinTs = autoMinTs;
  let viewMaxTs = autoMaxTs;
  let isZoomed = false;
  if (zoom) {
    const clampedMin = Math.max(zoom.minTs, autoMinTs);
    const clampedMax = Math.min(zoom.maxTs, autoMaxTs);
    if (clampedMax - clampedMin >= MIN_ZOOM_SPAN_MS) {
      viewMinTs = clampedMin;
      viewMaxTs = clampedMax;
      isZoomed = true;
    } else {
      barChartZoom.delete(zoomKey);
    }
  }
  const tsRange = Math.max(1, viewMaxTs - viewMinTs);
  // Filter to bars in the visible range so the log y-scale recomputes against
  // what's actually on screen — otherwise a single off-screen 200KB request
  // would squash the visible SSE deltas to nothing.
  const visibleBars = isZoomed ? bars.filter((b) => b.ts >= viewMinTs && b.ts <= viewMaxTs) : bars;
  // log scale for y so SSE deltas (tens of bytes) and request bodies
  // (hundreds of KB) coexist without the small bars vanishing.
  const sizes = visibleBars.map((b) => Math.max(1, b.size));
  const maxSize = Math.max(...sizes, 1);
  const logMax = Math.log10(maxSize + 1);
  const toX = (ts: number) => PAD_L + ((ts - viewMinTs) / tsRange) * plotW;
  const toY = (s: number) => PAD_T + plotH - (Math.log10(Math.max(1, s) + 1) / logMax) * plotH;
  const yGridCount = 4;
  const yGridLines = Array.from({ length: yGridCount }, (_, i) => {
    const exp = (logMax / yGridCount) * (i + 1);
    const val = 10 ** exp - 1;
    return { y: toY(val), label: formatBytes(val) };
  });
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const ts = viewMinTs + (tsRange / (xTickCount - 1)) * i;
    return { x: toX(ts), label: chartTimeLabel(ts) };
  });
  const barWidth = 2;
  const chartId = `agent-llm-bars-${(bars[0]?.ts ?? 0).toString(36)}`;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    handleBarChartZoom(e, zoomKey, viewMinTs, viewMaxTs, autoMinTs, autoMaxTs, PAD_L, plotW, W);
    onRequestUpdate?.();
  };
  const onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    if (barChartZoom.has(zoomKey)) {
      barChartZoom.delete(zoomKey);
      onRequestUpdate?.();
    }
  };
  return html`
    <div class="pm-chart-block">
      <div class="pm-chart-zoom-bar">
        <span class="pm-chart-zoom-hint">
          ${isZoomed
            ? html`<strong>Zoomed:</strong> ${chartTimeLabel(viewMinTs)} –
                ${chartTimeLabel(viewMaxTs)} · ${visibleBars.length} of ${bars.length} events`
            : html`<span class="pm-muted"
                >Scroll on the chart to zoom on time, double-click to reset</span
              >`}
        </span>
        ${isZoomed
          ? html`<button
              type="button"
              class="pm-chart-zoom-reset"
              @click=${() => {
                barChartZoom.delete(zoomKey);
                onRequestUpdate?.();
              }}
            >
              Reset zoom
            </button>`
          : nothing}
      </div>
      <div
        class="pm-chart-wrap"
        @mousemove=${(e: MouseEvent) =>
          handleAgentLlmBarHover(
            e,
            visibleBars,
            colorMap,
            viewMinTs,
            tsRange,
            logMax,
            PAD_L,
            plotW,
            plotH,
            PAD_T,
            H,
            W,
          )}
        @mouseleave=${handleChartLeave}
        @wheel=${onWheel}
        @dblclick=${onDblClick}
      >
        <svg viewBox="0 0 ${W} ${H}" class="pm-chart-svg pm-chart-svg--tall">
          ${yGridLines.map(
            (g) => svg`
              <line x1="${PAD_L}" y1="${g.y}" x2="${W - PAD_R}" y2="${g.y}"
                stroke="#d4d8e8" stroke-width="0.6" stroke-dasharray="3,3" />
              <text x="${PAD_L - 6}" y="${g.y + 4}" text-anchor="end"
                fill="#6b7280" font-size="11" font-family="monospace">${g.label}</text>
            `,
          )}
          <line
            x1="${PAD_L}"
            y1="${PAD_T + plotH}"
            x2="${W - PAD_R}"
            y2="${PAD_T + plotH}"
            stroke="#c4c9d6"
            stroke-width="0.6"
          />
          ${xTicks.map(
            (t) => svg`
              <text x="${t.x}" y="${H - 8}" text-anchor="middle"
                fill="#6b7280" font-size="11" font-family="monospace">${t.label}</text>
            `,
          )}
          ${visibleBars.map((b) => {
            const x = toX(b.ts) - barWidth / 2;
            const y = toY(b.size);
            const h = PAD_T + plotH - y;
            const fill = colorMap.get(b.category) ?? "#64748b";
            return svg`<rect x="${x}" y="${y}" width="${barWidth}" height="${h}"
              fill="${fill}" opacity="0.85" />`;
          })}
        </svg>
        <div class="pm-chart-tooltip" id="${chartId}-tip"></div>
        <div class="pm-chart-crosshair" id="${chartId}-cross"></div>
      </div>
    </div>
  `;
}

function handleAgentLlmBarHover(
  e: MouseEvent,
  bars: AgentLlmEventBar[],
  colorMap: Map<string, string>,
  minTs: number,
  tsRange: number,
  logMax: number,
  padL: number,
  plotW: number,
  plotH: number,
  padT: number,
  chartH: number,
  chartW: number,
) {
  const wrap = e.currentTarget as HTMLElement;
  const rect = wrap.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const svgW = rect.width;
  const xRatio = (mouseX - (padL / chartW) * svgW) / ((plotW / chartW) * svgW);
  if (xRatio < 0 || xRatio > 1) {
    handleChartLeave(e);
    return;
  }
  const hoverTs = minTs + xRatio * tsRange;
  let nearest = bars[0];
  let nearestDist = Infinity;
  for (const b of bars) {
    const d = Math.abs(b.ts - hoverTs);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = b;
    }
  }
  const tip = wrap.querySelector(".pm-chart-tooltip") as HTMLElement | null;
  const cross = wrap.querySelector(".pm-chart-crosshair") as HTMLElement | null;
  if (!tip || !cross || !nearest) {
    return;
  }
  const nearestXPct = ((nearest.ts - minTs) / tsRange) * 100;
  const padLPct = (padL / chartW) * 100;
  const plotWPct = (plotW / chartW) * 100;
  const crossLeftPct = padLPct + (nearestXPct / 100) * plotWPct;
  cross.style.display = "block";
  cross.style.left = `${crossLeftPct}%`;
  tip.style.display = "block";
  const time = new Date(nearest.ts).toLocaleTimeString("en-US", {
    hour12: false,
    fractionalSecondDigits: 1,
  });
  const swatch = colorMap.get(nearest.category) ?? "#64748b";
  const detailStr = nearest.detail
    ? `<br/><span style="color:#6b7280;">${nearest.detail}</span>`
    : "";
  tip.innerHTML =
    `<b>${formatBytes(nearest.size)}</b><br/>` +
    `<span style="display:inline-block;width:8px;height:8px;background:${swatch};border-radius:2px;margin-right:4px;vertical-align:middle;"></span>` +
    `${AGENT_LLM_CATEGORY_LABELS[nearest.category] ?? nearest.category}${detailStr}<br/>` +
    `<span style="color:#9ca3af;">${time}</span>`;
  const tipLeft = crossLeftPct > 70 ? crossLeftPct - 22 : crossLeftPct + 3;
  tip.style.left = `${tipLeft}%`;
  const nearestYPct = padT + plotH - (Math.log10(Math.max(1, nearest.size) + 1) / logMax) * plotH;
  tip.style.top = `${(nearestYPct / chartH) * 100 - 12}%`;
}

function renderDirectionContent(net: NetworkStats, props: ProtocolMonitorProps): TemplateResult {
  // Agent ↔ Model has its own dedicated 3-section layout (Events by category,
  // TTFT, Throughput) — see renderAgentLlmContent below.
  if (props.networkDirection === "agent-llm") {
    return renderAgentLlmContent(net, props);
  }
  const meta = getDirectionMeta(props.networkDirection);
  const samples = selectDirectionThroughput(net, props.networkDirection);
  const latency = selectDirectionLatency(net, props.networkDirection);

  const openExp = (key: string) => () => props.onOpenNetworkExplainer(key);

  // Shared x-axis across ALL direction tabs (op-gw, gw-op, node-gw, gw-node,
  // agent-llm, llm-agent). Computed once per net snapshot from every chart's
  // samples — switching tabs preserves the same time window so events line
  // up vertically across both the three charts on the current tab and the
  // charts on any other tab.
  const timeWindow = computeGlobalTimeWindow(net);

  return html`
    <div class="pm-net-direction-header">
      <span class="pm-dot" style="background:${meta.color};"></span>
      <strong>${meta.longLabel}</strong>
    </div>

    <!-- 1. Messages — type cards + size bar chart -->
    ${renderMessagesSection(
      net,
      props.networkDirection,
      meta.color,
      openExp,
      timeWindow,
      props.onRequestUpdate,
    )}

    <!-- 2. Latency — chart first, then a single merged row of distribution stats -->
    ${latency
      ? html`
          <div class="pm-net-section-title" style="margin-top:14px;">
            Latency · ${latency.label}
          </div>
          ${renderLatencyChartSvg(latency.label, latency.stats, meta.color, timeWindow)}
          ${renderNetStatRow([
            {
              title: "Min",
              value: formatMs(latency.stats.minMs),
              sub: "best sample",
              onClick: openExp(`${latency.latencyKey}-min`),
            },
            {
              title: "Avg",
              value: formatMs(latency.stats.avgMs),
              sub: `${latency.stats.count} samples`,
              onClick: openExp(`${latency.latencyKey}-avg`),
            },
            {
              title: "p50",
              value: formatMs(latency.stats.p50Ms),
              sub: "median",
              onClick: openExp(`${latency.latencyKey}-p50`),
            },
            {
              title: "p95",
              value: formatMs(latency.stats.p95Ms),
              sub: "tail",
              onClick: openExp(`${latency.latencyKey}-p95`),
            },
            {
              title: "Peak",
              value: formatMs(latency.stats.peakMs),
              sub: "worst sample",
              onClick: openExp(`${latency.latencyKey}-peak`),
            },
          ])}
        `
      : html`
          <div class="pm-net-section-title" style="margin-top:14px;">Latency</div>
          <div class="pm-net-no-latency">
            该方向没有独立测量的 latency 指标。Operator ↔ Gateway 这一段链路的耗时
            在协议层不会被单独打点;如果需要观察端到端响应时间,请看
            <strong>Agent → Model</strong> 标签页。
          </div>
        `}

    <!-- 3. Throughput — metrics only (no chart) -->
    ${renderWireThroughputStatsSection(
      samples,
      selectDirectionMessages(net, props.networkDirection),
      openExp,
    )}
  `;
}

/**
 * Render the Throughput section as a metrics-only block (no chart). Two
 * groups:
 *   - Per-message throughput (bytes/sec): derived from each message's
 *     envelope-aware bytes ÷ measured one-way latency. Source = the existing
 *     per-message throughput infrastructure (peer→gw uses trace.oneWayLatencyMs;
 *     gw→peer uses peer-reported rxSamples). Skips messages without a
 *     measured latency, so this set is a subset of the Messages section.
 *   - Per-message bytes: sourced directly from the Messages section's bar
 *     data (messageStore via selectDirectionMessages). Counts/min/max/avg
 *     here therefore always match the per-type cards above.
 */
function renderWireThroughputStatsSection(
  throughputSamples: ThroughputSample[],
  messages: MessagesDirection | null,
  openExp: (key: string) => () => void,
): TemplateResult {
  const tptCount = throughputSamples.length;
  const messageCount = messages?.bars.length ?? 0;
  if (tptCount === 0 && messageCount === 0) {
    return html`
      <div class="pm-net-section-title" style="margin-top:14px;">Throughput</div>
      <div class="pm-chart-empty" style="height:80px;line-height:80px;">
        Waiting for first measured message on this direction.
      </div>
    `;
  }

  // Per-message throughput (only messages with measured latency contribute).
  let tptMin = 0;
  let tptPeak = 0;
  let tptAvg = 0;
  let tptMedian = 0;
  if (tptCount > 0) {
    const bytesPerSecValues = throughputSamples.map((s) => s.bytesPerSec);
    const sortedTpt = bytesPerSecValues.slice().toSorted((a, b) => a - b);
    const tptSum = sortedTpt.reduce((a, b) => a + b, 0);
    tptMin = sortedTpt[0] ?? 0;
    tptPeak = sortedTpt[sortedTpt.length - 1] ?? 0;
    tptAvg = tptSum / tptCount;
    tptMedian = sortedTpt[Math.floor(tptCount * 0.5)] ?? 0;
  }

  // Per-message bytes — sourced from the same messageStore that feeds the
  // Messages section, so the numbers MATCH (no separate filter, no
  // bucket-vs-message confusion).
  let minBytes = 0;
  let maxBytes = 0;
  let avgBytes = 0;
  let medianBytes = 0;
  let totalBytes = 0;
  if (messageCount > 0 && messages) {
    const byteValues = messages.bars.map((b) => b.size);
    const sortedBytes = byteValues.slice().toSorted((a, b) => a - b);
    totalBytes = sortedBytes.reduce((a, b) => a + b, 0);
    minBytes = sortedBytes[0] ?? 0;
    maxBytes = sortedBytes[sortedBytes.length - 1] ?? 0;
    avgBytes = totalBytes / messageCount;
    medianBytes = sortedBytes[Math.floor(messageCount * 0.5)] ?? 0;
  }

  return html`
    <div class="pm-net-section-title" style="margin-top:14px;">Throughput</div>
    <div class="pm-net-subsection-title">
      Per-message throughput · ${tptCount}
      ${tptCount === 1 ? "measured message" : "measured messages"}
    </div>
    ${tptCount === 0
      ? html`<div class="pm-chart-empty" style="height:60px;line-height:60px;">
          No per-message latency available yet on this direction.
        </div>`
      : renderNetStatRow([
          {
            title: "Min",
            value: `${formatBytes(tptMin)}/s`,
            sub: "slowest message",
            onClick: openExp("throughput-min"),
          },
          {
            title: "Peak",
            value: `${formatBytes(tptPeak)}/s`,
            sub: "fastest message",
            onClick: openExp("throughput-peak"),
          },
          {
            title: "Average",
            value: `${formatBytes(tptAvg)}/s`,
            sub: `over ${tptCount} messages`,
            onClick: openExp("throughput-avg"),
          },
          {
            title: "Median",
            value: `${formatBytes(tptMedian)}/s`,
            sub: "p50",
            onClick: openExp("throughput-median"),
          },
        ])}
    <div class="pm-net-subsection-title" style="margin-top:10px;">
      Per-message bytes · ${messageCount} ${messageCount === 1 ? "message" : "messages"}
    </div>
    ${messageCount === 0
      ? html`<div class="pm-chart-empty" style="height:60px;line-height:60px;">
          No messages on this direction yet.
        </div>`
      : renderNetStatRow([
          {
            title: "Min",
            value: formatBytes(minBytes),
            sub: "smallest frame",
            onClick: openExp("throughput-bytes-min"),
          },
          {
            title: "Max",
            value: formatBytes(maxBytes),
            sub: "largest frame",
            onClick: openExp("throughput-bytes-max"),
          },
          {
            title: "Average",
            value: formatBytes(avgBytes),
            sub: `over ${messageCount} messages`,
            onClick: openExp("throughput-bytes-avg"),
          },
          {
            title: "Median",
            value: formatBytes(medianBytes),
            sub: "p50",
            onClick: openExp("throughput-bytes-median"),
          },
          {
            title: "Total",
            value: formatBytes(totalBytes),
            sub: "all frames summed",
            onClick: openExp("throughput-total"),
          },
        ])}
  `;
}

/**
 * Render the Throughput section for the agent|model tab. Per-LLM-call
 * generation throughput only (per-event bytes was removed because the
 * Events-by-category cards above the chart already show min/max/total per
 * category, which subsumed and visually overlapped this row).
 */
function renderAgentLlmThroughputSection(
  callThroughput: ThroughputDirectionStats,
  _eventByteStats: PayloadByteStats,
  openExp: (key: string) => () => void,
): TemplateResult {
  const tpt = callThroughput;
  if (tpt.count === 0) {
    return html`
      <div class="pm-net-section-title" style="margin-top:14px;">Throughput</div>
      <div class="pm-chart-empty" style="height:80px;line-height:80px;">
        Waiting for first measurable LLM call on this direction.
      </div>
    `;
  }
  return html`
    <div class="pm-net-section-title" style="margin-top:14px;">
      Throughput · ${tpt.count} ${tpt.count === 1 ? "call" : "calls"}
    </div>
    <div class="pm-net-subsection-title">Per-call generation throughput</div>
    ${renderNetStatRow([
      {
        title: "Min",
        value: `${formatBytes(tpt.minBytesPerSec ?? 0)}/s`,
        sub: "slowest call",
        onClick: openExp("agentllm-throughput-min"),
      },
      {
        title: "Peak",
        value: `${formatBytes(tpt.peakBytesPerSec ?? 0)}/s`,
        sub: "fastest call",
        onClick: openExp("agentllm-throughput-peak"),
      },
      {
        title: "Average",
        value: `${formatBytes(tpt.avgBytesPerSec ?? 0)}/s`,
        sub: `over ${tpt.count} calls`,
        onClick: openExp("agentllm-throughput-avg"),
      },
      {
        title: "Median",
        value: `${formatBytes(tpt.p50BytesPerSec ?? 0)}/s`,
        sub: "p50",
        onClick: openExp("agentllm-throughput-median"),
      },
    ])}
  `;
}

/**
 * Render a horizontal "merged" stat row — one full-width card containing
 * several sibling metrics for the same dimension (e.g. min | avg | p50 | p95
 * | peak), separated by vertical lines. Each cell is independently clickable
 * (mouse + keyboard) and opens the same explainer overlay as the old
 * one-card-per-metric layout.
 */
function renderNetStatRow(
  cells: Array<{ title: string; value: string; sub: string; onClick: () => void }>,
): TemplateResult {
  return html`
    <div class="pm-net-stat-row">
      ${cells.map(
        (c) => html`
          <button
            type="button"
            class="pm-net-stat-row-cell"
            role="button"
            title="点击查看说明"
            @click=${c.onClick}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                c.onClick();
              }
            }}
          >
            <div class="pm-net-stat-row-cell-title">
              ${c.title}<span class="pm-ucard-info">ⓘ</span>
            </div>
            <div class="pm-net-stat-row-cell-value">${c.value}</div>
            <div class="pm-net-stat-row-cell-sub">${c.sub}</div>
          </button>
        `,
      )}
    </div>
  `;
}

/** Median of an array of numbers (p50). Returns null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.slice().toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)] ?? null;
}

function chartTimeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Section 6: Latency stats + charts (right, below throughput)
// ---------------------------------------------------------------------------

function formatMs(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function renderLatencyChartSvg(
  label: string,
  stats: LatencyStats,
  color: string,
  timeWindow?: TimeWindow,
): TemplateResult {
  const { samples } = stats;
  if (samples.length === 0) {
    return html`
      <div class="pm-chart-block">
        <div class="pm-chart-empty" style="height:195px;line-height:195px;">
          Waiting for data...
        </div>
      </div>
    `;
  }

  const PAD_L = 64;
  const PAD_R = 24;
  const PAD_T = 14;
  const PAD_B = 28;
  const W = 460;
  const H = 195;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const maxVal = Math.max(stats.peakMs ?? 1, 1);
  const localMin = samples[0].ts;
  const localMax = samples.length > 1 ? samples[samples.length - 1].ts : localMin + 1000;
  const minTs = timeWindow?.minTs ?? localMin;
  const maxTs = timeWindow?.maxTs ?? localMax;
  const tsRange = maxTs - minTs || 1;
  const toX = (ts: number) => PAD_L + ((ts - minTs) / tsRange) * plotW;
  const toY = (v: number) => PAD_T + plotH - (v / maxVal) * plotH;

  const yGridCount = 4;
  const yGridLines = Array.from({ length: yGridCount }, (_, i) => {
    const val = (maxVal / yGridCount) * (i + 1);
    return { y: toY(val), label: formatMs(val) };
  });
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const ts = minTs + (tsRange / (xTickCount - 1)) * i;
    return { x: toX(ts), label: chartTimeLabel(ts) };
  });

  // Time-series polyline + area fill — gives the chart a shape even when
  // samples are sparse, instead of looking like "just an average line".
  const linePoints = samples.map((s) => `${toX(s.ts)},${toY(s.latencyMs)}`).join(" ");
  const areaPoints = `${toX(localMin)},${PAD_T + plotH} ${linePoints} ${toX(localMax)},${PAD_T + plotH}`;

  // Reference lines for the distribution. Drawn back-to-front so the headline
  // (avg) renders on top. Skip lines whose value is 0 — happens before any
  // samples, or when the metric truly is zero everywhere.
  const refLines = [
    { val: stats.peakMs ?? 0, label: "peak", dash: "2,4", opacity: 0.35, weight: 0.7 },
    { val: stats.p95Ms ?? 0, label: "p95", dash: "5,3", opacity: 0.55, weight: 1 },
    { val: stats.p50Ms ?? 0, label: "p50", dash: "4,4", opacity: 0.55, weight: 1 },
    { val: stats.avgMs ?? 0, label: "avg", dash: "6,4", opacity: 0.85, weight: 1.5 },
    { val: stats.minMs ?? 0, label: "min", dash: "2,4", opacity: 0.45, weight: 0.7 },
  ].filter((r) => r.val > 0);

  const chartId = `lat-${label.replace(/\W/g, "")}`;

  return html`
    <div class="pm-chart-block">
      <div
        class="pm-chart-wrap"
        @mousemove=${(e: MouseEvent) =>
          handleLatencyChartHover(
            e,
            samples,
            minTs,
            tsRange,
            maxVal,
            PAD_L,
            plotW,
            plotH,
            PAD_T,
            H,
            W,
          )}
        @mouseleave=${handleChartLeave}
      >
        <svg viewBox="0 0 ${W} ${H}" class="pm-chart-svg pm-chart-svg--tall">
          ${yGridLines.map(
            (g) => svg`
            <line x1="${PAD_L}" y1="${g.y}" x2="${W - PAD_R}" y2="${g.y}"
              stroke="#d4d8e8" stroke-width="0.6" stroke-dasharray="3,3" />
            <text x="${PAD_L - 6}" y="${g.y + 4}" text-anchor="end"
              fill="#6b7280" font-size="11" font-family="monospace">${g.label}</text>
          `,
          )}
          <line
            x1="${PAD_L}"
            y1="${PAD_T + plotH}"
            x2="${W - PAD_R}"
            y2="${PAD_T + plotH}"
            stroke="#c4c9d6"
            stroke-width="0.6"
          />
          ${xTicks.map(
            (t) => svg`
            <text x="${t.x}" y="${H - 8}" text-anchor="middle"
              fill="#6b7280" font-size="11" font-family="monospace">${t.label}</text>
          `,
          )}
          ${refLines.map(
            (r) => svg`
            <line x1="${PAD_L}" y1="${toY(r.val)}" x2="${W - PAD_R}" y2="${toY(r.val)}"
              stroke="${color}" stroke-width="${r.weight}"
              stroke-dasharray="${r.dash}" opacity="${r.opacity}" />
            <text x="${W - PAD_R + 2}" y="${toY(r.val) + 4}"
              fill="${color}" font-size="10" font-family="monospace"
              font-weight="600" opacity="${Math.min(1, r.opacity + 0.1)}">${r.label}</text>
          `,
          )}
          <polygon points="${areaPoints}" fill="${color}" opacity="0.15" />
          <polyline
            points="${linePoints}"
            fill="none"
            stroke="${color}"
            stroke-width="1.5"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          ${samples.map(
            (s) => svg`
            <circle cx="${toX(s.ts)}" cy="${toY(s.latencyMs)}" r="3.5"
              fill="${color}" stroke="#ffffff" stroke-width="1" opacity="0.95" />
          `,
          )}
        </svg>
        <div class="pm-chart-tooltip" id="${chartId}-tip"></div>
        <div class="pm-chart-crosshair" id="${chartId}-cross"></div>
      </div>
    </div>
  `;
}

// Keep for backwards compat
function handleLatencyChartHover(
  e: MouseEvent,
  samples: LatencySample[],
  minTs: number,
  tsRange: number,
  maxVal: number,
  padL: number,
  plotW: number,
  plotH: number,
  padT: number,
  chartH: number,
  chartW: number,
) {
  const wrap = e.currentTarget as HTMLElement;
  const rect = wrap.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const svgW = rect.width;

  const xRatio = (mouseX - (padL / chartW) * svgW) / ((plotW / chartW) * svgW);
  if (xRatio < 0 || xRatio > 1) {
    handleChartLeave(e);
    return;
  }
  const hoverTs = minTs + xRatio * tsRange;

  let nearest = samples[0];
  let nearestDist = Infinity;
  for (const s of samples) {
    const d = Math.abs(s.ts - hoverTs);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = s;
    }
  }

  const tip = wrap.querySelector(".pm-chart-tooltip") as HTMLElement | null;
  const cross = wrap.querySelector(".pm-chart-crosshair") as HTMLElement | null;
  if (!tip || !cross || !nearest) {
    return;
  }

  const nearestXPct = ((nearest.ts - minTs) / tsRange) * 100;
  const padLPct = (padL / chartW) * 100;
  const plotWPct = (plotW / chartW) * 100;
  const crossLeftPct = padLPct + (nearestXPct / 100) * plotWPct;

  cross.style.display = "block";
  cross.style.left = `${crossLeftPct}%`;

  tip.style.display = "block";
  const labelStr = nearest.label ? `<br/>${nearest.label}` : "";
  const modelStr = nearest.model
    ? `<br/><span style="color:#6b7280;">model:</span> ${nearest.model}`
    : "";
  tip.innerHTML =
    `<b>${formatMs(nearest.latencyMs)}</b>${labelStr}${modelStr}<br/>` +
    `<span style="color:#9ca3af;">${new Date(nearest.ts).toLocaleTimeString("en-US", {
      hour12: false,
      fractionalSecondDigits: 1,
    })}</span>`;

  const tipLeft = crossLeftPct > 70 ? crossLeftPct - 22 : crossLeftPct + 3;
  tip.style.left = `${tipLeft}%`;
  const nearestYPct = padT + plotH - (nearest.latencyMs / maxVal) * plotH;
  tip.style.top = `${(nearestYPct / chartH) * 100 - 12}%`;
}

function handleChartLeave(e: Event) {
  const wrap = e.currentTarget as HTMLElement;
  const tip = wrap.querySelector(".pm-chart-tooltip") as HTMLElement | null;
  const cross = wrap.querySelector(".pm-chart-crosshair") as HTMLElement | null;
  if (tip) {
    tip.style.display = "none";
  }
  if (cross) {
    cross.style.display = "none";
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = /* css */ `
  .pm-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    color: #1a1a2e;
    background: #f8f9fc;
  }

  /* Usage overview */
  .pm-overview {
    padding: 0;
  }
  .pm-usage-empty {
    padding: 8px 10px;
    border: 1px dashed #d4d8e8;
    border-radius: 6px;
    background: #fafbff;
    color: #6b7280;
    font-size: 11px;
    line-height: 1.45;
  }
  .pm-usage-empty strong {
    color: #374151;
  }
  .pm-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .pm-ucard {
    border: 1px solid #d4d8e8;
    border-radius: 6px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: #ffffff;
  }
  .pm-ucard--good { border-left: 3px solid #16a34a; }
  .pm-ucard--warn { border-left: 3px solid #d97706; }
  .pm-ucard--bad { border-left: 3px solid #dc2626; }
  .pm-ucard-title {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    font-weight: 600;
  }
  .pm-ucard-value {
    font-size: 14px;
    font-weight: 700;
    color: #1a1a2e;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pm-ucard-sub {
    font-size: 9px;
    color: #9ca3af;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pm-check {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    user-select: none;
    font-size: 11px;
  }
  .pm-btn {
    background: #ffffff;
    color: #1a1a2e;
    border: 1px solid #d4d8e8;
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
    font-size: 11px;
  }
  .pm-btn:hover { background: #eef0f6; }
  .pm-btn.danger { border-color: #fca5a5; color: #dc2626; }
  .pm-btn.danger:hover { background: #fef2f2; }

  /* Tab bar */
  .pm-tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    /* No vertical padding — the protocol-monitor sub-tab row is the very
       first thing inside the page; let it sit flush against the global
       search/nav bar above instead of adding a 4px breathing-room band. */
    padding: 0 10px;
    border-bottom: 1px solid #d4d8e8;
    flex-shrink: 0;
    background: #ffffff;
  }
  .pm-tab-btn {
    background: none;
    border: none;
    color: #6b7280;
    font-size: 12px;
    font-weight: 500;
    padding: 6px 14px;
    cursor: pointer;
    border-radius: 4px;
    transition: color 0.1s, background 0.1s;
    font-family: inherit;
  }
  .pm-tab-btn:hover {
    color: #1a1a2e;
    background: #eef0f6;
  }
  .pm-tab-btn.active {
    color: #1a1a2e;
    background: #e0e4ef;
    font-weight: 600;
  }
  .pm-controls-inline {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pm-export-banner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 999px;
    background: #fef3c7;
    color: #92400e;
    border: 1px solid #fcd34d;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  /* Live / Paused monitoring switch */
  .pm-monitor-switch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
    padding: 2px 10px 2px 4px;
    border: 1px solid #d4d8e8;
    border-radius: 999px;
    background: #ffffff;
    font: inherit;
    color: inherit;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .pm-monitor-switch:hover {
    border-color: #9aa3b8;
  }
  .pm-monitor-switch:focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: 2px;
  }
  .pm-monitor-switch-track {
    position: relative;
    width: 28px;
    height: 16px;
    border-radius: 999px;
    background: #16a34a;
    transition: background 0.15s ease;
    flex-shrink: 0;
  }
  .pm-monitor-switch-thumb {
    position: absolute;
    top: 2px;
    left: 14px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
    transition: left 0.15s ease;
  }
  .pm-monitor-switch--paused .pm-monitor-switch-track {
    background: #94a3b8;
  }
  .pm-monitor-switch--paused .pm-monitor-switch-thumb {
    left: 2px;
  }
  .pm-monitor-switch-label {
    font-size: 11px;
    font-weight: 600;
    color: #16a34a;
    letter-spacing: 0.02em;
  }
  .pm-monitor-switch--paused .pm-monitor-switch-label {
    color: #6b7280;
  }

  /* Tab content */
  .pm-tab-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .pm-pane {
    flex: 1;
    overflow-y: auto;
    /* No top padding — sit flush against the sub-tab bar above. The user
       found the prior 10px gap wasted vertical space on every monitor view. */
    padding: 0 10px 10px;
  }
  .pm-terminology-pane {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .pm-terminology-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px 14px;
  }
  .pm-term-group {
    margin-bottom: 18px;
  }
  .pm-term-group-title {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #1a1a2e;
    border-bottom: 1px solid #d4d8e8;
    padding-bottom: 4px;
  }
  .pm-term-group-intro {
    margin: 6px 0 10px;
    font-size: 11px;
    color: #6b7280;
    line-height: 1.5;
  }
  .pm-term-list {
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pm-term-item {
    display: grid;
    grid-template-columns: minmax(140px, 180px) 1fr;
    gap: 12px;
    padding: 8px 10px;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
  }
  .pm-term-dt {
    font-size: 11px;
    font-weight: 700;
    color: #1a1a2e;
    line-height: 1.4;
  }
  .pm-term-dd {
    margin: 0;
    font-size: 11px;
    color: #374151;
    line-height: 1.55;
  }
  .pm-term-dd em {
    font-style: italic;
    color: #1a1a2e;
  }
  .pm-term-dd strong {
    font-weight: 700;
    color: #1a1a2e;
  }
  .pm-term-example {
    margin-top: 6px;
    padding: 6px 8px 6px 26px;
    background: #f5f7fb;
    border-left: 2px solid #94a3b8;
    border-radius: 3px;
    font-size: 10.5px;
    color: #374151;
    line-height: 1.55;
    position: relative;
  }
  .pm-term-example-label {
    position: absolute;
    left: 6px;
    top: 6px;
    font-size: 9px;
    font-weight: 700;
    color: #64748b;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .pm-term-example code {
    background: #e5e7eb;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .pm-term-subheading {
    margin-top: 10px;
    margin-bottom: 4px;
    font-size: 10.5px;
    font-weight: 700;
    color: #1a1a2e;
    letter-spacing: 0.02em;
  }
  .pm-term-para {
    margin: 0 0 4px;
    font-size: 11px;
    color: #374151;
    line-height: 1.55;
  }
  .pm-term-list-inline {
    margin: 2px 0 6px;
    padding-left: 18px;
    font-size: 11px;
    color: #374151;
    line-height: 1.55;
  }
  .pm-term-list-inline li {
    margin-bottom: 3px;
  }
  .pm-term-list-inline code,
  .pm-term-para code {
    background: #e5e7eb;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .pm-term-table-wrap {
    margin-top: 8px;
    overflow-x: auto;
    border: 1px solid #d4d8e8;
    border-radius: 4px;
  }
  .pm-term-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10.5px;
    color: #1f2937;
  }
  .pm-term-table thead th {
    background: #eef1f6;
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid #d4d8e8;
    font-weight: 700;
    color: #1a1a2e;
    white-space: nowrap;
  }
  .pm-term-table tbody td {
    padding: 5px 8px;
    border-bottom: 1px solid #eef0f4;
    vertical-align: top;
    line-height: 1.45;
  }
  .pm-term-table tbody tr:last-child td {
    border-bottom: none;
  }
  .pm-term-table tr.pm-term-table-section td {
    background: #f5f7fb;
    font-weight: 700;
    color: #1a1a2e;
    padding: 6px 8px;
    border-top: 1px solid #d4d8e8;
  }
  .pm-term-table code {
    background: #e5e7eb;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .pm-term-tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .pm-term-tag--stop {
    background: #fef2ed;
    color: #c2410c;
    border: 1px solid #fbbf99;
  }
  .pm-term-tag--tool {
    background: #ecfdf5;
    color: #047857;
    border: 1px solid #a7f3d0;
  }
  .pm-protocol-layout {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 1fr;
    overflow: hidden;
    gap: 0;
  }
  .pm-left-half {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid #d4d8e8;
  }
  .pm-left-top {
    display: grid;
    grid-template-columns: 1fr 1fr;
    flex-shrink: 0;
  }
  .pm-live-card-col {
    display: flex;
    flex-direction: column;
    padding: 8px;
    max-height: 300px;
    overflow-y: auto;
  }
  .pm-live-cards-details {
    flex-shrink: 0;
    border-bottom: 1px solid #d4d8e8;
  }
  .pm-live-cards-summary {
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    color: #1a1a2e;
    padding: 6px 10px;
    background: #f8fafc;
    user-select: none;
    list-style: revert;
  }
  .pm-live-cards-summary:hover {
    background: #f1f3f9;
  }
  .pm-live-cards-details[open] .pm-live-cards-summary {
    border-bottom: 1px solid #e5e7eb;
  }
  .pm-live-card-col:first-child {
    border-right: 1px solid #d4d8e8;
  }
  .pm-right-half {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .pm-model-filter {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid #d4d8e8;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .pm-model-filter-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    margin-right: 4px;
  }
  .pm-model-btn {
    background: #ffffff;
    color: #374151;
    border: 1px solid #d4d8e8;
    border-radius: 12px;
    padding: 2px 10px;
    cursor: pointer;
    font-size: 10px;
    font-family: inherit;
    font-weight: 500;
    transition: all 0.1s;
  }
  .pm-model-btn:hover {
    background: #eef0f6;
    border-color: #93a3c0;
  }
  .pm-model-btn.active {
    background: #2563eb;
    color: #ffffff;
    border-color: #2563eb;
    font-weight: 600;
  }
  .pm-model-filter-active {
    font-size: 9px;
    font-weight: 600;
    background: #2563eb;
    color: #ffffff;
    padding: 1px 8px;
    border-radius: 8px;
    margin-left: 6px;
  }
  .pm-usage-banner {
    padding: 8px;
    flex-shrink: 0;
  }
  .pm-right-cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    flex: 1;
    min-height: 0;
  }
  .pm-stats-col {
    display: flex;
    flex-direction: column;
    padding: 8px;
    overflow-y: auto;
  }
  .pm-stats-col:first-child {
    border-right: 1px solid #d4d8e8;
  }

  /* Directional network/latency tabs */
  .pm-net-pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .pm-net-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid #d4d8e8;
    flex-shrink: 0;
    background: #f8fafc;
  }
  .pm-net-tab {
    --pm-net-tab-color: #6b7280;
    background: #ffffff;
    border: 1px solid #d4d8e8;
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 10.5px;
    font-weight: 600;
    color: #374151;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .pm-net-tab:hover {
    border-color: var(--pm-net-tab-color);
    color: var(--pm-net-tab-color);
  }
  .pm-net-tab.active {
    background: var(--pm-net-tab-color);
    border-color: var(--pm-net-tab-color);
    color: #ffffff;
  }
  .pm-net-direction-content {
    flex: 1;
    overflow-y: auto;
    /* Tight top padding — the directional tabs above are already a clear
       boundary, no need for an extra 10px breathing band before the first
       section title. */
    padding: 4px 12px 14px;
  }
  .pm-net-direction-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #1a1a2e;
    margin-bottom: 8px;
  }
  .pm-net-section-title {
    font-size: 10.5px;
    font-weight: 700;
    color: #1a1a2e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .pm-net-subsection-title {
    font-size: 10px;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 4px 0 4px;
  }
  .pm-message-types-details {
    margin: 6px 0 8px;
  }
  .pm-message-types-summary {
    cursor: pointer;
    font-size: 11px;
    color: #4b5563;
    padding: 4px 8px;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    user-select: none;
  }
  .pm-message-types-summary:hover {
    background: #e5e7eb;
  }
  .pm-message-types-details[open] .pm-message-types-summary {
    margin-bottom: 4px;
  }
  .pm-net-stat-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    margin-bottom: 10px;
  }
  /* Single full-width "merged" card with vertical separators between cells.
     Used wherever a section reports several variants of the same metric
     (Latency: min | avg | p50 | p95 | peak; Throughput: min | peak | avg |
     median; etc.) so the user reads a single visual unit instead of a
     fragmented grid of tiny cards. */
  .pm-net-stat-row {
    display: flex;
    width: 100%;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #ffffff;
    margin-bottom: 10px;
    overflow: hidden;
  }
  .pm-net-stat-row-cell {
    flex: 1;
    text-align: left;
    background: transparent;
    border: none;
    border-right: 1px solid #e5e7eb;
    padding: 6px 10px;
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition: background-color 0.08s;
    min-width: 0;
  }
  .pm-net-stat-row-cell:last-child {
    border-right: none;
  }
  .pm-net-stat-row-cell:hover {
    background: #f3f4f6;
  }
  .pm-net-stat-row-cell-title {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .pm-net-stat-row-cell-value {
    font-size: 14px;
    font-weight: 700;
    color: #1a1a2e;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pm-net-stat-row-cell-sub {
    font-size: 10px;
    color: #6b7280;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pm-usage-details {
    flex-shrink: 0;
    border-bottom: 1px solid #d4d8e8;
  }
  .pm-usage-summary {
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    color: #1a1a2e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 6px 10px;
    background: #f8fafc;
    user-select: none;
    list-style: revert;
  }
  .pm-usage-summary:hover {
    background: #f1f3f9;
  }
  .pm-net-stat-card {
    text-align: left;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 8px 10px;
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition: transform 0.08s, border-color 0.08s, box-shadow 0.08s;
  }
  .pm-net-stat-card:hover {
    transform: translateY(-1px);
    border-color: #9aa3b8;
    box-shadow: 0 3px 8px rgba(0,0,0,0.05);
  }
  .pm-net-stat-card:focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: 2px;
  }
  .pm-net-stat-card-title {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .pm-net-stat-card-value {
    font-size: 16px;
    font-weight: 700;
    color: #111827;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }
  .pm-net-stat-card-sub {
    font-size: 10px;
    color: #6b7280;
    margin-top: 2px;
  }
  .pm-message-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 8px;
    margin-top: 6px;
  }
  .pm-message-card {
    background: #fff;
    border: 1px solid #e0e4ee;
    border-left: 3px solid currentColor;
    border-radius: 6px;
    padding: 8px 10px;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  }
  .pm-message-card:hover {
    background: #f5f7fb;
  }
  .pm-message-card-type {
    font-size: 11px;
    color: #4b5563;
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pm-message-card-count {
    font-size: 18px;
    font-weight: 600;
    color: #0f172a;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    margin-top: 2px;
  }
  .pm-message-card-sub {
    font-size: 10px;
    color: #6b7280;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .pm-message-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin-top: 6px;
    font-size: 11px;
    color: #4b5563;
    font-family: monospace;
  }
  .pm-message-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .pm-message-legend-swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }
  .pm-message-legend-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
  }
  .pm-net-no-latency {
    margin-top: 14px;
    padding: 10px 12px;
    background: #f5f7fb;
    border: 1px dashed #cbd5e1;
    border-radius: 6px;
    color: #4b5563;
    font-size: 11px;
    line-height: 1.55;
  }
  .pm-diagram-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 300px;
    overflow: hidden;
  }
  /* Live cards */
  .pm-live-cards {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 280px;
    overflow-y: auto;
    padding: 4px;
  }
  .pm-live-cards-empty {
    padding: 20px;
    text-align: center;
    color: #9ca3af;
    font-size: 11px;
  }
  .pm-live-card {
    border: 1px solid #d4d8e8;
    border-radius: 6px;
    padding: 6px 8px;
    background: #ffffff;
    font-size: 11px;
  }
  .pm-card-user { border-left: 3px solid #3b82f6; }
  .pm-card-assistant { border-left: 3px solid #8b5cf6; }
  .pm-card-tool { border-left: 3px solid #f59e0b; }
  .pm-card-tool-start { border-left-color: #3b82f6; }
  .pm-card-tool-end { border-left-color: #22c55e; }
  .pm-card-role {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    color: #6b7280;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pm-card-phase {
    font-size: 8px;
    font-weight: 600;
    padding: 1px 4px;
    border-radius: 3px;
    background: #eef0f6;
    color: #374151;
  }
  .pm-card-agent {
    font-size: 8px;
    color: #9ca3af;
    font-weight: 400;
  }
  .pm-card-text {
    color: #1a1a2e;
    line-height: 1.4;
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .pm-card-time {
    font-size: 8px;
    color: #9ca3af;
    margin-top: 2px;
    text-align: right;
  }
  .pm-section-title {
    padding: 8px 10px 4px;
    font-size: 11px;
    font-weight: 700;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  /* Filters */
  .pm-filters {
    flex: 1;
    overflow-y: auto;
  }
  .pm-filters-title {
    padding: 6px 10px 4px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    position: sticky;
    top: 0;
    background: #f8f9fc;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .pm-type-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding: 4px 10px 8px;
  }
  .pm-type-card {
    border: 1px solid #d4d8e8;
    border-radius: 6px;
    padding: 6px 8px;
    cursor: pointer;
    transition: opacity 0.15s, border-color 0.15s;
    background: #ffffff;
  }
  .pm-type-card:hover { border-color: #93a3c0; }
  .pm-type-card.disabled {
    opacity: 0.35;
    border-color: #d4d8e8;
  }
  .pm-type-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 5px;
  }
  .pm-type-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .pm-type-card-key {
    flex: 1;
    font-size: 10px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #1a1a2e;
  }
  /* Toggle switch */
  .pm-type-switch {
    position: relative;
    display: inline-block;
    width: 28px;
    height: 14px;
    flex-shrink: 0;
  }
  .pm-type-switch input { opacity: 0; width: 0; height: 0; }
  .pm-type-slider {
    position: absolute;
    inset: 0;
    background: #c4c9d6;
    border-radius: 7px;
    transition: background 0.15s;
    cursor: pointer;
  }
  .pm-type-slider::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 10px;
    height: 10px;
    background: #ffffff;
    border-radius: 50%;
    transition: transform 0.15s, background 0.15s;
  }
  .pm-type-switch input:checked + .pm-type-slider {
    background: #2563eb;
  }
  .pm-type-switch input:checked + .pm-type-slider::after {
    transform: translateX(14px);
    background: #fff;
  }
  /* Card metric row */
  .pm-type-card-stats {
    display: flex;
    gap: 8px;
  }
  .pm-type-metric {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
  }
  .pm-type-metric-val {
    font-size: 11px;
    font-weight: 700;
    color: #1a1a2e;
    white-space: nowrap;
  }
  .pm-type-metric-label {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7280;
  }
  .pm-muted { color: #6b7280; font-size: 11px; padding: 4px 0; }

  /* Sequence diagram */
  .pm-diagram {
    flex: 1;
    overflow-y: auto;
    position: relative;
  }
  .pm-columns-header {
    display: grid;
    grid-template-columns: 68px repeat(5, 1fr);
    position: sticky;
    top: 0;
    background: #f8f9fc;
    z-index: 10;
    border-bottom: 1px solid #d4d8e8;
  }
  .pm-col-header {
    text-align: center;
    padding: 8px 0 6px;
    color: #374151;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
  }
  .pm-col-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #4b5563;
  }
  .pm-col-label-text {
    font-weight: 800;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #374151;
  }
  .pm-rows-wrap {
    position: relative;
  }
  .pm-vlines {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 68px;
    right: 0;
    pointer-events: none;
    z-index: 0;
  }
  .pm-vline {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    margin-left: -0.5px;
    background: #9ca3af;
  }
  .pm-ts-header {
    padding: 5px 6px;
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
  }
  .pm-row {
    display: grid;
    grid-template-columns: 68px 1fr;
    height: ${ROW_HEIGHT}px;
    align-items: center;
    cursor: pointer;
    border-bottom: 1px solid #eef0f6;
  }
  .pm-row:hover { background: #eef0f6; }
  .pm-row.selected { background: #dde3f0; }
  .pm-ts {
    padding: 0 6px;
    font-size: 9px;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pm-msg-box {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    background: #ffffff;
    background-color: #ffffff;
    border: 1.5px solid;
    border-radius: 5px;
    padding: 3px 8px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    z-index: 5;
    max-width: 320px;
    pointer-events: none;
  }
  .pm-msg-method {
    font-size: 9px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 310px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .pm-msg-detail {
    font-size: 8px;
    color: #6b7280;
    white-space: normal;
    word-break: break-word;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
    max-width: 310px;
    line-height: 1.3;
  }
  .pm-proto-badge {
    display: inline-block;
    font-size: 7px;
    font-weight: 700;
    letter-spacing: 0.03em;
    padding: 1px 4px;
    border-radius: 3px;
    vertical-align: middle;
    margin-left: 2px;
    white-space: nowrap;
  }
  .pm-arrow-container {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    height: 2px;
    display: flex;
    align-items: center;
    pointer-events: none;
    z-index: 2;
  }
  .pm-arrow-container.group-arrow { height: 4px; }
  .pm-arrow-line { flex: 1; height: 100%; position: relative; }
  .pm-arrow-head {
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    flex-shrink: 0;
  }
  .pm-arrow-head.right { border-left-width: 8px; border-left-style: solid; }
  .pm-arrow-head.left { border-right-width: 8px; border-right-style: solid; }
  .pm-arrow-label {
    position: absolute;
    top: -13px;
    white-space: nowrap;
    font-size: 9px;
    font-weight: 500;
    pointer-events: none;
    padding: 0 3px;
    background: #f8f9fc;
  }
  .pm-arrow-badge {
    display: inline-block;
    background: #fef3c7;
    color: #92400e;
    border-radius: 8px;
    padding: 0 5px;
    font-size: 8px;
    margin-left: 3px;
    font-weight: 700;
  }
  .pm-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 120px;
    color: #6b7280;
  }

  /* Network stats */
  .pm-net-stats {
    padding-bottom: 0;
  }
  .pm-net-cards {
    padding: 4px 10px;
  }
  .pm-net-card {
    border: 1px solid #d4d8e8;
    border-radius: 6px;
    padding: 8px 10px;
    background: #ffffff;
  }
  .pm-net-card-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    font-weight: 600;
    margin-bottom: 2px;
  }
  .pm-net-card-value {
    font-size: 18px;
    font-weight: 700;
    color: #1a1a2e;
    line-height: 1.2;
    margin-bottom: 6px;
  }
  .pm-net-bar {
    display: flex;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    background: #e5e7eb;
  }
  .pm-net-bar-in {
    background: #2563eb;
    transition: width 0.3s;
  }
  .pm-net-bar-out {
    background: #d97706;
    transition: width 0.3s;
  }
  .pm-net-bar-legend {
    display: flex;
    gap: 12px;
    margin-top: 4px;
    font-size: 9px;
    color: #6b7280;
  }
  .pm-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 3px;
    vertical-align: middle;
  }
  .pm-net-channels {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 10px 0;
  }
  .pm-net-channel {
    border: 1px solid #d4d8e8;
    border-radius: 6px;
    padding: 6px 8px;
    background: #ffffff;
  }
  .pm-net-channel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .pm-net-channel-label {
    font-size: 10px;
    font-weight: 600;
    color: #1a1a2e;
    flex: 1;
  }
  .pm-net-channel-badge {
    font-size: 9px;
    color: #6b7280;
    background: #eef0f6;
    padding: 1px 6px;
    border-radius: 8px;
  }
  .pm-net-channel-metrics {
    display: flex;
    gap: 8px;
  }
  .pm-net-metric {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
  }
  .pm-net-metric-val {
    font-size: 13px;
    font-weight: 700;
    color: #1a1a2e;
    white-space: nowrap;
  }
  .pm-net-metric-label {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7280;
  }

  /* Charts */
  .pm-charts {
    flex: 1;
    padding: 0;
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .pm-chart-block {
    border: 1px solid #d4d8e8;
    border-radius: 6px;
    padding: 8px 10px;
    background: #ffffff;
    /* All charts span the full width of the parent direction-content panel
       — the user found the previous 75% cap was wasting horizontal real
       estate next to the cards (which are now collapsed by default anyway). */
    max-width: 100%;
  }
  .pm-chart-block--full {
    /* Backwards-compat alias, no longer needed since pm-chart-block is now
       full-width by default. Kept so old call sites keep working. */
    max-width: 100%;
  }
  .pm-chart-block--short {
    /* Backwards-compat: the global pm-chart-svg--tall aspect ratio is now
       460/195, so this modifier is a no-op. Kept to avoid breaking any
       external HTML exports that reference the class name. */
  }
  .pm-chart-zoom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    margin-bottom: 2px;
    min-height: 18px;
  }
  .pm-chart-zoom-hint {
    color: #4b5563;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pm-chart-zoom-hint strong {
    color: #1a1a2e;
  }
  .pm-chart-zoom-reset {
    background: #ffffff;
    color: #1a1a2e;
    border: 1px solid #d4d8e8;
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 10px;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
    flex-shrink: 0;
  }
  .pm-chart-zoom-reset:hover {
    background: #eef0f6;
    border-color: #93a3c0;
  }
  .pm-chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .pm-chart-title {
    font-size: 11px;
    font-weight: 600;
    color: #1a1a2e;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pm-chart-wrap {
    position: relative;
    width: 100%;
    cursor: crosshair;
  }
  .pm-chart-svg {
    background: #f1f3f9;
    border-radius: 4px;
    display: block;
    width: 100%;
    height: 120px;
  }
  .pm-chart-svg--tall {
    /* All "tall" charts (messages bar / latency line / agent|model events)
       render at the same shorter aspect ratio. The viewBox in the SVGs is
       set to 0 0 460 195 to match — keeping the two in sync prevents the
       default xMidYMid-meet preserveAspectRatio from leaving empty bands on
       the sides, which would offset mouse-hover coordinates from the
       rendered bars. */
    height: auto;
    aspect-ratio: 460 / 195;
  }
  .pm-chart-subtitle {
    font-size: 10px;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 4px 0 4px;
  }
  .pm-chart-empty {
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f1f3f9;
    border-radius: 4px;
    color: #9ca3af;
    font-size: 11px;
  }
  .pm-chart-tooltip {
    display: none;
    position: absolute;
    background: #ffffff;
    border: 1px solid #d4d8e8;
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 11px;
    color: #1a1a2e;
    pointer-events: none;
    z-index: 5;
    white-space: nowrap;
    box-shadow: 0 4px 14px rgba(0,0,0,0.12);
    line-height: 1.45;
  }
  .pm-chart-crosshair {
    display: none;
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #6b7280;
    opacity: 0.5;
    pointer-events: none;
    z-index: 4;
  }
  .pm-chart-summary {
    display: flex;
    gap: 16px;
    margin-top: 6px;
    font-size: 10px;
    color: #6b7280;
  }
  .pm-chart-summary b {
    color: #1a1a2e;
    font-weight: 600;
  }
  .pm-chart-legend {
    display: flex;
    gap: 12px;
    margin-top: 4px;
    font-size: 9px;
    color: #6b7280;
  }
  .pm-chart-legend span {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .pm-legend-line {
    display: inline-block;
    width: 16px;
    height: 2px;
    border-radius: 1px;
  }
  .pm-legend-dash {
    background: repeating-linear-gradient(
      90deg,
      currentColor 0px,
      currentColor 4px,
      transparent 4px,
      transparent 7px
    ) !important;
  }
  .pm-legend-dot {
    background: repeating-linear-gradient(
      90deg,
      currentColor 0px,
      currentColor 2px,
      transparent 2px,
      transparent 5px
    ) !important;
  }

  /* Detail overlay */
  .pm-detail-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.2);
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .pm-detail-modal {
    width: 560px;
    max-width: 90vw;
    max-height: 80vh;
    background: #ffffff;
    border: 1px solid #d4d8e8;
    border-radius: 8px;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.12);
  }

  /* Clickable usage card affordance */
  .pm-ucard--clickable {
    cursor: pointer;
    transition: transform 0.08s ease, box-shadow 0.08s ease, border-color 0.08s ease;
  }
  .pm-ucard--clickable:hover {
    transform: translateY(-1px);
    border-color: #9aa3b8;
    box-shadow: 0 4px 10px rgba(0,0,0,0.06);
  }
  .pm-ucard--clickable:focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: 2px;
  }
  .pm-ucard-info {
    margin-left: 6px;
    font-size: 10px;
    color: #6b7280;
    font-weight: 400;
  }

  /* Explainer modal */
  .pm-explainer-modal {
    width: 640px;
    max-width: 92vw;
    max-height: 85vh;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .pm-explainer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid #e5e7eb;
    position: sticky;
    top: 0;
    background: #ffffff;
    z-index: 1;
  }
  .pm-explainer-header h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: #111827;
  }
  .pm-explainer-close {
    background: transparent;
    border: none;
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    color: #6b7280;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .pm-explainer-close:hover {
    background: #f3f4f6;
    color: #111827;
  }
  .pm-explainer-body {
    padding: 16px 20px 20px;
    font-size: 12.5px;
    color: #1f2937;
    line-height: 1.55;
    overflow-y: auto;
  }
  .pm-explainer-values {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  .pm-explainer-stat {
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 10px 12px;
    background: #f9fafb;
    text-align: center;
  }
  .pm-explainer-stat-value {
    font-size: 20px;
    font-weight: 600;
    color: #111827;
    line-height: 1.2;
  }
  .pm-explainer-stat-label {
    font-size: 10.5px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-top: 2px;
  }
  .pm-explainer-intro {
    margin: 0 0 14px;
    color: #374151;
  }
  .pm-explainer-section {
    margin-bottom: 14px;
    padding: 10px 12px;
    background: #f9fafb;
    border: 1px solid #eef0f4;
    border-radius: 6px;
  }
  .pm-explainer-section p {
    margin: 0;
  }
  .pm-explainer-section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: #111827;
    margin-bottom: 6px;
    font-size: 12.5px;
  }
  .pm-explainer-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .pm-badge-user {
    background: #dbeafe;
    color: #1d4ed8;
  }
  .pm-badge-assistant {
    background: #dcfce7;
    color: #166534;
  }
  .pm-badge-total {
    background: #ede9fe;
    color: #5b21b6;
  }
  .pm-explainer-body code {
    background: #eef2f7;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .pm-explainer-note ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
  .pm-explainer-note li {
    margin-bottom: 4px;
  }
  .pm-explainer-section ul {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  .pm-explainer-section li {
    margin-bottom: 4px;
  }
  .pm-explainer-section p + p {
    margin-top: 6px;
  }
  .pm-explainer-mini {
    margin: 6px 0 0 !important;
    padding: 6px 8px;
    background: #eef2f7;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
    color: #1f2937;
  }
`;
