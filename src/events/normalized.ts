import type { RawAgentEvent } from "./raw";
import type {
  AgentPermissionDecision,
  AgentPermissionKind,
} from "../agents/types";

export type NormalizedAgentEventType =
  | "run.started"
  | "message.started"
  | "message.injected"
  | "text.delta"
  | "reasoning.delta"
  | "tool.call.started"
  | "tool.call.delta"
  | "tool.call.completed"
  | "permission.requested"
  | "permission.resolved"
  | "message.completed"
  | "run.completed"
  | "run.error";

export interface NormalizedAgentEventBase {
  provider: string;
  runId: string;
  type: NormalizedAgentEventType;
  timestamp: string;
  raw?: RawAgentEvent;
  meta?: Record<string, unknown>;
}

export interface RunStartedEvent extends NormalizedAgentEventBase {
  type: "run.started";
}

export interface MessageStartedEvent extends NormalizedAgentEventBase {
  type: "message.started";
  /**
   * Provider-assigned identifier for the user message that started this turn.
   * Opaque to callers.
   *
   * - claude-code: the user message UUID written to the session JSONL
   * - codex: the turn id from `turn/started`
   * - open-code: the message id from `message.updated` (role=user)
   */
  messageId?: string;
}

export interface MessageInjectedEvent extends NormalizedAgentEventBase {
  type: "message.injected";
  content: string;
  /**
   * Provider-assigned identifier for the injected user message. See
   * `MessageStartedEvent.messageId` for provider-specific semantics.
   */
  messageId?: string;
}

export interface TextDeltaEvent extends NormalizedAgentEventBase {
  type: "text.delta";
  delta: string;
}

export interface ReasoningDeltaEvent extends NormalizedAgentEventBase {
  type: "reasoning.delta";
  delta: string;
}

export interface ToolCallStartedEvent extends NormalizedAgentEventBase {
  type: "tool.call.started";
  toolName: string;
  callId?: string;
  input?: unknown;
}

export interface ToolCallDeltaEvent extends NormalizedAgentEventBase {
  type: "tool.call.delta";
  toolName?: string;
  callId?: string;
  delta: string;
}

export interface ToolCallCompletedEvent extends NormalizedAgentEventBase {
  type: "tool.call.completed";
  toolName?: string;
  callId?: string;
  output?: unknown;
}

export interface PermissionRequestedEvent extends NormalizedAgentEventBase {
  type: "permission.requested";
  requestId: string;
  kind: AgentPermissionKind;
  title?: string;
  message?: string;
  input?: unknown;
  canRemember?: boolean;
}

export interface PermissionResolvedEvent extends NormalizedAgentEventBase {
  type: "permission.resolved";
  requestId: string;
  decision: AgentPermissionDecision;
  remember?: boolean;
}

export interface MessageCompletedEvent extends NormalizedAgentEventBase {
  type: "message.completed";
  text?: string;
  /**
   * Provider-assigned identifier for the assistant message that just
   * completed. Format mirrors `MessageStartedEvent.messageId` but identifies
   * the assistant turn rather than the user one.
   */
  messageId?: string;
}

export interface RunCompletedEvent extends NormalizedAgentEventBase {
  type: "run.completed";
  text?: string;
}

export interface RunErrorEvent extends NormalizedAgentEventBase {
  type: "run.error";
  error: string;
}

export type NormalizedAgentEvent =
  | RunStartedEvent
  | MessageStartedEvent
  | MessageInjectedEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartedEvent
  | ToolCallDeltaEvent
  | ToolCallCompletedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | MessageCompletedEvent
  | RunCompletedEvent
  | RunErrorEvent;

export function createNormalizedEvent<TType extends NormalizedAgentEventType>(
  type: TType,
  base: Omit<NormalizedAgentEventBase, "type" | "timestamp"> & {
    timestamp?: string;
  },
  extra?: Record<string, unknown>,
): NormalizedAgentEvent {
  return {
    type,
    provider: base.provider,
    runId: base.runId,
    timestamp: base.timestamp ?? new Date().toISOString(),
    raw: base.raw,
    meta: base.meta,
    ...(extra ?? {}),
  } as NormalizedAgentEvent;
}

export function normalizeRawAgentEvent(
  event: RawAgentEvent,
): NormalizedAgentEvent[] {
  const payload = event.payload as Record<string, unknown> | undefined;
  const common = {
    provider: event.provider,
    runId: event.runId,
    raw: event,
    timestamp: event.timestamp,
  };

  if (
    event.type === "assistant" &&
    Array.isArray(
      (payload?.message as Record<string, unknown> | undefined)?.content,
    )
  ) {
    const blocks = (payload?.message as Record<string, unknown>)
      .content as Array<Record<string, unknown>>;
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");

    return [
      createNormalizedEvent("message.started", common),
      ...(text
        ? [createNormalizedEvent("text.delta", common, { delta: text })]
        : []),
      createNormalizedEvent("message.completed", common, { text }),
      createNormalizedEvent("run.completed", common, { text }),
    ];
  }

  if (event.type.includes("delta")) {
    const delta = String(
      payload?.delta ?? payload?.text ?? payload?.["content"] ?? "",
    );
    const normalizedType = event.type.includes("reasoning")
      ? "reasoning.delta"
      : "text.delta";
    return [createNormalizedEvent(normalizedType, common, { delta })];
  }

  if (event.type.includes("tool")) {
    const toolName = String(payload?.toolName ?? payload?.tool_name ?? "tool");
    if (event.type.includes("completed") || event.type.includes("summary")) {
      return [
        createNormalizedEvent("tool.call.completed", common, {
          toolName,
          callId: payload?.callId ?? payload?.tool_use_id,
          output: payload?.output ?? payload?.result,
        }),
      ];
    }

    return [
      createNormalizedEvent("tool.call.started", common, {
        toolName,
        callId: payload?.callId ?? payload?.tool_use_id,
        input: payload?.input,
      }),
    ];
  }

  if (event.type === "result") {
    const text = String(payload?.result ?? payload?.text ?? "");
    return [createNormalizedEvent("run.completed", common, { text })];
  }

  if (event.type === "error") {
    return [
      createNormalizedEvent("run.error", common, {
        error: String(
          payload?.message ?? payload?.error ?? "Unknown agent error",
        ),
      }),
    ];
  }

  return [];
}
