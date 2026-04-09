import { randomUUID } from "node:crypto";
import {
  WebSocket,
  WebSocketServer,
  type RawData,
  type WebSocket as WsSocket,
} from "ws";

import { AsyncQueue } from "../../shared/async-queue";
import { getAvailablePort, waitFor } from "../../shared/network";

export interface SdkWsMessage {
  [key: string]: unknown;
  type: string;
}

export interface SdkWsTransport {
  waitForConnection(timeoutMs?: number): Promise<void>;
  send(message: SdkWsMessage): Promise<void>;
  request(request: Record<string, unknown>): Promise<SdkWsMessage>;
  close(): Promise<void>;
  messages(): AsyncIterable<SdkWsMessage>;
}

export interface SdkWsServerOptions {
  host?: string;
  port?: number;
}

type PendingResponse = {
  resolve: (message: SdkWsMessage) => void;
  reject: (error?: unknown) => void;
};

type ChannelLike = {
  handleIncomingMessage(message: SdkWsMessage): void;
  handleConnectionClosed(error: Error): void;
};

function handleIncomingMessage(
  text: string,
  messagesQueue: AsyncQueue<SdkWsMessage>,
  pendingResponses: Map<string, PendingResponse>,
): void {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let message: SdkWsMessage;
    try {
      message = JSON.parse(line) as SdkWsMessage;
    } catch {
      continue;
    }
    if (
      message.type === "control_response" &&
      typeof message.response === "object" &&
      message.response !== null
    ) {
      const requestId = String(
        (message.response as Record<string, unknown>).request_id ?? "",
      );
      const pending = pendingResponses.get(requestId);
      if (pending) {
        pendingResponses.delete(requestId);
        pending.resolve(message);
      }
    }
    messagesQueue.push(message);
  }
}

export class SdkWsServer implements SdkWsTransport {
  private server?: WebSocketServer;
  private socket?: WsSocket;
  private readonly messagesQueue = new AsyncQueue<SdkWsMessage>();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly host: string;
  private port?: number;

  constructor(options?: SdkWsServerOptions) {
    this.host = options?.host ?? "127.0.0.1";
    this.port = options?.port;
  }

