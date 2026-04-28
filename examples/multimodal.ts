import { pathToFileURL } from "node:url";
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

const result = await agent.run({
  model: "sonnet",
  input: [
    {
      type: "text",
      text: "Describe this image and save a summary to /workspace/description.md",
    },
    { type: "image", image: pathToFileURL("/path/to/screenshot.png") },
  ],
});

console.log(result.text);
await sandbox.delete();
