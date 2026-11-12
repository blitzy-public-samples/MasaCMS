// Stored-row rules of the golden normaliser: canonical row encodings with ids and timestamps normalised, compared as multisets.
import {
  SERIALIZED_DOCUMENT_COLUMNS,
  compareEncodings,
  decodeRow,
  diffMultiset,
  encodeRow,
  multiset,
  tableChecksum,
  type CanonicalColumn,
  type CanonicalValue,
  type MultisetDelta,
} from '@opt2/platform/migration-kit';
import type { RowSnapshot } from '../side-effects.js';
import { normaliseIdsInString, type IdOrdinals, type OrdinalCounter } from './ids.js';
import type { NormaliseRules } from './rules.js';
import { isDateOnlyField, normaliseTimestamp } from './values.js';

/** One unit's normalised rows as distinct encodings with occurrence counts, sorted bytewise. */
export interface NormalisedTable {
  unit: string;
  legacyTable: string;
  /** Columns of the normalised encodings; a masked `t` column is `s`, since its placeholder is not a timestamp. */
  columns: CanonicalColumn[];
  entries: { encoding: string; count: number }[];
  /** `tableChecksum` SHA-256 over every occurrence. */
  checksum: string;
}

/** Normalised rows keyed by unit, in sorted unit order. */
export type NormalisedRows = Record<string, NormalisedTable>;

/** One unit's row differences: occurrences golden holds and replay lacks (`missing`), and the reverse (`extra`). */
export interface RowComparison {
  missing: string[];
  extra: string[];
  checksumEqual: boolean;
}

type CellRule = 'literal' | 'ids' | 'text' | 'timestamp';

interface ColumnPlan {
  readonly name: string;
  readonly output: CanonicalColumn;
  readonly rule: CellRule;
  /** Name the timestamp rules see; undefined when a date-only column is to be masked like any other. */
  readonly key: string | undefined;
}

interface RowContext {
  readonly rules: NormaliseRules;
  readonly ids: boolean;
  readonly timestamps: boolean;
  readonly money: RegExp;
  readonly serialized: ReadonlySet<string>;
}

// Stored rows normalise only ids and timestamps, selected by `rows.apply`; origins, tokens and URLs inside stored
// text stay compared, which is why normaliseText (which masks them too) is not used here. The rows rules declare no
// volatile columns, so no other column is masked.
function rowContext(rules: NormaliseRules): RowContext {
  const apply = new Set<string>(rules.rows.apply);
  return {
    rules,
    ids: apply.has(rules.ids.id) || apply.has(rules.ids.rfc4122.id),
    timestamps: apply.has(rules.timestamps.id),
    money: new RegExp(rules.rows.literal.money),
    serialized: new Set(SERIALIZED_DOCUMENT_COLUMNS.map((name) => name.toLowerCase())),
  };
}

/** Bare lower-cased table name: `dbo.[ttrash]` and `ttrash` name one table, as SQL Server compares names. */
function tableName(legacyTable: string): string {
  return (legacyTable.split('.').at(-1) ?? '').replaceAll(/[[\]]/g, '').toLowerCase();
}

function planColumns(snapshot: RowSnapshot, ctx: RowContext): ColumnPlan[] {
  const table = tableName(snapshot.legacyTable);
  const literalDates = ctx.rules.rows.literal.dateOnlyFields;
  return snapshot.columns.map((column): ColumnPlan => {
    const dateOnly = isDateOnlyField(column.name, ctx.rules);
    let rule: CellRule = 'literal';
    if (column.type === 't' && ctx.timestamps && !(dateOnly && literalDates)) rule = 'timestamp';
    // Serialized documents are compared byte-exact and never parsed; only their ids are masked.
    else if (column.type === 's') rule = ctx.serialized.has(`${table}.${column.name.toLowerCase()}`) ? 'ids' : 'text';
    return {
      name: column.name,
      output: rule === 'timestamp' ? { name: column.name, type: 's' } : { ...column },
      rule,
      key: dateOnly && !literalDates ? undefined : column.name,
    };
  });
}

function normaliseCell(plan: ColumnPlan, value: CanonicalValue, state: IdOrdinals, ctx: RowContext): CanonicalValue {
  if (plan.rule === 'literal' || typeof value !== 'string') return value;
  if (plan.rule === 'timestamp') return normaliseTimestamp(value, ctx.rules, plan.key);
  if (plan.rule === 'text') {
    if (ctx.money.test(value)) return value;
    if (ctx.timestamps) {
      const masked = normaliseTimestamp(value, ctx.rules, plan.key);
      if (masked !== value) return masked;
    }
  }
  return ctx.ids ? normaliseIdsInString(value, state, ctx.rules.ids) : value;
}

type Mask = (s: string) => string;

