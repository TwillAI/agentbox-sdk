import { Agent, AgentProvider, Sandbox, SandboxProvider } from "agentbox-sdk";

const sandbox = new Sandbox(SandboxProvider.LocalDocker, {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

await sandbox.findOrProvision();

const agent = new Agent(AgentProvider.ClaudeCode, {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
});

await agent.setup();

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
