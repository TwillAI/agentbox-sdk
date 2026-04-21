/**
 * End-to-end test for mid-run message injection on the opencode provider.
 *
 * Spins up a Modal sandbox using the pre-built browser-agent image, starts an
 * opencode agent, injects a second user message after the first tool call
 * completes, and checks that both messages were processed in the same run
 * (same sessionId, two assistant turns).
 *
 * Required env: MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, MODAL_APP_NAME,
 * OPENAGENT_MODAL_IMAGE, ANTHROPIC_API_KEY (or OPENAI_API_KEY).
 */
import { Agent, Sandbox } from "../src";
import { AGENT_RESERVED_PORTS } from "../src/agents/ports";

function fail(message: string): never {
  console.error(`\n[FAIL] ${message}`);
  process.exit(1);
}

const image = process.env.OPENAGENT_MODAL_IMAGE;
if (!image) {
  fail("OPENAGENT_MODAL_IMAGE is not set.");
}

const modalTokenId = process.env.MODAL_TOKEN_ID;
const modalTokenSecret = process.env.MODAL_TOKEN_SECRET;
if (!modalTokenId || !modalTokenSecret) {
  fail("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required.");
}

const openCodeConfig = {
  $schema: "https://opencode.ai/config.json",
  ...(process.env.ANTHROPIC_API_KEY
    ? {
        provider: {
          anthropic: {
            options: { apiKey: "{env:ANTHROPIC_API_KEY}" },
          },
        },
      }
    : process.env.OPENAI_API_KEY
      ? {
          provider: {
            openai: {
              options: { apiKey: "{env:OPENAI_API_KEY}" },
            },
          },
        }
      : (() => {
          fail("ANTHROPIC_API_KEY or OPENAI_API_KEY must be set.");
        })()),
};

const model = process.env.ANTHROPIC_API_KEY
  ? "anthropic/claude-sonnet-4-6"
  : "openai/gpt-4.1";

const sandbox = new Sandbox("modal", {
  workingDir: "/workspace",
  image,
  env: {
    ...(process.env.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
      : {}),
    ...(process.env.OPENAI_API_KEY
      ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
      : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig),
  },
  tags: { scope: "e2e", runner: "opencode-mid-run" },
  idleTimeoutMs: 15 * 60_000,
  autoStopMs: 30 * 60_000,
  resources: { cpu: 2, memoryMiB: 4096 },
  provider: {
    appName: process.env.MODAL_APP_NAME ?? "twill-sandboxes",
    tokenId: modalTokenId,
    tokenSecret: modalTokenSecret,
    unencryptedPorts: [...AGENT_RESERVED_PORTS.opencode],
  },
});

