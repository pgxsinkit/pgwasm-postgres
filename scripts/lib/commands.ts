import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { isValidTag, readExtensionPaths, readIdentities, readUpstreamPin } from "./config.ts";
import { gitCache, gitTree, UserError } from "./git.ts";
import type { Layout } from "./layout.ts";
import { copyOverlay, listOverlay, stageOverlay, type OverlayEntry } from "./overlay.ts";
import { applySeries, comparePatchDirs, describeAmFailure, formatSeries, listPatches } from "./series.ts";
import { addWorktree, removeWorktree, resolveTag } from "./upstream.ts";

export type Log = (line: string) => void;

function scratchDir(layout: Layout, purpose: string): string {
  return join(layout.cacheDir, `${purpose}-${process.pid}-${Date.now().toString(36)}`);
}

/** Paths the patched tree already has that the overlay would overwrite: overlay files must be new files. */
function overlayCollisions(layout: Layout, worktree: string, overlay: readonly OverlayEntry[]): string[] {
  if (overlay.length === 0) return [];
  const tracked = new Set(
    gitTree(layout, worktree, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])
      .stdout.split("\0")
      .filter((path) => path !== ""),
  );
  return overlay.filter((entry) => tracked.has(entry.path)).map((entry) => entry.path);
}

function collisionError(paths: readonly string[], where: string): UserError {
  return new UserError(
    [
      `These overlay paths already exist in ${where}:`,
      ...paths.map((path) => `  ${path}`),
      "The overlay only adds files. Change an upstream file with a patch, and keep patches off overlay paths.",
    ].join("\n"),
  );
}

export interface CheckResult {
  readonly tree: string;
  readonly patches: readonly string[];
}

/**
 * `patches:check`: pinned tag + `git am --3way` of every patch + the overlay, then `git write-tree`. Proves
 * the export is round-trip stable (re-exporting the applied commits reproduces `patches/` byte for byte)
 * and, while identity records exist, that the tree equals the recorded one.
 */
export function checkSeries(layout: Layout, log: Log): CheckResult {
  const pin = readUpstreamPin(layout);
  const patches = listPatches(layout.patchesDir);
  const overlay = listOverlay(layout.overlayDir);
  const identities = readIdentities(layout);
  for (const identity of identities) {
    if (identity.upstreamCommit !== pin.commit || identity.upstreamTag !== pin.tag) {
      throw new UserError(
        [
          `${identity.file} records the split of ${identity.upstreamTag} (${identity.upstreamCommit}),`,
          `but upstream.json pins ${pin.tag} (${pin.commit}).`,
          "Tree identity only holds on the base it was derived for; retire the record before moving the pin.",
        ].join("\n"),
      );
    }
  }

  const extensionPaths = readExtensionPaths(layout);
  if (extensionPaths !== undefined) {
    const manifested = [".gitmodules", ...extensionPaths].sort();
    for (const identity of identities) {
      const excluded = [...identity.excludedPaths].sort();
      if (excluded.join("\n") !== manifested.join("\n")) {
        throw new UserError(
          [
            `${identity.file} excludes ${excluded.join(", ")},`,
            `but extensions.json replaces ${manifested.join(", ")}.`,
            "The manifest must stand in for exactly the paths tree identity leaves out.",
          ].join("\n"),
        );
      }
    }
  }

  const base = resolveTag(layout, pin, log);
  const worktree = scratchDir(layout, "check");
  const exportDir = `${worktree}-export`;
  addWorktree(layout, worktree, base);
  try {
    const failure = applySeries(layout, worktree, patches);
    if (failure !== undefined) {
      throw new UserError(["patches:check failed.", ...describeAmFailure(failure, `${pin.tag} (${base})`)].join("\n"));
    }

    const collisions = overlayCollisions(layout, worktree, overlay);
    if (collisions.length > 0) throw collisionError(collisions, `${pin.tag} with the series applied`);

    formatSeries(layout, worktree, base, exportDir);
    const drift = comparePatchDirs(layout.patchesDir, exportDir);
    if (drift.length > 0) {
      throw new UserError(
        [
          "patches/ is not round-trip stable: re-exporting the applied commits does not reproduce it.",
          ...drift.map((line) => `  ${line}`),
          "Regenerate it with `bun run patches:work` and `bun run patches:export`; never edit a patch file by hand.",
        ].join("\n"),
      );
    }

    copyOverlay(layout.overlayDir, overlay, worktree);
    stageOverlay(layout, worktree, overlay);
    const tree = gitTree(layout, worktree, ["write-tree"]).stdout.trim();

    for (const identity of identities) {
      if (tree !== identity.expectedTree) {
        const known = gitCache(layout, ["cat-file", "-e", `${identity.expectedTree}^{tree}`], { allowFailure: true });
        const detail =
          known.exitCode === 0
            ? gitCache(layout, ["diff-tree", "-r", "--name-status", identity.expectedTree, tree])
                .stdout.trimEnd()
                .split("\n")
            : [
                `To see the difference, fetch ${identity.sourceCommit} from ${identity.sourceRepository} into the cache`,
                `(git --git-dir=${relative(layout.root, layout.cacheRepo)} fetch --depth 1 ${identity.sourceRepository} ${identity.sourceCommit})`,
                "and run this check again.",
              ];
        throw new UserError(
          [
            `Tree identity failed (${identity.file}):`,
            `  expected ${identity.expectedTree} (${identity.sourceCommit} without ${identity.excludedPaths.join(", ")})`,
            `  actual   ${tree} (${pin.tag} + ${patches.length} patches + ${overlay.length} overlay files)`,
            ...detail.map((line) => `  ${line}`),
          ].join("\n"),
        );
      }
    }

    log(`patches:check: ${patches.length} patches apply on ${pin.tag} (${base}); ${overlay.length} overlay files.`);
    log(`patches:check: export is round-trip stable (${patches.length} files byte-identical).`);
    log(`patches:check: tree ${tree}.`);
    for (const identity of identities) {
      log(
        `patches:check: tree identity holds (${identity.file}: ${identity.sourceCommit} without the excluded paths).`,
      );
    }
    return { tree, patches };
  } finally {
    removeWorktree(layout, worktree);
    rmSync(exportDir, { recursive: true, force: true });
  }
}

