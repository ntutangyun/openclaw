import { getPingSampleStore } from "../ping-store.js";
import {
  ErrorCodes,
  errorShape,
  validatePingGwToPeerAckParams,
  validatePingMetricsReportParams,
  validatePingPeerToGwParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Dedicated ping protocol handlers for the protocol monitor.
 * See src/gateway/protocol/schema/ping.ts for the wire contract.
 */
export const pingHandlers: GatewayRequestHandlers = {
  /**
   * Forward direction (peer → gw): peer sends `peerT0`; gateway stamps `t1`
   * on entry and `t2` immediately before respond. The peer subtracts
   * `gatewayProcessingMs = t2 - t1` from its own (peerT3 - peerT0) to
   * isolate wire RTT, then divides by 2 for the one-way estimate.
   */
  "ping.peer-to-gw": ({ params, respond }) => {
    const t1 = Date.now();
    if (!validatePingPeerToGwParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ping.peer-to-gw params: ${JSON.stringify(validatePingPeerToGwParams.errors)}`,
        ),
      );
      return;
    }
    const t2 = Date.now();
    respond(true, { peerT0: params.peerT0, gatewayProcessingMs: Math.max(0, t2 - t1) });
  },

  /**
   * Reverse direction (gw → peer): gateway broadcasts `ping.gw-to-peer` event
   * with `gatewayT0`; peer immediately ACKs via this RPC echoing `gatewayT0`
   * and reporting `peerProcessingMs`. Gateway computes RTT = now - gatewayT0
   * - peerProcessingMs, divides by 2, stores the reverse sample for this peer.
   */
  "ping.gw-to-peer.ack": ({ params, respond, client }) => {
    const t3 = Date.now();
    if (!validatePingGwToPeerAckParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ping.gw-to-peer.ack params: ${JSON.stringify(validatePingGwToPeerAckParams.errors)}`,
        ),
      );
      return;
    }
    const store = getPingSampleStore();
    if (!store) {
      respond(true, { ok: true });
      return;
    }
    const wireRttMs = Math.max(0, t3 - params.gatewayT0 - params.peerProcessingMs);
    const oneWayMs = wireRttMs / 2;
    const role = client?.connect?.role === "node" ? "node" : "operator";
    store.record(role, client?.connId, "reverse", [{ ts: t3, oneWayMs }]);
    respond(true, { ok: true });
  },

  /**
   * Forward-direction batch report from peer. The peer measured the RTTs
   * locally (single-clock); this RPC just hands them to the gateway so the
   * protocol monitor UI (which lives on operator clients, not nodes) can
   * chart both directions for every peer.
   */
  "ping.metrics-report": ({ params, respond, client }) => {
    if (!validatePingMetricsReportParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ping.metrics-report params: ${JSON.stringify(validatePingMetricsReportParams.errors)}`,
        ),
      );
      return;
    }
    const store = getPingSampleStore();
    if (!store) {
      respond(true, { accepted: 0 });
      return;
    }
    const role = client?.connect?.role === "node" ? "node" : "operator";
    store.record(role, client?.connId, "forward", params.samples);
    respond(true, { accepted: params.samples.length });
  },
};
