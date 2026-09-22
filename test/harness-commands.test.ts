import { describe, expect, it } from "vitest";
import { resolveHarnessCommand } from "../src/agents/commands";
import {
  builtinHarnessCommands,
  claudeHarnessCommands,
  codexHarnessCommands,
  codexSkillMention,
  openCodeHarnessCommands,
  parseHarnessCommandInvocation,
  skillDirective,
} from "../src/agents/harness-commands";
import { resolveCodexCommandDispatch } from "../src/agents/providers/codex";
import { resolveOpenCodeCommandDispatch } from "../src/agents/providers/opencode";

describe("harness command parsing", () => {
  it("recognizes a leading slash token and its arguments", () => {
    expect(parseHarnessCommandInvocation("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseHarnessCommandInvocation("  /review focus on auth\nand tests")).toEqual({ name: "review", args: "focus on auth\nand tests" });
    expect(parseHarnessCommandInvocation("/posthog:signals last week")).toEqual({ name: "posthog:signals", args: "last week" });
  });
  it.each(["\n", "\r\n", "\t", " "])("accepts %j before command arguments", (separator) => {
    for (const provider of ["codex", "open-code", "claude-code"] as const) {
      expect(resolveHarnessCommand(provider, `/review${separator}Focus on authentication`)).toEqual({
        input: `/review${separator}Focus on authentication`,
        command: { name: "review", args: "Focus on authentication" },
      });
    }
    expect(parseHarnessCommandInvocation(`/compact${separator}`)).toEqual({ name: "compact", args: "" });
  });
  it("leaves paths and prose alone", () => {
    expect(parseHarnessCommandInvocation("/src/app.ts is broken")).toBeUndefined();
    expect(parseHarnessCommandInvocation("Please /compact this")).toBeUndefined();
    expect(parseHarnessCommandInvocation("/")).toBeUndefined();
    expect(parseHarnessCommandInvocation("/compact, then continue")).toBeUndefined();
  });
  it("keeps the raw input and describes the command for every provider", () => {
    const image = { type: "image" as const, image: "data:image/png;base64,AAAA" };
    expect(resolveHarnessCommand("claude-code", "/compact keep the test plan")).toEqual({ input: "/compact keep the test plan", command: { name: "compact", args: "keep the test plan" } });
    expect(resolveHarnessCommand("codex", [{ type: "text", text: "/review" }, image])).toEqual({ input: [{ type: "text", text: "/review" }, image], command: { name: "review", args: "" } });
    expect(resolveHarnessCommand("open-code", "/src/app.ts is broken")).toEqual({ input: "/src/app.ts is broken" });
  });
});

describe("Claude Code command inventory", () => {
  it("keeps headless commands, skills, and plugin commands and hides host-owned ones", () => {
    const commands = claudeHarnessCommands({
      slash_commands: ["compact", "clear", "model", "context", "doctor", "goal", "plan", "__remote-workflow", "frontend-design", "posthog:signals", "my-command", "compact"],
      skills: ["frontend-design", "posthog:signals"],
      terminal_slash_commands: ["doctor"],
      plugins: [{ name: "posthog" }],
    });
    expect(commands.map((command) => [command.name, command.source])).toEqual([
      ["compact", "builtin"],
      ["context", "builtin"],
      ["frontend-design", "skill"],
      ["posthog:signals", "plugin"],
      ["my-command", "custom"],
    ]);
    expect(commands[0]).toMatchObject({ description: expect.stringContaining("context"), argumentHint: expect.any(String) });
  });
});

describe("Codex command inventory and dispatch", () => {
  const list = {
    data: [
      {
        cwd: "/repo",
        skills: [
          { name: "frontend-design", description: "Design UI", enabled: true, pluginId: null },
          { name: "pdf:pdf", description: "Long description", interface: { shortDescription: "Work with PDFs" }, enabled: true, pluginId: "pdf@openai" },
          { name: "disabled", description: "off", enabled: false, pluginId: null },
        ],
      },
    ],
  };
  it("lists built-ins ahead of enabled skills", () => {
    expect(codexHarnessCommands(list).map((command) => [command.name, command.source, command.description])).toEqual([
      ["compact", "builtin", expect.any(String)],
      ["review", "builtin", expect.any(String)],
      ["init", "builtin", expect.any(String)],
      ["frontend-design", "skill", "Design UI"],
      ["pdf:pdf", "plugin", "Work with PDFs"],
    ]);
    expect(codexSkillMention("pdf:pdf")).toBe("$pdf");
    expect(codexSkillMention("frontend-design")).toBe("$frontend-design");
  });
  it.each(["init", "frontend-design"])("preserves additional text and images for /%s", (name) => {
    const inputItems = [
      { type: "text", text: `/${name} focus on API`, text_elements: [] },
      { type: "text", text: "Only change packages/api.", text_elements: [] },
      { type: "localImage", path: "/tmp/a.png" },
    ];
    const dispatch = resolveCodexCommandDispatch({ name, args: "focus on API" }, inputItems, new Set(["frontend-design"]));
    expect(dispatch).toMatchObject({ kind: "turn", inputItems: [
      { type: "text", text: expect.stringContaining("focus on API") },
      inputItems[1], inputItems[2],
    ] });
  });
  it("maps commands to app-server calls, prompts, or verbatim text", () => {
    const items = [{ type: "text", text: "/review focus on auth", text_elements: [] }, { type: "localImage", path: "/tmp/a.png" }];
    const skills = new Set(["frontend-design"]);
    expect(resolveCodexCommandDispatch({ name: "compact", args: "" }, items, skills)).toEqual({ kind: "compact" });
    expect(resolveCodexCommandDispatch({ name: "review", args: "focus on auth" }, items, skills)).toEqual({ kind: "review", target: { type: "custom", instructions: "focus on auth" } });
    expect(resolveCodexCommandDispatch({ name: "review", args: "" }, items, skills)).toEqual({ kind: "review", target: { type: "uncommittedChanges" } });
    expect(resolveCodexCommandDispatch({ name: "init", args: "" }, items, skills)).toMatchObject({ kind: "turn", inputItems: [{ type: "text", text: expect.stringContaining("AGENTS.md") }, items[1]] });
    expect(resolveCodexCommandDispatch({ name: "frontend-design", args: "the settings page" }, items, skills)).toMatchObject({ kind: "turn", inputItems: [{ type: "text", text: "$frontend-design the settings page", text_elements: [] }, items[1]] });
    expect(resolveCodexCommandDispatch({ name: "unknown", args: "x" }, items, skills)).toEqual({ kind: "turn", inputItems: items });
    expect(resolveCodexCommandDispatch(undefined, items, skills)).toEqual({ kind: "turn", inputItems: items });
  });
});

describe("OpenCode command inventory and dispatch", () => {
  // `Command.hints()` only ever returns the template's raw placeholders.
  const commands = openCodeHarnessCommands(
    [
      { name: "init", description: "guided AGENTS.md setup", source: "command", hints: ["$ARGUMENTS"] },
      { name: "review", source: "command", hints: ["$1", "$ARGUMENTS"] },
      { name: "deploy", description: "Deploy the app", hints: ["$1", "$2"] },
      { name: "release notes", description: "Never reaches the host" },
      { name: "server:prompt", mcp: true },
    ],
    [{ name: "customize-opencode", description: "Edit opencode config" }],
  );
  it("lists compaction, configured commands, MCP prompts, and skills", () => {
    expect(commands.map((command) => [command.name, command.source, command.argumentHint])).toEqual([
      ["compact", "builtin", undefined],
      ["init", "builtin", "<optional focus>"],
      ["review", "builtin", "<optional focus>"],
      ["deploy", "custom", "<arguments>"],
      ["server:prompt", "mcp", undefined],
      ["customize-opencode", "skill", undefined],
    ]);
  });
  it("drops names a host would reject rather than lose the inventory", () => {
    expect(commands.some((command) => command.name === "release notes")).toBe(false);
    expect(claudeHarnessCommands({ slash_commands: ["fix issue", "ok"] }).map((command) => command.name)).toEqual(["ok"]);
    expect(
      codexHarnessCommands({ data: [{ skills: [{ name: "bad name", enabled: true }, { name: "good", enabled: true }] }] })
        .map((command) => command.name),
    ).toEqual(["compact", "review", "init", "good"]);
  });
  it("routes commands to summarize, command execution, or a prompt", () => {
    expect(resolveOpenCodeCommandDispatch({ name: "compact", args: "" }, commands)).toEqual({ kind: "summarize" });
    expect(resolveOpenCodeCommandDispatch({ name: "deploy", args: "staging 1.2" }, commands)).toEqual({ kind: "command", command: "deploy", arguments: "staging 1.2" });
    expect(resolveOpenCodeCommandDispatch({ name: "customize-opencode", args: "add a plugin" }, commands)).toEqual({ kind: "prompt", text: skillDirective("customize-opencode", "add a plugin") });
    expect(resolveOpenCodeCommandDispatch({ name: "nope", args: "" }, commands)).toEqual({ kind: "prompt" });
    expect(resolveOpenCodeCommandDispatch(undefined, commands)).toEqual({ kind: "prompt" });
  });
});

describe("built-in command lists", () => {
  it("covers every provider with compaction first", () => {
    for (const provider of ["claude-code", "codex", "open-code"] as const) {
      const commands = builtinHarnessCommands(provider);
      expect(commands[0]?.name).toBe("compact");
      expect(commands.every((command) => command.source === "builtin")).toBe(true);
    }
  });
});
