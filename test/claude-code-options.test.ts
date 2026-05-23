import { describe, expect, it } from "vitest";

import { AgentProvider, type AgentExecutionRequest } from "../src/agents/types";
import { buildClaudeQueryOptions } from "../src/agents/providers/claude-code";

function makeClaudeRequest(): AgentExecutionRequest<"claude-code"> {
  return {
    runId: "run-1",
    provider: AgentProvider.ClaudeCode,
    options: { cwd: "/workspace", approvalMode: "auto" },
    run: { input: "hello" },
  };
}

describe("claude-code query options", () => {
  it("opts into full sub-agent transcript forwarding", () => {
    const options = buildClaudeQueryOptions({
      request: makeClaudeRequest(),
      settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
      mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
      env: {},
    });

    expect(options.forwardSubagentText).toBe(true);
  });
});
