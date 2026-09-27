/**
 * What a pg_regress run leaves behind, read back: its TAP status lines, its `regression.diffs` split per test
 * and normalised so that two runs of the same build give the same bytes, and the bridge's backend failures.
 */

export interface TestStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
}

/** pg_regress's status lines: `ok 12   + boolean   85 ms`, `not ok 13   - char   40 ms` (test_status_print). */
const STATUS_LINE = /^(not )?ok\s+\d+\s+[+-] (\S+)\s+(\d+) ms$/;

export function parseStatusLines(output: string): TestStatus[] {
  const tests: TestStatus[] = [];
  for (const line of output.split("\n")) {
    const match = STATUS_LINE.exec(line.trimEnd());
    if (match === null) continue;
    tests.push({ name: match[2] ?? "", ok: match[1] === undefined, ms: Number(match[3]) });
  }
  return tests;
}

/** The directories and port of a run, which a normalised diff replaces with placeholders. */
export interface RunPaths {
  /** pg_regress's `--inputdir` (`abs_srcdir`), which also holds `expected/`. */
  readonly inputDir: string;
  /** pg_regress's `--outputdir` (`abs_builddir`), which holds `results/` and the regress library. */
  readonly outputDir: string;
  readonly port: number;
}

/**
 * Splits `regression.diffs` into one diff per test, keyed by test name. pg_regress appends, for each failed
 * test, a header line `diff <options> <expected file> <results file>` and then diff's own output.
 */
export function splitDiffs(text: string): Map<string, string> {
  const diffs = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (name !== undefined) diffs.set(name, `${lines.join("\n").trimEnd()}\n`);
  };
  for (const line of text.split("\n")) {
    const header = /^diff .* \S*\/results\/([^/\s]+)\.out$/.exec(line);
    if (header !== null) {
      flush();
      name = header[1];
      lines = [];
    }
    if (name !== undefined) lines.push(line);
  }
  flush();
  return diffs;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A test's diff without what is specific to one run: the header's absolute paths become `expected/…` and
 * `results/…`, the `---`/`+++` lines lose their paths and timestamps, and in the content the input and output
 * directories become `@abs_srcdir@` and `@abs_builddir@` and the bridge's port `@port@`. Everything else is
 * kept.
 */
export function normaliseDiff(diff: string, paths: RunPaths): string {
  const expected = new RegExp(`${escapeRegExp(paths.inputDir)}/expected/`, "g");
  const results = new RegExp(`${escapeRegExp(paths.outputDir)}/results/`, "g");
  const input = new RegExp(escapeRegExp(paths.inputDir), "g");
  const output = new RegExp(escapeRegExp(paths.outputDir), "g");
  const port = new RegExp(`\\bport ${paths.port}\\b`, "g");
  return diff
    .split("\n")
    .map((line, index) => {
      if (index === 0 && line.startsWith("diff ")) {
        return line.replace(expected, "expected/").replace(results, "results/");
      }
      const file = /^(---|\+\+\+) (\S+)\t.*$/.exec(line);
      if (file !== null && (line.startsWith("--- ") || line.startsWith("+++ "))) {
        const name = (file[2] ?? "").replace(expected, "expected/").replace(results, "results/");
        if (name.startsWith("expected/") || name.startsWith("results/")) return `${file[1]} ${name}`;
      }
      return line.replace(input, "@abs_srcdir@").replace(output, "@abs_builddir@").replace(port, "port @port@");
    })
    .join("\n");
}

export interface BackendFailure {
  /** The test the connection belonged to (its application_name `pg_regress/<test>`), or the name as logged. */
  readonly test: string;
  readonly error: string;
}

/** The bridge log's `#<id> <application_name>: BACKEND FAILED: <error>` lines. */
export function backendFailures(log: string): BackendFailure[] {
  const failures: BackendFailure[] = [];
  for (const line of log.split("\n")) {
    const match = /#\d+ (\S*): BACKEND FAILED: (.*)$/.exec(line);
    if (match === null) continue;
    failures.push({ test: (match[1] ?? "").replace(/^pg_regress\//, ""), error: match[2] ?? "" });
  }
  return failures;
}
