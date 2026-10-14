import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";

/** An icon an MCP server advertises (MCP `Icon`, spec 2025-11-25). */
export interface McpServerIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

/**
 * What a host needs to show whose tool an MCP call is: the configured name
 * (the `<server>` in `mcp__<server>__<tool>`), the origin of its endpoint for
 * HTTP servers, and the presentation metadata the server advertised.
 */
export interface McpServerSummary {
  name: string;
  /** Origin only: paths and query strings can carry credentials. */
  url?: string;
  title?: string;
  websiteUrl?: string;
  icons?: McpServerIcon[];
}

/**
 * Raw frame carrying the run's MCP servers, recorded alongside the
 * provider's own events. Claude Code runs emit it as a `system` message, the
 * sandbox daemon writes the same shape (see the daemon script).
 */
export interface ClaudeMcpServersFrame {
  type: "system";
  subtype: "mcp_servers";
  mcp_servers: McpServerSummary[];
}

export function urlOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export function mcpServerIcons(value: unknown): McpServerIcon[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const icons = value.filter(
    (icon): icon is McpServerIcon =>
      !!icon &&
      typeof icon === "object" &&
      typeof (icon as { src?: unknown }).src === "string",
  );
  return icons.length > 0 ? icons : undefined;
}

export function compactMcpServer(summary: McpServerSummary): McpServerSummary {
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  ) as McpServerSummary;
}

/** Codex's twin of {@link ClaudeMcpServersFrame}, shaped like its notifications. */
export interface CodexMcpServersFrame {
  method: "agentbox/mcpServers";
  params: { servers: McpServerSummary[] };
}

/** The fields of a Codex `mcpServerStatus/list` entry read here. */
export interface CodexMcpServerStatus {
  name: string;
  httpOrigin?: string | null;
  serverInfo?: {
    title?: string | null;
    websiteUrl?: string | null;
    icons?: unknown[] | null;
  } | null;
}

export function codexMcpServersFrame(
  statuses: CodexMcpServerStatus[],
): CodexMcpServersFrame {
  return {
    method: "agentbox/mcpServers",
    params: {
      servers: statuses.map((status) =>
        compactMcpServer({
          name: status.name,
          url: urlOrigin(status.httpOrigin),
          title: status.serverInfo?.title ?? undefined,
          websiteUrl: urlOrigin(status.serverInfo?.websiteUrl),
          icons: mcpServerIcons(status.serverInfo?.icons),
        }),
      ),
    },
  };
}

export function claudeMcpServersFrame(
  statuses: McpServerStatus[],
): ClaudeMcpServersFrame {
  return {
    type: "system",
    subtype: "mcp_servers",
    mcp_servers: statuses.map((status) => {
      // The SDK types `serverInfo` as name/version only; the CLI may pass
      // the rest of the server's `Implementation` through.
      const info = (status.serverInfo ?? {}) as Record<string, unknown>;
      const config = (status.config ?? {}) as { url?: unknown };
      return compactMcpServer({
        name: status.name,
        url: urlOrigin(config.url),
        title: typeof info.title === "string" ? info.title : undefined,
        websiteUrl: urlOrigin(info.websiteUrl),
        icons: mcpServerIcons(info.icons),
      });
    }),
  };
}
