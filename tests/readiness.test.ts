import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ApplyLog } from "../scripts/lib/bump-report.ts";
import type { ConflictedFile } from "../scripts/lib/bump.ts";
import { exportSeries, scratchDir, workSeries } from "../scripts/lib/commands.ts";
import { readUpstreamPin } from "../scripts/lib/config.ts";
import type { DataDirEntry } from "../scripts/lib/driver/postgres.ts";
import { git } from "../scripts/lib/git.ts";
import { layoutFor } from "../scripts/lib/layout.ts";
import type { CompatibilityTuple } from "../scripts/lib/pg-control.ts";
import {
  applyPastConflicts,
  compilerErrors,
  formatStatus,
  lastLines,
  parseStatus,
  rawTupleValues,
  readinessReport,
  readinessStatus,
  type ReadinessInput,
  type ReadinessStatus,
} from "../scripts/lib/readiness.ts";
import {
  compareTags,
  lsRemoteTagNames,
  pollTargets,
  rankTag,
  readinessTagProblems,
} from "../scripts/lib/upstream-tags.ts";
import { addWorktree, removeWorktree, resolveTag } from "../scripts/lib/upstream.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());
const quiet = (): void => {};

// What `git ls-remote --tags` of upstream listed on 2026-09-28, 18 and 19, with an annotated tag's peeled line.
const LS_REMOTE = [
  "1111111111111111111111111111111111111111\trefs/tags/REL9_6_0",
  "2222222222222222222222222222222222222222\trefs/tags/REL_18_0",
  "3333333333333333333333333333333333333333\trefs/tags/REL_18_3",
  "4444444444444444444444444444444444444444\trefs/tags/REL_18_4",
  "5555555555555555555555555555555555555555\trefs/tags/REL_18_6",
  "6666666666666666666666666666666666666666\trefs/tags/REL_18_BETA1",
  "7777777777777777777777777777777777777777\trefs/tags/REL_18_RC1",
  "8888888888888888888888888888888888888888\trefs/tags/REL_19_BETA1",
  "9999999999999999999999999999999999999999\trefs/tags/REL_19_BETA4",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/REL_19_BETA4^{}",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/REL_19_BETA2",
  "",
].join("\n");

