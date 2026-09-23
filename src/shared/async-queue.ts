import { asError } from "./errors";

type Resolver<T> = {
  resolve: (value: IteratorResult<T>) => void;
  reject: (reason?: unknown) => void;
};

export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly items: T[] = [];
  private readonly resolvers: Resolver<T>[] = [];
  private closed = false;
  private failure: Error | null = null;

  push(item: T): void {
    if (this.closed || this.failure) {
      return;
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver.resolve({ done: false, value: item });
      return;
    }

    this.items.push(item);
  }

  finish(): void {
    if (this.closed || this.failure) {
      return;
    }

    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.resolve({ done: true, value: undefined });
    }
  }

  /**
   * Fail the queue for whatever has not been delivered yet.
   *
   * A queue that already {@link finish}ed stays finished: every event reached
   * the consumer and the transport merely closed afterwards (a websocket
   * "error" landing right behind its "close"), which is not a run failure.
   * Buffered items also survive — {@link next} drains them before it throws —
   * so a transport that dies mid-stream still hands over everything it
   * received instead of discarding the tail.
   */
  fail(error: unknown): void {
    if (this.closed || this.failure) {
      return;
    }

    this.failure = asError(error);
    // A consumer only waits once `items` is empty, so nothing is lost here.
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.reject(this.failure);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      const value = this.items.shift() as T;
      return { done: false, value };
    }

    if (this.failure) {
      throw this.failure;
    }

    if (this.closed) {
      return { done: true, value: undefined };
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.resolvers.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
