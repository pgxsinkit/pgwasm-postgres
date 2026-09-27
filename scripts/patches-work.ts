import { runCli, info } from "./lib/cli.ts";
import { workSeries } from "./lib/commands.ts";
/**
 * bun run patches:work [<tag>] [--force]
 *
 * Materialises work/<tag> (gitignored): a worktree of the upstream cache on branch work/<tag>, with the
 * series applied as commits on top of the tag and the overlay copied in uncommitted. <tag> defaults to the
 * pinned tag; another tag is fetched and the series applied with a 3-way merge, stopping on conflicts.
 * --force recreates an existing worktree, discarding its commits and changes.
 */
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";

runCli(() => {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const positional = args.filter((arg) => arg !== "--force");
  if (positional.length > 1 || positional.some((arg) => arg.startsWith("-"))) {
    throw new UserError("Usage: bun run patches:work [<tag>] [--force]");
  }
  workSeries(layoutFor(repoRoot), positional[0], { force }, info);
});
