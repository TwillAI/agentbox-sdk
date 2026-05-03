import { describe, expect, it } from "vitest";

import { ProviderLogAssembler } from "../src/events";

const MSG_ID = "msg_01abc";

function streamStart(messageId: string) {
  return {
    type: "stream_event",
    uuid: "u-start",
    session_id: "sess",
    parent_tool_use_id: null,
    event: {
      type: "message_start",
      message: {
        id: messageId,
        role: "assistant",
        type: "message",
        model: "claude-sonnet",
        content: [],
      },
    },
  };
}

function streamTextDelta(text: string) {
  return {
    type: "stream_event",
    uuid: `u-${text}`,
    session_id: "sess",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  };
}

function streamThinkingDelta(thinking: string) {
  return {
    type: "stream_event",
    uuid: `u-think-${thinking}`,
    session_id: "sess",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking },
    },
  };
}

function streamMessageStop() {
  return {
    type: "stream_event",
    uuid: "u-stop",
    session_id: "sess",
    parent_tool_use_id: null,
    event: { type: "message_stop" },
  };
}

function finalAssistant(messageId: string) {
  return {
    type: "assistant",
    uuid: "asst-uuid",
    session_id: "sess",
    parent_tool_use_id: null,
    message: {
      id: messageId,
      role: "assistant",
      type: "message",
      model: "claude-sonnet",
      content: [
        { type: "text", text: "Hello world" },
        {
          type: "tool_use",
          id: "tool_1",
          name: "Bash",
          input: { command: "ls" },
        },
      ],
      stop_reason: "tool_use",
    },
  };
}

