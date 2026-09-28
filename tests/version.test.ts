import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { git, UserError } from "../scripts/lib/git.ts";
import {
  ancestorTags,
  candidateVersion,
  formatVersion,
  parseReleaseTag,
  prereleaseVersion,
  releaseTagsAt,
  repositoryCandidate,
  upstreamVersion,
} from "../scripts/lib/version.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

const candidate = (tag: string, tags: readonly string[]): string => formatVersion(candidateVersion(tag, tags));

describe("the candidate version", () => {
  test("parses release tags and upstream tags", () => {
    expect(parseReleaseTag("18.3.0")).toEqual({ major: 18, minor: 3, revision: 0 });
    expect(parseReleaseTag("18.10.12")).toEqual({ major: 18, minor: 10, revision: 12 });
    for (const tag of ["builder-sources-1", "v18.3.0", "18.3", "18.3.0-rc1", "018.3.0", "18.3.0.1"]) {
      expect(parseReleaseTag(tag)).toBeUndefined();
    }
    expect(upstreamVersion("REL_18_3")).toEqual({ major: 18, minor: 3 });
    expect(thrown(() => upstreamVersion("REL_19_BETA4"))).toBeInstanceOf(UserError);
  });

  test("is <major>.<minor>.0 until there is a release tag, ignoring other tags", () => {
    expect(candidate("REL_18_3", [])).toBe("18.3.0");
    expect(candidate("REL_18_3", ["builder-sources-1", "builder-sources-2"])).toBe("18.3.0");
  });

  test("is the latest release's revision + 1 on the same minor", () => {
    expect(candidate("REL_18_3", ["18.3.0"])).toBe("18.3.1");
    expect(candidate("REL_18_3", ["18.3.0", "18.3.1", "builder-sources-1", "18.3.10", "18.3.9"])).toBe("18.3.11");
  });

  test("starts at .0 when the pin moves to another minor or major", () => {
    expect(candidate("REL_18_6", ["18.3.0", "18.3.1"])).toBe("18.6.0");
    expect(candidate("REL_18_6", ["18.3.0", "18.6.0"])).toBe("18.6.1");
    expect(candidate("REL_19_1", ["18.6.4"])).toBe("19.1.0");
  });

  test("refuses a pin that moved backwards onto a released version", () => {
    expect(thrown(() => candidateVersion("REL_18_3", ["18.3.0", "18.6.0"])).message).toContain("moved backwards");
  });

  test("is a pre-release for a beta or a release candidate, which is never a release tag", () => {
    expect(prereleaseVersion("REL_19_BETA4")).toBe("19.0.0-beta.4");
    expect(prereleaseVersion("REL_19_RC1")).toBe("19.0.0-rc.1");
    for (const tag of ["REL_18_6", "REL_19_0", "REL_19_ALPHA1", "18.6.0"])
      expect(prereleaseVersion(tag)).toBeUndefined();
    expect(parseReleaseTag("19.0.0-beta.4")).toBeUndefined();
  });
});

describe("the repository's tags", () => {
  const env = (dir: string): Record<string, string> => ({
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.invalid",
  });

  test("count only the strict ancestors of HEAD, so a tagged commit's candidate is its tag", () => {
    const dir = fixtures.dir("version");
    write(join(dir, "gitconfig"), "");
    const repo = join(dir, "repo");
    const run = (...args: string[]): string => git(args, { cwd: repo, env: env(dir) }).stdout.trim();
    write(join(repo, "file"), "1\n");
    run("init", "--quiet", "--initial-branch=main");
    const commit = (message: string): void => {
      write(join(repo, "file"), `${message}\n`);
      run("add", "file");
      run("commit", "--quiet", "-m", message);
    };
    commit("first");
    run("tag", "builder-sources-1");
    expect(repositoryCandidate(repo, "REL_18_3")).toBe("18.3.0");

    commit("second");
    expect(repositoryCandidate(repo, "REL_18_3")).toBe("18.3.0");
    run("tag", "18.3.0");
    // The tag on HEAD is the release being built: HEAD's candidate is still 18.3.0.
    expect(releaseTagsAt(repo)).toEqual(["18.3.0"]);
    expect(ancestorTags(repo)).toEqual(["builder-sources-1"]);
    expect(repositoryCandidate(repo, "REL_18_3")).toBe("18.3.0");

    commit("third");
    expect(repositoryCandidate(repo, "REL_18_3")).toBe("18.3.1");
    expect(releaseTagsAt(repo)).toEqual([]);

    // A tag that is not an ancestor (another branch) does not count.
    run("switch", "--quiet", "-c", "other");
    commit("other");
    run("tag", "18.3.1");
    run("switch", "--quiet", "main");
    expect(repositoryCandidate(repo, "REL_18_3")).toBe("18.3.1");
    // A beta pin's build is a pre-release, whatever the tags.
    expect(repositoryCandidate(repo, "REL_19_BETA4")).toBe("19.0.0-beta.4");
  });
});
