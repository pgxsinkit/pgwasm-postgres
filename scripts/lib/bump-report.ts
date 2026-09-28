/**
 * The bump's report (ADR-0001 decision 7): Markdown, the body of the bump's pull request. A conflicting apply
 * gives {@link conflictReport}: the patch, the conflicting files and hunks, and the upstream commits that changed
 * those lines. A clean apply gives {@link bumpReport}: the apply log, the range-diff, the upstream changes to the
 * patched files, and what the engine gate found: the export list, the data format, pg_regress against the
 * baseline, the prepopulated data directory, the sizes against the previous release, and which records to
 * re-record. The bump never re-records one: the operator does, after reading this, each in its own commit.
 */
import type { ConflictedFile, PatchChange, UpstreamCommit } from "./bump.ts";
import type { TupleDifference } from "./data-format.ts";
import type { GateStep } from "./gate.ts";

export interface TagRef {
  readonly tag: string;
  readonly commit: string;
}

export type PatchResult = "applied cleanly" | "applied with a 3-way merge" | "CONFLICT" | "not applied";

export interface ApplyLog {
  readonly patches: readonly { readonly patch: string; readonly result: PatchResult }[];
  /** git am's output, patch after patch. */
  readonly output: string;
}

export interface ConflictReportInput {
  readonly from: TagRef;
  readonly to: TagRef;
  readonly apply: ApplyLog;
  /** The patch that did not apply. */
  readonly patch: string;
  readonly files: readonly ConflictedFile[];
  /** Upstream commits between the tags. */
  readonly upstreamTotal: number;
}

export interface SizeRow {
  readonly name: string;
  readonly before: number | undefined;
  readonly after: number | undefined;
}

export interface RegressFindings {
  /** The upstream tag the baseline was recorded on, and its summary. */
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
  readonly unstable: readonly string[];
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  /** Of the tests not in the baseline (new in the schedule), those that fail. */
  readonly unexpectedFailing: readonly string[];
  /** The tests whose sql or expected output changed upstream between the tags. */
  readonly changedUpstream: readonly string[];
  readonly scheduleChanged: boolean;
  /** A new failure's diff, or a changed diff's difference from the recorded one, per test. */
  readonly details: readonly { readonly test: string; readonly text: string }[];
}

export interface GateFindings {
  readonly steps: readonly GateStep[];
  /** The last lines of the build log, when the build failed. */
  readonly buildLog: readonly string[];
  /** `version()`'s release: the build manifest's version. */
  readonly version: string | undefined;
  readonly exports:
    | {
        readonly symbols: number;
        readonly reference: number;
        readonly added: readonly string[];
        readonly removed: readonly string[];
        readonly missingCore: readonly string[];
      }
    | undefined;
  readonly dataFormat:
    | { readonly declared: number; readonly differences: readonly TupleDifference[]; readonly catalogVersion: number }
    | undefined;
  readonly regress: RegressFindings | undefined;
  readonly prepopulated:
    | {
        readonly entries: number;
        readonly bytes: number;
        readonly recorded: { readonly entries: number; readonly bytes: number };
        /** The driver's files whose sha256 differs from the record's. */
        readonly artefactsChanged: readonly string[];
      }
    | undefined;
  readonly sizes:
    | { readonly previous: string; readonly rows: readonly SizeRow[] }
    | { readonly previous: string | undefined; readonly unavailable: string };
}

export interface BumpReportInput {
  readonly from: TagRef;
  readonly to: TagRef;
  /** The bump commit, and the release it builds (its candidate version). */
  readonly commit: string;
  readonly version: string;
  readonly apply: ApplyLog;
  /** The re-exported patch files that changed. */
  readonly changes: readonly PatchChange[];
  /** The tree `patches:check` proved on the new tag. */
  readonly tree: string;
  readonly rangeDiff: string;
  readonly upstream: {
    readonly total: number;
    readonly patchedFiles: readonly string[];
    readonly commits: readonly UpstreamCommit[];
  };
  readonly gate: GateFindings;
}

