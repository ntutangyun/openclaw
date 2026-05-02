import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PingSampleStore, setPingSampleStore } from "../ping-store.js";
import { pingHandlers } from "./ping.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createOptions(
  method: string,
  params: unknown,
  client: { role: "operator" | "node"; connId?: string } | null,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params: params as Record<string, unknown>,
    client: client ? { connect: { role: client.role }, connId: client.connId ?? "conn-1" } : null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {} as GatewayRequestHandlerOptions["context"],
  } as unknown as GatewayRequestHandlerOptions;
}

describe("pingHandlers ping.peer-to-gw", () => {
  it("echoes peerT0 and reports gateway processing time", () => {
    const before = Date.now();
    const opts = createOptions("ping.peer-to-gw", { peerT0: 12_345 }, { role: "operator" });
    void pingHandlers["ping.peer-to-gw"]?.(opts);
    const after = Date.now();
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    const result = payload as { peerT0: number; gatewayProcessingMs: number };
    expect(result.peerT0).toBe(12_345);
    expect(result.gatewayProcessingMs).toBeGreaterThanOrEqual(0);
    expect(result.gatewayProcessingMs).toBeLessThanOrEqual(after - before);
  });

  it("rejects malformed params", () => {
    const opts = createOptions("ping.peer-to-gw", { peerT0: "nope" }, { role: "operator" });
    void pingHandlers["ping.peer-to-gw"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    const [ok, , error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect((error as { code: string } | undefined)?.code).toBe("INVALID_REQUEST");
  });
});

describe("pingHandlers ping.gw-to-peer.ack", () => {
  let store: PingSampleStore;
  beforeEach(() => {
    store = new PingSampleStore();
    setPingSampleStore(store);
  });
  afterEach(() => {
    setPingSampleStore(null);
  });

  it("computes RTT excluding peer processing and stores as a reverse sample", () => {
    const gatewayT0 = Date.now() - 50; // pretend the ping went out 50ms ago
    const opts = createOptions(
      "ping.gw-to-peer.ack",
      { pingId: "p1", gatewayT0, peerProcessingMs: 4 },
      { role: "operator", connId: "conn-A" },
    );
    void pingHandlers["ping.gw-to-peer.ack"]?.(opts);
    const samples = store.snapshot("operator", "reverse");
    expect(samples).toHaveLength(1);
    // RTT ≈ 50ms, minus peerProcessingMs=4 → wireRTT ≈ 46ms → one-way ≈ 23ms.
    // Allow a generous margin because the test stamps gatewayT0 with real wall clock.
    expect(samples[0]?.oneWayMs).toBeGreaterThan(15);
    expect(samples[0]?.oneWayMs).toBeLessThan(60);
  });

  it("classifies the sample under `node` when the client role is node", () => {
    const opts = createOptions(
      "ping.gw-to-peer.ack",
      { pingId: "p1", gatewayT0: Date.now() - 10, peerProcessingMs: 0 },
      { role: "node", connId: "node-X" },
    );
    void pingHandlers["ping.gw-to-peer.ack"]?.(opts);
    expect(store.snapshot("node", "reverse")).toHaveLength(1);
    expect(store.snapshot("operator", "reverse")).toHaveLength(0);
  });

  it("clamps wire RTT to >=0 when peer processing exceeds total elapsed", () => {
    const opts = createOptions(
      "ping.gw-to-peer.ack",
      // peerProcessingMs absurdly larger than the elapsed gap on purpose.
      { pingId: "p1", gatewayT0: Date.now(), peerProcessingMs: 1_000_000 },
      { role: "operator" },
    );
    void pingHandlers["ping.gw-to-peer.ack"]?.(opts);
    const samples = store.snapshot("operator", "reverse");
    expect(samples).toHaveLength(1);
    expect(samples[0]?.oneWayMs).toBe(0);
  });

  it("rejects malformed params", () => {
    const opts = createOptions(
      "ping.gw-to-peer.ack",
      { pingId: 5, gatewayT0: "bad" },
      { role: "operator" },
    );
    void pingHandlers["ping.gw-to-peer.ack"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(store.snapshot("operator", "reverse")).toHaveLength(0);
  });
});

describe("pingHandlers ping.metrics-report", () => {
  let store: PingSampleStore;
  beforeEach(() => {
    store = new PingSampleStore();
    setPingSampleStore(store);
  });
  afterEach(() => {
    setPingSampleStore(null);
  });

  it("stores peer-reported forward samples for the source", () => {
    const opts = createOptions(
      "ping.metrics-report",
      {
        samples: [
          { ts: 100, oneWayMs: 5 },
          { ts: 200, oneWayMs: 6 },
        ],
      },
      { role: "operator", connId: "conn-A" },
    );
    void pingHandlers["ping.metrics-report"]?.(opts);
    expect(store.snapshot("operator", "forward")).toEqual([
      { ts: 100, oneWayMs: 5 },
      { ts: 200, oneWayMs: 6 },
    ]);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond.mock.calls[0]?.[1]).toEqual({ accepted: 2 });
  });

  it("rejects malformed params", () => {
    const opts = createOptions("ping.metrics-report", { samples: "nope" }, { role: "operator" });
    void pingHandlers["ping.metrics-report"]?.(opts);
    expect((opts.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(false);
    expect(store.snapshot("operator", "forward")).toHaveLength(0);
  });

  it("accepts an empty batch as no-op success", () => {
    const opts = createOptions("ping.metrics-report", { samples: [] }, { role: "operator" });
    void pingHandlers["ping.metrics-report"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toEqual({ accepted: 0 });
  });
});