describe("upstream's tags", () => {
  test("rank as upstream orders them: betas, release candidates, then releases", () => {
    expect(rankTag("REL_19_BETA4")).toEqual({ tag: "REL_19_BETA4", major: 19, kind: "beta", number: 4 });
    expect(rankTag("REL_19_RC1")).toEqual({ tag: "REL_19_RC1", major: 19, kind: "rc", number: 1 });
    expect(rankTag("REL_18_10")).toEqual({ tag: "REL_18_10", major: 18, kind: "release", number: 10 });
    for (const tag of ["REL9_6_0", "REL_19_ALPHA1", "REL_18", "18.6.0", "REL_18_6^{}"]) {
      expect(rankTag(tag)).toBeUndefined();
    }
    const order = ["REL_19_1", "REL_18_10", "REL_19_RC2", "REL_19_BETA10", "REL_19_0", "REL_19_BETA2", "REL_19_RC1"];
    const sorted = order
      .map((tag) => rankTag(tag))
      .filter((tag) => tag !== undefined)
      .sort(compareTags)
      .map((tag) => tag.tag);
    expect(sorted).toEqual([
      "REL_18_10",
      "REL_19_BETA2",
      "REL_19_BETA10",
      "REL_19_RC1",
      "REL_19_RC2",
      "REL_19_0",
      "REL_19_1",
    ]);
  });

  test("ls-remote's listing gives each tag once, peeled lines left out", () => {
    expect(lsRemoteTagNames(LS_REMOTE)).toEqual([
      "REL9_6_0",
      "REL_18_0",
      "REL_18_3",
      "REL_18_4",
      "REL_18_6",
      "REL_18_BETA1",
      "REL_18_RC1",
      "REL_19_BETA1",
      "REL_19_BETA4",
      "REL_19_BETA2",
    ]);
  });

  test("the poll bumps to the newest newer release of the pinned major, and reports the next major's newest tag", () => {
    const tags = lsRemoteTagNames(LS_REMOTE);
    // Today: 18.6 is 18's newest, so no bump; 19's newest is BETA4.
    expect(pollTargets("REL_18_6", tags)).toMatchObject({ bump: undefined, nextMajor: 19, readiness: "REL_19_BETA4" });
    // Only the newest minor: 18.4 is skipped.
    expect(pollTargets("REL_18_3", tags).bump).toBe("REL_18_6");
    // A release candidate is newer than every beta, and 19.0 newer than every candidate.
    expect(pollTargets("REL_18_6", [...tags, "REL_19_RC1"]).readiness).toBe("REL_19_RC1");
    expect(pollTargets("REL_18_6", [...tags, "REL_19_RC1", "REL_19_0"]).readiness).toBe("REL_19_0");
    // Nothing of the next major yet, and a beta of the pinned major is never a bump.
    expect(pollTargets("REL_17_2", ["REL_17_2", "REL_17_BETA3", "REL_16_9"])).toMatchObject({
      bump: undefined,
      nextMajor: 18,
      readiness: undefined,
    });
    expect(thrown(() => pollTargets("REL_19_BETA4", tags)).message).toContain("not an upstream release tag");
  });

  test("readiness is for a later major's tags only", () => {
    expect(readinessTagProblems("REL_18_6", "REL_19_BETA4")).toEqual([]);
    expect(readinessTagProblems("REL_18_6", "REL_19_0")).toEqual([]);
    expect(readinessTagProblems("REL_18_6", "REL_20_BETA1")).toEqual([]);
    expect(readinessTagProblems("REL_18_6", "REL_18_7")[0]).toContain("bun run bump");
    expect(readinessTagProblems("REL_18_6", "REL_18_BETA1")[0]).toContain("a later major's tags");
    expect(readinessTagProblems("REL_18_6", "REL_17_9")[0]).toContain("a later major's tags");
    expect(readinessTagProblems("REL_18_6", "master")[0]).toContain("is not an upstream tag");
  });
});

const PATCHES = ["0001-build-emscripten-add-the-port.patch", "0002-backend-pglite-hooks.patch"];
const FROM = { tag: "REL_18_6", commit: "724edf9bde9d356724ad384a2e196edc3c9f80f7" };
const TO = { tag: "REL_19_BETA4", commit: "b73d13c32c834a2c8e1c60cb92f79530376cedf1" };
const SERIES = "dc9576e1c2f3aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function input(overrides: Partial<ReadinessInput>): ReadinessInput {
  const apply: ApplyLog = {
    patches: PATCHES.map((patch) => ({ patch, result: "applied cleanly" as const })),
    output: "Applying: build-emscripten: add the port\nApplying: backend: pglite hooks",
  };
  return {
    from: FROM,
    to: TO,
    series: SERIES,
    apply,
    conflicts: [],
    collisions: [],
    build: undefined,
    tuple: undefined,
    exports: undefined,
    regress: undefined,
    ...overrides,
  };
}

const TUPLE: CompatibilityTuple = {
  pg_control_version: 1800,
  catalog_version_no: 202506291,
  maxAlign: 8,
  floatFormat: 1234567,
  blcksz: 8192,
  relseg_size: 131072,
  xlog_blcksz: 8192,
  nameDataLen: 64,
  indexMaxKeys: 32,
  toast_max_chunk_size: 1996,
  loblksize: 2048,
  float8ByVal: false,
  xlp_magic: "0xD118",
};

