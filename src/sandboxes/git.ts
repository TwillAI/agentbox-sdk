import type { GitCloneOptions } from "./types";
import { shellQuote } from "../shared/shell";

function encodeExtraHeader(name: string, value: string): string {
  return `http.extraHeader=${name}: ${value}`;
}

export function buildGitCloneCommand(options: GitCloneOptions): string {
  const targetDir = options.targetDir ?? ".";
  const cloneArgs: string[] = [];

  if (options.depth) {
    cloneArgs.push("--depth", String(options.depth));
  }

  if (options.branch) {
    cloneArgs.push("--branch", options.branch, "--single-branch");
  }

  const configArgs: string[] = [];
  if (options.token) {
    configArgs.push(
      "-c",
      encodeExtraHeader("Authorization", `Bearer ${options.token}`),
    );
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    configArgs.push("-c", encodeExtraHeader(name, value));
  }

  const command = [
    "git",
    ...configArgs.map(shellQuote),
    "clone",
    ...cloneArgs.map(shellQuote),
    shellQuote(options.repoUrl),
    shellQuote(targetDir),
  ].join(" ");

  if (targetDir === ".") {
    return command;
  }
  return `mkdir -p ${shellQuote(targetDir)} && rm -rf ${shellQuote(targetDir)} && ${command}`;
}
