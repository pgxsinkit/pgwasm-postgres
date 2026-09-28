/**
 * The engine gate's output (ADR-0001 decisions 6 and 9): everything a release publishes, in one flat directory,
 * `.cache/gate/<commit>/`, which `bun run gate` fills only when every check passed:
 *
 * - the artefacts: `pglite.{wasm,data,js}`, `initdb.{wasm,js}`, `pg_dump.{wasm,js}`, each extension archive
 *   (`amcheck.tar.gz`), and the export list pglite.wasm was linked with (`exported_functions.txt`);
 * - `prepopulated.tar.gz`, the prepopulated data directory made at the commit's SOURCE_DATE_EPOCH;
 * - `data-format.json`, the declared `dataFormat` and its compatibility tuple;
 * - `manifest.json` ({@link GateManifest}): every other file's bytes and sha256, the version, the commit and its
 *   epoch, the upstream tag and commit, the `dataFormat` and tuple, the builder image, the export list against
 *   the reference, and the pg_regress result;
 * - `SHA256SUMS`: `sha256sum -c` lines for every file but itself.
 *
 * Nothing in the manifest varies between two gates of one commit, so the release job, which runs the gate again
 * at the tag, requires its manifest to be identical to the one of the gated build ({@link compareGateManifests}):
 * what was gated is provably what ships.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { readJson, SHA } from "./config.ts";
import { sha256Hex } from "./digest.ts";
import { UserError } from "./git.ts";
import type { Layout } from "./layout.ts";
import { TUPLE_KEYS, type CompatibilityTuple } from "./pg-control.ts";

export const GATE_MANIFEST = "manifest.json";
export const SUMS_FILE = "SHA256SUMS";

/** The gate's directory for a commit. */
export function gateDir(layout: Layout, commit: string): string {
  return join(layout.cacheDir, "gate", commit);
}

/** Where the gate collects the release while it runs; renamed to {@link gateDir} only when every check passed. */
export function gateStaging(layout: Layout, commit: string): string {
  return `${gateDir(layout, commit)}.partial`;
}

/** The name of the artifact `gate.yml` uploads a commit's gate directory as. */
export function gateArtifact(commit: string): string {
  return `gate-${commit}`;
}

/** One step of a gate run: its exit code, or null when it did not run (an earlier step failed). */
export interface GateStep {
  readonly name: string;
  readonly exitCode: number | null;
  readonly seconds: number;
}

/** How each step of a gate run ended, passed or not: `.cache/gate/<commit>.steps.json` (a bump reads it). */
export interface GateSteps {
  readonly commit: string;
  /** `--keep-going`: the steps after a failed one ran too (all but the build's). */
  readonly keepGoing: boolean;
  readonly steps: readonly GateStep[];
}

export function gateStepsFile(layout: Layout, commit: string): string {
  return `${gateDir(layout, commit)}.steps.json`;
}

/**
 * The Markdown `patches:tokens` wrote for the gate's summary (ADR-0001 decision 4): report-only, so it is neither a
 * step nor in the manifest.
 */
export function gateTokensFile(layout: Layout, commit: string): string {
  return `${gateDir(layout, commit)}.tokens.md`;
}

export function formatGateSteps(steps: GateSteps): string {
  return `${JSON.stringify(steps, null, 2)}\n`;
}

export function readGateSteps(layout: Layout, commit: string): GateSteps | undefined {
  const file = gateStepsFile(layout, commit);
  if (!existsSync(file)) return undefined;
  const json = readJson(file, layout.root);
  const steps = json["steps"];
  if (json["commit"] !== commit || !Array.isArray(steps)) throw new UserError(`${file} is not the steps of ${commit}.`);
  return {
    commit,
    keepGoing: json["keepGoing"] === true,
    steps: steps.map((entry: unknown, index) => {
      const step = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      const exitCode = step["exitCode"];
      if (typeof step["name"] !== "string" || !(exitCode === null || typeof exitCode === "number")) {
        throw new UserError(`${file}: steps[${index}] is not a step.`);
      }
      return { name: step["name"], exitCode, seconds: Number(step["seconds"] ?? 0) };
    }),
  };
}

