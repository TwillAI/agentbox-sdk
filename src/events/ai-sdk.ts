import type { NormalizedAgentEvent } from "./normalized";
import type {
  AgentPermissionDecision,
  AgentPermissionKind,
} from "../agents/types";

export type AISDKEvent =
  | { type: "response-start"; id: string; provider: string }
  | { type: "text-delta"; id: string; provider: string; textDelta: string }
  | { type: "reasoning-delta"; id: string; provider: string; textDelta: string }
  | {
      type: "tool-input-start";
      id: string;
      provider: string;
      toolName: string;
      callId?: string;
    }
  | {
      type: "tool-input-delta";
      id: string;
      provider: string;
      toolName?: string;
      callId?: string;
      inputTextDelta: string;
    }
  | {
      type: "tool-output-available";
      id: string;
      provider: string;
      toolName?: string;
      callId?: string;
      output?: unknown;
    }
  | {
      type: "permission-requested";
      id: string;
      provider: string;
      requestId: string;
      kind: AgentPermissionKind;
      title?: string;
      message?: string;
      input?: unknown;
      canRemember?: boolean;
    }
  | {
      type: "permission-resolved";
      id: string;
      provider: string;
      requestId: string;
      decision: AgentPermissionDecision;
      remember?: boolean;
    }
  | { type: "response-finish"; id: string; provider: string; text?: string }
  | { type: "response-error"; id: string; provider: string; error: string };

export function toAISDKEvent(event: NormalizedAgentEvent): AISDKEvent | null {
  switch (event.type) {
    case "run.started":
      return {
        type: "response-start",
        id: event.runId,
        provider: event.provider,
      };
    case "text.delta":
      return {
        type: "text-delta",
        id: event.runId,
        provider: event.provider,
        textDelta: event.delta,
      };
    case "reasoning.delta":
      return {
        type: "reasoning-delta",
        id: event.runId,
        provider: event.provider,
        textDelta: event.delta,
      };
    case "tool.call.started":
      return {
        type: "tool-input-start",
        id: event.runId,
        provider: event.provider,
        toolName: event.toolName,
        callId: event.callId,
      };
    case "tool.call.delta":
      return {
        type: "tool-input-delta",
        id: event.runId,
        provider: event.provider,
        toolName: event.toolName,
        callId: event.callId,
        inputTextDelta: event.delta,
      };
    case "tool.call.completed":
      return {
        type: "tool-output-available",
        id: event.runId,
        provider: event.provider,
        toolName: event.toolName,
        callId: event.callId,
        output: event.output,
      };
    case "permission.requested":
      return {
        type: "permission-requested",
        id: event.runId,
        provider: event.provider,
        requestId: event.requestId,
        kind: event.kind,
        title: event.title,
        message: event.message,
        input: event.input,
        canRemember: event.canRemember,
      };
    case "permission.resolved":
      return {
        type: "permission-resolved",
        id: event.runId,
        provider: event.provider,
        requestId: event.requestId,
        decision: event.decision,
        remember: event.remember,
      };
    case "message.completed":
    case "run.completed":
      return {
        type: "response-finish",
        id: event.runId,
        provider: event.provider,
        text: event.text,
      };
    case "run.error":
      return {
        type: "response-error",
        id: event.runId,
        provider: event.provider,
        error: event.error,
      };
    default:
      return null;
  }
}

export async function* toAISDKStream(
  events: AsyncIterable<NormalizedAgentEvent>,
): AsyncIterable<AISDKEvent> {
  for await (const event of events) {
    const mapped = toAISDKEvent(event);
    if (mapped) {
      yield mapped;
    }
  }
}
