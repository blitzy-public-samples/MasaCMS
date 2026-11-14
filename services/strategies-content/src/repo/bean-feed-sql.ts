/** The JSON API beanFeed plan as data, the feed source contract, and a source that filters, counts and pages one SQL scope. */
import type { CanonicalType, TableDefinition } from '@opt2/platform/migration-kit';
import type { QueryResultRow, TenantTx } from '@opt2/platform/tenancy';
import { SqlParams } from './content-queries.js';
import { likeRuns, likeVerdictUnits, type LikeToken, type LikeUnitRanges } from './feed-like.js';

/** A param's comparison type: its column's property hint, else varchar. */
export type FeedParamType = 'varchar' | 'numeric' | 'timestamp';

/** A param's SQL operator, as queryParam.setCondition leaves it. */
export type FeedOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like';

/** One param of a feed's WHERE clause. */
export interface FeedParamCondition {
  readonly kind: 'param';
  /** Lower-cased column name. */
  readonly column: string;
  /** The column as the request named it, which row lookups use. */
  readonly field: string;
  readonly type: FeedParamType;
  readonly condition: FeedOperator;
  readonly criteria: string;
  readonly isNull: boolean;
  /** `in` and `not in`: the listed values, `['']` for an empty list. */
  readonly items?: readonly string[];
  /** `like`: the SQL Server LIKE pattern. */
  readonly pattern?: string;
  /** `timestamp`: epoch milliseconds of each compared value (the criteria, or each item), 0 for one that is no date. */
  readonly times?: readonly number[];
}

/** A feed's WHERE clause: params joined with SQL precedence and three-valued logic. */
export type FeedCondition =
  | FeedParamCondition
  | { readonly kind: 'and' | 'or'; readonly left: FeedCondition; readonly right: FeedCondition };

/** One ORDER BY term; ascending sorts NULL first, descending last. */
export interface FeedOrderTerm {
  /** Lower-cased column name. */
  readonly column: string;
  /** The column as the request named it, which row lookups use. */
  readonly field: string;
  readonly desc: boolean;
  readonly type: FeedParamType;
}

/** The rows a feed selects (its whole scope without `where`) and the terms ordering them ahead of the scope's own order. */
export interface FeedQuery {
  readonly where?: FeedCondition;
  readonly order: readonly FeedOrderTerm[];
}

/** A source's row count for a query, `throws` for an error the evaluator raises, or `rows` when only memory is exact. */
export type FeedCount<R = unknown> =
  | {
      readonly kind: 'count';
      readonly count: number;
      /** A varchar term orders a non-null complex value, which a row of another source could pair with. */
      readonly pairable: boolean;
      /** A numeric or timestamp term orders a value the evaluator's comparator cannot order (NaN, infinite). */
      readonly unstable: boolean;
    }
  | {
      readonly kind: 'throws';
      /** The scope's first row on which filtering raises; none when ordering the selected rows converts a complex value. */
      readonly rows: readonly R[];
    }
  | { readonly kind: 'rows' };

/** The rows of a JSON API feed, filtered, counted and paged where they are held. */
export interface BeanFeedSource<R> {
  /** The rows' columns, which a feed without declared columns checks requests against. */
  readonly columns: readonly string[];
  /** True when the scope holds no row. */
  isEmpty(): Promise<boolean>;
  /**
   * Rows on which filtering by `where` in memory raises what filtering the scope raises: its first raising row, every
   * row when only memory can tell, none when filtering raises nothing.
   */
  filterThrows(where: FeedCondition | undefined): Promise<readonly R[]>;
  count(query: FeedQuery): Promise<FeedCount<R>>;
  /** `limit` rows of `query` after the first `offset`, ordered by its terms, then by the scope's order. */
  rows(query: FeedQuery, offset: number, limit: number): Promise<R[]>;
  /** Every row of the scope in its own order. */
  all(): Promise<R[]>;
}

/** A table a spec reads; its unit's window phase gates the reads. */
export type FeedTableDef = Readonly<Pick<TableDefinition, 'table' | 'key' | 'unit'>>;

/** A row column: its SQL expression and the canonical type of the value the row holds. */
export interface FeedColumn {
  readonly sql: string;
  readonly type: CanonicalType;
}

