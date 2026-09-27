/**
 * The declared data format (ADR-0001 decision 8): `data-format.json` names the current `dataFormat` and the
 * compatibility tuple it stands for, and keeps every earlier format with its tuple. Two rules hold:
 *
 * - a changed tuple needs a new `dataFormat`: a build's data directory must have exactly the current tuple;
 * - a new `dataFormat` needs a new tuple: formats are numbered 1, 2, … and no two share a tuple.
 *
 * pgxsinkit carries the current `dataFormat` into the build's identity, and every data directory records it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { field, readJson, type Json } from "./config.ts";
import type { DataDirEntry } from "./driver/postgres.ts";
import { UserError } from "./git.ts";
import type { Layout } from "./layout.ts";
import {
  compatibilityTuple,
  parseControlFile,
  parseWalLongPageHeader,
  TUPLE_KEYS,
  type CompatibilityTuple,
} from "./pg-control.ts";

export interface DataFormat {
  readonly dataFormat: number;
  readonly tuple: CompatibilityTuple;
}

export interface DataFormatDeclaration extends DataFormat {
  /** The file, relative to the repository root. */
  readonly file: string;
  /** Every earlier format, oldest first. */
  readonly previous: readonly DataFormat[];
}

const MAGIC = /^0x[0-9A-F]{4}$/;

function readTuple(json: unknown, where: string): CompatibilityTuple {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new UserError(`${where} must be an object.`);
  const object = json as Json;
  const keys = Object.keys(object).sort();
  const expected = [...TUPLE_KEYS].sort();
  if (keys.join(",") !== expected.join(",")) {
    throw new UserError(`${where} must have exactly the keys ${TUPLE_KEYS.join(", ")}; it has ${keys.join(", ")}.`);
  }
  for (const key of TUPLE_KEYS) {
    const value = object[key];
    const valid =
      key === "float8ByVal"
        ? typeof value === "boolean"
        : key === "xlp_magic"
          ? typeof value === "string" && MAGIC.test(value)
          : typeof value === "number" && Number.isFinite(value) && value > 0;
    if (!valid) throw new UserError(`${where}.${key} is ${JSON.stringify(value)}, which is not a valid value.`);
  }
  return object as unknown as CompatibilityTuple;
}

function readFormatNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new UserError(`${where} must be a positive integer.`);
  }
  return value;
}

/** Reads `data-format.json`; its structure only (see {@link declarationProblems} for the rules). */
export function readDataFormat(layout: Layout): DataFormatDeclaration {
  const file = relative(layout.root, layout.dataFormatFile);
  if (!existsSync(layout.dataFormatFile)) throw new UserError(`${file} is missing.`);
  const json = readJson(layout.dataFormatFile, layout.root);
  const previous = field(json, "previous", file);
  if (!Array.isArray(previous)) throw new UserError(`${file}: \`previous\` must be an array.`);
  return {
    file,
    dataFormat: readFormatNumber(json["dataFormat"], `${file}: \`dataFormat\``),
    tuple: readTuple(json["tuple"], `${file}: \`tuple\``),
    previous: previous.map((entry: unknown, index) => {
      const where = `${file}: \`previous[${index}]\``;
      if (typeof entry !== "object" || entry === null) throw new UserError(`${where} must be an object.`);
      const object = entry as Json;
      return {
        dataFormat: readFormatNumber(object["dataFormat"], `${where}.dataFormat`),
        tuple: readTuple(object["tuple"], `${where}.tuple`),
      };
    }),
  };
}

export function sameTuple(a: CompatibilityTuple, b: CompatibilityTuple): boolean {
  return TUPLE_KEYS.every((key) => a[key] === b[key]);
}

/** Where a declaration breaks the rules: numbering 1…n in order, and one tuple per format. */
export function declarationProblems(declaration: DataFormatDeclaration): string[] {
  const formats: DataFormat[] = [...declaration.previous, declaration];
  const problems: string[] = [];
  formats.forEach((format, index) => {
    if (format.dataFormat !== index + 1) {
      problems.push(
        `dataFormat ${format.dataFormat} is declared ${index === formats.length - 1 ? "as the current format" : `at previous[${index}]`}, where ${index + 1} belongs: formats are numbered 1, 2, … in order.`,
      );
    }
    for (const earlier of formats.slice(0, index)) {
      if (sameTuple(earlier.tuple, format.tuple)) {
        problems.push(
          `dataFormat ${format.dataFormat} has the same tuple as dataFormat ${earlier.dataFormat}: a new dataFormat needs a new tuple.`,
        );
      }
    }
  });
  return problems;
}

export interface TupleDifference {
  readonly key: (typeof TUPLE_KEYS)[number];
  readonly declared: string;
  readonly actual: string;
}

export function tupleDifferences(declared: CompatibilityTuple, actual: CompatibilityTuple): TupleDifference[] {
  return TUPLE_KEYS.filter((key) => declared[key] !== actual[key]).map((key) => ({
    key,
    declared: String(declared[key]),
    actual: String(actual[key]),
  }));
}

const WAL_SEGMENT = /^[0-9A-F]{24}$/;

/** The tuple of a data directory held as entries (from the driver or an archive). */
export function tupleOfEntries(entries: readonly DataDirEntry[]): CompatibilityTuple {
  const control = entries.find((entry) => entry.path === "/global/pg_control");
  const segment = entries
    .filter(
      (entry) => entry.type === "file" && entry.path.startsWith("/pg_wal/") && WAL_SEGMENT.test(entry.path.slice(8)),
    )
    .sort((a, b) => (a.path < b.path ? -1 : 1))[0];
  if (control === undefined) throw new UserError("The data directory has no global/pg_control.");
  if (segment === undefined) throw new UserError("The data directory has no WAL segment in pg_wal/.");
  return compatibilityTuple(parseControlFile(control.data), parseWalLongPageHeader(segment.data));
}

/** The tuple of a data directory on the host's disk. */
export function tupleOfDirectory(dir: string): CompatibilityTuple {
  const control = join(dir, "global", "pg_control");
  if (!existsSync(control)) throw new UserError(`${dir} has no global/pg_control.`);
  const walDir = join(dir, "pg_wal");
  const segment = existsSync(walDir)
    ? readdirSync(walDir)
        .filter((name) => WAL_SEGMENT.test(name))
        .sort()[0]
    : undefined;
  if (segment === undefined) throw new UserError(`${dir} has no WAL segment in pg_wal/.`);
  return compatibilityTuple(
    parseControlFile(new Uint8Array(readFileSync(control))),
    parseWalLongPageHeader(new Uint8Array(readFileSync(join(walDir, segment)))),
  );
}
