/**
 * The prepopulated data directory (ADR-0001 decision 10): a fresh cluster to start from instead of running
 * initdb, made by this build's own initdb through the driver and packed as a deterministic tarball.
 *
 * It reproduces how ElectricSQL made `@electric-sql/pglite-prepopulatedfs` 0.5.8 (its `generateFS.ts`):
 * `PGlite.create()` ran initdb with PGlite's arguments on a scratch instance, copied the cluster into a
 * fresh instance and started the backend there with PGlite's start parameters; `dumpDataDir('gzip')` then
 * archived the data directory of the running backend, before `close()`. So the archive holds the files the
 * start writes (`postmaster.pid`, the relcache init files, the XLOG_PARAMETER_CHANGE record the start
 * parameters cause, pg_control in production), and restoring it recovers from initdb's shutdown checkpoint.
 * Members are the data directory's files and directories with absolute paths (`/global/pg_control`) and no
 * root member, as in ElectricSQL's asset.
 *
 * What makes it deterministic: the driver's deterministic host (a virtual clock from `SOURCE_DATE_EPOCH`,
 * seeded entropy, UTC), and the tarball's normalisation: members sorted by path, mtimes at
 * `SOURCE_DATE_EPOCH`, owner 0/0, modes 0750 (directories) and 0640 (files), which are the modes Postgres
 * gives a cluster made with `--allow-group-access`, and gzip with no name and mtime 0. It carries no pgwasm
 * build marker: pgwasm adds one when it restores the archive.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { field, IDENTITY_KINDS, readIdentityRecord, stringField, type Json } from "./config.ts";
import { DRIVER_FILES, type Artefacts, type DriverFile } from "./driver/artefacts.ts";
import { deterministicHost } from "./driver/determinism.ts";
import { initdb } from "./driver/initdb.ts";
import { Postgres, type DataDirEntry } from "./driver/postgres.ts";
import { UserError } from "./git.ts";
import type { Layout } from "./layout.ts";
import {
  ControlFileError,
  parseControlFile,
  RESOURCE_MANAGERS,
  walRecords,
  type ControlFile,
  type ControlValue,
} from "./pg-control.ts";
import { gzipDeterministic, readTar, writeTar } from "./tar.ts";

export const DIRECTORY_MODE = 0o750;
export const FILE_MODE = 0o640;
/** pgwasm's build marker (pgxsinkit ADR-0063); the asset must not carry one. */
export const BUILD_MARKER_PATH = "/PGWASM_BUILD";

export interface Prepopulated {
  /** The data directory, sorted by path, as the archive holds it. */
  readonly entries: readonly DataDirEntry[];
  /** The uncompressed archive: its bytes depend only on the entries and `SOURCE_DATE_EPOCH`. */
  readonly tar: Uint8Array;
  /** The asset: `tar`, gzipped. */
  readonly asset: Uint8Array;
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The archive of a data directory: sorted members with fixed mtimes, modes and owner. */
export function packDataDir(entries: readonly DataDirEntry[], sourceDateEpoch: number): Uint8Array {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.path.startsWith("/") || entry.path.endsWith("/") || entry.path.includes("//")) {
      throw new Error(`Data directory entry ${JSON.stringify(entry.path)} is not an absolute path inside it`);
    }
    if (seen.has(entry.path)) throw new Error(`Data directory entry ${entry.path} appears twice`);
    seen.add(entry.path);
    if (entry.path === BUILD_MARKER_PATH)
      throw new Error(`The data directory carries a build marker (${BUILD_MARKER_PATH})`);
  }
  return writeTar(
    [...entries].sort(byPath).map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.type === "directory" ? DIRECTORY_MODE : FILE_MODE,
      mtime: sourceDateEpoch,
      data: entry.data,
    })),
  );
}

/** A data directory archive's entries (gzipped or not), as the driver writes them into MEMFS. */
export function unpackDataDir(archive: Uint8Array): DataDirEntry[] {
  return readTar(archive).map((member) => {
    if (member.type !== "file" && member.type !== "directory") {
      throw new Error(`Data directory archive member ${member.path} is a ${member.type}`);
    }
    const path = `/${member.path.replace(/^\.?\/+/, "").replace(/\/+$/, "")}`;
    return { path, type: member.type, mode: member.mode, data: member.data };
  });
}

/**
 * Makes the prepopulated data directory from a build's artefacts: initdb, a start, and the archive of the
 * running backend's data directory.
 */
