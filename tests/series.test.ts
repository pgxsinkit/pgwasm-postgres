import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { checkSeries, exportSeries, workSeries } from "../scripts/lib/commands.ts";
import { git, UserError } from "../scripts/lib/git.ts";
import { layoutFor, repoRoot, type Layout } from "../scripts/lib/layout.ts";
import { findConflictRegions, listPatches, parseRejectedHunks } from "../scripts/lib/series.ts";

// A miniature upstream (a git repo with tags) and a miniature pgwasm-postgres root, under the repo's tmp/.
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly dir: string;
  readonly upstream: string;
  readonly layout: Layout;
  readonly env: Record<string, string>;
}

const quiet = (): void => {};

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

function makeFixture(): Fixture {
  mkdirSync(join(repoRoot, "tmp"), { recursive: true });
  const dir = mkdtempSync(join(repoRoot, "tmp", "test-series-"));
  fixtures.push(dir);
  writeFileSync(join(dir, "gitconfig"), "");
  const env = {
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.invalid",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
  };

  const upstream = join(dir, "upstream");
  mkdirSync(upstream);
  git(["init", "--quiet", "--initial-branch=main"], { cwd: upstream, env });
  write(join(upstream, ".gitignore"), "*.js\n");
  write(join(upstream, "src", "a.c"), ["int a(void)", "{", "\treturn 1;", "}", ""].join("\n"));
  write(join(upstream, "src", "b.c"), "int b;\n");
  git(["add", "-A"], { cwd: upstream, env });
  git(["commit", "--quiet", "-m", "Base"], { cwd: upstream, env });
  git(["tag", "v1"], { cwd: upstream, env });
  const commit = git(["rev-parse", "HEAD"], { cwd: upstream, env }).stdout.trim();

  const root = join(dir, "root");
  write(join(root, "upstream.json"), JSON.stringify({ repository: `file://${upstream}`, tag: "v1", commit }, null, 2));
  write(join(root, "overlay", "tools", "run.sh"), "#!/bin/sh\necho run\n", 0o755);
  write(join(root, "overlay", "tools", "data.txt"), "data\n");
  write(join(root, "overlay", "tools", "glue.js"), "export {};\n");
  symlinkSync("data.txt", join(root, "overlay", "tools", "link"));
  mkdirSync(join(root, "patches"));
  return { dir, upstream, layout: layoutFor(root), env };
}

/** Commits a change to src/a.c in `cwd` (the work tree or the upstream clone). */
function changeA(fixture: Fixture, cwd: string, value: string, message: string): void {
  write(join(cwd, "src", "a.c"), ["int a(void)", "{", `\treturn ${value};`, "}", ""].join("\n"));
  git(["commit", "--quiet", "-am", message], { cwd, env: fixture.env });
}

