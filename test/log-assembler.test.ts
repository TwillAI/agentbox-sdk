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

function childStreamStart(messageId: string, parentToolUseId: string) {
  return {
    ...streamStart(messageId),
    parent_tool_use_id: parentToolUseId,
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

function childFinalAssistant(messageId: string, parentToolUseId: string) {
  return {
    ...finalAssistant(messageId),
    parent_tool_use_id: parentToolUseId,
    message: {
      id: messageId,
      role: "assistant",
      type: "message",
      model: "claude-sonnet",
      content: [
        {
          type: "tool_use",
          id: "child_tool_1",
          name: "Bash",
          input: { command: "pwd" },
        },
      ],
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

  it("preserves parent_tool_use_id on child sub-agent message snapshots", () => {
    const assembler = new ProviderLogAssembler();
    const parentToolUseId = "toolu_task_parent";
    const childMessageId = "msg_child";

    const out = [
      ...assembler.process(
        "claude-code",
        childStreamStart(childMessageId, parentToolUseId),
      ),
      ...assembler.process("claude-code", streamTextDelta("child text")),
      ...assembler.process(
        "claude-code",
        childFinalAssistant(childMessageId, parentToolUseId),
      ),
    ];

    expect(out.at(-1)).toMatchObject({
      type: "message.updated",
      messageId: childMessageId,
      parent_tool_use_id: parentToolUseId,
      message: {
        content: [{ type: "tool_use", id: "child_tool_1" }],
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

  it("preserves tool_use blocks when a same-messageId stream_event re-anchors after the assistant message", () => {
    // Regression: with the previous implementation, any upsertMessage call
    // (e.g. a second message_start for the same messageId, which fires on
    // session resume / daemon reconnect / SDK retry paths) emitted a snapshot
    // without extraBlocks, dropping the tool_use from the UI trace.
    const assembler = new ProviderLogAssembler();
    assembler.process("claude-code", streamStart(MSG_ID));
    assembler.process("claude-code", streamTextDelta("Hello world"));
    assembler.process("claude-code", finalAssistant(MSG_ID));

    const [reAnchored] = assembler.process("claude-code", streamStart(MSG_ID));

    expect(reAnchored).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        content: [
          { type: "text", text: "Hello world" },
          { type: "tool_use", id: "tool_1", name: "Bash" },
        ],
      },
    });
  });

  it("accumulates tool_use blocks across multiple assistant emissions with the same messageId", () => {
    const assembler = new ProviderLogAssembler();
    assembler.process("claude-code", streamStart(MSG_ID));
    assembler.process("claude-code", {
      type: "assistant",
      uuid: "u1",
      session_id: "sess",
      parent_tool_use_id: null,
      message: {
        id: MSG_ID,
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_a",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    const [snap] = assembler.process("claude-code", {
      type: "assistant",
      uuid: "u2",
      session_id: "sess",
      parent_tool_use_id: null,
      message: {
        id: MSG_ID,
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_b",
            name: "Read",
            input: { file_path: "/tmp/x" },
          },
        ],
      },
    });

    expect(snap).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        content: [
          { type: "tool_use", id: "tool_a", name: "Bash" },
          { type: "tool_use", id: "tool_b", name: "Read" },
        ],
      },
    });
  });

  it("replaces a tool_use in place when a later assistant emission carries the same block id", () => {
    const assembler = new ProviderLogAssembler();
    assembler.process("claude-code", streamStart(MSG_ID));
    assembler.process("claude-code", {
      type: "assistant",
      uuid: "u1",
      session_id: "sess",
      parent_tool_use_id: null,
      message: {
        id: MSG_ID,
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    const [snap] = assembler.process("claude-code", {
      type: "assistant",
      uuid: "u2",
      session_id: "sess",
      parent_tool_use_id: null,
      message: {
        id: MSG_ID,
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "Bash",
            input: { command: "ls -la" },
          },
        ],
      },
    });

    const blocks = (snap?.message as { content?: unknown[] })?.content ?? [];
    const toolBlocks = blocks.filter(
      (b): b is Record<string, unknown> =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).type === "tool_use",
    );
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      id: "tool_1",
      input: { command: "ls -la" },
    });
  });

  it("getSnapshots returns one entry per messageId in first-seen order with the latest content", () => {
    // Parity check vs. dedupeSnapshots over the full emission stream — these
    // two should agree on the in-class shape ("message.updated") for any
    // sequence of events. Used end-of-run to persist the full deduped trace
    // without going through Redis.
    const assembler = new ProviderLogAssembler();
    const emitted: Record<string, unknown>[] = [];

    // First message: two text deltas, then a final assistant carrying tool_use.
    emitted.push(...assembler.process("claude-code", streamStart("msg_1")));
    emitted.push(
      ...assembler.process("claude-code", streamTextDelta("Hello ")),
    );
    emitted.push(...assembler.process("claude-code", streamTextDelta("world")));
    emitted.push(...assembler.process("claude-code", finalAssistant("msg_1")));

    // Second message: one text delta, no final assistant.
    emitted.push(...assembler.process("claude-code", streamStart("msg_2")));
    emitted.push(...assembler.process("claude-code", streamTextDelta("next")));

    const snapshots = assembler.getSnapshots("claude-code");
    const deduped = ProviderLogAssembler.dedupeSnapshots(
      "claude-code",
      emitted,
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      type: "message.updated",
      messageId: "msg_1",
      message: {
        content: [
          { type: "text", text: "Hello world" },
          { type: "tool_use", id: "tool_1", name: "Bash" },
        ],
      },
    });
    expect(snapshots[1]).toMatchObject({
      type: "message.updated",
      messageId: "msg_2",
      message: { content: [{ type: "text", text: "next" }] },
    });
    // Equivalence with dedupeSnapshots over the emitted stream: same shape per
    // in-class entry. This stream has no passthrough events, so the deduped
    // sequence is just the in-class entries.
    const dedupedInClass = deduped.filter(
      (s) => (s as { type?: string }).type === "message.updated",
    );
    expect(snapshots).toEqual(dedupedInClass);
  });

  it("getSnapshots retains user/result passthrough events so tool_result blocks survive end-of-run persistence", () => {
    const assembler = new ProviderLogAssembler();
    const toolUseId = "toolu_bash_1";

    assembler.process("claude-code", {
      type: "assistant",
      message: {
        id: "msg_1",
        content: [
          { type: "text", text: "Running ls" },
          { type: "tool_use", id: toolUseId, name: "Bash", input: {} },
        ],
      },
    });

    assembler.process("claude-code", {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: "file1.txt\nfile2.txt",
          },
        ],
      },
    });

    assembler.process("claude-code", {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
    });

    const snapshots = assembler.getSnapshots("claude-code");

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({
      type: "message.updated",
      messageId: "msg_1",
    });
    expect(snapshots[1]).toMatchObject({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: "file1.txt\nfile2.txt",
          },
        ],
      },
    });
    expect(snapshots[2]).toMatchObject({
      type: "result",
      subtype: "success",
    });
  });

  it("seedFromSnapshots restores passthrough events so subsequent getSnapshots returns them", () => {
    const a = new ProviderLogAssembler();
    a.process("claude-code", {
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
      },
    });
    a.process("claude-code", {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        ],
      },
    });

    const seed = a.getSnapshots("claude-code");
    const b = new ProviderLogAssembler();
    b.seedFromSnapshots("claude-code", seed);

    expect(b.getSnapshots("claude-code")).toEqual(seed);
  });

  it("getSnapshots on a fresh provider returns an empty array", () => {
    const assembler = new ProviderLogAssembler();
    expect(assembler.getSnapshots("claude-code")).toEqual([]);
    expect(assembler.getSnapshots("codex")).toEqual([]);
    expect(assembler.getSnapshots("opencode")).toEqual([]);
    expect(assembler.getSnapshots("unknown")).toEqual([]);
  });

  it("seedFromSnapshots preserves tool_use blocks so a later stream_event keeps them in the snapshot", () => {
    const a = new ProviderLogAssembler();
    a.process("claude-code", streamStart(MSG_ID));
    a.process("claude-code", streamTextDelta("Hello world"));
    const seed = [...a.process("claude-code", finalAssistant(MSG_ID))];

    const b = new ProviderLogAssembler();
    b.seedFromSnapshots("claude-code", seed);
    const [reAnchored] = b.process("claude-code", streamStart(MSG_ID));

    expect(reAnchored).toMatchObject({
      type: "message.updated",
      messageId: MSG_ID,
      message: {
        content: [
          { type: "text", text: "Hello world" },
          { type: "tool_use", id: "tool_1", name: "Bash" },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCode sub-agent linkage helpers
// ---------------------------------------------------------------------------

const MAIN_SID = "session_main";
const SUB_SID_A = "session_subA";
const SUB_SID_B = "session_subB";

function ocUserMessage(sessionID: string, id: string) {
  return {
    type: "message.updated",
    properties: {
      info: { id, role: "user", sessionID },
    },
  };
}

function ocAssistantMessage(sessionID: string, id: string) {
  return {
    type: "message.updated",
    properties: {
      info: { id, role: "assistant", sessionID },
    },
  };
}

function ocTaskPart(
  sessionID: string,
  messageID: string,
  callID: string,
  partId: string,
  metadataSessionId?: string,
) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: partId,
        callID,
        messageID,
        sessionID,
        type: "tool",
        tool: "task",
        state: metadataSessionId
          ? { metadata: { sessionId: metadataSessionId } }
          : {},
      },
    },
  };
}

function ocTextPartUpdate(
  sessionID: string,
  messageID: string,
  partId: string,
  text: string,
) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: partId,
        messageID,
        sessionID,
        type: "text",
        text,
      },
    },
  };
}

