/**
 * The bump (ADR-0001 decision 7): moving the pin to a newer upstream release of the pinned major. `bun run bump`
 * refuses what a bump is not, applies the series onto the new tag with `git am --3way` (as `patches:work` does),
 * and, on a clean apply, re-exports `patches/`, moves `upstream.json`, proves the series with `patches:check` and
 * commits; then the engine gate runs and the report says what it found. This module holds the refusals and the git
 * work in the upstream cache; the report is `bump-report.ts`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { ApplyLog } from "./bump-report.ts";
import { collisionError, overlayCollisions, scratchDir } from "./commands.ts";
import { readJson, type UpstreamPin } from "./config.ts";
import { cacheEnv, git, gitCache, gitTree, UserError } from "./git.ts";
import { followRange, invertHunks, oldRange, parseDiffHunks, type Hunk, type LineRange } from "./hunks.ts";
import type { Layout } from "./layout.ts";
import { listOverlay } from "./overlay.ts";
import { applyEach, formatSeries, listPatches, type AmFailure, type PatchApplied } from "./series.ts";
import { addWorktree, removeWorktree } from "./upstream.ts";

/** An upstream tag's major and minor: `REL_18_6` is 18 and 6; `REL_19_BETA4` is 19 and no minor. */
export interface UpstreamTag {
  readonly tag: string;
  readonly major: number;
  /** undefined for a beta or a release candidate. */
  readonly minor: number | undefined;
}

const UPSTREAM_TAG = /^REL_(\d+)_([A-Za-z0-9]+)$/;

export function parseUpstreamTag(tag: string): UpstreamTag | undefined {
  const match = UPSTREAM_TAG.exec(tag);
  if (match === null) return undefined;
  const minor = /^\d+$/.test(match[2] ?? "") ? Number(match[2]) : undefined;
  return { tag, major: Number(match[1]), minor };
}

/**
 * Why `tag` cannot be bumped to from the pinned `pinTag`; empty when it can. A bump moves to a newer release of
 * the pinned major: another major (a release, a beta or a release candidate) is adopted deliberately, through a
 * `port-<major>` branch (decision 8), never by a bump.
 */
export function bumpTagProblems(pinTag: string, tag: string): string[] {
  const pin = parseUpstreamTag(pinTag);
  if (pin === undefined || pin.minor === undefined) {
    return [`upstream.json pins ${pinTag}, which is not an upstream release tag (REL_<major>_<minor>).`];
  }
  const target = parseUpstreamTag(tag);
  if (target === undefined) {
    return [`${JSON.stringify(tag)} is not an upstream tag of the form REL_<major>_<minor> (\`REL_${pin.major}_7\`).`];
  }
  if (target.major !== pin.major) {
    return [
      `${tag} is PostgreSQL ${target.major}, but the pin is PostgreSQL ${pin.major} (${pinTag}). A bump stays in the pinned major: a new major is adopted deliberately, through a port-${target.major} branch rebased onto main (ADR-0001 decision 8), never by \`bun run bump\`.`,
    ];
  }
  if (target.minor === undefined) {
    return [
      `${tag} is not a release of PostgreSQL ${pin.major} (REL_${pin.major}_<minor>): a bump moves to a release.`,
    ];
  }
  if (target.minor === pin.minor) return [`upstream.json already pins ${tag}.`];
  if (target.minor < pin.minor) {
    return [`${tag} is older than the pinned ${pinTag}: a bump moves the pin forward, to a newer minor release.`];
  }
  return [];
}

/** The bump's target, or the refusal. */
export function checkBumpTag(pinTag: string, tag: string): UpstreamTag {
  const problems = bumpTagProblems(pinTag, tag);
  const target = parseUpstreamTag(tag);
  if (problems.length > 0 || target === undefined) throw new UserError(`bump: refusing ${tag}: ${problems.join(" ")}`);
  return target;
}

/** What `git ls-remote` says of a tag: its object, and the commit it peels to when it is an annotated tag. */
export interface RemoteTag {
  readonly object: string;
  readonly peeled: string | undefined;
}

