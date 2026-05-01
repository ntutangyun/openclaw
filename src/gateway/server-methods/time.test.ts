import { describe, expect, it, vi } from "vitest";
import { timeHandlers } from "./time.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createOptions(
  params: unknown,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  const debug = vi.fn();
  return {
    req: { type: "req", id: "req-1", method: "time.sync", params },
    params: params as Record<string, unknown>,
    client: { connect: { role: "operator" }, connId: "conn-test" },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      logGateway: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("timeHandlers time.sync", () => {
  it("responds with monotonically non-decreasing gatewayT1 and gatewayT2 timestamps", () => {
    const before = Date.now();
    const opts = createOptions({ peerT0: 100_000 });
    void timeHandlers["time.sync"]?.(opts);
    const after = Date.now();
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    const result = payload as { peerT0: number; gatewayT1: number; gatewayT2: number };
    expect(result.peerT0).toBe(100_000);
    expect(result.gatewayT1).toBeGreaterThanOrEqual(before);
    expect(result.gatewayT2).toBeGreaterThanOrEqual(result.gatewayT1);
    expect(result.gatewayT2).toBeLessThanOrEqual(after);
  });

  it("rejects params without peerT0", () => {
    const opts = createOptions({});
    void timeHandlers["time.sync"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    const [ok, , error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect((error as { code: string } | undefined)?.code).toBe("INVALID_REQUEST");
  });

  it("rejects negative peerT0", () => {
    const opts = createOptions({ peerT0: -1 });
    void timeHandlers["time.sync"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    const [ok] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
  });

  it("logs prevSync metrics for diagnostic visibility", () => {
    const debug = vi.fn();
    const opts = createOptions(
      {
        peerT0: 100_000,
        prevSync: { offsetMs: -42.5, networkRttMs: 7.25, gatewayProcessingMs: 1.5 },
      },
      {
        context: {
          logGateway: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as unknown as GatewayRequestHandlerOptions["context"],
      },
    );
    void timeHandlers["time.sync"]?.(opts);
    expect(debug).toHaveBeenCalledTimes(1);
    const message = debug.mock.calls[0]?.[0];
    expect(message).toContain("offsetMs=-42.50");
    expect(message).toContain("networkRttMs=7.25");
    expect(message).toContain("gatewayProcessingMs=1.50");
    expect(message).toContain("conn=conn-test");
    expect(message).toContain("role=operator");
  });

  it("does not require prevSync in the request", () => {
    const opts = createOptions({ peerT0: 100_000 });
    void timeHandlers["time.sync"]?.(opts);
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
  });
});
