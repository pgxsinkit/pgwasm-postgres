import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { IDENTITY_KINDS } from "../scripts/lib/config.ts";
import type { DataDirEntry } from "../scripts/lib/driver/postgres.ts";
import { layoutFor, repoRoot } from "../scripts/lib/layout.ts";
import { crc32c } from "../scripts/lib/pg-control.ts";
import {
  compareDataDirs,
  DIRECTORY_MODE,
  FILE_MODE,
  formatPrepopulatedRecord,
  packDataDir,
  readPrepopulatedRecord,
  unpackDataDir,
  type PrepopulatedRecord,
} from "../scripts/lib/prepopulated.ts";
import { gzipDeterministic, readTar, writeTar } from "../scripts/lib/tar.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

const bytes = (text: string) => new TextEncoder().encode(text);
const pgControl = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", "data-format", "pg_control")));

describe("tar writer", () => {
  const entries = [
    { path: "/base", type: "directory", mode: 0o700, mtime: 1_790_000_000, data: new Uint8Array(0) },
    { path: "/base/1/2608", type: "file", mode: 0o600, mtime: 1_790_000_000, data: bytes("x".repeat(513)) },
    { path: `/${"deep/".repeat(30)}name`, type: "file", mode: 0o640, mtime: 7, data: bytes("long\n") },
  ] as const;

  test("writes ustar members that read back exactly, in the order given", () => {
    const archive = writeTar(entries);
    expect(archive.length).toBe(512 + 512 + 1024 + 512 + 512 + 1024);
    const members = readTar(archive);
    expect(
      members.map((member) => [member.path, member.type, member.mode, member.mtime, member.uid, member.gid]),
    ).toEqual(entries.map((entry) => [entry.path, entry.type, entry.mode, entry.mtime, 0, 0]));
    expect(members.map((member) => new TextDecoder().decode(member.data))).toEqual(["", "x".repeat(513), "long\n"]);
    expect(writeTar(entries)).toEqual(archive);
  });

  test("GNU tar lists the archive", () => {
    const dir = fixtures.dir("tar-write");
    write(join(dir, "a.tar"), writeTar(entries));
    const proc = Bun.spawnSync(["tar", "--numeric-owner", "-tvf", join(dir, "a.tar")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const lines = proc.stdout.toString().trim().split("\n");
    expect(lines.map((line) => line.split(/\s+/)[0])).toEqual(["drwx------", "-rw-------", "-rw-r-----"]);
    expect(lines.map((line) => line.split(/\s+/).at(-1))).toEqual(entries.map((entry) => entry.path));
  });

  test("refuses what ustar cannot hold", () => {
    const base = { type: "file", mode: 0o644, mtime: 0, data: new Uint8Array(0) } as const;
    expect(thrown(() => writeTar([{ ...base, path: "x".repeat(101) }])).message).toContain("too long");
    expect(thrown(() => writeTar([{ ...base, path: "a", mtime: -1 }])).message).toContain("mtime");
    expect(thrown(() => writeTar([{ ...base, type: "directory", path: "d", data: bytes("x") }])).message).toContain(
      "has data",
    );
  });

  test("gzips with no name, mtime 0 and the Unix OS byte", () => {
    const data = bytes("prepopulated\n".repeat(100));
    const gz = gzipDeterministic(data);
    expect(Array.from(gz.subarray(0, 10))).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 3]);
    expect(new Uint8Array(gunzipSync(gz))).toEqual(data);
    expect(gzipDeterministic(data)).toEqual(gz);
  });
});

