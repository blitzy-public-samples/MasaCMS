/**
 * Port of the diff functions of the Java diff_match_patch build bundled with Masa
 * (core/mura/lib/diff_match_patch.jar), as mura.diffMatchPatch.compute uses them for carch.loaddiff.
 * Like Java it works on UTF-16 code units, so an edit boundary can fall inside a surrogate pair.
 * Diff Match and Patch: Copyright 2006 Google Inc., Neil Fraser; licensed under the Apache License 2.0.
 */

/** Java diff_match_patch.Operation. */
export enum DiffOp {
  DELETE = -1,
  INSERT = 1,
  EQUAL = 0,
}

/** Java diff_match_patch.Diff: operation and text. */
export type Diff = [DiffOp, string];

/** Deadline settings (Java Diff_Timeout and System.currentTimeMillis). */
export interface DiffTimingOptions {
  /** Diff_Timeout in milliseconds; 0 or less means no deadline. Default 1000 (Diff_Timeout = 1.0f). */
  timeoutMs?: number;
  /** Millisecond clock. Default performance.now(). */
  now?: () => number;
}

/** Options of diff_main(text1, text2, checklines). */
export interface DiffMainOptions extends DiffTimingOptions {
  /** Line-level speedup for texts over 100 code units. Default true. */
  checklines?: boolean;
}

/** Result of mura.diffMatchPatch.compute. */
export interface ComputedDiff {
  diffs: Diff[];
  html: string;
  text1: string;
  text2: string;
}

const DEFAULT_TIMEOUT_MS = 1000;

interface DiffContext {
  readonly deadline: number;
  /** Java diff_halfMatch runs only when Diff_Timeout > 0. */
  readonly halfMatch: boolean;
  readonly now: () => number;
}

type HalfMatch = [string, string, string, string, string];

// Java Character.isLetterOrDigit, isWhitespace and getType == CONTROL on one UTF-16 unit.
// The lookahead drops the BMP letters newer than the legacy JVM's tables (Java 17, Unicode 13).
const LETTER_OR_DIGIT =
  /^(?![\u0870-\u0887\u0889-\u088F\u08B5\u08C8\u08C9\u0C5C\u0C5D\u0CDC\u0CDD\u170D\u171F\u1B4C\u1C89\u1C8A\u2C2F\u2C5F\u9FFD-\u9FFF\uA7C0\uA7C1\uA7CB-\uA7DC\uA7F1-\uA7F4])[\p{L}\p{Nd}]$/u;
const JAVA_WHITESPACE = /^(?![\u00A0\u2007\u202F])[\p{Zs}\p{Zl}\p{Zp}\t\n\u000B\f\r\u001C-\u001F]$/u;
const CONTROL = /^\p{Cc}$/u;
// Java "\n\r?\n\Z": \Z also matches before one final line terminator.
const BLANKLINEEND = /\n\r?\n(?:\r\n|[\n\r\u0085\u2028\u2029])?$/;
const BLANKLINESTART = /^\r?\n\r?\n/;

function element(list: readonly Diff[], index: number): Diff {
  const item = list[index];
  if (item === undefined) throw new RangeError(`No diff at index ${String(index)}`);
  return item;
}

/** Index-based java.util.ListIterator, so each port walks and edits the list in Java's order. */
class ListCursor {
  private readonly list: Diff[];
  private cursor = 0;
  private lastReturned = -1;

  constructor(list: Diff[]) {
    this.list = list;
  }

  hasNext(): boolean {
    return this.cursor < this.list.length;
  }

  hasPrevious(): boolean {
    return this.cursor > 0;
  }

  next(): Diff {
    const item = element(this.list, this.cursor);
    this.lastReturned = this.cursor;
    this.cursor += 1;
    return item;
  }

  /** `pointer.hasNext() ? pointer.next() : null`. */
  nextOrNull(): Diff | null {
    return this.hasNext() ? this.next() : null;
  }

  previous(): Diff {
    const item = element(this.list, this.cursor - 1);
    this.cursor -= 1;
    this.lastReturned = this.cursor;
    return item;
  }

  set(item: Diff): void {
    this.list[this.requireLastReturned()] = item;
  }

