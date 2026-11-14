/** Per-owner routing of legacy rows shared by the backfill and the feed: target hints, predicate acceptance and apply discriminators. */
import type { CanonicalColumn } from '@opt2/platform/migration-kit';

import type { MigrationContext } from '../context.js';
import type { CanonicalRow, LegacyTableShape } from '../extract/index.js';
import type { DataOwner, LegacyTableTarget } from '../owners/index.js';
import { JoinLookups, createUnitRowFilter, type UnitRowFilter } from '../reconcile/index.js';
import type { ApplyChange, OwnerBatcher, TenantResolver } from './batch.js';

/** Context members {@link Acceptance} reads. */
export type AcceptanceContext = Pick<MigrationContext, 'config' | 'legacy' | 'catalog'>;

/** Command named in the errors of a row predicate it cannot read. */
export type PredicateReader = 'feed' | 'backfill';

type Discriminator = NonNullable<ApplyChange['discriminator']>;

/** How the owner tells one target's rows apart: a discriminator sent with each row, or a split column carried with its literal. */
export interface TargetHint {
  readonly discriminator: Discriminator | undefined;
  readonly carried: { readonly column: CanonicalColumn; readonly value: string } | undefined;
  /** The split column of a column predicate, in lower case. */
  readonly predicateColumn: string | undefined;
}

/** One target of a table with the lower-cased columns it writes and its apply hint. */
export interface TargetPlan {
  readonly target: LegacyTableTarget;
  readonly columns: ReadonlySet<string>;
  readonly hint: TargetHint;
}

/** One side of a diff, or the backfill's snapshot: the snapshot database and the resolver of its rows' tenants. */
export interface DiffSide {
  readonly database: string;
  readonly tenants: TenantResolver;
}

/** The table, keying and owner one apply row is added for. */
export interface RowRoute {
  readonly table: string;
  readonly keyed: boolean;
  readonly owner: DataOwner;
}

const CLASS_MAP_PREDICATE = /^\s*classMap\s+owner\s*=\s*(\S+)\s*$/i;
const PREDICATE = /^\s*(owner\s+)?(\w+)\s*(?:=\s*(.+?)|in\s*\((.+)\))\s*$/i;
const LITERAL = /^\s*(?:'((?:[^']|'')*)'|(-?\d+))\s*$/;

const lower = (name: string): string => name.toLowerCase();

/** First literal of a predicate value list: quoted text, or an integer as a number. @throws Error for any other form. */
function firstLiteral(predicate: string, list: string, reader: PredicateReader): Discriminator {
  const literal = LITERAL.exec(list.split(',')[0] ?? '');
  if (literal === null) throw new Error(`row predicate "${predicate}" has a value list the ${reader} cannot read`);
  return literal[1] === undefined ? Number(literal[2]) : literal[1].replaceAll("''", "'");
}

/** Discriminator (class-map owner or joined predicate's first literal) or carried split column of a target, as the window import derives them. */
export function hintOf(target: LegacyTableTarget, columns: readonly CanonicalColumn[], reader: PredicateReader = 'feed'): TargetHint {
  const predicate = target.rowPredicate;
  if (predicate === null) return { discriminator: undefined, carried: undefined, predicateColumn: undefined };
  const classOwner = CLASS_MAP_PREDICATE.exec(predicate)?.[1];
  if (classOwner !== undefined) return { discriminator: classOwner, carried: undefined, predicateColumn: undefined };
  const match = PREDICATE.exec(predicate);
  const attr = match?.[2];
  const list = match?.[3] ?? match?.[4];
  if (match === null || attr === undefined || list === undefined) throw new Error(`row predicate "${predicate}" has a form the ${reader} cannot read`);
  const value = firstLiteral(predicate, list, reader);
  const column = match[1] === undefined ? columns.find((candidate) => lower(candidate.name) === lower(attr)) : undefined;
  if (column === undefined) return { discriminator: value, carried: undefined, predicateColumn: undefined };
  return { discriminator: undefined, carried: { column, value: String(value) }, predicateColumn: lower(column.name) };
}

