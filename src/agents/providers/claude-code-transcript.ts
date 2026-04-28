import { randomUUID } from "node:crypto";

/**
 * Pure helpers for surgically rewriting Claude Code session JSONL transcripts.
 *
 * Claude Code stores each session at:
 *   $HOME/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * Lines are JSON objects keyed by `uuid`, linked to their predecessor via
 * `parentUuid`, and tagged with the owning `sessionId`. The first message has
 * `parentUuid: null`. Non-message lines (e.g. `summary`, `file-history-snapshot`)
 * occasionally appear; we skip ones we can't parse rather than failing.
 *
 * Forking semantics: callers pass the uuid of the user message they want to
 * "edit and rerun". We drop that uuid AND every descendant, keeping only the
 * ancestor chain up to (but not including) the target. The new transcript is
 * rewritten with a fresh sessionId so Claude treats it as a separate session
 * (akin to `--fork-session`).
 */

interface TranscriptLine {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ForkClaudeTranscriptResult {
  /** JSONL string ready to write to disk (always ends with a newline). */
  content: string;
  /** Number of lines retained after surgery. */
  keptCount: number;
  /** Number of lines dropped (target + descendants + unparseable). */
  droppedCount: number;
}

/**
 * Rewrite a Claude Code session JSONL transcript so that the message at
 * `targetUuid` and everything that descends from it is removed. The remaining
 * lines have their `sessionId` rewritten to `newSessionId` so Claude treats
 * them as part of the forked session.
 *
 * Throws if `targetUuid` cannot be located in the source transcript.
 */
export function forkClaudeTranscript(
  source: string,
  targetUuid: string,
  newSessionId: string,
): ForkClaudeTranscriptResult {
  const rawLines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  type Parsed = { line: TranscriptLine; raw: string };
  const parsed: Parsed[] = [];
  for (const raw of rawLines) {
    try {
      parsed.push({ line: JSON.parse(raw) as TranscriptLine, raw });
    } catch {
      // Skip unparseable lines; they're dropped from the fork to avoid
      // poisoning the rewritten transcript.
    }
  }

  const byUuid = new Map<string, Parsed>();
  for (const entry of parsed) {
    if (typeof entry.line.uuid === "string") {
      byUuid.set(entry.line.uuid, entry);
    }
  }

  if (!byUuid.has(targetUuid)) {
    throw new Error(
      `Cannot fork claude-code transcript: target uuid ${targetUuid} not found.`,
    );
  }

  // Compute the set of uuids to keep: the ancestor chain of the target,
  // EXCLUSIVE of the target itself (we want the run that resumes from the
  // forked session to continue *before* the edited message).
  const keep = new Set<string>();
  const targetEntry = byUuid.get(targetUuid)!;
  let cursor =
    typeof targetEntry.line.parentUuid === "string"
      ? targetEntry.line.parentUuid
      : null;
  while (cursor) {
    if (keep.has(cursor)) break;
    keep.add(cursor);
    const parent = byUuid.get(cursor);
    cursor =
      parent && typeof parent.line.parentUuid === "string"
        ? parent.line.parentUuid
        : null;
  }

  const kept: string[] = [];
  let droppedCount = rawLines.length - parsed.length; // unparseable lines
  for (const entry of parsed) {
    const uuid = entry.line.uuid;
    if (typeof uuid !== "string" || !keep.has(uuid)) {
      droppedCount += 1;
      continue;
    }
    const rewritten = { ...entry.line, sessionId: newSessionId };
    kept.push(JSON.stringify(rewritten));
  }

  return {
    content: kept.length > 0 ? kept.join("\n") + "\n" : "",
    keptCount: kept.length,
    droppedCount,
  };
}

/**
 * Encode an absolute working-directory path the way Claude Code does for its
 * `~/.claude/projects/<encoded-cwd>/` directory: replace `/` with `-` and
 * preserve a leading dash. Example: `/Users/me/proj` → `-Users-me-proj`.
 *
 * Claude's exact encoding has not been formally documented; if a future
 * Claude release changes the rule, the caller should fall back to a `find`
 * over the project tree.
 */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/** Generate a fresh sessionId (UUIDv4) for the forked transcript. */
export function newClaudeSessionId(): string {
  return randomUUID();
}