  add(item: Diff): void {
    this.list.splice(this.cursor, 0, item);
    this.cursor += 1;
    this.lastReturned = -1;
  }

  remove(): void {
    const index = this.requireLastReturned();
    this.list.splice(index, 1);
    if (index < this.cursor) this.cursor -= 1;
    this.lastReturned = -1;
  }

  private requireLastReturned(): number {
    if (this.lastReturned < 0) throw new Error('ListCursor has no current element');
    return this.lastReturned;
  }
}

/** Ports diff_main(text1, text2, checklines): the differences between two texts. */
export function diffMain(text1: string, text2: string, options: DiffMainOptions = {}): Diff[] {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());
  const context: DiffContext = {
    deadline: timeoutMs <= 0 ? Number.POSITIVE_INFINITY : now() + timeoutMs,
    halfMatch: timeoutMs > 0,
    now,
  };
  return diffMainWithDeadline(text1, text2, options.checklines ?? true, context);
}

/** Ports the private diff_main(text1, text2, checklines, deadline). */
function diffMainWithDeadline(text1: string, text2: string, checklines: boolean, context: DiffContext): Diff[] {
  if (text1 === text2) {
    return text1.length !== 0 ? [[DiffOp.EQUAL, text1]] : [];
  }

  let commonlength = diffCommonPrefix(text1, text2);
  const commonprefix = text1.substring(0, commonlength);
  text1 = text1.substring(commonlength);
  text2 = text2.substring(commonlength);

  commonlength = diffCommonSuffix(text1, text2);
  const commonsuffix = text1.substring(text1.length - commonlength);
  text1 = text1.substring(0, text1.length - commonlength);
  text2 = text2.substring(0, text2.length - commonlength);

  const diffs = diffCompute(text1, text2, checklines, context);
  if (commonprefix.length !== 0) diffs.unshift([DiffOp.EQUAL, commonprefix]);
  if (commonsuffix.length !== 0) diffs.push([DiffOp.EQUAL, commonsuffix]);
  diffCleanupMerge(diffs);
  return diffs;
}

/** Ports diff_compute: texts known to share no common prefix or suffix. */
function diffCompute(text1: string, text2: string, checklines: boolean, context: DiffContext): Diff[] {
  if (text1.length === 0) return [[DiffOp.INSERT, text2]];
  if (text2.length === 0) return [[DiffOp.DELETE, text1]];

  const longtext = text1.length > text2.length ? text1 : text2;
  const shorttext = text1.length > text2.length ? text2 : text1;
  const i = longtext.indexOf(shorttext);
  if (i !== -1) {
    const op = text1.length > text2.length ? DiffOp.DELETE : DiffOp.INSERT;
    return [
      [op, longtext.substring(0, i)],
      [DiffOp.EQUAL, shorttext],
      [op, longtext.substring(i + shorttext.length)],
    ];
  }

  if (shorttext.length === 1) {
    return [
      [DiffOp.DELETE, text1],
      [DiffOp.INSERT, text2],
    ];
  }

  const hm = context.halfMatch ? diffHalfMatch(text1, text2) : null;
  if (hm !== null) {
    const [text1A, text1B, text2A, text2B, midCommon] = hm;
    const diffsA = diffMainWithDeadline(text1A, text2A, checklines, context);
    const diffsB = diffMainWithDeadline(text1B, text2B, checklines, context);
    return diffsA.concat([[DiffOp.EQUAL, midCommon]], diffsB);
  }

  if (checklines && text1.length > 100 && text2.length > 100) {
    return diffLineMode(text1, text2, context);
  }

  return diffBisect(text1, text2, context);
}