function thrown(body: () => unknown): Error {
  try {
    body();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected the call to throw");
}

describe("patches:work, patches:export and patches:check", () => {
  test("round-trip a series, and check gives the tree of the upstream with the change and the overlay", () => {
    const fixture = makeFixture();
    const { layout } = fixture;

    const worktree = workSeries(layout, undefined, {}, quiet);
    expect(lstatSync(join(worktree, "tools", "run.sh")).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(worktree, "tools", "link")).isSymbolicLink()).toBe(true);
    // The overlay copies are excluded from git status, so `git add -A` cannot sweep them into a patch.
    expect(git(["status", "--porcelain"], { cwd: worktree, env: fixture.env }).stdout).toBe("");

    changeA(fixture, worktree, "2", "topic: return 2");
    expect(exportSeries(layout, undefined, quiet)).toEqual(["0001-topic-return-2.patch"]);
    const patch = readFileSync(join(layout.patchesDir, "0001-topic-return-2.patch"), "utf8");
    expect(patch.startsWith("From 0000000000000000000000000000000000000000 ")).toBe(true);
    expect(patch).toContain("From: Test Author <author@example.invalid>");
    expect(patch).not.toMatch(/^-- \n\d/m);

    // The same change and overlay committed straight onto the upstream is the tree the series gives.
    changeA(fixture, fixture.upstream, "2", "Source");
    for (const name of ["run.sh", "data.txt", "glue.js"]) {
      const mode = name === "run.sh" ? 0o755 : 0o644;
      write(join(fixture.upstream, "tools", name), readFileSync(join(layout.overlayDir, "tools", name), "utf8"), mode);
    }
    symlinkSync("data.txt", join(fixture.upstream, "tools", "link"));
    git(["add", "-f", "tools"], { cwd: fixture.upstream, env: fixture.env });
    git(["commit", "--quiet", "-m", "Overlay"], { cwd: fixture.upstream, env: fixture.env });
    const expectedTree = git(["rev-parse", "HEAD^{tree}"], { cwd: fixture.upstream, env: fixture.env }).stdout.trim();
    expect(checkSeries(layout, quiet)).toEqual({ tree: expectedTree, patches: ["0001-topic-return-2.patch"] });

    // The tree carries the overlay's modes: a changed mode gives another tree.
    chmodSync(join(layout.overlayDir, "tools", "data.txt"), 0o755);
    expect(checkSeries(layout, quiet).tree).not.toBe(expectedTree);
    // No scratch worktree survives a check.
    expect(readdirSync(layout.cacheDir).filter((name) => name.startsWith("check-"))).toEqual([]);
  });

  test("check rejects a patches/ that export would not reproduce", () => {
    const fixture = makeFixture();
    const { layout } = fixture;
    changeA(fixture, workSeries(layout, undefined, {}, quiet), "2", "topic: return 2");
    exportSeries(layout, undefined, quiet);

    // git am ignores the diffstat, so a hand-edited one still applies; the export restores it.
    const file = join(layout.patchesDir, "0001-topic-return-2.patch");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^ 1 file changed.*$/m, " 1 file changed"));
    const error = thrown(() => checkSeries(layout, quiet));
    expect(error.message).toContain("patches/ is not round-trip stable");
    expect(error.message).toMatch(/0001-topic-return-2\.patch: first difference at line \d+/);
  });

  test("a series that conflicts on another tag names the patch and the conflict", () => {
    const fixture = makeFixture();
    const { layout } = fixture;
    changeA(fixture, workSeries(layout, undefined, {}, quiet), "2", "topic: return 2");
    exportSeries(layout, undefined, quiet);

    changeA(fixture, fixture.upstream, "3", "Upstream moves on");
    git(["tag", "v2"], { cwd: fixture.upstream, env: fixture.env });

    const error = thrown(() => workSeries(layout, "v2", {}, quiet));
    expect(error).toBeInstanceOf(UserError);
    expect(error.message).toContain("patches/0001-topic-return-2.patch does not apply on v2");
    expect(error.message).toMatch(/src\/a\.c \(lines 3-7\)/);
    expect(error.message).toContain("left mid-`git am` at work/v2");
    expect(existsSync(join(layout.workDir, "v2", "src", "a.c"))).toBe(true);

    // Exporting from a tag other than the pinned one is refused.
    expect(thrown(() => exportSeries(layout, "v2", quiet)).message).toContain("upstream.json pins v1, not v2");
  });

  test("export refuses commits that touch overlay paths", () => {
    const fixture = makeFixture();
    const { layout } = fixture;
    const worktree = workSeries(layout, undefined, {}, quiet);
    git(["add", "-f", "tools/data.txt"], { cwd: worktree, env: fixture.env });
    git(["commit", "--quiet", "-m", "oops"], { cwd: worktree, env: fixture.env });
    const error = thrown(() => exportSeries(layout, undefined, quiet));
    expect(error.message).toContain("These overlay paths already exist in work/v1's HEAD");
    expect(error.message).toContain("tools/data.txt");
  });
});

describe("series helpers", () => {
  test("patch files must be numbered from 0001 without gaps", () => {
    const fixture = makeFixture();
    const { patchesDir } = fixture.layout;
    writeFileSync(join(patchesDir, "0001-a.patch"), "");
    writeFileSync(join(patchesDir, "0003-c.patch"), "");
    expect(thrown(() => listPatches(patchesDir)).message).toContain("expected the 2nd patch to be named 0002-");
    rmSync(join(patchesDir, "0003-c.patch"));
    writeFileSync(join(patchesDir, "0002-b.patch"), "");
    expect(listPatches(patchesDir)).toEqual(["0001-a.patch", "0002-b.patch"]);
  });

  test("rejected hunks and conflict regions are extracted", () => {
    const output = [
      "Applying: x",
      "error: patch failed: src/backend/Makefile:61",
      "error: src/backend/Makefile: patch does not apply",
      "error: patch failed: src/backend/Makefile:61",
      "error: patch failed: src/backend/tcop/postgres.c:4168",
    ].join("\n");
    expect(parseRejectedHunks(output)).toEqual(["src/backend/Makefile:61", "src/backend/tcop/postgres.c:4168"]);
    const text = ["a", "<<<<<<< HEAD", "b", "=======", "c", ">>>>>>> patch", "d", "<<<<<<< ours", ">>>>>>> theirs"];
    expect(findConflictRegions("f.c", text.join("\n"))).toEqual([
      { file: "f.c", startLine: 2, endLine: 6 },
      { file: "f.c", startLine: 8, endLine: 9 },
    ]);
  });
});
