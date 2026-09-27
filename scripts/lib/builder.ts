/**
 * The builder image (ADR-0001 decision 9), built from builder/Containerfile. Local only until the image is
 * published; the build references it by this name, and `build.json` records the id it ran.
 */
import { join } from "node:path";

/**
 * `3.1.74` is the Emscripten version (pinned until 18.3.0, see the Containerfile); `-p1` counts revisions of
 * our pinned image on that Emscripten.
 */
export const BUILDER_IMAGE = "localhost/pgwasm-postgres-builder:3.1.74-p1";

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
 * `podman build`, capped: 4 CPUs and 16 GiB, and builder/bin/make at /usr/local/bin/{make,gmake} in every RUN
 * step (CMake picks gmake first), turning a bare `make -j` / `cmake --build . -j` into -j4; buildah removes the
 * mount points afterwards, so nothing of it lands in the image. `--format docker`: the Containerfile uses SHELL,
 * which the OCI format cannot record (ElectricSQL builds with BuildKit, whose images are Docker-format too).
 */
export function imageBuildCommand(paths: BuilderPaths, image: string = BUILDER_IMAGE): string[] {
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
    "--cpu-period",
    "100000",
    "--cpu-quota",
    "400000",
    "--memory",
    "16g",
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
