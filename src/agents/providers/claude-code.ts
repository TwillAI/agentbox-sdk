import { randomUUID } from "node:crypto";
import path from "node:path";

import { createNormalizedEvent, type RawAgentEvent } from "../../events";
import type { PermissionRequestedEvent } from "../../events";
import { sleep } from "../../shared/network";
import { shellQuote } from "../../shared/shell";
import {
  AgentProvider,
  type AgentAttachRequest,
  type AgentExecutionRequest,
  type AgentOptions,
  type AgentProviderAdapter,
  type AgentRunSink,
  type AgentSetupRequest,
  type UserContent,
} from "../types";
import { SandboxProvider } from "../../sandboxes/types";
import { shouldAutoApproveClaudeTools } from "../approval";
import { mapToClaudeUserContent, validateProviderUserInput } from "../input";
import {
  assertCommandsSupported,
  buildClaudeCommandArtifacts,
} from "../config/commands";
import { buildClaudeHookSettings, assertHooksSupported } from "../config/hooks";
import { buildClaudeMcpConfig } from "../config/mcp";
import { agentboxRoot, createSetupTarget } from "../config/setup";
import { applyDifferentialSetup } from "../config/setup-manifest";
import { prepareSkillArtifacts } from "../config/skills";
import { buildClaudeSubagentArtifacts } from "../config/subagents";
import {
  SharedSdkWsConnection,
  SdkWsServer,
  type SdkWsMessage,
  type SdkWsTransport,
} from "../transports/sdk-ws";
import { spawnCommand } from "../transports/spawn";
import { extractClaudeCostData } from "../cost";
import { debugClaude, debugRelay, time } from "../../shared/debug";

/**
 * Path to the on-disk `.claude` config directory agentbox uses for a
 * given run. Resolves to `/tmp/agentbox/claude-code/.claude` in a
 * sandbox, or `<os.tmpdir()>/agentbox-claude-code/.claude` on the host.
 *
 * `setup()` writes settings, MCP config, sub-agent / skill / command
 * files under this directory; `execute()` derives the same path
 * independently and lets the CLI auto-discover everything via
 * `CLAUDE_CONFIG_DIR`. There is no setup → execute data channel.
 */
function claudeConfigDir(options: AgentOptions<"claude-code">): string {
  return path.join(
    agentboxRoot(AgentProvider.ClaudeCode, Boolean(options.sandbox)),
    ".claude",
  );
}

export function buildClaudeCliArgs(params: {
  sdkUrl: string;
  request: AgentExecutionRequest<"claude-code">;
  /**
   * `settingsPath` and `mcpConfigPath` are deterministic per-sandbox
   * locations; `setup()` ensures both files exist (with empty
   * placeholders if no hooks / no MCPs were configured), so `execute()`
   * always passes both flags without inspecting any agent-config.
   */
  settingsPath: string;
  mcpConfigPath: string;
}): string[] {
  const { sdkUrl, request, settingsPath, mcpConfigPath } = params;
  const provider = request.options.provider;
  return [
    "--sdk-url",
    sdkUrl,
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    ...(provider?.verbose ? ["--verbose"] : []),
    ...(request.run.model ? ["--model", request.run.model] : []),
    ...(request.run.reasoning ? ["--effort", request.run.reasoning] : []),
    ...(provider?.permissionMode
      ? ["--permission-mode", provider.permissionMode]
      : []),
    ...(provider?.allowedTools?.length
      ? ["--allowedTools", provider.allowedTools.join(",")]
      : []),
    ...(request.run.resumeSessionId ? ["-r", request.run.resumeSessionId] : []),
    "--settings",
    settingsPath,
    "--mcp-config",
    mcpConfigPath,
    ...(provider?.args ?? []),
    "-p",
    "",
  ];
}

const REMOTE_SDK_RELAY_PORT = 43180;
const REMOTE_SDK_RELAY_PATH = "/tmp/agentbox/claude-code/relay.mjs";

