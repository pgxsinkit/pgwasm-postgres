/**
 * bun run prepopulated [--artefacts <dir>] [--out <file>] [--check | --record] [--compare <archive>]
 *
 * Makes the prepopulated data directory asset (ADR-0001 decision 10) from a build's artefacts with the
 * driver: the build's own initdb and a start, under a virtual clock from SOURCE_DATE_EPOCH (default: the
 * commit time of HEAD) with seeded entropy, packed as a deterministic .tar.gz (default:
 * .cache/prepopulated/prepopulated.tar.gz). Then proves the asset loads: unpacked into MEMFS, booted, queried.
 *
 * --check     regenerate at the recorded SOURCE_DATE_EPOCH and require identity/prepopulated.json's archive
 *             and asset sha256s (and its artefacts); exits 1 on any difference.
 * --record    write identity/prepopulated.json from this generation (after a deliberate build change).
 * --compare   report, file by file, how the asset differs from another data directory archive (e.g.
 *             ElectricSQL's @electric-sql/pglite-prepopulatedfs 0.5.8).
 *
 * Not part of validate or CI: it needs a build.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { info, runCliAsync } from "./lib/cli.ts";
import { DRIVER_FILES, loadArtefacts, type Artefacts } from "./lib/driver/artefacts.ts";
import { sourceDateEpoch } from "./lib/driver/determinism.ts";
import { Postgres } from "./lib/driver/postgres.ts";
import { parseBackendMessages, queryMessage, queryResults, startupMessage } from "./lib/driver/wire.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { parseControlFile } from "./lib/pg-control.ts";
import {
  artefactDigests,
  compareDataDirs,
  digestOf,
  formatPrepopulatedRecord,
  generatePrepopulated,
  readPrepopulatedRecord,
  unpackDataDir,
  type PrepopulatedRecord,
} from "./lib/prepopulated.ts";

const USAGE =
  "Usage: bun run prepopulated [--artefacts <dir>] [--out <file>] [--check | --record] [--compare <archive>]";

interface Options {
  artefacts?: string;
  out?: string;
  compare?: string;
  mode: "generate" | "check" | "record";
}

function parseOptions(args: readonly string[]): Options {
  const options: Options = { mode: "generate" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--check" || arg === "--record") {
      if (options.mode !== "generate") throw new UserError(USAGE);
      options.mode = arg === "--check" ? "check" : "record";
    } else if ((arg === "--artefacts" || arg === "--out" || arg === "--compare") && value !== undefined) {
      options[arg === "--artefacts" ? "artefacts" : arg === "--out" ? "out" : "compare"] = value;
      index += 1;
    } else {
      throw new UserError(USAGE);
    }
  }
  return options;
}

/** Boots the driver on the asset and queries it: the proof that the asset loads. */
async function proveLoads(artefacts: Artefacts, asset: Uint8Array): Promise<string> {
  const entries = unpackDataDir(asset);
  const control = parseControlFile(
    entries.find((entry) => entry.path === "/global/pg_control")?.data ?? new Uint8Array(),
  );
  const postgres = await Postgres.create(artefacts);
  try {
    postgres.writeDataDir(entries);
    postgres.start();
    postgres.exchange(startupMessage({ user: "postgres", database: "postgres" }));
    const [row] =
      queryResults(
        parseBackendMessages(
          postgres.exchange(
            queryMessage(
              "SELECT system_identifier, (SELECT count(*) FROM pg_class), current_setting('timezone') FROM pg_control_system()",
            ),
          ),
        ),
      )[0]?.rows ?? [];
    if (row?.[0] !== String(control.fields.get("system_identifier"))) {
      throw new UserError(`The booted cluster reports system identifier ${String(row?.[0])}, not the asset's.`);
    }
    return `system identifier ${row[0]}, ${row[1]} relations in pg_class, timezone ${row[2]}`;
  } finally {
    postgres.close();
  }
}

