import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Agent } from "../src/agents/Agent";
import type { AgentRun } from "../src/agents/types";

// Codex 0.154+ gates MCP tool calls (including code-mode calls) behind an
// `mcpServer/elicitation/request` tagged `codex_approval_kind: mcp_tool_call`
// and blocks the turn until the client answers it.
const elicitation = {
  threadId: "thread-test",
  turnId: "turn-test",
  serverName: "twill_local_delegation",
  mode: "form",
  message: "Allow this request?",
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_request_type: "approval_request",
    codex_approval_kind: "mcp_tool_call",
    persist: ["session", "always"],
    tool_name: "delegate_to_cloud",
    tool_params: { title: "Repro" },
  },
};

async function fixture(directory: string, script: string) {
  const binary = path.join(directory, "codex-fixture");
  await mkdir(path.join(directory, "codex"), { recursive: true });
  await writeFile(
    binary,
    `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (value) => fs.appendFileSync(process.env.RECORD_FILE, JSON.stringify(value) + '\\n');
const complete = (status) => send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-test' } } });
    ${script}
  } else if (message.id !== undefined && message.method === undefined) {
    record(message);
    ${"complete(message.error || (message.result && message.result.action === 'decline') ? 'interrupted' : 'completed');"}
  }
});
`,
    { mode: 0o700 },
  );
  return binary;
}

it("answers Codex MCP tool-call approval elicitations instead of stalling the turn", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agentbox-codex-elicitation-"),
  );
  const record = path.join(directory, "responses.jsonl");
  const binary = await fixture(
    directory,
    `send({ id: 9001, method: 'mcpServer/elicitation/request', params: ${JSON.stringify(elicitation)} });`,
  );
  let active: AgentRun | undefined;
  try {
    for (const [decision, remember, expected] of [
      ["allow", false, { action: "accept", content: null }],
      [
        "allow",
        true,
        { action: "accept", content: null, _meta: { persist: "session" } },
      ],
      ["deny", false, { action: "decline", content: null }],
    ] as const) {
      await rm(record, { force: true });
      const agent = new Agent("codex", {
        cwd: directory,
        stateDirectory: directory,
        approvalMode: "interactive",
        provider: { binary },
        env: { RECORD_FILE: record },
      });
      active = agent.stream({ input: "Delegate this task" });
      let asks = 0;
      for await (const event of active) {
        if (event.type !== "permission.requested") continue;
        asks++;
        expect(event.kind).toBe("tool");
        expect(event.toolName).toBe("delegate_to_cloud");
        expect(event.canRemember).toBe(true);
        expect(event.input).toMatchObject({
          server: "twill_local_delegation",
          arguments: { title: "Repro" },
        });
        await active.respondToPermission({
          requestId: event.requestId,
          decision,
          remember,
        });
      }
      expect(asks).toBe(1);
      await active.finished;
      const responses = (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(responses).toEqual([{ id: 9001, result: expected }]);
      active = undefined;
    }
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

it("auto-approves MCP tool-call elicitations when approvals are not interactive", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agentbox-codex-elicitation-auto-"),
  );
  const record = path.join(directory, "responses.jsonl");
  const binary = await fixture(
    directory,
    `send({ id: 9001, method: 'mcpServer/elicitation/request', params: ${JSON.stringify(elicitation)} });`,
  );
  try {
    const agent = new Agent("codex", {
      cwd: directory,
      stateDirectory: directory,
      provider: { binary },
      env: { RECORD_FILE: record },
    });
    const run = agent.stream({ input: "Delegate this task" });
    for await (const event of run) {
      expect(event.type).not.toBe("permission.requested");
    }
    await run.finished;
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
      id: 9001,
      result: { action: "accept", content: null },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("declines server requests it does not understand so Codex cannot block forever", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agentbox-codex-unknown-request-"),
  );
  const record = path.join(directory, "responses.jsonl");
  const binary = await fixture(
    directory,
    `send({ id: 9002, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-test', turnId: 'turn-test', serverName: 'other', mode: 'form', message: 'Pick one', requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } } } });
    send({ id: 9003, method: 'item/permissions/requestApproval', params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'item-test' } });`,
  );
  try {
    const agent = new Agent("codex", {
      cwd: directory,
      stateDirectory: directory,
      approvalMode: "interactive",
      provider: { binary },
      env: { RECORD_FILE: record },
    });
    const run = agent.stream({ input: "Do the thing" });
    for await (const event of run) {
      expect(event.type).not.toBe("permission.requested");
    }
    await run.finished;
    const responses = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(responses).toEqual([
      { id: 9002, result: { action: "cancel", content: null } },
      {
        id: 9003,
        error: {
          code: -32601,
          message: "Unsupported request item/permissions/requestApproval",
        },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
