/**
 * The pg_regress baseline (ADR-0001 decision 6): every test's result on the pinned upstream tag, each failing
 * test's normalised diff, and, per group of failures, why they fail. `regress/baseline.json` holds the results
 * and the groups; `regress/diffs/<test>.diff` the diffs. `bun run regress --record` writes the results and the
 * diffs and keeps the groups, which are written by hand; the gate compares runs with it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { readJson, type Json } from "../config.ts";
import { UserError } from "../git.ts";
import type { Layout } from "../layout.ts";

export type Outcome = "ok" | "failed";
export type BaselineResult = Outcome | "unstable";

/** One test in one run: its outcome and, when it failed, its normalised diff. */
export interface TestRun {
  readonly outcome: Outcome;
  readonly diff?: string;
}

/** One run: every test of the schedule, in the order pg_regress ran them. */
export type RunResults = ReadonlyMap<string, TestRun>;

export interface Group {
  /** Why the group's tests fail (or are unstable), written by hand. */
  readonly reason: string;
  readonly tests: readonly string[];
}

export interface Baseline {
  readonly upstream: { readonly tag: string; readonly commit: string };
  /** The schedule, relative to the source's `src/test/regress`. */
  readonly schedule: string;
  /** How many runs the record combined. */
  readonly runs: number;
  /** The sha256 of each file the record ran, by name: the artefacts and the regress library. */
  readonly recordedWith: Readonly<Record<string, string>>;
  readonly summary: {
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly unstable: number;
  };
  readonly groups: Readonly<Record<string, Group>>;
  readonly tests: Readonly<Record<string, BaselineResult>>;
}

export const UNCLASSIFIED = "unclassified";

const COMMENT =
  "The pg_regress baseline (ADR-0001 decision 6): each test of the schedule on the pinned tag, run through the TCP bridge on the build, with --use-existing --max-connections=1. A failed test's normalised diff is regress/diffs/<test>.diff; an unstable test's outcome or diff differed between the recorded runs. `tests` and `summary` are written by `bun run regress --record`; `groups` (why each failing or unstable test fails) are written by hand and kept by --record. `bun run regress` fails on a new failure, a changed diff or a newly unstable test, and reports a vanished failure.";

/** Combines runs: a test whose outcome or diff differs between them is unstable. */
export interface Combined {
  readonly result: BaselineResult;
  readonly outcomes: readonly Outcome[];
  /** The diff, for a test that failed the same way in every run. */
  readonly diff?: string;
}

export function combineRuns(runs: readonly RunResults[]): Map<string, Combined> {
  const first = runs[0];
  if (first === undefined) throw new Error("combineRuns: no runs");
  const names = [...first.keys()];
  for (const [index, run] of runs.entries()) {
    const other = [...run.keys()];
    if (other.length !== names.length || other.some((name, position) => name !== names[position])) {
      throw new UserError(`Run ${index + 1} ran different tests from run 1; the runs cannot be compared.`);
    }
  }
  const combined = new Map<string, Combined>();
  for (const name of names) {
    const tests = runs.map((run) => run.get(name) as TestRun);
    const outcomes = tests.map((test) => test.outcome);
    const diffs = new Set(tests.map((test) => test.diff ?? ""));
    const stable = new Set(outcomes).size === 1 && diffs.size === 1;
    const outcome = outcomes[0] ?? "failed";
    if (!stable) combined.set(name, { result: "unstable", outcomes });
    else if (outcome === "ok") combined.set(name, { result: "ok", outcomes });
    else combined.set(name, { result: "failed", outcomes, diff: tests[0]?.diff ?? "" });
  }
  return combined;
}

export interface Comparison {
  /** Passed in the baseline, failed now. */
  readonly newFailures: readonly string[];
  /** Failed in the baseline and now, with a different diff. */
  readonly changedDiffs: readonly string[];
  /** Stable in the baseline, and the runs disagree now. */
  readonly newlyUnstable: readonly string[];
  /** Failed in the baseline, passed in every run now: the baseline can be tightened. */
  readonly vanished: readonly string[];
  /** Unstable in the baseline: reported, never a failure. */
  readonly unstable: readonly { readonly name: string; readonly outcomes: readonly Outcome[] }[];
  /** In the baseline, not run. */
  readonly missing: readonly string[];
  /** Run, not in the baseline. */
  readonly unexpected: readonly string[];
}

