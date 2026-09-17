# AgentBox

[Live demo](https://agentbox-demo-175164121374.us-west1.run.app/)

Run coding agents inside sandboxes. One API, any provider.

Unlike wrappers that shell out to CLIs in non-interactive mode (e.g. `claude --print`), AgentBox launches each agent as a **server process** inside the sandbox and communicates over WebSocket or HTTP. This preserves the full interactive capabilities of each agent — approval flows, tool-use control, streaming events.

```ts
import { Agent, Sandbox } from "agentbox-sdk";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
});

await sandbox.findOrProvision();

const run = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
}).stream({
  model: "sonnet",
  input: "Create a hello world Express server in /workspace/server.ts",
});

for await (const event of run) {
  if (event.type === "text.delta") process.stdout.write(event.delta);
}

await sandbox.delete();
```

Providers are mix-and-match:

- **Agents** — [`claude-code`](./src/agents/providers/claude-code.ts), [`opencode`](./src/agents/providers/opencode.ts), [`codex`](./src/agents/providers/codex.ts)
- **Sandboxes** — [`local-docker`](./src/sandboxes/providers/local-docker.ts), [`e2b`](./src/sandboxes/providers/e2b.ts), [`modal`](./src/sandboxes/providers/modal.ts), [`daytona`](./src/sandboxes/providers/daytona.ts), [`vercel`](./src/sandboxes/providers/vercel.ts)

Swap either one and your app code stays the same.

## Install

```bash
npm install agentbox-sdk
```

Requires Node >= 20. The agent CLI you want to use (`claude`, `opencode`, `codex`) should be installed inside your sandbox image.

## Getting started

### 1. Build a sandbox image

AgentBox ships with built-in image presets. Build one for your sandbox provider:

```bash
npx agentbox image build --provider local-docker --preset browser-agent
```

This prints an image reference (a Docker tag, Modal image ID, E2B template, or Daytona snapshot depending on the provider). Set it as `IMAGE_ID`:

```bash
export IMAGE_ID=<printed value>
```

### 2. Run an agent

```ts
import { Agent, Sandbox } from "agentbox-sdk";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
});

// Explicitly attach to / create the sandbox before running anything.
// Subsequent `sandbox.run`, `sandbox.gitClone`, agent runs, etc. all
// require this to have happened first.
await sandbox.findOrProvision();

const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
});

const result = await agent.run({
  model: "sonnet",
  input:
    "Explain the project structure and write a summary to /workspace/OVERVIEW.md",
});

console.log(result.text);
await sandbox.delete();
```

### 3. Stream events

`agent.stream()` returns an async iterable of normalized events:

```ts
const run = agent.stream({
  model: "sonnet",
  input: "Write a fizzbuzz in Python",
});

for await (const event of run) {
  if (event.type === "text.delta") {
    process.stdout.write(event.delta);
  }
}

const result = await run.finished;
```

Claude Code can leave work running after its turn ends (`run_in_background`
shells, `Monitor`, background subagents, scheduled wakeups) and re-prompts
itself when that work finishes. AgentBox reports it through `background.tasks`
events — `tasks` is the full live set after each change and `waiting` is `true`
while the harness has ended its turn and the run stays open only for those
tasks (or, with an empty set, for the wake-up the CLI queues for a task that
finished mid-turn) — and settles the run on the follow-up turn's result
instead of the first one. Once background work has been seen, a turn end
settles the run only after a 15s grace with no new turn, and a final
`background.tasks` with `tasks: []` and `waiting: false` precedes the settle.
`backgroundTaskTimeoutMs` bounds the total time spent waiting across the run:
default 30 minutes, `0` settles at the first turn end as before, `Infinity`
waits forever. On expiry the tasks are stopped best-effort and the run
completes with the last turn's text.

Codex owns command polling (`write_stdin`), yielded code-mode waits (`wait`),
and subagent waits (`wait_agent`). AgentBox finishes an ordinary Codex run on
its root `turn/completed`, regardless of shell processes still running. It does
not classify commands, wait for their exit, or inject synthetic follow-up turns.
Raw tool events remain available. A command ending after the final turn does
not restart the model. Remote cleanup disconnects from the shared app-server;
local cleanup shuts down the app-server it owns.

Native Codex goals are a separate lifecycle: an active root-thread goal keeps
the run open between turns so Codex can continue on its own. AgentBox reports
these gaps with `background.tasks { tasks: [], waiting: true }` and clears the
wait when the next native turn starts. A root goal becoming `complete` or
`blocked` ends the run after its final turn; a goal cleared or made inactive
while idle settles immediately. Child-thread and stale-turn goal updates do
not end the root run. `blocked` preserves the final answer without implying
that the objective was achieved.

Only these native goal waits use `backgroundTaskTimeoutMs` for Codex. The
15-second idle grace and total wait ceiling bound the gap between native turns;
`0` settles at the first turn. Expiry settles with the last answer without
terminating remote shell processes. A user message can resume an idle goal
wait. Stateless cancellation (`Agent.attach(...).abort()`) interrupts an active
turn, or starts a turn only to interrupt it if the thread is idle, then stops
the idle thread's leftover terminals. Claude Code and OpenCode retain their own
background-work handling described above and below.

OpenCode has no background shells, monitors, or wake-ups; its only work that
outlives a turn is `task {background: true}`, which the server accepts only when
it runs with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (or the
`OPENCODE_EXPERIMENTAL` umbrella) in its environment. With that flag the parent
session goes idle while the child session runs and OpenCode itself re-prompts
the parent with the child's result. AgentBox recognises a background child from
the parent's `task` tool call (`metadata.background`), so nothing depends on the
caller's env: while such a child is live at the parent's idle the run stays
open, the children are reported through `background.tasks` (`type:
"subagent"`, `description` is the task description / child session title),
`waiting` flips to `false` when the parent resumes, and the run settles on the
next parent idle with nothing live — its text is the parent's last assistant
message, never the injected result. Child liveness comes from SSE frames
reconciled against `GET /session/status` at each parent idle and while waiting,
and the injected `<task id=… state=…>` result also counts as the child's
completion, so a lost frame cannot hold the run open. A child that ends without
waking the parent settles the run after the 15s grace. `backgroundTaskTimeoutMs`
bounds the total wait as for Claude Code; on expiry, or when the run fails with
a child still live, the leftover subagents are stopped best-effort via
`POST /session/:id/abort`. Aborting the run while waiting cancels the children
through the same endpoint. Without the flag nothing changes: a parent idle is
the end of the run.

## Agents

Three agent providers are supported. Each wraps a CLI that runs inside the sandbox:

| Provider      | CLI        | Model format                                    |
| ------------- | ---------- | ----------------------------------------------- |
| `claude-code` | `claude`   | `sonnet`, `opus`, `haiku`                       |
| `opencode`    | `opencode` | `anthropic/claude-sonnet-4-6`, `openai/gpt-4.1` |
| `codex`       | `codex`    | `gpt-5.3-codex`, `gpt-5.4`                      |

```ts
new Agent("claude-code", { sandbox, cwd: "/workspace", approvalMode: "auto" });
new Agent("open-code", { sandbox, cwd: "/workspace", approvalMode: "auto" });
new Agent("codex", { sandbox, cwd: "/workspace", approvalMode: "auto" });
```

### Reasoning effort

Pass an optional `reasoning` level alongside `model` on any run. It maps to each provider's native reasoning control: Codex's `effort` on `turn/start`, Claude Code's `--effort` flag, and OpenCode's `reasoningEffort` agent variant.

```ts
await agent.run({
  model: "sonnet",
  reasoning: "high", // "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
  input: "Refactor this module and explain your reasoning.",
});
```

`xhigh` requires a model that supports it (e.g. Claude Opus 4.7+, Codex `gpt-5.4`).

Codex also supports `max` (maximum reasoning) and `ultra` (maximum reasoning with automatic task delegation). Astra, GPT-5.6 Sol, and GPT-5.6 Terra support both; GPT-5.6 Luna supports `max`. Check the runtime's `model/list` → `supportedReasoningEfforts` for model availability. Both values are forwarded unchanged to `turn/start.effort`, including resumed and plan-mode turns; other AgentBox providers reject them.

### Open-source & custom models (OpenRouter, OSS)

Codex isn't limited to OpenAI models — it can route through any
OpenAI-compatible endpoint (OpenRouter, a local Ollama/LM Studio/vLLM
server, a proxy). Just like the opencode provider lights up OpenRouter
from `OPENROUTER_API_KEY`, the codex provider does too: set the key in the
agent env and pass an OpenRouter model slug.

```ts
const agent = new Agent("codex", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY! },
});

await agent.run({
  model: "openai/gpt-5.3-codex", // any OpenRouter model slug
  input: "Explain the project structure.",
});
```

When `OPENROUTER_API_KEY` is present (and `OPENAI_API_KEY` is not), AgentBox
auto-registers an `openrouter` model provider pointing at
`https://openrouter.ai/api/v1` and selects it. Override the endpoint with
`OPENROUTER_BASE_URL`.

For any other OpenAI-compatible endpoint, declare providers explicitly via
`provider.modelProviders` and pick one with `provider.modelProvider`:

```ts
new Agent("codex", {
  sandbox,
  cwd: "/workspace",
  env: { TOGETHER_API_KEY: process.env.TOGETHER_API_KEY! },
  provider: {
    modelProvider: "together",
    modelProviders: {
      together: {
        name: "Together",
        baseUrl: "https://api.together.xyz/v1",
        envKey: "TOGETHER_API_KEY",
        wireApi: "responses", // codex removed the "chat" wire API
      },
    },
  },
});
```

These are written into Codex's `config.toml` as `[model_providers.*]`
blocks, which the codex app-server reads via `CODEX_HOME`. The model slug
stays a per-run value; the provider is agent-level config. Note that codex
dropped the Chat Completions wire API in early 2026 — providers must speak
the Responses API (`wire_api = "responses"`), which OpenRouter and LM
Studio support; chat-only backends need a responses→chat proxy.

## Sandboxes

Five sandbox providers are supported. Each gives you an isolated environment with the same interface:

| Provider       | What it is             | Auth                                                    |
| -------------- | ---------------------- | ------------------------------------------------------- |
| `local-docker` | Local Docker container | Docker daemon                                           |
| `e2b`          | Cloud micro-VM         | `E2B_API_KEY`                                           |
| `modal`        | Cloud container        | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`                 |
| `daytona`      | Cloud dev environment  | `DAYTONA_API_KEY`                                       |
| `vercel`       | Ephemeral cloud VM     | `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` |

Every sandbox supports: `findOrProvision()`, `run()`, `runAsync()`, `gitClone()`, `uploadAndRun()`, `openPort()`, `getPreviewLink()`, `snapshot()`, `stop()`, `delete()`.

### Provisioning lifecycle

`new Sandbox(...)` only stores configuration — it does **not** create or attach to a real sandbox. Call `findOrProvision()` once when you're ready to start using it, and every subsequent operation (`run`, `gitClone`, `uploadAndRun`, agent runs, …) reuses that sandbox:

```ts
const sandbox = new Sandbox("modal", {
  /* … */
});

await sandbox.findOrProvision(); // attach to existing tagged sandbox or create a fresh one
await sandbox.gitClone({ repoUrl: "…" });
const result = await sandbox.run("pnpm install");
```

Calling a method that needs a live sandbox before `findOrProvision()` throws a clear error. This makes the (potentially slow) attach / create step explicit and lets you control exactly when it happens.

Vercel sandboxes use runtime snapshots instead of pre-built images — call `sandbox.snapshot()` to capture state and pass the returned id via `provider.snapshotId` on the next run.

Vercel also requires ports to be declared at create time via `provider.ports` — `openPort()` is a no-op at runtime, so any port the agent (or your own code) will listen on must be listed up front:

```ts
const sandbox = new Sandbox("vercel", {
  provider: {
    snapshotId: process.env.VERCEL_SNAPSHOT_ID!,
    ports: [4096], // e.g. opencode; codex/claude-code use 43180
  },
});
```

## Skills

Attach GitHub repos as agent skills. They're cloned into the sandbox and surfaced to the agent:

```ts
const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  skills: [
    {
      name: "agent-browser",
      repo: "https://github.com/vercel-labs/agent-browser",
    },
  ],
});
```

You can also embed skills inline:

```ts
skills: [
  {
    source: "embedded",
    name: "lint-fix",
    files: {
      "SKILL.md": "Run `npm run lint:fix` and verify the output is clean.",
    },
  },
],
```

## Sub-agents

Delegate tasks to specialized sub-agents:

```ts
const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  subAgents: [
    {
      name: "reviewer",
      description: "Reviews code for bugs and security issues",
      instructions:
        "Flag bugs, security issues, and missing edge cases. Be concise.",
      tools: ["bash", "read"],
    },
  ],
});
```

## MCP servers

Connect MCP servers to give agents access to external tools:

```ts
const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  mcps: [
    {
      name: "filesystem",
      type: "local",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    },
    {
      name: "my-api",
      type: "remote",
      url: "https://mcp.example.com/sse",
    },
  ],
});
```

## Custom commands

Register slash commands the agent can use:

```ts
const agent = new Agent("open-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  commands: [
    {
      name: "triage",
      description: "Triage a bug report into root cause + fix plan",
      template:
        "Analyze the bug report. Return: root cause, files to change, and tests to add.",
    },
  ],
});
```

## Multimodal input

Pass images and files alongside text:

```ts
import { pathToFileURL } from "node:url";