/** Ports diff_lineMode: a line-level diff, then a character re-diff of each replacement block. */
function diffLineMode(text1: string, text2: string, context: DiffContext): Diff[] {
  const { chars1, chars2, lineArray } = diffLinesToChars(text1, text2);
  const diffs = diffMainWithDeadline(chars1, chars2, false, context);
  diffCharsToLines(diffs, lineArray);
  diffCleanupSemantic(diffs);

  diffs.push([DiffOp.EQUAL, '']);
  let countDelete = 0;
  let countInsert = 0;
  let textDelete = '';
  let textInsert = '';
  const pointer = new ListCursor(diffs);
  let thisDiff: Diff | null = pointer.next();
  while (thisDiff !== null) {
    switch (thisDiff[0]) {
      case DiffOp.INSERT:
        countInsert += 1;
        textInsert += thisDiff[1];
        break;
      case DiffOp.DELETE:
        countDelete += 1;
        textDelete += thisDiff[1];
        break;
      case DiffOp.EQUAL:
        if (countDelete >= 1 && countInsert >= 1) {
          pointer.previous();
          for (let j = 0; j < countDelete + countInsert; j++) {
            pointer.previous();
            pointer.remove();
          }
          for (const newDiff of diffMainWithDeadline(textDelete, textInsert, false, context)) {
            pointer.add(newDiff);
          }
        }
        countInsert = 0;
        countDelete = 0;
        textDelete = '';
        textInsert = '';
        break;
    }
    thisDiff = pointer.nextOrNull();
  }
  diffs.pop();
  return diffs;
}

/** Reads a diff_bisect V-array cell; Java's indexes never leave the array, so the fallback is unreachable. */
function cell(v: Int32Array, index: number): number {
  return v[index] ?? -1;
}

/** Ports diff_bisect: the Myers middle snake, split there and diffed recursively. */
function diffBisect(text1: string, text2: string, context: DiffContext): Diff[] {
  const text1Length = text1.length;
  const text2Length = text2.length;
  const maxD = Math.floor((text1Length + text2Length + 1) / 2);
  const vOffset = maxD;
  const vLength = 2 * maxD;
  const v1 = new Int32Array(vLength).fill(-1);
  const v2 = new Int32Array(vLength).fill(-1);
  v1[vOffset + 1] = 0;
  v2[vOffset + 1] = 0;
  const delta = text1Length - text2Length;
  // With an odd total length the front path collides with the reverse path.
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    if (context.now() > context.deadline) break;

    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = vOffset + k1;
      let x1: number;
      if (k1 === -d || (k1 !== d && cell(v1, k1Offset - 1) < cell(v1, k1Offset + 1))) {
        x1 = cell(v1, k1Offset + 1);
      } else {
        x1 = cell(v1, k1Offset - 1) + 1;
      }
      let y1 = x1 - k1;
      while (x1 < text1Length && y1 < text2Length && text1.charCodeAt(x1) === text2.charCodeAt(y1)) {
        x1++;
        y1++;
      }
      v1[k1Offset] = x1;
      if (x1 > text1Length) {
        k1end += 2;
      } else if (y1 > text2Length) {
        k1start += 2;
      } else if (front) {
        const k2Offset = vOffset + delta - k1;
        if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1) {
          const x2 = text1Length - cell(v2, k2Offset);
          if (x1 >= x2) return diffBisectSplit(text1, text2, x1, y1, context);
        }
      }
    }

    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = vOffset + k2;
      let x2: number;
      if (k2 === -d || (k2 !== d && cell(v2, k2Offset - 1) < cell(v2, k2Offset + 1))) {
        x2 = cell(v2, k2Offset + 1);
      } else {
        x2 = cell(v2, k2Offset - 1) + 1;
      }
      let y2 = x2 - k2;
      while (
        x2 < text1Length &&
        y2 < text2Length &&
        text1.charCodeAt(text1Length - x2 - 1) === text2.charCodeAt(text2Length - y2 - 1)
      ) {
        x2++;
        y2++;
      }
      v2[k2Offset] = x2;
      if (x2 > text1Length) {
        k2end += 2;
      } else if (y2 > text2Length) {
        k2start += 2;
      } else if (!front) {
        const k1Offset = vOffset + delta - k2;
        if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
          const x1 = cell(v1, k1Offset);
          const y1 = vOffset + x1 - k1Offset;
          if (x1 >= text1Length - x2) return diffBisectSplit(text1, text2, x1, y1, context);
        }
      }
    }
  }
  // Deadline reached, or no commonality at all.
  return [
    [DiffOp.DELETE, text1],
    [DiffOp.INSERT, text2],
  ];
}

