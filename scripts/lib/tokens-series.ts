/**
 * postgres.c as a revision's series makes it, for the token-identity check (ADR-0001 decision 4, `bun run
 * patches:tokens`): the revision's upstream.json and patches/, applied with `git am --3way` onto the pinned tag in a
 * scratch worktree of the upstream cache, as `patches:check` applies the series. The working series is the working
 * tree's upstream.json and patches/. Two sides are compared only when they pin the same upstream tag and commit.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { scratchDir, type Log } from "./commands.ts";
import { isValidTag, readUpstreamPin, SHA, stringField, type Json, type UpstreamPin } from "./config.ts";
import { git, gitBytes, gitCache, gitTree, UserError } from "./git.ts";
import type { Layout } from "./layout.ts";
import { applySeries, describeAmFailure, listPatches } from "./series.ts";
import { POSTGRES_DIR, POSTGRES_SOURCE } from "./tokens.ts";
import { addWorktree, removeWorktree, resolveTag } from "./upstream.ts";
import { ancestorTags, formatVersion, parseReleaseTag, type Version } from "./version.ts";

/** postgres.c's path in the tree. */
export const POSTGRES_PATH = `${POSTGRES_DIR}/${POSTGRES_SOURCE}`;

/** A series: where its patch files are, and the tag they apply to. */
export interface SeriesSide {
  /** How the report names it: a release tag, a short commit, or the working series. */
  readonly label: string;
  /** The commit of this repository whose series it is; undefined for the working tree's. */
  readonly commit: string | undefined;
  readonly pin: UpstreamPin;
  readonly patchesDir: string;
}

/** The latest release tag (`N.N.N`) of `tags`, by version; undefined when there is none. */
export function latestRelease(tags: readonly string[]): string | undefined {
  const compare = (a: Version, b: Version): number => a.major - b.major || a.minor - b.minor || a.revision - b.revision;
  const latest = tags
    .map(parseReleaseTag)
    .filter((version): version is Version => version !== undefined)
    .sort(compare)
    .at(-1);
  return latest === undefined ? undefined : formatVersion(latest);
}

/** The default side to compare with: the latest release among HEAD's strict ancestors (the release it follows). */
export function defaultAgainst(root: string): string {
  const tag = latestRelease(ancestorTags(root));
  if (tag === undefined) {
    throw new UserError(
      "No release tag (N.N.N) among HEAD's ancestors to compare with; name a revision with --against <revision>.",
    );
  }
  return tag;
}

/** A revision's upstream.json, as `readUpstreamPin` reads the working tree's. */
function pinAt(root: string, commit: string, label: string): UpstreamPin {
  const name = `upstream.json at ${label}`;
  let json: unknown;
  try {
    json = JSON.parse(gitBytes(["show", `${commit}:upstream.json`], { cwd: root }).toString("utf8"));
  } catch (error) {
    throw new UserError(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new UserError(`${name} must contain a JSON object.`);
  }
  const object = json as Json;
  const tag = stringField(object, "tag", name);
  if (!isValidTag(tag)) throw new UserError(`${name}: \`tag\` is ${JSON.stringify(tag)}, not a valid tag name.`);
  return {
    repository: stringField(object, "repository", name),
    tag,
    commit: stringField(object, "commit", name, SHA),
  };
}

/**
 * The series of a revision of this repository: its patch files written to `patchesDir` (which must not exist) byte
 * for byte, and its pin.
 */
export function revisionSide(root: string, revision: string, patchesDir: string): SeriesSide {
  const resolved = git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
    cwd: root,
    allowFailure: true,
  });
  const commit = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !SHA.test(commit)) {
    throw new UserError(`${revision} is not a commit of this repository.`);
  }
  const label = revision === commit ? commit.slice(0, 12) : revision;
  const pin = pinAt(root, commit, label);
  if (existsSync(patchesDir)) throw new Error(`revisionSide: ${patchesDir} already exists.`);
  mkdirSync(patchesDir, { recursive: true });
  const names = git(["ls-tree", "-z", "--name-only", commit, "--", "patches/"], { cwd: root })
    .stdout.split("\0")
    .filter((path) => path.endsWith(".patch"))
    .map((path) => path.slice(path.lastIndexOf("/") + 1));
  for (const name of names) {
    writeFileSync(join(patchesDir, name), gitBytes(["show", `${commit}:patches/${name}`], { cwd: root }));
  }
  return { label, commit, pin, patchesDir };
}