function sameRecord(a: PrepopulatedRecord, b: PrepopulatedRecord): string[] {
  const problems: string[] = [];
  if (a.entries !== b.entries) problems.push(`${a.entries} entries, recorded ${b.entries}`);
  if (a.tar.sha256 !== b.tar.sha256 || a.tar.bytes !== b.tar.bytes) {
    problems.push(`archive ${a.tar.bytes} bytes ${a.tar.sha256}, recorded ${b.tar.bytes} bytes ${b.tar.sha256}`);
  }
  if (a.asset.sha256 !== b.asset.sha256 || a.asset.bytes !== b.asset.bytes) {
    problems.push(
      `asset ${a.asset.bytes} bytes ${a.asset.sha256}, recorded ${b.asset.bytes} bytes ${b.asset.sha256}${a.tar.sha256 === b.tar.sha256 ? " (the archive is identical: only gzip's output changed, so this Bun's zlib is not the one the record was made with)" : ""}`,
    );
  }
  return problems;
}

await runCliAsync(async () => {
  const layout = layoutFor(repoRoot);
  const options = parseOptions(process.argv.slice(2));
  const recorded = readPrepopulatedRecord(layout);
  const artefacts = await loadArtefacts(options.artefacts ?? layout.buildDist);
  const digests = artefactDigests(artefacts);
  const where = (path: string) => relative(layout.root, path) || ".";

  let epoch: number;
  if (options.mode === "check") {
    if (recorded === undefined)
      throw new UserError(`${where(layout.prepopulatedRecord)} is missing: nothing to check against.`);
    const changed = DRIVER_FILES.filter((file) => digests[file] !== recorded.artefacts[file]);
    if (changed.length > 0) {
      throw new UserError(
        `prepopulated --check: ${where(artefacts.dir)} is not the build ${where(layout.prepopulatedRecord)} was made from (${changed.join(", ")} differ). After a deliberate build change, run \`bun run prepopulated --record\`.`,
      );
    }
    epoch = recorded.sourceDateEpoch;
  } else {
    epoch = sourceDateEpoch(layout.root);
  }

  info(
    `prepopulated: artefacts ${where(artefacts.dir)}, SOURCE_DATE_EPOCH=${epoch} (${new Date(epoch * 1000).toISOString()})`,
  );
  const started = performance.now();
  const generated = await generatePrepopulated(artefacts, epoch);
  const out = resolve(options.out ?? layout.prepopulatedAsset);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, generated.asset);
  const record: PrepopulatedRecord = {
    sourceDateEpoch: epoch,
    artefacts: digests,
    entries: generated.entries.length,
    tar: digestOf(generated.tar),
    asset: digestOf(generated.asset),
  };
  info(`prepopulated: ${record.entries} entries in ${Math.round(performance.now() - started)} ms`);
  info(`prepopulated: archive ${record.tar.bytes} bytes, sha256 ${record.tar.sha256}`);
  info(`prepopulated: ${where(out)} ${record.asset.bytes} bytes, sha256 ${record.asset.sha256}`);

  const loaded = await proveLoads(artefacts, new Uint8Array(readFileSync(out)));
  info(`prepopulated: the asset boots: ${loaded}`);

  if (options.compare !== undefined) {
    info(`prepopulated: compared with ${options.compare}:`);
    const theirs = unpackDataDir(new Uint8Array(readFileSync(resolve(options.compare))));
    for (const line of compareDataDirs(generated.entries, theirs)) info(`  ${line}`);
  }

  if (options.mode === "record") {
    writeFileSync(layout.prepopulatedRecord, formatPrepopulatedRecord(record));
    info(`prepopulated: wrote ${where(layout.prepopulatedRecord)}`);
    return;
  }
  const comparable =
    recorded !== undefined &&
    recorded.sourceDateEpoch === epoch &&
    DRIVER_FILES.every((file) => digests[file] === recorded.artefacts[file]);
  if (!comparable) {
    if (options.mode === "generate" && recorded !== undefined) {
      info(
        `prepopulated: not compared with ${where(layout.prepopulatedRecord)} (recorded at SOURCE_DATE_EPOCH=${recorded.sourceDateEpoch}${DRIVER_FILES.every((file) => digests[file] === recorded.artefacts[file]) ? "" : ", from other artefacts"}); \`--check\` regenerates at the recorded epoch.`,
      );
    }
    return;
  }
  const problems = sameRecord(record, recorded);
  if (problems.length > 0) {
    throw new UserError(
      [
        `prepopulated: FAILED: the same inputs gave a different asset than ${where(layout.prepopulatedRecord)} records:`,
        ...problems.map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  info(`prepopulated: identical to ${where(layout.prepopulatedRecord)}`);
});
