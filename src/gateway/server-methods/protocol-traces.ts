import { getProtocolTraceStore } from "../protocol-trace-store.js";
import { ErrorCodes, errorShape, validateProtocolTracesRxReportParams } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * `protocol-traces.rx-report` — peer batch-reports gateway→peer one-way
 * latency samples it measured locally (the gateway can't observe its own
 * outbound frames' arrival time at the peer). Samples land in the trace
 * store's per-source rx buffer and are re-broadcast as `protocol.rx.samples`
 * events for the protocol monitor UI to chart the reverse direction.
 */
export const protocolTracesHandlers: GatewayRequestHandlers = {
  "protocol-traces.rx-report": ({ params, respond, client }) => {
    if (!validateProtocolTracesRxReportParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid rx-report params: ${JSON.stringify(validateProtocolTracesRxReportParams.errors)}`,
        ),
      );
      return;
    }
    const store = getProtocolTraceStore();
    if (!store) {
      // Trace store disabled (e.g. minimalTestGateway). Accept-and-drop so
      // peers don't keep retrying.
      respond(true, { accepted: 0 });
      return;
    }
    const role = client?.connect?.role === "node" ? "node" : "operator";
    const samples = params.samples;
    store.recordRxSamples(role, samples, {
      connId: client?.connId,
      client: client?.connect?.client?.id,
    });
    respond(true, { accepted: samples.length });
  },
};
