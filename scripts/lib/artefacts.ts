/**
 * Byte identity (ADR-0001 decision 2): the record of what the build must produce, and the check of a build's
 * `dist/` against it. Files are compared byte for byte (size and sha256). Extension archives are compared by
 * their members (path, type, mode, owner, bytes), never by their archive bytes: those carry each member's mtime
 * (the moment of `make install`) and the filesystem's directory order, which nobody can reproduce.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { field, IDENTITY_KINDS, readIdentityRecord, SHA, stringField, TREE_PATH, type Json } from "./config.ts";
import { UserError } from "./git.ts";
import type { Layout } from "./layout.ts";
import { formatMode, readTar, type TarMember, type TarMemberType } from "./tar.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const MODE = /^0[0-7]{3}$/;
const MEMBER_TYPES: readonly TarMemberType[] = ["file", "hardlink", "symlink", "directory", "other"];

/** The build inputs specific to byte identity; the record ties them to the bytes they give. */
export interface BuildRecipe {
  /** Where the source is mounted and the build runs (embedded in pglite.wasm and pglite.data). */
  readonly sourcePath: string;
  /** What `build-with-docker.sh` passes with `-e`, in order. */
  readonly environment: Readonly<Record<string, string>>;
}

export interface FileRecord {
  readonly name: string;
  /** Relative to `dist/`. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly published: string;
}

export interface MemberRecord {
  readonly path: string;
  readonly type: TarMemberType;
  readonly mode: string;
  readonly uid: number;
  readonly gid: number;
  readonly uname: string;
  readonly gname: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly linkname?: string;
}

export interface ArchiveRecord {
  readonly name: string;
  readonly path: string;
  /** The published archive: reported, never compared. */
  readonly published: { readonly bytes: number; readonly sha256: string; readonly from: string };
  /** Sorted by path. */
  readonly members: readonly MemberRecord[];
}

export interface ArtefactRecord {
  /** The record, relative to the repository root. */
  readonly file: string;
  /** The tree `patches:check` proves: the build must be of exactly this tree. */
  readonly tree: string;
  readonly build: BuildRecipe;
  readonly files: readonly FileRecord[];
  readonly archives: readonly ArchiveRecord[];
}

function objectAt(json: Json, path: string, name: string): Json {
  const value = field(json, path, name);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UserError(`${name}: \`${path}\` must be an object.`);
  }
  return value as Json;
}

function arrayAt(json: Json, path: string, name: string): Json[] {
  const value = field(json, path, name);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new UserError(`${name}: \`${path}\` must be an array of objects.`);
  }
  return value as Json[];
}

function countAt(json: Json, path: string, name: string): number {
  const value = field(json, path, name);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new UserError(`${name}: \`${path}\` must be a non-negative integer.`);
  }
  return value;
}

function readMember(json: Json, where: string): MemberRecord {
  const type = stringField(json, "type", where);
  if (!(MEMBER_TYPES as readonly string[]).includes(type)) {
    throw new UserError(`${where}: \`type\` is ${JSON.stringify(type)}; expected one of ${MEMBER_TYPES.join(", ")}.`);
  }
  const linkname = json["linkname"];
  if (linkname !== undefined && typeof linkname !== "string")
    throw new UserError(`${where}: \`linkname\` must be a string.`);
  return {
    path: stringField(json, "path", where),
    type: type as TarMemberType,
    mode: stringField(json, "mode", where, MODE),
    uid: countAt(json, "uid", where),
    gid: countAt(json, "gid", where),
    uname: stringField(json, "uname", where),
    gname: stringField(json, "gname", where),
    bytes: countAt(json, "bytes", where),
    sha256: stringField(json, "sha256", where, SHA256),
    ...(linkname === undefined || linkname === "" ? {} : { linkname }),
  };
}

