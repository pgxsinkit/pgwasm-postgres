import { existsSync, mkdirSync, rmSync } from "node:fs";

import { gitCache, UserError, writeCacheGitConfig } from "./git.ts";
import type { Layout } from "./layout.ts";

export interface TagRequest {
  readonly repository: string;
  readonly tag: string;
  /** When given, the tag must resolve to exactly this commit. */
  readonly commit?: string;
}

/** Creates the bare cache clone on first use and (re)writes its isolated git config. */
export function ensureCache(layout: Layout): void {
  mkdirSync(layout.cacheDir, { recursive: true });
  writeCacheGitConfig(layout);
  if (!existsSync(layout.cacheRepo)) {
    gitCache(layout, ["init", "--quiet", "--bare"]);
  }
}

function localTagCommit(layout: Layout, tag: string): string | undefined {
  const result = gitCache(layout, ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}^{commit}`], {
    allowFailure: true,
  });
  const commit = result.stdout.trim();
  return result.exitCode === 0 && commit !== "" ? commit : undefined;
}

/**
 * Resolves an upstream tag to its commit, fetching it (shallow) into the cache only when the cache does not
 * already hold it at the expected commit. The first run needs the network; later runs do not.
 */
export function resolveTag(layout: Layout, request: TagRequest, log: (line: string) => void): string {
  ensureCache(layout);
  const cached = localTagCommit(layout, request.tag);
  if (cached !== undefined && (request.commit === undefined || cached === request.commit)) return cached;

  log(`Fetching ${request.tag} from ${request.repository} into ${layout.cacheRepo} (shallow; later runs reuse it)`);
  const fetch = gitCache(
    layout,
    [
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "--no-tags",
      request.repository,
      `+refs/tags/${request.tag}:refs/tags/${request.tag}`,
    ],
    { allowFailure: true },
  );
  if (fetch.exitCode !== 0) {
    throw new UserError(
      [
        `Could not fetch tag ${request.tag} from ${request.repository}:`,
        ...fetch.stderr
          .trim()
          .split("\n")
          .map((line) => `  ${line}`),
      ].join("\n"),
    );
  }

  const fetched = localTagCommit(layout, request.tag);
  if (fetched === undefined) {
    throw new UserError(`Fetched ${request.tag} from ${request.repository}, but it does not resolve to a commit.`);
  }
  if (request.commit !== undefined && fetched !== request.commit) {
    throw new UserError(
      [
        `Upstream tag ${request.tag} resolves to ${fetched}, but upstream.json pins ${request.commit}.`,
        "Either the tag moved upstream (investigate before trusting it) or the pin is wrong.",
      ].join("\n"),
    );
  }
  return fetched;
}

/** Adds a worktree of the cache at `path`, on a fresh branch when `branch` is given, detached otherwise. */
export function addWorktree(layout: Layout, path: string, commit: string, branch?: string): void {
  const placement = branch === undefined ? ["--detach"] : ["-B", branch];
  gitCache(layout, ["worktree", "add", "--quiet", ...placement, path, commit]);
}

/** Removes a worktree of the cache, and its administrative files, whatever state it is in. */
export function removeWorktree(layout: Layout, path: string): void {
  gitCache(layout, ["worktree", "remove", "--force", "--force", path], { allowFailure: true });
  rmSync(path, { recursive: true, force: true });
  gitCache(layout, ["worktree", "prune"], { allowFailure: true });
}
