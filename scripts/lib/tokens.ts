/**
 * The token-identity check of postgres.c (ADR-0001 decision 4), its pure parts: the C tokenizer, the split of a
 * preprocessed translation unit into its top-level items, the comparison of two token streams and its bounded report,
 * and the compile command taken from `make -n` in the build's configured tree. `bun run patches:tokens`
 * (scripts/patches-tokens.ts) materialises postgres.c from the series at two revisions (tokens-series.ts) and
 * preprocesses both in the builder image with these.
 *
 * Preprocessed with `-E -P -D__LINE__=0`, two files that are the same code give the same tokens: `-P` drops the line
 * markers and `__LINE__=0` the line numbers `ereport` and `elog` record, so what is left is the code. The comparison
 * ignores whitespace (it compares tokens), and it aligns top-level items (declarations and function definitions), so
 * that a definition that moved is reported as moved rather than as a deletion and an insertion.
 */
import { SOURCE_MOUNT } from "./build.ts";
import { CONTAINER_PREFIX } from "./podman.ts";

/**
 * One C token, in order of precedence: a string or character literal (with its encoding prefix), a pp-number, an
 * identifier, a punctuator (longest first), or any other single character. Groups: 1 blanks and line continuations,
 * 2 a newline, 3 a comment, 4 a token.
 */
const TOKEN =
  /([ \t\f\v\r]+|\\\r?\n)|(\n)|(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|((?:u8|[uUL])?"(?:[^"\\\n]|\\[\s\S])*"|(?:u8|[uUL])?'(?:[^'\\\n]|\\[\s\S])*'|\.?[0-9](?:[eEpP][+-]|'[0-9A-Za-z_]|[0-9A-Za-z_.])*|[A-Za-z_$][A-Za-z0-9_$]*|%:%:|\.\.\.|<<=|>>=|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||[*/%+\-&^|]=|##|<:|:>|<%|%>|%:|[\s\S])/y;

/** A directive line: from its `#` to the end of the line, continuation lines included. */
const DIRECTIVE = /#(?:[^\n\\]|\\\r?\n|\\)*/y;

/**
 * The tokens of C source text, without whitespace or comments. A line that starts with `#` (a `#pragma`, the only
 * directive `-E -P` leaves) is one token, its whitespace normalised to single spaces.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let lineStart = true;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    if (lineStart && text[at] === "#") {
      DIRECTIVE.lastIndex = at;
      const directive = DIRECTIVE.exec(text);
      if (directive !== null) {
        tokens.push(
          directive[0]
            .replace(/\\\r?\n/g, " ")
            .trim()
            .replace(/\s+/g, " "),
        );
        TOKEN.lastIndex = DIRECTIVE.lastIndex;
        lineStart = false;
        continue;
      }
    }
    const match = TOKEN.exec(text);
    if (match === null) break; // unreachable: the last alternative matches any character
    const [, blank, newline, comment, token] = match;
    if (newline !== undefined) lineStart = true;
    else if (blank !== undefined) continue;
    else if (comment !== undefined) {
      if (comment.includes("\n")) lineStart = true;
    } else if (token !== undefined) {
      tokens.push(token);
      lineStart = false;
    }
  }
  return tokens;
}

/** A top-level item of a translation unit: a declaration (up to its `;`), a function definition (up to its `}`). */
export interface Item {
  /** The index of its first token in the stream, and the index after its last. */
  readonly start: number;
  readonly end: number;
  /** What it declares, for the report: a function's name, a variable's, a type's; or its first token. */
  readonly name: string;
  /** Its tokens, joined by single spaces: two items are the same code when their keys are equal. */
  readonly key: string;
}

const OPENERS = new Set(["(", "[", "{", "<:", "<%"]);
const CLOSERS = new Set([")", "]", "}", ":>", "%>"]);

/** Keywords and GNU extensions, which never name an item. */
const KEYWORDS = new Set(
  [
    "auto break case char const continue default do double else enum extern float for goto if inline int long",
    "register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while",
    "_Bool _Complex _Imaginary _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local bool true",
    "false nullptr typeof typeof_unqual alignas alignof static_assert thread_local constexpr __attribute__",
    "__attribute __extension__ __inline __inline__ __restrict __restrict__ __volatile__ __const __const__ __signed",
    "__signed__ __asm__ __asm asm __typeof__ __typeof __builtin_va_list __int128 __thread __declspec __label__",
  ]
    .join(" ")
    .split(" "),
);

