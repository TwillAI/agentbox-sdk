import { randomUUID } from "node:crypto";
import path from "node:path";

import { createNormalizedEvent, type RawAgentEvent } from "../../events";
import type { PermissionRequestedEvent } from "../../events";
import { sleep } from "../../shared/network";
import { shellQuote } from "../../shared/shell";
import type {
  AgentExecutionRequest,
  AgentProviderAdapter,
  AgentRunSink,
  UserContent,
} from "../types";
import { shouldAutoApproveClaudeTools } from "../approval";
import { mapToClaudeUserContent, validateProviderUserInput } from "../input";
import {
  assertCommandsSupported,
  buildClaudeCommandArtifacts,
} from "../config/commands";
import { buildClaudeHookSettings, assertHooksSupported } from "../config/hooks";
import { buildClaudeMcpArtifact } from "../config/mcp";
import { createRuntimeTarget } from "../config/runtime";
import { installSkills, prepareSkillArtifacts } from "../config/skills";
import { buildClaudeAgentsConfig } from "../config/subagents";
import type { RuntimeTarget } from "../config/types";
import {
  SharedSdkWsConnection,
  SdkWsServer,
  type SdkWsMessage,
  type SdkWsTransport,
} from "../transports/sdk-ws";
import { spawnCommand } from "../transports/spawn";
import type { AsyncCommandHandle, CommandResult } from "../../sandboxes";

type ClaudeRuntime = {
  transport: SdkWsTransport;
  cleanup: () => Promise<void>;
  raw: unknown;
  initializeRequest?: Record<string, unknown>;
};

type SharedRemoteRelay = {
  relayPort: number;
  relayPath: string;
  previewUrl: string;
  handle?: AsyncCommandHandle;
};

type SharedRemoteHostConnection = {
  previewUrl: string;
  connection: SharedSdkWsConnection;
};

const REMOTE_SDK_RELAY_PORT = 43180;
const REMOTE_SDK_RELAY_PATH = "/tmp/agentbox/claude-code/relay.mjs";
const sharedRemoteConnectionBySandbox = new WeakMap<
  object,
  Promise<SharedRemoteHostConnection>
>();

