import { describe, expect, it } from "vitest";
import {
  BackgroundTaskTracker,
  DEFAULT_BACKGROUND_TASK_TIMEOUT_MS,
  applyCliBackgroundWaitCeiling,
  resolveBackgroundTaskTimeoutMs,
} from "../src/agents/background-tasks";

// Message shapes copied from the CLI 2.1.270 streaming-input experiments
// (background bash, Monitor, background subagent, CronCreate), trimmed to
// the fields the tracker reads.
const system = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: "system", subtype, ...fields });
const result = (text: string) => ({ type: "result", subtype: "success", result: text, is_error: false });
const assistant = (content: unknown[], parent_tool_use_id: string | null = null) => ({ type: "assistant", parent_tool_use_id, message: { role: "assistant", content } });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const toolResult = (tool_use_id: string, content: unknown, extra: Record<string, unknown> = {}, parent_tool_use_id: string | null = null) => ({ type: "user", parent_tool_use_id, message: { role: "user", content: [{ type: "tool_result", tool_use_id, content, ...extra }] } });
const changed = (tasks: Array<{ task_id: string; task_type: string; description: string }>) => system("background_tasks_changed", { tasks });
const ids = (tracker: BackgroundTaskTracker) => tracker.liveTasks().map((task) => task.id);