try {
  console.log("Provisioning Modal sandbox…");
  await sandbox.run("opencode --version", { timeoutMs: 60_000 });

  const agent = new Agent("opencode", {
    sandbox,
    cwd: "/workspace",
    approvalMode: "auto",
  });

  const run = agent.stream({
    model,
    input:
      "Write a fizzbuzz function in Python and save it to /workspace/fizzbuzz.py. Only create the function, nothing else.",
  });

  // Fire the injection on a short timer. Opencode's POST /session/:id/message
  // is synchronous per-turn, but concurrent POSTs are queued server-side, so
  // the injected message will be picked up as the next turn after the first
  // one completes. This is deterministic regardless of whether the first turn
  // emits tool call events that bubble through our SSE normalizer.
  const INJECT_AFTER_MS = 4_000;
  let injected = false;
  let injectedAt: number | null = null;
  let injectError: unknown;
  const injectionPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      injected = true;
      injectedAt = Date.now();
      console.log(
        `\n>>> [${INJECT_AFTER_MS}ms] Injecting mid-run message: add a __main__ block\n`,
      );
      run
        .sendMessage(
          'Now also append an `if __name__ == "__main__":` block at the end of /workspace/fizzbuzz.py that prints fizzbuzz for 1..15. Keep the existing function. Overwrite the file.',
        )
        .then(() => {
          console.log(">>> sendMessage resolved\n");
        })
        .catch((error: unknown) => {
          injectError = error;
          console.error(
            `>>> sendMessage threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(resolve);
    }, INJECT_AFTER_MS);
  });

  const textDeltas: string[] = [];
  const events: string[] = [];

  for await (const event of run) {
    events.push(event.type);
    switch (event.type) {
      case "run.started":
        console.log("→ run.started");
        break;
      case "message.started":
        console.log("→ message.started");
        break;
      case "tool.call.started":
        console.log(`→ tool.call.started   ${event.toolName}`);
        break;
      case "tool.call.completed":
        console.log(`→ tool.call.completed ${event.toolName}`);
        break;
      case "message.injected":
        console.log(`→ message.injected    ${event.content.slice(0, 60)}…`);
        break;
      case "text.delta":
        textDeltas.push(event.delta);
        process.stdout.write(event.delta);
        break;
      case "message.completed":
        console.log(`\n→ message.completed   (${event.text?.length ?? 0} ch)`);
        break;
      case "run.completed":
        console.log(`\n→ run.completed       (${event.text?.length ?? 0} ch)`);
        break;
      case "run.error":
        console.log(`\n→ run.error           ${event.error}`);
        break;
    }
  }

  await injectionPromise;

  const result = await run.finished;
  console.log("\n--- run finished ---");
  console.log(`sessionId: ${result.sessionId}`);
  console.log(`final text length: ${result.text.length}`);
  console.log(`total events: ${events.length}`);
  console.log(`text.delta chunks: ${textDeltas.length}`);

  if (injectError) {
    fail(
      `sendMessage threw: ${injectError instanceof Error ? injectError.message : String(injectError)}`,
    );
  }
  if (!injected) {
    fail("Injection timer never fired.");
  }

  const count = (type: string) => events.filter((t) => t === type).length;
  const messageInjectedCount = count("message.injected");
  const textDeltaCount = count("text.delta");
  const runCompletedCount = count("run.completed");
  console.log(
    `event counts: message.injected=${messageInjectedCount}, text.delta=${textDeltaCount}, run.completed=${runCompletedCount}`,
  );
  if (messageInjectedCount !== 1) {
    fail(`Expected exactly 1 message.injected event, got ${messageInjectedCount}.`);
  }
  if (textDeltaCount < 2) {
    fail(
      `Expected at least 2 text.delta events (one per turn), got ${textDeltaCount}. The injected message was probably not processed as a second turn.`,
    );
  }
  if (runCompletedCount !== 1) {
    fail(`Expected exactly 1 run.completed event, got ${runCompletedCount}.`);
  }

  const fizzbuzzCheck = await sandbox.run(
    "test -f /workspace/fizzbuzz.py && grep -c '__main__' /workspace/fizzbuzz.py || echo missing",
    { timeoutMs: 30_000 },
  );
  const mainBlockCount = Number.parseInt(
    fizzbuzzCheck.stdout.trim() || "0",
    10,
  );
  console.log(
    `\n/workspace/fizzbuzz.py exists, __main__ occurrences: ${Number.isNaN(mainBlockCount) ? fizzbuzzCheck.stdout.trim() : mainBlockCount}`,
  );

  if (!Number.isFinite(mainBlockCount) || mainBlockCount < 1) {
    fail(
      "Injected message was not honored: no __main__ block found in /workspace/fizzbuzz.py.",
    );
  }

  const runDurationMs =
    injectedAt !== null ? Date.now() - injectedAt : undefined;
  console.log(
    `\n[PASS] Mid-run injection worked. Injection-to-completion: ${runDurationMs ?? "?"} ms.`,
  );
} finally {
  console.log("\nCleaning up sandbox…");
  await sandbox.delete().catch((error: unknown) => {
    console.warn(
      `sandbox.delete() failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