export interface GateFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface GateManifest {
  /** The release version the build embeds, `version()`'s `pgwasm-postgres <version>`. */
  readonly version: string;
  /** The commit of this repository, and the tree `patches:check` proved (the tag, the series, the overlay). */
  readonly commit: string;
  readonly tree: string;
  /** The commit's time: the build's and the prepopulated data directory's SOURCE_DATE_EPOCH. */
  readonly sourceDateEpoch: number;
  readonly upstream: { readonly tag: string; readonly commit: string };
  readonly dataFormat: number;
  readonly tuple: CompatibilityTuple;
  readonly builder: {
    /** The reference the build ran: the published image by digest, or a local build of builder/. */
    readonly image: string;
    readonly id: string;
    /** The published image's digest, or null when the build did not run in the published image. */
    readonly digest: string | null;
    /** The content of builder/ at the commit (see builder-lock.ts). */
    readonly contentSha256: string;
  };
  /** The build's export list against the reference, exported_functions.txt at the commit. */
  readonly exports: {
    readonly symbols: number;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
  /** The pg_regress gate: the baseline the run matched, and the failures it records that passed. */
  readonly regress: {
    readonly schedule: string;
    /** The digest of regress/ (baseline.json and diffs/) at the commit. */
    readonly baselineSha256: string;
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly unstable: number;
    readonly vanished: readonly string[];
  };
  /** Every file of the directory but the manifest and SHA256SUMS, sorted by name. */
  readonly files: readonly GateFile[];
}

const COMMENT =
  "Written by `bun run gate` (ADR-0001 decisions 6 and 9): every release asset's bytes and sha256, what they were built from and what the engine gate found. Two gates of one commit give identical manifests; the release job requires its own to be identical to the gated build's. `sha256sum -c SHA256SUMS` checks the files.";

export function formatGateManifest(manifest: GateManifest): string {
  return `${JSON.stringify({ $comment: COMMENT, ...manifest }, null, 2)}\n`;
}

const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** Reads and checks a gate manifest; `name` names it in messages. */
export function parseGateManifest(json: Record<string, unknown>, name: string): GateManifest {
  const fail = (what: string): never => {
    throw new UserError(`${name}: ${what}`);
  };
  const object = (value: unknown, what: string): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fail(`\`${what}\` must be an object`);
  const string = (value: unknown, what: string, pattern?: RegExp): string =>
    typeof value === "string" && (pattern === undefined || pattern.test(value))
      ? value
      : fail(`\`${what}\` is ${JSON.stringify(value)}`);
  const count = (value: unknown, what: string): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : fail(`\`${what}\` must be a non-negative integer`);
  const strings = (value: unknown, what: string): string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? (value as string[])
      : fail(`\`${what}\` must be a list of strings`);

  const upstream = object(json["upstream"], "upstream");
  const tuple = object(json["tuple"], "tuple");
  if (Object.keys(tuple).sort().join(",") !== [...TUPLE_KEYS].sort().join(","))
    fail("`tuple` must have the tuple's keys");
  const builder = object(json["builder"], "builder");
  const exports = object(json["exports"], "exports");
  const regress = object(json["regress"], "regress");
  const files = Array.isArray(json["files"]) ? (json["files"] as unknown[]) : fail("`files` must be a list");
  const digest = builder["digest"];
  return {
    version: string(json["version"], "version", VERSION),
    commit: string(json["commit"], "commit", SHA),
    tree: string(json["tree"], "tree", SHA),
    sourceDateEpoch: count(json["sourceDateEpoch"], "sourceDateEpoch"),
    upstream: {
      tag: string(upstream["tag"], "upstream.tag"),
      commit: string(upstream["commit"], "upstream.commit", SHA),
    },
    dataFormat: count(json["dataFormat"], "dataFormat"),
    tuple: tuple as unknown as CompatibilityTuple,
    builder: {
      image: string(builder["image"], "builder.image"),
      id: string(builder["id"], "builder.id", SHA256),
      digest: digest === null ? null : string(digest, "builder.digest", DIGEST),
      contentSha256: string(builder["contentSha256"], "builder.contentSha256", SHA256),
    },
    exports: {
      symbols: count(exports["symbols"], "exports.symbols"),
      added: strings(exports["added"], "exports.added"),
      removed: strings(exports["removed"], "exports.removed"),
    },
    regress: {
      schedule: string(regress["schedule"], "regress.schedule"),
      baselineSha256: string(regress["baselineSha256"], "regress.baselineSha256", SHA256),
      tests: count(regress["tests"], "regress.tests"),
      passed: count(regress["passed"], "regress.passed"),
      failed: count(regress["failed"], "regress.failed"),
      unstable: count(regress["unstable"], "regress.unstable"),
      vanished: strings(regress["vanished"], "regress.vanished"),
    },
    files: files.map((entry, index) => {
      const file = object(entry, `files[${index}]`);
      return {
        name: string(file["name"], `files[${index}].name`, /^[^/\\]+$/),
        bytes: count(file["bytes"], `files[${index}].bytes`),
        sha256: string(file["sha256"], `files[${index}].sha256`, SHA256),
      };
    }),
  };
}

export function readGateManifest(dir: string, root: string): GateManifest {
  const file = join(dir, GATE_MANIFEST);
  if (!existsSync(file)) throw new UserError(`${dir} has no ${GATE_MANIFEST}: it is not a gate directory.`);
  return parseGateManifest(readJson(file, root), file);
}

export function digestFile(dir: string, name: string): GateFile {
  const bytes = new Uint8Array(readFileSync(join(dir, name)));
  return { name, bytes: bytes.length, sha256: sha256Hex(bytes) };
}

const byName = (a: { name: string }, b: { name: string }): number =>
  Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));

