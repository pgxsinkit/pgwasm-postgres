/**
 * A reader for the tar archives the build writes (`tar -czf`, GNU tar 1.34 in the builder image): enough of
 * ustar, GNU (`L`/`K` long names) and pax (`x` headers) to list every member with its path, type, mode,
 * owner and bytes. `build:verify` compares archives by these members, never by their archive bytes, which
 * carry the moment of `make install` (member mtimes) and the filesystem's directory order.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

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
