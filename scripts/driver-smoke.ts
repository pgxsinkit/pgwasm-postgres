/**
 * bun run driver:smoke [--artefacts <dir>] [--from <data dir archive>]
 *
 * Drives a build's artefacts end to end with the minimal driver (ADR-0001 decision 10): initdb into MEMFS
 * (or, with --from, a prepopulated data directory archive unpacked into it), a single-user start, and over
 * the wire protocol: `SELECT version()` (which must name the build's release: its manifest's version, or any
 * `pgwasm-postgres N.N.N` without one), a DDL/DML round trip with an error in the middle of it,
 * `CREATE EXTENSION amcheck` with `bt_index_check` on catalog indexes, a `LOAD` of every shared module the build
 * ships (the core modules in pglite.data's lib/postgresql, and the extension archives'), encoding conversions:
 * every default conversion once, and non-ASCII text through several, the stack-leak check (4,000 failing
 * statements on the session each report their own error, then a normal query runs, and the wasm's shadow stack
 * pointer is where it was), and last pg_dump (pg_dump.js and .wasm) of the round trip's table, on the session as
 * pgxsinkit's pgwasm-pg-dump runs it. Exits 1 on the first failure.
 *
 * The artefacts default to `bun run build`'s output. Not part of validate or CI: it needs a build.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { info, runCliAsync } from "./lib/cli.ts";
import { readUpstreamPin } from "./lib/config.ts";
import { loadArtefacts } from "./lib/driver/artefacts.ts";
import { initdb } from "./lib/driver/initdb.ts";
import { runPgDump } from "./lib/driver/pg-dump.ts";
import { PG_ROOT, Postgres } from "./lib/driver/postgres.ts";
import {
  parseBackendMessages,
  queryMessage,
  queryResults,
  ServerError,
  startupMessage,
  type QueryResult,
} from "./lib/driver/wire.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { MANIFEST_FILE, readManifest } from "./lib/manifest.ts";
import { unpackDataDir } from "./lib/prepopulated.ts";
import { upstreamVersion } from "./lib/version.ts";

/**
 * Non-ASCII text through conversions to other encodings and back, each through its own module. (Not JOHAB:
 * Postgres' own JOHAB verifier refuses what its UTF8 to JOHAB conversion writes; its module still runs in the
 * default conversions below.)
 */
const ROUND_TRIPS: readonly (readonly [encoding: string, text: string])[] = [
  ["LATIN1", "déjà vu"],
  ["LATIN2", "zażółć"],
  ["WIN1251", "привет"],
  ["KOI8R", "привет"],
  ["EUC_JP", "日本語"],
  ["EUC_KR", "한국어"],
  ["EUC_CN", "中文"],
  ["EUC_TW", "中文"],
  ["SJIS", "日本語"],
  ["BIG5", "中文"],
  ["GBK", "中文"],
  ["GB18030", "中文"],
  ["UHC", "한국어"],
  ["EUC_JIS_2004", "日本語"],
  ["SHIFT_JIS_2004", "日本語"],
  ["ISO_8859_5", "привет"],
  ["WIN1250", "zażółć"],
];

/**
 * The stack-leak check's failing statements: more than twice the ERRORs after which a session whose shadow stack
 * pointer is not restored refused everything (about 1,700 at about 1.2 kB each, against max_stack_depth's 2 MB).
 */
const STACK_LEAK_ERRORS = 4000;

function options(args: readonly string[]): { artefacts: string | undefined; from: string | undefined } {
  const usage = "Usage: bun run driver:smoke [--artefacts <dir>] [--from <data dir archive>]";
  let artefacts: string | undefined;
  let from: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) throw new UserError(usage);
    if (args[index] === "--artefacts") artefacts = value;
    else if (args[index] === "--from") from = value;
    else throw new UserError(usage);
  }
  return { artefacts, from };
}

function expect(condition: boolean, what: string, actual: unknown): void {
  if (!condition) throw new UserError(`driver:smoke FAILED: ${what}; got ${JSON.stringify(actual)}`);
}

