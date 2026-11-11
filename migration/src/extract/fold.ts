/** Folds the fixture `Program_<id>` tables of one logical table into a single stream, and resolves any legacy table to its stream. */
import { encodeKey, encodeRow, LEGACY_PROGRAM_ID_COLUMN, parseProgramTable, programTableName } from '@opt2/platform/migration-kit';
import type { CanonicalColumn } from '@opt2/platform/migration-kit';

import type { MigrationContext } from '../context.js';
import { UnitCatalogError, UnknownLegacyTableError, type UnitCatalog } from '../owners/units.js';
import { findColumn, listLegacyTables, parseQualifiedName, qualifiedName, TableNotFoundError, type LegacyTableRef } from './catalog.js';
import {
  compareCanonicalRows,
  describeStream,
  streamCanonicalRows,
  type CanonicalRow,
  type KeyValue,
  type StreamOptions,
  type StreamShape,
} from './stream.js';
import type { MigratableTable } from './tables.js';

/** One `Program_<id>` table of a folded logical table. */
export interface FoldPart {
  programId: number;
  ref: LegacyTableRef;
}

/** Options of {@link streamFoldedRows}; `table` is the logical name the rows carry as `CanonicalRow.table`. */
export interface FoldedStreamOptions extends Omit<StreamOptions, 'table' | 'label'> {
  table: string;
  parts: readonly FoldPart[];
}

/**
 * Encoded shape of a logical table: `columns` in encoding order and `keyColumns` in key order, both ending with
 * `legacy_program_id` for folded tables (keyColumns only when keyed); `parts` is empty for a plain table.
 */
export interface LegacyTableShape {
  table: string;
  folded: boolean;
  keyed: boolean;
  keyColumns: readonly string[];
  columns: readonly CanonicalColumn[];
  parts: readonly FoldPart[];
}

/** Ports {@link streamLegacyTable} and {@link describeLegacyTable} read through. */
export type LegacyTableDeps = Pick<MigrationContext, 'legacy' | 'catalog'>;

/** A logical name (`Program_N.timesheet`), a physical name (`tcontent`, `Program_1.timesheet`) or a migratable table, with stream options. */
export type LegacyTableOptions = Omit<StreamOptions, 'legacy' | 'table' | 'label'> & { table: string | MigratableTable };

/** The parts of one folded table disagree on column names, order or canonical types, on keyed-ness or key, or there are none. */
export class FoldShapeError extends Error {
  override readonly name = 'FoldShapeError';
  readonly table: string;

  constructor(table: string, message: string) {
    super(`${table}: ${message}`);
    this.table = table;
  }
}

