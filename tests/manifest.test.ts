import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  artefactPaths,
  compareBuild,
  digestArtefacts,
  formatComparison,
  formatManifest,
  MANIFEST_FILE,
  readManifest,
  RELEASE_FILES,
  type BuildManifest,
} from "../scripts/lib/manifest.ts";
import { Fixtures, gnuTar, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

/** A dist/ with every release file and one extension archive, and a manifest that describes it. */
function distFixture(): { dir: string; dist: string; manifest: BuildManifest } {
  const dir = fixtures.dir("dist");
  const dist = join(dir, "dist");
  for (const path of RELEASE_FILES) write(join(dist, path), `${path}\n`);
  write(join(dist, "bin", "psql.js"), "not a release file\n");
  // The build tree's own postgres target, installed by `make install`: not the backend's glue.
  write(join(dist, "bin", "postgres.js"), "not a release file either\n");
  const staging = join(dir, "staging");
  write(join(staging, "lib", "postgresql", "ext.so"), "so\n", 0o755);
  mkdirSync(join(dist, "extensions"));
  gnuTar(staging, join(dist, "extensions", "ext.tar.gz"), ["-cz"]);
  return { dir, dist, manifest: manifestOf(dist) };
}

function manifestOf(dist: string): BuildManifest {
  return {
    version: "18.3.0",
    upstream: { tag: "REL_18_3", commit: "1".repeat(40) },
    commit: "2".repeat(40),
    worktreeClean: true,
    tree: "3".repeat(40),
    sourceDateEpoch: 1_790_000_000,
    debug: false,
    builder: { image: "localhost/pgwasm-postgres-builder:3.1.74-p2", id: "4".repeat(64) },
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
    artefacts: digestArtefacts(dist),
  };
}

describe("the build manifest", () => {
  test("lists the release files and the extension archives, and round-trips through its JSON", () => {
    const { dir, dist, manifest } = distFixture();
    expect(artefactPaths(dist)).toEqual([...RELEASE_FILES, "extensions/ext.tar.gz"].sort());
    expect(manifest.artefacts.find((artefact) => artefact.path === "pgwasm/postgres.wasm")).toEqual({
      path: "pgwasm/postgres.wasm",
      bytes: 21,
      sha256: new Bun.CryptoHasher("sha256").update("pgwasm/postgres.wasm\n").digest("hex"),
    });
    const file = join(dist, MANIFEST_FILE);
    writeFileSync(file, formatManifest(manifest));
    expect(readManifest(file, dir)).toEqual(manifest);
    rmSync(join(dist, "bin", "pg_dump.js"));
    expect(thrown(() => artefactPaths(dist)).message).toContain("lacks bin/pg_dump.js");
  });

  test("a build that reproduces the manifest passes, and every difference is reported", () => {
    const { dist, manifest } = distFixture();
    const same = compareBuild(manifest, manifest);
    expect(same.ok).toBe(true);
    expect(formatComparison(same).at(-1)).toBe("Reproduced: 9/9 artefacts identical.");
    // Another commit or image with the same bytes still reproduces; only the notes say so.
    const moved = compareBuild(manifest, { ...manifest, commit: "5".repeat(40) });
    expect(moved.ok).toBe(true);
    expect(moved.notes[0]).toContain("commit");

    writeFileSync(join(dist, "pgwasm", "postgres.js"), "changed\n");
    rmSync(join(dist, "exported_functions.txt"));
    write(join(dist, "exported_functions.txt"), "exported_functions.txt\n");
    write(join(dist, "extensions", "more.tar.gz"), "more\n");
    const changed = compareBuild(manifest, { ...manifest, version: "18.3.1", artefacts: digestArtefacts(dist) });
    expect(changed.ok).toBe(false);
    const status = new Map(changed.artefacts.map((artefact) => [artefact.path, artefact.status]));
    expect(status.get("pgwasm/postgres.js")).toBe("DIFFERENT");
    expect(status.get("exported_functions.txt")).toBe("identical");
    expect(status.get("extensions/more.tar.gz")).toBe("UNEXPECTED");
    const report = formatComparison(changed).join("\n");
    expect(report).toContain('version: "18.3.1", the manifest has "18.3.0"');
    expect(report).toContain("NOT reproduced: 8/10 artefacts identical; version differ.");
  });
});
