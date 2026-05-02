/**
 * Differential setup cache for agent runtimes — one round-trip edition.
 *
 * Each agent provider (`claude-code`, `codex`, `opencode`) needs to seed a
 * sandbox with a set of files (skills, MCP config, settings, sub-agent
 * definitions, …) and run a set of install commands (`npx skills add ...`)
 * before the model can answer the first prompt.
 *
 * On a fresh sandbox these steps are unavoidable, but on a sandbox that
 * has already been used **none of them have to re-run** — the artifacts on
 * disk are already in the right state. Persisting a tiny manifest at
 * `${runtimeRoot}/setup-manifest.json` lets us short-circuit unchanged
 * artifacts/install commands across runs.
 *
 * What changed: we used to do this diff host-side, which on Modal cost ~25
 * RPCs (~5.8s cold path) just to ferry artifacts back and forth. We now
 * do **the entire diff inside the sandbox**:
 *
 *  1. The host computes target hashes and serializes them as
 *     `setup-target.json`.
 *  2. The host bundles every artifact + `setup-target.json` + a tiny
 *     `install.sh` script into a single tarball.
 *  3. `Sandbox.uploadAndRun(...)` streams the tarball through stdin and
 *     runs `install.sh` — one Modal exec.
 *  4. `install.sh` reads the existing manifest, diffs install commands,
 *     runs only the stale ones in parallel, then atomically replaces the
 *     manifest with `setup-target.json`.
 *
 * Cold path: ~1 RPC + actual install work (~1-1.5s).
 * Warm path: ~1 RPC; the script reads/diffs the manifest and exits without
 *            running installs (~0.7-1s).
 *
 * On top of the diff, providers can short-circuit the entire setup() with
 * {@link preflightSetup}: a single no-upload `sandbox.run` that checks the
 * `setup.id` marker (written by {@link markSetupComplete} after a
 * successful setup) AND, optionally, a daemon liveness probe over loopback.
 * When both match, setup returns without uploading anything.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import type { TarballEntry } from "../../sandboxes/tarball";
import { shellQuote } from "../../shared/shell";
import type { SetupTarget, TextArtifact } from "./types";
import { debugSetup, time } from "../../shared/debug";

const MANIFEST_FILENAME = "setup-manifest.json";
const TARGET_MANIFEST_FILENAME = "setup-target.json";
const INSTALL_SCRIPT_FILENAME = "install.sh";
const SETUP_ID_FILENAME = "setup.id";
const MANIFEST_VERSION = 1;

interface SetupManifest {
  version: number;
  artifacts: Record<string, string>;
  installCommands: Record<string, string>;
}

/**
 * Liveness expectation for {@link preflightSetup}. The preflight script
 * curls `http://127.0.0.1:<port><healthPath>` over loopback inside the
 * sandbox; when {@link expectedVersionMatch} is set, the response body
 * must contain that substring (used by claude-code to detect a stale
 * daemon at the wrong protocol version).
 */
export interface PreflightDaemon {
  port: number;
  healthPath: string;
  expectedVersionMatch?: string;
}

function hashArtifact(artifact: TextArtifact): string {
  const hasher = createHash("sha256");
  hasher.update(artifact.executable ? "1" : "0");
  hasher.update("\0");
  hasher.update(artifact.content, "utf8");
  return hasher.digest("hex");
}