// Owner exports encode folded rows without this column and report it as `legacyProgramId`; comparers re-encode both
// sides over `LegacyTableShape.columns`, so it is appended here as the owner's target columns append it.
const PROGRAM_COLUMN: CanonicalColumn = Object.freeze({ name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' });
const PLAIN_TABLE = /^[^.[\]]+$/;
const LIVE_DATABASE = '(live)';
const NO_PARTS: readonly FoldPart[] = Object.freeze([]);
const NO_KEY: readonly string[] = Object.freeze([]);

interface FoldPlan {
  readonly shape: LegacyTableShape;
  readonly partOptions: readonly StreamOptions[];
  /** Definitions of `shape.keyColumns`, for `encodeKey`. */
  readonly keyDefinitions: readonly CanonicalColumn[];
}

type ResolvedTable = { readonly folded: false; readonly options: StreamOptions } | { readonly folded: true; readonly options: FoldedStreamOptions };

function plainColumn(column: CanonicalColumn): CanonicalColumn {
  return Object.freeze(column.scale === undefined ? { name: column.name, type: column.type } : { name: column.name, type: column.type, scale: column.scale });
}

function sameColumns(a: readonly CanonicalColumn[], b: readonly CanonicalColumn[]): boolean {
  return a.length === b.length && a.every((column, index) => {
    const other = b[index];
    return other !== undefined && other.name === column.name && other.type === column.type && other.scale === column.scale;
  });
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => b[index] === name);
}

/** Requested names without `legacy_program_id`, which the fold supplies itself. */
function withoutProgramColumn(names: readonly string[] | undefined): readonly string[] | undefined {
  return names?.filter((name) => name.toLowerCase() !== LEGACY_PROGRAM_ID_COLUMN);
}

/** Describes every part, checks they share one shape, and derives the folded shape. */
async function planFold(options: FoldedStreamOptions): Promise<FoldPlan> {
  const { parts, table, ...stream } = options;
  if (parts.length === 0) throw new FoldShapeError(table, 'a folded table needs at least one Program_<id> part');
  const sorted = Object.freeze([...parts].sort((a, b) => a.programId - b.programId));
  const base = { ...stream, columns: withoutProgramColumn(stream.columns), keyColumns: withoutProgramColumn(stream.keyColumns) };
  const partOptions = sorted.map((part): StreamOptions => ({ ...base, table: part.ref, label: table }));
  const shapes = await Promise.all(partOptions.map((partOption) => describeStream(partOption)));

  const first = shapes[0] as StreamShape;
  shapes.forEach((shape, index) => {
    const part = (sorted[index] as FoldPart).ref.qualified;
    if (findColumn(shape.catalog, LEGACY_PROGRAM_ID_COLUMN) !== undefined) {
      throw new FoldShapeError(table, `${part} already has a ${LEGACY_PROGRAM_ID_COLUMN} column`);
    }
    if (shape.keyed !== first.keyed || !sameNames(shape.keyColumns, first.keyColumns) || !sameColumns(shape.columns, first.columns)) {
      throw new FoldShapeError(table, `${part} does not have the columns, types and key of ${first.catalog.qualified}`);
    }
  });

  const keyColumns = first.keyed ? Object.freeze([...first.keyColumns, LEGACY_PROGRAM_ID_COLUMN]) : NO_KEY;
  const keyDefinitions = first.keyed
    ? Object.freeze([...first.keyColumns.map((name) => plainColumn(findColumn(first.catalog, name) as CanonicalColumn)), PROGRAM_COLUMN])
    : Object.freeze([]);
  const shape: LegacyTableShape = Object.freeze({
    table,
    folded: true,
    keyed: first.keyed,
    keyColumns,
    columns: Object.freeze([...first.columns.map(plainColumn), PROGRAM_COLUMN]),
    parts: sorted,
  });
  return { shape, partOptions, keyDefinitions };
}

/** One part's rows with `legacy_program_id` added to the row, its encoding and, when keyed, its key. */
async function* foldedPartRows(plan: FoldPlan, index: number): AsyncGenerator<CanonicalRow, void, undefined> {
  const { shape, keyDefinitions } = plan;
  const programId = (shape.parts[index] as FoldPart).programId;
  const programText = String(programId);
  for await (const source of streamCanonicalRows(plan.partOptions[index] as StreamOptions)) {
    const row = { ...source.row, [LEGACY_PROGRAM_ID_COLUMN]: programText };
    const encoding = encodeRow(shape.columns, row);
    if (!shape.keyed) {
      yield { table: shape.table, legacyProgramId: programId, key: encoding, keyValues: source.keyValues, encoding, row };
      continue;
    }
    const keyValues: readonly KeyValue[] = [...source.keyValues, programId];
    yield { table: shape.table, legacyProgramId: programId, key: encodeKey(keyDefinitions, shape.keyColumns, row), keyValues, encoding, row };
  }
}

async function pull(source: AsyncGenerator<CanonicalRow, void, undefined>): Promise<CanonicalRow | undefined> {
  const next = await source.next();
  return next.done === true ? undefined : next.value;
}

/** Returns every part stream; a failure is thrown unless `quiet`, as an earlier error is already propagating. */
async function closeParts(sources: readonly AsyncGenerator<CanonicalRow, void, undefined>[], quiet: boolean): Promise<void> {
  const outcomes = await Promise.allSettled(sources.map((source) => source.return(undefined)));
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (!quiet && failure !== undefined) throw failure.reason;
}

/**
 * Streams the parts of one folded table as one table in `compareCanonicalRows` order, each row with `legacyProgramId`.
 * Breaking early cancels every part's SQL request and removes its spill files.
 * @throws FoldShapeError when the parts do not share one shape.
 */
export async function* streamFoldedRows(options: FoldedStreamOptions): AsyncGenerator<CanonicalRow, void, undefined> {
  const plan = await planFold(options);
  const sources = plan.partOptions.map((_, index) => foldedPartRows(plan, index));
  let thrown = false;
  try {
    const heads: (CanonicalRow | undefined)[] = [];
    for (const source of sources) heads.push(await pull(source));
    // Encodings are prefix-free and each part appends one constant suffix, so merging keyless parts on the folded
    // encodings keeps every part's own order; ties go to the lower program id.
    for (;;) {
      let least = -1;
      heads.forEach((head, index) => {
        if (head !== undefined && (least < 0 || compareCanonicalRows(head, heads[least] as CanonicalRow) < 0)) least = index;
      });
      if (least < 0) return;
      yield heads[least] as CanonicalRow;
      heads[least] = await pull(sources[least] as AsyncGenerator<CanonicalRow, void, undefined>);
    }
  } catch (error) {
    thrown = true;
    throw error;
  } finally {
    await closeParts(sources, thrown);
  }
}

/** Lookup form of a table name: bare for `dbo`, unbracketed, lower case. */
function tableKey(name: string): string {
  const { schema, table } = parseQualifiedName(name);
  return qualifiedName(schema, table).toLowerCase();
}

/** Ownership key of the table, or `[]` (the live primary key) for a table the ownership file does not migrate. */
function ownershipKey(catalog: UnitCatalog, table: string): readonly string[] {
  try {
    return catalog.keyColumnsOf(table);
  } catch (error) {
    if (error instanceof UnknownLegacyTableError || error instanceof UnitCatalogError) return NO_KEY;
    throw error;
  }
}

/** Ownership name of the folded table `name` stands for, or undefined when it names no folded table. */
function foldTargetOf(catalog: UnitCatalog, name: string): string | undefined {
  const { table } = parseQualifiedName(name);
  if (!PLAIN_TABLE.test(table)) return undefined;
  // A program-0 probe folds onto an ownership entry exactly when one is declared for this table name.
  const probe = catalog.foldProgramTable(programTableName(0, table));
  return probe.programId !== null && tableKey(probe.legacyTable) === tableKey(name) ? probe.legacyTable : undefined;
}

function migratablePart(table: MigratableTable, part: MigratableTable['physical'][number]): FoldPart {
  if (part.programId === undefined) throw new FoldShapeError(table.name, `${part.ref.qualified} is not a Program_<id> table`);
  return { programId: part.programId, ref: part.ref };
}

/** The plain or folded stream options a table resolves to; logical folded names discover their parts in the target database. */
async function resolveTable(deps: LegacyTableDeps, options: LegacyTableOptions): Promise<ResolvedTable> {
  const { table, ...rest } = options;
  const stream = { ...rest, legacy: deps.legacy };

  if (typeof table !== 'string') {
    const keyColumns = options.keyColumns ?? table.keyColumns;
    if (table.folded) {
      const parts = table.physical.map((part) => migratablePart(table, part));
      return { folded: true, options: { ...stream, keyColumns, table: table.name, parts } };
    }
    const { ref } = table.physical[0] as MigratableTable['physical'][number];
    return { folded: false, options: { ...stream, keyColumns, table: ref, label: table.name } };
  }

  const keyColumns = options.keyColumns ?? ownershipKey(deps.catalog, table);
  const program = parseProgramTable(table);
  if (program !== null) {
    const { schema, table: name } = parseQualifiedName(table);
    const part: FoldPart = { programId: program.programId, ref: { schema, table: name, qualified: qualifiedName(schema, name) } };
    return { folded: true, options: { ...stream, keyColumns, table: deps.catalog.foldProgramTable(table).legacyTable, parts: [part] } };
  }

  const generic = foldTargetOf(deps.catalog, table);
  if (generic === undefined) return { folded: false, options: { ...stream, keyColumns, table } };
  const pool = await (options.database === undefined ? deps.legacy.live() : deps.legacy.database(options.database));
  const parts = (await listLegacyTables(pool)).flatMap((ref): FoldPart[] => {
    const fold = deps.catalog.foldProgramTable(ref.qualified);
    return fold.programId !== null && fold.legacyTable === generic ? [{ programId: fold.programId, ref }] : [];
  });
  if (parts.length === 0) throw new TableNotFoundError(options.database ?? LIVE_DATABASE, generic);
  return { folded: true, options: { ...stream, keyColumns, table: generic, parts } };
}

/** Shape of the stream {@link streamLegacyTable} yields for the same options, without reading rows. */
export async function describeLegacyTable(deps: LegacyTableDeps, options: LegacyTableOptions): Promise<LegacyTableShape> {
  const resolved = await resolveTable(deps, options);
  if (resolved.folded) return (await planFold(resolved.options)).shape;
  const shape = await describeStream(resolved.options);
  return Object.freeze({
    table: shape.table,
    folded: false,
    keyed: shape.keyed,
    keyColumns: shape.keyColumns,
    columns: Object.freeze(shape.columns.map(plainColumn)),
    parts: NO_PARTS,
  });
}

/**
 * Streams a legacy table as canonical rows: folded tables through {@link streamFoldedRows}, any other through
 * `streamCanonicalRows`. `keyColumns` defaults to the ownership key.
 */
export async function* streamLegacyTable(deps: LegacyTableDeps, options: LegacyTableOptions): AsyncGenerator<CanonicalRow, void, undefined> {
  const resolved = await resolveTable(deps, options);
  if (resolved.folded) yield* streamFoldedRows(resolved.options);
  else yield* streamCanonicalRows(resolved.options);
}
