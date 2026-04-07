import { Agent, Sandbox } from "../src";

async function main() {
  const sandbox = new Sandbox("local-docker", {
    workingDir: "/workspace",
    tags: { example: "codex" },
    image: "node:20-bookworm",
  });

  const agent = new Agent("codex", {
    sandbox,
    cwd: "/workspace",
  });

  const run = agent.stream({
    input: "Describe the current working directory.",
    model: "gpt-5-codex",
  });

  const sessionId = await run.sessionIdReady;
  console.log("Session:", sessionId);

  for await (const event of run) {
    if (event.type === "text.delta") {
      process.stdout.write(event.delta);
    }
  }

  const result = await run.finished;
  console.log("\nDone:", result.text);
}

void main();
