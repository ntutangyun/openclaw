import { Type, type Static } from "typebox";

/**
 * Dedicated ping protocol for protocol-monitor latency measurement. Replaces
 * the old "instrument every functional message with sentAt" approach.
 *
 * Goals:
 *   1. Don't modify functional message payloads.
 *   2. Latency is independent of payload size (pings are fixed-shape).
 *   3. Forward (peer→gw) and reverse (gw→peer) are measured **independently**:
 *      each direction runs its own RTT measurement using a single clock so the
 *      result is mechanically honest within that ping (no clock-sync state, no
 *      symmetry assumption between directions). Each direction's reported
 *      one-way is RTT/2 of the round trip in that direction.
 *
 * Wire-level mechanics (per direction, every 5 s):
 *
 *   Forward (peer → gateway):
 *     peer  --[ping.peer-to-gw {peerT0}]------> gateway      (peer stamps t0 on send)
 *     peer  <--[res {peerT0, gatewayProcessingMs}]-- gateway  (gateway stamps t1 on entry, t2 before respond)
 *     peer's wire RTT  = (peerT3 - peerT0) - gatewayProcessingMs
 *     forward one-way  = wireRTT / 2
 *
 *   Reverse (gateway → peer):
 *     gateway --[event ping.gw-to-peer {pingId, gatewayT0}]--> peer  (gateway stamps t0 on send)
 *     peer    --[ping.gw-to-peer.ack {pingId, gatewayT0, peerProcessingMs}]--> gateway
 *     gateway's wire RTT = (gatewayT3 - gatewayT0) - peerProcessingMs
 *     reverse one-way    = wireRTT / 2
 *
 * Sample distribution (gateway has both, then broadcasts to all UIs):
 *   peer    --[ping.metrics-report {forwardSamples}]--> gateway
 *   gateway --[event ping.metrics {source, direction, samples}]--> all UIs
 *
 * All ping methods/events are in DEFAULT_INGEST_BLOCKLIST so they never
 * pollute the throughput / messages / timeline aggregates that they're
 * supposed to be measuring. Allowed for both `operator` and `node` roles via
 * SHARED_METHODS.
 */

const PingSampleSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    oneWayMs: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const PingPeerToGwParamsSchema = Type.Object(
  {
    peerT0: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const PingPeerToGwResultSchema = Type.Object(
  {
    peerT0: Type.Integer({ minimum: 0 }),
    gatewayProcessingMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const PingGwToPeerEventSchema = Type.Object(
  {
    pingId: Type.String({ minLength: 1 }),
    gatewayT0: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const PingGwToPeerAckParamsSchema = Type.Object(
  {
    pingId: Type.String({ minLength: 1 }),
    gatewayT0: Type.Integer({ minimum: 0 }),
    peerProcessingMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const PingGwToPeerAckResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const PingMetricsReportParamsSchema = Type.Object(
  {
    samples: Type.Array(PingSampleSchema, { maxItems: 200 }),
  },
  { additionalProperties: false },
);

export const PingMetricsReportResultSchema = Type.Object(
  {
    accepted: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/**
 * Gateway broadcasts each new batch of ping samples (forward or reverse) to
 * all connected clients so the protocol monitor charts update in near-real
 * time. `source` identifies which peer the samples are about; `direction`
 * tells the chart which series the samples feed.
 */
export const PingMetricsEventSchema = Type.Object(
  {
    source: Type.String({ enum: ["operator", "node"] }),
    connId: Type.Optional(Type.String()),
    direction: Type.String({ enum: ["forward", "reverse"] }),
    samples: Type.Array(PingSampleSchema),
  },
  { additionalProperties: false },
);

export type PingSample = Static<typeof PingSampleSchema>;
export type PingPeerToGwParams = Static<typeof PingPeerToGwParamsSchema>;
export type PingPeerToGwResult = Static<typeof PingPeerToGwResultSchema>;
export type PingGwToPeerEvent = Static<typeof PingGwToPeerEventSchema>;
export type PingGwToPeerAckParams = Static<typeof PingGwToPeerAckParamsSchema>;
export type PingGwToPeerAckResult = Static<typeof PingGwToPeerAckResultSchema>;
export type PingMetricsReportParams = Static<typeof PingMetricsReportParamsSchema>;
export type PingMetricsReportResult = Static<typeof PingMetricsReportResultSchema>;
export type PingMetricsEvent = Static<typeof PingMetricsEventSchema>;
