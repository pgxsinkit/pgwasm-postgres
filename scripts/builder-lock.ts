/**
 * bun run builder:lock [--digest <sha256:…> --id <image id> [--content <sha256>] | --unpublished]
 *
 * The builder image's lock, builder/image.lock.json (ADR-0001 decision 9; see scripts/lib/builder-lock.ts).
 *
 * Without options it changes nothing: it prints the lock, the content of builder/ now, and what the gate does
 * with them (pull the published image by digest, or build the image from builder/).
 *
 * --digest, --id  record a publication: the digest and image id `builder-image.yml` printed in its job summary,
 *                 for builder/'s content now. --content (the summary's) makes it refuse unless builder/ has the
 *                 content the image was built from.
 * --unpublished   record builder/'s content now as not published (no digest, no id).
 */
import { relative } from "node:path";

import { builderContent, chooseBuilder, lockPath, parseLock, readLock, writeLock } from "./lib/builder-lock.ts";
import { publishedImage } from "./lib/builder.ts";
import { info, runCli } from "./lib/cli.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";

const USAGE = "Usage: bun run builder:lock [--digest <sha256:…> --id <image id> [--content <sha256>] | --unpublished]";

runCli(() => {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let unpublished = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--unpublished") unpublished = true;
    else if (["--digest", "--id", "--content"].includes(arg) && args[index + 1] !== undefined && !values.has(arg)) {
      values.set(arg, args[index + 1] ?? "");
      index += 1;
    } else throw new UserError(USAGE);
  }
  if (unpublished && values.size > 0) throw new UserError(USAGE);
  if (values.size > 0 && (!values.has("--digest") || !values.has("--id"))) throw new UserError(USAGE);

  const layout = layoutFor(repoRoot);
  const file = relative(layout.root, lockPath(layout.builderDir));
  const content = builderContent(layout.builderDir);
  const image = publishedImage();

  if (values.size === 0 && !unpublished) {
    const lock = readLock(layout.builderDir, layout.root);
    info(
      `builder:lock: ${file}: ${lock.image}, ${lock.digest === null ? "not published" : `${lock.digest}, id ${lock.id ?? ""}`}`,
    );
    info(`builder:lock: its content ${lock.contentSha256}`);
    info(`builder:lock: builder/ now ${content}`);
    const choice = chooseBuilder(lock, content, image);
    info(
      choice.kind === "pull"
        ? `builder:lock: the gate pulls ${choice.reference}; a release can be made.`
        : `builder:lock: the gate builds the image from builder/: ${choice.reason}; a release refuses this.`,
    );
    return;
  }

  const expected = values.get("--content");
  if (expected !== undefined && expected !== content) {
    throw new UserError(
      `builder:lock: builder/'s content is ${content}, not ${expected}: the image was built from another commit's builder/. Record it on the commit builder-image.yml ran on.`,
    );
  }
  const lock = parseLock(
    {
      image,
      contentSha256: content,
      digest: unpublished ? null : (values.get("--digest") ?? null),
      id: unpublished ? null : (values.get("--id") ?? null),
    },
    "builder:lock",
  );
  writeLock(layout.builderDir, lock);
  info(
    `builder:lock: wrote ${file}: ${lock.image}, ${lock.digest === null ? "not published" : `${lock.digest}, id ${lock.id ?? ""}`}, content ${lock.contentSha256}.`,
  );
});