/**
 * The worktree's tag and base commit. For a tag other than the pinned one, the pinned tag is fetched too:
 * `git am --3way` falls back on the blobs the patches were cut against, which only the pinned tag has.
 */
function resolveWorkTag(
  layout: Layout,
  tag: string | undefined,
  log: Log,
): { tag: string; base: string; pinnedTag: string } {
  const pin = readUpstreamPin(layout);
  const chosen = tag ?? pin.tag;
  if (!isValidTag(chosen)) throw new UserError(`${JSON.stringify(chosen)} is not a valid tag name.`);
  const pinned = resolveTag(layout, pin, log);
  const base = chosen === pin.tag ? pinned : resolveTag(layout, { repository: pin.repository, tag: chosen }, log);
  return { tag: chosen, base, pinnedTag: pin.tag };
}

/** Git's info/exclude for the cache: keeps the overlay copies out of `git status` and `git add -A` in worktrees. */
function writeOverlayExcludes(layout: Layout, overlay: readonly OverlayEntry[]): void {
  const lines = [
    "# Written by `bun run patches:work`: the overlay is copied into worktrees but never committed there.",
    "# Edit overlay files in pgwasm-postgres's overlay/ directory instead.",
    ...overlay.map((entry) => `/${entry.path.replace(/([*?[\\])/g, "\\$1")}`),
    "",
  ];
  mkdirSync(join(layout.cacheRepo, "info"), { recursive: true });
  writeFileSync(join(layout.cacheRepo, "info", "exclude"), lines.join("\n"));
}

export function workPath(layout: Layout, tag: string): string {
  return join(layout.workDir, tag);
}

export interface WorkOptions {
  /** Replace an existing worktree for the tag (its uncommitted and unexported work is lost). */
  readonly force?: boolean;
}

/**
 * `patches:work <tag>`: a worktree at `work/<tag>` on branch `work/<tag>`, with the series applied as
 * commits on top of the tag and the overlay copied in (uncommitted, excluded from git status).
 */
