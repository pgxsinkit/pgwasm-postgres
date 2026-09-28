/**
 * One instance of the Postgres module (`pglite.js`) and the host state around it: the byte channel the wire
 * protocol goes through, the external-command hooks, and the data directory in its MEMFS.
 *
 * The module runs one backend in single-user mode; the series' `main-loop-unroll` and
 * `startup-packet-export` patches let the host feed it one exchange at a time.
 */
import { readTar } from "../tar.ts";
import type { Artefacts } from "./artefacts.ts";
import { realHost, type Host } from "./determinism.ts";
import { preservingExitCode, type ModuleOverrides, type PostgresModule } from "./emscripten.ts";

/** The artefacts hardcode this root: `bin/`, `share/` and `lib/` of the filesystem bundle live under it. */
export const PG_ROOT = "/pglite";
export const PGDATA = `${PG_ROOT}/data`;
export const INITDB_PATH = `${PG_ROOT}/bin/initdb`;
export const POSTGRES_PATH = `${PG_ROOT}/bin/postgres`;
const ICU_DATA_PATH = `${PG_ROOT}/icu`;
/** What `locale -a` prints, shipped in the filesystem bundle. */
const LOCALE_LIST_PATH = `${PG_ROOT}/locale-a`;

/** Postgres' error longjmp, as the overlay's host C code reports it (pglitec.c's POSTGRES_MAIN_LONGJMP). */
const POSTGRES_MAIN_LONGJMP = 100;
/** The exit status single-user mode reports when it started and stays alive. */
const EXIT_ALIVE = 99;
const INITIAL_MEMORY_PAGES = 2048;
const MAXIMUM_MEMORY_PAGES = 32768;

/**
 * The single-user-mode arguments of a start, before `-D <data dir> <database>`: PGlite 0.5.8's
 * `defaultStartParams`, which every data directory this build has made so far was started with.
 */
export const START_PARAMS: readonly string[] = [
  "--single", // single-user mode (must come first)
  "-F", // fsync off
  "-O", // allow system table structure changes
  "-j", // no newline as the interactive query delimiter
  ...["-c", "search_path=public"],
  ...["-c", "exit_on_error=false"],
  ...["-c", "log_checkpoints=false"],
  ...["-c", "max_worker_processes=0"],
  ...["-c", "max_parallel_workers=0"],
  ...["-c", "max_parallel_workers_per_gather=0"],
  ...["-c", "io_method=sync"],
  ...["-c", "max_parallel_maintenance_workers=0"],
];

/** A file or directory of a data directory; `path` is relative to it, with a leading `/` (`/global/1262`). */
export interface DataDirEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  /** Permission bits as the filesystem holds them. */
  readonly mode: number;
  readonly data: Uint8Array;
}

export interface PostgresOptions {
  readonly host?: Host;
  /** Every line the backend writes to stdout or stderr. */
  readonly log?: (line: string) => void;
  readonly user?: string;
  readonly database?: string;
}

/**
 * An exchange that streams, as a socket does: the backend's output goes to `write` whenever it flushes, and
 * a backend that has consumed the message and reads on (a `COPY … FROM STDIN` waiting for its data) gets
 * its next bytes from `read`, which may block until they exist.
 */
export interface ExchangeStream {
  /** The backend's output, as it is flushed; the chunk is the caller's to keep. */
  write(chunk: Uint8Array): void;
  /** More frontend bytes (never empty), or `null` for the end of the input, which the backend reads as EOF. */
  read(): Uint8Array | null;
}

/** Protocol codes of the startup-phase requests a server answers without a session. */
const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

/**
 * Whether `error` is how the runtime unwinds the wasm stack back to the main loop: `'unwind'` from
 * `emscripten_exit_with_live_runtime()` (an ERROR's intercepted siglongjmp, and a Terminate), or the number
 * an Emscripten-mode longjmp throws. An `ExitStatus` is not: it means the backend exited (a FATAL error,
 * `proc_exit`), after its exit callbacks tore the session down.
 */
