/**
 * `global/pg_control` and the WAL's long page header, parsed in TypeScript for the 32-bit wasm build
 * (wasm32: little-endian, 8-byte `int64`/`uint64`/`double` alignment), so a data directory's on-disk
 * format can be checked without running Postgres. The build's `bin/pg_controldata.js` is no help: it
 * loads a `pg_controldata.wasm` the build does not install.
 *
 * The layout is per `PG_CONTROL_VERSION`, transcribed from `src/include/catalog/pg_control.h`, and the
 * CRC-32C Postgres stores after the struct is verified, so a layout that does not match the file fails
 * rather than returning wrong values.
 */

/** The C types of pg_control.h, with their wasm32 size and alignment. */
type Scalar = "u32" | "i32" | "u64" | "i64" | "f64" | "bool" | "nonce";
type FieldType = Scalar | readonly Field[];
type Field = readonly [name: string, type: FieldType];

const SCALARS: Readonly<Record<Scalar, { size: number; align: number }>> = {
  u32: { size: 4, align: 4 },
  i32: { size: 4, align: 4 },
  u64: { size: 8, align: 8 },
  i64: { size: 8, align: 8 },
  f64: { size: 8, align: 8 },
  bool: { size: 1, align: 1 },
  nonce: { size: 32, align: 1 }, // char mock_authentication_nonce[MOCK_AUTH_NONCE_LEN]
};

/** `CheckPoint` at PG_CONTROL_VERSION 1800 (REL_18_3 pg_control.h lines 35-65). */
const CHECKPOINT_1800: readonly Field[] = [
  ["redo", "u64"],
  ["ThisTimeLineID", "u32"],
  ["PrevTimeLineID", "u32"],
  ["fullPageWrites", "bool"],
  ["wal_level", "i32"],
  ["nextXid", "u64"], // FullTransactionId
  ["nextOid", "u32"],
  ["nextMulti", "u32"],
  ["nextMultiOffset", "u32"], // MultiXactOffset is 32-bit in 18
  ["oldestXid", "u32"],
  ["oldestXidDB", "u32"],
  ["oldestMulti", "u32"],
  ["oldestMultiDB", "u32"],
  ["time", "i64"], // pg_time_t
  ["oldestCommitTsXid", "u32"],
  ["newestCommitTsXid", "u32"],
  ["oldestActiveXid", "u32"],
];

/** `ControlFileData` at PG_CONTROL_VERSION 1800 (REL_18_3 pg_control.h lines 104-239). */
const CONTROL_FILE_1800: readonly Field[] = [
  ["system_identifier", "u64"],
  ["pg_control_version", "u32"],
  ["catalog_version_no", "u32"],
  ["state", "i32"], // DBState
  ["time", "i64"],
  ["checkPoint", "u64"],
  ["checkPointCopy", CHECKPOINT_1800],
  ["unloggedLSN", "u64"],
  ["minRecoveryPoint", "u64"],
  ["minRecoveryPointTLI", "u32"],
  ["backupStartPoint", "u64"],
  ["backupEndPoint", "u64"],
  ["backupEndRequired", "bool"],
  ["wal_level", "i32"],
  ["wal_log_hints", "bool"],
  ["MaxConnections", "i32"],
  ["max_worker_processes", "i32"],
  ["max_wal_senders", "i32"],
  ["max_prepared_xacts", "i32"],
  ["max_locks_per_xact", "i32"],
  ["track_commit_timestamp", "bool"],
  ["maxAlign", "u32"],
  ["floatFormat", "f64"],
  ["blcksz", "u32"],
  ["relseg_size", "u32"],
  ["xlog_blcksz", "u32"],
  ["xlog_seg_size", "u32"],
  ["nameDataLen", "u32"],
  ["indexMaxKeys", "u32"],
  ["toast_max_chunk_size", "u32"],
  ["loblksize", "u32"],
  ["float8ByVal", "bool"],
  ["data_checksum_version", "u32"],
  ["default_char_signedness", "bool"],
  ["mock_authentication_nonce", "nonce"],
  ["crc", "u32"], // pg_crc32c, over every byte before it
];

/** The layouts this parser knows, by `pg_control_version`. A new major adds its own. */
const LAYOUTS: ReadonlyMap<number, readonly Field[]> = new Map([[1800, CONTROL_FILE_1800]]);

/** `pg_control_version` sits right after the 8-byte system identifier in every layout since 8.x. */
const VERSION_OFFSET = 8;

export type ControlValue = number | bigint | boolean | Uint8Array;

/** A parsed pg_control: every field by name (`checkPointCopy.redo` for nested ones) and its offset. */
export interface ControlFile {
  readonly fields: ReadonlyMap<string, ControlValue>;
  readonly offsets: ReadonlyMap<string, number>;
  /** `offsetof(ControlFileData, crc)`: the number of bytes the CRC covers. */
  readonly crcOffset: number;
  /** `sizeof(ControlFileData)`. */
  readonly size: number;
}

function alignUp(offset: number, align: number): number {
  return Math.ceil(offset / align) * align;
}