function toRawEvent(
  runId: string,
  payload: unknown,
  type: string,
): RawAgentEvent {
  return {
    provider: AgentProvider.ClaudeCode,
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function extractAssistantText(message: SdkWsMessage): string {
  const content = message.message as
    | Array<Record<string, unknown>>
    | Record<string, unknown>
    | undefined;

  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");
  }

  if (content && Array.isArray(content.content)) {
    return (content.content as Array<Record<string, unknown>>)
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");
  }

  return "";
}

function extractStreamDelta(message: SdkWsMessage): string {
  const event = message.event as Record<string, unknown> | undefined;
  if (!event) {
    return "";
  }

  const delta = event.delta as Record<string, unknown> | undefined;
  if (typeof delta?.text === "string") {
    return delta.text;
  }

  if (typeof event.text === "string") {
    return event.text;
  }

  return "";
}

function extractThinkingDelta(message: SdkWsMessage): string {
  const event = message.event as Record<string, unknown> | undefined;
  const delta = event?.delta as Record<string, unknown> | undefined;
  if (typeof delta?.thinking === "string") {
    return delta.thinking;
  }
  if (typeof delta?.reasoning === "string") {
    return delta.reasoning;
  }
  if (typeof event?.thinking === "string") {
    return event.thinking;
  }
  if (typeof event?.reasoning === "string") {
    return event.reasoning;
  }
  return "";
}

function extractAssistantThinking(message: SdkWsMessage): string {
  const content = message.message as
    | Array<Record<string, unknown>>
    | Record<string, unknown>
    | undefined;

  const blocks = Array.isArray(content)
    ? content
    : content && Array.isArray(content.content)
      ? (content.content as Array<Record<string, unknown>>)
      : [];

  return blocks
    .filter((block) => block.type === "thinking" || block.type === "reasoning")
    .map((block) =>
      String(block.thinking ?? block.reasoning ?? block.text ?? ""),
    )
    .filter(Boolean)
    .join("");
}

function createClaudePermissionEvent(
  request: AgentExecutionRequest<"claude-code">,
  message: SdkWsMessage,
): PermissionRequestedEvent {
  const requestPayload = (message.request ?? {}) as Record<string, unknown>;
  return createNormalizedEvent(
    "permission.requested",
    {
      provider: request.provider,
      runId: request.runId,
      raw: toRawEvent(request.runId, message, message.type),
    },
    {
      requestId: String(message.request_id ?? ""),
      kind: "tool",
      title: `Approve ${String(requestPayload.tool_name ?? "tool")} tool`,
      message: `Claude wants to use ${String(requestPayload.tool_name ?? "tool")}.`,
      input: requestPayload.input,
      canRemember: false,
    },
  ) as PermissionRequestedEvent;
}

function createRemoteSdkRelayScript(): string {
  return `
import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.argv[2] ?? "43180");
const magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const channels = new Map();
let hostSocket = null;

function getChannel(runId) {
  let channel = channels.get(runId);
  if (!channel) {
    channel = {
      claude: null,
      pending: {
        toHost: [],
        claude: [],
      },
    };
    channels.set(runId, channel);
  }
  return channel;
}

function sendFrame(socket, payload, opcode = 0x1) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, payload]));
}

function parseFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  let payload = buffer.subarray(offset, offset + length);
  if (mask) {
    payload = Buffer.from(payload);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    fin,
    opcode,
    payload,
    bytesUsed: offset + length,
  };
}

function sendHostEnvelope(runId, message) {
  if (!hostSocket) {
    return false;
  }
  sendFrame(
    hostSocket,
    Buffer.from(JSON.stringify({ runId, message }), "utf8"),
  );
  return true;
}

function flushClaude(channel) {
  const socket = channel.claude;
  if (!socket) {
    return;
  }
  while (channel.pending.claude.length > 0) {
    sendFrame(socket, Buffer.from(channel.pending.claude.shift(), "utf8"));
  }
}

function flushHostBacklog() {
  if (!hostSocket) {
    return;
  }
  for (const [runId, channel] of channels.entries()) {
    while (channel.pending.toHost.length > 0) {
      sendHostEnvelope(runId, channel.pending.toHost.shift());
    }
  }
}

function relayFromClaude(runId, message) {
  const channel = getChannel(runId);
  if (!sendHostEnvelope(runId, message)) {
    channel.pending.toHost.push(message);
  }
}

// Stateless control endpoints.
//
// Any process with the relay's preview URL can issue control commands
// against a runId without holding the host WebSocket slot. \`abort\`
// sends an interrupt control_request frame (best-effort) and then
// destroys the relay's claude-side socket so the in-sandbox claude
// CLI loses its SDK channel and exits. \`sendMessage\` synthesizes a
// fresh user frame on the live claude socket.
function handleControlAbort(runId, response) {
  const channel = channels.get(runId);
  if (!channel || !channel.claude) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "no claude channel for runId" }));
    return;
  }
  try {
    const interrupt = {
      type: "control_request",
      request_id: crypto.randomUUID(),
      request: { subtype: "interrupt" },
    };
    sendFrame(channel.claude, Buffer.from(JSON.stringify(interrupt) + "\\n", "utf8"));
  } catch {}
  try {
    channel.claude.destroy();
  } catch {}
  channel.claude = null;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
}

function handleControlSendMessage(runId, body, response) {
  const channel = getChannel(runId);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "invalid json body" }));
    return;
  }
  const content = parsed?.content;
  if (!Array.isArray(content)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "content must be an array of claude SDK content blocks" }));
    return;
  }
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
  const messageUuid = crypto.randomUUID();
  const message = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: messageUuid,
  };
  const payload = JSON.stringify(message) + "\\n";
  if (channel.claude) {
    sendFrame(channel.claude, Buffer.from(payload, "utf8"));
  } else {
    channel.pending.claude.push(payload);
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, messageId: messageUuid }));
}

function registerClaudePeer(socket, runId) {
  const channel = getChannel(runId);
  channel.claude = socket;
  flushClaude(channel);
  let buffer = Buffer.alloc(0);
  let fragments = [];

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const frame = parseFrame(buffer);
      if (!frame) {
        return;
      }
      buffer = buffer.subarray(frame.bytesUsed);

      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        sendFrame(socket, frame.payload, 0xA);
        continue;
      }
      if (frame.opcode === 0xA) {
        continue;
      }
      if (frame.opcode === 0x1) {
        fragments = [frame.payload];
      } else if (frame.opcode === 0x0) {
        fragments.push(frame.payload);
      } else {
        continue;
      }

      if (frame.fin) {
        const text = Buffer.concat(fragments).toString("utf8");
        for (const line of text
          .split("\\n")
          .map((value) => value.trim())
          .filter(Boolean)) {
          relayFromClaude(runId, JSON.parse(line));
        }
        fragments = [];
      }
    }
  });

  const clearPeer = () => {
    const latestChannel = channels.get(runId);
    if (!latestChannel) {
      return;
    }
    if (latestChannel.claude === socket) {
      latestChannel.claude = null;
    }
    if (
      latestChannel.claude === null &&
      latestChannel.pending.toHost.length === 0 &&
      latestChannel.pending.claude.length === 0
    ) {
      channels.delete(runId);
    }
  };
  socket.on("close", clearPeer);
  socket.on("error", clearPeer);
}

function registerHostPeer(socket) {
  hostSocket = socket;
  flushHostBacklog();

  let buffer = Buffer.alloc(0);
  let fragments = [];

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const frame = parseFrame(buffer);
      if (!frame) {
        return;
      }
      buffer = buffer.subarray(frame.bytesUsed);

      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        sendFrame(socket, frame.payload, 0xA);
        continue;
      }
      if (frame.opcode === 0xA) {
        continue;
      }
      if (frame.opcode === 0x1) {
        fragments = [frame.payload];
      } else if (frame.opcode === 0x0) {
        fragments.push(frame.payload);
      } else {
        continue;
      }

      if (frame.fin) {
        const envelope = JSON.parse(Buffer.concat(fragments).toString("utf8"));
        const runId = String(envelope.runId ?? "");
        const message = envelope.message;
        if (!runId || !message) {
          fragments = [];
          continue;
        }
        const channel = getChannel(runId);
        if (channel.claude) {
          sendFrame(
            channel.claude,
            Buffer.from(JSON.stringify(message) + "\\n", "utf8"),
          );
        } else {
          channel.pending.claude.push(JSON.stringify(message) + "\\n");
        }
        fragments = [];
      }
    }
  });

  const clearHost = () => {
    if (hostSocket === socket) {
      hostSocket = null;
    }
  };
  socket.on("close", clearHost);
  socket.on("error", clearHost);
}

const RELAY_PROTOCOL_VERSION = "2";

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/__version") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(RELAY_PROTOCOL_VERSION);
    return;
  }
  if (request.method === "POST" && typeof request.url === "string") {
    const url = new URL(request.url, "http://127.0.0.1");
    const abortMatch = url.pathname.match(/^\\/runs\\/([^/]+)\\/abort$/);
    if (abortMatch) {
      handleControlAbort(decodeURIComponent(abortMatch[1]), response);
      return;
    }
    const sendMatch = url.pathname.match(/^\\/runs\\/([^/]+)\\/sendMessage$/);
    if (sendMatch) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          request.destroy();
        }
      });
      request.on("end", () => {
        try {
          handleControlSendMessage(decodeURIComponent(sendMatch[1]), body, response);
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
        }
      });
      return;
    }
  }
  response.writeHead(426, { "content-type": "text/plain" });
  response.end("Upgrade Required");
});

server.on("upgrade", (request, socket) => {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + magic)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + accept,
      "",
      "",
    ].join("\\r\\n"),
  );

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const role = url.searchParams.get("role") === "host" ? "host" : "claude";
  if (role === "host") {
    registerHostPeer(socket);
    return;
  }

  const runId = url.searchParams.get("runId") ?? "default";
  registerClaudePeer(socket, runId);
});

server.listen(port, "0.0.0.0");

const shutdown = () => {
  hostSocket?.destroy();
  for (const channel of channels.values()) {
    channel.claude?.destroy();
  }
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`.trimStart();
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

function toSharedHostWebSocketUrl(url: string): string {
  const parsed = new URL(toWebSocketUrl(url));
  parsed.searchParams.set("role", "host");
  parsed.searchParams.delete("runId");
  return parsed.toString();
}

function toClaudeRelayUrl(port: number, runId: string): string {
  const parsed = new URL(`ws://127.0.0.1:${port}/`);
  parsed.searchParams.set("role", "claude");
  parsed.searchParams.set("runId", runId);
  return parsed.toString();
}

function buildLocalSdkUrl(
  server: SdkWsServer,
  sandboxProvider?: string,
): string {
  if (sandboxProvider === SandboxProvider.LocalDocker) {
    return server.url
      .replace("127.0.0.1", "host.docker.internal")
      .replace("0.0.0.0", "host.docker.internal");
  }

  return server.url;
}

async function connectRemoteTransport(
  url: string,
  headers: Record<string, string> = {},
): Promise<SharedSdkWsConnection> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 30_000) {
    const client = new SharedSdkWsConnection(url, headers);
    try {
      await Promise.race([
        client.start(),
        sleep(2_000).then(() => {
          throw new Error(
            `Timed out connecting to remote SDK bridge at ${url}.`,
          );
        }),
      ]);
      return client;
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
      await sleep(250);
    }
  }

  throw (
    lastError ?? new Error(`Could not connect to remote SDK bridge at ${url}.`)
  );
}

