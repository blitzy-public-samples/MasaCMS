import { readFileSync } from 'node:fs';
import { parseProgramTable } from '@opt2/platform/migration-kit';
import { z } from '@opt2/platform/service-kit';
import { loadConfig, ownerByName, type MigrationConfig } from '../config.js';

/** A service that owns migrated data; at run time one of config `dataOwners`. */
export type DataOwner = MigrationConfig['dataOwners'][number];

/** Owner the ownership file records for a legacy table. */
export type LegacyTableOwner = DataOwner | 'split' | 'decision-list' | 'retired';

/** A unit of write authority: one target table and the legacy tables that feed it. */
export interface Unit {
  readonly id: string;
  readonly owner: DataOwner;
  readonly schema: string;
  readonly legacyTables: readonly string[];
}

/** The rows and columns of a legacy table that one unit takes. */
export interface LegacyTableTarget {
  readonly unit: string;
  readonly owner: DataOwner;
  /** Row selector as written in the ownership file; null takes every row. */
  readonly rowPredicate: string | null;
  readonly keyColumns: readonly string[];
  /** `'whole-table'`: every live column of the legacy table. */
  readonly ownedColumns: readonly string[] | 'whole-table';
}

/** A legacy table name with a concrete `Program_<id>` schema folded onto its generic entry. */
export interface ProgramFold {
  readonly legacyTable: string;
  readonly programId: number | null;
}

/** Options of {@link loadUnitCatalog}. */
export interface LoadUnitCatalogOptions {
  /** Replaces config `dataOwners`. */
  dataOwners?: readonly string[];
}

/** Units and legacy-table ownership read from `opt2/table-ownership.json`; table lookups fold `Program_<id>` first. */
export interface UnitCatalog {
  /** Every unit, in file order. */
  units(): readonly Unit[];
  /** @throws UnknownUnitError */
  unit(id: string): Unit;
  /** @throws UnknownUnitError */
  ownerOf(unitId: string): DataOwner;
  /** Units of `owner`; empty for an owner without units. */
  unitsOfOwner(owner: string): readonly Unit[];
  /** @throws UnknownUnitError */
  legacyTablesOf(unitId: string): readonly string[];
  /** Generic entry name and program id of `Program_<id>.<table>`; any other name comes back with `programId: null`. */
  foldProgramTable(table: string): ProgramFold;
  /** Owner the ownership file records for the table. @throws UnknownLegacyTableError */
  legacyTableOwner(table: string): LegacyTableOwner;
  /** Targets of the table; empty for a table that does not migrate. @throws UnknownLegacyTableError */
  unitsForLegacyTable(table: string): readonly LegacyTableTarget[];
  /** True when the table has targets, never for decision-list or retired tables. @throws UnknownLegacyTableError */
  isMigratable(table: string): boolean;
  /** @throws UnknownLegacyTableError */
  isSplit(table: string): boolean;
  /** Distinct target owners, in `dataOwners` order. @throws UnknownLegacyTableError */
  ownersForLegacyTable(table: string): readonly DataOwner[];
  /**
   * Legacy key columns of the table; `[]` means keyless, compared as a multiset of whole-row encodings.
   * @throws UnknownLegacyTableError, or UnitCatalogError for a table that does not migrate.
   */
  keyColumnsOf(table: string): readonly string[];
}

/** The ownership file is unreadable, malformed or breaks a catalog invariant, or a key was asked of a table that does not migrate. */
export class UnitCatalogError extends Error {
  override readonly name = 'UnitCatalogError';
}

/** No unit has this id. */
export class UnknownUnitError extends Error {
  override readonly name = 'UnknownUnitError';
  readonly unitId: string;

  constructor(unitId: string) {
    super(`Unknown unit "${unitId}"`);
    this.unitId = unitId;
  }
}

/** No ownership entry or pattern matches this legacy table. */
export class UnknownLegacyTableError extends Error {
  override readonly name = 'UnknownLegacyTableError';
  readonly table: string;

  constructor(table: string) {
    super(`Unknown legacy table "${table}"`);
    this.table = table;
  }
}

const SPLIT = 'split';
const UNMIGRATED_OWNERS: ReadonlySet<string> = new Set(['decision-list', 'retired']);

const name = () => z.string().min(1);
const names = () => z.array(name());

const targetBase = { unit: name(), owner: name(), rowPredicate: z.string().nullable(), keyColumns: names() };

