import { randomUUID } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { AsyncQueue } from "../../shared/async-queue";
import { getAvailablePort, waitFor } from "../../shared/network";

export interface SdkWsMessage {
  [key: string]: unknown;
  type: string;
}

export interface SdkWsServerOptions {
  host?: string;
  port?: number;
}

export class SdkWsServer {
  private server?: WebSocketServer;
  private socket?: WebSocket;
  private readonly messagesQueue = new AsyncQueue<SdkWsMessage>();
  private readonly pendingResponses = new Map<
    string,
    {
      resolve: (message: SdkWsMessage) => void;
      reject: (error?: unknown) => void;
    }
  >();
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
  }

  async waitForConnection(timeoutMs = 15_000): Promise<void> {
    await waitFor(async () => Boolean(this.socket), {
      timeoutMs,
      intervalMs: 100,
    });
  }

  async send(message: SdkWsMessage): Promise<void> {
    await this.waitForConnection();
    await new Promise<void>((resolve, reject) => {
      this.socket?.send(`${JSON.stringify(message)}\n`, (error) => {
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
    const text = rawData.toString();
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      try {
        const message = JSON.parse(line) as SdkWsMessage;
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
      } catch (error) {
        this.messagesQueue.fail(error);
      }
    }
  }
}
