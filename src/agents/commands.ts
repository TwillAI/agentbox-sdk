import {
  parseHarnessCommandInvocation,
  type HarnessCommandInvocation,
} from "./harness-commands";
import type { AgentProviderName, AgentRunConfig, UserContent } from "./types";

export type HarnessCommand = "plan" | "agent" | "goal";
export interface HarnessCapabilities {
  commands: HarnessCommand[];
  planning: "explicit" | "agent-directed";
  questions: boolean;
  fullAccess: boolean;
}
/** Adapter capabilities. Runtime adapters additionally validate commands against the live harness. */
export function harnessCapabilities(provider: AgentProviderName): HarnessCapabilities {
  return { commands: provider === "open-code" ? ["plan", "agent"] : ["plan", "agent", "goal"], planning: provider === "codex" ? "explicit" : "agent-directed", questions: true, fullAccess: true };
}
/**
 * Resolve a leading slash token. `/plan`, `/agent`, and `/goal` are harness
 * modes handled here; any other `/name args` is a harness command left in the
 * input verbatim (Claude Code dispatches it itself) and described by
 * `command` so Codex and OpenCode adapters can map it to their native calls.
 */
export function resolveHarnessCommand(provider: AgentProviderName, input: UserContent): Pick<AgentRunConfig, "input" | "mode" | "goal" | "command"> {
  const first = typeof input === "string" ? input : input.find((part) => part.type === "text")?.text;
  const match = first?.match(/^\s*\/(plan|agent|goal)(?:\s+([\s\S]*))?$/);
  if (!match) {
    const invocation: HarnessCommandInvocation | undefined = first ? parseHarnessCommandInvocation(first) : undefined;
    return invocation ? { input, command: invocation } : { input };
  }
  const command = match[1] as HarnessCommand;
  if (!harnessCapabilities(provider).commands.includes(command)) throw new Error(`/${command} is not supported by ${provider}.`);
  const body = match[2]?.trim() ?? "";
  if (command === "goal" && (!body || body.length > 4000)) throw new Error("/goal requires an objective of 1–4000 characters.");
  // Claude's goal is a native skill. Its presence is checked against SDK init commands.
  if (command === "goal" && provider === "claude-code") return { input, goal: body };
  const text = body || (command === "plan" ? "Plan the requested work." : "Continue with implementation.");
  let replaced = false;
  const cleaned = typeof input === "string" ? text : input.map((part) => {
    if (part.type !== "text" || replaced) return part;
    replaced = true;
    return { ...part, text };
  });
  return command === "goal" ? { input: cleaned, goal: body } : { input: cleaned, mode: command === "plan" ? "plan" : "default" };
}
