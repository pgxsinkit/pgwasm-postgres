/**
 * The weekly upstream poll (ADR-0001 decisions 7 and 8). `git ls-remote --tags` of upstream gives two targets (see
 * upstream-tags.ts): the newest newer release of the pinned major, which `bun run bump` moves the pin to on a branch
 * `bump/<tag>` from develop, opened as a pull request for review (or, when the bump could not commit, an issue); and
 * the newest tag of the next major, which `bun run readiness` reports as a comment on the one open "Postgres
 * <major> readiness" issue, whose body is a table of every reported tag. Everything it does is idempotent, so a
 * weekly run never duplicates anything: an existing `bump/<tag>` branch, or an open pull request or issue naming
 * the tag, skips the bump; a comment carrying `<!-- readiness:<tag> -->` skips the readiness run.
 *
 * Every command goes through a {@link Runner}, the seam the tests replace. With `dryRun` the commands that read are
 * run (`git ls-remote`, `git rev-parse`, `gh … list`, `gh api` GETs) and every command that writes anything, locally
 * or on GitHub, is printed instead.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { UpstreamPin } from "./config.ts";
import type { RunResult } from "./git.ts";
import type { Layout } from "./layout.ts";
import { parseStatus, type ReadinessStatus } from "./readiness.ts";
import { lsRemoteTagNames, pollTargets, rankTag, compareTags, type RankedTag } from "./upstream-tags.ts";

export interface RunOptions {
  /** Show the command's output as it runs (a bump, a readiness run), as well as returning it. */
  readonly stream?: boolean;
}

/** Runs a command and returns its exit code and output; never throws on a non-zero exit. */
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>;

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRefName: string;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
}

export interface Comment {
  readonly id: number;
  readonly url: string;
  readonly body: string;
}

function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./^{}-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** A command as a shell would take it. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

export class PollError extends Error {
  override name = "PollError";
}

async function succeed(run: Runner, argv: readonly string[]): Promise<string> {
  const result = await run(argv);
  if (result.exitCode !== 0) {
    throw new PollError(
      `\`${commandLine(argv)}\` exited ${result.exitCode}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 2000)}`,
    );
  }
  return result.stdout;
}

/** What the poll reads from GitHub, through `gh` (GH_TOKEN from the environment). */
export class GitHub {
  readonly repository: string;
  readonly #run: Runner;

  constructor(repository: string, run: Runner) {
    this.repository = repository;
    this.#run = run;
  }

  async #json(argv: readonly string[]): Promise<unknown> {
    const text = await succeed(this.#run, argv);
    return JSON.parse(text === "" ? "null" : text) as unknown;
  }

  /** Whether the repository has the branch (matching-refs matches a prefix: the exact ref is looked for). */
  async branchExists(branch: string): Promise<boolean> {
    const refs = await succeed(this.#run, [
      "gh",
      "api",
      `repos/${this.repository}/git/matching-refs/heads/${branch}`,
      "--jq",
      ".[].ref",
    ]);
    return refs.split("\n").includes(`refs/heads/${branch}`);
  }

  async openPullRequests(): Promise<PullRequest[]> {
    const list = await this.#json([
      "gh",
      "pr",
      "list",
      "--repo",
      this.repository,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,title,url,headRefName",
    ]);
    return Array.isArray(list) ? (list as PullRequest[]) : [];
  }

  async openIssues(): Promise<Issue[]> {
    const list = await this.#json([
      "gh",
      "issue",
      "list",
      "--repo",
      this.repository,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,title,url,body",
    ]);
    return Array.isArray(list) ? (list as Issue[]) : [];
  }

  /** An issue's comments, oldest first, every page. */
  async comments(issue: number): Promise<Comment[]> {
    const lines = await succeed(this.#run, [
      "gh",
      "api",
      "--paginate",
      `repos/${this.repository}/issues/${issue}/comments`,
      "--jq",
      ".[] | {id, url: .html_url, body}",
    ]);
    return lines
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Comment);
  }
}

/** Whether `text` names `tag` as a word of its own (`REL_18_7`, not `REL_18_70`). */
export function mentionsTag(text: string, tag: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${tag}($|[^A-Za-z0-9_])`).test(text);
}

export function bumpBranch(tag: string): string {
  return `bump/${tag}`;
}

export interface BumpState {
  readonly branchExists: boolean;
  readonly pullRequests: readonly PullRequest[];
  readonly issues: readonly Issue[];
}

/** Why the poll leaves the bump to `tag` alone this week; empty when it bumps. */
export function bumpSkipReasons(tag: string, state: BumpState): string[] {
  const branch = bumpBranch(tag);
  return [
    ...(state.branchExists ? [`the branch ${branch} exists on GitHub`] : []),
    ...state.pullRequests
      .filter((pr) => pr.headRefName === branch || mentionsTag(pr.title, tag))
      .map((pr) => `pull request #${pr.number} is open (${pr.title})`),
    ...state.issues
      .filter((issue) => mentionsTag(issue.title, tag))
      .map((issue) => `issue #${issue.number} is open (${issue.title})`),
  ];
}