export interface Rerecord {
  readonly record: string;
  readonly command: string;
  readonly why: string;
}

export interface Verdict {
  /** What stops the bump: it cannot be released until each is fixed (and it is never fixed by a new record). */
  readonly blocking: readonly string[];
  /** What must be investigated and explained before a release (in the records' commit messages). */
  readonly investigate: readonly string[];
  /** The records that differ, each re-recorded by its own command, in its own commit. */
  readonly rerecord: readonly Rerecord[];
}

const number = (value: number): string => value.toLocaleString("en-US");
const short = (sha: string): string => sha.slice(0, 12);
const code = (text: string): string => `\`${text}\``;
const names = (list: readonly string[]): string => list.map(code).join(", ");
/** `1 test`, `2 tests`. */
const count = (value: number, noun: string, plural = `${noun}s`): string =>
  `${number(value)} ${value === 1 ? noun : plural}`;
/** Inline code in HTML (a `<summary>`), where Markdown's backticks are not rendered. */
const htmlCode = (text: string): string =>
  `<code>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;

function step(gate: GateFindings, name: string): GateStep | undefined {
  return gate.steps.find((entry) => entry.name === name);
}

function failed(gate: GateFindings, name: string): boolean {
  const found = step(gate, name);
  return found !== undefined && found.exitCode !== null && found.exitCode !== 0;
}

function ran(gate: GateFindings, name: string): boolean {
  const found = step(gate, name);
  return found !== undefined && found.exitCode !== null;
}

/** What blocks the bump, what to investigate, and what to re-record. */
export function bumpVerdict(input: BumpReportInput): Verdict {
  const { gate } = input;
  const blocking: string[] = [];
  const investigate: string[] = [];
  const rerecord: Rerecord[] = [];

  if (failed(gate, "build")) blocking.push("The build failed (the end of its log is below); nothing else ran.");
  if (failed(gate, "driver:smoke")) {
    blocking.push("`driver:smoke` failed: the build does not boot, answer, load its modules or convert as it must.");
  }
  if (gate.dataFormat !== undefined && gate.dataFormat.differences.length > 0) {
    blocking.push(
      `The compatibility tuple changed (${names(gate.dataFormat.differences.map((entry) => entry.key))}): a minor release of PostgreSQL ${input.to.tag.replace(/^REL_(\d+)_.*/, "$1")} must keep dataFormat ${gate.dataFormat.declared}. Find out why; never declare a new dataFormat for a minor release.`,
    );
  } else if (failed(gate, "data-format:check")) {
    blocking.push("`data-format:check` failed (its message is in the log).");
  }
  if (gate.exports !== undefined && gate.exports.missingCore.length > 0) {
    blocking.push(
      `Core symbols are missing from the export list: ${names(gate.exports.missingCore)}. The host calls them.`,
    );
  }
  if (failed(gate, "prepopulated")) {
    blocking.push("`prepopulated` failed: the prepopulated data directory could not be made, or did not boot.");
  }
  if (ran(gate, "regress") && gate.regress === undefined) {
    blocking.push("pg_regress did not complete: no comparison with the baseline (its message is in the log).");
  }

  if (gate.exports !== undefined && gate.exports.added.length + gate.exports.removed.length > 0) {
    rerecord.push({
      record: "`exported_functions.txt`",
      command: "bun run exports:check --record",
      why: `the build's export list differs from the reference (${gate.exports.added.length} added, ${gate.exports.removed.length} removed)`,
    });
    if (gate.exports.removed.length > 0) {
      investigate.push(
        `${gate.exports.removed.length} symbol${gate.exports.removed.length === 1 ? "" : "s"} left the export list (${names(gate.exports.removed)}): say why each went (no shipped module imports it any more) before a release.`,
      );
    }
  }
  if (gate.prepopulated !== undefined) {
    const { prepopulated } = gate;
    if (
      prepopulated.artefactsChanged.length > 0 ||
      prepopulated.entries !== prepopulated.recorded.entries ||
      failed(gate, "prepopulated --check")
    ) {
      rerecord.push({
        record: "`identity/prepopulated.json`",
        command: "bun run prepopulated --record",
        why:
          prepopulated.artefactsChanged.length > 0
            ? `it records the previous build's artefacts (${names(prepopulated.artefactsChanged)} differ)`
            : "the prepopulated data directory differs from the record",
      });
    }
    if (prepopulated.entries !== prepopulated.recorded.entries) {
      investigate.push(
        `The prepopulated data directory has ${number(prepopulated.entries)} entries, not the recorded ${number(prepopulated.recorded.entries)}: say which files came or went.`,
      );
    }
  }
  const { regress } = gate;
  if (regress !== undefined) {
    const upstream = new Set(regress.changedUpstream);
    rerecord.push({
      record: "`regress/` (the baseline and its diffs)",
      command: "bun run regress --record --runs 8",
      why:
        regress.baseline.tag === input.to.tag
          ? "the results differ from the baseline"
          : `the baseline is ${input.from.tag}'s: the tests and their expected output are ${input.to.tag}'s now`,
    });
    const failing = [...regress.newFailures, ...regress.unexpectedFailing];
    if (failing.length > 0) {
      investigate.push(
        `${count(failing.length, "test")} newly fail${failing.length === 1 ? "s" : ""} (${names(failing)}${regress.unexpectedFailing.length > 0 ? `; new in the schedule: ${names(regress.unexpectedFailing)}` : ""}): each is investigated and put in a group with its reason before a release.`,
      );
    }
    const upstreamChanged = regress.changedDiffs.filter((test) => upstream.has(test));
    if (upstreamChanged.length > 0) {
      investigate.push(
        `${count(upstreamChanged.length, "failing test")} that changed upstream fail${upstreamChanged.length === 1 ? "s" : ""} differently (${names(upstreamChanged)}): say, per test, whether the new diff is only the new test's (and still its group's reason).`,
      );
    }
    const behaviour = regress.changedDiffs.filter((test) => !upstream.has(test));
    if (behaviour.length > 0) {
      investigate.push(
        `${count(behaviour.length, "failing test")} whose sql and expected output did not change upstream fail${behaviour.length === 1 ? "s" : ""} differently (${names(behaviour)}): say what changed in the build.`,
      );
    }
    if (regress.newlyUnstable.length > 0) {
      investigate.push(
        `Newly unstable: ${names(regress.newlyUnstable)}. The record's runs must show the instability, and its group say why.`,
      );
    }
    if (regress.missing.length + regress.unexpected.length > 0) {
      investigate.push(
        `The schedule changed: ${regress.unexpected.length > 0 ? `new tests ${names(regress.unexpected)}` : ""}${regress.unexpected.length > 0 && regress.missing.length > 0 ? "; " : ""}${regress.missing.length > 0 ? `gone ${names(regress.missing)}` : ""}.`,
      );
    }
    const backend = regress.runs.reduce((total, run) => total + run.backendFailures, 0);
    if (backend > 0)
      investigate.push(`The backend failed ${backend} times during pg_regress (the bridge's log says where).`);
  }
  return { blocking, investigate, rerecord };
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function codeBlock(text: string, language = "text"): string[] {
  const fence = text.includes("```") ? "````" : "```";
  return [`${fence}${language}`, text === "" ? "(empty)" : text, fence];
}

