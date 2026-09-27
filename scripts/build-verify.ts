/**
 * bun run build:verify [<dist dir>]
 *
 * Checks a build's dist/ (by default .cache/build/postgres-pglite/dist, where `bun run build` puts it) against the
 * byte-identity record, identity/0.5.8-artefacts.json: the seven reproducible files byte for byte, and
 * amcheck.tar.gz by its members (path, type, mode, owner, bytes). Prints a table; exits 1 on any mismatch.
 *
 * Not part of validate or CI, like `bun run build`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { formatReport, readArtefactRecord, verifyArtefacts } from "./lib/artefacts.ts";
import { info, runCli } from "./lib/cli.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";

runCli(() => {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
    throw new UserError("Usage: bun run build:verify [<dist dir>]");
  }
  const layout = layoutFor(repoRoot);
  const record = readArtefactRecord(layout);
  const defaultDist = layout.buildDist;
  const dist = args[0] === undefined ? defaultDist : resolve(args[0]);
  if (!existsSync(dist)) {
    throw new UserError(
      `${relative(layout.root, dist) || "."} does not exist.${args[0] === undefined ? " Run `bun run build` first." : ""}`,
    );
  }

  info(`build:verify: ${relative(layout.root, dist)} against ${record.file}`);
  const manifestFile = join(layout.buildDir, "build.json");
  if (dist === defaultDist && existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    info(
      `build:verify: built ${String(manifest["startedAt"])} from tree ${String(manifest["tree"])} with ${String(manifest["image"])} (${String(manifest["imageId"]).slice(0, 12)}), exit ${String(manifest["exitCode"])}, ${String(manifest["buildSeconds"])} s`,
    );
  }
  info("");
  const result = verifyArtefacts(record, dist);
  for (const line of formatReport(result)) info(line);
  if (!result.ok) process.exit(1);
});
