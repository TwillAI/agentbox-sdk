import { Agent, Sandbox } from "agentbox-sdk";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

const result = await new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
}).run({
  model: "claude-sonnet-4-6",
  input: "Create a hello world Express server in /workspace/server.ts",
});

console.log(result.text);

await sandbox.delete();