function toRawEvent(
  runId: string,
  payload: unknown,
  type: string,
): RawAgentEvent {
  return {
    provider: "claude-code",
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

async function prepareClaudeRuntime(
  request: AgentExecutionRequest<"claude-code">,
): Promise<{
  target: RuntimeTarget;
  buildArgs: (sdkUrl: string) => string[];
  env: Record<string, string>;
  initializeRequest?: Record<string, unknown>;
}> {
  const options = request.options;
  const provider = options.provider;
  const target = await createRuntimeTarget(
    request.provider,
    request.runId,
    options,
  );

  const hooks = assertHooksSupported(request.provider, options);
  assertCommandsSupported(request.provider, options.commands);

  const { artifacts: skillArtifacts, installCommands } =
    await prepareSkillArtifacts(
      request.provider,
      options.skills,
      target.layout,
    );

  const artifacts = [
    ...skillArtifacts,
    ...buildClaudeCommandArtifacts(options.commands, target.layout),
  ];

  const mcpArtifact = buildClaudeMcpArtifact(
    options.mcps,
    target.layout.claudeDir,
  );
  if (mcpArtifact) {
    artifacts.push(mcpArtifact);
  }

  const hookSettings = buildClaudeHookSettings(hooks);
  let settingsPath: string | undefined;
  if (hookSettings) {
    settingsPath = path.join(target.layout.claudeDir, "settings.json");
    artifacts.push({
      path: settingsPath,
      content: JSON.stringify(hookSettings, null, 2),
    });
  }

  for (const artifact of artifacts) {
    await target.writeArtifact(artifact);
  }
  await installSkills(target, installCommands);

  const agents = buildClaudeAgentsConfig(options.subAgents);
  const initializeRequest = Object.keys({
    ...(request.run.systemPrompt
      ? { systemPrompt: request.run.systemPrompt }
      : {}),
    ...(agents ? { agents } : {}),
  }).length
    ? {
        subtype: "initialize",
        ...(request.run.systemPrompt
          ? { systemPrompt: request.run.systemPrompt }
          : {}),
        ...(agents ? { agents } : {}),
      }
    : undefined;

  const buildArgs = (sdkUrl: string): string[] => [
    "--sdk-url",
    sdkUrl,
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    ...(provider?.verbose ? ["--verbose"] : []),
    ...(request.run.model ? ["--model", request.run.model] : []),
    ...(provider?.permissionMode
      ? ["--permission-mode", provider.permissionMode]
      : []),
    ...(provider?.allowedTools?.length
      ? ["--allowedTools", provider.allowedTools.join(",")]
      : []),
    ...(request.run.resumeSessionId ? ["-r", request.run.resumeSessionId] : []),
    ...(settingsPath ? ["--settings", settingsPath] : []),
    ...(mcpArtifact ? ["--mcp-config", mcpArtifact.path] : []),
    ...(provider?.args ?? []),
    "-p",
    "",
  ];

  const env = {
    ...(options.env ?? {}),
    ...target.env,
  };

  return {
    target,
    buildArgs,
    env,
    initializeRequest,
  };
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

const server = http.createServer((_request, response) => {
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
  if (sandboxProvider === "local-docker") {
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

async function canConnectToRemoteRelay(
  previewUrl: string,
  headers: Record<string, string> = {},
): Promise<boolean> {
  const parsed = new URL(toWebSocketUrl(previewUrl));
  parsed.searchParams.set("role", "claude");
  parsed.searchParams.set("runId", "__probe__");
  const client = new SharedSdkWsConnection(parsed.toString(), headers);
  try {
    await Promise.race([
      client.start(),
      sleep(2_000).then(() => {
        throw new Error("Timed out connecting to remote relay.");
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function ensureSharedRemoteConnection(
  sandbox: NonNullable<
    AgentExecutionRequest<"claude-code">["options"]["sandbox"]
  >,
  previewUrl: string,
): Promise<SharedRemoteHostConnection> {
  const key = sandbox as object;
  const existing = sharedRemoteConnectionBySandbox.get(key);
  if (existing) {
    try {
      const connection = await existing;
      await connection.connection.waitForConnection(1_000);
      return connection;
    } catch {
      try {
        const stale = await existing;
        await stale.connection.close().catch(() => undefined);
      } catch {
        // Ignore stale connection cleanup failures.
      }
      sharedRemoteConnectionBySandbox.delete(key);
    }
  }

  const created = (async () => {
    const url = toSharedHostWebSocketUrl(previewUrl);
    const connection = await connectRemoteTransport(url, sandbox.previewHeaders);
    return { previewUrl, connection };
  })();

  sharedRemoteConnectionBySandbox.set(key, created);
  try {
    return await created;
  } catch (error) {
    sharedRemoteConnectionBySandbox.delete(key);
    throw error;
  }
}

async function ensureRemoteRelay(
  request: AgentExecutionRequest<"claude-code">,
  prepared: Awaited<ReturnType<typeof prepareClaudeRuntime>>,
): Promise<SharedRemoteRelay> {
  const sandbox = request.options.sandbox!;
  await sandbox.openPort(REMOTE_SDK_RELAY_PORT);
  const previewUrl = await sandbox.getPreviewLink(REMOTE_SDK_RELAY_PORT);
  const previewHeaders = sandbox.previewHeaders;

  if (await canConnectToRemoteRelay(previewUrl, previewHeaders)) {
    return {
      relayPort: REMOTE_SDK_RELAY_PORT,
      relayPath: REMOTE_SDK_RELAY_PATH,
      previewUrl,
    };
  }

  await prepared.target.writeArtifact({
    path: REMOTE_SDK_RELAY_PATH,
    content: createRemoteSdkRelayScript(),
  });

  const relayLogPath = "/tmp/agentbox/claude-code/relay.log";
  const relayHandle = await sandbox.runAsync(
    [
      `mkdir -p ${shellQuote(path.posix.dirname(REMOTE_SDK_RELAY_PATH))}`,
      `mkdir -p ${shellQuote(path.posix.dirname(relayLogPath))}`,
      `node ${shellQuote(REMOTE_SDK_RELAY_PATH)} ${shellQuote(String(REMOTE_SDK_RELAY_PORT))} > ${shellQuote(relayLogPath)} 2>&1`,
    ].join(" && "),
    {
      cwd: request.options.cwd,
      env: { ...prepared.env, IS_SANDBOX: "1" },
    },
  );
  let relayExit: CommandResult | unknown;
  void relayHandle
    .wait()
    .then((result) => {
      relayExit = result;
    })
    .catch((error) => {
      relayExit = error;
    });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (await canConnectToRemoteRelay(previewUrl, previewHeaders)) {
      return {
        relayPort: REMOTE_SDK_RELAY_PORT,
        relayPath: REMOTE_SDK_RELAY_PATH,
        previewUrl,
        handle: relayHandle,
      };
    }
    if (relayExit !== undefined) {
      break;
    }
    await sleep(250);
  }

  await relayHandle.kill().catch(() => undefined);
  throw new Error(`Timed out waiting for Claude relay on ${previewUrl}.`);
}

async function createLocalRuntime(
  request: AgentExecutionRequest<"claude-code">,
  prepared: Awaited<ReturnType<typeof prepareClaudeRuntime>>,
): Promise<ClaudeRuntime> {
  const sandboxProvider = request.options.sandbox?.provider;
  const transport = new SdkWsServer({
    host: sandboxProvider === "local-docker" ? "0.0.0.0" : "127.0.0.1",
  });
  await transport.start();

  const args = prepared.buildArgs(buildLocalSdkUrl(transport, sandboxProvider));

  if (request.options.sandbox) {
    const handle = await request.options.sandbox.runAsync(
      [request.options.provider?.binary ?? "claude", ...args],
      {
        cwd: request.options.cwd,
        env: {
          ...prepared.env,
        },
        pty: true,
      },
    );

    return {
      transport,
      cleanup: async () => {
        await handle.kill();
        await transport.close();
        await prepared.target.cleanup();
      },
      raw: { transport, handle, layout: prepared.target.layout },
      initializeRequest: prepared.initializeRequest,
    };
  }

  const processHandle = spawnCommand({
    command: request.options.provider?.binary ?? "claude",
    args,
    cwd: request.options.cwd,
    env: {
      ...process.env,
      ...prepared.env,
    },
  });

  return {
    transport,
    cleanup: async () => {
      await processHandle.kill();
      await transport.close();
      await prepared.target.cleanup();
    },
    raw: { transport, processHandle, layout: prepared.target.layout },
    initializeRequest: prepared.initializeRequest,
  };
}

async function createRemoteSandboxRuntime(
  request: AgentExecutionRequest<"claude-code">,
  prepared: Awaited<ReturnType<typeof prepareClaudeRuntime>>,
): Promise<ClaudeRuntime> {
  const sandbox = request.options.sandbox!;
  const relay = await ensureRemoteRelay(request, prepared);

  const args = prepared.buildArgs(
    toClaudeRelayUrl(relay.relayPort, request.runId),
  );
  const handle = await sandbox.runAsync(
    [request.options.provider?.binary ?? "claude", ...args],
    {
      cwd: request.options.cwd,
      env: { ...prepared.env, IS_SANDBOX: "1" },
      pty: true,
    },
  );

  const sharedConnection = await ensureSharedRemoteConnection(
    sandbox,
    relay.previewUrl,
  );
  const transport = sharedConnection.connection.createChannel(request.runId);

  return {
    transport,
    cleanup: async () => {
      await handle.kill().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await prepared.target.cleanup();
    },
    raw: { transport, handle, relay, layout: prepared.target.layout },
    initializeRequest: prepared.initializeRequest,
  };
}

async function createRuntime(
  request: AgentExecutionRequest<"claude-code">,
): Promise<ClaudeRuntime> {
  if (
    request.options.sandbox &&
    request.options.sandbox.provider !== "local-docker"
  ) {
    await request.options.sandbox.openPort(REMOTE_SDK_RELAY_PORT);
    const prepared = await prepareClaudeRuntime(request);
    return createRemoteSandboxRuntime(request, prepared);
  }

  const prepared = await prepareClaudeRuntime(request);
  return createLocalRuntime(request, prepared);
}

export class ClaudeCodeAgentAdapter implements AgentProviderAdapter<"claude-code"> {
  async execute(
    request: AgentExecutionRequest<"claude-code">,
    sink: AgentRunSink,
  ): Promise<() => Promise<void>> {
    const inputParts = await validateProviderUserInput(
      request.provider,
      request.run.input,
    );
    const userContent = mapToClaudeUserContent(inputParts);

    let sessionId = "";
    let accumulatedText = "";
    let usedStreaming = false;
    let pendingMessages = 1;
    const autoApproveTools = shouldAutoApproveClaudeTools(request.options);

    // Register `onMessage` synchronously so callers can send follow-up
    // messages as soon as they have the run handle, even while the runtime
    // (sandbox + relay + WebSocket) is still coming up. Messages that arrive
    // before the transport is connected are queued and flushed once it is.
    type ClaudeTransport = Awaited<ReturnType<typeof createRuntime>>["transport"];
    const transportRef: { current?: ClaudeTransport } = {};
    const queuedSends: Array<Parameters<ClaudeTransport["send"]>[0]> = [];

    sink.onMessage(async (content: UserContent) => {
      pendingMessages++;
      const parts = await validateProviderUserInput(request.provider, content);
      const mapped = mapToClaudeUserContent(parts);
      accumulatedText = "";
      usedStreaming = false;
      const payload = {
        type: "user" as const,
        message: { role: "user" as const, content: mapped },
        parent_tool_use_id: null,
        session_id: sessionId || request.run.resumeSessionId || "",
        uuid: randomUUID(),
      };
      if (transportRef.current) {
        await transportRef.current.send(payload);
      } else {
        queuedSends.push(payload);
      }
    });

    const runtime = await createRuntime(request);
    transportRef.current = runtime.transport;
    sink.setRaw(runtime.raw);
    sink.setAbort(runtime.cleanup);
    sink.emitEvent(
      createNormalizedEvent("run.started", {
        provider: request.provider,
        runId: request.runId,
      }),
    );

    const completion = new Promise<{ text: string }>((resolve, reject) => {
      void (async () => {
        for await (const message of runtime.transport.messages()) {
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

            await runtime.transport.send({
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
            const delta = extractStreamDelta(message);
            if (delta) {
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

            sink.emitEvent(
              createNormalizedEvent(
                "message.completed",
                {
                  provider: request.provider,
                  runId: request.runId,
                },
                {
                  text,
                },
              ),
            );
            continue;
          }

          if (message.type === "result") {
            const subtype = String(message.subtype ?? "success");
            if (subtype === "success") {
              pendingMessages--;
              if (pendingMessages <= 0) {
                resolve({ text: accumulatedText });
                return;
              }
              continue;
            } else {
              reject(
                new Error(
                  String(
                    message.result ??
                      message.error ??
                      "Claude Code run failed.",
                  ),
                ),
              );
            }
            return;
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
      await runtime.transport.waitForConnection(30_000);
      if (runtime.initializeRequest) {
        const response = await runtime.transport.request(
          runtime.initializeRequest,
        );
        sink.emitRaw(
          toRawEvent(request.runId, response, "control_response:initialize"),
        );
      }
      await runtime.transport.send({
        type: "user",
        message: {
          role: "user",
          content: userContent,
        },
        parent_tool_use_id: null,
        session_id: request.run.resumeSessionId ?? "",
        uuid: randomUUID(),
      });
      sink.emitEvent(
        createNormalizedEvent("message.started", {
          provider: request.provider,
          runId: request.runId,
        }),
      );
      for (const queued of queuedSends.splice(0)) {
        await runtime.transport.send(queued);
      }
      const { text } = await completion;
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
      sink.complete({ text });
    } finally {
      await runtime.cleanup().catch(() => undefined);
    }

    return async () => undefined;
  }
}
