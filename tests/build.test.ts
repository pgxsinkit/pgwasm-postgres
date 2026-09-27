import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BUILD_CONTAINER, buildCommand, buildPaths, buildRecipe } from "../scripts/lib/build.ts";
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
  test("the build runs as ElectricSQL's CI did, with the release version", () => {
    const paths = buildPaths(layoutFor("/repo"));
    const command = buildCommand(BUILDER_IMAGE, buildRecipe("18.3.0"), paths);
    expect(command.slice(0, 5)).toEqual(["nice", "-n", "10", "podman", "run"]);
    expect(command.slice(-2)).toEqual([BUILDER_IMAGE, "./build-pglite.sh"]);
    const joined = command.join(" ");
    for (const part of [
      "--rm",
      `--name ${BUILD_CONTAINER}`,
      "--unsetenv container",
      "--umask 0022",
      "--cpus 4 --memory 16g",
      "-e DEBUG=false -e PGWASM_POSTGRES_VERSION=18.3.0",
      "--workdir=/home/runner/_work/pglite/pglite/postgres-pglite",
      "-v /repo/.cache/build/postgres-pglite:/home/runner/_work/pglite/pglite/postgres-pglite:rw",
      "-v /repo/.cache/build/postgres-pglite/dist:/pglite:rw",
      "-v /repo/builder/bin/make:/usr/local/bin/make:ro",
    ]) {
      expect(joined).toContain(part);
    }
    expect(BUILD_CONTAINER.startsWith(CONTAINER_PREFIX)).toBe(true);
    expect(() => buildCommand(BUILDER_IMAGE, buildRecipe("18.3.0"), { ...paths, source: "/a:b" })).toThrow(
      /cannot|Cannot/,
    );
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

  function sourceFixture(): Layout {
    const dir = fixtures.dir("source");
    writeFileSync(join(dir, "gitconfig"), "");
    const upstream = join(dir, "upstream");
    mkdirSync(upstream, { recursive: true });
    const run = (args: string[]): string => git(args, { cwd: upstream, env: env(dirname(upstream)) }).stdout.trim();
    run(["init", "--quiet", "--initial-branch=main"]);
    write(join(upstream, "src/a.c"), "int a;\n");
    write(join(upstream, "configure"), "#!/bin/sh\n", 0o755);
    write(join(upstream, ".gitattributes"), "doc export-ignore\n");
    write(join(upstream, "doc/readme"), "doc\n");
    run(["add", "-A"]);
    run(["commit", "--quiet", "-m", "commit"]);
    run(["tag", "v1"]);
    const base = run(["rev-parse", "HEAD"]);

    const root = join(dir, "root");
    write(join(root, "upstream.json"), JSON.stringify({ repository: `file://${upstream}`, tag: "v1", commit: base }));
    write(join(root, "overlay", "tools", "run.sh"), "#!/bin/sh\n", 0o755);
    symlinkSync("run.sh", join(root, "overlay", "tools", "link"));
    mkdirSync(join(root, "patches"));
    return layoutFor(root);
  }

  test("checks out the proven tree, without git, under umask 022", () => {
    const layout = sourceFixture();
    const previous = process.umask(0o002);
    try {
      const destination = join(layout.cacheDir, "build", "src");
      const source = materialiseSource(layout, destination, () => {});
      expect(source.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(join(destination, ".git"))).toBe(false);
      expect(readFileSync(join(destination, "src", "a.c"), "utf8")).toBe("int a;\n");
      // A checkout, not an export: export-ignore'd files are there.
      expect(existsSync(join(destination, "doc", "readme"))).toBe(true);
      expect(readlinkSync(join(destination, "tools", "link"))).toBe("run.sh");
      const mode = (path: string): string => formatMode(lstatSync(join(destination, path)).mode & 0o7777);
      expect([mode("src/a.c"), mode("configure"), mode("src"), mode("tools/run.sh")]).toEqual([
        "0644",
        "0755",
        "0755",
        "0755",
      ]);
      // materialiseSource restored the caller's umask (setting it again returns the current one).
      expect(process.umask(0o002)).toBe(0o002);
      expect(thrown(() => materialiseSource(layout, destination, () => {}))).toBeInstanceOf(UserError);
    } finally {
      process.umask(previous);
    }
  });
});