describe("BackgroundTaskTracker", () => {
  it("follows a background shell through its notification and the CLI's follow-up turn", () => {
    const tracker = new BackgroundTaskTracker();
    expect(tracker.ingest(system("init"))).toBe(false);
    expect(tracker.hasSeenBackgroundWork()).toBe(false);
    tracker.ingest(assistant([toolUse("toolu_019sER", "Bash", { command: "sleep 25; echo BG_DONE_MARKER", run_in_background: true })]));
    tracker.ingest(changed([{ task_id: "bp6o2wveh", task_type: "local_bash", description: "Sleep for 25 seconds then print marker" }]));
    expect(tracker.hasSeenBackgroundWork()).toBe(true);
    expect(tracker.liveTasks()).toEqual([{ id: "bp6o2wveh", type: "local_bash", description: "Sleep for 25 seconds then print marker" }]);
    tracker.ingest(system("task_started", { task_id: "bp6o2wveh", tool_use_id: "toolu_019sER", description: "Sleep for 25 seconds then print marker", is_backgrounded: true, task_type: "local_bash" }));
    expect(ids(tracker)).toEqual(["bp6o2wveh"]);
    tracker.ingest(toolResult("toolu_019sER", "Command running in background with ID: bp6o2wveh."));
    expect(tracker.ingest(assistant([{ type: "text", text: "STARTED" }]))).toBe(false);
    expect(tracker.ingest(result("STARTED"))).toBe(false);
    expect(ids(tracker)).toEqual(["bp6o2wveh"]);
    tracker.ingest(changed([]));
    expect(ids(tracker)).toEqual([]);
    tracker.ingest(system("task_updated", { task_id: "bp6o2wveh", patch: { status: "completed", end_time: 1789549937304 } }));
    tracker.ingest(system("task_notification", { task_id: "bp6o2wveh", tool_use_id: "toolu_019sER", status: "completed", output_file: "/tmp/bp6o2wveh.output", summary: "Background command completed (exit code 0)" }));
    expect(tracker.ingest(system("init"))).toBe(true);
    expect(tracker.ingest(assistant([toolUse("toolu_01Lnk", "Read", { file_path: "/tmp/bp6o2wveh.output" })]))).toBe(false);
    expect(tracker.ingest(result("BG_DONE_MARKER"))).toBe(false);
  });

  it("follows the Monitor transcript: a task finishing mid-turn leaves nothing live at that turn's result", () => {
    // scratchpad/bgexp/monitor/out.log, 26.2s-70.4s, message order verbatim.
    const tracker = new BackgroundTaskTracker();
    const sleep = { task_id: "b6j25nxew", task_type: "local_bash", description: "Sleep 20 seconds then create ready.flag" };
    const monitor = { task_id: "b994oia1k", task_type: "local_bash", description: "Watching for ready.flag file" };
    tracker.ingest(system("init"));
    tracker.ingest(assistant([toolUse("toolu_0167", "Bash", { command: "sleep 20; touch ready.flag", run_in_background: true })]));
    tracker.ingest(changed([sleep]));
    tracker.ingest(system("task_started", { ...sleep, tool_use_id: "toolu_0167", is_backgrounded: true }));
    tracker.ingest(toolResult("toolu_0167", "Command running in background with ID: b6j25nxew."));
    tracker.ingest(assistant([toolUse("toolu_01FK", "Monitor", { command: "until [ -f ready.flag ]; do sleep 0.5; done" })]));
    tracker.ingest(changed([sleep, monitor]));
    tracker.ingest(system("task_started", { ...monitor, tool_use_id: "toolu_01FK", is_backgrounded: true }));
    tracker.ingest(toolResult("toolu_01FK", "Monitor started (task b994oia1k, expires in 1m unless the source ends first)"));
    expect(ids(tracker)).toEqual(["b6j25nxew", "b994oia1k"]);
    tracker.ingest(assistant([{ type: "text", text: "ARMED" }]));
    tracker.ingest(result("ARMED"));
    // 46.3s: the sleep finishes while idle; the CLI wakes the model for it.
    tracker.ingest(changed([monitor]));
    tracker.ingest(system("task_updated", { task_id: "b6j25nxew", patch: { status: "completed" } }));
    tracker.ingest(system("task_notification", { task_id: "b6j25nxew", status: "completed", output_file: "", summary: "Background command completed (exit code 0)" }));
    expect(ids(tracker)).toEqual(["b994oia1k"]);
    expect(tracker.ingest(system("init"))).toBe(true);
    // 46.7s: the monitor fires DURING that turn; its wake-up is queued.
    tracker.ingest(changed([]));
    tracker.ingest(system("task_updated", { task_id: "b994oia1k", patch: { status: "completed" } }));
    tracker.ingest(system("task_notification", { task_id: "b994oia1k", status: "completed", output_file: "", summary: "Monitor stream ended" }));
    tracker.ingest(assistant([{ type: "text", text: "The background sleep command has completed and created the file. Waiting for Monitor to detect it..." }]));
    expect(ids(tracker)).toEqual([]);
    // 59.2s: turn 2 ends with nothing live, yet the queued wake-up starts turn 3 at once.
    tracker.ingest(result("Waiting for Monitor to detect it..."));
    expect(tracker.hasSeenBackgroundWork()).toBe(true);
    expect(tracker.ingest(system("init"))).toBe(true);
    tracker.ingest(assistant([{ type: "text", text: "MONITOR_FIRED" }]));
    tracker.ingest(result("MONITOR_FIRED"));
    // 62.6s: and turn 4 follows turn 3 the same way.
    expect(tracker.ingest(system("init"))).toBe(true);
    tracker.ingest(result("The Monitor has completed successfully"));
    expect(ids(tracker)).toEqual([]);
  });

  it("ignores subagent-owned tasks and forwarded subagent messages while a background agent runs", () => {
    const tracker = new BackgroundTaskTracker();
    const agent = { task_id: "a892e8ac41885d4e6", task_type: "local_agent", description: "Background sleep test" };
    tracker.ingest(system("init"));
    tracker.ingest(assistant([toolUse("toolu_01Wig", "Agent", { description: "Background sleep test", run_in_background: true })]));
    tracker.ingest(changed([agent]));
    tracker.ingest(system("task_started", { ...agent, tool_use_id: "toolu_01Wig", subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1 }));
    tracker.ingest(result("LAUNCHED"));
    // The subagent's own transcript is forwarded with parent_tool_use_id set.
    expect(tracker.ingest(assistant([toolUse("toolu_014t", "Bash", { command: "sleep 20" })], "toolu_01Wig"))).toBe(false);
    tracker.ingest(system("task_progress", { task_id: agent.task_id, description: "Running Wait for 20 seconds" }));
    tracker.ingest(system("task_started", { task_id: "bf51i0gwv", owned_by_subagent: true, tool_use_id: "toolu_014t", description: "Wait for 20 seconds", is_backgrounded: false, task_type: "local_bash" }));
    expect(ids(tracker)).toEqual([agent.task_id]);
    tracker.ingest(system("task_notification", { task_id: "bf51i0gwv", status: "completed", output_file: "", summary: "Wait for 20 seconds" }));
    tracker.ingest(toolResult("toolu_014t", "(Bash completed with no output)", { is_error: false }, "toolu_01Wig"));
    expect(tracker.ingest(assistant([{ type: "text", text: "SUB_DONE_MARKER" }], "toolu_01Wig"))).toBe(false);
    expect(ids(tracker)).toEqual([agent.task_id]);
    tracker.ingest(changed([]));
    tracker.ingest(system("task_updated", { task_id: agent.task_id, patch: { status: "completed" } }));
    tracker.ingest(system("task_notification", { task_id: agent.task_id, status: "completed", output_file: "/tmp/a892.output", summary: "SUB_DONE_MARKER" }));
    expect(ids(tracker)).toEqual([]);
    expect(tracker.ingest(system("init"))).toBe(true);
  });

  it("treats a scheduled one-shot as live until the cron-fired turn starts", () => {
    const tracker = new BackgroundTaskTracker();
    tracker.ingest(system("init"));
    tracker.ingest(assistant([toolUse("toolu_01UrvJ", "CronCreate", { cron: "* * * * *", prompt: "Reply with exactly CRON_FIRED", recurring: false })]));
    // Pending until the tool_result confirms the schedule took.
    expect(ids(tracker)).toEqual([]);
    tracker.ingest(toolResult("toolu_01UrvJ", "Scheduled one-shot task 0d8ff1be (Every minute)."));
    expect(tracker.liveTasks()).toEqual([{ id: "toolu_01UrvJ", type: "scheduled_wakeup", description: "Reply with exactly CRON_FIRED" }]);
    expect(tracker.ingest(assistant([{ type: "text", text: "SCHEDULED" }]))).toBe(false);
    tracker.ingest(result("SCHEDULED"));
    expect(ids(tracker)).toEqual(["toolu_01UrvJ"]);
    expect(tracker.ingest({ type: "command_lifecycle", command_uuid: "4738361a", state: "started" })).toBe(true);
    expect(ids(tracker)).toEqual([]);
    expect(tracker.ingest(system("init"))).toBe(false);
    tracker.ingest(assistant([{ type: "text", text: "CRON_FIRED" }]));
    tracker.ingest(result("CRON_FIRED"));
    expect(tracker.ingest({ type: "command_lifecycle", command_uuid: "4738361a", state: "completed" })).toBe(false);
  });

  it("keeps a scheduled wakeup armed across a turn the CLI starts for a finished shell", () => {
    const tracker = new BackgroundTaskTracker();
    const shell = { task_id: "b6j25nxew", task_type: "local_bash", description: "Long build" };
    tracker.ingest(system("init"));
    tracker.ingest(assistant([toolUse("cron-1", "CronCreate", { cron: "*/10 * * * *", prompt: "Check the deploy", recurring: false })]));
    tracker.ingest(toolResult("cron-1", "Scheduled one-shot task 0d8ff1be."));
    tracker.ingest(changed([shell]));
    tracker.ingest(result("SCHEDULED"));
    expect(ids(tracker)).toEqual(["b6j25nxew", "cron-1"]);
    // The shell finishes first: its notification turn is not the cron firing
    // (no command_lifecycle), so the schedule stays live in the CLI and here.
    tracker.ingest(changed([]));
    tracker.ingest(system("task_notification", { task_id: "b6j25nxew", status: "completed", output_file: "", summary: "done" }));
    expect(tracker.ingest(system("init"))).toBe(true);
    tracker.ingest(assistant([{ type: "text", text: "Build done; waiting for the deploy check." }]));
    tracker.ingest(result("Build done; waiting for the deploy check."));
    expect(ids(tracker)).toEqual(["cron-1"]);
    expect(tracker.ingest({ type: "command_lifecycle", command_uuid: "4738361a", state: "started" })).toBe(true);
    expect(ids(tracker)).toEqual([]);
  });

  it("drops a wakeup whose scheduling failed or that the model cancelled", () => {
    const tracker = new BackgroundTaskTracker();
    tracker.ingest(assistant([toolUse("cron-bad", "CronCreate", { cron: "* * * * *", prompt: "never" })]));
    tracker.ingest(toolResult("cron-bad", "Invalid cron expression", { is_error: true }));
    expect(ids(tracker)).toEqual([]);
    expect(tracker.hasSeenBackgroundWork()).toBe(false);
    tracker.ingest(assistant([toolUse("wake-1", "ScheduleWakeup", { prompt: "Check the build", delay: "5m" })]));
    tracker.ingest(toolResult("wake-1", "Wakeup scheduled"));
    tracker.ingest(assistant([toolUse("cron-2", "CronCreate", { cron: "*/5 * * * *" })]));
    tracker.ingest(toolResult("cron-2", "Scheduled recurring task"));
    expect(tracker.liveTasks().map((task) => task.description)).toEqual(["Check the build", "*/5 * * * *"]);
    tracker.ingest(assistant([toolUse("wake-stop", "ScheduleWakeup", { stop: true })]));
    expect(ids(tracker)).toEqual([]);
    tracker.ingest(assistant([toolUse("cron-3", "CronCreate", { cron: "0 * * * *", prompt: "hourly" })]));
    tracker.ingest(toolResult("cron-3", "Scheduled recurring task 1234abcd"));
    expect(ids(tracker)).toEqual(["cron-3"]);
    tracker.ingest(assistant([toolUse("del-1", "CronDelete", { id: "1234abcd" })]));
    expect(ids(tracker)).toEqual([]);
  });

  it("falls back to task_started / task_updated / task_notification edges on CLIs without background_tasks_changed", () => {
    const tracker = new BackgroundTaskTracker();
    tracker.ingest(system("init"));
    tracker.ingest(system("task_started", { task_id: "fg1", tool_use_id: "t1", description: "Foreground build", is_backgrounded: false, task_type: "local_bash" }));
    expect(ids(tracker)).toEqual([]);
    tracker.ingest(system("task_started", { task_id: "bg1", tool_use_id: "t2", description: "Long test run", is_backgrounded: true, task_type: "local_bash" }));
    tracker.ingest(system("task_started", { task_id: "bg2", tool_use_id: "t3", description: "Background agent", is_backgrounded: true, task_type: "local_agent" }));
    expect(tracker.liveTasks()).toEqual([{ id: "bg1", type: "local_bash", description: "Long test run" }, { id: "bg2", type: "local_agent", description: "Background agent" }]);
    tracker.ingest(result("STARTED"));
    tracker.ingest(system("task_updated", { task_id: "bg1", patch: { status: "running" } }));
    expect(ids(tracker)).toEqual(["bg1", "bg2"]);
    tracker.ingest(system("task_updated", { task_id: "bg1", patch: { status: "failed", error: "exit 1" } }));
    expect(ids(tracker)).toEqual(["bg2"]);
    tracker.ingest(system("task_notification", { task_id: "bg2", status: "completed", output_file: "", summary: "done" }));
    expect(ids(tracker)).toEqual([]);
    // A top-level assistant message after the result is the follow-up turn.
    expect(tracker.ingest(assistant([{ type: "text", text: "Both finished." }]))).toBe(true);
    expect(tracker.ingest(assistant([{ type: "text", text: "More." }]))).toBe(false);
  });

  it("treats the first main-agent partial after a result as the follow-up turn", () => {
    const tracker = new BackgroundTaskTracker();
    tracker.ingest(result("STARTED"));
    expect(tracker.ingest({ type: "stream_event", parent_tool_use_id: "sub", event: { type: "message_start" } })).toBe(false);
    expect(tracker.ingest({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } })).toBe(true);
  });
});

describe("background task settings", () => {
  it("resolves the timeout with a 30 minute default and rejects negatives", () => {
    expect(DEFAULT_BACKGROUND_TASK_TIMEOUT_MS).toBe(30 * 60_000);
    expect(resolveBackgroundTaskTimeoutMs(undefined)).toBe(DEFAULT_BACKGROUND_TASK_TIMEOUT_MS);
    expect(resolveBackgroundTaskTimeoutMs(0)).toBe(0);
    expect(resolveBackgroundTaskTimeoutMs(Infinity)).toBe(Infinity);
    expect(() => resolveBackgroundTaskTimeoutMs(-1)).toThrow(/non-negative/);
    expect(() => resolveBackgroundTaskTimeoutMs(Number.NaN)).toThrow(/non-negative/);
  });

  it("bounds the CLI wind-down unless the caller chose a value", () => {
    const env: Record<string, string> = {};
    applyCliBackgroundWaitCeiling(env);
    expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe("30000");
    const custom = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" };
    applyCliBackgroundWaitCeiling(custom);
    expect(custom.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe("0");
  });
});
