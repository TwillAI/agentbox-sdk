import type { AgentProviderName, AgentUserAnswer, AgentUserQuestion } from "./types";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent question");
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid agent question text");
  return value;
}

/** Normalize at the provider boundary; positional IDs stay stable for this request. */
export function normalizeUserQuestions(provider: AgentProviderName, input: unknown): AgentUserQuestion[] {
  const questions = record(input).questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 10) throw new Error("Unsupported agent question count");
  return questions.map((value, index) => {
    const item = record(value);
    // Secret requests belong to the CLI's own credential flow, never task history.
    if (item.isSecret === true) throw new Error("Secret questions cannot be answered through task history");
    const options = item.options ?? [];
    if (!Array.isArray(options) || options.length > 30) throw new Error("Unsupported agent question options");
    const result: AgentUserQuestion = {
      id: String(index),
      question: text(item.question, 10_000),
      ...(item.header ? { header: text(item.header, 200) } : {}),
      options: options.map((value) => {
        const option = record(value);
        return { label: text(option.label, 1000), ...(option.description ? { description: text(option.description, 10_000) } : {}) };
      }),
      multiple: provider === "claude-code" ? item.multiSelect === true : provider === "open-code" && item.multiple === true,
      allowCustom: provider === "open-code" ? item.custom !== false : true,
    };
    if (new Set(result.options.map((option) => option.label)).size !== result.options.length) throw new Error("Duplicate agent question options");
    if (!result.options.length && !result.allowCustom) throw new Error("Agent question has no available answers");
    return result;
  });
}

/**
 * Questions attached to a message the harness did not pause on (Codex
 * `request_user_input_async`: `[{ title, options: string[] }]`). They ride on
 * `message.completed`, so a malformed list must not fail the run: it is
 * dropped (`undefined`) instead of thrown. Blocking asks use
 * {@link normalizeUserQuestions}, whose errors keep the request pending.
 */
export function normalizeAsyncUserQuestions(provider: AgentProviderName, questions: unknown): AgentUserQuestion[] | undefined {
  if (!Array.isArray(questions) || !questions.length || questions.length > 10) return undefined;
  try {
    return questions.map((value, index) => {
      const item = record(value);
      if (item.isSecret === true) throw new Error("Secret questions cannot be relayed");
      const options = item.options ?? [];
      if (!Array.isArray(options) || options.length > 30) throw new Error("Unsupported agent question options");
      const result: AgentUserQuestion = {
        id: String(index),
        question: text(item.title ?? item.question, 10_000),
        ...(item.header ? { header: text(item.header, 200) } : {}),
        // Codex async options are bare strings; blocking shapes use {label, description}.
        options: options.map((value) => {
          if (typeof value === "string") return { label: text(value, 1000) };
          const option = record(value);
          return { label: text(option.label, 1000), ...(option.description ? { description: text(option.description, 10_000) } : {}) };
        }),
        multiple: provider === "claude-code" ? item.multiSelect === true : provider === "open-code" && item.multiple === true,
        allowCustom: provider === "open-code" ? item.custom !== false : true,
      };
      if (new Set(result.options.map((option) => option.label)).size !== result.options.length) throw new Error("Duplicate agent question options");
      return result;
    });
  } catch {
    return undefined;
  }
}

export function validateUserAnswers(questions: AgentUserQuestion[] | undefined, answers: AgentUserAnswer[] | undefined): AgentUserAnswer[] {
  if (!questions?.length || !answers || answers.length !== questions.length || new Set(answers.map((answer) => answer.questionId)).size !== answers.length) throw new Error("Answer each agent question once");
  return questions.map((question) => {
    const answer = answers.find((answer) => answer.questionId === question.id);
    if (!answer || !Array.isArray(answer.values) || !answer.values.length || answer.values.length > (question.multiple ? 30 : 1)) throw new Error("Choose an answer for each question");
    if (new Set(answer.values).size !== answer.values.length || answer.values.some((value) => typeof value !== "string" || !value.trim() || value.length > 10_000 || (!question.allowCustom && !question.options.some((option) => option.label === value)))) throw new Error("Invalid answer to agent question");
    return { questionId: question.id, values: [...answer.values] };
  });
}

/** Each transport has a different reply shape; IDs must come from the original ask. */
export function questionReply(provider: AgentProviderName, input: unknown, answers: AgentUserAnswer[]): Record<string, unknown> | string[][] {
  const normalized = normalizeUserQuestions(provider, input);
  const ordered = validateUserAnswers(normalized, answers);
  if (provider === "open-code") return ordered.map((answer) => answer.values);
  const original = record(input).questions as unknown[];
  const keys = original.map((item) => text(record(item)[provider === "codex" ? "id" : "question"], 10_000));
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate agent question IDs");
  return Object.fromEntries(keys.map((key, index) => [key, provider === "codex" ? { answers: ordered[index]!.values } : ordered[index]!.values.join(", ")]));
}
