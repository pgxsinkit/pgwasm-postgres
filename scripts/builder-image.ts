/**
 * bun run builder:image [--push] [--summary <file>]
 *
 * Builds the builder image from builder/Containerfile with podman, as localhost/pgwasm-postgres-builder:6.0.10-p1
 * (amd64 only), capped at 4 CPUs, 16 GiB and `make -j4`. From scratch it takes about 40 minutes; podman's layer
 * cache makes an unchanged rebuild take seconds. Then checks the image's package set against
 * builder/dpkg-expected.txt. The full log goes to .cache/builder-image.log.
 *
 * --push     then publish it (ADR-0001 decision 9) as ghcr.io/pgxsinkit/pgwasm-builder:<the same tag>, as
 *            `builder-image.yml` does; podman must be logged in to ghcr.io. It pushes a content of builder/ once
 *            per tag: when builder/image.lock.json already records this content published under the tag, nothing
 *            is built or pushed; when it records the tag published from other content, it refuses (a changed
 *            builder/ gets a new tag). It prints the digest and the `bun run builder:lock` command that records
 *            it, and writes them to .cache/builder-image.json.
 * --summary  append a Markdown summary of the publication to <file> (the job summary in CI).
 *
 * Not part of validate: it takes too long.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { buildBuilderImage, pushBuilderImage } from "./lib/builder-image.ts";
import {
  builderContent,
  lockCommand,
  lockPath,
  publicationSummary,
  pushDecision,
  readLock,
  type Publication,
} from "./lib/builder-lock.ts";
import { BUILDER_IMAGE, publishedImage } from "./lib/builder.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { refuseOtherContainers, requirePodman, resourceCaps } from "./lib/podman.ts";

const USAGE = "Usage: bun run builder:image [--push] [--summary <file>]";

function options(args: readonly string[]): { push: boolean; summary: string | undefined } {
  let push = false;
  let summary: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--push") push = true;
    else if (args[index] === "--summary" && args[index + 1] !== undefined) {
      summary = args[index + 1];
      index += 1;
    } else throw new UserError(USAGE);
  }
  return { push, summary };
}

await runCliAsync(async () => {
  const args = options(process.argv.slice(2));
  const layout = layoutFor(repoRoot);
  requirePodman();
  refuseOtherContainers();
  const report = (publication: Publication): void => {
    mkdirSync(layout.cacheDir, { recursive: true });
    writeFileSync(join(layout.cacheDir, "builder-image.json"), `${JSON.stringify(publication, null, 2)}\n`);
    info(
      `builder:image: ${publication.image} is ${publication.digest}${publication.id === null ? "" : `, id ${publication.id}`}`,
    );
    if (publication.pushed) {
      info(`builder:image: record it in ${relative(layout.root, lockPath(layout.builderDir))} with`);
      info(`  ${lockCommand(publication)}`);
    }
    if (args.summary !== undefined) appendFileSync(args.summary, publicationSummary(publication));
  };

  const target = publishedImage();
  const content = builderContent(layout.builderDir);
  if (args.push) {
    const lock = existsSync(lockPath(layout.builderDir)) ? readLock(layout.builderDir, layout.root) : undefined;
    const decision = pushDecision(lock, content, target);
    if (decision.kind === "refuse") throw new UserError(`builder:image: ${decision.reason}`);
    if (decision.kind === "published") {
      info(`builder:image: ${target} is already published from this content of builder/; nothing to push.`);
      report({ image: target, digest: decision.digest, id: lock?.id ?? null, contentSha256: content, pushed: false });
      return;
    }
  }

  const id = await buildBuilderImage(layout, BUILDER_IMAGE, resourceCaps(info), info);
  if (!args.push) return;
  const digest = await pushBuilderImage(layout, BUILDER_IMAGE, target, info);
  report({ image: target, digest, id, contentSha256: content, pushed: true });
});