/**
 * Resolve the relay endpoint for `sandbox`, starting the in-sandbox relay
 * process if it isn't already running.
 *
 * One Modal exec covers everything: the relay script is shipped via the
 * tarball, then a single bash command short-circuits if the port is
 * already listening (warm sandbox: the previously-spawned relay is still
 * around) and otherwise daemonizes a fresh `node relay.mjs`.
 *
 * No sandbox-side WS probe runs: the host's `connectRemoteTransport`
 * retries until success, which IS the readiness check. If the relay
 * never comes up, that timeout surfaces as a connection error after the
 * normal grace period.
 */
/**
 * Bumped whenever the embedded relay script's protocol changes (e.g. new
 * HTTP control endpoints). The probe asks the running relay for its
 * `/__version` and only reuses it on an exact match — older relays
 * return 426 and trigger a kill+re-spawn so warm sandboxes pick up the
 * new code automatically.
 */
const RELAY_PROTOCOL_VERSION = "2";

async function ensureRemoteRelay(
  options: AgentOptions<"claude-code">,
  env: Record<string, string>,
): Promise<void> {
  return time(debugRelay, "ensureRemoteRelay", async () => {
    const sandbox = options.sandbox!;

    const relayLogPath = "/tmp/agentbox/claude-code/relay.log";
    const relayPidPath = "/tmp/agentbox/claude-code/relay.pid";

    // Fast-path: ask the running relay for its protocol version. We
    // only reuse if the version matches the one we ship — that protects
    // warm sandboxes whose existing relay predates a protocol change
    // (e.g. the HTTP control endpoints) and would otherwise reject our
    // attach calls.
    const probe = await time(debugRelay, "probe relay version", () =>
      sandbox.run(
        `curl -fsS --max-time 1 http://127.0.0.1:${REMOTE_SDK_RELAY_PORT}/__version 2>/dev/null`,
        { cwd: options.cwd, timeoutMs: 3_000 },
      ),
    );
    if (
      probe.exitCode === 0 &&
      probe.combinedOutput.trim() === RELAY_PROTOCOL_VERSION
    ) {
      debugRelay(
        "relay v%s already running — reusing without upload",
        RELAY_PROTOCOL_VERSION,
      );
      return;
    }

    // Cold path: kill any stale relay (old version or unrelated process
    // squatting on the port), upload the new script, and spawn it. The
    // kill step is best-effort: `relay.pid` may be missing on a fresh
    // sandbox or stale on a warm one, and `fuser` is unavailable on
    // some base images — both branches `|| true` so the launch doesn't
    // fail.
    //
    // `nohup … & echo $! > pid` must live inside a subshell — `/bin/sh`
    // rejects `cmd & && cmd2` as a syntax error.
    const launchCommand = [
      `mkdir -p ${shellQuote(path.posix.dirname(REMOTE_SDK_RELAY_PATH))}`,
      `if [ -f ${shellQuote(relayPidPath)} ]; then kill -TERM "$(cat ${shellQuote(relayPidPath)})" 2>/dev/null || true; fi`,
      `(fuser -k -n tcp ${REMOTE_SDK_RELAY_PORT} 2>/dev/null || true)`,
      `sleep 0.5`,
      `(nohup node ${shellQuote(REMOTE_SDK_RELAY_PATH)} ${REMOTE_SDK_RELAY_PORT} > ${shellQuote(relayLogPath)} 2>&1 & echo $! > ${shellQuote(relayPidPath)})`,
    ].join(" && ");

    await time(debugRelay, "uploadAndRun relay (write + spawn)", () =>
      sandbox.uploadAndRun(
        [
          {
            path: REMOTE_SDK_RELAY_PATH,
            content: createRemoteSdkRelayScript(),
            mode: 0o644,
          },
        ],
        launchCommand,
        {
          cwd: options.cwd,
          env: { ...env, IS_SANDBOX: "1" },
        },
      ),
    );
  });
}

