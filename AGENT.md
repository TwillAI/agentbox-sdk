# OpenAgent Guide

OpenAgent is a Bun-friendly TypeScript package for running coding agents and sandbox providers through a swappable API.

## Purpose

The main goal of this package is low-cost swapping:

- swap `codex`, `opencode`, and `claude-code` behind one `Agent` abstraction
- swap `local-docker`, `modal`, and `daytona` behind one `Sandbox` abstraction
- keep provider-specific behavior available, but only behind explicit escape hatches

## Core API Rules

### `Agent`

Use `Agent` as the primary public abstraction.

Construction-time `Agent` options are for reusable environment/runtime setup:

- `sandbox`
- `cwd`
- `env`
- `approvalMode`
- `mcps`
- `skills`
- `subAgents`
- `commands`
- `provider`

Run-time config must stay minimal:

- `input`
- `model`
- `systemPrompt`
- `resumeSessionId`

Do not move MCPs, skills, commands, or sub-agents into the run config.

Hooks are provider-specific because their semantics do not line up cleanly across runtimes:

- Claude Code: configure native hooks under `provider.hooks`
- Codex: configure native hooks under `provider.hooks`
- OpenCode: configure native plugin hooks under `provider.plugins`

Keep `sessionId` as the unified public concept, even though providers map it differently internally:

- Codex: thread id
- OpenCode: session id
- Claude Code: session id

Interactive approvals also belong on the shared `Agent` surface:

- `approvalMode: "interactive"` should make provider permission prompts visible through normalized events
- `AgentRun.respondToPermission()` should be the shared way to continue a paused run
- provider-specific approval flags remain escape hatches, not the primary API

### `Sandbox`

Use `Sandbox` as the primary public abstraction.

Keep the common surface stable:

- `gitClone()`
- `run()`
- `runAsync()`
- `setSecret()` / `setSecrets()`
- `list()`
- `snapshot()`
- `stop()`
- `delete()`
- `getPreviewLink()`
- `raw`

Provider-specific settings belong under `provider`.

## Design Principles

- Prefer provider-agnostic types first.
- Add provider-specific options only when a feature cannot be represented cleanly across providers.
- If a feature is unsupported for a provider, fail clearly instead of silently ignoring it.
- Preserve raw provider access through `raw` and `rawEvents()`.
- Prefer normalized approval events over provider-specific approval callbacks.
- Keep normalized events small and readable.

## Important Runtime Notes

- `local-docker` requires explicit port publishing for host-reachable services like OpenCode.
- Codex uses an env-driven login/setup path when `OPENAI_API_KEY` is present.
- Claude Code over `--sdk-url` is sensitive to websocket startup ordering; the server must drive the initial user message correctly.
- Resume support is run-scoped and uses `resumeSessionId`.

## Repo Map

- `src/agents/` — public `Agent` abstraction, provider adapters, config compilers, transports
- `src/sandboxes/` — public `Sandbox` abstraction and sandbox providers
- `src/events/` — normalized and raw event types
- `examples/` — small usage examples
- `test/` — unit and smoke tests
- `scripts/` — repo-level helper scripts like Docker E2E checks

## Commands

Use these regularly when changing the repo:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

If this directory is a git repo, install hooks with:

```bash
npm run hooks:install
```

## E2E Testing

The local Docker E2E suite validates all three agent providers in a Linux container.

Key expectations:

- credentials should come from project env, not copied host state
- the script should exercise the real `Agent` and `Sandbox` abstractions
- it should produce comparable evidence across providers
- shared feature coverage should include simple runs plus skills, sub-agents, and interactive approvals
- provider-native hook coverage should exercise Claude hooks, Codex hooks, and OpenCode plugin hooks
- CI should build its own Docker image from the repo and rely on GitHub Actions secrets instead of host-specific auth folders where possible

## When Editing

- Prefer updating `README.md` when the public API changes.
- Keep `AGENT.md` aligned with the actual architecture and invariants.
- Remove stale scripts or alternate implementations once a clear winner exists.
- If you introduce a new abstraction boundary, document who owns configuration and who owns execution-time behavior.
