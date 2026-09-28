/**
 * initdb, run the way PGlite 0.5.8 ran it: its own wasm module, whose `system()`/`popen()` calls to
 * `/pglite/bin/postgres` run the backend's `main` on a scratch Postgres instance (`--boot`, `--single`,
 * `-V`), with the heap reset to its pristine state before each run. initdb sees that instance's
 * filesystem through PROXYFS, so the cluster lands in the instance's `/pglite/data`, which is read back.
 */
import type { Artefacts } from "./artefacts.ts";
import { commandWords } from "./command-line.ts";
import { realHost, type Host } from "./determinism.ts";
import { preservingExitCode, type InitdbModule } from "./emscripten.ts";
import { INITDB_PATH, PG_ROOT, PGDATA, Postgres, POSTGRES_PATH, type DataDirEntry } from "./postgres.ts";

/**
 * initdb's arguments: PGlite 0.5.8's, which made ElectricSQL's prepopulated data directory and every data
 * directory pgxsinkit's C build creates.
 */
export const INITDB_ARGS: readonly string[] = [
  "--allow-group-access",
  "--encoding",
  "UTF8",
  "--locale=C.UTF-8",
  "--locale-provider=libc",
  "--auth=trust",
];

/** The files the backend reads initdb's output from and writes initdb's input to. */
const BACKEND_STDIN = `${PG_ROOT}/pgstdin`;
const BACKEND_STDOUT = `${PG_ROOT}/pgstdout`;

export interface InitdbOptions {
  readonly host?: Host;
  /** Every line initdb and the backend print. */
  readonly log?: (line: string) => void;
  readonly args?: readonly string[];
}

export class InitdbError extends Error {
  override name = "InitdbError";
}

/** Runs initdb and returns the data directory it made. */
export async function initdb(artefacts: Artefacts, options: InitdbOptions = {}): Promise<DataDirEntry[]> {
  const host = options.host ?? realHost;
  const args = [...(options.args ?? INITDB_ARGS)];
  const scratch = await Postgres.create(artefacts, { host, ...(options.log ? { log: options.log } : {}) });
  try {
    const { exitCode, output } = await runInitdb(artefacts, scratch, host, args, options.log);
    if (exitCode !== 0) throw new InitdbError(`initdb exited with ${exitCode}:\n${output}\n${scratch.recentOutput}`);
    return scratch.readDataDir();
  } finally {
    scratch.dispose();
  }
}

async function runInitdb(
  artefacts: Artefacts,
  scratch: Postgres,
  host: Host,
  args: string[],
  log: ((line: string) => void) | undefined,
): Promise<{ exitCode: number; output: string }> {
  const pg = scratch.module;
  const pristineHeap = pg.HEAPU8.slice();
  const lines: string[] = [];
  const print = (text: string) => {
    log?.(text);
    lines.push(text);
  };
  // A popen in "w" mode runs the backend once initdb has written its input, at pclose.
  let pendingWords: string[] | undefined;
  let lastStatus = 0;
  let initdbReads = -1;
  let initdbWrites = -1;

  const runBackend = (words: readonly string[]): number => {
    const [program, ...rest] = words;
    if (program !== POSTGRES_PATH) throw new Error(`initdb tried to execute ${String(program)}`);
    pg.HEAPU8.set(pristineHeap);
    return scratch.callMain(rest);
  };
  const wordsAt = (module: InitdbModule, pointer: number) => commandWords(module.UTF8ToString(pointer));

  let failInstantiation: (error: unknown) => void = () => undefined;
  const instantiationFailed = new Promise<never>((_, reject) => {
    failInstantiation = reject;
  });
  const initdbModule = await Promise.race([
    artefacts.createInitdbModule({
      thisProgram: INITDB_PATH,
      arguments: args,
      noExitRuntime: false,
      stdin: () => null,
      print,
      printErr: print,
      instantiateWasm: (imports, done) => {
        host.instantiate(artefacts.initdbWasm, imports).then(
          (wasm) => done(wasm, artefacts.initdbWasm),
          (error: unknown) => failInstantiation(error),
        );
        return {};
      },
      preRun: [
        (module) => {
          host.prepareFilesystem(module.FS);
          module.FS.mkdir(PG_ROOT);
          module.FS.mount(module.PROXYFS, { root: PG_ROOT, fs: pg.FS }, PG_ROOT);
          // PGlite 0.5.8's, plus LANG: the runtime's default derives it from `navigator.languages`, which
          // differs between hosts (Node 24 on ElectricSQL's CI gave en_US.UTF-8; Bun has none).
          Object.assign(module.ENV, {
            PGDATA,
            HOME: "/home/postgres",
            USER: "postgres",
            LOGNAME: "postgres",
            ICU_DATA: `${PG_ROOT}/icu`,
            LANG: "en_US.UTF-8",
          });
          module.onRuntimeInitialized = () => {
            module._pgl_set_system_fn(
              module.addFunction((command: number) => runBackend(wordsAt(module, command)), "pi"),
            );
            module._pgl_set_popen_fn(
              module.addFunction((command: number, mode: number) => {
                const words = wordsAt(module, command);
                const openMode = module.UTF8ToString(mode);
                if (openMode === "r") {
                  lastStatus = runBackend(words);
                  return initdbReads;
                }
                if (openMode === "w") {
                  pendingWords = words;
                  return initdbWrites;
                }
                throw new Error(`Unexpected popen mode ${openMode}`);
              }, "ppi"),
            );
            module._pgl_set_pclose_fn(
              module.addFunction((stream: number) => {
                if (stream !== initdbReads && stream !== initdbWrites) return module._pclose(stream);
                if (pendingWords !== undefined) {
                  const words = pendingWords;
                  pendingWords = undefined;
                  lastStatus = runBackend(words);
                }
                return lastStatus;
              }, "pi"),
            );
            const cstr = (text: string) => pg.stringToUTF8OnStack(text);
            pg._pgl_freopen(cstr(BACKEND_STDIN), cstr("r"), 0);
            pg._pgl_freopen(cstr(BACKEND_STDOUT), cstr("w"), 1);
            initdbReads = module._fopen(module.stringToUTF8OnStack(BACKEND_STDOUT), module.stringToUTF8OnStack("r"));
            initdbWrites = module._fopen(module.stringToUTF8OnStack(BACKEND_STDIN), module.stringToUTF8OnStack("w"));
          };
        },
      ],
    }),
    instantiationFailed,
  ]);
  const exitCode = preservingExitCode(() => initdbModule.callMain(args));
  return { exitCode, output: lines.join("\n") };
}
