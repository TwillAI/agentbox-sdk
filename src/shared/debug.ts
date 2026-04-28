/**
 * Namespaced timing/debug logging for the agentbox SDK.
 *
 * Built on the `debug` package — enable at runtime via the `DEBUG` env var:
 *
 *   DEBUG=agentbox:*           // everything
 *   DEBUG=agentbox:claude      // just the claude provider path
 *   DEBUG=agentbox:setup,agentbox:sandbox   // setup + sandbox round-trips
 *
 * `debug` automatically appends a delta-since-previous-log to every line
 * (e.g. `+12ms`), which makes spotting hot spots in a startup trace easy.
 *
 * `time()` wraps a promise-returning step with `→ label` / `← label (Xms)`
 * (and `✗ label (Xms)` on failure) so you can see where time is going at a
 * glance without sprinkling start/end logs by hand.
 */
import createDebug, { type Debugger } from "debug";

const ROOT = "agentbox";

export type DebugNamespace =
  | "agent"
  | "claude"
  | "codex"
  | "opencode"
  | "setup"
  | "runtime"
  | "sandbox"
  | "relay";

const namespaces: Partial<Record<DebugNamespace, Debugger>> = {};

export function debug(namespace: DebugNamespace): Debugger {
  let d = namespaces[namespace];
  if (!d) {
    d = createDebug(`${ROOT}:${namespace}`);
    namespaces[namespace] = d;
  }
  return d;
}

export const debugAgent = debug("agent");
export const debugClaude = debug("claude");
export const debugCodex = debug("codex");
export const debugOpencode = debug("opencode");
export const debugSetup = debug("setup");
export const debugRuntime = debug("runtime");
export const debugSandbox = debug("sandbox");
export const debugRelay = debug("relay");

/**
 * Time an async step. Emits `→ label` immediately and `← label (Xms)` (or
 * `✗ label (Xms): err`) when the promise settles.
 *
 * The `extra` callback can return a key/value object that's appended to the
 * completion line — useful for things like `{ bytes: 1234 }` on a write.
 *
 * No-ops cheaply when the namespace is disabled (`debug.enabled` short-
 * circuits before we even read the clock).
 */
export async function time<T>(
  log: Debugger,
  label: string,
  fn: () => Promise<T>,
  extra?: (result: T) => Record<string, unknown> | undefined,
): Promise<T> {
  if (!log.enabled) {
    return fn();
  }
  const start = Date.now();
  log("→ %s", label);
  try {
    const result = await fn();
    const meta = extra?.(result);
    if (meta) {
      log("← %s (%dms) %o", label, Date.now() - start, meta);
    } else {
      log("← %s (%dms)", label, Date.now() - start);
    }
    return result;
  } catch (error) {
    log(
      "✗ %s (%dms): %s",
      label,
      Date.now() - start,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

/**
 * Sync variant of `time()` for hot inline blocks. Most useful when wrapping
 * synchronous JSON.stringify / shell-quoting / hashing work that we suspect
 * is contributing to startup latency.
 */
export function timeSync<T>(
  log: Debugger,
  label: string,
  fn: () => T,
  extra?: (result: T) => Record<string, unknown> | undefined,
): T {
  if (!log.enabled) {
    return fn();
  }
  const start = Date.now();
  try {
    const result = fn();
    const elapsed = Date.now() - start;
    const meta = extra?.(result);
    if (meta) {
      log("· %s (%dms) %o", label, elapsed, meta);
    } else {
      log("· %s (%dms)", label, elapsed);
    }
    return result;
  } catch (error) {
    log(
      "✗ %s (%dms): %s",
      label,
      Date.now() - start,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
