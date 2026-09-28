/**
 * Upstream's tags as the weekly poll reads them (ADR-0001 decisions 7 and 8): `git ls-remote --tags` lists them, and
 * the poll picks the newest release of the pinned major newer than the pin (a bump) and the newest tag of the next
 * major (its readiness). A release is `REL_<major>_<minor>`, a beta `REL_<major>_BETA<n>`, a release candidate
 * `REL_<major>_RC<n>`; older schemes (`REL9_6_0`) and anything else are ignored. Within a major the betas come
 * first, then the release candidates, then the releases: BETA1 < … < RC1 < … < 0 < 1 < ….
 */
import { UserError } from "./git.ts";

export type TagKind = "beta" | "rc" | "release";

export interface RankedTag {
  readonly tag: string;
  readonly major: number;
  readonly kind: TagKind;
  /** The beta's or release candidate's number, or the release's minor. */
  readonly number: number;
}

const TAG = /^REL_(\d+)_(?:(BETA|RC)(\d+)|(\d+))$/;
const KIND_ORDER: Readonly<Record<TagKind, number>> = { beta: 0, rc: 1, release: 2 };

export function rankTag(tag: string): RankedTag | undefined {
  const match = TAG.exec(tag);
  if (match === null) return undefined;
  const major = Number(match[1]);
  if (match[4] !== undefined) return { tag, major, kind: "release", number: Number(match[4]) };
  return { tag, major, kind: match[2] === "BETA" ? "beta" : "rc", number: Number(match[3]) };
}

/** Upstream's order: by major, then betas, release candidates and releases, then by number. */
export function compareTags(a: RankedTag, b: RankedTag): number {
  return a.major - b.major || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.number - b.number;
}

/** The tag names in `git ls-remote --tags` output, without the peeled (`^{}`) lines, in the order listed. */
export function lsRemoteTagNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref === undefined || !ref.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
    names.push(ref.slice("refs/tags/".length));
  }
  return names;
}

function newest(tags: readonly string[], keep: (tag: RankedTag) => boolean): string | undefined {
  return tags
    .map(rankTag)
    .filter((tag): tag is RankedTag => tag !== undefined && keep(tag))
    .sort(compareTags)
    .at(-1)?.tag;
}

/** What the poll acts on: the bump's tag and the readiness tag, each when there is one. */
export interface PollTargets {
  readonly pinned: RankedTag;
  /** The newest release of the pinned major newer than the pin (only the newest: skipping minors is fine). */
  readonly bump: string | undefined;
  /** The major after the pinned one. */
  readonly nextMajor: number;
  /** The newest tag of the next major: a beta, a release candidate or a release. */
  readonly readiness: string | undefined;
}

export function pollTargets(pinTag: string, tags: readonly string[]): PollTargets {
  const pinned = rankTag(pinTag);
  if (pinned === undefined || pinned.kind !== "release") {
    throw new UserError(`upstream.json pins ${pinTag}, which is not an upstream release tag (REL_<major>_<minor>).`);
  }
  const nextMajor = pinned.major + 1;
  return {
    pinned,
    bump: newest(tags, (tag) => tag.major === pinned.major && tag.kind === "release" && tag.number > pinned.number),
    nextMajor,
    readiness: newest(tags, (tag) => tag.major === nextMajor),
  };
}

/**
 * Why `tag` has no readiness to report against the pinned `pinTag`; empty when it has. Readiness is for a later
 * major's tags (a beta, a release candidate or a release): a newer release of the pinned major is a bump.
 */
export function readinessTagProblems(pinTag: string, tag: string): string[] {
  const pinned = rankTag(pinTag);
  if (pinned === undefined || pinned.kind !== "release") {
    return [`upstream.json pins ${pinTag}, which is not an upstream release tag (REL_<major>_<minor>).`];
  }
  const target = rankTag(tag);
  if (target === undefined) {
    return [
      `${JSON.stringify(tag)} is not an upstream tag of the form REL_<major>_BETA<n>, REL_<major>_RC<n> or REL_<major>_<minor> (\`REL_${pinned.major + 1}_BETA1\`).`,
    ];
  }
  if (target.major <= pinned.major) {
    return [
      `${tag} is PostgreSQL ${target.major}, and the pin is PostgreSQL ${pinned.major} (${pinTag}): readiness is for a later major's tags. A newer release of the pinned major goes in through \`bun run bump\`.`,
    ];
  }
  return [];
}
