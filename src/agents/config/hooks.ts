import path from "node:path";

import { AgentProvider, type AgentProviderName } from "../types";
import type {
  ClaudeCodeHooksConfig,
  CodexHooksConfig,
  OpenCodePluginConfig,
  OpenCodePluginHookConfig,
  TextArtifact,
} from "./types";

type OptionsWithProviderConfig = {
  hooks?: unknown;
  provider?: {
    hooks?: unknown;
    plugins?: unknown;
  };
};

function hasHookEntries(
  hooks:
    | ClaudeCodeHooksConfig
    | CodexHooksConfig
    | Record<string, unknown>
    | undefined,
): boolean {
  if (!hooks || typeof hooks !== "object") {
    return false;
  }

  return Object.values(hooks).some(
    (groups) => Array.isArray(groups) && groups.length > 0,
  );
}

function readTopLevelHooks(options: unknown): unknown {
  if (!options || typeof options !== "object" || !("hooks" in options)) {
    return undefined;
  }

  return (options as OptionsWithProviderConfig).hooks;
}

function readProviderHooks(options: unknown): unknown {
  if (!options || typeof options !== "object" || !("provider" in options)) {
    return undefined;
  }

  return (options as OptionsWithProviderConfig).provider?.hooks;
}

function readProviderPlugins(options: unknown): unknown {
  if (!options || typeof options !== "object" || !("provider" in options)) {
    return undefined;
  }

  return (options as OptionsWithProviderConfig).provider?.plugins;
}

function legacySharedHooksError(provider: AgentProviderName): string {
  return provider === AgentProvider.OpenCode
    ? "OpenCode hook plugins must be configured on options.provider.plugins. The shared options.hooks field was removed because hook semantics differ by provider."
    : `${provider === AgentProvider.ClaudeCode ? "Claude Code" : "Codex"} hooks must be configured on options.provider.hooks. The shared options.hooks field was removed because hook semantics differ by provider.`;
}

function invalidGroupedHooksShapeError(
  provider: "claude-code" | "codex",
): string {
  return `${provider === AgentProvider.ClaudeCode ? "Claude Code" : "Codex"} hooks must use the native grouped hooks object shape under options.provider.hooks, with each event mapped to an array of matcher groups.`;
}

function hasMalformedGroupedHookEntries(
  hooks: Record<string, unknown>,
): boolean {
  return Object.values(hooks).some(
    (groups) => groups !== undefined && !Array.isArray(groups),
  );
}

function opencodeHooksFieldError(): string {
  return "OpenCode uses options.provider.plugins for native hook support. options.provider.hooks is not supported for opencode.";
}

function unexpectedPluginsFieldError(provider: AgentProviderName): string {
  return `OpenCode plugins are only supported for the opencode provider in this package. Configure them on options.provider.plugins for opencode; received plugin configuration for ${provider}.`;
}

export function buildClaudeHookSettings(
  hooks: ClaudeCodeHooksConfig | undefined,
): Record<string, unknown> | undefined {
  if (!hasHookEntries(hooks)) {
    return undefined;
  }

  return { hooks };
}

export function buildCodexHooksFile(
  hooks: CodexHooksConfig | undefined,
): Record<string, unknown> | undefined {
  if (!hasHookEntries(hooks)) {
    return undefined;
  }

  return { hooks };
}

