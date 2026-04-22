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
  approvalMode: "auto",
  mcps: [
    {
      name: "filesystem",
      type: "local",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    },
  ],
});

const result = await agent.run({
  model: "sonnet",
  input: "Use the filesystem MCP to list all files in /workspace",
});

console.log(result.text);
await sandbox.delete();
