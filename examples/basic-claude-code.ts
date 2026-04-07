import { Agent, Sandbox } from "../src";

async function main() {
  const sandbox = new Sandbox("local-docker", {
    workingDir: "/workspace",
    tags: { example: "claude-code" },
    image: "node:20-bookworm",
  });

  const agent = new Agent("claude-code", {
    sandbox,
    cwd: "/workspace",
    subAgents: [
      {
        name: "reviewer",
        description: "Review code for bugs and regressions",
        instructions:
          "Review the current changes and flag likely bugs, regressions, and missing tests.",
        tools: ["bash"],
      },
    ],
    provider: {
      autoApproveTools: true,
      verbose: true,
    },
  });

  const run = agent.stream({
    input: "List the most interesting files in this repository.",
    model: "claude-opus-4-1",
    systemPrompt:
      "Be concise and prioritize files that best explain the project.",
  });

  console.log("Session:", await run.sessionIdReady);

  for await (const event of run) {
    if (event.type === "text.delta") {
      process.stdout.write(event.delta);
    }
  }

  const result = await run.finished;
  console.log("\nDone:", result.text);
}

void main();
