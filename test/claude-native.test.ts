
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentExecutionRequest, AgentRunSink } from "../src/agents/types";
import type { BackgroundTasksEvent } from "../src/events";
import { executeNativeClaude } from "../src/agents/providers/claude-code";
import orphanedPoll from "./fixtures/claude-orphaned-poll.json";

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
      expect(await options.canUseTool!("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "ask-1", requestId: "permission-ask-1" })).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "Which theme?": "Keep the existing theme" } } });
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
        expect(await options.canUseTool!("Bash", { command: "git status" }, { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "permission-tool-1", title: "Inspect repository?" })).toMatchObject({ behavior: "allow" });
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
      const context = { signal: new AbortController().signal, toolUseID: "question", requestId: "permission-question" };
      await options.canUseTool!("AskUserQuestion", { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }] }, context);
      await options.canUseTool!("ExitPlanMode", { plan: "Implement A" }, { ...context, toolUseID: "plan", requestId: "permission-plan" });
      yield { type: "result", subtype: "success", result: "Done", is_error: false } as SDKMessage;
    })(), { close() {} }));
    const runtime = request();
    runtime.options = { ...runtime.options, approvalMode: "auto", interactiveQuestions: true, fullAccess: true };
    await executeNativeClaude(runtime, target);
    expect(target.requestPermission).toHaveBeenCalledTimes(2);
    expect(target.requestPermission).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "plan" }));
  });
});

