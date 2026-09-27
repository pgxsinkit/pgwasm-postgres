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
  /** Identity records (decision 2): the tree (`patches:check`) and the artefacts (`build:verify`), while they exist. */
  readonly identityDir: string;
  /** The temporary manifest of the third-party extensions that were gitlinks in the source. */
  readonly extensionsFile: string;
  /** The byte-identity record `build:verify` checks the build's output against (decision 2). */
  readonly artefactsRecord: string;
  /** The builder image's definition (decision 9): its Containerfile and the `make` resource cap. */
  readonly builderDir: string;
  /** Gitignored: the upstream clone and scratch worktrees. */
  readonly cacheDir: string;
  /** The bare, shallow clone holding only the upstream tags fetched so far. */
  readonly cacheRepo: string;
  /** The bare, shallow clone holding the extension commits `extensions.json` pins. */
  readonly extensionsCache: string;
  /** Where `bun run build` works: the source, the log and `build.json`. Replaced by every build. */
  readonly buildDir: string;
  /** The materialised source the build runs in. */
  readonly buildSource: string;
  /** Its `dist/`: the build's output, mounted at `/pglite` in the builder. */
  readonly buildDist: string;
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
    extensionsFile: join(root, "extensions.json"),
    artefactsRecord: join(root, "identity", "0.5.8-artefacts.json"),
    builderDir: join(root, "builder"),
    cacheDir,
    cacheRepo: join(cacheDir, "upstream.git"),
    extensionsCache: join(cacheDir, "extensions.git"),
    buildDir,
    buildSource: join(buildDir, "postgres-pglite"),
    buildDist: join(buildDir, "postgres-pglite", "dist"),
    cacheGitConfig: join(cacheDir, "gitconfig"),
    workDir: join(root, "work"),
  };
}

export const repoRoot = resolve(import.meta.dir, "..", "..");
