import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { git } from "../scripts/lib/git.ts";
import { layoutFor } from "../scripts/lib/layout.ts";
import { FORMAT_PATCH_FLAGS } from "../scripts/lib/series.ts";
import {
  defaultAgainst,
  latestRelease,
  materialisePostgres,
  otherDifferences,
  POSTGRES_PATH,
  removeSide,
  requireSamePin,
  revisionSide,
  workingSide,
} from "../scripts/lib/tokens-series.ts";
import {
  clipMiddle,
  compareTokens,
  compileCommand,
  diffSequences,
  formatComparison,
  makeDryRunCommand,
  PREPROCESS_FLAGS,
  preprocessCommand,
  preprocessRunCommand,
  shellWords,
  splitItems,
  tokenize,
  tokensSummary,
  verdict,
  type Hunk,
} from "../scripts/lib/tokens.ts";
import { Fixtures, thrown, write } from "./helpers.ts";

const fixtures = new Fixtures();
afterEach(() => fixtures.cleanup());
const quiet = (): void => {};

describe("tokenize", () => {
  test("splits C into tokens: literals with their prefixes, pp-numbers, the longest punctuator", () => {
    expect(tokenize(`int a+++b; x->y ... 1.5e+10f 0x1p-3 .5 L"x\\"y" '\\'' u8"z" a<<=b c%:%:d`)).toEqual([
      "int",
      "a",
      "++",
      "+",
      "b",
      ";",
      "x",
      "->",
      "y",
      "...",
      "1.5e+10f",
      "0x1p-3",
      ".5",
      'L"x\\"y"',
      "'\\''",
      'u8"z"',
      "a",
      "<<=",
      "b",
      "c",
      "%:%:",
      "d",
    ]);
  });

  test("drops whitespace, line continuations and comments", () => {
    expect(tokenize("int  a /* a\n comment */ =\t1 ; // x\nchar\\\n b;")).toEqual(tokenize("int a=1;char b;"));
    expect(tokenize('s = "a /* not */ b";')).toEqual(["s", "=", '"a /* not */ b"', ";"]);
  });

  test("a line that starts with # is one token; a # elsewhere is a punctuator", () => {
    expect(tokenize("#pragma  GCC\tvisibility push(default)\n  # pragma weak \\\n x\nint a # b;")).toEqual([
      "#pragma GCC visibility push(default)",
      "# pragma weak x",
      "int",
      "a",
      "#",
      "b",
      ";",
    ]);
  });
});

describe("splitItems", () => {
  test("declarations end at their ;, function definitions at their body's }", () => {
    const tokens = tokenize(
      [
        "typedef struct S { int x; } T;",
        "extern void f(void);",
        "static int g(int a) { if (a) { return 1; } return 0; }",
        "int v[] = { 1, 2 };",
        "#pragma weak h",
        "__attribute__((unused)) static int k(void) { return 2; }",
        "static volatile _Bool flag = 0;",
      ].join("\n"),
    );
    const items = splitItems(tokens);
    expect(items.map((item) => item.name)).toEqual(["T", "f", "g", "v", "#pragma weak h", "k", "flag"]);
    expect(items.map((item) => item.key)).toContain("static int g ( int a ) { if ( a ) { return 1 ; } return 0 ; }");
    expect(items.at(-1)?.end).toBe(tokens.length);
  });
});

/** Rebuilds `b` from `a` and the hunks, checking that what lies between the hunks is equal. */
function apply(a: readonly string[], b: readonly string[], hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const hunk of hunks) {
    expect(a.slice(i, hunk.aStart)).toEqual(b.slice(j, hunk.bStart));
    out.push(...a.slice(i, hunk.aStart), ...b.slice(hunk.bStart, hunk.bEnd));
    i = hunk.aEnd;
    j = hunk.bEnd;
  }
  expect(a.slice(i)).toEqual(b.slice(j));
  out.push(...a.slice(i));
  return out;
}

