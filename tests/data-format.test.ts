import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  declarationProblems,
  readDataFormat,
  tupleDifferences,
  tupleOfDirectory,
  tupleOfEntries,
  type DataFormatDeclaration,
} from "../scripts/lib/data-format.ts";
import type { DataDirEntry } from "../scripts/lib/driver/postgres.ts";
import { layoutFor, repoRoot } from "../scripts/lib/layout.ts";
import {
  compatibilityTuple,
  crc32c,
  parseControlFile,
  parseWalLongPageHeader,
  walRecords,
} from "../scripts/lib/pg-control.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

/** pg_control and the first WAL page of the prepopulated data directory `bun run prepopulated` made. */
const fixtureDir = join(import.meta.dir, "fixtures", "data-format");
const pgControl = () => new Uint8Array(readFileSync(join(fixtureDir, "pg_control")));
const walPage = () => new Uint8Array(readFileSync(join(fixtureDir, "wal-first-page")));

describe("pg_control", () => {
  test("CRC-32C is Castagnoli's", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });

  test("parses the wasm32 layout of PG_CONTROL_VERSION 1800", () => {
    const control = parseControlFile(pgControl());
    expect(control.crcOffset).toBe(292);
    expect(control.size).toBe(296);
    const fields = Object.fromEntries(control.fields);
    expect(fields).toMatchObject({
      pg_control_version: 1800,
      catalog_version_no: 202506291,
      state: 6, // DB_IN_PRODUCTION: the asset is of a running backend
      "checkPointCopy.ThisTimeLineID": 1,
      "checkPointCopy.fullPageWrites": true,
      MaxConnections: 100,
      max_worker_processes: 0, // PGlite's start parameters, recorded by the start's XLOG_PARAMETER_CHANGE
      maxAlign: 8,
      floatFormat: 1234567,
      blcksz: 8192,
      relseg_size: 131072,
      xlog_blcksz: 8192,
      xlog_seg_size: 16 * 1024 * 1024,
      nameDataLen: 64,
      indexMaxKeys: 32,
      toast_max_chunk_size: 1996,
      loblksize: 2048,
      float8ByVal: false,
      data_checksum_version: 1,
      default_char_signedness: true,
    });
    // BootStrapXLOG: tv_sec << 32 | tv_usec << 12 | getpid() & 0xFFF, and Emscripten's getpid() is 42.
    const systemIdentifier = control.fields.get("system_identifier") as bigint;
    expect(systemIdentifier & 0xfffn).toBe(42n);
    expect(systemIdentifier >> 32n).toBe(control.fields.get("checkPointCopy.time") as bigint);
  });

  test("refuses a corrupt file, an unknown version and a short file", () => {
    const corrupt = pgControl();
    corrupt[100] = (corrupt[100] ?? 0) ^ 0x01;
    expect(thrown(() => parseControlFile(corrupt)).message).toContain("CRC-32C does not match");
    const foreign = pgControl();
    new DataView(foreign.buffer).setUint32(8, 1700, true);
    expect(thrown(() => parseControlFile(foreign)).message).toContain("PG_CONTROL_VERSION 1700, which has no layout");
    expect(thrown(() => parseControlFile(pgControl().subarray(0, 200))).message).toContain("too short");
  });
});

describe("the WAL page header", () => {
  test("reads the long header of a segment's first page", () => {
    const header = parseWalLongPageHeader(walPage());
    expect(header).toMatchObject({
      magic: 0xd118,
      timeline: 1,
      pageAddress: 0x1000000n,
      segmentSize: 16777216,
      blockSize: 8192,
    });
    expect(header.systemIdentifier).toBe(parseControlFile(pgControl()).fields.get("system_identifier") as bigint);
  });

  test("refuses a page without a long header", () => {
    const page = walPage();
    new DataView(page.buffer).setUint16(2, 0, true);
    expect(thrown(() => parseWalLongPageHeader(page)).message).toContain("no long header");
    expect(thrown(() => parseWalLongPageHeader(page.subarray(0, 39))).message).toContain("too short");
  });

  test("finds the records of a page, up to the first that runs past it", () => {
    const { stream, records } = walRecords(walPage(), 8192, 8);
    expect(stream.length).toBe(8192 - 40);
    // initdb's first record, the bootstrap shutdown checkpoint (XLOG, info 0x00), then a record of 8241
    // bytes that continues on the next page.
    expect(records).toEqual([{ start: 0, length: 114, rmid: 0, info: 0 }]);
    expect(new DataView(stream.buffer).getUint32(120, true)).toBe(8241);
  });
});

