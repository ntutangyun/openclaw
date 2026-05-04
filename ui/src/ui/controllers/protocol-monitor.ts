import { GATEWAY_CLIENT_IDS } from "../../../../src/gateway/protocol/client-info.ts";
import type { GatewayBrowserClient } from "../gateway.ts";

/**
 * Operator-pair filter: in the op↔gw direction tabs, only count traces from
 * the actual Control UI (or unknown-client traces, kept for backwards compat
 * with traces captured before `client` was added). Excludes operator-role
 * connections from agent CLI subprocesses, gateway-client backends, etc. —
 * those still belong on the wire but pollute the operator monitor view.
 *
 * For non-operator-pair directions (node↔gw, agent↔llm), no filter is
 * applied — those don't have the same identity-confusion problem.
 */
function isShownInOperatorPair(t: ProtocolTraceRecord): boolean {
  if (!t.client) {
    return true; // pre-upgrade trace, can't filter
  }
  return t.client === GATEWAY_CLIENT_IDS.CONTROL_UI;
}

function isOperatorPairTrace(t: ProtocolTraceRecord): boolean {
  return (
    (t.source === "operator" && t.target === "gateway") ||
    (t.source === "gateway" && t.target === "operator")
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TraceEntity = "operator" | "gateway" | "node" | "agent" | "llm";

export type ProtocolTraceRecord = {
  id: string;
  ts: number;
  direction: "in" | "out";
  kind: "req" | "res" | "event";
  source: TraceEntity;
  target: TraceEntity;
  method?: string;
  event?: string;
  connId?: string;
  role?: string;
  /**
   * Stable client identifier from the connect frame. Used by the UI to keep
   * the operator-pair (op↔gw) monitor scoped to actual Control UI traffic
   * and exclude agent CLI subprocesses that also connect with operator role
   * (e.g. the agent calling `node.invoke` to drive a tool plugin shows up
   * with `client === "cli"`, not the user's Control UI session).
   */
  client?: string;
  /** Connect-frame `client.mode` (ui/cli/backend/webchat/…). */
  clientMode?: string;
  ok?: boolean;
  payload?: unknown;
  runId?: string;
  seq?: number;
  stream?: string;
  payloadSize?: number;
  /** Protocol-level request id (shared between matching req and res). */
  reqId?: string | number;
  /**
   * One-way wire latency in ms, computed by the gateway as
   * `Date.now() - frame.sentAt` for inbound traces only. Undefined for
   * outbound traces (the gateway can't observe peer recv time) and for
   * inbound traces from peers that don't stamp `sentAt`.
   */
  oneWayLatencyMs?: number;
};

export type CoalescedGroup = {
  type: "group";
  id: string;
  ts: number;
  source: TraceEntity;
  target: TraceEntity;
  runId: string;
  events: ProtocolTraceRecord[];
  label: string;
};

export type CoalescedEntry = (ProtocolTraceRecord & { type?: undefined }) | CoalescedGroup;

// ---------------------------------------------------------------------------
// Message type key -- used for aggregation and filtering
// ---------------------------------------------------------------------------

export function traceTypeKey(record: ProtocolTraceRecord): string {
  if (record.kind === "event" && record.event) {
    return `event.${record.event}${record.stream ? `.${record.stream}` : ""}`;
  }
  if (record.method) {
    return `${record.kind}.${record.method}`;
  }
  return record.kind;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export type ProtocolStats = {
  totalMessages: number;
  toolCalls: number;
  llmCalls: number;
  avgTtft: number | null;
  tokensPerMin: number | null;
  llmLatencyAvg: number | null;
};

export type MessageTypeStats = {
  key: string;
  count: number;
  enabled: boolean;
  avgPerMin: number | null;
  totalBytes: number;
  bytesPerMin: number | null;
};

export type ThroughputSample = {
  ts: number;
  bytesPerSec: number;
  /** Raw bytes accumulated in this bucket (before rate conversion). */
  rawBytes: number;
};

// ---------------------------------------------------------------------------
// Latency types
// ---------------------------------------------------------------------------

export type LatencySample = {
  ts: number;
  latencyMs: number;
  label?: string;
  model?: string;
};

export type LatencyStats = {
  samples: LatencySample[];
  /** Minimum sample value (ms). Null when no samples. */
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
  /** Max sample value (ms). Alias retained for chart-helper backwards compat. */
  peakMs: number | null;
  count: number;
};

// ---------------------------------------------------------------------------
// Model tracking — extract active model from lifecycle events per runId
// ---------------------------------------------------------------------------

/**
 * Build a map of runId → model name from lifecycle events in the trace buffer.
 * Each lifecycle start/request event carries the model name.
 */
export function buildRunModelMap(traces: ProtocolTraceRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of traces) {
    if (!t.runId || t.kind !== "event" || t.stream !== "lifecycle") {
      continue;
    }
    const p = t.payload as Record<string, unknown> | undefined;
    const data = p?.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : p;
    if (!data) {
      continue;
    }
    const model = data.model ?? data.activeModel ?? data.selectedModel;
    if (typeof model === "string" && model.trim()) {
      map.set(t.runId, model.trim());
    }
  }
  return map;
}

/**
 * Extract the list of distinct models seen in the trace buffer.
 */
export function extractModels(traces: ProtocolTraceRecord[]): string[] {
  const models = new Set<string>();
  const runModelMap = buildRunModelMap(traces);
  for (const model of runModelMap.values()) {
    models.add(model);
  }
  return [...models].toSorted();
}

/**
 * Filter traces to only those associated with a specific model.
 * Traces without a runId (e.g., operator↔gateway RPC) are always included.
 * Traces with a runId are included only if that run used the specified model.
 */
export function filterTracesByModel(
  traces: ProtocolTraceRecord[],
  model: string | null,
  runModelMap: Map<string, string>,
): ProtocolTraceRecord[] {
  if (!model) {
    return traces;
  }
  return traces.filter((t) => {
    if (!t.runId) {
      return true; // Non-run traces (RPC, etc.) always included
    }
    return runModelMap.get(t.runId) === model;
  });
}

export type DirectionalThroughputSamples = {
  combined: ThroughputSample[];
  forward: ThroughputSample[];
  reverse: ThroughputSample[];
};

/** Distribution stats for a single direction's per-message throughput series. */
export type ThroughputDirectionStats = {
  samples: ThroughputSample[];
  minBytesPerSec: number | null;
  p50BytesPerSec: number | null;
  p95BytesPerSec: number | null;
  avgBytesPerSec: number | null;
  peakBytesPerSec: number | null;
  count: number;
};

export type DirectionalThroughputStats = {
  forward: ThroughputDirectionStats;
  reverse: ThroughputDirectionStats;
};

/**
 * Aggregate stats per message type for the "messages" section. One card per
 * distinct method/event observed on a wire pair.
 */
export type MessageTypeCard = {
  type: string; // e.g. "req.chat.send", "event.session.message"
  count: number;
  minBytes: number;
  maxBytes: number;
};

/** Single message data point for the per-direction bar chart. */
export type MessageBar = {
  ts: number;
  size: number;
  type: string;
};

export type MessagesDirection = {
  cards: MessageTypeCard[];
  bars: MessageBar[];
};

export type DirectionalMessages = {
  forward: MessagesDirection;
  reverse: MessagesDirection;
};

export type RequestStats = {
  /** Total number of Agent → Model LLM requests observed. */
  total: number;
  /** Largest single request payload size in bytes. */
  peakPayloadSize: number;
  /** Mean request payload size in bytes (0 if none). */
  avgPayloadSize: number;
  /** Timestamp of the most recent request, or null if none. */
  latestTs: number | null;
  /** Payload size of the most recent request in bytes. */
  latestPayloadSize: number;
};

export type ResponseStats = {
  /** Total number of Model → Agent SSE (assistant stream) events observed. */
  totalEvents: number;
  /** Mean events per second across the SSE stream, or null if < 2 events. */
  avgEventsPerSec: number | null;
  /** Largest single SSE payload size in bytes. */
  peakPayloadSize: number;
  /** Mean SSE payload size in bytes (0 if none). */
  avgPayloadSize: number;
};

/**
 * Per-LLM-call rollup. One entry per `runId` lifecycle (agent→model request +
 * the entire llm→agent SSE stream that follows). Used by the agent|model
 * monitor's "LLM Calls" section so the bar chart shows one bar per call —
 * far more readable than one bar per SSE delta and immune to MAX_VISIBLE
 * trace eviction.
 */
export type LlmCall = {
  runId: string;
  /** Lifecycle-resolved model name (`activeModel` / `selectedModel` / `model`). */
  model: string | null;
  /** Lifecycle start ts — when the request body left the agent. */
  requestTs: number;
  /** Serialized request body size (lifecycle event's `data.requestSize`). */
  requestBytes: number;
  /** First assistant SSE event ts; null until first chunk arrives. */
  firstAssistantTs: number | null;
  /** Most recent assistant SSE event ts; tracks last activity for the call. */
  lastAssistantTs: number | null;
  /** SSE event count for this call (one per parsed JSONL record). */
  responseEventCount: number;
  /** Sum of all SSE event payload sizes for this call. */
  responseBytes: number;
  /** Min single SSE event size in this call (Infinity until first event). */
  minSseBytes: number;
  /** Max single SSE event size in this call. */
  maxSseBytes: number;
  /** Number of tool calls (`stream:"tool"` start events) attributed to this run. */
  toolCallCount: number;
  /** True after a lifecycle `end` is observed for this run. */
  responseComplete: boolean;
};

/**
 * Per-call data point — one entry per LLM call. Used for line charts where
 * the y-value isn't bytes/sec (the original ThroughputSample shape) so we
 * keep both: `value` is the headline, `extra` is whatever supplementary
 * number the tooltip wants to surface.
 */
export type LlmPerCallSample = {
  ts: number;
  value: number;
  extra?: number;
};

/**
 * Categories used to color and group bars in the unified agent|model event
 * chart. One per logical event-type:
 *   - `request`        — agent→llm lifecycle "request" (one per LLM call)
 *   - `sse`            — llm→agent assistant SSE delta (one per parsed delta)
 *   - `tool-call`      — agent→gateway tool start (one per tool invocation)
 *   - `tool-result`    — tool result echo back to the agent
 *   - `complete`       — llm→agent lifecycle "end"
 *   - `other`          — anything else with a runId on this edge
 */
export type AgentLlmEventCategory =
  | "request"
  | "sse"
  | "tool-call"
  | "tool-result"
  | "complete"
  | "other";

export type AgentLlmEventBar = {
  ts: number;
  size: number;
  category: AgentLlmEventCategory;
  /** Short detail string for the tooltip (e.g. tool name, model name). */
  detail?: string;
};

export type AgentLlmEventCard = {
  category: AgentLlmEventCategory;
  count: number;
  totalBytes: number;
  minBytes: number;
  maxBytes: number;
};

export type AgentLlmStats = {
  /** Per-call TTFT — one sample per LLM call. */
  ttft: LatencyStats;
  /** Total LLM calls (one per request event). */
  totalCalls: number;
  /** Total events recorded in the unified event store. */
  totalEvents: number;
  /** Sum of all event payloads. */
  totalBytes: number;
  /** Cards aggregated by category for the headline grid. */
  cards: AgentLlmEventCard[];
  /** One bar per recorded event; drives the unified chart. */
  bars: AgentLlmEventBar[];
  /**
   * Per-LLM-call generation throughput. One sample per LLM call:
   * `bytesPerSec = responseBytes / generationDurationMs * 1000`,
   * `rawBytes = responseBytes`. Used by the Throughput section's
   * per-message-throughput stats (min/peak/avg/median bytes/sec).
   */
  callThroughput: ThroughputDirectionStats;
  /**
   * Per-event payload-size distribution (each bar contributes one sample).
   * Used by the Throughput section's per-message-bytes stats.
   */
  eventByteStats: PayloadByteStats;
};

/** Distribution of per-message payload sizes (in bytes). */
export type PayloadByteStats = {
  count: number;
  totalBytes: number;
  minBytes: number | null;
  maxBytes: number | null;
  avgBytes: number | null;
  p50Bytes: number | null;
};

/**
 * Per-model card aggregates for the agent|model monitor's "LLM Calls"
 * section. Mirrors `MessageTypeCard` for wire-pair Messages.
 */
export type LlmCallCard = {
  /** Resolved model name, or `(unknown)` for calls whose lifecycle never
   * carried a model identifier. */
  model: string;
  count: number;
  minBytes: number;
  maxBytes: number;
  totalBytes: number;
};

/** Single LLM call data point for the per-direction bar chart. */
export type LlmCallBar = {
  ts: number;
  size: number;
  model: string;
};

export type LlmCallSection = {
  cards: LlmCallCard[];
  bars: LlmCallBar[];
};

export type NetworkStats = {
  totalBytesIn: number;
  totalBytesOut: number;
  operatorGateway: DirectionalThroughputSamples;
  gatewayNode: DirectionalThroughputSamples;
  /**
   * Per-message throughput stats for the wire pairs. Each sample is
   * `payloadBytes / contemporaneous_ping_oneWayMs * 1000` — uses the
   * dedicated ping protocol's most-recent latency reading for that
   * direction so throughput is independent of the message's own timing.
   * agent-llm is in-process and doesn't get per-message throughput stats.
   */
  operatorGatewayThroughputStats: DirectionalThroughputStats;
  gatewayNodeThroughputStats: DirectionalThroughputStats;
  /**
   * Per-message-type aggregates + per-message bars for the "messages"
   * section. One per wire pair, broken down by direction. Only traces that
   * survived `DEFAULT_INGEST_BLOCKLIST` (i.e. agentic-task-relevant frames)
   * appear here.
   */
  operatorGatewayMessages: DirectionalMessages;
  gatewayNodeMessages: DirectionalMessages;
  /**
   * Merged Agent ↔ Model rollup. Replaces the old split agent-to-model /
   * model-to-agent direction tabs. Contains: HTTP request bars, per-call
   * TTFT latency stats, SSE rate + size stats, tool call counts per
   * response, and complete-response bytes — all keyed by `runId` from
   * `llmCallStore` so they survive trace ring buffer eviction.
   */
  agentLlm: AgentLlmStats;
  /**
   * Operator → Gateway WS one-way latency samples, derived from
   * `frame.sentAt` stamped by the operator client. Assumes synced clocks.
   */
  operatorGatewayOneWayLatency: LatencyStats;
  /**
   * Node → Gateway WS one-way latency samples, derived from `frame.sentAt`
   * stamped by the node client. Assumes synced clocks.
   */
  nodeGatewayOneWayLatency: LatencyStats;
  /**
   * Gateway → Operator WS one-way latency samples, peer-measured by the
   * operator client and reported back via `protocol-traces.rx-report`. The
   * gateway can't observe its own outbound frames' arrival time at the
   * peer from its own clock alone.
   */
  gatewayOperatorOneWayLatency: LatencyStats;
  /**
   * Gateway → Node WS one-way latency samples, peer-measured by the node
   * client and reported back via `protocol-traces.rx-report`.
   */
  gatewayNodeOneWayLatency: LatencyStats;
};

// ---------------------------------------------------------------------------
// Chat / tool message extraction for live cards
// ---------------------------------------------------------------------------

export type ChatMessage = {
  ts: number;
  role: "user" | "assistant";
  text: string;
};

export type ToolCallMessage = {
  ts: number;
  name: string;
  phase: string;
  detail: string;
  agentId?: string;
};

export function extractChatMessages(traces: ProtocolTraceRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const t of traces) {
    if (t.kind !== "event") {
      continue;
    }
    // Chat events (complete messages, not streaming tokens)
    if (t.event === "chat" || t.event === "session.message") {
      const p = t.payload as Record<string, unknown> | undefined;
      if (!p) {
        continue;
      }
      const state = p.state as string | undefined;
      if (state !== "final" && t.event === "chat") {
        continue;
      }
      const msg = p.message as Record<string, unknown> | undefined;
      if (!msg) {
        continue;
      }
      const role = msg.role as string;
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      let text = "";
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
      if (!text && typeof msg.text === "string") {
        text = msg.text.trim();
      }
      if (text) {
        messages.push({ ts: t.ts, role: role, text });
      }
    }
  }
  return messages;
}

export function extractToolCalls(traces: ProtocolTraceRecord[]): ToolCallMessage[] {
  const calls: ToolCallMessage[] = [];
  for (const t of traces) {
    if (t.kind !== "event" || t.stream !== "tool") {
      continue;
    }
    const p = t.payload as Record<string, unknown> | undefined;
    const data = p?.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : p;
    if (!data) {
      continue;
    }
    const phase = (data.phase as string) ?? "";
    const name = (data.name as string) ?? "unknown";
    if (!phase) {
      continue;
    }
    let detail = "";
    const meta = typeof data.meta === "string" ? data.meta : undefined;
    const args =
      data.args && typeof data.args === "object" ? (data.args as Record<string, unknown>) : null;
    if (phase === "start") {
      if ((name === "exec" || name === "bash") && args?.command) {
        detail = (
          typeof args.command === "string" ? args.command : JSON.stringify(args.command)
        ).slice(0, 120);
      } else if (
        (name === "read" || name === "write" || name === "edit") &&
        (args?.path ?? args?.file_path)
      ) {
        detail = String(args?.path ?? args?.file_path);
      } else if (meta) {
        detail = meta.slice(0, 120);
      }
    } else if (phase === "result" || phase === "end") {
      const isErr = data.isError === true;
      detail = isErr ? "failed" : (meta ?? "done");
    }
    calls.push({
      ts: t.ts,
      name,
      phase,
      detail,
      agentId: t.runId ? `agent:${t.runId.slice(0, 8)}` : undefined,
    });
  }
  return calls;
}

/**
 * Methods (req/res) and events that the protocol monitor should NOT ingest
 * into its trace buffer at all. These are UI/control-plane housekeeping calls
 * (periodic polls, presence pings, etc.) that aren't part of the user's task
 * flow and would otherwise crowd the fixed-length buffer (MAX_VISIBLE = 1000)
 * out of useful agent traces.
 *
 * The traffic still flows on the wire — this only filters what the UI keeps
 * locally for the Protocol Monitor view. Other parts of the UI (overview,
 * usage, nodes list, etc.) are unaffected because they consume those
 * responses through their own controllers, not through `protocolTraces`.
 */
export const DEFAULT_INGEST_BLOCKLIST = new Set<string>([
  // Periodic polls
  "node.list",
  "nodes.list",
  "node.describe",
  "device.pair.list",
  "device.pair.status",
  "session.usage",
  "sessions.usage",
  "sessions.list",
  "sessions.subscribe",
  "sessions.unsubscribe",
  "sessions.messages.subscribe",
  "sessions.messages.unsubscribe",
  "agent.identity.get",
  "agents.list",
  "presence.list",
  "system-presence",
  "channels.list",
  "channels.status",
  "cron.list",
  "cron.status",
  "cron.runs",
  "config.get",
  "models.list",
  "models.authStatus",
  "tools.catalog",
  "tools.effective",
  "usage.status",
  "usage.cost",
  "debug.snapshot",
  // UI bootstrap / catalog (one-shot, not part of the running task)
  "gateway.identity.get",
  "talk.config",
  "voicewake.get",
  "skills.status",
  "skills.search",
  "skills.detail",
  "commands.list",
  // Health / liveness
  "health",
  "last-heartbeat",
  "set-heartbeats",
  "status",
  // Connection lifecycle
  "connect",
  "hello",
  // The protocol monitor's own RPCs
  "protocol-traces.list",
  "protocol-traces.clear",
  // Peer → gateway batch of measured rx-latency samples for the gateway→peer
  // direction (the trip itself shouldn't show up as gateway→peer or
  // peer→gateway throughput/latency in the chart).
  "protocol-traces.rx-report",
  // Clock-sync mechanism — high-frequency, mechanism-only, would dominate
  // operator->gateway aggregates if left in.
  "time.sync",
  // Dedicated ping protocol for protocol-monitor latency. Excluded from
  // throughput / messages / timeline so it doesn't pollute the metrics it's
  // supposed to measure.
  "ping.peer-to-gw",
  "ping.gw-to-peer.ack",
  "ping.metrics-report",
  // Read-only history fetched on UI mount; not part of the active task flow.
  "chat.history",
  // Node control-plane queue plumbing — not part of the agentic task itself.
  "node.pending.pull",
  "node.pending.ack",
  "node.pending.drain",
  "node.canvas.capability.refresh",
  // Periodic broadcast events
  "tick",
  "heartbeat",
  "presence",
  "open",
  "hello-ok",
  "protocol.trace",
  // Gateway → UIs broadcast of a peer-reported rx-latency batch.
  "protocol.rx.samples",
  // Gateway → peer ping event + gateway → all-UIs sample broadcast.
  "ping.gw-to-peer",
  "ping.metrics",
]);

/** Returns true if a trace record should be dropped before ingestion. */
export function isIngestBlocklisted(
  record: { method?: string; event?: string },
  blocklist: ReadonlySet<string> = DEFAULT_INGEST_BLOCKLIST,
): boolean {
  if (record.method && blocklist.has(record.method)) {
    return true;
  }
  if (record.event && blocklist.has(record.event)) {
    return true;
  }
  return false;
}

/**
 * Narrower filter applied ONLY to the per-direction Messages store. The full
 * `DEFAULT_INGEST_BLOCKLIST` keeps the trace ring buffer focused on agentic
 * task traffic; the wire-pair message-size bar chart is a different question:
 * "what kinds of frames are actually moving on this WebSocket?". For that, we
 * want to surface health pings, presence ticks, polls etc. so the chart
 * isn't almost-empty when no agent task is running. Only true measurement
 * mechanism that the protocol monitor itself depends on stays excluded —
 * leaving those in would be self-referential and would dominate the chart.
 */
export const MESSAGES_SELF_REFERENTIAL_BLOCKLIST = new Set<string>([
  // The protocol monitor's own RPCs and rebroadcast events.
  "protocol-traces.list",
  "protocol-traces.clear",
  "protocol-traces.rx-report",
  "protocol.trace",
  "protocol.rx.samples",
  // The dedicated ping protocol (high frequency, used to derive latency).
  "ping.peer-to-gw",
  "ping.gw-to-peer",
  "ping.gw-to-peer.ack",
  "ping.metrics",
  "ping.metrics-report",
  // Clock-sync mechanism (high frequency, used to derive sentAt offsets).
  "time.sync",
]);

/** Default disabled message types for cleaner agentic task view. */
export const DEFAULT_DISABLED_TYPES = new Set([
  "req.health",
  "res.health",
  "req.connect",
  "event.open",
  "event.hello-ok",
  "req.agents.list",
  "res.agents.list",
  "req.nodes.list",
  "res.nodes.list",
  "req.sessions.list",
  "res.sessions.list",
  "req.sessions.subscribe",
  "res.sessions.subscribe",
  "req.sessions.unsubscribe",
  "res.sessions.unsubscribe",
  "req.sessions.messages.subscribe",
  "res.sessions.messages.subscribe",
  "req.sessions.messages.unsubscribe",
  "res.sessions.messages.unsubscribe",
  "event.presence",
  "event.tick",
  "event.heartbeat",
  "event.health",
  "event.protocol.trace",
  "req.protocol-traces.list",
  "res.protocol-traces.list",
  "req.last-heartbeat",
  "res.last-heartbeat",
  "req.set-heartbeats",
  "res.set-heartbeats",
  "req.status",
  "res.status",
  "req.usage.status",
  "res.usage.status",
  "req.usage.cost",
  "res.usage.cost",
  "req.config.get",
  "res.config.get",
  "req.models.list",
  "res.models.list",
  "req.tools.catalog",
  "res.tools.catalog",
  "req.tools.effective",
  "res.tools.effective",
  "req.system-presence",
  "res.system-presence",
  "req.channels.status",
  "res.channels.status",
]);

/**
 * Resolve the `phase` string from an agent event payload.
 *
 * The payload shape varies depending on truncation and serialization:
 *   - Full AgentEventPayload:  `{ data: { phase } }`
 *   - Flattened ws-log meta:   `{ phase }`
 *   - Truncated:               `{ _truncated: true }` (no phase)
 */
function resolvePhase(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const rec = payload as Record<string, unknown>;
  // Direct (flattened)
  if (typeof rec.phase === "string") {
    return rec.phase;
  }
  // Nested inside data (AgentEventPayload shape)
  if (rec.data && typeof rec.data === "object") {
    const d = rec.data as Record<string, unknown>;
    if (typeof d.phase === "string") {
      return d.phase;
    }
  }
  return undefined;
}

export function computeStats(traces: ProtocolTraceRecord[]): ProtocolStats {
  let toolCalls = 0;
  let llmCalls = 0;
  const llmStartTimes = new Map<string, number>();
  const ttftValues: number[] = [];
  let assistantTokenEvents = 0;
  let firstAssistantTs: number | null = null;
  let lastAssistantTs: number | null = null;

  for (const t of traces) {
    // Tool calls: agent event with stream=tool and phase=start
    if (t.stream === "tool" && t.kind === "event") {
      if (resolvePhase(t.payload) === "start") {
        toolCalls++;
      }
    }
    // LLM calls: lifecycle start
    if (t.stream === "lifecycle" && t.kind === "event") {
      const phase = resolvePhase(t.payload);
      if (phase === "start" && t.runId) {
        llmCalls++;
        llmStartTimes.set(t.runId, t.ts);
      }
    }
    // TTFT: time from lifecycle start to first assistant event for same runId
    if (t.stream === "assistant" && t.kind === "event" && t.runId) {
      const startTs = llmStartTimes.get(t.runId);
      if (startTs !== undefined) {
        ttftValues.push(t.ts - startTs);
        llmStartTimes.delete(t.runId);
      }
      assistantTokenEvents++;
      if (firstAssistantTs === null) {
        firstAssistantTs = t.ts;
      }
      lastAssistantTs = t.ts;
    }
  }

  const avgTtft =
    ttftValues.length > 0 ? ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length : null;

  // Tokens per minute approximation: assistant events per minute window
  let tokensPerMin: number | null = null;
  if (firstAssistantTs !== null && lastAssistantTs !== null && lastAssistantTs > firstAssistantTs) {
    const durationMin = (lastAssistantTs - firstAssistantTs) / 60_000;
    if (durationMin > 0) {
      tokensPerMin = Math.round(assistantTokenEvents / durationMin);
    }
  }

  return {
    totalMessages: traces.length,
    toolCalls,
    llmCalls,
    avgTtft: avgTtft !== null ? Math.round(avgTtft) : null,
    tokensPerMin,
    llmLatencyAvg: avgTtft !== null ? Math.round(avgTtft) : null,
  };
}

export function computeMessageTypes(
  traces: ProtocolTraceRecord[],
  disabledTypes: Set<string>,
): MessageTypeStats[] {
  const buckets = new Map<
    string,
    { count: number; totalBytes: number; firstTs: number; lastTs: number }
  >();
  for (const t of traces) {
    const key = traceTypeKey(t);
    const existing = buckets.get(key);
    const size = t.payloadSize ?? 0;
    if (existing) {
      existing.count++;
      existing.totalBytes += size;
      if (t.ts < existing.firstTs) {
        existing.firstTs = t.ts;
      }
      if (t.ts > existing.lastTs) {
        existing.lastTs = t.ts;
      }
    } else {
      buckets.set(key, { count: 1, totalBytes: size, firstTs: t.ts, lastTs: t.ts });
    }
  }
  return [...buckets.entries()]
    .map(([key, b]) => {
      const durationMin = b.lastTs > b.firstTs ? (b.lastTs - b.firstTs) / 60_000 : 0;
      return {
        key,
        count: b.count,
        enabled: !disabledTypes.has(key),
        avgPerMin: durationMin > 0 ? Math.round(b.count / durationMin) : null,
        totalBytes: b.totalBytes,
        bytesPerMin: durationMin > 0 ? Math.round(b.totalBytes / durationMin) : null,
      };
    })
    .toSorted((a, b) => b.count - a.count);
}

const THROUGHPUT_BUCKET_MS = 2000;

// ---------------------------------------------------------------------------
// Persistent network stats accumulators
//
// computeNetworkStats is invoked on every render over whatever is currently in
// the client-side trace buffer (capped at MAX_VISIBLE = 1000). For a busy
// session that generates thousands of traces — especially chatty assistant
// stream deltas — older traces get evicted by newer ones, and any "since
// session start" totals or bucket counts computed from the live buffer alone
// collapse to reflect only the last ~1000 traces.
//
// Symptoms this pattern fixes:
//   - Total Bytes dropping from 90 MB to 20 B mid-session once large
//     lifecycle requests are pushed out
//   - Model → Agent showing far fewer buckets than Agent → Model because
//     many stream events per call evict themselves faster
//
// Mirrors the ttftCache / genCache approach already used for TTFT and
// generation latency: ingest each trace exactly once (dedup by id), maintain
// running totals and bucket maps at module scope, and snapshot them on reset.
// ---------------------------------------------------------------------------

type BucketMap = Map<number, number>;

type RouteAccumulator = {
  combined: BucketMap;
  forward: BucketMap;
  reverse: BucketMap;
};

type RequestAccumulatorState = {
  total: number;
  peakSize: number;
  totalSize: number;
  latestTs: number | null;
  latestSize: number;
};

type ResponseAccumulatorState = {
  total: number;
  peakSize: number;
  totalSize: number;
  firstTs: number | null;
  lastTs: number | null;
};

function emptyRoute(): RouteAccumulator {
  return { combined: new Map(), forward: new Map(), reverse: new Map() };
}

const netState = {
  totalBytesIn: 0,
  totalBytesOut: 0,
  operatorGateway: emptyRoute(),
  agentLlm: emptyRoute(),
  gatewayNode: emptyRoute(),
  requests: {
    total: 0,
    peakSize: 0,
    totalSize: 0,
    latestTs: null,
    latestSize: 0,
  } as RequestAccumulatorState,
  responses: {
    total: 0,
    peakSize: 0,
    totalSize: 0,
    firstTs: null,
    lastTs: null,
  } as ResponseAccumulatorState,
};

const netProcessed = new Set<string>();
/** Absolute cap; clearing risks a one-off recount artifact. Matches latency-cache policy. */
const MAX_NET_PROCESSED = 200_000;

function addBucket(map: BucketMap, bucket: number, size: number) {
  map.set(bucket, (map.get(bucket) ?? 0) + size);
}

function ingestIntoNetwork(t: ProtocolTraceRecord): void {
  if (netProcessed.has(t.id)) {
    return;
  }
  netProcessed.add(t.id);

  const size = t.payloadSize ?? 0;
  if (t.direction === "in") {
    netState.totalBytesIn += size;
  } else {
    netState.totalBytesOut += size;
  }

  const bucket = Math.floor(t.ts / THROUGHPUT_BUCKET_MS) * THROUGHPUT_BUCKET_MS;
  const src = t.source;
  const tgt = t.target;

  if (src === "operator" && tgt === "gateway") {
    if (isShownInOperatorPair(t)) {
      addBucket(netState.operatorGateway.combined, bucket, size);
      addBucket(netState.operatorGateway.forward, bucket, size);
    }
  } else if (src === "gateway" && tgt === "operator") {
    if (isShownInOperatorPair(t)) {
      addBucket(netState.operatorGateway.combined, bucket, size);
      addBucket(netState.operatorGateway.reverse, bucket, size);
    }
  }

  if (src === "agent" && tgt === "llm") {
    addBucket(netState.agentLlm.combined, bucket, size);
    addBucket(netState.agentLlm.forward, bucket, size);
    // Requests: agent→llm lifecycle start/request events carry the full LLM
    // request body size in `payloadSize` (see `requestSize` override in the
    // trace store). Everything else on this edge is tool metadata.
    if (t.kind === "event" && t.stream === "lifecycle") {
      const phase = resolvePhase(t.payload);
      if (phase === "start" || phase === "request") {
        netState.requests.total += 1;
        if (size > netState.requests.peakSize) {
          netState.requests.peakSize = size;
        }
        netState.requests.totalSize += size;
        if (netState.requests.latestTs === null || t.ts > netState.requests.latestTs) {
          netState.requests.latestTs = t.ts;
          netState.requests.latestSize = size;
        }
      }
    }
  } else if (src === "llm" && tgt === "agent") {
    addBucket(netState.agentLlm.combined, bucket, size);
    addBucket(netState.agentLlm.reverse, bucket, size);
    // Responses: each assistant stream event represents one SSE frame from
    // the model. Lifecycle end also lands in this direction; we only count
    // stream frames for SSE stats.
    if (t.kind === "event" && t.stream === "assistant") {
      netState.responses.total += 1;
      if (size > netState.responses.peakSize) {
        netState.responses.peakSize = size;
      }
      netState.responses.totalSize += size;
      if (netState.responses.firstTs === null || t.ts < netState.responses.firstTs) {
        netState.responses.firstTs = t.ts;
      }
      if (netState.responses.lastTs === null || t.ts > netState.responses.lastTs) {
        netState.responses.lastTs = t.ts;
      }
    }
  }

  if (src === "gateway" && tgt === "node") {
    addBucket(netState.gatewayNode.combined, bucket, size);
    addBucket(netState.gatewayNode.forward, bucket, size);
  } else if (src === "node" && tgt === "gateway") {
    addBucket(netState.gatewayNode.combined, bucket, size);
    addBucket(netState.gatewayNode.reverse, bucket, size);
  }
}

function trimNetProcessed(): void {
  if (netProcessed.size > MAX_NET_PROCESSED) {
    netProcessed.clear();
  }
}

export function clearNetworkAccumulators(): void {
  netState.totalBytesIn = 0;
  netState.totalBytesOut = 0;
  netState.operatorGateway.combined.clear();
  netState.operatorGateway.forward.clear();
  netState.operatorGateway.reverse.clear();
  netState.agentLlm.combined.clear();
  netState.agentLlm.forward.clear();
  netState.agentLlm.reverse.clear();
  netState.gatewayNode.combined.clear();
  netState.gatewayNode.forward.clear();
  netState.gatewayNode.reverse.clear();
  netState.requests.total = 0;
  netState.requests.peakSize = 0;
  netState.requests.totalSize = 0;
  netState.requests.latestTs = null;
  netState.requests.latestSize = 0;
  netState.responses.total = 0;
  netState.responses.peakSize = 0;
  netState.responses.totalSize = 0;
  netState.responses.firstTs = null;
  netState.responses.lastTs = null;
  netProcessed.clear();
}

function bucketsToSamples(buckets: BucketMap): ThroughputSample[] {
  return [...buckets.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([ts, bytes]) => ({
      ts,
      bytesPerSec: (bytes / THROUGHPUT_BUCKET_MS) * 1000,
      rawBytes: bytes,
    }));
}

function routeToDirectional(r: RouteAccumulator): DirectionalThroughputSamples {
  return {
    combined: bucketsToSamples(r.combined),
    forward: bucketsToSamples(r.forward),
    reverse: bucketsToSamples(r.reverse),
  };
}

export function computeNetworkStats(
  traces: ProtocolTraceRecord[],
  modelFilter?: string | null,
  // _runModelMap kept for callers that pass it positionally; the new
  // per-call store carries `model` on each LlmCall entry directly so we
  // don't need an external map. Underscore prefix suppresses unused warn.
  _runModelMap?: Map<string, string>,
): NetworkStats {
  for (const t of traces) {
    ingestIntoNetwork(t);
  }
  trimNetProcessed();

  // Build the unified agent|model stats (TTFT + per-category cards + bars)
  // and apply the model filter to the TTFT samples (the only model-tagged
  // dimension in the rollup).
  const agentLlmRaw = buildAgentLlmStats();
  const agentLlm: AgentLlmStats = {
    ...agentLlmRaw,
    ttft: filterLatencyByModel(agentLlmRaw.ttft, modelFilter),
  };
  return {
    totalBytesIn: netState.totalBytesIn,
    totalBytesOut: netState.totalBytesOut,
    operatorGateway: routeToDirectional(netState.operatorGateway),
    gatewayNode: routeToDirectional(netState.gatewayNode),
    agentLlm,
    // Latency now sources from dedicated 10s pings (RTT/2 in each direction)
    // instead of mining functional-message sentAt. See ping.ts for design.
    operatorGatewayOneWayLatency: computePingLatencyStats("operator", "forward"),
    gatewayOperatorOneWayLatency: computePingLatencyStats("operator", "reverse"),
    nodeGatewayOneWayLatency: computePingLatencyStats("node", "forward"),
    gatewayNodeOneWayLatency: computePingLatencyStats("node", "reverse"),
    // Per-message throughput stats. peer→gw uses trace.oneWayLatencyMs
    // (gateway-stamped at recv); gw→peer reads payloadSize+latencyMs from
    // peer-reported rx-samples directly. Either way, per-message — no
    // per-window ping smearing — and no trace↔rx-sample join needed.
    operatorGatewayThroughputStats: {
      forward: buildThroughputStats(
        computePeerToGwThroughput(traces, "operator", getLatestPingOneWayMs("operator", "forward")),
      ),
      reverse: buildThroughputStats(computeGwToPeerThroughput(rxSamplesOperator)),
    },
    gatewayNodeThroughputStats: {
      forward: buildThroughputStats(
        computePeerToGwThroughput(traces, "node", getLatestPingOneWayMs("node", "forward")),
      ),
      reverse: buildThroughputStats(computeGwToPeerThroughput(rxSamplesNode)),
    },
    operatorGatewayMessages: {
      forward: buildMessagesDirection(messageStore.opGw.forward),
      reverse: buildMessagesDirection(messageStore.opGw.reverse),
    },
    gatewayNodeMessages: {
      forward: buildMessagesDirection(messageStore.nodeGw.forward),
      reverse: buildMessagesDirection(messageStore.nodeGw.reverse),
    },
  };
}

// ---------------------------------------------------------------------------
// Latency computation helpers
// ---------------------------------------------------------------------------

function filterLatencyByModel(stats: LatencyStats, modelFilter?: string | null): LatencyStats {
  if (!modelFilter) {
    return stats;
  }
  const filtered = stats.samples.filter((s) => !s.model || s.model === modelFilter);
  return buildLatencyStats(filtered);
}

/**
 * Most recent ping-derived one-way latency (ms) for a given source/direction,
 * or null if no pings have arrived yet. Used by per-message throughput to
 * estimate transmission time without instrumenting the message itself.
 */
function getLatestPingOneWayMs(
  source: "operator" | "node",
  direction: "forward" | "reverse",
): number | null {
  const arr = pingSamples[source][direction];
  if (arr.length === 0) {
    return null;
  }
  const last = arr[arr.length - 1];
  return last ? last.oneWayMs : null;
}

/**
 * Per-message throughput, peer→gw direction (op→gw, node→gw). Each trace
 * carries `oneWayLatencyMs` stamped by the gateway at ingest time as
 * `recvTs − frame.sentAt`, where `frame.sentAt` was already adjusted into
 * gateway clock by the peer using the cached `time.sync` offset. We just
 * divide payload bytes by that per-message latency — no joining anything.
 *
 * Falls back to the most recent ping one-way latency only if a trace lacks
 * `oneWayLatencyMs` (pre-upgrade peer that didn't stamp `sentAt`, or a
 * frame the gateway clamped on capture). Skips traces that fail the
 * operator-pair filter so non-Control-UI operator clients (agent CLI etc.)
 * don't pollute the chart.
 */
function computePeerToGwThroughput(
  traces: ProtocolTraceRecord[],
  matchSource: TraceEntity,
  fallbackPingMs: number | null,
): ThroughputSample[] {
  const samples: ThroughputSample[] = [];
  for (const t of traces) {
    if (t.source !== matchSource || t.target !== "gateway") {
      continue;
    }
    if (isOperatorPairTrace(t) && !isShownInOperatorPair(t)) {
      continue;
    }
    const bytes = t.payloadSize ?? 0;
    if (bytes <= 0) {
      continue;
    }
    let oneWayMs: number | null = typeof t.oneWayLatencyMs === "number" ? t.oneWayLatencyMs : null;
    if (oneWayMs === null || oneWayMs <= 0) {
      oneWayMs = fallbackPingMs;
    }
    if (oneWayMs === null || oneWayMs <= 0) {
      continue;
    }
    samples.push({ ts: t.ts, bytesPerSec: (bytes / oneWayMs) * 1000, rawBytes: bytes });
  }
  return samples;
}

/**
 * Per-message throughput, gw→peer direction (gw→op, gw→node). Read directly
 * from rx-samples — the peer captured each frame's `payloadSize` and
 * `latencyMs` at recv time (`recvTs + clockOffsetMs − frame.sentAt`) and
 * batch-reported them via `protocol-traces.rx-report`. No trace join needed.
 *
 * Operator-pair filtering happens at ingest (`handleProtocolRxSamplesEvent`
 * drops batches from non-Control-UI operator clients), so iterating the
 * buffer here doesn't need a per-sample filter. Pre-upgrade peers that
 * didn't stamp `payloadSize` get skipped — there's no fallback because
 * fallback would require a trace lookup, which is what we're trying to
 * avoid.
 */
function computeGwToPeerThroughput(rxSamples: RxLatencySampleEntry[]): ThroughputSample[] {
  const samples: ThroughputSample[] = [];
  for (const s of rxSamples) {
    if (s.payloadSize === undefined || s.payloadSize <= 0) {
      continue;
    }
    if (s.latencyMs <= 0) {
      continue;
    }
    samples.push({
      ts: s.ts,
      bytesPerSec: (s.payloadSize / s.latencyMs) * 1000,
      rawBytes: s.payloadSize,
    });
  }
  return samples;
}

/**
 * Stable display label per message: `event.<name>` for events, `<kind>.<method>`
 * for req/res frames. Returns null for frames that have neither an event name
 * nor a method (rare; e.g. malformed frames).
 */
function resolveMessageType(t: ProtocolTraceRecord): string | null {
  if (t.kind === "event") {
    return t.event ? `event.${t.event}` : null;
  }
  if (t.method) {
    return `${t.kind}.${t.method}`;
  }
  return null;
}

/**
 * Read the per-direction message buffer (populated at ingest time, decoupled
 * from the shared MAX_VISIBLE trace buffer) and roll it up into cards + bars.
 */
function buildMessagesDirection(buf: MessageEntry[]): MessagesDirection {
  const cardMap = new Map<string, MessageTypeCard>();
  const bars: MessageBar[] = [];
  for (const e of buf) {
    bars.push({ ts: e.ts, size: e.size, type: e.type });
    const existing = cardMap.get(e.type);
    if (existing) {
      existing.count += 1;
      if (e.size < existing.minBytes) {
        existing.minBytes = e.size;
      }
      if (e.size > existing.maxBytes) {
        existing.maxBytes = e.size;
      }
    } else {
      cardMap.set(e.type, {
        type: e.type,
        count: 1,
        minBytes: e.size,
        maxBytes: e.size,
      });
    }
  }
  return {
    cards: Array.from(cardMap.values()).toSorted((a, b) => b.count - a.count),
    bars,
  };
}

/**
 * Distribution of per-message payload sizes. `sizes` is the raw `payloadSize`
 * (bytes) for each message — this builder doesn't care about throughput
 * (bytes/sec), just the byte size of each individual frame.
 */
export function buildPayloadByteStats(sizes: number[]): PayloadByteStats {
  if (sizes.length === 0) {
    return {
      count: 0,
      totalBytes: 0,
      minBytes: null,
      maxBytes: null,
      avgBytes: null,
      p50Bytes: null,
    };
  }
  const sorted = sizes.slice().toSorted((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    totalBytes: sum,
    minBytes: sorted[0] ?? null,
    maxBytes: sorted[sorted.length - 1] ?? null,
    avgBytes: sum / sorted.length,
    p50Bytes: sorted[Math.floor(sorted.length * 0.5)] ?? null,
  };
}

function buildThroughputStats(samples: ThroughputSample[]): ThroughputDirectionStats {
  if (samples.length === 0) {
    return {
      samples,
      minBytesPerSec: null,
      p50BytesPerSec: null,
      p95BytesPerSec: null,
      avgBytesPerSec: null,
      peakBytesPerSec: null,
      count: 0,
    };
  }
  const sorted = samples.map((s) => s.bytesPerSec).toSorted((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    samples,
    minBytesPerSec: sorted[0] ?? null,
    p50BytesPerSec: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95BytesPerSec: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    avgBytesPerSec: sum / sorted.length,
    peakBytesPerSec: sorted[sorted.length - 1] ?? null,
    count: sorted.length,
  };
}

/**
 * Build LatencyStats from dedicated ping samples. Each ping sample is
 * RTT/2 of a single-clock round-trip in that direction (no clock-sync state,
 * no symmetry assumption between forward and reverse — each is its own
 * independent measurement). See `src/gateway/protocol/schema/ping.ts`.
 */
function computePingLatencyStats(
  source: "operator" | "node",
  direction: "forward" | "reverse",
): LatencyStats {
  const arr = pingSamples[source][direction];
  const samples: LatencySample[] = arr.map((s) => ({ ts: s.ts, latencyMs: s.oneWayMs }));
  return buildLatencyStats(samples);
}

function buildLatencyStats(samples: LatencySample[]): LatencyStats {
  if (samples.length === 0) {
    return {
      samples,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      avgMs: null,
      peakMs: null,
      count: 0,
    };
  }
  const sorted = samples.map((s) => s.latencyMs).toSorted((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    samples,
    minMs: sorted[0] ?? null,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    avgMs: Math.round(sum / sorted.length),
    peakMs: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

/**
 * Per-LLM-call state within a single agent run.
 *
 * An agent run (`runId`) contains multiple LLM inference calls separated by
 * tool use. The pattern within a run is:
 *
 *   lifecycle start
 *     assistant events (LLM call 1)
 *     tool start ... tool end
 *     assistant events (LLM call 2)   <- new call boundary
 *     tool start ... tool end
 *     assistant events (LLM call 3)
 *   lifecycle end
 *
 * We detect each LLM call boundary as "first assistant event after lifecycle
 * start or after the most recent tool-end". This gives us per-call TTFT
 * (time waiting for LLM) and per-call generation time (duration of the
 * assistant event burst).
 *
 * Persistent caches: latency samples are accumulated in module-level caches
 * so they survive trace buffer eviction (the UI keeps only the latest 500
 * traces). Each sample is keyed by its trace id to avoid duplicates on
 * recomputation.
 */
type RunLlmCallState = {
  /** Timestamp of the most recent call boundary (lifecycle start or tool end). */
  lastBoundaryTs: number;
  /** Whether a boundary has been observed (lifecycle start or tool end). */
  hasBoundary: boolean;
  /** Whether we are currently in an assistant burst. */
  inBurst: boolean;
  /** LLM call index within this run (for labeling). */
  callIndex: number;
};

type GenRunState = {
  burstStartTs: number | null;
  burstLastTs: number | null;
  /** Trace id of the last assistant event in the current burst. */
  burstLastId: string | null;
  callIndex: number;
  runId?: string;
};

// ---------------------------------------------------------------------------
// Persistent latency sample caches (survive trace buffer eviction)
//
// Key insight: `computeNetworkStats` re-scans the full trace buffer on every
// render.  With persistent run-state, re-processing old events would corrupt
// the state machine.  We track which trace IDs have already been processed
// and skip them on subsequent scans.
// ---------------------------------------------------------------------------

const ttftCache: LatencySample[] = [];
const ttftRunState = new Map<string, RunLlmCallState>();
const ttftProcessed = new Set<string>();

const genCache: LatencySample[] = [];
const genRunState = new Map<string, GenRunState>();
const genProcessed = new Set<string>();

// Reverse-direction (gateway → peer) rx-latency samples, fed by
// `handleProtocolRxSamplesEvent`. Per-source so we can chart the operator and
// node legs separately. Capped to bound memory under long uptime.
type RxLatencySampleEntry = {
  ts: number;
  latencyMs: number;
  method?: string;
  event?: string;
  /**
   * Serialized payload size of the received frame, computed by the receiver
   * at recv time. Lets the UI compute per-message gw→peer throughput as
   * `payloadSize / latencyMs * 1000` directly from the rx-sample, with no
   * trace lookup. Undefined for pre-upgrade peers.
   */
  payloadSize?: number;
};
const rxSamplesOperator: RxLatencySampleEntry[] = [];
const rxSamplesNode: RxLatencySampleEntry[] = [];
const RX_SAMPLE_CAP = 1000;

// Dedicated ping-protocol samples, fed by `handlePingMetricsEvent`. These are
// the source of truth for the protocol monitor's latency charts now (replaces
// the old sentAt-based computation that mixed mechanism + functional traffic).
type PingSampleEntry = { ts: number; oneWayMs: number };
const pingSamples = {
  operator: { forward: [] as PingSampleEntry[], reverse: [] as PingSampleEntry[] },
  node: { forward: [] as PingSampleEntry[], reverse: [] as PingSampleEntry[] },
};
const PING_SAMPLE_CAP = 1000;

// Compact per-direction message store for the Protocol Monitor's "Messages"
// section. Stores only {ts, size, type} per wire-pair message — far smaller
// than a full ProtocolTraceRecord — so it can hold ~10-30× more history than
// the shared 1000-entry trace buffer. Without this, assistant SSE deltas
// (one trace per parsed JSONL record from the streaming output, typically
// 70-95% of the buffer after even one moderate LLM turn) push out the
// less-frequent wire-pair frames like `req.node.invoke` long before the
// task completes, so card counts and bar history both decay over time.
//
// agent↔llm directions don't get a store here because they're not "wire"
// traffic and would be dominated by SSE deltas anyway; their throughput /
// latency / TTFT calculations still iterate `protocolTraces` directly.
type MessageEntry = { ts: number; size: number; type: string };
const MESSAGE_STORE_CAP = 3000;
const messageStore = {
  opGw: { forward: [] as MessageEntry[], reverse: [] as MessageEntry[] },
  nodeGw: { forward: [] as MessageEntry[], reverse: [] as MessageEntry[] },
};
// Trace ids already recorded into messageStore. Prevents double-counting when
// `loadProtocolTraces` runs after live events have already populated the store
// (e.g. on reconnect). Capped to twice the store size so it can't grow
// unboundedly during long sessions.
const recordedMessageIds = new Set<string>();
const RECORDED_MESSAGE_IDS_CAP = MESSAGE_STORE_CAP * 4;

function pushBoundedMessage(buf: MessageEntry[], entry: MessageEntry) {
  buf.push(entry);
  if (buf.length > MESSAGE_STORE_CAP) {
    buf.splice(0, buf.length - MESSAGE_STORE_CAP);
  }
}

/**
 * Record a single trace into `messageStore` if it belongs to a wire-pair
 * direction and isn't already recorded. No-op for non-wire pairs (agent↔llm).
 */
function recordMessageFromTrace(t: ProtocolTraceRecord): void {
  if (!t.id || recordedMessageIds.has(t.id)) {
    return;
  }
  if (isOperatorPairTrace(t) && !isShownInOperatorPair(t)) {
    return;
  }
  // Narrower blocklist than the full ingest filter — keep health/presence/
  // poll/heartbeat traces visible in the message-size bar chart, drop only
  // the self-referential measurement mechanism.
  if (isIngestBlocklisted(t, MESSAGES_SELF_REFERENTIAL_BLOCKLIST)) {
    return;
  }
  let buf: MessageEntry[] | null = null;
  if (t.source === "operator" && t.target === "gateway") {
    buf = messageStore.opGw.forward;
  } else if (t.source === "gateway" && t.target === "operator") {
    buf = messageStore.opGw.reverse;
  } else if (t.source === "node" && t.target === "gateway") {
    buf = messageStore.nodeGw.forward;
  } else if (t.source === "gateway" && t.target === "node") {
    buf = messageStore.nodeGw.reverse;
  }
  if (!buf) {
    return;
  }
  const type = resolveMessageType(t);
  if (!type) {
    return;
  }
  pushBoundedMessage(buf, { ts: t.ts, size: t.payloadSize ?? 0, type });
  recordedMessageIds.add(t.id);
  if (recordedMessageIds.size > RECORDED_MESSAGE_IDS_CAP) {
    // Cheap reset rather than a true LRU — worst case a few traces get
    // re-recorded once. Caller is idempotent on count via the set check
    // above and bounded buffer size, so duplicates would only show up if
    // both sides of the reset overlap with a re-load, which is rare.
    recordedMessageIds.clear();
  }
}

// ---------------------------------------------------------------------------
// LLM call store — agent|model monitor
// ---------------------------------------------------------------------------

/**
 * Per-LLM-call accumulator. Populated at trace ingest time so the agent|model
 * monitor's metrics survive SSE eviction from the shared trace ring buffer.
 *
 * IMPORTANT: keyed by the lifecycle `request`-event trace id, NOT by `runId`.
 * Each agent run uses ONE runId across all its LLM calls — the lifecycle
 * `start` event only fires once per agent run, while a fresh
 * `request` event fires for every individual LLM call (with the growing
 * conversation history as `requestSize`). So one runId can hold dozens of
 * calls; keying on runId would (and did) collapse them into a single entry
 * with bogus TTFT.
 *
 * `lastCallByRunId` lets SSE / tool / end events attribute back to the most
 * recently started call for that runId.
 */
const llmCallStore = new Map<string, LlmCall>();
const lastCallByRunId = new Map<string, string>();
const LLM_CALL_STORE_CAP = 500;
/** Trace ids already folded into a call entry (dedupe across re-loads). */
const recordedLlmCallTraceIds = new Set<string>();
const RECORDED_LLM_CALL_IDS_CAP = 4000;

function pickLlmCallModel(t: ProtocolTraceRecord): string | null {
  if (t.kind !== "event" || t.stream !== "lifecycle") {
    return null;
  }
  const p = t.payload as Record<string, unknown> | undefined;
  const data = p?.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : p;
  if (!data) {
    return null;
  }
  const candidate = data.model ?? data.activeModel ?? data.selectedModel;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

function trimLlmCallStoreIfNeeded() {
  if (llmCallStore.size <= LLM_CALL_STORE_CAP) {
    return;
  }
  // Drop the oldest by requestTs. Map iteration is insertion order, but the
  // store key is now per-call trace id (not requestTs), so we sort.
  const entries = Array.from(llmCallStore.entries()).toSorted(
    ([, a], [, b]) => a.requestTs - b.requestTs,
  );
  const toDrop = entries.length - LLM_CALL_STORE_CAP;
  for (let i = 0; i < toDrop; i++) {
    const entry = entries[i];
    if (entry) {
      llmCallStore.delete(entry[0]);
    }
  }
}

/**
 * Fold a single trace into the LlmCall store. Called once per trace at
 * ingest time (dedupe via recordedLlmCallTraceIds).
 *
 * Call-boundary semantics: each agent→llm lifecycle `request` event creates a
 * NEW LlmCall entry (keyed by that trace's id). The lifecycle `start` event
 * fires only once per agent run, so it can't be the call boundary. When a
 * new `request` arrives for a runId that already had an open call, the
 * previous call is implicitly finalized (responseComplete = true).
 *
 * SSE / tool / end events look up the most-recent call for their runId via
 * `lastCallByRunId` and accumulate onto it.
 */
function recordLlmCallFromTrace(t: ProtocolTraceRecord): void {
  if (!t.id || recordedLlmCallTraceIds.has(t.id) || !t.runId) {
    return;
  }
  const isAgentToLlm = t.source === "agent" && t.target === "llm";
  const isLlmToAgent = t.source === "llm" && t.target === "agent";
  const isToolStart =
    t.kind === "event" && t.stream === "tool" && resolvePhase(t.payload) === "start";

  // Each agent→llm lifecycle "request" = a brand-new LLM call.
  if (isAgentToLlm && t.kind === "event" && t.stream === "lifecycle") {
    const phase = resolvePhase(t.payload);
    if (phase === "request") {
      // Finalize the previous call for this runId, if any.
      const prevKey = lastCallByRunId.get(t.runId);
      const prev = prevKey ? llmCallStore.get(prevKey) : undefined;
      if (prev && !prev.responseComplete) {
        prev.responseComplete = true;
      }
      const callKey = t.id;
      llmCallStore.set(callKey, {
        runId: t.runId,
        model: pickLlmCallModel(t),
        requestTs: t.ts,
        requestBytes: t.payloadSize ?? 0,
        firstAssistantTs: null,
        lastAssistantTs: null,
        responseEventCount: 0,
        responseBytes: 0,
        minSseBytes: Number.POSITIVE_INFINITY,
        maxSseBytes: 0,
        toolCallCount: 0,
        responseComplete: false,
      });
      lastCallByRunId.set(t.runId, callKey);
      recordedLlmCallTraceIds.add(t.id);
      trimLlmCallStoreIfNeeded();
      return;
    }
    // phase="start" / other agent→llm lifecycle events — informational only.
    recordedLlmCallTraceIds.add(t.id);
    return;
  }

  // SSE / lifecycle-end from llm→agent attribute to the most recent call.
  if (isLlmToAgent) {
    const callKey = lastCallByRunId.get(t.runId);
    const call = callKey ? llmCallStore.get(callKey) : undefined;
    if (!call) {
      recordedLlmCallTraceIds.add(t.id);
      return;
    }
    if (t.kind === "event" && t.stream === "assistant") {
      if (call.firstAssistantTs === null) {
        call.firstAssistantTs = t.ts;
      }
      call.lastAssistantTs = t.ts;
      call.responseEventCount += 1;
      const size = t.payloadSize ?? 0;
      call.responseBytes += size;
      if (size > 0 && size < call.minSseBytes) {
        call.minSseBytes = size;
      }
      if (size > call.maxSseBytes) {
        call.maxSseBytes = size;
      }
      if (!call.model) {
        const m = pickLlmCallModel(t);
        if (m) {
          call.model = m;
        }
      }
      recordedLlmCallTraceIds.add(t.id);
      return;
    }
    if (t.kind === "event" && t.stream === "lifecycle") {
      const phase = resolvePhase(t.payload);
      if (phase === "end") {
        call.lastAssistantTs = Math.max(call.lastAssistantTs ?? 0, t.ts);
        call.responseComplete = true;
      }
      if (!call.model) {
        const m = pickLlmCallModel(t);
        if (m) {
          call.model = m;
        }
      }
      recordedLlmCallTraceIds.add(t.id);
      return;
    }
  }

  // Tool starts attribute to the most recent call for this runId.
  if (isToolStart) {
    const callKey = lastCallByRunId.get(t.runId);
    const call = callKey ? llmCallStore.get(callKey) : undefined;
    if (call) {
      call.toolCallCount += 1;
    }
    recordedLlmCallTraceIds.add(t.id);
    return;
  }

  if (recordedLlmCallTraceIds.size > RECORDED_LLM_CALL_IDS_CAP) {
    recordedLlmCallTraceIds.clear();
  }
}

// ---------------------------------------------------------------------------
// Agent|Model unified event store — backs the single bar chart
// ---------------------------------------------------------------------------

/**
 * Per-event store for the unified agent|model bar chart. Captures every
 * trace on the agent↔llm edge (plus tool events tagged with a runId) so the
 * chart can render every request, SSE delta, tool call, and complete event
 * as its own bar — independently of the shared trace ring buffer (which
 * fills up with SSE deltas and evicts older context fast).
 *
 * Store cap chosen for SSE-heavy sessions: 10000 entries × ~32 bytes per
 * entry ≈ 320 KB. A typical multi-call session generates 1k–5k SSE deltas;
 * cap at 10k gives plenty of headroom while still bounding memory.
 */
type AgentLlmEventEntry = AgentLlmEventBar;
const agentLlmEventStore: AgentLlmEventEntry[] = [];
const AGENT_LLM_EVENT_STORE_CAP = 10_000;
const recordedAgentLlmEventIds = new Set<string>();
const RECORDED_AGENT_LLM_EVENT_IDS_CAP = AGENT_LLM_EVENT_STORE_CAP * 4;

function pushAgentLlmEvent(entry: AgentLlmEventEntry) {
  agentLlmEventStore.push(entry);
  if (agentLlmEventStore.length > AGENT_LLM_EVENT_STORE_CAP) {
    agentLlmEventStore.splice(0, agentLlmEventStore.length - AGENT_LLM_EVENT_STORE_CAP);
  }
}

function pickToolName(t: ProtocolTraceRecord): string | null {
  const p = t.payload as Record<string, unknown> | undefined;
  const data = p?.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : p;
  if (!data) {
    return null;
  }
  const candidate = data.name ?? data.tool;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function categorizeAgentLlmEvent(t: ProtocolTraceRecord): AgentLlmEventCategory | null {
  const isAgentToLlm = t.source === "agent" && t.target === "llm";
  const isLlmToAgent = t.source === "llm" && t.target === "agent";
  const isAgentToolEdge = t.source === "agent" && t.target === "gateway" && t.stream === "tool";
  if (!isAgentToLlm && !isLlmToAgent && !isAgentToolEdge) {
    return null;
  }
  if (t.kind !== "event") {
    return null;
  }
  if (t.stream === "assistant") {
    return "sse";
  }
  if (t.stream === "lifecycle") {
    const phase = resolvePhase(t.payload);
    if (phase === "request") {
      return "request";
    }
    if (phase === "end") {
      return "complete";
    }
    return null; // lifecycle "start" is informational, doesn't get a bar
  }
  if (t.stream === "tool") {
    const phase = resolvePhase(t.payload);
    if (phase === "start") {
      return "tool-call";
    }
    if (phase === "result") {
      return "tool-result";
    }
    return null;
  }
  return "other";
}

function recordAgentLlmEventFromTrace(t: ProtocolTraceRecord): void {
  if (!t.id || recordedAgentLlmEventIds.has(t.id)) {
    return;
  }
  const category = categorizeAgentLlmEvent(t);
  if (!category) {
    return;
  }
  let detail: string | undefined;
  if (category === "request" || category === "complete") {
    const m = pickLlmCallModel(t);
    if (m) {
      detail = m;
    }
  } else if (category === "tool-call" || category === "tool-result") {
    const n = pickToolName(t);
    if (n) {
      detail = n;
    }
  }
  pushAgentLlmEvent({
    ts: t.ts,
    size: t.payloadSize ?? 0,
    category,
    detail,
  });
  recordedAgentLlmEventIds.add(t.id);
  if (recordedAgentLlmEventIds.size > RECORDED_AGENT_LLM_EVENT_IDS_CAP) {
    recordedAgentLlmEventIds.clear();
  }
}

const AGENT_LLM_CATEGORIES: AgentLlmEventCategory[] = [
  "request",
  "sse",
  "tool-call",
  "tool-result",
  "complete",
  "other",
];

function buildAgentLlmStats(): AgentLlmStats {
  const cardMap = new Map<AgentLlmEventCategory, AgentLlmEventCard>();
  for (const cat of AGENT_LLM_CATEGORIES) {
    cardMap.set(cat, {
      category: cat,
      count: 0,
      totalBytes: 0,
      minBytes: Number.POSITIVE_INFINITY,
      maxBytes: 0,
    });
  }
  let totalBytes = 0;
  for (const e of agentLlmEventStore) {
    const card = cardMap.get(e.category);
    if (!card) {
      continue;
    }
    card.count += 1;
    card.totalBytes += e.size;
    if (e.size > 0 && e.size < card.minBytes) {
      card.minBytes = e.size;
    }
    if (e.size > card.maxBytes) {
      card.maxBytes = e.size;
    }
    totalBytes += e.size;
  }
  const cards: AgentLlmEventCard[] = [];
  for (const cat of AGENT_LLM_CATEGORIES) {
    const c = cardMap.get(cat);
    if (!c || c.count === 0) {
      continue;
    }
    if (c.minBytes === Number.POSITIVE_INFINITY) {
      c.minBytes = 0;
    }
    cards.push(c);
  }

  // Per-call TTFT samples + per-call generation throughput. One sample per
  // LLM call: TTFT = firstAssistantTs − requestTs; throughput =
  // responseBytes / generationDurationMs * 1000 (only when the call streamed
  // ≥ 2 SSE events, so there's a measurable duration). callThroughput drives
  // the agent|model Throughput section's per-message-throughput stats.
  const ttftSamples: LatencySample[] = [];
  const callThroughputSamples: ThroughputSample[] = [];
  for (const call of llmCallStore.values()) {
    if (call.firstAssistantTs === null) {
      continue;
    }
    const ttftMs = call.firstAssistantTs - call.requestTs;
    if (ttftMs > 0) {
      ttftSamples.push({
        ts: call.requestTs,
        latencyMs: ttftMs,
        model: call.model ?? undefined,
      });
    }
    if (call.lastAssistantTs !== null && call.responseBytes > 0 && call.responseEventCount >= 2) {
      const genMs = call.lastAssistantTs - call.firstAssistantTs;
      if (genMs > 0) {
        callThroughputSamples.push({
          ts: call.requestTs,
          bytesPerSec: (call.responseBytes / genMs) * 1000,
          rawBytes: call.responseBytes,
        });
      }
    }
  }

  const eventSizes = agentLlmEventStore.map((e) => e.size).filter((s) => s > 0);

  return {
    ttft: buildLatencyStats(ttftSamples.toSorted((a, b) => a.ts - b.ts)),
    totalCalls: llmCallStore.size,
    totalEvents: agentLlmEventStore.length,
    totalBytes,
    cards,
    bars: agentLlmEventStore.slice().toSorted((a, b) => a.ts - b.ts),
    callThroughput: buildThroughputStats(callThroughputSamples.toSorted((a, b) => a.ts - b.ts)),
    eventByteStats: buildPayloadByteStats(eventSizes),
  };
}

/** Clear latency + network accumulators (called when user resets traces). */
export function clearLatencyCaches() {
  ttftCache.length = 0;
  ttftRunState.clear();
  ttftProcessed.clear();
  genCache.length = 0;
  genRunState.clear();
  genProcessed.clear();
  clearNetworkAccumulators();
}

export type LatencyCacheSnapshot = {
  ttft: LatencySample[];
  gen: LatencySample[];
  network?: NetworkCacheSnapshot;
};

export type NetworkCacheSnapshot = {
  totalBytesIn: number;
  totalBytesOut: number;
  operatorGateway: {
    combined: [number, number][];
    forward: [number, number][];
    reverse: [number, number][];
  };
  agentLlm: {
    combined: [number, number][];
    forward: [number, number][];
    reverse: [number, number][];
  };
  gatewayNode: {
    combined: [number, number][];
    forward: [number, number][];
    reverse: [number, number][];
  };
  requests: RequestAccumulatorState;
  responses: ResponseAccumulatorState;
  /** Trace ids already ingested, so rehydration does not double-count them. */
  processedIds: string[];
};

function snapshotRoute(r: RouteAccumulator) {
  return {
    combined: [...r.combined.entries()],
    forward: [...r.forward.entries()],
    reverse: [...r.reverse.entries()],
  };
}

function rehydrateRoute(
  r: RouteAccumulator,
  snap: { combined: [number, number][]; forward: [number, number][]; reverse: [number, number][] },
) {
  r.combined.clear();
  r.forward.clear();
  r.reverse.clear();
  for (const [ts, bytes] of snap.combined) {
    r.combined.set(ts, bytes);
  }
  for (const [ts, bytes] of snap.forward) {
    r.forward.set(ts, bytes);
  }
  for (const [ts, bytes] of snap.reverse) {
    r.reverse.set(ts, bytes);
  }
}

export function snapshotNetworkAccumulators(): NetworkCacheSnapshot {
  return {
    totalBytesIn: netState.totalBytesIn,
    totalBytesOut: netState.totalBytesOut,
    operatorGateway: snapshotRoute(netState.operatorGateway),
    agentLlm: snapshotRoute(netState.agentLlm),
    gatewayNode: snapshotRoute(netState.gatewayNode),
    requests: { ...netState.requests },
    responses: { ...netState.responses },
    processedIds: [...netProcessed],
  };
}

export function rehydrateNetworkAccumulators(snap: NetworkCacheSnapshot): void {
  clearNetworkAccumulators();
  netState.totalBytesIn = snap.totalBytesIn;
  netState.totalBytesOut = snap.totalBytesOut;
  rehydrateRoute(netState.operatorGateway, snap.operatorGateway);
  rehydrateRoute(netState.agentLlm, snap.agentLlm);
  rehydrateRoute(netState.gatewayNode, snap.gatewayNode);
  netState.requests = { ...snap.requests };
  netState.responses = { ...snap.responses };
  for (const id of snap.processedIds) {
    netProcessed.add(id);
  }
}

/**
 * Snapshot the persistent latency + network accumulators for export. The
 * in-flight run-state Maps are intentionally omitted: the exported viewer
 * does not feed new traces through the state machines.
 */
export function snapshotLatencyCaches(): LatencyCacheSnapshot {
  return {
    ttft: ttftCache.map((s) => ({ ...s })),
    gen: genCache.map((s) => ({ ...s })),
    network: snapshotNetworkAccumulators(),
  };
}

/**
 * Rehydrate the latency + network caches from a previously-taken snapshot.
 * Called once by the exported HTML viewer before first render so
 * `computeNetworkStats` reproduces the exact stats that were on screen at
 * export time.
 */
export function rehydrateLatencyCaches(snapshot: LatencyCacheSnapshot) {
  clearLatencyCaches();
  for (const s of snapshot.ttft) {
    ttftCache.push({ ...s });
  }
  for (const s of snapshot.gen) {
    genCache.push({ ...s });
  }
  if (snapshot.network) {
    rehydrateNetworkAccumulators(snapshot.network);
  }
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

export function coalesceTraces(traces: ProtocolTraceRecord[]): CoalescedEntry[] {
  const result: CoalescedEntry[] = [];
  let currentGroup: CoalescedGroup | null = null;

  for (const trace of traces) {
    const isAgentStream =
      trace.kind === "event" &&
      trace.event === "agent" &&
      trace.runId &&
      trace.stream === "assistant";

    if (isAgentStream) {
      if (currentGroup && currentGroup.runId === trace.runId) {
        currentGroup.events.push(trace);
        currentGroup.label = `LLM stream (${currentGroup.events.length} events)`;
      } else {
        if (currentGroup) {
          result.push(currentGroup);
        }
        currentGroup = {
          type: "group",
          id: `group-${trace.id}`,
          ts: trace.ts,
          source: trace.source,
          target: trace.target,
          runId: trace.runId!,
          events: [trace],
          label: "LLM stream (1 event)",
        };
      }
    } else {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(trace);
    }
  }
  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

// ---------------------------------------------------------------------------
// State interface
// ---------------------------------------------------------------------------

export type ProtocolMonitorHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  protocolTraces: ProtocolTraceRecord[];
  protocolMonitorLoading: boolean;
  protocolSelectedTrace: ProtocolTraceRecord | CoalescedGroup | null;
  protocolAutoScroll: boolean;
  protocolDisabledTypes: Set<string>;
  protocolMonitoringPaused: boolean;
  /**
   * Reactive counter bumped by handlers that update module-level controller
   * state (ping samples, rx samples) so Lit re-renders the protocol monitor
   * even when no functional trace traffic is flowing. Without this the chart
   * sticks at "Waiting for data..." indefinitely on an idle gateway because
   * the only state update comes from non-reactive module variables.
   */
  protocolControllerStateVersion: number;
};

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function filterTraces(
  traces: ProtocolTraceRecord[],
  disabledTypes: Set<string>,
): ProtocolTraceRecord[] {
  if (disabledTypes.size === 0) {
    return traces;
  }
  return traces.filter((t) => !disabledTypes.has(traceTypeKey(t)));
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 1000;

export async function loadProtocolTraces(host: ProtocolMonitorHost) {
  if (!host.client || !host.connected) {
    return;
  }
  host.protocolMonitorLoading = true;
  try {
    const res = await host.client.request<{ traces: ProtocolTraceRecord[] }>(
      "protocol-traces.list",
      { limit: MAX_VISIBLE },
    );
    const incoming = res.traces ?? [];
    const filtered = incoming.filter((t) => !isIngestBlocklisted(t));
    host.protocolTraces = filtered;
    // Seed the per-direction Messages store and the agent|model LlmCall
    // store from the bulk batch. The live event handler will continue to
    // add new traces — both stores dedupe by trace id so a reconnect-driven
    // re-load doesn't double-count.
    //
    // Messages store sees the un-filtered batch (it has its own narrower
    // self-referential blocklist) so the message-size bar chart can show
    // health/presence/poll traffic that the trace ring buffer drops. LLM
    // stores only act on agent↔llm edges, which the wider filter doesn't
    // intersect, so feeding them `filtered` is fine.
    for (const t of incoming) {
      recordMessageFromTrace(t);
    }
    for (const t of filtered) {
      recordLlmCallFromTrace(t);
      recordAgentLlmEventFromTrace(t);
    }
  } catch {
    // ignore
  } finally {
    host.protocolMonitorLoading = false;
  }
}

export function handleProtocolTraceEvent(host: ProtocolMonitorHost, payload: unknown) {
  if (host.protocolMonitoringPaused) {
    return;
  }
  if (!payload || typeof payload !== "object") {
    return;
  }
  const record = payload as ProtocolTraceRecord;
  if (record.event === "protocol.trace") {
    return;
  }
  // Record into the messages store BEFORE the trace-buffer blocklist so the
  // message-size bar chart sees the wider set (health, presence, polls,
  // heartbeats etc.). recordMessageFromTrace applies its own narrower
  // self-referential filter.
  recordMessageFromTrace(record);
  if (isIngestBlocklisted(record)) {
    return;
  }
  const next = [...host.protocolTraces, record];
  host.protocolTraces = next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
  recordLlmCallFromTrace(record);
  recordAgentLlmEventFromTrace(record);
}

/**
 * Append a batch of dedicated-ping samples to the per-source per-direction
 * sliding window. Fed by the gateway's `ping.metrics` broadcast event.
 */
export function handlePingMetricsEvent(host: ProtocolMonitorHost, payload: unknown) {
  if (host.protocolMonitoringPaused) {
    return;
  }
  if (!payload || typeof payload !== "object") {
    return;
  }
  const data = payload as {
    source?: unknown;
    direction?: unknown;
    samples?: unknown;
  };
  if (data.source !== "operator" && data.source !== "node") {
    return;
  }
  if (data.direction !== "forward" && data.direction !== "reverse") {
    return;
  }
  if (!Array.isArray(data.samples)) {
    return;
  }
  const target = pingSamples[data.source][data.direction];
  for (const raw of data.samples) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const s = raw as { ts?: unknown; oneWayMs?: unknown };
    if (typeof s.ts !== "number" || typeof s.oneWayMs !== "number") {
      continue;
    }
    target.push({ ts: s.ts, oneWayMs: s.oneWayMs });
  }
  if (target.length > PING_SAMPLE_CAP) {
    target.splice(0, target.length - PING_SAMPLE_CAP);
  }
  // Bump reactive version so Lit re-renders the protocol monitor view; the
  // ping samples themselves live in module state that Lit can't observe.
  host.protocolControllerStateVersion = (host.protocolControllerStateVersion ?? 0) + 1;
}

/**
 * Append a peer-reported rx-latency batch to the per-source sliding window.
 * Called from the WS event dispatcher when `protocol.rx.samples` arrives.
 * Filtering by task-relevance happens at compute time (`computeRxLatencyStats`)
 * so the buffer remains a faithful record we can re-query if the filter
 * changes later.
 */
export function handleProtocolRxSamplesEvent(host: ProtocolMonitorHost, payload: unknown) {
  if (host.protocolMonitoringPaused) {
    return;
  }
  if (!payload || typeof payload !== "object") {
    return;
  }
  const data = payload as {
    source?: unknown;
    client?: unknown;
    samples?: unknown;
  };
  if (data.source !== "operator" && data.source !== "node") {
    return;
  }
  if (!Array.isArray(data.samples)) {
    return;
  }
  // Operator-pair monitor is scoped to actual Control UI traffic. Drop
  // batches reported by other operator-role connections (agent CLI, TUI,
  // etc.). Pre-upgrade gateways don't stamp `client` — let those through.
  if (
    data.source === "operator" &&
    typeof data.client === "string" &&
    data.client !== GATEWAY_CLIENT_IDS.CONTROL_UI
  ) {
    return;
  }
  const target = data.source === "operator" ? rxSamplesOperator : rxSamplesNode;
  for (const raw of data.samples) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const s = raw as {
      ts?: unknown;
      latencyMs?: unknown;
      method?: unknown;
      event?: unknown;
      payloadSize?: unknown;
    };
    if (typeof s.ts !== "number" || typeof s.latencyMs !== "number") {
      continue;
    }
    target.push({
      ts: s.ts,
      latencyMs: s.latencyMs,
      method: typeof s.method === "string" ? s.method : undefined,
      event: typeof s.event === "string" ? s.event : undefined,
      payloadSize: typeof s.payloadSize === "number" ? s.payloadSize : undefined,
    });
  }
  if (target.length > RX_SAMPLE_CAP) {
    target.splice(0, target.length - RX_SAMPLE_CAP);
  }
}

export async function clearProtocolTraces(host: ProtocolMonitorHost) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    await host.client.request("protocol-traces.clear");
    host.protocolTraces = [];
    rxSamplesOperator.length = 0;
    rxSamplesNode.length = 0;
    pingSamples.operator.forward.length = 0;
    pingSamples.operator.reverse.length = 0;
    pingSamples.node.forward.length = 0;
    pingSamples.node.reverse.length = 0;
    messageStore.opGw.forward.length = 0;
    messageStore.opGw.reverse.length = 0;
    messageStore.nodeGw.forward.length = 0;
    messageStore.nodeGw.reverse.length = 0;
    recordedMessageIds.clear();
    llmCallStore.clear();
    lastCallByRunId.clear();
    recordedLlmCallTraceIds.clear();
    agentLlmEventStore.length = 0;
    recordedAgentLlmEventIds.clear();
    host.protocolSelectedTrace = null;
    clearLatencyCaches();
  } catch {
    // ignore
  }
}

/**
 * Destructive reset for the Protocol Monitor page. In addition to
 * `clearProtocolTraces`, this asks the gateway to unlink every session
 * transcript file on disk, then clears the locally-cached usage result so the
 * "Usage Overview" metrics zero out. Session transcripts are persistent agent
 * memory — the user is warned with exact counts from a dry-run before anything
 * is touched.
 *
 * Host type is widened so we can also clear the two cached usage fields that
 * back the usage overview cards.
 */
export async function purgeAllProtocolMonitorState(
  host: ProtocolMonitorHost & {
    usageResult: unknown;
    usageCostSummary: unknown;
  },
): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }

  // Step 1: dry-run for counts so the confirm is specific, not generic.
  type PurgeResult = { dryRun: boolean; fileCount: number; byteCount: number; agentIds: string[] };
  let plan: PurgeResult;
  try {
    plan = await host.client.request<PurgeResult>("sessions.purge", { dryRun: true });
  } catch {
    // Older gateway that doesn't understand sessions.purge — fall back to
    // the non-destructive reset rather than leave the button broken.
    if (
      confirm(
        "This gateway is too old to purge session transcripts from disk. " +
          "Clear only the in-memory traces and local metrics cache?",
      )
    ) {
      await clearProtocolTraces(host);
      host.usageResult = null;
      host.usageCostSummary = null;
    }
    return;
  }

  const mib = plan.byteCount / (1024 * 1024);
  const agentsDesc =
    plan.agentIds.length === 0
      ? "no agents"
      : plan.agentIds.length === 1
        ? `agent "${plan.agentIds[0]}"`
        : `${plan.agentIds.length} agents (${plan.agentIds.toSorted().join(", ")})`;
  const sizeDesc = mib >= 0.05 ? `${mib.toFixed(1)} MiB` : `${plan.byteCount} bytes`;

  const confirmed = confirm(
    `Reset protocol monitor and permanently delete session data?\n\n` +
      `• ${plan.fileCount} session transcript file(s) across ${agentsDesc}\n` +
      `• ~${sizeDesc} on disk\n` +
      `• The gateway's in-memory protocol trace buffer\n` +
      `• Persistent latency caches in this browser\n\n` +
      `Session transcripts are the agents' actual conversation history — this ` +
      `cannot be undone and agents currently mid-turn may lose context. ` +
      `Continue?`,
  );
  if (!confirmed) {
    return;
  }

  // Step 2: live purge. Run sequentially so trace buffer clear happens even if
  // sessions.purge fails; the user asked for a complete reset.
  try {
    await host.client.request<PurgeResult>("sessions.purge", {});
  } catch {
    // Fall through — we still want the rest of the reset to happen so at
    // least the UI matches what the gateway would hand us on next refresh.
  }
  await clearProtocolTraces(host);
  host.usageResult = null;
  host.usageCostSummary = null;
}
