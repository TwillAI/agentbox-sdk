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
  // Skills from a GitHub repo are cloned into the sandbox
  // and made available to the agent automatically.
  skills: [
    {
      name: "agent-browser",
      repo: "https://github.com/vercel-labs/agent-browser",
    },
  ],
});

const result = await agent.run({
  model: "claude-sonnet-4-6",
  input: "Browse https://example.com and tell me what the page says.",
});

console.log(result.text);
await sandbox.delete();
