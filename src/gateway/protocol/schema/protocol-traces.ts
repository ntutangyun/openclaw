import { Type, type Static } from "typebox";

/**
 * Peer → gateway batch report of inbound (gateway → peer) one-way latency
 * samples.
 *
 * The peer measures rx latency for each frame it receives from the gateway:
 *
 *   latencyMs = Date.now() + clockOffsetMs - frame.sentAt
 *
 * where `clockOffsetMs` is the cached offset from the most recent `time.sync`
 * exchange (see `src/gateway/protocol/schema/time.ts`). Without `time.sync`
 * the offset defaults to 0, so reports made before sync converges may be off
 * by raw OS clock skew between the two hosts — they're best-effort.
 *
 * Samples are batched to keep WS overhead low. The gateway re-broadcasts each
 * batch as a `protocol.rx.samples` event so connected operator UIs can render
 * the gateway → peer direction in their latency charts (the gateway has no
 * way to measure that direction from its own clock alone).
 *
 * `ts` is the peer's wall-clock at receive, shifted into the gateway's clock
 * frame (`Date.now() + clockOffsetMs`), so all sample timestamps from all
 * peers are directly comparable on the gateway side.
 *
 * Allowed for both `operator` and `node` roles; no scope required.
 */
export const ProtocolTracesRxSampleSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    latencyMs: Type.Number({ minimum: 0 }),
    kind: Type.Optional(Type.String()),
    method: Type.Optional(Type.String()),
    event: Type.Optional(Type.String()),
    /**
     * Serialized payload byte count for this frame, computed by the receiver
     * (`JSON.stringify(frame.payload).length`) at recv time. Lets the UI
     * compute per-message throughput as `payloadSize / latencyMs * 1000`
     * without joining back to the corresponding trace record. Optional for
     * back-compat with pre-upgrade peers that don't stamp it.
     */
    payloadSize: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ProtocolTracesRxReportParamsSchema = Type.Object(
  {
    samples: Type.Array(ProtocolTracesRxSampleSchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);

export const ProtocolTracesRxReportResultSchema = Type.Object(
  {
    accepted: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Payload of the gateway → UIs `protocol.rx.samples` broadcast event. */
export const ProtocolRxSamplesEventSchema = Type.Object(
  {
    source: Type.String({ enum: ["operator", "node"] }),
    connId: Type.Optional(Type.String()),
    /**
     * Client id (`openclaw-control-ui`, `cli`, `openclaw-tui`, …) of the
     * peer that produced this batch. Lets the UI scope the operator-pair
     * monitor to actual Control UI traffic without resorting to per-trace
     * joins. Optional for back-compat with pre-upgrade gateways.
     */
    client: Type.Optional(Type.String()),
    samples: Type.Array(ProtocolTracesRxSampleSchema),
  },
  { additionalProperties: false },
);

export type ProtocolTracesRxSample = Static<typeof ProtocolTracesRxSampleSchema>;
export type ProtocolTracesRxReportParams = Static<typeof ProtocolTracesRxReportParamsSchema>;
export type ProtocolTracesRxReportResult = Static<typeof ProtocolTracesRxReportResultSchema>;
export type ProtocolRxSamplesEvent = Static<typeof ProtocolRxSamplesEventSchema>;
