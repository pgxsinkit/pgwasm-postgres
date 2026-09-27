/**
 * The builder image's lock (ADR-0001 decision 9): builder/image.lock.json records the published image (its
 * reference by tag, the digest the registry stored it at, and its image id) and the content of builder/ it was
 * built from, as a {@link directoryDigest} of builder/ without the lock itself.
 *
 * The gate uses it to choose its image ({@link chooseBuilder}): when the lock's content is builder/'s and it has a
 * digest, the published image is pulled by digest; when builder/ changed since (a change to the builder, not
 * published yet), the image is built from builder/ in the job; a release accepts only the published image.
 * `builder:image --push` publishes a content once under a tag ({@link pushDecision}), and `builder:lock` writes
 * the lock from what `builder-image.yml` reports.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BUILDER_IMAGE, digestReference, PUBLISHED_REPOSITORY, publishedImage } from "./builder.ts";
import { field, readJson } from "./config.ts";
import { directoryDigest } from "./digest.ts";
import { UserError } from "./git.ts";

export const LOCK_FILE = "image.lock.json";

const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface BuilderLock {
  /** The published image by tag: `ghcr.io/pgxsinkit/pgwasm-builder:<the local image's tag>`. */
  readonly image: string;
  /** The content of builder/ the image was built from ({@link builderContent}). */
  readonly contentSha256: string;
  /** The digest the registry stored the image at (`sha256:…`); null until it is published. */
  readonly digest: string | null;
  /** The image id (its config's sha256), which a pull by digest must give; null until it is published. */
  readonly id: string | null;
}

export function lockPath(builderDir: string): string {
  return join(builderDir, LOCK_FILE);
}

/** The content of builder/ an image is built from: every file under it but the lock. */
export function builderContent(builderDir: string): string {
  return directoryDigest(builderDir, [LOCK_FILE]);
}

const COMMENT =
  "The builder image's lock (ADR-0001 decision 9), written by `bun run builder:lock`, never by hand. `image` is the published image by tag, `digest` and `id` what the registry stored it at and the image id a pull gives (null: not published yet), and `contentSha256` the content of builder/ (every file but this one) it was built from. The gate pulls the image by digest when builder/ still has that content, and builds it from builder/ otherwise; a release requires the published image.";

export function formatLock(lock: BuilderLock): string {
  return `${JSON.stringify({ $comment: COMMENT, ...lock }, null, 2)}\n`;
}

/** Checks a lock's fields; `name` names it in messages. */
export function parseLock(json: Record<string, unknown>, name: string): BuilderLock {
  const text = (path: string, pattern: RegExp | undefined, nullable: boolean): string | null => {
    const value = field(json, path, name);
    if (value === null && nullable) return null;
    if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value))) {
      throw new UserError(
        `${name}: \`${path}\` must be ${nullable ? "null or " : ""}a string${pattern === undefined ? "" : ` matching ${String(pattern)}`}; it is ${JSON.stringify(value)}.`,
      );
    }
    return value;
  };
  const image = text("image", /^[^@\s]+:[^@\s:/]+$/, false) as string;
  const lock: BuilderLock = {
    image,
    contentSha256: text("contentSha256", SHA256, false) as string,
    digest: text("digest", DIGEST, true),
    id: text("id", SHA256, true),
  };
  if ((lock.digest === null) !== (lock.id === null)) {
    throw new UserError(`${name}: \`digest\` and \`id\` are both set (published) or both null (not published).`);
  }
  return lock;
}

export function readLock(builderDir: string, root: string): BuilderLock {
  const file = lockPath(builderDir);
  const name = relative(root, file);
  if (!existsSync(file)) throw new UserError(`${name} is missing; write it with \`bun run builder:lock\`.`);
  return parseLock(readJson(file, root), name);
}

export function writeLock(builderDir: string, lock: BuilderLock): void {
  writeFileSync(lockPath(builderDir), formatLock(lock));
}

