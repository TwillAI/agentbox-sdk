/**
 * Live proof of the claude-code park/wake loop against a REAL Daytona sandbox
 * and a REAL Claude Code CLI. Never part of the default test run.
 *
 *   node --env-file=<twill>/.env test/e2e/park-wake.e2e.mjs
 *
 * The daemon's wake callback needs a URL the sandbox can reach, so the
 * receiver runs *inside* the sandbox on loopback and appends each call to a
 * file this script reads back over the sandbox exec channel. That exercises
 * the real code path (daemon → fetch → Bearer token) without a public tunnel.
 *
 * Scenarios:
 *   1. park + wake + attach — a turn ends with a background shell still live;
 *      the run settles at its answer, the daemon keeps the CLI, and when the
 *      shell finishes the CLI takes a turn on its own and wakes the host. A
 *      `resumeParked` run then streams that turn.
 *   2. follow-up adoption — a second run with a real prompt takes the parked
 *      CLI over instead of starting a second one, and answers ITS OWN prompt.
 *   3. budget carry — the park hands its remaining budget to the adopting run
 *      instead of restarting the ceiling.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Agent } from "../../dist/agents/index.js";
import { Sandbox } from "../../dist/sandboxes/index.js";

const WAKE_PORT = 45999;
const WAKE_LOG = "/tmp/wake-calls.log";
const WAKE_TOKEN = `tok-${randomUUID()}`;
const MODEL = process.env.E2E_MODEL ?? "sonnet";
const SNAPSHOT = process.env.E2E_SNAPSHOT ?? "twill-small-2026-09-06";
// The CLI's shell does not inherit the login PATH, so `node` alone is 127.
const NODE_BIN = process.env.E2E_NODE ?? "/usr/local/bin/node";

const log = (...parts) =>
  console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Node source for the in-sandbox stand-in for POST /api/agent-wake. */
const receiverSource = `
const http = require("node:http");
const fs = require("node:fs");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    fs.appendFileSync(${JSON.stringify(WAKE_LOG)},
      JSON.stringify({ at: Date.now(), auth: req.headers.authorization, body }) + "\\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ started: true }));
  });
}).listen(${WAKE_PORT}, "127.0.0.1", () => console.log("wake receiver up"));
`;

