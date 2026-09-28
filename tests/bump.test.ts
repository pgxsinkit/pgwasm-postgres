import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  bumpCommitMessage,
  bumpReport,
  bumpVerdict,
  conflictReport,
  wrap,
  type BumpReportInput,
  type GateFindings,
} from "../scripts/lib/bump-report.ts";
import {
  bumpTagProblems,
  checkBumpTag,
  conflictedFiles,
  countCommits,
  fetchTagHistory,
  parseLsRemote,
  parseUpstreamTag,
  patchChange,
  patchedFiles,
  rangeDiff,
  rebaseSeries,
  regressTestsChanged,
  upstreamCommits,
  writePin,
} from "../scripts/lib/bump.ts";
import { exportSeries, workSeries } from "../scripts/lib/commands.ts";
import { readUpstreamPin } from "../scripts/lib/config.ts";
import { git, UserError } from "../scripts/lib/git.ts";
import { followRange, invertHunks, oldRange, parseDiffHunks, type Hunk } from "../scripts/lib/hunks.ts";
import { layoutFor, type Layout } from "../scripts/lib/layout.ts";
import { formatSeries, listPatches } from "../scripts/lib/series.ts";
import { removeWorktree, resolveTag } from "../scripts/lib/upstream.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());
const quiet = (): void => {};

describe("the bump's target", () => {
  test("upstream tags parse into a major and, for a release, a minor", () => {
    expect(parseUpstreamTag("REL_18_6")).toEqual({ tag: "REL_18_6", major: 18, minor: 6 });
    expect(parseUpstreamTag("REL_19_BETA4")).toEqual({ tag: "REL_19_BETA4", major: 19, minor: undefined });
    expect(parseUpstreamTag("REL_18_RC1")?.minor).toBeUndefined();
    expect(parseUpstreamTag("18.6.0")).toBeUndefined();
    expect(parseUpstreamTag("REL_18_6^{}")).toBeUndefined();
  });

  test("a newer minor of the pinned major is a bump", () => {
    expect(bumpTagProblems("REL_18_3", "REL_18_6")).toEqual([]);
    expect(bumpTagProblems("REL_18_3", "REL_18_4")).toEqual([]);
    expect(checkBumpTag("REL_18_3", "REL_18_6")).toEqual({ tag: "REL_18_6", major: 18, minor: 6 });
  });

  test("another major, a beta or a release candidate of it, is adopted through a port branch, never bumped", () => {
    for (const tag of ["REL_19_BETA4", "REL_19_1", "REL_17_9", "REL_19_RC1"]) {
      const [problem] = bumpTagProblems("REL_18_3", tag);
      expect(problem).toContain(`but the pin is PostgreSQL 18 (REL_18_3)`);
      expect(problem).toContain(`port-${tag.split("_")[1]}`);
      expect(problem).toContain("decision 8");
    }
    const error = thrown(() => checkBumpTag("REL_18_3", "REL_19_BETA4"));
    expect(error).toBeInstanceOf(UserError);
    expect(error.message).toStartWith("bump: refusing REL_19_BETA4: REL_19_BETA4 is PostgreSQL 19");
  });

  test("anything but a newer release of the major is refused", () => {
    expect(bumpTagProblems("REL_18_3", "REL_18_BETA1")[0]).toContain("is not a release of PostgreSQL 18");
    expect(bumpTagProblems("REL_18_3", "REL_18_3")[0]).toBe("upstream.json already pins REL_18_3.");
    expect(bumpTagProblems("REL_18_3", "REL_18_2")[0]).toContain("older than the pinned REL_18_3");
    expect(bumpTagProblems("REL_18_3", "18.6.0")[0]).toContain("is not an upstream tag of the form");
    expect(bumpTagProblems("REL_18_3", "--lock")[0]).toContain("is not an upstream tag of the form");
    expect(bumpTagProblems("v1", "REL_18_6")[0]).toContain("upstream.json pins v1");
  });

  test("ls-remote tells a tag that exists, peeled or not, from one that does not", () => {
    const sha = (digit: string): string => digit.repeat(40);
    expect(parseLsRemote(`${sha("a")}\trefs/tags/REL_18_6\n`, "REL_18_6")).toEqual({
      object: sha("a"),
      peeled: undefined,
    });
    const annotated = `${sha("a")}\trefs/tags/REL_18_6\n${sha("b")}\trefs/tags/REL_18_6^{}\n`;
    expect(parseLsRemote(annotated, "REL_18_6")).toEqual({ object: sha("a"), peeled: sha("b") });
    expect(parseLsRemote(`${sha("a")}\trefs/tags/REL_18_60\n`, "REL_18_6")).toBeUndefined();
    expect(parseLsRemote("", "REL_18_6")).toBeUndefined();
  });
});

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({
  oldStart,
  oldCount,
  newStart,
  newCount,
  header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
});

