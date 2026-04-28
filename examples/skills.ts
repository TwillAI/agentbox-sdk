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
  // Skills from a GitHub repo are cloned into the sandbox
  // and made available to the agent automatically.
  skills: [
    {
      name: "agent-browser",
      repo: "https://github.com/vercel-labs/agent-browser",
    },
  ],
});

await agent.setup();

const result = await agent.run({
  model: "sonnet",
  input: "Browse https://example.com and tell me what the page says.",
});

console.log(result.text);
await sandbox.delete();