await runCliAsync(async () => {
  const layout = layoutFor(repoRoot);
  const args = options(process.argv.slice(2));
  const started = performance.now();
  const elapsed = () => `${Math.round(performance.now() - started)} ms`;
  const artefacts = await loadArtefacts(args.artefacts ?? layout.buildDist);
  info(`driver:smoke: artefacts ${relative(layout.root, artefacts.dir) || "."}`);
  const pin = upstreamVersion(readUpstreamPin(layout).tag);
  const manifestFile = join(artefacts.dir, MANIFEST_FILE);
  const release = existsSync(manifestFile) ? readManifest(manifestFile, layout.root).version : undefined;
  const expectedVersion = new RegExp(
    `^PostgreSQL ${pin.major}\\.${pin.minor} \\(pgwasm-postgres ${release === undefined ? "\\d+\\.\\d+\\.\\d+" : release.replaceAll(".", "\\.")}\\) on wasm32-unknown-emscripten, `,
  );

  const cluster =
    args.from === undefined ? await initdb(artefacts) : unpackDataDir(new Uint8Array(readFileSync(resolve(args.from))));
  info(
    `driver:smoke: ${args.from === undefined ? "initdb made" : `${args.from} holds`} ${cluster.length} entries (${elapsed()})`,
  );

  const postgres = await Postgres.create(artefacts);
  try {
    postgres.writeDataDir(cluster);
    postgres.installExtension(artefacts.extension("amcheck"));
    postgres.start();
    info(`driver:smoke: started (${elapsed()})`);

    const startup = parseBackendMessages(postgres.exchange(startupMessage({ user: "postgres", database: "postgres" })));
    const types = startup.map((message) => message.type).join("");
    expect(types.startsWith("R") && types.endsWith("Z"), "the startup exchange ends in ReadyForQuery", types);
    info(`driver:smoke: startup exchange ${types.length} messages, ReadyForQuery`);

    const query = (sql: string): QueryResult[] =>
      queryResults(parseBackendMessages(postgres.exchange(queryMessage(sql))));
    const value = (sql: string): string | null | undefined => query(sql).at(-1)?.rows[0]?.[0];

    const version = value("SELECT version()");
    expect(expectedVersion.test(version ?? ""), `version() matches ${String(expectedVersion)}`, version);
    info(`driver:smoke: ${version}`);

    query("CREATE TABLE smoke (id integer PRIMARY KEY, note text NOT NULL)");
    query("INSERT INTO smoke VALUES (1, 'one'), (2, 'two'), (3, 'three')");
    let duplicate: ServerError | undefined;
    try {
      query("INSERT INTO smoke VALUES (2, 'again')");
    } catch (error) {
      if (!(error instanceof ServerError)) throw error;
      duplicate = error;
    }
    expect(duplicate?.fields["C"] === "23505", "a duplicate key is refused with 23505", duplicate?.message);
    query("UPDATE smoke SET note = upper(note) WHERE id >= 2; DELETE FROM smoke WHERE id = 1");
    const rows = query("SELECT id, note FROM smoke ORDER BY id")[0]?.rows;
    expect(
      JSON.stringify(rows) ===
        JSON.stringify([
          ["2", "TWO"],
          ["3", "THREE"],
        ]),
      "the round trip's rows",
      rows,
    );
    info("driver:smoke: DDL/DML round trip ok, and the session survived a unique violation (23505)");

    query("CREATE EXTENSION amcheck");
    const indexes = ["pg_class_oid_index", "pg_attribute_relid_attnum_index", "pg_proc_proname_args_nsp_index"];
    for (const index of indexes) {
      query(`SELECT bt_index_check('pg_catalog.${index}'::regclass, true)`);
    }
    query("SELECT bt_index_check('smoke_pkey'::regclass, true)");
    const amcheck = value("SELECT extversion FROM pg_extension WHERE extname = 'amcheck'");
    info(
      `driver:smoke: amcheck ${amcheck}: bt_index_check(…, heapallindexed) clean on ${indexes.join(", ")} and smoke_pkey`,
    );

    // Every shared module the build ships: a module whose import pglite.wasm does not export fails to load
    // (a data symbol) or throws out of the wasm when the function is called.
    const FS = postgres.module.FS;
    const modules = FS.readdir(`${PG_ROOT}/lib/postgresql`)
      .filter((name) => name.endsWith(".so"))
      .sort();
    for (const module of modules) query(`LOAD '$libdir/${module.slice(0, -".so".length)}'`);
    info(`driver:smoke: LOAD ok for all ${modules.length} shared modules: ${modules.join(" ")}`);

    // Every default conversion once (each calls its module's conversion function), then non-ASCII round trips.
    const conversions = query(
      "SELECT c.conname, convert('\\x41'::bytea, pg_encoding_to_char(c.conforencoding), pg_encoding_to_char(c.contoencoding)) FROM pg_conversion c WHERE c.condefault ORDER BY c.conname",
    )[0]?.rows;
    expect(
      conversions !== undefined && conversions.length > 100 && conversions.every((row) => row[1] === "\\x41"),
      "every default conversion converts 'A'",
      conversions?.filter((row) => row[1] !== "\\x41"),
    );
    const latin1 = value("SELECT convert('x', 'UTF8', 'LATIN1')");
    expect(latin1 === "\\x78", "convert('x', 'UTF8', 'LATIN1') is \\x78", latin1);
    const eAcute = value("SELECT convert_to('é', 'LATIN1')");
    expect(eAcute === "\\xe9", "convert_to('é', 'LATIN1') is \\xe9", eAcute);
    for (const [encoding, text] of ROUND_TRIPS) {
      const back = value(`SELECT convert_from(convert_to('${text}', '${encoding}'), '${encoding}')`);
      expect(back === text, `'${text}' survives a round trip through ${encoding}`, back);
    }
    info(
      `driver:smoke: ${conversions?.length ?? 0} default conversions ok; convert('x', 'UTF8', 'LATIN1') = ${latin1}, convert_to('é', 'LATIN1') = ${eAcute}; round trips through ${ROUND_TRIPS.map(([encoding]) => encoding).join(" ")}`,
    );
    const stems = value("SELECT to_tsvector('english', 'The running dogs')");
    expect(stems === "'dog':3 'run':2", "dict_snowball stems English", stems);
    info(`driver:smoke: to_tsvector('english', 'The running dogs') = ${stems}`);

    // The shadow stack across ERRORs, on any toolchain: an ERROR unwinds the wasm stack with a throw that skips the
    // epilogue of every frame it abandons, and the driver puts the stack pointer back after it (scripts/lib/driver/
    // postgres.ts, ShadowStack). Without that, every ERROR leaked the abandoned frames' stack until max_stack_depth
    // refused every statement ("stack depth limit exceeded"), then ran past the stack's end.
    const stackBefore = postgres.shadowStackPointer;
    const leakStarted = performance.now();
    for (let index = 0; index < STACK_LEAK_ERRORS; index += 1) {
      const input = `stack-leak-${index}`;
      let failure: ServerError | undefined;
      try {
        query(`SELECT '${input}'::integer`);
      } catch (error) {
        if (!(error instanceof ServerError)) throw error;
        failure = error;
      }
      const message = `invalid input syntax for type integer: "${input}"`;
      expect(
        failure?.fields["C"] === "22P02" && failure.fields["M"] === message,
        `failing statement ${index + 1} of ${STACK_LEAK_ERRORS} reports its own error (22P02, ${message})`,
        failure?.message,
      );
    }
    const stackAfter = postgres.shadowStackPointer;
    const after = value("SELECT 'the session survived'");
    expect(after === "the session survived", `a normal query runs after ${STACK_LEAK_ERRORS} ERRORs`, after);
    expect(
      stackAfter === stackBefore,
      `the shadow stack pointer is where it was before ${STACK_LEAK_ERRORS} ERRORs (${stackBefore})`,
      stackAfter,
    );
    info(
      `driver:smoke: ${STACK_LEAK_ERRORS} failing statements each reported their own error (22P02) in ${Math.round(performance.now() - leakStarted)} ms, then a query ran; the shadow stack pointer stayed at ${stackBefore}`,
    );

    // pg_dump, a program every release ships, on the session: its libpq connects over its default Unix socket,
    // through pglitec.c's socket overrides. Last, since it leaves its read-only transaction open.
    const dump = await runPgDump(artefacts, postgres, ["-U", "postgres", "--inserts", "-t", "public.smoke"]);
    const script = dump.output === undefined ? "" : new TextDecoder().decode(dump.output);
    const inserts = script.split("\n").filter((line) => line.startsWith("INSERT INTO public.smoke "));
    expect(
      dump.exitCode === 0 &&
        script.includes("CREATE TABLE public.smoke (") &&
        JSON.stringify(inserts) ===
          JSON.stringify([
            "INSERT INTO public.smoke VALUES (2, 'TWO');",
            "INSERT INTO public.smoke VALUES (3, 'THREE');",
          ]),
      "pg_dump --inserts -t smoke dumps the table's definition and its two rows",
      dump.exitCode === 0 ? inserts : `exit ${dump.exitCode}: ${dump.stderr}`,
    );
    info(
      `driver:smoke: pg_dump --inserts -t smoke: ${script.length} bytes, CREATE TABLE and ${inserts.length} INSERTs`,
    );
  } finally {
    postgres.close();
  }
  info(`driver:smoke: ok (${elapsed()})`);
});
