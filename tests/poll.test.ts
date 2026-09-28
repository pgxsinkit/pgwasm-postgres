import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunResult } from "../scripts/lib/git.ts";
import { layoutFor, repoRoot, type Layout } from "../scripts/lib/layout.ts";
import {
  bounded,
  bumpIssue,
  bumpPullRequest,
  bumpSkipReasons,
  commandLine,
  findReadinessIssue,
  GitHub,
  mentionsTag,
  poll,
  PORT_CHECKLIST,
  portChecklistSection,
  readinessIssueBody,
  readinessMarker,
  readinessRows,
  type Comment,
  type Issue,
  type PullRequest,
  type Runner,
} from "../scripts/lib/poll.ts";
import { formatStatus, type ReadinessStatus } from "../scripts/lib/readiness.ts";
import { Fixtures, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());

const REPO = "pgxsinkit/pgwasm-postgres";
const UPSTREAM = "https://github.com/postgres/postgres.git";
const TAGS = ["REL_18_3", "REL_18_4", "REL_18_6", "REL_18_RC1", "REL_19_BETA1", "REL_19_BETA3", "REL_19_BETA4"];

function status(tag: string, apply: string): ReadinessStatus {
  return {
    tag,
    commit: "b".repeat(40),
    series: "c".repeat(40),
    pinned: "REL_18_6",
    apply,
    build: "not run",
    regress: "not run",
  };
}

function reportOf(tag: string, apply: string): string {
  return `${formatStatus(status(tag, apply))}\n# PostgreSQL 19 readiness: \`${tag}\`\n`;
}

const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });

/** A port checklist as docs/port-checklist.md has it: a title, a paragraph and items. */
const CHECKLIST =
  "# Port checklist: the next Postgres major\n\nWhat it takes.\n\n- **Port the series** first.\n- **Records** last.\n";

/** A GitHub repository and an upstream, as the poll's runner sees them; every command is recorded. */
class World {
  readonly calls: string[] = [];
  readonly logs: string[] = [];
  branches: string[] = [];
  pullRequests: PullRequest[] = [];
  issues: Issue[] = [];
  comments = new Map<number, Comment[]>();
  heads: string[] = ["1".repeat(40)];
  bump: (report: string) => RunResult = () => ok();
  readiness: (report: string) => RunResult = (report) => {
    writeFileSync(report, reportOf("REL_19_BETA4", "conflict in `0001`"));
    return ok();
  };
  readonly layout: Layout;

  constructor(layout: Layout) {
    this.layout = layout;
  }

