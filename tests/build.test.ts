import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { BUILD_CONTAINER, buildCommand, buildPaths, RECIPE } from "../scripts/lib/build.ts";
import { BUILDER_IMAGE } from "../scripts/lib/builder.ts";
import { git, UserError } from "../scripts/lib/git.ts";
import { layoutFor, type Layout } from "../scripts/lib/layout.ts";
import { CONTAINER_PREFIX } from "../scripts/lib/podman.ts";
import { materialiseSource } from "../scripts/lib/source.ts";
import { formatMode } from "../scripts/lib/tar.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

describe("the build command", () => {
  test("the build runs as ElectricSQL's CI did", () => {
    const paths = buildPaths(layoutFor("/repo"));
    const command = buildCommand(BUILDER_IMAGE, RECIPE, paths);
    expect(command.slice(0, 5)).toEqual(["nice", "-n", "10", "podman", "run"]);
    expect(command.slice(-2)).toEqual([BUILDER_IMAGE, "./build-pglite.sh"]);
    const joined = command.join(" ");
    for (const part of [
      "--rm",
      `--name ${BUILD_CONTAINER}`,
      "--unsetenv container",
      "--umask 0022",
      "--cpus 4 --memory 16g",
      "-e DEBUG=false -e PGLITE_VERSION=0.5.8",
      "--workdir=/home/runner/_work/pglite/pglite/postgres-pglite",
      "-v /repo/.cache/build/postgres-pglite:/home/runner/_work/pglite/pglite/postgres-pglite:rw",
      "-v /repo/.cache/build/postgres-pglite/dist:/pglite:rw",
      "-v /repo/builder/bin/make:/usr/local/bin/make:ro",
    ]) {
      expect(joined).toContain(part);
    }
    expect(BUILD_CONTAINER.startsWith(CONTAINER_PREFIX)).toBe(true);
    expect(() => buildCommand(BUILDER_IMAGE, RECIPE, { ...paths, source: "/a:b" })).toThrow(/cannot|Cannot/);
  });
});

describe("materialiseSource", () => {
  const env = (dir: string): Record<string, string> => ({
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.invalid",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
  });

  function repo(dir: string, files: Record<string, [string, number]>): string {
    mkdirSync(dir, { recursive: true });
    git(["init", "--quiet", "--initial-branch=main"], { cwd: dir, env: env(dirname(dir)) });
    for (const [path, [content, mode]] of Object.entries(files)) write(join(dir, path), content, mode);
    git(["add", "-A"], { cwd: dir, env: env(dirname(dir)) });
    git(["commit", "--quiet", "-m", "commit"], { cwd: dir, env: env(dirname(dir)) });
    return git(["rev-parse", "HEAD"], { cwd: dir, env: env(dirname(dir)) }).stdout.trim();
  }

  function sourceFixture(): { dir: string; layout: Layout; extension: string; pinned: string } {
    const dir = fixtures.dir("source");
    writeFileSync(join(dir, "gitconfig"), "");
    const upstream = join(dir, "upstream");
    const base = repo(upstream, {
      "src/a.c": ["int a;\n", 0o644],
      configure: ["#!/bin/sh\n", 0o755],
      "ext/Makefile": ["all:\n", 0o644],
    });
    git(["tag", "v1"], { cwd: upstream, env: env(dir) });

    const extension = join(dir, "extension");
    const pinned = repo(extension, {
      "ext.c": ["pinned\n", 0o644],
      "build.sh": ["#!/bin/sh\n", 0o755],
      ".gitattributes": [".github export-ignore\n", 0o644],
      ".github/ci.yml": ["on: push\n", 0o644],
    });
    write(join(extension, "ext.c"), "later\n");
    git(["commit", "--quiet", "-am", "later"], { cwd: extension, env: env(dir) });

    const root = join(dir, "root");
    write(join(root, "upstream.json"), JSON.stringify({ repository: `file://${upstream}`, tag: "v1", commit: base }));
    write(join(root, "overlay", "tools", "run.sh"), "#!/bin/sh\n", 0o755);
    symlinkSync("run.sh", join(root, "overlay", "tools", "link"));
    mkdirSync(join(root, "patches"));
    write(
      join(root, "extensions.json"),
      JSON.stringify({ extensions: [{ path: "ext/one", url: `file://${extension}`, commit: pinned }] }),
    );
    return { dir, layout: layoutFor(root), extension, pinned };
  }

  test("checks out the proven tree and the pinned extensions, without git, under umask 022", () => {
    const { layout, extension } = sourceFixture();
    const previous = process.umask(0o002);
    try {
      const destination = join(layout.cacheDir, "build", "src");
      const source = materialiseSource(layout, destination, () => {});
      expect(source.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(join(destination, ".git"))).toBe(false);
      expect(existsSync(join(destination, "ext", "one", ".git"))).toBe(false);
      expect(readFileSync(join(destination, "src", "a.c"), "utf8")).toBe("int a;\n");
      expect(readFileSync(join(destination, "ext", "one", "ext.c"), "utf8")).toBe("pinned\n");
      // A checkout, not an export: export-ignore'd files are there.
      expect(existsSync(join(destination, "ext", "one", ".github", "ci.yml"))).toBe(true);
      expect(readlinkSync(join(destination, "tools", "link"))).toBe("run.sh");
      const mode = (path: string): string => formatMode(lstatSync(join(destination, path)).mode & 0o7777);
      expect([mode("src/a.c"), mode("configure"), mode("src"), mode("tools/run.sh"), mode("ext/one/build.sh")]).toEqual(
        ["0644", "0755", "0755", "0755", "0755"],
      );
      // materialiseSource restored the caller's umask (setting it again returns the current one).
      expect(process.umask(0o002)).toBe(0o002);

      // The pinned commit is cached: a second materialisation needs no network (here, no extension repo).
      rmSync(extension, { recursive: true });
      const again = join(layout.cacheDir, "build", "again");
      expect(materialiseSource(layout, again, () => {}).tree).toBe(source.tree);
      expect(thrown(() => materialiseSource(layout, again, () => {}))).toBeInstanceOf(UserError);
    } finally {
      process.umask(previous);
    }
  });

  test("an unreachable extension commit is reported", () => {
    const { layout } = sourceFixture();
    const manifest = JSON.parse(readFileSync(layout.extensionsFile, "utf8")) as {
      extensions: { commit: string }[];
    };
    const [first] = manifest.extensions;
    if (first === undefined) throw new Error("fixture");
    first.commit = "1".repeat(40);
    writeFileSync(layout.extensionsFile, JSON.stringify(manifest));
    const error = thrown(() => materialiseSource(layout, join(layout.cacheDir, "build", "src"), () => {}));
    expect(error.message).toContain(`Could not fetch ${"1".repeat(40)} (ext/one)`);
  });
});
