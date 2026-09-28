import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DRIVER_FILES, locateDriverFiles } from "../scripts/lib/driver/artefacts.ts";
import { commandWords } from "../scripts/lib/driver/command-line.ts";
import {
  deterministicHost,
  parseEpoch,
  SeededRandom,
  sourceDateEpoch,
  VirtualClock,
} from "../scripts/lib/driver/determinism.ts";
import type { EmscriptenFS } from "../scripts/lib/driver/emscripten.ts";
import { FrontendFramer } from "../scripts/lib/driver/pg-dump.ts";
import { isUnwind, START_PARAMS } from "../scripts/lib/driver/postgres.ts";
import {
  parseBackendMessages,
  queryMessage,
  queryResults,
  ServerError,
  startupMessage,
} from "../scripts/lib/driver/wire.ts";
import { repoRoot } from "../scripts/lib/layout.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

describe("the artefacts the driver loads", () => {
  test("are found in a build's dist/, the backend's in pgwasm/ and never the build tree's bin/postgres.js", () => {
    const dist = fixtures.dir("dist");
    for (const name of ["postgres.js", "postgres.wasm", "postgres.data"]) write(join(dist, "pgwasm", name), name);
    for (const name of ["initdb.js", "initdb.wasm", "postgres.js"]) write(join(dist, "bin", name), name);
    expect(locateDriverFiles(dist)).toEqual({
      "postgres.js": join(dist, "pgwasm", "postgres.js"),
      "postgres.wasm": join(dist, "pgwasm", "postgres.wasm"),
      "postgres.data": join(dist, "pgwasm", "postgres.data"),
      "initdb.js": join(dist, "bin", "initdb.js"),
      "initdb.wasm": join(dist, "bin", "initdb.wasm"),
    });
  });

  test("are found in a flat directory, as a release has them", () => {
    const flat = fixtures.dir("flat");
    for (const name of DRIVER_FILES) write(join(flat, name), name);
    expect(Object.values(locateDriverFiles(flat))).toEqual(DRIVER_FILES.map((name) => join(flat, name)));
    expect(thrown(() => locateDriverFiles(fixtures.dir("empty"))).message).toContain("has no postgres.js");
  });
});

describe("isUnwind", () => {
  test("knows the runtime's own unwinds on Emscripten 3.1.74 and 6, and nothing else", () => {
    // The glue's classes, as Emscripten 6.0.10 declares them (not exported; the name is what is kept).
    class EmscriptenEH {}
    class EmscriptenSjLj extends EmscriptenEH {}
    class ExitStatus {
      name = "ExitStatus";
      status = 1;
    }
    expect(isUnwind("unwind")).toBe(true);
    expect(isUnwind(Infinity)).toBe(true);
    expect(isUnwind(new EmscriptenSjLj())).toBe(true);
    expect(isUnwind(new EmscriptenEH())).toBe(false);
    expect(isUnwind(new ExitStatus())).toBe(false);
    expect(isUnwind(new Error("unwind"))).toBe(false);
    expect(isUnwind(Object.create(null))).toBe(false);
    expect(isUnwind(null)).toBe(false);
  });
});

describe("FrontendFramer", () => {
  test("hands out whole messages: the startup packet, then typed ones, however libpq's writes split them", () => {
    const startup = startupMessage({ user: "postgres" });
    const first = queryMessage("SELECT 1");
    const second = queryMessage("SELECT 2");
    const stream = new Uint8Array([...startup, ...first, ...second]);
    const framer = new FrontendFramer();
    const cut = startup.length + 3;
    expect(framer.push(stream.subarray(0, 2))).toEqual([]);
    expect(framer.push(stream.subarray(2, cut))).toEqual([startup]);
    expect(framer.push(stream.subarray(cut))).toEqual([first, second]);
    expect(() => new FrontendFramer().push(new Uint8Array([0, 0, 0, 3]))).toThrow("invalid length");
  });
});

