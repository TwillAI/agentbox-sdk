import { describe, expect, it } from "vitest";

import { AgentProvider, type AgentExecutionRequest } from "../src/agents/types";
import { buildClaudeQueryOptions } from "../src/agents/providers/claude-code";
import { buildClaudeWorkflowSettings } from "../src/agents/config/hooks";

function makeClaudeRequest(
  overrides: Partial<AgentExecutionRequest<"claude-code">> = {},
): AgentExecutionRequest<"claude-code"> {
  return {
    runId: "run-1",
    provider: AgentProvider.ClaudeCode,
    options: { cwd: "/workspace", approvalMode: "auto" },
    run: { input: "hello" },
    ...overrides,
  };
}

function buildOptions(request: AgentExecutionRequest<"claude-code">) {
  return buildClaudeQueryOptions({
    request,
    settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
    mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
    env: {},
  });
}

describe("claude-code query options", () => {
  it("opts into full sub-agent transcript forwarding", () => {
    expect(buildOptions(makeClaudeRequest()).forwardSubagentText).toBe(true);
  });

  it("passes through the requested reasoning effort", () => {
    const options = buildOptions(
      makeClaudeRequest({ run: { input: "hi", reasoning: "high" } }),
    );
    expect(options.effort).toBe("high");
  });

  it("forces xhigh effort when ultracode is enabled", () => {
    const options = buildOptions(
      makeClaudeRequest({
        options: { cwd: "/workspace", provider: { ultracode: true } },
        // ultracode overrides an explicit lower effort
        run: { input: "hi", reasoning: "low" },
      }),
    );
    expect(options.effort).toBe("xhigh");
  });
});

describe("claude-code workflow settings", () => {
  it("enables workflows + ultracode when on", () => {
    expect(buildClaudeWorkflowSettings(true)).toEqual({
      enableWorkflows: true,
      ultracode: true,
    });
  });

  it("emits nothing when off", () => {
    expect(buildClaudeWorkflowSettings(false)).toEqual({});
    expect(buildClaudeWorkflowSettings(undefined)).toEqual({});
  });
});
