import { describe, expect, it } from "vitest";

import {
  LIVE_MATRIX_CONCURRENT_SESSION_COUNT,
  LIVE_MATRIX_E2E_ENABLED,
  LIVE_MATRIX_E2E_RUNNABLE_COMBINATIONS,
  LIVE_MATRIX_E2E_SKIPPED_COMBINATIONS,
  LIVE_MATRIX_E2E_TIMEOUT_MS,
  formatLiveMatrixLabel,
  logLiveMatrixPlan,
  runSimpleStreamMatrixScenario,
} from "../scripts/live-matrix-e2e";

if (LIVE_MATRIX_E2E_ENABLED) {
  logLiveMatrixPlan();
}

describe.skipIf(!LIVE_MATRIX_E2E_ENABLED)(
  "live agent and sandbox async stream matrix",
  () => {
    for (const skipped of LIVE_MATRIX_E2E_SKIPPED_COMBINATIONS) {
      it.skip(`${formatLiveMatrixLabel(skipped)} skipped: ${skipped.reason}`, () =>
        undefined);
    }

    it.each(
      LIVE_MATRIX_E2E_RUNNABLE_COMBINATIONS.map(
        (combination) =>
          [formatLiveMatrixLabel(combination), combination] as const,
      ),
    )(
      `%s streams exact text across ${LIVE_MATRIX_CONCURRENT_SESSION_COUNT} concurrent sessions`,
      async (_label, combination) => {
        const result = await runSimpleStreamMatrixScenario(combination);

        expect(result.version.length).toBeGreaterThan(0);
        expect(result.sessions).toHaveLength(
          LIVE_MATRIX_CONCURRENT_SESSION_COUNT,
        );
        for (const session of result.sessions) {
          expect(session.sessionId.length).toBeGreaterThan(0);
          expect(session.eventTypes).toContain("text.delta");
          expect(session.text).toBe(session.expectedText);
          expect(session.streamedText).toBe(session.expectedText);
        }
      },
      LIVE_MATRIX_E2E_TIMEOUT_MS,
    );
  },
);
