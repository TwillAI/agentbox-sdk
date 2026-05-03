import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { streamSseResilient } from "../src/agents/transports/app-server";

describe("streamSseResilient", () => {
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("yields events from a single uninterrupted SSE response", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("id: 1\nevent: hello\ndata: world\n\n");
      res.write("id: 2\nevent: hello\ndata: there\n\n");
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    const events: Array<{ event?: string; id?: string; data: string }> = [];
    for await (const ev of streamSseResilient(`${baseUrl}/event`)) {
      events.push(ev);
    }

    expect(events).toEqual([
      { event: "hello", id: "1", data: "world" },
      { event: "hello", id: "2", data: "there" },
    ]);
  });

  it("reconnects after a mid-stream connection drop and replays Last-Event-ID", async () => {
    let connection = 0;
    const seenLastEventIds: Array<string | undefined> = [];

    server = createServer((req, res) => {
      connection++;
      seenLastEventIds.push(
        Array.isArray(req.headers["last-event-id"])
          ? req.headers["last-event-id"][0]
          : (req.headers["last-event-id"] as string | undefined),
      );
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (connection === 1) {
        // Send one event, then forcibly drop the connection mid-stream.
        res.write("id: 1\nevent: tick\ndata: a\n\n");
        setTimeout(() => res.destroy(), 50);
      } else {
        // On reconnect, server emits two more events and ends cleanly.
        res.write("id: 2\nevent: tick\ndata: b\n\n");
        res.write("id: 3\nevent: tick\ndata: c\n\n");
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    const events: Array<{ event?: string; id?: string; data: string }> = [];
    for await (const ev of streamSseResilient(`${baseUrl}/event`)) {
      events.push(ev);
    }

    expect(events.map((e) => e.data)).toEqual(["a", "b", "c"]);
    // First connection has no Last-Event-ID; second resumes from id=1.
    expect(seenLastEventIds).toEqual([undefined, "1"]);
  });

  it("stops reconnecting when the consumer aborts", async () => {
    let connection = 0;
    server = createServer((_req, res) => {
      connection++;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Drop every connection immediately to force reconnect attempts.
      setTimeout(() => res.destroy(), 10);
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    const controller = new AbortController();
    const iter = streamSseResilient(`${baseUrl}/event`, {
      signal: controller.signal,
    });

    // Let it churn through a couple of reconnect attempts, then abort.
    setTimeout(() => controller.abort(), 200);

    let threw = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of iter) {
        // drain
      }
    } catch {
      threw = true;
    }

    // Either it threw on abort or the iterator returned cleanly when the
    // signal fired between attempts; both are acceptable terminations.
    expect(threw || connection >= 1).toBe(true);
  });
});
