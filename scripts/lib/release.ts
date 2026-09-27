/**
 * The release (ADR-0001 decisions 5, 7 and 9). A release is a tag `N.N.N` on a commit whose engine gate passed:
 * `release.yml` refuses a tag that is not the commit's candidate version ({@link releaseTagProblems}), runs the gate
 * at the tag, downloads the gated build of the same commit from a successful `gate.yml` run ({@link chooseGateRun}),
 * requires the two manifests to be identical ({@link publishProblems}), and creates the GitHub release with every
 * file of the gate directory as an asset and notes generated from the manifest ({@link releaseNotes}).
 */
import { diffExports, parseExportList } from "./exports.ts";
import {
  changeLine,
  compareGateManifests,
  dataFormatLine,
  filesTable,
  regressLine,
  type GateManifest,
} from "./gate.ts";
import { git } from "./git.ts";
import { ancestorTags, formatVersion, parseReleaseTag, type Version } from "./version.ts";

/** What the release job knows about a tag when it starts. */
export interface TagFacts {
  readonly tag: string;
  /** The commit the tag resolves to, or undefined when there is no such tag. */
  readonly tagCommit: string | undefined;
  /** The commit checked out. */
  readonly head: string;
  /** The candidate version of `head` (scripts/lib/version.ts). */
  readonly candidate: string;
}

/** Why a tag cannot be released at `head`; empty when it can. */
export function releaseTagProblems(facts: TagFacts): string[] {
  if (parseReleaseTag(facts.tag) === undefined) {
    return [`${facts.tag} is not a release tag (N.N.N, unprefixed, no leading zeros).`];
  }
  const problems: string[] = [];
  if (facts.tagCommit === undefined) problems.push(`there is no tag ${facts.tag}.`);
  else if (facts.tagCommit !== facts.head) {
    problems.push(`${facts.tag} is ${facts.tagCommit}, but the checkout is ${facts.head}.`);
  }
  if (facts.tag !== facts.candidate) {
    problems.push(
      `${facts.tag} is not the candidate version of ${facts.head.slice(0, 12)}, which is ${facts.candidate} (derived from the release tags of its ancestors and the pinned upstream tag).`,
    );
  }
  return problems;
}

/** The latest release tag (`N.N.N`) among `commit`'s strict ancestors, or undefined before the first release. */
export function previousRelease(root: string, commit = "HEAD"): string | undefined {
  const compare = (a: Version, b: Version): number => a.major - b.major || a.minor - b.minor || a.revision - b.revision;
  const latest = ancestorTags(root, commit)
    .map(parseReleaseTag)
    .filter((version): version is Version => version !== undefined)
    .sort(compare)
    .at(-1);
  return latest === undefined ? undefined : formatVersion(latest);
}

/** The reference export list committed at a tag, or undefined when the tag has none. */
export function exportsAt(root: string, tag: string): string[] | undefined {
  const show = git(["show", `refs/tags/${tag}:exported_functions.txt`], { cwd: root, allowFailure: true });
  return show.exitCode === 0 ? parseExportList(show.stdout) : undefined;
}

/** A `gate.yml` run, as `gh run list --json databaseId,status,conclusion,createdAt,url` lists it. */
export interface GateRun {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly createdAt: string;
  readonly url: string;
}

export type RunChoice =
  | { readonly kind: "use"; readonly run: GateRun }
  | { readonly kind: "wait"; readonly run: GateRun }
  | { readonly kind: "none"; readonly reason: string };

/**
 * The gate run whose build is the gated one: the latest successful run for the commit; else the latest run still
 * going, to wait for; else none.
 */
export function chooseGateRun(runs: readonly GateRun[]): RunChoice {
  const latestFirst = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const succeeded = latestFirst.find((run) => run.status === "completed" && run.conclusion === "success");
  if (succeeded !== undefined) return { kind: "use", run: succeeded };
  const going = latestFirst.find((run) => run.status !== "completed");
  if (going !== undefined) return { kind: "wait", run: going };
  return {
    kind: "none",
    reason:
      runs.length === 0
        ? "gate.yml never ran on it"
        : `gate.yml ran on it ${runs.length} time${runs.length === 1 ? "" : "s"}, never successfully (${latestFirst.map((run) => run.conclusion || run.status).join(", ")})`,
  };
}

