/**
 * The native client side of the engine gate's pg_regress (ADR-0001 decision 6): `pg_regress` and `psql`, built
 * from the pristine upstream tag of upstream.json, never the patched tree (the client is upstream's; the server
 * under test is ours), with the host gcc of the builder image. They are cached per tag under
 * `.cache/regress/<tag>/`: `source/` (the tag's tree, which also holds the tests), `build/` (a VPATH build),
 * `install/` (the prefix, `/pgwasm-regress` inside the containers that run them) and `tools.json`, which
 * records what they were built from: the tag, the configure flags and the builder image's id (they run in that
 * image, against its libc). A build takes about half a minute.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { UpstreamPin } from "../config.ts";
import { UserError } from "../git.ts";
import type { Layout } from "../layout.ts";
import { CONTAINER_PREFIX, removeBuildOutput, removeContainer, type ResourceCaps } from "../podman.ts";
import { checkoutTree } from "../source.ts";
import { resolveTag } from "../upstream.ts";

export const TOOLS_CONTAINER = `${CONTAINER_PREFIX}regress-tools`;
/** Where the tools' install prefix is mounted in the containers that build and run them. */
export const TOOLS_PREFIX = "/pgwasm-regress";
const SOURCE_MOUNT = "/pgwasm-regress-src";
const BUILD_MOUNT = "/pgwasm-regress-build";

/** The image has no readline, zlib or ICU headers, and the client side needs none of them. */
export const CONFIGURE_FLAGS: readonly string[] = [
  `--prefix=${TOOLS_PREFIX}`,
  "--without-readline",
  "--without-zlib",
  "--without-icu",
];

export interface ToolsPaths {
  readonly dir: string;
  readonly source: string;
  readonly build: string;
  readonly install: string;
  readonly stamp: string;
  readonly log: string;
  /** The tag's `src/test/regress`: the schedule, `sql/`, `expected/` and `data/`. */
  readonly regressDir: string;
}

export function toolsPaths(layout: Layout, tag: string): ToolsPaths {
  const dir = join(layout.regressCache, tag);
  const source = join(dir, "source");
  return {
    dir,
    source,
    build: join(dir, "build"),
    install: join(dir, "install"),
    stamp: join(dir, "tools.json"),
    log: join(dir, "tools.log"),
    regressDir: join(source, "src", "test", "regress"),
  };
}

interface Stamp {
  readonly tag: string;
  readonly commit: string;
  readonly configure: readonly string[];
  readonly image: string;
  readonly imageId: string;
}

/** The build, run with `bash -c` in the image: psql and pg_regress, and libpq for psql. */
export function toolsBuildScript(): string {
  return [
    "set -euo pipefail",
    `cd ${BUILD_MOUNT}`,
    `${SOURCE_MOUNT}/configure ${CONFIGURE_FLAGS.join(" ")}`,
    // psql includes generated catalog headers, which only the backend's makefile generates.
    "make -C src/backend generated-headers",
    // The libraries psql and pg_regress link come first, one directory at a time: psql's prerequisites
    // submake-libpgport and submake-libpgfeutils both make src/port and src/common, and under -j they ran at
    // once in the same directory, racing on its archives (the 18.6.1 release job's first run failed on it).
    "make -j4 -C src/port",
    "make -j4 -C src/common",
    "make -j4 -C src/fe_utils",
    "make -j4 -C src/interfaces/libpq",
    "make -j4 -C src/bin/psql",
    "make -j4 -C src/test/regress pg_regress",
    "make -C src/interfaces/libpq install",
    "make -C src/bin/psql install",
    `install -m 755 src/test/regress/pg_regress ${TOOLS_PREFIX}/bin/pg_regress`,
    `${TOOLS_PREFIX}/bin/psql --version`,
    `${TOOLS_PREFIX}/bin/pg_regress --version`,
  ].join("\n");
}

function built(paths: ToolsPaths, wanted: Stamp): boolean {
  if (!existsSync(paths.stamp)) return false;
  for (const tool of ["psql", "pg_regress"]) if (!existsSync(join(paths.install, "bin", tool))) return false;
  const stamp = JSON.parse(readFileSync(paths.stamp, "utf8")) as Partial<Stamp>;
  return (
    stamp.tag === wanted.tag &&
    stamp.commit === wanted.commit &&
    stamp.imageId === wanted.imageId &&
    JSON.stringify(stamp.configure) === JSON.stringify(wanted.configure)
  );
}

/** Builds the tools for the pinned tag unless the cache already holds them; returns their paths. */
export async function ensureTools(
  layout: Layout,
  pin: UpstreamPin,
  image: string,
  imageId: string,
  caps: ResourceCaps,
  log: (line: string) => void,
): Promise<ToolsPaths> {
  const paths = toolsPaths(layout, pin.tag);
  const wanted: Stamp = { tag: pin.tag, commit: pin.commit, configure: CONFIGURE_FLAGS, image, imageId };
  if (built(paths, wanted)) return paths;

  const commit = resolveTag(layout, { repository: pin.repository, tag: pin.tag, commit: pin.commit }, log);
  removeBuildOutput(paths.dir);
  checkoutTree(layout, layout.cacheRepo, commit, paths.source);
  mkdirSync(paths.build, { recursive: true });
  mkdirSync(paths.install, { recursive: true });
  log(
    `regress: building psql and pg_regress from pristine ${pin.tag} in ${image} (log: ${relative(layout.root, paths.log)})`,
  );

  const command = [
    "nice",
    "-n",
    "10",
    "podman",
    "run",
    "--rm",
    "--name",
    TOOLS_CONTAINER,
    "--pull=never",
    ...(caps.cpu ? ["--cpus", "4"] : []),
    ...(caps.memory ? ["--memory", "8g"] : []),
    "-v",
    `${paths.source}:${SOURCE_MOUNT}:ro`,
    "-v",
    `${paths.build}:${BUILD_MOUNT}:rw`,
    "-v",
    `${paths.install}:${TOOLS_PREFIX}:rw`,
    image,
    "bash",
    "-c",
    toolsBuildScript(),
  ];
  const fd = openSync(paths.log, "w");
  const started = Date.now();
  const exitCode = await Bun.spawn(command, { stdin: "ignore", stdout: fd, stderr: fd }).exited;
  closeSync(fd);
  if (exitCode !== 0) {
    removeContainer(TOOLS_CONTAINER);
    const tail = readFileSync(paths.log, "utf8").trimEnd().split("\n").slice(-20);
    throw new UserError(
      [`regress: the tools build failed (exit ${exitCode}):`, ...tail.map((line) => `  | ${line}`)].join("\n"),
    );
  }
  writeFileSync(paths.stamp, `${JSON.stringify(wanted, null, 2)}\n`);
  log(`regress: psql and pg_regress built in ${Math.round((Date.now() - started) / 1000)} s`);
  return paths;
}