export class ClaudeCodeAgentAdapter implements AgentProviderAdapter<"claude-code"> {
  /**
   * Sandbox-side preparation for the claude-code runtime.
   *
   * `setup()` is the ONLY place agent-config (skills, commands, MCPs,
   * hooks, sub-agents) is read. All of it is persisted to deterministic
   * file paths under the sandbox layout's `.claude/` dir. With
   * `CLAUDE_CONFIG_DIR` pointed at that dir from `execute()`, the CLI
   * picks everything up at startup. There is no wire-protocol fallback.
   *
   * Side effects (all idempotent):
   *   1. Upload artifacts via the differential-setup manifest:
   *      - skills/, commands/, agents/<name>.md (sub-agents)
   *      - settings.json (always — `{}` if no hooks)
   *      - agentbox-mcp.json (always — `{"mcpServers":{}}` if no MCPs)
   *   2. For remote sandboxes, ensure the in-sandbox SDK relay is
   *      listening on `REMOTE_SDK_RELAY_PORT` (curl probe + spawn on
   *      cold path).
   */
  async setup(request: AgentSetupRequest<"claude-code">): Promise<void> {
    await time(debugClaude, "claude-code setup()", async () => {
      const options = request.options;
      const provider = request.provider;

      const target = await createSetupTarget(provider, "shared-setup", options);
      const settingsPath = path.join(target.layout.claudeDir, "settings.json");
      const mcpConfigPath = path.join(
        target.layout.claudeDir,
        "agentbox-mcp.json",
      );

      const hooks = assertHooksSupported(provider, options);
      assertCommandsSupported(provider, options.commands);

      const { artifacts: skillArtifacts, installCommands } = await time(
        debugClaude,
        "prepareSkillArtifacts",
        () => prepareSkillArtifacts(provider, options.skills, target.layout),
      );

      // settings.json and agentbox-mcp.json are ALWAYS written, even
      // when the user configured no hooks / no MCPs. That way
      // `execute()` can pass `--settings <static-path>` and
      // `--mcp-config <static-path>` unconditionally without ever
      // needing to read agent-config to decide.
      const hookSettings = buildClaudeHookSettings(hooks) ?? {};
      const mcpConfigJson =
        buildClaudeMcpConfig(options.mcps) ??
        JSON.stringify({ mcpServers: {} }, null, 2);

      const artifacts = [
        ...skillArtifacts,
        ...buildClaudeCommandArtifacts(options.commands, target.layout),
        ...buildClaudeSubagentArtifacts(options.subAgents, target.layout),
        {
          path: settingsPath,
          content: JSON.stringify(hookSettings, null, 2),
        },
        {
          path: mcpConfigPath,
          content: mcpConfigJson,
        },
      ];

      // Upload artifacts and (in parallel) start the relay on remote
      // sandboxes. The two operations don't depend on each other —
      // artifact paths are stable and the relay script is shipped via
      // its own tarball inside `ensureRemoteRelay`.
      const env = { ...(options.env ?? {}), ...target.env };
      const tasks: Array<Promise<void>> = [
        time(debugClaude, "applyDifferentialSetup", () =>
          applyDifferentialSetup(target, artifacts, installCommands),
        ),
      ];

      const isRemoteSandbox =
        options.sandbox &&
        options.sandbox.provider !== SandboxProvider.LocalDocker;
      if (isRemoteSandbox) {
        tasks.push(ensureRemoteRelay(options, env));
      }

      await Promise.all(tasks);
    });
  }

