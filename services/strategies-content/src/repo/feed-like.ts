/** SQL Server LIKE pattern semantics of the JSON API beanFeed: a pattern's tokens and each token's verdict on a code unit. */

const COLLATOR = new Intl.Collator('en', { sensitivity: 'accent' });
const LIKE_RANGE_END = /^[0-9A-Za-z]$/;
const BMP_UNITS = 0x10000;
// Only code units below this one carry a rank.
const RANKED_UNITS = 0x180;

/** A token's verdict on one code unit: it matches, it does not, or the in-memory feed cannot compute it. */
export type LikeVerdict = 'match' | 'miss' | 'unsupported';

/** A `[...]` class under SQL Server's `^`, `-` and collation-range rules. */
export interface LikeClass {
  readonly kind: 'class';
  /** The text between `[` and its closing `]` or the end of the pattern. */
  readonly content: string;
  /** Leading `^`s. */
  readonly negated: boolean;
  /** A `--` in the body, which leaves every code unit unsupported. */
  readonly broken: boolean;
  /** likeFold of each single member. */
  readonly members: ReadonlySet<string>;
  /** Inclusive rank ranges of the ranges whose ends both have a reproduced order. */
  readonly ranges: readonly (readonly [number, number])[];
  /** A range end without a reproduced order. */
  readonly unranked: boolean;
}

/** One pattern character position: `_`, a literal code unit under likeFold, or a class. */
export type LikeToken = { readonly kind: 'any' } | { readonly kind: 'unit'; readonly folded: string } | LikeClass;

/** A pattern's `%`-free runs. */
export interface LikeRuns {
  /** The run before the first `%`, matched at the start. */
  readonly head: readonly LikeToken[];
  /** The runs between `%`s, in order. */
  readonly middle: readonly (readonly LikeToken[])[];
  /** The run after the last `%`, matched at the end; undefined when the pattern has no `%`. */
  readonly tail: readonly LikeToken[] | undefined;
}

/** Ascending, disjoint, inclusive ranges of code units. */
export type LikeUnitRanges = readonly (readonly [number, number])[];

/** COLLATOR's rank of each code unit below U+0180 whose SQL Server order, as nvarchar and as varchar, it reproduces. */
function likeRanks(): ReadonlyMap<string, number> {
  const units = Array.from({ length: RANKED_UNITS }, (_, code) => String.fromCharCode(code))
    .filter((ch) => !'ª²³¹º¼½¾ÐÞðþĸŉŒœŠšŸ'.includes(ch))
    .sort((a, b) => COLLATOR.compare(a, b));
  const ranks = new Map<string, number>();
  units.forEach((ch, i) => {
    const previous = units[i - 1];
    const tied = previous !== undefined && COLLATOR.compare(previous, ch) === 0;
    ranks.set(ch, tied ? (ranks.get(previous) ?? i) : i);
  });
  return ranks;
}

const LIKE_RANKS = likeRanks();

let foldGroups: ReadonlyMap<string, readonly number[]> | undefined;

