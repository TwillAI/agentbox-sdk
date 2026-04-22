/**
 * Custom sandbox images let you pre-install tools your agent needs.
 *
 * 1. Define the image in a .mjs file (see below)
 * 2. Build it:  npx agentbox image build --provider local-docker --file ./my-image.mjs
 * 3. Use the printed image reference as IMAGE_ID
 *
 * Example image definition (my-image.mjs):
 *
 *   export default {
 *     name: "playwright-sandbox",
 *     base: "node:20-bookworm",
 *     env: { PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" },
 *     run: [
 *       "apt-get update && apt-get install -y git python3 ca-certificates",
 *       "npm install -g pnpm @anthropic-ai/claude-code",
 *       "npx playwright install --with-deps chromium",
 *     ],
 *     workdir: "/workspace",
 *     cmd: ["sleep", "infinity"],
 *   };
 */

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
});

const result = await agent.run({
  model: "sonnet",
  input:
    "Use Playwright to take a screenshot of https://example.com and save it to /workspace/screenshot.png",
});

console.log(result.text);
await sandbox.delete();
