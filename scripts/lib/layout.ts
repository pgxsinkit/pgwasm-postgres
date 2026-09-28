import { join, resolve } from "node:path";

/** Where everything lives, relative to a repository root (the real one, or a test fixture). */
export interface Layout {
  readonly root: string;
  /** The upstream pin: repository URL, tag and the commit the tag must resolve to. */
  readonly upstreamFile: string;
  /** `git format-patch` output, applied in file-name order with `git am --3way`. */
  readonly patchesDir: string;
  /** Files copied into the tree verbatim, mirroring tree paths. Never patched. */
  readonly overlayDir: string;
  /** Identity records: the prepopulated data directory's (decision 10). */
  readonly identityDir: string;
  /** The reference export list `exports:check` diffs a build's against (decision 6). */
  readonly exportsReference: string;
  /** The record of the prepopulated data directory `prepopulated --check` reproduces (decision 10). */
  readonly prepopulatedRecord: string;
  /** The declared data format and its compatibility tuple (decision 8). */
  readonly dataFormatFile: string;
  /** The builder image's definition (decision 9): its Containerfile and the `make` resource cap. */
  readonly builderDir: string;
  /** The pg_regress baseline (decision 6): the results and the failure groups. */
  readonly regressBaseline: string;
  /** The baseline's normalised diffs, one per failing test. */
  readonly regressDiffsDir: string;
  /** Gitignored: the native pg_regress and psql per upstream tag, and the runs' output. */
  readonly regressCache: string;
  /** Gitignored: the upstream clone and scratch worktrees. */
  readonly cacheDir: string;
  /** The bare, shallow clone holding only the upstream tags fetched so far. */
  readonly cacheRepo: string;
  /** Where `bun run build` works: the source, the log and `build.json`. Replaced by every build. */
  readonly buildDir: string;
  /** The materialised source the build runs in. */
  readonly buildSource: string;
  /** Its `dist/`: the build's output and its `manifest.json`, mounted at `/pgwasm` in the builder. */
  readonly buildDist: string;
  /** Where `bun run prepopulated` writes the asset by default. */
  readonly prepopulatedAsset: string;
  /** The git config every command against the cache runs with (the user's global config is not read). */
  readonly cacheGitConfig: string;
  /** Gitignored: `patches:work` worktrees, one per upstream tag. */
  readonly workDir: string;
}

export function layoutFor(root: string): Layout {
  const cacheDir = join(root, ".cache");
  const buildDir = join(cacheDir, "build");
  return {
    root,
    upstreamFile: join(root, "upstream.json"),
    patchesDir: join(root, "patches"),
    overlayDir: join(root, "overlay"),
    identityDir: join(root, "identity"),
    exportsReference: join(root, "exported_functions.txt"),
    prepopulatedRecord: join(root, "identity", "prepopulated.json"),
    dataFormatFile: join(root, "data-format.json"),
    builderDir: join(root, "builder"),
    regressBaseline: join(root, "regress", "baseline.json"),
    regressDiffsDir: join(root, "regress", "diffs"),
    regressCache: join(cacheDir, "regress"),
    cacheDir,
    cacheRepo: join(cacheDir, "upstream.git"),
    buildDir,
    buildSource: join(buildDir, "postgres-pglite"),
    buildDist: join(buildDir, "postgres-pglite", "dist"),
    prepopulatedAsset: join(cacheDir, "prepopulated", "prepopulated.tar.gz"),
    cacheGitConfig: join(cacheDir, "gitconfig"),
    workDir: join(root, "work"),
  };
}

export const repoRoot = resolve(import.meta.dir, "..", "..");