/** One SQL feed scope. */
export interface FeedTableSpec {
  readonly defs: readonly FeedTableDef[];
  readonly from: string;
  /** The scope's predicates; they reference `$1`, the transaction's tenant id, and bind `values` from `$2`. */
  readonly where: readonly string[];
  readonly values: readonly unknown[];
  /** The rows' columns in SELECT order, under lower-cased names. */
  readonly columns: Readonly<Record<string, FeedColumn>>;
  /** ORDER BY keys of the scope's own row order; together they are unique per row. */
  readonly tieBreak: readonly string[];
}

/** Runs one statement's work in a tenant transaction. */
export type FeedRunner = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

/** The repository's raw SELECT, read behind the units of `defs`. */
export type FeedSelect = <R extends QueryResultRow>(
  tx: TenantTx,
  defs: readonly FeedTableDef[],
  sql: string,
  values: readonly unknown[],
) => Promise<R[]>;

/** Settings of {@link sqlFeedSource}. */
export interface SqlFeedSourceOptions {
  readonly spec: FeedTableSpec;
  readonly run: FeedRunner;
  readonly select: FeedSelect;
  /** Qualified collation comparing and ordering text as Intl.Collator('en', { sensitivity: 'accent' }) does. */
  readonly collation: string;
}

type Comparison = '=' | '!=' | '>' | '>=' | '<' | '<=';

const SQL_OPERATOR: Readonly<Record<Comparison, string>> = Object.freeze({
  '=': '=',
  '!=': '<>',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
});
const UNKNOWN = 'NULL::boolean';
// Values cfText refuses: dates and binaries.
const COMPLEX_TYPES: ReadonlySet<CanonicalType> = new Set<CanonicalType>(['t', 'b']);
const NUMERIC_TYPES: ReadonlySet<CanonicalType> = new Set<CanonicalType>(['i', 'f', 'd']);
// Column types whose values may be NaN or infinite.
const FLOAT_TYPES: ReadonlySet<CanonicalType> = new Set<CanonicalType>(['f', 'd']);
const ASTRAL = '[\\U00010000-\\U0010FFFF]';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BMP_UNITS = 0x10000;
// A unit image writes surrogate unit u as code point SURROGATE_IMAGE + (u - 0xD800), in U+F0000–U+F07FF.
const SURROGATE_IMAGE = 0xf0000;
// Like NUL, a completely ignorable starter to the collation; unlike NUL, text can hold it.
const NUL_STAND_IN = '\u0001';
// The largest bound of an ARE `{m}` repetition.
const DUP_MAX = 255;
// The longest LIKE patterns, the second for one a class can raise on, whose AREs PostgreSQL compiles in bounded time;
// a like param of a longer pattern has no SQL form, so only memory evaluates it.
const LIKE_SQL_LENGTH = 16384;
const LIKE_SQL_RAISING_LENGTH = 2048;

let trailingSpace: string | undefined;

/** The `\uXXXX` or `\UXXXXXXXX` ARE escape of a code point. */
function unitEscape(unit: number): string {
  return unit < BMP_UNITS ? `\\u${unit.toString(16).padStart(4, '0')}` : `\\U${unit.toString(16).padStart(8, '0')}`;
}

/** A predicate NULL for a NULL `value` and `truth` for any other. */
function constant(value: string, truth: boolean): string {
  return `(CASE WHEN (${value}) IS NULL THEN NULL::boolean ELSE ${String(truth)} END)`;
}

/** An ARE bracket expression of sorted, distinct code points, as ranges; undefined for none. */
function bracketOf(units: readonly number[]): string | undefined {
  const parts: string[] = [];
  let start = -1;
  let end = -1;
  const close = (): void => {
    if (start >= 0) parts.push(start === end ? unitEscape(start) : `${unitEscape(start)}-${unitEscape(end)}`);
  };
  for (const unit of units) {
    if (unit === end + 1 && start >= 0) end = unit;
    else {
      close();
      start = unit;
      end = unit;
    }
  }
  close();
  return parts.length === 0 ? undefined : `[${parts.join('')}]`;
}

/** The ARE of the trailing run String.prototype.trimEnd removes. */
function trailingSpaceRegex(): string {
  if (trailingSpace === undefined) {
    const spaces: number[] = [];
    for (let unit = 0; unit < BMP_UNITS; unit++) if (String.fromCharCode(unit).trimEnd() === '') spaces.push(unit);
    trailingSpace = `${bracketOf(spaces) ?? '[ ]'}+$`;
  }
  return trailingSpace;
}