function normaliseRow(
  plans: readonly ColumnPlan[],
  row: Readonly<Record<string, CanonicalValue>>,
  state: IdOrdinals,
  ctx: RowContext,
  mask?: Mask,
): Record<string, CanonicalValue> {
  // Catalog order, so ordinals follow column position within the row.
  return Object.fromEntries(
    plans.map((plan): [string, CanonicalValue] => {
      const value = normaliseCell(plan, row[plan.name] ?? null, state, ctx);
      return [plan.name, mask !== undefined && plan.rule !== 'literal' && typeof value === 'string' ? mask(value) : value];
    }),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrites placeholders of `template` whose ordinal is `from` or later to the `?` ordinal. */
function unknownOrdinals(template: string, from: number): Mask {
  const slot = new RegExp(template.split('{n}').map(escapeRegExp).join('(\\d+)'), 'g');
  const unknown = template.replaceAll('{n}', '?');
  return (s) => s.replace(slot, (match: string, ordinal: string) => (Number(ordinal) >= from ? unknown : match));
}

function copyCounter(counter: OrdinalCounter): OrdinalCounter {
  return { byId: new Map(counter.byId), next: counter.next };
}

/**
 * Rows ordered by their provisional normalised encoding, in which ids `state` already knows keep their ordinals
 * and ids it does not know read `<id:?>`; a scratch copy of `state` absorbs the provisional assignments.
 */
function provisionalOrder(
  plans: readonly ColumnPlan[],
  output: readonly CanonicalColumn[],
  rows: readonly Record<string, CanonicalValue>[],
  state: IdOrdinals,
  ctx: RowContext,
): Record<string, CanonicalValue>[] {
  const scratch: IdOrdinals = { ...copyCounter(state), rfc4122: copyCounter(state.rfc4122) };
  const cfUuids = unknownOrdinals(ctx.rules.ids.placeholder, state.next);
  const rfc4122 = unknownOrdinals(ctx.rules.ids.rfc4122.placeholder, state.rfc4122.next);
  const mask: Mask = (s) => rfc4122(cfUuids(s));
  return rows
    .map((row) => ({ row, key: encodeRow(output, normaliseRow(plans, row, scratch, ctx, mask)) }))
    .sort((a, b) => compareEncodings(a.key, b.key))
    .map(({ row }) => row);
}

function normaliseTable(snapshot: RowSnapshot, state: IdOrdinals, ctx: RowContext): NormalisedTable {
  const plans = planColumns(snapshot, ctx);
  const output = plans.map((plan) => plan.output);
  const decoded = snapshot.rows.map((encoding) => decodeRow(snapshot.columns, encoding));
  // New ids take ordinals in the order of their rows' id-independent form, never of their random values.
  const encodings = provisionalOrder(plans, output, decoded, state, ctx).map((row) =>
    encodeRow(output, normaliseRow(plans, row, state, ctx)),
  );
  const entries = [...multiset(encodings).values()]
    .map(({ encoding, count }) => ({ encoding, count }))
    .sort((a, b) => compareEncodings(a.encoding, b.encoding));
  return {
    unit: snapshot.unit,
    legacyTable: snapshot.legacyTable,
    columns: output,
    entries,
    // Keyless (sorted-row) form for every table: all compare as multisets, and key-column names may differ in case
    // between the legacy catalog and the target export.
    checksum: tableChecksum(encodings.map((row) => ({ row }))).sha256,
  };
}

/**
 * Normalises each unit's canonical rows, units in sorted order, continuing the scenario's id ordinals in `state`.
 * Every table is a multiset of normalised encodings, so keyless tables and duplicate rows keep their multiplicity.
 */
export function normaliseRows(
  snapshots: Readonly<Record<string, RowSnapshot>>,
  state: IdOrdinals,
  rules: NormaliseRules,
): NormalisedRows {
  const ctx = rowContext(rules);
  return Object.fromEntries(
    Object.entries(snapshots)
      .sort(([a], [b]) => compareEncodings(a, b))
      .map(([unit, snapshot]): [string, NormalisedTable] => [unit, normaliseTable(snapshot, state, ctx)]),
  );
}

function* occurrences(table: NormalisedTable | undefined): Generator<string> {
  for (const { encoding, count } of table?.entries ?? []) {
    for (let i = 0; i < count; i++) yield encoding;
  }
}

function expand(deltas: readonly MultisetDelta[]): string[] {
  return deltas.flatMap((delta) => Array.from({ length: delta.count }, () => delta.encoding));
}

function unitOf(rows: NormalisedRows, unit: string): NormalisedTable | undefined {
  return Object.hasOwn(rows, unit) ? rows[unit] : undefined;
}

/**
 * Per-unit multiset difference of two normalised row sets, one list element per occurrence; a unit on one side only
 * reports all its occurrences as missing or extra and never an equal checksum.
 */
export function compareRows(golden: NormalisedRows, replay: NormalisedRows): Record<string, RowComparison> {
  const units = [...new Set([...Object.keys(golden), ...Object.keys(replay)])].sort(compareEncodings);
  return Object.fromEntries(
    units.map((unit): [string, RowComparison] => {
      const was = unitOf(golden, unit);
      const now = unitOf(replay, unit);
      const { added, removed } = diffMultiset(occurrences(was), occurrences(now));
      return [
        unit,
        {
          missing: expand(removed),
          extra: expand(added),
          checksumEqual: was !== undefined && now !== undefined && was.checksum === now.checksum,
        },
      ];
    }),
  );
}