export function readinessIssueTitle(major: number): string {
  return `Postgres ${major} readiness`;
}

/** The open readiness issue of a major: the oldest open issue with exactly its title. */
export function findReadinessIssue(issues: readonly Issue[], major: number): Issue | undefined {
  const title = readinessIssueTitle(major);
  return issues.filter((issue) => issue.title === title).sort((a, b) => a.number - b.number)[0];
}

export function readinessMarker(tag: string): string {
  return `<!-- readiness:${tag} -->`;
}

export function reportedIn(comments: readonly Comment[], tag: string): Comment | undefined {
  return comments.find((comment) => comment.body.includes(readinessMarker(tag)));
}

export interface ReadinessRow {
  readonly status: ReadinessStatus;
  readonly url: string;
}

/** The reported tags, from the comments that carry a marker and a status: newest tag first, the latest report each. */
export function readinessRows(comments: readonly Comment[]): ReadinessRow[] {
  const byTag = new Map<string, ReadinessRow>();
  for (const comment of comments) {
    const status = parseStatus(comment.body);
    if (status === undefined || !comment.body.includes(readinessMarker(status.tag))) continue;
    byTag.set(status.tag, { status, url: comment.url });
  }
  const rank = (row: ReadinessRow): RankedTag =>
    rankTag(row.status.tag) ?? { tag: row.status.tag, major: 0, kind: "beta", number: 0 };
  return [...byTag.values()].sort((a, b) => compareTags(rank(b), rank(a)));
}

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The readiness issue's body: what it is, and a table of every reported tag. */
export function readinessIssueBody(major: number, rows: readonly ReadinessRow[]): string {
  const lines = [
    `The series' readiness for PostgreSQL ${major} (ADR-0001 decision 8). The weekly poll (\`poll.yml\`, \`bun run poll\`) runs \`bun run readiness\` on each new tag of PostgreSQL ${major}: it applies the series onto the tag in a scratch copy, builds it once it applies, and runs pg_regress against the pinned major's baseline once it builds. Each tag's report is a comment below; this table is kept from them. Nothing here is a pull request or a commit: a major is adopted deliberately, through a \`port-${major}\` branch rebased onto main.`,
    "",
  ];
  if (rows.length === 0) {
    lines.push("No tag reported yet.");
  } else {
    lines.push(
      "| Tag | Series | Apply | Build | pg_regress | Report |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map(
        (row) =>
          `| \`${row.status.tag}\` | \`${row.status.series.slice(0, 12)}\` (${cell(row.status.pinned)}) | ${cell(row.status.apply)} | ${cell(row.status.build)} | ${cell(row.status.regress)} | [comment](${row.url}) |`,
      ),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** GitHub's limit on an issue's or pull request's body and on a comment is 65,536 characters. */
export const BODY_LIMIT = 65_000;

/**
 * `text` cut to `limit` characters at a line, with an open code fence and open `<details>` closed and a note
 * appended; `text` itself when it fits.
 */
export function bounded(text: string, note: string, limit = BODY_LIMIT): string {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - note.length - 200);
  const kept = text.slice(0, room);
  const lines = kept.slice(0, Math.max(0, kept.lastIndexOf("\n"))).split("\n");
  const fences = lines.filter((line) => /^`{3,}/.test(line));
  if (fences.length % 2 === 1) lines.push(fences.at(-1)?.match(/^`+/)?.[0] ?? "```");
  const open = lines.filter((line) => line.startsWith("<details>")).length;
  const closed = lines.filter((line) => line.startsWith("</details>")).length;
  for (let index = closed; index < open; index += 1) lines.push("", "</details>");
  lines.push("", `**${note}**`, "");
  return lines.join("\n");
}

const REVIEW_ONLY =
  "Review only: integrate it by fast-forwarding develop from the command line, never with a merge button. The poll pushed it with the workflow's `GITHUB_TOKEN`, so no workflow ran on it and it shows no checks: the engine gate's result is in the report below, and `gate.yml` runs when develop is pushed.";

