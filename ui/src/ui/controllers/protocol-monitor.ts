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
};

export type LatencyStats = {
  samples: LatencySample[];
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
  peakMs: number | null;
  count: number;
};

export type NetworkStats = {
  totalBytesIn: number;
  totalBytesOut: number;
  operatorGateway: ThroughputSample[];
  agentLlm: ThroughputSample[];
  gatewayNode: ThroughputSample[];
  /** Agent-LLM TTFT latency samples (one per LLM call). */
  agentLlmTtft: LatencyStats;
  /** Agent-LLM full generation latency samples (one per LLM call). */
  agentLlmGeneration: LatencyStats;
  /** Gateway-Node request-response latency samples. */
  gatewayNodeLatency: LatencyStats;
};

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

export function computeNetworkStats(traces: ProtocolTraceRecord[]): NetworkStats {
  let totalBytesIn = 0;
  let totalBytesOut = 0;

  const ogBuckets = new Map<number, number>();
  const alBuckets = new Map<number, number>();
  const gnBuckets = new Map<number, number>();

  for (const t of traces) {
    const size = t.payloadSize ?? 0;
    if (t.direction === "in") {
      totalBytesIn += size;
    } else {
      totalBytesOut += size;
    }

    const bucket = Math.floor(t.ts / THROUGHPUT_BUCKET_MS) * THROUGHPUT_BUCKET_MS;
    const src = t.source;
    const tgt = t.target;

    if ((src === "operator" && tgt === "gateway") || (src === "gateway" && tgt === "operator")) {
      ogBuckets.set(bucket, (ogBuckets.get(bucket) ?? 0) + size);
    }
    if ((src === "agent" && tgt === "llm") || (src === "llm" && tgt === "agent")) {
      alBuckets.set(bucket, (alBuckets.get(bucket) ?? 0) + size);
    }
    if ((src === "gateway" && tgt === "node") || (src === "node" && tgt === "gateway")) {
      gnBuckets.set(bucket, (gnBuckets.get(bucket) ?? 0) + size);
    }
  }

  const toSamples = (buckets: Map<number, number>): ThroughputSample[] =>
    [...buckets.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([ts, bytes]) => ({
        ts,
        bytesPerSec: (bytes / THROUGHPUT_BUCKET_MS) * 1000,
        rawBytes: bytes,
      }));

  return {
    totalBytesIn,
    totalBytesOut,
    operatorGateway: toSamples(ogBuckets),
    agentLlm: toSamples(alBuckets),
    gatewayNode: toSamples(gnBuckets),
    agentLlmTtft: computeAgentLlmTtft(traces),
    agentLlmGeneration: computeAgentLlmGeneration(traces),
    gatewayNodeLatency: computeGatewayNodeLatency(traces),
  };
}

// ---------------------------------------------------------------------------
// Latency computation helpers
// ---------------------------------------------------------------------------

