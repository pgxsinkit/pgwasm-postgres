/**
 * The build, still as ElectricSQL CI's `build-with-docker.sh` invocation for `@electric-sql/pglite@0.5.8` ran it
 * (the byte-identity build of ADR-0001 decision 2), with podman and our builder image. From `build-with-docker.sh` (overlay, as at `b133782`):
 *
 *   docker run --rm -e DEBUG=false -e PGLITE_VERSION=0.5.8 --workdir=$(pwd) -v .:$(pwd):rw -v ./dist:/pglite:rw \
 *     electricsql/pglite-builder:3.1.74-7 ./build-pglite.sh
 *
 * with `$(pwd)` = `/home/runner/_work/pglite/pglite/postgres-pglite` on ElectricSQL's runner. The container runs
 * as root with umask 022, no `TZ` and no `LANG`/`LC_*` (podman passes none of the host's environment), and
 * `--unsetenv container` drops the one variable podman adds and docker does not.
 *
 * Resource caps that change no compiler input: `builder/bin/make` over `/usr/local/bin/make` turns the script's
 * bare `make -j` into `make -j4`; the container gets 4 CPUs and 16 GiB; podman (and so the build) runs under
 * `nice -n 10`.
 */
import { join } from "node:path";

import type { Layout } from "./layout.ts";
import { CONTAINER_PREFIX } from "./podman.ts";

/** The build inputs besides the source and the image. */
export interface BuildRecipe {
  /** Where the source is mounted and the build runs (embedded in pglite.wasm and pglite.data). */
  readonly sourcePath: string;
  /** What `build-with-docker.sh` passes with `-e`, in order. */
  readonly environment: Readonly<Record<string, string>>;
}

/** ElectricSQL CI's inputs for 0.5.8: the checkout path, and the environment `build-with-docker.sh` passes. */
export const RECIPE: BuildRecipe = {
  sourcePath: "/home/runner/_work/pglite/pglite/postgres-pglite",
  environment: { DEBUG: "false", PGLITE_VERSION: "0.5.8" },
};

/** The build container's name: one build at a time. */
export const BUILD_CONTAINER = `${CONTAINER_PREFIX}build`;

/** `build-pglite.sh`'s output folder (its `INSTALL_FOLDER` default), where `build-with-docker.sh` mounts `./dist`. */
export const OUTPUT_MOUNT = "/pglite";

/** Where `builder/bin/make` goes: ahead of `/usr/bin/make` on the image's PATH. */
export const MAKE_MOUNT = "/usr/local/bin/make";

export interface BuildPaths {
  /** The materialised source tree on the host. */
  readonly source: string;
  /** Its `dist/`, which receives the artefacts. */
  readonly dist: string;
  /** `builder/bin/make`. */
  readonly make: string;
}

export function buildPaths(layout: Layout): BuildPaths {
  return { source: layout.buildSource, dist: layout.buildDist, make: join(layout.builderDir, "bin", "make") };
}

/** A bind mount's host path: podman's `-v` syntax cannot carry `:` or `,`. */
function mountable(path: string): string {
  if (/[:,]/.test(path)) throw new Error(`Cannot bind-mount ${path}: the path contains ":" or ",".`);
  return path;
}

/** The command `bun run build` runs. */
export function buildCommand(image: string, recipe: BuildRecipe, paths: BuildPaths): string[] {
  return [
    "nice",
    "-n",
    "10",
    "podman",
    "run",
    "--rm",
    "--name",
    BUILD_CONTAINER,
    "--pull=never",
    "--cpus",
    "4",
    "--memory",
    "16g",
    "--umask",
    "0022",
    "--unsetenv",
    "container",
    ...Object.entries(recipe.environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    `--workdir=${recipe.sourcePath}`,
    "-v",
    `${mountable(paths.source)}:${recipe.sourcePath}:rw`,
    "-v",
    `${mountable(paths.dist)}:${OUTPUT_MOUNT}:rw`,
    "-v",
    `${mountable(paths.make)}:${MAKE_MOUNT}:ro`,
    image,
    "./build-pglite.sh",
  ];
}
