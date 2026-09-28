import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BUILD_CONTAINER, buildCommand, buildEnvironment, buildPaths, SOURCE_MOUNT } from "../scripts/lib/build.ts";
import { BUILDER_IMAGE } from "../scripts/lib/builder.ts";
import { git, UserError } from "../scripts/lib/git.ts";
import { layoutFor, type Layout } from "../scripts/lib/layout.ts";
import { capsOf, CONTAINER_PREFIX } from "../scripts/lib/podman.ts";
import { materialiseSource } from "../scripts/lib/source.ts";
import { formatMode } from "../scripts/lib/tar.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

describe("the build command", () => {
  const paths = buildPaths(layoutFor("/repo"));
  const inputs = { version: "18.3.0", sourceDateEpoch: 1_790_501_297, debug: false };

  test("mounts the source at /build, whatever the checkout's path, and passes the release inputs", () => {
    const command = buildCommand(BUILDER_IMAGE, inputs, paths);
    expect(command.slice(0, 5)).toEqual(["nice", "-n", "10", "podman", "run"]);
    expect(command.slice(-2)).toEqual([BUILDER_IMAGE, "./build-pglite.sh"]);
    const joined = command.join(" ");
    for (const part of [
      "--rm",
      `--name ${BUILD_CONTAINER}`,
      "--unsetenv container",
      "--umask 0022",
      "--cpus 4 --memory 16g",
      "-e DEBUG=false -e PGWASM_POSTGRES_VERSION=18.3.0 -e SOURCE_DATE_EPOCH=1790501297 -e LC_ALL=C",
      `--workdir=${SOURCE_MOUNT}`,
      "-v /repo/.cache/build/postgres-pglite:/build:rw",
      "-v /repo/.cache/build/postgres-pglite/dist:/pgwasm:rw",
      "-v /repo/builder/bin/make:/usr/local/bin/make:ro",
    ]) {
      expect(joined).toContain(part);
    }
    // A release build never sees the host path, except as the mount's source.
    expect(joined.split("/repo/").length - 1).toBe(3);
    expect(joined).not.toContain("HOST_SOURCE_DIR");
    expect(BUILD_CONTAINER.startsWith(CONTAINER_PREFIX)).toBe(true);
    expect(() => buildCommand(BUILDER_IMAGE, inputs, { ...paths, source: "/a:b" })).toThrow(/Cannot/);
  });

  test("leaves out the resource caps podman cannot apply (a CI runner's undelegated cgroup controllers)", () => {
    expect(capsOf(["cpu", "memory", "pids"])).toEqual({ cpu: true, memory: true });
    expect(capsOf(["memory", "pids"])).toEqual({ cpu: false, memory: true });
    expect(capsOf([])).toEqual({ cpu: false, memory: false });
    const memoryOnly = buildCommand(BUILDER_IMAGE, inputs, paths, capsOf(["memory"])).join(" ");
    expect(memoryOnly).not.toContain("--cpus");
    expect(memoryOnly).toContain("--pull=never --memory 16g --umask 0022");
    const full = buildCommand(BUILDER_IMAGE, inputs, paths, capsOf(["cpu", "memory"]));
    expect(full).toEqual(buildCommand(BUILDER_IMAGE, inputs, paths));
  });

  test("a debug build maps /build back to the host's source", () => {
    expect(buildEnvironment({ ...inputs, debug: true }, paths)).toEqual({
      DEBUG: "true",
      PGWASM_POSTGRES_VERSION: "18.3.0",
      SOURCE_DATE_EPOCH: "1790501297",
      LC_ALL: "C",
      HOST_SOURCE_DIR: "/repo/.cache/build/postgres-pglite",
    });
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
