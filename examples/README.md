# Examples

These examples are scenario-first rather than provider-first.

They also import `openagent` the same way a real consumer app would, instead of reaching into `../src`.

Each script shows a real developer workflow with a specific `agent + sandbox` pair:

| Script | Pair | Use case | Extra env |
| --- | --- | --- | --- |
| `repo-tour-codex-local-docker.ts` | `codex + local-docker` | Onboard a new engineer into a repo and write `ONBOARDING.md` | `OPENAI_API_KEY` |
| `pr-review-claude-code-modal.ts` | `claude-code + modal` | Review a risky checkout diff in a remote sandbox | `ANTHROPIC_API_KEY`, Modal auth |
| `issue-triage-opencode-daytona.ts` | `opencode + daytona` | Turn a bug report into a root-cause analysis and fix plan | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, Daytona auth |
| `browser-qa-opencode-e2b.ts` | `opencode + e2b` | Smoke-test a preview URL and save a screenshot | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, `E2B_API_KEY` |

## Assumptions

- `IMAGE_ID` is already set in your environment.
- `IMAGE_ID` should point to the right image reference for the sandbox provider you are about to run:
  - Docker image tag for `local-docker`
  - Modal image id for `modal`
  - Daytona snapshot for `daytona`
  - E2B template name or tag for `e2b`
- The image already has the relevant agent runtime installed.

## Run

```bash
npm run examples:repo-tour
npm run examples:pr-review
npm run examples:triage
npm run examples:browser-qa
```

Each script builds the package first so the examples run against the published entrypoints.

## Handy notes

- Each entry file is intentionally short; seeded project fixtures live under `examples/fixtures/`.
- Every example seeds its own tiny project inside the sandbox so you can run it without cloning another repo.
- By default the script deletes the sandbox when it finishes.
- Set `KEEP_SANDBOX=1` if you want to inspect the environment afterward.
