/**
 * bun run build:verify <manifest> [<dist dir>]
 *
 * Checks that a build reproduces another (ADR-0001 decision 9): the release artefacts of a `dist/` (by default
 * .cache/build/postgres-pglite/dist, where `bun run build` puts it) against a manifest another build wrote, such
 * as the gated build's. Every artefact (the extension archives included) must have the manifest's bytes and
 * sha256, and the dist's own manifest.json, when it has one, the same version, source date and compatibility
 * tuple. Prints a table; exits 1 on any difference.
 *
 * Not part of validate or CI, like `bun run build`.
 */
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { info, runCli } from "./lib/cli.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { compareBuild, digestArtefacts, formatComparison, MANIFEST_FILE, readManifest } from "./lib/manifest.ts";

runCli(() => {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || args.some((arg) => arg.startsWith("-"))) {
    throw new UserError("Usage: bun run build:verify <manifest> [<dist dir>]");
  }
  const layout = layoutFor(repoRoot);
  const manifestFile = resolve(args[0] ?? "");
  const dist = args[1] === undefined ? layout.buildDist : resolve(args[1]);
  const where = (path: string): string => relative(layout.root, path) || ".";
  if (!existsSync(manifestFile)) throw new UserError(`${args[0] ?? ""} does not exist.`);
  if (!existsSync(dist)) {
    throw new UserError(`${where(dist)} does not exist.${args[1] === undefined ? " Run `bun run build` first." : ""}`);
  }
  const expected = readManifest(manifestFile, layout.root);
  const ownManifest = join(dist, MANIFEST_FILE);
  const own = existsSync(ownManifest) ? readManifest(ownManifest, layout.root) : undefined;
  info(
    `build:verify: ${where(dist)} against ${where(manifestFile)} (${expected.version}, ${expected.commit.slice(0, 12)})`,
  );
  if (own === undefined) info(`build:verify: ${where(dist)} has no ${MANIFEST_FILE}: only its artefacts are compared.`);
  info("");
  const comparison = compareBuild(expected, { ...own, artefacts: digestArtefacts(dist) });
  for (const line of formatComparison(comparison)) info(line);
  if (!comparison.ok) process.exit(1);
});