describe("commandWords", () => {
  test("splits the command lines initdb hands to the host", () => {
    expect(commandWords('"/pglite/bin/postgres" --boot -X 1048576 -F -c log_checkpoints=false')).toEqual([
      "/pglite/bin/postgres",
      "--boot",
      "-X",
      "1048576",
      "-F",
      "-c",
      "log_checkpoints=false",
    ]);
    expect(
      commandWords('"/pglite/bin/postgres" --single -F -O -j -c search_path=pg_catalog template1 >"/dev/null"'),
    ).toEqual(["/pglite/bin/postgres", "--single", "-F", "-O", "-j", "-c", "search_path=pg_catalog", "template1"]);
    expect(commandWords('"/pglite/bin/postgres" -V')).toEqual(["/pglite/bin/postgres", "-V"]);
  });

  test("honours quoting and escapes, and stops at the first operator", () => {
    expect(commandWords(`a'b c'd "e \\"f\\" \\$g \\x" h\\ i ""`)).toEqual(["ab cd", 'e "f" $g \\x', "h i", ""]);
    expect(commandWords("run a | tee b")).toEqual(["run", "a"]);
    expect(commandWords("run a;b")).toEqual(["run", "a"]);
    expect(commandWords("   ")).toEqual([]);
    expect(thrown(() => commandWords('"open')).message).toContain('unterminated "');
    expect(thrown(() => commandWords("'open")).message).toContain("unterminated '");
  });
});

describe("START_PARAMS", () => {
  test("are PGlite 0.5.8's defaultStartParams", () => {
    expect(START_PARAMS).toEqual([
      "--single",
      "-F",
      "-O",
      "-j",
      "-c",
      "search_path=public",
      "-c",
      "exit_on_error=false",
      "-c",
      "log_checkpoints=false",
      "-c",
      "max_worker_processes=0",
      "-c",
      "max_parallel_workers=0",
      "-c",
      "max_parallel_workers_per_gather=0",
      "-c",
      "io_method=sync",
      "-c",
      "max_parallel_maintenance_workers=0",
    ]);
  });
});

describe("wire protocol", () => {
  test("frames a startup packet and a query", () => {
    const startup = startupMessage({ user: "postgres", database: "db" });
    const text = "user\0postgres\0database\0db\0\0";
    expect(startup.length).toBe(8 + text.length);
    expect(new DataView(startup.buffer).getInt32(0)).toBe(startup.length);
    expect(new DataView(startup.buffer).getInt32(4)).toBe(196608);
    expect(new TextDecoder().decode(startup.subarray(8))).toBe(text);

    const query = queryMessage("SELECT 1");
    expect(String.fromCharCode(query[0] ?? 0)).toBe("Q");
    expect(new DataView(query.buffer).getInt32(1)).toBe(4 + "SELECT 1\0".length);
    expect(new TextDecoder().decode(query.subarray(5))).toBe("SELECT 1\0");
  });

  /** A backend message: type, length, body. */
  function message(type: string, ...parts: (string | number[] | Uint8Array)[]): Uint8Array {
    const body = parts.flatMap((part) =>
      typeof part === "string" ? [...new TextEncoder().encode(part)] : Array.from(part),
    );
    const out = new Uint8Array(5 + body.length);
    out[0] = type.charCodeAt(0);
    new DataView(out.buffer).setInt32(1, 4 + body.length);
    out.set(body, 5);
    return out;
  }
  const int16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
  const int32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => Array.from(part)));

  const rows = concat(
    message("T", int16(2), "id\0", new Array<number>(18).fill(0), "note\0", new Array<number>(18).fill(0)),
    message("D", int16(2), int32(1), "7", int32(-1)),
    message("C", "SELECT 1\0"),
    message("Z", "I"),
  );

  test("reads a query's rows, NULLs included", () => {
    const messages = parseBackendMessages(rows);
    expect(messages.map((entry) => entry.type).join("")).toBe("TDCZ");
    expect(queryResults(messages)).toEqual([{ command: "SELECT 1", columns: ["id", "note"], rows: [["7", null]] }]);
  });

  test("turns an ErrorResponse into a ServerError", () => {
    const error = concat(message("E", "SERROR\0", "C23505\0", "Mduplicate key\0", "\0"), message("Z", "I"));
    const failure = thrown(() => queryResults(parseBackendMessages(error)));
    expect(failure).toBeInstanceOf(ServerError);
    expect((failure as ServerError).fields).toEqual({ S: "ERROR", C: "23505", M: "duplicate key" });
    expect(failure.message).toBe("ERROR 23505: duplicate key");
  });

  test("rejects a truncated message and a response without ReadyForQuery", () => {
    expect(thrown(() => parseBackendMessages(rows.subarray(0, rows.length - 1))).message).toContain("claims");
    expect(thrown(() => parseBackendMessages(rows.subarray(0, 3))).message).toContain("truncated");
    expect(thrown(() => queryResults(parseBackendMessages(message("C", "SELECT 0\0")))).message).toContain(
      "ReadyForQuery",
    );
  });
});

