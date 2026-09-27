/**
 * bun run regress:bridge [--artefacts <dir>] [--host <address>] [--port <n>] [--database <name>]
 *                        [--setup <sql>]… [--mount <dir>]… [--epoch <seconds>] [--log <file>]
 *
 * Serves a build's backend over TCP (ADR-0001 decision 6; scripts/lib/bridge/bridge.ts): initdb, the
 * `--setup` queries in `postgres` (for instance the `CREATE DATABASE` of `--database`), then one session on
 * `--database` as user postgres, which native clients (psql, pg_regress) reach at `--host`:`--port` (default
 * 127.0.0.1 and any free port). `--mount` makes a host directory visible to the backend at the same path. The
 * cluster is made on a deterministic host whose clock starts at `--epoch` (default: SOURCE_DATE_EPOCH, or the
 * commit time of HEAD); the session runs on the real clock.
 * Prints one line, `regress:bridge: listening on <host>:<port> …`, when it is ready, and runs until it is
 * killed. The bridge's events and the backend's output go to `--log`, or to stderr.
 *
 * The artefacts default to `bun run build`'s output. Not part of validate or CI: it needs a build.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";

import { Bridge } from "./lib/bridge/bridge.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { loadArtefacts } from "./lib/driver/artefacts.ts";
import { parseEpoch, sourceDateEpoch } from "./lib/driver/determinism.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";

const USAGE =
  "Usage: bun run regress:bridge [--artefacts <dir>] [--host <address>] [--port <n>] [--database <name>] [--setup <sql>]… [--mount <dir>]… [--epoch <seconds>] [--log <file>]";

interface Options {
  artefacts: string | undefined;
  host: string;
  port: number;
  database: string;
  setup: string[];
  mounts: string[];
  epoch: number | undefined;
  log: string | undefined;
}

function options(args: readonly string[]): Options {
  const parsed: Options = {
    artefacts: undefined,
    host: "127.0.0.1",
    port: 0,
    database: "postgres",
    setup: [],
    mounts: [],
    epoch: undefined,
    log: undefined,
  };
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) throw new UserError(USAGE);
    switch (args[index]) {
      case "--artefacts":
        parsed.artefacts = value;
        break;
      case "--host":
        parsed.host = value;
        break;
      case "--port":
        if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new UserError(`--port ${value}: not a port`);
        parsed.port = Number(value);
        break;
      case "--database":
        parsed.database = value;
        break;
      case "--setup":
        parsed.setup.push(value);
        break;
      case "--mount":
        parsed.mounts.push(resolve(value));
        break;
      case "--epoch":
        parsed.epoch = parseEpoch(value, "--epoch");
        break;
      case "--log":
        parsed.log = resolve(value);
        break;
      default:
        throw new UserError(USAGE);
    }
  }
  return parsed;
}

await runCliAsync(async () => {
  const layout = layoutFor(repoRoot);
  const args = options(process.argv.slice(2));
  const started = performance.now();
  const fd = args.log === undefined ? 2 : openSync(args.log, "a");
  // Synchronous writes: the main thread blocks while it waits for clients, and the process ends by a kill.
  const write = (line: string) => writeSync(fd, `${line}\n`);
  const stamp = () => `[${((performance.now() - started) / 1000).toFixed(3).padStart(9)}s]`;
  try {
    const bridge = await Bridge.start({
      artefacts: await loadArtefacts(args.artefacts ?? layout.buildDist),
      database: args.database,
      setup: args.setup,
      mounts: args.mounts,
      host: args.host,
      port: args.port,
      epoch: args.epoch ?? sourceDateEpoch(layout.root),
      log: (line) => write(`${stamp()} ${line}`),
      backendLog: (line) => write(`${stamp()} backend| ${line}`),
    });
    info(`regress:bridge: listening on ${args.host}:${bridge.port} (database ${args.database}, user postgres)`);
    await bridge.serve();
  } finally {
    if (fd !== 2) closeSync(fd);
  }
});
