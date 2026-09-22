import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Agent } from "../src/agents/Agent";
import type { AgentRun } from "../src/agents/types";

const decisions = [undefined, null, [], ["accept", "cancel"], ["accept", "decline", "cancel"]];
const cases = ["commandExecution", "fileChange"].flatMap((kind) =>
  decisions.map((availableDecisions) => ({ kind, availableDecisions })),
);

it.each(cases)("denying $kind continues the turn with availableDecisions=$availableDecisions", async ({ kind, availableDecisions }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbox-codex-denial-"));
  const binary = path.join(directory, "codex-fixture");
  const record = path.join(directory, "responses.jsonl");
  const params = { threadId: "thread-test", turnId: "turn-test", itemId: "denied-item", availableDecisions };
  await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const complete = status => send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status } } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 9001 && message.result) {
    fs.appendFileSync(process.env.RECORD_FILE, JSON.stringify(message.result) + '\\n');
    if (message.result.decision === 'cancel') return complete('interrupted');
    if (message.result.decision !== 'decline') return complete('failed');
    send({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test', item: { id: 'denied-item', type: ${JSON.stringify(kind)}, status: 'declined' } } });
    // The next action still requires its own permission; denial grants nothing.
    send({ id: 9002, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'next-item', command: 'echo alternative' } });
  } else if (message.id === 9002 && message.result) {
    fs.appendFileSync(process.env.RECORD_FILE, JSON.stringify(message.result) + '\\n');
    if (message.result.decision !== 'accept') return complete('failed');
    send({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test', item: { id: 'final', type: 'agentMessage', text: 'Continued without the denied action.' } } });
    complete('completed');
  } else if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-test' } } });
    send({ id: 9001, method: ${JSON.stringify(`item/${kind}/requestApproval`)}, params: ${JSON.stringify(params)} });
  }
});
`, { mode: 0o700 });
  let active: AgentRun | undefined;
  try {
    const agent = new Agent("codex", {
      cwd: directory, stateDirectory: directory, configuration: "native",
      approvalMode: "interactive", provider: { binary, useBroker: false },
      env: { RECORD_FILE: record },
    });
    active = agent.stream({ input: "Continue when an action is denied" });
    const requests: string[] = [];
    for await (const event of active) {
      expect(event.type).not.toBe("run.cancelled");
      if (event.type !== "permission.requested") continue;
      requests.push(event.requestId);
      await active.respondToPermission({ requestId: event.requestId, decision: event.requestId === "9001" ? "deny" : "allow" });
    }
    expect(requests).toEqual(["9001", "9002"]);
    const result = await active.finished;
    expect(result.isCancelled).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("Continued without the denied action.");
    expect((await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual([{ decision: "decline" }, { decision: "accept" }]);
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
