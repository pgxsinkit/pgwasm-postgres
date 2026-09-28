import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  builderContent,
  chooseBuilder,
  formatLock,
  lockCommand,
  LOCK_FILE,
  parseLock,
  publicationSummary,
  pushDecision,
  readLock,
  type BuilderLock,
} from "../scripts/lib/builder-lock.ts";
import {
  BUILDER_IMAGE,
  digestReference,
  imagePushCommand,
  imageTag,
  PUBLISHED_REPOSITORY,
  publishedDigest,
  publishedImage,
} from "../scripts/lib/builder.ts";
import { directoryDigest, sha256Hex, treeDigest, treeEntries } from "../scripts/lib/digest.ts";
import { UserError } from "../scripts/lib/git.ts";
import { layoutFor, repoRoot } from "../scripts/lib/layout.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

const DIGEST = `sha256:${"a".repeat(64)}`;
const ID = "b".repeat(64);

describe("tree digests", () => {
  test("depend on paths, contents and the execute bit, never on order, mtimes or empty directories", () => {
    const dir = fixtures.dir("digest");
    write(join(dir, "Containerfile"), "FROM x\n");
    write(join(dir, "bin", "make"), "#!/bin/bash\n", 0o755);
    const digest = directoryDigest(dir);
    expect(treeEntries(dir).map((entry) => `${entry.mode} ${entry.path}`)).toEqual([
      "100644 Containerfile",
      "100755 bin/make",
    ]);
    // Order-independent, and it is the documented line format.
    const entries = treeEntries(dir);
    expect(treeDigest([...entries].reverse())).toBe(digest);
    expect(digest).toBe(
      sha256Hex(`100644 ${sha256Hex("FROM x\n")} Containerfile\n100755 ${sha256Hex("#!/bin/bash\n")} bin/make\n`),
    );
    write(join(dir, "empty", ".keep"), "");
    const withKeep = directoryDigest(dir);
    expect(withKeep).not.toBe(digest);
    expect(directoryDigest(dir, ["empty/.keep"])).toBe(digest);

    chmodSync(join(dir, "bin", "make"), 0o644);
    expect(directoryDigest(dir, ["empty/.keep"])).not.toBe(digest);
    chmodSync(join(dir, "bin", "make"), 0o700);
    expect(directoryDigest(dir, ["empty/.keep"])).toBe(digest);
    symlinkSync("make", join(dir, "bin", "gmake"));
    expect(treeEntries(dir).find((entry) => entry.path === "bin/gmake")).toEqual({
      path: "bin/gmake",
      mode: "120000",
      sha256: sha256Hex("make"),
    });
    expect(() => treeDigest([...entries, ...entries])).toThrow(/twice/);
  });
});

describe("the builder image's references", () => {
  test("the published image keeps the local tag, and a digest reference is recognised", () => {
    expect(imageTag(BUILDER_IMAGE)).toBe("6.0.10-p1");
    expect(imageTag("localhost:5000/a/b:t")).toBe("t");
    expect(imageTag("localhost:5000/a/b")).toBeUndefined();
    expect(imageTag(`${PUBLISHED_REPOSITORY}@${DIGEST}`)).toBeUndefined();
    expect(publishedImage()).toBe("ghcr.io/pgxsinkit/pgwasm-builder:6.0.10-p1");
    expect(digestReference(PUBLISHED_REPOSITORY, DIGEST)).toBe(`ghcr.io/pgxsinkit/pgwasm-builder@${DIGEST}`);
    expect(publishedDigest(`${PUBLISHED_REPOSITORY}@${DIGEST}`, [])).toBe(DIGEST);
    expect(publishedDigest(BUILDER_IMAGE, [`localhost/pgwasm-postgres-builder@sha256:${"c".repeat(64)}`])).toBeNull();
    expect(publishedDigest(BUILDER_IMAGE, [`${PUBLISHED_REPOSITORY}@${DIGEST}`])).toBe(DIGEST);
    expect(imagePushCommand(BUILDER_IMAGE, publishedImage(), "/d")).toEqual([
      "podman",
      "push",
      "--format",
      "v2s2",
      "--digestfile",
      "/d",
      BUILDER_IMAGE,
      "docker://ghcr.io/pgxsinkit/pgwasm-builder:6.0.10-p1",
    ]);
  });
});