async function readWakes(sandbox) {
  const out = await sandbox.run(`cat ${WAKE_LOG} 2>/dev/null || true`);
  return (out.stdout ?? out.combinedOutput ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Plant a node script that runs for `seconds` and then writes `marker`. Run in
 * the FOREGROUND it outlives Bash's shortened timeout, so the CLI moves it to
 * the background; when it finishes, the CLI takes a turn of its own — which is
 * exactly the wake this test is about. (The CLI refuses a bare `sleep`.)
 */
async function plantBackgroundScript(sandbox, scriptPath, marker, seconds) {
  const source = `setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(
    marker,
  )}, "finished"); process.exit(0); }, ${seconds * 1000});`;
  await sandbox.run(
    `cat > ${scriptPath} <<'SCRIPT_EOF'\n${source}\nSCRIPT_EOF`,
  );
}

/** The prompt shape that reliably produces a backgrounded task. */
const backgroundPrompt = (scriptPath, answer) =>
  "This is a process-management test in a disposable directory. Use the Bash " +
  `tool exactly once, in the FOREGROUND: command \`${NODE_BIN} ${scriptPath}\`, ` +
  "timeout 5000, and do NOT set run_in_background. It will not finish in " +
  "time; when the tool reports it was moved to the background, do not wait " +
  "for it, do not check on it, and do not stop it. Then reply with exactly: " +
  answer;

/** Drain a run, collecting the signals these scenarios assert on. */
async function drive(run, label) {
  const events = [];
  const backgroundTasks = [];
  (async () => {
    for await (const event of run) {
      events.push(event.type);
      if (event.type === "background.tasks") {
        backgroundTasks.push({
          tasks: event.tasks.map((t) => t.id),
          waiting: event.waiting,
          parked: event.parked === true,
        });
      }
    }
  })().catch(() => {});
  const result = await run.finished;
  const tools = result.rawEvents
    .flatMap((raw) => {
      const payload = raw.payload ?? {};
      const content = payload?.message?.content;
      return Array.isArray(content) ? content : [];
    })
    .filter((block) => block?.type === "tool_use")
    .map((block) => `${block.name}(${JSON.stringify(block.input).slice(0, 160)})`);
  log(`${label}: settled`, {
    chars: result.text.length,
    text: result.text.slice(0, 120),
    error: result.error,
    nothingParked: result.nothingParked,
    tools,
    events: [...new Set(events)].join(","),
  });
  if (process.env.E2E_DUMP) {
    const fs = await import("node:fs");
    fs.writeFileSync(
      `/tmp/raw-${label}.json`,
      JSON.stringify(result.rawEvents.map((r) => r.payload), null, 1),
    );
    log(`${label}: raw events written to /tmp/raw-${label}.json`);
  }
  return { result, events, backgroundTasks };
}

async function main() {
  assert.ok(process.env.DAYTONA_API_KEY, "DAYTONA_API_KEY required");
  assert.ok(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY required");

  const sandbox = new Sandbox("daytona", {
    workingDir: "/workspace",
    image: SNAPSHOT,
    idleTimeoutMs: 20 * 60_000,
    provider: {
      name: `park-wake-e2e-${randomUUID().slice(0, 8)}`,
      apiKey: process.env.DAYTONA_API_KEY,
      ...(process.env.DAYTONA_ORGANIZATION_ID
        ? { organizationId: process.env.DAYTONA_ORGANIZATION_ID }
        : {}),
    },
  });

  const failures = [];
  const pass = (name) => log(`PASS  ${name}`);
  const check = async (name, fn) => {
    try {
      await fn();
      pass(name);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      log(`FAIL  ${name}: ${error.message}`);
    }
  };

  try {
    if (process.env.E2E_SANDBOX_ID) {
      log("attaching to sandbox", process.env.E2E_SANDBOX_ID);
      await sandbox.attachById(process.env.E2E_SANDBOX_ID);
    } else {
      log("creating sandbox from", SNAPSHOT);
      await sandbox.findOrProvision();
    }
    const version = await sandbox.run("claude --version || true");
    log(
      "claude in sandbox:",
      (version.stdout ?? version.combinedOutput ?? "").trim(),
    );

    // Wake receiver, backgrounded inside the sandbox.
    await sandbox.run(
      `cat > /tmp/wake-receiver.cjs <<'EOF'\n${receiverSource}\nEOF`,
    );
    await sandbox.run(
      `rm -f ${WAKE_LOG}; nohup node /tmp/wake-receiver.cjs > /tmp/wake-receiver.log 2>&1 & sleep 1; cat /tmp/wake-receiver.log`,
    );
    const probe = await sandbox.run(
      `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:${WAKE_PORT}/ -d '{}' || true`,
    );
    log(
      "wake receiver probe:",
      (probe.stdout ?? probe.combinedOutput ?? "").trim(),
    );
    await sandbox.run(`rm -f ${WAKE_LOG}`);

    const agent = new Agent("claude-code", {
      sandbox,
      cwd: "/workspace",
      approvalMode: "auto",
      backgroundTaskTimeoutMs: 6 * 60_000,
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        // Bash's default timeout is 120s. Shorten it so a foreground command
        // is moved to the background within seconds — the same trick the
        // local smoke uses, and far more reliable than asking the model for
        // run_in_background.
        BASH_DEFAULT_TIMEOUT_MS: "5000",
      },
      provider: {
        parkBackgroundWork: {
          wakeUrl: `http://127.0.0.1:${WAKE_PORT}/wake`,
          wakeToken: WAKE_TOKEN,
        },
      },
    });
    log("setup()");
    await agent.setup();

    // ── 1. park + wake + attach ──────────────────────────────────────────
    const marker = `/workspace/bg-${randomUUID().slice(0, 8)}.txt`;
    const script1 = `/workspace/bg-${randomUUID().slice(0, 8)}.cjs`;
    await plantBackgroundScript(sandbox, script1, marker, 45);
    log("run 1: start background work, answer immediately");
    const first = await drive(
      agent.stream({
        runId: `e2e-park-${randomUUID().slice(0, 8)}`,
        model: MODEL,
        input: backgroundPrompt(script1, "STARTED"),
      }),
      "run1",
    );
    const sessionId = first.result.sessionId;
    log("run1 session", sessionId, "backgroundTasks", first.backgroundTasks);

    await check("run 1 settles at its answer while work is live", async () => {
      assert.equal(
        first.result.error,
        undefined,
        `run errored: ${first.result.error}`,
      );
      assert.ok(first.result.text.length > 0, "no answer text");
    });
    await check("run 1 reports the harness parked", async () => {
      const parked = first.backgroundTasks.filter((b) => b.parked);
      assert.ok(
        parked.length > 0,
        `no parked background.tasks event; saw ${JSON.stringify(first.backgroundTasks)}`,
      );
    });

    log("waiting for the background shell to finish and wake the host...");
    let wakes = [];
    for (let i = 0; i < 100; i++) {
      wakes = await readWakes(sandbox);
      if (wakes.length > 0) break;
      await sleep(3000);
    }
    await check(
      "the parked CLI wakes the host when its turn starts",
      async () => {
        assert.ok(wakes.length > 0, "no wake call arrived within 5 minutes");
        const call = wakes[0];
        assert.equal(
          call.auth,
          `Bearer ${WAKE_TOKEN}`,
          "wrong wake authorization",
        );
        const body = JSON.parse(call.body);
        assert.equal(
          body.sessionId,
          sessionId,
          "wake carried the wrong session",
        );
      },
    );
    await check("the host is woken once, not once per frame", async () => {
      await sleep(5000);
      const settled = await readWakes(sandbox);
      assert.ok(
        settled.length <= 2,
        `expected at most 2 wakes for one turn, got ${settled.length}`,
      );
    });

    log("run 2: attach to the parked turn (resumeParked)");
    const woke = await drive(
      agent.stream({
        runId: `e2e-wake-${randomUUID().slice(0, 8)}`,
        model: MODEL,
        input: "",
        resumeSessionId: sessionId,
        resumeParked: true,
      }),
      "run2",
    );
    await check("the wake run streams the parked turn", async () => {
      assert.equal(
        woke.result.error,
        undefined,
        `wake errored: ${woke.result.error}`,
      );
      assert.notEqual(woke.result.nothingParked, true, "nothing was parked");
      assert.ok(woke.result.text.length > 0, "the woken turn produced no text");
    });
    await check("the background shell really ran", async () => {
      const out = await sandbox.run(
        `cat ${marker} 2>/dev/null || echo MISSING`,
      );
      const text = (out.stdout ?? out.combinedOutput ?? "").trim();
      assert.equal(text, "finished", `marker file: ${text}`);
    });

    // ── 2 & 3. follow-up adoption and budget carry ───────────────────────
    const marker2 = `/workspace/bg2-${randomUUID().slice(0, 8)}.txt`;
    const script2 = `/workspace/bg2-${randomUUID().slice(0, 8)}.cjs`;
    await plantBackgroundScript(sandbox, script2, marker2, 120);
    log("run 3: park again, then adopt with a real follow-up");
    const third = await drive(
      agent.stream({
        runId: `e2e-park2-${randomUUID().slice(0, 8)}`,
        model: MODEL,
        resumeSessionId: sessionId,
        input: backgroundPrompt(script2, "STARTED2"),
      }),
      "run3",
    );
    await check("run 3 parks again", async () => {
      assert.ok(
        third.backgroundTasks.some((b) => b.parked),
        `no re-park; saw ${JSON.stringify(third.backgroundTasks)}`,
      );
    });

    log("run 4: follow-up adopts the parked CLI and answers its own prompt");
    const follow = await drive(
      agent.stream({
        runId: `e2e-follow-${randomUUID().slice(0, 8)}`,
        model: MODEL,
        resumeSessionId: sessionId,
        input:
          "Ignore any background work. Reply with exactly the word BANANA and nothing else.",
      }),
      "run4",
    );
    await check(
      "the follow-up answers its own prompt, not the parked turn",
      async () => {
        assert.equal(
          follow.result.error,
          undefined,
          `follow-up errored: ${follow.result.error}`,
        );
        assert.match(
          follow.result.text,
          /BANANA/i,
          `follow-up answered with the wrong turn: ${JSON.stringify(follow.result.text.slice(0, 200))}`,
        );
        assert.doesNotMatch(
          follow.result.text,
          /STARTED2/,
          "follow-up was answered with the parked turn's text",
        );
      },
    );
    await check(
      "the adopting run inherits the live background work",
      async () => {
        assert.ok(
          follow.backgroundTasks.some((b) => b.tasks.length > 0),
          `adopting run saw no live tasks; ${JSON.stringify(follow.backgroundTasks)}`,
        );
      },
    );

    log("\n==== RESULT ====");
    if (failures.length) {
      for (const failure of failures) log("FAILED:", failure);
      process.exitCode = 1;
    } else {
      log("all scenarios passed");
    }
  } finally {
    if (process.env.E2E_SANDBOX_ID) {
      log("leaving the pre-provisioned sandbox in place");
    } else {
      log("deleting sandbox");
      await sandbox.delete().catch((e) => log("delete failed:", e.message));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
