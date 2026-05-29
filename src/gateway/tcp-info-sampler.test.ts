import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayWsClient } from "./server/ws-types.js";
import { parseSsTcpInfo, startTcpInfoSampler } from "./tcp-info-sampler.js";

// Two sockets as emitted by `ss -tinH state established` (no State column, no
// header). Address line first, then an indented info line carrying rtt/minrtt.
const SAMPLE = [
  "0      0          127.0.0.1:19000       127.0.0.1:42200",
  "\t cubic wscale:10,9 rto:540 rtt:285.434/45.319 ato:40 mss:1378 minrtt:214.445",
  "0      0       100.75.32.28:54964   34.107.243.93:443",
  "\t cubic wscale:9,9 rto:216 rtt:14.735/20.975 ato:40 minrtt:0.034",
].join("\n");

describe("parseSsTcpInfo", () => {
  it("parses srtt + minrtt per socket, pairing address with its info line", () => {
    const recs = parseSsTcpInfo(SAMPLE);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({
      localPort: 19000,
      peerAddr: "127.0.0.1",
      peerPort: 42200,
      srttMs: 285.434,
      minRttMs: 214.445,
    });
    expect(recs[1]).toMatchObject({
      localPort: 54964,
      peerAddr: "34.107.243.93",
      peerPort: 443,
      srttMs: 14.735,
      minRttMs: 0.034,
    });
  });

  it("skips an address line that has no following rtt info line", () => {
    const out = [
      "0 0 10.0.0.1:80 10.0.0.2:5000",
      "0 0 10.0.0.1:80 10.0.0.3:6000",
      "\t cubic rtt:5.0/1.0 minrtt:4.0",
    ].join("\n");
    const recs = parseSsTcpInfo(out);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ peerPort: 6000, srttMs: 5 });
  });

  it("strips IPv6 brackets and %zone ids", () => {
    const recs = parseSsTcpInfo("0 0 [::1]:8080 [fe80::1%eth0]:5555\n\t cubic rtt:2.5/0.5");
    expect(recs[0]).toMatchObject({ localAddr: "::1", peerAddr: "fe80::1", peerPort: 5555, srttMs: 2.5 });
  });

  it("ignores a header line and a leading State column (output without -H)", () => {
    // `ss -tin state established` (no -H) emits a header; minimal builds may also
    // keep the State column. Neither has a numeric-port token, so both are skipped.
    const out = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port",
      "ESTAB  0      0      10.0.0.1:80        10.0.0.2:5000",
      "\t cubic rtt:7.5/1.0 minrtt:6.0",
    ].join("\n");
    const recs = parseSsTcpInfo(out);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ peerAddr: "10.0.0.2", peerPort: 5000, srttMs: 7.5 });
  });
});

describe("startTcpInfoSampler", () => {
  afterEach(() => vi.useRealTimers());

  function fakeClient(role: "operator" | "node", sock: Record<string, unknown>): GatewayWsClient {
    return {
      connId: `conn-${role}`,
      connect: { role },
      socket: { _socket: sock },
    } as unknown as GatewayWsClient;
  }

  it("broadcasts srtt/minrtt for a client matched by peer addr:port", async () => {
    vi.useFakeTimers();
    const client = fakeClient("node", {
      remoteAddress: "34.107.243.93",
      remotePort: 443,
      localAddress: "100.75.32.28",
      localPort: 54964,
    });
    const broadcasts: Array<{ source: string; connId?: string; samples: unknown[] }> = [];
    const stop = startTcpInfoSampler({
      clients: new Set([client]),
      runSs: async () => SAMPLE,
      now: () => 1000,
      broadcast: (info) => broadcasts.push(info),
    });
    await vi.advanceTimersByTimeAsync(1100);
    stop();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      source: "node",
      connId: "conn-node",
      samples: [{ ts: 1000, srttMs: 14.735, minRttMs: 0.034 }],
    });
  });

  it("matches by localPort:peerPort when the peer address differs (IPv4-mapped)", async () => {
    vi.useFakeTimers();
    const client = fakeClient("operator", {
      remoteAddress: "::ffff:34.107.243.93",
      remotePort: 443,
      localPort: 54964,
    });
    const broadcasts: Array<{ source: string }> = [];
    const stop = startTcpInfoSampler({
      clients: new Set([client]),
      runSs: async () => SAMPLE,
      now: () => 2000,
      broadcast: (info) => broadcasts.push(info),
    });
    await vi.advanceTimersByTimeAsync(1100);
    stop();
    // ::ffff: normalizes to 34.107.243.93 so the peer key matches directly.
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].source).toBe("operator");
  });

  it("reports agent-model srtt for a socket matching a configured provider endpoint", async () => {
    vi.useFakeTimers();
    const broadcasts: Array<{ source: string; samples: Array<{ ts: number; srttMs: number }> }> = [];
    const stop = startTcpInfoSampler({
      clients: new Set(), // no peer WS clients — isolate the agent↔model path
      runSs: async () => SAMPLE,
      now: () => 3000,
      modelEndpoints: () => [{ host: "34.107.243.93", port: 443 }],
      resolveHostIps: async (h) => [h], // host is already an IP literal
      broadcast: (info) => broadcasts.push(info),
    });
    await vi.advanceTimersByTimeAsync(1100);
    stop();
    const am = broadcasts.find((b) => b.source === "agent-model");
    expect(am).toBeTruthy();
    expect(am?.samples[0]).toMatchObject({ ts: 3000, srttMs: 14.735 });
  });

  it("emits no agent-model sample when no socket matches the endpoint", async () => {
    vi.useFakeTimers();
    const broadcasts: Array<{ source: string }> = [];
    const stop = startTcpInfoSampler({
      clients: new Set(),
      runSs: async () => SAMPLE,
      now: () => 4000,
      modelEndpoints: () => [{ host: "203.0.113.7", port: 8000 }], // not in SAMPLE
      resolveHostIps: async (h) => [h],
      broadcast: (info) => broadcasts.push(info),
    });
    await vi.advanceTimersByTimeAsync(1100);
    stop();
    expect(broadcasts.some((b) => b.source === "agent-model")).toBe(false);
  });
});
