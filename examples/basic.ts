import { Agent, AgentProvider, Sandbox, SandboxProvider } from "agentbox-sdk";

const sandbox = new Sandbox(SandboxProvider.LocalDocker, {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

const result = await new Agent(AgentProvider.ClaudeCode, {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
}).run({
  model: "sonnet",
  input: "Create a hello world Express server in /workspace/server.ts",
});

console.log(result.text);

await sandbox.delete();