/** Reads and checks the artefact record (`identity/0.5.8-artefacts.json`). */
export function readArtefactRecord(layout: Layout): ArtefactRecord {
  if (!existsSync(layout.artefactsRecord)) {
    throw new UserError(
      `${layout.artefactsRecord} is missing: there is no byte-identity record to build or verify against.`,
    );
  }
  const { name, kind, json } = readIdentityRecord(layout, layout.artefactsRecord);
  if (kind !== IDENTITY_KINDS.artefacts)
    throw new UserError(`${name}: \`kind\` must be "${IDENTITY_KINDS.artefacts}".`);

  const build = objectAt(json, "build", name);
  const environment = objectAt(build, "environment", `${name} build`);
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string") {
      throw new UserError(`${name}: \`build.environment\` must map variable names to strings (${key}).`);
    }
  }
  const sourcePath = stringField(build, "sourcePath", `${name} build`, /^\/[^:,]+$/);

  const files = arrayAt(json, "files", name).map((entry, index): FileRecord => {
    const where = `${name} files[${index}]`;
    return {
      name: stringField(entry, "name", where),
      path: stringField(entry, "path", where, TREE_PATH),
      bytes: countAt(entry, "bytes", where),
      sha256: stringField(entry, "sha256", where, SHA256),
      published: stringField(entry, "published", where),
    };
  });
  const archives = arrayAt(json, "archives", name).map((entry, index): ArchiveRecord => {
    const where = `${name} archives[${index}]`;
    const published = objectAt(entry, "published", where);
    const members = arrayAt(entry, "members", where).map((member, memberIndex) =>
      readMember(member, `${where} members[${memberIndex}]`),
    );
    const paths = members.map((member) => member.path);
    if (paths.join("\n") !== [...new Set(paths)].sort().join("\n")) {
      throw new UserError(`${where}: \`members\` must be sorted by path, without duplicates.`);
    }
    return {
      name: stringField(entry, "name", where),
      path: stringField(entry, "path", where, TREE_PATH),
      published: {
        bytes: countAt(published, "bytes", `${where} published`),
        sha256: stringField(published, "sha256", `${where} published`, SHA256),
        from: stringField(published, "from", `${where} published`),
      },
      members,
    };
  });

  return {
    file: name,
    tree: stringField(json, "source.tree", name, SHA),
    build: {
      sourcePath,
      environment: environment as Record<string, string>,
    },
    files,
    archives,
  };
}

/** A tar member as the record writes it. */
export function memberRecord(member: TarMember): MemberRecord {
  return {
    path: member.path,
    type: member.type,
    mode: formatMode(member.mode),
    uid: member.uid,
    gid: member.gid,
    uname: member.uname,
    gname: member.gname,
    bytes: member.size,
    sha256: member.sha256,
    ...(member.linkname === "" ? {} : { linkname: member.linkname }),
  };
}

/** An archive's members as the record writes them: sorted by path. */
export function archiveMembers(bytes: Uint8Array): MemberRecord[] {
  return readTar(bytes)
    .map(memberRecord)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type Status = "match" | "MISMATCH" | "MISSING" | "UNEXPECTED";

export interface Digest {
  readonly bytes: number;
  readonly sha256: string;
}

export interface FileResult {
  readonly record: FileRecord;
  readonly actual: Digest | undefined;
  readonly status: Status;
}

export interface MemberResult {
  readonly path: string;
  readonly expected: MemberRecord | undefined;
  readonly actual: MemberRecord | undefined;
  readonly status: Status;
  /** The fields that differ, for a mismatch. */
  readonly differences: readonly string[];
}

export interface ArchiveResult {
  readonly record: ArchiveRecord;
  readonly actual: Digest | undefined;
  readonly members: readonly MemberResult[];
  readonly status: Status;
}

export interface VerifyResult {
  readonly files: readonly FileResult[];
  readonly archives: readonly ArchiveResult[];
  readonly ok: boolean;
}

function digest(path: string): Digest | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const MEMBER_FIELDS = ["type", "mode", "uid", "gid", "uname", "gname", "bytes", "sha256", "linkname"] as const;

function compareMembers(expected: readonly MemberRecord[], actual: readonly MemberRecord[]): MemberResult[] {
  const actualByPath = new Map(actual.map((member) => [member.path, member]));
  const results: MemberResult[] = expected.map((want) => {
    const got = actualByPath.get(want.path);
    if (got === undefined)
      return { path: want.path, expected: want, actual: undefined, status: "MISSING", differences: [] };
    const differences = MEMBER_FIELDS.filter((key) => want[key] !== got[key]);
    return {
      path: want.path,
      expected: want,
      actual: got,
      status: differences.length === 0 ? "match" : "MISMATCH",
      differences,
    };
  });
  const expectedPaths = new Set(expected.map((member) => member.path));
  for (const got of actual) {
    if (!expectedPaths.has(got.path)) {
      results.push({ path: got.path, expected: undefined, actual: got, status: "UNEXPECTED", differences: [] });
    }
  }
  return results;
}

/** Checks a build's `dist/` against the record. */
export function verifyArtefacts(record: ArtefactRecord, distDir: string): VerifyResult {
  const files = record.files.map((file): FileResult => {
    const actual = digest(join(distDir, file.path));
    const status: Status =
      actual === undefined
        ? "MISSING"
        : actual.bytes === file.bytes && actual.sha256 === file.sha256
          ? "match"
          : "MISMATCH";
    return { record: file, actual, status };
  });
  const archives = record.archives.map((archive): ArchiveResult => {
    const path = join(distDir, archive.path);
    const actual = digest(path);
    if (actual === undefined) return { record: archive, actual, members: [], status: "MISSING" };
    const members = compareMembers(archive.members, archiveMembers(readFileSync(path)));
    return {
      record: archive,
      actual,
      members,
      status: members.every((m) => m.status === "match") ? "match" : "MISMATCH",
    };
  });
  const ok = files.every((file) => file.status === "match") && archives.every((archive) => archive.status === "match");
  return { files, archives, ok };
}

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  right: readonly number[] = [],
): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells
      .map((cell, column) =>
        right.includes(column) ? cell.padStart(widths[column] ?? 0) : cell.padEnd(widths[column] ?? 0),
      )
      .join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