describe("ProviderLogAssembler — claude-code", () => {
  it("accumulates stream_event text deltas into message.updated snapshots", () => {
    const assembler = new ProviderLogAssembler();
    const out = [
      ...assembler.process("claude-code", streamStart(MSG_ID)),
      ...assembler.process("claude-code", streamTextDelta("Hello ")),
      ...assembler.process("claude-code", streamTextDelta("world")),
    ];

    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: { id: MSG_ID, role: "assistant", content: [] },
    });
    expect(out[1]).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        id: MSG_ID,
        role: "assistant",
        content: [{ type: "text", text: "Hello " }],
      },
    });
    expect(out[2]).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        id: MSG_ID,
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    });
  });

  it("includes both text and thinking blocks during streaming", () => {
    const assembler = new ProviderLogAssembler();
    assembler.process("claude-code", streamStart(MSG_ID));
    assembler.process("claude-code", streamTextDelta("Hi"));
    const [snap] = assembler.process(
      "claude-code",
      streamThinkingDelta("pondering"),
    );

    expect(snap).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "text", text: "Hi" },
        ],
      },
    });
  });

  it("drops non-delta stream events (message_stop, content_block_stop) from the snapshot stream", () => {
    const assembler = new ProviderLogAssembler();
    assembler.process("claude-code", streamStart(MSG_ID));
    const out = assembler.process("claude-code", streamMessageStop());
    expect(out).toEqual([]);
  });

  it("replaces accumulated state with the SDK's final assistant content and suppresses the raw event", () => {
    const assembler = new ProviderLogAssembler();
    assembler.process("claude-code", streamStart(MSG_ID));
    assembler.process("claude-code", streamTextDelta("Hello "));
    assembler.process("claude-code", streamTextDelta("wor"));

    const out = assembler.process("claude-code", finalAssistant(MSG_ID));

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        id: MSG_ID,
        role: "assistant",
        content: [
          { type: "text", text: "Hello world" },
          {
            type: "tool_use",
            id: "tool_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    // Raw "assistant" event is not surfaced — only the assembled snapshot.
    expect(out[0]).not.toHaveProperty("uuid", "asst-uuid");
    expect(out[0]?.type).toBe("message.updated");
  });

  it("preserves streamed thinking when the final assistant message has no thinking block", () => {
    // Repro for `thinking: { display: "summarized" }`: the SDK ships thinking
    // via `thinking_delta` stream events but the final `assistant` SDKMessage
    // contains no `thinking` block. The assembler must not erase the streamed
    // thinking when it sees the final message.
    const assembler = new ProviderLogAssembler();
    assembler.process("claude-code", streamStart(MSG_ID));
    assembler.process("claude-code", streamThinkingDelta("step 1, "));
    assembler.process("claude-code", streamThinkingDelta("step 2"));
    assembler.process("claude-code", streamTextDelta("Hello "));
    assembler.process("claude-code", streamTextDelta("world"));

    // Final assistant: text + tool_use only, no thinking block (summarized).
    const finalNoThinking = {
      type: "assistant",
      uuid: "asst-uuid",
      session_id: "sess",
      parent_tool_use_id: null,
      message: {
        id: MSG_ID,
        role: "assistant",
        type: "message",
        model: "claude-sonnet",
        content: [
          { type: "text", text: "Hello world" },
          {
            type: "tool_use",
            id: "tool_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    };
    const [snap] = assembler.process("claude-code", finalNoThinking);

    expect(snap).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        content: [
          { type: "thinking", thinking: "step 1, step 2" },
          { type: "text", text: "Hello world" },
          { type: "tool_use", id: "tool_1", name: "Bash" },
        ],
      },
    });
  });

  it("passes through system/user/result events untouched", () => {
    const assembler = new ProviderLogAssembler();
    const sys = { type: "system", subtype: "init", session_id: "sess" };
    const user = { type: "user", message: { role: "user", content: "hi" } };
    const result = { type: "result", subtype: "success", result: "done" };

    expect(assembler.process("claude-code", sys)).toEqual([sys]);
    expect(assembler.process("claude-code", user)).toEqual([user]);
    expect(assembler.process("claude-code", result)).toEqual([result]);
  });

  it("seedFromSnapshots restores per-message state so subsequent deltas extend the same message", () => {
    const a = new ProviderLogAssembler();
    a.process("claude-code", streamStart(MSG_ID));
    a.process("claude-code", streamTextDelta("Hello "));
    const seed = a.process("claude-code", streamTextDelta("world"));

    const b = new ProviderLogAssembler();
    b.seedFromSnapshots("claude-code", seed);
    // After seeding, a fresh message_start re-binds the current id and a delta
    // appends to the seeded text.
    b.process("claude-code", streamStart(MSG_ID));
    const [resumed] = b.process("claude-code", streamTextDelta("!"));

    expect(resumed).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        content: [{ type: "text", text: "Hello world!" }],
      },
    });
  });

  it("dedupeSnapshots collapses repeated message.updated entries by messageId", () => {
    const snapshots = [
      {
        type: "message.updated",
        messageId: MSG_ID,
        message: {
          id: MSG_ID,
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
        },
      },
      {
        type: "message.updated",
        messageId: MSG_ID,
        message: {
          id: MSG_ID,
          role: "assistant",
          content: [{ type: "text", text: "Hi there" }],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ];

    const deduped = ProviderLogAssembler.dedupeSnapshots(
      "claude-code",
      snapshots,
    );

    expect(deduped).toHaveLength(2);
    expect(deduped[0]).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: { content: [{ type: "text", text: "Hi there" }] },
    });
    expect(deduped[1]).toMatchObject({ type: "result" });
  });

  it("handles two sequential assistant messages with distinct ids", () => {
    const assembler = new ProviderLogAssembler();
    assembler.process("claude-code", streamStart("msg_1"));
    assembler.process("claude-code", streamTextDelta("first"));
    assembler.process("claude-code", {
      type: "assistant",
      uuid: "u1",
      session_id: "sess",
      parent_tool_use_id: null,
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
    });

    assembler.process("claude-code", streamStart("msg_2"));
    const [second] = assembler.process(
      "claude-code",
      streamTextDelta("second"),
    );

    expect(second).toMatchObject({
      type: "message.updated",
      messageId: "msg_2",
      message: { content: [{ type: "text", text: "second" }] },
    });
  });
});