/** Lower-cased columns one target writes: its owned columns (every shape column for `whole-table`), its key and its split column. */
function targetColumns(target: LegacyTableTarget, shape: Pick<LegacyTableShape, 'columns'>, hint: TargetHint): Set<string> {
  const owned = target.ownedColumns === 'whole-table' ? shape.columns.map((column) => column.name) : target.ownedColumns;
  const columns = new Set([...owned, ...target.keyColumns].map(lower));
  if (hint.predicateColumn !== undefined) columns.add(hint.predicateColumn);
  return columns;
}

/** Plan of `target` over the table's shape. @throws Error for a row predicate `reader` cannot read. */
export function planTarget(target: LegacyTableTarget, shape: Pick<LegacyTableShape, 'columns'>, reader: PredicateReader = 'feed'): TargetPlan {
  const hint = hintOf(target, shape.columns, reader);
  return { target, hint, columns: targetColumns(target, shape, hint) };
}

/** Which rows of a table each predicate target takes in each snapshot database, judged row by row through reconciliation's row selection. */
export class Acceptance {
  readonly #ctx: AcceptanceContext;
  readonly #table: string;
  readonly #lookups: JoinLookups;
  readonly #filters = new Map<string, Promise<UnitRowFilter>>();

  constructor(ctx: AcceptanceContext, table: string) {
    this.#ctx = ctx;
    this.#table = table;
    this.#lookups = new JoinLookups(ctx);
  }

  /** Replaces the previous chunk's join keys with those the predicate `targets` need to judge `rows`. */
  async prepare(targets: readonly LegacyTableTarget[], rows: readonly (readonly [DiffSide, CanonicalRow])[]): Promise<void> {
    this.#lookups.clear();
    const sides = [...new Set(rows.map(([side]) => side))];
    for (const target of targets) {
      if (target.rowPredicate === null) continue;
      for (const side of sides) {
        const filter = await this.#filter(target.unit, side);
        await filter.prepare(rows.flatMap(([rowSide, row]) => (rowSide === side ? [row.row] : [])));
      }
    }
  }

  /** True when `target` takes `row` of the database `side` reads. */
  async accepts(target: LegacyTableTarget, side: DiffSide, row: CanonicalRow): Promise<boolean> {
    if (target.rowPredicate === null) return true;
    return (await this.#filter(target.unit, side)).accepts(row.row);
  }

  /** The plans among `plans` that take `row`. */
  async filter(plans: readonly TargetPlan[], side: DiffSide, row: CanonicalRow): Promise<TargetPlan[]> {
    const taken: TargetPlan[] = [];
    for (const plan of plans) if (await this.accepts(plan.target, side, row)) taken.push(plan);
    return taken;
  }

  #filter(unit: string, side: DiffSide): Promise<UnitRowFilter> {
    const id = JSON.stringify([side.database, unit]);
    let filter = this.#filters.get(id);
    if (filter === undefined) {
      filter = createUnitRowFilter(this.#ctx, { unit, legacyTable: this.#table, database: side.database, lookups: this.#lookups });
      this.#filters.set(id, filter);
    }
    return filter;
  }
}

/** Consecutive runs of at most `size` items of `items`. */
export async function* chunksOf<T>(items: AsyncIterable<T>, size: number): AsyncGenerator<T[], void, undefined> {
  let chunk: T[] = [];
  for await (const item of items) {
    chunk.push(item);
    if (chunk.length >= size) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length > 0) yield chunk;
}

/**
 * Adds `change` to `batcher` once per distinct discriminator the taking targets need, or once without one when none needs any.
 * @throws Error for a keyless row taken under several discriminators, before anything is added.
 */
export async function addTaken(
  batcher: OwnerBatcher,
  route: RowRoute,
  change: Omit<ApplyChange, 'discriminator'>,
  taken: readonly TargetPlan[],
  tenantId: string,
  legacyProgramId: number | undefined,
): Promise<void> {
  const discriminators = [...new Set(taken.flatMap((plan) => (plan.hint.discriminator === undefined ? [] : [plan.hint.discriminator])))];
  // A keyless row sent twice would be inserted or deleted twice by a target that needs no discriminator.
  if (!route.keyed && discriminators.length > 1) {
    throw new Error(`a keyless ${route.table} row is taken by ${route.owner} targets with different discriminators`);
  }
  for (const discriminator of discriminators.length === 0 ? [undefined] : discriminators) {
    await batcher.add(tenantId, { ...change, ...(discriminator === undefined ? {} : { discriminator }) }, legacyProgramId);
  }
}
