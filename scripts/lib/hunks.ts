/**
 * Unified-diff hunks, and following a range of lines through them: which upstream commits between two tags
 * touched the lines a patch's hunk stands on (its context and the lines it removes). A bump's conflict report
 * names those commits (ADR-0001 decision 7).
 */

/** A hunk's header, `@@ -oldStart,oldCount +newStart,newCount @@`. A count of 0 means the start is the line before. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** The header line as the diff has it. */
  readonly header: string;
}

/** The hunks of one file in a diff. */
export interface FileHunks {
  readonly file: string;
  readonly hunks: readonly Hunk[];
}

/** Lines `start` to `end` of a file, 1-based and inclusive; `end < start` is an empty range before `start`. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

const FILE_HEADER = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of every file of a diff (`git diff`, `git format-patch`), in order, keyed by the new path. Lines inside
 * a hunk that look like headers cannot be mistaken for one: the hunk's counts say where it ends.
 */
export function parseDiffHunks(text: string): FileHunks[] {
  const files: { file: string; hunks: Hunk[] }[] = [];
  let current: { file: string; hunks: Hunk[] } | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) oldLeft -= 1;
      else if (line.startsWith("+")) newLeft -= 1;
      else if (line.startsWith(" ") || line === "") {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    const file = FILE_HEADER.exec(line);
    if (file !== null) {
      current = { file: file[2] ?? "", hunks: [] };
      files.push(current);
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null && current !== undefined) {
      const parsed: Hunk = {
        oldStart: Number(hunk[1]),
        oldCount: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newCount: hunk[4] === undefined ? 1 : Number(hunk[4]),
        header: line,
      };
      current.hunks.push(parsed);
      oldLeft = parsed.oldCount;
      newLeft = parsed.newCount;
    }
  }
  return files;
}

/** A hunk's old-side lines: the lines it stands on (context and removed lines). */
export function oldRange(hunk: Hunk): LineRange {
  return hunk.oldCount === 0
    ? { start: hunk.oldStart + 1, end: hunk.oldStart }
    : { start: hunk.oldStart, end: hunk.oldStart + hunk.oldCount - 1 };
}

/** The same hunks read the other way: a diff from new to old. */
export function invertHunks(hunks: readonly Hunk[]): Hunk[] {
  return hunks.map((hunk) => ({
    oldStart: hunk.newStart,
    oldCount: hunk.newCount,
    newStart: hunk.oldStart,
    newCount: hunk.oldCount,
    header: hunk.header,
  }));
}

/**
 * Whether a diff's hunks change any line of `range` (a line removed or replaced, or lines inserted between two of
 * its lines), and where the range's lines are after it. A range a hunk overlaps grows to cover what the hunk put in
 * their place. The hunks must be of a `-U0` diff (no context lines), in order.
 */
export function followRange(range: LineRange, hunks: readonly Hunk[]): { range: LineRange; touched: boolean } {
  let touched = false;
  let startShift = 0;
  let endShift = 0;
  let startSet: number | undefined;
  let endSet: number | undefined;
  for (const hunk of hunks) {
    const delta = hunk.newCount - hunk.oldCount;
    if (hunk.oldCount === 0) {
      // Lines inserted after old line `oldStart`.
      if (hunk.oldStart >= range.start && hunk.oldStart < range.end) touched = true;
      if (hunk.oldStart < range.start) startShift += delta;
      if (hunk.oldStart < range.end) endShift += delta;
      continue;
    }
    const first = hunk.oldStart;
    const last = hunk.oldStart + hunk.oldCount - 1;
    if (last < range.start) {
      startShift += delta;
      endShift += delta;
    } else if (first > range.end) {
      continue;
    } else {
      touched = true;
      const newFirst = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
      const newLast = hunk.newCount === 0 ? hunk.newStart : hunk.newStart + hunk.newCount - 1;
      if (first <= range.start && startSet === undefined) startSet = newFirst;
      if (last >= range.end) endSet = newLast;
      else endShift += delta;
    }
  }
  const start = startSet ?? range.start + startShift;
  const end = endSet ?? range.end + endShift;
  return { range: { start, end: Math.max(end, start - 1) }, touched };
}
