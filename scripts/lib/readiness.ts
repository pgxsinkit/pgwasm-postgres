/**
 * The next major's readiness (ADR-0001 decisions 7 and 8): what `bun run readiness <tag>` found when it applied the
 * series onto a later major's tag in a scratch copy, and, when it applied, built it and ran pg_regress against the
 * pinned major's baseline. The report is Markdown, a comment on the rolling "Postgres <major> readiness" issue, and
 * starts with its status as an HTML comment, which the poll reads back to keep the issue's table. A conflict, a
 * failed build or pg_regress results unlike the baseline's are information about the port, never an error.
 */
import {
  applySection,
  codeBlock,
  conflictSections,
  details,
  escapeCell,
  tableRow,
  type ApplyLog,
  type TagRef,
} from "./bump-report.ts";
import { conflictedFiles, type ConflictedFile } from "./bump.ts";
import type { DataDirEntry } from "./driver/postgres.ts";
import { gitTree } from "./git.ts";
import type { Layout } from "./layout.ts";
import { formatMagic, TUPLE_KEYS, type CompatibilityTuple } from "./pg-control.ts";
import { applyEach, type PatchApplied } from "./series.ts";

/** A readiness report's summary: one row of the readiness issue's table. */
export interface ReadinessStatus {
  readonly tag: string;
  /** The commit the upstream tag resolves to. */
  readonly commit: string;
  /** The pgwasm-postgres commit whose series was applied, and its pinned tag. */
  readonly series: string;
  readonly pinned: string;
  readonly apply: string;
  readonly build: string;
  readonly regress: string;
}

const STATUS_START = "<!-- readiness-status ";
const STATUS_END = " -->";

/** The status as an HTML comment (a `-->` inside a value is escaped, so the comment cannot end early). */
export function formatStatus(status: ReadinessStatus): string {
  return `${STATUS_START}${JSON.stringify(status).replaceAll("-->", "--\\u003e")}${STATUS_END}`;
}

function isStatus(value: unknown): value is ReadinessStatus {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return ["tag", "commit", "series", "pinned", "apply", "build", "regress"].every(
    (key) => typeof record[key] === "string",
  );
}

