import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: vi.fn(() => ({
      agents: {
        list: [{ id: "main" }, { id: "opus" }],
      },
      session: {},
    })),
  };
});

import { usageHandlers } from "./usage.js";

type SessionsPurgeArgs = Parameters<(typeof usageHandlers)["sessions.purge"]>[0];
type SessionsPurgeResult = {
  dryRun: boolean;
  fileCount: number;
  byteCount: number;
  agentIds: string[];
};

async function runSessionsPurge(
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: SessionsPurgeResult; error?: unknown }> {
  const respond = vi.fn();
  await usageHandlers["sessions.purge"]({
    respond,
    params,
  } as unknown as SessionsPurgeArgs);
  expect(respond).toHaveBeenCalledTimes(1);
  const [ok, result, error] = respond.mock.calls[0] as [
    boolean,
    SessionsPurgeResult | undefined,
    unknown,
  ];
  return { ok, result, error };
}

let stateDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-purge-test-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function seedSessionsDir(agentId: string, files: Record<string, string>): string {
  const dir = path.join(stateDir, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
  }
  return dir;
}

describe("sessions.purge", () => {
  it("rejects unknown params", async () => {
    const respond = vi.fn();
    await usageHandlers["sessions.purge"]({
      respond,
      params: { something: "bad" },
    } as unknown as SessionsPurgeArgs);
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok] = respond.mock.calls[0] as [boolean];
    expect(ok).toBe(false);
  });

  it("dry-run returns counts without touching disk", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const mainDir = seedSessionsDir("main", {
        "s-main.jsonl": "x".repeat(100),
        "s-old.jsonl.deleted.2026-01-01T00-00-00Z": "y".repeat(50),
      });
      seedSessionsDir("opus", { "s-opus.jsonl": "z".repeat(20) });

      const { ok, result } = await runSessionsPurge({ dryRun: true });
      expect(ok).toBe(true);
      expect(result?.dryRun).toBe(true);
      expect(result?.fileCount).toBe(3);
      expect(result?.byteCount).toBe(170);
      expect(result?.agentIds.toSorted()).toEqual(["main", "opus"]);

      // Disk untouched.
      expect(fs.existsSync(path.join(mainDir, "s-main.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(mainDir, "s-old.jsonl.deleted.2026-01-01T00-00-00Z"))).toBe(
        true,
      );
    });
  });

  it("live run unlinks transcript files (primary and archived) across all agents", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const mainDir = seedSessionsDir("main", {
        "s-main.jsonl": "alpha",
        "s-reset.jsonl.reset.2026-02-15T12-30-00.000Z": "beta",
      });
      const opusDir = seedSessionsDir("opus", {
        "s-opus.jsonl": "gamma",
      });

      const { ok, result } = await runSessionsPurge({});
      expect(ok).toBe(true);
      expect(result?.dryRun).toBe(false);
      expect(result?.fileCount).toBe(3);
      expect(result?.byteCount).toBe(14);
      expect(result?.agentIds.toSorted()).toEqual(["main", "opus"]);

      // All session files gone.
      expect(fs.readdirSync(mainDir)).toEqual([]);
      expect(fs.readdirSync(opusDir)).toEqual([]);
    });
  });

  it("leaves non-transcript files in the sessions dir intact", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const dir = seedSessionsDir("main", {
        "s-main.jsonl": "alpha",
        "sessions.json": '{"some":"store"}',
        "notes.txt": "human-written notes",
      });

      const { ok, result } = await runSessionsPurge({});
      expect(ok).toBe(true);
      expect(result?.fileCount).toBe(1);

      const remaining = fs.readdirSync(dir).toSorted();
      expect(remaining).toEqual(["notes.txt", "sessions.json"]);
    });
  });

  it("succeeds when an agent has no sessions directory yet", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      // Neither main nor opus has a sessions dir.
      const { ok, result } = await runSessionsPurge({});
      expect(ok).toBe(true);
      expect(result?.fileCount).toBe(0);
      expect(result?.byteCount).toBe(0);
      expect(result?.agentIds).toEqual([]);
    });
  });
});
