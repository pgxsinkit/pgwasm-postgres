/**
 * The build manifest (ADR-0001 decision 9): what a build is and what it made, written next to its output
 * (`dist/manifest.json`) by `bun run build`: the version, the commit and the inputs it was built from, the
 * compatibility tuple of its data directories, and every artefact's bytes and sha256. It holds nothing that
 * varies between two builds of one commit (no times, no host paths), so the manifests of two such builds are
 * identical, and `bun run build:verify <manifest>` checks a build against another's.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { field, readJson, SHA, stringField, type Json } from "./config.ts";
import { UserError } from "./git.ts";
import { TUPLE_KEYS, type CompatibilityTuple } from "./pg-control.ts";

export const MANIFEST_FILE = "manifest.json";

/**
 * The release artefacts, relative to `dist/`, besides the extension archives (every `extensions/*.tar.gz`):
 * the backend (in `pgwasm/`, apart from the build tree's own `bin/postgres.js`), initdb and pg_dump, and the
 * export list postgres.wasm was linked with.
 */
export const RELEASE_FILES = [
  "pgwasm/postgres.wasm",
  "pgwasm/postgres.data",
  "pgwasm/postgres.js",
  "bin/initdb.wasm",
  "bin/initdb.js",
  "bin/pg_dump.wasm",
  "bin/pg_dump.js",
  "exported_functions.txt",
] as const;

export interface ArtefactDigest {
  /** Relative to `dist/`. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BuildManifest {
  /** The release version the build embeds. */
  readonly version: string;
  readonly upstream: { readonly tag: string; readonly commit: string };
  /** The commit of this repository the build was made from, and whether its working tree was clean. */
  readonly commit: string;
  readonly worktreeClean: boolean;
  /** The tree `patches:check` proved: the pinned tag, the series and the overlay. */
  readonly tree: string;
  readonly sourceDateEpoch: number;
  readonly debug: boolean;
  readonly builder: { readonly image: string; readonly id: string };
  /** The declared `dataFormat` whose tuple the build's data directories have, or null when none has it. */
  readonly dataFormat: number | null;
  readonly tuple: CompatibilityTuple;
  /** Sorted by path. */
  readonly artefacts: readonly ArtefactDigest[];
}

const SHA256 = /^[0-9a-f]{64}$/;

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The release artefacts a `dist/` holds, relative to it, sorted; every one must be there. */
export function artefactPaths(dist: string): string[] {
  const extensionsDir = join(dist, "extensions");
  const archives = existsSync(extensionsDir)
    ? readdirSync(extensionsDir)
        .filter((name) => name.endsWith(".tar.gz"))
        .map((name) => `extensions/${name}`)
    : [];
  if (archives.length === 0) throw new UserError(`${dist} has no extension archive (extensions/*.tar.gz).`);
  const missing = RELEASE_FILES.filter((path) => !existsSync(join(dist, path)) || !statSync(join(dist, path)).isFile());
  if (missing.length > 0) throw new UserError(`${dist} lacks ${missing.join(", ")}.`);
  return [...RELEASE_FILES, ...archives].sort();
}

export function digestArtefacts(dist: string): ArtefactDigest[] {
  return artefactPaths(dist).map((path) => {
    const bytes = new Uint8Array(readFileSync(join(dist, path)));
    return { path, bytes: bytes.length, sha256: sha256Of(bytes) };
  });
}

export function formatManifest(manifest: BuildManifest): string {
  return `${JSON.stringify(
    {
      $comment:
        "Written by `bun run build` (ADR-0001 decision 9). Two builds of one commit give identical manifests; `bun run build:verify <manifest>` checks a build against one.",
      ...manifest,
    },
    null,
    2,
  )}\n`;
}

function count(json: Json, path: string, name: string): number {
  const value = field(json, path, name);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new UserError(`${name}: \`${path}\` must be a non-negative integer.`);
  }
  return value;
}

function flag(json: Json, path: string, name: string): boolean {
  const value = field(json, path, name);
  if (typeof value !== "boolean") throw new UserError(`${name}: \`${path}\` must be a boolean.`);
  return value;
}

export function readManifest(file: string, root: string): BuildManifest {
  const name = relative(root, file) || file;
  const json = readJson(file, root);
  const tuple = field(json, "tuple", name);
  if (typeof tuple !== "object" || tuple === null || Array.isArray(tuple)) {
    throw new UserError(`${name}: \`tuple\` must be an object.`);
  }
  const keys = Object.keys(tuple).sort().join(",");
  if (keys !== [...TUPLE_KEYS].sort().join(",")) throw new UserError(`${name}: \`tuple\` must have the tuple's keys.`);
  const dataFormat = field(json, "dataFormat", name);
  if (dataFormat !== null && (typeof dataFormat !== "number" || !Number.isSafeInteger(dataFormat))) {
    throw new UserError(`${name}: \`dataFormat\` must be a number or null.`);
  }
  const artefacts = field(json, "artefacts", name);
  if (!Array.isArray(artefacts)) throw new UserError(`${name}: \`artefacts\` must be an array.`);
  return {
    version: stringField(json, "version", name),
    upstream: { tag: stringField(json, "upstream.tag", name), commit: stringField(json, "upstream.commit", name, SHA) },
    commit: stringField(json, "commit", name, SHA),
    worktreeClean: flag(json, "worktreeClean", name),
    tree: stringField(json, "tree", name, SHA),
    sourceDateEpoch: count(json, "sourceDateEpoch", name),
    debug: flag(json, "debug", name),
    builder: { image: stringField(json, "builder.image", name), id: stringField(json, "builder.id", name) },
    dataFormat,
    tuple: tuple as CompatibilityTuple,
    artefacts: artefacts.map((entry: unknown, index) => {
      const where = `${name} artefacts[${index}]`;
      if (typeof entry !== "object" || entry === null) throw new UserError(`${where} must be an object.`);
      const object = entry as Json;
      return {
        path: stringField(object, "path", where),
        bytes: count(object, "bytes", where),
        sha256: stringField(object, "sha256", where, SHA256),
      };
    }),
  };
}