/** Ports diff_bisectSplit: diffs both halves around the snake at (x, y). */
function diffBisectSplit(text1: string, text2: string, x: number, y: number, context: DiffContext): Diff[] {
  const diffs = diffMainWithDeadline(text1.substring(0, x), text2.substring(0, y), false, context);
  const diffsb = diffMainWithDeadline(text1.substring(x), text2.substring(y), false, context);
  return diffs.concat(diffsb);
}

/** Ports diff_linesToChars: one code unit per distinct line; lineArray[0] is ''. */
function diffLinesToChars(text1: string, text2: string): { chars1: string; chars2: string; lineArray: string[] } {
  const lineArray: string[] = [''];
  const lineHash = new Map<string, number>();
  const chars1 = diffLinesToCharsMunge(text1, lineArray, lineHash);
  const chars2 = diffLinesToCharsMunge(text2, lineArray, lineHash);
  return { chars1, chars2, lineArray };
}

/** Ports diff_linesToCharsMunge; like Java it has no line cap, so indexes wrap at 65536. */
function diffLinesToCharsMunge(text: string, lineArray: string[], lineHash: Map<string, number>): string {
  let lineStart = 0;
  let lineEnd = -1;
  let chars = '';
  while (lineEnd < text.length - 1) {
    lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length - 1;
    const line = text.substring(lineStart, lineEnd + 1);
    lineStart = lineEnd + 1;

    const known = lineHash.get(line);
    if (known !== undefined) {
      chars += String.fromCharCode(known);
    } else {
      lineArray.push(line);
      lineHash.set(line, lineArray.length - 1);
      chars += String.fromCharCode(lineArray.length - 1);
    }
  }
  return chars;
}

/** Ports diff_charsToLines: rehydrates line codes into text, in place. */
function diffCharsToLines(diffs: Diff[], lineArray: readonly string[]): void {
  for (const diff of diffs) {
    let text = '';
    for (let y = 0; y < diff[1].length; y++) {
      const line = lineArray[diff[1].charCodeAt(y)];
      if (line === undefined) throw new RangeError(`No line for code ${String(diff[1].charCodeAt(y))}`);
      text += line;
    }
    diff[1] = text;
  }
}

/** Ports diff_commonPrefix: length of the common prefix. */
function diffCommonPrefix(text1: string, text2: string): number {
  const n = Math.min(text1.length, text2.length);
  for (let i = 0; i < n; i++) {
    if (text1.charCodeAt(i) !== text2.charCodeAt(i)) return i;
  }
  return n;
}

/** Ports diff_commonSuffix: length of the common suffix. */
function diffCommonSuffix(text1: string, text2: string): number {
  const text1Length = text1.length;
  const text2Length = text2.length;
  const n = Math.min(text1Length, text2Length);
  for (let i = 1; i <= n; i++) {
    if (text1.charCodeAt(text1Length - i) !== text2.charCodeAt(text2Length - i)) return i - 1;
  }
  return n;
}

/** Ports diff_commonOverlap: length of the longest suffix of text1 that is a prefix of text2. */
function diffCommonOverlap(text1: string, text2: string): number {
  const text1Length = text1.length;
  const text2Length = text2.length;
  if (text1Length === 0 || text2Length === 0) return 0;
  if (text1Length > text2Length) {
    text1 = text1.substring(text1Length - text2Length);
  } else if (text1Length < text2Length) {
    text2 = text2.substring(0, text1Length);
  }
  const textLength = Math.min(text1Length, text2Length);
  if (text1 === text2) return textLength;

  let best = 0;
  let length = 1;
  for (;;) {
    const pattern = text1.substring(textLength - length);
    const found = text2.indexOf(pattern);
    if (found === -1) return best;
    length += found;
    if (found === 0 || text1.substring(textLength - length) === text2.substring(0, length)) {
      best = length;
      length++;
    }
  }
}

