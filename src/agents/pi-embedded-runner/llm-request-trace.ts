/**
 * Stream function wrapper that emits an agent event with the estimated
 * LLM request payload size.  This enables the protocol monitor to track
 * agent → model throughput (the outbound prompt/context sent to the LLM API).
 *
 * The wrapper measures the serialized size of the request context
 * (system prompt + messages + tools) and emits a `lifecycle` event with
 * `phase: "request"` before delegating to the inner stream function.
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../../infra/agent-events.js";

function estimateContextSize(context: {
  systemPrompt?: string;
  messages?: unknown[];
  tools?: unknown[];
}): number {
  let size = 0;
  if (context.systemPrompt) {
    size += context.systemPrompt.length;
  }
  if (context.messages) {
    try {
      size += JSON.stringify(context.messages).length;
    } catch {
      // fall back to rough estimate
      size += context.messages.length * 200;
    }
  }
  if (context.tools) {
    try {
      size += JSON.stringify(context.tools).length;
    } catch {
      size += context.tools.length * 500;
    }
  }
  return size;
}

export function wrapStreamFnWithRequestTrace(
  inner: StreamFn,
  runId: string,
  sessionKey?: string,
): StreamFn {
  return (model, context, options) => {
    const requestSize = estimateContextSize(context);
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "request",
        requestSize,
        model: model.id,
        provider: model.provider,
        messageCount: context.messages?.length ?? 0,
        toolCount: context.tools?.length ?? 0,
      },
      sessionKey,
    });
    return inner(model, context, options);
  };
}
