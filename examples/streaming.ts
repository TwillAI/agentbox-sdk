import { Agent, Sandbox } from "agentbox-sdk";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
});

const run = agent.stream({
  model: "sonnet",
  input:
    "Write a fizzbuzz function in Python and save it to /workspace/fizzbuzz.py",
});

for await (const event of run) {
  switch (event.type) {
    case "text.delta":
      process.stdout.write(event.delta);
      break;
    case "tool.call.started":
      console.log(`\n> tool: ${event.toolName}`);
      break;
    case "tool.call.completed":
      console.log(`  done (${event.toolName})`);
      break;
  }
}

const result = await run.finished;
console.log(`\nSession: ${result.sessionId}`);

await sandbox.delete();