describe("background tasks", () => {
  const system = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: "system", subtype, ...fields }) as unknown as SDKMessage;
  const changed = (tasks: Array<{ task_id: string; task_type: string; description: string; ambient?: boolean }>) => system("background_tasks_changed", { tasks });
  const success = (text: string) => ({ type: "result", subtype: "success", result: text, is_error: false }) as SDKMessage;
  const hang = () => new Promise<never>(() => {});
  const shell = { task_id: "bp6o2wveh", task_type: "local_bash", description: "Sleep for 25 seconds then print marker" };
  const backgroundEvents = (target: AgentRunSink) => vi.mocked(target.emitEvent).mock.calls
    .map(([event]) => event)
    .filter((event): event is BackgroundTasksEvent => event.type === "background.tasks")
    .map((event) => ({ waiting: event.waiting, ids: event.tasks.map((task) => task.id) }));

  it("completes without waiting for ambient watchers", async () => {
    const target = sink();
    const stopTask = vi.fn();
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield changed([{ ...shell, ambient: true }]);
      yield system("task_started", { ...shell, is_backgrounded: true });
      yield success("Done");
      await hang();
    })(), { close() {}, stopTask }));
    await executeNativeClaude(request(), target);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Done" }));
    expect(backgroundEvents(target)).toEqual([]);
    expect(stopTask).not.toHaveBeenCalled();
  });

  it("drains coalesced task results, retaining the last non-empty answer", async () => {
    const target = sink();
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("session_state_changed", { state: "running" });
      yield changed([shell]);
      yield success("Started");
      yield changed([]);
      yield system("init", { session_id: "s" });
      // 0.3.274 acknowledges coalesced notifications with empty, zero-turn
      // results, followed by the one model response for the whole batch.
      yield { ...success(""), num_turns: 0 } as SDKMessage;
      expect(target.complete).not.toHaveBeenCalled();
      yield success("Both background tasks finished.");
      yield { ...success(""), num_turns: 0 } as SDKMessage;
      yield system("session_state_changed", { state: "idle" });
      throw new Error("Must finish on idle");
    })(), { close() {} }));
    await executeNativeClaude(request(), target, { graceMs: 20 });
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Both background tasks finished." }));
  });

  it("waits for the CLI idle barrier after a task finishes mid-turn", async () => {
    const target = sink();
    const close = vi.fn();
    state.query.mockImplementation(({ options }: { options: Options }) => Object.assign((async function* () {
      expect(options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
      expect(options.hooks?.Stop).toBeUndefined();
      yield system("session_state_changed", { state: "running" });
      yield changed([shell]);
      yield changed([]);
      yield success("Initial answer");
      // Empty snapshot + result with queued_turn_count=0 is insufficient:
      // system-generated notification turns are not in that count.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(target.complete).not.toHaveBeenCalled();
      yield system("init", { session_id: "s" });
      yield success("Notification reply");
      yield system("session_state_changed", { state: "idle" });
      throw new Error("Must settle at idle without another read or grace");
    })(), { close }));
    await executeNativeClaude(request(), target, { graceMs: 1 });
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Notification reply" }));
    expect(close).toHaveBeenCalledOnce();
    expect(backgroundEvents(target).at(-1)).toEqual({ waiting: false, ids: [] });
  });

  it("keeps waiting when the session is idle but a task is still running", async () => {
    const target = sink();
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("session_state_changed", { state: "running" });
      yield changed([shell]);
      yield success("Launched");
      yield system("session_state_changed", { state: "idle" });
      expect(target.complete).not.toHaveBeenCalled();
      expect(backgroundEvents(target).at(-1)).toEqual({ waiting: true, ids: [shell.task_id] });
      yield changed([]);
      // An earlier idle must not be reused for a later task snapshot.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(target.complete).not.toHaveBeenCalled();
      yield system("session_state_changed", { state: "running" });
      yield system("init", { session_id: "s" });
      yield success("Finished");
      yield system("session_state_changed", { state: "idle" });
      await hang();
    })(), { close() {} }));
    await executeNativeClaude(request(), target, { graceMs: 1 });
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Finished" }));
  });

  it("bounds a genuinely live forgotten poll without injecting model cleanup", async () => {
    const target = sink();
    const runtime = request();
    runtime.options.backgroundTaskTimeoutMs = 20;
    const stopTask = vi.fn(async () => {});
    state.query.mockImplementation(({ options }: { options: Options }) => Object.assign((async function* () {
      expect(options.hooks?.Stop).toBeUndefined();
      yield system("session_state_changed", { state: "running" });
      for (const event of orphanedPoll) yield event as SDKMessage;
      yield success("All three probes are stopped.");
      yield system("session_state_changed", { state: "idle" });
      await hang();
    })(), { close() {}, stopTask }));
    await executeNativeClaude(runtime, target);
    expect(stopTask).toHaveBeenCalledExactlyOnceWith("bcdvi89ub");
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "All three probes are stopped." }));
  });

  it("stays open for a background shell and completes with the follow-up turn's result", async () => {
    const order: string[] = [];
    const target = sink();
    target.complete = vi.fn(() => { order.push("complete"); });
    const close = vi.fn(() => { order.push("close"); });
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield system("task_started", { ...shell, tool_use_id: "toolu_1", is_backgrounded: true });
      yield changed([shell]);
      yield success("STARTED");
      yield changed([]);
      yield system("task_notification", { task_id: shell.task_id, status: "completed", output_file: "", summary: "completed (exit code 0)" });
      yield system("init", { session_id: "s" });
      yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "BG_DONE_MARKER" }] } } as SDKMessage;
      yield success("BG_DONE_MARKER");
    })(), { close, stopTask: vi.fn() }));
    await executeNativeClaude(request(), target);
    expect(target.complete).toHaveBeenCalledOnce();
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "BG_DONE_MARKER" }));
    expect(backgroundEvents(target)).toEqual([
      { waiting: false, ids: ["bp6o2wveh"] },
      { waiting: true, ids: ["bp6o2wveh"] },
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
      // The follow-up turn's result may itself be followed by a queued
      // wake-up, so the run waits again until the CLI ends the stream.
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
    expect(order).toEqual(["close", "complete"]);
  });

  it("replays the Monitor transcript and completes with the fourth turn, not the one that emptied the set", async () => {
    // scratchpad/bgexp/monitor/out.log, verbatim order: the monitor finishes
    // during turn 2, so result #2 sees nothing live while the CLI already has
    // turns 3 and 4 queued behind it.
    const target = sink();
    const sleep = { task_id: "b6j25nxew", task_type: "local_bash", description: "Sleep 20 seconds then create ready.flag" };
    const monitor = { task_id: "b994oia1k", task_type: "local_bash", description: "Watching for ready.flag file" };
    const text = (value: string) => ({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: value }] } }) as SDKMessage;
    const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }) as SDKMessage;
    const toolResult = (tool_use_id: string, content: string) => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id, content }] } }) as SDKMessage;
    let drained = false;
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield toolUse("toolu_0167", "Bash", { command: "sleep 20; touch ready.flag", run_in_background: true });
      yield changed([sleep]);
      yield system("task_started", { ...sleep, tool_use_id: "toolu_0167", is_backgrounded: true });
      yield toolResult("toolu_0167", "Command running in background with ID: b6j25nxew.");
      yield toolUse("toolu_01FK", "Monitor", { command: "until [ -f ready.flag ]; do sleep 0.5; done" });
      yield changed([sleep, monitor]);
      yield system("task_started", { ...monitor, tool_use_id: "toolu_01FK", is_backgrounded: true });
      yield toolResult("toolu_01FK", "Monitor started (task b994oia1k, expires in 1m unless the source ends first)");
      yield text("ARMED");
      yield success("ARMED");
      yield changed([monitor]);
      yield system("task_updated", { task_id: sleep.task_id, patch: { status: "completed" } });
      yield system("task_notification", { task_id: sleep.task_id, status: "completed", output_file: "", summary: "Background command completed (exit code 0)" });
      yield system("init", { session_id: "s" });
      yield changed([]);
      yield system("task_updated", { task_id: monitor.task_id, patch: { status: "completed" } });
      yield system("task_notification", { task_id: monitor.task_id, status: "completed", output_file: "", summary: "Monitor stream ended" });
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Your previous response had no visible output. Please continue and produce a user-visible response.]" }] } } as SDKMessage;
      yield text("The background sleep command has completed and created the file. Waiting for Monitor to detect it...");
      yield success("The background sleep command has completed and created the file. Waiting for Monitor to detect it...");
      yield system("init", { session_id: "s" });
      yield text("MONITOR_FIRED");
      yield success("MONITOR_FIRED");
      yield system("init", { session_id: "s" });
      yield text("The Monitor has completed successfully - both the background task and the file monitoring worked as expected.");
      yield success("The Monitor has completed successfully - both the background task and the file monitoring worked as expected.");
      drained = true;
    })(), { close() {}, stopTask: vi.fn() }));
    await executeNativeClaude(request(), target);
    expect(drained).toBe(true);
    expect(target.complete).toHaveBeenCalledOnce();
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "The Monitor has completed successfully - both the background task and the file monitoring worked as expected." }));
    expect(backgroundEvents(target)).toEqual([
      { waiting: false, ids: ["b6j25nxew"] },
      { waiting: false, ids: ["b6j25nxew", "b994oia1k"] },
      { waiting: true, ids: ["b6j25nxew", "b994oia1k"] },
      { waiting: true, ids: ["b994oia1k"] },
      { waiting: false, ids: ["b994oia1k"] },
      { waiting: false, ids: [] },
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
  });

  it("keeps the wake-up of a shell that finished before its own turn ended", async () => {
    // Model backgrounds a short command and keeps working in the foreground:
    // the completion lands before result #1 and the CLI's follow-up turn
    // starts right after it.
    const target = sink();
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell]);
      yield changed([]);
      yield system("task_notification", { task_id: shell.task_id, status: "completed", output_file: "", summary: "completed (exit code 0)" });
      yield success("STARTED");
      yield system("init", { session_id: "s" });
      yield success("BG_DONE_MARKER");
    })(), { close() {}, stopTask: vi.fn() }));
    await executeNativeClaude(request(), target);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "BG_DONE_MARKER" }));
  });

  it("settles on the remembered result when the transport fails during the wait", async () => {
    const target = sink();
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell]);
      yield success("STARTED");
      throw new Error("Claude Code process exited with code 1");
    })(), { close() {}, stopTask: vi.fn() }));
    await executeNativeClaude(request(), target);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "STARTED" }));
    expect(target.fail).not.toHaveBeenCalled();
    expect(backgroundEvents(target).at(-1)).toEqual({ waiting: false, ids: [] });
  });

  it("still fails when the transport dies before any result", async () => {
    const target = sink();
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell]);
      throw new Error("Claude Code process exited with code 1");
    })(), { close() {}, stopTask: vi.fn() }));
    await expect(executeNativeClaude(request(), target)).rejects.toThrow(/exited with code 1/);
    expect(target.complete).not.toHaveBeenCalled();
  });

  it("bounds the run's total waiting time rather than each wait", async () => {
    const target = sink();
    const stopTask = vi.fn<(id: string) => Promise<void>>(async () => {});
    const runtime = request();
    runtime.options.backgroundTaskTimeoutMs = 300;
    const startedAt = Date.now();
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell]);
      yield success("FIRST");
      // The model is woken after 200ms of waiting and ends another turn
      // with the shell still live: only 100ms of budget is left.
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield system("init", { session_id: "s" });
      yield success("SECOND");
      await hang();
    })(), { close() {}, stopTask }));
    await executeNativeClaude(runtime, target);
    expect(Date.now() - startedAt).toBeLessThan(450);
    expect(stopTask).toHaveBeenCalledWith("bp6o2wveh");
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "SECOND" }));
  });

  it("does not hang on a stop_task the CLI never answers", async () => {
    const target = sink();
    const runtime = request();
    runtime.options.backgroundTaskTimeoutMs = 20;
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell]);
      yield success("STARTED");
      await hang();
    })(), { close() {}, stopTask: () => hang() }));
    await executeNativeClaude(runtime, target, { stopTimeoutMs: 20 });
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "STARTED" }));
  });

  it("settles with the last result after the grace when the set empties and no turn follows", async () => {
    const target = sink();
    const stopTask = vi.fn();
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell]);
      yield success("STARTED");
      yield changed([]);
      await hang();
    })(), { close() {}, stopTask }));
    await executeNativeClaude(request(), target, { graceMs: 20 });
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "STARTED" }));
    expect(stopTask).not.toHaveBeenCalled();
    expect(backgroundEvents(target).at(-1)).toEqual({ waiting: false, ids: [] });
  });

  it("stops leftover tasks and completes with the last result when the ceiling expires", async () => {
    const target = sink();
    const stopTask = vi.fn<(id: string) => Promise<void>>(async () => {});
    const runtime = request();
    runtime.options.backgroundTaskTimeoutMs = 20;
    const agent = { task_id: "a892e8ac41885d4e6", task_type: "local_agent", description: "Background sleep test" };
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell, agent]);
      yield success("LAUNCHED");
      await hang();
    })(), { close() {}, stopTask }));
    await executeNativeClaude(runtime, target);
    expect(stopTask.mock.calls.map(([id]) => id)).toEqual(["bp6o2wveh", "a892e8ac41885d4e6"]);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "LAUNCHED" }));
    expect(target.fail).not.toHaveBeenCalled();
    expect(backgroundEvents(target).at(-1)).toEqual({ waiting: false, ids: [] });
  });

  it("keeps the legacy settle-at-first-result behaviour when backgroundTaskTimeoutMs is 0", async () => {
    const target = sink();
    const close = vi.fn();
    const runtime = request();
    runtime.options.backgroundTaskTimeoutMs = 0;
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell]);
      yield success("STARTED");
      await hang();
    })(), { close, stopTask: vi.fn() }));
    await executeNativeClaude(runtime, target);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "STARTED" }));
    expect(backgroundEvents(target)).toEqual([{ waiting: false, ids: ["bp6o2wveh"] }]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("surfaces an abort while waiting as a cancellation", async () => {
    const target = sink();
    let abort: (() => Promise<void>) | undefined;
    target.setAbort = (handler) => { abort = handler; };
    state.query.mockImplementation(() => Object.assign((async function* () {
      yield system("init", { session_id: "s" });
      yield changed([shell]);
      yield success("STARTED");
      await abort!();
    })(), { close() {}, stopTask: vi.fn() }));
    await executeNativeClaude(request(), target);
    expect(target.cancel).toHaveBeenCalledOnce();
    expect(target.complete).not.toHaveBeenCalled();
  });

  it("bounds the CLI's own wind-down unless the caller set it", async () => {
    delete process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
    let seen: Options | undefined;
    state.query.mockImplementation(({ options }: { options: Options }) => {
      seen = options;
      return Object.assign((async function* () { yield success("Done"); })(), { close() {} });
    });
    await executeNativeClaude(request(), sink());
    expect(seen?.env?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe("30000");
    const runtime = request();
    runtime.options.env = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" };
    await executeNativeClaude(runtime, sink());
    expect(seen?.env?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe("0");
  });
});
