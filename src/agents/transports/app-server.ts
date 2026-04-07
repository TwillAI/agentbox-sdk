import { createParser, type EventSourceMessage } from "eventsource-parser";

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

  return (await response.json()) as T;
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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

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
