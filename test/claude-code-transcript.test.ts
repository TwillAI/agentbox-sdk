import { describe, expect, it } from "vitest";

import {
  encodeClaudeCwd,
  forkClaudeTranscript,
} from "../src/agents/providers/claude-code-transcript";

const FIXTURE_LINES = [
  {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId: "s-original",
    message: { role: "user", content: [{ type: "text", text: "first" }] },
  },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    sessionId: "s-original",
    message: { role: "assistant", content: [{ type: "text", text: "ack 1" }] },
  },
  {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    sessionId: "s-original",
    message: { role: "user", content: [{ type: "text", text: "second" }] },
  },
  {
    type: "assistant",
    uuid: "a2",
    parentUuid: "u2",
    sessionId: "s-original",
    message: { role: "assistant", content: [{ type: "text", text: "ack 2" }] },
  },
  {
    type: "user",
    uuid: "u3",
    parentUuid: "a2",
    sessionId: "s-original",
    message: { role: "user", content: [{ type: "text", text: "third" }] },
  },
];

const FIXTURE_JSONL = FIXTURE_LINES.map((line) => JSON.stringify(line)).join(
  "\n",
);

describe("forkClaudeTranscript", () => {
  it("keeps only ancestors of the target uuid", () => {
    const result = forkClaudeTranscript(FIXTURE_JSONL, "u2", "s-new");

    const lines = result.content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { uuid: string; sessionId: string });

    expect(lines.map((line) => line.uuid)).toEqual(["u1", "a1"]);
    expect(result.keptCount).toBe(2);
    expect(result.droppedCount).toBe(3);
  });

  it("rewrites sessionId on every kept line", () => {
    const result = forkClaudeTranscript(FIXTURE_JSONL, "u3", "s-new");

    const lines = result.content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { uuid: string; sessionId: string });

    expect(lines.map((line) => line.sessionId)).toEqual([
      "s-new",
      "s-new",
      "s-new",
      "s-new",
    ]);
    expect(lines.map((line) => line.uuid)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("returns an empty transcript when forking at the very first message", () => {
    const result = forkClaudeTranscript(FIXTURE_JSONL, "u1", "s-new");

    expect(result.content).toBe("");
    expect(result.keptCount).toBe(0);
  });

  it("throws when the target uuid is not present", () => {
    expect(() =>
      forkClaudeTranscript(FIXTURE_JSONL, "missing-uuid", "s-new"),
    ).toThrow(/missing-uuid/);
  });

  it("ignores unparseable lines without throwing", () => {
    const polluted = `${FIXTURE_JSONL}\nnot-json\n`;
    const result = forkClaudeTranscript(polluted, "u3", "s-new");
    expect(result.keptCount).toBe(4);
    // 1 unparseable + descendants of u3 (none) + u3 itself = 1 dropped from
    // the original payload PLUS the unparseable line.
    expect(result.droppedCount).toBe(2);
  });

  it("trailing newline is consistent", () => {
    const result = forkClaudeTranscript(FIXTURE_JSONL, "u2", "s-new");
    expect(result.content.endsWith("\n")).toBe(true);
  });
});

describe("encodeClaudeCwd", () => {
  it("replaces slashes with dashes", () => {
    expect(encodeClaudeCwd("/Users/me/proj")).toBe("-Users-me-proj");
  });

  it("handles workspace-style paths", () => {
    expect(encodeClaudeCwd("/workspace")).toBe("-workspace");
  });
});