export async function generatePrepopulated(
  artefacts: Artefacts,
  sourceDateEpoch: number,
  log?: (line: string) => void,
): Promise<Prepopulated> {
  const host = deterministicHost(sourceDateEpoch);
  const options = { host, ...(log ? { log } : {}) };
  const cluster = await initdb(artefacts, options);
  const postgres = await Postgres.create(artefacts, options);
  let entries: DataDirEntry[];
  try {
    postgres.writeDataDir(cluster);
    postgres.start();
    entries = postgres.readDataDir();
  } finally {
    // No shutdown: the archive is of the running backend, as ElectricSQL's is.
    postgres.dispose();
  }
  const tar = packDataDir(entries, sourceDateEpoch);
  return { entries, tar, asset: gzipDeterministic(tar) };
}

export interface Digest {
  readonly bytes: number;
  readonly sha256: string;
}

export function digestOf(bytes: Uint8Array): Digest {
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** What `identity/prepopulated.json` records: the inputs of a generation and what they gave. */
export interface PrepopulatedRecord {
  readonly sourceDateEpoch: number;
  /** sha256 of each file the driver loads. */
  readonly artefacts: Readonly<Record<DriverFile, string>>;
  readonly entries: number;
  readonly tar: Digest;
  readonly asset: Digest;
}

export function artefactDigests(artefacts: Artefacts): Record<DriverFile, string> {
  return Object.fromEntries(
    DRIVER_FILES.map((name) => [name, digestOf(new Uint8Array(readFileSync(artefacts.files[name]))).sha256]),
  ) as Record<DriverFile, string>;
}

const SHA256 = /^[0-9a-f]{64}$/;

function count(json: Json, path: string, name: string): number {
  const value = field(json, path, name);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new UserError(`${name}: \`${path}\` must be a non-negative integer.`);
  }
  return value;
}

/** `artefacts[<file>]`: the file names hold dots, which `field`'s paths separate. */
function artefactDigest(json: Json, file: DriverFile, name: string): string {
  const artefacts = field(json, "artefacts", name);
  const value = typeof artefacts === "object" && artefacts !== null ? (artefacts as Json)[file] : undefined;
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new UserError(`${name}: \`artefacts["${file}"]\` must be a sha256.`);
  }
  return value;
}

/** Reads `identity/prepopulated.json`, or `undefined` when there is none. */
export function readPrepopulatedRecord(layout: Layout): PrepopulatedRecord | undefined {
  if (!existsSync(layout.prepopulatedRecord)) return undefined;
  const { name, kind, json } = readIdentityRecord(layout, layout.prepopulatedRecord);
  if (kind !== IDENTITY_KINDS.prepopulated)
    throw new UserError(`${name}: \`kind\` must be "${IDENTITY_KINDS.prepopulated}".`);
  return {
    sourceDateEpoch: count(json, "sourceDateEpoch", name),
    artefacts: Object.fromEntries(DRIVER_FILES.map((file) => [file, artefactDigest(json, file, name)])) as Record<
      DriverFile,
      string
    >,
    entries: count(json, "entries", name),
    tar: { bytes: count(json, "tar.bytes", name), sha256: stringField(json, "tar.sha256", name, SHA256) },
    asset: { bytes: count(json, "asset.bytes", name), sha256: stringField(json, "asset.sha256", name, SHA256) },
  };
}

/** The record's JSON text. */
export function formatPrepopulatedRecord(record: PrepopulatedRecord): string {
  return `${JSON.stringify(
    {
      $comment:
        "The prepopulated data directory (ADR-0001 decision 10): `bun run prepopulated` on the artefacts with these sha256s, at this SOURCE_DATE_EPOCH, must give exactly this archive (`tar`) and asset (`asset`, the archive gzipped by the pinned Bun's zlib). Checked by `bun run prepopulated --check`, never by validate or CI (it needs a build); rewritten by `bun run prepopulated --record` when the build changes.",
      kind: IDENTITY_KINDS.prepopulated,
      ...record,
    },
    null,
    2,
  )}\n`;
}

function formatValue(value: ControlValue | undefined): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value);
}

function differingBytes(a: Uint8Array, b: Uint8Array): number {
  let differing = Math.abs(a.length - b.length);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) differing += 1;
  return differing;
}

/**
 * How two data directories differ, as report lines: entries only one side has, then each differing file,
 * explained field by field for pg_control and postmaster.pid, and record by record for a WAL segment.
 */
