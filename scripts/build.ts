/**
 * bun run build
 *
 * The byte-identity build (ADR-0001 decision 2): proves the series (`patches:check`), materialises its tree and
 * the extensions of extensions.json into .cache/build/postgres-pglite (gitignored; the previous build there is
 * deleted), and runs `build-pglite.sh` on it in the builder image, as ElectricSQL's CI ran it for 0.5.8 (see
 * scripts/lib/build.ts). The artefacts land in .cache/build/postgres-pglite/dist; the full log in
 * .cache/build/build.log. About 15 minutes. Then `bun run build:verify`.
 *
 * Not part of validate or CI: it takes too long, and the image is not published yet.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { readArtefactRecord } from "./lib/artefacts.ts";
import { BUILD_CONTAINER, buildCommand, buildPaths } from "./lib/build.ts";
import { BUILDER_IMAGE } from "./lib/builder.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { imageId, refuseOtherContainers, removeBuildOutput, removeContainer, requirePodman } from "./lib/podman.ts";
import { materialiseSource } from "./lib/source.ts";

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s (${seconds} s)`;
}

await runCliAsync(async () => {
  if (process.argv.length > 2) throw new UserError("Usage: bun run build");
  const layout = layoutFor(repoRoot);
  const record = readArtefactRecord(layout);
  const image = BUILDER_IMAGE;

  requirePodman();
  const id = imageId(image);
  if (id === undefined) {
    throw new UserError(
      `The builder image ${image} is not in podman's local storage; build it with \`bun run builder:image\`.`,
    );
  }
  refuseOtherContainers();

  const started = new Date();
  const paths = buildPaths(layout);
  const logFile = join(layout.buildDir, "build.log");
  const manifestFile = join(layout.buildDir, "build.json");
  removeBuildOutput(layout.buildDir);
  mkdirSync(layout.buildDir, { recursive: true });

  const source = materialiseSource(layout, paths.source, info);
  if (source.tree !== record.tree) {
    throw new UserError(
      `${record.file} records the artefacts of tree ${record.tree}, but the series gives ${source.tree}. The record only holds for its tree.`,
    );
  }
  mkdirSync(paths.dist); // docker creates a missing bind-mount source; podman refuses one

  const manifest = {
    tree: source.tree,
    extensions: source.extensions,
    image,
    imageId: id,
    recipe: record.build,
    startedAt: started.toISOString(),
  };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const command = buildCommand(image, record.build, paths);
  info(`build: ${image} (${id.slice(0, 12)}), source at ${record.build.sourcePath}`);
  info(`build: ${command.join(" ")}`);
  info(`build: log at ${relative(layout.root, logFile)} (about 15 minutes)`);

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
    manifestFile,
    `${JSON.stringify({ ...manifest, finishedAt: new Date().toISOString(), exitCode, buildSeconds: Math.round(wall / 1000) }, null, 2)}\n`,
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
  info(`build: done in ${duration(wall)}; the artefacts are in ${relative(layout.root, paths.dist)}.`);
  info("build: next, `bun run build:verify`.");
});