export function compare(
  baseline: Baseline,
  baselineDiffs: ReadonlyMap<string, string>,
  combined: ReadonlyMap<string, Combined>,
): Comparison {
  const comparison = {
    newFailures: [] as string[],
    changedDiffs: [] as string[],
    newlyUnstable: [] as string[],
    vanished: [] as string[],
    unstable: [] as { name: string; outcomes: readonly Outcome[] }[],
    missing: Object.keys(baseline.tests).filter((name) => !combined.has(name)),
    unexpected: [] as string[],
  };
  for (const [name, now] of combined) {
    const expected = baseline.tests[name];
    if (expected === undefined) comparison.unexpected.push(name);
    else if (expected === "unstable") comparison.unstable.push({ name, outcomes: now.outcomes });
    else if (now.result === "unstable") comparison.newlyUnstable.push(name);
    else if (expected === "ok" && now.result === "failed") comparison.newFailures.push(name);
    else if (expected === "failed" && now.result === "ok") comparison.vanished.push(name);
    else if (expected === "failed" && now.diff !== baselineDiffs.get(name)) comparison.changedDiffs.push(name);
  }
  return comparison;
}

export function passes(comparison: Comparison): boolean {
  return (
    comparison.newFailures.length === 0 &&
    comparison.changedDiffs.length === 0 &&
    comparison.newlyUnstable.length === 0 &&
    comparison.missing.length === 0 &&
    comparison.unexpected.length === 0
  );
}

export interface RecordInput {
  readonly upstream: Baseline["upstream"];
  readonly schedule: string;
  readonly runs: number;
  readonly recordedWith: Readonly<Record<string, string>>;
}

/**
 * A new baseline from combined runs, keeping the previous baseline's groups for the tests that still fail
 * or are unstable. A failing or unstable test in no group lands in `unclassified`, which the baseline's
 * validation refuses until it is classified by hand.
 */
export function recordBaseline(
  previous: Baseline | undefined,
  combined: ReadonlyMap<string, Combined>,
  input: RecordInput,
): { baseline: Baseline; diffs: Map<string, string>; unclassified: string[] } {
  const tests: Record<string, BaselineResult> = {};
  const diffs = new Map<string, string>();
  for (const [name, test] of combined) {
    tests[name] = test.result;
    if (test.result === "failed") diffs.set(name, test.diff ?? "");
  }
  const notOk = new Set(Object.keys(tests).filter((name) => tests[name] !== "ok"));
  const groups: Record<string, Group> = {};
  const grouped = new Set<string>();
  for (const [id, group] of Object.entries(previous?.groups ?? {})) {
    if (id === UNCLASSIFIED) continue;
    const kept = group.tests.filter((name) => notOk.has(name) && !grouped.has(name));
    for (const name of kept) grouped.add(name);
    if (kept.length > 0) groups[id] = { reason: group.reason, tests: kept };
  }
  const unclassified = [...notOk].filter((name) => !grouped.has(name));
  if (unclassified.length > 0) {
    groups[UNCLASSIFIED] = {
      reason: "Not classified yet: move each test into a group with a reason.",
      tests: unclassified,
    };
  }
  const results = Object.values(tests);
  const baseline: Baseline = {
    upstream: input.upstream,
    schedule: input.schedule,
    runs: input.runs,
    recordedWith: input.recordedWith,
    summary: {
      tests: results.length,
      passed: results.filter((result) => result === "ok").length,
      failed: results.filter((result) => result === "failed").length,
      unstable: results.filter((result) => result === "unstable").length,
    },
    groups,
    tests,
  };
  return { baseline, diffs, unclassified };
}

/** Everything wrong with a baseline and its diff files; empty when it is consistent. */
export function validateBaseline(baseline: Baseline, diffNames: readonly string[]): string[] {
  const problems: string[] = [];
  const results = Object.entries(baseline.tests);
  const count = (result: BaselineResult) => results.filter(([, value]) => value === result).length;
  const summary = { tests: results.length, passed: count("ok"), failed: count("failed"), unstable: count("unstable") };
  if (JSON.stringify(summary) !== JSON.stringify(baseline.summary)) {
    problems.push(`summary ${JSON.stringify(baseline.summary)} does not count the tests (${JSON.stringify(summary)})`);
  }
  const groupOf = new Map<string, string>();
  for (const [id, group] of Object.entries(baseline.groups)) {
    if (id === UNCLASSIFIED) problems.push(`group ${id} holds ${group.tests.join(", ")}: classify them`);
    if (group.reason.trim() === "") problems.push(`group ${id} has no reason`);
    if (group.tests.length === 0) problems.push(`group ${id} has no tests`);
    for (const name of group.tests) {
      const result = baseline.tests[name];
      if (result === undefined) problems.push(`group ${id} names ${name}, which is not a test`);
      else if (result === "ok") problems.push(`group ${id} names ${name}, which passes`);
      const other = groupOf.get(name);
      if (other !== undefined) problems.push(`${name} is in groups ${other} and ${id}`);
      groupOf.set(name, id);
    }
  }
  for (const [name, result] of results) {
    if (result !== "ok" && !groupOf.has(name)) problems.push(`${name} (${result}) is in no group`);
  }
  const failed = new Set(results.filter(([, result]) => result === "failed").map(([name]) => name));
  for (const name of failed) if (!diffNames.includes(name)) problems.push(`${name} failed but has no diff file`);
  for (const name of diffNames) if (!failed.has(name)) problems.push(`the diff file of ${name}, which did not fail`);
  return problems;
}

