/**
 * bun run builder:image
 *
 * Builds the builder image from builder/Containerfile with podman, as localhost/pgwasm-postgres-builder:3.1.74-p2
 * (amd64 only), capped at 4 CPUs, 16 GiB and `make -j4`. From scratch it takes about 40 minutes; podman's layer
 * cache makes an unchanged rebuild take seconds. Then checks the image's package set against
 * builder/dpkg-expected.txt. The full log goes to .cache/builder-image.log.
 *
 * Not part of validate or CI: it takes too long, and the image is not published yet.
 */
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  BUILDER_IMAGE,
  builderPaths,
  diffPackages,
  DPKG_QUERY,
  imageBuildCommand,
  sortedLines,
} from "./lib/builder.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import {
  CONTAINER_PREFIX,
  imageId,
  podman,
  refuseOtherContainers,
  removeContainer,
  requirePodman,
} from "./lib/podman.ts";

await runCliAsync(async () => {
  if (process.argv.length > 2) throw new UserError("Usage: bun run builder:image");
  const layout = layoutFor(repoRoot);
  const paths = builderPaths(layout.builderDir);
  requirePodman();
  if (process.arch !== "x64") {
    throw new UserError(
      `The builder image is amd64 only (its toolchain is pinned by amd64 digest); this is ${process.arch}.`,
    );
  }
  refuseOtherContainers();

  mkdirSync(layout.cacheDir, { recursive: true });
  const logFile = join(layout.cacheDir, "builder-image.log");
  const command = imageBuildCommand(paths);
  info(`builder:image: ${command.join(" ")}`);
  info(`builder:image: log at ${relative(layout.root, logFile)} (about 40 minutes without the layer cache)`);
  const log = openSync(logFile, "w");
  const started = Date.now();
  const child = Bun.spawn(command, { stdin: "ignore", stdout: log, stderr: log });
  const exitCode = await child.exited;
  closeSync(log);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (exitCode !== 0) {
    const tail = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-30);
    throw new UserError(
      [
        `builder:image: podman build failed (exit ${exitCode}) after ${seconds} s:`,
        ...tail.map((line) => `  | ${line}`),
      ].join("\n"),
    );
  }
  const id = imageId(BUILDER_IMAGE);
  if (id === undefined)
    throw new UserError(`builder:image: podman build succeeded, but ${BUILDER_IMAGE} is not there.`);
  info(`builder:image: built ${BUILDER_IMAGE} (${id.slice(0, 12)}) in ${seconds} s.`);

  const checker = `${CONTAINER_PREFIX}dpkg-check`;
  const query = podman(
    [
      "run",
      "--rm",
      "--name",
      checker,
      "--pull=never",
      "--entrypoint",
      DPKG_QUERY[0],
      BUILDER_IMAGE,
      ...DPKG_QUERY.slice(1),
    ],
    { allowFailure: true },
  );
  removeContainer(checker);
  if (query.exitCode !== 0)
    throw new UserError(`builder:image: dpkg-query failed in the image:\n${query.stderr.trim()}`);
  const expected = sortedLines(readFileSync(paths.dpkgExpected, "utf8"));
  const differences = diffPackages(expected, sortedLines(query.stdout));
  if (differences.length > 0) {
    throw new UserError(
      [
        `builder:image: the image's package set differs from ${relative(layout.root, paths.dpkgExpected)}:`,
        ...differences.map((line) => `  ${line}`),
        "The runner stage's apt comes from a dated snapshot, so it cannot drift by itself: check the Containerfile.",
      ].join("\n"),
    );
  }
  info(
    `builder:image: the package set matches ${relative(layout.root, paths.dpkgExpected)} (${expected.length} packages).`,
  );
});