describe("the readiness report", () => {
  test("its status survives the round trip through an HTML comment, even with a `-->` in a value", () => {
    const status: ReadinessStatus = {
      tag: "REL_19_BETA4",
      commit: TO.commit,
      series: SERIES,
      pinned: "REL_18_6",
      apply: "conflict --> here",
      build: "not run",
      regress: "not run",
    };
    const comment = formatStatus(status);
    expect(comment).toStartWith("<!-- readiness-status {");
    expect(comment.indexOf("-->")).toBe(comment.length - 3);
    expect(parseStatus(`<!-- readiness:REL_19_BETA4 -->\n${comment}\n# Report`)).toEqual(status);
    expect(parseStatus("no status here")).toBeUndefined();
    expect(parseStatus("<!-- readiness-status {not json} -->")).toBeUndefined();
    expect(parseStatus('<!-- readiness-status {"tag":"REL_19_BETA4"} -->')).toBeUndefined();
  });

  test("a conflict says where, with the bump's conflict sections and no upstream commits", () => {
    const file: ConflictedFile = {
      file: "src/backend/Makefile",
      hunks: ["@@ -60,6 +60,12 @@ endif"],
      rejected: ["src/backend/Makefile:60"],
      regions: [{ start: 58, end: 71 }],
      commits: undefined,
      touching: [],
      excerpts: ["<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> build-emscripten"],
    };
    const conflicted = input({
      apply: {
        patches: [
          { patch: PATCHES[0] ?? "", result: "CONFLICT" },
          { patch: PATCHES[1] ?? "", result: "applied cleanly" },
        ],
        output: "error: patch failed: src/backend/Makefile:60",
      },
      conflicts: [{ patch: PATCHES[0] ?? "", files: [file] }],
    });
    expect(readinessStatus(conflicted)).toEqual({
      tag: "REL_19_BETA4",
      commit: TO.commit,
      series: SERIES,
      pinned: "REL_18_6",
      apply: "conflict in `0001` (`src/backend/Makefile`)",
      build: "not run",
      regress: "not run",
    });
    const report = readinessReport(conflicted);
    expect(parseStatus(report)).toEqual(readinessStatus(conflicted));
    expect(report).toContain("# PostgreSQL 19 readiness: `REL_19_BETA4`");
    expect(report).toContain("**The series does not apply:** 1 of its 2 patches stop on a conflict (`0001`).");
    expect(report).toContain("`port-19` branch");
    expect(report).toContain("| `0001-build-emscripten-add-the-port.patch` | CONFLICT |");
    expect(report).toContain("### `patches/0001-build-emscripten-add-the-port.patch`\n\n#### `src/backend/Makefile`");
    expect(report).toContain("- The 3-way merge's conflicts: lines 58-71 of the merged file");
    expect(report).not.toContain("Upstream commits between the tags");
    expect(report).not.toContain("## Build");
  });

  test("a failed build names the step and its last errors", () => {
    const log = [
      "pglite: building release version.",
      "emcc -O2 -Werror=vla -c foo.c",
      "foo.c:12:3: error: use of undeclared identifier 'PostgresMainLoopOnce'",
      "foo.c:12:3: error: use of undeclared identifier 'PostgresMainLoopOnce'",
      "wasm-ld: error: undefined symbol: pgl_socket",
      "make[2]: *** [Makefile:12: foo.o] Error 1",
      "error: emmake make PORTNAME=emscripten -j",
    ].join("\n");
    expect(compilerErrors(log)).toEqual([
      "foo.c:12:3: error: use of undeclared identifier 'PostgresMainLoopOnce'",
      "wasm-ld: error: undefined symbol: pgl_socket",
      "make[2]: *** [Makefile:12: foo.o] Error 1",
      "error: emmake make PORTNAME=emscripten -j",
    ]);
    expect(compilerErrors(log, 1)).toEqual(["error: emmake make PORTNAME=emscripten -j"]);
    expect(compilerErrors(`x.c:1:1: error: ${"y".repeat(500)}`, 20, 40)[0]).toHaveLength(42);
    expect(lastLines("a\nb\nc\n", 2)).toEqual(["b", "c"]);

    const failed = input({
      build: {
        exitCode: 1,
        scriptExitCode: 21,
        seconds: 312,
        version: "19.0.0-beta.4",
        errors: compilerErrors(log),
        tail: lastLines(log, 3),
      },
    });
    expect(readinessStatus(failed)).toMatchObject({ apply: "applies", build: "fails: make", regress: "not run" });
    const report = readinessReport(failed);
    expect(report).toContain("**The series applies, but the build fails** at the tree (`emmake make`).");
    expect(report).toContain("build-pglite.sh stopped at the tree (`emmake make`) (exit 21) after 5m12s.");
    expect(report).toContain("wasm-ld: error: undefined symbol: pgl_socket");
    expect(report).not.toContain("## Compatibility tuple");
  });

  test("a build reports the new tuple, the export list and pg_regress, as information", () => {
    const built = input({
      apply: {
        patches: [
          { patch: PATCHES[0] ?? "", result: "applied cleanly" },
          { patch: PATCHES[1] ?? "", result: "applied with a 3-way merge" },
        ],
        output: "",
      },
      build: { exitCode: 0, scriptExitCode: 0, seconds: 540, version: "19.0.0-beta.4", errors: [], tail: [] },
      tuple: {
        tuple: { ...TUPLE, pg_control_version: 1900, catalog_version_no: 202609011, xlp_magic: "0xD119" },
        declared: { dataFormat: 1, tuple: TUPLE },
      },
      exports: { symbols: 1210, reference: 1200, added: ["_new_symbol"], removed: [], missingCore: [] },
      regress: {
        exitCode: 1,
        outcome: {
          baseline: { tag: "REL_18_6", tests: 231, passed: 178, failed: 49, unstable: 4 },
          runs: [{ tests: 240, passed: 170, failed: 70, backendFailures: 0, seconds: 110 }],
          newFailures: ["json", "strings"],
          changedDiffs: ["copy2"],
          newlyUnstable: [],
          vanished: ["euc_kr"],
          missing: ["old_test"],
          unexpected: ["new_pass", "new_fail"],
          unexpectedFailing: ["new_fail"],
        },
        tail: [],
      },
    });
    expect(readinessStatus(built)).toMatchObject({
      apply: "applies (3-way: `0002`)",
      build: "builds",
      regress: "170/240 pass; 3 new failures",
    });
    const report = readinessReport(built);
    expect(report).toContain("**The series applies and builds.**");
    expect(report).toContain("Built in 9m00s as `19.0.0-beta.4`.");
    expect(report).toContain("3 of the 13 values differ from dataFormat 1's (**bold**)");
    expect(report).toContain("| `pg_control_version` | `1800` | **`1900`** |");
    expect(report).toContain("| `blcksz` | `8192` | `8192` |");
    expect(report).toContain("- Added (1): `_new_symbol`");
    expect(report).toContain("- Core symbols missing (0): none");
    expect(report).toContain(
      "compared with the baseline recorded on `REL_18_6` (231 tests: 178 pass, 49 fail, 4 unstable)",
    );
    expect(report).toContain("| 1 | 240 | 170 | 70 | 0 | 110 s |");
    expect(report).toContain("- New failures (passed in the baseline): `json`, `strings`");
    expect(report).toContain("- Not in the baseline (new in the schedule) and failing: `new_fail`");
    expect(report).toContain("- Not in the baseline and passing: `new_pass`");
    expect(report).toContain("- Failed in the baseline, pass now: `euc_kr`");
  });

  test("a tuple without a layout here still reports the version, the catalog version and the WAL magic", () => {
    const control = new Uint8Array(64);
    const view = new DataView(control.buffer);
    view.setUint32(8, 1900, true);
    view.setUint32(12, 202609011, true);
    const wal = new Uint8Array(64);
    new DataView(wal.buffer).setUint16(0, 0xd119, true);
    const entries: DataDirEntry[] = [
      { path: "/global/pg_control", type: "file", mode: 0o600, data: control },
      { path: "/pg_wal/000000010000000000000001", type: "file", mode: 0o600, data: wal },
    ];
    const raw = rawTupleValues(entries);
    expect(raw).toEqual({ pg_control_version: "1900", catalog_version_no: "202609011", xlp_magic: "0xD119" });

    const report = readinessReport(
      input({
        build: { exitCode: 0, scriptExitCode: 0, seconds: 540, version: undefined, errors: [], tail: [] },
        tuple: { error: "pg_control has PG_CONTROL_VERSION 1900, which has no layout here", raw },
        exports: { error: "no exported_functions.txt" },
        regress: { exitCode: 1, outcome: undefined, tail: ["regress: the bridge failed"] },
      }),
    );
    expect(report).toContain("The tuple could not be read from a fresh initdb: pg_control has PG_CONTROL_VERSION 1900");
    expect(report).toContain("- `pg_control_version`: `1900`");
    expect(report).toContain("The build's export list could not be read: no exported_functions.txt");
    expect(report).toContain("`bun run regress` did not complete (exit 1):");
  });

  test("an overlay collision stops before the build", () => {
    const collided = input({ collisions: ["pglite/Makefile"] });
    expect(readinessStatus(collided).apply).toBe("applies; the overlay collides (1 path)");
    expect(readinessReport(collided)).toContain("- `pglite/Makefile`");
  });
});

