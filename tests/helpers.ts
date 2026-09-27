import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { repoRoot } from "../scripts/lib/layout.ts";

/**
 * Scratch directories for one test file, under the repository's tmp/ (gitignored), never the system temp
 * directory. Call `cleanup` from the file's `afterEach`.
 */
export class Fixtures {
  readonly #dirs: string[] = [];

  dir(name: string): string {
    mkdirSync(join(repoRoot, "tmp"), { recursive: true });
    const dir = mkdtempSync(join(repoRoot, "tmp", `test-${name}-`));
    this.#dirs.push(dir);
    return dir;
  }

  cleanup(): void {
    for (const dir of this.#dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
}

export function write(path: string, content: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

export function thrown(body: () => unknown): Error {
  try {
    body();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected the call to throw");
}

/** GNU tar with root ownership, as the builder image writes extension archives. Needs `tar` on the host. */
export function gnuTar(cwd: string, archive: string, args: readonly string[]): Uint8Array {
  const proc = Bun.spawnSync(["tar", "--owner=0", "--group=0", "--numeric-owner", ...args, "-f", archive, "."], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`tar failed: ${proc.stderr.toString()}`);
  return new Uint8Array(readFileSync(archive));
}
