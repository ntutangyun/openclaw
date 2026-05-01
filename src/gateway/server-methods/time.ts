import { ErrorCodes, errorShape, validateTimeSyncParams } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * `time.sync` is the peer-side half of the 4-timestamp NTP-style clock
 * synchronization exchange. The handler stamps `gatewayT1` as early as
 * possible on entry and `gatewayT2` immediately before responding so that the
 * `(t2 - t1)` delta the peer receives is the closest possible measurement of
 * the gateway's own request-handling time. The peer combines all four
 * timestamps (its `peerT0`, the gateway's `t1` and `t2`, and its own `peerT3`)
 * to derive `offset`, `networkRttMs`, and `gatewayProcessingMs`.
 *
 * No state is persisted on the gateway: the peer caches the offset locally and
 * applies it to outbound `RequestFrame.sentAt` so the gateway's existing
 * `oneWayLatencyMs = capturedAt - sentAt` formula stays correct without
 * further coordination. `prevSync`, when present, is logged at debug for
 * observability only.
 */
export const timeHandlers: GatewayRequestHandlers = {
  "time.sync": ({ params, respond, client, context }) => {
    const t1 = Date.now();
    if (!validateTimeSyncParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid time.sync params: ${JSON.stringify(validateTimeSyncParams.errors)}`,
        ),
      );
      return;
    }
    const { peerT0, prevSync } = params;
    if (prevSync) {
      const role = client?.connect?.role ?? "unknown";
      const connId = client?.connId ?? "unknown";
      context.logGateway.debug(
        `time.sync prevSync conn=${connId} role=${role} offsetMs=${prevSync.offsetMs.toFixed(2)} networkRttMs=${prevSync.networkRttMs.toFixed(2)} gatewayProcessingMs=${prevSync.gatewayProcessingMs.toFixed(2)}`,
      );
    }
    const t2 = Date.now();
    respond(true, { peerT0, gatewayT1: t1, gatewayT2: t2 });
  },
};