export type Status = "identical" | "DIFFERENT" | "MISSING" | "UNEXPECTED";

export interface ArtefactComparison {
  readonly path: string;
  readonly expected: ArtefactDigest | undefined;
  readonly actual: ArtefactDigest | undefined;
  readonly status: Status;
}

export interface ManifestComparison {
  readonly artefacts: readonly ArtefactComparison[];
  /** The fields that must match and do not (`version`, `tuple`, …). */
  readonly fields: readonly { readonly field: string; readonly expected: string; readonly actual: string }[];
  /** Fields that differ without making the builds different (the builder image's id, the commit). */
  readonly notes: readonly string[];
  readonly ok: boolean;
}

const text = (value: unknown): string => JSON.stringify(value);

/**
 * Compares a build (its artefacts' digests, and what its manifest says) with a manifest: every artefact, the
 * version, the source date and the tuple must be identical.
 */
export function compareBuild(
  expected: BuildManifest,
  actual: Pick<BuildManifest, "artefacts"> & Partial<BuildManifest>,
): ManifestComparison {
  const actualByPath = new Map(actual.artefacts.map((artefact) => [artefact.path, artefact]));
  const expectedPaths = new Set(expected.artefacts.map((artefact) => artefact.path));
  const artefacts: ArtefactComparison[] = expected.artefacts.map((want) => {
    const got = actualByPath.get(want.path);
    const status: Status =
      got === undefined
        ? "MISSING"
        : got.bytes === want.bytes && got.sha256 === want.sha256
          ? "identical"
          : "DIFFERENT";
    return { path: want.path, expected: want, actual: got, status };
  });
  for (const got of actual.artefacts) {
    if (!expectedPaths.has(got.path))
      artefacts.push({ path: got.path, expected: undefined, actual: got, status: "UNEXPECTED" });
  }
  const fields: { field: string; expected: string; actual: string }[] = [];
  const notes: string[] = [];
  const decisive = ["version", "sourceDateEpoch", "debug", "dataFormat", "tuple", "tree", "upstream"] as const;
  for (const key of decisive) {
    if (actual[key] !== undefined && text(actual[key]) !== text(expected[key])) {
      fields.push({ field: key, expected: text(expected[key]), actual: text(actual[key]) });
    }
  }
  for (const key of ["commit", "worktreeClean", "builder"] as const) {
    if (actual[key] !== undefined && text(actual[key]) !== text(expected[key])) {
      notes.push(`${key}: ${text(actual[key])} (the manifest: ${text(expected[key])})`);
    }
  }
  const ok = artefacts.every((artefact) => artefact.status === "identical") && fields.length === 0;
  return { artefacts, fields, notes, ok };
}

export function formatComparison(comparison: ManifestComparison): string[] {
  const rows = comparison.artefacts.map((artefact) => {
    const shown = artefact.actual ?? artefact.expected;
    return [
      artefact.path,
      shown === undefined ? "-" : shown.bytes.toLocaleString("en-US"),
      shown === undefined ? "-" : shown.sha256,
      artefact.status,
    ];
  });
  const header = ["artefact", "bytes", "sha256", "result"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => (column === 1 ? cell.padStart(widths[column] ?? 0) : cell.padEnd(widths[column] ?? 0))).join(" | ")} |`;
  const lines = [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
  for (const artefact of comparison.artefacts) {
    if (artefact.status === "DIFFERENT" && artefact.expected !== undefined) {
      lines.push(
        `${artefact.path}: expected ${artefact.expected.bytes.toLocaleString("en-US")} bytes, ${artefact.expected.sha256}`,
      );
    }
  }
  for (const difference of comparison.fields) {
    lines.push(`${difference.field}: ${difference.actual}, the manifest has ${difference.expected}`);
  }
  for (const note of comparison.notes) lines.push(`note: ${note}`);
  const identical = comparison.artefacts.filter((artefact) => artefact.status === "identical").length;
  lines.push(
    "",
    `${comparison.ok ? "Reproduced" : "NOT reproduced"}: ${identical}/${comparison.artefacts.length} artefacts identical${comparison.fields.length === 0 ? "" : `; ${comparison.fields.map((entry) => entry.field).join(", ")} differ`}.`,
  );
  return lines;
}