/** `atom` repeated `count` times, nesting repetitions past DUP_MAX. */
function repeat(atom: string, count: number): string {
  if (count <= 1) return count === 1 ? atom : '';
  if (count <= DUP_MAX) return `${atom}{${String(count)}}`;
  return `${repeat(`(?:${atom}{${String(DUP_MAX)}})`, Math.floor(count / DUP_MAX))}${repeat(atom, count % DUP_MAX)}`;
}

/** An ARE bracket of code-unit `ranges` in a unit image, without NUL, which stored text never holds; undefined for none. */
function imageBracket(ranges: LikeUnitRanges): string | undefined {
  const parts: string[] = [];
  const add = (from: number, to: number, image: number): void => {
    if (from <= to) parts.push(from === to ? unitEscape(from + image) : `${unitEscape(from + image)}-${unitEscape(to + image)}`);
  };
  for (const [from, to] of ranges) {
    add(Math.max(from, 1), Math.min(to, 0xd7ff), 0);
    add(Math.max(from, 0xd800), Math.min(to, 0xdfff), SURROGATE_IMAGE - 0xd800);
    add(Math.max(from, 0xe000), to, 0);
  }
  return parts.length === 0 ? undefined : `[${parts.join('')}]`;
}

/** A LIKE token's ARE brackets over a unit image: the code units it matches and those it raises on; undefined for none. */
interface TokenSql {
  readonly match: string | undefined;
  readonly raise: string | undefined;
}

function tokenSql(token: LikeToken): TokenSql {
  if (token.kind === 'any') return { match: '.', raise: undefined };
  const units = likeVerdictUnits(token);
  return { match: imageBracket(units.match), raise: imageBracket(units.unsupported) };
}

/** The ARE alternation of `a` and `b`, undefined standing for one that matches nothing. */
function either(a: string | undefined, b: string | undefined): string | undefined {
  return a === undefined || b === undefined ? (a ?? b) : `(?:${a}|${b})`;
}

/** The ARE sequence of `a` then `b`, undefined standing for one that matches nothing. */
function then(a: string | undefined, b: string | undefined): string | undefined {
  return a === undefined || b === undefined ? undefined : `${a}${b}`;
}

/** The ARE of `run` fitting at one position; undefined when one of its tokens matches no code unit. */
function fitOf(run: readonly TokenSql[]): string | undefined {
  let fit = '';
  for (const token of run) {
    if (token.match === undefined) return undefined;
    fit += token.match;
  }
  return fit;
}

/** `(?:P0|A0(?:P1|A1(?:…)))`: reading `run` from one position raises; its tokens before k match (A) and token k raises (P). */
function raisesAt(run: readonly TokenSql[]): string | undefined {
  return run.reduceRight<string | undefined>((deeper, token) => either(token.raise, then(token.match, deeper)), undefined);
}

/** A LIKE pattern as AREs over a unit image: the values LikePattern matches, and those it raises on. */
interface LikeSql {
  /** undefined: it matches no value. */
  readonly match: string | undefined;
  /** Anchored at the start only; undefined: it raises on no value. */
  readonly raise: string | undefined;
  /** False when `match` reads text alike, without a unit image. */
  readonly units: boolean;
}

const likeSqls = new WeakMap<FeedParamCondition, LikeSql | undefined>();

/**
 * LikePattern's leftmost fit as AREs, undefined past the lengths SQL compiles. `match` is the existential pattern, which
 * the leftmost fit equals on every value it does not raise on. `raise` walks the fit: the head at the start, each middle
 * run past the positions it misses at to the first it raises at or fits, then the tail at the end.
 */
