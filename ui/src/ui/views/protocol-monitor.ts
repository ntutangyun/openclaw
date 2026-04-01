import { html, nothing, type TemplateResult } from "lit";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import type {
  ProtocolTraceRecord,
  CoalescedGroup,
  CoalescedEntry,
  MessageTypeStats,
  NetworkStats,
  ThroughputSample,
  LatencyStats,
  LatencySample,
} from "../controllers/protocol-monitor.ts";
import {
  coalesceTraces,
  filterTraces,
  computeMessageTypes,
  computeNetworkStats,
} from "../controllers/protocol-monitor.ts";
import { renderProtocolMonitorDetail } from "./protocol-monitor-detail.ts";
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

export type ProtocolMonitorSubTab = "usage" | "protocol";

export type ProtocolMonitorProps = {
  traces: ProtocolTraceRecord[];
  loading: boolean;
  selectedTrace: ProtocolTraceRecord | CoalescedGroup | null;
  autoScroll: boolean;
  disabledTypes: Set<string>;
  subTab: ProtocolMonitorSubTab;
  usageTotals: UsageTotals | null;
  usageAggregates: UsageAggregates | null;
  usageSessions: unknown[];
  usageLoading: boolean;
  onSubTabChange: (tab: ProtocolMonitorSubTab) => void;
  onToggleAutoScroll: (v: boolean) => void;
  onSelectTrace: (t: ProtocolTraceRecord | CoalescedGroup) => void;
  onClearSelection: () => void;
  onRefresh: () => void;
  onExport: () => void;
  onReset: () => void;
  onToggleType: (key: string) => void;
};

// ---------------------------------------------------------------------------
// Column layout (5 columns now including LLM)
// ---------------------------------------------------------------------------

type Column = "operator" | "gateway" | "node" | "agent" | "llm";
const COLUMNS: Column[] = ["operator", "gateway", "node", "agent", "llm"];
const COL_INDEX: Record<Column, number> = { operator: 0, gateway: 1, node: 2, agent: 3, llm: 4 };
const COL_LABELS: Record<Column, string> = {
  operator: "Operator",
  gateway: "Gateway",
  node: "Node",
  agent: "Agent",
  llm: "LLM",
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
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const ROW_HEIGHT = 80;

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

const SUB_TABS: { id: ProtocolMonitorSubTab; label: string }[] = [
  { id: "usage", label: "Usage Overview" },
  { id: "protocol", label: "Protocol & Network" },
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
        ${props.subTab === "usage" ? renderUsagePane(props) : nothing}
        ${props.subTab === "protocol" ? renderProtocolAndNetworkPane(props) : nothing}
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
              })}
            </div>
          </div>`
        : nothing}
    </div>
  `;
}

function renderUsagePane(props: ProtocolMonitorProps): TemplateResult {
  return html`<div class="pm-pane">${renderUsageOverview(props)}</div>`;
}

