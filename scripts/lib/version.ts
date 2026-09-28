/**
 * The release version a build embeds (ADR-0001 decision 5), derived from the repository, never from a
 * hand-edited file. Releases are tagged `<pg major>.<pg minor>.<revision>`, and the candidate for a commit is:
 *
 * - `<major>.<minor>.0` of the pinned upstream tag while there is no semver tag yet;
 * - the latest semver tag's revision + 1 when that tag is of the pinned major.minor;
 * - `<major>.<minor>.0` otherwise (the pin moved to a new minor or major).
 *
 * Only tags of the commit's strict ancestors count: a tag on the commit itself is what a release job checks
 * against the candidate, so the gated build of a commit and the build of its tag embed the same version.
 * Tags that are not `N.N.N` (`builder-sources-1`) are ignored.
 *
 * A pin on a beta or a release candidate of the next major (a `port-<major>` branch's, or `bun run readiness`'s
 * scratch copy, decision 8) builds as the semver pre-release `<major>.0.0-beta.<n>` or `<major>.0.0-rc.<n>`: never a
 * release, since releases are tagged `N.N.N` only, so `release:check` refuses it.
 */
import { git, UserError } from "./git.ts";

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly revision: number;
}

const SEMVER_TAG = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Upstream's release tags: `REL_18_3`. Betas and release candidates (`REL_19_BETA4`) have no minor. */
const UPSTREAM_RELEASE_TAG = /^REL_(\d+)_(\d+)$/;
/** Upstream's betas and release candidates: `REL_19_BETA4`, `REL_19_RC1`. */
const UPSTREAM_PRERELEASE_TAG = /^REL_(\d+)_(BETA|RC)(\d+)$/;

/** A release tag's version, or `undefined` when the tag is not `N.N.N`. */
export function parseReleaseTag(tag: string): Version | undefined {
  const match = SEMVER_TAG.exec(tag);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), revision: Number(match[3]) };
}

/** The Postgres major and minor of an upstream release tag. */
export function upstreamVersion(tag: string): { major: number; minor: number } {
  const match = UPSTREAM_RELEASE_TAG.exec(tag);
  if (match === null) {
    throw new UserError(
      `The pinned upstream tag ${tag} is not a release tag (REL_<major>_<minor>): a build of it has no release version.`,
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.revision}`;
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.revision - b.revision;
}

/** The candidate version for a build of `upstreamTag`, given the tags of the commit's ancestors. */
export function candidateVersion(upstreamTag: string, tags: readonly string[]): Version {
  const pin = upstreamVersion(upstreamTag);
  const latest = tags
    .map(parseReleaseTag)
    .filter((version): version is Version => version !== undefined)
    .sort(compare)
    .at(-1);
  const candidate =
    latest !== undefined && latest.major === pin.major && latest.minor === pin.minor
      ? { ...pin, revision: latest.revision + 1 }
      : { ...pin, revision: 0 };
  if (tags.includes(formatVersion(candidate))) {
    throw new UserError(
      `The candidate version ${formatVersion(candidate)} is already a tag, but ${upstreamTag} is older than the latest release ${latest === undefined ? "" : formatVersion(latest)}: the pin moved backwards.`,
    );
  }
  return candidate;
}

/** The tags of `commit`'s strict ancestors: reachable from it, not on it. */
export function ancestorTags(root: string, commit = "HEAD"): string[] {
  return git(["tag", "--list", "--merged", commit, "--no-contains", commit], { cwd: root })
    .stdout.split("\n")
    .filter((line) => line !== "");
}

/** The release tags (`N.N.N`) on `commit` itself. */
export function releaseTagsAt(root: string, commit = "HEAD"): string[] {
  return git(["tag", "--list", "--points-at", commit], { cwd: root })
    .stdout.split("\n")
    .filter((tag) => parseReleaseTag(tag) !== undefined);
}

/** The version of a build of an upstream beta or release candidate (`19.0.0-beta.4`), or undefined for any other tag. */
export function prereleaseVersion(upstreamTag: string): string | undefined {
  const match = UPSTREAM_PRERELEASE_TAG.exec(upstreamTag);
  if (match === null) return undefined;
  return `${Number(match[1])}.0.0-${(match[2] ?? "").toLowerCase()}.${Number(match[3])}`;
}

/** The candidate version of the repository's HEAD for the pinned upstream tag. */
export function repositoryCandidate(root: string, upstreamTag: string): string {
  return prereleaseVersion(upstreamTag) ?? formatVersion(candidateVersion(upstreamTag, ancestorTags(root)));
}
