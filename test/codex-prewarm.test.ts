import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Agent } from "../src/agents/Agent";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbox-prewarm-"));
  const record = path.join(directory, "requests.jsonl");
  const binary = path.join(directory, "codex.mjs");
  await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = value => fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, ...value }) + '\\n');
record({ method: 'spawn', argv: process.argv.slice(2) });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'session' } } });
  else if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    send({ method: 'turn/started', params: { threadId: 'session', turn: { id: 'turn', status: 'inProgress' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'session', turnId: 'turn', itemId: 'answer', delta: 'READY' } });
    if (message.params.input[0].text !== 'wait') send({ method: 'turn/completed', params: { threadId: 'session', turn: { id: 'turn', status: 'completed' } } });
  }
});
`, { mode: 0o700 });
  const agent = new Agent("codex", {
    cwd: directory, configuration: "native", provider: { binary, prewarm: true, args: ["-c", 'mcp_servers.twill={url="http://127.0.0.1:1/mcp"}'] },
  });
  const records = async (): Promise<Array<{ pid: number; method: string; argv?: string[] }>> =>
    (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { agent, records, async close() { await agent.killServer(); await rm(directory, { recursive: true, force: true }); } };
}

async function exited(pid: number) {
  await expect.poll(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }).toBe(true);
}

it("prepares once without a thread or prompt, then consumes that process for the run", async () => {
  const f = await fixture();
  try {
    await Promise.all([f.agent.setup(), f.agent.setup()]);
    const prepared = await f.records();
    expect(prepared.filter(row => row.method === "initialize")).toHaveLength(1);
    expect(prepared.some(row => row.method.startsWith("thread/") || row.method === "turn/start")).toBe(false);
    const result = await f.agent.run({ input: "hello", model: "test" });
    expect(result.error).toBeUndefined();
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("READY");
    const records = await f.records();
    expect(records.filter(row => row.method === "spawn")).toHaveLength(1);
    expect(records[0]!.argv).toEqual(["-c", 'mcp_servers.twill={url="http://127.0.0.1:1/mcp"}', "app-server"]);
    expect(records.filter(row => row.method === "initialize")).toHaveLength(1);
    expect(records.find(row => row.method === "turn/start")?.pid).toBe(prepared[0]!.pid);
    await exited(prepared[0]!.pid);
  } finally { await f.close(); }
});

it("replaces a prepared process that exited while idle without replaying a prompt", async () => {
  const f = await fixture();
  try {
    await f.agent.setup();
    const pid = (await f.records())[0]!.pid;
    process.kill(pid, "SIGKILL");
    await exited(pid);
    expect((await f.agent.run({ input: "hello", model: "test" })).text).toBe("READY");
    const records = await f.records();
    expect(records.filter(row => row.method === "spawn")).toHaveLength(2);
    expect(records.filter(row => row.method === "turn/start")).toHaveLength(1);
    await exited(records.at(-1)!.pid);
  } finally { await f.close(); }
});

it("killServer disposes an unused prepared process", async () => {
  const f = await fixture();
  try {
    await f.agent.setup();
    const pid = (await f.records())[0]!.pid;
    await f.agent.killServer();
    await exited(pid);
    expect((await f.records()).some(row => row.method === "turn/start")).toBe(false);
  } finally { await f.close(); }
});

it("killServer cancels preparation that has not spawned yet", async () => {
  const f = await fixture();
  try {
    const preparation = f.agent.setup();
    const cancelled = expect(preparation).rejects.toThrow("preparation was cancelled");
    await f.agent.killServer();
    await cancelled;
    const records = await f.records().catch(() => []);
    for (const row of records) if (row.method === "spawn") await exited(row.pid);
    await f.agent.setup();
    await f.agent.killServer();
  } finally { await f.close(); }
});

it("abort stops a run using the prepared process", async () => {
  const f = await fixture();
  try {
    await f.agent.setup();
    const pid = (await f.records())[0]!.pid;
    const run = f.agent.stream({ input: "wait", model: "test" });
    for await (const event of run) if (event.type === "text.delta") break;
    await run.abort();
    expect((await run.finished).isCancelled).toBe(true);
    await exited(pid);
  } finally { await f.close(); }
});
