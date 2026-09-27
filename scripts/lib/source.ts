/**
 * The build's source: the tree `patches:check` proves (the pinned tag + the series + the overlay), checked out
 * into a plain directory with no `.git`, by git itself (`read-tree` + `checkout-index`, so `.gitattributes` apply
 * as on a checkout), under umask 022: files 0644 or 0755, directories 0755.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { checkSeries, type Log } from "./commands.ts";
import { cacheEnv, git, UserError } from "./git.ts";
import type { Layout } from "./layout.ts";

export interface MaterialisedSource {
  readonly directory: string;
  /** The tree `patches:check` wrote and proved. */
  readonly tree: string;
}

/** The umask the source is checked out under. */
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

/**
 * Proves the series (`checkSeries`: apply, round-trip export), then checks the proven tree out into
 * `destination`, which must not exist yet.
 */
export function materialiseSource(layout: Layout, destination: string, log: Log): MaterialisedSource {
  if (existsSync(destination)) throw new UserError(`${relative(layout.root, destination)} already exists.`);
  const previous = process.umask(CHECKOUT_UMASK);
  try {
    const { tree } = checkSeries(layout, log);
    checkoutTree(layout, layout.cacheRepo, tree, destination);
    log(`source: ${relative(layout.root, destination)}: tree ${tree}, no .git.`);
    return { directory: destination, tree };
  } finally {
    process.umask(previous);
  }
}