describe("the builder lock", () => {
  const content = "c".repeat(64);
  const published: BuilderLock = { image: publishedImage(), contentSha256: content, digest: DIGEST, id: ID };
  const unpublished: BuilderLock = { ...published, digest: null, id: null };

  test("the committed lock is well formed, names the published image and excludes itself from the content", () => {
    const layout = layoutFor(repoRoot);
    const lock = readLock(layout.builderDir, repoRoot);
    expect(lock.image).toBe(publishedImage());
    expect(readFileSync(join(layout.builderDir, LOCK_FILE), "utf8")).toBe(formatLock(lock));
    expect(builderContent(layout.builderDir)).toBe(directoryDigest(layout.builderDir, [LOCK_FILE]));
  });

  test("parses what it formats and refuses a half-published or malformed lock", () => {
    for (const lock of [published, unpublished]) {
      expect(parseLock(JSON.parse(formatLock(lock)) as Record<string, unknown>, "lock")).toEqual(lock);
    }
    const bad = (patch: Record<string, unknown>): Error =>
      thrown(() => parseLock({ ...published, ...patch }, "builder/image.lock.json"));
    expect(bad({ id: null }).message).toContain("both set");
    expect(bad({ digest: "sha256:short" })).toBeInstanceOf(UserError);
    expect(bad({ image: "ghcr.io/pgxsinkit/pgwasm-builder" }).message).toContain("image");
    expect(bad({ contentSha256: null }).message).toContain("contentSha256");
  });

  test("the gate pulls the published image only for builder/'s content under the current tag", () => {
    expect(chooseBuilder(published, content)).toEqual({
      kind: "pull",
      reference: `ghcr.io/pgxsinkit/pgwasm-builder@${DIGEST}`,
      digest: DIGEST,
      id: ID,
    });
    const changed = chooseBuilder(published, "d".repeat(64));
    expect(changed.kind).toBe("build");
    expect(changed.kind === "build" && changed.reason).toContain("builder/ changed");
    const notYet = chooseBuilder(unpublished, content);
    expect(notYet.kind === "build" && notYet.reason).toContain("not published yet");
    const retagged = chooseBuilder(published, content, "ghcr.io/pgxsinkit/pgwasm-builder:6.0.10-p2");
    expect(retagged.kind === "build" && retagged.reason).toContain("6.0.10-p2");
  });

  test("a content is pushed once per tag, and a published tag never gets other content", () => {
    expect(pushDecision(undefined, content, publishedImage())).toEqual({ kind: "push" });
    expect(pushDecision(unpublished, "d".repeat(64), publishedImage())).toEqual({ kind: "push" });
    expect(pushDecision(published, content, publishedImage())).toEqual({ kind: "published", digest: DIGEST });
    const refused = pushDecision(published, "d".repeat(64), publishedImage());
    expect(refused.kind === "refuse" && refused.reason).toContain("new tag");
    expect(pushDecision(published, "d".repeat(64), "ghcr.io/pgxsinkit/pgwasm-builder:6.0.10-p2")).toEqual({
      kind: "push",
    });
  });

  test("the publication's summary carries the command that records it", () => {
    const publication = { image: publishedImage(), digest: DIGEST, id: ID, contentSha256: content, pushed: true };
    expect(lockCommand(publication)).toBe(`bun run builder:lock --digest ${DIGEST} --id ${ID} --content ${content}`);
    const summary = publicationSummary(publication);
    expect(summary).toContain(`| Digest | \`${DIGEST}\` |`);
    expect(summary).toContain(lockCommand(publication));
    expect(publicationSummary({ ...publication, pushed: false })).toContain("nothing was pushed");
  });
});