describe("diffSequences", () => {
  test("finds the ranges that differ", () => {
    expect(diffSequences(["a", "b"], ["a", "b"])).toEqual({ hunks: [], approximate: false });
    expect(diffSequences(["a", "b", "c", "d"], ["a", "x", "c", "d"]).hunks).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
    ]);
    expect(diffSequences(["a", "b"], ["a", "x", "b"]).hunks).toEqual([{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
    expect(diffSequences(["a", "b", "c", "d", "e"], ["a", "X", "c", "Y", "e"]).hunks).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
      { aStart: 3, aEnd: 4, bStart: 3, bEnd: 4 },
    ]);
  });

  test("beyond its edit budget, the difference is one approximate range", () => {
    const difference = diffSequences(["a", "b", "c", "d", "e"], ["a", "X", "c", "Y", "e"], 1);
    expect(difference).toEqual({ hunks: [{ aStart: 1, aEnd: 4, bStart: 1, bEnd: 4 }], approximate: true });
  });

  test("its hunks turn one sequence into the other, with as few edits as an edit script needs", () => {
    let seed = 42;
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let round = 0; round < 300; round += 1) {
      const a = Array.from({ length: random(30) }, () => "abcd"[random(4)] ?? "a");
      const b = Array.from({ length: random(30) }, () => "abcd"[random(4)] ?? "a");
      const { hunks, approximate } = diffSequences(a, b);
      expect(approximate).toBe(false);
      expect(apply(a, b, hunks)).toEqual(b);
      // The edits are |a| + |b| - 2·LCS.
      const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          const row = lcs[i] ?? [];
          row[j] =
            a[i - 1] === b[j - 1] ? (lcs[i - 1]?.[j - 1] ?? 0) + 1 : Math.max(lcs[i - 1]?.[j] ?? 0, row[j - 1] ?? 0);
        }
      }
      const edits = hunks.reduce((sum, hunk) => sum + hunk.aEnd - hunk.aStart + hunk.bEnd - hunk.bStart, 0);
      expect(edits).toBe(a.length + b.length - 2 * (lcs[a.length]?.[b.length] ?? 0));
    }
  });
});

describe("compareTokens and its report", () => {
  const f = "void f() { a = 1; }";
  const g = "void g() { a = 2; }";

  test("identical streams, whatever their whitespace", () => {
    const comparison = compareTokens(tokenize(`int a; ${f}`), tokenize(`int  a;\n${f}\n`));
    expect(comparison.identical).toBe(true);
    expect(verdict(comparison)).toBe("identical");
    expect(formatComparison(comparison, { from: "A", to: "B" })).toEqual([
      "identical: 13 tokens in 2 top-level items.",
    ]);
  });

  test("a definition in another place moved; a prototype on one side only was added", () => {
    const comparison = compareTokens(tokenize(`int a; ${f} ${g}`), tokenize(`int a; void f(void); ${g} ${f}`));
    expect(comparison.moved.map((item) => item.name)).toEqual(["f"]);
    expect(comparison.added.map((item) => item.tokens.join(" "))).toEqual(["void f ( void ) ;"]);
    expect(comparison.changed).toEqual([]);
    expect(comparison.removed).toEqual([]);
    expect(verdict(comparison)).toBe("different");
    expect(verdict(compareTokens(tokenize(`${f} ${g}`), tokenize(`${g} ${f}`)))).toBe(
      "the same items in another order",
    );
  });

  test("an item of the same name with other tokens changed, and the report shows the range in context", () => {
    const comparison = compareTokens(tokenize(`int a; ${f}`), tokenize("int a; void f() { a = 3; }"));
    expect(comparison.changed.map((item) => item.name)).toEqual(["f"]);
    expect(comparison.changed[0]?.difference.hunks).toEqual([{ aStart: 7, aEnd: 8, bStart: 7, bEnd: 8 }]);
    expect(formatComparison(comparison, { from: "A", to: "B" }, { entries: 5, context: 2, width: 100 })).toEqual([
      "not identical (different): A has 13 tokens in 2 top-level items, B 13 tokens in 2 top-level items.",
      "changed: 1",
      "  f: 1 differing range",
      "    token 7: … a = [-1-] {+3+} ; } …",
    ]);
  });

  test("the report is bounded", () => {
    const many = Array.from({ length: 20 }, (_, index) => `int v${index} = ${"1 + ".repeat(50)}1;`).join(" ");
    const lines = formatComparison(
      compareTokens(tokenize("int a;"), tokenize(`int a; ${many}`)),
      {
        from: "A",
        to: "B",
      },
      { entries: 3, context: 2, width: 60 },
    );
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe("only in B: 20");
    expect(lines[5]).toBe("  … and 17 more");
    expect(lines.every((line) => line.length <= 120)).toBe(true);
    expect(clipMiddle("abcdefghij", 7)).toBe("ab … ij");
  });
});

