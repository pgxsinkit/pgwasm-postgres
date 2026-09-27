import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gitTree, UserError } from "./git.ts";
import type { Layout } from "./layout.ts";

/**
 * `git format-patch` flags that make `patches/` a pure function of the commits: no commit ids, no git
 * version signature, full blob ids (abbreviations grow with the object count), no rename detection and
 * no "n/N" numbering in subjects (adding a patch does not rewrite every other file). The user's git
 * config is not read (see `cacheEnv`), so diff and format settings are git's defaults.
 */
export const FORMAT_PATCH_FLAGS = [
  "--zero-commit",
  "--no-signature",
  "--full-index",
  "--no-renames",
  "--no-numbered",
  "--diff-algorithm=myers",
  "--unified=3",
  "--filename-max-length=100",
] as const;

const PATCH_NAME = /^(\d{4})-.+\.patch$/;

/** The series, in application order. Names must be `NNNN-<subject>.patch`, numbered 0001 upwards without gaps. */
export function listPatches(patchesDir: string): string[] {
  if (!existsSync(patchesDir)) return [];
  const names = readdirSync(patchesDir)
    .filter((name) => name.endsWith(".patch"))
    .sort();
  names.forEach((name, index) => {
    const match = PATCH_NAME.exec(name);
    const expected = String(index + 1).padStart(4, "0");
    if (match?.[1] !== expected) {
      throw new UserError(
        `patches/${name}: expected the ${ordinal(index + 1)} patch to be named ${expected}-<subject>.patch (as \`bun run patches:export\` writes it).`,
      );
    }
  });
  return names;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

export interface ConflictRegion {
  readonly file: string;
  /** 1-based, inclusive: from the `<<<<<<<` line to the `>>>>>>>` line. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface AmFailure {
  /** The patch file that failed, when git's state identifies it. */
  readonly patch: string | undefined;
  /** `path:line` of each hunk plain application rejected. */
  readonly rejectedHunks: readonly string[];
  /** Files the 3-way fallback left unmerged. */
  readonly unmergedFiles: readonly string[];
  /** Conflict regions in those files. */
  readonly conflicts: readonly ConflictRegion[];
  /** git am's own output. */
  readonly output: string;
}

/** `error: patch failed: <path>:<line>` lines, in order, without duplicates. */
export function parseRejectedHunks(output: string): string[] {
  const hunks: string[] = [];
  for (const match of output.matchAll(/^error: patch failed: (.+:\d+)$/gm)) {
    const hunk = match[1];
    if (hunk !== undefined && !hunks.includes(hunk)) hunks.push(hunk);
  }
  return hunks;
}

/** Conflict-marker regions (`<<<<<<< ` … `>>>>>>> `) in a file's text. */
export function findConflictRegions(file: string, text: string): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  let start: number | undefined;
  text.split("\n").forEach((line, index) => {
    if (line.startsWith("<<<<<<< ")) start = index + 1;
    else if (line.startsWith(">>>>>>> ") && start !== undefined) {
      regions.push({ file, startLine: start, endLine: index + 1 });
      start = undefined;
    }
  });
  return regions;
}

/** `git am --3way` of patch files, in order; the result's output is git's stdout and stderr together. */
function runAm(layout: Layout, worktree: string, patches: readonly string[]): { exitCode: number; output: string } {
  const am = gitTree(
    layout,
    worktree,
    [
      "am",
      "--3way",
      "--committer-date-is-author-date",
      "--no-gpg-sign",
      ...patches.map((name) => join(layout.patchesDir, name)),
    ],
    { allowFailure: true },
  );
  return { exitCode: am.exitCode, output: `${am.stdout}${am.stderr}`.trim() };
}

/**
 * Applies the series with `git am --3way`. On failure git's am state is left in place (the caller aborts
 * or hands the worktree to a human) and the failure is described: which patch, which hunks, which files.
 */
export function applySeries(layout: Layout, worktree: string, patches: readonly string[]): AmFailure | undefined {
  if (patches.length === 0) return undefined;
  const am = runAm(layout, worktree, patches);
  return am.exitCode === 0 ? undefined : amFailure(layout, worktree, patches, am.output);
}

/** How one patch of the series applied: plainly, or only through `git am --3way`'s fallback to a 3-way merge. */
export interface PatchApplied {
  readonly patch: string;
  readonly threeWay: boolean;
  /** git am's own output for the patch. */
  readonly output: string;
}

export interface SeriesApplication {
  /** The patches that applied, in order. */
  readonly applied: readonly PatchApplied[];
  /** The patch that did not, when one did not; git's am state is then left in place, as by {@link applySeries}. */
  readonly failure: AmFailure | undefined;
}

/** git am's message when a patch does not apply as it is and it falls back to a 3-way merge (LC_ALL=C). */
const THREE_WAY_FALLBACK = "Falling back to patching base and 3-way merge";

/**
 * Applies the series one patch at a time with `git am --3way`, as {@link applySeries} does, recording for each
 * patch whether it needed the 3-way fallback. It stops at the first patch that does not apply.
 */
