import { WebSocketServer, type WebSocket } from "ws";
import { expect, it } from "vitest";
import { Agent } from "../src/agents/Agent";
import type { Sandbox } from "../src";
import type { AgentResult, AgentRun } from "../src/agents/types";

type Request = { id?: number; method: string; params: Record<string, unknown> };

const message = (id: string, text: string) => ({ type: "agentMessage", id, text });

// Shapes from the 2026-10-01 prod incident: the Cloud Run instance reset every
// outbound connection mid-turn while the app-server kept running the thread.
async function droppingAppServer(
  onResume: (socket: WebSocket) => unknown,
) {
  const requests: Request[] = [];
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let connections = 0;
  server.on("connection", (socket) => {
    const connection = ++connections;
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    socket.on("message", (data) => {
      const request = JSON.parse(String(data)) as Request;
      if (request.id === undefined) return;
      requests.push(request);
      const reply = (result: unknown) => send({ id: request.id, result });
      if (request.method === "thread/start") reply({ thread: { id: "root" } });
      else if (request.method === "turn/start" && connection === 1) {
        reply({ turn: { id: "turn-1" } });
        send({ method: "turn/started", params: { threadId: "root", turn: { id: "turn-1", status: "inProgress" } } });
        send({ method: "item/completed", params: { threadId: "root", turnId: "turn-1", item: message("seen", "Looking.") } });
        setTimeout(() => socket.terminate(), 20);
      } else if (request.method === "thread/resume") reply({ thread: onResume(socket) });
      else reply({});
    });
  });
  const port = (server.address() as { port: number }).port;
  const sandbox = {
    provider: "e2b",
    previewHeaders: {},
    getPreviewLink: async () => `http://127.0.0.1:${port}`,
    run: async () => ({ exitCode: 0, stdout: "test-token\n", stderr: "", combinedOutput: "test-token\n" }),
  } as unknown as Sandbox;
  return {
    requests,
    connections: () => connections,
    run: async (): Promise<AgentResult> => {
      const run: AgentRun = new Agent("codex", { sandbox, cwd: "/work" }).stream({ input: "Fix it" });
      for await (const _ of run) void _;
      return run.finished;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

const completedTexts = (result: AgentResult) =>
  result.events.flatMap((event) => (event.type === "message.completed" && event.text ? [event.text] : []));

it("rejoins a running turn after the transport drops and keeps reading it", async () => {
  const fake = await droppingAppServer((socket) => {
    setTimeout(() => {
      const send = (value: unknown) => socket.send(JSON.stringify(value));
      // Replayed from the resume below: its live completion is not repeated.
      send({ method: "item/completed", params: { threadId: "root", turnId: "turn-1", item: message("gap", "Linting.") } });
      send({ method: "item/completed", params: { threadId: "root", turnId: "turn-1", item: message("answer", "Fixed.") } });
      send({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn-1", status: "completed" } } });
    }, 20);
    return {
      id: "root",
      status: { type: "active", activeFlags: [] },
      turns: [{
        id: "turn-1",
        status: "inProgress",
        items: [
          message("seen", "Looking."),
          message("gap", "Linting."),
          { type: "commandExecution", id: "lint", status: "inProgress" },
        ],
      }],
    };
  });
  try {
    const result = await fake.run();
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("Fixed.");
    expect(completedTexts(result)).toEqual(["Looking.", "Linting.", "Fixed."]);
    expect(fake.connections()).toBe(2);
    expect(fake.requests.find((request) => request.method === "thread/resume")?.params).toEqual({ threadId: "root" });
  } finally {
    await fake.close();
  }
});

it("finishes from the resumed thread when the turn ended while disconnected", async () => {
  const fake = await droppingAppServer(() => ({
    id: "root",
    status: { type: "idle" },
    turns: [{ id: "turn-1", status: "completed", items: [message("seen", "Looking."), message("answer", "Fixed.")] }],
  }));
  try {
    const result = await fake.run();
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("Fixed.");
    expect(completedTexts(result)).toEqual(["Looking.", "Fixed."]);
  } finally {
    await fake.close();
  }
});

it("fails as before when the app-server lost the turn", async () => {
  const fake = await droppingAppServer(() => ({
    id: "root",
    status: { type: "idle" },
    turns: [{ id: "turn-1", status: "interrupted", items: [] }],
  }));
  try {
    const result = await fake.run();
    expect(String(result.error)).toContain("Codex transport closed before run completed.");
    expect(fake.connections()).toBe(2);
  } finally {
    await fake.close();
  }
});
