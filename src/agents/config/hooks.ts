import type { AgentHookConfig } from "./types";

type ClaudeHookCommand = {
  type: "command";
  command: string;
  statusMessage?: string;
};

type ClaudeHookGroup = {
  matcher?: string;
  hooks: ClaudeHookCommand[];
};

export function buildClaudeHookSettings(
  hooks: AgentHookConfig[] | undefined,
): Record<string, unknown> | undefined {
  if (!hooks || hooks.length === 0) {
    return undefined;
  }

  const grouped = new Map<string, ClaudeHookGroup[]>();

  for (const hook of hooks) {
    const groups = grouped.get(hook.event) ?? [];
    groups.push({
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: hook.command,
          ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
        },
      ],
    });
    grouped.set(hook.event, groups);
  }

  return {
    hooks: Object.fromEntries(grouped.entries()),
  };
}

export function assertHooksSupported(
  provider: "claude-code" | "opencode" | "codex",
  hooks: AgentHookConfig[] | undefined,
): void {
  if (!hooks || hooks.length === 0) {
    return;
  }

  if (provider !== "claude-code") {
    throw new Error(
      `Hooks are only supported for the Claude Code provider in this package. Received hooks for ${provider}.`,
    );
  }
}
