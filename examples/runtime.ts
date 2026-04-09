import type { Sandbox } from "openagent";
import type { AgentRun } from "openagent/agents";
import type { AsyncCommandHandle, CommandOptions } from "openagent/sandboxes";

export async function runChecked(
  sandbox: Sandbox,
  command: string | string[],
  options?: CommandOptions,
): Promise<string> {
  const result = await sandbox.run(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Command failed with exit code ${result.exitCode}.`,
        result.stderr || result.stdout || result.combinedOutput,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return result.stdout;
}

export async function writeFiles(
  sandbox: Sandbox,
  rootDir: string,
  files: Record<string, string>,
): Promise<void> {
  const script = `
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.argv[1];
const files = JSON.parse(process.argv[2]);

for (const [relativePath, content] of Object.entries(files)) {
  const targetPath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, String(content), "utf8");
}
`;

  await runChecked(
    sandbox,
    [
      "node",
      "--input-type=module",
      "-e",
      script,
      rootDir,
      JSON.stringify(files),
    ],
    { timeoutMs: 30_000 },
  );
}

export async function stageGitBaseline(
  sandbox: Sandbox,
  cwd: string,
): Promise<void> {
  await runChecked(
    sandbox,
    ["/bin/sh", "-lc", "git init >/dev/null 2>&1 && git add ."],
    { cwd, timeoutMs: 30_000 },
  );
}

export async function streamRun(label: string, run: AgentRun): Promise<void> {
  console.log(`\n=== ${label} ===`);
  console.log(`Session: ${await run.sessionIdReady}\n`);

  for await (const event of run) {
    if (event.type === "text.delta") {
      process.stdout.write(event.delta);
    }
  }

  await run.finished;
  process.stdout.write("\n");
}

export async function startHttpServer(
  sandbox: Sandbox,
  cwd: string,
  port: number,
): Promise<AsyncCommandHandle> {
  const handle = await sandbox.runAsync(
    ["python3", "-m", "http.server", String(port), "--directory", cwd],
    {
      cwd,
      timeoutMs: 0,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return handle;
}

export async function cleanupSandbox(sandbox: Sandbox): Promise<void> {
  if (process.env.KEEP_SANDBOX === "1") {
    console.log(
      `Keeping sandbox ${sandbox.provider}${sandbox.id ? ` (${sandbox.id})` : ""}.`,
    );
    return;
  }

  await sandbox.delete().catch(() => undefined);
}

export async function runExample(
  title: string,
  task: () => Promise<void>,
): Promise<void> {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));

  try {
    await task();
  } catch (error) {
    console.error("\nExample failed.");
    throw error;
  }
}
