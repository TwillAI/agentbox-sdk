import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Agent } from "../src/agents/Agent";
import type { AgentRun } from "../src/agents/types";

it.each(["item/tool/requestUserInput", "tool/requestUserInput"])("round-trips %s through the public run controller, retaining invalid asks and supporting skip", async (method) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbox-codex-questions-"));
  const binary = path.join(directory, "codex-fixture");
  const record = path.join(directory, "response.json");
  await mkdir(path.join(directory, "codex"));
  await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 9001 && message.result) {
    fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify({ pid: process.pid, ...message.result }));
    send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
  } else if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-test' } } });
    send({ id: 9001, method: ${JSON.stringify(method)}, params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'item-test', isBlocking: true, questions: [{ id: 'format', header: 'Format', question: 'Which format?', options: [{ label: 'JSON', description: 'Structured' }, { label: 'Text', description: 'Plain' }] }] } });
  }
});
`, { mode: 0o700 });
  let active: AgentRun | undefined;
  try {
    for (const decision of ["allow", "deny"] as const) {
      const agent = new Agent("codex", { cwd: directory, stateDirectory: directory, approvalMode: "auto", fullAccess: true, interactiveQuestions: true, provider: { binary }, env: { RECORD_FILE: record } });
      active = agent.stream({ input: "Ask the question" });
      let asks = 0;
      for await (const event of active) {
        if (event.type !== "permission.requested") continue;
        asks++;
        expect(event.kind).toBe("question");
        expect(event.questions?.[0]).toMatchObject({ id: "0", question: "Which format?" });
        await expect(active.respondToPermission({ requestId: event.requestId, decision: "allow" })).rejects.toThrow(/Answer each/);
        await active.respondToPermission({ requestId: event.requestId, decision, ...(decision === "allow" ? { answers: [{ questionId: "0", values: ["Custom ☃"] }] } : {}) });
        await expect(active.respondToPermission({ requestId: event.requestId, decision: "deny" })).rejects.toThrow(/not pending/);
      }
      expect(asks).toBe(1);
      expect((await active.finished).isCancelled).toBe(false);
      const response = JSON.parse(await readFile(record, "utf8")) as { pid: number; answers: unknown };
      expect(response.answers).toEqual(decision === "allow" ? { format: { answers: ["Custom ☃"] } } : {});
      await vi.waitFor(() => expect(() => process.kill(-response.pid, 0)).toThrow());
      active = undefined;
    }
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

it("relays a non-blocking request_user_input_async ask on message.completed without pausing the run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbox-codex-async-questions-"));
  const binary = path.join(directory, "codex-fixture");
  await mkdir(path.join(directory, "codex"));
  const item = {
    id: "call_ask",
    type: "agentMessage",
    phase: "final_answer",
    delivery: "async",
    text: "Copy .env?\n- Saved settings only\n- Copy missing values",
    questions: [{ title: "Copy .env?", options: ["Saved settings only", "Copy missing values"] }],
  };
  await writeFile(binary, `#!${process.execPath}
import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const item = ${JSON.stringify(item)};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-test' } } });
    send({ method: 'item/started', params: { threadId: 'thread-test', turnId: 'turn-test', item } });
    send({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test', item } });
    send({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test', item: { id: 'msg_final', type: 'agentMessage', text: 'Done without copying.' } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
  }
});
`, { mode: 0o700 });
  let active: AgentRun | undefined;
  try {
    const agent = new Agent("codex", { cwd: directory, stateDirectory: directory, approvalMode: "auto", fullAccess: true, interactiveQuestions: true, provider: { binary } });
    active = agent.stream({ input: "Set up the workspace" });
    const messages: Array<{ text?: string; questions?: unknown }> = [];
    for await (const event of active) {
      expect(event.type).not.toBe("permission.requested");
      if (event.type === "message.completed") messages.push({ text: event.text, questions: event.questions });
    }
    expect(messages).toEqual([
      { text: item.text, questions: [{ id: "0", question: "Copy .env?", options: [{ label: "Saved settings only" }, { label: "Copy missing values" }], multiple: false, allowCustom: true }] },
      { text: "Done without copying.", questions: undefined },
    ]);
    const result = await active.finished;
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("Done without copying.");
    active = undefined;
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
