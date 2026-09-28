/**
 * bun run poll [--dry-run] [--image <reference> | --lock]
 *
 * The weekly upstream poll (ADR-0001 decisions 7 and 8), which `poll.yml` runs every Monday; see scripts/lib/poll.ts.
 * It lists upstream's tags with `git ls-remote --tags` and acts, through `gh` (GH_TOKEN from the environment), on
 * two targets, each only when nothing for it exists yet:
 *
 *   bump       the newest release of the pinned major newer than the pin: from develop (HEAD must be on it, with a
 *              clean working tree), a branch `bump/<tag>` and `bun run bump <tag> --report <file>`. If the bump
 *              committed, the branch is pushed and a pull request against develop opened with the report as its body
 *              (a draft, titled "[blocked] …", when bump exits 1 because something stops it); if it did not (a
 *              conflicting apply, or a refusal), there is nothing to open a pull request with, so an issue "Bump to
 *              <tag>: the series does not apply" carries the conflict report. HEAD goes back to develop. Skipped when
 *              the branch exists on GitHub or an open pull request or issue names the tag.
 *   readiness  the newest tag of the next major: `bun run readiness <tag>`'s report as a comment, marked
 *              `<!-- readiness:<tag> -->`, on the open issue "Postgres <major> readiness" (created when there is
 *              none), whose body is kept a table of every reported tag. Never a pull request, never a commit.
 *              Skipped when a comment carries the tag's marker; the table is still brought up to date.
 *
 * The pull request is for review only: develop is fast-forwarded from the command line, never merged. One pushed
 * with the workflow's GITHUB_TOKEN triggers no workflow, so it shows no checks; its body carries the gate's result.
 * The files the commands read (the reports, the bodies) go to .cache/poll/.
 *
 * --dry-run        decide, and print every command that would write anything, locally or on GitHub, instead of
 *                  running it; the reads (`git ls-remote`, `gh … list`, `gh api` GETs) run.
 * --image, --lock  the builder image bump and readiness build in (default: the local image; CI: --lock).
 *
 * The repository is GITHUB_REPOSITORY's, or `gh repo view`'s. Exits 1 when an action failed.
 */
import { info, runCliAsync } from "./lib/cli.ts";
import { readUpstreamPin } from "./lib/config.ts";
import { UserError, type RunResult } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { GitHub, poll, type Runner } from "./lib/poll.ts";

const USAGE = "Usage: bun run poll [--dry-run] [--image <reference> | --lock]";

interface Options {
  dryRun: boolean;
  image: string | undefined;
  lock: boolean;
}

function options(args: readonly string[]): Options {
  const parsed: Options = { dryRun: false, image: undefined, lock: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--lock") parsed.lock = true;
    else if (arg === "--image" && value !== undefined) {
      parsed.image = value;
      index += 1;
    } else throw new UserError(USAGE);
  }
  if (parsed.lock && parsed.image !== undefined) throw new UserError(USAGE);
  return parsed;
}

async function tee(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream | undefined): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    sink?.write(chunk);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** Runs commands in the repository, without a terminal prompt; a streamed one's output is shown as it comes. */
function runner(cwd: string): Runner {
  return async (argv, runOptions = {}) => {
    const proc = Bun.spawn([...argv], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stream = runOptions.stream === true;
    const [stdout, stderr, exitCode] = await Promise.all([
      tee(proc.stdout, stream ? process.stdout : undefined),
      tee(proc.stderr, stream ? process.stderr : undefined),
      proc.exited,
    ]);
    const result: RunResult = { exitCode, stdout, stderr };
    return result;
  };
}

await runCliAsync(async () => {
  const args = options(process.argv.slice(2));
  const layout = layoutFor(repoRoot);
  const pin = readUpstreamPin(layout);
  if (Bun.which("gh") === null) throw new UserError("poll: the GitHub CLI (gh) is not installed.");
  const run = runner(layout.root);
  let repository = process.env["GITHUB_REPOSITORY"] ?? "";
  if (repository === "") {
    const view = await run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    repository = view.stdout.trim();
    if (view.exitCode !== 0 || repository === "") {
      throw new UserError(`poll: no GitHub repository (set GITHUB_REPOSITORY): ${view.stderr.trim()}`);
    }
  }
  const result = await poll(
    {
      layout,
      pin,
      github: new GitHub(repository, run),
      run,
      log: info,
      bunRun: [Bun.which("bun") === null ? process.execPath : "bun", "run"],
    },
    {
      dryRun: args.dryRun,
      imageArgs: args.lock ? ["--lock"] : args.image === undefined ? [] : ["--image", args.image],
      base: "develop",
    },
  );
  if (result.failures.length > 0) {
    throw new UserError(["poll: FAILED:", ...result.failures.map((failure) => `  ${failure}`)].join("\n"));
  }
  info(`poll: done${args.dryRun ? " (dry run)" : ""}.`);
});
