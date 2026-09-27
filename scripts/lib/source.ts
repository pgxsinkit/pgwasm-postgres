/**
 * The build's source: the tree `patches:check` proves (the pinned tag + the series + the overlay), checked out
 * into a plain directory, and each extension of `extensions.json` checked out at its commit where the source
 * had its gitlink. This is what ElectricSQL's CI built: `actions/checkout` of `b133782` with its submodules.
 *
 * - No `.git` anywhere. On CI the checkout's `.git` files pointed outside the directory the builder mounted,
 *   so the build saw no repository (postgis's `repo_revision.pl` then records revision 0).
 * - Checked out by git itself (`read-tree` + `checkout-index`), so `.gitattributes` apply exactly as they did
 *   on CI (`git archive` would honour `export-ignore` and drop files pgtap and pgmq need).
 * - Under umask 022, as on GitHub-hosted runners: files 0644 or 0755, directories 0755.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { checkSeries, type Log } from "./commands.ts";
import { readExtensions, type ExtensionPin } from "./config.ts";
import { cacheEnv, git, UserError, writeCacheGitConfig, type GitOptions, type RunResult } from "./git.ts";
import type { Layout } from "./layout.ts";

export interface MaterialisedSource {
  readonly directory: string;
  /** The tree `patches:check` wrote and proved. */
  readonly tree: string;
  readonly extensions: readonly ExtensionPin[];
}

/** The umask CI checked out under. */
export const CHECKOUT_UMASK = 0o022;

/**
 * Checks out a tree-ish of a (bare) repository into `destination`, which must not exist yet. A throwaway index
 * holds the tree; nothing of git's is left in `destination`.
 */
export function checkoutTree(layout: Layout, gitDir: string, treeish: string, destination: string): void {
  if (existsSync(destination)) throw new Error(`checkoutTree: ${destination} already exists.`);
  mkdirSync(destination, { recursive: true });
  const index = join(layout.cacheDir, `index-${process.pid}-${Date.now().toString(36)}`);
  const env = { ...cacheEnv(layout), GIT_INDEX_FILE: index };
  try {
    git([`--git-dir=${gitDir}`, "read-tree", treeish], { cwd: layout.root, env });
    git([`--git-dir=${gitDir}`, `--work-tree=${destination}`, "checkout-index", "--all", "--force"], {
      cwd: destination,
      env,
    });
  } finally {
    rmSync(index, { force: true });
  }
}

function extensionsGit(
  layout: Layout,
  args: readonly string[],
  options: Pick<GitOptions, "allowFailure"> = {},
): RunResult {
  return git([`--git-dir=${layout.extensionsCache}`, ...args], { ...options, cwd: layout.root, env: cacheEnv(layout) });
}

function hasCommit(layout: Layout, commit: string): boolean {
  return extensionsGit(layout, ["cat-file", "-e", `${commit}^{commit}`], { allowFailure: true }).exitCode === 0;
}

/**
 * Makes an extension's pinned commit available in the extensions cache (a bare, shallow clone shared by all of
 * them), fetching only that commit, and only when the cache does not have it yet.
 */
export function fetchExtension(layout: Layout, extension: ExtensionPin, log: Log): void {
  mkdirSync(layout.cacheDir, { recursive: true });
  writeCacheGitConfig(layout);
  if (!existsSync(layout.extensionsCache)) {
    git(["init", "--quiet", "--bare", layout.extensionsCache], { cwd: layout.root, env: cacheEnv(layout) });
  }
  if (hasCommit(layout, extension.commit)) return;

  log(`Fetching ${extension.path} at ${extension.commit} from ${extension.url} (shallow; later runs reuse it)`);
  const ref = `refs/extensions/${extension.path}`;
  const fetch = extensionsGit(
    layout,
    ["fetch", "--quiet", "--depth", "1", "--no-tags", extension.url, `+${extension.commit}:${ref}`],
    { allowFailure: true },
  );
  if (fetch.exitCode !== 0 || !hasCommit(layout, extension.commit)) {
    throw new UserError(
      [
        `Could not fetch ${extension.commit} (${extension.path}) from ${extension.url}:`,
        ...`${fetch.stderr}${fetch.stdout}`
          .trim()
          .split("\n")
          .map((line) => `  ${line}`),
        "The commit must still be reachable upstream; if it is gone, the extension needs a new source (extensions.json).",
      ].join("\n"),
    );
  }
}

/**
 * Proves the series (`checkSeries`: apply, round-trip export, tree identity), then checks the proven tree and the
 * extensions out into `destination`, which must not exist yet.
 */
export function materialiseSource(layout: Layout, destination: string, log: Log): MaterialisedSource {
  if (existsSync(destination)) throw new UserError(`${relative(layout.root, destination)} already exists.`);
  const extensions = readExtensions(layout) ?? [];
  const previous = process.umask(CHECKOUT_UMASK);
  try {
    const { tree } = checkSeries(layout, log);
    for (const extension of extensions) fetchExtension(layout, extension, log);

    checkoutTree(layout, layout.cacheRepo, tree, destination);
    for (const extension of extensions) {
      const target = join(destination, extension.path);
      if (existsSync(target)) {
        throw new UserError(
          `${extension.path} (extensions.json) already exists in the tree; an extension must replace a gitlink the tree lacks.`,
        );
      }
      checkoutTree(layout, layout.extensionsCache, extension.commit, target);
    }
    log(
      `source: ${relative(layout.root, destination)}: tree ${tree} and ${extensions.length} extensions at their pinned commits, no .git.`,
    );
    return { directory: destination, tree, extensions };
  } finally {
    process.umask(previous);
  }
}
