import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

import { UserError } from "./git.ts";
import type { Layout } from "./layout.ts";

export const SHA = /^[0-9a-f]{40}$/;
/** Upstream tags become ref names and directory names: keep them to plain characters. */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface UpstreamPin {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
}

export type Json = Record<string, unknown>;

export function readJson(file: string, root: string): Json {
  const name = relative(root, file);
  if (!existsSync(file)) throw new UserError(`${name} is missing.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UserError(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UserError(`${name} must contain a JSON object.`);
  }
  return parsed as Json;
}

export function field(object: Json, path: string, name: string): unknown {
  let value: unknown = object;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new UserError(`${name}: \`${path}\` is missing.`);
    }
    value = (value as Json)[key];
  }
  return value;
}

export function stringField(object: Json, path: string, name: string, pattern?: RegExp): string {
  const value = field(object, path, name);
  if (typeof value !== "string" || value === "")
    throw new UserError(`${name}: \`${path}\` must be a non-empty string.`);
  if (pattern !== undefined && !pattern.test(value)) {
    throw new UserError(`${name}: \`${path}\` is ${JSON.stringify(value)}, which does not match ${String(pattern)}.`);
  }
  return value;
}

export function isValidTag(tag: string): boolean {
  return TAG.test(tag);
}

export function readUpstreamPin(layout: Layout): UpstreamPin {
  const json = readJson(layout.upstreamFile, layout.root);
  const name = relative(layout.root, layout.upstreamFile);
  return {
    repository: stringField(json, "repository", name),
    tag: stringField(json, "tag", name, TAG),
    commit: stringField(json, "commit", name, SHA),
  };
}

/** What an `identity/*.json` record proves: its `kind`. */
export const IDENTITY_KINDS = {
  /** The prepopulated data directory the build's own initdb gives (`prepopulated --check`, see `prepopulated.ts`). */
  prepopulated: "prepopulated",
} as const;

/** Reads an `identity/*.json` record and checks its `kind`. */
export function readIdentityRecord(layout: Layout, file: string): { name: string; kind: string; json: Json } {
  const name = relative(layout.root, file);
  const json = readJson(file, layout.root);
  const kind = stringField(json, "kind", name);
  if (!Object.values<string>(IDENTITY_KINDS).includes(kind)) {
    throw new UserError(
      `${name}: \`kind\` is ${JSON.stringify(kind)}; expected one of ${Object.values(IDENTITY_KINDS).join(", ")}.`,
    );
  }
  return { name, kind, json };
}

/** A third-party extension the source pinned as a gitlink: where it goes in the tree, and what is checked out there. */
export interface ExtensionPin {
  /** Tree path, relative and `/`-separated. */
  readonly path: string;
  readonly url: string;
  readonly commit: string;
}

/** A relative, `/`-separated path of plain names: no empty, `.`, `..` or `.git` segment. */
export const TREE_PATH = /^(?!.*(?:^|\/)(?:\.{1,2}|\.git)(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** `extensions.json`'s entries, or `undefined` once the manifest is gone. */
export function readExtensions(layout: Layout): ExtensionPin[] | undefined {
  if (!existsSync(layout.extensionsFile)) return undefined;
  const name = relative(layout.root, layout.extensionsFile);
  const json = readJson(layout.extensionsFile, layout.root);
  const extensions = field(json, "extensions", name);
  if (!Array.isArray(extensions)) throw new UserError(`${name}: \`extensions\` must be an array.`);
  return extensions.map((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UserError(`${name}: \`extensions[${index}]\` must be an object.`);
    }
    const object = entry as Json;
    const where = `${name} extensions[${index}]`;
    return {
      url: stringField(object, "url", where),
      commit: stringField(object, "commit", where, SHA),
      path: stringField(object, "path", where, TREE_PATH),
    };
  });
}

/** The tree paths of `extensions.json`'s entries, or `undefined` once the manifest is gone. */
export function readExtensionPaths(layout: Layout): string[] | undefined {
  return readExtensions(layout)?.map((extension) => extension.path);
}
