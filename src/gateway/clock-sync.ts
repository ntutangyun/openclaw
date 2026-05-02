/**
 * Helpers for the 4-timestamp NTP-style `time.sync` exchange. See the protocol
 * schema in `src/gateway/protocol/schema/time.ts` for the wire contract and
 * the rationale for each timestamp.
 *
 * Using the four timestamps `peerT0` (peer send), `gatewayT1` (gateway recv),
 * `gatewayT2` (gateway send), `peerT3` (peer recv):
 *
 *   offset (gateway − peer) = ((t1 − t0) + (t2 − t3)) / 2
 *   gatewayProcessingMs     = t2 − t1
 *   rttMs                   = t3 − t0
 *   networkRttMs            = rttMs − gatewayProcessingMs
 *
 * `offset` is what peers cache: it converts a peer-clock value into the
 * gateway's clock frame via `gatewayClock = peerClock + offset`. Peers shift
 * `RequestFrame.sentAt` by the cached offset so that the gateway's existing
 * `oneWayLatencyMs = capturedAt - sentAt` calculation stays accurate without
 * trusting OS-level clock alignment between hosts.
 */
export type ClockSyncMetrics = {
  /** Estimated `gateway_clock - peer_clock` (ms). Negative if peer is ahead. */
  offsetMs: number;
  /** Round-trip time excluding the gateway's request-handling time (ms). */
  networkRttMs: number;
  /** Gateway's measured request-handling time, `t2 - t1` (ms). */
  gatewayProcessingMs: number;
};

export type ClockSyncSample = ClockSyncMetrics & {
  /** End-to-end round trip including gateway processing, `t3 - t0` (ms). */
  rttMs: number;
};

export function computeClockSyncSample(
  peerT0: number,
  gatewayT1: number,
  gatewayT2: number,
  peerT3: number,
): ClockSyncSample {
  const offsetMs = (gatewayT1 - peerT0 + (gatewayT2 - peerT3)) / 2;
  const gatewayProcessingMs = Math.max(0, gatewayT2 - gatewayT1);
  const rttMs = Math.max(0, peerT3 - peerT0);
  const networkRttMs = Math.max(0, rttMs - gatewayProcessingMs);
  return { offsetMs, networkRttMs, gatewayProcessingMs, rttMs };
}

/**
 * Pick the sample with the smallest end-to-end RTT. Outliers are inflated by
 * GC pauses, send-queue depth, browser-tab throttling, and similar noise that
 * can only delay frames — never make them faster than the true wire path —
 * so the minimum is the closest estimate of physical-layer latency.
 */
export function pickBestSample(samples: ClockSyncSample[]): ClockSyncSample | null {
  let best: ClockSyncSample | null = null;
  for (const sample of samples) {
    if (!best || sample.rttMs < best.rttMs) {
      best = sample;
    }
  }
  return best;
}

export const TIME_SYNC_BURST_SAMPLES = 5;
export const TIME_SYNC_BURST_INTERVAL_MS = 200;
export const TIME_SYNC_PERIODIC_INTERVAL_MS = 60_000;

/**
 * Maximum unflushed rx-latency samples a peer keeps in memory before the
 * oldest get dropped. Bounds memory under prolonged disconnect or extreme
 * fan-in (e.g. fast assistant streams generating many events).
 */
export const RX_REPORT_BUFFER_CAP = 500;

/**
 * How often a peer drains its rx-latency buffer and posts to
 * `protocol-traces.rx-report`. Short enough that the protocol monitor's
 * reverse-direction chart updates close to live; long enough that the report
 * RPC itself doesn't dominate operator→gateway traffic.
 */
export const RX_REPORT_INTERVAL_MS = 5_000;

/** Single peer-measured gateway → peer rx-latency sample. */
export type RxLatencySample = {
  /** Peer's receive time, shifted into the gateway's clock frame. */
  ts: number;
  /** One-way latency in milliseconds. */
  latencyMs: number;
  kind?: string;
  method?: string;
  event?: string;
};

/**
 * Dedicated protocol-monitor ping cadence. Both peer-side (forward direction)
 * and gateway-side (reverse direction) schedulers fire every 5 s. See
 * `src/gateway/protocol/schema/ping.ts` for the full design.
 */
export const PING_INTERVAL_MS = 5_000;

/** Single ping-derived one-way latency sample. */
export type PingOneWaySample = {
  /** Wall-clock at the moment the sample was recorded (peer's clock). */
  ts: number;
  /** One-way latency estimate (RTT/2 of the dedicated ping) in ms. */
  oneWayMs: number;
};
