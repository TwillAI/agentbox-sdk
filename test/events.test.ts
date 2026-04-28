import { describe, expect, it } from "vitest";

import {
  normalizeRawAgentEvent,
  toAISDKEvent,
  type RawAgentEvent,
} from "../src";

describe("event normalization", () => {
  it("normalizes a completed assistant message", () => {
    const raw: RawAgentEvent = {
      provider: "claude-code",
      runId: "run-1",
      type: "assistant",
      timestamp: new Date().toISOString(),
      payload: {
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      },
    };

    const events = normalizeRawAgentEvent(raw);

    expect(events.map((event) => event.type)).toEqual([
      "message.started",
      "text.delta",
      "message.completed",
      "run.completed",
    ]);
    expect(events[1]).toMatchObject({
      type: "text.delta",
      delta: "Hello world",
    });
  });

  it("maps normalized events to AI SDK style events", () => {
    const events = normalizeRawAgentEvent({
      provider: "open-code",
      runId: "run-2",
      type: "result",
      timestamp: new Date().toISOString(),
      payload: {
        text: "Ship it",
      },
    });

    expect(events).toHaveLength(1);
    expect(toAISDKEvent(events[0]!)).toMatchObject({
      type: "response-finish",
      id: "run-2",
      provider: "open-code",
      text: "Ship it",
    });
  });

  it("maps permission events to AI SDK style events", () => {
    const requested = toAISDKEvent({
      type: "permission.requested",
      provider: "codex",
      runId: "run-3",
      timestamp: new Date().toISOString(),
      requestId: "perm-1",
      kind: "bash",
      title: "Approve command execution",
      message: "npm test",
      input: { command: "npm test" },
      canRemember: true,
    });
    const resolved = toAISDKEvent({
      type: "permission.resolved",
      provider: "codex",
      runId: "run-3",
      timestamp: new Date().toISOString(),
      requestId: "perm-1",
      decision: "allow",
      remember: true,
    });

    expect(requested).toMatchObject({
      type: "permission-requested",
      id: "run-3",
      provider: "codex",
      requestId: "perm-1",
      kind: "bash",
      canRemember: true,
    });
    expect(resolved).toMatchObject({
      type: "permission-resolved",
      id: "run-3",
      provider: "codex",
      requestId: "perm-1",
      decision: "allow",
      remember: true,
    });
  });
});
