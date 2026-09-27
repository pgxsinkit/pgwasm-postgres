/**
 * The parts of the Emscripten 3.1.74 runtime the driver calls, typed here rather than through
 * `@types/emscripten`. Only what is used is declared; an Emscripten bump that changes any of it breaks
 * the driver's typecheck or its smoke run, which is where the change is meant to surface (ADR-0001
 * decision 9).
 */

export interface EmscriptenStat {
  mode: number;
}

/** Emscripten's `FS`. */
export interface EmscriptenFS {
  analyzePath(path: string): { exists: boolean };
  mkdir(path: string, mode?: number): void;
  mkdirTree(path: string, mode?: number): void;
  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string): void;
  readdir(path: string): string[];
  stat(path: string): EmscriptenStat;
  isFile(mode: number): boolean;
  isDir(mode: number): boolean;
  readFile(path: string, options: { encoding: "binary" }): Uint8Array;
  writeFile(path: string, data: Uint8Array | string): void;
  chmod(path: string, mode: number): void;
  unlink(path: string): void;
  /** A character device whose reads call `input` once per byte. */
  createDevice(parent: string, name: string, input: () => number | null): unknown;
}

/** What the module factories accept; only the members the driver sets. */
export interface ModuleOverrides<TModule> {
  thisProgram: string;
  arguments: string[];
  noExitRuntime: boolean;
  wasmMemory?: WebAssembly.Memory;
  stdin: () => number | null;
  print: (text: string) => void;
  printErr: (text: string) => void;
  instantiateWasm: (
    imports: Bun.WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => Record<string, never>;
  getPreloadedPackage?: (name: string, size: number) => ArrayBuffer;
  preRun: ((module: TModule) => void)[];
}

/** The members both modules have. */
export interface ModuleBase {
  readonly FS: EmscriptenFS;
  readonly ENV: Record<string, string>;
  readonly HEAPU8: Uint8Array;
  readonly PROXYFS: unknown;
  onRuntimeInitialized?: () => void;
  callMain(args: string[]): number;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  removeFunction(pointer: number): void;
  UTF8ToString(pointer: number): string;
  stringToUTF8OnStack(value: string): number;
  _fopen(path: number, mode: number): number;
  _fclose(stream: number): number;
  _pgl_set_system_fn(fn: number): void;
  _pgl_set_popen_fn(fn: number): void;
  _pgl_set_pclose_fn(fn: number): void;
  _pgl_freopen(path: number, mode: number, stream: number): number;
}

/** `pglite.js`: the backend, with the host entry points the series' patches export. */
export interface PostgresModule extends ModuleBase {
  _pgl_set_rw_cbs(read: number, write: number): void;
  _pgl_pq_flush(): void;
  _pgl_setPGliteActive(value: number): number;
  _pgl_startPGlite(): void;
  _pgl_getMyProcPort(): number;
  _pgl_sendConnData(): void;
  _pgl_run_atexit_funcs(): void;
  _pgl_setPGliteExitStatus(status: number): number;
  _PostgresMainLoopOnce(): void;
  _PostgresMainLongJmp(): void;
  _PostgresSendReadyForQueryIfNecessary(): void;
  _ProcessStartupPacket(port: number, sslDone: boolean, gssDone: boolean): number;
  _pq_buffer_remaining_data(): number;
  _emscripten_force_exit(status: number): void;
}

/** `initdb.js`. */
export interface InitdbModule extends ModuleBase {
  _pclose(stream: number): number;
}

export type ModuleFactory<TModule> = (overrides: ModuleOverrides<TModule>) => Promise<TModule>;

interface ProcessWithExitCode {
  exitCode?: number | string | undefined;
}

/**
 * Runs `fn`, restoring `process.exitCode` afterwards. The runtime writes a program's exit status onto
 * the host's `process.exitCode`, and single-user Postgres reports a successful start by exiting with 99:
 * left alone, that would become the exit status of the script that drives it.
 */
export function preservingExitCode<T>(fn: () => T): T {
  const proc = (globalThis as { process?: ProcessWithExitCode }).process;
  if (proc === undefined) return fn();
  const before = proc.exitCode;
  try {
    return fn();
  } finally {
    if (proc.exitCode !== before) proc.exitCode = before ?? 0;
  }
}
