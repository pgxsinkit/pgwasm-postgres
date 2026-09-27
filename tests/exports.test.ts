import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  coreSymbols,
  diffExports,
  formatExportList,
  notExported,
  parseExportList,
  readExportList,
} from "../scripts/lib/exports.ts";
import { layoutFor, repoRoot } from "../scripts/lib/layout.ts";

describe("the export list", () => {
  test("parses to sorted, unique symbols, and formats back", () => {
    expect(parseExportList("_b\n_a\n\n_B\n_a\n")).toEqual(["_B", "_a", "_b"]);
    expect(formatExportList(["_B", "_a"])).toBe("_B\n_a\n");
    expect(coreSymbols("pgl_startPGlite\nPostgresMainLoopOnce\n")).toEqual([
      "_PostgresMainLoopOnce",
      "_pgl_startPGlite",
    ]);
  });

  test("a missing core symbol is what fails; additions and other removals are reported", () => {
    const reference = ["_LocalToUtf", "_pgl_startPGlite", "_postgis_only"];
    const build = ["_LocalToUtf", "_WalReceiverFunctions"];
    expect(diffExports(reference, build, ["_pgl_startPGlite"])).toEqual({
      added: ["_WalReceiverFunctions"],
      removed: ["_pgl_startPGlite", "_postgis_only"],
      missingCore: ["_pgl_startPGlite"],
    });
    expect(diffExports(reference, reference, ["_pgl_startPGlite"]).missingCore).toEqual([]);
    expect(notExported(["_LocalToUtf", "_setTempRet0"], ["LocalToUtf", "memory"])).toEqual(["_setTempRet0"]);
  });

  test("the reference holds every core symbol", () => {
    const layout = layoutFor(repoRoot);
    const reference = new Set(readExportList(layout.exportsReference));
    const core = coreSymbols(
      readFileSync(join(layout.overlayDir, "pglite", "static", "included.pglite.exports"), "utf8"),
    );
    expect(core.filter((symbol) => !reference.has(symbol))).toEqual([]);
    expect(readFileSync(layout.exportsReference, "utf8")).toBe(formatExportList([...reference]));
  });
});
