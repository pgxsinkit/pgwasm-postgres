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
build that became `18.3.0`, the first release whose bytes are ours (step 4a, 2026-09-27), builds only what
ships (amcheck, and the core modules `pglite.data` carries), exports what those modules import, names itself
`PostgreSQL 18.3 (pgwasm-postgres 18.3.0)`, and gives the same sha256s from any checkout. Its artefacts run
under this repository's own minimal driver, which also makes the prepopulated data directory as a
deterministic asset; `data-format:check` guards the on-disk format, `exports:check` the export list, and
Postgres's own regression suite runs on the build through a TCP bridge against a checked-in baseline. CI runs
that whole engine gate on every pull request and every push to develop and main, from scratch, and a tag
releases exactly the build the gate passed (step 4b); the builder image is published and locked, and `18.3.0`
is released. pgxsinkit's adoption follows (4c).

The pin now moves to a new upstream minor through `bun run bump` (step 5, 2026-09-27): the first bump took it
from `REL_18_3` to `REL_18_6`, the build that became `18.6.0` (`PostgreSQL 18.6 (pgwasm-postgres 18.6.0)`).
Of the 231 tests of its `parallel_schedule`, 178 pass, 49 fail the same way in every run and 4 are unstable.

The C build then moved from Emscripten 3.1.74 to 6.0.10 (step 6, 2026-09-28), in the builder image `6.0.10-p1`,
and every link names the browser floor, Safari and iOS 18.4, Chrome 137 and Firefox 131: the build that becomes
`18.6.1` (`PostgreSQL 18.6 (pgwasm-postgres 18.6.1)`). Its compatibility tuple and its pg_regress results are
`18.6.0`'s, its export list gains one symbol, and `pglite.wasm` is 9.4% smaller. See [Emscripten and the browser
floor](#emscripten-and-the-browser-floor).

Upstream is now polled weekly (step 7, 2026-09-28): `poll.yml` runs `bun run bump` on a new minor of the pinned
major and opens its pull request, and reports each new tag of the next major on the rolling "Postgres 19 readiness"
issue through `bun run readiness`. On `REL_19_BETA4` three of the five patches conflict (`0001` in
`src/backend/Makefile`, `0003` in `backend_startup.c`, `0005` in `postgres.c`), so nothing is built yet. See [The
weekly poll and the next major](#the-weekly-poll-and-the-next-major).

## Layout

| Path                      | What                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `upstream.json`           | The pin: upstream repository, tag, and the commit the tag must resolve to                      |
| `patches/`                | The series: `git format-patch` output, applied in order with `git am --3way`                   |
| `overlay/`                | Files copied into the tree verbatim, mirroring tree paths; never patched                       |
| `exported_functions.txt`  | The reference export list of `pglite.wasm`, which `exports:check` diffs a build's against      |
| `data-format.json`        | The declared `dataFormat` and its compatibility tuple, which `data-format:check` enforces      |
| `identity/`               | The prepopulated asset's record, which `prepopulated --check` reproduces                       |
| `regress/`                | The pg_regress baseline: every test's result, the failing tests' diffs, why each group fails   |
| `builder/`                | The builder image: its pinned `Containerfile`, the package set it must have, the `make -j` cap |
| `builder/image.lock.json` | The published builder image: its digest, and the content of `builder/` it was built from       |
| `.github/workflows/`      | CI: `validate:full`, the builder image's publication, the engine gate, the release             |
| `scripts/`                | The Bun scripts below                                                                          |
| `docs/adr/`               | Decisions                                                                                      |

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

To change a patch: `bun run patches:work`, then edit and commit in `work/REL_18_6` (`git commit --fixup`
and `git rebase -i --autosquash REL_18_6` work as usual; a new topic is a new commit), then
`bun run patches:export` and `bun run patches:check`, and commit `patches/` here. A patch's subject is
`<topic>: <summary>`; its body says what the patch does and why. Never edit a patch file by hand.
Overlay files are edited in `overlay/` directly.

## Building

Requirements: podman (rootless is fine) on an amd64 host, the network on the first run, and about 5 GB
of free disk (the image is 2.59 GB; podman's layer cache and the 0.5 GB build tree take the rest).

```sh
bun run builder:image [--push]            # build the builder image from builder/ (about 10 min from scratch, seconds when cached)
bun run builder:lock                      # the published image's lock, and what the gate does with it
bun run build [--debug] [--image <ref>]   # build the source in it (about 7 min)
bun run build:verify <manifest> [<dist>]  # check that a build reproduces another's manifest
bun run exports:check [--record]          # diff the build's export list against exported_functions.txt
```

- **`builder:image`** builds `builder/Containerfile` with podman as
  `localhost/pgwasm-postgres-builder:6.0.10-p1`, capped at 4 CPUs and 16 GiB, with `builder/bin/make`
  turning every bare `make -j` into `make -j4`, then checks the image's packages against
  `builder/dpkg-expected.txt`. The log goes to `.cache/builder-image.log`. The image builds what the core
  links on Emscripten 6.0.10 (Ubuntu 24.04): zlib 1.3.2 and libxml2 2.15.4, their latest releases, and ICU
  76.1, which moves only with a Postgres major. Every input is pinned (the emsdk image by digest, apt by a
  dated snapshot, every source by checksum), at its latest version when pinned; the reasons are next to the
  pins. A cap podman cannot apply (rootless podman without the `cpu` or `memory` cgroup controller delegated,
  as on a CI runner) is left out; the caps change no compiler input. `--push` publishes it (see [The engine gate, CI and
  releases](#the-engine-gate-ci-and-releases)).
- **`builder:lock [--digest <sha256:…> --id <image id> [--content <sha256>] | --unpublished]`** shows
  `builder/image.lock.json` (the published image by tag, its digest and image id, and the content of
  `builder/` it was built from) against `builder/` now, and says whether the gate pulls the published image
  or builds one; with `--digest` and `--id` it records a publication, refusing (with `--content`) a
  `builder/` that is not the one the image was built from. The lock changes only through it.
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
  release build never sees the host path. `--image` builds in another image of podman's local storage (the
  published one, by digest); the manifest records the reference and its id. It refuses to start without
  podman or the image, or while another `pgwasm-postgres-*` container exists.
- **`build:verify <manifest> [<dist dir>]`** checks a `dist/` (default: the build's) against another
  build's manifest: every release artefact by bytes and sha256, the extension archives included, and the
  version, epoch and tuple of the dist's own manifest. It prints a table and exits 1 on any difference.
  Two builds of one commit, from any checkout, reproduce each other.
- **`exports:check [--artefacts <dir>] [--record]`** diffs the build's `exported_functions.txt` against the
  reference at the repository root: a core symbol (one of `included.pglite.exports`) missing fails, any
  other symbol added or removed is reported. `--record` rewrites the reference after a deliberate change.

None of them runs in `validate`: they take too long. The engine gate (`bun run gate`, below) runs them in CI
on every pull request and push. Run the gate (or `build`, then `exports:check` and the driver's checks
below) after changing anything that reaches the build: `builder/`, `patches/`, `overlay/`, the build
scripts.

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
installing an extension archive, pg_dump (`pg_dump.js`/`.wasm`) on a session, and a clean close. After an ERROR
it restores the wasm's shadow stack pointer, which the error's unwind leaves where the deepest abandoned frame
put it (about 1.2 kB lost per ERROR otherwise, until `max_stack_depth` refuses everything); an exit (a FATAL)
ends the session. It takes the
artefact directory as a build's `dist/` (`bin/`, `extensions/`) or a flat directory of the same files.

- **`driver:smoke [--artefacts <dir>] [--from <archive>]`** runs initdb (or unpacks a data directory
  archive), boots, and over the wire checks that `SELECT version()` names the build's release (its
  manifest's version), a DDL/DML round trip that survives a unique violation, `CREATE EXTENSION amcheck`
  with `bt_index_check` on catalog indexes, a `LOAD` of every shared module the build ships (the 28 core
  modules in `pglite.data`'s `lib/postgresql` and the extension archives'), every default encoding
  conversion once, non-ASCII round trips through 17 encodings, and dict_snowball's stemming. Then the
  stack-leak check: 4,000 failing statements on the session must each report their own error, a normal query
  must run after them, and the shadow stack pointer must be where it was. It guards the restore after an
  ERROR on any toolchain (without it the check fails at the 1,899th statement, "stack depth limit exceeded").
  Last, `pg_dump --inserts -t smoke` on the session, as pgxsinkit's `pgwasm-pg-dump` runs it (`pg_dump.js` and
  `.wasm` through libpq's socket overrides), must dump the table and its two rows.
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

None of them runs in `validate`, which has no build; the engine gate runs them. Run them after a change that
reaches the build or the driver; `bun test` covers their pure logic (the parsers, the tar writer, the
determinism helpers).

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

The baseline (8 runs on the `18.6.0` build, `REL_18_6`'s tests) has 231 tests: 178 pass, 49 fail the same way in
every run and 4 are unstable; each run reports 53 failures, and no backend fails. The `18.6.1` build (Emscripten
6.0.10) matches it in every run, and it was not re-recorded. The failures, by group (`regress/baseline.json` has
the full reasons):

| Group                     | Tests | Why                                                                                                        |
| ------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `session-authorization`   | 21    | `RESET SESSION AUTHORIZATION` does nothing in single-user mode; the test runs on as the role               |
| `regress-library`         | 18    | The tests' C functions: the tree's `regress.so` imports symbols `pglite.wasm` does not export              |
| `single-process`          | 3     | No checkpointer, no background or parallel workers                                                         |
| `session-persistence`     | 3     | `\c` gets the same backend back: login triggers, `temp_buffers`, loaded libraries                          |
| `extended-protocol-ready` | 2     | An extended-query error sends an early ReadyForQuery, which desynchronises psql (unstable)                 |
| `wasm-stack`              | 2     | The JSON parser's recursion takes no shadow stack, so `max_stack_depth` never trips                        |
| `walreceiver-libpq`       | 1     | libpqwalreceiver's static libpq calls the backend's libpgcommon, so connections fail (unstable: the clock) |
| `clock-resolution`        | 1     | The wasm's wall clock has millisecond resolution (unstable)                                                |
| `start-parameters`        | 1     | PGlite's start parameters: `search_path=public` (and `-O`)                                                 |
| `icu-locales`             | 1     | The only ICU collations are `und-x-icu` and `unicode`                                                      |

Against the byte-identity build's baseline (172 pass, 51 fail, 7 unstable), euc_kr, copyencoding (the
conversion modules' imports), object_address, tsearch, tsdicts (libpqwalreceiver loads, so no failed
`dlopen` poisons the later ones) and infinite_recurse (the raised stack) pass, and json, jsonb, conversion
and alter_table fail the same way in every run instead of unstably. Against `18.3.0`'s (`REL_18_3`, 230 tests:
178, 48, 4), nothing passes or fails that did not before: `REL_18_6` adds compression_pglz, which needs the
regress library, and twelve failing tests fail at other lines or on their new checks (the commit that recorded it
says which and why).

`regress` compares with a baseline recorded on another upstream tag all the same, as after a bump, and then fails
until the baseline is recorded for the pinned tag.

Neither script runs in `validate`: they need a build and podman; the engine gate runs `regress`. Run it after
any change that reaches the build or the driver, and `--record` only after a deliberate change, with each new failure given a
group and a reason.

## The engine gate, CI and releases

Requirements: as for [building](#building); the release scripts also need the GitHub CLI (`gh`).

```sh
bun run gate [--image <ref> | --lock [--published]] [--keep-going] [--summary <file>]   # the engine gate of HEAD
bun run release:check <tag>                                 # the tag is HEAD's candidate version
bun run release:gated <commit> [--out <dir>]                # download the gated build of a commit
bun run release:publish <tag> --gated <dir> [--dry-run]     # identical manifests, then the GitHub release
```

- **`gate`** is the whole engine gate (ADR-0001 decision 6) of the current commit, in about 12 minutes. It
  refuses a working tree with changes, sets `SOURCE_DATE_EPOCH` to the commit's time, and runs `build`,
  `driver:smoke`, `exports:check`, `data-format:check`, `prepopulated` (at that epoch),
  `prepopulated --check` and `regress`, stopping at the first that fails, whose own message says why;
  `--keep-going` runs every step all the same (but after a failed build) and then fails on all that did, which is
  what `bump` runs. Then it writes `.cache/gate/<commit>/`, which exists only for a commit whose gate passed: the
  release. How each step ended goes to `.cache/gate/<commit>.steps.json`, passed or not. The builder
  image is the local one by default, or `--image`; `--lock` lets `builder/image.lock.json` decide, as CI does:
  the published image, pulled by digest, when the lock records `builder/`'s content published, and otherwise
  the image built from `builder/` in the job; `--published` (the release) accepts only the published image.
  `--summary` appends a Markdown summary of the manifest (the job summary in CI).
- **`release:check <tag>`** refuses a tag that is not `N.N.N`, does not point at HEAD, or is not HEAD's
  candidate version.
- **`release:gated <commit> [--out <dir>]`** downloads the `gate-<commit>` artifact of the latest successful
  `gate.yml` run on the commit (`gh run list`, `gh run download`; it waits for a run still going) into
  `.cache/gated/<commit>` and checks it against its own manifest and `SHA256SUMS`.
- **`release:publish <tag> --gated <dir> [--gate <dir>] [--dry-run] [--summary <file>]`** checks both gate
  directories, requires this gate (default: `.cache/gate/<HEAD>`) to be of HEAD and of the tag's version,
  built in the published image, and its manifest identical to the gated build's, writes the notes
  (`.cache/gate/<HEAD>.notes.md`) and runs `gh release create <tag> --verify-tag` with every file of the gate
  directory. `--dry-run` stops before that, printing the notes and the command, and reports a missing tag or
  a local builder image instead of refusing.

A release, and the gate directory it is made from, holds:

| File                                      | What                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pglite.wasm`, `pglite.data`, `pglite.js` | The backend, its filesystem bundle and its Emscripten glue                                 |
| `initdb.wasm`, `initdb.js`                | initdb                                                                                     |
| `pg_dump.wasm`, `pg_dump.js`              | pg_dump                                                                                    |
| `amcheck.tar.gz`                          | The amcheck extension                                                                      |
| `prepopulated.tar.gz`                     | The prepopulated data directory, made at the commit's `SOURCE_DATE_EPOCH`                  |
| `exported_functions.txt`                  | The export list `pglite.wasm` was linked with                                              |
| `data-format.json`                        | The declared `dataFormat` and its compatibility tuple                                      |
| `manifest.json`                           | Every other file's bytes and sha256, and what they were built from and what the gate found |
| `SHA256SUMS`                              | `sha256sum -c` lines for every file but itself                                             |

`manifest.json` records the version, the commit, its tree and its time (the `SOURCE_DATE_EPOCH`), the
upstream tag and commit, the `dataFormat` and tuple, the builder image (the reference the build ran, its id,
its published digest, and the content of `builder/`), the export list against `exported_functions.txt`, and
pg_regress as the baseline the run matched (its summary, a digest of `regress/`, the recorded failures that
passed). Nothing in it varies between two gates of one commit: the runs' own counts and times stay in
`.cache/regress/outcome.json`. The release notes are generated from it: the upstream tag and commit, each
asset's size and sha256, the `dataFormat`, pg_regress, the export list against the previous release's, and
the builder image's digest.

The workflows are thin: every step that does work is one of these scripts, and gives the same result
locally.

| Workflow            | On                                                                          | Runs                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`            | pull requests, pushes to develop and main                                   | `validate:full`                                                                                                                    |
| `builder-image.yml` | pushes to develop and main that change `builder/` (not the lock); on demand | `builder:image --push` to `ghcr.io/pgxsinkit/pgwasm-builder`; the digest and the `builder:lock` command in the job summary         |
| `gate.yml`          | pull requests (their head commit), pushes to develop and main               | `gate --lock`; the gate directory uploaded as the artifact `gate-<commit>`; the manifest in the job summary                        |
| `release.yml`       | a tag `N.N.N` (never `builder-sources-<n>`)                                 | `release:check`, `gate --lock --published`, `release:gated`, `release:publish`: the release, only if its manifest is the gated one |
| `poll.yml`          | Mondays 06:00 UTC; on demand (`dry_run`)                                    | `poll --lock` from develop: a bump's branch and pull request (or issue), the readiness issue's comment and table                   |

The builder image is published from `builder/` by `builder-image.yml` as
`ghcr.io/pgxsinkit/pgwasm-builder:<tag>` (`6.0.10-p1`, the local image's tag), in Docker's v2s2 format so that
a pull by digest gives the local image's id. It publishes a content of `builder/` once per tag: when the lock
already records it, nothing is pushed, and when the lock records the tag published from other content, it
refuses. A change to `builder/` is therefore a new tag (`-p2`: `BUILDER_IMAGE` in `scripts/lib/builder.ts`
and the Containerfile's header). Until its publication is recorded, CI builds the image in the job (up to an
hour more), and no release can be made. The job summary prints the command that records it:
`bun run builder:lock --digest <sha256:…> --id <image id> --content <sha256>`, run on the commit the workflow
ran on, and committed.

Releasing, once the lock records the published image (`bun run builder:lock` says the gate pulls it):

1. The commit is on develop and `gate.yml` passed on it (on its pull request's head or on a push).
2. Fast-forward main to it and push main; `release.yml` finds the gate run through `gate.yml` on main, the
   default branch.
3. Tag the commit with its candidate version, the version the gate built (`18.3.0`), unprefixed, and push the
   tag. `release.yml` rebuilds the commit from scratch in the published image, runs the gate again, requires
   its manifest to be identical to the gated build's, and publishes the release with its assets and notes.

A tag that is not the commit's candidate, a lock that does not record the published image, or a build that
differs from the gated one fails the job before anything is published; the tag can then be deleted and set
again. A gate artifact lives as long as the repository's artifact retention (90 days by default); for an older
commit, re-run `gate.yml` on it before tagging.

## Bumping to a new upstream release

Requirements: as for [the engine gate](#the-engine-gate-ci-and-releases), the network, and `gh` for the size
comparison (without it the report says so and goes on).

```sh
bun run bump <upstream tag> [--image <ref> | --lock] [--report <file>] [--trailer <trailer>]...
```

A new minor release of the pinned major (`REL_18_6` on a `REL_18_3` pin) goes in through **`bump`** (ADR-0001
decision 7), run by hand or by [the weekly poll](#the-weekly-poll-and-the-next-major), unchanged.

- **It refuses** a tag of another major, a release, a beta or a release candidate alike (`REL_19_BETA4`: a new
  major is adopted deliberately, through a `port-<major>` branch rebased onto main, decision 8), anything but a
  newer release of the pinned major (`REL_18_BETA1`, the pinned tag, an older one), a tag upstream does not have
  (`git ls-remote`) or that does not resolve to a commit, and a working tree with changes.
- **It applies** the series onto the tag: the tag is fetched into the upstream cache with its history since the
  pinned one (`--shallow-exclude`, so that the commits between them can be listed and diffed), and the patches
  are applied one by one with `git am --3way`, as `patches:work` does. On a conflict it stops and changes nothing
  in the repository: the report names the patch, each conflicting file with the patch's hunks, where the plain
  apply stopped, the 3-way merge's conflict regions and their text, and the upstream commits between the tags
  that changed the file, marking those that changed the lines the hunks stand on. The conflict is then resolved
  by hand in `patches:work <tag>`.
- **On a clean apply it commits the bump**: `patches/` re-exported onto the tag (context lines and blob ids
  move) and `upstream.json`'s tag and commit, proven by `patches:check`, in one commit, validated by the hook,
  whose subject is `upstream: bump the pin to <tag>` (`--trailer` adds trailers to its message). A failure
  before the commit puts both back.
- **Then it runs `gate --keep-going`** on that commit and writes the report (default
  `.cache/bump/<tag>.md`, or `--report`), Markdown, the bump's pull request body: the verdict, what to
  investigate and what to re-record; the apply log; `git range-diff` of the series on the old tag against the
  series on the new one; the upstream commits that change the patched files; each step of the gate; the export
  list against `exported_functions.txt`; the data format; pg_regress against the baseline (a baseline of the old
  tag is compared all the same, with the new tag's tests; tests upstream changed are told apart, and the new and
  changed diffs are in the report); the prepopulated data directory against its record; and the sizes against the
  previous release's `manifest.json` (downloaded with `gh`, read-only).
- It exits 1 when something blocks the bump: a conflict, a failed build or `driver:smoke`, a changed
  compatibility tuple (a minor release keeps its `dataFormat`: find out why, never declare a new one), a core
  symbol missing from the export list, the prepopulated asset, pg_regress not completing; records that differ do
  not block. HEAD moves only when the bump is committed, never on a refusal or a conflict.

**`bump` never re-records a record.** After reading the report, re-record each one that differs, in its own
commit after the bump's, with each change explained in the commit message:

1. `bun run exports:check --record`: why each symbol came or went (which shipped module imports it now, and the
   upstream commit that made it). A core symbol never goes missing, and a removed symbol is explained before a
   release.
2. `bun run prepopulated --record`: the record names the artefacts, so it moves with every build change; say how
   the asset differs from the previous release's (`--compare`, with `SOURCE_DATE_EPOCH` at that release's epoch so
   that the clock does not count).
3. `bun run regress --record --runs 8`: the baseline becomes the new tag's. Every test that newly fails, a test new
   in the schedule included, gets a group and a reason, and every failing test that fails differently is
   explained (a test upstream changed, or a change of the build).

Then the docs, and two gates from clean at the last commit, with identical manifests. The release is then as
for any commit: `gate.yml` passes on it, main is fast-forwarded to it, and it is tagged with its candidate
version (`18.6.0` for the first bump on `18.3.0`).

The first bump, `REL_18_3` → `REL_18_6` (`18.6.0`, 2026-09-27): all five patches applied cleanly (hunk offsets
and blob ids moved; `git range-diff` shows every patch unchanged); 397 upstream commits, 22 of them change the
patched files. The tuple is dataFormat 1's. Three symbols joined the export list (amcheck's `RestrictSearchPath`,
libpqwalreceiver's `WalRcvIdentifySystemLsn` and `timingsafe_bcmp`); the baseline's changes are under
[Regression tests](#regression-tests). The sizes against `18.3.0`:

| File          | 18.3.0 (bytes) | 18.6.0 (bytes) | Change           |
| ------------- | -------------: | -------------: | ---------------- |
| `pglite.wasm` |     10,061,242 |     10,089,345 | +28,103 (+0.28%) |
| `pglite.data` |      6,293,220 |      6,290,545 | −2,675 (−0.04%)  |
| `pglite.js`   |        380,679 |        380,859 | +180 (+0.05%)    |

## The weekly poll and the next major

Requirements: `gh` (with `GH_TOKEN`, or logged in), the network; for what it runs, as for `bump` and the engine gate.

```sh
bun run poll [--dry-run] [--image <ref> | --lock]
bun run readiness <upstream tag> [--image <ref> | --lock] [--report <file>]
```

**`poll`** (ADR-0001 decisions 7 and 8) lists upstream's tags with `git ls-remote --tags` and acts on two targets,
each once: a later run finds what an earlier one made and skips it. `poll.yml` runs it every Monday at 06:00 UTC
and on demand (`dry_run`), from develop, with `--lock`.

- **A bump**: the newest release of the pinned major newer than the pin (only the newest: `REL_18_4` is skipped
  when `REL_18_6` is out). From develop, with a clean working tree, it makes the branch `bump/<tag>` and runs
  `bun run bump <tag> --report .cache/poll/bump-<tag>.md`. If the bump committed, the branch is pushed and a pull
  request against develop is opened with the report as its body, a draft titled `[blocked] …` when `bump` exits 1
  because something stops it. If it did not (a conflicting apply, or a refusal) there is no commit to open a pull
  request with, so an issue "Bump to `<tag>`: the series does not apply" carries the conflict report. HEAD goes
  back to develop. An existing `bump/<tag>` branch on GitHub, or an open pull request or issue naming the tag,
  skips the bump.
- **The next major's readiness**: its newest tag (betas, then release candidates, then releases:
  `REL_19_BETA4` today) gets `readiness`'s report as a comment marked `<!-- readiness:<tag> -->` on the open issue
  "Postgres 19 readiness" (made when there is none), whose body is kept a table of every reported tag: apply,
  build and pg_regress. A comment with the tag's marker skips the run; the table is still brought up to date. Never
  a pull request, never a commit: a major is adopted through a `port-<major>` branch.
- `--dry-run` runs only what reads (`git ls-remote`, `gh … list`, `gh api` GETs) and prints every command that
  would write anything, locally or on GitHub. The bodies go to `.cache/poll/`, which `poll.yml` uploads as an
  artifact: a body over GitHub's limit (65,536 characters) is cut, with a note.

The bump's pull request is for review only: develop is fast-forwarded to it from the command line, never merged.
The poll pushes and opens it with the workflow's `GITHUB_TOKEN`, which triggers no workflow, so it shows no checks:
its body carries the engine gate's result, and `gate.yml` runs when the fast-forward of develop is pushed. The
repository must allow Actions to open pull requests (Settings → Actions → General → "Allow GitHub Actions to create
and approve pull requests"), or `gh pr create` fails after the branch is pushed. The schedule runs from the default
branch, so it starts once main has `poll.yml`.

**`readiness`** refuses a tag of the pinned major or an older one (a newer release of the pinned major is a bump),
a tag upstream does not have, and a working tree with changes. It never commits to a branch:

- It fetches the tag (shallow) and applies the series of HEAD onto it with `git am --3way`, patch by patch, in a
  scratch worktree of the upstream cache, past its conflicts: a patch that conflicts is reported with the bump's
  conflict sections (its files and hunks, the merge's conflict regions and their text; not the upstream commits,
  whose history is not fetched), skipped, and the next ones applied without it, so a later patch can fail for want
  of an earlier one.
- On a clean apply it builds in a scratch copy of the repository at HEAD (a detached worktree under `.cache/`,
  sharing the upstream cache) with the series re-exported onto the tag and the pin moved to it: `bun run build`,
  whose version for a beta or a release candidate is the pre-release `19.0.0-beta.4` (never a release: release
  tags are `N.N.N`). A failed build is reported with build-pglite.sh's step and its last errors.
- Once it builds: the compatibility tuple of a fresh initdb against `data-format.json` (a major is expected to
  change it: the report gives the new values), the export list against `exported_functions.txt`, and
  `bun run regress` against the pinned major's baseline (the counts, and the new failures by name).

The report (default `.cache/readiness/<tag>.md`, the build log next to it) starts with its status as an HTML
comment, from which the poll keeps the issue's table. `readiness` exits 0 whenever it wrote a report, whatever the
report says; the scratch worktrees are removed.

## Emscripten and the browser floor

Since `18.6.1` the C build is compiled and linked by Emscripten 6.0.10 (ADR-0001 decisions 9 and 11); `18.3.0` and
`18.6.0` were built by 3.1.74. The builder image `6.0.10-p1` is the emsdk image by digest, on Ubuntu 24.04 with apt
from a 2026-09-28 snapshot, and builds zlib 1.3.2, libxml2 2.15.4 and ICU 76.1. ICU moves only with a Postgres
major, never within one: a major recreates every store through its `dataFormat` change, so no store lives across
an ICU change, while inside a store's life a new ICU would change the collation versions `pg_collation` and
`pg_database` record, and could leave indexes on ICU collations silently wrong until they are reindexed. The
major's port regenerates the overlay's `minimal-icu` data with it.

**The browser floor.** Every link names Safari and iOS 18.4, Chrome 137 and Firefox 131
(`-sMIN_SAFARI_VERSION=180400 -sMIN_CHROME_VERSION=137 -sMIN_FIREFOX_VERSION=131`), the first releases with standard
wasm exceptions (exnref). `-sENVIRONMENT` stays `node,web,worker` (Bun runs the artefacts as node), and with it
Emscripten's own node floor, 18.3.0, which gates the features the browser floor allows (exnref, extended-const)
too: on 6.0.10 the three flags change no byte of the artefacts. setjmp and longjmp stay Emscripten's JavaScript
implementation (`-sSUPPORT_LONGJMP=emscripten`); wasm exceptions belong to the performance work.

**What the build sets for Emscripten 6**, so that it links what 3.1.74 linked (`build-pglite.sh` says why next to
each):

| Setting                                       | Why                                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-sFAKE_DYLIBS=1`, every link                 | 6.0.0 links a real shared library it finds for `-l` dynamically: libpq is also built as `libpq.so`, which initdb, pg_dump and libpqwalreceiver would load |
| `-sDEFAULT_TO_CXX=1`, every link              | Since 6.0.6 only em++ links C++'s runtime, and ICU is C++                                                                                                 |
| `-sUSE_PTHREADS=0`, every link                | Undoes the `-pthread` of libpq's links; deprecated, but nothing replaces its `=0`                                                                         |
| `-Wl,--no-export-dynamic`, pglite             | The backend link's `-Wl,--export-dynamic` (configure's `LDFLAGS_EX_BE`) comes last since 4.0.20, and exported all 9,649 symbols of the link               |
| `HEAP8`, `HEAPU8` exported, all three modules | 4.0.7 stopped exporting the heap views                                                                                                                    |
| `wasmMemory` an incoming option, pglite       | 6.0.2 dropped it from the default `INCOMING_MODULE_JS_API`; the hosts pass their own memory                                                               |
| `--pre-js pglite/scripts/loadBundleFirst.js`  | 4.0.7 runs `Module.preRun` in the order listed, so the file packager's loader, appended last, ran after the host's callbacks; it runs first again         |
| `-Dsocket=pgl_socket` (pglitec.c)             | 6.0's SOCKFS creates AF_INET sockets only, and libpq's default Unix socket failed (pg_dump could not connect); the descriptor is /dev/null's now          |

**What a host can rely on** (pgxsinkit's `@pgxsinkit/pgwasm-c` and `@pgxsinkit/pgwasm-pg-dump`, and this
repository's driver). The factories take `thisProgram`, `arguments`, `noExitRuntime`, `stdin`, `print`, `printErr`,
`instantiateWasm(imports, done)` and `preRun`, and `pglite.js` also `wasmMemory` and `getPreloadedPackage(name,
size)`. `pglite.data` is loaded before the first `preRun` callback, and the callbacks run in the order listed
(3.1.74 ran them in reverse). The modules expose `FS` (with MEMFS and PROXYFS, and in `pglite.js` NODEFS and IDBFS,
whose stores keep their format), `ENV`, `HEAP8`, `HEAPU8`, `callMain`, `addFunction`, `removeFunction`,
`UTF8ToString`, `stringToUTF8OnStack` and the exported functions. `pglite.wasm` imports its memory, while
`initdb.wasm` and `pg_dump.wasm` now define and export their own (a main module is no longer relocatable, since
4.0.19). An ERROR's intercepted siglongjmp still unwinds with `'unwind'`; a longjmp that escapes every setjmp throws
an instance of the glue's `EmscriptenSjLj` class, where 3.1.74 threw a number. pg_dump's libpq connects over its
default Unix socket as before, through `pgl_set_rw_cbs`.

The sizes against `18.6.0`:

| File           | 18.6.0 (bytes) | 18.6.1 (bytes) | Change            |
| -------------- | -------------: | -------------: | ----------------- |
| `pglite.wasm`  |     10,089,345 |      9,140,085 | −949,260 (−9.41%) |
| `pglite.data`  |      6,290,545 |      6,246,509 | −44,036 (−0.70%)  |
| `pglite.js`    |        380,859 |        335,082 | −45,777 (−12.02%) |
| `initdb.wasm`  |        395,467 |        298,938 | −96,529 (−24.41%) |
| `initdb.js`    |        109,978 |        106,390 | −3,588 (−3.26%)   |
| `pg_dump.wasm` |        703,947 |        655,066 | −48,881 (−6.94%)  |
| `pg_dump.js`   |        126,562 |        112,499 | −14,063 (−11.11%) |

`pglite.wasm`'s code is 520,355 bytes smaller and its data section 415,547: a main module that is not relocatable
addresses its data by constants rather than through `__memory_base` and the GOT, and places it at fixed addresses,
in 7,578 segments that leave out the zero runs of the one relocatable segment 3.1.74 wrote. `pg_dump.js` and the
three pgxs test programs in `pglite.data` no longer carry SOCKFS (`pgl_socket`). In `pglite.data` only the 28 core
modules, pgxs's `Makefile.global` (the flags) and those test programs changed; its other 667 files are
byte-identical, the timezone files among them.

## Scripts

| Script                    | Does                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `format` / `format:write` | oxfmt, check / write                                                                      |
| `lint` / `lint:fix`       | oxlint (type-aware), check / fix                                                          |
| `typecheck`               | TypeScript 7                                                                              |
| `test`                    | Unit tests (`bun test`)                                                                   |
| `check`                   | typecheck + lint + test                                                                   |
| `validate`                | format + check + `patches:check`: the pre-commit hook                                     |
| `validate:full`           | The same, for now: what `ci.yml` runs on pushes to develop and main and on pull requests  |
| `builder:image`           | Build the builder image from `builder/` and check its package set; `--push` publishes it  |
| `builder:lock`            | Show the published image's lock against `builder/`; record a publication                  |
| `build`                   | Build the materialised source in the builder image, with its manifest (in the gate)       |
| `build:verify`            | Check that a build reproduces another build's manifest (not in CI)                        |
| `exports:check`           | Diff a build's export list against `exported_functions.txt`; `--record` it (in the gate)  |
| `driver:smoke`            | Drive a build's artefacts: initdb, boot, a wire-protocol smoke test (in the gate)         |
| `prepopulated`            | Make the prepopulated data directory asset; `--check` it against its record (in the gate) |
| `data-format:check`       | Check a build's compatibility tuple against `data-format.json` (in the gate)              |
| `regress:bridge`          | Serve a build's backend over TCP to native clients (not in CI)                            |
| `regress`                 | Run pg_regress on a build and compare it with the baseline; `--record` it (in the gate)   |
| `gate`                    | The engine gate of HEAD, from clean, and the release it would publish (`gate.yml`)        |
| `bump`                    | Move the pin to a newer minor release: apply, re-export, commit, gate, report             |
| `readiness`               | Apply, build and regress the series on the next major's tag in a scratch copy; report     |
| `poll`                    | The weekly poll (`poll.yml`): a bump's pull request, the readiness issue; `--dry-run`     |
| `release:check`           | Refuse a tag that is not HEAD's candidate version (`release.yml`)                         |
| `release:gated`           | Download and check the gated build of a commit from `gate.yml` (`release.yml`)            |
| `release:publish`         | Require identical manifests, then create the GitHub release; `--dry-run` (`release.yml`)  |

## Versions and releases

Releases are tagged `<pg major>.<pg minor>.<revision>` (`18.3.0`, `18.3.1`, `18.6.0`, …); the tag is the
only version input, and `package.json`'s `0.0.0` is a placeholder. The build derives the version it embeds
(`scripts/lib/version.ts`): `<major>.<minor>.0` of the pinned upstream tag while there is no release tag,
the latest release tag's revision + 1 when that tag is of the pinned major.minor, and `<major>.<minor>.0`
otherwise. Only the tags of HEAD's strict ancestors count, so a tagged commit builds as its own tag, and tags
that are not `N.N.N` (`builder-sources-1`) are ignored; today the candidate is `18.6.1`. Releases are GitHub
release assets with a checksum manifest, not npm packages, made only by `release.yml` from the gated build (see
[The engine gate, CI and releases](#the-engine-gate-ci-and-releases)). History is linear: changes are rebased,
never merged, and main is fast-forwarded from the command line.

## License

The [PostgreSQL License](LICENSE). The patches and the overlay derive from PostgreSQL and from
ElectricSQL's `postgres-pglite`; see [NOTICE](NOTICE).
