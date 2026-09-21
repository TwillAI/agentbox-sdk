import type { BackgroundTask } from "../events/normalized";

/** Default {@link AgentOptionsBase.backgroundTaskTimeoutMs}. */
export const DEFAULT_BACKGROUND_TASK_TIMEOUT_MS = 30 * 60_000;
/** Idle grace once the live set empties without a follow-up turn starting. */
export const BACKGROUND_TASK_GRACE_MS = 15_000;
/**
 * Bound on the CLI's own print-mode wind-down. Once the host disconnects
 * (daemon path) the CLI's input closes: background shells are killed 5s
 * later and background agents/workflows are waited on up to this value
 * before being killed. The CLI default is 10 minutes — far too long for a
 * sandbox to linger after the run settled.
 */
export const CLI_BACKGROUND_WAIT_CEILING_ENV =
  "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS";
export const CLI_BACKGROUND_WAIT_CEILING_MS = 30_000;

export function resolveBackgroundTaskTimeoutMs(
  value: number | undefined,
): number {
  if (value === undefined) return DEFAULT_BACKGROUND_TASK_TIMEOUT_MS;
  if (Number.isNaN(value) || value < 0) {
    throw new Error(
      "backgroundTaskTimeoutMs must be a non-negative number (Infinity waits forever).",
    );
  }
  return value;
}

/** Default the CLI wind-down ceiling unless the caller chose one. */
export function applyCliBackgroundWaitCeiling(
  env: Record<string, string>,
): void {
  env[CLI_BACKGROUND_WAIT_CEILING_ENV] ??= String(
    CLI_BACKGROUND_WAIT_CEILING_MS,
  );
}

type Msg = Record<string, unknown>;

