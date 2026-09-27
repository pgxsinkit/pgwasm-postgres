/**
 * bun run data-format:check [--artefacts <dir>] [<data directory or archive>]
 *
 * The data-format guard (ADR-0001 decision 8). Extracts the compatibility tuple from a build's data
 * directory (pg_control, with its CRC-32C verified, and the first WAL segment's page magic) and fails unless
 * it equals the one data-format.json declares for the current dataFormat. It also checks the declaration's
 * own rules: formats numbered 1, 2, … and no two sharing a tuple.
 *
 * The data directory is, by default, a fresh initdb of the build's artefacts through the driver (default:
 * `bun run build`'s output); or a directory on disk; or a data directory archive (a prepopulated asset).
 *
 * Not part of validate or CI when it runs initdb: that needs a build.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { info, runCliAsync } from "./lib/cli.ts";
import {
  declarationProblems,
  readDataFormat,
  tupleDifferences,
  tupleOfDirectory,
  tupleOfEntries,
} from "./lib/data-format.ts";
import { loadArtefacts } from "./lib/driver/artefacts.ts";
import { initdb } from "./lib/driver/initdb.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import type { CompatibilityTuple } from "./lib/pg-control.ts";
import { unpackDataDir } from "./lib/prepopulated.ts";

const USAGE = "Usage: bun run data-format:check [--artefacts <dir>] [<data directory or archive>]";

await runCliAsync(async () => {
  const layout = layoutFor(repoRoot);
  const args = process.argv.slice(2);
  let artefactsDir: string | undefined;
  let source: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--artefacts" && args[index + 1] !== undefined && artefactsDir === undefined) {
      artefactsDir = args[index + 1];
      index += 1;
    } else if (!arg.startsWith("-") && source === undefined) {
      source = arg;
    } else {
      throw new UserError(USAGE);
    }
  }
  if (source !== undefined && artefactsDir !== undefined) throw new UserError(USAGE);

  const declaration = readDataFormat(layout);
  const problems = declarationProblems(declaration);
  if (problems.length > 0) {
    throw new UserError(
      [`data-format:check: ${declaration.file} breaks its rules:`, ...problems.map((line) => `  ${line}`)].join("\n"),
    );
  }

  let tuple: CompatibilityTuple;
  let described: string;
  if (source === undefined) {
    const artefacts = await loadArtefacts(artefactsDir ?? layout.buildDist);
    described = `a fresh initdb of ${relative(layout.root, artefacts.dir) || "."}`;
    tuple = tupleOfEntries(await initdb(artefacts));
  } else {
    const path = resolve(source);
    if (!existsSync(path)) throw new UserError(`${source} does not exist.`);
    described = source;
    tuple = statSync(path).isDirectory()
      ? tupleOfDirectory(path)
      : tupleOfEntries(unpackDataDir(new Uint8Array(readFileSync(path))));
  }

  const differences = tupleDifferences(declaration.tuple, tuple);
  info(`data-format:check: ${described} against ${declaration.file} (dataFormat ${declaration.dataFormat})`);
  const width = Math.max(...Object.keys(tuple).map((key) => key.length));
  for (const [key, value] of Object.entries(tuple)) {
    const difference = differences.find((entry) => entry.key === key);
    info(
      `  ${key.padEnd(width)}  ${String(value)}${difference === undefined ? "" : `  (declared ${difference.declared})`}`,
    );
  }
  if (differences.length > 0) {
    throw new UserError(
      [
        `data-format:check: FAILED: the compatibility tuple changed (${differences.map((entry) => entry.key).join(", ")}), so data directories of this build cannot be opened by builds of dataFormat ${declaration.dataFormat}, nor theirs by it.`,
        `A changed tuple needs a new dataFormat: in ${declaration.file}, move the current format to \`previous\` and declare dataFormat ${declaration.dataFormat + 1} with the tuple above. A new dataFormat needs a new tuple: formats never share one.`,
      ].join("\n"),
    );
  }
  info(`data-format:check: the tuple is dataFormat ${declaration.dataFormat}'s.`);
});
