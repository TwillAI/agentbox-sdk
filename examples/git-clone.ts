import { Agent, Sandbox } from "agentbox-sdk";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

await sandbox.gitClone({
  repoUrl: "https://github.com/expressjs/express",
  targetDir: "/workspace/express",
  depth: 1,
});

const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace/express",
  approvalMode: "auto",
});

const result = await agent.run({
  model: "sonnet",
  input:
    "Read the codebase and write a brief architecture overview to /workspace/express/ARCHITECTURE.md",
});

console.log(result.text);
await sandbox.delete();