function alignmentOf(type: FieldType): number {
  return typeof type === "string" ? SCALARS[type].align : Math.max(...type.map(([, inner]) => alignmentOf(inner)));
}

/**
 * Reads a struct at `base` into `values`, recording each field's offset in `offsets`; returns its size
 * (rounded up to its alignment, as C's `sizeof`).
 */
function readStruct(
  view: DataView,
  base: number,
  fields: readonly Field[],
  prefix: string,
  values: Map<string, ControlValue>,
  offsets: Map<string, number>,
): number {
  let offset = 0;
  for (const [name, type] of fields) {
    offset = alignUp(offset, alignmentOf(type));
    const at = base + offset;
    const key = `${prefix}${name}`;
    offsets.set(key, at);
    if (typeof type !== "string") {
      offset += readStruct(view, at, type, `${key}.`, values, offsets);
      continue;
    }
    if (at + SCALARS[type].size > view.byteLength)
      throw new ControlFileError(`pg_control is ${view.byteLength} bytes: too short`);
    switch (type) {
      case "u32":
        values.set(key, view.getUint32(at, true));
        break;
      case "i32":
        values.set(key, view.getInt32(at, true));
        break;
      case "u64":
        values.set(key, view.getBigUint64(at, true));
        break;
      case "i64":
        values.set(key, view.getBigInt64(at, true));
        break;
      case "f64":
        values.set(key, view.getFloat64(at, true));
        break;
      case "bool":
        values.set(key, view.getUint8(at) !== 0);
        break;
      case "nonce":
        values.set(key, new Uint8Array(view.buffer, view.byteOffset + at, SCALARS.nonce.size).slice());
        break;
    }
    offset += SCALARS[type].size;
  }
  return alignUp(offset, alignmentOf(fields));
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32C (Castagnoli), as Postgres' `COMP_CRC32C` computes it. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC32C_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export class ControlFileError extends Error {
  override name = "ControlFileError";
}

