import { describe, expect, it } from "vitest";

import { Agent, AgentProvider, type AgentExecutionRequest } from "../src";
import { buildClaudeQueryOptions } from "../src/agents/providers/claude-code";

function makeClaudeRequest(overrides: {
  resumeSessionId?: string;
  forkSessionId?: string;
  forkAtMessageId?: string;
  clearContext?: boolean;
}): AgentExecutionRequest<"claude-code"> {
  return {
    runId: "run-1",
    provider: AgentProvider.ClaudeCode,
    options: { cwd: "/workspace", approvalMode: "auto" },
    run: { input: "hello", ...overrides },
  };
}

describe("clearContext (fresh-session) wiring", () => {
  describe("AgentRunConfig validation", () => {
    const agent = new Agent(AgentProvider.ClaudeCode, { cwd: "/tmp" });

    it("does not throw when clearContext overrides resume + fork hints", () => {
      // clearContext takes precedence over resume/fork, so the usual
      // mutual-exclusivity guard must not fire.
      expect(() =>
        agent.stream({
          input: "x",
          clearContext: true,
          resumeSessionId: "session-a",
          forkSessionId: "session-b",
          forkAtMessageId: "msg-1",
        }),
      ).not.toThrow();
    });
  });

  describe("claude-code", () => {
    it("ignores resumeSessionId when clearContext is set", () => {
      const options = buildClaudeQueryOptions({
        request: makeClaudeRequest({
          resumeSessionId: "session-resume",
          clearContext: true,
        }),
        settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
        mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
        env: {},
      }) as Record<string, unknown>;
      expect(options.resume).toBeUndefined();
      expect(options.resumeSessionAt).toBeUndefined();
      expect(options.forkSession).toBeUndefined();
    });

    it("ignores fork hints when clearContext is set", () => {
      const options = buildClaudeQueryOptions({
        request: makeClaudeRequest({
          forkSessionId: "session-source",
          forkAtMessageId: "msg-uuid-42",
          clearContext: true,
        }),
        settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
        mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
        env: {},
      }) as Record<string, unknown>;
      expect(options.resume).toBeUndefined();
      expect(options.resumeSessionAt).toBeUndefined();
      expect(options.forkSession).toBeUndefined();
    });

    it("still resumes normally when clearContext is absent", () => {
      const options = buildClaudeQueryOptions({
        request: makeClaudeRequest({ resumeSessionId: "session-resume" }),
        settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
        mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
        env: {},
      }) as Record<string, unknown>;
      expect(options.resume).toBe("session-resume");
    });
  });
});
