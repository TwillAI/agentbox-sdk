import { Agent, AgentProvider, Sandbox, SandboxProvider } from "agentbox-sdk";

const sandbox = new Sandbox(SandboxProvider.LocalDocker, {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

await sandbox.findOrProvision();

await sandbox.gitClone({
  repoUrl: "https://github.com/expressjs/express",
  targetDir: "/workspace/express",
  depth: 1,
});

const agent = new Agent(AgentProvider.ClaudeCode, {
  sandbox,
  cwd: "/workspace/express",
  approvalMode: "auto",
});

await agent.setup();

const result = await agent.run({
  model: "sonnet",
  input:
    "Read the codebase and write a brief architecture overview to /workspace/express/ARCHITECTURE.md",
});

console.log(result.text);
await sandbox.delete();