const bytesText = (bytes: number): string => bytes.toLocaleString("en-US");

/** The report `build:verify` prints: a table per kind, with the expected values next to any mismatch. */
export function formatReport(result: VerifyResult): string[] {
  const fileRows = result.files.flatMap((file) => {
    const got = file.actual;
    const row = [
      file.record.name,
      got === undefined ? "-" : bytesText(got.bytes),
      got === undefined ? "-" : got.sha256,
      file.status,
    ];
    if (file.status !== "MISMATCH") return [row];
    return [row, [" expected", bytesText(file.record.bytes), file.record.sha256, ""]];
  });
  const lines = table(["file", "bytes", "sha256", "result"], fileRows, [1]);

  for (const archive of result.archives) {
    const got = archive.actual;
    lines.push(
      "",
      got === undefined
        ? `${archive.record.name}: MISSING (${archive.record.path})`
        : `${archive.record.name}: ${bytesText(got.bytes)} bytes, sha256 ${got.sha256}; the published archive is ${bytesText(archive.record.published.bytes)} bytes, ${archive.record.published.sha256} (${got.sha256 === archive.record.published.sha256 ? "identical" : "not compared: member mtimes and order are irreproducible"}).`,
    );
    if (got === undefined) continue;
    const memberRows = archive.members.flatMap((member) => {
      const shown = member.actual ?? member.expected;
      const row = [
        member.path,
        shown === undefined ? "-" : shown.mode,
        shown === undefined ? "-" : `${shown.uid}/${shown.gid} ${shown.uname}/${shown.gname}`,
        shown === undefined ? "-" : bytesText(shown.bytes),
        shown === undefined ? "-" : shown.sha256,
        member.status === "MISMATCH" ? `MISMATCH (${member.differences.join(", ")})` : member.status,
      ];
      const want = member.expected;
      if (member.status !== "MISMATCH" || want === undefined) return [row];
      return [
        row,
        [
          " expected",
          want.mode,
          `${want.uid}/${want.gid} ${want.uname}/${want.gname}`,
          bytesText(want.bytes),
          want.sha256,
          "",
        ],
      ];
    });
    lines.push(...table(["member", "mode", "owner", "bytes", "sha256", "result"], memberRows, [3]));
  }

  const matchingFiles = result.files.filter((file) => file.status === "match").length;
  const summary = [`${matchingFiles}/${result.files.length} files byte-identical`];
  for (const archive of result.archives) {
    const matching = archive.members.filter((member) => member.status === "match").length;
    summary.push(`${archive.record.name}: ${matching}/${archive.record.members.length} members identical`);
  }
  lines.push("", `${result.ok ? "Byte identity holds" : "Byte identity FAILED"}: ${summary.join("; ")}.`);
  return lines;
}
