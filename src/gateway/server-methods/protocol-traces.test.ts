import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ProtocolTraceStore,
  type RxLatencySample,
  setProtocolTraceStore,
} from "../protocol-trace-store.js";
import { protocolTracesHandlers } from "./protocol-traces.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type RecordedRx = {
  source: "operator" | "node";
  samples: { ts: number; latencyMs: number }[];
  connId?: string;
};

function fakeStore(recorded: RecordedRx[]): ProtocolTraceStore {
  return {
    recordRxSamples: (
      source: "operator" | "node",
      samples: RxLatencySample[],
      opts?: { connId?: string },
    ) => {
      recorded.push({ source, samples: samples.slice(), connId: opts?.connId });
    },
  } as unknown as ProtocolTraceStore;
}

function createOptions(
  params: unknown,
  client: { role: "operator" | "node"; connId?: string } | null,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "protocol-traces.rx-report", params },
    params: params as Record<string, unknown>,
    client: client ? { connect: { role: client.role }, connId: client.connId ?? "conn-1" } : null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {} as GatewayRequestHandlerOptions["context"],
  } as unknown as GatewayRequestHandlerOptions;
}

describe("protocolTracesHandlers protocol-traces.rx-report", () => {
  let recorded: RecordedRx[] = [];

  beforeEach(() => {
    recorded = [];
    setProtocolTraceStore(fakeStore(recorded));
  });

  afterEach(() => {
    // The singleton is process-wide; leave a no-op store so other tests
    // don't observe stale state from this test file.
    setProtocolTraceStore({
      recordRxSamples: () => {},
    } as unknown as ProtocolTraceStore);
  });

  it("forwards a valid batch from an operator into the trace store", () => {
    const opts = createOptions(
      {
        samples: [
          { ts: 1_000_000, latencyMs: 5 },
          { ts: 1_000_100, latencyMs: 6, kind: "event", event: "session.message" },
          { ts: 1_000_200, latencyMs: 7, kind: "res", method: "chat.send" },
        ],
      },
      { role: "operator", connId: "browser-A" },
    );
    void protocolTracesHandlers["protocol-traces.rx-report"]?.(opts);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.source).toBe("operator");
    expect(recorded[0]?.samples).toHaveLength(3);
    expect(recorded[0]?.connId).toBe("browser-A");
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toEqual({ accepted: 3 });
  });

  it("classifies the report under `node` when client.role is node", () => {
    const opts = createOptions(
      { samples: [{ ts: 1, latencyMs: 1 }] },
      { role: "node", connId: "node-X" },
    );
    void protocolTracesHandlers["protocol-traces.rx-report"]?.(opts);
    expect(recorded[0]?.source).toBe("node");
  });

  it("rejects malformed params", () => {
    const opts = createOptions({ samples: "not-an-array" }, { role: "operator" });
    void protocolTracesHandlers["protocol-traces.rx-report"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    const [ok, , error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect((error as { code: string } | undefined)?.code).toBe("INVALID_REQUEST");
    expect(recorded).toHaveLength(0);
  });

  it("rejects samples with negative latencyMs (schema enforces minimum 0)", () => {
    const opts = createOptions({ samples: [{ ts: 100, latencyMs: -5 }] }, { role: "operator" });
    void protocolTracesHandlers["protocol-traces.rx-report"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it("accepts an empty batch as a no-op success", () => {
    const opts = createOptions({ samples: [] }, { role: "operator" });
    void protocolTracesHandlers["protocol-traces.rx-report"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toEqual({ accepted: 0 });
  });
});