function buildLatencyStats(samples: LatencySample[]): LatencyStats {
  if (samples.length === 0) {
    return { samples, p50Ms: null, p95Ms: null, avgMs: null, peakMs: null, count: 0 };
  }
  const sorted = samples.map((s) => s.latencyMs).toSorted((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    samples,
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
function computeAgentLlmTtft(traces: ProtocolTraceRecord[]): LatencyStats {
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

    // Tool end: marks a new call boundary
    if (t.stream === "tool" && resolvePhase(t.payload) === "end") {
      let state = ttftRunState.get(t.runId);
      if (!state) {
        state = { lastBoundaryTs: t.ts, hasBoundary: true, inBurst: false, callIndex: 0 };
        ttftRunState.set(t.runId, state);
      } else {
        state.lastBoundaryTs = t.ts;
        state.hasBoundary = true;
        state.inBurst = false;
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
function computeAgentLlmGeneration(traces: ProtocolTraceRecord[]): LatencyStats {
  const flushBurst = (state: GenRunState) => {
    if (state.burstStartTs !== null && state.burstLastTs !== null) {
      const duration = state.burstLastTs - state.burstStartTs;
      if (duration > 0) {
        genCache.push({
          ts: state.burstLastTs,
          latencyMs: duration,
          label: `gen #${state.callIndex}`,
        });
      }
    }
  };

  const initGenState = (): GenRunState => ({
    burstStartTs: null,
    burstLastTs: null,
    burstLastId: null,
    callIndex: 0,
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
      genRunState.set(t.runId, initGenState());
      continue;
    }

    // Assistant event: track burst
    if (t.stream === "assistant") {
      let state = genRunState.get(t.runId);
      if (!state) {
        state = initGenState();
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
        });
      }
    }
  }

  trimLatencyCache(genCache);
  trimProcessedSet(genProcessed);
  return buildLatencyStats([...genCache, ...liveExtras]);
}

/** Clear latency caches (called when user resets traces). */
export function clearLatencyCaches() {
  ttftCache.length = 0;
  ttftRunState.clear();
  ttftProcessed.clear();
  genCache.length = 0;
  genRunState.clear();
  genProcessed.clear();
}

const STALE_REQUEST_MS = 60_000;

/**
 * Gateway-Node latency: match req (node→gateway) to res (gateway→node)
 * by connId + reqId (the protocol-level request id).
 *
 * Direction note: node sends a request *to* the gateway (source=node,
 * target=gateway, kind=req) and the gateway replies (source=gateway,
 * target=node, kind=res). The latency measures gateway processing time
 * for that RPC. We also capture the reverse direction (gateway→node req
 * answered by node→gateway res) when it occurs.
 */
function computeGatewayNodeLatency(traces: ProtocolTraceRecord[]): LatencyStats {
  const inflight = new Map<string, { ts: number; method?: string }>();
  const samples: LatencySample[] = [];

  for (const t of traces) {
    const isGatewayNode =
      (t.source === "gateway" && t.target === "node") ||
      (t.source === "node" && t.target === "gateway");
    if (!isGatewayNode || t.reqId === undefined) {
      continue;
    }

    const key = `${t.connId ?? ""}:${t.reqId}`;

    if (t.kind === "req") {
      inflight.set(key, { ts: t.ts, method: t.method });
    } else if (t.kind === "res") {
      const req = inflight.get(key);
      if (req) {
        samples.push({ ts: t.ts, latencyMs: t.ts - req.ts, label: req.method });
        inflight.delete(key);
      }
    }
  }

  // Expire stale entries (avoid unbounded growth across recomputations)
  const now = Date.now();
  for (const [key, req] of inflight) {
    if (now - req.ts > STALE_REQUEST_MS) {
      inflight.delete(key);
    }
  }

  return buildLatencyStats(samples);
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

const MAX_VISIBLE = 5000;

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
    host.protocolTraces = res.traces ?? [];
  } catch {
    // ignore
  } finally {
    host.protocolMonitorLoading = false;
  }
}

export function handleProtocolTraceEvent(host: ProtocolMonitorHost, payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const record = payload as ProtocolTraceRecord;
  if (record.event === "protocol.trace") {
    return;
  }
  const next = [...host.protocolTraces, record];
  host.protocolTraces = next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
}

export async function clearProtocolTraces(host: ProtocolMonitorHost) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    await host.client.request("protocol-traces.clear");
    host.protocolTraces = [];
    host.protocolSelectedTrace = null;
    clearLatencyCaches();
  } catch {
    // ignore
  }
}

export function exportProtocolTraces(host: ProtocolMonitorHost) {
  const wsUrl = (host as Record<string, unknown>).settings as { gatewayUrl?: string } | undefined;
  const gwUrl = wsUrl?.gatewayUrl;
  let base = "";
  if (gwUrl) {
    try {
      const u = new URL(gwUrl);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      base = u.origin;
    } catch {
      // fall through to same-origin
    }
  }
  const a = document.createElement("a");
  a.href = `${base}/protocol-traces/export`;
  a.download = "";
  a.click();
}