export function bumpPullRequest(tag: string, report: string, blocked: boolean): { title: string; body: string } {
  const preface = [
    `Opened by the weekly upstream poll: \`bun run bump ${tag}\` on \`${bumpBranch(tag)}\`, from develop. ${REVIEW_ONLY}`,
    "",
    blocked
      ? "**Something stops this bump** (the report's STOP): it stays a draft until that is fixed, and what stops a bump is fixed, never recorded away. The records the report names are re-recorded on this branch, each in its own commit, after reading it."
      : "The records the report names are re-recorded on this branch, each in its own commit, after reading it; then two gates from clean and the release as usual.",
    "",
    "---",
    "",
  ].join("\n");
  return {
    title: `${blocked ? "[blocked] " : ""}Bump PostgreSQL to ${tag}`,
    body: bounded(
      `${preface}${report}`,
      `The report is cut here for GitHub's size limit: the whole of it is the poll run's artifact.`,
    ),
  };
}

/** The issue for a bump that could not commit: its conflict report, or bump's own output when it refused. */
export function bumpIssue(tag: string, report: string | undefined, output: string): { title: string; body: string } {
  if (report !== undefined) {
    const body = [
      `Opened by the weekly upstream poll: \`bun run bump ${tag}\` stopped on a conflict, so there is no commit to open a pull request with. Nothing changed on any branch. The conflict is resolved by hand, as the report says (\`bun run patches:work ${tag}\`), and the bump goes in as a pull request against develop; close this issue then.`,
      "",
      "---",
      "",
      report,
    ].join("\n");
    return {
      title: `Bump to ${tag}: the series does not apply`,
      body: bounded(
        body,
        "The report is cut here for GitHub's size limit: the whole of it is the poll run's artifact.",
      ),
    };
  }
  const tail = output.trimEnd().split("\n").slice(-60).join("\n");
  const body = [
    `Opened by the weekly upstream poll: \`bun run bump ${tag}\` refused the bump and wrote no report, so there is no commit to open a pull request with. Its output ends:`,
    "",
    "```text",
    tail,
    "```",
    "",
  ].join("\n");
  return { title: `Bump to ${tag}: bump refused it`, body: bounded(body, "The output is cut here.") };
}

export interface PollOptions {
  readonly dryRun: boolean;
  /** The builder image arguments bump and readiness get: `--lock`, `--image <ref>`, or none. */
  readonly imageArgs: readonly string[];
  /** The branch a bump starts from and its pull request targets. */
  readonly base: string;
}

export interface PollContext {
  readonly layout: Layout;
  readonly pin: UpstreamPin;
  readonly github: GitHub;
  readonly run: Runner;
  readonly log: (line: string) => void;
  /** The command that starts a package script: `[bun, "run"]`. */
  readonly bunRun: readonly string[];
}

/** What the poll did, and what it could not do. */
export interface PollResult {
  readonly bump: string | undefined;
  readonly readiness: string | undefined;
  readonly failures: readonly string[];
}

class Poll {
  readonly failures: string[] = [];
  readonly dir: string;

  readonly context: PollContext;
  readonly options: PollOptions;

  constructor(context: PollContext, options: PollOptions) {
    this.context = context;
    this.options = options;
    this.dir = join(context.layout.cacheDir, "poll");
  }

  log(line: string): void {
    this.context.log(line);
  }

  where(path: string): string {
    return relative(this.context.layout.root, path) || ".";
  }

  /** A command that writes: printed on a dry run, run otherwise. */
  async act(argv: readonly string[], options: RunOptions = {}): Promise<RunResult | undefined> {
    this.log(`poll: ${this.options.dryRun ? "would run" : "run"}: ${commandLine(argv)}`);
    if (this.options.dryRun) return undefined;
    return this.context.run(argv, options);
  }

  /** A command that writes and must succeed: its stdout, or undefined on a dry run. */
  async must(argv: readonly string[]): Promise<string | undefined> {
    const result = await this.act(argv);
    if (result === undefined) return undefined;
    if (result.exitCode !== 0) {
      throw new PollError(
        `\`${commandLine(argv)}\` exited ${result.exitCode}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 2000)}`,
      );
    }
    return result.stdout;
  }