  get url(): string {
    if (!this.port) {
      throw new Error("SDK WebSocket server has not been started yet.");
    }

    return `ws://${this.host}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.port ??= await getAvailablePort(this.host);
    this.server = new WebSocketServer({ host: this.host, port: this.port });

    this.server.on("connection", (socket) => {
      this.socket = socket;
      socket.on("message", (data) => this.handleMessage(data));
      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = undefined;
        }
      });
    });
    this.server.on("error", (error) => {
      this.messagesQueue.fail(error);
    });
  }

  async waitForConnection(timeoutMs = 15_000): Promise<void> {
    await waitFor(async () => Boolean(this.socket), {
      timeoutMs,
      intervalMs: 100,
    });
  }

  async send(message: SdkWsMessage): Promise<void> {
    await this.waitForConnection();
    const socket = this.socket;
    if (!socket) {
      throw new Error("SDK WebSocket server has no active connection.");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async request(request: Record<string, unknown>): Promise<SdkWsMessage> {
    const requestId = randomUUID();

    const response = new Promise<SdkWsMessage>((resolve, reject) => {
      this.pendingResponses.set(requestId, { resolve, reject });
    });

    await this.send({
      type: "control_request",
      request_id: requestId,
      request,
    });

    return response;
  }

  async close(): Promise<void> {
    this.messagesQueue.finish();
    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error("SDK WebSocket server closed."));
    }
    this.pendingResponses.clear();
    this.socket?.close();

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.server = undefined;
    this.socket = undefined;
  }

  messages(): AsyncIterable<SdkWsMessage> {
    return this.messagesQueue;
  }

  private handleMessage(rawData: RawData): void {
    handleIncomingMessage(
      rawData.toString(),
      this.messagesQueue,
      this.pendingResponses,
    );
  }
}

export class SdkWsClient implements SdkWsTransport {
  private socket?: WebSocket;
  private readonly messagesQueue = new AsyncQueue<SdkWsMessage>();
  private readonly pendingResponses = new Map<string, PendingResponse>();

  constructor(private readonly url: string) {}

  async start(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on("message", (data) => {
      handleIncomingMessage(
        data.toString(),
        this.messagesQueue,
        this.pendingResponses,
      );
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.messagesQueue.finish();
    });
    socket.on("error", (error) => {
      this.messagesQueue.fail(error);
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("open", handleOpen);
        socket.off("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("open", handleOpen);
      socket.once("error", handleError);
    });
  }

  async waitForConnection(timeoutMs = 15_000): Promise<void> {
    await waitFor(async () => this.socket?.readyState === WebSocket.OPEN, {
      timeoutMs,
      intervalMs: 100,
    });
  }

  async send(message: SdkWsMessage): Promise<void> {
    await this.waitForConnection();
    const socket = this.socket;
    if (!socket) {
      throw new Error("SDK WebSocket client has no active connection.");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async request(request: Record<string, unknown>): Promise<SdkWsMessage> {
    const requestId = randomUUID();
    const response = new Promise<SdkWsMessage>((resolve, reject) => {
      this.pendingResponses.set(requestId, { resolve, reject });
    });

    await this.send({
      type: "control_request",
      request_id: requestId,
      request,
    });

    return response;
  }

  async close(): Promise<void> {
    this.messagesQueue.finish();
    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error("SDK WebSocket client closed."));
    }
    this.pendingResponses.clear();

    if (!this.socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      const socket = this.socket;
      if (!socket) {
        resolve();
        return;
      }
      this.socket = undefined;
      if (
        socket.readyState === WebSocket.CLOSED ||
        socket.readyState === WebSocket.CLOSING
      ) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  messages(): AsyncIterable<SdkWsMessage> {
    return this.messagesQueue;
  }
}

class SharedSdkWsChannel implements SdkWsTransport, ChannelLike {
  private readonly messagesQueue = new AsyncQueue<SdkWsMessage>();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private closed = false;

  constructor(
    private readonly connection: SharedSdkWsConnection,
    private readonly runId: string,
    private readonly onClose: () => void,
  ) {}

  handleIncomingMessage(message: SdkWsMessage): void {
    if (this.closed) {
      return;
    }

    if (
      message.type === "control_response" &&
      typeof message.response === "object" &&
      message.response !== null
    ) {
      const requestId = String(
        (message.response as Record<string, unknown>).request_id ?? "",
      );
      const pending = this.pendingResponses.get(requestId);
      if (pending) {
        this.pendingResponses.delete(requestId);
        pending.resolve(message);
      }
    }

    this.messagesQueue.push(message);
  }

  handleConnectionClosed(error: Error): void {
    if (this.closed) {
      return;
    }
    for (const pending of this.pendingResponses.values()) {
      pending.reject(error);
    }
    this.pendingResponses.clear();
    this.messagesQueue.fail(error);
  }

  async waitForConnection(timeoutMs = 15_000): Promise<void> {
    await this.connection.waitForConnection(timeoutMs);
  }

  async send(message: SdkWsMessage): Promise<void> {
    await this.connection.sendToRun(this.runId, message);
  }

  async request(request: Record<string, unknown>): Promise<SdkWsMessage> {
    const requestId = randomUUID();
    const response = new Promise<SdkWsMessage>((resolve, reject) => {
      this.pendingResponses.set(requestId, { resolve, reject });
    });

    await this.send({
      type: "control_request",
      request_id: requestId,
      request,
    });

    return response;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error("SDK WebSocket channel closed."));
    }
    this.pendingResponses.clear();
    this.messagesQueue.finish();
    this.onClose();
  }

  messages(): AsyncIterable<SdkWsMessage> {
    return this.messagesQueue;
  }
}

const MAX_PENDING_MESSAGES_PER_RUN = 1000;

export class SharedSdkWsConnection {
  private socket?: WebSocket;
  private readonly channels = new Map<string, SharedSdkWsChannel>();
  private readonly pendingMessages = new Map<string, SdkWsMessage[]>();

  constructor(private readonly url: string) {}

  async start(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on("message", (data) => {
      const lines = data
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        try {
          const envelope = JSON.parse(line) as {
            runId?: string;
            message?: SdkWsMessage;
          };
          if (!envelope.runId || !envelope.message) {
            continue;
          }
          const channel = this.channels.get(envelope.runId);
          if (channel) {
            channel.handleIncomingMessage(envelope.message);
            continue;
          }
          const pending = this.pendingMessages.get(envelope.runId) ?? [];
          if (pending.length < MAX_PENDING_MESSAGES_PER_RUN) {
            pending.push(envelope.message);
            this.pendingMessages.set(envelope.runId, pending);
          }
        } catch (error) {
          const failure =
            error instanceof Error
              ? error
              : new Error("Failed to parse shared SDK message.");
          for (const channel of this.channels.values()) {
            channel.handleConnectionClosed(failure);
          }
        }
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      const error = new Error("Shared SDK WebSocket connection closed.");
      for (const channel of this.channels.values()) {
        channel.handleConnectionClosed(error);
      }
    });
    socket.on("error", (error) => {
      for (const channel of this.channels.values()) {
        channel.handleConnectionClosed(error);
      }
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("open", handleOpen);
        socket.off("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("open", handleOpen);
      socket.once("error", handleError);
    });
  }

  async waitForConnection(timeoutMs = 15_000): Promise<void> {
    await waitFor(async () => this.socket?.readyState === WebSocket.OPEN, {
      timeoutMs,
      intervalMs: 100,
    });
  }

  createChannel(runId: string): SdkWsTransport {
    const existing = this.channels.get(runId);
    if (existing) {
      return existing;
    }

    const channel = new SharedSdkWsChannel(this, runId, () => {
      this.channels.delete(runId);
    });
    this.channels.set(runId, channel);
    const pending = this.pendingMessages.get(runId);
    if (pending?.length) {
      for (const message of pending) {
        channel.handleIncomingMessage(message);
      }
      this.pendingMessages.delete(runId);
    }
    return channel;
  }

  async sendToRun(runId: string, message: SdkWsMessage): Promise<void> {
    await this.waitForConnection();
    const socket = this.socket;
    if (!socket) {
      throw new Error("Shared SDK WebSocket connection is not open.");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(`${JSON.stringify({ runId, message })}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.close();
    }
    this.channels.clear();
    this.pendingMessages.clear();

    if (!this.socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      const socket = this.socket;
      this.socket = undefined;
      if (!socket) {
        resolve();
        return;
      }
      if (
        socket.readyState === WebSocket.CLOSED ||
        socket.readyState === WebSocket.CLOSING
      ) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.close();
    });
  }
}