export function applyEach(layout: Layout, worktree: string, patches: readonly string[]): SeriesApplication {
  const applied: PatchApplied[] = [];
  for (const patch of patches) {
    const am = runAm(layout, worktree, [patch]);
    if (am.exitCode !== 0) return { applied, failure: amFailure(layout, worktree, [patch], am.output) };
    applied.push({ patch, threeWay: am.output.includes(THREE_WAY_FALLBACK), output: am.output });
  }
  return { applied, failure: undefined };
}

/** Describes a failed `git am` of `patches` from the am state it left in a worktree. */
function amFailure(layout: Layout, worktree: string, patches: readonly string[], output: string): AmFailure {
  const nextFile = gitTree(layout, worktree, ["rev-parse", "--git-path", "rebase-apply/next"]).stdout.trim();
  const nextPath = nextFile.startsWith("/") ? nextFile : join(worktree, nextFile);
  const next = existsSync(nextPath) ? Number.parseInt(readFileSync(nextPath, "utf8").trim(), 10) : Number.NaN;
  const unmergedFiles = gitTree(layout, worktree, ["diff", "--name-only", "--diff-filter=U"])
    .stdout.split("\n")
    .filter((line) => line !== "");
  const conflicts = unmergedFiles.flatMap((file) => {
    const path = join(worktree, file);
    return existsSync(path) ? findConflictRegions(file, readFileSync(path, "utf8")) : [];
  });
  return {
    patch: Number.isInteger(next) ? patches[next - 1] : undefined,
    rejectedHunks: parseRejectedHunks(output),
    unmergedFiles,
    conflicts,
    output,
  };
}

export function describeAmFailure(failure: AmFailure, base: string): string[] {
  const lines = [`patches/${failure.patch ?? "(unknown patch)"} does not apply on ${base}.`];
  if (failure.rejectedHunks.length > 0) {
    lines.push("Hunks that did not apply cleanly:", ...failure.rejectedHunks.map((hunk) => `  ${hunk}`));
  }
  if (failure.unmergedFiles.length > 0) {
    lines.push("The 3-way merge left conflicts in:");
    for (const file of failure.unmergedFiles) {
      const regions = failure.conflicts.filter((region) => region.file === file);
      const where = regions.map((region) => `${region.startLine}-${region.endLine}`).join(", ");
      lines.push(`  ${file}${where === "" ? "" : ` (lines ${where})`}`);
    }
  }
  lines.push("git am said:", ...failure.output.split("\n").map((line) => `  | ${line}`));
  return lines;
}

/**
 * Writes the commits `base..HEAD` of a worktree as a patch series into `outDir` (which must be empty or
 * absent). Refuses merges, which format-patch would silently drop.
 */
export function formatSeries(layout: Layout, worktree: string, base: string, outDir: string): string[] {
  const ancestor = gitTree(layout, worktree, ["merge-base", "--is-ancestor", base, "HEAD"], { allowFailure: true });
  if (ancestor.exitCode !== 0) throw new UserError(`${worktree}: HEAD does not descend from ${base}.`);
  const merges = gitTree(layout, worktree, ["rev-list", "--merges", `${base}..HEAD`]).stdout.trim();
  if (merges !== "") {
    throw new UserError(
      `${worktree}: the series contains merge commits (${merges.split("\n").join(", ")}); rebase them away.`,
    );
  }
  return gitTree(layout, worktree, [
    "format-patch",
    ...FORMAT_PATCH_FLAGS,
    "--output-directory",
    outDir,
    `${base}..HEAD`,
  ])
    .stdout.split("\n")
    .filter((line) => line !== "")
    .map((path) => path.slice(path.lastIndexOf("/") + 1));
}

/** Differences between two patch directories, as human-readable lines; empty when byte-identical. */
export function comparePatchDirs(expectedDir: string, actualDir: string): string[] {
  const expected = listPatchFiles(expectedDir);
  const actual = listPatchFiles(actualDir);
  const problems: string[] = [];
  for (const name of expected) {
    if (!actual.includes(name)) problems.push(`${name}: only in patches/`);
  }
  for (const name of actual) {
    if (!expected.includes(name)) {
      problems.push(`${name}: only in the export`);
      continue;
    }
    const want = readFileSync(join(expectedDir, name));
    const got = readFileSync(join(actualDir, name));
    if (!want.equals(got)) problems.push(`${name}: ${firstDifference(want.toString("utf8"), got.toString("utf8"))}`);
  }
  return problems;
}

function listPatchFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".patch"))
        .sort()
    : [];
}

function firstDifference(want: string, got: string): string {
  const wantLines = want.split("\n");
  const gotLines = got.split("\n");
  const length = Math.max(wantLines.length, gotLines.length);
  for (let index = 0; index < length; index += 1) {
    if (wantLines[index] !== gotLines[index]) {
      const show = (line: string | undefined): string => (line === undefined ? "(end of file)" : JSON.stringify(line));
      return `first difference at line ${index + 1}: patches/ has ${show(wantLines[index])}, the export has ${show(gotLines[index])}`;
    }
  }
  return "the bytes differ (line endings or encoding)";
}
