/**
 * bun run release:check <tag>
 *
 * The release job's first step (ADR-0001 decision 5): refuses a tag that is not a release tag (`N.N.N`), that
 * does not point at the checkout, or that is not the checkout's candidate version (scripts/lib/version.ts: the
 * version the build embeds, derived from the release tags of its ancestors and the pinned upstream tag).
 */
import { info, runCli } from "./lib/cli.ts";
import { readUpstreamPin } from "./lib/config.ts";
import { git, UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { releaseTagProblems } from "./lib/release.ts";
import { repositoryCandidate } from "./lib/version.ts";

runCli(() => {
  const args = process.argv.slice(2);
  const tag = args[0];
  if (args.length !== 1 || tag === undefined || tag.startsWith("-"))
    throw new UserError("Usage: bun run release:check <tag>");
  const layout = layoutFor(repoRoot);
  const head = git(["rev-parse", "HEAD"], { cwd: layout.root }).stdout.trim();
  const resolved = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], {
    cwd: layout.root,
    allowFailure: true,
  });
  const tagCommit = resolved.exitCode === 0 ? resolved.stdout.trim() : undefined;
  const candidate = repositoryCandidate(layout.root, readUpstreamPin(layout).tag);
  const problems = releaseTagProblems({ tag, tagCommit, head, candidate });
  if (problems.length > 0) {
    throw new UserError([`release:check: refusing ${tag}:`, ...problems.map((line) => `  ${line}`)].join("\n"));
  }
  info(`release:check: ${tag} is ${head.slice(0, 12)}'s candidate version.`);
});