function isUnwind(error: unknown): boolean {
  return error === "unwind" || typeof error === "number";
}

/** A backend that exited during an exchange: a FATAL error, or anything else that reached `proc_exit`. */
export class BackendExit extends Error {
  override name = "BackendExit";
  readonly status: number;

  constructor(status: number, output: string) {
    super(`The backend exited with status ${status}:\n${output}`);
    this.status = status;
  }
}

/**
 * The wasm's shadow stack pointer (the C stack in linear memory), which the glue does not export. A throw
 * that unwinds wasm frames (an ERROR's intercepted siglongjmp, a FATAL's exit) skips their epilogues, so the
 * pointer stays where the deepest of them left it; without a restore, every ERROR would leak that much stack
 * (about 1.2 kB for `SELECT 1/0`) until `max_stack_depth` refuses everything, and then past the stack's end.
 * The host restores it to where the call started, as Postgres' own siglongjmp to PostgresMain would.
 */
interface ShadowStack {
  save(): number;
  restore(pointer: number): void;
}

function shadowStack(instance: WebAssembly.Instance): ShadowStack {
  const current = instance.exports["emscripten_stack_get_current"];
  const restore = instance.exports["_emscripten_stack_restore"];
  if (typeof current !== "function" || typeof restore !== "function") {
    throw new Error("The Postgres module exports no emscripten_stack_get_current or _emscripten_stack_restore");
  }
  return {
    save: () => (current as () => number)(),
    restore: (pointer) => (restore as (pointer: number) => void)(pointer),
  };
}

function exitStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || (error as { name?: unknown }).name !== "ExitStatus") {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : -1;
}

export class Postgres {
  readonly module: PostgresModule;
  readonly #database: string;
  #input: Uint8Array = new Uint8Array(0);
  #readOffset = 0;
  #output: Uint8Array[] = [];
  #stream: ExchangeStream | undefined;
  #commandStream: number | null = null;
  readonly #functions: number[] = [];
  /** The last lines the backend printed, shared with the module's print callbacks. */
  readonly #recentLines: string[];
  readonly #stack: ShadowStack;
  #started = false;
  #stopped = false;
  #failed = false;
  #disposed = false;

  private constructor(module: PostgresModule, database: string, recentLines: string[], stack: ShadowStack) {
    this.module = module;
    this.#database = database;
    this.#recentLines = recentLines;
    this.#stack = stack;
  }

