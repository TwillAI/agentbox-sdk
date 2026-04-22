import * as readline from "node:readline/promises";
import { Agent, AgentProvider, Sandbox, SandboxProvider } from "agentbox-sdk";

const sandbox = new Sandbox(SandboxProvider.LocalDocker, {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

const agent = new Agent(AgentProvider.ClaudeCode, {
  sandbox,
  cwd: "/workspace",
  approvalMode: "interactive",
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const run = agent.stream({
  model: "sonnet",
  input:
    "Install express and create a hello world server in /workspace/server.ts",
});

for await (const event of run) {
  switch (event.type) {
    case "text.delta":
      process.stdout.write(event.delta);
      break;

    case "permission.requested": {
      console.log(`\n--- Permission requested ---`);
      console.log(`  Kind:    ${event.kind}`);
      console.log(`  Title:   ${event.title ?? "(none)"}`);
      console.log(`  Message: ${event.message ?? "(none)"}`);
      const answer = await rl.question("  Allow? (y/n) ");
      await run.respondToPermission({
        requestId: event.requestId,
        decision: answer.toLowerCase().startsWith("y") ? "allow" : "deny",
      });
      break;
    }

    case "permission.resolved":
      console.log(`  -> ${event.decision}`);
      break;
  }
}

rl.close();
const result = await run.finished;
console.log(`\nDone. Session: ${result.sessionId}`);

await sandbox.delete();
