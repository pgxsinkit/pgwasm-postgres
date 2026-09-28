/**
 * A build's artefacts, as the driver loads them: the Emscripten glue (`pglite.js`, `initdb.js`), the two
 * compiled modules, the filesystem bundle (`pglite.data`) and the extension archives.
 *
 * The directory is a build's `dist/` (`bin/pglite.js`, `extensions/amcheck.tar.gz`) or a flat directory
 * holding the same files (`pglite.js`, `amcheck.tar.gz`), as pgxsinkit's `pgwasm-c/artefacts/` does.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { UserError } from "../git.ts";
import type { InitdbModule, ModuleFactory, PgDumpModule, PgDumpOverrides, PostgresModule } from "./emscripten.ts";

/** The files the driver loads, by name. */
export const DRIVER_FILES = ["pglite.js", "pglite.wasm", "pglite.data", "initdb.js", "initdb.wasm"] as const;
export type DriverFile = (typeof DRIVER_FILES)[number];

export interface Artefacts {
  readonly dir: string;
  /** Where each file the driver loaded was found. */
  readonly files: Readonly<Record<DriverFile, string>>;
  readonly createPostgresModule: ModuleFactory<PostgresModule>;
  readonly createInitdbModule: ModuleFactory<InitdbModule>;
  readonly postgresWasm: WebAssembly.Module;
  readonly initdbWasm: WebAssembly.Module;
  /** `pglite.data`; every instance is handed its own copy. */
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

export async function loadArtefacts(directory: string): Promise<Artefacts> {
  const dir = resolve(directory);
  if (!existsSync(dir)) throw new UserError(`The artefact directory ${dir} does not exist.`);
  const files = Object.fromEntries(DRIVER_FILES.map((name) => [name, locate(dir, "bin", name)])) as Record<
    DriverFile,
    string
  >;
  const [createPostgresModule, createInitdbModule, postgresWasm, initdbWasm] = await Promise.all([
    factory<ModuleFactory<PostgresModule>>(files["pglite.js"]),
    factory<ModuleFactory<InitdbModule>>(files["initdb.js"]),
    WebAssembly.compile(readFileSync(files["pglite.wasm"])),
    WebAssembly.compile(readFileSync(files["initdb.wasm"])),
  ]);
  return {
    dir,
    files,
    createPostgresModule,
    createInitdbModule,
    postgresWasm,
    initdbWasm,
    fsBundle: new Uint8Array(readFileSync(files["pglite.data"])),
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
