import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { gitTree, UserError } from "./git.ts";
import type { Layout } from "./layout.ts";

/** Git's tree modes: tree identity includes them, so the executable bit and symlinks must survive. */
export type OverlayMode = "100644" | "100755" | "120000";

export interface OverlayEntry {
  /** Path relative to the overlay root and to the tree, with `/` separators. */
  readonly path: string;
  readonly mode: OverlayMode;
}

/** Every file and symlink under `overlayDir`, in git's (byte-wise) path order. */
export function listOverlay(overlayDir: string): OverlayEntry[] {
  const entries: OverlayEntry[] = [];
  const walk = (relativeDir: string): void => {
    for (const name of readdirSync(join(overlayDir, relativeDir))) {
      const path = relativeDir === "" ? name : `${relativeDir}/${name}`;
      if (name === ".git") throw new UserError(`overlay/${path}: a .git entry cannot be part of the overlay.`);
      const stat = lstatSync(join(overlayDir, path));
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) entries.push({ path, mode: "120000" });
      else if (stat.isFile()) entries.push({ path, mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644" });
      else throw new UserError(`overlay/${path}: only regular files, directories and symlinks can be overlaid.`);
    }
  };
  walk("");
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Copies the overlay into a tree, replacing whatever is at each path, with git's modes (0644/0755). */
export function copyOverlay(overlayDir: string, entries: readonly OverlayEntry[], destination: string): void {
  for (const entry of entries) {
    const source = join(overlayDir, entry.path);
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    if (entry.mode === "120000") {
      symlinkSync(readlinkSync(source), target);
    } else {
      copyFileSync(source, target);
      chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
}

/**
 * Stages the overlay's exact bytes and modes in a worktree's index. `hash-object --no-filters` and
 * `update-index --index-info` bypass `.gitignore` (upstream's patched one ignores `*.js`) and any
 * `.gitattributes` conversion, so the staged tree is byte for byte what the overlay holds.
 */
export function stageOverlay(layout: Layout, worktree: string, entries: readonly OverlayEntry[]): void {
  const files = entries.filter((entry) => entry.mode !== "120000");
  const fileBlobs =
    files.length === 0
      ? []
      : gitTree(layout, worktree, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
          stdin: files.map((entry) => `${entry.path}\n`).join(""),
        })
          .stdout.trim()
          .split("\n");
  const blobs = new Map(files.map((entry, index) => [entry.path, fileBlobs[index]]));
  for (const entry of entries) {
    if (entry.mode !== "120000") continue;
    const target = readlinkSync(join(worktree, entry.path));
    blobs.set(entry.path, gitTree(layout, worktree, ["hash-object", "-w", "--stdin"], { stdin: target }).stdout.trim());
  }
  const indexInfo = entries.map((entry) => {
    const blob = blobs.get(entry.path);
    if (blob === undefined || !/^[0-9a-f]{40}$/.test(blob)) {
      throw new Error(`Could not hash overlay file ${entry.path} (got ${JSON.stringify(blob)}).`);
    }
    return `${entry.mode} ${blob}\t${entry.path}\n`;
  });
  gitTree(layout, worktree, ["update-index", "--add", "--index-info"], { stdin: indexInfo.join("") });
}
