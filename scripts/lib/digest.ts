/**
 * Content digests of files and directory trees, for the records that say what something was made from: the
 * builder image's lock (the content of `builder/` it was built from) and the gate's manifest (the pg_regress
 * baseline it passed against).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { UserError } from "./git.ts";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One entry of a tree, as {@link treeDigest} hashes it. */
export interface TreeEntry {
  /** Relative to the tree's root, `/`-separated. */
  readonly path: string;
  /** Git's modes: `100644`, `100755` (any execute bit) or `120000` (a symbolic link). */
  readonly mode: "100644" | "100755" | "120000";
  /** The sha256 of the file's bytes, or of a link's target. */
  readonly sha256: string;
}

const byPath = (a: TreeEntry, b: TreeEntry): number => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));

/**
 * The digest of a tree: the sha256 of one `<mode> <sha256> <path>` line per entry, sorted bytewise by path. It
 * depends only on the paths, the contents and whether a file is executable (what git records), never on mtimes,
 * owners or the order the filesystem lists a directory in.
 */
export function treeDigest(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort(byPath);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]?.path === sorted[index - 1]?.path) throw new Error(`treeDigest: ${sorted[index]?.path} twice`);
  }
  return sha256Hex(sorted.map((entry) => `${entry.mode} ${entry.sha256} ${entry.path}\n`).join(""));
}

/**
 * Every file and symbolic link under `dir`, recursively, except the paths `exclude` names (relative, `/`-separated),
 * sorted bytewise by path. A directory contributes only its files: an empty directory changes nothing.
 */
export function treeEntries(dir: string, exclude: readonly string[] = []): TreeEntry[] {
  if (!existsSync(dir)) throw new UserError(`${dir} does not exist.`);
  const skip = new Set(exclude);
  const entries: TreeEntry[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(dir, relative))) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (skip.has(path)) continue;
      const full = join(dir, path);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) entries.push({ path, mode: "120000", sha256: sha256Hex(readlinkSync(full)) });
      else if (stat.isFile()) {
        const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
        entries.push({ path, mode, sha256: sha256Hex(new Uint8Array(readFileSync(full))) });
      } else throw new UserError(`${full} is neither a file, a directory nor a symbolic link.`);
    }
  };
  walk("");
  return entries.sort(byPath);
}

/** {@link treeDigest} of a directory on disk. */
export function directoryDigest(dir: string, exclude: readonly string[] = []): string {
  return treeDigest(treeEntries(dir, exclude));
}
