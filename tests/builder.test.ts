import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BUILDER_IMAGE, builderPaths, diffPackages, imageBuildCommand, sortedLines } from "../scripts/lib/builder.ts";
import { repoRoot } from "../scripts/lib/layout.ts";

describe("builder:image", () => {
  test("the image build is capped and checks the package set bytewise", () => {
    const command = imageBuildCommand(builderPaths("/repo/builder")).join(" ");
    expect(command).toContain("--format docker");
    expect(command).toContain("-v /repo/builder/bin/make:/usr/local/bin/gmake:ro");
    expect(command).toContain("-f /repo/builder/Containerfile -t localhost/pgwasm-postgres-builder:3.1.74-p2");
    const expected = readFileSync(join(repoRoot, "builder", "dpkg-expected.txt"), "utf8");
    expect(sortedLines(expected).join("\n")).toBe(expected.trimEnd());
    expect(sortedLines("b=1\nB=1\na=2\n")).toEqual(["B=1", "a=2", "b=1"]);
    expect(diffPackages(["a=1", "b=1"], ["a=1", "b=2"])).toEqual(["-b=1", "+b=2"]);
  });

  test("the image build leaves out the caps podman cannot apply", () => {
    const paths = builderPaths("/repo/builder");
    const none = imageBuildCommand(paths, BUILDER_IMAGE, { cpu: false, memory: false }).join(" ");
    expect(none).toContain("--layers --force-rm -v /repo/builder/bin/make:/usr/local/bin/make:ro");
    const full = imageBuildCommand(paths).join(" ");
    expect(full).toContain("--force-rm --cpu-period 100000 --cpu-quota 400000 --memory 16g -v");
  });
});