/** The digests of a directory's files, sorted by name. */
export function digestFiles(dir: string, names: readonly string[]): GateFile[] {
  return names.map((name) => digestFile(dir, name)).sort(byName);
}

/** `SHA256SUMS`: `<sha256>  <name>` per file, sorted by name, as `sha256sum` writes and `sha256sum -c` reads it. */
export function formatSums(files: readonly GateFile[]): string {
  return [...files]
    .sort(byName)
    .map((file) => `${file.sha256}  ${file.name}\n`)
    .join("");
}

/**
 * Everything wrong with a gate directory: a file missing, extra or different from what its manifest records, a
 * subdirectory, or a SHA256SUMS that is not the one of its files. Empty when the directory is what its manifest
 * says.
 */
export function verifyGateDir(dir: string, manifest: GateManifest): string[] {
  const problems: string[] = [];
  const present = readdirSync(dir).sort();
  const listed = new Set([...manifest.files.map((file) => file.name), GATE_MANIFEST, SUMS_FILE]);
  for (const name of present) {
    if (!statSync(join(dir, name)).isFile()) problems.push(`${name} is not a file`);
    else if (!listed.has(name)) problems.push(`${name} is not in the manifest`);
  }
  for (const name of listed) if (!present.includes(name)) problems.push(`${name} is missing`);
  for (const expected of manifest.files) {
    if (!present.includes(expected.name)) continue;
    const actual = digestFile(dir, expected.name);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      problems.push(
        `${expected.name} is ${actual.bytes} bytes, ${actual.sha256}; the manifest has ${expected.bytes} bytes, ${expected.sha256}`,
      );
    }
  }
  if (present.includes(SUMS_FILE) && present.includes(GATE_MANIFEST)) {
    const expected = formatSums([...manifest.files, digestFile(dir, GATE_MANIFEST)]);
    if (readFileSync(join(dir, SUMS_FILE), "utf8") !== expected) {
      problems.push(`${SUMS_FILE} is not the sha256 list of the directory's files`);
    }
  }
  return problems;
}

/** A value's differences from another, as `<path>: <expected> → <actual>` lines. */
function differences(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isObject(expected) && isObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      differences(expected[key], actual[key], path === "" ? key : `${path}.${key}`, out);
    }
    return;
  }
  out.push(`${path}: ${JSON.stringify(expected) ?? "(none)"} → ${JSON.stringify(actual) ?? "(none)"}`);
}

/**
 * How a gate manifest differs from the one it must equal (the gated build's): one line per differing field, and
 * per file by name. Empty when they are identical.
 */
export function compareGateManifests(expected: GateManifest, actual: GateManifest): string[] {
  const out: string[] = [];
  const { files: expectedFiles, ...expectedRest } = expected;
  const { files: actualFiles, ...actualRest } = actual;
  differences(expectedRest, actualRest, "", out);
  const actualByName = new Map(actualFiles.map((file) => [file.name, file]));
  for (const want of expectedFiles) {
    const got = actualByName.get(want.name);
    if (got === undefined) out.push(`files: ${want.name} is missing`);
    else if (got.bytes !== want.bytes || got.sha256 !== want.sha256) {
      out.push(`files: ${want.name}: ${want.bytes} bytes, ${want.sha256} → ${got.bytes} bytes, ${got.sha256}`);
    }
  }
  const expectedNames = new Set(expectedFiles.map((file) => file.name));
  for (const got of actualFiles) if (!expectedNames.has(got.name)) out.push(`files: ${got.name} is new`);
  return out;
}