describe("the compile command", () => {
  test("shellWords splits a simple command and refuses anything else", () => {
    expect(shellWords(`emcc 'a b' "c \\"d\\"" e\\ f -DX='"y"'`)).toEqual(["emcc", "a b", 'c "d"', "e f", '-DX="y"']);
    expect(() => shellWords("a; b")).toThrow("Not a simple command");
    expect(() => shellWords("a && b")).toThrow("Not a simple command");
    expect(() => shellWords("a $HOME")).toThrow("Not a simple command");
  });

  test("compileCommand takes the one line of make -n that compiles the file", () => {
    const output = [
      "make: Entering directory '/build/src/backend/tcop'",
      "/emsdk/upstream/emscripten/emcc -Wall -O2 -D__PGLITE__ -I../../../src/include  -c -o postgres.o postgres.c",
      "make: Leaving directory '/build/src/backend/tcop'",
    ].join("\n");
    expect(compileCommand(output, "postgres.c", "postgres.o")).toEqual([
      "/emsdk/upstream/emscripten/emcc",
      "-Wall",
      "-O2",
      "-D__PGLITE__",
      "-I../../../src/include",
      "-c",
      "-o",
      "postgres.o",
      "postgres.c",
    ]);
    expect(() => compileCommand("make: 'postgres.o' is up to date.", "postgres.c", "postgres.o")).toThrow(
      "make -n printed no command that compiles postgres.c into postgres.o",
    );
    const twice = `cc -c -o postgres.o postgres.c\ncc -c -o postgres.o postgres.c`;
    expect(() => compileCommand(twice, "postgres.c", "postgres.o")).toThrow("printed 2 commands");
  });

  test("preprocessCommand swaps the compilation for decision 4's preprocessing, keeping every other flag", () => {
    const compile = [
      "emcc",
      "-O2",
      "-MMD",
      "-MP",
      "-MF",
      ".deps/postgres.Po",
      "-I.",
      "-c",
      "-o",
      "postgres.o",
      "postgres.c",
    ];
    expect(preprocessCommand(compile, "postgres.c", "/tokens/a.i")).toEqual([
      "emcc",
      "-O2",
      "-I.",
      ...PREPROCESS_FLAGS,
      "-o",
      "/tokens/a.i",
      "postgres.c",
    ]);
    expect(PREPROCESS_FLAGS).toEqual(["-E", "-P", "-D__PGLITE__", "-D__LINE__=0", "-Wno-builtin-macro-redefined"]);
  });

  test("the containers mount the configured tree read-only where the build ran, and a side over its postgres.c", () => {
    const dry = makeDryRunCommand("image", "/tree");
    expect(dry.slice(0, 5)).toEqual(["podman", "run", "--rm", "--name", "pgwasm-postgres-tokens"]);
    expect(dry).toContain("/tree:/build:ro");
    expect(dry).toContain("--workdir=/build/src/backend/tcop");
    expect(dry.slice(dry.indexOf("image"))).toEqual([
      "image",
      "emmake",
      "make",
      "PORTNAME=emscripten",
      "-n",
      "-W",
      "postgres.c",
      "postgres.o",
    ]);
    const run = preprocessRunCommand("image", "/tree", "/state/a/postgres.c", "/state", ["emcc", "-E"]);
    expect(run).toContain("/state/a/postgres.c:/build/src/backend/tcop/postgres.c:ro");
    expect(run).toContain("/state:/tokens:rw");
    expect(run.slice(-3)).toEqual(["image", "emcc", "-E"]);
  });
});

describe("the gate summary", () => {
  test("says identical, where it differs, or why it did not compare", () => {
    const same = compareTokens(tokenize("int a;"), tokenize("int a;"));
    expect(tokensSummary({ kind: "compared", from: "18.6.1", comparison: same, report: [] })).toBe(
      "- postgres.c's token stream (`patches:tokens`, report-only): identical to 18.6.1's (3 tokens).\n",
    );
    const other = compareTokens(tokenize("int a; void f() {}"), tokenize("void f() {} int a; int b;"));
    const summary = tokensSummary({ kind: "compared", from: "18.6.1", comparison: other, report: ["line"] });
    expect(summary).toContain("differs from 18.6.1's (different): top-level items 1 moved, 1 only in this commit.");
    expect(summary).toContain("```text\nline\n```");
    expect(tokensSummary({ kind: "not compared", from: "18.6.1", reason: "18.6.1 pins REL_18_6\nmore" })).toBe(
      "- postgres.c's token stream (`patches:tokens`, report-only): not compared with 18.6.1's: 18.6.1 pins REL_18_6\n",
    );
  });
});

