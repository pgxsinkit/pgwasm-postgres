/**
 * bun run readiness <upstream tag> [--image <reference> | --lock] [--report <file>]
 *
 * The next major's readiness (ADR-0001 decisions 7 and 8): how the series of HEAD fares on a later major's tag (a
 * beta, a release candidate or a release), with nothing committed anywhere. It refuses a tag of the pinned major or
 * an older one (a newer release of the pinned major is `bun run bump`'s), a tag upstream does not have, and a working
 * tree with changes (the report is a commit's). Then:
 *
 *   apply    fetches the tag (shallow) into the upstream cache and applies the series onto it with `git am --3way`,
 *            patch by patch, in a scratch worktree of the cache, as `bun run bump` does, but past its conflicts: a
 *            patch that conflicts is reported with the bump's own conflict sections (the files, the patch's hunks,
 *            the merge's conflict regions), skipped, and the next ones applied without it. The upstream commits since
 *            the pinned tag are not listed, since their history is not fetched.
 *   build    on a clean apply: a scratch copy of this repository at HEAD (a detached worktree under .cache/, sharing
 *            the upstream cache) gets the series re-exported onto the tag and its pin moved to it, and builds there
 *            with `bun run build` (a beta builds as the pre-release version `<major>.0.0-beta.<n>`).
 *   checks   once it built: the compatibility tuple of a fresh initdb against data-format.json (a major is expected
 *            to change it: the report gives the new values), the export list against exported_functions.txt, and
 *            `bun run regress` against the pinned major's baseline (the counts, and the new failures by name).
 *
 * The report (default .cache/readiness/<tag>.md; the build log next to it) starts with its status as an HTML
 * comment, which `bun run poll` reads back for the readiness issue's table. The scratch worktrees are removed.
 *
 * --image, --lock  the builder image, as for `bun run gate` (default: the local image).
 * --report         where the report goes.
 *
 * Exits 0 when it wrote a report, whatever the report says (a conflict, a failed build or pg_regress results unlike
 * the baseline's are what it reports); 1 only when it could not write one. A build takes about 15 minutes with
 * pg_regress. Not part of validate.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { chooseBuilderImage } from "./lib/builder-image.ts";
import { exportRebased, lsRemoteTag, writePin, type Rebased } from "./lib/bump.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { overlayCollisions, scratchDir } from "./lib/commands.ts";
import { readUpstreamPin } from "./lib/config.ts";
import { readDataFormat, tupleOfEntries } from "./lib/data-format.ts";
import { loadArtefacts } from "./lib/driver/artefacts.ts";
import { initdb } from "./lib/driver/initdb.ts";
import type { DataDirEntry } from "./lib/driver/postgres.ts";
import { coreSymbols, diffExports, readExportList } from "./lib/exports.ts";
import { git, gitTree, UserError } from "./lib/git.ts";
import { layoutFor, repoRoot, type Layout } from "./lib/layout.ts";
import { listOverlay } from "./lib/overlay.ts";
import { removeBuildOutput } from "./lib/podman.ts";
import {
  applyPastConflicts,
  compilerErrors,
  lastLines,
  rawTupleValues,
  readinessReport,
  readinessStatus,
  type BuildFindings,
  type ExportFindings,
  type ReadinessInput,
  type RegressReadiness,
  type TupleFindings,
} from "./lib/readiness.ts";
import { outcomePath, readOutcome } from "./lib/regress/outcome.ts";
import { listPatches } from "./lib/series.ts";
import { readinessTagProblems } from "./lib/upstream-tags.ts";
import { addWorktree, removeWorktree, resolveTag } from "./lib/upstream.ts";

const USAGE = "Usage: bun run readiness <upstream tag> [--image <reference> | --lock] [--report <file>]";

interface Options {
  tag: string;
  image: string | undefined;
  lock: boolean;
  report: string | undefined;
}

function options(args: readonly string[]): Options {
  const [tag, ...rest] = args;
  if (tag === undefined || tag.startsWith("-")) throw new UserError(USAGE);
  const parsed: Options = { tag, image: undefined, lock: false, report: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--lock") {
      parsed.lock = true;
      continue;
    }
    const value = rest[index + 1];
    index += 1;
    if (value === undefined) throw new UserError(USAGE);
    if (flag === "--image") parsed.image = value;
    else if (flag === "--report") parsed.report = value;
    else throw new UserError(USAGE);
  }
  if (parsed.lock && parsed.image !== undefined) throw new UserError(USAGE);
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tee(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    sink.write(chunk);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** Runs one of the scratch copy's scripts in it, its output shown and kept. */
async function runScratchScript(
  scratch: Layout,
  script: string,
  args: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([process.execPath, join(scratch.root, "scripts", script), ...args], {
    cwd: scratch.root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exitCode] = await Promise.all([
    tee(proc.stdout, process.stdout),
    tee(proc.stderr, process.stderr),
    proc.exited,
  ]);
  return { exitCode, output: `${out}${err}` };
}

/** A scratch copy of this repository at `commit`: a detached worktree under .cache/, sharing the upstream cache. */
function scratchCopy(layout: Layout, commit: string): Layout {
  const root = scratchDir(layout, "readiness");
  git(["worktree", "add", "--quiet", "--detach", root, commit], { cwd: layout.root });
  const scratch = layoutFor(root);
  mkdirSync(scratch.cacheDir, { recursive: true });
  symlinkSync(layout.cacheRepo, scratch.cacheRepo);
  return scratch;
}

function removeScratchCopy(layout: Layout, scratch: Layout): void {
  removeBuildOutput(scratch.root);
  git(["worktree", "prune"], { cwd: layout.root, allowFailure: true });
}

async function build(scratch: Layout, image: string, logCopy: string): Promise<BuildFindings> {
  info("\nreadiness: ── build ──");
  const run = await runScratchScript(scratch, "build.ts", ["--image", image]);
  const recordFile = join(scratch.buildDir, "build.json");
  const record = existsSync(recordFile)
    ? (JSON.parse(readFileSync(recordFile, "utf8")) as { exitCode?: number; buildSeconds?: number; version?: string })
    : {};
  const logFile = join(scratch.buildDir, "build.log");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  if (existsSync(logFile)) copyFileSync(logFile, logCopy);
  const scriptExitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
  const scriptFailed = scriptExitCode !== undefined && scriptExitCode !== 0;
  return {
    exitCode: run.exitCode,
    scriptExitCode,
    seconds: record.buildSeconds,
    version: record.version,
    errors: scriptFailed ? compilerErrors(log) : [],
    tail: scriptFailed ? lastLines(log, 25) : run.exitCode === 0 ? [] : lastLines(run.output),
  };
}

function exportsOf(layout: Layout, scratch: Layout): ExportFindings {
  try {
    const reference = readExportList(layout.exportsReference);
    const listed = readExportList(join(scratch.buildDist, "exported_functions.txt"));
    const core = coreSymbols(
      readFileSync(join(layout.overlayDir, "pglite", "static", "included.pglite.exports"), "utf8"),
    );
    const diff = diffExports(reference, listed, core);
    return {
      symbols: listed.length,
      reference: reference.length,
      added: diff.added,
      removed: diff.removed,
      missingCore: diff.missingCore,
    };
  } catch (error) {
    return { error: message(error) };
  }
}

async function tupleOf(layout: Layout, scratch: Layout): Promise<TupleFindings> {
  info("\nreadiness: ── the compatibility tuple (a fresh initdb) ──");
  let entries: DataDirEntry[] | undefined;
  try {
    entries = await initdb(await loadArtefacts(scratch.buildDist));
    const declaration = readDataFormat(layout);
    return {
      tuple: tupleOfEntries(entries),
      declared: { dataFormat: declaration.dataFormat, tuple: declaration.tuple },
    };
  } catch (error) {
    return { error: message(error), raw: entries === undefined ? {} : rawTupleValues(entries) };
  }
}

async function regress(scratch: Layout, image: string, tag: string): Promise<RegressReadiness> {
  info("\nreadiness: ── regress ──");
  const run = await runScratchScript(scratch, "regress.ts", ["--image", image]);
  if (!existsSync(outcomePath(scratch)))
    return { exitCode: run.exitCode, outcome: undefined, tail: lastLines(run.output) };
  const outcome = readOutcome(scratch);
  if (outcome.upstream.tag !== tag) return { exitCode: run.exitCode, outcome: undefined, tail: lastLines(run.output) };
  const { comparison } = outcome;
  const normalised = (test: string): string => join(scratch.regressCache, "runs", "1", "normalised", `${test}.diff`);
  return {
    exitCode: run.exitCode,
    outcome: {
      baseline: { tag: outcome.baseline.upstream.tag, ...outcome.baseline.summary },
      runs: outcome.runs,
      newFailures: comparison.newFailures,
      changedDiffs: comparison.changedDiffs,
      newlyUnstable: comparison.newlyUnstable,
      vanished: comparison.vanished,
      missing: comparison.missing,
      unexpected: comparison.unexpected,
      // A test the baseline does not have failed when the run left its diff.
      unexpectedFailing: comparison.unexpected.filter((test) => existsSync(normalised(test))),
    },
    tail: [],
  };
}

await runCliAsync(async () => {
  const args = options(process.argv.slice(2));
  const layout = layoutFor(repoRoot);
  const pin = readUpstreamPin(layout);
  const problems = readinessTagProblems(pin.tag, args.tag);
  if (problems.length > 0) throw new UserError(`readiness: refusing ${args.tag}: ${problems.join(" ")}`);
  const changes = git(["status", "--porcelain"], { cwd: layout.root }).stdout.trimEnd();
  if (changes !== "") {
    throw new UserError(
      [
        "readiness: the working tree has changes; the report is a commit's series. Commit or stash them first:",
        ...changes.split("\n").map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  const series = git(["rev-parse", "HEAD"], { cwd: layout.root }).stdout.trim();
  lsRemoteTag(layout, pin.repository, args.tag, "readiness");
  // The pinned tag too: git am's 3-way fallback needs the blobs the patches were cut against.
  const oldCommit = resolveTag(layout, pin, info);
  const newCommit = resolveTag(layout, { repository: pin.repository, tag: args.tag }, info);
  const reportFile = resolve(args.report ?? join(layout.cacheDir, "readiness", `${args.tag}.md`));
  const logCopy = reportFile.replace(/(\.md)?$/, ".build.log");
  mkdirSync(dirname(reportFile), { recursive: true });
  rmSync(reportFile, { force: true });
  rmSync(logCopy, { force: true });

  const patches = listPatches(layout.patchesDir);
  info(
    `readiness: the series of ${series.slice(0, 12)} (pinned to ${pin.tag}) onto ${args.tag} (${newCommit.slice(0, 12)})`,
  );
  const worktree = scratchDir(layout, "readiness-apply");
  addWorktree(layout, worktree, newCommit);
  let scratch: Layout | undefined;
  try {
    const { apply, applied, conflicts } = applyPastConflicts(layout, worktree, patches, oldCommit, newCommit);
    for (const entry of apply.patches) info(`readiness: ${entry.patch}: ${entry.result}`);
    const collisions =
      conflicts.length === 0 ? overlayCollisions(layout, worktree, listOverlay(layout.overlayDir)) : [];

    let buildFindings: BuildFindings | undefined;
    let exports: ExportFindings | undefined;
    let tuple: TupleFindings | undefined;
    let regressFindings: RegressReadiness | undefined;
    if (conflicts.length === 0 && collisions.length === 0) {
      const head = gitTree(layout, worktree, ["rev-parse", "HEAD"]).stdout.trim();
      const rebased: Rebased = { worktree, base: newCommit, head, applied, failure: undefined };
      scratch = scratchCopy(layout, series);
      exportRebased(layout, rebased, scratch.patchesDir);
      writePin(scratch, { repository: pin.repository, tag: args.tag, commit: newCommit });
      info(`readiness: ${relative(layout.root, scratch.root)} is HEAD with the series re-exported onto ${args.tag}`);
      const image = await chooseBuilderImage(
        layout,
        { image: args.image, lock: args.lock, published: false },
        "readiness",
        info,
      );
      buildFindings = await build(scratch, image, logCopy);
      if (buildFindings.scriptExitCode === 0) {
        exports = exportsOf(layout, scratch);
        tuple = await tupleOf(layout, scratch);
        regressFindings = await regress(scratch, image, args.tag);
      }
    }

    const input: ReadinessInput = {
      from: { tag: pin.tag, commit: oldCommit },
      to: { tag: args.tag, commit: newCommit },
      series,
      apply,
      conflicts,
      collisions,
      build: buildFindings,
      tuple,
      exports,
      regress: regressFindings,
    };
    writeFileSync(reportFile, readinessReport(input));
    const status = readinessStatus(input);
    info(
      `\nreadiness: ${args.tag}: apply ${status.apply}; build ${status.build}; pg_regress ${status.regress}. The report: ${reportFile}`,
    );
  } finally {
    removeWorktree(layout, worktree);
    if (scratch !== undefined) removeScratchCopy(layout, scratch);
  }
});