/** The groups `name(…)` that are not a declarator: attributes, asm labels, alignment and type-of. */
const NOT_DECLARATORS = new Set([
  "__attribute__",
  "__attribute",
  "__declspec",
  "__asm__",
  "__asm",
  "asm",
  "_Alignas",
  "alignas",
  "__typeof__",
  "__typeof",
  "typeof",
  "typeof_unqual",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isName(token: string | undefined): token is string {
  return token !== undefined && IDENTIFIER.test(token) && !KEYWORDS.has(token);
}

/** The index of the bracket that closes the one at `open`, or `end` when none does. */
function matching(tokens: readonly string[], open: number, end: number): number {
  let depth = 0;
  for (let index = open; index < end; index += 1) {
    const token = tokens[index] ?? "";
    if (OPENERS.has(token)) depth += 1;
    else if (CLOSERS.has(token)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return end;
}

/**
 * An item's name: the identifier before its first top-level `(` that is not an attribute's (a function, a
 * prototype), otherwise the last identifier at its top level before an `=` (a variable, a typedef, a tag),
 * otherwise its first token.
 */
function itemName(tokens: readonly string[], start: number, end: number): string {
  const first = tokens[start] ?? "";
  if (first.startsWith("#")) return first;
  let depth = 0;
  let last: string | undefined;
  let skipUntil = -1;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index] ?? "";
    if (OPENERS.has(token)) {
      if (token === "(" && depth === 0 && index > skipUntil && index > start) {
        const before = tokens[index - 1];
        if (before !== undefined && NOT_DECLARATORS.has(before)) skipUntil = matching(tokens, index, end);
        else if (isName(before)) return before;
      }
      depth += 1;
    } else if (CLOSERS.has(token)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (token === "=") break;
      if (isName(token)) last = token;
    }
  }
  return last ?? first;
}

/**
 * Splits a translation unit's tokens into its top-level items. A declaration ends at a `;` outside every bracket; a
 * function definition at the `}` that closes its body, recognised as a top-level `{` that follows a `)`; a directive
 * line is an item by itself. A struct's or an initializer's `}` does not end its item: its `;` does.
 */
export function splitItems(tokens: readonly string[]): Item[] {
  const items: Item[] = [];
  let start = 0;
  let depth = 0;
  let body = false;
  const close = (end: number): void => {
    if (end > start) {
      items.push({ start, end, name: itemName(tokens, start, end), key: tokens.slice(start, end).join(" ") });
    }
    start = end;
    body = false;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (depth === 0 && token.length > 1 && token.startsWith("#")) {
      close(index);
      close(index + 1);
    } else if (OPENERS.has(token)) {
      if (depth === 0 && (token === "{" || token === "<%") && index > start && tokens[index - 1] === ")") body = true;
      depth += 1;
    } else if (CLOSERS.has(token)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && body && (token === "}" || token === "%>")) close(index + 1);
    } else if (depth === 0 && token === ";") {
      close(index + 1);
    }
  }
  close(tokens.length);
  return items;
}

/** A range where two sequences differ: `a[aStart, aEnd)` stands where `b[bStart, bEnd)` does. */
export interface Hunk {
  readonly aStart: number;
  readonly aEnd: number;
  readonly bStart: number;
  readonly bEnd: number;
}

export interface Difference {
  readonly hunks: readonly Hunk[];
  /** More edits than the budget: one hunk spans everything between the common prefix and suffix. */
  readonly approximate: boolean;
}

/** The default edit budget of {@link diffSequences}: the search keeps O(D²) state. */
export const MAX_EDITS = 2000;

/**
 * The ranges where two sequences differ, from a shortest edit script (Myers' O(ND) algorithm) of what lies between
 * their common prefix and suffix. With more than `maxEdits` edits, the difference is one hunk.
 */
export function diffSequences(a: readonly string[], b: readonly string[], maxEdits = MAX_EDITS): Difference {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  if (prefix === aEnd && prefix === bEnd) return { hunks: [], approximate: false };
  const whole: Hunk[] = [{ aStart: prefix, aEnd, bStart: prefix, bEnd }];
  if (prefix === aEnd || prefix === bEnd) return { hunks: whole, approximate: false };

  // The middle's elements as numbers, so the search compares numbers.
  const ids = new Map<string, number>();
  const intern = (value: string): number => {
    let id = ids.get(value);
    if (id === undefined) {
      id = ids.size;
      ids.set(value, id);
    }
    return id;
  };
  const xs = Int32Array.from(a.slice(prefix, aEnd), intern);
  const ys = Int32Array.from(b.slice(prefix, bEnd), intern);
  const n = xs.length;
  const m = ys.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]: the furthest x on each diagonal k in [-d-1, d+1] before step d, at index k + d + 1.
  const trace: Int32Array[] = [];
  let edits = -1;
  search: for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && xs[x] === ys[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        edits = d;
        break search;
      }
    }
  }
  if (edits === -1) return { hunks: whole, approximate: true };

  // Walk the trace back from the end, marking the elements the edit script keeps.
  const keptA = new Uint8Array(n);
  const keptB = new Uint8Array(m);
  let x = n;
  let y = m;
  const keepDiagonal = (untilX: number): void => {
    while (x > untilX && y > 0) {
      x -= 1;
      y -= 1;
      keptA[x] = 1;
      keptB[y] = 1;
    }
  };
  for (let d = edits; d > 0; d -= 1) {
    const before = trace[d] ?? new Int32Array(0);
    const at = (k: number): number => before[k + d + 1] ?? 0;
    const k = x - y;
    const fromK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const fromX = at(fromK);
    keepDiagonal(fromK === k + 1 ? fromX : fromX + 1);
    x = fromX;
    y = fromX - fromK;
  }
  keepDiagonal(0);

  // Runs of elements the script does not keep are the hunks; the kept ones pair up in order.
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && keptA[i] === 1 && keptB[j] === 1) {
      i += 1;
      j += 1;
      continue;
    }
    const aStart = i;
    const bStart = j;
    while (i < n && keptA[i] !== 1) i += 1;
    while (j < m && keptB[j] !== 1) j += 1;
    hunks.push({ aStart: prefix + aStart, aEnd: prefix + i, bStart: prefix + bStart, bEnd: prefix + j });
  }
  return { hunks, approximate: false };
}

