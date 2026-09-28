/**
 * bun run bump <upstream tag> [--image <reference> | --lock] [--report <file>] [--trailer <trailer>]...
 *
 * Moves the pin to a newer upstream release of the pinned major (ADR-0001 decision 7), and says what that changes.
 * It refuses a tag of another major (majors are adopted deliberately, through a port-<major> branch: decision 8),
 * anything but a newer release (`REL_<major>_<minor>`), a tag upstream does not have or that does not resolve to a
 * commit, and a working tree with changes. Then:
 *
 *   apply    fetches the tag with its history since the pinned one into the upstream cache, and applies the series
 *            onto it with `git am --3way`, patch by patch, as `patches:work` does. On a conflict it stops, changes
 *            nothing in the repository, and writes the report: the patch, the conflicting files and hunks, and the
 *            upstream commits between the tags that changed those lines.
 *   update   on a clean apply: re-exports patches/ (their context moved), sets upstream.json's tag and commit,
 *            proves the series with patches:check, and commits the two (the pre-commit hook validates it).
 *   gate     runs `bun run gate --keep-going` on that commit, then writes the report: the apply log, `git
 *            range-diff` of the series (old tag's against new tag's), the upstream commits that change the patched
 *            files, the export list against exported_functions.txt, the data format (a minor must keep its
 *            dataFormat), pg_regress against the baseline, the prepopulated data directory against its record, and
 *            the sizes against the previous release's manifest.json (downloaded with `gh`, read-only).
 *
 * It never re-records the regress baseline, exported_functions.txt or identity/prepopulated.json: the report says
 * which differ and the command that re-records each, which the operator runs after reading it, each in its own
 * commit. A core symbol gone from the export list, or a test that newly fails, is investigated and explained
 * before a release.
 *
 * --image, --lock  the builder image, as for `bun run gate` (default: the local image).
 * --report         where the report goes (default .cache/bump/<tag>.md): the bump's pull request body.
 * --trailer        a trailer for the bump commit's message (`git commit --trailer`); repeatable.
 *
 * Exits 0 when the bump is committed and nothing blocks it (records to re-record are not blocking); 1 otherwise.
 * HEAD moves only when the bump is committed. It takes about 15 minutes (the gate). Not part of validate.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  bumpCommitMessage,
  bumpReport,
  bumpVerdict,
  conflictReport,
  type ApplyLog,
  type GateFindings,
  type RegressFindings,
  type SizeRow,
  type TagRef,
} from "./lib/bump-report.ts";
import {
  applyLog,
  checkBumpTag,
  conflictedFiles,
  exportRebased,
  countCommits,
  diffFiles,
  fetchTagHistory,
  lsRemoteTag,
  patchedFiles,
  rangeDiff,
  rebaseSeries,
  regressTestsChanged,
  upstreamCommits,
  where,
  writePin,
  type PatchChange,
} from "./lib/bump.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { checkSeries } from "./lib/commands.ts";
import { readUpstreamPin, type UpstreamPin } from "./lib/config.ts";
import { readDataFormat, tupleDifferences } from "./lib/data-format.ts";
import { DRIVER_FILES } from "./lib/driver/artefacts.ts";
import { coreSymbols, diffExports, readExportList } from "./lib/exports.ts";
import { gateStaging, readGateManifest, readGateSteps, type GateManifest } from "./lib/gate.ts";
import { git, gitTree, UserError } from "./lib/git.ts";
import { layoutFor, repoRoot, type Layout } from "./lib/layout.ts";
import { MANIFEST_FILE, readManifest, type BuildManifest } from "./lib/manifest.ts";
import { readPrepopulatedRecord, unpackDataDir } from "./lib/prepopulated.ts";
import { outcomePath, readOutcome } from "./lib/regress/outcome.ts";
import { previousRelease } from "./lib/release.ts";
import { listPatches } from "./lib/series.ts";
import { removeWorktree, resolveTag } from "./lib/upstream.ts";
import { repositoryCandidate } from "./lib/version.ts";

const USAGE =
  "Usage: bun run bump <upstream tag> [--image <reference> | --lock] [--report <file>] [--trailer <trailer>]...";

interface Options {
  tag: string;
  image: string | undefined;
  lock: boolean;
  report: string | undefined;
  trailers: string[];
}

function options(args: readonly string[]): Options {
  const [tag, ...rest] = args;
  if (tag === undefined || tag.startsWith("-")) throw new UserError(USAGE);
  const parsed: Options = { tag, image: undefined, lock: false, report: undefined, trailers: [] };
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
    else if (flag === "--trailer") parsed.trailers.push(value);
    else throw new UserError(USAGE);
  }
  if (parsed.lock && parsed.image !== undefined) throw new UserError(USAGE);
  return parsed;
}

function writeReport(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** The repository's patches/ and upstream.json as they are, to put back if the bump fails before its commit. */
function snapshot(layout: Layout): () => void {
  const pin = readFileSync(layout.upstreamFile);
  const patches = new Map(
    readdirSync(layout.patchesDir)
      .filter((name) => name.endsWith(".patch"))
      .map((name) => [name, readFileSync(join(layout.patchesDir, name))]),
  );
  return () => {
    git(["reset", "--quiet", "--", "patches", "upstream.json"], { cwd: layout.root, allowFailure: true });
    for (const name of readdirSync(layout.patchesDir)) {
      if (name.endsWith(".patch")) rmSync(join(layout.patchesDir, name));
    }
    for (const [name, bytes] of patches) writeFileSync(join(layout.patchesDir, name), bytes);
    writeFileSync(layout.upstreamFile, pin);
  };
}

