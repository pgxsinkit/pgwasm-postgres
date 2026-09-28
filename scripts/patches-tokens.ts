/**
 * bun run patches:tokens [--against <revision>] [--image <reference>] [--summary <file>]
 *
 * The token-identity check of postgres.c (ADR-0001 decision 4): postgres.c as the series of <revision> (default: the
 * latest release tag among HEAD's ancestors) makes it, against postgres.c as the working series makes it (patches/
 * and upstream.json as they are in the working tree), preprocessed as the build compiles it and compared token by
 * token. Both sides must pin the same upstream tag; it refuses otherwise.
 *
 *   series      each side's series applied onto the pinned tag in a scratch worktree of the upstream cache
 *               (scripts/lib/tokens-series.ts); postgres.c goes to .cache/tokens/<side>/postgres.c
 *   command     the build's own compile command, from `make -n` in the build's configured tree
 *               (.cache/build/postgres-pglite: run `bun run build` first; the gate runs this after its build)
 *   preprocess  in the builder image, with each side's postgres.c bind-mounted over the tree's: the command with
 *               `-c -o postgres.o` replaced by `-E -P -D__PGLITE__ -D__LINE__=0 -Wno-builtin-macro-redefined`,
 *               to .cache/tokens/<side>.i
 *   compare     the token streams, whitespace dropped, item by item (scripts/lib/tokens.ts): "identical", or the
 *               items that moved, changed (with each differing range in its context) or are on one side only
 *
 * --image    the builder image (default: the one the configured tree was built in, from its build.json).
 * --summary  append the gate summary's Markdown to <file>, whatever the outcome.
 *
 * Exits 0 when it compared, identical or not (it reports; decision 4's "as built"); 1 when it could not compare.
 * It takes seconds once the image and the configured tree exist. The gate runs it, report-only, after its build.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BUILDER_IMAGE } from "./lib/builder.ts";
import { info, runCli } from "./lib/cli.ts";
import { UserError } from "./lib/git.ts";
import { layoutFor, repoRoot } from "./lib/layout.ts";
import {
  imageId,
  podman,
  refuseOtherContainers,
  removeBuildOutput,
  removeContainer,
  requirePodman,
} from "./lib/podman.ts";
import {
  configuredTree,
  defaultAgainst,
  materialisePostgres,
  otherDifferences,
  removeSide,
  requireSamePin,
  revisionSide,
  workingSide,
  type SeriesSide,
} from "./lib/tokens-series.ts";
import {
  compareTokens,
  compileCommand,
  formatComparison,
  makeDryRunCommand,
  POSTGRES_OBJECT,
  POSTGRES_SOURCE,
  preprocessCommand,
  preprocessRunCommand,
  TOKENS_CONTAINER,
  TOKENS_OUTPUT_MOUNT,
  tokenize,
  tokensSummary,
  type TokensOutcome,
} from "./lib/tokens.ts";

const USAGE = "Usage: bun run patches:tokens [--against <revision>] [--image <reference>] [--summary <file>]";

interface Options {
  against: string | undefined;
  image: string | undefined;
  summary: string | undefined;
}

function options(args: readonly string[]): Options {
  const parsed: Options = { against: undefined, image: undefined, summary: undefined };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) throw new UserError(USAGE);
    if (flag === "--against") parsed.against = value;
    else if (flag === "--image") parsed.image = value;
    else if (flag === "--summary") parsed.summary = value;
    else throw new UserError(USAGE);
  }
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a container of this check to its end; its output, or a UserError with podman's. */
function run(command: readonly string[], what: string): string {
  const result = podman(command.slice(1), { allowFailure: true });
  removeContainer(TOKENS_CONTAINER);
  if (result.exitCode !== 0) {
    const output = `${result.stdout}${result.stderr}`.trimEnd().split("\n").slice(-15);
    throw new UserError(
      [`patches:tokens: ${what} failed (exit ${result.exitCode}):`, ...output.map((line) => `  | ${line}`)].join("\n"),
    );
  }
  return result.stdout;
}

