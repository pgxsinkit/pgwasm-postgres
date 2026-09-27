import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { builderPaths, diffPackages, imageBuildCommand, sortedLines } from "../scripts/lib/builder.ts";
import { repoRoot } from "../scripts/lib/layout.ts";

describe("builder:image", () => {
  test("the image build is capped and checks the package set bytewise", () => {
    const command = imageBuildCommand(builderPaths("/repo/builder")).join(" ");
    expect(command).toContain("--format docker");
    expect(command).toContain("-v /repo/builder/bin/make:/usr/local/bin/gmake:ro");
    expect(command).toContain("-f /repo/builder/Containerfile -t localhost/pgwasm-postgres-builder:3.1.74-p1");
    const expected = readFileSync(join(repoRoot, "builder", "dpkg-expected.txt"), "utf8");
    expect(sortedLines(expected).join("\n")).toBe(expected.trimEnd());
    expect(sortedLines("b=1\nB=1\na=2\n")).toEqual(["B=1", "a=2", "b=1"]);
    expect(diffPackages(["a=1", "b=1"], ["a=1", "b=2"])).toEqual(["-b=1", "+b=2"]);
  });
});