describe("the data directory archive", () => {
  const entry = (path: string, data?: string, mode = 0o666): DataDirEntry => ({
    path,
    type: data === undefined ? "directory" : "file",
    mode,
    data: data === undefined ? new Uint8Array(0) : bytes(data),
  });
  const cluster = [
    entry("/global/pg_control", "control"),
    entry("/PG_VERSION", "18\n"),
    entry("/global", undefined, 0o777),
  ];

  test("sorts members, fixes modes and mtimes, and round-trips", () => {
    const archive = packDataDir(cluster, 1_790_000_000);
    const members = readTar(archive);
    expect(members.map((member) => member.path)).toEqual(["/PG_VERSION", "/global", "/global/pg_control"]);
    expect(members.map((member) => member.mode)).toEqual([FILE_MODE, DIRECTORY_MODE, FILE_MODE]);
    expect(new Set(members.map((member) => member.mtime))).toEqual(new Set([1_790_000_000]));
    expect(packDataDir([...cluster].reverse(), 1_790_000_000)).toEqual(archive);
    const unpacked = unpackDataDir(gzipDeterministic(archive));
    expect(unpacked.map((item) => [item.path, item.type, new TextDecoder().decode(item.data)])).toEqual([
      ["/PG_VERSION", "file", "18\n"],
      ["/global", "directory", ""],
      ["/global/pg_control", "file", "control"],
    ]);
  });

  test("refuses a build marker, relative or repeated paths", () => {
    expect(thrown(() => packDataDir([entry("/PGWASM_BUILD", "{}")], 0)).message).toContain("build marker");
    expect(thrown(() => packDataDir([entry("global", undefined)], 0)).message).toContain("absolute path");
    expect(thrown(() => packDataDir([entry("/a", "1"), entry("/a", "2")], 0)).message).toContain("twice");
  });

  test("a comparison names what differs, down to pg_control's fields", () => {
    const changed = pgControl.slice();
    const view = new DataView(changed.buffer);
    view.setBigInt64(24, view.getBigInt64(24, true) + 1n, true); // `time`
    view.setUint32(292, crc32c(changed.subarray(0, 292)), true);
    const corrupt = pgControl.slice();
    corrupt[24] = (corrupt[24] ?? 0) ^ 1;
    const ours = [
      entry("/PG_VERSION", "18\n"),
      { ...entry("/global/pg_control", ""), data: pgControl },
      entry("/ours", ""),
    ];
    const theirs = [
      entry("/PG_VERSION", "18\n"),
      { ...entry("/global/pg_control", ""), data: pgControl },
      entry("/theirs", ""),
    ];
    expect(compareDataDirs(ours, theirs)).toEqual([
      "only in ours: /ours",
      "only in theirs: /theirs",
      "2 of 3 entries are byte-identical.",
    ]);
    const lines = compareDataDirs(ours, [...theirs.slice(0, 1), { ...entry("/global/pg_control", ""), data: changed }]);
    const time = new DataView(pgControl.buffer, pgControl.byteOffset).getBigInt64(24, true);
    expect(lines.slice(1, 4)).toEqual([
      "/global/pg_control: 5 of 8192 bytes differ",
      `    time: ${time} (theirs ${time + 1n})`,
      `    crc: ${new DataView(pgControl.buffer, pgControl.byteOffset).getUint32(292, true)} (theirs ${view.getUint32(292, true)})`,
    ]);
    const unparsed = compareDataDirs(ours, [
      ...theirs.slice(0, 1),
      { ...entry("/global/pg_control", ""), data: corrupt },
    ]);
    expect(unparsed[2]).toContain("not compared field by field: pg_control's CRC-32C does not match");
  });
});

describe("identity/prepopulated.json", () => {
  test("the committed record reads", () => {
    const layout = layoutFor(repoRoot);
    const record = readPrepopulatedRecord(layout);
    expect(record?.entries).toBeGreaterThan(900);
    expect(record?.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a record round-trips through its JSON, and a wrong one is refused", () => {
    const root = fixtures.dir("prepopulated-record");
    const layout = layoutFor(root);
    const record: PrepopulatedRecord = {
      sourceDateEpoch: 1_790_000_000,
      artefacts: {
        "pglite.js": "a".repeat(64),
        "pglite.wasm": "b".repeat(64),
        "pglite.data": "c".repeat(64),
        "initdb.js": "d".repeat(64),
        "initdb.wasm": "e".repeat(64),
      },
      entries: 998,
      tar: { bytes: 1024, sha256: "f".repeat(64) },
      asset: { bytes: 512, sha256: "0".repeat(64) },
    };
    expect(readPrepopulatedRecord(layout)).toBeUndefined();
    write(layout.prepopulatedRecord, formatPrepopulatedRecord(record));
    expect(readPrepopulatedRecord(layout)).toEqual(record);
    expect(JSON.parse(readFileSync(layout.prepopulatedRecord, "utf8")).kind).toBe(IDENTITY_KINDS.prepopulated);
    write(
      layout.prepopulatedRecord,
      formatPrepopulatedRecord({ ...record, artefacts: { ...record.artefacts, "initdb.js": "x" } }),
    );
    expect(thrown(() => readPrepopulatedRecord(layout)).message).toContain('artefacts["initdb.js"]');
    write(layout.prepopulatedRecord, formatPrepopulatedRecord({ ...record, artefacts: {} }));
    expect(thrown(() => readPrepopulatedRecord(layout)).message).toContain("`artefacts` names no file");
    // A record made before 18.6.2 names the artefacts as they were then: it reads, and is of other artefacts.
    const before = { ...record, artefacts: { "pglite.js": "a".repeat(64), "initdb.js": "d".repeat(64) } };
    write(layout.prepopulatedRecord, formatPrepopulatedRecord(before));
    expect(readPrepopulatedRecord(layout)).toEqual(before);
  });
});
