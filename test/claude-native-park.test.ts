import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentExecutionRequest, AgentRunSink, NativeParkBackgroundWork } from "../src/agents/types";
import type { BackgroundTasksEvent } from "../src/events";
import { executeNativeClaude } from "../src/agents/providers/claude-code";
import { findParkedNativeSession } from "../src/agents/providers/claude-native-session";
import { AsyncQueue } from "../src/shared/async-queue";

const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: state.query }));

const system = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: "system", subtype, ...fields }) as unknown as SDKMessage;
const changed = (tasks: Array<{ task_id: string; task_type: string; description: string }>) => system("background_tasks_changed", { tasks });
const success = (text: string) => ({ type: "result", subtype: "success", result: text, is_error: false }) as SDKMessage;
const running = () => system("session_state_changed", { state: "running" });
const idle = () => system("session_state_changed", { state: "idle" });
const shell = { task_id: "bq1test", task_type: "local_bash", description: "npm test" };

function sink(): AgentRunSink {
  return { setRaw: vi.fn(), setAbort: vi.fn(), setSessionId: vi.fn(), emitRaw: vi.fn(), emitEvent: vi.fn(), requestPermission: vi.fn(async (event) => ({ requestId: event.requestId, decision: "allow" as const })), onMessage: vi.fn(), complete: vi.fn(), cancel: vi.fn(), fail: vi.fn() };
}

function request(parking?: NativeParkBackgroundWork, run: Partial<AgentExecutionRequest<"claude-code">["run"]> = {}): AgentExecutionRequest<"claude-code"> {
  return {
    provider: "claude-code",
    runId: randomUUID(),
    options: { cwd: os.tmpdir(), stateDirectory: path.join(os.tmpdir(), randomUUID()), approvalMode: "interactive", configuration: "native", ...(parking ? { provider: { parkBackgroundWork: parking } } : {}) },
    run: { input: "Run the tests in the background", model: "sonnet", ...run },
  };
}

/** A CLI whose output the test writes, and whose prompts it reads. */
function fakeCli() {
  const out = new AsyncQueue<SDKMessage>();
  const prompts: SDKUserMessage[] = [];
  const close = vi.fn(() => out.finish());
  const stopTask = vi.fn(async () => {});
  let options: Options | undefined;
  state.query.mockImplementation(({ prompt, options: given }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    options = given;
    void (async () => { for await (const message of prompt) prompts.push(message); })();
    return Object.assign(out, { close, stopTask });
  });
  return { emit: (...messages: SDKMessage[]) => messages.forEach((message) => out.push(message)), prompts, close, stopTask, options: () => options! };
}

const sessionOf = (target: AgentRunSink) => vi.mocked(target.setSessionId).mock.calls[0]![0];
const lastTasks = (target: AgentRunSink) => vi.mocked(target.emitEvent).mock.calls
  .map(([event]) => event)
  .filter((event): event is BackgroundTasksEvent => event.type === "background.tasks")
  .at(-1);

/** A first run that answers with a background test run still going, and parks. */
async function parkedRun(parking: NativeParkBackgroundWork, runtime = request(parking)) {
  const cli = fakeCli();
  const target = sink();
  cli.emit(running(), changed([shell]), system("task_started", { ...shell, is_backgrounded: true }), success("Tests are running in the background."), idle());
  await executeNativeClaude(runtime, target);
  return { cli, target, sessionId: sessionOf(target) };
}

afterEach(async () => {
  state.query.mockReset();
});