function likeSql(pattern: string): LikeSql | undefined {
  if (pattern.length > LIKE_SQL_LENGTH) return undefined;
  const compiled = new Map<string, TokenSql>();
  const sqlOf = (run: readonly LikeToken[]): TokenSql[] =>
    run.map((token) => {
      const key = token.kind === 'class' ? `c${token.content}` : token.kind === 'unit' ? `u${token.folded}` : 'a';
      const held = compiled.get(key) ?? tokenSql(token);
      compiled.set(key, held);
      return held;
    });
  const runs = likeRuns(pattern);
  const head = sqlOf(runs.head);
  // An empty run fits where the scan stands, so only `.*` is left of it.
  const middle = runs.middle.filter((run) => run.length > 0).map(sqlOf);
  const tail = runs.tail === undefined ? undefined : sqlOf(runs.tail);
  const raising = [...compiled.values()].some((token) => token.raise !== undefined);
  if (raising && pattern.length > LIKE_SQL_RAISING_LENGTH) return undefined;
  const units = /[_[\uD800-\uDFFF]/.test(pattern);
  // Lookaheads for the room a run needs, and for the exact room a run anchored at the end leaves.
  const room = (run: readonly TokenSql[]): string => `(?=${repeat('.', run.length)})`;
  const ends = (run: readonly TokenSql[]): string => `(?=${repeat('.', run.length)}$)`;
  if (tail === undefined) return { match: then('^', then(fitOf(head), '$')), raise: then(`^${ends(head)}`, raisesAt(head)), units };
  const fits = [head, ...middle, tail].map(fitOf);
  const match = fits.some((fit) => fit === undefined) ? undefined : `^${fits.join('.*')}$`;
  if (!raising) return { match, raise: undefined, units };
  let rest = then(`.*${ends(tail)}`, raisesAt(tail));
  for (const run of middle.toReversed()) {
    const raise = raisesAt(run);
    const fit = fitOf(run);
    // With room for the run, a position it neither fits nor raises at is one it misses at.
    const scan = `(?:${room(run)}${fit === undefined ? '' : `(?!${fit})`}${raise === undefined ? '' : `(?!${raise})`}.)*`;
    rest = then(scan, either(then(room(run), raise), then(fit, rest)));
  }
  return { match, raise: then('^', either(then(room(head), raisesAt(head)), then(fitOf(head), rest))), units };
}

/** The compiled `like` pattern of a param, once per param. */
function likeSqlOf(param: FeedParamCondition, pattern: string): LikeSql | undefined {
  if (!likeSqls.has(param)) likeSqls.set(param, likeSql(pattern));
  return likeSqls.get(param);
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The params of `where`, in clause order. */
function paramsOf(where: FeedCondition | undefined): FeedParamCondition[] {
  if (where === undefined) return [];
  return where.kind === 'param' ? [where] : [...paramsOf(where.left), ...paramsOf(where.right)];
}

function orderBy(keys: readonly string[]): string {
  return keys.length === 0 ? '' : ` ORDER BY ${keys.join(', ')}`;
}

/** Compiles feed queries over one spec into SQL, every value bound after the spec's own. */
class FeedSql {
  readonly p: SqlParams;
  #trim: string | undefined;
  #astral: string | undefined;

  constructor(
    private readonly spec: FeedTableSpec,
    private readonly collation: string,
  ) {
    this.p = new SqlParams(1 + spec.values.length);
  }

  /** The statement's values: the tenant id, the spec's values, then the compiled ones. */
  values(tenantId: string): unknown[] {
    return [tenantId, ...this.spec.values, ...this.p.values];
  }

  scope(): string {
    return this.spec.where.length === 0 ? 'true' : this.spec.where.map((predicate) => `(${predicate})`).join(' AND ');
  }

  column(name: string): FeedColumn | undefined {
    return Object.hasOwn(this.spec.columns, name) ? this.spec.columns[name] : undefined;
  }

  /** A column's value as cfText(value).trimEnd() reads it; undefined for a type it holds no exact text form of. */
  private text(column: FeedColumn): string | undefined {
    if (column.type === 's') {
      this.#trim ??= this.p.add(trailingSpaceRegex());
      return `regexp_replace((${column.sql})::text COLLATE "C", ${this.#trim}::text, '')`;
    }
    return column.type === 'i' || column.type === 'd' ? `((${column.sql})::text COLLATE "C")` : undefined;
  }

  /** The unit image of a text column's `text`: each UTF-16 code unit one character, read apart only for a value holding astral text. */
  private unitImage(column: FeedColumn, text: string): string {
    this.#astral ??= this.p.add(ASTRAL);
    const point = 'ascii(feed_unit.ch)';
    const halves =
      `chr(${String(SURROGATE_IMAGE)} + ((${point} - ${String(BMP_UNITS)}) >> 10))` +
      ` || chr(${String(SURROGATE_IMAGE + 0x400)} + ((${point} - ${String(BMP_UNITS)}) & 1023))`;
    const image =
      `(SELECT string_agg(CASE WHEN ${point} >= ${String(BMP_UNITS)} THEN ${halves} ELSE feed_unit.ch END, '' ORDER BY feed_unit.pos)` +
      ` FROM regexp_split_to_table(${text}, '') WITH ORDINALITY AS feed_unit(ch, pos))`;
    return `(CASE WHEN (${column.sql})::text COLLATE "C" ~ ${this.#astral}::text THEN ${image} COLLATE "C" ELSE ${text} END)`;
  }

  /** `where` as a predicate, or undefined when SQL cannot evaluate it as the in-memory evaluator does. */
  condition(where: FeedCondition | undefined): string | undefined {
    if (where === undefined) return 'true';
    if (where.kind === 'param') return this.param(where);
    const left = this.condition(where.left);
    const right = this.condition(where.right);
    return left === undefined || right === undefined ? undefined : `(${left} ${where.kind === 'and' ? 'AND' : 'OR'} ${right})`;
  }

  private param(param: FeedParamCondition): string | undefined {
    const column = this.column(param.column);
    if (param.isNull) {
      const value = column?.sql ?? 'NULL';
      if (param.condition === '=') return `((${value}) IS NULL)`;
      return param.condition === '!=' ? `((${value}) IS NOT NULL)` : UNKNOWN;
    }
    if (column === undefined) return UNKNOWN;
    if (param.type === 'varchar') return this.varchar(param, column);
    return param.type === 'numeric' ? this.numeric(param, column) : this.timestamp(param, column);
  }

  private varchar(param: FeedParamCondition, column: FeedColumn): string | undefined {
    // A non-null complex value makes filtering raise, so every value reaching this predicate is NULL.
    if (COMPLEX_TYPES.has(column.type)) return UNKNOWN;
    const text = this.text(column);
    if (text === undefined) return undefined;
    if (param.pattern !== undefined) {
      const like = likeSqlOf(param, param.pattern);
      if (like === undefined) return undefined;
      if (like.match === undefined) return constant(text, false);
      const subject = like.units && column.type === 's' ? this.unitImage(column, text) : `(${text})`;
      return `(${subject} ~ ${this.p.add(like.match)}::text)`;
    }
    const operands = (param.items ?? [param.criteria]).map((value) => value.trimEnd().replaceAll('\u0000', NUL_STAND_IN));
    // A lone surrogate has a collation weight of its own, which no storable text carries.
    const storable = operands.filter((value) => !LONE_SURROGATE.test(value));
    const collated = `(${text}) COLLATE ${this.collation}`;
    if (param.condition === 'in' || param.condition === 'not in') {
      const found = storable.length === 0 ? constant(text, false) : `(${collated} = ANY (${this.p.add(storable)}::text[]))`;
      return param.condition === 'in' ? found : `(NOT ${found})`;
    }
    if (param.condition === 'like') return undefined;
    if (storable.length === 0) {
      // Text cannot hold the operand, so SQL has no order of it against stored text.
      return param.condition === '=' || param.condition === '!=' ? constant(text, param.condition === '!=') : undefined;
    }
    return `(${collated} ${SQL_OPERATOR[param.condition]} ${this.p.add(storable[0] ?? '')}::text)`;
  }

  private numeric(param: FeedParamCondition, column: FeedColumn): string | undefined {
    if (!NUMERIC_TYPES.has(column.type) || param.condition === 'like') return undefined;
    const value = `(${column.sql})::float8`;
    const test = (op: Comparison, n: number): string => {
      if (Number.isNaN(n)) return `(CASE WHEN (${column.sql}) IS NULL THEN NULL::boolean ELSE ${String(op === '!=')} END)`;
      const compared = `${value} ${SQL_OPERATOR[op]} ${this.p.add(n)}::float8`;
      if (!FLOAT_TYPES.has(column.type)) return `(${compared})`;
      return `(CASE WHEN ${value} = 'NaN'::float8 THEN ${String(op === '!=')} ELSE ${compared} END)`;
    };
    const operands = (param.items ?? [param.criteria]).map(Number);
    if (param.condition === 'in') return `(${operands.map((n) => test('=', n)).join(' OR ')})`;
    if (param.condition === 'not in') return `(${operands.map((n) => test('!=', n)).join(' AND ')})`;
    return test(param.condition, operands[0] ?? Number.NaN);
  }

  private timestamp(param: FeedParamCondition, column: FeedColumn): string | undefined {
    const times = param.times ?? [];
    if (column.type !== 't' || times.length === 0 || param.condition === 'like') return undefined;
    // The driver binds a Date as its process-local wall clock, as it binds the stored timestamps.
    const test = (op: Comparison, ms: number): string => `((${column.sql}) ${SQL_OPERATOR[op]} ${this.p.add(new Date(ms))}::timestamp)`;
    if (param.condition === 'in') return `(${times.map((ms) => test('=', ms)).join(' OR ')})`;
    if (param.condition === 'not in') return `(${times.map((ms) => test('!=', ms)).join(' AND ')})`;
    return test(param.condition, times[0] ?? 0);
  }

  /** The value a term orders by; null when every row ties on it, undefined when SQL cannot order it as the evaluator does. */
  private sortKey(term: FeedOrderTerm): string | null | undefined {
    const column = this.column(term.column);
    if (column === undefined) return null;
    if (term.type === 'varchar') {
      if (COMPLEX_TYPES.has(column.type)) return `((${column.sql}) IS NOT NULL)`;
      const text = this.text(column);
      return text === undefined ? undefined : `(${text}) COLLATE ${this.collation}`;
    }
    if (term.type === 'numeric') return NUMERIC_TYPES.has(column.type) ? `(${column.sql})::float8` : undefined;
    return column.type === 't' ? `(${column.sql})` : undefined;
  }

  /** ORDER BY keys of `terms`, or undefined when SQL cannot order them as the evaluator does. */
  order(terms: readonly FeedOrderTerm[]): string[] | undefined {
    const keys: string[] = [];
    for (const term of terms) {
      const key = this.sortKey(term);
      if (key === undefined) return undefined;
      if (key !== null) keys.push(`${key} ${term.desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`);
    }
    return keys;
  }

  /**
   * Predicates true for a scope row on which filtering by `where` raises: it converts a complex value to text, or a
   * like param raises on the value. Undefined when SQL cannot tell: a like pattern past the lengths SQL compiles, or a
   * value a like param could raise on that SQL holds no exact text of.
   */
  raising(where: FeedCondition | undefined): string[] | undefined {
    const predicates: string[] = [];
    for (const param of paramsOf(where)) {
      const column = this.column(param.column);
      if (param.isNull || param.type !== 'varchar' || column === undefined) continue;
      if (COMPLEX_TYPES.has(column.type)) predicates.push(`(${column.sql}) IS NOT NULL`);
      else if (param.pattern !== undefined) {
        const like = likeSqlOf(param, param.pattern);
        if (like === undefined) return undefined;
        if (like.raise === undefined) continue;
        const text = this.text(column);
        if (text === undefined) return undefined;
        const subject = column.type === 's' ? this.unitImage(column, text) : `(${text})`;
        predicates.push(`((${column.sql}) IS NOT NULL AND (${subject} ~ ${this.p.add(like.raise)}::text))`);
      }
    }
    return predicates;
  }

  /** Predicates true for a row whose value of a numeric term the evaluator's comparator cannot order. */
  unstableTerms(terms: readonly FeedOrderTerm[]): string[] {
    return terms.flatMap((term) => {
      const column = this.column(term.column);
      if (term.type !== 'numeric' || column === undefined || !FLOAT_TYPES.has(column.type)) return [];
      return [`(${column.sql})::float8 IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)`];
    });
  }

  /** For each varchar term over complex values: its value and the keys of the terms before it, which a pair of rows ties on. */
  complexTerms(terms: readonly FeedOrderTerm[]): { value: string; ties: string[] }[] {
    return terms.flatMap((term, index) => {
      const column = this.column(term.column);
      if (term.type !== 'varchar' || column === undefined || !COMPLEX_TYPES.has(column.type)) return [];
      const ties = terms.slice(0, index).flatMap((earlier) => this.sortKey(earlier) ?? []);
      return [{ value: column.sql, ties }];
    });
  }
}

/** The statement flags {@link sqlFeedSource}'s count reads. */
type CountRow = { n: number } & Record<string, unknown>;

/** A feed source over one SQL scope: each method runs its statements in `run`, through `select`'s gated reads. */
export function sqlFeedSource<R extends QueryResultRow>({ spec, run, select, collation }: SqlFeedSourceOptions): BeanFeedSource<R> {
  const selected = Object.entries(spec.columns)
    .map(([name, column]) => `${column.sql} AS ${quoteIdent(name)}`)
    .join(', ');
  const compiler = (): FeedSql => new FeedSql(spec, collation);
  const exists = async (sql: FeedSql, predicates: readonly string[]): Promise<boolean> => {
    const statement = `SELECT EXISTS (SELECT 1 FROM ${spec.from} WHERE ${sql.scope()} AND (${predicates.join(' OR ')})) AS found`;
    const [row] = await run((tx) => select<{ found: boolean }>(tx, spec.defs, statement, sql.values(tx.tenantId)));
    return row?.found === true;
  };
  const all = (): Promise<R[]> => {
    const sql = compiler();
    const statement = `SELECT ${selected} FROM ${spec.from} WHERE ${sql.scope()}${orderBy(spec.tieBreak)}`;
    return run((tx) => select<R>(tx, spec.defs, statement, sql.values(tx.tenantId)));
  };
  const raisingRows = async (where: FeedCondition | undefined): Promise<R[]> => {
    const sql = compiler();
    const raising = sql.raising(where);
    if (raising === undefined) return all();
    if (raising.length === 0) return [];
    const statement = `SELECT ${selected} FROM ${spec.from} WHERE ${sql.scope()} AND (${raising.join(' OR ')})${orderBy(spec.tieBreak)} LIMIT 1`;
    return run((tx) => select<R>(tx, spec.defs, statement, sql.values(tx.tenantId)));
  };

  return {
    columns: Object.keys(spec.columns),

    async isEmpty() {
      const sql = compiler();
      return !(await exists(sql, ['true']));
    },

    filterThrows: raisingRows,

    async count(query) {
      const sql = compiler();
      const where = sql.condition(query.where);
      const raising = sql.raising(query.where);
      // A separate compiler checks the order, so the count binds no value it does not reference.
      if (where === undefined || raising === undefined || compiler().order(query.order) === undefined) return { kind: 'rows' };
      const scope = `FROM ${spec.from} WHERE ${sql.scope()}`;
      const filtered = `${scope} AND ${where}`;
      const flags = [`(SELECT count(*)::integer ${filtered}) AS n`];
      if (raising.length > 0) flags.push(`EXISTS (SELECT 1 ${scope} AND (${raising.join(' OR ')})) AS raises`);
      const unstable = sql.unstableTerms(query.order);
      if (unstable.length > 0) flags.push(`EXISTS (SELECT 1 ${filtered} AND (${unstable.join(' OR ')})) AS unstable`);
      const terms = sql.complexTerms(query.order);
      terms.forEach(({ value, ties }, index) => {
        const nonNull = `${filtered} AND (${value}) IS NOT NULL`;
        const grouped = ties.length === 0 ? '' : ` GROUP BY ${ties.join(', ')}`;
        flags.push(`EXISTS (SELECT 1 ${nonNull}${grouped} HAVING count(*) > 1) AS paired_${String(index)}`);
        flags.push(`EXISTS (SELECT 1 ${nonNull}) AS pairable_${String(index)}`);
      });
      const [row] = (await run((tx) => select<CountRow>(tx, spec.defs, `SELECT ${flags.join(', ')}`, sql.values(tx.tenantId)))) as [CountRow];
      const flagged = (name: string): boolean => terms.some((_, index) => row[`${name}_${String(index)}`] === true);
      if (row['raises'] === true) {
        const rows = await raisingRows(query.where);
        // The raising rows a concurrent write removed in between leave only memory exact.
        return rows.length > 0 ? { kind: 'throws', rows } : { kind: 'rows' };
      }
      if (row['unstable'] === true) return { kind: 'rows' };
      if (flagged('paired')) return { kind: 'throws', rows: [] };
      return { kind: 'count', count: row.n, pairable: flagged('pairable'), unstable: false };
    },

    rows(query, offset, limit) {
      const sql = compiler();
      const where = sql.condition(query.where);
      const keys = sql.order(query.order);
      if (where === undefined || keys === undefined) return Promise.reject(new Error('The feed query has no SQL form; count() answers rows for it'));
      const statement =
        `SELECT ${selected} FROM ${spec.from} WHERE ${sql.scope()} AND ${where}${orderBy([...keys, ...spec.tieBreak])}` +
        ` LIMIT ${sql.p.add(limit)}::bigint OFFSET ${sql.p.add(offset)}::bigint`;
      return run((tx) => select<R>(tx, spec.defs, statement, sql.values(tx.tenantId)));
    },

    all,
  };
}
