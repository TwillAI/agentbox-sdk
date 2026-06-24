import type { AgentMcpConfig, CodexModelProviderConfig } from "./types";

const SAFE_TOML_KEY = /^[a-zA-Z0-9_-]+$/;

function assertSafeTomlKey(name: string, context: string): void {
  if (!SAFE_TOML_KEY.test(name)) {
    throw new Error(
      `${context} name ${JSON.stringify(name)} contains characters that are not safe for TOML keys. Use only alphanumeric characters, hyphens, and underscores.`,
    );
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

/**
 * Serialize a string map as a TOML inline table with quoted keys, e.g.
 * `{ "X-Title" = "AgentBox", "api-version" = "2025-04-01" }`. Keys are
 * quoted so header names / params that aren't bare-key safe (hyphens,
 * dots) round-trip correctly.
 */
function tomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

/**
 * Emit a `[model_providers.<id>]` block mirroring codex's
 * `ModelProviderInfo`. Field names are the snake_case keys codex parses
 * with `deny_unknown_fields`, so only known fields are written and only
 * when set. `name` is required by codex, so it falls back to the id.
 */
function appendCodexModelProviderBlock(
  blocks: string[],
  id: string,
  cfg: CodexModelProviderConfig,
): void {
  assertSafeTomlKey(id, "Model provider");

  blocks.push(`[model_providers.${id}]`);
  blocks.push(`name = ${tomlString(cfg.name ?? id)}`);
  if (cfg.baseUrl) {
    blocks.push(`base_url = ${tomlString(cfg.baseUrl)}`);
  }
  if (cfg.envKey) {
    blocks.push(`env_key = ${tomlString(cfg.envKey)}`);
  }
  if (cfg.wireApi) {
    blocks.push(`wire_api = ${tomlString(cfg.wireApi)}`);
  }
  if (cfg.queryParams && Object.keys(cfg.queryParams).length > 0) {
    blocks.push(`query_params = ${tomlInlineTable(cfg.queryParams)}`);
  }
  if (cfg.httpHeaders && Object.keys(cfg.httpHeaders).length > 0) {
    blocks.push(`http_headers = ${tomlInlineTable(cfg.httpHeaders)}`);
  }
  if (cfg.envHttpHeaders && Object.keys(cfg.envHttpHeaders).length > 0) {
    blocks.push(`env_http_headers = ${tomlInlineTable(cfg.envHttpHeaders)}`);
  }
  if (cfg.requestMaxRetries !== undefined) {
    blocks.push(`request_max_retries = ${Math.trunc(cfg.requestMaxRetries)}`);
  }
  if (cfg.streamMaxRetries !== undefined) {
    blocks.push(`stream_max_retries = ${Math.trunc(cfg.streamMaxRetries)}`);
  }
  if (cfg.streamIdleTimeoutMs !== undefined) {
    blocks.push(
      `stream_idle_timeout_ms = ${Math.trunc(cfg.streamIdleTimeoutMs)}`,
    );
  }
  blocks.push("");
}

export function buildClaudeMcpConfig(
  mcps: AgentMcpConfig[] | undefined,
): string | undefined {
  if (!mcps || mcps.length === 0) {
    return undefined;
  }

  const mcpServers = Object.fromEntries(
    mcps
      .filter((mcp) => mcp.enabled !== false)
      .map((mcp) => {
        if (mcp.type === "remote") {
          const headers = {
            ...(mcp.headers ?? {}),
            ...(mcp.bearerTokenEnvVar
              ? {
                  Authorization: `Bearer \${${mcp.bearerTokenEnvVar}}`,
                }
              : {}),
          };

          return [
            mcp.name,
            {
              type: "http",
              url: mcp.url,
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
            },
          ];
        }

        return [
          mcp.name,
          {
            type: "stdio",
            command: mcp.command,
            ...(mcp.args?.length ? { args: mcp.args } : {}),
            ...(mcp.env ? { env: mcp.env } : {}),
          },
        ];
      }),
  );

  return JSON.stringify({ mcpServers }, null, 2);
}

export function buildOpenCodeMcpConfig(
  mcps: AgentMcpConfig[] | undefined,
): Record<string, unknown> | undefined {
  if (!mcps || mcps.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    mcps
      .filter((mcp) => mcp.enabled !== false)
      .map((mcp) => {
        if (mcp.type === "remote") {
          const headers = {
            ...(mcp.headers ?? {}),
            ...(mcp.bearerTokenEnvVar
              ? { Authorization: `Bearer {env:${mcp.bearerTokenEnvVar}}` }
              : {}),
          };

          return [
            mcp.name,
            {
              type: "remote",
              url: mcp.url,
              enabled: true,
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
            },
          ];
        }

        return [
          mcp.name,
          {
            type: "local",
            command: [mcp.command, ...(mcp.args ?? [])],
            enabled: true,
            ...(mcp.env ? { env: mcp.env } : {}),
          },
        ];
      }),
  );
}

export interface CodexConfigTomlOptions {
  mcps?: AgentMcpConfig[];
  agentSections?: string[];
  enableHooks?: boolean;
  /**
   * Sets `[features]\nskills = true` so codex discovers skills from
   * `<CODEX_HOME>/skills/...` at startup. Without this flag codex
   * silently ignores any skill files we wrote.
   */
  enableSkills?: boolean;
  /**
   * Sets `[features]\nmulti_agent = true` so codex loads custom agent
   * TOML files written by `setup()`. Replaces the previous
   * per-`execute()` `-c features.multi_agent=...` flag, keeping
   * agent-config out of the spawn path.
   */
  enableMultiAgent?: boolean;
  /**
   * Static OpenAI base URL override (e.g. when routing through a
   * proxy). Goes in config.toml so `execute()` doesn't need to know
   * about provider-level overrides at spawn time.
   */
  openAiBaseUrl?: string;
  /**
   * Top-level `model` key. Backstops the per-run `thread/start` model and,
   * crucially, gives named sub-agent (role) spawns a resolvable model: codex
   * rebuilds the child config from the on-disk config-layer stack and drops
   * the parent turn's runtime model, so without a `model` on disk
   * `spawn_agent` fails service-tier validation. Omitted when undefined.
   */
  model?: string;
  /**
   * Top-level `model_provider` key — selects which `[model_providers.*]`
   * table codex routes through. Omitted when undefined (codex defaults to
   * its built-in `openai` provider).
   */
  modelProvider?: string;
  /**
   * Custom OpenAI-compatible providers, emitted as `[model_providers.<id>]`
   * blocks. Used to make local OSS servers available to codex.
   */
  modelProviders?: Record<string, CodexModelProviderConfig>;
}

export function buildCodexConfigToml(
  opts: CodexConfigTomlOptions = {},
): string | undefined {
  const {
    mcps,
    agentSections = [],
    enableHooks = false,
    enableSkills = false,
    enableMultiAgent = false,
    openAiBaseUrl,
    model,
    modelProvider,
    modelProviders,
  } = opts;

  const blocks: string[] = [];

  if (openAiBaseUrl) {
    blocks.push(`openai_base_url = ${tomlString(openAiBaseUrl)}`);
    blocks.push("");
  }

  // Bare top-level key — must precede every `[table]` header (TOML assigns
  // any key after a header to that table), so it sits with the other
  // top-level keys above the `[model_providers.*]` / `[mcp_servers.*]` blocks.
  if (model) {
    blocks.push(`model = ${tomlString(model)}`);
    blocks.push("");
  }

  // Provider selection (`model_provider`) must precede the
  // `[model_providers.*]` tables: TOML treats every key after a table
  // header as belonging to that table, so a bare top-level key written
  // afterwards would be parsed into the last provider block instead.
  if (modelProvider) {
    blocks.push(`model_provider = ${tomlString(modelProvider)}`);
    blocks.push("");
  }

  for (const [id, cfg] of Object.entries(modelProviders ?? {})) {
    appendCodexModelProviderBlock(blocks, id, cfg);
  }

  for (const mcp of mcps ?? []) {
    if (mcp.enabled === false) {
      continue;
    }

    assertSafeTomlKey(mcp.name, "MCP server");

    if (mcp.type === "remote") {
      if (mcp.headers && Object.keys(mcp.headers).length > 0) {
        throw new Error(
          `Codex only supports remote MCPs with bearerTokenEnvVar in this package. MCP "${mcp.name}" includes raw headers.`,
        );
      }

      blocks.push(`[mcp_servers.${mcp.name}]`);
      blocks.push(`url = ${tomlString(mcp.url)}`);
      if (mcp.bearerTokenEnvVar) {
        blocks.push(
          `bearer_token_env_var = ${tomlString(mcp.bearerTokenEnvVar)}`,
        );
      }
      blocks.push("");
      continue;
    }

    blocks.push(`[mcp_servers.${mcp.name}]`);
    blocks.push(`command = ${tomlString(mcp.command)}`);
    if (mcp.args?.length) {
      blocks.push(`args = ${tomlStringArray(mcp.args)}`);
    }
    if (mcp.env && Object.keys(mcp.env).length > 0) {
      blocks.push(`env_vars = ${tomlStringArray(Object.keys(mcp.env))}`);
    }
    blocks.push("");
  }

  // Coalesce `[features]` so we don't emit the section header twice
  // when more than one feature flag is active.
  const featureLines: string[] = [];
  if (enableHooks) featureLines.push("codex_hooks = true");
  if (enableSkills) featureLines.push("skills = true");
  if (enableMultiAgent) featureLines.push("multi_agent = true");
  if (featureLines.length > 0) {
    blocks.push("[features]");
    blocks.push(...featureLines);
    blocks.push("");
  }

  blocks.push(...agentSections);

  if (blocks.length === 0) {
    return undefined;
  }

  return `${blocks.join("\n").trim()}\n`;
}
