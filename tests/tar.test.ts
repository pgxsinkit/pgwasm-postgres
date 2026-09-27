import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

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
