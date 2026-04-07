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

  fail(error: unknown): void {
    if (this.failure) {
      return;
    }

    this.failure = asError(error);
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.reject(this.failure);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.failure) {
      throw this.failure;
    }

    if (this.items.length > 0) {
      const value = this.items.shift() as T;
      return { done: false, value };
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
