import { describe, expect, it } from "vitest";
import { DEFAULT_INGEST_BLOCKLIST, isIngestBlocklisted } from "./protocol-monitor.ts";

describe("DEFAULT_INGEST_BLOCKLIST", () => {
  it("excludes the time.sync clock-sync mechanism so it doesn't dominate operator latency", () => {
    expect(DEFAULT_INGEST_BLOCKLIST.has("time.sync")).toBe(true);
    expect(isIngestBlocklisted({ method: "time.sync" })).toBe(true);
  });

  it("excludes UI bootstrap fetches that aren't part of the active task", () => {
    for (const method of [
      "chat.history",
      "commands.list",
      "gateway.identity.get",
      "models.authStatus",
      "talk.config",
      "voicewake.get",
      "skills.status",
      "skills.search",
      "skills.detail",
      "cron.runs",
      "node.describe",
    ]) {
      expect(isIngestBlocklisted({ method })).toBe(true);
    }
  });

  it("excludes node-side queue plumbing", () => {
    for (const method of [
      "node.pending.pull",
      "node.pending.ack",
      "node.pending.drain",
      "node.canvas.capability.refresh",
    ]) {
      expect(isIngestBlocklisted({ method })).toBe(true);
    }
  });

  it("keeps actual task-flow methods unblocked", () => {
    for (const method of [
      "chat.send",
      "chat.abort",
      "node.invoke",
      "node.invoke.result",
      "node.event",
      "sessions.send",
      "sessions.create",
      "sessions.abort",
    ]) {
      expect(isIngestBlocklisted({ method })).toBe(false);
    }
  });

  it("keeps task-flow events unblocked", () => {
    for (const event of ["chat", "session.message", "session.tool", "agent"]) {
      expect(isIngestBlocklisted({ event })).toBe(false);
    }
  });

  it("matches by event name when only `event` is set", () => {
    expect(isIngestBlocklisted({ event: "tick" })).toBe(true);
    expect(isIngestBlocklisted({ event: "presence" })).toBe(true);
    expect(isIngestBlocklisted({ event: "protocol.trace" })).toBe(true);
  });
});
