/**
 * bun run driver:smoke [--artefacts <dir>] [--from <data dir archive>]
 *
 * Drives a build's artefacts end to end with the minimal driver (ADR-0001 decision 10): initdb into MEMFS
 * (or, with --from, a prepopulated data directory archive unpacked into it), a single-user start, and over
 * the wire protocol: `SELECT version()`, a DDL/DML round trip with an error in the middle of it, and
 * `CREATE EXTENSION amcheck` with `bt_index_check` on catalog indexes. Exits 1 on the first failure.
 *
 * The artefacts default to `bun run build`'s output. Not part of validate or CI: it needs a build.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { info, runCliAsync } from "./lib/cli.ts";
import { loadArtefacts } from "./lib/driver/artefacts.ts";
import { initdb } from "./lib/driver/initdb.ts";
import { Postgres } from "./lib/driver/postgres.ts";
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
import { unpackDataDir } from "./lib/prepopulated.ts";

const EXPECTED_VERSION = /^PostgreSQL 18\.3 \(PGlite 0\.5\.8\) on wasm32-unknown-emscripten, /;

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
    expect(EXPECTED_VERSION.test(version ?? ""), "version() names PostgreSQL 18.3 (PGlite 0.5.8) on wasm32", version);
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
  } finally {
    postgres.close();
  }
  info(`driver:smoke: ok (${elapsed()})`);
});
