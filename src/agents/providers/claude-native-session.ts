import type {
  CanUseTool,
  HookCallback,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { BackgroundTask } from "../../events";
import { AsyncQueue } from "../../shared/async-queue";
import { debugClaude } from "../../shared/debug";
import type { NativeParkBackgroundWork } from "../types";

// The in-process twin of the sandbox daemon's parked runs (see the daemon
// script in claude-code.ts): same buffer bound, same wake backoff.
const PARK_BUFFER_LIMIT = 16 * 1024 * 1024;
const WAKE_RETRY_MS = [0, 1000, 2000, 4000, 8000, 16000, 30000, 60000];
const WAKE_RETRY_CEILING_MS = 60000;
const NO_USER = "No user is attached to approve this request.";

type Next = Promise<IteratorResult<unknown>>;

/** What the run currently attached to the CLI decides for it. */
export interface NativeRunHandlers {
  canUseTool: CanUseTool;
  preToolUse: HookCallback;
}

interface Park {
  tasks: BackgroundTask[];
  parking: NativeParkBackgroundWork;
  timer?: ReturnType<typeof setTimeout>;
  waking: boolean;
  wokeAt: number;
}

const parkedSessions = new Map<string, NativeClaudeSession>();

/** The CLI parked for `sessionId` in this process, if any. */
export function findParkedNativeSession(
  sessionId: string,
): NativeClaudeSession | undefined {
  return parkedSessions.get(sessionId);
}

function turnEdges(message: unknown): { started: boolean; ended: boolean } {
  const m = message as { type?: string; subtype?: string; state?: string };
  const state =
    m.type === "system" && m.subtype === "session_state_changed"
      ? m.state
      : undefined;
  return {
    started: m.type === "system" && (m.subtype === "init" || state === "running"),
    // A turn that dies without a result would otherwise stay active forever
    // and inflate the turn count an adopting run skips; idle clears it too.
    ended: m.type === "result" || state === "idle",
  };
}

/**
 * A native Claude CLI owned by this process, which can outlive the run that
 * started it. A run whose turn ends with background work still live parks the
 * CLI here instead of waiting on it: output is buffered while nobody is
 * attached, a turn the CLI starts on its own (a task finished, a schedule
 * fired) calls the host's `onWake`, and the next run resuming the session
 * adopts the CLI instead of spawning a second one on the same session. The
 * park lasts what is left of the background budget.
 *
 * Every read of the CLI goes through {@link pull}, one at a time: an attached
 * run reads through {@link open}, a parked CLI is drained by {@link pump}, and
 * a read left in flight when one hands over to the other is passed along
 * rather than dropped.
 */
export class NativeClaudeSession {
  readonly prompt = new AsyncQueue<SDKUserMessage>();
  query?: Query;
  private iterator?: AsyncIterator<SDKMessage>;
  private handlers?: NativeRunHandlers;
  private parked?: Park;
  // Absolute end of the background budget, carried across parks so a CLI
  // that is adopted and parked again cannot extend its own ceiling.
  private parkDeadline = Infinity;
  private buffer: unknown[] = [];
  private bufferedBytes = 0;
  private bufferedResults = 0;
  private bufferOverflowed = false;
  private turnActive = false;
  private pumping?: Next;
  private ending?: Promise<void>;

  constructor(
    readonly sessionId: string,
    private readonly kill: () => Promise<void>,
  ) {}

  bind(query: Query): void {
    this.query = query;
    this.iterator = query[Symbol.asyncIterator]();
  }

  get isParked(): boolean {
    return this.parked !== undefined;
  }

  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const handlers = this.handlers;
    // Parked with nobody attached: there is no one to ask, and waiting would
    // wedge the CLI out of reach of any wake. Declining without `interrupt`
    // lets it report and carry on with its background work.
    if (!handlers) return { behavior: "deny", message: NO_USER };
    const result = await handlers.canUseTool(toolName, input, options);
    // Asked of a run that parked the CLI meanwhile: its sink declined as the
    // run settled, and that must not interrupt the work it left running.
    if (this.handlers !== handlers && result?.behavior === "deny")
      return { behavior: "deny", message: NO_USER };
    return result;
  };

  readonly preToolUse: HookCallback = async (input, toolUseID, options) =>
    this.handlers ? this.handlers.preToolUse(input, toolUseID, options) : {};

  /** Attach a run: `preamble` is read first, then the CLI's own output. */
  open(
    handlers: NativeRunHandlers,
    preamble: unknown[] = [],
    handoff?: Next,
  ): AsyncIterable<unknown> {
    this.handlers = handlers;
    const queue = [...preamble];
    let pending = handoff;
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Next => {
          if (queue.length > 0)
            return Promise.resolve({ done: false, value: queue.shift() });
          if (pending) {
            const next = pending;
            pending = undefined;
            return next;
          }
          return this.pull();
        },
      }),
    };
  }

  /**
   * Keep the CLI after the attached run settles. `inflight` is a read that
   * run started but never consumed; its message is buffered, not lost.
   */
  park(
    tasks: BackgroundTask[],
    ttlMs: number,
    parking: NativeParkBackgroundWork,
    inflight?: Next,
  ): boolean {
    if (this.ending || !this.iterator) return false;
    this.handlers = undefined;
    // Never past a deadline inherited from an earlier park: the ceiling
    // bounds the work, not each park.
    this.parkDeadline = Math.min(
      this.parkDeadline,
      Number.isFinite(ttlMs) ? Date.now() + Math.max(0, ttlMs) : Infinity,
    );
    const parked: Park = { tasks, parking, waking: false, wokeAt: 0 };
    if (Number.isFinite(this.parkDeadline)) {
      parked.timer = setTimeout(
        () => {
          if (this.parked !== parked) return;
          debugClaude("★ parked CLI ran out of background budget; ending it");
          void this.end();
        },
        Math.min(Math.max(0, this.parkDeadline - Date.now()), 2147483647),
      );
      parked.timer.unref?.();
    }
    this.parked = parked;
    parkedSessions.set(this.sessionId, this);
    void this.pump(inflight);
    return true;
  }

  /**
   * A later run takes the parked CLI over: it learns what was live and how
   * many results precede its own turn, then reads what was buffered. An
   * attach-only run with nothing to stream leaves the park alone (undefined).
   */
  adopt(
    handlers: NativeRunHandlers,
    attachOnly: boolean,
  ): AsyncIterable<unknown> | undefined {
    const parked = this.parked;
    if (!parked) return undefined;
    const turns = this.bufferedResults + (this.turnActive ? 1 : 0);
    if (attachOnly && turns === 0) return undefined;
    clearTimeout(parked.timer);
    this.parked = undefined;
    parkedSessions.delete(this.sessionId);
    // What is left of the background budget, so a run that adopts and parks
    // again inherits the deadline instead of restarting it.
    const budgetLeftMs = Number.isFinite(this.parkDeadline)
      ? Math.max(0, this.parkDeadline - Date.now())
      : null;
    const preamble = [
      { _parked: { tasks: parked.tasks, turns, budgetLeftMs } },
      ...this.buffer,
    ];
    this.buffer = [];
    this.bufferedBytes = 0;
    this.bufferedResults = 0;
    this.bufferOverflowed = false;
    // The drain may be mid-read: that message belongs to the adopting run.
    const handoff = this.pumping;
    this.pumping = undefined;
    return this.open(handlers, preamble, handoff);
  }

  /** Close the CLI and the background work it owns. Idempotent. */
  end(): Promise<void> {
    return (this.ending ??= (async () => {
      const parked = this.parked;
      this.parked = undefined;
      this.handlers = undefined;
      clearTimeout(parked?.timer);
      if (parkedSessions.get(this.sessionId) === this)
        parkedSessions.delete(this.sessionId);
      try {
        await this.kill();
      } finally {
        if (parked) parked.parking.onEnded?.();
      }
    })());
  }

  private pull(): Promise<IteratorResult<SDKMessage>> {
    return this.iterator!.next().then((result) => {
      if (!result.done) {
        const { started, ended } = turnEdges(result.value);
        if (started) this.turnActive = true;
        if (ended) this.turnActive = false;
      }
      return result;
    });
  }

  private async pump(first?: Next): Promise<void> {
    let next = first;
    while (this.parked) {
      next ??= this.pull();
      this.pumping = next;
      let result: IteratorResult<unknown>;
      try {
        result = await next;
      } catch (error) {
        if (this.pumping !== next) return;
        debugClaude("parked CLI stream failed: %o", error);
        void this.end();
        return;
      }
      // Adopted meanwhile: the adopting run reads this very result.
      if (this.pumping !== next) return;
      this.pumping = undefined;
      next = undefined;
      if (result.done) {
        debugClaude("★ parked CLI exited");
        void this.end();
        return;
      }
      this.hold(result.value);
    }
  }

  private hold(message: unknown): void {
    // The `_parked` preamble of a run that never got to read it.
    if (message && typeof message === "object" && "_parked" in message) return;
    const { started } = turnEdges(message);
    const isResult = (message as { type?: string }).type === "result";
    if (isResult) this.bufferedResults++;
    // Anything the CLI produces on its own is news for the host: the start of
    // a turn, and equally the result of one already in flight at park time.
    if (started || isResult) this.wake();
    // Partial deltas are rebuilt from the final messages.
    if ((message as { type?: string }).type === "stream_event") return;
    const size = Buffer.byteLength(JSON.stringify(message) ?? "");
    if (this.bufferedBytes + size > PARK_BUFFER_LIMIT) {
      // Keep what the CLI already produced and drop the rest rather than
      // killing it: the adopting run learns its transcript is incomplete.
      if (!this.bufferOverflowed) {
        this.bufferOverflowed = true;
        this.buffer.push({ _notice: "park_buffer_overflow" });
        this.wake();
      }
      return;
    }
    this.bufferedBytes += size;
    this.buffer.push(message);
  }

  private wake(): void {
    const parked = this.parked;
    if (!parked || parked.waking) return;
    // A wake the host accepted stands until a run attaches; ask again only
    // once it is plain that no run is coming.
    if (parked.wokeAt && Date.now() - parked.wokeAt < WAKE_RETRY_CEILING_MS)
      return;
    parked.waking = true;
    void (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          const delay = WAKE_RETRY_MS[attempt] ?? WAKE_RETRY_CEILING_MS;
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          // Adopted or ended meanwhile: stop asking.
          if (this.parked !== parked) return;
          try {
            if ((await parked.parking.onWake()) !== false) {
              parked.wokeAt = Date.now();
              return;
            }
          } catch (error) {
            debugClaude("wake callback failed: %o", error);
          }
        }
      } finally {
        parked.waking = false;
      }
    })();
  }
}
