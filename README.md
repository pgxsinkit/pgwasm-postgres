# pgwasm-postgres

PostgreSQL for WebAssembly, kept as a patch series on upstream PostgreSQL releases. This repository
holds the pin, the patches and the extra files that turn an upstream release into the source of the C
build; PostgreSQL's own source never enters its history. pgxsinkit's `@pgxsinkit/pgwasm-c` (and
`@pgxsinkit/pgwasm-pg-dump`) consume its releases.

The mechanics and the plan are in [ADR-0001](docs/adr/0001-postgres-as-a-patch-series.md).

## Status

The series began as the split of ElectricSQL's PGlite fork (`electric-sql/postgres-pglite` at `b133782`,
the PostgreSQL 18.3 tree PGlite 0.5.8 was built from), proven by tree identity and by rebuilding PGlite
0.5.8's artefacts byte for byte (steps 1 and 2); both records are retired, and the history keeps them. The
build that becomes `18.3.0`, the first release whose bytes are ours, is done (step 4a, 2026-09-27): it
builds only what ships (amcheck, and the core modules `pglite.data` carries), exports what those modules
import, names itself `PostgreSQL 18.3 (pgwasm-postgres 18.3.0)`, and gives the same sha256s from any
checkout. Its artefacts run under this repository's own minimal driver, which also makes the prepopulated
data directory as a deterministic asset; `data-format:check` guards the on-disk format, `exports:check`
the export list, and Postgres's own regression suite runs on the build through a TCP bridge against a
checked-in baseline: of the 230 tests of `parallel_schedule`, 178 pass, 49 fail the same way in every run
and 3 are unstable. There is no release yet: CI for the image, the gate and the release (4b), then
pgxsinkit's adoption (4c).

## Layout

| Path                     | What                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `upstream.json`          | The pin: upstream repository, tag, and the commit the tag must resolve to                      |
| `patches/`               | The series: `git format-patch` output, applied in order with `git am --3way`                   |
| `overlay/`               | Files copied into the tree verbatim, mirroring tree paths; never patched                       |
| `exported_functions.txt` | The reference export list of `pglite.wasm`, which `exports:check` diffs a build's against      |
| `data-format.json`       | The declared `dataFormat` and its compatibility tuple, which `data-format:check` enforces      |
| `identity/`              | The prepopulated asset's record, which `prepopulated --check` reproduces                       |
| `regress/`               | The pg_regress baseline: every test's result, the failing tests' diffs, why each group fails   |
| `builder/`               | The builder image: its pinned `Containerfile`, the package set it must have, the `make -j` cap |
| `scripts/`               | The Bun scripts below                                                                          |
| `docs/adr/`              | Decisions                                                                                      |

The source tree is the pinned tag, with the patches applied as commits and the overlay copied on top.
The overlay only adds files: an upstream file changes through a patch, and no patch touches an overlay
path.

The patches, one per topic:

| Patch                    | Files                                                                     | What                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `build-emscripten`       | `configure`, `.gitignore`, the three port files, eight makefiles          | The Emscripten port, the wasm link and install targets, the version label                                       |
| `backend-single-process` | xlog.c, posix_sema.c, checkpointer.c, fd.c, miscinit.c, postinit.c, guc.c | One backend embedded in the host, without a postmaster or checkpointer process                                  |
| `startup-packet-export`  | backend_startup.c                                                         | `ProcessStartupPacket` callable by the host                                                                     |
| `encoding-shim`          | pg_dump.c, pg_backup_archiver.c, fe-exec.c                                | libpgcommon's encoding functions in the statically linked tools                                                 |
| `main-loop-unroll`       | postgres.c                                                                | PostgresMain's loop split into functions the host calls once per message exchange, plus the host's entry points |

## Working on the series

