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
     that exists upstream is changed by a patch, and a patch never touches an overlay path.
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
     derive it). A temporary `extensions.json` records the gitlinks (path, URL, commit) in their place.
     `patches:check` enforces it in `validate` and in CI until `18.3.0`; it needs no build.
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
   - Five patches, cut by topic in dependency order: `build-emscripten`, `backend-single-process`,
     `startup-packet-export`, `encoding-shim`, `main-loop-unroll`. Each commit message says what the
     patch does and why, and names `b133782` as its source. ElectricSQL's 22 commits are not kept one
     by one.
   - Until byte identity holds, the patches and overlay stay exactly ElectricSQL's, oddities included
     (repeated blocks in `src/template/emscripten` and `src/makefiles/Makefile.emscripten`, the
     `docker` build script). Cleanups come after.

3. **After byte identity, the build compiles only what ships: amcheck.** `exported_functions.txt`
   becomes `included.pglite.exports` plus the shipped modules' imports. `extensions.json`, its clone
   step, and every builder-image library that only those extensions need are deleted. Adding a
   third-party extension or another contrib module later is a build line and a release. This is the
   first change whose artefacts differ from 0.5.8's; the `pglite.wasm` size change is measured and
   recorded when it lands.

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
   consumes them.

6. **The engine gate runs here, before a tag.** Clean apply; build; export-list diff (removing a core
   symbol from `included.pglite.exports` fails, anything else is reported); pg_regress against a
   baseline. pg_regress is native, built from the same tag inside the builder image, run with
   `--use-existing --max-connections=1`, and talks to the wasm build through a Bun TCP bridge of about
   100 lines on the build's byte channel. The first run on 18.3 records the known failures
   (multi-session tests, tablespaces, `\c` reconnects, …) as a checked-in baseline. The gate is "no new
   diffs", and a vanished diff is reported so the baseline tightens. The contract gate (pgxsinkit's
   suites on the pin-bump PR) lives in pgxsinkit. A release that passes the engine gate and fails the
   contract gate is superseded by a new revision, never retracted.

7. **Trigger and automation.** A weekly `git ls-remote` poll finds a new tag of the current major; the
   Bun bump script applies the series, refreshes `patches/`, builds, runs the engine gate and opens a
   PR with the apply log, `git range-diff`, the export diff and the pg_regress result. A conflicting
   apply still opens the PR, failing, with the hunks in its log. The maintainer fast-forwards main from
   the command line and tags; the tag's release job publishes. The next major's betas and RCs update
   one rolling "Postgres 19 readiness" issue with apply, build and (once it builds) regress results,
   with no PR.

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
   break tree identity, so ElectricSQL's copy stays there, unused, and is deleted at `18.3.0`.
   `bun run builder:image` builds it locally (`localhost/pgwasm-postgres-builder:3.1.74-p1`);
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
   own release through both gates, because the glue under `pgwasm-c`'s host code changes.

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
    without pgwasm's build marker; pgwasm adds the marker on restore.

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
       - 3b (next): the pg_regress bridge and its 18.3 baseline (decision 6).
    4. `18.3.0`: amcheck only, the manifest and extension libraries deleted, the fixed-path
       reproducible build, the `pgwasm-postgres` label, our prepopulated data directory. pgxsinkit
       adopts it.
    5. The bump script, run by hand first, then `18.6.0` through it.
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
- Until `18.3.0`, cleaning up ElectricSQL's code breaks tree identity, so it waits.
- The overlay includes two ICU data files, which bring the Unicode License into `NOTICE`.

References: pgxsinkit ADR-0062 (absorb PGlite as pgwasm), ADR-0063 (build permanence and the storage
build), ADR-0064 (the C build's supply chain, pending).
