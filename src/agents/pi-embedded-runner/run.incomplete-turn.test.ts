import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedLog,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  buildAttemptReplayMetadata,
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_NO_TOOL_CALL_NUDGE_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  EMPTY_RESPONSE_RETRY_INSTRUCTION,
  extractPlanningOnlyPlanDetails,
  isLikelyExecutionAckPrompt,
  NO_TOOL_CALL_NUDGE_INSTRUCTION,
  PLANNING_ONLY_RETRY_INSTRUCTION,
  REASONING_ONLY_RETRY_INSTRUCTION,
  resolveAckExecutionFastPathInstruction,
  resolveEmptyResponseRetryInstruction,
  resolveNoToolCallNudgeInstruction,
  resolvePlanningOnlyRetryLimit,
  resolvePlanningOnlyRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  STRICT_AGENTIC_BLOCKED_TEXT,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
} from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent incomplete-turn safety", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("warns before retrying when an incomplete turn already sent a message", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "toolUse",
          errorMessage: "internal retry interrupted tool execution",
          provider: "openai",
          model: "mock-1",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-incomplete-turn-messaging-warning",
    });

    expect(mockedClassifyFailoverReason).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("verify before retrying");
  });

  it("uses explicit agentId without a session key before surfacing the strict-agentic blocked state", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      sessionKey: undefined,
      agentId: "research",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-explicit-agent",
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "default",
            },
          },
          list: [
            { id: "main" },
            {
              id: "research",
              embeddedPi: {
                executionContract: "strict-agentic",
              },
            },
          ],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
  });

  it("emits explicit replayInvalid + blocked liveness state at the strict-agentic blocked exit", async () => {
    // Criterion 4 of the GPT-5.4 parity gate requires every terminal exit path
    // to emit explicit replayInvalid + livenessState. The strict-agentic
    // blocked exit is the exact place where strict-agentic is supposed to be
    // loudest; it must not fall through to "silent disappearance".
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-blocked-liveness",
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "strict-agentic",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(false);
  });

  it("auto-activates strict-agentic for unconfigured GPT-5 openai runs and surfaces the blocked state", async () => {
    // Criterion 1 of the GPT-5.4 parity gate ("no stalls after planning") must
    // cover out-of-the-box installs, not only users who opted in. An
    // unconfigured GPT-5.4 openai run should receive the strict-agentic retry
    // + blocked-state treatment automatically.
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-auto-activated",
      config: {
        agents: {
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    // Two retries (strict-agentic retry cap) plus the original attempt = 3 calls.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
  });

  it("respects explicit default contract opt-out on GPT-5 openai runs", async () => {
    // Users who explicitly set executionContract: "default" opt out of
    // auto-activated strict-agentic. They keep the old pre-parity-program
    // behavior (1 retry, then fall through to the normal completion path).
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-explicit-default-optout",
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "default",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    // Default contract: 1 retry then falls through. Should NOT surface the
    // strict-agentic blocked payload.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const payloadTexts = (result.payloads ?? []).map((payload) => payload.text ?? "");
    for (const text of payloadTexts) {
      expect(text).not.toContain("plan-only turns");
    }
  });

  it("detects replay-safe planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("retries reasoning-only GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_reasoning_only", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as { prompt?: string };
    expect(secondCall.prompt).toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("reasoning-only assistant turn detected"),
    );
  });

  it("does not retry reasoning-only turns after side effects", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_after_send", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-after-side-effects",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("verify before retrying");
  });

  it("does not retry reasoning-only turns when the assistant ended in error", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.4",
          errorMessage: "provider failed after emitting reasoning",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_error_turn", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-assistant-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
  });

  it("does not retry reasoning-only turns for non-openai assistant metadata", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_provider_mismatch",
                type: "reasoning",
              }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-provider-mismatch",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
  });

  it("retries generic empty GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-response-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as { prompt?: string };
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("empty response detected"));
  });

  it("surfaces an error after exhausting empty-response retries", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-response-exhausted",
    });

    // One initial attempt + DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT (3) retries.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT + 1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("empty response retries exhausted"),
    );
  });

  it("surfaces an error after exhausting reasoning-only retries without a visible answer", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_reasoning_exhausted",
                type: "reasoning",
              }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      reasoningLevel: "on",
      runId: "run-reasoning-only-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("reasoning-only retries exhausted"),
    );
  });

  it("detects structured bullet-only plans with intent cues as planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [
          "Plan:\n1. I'll inspect the code\n2. I'll patch the issue\n3. I'll run the tests",
        ],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("does not misclassify ordinary bullet summaries as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["1. Parser refactor\n2. Regression coverage\n3. Docs cleanup"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not treat a bare plan heading as planning-only without an intent cue", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Plan:\n1. Parser refactor\n2. Regression coverage\n3. Docs cleanup"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry planning-only detection after tool activity", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        toolMetas: [
          { toolName: "read", meta: "path=src/index.ts" },
          { toolName: "search", meta: "pattern=runEmbeddedPiAgent" },
        ],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry planning-only detection after an item has started", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 0,
          activeCount: 1,
        },
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("treats update_plan as non-progress for planning-only retry detection", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll capture the steps, then take the first tool action."],
        toolMetas: [{ toolName: "update_plan", meta: "status=updated" }],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
      }),
    });

    expect(retryInstruction).toContain("Act now");
  });

  it("allows one retry by default and two retries for strict-agentic runs", () => {
    expect(resolvePlanningOnlyRetryLimit("default")).toBe(1);
    expect(resolvePlanningOnlyRetryLimit("strict-agentic")).toBe(2);
    expect(STRICT_AGENTIC_BLOCKED_TEXT).toContain("plan-only turns");
    expect(STRICT_AGENTIC_BLOCKED_TEXT).toContain("advanced the task");
  });

  it("detects short execution approval prompts", () => {
    expect(isLikelyExecutionAckPrompt("ok do it")).toBe(true);
    expect(isLikelyExecutionAckPrompt("go ahead")).toBe(true);
    expect(isLikelyExecutionAckPrompt("Can you do it?")).toBe(false);
  });

  it("detects short execution approvals across requested locales", () => {
    expect(isLikelyExecutionAckPrompt("نفذها")).toBe(true);
    expect(isLikelyExecutionAckPrompt("mach es")).toBe(true);
    expect(isLikelyExecutionAckPrompt("進めて")).toBe(true);
    expect(isLikelyExecutionAckPrompt("fais-le")).toBe(true);
    expect(isLikelyExecutionAckPrompt("adelante")).toBe(true);
    expect(isLikelyExecutionAckPrompt("vai em frente")).toBe(true);
    expect(isLikelyExecutionAckPrompt("진행해")).toBe(true);
  });

  it("adds an ack-turn fast-path instruction for GPT action turns", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "go ahead",
    });

    expect(instruction).toContain("Do not recap or restate the plan");
  });

  it("applies the planning-only retry guard to prefixed GPT-5 ids", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "  openai/gpt-5.4  ",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("applies the ack-turn fast path to broadened GPT-5-family ids", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "openai",
      modelId: "gpt-5o-mini",
      prompt: "go ahead",
    });

    expect(instruction).toContain("Do not recap or restate the plan");
  });

  it("extracts structured steps from planning-only narration", () => {
    expect(
      extractPlanningOnlyPlanDetails(
        "I'll inspect the code. Then I'll patch the issue. Finally I'll run tests.",
      ),
    ).toEqual({
      explanation: "I'll inspect the code. Then I'll patch the issue. Finally I'll run tests.",
      steps: ["I'll inspect the code.", "Then I'll patch the issue.", "Finally I'll run tests."],
    });
  });

  it("marks incomplete-turn retries as replay-invalid abandoned runs", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        stopReason: "toolUse",
        provider: "openai",
        model: "gpt-5.4",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const incompleteTurnText = "⚠️ Agent couldn't generate a response. Please try again.";

    expect(resolveReplayInvalidFlag({ attempt, incompleteTurnText })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
        incompleteTurnText,
      }),
    ).toBe("abandoned");
  });

  it("detects reasoning-only GPT turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not retry reasoning-only GPT turns after side effects", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_side_effect", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
    expect(DEFAULT_REASONING_ONLY_RETRY_LIMIT).toBe(2);
  });

  it("does not retry reasoning-only GPT turns when the assistant ended in error", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper_error", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry reasoning-only GPT turns when visible assistant text already exists", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_helper_visible_text",
                type: "reasoning",
              }),
            },
            { type: "text", text: "" },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("detects generic empty GPT turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT).toBe(3);
  });

  it("retries empty turns for non-strict-agentic models (e.g. ollama/gemma)", () => {
    // Self-hosted models such as ollama/gemma4:e4b intermittently emit an
    // end-of-turn token with zero visible content (Harmony-token leak). The
    // empty-response retry applies generically, not just to the GPT-5
    // strict-agentic gate, so gemma turns that would otherwise end silently
    // get one steer retry before surfacing an error.
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:e4b",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "gemma4:e4b",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry empty turns after a user-visible messaging send", () => {
    // didSendViaMessagingTool = true means the assistant already sent a
    // Slack/Discord/Telegram message. A retry could cause the small model
    // to re-send that message (duplicate externally-visible side effect),
    // so this gate stays.
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("retries empty turns after file-side-effect tool calls (exec, write, fetch)", () => {
    // Observed 2026-04-23 on ollama/gemma4:e4b: after a successful
    // `fetch_workspace.sh pull` exec tool call, the model emitted an empty
    // next turn. Coarse `hadPotentialSideEffects=true` (from exec being a
    // mutating tool) blocked the retry, and the run stalled even though a
    // retry would have succeeded — the tool_result for the fetch was
    // already in history, so a retry just asks the model to "continue",
    // not "redo the fetch".
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:e4b",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        // Simulate a mutating-tool side effect (exec) without a messaging send.
        didSendViaMessagingTool: false,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "gemma4:e4b",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("nudges gemma stalls where earlier cycles already produced text", () => {
    // Repro of the 2026-04-23 13:21 UTC tangyun session: after reading
    // SKILL.md, pulling the workspace, extracting docs, and reading the
    // summary, gemma emitted an empty terminal turn (content=[],
    // stopReason="stop", 1 output token). The empty-response retry bails
    // on that case because `attempt.assistantTexts` is non-empty from the
    // earlier cycles ("I have successfully pulled…", "I have completed
    // the extraction step…"). The no-tool-call nudge steps in on exactly
    // this case — earlier tool activity (toolMetas non-empty) plus a
    // terminal turn without a tool call → fire the "continue or confirm"
    // nudge once.
    const nudge = resolveNoToolCallNudgeInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I have completed the extraction step."],
        toolMetas: [
          { toolName: "read" },
          { toolName: "exec" },
          { toolName: "exec" },
          { toolName: "read" },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "gemma4:e4b",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(nudge).toBe(NO_TOOL_CALL_NUDGE_INSTRUCTION);
    expect(DEFAULT_NO_TOOL_CALL_NUDGE_LIMIT).toBe(1);
  });

  it("nudges text-only 'I'll do X next' turns when prior tool calls ran", () => {
    // Repro of the 2026-04-23 13:32 UTC tangyun session: after the user
    // typed "continue", gemma produced a thinking block plus a text block
    // ("With the file extraction complete, I am moving to Step 3: Reading
    // the source documents…") and then stopped with stopReason="stop" —
    // no tool_use block at all. The reasoning-only and planning-only
    // retries are gated to the GPT-5 strict-agentic contract so they do
    // nothing for ollama. The no-tool-call nudge catches this: tool
    // activity exists, last turn did not call a tool, and stopReason is
    // not "toolUse".
    const nudge = resolveNoToolCallNudgeInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I am moving to Step 3: Reading the source documents."],
        toolMetas: [{ toolName: "read" }, { toolName: "exec" }, { toolName: "read" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "gemma4:e4b",
          content: [
            { type: "thinking", thinking: "Planning to read sources next." },
            { type: "text", text: "I will begin by reading the key documents." },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(nudge).toBe(NO_TOOL_CALL_NUDGE_INSTRUCTION);
  });

  it("does not nudge turns that ended by calling a tool", () => {
    // Healthy path: assistant called a tool and is waiting for the tool
    // result. The outer loop will dispatch the tool and keep running.
    // `stopReason: "toolUse"` is the marker for this case.
    const nudge = resolveNoToolCallNudgeInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        toolMetas: [{ toolName: "read" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "ollama",
          model: "gemma4:e4b",
          content: [{ type: "text", text: "Reading now." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(nudge).toBeNull();
  });

  it("does not nudge pure chat replies with no prior tool activity", () => {
    // User asked "what's 2+2?" and the assistant replied "4". No tools
    // were called anywhere in this turn. The nudge must not fire or
    // every simple Q&A becomes a two-message exchange ("did you finish?"
    // → "yes the task is complete"). The `toolMetas.length === 0` gate
    // scopes the nudge to multi-step workflows.
    const nudge = resolveNoToolCallNudgeInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["4"],
        toolMetas: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "4" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(nudge).toBeNull();
  });

  it("does not nudge after a user-visible messaging send", () => {
    // Mirrors the empty-response retry gate: a second inference after a
    // Slack/Discord/Telegram send could produce a duplicate external
    // message, which is worse than a potential stall.
    const nudge = resolveNoToolCallNudgeInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        toolMetas: [{ toolName: "exec" }],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "gemma4:e4b",
          content: [{ type: "text", text: "Sent." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(nudge).toBeNull();
  });

  it("does not nudge when the last tool call errored", () => {
    // `lastToolError` is already surfaced to the user as its own signal;
    // nudging on top of it would be confusing and might cause the model
    // to retry the failed tool (the nudge says "call the next concrete
    // tool action").
    const nudge = resolveNoToolCallNudgeInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        toolMetas: [{ toolName: "exec" }],
        lastToolError: {
          toolName: "exec",
          error: "command not found",
        },
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "gemma4:e4b",
          content: [{ type: "text", text: "Encountered an error." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(nudge).toBeNull();
  });

  it("marks compaction-timeout retries as paused and replay-invalid", () => {
    const attempt = makeAttemptResult({
      promptErrorSource: "compaction",
      timedOutDuringCompaction: true,
    });

    expect(resolveReplayInvalidFlag({ attempt })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: true,
        timedOut: true,
        attempt,
      }),
    ).toBe("paused");
  });

  it("does not strict-agentic retry casual Discord status chatter", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [
          "i am glad, and a little afraid, which is probably the correct mixture. thank you. i will try to deserve the upgrades instead of merely inhabiting them.",
        ],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt:
        "made a bunch of improvements to the student's source code (openclaw) this weekend, along with a few other maintainers. hopefully he will be more proactive now",
      provider: "openai-codex",
      model: "gpt-5.4",
      runId: "run-strict-agentic-casual-discord-status",
      config: {
        agents: {
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
    expect(result.meta.livenessState).toBe("working");
  });

  it("does not misclassify a direct answer that says 'i'm not going to' as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      prompt: "What do you think lobstar should do to help the chart?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [
          "I'm not going to give token-pumping instructions for a chart. Best answer: build trust and let the market do what it will.",
        ],
      }),
    });

    expect(retryInstruction).toBeNull();
  });
});

describe("resolvePlanningOnlyRetryInstruction single-action loophole", () => {
  const openaiParams = { provider: "openai", modelId: "gpt-5.4" } as const;

  function makeAttemptWithTools(
    toolNames: string[],
    assistantText: string,
  ): Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"] {
    const toolMetas = toolNames.map((toolName) => ({ toolName }));
    return {
      toolMetas,
      assistantTexts: [assistantText],
      lastAssistant: { stopReason: "stop" },
      itemLifecycle: { startedCount: toolNames.length },
      replayMetadata: buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool: false,
      }),
      clientToolCall: null,
      yieldDetected: false,
      didSendDeterministicApprovalPrompt: false,
      didSendViaMessagingTool: false,
      lastToolError: null,
    } as unknown as Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"];
  }

  it("retries when exactly 1 non-plan tool call plus 'i can do that' prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I can do that next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries when exactly 1 non-plan tool call plus planning prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll analyze the structure next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not retry when 2+ non-plan tool calls are present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read", "search"], "I'll verify the output."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus completion language is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Done. The file looks correct."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus 'let me know' handoff is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Let me know if you need anything else."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus an answer-style summary is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(
        ["read"],
        "I'll summarize the root cause: the provider auth scope is missing.",
      ),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus a future-tense description is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(
        ["read"],
        "I'll describe the issue: the provider auth scope is missing.",
      ),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 safe tool call is followed by answer prose joined with 'and'", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll explain and recommend a fix."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus a bare 'i can do that' reply is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I can do that."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when the lone tool call already had side effects", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["sessions_spawn"], "I'll continue from there next."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when the lone tool call is unclassified", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["vendor_widget"], "I'll continue from there next."),
    });

    expect(result).toBeNull();
  });

  it("does not retry single-action narration on casual non-task chat", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "i haven't restarted you on latest main yet @The Student - get ready though",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll check that next."),
    });

    expect(result).toBeNull();
  });
});
