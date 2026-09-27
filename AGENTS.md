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
  `bun run validate:full` is what CI runs.
- **Tags are the only version input.** Releases are tagged `<pg major>.<pg minor>.<revision>` (`18.3.0`),
  unprefixed. `package.json` keeps `"version": "0.0.0"`; never hand-edit a version anywhere.
- **Releases are GitHub release assets**, never npm packages.
- **Rebase, never merge.** History is linear. PRs are for review; main is fast-forwarded from the command
  line. Never push, tag or publish unless the maintainer asks for that specific step.

## Tools

- **Bun only.** Never use the `npm` CLI for anything. Run tools through `bun run <script>`, not directly.
- **podman only**, never docker. (The overlay's `build-with-docker.sh` is ElectricSQL's, carried
  verbatim for tree identity; it changes after byte identity, see ADR-0001.)
- **mise** pins the toolchain (`mise.toml`).
- **Latest versions, always.** Every dependency and tool goes in at its latest published version,
  verified with a real command (`bun info <pkg> version`, `mise latest <tool>`). A non-latest pin needs a
  demonstrated reason in a comment next to it (Emscripten 3.1.74 until `18.3.0` is one).
- **TypeScript (Bun) for scripts**, strict, covered by `bun run typecheck`; bash only where TypeScript
  cannot be made robust. oxlint and oxfmt; never eslint, prettier or biome.

## The series

- **Never edit `patches/` by hand.** Change it with `bun run patches:work`, commits in `work/<tag>`,
  then `bun run patches:export` and `bun run patches:check`. A hand edit fails `patches:check`.
- **Patch commits are content.** Subject `<topic>: <summary>`, a body saying what and why, and for
  derived patches a provenance line naming the source commit. No AI or tool trailers in them.
- **The overlay only adds files.** Edit overlay files in `overlay/`. An upstream file changes through a
  patch; a patch never touches an overlay path (`patches:check` and `patches:export` refuse it).
- **Until `18.3.0`, tree identity must hold** (`identity/b133782.json`): the patches and overlay stay
  exactly ElectricSQL's, oddities included. No cleanups before then, however obvious.
- Never commit PostgreSQL source, build outputs or the contents of `.cache/` or `work/`.

## Directory hygiene

- Scratch files, logs and one-off scripts go under `tmp/agents/` (gitignored), never anywhere else:
  not the repository root, not the system `/tmp`, and never redirect to `/dev/null`.
- If a scratch file lands in the wrong place, move or delete it before doing anything else.
- No long fixed `sleep N` waits: wait on the process itself, or poll briefly.
