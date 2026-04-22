import { describe, expect, it } from "vitest";

import { Sandbox, SandboxProvider } from "../src";

const smokeEnabled = process.env.AGENTBOX_RUN_SMOKE_TESTS === "1";

describe.skipIf(!smokeEnabled)("optional provider smoke tests", () => {
  it("can reach an OpenCode app server when a URL is provided", async () => {
    const serverUrl = process.env.AGENTBOX_OPENCODE_URL;
    if (!serverUrl) {
      return;
    }

    const response = await fetch(
      `${serverUrl.replace(/\/$/, "")}/global/health`,
    );
    expect(response.ok).toBe(true);
  });

  it("can list Modal sandboxes when credentials are present", async () => {
    if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
      return;
    }

    const sandbox = new Sandbox(SandboxProvider.Modal, {
      provider: {
        tokenId: process.env.MODAL_TOKEN_ID,
        tokenSecret: process.env.MODAL_TOKEN_SECRET,
        appName: "agentbox-smoke",
      },
    });

    const sandboxes = await sandbox.list();
    expect(Array.isArray(sandboxes)).toBe(true);
  });

  it("can list Daytona sandboxes when credentials are present", async () => {
    if (!process.env.DAYTONA_API_KEY) {
      return;
    }

    const sandbox = new Sandbox(SandboxProvider.Daytona, {
      provider: {
        apiKey: process.env.DAYTONA_API_KEY,
        apiUrl: process.env.DAYTONA_API_URL,
        target: process.env.DAYTONA_TARGET,
      },
    });

    const sandboxes = await sandbox.list();
    expect(Array.isArray(sandboxes)).toBe(true);
  });

  it("can list Vercel sandboxes when credentials are present", async () => {
    if (
      !process.env.VERCEL_TOKEN ||
      !process.env.VERCEL_TEAM_ID ||
      !process.env.VERCEL_PROJECT_ID
    ) {
      return;
    }

    const sandbox = new Sandbox(SandboxProvider.Vercel, {
      provider: {
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
        projectId: process.env.VERCEL_PROJECT_ID,
      },
    });

    const sandboxes = await sandbox.list();
    expect(Array.isArray(sandboxes)).toBe(true);
  });

  it("can list E2B sandboxes when credentials are present", async () => {
    if (!process.env.E2B_API_KEY) {
      return;
    }

    const sandbox = new Sandbox(SandboxProvider.E2B, {
      provider: {
        apiKey: process.env.E2B_API_KEY,
      },
    });

    const sandboxes = await sandbox.list();
    expect(Array.isArray(sandboxes)).toBe(true);
  });
});