function details(summary: string, body: readonly string[]): string[] {
  return ["<details>", `<summary>${summary}</summary>`, "", ...body, "", "</details>"];
}

/** The apply log as a table of patches and results, with git am's output folded away. */
export function applySection(apply: ApplyLog): string[] {
  return [
    tableRow(["Patch", "Result"]),
    tableRow(["---", "---"]),
    ...apply.patches.map((entry) => tableRow([code(entry.patch), entry.result])),
    "",
    ...details("git am's output", codeBlock(apply.output)),
  ];
}

function header(from: TagRef, to: TagRef): string {
  return `PostgreSQL ${code(to.tag)} (${code(short(to.commit))}), from the pinned ${code(from.tag)} (${code(short(from.commit))})`;
}

/**
 * The conflicting files of a failed apply, a `### file` section each: the patch's hunks, where the plain apply
 * stopped, the 3-way merge's conflict regions with their text, and the upstream commits between the tags that changed
 * the file (when they were looked up).
 */
export function conflictSections(files: readonly ConflictedFile[]): string[] {
  const lines: string[] = [];
  for (const file of files) {
    lines.push("", `### ${code(file.file)}`, "");
    if (file.hunks.length > 0) lines.push(`- The patch's hunks: ${file.hunks.map(code).join(", ")}`);
    if (file.rejected.length > 0) lines.push(`- Where the plain apply stopped: ${names(file.rejected)}`);
    if (file.regions.length > 0) {
      lines.push(
        `- The 3-way merge's conflicts: lines ${file.regions.map((region) => `${region.start}-${region.end}`).join(", ")} of the merged file`,
      );
    } else {
      lines.push("- The 3-way merge left no conflict markers (it could not run: see git am's output).");
    }
    const touching = new Set(file.touching);
    if (file.commits === undefined) {
      // Not looked up: another major's tag is fetched without the history since the pinned one.
    } else if (file.commits.length === 0) {
      lines.push("- No upstream commit between the tags changed this file.");
    } else {
      lines.push(
        `- Upstream commits between the tags that changed the file (${file.commits.length}; **bold**: they changed the lines the patch's hunks stand on, ${touching.size}):`,
        "",
        tableRow(["Commit", "Date", "Subject"]),
        tableRow(["---", "---", "---"]),
        ...file.commits.map((commit) => {
          const mark = touching.has(commit.sha) ? (text: string) => `**${text}**` : (text: string) => text;
          return tableRow([mark(code(short(commit.sha))), commit.date, mark(escapeCell(commit.subject))]);
        }),
      );
    }
    file.excerpts.forEach((excerpt, index) => {
      const region = file.regions[index];
      lines.push(
        "",
        ...details(
          `Conflict ${index + 1}${region === undefined ? "" : ` (lines ${region.start}-${region.end})`}`,
          codeBlock(excerpt, "diff"),
        ),
      );
    });
  }
  return lines;
}

