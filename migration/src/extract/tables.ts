/** Partition of the live legacy table list into the logical tables the migration moves and the tables it leaves on legacy. */
import type { LegacyTableRef } from './catalog.js';
import { UnitCatalogError, UnknownLegacyTableError } from '../owners/units.js';
import type { DataOwner, LegacyTableOwner, UnitCatalog } from '../owners/units.js';

/** Form-builder tables generated at run time as `fb_<name>` (core/mura/formBuilder/formBuilderManager.cfc:443,506,689,730,773). */
export const DYNAMIC_TABLE_PATTERN = /^fb_/i;

/** A logical table the migration moves; `physical` holds one live part, or one per `Program_<id>` schema when `folded`. */
export interface MigratableTable {
  /** Ownership-file name of the table. */
  readonly name: string;
  readonly owner: DataOwner | 'split';
  readonly owners: readonly DataOwner[];
  /** Sorted by `programId`, which is set only on folded parts. */
  readonly physical: readonly { readonly ref: LegacyTableRef; readonly programId?: number }[];
  readonly folded: boolean;
  /** Legacy key columns; `[]` means keyless. */
  readonly keyColumns: readonly string[];
}

/**
 * A live table that stays on legacy. `owner` is the recorded owner — `decision-list`, `retired`, or the service of a fixture
 * table the ownership file marks unmigrated — or `unassigned` when no ownership entry matches.
 */
export interface SkippedTable {
  readonly name: string;
  readonly owner: LegacyTableOwner | 'unassigned';
  readonly physical: readonly LegacyTableRef[];
}

/** Both sides of {@link partitionLegacyTables}, each sorted by `name` in code-unit order. */
export interface TablePartition {
  readonly migratable: readonly MigratableTable[];
  readonly skipped: readonly SkippedTable[];
}

interface Part {
  readonly ref: LegacyTableRef;
  readonly programId: number | null;
}

function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Live refs keyed by ownership-file name, `Program_<id>` parts folded onto their generic entry and sorted by program id. */
function groupByLogicalName(catalog: UnitCatalog, liveTables: readonly LegacyTableRef[]): Map<string, Part[]> {
  const groups = new Map<string, Part[]>();
  for (const ref of liveTables) {
    const { legacyTable, programId } = catalog.foldProgramTable(ref.qualified);
    const parts = groups.get(legacyTable);
    if (parts === undefined) groups.set(legacyTable, [{ ref, programId }]);
    else parts.push({ ref, programId });
  }
  for (const parts of groups.values()) parts.sort((a, b) => (a.programId ?? -1) - (b.programId ?? -1));
  return groups;
}

function migratableTable(catalog: UnitCatalog, name: string, parts: readonly Part[]): MigratableTable {
  const owners = catalog.ownersForLegacyTable(name);
  const first = owners[0];
  if (first === undefined) throw new UnitCatalogError(`legacy table ${name} is migratable but has no owner`);
  return Object.freeze({
    name,
    owner: catalog.isSplit(name) ? 'split' : first,
    owners,
    physical: Object.freeze(parts.map(({ ref, programId }) => Object.freeze(programId === null ? { ref } : { ref, programId }))),
    folded: parts.some((part) => part.programId !== null),
    keyColumns: catalog.keyColumnsOf(name),
  });
}

/**
 * Splits `liveTables` (from `listLegacyTables`) into the logical tables to migrate and those left on legacy.
 * @throws UnitCatalogError when a migratable table has no owner; any catalog error other than UnknownLegacyTableError.
 */
export function partitionLegacyTables(catalog: UnitCatalog, liveTables: readonly LegacyTableRef[]): TablePartition {
  const migratable: MigratableTable[] = [];
  const skipped: SkippedTable[] = [];
  for (const [name, parts] of groupByLogicalName(catalog, liveTables)) {
    const physical = Object.freeze(parts.map((part) => part.ref));
    const skip = (owner: SkippedTable['owner']): void => {
      skipped.push(Object.freeze({ name, owner, physical }));
    };
    if (physical.some((ref) => DYNAMIC_TABLE_PATTERN.test(ref.table))) {
      skip('decision-list');
      continue;
    }
    let isMigratable: boolean;
    try {
      isMigratable = catalog.isMigratable(name);
    } catch (error) {
      if (!(error instanceof UnknownLegacyTableError)) throw error;
      skip('unassigned');
      continue;
    }
    if (isMigratable) migratable.push(migratableTable(catalog, name, parts));
    else skip(catalog.legacyTableOwner(name));
  }
  return Object.freeze({ migratable: Object.freeze(migratable.sort(byName)), skipped: Object.freeze(skipped.sort(byName)) });
}

/** The logical tables of `liveTables` the migration moves, sorted by `name`. */
export function migratableTables(catalog: UnitCatalog, liveTables: readonly LegacyTableRef[]): readonly MigratableTable[] {
  return partitionLegacyTables(catalog, liveTables).migratable;
}