const number = (value: number): string => value.toLocaleString("en-US");

/** A Markdown table of the files: name, bytes, sha256. */
export function filesTable(files: readonly GateFile[]): string[] {
  return [
    "| File | Bytes | sha256 |",
    "| --- | ---: | --- |",
    ...files.map((file) => `| \`${file.name}\` | ${number(file.bytes)} | \`${file.sha256}\` |`),
  ];
}

/** One line on the pg_regress result. */
export function regressLine(regress: GateManifest["regress"]): string {
  const vanished =
    regress.vanished.length === 0
      ? ""
      : `; ${regress.vanished.length} recorded failure${regress.vanished.length === 1 ? "" : "s"} passed (${regress.vanished.join(", ")})`;
  return `pg_regress \`${regress.schedule}\`: ${regress.tests} tests, ${regress.passed} pass, ${regress.failed} fail as the baseline records, ${regress.unstable} unstable; no new failure, no changed diff${vanished} (baseline \`${regress.baselineSha256.slice(0, 12)}\`)`;
}

/** Symbols, as a short list: the first `limit`, and how many more. */
export function symbolList(symbols: readonly string[], limit = 20): string {
  const shown = symbols.slice(0, limit).map((symbol) => `\`${symbol}\``);
  return symbols.length > limit ? `${shown.join(" ")} and ${symbols.length - limit} more` : shown.join(" ");
}

/** A list's change: `+2 (…), −1 (…)`, or `no change`. */
export function changeLine(added: readonly string[], removed: readonly string[]): string {
  if (added.length + removed.length === 0) return "no change";
  return [
    added.length === 0 ? undefined : `${added.length} added (${symbolList(added)})`,
    removed.length === 0 ? undefined : `${removed.length} removed (${symbolList(removed)})`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

/** One line on the export list against the reference. */
export function exportsLine(exports: GateManifest["exports"]): string {
  return `export list: ${number(exports.symbols)} symbols; against \`exported_functions.txt\` at the commit: ${changeLine(exports.added, exports.removed)}`;
}

/** The compatibility tuple, shortened to what changes between majors. */
export function dataFormatLine(manifest: Pick<GateManifest, "dataFormat" | "tuple">): string {
  const { tuple } = manifest;
  return `dataFormat ${manifest.dataFormat}: pg_control_version ${tuple.pg_control_version}, catalog_version_no ${tuple.catalog_version_no}, WAL page magic ${tuple.xlp_magic}, float8ByVal ${String(tuple.float8ByVal)} (the full tuple is in \`data-format.json\` and \`manifest.json\`)`;
}

/** Where the build's image came from, in words. */
export function builderLine(builder: GateManifest["builder"]): string {
  return builder.digest === null
    ? `builder image \`${builder.image}\` (id \`${builder.id.slice(0, 12)}\`), built from builder/ (\`${builder.contentSha256.slice(0, 12)}\`), not the published image`
    : `builder image \`${builder.image}\` (id \`${builder.id.slice(0, 12)}\`), the published image by digest`;
}

/** The job summary of a passed gate, with the report-only token check's Markdown when it ran. */
export function gateSummary(manifest: GateManifest, tokens?: string): string {
  return [
    `### Engine gate passed: pgwasm-postgres ${manifest.version} at \`${manifest.commit.slice(0, 12)}\``,
    "",
    `PostgreSQL \`${manifest.upstream.tag}\` (\`${manifest.upstream.commit.slice(0, 12)}\`) with the series, tree \`${manifest.tree.slice(0, 12)}\`, SOURCE_DATE_EPOCH ${manifest.sourceDateEpoch} (${new Date(manifest.sourceDateEpoch * 1000).toISOString()}).`,
    "",
    ...filesTable(manifest.files),
    "",
    `- ${dataFormatLine(manifest)}`,
    `- ${regressLine(manifest.regress)}`,
    `- ${exportsLine(manifest.exports)}`,
    `- ${builderLine(manifest.builder)}`,
    ...(tokens === undefined ? [] : [tokens.trimEnd()]),
    "",
  ].join("\n");
}
