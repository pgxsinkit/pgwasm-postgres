/**
 * pglite.wasm's export list (ADR-0001 decision 6). The build links pglite.wasm with -sMAIN_MODULE=2, which exports
 * only the symbols `exported_functions.txt` lists: `pglite/static/included.pglite.exports` (the core set: what the
 * host calls) and the imports of every module the build ships (overlay `pglite/scripts/exported-functions.sh`).
 * The build writes the list into `dist/`; `exported_functions.txt` at the repository root is the reference the
 * engine gate diffs it against. A core symbol missing from the build's list fails; anything else is reported.
 */
import { readFileSync } from "node:fs";

/** A list's symbols (one per line, with Emscripten's leading underscore), sorted bytewise, without duplicates. */
export function parseExportList(text: string): string[] {
  const symbols = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return [...new Set(symbols)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** `included.pglite.exports` holds bare names; the export list has them with the leading underscore. */
export function coreSymbols(includedText: string): string[] {
  return parseExportList(includedText).map((name) => `_${name}`);
}

export function readExportList(file: string): string[] {
  return parseExportList(readFileSync(file, "utf8"));
}

export function formatExportList(symbols: readonly string[]): string {
  return symbols.map((symbol) => `${symbol}\n`).join("");
}

export interface ExportsDiff {
  /** In the build's list, not in the reference. */
  readonly added: readonly string[];
  /** In the reference, not in the build's list. */
  readonly removed: readonly string[];
  /** Core symbols (included.pglite.exports) the build's list lacks: the gate fails on any. */
  readonly missingCore: readonly string[];
}

export function diffExports(
  reference: readonly string[],
  build: readonly string[],
  core: readonly string[],
): ExportsDiff {
  const inBuild = new Set(build);
  const inReference = new Set(reference);
  return {
    added: build.filter((symbol) => !inReference.has(symbol)),
    removed: reference.filter((symbol) => !inBuild.has(symbol)),
    missingCore: core.filter((symbol) => !inBuild.has(symbol)),
  };
}

/**
 * The listed symbols a linked pglite.wasm does not export: Emscripten links a list only if every symbol in it is
 * defined, by the wasm or by the JavaScript glue (`_setTempRet0`, `_exit`, …), so these are the glue's. `exports`
 * are the wasm's export names, without the underscore.
 */
export function notExported(list: readonly string[], exports: readonly string[]): string[] {
  const exported = new Set(exports.map((name) => `_${name}`));
  return list.filter((symbol) => !exported.has(symbol));
}