function parseBaseline(json: Json, name: string): Baseline {
  const fail = (what: string): never => {
    throw new UserError(`${name}: ${what}`);
  };
  const object = (value: unknown, what: string): Json =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Json)
      : fail(`${what} is not an object`);
  const upstream = object(json["upstream"], "upstream");
  const summary = object(json["summary"], "summary");
  const groups = object(json["groups"], "groups");
  const tests = object(json["tests"], "tests");
  for (const [test, result] of Object.entries(tests)) {
    if (result !== "ok" && result !== "failed" && result !== "unstable") fail(`tests.${test} is ${String(result)}`);
  }
  const parsedGroups: Record<string, Group> = {};
  for (const [id, value] of Object.entries(groups)) {
    const group = object(value, `groups.${id}`);
    const groupTests = group["tests"];
    if (typeof group["reason"] !== "string" || !Array.isArray(groupTests))
      fail(`groups.${id} needs a reason and tests`);
    parsedGroups[id] = { reason: group["reason"] as string, tests: (groupTests as unknown[]).map(String) };
  }
  return {
    upstream: { tag: String(upstream["tag"]), commit: String(upstream["commit"]) },
    schedule: String(json["schedule"]),
    runs: Number(json["runs"]),
    recordedWith: object(json["recordedWith"], "recordedWith") as Record<string, string>,
    summary: {
      tests: Number(summary["tests"]),
      passed: Number(summary["passed"]),
      failed: Number(summary["failed"]),
      unstable: Number(summary["unstable"]),
    },
    groups: parsedGroups,
    tests: tests as Record<string, BaselineResult>,
  };
}

/** The baseline and its diffs, or `undefined` when none was recorded yet. */
export function readBaseline(layout: Layout): { baseline: Baseline; diffs: Map<string, string> } | undefined {
  if (!existsSync(layout.regressBaseline)) return undefined;
  const baseline = parseBaseline(
    readJson(layout.regressBaseline, layout.root),
    relative(layout.root, layout.regressBaseline),
  );
  const diffs = new Map<string, string>();
  if (existsSync(layout.regressDiffsDir)) {
    for (const file of readdirSync(layout.regressDiffsDir).sort()) {
      // latin1 keeps the bytes as they are: a diff may hold output in another encoding (see run.ts).
      if (file.endsWith(".diff")) {
        diffs.set(file.slice(0, -5), readFileSync(join(layout.regressDiffsDir, file), "latin1"));
      }
    }
  }
  return { baseline, diffs };
}

/** The width oxfmt formats to (.oxfmtrc.jsonc's printWidth). */
const PRINT_WIDTH = 120;

/**
 * The baseline as it is written: two-space JSON with the groups sorted by id, laid out as oxfmt lays it out
 * (a group's test list on one line when that line fits the print width), so a record passes `bun run format`.
 */
export function formatBaseline(baseline: Baseline): string {
  const groups = Object.fromEntries(Object.entries(baseline.groups).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const text = JSON.stringify({ $comment: COMMENT, ...baseline, groups }, null, 2);
  const collapsed = text.replace(
    /^( *)"tests": \[\n((?: *"[^"\n]*",?\n)+) *\]/gm,
    (whole, indent: string, items: string) => {
      const names = items.split("\n").filter((item) => item.trim() !== "");
      const line = `${indent}"tests": [${names.map((item) => item.trim().replace(/,$/, "")).join(", ")}]`;
      return line.length <= PRINT_WIDTH ? line : whole;
    },
  );
  return `${collapsed}\n`;
}

/** Writes the baseline and replaces the diff files. */
export function writeBaseline(layout: Layout, baseline: Baseline, diffs: ReadonlyMap<string, string>): void {
  mkdirSync(layout.regressDiffsDir, { recursive: true });
  for (const file of readdirSync(layout.regressDiffsDir)) {
    if (file.endsWith(".diff") && !diffs.has(file.slice(0, -5))) rmSync(join(layout.regressDiffsDir, file));
  }
  for (const [name, diff] of diffs) writeFileSync(join(layout.regressDiffsDir, `${name}.diff`), diff, "latin1");
  writeFileSync(layout.regressBaseline, formatBaseline(baseline));
}