export function workSeries(layout: Layout, tag: string | undefined, options: WorkOptions, log: Log): string {
  const { tag: chosen, base, pinnedTag } = resolveWorkTag(layout, tag, log);
  const patches = listPatches(layout.patchesDir);
  const overlay = listOverlay(layout.overlayDir);
  const worktree = workPath(layout, chosen);

  if (existsSync(worktree)) {
    if (options.force !== true) {
      throw new UserError(
        [
          `${relative(layout.root, worktree)} already exists.`,
          `Export it first (\`bun run patches:export ${chosen}\`), or recreate it with \`bun run patches:work ${chosen} --force\``,
          "(which discards its commits and changes).",
        ].join("\n"),
      );
    }
    removeWorktree(layout, worktree);
  }
  mkdirSync(layout.workDir, { recursive: true });
  addWorktree(layout, worktree, base, `work/${chosen}`);
  writeOverlayExcludes(layout, overlay);
  copyOverlay(layout.overlayDir, overlay, worktree);

  const failure = applySeries(layout, worktree, patches);
  const where = relative(layout.root, worktree);
  if (failure !== undefined) {
    throw new UserError(
      [
        ...describeAmFailure(failure, `${chosen} (${base})`),
        `The worktree is left mid-\`git am\` at ${where}. Resolve the conflicts there, \`git add\` the files and run`,
        `\`git am --continue\` (again for each later patch that stops), then \`bun run patches:export ${chosen}\`.`,
      ].join("\n"),
    );
  }
  const collisions = overlayCollisions(layout, worktree, overlay);
  if (collisions.length > 0) throw collisionError(collisions, `${chosen} with the series applied`);

  log(`patches:work: ${where} is on branch work/${chosen}: ${chosen} (${base}) + ${patches.length} commits.`);
  log(`patches:work: the ${overlay.length} overlay files are copied in, uncommitted (edit them under overlay/).`);
  log(
    `patches:work: edit, commit or \`git rebase -i ${chosen}\` there, then run \`bun run patches:export ${chosen}\`.`,
  );
  if (chosen !== pinnedTag) {
    log(
      `patches:work: upstream.json pins ${pinnedTag}; set its tag and commit to ${chosen} (${base}) before exporting.`,
    );
  }
  return worktree;
}

/** `patches:export [tag]`: writes `work/<tag>`'s commits back to `patches/`, deterministically. */
export function exportSeries(layout: Layout, tag: string | undefined, log: Log): string[] {
  const pin = readUpstreamPin(layout);
  const chosen = tag ?? pin.tag;
  if (!isValidTag(chosen)) throw new UserError(`${JSON.stringify(chosen)} is not a valid tag name.`);
  if (chosen !== pin.tag) {
    throw new UserError(
      [
        `upstream.json pins ${pin.tag}, not ${chosen}: patches/ must apply on the pinned tag.`,
        `To move the pin, set upstream.json's tag and commit to ${chosen}'s first, then export.`,
      ].join("\n"),
    );
  }
  const worktree = workPath(layout, chosen);
  const where = relative(layout.root, worktree);
  if (!existsSync(worktree)) {
    throw new UserError(`${where} does not exist; create it with \`bun run patches:work ${chosen}\`.`);
  }

  const inProgress = ["rebase-apply", "rebase-merge", "MERGE_HEAD", "CHERRY_PICK_HEAD"].filter((name) => {
    const path = gitTree(layout, worktree, ["rev-parse", "--git-path", name]).stdout.trim();
    return existsSync(path.startsWith("/") ? path : join(worktree, path));
  });
  if (inProgress.length > 0) {
    throw new UserError(`${where} has an operation in progress (${inProgress.join(", ")}); finish or abort it first.`);
  }
  const dirty = gitTree(layout, worktree, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (dirty !== "") {
    throw new UserError(
      [
        `${where} has uncommitted changes to tracked files; commit or discard them first:`,
        ...dirty.split("\n").map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  const overlay = listOverlay(layout.overlayDir);
  const collisions = overlayCollisions(layout, worktree, overlay);
  if (collisions.length > 0) throw collisionError(collisions, `${where}'s HEAD`);

  const base = resolveTag(layout, pin, log);
  const staging = scratchDir(layout, "export");
  try {
    const written = formatSeries(layout, worktree, base, staging);
    const changes = comparePatchDirs(layout.patchesDir, staging);
    if (changes.length === 0) {
      log(`patches:export: patches/ already matches ${where} (${written.length} patches).`);
      return written;
    }
    mkdirSync(layout.patchesDir, { recursive: true });
    for (const name of readdirSync(layout.patchesDir)) {
      if (name.endsWith(".patch")) rmSync(join(layout.patchesDir, name));
    }
    for (const name of written) copyFileSync(join(staging, name), join(layout.patchesDir, name));
    log(`patches:export: wrote ${written.length} patches from ${where}:`);
    for (const change of changes) log(`  ${change}`);
    log("patches:export: run `bun run patches:check` to prove the new series.");
    return written;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
