import type { GatewayBrowserClient } from "../gateway.ts";

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

export type NetworkStats = {
  totalBytesIn: number;
  totalBytesOut: number;
  operatorGateway: DirectionalThroughputSamples;
  agentLlm: DirectionalThroughputSamples;
  gatewayNode: DirectionalThroughputSamples;
  /** Agent-LLM TTFT latency samples (one per LLM call). */
  agentLlmTtft: LatencyStats;
  /** Agent-LLM full generation latency samples (one per LLM call). */
  agentLlmGeneration: LatencyStats;
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
  /** Agent → Model request (lifecycle start) rollup. */
  requestStats: RequestStats;
  /** Model → Agent SSE response rollup. */
  responseStats: ResponseStats;
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
    addBucket(netState.operatorGateway.combined, bucket, size);
    addBucket(netState.operatorGateway.forward, bucket, size);
  } else if (src === "gateway" && tgt === "operator") {
    addBucket(netState.operatorGateway.combined, bucket, size);
    addBucket(netState.operatorGateway.reverse, bucket, size);
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

function buildRequestStats(): RequestStats {
  const { total, peakSize, totalSize, latestTs, latestSize } = netState.requests;
  return {
    total,
    peakPayloadSize: peakSize,
    avgPayloadSize: total > 0 ? Math.round(totalSize / total) : 0,
    latestTs,
    latestPayloadSize: latestSize,
  };
}

function buildResponseStats(): ResponseStats {
  const { total, peakSize, totalSize, firstTs, lastTs } = netState.responses;
  const hasSpan = firstTs !== null && lastTs !== null && lastTs > firstTs;
  return {
    totalEvents: total,
    avgEventsPerSec: hasSpan ? total / ((lastTs - firstTs) / 1000) : null,
    peakPayloadSize: peakSize,
    avgPayloadSize: total > 0 ? Math.round(totalSize / total) : 0,
  };
}

export function computeNetworkStats(
  traces: ProtocolTraceRecord[],
  modelFilter?: string | null,
  runModelMap?: Map<string, string>,
): NetworkStats {
  for (const t of traces) {
    ingestIntoNetwork(t);
  }
  trimNetProcessed();

  return {
    totalBytesIn: netState.totalBytesIn,
    totalBytesOut: netState.totalBytesOut,
    operatorGateway: routeToDirectional(netState.operatorGateway),
    agentLlm: routeToDirectional(netState.agentLlm),
    gatewayNode: routeToDirectional(netState.gatewayNode),
    agentLlmTtft: filterLatencyByModel(computeAgentLlmTtft(traces, runModelMap), modelFilter),
    agentLlmGeneration: filterLatencyByModel(
      computeAgentLlmGeneration(traces, runModelMap),
      modelFilter,
    ),
    // Latency now sources from dedicated 5s pings (RTT/2 in each direction)
    // instead of mining functional-message sentAt. See ping.ts for design.
    operatorGatewayOneWayLatency: computePingLatencyStats("operator", "forward"),
    gatewayOperatorOneWayLatency: computePingLatencyStats("operator", "reverse"),
    nodeGatewayOneWayLatency: computePingLatencyStats("node", "forward"),
    gatewayNodeOneWayLatency: computePingLatencyStats("node", "reverse"),
    requestStats: buildRequestStats(),
    responseStats: buildResponseStats(),
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
type RxLatencySampleEntry = { ts: number; latencyMs: number; method?: string; event?: string };
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

/** Max cached samples / processed-id set size. */
const MAX_LATENCY_CACHE = 2000;

function trimLatencyCache(cache: LatencySample[]) {
  if (cache.length > MAX_LATENCY_CACHE) {
    cache.splice(0, cache.length - MAX_LATENCY_CACHE);
  }
}

function trimProcessedSet(processed: Set<string>) {
  if (processed.size > MAX_LATENCY_CACHE * 4) {
    // Keep the set from growing unboundedly; clear and let it refill
    // (worst case: a few traces get re-processed once)
    processed.clear();
  }
}

/**
 * Agent-LLM TTFT: per-LLM-call time from the call boundary (lifecycle start
 * or tool end) to the first assistant stream event.
 *
 * Uses a persistent cache so samples survive trace buffer eviction.
 * Only processes traces not yet seen (by trace id).
 */
function computeAgentLlmTtft(
  traces: ProtocolTraceRecord[],
  runModelMap?: Map<string, string>,
): LatencyStats {
  for (const t of traces) {
    if (ttftProcessed.has(t.id)) {
      continue;
    }
    ttftProcessed.add(t.id);

    if (!t.runId || t.kind !== "event") {
      continue;
    }

    // Lifecycle start: begin/reset tracking this run
    if (t.stream === "lifecycle" && resolvePhase(t.payload) === "start") {
      ttftRunState.set(t.runId, {
        lastBoundaryTs: t.ts,
        hasBoundary: true,
        inBurst: false,
        callIndex: 0,
      });
      continue;
    }

    // Tool end/result: marks a new call boundary
    if (t.stream === "tool") {
      const phase = resolvePhase(t.payload);
      if (phase === "end" || phase === "result") {
        let state = ttftRunState.get(t.runId);
        if (!state) {
          state = { lastBoundaryTs: t.ts, hasBoundary: true, inBurst: false, callIndex: 0 };
          ttftRunState.set(t.runId, state);
        } else {
          state.lastBoundaryTs = t.ts;
          state.hasBoundary = true;
          state.inBurst = false;
        }
      }
      continue;
    }

    // First assistant event after a boundary = TTFT for this LLM call
    if (t.stream === "assistant") {
      let state = ttftRunState.get(t.runId);
      if (!state) {
        // No boundary seen (evicted); bootstrap but can't compute TTFT
        state = { lastBoundaryTs: t.ts, hasBoundary: false, inBurst: true, callIndex: 0 };
        ttftRunState.set(t.runId, state);
        continue;
      }

      if (!state.inBurst && state.hasBoundary) {
        state.callIndex++;
        state.inBurst = true;
        const ttft = t.ts - state.lastBoundaryTs;
        if (ttft > 0) {
          ttftCache.push({
            ts: t.ts,
            latencyMs: ttft,
            label: `TTFT #${state.callIndex}`,
            model: t.runId ? runModelMap?.get(t.runId) : undefined,
          });
        }
      } else if (!state.inBurst) {
        state.inBurst = true;
      }
      continue;
    }

    // Lifecycle end: clean up
    if (t.stream === "lifecycle") {
      const phase = resolvePhase(t.payload);
      if (phase === "end" || phase === "complete" || phase === "error") {
        ttftRunState.delete(t.runId);
      }
    }
  }
  trimLatencyCache(ttftCache);
  trimProcessedSet(ttftProcessed);
  return buildLatencyStats(ttftCache);
}

/**
 * Agent-LLM generation latency: per-LLM-call duration of each assistant
 * event burst (first assistant event to last assistant event before the next
 * tool call or lifecycle end).
 *
 * Uses a persistent cache so samples survive trace buffer eviction.
 * Only processes traces not yet seen (by trace id).
 */
function computeAgentLlmGeneration(
  traces: ProtocolTraceRecord[],
  runModelMap?: Map<string, string>,
): LatencyStats {
  const flushBurst = (state: GenRunState) => {
    if (state.burstStartTs !== null && state.burstLastTs !== null) {
      const duration = state.burstLastTs - state.burstStartTs;
      if (duration > 0) {
        genCache.push({
          ts: state.burstLastTs,
          latencyMs: duration,
          label: `gen #${state.callIndex}`,
          model: state.runId ? runModelMap?.get(state.runId) : undefined,
        });
      }
    }
  };

  const initGenState = (runId?: string): GenRunState => ({
    burstStartTs: null,
    burstLastTs: null,
    burstLastId: null,
    callIndex: 0,
    runId,
  });

  for (const t of traces) {
    if (genProcessed.has(t.id)) {
      continue;
    }
    genProcessed.add(t.id);

    if (!t.runId || t.kind !== "event") {
      continue;
    }

    // Lifecycle start: begin tracking
    if (t.stream === "lifecycle" && resolvePhase(t.payload) === "start") {
      genRunState.set(t.runId, initGenState(t.runId));
      continue;
    }

    // Assistant event: track burst
    if (t.stream === "assistant") {
      let state = genRunState.get(t.runId);
      if (!state) {
        state = initGenState(t.runId);
        genRunState.set(t.runId, state);
      }
      if (state.burstStartTs === null) {
        state.callIndex++;
        state.burstStartTs = t.ts;
      }
      state.burstLastTs = t.ts;
      state.burstLastId = t.id;
      continue;
    }

    // Tool event or lifecycle end: flush current burst
    if (t.stream === "tool" || t.stream === "lifecycle") {
      const state = genRunState.get(t.runId);
      if (state) {
        flushBurst(state);
        state.burstStartTs = null;
        state.burstLastTs = null;
        state.burstLastId = null;
      }

      if (t.stream === "lifecycle") {
        const phase = resolvePhase(t.payload);
        if (phase === "end" || phase === "complete" || phase === "error") {
          if (state) {
            flushBurst(state);
          }
          genRunState.delete(t.runId);
        }
      }
    }
  }

  // Show in-progress burst as live (not persisted until complete)
  const liveExtras: LatencySample[] = [];
  for (const state of genRunState.values()) {
    if (state.burstStartTs !== null && state.burstLastTs !== null) {
      const duration = state.burstLastTs - state.burstStartTs;
      if (duration > 0) {
        liveExtras.push({
          ts: state.burstLastTs,
          latencyMs: duration,
          label: `gen #${state.callIndex} (live)`,
          model: state.runId ? runModelMap?.get(state.runId) : undefined,
        });
      }
    }
  }

  trimLatencyCache(genCache);
  trimProcessedSet(genProcessed);
  return buildLatencyStats([...genCache, ...liveExtras]);
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
    host.protocolTraces = incoming.filter((t) => !isIngestBlocklisted(t));
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
  if (isIngestBlocklisted(record)) {
    return;
  }
  const next = [...host.protocolTraces, record];
  host.protocolTraces = next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
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
    samples?: unknown;
  };
  if (data.source !== "operator" && data.source !== "node") {
    return;
  }
  if (!Array.isArray(data.samples)) {
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
    };
    if (typeof s.ts !== "number" || typeof s.latencyMs !== "number") {
      continue;
    }
    target.push({
      ts: s.ts,
      latencyMs: s.latencyMs,
      method: typeof s.method === "string" ? s.method : undefined,
      event: typeof s.event === "string" ? s.event : undefined,
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