describe("the apply onto the next major", () => {
  test("goes past a conflict: the patch is described and skipped, and the next one applies without it", () => {
    const dir = fixtures.dir("readiness");
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
    const run = (cwd: string, args: string[]): string => git(args, { cwd, env }).stdout.trim();
    const commit = (files: Record<string, string>, message: string): string => {
      for (const [path, content] of Object.entries(files)) write(join(upstream, path), content);
      run(upstream, ["add", "-A"]);
      run(upstream, ["commit", "--quiet", "-m", message]);
      return run(upstream, ["rev-parse", "HEAD"]);
    };
    run(upstream, ["init", "--quiet", "--initial-branch=main"]);
    const base = commit({ "a.c": "int a = 1;\n", "b.c": "int b = 1;\n" }, "Base");
    run(upstream, ["tag", "REL_1_1"]);
    const beta = commit({ "a.c": "int a = 10;\n" }, "Next major");
    run(upstream, ["tag", "REL_2_BETA1"]);

    const root = join(dir, "root");
    write(
      join(root, "upstream.json"),
      `${JSON.stringify({ repository: `file://${upstream}`, tag: "REL_1_1", commit: base }, null, 2)}\n`,
    );
    mkdirSync(join(root, "patches"));
    mkdirSync(join(root, "overlay"));
    const layout = layoutFor(root);
    const work = workSeries(layout, undefined, {}, quiet);
    write(join(work, "a.c"), "int a = 2;\n");
    run(work, ["commit", "--quiet", "-am", "topic: a is 2"]);
    write(join(work, "b.c"), "int b = 2;\n");
    run(work, ["commit", "--quiet", "-am", "other: b is 2"]);
    exportSeries(layout, undefined, quiet);
    removeWorktree(layout, work);

    const pin = readUpstreamPin(layout);
    const from = resolveTag(layout, pin, quiet);
    const to = resolveTag(layout, { repository: pin.repository, tag: "REL_2_BETA1" }, quiet);
    expect(to).toBe(beta);
    const worktree = scratchDir(layout, "test-readiness");
    addWorktree(layout, worktree, to);
    try {
      const patches = ["0001-topic-a-is-2.patch", "0002-other-b-is-2.patch"];
      const result = applyPastConflicts(layout, worktree, patches, from, to);
      expect(result.apply.patches).toEqual([
        { patch: "0001-topic-a-is-2.patch", result: "CONFLICT" },
        { patch: "0002-other-b-is-2.patch", result: "applied cleanly" },
      ]);
      expect(result.applied.map((entry) => entry.patch)).toEqual(["0002-other-b-is-2.patch"]);
      const [conflict, ...others] = result.conflicts;
      expect(others).toEqual([]);
      expect(conflict?.patch).toBe("0001-topic-a-is-2.patch");
      expect(conflict?.files.map((file) => [file.file, file.commits, file.regions.length])).toEqual([
        ["a.c", undefined, 1],
      ]);
      expect(result.apply.output).toContain("CONFLICT (content): Merge conflict in a.c");
      // The worktree holds the tag and the patch that applied.
      expect(run(worktree, ["log", "--format=%s", `${to}..HEAD`])).toBe("other: b is 2");
    } finally {
      removeWorktree(layout, worktree);
    }
  });
});