describe("native parking", () => {
  it("ends the run at its answer and keeps the CLI and its work alive", async () => {
    const parking = { onWake: vi.fn(), onEnded: vi.fn() };
    const { cli, target, sessionId } = await parkedRun(parking);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Tests are running in the background." }));
    expect(cli.close).not.toHaveBeenCalled();
    expect(cli.stopTask).not.toHaveBeenCalled();
    expect(lastTasks(target)).toMatchObject({ waiting: false, parked: true, tasks: [expect.objectContaining({ id: shell.task_id })] });
    expect(findParkedNativeSession(sessionId)).toBeDefined();
    await findParkedNativeSession(sessionId)!.end();
    expect(cli.close).toHaveBeenCalledOnce();
    expect(parking.onEnded).toHaveBeenCalledOnce();
  });

  it("changes nothing for a turn that ends with nothing live", async () => {
    const parking = { onWake: vi.fn() };
    const cli = fakeCli();
    const target = sink();
    cli.emit(running(), success("Done"), idle());
    await executeNativeClaude(request(parking), target);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Done" }));
    expect(cli.close).toHaveBeenCalledOnce();
    expect(findParkedNativeSession(sessionOf(target))).toBeUndefined();
  });

  it("wakes the host for the turn the CLI starts on its own, and a wake run streams it", async () => {
    const parking = { onWake: vi.fn(), onEnded: vi.fn() };
    const { cli, sessionId } = await parkedRun(parking);
    cli.emit(changed([]), system("task_notification", { task_id: shell.task_id, status: "completed", summary: "npm test passed" }), running(), system("init", { session_id: sessionId }), success("All 212 tests pass."), idle());
    await vi.waitFor(() => expect(parking.onWake).toHaveBeenCalled());
    // A chatty turn is one wake, not one per frame.
    expect(parking.onWake).toHaveBeenCalledOnce();

    const target = sink();
    await executeNativeClaude(request(parking, { resumeSessionId: sessionId, resumeParked: true, input: "" }), target);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "All 212 tests pass." }));
    expect(state.query).toHaveBeenCalledOnce();
    // Nothing is live any more: the wake run ends the CLI with it.
    expect(cli.close).toHaveBeenCalledOnce();
    expect(findParkedNativeSession(sessionId)).toBeUndefined();
  });

  it("asks again until the host accepts the wake", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const onWake = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
      const { cli, sessionId } = await parkedRun({ onWake });
      cli.emit(changed([]), running(), system("init", { session_id: sessionId }));
      await vi.waitFor(() => expect(onWake).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(onWake).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onWake).toHaveBeenCalledTimes(3);
      await findParkedNativeSession(sessionId)!.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a follow-up take the parked CLI over, keeps its work, and parks again", async () => {
    const parking = { onWake: vi.fn(), onEnded: vi.fn() };
    const { cli, sessionId } = await parkedRun(parking);
    const target = sink();
    const followUp = executeNativeClaude(request(parking, { resumeSessionId: sessionId, input: "Anything yet?" }), target);
    await vi.waitFor(() => expect(cli.prompts).toHaveLength(2));
    expect(cli.prompts[1]!.message.content).toBe("Anything yet?");
    cli.emit(running(), system("init", { session_id: sessionId }), success("Still running; I will report back."), idle());
    await followUp;
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Still running; I will report back." }));
    expect(state.query).toHaveBeenCalledOnce();
    expect(cli.close).not.toHaveBeenCalled();
    expect(cli.stopTask).not.toHaveBeenCalled();
    expect(lastTasks(target)).toMatchObject({ parked: true, tasks: [expect.objectContaining({ id: shell.task_id })] });
    expect(parking.onWake).not.toHaveBeenCalled();
    await findParkedNativeSession(sessionId)!.end();
  });

  it("skips a turn that finished while parked when a follow-up adopts", async () => {
    const parking = { onWake: vi.fn() };
    const { cli, sessionId } = await parkedRun(parking);
    cli.emit(changed([]), running(), system("init", { session_id: sessionId }), success("Tests pass."), idle());
    await vi.waitFor(() => expect(parking.onWake).toHaveBeenCalled());
    const target = sink();
    const followUp = executeNativeClaude(request(parking, { resumeSessionId: sessionId, input: "Now commit." }), target);
    await vi.waitFor(() => expect(cli.prompts).toHaveLength(2));
    cli.emit(running(), system("init", { session_id: sessionId }), success("Committed."), idle());
    await followUp;
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Committed." }));
  });

  it("parks, rather than stopping the work, when the host finishes the wait, and keeps a read in flight", async () => {
    const parking = { onWake: vi.fn() };
    const cli = fakeCli();
    const target = sink();
    let finish = () => {};
    target.setFinishBackgroundWait = (handler) => { finish = handler; };
    // An older CLI without session-state events: the run waits after its result.
    cli.emit(changed([shell]), success("Started the tests."));
    const run = executeNativeClaude(request(parking), target);
    await vi.waitFor(() => expect(lastTasks(target)).toMatchObject({ waiting: true }));
    finish();
    await run;
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Started the tests." }));
    expect(cli.stopTask).not.toHaveBeenCalled();
    expect(cli.close).not.toHaveBeenCalled();
    // The run had a read pending when it parked; what it returns is kept.
    cli.emit(changed([]), system("init", { session_id: "s" }), success("Tests pass."));
    await vi.waitFor(() => expect(parking.onWake).toHaveBeenCalled());
    const wake = sink();
    await executeNativeClaude(request(parking, { resumeSessionId: sessionOf(target), resumeParked: true, input: "" }), wake, { graceMs: 1 });
    expect(wake.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Tests pass." }));
  });

  it("winds the CLI down when the background budget runs out", async () => {
    const parking = { onWake: vi.fn(), onEnded: vi.fn() };
    const runtime = request(parking);
    runtime.options.backgroundTaskTimeoutMs = 50;
    const { cli, sessionId } = await parkedRun(parking, runtime);
    expect(findParkedNativeSession(sessionId)).toBeDefined();
    await vi.waitFor(() => expect(cli.close).toHaveBeenCalledOnce());
    expect(parking.onEnded).toHaveBeenCalledOnce();
    expect(findParkedNativeSession(sessionId)).toBeUndefined();
  });

  it("ends the parked CLI when the CLI exits on its own", async () => {
    const parking = { onWake: vi.fn(), onEnded: vi.fn() };
    const { cli, sessionId } = await parkedRun(parking);
    cli.emit(changed([]));
    // The CLI's print-mode wind-down: output ends.
    (cli as unknown as { close: () => void }).close();
    await vi.waitFor(() => expect(parking.onEnded).toHaveBeenCalledOnce());
    expect(findParkedNativeSession(sessionId)).toBeUndefined();
  });

  it("ends the parked work when the conversation is rewound", async () => {
    const parking = { onWake: vi.fn(), onEnded: vi.fn() };
    const { sessionId } = await parkedRun(parking);
    const fork = fakeCli();
    fork.emit(success("Rewound."));
    await executeNativeClaude(request(parking, { forkSessionId: sessionId, forkAtMessageId: "m-1" }), sink());
    expect(parking.onEnded).toHaveBeenCalledOnce();
    expect(findParkedNativeSession(sessionId)).toBeUndefined();
  });

  it("stops a parked CLI when the adopting run is aborted", async () => {
    const parking = { onWake: vi.fn(), onEnded: vi.fn() };
    const { cli, sessionId } = await parkedRun(parking);
    const target = sink();
    let abort: (() => Promise<void>) | undefined;
    target.setAbort = (handler) => { abort = handler; };
    const followUp = executeNativeClaude(request(parking, { resumeSessionId: sessionId, input: "Stop that." }), target);
    await vi.waitFor(() => expect(cli.prompts).toHaveLength(2));
    await abort!();
    await followUp;
    expect(cli.close).toHaveBeenCalledOnce();
    expect(findParkedNativeSession(sessionId)).toBeUndefined();
  });

  it("declines, without interrupting, a permission nobody is attached to answer", async () => {
    const parking = { onWake: vi.fn() };
    const { cli, sessionId } = await parkedRun(parking);
    const decision = await cli.options().canUseTool!("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal, toolUseID: "t-1", requestId: "p-1" });
    expect(decision).toEqual({ behavior: "deny", message: "No user is attached to approve this request." });
    await findParkedNativeSession(sessionId)!.end();
  });

  it("settles an attach with nothing parked as nothing parked, without starting a CLI", async () => {
    const target = sink();
    await executeNativeClaude(request({ onWake: vi.fn() }, { resumeSessionId: randomUUID(), resumeParked: true, input: "" }), target);
    expect(state.query).not.toHaveBeenCalled();
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ nothingParked: true }));
  });

  it("leaves a quiet park alone when a wake run finds no turn to stream", async () => {
    const parking = { onWake: vi.fn() };
    const { cli, sessionId } = await parkedRun(parking);
    const target = sink();
    await executeNativeClaude(request(parking, { resumeSessionId: sessionId, resumeParked: true, input: "" }), target);
    expect(target.complete).toHaveBeenCalledWith(expect.objectContaining({ nothingParked: true }));
    expect(cli.close).not.toHaveBeenCalled();
    expect(findParkedNativeSession(sessionId)).toBeDefined();
    await findParkedNativeSession(sessionId)!.end();
  });

  it("waits as before without a parking option", async () => {
    const cli = fakeCli();
    const target = sink();
    let finish = () => {};
    target.setFinishBackgroundWait = (handler) => { finish = handler; };
    cli.emit(running(), changed([shell]), success("Started."), idle());
    const run = executeNativeClaude(request(), target);
    await vi.waitFor(() => expect(lastTasks(target)).toMatchObject({ waiting: true }));
    finish();
    await run;
    expect(cli.stopTask).toHaveBeenCalledExactlyOnceWith(shell.task_id);
    expect(cli.close).toHaveBeenCalledOnce();
  });
});
