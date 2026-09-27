/**
 * bun run release:gated <commit> [--out <dir>] [--timeout <minutes>]
 *
 * Downloads the gated build of a commit (ADR-0001 decision 9): the gate directory a successful `gate.yml` run on
 * that commit uploaded as the artifact `gate-<commit>`, into <dir> (default .cache/gated/<commit>), and checks it
 * against its own manifest and SHA256SUMS. When no run on the commit has succeeded yet but one is still going, it
 * waits for that one (polling every 15 seconds, up to --timeout minutes, default 90).
 *
 * It uses the GitHub CLI, read-only: `gh run list`, `gh run view`, `gh run download` (in CI, GH_TOKEN with
 * `actions: read`; GH_REPO names the repository, or gh finds it from the git remote).
 */
import { mkdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { info, runCliAsync } from "./lib/cli.ts";
import { gateArtifact, readGateManifest, verifyGateDir } from "./lib/gate.ts";
import { CommandError, UserError, type RunResult } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { chooseGateRun, type GateRun } from "./lib/release.ts";

const USAGE = "Usage: bun run release:gated <commit> [--out <dir>] [--timeout <minutes>]";
const WORKFLOW = "gate.yml";
const POLL_MS = 15_000;

function gh(args: readonly string[]): RunResult {
  const command = ["gh", ...args];
  const proc = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const result = { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  if (result.exitCode !== 0) throw new CommandError(command, process.cwd(), result);
  return result;
}

await runCliAsync(async () => {
  const args = process.argv.slice(2);
  const commit = args[0];
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) throw new UserError(USAGE);
  let out: string | undefined;
  let timeoutMinutes = 90;
  for (let index = 1; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] === "--out" && value !== undefined) out = value;
    else if (args[index] === "--timeout" && value !== undefined && /^[1-9]\d*$/.test(value))
      timeoutMinutes = Number(value);
    else throw new UserError(USAGE);
  }
  if (Bun.which("gh") === null) throw new UserError("release:gated: the GitHub CLI (gh) is not installed.");
  const layout = layoutFor(repoRoot);
  const dir = resolve(out ?? join(layout.cacheDir, "gated", commit));

  const list = (): GateRun[] =>
    JSON.parse(
      gh([
        "run",
        "list",
        "--workflow",
        WORKFLOW,
        "--commit",
        commit,
        "--limit",
        "100",
        "--json",
        "databaseId,status,conclusion,createdAt,url",
      ]).stdout,
    ) as GateRun[];

  let choice = chooseGateRun(list());
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (choice.kind === "wait") {
    info(`release:gated: waiting for ${choice.run.url} (${choice.run.status})`);
    if (Date.now() > deadline) {
      throw new UserError(`release:gated: ${choice.run.url} did not finish within ${timeoutMinutes} minutes.`);
    }
    await Bun.sleep(POLL_MS);
    choice = chooseGateRun(list());
  }
  if (choice.kind === "none") {
    throw new UserError(
      `release:gated: no gated build of ${commit}: ${choice.reason}. Tag a commit only once gate.yml passed on it (re-run it if its artifact expired).`,
    );
  }
  const run = choice.run;
  info(`release:gated: ${run.url} (${run.createdAt}) passed; downloading ${gateArtifact(commit)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  gh(["run", "download", String(run.databaseId), "--name", gateArtifact(commit), "--dir", dir]);

  const manifest = readGateManifest(dir, layout.root);
  const problems = verifyGateDir(dir, manifest);
  if (manifest.commit !== commit) problems.push(`its manifest is of ${manifest.commit}`);
  if (problems.length > 0) {
    throw new UserError(
      [
        `release:gated: the artifact of ${run.url} is not a gate directory of ${commit}:`,
        ...problems.map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  info(
    `release:gated: ${relative(layout.root, dir) || dir}: pgwasm-postgres ${manifest.version}, ${manifest.files.length} files, each as its manifest records.`,
  );
});