function renderProtocolAndNetworkPane(props: ProtocolMonitorProps): TemplateResult {
  const filtered = filterTraces(props.traces, props.disabledTypes);
  const coalesced = coalesceTraces(filtered);
  const msgTypes = computeMessageTypes(props.traces, props.disabledTypes);
  const netStats = computeNetworkStats(props.traces);
  return html`
    <div class="pm-split-pane">
      <div class="pm-split-left">
        <div class="pm-section-title">Message Filters</div>
        ${renderMessageTypeFilters(msgTypes, props)}
        <div
          class="pm-section-title"
          style="display:flex;justify-content:space-between;align-items:center;"
        >
          Sequence Diagram
          <label class="pm-check" style="font-weight:400;text-transform:none;letter-spacing:0;">
            <input
              type="checkbox"
              .checked=${props.autoScroll}
              @change=${(e: Event) =>
                props.onToggleAutoScroll((e.target as HTMLInputElement).checked)}
            />
            Auto-scroll
          </label>
        </div>
        ${renderSequenceDiagram(coalesced, props)}
      </div>
      <div class="pm-split-mid">
        ${renderNetworkStats(netStats)} ${renderThroughputCharts(netStats)}
      </div>
      <div class="pm-split-right">${renderLatencySection(netStats)}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Section 1: Usage overview (top)
// ---------------------------------------------------------------------------

function renderUsageOverview(props: ProtocolMonitorProps): TemplateResult {
  const totals = props.usageTotals;
  const agg = props.usageAggregates;

  if (props.usageLoading && !totals) {
    return html`<div class="pm-stats-bar">
      <span class="pm-muted">Loading usage data...</span>
    </div>`;
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

  return html`
    <div class="pm-overview">
      <div class="pm-overview-grid">
        ${usageCard(
          "Messages",
          String(msgTotal),
          `${userMsgs} user · ${assistantMsgs} assistant`,
          "hero",
        )}
        ${usageCard(
          "Throughput",
          throughput !== undefined ? `${formatTokens(Math.round(throughput))} tok/min` : "—",
          `${avgDuration} avg session`,
          "hero",
        )}
        ${usageCard("Tool Calls", String(toolCalls), `${uniqueTools} unique tools`, "half")}
        ${usageCard("Avg Tokens", formatTokens(avgTokens), `across ${msgTotal} messages`, "half")}
        ${usageCard(
          "Cache Hit",
          `${cacheHitRate.toFixed(1)}%`,
          `${formatTokens(totals?.cacheRead ?? 0)} cached · ${formatTokens(cacheBase)} prompt`,
          cacheTone,
        )}
        ${usageCard("Error Rate", `${errorRate.toFixed(2)}%`, `${errors} errors`, errorTone)}
        ${usageCard(
          "Total Cost",
          formatCost(totalCost),
          `${formatCost(msgTotal > 0 ? totalCost / msgTotal : 0, 4)}/msg`,
          "compact",
        )}
        ${usageCard(
          "Total Tokens",
          formatTokens(totalTokens),
          `in ${formatTokens(totals?.input ?? 0)} · out ${formatTokens(totals?.output ?? 0)}`,
          "compact",
        )}
      </div>
    </div>
  `;
}

function renderControlButtons(props: ProtocolMonitorProps): TemplateResult {
  return html`
    <div class="pm-controls-inline">
      <button class="pm-btn" @click=${props.onRefresh}>Refresh</button>
      <button class="pm-btn" @click=${props.onExport}>Export</button>
      <button
        class="pm-btn danger"
        @click=${() => {
          if (confirm("Clear all protocol trace history?")) {
            props.onReset();
          }
        }}
      >
        Reset
      </button>
    </div>
  `;
}

function usageCard(title: string, value: string, sub: string, tone?: string): TemplateResult {
  const toneClass = tone === "good" || tone === "warn" || tone === "bad" ? `pm-ucard--${tone}` : "";
  const sizeClass =
    tone === "hero"
      ? "pm-ucard--hero"
      : tone === "half"
        ? "pm-ucard--half"
        : tone === "compact"
          ? "pm-ucard--compact"
          : "";
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
        ${COLUMNS.map((col) => html`<div class="pm-col-header">${COL_LABELS[col]}</div>`)}
      </div>
      ${coalesced.length === 0
        ? html`<div class="pm-empty">
            ${props.loading ? "Loading..." : "No messages match filters."}
          </div>`
        : html`
            <div style="position:relative;height:${totalHeight}px;">
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
// Section 4: Network statistics (right-top)
// ---------------------------------------------------------------------------

function peakBps(samples: ThroughputSample[]): number {
  if (samples.length === 0) {
    return 0;
  }
  return Math.max(...samples.map((s) => s.bytesPerSec));
}

function avgBps(samples: ThroughputSample[]): number {
  if (samples.length === 0) {
    return 0;
  }
  return samples.reduce((a, s) => a + s.bytesPerSec, 0) / samples.length;
}

function renderNetworkStats(net: NetworkStats): TemplateResult {
  const total = net.totalBytesIn + net.totalBytesOut;
  const inPct = total > 0 ? Math.round((net.totalBytesIn / total) * 100) : 0;
  const outPct = 100 - inPct;

  return html`
    <div class="pm-net-stats">
      <div class="pm-filters-title">Network Statistics</div>

      <div class="pm-net-cards">
        <div class="pm-net-card">
          <div class="pm-net-card-label">Total Transfer</div>
          <div class="pm-net-card-value">${formatBytes(total)}</div>
          <div class="pm-net-bar">
            <div
              class="pm-net-bar-in"
              style="width:${inPct}%;"
              title="In: ${formatBytes(net.totalBytesIn)}"
            ></div>
            <div
              class="pm-net-bar-out"
              style="width:${outPct}%;"
              title="Out: ${formatBytes(net.totalBytesOut)}"
            ></div>
          </div>
          <div class="pm-net-bar-legend">
            <span
              ><span class="pm-dot" style="background:#3b82f6;"></span> In
              ${formatBytes(net.totalBytesIn)}</span
            >
            <span
              ><span class="pm-dot" style="background:#f59e0b;"></span> Out
              ${formatBytes(net.totalBytesOut)}</span
            >
          </div>
        </div>
      </div>

      <div class="pm-net-channels">
        ${renderChannelRow("Operator ↔ Gateway", net.operatorGateway, "#3b82f6")}
        ${renderChannelRow("Agent ↔ LLM", net.agentLlm, "#f59e0b")}
        ${renderChannelRow("Gateway ↔ Node", net.gatewayNode, "#22c55e")}
      </div>
    </div>
  `;
}

function renderChannelRow(
  label: string,
  samples: ThroughputSample[],
  color: string,
): TemplateResult {
  const peak = peakBps(samples);
  const avg = avgBps(samples);
  const totalBytes = samples.reduce((a, s) => a + s.rawBytes, 0);

  return html`
    <div class="pm-net-channel">
      <div class="pm-net-channel-header">
        <span class="pm-dot" style="background:${color};"></span>
        <span class="pm-net-channel-label">${label}</span>
        <span class="pm-net-channel-badge">${samples.length} samples</span>
      </div>
      <div class="pm-net-channel-metrics">
        <div class="pm-net-metric">
          <span class="pm-net-metric-val">${formatBytes(peak)}/s</span>
          <span class="pm-net-metric-label">peak</span>
        </div>
        <div class="pm-net-metric">
          <span class="pm-net-metric-val">${formatBytes(avg)}/s</span>
          <span class="pm-net-metric-label">avg</span>
        </div>
        <div class="pm-net-metric">
          <span class="pm-net-metric-val">${formatBytes(totalBytes)}</span>
          <span class="pm-net-metric-label">total</span>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Section 5: Throughput charts (right-bottom)
// ---------------------------------------------------------------------------

function renderThroughputCharts(net: NetworkStats): TemplateResult {
  return html`
    <div class="pm-charts">
      ${renderChart("Operator ↔ Gateway", net.operatorGateway, "#3b82f6")}
      ${renderChart("Agent ↔ LLM", net.agentLlm, "#f59e0b")}
      ${renderChart("Gateway ↔ Node", net.gatewayNode, "#22c55e")}
    </div>
  `;
}

function chartTimeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}

function renderChart(title: string, samples: ThroughputSample[], color: string): TemplateResult {
  const PAD_L = 48;
  const PAD_R = 8;
  const PAD_T = 6;
  const PAD_B = 18;
  const W = 460;
  const H = 120;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const peak = samples.length > 0 ? Math.max(...samples.map((s) => s.bytesPerSec)) : 0;
  const avg =
    samples.length > 0 ? samples.reduce((a, s) => a + s.bytesPerSec, 0) / samples.length : 0;
  const totalBytes = samples.reduce((a, s) => a + s.rawBytes, 0);

  if (samples.length < 2) {
    return html`
      <div class="pm-chart-block">
        <div class="pm-chart-header">
          <span class="pm-chart-title"
            ><span class="pm-dot" style="background:${color};"></span> ${title}</span
          >
        </div>
        <div class="pm-chart-empty">Waiting for data...</div>
        <div class="pm-chart-summary">
          <span>Peak: —</span><span>Avg: —</span><span>Total: —</span>
        </div>
      </div>
    `;
  }

  const maxVal = Math.max(peak, 1);
  const minTs = samples[0].ts;
  const maxTs = samples[samples.length - 1].ts;
  const tsRange = maxTs - minTs || 1;

  const toX = (ts: number) => PAD_L + ((ts - minTs) / tsRange) * plotW;
  const toY = (v: number) => PAD_T + plotH - (v / maxVal) * plotH;

  // Line + area fill points
  const linePoints = samples.map((s) => `${toX(s.ts)},${toY(s.bytesPerSec)}`).join(" ");
  const areaPoints =
    `${toX(minTs)},${toY(0)} ` +
    samples.map((s) => `${toX(s.ts)},${toY(s.bytesPerSec)}`).join(" ") +
    ` ${toX(maxTs)},${toY(0)}`;

  // Y-axis grid (4 lines)
  const yGridCount = 4;
  const yGridLines = Array.from({ length: yGridCount }, (_, i) => {
    const val = (maxVal / yGridCount) * (i + 1);
    return { y: toY(val), label: formatBytes(val) + "/s" };
  });

  // X-axis labels (5 ticks)
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const ts = minTs + (tsRange / (xTickCount - 1)) * i;
    return { x: toX(ts), label: chartTimeLabel(ts) };
  });

  // Average line
  const avgY = toY(avg);

  // Unique chart id for gradient
  const chartId = `chart-${title.replace(/\W/g, "")}`;

  return html`
    <div class="pm-chart-block">
      <div class="pm-chart-header">
        <span class="pm-chart-title"
          ><span class="pm-dot" style="background:${color};"></span> ${title}</span
        >
      </div>
      <div
        class="pm-chart-wrap"
        @mousemove=${(e: MouseEvent) =>
          handleChartHover(e, samples, minTs, tsRange, maxVal, PAD_L, plotW, plotH, PAD_T)}
        @mouseleave=${handleChartLeave}
      >
        <svg viewBox="0 0 ${W} ${H}" class="pm-chart-svg" preserveAspectRatio="none">
          <defs>
            <linearGradient id="${chartId}-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${color}" stop-opacity="0.25" />
              <stop offset="100%" stop-color="${color}" stop-opacity="0.02" />
            </linearGradient>
          </defs>
          <!-- Y grid -->
          ${yGridLines.map(
            (g) => html`
              <line
                x1="${PAD_L}"
                y1="${g.y}"
                x2="${W - PAD_R}"
                y2="${g.y}"
                stroke="#d4d8e8"
                stroke-width="0.5"
                stroke-dasharray="3,3"
              />
              <text
                x="${PAD_L - 4}"
                y="${g.y + 3}"
                text-anchor="end"
                fill="#6b7280"
                font-size="8"
                font-family="monospace"
                >${g.label}</text
              >
            `,
          )}
          <!-- X axis -->
          <line
            x1="${PAD_L}"
            y1="${PAD_T + plotH}"
            x2="${W - PAD_R}"
            y2="${PAD_T + plotH}"
            stroke="#c4c9d6"
            stroke-width="0.5"
          />
          ${xTicks.map(
            (t) => html`
              <text
                x="${t.x}"
                y="${H - 2}"
                text-anchor="middle"
                fill="#6b7280"
                font-size="8"
                font-family="monospace"
                >${t.label}</text
              >
            `,
          )}
          <!-- Avg line -->
          <line
            x1="${PAD_L}"
            y1="${avgY}"
            x2="${W - PAD_R}"
            y2="${avgY}"
            stroke="${color}"
            stroke-width="0.5"
            stroke-dasharray="5,4"
            opacity="0.5"
          />
          <text
            x="${W - PAD_R + 2}"
            y="${avgY + 3}"
            fill="${color}"
            font-size="7"
            font-family="monospace"
            opacity="0.7"
          >
            avg
          </text>
          <!-- Area fill -->
          <polygon points="${areaPoints}" fill="url(#${chartId}-fill)" />
          <!-- Line -->
          <polyline
            points="${linePoints}"
            fill="none"
            stroke="${color}"
            stroke-width="1.5"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <!-- Data point dots -->
          ${samples.map(
            (s) => html`
              <circle
                cx="${toX(s.ts)}"
                cy="${toY(s.bytesPerSec)}"
                r="2"
                fill="${color}"
                opacity="0.6"
              />
            `,
          )}
        </svg>
        <div class="pm-chart-tooltip" id="${chartId}-tip"></div>
        <div class="pm-chart-crosshair" id="${chartId}-cross"></div>
      </div>
      <div class="pm-chart-summary">
        <span>Peak: <b>${formatBytes(peak)}/s</b></span>
        <span>Avg: <b>${formatBytes(avg)}/s</b></span>
        <span>Total: <b>${formatBytes(totalBytes)}</b></span>
        <span>Samples: <b>${samples.length}</b></span>
      </div>
    </div>
  `;
}

function handleChartHover(
  e: MouseEvent,
  samples: ThroughputSample[],
  minTs: number,
  tsRange: number,
  maxVal: number,
  padL: number,
  plotW: number,
  plotH: number,
  padT: number,
) {
  const wrap = e.currentTarget as HTMLElement;
  const rect = wrap.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const svgW = rect.width;

  // Map mouse X to timestamp
  const xRatio = (mouseX - (padL / 460) * svgW) / ((plotW / 460) * svgW);
  if (xRatio < 0 || xRatio > 1) {
    handleChartLeave(e);
    return;
  }
  const hoverTs = minTs + xRatio * tsRange;

  // Find nearest sample
  let nearest = samples[0];
  let nearestDist = Infinity;
  for (const s of samples) {
    const d = Math.abs(s.ts - hoverTs);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = s;
    }
  }

  // Position tooltip & crosshair
  const tip = wrap.querySelector(".pm-chart-tooltip") as HTMLElement | null;
  const cross = wrap.querySelector(".pm-chart-crosshair") as HTMLElement | null;
  if (!tip || !cross || !nearest) {
    return;
  }

  const nearestXPct = ((nearest.ts - minTs) / tsRange) * 100;
  const padLPct = (padL / 460) * 100;
  const plotWPct = (plotW / 460) * 100;
  const crossLeftPct = padLPct + (nearestXPct / 100) * plotWPct;

  cross.style.display = "block";
  cross.style.left = `${crossLeftPct}%`;

  tip.style.display = "block";
  tip.innerHTML =
    `<b>${formatBytes(nearest.bytesPerSec)}/s</b><br/>` +
    new Date(nearest.ts).toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 1 });

  // Position tooltip to avoid overflow
  const tipLeft = crossLeftPct > 70 ? crossLeftPct - 20 : crossLeftPct + 3;
  tip.style.left = `${tipLeft}%`;
  const nearestYPct = padT + plotH - (nearest.bytesPerSec / maxVal) * plotH;
  tip.style.top = `${(nearestYPct / 120) * 100 - 10}%`;
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

function renderLatencySection(net: NetworkStats): TemplateResult {
  return html`
    <div class="pm-filters-title">Latency</div>
    <div class="pm-net-channels">
      ${renderLatencyCard("Agent ↔ LLM · TTFT", net.agentLlmTtft, "#7c3aed")}
      ${renderLatencyCard("Agent ↔ LLM · Generation", net.agentLlmGeneration, "#9333ea")}
      ${renderLatencyCard("Gateway ↔ Node", net.gatewayNodeLatency, "#059669")}
    </div>
    <div class="pm-charts">
      ${renderLatencyChart("Agent ↔ LLM · TTFT", net.agentLlmTtft, "#7c3aed")}
      ${renderLatencyChart("Agent ↔ LLM · Generation", net.agentLlmGeneration, "#9333ea")}
      ${renderLatencyChart("Gateway ↔ Node Latency", net.gatewayNodeLatency, "#059669")}
    </div>
  `;
}

function renderLatencyCard(label: string, stats: LatencyStats, color: string): TemplateResult {
  return html`
    <div class="pm-net-channel">
      <div class="pm-net-channel-header">
        <span class="pm-dot" style="background:${color};"></span>
        <span class="pm-net-channel-label">${label}</span>
        <span class="pm-net-channel-badge">${stats.count} samples</span>
      </div>
      <div class="pm-net-channel-metrics">
        <div class="pm-net-metric">
          <span class="pm-net-metric-val">${formatMs(stats.avgMs)}</span>
          <span class="pm-net-metric-label">avg</span>
        </div>
        <div class="pm-net-metric">
          <span class="pm-net-metric-val">${formatMs(stats.p50Ms)}</span>
          <span class="pm-net-metric-label">p50</span>
        </div>
        <div class="pm-net-metric">
          <span class="pm-net-metric-val">${formatMs(stats.p95Ms)}</span>
          <span class="pm-net-metric-label">p95</span>
        </div>
        <div class="pm-net-metric">
          <span class="pm-net-metric-val">${formatMs(stats.peakMs)}</span>
          <span class="pm-net-metric-label">peak</span>
        </div>
      </div>
    </div>
  `;
}

function renderLatencyChart(title: string, stats: LatencyStats, color: string): TemplateResult {
  const PAD_L = 48;
  const PAD_R = 8;
  const PAD_T = 6;
  const PAD_B = 18;
  const W = 460;
  const H = 120;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const { samples } = stats;

  if (samples.length === 0) {
    return html`
      <div class="pm-chart-block">
        <div class="pm-chart-header">
          <span class="pm-chart-title"
            ><span class="pm-dot" style="background:${color};"></span> ${title}</span
          >
        </div>
        <div class="pm-chart-empty">Waiting for data...</div>
        <div class="pm-chart-summary">
          <span>Avg: —</span><span>P50: —</span><span>P95: —</span><span>Peak: —</span>
        </div>
      </div>
    `;
  }

  const maxVal = Math.max(stats.peakMs ?? 1, 1);
  const minTs = samples[0].ts;
  const maxTs = samples.length > 1 ? samples[samples.length - 1].ts : minTs + 1000;
  const tsRange = maxTs - minTs || 1;
  const avgVal = stats.avgMs ?? 0;

  const toX = (ts: number) => PAD_L + ((ts - minTs) / tsRange) * plotW;
  const toY = (v: number) => PAD_T + plotH - (v / maxVal) * plotH;

  // Y-axis grid (4 lines)
  const yGridCount = 4;
  const yGridLines = Array.from({ length: yGridCount }, (_, i) => {
    const val = (maxVal / yGridCount) * (i + 1);
    return { y: toY(val), label: formatMs(val) };
  });

  // X-axis labels (5 ticks)
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const ts = minTs + (tsRange / (xTickCount - 1)) * i;
    return { x: toX(ts), label: chartTimeLabel(ts) };
  });

  // Average line
  const avgY = toY(avgVal);

  const chartId = `lat-${title.replace(/\W/g, "")}`;

  return html`
    <div class="pm-chart-block">
      <div class="pm-chart-header">
        <span class="pm-chart-title"
          ><span class="pm-dot" style="background:${color};"></span> ${title}</span
        >
      </div>
      <div
        class="pm-chart-wrap"
        @mousemove=${(e: MouseEvent) =>
          handleLatencyChartHover(e, samples, minTs, tsRange, maxVal, PAD_L, plotW, plotH, PAD_T)}
        @mouseleave=${handleChartLeave}
      >
        <svg viewBox="0 0 ${W} ${H}" class="pm-chart-svg" preserveAspectRatio="none">
          <!-- Y grid -->
          ${yGridLines.map(
            (g) => html`
              <line
                x1="${PAD_L}"
                y1="${g.y}"
                x2="${W - PAD_R}"
                y2="${g.y}"
                stroke="#d4d8e8"
                stroke-width="0.5"
                stroke-dasharray="3,3"
              />
              <text
                x="${PAD_L - 4}"
                y="${g.y + 3}"
                text-anchor="end"
                fill="#6b7280"
                font-size="8"
                font-family="monospace"
                >${g.label}</text
              >
            `,
          )}
          <!-- X axis -->
          <line
            x1="${PAD_L}"
            y1="${PAD_T + plotH}"
            x2="${W - PAD_R}"
            y2="${PAD_T + plotH}"
            stroke="#c4c9d6"
            stroke-width="0.5"
          />
          ${xTicks.map(
            (t) => html`
              <text
                x="${t.x}"
                y="${H - 2}"
                text-anchor="middle"
                fill="#6b7280"
                font-size="8"
                font-family="monospace"
                >${t.label}</text
              >
            `,
          )}
          <!-- Avg line -->
          <line
            x1="${PAD_L}"
            y1="${avgY}"
            x2="${W - PAD_R}"
            y2="${avgY}"
            stroke="${color}"
            stroke-width="1.5"
            stroke-dasharray="6,4"
            opacity="0.8"
          />
          <text
            x="${W - PAD_R + 2}"
            y="${avgY + 3}"
            fill="${color}"
            font-size="8"
            font-family="monospace"
            font-weight="600"
            opacity="0.9"
          >
            avg
          </text>
          <!-- Scatter points -->
          ${samples.map(
            (s) => html`
              <circle
                cx="${toX(s.ts)}"
                cy="${toY(s.latencyMs)}"
                r="5"
                fill="${color}"
                opacity="1"
                stroke="#ffffff"
                stroke-width="1.5"
              />
            `,
          )}
        </svg>
        <div class="pm-chart-tooltip" id="${chartId}-tip"></div>
        <div class="pm-chart-crosshair" id="${chartId}-cross"></div>
      </div>
      <div class="pm-chart-summary">
        <span>Avg: <b>${formatMs(stats.avgMs)}</b></span>
        <span>P50: <b>${formatMs(stats.p50Ms)}</b></span>
        <span>P95: <b>${formatMs(stats.p95Ms)}</b></span>
        <span>Peak: <b>${formatMs(stats.peakMs)}</b></span>
        <span>N: <b>${stats.count}</b></span>
      </div>
    </div>
  `;
}

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
) {
  const wrap = e.currentTarget as HTMLElement;
  const rect = wrap.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const svgW = rect.width;

  const xRatio = (mouseX - (padL / 460) * svgW) / ((plotW / 460) * svgW);
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
  const padLPct = (padL / 460) * 100;
  const plotWPct = (plotW / 460) * 100;
  const crossLeftPct = padLPct + (nearestXPct / 100) * plotWPct;

  cross.style.display = "block";
  cross.style.left = `${crossLeftPct}%`;

  tip.style.display = "block";
  const labelStr = nearest.label ? `<br/>${nearest.label}` : "";
  tip.innerHTML =
    `<b>${formatMs(nearest.latencyMs)}</b>${labelStr}<br/>` +
    new Date(nearest.ts).toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 1 });

  const tipLeft = crossLeftPct > 70 ? crossLeftPct - 20 : crossLeftPct + 3;
  tip.style.left = `${tipLeft}%`;
  const nearestYPct = padT + plotH - (nearest.latencyMs / maxVal) * plotH;
  tip.style.top = `${(nearestYPct / 120) * 100 - 10}%`;
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
    padding: 4px 10px;
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
    padding: 10px;
  }
  .pm-split-pane {
    flex: 1;
    display: grid;
    grid-template-columns: 50% 25% 25%;
    overflow: hidden;
  }
  .pm-split-left {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid #d4d8e8;
  }
  .pm-split-mid {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    padding: 10px;
    border-right: 1px solid #d4d8e8;
  }
  .pm-split-right {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    padding: 10px;
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
    max-height: 220px;
    overflow-y: auto;
    flex-shrink: 0;
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
    z-index: 2;
    border-bottom: 1px solid #d4d8e8;
  }
  .pm-col-header {
    text-align: center;
    padding: 5px 0;
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    position: relative;
  }
  .pm-col-header::after {
    content: "";
    position: absolute;
    bottom: -9999px;
    left: 50%;
    width: 1px;
    height: 9999px;
    background: #e5e7eb;
    pointer-events: none;
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
    border: 1.5px solid;
    border-radius: 5px;
    padding: 3px 8px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    z-index: 1;
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
    font-size: 11px;
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
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .pm-chart-block {
    border: 1px solid #d4d8e8;
    border-radius: 6px;
    padding: 8px 10px;
    background: #ffffff;
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
    padding: 4px 8px;
    font-size: 10px;
    color: #1a1a2e;
    pointer-events: none;
    z-index: 5;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    line-height: 1.4;
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
`;