describe("the deterministic host", () => {
  test("the virtual clock starts at the epoch and moves a microsecond per read", () => {
    const clock = new VirtualClock(1_790_000_000);
    expect(clock.realtimeMs()).toBeCloseTo(1_790_000_000_000.001, 6);
    expect(clock.monotonicMs()).toBeCloseTo(0.002, 9);
    expect(clock.realtimeMs()).toBeCloseTo(1_790_000_000_000.003, 6);
    expect(clock.realtimeNs()).toBe(1_790_000_000_000_004_000n);
    expect(clock.monotonicNs()).toBe(5_000n);
  });

  test("the seeded stream depends on the seed and the count, never on how draws are split", () => {
    const whole = new Uint8Array(100);
    new SeededRandom("seed").fill(whole);
    const split = new SeededRandom("seed");
    const parts = [new Uint8Array(1), new Uint8Array(33), new Uint8Array(66)];
    for (const part of parts) split.fill(part);
    expect(new Uint8Array(parts.flatMap((part) => Array.from(part)))).toEqual(whole);
    const bytewise = new SeededRandom("seed");
    expect(Array.from({ length: 100 }, () => bytewise.byte())).toEqual(Array.from(whole));
    const other = new Uint8Array(100);
    new SeededRandom("other").fill(other);
    expect(other).not.toEqual(whole);
  });

  test("replaces the clock and entropy imports, and the random devices", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const realNow = () => 0;
    const env = { memory, emscripten_date_now: realNow, emscripten_get_now: realNow, other: realNow };
    const wasi = { clock_time_get: () => 0, random_get: () => 0, fd_write: realNow };
    const host = deterministicHost(1_700_000_000);
    const imports = host.imports({ env, wasi_snapshot_preview1: wasi }, () => memory);
    const hostEnv = imports["env"] as Record<string, (...args: unknown[]) => unknown>;
    const hostWasi = imports["wasi_snapshot_preview1"] as Record<string, (...args: unknown[]) => unknown>;
    expect(hostEnv["other"]).toBe(realNow);
    expect(hostWasi["fd_write"]).toBe(realNow);
    expect(hostEnv["emscripten_date_now"]?.()).toBeCloseTo(1_700_000_000_000.001, 6);
    expect(hostWasi["clock_time_get"]?.(0, 0n, 64)).toBe(0);
    expect(new DataView(memory.buffer).getBigUint64(64, true)).toBe(1_700_000_000_000_002_000n);
    expect(hostWasi["clock_time_get"]?.(9, 0n, 64)).toBe(28);
    expect(hostWasi["random_get"]?.(128, 16)).toBe(0);
    const expected = new Uint8Array(16);
    new SeededRandom("pgwasm-postgres SOURCE_DATE_EPOCH=1700000000").fill(expected);
    expect(new Uint8Array(memory.buffer, 128, 16)).toEqual(expected);
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(0);

    const devices: string[] = [];
    const fs = {
      unlink: (path: string) => devices.push(`unlink ${path}`),
      createDevice: (parent: string, name: string) => devices.push(`create ${parent}/${name}`),
    } as unknown as EmscriptenFS;
    host.prepareFilesystem(fs);
    expect(devices).toEqual(["unlink /dev/random", "create /dev/random", "unlink /dev/urandom", "create /dev/urandom"]);
  });

  test("SOURCE_DATE_EPOCH comes from the environment, or from HEAD's commit time", () => {
    expect(sourceDateEpoch(repoRoot, { SOURCE_DATE_EPOCH: "1790000000" })).toBe(1_790_000_000);
    expect(sourceDateEpoch(repoRoot, {})).toBeGreaterThan(1_780_000_000);
    expect(parseEpoch("0", "x")).toBe(0);
    expect(thrown(() => parseEpoch("1.5", "SOURCE_DATE_EPOCH")).message).toContain("Unix time in seconds");
    expect(thrown(() => sourceDateEpoch(repoRoot, { SOURCE_DATE_EPOCH: "soon" })).message).toContain(
      "SOURCE_DATE_EPOCH",
    );
  });
});
