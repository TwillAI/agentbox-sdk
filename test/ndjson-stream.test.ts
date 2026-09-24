import { describe, expect, it } from "vitest";
import { parseNdjsonStream } from "../src/agents/providers/claude-code";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const values: unknown[] = [];
  for await (const value of parseNdjsonStream(stream(chunks)))
    values.push(value);
  return values;
}

describe("parseNdjsonStream", () => {
  it("splits lines across and within chunks, skipping blanks and bad lines", async () => {
    expect(
      await collect([
        '{"a":1}\n{"b":',
        "2}\n\n",
        "not json\n",
        '{"c":"é🧵"}\n{"d":4}\n{"tail":',
        "true}",
      ]),
    ).toEqual([{ a: 1 }, { b: 2 }, { c: "é🧵" }, { d: 4 }, { tail: true }]);
  });

  it("keeps a multi-byte character split between chunks", async () => {
    const bytes = new TextEncoder().encode('{"x":"🧵"}\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    const values: unknown[] = [];
    for await (const value of parseNdjsonStream(body)) values.push(value);
    expect(values).toEqual([{ x: "🧵" }]);
  });

  it("reads one large frame spread over many chunks in linear time", async () => {
    const output = "x".repeat(8 * 1024 * 1024);
    const frame = `${JSON.stringify({ output })}\n`;
    const chunks: string[] = [];
    for (let at = 0; at < frame.length; at += 2048)
      chunks.push(frame.slice(at, at + 2048));
    const started = performance.now();
    const values = await collect(chunks);
    // Rescanning the buffer per chunk took seconds here (4,096 chunks).
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(values).toEqual([{ output }]);
  });
});