describe("hunks", () => {
  test("a diff's hunks are read per file, counting lines so a hunk's content is never a header", () => {
    const diff = [
      "diff --git a/src/a.c b/src/a.c",
      "index 1111111..2222222 100644",
      "--- a/src/a.c",
      "+++ b/src/a.c",
      "@@ -3,7 +3,7 @@ int x;",
      " a",
      " b",
      " c",
      "-diff --git a/fake b/fake",
      "+@@ -1 +1 @@",
      " d",
      " e",
      " f",
      "@@ -20 +20,2 @@",
      "-x",
      "+y",
      "+z",
      "\\ No newline at end of file",
      "diff --git a/src/b.c b/src/b.c",
      "@@ -0,0 +1,3 @@",
      "+1",
      "+2",
      "+3",
    ].join("\n");
    const parsed = parseDiffHunks(diff);
    expect(parsed.map((file) => file.file)).toEqual(["src/a.c", "src/b.c"]);
    expect(parsed[0]?.hunks).toEqual([
      { oldStart: 3, oldCount: 7, newStart: 3, newCount: 7, header: "@@ -3,7 +3,7 @@ int x;" },
      { oldStart: 20, oldCount: 1, newStart: 20, newCount: 2, header: "@@ -20 +20,2 @@" },
    ]);
    expect(parsed[1]?.hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newCount: 3 });
    expect(oldRange(hunk(3, 7, 3, 7))).toEqual({ start: 3, end: 9 });
    expect(oldRange(hunk(5, 0, 6, 2))).toEqual({ start: 6, end: 5 });
  });

  test("a range follows the hunks: shifted by changes before it, untouched by changes after it", () => {
    const range = { start: 10, end: 20 };
    // Two lines inserted after line 2, one line removed at 5: +1 before the range.
    expect(followRange(range, [hunk(2, 0, 3, 2), hunk(5, 1, 6, 0)])).toEqual({
      range: { start: 11, end: 21 },
      touched: false,
    });
    expect(followRange(range, [hunk(30, 2, 30, 5)])).toEqual({ range, touched: false });
    // Lines inserted right after the range's last line do not touch it.
    expect(followRange(range, [hunk(20, 0, 21, 3)]).touched).toBe(false);
  });

  test("a range a hunk changes is touched, and grows to what the hunk put in its place", () => {
    const range = { start: 10, end: 20 };
    expect(followRange(range, [hunk(15, 1, 15, 3)])).toEqual({ range: { start: 10, end: 22 }, touched: true });
    expect(followRange(range, [hunk(8, 4, 8, 1)])).toEqual({ range: { start: 8, end: 17 }, touched: true });
    expect(followRange(range, [hunk(18, 5, 18, 1)])).toEqual({ range: { start: 10, end: 18 }, touched: true });
    // Lines inserted between two of its lines.
    expect(followRange(range, [hunk(12, 0, 13, 1)])).toEqual({ range: { start: 10, end: 21 }, touched: true });
    // The whole range removed.
    expect(followRange(range, [hunk(9, 13, 8, 0)])).toEqual({ range: { start: 9, end: 8 }, touched: true });
  });

  test("inverted hunks take a range back", () => {
    const hunks = [hunk(2, 0, 3, 2), hunk(15, 1, 17, 3)];
    expect(followRange({ start: 12, end: 13 }, invertHunks(hunks))).toEqual({
      range: { start: 10, end: 11 },
      touched: false,
    });
  });
});

