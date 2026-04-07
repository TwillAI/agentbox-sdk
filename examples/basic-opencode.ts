import { Agent, Sandbox } from "../src";

async function main() {
  const sandbox = new Sandbox("local-docker", {
    workingDir: "/workspace",
    tags: { example: "opencode" },
    image: "node:20-bookworm",
  });

  const agent = new Agent("opencode", {
    sandbox,
    cwd: "/workspace",
    commands: [
      {
        name: "triage",
        description: "Triage the current repo state",
        template:
          "Summarize the current repository state and suggest the highest-value next step.",
      },
    ],
  });

  const run = agent.stream({
    input: "Summarize the repository and suggest a first task.",
    model: "gpt-4.1",
    systemPrompt: "Prefer concise summaries and concrete next steps.",
  });

  console.log("Session:", await run.sessionIdReady);

  for await (const event of run.toAISDKEvents()) {
    if (event.type === "text-delta") {
      process.stdout.write(event.textDelta);
    }
  }

  const result = await run.finished;
  console.log("\nDone:", result.text);
}

void main();
