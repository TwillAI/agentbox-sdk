import { describe, expect, it } from "vitest";

import { Sandbox } from "../src";

const smokeEnabled = process.env.OPENAGENT_RUN_SMOKE_TESTS === "1";

describe.skipIf(!smokeEnabled)("optional provider smoke tests", () => {
  it("can reach an OpenCode app server when a URL is provided", async () => {
    const serverUrl = process.env.OPENAGENT_OPENCODE_URL;
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

    const sandbox = new Sandbox("modal", {
      provider: {
        tokenId: process.env.MODAL_TOKEN_ID,
        tokenSecret: process.env.MODAL_TOKEN_SECRET,
        appName: "openagent-smoke",
      },
    });

    const sandboxes = await sandbox.list();
    expect(Array.isArray(sandboxes)).toBe(true);
  });

  it("can list Daytona sandboxes when credentials are present", async () => {
    if (!process.env.DAYTONA_API_KEY) {
      return;
    }

    const sandbox = new Sandbox("daytona", {
      provider: {
        apiKey: process.env.DAYTONA_API_KEY,
        apiUrl: process.env.DAYTONA_API_URL,
        target: process.env.DAYTONA_TARGET,
      },
    });

    const sandboxes = await sandbox.list();
    expect(Array.isArray(sandboxes)).toBe(true);
  });
});
