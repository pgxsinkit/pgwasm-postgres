import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GateManifest } from "../scripts/lib/gate.ts";
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

/** A gate manifest of 18.3.0 in the published builder image, with the given files. */
export function gateManifest(files: GateManifest["files"]): GateManifest {
  return {
    version: "18.3.0",
    commit: "1".repeat(40),
    tree: "2".repeat(40),
    sourceDateEpoch: 1_790_508_533,
    upstream: { tag: "REL_18_3", commit: "3".repeat(40) },
    dataFormat: 1,
    tuple: {
      pg_control_version: 1800,
      catalog_version_no: 202506291,
      maxAlign: 8,
      floatFormat: 1234567,
      blcksz: 8192,
      relseg_size: 131072,
      xlog_blcksz: 8192,
      nameDataLen: 64,
      indexMaxKeys: 32,
      toast_max_chunk_size: 1996,
      loblksize: 2048,
      float8ByVal: false,
      xlp_magic: "0xD118",
    },
    builder: {
      image: `ghcr.io/pgxsinkit/pgwasm-builder@sha256:${"4".repeat(64)}`,
      id: "5".repeat(64),
      digest: `sha256:${"4".repeat(64)}`,
      contentSha256: "6".repeat(64),
    },
    exports: { symbols: 1121, added: [], removed: [] },
    regress: {
      schedule: "parallel_schedule",
      baselineSha256: "7".repeat(64),
      tests: 230,
      passed: 178,
      failed: 49,
      unstable: 3,
      vanished: [],
    },
    files,
  };
}
