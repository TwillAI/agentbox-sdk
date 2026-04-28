/**
 * Swap "local-docker" for any cloud sandbox provider.
 * The agent code stays exactly the same.
 */

import { Agent, AgentProvider, Sandbox, SandboxProvider } from "agentbox-sdk";

// --- E2B ---
const e2b = new Sandbox(SandboxProvider.E2B, {
  workingDir: "/workspace",
  image: process.env.E2B_TEMPLATE!,
  provider: {
    apiKey: process.env.E2B_API_KEY!,
    timeoutMs: 10 * 60_000,
  },
});

// --- Modal ---
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const modal = new Sandbox(SandboxProvider.Modal, {
  workingDir: "/workspace",
  image: process.env.MODAL_IMAGE_ID!,
  resources: { cpu: 2, memoryMiB: 4096 },
  provider: {
    appName: "my-agent-app",
  },
});

// --- Daytona ---
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const daytona = new Sandbox(SandboxProvider.Daytona, {
  workingDir: "/workspace",
  image: process.env.DAYTONA_IMAGE!,
  provider: {
    apiKey: process.env.DAYTONA_API_KEY!,
  },
});

// Pick one:
const sandbox = e2b; // or modal, daytona

await sandbox.findOrProvision();

const agent = new Agent(AgentProvider.OpenCode, {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

await agent.setup();

const result = await agent.run({
  model: "anthropic/claude-sonnet-4-6",
  input: "List all files in the workspace and summarize what you see.",
});

console.log(result.text);
await sandbox.delete();
