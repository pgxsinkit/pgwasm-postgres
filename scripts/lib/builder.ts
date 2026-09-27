/**
 * The builder image (ADR-0001 decision 9), built from builder/Containerfile. Locally it is
 * {@link BUILDER_IMAGE}; `builder-image.yml` publishes it as {@link publishedImage} on GHCR, and
 * builder/image.lock.json records the digest it was published at (see builder-lock.ts). Every script that runs it
 * takes the reference as `--image`; the manifests record the reference and the id each build ran.
 */
import { join } from "node:path";

import { ALL_CAPS, type ResourceCaps } from "./podman.ts";

/**
 * `3.1.74` is the Emscripten version (pinned until its own release, see the Containerfile); `-p2` counts
 * revisions of our pinned image on that Emscripten (`-p1` was the byte-identity image, `-p2` the amcheck-only one).
 * A change to builder/ is a new revision: a published tag is never pushed again with other content.
 */
export const BUILDER_IMAGE = "localhost/pgwasm-postgres-builder:3.1.74-p2";

/** Where `builder-image.yml` publishes the image, under the local image's tag. */
export const PUBLISHED_REPOSITORY = "ghcr.io/pgxsinkit/pgwasm-builder";

/** An image reference's tag (`3.1.74-p2`), or `undefined` for a digest reference or one without a tag. */
export function imageTag(reference: string): string | undefined {
  if (reference.includes("@")) return undefined;
  const name = reference.slice(reference.lastIndexOf("/") + 1);
  const colon = name.indexOf(":");
  return colon === -1 ? undefined : name.slice(colon + 1);
}

/** The published image's reference by tag: {@link PUBLISHED_REPOSITORY} with the local image's tag. */
export function publishedImage(local: string = BUILDER_IMAGE): string {
  const tag = imageTag(local);
  if (tag === undefined) throw new Error(`publishedImage: ${local} has no tag.`);
  return `${PUBLISHED_REPOSITORY}:${tag}`;
}

/** A reference by digest: `<repository>@sha256:…`. */
export function digestReference(repository: string, digest: string): string {
  return `${repository}@${digest}`;
}

/**
 * The published image's digest, when an image is the published one: the digest of a reference by digest to
 * {@link PUBLISHED_REPOSITORY}, or one podman recorded for that repository (`RepoDigests`: pulled or pushed).
 * Null for a local build that was never published.
 */
export function publishedDigest(reference: string, repoDigests: readonly string[]): string | null {
  const prefix = `${PUBLISHED_REPOSITORY}@`;
  const found = [reference, ...repoDigests].find((entry) => entry.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

export interface BuilderPaths {
  readonly containerfile: string;
  readonly context: string;
  /** The `make` resource cap, bind-mounted for every RUN step. */
  readonly make: string;
  /** The runner stage's package set, `<package>=<version>` per line, sorted bytewise. */
  readonly dpkgExpected: string;
}

export function builderPaths(builderDir: string): BuilderPaths {
  return {
    containerfile: join(builderDir, "Containerfile"),
    context: builderDir,
    make: join(builderDir, "bin", "make"),
    dpkgExpected: join(builderDir, "dpkg-expected.txt"),
  };
}

/**
 * `podman build`, capped: 4 CPUs and 16 GiB (those podman can apply, see podman.ts), and builder/bin/make at /usr/local/bin/{make,gmake} in every RUN
 * step (CMake picks gmake first), turning a bare `make -j` / `cmake --build . -j` into -j4; buildah removes the
 * mount points afterwards, so nothing of it lands in the image. `--format docker`: the Containerfile uses SHELL,
 * which the OCI format cannot record (ElectricSQL builds with BuildKit, whose images are Docker-format too).
 */
export function imageBuildCommand(
  paths: BuilderPaths,
  image: string = BUILDER_IMAGE,
  caps: ResourceCaps = ALL_CAPS,
): string[] {
  return [
    "nice",
    "-n",
    "10",
    "podman",
    "build",
    "--format",
    "docker",
    "--layers",
    "--force-rm",
    ...(caps.cpu ? ["--cpu-period", "100000", "--cpu-quota", "400000"] : []),
    ...(caps.memory ? ["--memory", "16g"] : []),
    "-v",
    `${paths.make}:/usr/local/bin/make:ro`,
    "-v",
    `${paths.make}:/usr/local/bin/gmake:ro`,
    "-f",
    paths.containerfile,
    "-t",
    image,
    paths.context,
  ];
}

/** Lists the image's installed packages, one `<package>=<version>` per line (the caller sorts). */
export const DPKG_QUERY = ["dpkg-query", "--show", "--showformat=${Package}=${Version}\\n"] as const;

/** Sorts lines bytewise (as `LC_ALL=C sort` does) and drops empty ones. */
export function sortedLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** Differences between the expected and the actual package lists, as `-expected` / `+actual` lines. */
export function diffPackages(expected: readonly string[], actual: readonly string[]): string[] {
  const want = new Set(expected);
  const got = new Set(actual);
  return [
    ...expected.filter((line) => !got.has(line)).map((line) => `-${line}`),
    ...actual.filter((line) => !want.has(line)).map((line) => `+${line}`),
  ];
}

/**
 * `podman push` of the local image to the published reference, as Docker's v2s2 manifest: the image is built with
 * `--format docker` (it records SHELL), and keeping that format keeps its config, so a pull by digest gives the
 * local image's id back. `--digestfile` receives the digest of what the registry stored.
 */
export function imagePushCommand(local: string, published: string, digestFile: string): string[] {
  return ["podman", "push", "--format", "v2s2", "--digestfile", digestFile, local, `docker://${published}`];
}
