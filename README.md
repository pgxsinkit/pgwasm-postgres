# pgwasm-postgres

PostgreSQL for WebAssembly, kept as a patch series on upstream PostgreSQL releases. This repository
holds the pin, the patches and the extra files that turn an upstream release into the source of the C
build; PostgreSQL's own source never enters its history. pgxsinkit's `@pgxsinkit/pgwasm-c` (and
`@pgxsinkit/pgwasm-pg-dump`) consume its releases.

The mechanics and the plan are in [ADR-0001](docs/adr/0001-postgres-as-a-patch-series.md).

## Status

The series is the split of ElectricSQL's PGlite fork (`electric-sql/postgres-pglite` at `b133782`, the
PostgreSQL 18.3 tree PGlite 0.5.8 was built from). `patches:check` proves that the pinned `REL_18_3` +
the patches + the overlay gives exactly that tree, without its extension submodules. `build` and
`build:verify` prove that the tree, with those extensions, builds PGlite 0.5.8's artefacts byte for byte
(2026-09-27). There is no release yet.

## Layout

| Path              | What                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `upstream.json`   | The pin: upstream repository, tag, and the commit the tag must resolve to                                    |
| `patches/`        | The series: `git format-patch` output, applied in order with `git am --3way`                                 |
| `overlay/`        | Files copied into the tree verbatim, mirroring tree paths; never patched                                     |
| `extensions.json` | Temporary: the nine third-party extensions `b133782` pins as submodules (path, URL, commit)                  |
| `identity/`       | Temporary: the identity records `patches:check` and `build:verify` check, until the first release (`18.3.0`) |
| `builder/`        | The builder image: its pinned `Containerfile`, the package set it must have, the `make -j` cap               |
| `scripts/`        | The Bun scripts below                                                                                        |
| `docs/adr/`       | Decisions                                                                                                    |

The source tree is the pinned tag, with the patches applied as commits and the overlay copied on top.
The overlay only adds files: an upstream file changes through a patch, and no patch touches an overlay
path.

The patches, one per topic:

| Patch                    | Files                                                                     | What                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `build-emscripten`       | `configure`, `.gitignore`, the three port files, ten makefiles            | The Emscripten port, the wasm link and install targets, the extension import lists, the version label           |
| `backend-single-process` | xlog.c, posix_sema.c, checkpointer.c, fd.c, miscinit.c, postinit.c, guc.c | One backend embedded in the host, without a postmaster or checkpointer process                                  |
| `startup-packet-export`  | backend_startup.c                                                         | `ProcessStartupPacket` callable by the host                                                                     |
| `encoding-shim`          | pg_dump.c, pg_backup_archiver.c, fe-exec.c                                | libpgcommon's encoding functions in the statically linked tools                                                 |
| `main-loop-unroll`       | postgres.c                                                                | PostgresMain's loop split into functions the host calls once per message exchange, plus the host's entry points |

## Working on the series

Requirements: git, [mise](https://mise.jdx.dev) (`mise install` installs the pinned Bun), and
`bun install` (which also installs the pre-commit hook).

```sh
bun run patches:check            # prove the series: apply, round-trip export, tree identity
bun run patches:work [<tag>]     # materialise work/<tag> with the series as commits
bun run patches:export [<tag>]   # write work/<tag>'s commits back to patches/
```

- **`patches:check`** fetches the pinned tag into `.cache/upstream.git` (a gitignored, shallow, bare
  clone; the first run needs the network, about 35 MB, and later runs take a couple of seconds
  offline), checks that the tag resolves to the pinned commit, applies every patch in a throwaway
  worktree with `git am --3way`, and copies the overlay in. It then checks that re-exporting the applied
  commits reproduces `patches/` byte for byte, writes the tree, and compares it with every
  `identity/*.json`. A failure names the patch, the rejected hunks and the conflicting lines, or the
  first differing line of a patch file, or the expected and actual trees. `bun run validate` runs it.
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

Requirements: podman (rootless is fine) on an amd64 host, the network on the first run, and about 6 GB
of free disk (the image is 2.8 GB; podman's layer cache and the 0.6 GB build tree take the rest).

```sh
bun run builder:image   # build the builder image from builder/ (about 40 min from scratch, seconds when cached)
bun run build           # build the source in it (about 15 min)
bun run build:verify    # check the artefacts against identity/0.5.8-artefacts.json
```

- **`builder:image`** builds `builder/Containerfile` with podman as
  `localhost/pgwasm-postgres-builder:3.1.74-p1`, capped at 4 CPUs and 16 GiB, with `builder/bin/make`
  turning every bare `make -j` into `make -j4`, then checks the image's packages against
  `builder/dpkg-expected.txt`. The log goes to `.cache/builder-image.log`.
- **`build`** runs `patches:check`, then checks the proven tree out into `.cache/build/postgres-pglite`
  (replacing the previous build) with the extensions of `extensions.json` at their commits (fetched once
  into `.cache/extensions.git`) and no `.git` anywhere, and runs the tree's `build-pglite.sh` in the builder
  image as ElectricSQL's CI ran it for 0.5.8: the source mounted at
  `/home/runner/_work/pglite/pglite/postgres-pglite` (the artefacts embed that path), `PGLITE_VERSION=0.5.8`
  and `DEBUG=false`, as root with umask 022 and no `TZ` or locale variables, under the same resource caps.
  The artefacts land in `.cache/build/postgres-pglite/dist/`, the log in `.cache/build/build.log`. It
  refuses to start without podman or the image, or while another `pgwasm-postgres-*` container exists.
- **`build:verify [<dist dir>]`** checks a `dist/` against `identity/0.5.8-artefacts.json`: the seven
  reproducible files (`pglite.wasm`, `pglite.data`, `pglite.js`, `initdb.wasm`, `initdb.js`,
  `pg_dump.wasm`, `pg_dump.js`) by size and sha256, and `amcheck.tar.gz` by its members (path, mode,
  owner, bytes), because its archive bytes carry the member mtimes and the directory order of the build,
  which nobody can reproduce. It prints a table and exits 1 on any mismatch.

None of them runs in `validate` or CI: they take too long, and the image is not published yet. Run
`build` and `build:verify` after changing anything that reaches the build: `builder/`, `extensions.json`,
the build scripts. A mismatch is diagnosed and fixed in the build, never by editing the record.

## Scripts

| Script                    | Does                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| `format` / `format:write` | oxfmt, check / write                                                   |
| `lint` / `lint:fix`       | oxlint (type-aware), check / fix                                       |
| `typecheck`               | TypeScript 7                                                           |
| `test`                    | Unit tests (`bun test`)                                                |
| `check`                   | typecheck + lint + test                                                |
| `validate`                | format + check + `patches:check`: the pre-commit hook                  |
| `validate:full`           | The same, for now: what CI runs on pushes to main and on pull requests |
| `builder:image`           | Build the builder image from `builder/` and check its package set      |
| `build`                   | Build the materialised source in the builder image (not in CI)         |
| `build:verify`            | Check a build's `dist/` against the byte-identity record (not in CI)   |

## Versions and releases

Releases are tagged `<pg major>.<pg minor>.<revision>` (`18.3.0`, `18.3.1`, `18.6.0`, …); the tag is the
only version input, and `package.json`'s `0.0.0` is a placeholder. Releases are GitHub release assets
with a checksum manifest, not npm packages. History is linear: changes are rebased, never merged.

## License

The [PostgreSQL License](LICENSE). The patches and the overlay derive from PostgreSQL and from
ElectricSQL's `postgres-pglite`; see [NOTICE](NOTICE).