/** The working tree's series: patches/ and upstream.json as they are. */
export function workingSide(layout: Layout): SeriesSide {
  const head = git(["rev-parse", "HEAD"], { cwd: layout.root }).stdout.trim();
  const changed =
    git(["status", "--porcelain", "--", "patches", "upstream.json"], { cwd: layout.root }).stdout.trim() !== "";
  return {
    label: `the working series (HEAD ${head.slice(0, 12)}${changed ? ", with changes" : ""})`,
    commit: undefined,
    pin: readUpstreamPin(layout),
    patchesDir: layout.patchesDir,
  };
}

/** Refuses two sides that pin different upstream tags (or one tag at different commits): their code differs anyway. */
export function requireSamePin(from: SeriesSide, to: SeriesSide): void {
  if (from.pin.tag === to.pin.tag && from.pin.commit === to.pin.commit) return;
  const pin = (side: SeriesSide): string => `${side.pin.tag} (${side.pin.commit.slice(0, 12)})`;
  throw new UserError(
    `${from.label} pins ${pin(from)} and ${to.label} pins ${pin(to)}: postgres.c's tokens are compared only between two series on one upstream tag.`,
  );
}

/** postgres.c as a side's series makes it, and the commit the series made in the upstream cache. */
export interface MaterialisedPostgres {
  readonly source: Buffer;
  readonly commit: string;
}

/**
 * Applies a side's series onto its pinned tag in a scratch worktree of the upstream cache (fetching the tag the first
 * time), and reads postgres.c from it. The worktree is removed; the commits stay in the cache.
 */
export function materialisePostgres(layout: Layout, side: SeriesSide, log: Log): MaterialisedPostgres {
  const base = resolveTag(layout, side.pin, log);
  const patches = listPatches(side.patchesDir);
  const worktree = scratchDir(layout, "tokens");
  addWorktree(layout, worktree, base);
  try {
    const failure = applySeries({ ...layout, patchesDir: side.patchesDir }, worktree, patches);
    if (failure !== undefined) {
      throw new UserError(
        [
          `The series of ${side.label} does not apply.`,
          ...describeAmFailure(failure, `${side.pin.tag} (${base.slice(0, 12)})`),
        ].join("\n"),
      );
    }
    const commit = gitTree(layout, worktree, ["rev-parse", "HEAD"]).stdout.trim();
    return { source: readFileSync(join(worktree, POSTGRES_PATH)), commit };
  } finally {
    removeWorktree(layout, worktree);
  }
}

/** The paths other than postgres.c where two materialised series differ. */
export function otherDifferences(layout: Layout, from: string, to: string): string[] {
  return gitCache(layout, ["diff", "--name-only", "-z", "--no-renames", from, to])
    .stdout.split("\0")
    .filter((path) => path !== "" && path !== POSTGRES_PATH);
}

/** The build's configured tree, and what it was built from and in, from its `build.json`. */
export interface ConfiguredTree {
  readonly directory: string;
  readonly commit: string | undefined;
  readonly tree: string | undefined;
  readonly image: string | undefined;
}

/** The files a tree has once `configure` ran and the build made its generated headers. */
const CONFIGURED = ["config.status", "src/Makefile.global", "src/include/pg_config.h", "src/include/utils/errcodes.h"];

/**
 * The configured tree the check preprocesses in: the last build's (`bun run build`, which the gate runs first), never
 * one configured apart, so the compile command and the headers are the build's own.
 */
export function configuredTree(layout: Layout): ConfiguredTree {
  const directory = layout.buildSource;
  const missing = CONFIGURED.filter((path) => !existsSync(join(directory, path)));
  if (missing.length > 0) {
    throw new UserError(
      `There is no configured tree at ${relative(layout.root, directory)} (${missing.join(", ")} missing): run \`bun run build\` first. \`bun run gate\` runs this check after its build.`,
    );
  }
  const record = join(layout.buildDir, "build.json");
  let json: Record<string, unknown> = {};
  if (existsSync(record)) {
    const parsed: unknown = JSON.parse(readFileSync(record, "utf8"));
    if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
  }
  const text = (key: string): string | undefined => {
    const value = json[key];
    return typeof value === "string" ? value : undefined;
  };
  return { directory, commit: text("commit"), tree: text("tree"), image: text("image") };
}

/** Removes a revision side's scratch patch files. */
export function removeSide(side: SeriesSide): void {
  if (side.commit !== undefined) rmSync(side.patchesDir, { recursive: true, force: true });
}