Requirements: git, [mise](https://mise.jdx.dev) (`mise install` installs the pinned Bun), and
`bun install` (which also installs the pre-commit hook).

```sh
bun run patches:check            # prove the series: apply, round-trip export
bun run patches:work [<tag>]     # materialise work/<tag> with the series as commits
bun run patches:export [<tag>]   # write work/<tag>'s commits back to patches/
```

- **`patches:check`** fetches the pinned tag into `.cache/upstream.git` (a gitignored, shallow, bare
  clone; the first run needs the network, about 35 MB, and later runs take a couple of seconds
  offline), checks that the tag resolves to the pinned commit, applies every patch in a throwaway
  worktree with `git am --3way`, and copies the overlay in. It then checks that re-exporting the applied
  commits reproduces `patches/` byte for byte, and writes the tree the build is made from. A failure names
  the patch, the rejected hunks and the conflicting lines, or the first differing line of a patch file.
  `bun run validate` runs it.
- **`patches:work [<tag>] [--force]`** creates `work/<tag>` (gitignored), a worktree of the cache on
  branch `work/<tag>`: the tag, with one commit per patch on top, and the overlay copied in but not
  committed (the cache's `info/exclude` keeps it out of `git status`, except `pglite/out/.gitignore`,
  which un-ignores itself). `<tag>` defaults to the pinned tag; any other upstream tag is fetched and the
  series applied with a 3-way merge. On a conflict the worktree is left mid-`git am` for you to resolve
  (`git add`, then `git am --continue`). `--force` recreates an existing worktree and discards its work.
- **`patches:export [<tag>]`** writes `<tag>..HEAD` of `work/<tag>` to `patches/` and replaces the old
  files. The worktree must be clean and must be on the pinned tag; commits that touch an overlay path are
  refused. Output is deterministic: no commit ids, no git version, full blob ids, no rename detection,
  no `n/N` numbering, and none of your git config.

To change a patch: `bun run patches:work`, then edit and commit in `work/REL_18_3` (`git commit --fixup`
and `git rebase -i --autosquash REL_18_3` work as usual; a new topic is a new commit), then
`bun run patches:export` and `bun run patches:check`, and commit `patches/` here. A patch's subject is
`<topic>: <summary>`; its body says what the patch does and why. Never edit a patch file by hand.
Overlay files are edited in `overlay/` directly.

## Building

Requirements: podman (rootless is fine) on an amd64 host, the network on the first run, and about 5 GB
of free disk (the image is 2.65 GB; podman's layer cache and the 0.5 GB build tree take the rest).

```sh
bun run builder:image                     # build the builder image from builder/ (about 10 min from scratch, seconds when cached)
bun run build [--debug]                   # build the source in it (about 8 min)
bun run build:verify <manifest> [<dist>]  # check that a build reproduces another's manifest
bun run exports:check [--record]          # diff the build's export list against exported_functions.txt
```

- **`builder:image`** builds `builder/Containerfile` with podman as
  `localhost/pgwasm-postgres-builder:3.1.74-p2`, capped at 4 CPUs and 16 GiB, with `builder/bin/make`
  turning every bare `make -j` into `make -j4`, then checks the image's packages against
  `builder/dpkg-expected.txt`. The log goes to `.cache/builder-image.log`. The image builds what the core
  links: zlib, libxml2 and ICU, at 0.5.8's versions, on Emscripten 3.1.74 (its pins are the documented
  exception to the latest-versions rule; the reasons are next to them).
- **`build`** runs `patches:check`, checks the proven tree out into `.cache/build/postgres-pglite`
  (replacing the previous build) with no `.git`, and runs the tree's `build-pglite.sh` in the builder image,
  reproducibly from any checkout: the source mounted at `/build`, the candidate version of HEAD (derived
  from the tags, see [Versions and releases](#versions-and-releases)) as `PGWASM_POSTGRES_VERSION`,
  `SOURCE_DATE_EPOCH` = the commit time of HEAD (or the environment's), `LC_ALL=C`, as root with umask
  022, under the same resource caps. It builds the core and the contrib modules of `build-pglite.sh`'s
  `PGLITE_CONTRIB` (amcheck), each packaged as a deterministic archive (members sorted, mtimes at
  `SOURCE_DATE_EPOCH`, owner root:0), and links `pglite.wasm` exporting `pglite/static/included.pglite.exports`
  plus every symbol a shipped module imports (the overlay's `pglite/scripts/exported-functions.sh`). The
  artefacts land in `.cache/build/postgres-pglite/dist/` with `manifest.json` next to them: the version,
  commit, tree, epoch, builder image, the compatibility tuple of a fresh initdb and its `dataFormat`, and
  every release artefact's bytes and sha256. The log goes to `.cache/build/build.log`. `--debug` makes a
  debug build whose debug info points at the materialised source on the host (`-ffile-prefix-map`); a
  release build never sees the host path. It refuses to start without podman or the image, or while
  another `pgwasm-postgres-*` container exists.
- **`build:verify <manifest> [<dist dir>]`** checks a `dist/` (default: the build's) against another
  build's manifest: every release artefact by bytes and sha256, the extension archives included, and the
  version, epoch and tuple of the dist's own manifest. It prints a table and exits 1 on any difference.
  Two builds of one commit, from any checkout, reproduce each other.
- **`exports:check [--artefacts <dir>] [--record]`** diffs the build's `exported_functions.txt` against the
  reference at the repository root: a core symbol (one of `included.pglite.exports`) missing fails, any
  other symbol added or removed is reported. `--record` rewrites the reference after a deliberate change.

None of them runs in `validate` or CI: they take too long, and the image is not published yet. Run
`build`, then `exports:check` and the driver's checks below, after changing anything that reaches the
build: `builder/`, `patches/`, `overlay/`, the build scripts.

| File          | 0.5.8 (bytes) | 18.3.0 (bytes) | Change            |
| ------------- | ------------: | -------------: | ----------------- |
| `pglite.wasm` |    10,088,161 |     10,061,242 | −26,919 (−0.27%)  |
| `pglite.data` |     6,295,316 |      6,293,220 | −2,096 (−0.03%)   |
| `pglite.js`   |       516,332 |        380,679 | −135,653 (−26.3%) |

`pglite.wasm` exports 1,144 symbols instead of 0.5.8's 2,093 (the export list: 1,121 instead of 2,064), and
`pglite.js` loses a wrapper for each dropped one; `initdb` and `pg_dump` are byte-identical to 0.5.8's.

## Driving the artefacts

Requirements: a build (`bun run build`, or any directory holding the artefacts); no containers.

```sh
bun run driver:smoke                   # initdb, boot, and a wire-protocol smoke test
bun run prepopulated [--check]         # make the prepopulated data directory; --check reproduces the record
bun run data-format:check              # the data-format guard: the build's tuple against data-format.json
```

The driver (`scripts/lib/driver/`) runs a build's `pglite.js`/`pglite.wasm`/`pglite.data` and
`initdb.js`/`initdb.wasm` directly against their Emscripten glue, with nothing from pgxsinkit: initdb into
MEMFS (its own module, whose `system()`/`popen()` calls run the backend on a scratch instance), a
single-user start on a data directory, a byte channel for the wire protocol (`exchange(bytes) → bytes`, or
streamed, with blocking reads, for the bridge), reading and writing a data directory, mounting a host directory,
installing an extension archive, and a clean close. After an ERROR it restores the wasm's shadow stack pointer,
which the error's unwind leaves where the deepest abandoned frame put it (about 1.2 kB lost per ERROR
otherwise, until `max_stack_depth` refuses everything); an exit (a FATAL) ends the session. It takes the
artefact directory as a build's `dist/` (`bin/`, `extensions/`) or a flat directory of the same files.

- **`driver:smoke [--artefacts <dir>] [--from <archive>]`** runs initdb (or unpacks a data directory
  archive), boots, and over the wire checks that `SELECT version()` names the build's release (its
  manifest's version), a DDL/DML round trip that survives a unique violation, `CREATE EXTENSION amcheck`
  with `bt_index_check` on catalog indexes, a `LOAD` of every shared module the build ships (the 28 core
  modules in `pglite.data`'s `lib/postgresql` and the extension archives'), every default encoding
  conversion once, non-ASCII round trips through 17 encodings, and dict_snowball's stemming.
- **`prepopulated [--artefacts <dir>] [--out <file>] [--check | --record] [--compare <archive>]`** makes the
  prepopulated data directory the way ElectricSQL made `@electric-sql/pglite-prepopulatedfs` 0.5.8 (the
  build's own initdb with PGlite's arguments, a start with PGlite's start parameters, then the archive of the
  running backend's data directory), deterministically: the driver gives the wasm a virtual clock from
  `SOURCE_DATE_EPOCH` (default: the commit time of HEAD), entropy seeded from it, and UTC, and the tarball
  has sorted members with absolute paths, mtimes at `SOURCE_DATE_EPOCH`, owner 0/0, modes 0750/0640 and a
  gzip header with no name and mtime 0. It carries no pgwasm build marker. The asset goes to
  `.cache/prepopulated/prepopulated.tar.gz`, and is then booted and queried to prove it loads. `--check`
  regenerates at the SOURCE_DATE_EPOCH `identity/prepopulated.json` records, from the artefacts it records,
  and requires its sha256s (the archive's, and the gzip's, which holds for the pinned Bun's zlib);
  `--record` rewrites the record after a deliberate build change; `--compare` reports how the asset differs
  from another data directory archive, file by file, pg_control field by field and WAL record by record.
- **`data-format:check [--artefacts <dir>] [<data directory or archive>]`** extracts the compatibility
  tuple from a build's data directory (a fresh initdb through the driver by default, or a directory or an
  archive): pg_control parsed in TypeScript for the wasm32 layout with its CRC-32C verified, and the first WAL
  segment's page magic. It fails unless the tuple is the one `data-format.json` declares for the current
  `dataFormat`, and unless the declaration keeps its rules (formats numbered 1, 2, …, no two with one tuple).

None of them runs in `validate` or CI, which have no build. Run them after a change that reaches the build
or the driver; `bun test` covers their pure logic (the parsers, the tar writer, the determinism helpers).

## Regression tests

Requirements: a build (`bun run build`, or any directory holding the artefacts), podman and the builder image.

```sh
bun run regress                  # run parallel_schedule once and compare it with regress/baseline.json
bun run regress --record         # run it twice or more and rewrite the baseline's results and diffs
bun run regress:bridge [--artefacts <dir>] [--port <n>] [--database <name>] [--setup <sql>]… [--mount <dir>]…
```

- **`regress [--artefacts <dir>] [--runs <n>] [--timeout <minutes>] [--regress-lib <regress.so>] [--record]`** is
  the engine gate's pg_regress (ADR-0001 decision 6). It builds upstream's `pg_regress` and `psql` from the
  pristine pinned tag, never the patched tree (the client is upstream's; the server under test is ours), with
  the builder image's host gcc (about 40 s, cached per tag under `.cache/regress/<tag>/`). It then runs
  `src/test/regress/parallel_schedule` with `--use-existing --max-connections=1` in the builder image on the
  host's network, against the bridge serving the artefacts (default: the build's `dist/`); a run takes about
  two minutes, and its output stays in `.cache/regress/runs/<n>/`. Each test is compared with the baseline: a
  new failure, a changed diff or a newly unstable test fails the gate; a vanished failure is reported, so the
  baseline can be tightened; a test the baseline records as unstable is reported apart. `--record` (2 runs by
  default, at least 2) rewrites `regress/baseline.json`'s results and `regress/diffs/`, and records a test whose
  outcome or diff differs between the runs as unstable. It keeps the failure groups, which are written by hand:
  a new failure lands in `unclassified`, which `bun test` refuses until it has a group and a reason.
- **Diffs are normalised** so that two runs of one build give the same bytes: the header's paths become
  `expected/…` and `results/…`, the timestamps go, and in the content the run's input and output directories
  become `@abs_srcdir@` and `@abs_builddir@` and the bridge's port `@port@`.
- **`--use-existing` makes pg_regress create nothing**, so the bridge creates `regression` as pg_regress's own
  `create_database()` would (`TEMPLATE=template0`, then its six `ALTER DATABASE … SET`s), on a cluster made by
  the build's initdb on the driver's deterministic host, whose clock starts at the pinned tag's commit time. The run's directories have the same paths on the host,
  in the container and in the backend's filesystem (a NODEFS mount), so the tests' server-side
  `COPY … FROM :'filename'` reads the tag's `data/` and writes into the run's `results/`. The run gives no
  `regress.so`: the build tree's own does not load (see the baseline's `regress-library` group), so the tests'
  C functions are missing. `--regress-lib` supplies one for experiments; the baseline is recorded without.
- **The bridge** (`scripts/lib/bridge/`) serves the build's single backend to native clients: TCP in a worker
  thread, the backend on the main thread, which waits on a SharedArrayBuffer so that a `COPY … FROM STDIN`
  blocks for the client's data as on a socket. One connection owns the session at a time; a new one takes it
  over, since psql's `\c` opens its new connection before closing the old one. Before every startup packet it
  resets the session (Sync, `ROLLBACK` if a transaction block is open, `DISCARD ALL`, and
  `SET SESSION AUTHORIZATION postgres`, since single-user mode leaves `session_authorization` without a reset
  value). What a new backend would start without stays as it was (its pid, loaded libraries, caches and
  statistics), and login event triggers never fire. The startup packet's settings (`PGTZ`, `PGDATESTYLE`, `PGOPTIONS`'s `-c`s) become the
  session's defaults, with `set_config` and as `-c` start parameters (the backend is restarted when they
  change), so `RESET` returns to them. The user and database are fixed (`postgres`, the served one): a startup
  packet for another is refused with a FATAL. Only whole messages reach the backend, never a Terminate. A backend
  that fails (a throw out of the wasm, an exit) is restarted from its data directory, which runs crash recovery,
  and the log says `BACKEND FAILED` and for which test. `regress:bridge` runs it on its own, for psql or any
  other client: it prints the port it listens on, and its options are in its usage line.
- **The gate's bridge runs on a raised native stack**: `regress` starts it through bash with `ulimit -s` at
  256 MiB and `BUN_JSC_maxPerThreadStackUsage` at 255 MiB, about 50 times the default's recursion depth.
  Postgres' `check_stack_depth()` measures only the wasm's shadow stack, while every wasm frame takes native
  stack, so on the defaults a deep recursion (`infinite_recurse`, which needs 32 to 48 MiB) threw out of the
  wasm first, depending on how far JavaScriptCore had compiled it. `regress:bridge` on its own runs on the
  stack it is started with.

The baseline (4 runs on the `18.3.0` build) has 230 tests: 178 pass, 49 fail the same way in every run and 3
are unstable; each run reports 52 failures, and no backend fails. The failures, by group
(`regress/baseline.json` has the full reasons):

| Group                     | Tests | Why                                                                                           |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `session-authorization`   | 21    | `RESET SESSION AUTHORIZATION` does nothing in single-user mode; the test runs on as the role  |
| `regress-library`         | 17    | The tests' C functions: the tree's `regress.so` imports symbols `pglite.wasm` does not export |
| `single-process`          | 3     | No checkpointer, no background or parallel workers                                            |
| `session-persistence`     | 3     | `\c` gets the same backend back: login triggers, `temp_buffers`, loaded libraries             |
| `extended-protocol-ready` | 2     | An extended-query error sends an early ReadyForQuery, which desynchronises psql (unstable)    |
| `wasm-stack`              | 2     | The JSON parser's recursion takes no shadow stack, so `max_stack_depth` never trips           |
| `walreceiver-libpq`       | 1     | libpqwalreceiver's static libpq calls the backend's libpgcommon, so connections fail          |
| `clock-resolution`        | 1     | The wasm's wall clock has millisecond resolution (unstable)                                   |
| `start-parameters`        | 1     | PGlite's start parameters: `search_path=public` (and `-O`)                                    |
| `icu-locales`             | 1     | The only ICU collations are `und-x-icu` and `unicode`                                         |

Against the byte-identity build's baseline (172 pass, 51 fail, 7 unstable), euc_kr, copyencoding (the
conversion modules' imports), object_address, tsearch, tsdicts (libpqwalreceiver loads, so no failed
`dlopen` poisons the later ones) and infinite_recurse (the raised stack) pass, and json, jsonb, conversion
and alter_table fail the same way in every run instead of unstably.

Neither script runs in `validate` or CI: they need a build and podman. Run `regress` after any change that
reaches the build or the driver, and `--record` only after a deliberate change, with each new failure given a
group and a reason.

## Scripts

| Script                    | Does                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `format` / `format:write` | oxfmt, check / write                                                                    |
| `lint` / `lint:fix`       | oxlint (type-aware), check / fix                                                        |
| `typecheck`               | TypeScript 7                                                                            |
| `test`                    | Unit tests (`bun test`)                                                                 |
| `check`                   | typecheck + lint + test                                                                 |
| `validate`                | format + check + `patches:check`: the pre-commit hook                                   |
| `validate:full`           | The same, for now: what CI runs on pushes to main and on pull requests                  |
| `builder:image`           | Build the builder image from `builder/` and check its package set                       |
| `build`                   | Build the materialised source in the builder image, with its manifest (not in CI)       |
| `build:verify`            | Check that a build reproduces another build's manifest (not in CI)                      |
| `exports:check`           | Diff a build's export list against `exported_functions.txt`; `--record` it (not in CI)  |
| `driver:smoke`            | Drive a build's artefacts: initdb, boot, a wire-protocol smoke test (not in CI)         |
| `prepopulated`            | Make the prepopulated data directory asset; `--check` it against its record (not in CI) |
| `data-format:check`       | Check a build's compatibility tuple against `data-format.json` (not in CI)              |
| `regress:bridge`          | Serve a build's backend over TCP to native clients (not in CI)                          |
| `regress`                 | Run pg_regress on a build and compare it with the baseline; `--record` it (not in CI)   |

## Versions and releases

Releases are tagged `<pg major>.<pg minor>.<revision>` (`18.3.0`, `18.3.1`, `18.6.0`, …); the tag is the
only version input, and `package.json`'s `0.0.0` is a placeholder. The build derives the version it embeds
(`scripts/lib/version.ts`): `<major>.<minor>.0` of the pinned upstream tag while there is no release tag,
the latest release tag's revision + 1 when that tag is of the pinned major.minor, and `<major>.<minor>.0`
otherwise. Only the tags of HEAD's strict ancestors count, so a tagged commit builds as its own tag, and tags
that are not `N.N.N` (`builder-sources-1`) are ignored; today the candidate is `18.3.0`. Releases are GitHub
release assets with a checksum manifest, not npm packages. History is linear: changes are rebased, never
merged.

## License

The [PostgreSQL License](LICENSE). The patches and the overlay derive from PostgreSQL and from
ElectricSQL's `postgres-pglite`; see [NOTICE](NOTICE).