/** The report of a bump whose apply stopped on a conflict: nothing in the repository changed. */
export function conflictReport(input: ConflictReportInput): string {
  return [
    `# Bump ${input.from.tag} → ${input.to.tag}: CONFLICT`,
    "",
    `${header(input.from, input.to)}: ${code(`patches/${input.patch}`)} does not apply with \`git am --3way\`. Nothing in the repository changed: \`upstream.json\` and \`patches/\` are as they were, and no commit was made. ${count(input.upstreamTotal, "upstream commit")} lie between the tags.`,
    "",
    `To resolve it: \`bun run patches:work ${input.to.tag}\` leaves the series applied up to this patch, mid-\`git am\`, in \`work/${input.to.tag}\`; resolve the conflicts there (\`git add\`, \`git am --continue\`), set \`upstream.json\`'s tag and commit to ${code(input.to.tag)} and ${code(input.to.commit)}, then run \`bun run patches:export ${input.to.tag}\` and \`bun run patches:check\`, and commit.`,
    "",
    "## Apply",
    "",
    ...applySection(input.apply),
    "",
    "## Conflicts",
    ...conflictSections(input.files),
    "",
  ].join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function changeWords(change: PatchChange): string {
  const parts = [
    change.blobIds > 0 ? `${change.blobIds} blob id line${change.blobIds === 1 ? "" : "s"}` : undefined,
    change.hunkOffsets > 0 ? `${change.hunkOffsets} hunk offset${change.hunkOffsets === 1 ? "" : "s"}` : undefined,
    change.other > 0
      ? `${change.other} other line${change.other === 1 ? "" : "s"} (context or content: see the range-diff)`
      : undefined,
  ].filter((part) => part !== undefined);
  return parts.join(", ");
}

function sign(value: number): string {
  return value > 0 ? `+${number(value)}` : value < 0 ? `−${number(-value)}` : "0";
}

function sizeRow(row: SizeRow): string {
  if (row.before === undefined || row.after === undefined) {
    return tableRow([
      code(row.name),
      row.before === undefined ? "—" : number(row.before),
      row.after === undefined ? "—" : number(row.after),
      row.before === undefined ? "new" : "gone",
    ]);
  }
  const change = row.after - row.before;
  const percent =
    row.before === 0 ? "" : ` (${change >= 0 ? "+" : "−"}${((Math.abs(change) / row.before) * 100).toFixed(2)}%)`;
  return tableRow([
    code(row.name),
    number(row.before),
    number(row.after),
    `${sign(change)}${change === 0 ? "" : percent}`,
  ]);
}

const DETAIL_BUDGET = 30_000;
const DETAIL_LINES = 60;

function regressSection(input: BumpReportInput, regress: RegressFindings): string[] {
  const upstream = new Set(regress.changedUpstream);
  const tagged = (list: readonly string[]): string =>
    list.length === 0
      ? "none"
      : list.map((test) => `${code(test)}${upstream.has(test) ? " (changed upstream)" : ""}`).join(", ");
  const lines = [
    `Compared with the baseline recorded on ${code(regress.baseline.tag)} (${regress.baseline.tests} tests: ${regress.baseline.passed} pass, ${regress.baseline.failed} fail, ${regress.baseline.unstable} unstable), with ${input.to.tag}'s tests and expected output${regress.scheduleChanged ? " (its `parallel_schedule` changed)" : ""}. ${count(regress.changedUpstream.length, "test")} changed upstream between the tags.`,
    "",
    tableRow(["Run", "Tests", "Pass", "Fail", "Backend failures", "Time"]),
    tableRow(["---", "---:", "---:", "---:", "---:", "---:"]),
    ...regress.runs.map((run, index) =>
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
    `- New failures (passed in the baseline): ${tagged(regress.newFailures)}`,
    `- Changed diffs (failed in the baseline, fail differently now): ${tagged(regress.changedDiffs)}`,
    `- Newly unstable: ${tagged(regress.newlyUnstable)}`,
    `- Vanished (failed in the baseline, pass now): ${tagged(regress.vanished)}`,
    `- Unstable in the baseline (reported apart): ${tagged(regress.unstable)}`,
    `- Not run (in the baseline): ${tagged(regress.missing)}`,
    `- Not in the baseline (new in the schedule): ${regress.unexpected.length === 0 ? "none" : regress.unexpected.map((test) => `${code(test)} (${regress.unexpectedFailing.includes(test) ? "fails" : "passes"})`).join(", ")}`,
  ];
  let budget = DETAIL_BUDGET;
  for (const detail of regress.details) {
    const all = detail.text.trimEnd().split("\n");
    const shown =
      all.length > DETAIL_LINES ? [...all.slice(0, DETAIL_LINES), `… ${all.length - DETAIL_LINES} more lines`] : all;
    const text = shown.join("\n");
    if (text.length > budget) {
      lines.push("", `(Further diffs are left out for length: \`.cache/regress/runs/1/normalised/\` has them.)`);
      break;
    }
    budget -= text.length;
    const kind = [...regress.newFailures, ...regress.unexpectedFailing].includes(detail.test)
      ? "its diff"
      : "its diff against the recorded one (- recorded, + this run)";
    lines.push(
      "",
      ...details(
        `${htmlCode(detail.test)}${upstream.has(detail.test) ? " (changed upstream)" : ""}: ${kind}`,
        codeBlock(text, "diff"),
      ),
    );
  }
  return lines;
}

/** Words wrapped at `width` columns; a word longer than the width gets a line of its own. */
export function wrap(text: string, width = 72, indent = ""): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    const next = line === "" ? `${indent}${word}` : `${line} ${word}`;
    if (next.length > width && line !== "") {
      lines.push(line);
      line = `${indent}${word}`;
    } else line = next;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** The bump commit's message: what moved, how each patch applied, and what changed in patches/. */
export function bumpCommitMessage(input: {
  readonly from: TagRef;
  readonly to: TagRef;
  readonly apply: ApplyLog;
  readonly changes: readonly PatchChange[];
}): string {
  const { from, to } = input;
  const bullet = (text: string): string[] => {
    const [first = "", ...rest] = wrap(text, 70);
    return [`- ${first}`, ...rest.map((line) => `  ${line}`)];
  };
  return [
    `upstream: bump the pin to ${to.tag}`,
    "",
    ...wrap(
      `\`bun run bump ${to.tag}\`: upstream.json pins PostgreSQL ${to.tag} (${to.commit}) instead of ${from.tag} (${from.commit}), and patches/ is the series re-exported onto it. Each patch, applied with git am --3way:`,
    ),
    "",
    ...input.apply.patches.flatMap((entry) => bullet(`${entry.patch}: ${entry.result}`)),
    "",
    ...wrap(
      input.changes.length === 0
        ? "The re-exported patches are byte-identical."
        : `The re-exported patches change only where upstream moved: ${input.changes.map((change) => `${change.patch.slice(0, 4)} (${changeWords(change)})`).join("; ")}.`,
    ),
    "",
    ...wrap(
      "The engine gate's records (the regress baseline, exported_functions.txt, identity/prepopulated.json) are left as they are: the bump's report says what differs, and each is re-recorded in its own commit.",
    ),
    "",
  ].join("\n");
}

/** The report of a bump whose series applied: the bump is committed, and the gate ran on it. */
export function bumpReport(input: BumpReportInput): string {
  const { gate } = input;
  const verdict = bumpVerdict(input);
  const lines: string[] = [
    `# Bump ${input.from.tag} → ${input.to.tag} (pgwasm-postgres ${input.version})`,
    "",
    `${header(input.from, input.to)}, committed as ${code(short(input.commit))}. ${count(input.upstream.total, "upstream commit")} lie between the tags; ${number(input.upstream.commits.length)} of them change the ${count(input.upstream.patchedFiles.length, "file")} the series patches.`,
    "",
  ];
  if (verdict.blocking.length > 0) {
    lines.push(
      "**STOP.** This bump cannot be released as it is:",
      "",
      ...verdict.blocking.map((line) => `- ${line}`),
      "",
    );
  } else {
    lines.push(
      "**The series applies and the build passes.** What the engine gate found against the records is below; re-record each record that differs, in its own commit, only after reading it, and explain each change in the commit message.",
      "",
    );
  }
  if (verdict.investigate.length > 0) {
    lines.push(
      "To investigate and explain before a release:",
      "",
      ...verdict.investigate.map((line) => `- ${line}`),
      "",
    );
  }
  if (verdict.rerecord.length > 0) {
    lines.push(
      "Records that differ (a bump never re-records one):",
      "",
      tableRow(["Record", "Why", "Re-record with"]),
      tableRow(["---", "---", "---"]),
      ...verdict.rerecord.map((entry) => tableRow([entry.record, entry.why, code(entry.command)])),
      "",
    );
  }

  lines.push("## Apply", "", ...applySection(input.apply), "");
  lines.push(
    input.changes.length === 0
      ? "`patches/` re-exported onto the new tag: byte-identical."
      : `\`patches/\` re-exported onto the new tag: ${input.changes.map((change) => `${code(change.patch)} (${changeWords(change)})`).join("; ")}.`,
    "",
    `\`patches:check\` passes on ${code(input.to.tag)}: tree ${code(input.tree)}.`,
    "",
    "## Range-diff",
    "",
    `\`git range-diff ${input.from.tag}..<series on ${input.from.tag}> ${input.to.tag}..<series on ${input.to.tag}>\` (\`=\`: the patch is unchanged but for where it applies):`,
    "",
    ...codeBlock(input.rangeDiff),
    "",
    "## Upstream changes to the patched files",
    "",
  );
  if (input.upstream.commits.length === 0) {
    lines.push("No upstream commit between the tags changes a file the series patches.", "");
  } else {
    lines.push(
      tableRow(["Commit", "Date", "Subject", "Patched files it changes"]),
      tableRow(["---", "---", "---", "---"]),
      ...input.upstream.commits.map((commit) =>
        tableRow([code(short(commit.sha)), commit.date, escapeCell(commit.subject), names(commit.files)]),
      ),
      "",
    );
  }

  lines.push(
    "## Engine gate",
    "",
    `\`bun run gate --keep-going\` at ${code(short(input.commit))}${gate.version === undefined ? "" : `: \`SELECT version()\` names ${code(`pgwasm-postgres ${gate.version}`)}`}.`,
    "",
    tableRow(["Step", "Result", "Time"]),
    tableRow(["---", "---", "---:"]),
    ...gate.steps.map((entry) =>
      tableRow([
        code(entry.name),
        entry.exitCode === null ? "not run" : entry.exitCode === 0 ? "passed" : `FAILED (exit ${entry.exitCode})`,
        entry.exitCode === null ? "" : `${entry.seconds} s`,
      ]),
    ),
    "",
  );
  if (gate.buildLog.length > 0)
    lines.push(...details("The end of the build log", codeBlock(gate.buildLog.join("\n"))), "");

  lines.push("### Export list", "");
  if (gate.exports === undefined) lines.push("Not compared: no build.", "");
  else {
    const { exports } = gate;
    lines.push(
      `${number(exports.symbols)} symbols against the reference's ${number(exports.reference)}: ${exports.added.length} added${exports.added.length > 0 ? ` (${names(exports.added)})` : ""}, ${exports.removed.length} removed${exports.removed.length > 0 ? ` (${names(exports.removed)})` : ""}; ${exports.missingCore.length === 0 ? "no core symbol missing" : `**${exports.missingCore.length} core symbols missing** (${names(exports.missingCore)})`}.`,
      "",
    );
  }

  lines.push("### Data format", "");
  if (gate.dataFormat === undefined) lines.push("Not checked: no build.", "");
  else if (gate.dataFormat.differences.length === 0) {
    lines.push(
      `The compatibility tuple is dataFormat ${gate.dataFormat.declared}'s, unchanged (catalog_version_no ${gate.dataFormat.catalogVersion}).`,
      "",
    );
  } else {
    lines.push(
      `**The compatibility tuple changed:** ${gate.dataFormat.differences.map((entry) => `${code(entry.key)} ${entry.declared} → ${entry.actual}`).join(", ")}. STOP: a minor release must keep dataFormat ${gate.dataFormat.declared}.`,
      "",
    );
  }

  lines.push("### pg_regress", "");
  if (gate.regress === undefined) lines.push("No comparison: pg_regress did not run to the end.", "");
  else lines.push(...regressSection(input, gate.regress), "");

  lines.push("### Prepopulated data directory", "");
  if (gate.prepopulated === undefined) lines.push("Not made: the step did not run or failed.", "");
  else {
    const { prepopulated } = gate;
    lines.push(
      `Made and booted: ${number(prepopulated.entries)} entries, ${number(prepopulated.bytes)} bytes (the record: ${number(prepopulated.recorded.entries)} entries, ${number(prepopulated.recorded.bytes)} bytes). ${prepopulated.artefactsChanged.length > 0 ? `The record is of other artefacts (${names(prepopulated.artefactsChanged)}), so \`prepopulated --check\` cannot hold until it is re-recorded.` : "The record is of these artefacts."}`,
      "",
    );
  }

  lines.push("### Sizes", "");
  if ("unavailable" in gate.sizes) {
    lines.push(
      `Not compared${gate.sizes.previous === undefined ? "" : ` with ${code(gate.sizes.previous)}`}: ${gate.sizes.unavailable}.`,
      "",
    );
  } else {
    lines.push(
      `Against the ${code(gate.sizes.previous)} release's \`manifest.json\`:`,
      "",
      tableRow(["File", gate.sizes.previous, input.version, "Change"]),
      tableRow(["---", "---:", "---:", "---"]),
      ...gate.sizes.rows.map(sizeRow),
      "",
    );
  }
  return lines.join("\n");
}
