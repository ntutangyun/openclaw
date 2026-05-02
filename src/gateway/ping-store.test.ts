import { afterEach, describe, expect, it, vi } from "vitest";
import { PingSampleStore } from "./ping-store.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PingSampleStore", () => {
  it("appends forward and reverse samples per source independently", () => {
    const store = new PingSampleStore();
    store.record("operator", "conn-A", "forward", [{ ts: 1, oneWayMs: 5 }]);
    store.record("operator", "conn-A", "reverse", [{ ts: 2, oneWayMs: 7 }]);
    store.record("node", "conn-B", "forward", [{ ts: 3, oneWayMs: 3 }]);

    expect(store.snapshot("operator", "forward")).toEqual([{ ts: 1, oneWayMs: 5 }]);
    expect(store.snapshot("operator", "reverse")).toEqual([{ ts: 2, oneWayMs: 7 }]);
    expect(store.snapshot("node", "forward")).toEqual([{ ts: 3, oneWayMs: 3 }]);
    expect(store.snapshot("node", "reverse")).toEqual([]);
  });

  it("aggregates samples across multiple connections of the same source", () => {
    const store = new PingSampleStore();
    store.record("operator", "conn-A", "forward", [{ ts: 10, oneWayMs: 1 }]);
    store.record("operator", "conn-B", "forward", [{ ts: 20, oneWayMs: 2 }]);
    expect(
      store
        .snapshot("operator", "forward")
        .map((s) => s.oneWayMs)
        .toSorted((a, b) => a - b),
    ).toEqual([1, 2]);
  });

  it("caps per-direction sample buffers at 1000 entries", () => {
    const store = new PingSampleStore();
    const samples = Array.from({ length: 1500 }, (_, i) => ({ ts: i, oneWayMs: i }));
    store.record("operator", "conn-A", "forward", samples);
    const stored = store.snapshot("operator", "forward");
    expect(stored).toHaveLength(1000);
    // The newest 1000 should survive (oldest dropped).
    expect(stored[0]?.ts).toBe(500);
    expect(stored.at(-1)?.ts).toBe(1499);
  });

  it("invokes the broadcast callback with each batch", () => {
    const store = new PingSampleStore();
    const broadcast = vi.fn();
    store.setBroadcast(broadcast);
    store.record("node", "conn-X", "reverse", [{ ts: 99, oneWayMs: 4 }]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      source: "node",
      connId: "conn-X",
      direction: "reverse",
      samples: [{ ts: 99, oneWayMs: 4 }],
    });
  });

  it("does not broadcast for empty batches", () => {
    const store = new PingSampleStore();
    const broadcast = vi.fn();
    store.setBroadcast(broadcast);
    store.record("operator", "conn-A", "forward", []);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("removes a connection's samples on `removeConnection`", () => {
    const store = new PingSampleStore();
    store.record("operator", "conn-A", "forward", [{ ts: 1, oneWayMs: 1 }]);
    store.record("operator", "conn-B", "forward", [{ ts: 2, oneWayMs: 2 }]);
    store.removeConnection("operator", "conn-A");
    expect(store.snapshot("operator", "forward")).toEqual([{ ts: 2, oneWayMs: 2 }]);
  });

  it("clears every bucket on `clear`", () => {
    const store = new PingSampleStore();
    store.record("operator", "conn-A", "forward", [{ ts: 1, oneWayMs: 1 }]);
    store.record("node", "conn-B", "reverse", [{ ts: 2, oneWayMs: 2 }]);
    store.clear();
    expect(store.snapshot("operator", "forward")).toEqual([]);
    expect(store.snapshot("node", "reverse")).toEqual([]);
  });
});
