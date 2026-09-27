/**
 * bun run build [--debug]
 *
 * The build (ADR-0001 decisions 3, 5 and 9): proves the series (`patches:check`), materialises its tree into
 * .cache/build/postgres-pglite (gitignored; the previous build there is deleted), and runs `build-pglite.sh` on
 * it in the builder image (see scripts/lib/build.ts): the source at /build, the candidate version of HEAD
 * (scripts/lib/version.ts), SOURCE_DATE_EPOCH = the commit time of HEAD (or the environment's), LC_ALL=C.
 * The artefacts land in .cache/build/postgres-pglite/dist, with `manifest.json` next to them (every artefact's bytes
 * and sha256, the version, the compatibility tuple of a fresh initdb); the full log in .cache/build/build.log.
 * Two builds of one commit, from any checkout, give identical manifests (`bun run build:verify <manifest>`).
 *
 * --debug  a debug build (-g, no wasm-opt), whose debug info points at the materialised source on the host.
 *
 * Not part of validate or CI: it takes minutes, and the image is not published yet.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BUILD_CONTAINER, buildCommand, buildPaths, type BuildInputs } from "./lib/build.ts";
import { BUILDER_IMAGE } from "./lib/builder.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { readUpstreamPin } from "./lib/config.ts";
import { readDataFormat, sameTuple, tupleOfEntries } from "./lib/data-format.ts";
import { loadArtefacts } from "./lib/driver/artefacts.ts";
import { sourceDateEpoch } from "./lib/driver/determinism.ts";
import { initdb } from "./lib/driver/initdb.ts";
import { git, UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { digestArtefacts, formatManifest, MANIFEST_FILE, type BuildManifest } from "./lib/manifest.ts";
import { imageId, refuseOtherContainers, removeBuildOutput, removeContainer, requirePodman } from "./lib/podman.ts";
import { materialiseSource } from "./lib/source.ts";
import { repositoryCandidate } from "./lib/version.ts";

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s (${seconds} s)`;
}

await runCliAsync(async () => {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--debug")) {
    throw new UserError("Usage: bun run build [--debug]");
  }
  const layout = layoutFor(repoRoot);
  const pin = readUpstreamPin(layout);
  const image = BUILDER_IMAGE;

  requirePodman();
  const id = imageId(image);
  if (id === undefined) {
    throw new UserError(
      `The builder image ${image} is not in podman's local storage; build it with \`bun run builder:image\`.`,
    );
  }
  refuseOtherContainers();

  const inputs: BuildInputs = {
    version: repositoryCandidate(layout.root, pin.tag),
    sourceDateEpoch: sourceDateEpoch(layout.root),
    debug: args[0] === "--debug",
  };
  const commit = git(["rev-parse", "HEAD"], { cwd: layout.root }).stdout.trim();
  const worktreeClean = git(["status", "--porcelain"], { cwd: layout.root }).stdout.trim() === "";

  const started = new Date();
  const paths = buildPaths(layout);
  const logFile = join(layout.buildDir, "build.log");
  const recordFile = join(layout.buildDir, "build.json");
  removeBuildOutput(layout.buildDir);
  mkdirSync(layout.buildDir, { recursive: true });

  const source = materialiseSource(layout, paths.source, info);
  mkdirSync(paths.dist); // podman refuses a missing bind-mount source

  const record = { ...inputs, commit, worktreeClean, tree: source.tree, image, imageId: id };
  writeFileSync(recordFile, `${JSON.stringify({ ...record, startedAt: started.toISOString() }, null, 2)}\n`);

  const command = buildCommand(image, inputs, paths);
  info(
    `build: ${inputs.version}${inputs.debug ? " (debug)" : ""} from ${commit.slice(0, 12)}${worktreeClean ? "" : " with a modified working tree"}, SOURCE_DATE_EPOCH=${inputs.sourceDateEpoch} (${new Date(inputs.sourceDateEpoch * 1000).toISOString()})`,
  );
  info(`build: ${image} (${id.slice(0, 12)})`);
  info(`build: ${command.join(" ")}`);
  info(`build: log at ${relative(layout.root, logFile)} (about 10 minutes)`);

  const log = openSync(logFile, "w");
  const runStarted = Date.now();
  const child = Bun.spawn(command, { stdin: "ignore", stdout: log, stderr: log });
  const interrupt = (signal: NodeJS.Signals): void => {
    info(`build: ${signal}: removing ${BUILD_CONTAINER}`);
    removeContainer(BUILD_CONTAINER);
    process.exit(130);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const exitCode = await child.exited;
  closeSync(log);
  const wall = Date.now() - runStarted;

  writeFileSync(
    recordFile,
    `${JSON.stringify({ ...record, startedAt: started.toISOString(), finishedAt: new Date().toISOString(), exitCode, buildSeconds: Math.round(wall / 1000) }, null, 2)}\n`,
  );
  if (exitCode !== 0) {
    removeContainer(BUILD_CONTAINER);
    const tail = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-30);
    throw new UserError(
      [
        `build: build-pglite.sh failed (exit ${exitCode}) after ${duration(wall)}. The last lines of ${relative(layout.root, logFile)}:`,
        ...tail.map((line) => `  | ${line}`),
      ].join("\n"),
    );
  }
  info(`build: built in ${duration(wall)}.`);

  // The compatibility tuple of the build's data directories (ADR-0001 decision 8): a fresh initdb's.
  const tuple = tupleOfEntries(await initdb(await loadArtefacts(paths.dist)));
  const declaration = readDataFormat(layout);
  const dataFormat = [declaration, ...declaration.previous].find((format) => sameTuple(format.tuple, tuple));
  const manifest: BuildManifest = {
    version: inputs.version,
    upstream: { tag: pin.tag, commit: pin.commit },
    commit,
    worktreeClean,
    tree: source.tree,
    sourceDateEpoch: inputs.sourceDateEpoch,
    debug: inputs.debug,
    builder: { image, id },
    dataFormat: dataFormat?.dataFormat ?? null,
    tuple,
    artefacts: digestArtefacts(paths.dist),
  };
  const manifestFile = join(paths.dist, MANIFEST_FILE);
  writeFileSync(manifestFile, formatManifest(manifest));
  for (const artefact of manifest.artefacts) {
    info(`build: ${artefact.path.padEnd(28)} ${String(artefact.bytes).padStart(10)}  ${artefact.sha256}`);
  }
  info(
    `build: dataFormat ${manifest.dataFormat ?? "NONE (the tuple is not declared: run `bun run data-format:check`)"}; the manifest is ${relative(layout.root, manifestFile)}.`,
  );
  info(`build: the artefacts are in ${relative(layout.root, paths.dist)}.`);
});
