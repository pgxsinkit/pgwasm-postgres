import { writeFileSync } from "node:fs";

import type { Layout } from "./layout.ts";

/** An expected failure: the message is the whole report, printed without a stack trace. */
export class UserError extends Error {
  override name = "UserError";
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class CommandError extends Error {
  override name = "CommandError";
  readonly result: RunResult;

  constructor(command: readonly string[], cwd: string, result: RunResult) {
    const output = (result.stderr.trim() || result.stdout.trim()).split("\n").map((line) => `  ${line}`);
    super([`\`${command.join(" ")}\` (in ${cwd}) exited with ${result.exitCode}`, ...output].join("\n"));
    this.result = result;
  }
}

export interface GitOptions {
  readonly cwd: string;
  /** Added on top of the sanitised environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  /** Return a failing result instead of throwing. */
  readonly allowFailure?: boolean;
}

/**
 * The process environment without any `GIT_*` variable. A git hook exports `GIT_INDEX_FILE` (and sometimes
 * `GIT_DIR`); inherited, they would point commands aimed at the upstream cache at this repository's index.
 */
function sanitisedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

export function git(args: readonly string[], options: GitOptions): RunResult {
  const command = ["git", ...args];
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: { ...sanitisedEnv(), ...options.env },
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const result: RunResult = {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
  if (result.exitCode !== 0 && options.allowFailure !== true) throw new CommandError(command, options.cwd, result);
  return result;
}

/** The committer recorded on commits `git am` makes in the cache. `patches/` never contains it. */
export const CACHE_COMMITTER = { name: "pgwasm-postgres", email: "patches@pgwasm-postgres.invalid" } as const;

/**
 * The config every command against the upstream cache runs with, in place of the user's global and system
 * config: `format-patch` output, `git am` behaviour and checkouts then depend only on the git version.
 */
const CACHE_GIT_CONFIG = `# Written by pgwasm-postgres's scripts (scripts/lib/git.ts); regenerated on every run.
[core]
\tautocrlf = false
[advice]
\tdetachedHead = false
[init]
\tdefaultBranch = main
[gc]
\tauto = 0
[maintenance]
\tauto = false
`;

export function writeCacheGitConfig(layout: Layout): void {
  writeFileSync(layout.cacheGitConfig, CACHE_GIT_CONFIG);
}

/** Environment for commands against the upstream cache and its worktrees. */
export function cacheEnv(layout: Layout): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: layout.cacheGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_COMMITTER_NAME: CACHE_COMMITTER.name,
    GIT_COMMITTER_EMAIL: CACHE_COMMITTER.email,
    // Stable, untranslated messages: failures are parsed and reported.
    LC_ALL: "C",
    LANGUAGE: "C",
  };
}

/** `git --git-dir=<cache>`: the bare cache is never discovered implicitly (`safe.bareRepository` may forbid it). */
export function gitCache(
  layout: Layout,
  args: readonly string[],
  options: Omit<GitOptions, "cwd" | "env"> = {},
): RunResult {
  return git([`--git-dir=${layout.cacheRepo}`, ...args], { ...options, cwd: layout.root, env: cacheEnv(layout) });
}

/** A command inside a worktree of the cache. */
export function gitTree(
  layout: Layout,
  worktree: string,
  args: readonly string[],
  options: Omit<GitOptions, "cwd" | "env"> = {},
): RunResult {
  return git(args, { ...options, cwd: worktree, env: cacheEnv(layout) });
}
