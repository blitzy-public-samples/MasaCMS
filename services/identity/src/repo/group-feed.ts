/** The JSON API group feed's params, ORDER BY, TOP and page cut as SQL over `identity.group_account` [legacy: core/mura/user/userGateway.cfc:164-592]. */
import { GROUP_ACCOUNT, type GroupAccountRow } from './tables.js';

/** A `tusers` param datatype, which decides how a feed compares the column. */
export type FeedColumnType = 'varchar' | 'numeric' | 'timestamp';

/** A feed param comparison other than IN and LIKE. */
export type FeedComparison = '=' | '!=' | '<' | '<=' | '>' | '>=';

/** One feed param as the WHERE clause tests a group_account column, with the criteria as the legacy queryParam binds it. */
export type GroupFeedCondition =
  | { kind: 'null'; column: string; negated: boolean }
  | { kind: 'compare'; column: string; type: FeedColumnType; op: FeedComparison; value: string | number | Date }
  | { kind: 'in'; column: string; type: FeedColumnType; negated: boolean; items: readonly string[] }
  | { kind: 'like'; column: string; pattern: string };

/** A condition joined to the previous one by `relationship`, AND binding before OR. */
export interface GroupFeedFilter {
  relationship: 'and' | 'or';
  condition: GroupFeedCondition;
}

/** One ORDER BY key: NULLs first ascending, last descending. */
export interface GroupFeedSortKey {
  column: string;
  type: FeedColumnType;
  desc: boolean;
}

/** What a feed selects of one user pool. */
export interface GroupFeedQuery {
  /** Selects S2 groups too; otherwise only those whose S2 is 0. */
  includeS2?: boolean;
  /** Selects only groups whose InActive equals it. */
  inactive?: number;
  filters: readonly GroupFeedFilter[];
  /** Keys ahead of the userid tie-break. */
  order: readonly GroupFeedSortKey[];
  /** The TOP that caps `total`; Infinity for none. */
  top: number;
  /** The most leading rows returned; Infinity for every one. */
  limit: number;
}

/** The leading rows of a feed's selection in its order, and how many rows it selects up to its TOP. */
export interface GroupFeedPage {
  rows: GroupAccountRow[];
  total: number;
}

/** A compiled feed: its WHERE clause and ORDER BY over alias `g`, and the values they bind from the first free placeholder on. */
export interface CompiledGroupFeed {
  where: string;
  orderBy: string;
  params: unknown[];
}

/** Columns a feed may name; the target-only tenant and version columns are no `tusers` column. */
const FEED_COLUMNS: ReadonlySet<string> = new Set(
  GROUP_ACCOUNT.columns.map((column) => column.name).filter((name) => name !== 'tenant_id' && name !== 'row_version'),
);

/** The char(35) columns of 0002_accounts.sql, which pg returns blank-padded to their width. */
const CHAR_WIDTHS: ReadonlyMap<string, number> = new Map([
  ['userid', 35],
  ['photofileid', 35],
]);

/** Follows each supplementary code point of a LIKE operand, so `_` steps over it as over the two UTF-16 units likeMatcher reads. */
const SURROGATE_MARK = '\u{10FFFF}';

/** BMP code units the case-insensitive non-unicode RegExp likeMatcher builds folds (ECMAScript `Canonicalize`), with their folds. */
let folds: { map: ReadonlyMap<string, string>; from: string; to: string } | undefined;

function caseFolds(): { map: ReadonlyMap<string, string>; from: string; to: string } {
  if (folds === undefined) {
    const map = new Map<string, string>();
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const unit = String.fromCharCode(code);
      const upper = unit.toUpperCase();
      if (upper.length === 1 && upper !== unit && !(code >= 0x80 && upper.charCodeAt(0) < 0x80)) map.set(unit, upper);
    }
    folds = { map, from: [...map.keys()].join(''), to: [...map.values()].join('') };
  }
  return folds;
}

/** Whether PostgreSQL can bind `text` unchanged: well-formed UTF-16 without U+0000. */
function bindable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) return false;
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    }
  }
  return true;
}

/**
 * Whether compileGroupFeed reproduces `condition` exactly. PostgreSQL LIKE has no `[...]` class, cannot bind ill-formed or
 * NUL-holding text, and a pattern holding the surrogate mark could align with the mark itself.
 */