runCli(() => {
  const args = options(process.argv.slice(2));
  const layout = layoutFor(repoRoot);
  const started = Date.now();
  let fromLabel: string | undefined;
  const summarise = (outcome: TokensOutcome): void => {
    if (args.summary !== undefined) appendFileSync(args.summary, tokensSummary(outcome));
  };

  const state = join(layout.cacheDir, "tokens");
  let from: SeriesSide | undefined;
  try {
    const against = args.against ?? defaultAgainst(layout.root);
    removeBuildOutput(state);
    mkdirSync(state, { recursive: true });
    from = revisionSide(layout.root, against, join(state, "patches-against"));
    fromLabel = from.label;
    const to = workingSide(layout);
    requireSamePin(from, to);

    requirePodman();
    const tree = configuredTree(layout);
    const image = args.image ?? tree.image ?? BUILDER_IMAGE;
    if (imageId(image) === undefined) {
      throw new UserError(
        `The builder image ${image} is not in podman's local storage; pass the build's with --image.`,
      );
    }
    refuseOtherContainers();

    info(
      `patches:tokens: postgres.c of ${from.label} against ${to.label}, both on ${to.pin.tag} (${to.pin.commit.slice(0, 12)}).`,
    );
    const sides = [
      { name: "against", side: from },
      { name: "working", side: to },
    ] as const;
    const materialised = sides.map(({ name, side }) => {
      const result = materialisePostgres(layout, side, info);
      const file = join(state, name, POSTGRES_SOURCE);
      mkdirSync(join(state, name), { recursive: true });
      writeFileSync(file, result.source);
      return { name, file, commit: result.commit };
    });
    const [fromTree, toTree] = materialised;
    if (fromTree === undefined || toTree === undefined) throw new Error("unreachable");
    const others = otherDifferences(layout, fromTree.commit, toTree.commit);

    const built = tree.commit === undefined ? "a build" : `the build of ${tree.commit.slice(0, 12)}`;
    info(`patches:tokens: the configured tree of ${built}, ${relative(layout.root, tree.directory)}, in ${image}.`);
    const compile = compileCommand(
      run(makeDryRunCommand(image, tree.directory), "make -n"),
      POSTGRES_SOURCE,
      POSTGRES_OBJECT,
    );
    const streams = materialised.map(({ name, file }) => {
      const output = `${TOKENS_OUTPUT_MOUNT}/${name}.i`;
      const command = preprocessCommand(compile, POSTGRES_SOURCE, output);
      run(preprocessRunCommand(image, tree.directory, file, state, command), `preprocessing ${name}'s postgres.c`);
      return tokenize(readFileSync(join(state, `${name}.i`), "utf8"));
    });
    info(
      `patches:tokens: the build's command, as run: ${preprocessCommand(compile, POSTGRES_SOURCE, `${TOKENS_OUTPUT_MOUNT}/<side>.i`).join(" ")}`,
    );

    const comparison = compareTokens(streams[0] ?? [], streams[1] ?? []);
    const report = formatComparison(comparison, { from: from.label, to: "the working series" });
    for (const line of report) info(`patches:tokens: ${line}`);
    if (others.length > 0) {
      const shown = others.slice(0, 10).join(", ");
      info(
        `patches:tokens: the two series also differ in ${others.length} other file${others.length === 1 ? "" : "s"} (${shown}${others.length > 10 ? ", …" : ""}); both sides are preprocessed with the configured tree's.`,
      );
    }
    info(
      `patches:tokens: done in ${Math.round((Date.now() - started) / 1000)} s; the preprocessed files are in ${relative(layout.root, state)}.`,
    );
    summarise({ kind: "compared", from: from.label, comparison, report });
  } catch (error) {
    summarise({ kind: "not compared", from: fromLabel, reason: message(error) });
    throw error;
  } finally {
    if (from !== undefined) removeSide(from);
  }
});
