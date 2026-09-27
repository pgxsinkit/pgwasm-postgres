/**
 * One pg_regress run against a build (ADR-0001 decision 6): the bridge serves the build's backend on a free
 * port, and upstream's native pg_regress runs the schedule with `--use-existing --max-connections=1` in the
 * builder image, on the host's network.
 *
 * `--use-existing` makes pg_regress create nothing: no database, no roles, and no server configuration. So the
 * bridge creates `regression` the way pg_regress's own `create_database()` (REL_18_3 pg_regress.c) would have,
 * before the session starts on it. The run's directories are the same paths on the host, in the container and
 * in the backend's filesystem (a NODEFS mount), so the server-side `COPY … FROM :'filename'` of the tests reads
 * the tag's `data/` and writes into the run's `results/` as a local server would. The run's `lib/` is
 * pg_regress's `--dlpath`, where the tests look for the regress library (`:libdir/regress.so`). It is empty
 * unless a library is given: the build's own `src/test/regress/regress.so` imports functions and data symbols
 * `pglite.wasm` does not export (its export list comes from the modules the build ships, which regress.so is
 * not), so its `dlopen` fails, and in this runtime a failed `dlopen` makes every later one fail too. Without
 * the file, `CREATE FUNCTION … AS :'regresslib'` fails before any `dlopen`.
 *
 * The bridge runs with a raised native stack ({@link BRIDGE_STACK_KIB}).
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { UserError } from "../git.ts";
import type { Layout } from "../layout.ts";
import { CONTAINER_PREFIX, removeBuildOutput, removeContainer } from "../podman.ts";
import type { RunResults, TestRun } from "./baseline.ts";
import { backendFailures, normaliseDiff, parseStatusLines, splitDiffs, type BackendFailure } from "./results.ts";
import { TOOLS_PREFIX, type ToolsPaths } from "./tools.ts";

export const REGRESS_CONTAINER = `${CONTAINER_PREFIX}regress`;

/**
 * The native stack the bridge's backend runs on: 256 MiB. The backend runs on the bridge's main thread, and every
 * wasm frame takes native stack, while Postgres' check_stack_depth() measures only the wasm's shadow stack (the
 * locals whose address is taken). With the defaults (an 8 MiB RLIMIT_STACK, and JavaScriptCore's
 * maxPerThreadStackUsage, which stops a plain JavaScript recursion at about 45,000 frames) a deep recursion
 * overflows the native stack first, and throws a RangeError out of the wasm, which ends the backend; how deep it
 * gets depends on how far JavaScriptCore has compiled the wasm. `SELECT infinite_recurse()` (max_stack_depth
 * 2MB) needs between 32 and 48 MiB (2026-09-27); 256 MiB, about 50 times the default's depth, leaves the stack
 * check to Postgres. Both limits are raised: RLIMIT_STACK (`ulimit -s`, in KiB) sizes the main thread's stack,
 * and `BUN_JSC_maxPerThreadStackUsage` (bytes, 1 MiB less) lets JavaScriptCore use it.
 */
export const BRIDGE_STACK_KIB = 256 * 1024;

/** The bridge's command: bash raises RLIMIT_STACK, then execs Bun on the bridge script. */
export function bridgeCommand(bun: string, script: string, args: readonly string[]): string[] {
  return ["bash", "-c", `ulimit -s ${BRIDGE_STACK_KIB} && exec "$@"`, "bash", bun, script, ...args];
}

/** The bridge's environment: the caller's, with JavaScriptCore allowed the raised stack. */
export function bridgeEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) result[name] = value;
  result["BUN_JSC_maxPerThreadStackUsage"] = String((BRIDGE_STACK_KIB - 1024) * 1024);
  return result;
}
export const REGRESSION_DATABASE = "regression";
export const SCHEDULE = "parallel_schedule";

/**
 * pg_regress's `create_database("regression")` at REL_18_3, without `--encoding` or `--no-locale`: two psql
 * commands, so two queries (CREATE DATABASE cannot share a query with anything else).
 */
export const DATABASE_SETUP: readonly string[] = [
  `CREATE DATABASE "${REGRESSION_DATABASE}" TEMPLATE=template0`,
  ["lc_messages", "lc_monetary", "lc_numeric", "lc_time"]
    .map((name) => `ALTER DATABASE "${REGRESSION_DATABASE}" SET ${name} TO 'C';`)
    .concat([
      `ALTER DATABASE "${REGRESSION_DATABASE}" SET bytea_output TO 'hex';`,
      `ALTER DATABASE "${REGRESSION_DATABASE}" SET timezone_abbreviations TO 'Default';`,
    ])
    .join(""),
];

export interface RunInput {
  readonly layout: Layout;
  readonly tools: ToolsPaths;
  readonly image: string;
  readonly artefactsDir: string;
  /** A `regress.so` (wasm) for the run's `lib/`, or none. */
  readonly regressLib: string | undefined;
  /** SOURCE_DATE_EPOCH for the bridge's cluster. */
  readonly epoch: number;
  /** The run's output directory (pg_regress's `--outputdir`); replaced. */
  readonly runDir: string;
  readonly timeoutMinutes: number;
  readonly log: (line: string) => void;
}

export interface RunOutput {
  readonly results: RunResults;
  readonly backendFailures: readonly BackendFailure[];
  readonly seconds: number;
}

/** A bind mount at the same path inside the container; podman's `-v` cannot carry `:` or `,`. */
function sameMount(path: string, mode: "ro" | "rw"): string[] {
  if (/[:,]/.test(path)) throw new UserError(`Cannot bind-mount ${path}: the path contains ":" or ",".`);
  return ["-v", `${path}:${path}:${mode}`];
}