function asRecord(value: unknown): Msg | undefined {
  return value !== null && typeof value === "object"
    ? (value as Msg)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const SCHEDULE_TOOLS = new Set(["CronCreate", "ScheduleWakeup"]);
const DONE_STATUSES = new Set(["completed", "failed", "killed"]);

/**
 * Tracks the Claude Code background work that outlives a turn, so the
 * provider knows whether a `result` is really the end of the run.
 *
 * `background_tasks_changed` is authoritative (replace semantics); the
 * `task_*` edges are only a fallback until the first snapshot. Their ordering
 * relative to snapshots is unspecified. Ambient watchers are not activity.
 * Scheduled wakeups (CronCreate /
 * ScheduleWakeup) never appear in the CLI's task set, so they are tracked
 * as pseudo tasks keyed by tool_use id. Only a fired schedule
 * (`command_lifecycle started`) or an explicit cancel drops them: a turn
 * the CLI starts for an unrelated task notification leaves the schedule
 * armed in the CLI, so it must stay live here too.
 */
export class BackgroundTaskTracker {
  private readonly tasks = new Map<string, { task: BackgroundTask; ambient: boolean }>();
  private readonly wakeups = new Map<string, BackgroundTask>();
  // tool_use seen, tool_result not yet: a failed schedule adds nothing.
  private readonly pendingWakeups = new Map<string, BackgroundTask>();
  // task_started seen while the command was still in the foreground, kept so
  // a later "moved to the background" patch can name the task it promotes.
  private readonly foreground = new Map<string, Msg>();
  private afterResult = false;
  private seenBackgroundWork = false;
  private hasTaskSnapshot = false;

  liveTasks(): BackgroundTask[] {
    return [
      ...[...this.tasks.values()].filter(({ ambient }) => !ambient).map(({ task }) => task),
      ...this.wakeups.values(),
    ];
  }

  /**
   * True once any background task or scheduled wakeup was live in this run.
   * The CLI queues a wake-up for every task that finishes and delivers it as
   * a new turn once the model is idle — including tasks that finished
   * mid-turn, whose queued turn starts right after that turn's `result`
   * with nothing live in between. After background work has been seen, wait
   * for session_state_changed/idle with an empty live set. Older CLIs that
   * never emit session state use an idle grace as a compatibility fallback.
   */
  hasSeenBackgroundWork(): boolean {
    return this.seenBackgroundWork;
  }

  /**
   * Prime a run that attaches to a parked harness with what was live when it
   * was parked: that run never saw the work start, and would otherwise take
   * its first `result` for the end of the run and tear the harness down.
   * Snapshots and schedule events replayed afterwards supersede it.
   */
  restore(tasks: BackgroundTask[]): void {
    for (const task of tasks) {
      if (!task.id) continue;
      this.seenBackgroundWork = true;
      if (task.type === "scheduled_wakeup") this.wakeups.set(task.id, task);
      else this.tasks.set(task.id, { task, ambient: false });
    }
  }

  /** Feed one SDKMessage. Returns true when it started a follow-up turn. */
  ingest(message: unknown): boolean {
    const m = asRecord(message);
    if (!m) return false;
    if (m.type === "result") {
      this.afterResult = true;
      return false;
    }
    if (m.type === "system") return this.ingestSystem(m);
    if (m.type === "command_lifecycle") {
      if (m.state !== "started") return false;
      // A scheduled wakeup firing is the only turn start that consumes it.
      this.wakeups.clear();
      return this.startTurn();
    }
    // Subagent traffic (forwarded with parent_tool_use_id) never starts a
    // top-level turn or schedules top-level wakeups.
    if (m.parent_tool_use_id) return false;
    if (m.type === "assistant") {
      const started = this.startTurn();
      this.ingestToolUses(m);
      return started;
    }
    if (m.type === "user") {
      this.ingestToolResults(m);
      return false;
    }
    // The first partial of a follow-up turn precedes its assistant message;
    // reacting here keeps the accumulated text of the new turn intact.
    if (m.type === "stream_event")
      return asRecord(m.event)?.type === "message_start" && this.startTurn();
    return false;
  }

  private startTurn(): boolean {
    if (!this.afterResult) return false;
    this.afterResult = false;
    return true;
  }

  private ingestSystem(m: Msg): boolean {
    const id = String(m.task_id ?? "");
    switch (m.subtype) {
      case "background_tasks_changed":
        this.hasTaskSnapshot = true;
        this.foreground.clear();
        this.tasks.clear();
        for (const entry of asArray(m.tasks)) {
          const task = asRecord(entry);
          if (task) this.addTask(task);
        }
        return false;
      case "task_started":
        if (this.hasTaskSnapshot || m.owned_by_subagent) return false;
        if (m.is_backgrounded === true) this.addTask(m);
        // Still in the foreground. Remember it anyway: `task_started` carries
        // the only copy of the description and type, and a command that
        // outlives its timeout is promoted to the background later, by a
        // `task_updated` patch that carries neither.
        else if (id) this.foreground.set(id, m);
        return false;
      case "task_notification":
        if (!this.hasTaskSnapshot) {
          this.tasks.delete(id);
          this.foreground.delete(id);
        }
        return false;
      case "task_updated": {
        if (this.hasTaskSnapshot) return false;
        const patch = asRecord(m.patch);
        if (DONE_STATUSES.has(String(patch?.status))) {
          this.tasks.delete(id);
          this.foreground.delete(id);
          return false;
        }
        // A foreground command moved to the background once it exceeded its
        // timeout. That promotion is how background work most often begins,
        // and on a CLI that emits no `background_tasks_changed` snapshot it
        // is the only signal that it began at all — without it the run takes
        // the turn end for the run end and the work is torn down with the CLI.
        // Only a task whose start we saw in the foreground: the patch names
        // no owner, so promoting an unknown id would also adopt a subagent's
        // own command, which is not this run's background work.
        const started = this.foreground.get(id);
        if (patch?.is_backgrounded === true && started) {
          this.foreground.delete(id);
          this.addTask(started);
        }
        return false;
      }
      case "init":
        return this.startTurn();
      default:
        return false;
    }
  }

  private addTask(task: Msg): void {
    const id = String(task.task_id ?? "");
    if (!id) return;
    const ambient = task.ambient === true || task.skip_transcript === true;
    if (!ambient) this.seenBackgroundWork = true;
    this.tasks.set(id, {
      ambient,
      task: {
        id,
        type: String(task.task_type ?? "task"),
        description: String(task.description ?? ""),
      },
    });
  }

  private ingestToolUses(m: Msg): void {
    for (const entry of asArray(asRecord(m.message)?.content)) {
      const block = asRecord(entry);
      if (block?.type !== "tool_use") continue;
      const name = String(block.name ?? "");
      const input = asRecord(block.input) ?? {};
      if (
        name === "CronDelete" ||
        (name === "ScheduleWakeup" && input.stop === true)
      ) {
        this.wakeups.clear();
        continue;
      }
      if (!SCHEDULE_TOOLS.has(name)) continue;
      const id = String(block.id ?? "");
      if (!id) continue;
      this.pendingWakeups.set(id, {
        id,
        type: "scheduled_wakeup",
        description: String(input.prompt ?? input.cron ?? name),
      });
    }
  }

  private ingestToolResults(m: Msg): void {
    for (const entry of asArray(asRecord(m.message)?.content)) {
      const block = asRecord(entry);
      if (block?.type !== "tool_result") continue;
      const id = String(block.tool_use_id ?? "");
      const pending = this.pendingWakeups.get(id);
      if (!pending) continue;
      this.pendingWakeups.delete(id);
      if (block.is_error) continue;
      this.seenBackgroundWork = true;
      this.wakeups.set(id, pending);
    }
  }
}

// Node coerces setTimeout delays above 2^31-1 to 1ms.
export const MAX_TIMER_MS = 2 ** 31 - 1;
export const STOP_TASKS_TIMEOUT_MS = 5_000;

/** Resolve `promise` or give up after `ms`; the timer never keeps the process alive. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Why a background wait ended without a follow-up turn starting. */
export type BackgroundWaitExpiry = "grace" | "ceiling" | "finished";

/**
 * Timers that end one background wait. Created when a turn ends and
 * discarded when a follow-up turn starts, so a stale expiry can never
 * settle a run that has resumed. `ceilingMs` is what is left of the run's
 * budget, so re-armed waits cannot extend it.
 */
export class BackgroundWait {
  readonly expired: Promise<BackgroundWaitExpiry>;
  private expire!: (reason: BackgroundWaitExpiry) => void;
  private grace?: NodeJS.Timeout;
  private readonly ceiling?: NodeJS.Timeout;
  private readonly startedAt = Date.now();

  constructor(private readonly graceMs: number, ceilingMs: number) {
    this.expired = new Promise((resolve) => { this.expire = resolve; });
    // Infinity = wait forever: no ceiling timer at all.
    if (Number.isFinite(ceilingMs)) {
      this.ceiling = setTimeout(() => this.expire("ceiling"), Math.min(ceilingMs, MAX_TIMER_MS));
    }
  }

  /** Arm the grace timer while nothing is live; disarm it once a task appears. */
  setIdle(idle: boolean): void {
    if (!idle) { clearTimeout(this.grace); this.grace = undefined; return; }
    this.grace ??= setTimeout(() => this.expire("grace"), this.graceMs);
  }

  /** End the wait now on the host's request ({@link BackgroundWaitFinish}). */
  finish(): void {
    this.expire("finished");
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  clear(): void {
    clearTimeout(this.grace);
    clearTimeout(this.ceiling);
  }
}

/**
 * The host's request to stop holding a run open for background work
 * (`AgentRun.finishBackgroundWait()`). It latches: asked while a turn is
 * active, it ends the wait that turn would otherwise start, so the caller
 * never has to time the request against the turn end.
 */
export class BackgroundWaitFinish {
  private requested = false;
  private wait?: BackgroundWait;

  request(): void {
    this.requested = true;
    this.wait?.finish();
  }

  /** Follow the run's current wait; a latched request ends a new one at once. */
  watch<T extends BackgroundWait | undefined>(wait: T): T {
    this.wait = wait;
    if (this.requested) wait?.finish();
    return wait;
  }
}