  #afterFlag(argv: readonly string[], flag: string): string {
    return argv[argv.indexOf(flag) + 1] ?? "";
  }

  readonly run: Runner = async (argv) => {
    const line = commandLine(argv);
    this.calls.push(line);
    const [command, sub] = argv;
    if (command === "git" && sub === "ls-remote") {
      return ok(TAGS.map((tag, index) => `${String(index).repeat(40)}\trefs/tags/${tag}\n`).join(""));
    }
    if (line.startsWith("git rev-parse --abbrev-ref HEAD")) return ok("develop\n");
    if (line === "git rev-parse HEAD") return ok(`${this.heads.length > 1 ? this.heads.shift() : this.heads[0]}\n`);
    if (line === "git status --porcelain") return ok("");
    if (line === "git config --get branch.develop.remote") return ok("origin\n");
    if (command === "git") return ok();
    if (command === "bun") {
      const report = join(this.layout.root, this.#afterFlag(argv, "--report"));
      return argv[2] === "bump" ? this.bump(report) : this.readiness(report);
    }
    if (line.startsWith(`gh api repos/${REPO}/git/matching-refs/heads/`)) {
      const prefix = (argv[2] ?? "").split("/heads/")[1] ?? "";
      return ok(
        this.branches
          .filter((branch) => branch.startsWith(prefix))
          .map((b) => `refs/heads/${b}\n`)
          .join(""),
      );
    }
    if (line.startsWith("gh pr list")) return ok(JSON.stringify(this.pullRequests));
    if (line.startsWith("gh issue list")) return ok(JSON.stringify(this.issues));
    if (line.startsWith("gh api --paginate")) {
      const issue = Number(/issues\/(\d+)\/comments/.exec(line)?.[1]);
      return ok((this.comments.get(issue) ?? []).map((comment) => `${JSON.stringify(comment)}\n`).join(""));
    }
    if (line.startsWith("gh issue create")) {
      const number = 40 + this.issues.length;
      const body = readFileSync(join(this.layout.root, this.#afterFlag(argv, "--body-file")), "utf8");
      this.issues.push({
        number,
        title: this.#afterFlag(argv, "--title"),
        url: `https://github.com/${REPO}/issues/${number}`,
        body,
      });
      return ok(`https://github.com/${REPO}/issues/${number}\n`);
    }
    if (line.startsWith("gh issue comment")) {
      const number = Number(argv[3]);
      const body = readFileSync(join(this.layout.root, this.#afterFlag(argv, "--body-file")), "utf8");
      const list = this.comments.get(number) ?? [];
      const id = 900 + list.length;
      const url = `https://github.com/${REPO}/issues/${number}#issuecomment-${id}`;
      this.comments.set(number, [...list, { id, url, body }]);
      return ok(`${url}\n`);
    }
    if (line.startsWith("gh issue edit")) {
      const number = Number(argv[3]);
      const body = readFileSync(join(this.layout.root, this.#afterFlag(argv, "--body-file")), "utf8");
      this.issues = this.issues.map((issue) => (issue.number === number ? { ...issue, body } : issue));
      return ok();
    }
    if (line.startsWith("gh pr create")) return ok(`https://github.com/${REPO}/pull/12\n`);
    throw new Error(`unexpected command: ${line}`);
  };

  async poll(pinTag: string, dryRun: boolean) {
    return poll(
      {
        layout: this.layout,
        pin: { repository: UPSTREAM, tag: pinTag, commit: "a".repeat(40) },
        github: new GitHub(REPO, this.run),
        run: this.run,
        log: (line) => this.logs.push(line),
        bunRun: ["bun", "run"],
      },
      { dryRun, imageArgs: ["--lock"], base: "develop" },
    );
  }

  /** The commands that write, locally or on GitHub. */
  writes(): string[] {
    return this.calls.filter(
      (line) =>
        !/^git (ls-remote|rev-parse|status|config --get)|^gh (api (--paginate )?repos\/[^ ]+ --jq|api repos|pr list|issue list)/.test(
          line,
        ),
    );
  }
}

function world(): World {
  const layout = layoutFor(fixtures.dir("poll"));
  write(join(layout.root, PORT_CHECKLIST), CHECKLIST);
  return new World(layout);
}

describe("the poll's decisions", () => {
  test("a tag is named as a word of its own", () => {
    expect(mentionsTag("Bump PostgreSQL to REL_18_7", "REL_18_7")).toBe(true);
    expect(mentionsTag("bump/REL_18_7", "REL_18_7")).toBe(true);
    expect(mentionsTag("Bump to REL_18_70", "REL_18_7")).toBe(false);
    expect(mentionsTag("XREL_18_7", "REL_18_7")).toBe(false);
  });

  test("an existing branch, or an open pull request or issue naming the tag, skips the bump", () => {
    const pr = (number: number, title: string, headRefName: string): PullRequest => ({
      number,
      title,
      headRefName,
      url: `u${number}`,
    });
    const issue = (number: number, title: string): Issue => ({ number, title, url: `u${number}`, body: "" });
    expect(bumpSkipReasons("REL_18_7", { branchExists: false, pullRequests: [], issues: [] })).toEqual([]);
    expect(bumpSkipReasons("REL_18_7", { branchExists: true, pullRequests: [], issues: [] })).toEqual([
      "the branch bump/REL_18_7 exists on GitHub",
    ]);
    expect(
      bumpSkipReasons("REL_18_7", {
        branchExists: false,
        pullRequests: [
          pr(3, "Something else", "bump/REL_18_7"),
          pr(4, "By hand: REL_18_7", "mine"),
          pr(5, "REL_18_70", "x"),
        ],
        issues: [issue(6, "Bump to REL_18_7: the series does not apply"), issue(7, "Postgres 19 readiness")],
      }),
    ).toEqual([
      "pull request #3 is open (Something else)",
      "pull request #4 is open (By hand: REL_18_7)",
      "issue #6 is open (Bump to REL_18_7: the series does not apply)",
    ]);
  });

  test("the readiness issue is the oldest open one with exactly its title, and its table comes from the marked reports", () => {
    const issues: Issue[] = [
      { number: 9, title: "Postgres 19 readiness", url: "u9", body: "" },
      { number: 4, title: "Postgres 19 readiness", url: "u4", body: "" },
      { number: 2, title: "Postgres 19 readiness?", url: "u2", body: "" },
    ];
    expect(findReadinessIssue(issues, 19)?.number).toBe(4);
    expect(findReadinessIssue(issues, 20)).toBeUndefined();

    const comments: Comment[] = [
      {
        id: 1,
        url: "c1",
        body: `${readinessMarker("REL_19_BETA3")}\n${reportOf("REL_19_BETA3", "conflict in `0001`")}`,
      },
      { id: 2, url: "c2", body: "A human's remark, with REL_19_BETA4 in it." },
      // A status without its marker is not a report.
      { id: 3, url: "c3", body: reportOf("REL_19_BETA2", "applies") },
      { id: 4, url: "c4", body: `${readinessMarker("REL_19_RC1")}\n${reportOf("REL_19_RC1", "applies | 3-way")}` },
    ];
    const rows = readinessRows(comments);
    expect(rows.map((row) => [row.status.tag, row.url])).toEqual([
      ["REL_19_RC1", "c4"],
      ["REL_19_BETA3", "c1"],
    ]);
    const body = readinessIssueBody(19, rows, CHECKLIST);
    expect(body).toContain("a `port-19` branch rebased onto main");
    expect(body).toContain("| Tag | Series | Apply | Build | pg_regress | Report |");
    expect(body).toContain(
      "| `REL_19_RC1` | `cccccccccccc` (REL_18_6) | applies \\| 3-way | not run | not run | [comment](c4) |",
    );
    expect(readinessIssueBody(19, [], CHECKLIST)).toContain("No tag reported yet.");
  });

  test("the port checklist is a section of its own under the table, without the file's title", () => {
    const rows = readinessRows([
      { id: 1, url: "c1", body: `${readinessMarker("REL_19_BETA4")}\n${reportOf("REL_19_BETA4", "applies")}` },
    ]);
    const body = readinessIssueBody(19, rows, CHECKLIST);
    expect(body.indexOf("| Tag | Series |")).toBeLessThan(body.indexOf("## Port checklist"));
    expect(body).toEndWith(
      "## Port checklist\n\nWhat it takes.\n\n- **Port the series** first.\n- **Records** last.\n",
    );
    expect(body).not.toContain("# Port checklist: the next Postgres major");
    expect(readinessIssueBody(19, [], CHECKLIST)).toContain("No tag reported yet.\n\n## Port checklist\n");
    expect(portChecklistSection("- one\r\n- two\r\n")).toEqual(["## Port checklist", "", "- one", "- two"]);
  });

  test("the committed checklist renders with every step of a port", () => {
    const section = portChecklistSection(readFileSync(join(repoRoot, PORT_CHECKLIST), "utf8")).join("\n");
    for (const step of [
      "**Port the series**",
      "**Rename the internal PGlite names**",
      "**ICU**",
      "**dataFormat**",
      "**Records**",
      "**Store compatibility**",
      "**pgxsinkit**",
    ]) {
      expect(section).toContain(`- ${step}`);
    }
    expect(section).not.toMatch(/^# /m);
    expect(section).not.toMatch(/\]\((?!https?:)/);
  });

  test("a body over GitHub's limit is cut at a line, its fence and details closed, with a note", () => {
    expect(bounded("short", "cut")).toBe("short");
    const text = [
      "# Report",
      "<details>",
      "```text",
      ...Array.from({ length: 400 }, (_, i) => `line ${i}`),
      "```",
      "</details>",
    ].join("\n");
    const cut = bounded(text, "Cut here.", 1000);
    expect(cut.length).toBeLessThanOrEqual(1000);
    expect(cut).toEndWith("```\n\n</details>\n\n**Cut here.**\n");
    expect(cut.split("\n").filter((line) => line.startsWith("```")).length % 2).toBe(0);
  });

  test("the pull request and the issue say what they are", () => {
    const pr = bumpPullRequest("REL_18_7", "# Bump REL_18_6 → REL_18_7", false);
    expect(pr.title).toBe("Bump PostgreSQL to REL_18_7");
    expect(pr.body).toContain("Review only: integrate it by fast-forwarding develop from the command line");
    expect(pr.body).toContain("no workflow ran on it");
    expect(pr.body).toEndWith("# Bump REL_18_6 → REL_18_7");
    expect(bumpPullRequest("REL_18_7", "", true).title).toBe("[blocked] Bump PostgreSQL to REL_18_7");
    expect(bumpIssue("REL_18_7", "# CONFLICT", "").title).toBe("Bump to REL_18_7: the series does not apply");
    const refused = bumpIssue("REL_18_7", undefined, "bump: refusing REL_18_7: it does not resolve to a commit.\n");
    expect(refused.title).toBe("Bump to REL_18_7: bump refused it");
    expect(refused.body).toContain("bump: refusing REL_18_7");
  });

  test("a command is printed as a shell would take it", () => {
    expect(commandLine(["gh", "issue", "create", "--title", "Postgres 19 readiness", "--body-file", "a/b.md"])).toBe(
      "gh issue create --title 'Postgres 19 readiness' --body-file a/b.md",
    );
    expect(commandLine(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
  });
});

describe("the poll", () => {
  test("today, on a dry run: no bump, and the readiness of REL_19_BETA4 planned, nothing written", async () => {
    const w = world();
    const result = await w.poll("REL_18_6", true);
    expect(result).toEqual({ bump: undefined, readiness: "REL_19_BETA4", failures: [] });
    expect(w.writes()).toEqual([]);
    expect(existsSync(join(w.layout.cacheDir, "poll"))).toBe(false);
    const planned = w.logs.filter((line) => line.startsWith("poll: would run: ")).map((line) => line.slice(17));
    expect(planned).toEqual([
      `gh issue create --repo ${REPO} --title 'Postgres 19 readiness' --body-file .cache/poll/readiness-19.body.md`,
      "bun run readiness REL_19_BETA4 --lock --report .cache/poll/readiness-REL_19_BETA4.md",
      `gh issue comment '<the new issue>' --repo ${REPO} --body-file .cache/poll/readiness-REL_19_BETA4.comment.md`,
      `gh issue edit '<the new issue>' --repo ${REPO} --body-file .cache/poll/readiness-19.body.md`,
    ]);
  });

  test("a dry run plans the bump's branch, its command and its pull request", async () => {
    const w = world();
    await w.poll("REL_18_3", true);
    expect(w.writes()).toEqual([]);
    const planned = w.logs.filter((line) => line.startsWith("poll: would run: ")).map((line) => line.slice(17));
    expect(planned.slice(0, 5)).toEqual([
      "git switch --quiet --create bump/REL_18_6",
      "bun run bump REL_18_6 --lock --report .cache/poll/bump-REL_18_6.md",
      "git push origin bump/REL_18_6",
      `gh pr create --repo ${REPO} --base develop --head bump/REL_18_6 --title 'Bump PostgreSQL to REL_18_6' --body-file .cache/poll/bump-REL_18_6.pr.md`,
      `gh issue create --repo ${REPO} --title 'Bump to REL_18_6: the series does not apply' --body-file .cache/poll/bump-REL_18_6.issue.md`,
    ]);
    expect(planned[5]).toBe("git switch --quiet develop");
  });

  test("an existing bump branch skips the bump", async () => {
    const w = world();
    w.branches = ["bump/REL_18_6"];
    await w.poll("REL_18_3", false);
    expect(w.calls.some((line) => line.includes("bun run bump"))).toBe(false);
    expect(w.logs).toContain("poll: bump to REL_18_6: nothing to do: the branch bump/REL_18_6 exists on GitHub.");
  });

  test("a bump that commits is pushed and opened as a pull request against develop; a blocked one as a draft", async () => {
    for (const exitCode of [0, 1]) {
      const w = world();
      w.heads = ["1".repeat(40), "2".repeat(40)];
      w.bump = (report) => {
        writeFileSync(report, "# Bump REL_18_3 → REL_18_6 (pgwasm-postgres 18.6.0)\n");
        return { exitCode, stdout: "", stderr: "" };
      };
      w.comments.set(40, []);
      const result = await w.poll("REL_18_3", false);
      expect(result.failures).toEqual([]);
      const writes = w.writes().filter((line) => !line.includes("readiness") && !line.startsWith("gh issue"));
      expect(writes).toEqual([
        "git switch --quiet --create bump/REL_18_6",
        "bun run bump REL_18_6 --lock --report .cache/poll/bump-REL_18_6.md",
        "git push origin bump/REL_18_6",
        `gh pr create --repo ${REPO} --base develop --head bump/REL_18_6 --title '${exitCode === 0 ? "" : "[blocked] "}Bump PostgreSQL to REL_18_6' --body-file .cache/poll/bump-REL_18_6.pr.md${exitCode === 0 ? "" : " --draft"}`,
        "git switch --quiet develop",
      ]);
      const body = readFileSync(join(w.layout.cacheDir, "poll", "bump-REL_18_6.pr.md"), "utf8");
      expect(body).toContain("Review only");
      expect(body).toEndWith("# Bump REL_18_3 → REL_18_6 (pgwasm-postgres 18.6.0)\n");
    }
  });

  test("a bump that does not commit opens an issue with its conflict report, and HEAD goes back to develop", async () => {
    const w = world();
    w.bump = (report) => {
      writeFileSync(report, "# Bump REL_18_3 → REL_18_6: CONFLICT\n");
      return { exitCode: 1, stdout: "", stderr: "bump: 0001 does not apply" };
    };
    await w.poll("REL_18_3", false);
    const writes = w.writes().filter((line) => !line.includes("readiness") && !line.startsWith("gh issue comment"));
    expect(writes.slice(0, 4)).toEqual([
      "git switch --quiet --create bump/REL_18_6",
      "bun run bump REL_18_6 --lock --report .cache/poll/bump-REL_18_6.md",
      `gh issue create --repo ${REPO} --title 'Bump to REL_18_6: the series does not apply' --body-file .cache/poll/bump-REL_18_6.issue.md`,
      "git switch --quiet develop",
    ]);
    expect(w.issues[0]?.body).toContain("# Bump REL_18_3 → REL_18_6: CONFLICT");
    expect(w.calls.some((line) => line.startsWith("git push") || line.startsWith("gh pr create"))).toBe(false);
  });

  test("readiness: a new tag is reported on the existing issue and tabulated; a second run changes nothing", async () => {
    const w = world();
    const beta3 = `${readinessMarker("REL_19_BETA3")}\n${reportOf("REL_19_BETA3", "conflict in `0001`")}`;
    w.issues = [{ number: 5, title: "Postgres 19 readiness", url: "u5", body: "stale" }];
    w.comments.set(5, [{ id: 1, url: "c1", body: beta3 }]);
    w.readiness = (report) => {
      writeFileSync(report, reportOf("REL_19_BETA4", "conflicts in `0001`, `0005`"));
      return ok();
    };
    expect((await w.poll("REL_18_6", false)).failures).toEqual([]);
    expect(w.writes()).toEqual([
      "bun run readiness REL_19_BETA4 --lock --report .cache/poll/readiness-REL_19_BETA4.md",
      `gh issue comment 5 --repo ${REPO} --body-file .cache/poll/readiness-REL_19_BETA4.comment.md`,
      `gh issue edit 5 --repo ${REPO} --body-file .cache/poll/readiness-19.body.md`,
    ]);
    const comment = w.comments.get(5)?.[1];
    expect(comment?.body).toStartWith(`${readinessMarker("REL_19_BETA4")}\n<!-- readiness-status `);
    const body = w.issues[0]?.body ?? "";
    expect(body.indexOf("`REL_19_BETA4`")).toBeLessThan(body.indexOf("`REL_19_BETA3`"));
    expect(body).toContain(`[comment](${comment?.url})`);

    const again = new World(w.layout);
    again.issues = w.issues;
    again.comments = w.comments;
    expect((await again.poll("REL_18_6", false)).failures).toEqual([]);
    expect(again.writes()).toEqual([]);
    expect(again.logs).toContain(`poll: readiness of REL_19_BETA4: already reported (${comment?.url})`);
  });

  test("an issue whose body lacks the port checklist gets it on the next run, and nothing else is written", async () => {
    const w = world();
    const beta4 = `${readinessMarker("REL_19_BETA4")}\n${reportOf("REL_19_BETA4", "conflict in `0001`")}`;
    w.comments.set(5, [{ id: 1, url: "c1", body: beta4 }]);
    const table = readinessIssueBody(19, readinessRows(w.comments.get(5) ?? []), CHECKLIST);
    const before = table.slice(0, table.indexOf("## Port checklist"));
    w.issues = [{ number: 5, title: "Postgres 19 readiness", url: "u5", body: before }];
    expect((await w.poll("REL_18_6", false)).failures).toEqual([]);
    expect(w.writes()).toEqual([`gh issue edit 5 --repo ${REPO} --body-file .cache/poll/readiness-19.body.md`]);
    expect(w.issues[0]?.body).toBe(table);
    expect(w.issues[0]?.body).toContain("## Port checklist\n\nWhat it takes.");
  });

  test("a missing port checklist is a failure, and the body is left as it is", async () => {
    const w = world();
    rmSync(join(w.layout.root, PORT_CHECKLIST));
    w.comments.set(5, [
      { id: 1, url: "c1", body: `${readinessMarker("REL_19_BETA4")}\n${reportOf("REL_19_BETA4", "applies")}` },
    ]);
    w.issues = [{ number: 5, title: "Postgres 19 readiness", url: "u5", body: "stale" }];
    expect((await w.poll("REL_18_6", false)).failures).toEqual([
      "docs/port-checklist.md is missing: the readiness issue's body carries it.",
    ]);
    expect(w.writes()).toEqual([]);
  });

  test("readiness that writes no report is a failure, and nothing is posted", async () => {
    const w = world();
    w.issues = [{ number: 5, title: "Postgres 19 readiness", url: "u5", body: readinessIssueBody(19, [], CHECKLIST) }];
    w.readiness = () => ({ exitCode: 1, stdout: "", stderr: "readiness: could not list the tags" });
    const result = await w.poll("REL_18_6", false);
    expect(result.failures).toEqual(["readiness of REL_19_BETA4: `bun run readiness` exited 1 without a report."]);
    expect(w.writes()).toEqual([
      "bun run readiness REL_19_BETA4 --lock --report .cache/poll/readiness-REL_19_BETA4.md",
    ]);
  });
});