function ocTextDelta(
  sessionID: string,
  messageID: string,
  partId: string,
  delta: string,
) {
  return {
    type: "message.part.delta",
    properties: {
      partID: partId,
      messageID,
      sessionID,
      field: "text",
      delta,
    },
  };
}

function partOf(snapshot: unknown): Record<string, unknown> | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const props = (snapshot as Record<string, unknown>).properties;
  if (props && typeof props === "object") {
    const part = (props as Record<string, unknown>).part;
    if (part && typeof part === "object") {
      return part as Record<string, unknown>;
    }
  }
  const ep = (snapshot as Record<string, unknown>).part;
  if (ep && typeof ep === "object") return ep as Record<string, unknown>;
  return undefined;
}

describe("ProviderLogAssembler — opencode sub-agent linkage", () => {
  it("stamps parentTaskCallId via explicit task metadata sessionId", () => {
    const a = new ProviderLogAssembler();
    // Main session opens with a user message.
    a.process("opencode", ocUserMessage(MAIN_SID, "u1"));
    // Parent emits a task tool whose metadata already carries the child sid.
    a.process(
      "opencode",
      ocTaskPart(MAIN_SID, "m_parent", "call_task_A", "part_task_A", SUB_SID_A),
    );
    // Child session announces its assistant message envelope first — the
    // assembler tracks it for messageID -> sessionID indexing but doesn't
    // stamp the envelope itself (envelopes carry no part to stamp; the
    // UI nests via parts only).
    a.process("opencode", ocAssistantMessage(SUB_SID_A, "m_child_A"));
    const [childText] = a.process(
      "opencode",
      ocTextPartUpdate(SUB_SID_A, "m_child_A", "part_child_text", "Hello"),
    );

    expect(partOf(childText)).toMatchObject({
      parentTaskCallId: "call_task_A",
    });
  });

  it("FIFO-binds an orphan child sessionID when metadata arrives late", () => {
    const a = new ProviderLogAssembler();
    a.process("opencode", ocUserMessage(MAIN_SID, "u1"));
    // Task tool emits WITHOUT metadata.sessionId — opencode hasn't
    // published the child session yet.
    a.process(
      "opencode",
      ocTaskPart(MAIN_SID, "m_parent", "call_task_A", "part_task_A"),
    );
    // Child session's first event arrives on the bus before the parent
    // task's metadata update.
    const [childText] = a.process(
      "opencode",
      ocTextPartUpdate(SUB_SID_A, "m_child_A", "part_child_text", "Hello"),
    );

    expect(partOf(childText)).toMatchObject({
      parentTaskCallId: "call_task_A",
    });
  });

  it("FIFO-binds two parallel sub-agents to their respective task tools", () => {
    const a = new ProviderLogAssembler();
    a.process("opencode", ocUserMessage(MAIN_SID, "u1"));
    // Two task tools emitted back-to-back in the same parent turn, neither
    // carrying metadata.sessionId yet.
    a.process(
      "opencode",
      ocTaskPart(MAIN_SID, "m_parent", "call_task_A", "part_task_A"),
    );
    a.process(
      "opencode",
      ocTaskPart(MAIN_SID, "m_parent", "call_task_B", "part_task_B"),
    );
    // Children stream in interleaved.
    const [aText] = a.process(
      "opencode",
      ocTextPartUpdate(SUB_SID_A, "m_child_A", "part_a_text", "from A"),
    );
    const [bText] = a.process(
      "opencode",
      ocTextPartUpdate(SUB_SID_B, "m_child_B", "part_b_text", "from B"),
    );
    const [aText2] = a.process(
      "opencode",
      ocTextPartUpdate(SUB_SID_A, "m_child_A", "part_a_text2", "from A again"),
    );

    expect(partOf(aText)).toMatchObject({ parentTaskCallId: "call_task_A" });
    expect(partOf(bText)).toMatchObject({ parentTaskCallId: "call_task_B" });
    expect(partOf(aText2)).toMatchObject({ parentTaskCallId: "call_task_A" });
  });

  it("does not stamp parentTaskCallId on the main session's own events", () => {
    const a = new ProviderLogAssembler();
    a.process("opencode", ocUserMessage(MAIN_SID, "u1"));
    a.process(
      "opencode",
      ocTaskPart(MAIN_SID, "m_parent", "call_task_A", "part_task_A", SUB_SID_A),
    );
    // Main agent emits a text part on the MAIN session — must not be
    // mis-bound to the task tool.
    const [mainText] = a.process(
      "opencode",
      ocTextPartUpdate(MAIN_SID, "m_parent", "part_main_text", "Working..."),
    );

    const part = partOf(mainText);
    expect(part).toBeTruthy();
    expect(part?.parentTaskCallId).toBeUndefined();
  });

  it("propagates parentTaskCallId through message.part.delta text streaming", () => {
    const a = new ProviderLogAssembler();
    a.process("opencode", ocUserMessage(MAIN_SID, "u1"));
    a.process(
      "opencode",
      ocTaskPart(MAIN_SID, "m_parent", "call_task_A", "part_task_A"),
    );
    // First child event is a delta (no part snapshot yet). The assembler
    // must still FIFO-bind from the delta's sessionID.
    const [first] = a.process(
      "opencode",
      ocTextDelta(SUB_SID_A, "m_child_A", "part_child_text", "Hel"),
    );
    const [second] = a.process(
      "opencode",
      ocTextDelta(SUB_SID_A, "m_child_A", "part_child_text", "lo"),
    );

    expect(partOf(first)).toMatchObject({
      parentTaskCallId: "call_task_A",
      text: "Hel",
    });
    expect(partOf(second)).toMatchObject({
      parentTaskCallId: "call_task_A",
      text: "Hello",
    });
  });

  it("seedFromSnapshots restores parentTaskCallId so later child deltas keep nesting", () => {
    const a = new ProviderLogAssembler();
    a.process("opencode", ocUserMessage(MAIN_SID, "u1"));
    a.process(
      "opencode",
      ocTaskPart(MAIN_SID, "m_parent", "call_task_A", "part_task_A", SUB_SID_A),
    );
    a.process(
      "opencode",
      ocTextPartUpdate(SUB_SID_A, "m_child_A", "part_child_text", "Hello"),
    );
    const seed = a.getSnapshots("opencode");

    const b = new ProviderLogAssembler();
    b.seedFromSnapshots("opencode", seed);
    // A late delta on the child session should still nest after reseed.
    const [more] = b.process(
      "opencode",
      ocTextDelta(SUB_SID_A, "m_child_A", "part_child_text2", " world"),
    );

    expect(partOf(more)).toMatchObject({
      parentTaskCallId: "call_task_A",
    });
  });
});
