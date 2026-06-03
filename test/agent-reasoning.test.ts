import { describe, expect, it } from "vitest";

import {
  AgentProvider,
  type AgentExecutionRequest,
  type AgentReasoningEffort,
} from "../src";
import { buildClaudeQueryOptions } from "../src/agents/providers/claude-code";
import { buildCodexTurnStartParams } from "../src/agents/providers/codex";
import {
  buildOpenCodeConfig,
  openCodeAgentSlug,
} from "../src/agents/providers/opencode";

const REASONING_LEVELS: AgentReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

function makeCodexRequest(
  reasoning?: AgentReasoningEffort,
): AgentExecutionRequest<"codex"> {
  return {
    runId: "run-1",
    provider: AgentProvider.Codex,
    options: { cwd: "/workspace", approvalMode: "auto" },
    run: { input: "hello", ...(reasoning ? { reasoning } : {}) },
  };
}

function makeClaudeRequest(
  reasoning?: AgentReasoningEffort,
): AgentExecutionRequest<"claude-code"> {
  return {
    runId: "run-1",
    provider: AgentProvider.ClaudeCode,
    options: { cwd: "/workspace", approvalMode: "auto" },
    run: { input: "hello", ...(reasoning ? { reasoning } : {}) },
  };
}

function makeOpenCodeRequest(
  reasoning?: AgentReasoningEffort,
): AgentExecutionRequest<"open-code"> {
  return {
    runId: "run-1",
    provider: AgentProvider.OpenCode,
    options: { cwd: "/workspace", approvalMode: "auto" },
    run: { input: "hello", ...(reasoning ? { reasoning } : {}) },
  };
}

describe("reasoning param", () => {
  describe("codex", () => {
    it("forwards reasoning to turn/start as effort", () => {
      for (const level of REASONING_LEVELS) {
        const params = buildCodexTurnStartParams({
          threadId: "thread-1",
          inputItems: [],
          request: makeCodexRequest(level),
        });
        expect(params.effort).toBe(level);
      }
    });

    it("sends effort: null when reasoning is unset", () => {
      const params = buildCodexTurnStartParams({
        threadId: "thread-1",
        inputItems: [],
        request: makeCodexRequest(),
      });
      expect(params.effort).toBeNull();
    });
  });

  describe("claude-code", () => {
    it("forwards reasoning to SDK options as effort", () => {
      for (const level of REASONING_LEVELS) {
        const options = buildClaudeQueryOptions({
          request: makeClaudeRequest(level),
          settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
          mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
          env: {},
        });
        expect(options.effort).toBe(level);
      }
    });

    it("omits effort when reasoning is unset", () => {
      const options = buildClaudeQueryOptions({
        request: makeClaudeRequest(),
        settingsPath: "/tmp/agentbox/claude-code/.claude/settings.json",
        mcpConfigPath: "/tmp/agentbox/claude-code/.claude/agentbox-mcp.json",
        env: {},
      });
      expect(options.effort).toBeUndefined();
    });
  });

  describe("open-code", () => {
    it("emits one agent variant per reasoning level", () => {
      const config = buildOpenCodeConfig(
        makeOpenCodeRequest().options,
        false,
      ) as {
        agent: Record<string, { reasoningEffort?: string } | undefined>;
      };
      const baseAgent = config.agent.agentbox;
      expect(baseAgent).toBeDefined();
      expect(baseAgent?.reasoningEffort).toBeUndefined();
      for (const level of REASONING_LEVELS) {
        const variant = config.agent[`agentbox-${level}`];
        expect(variant).toBeDefined();
        expect(variant?.reasoningEffort).toBe(level);
      }
    });

    it("maps reasoning to the matching agent slug", () => {
      expect(openCodeAgentSlug()).toBe("agentbox");
      for (const level of REASONING_LEVELS) {
        expect(openCodeAgentSlug(level)).toBe(`agentbox-${level}`);
      }
    });
  });
});

describe("buildOpenCodeConfig openRouter extraBody", () => {
  type OpenRouterOptions = {
    baseURL: string;
    extraBody: { transforms: string[]; plugins?: Array<{ id: string }> };
  };
  const openRouterOptions = (config: unknown): OpenRouterOptions =>
    (config as { provider: { openrouter: { options: OpenRouterOptions } } })
      .provider.openrouter.options;

  it("always applies the middle-out transform", () => {
    const options = openRouterOptions(
      buildOpenCodeConfig(makeOpenCodeRequest().options, false),
    );
    expect(options.extraBody.transforms).toEqual(["middle-out"]);
  });

  it("omits plugins when openRouterPlugins is unset", () => {
    const options = openRouterOptions(
      buildOpenCodeConfig(makeOpenCodeRequest().options, false),
    );
    expect(options.extraBody.plugins).toBeUndefined();
  });

  it("forwards openRouterPlugins into extraBody alongside middle-out", () => {
    const request = makeOpenCodeRequest();
    request.options.openRouterPlugins = [{ id: "context-compression" }];
    const options = openRouterOptions(
      buildOpenCodeConfig(request.options, false),
    );
    expect(options.extraBody.transforms).toEqual(["middle-out"]);
    expect(options.extraBody.plugins).toEqual([{ id: "context-compression" }]);
  });

  it("omits plugins when openRouterPlugins is an empty array", () => {
    const request = makeOpenCodeRequest();
    request.options.openRouterPlugins = [];
    const options = openRouterOptions(
      buildOpenCodeConfig(request.options, false),
    );
    expect(options.extraBody.plugins).toBeUndefined();
  });
});