/** Ports diff_halfMatch: a shared substring at least half the longer text's length, or null. */
function diffHalfMatch(text1: string, text2: string): HalfMatch | null {
  const longtext = text1.length > text2.length ? text1 : text2;
  const shorttext = text1.length > text2.length ? text2 : text1;
  if (longtext.length < 4 || shorttext.length * 2 < longtext.length) return null;

  // Seeds at the second and the third quarter of the longer text.
  const hm1 = diffHalfMatchI(longtext, shorttext, Math.floor((longtext.length + 3) / 4));
  const hm2 = diffHalfMatchI(longtext, shorttext, Math.floor((longtext.length + 1) / 2));
  let hm: HalfMatch;
  if (hm1 === null) {
    if (hm2 === null) return null;
    hm = hm2;
  } else if (hm2 === null) {
    hm = hm1;
  } else {
    hm = hm1[4].length > hm2[4].length ? hm1 : hm2;
  }

  if (text1.length > text2.length) return hm;
  return [hm[2], hm[3], hm[0], hm[1], hm[4]];
}

/** Ports diff_halfMatchI: half-match seeded by the quarter-length substring of longtext at i. */
function diffHalfMatchI(longtext: string, shorttext: string, i: number): HalfMatch | null {
  const seed = longtext.substring(i, i + Math.floor(longtext.length / 4));
  let j = -1;
  let bestCommon = '';
  let bestLongtextA = '';
  let bestLongtextB = '';
  let bestShorttextA = '';
  let bestShorttextB = '';
  while ((j = shorttext.indexOf(seed, j + 1)) !== -1) {
    const prefixLength = diffCommonPrefix(longtext.substring(i), shorttext.substring(j));
    const suffixLength = diffCommonSuffix(longtext.substring(0, i), shorttext.substring(0, j));
    if (bestCommon.length < suffixLength + prefixLength) {
      bestCommon = shorttext.substring(j - suffixLength, j) + shorttext.substring(j, j + prefixLength);
      bestLongtextA = longtext.substring(0, i - suffixLength);
      bestLongtextB = longtext.substring(i + prefixLength);
      bestShorttextA = shorttext.substring(0, j - suffixLength);
      bestShorttextB = shorttext.substring(j + prefixLength);
    }
  }
  if (bestCommon.length * 2 >= longtext.length) {
    return [bestLongtextA, bestLongtextB, bestShorttextA, bestShorttextB, bestCommon];
  }
  return null;
}