/** The previous release's manifest, downloaded read-only with gh, or why it is not available. */
function previousManifest(layout: Layout, tag: string): GateManifest | string {
  if (Bun.which("gh") === null) return "the GitHub CLI (gh) is not installed";
  const dir = join(layout.cacheDir, "bump", "releases", tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const proc = Bun.spawnSync(
    ["gh", "release", "download", tag, "--pattern", MANIFEST_FILE, "--dir", dir, "--clobber"],
    { cwd: layout.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return `\`gh release download ${tag}\` failed: ${proc.stderr.toString().trim()}`;
  return readGateManifest(dir, layout.root);
}

function fileBytes(path: string): number | undefined {
  return existsSync(path) ? statSync(path).size : undefined;
}

function sizeRows(previous: GateManifest, now: ReadonlyMap<string, number>): SizeRow[] {
  const rows: SizeRow[] = previous.files.map((file) => ({
    name: file.name,
    before: file.bytes,
    after: now.get(file.name),
  }));
  for (const [name, bytes] of now) {
    if (!previous.files.some((file) => file.name === name)) rows.push({ name, before: undefined, after: bytes });
  }
  return rows;
}

function regressFindings(
  layout: Layout,
  ran: boolean,
  to: TagRef,
  build: BuildManifest,
  from: string,
): RegressFindings | undefined {
  if (!ran || !existsSync(outcomePath(layout))) return undefined;
  const outcome = readOutcome(layout);
  const byName = new Map(build.artefacts.map((artefact) => [basename(artefact.path), artefact.sha256]));
  if (outcome.upstream.tag !== to.tag || DRIVER_FILES.some((name) => outcome.ranWith[name] !== byName.get(name))) {
    return undefined;
  }
  const changed = regressTestsChanged(layout, from, to.commit);
  const upstream = new Set(changed.tests);
  const normalised = (test: string): string => join(layout.regressCache, "runs", "1", "normalised", `${test}.diff`);
  const { comparison } = outcome;
  // A test the baseline does not have failed when the run left its diff.
  const unexpectedFailing = comparison.unexpected.filter((test) => existsSync(normalised(test)));
  const failing = [...comparison.newFailures, ...unexpectedFailing];
  // The ones that say most about the build first: changed diffs of tests upstream left alone, then new failures.
  const ordered = [
    ...comparison.changedDiffs.filter((test) => !upstream.has(test)),
    ...failing,
    ...comparison.changedDiffs.filter((test) => upstream.has(test)),
  ];
  const details = ordered.flatMap((test) => {
    const file = normalised(test);
    if (!existsSync(file)) return [];
    if (failing.includes(test)) return [{ test, text: readFileSync(file, "latin1") }];
    const text = diffFiles(layout, join(layout.regressDiffsDir, `${test}.diff`), file);
    return text === undefined ? [] : [{ test, text }];
  });
  return {
    baseline: { tag: outcome.baseline.upstream.tag, ...outcome.baseline.summary },
    runs: outcome.runs,
    newFailures: comparison.newFailures,
    changedDiffs: comparison.changedDiffs,
    newlyUnstable: comparison.newlyUnstable,
    vanished: comparison.vanished,
    unstable: comparison.unstable,
    missing: comparison.missing,
    unexpected: comparison.unexpected,
    unexpectedFailing,
    changedUpstream: changed.tests,
    scheduleChanged: changed.schedule,
    details,
  };
}

/** What the gate found, read from what it left: the steps, the build, the regress outcome, the staged asset. */
function gateFindings(layout: Layout, commit: string, to: TagRef, from: string): GateFindings {
  const steps = readGateSteps(layout, commit)?.steps ?? [];
  const passed = (name: string): boolean => steps.some((step) => step.name === name && step.exitCode === 0);
  const buildLogFile = join(layout.buildDir, "build.log");
  const buildLog =
    steps.some((step) => step.name === "build" && step.exitCode !== 0 && step.exitCode !== null) &&
    existsSync(buildLogFile)
      ? readFileSync(buildLogFile, "utf8").trimEnd().split("\n").slice(-30)
      : [];
  const manifestFile = join(layout.buildDist, MANIFEST_FILE);
  const build = passed("build") && existsSync(manifestFile) ? readManifest(manifestFile, layout.root) : undefined;
  if (build !== undefined && build.commit !== commit) {
    throw new UserError(`bump: ${where(layout, manifestFile)} is of ${build.commit}, not the bump ${commit}.`);
  }
  const previous = previousRelease(layout.root, commit);
  const noSizes = (reason: string): GateFindings["sizes"] => ({ previous, unavailable: reason });
  if (build === undefined) {
    return {
      steps,
      buildLog,
      version: undefined,
      exports: undefined,
      dataFormat: undefined,
      regress: undefined,
      prepopulated: undefined,
      sizes: noSizes("there is no build"),
    };
  }

  const reference = readExportList(layout.exportsReference);
  const listed = readExportList(join(layout.buildDist, "exported_functions.txt"));
  const core = coreSymbols(
    readFileSync(join(layout.overlayDir, "pglite", "static", "included.pglite.exports"), "utf8"),
  );
  const exportsDiff = diffExports(reference, listed, core);
  const declaration = readDataFormat(layout);

  const byName = new Map(build.artefacts.map((artefact) => [basename(artefact.path), artefact]));
  const assetFile = join(gateStaging(layout, commit), "prepopulated.tar.gz");
  const record = readPrepopulatedRecord(layout);
  const asset = passed("prepopulated") && existsSync(assetFile) ? new Uint8Array(readFileSync(assetFile)) : undefined;
  const prepopulated =
    asset === undefined || record === undefined
      ? undefined
      : {
          entries: unpackDataDir(asset).length,
          bytes: asset.length,
          recorded: { entries: record.entries, bytes: record.asset.bytes },
          artefactsChanged: DRIVER_FILES.filter((name) => byName.get(name)?.sha256 !== record.artefacts[name]),
        };

  let sizes: GateFindings["sizes"];
  if (previous === undefined) sizes = noSizes("there is no earlier release");
  else {
    const manifest = previousManifest(layout, previous);
    if (typeof manifest === "string") sizes = noSizes(manifest);
    else {
      const now = new Map<string, number>([...byName].map(([name, artefact]) => [name, artefact.bytes]));
      const dataFormatBytes = fileBytes(layout.dataFormatFile);
      if (dataFormatBytes !== undefined) now.set("data-format.json", dataFormatBytes);
      if (asset !== undefined) now.set("prepopulated.tar.gz", asset.length);
      sizes = { previous, rows: sizeRows(manifest, now) };
    }
  }

  return {
    steps,
    buildLog,
    version: build.version,
    exports: {
      symbols: listed.length,
      reference: reference.length,
      added: exportsDiff.added,
      removed: exportsDiff.removed,
      missingCore: exportsDiff.missingCore,
    },
    dataFormat: {
      declared: declaration.dataFormat,
      differences: tupleDifferences(declaration.tuple, build.tuple),
      catalogVersion: build.tuple.catalog_version_no,
    },
    regress: regressFindings(
      layout,
      steps.some((step) => step.name === "regress" && step.exitCode !== null),
      to,
      build,
      from,
    ),
    prepopulated,
    sizes,
  };
}

await runCliAsync(async () => {
  const args = options(process.argv.slice(2));
  const layout = layoutFor(repoRoot);
  const pin = readUpstreamPin(layout);
  const target = checkBumpTag(pin.tag, args.tag);
  const changes = git(["status", "--porcelain"], { cwd: layout.root }).stdout.trimEnd();
  if (changes !== "") {
    throw new UserError(
      [
        "bump: the working tree has changes; a bump starts from a commit. Commit or stash them first:",
        ...changes.split("\n").map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  lsRemoteTag(layout, pin.repository, target.tag);
  const oldCommit = resolveTag(layout, pin, info);
  info(`bump: fetching ${target.tag} and its history since ${pin.tag} into the upstream cache`);
  const newCommit = fetchTagHistory(layout, pin.repository, target.tag, pin.tag);
  const from: TagRef = { tag: pin.tag, commit: oldCommit };
  const to: TagRef = { tag: target.tag, commit: newCommit };
  const reportFile = resolve(args.report ?? join(layout.cacheDir, "bump", `${target.tag}.md`));
  const patches = listPatches(layout.patchesDir);
  const upstreamTotal = countCommits(layout, oldCommit, newCommit);
  info(
    `bump: ${pin.tag} (${oldCommit.slice(0, 12)}) → ${target.tag} (${newCommit.slice(0, 12)}): ${upstreamTotal} upstream commits`,
  );

  const worktrees: string[] = [];
  let message: string;
  let apply: ApplyLog;
  let changed: PatchChange[];
  let tree: string;
  let range: string;
  const restore = snapshot(layout);
  let modified = false;
  try {
    const old = rebaseSeries(layout, "bump-old", oldCommit, patches);
    worktrees.push(old.worktree);
    if (old.failure !== undefined) {
      throw new UserError(`bump: patches/ does not apply on the pinned ${pin.tag}; run \`bun run patches:check\`.`);
    }
    const next = rebaseSeries(layout, "bump-new", newCommit, patches);
    worktrees.push(next.worktree);
    apply = applyLog(patches, next);
    for (const entry of apply.patches) info(`bump: ${entry.patch}: ${entry.result}`);

    if (next.failure !== undefined) {
      const files = conflictedFiles(layout, next.worktree, next.failure, patches, oldCommit, newCommit);
      writeReport(
        reportFile,
        conflictReport({ from, to, apply, patch: next.failure.patch ?? "(unknown)", files, upstreamTotal }),
      );
      gitTree(layout, next.worktree, ["am", "--abort"], { allowFailure: true });
      throw new UserError(
        `bump: ${next.failure.patch ?? "a patch"} does not apply on ${target.tag}; nothing in the repository changed. The report: ${reportFile}`,
      );
    }

    range = rangeDiff(layout, old, next);
    modified = true;
    changed = exportRebased(layout, next);
    const newPin: UpstreamPin = { repository: pin.repository, tag: target.tag, commit: newCommit };
    writePin(layout, newPin);
    tree = checkSeries(layout, info).tree;
    message = bumpCommitMessage({ from, to, apply, changes: changed });
    git(["add", "--all", "--", "patches", "upstream.json"], { cwd: layout.root });
    info("bump: committing the pin and the re-exported series (the pre-commit hook validates it)");
    git(["commit", "--quiet", "--file", "-", ...args.trailers.flatMap((trailer) => ["--trailer", trailer])], {
      cwd: layout.root,
      stdin: message,
    });
  } catch (error) {
    // Nothing is left changed: patches/ and upstream.json go back to what they were, unstaged.
    if (modified) restore();
    throw error;
  } finally {
    for (const worktree of worktrees) removeWorktree(layout, worktree);
  }

  const commit = git(["rev-parse", "HEAD"], { cwd: layout.root }).stdout.trim();
  const version = repositoryCandidate(layout.root, target.tag);
  info(
    `bump: committed ${commit.slice(0, 12)} (pgwasm-postgres ${version}); the engine gate follows (about 15 minutes)`,
  );

  const gateArgs = [
    "--keep-going",
    ...(args.lock ? ["--lock"] : []),
    ...(args.image === undefined ? [] : ["--image", args.image]),
  ];
  const gateExit = await Bun.spawn([process.execPath, join(layout.root, "scripts", "gate.ts"), ...gateArgs], {
    cwd: layout.root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  info(`\nbump: the gate exited ${gateExit}; reading what it found`);

  const files = patchedFiles(patches.map((name) => readFileSync(join(layout.patchesDir, name), "utf8")));
  const input = {
    from,
    to,
    commit,
    version,
    apply,
    changes: changed,
    tree,
    rangeDiff: range,
    upstream: {
      total: upstreamTotal,
      patchedFiles: files,
      commits: upstreamCommits(layout, oldCommit, newCommit, files),
    },
    gate: gateFindings(layout, commit, to, oldCommit),
  };
  writeReport(reportFile, bumpReport(input));
  const verdict = bumpVerdict(input);
  if (input.gate.steps.length === 0) {
    throw new UserError(
      `bump: the gate did not run (exit ${gateExit}; its message is above). The report: ${reportFile}`,
    );
  }
  for (const line of verdict.investigate) info(`bump: investigate: ${line}`);
  for (const entry of verdict.rerecord) info(`bump: re-record ${entry.record} (${entry.why}): ${entry.command}`);
  if (verdict.blocking.length > 0) {
    throw new UserError(
      [
        `bump: STOP: ${target.tag} is committed as ${commit.slice(0, 12)}, but:`,
        ...verdict.blocking.map((line) => `  ${line}`),
        `The report: ${reportFile}`,
      ].join("\n"),
    );
  }
  info(`bump: ${target.tag} is committed as ${commit.slice(0, 12)} and nothing blocks it. The report: ${reportFile}`);
});
