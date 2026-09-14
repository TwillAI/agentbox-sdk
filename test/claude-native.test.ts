
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentExecutionRequest, AgentRunSink } from "../src/agents/types";
import { executeNativeClaude } from "../src/agents/providers/claude-code";

const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: state.query }));

function request(): AgentExecutionRequest<"claude-code"> {
  return { provider: "claude-code", runId: randomUUID(), options: { cwd: os.tmpdir(), stateDirectory: path.join(os.tmpdir(), randomUUID()), approvalMode: "interactive" }, run: { input: "Inspect this project", model: "sonnet" } };
}

function sink(): AgentRunSink {
  return { setRaw: vi.fn(), setAbort: vi.fn(), setSessionId: vi.fn(), emitRaw: vi.fn(), emitEvent: vi.fn(), requestPermission: vi.fn(async (event) => ({ requestId: event.requestId, decision: "allow" as const })), onMessage: vi.fn(), complete: vi.fn(), cancel: vi.fn(), fail: vi.fn() };
}

describe("native Claude transport", () => {
  it("uses Claude's built-in prompt and user/project settings without generated plugins or MCPs", async () => {
    const runtime = request();
    runtime.options.configuration = "native";
    state.query.mockImplementation(({ options }: { options: Options }) => {
      expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
      expect(options.settingSources).toEqual(["user", "project", "local"]);
      expect(options.settings).toBeUndefined();
      expect(options.plugins).toBeUndefined();
      expect(options.extraArgs).not.toHaveProperty("mcp-config");
      expect(options.extraArgs).not.toHaveProperty("append-system-prompt");
      return Object.assign((async function* () {
        yield { type: "result", subtype: "success", result: "Done", is_error: false } as SDKMessage;
      })(), { close() {} });
    });
    await executeNativeClaude(runtime, sink());
  });
  it("names the forked session with the pre-minted id so callers can resume it", async () => {
    const runtime = request();
    runtime.run.forkSessionId = "source-session";
    runtime.run.forkAtMessageId = "message-7";
    const target = sink();
    let seen: Options | undefined;
    state.query.mockImplementation(({ options }: { options: Options }) => {
      seen = options;
      return Object.assign((async function* () {
        yield { type: "result", subtype: "success", result: "Done", is_error: false } as SDKMessage;
      })(), { close() {} });
    });
    await executeNativeClaude(runtime, target);
    expect(seen?.resume).toBe("source-session");
    expect(seen?.resumeSessionAt).toBe("message-7");
    expect(seen?.forkSession).toBe(true);
    expect(seen?.sessionId).toBeDefined();
    expect(target.setSessionId).toHaveBeenCalledWith(seen?.sessionId);
  });
  it("omits sessionId when resuming an existing session", async () => {
    const runtime = request();
    runtime.run.resumeSessionId = "existing-session";
    let seen: Options | undefined;
    state.query.mockImplementation(({ options }: { options: Options }) => {
      seen = options;
      return Object.assign((async function* () {
        yield { type: "result", subtype: "success", result: "Done", is_error: false } as SDKMessage;
      })(), { close() {} });
    });
    await executeNativeClaude(runtime, sink());
    expect(seen?.resume).toBe("existing-session");
    expect(seen?.sessionId).toBeUndefined();
  });
  it("returns actual question answers without changing other tool input", async () => {
    const target = sink();
    target.requestPermission = vi.fn<AgentRunSink["requestPermission"]>(async (event) => ({ requestId: event.requestId, decision: "allow", answers: [{ questionId: "0", values: ["Keep the existing theme"] }] }));
    const input = { questions: [{ question: "Which theme?", header: "Theme", options: [{ label: "Light" }, { label: "Dark" }], multiSelect: false }], metadata: { source: "test" } };
    state.query.mockImplementation(({ options }: { options: Options }) => Object.assign((async function* () {
      expect(await options.canUseTool!("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "ask-1" })).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "Which theme?": "Keep the existing theme" } } });
      yield { type: "result", subtype: "success", result: "Understood", is_error: false } as SDKMessage;
    })(), { close() {} }));
    await executeNativeClaude(request(), target);
    expect(target.requestPermission).toHaveBeenCalledWith(expect.objectContaining({ kind: "question", toolName: "AskUserQuestion", questions: [expect.objectContaining({ id: "0", allowCustom: true })] }));
  });

  it("uses CLI auth, surfaces permissions, and closes the transport before completion", async () => {
    const events: string[] = [];
    const target = sink();
    target.complete = vi.fn(() => { events.push("complete"); });
    const runtime = request();
    runtime.options.customHeaders = { "X-Test": "value" };
    state.query.mockImplementation(({ options }: { options: Options }) => {
      expect(options.env?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
      expect(options.env?.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Test: value");
      const stream = (async function* () {
        expect(await options.canUseTool!("Bash", { command: "git status" }, { signal: new AbortController().signal, toolUseID: "tool-1", title: "Inspect repository?" })).toMatchObject({ behavior: "allow" });
        yield { type: "result", subtype: "success", result: "Done", is_error: false } as SDKMessage;
      })();
      return Object.assign(stream, { close: () => { events.push("close"); } });
    });
    await executeNativeClaude(runtime, target);
    expect(target.requestPermission).toHaveBeenCalledWith(expect.objectContaining({ requestId: "tool-1", title: "Inspect repository?", kind: "tool" }));
    expect(events).toEqual(["close", "complete"]);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Done" }));
  });

  it("does not report success when the CLI closes without a result", async () => {
    const target = sink();
    const close = vi.fn();
    state.query.mockImplementation(() => Object.assign((async function* () { yield { type: "system", subtype: "init" } as SDKMessage; })(), { close }));
    await expect(executeNativeClaude(request(), target)).rejects.toThrow(/before reporting a result/);
    expect(target.complete).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports cancellation after native transport cleanup", async () => {
    const target = sink();
    let abort: (() => Promise<void>) | undefined;
    target.setAbort = (handler) => { abort = handler; };
    const close = vi.fn();
    state.query.mockImplementation(() => Object.assign((async function* () {
      await abort!();
      yield { type: "result", subtype: "success", result: "", is_error: false } as SDKMessage;
    })(), { close }));
    await executeNativeClaude(request(), target);
    expect(target.cancel).toHaveBeenCalledOnce();
    expect(target.complete).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});


describe("full-access conversations", () => {
  it("still asks questions and requires plan approval under automatic tool permissions", async () => {
    const target = sink();
    target.requestPermission = vi.fn<AgentRunSink["requestPermission"]>(async (event) => ({ requestId: event.requestId, decision: "allow", ...(event.kind === "question" ? { answers: [{ questionId: "0", values: ["A"] }] } : {}) }));
    state.query.mockImplementation(({ options }: { options: Options }) => Object.assign((async function* () {
      expect(options.permissionMode).toBe("bypassPermissions");
      const context = { signal: new AbortController().signal, toolUseID: "question" };
      await options.canUseTool!("AskUserQuestion", { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }] }, context);
      await options.canUseTool!("ExitPlanMode", { plan: "Implement A" }, { ...context, toolUseID: "plan" });
      yield { type: "result", subtype: "success", result: "Done", is_error: false } as SDKMessage;
    })(), { close() {} }));
    const runtime = request();
    runtime.options = { ...runtime.options, approvalMode: "auto", interactiveQuestions: true, fullAccess: true };
    await executeNativeClaude(runtime, target);
    expect(target.requestPermission).toHaveBeenCalledTimes(2);
    expect(target.requestPermission).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "plan" }));
  });
});
