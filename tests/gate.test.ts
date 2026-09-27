import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  compareGateManifests,
  digestFiles,
  formatGateManifest,
  formatSums,
  GATE_MANIFEST,
  gateArtifact,
  gateSummary,
  parseGateManifest,
  readGateManifest,
  SUMS_FILE,
  symbolList,
  verifyGateDir,
  type GateManifest,
} from "../scripts/lib/gate.ts";
import { UserError } from "../scripts/lib/git.ts";
import { sha256Of } from "../scripts/lib/manifest.ts";
import { Fixtures, gateManifest, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

const NAMES = ["pglite.wasm", "pglite.data", "amcheck.tar.gz", "exported_functions.txt", "prepopulated.tar.gz"];

/** A gate directory as `bun run gate` writes it. */
function gateFixture(): { dir: string; manifest: GateManifest } {
  const dir = fixtures.dir("gate");
  for (const name of NAMES) write(join(dir, name), `${name}\n`);
  const manifest = gateManifest(digestFiles(dir, NAMES));
  writeFileSync(join(dir, GATE_MANIFEST), formatGateManifest(manifest));
  writeFileSync(join(dir, SUMS_FILE), formatSums(digestFiles(dir, [...NAMES, GATE_MANIFEST])));
  return { dir, manifest };
}

describe("the gate directory", () => {
  test("its manifest lists every file by name, round-trips, and SHA256SUMS is sha256sum's format", () => {
    const { dir, manifest } = gateFixture();
    expect(manifest.files.map((file) => file.name)).toEqual([
      "amcheck.tar.gz",
      "exported_functions.txt",
      "pglite.data",
      "pglite.wasm",
      "prepopulated.tar.gz",
    ]);
    expect(manifest.files[0]).toEqual({
      name: "amcheck.tar.gz",
      bytes: 15,
      sha256: sha256Of(new TextEncoder().encode("amcheck.tar.gz\n")),
    });
    expect(readGateManifest(dir, dir)).toEqual(manifest);
    expect(formatSums(manifest.files).split("\n")[0]).toBe(`${manifest.files[0]?.sha256}  amcheck.tar.gz`);
    expect(verifyGateDir(dir, manifest)).toEqual([]);
    expect(gateArtifact(manifest.commit)).toBe(`gate-${"1".repeat(40)}`);
    // `sha256sum -c` agrees (coreutils on the host).
    const check = Bun.spawnSync(["sha256sum", "--check", "--strict", SUMS_FILE], { cwd: dir, stdout: "pipe" });
    expect(check.exitCode).toBe(0);
  });

  test("verification finds a changed, missing or extra file, a subdirectory and a stale SHA256SUMS", () => {
    const { dir, manifest } = gateFixture();
    writeFileSync(join(dir, "pglite.wasm"), "tampered\n");
    rmSync(join(dir, "pglite.data"));
    write(join(dir, "extra.txt"), "extra\n");
    mkdirSync(join(dir, "sub"));
    const problems = verifyGateDir(dir, manifest);
    expect(problems).toContain("pglite.data is missing");
    expect(problems).toContain("extra.txt is not in the manifest");
    expect(problems).toContain("sub is not a file");
    expect(problems.find((line) => line.startsWith("pglite.wasm is 9 bytes"))).toBeDefined();

    const clean = gateFixture();
    writeFileSync(join(clean.dir, SUMS_FILE), "");
    expect(verifyGateDir(clean.dir, clean.manifest)).toEqual([
      `${SUMS_FILE} is not the sha256 list of the directory's files`,
    ]);
  });

  test("a manifest must have its fields", () => {
    const { manifest } = gateFixture();
    const json = JSON.parse(formatGateManifest(manifest)) as Record<string, unknown>;
    expect(parseGateManifest(json, "m")).toEqual(manifest);
    const bad = (patch: Record<string, unknown>): Error => thrown(() => parseGateManifest({ ...json, ...patch }, "m"));
    expect(bad({ version: "v18.3.0" })).toBeInstanceOf(UserError);
    expect(bad({ tuple: { pg_control_version: 1800 } }).message).toContain("tuple");
    expect(bad({ files: [{ name: "a/b", bytes: 1, sha256: "0".repeat(64) }] }).message).toContain("files[0].name");
    expect(bad({ builder: { ...manifest.builder, digest: "latest" } }).message).toContain("builder.digest");
    expect(
      parseGateManifest({ ...json, builder: { ...manifest.builder, digest: null } }, "m").builder.digest,
    ).toBeNull();
  });
});

describe("comparing gate manifests", () => {
  test("identical manifests have no difference, and every difference is named", () => {
    const { manifest } = gateFixture();
    expect(compareGateManifests(manifest, structuredClone(manifest))).toEqual([]);
    const [first, second, ...rest] = manifest.files;
    if (first === undefined || second === undefined) throw new Error("fixture");
    const other: GateManifest = {
      ...manifest,
      sourceDateEpoch: manifest.sourceDateEpoch + 1,
      builder: { ...manifest.builder, digest: null },
      regress: { ...manifest.regress, vanished: ["json"] },
      files: [{ ...first, sha256: "0".repeat(64) }, ...rest, { name: "new.txt", bytes: 1, sha256: "9".repeat(64) }],
    };
    const differences = compareGateManifests(manifest, other);
    expect(differences).toEqual([
      `builder.digest: "sha256:${"4".repeat(64)}" → null`,
      'regress.vanished: [] → ["json"]',
      "sourceDateEpoch: 1790508533 → 1790508534",
      `files: amcheck.tar.gz: 15 bytes, ${first.sha256} → 15 bytes, ${"0".repeat(64)}`,
      `files: ${second.name} is missing`,
      "files: new.txt is new",
    ]);
  });

  test("the job summary shows the files, the data format, pg_regress and the builder", () => {
    const { manifest } = gateFixture();
    const summary = gateSummary({ ...manifest, exports: { symbols: 1121, added: ["_a"], removed: [] } });
    expect(summary).toContain("### Engine gate passed: pgwasm-postgres 18.3.0 at `111111111111`");
    expect(summary).toContain(
      `| \`pglite.wasm\` | 12 | \`${manifest.files.find((file) => file.name === "pglite.wasm")?.sha256}\` |`,
    );
    expect(summary).toContain(
      "dataFormat 1: pg_control_version 1800, catalog_version_no 202506291, WAL page magic 0xD118",
    );
    expect(summary).toContain("230 tests, 178 pass, 49 fail as the baseline records, 3 unstable");
    expect(summary).toContain("1,121 symbols; against `exported_functions.txt` at the commit: 1 added (`_a`)");
    expect(summary).toContain("the published image by digest");
    expect(symbolList(["_a", "_b", "_c"], 2)).toBe("`_a` `_b` and 1 more");
  });
});
