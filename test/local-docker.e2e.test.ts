import { describe, expect, it } from "vitest";

import {
  LOCAL_DOCKER_E2E_ENABLED,
  LOCAL_DOCKER_E2E_PROVIDERS,
  LOCAL_DOCKER_E2E_TIMEOUT_MS,
  runApprovalScenario,
  runHookScenario,
  runImageScenario,
  runSimpleScenario,
  runSkillScenario,
  runSubAgentScenario,
} from "./helpers/local-docker-e2e";

describe.skipIf(!LOCAL_DOCKER_E2E_ENABLED)("local docker agent e2e", () => {
  it.each(LOCAL_DOCKER_E2E_PROVIDERS)(
    "%s completes a simple exact-text run",
    async (provider) => {
      const result = await runSimpleScenario(provider);

      expect(result.version.length).toBeGreaterThan(0);
      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(result.text).toBe("hello");
    },
    LOCAL_DOCKER_E2E_TIMEOUT_MS,
  );

  it.each(LOCAL_DOCKER_E2E_PROVIDERS)(
    "%s can inspect an attached image",
    async (provider) => {
      const result = await runImageScenario(provider);

      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(result.text).toBe(result.expectedColor);
    },
    LOCAL_DOCKER_E2E_TIMEOUT_MS,
  );

  it.each(LOCAL_DOCKER_E2E_PROVIDERS)(
    "%s can use embedded skills",
    async (provider) => {
      const result = await runSkillScenario(provider);

      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(result.text).toContain(result.secretToken);
    },
    LOCAL_DOCKER_E2E_TIMEOUT_MS,
  );

  it.each(LOCAL_DOCKER_E2E_PROVIDERS)(
    "%s can delegate to a configured sub-agent",
    async (provider) => {
      const result = await runSubAgentScenario(provider);

      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(result.text).toContain(result.secretToken);
    },
    LOCAL_DOCKER_E2E_TIMEOUT_MS,
  );

  it.each(LOCAL_DOCKER_E2E_PROVIDERS)(
    "%s surfaces interactive approvals through stream()",
    async (provider) => {
      const result = await runApprovalScenario(provider);

      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(result.permissionRequests.length).toBeGreaterThan(0);
      expect(
        result.events.some((event) => event.type === "permission.resolved"),
      ).toBe(true);
      expect(result.text).toContain("approval-complete");
      expect(result.outputFileContents).toBe(result.outputText);
    },
    LOCAL_DOCKER_E2E_TIMEOUT_MS,
  );

  it.each(LOCAL_DOCKER_E2E_PROVIDERS)(
    "%s runs configured native hook support inside the sandbox",
    async (provider) => {
      const result = await runHookScenario(provider);

      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(result.text).toContain("hook-complete");
      expect(result.triggerFileContents).toBe(result.triggerText);
      expect(result.hookFileContents).toBe(result.hookText);
    },
    LOCAL_DOCKER_E2E_TIMEOUT_MS,
  );
});