export function compareDataDirs(ours: readonly DataDirEntry[], theirs: readonly DataDirEntry[]): string[] {
  const lines: string[] = [];
  const theirsByPath = new Map(theirs.map((entry) => [entry.path, entry]));
  const oursByPath = new Map(ours.map((entry) => [entry.path, entry]));
  for (const entry of ours) if (!theirsByPath.has(entry.path)) lines.push(`only in ours: ${entry.path}`);
  for (const entry of theirs) if (!oursByPath.has(entry.path)) lines.push(`only in theirs: ${entry.path}`);
  let identical = 0;
  for (const entry of ours) {
    const other = theirsByPath.get(entry.path);
    if (other === undefined) continue;
    if (other.type !== entry.type) {
      lines.push(`${entry.path}: a ${entry.type} in ours, a ${other.type} in theirs`);
      continue;
    }
    if (Buffer.compare(entry.data, other.data) === 0) {
      identical += 1;
      continue;
    }
    lines.push(`${entry.path}: ${differingBytes(entry.data, other.data)} of ${entry.data.length} bytes differ`);
    if (entry.path === "/global/pg_control") {
      lines.push(...compareControlFiles(entry.data, other.data));
    } else if (entry.path === "/postmaster.pid") {
      const a = new TextDecoder().decode(entry.data).split("\n");
      const b = new TextDecoder().decode(other.data).split("\n");
      a.forEach((line, index) => {
        if (line !== b[index])
          lines.push(`    line ${index + 1}: ${JSON.stringify(line)} (theirs ${JSON.stringify(b[index])})`);
      });
    } else if (/^\/pg_wal\/[0-9A-F]{24}$/.test(entry.path)) {
      lines.push(...compareWal(entry.data, other.data, ours));
    }
  }
  lines.push(`${identical} of ${ours.length} entries are byte-identical.`);
  return lines;
}

function compareControlFiles(ours: Uint8Array, theirs: Uint8Array): string[] {
  let a: ControlFile;
  let b: ControlFile;
  try {
    a = parseControlFile(ours);
    b = parseControlFile(theirs);
  } catch (error) {
    if (error instanceof ControlFileError) return [`    not compared field by field: ${error.message}`];
    throw error;
  }
  const lines: string[] = [];
  for (const [key, value] of a.fields) {
    if (formatValue(value) !== formatValue(b.fields.get(key))) {
      lines.push(`    ${key}: ${formatValue(value)} (theirs ${formatValue(b.fields.get(key))})`);
    }
  }
  return lines;
}

function compareWal(a: Uint8Array, b: Uint8Array, ours: readonly DataDirEntry[]): string[] {
  const control = parseControlFile(ours.find((entry) => entry.path === "/global/pg_control")?.data ?? new Uint8Array());
  const blockSize = Number(control.fields.get("xlog_blcksz"));
  const maxAlign = Number(control.fields.get("maxAlign"));
  const lines: string[] = [];
  const headerBytes = differingBytes(a.subarray(0, 40), b.subarray(0, 40));
  if (headerBytes > 0) lines.push(`    first page header: ${headerBytes} bytes (xlp_sysid is bytes 24-31)`);
  const ourWal = walRecords(a, blockSize, maxAlign);
  const theirWal = walRecords(b, blockSize, maxAlign);
  const byKind = new Map<string, { records: number; differing: number }>();
  for (const record of ourWal.records) {
    const kind = `${RESOURCE_MANAGERS[record.rmid] ?? `rmgr ${record.rmid}`}/0x${record.info.toString(16).padStart(2, "0")}`;
    const tally = byKind.get(kind) ?? { records: 0, differing: 0 };
    tally.records += 1;
    const end = record.start + record.length;
    if (Buffer.compare(ourWal.stream.subarray(record.start, end), theirWal.stream.subarray(record.start, end)) !== 0) {
      tally.differing += 1;
    }
    byKind.set(kind, tally);
  }
  const differing = [...byKind.values()].reduce((total, tally) => total + tally.differing, 0);
  lines.push(`    ${differing} of ${ourWal.records.length} WAL records differ (same positions and lengths):`);
  for (const [kind, tally] of byKind) {
    if (tally.differing > 0) lines.push(`      ${kind}: ${tally.differing} of ${tally.records}`);
  }
  const last = ourWal.records.at(-1);
  const end = last === undefined ? 0 : last.start + last.length;
  const tail = differingBytes(ourWal.stream.subarray(end), theirWal.stream.subarray(end));
  if (tail > 0) lines.push(`    ${tail} bytes differ after the last record`);
  return lines;
}