  /** A file a command reads: written (under .cache/poll/), or on a dry run only named. */
  file(name: string, content: string): string {
    const path = join(this.dir, name);
    if (this.options.dryRun) return this.where(path);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path, content);
    return this.where(path);
  }

  async read(argv: readonly string[]): Promise<string> {
    return (await succeed(this.context.run, argv)).trim();
  }

  async bump(tag: string, pullRequests: readonly PullRequest[], issues: readonly Issue[]): Promise<void> {
    const { github } = this.context;
    const branch = bumpBranch(tag);
    const reasons = bumpSkipReasons(tag, {
      branchExists: await github.branchExists(branch),
      pullRequests,
      issues,
    });
    if (reasons.length > 0) {
      this.log(`poll: bump to ${tag}: nothing to do: ${reasons.join("; ")}.`);
      return;
    }
    const base = this.options.base;
    const current = await this.read(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    const changes = await this.read(["git", "status", "--porcelain"]);
    const problems = [
      ...(current === base ? [] : [`HEAD is on ${current}, not ${base}, which a bump starts from`]),
      ...(changes === "" ? [] : ["the working tree has changes"]),
    ];
    if (problems.length > 0 && !this.options.dryRun) {
      throw new PollError(`bump to ${tag}: ${problems.join("; ")}.`);
    }
    for (const problem of problems) this.log(`poll: note: ${problem}: the real run would refuse to bump.`);
    const remote =
      (await this.context.run(["git", "config", "--get", `branch.${base}.remote`])).stdout.trim() || "origin";
    const before = await this.read(["git", "rev-parse", "HEAD"]);
    const report = join(this.dir, `bump-${tag}.md`);
    const reportName = this.where(report);
    this.log(`poll: bump to ${tag}, on ${branch} from ${base} (${before.slice(0, 12)})`);
    if (!this.options.dryRun) {
      mkdirSync(this.dir, { recursive: true });
      rmSync(report, { force: true });
    }
    await this.must(["git", "switch", "--quiet", "--create", branch]);
    try {
      const bump = await this.act(
        [...this.context.bunRun, "bump", tag, ...this.options.imageArgs, "--report", reportName],
        {
          stream: true,
        },
      );
      if (bump === undefined) {
        this.log(`poll: then, if bump committed (HEAD moved from ${before.slice(0, 12)}):`);
        await this.act(["git", "push", remote, branch]);
        const pr = bumpPullRequest(tag, "(the report)", false);
        await this.act(this.pullRequestCommand(branch, pr.title, this.file(`bump-${tag}.pr.md`, pr.body), false));
        this.log(
          `poll: (a draft, titled "${bumpPullRequest(tag, "", true).title}", when bump exits 1: something blocks it)`,
        );
        this.log("poll: otherwise (a conflicting apply, or a refusal: no commit, so no pull request):");
        const issue = bumpIssue(tag, "(the conflict report)", "");
        await this.act(this.issueCommand(issue.title, this.file(`bump-${tag}.issue.md`, issue.body)));
        return;
      }
      const after = await this.read(["git", "rev-parse", "HEAD"]);
      if (after !== before) {
        await this.must(["git", "push", remote, branch]);
        const blocked = bump.exitCode !== 0;
        const pr = bumpPullRequest(
          tag,
          existsSync(report) ? readFileSync(report, "utf8") : "(bump wrote no report)",
          blocked,
        );
        const url = await this.must(
          this.pullRequestCommand(branch, pr.title, this.file(`bump-${tag}.pr.md`, pr.body), blocked),
        );
        this.log(`poll: bump to ${tag}: ${blocked ? "draft " : ""}pull request ${url?.trim() ?? ""}`);
        return;
      }
      const issue = bumpIssue(
        tag,
        existsSync(report) ? readFileSync(report, "utf8") : undefined,
        bump.stdout + bump.stderr,
      );
      const url = await this.must(this.issueCommand(issue.title, this.file(`bump-${tag}.issue.md`, issue.body)));
      this.log(`poll: bump to ${tag}: no commit (bump exited ${bump.exitCode}); issue ${url?.trim() ?? ""}`);
    } finally {
      await this.must(["git", "switch", "--quiet", base]);
    }
  }

  pullRequestCommand(branch: string, title: string, bodyFile: string, draft: boolean): string[] {
    const repo = this.context.github.repository;
    return [
      "gh",
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      this.options.base,
      "--head",
      branch,
      "--title",
      title,
      "--body-file",
      bodyFile,
      ...(draft ? ["--draft"] : []),
    ];
  }

  issueCommand(title: string, bodyFile: string): string[] {
    return [
      "gh",
      "issue",
      "create",
      "--repo",
      this.context.github.repository,
      "--title",
      title,
      "--body-file",
      bodyFile,
    ];
  }

  async readiness(tag: string, major: number, issues: readonly Issue[]): Promise<void> {
    const { github } = this.context;
    const repo = github.repository;
    const title = readinessIssueTitle(major);
    const issue = findReadinessIssue(issues, major);
    let number: string;
    let body = issue?.body;
    if (issue === undefined) {
      this.log(
        `poll: readiness: no open issue "${title}"; ${this.options.dryRun ? "it would be created" : "creating it"}`,
      );
      const created = await this.must([
        "gh",
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        title,
        "--body-file",
        this.file(`readiness-${major}.body.md`, readinessIssueBody(major, [])),
      ]);
      const match = /\/issues\/(\d+)/.exec(created ?? "");
      number = match?.[1] ?? "<the new issue>";
      body = readinessIssueBody(major, []);
      if (created !== undefined && match === null)
        throw new PollError(`gh issue create printed no issue URL: ${created}`);
    } else {
      number = String(issue.number);
      this.log(`poll: readiness: issue #${number} (${issue.url})`);
    }
    let comments = /^\d+$/.test(number) ? await github.comments(Number(number)) : [];
    const reported = reportedIn(comments, tag);
    if (reported !== undefined) {
      this.log(`poll: readiness of ${tag}: already reported (${reported.url})`);
    } else {
      const report = join(this.dir, `readiness-${tag}.md`);
      const reportName = this.where(report);
      if (!this.options.dryRun) {
        mkdirSync(this.dir, { recursive: true });
        rmSync(report, { force: true });
      }
      const run = await this.act(
        [...this.context.bunRun, "readiness", tag, ...this.options.imageArgs, "--report", reportName],
        { stream: true },
      );
      if (run !== undefined && (run.exitCode !== 0 || !existsSync(report))) {
        throw new PollError(`readiness of ${tag}: \`bun run readiness\` exited ${run.exitCode} without a report.`);
      }
      const text = run === undefined ? "(the report)" : readFileSync(report, "utf8");
      const comment = bounded(
        `${readinessMarker(tag)}\n${text}`,
        "The report is cut here for GitHub's size limit: the whole of it is the poll run's artifact.",
      );
      const url = await this.must([
        "gh",
        "issue",
        "comment",
        number,
        "--repo",
        repo,
        "--body-file",
        this.file(`readiness-${tag}.comment.md`, comment),
      ]);
      if (url !== undefined) this.log(`poll: readiness of ${tag}: reported in ${url.trim()}`);
      if (!this.options.dryRun) comments = await github.comments(Number(number));
    }
    if (this.options.dryRun && reported === undefined) {
      await this.act([
        "gh",
        "issue",
        "edit",
        number,
        "--repo",
        repo,
        "--body-file",
        this.file(`readiness-${major}.body.md`, "(the table, with the new report's row)"),
      ]);
      return;
    }
    const table = readinessIssueBody(major, readinessRows(comments));
    if (table === body) {
      this.log(`poll: readiness: issue #${number}'s table is up to date`);
      return;
    }
    await this.must([
      "gh",
      "issue",
      "edit",
      number,
      "--repo",
      repo,
      "--body-file",
      this.file(`readiness-${major}.body.md`, table),
    ]);
  }
}

