/**
 * A build's artefacts, as the driver loads them: the Emscripten glue (`postgres.js`, `initdb.js`), the two
 * compiled modules, the filesystem bundle (`postgres.data`) and the extension archives.
 *
 * The directory is a build's `dist/` (`pgwasm/postgres.js`, `bin/initdb.js`, `extensions/amcheck.tar.gz`) or a
 * flat directory holding the same files (`postgres.js`, `amcheck.tar.gz`), as pgxsinkit's `pgwasm-c/artefacts/`
 * does. A `dist/` also holds the build tree's own `bin/postgres.js`, which is not the backend's glue: the backend's
 * files are looked for in `pgwasm/` only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { UserError } from "../git.ts";
import type { InitdbModule, ModuleFactory, PgDumpModule, PgDumpOverrides, PostgresModule } from "./emscripten.ts";

/** The files the driver loads, by name. */
export const DRIVER_FILES = ["postgres.js", "postgres.wasm", "postgres.data", "initdb.js", "initdb.wasm"] as const;
export type DriverFile = (typeof DRIVER_FILES)[number];

/** Where a build's `dist/` holds each file the driver loads. */
const DIST_SUBDIR: Readonly<Record<DriverFile, string>> = {
  "postgres.js": "pgwasm",
  "postgres.wasm": "pgwasm",
  "postgres.data": "pgwasm",
  "initdb.js": "bin",
  "initdb.wasm": "bin",
};

export interface Artefacts {
  readonly dir: string;
  /** Where each file the driver loaded was found. */
  readonly files: Readonly<Record<DriverFile, string>>;
  readonly createPostgresModule: ModuleFactory<PostgresModule>;
  readonly createInitdbModule: ModuleFactory<InitdbModule>;
  readonly postgresWasm: WebAssembly.Module;
  readonly initdbWasm: WebAssembly.Module;
  /** `postgres.data`; every instance is handed its own copy. */
  readonly fsBundle: Uint8Array;
  /** An extension's archive (`<name>.tar.gz`). */
  extension(name: string): Uint8Array;
  /** `pg_dump.js`'s factory and `pg_dump.wasm`, loaded when first asked for. */
  pgDump(): Promise<{ readonly createModule: PgDumpFactory; readonly wasm: WebAssembly.Module }>;
}

export type PgDumpFactory = (overrides: PgDumpOverrides) => Promise<PgDumpModule>;

function locate(dir: string, subdir: string, name: string): string {
  const candidates = [join(dir, subdir, name), join(dir, name)];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new UserError(`${dir} has no ${name} (looked for ${candidates.join(" and ")}).`);
  return found;
}

async function factory<TFactory>(path: string): Promise<TFactory> {
  const imported = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (typeof imported.default !== "function") throw new UserError(`${path} does not export a module factory.`);
  return imported.default as TFactory;
}

/** Where each file the driver loads is in `dir`, a build's `dist/` or a flat directory. */
export function locateDriverFiles(dir: string): Record<DriverFile, string> {
  return Object.fromEntries(DRIVER_FILES.map((name) => [name, locate(dir, DIST_SUBDIR[name], name)])) as Record<
    DriverFile,
    string
  >;
}

export async function loadArtefacts(directory: string): Promise<Artefacts> {
  const dir = resolve(directory);
  if (!existsSync(dir)) throw new UserError(`The artefact directory ${dir} does not exist.`);
  const files = locateDriverFiles(dir);
  const [createPostgresModule, createInitdbModule, postgresWasm, initdbWasm] = await Promise.all([
    factory<ModuleFactory<PostgresModule>>(files["postgres.js"]),
    factory<ModuleFactory<InitdbModule>>(files["initdb.js"]),
    WebAssembly.compile(readFileSync(files["postgres.wasm"])),
    WebAssembly.compile(readFileSync(files["initdb.wasm"])),
  ]);
  return {
    dir,
    files,
    createPostgresModule,
    createInitdbModule,
    postgresWasm,
    initdbWasm,
    fsBundle: new Uint8Array(readFileSync(files["postgres.data"])),
    extension: (name) => new Uint8Array(readFileSync(locate(dir, "extensions", `${name}.tar.gz`))),
    pgDump: async () => {
      const [createModule, wasm] = await Promise.all([
        factory<PgDumpFactory>(locate(dir, "bin", "pg_dump.js")),
        WebAssembly.compile(readFileSync(locate(dir, "bin", "pg_dump.wasm"))),
      ]);
      return { createModule, wasm };
    },
  };
}
