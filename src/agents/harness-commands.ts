import type { AgentProviderName } from "./types";

/**
 * Where a harness command comes from. `builtin` commands ship with the CLI;
 * `skill`, `custom`, `plugin`, and `mcp` commands are discovered from the
 * environment the harness runs in and can differ per project.
 */
export type HarnessCommandSource =
  | "builtin"
  | "skill"
  | "custom"
  | "plugin"
  | "mcp";

/** A slash command the harness can run, as shown in a host's `/` palette. */
export interface HarnessCommandDescriptor {
  /** Name as typed after the slash, e.g. `compact` or `posthog:signals`. */
  name: string;
  description?: string;
  /** Free-text hint for what follows the name, e.g. `<optional instructions>`. */
  argumentHint?: string;
  source: HarnessCommandSource;
}

/** A leading `/name args` token from user input, resolved by each adapter. */
export interface HarnessCommandInvocation {
  name: string;
  /** Text after the command name, trimmed. Empty when none was given. */
  args: string;
}

export const MAX_HARNESS_COMMANDS = 500;
export const MAX_HARNESS_COMMAND_NAME = 200;
export const MAX_HARNESS_COMMAND_DESCRIPTION = 500;
export const MAX_HARNESS_COMMAND_ARGUMENT_HINT = 200;

/**
 * What a host accepts as a command name. Hosts validate the inventory as a
 * whole, so a single name they reject (an opencode config key with a space,
 * a `fix issue.md` command file) costs the run its entire palette. Entries
 * that cannot round-trip are dropped at the source instead.
 */
const HARNESS_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][\w:.-]*$/;

/** The name a host will accept, or nothing when this entry must be dropped. */
function harnessCommandName(raw: string | undefined): string | undefined {
  const name = raw?.trim();
  if (!name || name.length > MAX_HARNESS_COMMAND_NAME) return undefined;
  return HARNESS_COMMAND_NAME_PATTERN.test(name) ? name : undefined;
}

/** Free text clamped to what a host accepts, or nothing when it is empty. */
function harnessCommandText(
  raw: string | undefined,
  max: number,
): string | undefined {
  const text = raw?.trim();
  return text ? text.slice(0, max) : undefined;
}

const CLAUDE_BUILTINS: HarnessCommandDescriptor[] = [
  {
    name: "compact",
    description: "Free up context by summarizing the conversation so far",
    argumentHint: "<optional summarization instructions>",
    source: "builtin",
  },
  {
    name: "context",
    description: "Show what is using the context window",
    source: "builtin",
  },
  {
    name: "usage",
    description: "Show token usage and cost for this session",
    source: "builtin",
  },
  {
    name: "recap",
    description: "Summarize what has happened in this session",
    source: "builtin",
  },
  {
    name: "init",
    description: "Create a CLAUDE.md guide for this repository",
    source: "builtin",
  },
  {
    name: "security-review",
    description: "Review pending changes for security issues",
    source: "builtin",
  },
  {
    name: "mcp",
    description: "Show configured MCP servers and their status",
    source: "builtin",
  },
];

const CODEX_BUILTINS: HarnessCommandDescriptor[] = [
  {
    name: "compact",
    description: "Summarize the conversation to free up context",
    source: "builtin",
  },
  {
    name: "review",
    description: "Review the uncommitted changes in the workspace",
    argumentHint: "<optional review instructions>",
    source: "builtin",
  },
  {
    name: "init",
    description: "Create an AGENTS.md contributor guide for this repository",
    argumentHint: "<optional focus>",
    source: "builtin",
  },
];

const OPENCODE_BUILTINS: HarnessCommandDescriptor[] = [
  {
    name: "compact",
    description: "Summarize the session to free up context",
    source: "builtin",
  },
  {
    name: "init",
    description: "Create an AGENTS.md guide for this repository",
    argumentHint: "<optional focus>",
    source: "builtin",
  },
  {
    name: "review",
    description: "Review the current changes",
    argumentHint: "<optional focus>",
    source: "builtin",
  },
];