  static async create(artefacts: Artefacts, options: PostgresOptions = {}): Promise<Postgres> {
    const host = options.host ?? realHost;
    const user = options.user ?? "postgres";
    const database = options.database ?? "postgres";
    let instance: Postgres | undefined;
    let stack: ShadowStack | undefined;
    const lines: string[] = [];
    const output = (text: string) => {
      options.log?.(text);
      lines.push(text);
      if (lines.length > 40) lines.shift();
    };
    const bundle = artefacts.fsBundle.slice().buffer;
    let failInstantiation: (error: unknown) => void = () => undefined;
    const instantiationFailed = new Promise<never>((_, reject) => {
      failInstantiation = reject;
    });

    const overrides: ModuleOverrides<PostgresModule> = {
      thisProgram: POSTGRES_PATH,
      arguments: [],
      noExitRuntime: true,
      wasmMemory: new WebAssembly.Memory({ initial: INITIAL_MEMORY_PAGES, maximum: MAXIMUM_MEMORY_PAGES }),
      stdin: () => null,
      print: output,
      printErr: output,
      instantiateWasm: (imports, done) => {
        host.instantiate(artefacts.postgresWasm, imports).then(
          (wasm) => {
            stack = shadowStack(wasm);
            done(wasm, artefacts.postgresWasm);
          },
          (error: unknown) => failInstantiation(error),
        );
        return {};
      },
      getPreloadedPackage: (name, size) => {
        if (name !== "pglite.data" || bundle.byteLength !== size) {
          throw new Error(
            `Unexpected filesystem package ${name} of ${size} bytes (pglite.data has ${bundle.byteLength})`,
          );
        }
        return bundle;
      },
      // One step, so its order is plain: the glue runs it after loading the filesystem bundle.
      preRun: [
        (module) => {
          host.prepareFilesystem(module.FS);
          // The environment PGlite 0.5.8 gave the backend.
          Object.assign(module.ENV, {
            HOME: "/home/postgres",
            USER: "postgres",
            LOGNAME: "postgres",
            PGDATA,
            PGUSER: user,
            PGDATABASE: database,
            LANG: "en_US.UTF-8",
            LC_COLLATE: "en_US.UTF-8",
            LC_CTYPE: "en_US.UTF-8",
            TZ: "UTC",
            PGTZ: "UTC",
            PGCLIENTENCODING: "UTF8",
            ICU_DATA: ICU_DATA_PATH,
          });
          module.FS.chmod("/home/postgres/.pgpass", 0o600);
          module.FS.chmod(INITDB_PATH, 0o555);
          module.FS.chmod(POSTGRES_PATH, 0o555);
          module.onRuntimeInitialized = () => {
            if (stack === undefined) throw new Error("The Postgres module initialised before its instance");
            instance = new Postgres(module, database, lines, stack);
            instance.#installCallbacks();
          };
        },
      ],
    };
    const module = await Promise.race([artefacts.createPostgresModule(overrides), instantiationFailed]);
    if (instance === undefined || instance.module !== module) throw new Error("The Postgres module did not initialise");
    return instance;
  }

