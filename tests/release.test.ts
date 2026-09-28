import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { GateManifest } from "../scripts/lib/gate.ts";
import { git } from "../scripts/lib/git.ts";
import {
  chooseGateRun,
  exportsAt,
  previousRelease,
  publishProblems,
  releaseCommand,
  releaseNotes,
  releaseTagProblems,
  type GateRun,
} from "../scripts/lib/release.ts";
import { repositoryCandidate } from "../scripts/lib/version.ts";
import { Fixtures, gateManifest, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

const HEAD = "a".repeat(40);

function manifest(): GateManifest {
  return {
    ...gateManifest([
      { name: "amcheck.tar.gz", bytes: 21_862, sha256: "1".repeat(64) },
      { name: "postgres.wasm", bytes: 10_061_242, sha256: "2".repeat(64) },
    ]),
    commit: HEAD,
  };
}

describe("the release tag", () => {
  test("must be N.N.N, on the checkout, and the checkout's candidate version", () => {
    const facts = { tag: "18.3.0", tagCommit: HEAD, head: HEAD, candidate: "18.3.0" };
    expect(releaseTagProblems(facts)).toEqual([]);
    expect(releaseTagProblems({ ...facts, tag: "builder-sources-2" })).toEqual([
      "builder-sources-2 is not a release tag (N.N.N, unprefixed, no leading zeros).",
    ]);
    expect(releaseTagProblems({ ...facts, tag: "v18.3.0" })[0]).toContain("not a release tag");
    // A tag on the checkout that skips the candidate.
    const skipped = releaseTagProblems({ ...facts, tag: "18.3.1" });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("is not the candidate version of aaaaaaaaaaaa, which is 18.3.0");
    expect(releaseTagProblems({ ...facts, tagCommit: "b".repeat(40) })[0]).toContain("but the checkout is");
    expect(releaseTagProblems({ ...facts, tagCommit: undefined })).toEqual(["there is no tag 18.3.0."]);
  });

  test("in a repository: a tagged commit's candidate is its tag, and the previous release is found", () => {
    const dir = fixtures.dir("release");
    write(join(dir, "gitconfig"), "");
    const repo = join(dir, "repo");
    const env = {
      GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    const run = (...args: string[]): string => git(args, { cwd: repo, env }).stdout.trim();
    write(join(repo, "exported_functions.txt"), "_a\n_b\n");
    run("init", "--quiet", "--initial-branch=main");
    run("add", "-A");
    run("commit", "--quiet", "-m", "first");
    run("tag", "builder-sources-1");
    expect(previousRelease(repo)).toBeUndefined();
    run("tag", "18.3.0");
    const first = run("rev-parse", "HEAD");
    expect(
      releaseTagProblems({
        tag: "18.3.0",
        tagCommit: first,
        head: first,
        candidate: repositoryCandidate(repo, "REL_18_3"),
      }),
    ).toEqual([]);
    write(join(repo, "exported_functions.txt"), "_a\n_c\n");
    run("commit", "--quiet", "-am", "second");
    const second = run("rev-parse", "HEAD");
    expect(repositoryCandidate(repo, "REL_18_3")).toBe("18.3.1");
    // A tag named after an old version, on the new commit, is refused.
    expect(releaseTagProblems({ tag: "18.3.0", tagCommit: first, head: second, candidate: "18.3.1" })).toHaveLength(2);
    expect(previousRelease(repo)).toBe("18.3.0");
    expect(exportsAt(repo, "18.3.0")).toEqual(["_a", "_b"]);
    expect(exportsAt(repo, "builder-sources-1")).toEqual(["_a", "_b"]);
    expect(exportsAt(repo, "18.9.9")).toBeUndefined();
  });
});

describe("the gated build", () => {
  const run = (patch: Partial<GateRun>): GateRun => ({
    databaseId: 1,
    status: "completed",
    conclusion: "success",
    createdAt: "2026-09-27T10:00:00Z",
    url: "https://github.com/pgxsinkit/pgwasm-postgres/actions/runs/1",
    ...patch,
  });

  test("is the latest successful gate run of the commit, or the one still going", () => {
    const old = run({ databaseId: 1 });
    const newer = run({ databaseId: 2, createdAt: "2026-09-27T11:00:00Z" });
    const failed = run({ databaseId: 3, createdAt: "2026-09-27T12:00:00Z", conclusion: "failure" });
    const going = run({ databaseId: 4, createdAt: "2026-09-27T13:00:00Z", status: "in_progress", conclusion: "" });
    expect(chooseGateRun([old, failed, newer])).toEqual({ kind: "use", run: newer });
    expect(chooseGateRun([going, old])).toEqual({ kind: "use", run: old });
    expect(chooseGateRun([failed, going])).toEqual({ kind: "wait", run: going });
    expect(chooseGateRun([])).toEqual({ kind: "none", reason: "gate.yml never ran on it" });
    expect(chooseGateRun([failed])).toEqual({
      kind: "none",
      reason: "gate.yml ran on it 1 time, never successfully (failure)",
    });
  });

  test("must have a manifest identical to this job's, in the published image, for the tag at the checkout", () => {
    const ours = manifest();
    const input = { tag: "18.3.0", head: HEAD, tagCommit: HEAD, ours, gated: structuredClone(ours), dryRun: false };
    expect(publishProblems(input)).toEqual({ errors: [], warnings: [] });

    const drifted = {
      ...ours,
      files: [{ ...ours.files[0], sha256: "9".repeat(64) } as GateManifest["files"][number], ...ours.files.slice(1)],
    };
    expect(publishProblems({ ...input, gated: drifted }).errors).toEqual([
      `differs from the gated build: files: amcheck.tar.gz: 21862 bytes, ${"9".repeat(64)} → 21862 bytes, ${"1".repeat(64)}`,
    ]);
    expect(publishProblems({ ...input, tag: "18.3.1" }).errors).toEqual(["the gate built 18.3.0, not 18.3.1."]);
    expect(publishProblems({ ...input, head: "b".repeat(40), tagCommit: "b".repeat(40) }).errors[0]).toContain(
      "the gate is of",
    );

    const local = {
      ...ours,
      builder: { ...ours.builder, image: "localhost/pgwasm-postgres-builder:3.1.74-p2", digest: null },
    };
    const unpublished = { ...input, ours: local, gated: structuredClone(local), tagCommit: undefined };
    expect(publishProblems(unpublished).errors).toEqual([
      "there is no tag 18.3.0.",
      "the build ran in localhost/pgwasm-postgres-builder:3.1.74-p2, not the published builder image: a release is built with it.",
    ]);
    // A dry run reports them and goes on.
    expect(publishProblems({ ...unpublished, dryRun: true })).toEqual({
      errors: [],
      warnings: publishProblems(unpublished).errors,
    });
  });
});

describe("the release notes", () => {
  test("say what the release is, from its manifest, and how the export list changed", () => {
    const first = releaseNotes({ manifest: manifest(), exports: ["_a", "_c"], previous: undefined });
    expect(first).toContain(
      `PostgreSQL 18.3 for WebAssembly: upstream \`REL_18_3\` (\`${"3".repeat(40)}\`) with this repository's patch series and overlay at \`${HEAD}\``,
    );
    expect(first).toContain(
      "`SELECT version()` reads `PostgreSQL 18.3 (pgwasm-postgres 18.3.0) on wasm32-unknown-emscripten, …`",
    );
    expect(first).toContain(`| \`postgres.wasm\` | 10,061,242 | \`${"2".repeat(64)}\` |`);
    expect(first).toContain("dataFormat 1: pg_control_version 1800");
    expect(first).toContain(
      "pg_regress `parallel_schedule`: 230 tests, 178 pass, 49 fail as the baseline records, 3 unstable",
    );
    expect(first).toContain("The first release: there is no earlier export list to compare with.");
    expect(first).toContain("SOURCE_DATE_EPOCH 1790508533, 2026-09-27T");
    expect(first).toContain(
      `\`ghcr.io/pgxsinkit/pgwasm-builder@sha256:${"4".repeat(64)}\` (image id \`${"5".repeat(64)}\`), the published image of builder/`,
    );

    const next = releaseNotes({
      manifest: manifest(),
      exports: ["_a", "_c"],
      previous: { tag: "18.3.0", exports: ["_a", "_b"] },
    });
    expect(next).toContain("Against `18.3.0` (its `exported_functions.txt`): 1 added (`_c`), 1 removed (`_b`).");
    expect(next).toContain("Against the reference at the commit: no change.");
    expect(
      releaseNotes({ manifest: manifest(), exports: [], previous: { tag: "18.3.0", exports: undefined } }),
    ).toContain("`18.3.0` has no export list to compare with.");
  });

  test("the release takes every gate file as an asset and requires the tag on GitHub", () => {
    expect(releaseCommand("18.3.0", "/n.md", ["/g/a", "/g/b"])).toEqual([
      "gh",
      "release",
      "create",
      "18.3.0",
      "--verify-tag",
      "--title",
      "18.3.0",
      "--notes-file",
      "/n.md",
      "/g/a",
      "/g/b",
    ]);
  });
});