/** An item as the report shows it. */
export interface ItemText {
  readonly name: string;
  readonly tokens: readonly string[];
}

/** Items of one name on both sides with other tokens, and where their tokens differ. */
export interface ChangedItem {
  readonly name: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly difference: Difference;
}

export interface TokenComparison {
  readonly identical: boolean;
  readonly tokens: { readonly from: number; readonly to: number };
  readonly items: { readonly from: number; readonly to: number };
  /** Items with the same tokens on both sides, in another order. */
  readonly moved: readonly ItemText[];
  readonly changed: readonly ChangedItem[];
  /** Items on one side only: no item with the same tokens, nor one of the same name, on the other. */
  readonly removed: readonly ItemText[];
  readonly added: readonly ItemText[];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Compares two token streams item by item. The sequences of items are aligned by their tokens, and what the alignment
 * leaves over is sorted into items that moved (the same tokens elsewhere on the other side), items that changed (an
 * item of the same name on the other side, with the token-level difference) and items on one side only.
 */
export function compareTokens(from: readonly string[], to: readonly string[]): TokenComparison {
  const fromItems = splitItems(from);
  const toItems = splitItems(to);
  const sizes = {
    tokens: { from: from.length, to: to.length },
    items: { from: fromItems.length, to: toItems.length },
  };
  if (from.length === to.length && from.every((token, index) => token === to[index])) {
    return { identical: true, ...sizes, moved: [], changed: [], removed: [], added: [] };
  }

  const alignment = diffSequences(
    fromItems.map((item) => item.key),
    toItems.map((item) => item.key),
    Number.MAX_SAFE_INTEGER,
  );
  const deleted = alignment.hunks.flatMap((hunk) => fromItems.slice(hunk.aStart, hunk.aEnd));
  const inserted = alignment.hunks.flatMap((hunk) => toItems.slice(hunk.bStart, hunk.bEnd));
  const textOf = (item: Item, tokens: readonly string[]): ItemText => ({
    name: item.name,
    tokens: tokens.slice(item.start, item.end),
  });

  const insertedByKey = new Map<string, Item[]>();
  for (const item of inserted) push(insertedByKey, item.key, item);
  const moved: ItemText[] = [];
  const movedTo = new Set<Item>();
  const leftFrom: Item[] = [];
  for (const item of deleted) {
    const twin = insertedByKey.get(item.key)?.shift();
    if (twin === undefined) leftFrom.push(item);
    else {
      movedTo.add(twin);
      moved.push(textOf(item, from));
    }
  }
  const leftTo = inserted.filter((item) => !movedTo.has(item));

  const toByName = new Map<string, Item[]>();
  for (const item of leftTo) push(toByName, item.name, item);
  const changed: ChangedItem[] = [];
  const removed: ItemText[] = [];
  const pairedTo = new Set<Item>();
  for (const item of leftFrom) {
    const counterpart = toByName.get(item.name)?.shift();
    if (counterpart === undefined) {
      removed.push(textOf(item, from));
      continue;
    }
    pairedTo.add(counterpart);
    const fromTokens = from.slice(item.start, item.end);
    const toTokens = to.slice(counterpart.start, counterpart.end);
    changed.push({ name: item.name, from: fromTokens, to: toTokens, difference: diffSequences(fromTokens, toTokens) });
  }
  const added = leftTo.filter((item) => !pairedTo.has(item)).map((item) => textOf(item, to));
  return { identical: false, ...sizes, moved, changed, removed, added };
}

/** The comparison's verdict in a few words. */
export function verdict(comparison: TokenComparison): string {
  if (comparison.identical) return "identical";
  const orderOnly = comparison.changed.length === 0 && comparison.removed.length === 0 && comparison.added.length === 0;
  return orderOnly ? "the same items in another order" : "different";
}

/** How much of a difference the report shows. */
export interface ReportLimits {
  /** Items listed per kind, and differing ranges per changed item. */
  readonly entries: number;
  /** Tokens of context on each side of a differing range. */
  readonly context: number;
  /** Characters of one line. */
  readonly width: number;
}

export const REPORT_LIMITS: ReportLimits = { entries: 12, context: 8, width: 200 };

/** Text of at most about `width` characters, its middle elided. */
export function clipMiddle(text: string, width: number): string {
  if (text.length <= width) return text;
  const half = Math.max(1, Math.floor((width - 3) / 2));
  return `${text.slice(0, half)} … ${text.slice(text.length - half)}`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function bounded<T>(entries: readonly T[], limit: number, indent: string, line: (entry: T) => string[]): string[] {
  const lines = entries.slice(0, limit).flatMap(line);
  if (entries.length > limit) lines.push(`${indent}… and ${entries.length - limit} more`);
  return lines;
}

/**
 * The report of a comparison, bounded by `limits`: "identical", or each kind of difference with its items, and for a
 * changed item each differing range as `[-only in from-] {+only in to+}` in its context.
 */
export function formatComparison(
  comparison: TokenComparison,
  labels: { readonly from: string; readonly to: string },
  limits: ReportLimits = REPORT_LIMITS,
): string[] {
  const sizes = (tokens: number, items: number): string =>
    `${count(tokens, "token")} in ${count(items, "top-level item")}`;
  if (comparison.identical) return [`identical: ${sizes(comparison.tokens.from, comparison.items.from)}.`];
  const lines = [
    `not identical (${verdict(comparison)}): ${labels.from} has ${sizes(comparison.tokens.from, comparison.items.from)}, ${labels.to} ${sizes(comparison.tokens.to, comparison.items.to)}.`,
  ];
  const words = (tokens: readonly string[]): string => tokens.join(" ");
  const itemLine = (item: ItemText): string[] => [
    `  ${clipMiddle(`${item.name} (${count(item.tokens.length, "token")}): ${words(item.tokens)}`, limits.width)}`,
  ];
  if (comparison.moved.length > 0) {
    lines.push(`moved (the same tokens, in another order): ${comparison.moved.length}`);
    lines.push(
      ...bounded(comparison.moved, limits.entries, "  ", (item) => [
        `  ${item.name} (${count(item.tokens.length, "token")})`,
      ]),
    );
  }
  if (comparison.removed.length > 0) {
    lines.push(`only in ${labels.from}: ${comparison.removed.length}`);
    lines.push(...bounded(comparison.removed, limits.entries, "  ", itemLine));
  }
  if (comparison.added.length > 0) {
    lines.push(`only in ${labels.to}: ${comparison.added.length}`);
    lines.push(...bounded(comparison.added, limits.entries, "  ", itemLine));
  }
  if (comparison.changed.length > 0) {
    lines.push(`changed: ${comparison.changed.length}`);
    lines.push(
      ...bounded(comparison.changed, limits.entries, "  ", (item) => {
        const { hunks, approximate } = item.difference;
        const header = `  ${item.name}: ${count(hunks.length, "differing range")}${approximate ? " (too many edits to align: one range)" : ""}`;
        return [
          header,
          ...bounded(hunks, limits.entries, "    ", (hunk) => {
            const before = item.from.slice(Math.max(0, hunk.aStart - limits.context), hunk.aStart);
            const after = item.from.slice(hunk.aEnd, hunk.aEnd + limits.context);
            const gone = hunk.aEnd > hunk.aStart ? `[-${words(item.from.slice(hunk.aStart, hunk.aEnd))}-]` : "";
            const come = hunk.bEnd > hunk.bStart ? `{+${words(item.to.slice(hunk.bStart, hunk.bEnd))}+}` : "";
            const middle = clipMiddle([gone, come].filter((part) => part !== "").join(" "), limits.width);
            return [`    token ${hunk.aStart}: … ${words(before)} ${middle} ${words(after)} …`];
          }),
        ];
      }),
    );
  }
  return lines;
}

/**
 * Splits a shell command line (a `make -n` recipe line) into its words: single and double quotes and backslashes
 * are honoured, and nothing is expanded. A line with an unquoted operator (`;`, `&`, `|`, `<`, `>`) or an expansion
 * (`$`, a backquote) is not a simple command, and is refused.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === " " || char === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end === -1) throw new Error(`Unterminated single quote in: ${line}`);
      word = (word ?? "") + line.slice(index + 1, end);
      index = end;
    } else if (char === '"') {
      let value = "";
      let closed = false;
      for (index += 1; index < line.length; index += 1) {
        const inner = line[index] ?? "";
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "$" || inner === "`") throw new Error(`An expansion in a double-quoted word: ${line}`);
        if (inner === "\\" && '"\\$`'.includes(line[index + 1] ?? "x")) {
          index += 1;
          value += line[index] ?? "";
        } else value += inner;
      }
      if (!closed) throw new Error(`Unterminated double quote in: ${line}`);
      word = (word ?? "") + value;
    } else if (char === "\\") {
      index += 1;
      word = (word ?? "") + (line[index] ?? "");
    } else if (";&|<>$`".includes(char)) {
      throw new Error(`Not a simple command (an unquoted ${JSON.stringify(char)}): ${line}`);
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * The command in `make -n` output that compiles `source` into `object`: the one line whose words have `-c`,
 * `-o <object>` and `source`. Other lines (make's own messages, recursive makes) are skipped.
 */
export function compileCommand(makeOutput: string, source: string, object: string): string[] {
  const candidates = makeOutput
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .filter((line) => line.includes(source) && line.includes(object))
    .map((line) => {
      try {
        return shellWords(line.trim());
      } catch {
        return [];
      }
    })
    .filter((words) => {
      const output = words.indexOf("-o");
      return words.includes("-c") && output !== -1 && words[output + 1] === object && words.includes(source);
    });
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return only;
  throw new Error(
    [
      candidates.length === 0
        ? `make -n printed no command that compiles ${source} into ${object}. It printed:`
        : `make -n printed ${candidates.length} commands that compile ${source} into ${object}, not one. It printed:`,
      ...makeOutput
        .trimEnd()
        .split("\n")
        .slice(-10)
        .map((line) => `  | ${clipMiddle(line, 300)}`),
    ].join("\n"),
  );
}

/** Decision 4's flags: preprocess only, without line markers, with `__PGLITE__` defined and `__LINE__` fixed. */
export const PREPROCESS_FLAGS = ["-E", "-P", "-D__PGLITE__", "-D__LINE__=0", "-Wno-builtin-macro-redefined"] as const;

/** Flags that only write dependency files, and those of them that take the next word as their value. */
const DEPENDENCY_FLAGS = new Set(["-MD", "-MMD", "-MP", "-MG"]);
const DEPENDENCY_FLAGS_WITH_VALUE = new Set(["-MF", "-MT", "-MQ"]);

/**
 * The build's compile command made into decision 4's preprocessing: `-c`, `-o <object>`, the source and any
 * dependency-file flags go, and {@link PREPROCESS_FLAGS} and `-o <output> <source>` are appended. Every other word
 * stays, in its order.
 */
export function preprocessCommand(compile: readonly string[], source: string, output: string): string[] {
  const words: string[] = [];
  for (let index = 0; index < compile.length; index += 1) {
    const word = compile[index] ?? "";
    if (index > 0 && word === source) continue;
    if (word === "-c" || DEPENDENCY_FLAGS.has(word) || /^-M[FTQ]./.test(word)) continue;
    if (word === "-o" || DEPENDENCY_FLAGS_WITH_VALUE.has(word)) {
      index += 1;
      continue;
    }
    words.push(word);
  }
  return [...words, ...PREPROCESS_FLAGS, "-o", output, source];
}

/** The container of `patches:tokens`, one at a time. */
export const TOKENS_CONTAINER = `${CONTAINER_PREFIX}tokens`;

/** postgres.c's directory, and the file, in the build's tree. */
export const POSTGRES_DIR = "src/backend/tcop";
export const POSTGRES_SOURCE = "postgres.c";
export const POSTGRES_OBJECT = "postgres.o";

/** Where the preprocessed files are written in the container. */
export const TOKENS_OUTPUT_MOUNT = "/tokens";

function tokensContainer(image: string, tree: string, mounts: readonly string[], command: readonly string[]): string[] {
  return [
    "podman",
    "run",
    "--rm",
    "--name",
    TOKENS_CONTAINER,
    "--pull=never",
    "--network=none",
    "--umask",
    "0022",
    "--unsetenv",
    "container",
    "-e",
    "LC_ALL=C",
    `--workdir=${SOURCE_MOUNT}/${POSTGRES_DIR}`,
    "-v",
    `${tree}:${SOURCE_MOUNT}:ro`,
    ...mounts.flatMap((mount) => ["-v", mount]),
    image,
    ...command,
  ];
}

/**
 * `make -n` of postgres.o in the configured tree, mounted read-only where the build ran it, and run as the build runs
 * make (`emmake make PORTNAME=emscripten`): `-W postgres.c` makes the object out of date, so make prints the command
 * that compiles it.
 */
export function makeDryRunCommand(image: string, tree: string): string[] {
  return tokensContainer(
    image,
    tree,
    [],
    ["emmake", "make", "PORTNAME=emscripten", "-n", "-W", POSTGRES_SOURCE, POSTGRES_OBJECT],
  );
}

/**
 * The preprocessing of one side: its postgres.c bind-mounted over the configured tree's, so that the build's command
 * runs on it unchanged (the same directory, the same relative paths and the same `__FILE__`), writing to
 * `<output dir>/<name>`.
 */
export function preprocessRunCommand(
  image: string,
  tree: string,
  side: string,
  outputDir: string,
  command: readonly string[],
): string[] {
  return tokensContainer(
    image,
    tree,
    [`${side}:${SOURCE_MOUNT}/${POSTGRES_DIR}/${POSTGRES_SOURCE}:ro`, `${outputDir}:${TOKENS_OUTPUT_MOUNT}:rw`],
    command,
  );
}

/** What the gate's summary says about postgres.c's token stream. */
export type TokensOutcome =
  | {
      readonly kind: "compared";
      readonly from: string;
      readonly comparison: TokenComparison;
      readonly report: readonly string[];
    }
  | { readonly kind: "not compared"; readonly from: string | undefined; readonly reason: string };

const SUMMARY_LEAD = "- postgres.c's token stream (`patches:tokens`, report-only):";

/** The gate summary's Markdown: one line, and where the streams differ in a folded block. */
export function tokensSummary(outcome: TokensOutcome): string {
  if (outcome.kind === "not compared") {
    const against = outcome.from === undefined ? "" : ` with ${outcome.from}'s`;
    return `${SUMMARY_LEAD} not compared${against}: ${outcome.reason.split("\n")[0] ?? ""}\n`;
  }
  const { comparison } = outcome;
  if (comparison.identical) {
    return `${SUMMARY_LEAD} identical to ${outcome.from}'s (${count(comparison.tokens.to, "token")}).\n`;
  }
  const parts = [
    comparison.moved.length > 0 ? `${comparison.moved.length} moved` : undefined,
    comparison.changed.length > 0 ? `${comparison.changed.length} changed` : undefined,
    comparison.removed.length > 0 ? `${comparison.removed.length} only in ${outcome.from}` : undefined,
    comparison.added.length > 0 ? `${comparison.added.length} only in this commit` : undefined,
  ].filter((part) => part !== undefined);
  return [
    `${SUMMARY_LEAD} differs from ${outcome.from}'s (${verdict(comparison)}): top-level items ${parts.join(", ")}.`,
    "",
    "<details><summary>Where postgres.c's tokens differ</summary>",
    "",
    "```text",
    ...outcome.report,
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
}
