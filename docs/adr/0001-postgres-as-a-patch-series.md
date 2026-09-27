# The C build's Postgres as a patch series on upstream releases

Status: accepted (2026-09-27). The first record of this repository's own mechanics. pgxsinkit ADR-0064,
"The C build's supply chain" (pending), will record the pgxsinkit-facing side: adopting a release with a
pin script, the contract gate, the data-format guard in `@pgxsinkit/pgwasm-c`, and the browser floor in
the consumer docs. Amends pgxsinkit ADR-0062 decision 9: the C build's home is this new repository, not
a rename of the `pgxsinkit/postgres-pglite` fork.

## Context

pgxsinkit's default Postgres build is the C build (`@pgxsinkit/pgwasm-c`), and pgxsinkit owns it
outright (ADR-0062, ADR-0063). Contributing back to ElectricSQL is not a goal. The build ships today as
ElectricSQL's PGlite 0.5.8 artefacts, byte for byte.

Those artefacts were built from `electric-sql/postgres-pglite` at `b133782` ("different build host"):
upstream `REL_18_3` plus 22 commits. ElectricSQL starts each major's fork from an upstream tag and
does not rebase it onto later releases, so minors lag by several releases and majors by months.
Upstream has since tagged `REL_18_4` and `REL_18_6`, and `REL_19_BETA4`.

What the fork changes, outside its own `pglite/` directory: 32 files, +1543/−566.

- Small `#ifdef __PGLITE__` (or `__EMSCRIPTEN__`) blocks in eight backend files: xlog.c, posix_sema.c,
  checkpointer.c, fd.c, miscinit.c, postinit.c, guc.c and backend_startup.c.
- Three identical encoding-shim blocks in pg_dump.c, pg_backup_archiver.c and fe-exec.c.
- A one-line `configure` change that puts `(PGlite $PGLITE_VERSION)` into `version()`.
- Emscripten targets appended to Makefiles, and three new port files.
- `postgres.c`, 1357 changed lines: PostgresMain's loop body moved into `PostgresMainLoopOnce()` and
  re-indented, so git cannot follow it as a move.
- New files: `build-pglite.sh`, `build-with-docker.sh`, `README-PGLITE-DEV.md`, `contrib/dist.mk`
  and `.gitmodules`.

`pglite/` holds the host C code, static files, scripts, the builder Dockerfile, and nine gitlinks for
third-party extensions (pgvector, pgtap, pg_ivm, pg_uuidv7, pg_hashids, AGE, PostGIS, pg_textsearch,
pgmq). pgxsinkit ships none of those extensions, only the `amcheck` contrib module.

`git apply --3way` of that whole diff (2026-09-06) is clean on `REL_18_6` and stops on 7 hunks in 3
files on `REL_19_BETA3`.

The 0.5.8 build has been reproduced (2026-09-27): from `b133782`, with the source mounted at
ElectricSQL's CI path and `PGLITE_VERSION=0.5.8`, both ElectricSQL's builder image and a pinned draft
image (amd64, emsdk by digest, apt from a snapshot, every source by checksum) give 7 of the 8 published
files byte for byte. The eighth, `amcheck.tar.gz`, has the same files, modes and owners, but its
archive bytes carry the moment of ElectricSQL's `make install` and the filesystem's directory order, so
nobody can reproduce them. The build also embeds the checkout path, takes `PGLITE_VERSION` as an input,
and computes `pglite.wasm`'s export list from every extension it builds.

Postgres's own regression suite has never run on the wasm build.

## Decision

1. **A small repository holds the series, not the source.** Its main branch holds `upstream.json`
   (repository, tag, and the commit the tag must resolve to), `patches/` (`git format-patch` output,
   applied with `git am --3way`), `overlay/` (files copied into the tree verbatim, never patched), the
   Bun scripts, the workflows and the docs. Postgres source never enters its history.
   - The overlay starts as ElectricSQL's additions: `pglite/` (host C, static files, scripts, and the
     builder Dockerfile at `pglite/builder/`, unused: see decision 9), `build-pglite.sh`,
     `build-with-docker.sh`, `contrib/dist.mk` and `README-PGLITE-DEV.md`. It only adds files: a path
     that exists upstream is changed by a patch, and a patch never touches an overlay path. `18.3.0`
     deleted the Dockerfile, `build-with-docker.sh` and the extension build files, changed
     `build-pglite.sh`, `contrib/dist.mk` and `included.pglite.exports`, and added
     `pglite/scripts/exported-functions.sh` (decisions 3 and 9).
   - `bun run patches:work <tag>` materialises a gitignored worktree with the series as commits;
     `bun run patches:export` writes them back; `bun run patches:check` proves the series (below). The
     export is deterministic: no commit ids, no git version, full blob ids, no rename detection, no
     "n/N" subject numbering, and none of the user's git config. Patch files are generated and never
     edited by hand. A bump PR carries `git range-diff` of the series.
   - `pgxsinkit/postgres-pglite` is archived as the provenance of `b133782`.

   Why: the tooling stays version-agnostic on one default branch (scheduled workflows run only from the
   default branch), a bump is a reviewable PR against main, the repository is outside ElectricSQL's fork
   network by construction, and a clone is about a megabyte.