/** One poll: decides the bump and the readiness targets and acts on each, idempotently. */
export async function poll(context: PollContext, options: PollOptions): Promise<PollResult> {
  const state = new Poll(context, options);
  const listing = await succeed(context.run, ["git", "ls-remote", "--tags", context.pin.repository]);
  const targets = pollTargets(context.pin.tag, lsRemoteTagNames(listing));
  context.log(
    `poll: ${context.pin.tag} is pinned; bump: ${targets.bump ?? `none (${context.pin.tag} is PostgreSQL ${targets.pinned.major}'s newest release)`}; readiness: ${targets.readiness ?? `none (PostgreSQL ${targets.nextMajor} has no tag yet)`}${options.dryRun ? " (dry run: nothing that writes runs)" : ""}`,
  );
  if (targets.bump === undefined && targets.readiness === undefined) {
    return { bump: undefined, readiness: undefined, failures: [] };
  }
  const issues = await context.github.openIssues();
  if (targets.bump !== undefined) {
    try {
      await state.bump(targets.bump, await context.github.openPullRequests(), issues);
    } catch (error) {
      if (!(error instanceof PollError)) throw error;
      state.failures.push(error.message);
    }
  }
  if (targets.readiness !== undefined) {
    try {
      await state.readiness(targets.readiness, targets.nextMajor, issues);
    } catch (error) {
      if (!(error instanceof PollError)) throw error;
      state.failures.push(error.message);
    }
  }
  return { bump: targets.bump, readiness: targets.readiness, failures: state.failures };
}
