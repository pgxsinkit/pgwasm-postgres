/**
 * The host the wasm sees: its clock, its entropy and its timezone (ADR-0001 decision 10).
 *
 * By default a module sees the real host. A deterministic host replaces, for every module the driver
 * creates, the sources of nondeterminism a run of initdb and a boot reach:
 *
 * - **The clock.** The wasm imports `emscripten_date_now` (`time()`), `emscripten_get_now` (monotonic time)
 *   and `clock_time_get` (`clock_gettime`, hence `gettimeofday`) read one virtual clock that starts at
 *   `SOURCE_DATE_EPOCH` and advances by a microsecond on every read. That fixes pg_control's system
 *   identifier (`gettimeofday()` in BootStrapXLOG), its timestamps and the WAL's, and postmaster.pid's
 *   start time. A clock that never moved would hang any busy wait on it.
 * - **Entropy.** `pg_strong_random` (the build has no OpenSSL) reads `/dev/urandom`, which Emscripten backs
 *   with the host's `crypto.getRandomValues`; initdb's bootstrap backend fills pg_control's
 *   `mock_authentication_nonce` from it (InitControlFile), and every backend seeds its PRNG from it. The devices `/dev/urandom` and `/dev/random` and the wasm
 *   import `random_get` are replaced by one SHA-256 counter-mode stream seeded from `SOURCE_DATE_EPOCH`.
 * - **The timezone.** The runtime's libc local time (`_tzset_js`, `_localtime_js`, `_mktime_js`) is the host
 *   JavaScript engine's local time, and initdb picks the cluster's `timezone` and `log_timezone` by probing
 *   it. The process timezone is set to UTC, the timezone of the CI runner that built ElectricSQL's asset
 *   (which is where its `Etc/GMT0` comes from).
 */
import { createHash } from "node:crypto";

import { git, UserError } from "../git.ts";
import type { EmscriptenFS } from "./emscripten.ts";

/**
 * A clock that starts at `epochSeconds` and moves only when read, by one microsecond per read. It counts in
 * integer microseconds, so `clock_gettime`'s nanoseconds are exact (a double of nanoseconds since 1970 is
 * not).
 */
export class VirtualClock {
  readonly #epochMicros: bigint;
  #elapsedMicros = 0n;

  constructor(epochSeconds: number) {
    this.#epochMicros = BigInt(epochSeconds) * 1_000_000n;
  }

