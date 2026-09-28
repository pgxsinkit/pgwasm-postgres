/**
 * Building and publishing the builder image (ADR-0001 decision 9), for `bun run builder:image` and for the gate,
 * which builds it in the job when builder/ has changed since the published image (see builder-lock.ts).
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { builderContent, chooseBuilder, readLock } from "./builder-lock.ts";
import {
  BUILDER_IMAGE,
  builderPaths,
  diffPackages,
  DPKG_QUERY,
  imageBuildCommand,
  imagePushCommand,
  sortedLines,
} from "./builder.ts";
import { UserError } from "./git.ts";
import type { Layout } from "./layout.ts";
import {
  CONTAINER_PREFIX,
  imageId,
  podman,
  pullImage,
  removeContainer,
  resourceCaps,
  type ResourceCaps,
} from "./podman.ts";

type Log = (line: string) => void;

function tail(file: string, lines: number): string[] {
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .map((line) => `  | ${line}`);
}

/**
 * Builds builder/Containerfile as `image` (amd64 only), then checks the image's package set against
 * builder/dpkg-expected.txt. The log goes to .cache/builder-image.log. Returns the image's id.
 */
export async function buildBuilderImage(layout: Layout, image: string, caps: ResourceCaps, log: Log): Promise<string> {
  if (process.arch !== "x64") {
    throw new UserError(
      `The builder image is amd64 only (its toolchain is pinned by amd64 digest); this is ${process.arch}.`,
    );
  }
  const paths = builderPaths(layout.builderDir);
  mkdirSync(layout.cacheDir, { recursive: true });
  const logFile = join(layout.cacheDir, "builder-image.log");
  const command = imageBuildCommand(paths, image, caps);
  log(`builder:image: ${command.join(" ")}`);
  log(`builder:image: log at ${relative(layout.root, logFile)} (about 40 minutes without the layer cache)`);
  const fd = openSync(logFile, "w");
  const started = Date.now();
  const exitCode = await Bun.spawn(command, { stdin: "ignore", stdout: fd, stderr: fd }).exited;
  closeSync(fd);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (exitCode !== 0) {
    throw new UserError(
      [`builder:image: podman build failed (exit ${exitCode}) after ${seconds} s:`, ...tail(logFile, 30)].join("\n"),
    );
  }
  const id = imageId(image);
  if (id === undefined) throw new UserError(`builder:image: podman build succeeded, but ${image} is not there.`);
  log(`builder:image: built ${image} (${id.slice(0, 12)}) in ${seconds} s.`);

  const checker = `${CONTAINER_PREFIX}dpkg-check`;
  const query = podman(
    ["run", "--rm", "--name", checker, "--pull=never", "--entrypoint", DPKG_QUERY[0], image, ...DPKG_QUERY.slice(1)],
    { allowFailure: true },
  );
  removeContainer(checker);
  if (query.exitCode !== 0) {
    throw new UserError(`builder:image: dpkg-query failed in the image:\n${query.stderr.trim()}`);
  }
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
  log(
    `builder:image: the package set matches ${relative(layout.root, paths.dpkgExpected)} (${expected.length} packages).`,
  );
  return id;
}

/** Pushes the local image to `published` (by tag) and returns the digest the registry stored it at. */
export async function pushBuilderImage(layout: Layout, local: string, published: string, log: Log): Promise<string> {
  mkdirSync(layout.cacheDir, { recursive: true });
  const digestFile = join(layout.cacheDir, "builder-image.digest");
  const logFile = join(layout.cacheDir, "builder-push.log");
  rmSync(digestFile, { force: true });
  const command = imagePushCommand(local, published, digestFile);
  log(`builder:image: ${command.join(" ")}`);
  const fd = openSync(logFile, "w");
  const exitCode = await Bun.spawn(command, { stdin: "ignore", stdout: fd, stderr: fd }).exited;
  closeSync(fd);
  if (exitCode !== 0) {
    throw new UserError(
      [
        `builder:image: podman push failed (exit ${exitCode}); is podman logged in to ${published.split("/")[0] ?? ""}?`,
        ...tail(logFile, 20),
      ].join("\n"),
    );
  }
  const digest = readFileSync(digestFile, "utf8").trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new UserError(`builder:image: podman push wrote no digest to ${relative(layout.root, digestFile)}.`);
  }
  return digest;
}

/** Which builder image a script runs in: `--image`, or `--lock` (with `--published`: the published image or nothing). */
export interface ImageOptions {
  readonly image: string | undefined;
  readonly lock: boolean;
  readonly published: boolean;
}

/**
 * The builder image for `options` (the default: the local image). With `--lock`, builder/image.lock.json decides,
 * as in CI: the published image, pulled by digest and checked against the lock's id, when the lock records
 * builder/'s content published; otherwise the image built from builder/ here, which `--published` refuses.
 * `command` names the script in the messages.
 */
export async function chooseBuilderImage(
  layout: Layout,
  options: ImageOptions,
  command: string,
  log: Log,
): Promise<string> {
  if (!options.lock) return options.image ?? BUILDER_IMAGE;
  const choice = chooseBuilder(readLock(layout.builderDir, layout.root), builderContent(layout.builderDir));
  if (choice.kind === "build") {
    if (options.published) {
      throw new UserError(
        `${command}: a release is built in the published builder image, by digest, but ${choice.reason}. Publish builder/ (builder-image.yml), record it with \`bun run builder:lock\`, and release a commit whose lock records builder/'s content.`,
      );
    }
    log(`${command}: building the builder image from builder/: ${choice.reason}.`);
    await buildBuilderImage(layout, BUILDER_IMAGE, resourceCaps(log), log);
    return BUILDER_IMAGE;
  }
  log(`${command}: pulling the published builder image ${choice.reference}`);
  pullImage(choice.reference);
  const pulled = imageId(choice.reference);
  if (pulled !== choice.id) {
    throw new UserError(
      `${command}: ${choice.reference} has the id ${pulled ?? "(none)"}, but the lock records ${choice.id}.`,
    );
  }
  return choice.reference;
}
