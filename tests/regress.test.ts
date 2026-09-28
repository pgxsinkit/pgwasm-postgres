import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { layoutFor, repoRoot } from "../scripts/lib/layout.ts";
import {
  combineRuns,
  compare,
  formatBaseline,
  passes,
  readBaseline,
  recordBaseline,
  UNCLASSIFIED,
  validateBaseline,
  type Baseline,
  type RunResults,
  type TestRun,
} from "../scripts/lib/regress/baseline.ts";
import { backendFailures, normaliseDiff, parseStatusLines, splitDiffs } from "../scripts/lib/regress/results.ts";
import { BRIDGE_STACK_KIB, bridgeCommand, bridgeEnvironment, DATABASE_SETUP } from "../scripts/lib/regress/run.ts";
import { CONFIGURE_FLAGS, toolsBuildScript } from "../scripts/lib/regress/tools.ts";

describe("pg_regress's output", () => {
  test("status lines give each test's outcome, in order", () => {
    const output = [
      "# using postmaster on 127.0.0.1, port 41234",
      "not ok 1     - test_setup                                788 ms",
      "# parallel group (2 tests, in groups of 1):  boolean char",
      "ok 2         + boolean                                   147 ms",
      "ok 3         + collate.icu.utf8                           39 ms",
      "# (test process exited with exit code 2)",
    ].join("\n");
    expect(parseStatusLines(output)).toEqual([
      { name: "test_setup", ok: false, ms: 788 },
      { name: "boolean", ok: true, ms: 147 },
      { name: "collate.icu.utf8", ok: true, ms: 39 },
    ]);
  });

  const paths = { inputDir: "/src/test/regress", outputDir: "/runs/1", port: 41234 };
  const diffs = [
    "diff -U3 /src/test/regress/expected/boolean.out /runs/1/results/boolean.out",
    "--- /src/test/regress/expected/boolean.out\t2026-09-27 08:57:10.521 +0000",
    "+++ /runs/1/results/boolean.out\t2026-09-27 08:57:11.000 +0000",
    "@@ -1,3 +1,3 @@",
    " SELECT 1;",
    '-ERROR:  could not open file "/runs/1/results/x.data"',
    '+ERROR:  could not access file "/runs/1/lib/regress.so": /src/test/regress/data/x, port 41234 failed',
    "",
    "diff -U3 /src/test/regress/expected/char_1.out /runs/1/results/char.out",
    "--- /src/test/regress/expected/char_1.out\t2026-09-27 08:57:10.521 +0000",
    "+++ /runs/1/results/char.out\t2026-09-27 08:57:11.000 +0000",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");

  test("regression.diffs splits into one diff per test", () => {
    const split = splitDiffs(diffs);
    expect([...split.keys()]).toEqual(["boolean", "char"]);
    expect(split.get("char")?.split("\n")[0]).toBe(
      "diff -U3 /src/test/regress/expected/char_1.out /runs/1/results/char.out",
    );
    expect(split.get("char")?.endsWith("+b\n")).toBe(true);
  });

  test("a normalised diff loses the run's paths, timestamps and port, and keeps the rest", () => {
    const normalised = normaliseDiff(splitDiffs(diffs).get("boolean") ?? "", paths);
    expect(normalised.split("\n")).toEqual([
      "diff -U3 expected/boolean.out results/boolean.out",
      "--- expected/boolean.out",
      "+++ results/boolean.out",
      "@@ -1,3 +1,3 @@",
      " SELECT 1;",
      '-ERROR:  could not open file "@abs_builddir@/results/x.data"',
      '+ERROR:  could not access file "@abs_builddir@/lib/regress.so": @abs_srcdir@/data/x, port @port@ failed',
      "",
    ]);
    expect(normaliseDiff(splitDiffs(diffs).get("char") ?? "", paths).split("\n")[1]).toBe("--- expected/char_1.out");
  });

  test("the bridge log's backend failures name the test", () => {
    const log = [
      "[    9.066s] #47 pg_regress/opr_sanity: BACKEND FAILED: TypeError: resolved is not a function.",
      "[    9.066s] #47 pg_regress/opr_sanity: closed: the backend failed",
      "[   20.510s] #91 : BACKEND FAILED: RangeError: Maximum call stack size exceeded.",
    ].join("\n");
    expect(backendFailures(log)).toEqual([
      { test: "opr_sanity", error: "TypeError: resolved is not a function." },
      { test: "", error: "RangeError: Maximum call stack size exceeded." },
    ]);
  });
});

function run(entries: Record<string, TestRun>): RunResults {
  return new Map(Object.entries(entries));
}

const ok: TestRun = { outcome: "ok" };
const failed = (diff: string): TestRun => ({ outcome: "failed", diff });

describe("the baseline", () => {
  const input = {
    upstream: { tag: "REL_18_3", commit: "c".repeat(40) },
    schedule: "parallel_schedule",
    runs: 2,
    recordedWith: { "postgres.wasm": "a".repeat(64) },
  };

  test("runs combine: a test whose outcome or diff differs between them is unstable", () => {
    const combined = combineRuns([
      run({ a: ok, b: failed("x"), c: failed("x"), d: ok }),
      run({ a: ok, b: failed("x"), c: failed("y"), d: failed("z") }),
    ]);
    expect(Object.fromEntries([...combined].map(([name, test]) => [name, test.result]))).toEqual({
      a: "ok",
      b: "failed",
      c: "unstable",
      d: "unstable",
    });
    expect(combined.get("b")?.diff).toBe("x");
    expect(combined.get("d")?.outcomes).toEqual(["ok", "failed"]);
    expect(() => combineRuns([run({ a: ok }), run({ b: ok })])).toThrow("different tests");
  });

  test("a record keeps the groups of tests that still fail, and puts new failures in unclassified", () => {
    const previous = recordBaseline(undefined, combineRuns([run({ a: failed("x"), b: failed("y") })]), input).baseline;
    const grouped: Baseline = { ...previous, groups: { why: { reason: "because", tests: ["a", "b"] } } };
    const next = recordBaseline(grouped, combineRuns([run({ a: failed("x"), b: ok, c: failed("z") })]), input);
    expect(next.baseline.groups).toEqual({
      why: { reason: "because", tests: ["a"] },
      [UNCLASSIFIED]: { reason: expect.any(String) as unknown as string, tests: ["c"] },
    });
    expect(next.unclassified).toEqual(["c"]);
    expect([...next.diffs]).toEqual([
      ["a", "x"],
      ["c", "z"],
    ]);
    expect(next.baseline.summary).toEqual({ tests: 3, passed: 1, failed: 2, unstable: 0 });
    expect(validateBaseline(next.baseline, ["a", "c"])).toEqual(["group unclassified holds c: classify them"]);
  });

  test("validation finds every inconsistency", () => {
    const baseline: Baseline = {
      ...input,
      summary: { tests: 3, passed: 1, failed: 1, unstable: 0 },
      groups: { g: { reason: "", tests: ["a", "ok1", "ghost"] }, h: { reason: "r", tests: ["a"] } },
      tests: { a: "failed", ok1: "ok", u: "unstable" },
    };
    expect(validateBaseline(baseline, ["stray"])).toEqual([
      'summary {"tests":3,"passed":1,"failed":1,"unstable":0} does not count the tests ({"tests":3,"passed":1,"failed":1,"unstable":1})',
      "group g has no reason",
      "group g names ok1, which passes",
      "group g names ghost, which is not a test",
      "a is in groups g and h",
      "u (unstable) is in no group",
      "a failed but has no diff file",
      "the diff file of stray, which did not fail",
    ]);
  });

  test("the gate fails on a new failure, a changed diff or a newly unstable test, and reports the rest", () => {
    const baseline: Baseline = {
      ...input,
      summary: { tests: 6, passed: 2, failed: 3, unstable: 1 },
      groups: {},
      tests: { ok1: "ok", ok2: "ok", f1: "failed", f2: "failed", f3: "failed", u: "unstable" },
    };
    const diffs = new Map([
      ["f1", "x"],
      ["f2", "y"],
      ["f3", "z"],
    ]);
    const same = combineRuns([run({ ok1: ok, ok2: ok, f1: failed("x"), f2: failed("y"), f3: failed("z"), u: ok })]);
    expect(passes(compare(baseline, diffs, same))).toBe(true);

    const changed = combineRuns([
      run({ ok1: ok, ok2: failed("n"), f1: failed("x"), f2: failed("y2"), f3: ok, u: failed("q") }),
      run({ ok1: failed("m"), ok2: failed("n"), f1: failed("x"), f2: failed("y2"), f3: ok, u: ok }),
    ]);
    const comparison = compare(baseline, diffs, changed);
    expect(comparison).toEqual({
      newFailures: ["ok2"],
      changedDiffs: ["f2"],
      newlyUnstable: ["ok1"],
      vanished: ["f3"],
      unstable: [{ name: "u", outcomes: ["failed", "ok"] }],
      missing: [],
      unexpected: [],
    });
    expect(passes(comparison)).toBe(false);
    expect(passes(compare(baseline, diffs, combineRuns([run({ ok1: ok, extra: ok })])))).toBe(false);
  });

  test("the committed baseline is consistent, and written as --record writes it", () => {
    const layout = layoutFor(repoRoot);
    const recorded = readBaseline(layout);
    expect(recorded).toBeDefined();
    if (recorded === undefined) return;
    expect(validateBaseline(recorded.baseline, [...recorded.diffs.keys()])).toEqual([]);
    expect(formatBaseline(recorded.baseline)).toBe(readFileSync(layout.regressBaseline, "utf8"));
    for (const [name, diff] of recorded.diffs) {
      expect(diff.startsWith(`diff -U3 expected/`), name).toBe(true);
      expect(diff.includes(layout.root), name).toBe(false);
    }
  });
});

describe("the run", () => {
  test("creates the regression database as pg_regress's create_database() at REL_18_3 would", () => {
    expect(DATABASE_SETUP).toEqual([
      'CREATE DATABASE "regression" TEMPLATE=template0',
      [
        `ALTER DATABASE "regression" SET lc_messages TO 'C';`,
        `ALTER DATABASE "regression" SET lc_monetary TO 'C';`,
        `ALTER DATABASE "regression" SET lc_numeric TO 'C';`,
        `ALTER DATABASE "regression" SET lc_time TO 'C';`,
        `ALTER DATABASE "regression" SET bytea_output TO 'hex';`,
        `ALTER DATABASE "regression" SET timezone_abbreviations TO 'Default';`,
      ].join(""),
    ]);
  });

  test("runs the bridge with a raised native stack", () => {
    expect(bridgeCommand("/bin/bun", "/repo/scripts/regress-bridge.ts", ["--port", "0"])).toEqual([
      "bash",
      "-c",
      `ulimit -s ${BRIDGE_STACK_KIB} && exec "$@"`,
      "bash",
      "/bin/bun",
      "/repo/scripts/regress-bridge.ts",
      "--port",
      "0",
    ]);
    expect(BRIDGE_STACK_KIB).toBe(262144);
    const env = bridgeEnvironment({ PATH: "/bin", UNSET: undefined });
    expect(env).toEqual({ PATH: "/bin", BUN_JSC_maxPerThreadStackUsage: String(255 * 1024 * 1024) });
    // Bun picks the raised stack up: a plain recursion goes about 50 times as deep as with the defaults.
    const recursion =
      "let d = 0; const f = (n) => { d = n; return f(n + 1) + 1; }; try { f(0); } catch {} console.log(d);";
    const depth = (command: string[], env: Record<string, string>): number =>
      Number(Bun.spawnSync(command, { env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim());
    const raised = depth(bridgeCommand(process.execPath, "-e", [recursion]), bridgeEnvironment(process.env));
    const plain = depth([process.execPath, "-e", recursion], bridgeEnvironment({ PATH: process.env["PATH"] }));
    expect(raised).toBeGreaterThan(1_000_000);
    expect(plain).toBeLessThan(raised);
  });

  test("builds the client tools from the pristine tree, with configure's flags", () => {
    const script = toolsBuildScript();
    expect(script).toContain(`/pgwasm-regress-src/configure ${CONFIGURE_FLAGS.join(" ")}`);
    expect(script).toContain("make -C src/backend generated-headers");
    expect(script.indexOf("generated-headers")).toBeLessThan(script.indexOf("make -j4 -C src/bin/psql"));
  });

  test("makes the shared libraries before psql, whose prerequisites would make them at once", () => {
    const script = toolsBuildScript();
    const psql = script.indexOf("make -j4 -C src/bin/psql");
    for (const dir of ["src/port", "src/common", "src/fe_utils", "src/interfaces/libpq"]) {
      const at = script.indexOf(`make -j4 -C ${dir}\n`);
      expect(at).toBeGreaterThan(script.indexOf("generated-headers"));
      expect(at).toBeLessThan(psql);
    }
  });
});
