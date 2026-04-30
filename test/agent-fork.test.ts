import { describe, expect, it } from "vitest";

import { Agent, AgentProvider, type AgentExecutionRequest } from "../src";
import { buildClaudeQueryOptions } from "../src/agents/providers/claude-code";

function makeClaudeRequest(overrides: {
  resumeSessionId?: string;
  forkSessionId?: string;
  forkAtMessageId?: string;
}): AgentExecutionRequest<"claude-code"> {
  return {
    runId: "run-1",
    provider: AgentProvider.ClaudeCode,
    options: { cwd: "/workspace", approvalMode: "auto" },
    run: { input: "hello", ...overrides },
  };
}

describe("fork-at-message wiring", () => {
  describe("AgentRunConfig validation", () => {
    const agent = new Agent(AgentProvider.ClaudeCode, { cwd: "/tmp" });

    it("rejects resumeSessionId together with forkSessionId", () => {
      expect(() =>
        agent.stream({
          input: "x",
          resumeSessionId: "session-a",
          forkSessionId: "session-b",
          forkAtMessageId: "msg-1",
        }),
      ).toThrow(/mutually exclusive/);
    });

    it("rejects forkSessionId without forkAtMessageId", () => {
      expect(() =>
        agent.stream({
          input: "x",
          forkSessionId: "session-b",
        }),
      ).toThrow(/forkAtMessageId/);
    });

    it("rejects forkAtMessageId without forkSessionId", () => {
      expect(() =>
        agent.stream({
          input: "x",
          forkAtMessageId: "msg-1",
        }),
      ).toThrow(/forkSessionId/);
    });
  });

  describe("claude-code", () => {
    it("passes resumeSessionAt + forkSession when forking", () => {
      const options = buildClaudeQueryOptions({
        request: makeClaudeRequest({
          forkSessionId: "session-source",
          forkAtMessageId: "msg-uuid-42",
        }),
        settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
        mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
        env: {},
      }) as Record<string, unknown>;
      expect(options.resume).toBe("session-source");
      expect(options.resumeSessionAt).toBe("msg-uuid-42");
      expect(options.forkSession).toBe(true);
    });

    it("falls back to plain resume when only resumeSessionId is set", () => {
      const options = buildClaudeQueryOptions({
        request: makeClaudeRequest({ resumeSessionId: "session-resume" }),
        settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
        mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
        env: {},
      }) as Record<string, unknown>;
      expect(options.resume).toBe("session-resume");
      expect(options.resumeSessionAt).toBeUndefined();
      expect(options.forkSession).toBeUndefined();
    });

    it("emits no resume/fork keys for a fresh run", () => {
      const options = buildClaudeQueryOptions({
        request: makeClaudeRequest({}),
        settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
        mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
        env: {},
      }) as Record<string, unknown>;
      expect(options.resume).toBeUndefined();
      expect(options.resumeSessionAt).toBeUndefined();
      expect(options.forkSession).toBeUndefined();
    });
  });
});
