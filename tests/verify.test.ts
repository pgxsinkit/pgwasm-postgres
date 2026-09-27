import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  archiveMembers,
  formatReport,
  readArtefactRecord,
  verifyArtefacts,
  type ArtefactRecord,
  type MemberRecord,
} from "../scripts/lib/artefacts.ts";
import { readIdentities } from "../scripts/lib/config.ts";
import { layoutFor, repoRoot } from "../scripts/lib/layout.ts";
import { formatMode, readTar } from "../scripts/lib/tar.ts";
import { Fixtures, gnuTar, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

describe("tar reader", () => {
  const longName = `${"deep/".repeat(25)}file.txt`;

  function tree(dir: string): string {
    const root = join(dir, "tree");
    write(join(root, "lib", "x.so"), "binary\n", 0o755);
    write(join(root, "share", "x.sql"), "select 1;\n", 0o644);
    write(join(root, longName), "long\n", 0o600);
    symlinkSync("x.so", join(root, "lib", "link.so"));
    return root;
  }

  test.each(["gnu", "pax", "ustar"] as const)("lists every member of a %s archive", (format) => {
    const dir = fixtures.dir("tar");
    const root = tree(dir);
    if (format === "ustar") rmSync(join(root, "deep"), { recursive: true }); // ustar cannot hold a 133-byte name
    const members = readTar(gnuTar(root, join(dir, "a.tar.gz"), ["-cz", `--format=${format}`]));
    // GNU tar writes `./`-prefixed paths, and directories with a trailing slash.
    const byPath = new Map(members.map((member) => [member.path.replace(/^\.\//, ""), member]));

    const so = byPath.get("lib/x.so");
    expect(so?.type).toBe("file");
    expect(formatMode(so?.mode ?? 0)).toBe("0755");
    expect([so?.uid, so?.gid, so?.size]).toEqual([0, 0, 7]);
    expect(so?.sha256).toBe(new Bun.CryptoHasher("sha256").update("binary\n").digest("hex"));
    expect(formatMode(byPath.get("share/x.sql")?.mode ?? 0)).toBe("0644");
    expect(byPath.get("lib/link.so")).toMatchObject({ type: "symlink", linkname: "x.so", size: 0 });
    expect(byPath.get("lib/")?.type).toBe("directory");
    if (format !== "ustar") expect(byPath.get(longName)).toMatchObject({ type: "file", size: 5 });
  });

  test("rejects a corrupt header", () => {
    const dir = fixtures.dir("tar");
    const bytes = gnuTar(tree(dir), join(dir, "a.tar"), ["-c"]);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() => readTar(bytes)).toThrow(/bad header checksum/);
  });
});

/** A dist/ with two files and an archive, and the record that describes it exactly. */
function distFixture(): { dist: string; record: ArtefactRecord } {
  const dir = fixtures.dir("dist");
  const dist = join(dir, "dist");
  write(join(dist, "bin", "a.wasm"), "wasm\n");
  write(join(dist, "bin", "a.js"), "js\n");
  const staging = join(dir, "staging");
  write(join(staging, "lib", "ext.so"), "so\n", 0o755);
  write(join(staging, "share", "ext.control"), "control\n");
  mkdirSync(join(dist, "extensions"));
  const archive = gnuTar(staging, join(dist, "extensions", "ext.tar.gz"), ["-cz"]);
  const sha = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  return {
    dist,
    record: {
      file: "identity/test.json",
      tree: "0".repeat(40),
      build: { sourcePath: "/src", environment: {} },
      files: [
        { name: "a.wasm", path: "bin/a.wasm", bytes: 5, sha256: sha("wasm\n"), published: "test" },
        { name: "a.js", path: "bin/a.js", bytes: 3, sha256: sha("js\n"), published: "test" },
      ],
      archives: [
        {
          name: "ext.tar.gz",
          path: "extensions/ext.tar.gz",
          published: { bytes: 1, sha256: "f".repeat(64), from: "test" },
          members: archiveMembers(archive),
        },
      ],
    },
  };
}

function withMembers(
  record: ArtefactRecord,
  edit: (members: readonly MemberRecord[]) => MemberRecord[],
): ArtefactRecord {
  return { ...record, archives: record.archives.map((archive) => ({ ...archive, members: edit(archive.members) })) };
}

describe("build:verify", () => {
  test("a dist that matches the record passes", () => {
    const { dist, record } = distFixture();
    const result = verifyArtefacts(record, dist);
    expect(result.ok).toBe(true);
    // GNU tar records directories with a trailing slash.
    expect(record.archives[0]?.members.map((member) => member.path)).toEqual([
      "./",
      "./lib/",
      "./lib/ext.so",
      "./share/",
      "./share/ext.control",
    ]);
    const report = formatReport(result);
    expect(report.at(-1)).toBe("Byte identity holds: 2/2 files byte-identical; ext.tar.gz: 5/5 members identical.");
    expect(report.join("\n")).toContain("not compared: member mtimes and order are irreproducible");
  });

  test("changed, missing and unexpected files and members are reported", () => {
    const { dist, record } = distFixture();
    writeFileSync(join(dist, "bin", "a.js"), "JS\n");
    rmSync(join(dist, "bin", "a.wasm"));
    const edited = withMembers(record, (members) =>
      members
        .filter((member) => member.path !== "./share/")
        .map((member) => (member.path === "./lib/ext.so" ? { ...member, mode: "0644", uid: 1000 } : member))
        .concat([{ ...(members[0] as MemberRecord), path: "./gone" }]),
    );
    const result = verifyArtefacts(edited, dist);
    expect(result.ok).toBe(false);
    expect(result.files.map((file) => file.status)).toEqual(["MISSING", "MISMATCH"]);
    const status = new Map(result.archives[0]?.members.map((member) => [member.path, member]));
    expect(status.get("./lib/ext.so")).toMatchObject({ status: "MISMATCH", differences: ["mode", "uid"] });
    expect(status.get("./gone")?.status).toBe("MISSING");
    expect(status.get("./share/")?.status).toBe("UNEXPECTED");
    const report = formatReport(result).join("\n");
    expect(report).toContain("MISMATCH (mode, uid)");
    expect(report).toContain("Byte identity FAILED: 0/2 files byte-identical; ext.tar.gz: 3/5 members identical.");
  });

  test("a missing archive fails", () => {
    const { dist, record } = distFixture();
    rmSync(join(dist, "extensions"), { recursive: true });
    const result = verifyArtefacts(record, dist);
    expect(result.ok).toBe(false);
    expect(result.archives[0]?.status).toBe("MISSING");
  });
});

describe("the committed records", () => {
  const layout = layoutFor(repoRoot);

  test("the artefact record reads, and patches:check sees only the tree record", () => {
    const record = readArtefactRecord(layout);
    expect(record.files.map((file) => file.name)).toEqual([
      "pglite.wasm",
      "pglite.data",
      "pglite.js",
      "initdb.wasm",
      "initdb.js",
      "pg_dump.wasm",
      "pg_dump.js",
    ]);
    expect(record.archives.map((archive) => archive.name)).toEqual(["amcheck.tar.gz"]);
    expect(record.archives[0]?.members).toHaveLength(8);
    expect(readIdentities(layout).map((identity) => identity.file)).toEqual(["identity/b133782.json"]);
    expect(readIdentities(layout)[0]?.expectedTree).toBe(record.tree);
  });
});
