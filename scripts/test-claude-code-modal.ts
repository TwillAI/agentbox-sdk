import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Agent, Sandbox } from "../src";

function loadDotEnv() {
  const envPath = resolve(import.meta.dirname, "../.env");
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const RELAY_PORT = 43180;
const TIMEOUT_MS = 180_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function createSandbox(label: string): Sandbox<"modal"> {
  return new Sandbox("modal", {
    workingDir: "/workspace",
    image: requireEnv("OPENAGENT_MODAL_IMAGE"),
    tags: {
      scope: "test",
      runner: "claude-code-modal-test",
      label,
      run: randomUUID().slice(0, 8),
    },
    idleTimeoutMs: 15 * 60_000,
    autoStopMs: 60 * 60_000,
    resources: { cpu: 2, memoryMiB: 4096 },
    provider: {
      appName: process.env.MODAL_APP_NAME ?? "openagent-test",
      ...(process.env.MODAL_TOKEN_ID
        ? { tokenId: process.env.MODAL_TOKEN_ID }
        : {}),
      ...(process.env.MODAL_TOKEN_SECRET
        ? { tokenSecret: process.env.MODAL_TOKEN_SECRET }
        : {}),
      unencryptedPorts: [RELAY_PORT],
    },
  });
}

function createAgent(sandbox: Sandbox<"modal">): Agent<"claude-code"> {
  return new Agent("claude-code", {
    sandbox,
    cwd: "/workspace",
    approvalMode: "auto",
    env: { ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY") },
    provider: {
      autoApproveTools: true,
      verbose: true,
    },
  });
}

async function withTimeout<T>(
  label: string,
  task: () => Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>(
    (_, reject) =>
      (timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      )),
  );
  try {
    return await Promise.race([task(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

interface RunResult {
  label: string;
  success: boolean;
  sessionId?: string;
  expectedText: string;
  actualText: string;
  streamedText: string;
  eventTypes: string[];
  durationMs: number;
  error?: string;
}

async function executeRun(
  agent: Agent<"claude-code">,
  label: string,
  expectedText: string,
): Promise<RunResult> {
  const start = Date.now();
  const eventTypes: string[] = [];
  let streamedText = "";

  try {
    const run = agent.stream({
      input: `Reply with exactly "${expectedText}" and nothing else. Do not add any other text, explanation, or formatting.`,
      model: "claude-sonnet-4-6",
    });

    const sessionId = await withTimeout(
      `${label} session`,
      () => run.sessionIdReady,
      60_000,
    );
    console.log(`  [${label}] session started: ${sessionId}`);

    await withTimeout(
      `${label} completion`,
      async () => {
        for await (const event of run) {
          eventTypes.push(event.type);
          if (event.type === "text.delta") {
            streamedText += event.delta;
          }
        }
      },
      TIMEOUT_MS,
    );

    const result = await run.finished;
    const durationMs = Date.now() - start;

    return {
      label,
      success: true,
      sessionId: result.sessionId,
      expectedText,
      actualText: result.text.trim(),
      streamedText: streamedText.trim(),
      eventTypes: [...new Set(eventTypes)],
      durationMs,
    };
  } catch (err) {
    return {
      label,
      success: false,
      expectedText,
      actualText: "",
      streamedText: streamedText.trim(),
      eventTypes: [...new Set(eventTypes)],
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printResult(result: RunResult): void {
  const status = result.success ? "SUCCESS" : "FAILURE";
  console.log(`\n--- ${result.label}: ${status} ---`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.sessionId) {
    console.log(`  Session ID: ${result.sessionId}`);
  }
  console.log(`  Expected: "${result.expectedText}"`);
  console.log(`  Actual:   "${result.actualText}"`);
  console.log(`  Streamed: "${result.streamedText}"`);
  console.log(`  Event types: ${result.eventTypes.join(", ")}`);
  if (result.error) {
    console.log(`  Error: ${result.error}`);
  }
  const textMatch = result.actualText.includes(result.expectedText);
  console.log(`  Text match: ${textMatch}`);
}

async function main() {
  console.log("=== Claude Code + Modal Sandbox Test ===\n");

  const sandbox = createSandbox("claude-code-test");
  let singleResult: RunResult | undefined;
  const concurrentResults: RunResult[] = [];

  try {
    const version = await sandbox.run("claude --version", {
      cwd: "/workspace",
      timeoutMs: 30_000,
    });
    console.log(
      `  Claude version: ${version.stdout.trim() || version.combinedOutput.trim()}`,
    );

    const agent = createAgent(sandbox);

    // --- Test 1: Single run ---
    console.log("\n--- Test 1: Single Run ---");
    const expectedText = `test-single-${randomUUID().slice(0, 8)}`;
    singleResult = await executeRun(agent, "single-run", expectedText);
    printResult(singleResult);

    // --- Test 2: Two concurrent runs ---
    console.log("\n--- Test 2: Two Concurrent Runs ---");
    const expected1 = `test-concurrent-a-${randomUUID().slice(0, 8)}`;
    const expected2 = `test-concurrent-b-${randomUUID().slice(0, 8)}`;

    const [result1, result2] = await Promise.all([
      executeRun(agent, "concurrent-run-1", expected1),
      executeRun(agent, "concurrent-run-2", expected2),
    ]);

    concurrentResults.push(result1, result2);
    printResult(result1);
    printResult(result2);
  } catch (err) {
    console.error(
      "  FAILED (setup):",
      err instanceof Error ? err.message : err,
    );
  } finally {
    await sandbox.delete().catch(() => undefined);
  }

  // --- Summary ---
  console.log("\n\n========== SUMMARY ==========");
  const allResults = [singleResult, ...concurrentResults].filter(
    (r): r is RunResult => r !== undefined,
  );

  for (const r of allResults) {
    const status = r.success ? "PASS" : "FAIL";
    const textMatch = r.success && r.actualText.includes(r.expectedText);
    console.log(
      `  [${status}] ${r.label} (${(r.durationMs / 1000).toFixed(1)}s)${textMatch ? " - text matched" : r.success ? " - text mismatch" : ` - ${r.error?.slice(0, 80)}`}`,
    );
  }

  const passed = allResults.filter((r) => r.success).length;
  const failed = allResults.filter((r) => !r.success).length;
  console.log(
    `\nTotal: ${passed} passed, ${failed} failed out of ${allResults.length}`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

process.on("uncaughtException", (err) => {
  if (err.message?.includes("Channel has been shut down")) return;
  console.error("Fatal error:", err);
  process.exit(1);
});

void main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