export interface PublishInput {
  readonly tag: string;
  readonly head: string;
  readonly tagCommit: string | undefined;
  /** This job's gate. */
  readonly ours: GateManifest;
  /** The gated build: the gate.yml run's. */
  readonly gated: GateManifest;
  /** A dry run reports a missing tag and a build outside the published image instead of refusing them. */
  readonly dryRun: boolean;
}

/** Why the release cannot be published (errors), and what only a dry run lets pass (warnings). */
export function publishProblems(input: PublishInput): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const soft = (message: string): void => {
    (input.dryRun ? warnings : errors).push(message);
  };
  if (input.ours.version !== input.tag) errors.push(`the gate built ${input.ours.version}, not ${input.tag}.`);
  if (input.ours.commit !== input.head)
    errors.push(`the gate is of ${input.ours.commit}, not the checkout ${input.head}.`);
  if (input.tagCommit === undefined) soft(`there is no tag ${input.tag}.`);
  else if (input.tagCommit !== input.head) errors.push(`${input.tag} is ${input.tagCommit}, not ${input.head}.`);
  if (input.ours.builder.digest === null) {
    soft(`the build ran in ${input.ours.builder.image}, not the published builder image: a release is built with it.`);
  }
  for (const line of compareGateManifests(input.gated, input.ours))
    errors.push(`differs from the gated build: ${line}`);
  return { errors, warnings };
}

export interface NotesInput {
  readonly manifest: GateManifest;
  /** The build's export list (the gate directory's exported_functions.txt). */
  readonly exports: readonly string[];
  /** The previous release and the export list committed at it, when there is one. */
  readonly previous: { readonly tag: string; readonly exports: readonly string[] | undefined } | undefined;
}

function previousExportsLine(input: NotesInput): string {
  if (input.previous === undefined) return "The first release: there is no earlier export list to compare with.";
  if (input.previous.exports === undefined) return `\`${input.previous.tag}\` has no export list to compare with.`;
  const diff = diffExports(input.previous.exports, input.exports, []);
  return `Against \`${input.previous.tag}\` (its \`exported_functions.txt\`): ${changeLine(diff.added, diff.removed)}.`;
}

/** The release's notes, from its gate manifest. */
export function releaseNotes(input: NotesInput): string {
  const { manifest } = input;
  const pg = /^REL_(\d+)_(\d+)$/.exec(manifest.upstream.tag);
  const pgVersion = pg === null ? manifest.upstream.tag : `${pg[1]}.${pg[2]}`;
  return [
    `PostgreSQL ${pgVersion} for WebAssembly: upstream \`${manifest.upstream.tag}\` (\`${manifest.upstream.commit}\`) with this repository's patch series and overlay at \`${manifest.commit}\` (tree \`${manifest.tree}\`). \`SELECT version()\` reads \`PostgreSQL ${pgVersion} (pgwasm-postgres ${manifest.version}) on wasm32-unknown-emscripten, …\`.`,
    "",
    "## Assets",
    "",
    ...filesTable(manifest.files),
    "",
    "`sha256sum -c SHA256SUMS` checks them; `manifest.json` records what they were built from and what the engine gate found.",
    "",
    "## Data format",
    "",
    `${dataFormatLine(manifest)}.`,
    "",
    "## Engine gate",
    "",
    `- ${regressLine(manifest.regress)}.`,
    `- Export list: ${manifest.exports.symbols.toLocaleString("en-US")} symbols. ${previousExportsLine(input)} Against the reference at the commit: ${changeLine(manifest.exports.added, manifest.exports.removed)}.`,
    `- Reproduced: the release job rebuilt the commit from scratch (SOURCE_DATE_EPOCH ${manifest.sourceDateEpoch}, ${new Date(manifest.sourceDateEpoch * 1000).toISOString()}) and its manifest is identical to the gated build's, so these are the bytes the gate tested.`,
    "",
    "## Builder image",
    "",
    `\`${manifest.builder.image}\` (image id \`${manifest.builder.id}\`), ${manifest.builder.digest === null ? "a local build of" : "the published image of"} builder/ \`${manifest.builder.contentSha256}\`${manifest.builder.digest === null ? ", not the published image" : ""}.`,
    "",
  ].join("\n");
}

/** The command that creates the release: the tag must exist on GitHub; every gate file is an asset. */
export function releaseCommand(tag: string, notesFile: string, files: readonly string[]): string[] {
  return ["gh", "release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", notesFile, ...files];
}
