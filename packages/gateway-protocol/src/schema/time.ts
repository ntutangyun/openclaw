import { Type, type Static } from "typebox";

/**
 * Peer → gateway clock synchronization (4-timestamp NTP-style exchange).
 *
 * Peer sends `peerT0` (its wall-clock at request send). Gateway responds with
 * `gatewayT1` (gateway clock when the request handler stamped on entry) and
 * `gatewayT2` (gateway clock immediately before the response is queued). The
 * peer records `peerT3` (its clock when the response arrives) locally and
 * derives:
 *
 *   offset (gateway − peer) = ((gatewayT1 − peerT0) + (gatewayT2 − peerT3)) / 2
 *   networkRttMs            = (peerT3 − peerT0) − (gatewayT2 − gatewayT1)
 *   gatewayProcessingMs     = gatewayT2 − gatewayT1
 *
 * Peers cache `offset` and apply it to outbound `RequestFrame.sentAt` so that
 * the gateway-side `oneWayLatencyMs = capturedAt − sentAt` becomes accurate
 * regardless of OS clock skew between hosts. `prevSync` echoes the peer's most
 * recent measurement back for diagnostic surfacing only — the gateway does not
 * rely on it for correctness.
 *
 * Allowed for both `operator` and `node` roles; no scope required.
 */
export const TimeSyncParamsSchema = Type.Object(
  {
    peerT0: Type.Integer({ minimum: 0 }),
    prevSync: Type.Optional(
      Type.Object(
        {
          offsetMs: Type.Number(),
          networkRttMs: Type.Number({ minimum: 0 }),
          gatewayProcessingMs: Type.Number({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const TimeSyncResultSchema = Type.Object(
  {
    peerT0: Type.Integer({ minimum: 0 }),
    gatewayT1: Type.Integer({ minimum: 0 }),
    gatewayT2: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type TimeSyncParams = Static<typeof TimeSyncParamsSchema>;
export type TimeSyncResult = Static<typeof TimeSyncResultSchema>;
