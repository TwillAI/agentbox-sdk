import { describe, expect, it } from "vitest";

import { AsyncQueue } from "../src/shared/async-queue";

async function drain<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) items.push(item);
  return items;
}

describe("AsyncQueue", () => {
  it("delivers buffered items before reporting a transport failure", async () => {
    const queue = new AsyncQueue<string>();
    queue.push("a");
    queue.push("b");
    queue.fail(new Error("socket reset"));

    // Everything the transport managed to deliver is still handed over; the
    // failure only ends the stream once there is nothing left to read.
    expect(await queue.next()).toEqual({ done: false, value: "a" });
    expect(await queue.next()).toEqual({ done: false, value: "b" });
    await expect(queue.next()).rejects.toThrow("socket reset");
  });

  it("stays finished when the transport errors after a clean close", async () => {
    const queue = new AsyncQueue<string>();
    queue.push("only");
    queue.finish();
    // ws emits "error" right behind "close" on an abrupt disconnect; the run
    // already saw every event, so this must not become a run failure.
    queue.fail(new Error("read ECONNRESET"));

    await expect(drain(queue)).resolves.toEqual(["only"]);
  });

  it("rejects a consumer that is already waiting", async () => {
    const queue = new AsyncQueue<string>();
    const pending = queue.next();
    queue.fail(new Error("closed"));
    await expect(pending).rejects.toThrow("closed");
  });

  it("ignores pushes once failed and reports the first failure", async () => {
    const queue = new AsyncQueue<string>();
    queue.fail(new Error("first"));
    queue.fail(new Error("second"));
    queue.push("late");
    await expect(queue.next()).rejects.toThrow("first");
  });
});
