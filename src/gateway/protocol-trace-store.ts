import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveStateDir } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Singleton access -- used by HTTP handler and WS methods
// ---------------------------------------------------------------------------

let globalTraceStore: ProtocolTraceStore | null = null;

export function getProtocolTraceStore(): ProtocolTraceStore | null {
  return globalTraceStore;
}

export function setProtocolTraceStore(store: ProtocolTraceStore): void {
  globalTraceStore = store;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TraceEntity = "operator" | "gateway" | "node" | "agent" | "llm";
export type TraceKind = "req" | "res" | "event";

export type ProtocolTraceRecord = {
  id: string;
  ts: number;
  direction: "in" | "out";
  kind: TraceKind;
  source: TraceEntity;
  target: TraceEntity;
  method?: string;
  event?: string;
  connId?: string;
  role?: string;
  /**
   * Stable client identifier from the connect frame (e.g. `openclaw-control-ui`,
   * `cli`, `openclaw-tui`, …). Lets the UI distinguish traffic from the actual
   * Control UI vs other operator-role connections (agent CLI subprocesses,
   * TUI, mobile apps) that all share `role: "operator"`. Set on req/res frames
   * where the connection's client info is known; outbound broadcast events
   * leave it undefined.
   */
  client?: string;
  /** Connect-frame `client.mode` (ui/cli/backend/webchat/…) for the same use. */
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
   * One-way wire latency in milliseconds. Set only on inbound traces whose
   * frame envelope carried a `sentAt` from the sender. Computed as
   * `Date.now() - sentAt` at capture time. Assumes peers' clocks are synced.
   */
  oneWayLatencyMs?: number;
};

export type TraceBroadcastFn = (record: ProtocolTraceRecord) => void;

/** A single peer-reported gateway → peer rx-latency sample. */
export type RxLatencySample = {
  /** Peer's receive time, shifted into the gateway's clock frame. */
  ts: number;
  /** Peer-measured one-way latency (gateway send → peer recv) in milliseconds. */
  latencyMs: number;
  kind?: string;
  method?: string;
  event?: string;
};

export type RxSamplesBroadcastFn = (info: {
  source: "operator" | "node";
  connId?: string;
  /** Client id of the reporting peer (e.g. `openclaw-control-ui`, `cli`). */
  client?: string;
  samples: RxLatencySample[];
}) => void;

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

const AGENT_EVENTS = new Set(["agent", "chat", "session.message", "session.tool"]);

function resolveEntities(
  direction: "in" | "out",
  kind: string,
  meta: Record<string, unknown>,
): { source: TraceEntity; target: TraceEntity } {
  const role = meta.role as string | undefined;

  if (kind === "req" && direction === "in") {
    return {
      source: role === "node" ? "node" : "operator",
      target: "gateway",
    };
  }

  if (kind === "res" && direction === "out") {
    return {
      source: "gateway",
      target: role === "node" ? "node" : "operator",
    };
  }

  // Events (direction === "out")
  const eventName = meta.event as string | undefined;
  // Frames pushed directly to a node (role=node) ride the gateway→node edge.
  // Agent-stream events keep their logical agent↔llm routing below; everything
  // else for a node (node.invoke.request, session.* control events, etc.) is
  // tagged as gateway→node so throughput reflects the real wire traffic.
  if (role === "node" && (!eventName || !AGENT_EVENTS.has(eventName))) {
    return { source: "gateway", target: "node" };
  }
  if (eventName && AGENT_EVENTS.has(eventName)) {
    const stream = meta.stream as string | undefined;
    const data =
      meta.payload && typeof meta.payload === "object"
        ? (meta.payload as Record<string, unknown>)
        : undefined;
    // LLM response streaming back to agent
    if (stream === "assistant") {
      return { source: "llm", target: "agent" };
    }
    // Agent invoking a tool (agent-side action)
    if (stream === "tool") {
      return { source: "agent", target: "gateway" };
    }
    // Lifecycle: start/request = agent calling LLM, end = LLM done
    if (stream === "lifecycle") {
      // Phase can be at data.phase (flattened by summarize) or data.data.phase (nested AgentEventPayload)
      const nestedData =
        data?.data && typeof data.data === "object"
          ? (data.data as Record<string, unknown>)
          : undefined;
      const phase =
        typeof data?.phase === "string"
          ? data.phase
          : typeof nestedData?.phase === "string"
            ? nestedData.phase
            : undefined;
      if (phase === "start" || phase === "request") {
        return { source: "agent", target: "llm" };
      }
      if (phase === "end" || phase === "error") {
        return { source: "llm", target: "agent" };
      }
    }
    return { source: "agent", target: "gateway" };
  }
  return { source: "gateway", target: "operator" };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function estimatePayloadSize(payload: unknown): number {
  if (payload === undefined || payload === null) {
    return 0;
  }
  try {
    return JSON.stringify(payload).length;
  } catch {
    return 0;
  }
}

/** Max payload size for non-essential messages in the in-memory buffer. */
const TRUNCATE_PAYLOAD_LIMIT = 512;

/**
 * Selectively truncate payloads for the in-memory buffer to limit heap usage.
 * Keeps full payloads for:
 *   - tool events (stream=tool): needed for tool call details display
 *   - chat/session.message events: needed for chat message display
 *   - lifecycle events: small, needed for latency tracking
 * Truncates payloads for:
 *   - assistant stream events: hundreds per call, only need small deltas
 *   - RPC req/res: models.list, config.get, etc.
 *   - everything else
 */
function selectiveTruncatePayload(payload: unknown, meta: Record<string, unknown>): unknown {
  if (payload === undefined || payload === null) {
    return payload;
  }

  const stream = meta.stream as string | undefined;
  const event = meta.event as string | undefined;

  // Keep full: tool events, chat events, lifecycle events
  if (stream === "tool" || stream === "lifecycle") {
    return payload;
  }
  if (event === "chat" || event === "session.message" || event === "session.tool") {
    return payload;
  }

  // For assistant stream: keep only the text delta, drop the rest
  if (stream === "assistant") {
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const data =
        p.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : null;
      if (data) {
        const text = typeof data.text === "string" ? data.text : undefined;
        return { _slim: true, data: { text } };
      }
    }
    return { _slim: true };
  }

  // For everything else: truncate if large
  try {
    const json = JSON.stringify(payload);
    if (json.length <= TRUNCATE_PAYLOAD_LIMIT) {
      return payload;
    }
    if (typeof payload === "object" && payload !== null) {
      const keys = Object.keys(payload as Record<string, unknown>);
      return { _truncated: true, _keys: keys.slice(0, 15), _size: json.length };
    }
    return { _truncated: true, _size: json.length };
  } catch {
    return { _truncated: true };
  }
}

const RING_BUFFER_CAP = 1000;
const RX_SAMPLE_CAP_PER_SOURCE = 1000;

export class ProtocolTraceStore {
  private buffer: ProtocolTraceRecord[] = [];
  private broadcastFn: TraceBroadcastFn | null = null;
  private rxBroadcastFn: RxSamplesBroadcastFn | null = null;
  private rxSamples: { operator: RxLatencySample[]; node: RxLatencySample[] } = {
    operator: [],
    node: [],
  };
  private traceDir: string;
  private currentFile: string | null = null;
  private currentDate: string | null = null;
  private writeStream: fs.WriteStream | null = null;

  constructor(stateDir?: string) {
    const base = stateDir ?? resolveStateDir();
    this.traceDir = path.join(base, "protocol-traces");
    fs.mkdirSync(this.traceDir, { recursive: true });
  }

  setBroadcast(fn: TraceBroadcastFn) {
    this.broadcastFn = fn;
  }

  setRxBroadcast(fn: RxSamplesBroadcastFn) {
    this.rxBroadcastFn = fn;
  }

  /**
   * Append peer-reported rx samples to the per-source sliding window and
   * forward to the rx broadcast hook (consumed by the protocol monitor UI).
   */
  recordRxSamples(
    source: "operator" | "node",
    samples: RxLatencySample[],
    opts: { connId?: string; client?: string } = {},
  ) {
    if (!samples.length) {
      return;
    }
    const buf = this.rxSamples[source];
    for (const s of samples) {
      buf.push(s);
    }
    if (buf.length > RX_SAMPLE_CAP_PER_SOURCE) {
      buf.splice(0, buf.length - RX_SAMPLE_CAP_PER_SOURCE);
    }
    if (this.rxBroadcastFn) {
      this.rxBroadcastFn({ source, connId: opts.connId, client: opts.client, samples });
    }
  }

  getRxSamples(source: "operator" | "node"): RxLatencySample[] {
    return this.rxSamples[source].slice();
  }

  /** Called by the ws-log trace listener. */
  captureTrace(direction: "in" | "out", kind: string, meta: Record<string, unknown>) {
    // Skip protocol.trace events to avoid infinite recursion.
    if (kind === "event" && meta.event === "protocol.trace") {
      return;
    }

    const { source, target } = resolveEntities(direction, kind, meta);

    let payloadSize = estimatePayloadSize(meta.payload);

    // For lifecycle request events, use the requestSize from the event data
    // as it represents the actual LLM request size, not the small event envelope.
    if (meta.stream === "lifecycle" || (meta.payload && typeof meta.payload === "object")) {
      const p = meta.payload as Record<string, unknown> | undefined;
      const data = p?.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : p;
      if (data && typeof data?.requestSize === "number" && data.requestSize > 0) {
        payloadSize = data.requestSize;
      }
    }

    // Resolve runId: prefer top-level meta, fall back to payload.runId (agent events)
    let runId = meta.runId as string | undefined;
    if (!runId && meta.payload && typeof meta.payload === "object") {
      const p = meta.payload as Record<string, unknown>;
      if (typeof p.runId === "string") {
        runId = p.runId;
      }
    }

    // Resolve reqId: protocol-level request id for req/res correlation
    const rawReqId = meta.id;
    const reqId =
      typeof rawReqId === "string" || typeof rawReqId === "number" ? rawReqId : undefined;

    const capturedAt = Date.now();

    // Derive one-way wire latency for inbound frames whose sender stamped
    // `sentAt`. Only meaningful when peer clocks are synced (NTP).
    let oneWayLatencyMs: number | undefined;
    if (direction === "in" && typeof meta.sentAt === "number") {
      const delta = capturedAt - meta.sentAt;
      // Clamp negatives (clock skew) to 0; clamp absurd positives (stale frame
      // captured after a long pause) to undefined so they don't poison stats.
      if (delta >= 0 && delta < 60_000) {
        oneWayLatencyMs = delta;
      } else if (delta < 0 && delta > -1_000) {
        oneWayLatencyMs = 0;
      }
    }

    // Full record for JSONL persistence
    const fullRecord: ProtocolTraceRecord = {
      id: randomUUID(),
      ts: capturedAt,
      direction,
      kind: kind as TraceKind,
      source,
      target,
      method: meta.method as string | undefined,
      event: meta.event as string | undefined,
      connId: meta.connId as string | undefined,
      role: meta.role as string | undefined,
      client: typeof meta.client === "string" ? meta.client : undefined,
      clientMode: typeof meta.clientMode === "string" ? meta.clientMode : undefined,
      ok: typeof meta.ok === "boolean" ? meta.ok : undefined,
      payload: meta.payload,
      runId,
      seq: typeof meta.seq === "number" ? meta.seq : undefined,
      stream: meta.stream as string | undefined,
      payloadSize,
      reqId,
      oneWayLatencyMs,
    };

    // Selectively truncate payloads for in-memory buffer to limit heap usage.
    // Full payloads are persisted to JSONL for export.
    const record: ProtocolTraceRecord = {
      ...fullRecord,
      payload: selectiveTruncatePayload(meta.payload, meta),
    };

    // In-memory ring buffer
    this.buffer.push(record);
    if (this.buffer.length > RING_BUFFER_CAP) {
      this.buffer.splice(0, this.buffer.length - RING_BUFFER_CAP);
    }

    // JSONL persistence (full payload)
    this.appendToFile(fullRecord);

    // Broadcast to UI
    if (this.broadcastFn) {
      this.broadcastFn(record);
    }
  }

  getRecentTraces(limit = 500, afterId?: string): ProtocolTraceRecord[] {
    if (!afterId) {
      return this.buffer.slice(-limit);
    }
    const idx = this.buffer.findIndex((r) => r.id === afterId);
    if (idx === -1) {
      return this.buffer.slice(-limit);
    }
    return this.buffer.slice(idx + 1, idx + 1 + limit);
  }

  clearTraces() {
    this.buffer = [];
    this.rxSamples.operator = [];
    this.rxSamples.node = [];
    // Close current write stream
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
    // Archive existing files
    try {
      const files = fs.readdirSync(this.traceDir).filter((f) => f.endsWith(".jsonl"));
      const now = Date.now();
      for (const file of files) {
        const src = path.join(this.traceDir, file);
        const dest = path.join(this.traceDir, `${file}.archived.${now}`);
        fs.renameSync(src, dest);
      }
    } catch {
      // ignore
    }
    this.currentFile = null;
    this.currentDate = null;
  }

  getTraceDir(): string {
    return this.traceDir;
  }

  getActiveTraceFiles(): string[] {
    try {
      return fs
        .readdirSync(this.traceDir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(".archived."))
        .toSorted()
        .map((f) => path.join(this.traceDir, f));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private resolveFilePath(): string {
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (this.currentDate === dateStr && this.currentFile) {
      return this.currentFile;
    }
    // Day rolled over — close old stream
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
    this.currentDate = dateStr;
    this.currentFile = path.join(this.traceDir, `trace-${dateStr}.jsonl`);
    return this.currentFile;
  }

  private appendToFile(record: ProtocolTraceRecord) {
    const filePath = this.resolveFilePath();
    if (!this.writeStream || this.writeStream.path !== filePath) {
      if (this.writeStream) {
        this.writeStream.end();
      }
      this.writeStream = fs.createWriteStream(filePath, { flags: "a" });
    }
    this.writeStream.write(`${JSON.stringify(record)}\n`);
  }
}