  async execute(
    request: AgentExecutionRequest<"claude-code">,
    sink: AgentRunSink,
  ): Promise<() => Promise<void>> {
    const executeStartedAt = Date.now();
    debugClaude("execute() start runId=%s", request.runId);

    // Spawn context. Constants only — no agent-config touched.
    // `setup()` wrote skills/hooks/mcps/commands/subAgents into
    // `<claudeDir>/...`; the CLI auto-discovers them via
    // `CLAUDE_CONFIG_DIR`. settings.json and the MCP config still get
    // explicit CLI flags so claude is unambiguous about which files
    // to read.
    const claudeDir = claudeConfigDir(request.options);
    const settingsPath = path.join(claudeDir, "settings.json");
    const mcpConfigPath = path.join(claudeDir, "agentbox-mcp.json");
    const env: Record<string, string> = {
      ...(request.options.env ?? {}),
      CLAUDE_CONFIG_DIR: claudeDir,
    };
    // The system prompt is per-RUN (AgentRunConfig); we forward it
    // through the CLI's `initialize` control message at the start of
    // the stream.
    const initializeRequest = request.run.systemPrompt
      ? { subtype: "initialize", systemPrompt: request.run.systemPrompt }
      : undefined;

    const inputParts = await time(
      debugClaude,
      "validateProviderUserInput",
      () => validateProviderUserInput(request.provider, request.run.input),
    );
    const userContent = mapToClaudeUserContent(inputParts);

    let sessionId = "";
    let accumulatedText = "";
    let usedStreaming = false;
    let pendingMessages = 1;
    let firstTransportMessageLogged = false;
    let firstTextDeltaLogged = false;
    const autoApproveTools = shouldAutoApproveClaudeTools(request.options);

    // Register `onMessage` synchronously so callers can send follow-up
    // messages as soon as they have the run handle, even while the
    // transport is still coming up. Messages that arrive before the
    // transport is connected are queued and flushed once it is.
    const transportRef: { current?: SdkWsTransport } = {};
    const queuedSends: Array<Parameters<SdkWsTransport["send"]>[0]> = [];

    sink.onMessage(async (content: UserContent) => {
      pendingMessages++;
      const parts = await validateProviderUserInput(request.provider, content);
      const mapped = mapToClaudeUserContent(parts);
      accumulatedText = "";
      usedStreaming = false;
      const messageUuid = randomUUID();
      const payload = {
        type: "user" as const,
        message: { role: "user" as const, content: mapped },
        parent_tool_use_id: null,
        session_id: sessionId || request.run.resumeSessionId || "",
        uuid: messageUuid,
      };
      if (transportRef.current) {
        await transportRef.current.send(payload);
      } else {
        queuedSends.push(payload);
      }
      return { messageId: messageUuid };
    });

    // Spawn the claude CLI + open the host-side transport. There are
    // exactly three transport modes — branched inline (no createRuntime
    // indirection):
    //
    //   - Host (no sandbox): SdkWsServer on 127.0.0.1, claude spawned via
    //     spawnCommand.
    //   - LocalDocker: SdkWsServer on 0.0.0.0, claude spawned via
    //     sandbox.runAsync, --sdk-url points at host.docker.internal.
    //   - Remote sandbox: claude spawned via sandbox.runAsync targeting
    //     the in-sandbox relay (started in setup()), host dials the
    //     relay's preview URL.
    const sandbox = request.options.sandbox;
    const isRemoteSandbox =
      sandbox && sandbox.provider !== SandboxProvider.LocalDocker;

    let transport: SdkWsTransport;
    let raw: unknown;
    let cleanup: () => Promise<void>;

    if (isRemoteSandbox) {
      const previewUrl = await time(debugClaude, "getPreviewLink relay", () =>
        sandbox!.getPreviewLink(REMOTE_SDK_RELAY_PORT),
      );

      const args = buildClaudeCliArgs({
        sdkUrl: toClaudeRelayUrl(REMOTE_SDK_RELAY_PORT, request.runId),
        request,
        settingsPath: settingsPath,
        mcpConfigPath: mcpConfigPath,
      });

      // Spawn claude AND dial the host-side WebSocket in parallel. The
      // relay buffers frames bound for claude until the claude process
      // attaches, so the order in which these two land is safe. Each run
      // opens its own host-side WebSocket — we do NOT cache connections
      // in process memory because that can't be reasoned about across
      // instances in a multi-instance deployment (e.g. Cloud Run).
      const [handle, connection] = await time(
        debugClaude,
        "spawn claude binary || connectRemoteTransport (parallel)",
        () =>
          Promise.all([
            sandbox!.runAsync(
              [request.options.provider?.binary ?? "claude", ...args],
              {
                cwd: request.options.cwd,
                env: { ...env, IS_SANDBOX: "1" },
                pty: true,
              },
            ),
            connectRemoteTransport(
              toSharedHostWebSocketUrl(previewUrl),
              sandbox!.previewHeaders,
            ),
          ]),
      );
      const channel = connection.createChannel(request.runId);
      transport = channel;
      raw = { transport: channel, handle, claudeDir };
      cleanup = async () => {
        await handle.kill().catch(() => undefined);
        await channel.close().catch(() => undefined);
        await connection.close().catch(() => undefined);
      };
    } else {
      const sandboxProvider = sandbox?.provider;
      const server = new SdkWsServer({
        host:
          sandboxProvider === SandboxProvider.LocalDocker
            ? "0.0.0.0"
            : "127.0.0.1",
      });
      await server.start();

      const args = buildClaudeCliArgs({
        sdkUrl: buildLocalSdkUrl(server, sandboxProvider),
        request,
        settingsPath: settingsPath,
        mcpConfigPath: mcpConfigPath,
      });

      if (sandbox) {
        const handle = await sandbox.runAsync(
          [request.options.provider?.binary ?? "claude", ...args],
          {
            cwd: request.options.cwd,
            env: { ...env },
            pty: true,
          },
        );
        transport = server;
        raw = { transport: server, handle, claudeDir };
        cleanup = async () => {
          await handle.kill();
          await server.close();
        };
      } else {
        const processHandle = spawnCommand({
          command: request.options.provider?.binary ?? "claude",
          args,
          cwd: request.options.cwd,
          env: {
            ...process.env,
            ...env,
          },
        });
        transport = server;
        raw = { transport: server, processHandle, claudeDir };
        cleanup = async () => {
          await processHandle.kill();
          await server.close();
        };
      }
    }

    transportRef.current = transport;
    sink.setRaw(raw);
    sink.setAbort(cleanup);
    sink.emitEvent(
      createNormalizedEvent("run.started", {
        provider: request.provider,
        runId: request.runId,
      }),
    );

    const rawPayloads: Array<Record<string, unknown>> = [];
    const completion = new Promise<{ text: string }>((resolve, reject) => {
      void (async () => {
        for await (const message of transport.messages()) {
          if (!firstTransportMessageLogged) {
            firstTransportMessageLogged = true;
            debugClaude(
              "★ first transport message (%dms since execute start) type=%s",
              Date.now() - executeStartedAt,
              message.type,
            );
          }
          rawPayloads.push(message);
          sink.emitRaw(toRawEvent(request.runId, message, message.type));

          if (message.type === "system" && message.subtype === "init") {
            sessionId = String(message.session_id ?? "");
            if (sessionId) {
              sink.setSessionId(sessionId);
            }
            continue;
          }

          if (
            message.type === "control_request" &&
            (message.request as Record<string, unknown> | undefined)
              ?.subtype === "can_use_tool"
          ) {
            const requestId = String(message.request_id ?? "");
            const requestPayload = message.request as Record<string, unknown>;
            const response = autoApproveTools
              ? {
                  requestId,
                  decision: "allow" as const,
                }
              : await sink.requestPermission(
                  createClaudePermissionEvent(request, message),
                );

            if (response.decision === "allow") {
              sink.emitEvent(
                createNormalizedEvent(
                  "tool.call.started",
                  {
                    provider: request.provider,
                    runId: request.runId,
                  },
                  {
                    toolName: String(requestPayload.tool_name ?? "tool"),
                    callId: requestId,
                    input: requestPayload.input,
                  },
                ),
              );
            }

            await transport.send({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: requestId,
                response:
                  response.decision === "allow"
                    ? {
                        behavior: "allow",
                        updatedInput: requestPayload.input,
                      }
                    : {
                        behavior: "deny",
                        message: "User denied this action.",
                      },
              },
            });
            continue;
          }

          if (message.type === "stream_event") {
            const thinkingDelta = extractThinkingDelta(message);
            if (thinkingDelta) {
              sink.emitEvent(
                createNormalizedEvent(
                  "reasoning.delta",
                  {
                    provider: request.provider,
                    runId: request.runId,
                  },
                  {
                    delta: thinkingDelta,
                  },
                ),
              );
            }
            const delta = extractStreamDelta(message);
            if (delta) {
              if (!firstTextDeltaLogged) {
                firstTextDeltaLogged = true;
                debugClaude(
                  "★ first text delta (%dms since execute start)",
                  Date.now() - executeStartedAt,
                );
              }
              usedStreaming = true;
              accumulatedText += delta;
              sink.emitEvent(
                createNormalizedEvent(
                  "text.delta",
                  {
                    provider: request.provider,
                    runId: request.runId,
                  },
                  {
                    delta,
                  },
                ),
              );
            }
            continue;
          }

          if (message.type === "assistant") {
            const thinking = extractAssistantThinking(message);
            if (thinking) {
              sink.emitEvent(
                createNormalizedEvent(
                  "reasoning.delta",
                  {
                    provider: request.provider,
                    runId: request.runId,
                  },
                  {
                    delta: thinking,
                  },
                ),
              );
            }
            const text = extractAssistantText(message);
            if (!usedStreaming && text) {
              accumulatedText = text;
              sink.emitEvent(
                createNormalizedEvent(
                  "text.delta",
                  {
                    provider: request.provider,
                    runId: request.runId,
                  },
                  {
                    delta: text,
                  },
                ),
              );
            }

            const assistantId =
              typeof (message as Record<string, unknown>).uuid === "string"
                ? String((message as Record<string, unknown>).uuid)
                : undefined;
            sink.emitEvent(
              createNormalizedEvent(
                "message.completed",
                {
                  provider: request.provider,
                  runId: request.runId,
                },
                {
                  text,
                  ...(assistantId ? { messageId: assistantId } : {}),
                },
              ),
            );
            continue;
          }

          if (message.type === "result") {
            // `result` is the terminal message for a turn. Whether the
            // subtype is `success` or a non-success variant
            // (`error_during_execution`, an interrupt-induced result,
            // etc.) the turn is done — the SDK should unwind cleanly
            // either way. Rejecting on non-success used to surface
            // every external interrupt as `Claude Code run failed.`,
            // which is wrong: an `Agent.attach({...}).abort()` from
            // another instance feeds an `interrupt` control_request
            // into the relay, claude responds with a non-success
            // result, and the originating run should resolve with
            // whatever text streamed before the interrupt — not throw.
            //
            // Genuine fatal failures still propagate via other paths:
            // - `auth_status` (handled below) → reject for auth errors,
            // - transport close before any result → reject by the
            //   "Claude transport closed before run completed" branch,
            // - thrown adapter errors → bubble up naturally.
            const subtype = String(message.subtype ?? "success");
            if (subtype !== "success") {
              debugClaude(
                "result subtype=%s (non-success) — resolving turn as terminal; reason=%s",
                subtype,
                String(message.result ?? message.error ?? ""),
              );
            }
            pendingMessages--;
            if (pendingMessages <= 0) {
              resolve({ text: accumulatedText });
              return;
            }
            continue;
          }

          if (
            message.type === "auth_status" &&
            message.authenticated === false
          ) {
            reject(
              new Error("Claude Code reported an authentication failure."),
            );
            return;
          }
        }

        reject(new Error("Claude Code transport closed before run completed."));
      })().catch(reject);
    });

