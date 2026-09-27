import { runCli, info } from "./lib/cli.ts";
import { exportSeries } from "./lib/commands.ts";
/**
 * bun run patches:export [<tag>]
 *
 * Writes work/<tag>'s commits (<tag>..HEAD) back to patches/ with deterministic `git format-patch` flags,
 * replacing the series. <tag> defaults to, and must be, the pinned tag.
 */
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";

runCli(() => {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
    throw new UserError("Usage: bun run patches:export [<tag>]");
  }
  exportSeries(layoutFor(repoRoot), args[0], info);
});