/** Ports diff_cleanupSemantic: drops semantically trivial equalities and extracts edit overlaps. Mutates and returns diffs. */
export function diffCleanupSemantic(diffs: Diff[]): Diff[] {
  if (diffs.length === 0) return diffs;
  let changes = false;
  const equalities: Diff[] = [];
  let lastequality: string | null = null;
  let pointer = new ListCursor(diffs);
  // Characters changed before (1) and after (2) the last equality.
  let lengthInsertions1 = 0;
  let lengthDeletions1 = 0;
  let lengthInsertions2 = 0;
  let lengthDeletions2 = 0;
  let thisDiff: Diff | null = pointer.next();
  while (thisDiff !== null) {
    if (thisDiff[0] === DiffOp.EQUAL) {
      equalities.push(thisDiff);
      lengthInsertions1 = lengthInsertions2;
      lengthDeletions1 = lengthDeletions2;
      lengthInsertions2 = 0;
      lengthDeletions2 = 0;
      lastequality = thisDiff[1];
    } else {
      if (thisDiff[0] === DiffOp.INSERT) {
        lengthInsertions2 += thisDiff[1].length;
      } else {
        lengthDeletions2 += thisDiff[1].length;
      }
      if (
        lastequality !== null &&
        lastequality.length <= Math.max(lengthInsertions1, lengthDeletions1) &&
        lastequality.length <= Math.max(lengthInsertions2, lengthDeletions2)
      ) {
        const offending = lastOf(equalities);
        while (thisDiff !== offending) thisDiff = pointer.previous();
        pointer.next();
        pointer.set([DiffOp.DELETE, lastequality]);
        pointer.add([DiffOp.INSERT, lastequality]);

        equalities.pop();
        if (equalities.length !== 0) equalities.pop();
        if (equalities.length === 0) {
          while (pointer.hasPrevious()) pointer.previous();
        } else {
          // Step back to the last safe equality; it is visited (and pushed) again next.
          const safe = lastOf(equalities);
          let walked: Diff;
          do {
            walked = pointer.previous();
          } while (walked !== safe);
        }

        lengthInsertions1 = 0;
        lengthInsertions2 = 0;
        lengthDeletions1 = 0;
        lengthDeletions2 = 0;
        lastequality = null;
        changes = true;
      }
    }
    thisDiff = pointer.nextOrNull();
  }

  if (changes) diffCleanupMerge(diffs);
  diffCleanupSemanticLossless(diffs);

  // <del>abcxxx</del><ins>xxxdef</ins> -> <del>abc</del>xxx<ins>def</ins> and the reverse,
  // when the overlap is at least half of either edit.
  pointer = new ListCursor(diffs);
  let prevDiff: Diff | null = null;
  thisDiff = null;
  if (pointer.hasNext()) {
    prevDiff = pointer.next();
    if (pointer.hasNext()) thisDiff = pointer.next();
  }
  while (prevDiff !== null && thisDiff !== null) {
    if (prevDiff[0] === DiffOp.DELETE && thisDiff[0] === DiffOp.INSERT) {
      const deletion = prevDiff[1];
      const insertion = thisDiff[1];
      const overlapLength1 = diffCommonOverlap(deletion, insertion);
      const overlapLength2 = diffCommonOverlap(insertion, deletion);
      if (overlapLength1 >= overlapLength2) {
        if (overlapLength1 >= deletion.length / 2 || overlapLength1 >= insertion.length / 2) {
          pointer.previous();
          pointer.add([DiffOp.EQUAL, insertion.substring(0, overlapLength1)]);
          prevDiff[1] = deletion.substring(0, deletion.length - overlapLength1);
          thisDiff[1] = insertion.substring(overlapLength1);
        }
      } else if (overlapLength2 >= deletion.length / 2 || overlapLength2 >= insertion.length / 2) {
        pointer.previous();
        pointer.add([DiffOp.EQUAL, deletion.substring(0, overlapLength2)]);
        prevDiff[0] = DiffOp.INSERT;
        prevDiff[1] = insertion.substring(0, insertion.length - overlapLength2);
        thisDiff[0] = DiffOp.DELETE;
        thisDiff[1] = deletion.substring(overlapLength2);
      }
      thisDiff = pointer.nextOrNull();
    }
    prevDiff = thisDiff;
    thisDiff = pointer.nextOrNull();
  }
  return diffs;
}

function lastOf(stack: readonly Diff[]): Diff {
  return element(stack, stack.length - 1);
}

/** Ports diff_cleanupSemanticLossless: slides single edits between equalities to word and line boundaries. */
function diffCleanupSemanticLossless(diffs: Diff[]): void {
  const pointer = new ListCursor(diffs);
  let prevDiff = pointer.nextOrNull();
  let thisDiff = pointer.nextOrNull();
  let nextDiff = pointer.nextOrNull();
  while (prevDiff !== null && thisDiff !== null && nextDiff !== null) {
    if (prevDiff[0] === DiffOp.EQUAL && nextDiff[0] === DiffOp.EQUAL) {
      let equality1 = prevDiff[1];
      let edit = thisDiff[1];
      let equality2 = nextDiff[1];

      // Shift the edit as far left as possible.
      const commonOffset = diffCommonSuffix(equality1, edit);
      if (commonOffset !== 0) {
        const commonString = edit.substring(edit.length - commonOffset);
        equality1 = equality1.substring(0, equality1.length - commonOffset);
        edit = commonString + edit.substring(0, edit.length - commonOffset);
        equality2 = commonString + equality2;
      }

      // Step right one code unit at a time, keeping the best-scoring position (>= prefers trailing whitespace).
      let bestEquality1 = equality1;
      let bestEdit = edit;
      let bestEquality2 = equality2;
      let bestScore = diffCleanupSemanticScore(equality1, edit) + diffCleanupSemanticScore(edit, equality2);
      while (edit.length !== 0 && equality2.length !== 0 && edit.charCodeAt(0) === equality2.charCodeAt(0)) {
        equality1 += edit.charAt(0);
        edit = edit.substring(1) + equality2.charAt(0);
        equality2 = equality2.substring(1);
        const score = diffCleanupSemanticScore(equality1, edit) + diffCleanupSemanticScore(edit, equality2);
        if (score >= bestScore) {
          bestScore = score;
          bestEquality1 = equality1;
          bestEdit = edit;
          bestEquality2 = equality2;
        }
      }

      if (prevDiff[1] !== bestEquality1) {
        if (bestEquality1.length !== 0) {
          prevDiff[1] = bestEquality1;
        } else {
          pointer.previous();
          pointer.previous();
          pointer.previous();
          pointer.remove();
          pointer.next();
          pointer.next();
        }
        thisDiff[1] = bestEdit;
        if (bestEquality2.length !== 0) {
          nextDiff[1] = bestEquality2;
        } else {
          pointer.remove();
          nextDiff = thisDiff;
          thisDiff = prevDiff;
        }
      }
    }
    prevDiff = thisDiff;
    thisDiff = nextDiff;
    nextDiff = pointer.nextOrNull();
  }
}

