/**
 * bun run gate [--image <reference> | --lock [--published]] [--keep-going] [--summary <file>]
 *
 * The engine gate (ADR-0001 decision 6) of the current commit, from clean, and the release it would publish
 * (decision 9). It refuses a working tree with changes (the gate is a commit's), then runs, with
 * SOURCE_DATE_EPOCH at the commit's time, and stops at the first that fails, whose own message says why:
 *
 *   build                  patches:check, then the build from scratch, in the builder image
 *   driver:smoke           initdb, boot, the wire protocol, every shipped module and conversion
 *   exports:check          the export list against exported_functions.txt
 *   data-format:check      the compatibility tuple against data-format.json
 *   prepopulated           the prepopulated data directory, at the commit's SOURCE_DATE_EPOCH
 *   prepopulated --check   the prepopulated data directory at the record's epoch, against its record
 *   regress                pg_regress against regress/baseline.json
 *
 * Then it writes .cache/gate/<commit>/: the release's files, `manifest.json` and `SHA256SUMS` (see
 * scripts/lib/gate.ts). The directory exists only for a commit whose gate passed; a new run replaces it. How each
 * step ended goes to .cache/gate/<commit>.steps.json, passed or not.
 *
 * The builder image:
 *   (default)     localhost/pgwasm-postgres-builder:6.0.10-p1, which must be in podman's local storage;
 *   --image       another image in podman's local storage;
 *   --lock        builder/image.lock.json decides, as in CI: the published image, pulled by digest, when the lock
 *                 records builder/'s content published; otherwise the image built from builder/ here;
 *   --published   with --lock: the published image or nothing (the release job: a release is built with it).
 * --keep-going   run every step even when one fails (but for a failed build, which leaves nothing to check), then
 *                fail on all that did: what `bun run bump` runs, to report every record a new upstream tag moves.
 * --summary      append a Markdown summary to <file> (the job summary in CI).
 *
 * It takes about 12 minutes (the build 8, pg_regress 2), more when the image is built. Not part of validate.
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { chooseBuilderImage } from "./lib/builder-image.ts";
import { builderContent } from "./lib/builder-lock.ts";
import { publishedDigest } from "./lib/builder.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { readUpstreamPin } from "./lib/config.ts";
import { DRIVER_FILES } from "./lib/driver/artefacts.ts";
import { coreSymbols, diffExports, readExportList } from "./lib/exports.ts";
import {
  digestFiles,
  formatGateManifest,
  formatGateSteps,
  formatSums,
  GATE_MANIFEST,
  gateDir,
  gateStaging,
  gateStepsFile,
  gateSummary,
  SUMS_FILE,
  verifyGateDir,
  type GateManifest,
  type GateStep,
} from "./lib/gate.ts";
import { git, UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { artefactPaths, MANIFEST_FILE, readManifest } from "./lib/manifest.ts";
import { imageId, refuseOtherContainers, repoDigests, requirePodman } from "./lib/podman.ts";
import { baselineDigest, readOutcome } from "./lib/regress/outcome.ts";

const USAGE = "Usage: bun run gate [--image <reference> | --lock [--published]] [--keep-going] [--summary <file>]";

interface Options {
  image: string | undefined;
  lock: boolean;
  published: boolean;
  keepGoing: boolean;
  summary: string | undefined;
}

function options(args: readonly string[]): Options {
  const parsed: Options = { image: undefined, lock: false, published: false, keepGoing: false, summary: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--lock") parsed.lock = true;
    else if (arg === "--published") parsed.published = true;
    else if (arg === "--keep-going") parsed.keepGoing = true;
    else if (arg === "--image" && value !== undefined) {
      parsed.image = value;
      index += 1;
    } else if (arg === "--summary" && value !== undefined) {
      parsed.summary = value;
      index += 1;
    } else throw new UserError(USAGE);
  }
  if ((parsed.lock && parsed.image !== undefined) || (parsed.published && !parsed.lock)) throw new UserError(USAGE);
  return parsed;
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

await runCliAsync(async () => {
  const args = options(process.argv.slice(2));
  const layout = layoutFor(repoRoot);
  const pin = readUpstreamPin(layout);
  const where = (path: string): string => relative(layout.root, path) || ".";
  const summarise = (markdown: string): void => {
    if (args.summary !== undefined) appendFileSync(args.summary, markdown);
  };

  const changes = git(["status", "--porcelain"], { cwd: layout.root }).stdout.trimEnd();
  if (changes !== "") {
    throw new UserError(
      [
        "gate: the working tree has changes; the gate is a commit's. Commit or stash them first:",
        ...changes.split("\n").map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  const commit = git(["rev-parse", "HEAD"], { cwd: layout.root }).stdout.trim();
  const epoch = Number(git(["log", "-1", "--format=%ct", "HEAD"], { cwd: layout.root }).stdout.trim());
  const inherited = process.env["SOURCE_DATE_EPOCH"];
  if (inherited !== undefined && inherited !== "" && inherited !== String(epoch)) {
    info(`gate: SOURCE_DATE_EPOCH=${inherited} in the environment is replaced by the commit's time, ${epoch}.`);
  }
  requirePodman();
  refuseOtherContainers();

  // The builder image.
  const content = builderContent(layout.builderDir);
  const image = await chooseBuilderImage(layout, args, "gate", info);
  const id = imageId(image);
  if (id === undefined) {
    throw new UserError(
      `gate: the builder image ${image} is not in podman's local storage; build it with \`bun run builder:image\`, or use --lock.`,
    );
  }
  const digest = publishedDigest(image, repoDigests(image));
  info(
    `gate: ${commit.slice(0, 12)}, SOURCE_DATE_EPOCH=${epoch} (${new Date(epoch * 1000).toISOString()}), builder ${image} (${id.slice(0, 12)}${digest === null ? ", not the published image" : ", published"})`,
  );

  const final = gateDir(layout, commit);
  const staging = gateStaging(layout, commit);
  const stepsFile = gateStepsFile(layout, commit);
  rmSync(final, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
  rmSync(stepsFile, { force: true });
  mkdirSync(staging, { recursive: true });

  const steps: readonly (readonly [name: string, script: string, args: readonly string[]])[] = [
    ["build", "build.ts", ["--image", image]],
    ["driver:smoke", "driver-smoke.ts", []],
    ["exports:check", "exports-check.ts", []],
    ["data-format:check", "data-format-check.ts", []],
    ["prepopulated", "prepopulated.ts", ["--out", join(staging, "prepopulated.tar.gz")]],
    ["prepopulated --check", "prepopulated.ts", ["--check"]],
    ["regress", "regress.ts", ["--image", image]],
  ];
  const timings: [string, number][] = [];
  const ran: GateStep[] = [];
  const env = { ...process.env, SOURCE_DATE_EPOCH: String(epoch) };
  for (const [name, script, stepArgs] of steps) {
    info(`\ngate: ── ${name} ──`);
    const started = Date.now();
    const exitCode = await Bun.spawn([process.execPath, join(layout.root, "scripts", script), ...stepArgs], {
      cwd: layout.root,
      env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
    timings.push([name, Date.now() - started]);
    ran.push({ name, exitCode, seconds: Math.round((Date.now() - started) / 1000) });
    // A failed build leaves nothing to check; with --keep-going, any other failed step lets the rest run.
    if (exitCode !== 0 && (!args.keepGoing || name === "build")) break;
  }
  const skipped = steps.slice(ran.length).map(([name]) => ({ name, exitCode: null, seconds: 0 }));
  writeFileSync(stepsFile, formatGateSteps({ commit, keepGoing: args.keepGoing, steps: [...ran, ...skipped] }));
  const failed = ran.filter((step) => step.exitCode !== 0);
  if (failed.length > 0) {
    const names = failed.map((step) => step.name);
    summarise(
      `### Engine gate FAILED at ${names.map((name) => `\`${name}\``).join(", ")} (\`${commit.slice(0, 12)}\`)\n\nEach step's own message is in the job log.\n\n`,
    );
    if (skipped.length > 0) info(`\ngate: not run: ${skipped.map((step) => step.name).join(", ")}`);
    throw new UserError(
      `\ngate: FAILED at ${failed.map((step) => `${step.name} (exit ${step.exitCode})`).join(", ")}; ${failed.length === 1 ? "its message is" : "their messages are"} above.`,
    );
  }

  // Collect the release.
  info("\ngate: ── the release ──");
  const dist = layout.buildDist;
  const build = readManifest(join(dist, MANIFEST_FILE), layout.root);
  const mismatch = [
    build.commit === commit ? undefined : `commit ${build.commit}`,
    build.worktreeClean ? undefined : "a modified working tree",
    build.debug ? "a debug build" : undefined,
    build.sourceDateEpoch === epoch ? undefined : `SOURCE_DATE_EPOCH ${build.sourceDateEpoch}`,
    build.builder.image === image && build.builder.id === id ? undefined : `the builder ${build.builder.image}`,
    build.dataFormat === null ? "no declared dataFormat" : undefined,
  ].filter((entry) => entry !== undefined);
  if (mismatch.length > 0 || build.dataFormat === null) {
    throw new UserError(`gate: ${where(join(dist, MANIFEST_FILE))} is not this gate's build: ${mismatch.join(", ")}.`);
  }
  const sources = [...artefactPaths(dist).map((path) => join(dist, path)), layout.dataFormatFile];
  const names = [...sources.map((source) => basename(source)), "prepopulated.tar.gz"];
  if (new Set(names).size !== names.length)
    throw new UserError(`gate: two release files share a name: ${names.join(", ")}`);
  for (const source of sources) copyFileSync(source, join(staging, basename(source)));

  const reference = readExportList(layout.exportsReference);
  const listed = readExportList(join(dist, "exported_functions.txt"));
  const core = coreSymbols(
    readFileSync(join(layout.overlayDir, "pglite", "static", "included.pglite.exports"), "utf8"),
  );
  const exportsDiff = diffExports(reference, listed, core);

  const outcome = readOutcome(layout);
  const byName = new Map(build.artefacts.map((artefact) => [basename(artefact.path), artefact.sha256]));
  const stale = DRIVER_FILES.filter((name) => outcome.ranWith[name] !== byName.get(name));
  if (!outcome.passed || stale.length > 0 || outcome.image !== image) {
    throw new UserError(
      `gate: the regress outcome is not this build's passed run (${outcome.passed ? `ran with other ${stale.join(", ") || "image"}` : "it failed"}).`,
    );
  }
  const regressDigest = baselineDigest(layout);
  if (outcome.baseline.sha256 !== regressDigest) throw new UserError("gate: regress/ changed during the run.");

  const manifest: GateManifest = {
    version: build.version,
    commit,
    tree: build.tree,
    sourceDateEpoch: epoch,
    upstream: { tag: pin.tag, commit: pin.commit },
    dataFormat: build.dataFormat,
    tuple: build.tuple,
    builder: { image, id, digest, contentSha256: content },
    exports: { symbols: listed.length, added: [...exportsDiff.added], removed: [...exportsDiff.removed] },
    regress: {
      schedule: outcome.schedule,
      baselineSha256: regressDigest,
      ...outcome.baseline.summary,
      vanished: [...outcome.comparison.vanished],
    },
    files: digestFiles(staging, names),
  };
  writeFileSync(join(staging, GATE_MANIFEST), formatGateManifest(manifest));
  writeFileSync(join(staging, SUMS_FILE), formatSums(digestFiles(staging, [...names, GATE_MANIFEST])));
  const problems = verifyGateDir(staging, manifest);
  if (problems.length > 0) throw new Error(`gate: the directory it wrote is inconsistent: ${problems.join("; ")}`);
  renameSync(staging, final);

  for (const file of manifest.files) {
    info(`gate: ${file.name.padEnd(24)} ${String(file.bytes).padStart(10)}  ${file.sha256}`);
  }
  info(`gate: ${timings.map(([name, ms]) => `${name} ${seconds(ms)}`).join(", ")}`);
  info(`gate: passed: pgwasm-postgres ${manifest.version} at ${commit.slice(0, 12)}; the release is ${where(final)}.`);
  summarise(gateSummary(manifest));
});