describe("patch changes", () => {
  test("a re-exported patch's changes are counted by kind", () => {
    const before = ["From x", "index 1..2 100644", "@@ -10,3 +10,4 @@ f", " a", "+b"].join("\n");
    const after = ["From x", "index 3..4 100644", "@@ -12,3 +12,4 @@ f", " a", "+b"].join("\n");
    expect(patchChange("0001-x.patch", before, after)).toEqual({
      patch: "0001-x.patch",
      blobIds: 1,
      hunkOffsets: 1,
      other: 0,
    });
    expect(patchChange("p", before, after.replace(" a", " c")).other).toBe(1);
    expect(patchChange("p", before, `${after}\n+c`).other).toBe(1);
  });

  test("the patched files come from the patches' diff headers", () => {
    const patch = (file: string): string => `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(patchedFiles([patch("src/b.c") + patch("configure"), patch("src/b.c")])).toEqual(["configure", "src/b.c"]);
  });
});

// A miniature upstream with release tags, and a miniature pgwasm-postgres root with a one-patch series.
interface Fixture {
  readonly upstream: string;
  readonly layout: Layout;
  readonly env: Record<string, string>;
  readonly commits: Record<string, string>;
}

const A_C = [
  "/* a.c */",
  '#include "a.h"',
  "",
  "int a(void)",
  "{",
  "\treturn 1;",
  "}",
  "",
  "int z(void)",
  "{",
  "\treturn 26;",
  "}",
];

function aC(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function makeFixture(): Fixture {
  const dir = fixtures.dir("bump");
  writeFileSync(join(dir, "gitconfig"), "");
  const env = {
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.invalid",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
  };
  const upstream = join(dir, "upstream");
  mkdirSync(upstream);
  const run = (args: string[]): string => git(args, { cwd: upstream, env }).stdout.trim();
  const commits: Record<string, string> = {};
  const commit = (name: string, files: Record<string, string>): void => {
    for (const [path, content] of Object.entries(files)) write(join(upstream, path), content);
    run(["add", "-A"]);
    run(["commit", "--quiet", "-m", name]);
    commits[name] = run(["rev-parse", "HEAD"]);
  };
  run(["init", "--quiet", "--initial-branch=main"]);
  commit("Base", { "src/a.c": aC(A_C), "src/b.c": "int b;\n" });
  run(["tag", "REL_1_1"]);
  // Away from the patch's hunk (lines 3-9), then two lines before it: the series applies with an offset.
  commit("Change z", { "src/a.c": aC(A_C.map((line) => line.replace("26", "27"))) });
  const shifted = [
    "/* a.c: the a function */",
    "/* and the z function */",
    ...A_C.map((line) => line.replace("26", "27")),
  ];
  commit("Comment a.c", { "src/a.c": aC(shifted) });
  commit("Change b", { "src/b.c": "int b = 1;\n" });
  run(["tag", "REL_1_2"]);
  // On the line the patch changes.
  commit("Return 3", { "src/a.c": aC(shifted.map((line) => line.replace("return 1", "return 3"))) });
  run(["tag", "REL_1_3"]);

  const root = join(dir, "root");
  write(
    join(root, "upstream.json"),
    `${JSON.stringify({ $comment: "The pin.", repository: `file://${upstream}`, tag: "REL_1_1", commit: commits["Base"] }, null, 2)}\n`,
  );
  write(join(root, "overlay", "tools", "run.sh"), "#!/bin/sh\n", 0o755);
  mkdirSync(join(root, "patches"));
  const layout = layoutFor(root);
  const worktree = workSeries(layout, undefined, {}, quiet);
  write(join(worktree, "src", "a.c"), aC(A_C.map((line) => line.replace("return 1", "return 2"))));
  git(["commit", "--quiet", "-am", "topic: return 2"], { cwd: worktree, env });
  exportSeries(layout, undefined, quiet);
  removeWorktree(layout, worktree);
  return { upstream, layout, env, commits };
}

describe("the bump in the upstream cache", () => {
  test("a clean apply: the series re-exports onto the new tag with its offsets, and range-diff says it is the same", () => {
    const { layout, commits } = makeFixture();
    const pin = readUpstreamPin(layout);
    const old = resolveTag(layout, pin, quiet);
    const next = fetchTagHistory(layout, pin.repository, "REL_1_2", "REL_1_1");
    expect(next).toBe(commits["Change b"] ?? "");
    expect(countCommits(layout, old, next)).toBe(3);

    const patches = listPatches(layout.patchesDir);
    const before = rebaseSeries(layout, "test-old", old, patches);
    const after = rebaseSeries(layout, "test-new", next, patches);
    try {
      expect(after.failure).toBeUndefined();
      expect(after.applied.map((entry) => [entry.patch, entry.threeWay])).toEqual([
        ["0001-topic-return-2.patch", false],
      ]);
      expect(rangeDiff(layout, before, after)).toMatch(/^1: {2}[0-9a-f]+ = 1: {2}[0-9a-f]+ topic: return 2$/);

      const out = join(layout.cacheDir, "test-export");
      formatSeries(layout, after.worktree, next, out);
      const name = "0001-topic-return-2.patch";
      const change = patchChange(
        name,
        readFileSync(join(layout.patchesDir, name), "utf8"),
        readFileSync(join(out, name), "utf8"),
      );
      expect(change).toEqual({ patch: name, blobIds: 1, hunkOffsets: 1, other: 0 });
      rmSync(out, { recursive: true, force: true });
    } finally {
      removeWorktree(layout, before.worktree);
      removeWorktree(layout, after.worktree);
    }

    // The boundary of the shallow history is diffed against its real parent: "Change z" touched a.c only.
    expect(
      upstreamCommits(layout, old, next, ["src/a.c", "src/b.c"]).map((commit) => [commit.subject, commit.files]),
    ).toEqual([
      ["Change z", ["src/a.c"]],
      ["Comment a.c", ["src/a.c"]],
      ["Change b", ["src/b.c"]],
    ]);

    writePin(layout, { ...pin, tag: "REL_1_2", commit: next });
    const text = readFileSync(layout.upstreamFile, "utf8");
    expect(JSON.parse(text)).toEqual({
      $comment: "The pin.",
      repository: pin.repository,
      tag: "REL_1_2",
      commit: next,
    });
    expect(text.endsWith("}\n")).toBe(true);
  });

  test("a conflict names the patch, the file, its hunks and the upstream commit that changed those lines", () => {
    const { layout } = makeFixture();
    const pin = readUpstreamPin(layout);
    const old = resolveTag(layout, pin, quiet);
    const next = fetchTagHistory(layout, pin.repository, "REL_1_3", "REL_1_1");
    const patches = listPatches(layout.patchesDir);
    const rebased = rebaseSeries(layout, "test-conflict", next, patches);
    try {
      expect(rebased.failure?.patch).toBe("0001-topic-return-2.patch");
      const failure = rebased.failure;
      if (failure === undefined) throw new Error("expected a conflict");
      const [file, ...others] = conflictedFiles(layout, rebased.worktree, failure, patches, old, next);
      expect(others).toEqual([]);
      expect(file?.file).toBe("src/a.c");
      expect(file?.hunks).toEqual([expect.stringMatching(/^@@ -3,7 \+3,7 @@/)]);
      expect(file?.commits?.map((commit) => commit.subject)).toEqual(["Change z", "Comment a.c", "Return 3"]);
      const touching = (file?.commits ?? [])
        .filter((commit) => file?.touching.includes(commit.sha))
        .map((commit) => commit.subject);
      expect(touching).toEqual(["Return 3"]);
      expect(file?.excerpts[0]).toContain("<<<<<<<");

      const report = conflictReport({
        from: { tag: "REL_1_1", commit: old },
        to: { tag: "REL_1_3", commit: next },
        apply: { patches: [{ patch: "0001-topic-return-2.patch", result: "CONFLICT" }], output: failure.output },
        patch: "0001-topic-return-2.patch",
        files: file === undefined ? [] : [file],
        upstreamTotal: countCommits(layout, old, next),
      });
      expect(report).toStartWith("# Bump REL_1_1 → REL_1_3: CONFLICT");
      expect(report).toContain("`patches/0001-topic-return-2.patch` does not apply");
      expect(report).toContain("Nothing in the repository changed");
      expect(report).toContain("### `src/a.c`");
      expect(report).toMatch(/\| \*\*`[0-9a-f]{12}`\*\* \| 2026-01-02 \| \*\*Return 3\*\* \|/);
      expect(report).toMatch(/\| `[0-9a-f]{12}` \| 2026-01-02 \| Change z \|/);
    } finally {
      removeWorktree(layout, rebased.worktree);
    }
  });

  test("the regress tests an upstream change touched are named once, variants included", () => {
    const { upstream, layout, env } = makeFixture();
    const run = (args: string[]): string => git(args, { cwd: upstream, env }).stdout.trim();
    write(join(upstream, "src/test/regress/sql/json.sql"), "SELECT 1;\n");
    write(join(upstream, "src/test/regress/expected/json_1.out"), "1\n");
    write(join(upstream, "src/test/regress/parallel_schedule"), "test: json\n");
    run(["add", "-A"]);
    run(["commit", "--quiet", "-m", "Tests"]);
    run(["tag", "REL_1_4"]);
    const pin = readUpstreamPin(layout);
    const old = resolveTag(layout, pin, quiet);
    const next = fetchTagHistory(layout, pin.repository, "REL_1_4", "REL_1_1");
    expect(regressTestsChanged(layout, old, next)).toEqual({ tests: ["json"], schedule: true });
  });

  test("a tag that does not resolve to a commit is refused", () => {
    const { upstream, layout, env } = makeFixture();
    const blob = git(["hash-object", "-w", "--stdin"], { cwd: upstream, env, stdin: "not a commit\n" }).stdout.trim();
    git(["tag", "REL_1_5", blob], { cwd: upstream, env });
    const pin = readUpstreamPin(layout);
    resolveTag(layout, pin, quiet);
    const error = thrown(() => fetchTagHistory(layout, pin.repository, "REL_1_5", "REL_1_1"));
    expect(error.message).toContain("REL_1_5");
  });
});

function findings(overrides: Partial<GateFindings> = {}): GateFindings {
  return {
    steps: [
      { name: "build", exitCode: 0, seconds: 480 },
      { name: "driver:smoke", exitCode: 0, seconds: 20 },
      { name: "exports:check", exitCode: 0, seconds: 1 },
      { name: "data-format:check", exitCode: 0, seconds: 5 },
      { name: "prepopulated", exitCode: 0, seconds: 10 },
      { name: "prepopulated --check", exitCode: 1, seconds: 2 },
      { name: "regress", exitCode: 1, seconds: 100 },
    ],
    buildLog: [],
    version: "18.6.0",
    exports: { symbols: 1122, reference: 1121, added: ["_new_symbol"], removed: [], missingCore: [] },
    dataFormat: { declared: 1, differences: [], catalogVersion: 202506291 },
    regress: {
      baseline: { tag: "REL_18_3", tests: 230, passed: 178, failed: 48, unstable: 4 },
      runs: [{ tests: 230, passed: 177, failed: 53, backendFailures: 0, seconds: 95 }],
      newFailures: ["uuid"],
      changedDiffs: ["json", "jsonb"],
      newlyUnstable: [],
      vanished: ["tsearch"],
      unstable: ["psql", "stats"],
      missing: [],
      unexpected: ["compression_pglz", "new_ok"],
      unexpectedFailing: ["compression_pglz"],
      changedUpstream: ["jsonb", "uuid", "compression_pglz"],
      scheduleChanged: false,
      details: [{ test: "json", text: "@@ -1 +1 @@\n-a\n+b\n" }],
    },
    prepopulated: {
      entries: 998,
      bytes: 4_400_300,
      recorded: { entries: 998, bytes: 4_400_200 },
      artefactsChanged: ["pglite.wasm", "pglite.data"],
    },
    sizes: {
      previous: "18.3.0",
      rows: [
        { name: "pglite.wasm", before: 10_061_242, after: 10_070_000 },
        { name: "pglite.js", before: 380_679, after: 380_679 },
      ],
    },
    ...overrides,
  };
}

function reportInput(gate: GateFindings): BumpReportInput {
  return {
    from: { tag: "REL_18_3", commit: "6".repeat(40) },
    to: { tag: "REL_18_6", commit: "7".repeat(40) },
    commit: "a".repeat(40),
    version: "18.6.0",
    apply: {
      patches: [
        { patch: "0001-build.patch", result: "applied cleanly" },
        { patch: "0002-backend.patch", result: "applied with a 3-way merge" },
      ],
      output: "Applying: build\nApplying: backend",
    },
    changes: [{ patch: "0001-build.patch", blobIds: 1, hunkOffsets: 2, other: 0 }],
    tree: "b".repeat(40),
    rangeDiff: "1:  1111111 = 1:  2222222 build: x",
    upstream: {
      total: 397,
      patchedFiles: ["configure", "src/backend/tcop/postgres.c"],
      commits: [{ sha: "c".repeat(40), date: "2026-05-11", subject: "Fix a | b", files: ["configure"] }],
    },
    gate,
  };
}

describe("the bump report", () => {
  test("a bump whose build passes lists what to investigate and what to re-record, never re-recording", () => {
    const input = reportInput(findings());
    const verdict = bumpVerdict(input);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.rerecord.map((entry) => entry.command)).toEqual([
      "bun run exports:check --record",
      "bun run prepopulated --record",
      "bun run regress --record --runs 8",
    ]);
    expect(verdict.investigate).toEqual([
      expect.stringContaining(
        "2 tests newly fail (`uuid`, `compression_pglz`; new in the schedule: `compression_pglz`): each is investigated",
      ),
      expect.stringContaining("1 failing test that changed upstream fails differently (`jsonb`)"),
      expect.stringContaining(
        "1 failing test whose sql and expected output did not change upstream fails differently (`json`)",
      ),
      "The schedule changed: new tests `compression_pglz`, `new_ok`.",
    ]);

    const report = bumpReport(input);
    expect(report).toStartWith("# Bump REL_18_3 → REL_18_6 (pgwasm-postgres 18.6.0)\n");
    expect(report).toContain("**The series applies and the build passes.**");
    expect(report).toContain("| `0002-backend.patch` | applied with a 3-way merge |");
    expect(report).toContain("`0001-build.patch` (1 blob id line, 2 hunk offsets)");
    expect(report).toContain("1:  1111111 = 1:  2222222 build: x");
    expect(report).toContain("| `cccccccccccc` | 2026-05-11 | Fix a \\| b | `configure` |");
    expect(report).toContain("| `prepopulated --check` | FAILED (exit 1) | 2 s |");
    expect(report).toContain("1,122 symbols against the reference's 1,121: 1 added (`_new_symbol`), 0 removed");
    expect(report).toContain("dataFormat 1's, unchanged (catalog_version_no 202506291)");
    expect(report).toContain("- New failures (passed in the baseline): `uuid` (changed upstream)");
    expect(report).toContain("- Vanished (failed in the baseline, pass now): `tsearch`");
    expect(report).toContain(
      "- Not in the baseline (new in the schedule): `compression_pglz` (fails), `new_ok` (passes)",
    );
    expect(report).toContain(
      "<summary><code>json</code>: its diff against the recorded one (- recorded, + this run)</summary>",
    );
    expect(report).toContain("| `pglite.wasm` | 10,061,242 | 10,070,000 | +8,758 (+0.09%) |");
    expect(report).toContain("| `pglite.js` | 380,679 | 380,679 | 0 |");
    expect(report).toContain("The record is of other artefacts (`pglite.wasm`, `pglite.data`)");
  });

  test("a changed tuple, a missing core symbol or a failed build stops the bump", () => {
    const tuple = bumpVerdict(
      reportInput(
        findings({
          dataFormat: {
            declared: 1,
            differences: [{ key: "catalog_version_no", declared: "202506291", actual: "202506292" }],
            catalogVersion: 202506292,
          },
        }),
      ),
    );
    expect(tuple.blocking).toEqual([
      expect.stringContaining("a minor release of PostgreSQL 18 must keep dataFormat 1"),
    ]);
    expect(tuple.blocking[0]).toContain("never declare a new dataFormat for a minor release");
    const report = bumpReport(
      reportInput(
        findings({
          exports: {
            symbols: 1120,
            reference: 1121,
            added: [],
            removed: ["_ProcessStartupPacket"],
            missingCore: ["_ProcessStartupPacket"],
          },
        }),
      ),
    );
    expect(report).toContain("**STOP.**");
    expect(report).toContain("Core symbols are missing from the export list: `_ProcessStartupPacket`");

    const build = findings({
      steps: [
        { name: "build", exitCode: 2, seconds: 60 },
        { name: "driver:smoke", exitCode: null, seconds: 0 },
      ],
      buildLog: ["make: *** [all] Error 2"],
      version: undefined,
      exports: undefined,
      dataFormat: undefined,
      regress: undefined,
      prepopulated: undefined,
      sizes: { previous: "18.3.0", unavailable: "there is no build" },
    });
    const failed = bumpReport(reportInput(build));
    expect(bumpVerdict(reportInput(build)).blocking).toEqual([expect.stringContaining("The build failed")]);
    expect(failed).toContain("| `driver:smoke` | not run |  |");
    expect(failed).toContain("make: *** [all] Error 2");
    expect(failed).toContain("Not compared with `18.3.0`: there is no build.");
  });

  test("the bump commit's message says what moved and how each patch applied, wrapped", () => {
    const message = bumpCommitMessage({
      from: { tag: "REL_18_3", commit: "6".repeat(40) },
      to: { tag: "REL_18_6", commit: "7".repeat(40) },
      apply: {
        patches: [{ patch: "0001-build-emscripten-add-the-Emscripten-port.patch", result: "applied cleanly" }],
        output: "",
      },
      changes: [{ patch: "0001-build-emscripten-add-the-Emscripten-port.patch", blobIds: 1, hunkOffsets: 1, other: 0 }],
    });
    const lines = message.split("\n");
    expect(lines[0]).toBe("upstream: bump the pin to REL_18_6");
    expect(lines[1]).toBe("");
    expect(message).toContain("- 0001-build-emscripten-add-the-Emscripten-port.patch: applied cleanly");
    expect(message.replace(/\n(?!\n)/g, " ")).toContain("0001 (1 blob id line, 1 hunk offset)");
    expect(lines.filter((line) => line.length > 72 && !line.includes("7777777777"))).toEqual([]);
    expect(wrap("a b c", 3)).toEqual(["a b", "c"]);
    expect(wrap("abcdef g", 3)).toEqual(["abcdef", "g"]);
  });
});