const ownershipSchema = z.object({
  units: z.array(
    z.object({
      unit: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'must be <schema>.<table>'),
      owner: name(),
      legacyTables: names(),
    }),
  ),
  tables: z.array(
    z.object({
      table: name(),
      owner: name(),
      primaryKey: names(),
      migrated: z.boolean().optional(),
      programFold: z.boolean().optional(),
      targets: z.array(
        z.discriminatedUnion('columnPolicy', [
          z.object({ ...targetBase, columnPolicy: z.literal('whole-table') }),
          z.object({ ...targetBase, columnPolicy: z.literal('explicit'), ownedColumns: names().min(1) }),
        ]),
      ),
    }),
  ),
});

type OwnershipFile = z.infer<typeof ownershipSchema>;
type RawTable = OwnershipFile['tables'][number];
type RawTarget = RawTable['targets'][number];

interface Entry {
  readonly table: string;
  readonly owner: string;
  readonly split: boolean;
  readonly keyColumns: readonly string[];
  readonly targets: readonly LegacyTableTarget[];
  readonly owners: readonly DataOwner[];
}

interface LoadContext {
  readonly config: Pick<MigrationConfig, 'owners'>;
  readonly dataOwners: readonly string[];
  /** Config owners outside `dataOwners` (the migration service's own state, for one) hold coordination tables that never migrate. */
  readonly coordinationOwners: ReadonlySet<string>;
  readonly units: ReadonlyMap<string, Unit>;
  readonly issues: string[];
}

const EMPTY_UNITS: readonly Unit[] = Object.freeze([]);

function report(file: string, issues: readonly string[]): string {
  return [`invalid table ownership file ${file}`, ...issues.map((issue) => `  ${issue}`)].join('\n');
}

function readOwnershipFile(file: string): OwnershipFile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UnitCatalogError(report(file, [`cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`]), {
      cause: error,
    });
  }
  const result = ownershipSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new UnitCatalogError(report(file, issues), { cause: result.error });
  }
  return result.data;
}

/** Lookup key of a legacy table: no leading `dbo.`, lower case, as SQL Server's default collation compares names. */
function normalise(table: string): string {
  return table.replace(/^dbo\./i, '').toLowerCase();
}

function globRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

function unqualified(table: string): string {
  return table.slice(table.indexOf('.') + 1);
}

function buildUnits(raw: OwnershipFile['units'], ctx: Omit<LoadContext, 'units' | 'coordinationOwners'>): Map<string, Unit> {
  const units = new Map<string, Unit>();
  for (const { unit: id, owner, legacyTables } of raw) {
    const schema = id.slice(0, id.indexOf('.'));
    if (units.has(id)) ctx.issues.push(`unit ${id}: listed more than once`);
    if (!ctx.dataOwners.includes(owner)) {
      ctx.issues.push(`unit ${id}: owner "${owner}" is not a data owner`);
    } else {
      const expected = ownerByName(ctx.config, owner).schema;
      if (expected !== schema) ctx.issues.push(`unit ${id}: schema "${schema}" is not ${owner}'s schema "${expected}"`);
    }
    units.set(id, Object.freeze({ id, owner: owner as DataOwner, schema, legacyTables: Object.freeze([...legacyTables]) }));
  }
  return units;
}

function buildTarget(raw: RawTable, target: RawTarget, service: boolean, ctx: LoadContext): LegacyTableTarget {
  const where = `table ${raw.table}: target ${target.unit}`;
  const unit = ctx.units.get(target.unit);
  if (unit === undefined) ctx.issues.push(`${where} is not in units[]`);
  else if (unit.owner !== target.owner) ctx.issues.push(`${where} names owner "${target.owner}", the unit's owner is "${unit.owner}"`);
  if (service && target.owner !== raw.owner) ctx.issues.push(`${where} belongs to "${target.owner}", not the table's owner "${raw.owner}"`);
  // The legacy key is the table's primaryKey; a target may key on more columns (people.person adds SiteID to tusers.UserID).
  const keyed = raw.primaryKey.length > 0;
  if (keyed !== target.keyColumns.length > 0 || !raw.primaryKey.every((column) => target.keyColumns.includes(column))) {
    ctx.issues.push(`${where} keyColumns [${target.keyColumns.join(', ')}] do not carry the legacy key [${raw.primaryKey.join(', ')}]`);
  }
  return Object.freeze({
    unit: target.unit,
    owner: target.owner as DataOwner,
    rowPredicate: target.rowPredicate,
    keyColumns: Object.freeze([...target.keyColumns]),
    ownedColumns: target.columnPolicy === 'whole-table' ? 'whole-table' : Object.freeze([...target.ownedColumns]),
  });
}