  #advance(): bigint {
    this.#elapsedMicros += 1n;
    return this.#elapsedMicros;
  }

  /** Wall-clock time in milliseconds since the Unix epoch (`Date.now()`'s unit). */
  realtimeMs(): number {
    return Number(this.#epochMicros + this.#advance()) / 1000;
  }

  /** Monotonic time in milliseconds (`performance.now()`'s unit), from 0. */
  monotonicMs(): number {
    return Number(this.#advance()) / 1000;
  }

  /** Wall-clock time in nanoseconds since the Unix epoch (`clock_gettime(CLOCK_REALTIME)`). */
  realtimeNs(): bigint {
    return (this.#epochMicros + this.#advance()) * 1000n;
  }

  /** Monotonic time in nanoseconds, from 0. */
  monotonicNs(): bigint {
    return this.#advance() * 1000n;
  }
}

/**
 * A deterministic byte stream: SHA-256 of `seed` and a block counter, block after block. The bytes depend
 * only on the seed and on how many were drawn before, never on how the draws were split.
 */
export class SeededRandom {
  readonly #seed: string;
  #block = new Uint8Array(0);
  #offset = 0;
  #counter = 0;

  constructor(seed: string) {
    this.#seed = seed;
  }

  byte(): number {
    if (this.#offset === this.#block.length) {
      this.#block = new Uint8Array(createHash("sha256").update(`${this.#seed}\0${this.#counter}`).digest());
      this.#counter += 1;
      this.#offset = 0;
    }
    const value = this.#block[this.#offset] ?? 0;
    this.#offset += 1;
    return value;
  }

  fill(view: Uint8Array): void {
    for (let index = 0; index < view.length; index += 1) view[index] = this.byte();
  }
}

/** What a module is given of the host: its instantiation (so, its imports) and its random devices. */
export interface Host {
  /** A human-readable description, for logs. */
  readonly description: string;
  /** Instantiates a module with the imports its glue built (what the glue hands `instantiateWasm`). */
  instantiate(module: WebAssembly.Module, imports: Bun.WebAssembly.Imports): Promise<WebAssembly.Instance>;
  /** Called in `preRun`, once the runtime's filesystem exists. */
  prepareFilesystem(FS: EmscriptenFS): void;
}

/** A deterministic host; `imports` is its view of a module's imports, given the memory they write into. */
export interface DeterministicHost extends Host {
  imports(imports: Bun.WebAssembly.Imports, memory: () => WebAssembly.Memory): Bun.WebAssembly.Imports;
}

/** The real host: the wasm reads the host's clock, entropy and timezone. */
export const realHost: Host = {
  description: "the real clock and entropy",
  instantiate: (module, imports) => WebAssembly.instantiate(module, imports),
  prepareFilesystem: () => undefined,
};

function overlay(target: Bun.WebAssembly.ModuleImports, overrides: Readonly<Record<string, unknown>>) {
  // The glue's import objects may themselves be proxies (dynamic linking resolves symbols lazily).
  return new Proxy(target, {
    get: (object, key) => (typeof key === "string" && key in overrides ? overrides[key] : Reflect.get(object, key)),
  });
}

/** WASI clock ids: realtime, monotonic, process and thread CPU time. */
const CLOCK_REALTIME = 0;
const CLOCK_IDS = 4;
const WASI_EINVAL = 28;

/**
 * A host whose clock starts at `sourceDateEpoch` and whose entropy is seeded from it, in UTC. Every module
 * created with one host shares its clock and its stream, so a run's reads form one sequence.
 */
export function deterministicHost(sourceDateEpoch: number): DeterministicHost {
  pinProcessTimezone();
  const clock = new VirtualClock(sourceDateEpoch);
  const random = new SeededRandom(`pgwasm-postgres SOURCE_DATE_EPOCH=${sourceDateEpoch}`);
  const host: DeterministicHost = {
    description: `a virtual clock from SOURCE_DATE_EPOCH=${sourceDateEpoch} (${new Date(sourceDateEpoch * 1000).toISOString()}), seeded entropy, UTC`,
    imports(imports, memory) {
      const env = imports["env"];
      const wasi = imports["wasi_snapshot_preview1"];
      if (env === undefined || wasi === undefined) throw new Error("the module has no env or WASI imports");
      return {
        ...imports,
        env: overlay(env, {
          emscripten_date_now: () => clock.realtimeMs(),
          emscripten_get_now: () => clock.monotonicMs(),
        }),
        wasi_snapshot_preview1: overlay(wasi, {
          clock_time_get: (clockId: number, _precision: bigint, pointer: number) => {
            if (clockId < 0 || clockId >= CLOCK_IDS) return WASI_EINVAL;
            const ns = clockId === CLOCK_REALTIME ? clock.realtimeNs() : clock.monotonicNs();
            new DataView(memory().buffer).setBigUint64(pointer, ns, true);
            return 0;
          },
          random_get: (pointer: number, length: number) => {
            random.fill(new Uint8Array(memory().buffer, pointer, length));
            return 0;
          },
        }),
      };
    },
    /**
     * The memory the replaced imports write into is the one the module imports (pglite.js, built with
     * IMPORTED_MEMORY) or, failing that, the one it exports: since Emscripten 4.0.19 a main module (initdb.js) is
     * not relocatable and defines its own. Neither import is called before the instance exists.
     */
    async instantiate(module, imports) {
      let instance: WebAssembly.Instance | undefined;
      const imported = imports["env"]?.["memory"];
      const memory = (): WebAssembly.Memory => {
        if (imported instanceof WebAssembly.Memory) return imported;
        const exported = instance?.exports["memory"];
        if (exported instanceof WebAssembly.Memory) return exported;
        throw new Error("the module neither imports nor exports its memory");
      };
      instance = await WebAssembly.instantiate(module, host.imports(imports, memory));
      memory();
      return instance;
    },
    prepareFilesystem(FS) {
      for (const name of ["random", "urandom"]) {
        FS.unlink(`/dev/${name}`);
        FS.createDevice("/dev", name, () => random.byte());
      }
    },
  };
  return host;
}

function pinProcessTimezone(): void {
  process.env["TZ"] = "UTC";
  const winter = new Date(2026, 0, 1).getTimezoneOffset();
  const summer = new Date(2026, 6, 1).getTimezoneOffset();
  if (winter !== 0 || summer !== 0) {
    throw new UserError("Could not switch the process to UTC (TZ=UTC): the wasm would see the host's local time.");
  }
}

/**
 * `SOURCE_DATE_EPOCH` from the environment, or the commit time of HEAD: the moment a deterministic run's
 * clock starts at.
 */
export function sourceDateEpoch(root: string, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const fromEnv = env["SOURCE_DATE_EPOCH"];
  if (fromEnv !== undefined && fromEnv !== "") return parseEpoch(fromEnv, "SOURCE_DATE_EPOCH");
  return parseEpoch(git(["log", "-1", "--format=%ct", "HEAD"], { cwd: root }).stdout.trim(), "HEAD's commit time");
}

export function parseEpoch(value: string, what: string): number {
  if (!/^\d{1,11}$/.test(value))
    throw new UserError(`${what} must be a Unix time in seconds; got ${JSON.stringify(value)}.`);
  return Number(value);
}