const result = await agent.run({
  model: "sonnet",
  input: [
    { type: "text", text: "Describe this mockup and suggest improvements." },
    { type: "image", image: pathToFileURL("/workspace/mockup.png") },
  ],
});
```

Provider support: `opencode` (text, images, files), `claude-code` (text, images, PDFs), `codex` (text, images).

## Custom sandbox images

Define your own image when the built-in presets don't cover your needs.

Create `my-image.mjs`:

```js
export default {
  name: "playwright-sandbox",
  base: "node:20-bookworm",
  env: { PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" },
  run: [
    "apt-get update && apt-get install -y git python3 ca-certificates",
    "npm install -g pnpm @anthropic-ai/claude-code",
    "npx playwright install --with-deps chromium",
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
};
```

Build it:

```bash
npx agentbox image build --provider local-docker --file ./my-image.mjs
```

This works with all providers. For cloud providers, the printed value will be that provider's native image reference.

## Hooks

Hooks let you run code at specific points in the agent lifecycle. Each provider has its own hook format:

**Claude Code** — native hook settings:

```ts
new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  provider: {
    hooks: {
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] },
      ],
    },
  },
});
```

**Codex** — similar to Claude Code:

```ts
new Agent("codex", {
  sandbox,
  cwd: "/workspace",
  provider: {
    hooks: {
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] },
      ],
    },
  },
});
```

**OpenCode** — plugin-based hooks:

```ts
new Agent("open-code", {
  sandbox,
  cwd: "/workspace",
  provider: {
    plugins: [
      {
        name: "session-notifier",
        hooks: [{ event: "session.idle", body: 'return "session-idle";' }],
      },
    ],
  },
});
```

## Examples

The [`examples/`](./examples) directory has short, runnable scripts that each demonstrate one feature:

| Example                                                         | What it shows                 |
| --------------------------------------------------------------- | ----------------------------- |
| [`basic.ts`](./examples/basic.ts)                               | Minimal agent + sandbox       |
| [`streaming.ts`](./examples/streaming.ts)                       | Stream and handle events      |
| [`interactive-approval.ts`](./examples/interactive-approval.ts) | Approve tool calls from stdin |
| [`skills.ts`](./examples/skills.ts)                             | Attach a GitHub skill         |
| [`sub-agents.ts`](./examples/sub-agents.ts)                     | Delegate to sub-agents        |
| [`mcp-server.ts`](./examples/mcp-server.ts)                     | Connect an MCP server         |
| [`multimodal.ts`](./examples/multimodal.ts)                     | Send images to the agent      |
| [`custom-image.ts`](./examples/custom-image.ts)                 | Build a custom sandbox image  |
| [`cloud-sandbox.ts`](./examples/cloud-sandbox.ts)               | Use E2B, Modal, or Daytona    |
| [`basic-vercel.ts`](./examples/basic-vercel.ts)                 | Use a Vercel sandbox          |
| [`git-clone.ts`](./examples/git-clone.ts)                       | Clone a repo into the sandbox |

All examples import from `"agentbox-sdk"` like a normal dependency. Run them with:

```bash
npx tsx examples/basic.ts
```

## Package exports

```ts
import { Agent, Sandbox } from "agentbox-sdk"; // main entrypoint
import type { AgentRun } from "agentbox-sdk/agents"; // agent types
import type { CommandResult } from "agentbox-sdk/sandboxes"; // sandbox types
import type { NormalizedAgentEvent } from "agentbox-sdk/events"; // event types
```

## Contributing

```bash
npm install
npm run build
npm run typecheck
npm test
```

`npm run build` generates the `dist/` directory. You need to build before the examples or CLI work locally.

To test your local build from another project:

```bash
npm run build && npm pack
# then in your project:
npm install /path/to/agentbox-sdk-0.1.0.tgz
```

### Tests

```bash
npm test                                              # fast, no real providers
AGENTBOX_RUN_SMOKE_TESTS=1 npm run test:smoke         # live smoke tests
AGENTBOX_RUN_MATRIX_E2E=1 npm run test:e2e:matrix     # provider matrix
```

Live test suites are opt-in because they provision real infrastructure.

## Host execution settings

Use `configuration: "native"` to run a host harness with its own configuration,
built-in prompt, credentials, and repository instructions. AgentBox does not
generate settings, skills, commands, subagents, hooks, plugins, or MCP definitions
in this mode. It cannot be combined with a sandbox or AgentBox-managed skills,
MCPs, commands, subagents, or RTK. Omit `systemPrompt` when starting a turn to keep
the harness's built-in instructions unchanged.

```ts
const agent = new Agent("codex", {
  cwd: "/absolute/path/to/project",
  configuration: "native",
  approvalMode: "interactive",
});
await agent.setup();
```

Start a turn with `agent.stream({ input })`, consume its async event iterator,
and answer permission requests with `run.respondToPermission()`. Await
`run.finished` for the result and call `agent.killServer()` to release the runtime.

The default `configuration: "managed"` retains AgentBox-generated configuration
for host and sandbox execution.

`stateDirectory` selects a private, persistent directory for generated agent
configuration and session state on the host. It must be an absolute path and
cannot be combined with `sandbox`. Use a different directory for each execution
environment to prevent unrelated local jobs from overwriting configuration.
This setting does not copy credentials from the user's account.

With native configuration, Codex uses the user's sandbox and approval settings.
Managed host execution defaults to read-only. An explicit
`provider: { sandboxMode: "workspace-write" }` enables a host write policy;
`writableRoots` adds allowed directories and `networkAccess` enables network
access for that policy (disabled by default). The shared
`approvalMode: "interactive"` routes permission requests to the caller; it does
not itself change the native harness's policy. Cloud sandbox defaults are unchanged.

Host Claude runs the Anthropic SDK with the SDK-matched CLI by default.
`provider.binary` explicitly selects another compatible CLI. Sign-in and session
storage remain CLI-owned. Managed configuration loads generated skills, commands,
and subagents as a private local plugin. Native configuration loads user, project,
and local settings instead. Neither mode copies the CLI's credentials. When
`backgroundTaskTimeoutMs` expires, host Claude stops the leftover background
tasks through the SDK; in a sandbox the daemon lets the CLI wind down on
disconnect, bounded by `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=30000`, which
AgentBox sets in the CLI environment unless `env` already defines it.

Each host OpenCode Agent owns an authenticated loopback server on an ephemeral
port. Managed configuration uses an isolated configuration directory; native
configuration preserves the user's configuration paths. `killServer()` stops
only that Agent's process. It never discovers or kills another server by port number.

All three providers normalize interactive questions into `permission.requested`
events with `kind: "question"`. Respond with `decision: "allow"` and an `answers`
array containing each `questionId` and its selected or custom `values`, or use
`decision: "deny"` to skip. Invalid answers leave the request pending for correction.
Question answers cannot modify unrelated tool arguments. Ordinary tool requests
use the same API without `answers`.

Native runtimes own a POSIX process group by default. Termination is bounded and
escalates to SIGKILL if the process ignores SIGTERM. A supervisor that launches
each run in its own process group can set `processGroup: "inherited"`; that
supervisor is then responsible for stopping the complete group before reporting
that a run has stopped. This option is unavailable for cloud sandboxes.

## Packaging

`npm pack` builds the package from maintained TypeScript source before creating
the archive. Host execution includes the pinned Anthropic SDK and its Zod peer
as runtime dependencies; consumers do not need package-manager extensions.
Run `npm run check` before publishing. Provider integration tests use fake local
CLIs and SDK mocks; live tests remain opt-in.

## License

MIT

For native speed selection, use `provider: { serviceTier: "fast" }` with Codex (or `"default"` for standard speed), and `provider: { fastMode: true }` with Claude Code. Omit these options to inherit harness settings. Availability and usage charges are enforced by the harness.

### Preparing local Codex before a prompt

For an interactive host, `provider: { prewarm: true }` makes `await agent.setup()`
start and initialize the next Codex app-server. It does not create a thread, send
a prompt, or run tools. The next `stream()`/`run()` consumes that prepared process
and stops it normally when the run ends; abort still stops the owned process.
A prepared process that exited while idle is replaced before execution. Call
`await agent.killServer()` to dispose an unused prepared process. Prewarming is
host-only and opt-in. Use a new Agent for a changed cwd, environment, or policy.