    try {
      await time(debugClaude, "transport.waitForConnection", () =>
        transport.waitForConnection(30_000),
      );
      // Pipeline `initialize` + the first user message: we fire-and-forget
      // the `initialize` control request, then send the user message
      // immediately. WebSocket guarantees in-order delivery, so claude
      // processes init before the user message — we just don't wait for
      // the init reply on the host. This saves one round-trip-time
      // (typically ~1.3s on Modal) per run.
      let initPromise: Promise<Record<string, unknown>> | undefined;
      if (initializeRequest) {
        initPromise = transport.request(initializeRequest);
        // Surface init failures as debug logs, but don't block the rest
        // of the path on the response arriving.
        void initPromise
          .then((response: Record<string, unknown>) => {
            rawPayloads.push(response);
            sink.emitRaw(
              toRawEvent(
                request.runId,
                response,
                "control_response:initialize",
              ),
            );
          })
          .catch((error: unknown) => {
            debugClaude("initialize failed: %s", String(error));
          });
      }
      const initialUserUuid = randomUUID();
      await time(debugClaude, "send initial user message", () =>
        transport.send({
          type: "user",
          message: {
            role: "user",
            content: userContent,
          },
          parent_tool_use_id: null,
          session_id: request.run.resumeSessionId ?? "",
          uuid: initialUserUuid,
        }),
      );
      debugClaude(
        "★ ready for first model output (%dms since execute start)",
        Date.now() - executeStartedAt,
      );
      sink.emitEvent(
        createNormalizedEvent(
          "message.started",
          {
            provider: request.provider,
            runId: request.runId,
          },
          { messageId: initialUserUuid },
        ),
      );
      for (const queued of queuedSends.splice(0)) {
        await transport.send(queued);
      }
      const { text } = await completion;
      debugClaude(
        "★ run.completed (%dms since execute start) chars=%d",
        Date.now() - executeStartedAt,
        text.length,
      );
      sink.emitEvent(
        createNormalizedEvent(
          "run.completed",
          {
            provider: request.provider,
            runId: request.runId,
          },
          {
            text,
          },
        ),
      );
      sink.complete({ text, costData: extractClaudeCostData(rawPayloads) });
    } finally {
      await cleanup().catch(() => undefined);
    }

