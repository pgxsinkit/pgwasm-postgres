/**
 * bun run gate [--image <reference> | --lock [--published]] [--summary <file>]
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
 * scripts/lib/gate.ts). The directory exists only for a commit whose gate passed; a new run replaces it.
 *
 * The builder image:
 *   (default)     localhost/pgwasm-postgres-builder:3.1.74-p2, which must be in podman's local storage;
 *   --image       another image in podman's local storage;
 *   --lock        builder/image.lock.json decides, as in CI: the published image, pulled by digest, when the lock
 *                 records builder/'s content published; otherwise the image built from builder/ here;
 *   --published   with --lock: the published image or nothing (the release job: a release is built with it).
 * --summary      append a Markdown summary to <file> (the job summary in CI).
 *
 * It takes about 12 minutes (the build 8, pg_regress 2), more when the image is built. Not part of validate.
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { buildBuilderImage } from "./lib/builder-image.ts";
import { builderContent, chooseBuilder, readLock } from "./lib/builder-lock.ts";
import { BUILDER_IMAGE, publishedDigest } from "./lib/builder.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { readUpstreamPin } from "./lib/config.ts";
import { DRIVER_FILES } from "./lib/driver/artefacts.ts";
import { coreSymbols, diffExports, readExportList } from "./lib/exports.ts";
import {
  digestFiles,
  formatGateManifest,
  formatSums,
  GATE_MANIFEST,
  gateDir,
  gateSummary,
  SUMS_FILE,
  verifyGateDir,
  type GateManifest,
} from "./lib/gate.ts";
import { git, UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { artefactPaths, MANIFEST_FILE, readManifest } from "./lib/manifest.ts";
import { imageId, pullImage, refuseOtherContainers, repoDigests, requirePodman, resourceCaps } from "./lib/podman.ts";
import { baselineDigest, readOutcome } from "./lib/regress/outcome.ts";

const USAGE = "Usage: bun run gate [--image <reference> | --lock [--published]] [--summary <file>]";

interface Options {
  image: string | undefined;
  lock: boolean;
  published: boolean;
  summary: string | undefined;
}

function options(args: readonly string[]): Options {
  const parsed: Options = { image: undefined, lock: false, published: false, summary: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--lock") parsed.lock = true;
    else if (arg === "--published") parsed.published = true;
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
  let image = args.image ?? BUILDER_IMAGE;
  if (args.lock) {
    const choice = chooseBuilder(readLock(layout.builderDir, layout.root), content);
    if (choice.kind === "build") {
      if (args.published) {
        throw new UserError(
          `gate: a release is built in the published builder image, by digest, but ${choice.reason}. Publish builder/ (builder-image.yml), record it with \`bun run builder:lock\`, and release a commit whose lock records builder/'s content.`,
        );
      }
      info(`gate: building the builder image from builder/: ${choice.reason}.`);
      await buildBuilderImage(layout, BUILDER_IMAGE, resourceCaps(info), info);
      image = BUILDER_IMAGE;
    } else {
      info(`gate: pulling the published builder image ${choice.reference}`);
      pullImage(choice.reference);
      const pulled = imageId(choice.reference);
      if (pulled !== choice.id) {
        throw new UserError(
          `gate: ${choice.reference} has the id ${pulled ?? "(none)"}, but the lock records ${choice.id}.`,
        );
      }
      image = choice.reference;
    }
  }
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
  const staging = `${final}.partial`;
  rmSync(final, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
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
    if (exitCode !== 0) {
      summarise(
        `### Engine gate FAILED at \`${name}\` (\`${commit.slice(0, 12)}\`)\n\nIts own message is in the job log.\n\n`,
      );
      throw new UserError(`\ngate: FAILED at ${name} (exit ${exitCode}); its message is above.`);
    }
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
