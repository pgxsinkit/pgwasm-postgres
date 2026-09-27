/**
 * What a `bun run regress` gate run found, written to .cache/regress/outcome.json for the engine gate
 * (`bun run gate`), which puts its reproducible part into the release manifest: the baseline the run was compared
 * with (its summary and a digest of regress/), the verdict, and the vanished failures. The runs' own counts and
 * times stay here: an unstable test's outcome may differ between two gates of one commit.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { directoryDigest } from "../digest.ts";
import { UserError } from "../git.ts";
import type { Layout } from "../layout.ts";
import type { Baseline, Comparison } from "./baseline.ts";

export interface RegressOutcome {
  readonly upstream: { readonly tag: string; readonly commit: string };
  readonly schedule: string;
  /** The builder image the client ran in. */
  readonly image: string;
  /** The sha256 of each file the runs used, by name (the artefacts, and a regress library if one was given). */
  readonly ranWith: Readonly<Record<string, string>>;
  readonly baseline: { readonly sha256: string; readonly summary: Baseline["summary"] };
  readonly passed: boolean;
  readonly comparison: Omit<Comparison, "unstable"> & { readonly unstable: readonly string[] };
  readonly runs: readonly {
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly backendFailures: number;
    readonly seconds: number;
  }[];
}

export function outcomePath(layout: Layout): string {
  return join(layout.regressCache, "outcome.json");
}

/** The digest of regress/ (the baseline and its diffs), which says which baseline a run was compared with. */
export function baselineDigest(layout: Layout): string {
  return directoryDigest(dirname(layout.regressBaseline));
}

export function clearOutcome(layout: Layout): void {
  rmSync(outcomePath(layout), { force: true });
}

export function writeOutcome(layout: Layout, outcome: RegressOutcome): void {
  writeFileSync(outcomePath(layout), `${JSON.stringify(outcome, null, 2)}\n`);
}

export function readOutcome(layout: Layout): RegressOutcome {
  const file = outcomePath(layout);
  if (!existsSync(file)) throw new UserError(`${file} is missing: \`bun run regress\` wrote no outcome.`);
  return JSON.parse(readFileSync(file, "utf8")) as RegressOutcome;
}
