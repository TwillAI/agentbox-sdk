/**
 * Basic Vercel sandbox usage.
 * Requires: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 */

import { Sandbox, SandboxProvider } from "agentbox-sdk";

const sandbox = new Sandbox(SandboxProvider.Vercel, {
  tags: { example: "basic-vercel" },
  provider: {
    runtime: "node24",
    timeoutMs: 120_000,
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
  },
});

// Vercel sandboxes run under /vercel/sandbox by default and cannot use
// an arbitrary workspace root like the other providers.
await sandbox.gitClone({
  repoUrl: "https://github.com/octocat/Hello-World.git",
  targetDir: "/vercel/sandbox/hello-world",
});

const result = await sandbox.run("ls -la /vercel/sandbox/hello-world");
console.log(result.stdout);

await sandbox.delete();