/** Ports diff_cleanupSemanticScore: 6 (edge) down to 0 (inside a word) for a split between one and two. */
function diffCleanupSemanticScore(one: string, two: string): number {
  if (one.length === 0 || two.length === 0) return 6;

  const char1 = one.charAt(one.length - 1);
  const char2 = two.charAt(0);
  const nonAlphaNumeric1 = !LETTER_OR_DIGIT.test(char1);
  const nonAlphaNumeric2 = !LETTER_OR_DIGIT.test(char2);
  const whitespace1 = nonAlphaNumeric1 && JAVA_WHITESPACE.test(char1);
  const whitespace2 = nonAlphaNumeric2 && JAVA_WHITESPACE.test(char2);
  const lineBreak1 = whitespace1 && CONTROL.test(char1);
  const lineBreak2 = whitespace2 && CONTROL.test(char2);
  const blankLine1 = lineBreak1 && BLANKLINEEND.test(one);
  const blankLine2 = lineBreak2 && BLANKLINESTART.test(two);

  if (blankLine1 || blankLine2) return 5;
  if (lineBreak1 || lineBreak2) return 4;
  if (nonAlphaNumeric1 && !whitespace1 && whitespace2) return 3;
  if (whitespace1 || whitespace2) return 2;
  if (nonAlphaNumeric1 || nonAlphaNumeric2) return 1;
  return 0;
}