/** A tag in `git ls-remote --tags` output, or undefined when the remote has no such tag. */
export function parseLsRemote(output: string, tag: string): RemoteTag | undefined {
  let object: string | undefined;
  let peeled: string | undefined;
  for (const line of output.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) continue;
    if (ref === `refs/tags/${tag}`) object = sha;
    else if (ref === `refs/tags/${tag}^{}`) peeled = sha;
  }
  return object === undefined ? undefined : { object, peeled };
}

/**
 * Refuses a tag the upstream repository does not have (the network's failure is reported as such); `command` names
 * the script in the messages.
 */
export function lsRemoteTag(layout: Layout, repository: string, tag: string, command = "bump"): RemoteTag {
  const result = git(["ls-remote", "--tags", repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    cwd: layout.root,
    env: cacheEnv(layout),
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    throw new UserError(`${command}: could not list the tags of ${repository}:\n  ${result.stderr.trim()}`);
  }
  const found = parseLsRemote(result.stdout, tag);
  if (found === undefined) throw new UserError(`${command}: refusing ${tag}: ${repository} has no tag ${tag}.`);
  return found;
}

/**
 * Fetches `tag` into the upstream cache with its history back to `sinceTag` (which the cache must hold), so that
 * the commits between them can be listed and diffed (`--shallow-exclude`: the commit after `sinceTag` becomes the
 * cache's shallow boundary). Refuses a tag that does not resolve to a commit.
 */
export function fetchTagHistory(layout: Layout, repository: string, tag: string, sinceTag: string): string {
  const fetch = gitCache(
    layout,
    [
      "fetch",
      "--quiet",
      `--shallow-exclude=refs/tags/${sinceTag}`,
      "--no-tags",
      repository,
      `+refs/tags/${tag}:refs/tags/${tag}`,
    ],
    { allowFailure: true },
  );
  if (fetch.exitCode !== 0) {
    throw new UserError(`bump: could not fetch ${tag} and its history since ${sinceTag}:\n  ${fetch.stderr.trim()}`);
  }
  const resolved = gitCache(layout, ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}^{commit}`], {
    allowFailure: true,
  });
  const commit = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || commit === "") {
    throw new UserError(`bump: refusing ${tag}: it does not resolve to a commit.`);
  }
  return commit;
}

/** The series applied onto a tag in a scratch worktree of the cache (the caller removes it). */
export interface Rebased {
  readonly worktree: string;
  readonly base: string;
  /** HEAD after the patches that applied. */
  readonly head: string;
  readonly applied: readonly PatchApplied[];
  readonly failure: AmFailure | undefined;
}

/**
 * Applies `patches/` onto `base` in a fresh scratch worktree, one patch at a time with `git am --3way`, as
 * `patches:work` does. On a conflict the worktree is left mid-`git am` for the report to read.
 */
export function rebaseSeries(layout: Layout, purpose: string, base: string, patches: readonly string[]): Rebased {
  const worktree = scratchDir(layout, purpose);
  addWorktree(layout, worktree, base);
  const { applied, failure } = applyEach(layout, worktree, patches);
  if (failure === undefined) {
    const overlay = listOverlay(layout.overlayDir);
    const collisions = overlayCollisions(layout, worktree, overlay);
    if (collisions.length > 0) {
      removeWorktree(layout, worktree);
      throw collisionError(collisions, `${base} with the series applied`);
    }
  }
  const head = gitTree(layout, worktree, ["rev-parse", "HEAD"]).stdout.trim();
  return { worktree, base, head, applied, failure };
}

/** `git range-diff` of the series on the old tag against the series on the new one. */
export function rangeDiff(layout: Layout, from: { base: string; head: string }, to: { base: string; head: string }) {
  return gitCache(layout, [
    "range-diff",
    "--no-color",
    `${from.base}..${from.head}`,
    `${to.base}..${to.head}`,
  ]).stdout.trimEnd();
}

/** How each patch of the series applied onto a tag, for a report. */
export function applyLog(patches: readonly string[], rebased: Rebased): ApplyLog {
  const results = new Map<string, ApplyLog["patches"][number]["result"]>(
    rebased.applied.map((entry) => [entry.patch, entry.threeWay ? "applied with a 3-way merge" : "applied cleanly"]),
  );
  if (rebased.failure?.patch !== undefined) results.set(rebased.failure.patch, "CONFLICT");
  return {
    patches: patches.map((patch) => ({ patch, result: results.get(patch) ?? "not applied" })),
    output: [...rebased.applied.map((entry) => entry.output), rebased.failure?.output ?? ""]
      .filter((text) => text !== "")
      .join("\n"),
  };
}

/**
 * Replaces the patch files in `patchesDir` (the repository's `patches/` by default) with the series exported from
 * a worktree it applied cleanly in, onto that worktree's base; returns what changed per file. The names must stay
 * the same.
 */
export function exportRebased(layout: Layout, rebased: Rebased, patchesDir = layout.patchesDir): PatchChange[] {
  const staging = scratchDir(layout, "bump-export");
  try {
    const written = formatSeries(layout, rebased.worktree, rebased.base, staging);
    const before = listPatches(patchesDir);
    if (written.join("\n") !== before.join("\n")) {
      throw new UserError(
        `bump: the re-exported series is named differently (${written.join(", ")}) from patches/ (${before.join(", ")}).`,
      );
    }
    const changes: PatchChange[] = [];
    for (const name of written) {
      const old = readFileSync(join(patchesDir, name), "utf8");
      const next = readFileSync(join(staging, name), "utf8");
      if (old !== next) {
        changes.push(patchChange(name, old, next));
        writeFileSync(join(patchesDir, name), next);
      }
    }
    return changes;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** An upstream commit between the tags, and which of the given files it changed. */
export interface UpstreamCommit {
  readonly sha: string;
  readonly date: string;
  readonly subject: string;
  readonly files: readonly string[];
}

/**
 * A commit's first parent, from the commit object itself (a shallow boundary's parents are grafted away), when the
 * cache holds it.
 */
function parentOf(layout: Layout, sha: string): string | undefined {
  const object = gitCache(layout, ["cat-file", "commit", sha]).stdout;
  const parent = /^parent ([0-9a-f]{40})$/m.exec(object)?.[1];
  if (parent === undefined) return undefined;
  const present = gitCache(layout, ["cat-file", "-e", `${parent}^{commit}`], { allowFailure: true });
  return present.exitCode === 0 ? parent : undefined;
}

/** The files among `files` a commit changed, against its real parent. */
function changedFiles(layout: Layout, sha: string, files: readonly string[]): string[] | undefined {
  const parent = parentOf(layout, sha);
  if (parent === undefined) return undefined;
  return gitCache(layout, ["diff", "--name-only", "--no-renames", parent, sha, "--", ...files])
    .stdout.split("\n")
    .filter((line) => line !== "");
}

/** The number of upstream commits between two commits. */
export function countCommits(layout: Layout, from: string, to: string): number {
  return Number(gitCache(layout, ["rev-list", "--count", `${from}..${to}`]).stdout.trim());
}

/**
 * The upstream commits between two commits that changed any of `files`, oldest first, each with the files it
 * changed. The cache's shallow boundary commits are diffed against their real parent (git would diff them against
 * nothing, as if they added every file).
 */
export function upstreamCommits(layout: Layout, from: string, to: string, files: readonly string[]): UpstreamCommit[] {
  if (files.length === 0) return [];
  const log = gitCache(layout, [
    "log",
    "--no-merges",
    "--reverse",
    "--date=short",
    "--format=%x00%H%x09%ad%x09%s",
    "--name-only",
    "--no-renames",
    `${from}..${to}`,
    "--",
    ...files,
  ]).stdout;
  const shallowFile = join(layout.cacheRepo, "shallow");
  const shallow = new Set(
    existsSync(shallowFile)
      ? readFileSync(shallowFile, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [],
  );
  const commits: UpstreamCommit[] = [];
  for (const entry of log.split("\0").slice(1)) {
    const [header = "", ...rest] = entry.split("\n");
    const [sha = "", date = "", ...subject] = header.split("\t");
    const listed = rest.filter((line) => line !== "");
    const changed = shallow.has(sha) ? (changedFiles(layout, sha, files) ?? listed) : listed;
    if (changed.length > 0) commits.push({ sha, date, subject: subject.join("\t"), files: changed });
  }
  return commits;
}

/** The files the patches change (from their `diff --git` headers), sorted, without duplicates. */
export function patchedFiles(patchTexts: readonly string[]): string[] {
  const files = new Set<string>();
  for (const text of patchTexts) for (const file of parseDiffHunks(text)) files.add(file.file);
  return [...files].sort();
}

/** How a re-exported patch file differs from the one it replaces. */
export interface PatchChange {
  readonly patch: string;
  /** `index` lines (the blobs the patch applies to), hunk headers (where), other lines (context or content). */
  readonly blobIds: number;
  readonly hunkOffsets: number;
  readonly other: number;
}

/** Counts, line by line, what changed in a patch file; a changed line count counts as content. */
export function patchChange(patch: string, before: string, after: string): PatchChange {
  const old = before.split("\n");
  const next = after.split("\n");
  if (old.length !== next.length) {
    return { patch, blobIds: 0, hunkOffsets: 0, other: Math.abs(old.length - next.length) || 1 };
  }
  let blobIds = 0;
  let hunkOffsets = 0;
  let other = 0;
  old.forEach((line, index) => {
    const now = next[index] ?? "";
    if (line === now) return;
    if (line.startsWith("index ") && now.startsWith("index ")) blobIds += 1;
    else if (line.startsWith("@@ ") && now.startsWith("@@ ")) hunkOffsets += 1;
    else other += 1;
  });
  return { patch, blobIds, hunkOffsets, other };
}

/** A conflicting file of the patch that did not apply, and the upstream commits behind the conflict. */
export interface ConflictedFile {
  readonly file: string;
  /** The failing patch's hunk headers in this file. */
  readonly hunks: readonly string[];
  /** git's "patch failed" places in this file: where the plain apply stopped. */
  readonly rejected: readonly string[];
  /** Conflict regions the 3-way merge left, as lines of the merged file. */
  readonly regions: readonly LineRange[];
  /**
   * The upstream commits between the tags that changed the file, oldest first; undefined when their history is not
   * in the cache (another major's tag, fetched without it).
   */
  readonly commits: readonly UpstreamCommit[] | undefined;
  /** Of those, the ones that changed a line one of the patch's hunks stands on (its context or removed lines). */
  readonly touching: readonly string[];
  /** The conflict regions' text, markers included (at most 40 lines each). */
  readonly excerpts: readonly string[];
}

/** The hunks of `file` in a patch file, or none. */
function fileHunks(layout: Layout, patch: string, file: string): readonly Hunk[] {
  const text = readFileSync(join(layout.patchesDir, patch), "utf8");
  return parseDiffHunks(text).find((entry) => entry.file === file)?.hunks ?? [];
}

/** The `-U0` hunks of a commit's change to a file, against its real parent; undefined when that is not cached. */
function commitHunks(layout: Layout, sha: string, file: string): readonly Hunk[] | undefined {
  const parent = parentOf(layout, sha);
  if (parent === undefined) return undefined;
  const diff = gitCache(layout, ["diff", "-U0", "--no-color", "--no-renames", parent, sha, "--", file]).stdout;
  return parseDiffHunks(diff).find((entry) => entry.file === file)?.hunks ?? [];
}

const EXCERPT_LINES = 40;

/**
 * The conflicting files of a failed apply, each with the upstream commits between `from` and `to` that changed it
 * and those that changed the lines the failing patch's hunks stand on. The hunks' lines are the old tag's with the
 * earlier patches applied, so each range is taken back through the earlier patches to the old tag's lines, then
 * forward through the upstream commits, oldest first. Without `history` (the readiness of another major, whose tag
 * is fetched without the commits since the pinned one) the commits are not looked up.
 */
export function conflictedFiles(
  layout: Layout,
  worktree: string,
  failure: AmFailure,
  patches: readonly string[],
  from: string,
  to: string,
  history = true,
): ConflictedFile[] {
  const failing = failure.patch ?? "";
  const index = patches.indexOf(failing);
  const rejectedFiles = failure.rejectedHunks.map((hunk) => hunk.slice(0, hunk.lastIndexOf(":")));
  const files = [...new Set([...failure.unmergedFiles, ...rejectedFiles])].sort();
  return files.map((file) => {
    const hunks = index === -1 ? [] : fileHunks(layout, failing, file);
    let ranges = hunks.map(oldRange);
    for (const earlier of patches.slice(0, Math.max(index, 0)).reverse()) {
      const earlierHunks = fileHunks(layout, earlier, file);
      if (earlierHunks.length > 0) ranges = ranges.map((range) => followRange(range, invertHunks(earlierHunks)).range);
    }
    const commits = history ? upstreamCommits(layout, from, to, [file]) : undefined;
    const touching: string[] = [];
    for (const commit of commits ?? []) {
      const change = commitHunks(layout, commit.sha, file);
      if (change === undefined) {
        touching.push(commit.sha);
        continue;
      }
      let touched = false;
      ranges = ranges.map((range) => {
        const followed = followRange(range, change);
        touched ||= followed.touched;
        return followed.range;
      });
      if (touched) touching.push(commit.sha);
    }
    const regions = failure.conflicts
      .filter((region) => region.file === file)
      .map((region) => ({ start: region.startLine, end: region.endLine }));
    const path = join(worktree, file);
    const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
    const excerpts = regions.map((region) => {
      const text = lines.slice(region.start - 1, region.end);
      return text.length > EXCERPT_LINES
        ? [...text.slice(0, EXCERPT_LINES), `… ${text.length - EXCERPT_LINES} more lines`].join("\n")
        : text.join("\n");
    });
    return {
      file,
      hunks: hunks.map((hunk) => hunk.header),
      rejected: failure.rejectedHunks.filter((hunk) => hunk.startsWith(`${file}:`)),
      regions,
      commits,
      touching,
      excerpts,
    };
  });
}

/**
 * The regress tests whose input changed between two upstream commits (their `sql/`, `expected/`, `input/` or
 * `output/` files; an expected file's variants, `<test>_1.out`, count for the test), and whether the schedule did.
 */
export function regressTestsChanged(layout: Layout, from: string, to: string): { tests: string[]; schedule: boolean } {
  const regress = "src/test/regress/";
  const changed = gitCache(layout, ["diff", "--name-only", "--no-renames", from, to, "--", regress])
    .stdout.split("\n")
    .filter((line) => line !== "");
  const tests = new Set<string>();
  for (const path of changed) {
    const match = /^src\/test\/regress\/(?:sql|expected|input|output)\/(.+)\.(?:sql|out|source)$/.exec(path);
    if (match?.[1] !== undefined) tests.add(match[1].replace(/_\d+$/, ""));
  }
  return { tests: [...tests].sort(), schedule: changed.includes(`${regress}parallel_schedule`) };
}

/** The hunks of `git diff --no-index` of two files (no header: it holds their paths), or undefined when equal. */
export function diffFiles(layout: Layout, a: string, b: string): string | undefined {
  const result = git(["diff", "--no-index", "--no-color", "-U2", "--", a, b], {
    cwd: layout.root,
    env: cacheEnv(layout),
    allowFailure: true,
  });
  if (result.exitCode === 0) return undefined;
  if (result.exitCode !== 1) throw new UserError(`bump: git diff --no-index ${a} ${b} failed: ${result.stderr.trim()}`);
  const lines = result.stdout.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@ "));
  return (first === -1 ? lines : lines.slice(first)).join("\n");
}

/**
 * Moves `upstream.json` to a tag: its `tag` and `commit`, everything else as it was, in the file's layout (two
 * spaces, a final newline).
 */
export function writePin(layout: Layout, pin: UpstreamPin): void {
  const json = readJson(layout.upstreamFile, layout.root);
  json["tag"] = pin.tag;
  json["commit"] = pin.commit;
  writeFileSync(layout.upstreamFile, `${JSON.stringify(json, null, 2)}\n`);
}

/** The path of a file relative to the repository, for messages. */
export function where(layout: Layout, path: string): string {
  return relative(layout.root, path) || ".";
}
