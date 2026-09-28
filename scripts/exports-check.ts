/**
 * bun run exports:check [--artefacts <dir>] [--record]
 *
 * The engine gate's export-list diff (ADR-0001 decision 6): the export list a build linked postgres.wasm with
 * (`exported_functions.txt` in its `dist/`) against the reference, `exported_functions.txt` at the repository
 * root. It fails when the build's list lacks a core symbol (one of `overlay/pglite/static/included.pglite.exports`,
 * what the host calls); symbols added or removed otherwise (a shipped module's imports changed) are reported. It
 * also lists the symbols the JavaScript glue provides rather than postgres.wasm.
 *
 * --record  write the build's list as the reference (after a deliberate change, reviewed in the diff).
 *
 * The artefacts default to `bun run build`'s output. Not part of validate or CI: it needs a build.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { info, runCli } from "./lib/cli.ts";
import { coreSymbols, diffExports, notExported, readExportList } from "./lib/exports.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";

const USAGE = "Usage: bun run exports:check [--artefacts <dir>] [--record]";
const LIST = "exported_functions.txt";

function locate(dir: string, subdir: string, name: string): string {
  const found = [join(dir, name), join(dir, subdir, name)].find((path) => existsSync(path));
  if (found === undefined) throw new UserError(`${dir} has no ${name}.`);
  return found;
}

runCli(() => {
  const layout = layoutFor(repoRoot);
  const args = process.argv.slice(2);
  let artefacts: string | undefined;
  let record = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--record") record = true;
    else if (args[index] === "--artefacts" && args[index + 1] !== undefined) {
      artefacts = args[index + 1];
      index += 1;
    } else throw new UserError(USAGE);
  }
  const dir = resolve(artefacts ?? layout.buildDist);
  const where = (path: string): string => relative(layout.root, path) || ".";
  const buildFile = locate(dir, ".", LIST);
  const build = readExportList(buildFile);
  const core = coreSymbols(
    readFileSync(join(layout.overlayDir, "pglite", "static", "included.pglite.exports"), "utf8"),
  );

  if (record) {
    copyFileSync(buildFile, layout.exportsReference);
    info(`exports:check: wrote ${where(layout.exportsReference)} (${build.length} symbols) from ${where(buildFile)}`);
    return;
  }
  if (!existsSync(layout.exportsReference)) {
    throw new UserError(
      `${where(layout.exportsReference)} is missing; record it with \`bun run exports:check --record\`.`,
    );
  }
  const reference = readExportList(layout.exportsReference);
  info(
    `exports:check: ${where(buildFile)} (${build.length} symbols) against ${where(layout.exportsReference)} (${reference.length}); ${core.length} core symbols`,
  );
  const diff = diffExports(reference, build, core);
  for (const symbol of diff.added) info(`  added:   ${symbol}`);
  for (const symbol of diff.removed) info(`  removed: ${symbol}${core.includes(symbol) ? " (CORE)" : ""}`);

  // Emscripten refuses to link a list naming a symbol the link does not define, unless the JavaScript glue
  // provides it; those are listed here, for the record.
  const wasm = locate(dir, "pgwasm", "postgres.wasm");
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(wasm))).map((entry) => entry.name);
  const glue = notExported(build, exports);
  if (glue.length > 0)
    info(`exports:check: ${glue.length} listed symbols come from the JavaScript glue: ${glue.join(" ")}`);

  if (diff.missingCore.length > 0) {
    throw new UserError(
      `exports:check: FAILED: the build's list lacks ${diff.missingCore.length} core symbols: ${diff.missingCore.join(" ")}`,
    );
  }
  info(
    `exports:check: ok: ${diff.added.length} added, ${diff.removed.length} removed${diff.added.length + diff.removed.length > 0 ? " (review them; `--record` accepts them)" : ""}.`,
  );
});