function hashCommand(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

function computeTargetArtifacts(
  artifacts: TextArtifact[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const artifact of artifacts) {
    result[artifact.path] = hashArtifact(artifact);
  }
  return result;
}

/**
 * One stable hash that captures every input to a provider's setup. If
 * the hash matches the `setup.id` marker on disk AND the daemon (if any)
 * is responsive, setup is up-to-date and can be skipped.
 *
 * Providers compute this once at the top of setup() and:
 *   1. Pass it to {@link preflightSetup}; if it returns true, return early.
 *   2. Run their normal setup steps.
 *   3. Pass it to {@link markSetupComplete} once everything succeeded.
 */
export function computeSetupId(
  parts: {
    artifacts?: TextArtifact[];
    installCommands?: string[];
    daemon?: PreflightDaemon;
    /**
     * Anything else that, if changed, requires re-running setup —
     * provider-specific extras like daemon protocol version, login env
     * key presence, etc. Hashed verbatim.
     */
    extras?: string[];
  },
): string {
  const hasher = createHash("sha256");
  hasher.update(`v${MANIFEST_VERSION}\n`);
  for (const a of [...(parts.artifacts ?? [])].sort((x, y) =>
    x.path.localeCompare(y.path),
  )) {
    hasher.update(`a:${a.path}:${hashArtifact(a)}\n`);
  }
  for (const cmd of parts.installCommands ?? []) {
    hasher.update(`c:${hashCommand(cmd)}\n`);
  }
  if (parts.daemon) {
    hasher.update(
      `d:${parts.daemon.port}:${parts.daemon.healthPath}:${parts.daemon.expectedVersionMatch ?? ""}\n`,
    );
  }
  for (const extra of parts.extras ?? []) {
    hasher.update(`x:${extra}\n`);
  }
  return hasher.digest("hex");
}

/**
 * Single no-upload check: does `setup.id` match AND (if a daemon is
 * given) is the daemon serving the expected version on loopback?
 * Returns true iff setup is fully up-to-date and the caller can return
 * from setup() immediately, skipping the upload+install path entirely.
 *
 * Cost: one `target.probe(...)` (no tarball stream). On warm-warm this
 * is a few hundred ms of pure RPC overhead; on cold or drifted state
 * the caller falls through to its normal setup flow.
 */
export async function preflightSetup(
  target: SetupTarget,
  setupId: string,
  daemon?: PreflightDaemon,
): Promise<boolean> {
  return time(
    debugSetup,
    `preflightSetup ${target.provider}`,
    async () => {
      const setupIdFile = path.posix.join(
        target.layout.rootDir,
        SETUP_ID_FILENAME,
      );
      const checks: string[] = [
        `[ -f ${shellQuote(setupIdFile)} ]`,
        `[ "$(cat ${shellQuote(setupIdFile)} 2>/dev/null)" = ${shellQuote(setupId)} ]`,
      ];
      if (daemon) {
        const url = `http://127.0.0.1:${daemon.port}${daemon.healthPath}`;
        if (daemon.expectedVersionMatch) {
          checks.push(
            `curl -fsS --max-time 2 ${shellQuote(url)} 2>/dev/null | grep -q ${shellQuote(daemon.expectedVersionMatch)}`,
          );
        } else {
          checks.push(
            `curl -fsS --max-time 2 ${shellQuote(url)} >/dev/null 2>&1`,
          );
        }
      }
      return target.probe(checks.join(" && "));
    },
    (ok) => ({ ok }),
  );
}

/**
 * Write the `setup.id` warm-path marker. Called by providers at the end
 * of setup(), after every step (artifact upload, install commands,
 * daemon spawn, readiness polling) has succeeded. Subsequent
 * {@link preflightSetup} calls with the same id and a live daemon will
 * short-circuit the rest of setup.
 *
 * If anything before this point fails, the marker is left absent or
 * stale, so the next setup() falls through to the full path.
 */
export async function markSetupComplete(
  target: SetupTarget,
  setupId: string,
): Promise<void> {
  await time(debugSetup, `markSetupComplete ${target.provider}`, () =>
    target.runCommand(
      [
        `mkdir -p ${shellQuote(target.layout.rootDir)}`,
        `printf '%s' ${shellQuote(setupId)} > ${shellQuote(path.posix.join(target.layout.rootDir, SETUP_ID_FILENAME))}`,
      ].join(" && "),
    ),
  );
}

/**
 * Build the in-sandbox install script. It runs after `tar -x` has already
 * dropped every artifact onto disk (those re-extract idempotently — cheap
 * even on warm paths), and is responsible for:
 *
 *   - Reading any previous `setup-manifest.json`.
 *   - Computing which install commands are stale by hash.
 *   - Running stale install commands in parallel.
 *   - Atomically replacing the manifest with `setup-target.json`.
 *
 * We use a single python3 invocation for JSON parsing + diff — python is
 * available on every sandbox image agentbox supports today, avoiding a
 * dependency on `jq` which isn't always present in stripped images.
 */
function buildInstallScript(
  rootDir: string,
  installCommandsByKey: Record<string, string>,
): string {
  // Embed the commands map as base64 inside the script so multi-line and
  // shell-special command strings never need shell escaping. Python loads
  // it via env var.
  const commandsB64 = Buffer.from(
    JSON.stringify(installCommandsByKey),
    "utf8",
  ).toString("base64");

  return `#!/usr/bin/env bash
set -e
ROOT_DIR=${shellQuote(rootDir)}
TARGET_MANIFEST="$ROOT_DIR/${TARGET_MANIFEST_FILENAME}"
EXISTING_MANIFEST="$ROOT_DIR/${MANIFEST_FILENAME}"
export TARGET_MANIFEST EXISTING_MANIFEST

# Compute stale commands: any command whose hash in the target manifest
# differs from (or is missing in) the existing manifest. The python block
# emits the commands themselves, NUL-separated, so bash never has to
# deserialize JSON.
STALE_CMDS_FILE="$(mktemp)"
trap 'rm -f "$STALE_CMDS_FILE"' EXIT
COMMANDS_B64=${shellQuote(commandsB64)} \\
MANIFEST_VERSION=${MANIFEST_VERSION} \\
python3 - <<'PY' > "$STALE_CMDS_FILE"
import base64, json, os, sys
with open(os.environ["TARGET_MANIFEST"], "r", encoding="utf-8") as fh:
    target = json.load(fh)
existing = {}
try:
    with open(os.environ["EXISTING_MANIFEST"], "r", encoding="utf-8") as fh:
        existing = json.load(fh)
except FileNotFoundError:
    pass
expected_version = int(os.environ["MANIFEST_VERSION"])
target_cmds = target.get("installCommands", {})
existing_cmds = (
    existing.get("installCommands", {})
    if existing.get("version") == expected_version
    else {}
)
commands = json.loads(base64.b64decode(os.environ["COMMANDS_B64"]))
stale = [
    commands[key]
    for key, hashed in target_cmds.items()
    if commands.get(key) is not None and existing_cmds.get(key) != hashed
]
sys.stdout.write("\\0".join(stale))
PY

if [ -s "$STALE_CMDS_FILE" ]; then
  while IFS= read -r -d '' CMD; do
    [ -z "$CMD" ] && continue
    bash -c "$CMD" &
  done < "$STALE_CMDS_FILE"
  wait
fi

# Persist target manifest as the new manifest atomically. Doing this last
# means an interrupted install run doesn't poison the cache for next time.
mv "$TARGET_MANIFEST" "$EXISTING_MANIFEST"
`;
}

/**
 * Apply artifact writes and install commands using a single sandbox RPC.
 *
 * Bundles every artifact + the target manifest + the install script into
 * one tarball, ships it through `Sandbox.uploadAndRun`, and lets the
 * sandbox do the manifest diff / parallel installs locally. The manifest
 * is atomically rotated only after installs succeed.
 */
export async function applyDifferentialSetup(
  target: SetupTarget,
  artifacts: TextArtifact[],
  installCommands: string[],
): Promise<void> {
  await time(
    debugSetup,
    `applyDifferentialSetup ${target.provider}`,
    async () => {
      // Map command -> opaque key so the install script can refer to
      // commands by id without shell-escaping issues.
      const installCommandsByKey: Record<string, string> = {};
      for (let i = 0; i < installCommands.length; i++) {
        installCommandsByKey[`cmd${i}`] = installCommands[i]!;
      }

      const targetForSandbox: SetupManifest = {
        version: MANIFEST_VERSION,
        artifacts: computeTargetArtifacts(artifacts),
        installCommands: Object.fromEntries(
          Object.entries(installCommandsByKey).map(([key, command]) => [
            key,
            hashCommand(command),
          ]),
        ),
      };

      const rootDir = target.layout.rootDir;
      const tarballEntries: TarballEntry[] = [
        ...artifacts.map<TarballEntry>((artifact) => ({
          path: artifact.path,
          content: artifact.content,
          mode: artifact.executable ? 0o755 : 0o644,
        })),
        {
          path: path.posix.join(rootDir, TARGET_MANIFEST_FILENAME),
          content: JSON.stringify(targetForSandbox),
          mode: 0o644,
        },
        {
          path: path.posix.join(rootDir, INSTALL_SCRIPT_FILENAME),
          content: buildInstallScript(rootDir, installCommandsByKey),
          mode: 0o755,
        },
      ];

      // Sandbox does its own manifest diff inside install.sh — no host-side
      // round-trip to fetch the existing manifest.
      await target.uploadAndRun(
        tarballEntries,
        `bash ${shellQuote(path.posix.join(rootDir, INSTALL_SCRIPT_FILENAME))}`,
      );
    },
    () => ({
      artifacts: artifacts.length,
      installCommands: installCommands.length,
    }),
  );
}