describe("the two series", () => {
  test("latestRelease picks the highest N.N.N tag", () => {
    expect(latestRelease(["18.3.0", "18.6.1", "builder-sources-1", "18.6.0", "18.10.0"])).toBe("18.10.0");
    expect(latestRelease(["builder-sources-1"])).toBeUndefined();
  });

  test("postgres.c is materialised from a revision's series and from the working series, on one pin only", () => {
    const dir = fixtures.dir("tokens");
    writeFileSync(join(dir, "gitconfig"), "");
    const env = {
      GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "author@example.invalid",
      GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
    };
    const upstream = join(dir, "upstream");
    mkdirSync(upstream);
    const inUpstream = (args: readonly string[]): string => git(args, { cwd: upstream, env }).stdout;
    inUpstream(["init", "--quiet", "--initial-branch=main"]);
    write(join(upstream, POSTGRES_PATH), "int a;\n");
    write(join(upstream, "src", "include", "x.h"), "int x;\n");
    inUpstream(["add", "-A"]);
    inUpstream(["commit", "--quiet", "-m", "Base"]);
    inUpstream(["tag", "v1"]);
    const base = inUpstream(["rev-parse", "HEAD"]).trim();
    const patch = (content: string, header: string, name: string): string => {
      inUpstream(["checkout", "--quiet", "-B", name, "v1"]);
      write(join(upstream, POSTGRES_PATH), content);
      write(join(upstream, "src", "include", "x.h"), header);
      inUpstream(["commit", "--quiet", "-am", `topic: ${name}`]);
      const text = inUpstream(["format-patch", ...FORMAT_PATCH_FLAGS, "-1", "--stdout"]);
      inUpstream(["checkout", "--quiet", "main"]);
      return text;
    };

    const root = join(dir, "root");
    const inRoot = (args: readonly string[]): string => git(args, { cwd: root, env }).stdout;
    mkdirSync(root);
    inRoot(["init", "--quiet", "--initial-branch=main"]);
    const pin = { repository: `file://${upstream}`, tag: "v1", commit: base };
    write(join(root, "upstream.json"), `${JSON.stringify(pin, null, 2)}\n`);
    write(join(root, "patches", "0001-topic-b.patch"), patch("int b;\n", "int x;\n", "b"));
    inRoot(["add", "-A"]);
    inRoot(["commit", "--quiet", "-m", "series b"]);
    inRoot(["tag", "1.0.0"]);
    inRoot(["commit", "--quiet", "--allow-empty", "-m", "after the release"]);
    write(join(root, "patches", "0001-topic-b.patch"), patch("int c;\n", "int y;\n", "c"));

    const layout = layoutFor(root);
    expect(defaultAgainst(root)).toBe("1.0.0");
    const from = revisionSide(root, "1.0.0", join(dir, "patches-against"));
    const to = workingSide(layout);
    expect(from.label).toBe("1.0.0");
    expect(to.label).toMatch(/^the working series \(HEAD [0-9a-f]{12}, with changes\)$/);
    requireSamePin(from, to);
    const a = materialisePostgres(layout, from, quiet);
    const b = materialisePostgres(layout, to, quiet);
    expect(a.source.toString()).toBe("int b;\n");
    expect(b.source.toString()).toBe("int c;\n");
    expect(otherDifferences(layout, a.commit, b.commit)).toEqual(["src/include/x.h"]);
    removeSide(from);

    write(join(root, "upstream.json"), `${JSON.stringify({ ...pin, tag: "v2" }, null, 2)}\n`);
    const error = thrown(() =>
      requireSamePin(revisionSide(root, "1.0.0", join(dir, "patches-again")), workingSide(layout)),
    );
    expect(error.message).toContain("1.0.0 pins v1 (");
    expect(error.message).toContain("pins v2 (");
    expect(error.message).toContain("compared only between two series on one upstream tag");
    expect(thrown(() => revisionSide(root, "no-such-revision", join(dir, "x"))).message).toBe(
      "no-such-revision is not a commit of this repository.",
    );
  });
});
