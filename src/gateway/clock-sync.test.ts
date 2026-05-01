import { describe, expect, it } from "vitest";
import { computeClockSyncSample, pickBestSample, type ClockSyncSample } from "./clock-sync.js";

describe("computeClockSyncSample", () => {
  it("recovers offset when peer is 50ms ahead of gateway", () => {
    // Scenario: peer's clock is +50ms ahead of gateway. Peer sends at peerT0.
    // 5ms wire transit each way, 2ms gateway processing.
    //   t0 = 100050  (peer clock; gateway clock equivalent = 100000)
    //   t1 = 100005  (gateway clock at recv: gateway was at 100000 + 5ms wire)
    //   t2 = 100007  (gateway clock at send: gateway was at 100005 + 2ms work)
    //   t3 = 100062  (peer clock at recv: gateway 100007 + 5ms wire = 100012,
    //                 then add 50ms peer-ahead skew = 100062)
    const sample = computeClockSyncSample(100_050, 100_005, 100_007, 100_062);
    // offset = ((t1 - t0) + (t2 - t3)) / 2 = ((-45) + (-55)) / 2 = -50
    expect(sample.offsetMs).toBeCloseTo(-50, 5);
    expect(sample.gatewayProcessingMs).toBe(2);
    expect(sample.rttMs).toBe(12);
    expect(sample.networkRttMs).toBe(10);
  });

  it("recovers offset when peer is 30ms behind gateway", () => {
    // Mirror of the prior test with the peer 30ms behind. Same wire/processing.
    //   t0 = 99970   (peer)
    //   t1 = 100005  (gateway recv)
    //   t2 = 100007  (gateway send)
    //   t3 = 99982   (peer recv: gateway 100007 + 5ms wire = 100012 - 30 skew)
    const sample = computeClockSyncSample(99_970, 100_005, 100_007, 99_982);
    expect(sample.offsetMs).toBeCloseTo(30, 5);
    expect(sample.gatewayProcessingMs).toBe(2);
    expect(sample.rttMs).toBe(12);
    expect(sample.networkRttMs).toBe(10);
  });

  it("recovers a near-zero offset when clocks are aligned", () => {
    const sample = computeClockSyncSample(1_000_000, 1_000_005, 1_000_007, 1_000_012);
    expect(sample.offsetMs).toBeCloseTo(0, 5);
    expect(sample.networkRttMs).toBe(10);
  });

  it("clamps negative gateway processing and RTT to zero", () => {
    // Implausible inputs (e.g. wall-clock jump). Helper should not return
    // negative durations that would corrupt downstream display logic.
    const sample = computeClockSyncSample(100, 90, 85, 80);
    expect(sample.gatewayProcessingMs).toBe(0);
    expect(sample.rttMs).toBe(0);
    expect(sample.networkRttMs).toBe(0);
  });
});

describe("pickBestSample", () => {
  it("returns null for an empty list", () => {
    expect(pickBestSample([])).toBeNull();
  });

  it("returns the sample with the smallest RTT", () => {
    const samples: ClockSyncSample[] = [
      { offsetMs: 10, networkRttMs: 50, gatewayProcessingMs: 1, rttMs: 51 },
      { offsetMs: 11, networkRttMs: 4, gatewayProcessingMs: 1, rttMs: 5 },
      { offsetMs: 12, networkRttMs: 200, gatewayProcessingMs: 5, rttMs: 205 },
    ];
    expect(pickBestSample(samples)?.rttMs).toBe(5);
    expect(pickBestSample(samples)?.offsetMs).toBe(11);
  });
});
