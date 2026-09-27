/**
 * bun run patches:check
 *
 * Applies patches/ to the pinned upstream tag in a throwaway worktree, copies the overlay in and writes the
 * tree. Fails when a patch does not apply, when re-exporting the applied commits does not reproduce
 * patches/ byte for byte, or when the tree differs from an identity/*.json record.
 */
import { runCli, info } from "./lib/cli.ts";
import { checkSeries } from "./lib/commands.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";

runCli(() => {
  if (process.argv.length > 2) throw new UserError("Usage: bun run patches:check");
  checkSeries(layoutFor(repoRoot), info);
});
