/**
 * Tar archives. The reader handles those the build writes (`tar -czf`, GNU tar 1.34 in the builder image):
 * enough of ustar, GNU (`L`/`K` long names) and pax (`x` headers) to list every member with its path, type,
 * mode, owner and bytes (the driver installs extension archives with it, and unpacks data directory archives).
 *
 * The writer makes deterministic archives (ADR-0001 decisions 9 and 10): plain ustar, members in the order
 * given, and every header field fixed by the caller's entries, so equal entries give equal bytes.
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export type TarMemberType = "file" | "hardlink" | "symlink" | "directory" | "other";

export interface TarMember {
  readonly path: string;
  readonly type: TarMemberType;
  /** Permission bits, as recorded (`0o755`). */
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly uname: string;
  readonly gname: string;
  /** Size of the member's data (0 for anything but a regular file). */
  readonly size: number;
  /** Target of a symlink or hardlink, "" otherwise. */
  readonly linkname: string;
  /** sha256 of the member's data (of the empty string for anything but a regular file). */
  readonly sha256: string;
  /** Modification time, in seconds since the Unix epoch. */
  readonly mtime: number;
  /** The member's data: a view into the archive (empty for anything but a regular file). */
  readonly data: Uint8Array;
}

const BLOCK = 512;

function text(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

/** An octal numeric field (NUL- or space-terminated), or GNU's base-256 form for large values. */
function numeric(block: Uint8Array, start: number, length: number, name: string): number {
  const field = block.subarray(start, start + length);
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let value = (field[0] ?? 0) & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const digits = text(block, start, length).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new Error(`tar: header field ${name} is not octal: ${JSON.stringify(digits)}`);
  return Number.parseInt(digits, 8);
}

function checksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return sum === numeric(block, 148, 8, "chksum");
}

/** pax extended header records: `<length> <key>=<value>\n`. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const decoded = new TextDecoder().decode(data);
  let offset = 0;
  while (offset < decoded.length) {
    const space = decoded.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(decoded.slice(offset, space), 10);
    if (!Number.isInteger(length) || length <= 0) throw new Error("tar: malformed pax header record");
    const record = decoded.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals !== -1) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

function memberType(flag: string): TarMemberType {
  switch (flag) {
    case "0":
    case "\0":
    case "7":
      return "file";
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "5":
      return "directory";
    default:
      return "other";
  }
}

/** The members of a tar archive, in archive order. Gzipped input (`.tar.gz`) is recognised and inflated. */
export function readTar(input: Uint8Array): TarMember[] {
  const archive = input[0] === 0x1f && input[1] === 0x8b ? new Uint8Array(gunzipSync(input)) : input;
  const members: TarMember[] = [];
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax = new Map<string, string>();
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    if (!checksumOk(header)) throw new Error(`tar: bad header checksum at offset ${offset}`);
    const flag = String.fromCharCode(header[156] ?? 0);
    const describesNext = flag === "L" || flag === "K" || flag === "x" || flag === "g";
    const paxSize = describesNext ? undefined : pax.get("size");
    const size = paxSize === undefined ? numeric(header, 124, 12, "size") : Number(paxSize);
    const dataStart = offset + BLOCK;
    const data = archive.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error(`tar: member at offset ${offset} is truncated`);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // Headers that describe the next member rather than being one.
    if (flag === "L" || flag === "K") {
      const value = text(data, 0, data.length);
      if (flag === "L") longName = value;
      else longLink = value;
      continue;
    }
    if (flag === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (flag === "g") continue;

    const magic = text(header, 257, 6);
    // POSIX ustar splits long paths into prefix + name; GNU's format uses that area for other fields.
    const prefix = magic === "ustar" ? text(header, 345, 155) : "";
    const name = text(header, 0, 100);
    const type = memberType(flag);
    members.push({
      path: pax.get("path") ?? longName ?? (prefix === "" ? name : `${prefix}/${name}`),
      type,
      mode: numeric(header, 100, 8, "mode") & 0o7777,
      uid: pax.has("uid") ? Number(pax.get("uid")) : numeric(header, 108, 8, "uid"),
      gid: pax.has("gid") ? Number(pax.get("gid")) : numeric(header, 116, 8, "gid"),
      uname: pax.get("uname") ?? text(header, 265, 32),
      gname: pax.get("gname") ?? text(header, 297, 32),
      size: type === "file" ? size : 0,
      linkname: pax.get("linkpath") ?? longLink ?? text(header, 157, 100),
      sha256: createHash("sha256")
        .update(type === "file" ? data : new Uint8Array())
        .digest("hex"),
      mtime: pax.has("mtime") ? Math.floor(Number(pax.get("mtime"))) : numeric(header, 136, 12, "mtime"),
      data: type === "file" ? data : new Uint8Array(0),
    });
    longName = undefined;
    longLink = undefined;
    pax = new Map();
  }
  return members;
}

