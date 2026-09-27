/**
 * bun run regress [--artefacts <dir>] [--image <reference>] [--regress-lib <regress.so>] [--runs <n>]
 *                 [--timeout <minutes>] [--record]
 *
 * The engine gate's pg_regress (ADR-0001 decision 6): builds (or reuses) upstream's native pg_regress and psql
 * for the pinned tag, then runs `parallel_schedule` against the build through the TCP bridge, `--runs` times
 * (default 1), and compares the results with regress/baseline.json:
 *
 * - a new failure, a changed diff or a newly unstable test fails the gate;
 * - a vanished failure (failed in the baseline, passes in every run) is reported, so the baseline can be
 *   tightened with --record;
 * - a test the baseline records as unstable is reported apart, whatever it did.
 *
 * `--record` (at least 2 runs, the default then) rewrites the baseline's results and diffs from the runs: a test
 * whose outcome or diff differs between them is recorded as unstable. It keeps the hand-written groups; a new
 * failure lands in `unclassified`, which `bun test` refuses until it has a group and a reason.
 *
 * The artefacts default to `bun run build`'s output, and the builder image (where pg_regress and psql are built
 * and run) to localhost/pgwasm-postgres-builder:3.1.74-p2. The tests' regress library is left out unless
 * `--regress-lib` names one (see scripts/lib/regress/run.ts: the build's own cannot load), and the baseline is
 * recorded without it. It needs podman and the builder image, and a run takes a minute or two, so it is not part
 * of validate.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { BUILDER_IMAGE } from "./lib/builder.ts";
import { info, runCliAsync } from "./lib/cli.ts";
import { readUpstreamPin } from "./lib/config.ts";
import { loadArtefacts } from "./lib/driver/artefacts.ts";
import { gitCache, UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import { imageId, refuseOtherContainers, requirePodman, resourceCaps } from "./lib/podman.ts";
import {
  combineRuns,
  compare,
  passes,
  readBaseline,
  recordBaseline,
  validateBaseline,
  writeBaseline,
  type RunResults,
} from "./lib/regress/baseline.ts";
import { runSuite, SCHEDULE } from "./lib/regress/run.ts";
import { ensureTools } from "./lib/regress/tools.ts";

const USAGE =
  "Usage: bun run regress [--artefacts <dir>] [--image <reference>] [--regress-lib <regress.so>] [--runs <n>] [--timeout <minutes>] [--record]";

interface Options {
  artefacts: string | undefined;
  image: string;
  regressLib: string | undefined;
  runs: number | undefined;
  timeout: number;
  record: boolean;
}

function options(args: readonly string[]): Options {
  const parsed: Options = {
    artefacts: undefined,
    image: BUILDER_IMAGE,
    regressLib: undefined,
    runs: undefined,
    timeout: 60,
    record: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--record") {
      parsed.record = true;
      continue;
    }
    const value = args[index + 1];
    index += 1;
    if (value === undefined) throw new UserError(USAGE);
    const count = () => {
      if (!/^[1-9]\d*$/.test(value)) throw new UserError(`${flag} ${value}: not a positive number`);
      return Number(value);
    };
    if (flag === "--artefacts") parsed.artefacts = value;
    else if (flag === "--image") parsed.image = value;
    else if (flag === "--regress-lib") parsed.regressLib = value;
    else if (flag === "--runs") parsed.runs = count();
    else if (flag === "--timeout") parsed.timeout = count();
    else throw new UserError(USAGE);
  }
  return parsed;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function minutes(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

await runCliAsync(async () => {
  const layout = layoutFor(repoRoot);
  const args = options(process.argv.slice(2));
  const runs = args.runs ?? (args.record ? 2 : 1);
  if (args.record && runs < 2) throw new UserError("regress --record needs at least 2 runs, to find unstable tests.");
  const pin = readUpstreamPin(layout);

  const previous = readBaseline(layout);
  if (!args.record) {
    if (previous === undefined) throw new UserError("regress: there is no baseline yet; record one with --record.");
    const problems = validateBaseline(previous.baseline, [...previous.diffs.keys()]);
    if (problems.length > 0) throw new UserError(["regress: the baseline is inconsistent:", ...problems].join("\n  "));
    if (previous.baseline.upstream.tag !== pin.tag) {
      throw new UserError(
        `regress: the baseline is for ${previous.baseline.upstream.tag}, the pin is ${pin.tag}; record a new one with --record.`,
      );
    }
  }

  requirePodman();
  const image = args.image;
  const id = imageId(image);
  if (id === undefined) {
    throw new UserError(`regress: the builder image ${image} is missing; run \`bun run builder:image\`, or pull it.`);
  }
  refuseOtherContainers();

  const artefactsDir = resolve(args.artefacts ?? layout.buildDist);
  const regressLib = args.regressLib === undefined ? undefined : resolve(args.regressLib);
  const artefacts = await loadArtefacts(artefactsDir);
  const recordedWith: Record<string, string> = {};
  for (const [name, path] of Object.entries(artefacts.files)) recordedWith[name] = sha256(path);
  if (regressLib !== undefined) recordedWith["regress.so"] = sha256(regressLib);
  if (previous !== undefined && "regress.so" in previous.baseline.recordedWith !== (regressLib !== undefined)) {
    info(`regress: note: the baseline was recorded ${regressLib === undefined ? "with" : "without"} a regress library`);
  }
  info(
    `regress: artefacts ${relative(layout.root, artefactsDir) || "."}, ${regressLib === undefined ? "no regress library" : `regress library ${regressLib}`}`,
  );

  const tools = await ensureTools(layout, pin, image, id, resourceCaps(info), info);
  const epoch = Number(gitCache(layout, ["log", "-1", "--format=%ct", pin.commit]).stdout.trim());

  const results: RunResults[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const runDir = join(layout.regressCache, "runs", String(run));
    info(`regress: run ${run} of ${runs}: ${SCHEDULE} from ${pin.tag} (output: ${relative(layout.root, runDir)})`);
    const output = await runSuite({
      layout,
      tools,
      image,
      artefactsDir,
      regressLib,
      epoch,
      runDir,
      timeoutMinutes: args.timeout,
      log: info,
    });
    const tests = [...output.results.values()];
    const failed = tests.filter((test) => test.outcome === "failed").length;
    info(
      `regress: run ${run}: ${tests.length} tests, ${tests.length - failed} passed, ${failed} failed, ${output.backendFailures.length} backend failures, ${minutes(output.seconds)}`,
    );
    for (const failure of output.backendFailures) info(`  backend failed in ${failure.test}: ${failure.error}`);
    results.push(output.results);
  }

  const combined = combineRuns(results);
  const unstable = [...combined].filter(([, test]) => test.result === "unstable");
  for (const [name, test] of unstable) {
    const what = new Set(test.outcomes).size > 1 ? `outcomes ${test.outcomes.join(", ")}` : "its diff";
    info(`regress: ${name} differed between the runs (${what})`);
  }

  if (args.record) {
    const { baseline, diffs, unclassified } = recordBaseline(previous?.baseline, combined, {
      upstream: { tag: pin.tag, commit: pin.commit },
      schedule: SCHEDULE,
      runs,
      recordedWith,
    });
    writeBaseline(layout, baseline, diffs);
    const { tests, passed, failed } = baseline.summary;
    info(
      `regress: recorded ${relative(layout.root, layout.regressBaseline)}: ${tests} tests, ${passed} passed, ${failed} failed, ${baseline.summary.unstable} unstable`,
    );
    if (unclassified.length > 0) {
      info(`regress: unclassified (give each a group and a reason in the baseline): ${unclassified.join(", ")}`);
    }
    return;
  }

  if (previous === undefined) throw new Error("unreachable: checked above");
  const comparison = compare(previous.baseline, previous.diffs, combined);
  const report = (label: string, names: readonly string[]) => {
    for (const name of names) info(`regress: ${label}: ${name}`);
  };
  report("NEW FAILURE", comparison.newFailures);
  for (const name of comparison.changedDiffs) {
    info(
      `regress: CHANGED DIFF: ${name} (diff -u ${relative(layout.root, join(layout.regressDiffsDir, `${name}.diff`))} ${relative(layout.root, join(layout.regressCache, "runs", "1", "normalised", `${name}.diff`))})`,
    );
  }
  report("NEWLY UNSTABLE", comparison.newlyUnstable);
  report("NOT RUN (in the baseline)", comparison.missing);
  report("NOT IN THE BASELINE", comparison.unexpected);
  report("VANISHED (passes now; tighten the baseline with --record)", comparison.vanished);
  for (const test of comparison.unstable)
    info(`regress: unstable (baseline): ${test.name}: ${test.outcomes.join(", ")}`);
  const { summary } = previous.baseline;
  info(
    `regress: baseline ${summary.tests} tests: ${summary.passed} passed, ${summary.failed} failed, ${summary.unstable} unstable`,
  );
  if (!passes(comparison)) throw new UserError("regress: FAILED: the results differ from the baseline.");
  info(
    `regress: ok: no new failure, no changed diff${comparison.vanished.length > 0 ? `; ${comparison.vanished.length} vanished` : ""}.`,
  );
});