/**
 * Commands known to work for every installation of the harness when driven
 * headlessly. A live run replaces this list with what the harness reports.
 */
export function builtinHarnessCommands(
  provider: AgentProviderName,
): HarnessCommandDescriptor[] {
  switch (provider) {
    case "claude-code":
      return CLAUDE_BUILTINS.map((command) => ({ ...command }));
    case "codex":
      return CODEX_BUILTINS.map((command) => ({ ...command }));
    case "open-code":
      return OPENCODE_BUILTINS.map((command) => ({ ...command }));
    default:
      return [];
  }
}

/**
 * Parse a leading `/name args` token. Only a bare name qualifies: a path such
 * as `/src/app.ts` or a name followed by punctuation is prose, not a command.
 */
export function parseHarnessCommandInvocation(
  text: string,
): HarnessCommandInvocation | undefined {
  const match = text.match(/^\s*\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/);
  const name = match?.[1];
  if (!name) return undefined;
  return { name, args: (match[2] ?? "").trim() };
}

/**
 * Claude Code built-ins that change session state the host owns (model,
 * effort, titles, plugins) or that only make sense in a terminal. Hidden
 * from palettes; sending them still works exactly as in the CLI.
 */
const CLAUDE_HIDDEN_BUILTINS = new Set([
  "agents",
  "list-agents",
  "advisor",
  "auto-mode-setup",
  "autocompact",
  "clear",
  "reset",
  "new",
  "color",
  "config",
  "design-consent",
  "design-revoke",
  "doctor",
  "effort",
  "exit",
  "quit",
  "extra-usage",
  "fast",
  "goal",
  "heapdump",
  "import",
  "insights",
  "model",
  "output-style",
  "plan",
  "reload-plugins",
  "reload-skills",
  "rename",
  "name",
  "skill-doctor",
  "team-onboarding",
  "ultrareview",
  "usage-credits",
  "workflow-launch-exec",
  "add-dir",
  "stop",
]);

const CLAUDE_BUILTIN_DESCRIPTIONS = new Map(
  CLAUDE_BUILTINS.map((command) => [command.name, command]),
);

/**
 * Turn Claude Code's `system/init` command inventory into descriptors. The
 * headless CLI already omits commands that need an interactive terminal; this
 * additionally hides host-owned settings, internal commands, and the
 * commands flagged as bound to the local terminal.
 */