2. **The split is proven by tree identity, then byte identity.**
   - Tree identity: pristine `REL_18_3` + `git am` of the series + the overlay, then `git write-tree`,
     equals `b133782`'s tree without `.gitmodules` and the nine extension gitlinks
     (`identity/b133782.json`: tree `a3b4114a08d20cc5d97313d23c4e93376cd5861b`, with the commands that
     derive it). A temporary `extensions.json` recorded the gitlinks (path, URL, commit) in their place.
     `patches:check` enforced it in `validate` and in CI; it needed no build.
   - Byte identity: the materialised tree (the proven tree, with the nine extensions of
     `extensions.json` checked out at their commits and no `.git` anywhere), built by the reproduction
     recipe (source at `/home/runner/_work/pglite/pglite/postgres-pglite`, `PGLITE_VERSION=0.5.8`, root
     with umask 022 and no `TZ` or locale variables, the builder image of decision 9), reproduces the
     sha256s of the seven reproducible files (`pglite.wasm`, `pglite.data`, `pglite.js`, `initdb.wasm`,
     `initdb.js`, `pg_dump.wasm`, `pg_dump.js`), and `amcheck.tar.gz`'s unpacked files, modes and owners
     are identical. Proven 2026-09-27: `bun run build` builds it, and `bun run build:verify` checks its
     `dist/` against `identity/0.5.8-artefacts.json` (the published sizes and sha256s, and the published
     `amcheck.tar.gz`'s members). Neither runs in `validate` or CI: the build takes about 15 minutes and
     the image is not published yet. The split is done.
   - Both records retired with the `18.3.0` build (step 4a, 2026-09-27), whose changes they would refuse:
     `identity/b133782.json` with the identity step of `patches:check`, and `identity/0.5.8-artefacts.json`
     with the byte-identity `build:verify` (the name now checks a build against another's manifest,
     decision 9). The history keeps them. `patches:check` still proves that the series applies and that
     its export round-trips, in `validate` and in CI.
   - Five patches, cut by topic in dependency order: `build-emscripten`, `backend-single-process`,
     `startup-packet-export`, `encoding-shim`, `main-loop-unroll`. Each commit message says what the
     patch does and why, and names `b133782` as its source. ElectricSQL's 22 commits are not kept one
     by one.
   - Until byte identity holds, the patches and overlay stay exactly ElectricSQL's, oddities included
     (repeated blocks in `src/template/emscripten` and `src/makefiles/Makefile.emscripten`, the
     `docker` build script). Cleanups come after; `18.3.0` made the first two.

3. **After byte identity, the build compiles only what ships: amcheck.** `exported_functions.txt`
   becomes `included.pglite.exports` plus the shipped modules' imports. `extensions.json`, its clone
   step, and every builder-image library that only those extensions need are deleted. Adding a
   third-party extension or another contrib module later is a build line and a release. This is the
   first change whose artefacts differ from 0.5.8's; the `pglite.wasm` size change is measured and
   recorded when it lands. Done in `18.3.0` (2026-09-27):
   - `build-pglite.sh` builds and packages the contrib modules of its `PGLITE_CONTRIB`, `amcheck`
     alone. The nine third-party extensions, pgcrypto and every other contrib module are gone, with
     `extensions.json`, its clone step, the overlay's `pglite/other_extensions/`, `build-postgis.sh` and
     `build-pgcrypto.sh`, and the `build-emscripten` patch's `PGLITE_WITH_PGCRYPTO` switch. The modules
     `pglite.data` carries are unchanged: its `lib/postgresql` holds the same 28 core modules, byte for
     byte.
   - The export list is `included.pglite.exports` plus the imports of every module the build ships: the
     28 core modules (plpgsql, dict_snowball, the 24 encoding conversion modules, libpqwalreceiver,
     pgoutput) and the extension archives' (`amcheck.so`). The overlay's
     `pglite/scripts/exported-functions.sh` reads them from the linked modules with binaryen's
     `wasm-dis`: a module's `env` functions and globals and its `GOT.mem` and `GOT.func` entries, less
     what it defines itself (the dynamic linker binds a module's GOT entries to its own definitions) and
     what the dynamic linker hands every module (memory, table, stack pointer, memory and table bases,
     `invoke_*`). libpq's API is left out: the backend defines none of it, and the two encoding
     functions libpqwalreceiver's static libpq takes from libpgcommon (`pg_char_to_encoding`,
     `pg_encoding_to_char`) exist in the backend only as `*_private`. Emscripten refuses to link a list
     naming a symbol the link does not define, so an import the backend cannot give fails the build,
     not a query. The build writes the list into `dist/`; the `build-emscripten` patch lost the Makefile
     target that computed the old one and the `.imports` lists `pgxs.mk` and plpgsql's Makefile wrote
     for it.
   - The old list (every built extension's undefined symbols from its object files, less the symbols of
     the image's libraries) missed the core modules: an encoding conversion threw a `TypeError` out of
     the wasm and ended the backend, and `libpqwalreceiver.so` and `pgoutput.so` did not `dlopen`.
     `driver:smoke` now loads all 29 shipped modules and runs every default conversion. The list went
     from 2,064 symbols to 1,121: 120 added, the core modules' imports (the conversion helpers
     `LocalToUtf`, `UtfToLocal`, `report_invalid_encoding`, …, and what libpqwalreceiver and pgoutput
     need, `WalReceiverFunctions` and the `logicalrep_write_*` family among it); 1,063 removed, what only
     the dropped extensions imported, and OSSP uuid's six functions (`uuid_create`, …), which
     `included.pglite.exports` listed for contrib/uuid-ossp and 0.5.8 never exported (they are gone from
     that file too). `exported_functions.txt` at the repository root is the reference the engine gate
     diffs against (decision 6).
   - Sizes against 0.5.8's (2026-09-27):

     | File          | 0.5.8 (bytes) | 18.3.0 (bytes) | Change            |
     | ------------- | ------------: | -------------: | ----------------- |
     | `pglite.wasm` |    10,088,161 |     10,061,242 | −26,919 (−0.27%)  |
     | `pglite.data` |     6,295,316 |      6,293,220 | −2,096 (−0.03%)   |
     | `pglite.js`   |       516,332 |        380,679 | −135,653 (−26.3%) |

     `pglite.wasm` exports 1,144 symbols instead of 2,093: its export section is 19,287 bytes smaller and
     its code 6,880 (what only the dropped exports kept alive). `pglite.js` loses a wrapper per dropped
     export. Of `pglite.data`'s 699 files only pgxs's `Makefile.global`, `Makefile.port` and `pgxs.mk`
     changed (configure's flags and paths, the patch's smaller port files). `initdb` and `pg_dump` are
     byte-identical to 0.5.8's.

4. **The `main-loop-unroll` patch is rewritten to a minimal-surface form, on 18, before any 19 work.**
   The loop body stays in place at its current indentation; function boundaries go into
   `#ifdef __PGLITE__` blocks at the loop's top and bottom and around the sigsetjmp handler. Proof:
   preprocess `postgres.c` in the current form and in the rewrite with
   `emcc -E -P -D__PGLITE__ -D__LINE__=0 -Wno-builtin-macro-redefined` and compare the token streams;
   identical streams mean identical code except `ereport` line numbers. It runs in seconds, as a CI
   step. Any residual difference is listed and justified in the patch's message, with pgxsinkit's suite
   as the backstop. The oracle is the current patch applied to whichever 18.x is pinned; 19 has none.

5. **Release identity.** Tags are `<pg major>.<pg minor>.<revision>`, unprefixed (`18.3.0`, `18.3.1`,
   `18.6.0`), and are the only version input; nothing in the repository is hand-edited for a release.
   The `configure` label becomes `(pgwasm-postgres 18.6.0)`, so `SELECT version()` names the exact
   build. The byte-identical proof build is never tagged: `18.3.0` is the first build whose bytes are
   ours, and until then pgxsinkit keeps pinning ElectricSQL's npm tarballs, which hold the same bytes.
   Releases are GitHub release assets with a checksum manifest, not npm packages, and only pgxsinkit
   consumes them. The build derives its version from the repository (`scripts/lib/version.ts`), never from
   a hand-edited file: `<pg major>.<pg minor>.0` of the pinned upstream tag while there is no release tag;
   the latest release tag's revision + 1 when that tag is of the pinned major.minor; `<major>.<minor>.0`
   otherwise. Only the tags of HEAD's strict ancestors count, so a tagged commit's candidate is its own
   tag: the release job refuses a tag that is not the candidate, and the gated build and the tag's build
   embed the same version and match byte for byte. Tags that are not `N.N.N` (`builder-sources-1`) are
   ignored. `bun run build` passes the candidate as `PGWASM_POSTGRES_VERSION`, which the `configure`
   patch puts into `(pgwasm-postgres $PGWASM_POSTGRES_VERSION)`: the first build reads
   `PostgreSQL 18.3 (pgwasm-postgres 18.3.0) on wasm32-unknown-emscripten, …`.

6. **The engine gate runs here, before a tag.** Clean apply; build; export-list diff (removing a core
   symbol from `included.pglite.exports` fails, anything else is reported); pg_regress against a baseline.
   The export-list diff is `bun run exports:check`: the build's list against `exported_functions.txt` at
   the repository root, rewritten only by `--record` after a deliberate change; it also lists the symbols
   the JavaScript glue provides rather than `pglite.wasm`. The contract gate (pgxsinkit's suites on the
   pin-bump PR) lives in pgxsinkit. A release that passes the engine gate and fails the contract gate is
   superseded by a new revision, never retracted.
   The pg_regress part is `bun run regress`:
   - `pg_regress` and `psql` are upstream's, built natively from the pristine pinned tag, never the patched
     tree (the client is upstream's; the server under test is ours), with the builder image's host gcc, and
     cached per tag under `.cache/regress/<tag>/`. They run `parallel_schedule` in the builder image on the
     host's network with `--use-existing --max-connections=1`. `--use-existing` creates nothing, so the
     bridge creates `regression` as pg_regress's own `create_database()` would. The run's directories have
     the same paths on the host, in the container and in the backend's filesystem (a NODEFS mount), so the
     tests' server-side `COPY … FROM :'filename'` works as on a local server.
   - The bridge (`scripts/lib/bridge/`, `bun run regress:bridge`) serves the build's one backend over TCP
     through the driver's byte channel. It is not the 100 lines planned: a `COPY … FROM STDIN` needs the
     backend to block for the client's data in the middle of an exchange, so TCP runs in a worker and the
     backend, on the main thread, waits on a SharedArrayBuffer; and psql's `\c` opens its new connection
     before it closes the old one, so a new connection takes the session over instead of queueing. Before
     every startup packet the bridge resets the session: Sync, `ROLLBACK` if a transaction block is open,
     `DISCARD ALL`, then `SET SESSION AUTHORIZATION postgres`. The startup packet's settings become the
     session's defaults, applied with `set_config` and as `-c` start parameters (the backend is restarted
     when they change), so that `RESET` returns to them. A startup packet for another user or database is
     refused with a FATAL. Only whole messages reach the backend, never a Terminate. A backend that fails
     is restarted from its data directory, which runs crash recovery, as a postmaster restarts after a
     crash.
   - `regress/baseline.json` holds every test's result and, per group of failing or unstable tests, why
     (written by hand); `regress/diffs/` holds each failing test's diff, normalised (no paths, timestamps
     or port). A new failure, a changed diff or a newly unstable test fails the gate; a vanished failure is
     reported so the baseline tightens; a test the baseline records as unstable is reported apart.
     `--record` runs at least twice, and a test whose outcome or diff differs between the runs is recorded
     as unstable. The gate needs a build and podman, so it is not in `validate`; CI runs it (below).
   - The 18.3 baseline (2026-09-27, 4 runs on the byte-identity build, about two minutes each): of 230
     tests, 172 pass, 51 fail the same way in every run and 7 are unstable. Tablespaces and `\c` work
     (in-place tablespaces; `\c` through the reset). What fails is the engine's and the build's, not the
     method's: in single-user mode `RESET SESSION AUTHORIZATION` does nothing, since
     `session_authorization` never gets a value (20 tests); an error in an extended-query batch sends a
     ReadyForQuery before its Sync (the overlay's `pgl_longjmp` sets `send_ready_for_query` before the error
     handling sets `ignore_till_sync`), which desynchronises psql; `pglite.wasm` does not export what its
     own encoding conversion modules and `libpqwalreceiver.so` import (a conversion's call throws out of
     the wasm and ends the backend), nor what the tree's `regress.so` imports, so the tests' C functions
     are missing; once one `dlopen` has failed, every later one fails; deep recursion overflows the host's
     native stack before `max_stack_depth` trips; the wall clock has millisecond resolution; there is one
     process, and `\c` gets it back; PGlite's start parameters; no ICU language collations.
   - The bridge runs on a raised native stack: `bun run regress` starts it through bash with `ulimit -s`
     at 256 MiB and `BUN_JSC_maxPerThreadStackUsage` at 255 MiB, about 50 times the default's recursion
     depth. `check_stack_depth()` measures only the wasm's shadow stack (the locals whose address is
     taken), while every wasm frame takes native stack; on the defaults (8 MiB, and JavaScriptCore's own
     limit) a deep recursion overflowed the native stack first, and how deep it got depended on how far
     JavaScriptCore had compiled the wasm. `SELECT infinite_recurse()` (`max_stack_depth` 2MB) needs
     between 32 and 48 MiB (measured 2026-09-27).
   - The 18.3.0 baseline (2026-09-27, 4 runs on the `18.3.0` build, about 100 seconds each): of 230 tests,
     178 pass, 49 fail the same way in every run and 3 are unstable (psql and psql_pipeline, the early
     ReadyForQuery; stats, the clock); each run reports 52 failures and no backend fails. Against the
     byte-identity build's baseline: euc_kr and copyencoding (the conversion modules' imports),
     object_address, tsearch and tsdicts (libpqwalreceiver loads, so no failed `dlopen` poisons
     dict_snowball's) and infinite_recurse (the raised stack) pass; json, jsonb, conversion and
     alter_table fail the same way in every run instead of unstably (json and jsonb report the unterminated
     input, since the JSON parser's recursion takes no shadow stack and `max_stack_depth` never trips;
     conversion and alter_table no longer depend on a restart); opr_sanity, alter_generic and
     subscription get further, and fail on what is left: the tests' C functions, `RESET SESSION
     AUTHORIZATION`, and libpqwalreceiver's libpq.
   - Re-recorded in 4b (2026-09-27, 8 runs on the same artefacts): the second gate from clean failed on a
     changed diff of subscription, which resets its subscription's statistics twice and expects the second
     `stats_reset` to be later; two resets in one millisecond give the same time (the clock's resolution
     again). The four runs of the first record never showed it; three of the eight did. subscription is
     recorded as unstable, in its group walreceiver-libpq: of 230 tests, 178 pass, 48 fail the same way in
     every run and 4 are unstable. A test's instability can hide from a record of a few runs, and the gate
     then fails on it at random; each one found is recorded the same way.
   - Re-recorded for `18.6.0` in step 5 (2026-09-27, 8 runs on the build of the `REL_18_6` bump, with
     `REL_18_6`'s tests and expected output): of 231 tests, 178 pass, 49 fail the same way in every run and 4 are
     unstable (the same four); each run reports 53 failures and no backend fails. Nothing passes or fails that did
     not on `REL_18_3`: the new compression_pglz needs the regress library (regress-library); seven failing tests
     fail at other lines only (their expected output grew upstream); encoding, foreign_data and stats_ext fail on
     their new checks for their groups' reasons; rowsecurity and copy2 lose the syntax errors of their failed
     COPYs' in-line data, which upstream's psql now skips. Before a record, `regress` compares a baseline of
     another tag all the same, as after a bump, and fails until it is recorded for the pinned tag.
   - Known issues, left for later patches: `RESET SESSION AUTHORIZATION` does nothing in single-user
     mode (`session_authorization` never gets a value); an error in an extended-query batch sends an
     early ReadyForQuery (`pgl_longjmp` sets `send_ready_for_query` before the error handling sets
     `ignore_till_sync`); once one `dlopen` has failed, every later one fails ("missing magic block")
     until the backend restarts; libpqwalreceiver links libpq statically without libpgcommon's frontend
     build, so a connection fails with "libpq is incorrectly linked to backend functions" (and
     `pg_char_to_encoding`/`pg_encoding_to_char` stay unresolved in it); `check_stack_depth()` cannot see
     recursion that takes no shadow stack.
   - The first runs also found a defect in the driver: every ERROR leaked about 1.2 kB of the wasm's
     shadow stack, because nothing restored the stack pointer the error's unwind left behind, until
     `max_stack_depth` refused every statement. The driver now restores it after each unwound call.
     pgxsinkit's `pgwasm-c` host (`postgres-instance.ts`) drives the main loop the same way, without a
     restore.
   - As built in 4b (2026-09-27), the whole engine gate is one command, `bun run gate`, which runs the same
     locally and in CI. It gates a commit: it refuses a working tree with changes, sets `SOURCE_DATE_EPOCH`
     to the commit's time, and runs `build` (which starts with the clean apply, `patches:check`),
     `driver:smoke`, `exports:check`, `data-format:check` (decision 8), `prepopulated` at that epoch and
     `prepopulated --check` (decision 10), and `regress`, stopping at the first that fails, whose own
     message says why. Only then does it write `.cache/gate/<commit>/`, the release it would publish
     (decision 9). `gate.yml` runs it on every pull request (its head commit, not GitHub's merge commit: the
     gated commit is the one main is fast-forwarded to) and every push to develop and main, and uploads that
     directory as the artifact `gate-<commit>`, with the manifest in the job summary. `validate:full` stays
     the fast check without a build.
   - A pg_regress run's own counts can differ between two gates of one commit (a test the baseline records
     as unstable may pass or fail), so the manifest records what does not: the baseline the run matched (its
     summary and a digest of `regress/`) and the recorded failures that passed. The run's counts and times
     go to `.cache/regress/outcome.json`, which `regress` writes for the gate.

7. **Trigger and automation.** A weekly `git ls-remote` poll finds a new tag of the current major; the
   Bun bump script applies the series, refreshes `patches/`, builds, runs the engine gate and opens a
   PR with the apply log, `git range-diff`, the export diff and the pg_regress result. A conflicting
   apply still opens the PR, failing, with the hunks in its log. The maintainer fast-forwards main from
   the command line and tags; the tag's release job publishes. The next major's betas and RCs update
   one rolling "Postgres 19 readiness" issue with apply, build and (once it builds) regress results,
   with no PR.

   The release job, as built in 4b (2026-09-27), is `release.yml`, on a pushed tag `N.N.N` only (the filter
   `[0-9]+.[0-9]+.[0-9]+`; `builder-sources-<n>` never matches). In order: `bun run release:check <tag>`
   refuses a tag that is not the commit's candidate version (decision 5); `bun run gate --lock --published`
   runs the engine gate at the tag, from scratch, in the published builder image; `bun run release:gated`
   downloads the gated build of the same commit, the `gate-<commit>` artifact of the latest successful
   `gate.yml` run on it (`gh run list` and `gh run download` with `actions: read`; it waits for a run still
   going); and `bun run release:publish` requires the two manifests to be identical (decision 9) and creates
   the GitHub release with every file of the gate directory as an asset and notes generated from the
   manifest: the upstream tag and commit, each asset's size and sha256, the `dataFormat`, pg_regress, the
   export list against the previous release's, and the builder image's digest. A failed job publishes
   nothing, and the tag can be set again. The maintainer's part is to fast-forward main to a commit
   `gate.yml` passed on and push the tag; `release.yml` looks the gate run up through `gate.yml` on main,
   the default branch. The workflows are thin: every step that does work is a `bun run` script that gives
   the same result locally, and `release:publish --dry-run` stops before `gh release create`. The bump
   script, the poll and the readiness issue are steps 5 and 7.

   The bump, as built in step 5 (2026-09-27), is `bun run bump <upstream tag>`, run by hand until the poll runs
   it, unchanged (`--lock`, `--report <file>` for the PR body, `--trailer` for the commit):
   - It refuses a tag of another major (a release, a beta or a release candidate: a new major goes through a
     `port-<major>` branch, decision 8), anything but a newer release of the pinned major, a tag
     `git ls-remote` does not list or that does not resolve to a commit, and a working tree with changes.
   - It fetches the tag into the upstream cache with its history since the pinned tag (`--shallow-exclude`, so
     the commits between them can be listed and diffed; the shallow boundary is diffed against its real parent)
     and applies the series patch by patch with `git am --3way`, as `patches:work` does. A conflict changes
     nothing in the repository: the report names the patch, each conflicting file with the patch's hunks, where
     the plain apply stopped and the merge's conflict regions, and the upstream commits between the tags that
     changed the file, marked when they changed the lines a hunk stands on (each hunk's range is followed back
     through the earlier patches and forward through the upstream commits).
   - A clean apply is committed at once, the pin and `patches/` re-exported onto the new tag in one commit, after
     `patches:check`, because the gate gates a commit. Then `gate --keep-going` (every step runs, but after a
     failed build; `.cache/gate/<commit>.steps.json` says how each ended) and the report: the apply log, `git
     range-diff` of the series on the old tag against the series on the new one, the upstream commits that change
     the patched files, the export list against the reference, the data format, pg_regress against the baseline
     (the tests upstream changed told apart), the prepopulated data directory against its record, and the sizes
     against the previous release's `manifest.json` (`gh release download`, read-only).
   - It never re-records. The regress baseline, `exported_functions.txt` and `identity/prepopulated.json` are
     re-recorded by the operator after reading the report, each in its own commit with every change explained.
     A changed compatibility tuple stops a minor bump (a minor keeps its `dataFormat`, never a new one), as do a
     core symbol gone from the export list, a failed build, `driver:smoke` or prepopulated asset; a removed symbol
     and a newly failing test are explained before a release.
   - The first bump, `REL_18_3` → `REL_18_6` (`18.6.0`), 2026-09-27: 397 upstream commits, 22 of them in the 25
     patched files; all five patches applied without the 3-way fallback, and re-exported with only blob ids and
     hunk offsets changed, so `git range-diff` shows each unchanged. dataFormat 1's tuple, unchanged. The export
     list gained three symbols, each a shipped module's new import from an upstream fix: amcheck's
     `RestrictSearchPath` (0a61fcd), libpqwalreceiver's `WalRcvIdentifySystemLsn` (3310163) and its static
     libpq's `timingsafe_bcmp` (d93ef41). The baseline is decision 6's. Against `18.3.0`: `pglite.wasm`
     10,089,345 bytes (+28,103), `pglite.data` 6,290,545 (−2,675), `pglite.js` 380,859 (+180). The prepopulated
     asset, at `18.3.0`'s epoch, has 875 of its 998 entries byte-identical to `18.3.0`'s: the version in
     `information_schema.sql_implementation_info`, the new `postgresql.conf.sample`, and initdb's WAL, 8,248 bytes
     longer, which moves the checkpoint and the LSN and data checksum of every page written after it.
     `version()` reads `PostgreSQL 18.6 (pgwasm-postgres 18.6.0) on wasm32-unknown-emscripten, …`.

8. **Majors are adopted deliberately, and on-disk compatibility is guarded mechanically.** Main tracks
   one major. The trigger to move is a feature we need, or the current major coming within 12 months of
   its end of life (18: November 2030); until then the readiness issue and a `port-19` branch rebased
   onto main keep the port warm. Each release's manifest records the compatibility tuple: what Postgres
   compares against its compile-time values before it uses a data directory, read from the source.
   `ReadControlFile()` (REL_18_3 xlog.c) refuses a pg_control whose `pg_control_version` is not
   `PG_CONTROL_VERSION` (lines 4388 and 4398, before the CRC check at 4414), then one whose
   `catalog_version_no` (4424), `maxAlign` (4434), `floatFormat` (4444), `blcksz` (4450), `relseg_size`
   (4460), `xlog_blcksz` (4470), `nameDataLen` (4480), `indexMaxKeys` (4490), `toast_max_chunk_size`
   (4500), `loblksize` (4510) or `float8ByVal` (4521-4535) differs from the build's; and
   `XLogReaderValidatePageHeader()` (xlogreader.c line 1247) refuses WAL whose page magic is not
   `XLOG_PAGE_MAGIC`. Those thirteen values are the tuple. `xlog_seg_size` is not in it: the server
   adopts pg_control's value and only checks that it is a power of two between 1 MB and 1 GB (4539-4541);
   `data_checksum_version` and `default_char_signedness` are not compared either. `data-format.json`
   declares the current `dataFormat` (1) and its tuple, keyed by the C field names, and keeps every
   earlier format under `previous`. `bun run data-format:check` extracts the tuple from a build's data
   directory (pg_control parsed in TypeScript for the wasm32 layout, its CRC-32C verified; the magic from
   the first WAL segment's first page header; the build's `pg_controldata.js` has no `.wasm` and is not
   used) and fails unless it is the declared one: a changed tuple needs a new `dataFormat`, and a new
   `dataFormat` needs a new tuple (formats are numbered 1, 2, … and never share one). The engine gate
   runs it, for a major and equally for our own flag changes (a wasm64 build turns on `FLOAT8_BYVAL`).
   pgxsinkit carries the declared `dataFormat` into the build's identity. How existing stores cross a
   `dataFormat` change is a pgwasm decision, still open; it blocks the first major, not the patch work.

9. **Our own builder image, and every release reproducible.** The builder image is defined in
   `builder/` at the repository root (its `Containerfile`, the runner stage's package set, and the
   `make -j` resource cap), not in the overlay: replacing the overlay's `pglite/builder/Dockerfile` would
   have broken tree identity, so ElectricSQL's copy stayed there, unused, until `18.3.0` deleted it.
   `bun run builder:image` builds it locally (`localhost/pgwasm-postgres-builder:3.1.74-p2`);
   `ghcr.io/pgxsinkit/pgwasm-builder` is built from `builder/` by a workflow that runs when it changes,
   and the build references it by digest; podman everywhere, locally and in CI. The Containerfile is the
   reproduction's pinned draft (amd64, emsdk by digest, apt snapshot, every source by checksum, clones
   by commit), every instruction unchanged; sources that are not stable byte streams (GitLab on-demand
   archives, zlib) are mirrored as release assets here. The source sits at a fixed in-container path
   (`/build`) wherever the host checkout is; `-ffile-prefix-map` keeps debug builds pointing at host
   paths; `SOURCE_DATE_EPOCH` comes from the commit; the build runs under `LC_ALL=C`; extension tarballs
   are deterministic (sorted members, fixed mtimes, `gzip -n`). The tag's release job rebuilds from
   scratch and must reproduce every sha256 of the build the PR's gate tested, tarballs included, so what
   was gated is provably what ships. Emscripten stays at 3.1.74 until `18.3.0` (byte identity needs it;
   the reason goes next to the pin), then moves to the latest Emscripten (6.0.10 on 2026-09-27) as its
   own release through both gates, because the glue under `pgwasm-c`'s host code changes. As built for
   `18.3.0` (2026-09-27):
   - The image is `3.1.74-p2`: zlib (`--with-zlib`), libxml2 (`--with-libxml`) and ICU (`--with-icu`),
     what the core links. Gone: libxslt 1.1.43 (contrib/xml2 only), OpenSSL 3.0.17 (pgcrypto only; the
     core is built `--with-openssl=no`), OSSP uuid 1.6.2 (contrib/uuid-ossp only), json-c, libdeflate,
     libtiff, SQLite, PROJ, GEOS and GDAL (PostGIS only), and the symbol lists the old export list
     subtracted (`/install/exports`, `/install/imports`, `LIB_EXPORTS_DIR`, `LLVM_NM`). Two configure
     flags went with their libraries, each checked in REL_18_3: `--with-libxslt` defines `USE_LIBXSLT`,
     which only contrib/xml2's `xslt_proc.c` reads, and adds `-lxslt` to `LIBS`, from which the backend
     takes nothing; `--with-uuid=ossp` sets `UUID_LIBS` and `HAVE_UUID_OSSP`/`HAVE_OSSP_UUID_H`, read by
     contrib/uuid-ossp alone (`gen_random_uuid()` and `uuidv7()` are core code). The toolchain stage,
     and with it the package set, is unchanged. A build from scratch takes about 10 minutes (the image
     is 2.65 GB). Emscripten stays 3.1.74 in `18.3.0`, and the libraries at 0.5.8's versions, so that the
     first release whose bytes are ours changes what is built and not the toolchain; the pin comments
     say so, instead of byte identity.
   - `bun run build` mounts the materialised source at `/build`, passes `SOURCE_DATE_EPOCH` (the commit
     time of HEAD, or the environment's) and `LC_ALL=C`, and `build-pglite.sh` refuses to run without
     the version or the epoch. `contrib/dist.mk` sorts an archive's members by name and sets their
     mtimes to `SOURCE_DATE_EPOCH` and their owner to root:0 (the 0.5.8 reproduction's fix; tar pipes
     into gzip, whose header then has no name and mtime 0). `bun run build --debug` passes the host's
     path as `HOST_SOURCE_DIR` for `-ffile-prefix-map=/build=<host path>`; a release build never sees
     it, and `pglite.wasm` holds no host path.
   - The build writes `dist/manifest.json`: the version, the commit and the tree, the epoch, the builder
     image, the compatibility tuple of a fresh initdb and the `dataFormat` that declares it, and every
     release artefact's bytes and sha256 (`pglite.wasm`/`.data`/`.js`, `initdb.wasm`/`.js`,
     `pg_dump.wasm`/`.js`, `exported_functions.txt`, `amcheck.tar.gz`). Nothing in it varies between two
     builds of one commit. `bun run build:verify <manifest> [<dist>]` checks a build against another's.
   - Proven 2026-09-27 on the candidate commit: two builds from clean in this checkout and one from a
     clone at another host path gave byte-identical manifests, every sha256 equal, `amcheck.tar.gz`
     included. A build takes about 8 minutes.
   - Published and gated in 4b (2026-09-27). `builder-image.yml` runs `bun run builder:image --push` on a
     push to develop or main that changes `builder/` (not the lock) and on demand, with `GITHUB_TOKEN`
     (`packages: write`): it pushes the image as `ghcr.io/pgxsinkit/pgwasm-builder:3.1.74-p2`, the local
     image's tag, in Docker's v2s2 format, which keeps the config, so a pull by digest gives the local
     image's id. The Containerfile labels it with this repository (`org.opencontainers.image.source`), which
     links the package to it; the label adds no layer. `builder/image.lock.json` records the published
     image: its reference by tag, its digest and image id, and the content of `builder/` it was built from
     (a digest of every file under `builder/` but the lock: paths, contents and the execute bit). It changes
     only through `bun run builder:lock`, which the job summary prints with the digest. A content is
     published once per tag: when the lock records it, nothing is pushed; when the lock records the tag from
     other content, the push is refused, so a change to `builder/` is a new tag (`-p3`), and a published tag
     never moves.
   - The gate chooses its image from the lock (`bun run gate --lock`): the published image, pulled by digest
     and checked against the lock's id, when the lock records `builder/`'s content; otherwise the image
     built from `builder/` in the job (a pull request that changes the builder, until its image is
     published). A release requires the published image (`--published`). `build` and `regress` take the
     image as `--image`; the local default stays `localhost/pgwasm-postgres-builder:3.1.74-p2`. The resource
     caps are passed only when podman can apply them: rootless podman needs the `cpu` and `memory` cgroup
     controllers delegated, which a runner's service user may not have, and the caps change no compiler
     input.
   - The gate directory is the release: `pglite.{wasm,data,js}`, `initdb.{wasm,js}`, `pg_dump.{wasm,js}`,
     `amcheck.tar.gz`, `prepopulated.tar.gz`, `exported_functions.txt`, `data-format.json`, `manifest.json`
     and `SHA256SUMS`. The manifest holds every other file's bytes and sha256, the version, the commit, its
     tree and time, the upstream tag and commit, the `dataFormat` and tuple, the builder image (the
     reference the build ran, its id, its published digest, `builder/`'s content), the export list against
     the reference, and pg_regress (decision 6); nothing in it varies between two gates of one commit. The
     release job requires its gate's manifest to be identical to the gated build's, field by field and file
     by file: that is "what was gated is provably what ships".
   - Proven 2026-09-27 at `94a48dd`: two gates from nothing (the build, the upstream clone, the regress
     tools and runs, the prepopulated asset and the gate directory removed first) gave byte-identical
     manifests (sha256 `150db3e3551f`) and `SHA256SUMS`, every file equal, in about 15 minutes each
     (fetching the upstream tag, the build in 8m12s and 8m26s, the regress tools in 33 s, a pg_regress run
     in 1m31s). `release:publish --dry-run` found the two identical and wrote the notes, and refused a copy
     with a file changed and one whose manifest differs. The image was the local `3.1.74-p2`, not yet
     published, so the dry run reported that and the missing tag instead of refusing them. The first pair,
     at `6034634`, found subscription's instability (decision 6).

10. **This repository runs its artefacts with its own minimal driver,** Bun TypeScript written against
    the Emscripten glue, importing nothing from pgxsinkit (`scripts/lib/driver/`: MEMFS, initdb via
    `callMain` with its `system()` and `popen()` calls run on a scratch instance, a single-user start, the
    byte exchange, loading and dumping a data directory), used by the engine gate and the release job;
    `bun run driver:smoke` proves it on a build. The prepopulated data directory becomes a release asset,
    made as ElectricSQL made `@electric-sql/pglite-prepopulatedfs` 0.5.8: PGlite's initdb arguments and
    environment, a start with PGlite's start parameters, then the archive of the running backend's data
    directory (998 entries with absolute paths, `postmaster.pid` and the relcache init files included).
    It is deterministic without a C patch. The driver gives the wasm a virtual clock that starts at
    `SOURCE_DATE_EPOCH` (default: the commit time of HEAD) and moves a microsecond per read, through the
    imports `clock_time_get`, `emscripten_date_now` and `emscripten_get_now`: that fixes pg_control's
    system identifier and timestamps, the WAL's commit and checkpoint times, and postmaster.pid's start
    time. Generating twice and diffing found two more sources: entropy (`pg_strong_random` reads
    `/dev/urandom`, the host's `crypto.getRandomValues`, for pg_control's `mock_authentication_nonce`; the
    driver replaces the random devices and the `random_get` import with a stream seeded from
    `SOURCE_DATE_EPOCH`) and the host's timezone (initdb picks `timezone` by probing libc local time,
    which the runtime takes from the JavaScript engine; the driver runs in UTC, as ElectricSQL's CI did,
    which gives its `Etc/GMT0`). initdb's `LANG` is set too, since the runtime's default comes from
    `navigator.languages`. The tarball has sorted members, mtimes at `SOURCE_DATE_EPOCH`, owner 0/0, modes
    0750 and 0640, and a gzip header with no name and mtime 0. Two generations are byte-identical, and
    `identity/prepopulated.json` records the epoch, the artefacts' sha256s and the archive's and asset's,
    which `bun run prepopulated --check` reproduces. Against ElectricSQL's asset, 995 of the 998 entries
    are byte-identical, every catalog relation file and relcache init file among them; pg_control, the WAL
    segment and `postmaster.pid` differ only by the clock, the nonce, the CRCs over them, uninitialised
    padding in a few WAL records, and the data directory's inode number in `postmaster.pid`. It ships
    without pgwasm's build marker; pgwasm adds the marker on restore. Regenerated for `18.3.0`
    (2026-09-27) at the build commit's time: against the 0.5.8 build's asset, 993 of the 998 entries are
    byte-identical, every relation file among them. The rest differ by the new epoch (pg_control's system
    identifier, times, nonce and CRC, `postmaster.pid`'s start time, the WAL's timestamps and first page
    header) and by the new binary's memory layout (raw pointers in both `pg_internal.init` files, which
    moved; different leftovers in uninitialised padding of WAL records, with their CRCs); at the old
    epoch, only by the latter.

11. **Browser floor: Safari/iOS 18.4, Chrome 137, Firefox 131.** 18.4 is where Safari gets standard
    wasm exceptions (`exnref`), which give wasm-native setjmp/longjmp and `PG_TRY` without legacy
    exception handling or JavaScript `invoke_*` trampolines; tail calls, extended-const and SIMD come
    with it. Every iOS 18 device can run 18.7, so the floor excludes no device iOS 18.0 would include.
    The build compiles with the matching `-sMIN_*_VERSION` flags, from the release that first enforces
    the floor. The C build's performance work and a multi-session C build are out of scope here.

12. **Repository standards.** Bun and TypeScript 7 for scripts, oxlint and oxfmt, check-default
    scripts, `bun run validate` as the pre-commit hook (it includes `patches:check`) and
    `bun run validate:full` in CI, rebase-only integration from the command line, the tag as the only
    version. Licence: the PostgreSQL License, with a `NOTICE` crediting the PostgreSQL Global
    Development Group and ElectricSQL for the derived patches and overlay.

13. **Order of work.**
    1. This repository: tooling, the `REL_18_3` pin, the overlay, the five patches, the temporary
       extension manifest, tree identity in CI.
    2. Byte identity through the reproduction recipe, in two parts.
       - 2a (done 2026-09-27): the pinned draft image as `builder/`, `bun run build` and
         `bun run build:verify`, and byte identity proven with them.
       - 2b (done 2026-09-27): the unstable sources (the GitLab on-demand archives of libxml2, libxslt
         and libtiff, zlib, and OSSP uuid, whose own site is gone) are mirrored as the assets of the
         release `builder-sources-1` here, and the Containerfile fetches them from it. The checksums
         stay, so the bytes cannot change. Mirror releases are named `builder-sources-<n>`, never a
         semver tag, so they cannot be read as a build version, and an asset is never replaced in
         place.
    3. The driver, the compatibility tuple, the prepopulated asset, the pg_regress bridge and its 18.3
       baseline, in two parts.
       - 3a (done 2026-09-27): the driver and `driver:smoke`; the prepopulated data directory as a
         deterministic asset, with `prepopulated` and its record; the compatibility tuple,
         `data-format.json` and `data-format:check` (decisions 8 and 10).
       - 3b (done 2026-09-27): the TCP bridge, native pg_regress and psql from the pinned tag, the gate
         (`bun run regress`) and the 18.3 baseline: of 230 tests, 172 pass, 51 fail and 7 are unstable
         (decision 6).
    4. `18.3.0`, in three parts.
       - 4a (done 2026-09-27): the build that becomes `18.3.0`. Tree and byte identity retired; amcheck
         only, the extensions manifest and their libraries deleted (image `3.1.74-p2`); the export list
         from the shipped modules' imports, with `exported_functions.txt` as the reference and
         `exports:check`; the fixed-path reproducible build with its manifest and `build:verify`; the
         `pgwasm-postgres` label from the derived version; our prepopulated data directory regenerated;
         the pg_regress baseline re-recorded with the raised stack (decisions 2, 3, 5, 6 and 9).
       - 4b (done 2026-09-27): `bun run gate`, the builder image's publication and lock, and the release
         scripts, each runnable locally; `builder-image.yml`, `gate.yml` and `release.yml` (decisions 6, 7 and
         9). Published by the maintainer, in order: develop pushed, where `builder-image.yml` published the image;
         its digest recorded with `bun run builder:lock` (`b206c07`); `gate.yml` passed on that commit, main
         fast-forwarded to it, and `18.3.0` tagged and released by `release.yml`.
       - 4c: pgxsinkit adopts the release with `pgwasm:pin`.
    5. The bump script, run by hand first, then `18.6.0` through it (done 2026-09-27): `bun run bump`,
       `gate --keep-going`, and `regress` comparing a baseline of another tag (decision 7); the bump to
       `REL_18_6` and its three records, re-recorded after reading its report: the export list, the prepopulated
       asset and the pg_regress baseline (decisions 6, 7 and 10). Two gates from clean at the last commit gave
       identical manifests. Releasing `18.6.0` is the maintainer's, as for `18.3.0`.
    6. The Emscripten update and the browser floor as `18.6.1`, through both gates.
    7. The weekly poll and the readiness issue.
    8. The `main-loop-unroll` rewrite with its token-identity proof, before any `port-19` work.

## Considered options

- **Rename the fork and keep it.** Tooling would live on per-version branches, while scheduled
  workflows run only from the default branch; the repository would stay in ElectricSQL's fork network;
  a clone would carry all of Postgres's history.
- **One squashed commit per major, as ElectricSQL does.** Nothing rebases, which is why minors lag.
- **Plain diff files (quilt style).** They lose authorship and messages, and `git am --3way`'s
  fallback, which needs the blob ids `format-patch` records.
- **Keep ElectricSQL's 22 commits.** They interleave topics and churn (six of them add, disable,
  repoint or remove pg_textsearch); five topic patches review and rebase better.
- **Tree identity alone.** It proves the split of the source, not the build.
- **Drive the artefacts with the published `pgwasm` and `pgwasm-c`.** That is circular on an Emscripten
  bump; moving `pgwasm-c`'s host code here instead would make every change at that seam a two-repository
  publish.
- **Open pin-bump PRs in pgxsinkit automatically.** A PR opened with `GITHUB_TOKEN` triggers no CI, and
  a cross-repository PR needs a standing PAT or App for what is a one-command step.

## Consequences

- A minor bump is a PR whose `git range-diff` shows what moved; a conflict is visible in the PR.
- Working on the series needs one shallow fetch per upstream tag (about 35 MB) into the gitignored
  `.cache/`; later runs are offline and take seconds.
- `patches/` is generated: it changes through `patches:work` and `patches:export`, and a hand edit
  fails `patches:check`.
- With tree identity retired, the series and the overlay change like any other code: through
  `patches:work`/`patches:export`, and proven by the build and the engine gate, not by a record.
- The overlay includes two ICU data files, which bring the Unicode License into `NOTICE`.
- The first pg_regress baseline is a list of the engine's and the build's defects (decision 6); each one
  fixed, in `18.3.0` or later, tightens the baseline through `bun run regress --record`.

References: pgxsinkit ADR-0062 (absorb PGlite as pgwasm), ADR-0063 (build permanence and the storage
build), ADR-0064 (the C build's supply chain, pending).