/** Parses pg_control; throws unless its version has a known layout and its CRC-32C matches. */
export function parseControlFile(bytes: Uint8Array): ControlFile {
  if (bytes.length < VERSION_OFFSET + 4) throw new ControlFileError(`pg_control is ${bytes.length} bytes: too short`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(VERSION_OFFSET, true);
  const layout = LAYOUTS.get(version);
  if (layout === undefined) {
    throw new ControlFileError(
      `pg_control has PG_CONTROL_VERSION ${version}, which has no layout here (known: ${[...LAYOUTS.keys()].join(", ")}): add it from src/include/catalog/pg_control.h`,
    );
  }
  const fields = new Map<string, ControlValue>();
  const offsets = new Map<string, number>();
  const size = readStruct(view, 0, layout, "", fields, offsets);
  const crcOffset = offsets.get("crc") ?? 0;
  const crc = view.getUint32(crcOffset, true);
  const computed = crc32c(bytes.subarray(0, crcOffset));
  if (crc !== computed) {
    throw new ControlFileError(
      `pg_control's CRC-32C does not match (stored 0x${crc.toString(16).padStart(8, "0")}, computed 0x${computed.toString(16).padStart(8, "0")} over ${crcOffset} bytes): the file is corrupt or the layout for PG_CONTROL_VERSION ${version} is wrong`,
    );
  }
  return { fields, offsets, crcOffset, size };
}

/** The first page header of a WAL segment: `XLogLongPageHeaderData` (xlog_internal.h). */
export interface WalLongPageHeader {
  readonly magic: number;
  readonly info: number;
  readonly timeline: number;
  readonly pageAddress: bigint;
  readonly systemIdentifier: bigint;
  readonly segmentSize: number;
  readonly blockSize: number;
}

/** `XLP_LONG_HEADER`: the page's header is the long form, as on a segment's first page. */
const XLP_LONG_HEADER = 0x0002;

export function parseWalLongPageHeader(bytes: Uint8Array): WalLongPageHeader {
  if (bytes.length < 40)
    throw new ControlFileError(`The WAL segment is ${bytes.length} bytes: too short for a page header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = view.getUint16(2, true);
  if ((info & XLP_LONG_HEADER) === 0) throw new ControlFileError("The WAL segment's first page has no long header");
  return {
    magic: view.getUint16(0, true),
    info,
    timeline: view.getUint32(4, true),
    pageAddress: view.getBigUint64(8, true),
    // xlp_rem_len (uint32) at 16, then 4 bytes of padding before the uint64.
    systemIdentifier: view.getBigUint64(24, true),
    segmentSize: view.getUint32(32, true),
    blockSize: view.getUint32(36, true),
  };
}

/**
 * The compatibility tuple (ADR-0001 decision 8): what a server compares against its compile-time values
 * before it will use a data directory. `ReadControlFile()` (REL_18_3 xlog.c lines 4388-4535) refuses a
 * pg_control whose version, catalog version or any of the build-time sizes differ; WAL is refused when a
 * page's magic is not `XLOG_PAGE_MAGIC` (`XLogReaderValidatePageHeader()`, xlogreader.c line 1247). Keys are
 * the C field names.
 */
export interface CompatibilityTuple {
  readonly pg_control_version: number;
  readonly catalog_version_no: number;
  readonly maxAlign: number;
  readonly floatFormat: number;
  readonly blcksz: number;
  readonly relseg_size: number;
  readonly xlog_blcksz: number;
  readonly nameDataLen: number;
  readonly indexMaxKeys: number;
  readonly toast_max_chunk_size: number;
  readonly loblksize: number;
  readonly float8ByVal: boolean;
  /** `XLOG_PAGE_MAGIC`, from the WAL's first page header, as `0x` and four upper-case hex digits. */
  readonly xlp_magic: string;
}

export const TUPLE_KEYS = [
  "pg_control_version",
  "catalog_version_no",
  "maxAlign",
  "floatFormat",
  "blcksz",
  "relseg_size",
  "xlog_blcksz",
  "nameDataLen",
  "indexMaxKeys",
  "toast_max_chunk_size",
  "loblksize",
  "float8ByVal",
  "xlp_magic",
] as const satisfies readonly (keyof CompatibilityTuple)[];

function numberField(control: ControlFile, name: string): number {
  const value = control.fields.get(name);
  if (typeof value !== "number") throw new ControlFileError(`pg_control has no numeric field ${name}`);
  return value;
}

export function formatMagic(magic: number): string {
  return `0x${magic.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The tuple of a data directory, from its pg_control and the first page of a WAL segment. */
export function compatibilityTuple(control: ControlFile, wal: WalLongPageHeader): CompatibilityTuple {
  const systemIdentifier = control.fields.get("system_identifier");
  if (wal.systemIdentifier !== systemIdentifier) {
    throw new ControlFileError(
      `The WAL segment belongs to system ${wal.systemIdentifier}, pg_control to ${String(systemIdentifier)}`,
    );
  }
  const float8ByVal = control.fields.get("float8ByVal");
  if (typeof float8ByVal !== "boolean") throw new ControlFileError("pg_control has no float8ByVal");
  return {
    pg_control_version: numberField(control, "pg_control_version"),
    catalog_version_no: numberField(control, "catalog_version_no"),
    maxAlign: numberField(control, "maxAlign"),
    floatFormat: numberField(control, "floatFormat"),
    blcksz: numberField(control, "blcksz"),
    relseg_size: numberField(control, "relseg_size"),
    xlog_blcksz: numberField(control, "xlog_blcksz"),
    nameDataLen: numberField(control, "nameDataLen"),
    indexMaxKeys: numberField(control, "indexMaxKeys"),
    toast_max_chunk_size: numberField(control, "toast_max_chunk_size"),
    loblksize: numberField(control, "loblksize"),
    float8ByVal,
    xlp_magic: formatMagic(wal.magic),
  };
}

/** A WAL record's place in a segment, with the fields of its header that say what it is. */
export interface WalRecord {
  /** The record's start in the segment's page-header-free byte stream. */
  readonly start: number;
  readonly length: number;
  readonly rmid: number;
  readonly info: number;
}

/** Resource manager names by id (src/include/access/rmgrlist.h), as pg_waldump prints them. */
export const RESOURCE_MANAGERS: readonly string[] = [
  "XLOG",
  "Transaction",
  "Storage",
  "CLOG",
  "Database",
  "Tablespace",
  "MultiXact",
  "RelMap",
  "Standby",
  "Heap2",
  "Heap",
  "Btree",
  "Hash",
  "Gin",
  "Gist",
  "Sequence",
  "SPGist",
  "BRIN",
  "CommitTs",
  "ReplicationOrigin",
  "Generic",
  "LogicalMessage",
];

/**
 * A WAL segment without its page headers (`SizeOfXLogLongPHD` on the first page, `SizeOfXLogShortPHD`
 * on the others, both MAXALIGNed), and the records in it, from the segment's start to the first empty
 * record header or the first record that runs past the bytes given. A record continued from an earlier
 * segment is not handled: this reads a cluster's first segment.
 */
export function walRecords(
  segment: Uint8Array,
  blockSize: number,
  maxAlign: number,
): { stream: Uint8Array; records: WalRecord[] } {
  const align = (value: number) => Math.ceil(value / maxAlign) * maxAlign;
  const longHeader = align(36);
  const shortHeader = align(20);
  const pages = Math.floor(segment.length / blockSize);
  const stream = new Uint8Array(segment.length - longHeader - (pages - 1) * shortHeader);
  let length = 0;
  for (let page = 0; page < pages; page += 1) {
    const body = segment.subarray(page * blockSize + (page === 0 ? longHeader : shortHeader), (page + 1) * blockSize);
    stream.set(body, length);
    length += body.length;
  }
  const view = new DataView(stream.buffer);
  const records: WalRecord[] = [];
  for (let start = 0; start + 24 <= stream.length;) {
    const total = view.getUint32(start, true);
    if (total === 0 || start + total > stream.length) break;
    if (total < 24) throw new ControlFileError(`Invalid WAL record length ${total} at ${start}`);
    records.push({ start, length: total, rmid: stream[start + 17] ?? 0, info: stream[start + 16] ?? 0 });
    start = align(start + total);
  }
  return { stream, records };
}