/** `0o755` as `"0755"`: how modes are written in records and reports. */
export function formatMode(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

/** A member for {@link writeTar}. */
export interface TarEntry {
  /** The member's name, written as given (a leading `/` is kept; a directory has no trailing `/`). */
  readonly path: string;
  readonly type: "file" | "directory";
  /** Permission bits. */
  readonly mode: number;
  /** Seconds since the Unix epoch. */
  readonly mtime: number;
  readonly data: Uint8Array;
}

const encoder = new TextEncoder();

function putText(header: Uint8Array, start: number, length: number, value: string, name: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`tar: ${name} ${JSON.stringify(value)} does not fit in ${length} bytes`);
  header.set(bytes, start);
}

/** A NUL-terminated octal field of `length` bytes. */
function putOctal(header: Uint8Array, start: number, length: number, value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`tar: ${name} ${value} is not a non-negative integer`);
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length > length - 1) throw new Error(`tar: ${name} ${value} does not fit in ${length} bytes`);
  putText(header, start, length, `${digits}\0`, name);
}

/** Splits a path into ustar's prefix (up to 155 bytes) and name (up to 100), at a `/`. */
function ustarName(path: string): { prefix: string; name: string } {
  if (encoder.encode(path).length <= 100) return { prefix: "", name: path };
  for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100 && name !== "")
      return { prefix, name };
  }
  throw new Error(`tar: ${path} is too long for a ustar header`);
}

function ustarHeader(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const { prefix, name } = ustarName(entry.path);
  const size = entry.type === "file" ? entry.data.length : 0;
  if (entry.type === "directory" && entry.data.length !== 0) throw new Error(`tar: directory ${entry.path} has data`);
  putText(block, 0, 100, name, "name");
  putOctal(block, 100, 8, entry.mode & 0o7777, "mode");
  putOctal(block, 108, 8, 0, "uid");
  putOctal(block, 116, 8, 0, "gid");
  putOctal(block, 124, 12, size, "size");
  putOctal(block, 136, 12, entry.mtime, "mtime");
  block[156] = entry.type === "file" ? 0x30 : 0x35; // '0' or '5'
  putText(block, 257, 6, "ustar\0", "magic");
  putText(block, 263, 2, "00", "version");
  putOctal(block, 329, 8, 0, "devmajor");
  putOctal(block, 337, 8, 0, "devminor");
  putText(block, 345, 155, prefix, "prefix");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  putText(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `, "chksum");
  return block;
}

/**
 * A ustar archive of `entries`, in the order given: owner 0/0 with no user or group names, no device
 * numbers, and two zero blocks at the end (no padding to a record size).
 */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const total = entries.reduce(
    (bytes, entry) => bytes + BLOCK + Math.ceil((entry.type === "file" ? entry.data.length : 0) / BLOCK) * BLOCK,
    2 * BLOCK,
  );
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    archive.set(ustarHeader(entry), offset);
    offset += BLOCK;
    if (entry.type === "file") {
      archive.set(entry.data, offset);
      offset += Math.ceil(entry.data.length / BLOCK) * BLOCK;
    }
  }
  return archive;
}

/** gzip's operating-system byte for Unix, which `gzip -n` writes on Linux. */
const GZIP_OS_UNIX = 3;

/**
 * gzip at level 9 with a header that names no file and records mtime 0 and the Unix OS byte whatever the
 * host, as `gzip -n9` does. The deflate stream is zlib's, so its bytes hold for one zlib: the pinned Bun's.
 */
export function gzipDeterministic(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(gzipSync(data, { level: 9 }));
  const flags = out[3] ?? 0;
  if (out[0] !== 0x1f || out[1] !== 0x8b || out[2] !== 8 || flags !== 0) {
    throw new Error("gzip: zlib wrote an unexpected header (magic, method or flags)");
  }
  out.fill(0, 4, 8); // MTIME
  out[9] = GZIP_OS_UNIX;
  return out;
}
