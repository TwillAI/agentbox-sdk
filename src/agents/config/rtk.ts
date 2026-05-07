/**
 * RTK (rust-token-killer) activation.
 *
 * Each provider's `setup()` calls {@link activateRtk} after its own
 * artifacts are written. The helper invokes the installed `rtk` binary
 * with environment variables that redirect RTK's writes into the
 * agentbox-managed config layout (`SetupLayout`), so RTK's hook persists
 * even though agentbox owns each agent's config dir.
 *
 * Path resolution by RTK (verified against rtk-ai/rtk source):
 *   - Claude Code: `$RTK_CLAUDE_DIR` overrides `~/.claude`
 *   - Codex: `$CODEX_HOME` overrides `~/.codex`
 *   - OpenCode: only consults `home_dir()`; we override `$HOME` so
 *     `~/.config/opencode` resolves to `<rootDir>/.config/opencode`,
 *     which matches `layout.opencodeDir`.
 */

import { AgentProvider, type AgentProviderName } from "../types";
import type { SetupTarget } from "./types";

// Provider-specific args to `rtk init -g`. Only Claude Code patches an
// existing settings.json and therefore exposes/requires the patch-mode
// flags; the codex CLI explicitly rejects `--auto-patch` / `--no-patch`,
// and the opencode plugin install never prompts.
const RTK_INIT_ARGS_BY_PROVIDER: Record<AgentProviderName, string> = {
  [AgentProvider.ClaudeCode]: "--auto-patch",
  [AgentProvider.Codex]: "--codex",
  [AgentProvider.OpenCode]: "--opencode --auto-patch",
};

function rtkRedirectEnv(target: SetupTarget): Record<string, string> {
  const layout = target.layout;
  // Disable RTK telemetry unconditionally. The telemetry consent prompt is
  // guarded by `is_terminal()` and short-circuits in the non-TTY case
  // anyway, but this env var pins the behavior so a future RTK release
  // that changes the prompt logic can't re-introduce a hang.
  const common = { RTK_TELEMETRY_DISABLED: "1" };
  switch (target.provider) {
    case AgentProvider.ClaudeCode:
      return { ...common, RTK_CLAUDE_DIR: layout.claudeDir };
    case AgentProvider.Codex:
      return { ...common, CODEX_HOME: layout.codexDir };
    case AgentProvider.OpenCode:
      return { ...common, HOME: layout.rootDir };
  }
}

/**
 * Activate RTK for `target.provider`. Idempotent: `rtk init -g` skips
 * work when its hook is already present.
 *
 * Pre-creates the per-provider config dirs RTK writes into. RTK's
 * atomic-write doesn't `mkdir -p` for `~/.claude/RTK.md` or
 * `~/.codex/RTK.md`, so without this guard a fresh layout would error
 * with `Failed to create temp file in <dir>`.
 *
 * For Claude Code, passes `--auto-patch` so RTK skips the interactive
 * "Patch existing settings.json? [y/N]" prompt — without it, RTK
 * defaults to N in non-TTY contexts and silently declines to install
 * the hook. Codex and OpenCode modes don't prompt and reject
 * `--auto-patch`, so it is omitted for those providers.
 *
 * Failures (binary missing, non-zero exit) are logged and swallowed —
 * RTK is a token-saving optimization, not a correctness requirement, so
 * a setup-time failure should not block the agent from running.
 */
export async function activateRtk(target: SetupTarget): Promise<void> {
  const args = RTK_INIT_ARGS_BY_PROVIDER[target.provider];
  const env = rtkRedirectEnv(target);
  const dirsToEnsure = [target.layout.claudeDir, target.layout.codexDir]
    .map((d) => `'${d}'`)
    .join(" ");
  const cmd = `mkdir -p ${dirsToEnsure} && rtk init -g ${args}`.trim();
  try {
    await target.runCommand(cmd, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[rtk] activation failed for ${target.provider}; agent will run without the token-saving proxy: ${message}`,
    );
  }
}
