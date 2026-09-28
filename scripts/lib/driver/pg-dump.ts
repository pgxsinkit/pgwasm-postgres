/**
 * pg_dump (`pg_dump.js`, `pg_dump.wasm`) run on a Postgres instance's session, the way pgxsinkit's
 * `@pgxsinkit/pgwasm-pg-dump` runs it: a fresh module per run, libpq's socket reads and writes routed to the host
 * (pglitec.c's `pgl_set_rw_cbs`), every whole frontend message it sends handed to the session as one exchange, and
 * the reply queued for its reads. libpq connects over its default Unix socket, whose descriptor pglitec.c makes.
 *
 * pg_dump leaves its read-only transaction open (a disconnect would end it), so it runs last on a session.
 */
import type { Artefacts } from "./artefacts.ts";
import { preservingExitCode, type PgDumpModule } from "./emscripten.ts";
import type { Postgres } from "./postgres.ts";

/** Where pg_dump's own filesystem has it (`argv[0]`, which it resolves to find itself), and its output. */
const PG_DUMP_PATH = "/bin/pg_dump";
const OUTPUT_PATH = "/tmp/pg_dump.out";

export interface PgDumpRun {
  readonly exitCode: number;
  readonly stderr: string;
  /** The output file, when pg_dump exited 0 and wrote one. */
  readonly output: Uint8Array | undefined;
}

/**
 * The frontend messages in libpq's writes: the first is the startup packet (a length, then its body), every later
 * one a type byte and then a length that counts itself; a write may carry part of one, or several.
 */
export class FrontendFramer {
  #pending = new Uint8Array(0);
  #startup = true;

  push(bytes: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.#pending.length + bytes.length);
    joined.set(this.#pending);
    joined.set(bytes, this.#pending.length);
    const messages: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const header = this.#startup ? 4 : 5;
      if (joined.length - offset < header) break;
      const lengthAt = offset + header - 4;
      const length = new DataView(joined.buffer, lengthAt, 4).getUint32(0);
      if (length < 4) throw new Error(`pg_dump sent a frontend message with an invalid length (${length})`);
      const end = lengthAt + length;
      if (joined.length < end) break;
      messages.push(joined.slice(offset, end));
      offset = end;
      this.#startup = false;
    }
    this.#pending = joined.slice(offset);
    return messages;
  }
}

/** Runs pg_dump with `args` (and `-f <its output file>`) on `postgres`'s session. */
export async function runPgDump(artefacts: Artefacts, postgres: Postgres, args: readonly string[]): Promise<PgDumpRun> {
  const { createModule, wasm } = await artefacts.pgDump();
  const lines: string[] = [];
  let failInstantiation: (error: unknown) => void = () => undefined;
  const instantiationFailed = new Promise<never>((_, reject) => {
    failInstantiation = reject;
  });
  const module: PgDumpModule = await Promise.race([
    createModule({
      thisProgram: PG_DUMP_PATH,
      noExitRuntime: false,
      stdin: () => null,
      print: () => undefined,
      printErr: (text) => lines.push(text),
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(wasm, imports).then(
          (instance) => done(instance, wasm),
          (error: unknown) => failInstantiation(error),
        );
        return {};
      },
      preRun: [
        (mod) => {
          Object.assign(mod.ENV, { HOME: "/home/postgres", USER: "postgres", LOGNAME: "postgres" });
          mod.FS.mkdirTree(PG_DUMP_PATH.slice(0, PG_DUMP_PATH.lastIndexOf("/")));
          mod.FS.writeFile(PG_DUMP_PATH, "");
          mod.FS.chmod(PG_DUMP_PATH, 0o555);
        },
      ],
    }),
    instantiationFailed,
  ]);

  const framer = new FrontendFramer();
  const replies: Uint8Array[] = [];
  let head = 0;
  const write = module.addFunction((pointer: number, length: number) => {
    for (const message of framer.push(module.HEAPU8.subarray(pointer, pointer + length))) {
      const reply = postgres.exchange(message);
      if (reply.length > 0) replies.push(reply);
    }
    return length;
  }, "iii");
  const read = module.addFunction((pointer: number, maxLength: number) => {
    const target = module.HEAPU8.subarray(pointer, pointer + maxLength);
    let written = 0;
    while (written < target.length && replies.length > 0) {
      const chunk = replies[0] ?? new Uint8Array(0);
      const take = Math.min(chunk.length - head, target.length - written);
      target.set(chunk.subarray(head, head + take), written);
      written += take;
      head += take;
      if (head === chunk.length) {
        replies.shift();
        head = 0;
      }
    }
    return written;
  }, "iii");
  module._pgl_set_rw_cbs(read, write);

  const exitCode = preservingExitCode(() => module.callMain([...args, "-f", OUTPUT_PATH]));
  const output =
    exitCode === 0 && module.FS.analyzePath(OUTPUT_PATH).exists
      ? module.FS.readFile(OUTPUT_PATH, { encoding: "binary" }).slice()
      : undefined;
  return { exitCode, stderr: lines.join("\n"), output };
}
