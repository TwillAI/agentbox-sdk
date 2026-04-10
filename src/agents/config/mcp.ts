import path from "node:path";

import type { AgentMcpConfig, TextArtifact } from "./types";

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

export function buildCodexConfigToml(
  mcps: AgentMcpConfig[] | undefined,
  agentSections: string[] = [],
  enableHooks = false,
): string | undefined {
  const blocks: string[] = [];

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

  if (enableHooks) {
    blocks.push("[features]");
    blocks.push("codex_hooks = true");
    blocks.push("");
  }

  blocks.push(...agentSections);

  if (blocks.length === 0) {
    return undefined;
  }

  return `${blocks.join("\n").trim()}\n`;
}

export function buildClaudeMcpArtifact(
  mcps: AgentMcpConfig[] | undefined,
  claudeDir: string,
): TextArtifact | undefined {
  const content = buildClaudeMcpConfig(mcps);
  if (!content) {
    return undefined;
  }

  return {
    path: path.join(claudeDir, "agentbox-mcp.json"),
    content,
  };
}