    return async () => undefined;
  }

  /**
   * Stateless abort. POST to the in-sandbox relay's
   * `/runs/<runId>/abort` HTTP endpoint. The relay sends an interrupt
   * SDK control_request frame on its claude-side socket and then
   * destroys the socket — the in-sandbox claude CLI loses its SDK
   * channel and exits, the originating instance's host WS sees the
   * channel close and settles the run.
   */
  async attachAbort(request: AgentAttachRequest<"claude-code">): Promise<void> {
    if (request.sandbox.provider === SandboxProvider.LocalDocker) {
      throw new Error(
        "claude-code stateless attach is not supported for local-docker sandboxes; the relay is host-resident.",
      );
    }
    const previewUrl = (
      await request.sandbox.getPreviewLink(REMOTE_SDK_RELAY_PORT)
    ).replace(/\/$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      await fetch(
        `${previewUrl}/runs/${encodeURIComponent(request.runId)}/abort`,
        {
          method: "POST",
          signal: controller.signal,
          headers: request.sandbox.previewHeaders,
        },
      ).catch((error) => {
        debugClaude(
          "attachAbort runId=%s POST /abort failed: %o",
          request.runId,
          error,
        );
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Stateless message injection. POST `{ content, sessionId }` to the
   * relay's `/runs/<runId>/sendMessage`. The relay synthesizes a fresh
   * `user` SDK frame on the live claude socket; the originating
   * instance picks it up through its existing event stream.
   */
  async attachSendMessage(
    request: AgentAttachRequest<"claude-code">,
    content: UserContent,
  ): Promise<void> {
    if (request.sandbox.provider === SandboxProvider.LocalDocker) {
      throw new Error(
        "claude-code stateless attach is not supported for local-docker sandboxes; the relay is host-resident.",
      );
    }
    const previewUrl = (
      await request.sandbox.getPreviewLink(REMOTE_SDK_RELAY_PORT)
    ).replace(/\/$/, "");
    const inputParts = await validateProviderUserInput(
      AgentProvider.ClaudeCode,
      content,
    );
    const mapped = mapToClaudeUserContent(inputParts);
    const response = await fetch(
      `${previewUrl}/runs/${encodeURIComponent(request.runId)}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...request.sandbox.previewHeaders,
        },
        body: JSON.stringify({
          content: mapped,
          sessionId: request.sessionId ?? "",
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `claude-code attachSendMessage failed: ${response.status} ${await response.text().catch(() => "")}`,
      );
    }
  }
}