/** A code unit as a case-insensitive non-unicode JS regex compares it (ES Canonicalize). */
export function likeFold(ch: string): string {
  const upper = ch.toUpperCase();
  return upper.length !== 1 || (ch.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? ch : upper;
}

/** The code units of each likeFold value. */
function foldIndex(): ReadonlyMap<string, readonly number[]> {
  if (foldGroups === undefined) {
    const groups = new Map<string, number[]>();
    for (let unit = 0; unit < BMP_UNITS; unit++) {
      const folded = likeFold(String.fromCharCode(unit));
      const group = groups.get(folded);
      if (group === undefined) groups.set(folded, [unit]);
      else group.push(unit);
    }
    foldGroups = groups;
  }
  return foldGroups;
}

/** The rank of a range endpoint SQL Server and COLLATOR order alike (an ASCII letter or digit), else undefined. */
function likeRangeEnd(ch: string): number | undefined {
  return LIKE_RANGE_END.test(ch) ? LIKE_RANKS.get(ch) : undefined;
}

/** The class of a LIKE `[...]` class's content. */
function likeClass(content: string): LikeClass {
  const body = content.replace(/^\^+/, '');
  const negated = body !== content;
  const members = new Set<string>();
  const ranges: [number, number][] = [];
  const broken = body.includes('--');
  let unranked = false;
  for (let i = 0; !broken && i < body.length; i++) {
    if (body.charAt(i + 1) !== '-' || i + 2 >= body.length) members.add(likeFold(body.charAt(i)));
    else {
      const from = likeRangeEnd(body.charAt(i));
      const to = likeRangeEnd(body.charAt(i + 2));
      if (from === undefined || to === undefined) unranked = true;
      else ranges.push([from, to]);
      i += 2;
      // A `-` right after a range and before another character is dropped.
      if (body.charAt(i + 1) === '-' && i + 2 < body.length) i++;
    }
  }
  return { kind: 'class', content, negated, broken, members, ranges, unranked };
}

/** The tokens of a SQL Server LIKE pattern (`%`, `_` and `[...]` classes), one per UTF-16 code unit position. */
export function likeRuns(pattern: string): LikeRuns {
  const ended: LikeToken[][] = [];
  let tokens: LikeToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '%') {
      ended.push(tokens);
      tokens = [];
    } else if (ch === '_') tokens.push({ kind: 'any' });
    else if (ch === '[') {
      // A class ends at the first `]` after its `[`, or at the end of the pattern.
      const close = pattern.indexOf(']', i + 1);
      const end = close < 0 ? pattern.length : close;
      tokens.push(likeClass(pattern.slice(i + 1, end)));
      i = end;
    } else tokens.push({ kind: 'unit', folded: likeFold(ch) });
  }
  const [head, ...middle] = ended;
  return head === undefined ? { head: tokens, middle: [], tail: undefined } : { head, middle, tail: tokens };
}

/** A class's verdict on a code unit that is or is not one of its members and has `rank`. */
function classVerdict(token: LikeClass, member: boolean, rank: number | undefined): LikeVerdict {
  if (token.broken) return 'unsupported';
  const inRange = rank !== undefined && token.ranges.some(([from, to]) => from <= rank && rank <= to);
  if (member || inRange) return token.negated ? 'miss' : 'match';
  if (token.unranked || (rank === undefined && token.ranges.length > 0)) return 'unsupported';
  return token.negated ? 'match' : 'miss';
}

/** `token`'s verdict on the code unit `ch`. */
export function likeVerdict(token: LikeToken, ch: string): LikeVerdict {
  if (token.kind === 'any') return 'match';
  if (token.kind === 'unit') return likeFold(ch) === token.folded ? 'match' : 'miss';
  return classVerdict(token, token.members.has(likeFold(ch)), LIKE_RANKS.get(ch));
}

/** The code units on which `token` gives each verdict, over all 65536. */
export function likeVerdictUnits(token: LikeToken): Readonly<Record<LikeVerdict, LikeUnitRanges>> {
  // Every code unit outside `special` takes the verdict `rest`.
  let special: number[] = [];
  let rest: LikeVerdict = 'match';
  if (token.kind === 'unit') {
    special = [...(foldIndex().get(token.folded) ?? [])];
    rest = 'miss';
  } else if (token.kind === 'class') {
    const members = [...token.members].flatMap((member) => foldIndex().get(member) ?? []);
    special = [...new Set([...Array.from({ length: RANKED_UNITS }, (_, unit) => unit), ...members])].sort((a, b) => a - b);
    rest = classVerdict(token, false, undefined);
  }
  const units: Record<LikeVerdict, [number, number][]> = { match: [], miss: [], unsupported: [] };
  const add = (verdict: LikeVerdict, from: number, to: number): void => {
    if (from > to) return;
    const last = units[verdict].at(-1);
    if (last !== undefined && last[1] === from - 1) last[1] = to;
    else units[verdict].push([from, to]);
  };
  let next = 0;
  for (const unit of special) {
    add(rest, next, unit - 1);
    add(likeVerdict(token, String.fromCharCode(unit)), unit, unit);
    next = unit + 1;
  }
  add(rest, next, BMP_UNITS - 1);
  return units;
}