  #addFunction(fn: (...args: number[]) => number | void, signature: string): number {
    const pointer = this.module.addFunction(fn, signature);
    this.#functions.push(pointer);
    return pointer;
  }

  #installCallbacks(): void {
    const mod = this.module;
    mod._pgl_set_system_fn(this.#addFunction(() => 1, "pi"));
    mod._pgl_set_popen_fn(
      this.#addFunction((command: number, mode: number) => {
        const text = mod.UTF8ToString(command);
        const openMode = mod.UTF8ToString(mode);
        if (!text.startsWith("locale -a") || openMode !== "r") throw new Error(`Unhandled external command: ${text}`);
        this.#commandStream = mod._fopen(mod.stringToUTF8OnStack(LOCALE_LIST_PATH), mod.stringToUTF8OnStack("r"));
        return this.#commandStream;
      }, "ppp"),
    );
    mod._pgl_set_pclose_fn(
      this.#addFunction((stream: number) => {
        if (stream !== this.#commandStream) throw new Error(`Unhandled pclose of stream ${stream}`);
        mod._fclose(stream);
        this.#commandStream = null;
      }, "pi"),
    );
    const read = this.#addFunction((pointer: number, maxLength: number) => {
      if (this.#readOffset >= this.#input.length && this.#stream !== undefined) {
        const more = this.#stream.read();
        if (more === null) return 0;
        if (more.length === 0) throw new Error("ExchangeStream.read returned no bytes; return null for the end");
        this.#input = more;
        this.#readOffset = 0;
      }
      const length = Math.min(this.#input.length - this.#readOffset, maxLength);
      mod.HEAPU8.set(this.#input.subarray(this.#readOffset, this.#readOffset + length), pointer);
      this.#readOffset += length;
      return length;
    }, "iii");
    const write = this.#addFunction((pointer: number, length: number) => {
      const chunk = mod.HEAPU8.slice(pointer, pointer + length);
      if (this.#stream === undefined) this.#output.push(chunk);
      else this.#stream.write(chunk);
      return length;
    }, "iii");
    mod._pgl_set_rw_cbs(read, write);
  }

  /** The last lines the backend printed. */
  get recentOutput(): string {
    return this.#recentLines.join("\n");
  }

  /**
   * The wasm's shadow stack pointer now. Between exchanges it is where every exchange starts and ends, whatever
   * the exchange unwound: a drift means a leak (see {@link ShadowStack}).
   */
  get shadowStackPointer(): number {
    return this.#stack.save();
  }

  /** `callMain`, leaving the host's exit code alone. */
  callMain(args: string[]): number {
    return preservingExitCode(() => this.module.callMain(args));
  }

  /** Every entry under the data directory, sorted by path. */
  readDataDir(): DataDirEntry[] {
    const FS = this.module.FS;
    const entries: DataDirEntry[] = [];
    const walk = (directory: string) => {
      for (const name of FS.readdir(directory)) {
        if (name === "." || name === "..") continue;
        const full = `${directory}/${name}`;
        const { mode } = FS.stat(full);
        const isDirectory = FS.isDir(mode);
        if (!isDirectory && !FS.isFile(mode)) throw new Error(`${full} is neither a file nor a directory`);
        entries.push({
          path: full.slice(PGDATA.length),
          type: isDirectory ? "directory" : "file",
          mode: mode & 0o7777,
          data: isDirectory ? new Uint8Array(0) : FS.readFile(full, { encoding: "binary" }).slice(),
        });
        if (isDirectory) walk(full);
      }
    };
    walk(PGDATA);
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Writes entries into the data directory, creating it and any missing parent. */
  writeDataDir(entries: readonly DataDirEntry[]): void {
    const FS = this.module.FS;
    const ensure = (path: string) => {
      if (!FS.analyzePath(path).exists) FS.mkdirTree(path);
    };
    ensure(PGDATA);
    for (const entry of entries) {
      const path = `${PGDATA}${entry.path}`;
      if (entry.type === "directory") {
        ensure(path);
        continue;
      }
      ensure(path.slice(0, path.lastIndexOf("/")));
      FS.writeFile(path, entry.data);
    }
  }

  /** Installs an extension's files (a `.tar.gz` of `lib/postgresql/…` and `share/postgresql/extension/…`). */
  installExtension(archive: Uint8Array): void {
    const FS = this.module.FS;
    for (const member of readTar(archive)) {
      const path = `${PG_ROOT}/${member.path.replace(/^\.?\/+/, "")}`.replace(/\/+$/, "");
      if (member.type === "directory") {
        if (!FS.analyzePath(path).exists) FS.mkdirTree(path);
      } else if (member.type === "file") {
        const directory = path.slice(0, path.lastIndexOf("/"));
        if (!FS.analyzePath(directory).exists) FS.mkdirTree(directory);
        FS.writeFile(path, member.data);
      } else {
        throw new Error(
          `Extension archive member ${member.path} is a ${member.type}; only files and directories are installed`,
        );
      }
    }
  }

  /** Starts the backend in single-user mode on the data directory. */
  start(params: readonly string[] = START_PARAMS): void {
    if (this.#started) throw new Error("The backend is already started");
    const mod = this.module;
    mod._pgl_setPGliteActive(1);
    this.callMain([...params, "-D", PGDATA, this.#database]);
    const status = mod._pgl_setPGliteExitStatus(-3);
    if (status !== EXIT_ALIVE) {
      throw new Error(`Postgres failed to start (single-user mode exit status ${status}):\n${this.recentOutput}`);
    }
    mod._pgl_startPGlite();
    this.#started = true;
  }

  /**
   * One exchange on the session: `message` (a startup packet, or one or more whole frontend messages) goes
   * in, and every byte the backend writes in response comes back, or, with a `stream`, goes to its `write`
   * as it is flushed (and an empty array comes back). SSL and GSS encryption requests are refused with `N`,
   * as a server without either does; a cancel request and a Terminate are ignored, since the session ends
   * with the instance. A throw that is not the runtime's own unwind means the wasm stack was abandoned
   * mid-function, and an exit ({@link BackendExit}) means the backend tore its session down: either is
   * rethrown, and every later exchange is refused.
   */
  exchange(message: Uint8Array, stream?: ExchangeStream): Uint8Array {
    if (!this.#started) throw new Error("Start the backend before exchanging messages");
    if (this.#failed) throw new Error("The session failed and cannot be used again");
    if (this.#stopped) throw new Error("The backend was shut down");
    if (message.length === 0 || message[0] === 0x58) return new Uint8Array(0);
    this.#input = message;
    this.#readOffset = 0;
    this.#output = [];
    this.#stream = stream;
    try {
      if (message[0] === 0) this.#startupPhase(message);
      else this.#runMainLoop();
      return concat(this.#output);
    } catch (error) {
      this.#failed = true;
      const status = exitStatus(error);
      throw status === undefined ? error : new BackendExit(status, this.recentOutput);
    } finally {
      this.#input = new Uint8Array(0);
      this.#output = [];
      this.#stream = undefined;
    }
  }

  /**
   * Mounts a host directory at the same path in the module's filesystem (Emscripten's NODEFS), so the
   * backend reads and writes the host's files there, as a server running on the host would.
   */
  mountHostDirectory(path: string): void {
    const FS = this.module.FS;
    const nodefs = FS.filesystems["NODEFS"];
    if (nodefs === undefined) throw new Error("This build's runtime has no NODEFS");
    if (!FS.analyzePath(path).exists) FS.mkdirTree(path);
    FS.mount(nodefs, { root: path }, path);
  }

  #startupPhase(message: Uint8Array): void {
    const code = message.length >= 8 ? new DataView(message.buffer, message.byteOffset).getInt32(4) : 0;
    if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
      this.#output.push(new Uint8Array([0x4e])); // 'N'
      return;
    }
    if (code === CANCEL_REQUEST) return;
    const mod = this.module;
    if (mod._ProcessStartupPacket(mod._pgl_getMyProcPort(), true, true) !== 0) {
      throw new Error(`Postgres rejected the startup packet:\n${this.recentOutput}`);
    }
    mod._pgl_sendConnData();
    mod._pgl_pq_flush();
  }

  #runMainLoop(): void {
    const mod = this.module;
    // The loop returns after each message; a batch runs until the input (including whatever a streaming
    // exchange read on) is consumed.
    while (this.#readOffset < this.#input.length || mod._pq_buffer_remaining_data() > 0) {
      const stack = this.#stack.save();
      try {
        mod._PostgresMainLoopOnce();
      } catch (error) {
        this.#stack.restore(stack);
        if (!isUnwind(error)) throw error;
        // An ERROR: Postgres' siglongjmp into its main loop was intercepted; its handler runs here.
        if (mod._pgl_setPGliteExitStatus(-2) === POSTGRES_MAIN_LONGJMP) mod._PostgresMainLongJmp();
      }
    }
    mod._PostgresSendReadyForQueryIfNecessary();
    mod._pgl_pq_flush();
  }

  /** Shuts the backend down cleanly (its exit callbacks: the shutdown checkpoint), then disposes of it. */
  close(): void {
    this.shutdown();
    this.dispose();
  }

  /**
   * Shuts the backend down cleanly (its exit callbacks: the shutdown checkpoint) and leaves the instance
   * undisposed, so its data directory can still be read. Does nothing unless it is running.
   */
  shutdown(): void {
    if (this.#started && !this.#stopped && !this.#failed && !this.#disposed) {
      this.#stopped = true;
      try {
        preservingExitCode(() => {
          this.module._pgl_setPGliteActive(0);
          this.module._pgl_run_atexit_funcs();
        });
      } catch (error) {
        const exit = error as { name?: unknown; status?: unknown };
        if (!(exit.name === "ExitStatus" && exit.status === 0)) throw error;
      }
    }
  }

  /** Releases the callbacks and exits the runtime, which `noExitRuntime` otherwise keeps alive. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pointer of this.#functions.splice(0)) this.module.removeFunction(pointer);
    try {
      preservingExitCode(() => this.module._emscripten_force_exit(0));
    } catch {
      // The runtime reports a forced exit by throwing ExitStatus.
    }
  }
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
