import { createParser, type EventSourceMessage } from "eventsource-parser";
import { WebSocket } from "ws";

import { AsyncQueue } from "../../shared/async-queue";

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}.`);
  }

  const text = await response.text();
  if (text.length === 0) {
    throw new Error(
      `Request to ${url} returned status ${response.status} with an empty body.`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not parse JSON response from ${url} (status ${response.status}): ${cause}. Body: ${preview}`,
    );
  }
}

export async function* streamSse(
  url: string,
  init?: RequestInit,
): AsyncIterable<SseEvent> {
  const response = await fetch(url, init);
  if (!response.ok || !response.body) {
    throw new Error(`Could not open SSE stream at ${url}.`);
  }

  const queue = new AsyncQueue<SseEvent>();
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      queue.push({
        event: event.event || undefined,
        id: event.id || undefined,
        data: event.data,
      });
    },
    onError(error) {
      queue.fail(error);
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        parser.feed(decoder.decode(value, { stream: true }));
      }

      parser.feed(decoder.decode());
      queue.finish();
    } catch (error) {
      queue.fail(error);
    } finally {
      reader.releaseLock();
    }
  })();

  yield* queue;
}

/**
 * Reconnecting wrapper around `streamSse`. Retries on transient transport
 * errors with exponential backoff (0.5s → 5s), tracks the last event id,
 * and replays it via `Last-Event-ID` so servers that support SSE replay
 * can backfill events lost during the gap. If the consumer's `signal` is
 * aborted, the loop exits cleanly. Designed for long-running SSE channels
 * (opencode `/event`) where Bun's fetch occasionally drops the underlying
 * connection mid-stream.
 */
export async function* streamSseResilient(
  url: string,
  init?: RequestInit,
): AsyncIterable<SseEvent> {
  let lastEventId: string | undefined;
  let attempt = 0;
  const signal = init?.signal as AbortSignal | undefined;

  while (true) {
    try {
      const headers = {
        ...(init?.headers ?? {}),
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
      };
      for await (const ev of streamSse(url, { ...init, headers })) {
        attempt = 0;
        if (ev.id) lastEventId = ev.id;
        yield ev;
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      const delay = Math.min(500 * Math.pow(2, attempt), 5_000);
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal?.aborted) throw err;
    }
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export interface JsonRpcWebSocketTransport {
  source: AsyncIterable<string>;
  send: (line: string) => Promise<void>;
  close: () => Promise<void>;
  raw: WebSocket;
}

export async function connectJsonRpcWebSocket(
  url: string,
  options?: { headers?: Record<string, string> },
): Promise<JsonRpcWebSocketTransport> {
  const notifications = new AsyncQueue<string>();
  const socket = new WebSocket(url, { headers: options?.headers });

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

  socket.on("message", (data) => {
    notifications.push(data.toString());
  });
  socket.on("close", () => {
    notifications.finish();
  });
  socket.on("error", (error) => {
    notifications.fail(error);
  });

  return {
    source: notifications,
    send: async (line: string) => {
      await new Promise<void>((resolve, reject) => {
        socket.send(line, (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    close: async () => {
      await new Promise<void>((resolve) => {
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
    },
    raw: socket,
  };
}

export class JsonRpcLineClient<TNotification = unknown> {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications = new AsyncQueue<TNotification>();
  private nextId = 1;

  constructor(
    source: AsyncIterable<string>,
    private readonly writeLine: (line: string) => Promise<void>,
  ) {
    void this.consume(source);
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    const id = this.nextId++;

    const response = new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });

    await this.writeLine(JSON.stringify({ id, method, params }));
    return response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.writeLine(JSON.stringify({ method, params: params ?? {} }));
  }

  async respond(id: number, result: unknown): Promise<void> {
    await this.writeLine(JSON.stringify({ id, result }));
  }

  async respondError(id: number, error: unknown): Promise<void> {
    await this.writeLine(JSON.stringify({ id, error }));
  }

  async *messages(): AsyncIterable<TNotification> {
    yield* this.notifications;
  }

  private async consume(source: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of source) {
        if (!line.trim()) {
          continue;
        }

        const message = JSON.parse(line) as Record<string, unknown>;

        if (typeof message.method === "string") {
          this.notifications.push(message as TNotification);
          continue;
        }

        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) {
            continue;
          }

          this.pending.delete(message.id);

          if (message.error) {
            pending.reject(message.error);
          } else {
            pending.resolve(message.result);
          }

          continue;
        }
      }

      const closeError = new Error("JSON-RPC transport closed.");
      for (const pending of this.pending.values()) {
        pending.reject(closeError);
      }
      this.pending.clear();
      this.notifications.finish();
    } catch (error) {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.notifications.fail(error);
    }
  }
}