describe("the compatibility tuple", () => {
  const tuple = () => compatibilityTuple(parseControlFile(pgControl()), parseWalLongPageHeader(walPage()));

  test("is the committed declaration's", () => {
    const declaration = readDataFormat(layoutFor(repoRoot));
    expect(declarationProblems(declaration)).toEqual([]);
    expect(tupleDifferences(declaration.tuple, tuple())).toEqual([]);
    expect(tuple().xlp_magic).toBe("0xD118");
  });

  test("refuses a WAL segment of another system", () => {
    const page = walPage();
    new DataView(page.buffer).setBigUint64(24, 1n, true);
    expect(
      thrown(() => compatibilityTuple(parseControlFile(pgControl()), parseWalLongPageHeader(page))).message,
    ).toContain("belongs to system 1");
  });

  test("is read from entries and from a directory on disk", () => {
    const entries: DataDirEntry[] = [
      { path: "/global/pg_control", type: "file", mode: 0o640, data: pgControl() },
      { path: "/pg_wal/000000010000000000000002", type: "file", mode: 0o640, data: new Uint8Array(40) },
      { path: "/pg_wal/000000010000000000000001", type: "file", mode: 0o640, data: walPage() },
    ];
    expect(tupleOfEntries(entries)).toEqual(tuple());
    expect(thrown(() => tupleOfEntries(entries.slice(1))).message).toContain("no global/pg_control");
    const dir = fixtures.dir("data-dir");
    write(join(dir, "global", "pg_control"), pgControl());
    write(join(dir, "pg_wal", "000000010000000000000001"), walPage());
    write(join(dir, "pg_wal", "archive_status", ".keep"), "");
    expect(tupleOfDirectory(dir)).toEqual(tuple());
  });

  test("reports each changed field", () => {
    const changed = { ...tuple(), blcksz: 16384, float8ByVal: true };
    expect(tupleDifferences(tuple(), changed)).toEqual([
      { key: "blcksz", declared: "8192", actual: "16384" },
      { key: "float8ByVal", declared: "false", actual: "true" },
    ]);
  });
});

describe("the declaration's rules", () => {
  const base = readDataFormat(layoutFor(repoRoot));
  const declaration = (overrides: Partial<DataFormatDeclaration>): DataFormatDeclaration => ({ ...base, ...overrides });

  test("formats are numbered 1, 2, … in order", () => {
    const problems = declarationProblems(declaration({ dataFormat: 2 }));
    expect(problems).toEqual([
      "dataFormat 2 is declared as the current format, where 1 belongs: formats are numbered 1, 2, … in order.",
    ]);
  });

  test("a new dataFormat needs a new tuple", () => {
    const problems = declarationProblems(
      declaration({ dataFormat: 2, previous: [{ dataFormat: 1, tuple: base.tuple }] }),
    );
    expect(problems).toEqual(["dataFormat 2 has the same tuple as dataFormat 1: a new dataFormat needs a new tuple."]);
    const next = { ...base.tuple, float8ByVal: true };
    expect(
      declarationProblems(
        declaration({ dataFormat: 2, tuple: next, previous: [{ dataFormat: 1, tuple: base.tuple }] }),
      ),
    ).toEqual([]);
  });

  test("a malformed declaration is refused", () => {
    const root = fixtures.dir("data-format");
    const layout = layoutFor(root);
    const valid = JSON.parse(readFileSync(join(repoRoot, "data-format.json"), "utf8")) as Record<string, unknown>;
    write(layout.dataFormatFile, JSON.stringify({ ...valid, tuple: { ...(valid["tuple"] as object), extra: 1 } }));
    expect(thrown(() => readDataFormat(layout)).message).toContain("must have exactly the keys");
    write(
      layout.dataFormatFile,
      JSON.stringify({ ...valid, tuple: { ...(valid["tuple"] as object), xlp_magic: "D118" } }),
    );
    expect(thrown(() => readDataFormat(layout)).message).toContain("xlp_magic");
    write(layout.dataFormatFile, JSON.stringify({ ...valid, dataFormat: 0 }));
    expect(thrown(() => readDataFormat(layout)).message).toContain("positive integer");
    write(layout.dataFormatFile, JSON.stringify({ ...valid, previous: {} }));
    expect(thrown(() => readDataFormat(layout)).message).toContain("`previous` must be an array");
  });
});