function toPluginFileName(name: string, extension: "js" | "ts"): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "agentbox-plugin"}.${extension}`;
}

function toPluginExportName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  const parts = base
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1));
  const identifier = parts.join("") || "AgentBoxPlugin";
  return /^[A-Za-z_]/.test(identifier)
    ? identifier
    : `AgentBoxPlugin${identifier}`;
}

function indentBlock(input: string, spaces: number): string {
  const indent = " ".repeat(spaces);
  return input
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function renderOpenCodePluginHook(hook: OpenCodePluginHookConfig): string {
  const body =
    hook.body.trim().length > 0 ? hook.body.trim() : "return undefined;";
  return [
    `    ${JSON.stringify(hook.event)}: async (input, output) => {`,
    indentBlock(body, 6),
    "    },",
  ].join("\n");
}

function buildOpenCodePluginSource(plugin: OpenCodePluginConfig): string {
  const exportName = toPluginExportName(plugin.name);
  const setup = plugin.setup?.trim();
  const preamble = plugin.preamble?.trim();

  return [
    ...(preamble ? [preamble, ""] : []),
    `export const ${exportName} = async (ctx) => {`,
    ...(setup ? [indentBlock(setup, 2)] : []),
    "  return {",
    ...plugin.hooks.map((hook) => renderOpenCodePluginHook(hook)),
    "  };",
    "};",
    "",
    `export default ${exportName};`,
    "",
  ].join("\n");
}

export function buildOpenCodePluginArtifacts(
  plugins: OpenCodePluginConfig[] | undefined,
  opencodeDir: string,
): TextArtifact[] {
  if (!plugins || plugins.length === 0) {
    return [];
  }

  const seenFileNames = new Set<string>();
  return plugins.map((plugin) => {
    const fileExtension = plugin.fileExtension ?? "ts";
    const fileName = toPluginFileName(plugin.name, fileExtension);
    if (seenFileNames.has(fileName)) {
      throw new Error(
        `OpenCode plugin names must be unique after normalization. Duplicate plugin file: ${fileName}`,
      );
    }
    seenFileNames.add(fileName);

    return {
      path: path.join(opencodeDir, "plugins", fileName),
      content: buildOpenCodePluginSource(plugin),
    };
  });
}

export function hasConfiguredHooks(options: unknown): boolean {
  const providerPlugins = readProviderPlugins(options);
  return (
    readTopLevelHooks(options) !== undefined ||
    hasHookEntries(readProviderHooks(options) as Record<string, unknown>) ||
    (Array.isArray(providerPlugins) && providerPlugins.length > 0)
  );
}

export function assertHooksSupported(
  provider: "claude-code",
  options: unknown,
): ClaudeCodeHooksConfig | undefined;
export function assertHooksSupported(
  provider: "codex",
  options: unknown,
): CodexHooksConfig | undefined;
export function assertHooksSupported(
  provider: "open-code",
  options: unknown,
): OpenCodePluginConfig[] | undefined;
export function assertHooksSupported(
  provider: AgentProviderName,
  options: unknown,
):
  | ClaudeCodeHooksConfig
  | CodexHooksConfig
  | OpenCodePluginConfig[]
  | undefined {
  const topLevelHooks = readTopLevelHooks(options);
  if (topLevelHooks !== undefined) {
    throw new Error(legacySharedHooksError(provider));
  }

  const providerHooks = readProviderHooks(options);
  const providerPlugins = readProviderPlugins(options);

  if (provider === AgentProvider.OpenCode) {
    if (providerHooks !== undefined) {
      throw new Error(opencodeHooksFieldError());
    }

    if (providerPlugins === undefined) {
      return undefined;
    }

    if (!Array.isArray(providerPlugins)) {
      throw new Error(
        "OpenCode plugins must be configured as an array on options.provider.plugins.",
      );
    }

    return providerPlugins.length > 0 ? providerPlugins : undefined;
  }

  if (providerPlugins !== undefined) {
    throw new Error(unexpectedPluginsFieldError(provider));
  }

  if (providerHooks === undefined) {
    return undefined;
  }

  if (
    !providerHooks ||
    typeof providerHooks !== "object" ||
    Array.isArray(providerHooks)
  ) {
    throw new Error(invalidGroupedHooksShapeError(provider));
  }

  if (
    hasMalformedGroupedHookEntries(providerHooks as Record<string, unknown>)
  ) {
    throw new Error(invalidGroupedHooksShapeError(provider));
  }

  if (!hasHookEntries(providerHooks as Record<string, unknown>)) {
    return undefined;
  }

  return providerHooks as ClaudeCodeHooksConfig | CodexHooksConfig;
}
