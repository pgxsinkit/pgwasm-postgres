# Port checklist: the next Postgres major

What adopting the next Postgres major takes (ADR-0001 decision 8), on a `port-<major>` branch. This file is
`docs/port-checklist.md`; the weekly poll renders it into the "Postgres <major> readiness" issue, under the table.

- **Port the series** onto the new major on a `port-<major>` branch from main, kept rebased onto main
  (`bun run patches:work <tag>`, then `patches:export` and `patches:check`). The readiness issue's reports show
  where each patch conflicts.
- **Rename the internal PGlite names**, decided by the maintainer on 2026-09-28 to happen in the Postgres 19 port
  (18.6.2 renamed the user-facing ones: the artefacts `postgres.{js,wasm,data}` and the root `/pgwasm`).
  `git grep -il pglite` gives the inventory; by name:
  - `__PGLITE__`: `-D__PGLITE__` in `build-pglite.sh`'s `PGLITE_CFLAGS`, and the `#ifdef __PGLITE__` blocks of
    patches `0002` (xlog.c, posix_sema.c, checkpointer.c, fd.c, miscinit.c, guc.c), `0004` (pg_dump.c,
    pg_backup_archiver.c, fe-exec.c) and `0005` (postgres.c).
  - The `pgl_*` C symbols and their `_pgl_*` exports: defined in `overlay/pglite/src/pglitec/pglitec.c`; the libc
    names mapped onto them by `build-pglite.sh`'s `-D<name>=pgl_<name>` list; called by patch `0005`; exported
    through `overlay/pglite/static/included.pglite.exports` into `exported_functions.txt` (16 `_pgl_*` symbols,
    `_pgl_startPGlite` and `_pgl_setPGliteActive` among them); called by the driver (`scripts/lib/driver/`:
    `emscripten.ts`, `initdb.ts`, `postgres.ts`, `pg-dump.ts`). pgxsinkit's host calls them (`pgwasm-c`'s
    `packages/pgwasm-c/src/host/`, and `pgwasm-pg-dump`'s `_pgl_set_rw_cbs`), so the rename is a coordinated host
    change, adopted with the release.
  - `pglitec.c` (and its `PGLITE_UID`) and the `overlay/pglite/` directory (`scripts/`, `src/pglitec/`, `static/`,
    `out/`), with every path that names it: `build-pglite.sh`, patch `0001`'s `pglite/scripts/run_pg_cmd.mjs` (the
    pg_config and pg_ctl Makefiles), `exports:check`'s `pglite/static/included.pglite.exports`, and `readiness`'s
    build steps (`scripts/lib/readiness.ts`).
  - `build-pglite.sh` and its `PGLITE_*` variables (`PGLITE_CFLAGS`, `PGLITE_LDFLAGS`, `PGLITE_LDFLAGS_SL`,
    `PGLITE_LDFLAGS_EX`, `PGLITE_BROWSER_FLOOR`, `PGLITE_CONTRIB`, `PGLITE_EXPORTED_RUNTIME_METHODS`,
    `PGLITE_INCOMING_MODULE_JS_API`, and `POSTGRES_PGLITE_FLAGS`, which patch `0001`'s `src/backend/Makefile` reads),
    its `pglite:` log lines, and what runs it (`scripts/lib/build.ts`, `readiness`'s build steps).
  - The Makefile's `pglite` target and its `install-pglite` (patch `0001`, `src/backend/Makefile`), made by
    `build-pglite.sh`'s step 5.
  - `loadBundleFirst.js`'s location, `overlay/pglite/scripts/`, named by `build-pglite.sh`'s `--pre-js`.
  - `patches:tokens`'s `-D__PGLITE__`: `PREPROCESS_FLAGS` in `scripts/lib/tokens.ts`, and `tests/tokens.test.ts`.
  - The rest that says PGlite: `overlay/README-PGLITE-DEV.md` (ElectricSQL's), the text of
    `overlay/pglite/static/empty` (the placeholder files `bin/initdb`, `bin/pg_dump`, `bin/postgres`, `pgstdin` and
    `pgstdout` in `postgres.data`), and the build tree `.cache/build/postgres-pglite` (`scripts/lib/layout.ts`).
    Provenance stays: `NOTICE`, the ADR's history, and "PGlite 0.5.8's" start parameters and initdb arguments.
- **ICU**: move to the latest ICU with the major (ADR-0001 decision 9): the builder image's pin (a new image tag),
  and the overlay's `minimal-icu` data regenerated for it (`overlay/pglite/static/minimal-icu/<version>`, and its
  `--preload-file` in `build-pglite.sh`).
- **dataFormat**: declare the new `dataFormat` with the new major's tuple in `data-format.json` (decision 8), the
  current one moved to `previous`; `bun run data-format:check` extracts the tuple.
- **Records**: re-record the export list (`bun run exports:check --record`), the prepopulated asset
  (`bun run prepopulated --record`) and the regress baseline (`bun run regress --record --runs 8`, every new failure
  with a group and a reason) for the new major, each in its own commit with its changes explained.
- **Store compatibility** for that release: the maintainer decides. A new `dataFormat` means stores are recreated.
- **pgxsinkit** adopts the release through `pgwasm:pin`, with the host changes the renames need.