/** Where the gate's builder image comes from. */
export type BuilderChoice =
  | {
      readonly kind: "pull";
      /** `ghcr.io/pgxsinkit/pgwasm-builder@sha256:…`. */
      readonly reference: string;
      readonly digest: string;
      readonly id: string;
    }
  | { readonly kind: "build"; readonly reason: string };

/**
 * The published image when the lock describes builder/'s current content under the current tag and has a
 * digest; otherwise a build from builder/, with the reason. `expectedImage` is {@link publishedImage}.
 */
export function chooseBuilder(lock: BuilderLock, content: string, expectedImage = publishedImage()): BuilderChoice {
  if (lock.image !== expectedImage) {
    return {
      kind: "build",
      reason: `the lock names ${lock.image}, but the builder is ${expectedImage} (${BUILDER_IMAGE}'s tag)`,
    };
  }
  if (lock.contentSha256 !== content) {
    return {
      kind: "build",
      reason: `builder/ changed since the lock was written (its content is ${content.slice(0, 12)}, the lock's ${lock.contentSha256.slice(0, 12)})`,
    };
  }
  if (lock.digest === null || lock.id === null) {
    return { kind: "build", reason: `${lock.image} is not published yet (the lock has no digest)` };
  }
  return {
    kind: "pull",
    reference: digestReference(PUBLISHED_REPOSITORY, lock.digest),
    digest: lock.digest,
    id: lock.id,
  };
}

/** What `builder:image --push` published (or found published), as `builder-image.yml`'s job summary shows it. */
export interface Publication {
  readonly image: string;
  readonly digest: string;
  readonly id: string | null;
  readonly contentSha256: string;
  /** False when the lock already recorded this content published, and nothing was pushed. */
  readonly pushed: boolean;
}

/** The command that writes the lock for a publication, run on the commit it was built from. */
export function lockCommand(publication: Publication): string {
  return [
    "bun run builder:lock",
    `--digest ${publication.digest}`,
    ...(publication.id === null ? [] : [`--id ${publication.id}`]),
    `--content ${publication.contentSha256}`,
  ].join(" ");
}

/** A Markdown job summary of a publication. */
export function publicationSummary(publication: Publication): string {
  const lines = [
    `### Builder image ${publication.pushed ? "published" : "already published"}`,
    "",
    "| | |",
    "| --- | --- |",
    `| Image | \`${publication.image}\` |`,
    `| Digest | \`${publication.digest}\` |`,
    `| By digest | \`${digestReference(PUBLISHED_REPOSITORY, publication.digest)}\` |`,
    ...(publication.id === null ? [] : [`| Image id | \`${publication.id}\` |`]),
    `| builder/ content | \`${publication.contentSha256}\` |`,
    "",
  ];
  if (publication.pushed) {
    lines.push(
      "Record it in the lock on the commit this ran on (the command refuses another content of builder/), and commit the lock:",
      "",
      "```sh",
      lockCommand(publication),
      "```",
      "",
    );
  } else {
    lines.push("builder/image.lock.json already records this content published; nothing was pushed.", "");
  }
  return lines.join("\n");
}

/** What `builder:image --push` does with the image it built. */
export type PushDecision =
  | { readonly kind: "push" }
  | { readonly kind: "published"; readonly digest: string }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Pushes a content once per tag: when the lock already records this content published under the target tag, there
 * is nothing to push; when it records the target tag published with other content, pushing would move a
 * published tag, so a changed builder/ needs a new tag first.
 */
export function pushDecision(lock: BuilderLock | undefined, content: string, target: string): PushDecision {
  if (lock === undefined || lock.image !== target || lock.digest === null) return { kind: "push" };
  if (lock.contentSha256 === content) return { kind: "published", digest: lock.digest };
  return {
    kind: "refuse",
    reason: `${target} is published (${lock.digest}) from other content of builder/ (${lock.contentSha256.slice(0, 12)}; now ${content.slice(0, 12)}). Give the changed image a new tag (BUILDER_IMAGE in scripts/lib/builder.ts, and the Containerfile's header) before publishing it.`,
  };
}