function buildEntry(raw: RawTable, ctx: LoadContext): Entry {
  const service = ctx.dataOwners.includes(raw.owner);
  const split = raw.owner === SPLIT;
  if (!service && !split && !UNMIGRATED_OWNERS.has(raw.owner) && !ctx.coordinationOwners.has(raw.owner)) {
    ctx.issues.push(`table ${raw.table}: unknown owner "${raw.owner}"`);
  }
  // A service-owned fixture table marked `migrated: false` (lookup and transition tables) takes no targets.
  const wantsTargets = (service || split) && raw.migrated !== false;
  if (wantsTargets !== raw.targets.length > 0) {
    ctx.issues.push(`table ${raw.table}: owner "${raw.owner}" ${wantsTargets ? 'needs at least one target' : 'takes no targets'}`);
  }
  const targets = raw.targets.map((target) => buildTarget(raw, target, service, ctx));
  const owners = ctx.dataOwners.filter((owner) => targets.some((target) => target.owner === owner)) as DataOwner[];
  return Object.freeze({
    table: raw.table,
    owner: raw.owner,
    split,
    keyColumns: Object.freeze([...raw.primaryKey]),
    targets: Object.freeze(targets),
    owners: Object.freeze(owners),
  });
}

/**
 * Reads `tableOwnershipPath` once, validates it and checks its invariants, and indexes its units and legacy tables.
 * @throws UnitCatalogError naming the file and every problem found.
 */
export function loadUnitCatalog(tableOwnershipPath: string, options: LoadUnitCatalogOptions = {}): UnitCatalog {
  const file = readOwnershipFile(tableOwnershipPath);
  const config = loadConfig();
  const dataOwners: readonly string[] = options.dataOwners ?? config.dataOwners;
  const issues: string[] = [];
  const units = buildUnits(file.units, { config, dataOwners, issues });
  const coordinationOwners = new Set(Object.keys(config.owners).filter((owner) => !dataOwners.includes(owner)));
  const ctx: LoadContext = { config, dataOwners, coordinationOwners, units, issues };

  const exact = new Map<string, Entry>();
  const patterns: { regex: RegExp; entry: Entry }[] = [];
  const folds = new Map<string, string>();
  for (const raw of file.tables) {
    const entry = buildEntry(raw, ctx);
    const key = normalise(raw.table);
    if (exact.has(key)) issues.push(`table ${raw.table}: listed more than once`);
    exact.set(key, entry);
    if (raw.table.includes('*')) patterns.push({ regex: globRegExp(key), entry });
    if (raw.programFold === true) folds.set(unqualified(raw.table).toLowerCase(), raw.table);
  }
  if (issues.length > 0) throw new UnitCatalogError(report(tableOwnershipPath, issues));

  const unitList: readonly Unit[] = Object.freeze([...units.values()]);
  const byOwner = new Map<string, readonly Unit[]>(
    dataOwners.map((owner) => [owner, Object.freeze(unitList.filter((unit) => unit.owner === owner))]),
  );

  const unit = (id: string): Unit => {
    const found = units.get(id);
    if (found === undefined) throw new UnknownUnitError(id);
    return found;
  };

  const foldProgramTable = (table: string): ProgramFold => {
    const parsed = parseProgramTable(table);
    const generic = parsed === null ? undefined : folds.get(parsed.table.toLowerCase());
    if (parsed === null || generic === undefined) return Object.freeze({ legacyTable: table, programId: null });
    return Object.freeze({ legacyTable: generic, programId: parsed.programId });
  };

  const resolve = (table: string): Entry => {
    const key = normalise(foldProgramTable(table).legacyTable);
    const entry = exact.get(key) ?? patterns.find((pattern) => pattern.regex.test(key))?.entry;
    if (entry === undefined) throw new UnknownLegacyTableError(table);
    return entry;
  };

  return Object.freeze({
    units: () => unitList,
    unit,
    ownerOf: (unitId: string) => unit(unitId).owner,
    unitsOfOwner: (owner: string) => byOwner.get(owner) ?? EMPTY_UNITS,
    legacyTablesOf: (unitId: string) => unit(unitId).legacyTables,
    foldProgramTable,
    // The load rejects any owner outside data owners, coordination owners, split, decision-list and retired.
    legacyTableOwner: (table: string) => resolve(table).owner as LegacyTableOwner,
    unitsForLegacyTable: (table: string) => resolve(table).targets,
    isMigratable: (table: string) => resolve(table).targets.length > 0,
    isSplit: (table: string) => resolve(table).split,
    ownersForLegacyTable: (table: string) => resolve(table).owners,
    keyColumnsOf: (table: string) => {
      const entry = resolve(table);
      if (entry.targets.length === 0) throw new UnitCatalogError(`legacy table ${table} is not migratable (owner "${entry.owner}")`);
      return entry.keyColumns;
    },
  });
}
