import { describe, expect, it } from "vitest";
import { normalizeAsyncUserQuestions, normalizeUserQuestions, questionReply, validateUserAnswers } from "../src/agents/questions";

describe("interactive question transport", () => {
  const questions = [
    { id: "format", question: "Which format?", header: "Format", options: [{ label: "JSON", description: "Structured" }, { label: "Text" }], custom: false },
    { id: "notes", question: "Any notes?", header: "Notes", options: [] },
  ];
  const input = { questions };
  const answers = [{ questionId: "1", values: ["Keep Unicode: ☃"] }, { questionId: "0", values: ["JSON"] }];

  it("preserves user input, reorders by question, and maps each provider's reply", () => {
    expect(questionReply("codex", input, answers)).toEqual({ format: { answers: ["JSON"] }, notes: { answers: ["Keep Unicode: ☃"] } });
    expect(questionReply("open-code", input, answers)).toEqual([["JSON"], ["Keep Unicode: ☃"]]);
    expect(questionReply("claude-code", input, answers)).toEqual({ "Which format?": "JSON", "Any notes?": "Keep Unicode: ☃" });
  });

  it("rejects missing, duplicated, unknown and extra answers without guessing", () => {
    const normalized = normalizeUserQuestions("open-code", input);
    for (const values of [undefined, [], [answers[0]!], [answers[0]!, answers[0]!], [{ questionId: "x", values: ["JSON"] }, answers[0]!], [{ questionId: "0", values: ["XML"] }, answers[0]!], [{ questionId: "0", values: ["JSON", "Text"] }, answers[0]!]])
      expect(() => validateUserAnswers(normalized, values)).toThrow();
  });

  it("honors multi-select and rejects unsupported or secret requests", () => {
    const multi = { questions: [{ ...questions[0], multiple: true, multiSelect: true }] };
    expect(questionReply("open-code", multi, [{ questionId: "0", values: ["JSON", "Text"] }])).toEqual([["JSON", "Text"]]);
    expect(questionReply("claude-code", multi, [{ questionId: "0", values: ["JSON", "Text"] }])).toEqual({ "Which format?": "JSON, Text" });
    for (const value of [{ questions: [] }, { questions: [{ ...questions[0], isSecret: true }] }, { questions: [{ ...questions[0], options: Array(31).fill({ label: "A" }) }] }])
      expect(() => normalizeUserQuestions("codex", value)).toThrow();
    expect(() => questionReply("codex", { questions: [questions[0], questions[0]] }, answers)).toThrow(/Duplicate/);
  });

  it("normalizes non-blocking Codex asks with bare-string options and drops malformed lists", () => {
    expect(normalizeAsyncUserQuestions("codex", [{ title: "Copy .env?", options: ["Saved settings only", "Copy missing values"] }])).toEqual([
      { id: "0", question: "Copy .env?", options: [{ label: "Saved settings only" }, { label: "Copy missing values" }], multiple: false, allowCustom: true },
    ]);
    expect(normalizeAsyncUserQuestions("codex", [{ title: "Free text?", options: [] }])).toEqual([{ id: "0", question: "Free text?", options: [], multiple: false, allowCustom: true }]);
    for (const value of [undefined, [], "nope", [{ options: ["A"] }], [{ title: "Dup", options: ["A", "A"] }], [{ title: "Secret", options: [], isSecret: true }]])
      expect(normalizeAsyncUserQuestions("codex", value)).toBeUndefined();
  });
});
