/**
 * The build (ADR-0001 decision 9): `build-pglite.sh` on the materialised source, in the builder image, reproducible
 * from any checkout:
 *
 * - the source is mounted at a fixed path, {@link SOURCE_MOUNT}, wherever the checkout is (paths reach the
 *   artefacts: pg_config's flags, pgxs's Makefile.global in postgres.data, `__FILE__` in error reports);
 * - `SOURCE_DATE_EPOCH` is the commit time of HEAD, the extension archives' member mtimes;
 * - it runs under `LC_ALL=C`, as root with umask 022 and no `TZ`, and `--unsetenv container` drops the one
 *   variable podman adds;
 * - `PGWASM_POSTGRES_VERSION` is the candidate version (see version.ts), which `version()` names.
 *
 * A debug build (`DEBUG=true`, `-g`) also gets the checkout's host path as `HOST_SOURCE_DIR`, which
 * `build-pglite.sh` turns into `-ffile-prefix-map=/build=<host path>`, so that its debug info points at the files
 * on the host. A release build never sees the host path.
 *
 * Resource caps that change no compiler input: `builder/bin/make` over `/usr/local/bin/make` turns the script's
 * bare `make -j` into `make -j4`; the container gets 4 CPUs and 16 GiB (the caps podman can apply here, see
 * podman.ts); podman (and so the build) runs under `nice -n 10`.
 */
import { join } from "node:path";

import type { Layout } from "./layout.ts";
import { ALL_CAPS, CONTAINER_PREFIX, type ResourceCaps } from "./podman.ts";

/** The build container's name: one build at a time. */
export const BUILD_CONTAINER = `${CONTAINER_PREFIX}build`;

/** Where the source is mounted, and the build runs, whatever the host path of the checkout. */
export const SOURCE_MOUNT = "/build";

/** `build-pglite.sh`'s output folder (its `INSTALL_FOLDER` default), where the build's `dist/` is mounted. */
export const OUTPUT_MOUNT = "/pgwasm";

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

/** What a build is made from, besides the source and the image. */
export interface BuildInputs {
  /** The release version `version()` names (`18.3.0`). */
  readonly version: string;
  /** The commit time of HEAD, in seconds. */
  readonly sourceDateEpoch: number;
  /** A debug build: `-g`, no wasm-opt, and debug info that points at the host's checkout. */
  readonly debug: boolean;
}

/** The environment the build runs with, in the order it is passed. */
export function buildEnvironment(inputs: BuildInputs, paths: BuildPaths): Record<string, string> {
  return {
    DEBUG: inputs.debug ? "true" : "false",
    PGWASM_POSTGRES_VERSION: inputs.version,
    SOURCE_DATE_EPOCH: String(inputs.sourceDateEpoch),
    LC_ALL: "C",
    ...(inputs.debug ? { HOST_SOURCE_DIR: paths.source } : {}),
  };
}

/** A bind mount's host path: podman's `-v` syntax cannot carry `:` or `,`. */
function mountable(path: string): string {
  if (/[:,]/.test(path)) throw new Error(`Cannot bind-mount ${path}: the path contains ":" or ",".`);
  return path;
}

/** The command `bun run build` runs. */
export function buildCommand(
  image: string,
  inputs: BuildInputs,
  paths: BuildPaths,
  caps: ResourceCaps = ALL_CAPS,
): string[] {
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
    ...(caps.cpu ? ["--cpus", "4"] : []),
    ...(caps.memory ? ["--memory", "16g"] : []),
    "--umask",
    "0022",
    "--unsetenv",
    "container",
    ...Object.entries(buildEnvironment(inputs, paths)).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    `--workdir=${SOURCE_MOUNT}`,
    "-v",
    `${mountable(paths.source)}:${SOURCE_MOUNT}:rw`,
    "-v",
    `${mountable(paths.dist)}:${OUTPUT_MOUNT}:rw`,
    "-v",
    `${mountable(paths.make)}:${MAKE_MOUNT}:ro`,
    image,
    "./build-pglite.sh",
  ];
}
