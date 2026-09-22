import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Agent } from "../src/agents/Agent";
import type { AgentRun } from "../src/agents/types";

it("joins Codex file approval with its own thread/turn item preview without changing the wire decision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbox-codex-file-approval-"));
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
    send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: message.result.decision === 'cancel' ? 'interrupted' : 'completed' } } });
  } else if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-test' } } });
    send({ method: 'item/started', params: { threadId: 'thread-test', turnId: 'turn-test', item: { type: 'fileChange', id: 'item-test', changes: [{ path: '/fixture/sum.mjs', kind: { type: 'update' }, diff: '-return 0;\\n+return a+b;' }] } } });
    send({ method: 'item/started', params: { threadId: 'unrelated-thread', turnId: 'turn-test', item: { type: 'fileChange', id: 'item-test', changes: [{ path: '/unrelated/private-file' }] } } });
    send({ id: 9001, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'item-test' } });
  }
});
`, { mode: 0o700 });
  let active: AgentRun | undefined;
  try {
    for (const decision of ["allow", "deny"] as const) {
      const agent = new Agent("codex", { cwd: directory, stateDirectory: directory, approvalMode: "interactive", provider: { binary }, env: { RECORD_FILE: record } });
      active = agent.stream({ input: "Review the file change" });
      let asks = 0;
      for await (const event of active) {
        if (event.type !== "permission.requested") continue;
        asks++;
        expect(event.kind).toBe("file-change");
        expect(event.input).toMatchObject({ changes: [{ path: "/fixture/sum.mjs", diff: "-return 0;\n+return a+b;" }] });
        await active.respondToPermission({ requestId: event.requestId, decision });
      }
      expect(asks).toBe(1);
      expect((await active.finished).isCancelled).toBe(false);
      const response = JSON.parse(await readFile(record, "utf8")) as { pid: number; decision: string };
      expect(response.decision).toBe(decision === "allow" ? "accept" : "decline");
      expect(Object.keys(response).sort()).toEqual(["decision", "pid"]);
      await vi.waitFor(() => expect(() => process.kill(-response.pid, 0)).toThrow());
      active = undefined;
    }
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