/** The status a report carries, or undefined when the text has none (or a malformed one). */
export function parseStatus(text: string): ReadinessStatus | undefined {
  const start = text.indexOf(STATUS_START);
  if (start === -1) return undefined;
  const end = text.indexOf(STATUS_END, start + STATUS_START.length);
  if (end === -1) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start + STATUS_START.length, end));
    return isStatus(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A patch that did not apply, and its conflicting files. */
export interface PatchConflict {
  readonly patch: string;
  readonly files: readonly ConflictedFile[];
}

/**
 * Applies the series in a worktree of the cache with `git am --3way`, one patch at a time, past its conflicts: a
 * patch that conflicts is described (its files, hunks and conflict regions, without the upstream commits: the tag's
 * history since `from` is not fetched), aborted and skipped, and the next patches are applied without it. So every
 * patch gets a result, though a later one can fail for want of an earlier one.
 */
export function applyPastConflicts(
  layout: Layout,
  worktree: string,
  patches: readonly string[],
  from: string,
  to: string,
): { apply: ApplyLog; applied: PatchApplied[]; conflicts: PatchConflict[] } {
  const results: ApplyLog["patches"][number][] = [];
  const outputs: string[] = [];
  const applied: PatchApplied[] = [];
  const conflicts: PatchConflict[] = [];
  for (const patch of patches) {
    const { applied: done, failure } = applyEach(layout, worktree, [patch]);
    const entry = done[0];
    if (failure === undefined && entry !== undefined) {
      applied.push(entry);
      results.push({ patch, result: entry.threeWay ? "applied with a 3-way merge" : "applied cleanly" });
      outputs.push(entry.output);
      continue;
    }
    if (failure === undefined) continue;
    results.push({ patch, result: "CONFLICT" });
    outputs.push(failure.output);
    conflicts.push({ patch, files: conflictedFiles(layout, worktree, failure, patches, from, to, false) });
    gitTree(layout, worktree, ["am", "--abort"], { allowFailure: true });
  }
  return { apply: { patches: results, output: outputs.filter((text) => text !== "").join("\n") }, applied, conflicts };
}

/** build-pglite.sh's exit codes (overlay/build-pglite.sh), and the step each one ends. */
export const BUILD_STEPS: Readonly<Record<number, { readonly short: string; readonly step: string }>> = {
  11: { short: "configure", step: "configure (`emconfigure ./configure`)" },
  21: { short: "make", step: "the tree (`emmake make`)" },
  23: { short: "make install", step: "its install (`emmake make install`)" },
  31: { short: "contrib", step: "the contrib modules' archives (`emmake make -C contrib/`)" },
  41: { short: "modules", step: "unpacking the shipped modules" },
  42: { short: "export list", step: "the export list (`pglite/scripts/exported-functions.sh`)" },
  51: { short: "link", step: "linking the backend as postgres.js (`emmake make -C src/backend/ pglite`)" },
  52: { short: "install-pglite", step: "installing the backend (`emmake make -C src/backend/ install-pglite`)" },
};

const ERROR_LINE = /(?:^|\s)(?:fatal )?error: |\*\*\* .*Error \d+/;

/** Truncates a line to `width` characters. */
function clip(line: string, width: number): string {
  return line.length > width ? `${line.slice(0, width)} …` : line;
}

/**
 * The last `max` error lines of a build log (the compiler's and the linker's `error:`, make's `*** … Error n`), each
 * at most `width` characters, without repeats of the line before.
 */
export function compilerErrors(log: string, max = 20, width = 300): string[] {
  const lines: string[] = [];
  for (const line of log.split("\n")) {
    if (!ERROR_LINE.test(line)) continue;
    const clipped = clip(line.trimEnd(), width);
    if (lines.at(-1) !== clipped) lines.push(clipped);
  }
  return lines.slice(-max);
}

/** The last `count` lines of a text, each at most `width` characters. */
export function lastLines(text: string, count = 20, width = 300): string[] {
  return text
    .trimEnd()
    .split("\n")
    .slice(-count)
    .map((line) => clip(line, width));
}

/**
 * What the tuple's fields read from a data directory whose pg_control has no layout here (another major's
 * `PG_CONTROL_VERSION`): the version and the catalog version, at the same offsets in every version so far, and the WAL
 * page magic.
 */
export function rawTupleValues(entries: readonly DataDirEntry[]): Partial<Record<string, string>> {
  const values: Partial<Record<string, string>> = {};
  const control = entries.find((entry) => entry.path === "/global/pg_control")?.data;
  if (control !== undefined && control.length >= 16) {
    const view = new DataView(control.buffer, control.byteOffset, control.byteLength);
    values["pg_control_version"] = String(view.getUint32(8, true));
    values["catalog_version_no"] = String(view.getUint32(12, true));
  }
  const segment = entries
    .filter((entry) => entry.type === "file" && /^\/pg_wal\/[0-9A-F]{24}$/.test(entry.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1))[0]?.data;
  if (segment !== undefined && segment.length >= 2) {
    values["xlp_magic"] = formatMagic(new DataView(segment.buffer, segment.byteOffset, 2).getUint16(0, true));
  }
  return values;
}

export interface BuildFindings {
  /** `bun run build`'s exit code. */
  readonly exitCode: number;
  /** build-pglite.sh's, from the build's `build.json`; undefined when it did not run. */
  readonly scriptExitCode: number | undefined;
  readonly seconds: number | undefined;
  readonly version: string | undefined;
  /** The build log's last error lines, when build-pglite.sh failed. */
  readonly errors: readonly string[];
  /** The build log's last lines, when build-pglite.sh failed; `bun run build`'s own when it failed after it. */
  readonly tail: readonly string[];
}

export type TupleFindings =
  | {
      readonly tuple: CompatibilityTuple;
      readonly declared: { readonly dataFormat: number; readonly tuple: CompatibilityTuple };
    }
  | { readonly error: string; readonly raw: Partial<Record<string, string>> };

export type ExportFindings =
  | {
      readonly symbols: number;
      readonly reference: number;
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly missingCore: readonly string[];
    }
  | { readonly error: string };

export interface RegressReadiness {
  readonly exitCode: number;
  /** The comparison with the baseline, when pg_regress completed. */
  readonly outcome:
    | {
        readonly baseline: {
          readonly tag: string;
          readonly tests: number;
          readonly passed: number;
          readonly failed: number;
          readonly unstable: number;
        };
        readonly runs: readonly {
          readonly tests: number;
          readonly passed: number;
          readonly failed: number;
          readonly backendFailures: number;
          readonly seconds: number;
        }[];
        readonly newFailures: readonly string[];
        readonly changedDiffs: readonly string[];
        readonly newlyUnstable: readonly string[];
        readonly vanished: readonly string[];
        readonly missing: readonly string[];
        readonly unexpected: readonly string[];
        /** Of the tests not in the baseline, those that failed. */
        readonly unexpectedFailing: readonly string[];
      }
    | undefined;
  /** `bun run regress`'s last lines, when it did not complete. */
  readonly tail: readonly string[];
}

export interface ReadinessInput {
  readonly from: TagRef;
  readonly to: TagRef;
  /** The pgwasm-postgres commit whose series was applied. */
  readonly series: string;
  readonly apply: ApplyLog;
  /** The patches that did not apply (each skipped, the next ones applied without it). */
  readonly conflicts: readonly PatchConflict[];
  /** Overlay paths the tag with the series applied already has (the overlay only adds files): nothing is built. */
  readonly collisions: readonly string[];
  readonly build: BuildFindings | undefined;
  readonly tuple: TupleFindings | undefined;
  readonly exports: ExportFindings | undefined;
  readonly regress: RegressReadiness | undefined;
}

const code = (text: string): string => `\`${text}\``;
const short = (sha: string): string => sha.slice(0, 12);
const names = (list: readonly string[]): string => (list.length === 0 ? "none" : list.map(code).join(", "));
const patchNumber = (patch: string): string => patch.slice(0, 4);
const major = (tag: string): string => tag.replace(/^REL_(\d+)_.*$/, "$1");

function minutes(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Built: build-pglite.sh made the artefacts. */
function built(build: BuildFindings | undefined): boolean {
  return build?.scriptExitCode === 0;
}

function applyStatus(input: ReadinessInput): string {
  if (input.conflicts.length > 0) {
    const each = input.conflicts.map((conflict) => {
      const files = conflict.files.map((file) => code(file.file)).join(", ");
      return `${code(patchNumber(conflict.patch))}${files === "" ? "" : ` (${files})`}`;
    });
    return `${input.conflicts.length === 1 ? "conflict" : "conflicts"} in ${each.join(", ")}`;
  }
  if (input.collisions.length > 0)
    return `applies; the overlay collides (${input.collisions.length} ${input.collisions.length === 1 ? "path" : "paths"})`;
  const threeWay = input.apply.patches
    .filter((entry) => entry.result === "applied with a 3-way merge")
    .map((entry) => code(patchNumber(entry.patch)));
  return threeWay.length === 0 ? "applies" : `applies (3-way: ${threeWay.join(", ")})`;
}

function buildStatus(build: BuildFindings | undefined): string {
  if (build === undefined) return "not run";
  if (build.scriptExitCode === undefined) return "did not start";
  if (build.scriptExitCode !== 0) {
    return `fails: ${BUILD_STEPS[build.scriptExitCode]?.short ?? `exit ${build.scriptExitCode}`}`;
  }
  return build.exitCode === 0 ? "builds" : "builds; `bun run build` fails after it";
}

function regressStatus(regress: RegressReadiness | undefined): string {
  if (regress === undefined) return "not run";
  const outcome = regress.outcome;
  const run = outcome?.runs[0];
  if (outcome === undefined || run === undefined) return "did not complete";
  const failing = outcome.newFailures.length + outcome.unexpectedFailing.length;
  return `${run.passed}/${run.tests} pass; ${failing} new ${failing === 1 ? "failure" : "failures"}`;
}

export function readinessStatus(input: ReadinessInput): ReadinessStatus {
  return {
    tag: input.to.tag,
    commit: input.to.commit,
    series: input.series,
    pinned: input.from.tag,
    apply: applyStatus(input),
    build: buildStatus(input.build),
    regress: regressStatus(input.regress),
  };
}

function headline(input: ReadinessInput): string {
  if (input.conflicts.length > 0) {
    return `**The series does not apply:** ${input.conflicts.length} of its ${input.apply.patches.length} patches stop on a conflict (${input.conflicts.map((conflict) => code(patchNumber(conflict.patch))).join(", ")}). Each one was skipped and the next applied without it, so a later patch can fail for want of an earlier one. Porting the series is the \`port-${major(input.to.tag)}\` branch's work (ADR-0001 decision 8); this report says where.`;
  }
  if (input.collisions.length > 0) {
    return "**The series applies, but the overlay collides:** the tag has files the overlay adds, and the overlay only adds files. Nothing was built.";
  }
  const build = input.build;
  if (build === undefined || build.scriptExitCode === undefined) {
    return "**The series applies**, but the build did not start (its output is below).";
  }
  if (build.scriptExitCode !== 0) {
    return `**The series applies, but the build fails** at ${BUILD_STEPS[build.scriptExitCode]?.step ?? `build-pglite.sh's exit ${build.scriptExitCode}`}.`;
  }
  return "**The series applies and builds.** What differs from the pinned major's records is below: information for the port, not a failure.";
}

function buildSection(build: BuildFindings): string[] {
  const lines = ["## Build", ""];
  if (build.scriptExitCode === undefined) {
    lines.push(
      `\`bun run build\` exited ${build.exitCode} before build-pglite.sh ran:`,
      "",
      ...codeBlock(build.tail.join("\n")),
    );
    return lines;
  }
  const took = build.seconds === undefined ? "" : ` after ${minutes(build.seconds)}`;
  if (build.scriptExitCode !== 0) {
    const step = BUILD_STEPS[build.scriptExitCode]?.step ?? "an unknown step";
    lines.push(`build-pglite.sh stopped at ${step} (exit ${build.scriptExitCode})${took}.`, "");
    if (build.errors.length > 0) lines.push("Its last errors:", "", ...codeBlock(build.errors.join("\n")), "");
    lines.push(...details("The end of the build log", codeBlock(build.tail.join("\n"))));
    return lines;
  }
  lines.push(
    `Built${build.seconds === undefined ? "" : ` in ${minutes(build.seconds)}`}${build.version === undefined ? "" : ` as ${code(build.version)}`}.`,
  );
  if (build.exitCode !== 0) {
    lines.push(
      "",
      `\`bun run build\` failed after build-pglite.sh (exit ${build.exitCode}):`,
      "",
      ...codeBlock(build.tail.join("\n")),
    );
  }
  return lines;
}

function tupleSection(tag: string, tuple: TupleFindings): string[] {
  const lines = ["## Compatibility tuple", ""];
  if ("error" in tuple) {
    lines.push(`The tuple could not be read from a fresh initdb: ${tuple.error}`);
    const raw = Object.entries(tuple.raw);
    if (raw.length > 0) {
      lines.push("", "What the data directory holds where every version so far keeps it:", "");
      for (const [key, value] of raw) lines.push(`- ${code(key)}: ${code(value ?? "")}`);
    }
    return lines;
  }
  const changed = TUPLE_KEYS.filter((key) => tuple.tuple[key] !== tuple.declared.tuple[key]);
  lines.push(
    changed.length === 0
      ? `The tuple is dataFormat ${tuple.declared.dataFormat}'s: a data directory of this build opens with this major's builds and theirs with it.`
      : `${changed.length} of the ${TUPLE_KEYS.length} values differ from dataFormat ${tuple.declared.dataFormat}'s (**bold**). A major is expected to change the tuple: these are the values its new \`dataFormat\` would declare, not a failure.`,
    "",
    tableRow(["Field", `dataFormat ${tuple.declared.dataFormat}`, code(tag)]),
    tableRow(["---", "---", "---"]),
    ...TUPLE_KEYS.map((key) => {
      const now = String(tuple.tuple[key]);
      const mark = changed.includes(key) ? (text: string) => `**${text}**` : (text: string) => text;
      return tableRow([code(key), code(String(tuple.declared.tuple[key])), mark(code(now))]);
    }),
  );
  return lines;
}

function exportsSection(exports: ExportFindings): string[] {
  const lines = ["## Export list", ""];
  if ("error" in exports) {
    lines.push(`The build's export list could not be read: ${exports.error}`);
    return lines;
  }
  lines.push(
    `${exports.symbols} symbols, against \`exported_functions.txt\`'s ${exports.reference}.`,
    "",
    `- Added (${exports.added.length}): ${names(exports.added)}`,
    `- Removed (${exports.removed.length}): ${names(exports.removed)}`,
    `- Core symbols missing (${exports.missingCore.length}): ${names(exports.missingCore)}`,
  );
  return lines;
}

function regressSection(tag: string, regress: RegressReadiness): string[] {
  const lines = ["## pg_regress", ""];
  const outcome = regress.outcome;
  if (outcome === undefined) {
    lines.push(
      `\`bun run regress\` did not complete (exit ${regress.exitCode}):`,
      "",
      ...codeBlock(regress.tail.join("\n")),
    );
    return lines;
  }
  const { baseline } = outcome;
  lines.push(
    `${code(tag)}'s tests and expected output, compared with the baseline recorded on ${code(baseline.tag)} (${baseline.tests} tests: ${baseline.passed} pass, ${baseline.failed} fail, ${baseline.unstable} unstable). A result unlike the baseline's is information about the port, not a failure.`,
    "",
    tableRow(["Run", "Tests", "Pass", "Fail", "Backend failures", "Time"]),
    tableRow(["---", "---:", "---:", "---:", "---:", "---:"]),
    ...outcome.runs.map((run, index) =>
      tableRow([
        String(index + 1),
        String(run.tests),
        String(run.passed),
        String(run.failed),
        String(run.backendFailures),
        `${run.seconds} s`,
      ]),
    ),
    "",
    `- New failures (passed in the baseline): ${names(outcome.newFailures)}`,
    `- Not in the baseline (new in the schedule) and failing: ${names(outcome.unexpectedFailing)}`,
    `- Not in the baseline and passing: ${names(outcome.unexpected.filter((test) => !outcome.unexpectedFailing.includes(test)))}`,
    `- Failed in the baseline, pass now: ${names(outcome.vanished)}`,
    `- Fail differently from the baseline (${outcome.changedDiffs.length}): ${names(outcome.changedDiffs)}`,
    `- Newly unstable: ${names(outcome.newlyUnstable)}`,
    `- In the baseline, not run: ${names(outcome.missing)}`,
  );
  return lines;
}

/** The report: the status comment first, then Markdown. */
export function readinessReport(input: ReadinessInput): string {
  const status = readinessStatus(input);
  const lines = [
    formatStatus(status),
    `# PostgreSQL ${major(input.to.tag)} readiness: ${code(input.to.tag)}`,
    "",
    `PostgreSQL ${code(input.to.tag)} (${code(short(input.to.commit))}) with the series of pgwasm-postgres ${code(short(input.series))} (pinned to ${code(input.from.tag)}), applied with \`git am --3way\` patch by patch in a scratch worktree: nothing was committed to any branch.`,
    "",
    headline(input),
    "",
    tableRow(["Apply", "Build", "pg_regress"]),
    tableRow(["---", "---", "---"]),
    tableRow([escapeCell(status.apply), escapeCell(status.build), escapeCell(status.regress)]),
    "",
    "## Apply",
    "",
    ...applySection(input.apply),
  ];
  if (input.conflicts.length > 0) {
    lines.push(
      "",
      "## Conflicts",
      "",
      "The upstream commits since the pinned tag are not listed: another major's tag is fetched without that history.",
    );
    for (const conflict of input.conflicts) {
      lines.push("", `### ${code(`patches/${conflict.patch}`)}`, ...conflictSections(conflict.files, 4));
    }
  }
  if (input.collisions.length > 0) {
    lines.push("", "## Overlay", "", "Paths the overlay adds that the tag with the series applied already has:", "");
    lines.push(...input.collisions.map((path) => `- ${code(path)}`));
  }
  if (input.build !== undefined) lines.push("", ...buildSection(input.build));
  if (built(input.build)) {
    if (input.tuple !== undefined) lines.push("", ...tupleSection(input.to.tag, input.tuple));
    if (input.exports !== undefined) lines.push("", ...exportsSection(input.exports));
    if (input.regress !== undefined) lines.push("", ...regressSection(input.to.tag, input.regress));
  }
  lines.push("");
  return lines.join("\n");
}
