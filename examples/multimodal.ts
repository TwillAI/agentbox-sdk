import { pathToFileURL } from "node:url";
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
});

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