/** Ports diff_cleanupMerge: merges adjacent edits, factors out common affixes and shifts single edits. */
function diffCleanupMerge(diffs: Diff[]): void {
  diffs.push([DiffOp.EQUAL, '']);
  let pointer = new ListCursor(diffs);
  let countDelete = 0;
  let countInsert = 0;
  let textDelete = '';
  let textInsert = '';
  let thisDiff: Diff | null = pointer.next();
  let prevEqual: Diff | null = null;
  while (thisDiff !== null) {
    switch (thisDiff[0]) {
      case DiffOp.INSERT:
        countInsert += 1;
        textInsert += thisDiff[1];
        prevEqual = null;
        break;
      case DiffOp.DELETE:
        countDelete += 1;
        textDelete += thisDiff[1];
        prevEqual = null;
        break;
      case DiffOp.EQUAL:
        if (countDelete + countInsert > 1) {
          const bothTypes = countDelete !== 0 && countInsert !== 0;
          pointer.previous();
          for (; countDelete > 0; countDelete--) {
            pointer.previous();
            pointer.remove();
          }
          for (; countInsert > 0; countInsert--) {
            pointer.previous();
            pointer.remove();
          }
          if (bothTypes) {
            let commonlength = diffCommonPrefix(textInsert, textDelete);
            if (commonlength !== 0) {
              if (pointer.hasPrevious()) {
                thisDiff = pointer.previous();
                thisDiff[1] += textInsert.substring(0, commonlength);
                pointer.next();
              } else {
                pointer.add([DiffOp.EQUAL, textInsert.substring(0, commonlength)]);
              }
              textInsert = textInsert.substring(commonlength);
              textDelete = textDelete.substring(commonlength);
            }
            commonlength = diffCommonSuffix(textInsert, textDelete);
            if (commonlength !== 0) {
              thisDiff = pointer.next();
              thisDiff[1] = textInsert.substring(textInsert.length - commonlength) + thisDiff[1];
              textInsert = textInsert.substring(0, textInsert.length - commonlength);
              textDelete = textDelete.substring(0, textDelete.length - commonlength);
              pointer.previous();
            }
          }
          if (textDelete.length !== 0) pointer.add([DiffOp.DELETE, textDelete]);
          if (textInsert.length !== 0) pointer.add([DiffOp.INSERT, textInsert]);
          thisDiff = pointer.nextOrNull();
        } else if (prevEqual !== null) {
          prevEqual[1] += thisDiff[1];
          pointer.remove();
          thisDiff = pointer.previous();
          pointer.next();
        }
        countInsert = 0;
        countDelete = 0;
        textDelete = '';
        textInsert = '';
        prevEqual = thisDiff;
        break;
    }
    thisDiff = pointer.nextOrNull();
  }
  if (lastOf(diffs)[1].length === 0) diffs.pop();

  // A<ins>BA</ins>C -> <ins>AB</ins>AC: shift single edits over a neighbouring equality.
  let changes = false;
  pointer = new ListCursor(diffs);
  let prevDiff = pointer.nextOrNull();
  thisDiff = pointer.nextOrNull();
  let nextDiff = pointer.nextOrNull();
  while (prevDiff !== null && thisDiff !== null && nextDiff !== null) {
    if (prevDiff[0] === DiffOp.EQUAL && nextDiff[0] === DiffOp.EQUAL) {
      if (thisDiff[1].endsWith(prevDiff[1])) {
        thisDiff[1] = prevDiff[1] + thisDiff[1].substring(0, thisDiff[1].length - prevDiff[1].length);
        nextDiff[1] = prevDiff[1] + nextDiff[1];
        pointer.previous();
        pointer.previous();
        pointer.previous();
        pointer.remove();
        pointer.next();
        thisDiff = pointer.next();
        nextDiff = pointer.nextOrNull();
        changes = true;
      } else if (thisDiff[1].startsWith(nextDiff[1])) {
        prevDiff[1] += nextDiff[1];
        thisDiff[1] = thisDiff[1].substring(nextDiff[1].length) + nextDiff[1];
        pointer.remove();
        nextDiff = pointer.nextOrNull();
        changes = true;
      }
    }
    prevDiff = thisDiff;
    thisDiff = nextDiff;
    nextDiff = pointer.nextOrNull();
  }
  if (changes) diffCleanupMerge(diffs);
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '&para;<br>');
}

/** Ports diff_prettyHtml: equalities in <span>, deletions in <del>, insertions in <ins>, no separators. */
export function diffPrettyHtml(diffs: readonly Diff[]): string {
  let html = '';
  for (const [op, text] of diffs) {
    switch (op) {
      case DiffOp.INSERT:
        html += `<ins style="background:#e6ffe6;">${escapeHtml(text)}</ins>`;
        break;
      case DiffOp.DELETE:
        html += `<del style="background:#ffe6e6;">${escapeHtml(text)}</del>`;
        break;
      case DiffOp.EQUAL:
        html += `<span>${escapeHtml(text)}</span>`;
        break;
    }
  }
  return html;
}

/** Ports diff_text1: the source text (equalities and deletions). */
export function diffText1(diffs: readonly Diff[]): string {
  let text = '';
  for (const [op, data] of diffs) {
    if (op !== DiffOp.INSERT) text += data;
  }
  return text;
}

/** Ports diff_text2: the destination text (equalities and insertions). */
export function diffText2(diffs: readonly Diff[]): string {
  let text = '';
  for (const [op, data] of diffs) {
    if (op !== DiffOp.DELETE) text += data;
  }
  return text;
}

/** Ports mura.diffMatchPatch.compute: diff_main, diff_cleanupSemantic, then the HTML and both texts. */
export function computeDiff(text1: string, text2: string, options: DiffTimingOptions = {}): ComputedDiff {
  const diffs = diffMain(text1, text2, { ...options, checklines: true });
  diffCleanupSemantic(diffs);
  return { diffs, html: diffPrettyHtml(diffs), text1: diffText1(diffs), text2: diffText2(diffs) };
}