export function claudeHarnessCommands(init: {
  slash_commands?: string[];
  skills?: string[];
  terminal_slash_commands?: string[];
  plugins?: Array<{ name: string }>;
}): HarnessCommandDescriptor[] {
  const skills = new Set(init.skills ?? []);
  const terminal = new Set(init.terminal_slash_commands ?? []);
  const plugins = new Set((init.plugins ?? []).map((plugin) => plugin.name));
  const seen = new Set<string>();
  const commands: HarnessCommandDescriptor[] = [];
  for (const raw of init.slash_commands ?? []) {
    const name = harnessCommandName(raw.replace(/^\//, ""));
    if (!name || seen.has(name) || name.startsWith("__")) continue;
    if (terminal.has(name) || CLAUDE_HIDDEN_BUILTINS.has(name)) continue;
    seen.add(name);
    const known = CLAUDE_BUILTIN_DESCRIPTIONS.get(name);
    const prefix = name.includes(":") ? name.slice(0, name.indexOf(":")) : "";
    const source: HarnessCommandSource = known
      ? "builtin"
      : prefix && plugins.has(prefix)
        ? "plugin"
        : skills.has(name)
          ? "skill"
          : "custom";
    commands.push({
      name,
      ...(known?.description ? { description: known.description } : {}),
      ...(known?.argumentHint ? { argumentHint: known.argumentHint } : {}),
      source,
    });
  }
  return commands.slice(0, MAX_HARNESS_COMMANDS);
}

/** One entry of Codex's `skills/list` response. */
export interface CodexSkillEntry {
  name: string;
  description?: string;
  enabled?: boolean;
  pluginId?: string | null;
  interface?: { shortDescription?: string; displayName?: string } | null;
}

/** Codex `skills/list` groups skills per working directory. */
export function codexHarnessCommands(list: {
  data?: Array<{ skills?: CodexSkillEntry[] }>;
}): HarnessCommandDescriptor[] {
  const commands = builtinHarnessCommands("codex");
  const seen = new Set(commands.map((command) => command.name));
  for (const group of list.data ?? []) {
    for (const skill of group.skills ?? []) {
      const name = harnessCommandName(skill.name);
      if (!name || skill.enabled === false || seen.has(name)) continue;
      seen.add(name);
      const description = harnessCommandText(
        skill.interface?.shortDescription ?? skill.description ?? undefined,
        MAX_HARNESS_COMMAND_DESCRIPTION,
      );
      commands.push({
        name,
        ...(description ? { description } : {}),
        source: skill.pluginId ? "plugin" : "skill",
      });
    }
  }
  return commands.slice(0, MAX_HARNESS_COMMANDS);
}

/** Skill mention Codex resolves from prompt text (`$name`). */
export function codexSkillMention(name: string): string {
  const index = name.lastIndexOf(":");
  return `$${index === -1 ? name : name.slice(index + 1)}`;
}

/** One entry of OpenCode's `GET /command` response. */
export interface OpenCodeCommandEntry {
  name: string;
  description?: string;
  mcp?: boolean;
  hints?: string[];
  source?: string;
}

/** One entry of OpenCode's `GET /skill` response. */
export interface OpenCodeSkillEntry {
  name: string;
  description?: string;
}

const OPENCODE_BUILTIN_DESCRIPTIONS = new Map(
  OPENCODE_BUILTINS.map((command) => [command.name, command]),
);

/**
 * opencode's hints are the template's raw placeholders — `$1`, `$2`,
 * `$ARGUMENTS` — never argument names, so showing them verbatim would put
 * template syntax in a host's palette. They still say the command takes
 * arguments, which is all we report.
 */
const OPENCODE_PLACEHOLDER_HINT = /^\$(?:\d+|ARGUMENTS)$/;

function openCodeArgumentHint(hints: string[] | undefined): string | undefined {
  const named = (hints ?? [])
    .map((hint) => hint.trim())
    .filter((hint) => hint.length > 0 && !OPENCODE_PLACEHOLDER_HINT.test(hint));
  if (named.length > 0) return named.map((hint) => `<${hint}>`).join(" ");
  return hints?.length ? "<arguments>" : undefined;
}

export function openCodeHarnessCommands(
  commands: OpenCodeCommandEntry[],
  skills: OpenCodeSkillEntry[] = [],
): HarnessCommandDescriptor[] {
  const result: HarnessCommandDescriptor[] = [
    { ...OPENCODE_BUILTIN_DESCRIPTIONS.get("compact")! },
  ];
  const seen = new Set(result.map((command) => command.name));
  for (const command of commands) {
    const name = harnessCommandName(command.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const known = OPENCODE_BUILTIN_DESCRIPTIONS.get(name);
    const description = harnessCommandText(
      command.description ?? known?.description,
      MAX_HARNESS_COMMAND_DESCRIPTION,
    );
    // A curated hint names the argument; the server's only says there is one.
    const hint = harnessCommandText(
      known?.argumentHint ?? openCodeArgumentHint(command.hints),
      MAX_HARNESS_COMMAND_ARGUMENT_HINT,
    );
    result.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { argumentHint: hint } : {}),
      source: command.mcp
        ? "mcp"
        : command.source === "command" || known
          ? "builtin"
          : "custom",
    });
  }
  for (const skill of skills) {
    const name = harnessCommandName(skill.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = harnessCommandText(
      skill.description,
      MAX_HARNESS_COMMAND_DESCRIPTION,
    );
    result.push({
      name,
      ...(description ? { description } : {}),
      source: "skill",
    });
  }
  return result.slice(0, MAX_HARNESS_COMMANDS);
}

/** Natural-language directive for harnesses whose skills the model invokes. */
export function skillDirective(name: string, args: string): string {
  return args
    ? `Use the "${name}" skill for this: ${args}`
    : `Use the "${name}" skill.`;
}
