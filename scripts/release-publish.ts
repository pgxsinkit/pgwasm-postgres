/**
 * bun run release:publish <tag> --gated <dir> [--gate <dir>] [--dry-run] [--summary <file>]
 *
 * The release job's last step (ADR-0001 decision 9). It checks both gate directories against their manifests and
 * SHA256SUMS, and requires this job's gate (--gate, default .cache/gate/<HEAD>) to be of the checkout, of the tag's
 * version, built in the published builder image, and its manifest identical to the gated build's (--gated: the
 * directory `bun run release:gated` downloaded): what was gated is provably what ships. It then writes the release
 * notes from the manifest (.cache/gate/<HEAD>.notes.md) and creates the GitHub release with every file of the gate
 * directory as an asset (`gh release create --verify-tag`: the tag must be on GitHub).
 *
 * --dry-run  stops before `gh release create`, printing the notes and the command; a missing tag and a build
 *            outside the published image are reported instead of refused.
 * --summary  append the notes to <file> (the job summary in CI).
 */
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { info, runCli } from "./lib/cli.ts";
import { readExportList } from "./lib/exports.ts";
import { gateDir, readGateManifest, verifyGateDir } from "./lib/gate.ts";
import { git, UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { exportsAt, previousRelease, publishProblems, releaseCommand, releaseNotes } from "./lib/release.ts";

const USAGE = "Usage: bun run release:publish <tag> --gated <dir> [--gate <dir>] [--dry-run] [--summary <file>]";

runCli(() => {
  const args = process.argv.slice(2);
  const tag = args[0];
  if (tag === undefined || tag.startsWith("-")) throw new UserError(USAGE);
  let gated: string | undefined;
  let gate: string | undefined;
  let summary: string | undefined;
  let dryRun = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = args[index + 1];
    index += 1;
    if (value === undefined) throw new UserError(USAGE);
    if (flag === "--gated") gated = value;
    else if (flag === "--gate") gate = value;
    else if (flag === "--summary") summary = value;
    else throw new UserError(USAGE);
  }
  if (gated === undefined) throw new UserError(USAGE);
  const layout = layoutFor(repoRoot);
  const where = (path: string): string => (path.startsWith("/") ? relative(layout.root, path) || "." : path);
  const head = git(["rev-parse", "HEAD"], { cwd: layout.root }).stdout.trim();
  const resolved = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], {
    cwd: layout.root,
    allowFailure: true,
  });
  const tagCommit = resolved.exitCode === 0 ? resolved.stdout.trim() : undefined;

  const oursDir = resolve(gate ?? gateDir(layout, head));
  const gatedDir = resolve(gated);
  const dirs = [
    ["this job's gate", oursDir],
    ["the gated build", gatedDir],
  ] as const;
  const [ours, theirs] = dirs.map(([what, dir]) => {
    const manifest = readGateManifest(dir, layout.root);
    const problems = verifyGateDir(dir, manifest);
    if (problems.length > 0) {
      throw new UserError(
        [
          `release:publish: ${what} (${where(dir)}) is not what its manifest says:`,
          ...problems.map((line) => `  ${line}`),
        ].join("\n"),
      );
    }
    return manifest;
  });
  if (ours === undefined || theirs === undefined) throw new Error("unreachable");
  info(`release:publish: ${tag}: ${where(oursDir)} against the gated build ${where(gatedDir)}`);

  const { errors, warnings } = publishProblems({ tag, head, tagCommit, ours, gated: theirs, dryRun });
  for (const warning of warnings) info(`release:publish: dry run: ${warning}`);
  if (errors.length > 0) {
    throw new UserError([`release:publish: refusing ${tag}:`, ...errors.map((line) => `  ${line}`)].join("\n"));
  }
  info(`release:publish: the manifests are identical (${ours.files.length} files, every sha256 equal).`);

  const previousTag = previousRelease(layout.root, head);
  const notes = releaseNotes({
    manifest: ours,
    exports: readExportList(join(oursDir, "exported_functions.txt")),
    previous:
      previousTag === undefined ? undefined : { tag: previousTag, exports: exportsAt(layout.root, previousTag) },
  });
  const notesFile = `${gateDir(layout, head)}.notes.md`;
  mkdirSync(dirname(notesFile), { recursive: true });
  writeFileSync(notesFile, notes);
  if (summary !== undefined) appendFileSync(summary, `### Release ${tag}${dryRun ? " (dry run)" : ""}\n\n${notes}\n`);
  const files = readdirSync(oursDir)
    .sort()
    .map((name) => join(oursDir, name));
  const command = releaseCommand(tag, notesFile, files);

  if (dryRun) {
    info(`release:publish: dry run: the notes (${where(notesFile)}):\n`);
    info(notes);
    info(`release:publish: dry run: would run\n  ${command.map((part) => where(part)).join(" ")}`);
    return;
  }
  info(`release:publish: ${command.map((part) => where(part)).join(" ")}`);
  const proc = Bun.spawnSync(command, { cwd: layout.root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new UserError(`release:publish: gh release create failed (exit ${proc.exitCode}).`);
  info(`release:publish: released ${tag} with ${files.length} assets.`);
});