export function isSqlExpressible(condition: GroupFeedCondition): boolean {
  switch (condition.kind) {
    case 'null':
      return true;
    case 'compare':
      return typeof condition.value !== 'string' || bindable(condition.value);
    case 'in':
      return condition.type !== 'varchar' || condition.items.every(bindable);
    case 'like': {
      const { pattern } = condition;
      const open = pattern.indexOf('[');
      return !(open >= 0 && pattern.lastIndexOf(']') > open) && bindable(pattern) && !pattern.includes(SURROGATE_MARK);
    }
  }
}

/** A LIKE pattern in the folded form the SQL operand takes: units case-folded, each surrogate pair followed by the mark. */
function sqlLikePattern(pattern: string): string {
  const { map } = caseFolds();
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const code = pattern.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      out += pattern.slice(i, i + 2) + SURROGATE_MARK;
      i += 1;
    } else {
      const unit = pattern.charAt(i);
      out += map.get(unit) ?? unit;
    }
  }
  return out;
}

/** SQL Server's trailing-space-insensitive text, as compareText strips it. */
function untrailed(text: string): string {
  return text.replace(/ +$/, '');
}

/**
 * Compiles a feed's filters and order against alias `g`, binding values from `$first`: varchar comparisons under
 * `textCollation` (compareText's order), LIKE over the likeMatcher case folding with no escape character.
 */
export function compileGroupFeed(
  query: Pick<GroupFeedQuery, 'filters' | 'order'>,
  { textCollation, first }: { textCollation: string; first: number },
): CompiledGroupFeed {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${first + params.length - 1}`;
  };
  let foldParams: { from: string; to: string } | undefined;
  const column = (name: string): string => {
    if (!FEED_COLUMNS.has(name)) throw new RangeError(`${name} is not a group_account column a feed may name`);
    return `g."${name}"`;
  };
  const text = (name: string): string => `rtrim(${column(name)}::text, ' ') COLLATE ${textCollation}`;
  const atom = (condition: GroupFeedCondition): string => {
    const ref = column(condition.column);
    if (condition.kind === 'null') return `${ref} IS ${condition.negated ? 'NOT ' : ''}NULL`;
    if (condition.kind === 'like') {
      const width = CHAR_WIDTHS.get(condition.column);
      const operand = `(${width === undefined ? `${ref}::text` : `rpad(${ref}::text, ${width})`} COLLATE "C")`;
      if (foldParams === undefined) {
        const { from, to } = caseFolds();
        foldParams = { from: bind(from), to: bind(to) };
      }
      // An all-ASCII operand folds by upper(); a fixed regex marks supplementary code points of any other.
      const folded =
        `CASE WHEN octet_length(${operand}) = length(${operand}) THEN upper(${operand}) ELSE translate(regexp_replace(${operand},` +
        ` '([\\U00010000-\\U0010FFFF])', '\\1' || chr(${SURROGATE_MARK.codePointAt(0) ?? 0}), 'g'), ${foldParams.from}, ${foldParams.to}) END`;
      return `(${folded}) LIKE ${bind(sqlLikePattern(condition.pattern))} ESCAPE ''`;
    }
    if (condition.kind === 'in') {
      let member: string;
      if (condition.type === 'varchar') member = `${text(condition.column)} = ANY(${bind(condition.items.map(untrailed))}::text[])`;
      else if (condition.type === 'numeric') member = `${ref} = ANY(${bind(condition.items.map(Number).filter(Number.isFinite))}::numeric[])`;
      // A timestamp column equals no criteria item, which binds as text.
      else member = 'FALSE';
      return condition.negated ? `(${ref} IS NOT NULL AND NOT (${member}))` : member;
    }
    const op = condition.op === '!=' ? '<>' : condition.op;
    const { value } = condition;
    if (condition.type === 'varchar') return `${text(condition.column)} ${op} ${bind(untrailed(String(value)))}::text`;
    if (condition.type === 'numeric') {
      const number = Number(value);
      return Number.isNaN(number) ? 'FALSE' : `${ref} ${op} ${bind(number)}::numeric`;
    }
    return value instanceof Date ? `${ref} ${op} ${bind(value)}::timestamp` : 'FALSE';
  };
  const groups: string[][] = [];
  query.filters.forEach(({ relationship, condition }, i) => {
    const compiled = atom(condition);
    const last = groups.at(-1);
    if (i === 0 || relationship === 'or' || last === undefined) groups.push([compiled]);
    else last.push(compiled);
  });
  const where = groups.length === 0 ? 'TRUE' : groups.map((group) => `(${group.join(' AND ')})`).join(' OR ');
  const keys = query.order.map(({ column: name, type, desc }) => `${type === 'varchar' ? text(name) : column(name)} ${desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`);
  return { where, orderBy: [...keys, 'g.userid COLLATE "C"'].join(', '), params };
}
