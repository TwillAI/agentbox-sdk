import { describe, expect, it } from "vitest";
import { resolveHarnessCommand } from "../src/agents/commands";
import { hasInteractiveQuestions } from "../src/agents/approval";
import { buildCodexTurnStartParams } from "../src/agents/providers/codex";
import type { AgentExecutionRequest } from "../src/agents/types";

describe("native controls", () => {
  it("maps explicit commands without parsing prose or dropping attachments", () => {
    const image = { type: "image" as const, image: "data:image/png;base64,AAAA" };
    expect(resolveHarnessCommand("codex", [{ type: "text", text: "/plan improve auth" }, image])).toEqual({ mode: "plan", input: [{ type: "text", text: "improve auth" }, image] });
    expect(resolveHarnessCommand("codex", "Please /plan this")).toEqual({ input: "Please /plan this" });
    expect(resolveHarnessCommand("codex", "/goal finish migration")).toEqual({ input: "finish migration", goal: "finish migration" });
    expect(() => resolveHarnessCommand("open-code", "/goal test")).toThrow("not supported");
    expect(() => resolveHarnessCommand("codex", "/goal")).toThrow("objective");
  });
  it("keeps questions interactive when tool approvals are automatic", () => {
    expect(hasInteractiveQuestions({ approvalMode: "auto", interactiveQuestions: true })).toBe(true);
    expect(hasInteractiveQuestions({ approvalMode: "auto" })).toBe(false);
  });
  it("applies full access and native planning independently on host turns", () => {
    const request = { provider: "codex", runId: "run", options: { configuration: "native", fullAccess: true, approvalMode: "interactive" }, run: { input: "plan", model: "gpt-5.5", mode: "plan" } } as AgentExecutionRequest<"codex">;
    expect(buildCodexTurnStartParams({ request, threadId: "thread", inputItems: [] })).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, collaborationMode: { mode: "plan", settings: { model: "gpt-5.5", developer_instructions: null } } });
  });
});
