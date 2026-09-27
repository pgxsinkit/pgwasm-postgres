# pgwasm-postgres Agent Instructions

PostgreSQL for WebAssembly as a patch series: `upstream.json` pins an upstream release, `patches/` is
`git format-patch` output applied with `git am --3way`, and `overlay/` holds files copied into the tree
verbatim. PostgreSQL's source never enters this repository's history. pgxsinkit's `@pgxsinkit/pgwasm-c`
consumes the releases. Read [README.md](README.md) and
[docs/adr/0001](docs/adr/0001-postgres-as-a-patch-series.md) before changing anything.

## Release, versioning & tooling standard

- **Scripts are check-default.** `bun run format` and `bun run lint` check; `format:write` and
  `lint:fix` change files. `bun run validate` (format, typecheck, lint, unit tests, `patches:check`) is
  the pre-commit hook, installed by `bun install` through `prepare`, and must pass before every commit.
  `bun run validate:full` is what `ci.yml` runs; `gate.yml` runs the engine gate (`bun run gate --lock`) on
  every pull request and every push to develop and main.
- **Tags are the only version input.** Releases are tagged `<pg major>.<pg minor>.<revision>` (`18.3.0`),
  unprefixed. `package.json` keeps `"version": "0.0.0"`; never hand-edit a version anywhere.
- **Releases are GitHub release assets**, never npm packages, made only by `release.yml` from a pushed tag
  `N.N.N`: the tag must be the commit's candidate version, the commit must have passed `gate.yml` (tag only
  after it did, and after main is fast-forwarded to it), and the release is the gated build, byte for byte.
  Never create a release by hand.
- **Rebase, never merge.** History is linear. PRs are for review; main is fast-forwarded from the command
  line. Never push, tag or publish unless the maintainer asks for that specific step.

## Tools

- **Bun only.** Never use the `npm` CLI for anything. Run tools through `bun run <script>`, not directly.
- **podman only**, never docker. The build is `bun run build` in the image `builder/` defines (ADR-0001
  decision 9), published as `ghcr.io/pgxsinkit/pgwasm-builder` by `builder-image.yml` and pinned by digest in
  `builder/image.lock.json`, which changes only through `bun run builder:lock`, never by hand. A change to
  `builder/` is a new image tag (`-p3`: `BUILDER_IMAGE` in `scripts/lib/builder.ts` and the Containerfile's
  header): a published tag is never pushed again with other content. Never push an image unless the maintainer
  asks for that step. Every container this repository starts is named `pgwasm-postgres-*` and started with
  `--rm`; never remove, retag or prune an image or container this repository did not create, and never run
  `podman system prune` or `podman image prune`.
- **mise** pins the toolchain (`mise.toml`).
- **Latest versions, always.** Every dependency and tool goes in at its latest published version,
  verified with a real command (`bun info <pkg> version`, `mise latest <tool>`). A non-latest pin needs a
  demonstrated reason in a comment next to it (the builder image's pins are the documented exception:
  Emscripten 3.1.74 until its own release, and the libraries at 0.5.8's versions).
- **TypeScript (Bun) for scripts**, strict, covered by `bun run typecheck`; bash only where TypeScript
  cannot be made robust. oxlint and oxfmt; never eslint, prettier or biome.

## The series

- **Never edit `patches/` by hand.** Change it with `bun run patches:work`, commits in `work/<tag>`,
  then `bun run patches:export` and `bun run patches:check`. A hand edit fails `patches:check`.
- **Patch commits are content.** Subject `<topic>: <summary>`, a body saying what and why, and for
  derived patches a provenance line naming the source commit. No AI or tool trailers in them.
- **The overlay only adds files.** Edit overlay files in `overlay/`. An upstream file changes through a
  patch; a patch never touches an overlay path (`patches:check` and `patches:export` refuse it).
- **The build is reproducible, and gated in CI.** `bun run gate` (about 12 minutes: `build`,
  `driver:smoke`, `exports:check`, `data-format:check`, `prepopulated` and `prepopulated --check`,
  `regress`) is what `gate.yml` runs, not `validate`; it gates a commit, so it refuses a working tree with
  changes. Run it after committing any change that reaches the build (`builder/`, `patches/`, `overlay/`,
  the build and driver scripts), and never while another `pgwasm-postgres-*` container runs. Two gates of one
  commit give identical `manifest.json`s, and the release job requires that; anything in the gate's manifest
  that varies between two runs is a defect. Two builds of one commit, from any checkout, must give identical
  manifests (`bun run build:verify <manifest>`); a difference is diagnosed in the build. Build only what ships: a new contrib module is a `PGLITE_CONTRIB`
  entry and a release. Run long builds in the background and wait on the process, never with a long fixed
  `sleep`.
- **The export list has a reference.** `exported_functions.txt` changes only through
  `bun run exports:check --record`, after a deliberate change that is reviewed in its diff; a core symbol
  (one of `overlay/pglite/static/included.pglite.exports`) must never go missing.
- **The driver's scripts need a build too.** `bun run driver:smoke`, `bun run prepopulated --check` and
  `bun run data-format:check` are not in `validate`; the gate runs them, so a change that reaches the build
  or `scripts/lib/driver/` must keep them passing. `identity/prepopulated.json` changes only through
  `prepopulated --record`, after a deliberate build change. `data-format.json` changes only by declaring a new `dataFormat` with its new
  tuple, never by editing the current one to match a build.
- **So does the pg_regress gate.** `bun run regress` (a build, podman and the builder image; about two
  minutes a run) is not in `validate`; the gate runs it. Run it after any change that reaches the build or
  `scripts/lib/driver/`, and never while another `pgwasm-postgres-*` container runs. `regress/baseline.json`'s
  results and `regress/diffs/` change only through `bun run regress --record`, after a deliberate change;
  never edit a diff by hand. The failure groups are written by hand: every failing or unstable test needs a
  group with a reason, and `bun test` refuses `unclassified`. An unstable test is recorded with its reason,
  never tolerated silently: a gate that fails on a changed diff that is not a change of the build is a test
  whose instability the record missed, recorded with `--record` over enough runs to show it (8 found
  subscription's, 4 had not). The gate's bridge runs on a raised native stack (256 MiB); keep it raised.
- Never commit PostgreSQL source, build outputs or the contents of `.cache/` or `work/`.

## Directory hygiene

- Scratch files, logs and one-off scripts go under `tmp/agents/` (gitignored), never anywhere else:
  not the repository root, not the system `/tmp`, and never redirect to `/dev/null`.
- If a scratch file lands in the wrong place, move or delete it before doing anything else.
- No long fixed `sleep N` waits: wait on the process itself, or poll briefly.