function timeout(ms: number, what: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UserError(`regress: ${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Starts the bridge and waits for its `listening on <host>:<port>` line. */
async function startBridge(input: RunInput, logFile: string): Promise<{ bridge: Bun.Subprocess; port: number }> {
  const args = bridgeCommand(process.execPath, join(input.layout.root, "scripts", "regress-bridge.ts"), [
    ...["--artefacts", input.artefactsDir],
    ...["--database", REGRESSION_DATABASE],
    ...DATABASE_SETUP.flatMap((sql) => ["--setup", sql]),
    ...["--mount", input.tools.regressDir],
    ...["--mount", input.runDir],
    ...["--epoch", String(input.epoch)],
    ...["--log", logFile],
  ]);
  const bridge = Bun.spawn(args, {
    cwd: input.layout.root,
    env: bridgeEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = bridge.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const listening = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new UserError(`regress: the bridge exited before it listened; see ${logFile}\n${text}`);
      text += decoder.decode(value, { stream: true });
      const match = /listening on [^:\s]+:(\d+)/.exec(text);
      if (match !== null) return Number(match[1]);
    }
  })();
  const limit = timeout(180_000, "starting the bridge");
  try {
    const port = await Promise.race([listening, limit.promise]);
    reader.releaseLock();
    return { bridge, port };
  } catch (error) {
    bridge.kill("SIGKILL");
    throw error;
  } finally {
    limit.cancel();
  }
}

async function stopBridge(bridge: Bun.Subprocess): Promise<void> {
  if (bridge.exitCode !== null || bridge.signalCode !== null) return;
  bridge.kill("SIGTERM");
  const limit = timeout(10_000, "stopping the bridge");
  try {
    await Promise.race([bridge.exited, limit.promise]);
  } catch {
    bridge.kill("SIGKILL");
    await bridge.exited;
  } finally {
    limit.cancel();
  }
}

export async function runSuite(input: RunInput): Promise<RunOutput> {
  const { layout, tools, runDir } = input;
  if (input.regressLib !== undefined && !existsSync(input.regressLib)) {
    throw new UserError(`regress: no regress library at ${input.regressLib}`);
  }
  removeBuildOutput(runDir);
  mkdirSync(join(runDir, "lib"), { recursive: true });
  if (input.regressLib !== undefined) copyFileSync(input.regressLib, join(runDir, "lib", "regress.so"));
  const bridgeLog = join(runDir, "bridge.log");
  const regressLog = join(runDir, "pg_regress.log");
  const started = Date.now();

  const { bridge, port } = await startBridge(input, bridgeLog);
  input.log(`regress: the bridge listens on 127.0.0.1:${port} (log: ${relative(layout.root, bridgeLog)})`);
  try {
    const command = [
      "podman",
      "run",
      "--rm",
      "--name",
      REGRESS_CONTAINER,
      "--pull=never",
      "--network=host",
      "-v",
      `${tools.install}:${TOOLS_PREFIX}:ro`,
      ...sameMount(tools.regressDir, "ro"),
      ...sameMount(runDir, "rw"),
      input.image,
      `${TOOLS_PREFIX}/bin/pg_regress`,
      "--use-existing",
      "--max-connections=1",
      "--host=127.0.0.1",
      `--port=${port}`,
      "--user=postgres",
      `--bindir=${TOOLS_PREFIX}/bin`,
      `--inputdir=${tools.regressDir}`,
      `--outputdir=${runDir}`,
      `--dlpath=${join(runDir, "lib")}`,
      `--schedule=${join(tools.regressDir, SCHEDULE)}`,
    ];
    writeFileSync(join(runDir, "command.txt"), `${command.join(" ")}\n`);
    const fd = openSync(regressLog, "w");
    const regress = Bun.spawn(command, { stdin: "ignore", stdout: fd, stderr: fd });
    const limit = timeout(input.timeoutMinutes * 60_000, "the pg_regress run");
    try {
      await Promise.race([regress.exited, limit.promise]);
    } catch (error) {
      removeContainer(REGRESS_CONTAINER);
      throw error;
    } finally {
      limit.cancel();
      closeSync(fd);
    }
    if (bridge.exitCode !== null || bridge.signalCode !== null) {
      throw new UserError(
        `regress: the bridge exited during the run (${bridge.exitCode ?? bridge.signalCode}); see ${bridgeLog}`,
      );
    }
  } finally {
    await stopBridge(bridge);
  }
  const seconds = Math.round((Date.now() - started) / 1000);

  const statuses = parseStatusLines(readFileSync(regressLog, "utf8"));
  if (statuses.length === 0) {
    const tail = readFileSync(regressLog, "utf8").trimEnd().split("\n").slice(-20);
    throw new UserError(["regress: pg_regress reported no test:", ...tail.map((line) => `  | ${line}`)].join("\n"));
  }
  const diffsFile = join(runDir, "regression.diffs");
  // latin1 reads and writes bytes as they are: a diff may hold output in another encoding.
  const diffs = splitDiffs(existsSync(diffsFile) ? readFileSync(diffsFile, "latin1") : "");
  const paths = { inputDir: tools.regressDir, outputDir: runDir, port };
  const normalisedDir = join(runDir, "normalised");
  mkdirSync(normalisedDir, { recursive: true });
  const results = new Map<string, TestRun>();
  for (const status of statuses) {
    if (status.ok) {
      results.set(status.name, { outcome: "ok" });
      continue;
    }
    const raw = diffs.get(status.name);
    const diff = raw === undefined ? "(pg_regress wrote no diff for this test)\n" : normaliseDiff(raw, paths);
    writeFileSync(join(normalisedDir, `${status.name}.diff`), diff, "latin1");
    results.set(status.name, { outcome: "failed", diff });
  }
  return { results, backendFailures: backendFailures(readFileSync(bridgeLog, "utf8")), seconds };
}
