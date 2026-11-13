/** Target side of reconciliation: a unit table's rows and the unit's object manifest, read through its owner's export only. */
import {
  LEGACY_PROGRAM_ID_COLUMN,
  decodeRow,
  type CanonicalColumn,
  type CanonicalValue,
  type ExportRow,
  type ExportTable,
  type ObjectManifestEntry,
} from '@opt2/platform/migration-kit';

import type { MigrationContext } from '../context.js';
import { compareCanonicalRows, parseQualifiedName, qualifiedName, type CanonicalRow } from '../extract/index.js';
import type { DataOwner } from '../owners/index.js';
import type { ObjectEntry } from './compare.js';
import { toUnitRow, type UnitTableShape } from './legacy-side.js';

/** Context members the target side reads: the owners' export endpoints. */
export type ReconcileTargetDeps = Pick<MigrationContext, 'owners'>;

/** One unit table's target rows in one tenant, in `compareCanonicalRows` order, with the unit's objects when asked for. */
export interface TargetUnitRows {
  rows: CanonicalRow[];
  /** Null unless `includeObjects` was set. */
  objects: ObjectEntry[] | null;
}

/** Options of {@link readTargetUnitRows}. */
export interface ReadTargetUnitRowsOptions {
  /** Also collect the unit's object manifest, for file units. */
  includeObjects?: boolean;
}

/** The unit and owner whose object manifest {@link readTargetObjects} reads. */
export interface TargetObjectsSource {
  owner: DataOwner;
  unit: string;
}

/** The owner's export lacks comparison columns of a unit table, or encodes some with another canonical type. */
export class TargetShapeError extends Error {
  override readonly name: string = 'TargetShapeError';
  readonly unit: string;
  readonly legacyTable: string;
  readonly missingColumns: string[];
  /** Columns exported with another canonical type or scale, which re-encoding would coerce instead of comparing. */
  readonly mismatchedColumns: string[];

  constructor(
    shape: Pick<UnitTableShape, 'unit' | 'legacyTable'>,
    missingColumns: string[],
    mismatchedColumns: string[] = [],
    message = shapeMessage(shape, missingColumns, mismatchedColumns),
  ) {
    super(message);
    this.unit = shape.unit;
    this.legacyTable = shape.legacyTable;
    this.missingColumns = missingColumns;
    this.mismatchedColumns = mismatchedColumns;
  }
}

function shapeMessage(shape: Pick<UnitTableShape, 'unit' | 'legacyTable'>, missing: readonly string[], mismatched: readonly string[]): string {
  const problems = [
    ...(missing.length > 0 ? [`lacks column(s) ${missing.join(', ')}`] : []),
    ...(mismatched.length > 0 ? [`encodes column(s) ${mismatched.join(', ')} with another canonical type`] : []),
  ];
  return `Owner export of unit ${shape.unit} for legacy table ${shape.legacyTable} ${problems.join(' and ')}`;
}

/** Comparison form of a legacy table name; a folded table compares by its table part, as folded mappings name it unqualified. */
function tableKey(name: string, folded: boolean): string {
  const { schema, table } = parseQualifiedName(name);
  return (folded ? table : qualifiedName(schema, table)).toLowerCase();
}

function sameType(a: CanonicalColumn, b: CanonicalColumn): boolean {
  return a.type === b.type && (a.type !== 'd' || a.scale === b.scale);
}

/**
 * Exported column name of each shape column, matched case-insensitively; null for the program column of a folded
 * table, which rows carry as `legacyProgramId`. @throws TargetShapeError naming every missing or mistyped column.
 */
function columnSources(shape: UnitTableShape, exported: ExportTable): (string | null)[] {
  const byName = new Map(exported.columns.map((column) => [column.name.toLowerCase(), column]));
  const missing: string[] = [];
  const mismatched: string[] = [];
  const sources = shape.columns.map((column): string | null => {
    if (shape.folded && column.name === LEGACY_PROGRAM_ID_COLUMN) return null;
    const source = byName.get(column.name.toLowerCase());
    if (source === undefined) missing.push(column.name);
    else if (!sameType(source, column)) mismatched.push(column.name);
    return source?.name ?? null;
  });
  if (missing.length > 0 || mismatched.length > 0) throw new TargetShapeError(shape, missing, mismatched);
  return sources;
}

/** One exported row re-encoded over exactly the shape's columns, as the legacy side encodes its rows. */
function targetRow(shape: UnitTableShape, columns: readonly CanonicalColumn[], sources: readonly (string | null)[], row: ExportRow): CanonicalRow {
  if (shape.folded && row.legacyProgramId === undefined) throw new TargetShapeError(shape, [LEGACY_PROGRAM_ID_COLUMN]);
  const decoded = decodeRow(columns, row.row);
  const values: Record<string, CanonicalValue> = {};
  shape.columns.forEach((column, index) => {
    const source = sources[index] ?? null;
    values[column.name] = source === null ? String(row.legacyProgramId) : (decoded[source] ?? null);
  });
  return toUnitRow(shape, values, shape.folded ? row.legacyProgramId : undefined);
}

/** A manifest entry in the legacy side's object form; hashes compare as lowercase hex on both sides. */
function objectEntry(entry: ObjectManifestEntry): ObjectEntry {
  return { key: entry.key, size: entry.size, sha256: entry.sha256.toLowerCase() };
}

/**
 * Every row of `shape.legacyTable` that `shape.owner` exports for `shape.unit` in `tenantId`, re-encoded over
 * `shape.columns` (so excluded columns are dropped) and sorted with `compareCanonicalRows`; with `includeObjects`, the
 * unit's object manifest from every export page. Owner failures propagate.
 * @throws TargetShapeError when the export has no table for the legacy table, or lacks or mistypes a comparison column.
 */
export async function readTargetUnitRows(
  deps: ReconcileTargetDeps,
  shape: UnitTableShape,
  tenantId: string,
  options: ReadTargetUnitRowsOptions = {},
): Promise<TargetUnitRows> {
  const includeObjects = options.includeObjects === true;
  const key = tableKey(shape.legacyTable, shape.folded);
  const rows: CanonicalRow[] = [];
  const objects: ObjectEntry[] = [];
  let exportedTable = false;
  // describeUnitTable records the catalog's DataOwner for the unit, widened to string.
  for await (const page of deps.owners.exportPages(shape.owner as DataOwner, { unit: shape.unit, tenantId })) {
    if (includeObjects) objects.push(...(page.objects ?? []).map(objectEntry));
    for (const exported of page.tables) {
      if (tableKey(exported.legacyTable, shape.folded) !== key) continue;
      exportedTable = true;
      const sources = columnSources(shape, exported);
      for (const row of exported.rows) rows.push(targetRow(shape, exported.columns, sources, row));
    }
  }
  if (!exportedTable) {
    const all = shape.columns.map((column) => column.name);
    throw new TargetShapeError(shape, all, [], `Owner export of unit ${shape.unit} has no table for legacy table ${shape.legacyTable}`);
  }
  // Owners export in PostgreSQL key order, which need not equal the legacy side's order.
  rows.sort(compareCanonicalRows);
  return { rows, objects: includeObjects ? objects : null };
}

/** The object manifest `source.owner` exports for `source.unit` in `tenantId`, collected from every export page. */
export async function readTargetObjects(deps: ReconcileTargetDeps, source: TargetObjectsSource, tenantId: string): Promise<ObjectEntry[]> {
  const objects: ObjectEntry[] = [];
  for await (const page of deps.owners.exportPages(source.owner, { unit: source.unit, tenantId })) {
    objects.push(...(page.objects ?? []).map(objectEntry));
  }
  return objects;
}
