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
  subAgents: [
    {
      name: "reviewer",
      description: "Reviews code for bugs and security issues",
      instructions:
        "Review code changes carefully. Flag bugs, security issues, and missing edge cases. Be concise.",
      tools: ["bash", "read"],
    },
  ],
});

const result = await agent.run({
  model: "claude-sonnet-4-6",
  input: [
    "Create a simple user authentication module in /workspace/auth.ts,",
    "then delegate to the reviewer sub-agent to review it.",
  ].join(" "),
});

console.log(result.text);
await sandbox.delete();
