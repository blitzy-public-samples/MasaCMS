/** Legacy side of reconciliation: unit-table shapes, tenant resolution, the rows a unit owns, and the file-store objects. */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import {
  LEGACY_PROGRAM_ID_COLUMN,
  decodeRow,
  encodeKey,
  encodeRow,
  parseProgramTable,
  resolveTenant,
  sha256Hex,
  type CanonicalColumn,
  type CanonicalValue,
  type TenantLookups,
  type TenantSource,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';

import { ownerByName, type MigrationConfig } from '../config.js';
import type { MigrationContext } from '../context.js';
import type { RowSource } from '../diff/index.js';
import {
  TableNotFoundError,
  describeLegacyTable,
  findColumn,
  parseQualifiedName,
  qualifiedName,
  readTableCatalog,
  streamLegacyTable,
  type CanonicalRow,
  type TableCatalog,
} from '../extract/index.js';
import {
  FileStoreUnsupportedError,
  SUPPORTED_FILE_STORE,
  objectKey,
  parseStoredName,
  planObjects,
  readSnapshotFileOwners,
  readSnapshotSites,
} from '../files/index.js';
import { UnsupportedFileStoreError } from '../legacy/index.js';
import { PROGRAM_SITE_TABLE } from '../order/index.js';
import type { LegacyTableTarget, UnitCatalog } from '../owners/index.js';
import { DIFFERENCE_LIMIT, type ObjectEntry } from './compare.js';
import { UnitRowSorter, type UnitRowSorterOptions } from './sorted-rows.js';

/** Context members the legacy side reads: SQL Server through `legacy`, the file store through `bridge`, snapshot rows through `db`. */
export type ReconcileLegacyDeps = Pick<MigrationContext, 'legacy' | 'catalog' | 'config' | 'db' | 'bridge'>;

/** What one unit compares of one legacy table; both sides encode over exactly `columns`, keyed on `keyColumns` when `keyed`. */
export interface UnitTableShape {
  unit: string;
  owner: string;
  legacyTable: string;
  keyed: boolean;
  /** Key order, ending with `legacy_program_id` for keyed folded tables; empty when keyless. */
  keyColumns: string[];
  /** Catalog order, ending with `legacy_program_id` for folded tables. */
  columns: CanonicalColumn[];
  /** Non-key IDENTITY columns left out, since rows the target creates get SQL Server-generated values on projection. */
  excludedColumns: string[];
  folded: boolean;
}

/** Tenant of a legacy row as the backfill, the feed and reconciliation assign it. */
export interface TenantResolver {
  resolve(table: string, row: Readonly<Record<string, unknown>>): { tenantId: string; orphan: boolean };
  /** Tenants of every site of the database plus the umbrella tenant, sorted. */
  siteTenants(): string[];
}

/** Rows of one tenant placed there as orphans: the first `DIFFERENCE_LIMIT` keys in extraction order and the total. */
export interface LegacyOrphans {
  /** Encoded keys; keyless rows by the SHA-256 of their encoding. */
  keys: string[];
  count: number;
}

/** A unit table's legacy rows grouped by tenant, held in bounded memory until read. */
export interface LegacyUnitRows {
  /** Tenants holding rows, sorted. */
  tenants: string[];
  /** Rows per tenant. */
  counts: ReadonlyMap<string, number>;
  /** Rows of `tenantId` in `compareCanonicalRows` order; tenants are read once each, in ascending order, and one without rows yields none. */
  rows(tenantId: string): RowSource<CanonicalRow>;
  orphans: ReadonlyMap<string, LegacyOrphans>;
  /** Removes any spill files, read or not. */
  dispose(): Promise<void>;
}

/** Legacy file-store objects per tenant, or why the file units cannot be compared. */
export type LegacyObjects =
  | { status: 'compared'; byTenant: Map<string, ObjectEntry[]> }
  | { status: 'halted'; store: string; reason: string };

/** Options of {@link readLegacyObjects}: a snapshot's recorded manifest, or the live store listed through the bridge. */
export interface LegacyObjectsOptions {
  legacySource: 'snapshot' | 'live';
  /** Required for `snapshot`. */
  snapshotSeq?: number | null;
  /** Database whose `tsettings` and `tfiles` own the objects. */
  database: string;
}

type Values = Readonly<Record<string, CanonicalValue>>;

/** One column of a legacy table indexed by others: comparison form of the index columns to the distinct comparison-form values carried. */
type ValueIndex = ReadonlyMap<string, readonly string[]>;

/** Value indexes built during one run, by table, index columns and carried column. */
type IndexMemo = Map<string, Promise<ValueIndex>>;

/** Site a parent join value resolves to: its rows' single tenant and that tenant's site, or null when they span tenants. */
type ParentSite = { tenantId: string; siteId: string } | null;

/** Which rows of a split legacy table belong to one unit; `columns` are the row columns it reads. */
interface RowSelector {
  readonly columns: readonly string[];
  accepts(row: Values): boolean;
}

/** One `objectClass` entry of the ownership file's class map; `owners` keys are in comparison form. */
interface ClassRule {
  readonly classes: readonly string[];
  readonly owner: string | undefined;
  readonly ownerBy: string | undefined;
  readonly owners: Readonly<Record<string, string>>;
}

// The unit catalog keeps units, targets and keys only, so tenant rules and split joins are read from the ownership file.
/** Ownership-file facts of one legacy table that tenant resolution and row predicates need. */
interface TableFacts {
  readonly name: string;
  readonly tenantResolution: string | undefined;
  readonly siteIdColumn: string | undefined;
  readonly tenantParentJoin: string | undefined;
  readonly splitBy: string | undefined;
  readonly parentJoin: string | undefined;
  readonly addressJoin: string | undefined;
  readonly resolve: string | undefined;
  readonly classMap: readonly ClassRule[];
}

/** One hop of a join chain: `fromColumn` of the table the hop starts at equals `toColumn` of `toTable`. */
interface Hop {
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
}

const PREDICATE = /^\s*(owner\s+)?(\w+)\s*(?:=\s*(.+?)|in\s*\((.+)\))\s*$/i;
const CLASS_MAP_PREDICATE = /^\s*classMap\s+owner\s*=\s*(\S+)\s*$/i;
const LITERAL = /^\s*(?:'((?:[^']|'')*)'|(-?\d+))\s*$/;
const CHAIN_SEPARATOR = /,\s*then\s+/i;
const INDEX_SEPARATOR = '\u0000';
const ALL_ROWS: RowSelector = { columns: [], accepts: () => true };

const PROGRAM_SITE_COLUMNS = ['program_id', 'siteID'] as const;
/** Masa user, trash and class-extension tables and columns the class map reads [core/setup/db/mssql.sql:467-505,569-582]. */
const USERS = { table: 'tusers', id: 'UserID', type: 'Type' } as const;
const TRASH = { table: 'ttrash', id: 'objectID', parent: 'parentID', site: 'siteID', type: 'objectType', subType: 'objectSubType' } as const;
const SUBTYPES = { table: 'tclassextend', site: 'siteID', type: 'type', subType: 'subType', baseTable: 'baseTable' } as const;
/** Class-map `ownerBy` rules whose deciding value the legacy rows hold. */
const STORED_TYPE = 'stored Type';
const OWNING_USER_TYPE = "owning user's Type";
const BASE_TABLE = 'baseTable';

const TFILES_TENANT_SOURCE: TenantSource = { kind: 'site', column: 'siteID' };
const FILE_STORE_OWNER = 'strategies-content';
const FILE_OBJECT_TABLE = 'file_object';
const SNAPSHOT_MANIFEST_SQL = 'SELECT state, manifest_complete FROM migration.snapshot WHERE seq = $1';
const UNKNOWN_STORE = 'unknown';

const factsByFile = new Map<string, ReadonlyMap<string, TableFacts>>();
const runIndexes = new WeakMap<TenantResolver, IndexMemo>();

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const textsOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((item) => textOf(item) ?? []) : []);

/** Comparison form of a legacy value: SQL Server's default collation ignores case and trailing spaces. */
function norm(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = Buffer.isBuffer(value) ? value.toString('hex') : String(value);
  return text.replace(/ +$/, '').toLowerCase();
}

/** Lookup form of a table name: brackets and `dbo.` dropped, lower case. */
function tableKey(name: string): string {
  const { schema, table } = parseQualifiedName(name);
  return qualifiedName(schema, table).toLowerCase();
}

/** Value of column `name`, matched case-insensitively as SQL Server resolves names; undefined when absent. */
function valueOf(row: Readonly<Record<string, unknown>>, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name];
  const lower = name.toLowerCase();
  const found = Object.keys(row).find((key) => key.toLowerCase() === lower);
  return found === undefined ? undefined : row[found];
}

/** Index key of a value tuple; undefined when a value is null, which joins nothing. */
function indexKey(values: readonly unknown[]): string | undefined {
  const parts: string[] = [];
  for (const value of values) {
    const part = norm(value);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return parts.join(INDEX_SEPARATOR);
}

function push<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [item]);
  else list.push(item);
}

function classRuleOf(raw: unknown): ClassRule {
  const rule = recordOf(raw);
  const owners: Record<string, string> = {};
  for (const [value, owner] of Object.entries(recordOf(rule.owners))) {
    const name = textOf(owner);
    if (name !== undefined) owners[norm(value) ?? value] = name;
  }
  return { classes: textsOf(rule.classes), owner: textOf(rule.owner), ownerBy: textOf(rule.ownerBy), owners };
}

/** Facts of every table of the ownership file `file`, by lookup key; the file is read once per path. */
function ownershipFacts(file: string): ReadonlyMap<string, TableFacts> {
  const cached = factsByFile.get(file);
  if (cached !== undefined) return cached;
  const tables = recordOf(JSON.parse(readFileSync(file, 'utf8'))).tables;
  const facts = new Map<string, TableFacts>();
  for (const raw of Array.isArray(tables) ? tables : []) {
    const entry = recordOf(raw);
    const name = textOf(entry.table);
    if (name === undefined) continue;
    const split = recordOf(entry.split);
    facts.set(tableKey(name), {
      name,
      tenantResolution: textOf(entry.tenantResolution),
      siteIdColumn: textOf(entry.siteIdColumn),
      tenantParentJoin: textOf(recordOf(entry.tenantParent).join),
      splitBy: textOf(split.by),
      parentJoin: textOf(recordOf(split.parent).join),
      addressJoin: textOf(split.addressJoin),
      resolve: textOf(split.resolve),
      classMap: Array.isArray(split.classMap) ? split.classMap.map(classRuleOf) : [],
    });
  }
  factsByFile.set(file, facts);
  return facts;
}

/** Ownership facts of `table`, `Program_<id>` names folded onto their generic entry. */
function factsFor(deps: Pick<ReconcileLegacyDeps, 'config' | 'catalog'>, table: string): TableFacts {
  const facts = ownershipFacts(deps.config.paths.tableOwnership).get(tableKey(deps.catalog.foldProgramTable(table).legacyTable));
  if (facts === undefined) throw new Error(`the ownership file records no legacy table ${table}`);
  return facts;
}

/** Sides of a `<table>.<column> = <table>.<column>` join, each split at its last dot. */
function joinSides(join: string): { table: string; column: string }[] {
  const sides = join.split('=').map((side) => {
    const trimmed = side.trim();
    const dot = trimmed.lastIndexOf('.');
    return { table: trimmed.slice(0, Math.max(dot, 0)), column: trimmed.slice(dot + 1) };
  });
  if (sides.length !== 2 || sides.some((side) => side.table === '' || side.column === '')) throw new Error(`malformed ownership join "${join}"`);
  return sides;
}

/** Hops of an ownership join chain (`<join>, then <join>`) starting at `table`, each oriented from the table the previous hop reached. */
function chainHops(table: string, chain: string): Hop[] {
  let current = tableKey(table);
  return chain.split(CHAIN_SEPARATOR).map((join) => {
    const sides = joinSides(join);
    const fromIndex = sides.findIndex((side) => tableKey(side.table) === current);
    const from = sides[fromIndex];
    const to = sides[1 - fromIndex];
    if (from === undefined || to === undefined) throw new Error(`ownership join "${join}" does not start at ${current}`);
    current = tableKey(to.table);
    return { fromColumn: from.column, toTable: to.table, toColumn: to.column };
  });
}

/** Distinct comparison-form values of `carried` in `table` of `database`, indexed by `indexColumns`; streamed once per run. */
function valueIndex(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'catalog'>,
  memo: IndexMemo,
  spec: { database: string; table: string; indexColumns: readonly string[]; carried: string },
): Promise<ValueIndex> {
  const key = JSON.stringify([spec.database, tableKey(spec.table), spec.indexColumns.map((name) => name.toLowerCase()), spec.carried.toLowerCase()]);
  const known = memo.get(key);
  if (known !== undefined) return known;
  const building = (async (): Promise<ValueIndex> => {
    const index = new Map<string, string[]>();
    const columns = [...new Set([...spec.indexColumns, spec.carried])];
    for await (const source of streamLegacyTable(deps, { table: spec.table, database: spec.database, columns })) {
      const at = indexKey(spec.indexColumns.map((name) => valueOf(source.row, name)));
      const value = norm(valueOf(source.row, spec.carried));
      if (at === undefined || value === undefined) continue;
      const values = index.get(at);
      if (values === undefined) index.set(at, [value]);
      else if (!values.includes(value)) values.push(value);
    }
    return index;
  })();
  memo.set(key, building);
  return building;
}

/** Index memo of the run `tenants` belongs to; a resolver not built here gets its own. */
function indexesOf(tenants: TenantResolver): IndexMemo {
  let memo = runIndexes.get(tenants);
  if (memo === undefined) {
    memo = new Map();
    runIndexes.set(tenants, memo);
  }
  return memo;
}

// Tenant rules follow the ownership file's tenantResolution and tenantParent, as the owners' mappings and the window import
// do; the dependency order's inferred parents differ for several tables (tusersmemb, tuserstrikes, feed and comment children).
/** Tenant source of a table under its ownership-file rule. */
function tenantSourceOf(facts: TableFacts): TenantSource {
  const rule = facts.tenantResolution;
  if (rule === 'siteID' || rule === 'siteID-or-umbrella') {
    if (facts.siteIdColumn === undefined) throw new Error(`legacy table ${facts.name} records no site column`);
    return { kind: 'site', column: facts.siteIdColumn };
  }
  if (rule === 'program_site') return { kind: 'program' };
  if (rule?.startsWith('parent:') === true && facts.tenantParentJoin !== undefined) {
    const hops = chainHops(facts.name, facts.tenantParentJoin);
    const hop = hops[0];
    if (hop === undefined || hops.length !== 1) throw new Error(`tenant parent join of ${facts.name} must be one join`);
    return { kind: 'parent', parentLegacyTable: hop.toTable, columns: { [hop.fromColumn]: hop.toColumn } };
  }
  throw new Error(`legacy table ${facts.name} has tenant rule "${rule ?? 'none'}", which reconciliation cannot apply`);
}

/** Row columns a tenant source reads. */
function tenantColumnsOf(source: TenantSource): string[] {
  if (source.kind === 'site') return [source.column];
  return source.kind === 'parent' ? Object.keys(source.columns) : [];
}

/** Program id of a folded row: its `legacy_program_id` value, else the `Program_<id>` schema of `table`. */
function programIdOf(table: string, row: Readonly<Record<string, unknown>>): number | undefined {
  const value = valueOf(row, LEGACY_PROGRAM_ID_COLUMN);
  if (typeof value === 'string' || typeof value === 'number') return Number(value);
  return parseProgramTable(table)?.programId;
}

/** `synthetic.program_site` of `database` as program id to site id; empty when the fixtures are not loaded. */
async function readProgramSites(deps: Pick<ReconcileLegacyDeps, 'legacy' | 'catalog'>, database: string): Promise<ReadonlyMap<number, string>> {
  const sites = new Map<number, string>();
  const [idColumn, siteColumn] = PROGRAM_SITE_COLUMNS;
  try {
    for await (const source of streamLegacyTable(deps, { table: PROGRAM_SITE_TABLE, database, columns: PROGRAM_SITE_COLUMNS })) {
      const id = valueOf(source.row, idColumn);
      const site = valueOf(source.row, siteColumn);
      if (typeof id === 'string' && typeof site === 'string') sites.set(Number(id), site);
    }
  } catch (error) {
    if (!(error instanceof TableNotFoundError)) throw error;
  }
  return sites;
}

/**
 * Tenant resolver over `database` by each table's ownership rule (site column, parent row, `Program_<id>` site) through
 * `resolveTenant`; unresolvable rows and children of parents in several tenants go to the umbrella as orphans.
 */
export async function createTenantResolver(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'catalog' | 'config'>,
  options: { database: string },
): Promise<TenantResolver> {
  const { database } = options;
  const memo: IndexMemo = new Map();
  const sites = await readSnapshotSites(deps, database);
  const programSites = await readProgramSites(deps, database);
  const parentSites = new Map<string, ReadonlyMap<string, ParentSite>>();
  const sources = new Map<string, TenantSource>();
  const parentKey = (table: string, column: string): string => `${tableKey(table)}${INDEX_SEPARATOR}${column.toLowerCase()}`;

  const sourceFor = (table: string): TenantSource => {
    const key = tableKey(table);
    let source = sources.get(key);
    if (source === undefined) {
      source = tenantSourceOf(factsFor(deps, table));
      sources.set(key, source);
    }
    return source;
  };

  const lookups: TenantLookups = {
    umbrellaSiteId: deps.config.umbrellaSiteId,
    programSiteId: (programId) => programSites.get(programId),
    parentSiteId: (parentTable, key) => {
      const [column, value] = Object.entries(key)[0] ?? [];
      const sitesByValue = column === undefined ? undefined : parentSites.get(parentKey(parentTable, column));
      if (sitesByValue === undefined) throw new Error(`no parent lookup of ${parentTable} by ${String(column)} was prepared`);
      return sitesByValue.get(norm(value) ?? '')?.siteId ?? null;
    },
  };

  const resolveRow = (table: string, row: Readonly<Record<string, unknown>>) => {
    const source = sourceFor(table);
    return resolveTenant(source, row, lookups, { legacyProgramId: source.kind === 'program' ? programIdOf(table, row) : undefined });
  };

  /** Folds parent join values into their resolved site, retaining null for conflicting tenants and no parent rows. */
  const prepareParent = async (table: string, column: string, trail: readonly string[]): Promise<void> => {
    const key = parentKey(table, column);
    if (parentSites.has(key)) return;
    if (trail.includes(key)) throw new Error(`tenant parent joins form a cycle through ${table}.${column}`);
    const source = sourceFor(table);
    if (source.kind === 'parent') {
      for (const [, parentColumn] of Object.entries(source.columns)) await prepareParent(source.parentLegacyTable, parentColumn, [...trail, key]);
    }
    const sitesByValue = new Map<string, ParentSite>();
    const columns = [...new Set([column, ...tenantColumnsOf(source)])];
    try {
      for await (const { row } of streamLegacyTable(deps, { table, database, columns })) {
        const value = indexKey([valueOf(row, column)]);
        if (value === undefined) continue;
        const resolved = resolveRow(table, row);
        if (resolved.orphan) continue;
        const known = sitesByValue.get(value);
        if (known === undefined) sitesByValue.set(value, { tenantId: resolved.tenantId, siteId: resolved.siteId });
        else if (known !== null && known.tenantId === resolved.tenantId) known.siteId = resolved.siteId;
        else sitesByValue.set(value, null);
      }
    } catch (error) {
      if (!(error instanceof TableNotFoundError)) throw error;
    }
    parentSites.set(key, sitesByValue);
  };

  for (const facts of ownershipFacts(deps.config.paths.tableOwnership).values()) {
    if (facts.tenantResolution?.startsWith('parent:') !== true) continue;
    const source = tenantSourceOf(facts);
    if (source.kind !== 'parent') continue;
    for (const [, column] of Object.entries(source.columns)) await prepareParent(source.parentLegacyTable, column, []);
  }

  const tenantIds = [...new Set([...sites.map(tenantIdForSite), tenantIdForSite(deps.config.umbrellaSiteId)])].sort();
  const resolver: TenantResolver = {
    resolve(table, row) {
      const { tenantId, orphan } = resolveRow(table, row);
      return { tenantId, orphan };
    },
    siteTenants: () => [...tenantIds],
  };
  runIndexes.set(resolver, memo);
  return resolver;
}

/** The target of `unit` among the targets of `legacyTable`. */
function unitTarget(catalog: Pick<UnitCatalog, 'unitsForLegacyTable'>, unit: string, legacyTable: string): LegacyTableTarget {
  const target = catalog.unitsForLegacyTable(legacyTable).find((candidate) => candidate.unit === unit);
  if (target === undefined) throw new Error(`unit ${unit} takes no rows of legacy table ${legacyTable}`);
  return target;
}

/**
 * Canonical row of `values` over the shape's columns. Key values stay canonical text, so legacy and target rows built
 * here order alike under `compareCanonicalRows`; keyless rows are keyed by their encoding.
 */
export function toUnitRow(
  shape: Pick<UnitTableShape, 'legacyTable' | 'keyed' | 'keyColumns' | 'columns'>,
  values: Readonly<Record<string, CanonicalValue>>,
  legacyProgramId?: number,
): CanonicalRow {
  const encoding = encodeRow(shape.columns, values);
  return {
    table: shape.legacyTable,
    ...(legacyProgramId === undefined ? {} : { legacyProgramId }),
    key: shape.keyed ? encodeKey(shape.columns, shape.keyColumns, values) : encoding,
    keyValues: shape.keyed ? shape.keyColumns.map((name) => values[name] ?? null) : [],
    encoding,
    row: values,
  };
}

/**
 * Comparison shape of `unit`'s share of `legacyTable` in `database`: the owned columns in catalog order plus the key,
 * keyed when the live table has a primary key or the unit names key columns, without non-key IDENTITY columns.
 */
export async function describeUnitTable(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'catalog'>,
  options: { unit: string; legacyTable: string; database: string },
): Promise<UnitTableShape> {
  const { unit, legacyTable, database } = options;
  const target = unitTarget(deps.catalog, unit, legacyTable);
  const described = await describeLegacyTable(deps, {
    table: legacyTable,
    database,
    ...(target.keyColumns.length > 0 ? { keyColumns: target.keyColumns } : {}),
  });
  const part = described.parts[0];
  const catalog: TableCatalog = await readTableCatalog(await deps.legacy.database(database), part === undefined ? legacyTable : part.ref);
  const spelled = (name: string, role: string): string => {
    const column = findColumn(catalog, name);
    if (column === undefined) throw new Error(`${role} column ${name} of unit ${unit} is not a column of ${legacyTable} in database ${database}`);
    return column.name;
  };

  const keyed = catalog.hasPrimaryKey || target.keyColumns.length > 0;
  const baseKey = target.keyColumns.length > 0 ? target.keyColumns.map((name) => spelled(name, 'key')) : [...catalog.primaryKey];
  const keyColumns = !keyed ? [] : described.folded ? [...baseKey, LEGACY_PROGRAM_ID_COLUMN] : baseKey;
  const keySet = new Set(keyColumns);
  const owned = target.ownedColumns === 'whole-table' ? undefined : new Set(target.ownedColumns.map((name) => spelled(name, 'owned')));
  const identity = new Set(catalog.identityColumns);

  const columns: CanonicalColumn[] = [];
  const excludedColumns: string[] = [];
  for (const column of described.columns) {
    const programColumn = described.folded && column.name === LEGACY_PROGRAM_ID_COLUMN;
    if (!programColumn && !keySet.has(column.name) && owned !== undefined && !owned.has(column.name)) continue;
    if (!programColumn && !keySet.has(column.name) && identity.has(column.name)) excludedColumns.push(column.name);
    else columns.push(column);
  }
  return { unit, owner: target.owner, legacyTable, keyed, keyColumns, columns, excludedColumns, folded: described.folded };
}

/** Literals of a predicate value list: quoted text or integers, in comparison form; undefined for anything else. */
function literalsOf(list: string): string[] | undefined {
  const literals: string[] = [];
  for (const part of list.split(',')) {
    const literal = LITERAL.exec(part);
    if (literal === null) return undefined;
    literals.push(norm(literal[1] === undefined ? literal[2] : literal[1].replaceAll("''", "'")) ?? '');
  }
  return literals;
}

/** Values of `attr` that the join chain `hops` reaches from a row, in comparison form. */
async function chainValues(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'catalog'>,
  memo: IndexMemo,
  database: string,
  hops: readonly Hop[],
  attr: string,
): Promise<(row: Values) => string[]> {
  const steps: ValueIndex[] = [];
  for (const [position, hop] of hops.entries()) {
    const carried = hops[position + 1]?.fromColumn ?? attr;
    steps.push(await valueIndex(deps, memo, { database, table: hop.toTable, indexColumns: [hop.toColumn], carried }));
  }
  const start = hops[0]?.fromColumn;
  if (start === undefined) throw new Error('an ownership join chain needs at least one join');
  return (row) => {
    let values = [norm(valueOf(row, start))].flatMap((value) => value ?? []);
    for (const index of steps) {
      const next = new Set<string>();
      for (const value of values) for (const found of index.get(value) ?? []) next.add(found);
      next.delete('');
      values = [...next];
    }
    return values;
  };
}

/** The single value `values` hold once coded, or undefined when they hold none or several. */
function singleValue(values: readonly string[] | undefined, code: (value: string) => string | undefined = (value) => value): string | undefined {
  const coded = new Set((values ?? []).flatMap((value) => code(value) ?? []));
  return coded.size === 1 ? [...coded][0] : undefined;
}

/** User type code of a stored value: trashManager stores Type 1 as `Group` and 2 as `User` [core/mura/trash/trashManager.cfc:232-242]. */
function typeCode(value: unknown): string | undefined {
  const text = norm(value);
  return text === 'group' ? '1' : text === 'user' ? '2' : text;
}

/** Selector of `classMap owner = <owner>`; a row whose class or deciding value is unmapped belongs to no unit. */
async function classMapSelector(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'catalog'>,
  memo: IndexMemo,
  database: string,
  facts: TableFacts,
  owner: string,
): Promise<RowSelector> {
  const classColumn = facts.splitBy;
  if (classColumn === undefined || facts.classMap.length === 0) throw new Error(`legacy table ${facts.name} declares no class map`);
  const rules = facts.classMap.filter((rule) => rule.owner === owner || (rule.owner === undefined && Object.values(rule.owners).includes(owner)));
  const ruleBy = new Set(rules.flatMap((rule) => (rule.owner === undefined ? [rule.ownerBy ?? ''] : [])));
  for (const by of ruleBy) {
    if (by !== STORED_TYPE && by !== OWNING_USER_TYPE && by !== BASE_TABLE) throw new Error(`class map rule "${by}" of ${facts.name} cannot be evaluated`);
  }
  const index = (table: string, indexColumns: string[], carried: string): Promise<ValueIndex> =>
    valueIndex(deps, memo, { database, table, indexColumns, carried });
  const users = ruleBy.has(OWNING_USER_TYPE) ? await index(USERS.table, [USERS.id], USERS.type) : undefined;
  const trashedUsers = ruleBy.has(OWNING_USER_TYPE) ? await index(TRASH.table, [TRASH.id], TRASH.type) : undefined;
  const subtypes = ruleBy.has(BASE_TABLE) ? await index(SUBTYPES.table, [SUBTYPES.site, SUBTYPES.type, SUBTYPES.subType], SUBTYPES.baseTable) : undefined;

  const decidingValue = (rule: ClassRule, row: Values): string | undefined => {
    if (rule.ownerBy === STORED_TYPE) return typeCode(valueOf(row, TRASH.type));
    if (rule.ownerBy === OWNING_USER_TYPE) {
      const at = indexKey([valueOf(row, TRASH.parent)]) ?? '';
      return singleValue(users?.get(at)) ?? singleValue(trashedUsers?.get(at), typeCode);
    }
    const at = indexKey([valueOf(row, TRASH.site), valueOf(row, TRASH.type), valueOf(row, TRASH.subType)]) ?? '';
    return singleValue(subtypes?.get(at));
  };
  const columns = [classColumn, ...(ruleBy.size > 0 ? [TRASH.type, TRASH.subType, TRASH.parent, TRASH.site] : [])];
  return {
    columns,
    accepts(row) {
      const objectClass = norm(valueOf(row, classColumn));
      const rule = rules.find((candidate) => candidate.classes.some((name) => norm(name) === objectClass));
      if (rule === undefined) return false;
      if (rule.owner !== undefined) return true;
      const value = decidingValue(rule, row);
      return value !== undefined && rule.owners[value] === owner;
    },
  };
}

/**
 * Selector of a unit's row predicate: a class map, a row column, or a value the ownership joins reach (none reached: not the unit's).
 * @throws Error for a predicate form it cannot evaluate.
 */
async function rowSelectorFor(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'catalog' | 'config'>,
  memo: IndexMemo,
  database: string,
  shape: UnitTableShape,
  predicate: string | null,
): Promise<RowSelector> {
  if (predicate === null) return ALL_ROWS;
  const facts = factsFor(deps, shape.legacyTable);
  const classOwner = CLASS_MAP_PREDICATE.exec(predicate)?.[1];
  if (classOwner !== undefined) return classMapSelector(deps, memo, database, facts, classOwner);
  const match = PREDICATE.exec(predicate);
  const attr = match?.[2];
  const literals = literalsOf(match?.[3] ?? match?.[4] ?? '');
  if (match === null || attr === undefined || literals === undefined) {
    throw new Error(`row predicate "${predicate}" of ${shape.legacyTable} has a form reconciliation cannot evaluate`);
  }
  const accepted = new Set(literals);
  const viaOwner = match[1] !== undefined;
  if (!viaOwner) {
    const column = findColumn(await readTableCatalog(await deps.legacy.database(database), shape.legacyTable), attr);
    if (column !== undefined) return { columns: [column.name], accepts: (row) => accepted.has(norm(valueOf(row, column.name)) ?? '') };
  }
  const chains = (viaOwner ? [facts.parentJoin, facts.addressJoin] : [facts.resolve]).flatMap((chain) =>
    chain === undefined ? [] : [chainHops(shape.legacyTable, chain)],
  );
  if (chains.length === 0) throw new Error(`row predicate "${predicate}" of ${shape.legacyTable} names no ownership join to evaluate it`);
  const reached: ((row: Values) => string[])[] = [];
  for (const hops of chains) reached.push(await chainValues(deps, memo, database, hops, attr));
  return {
    columns: [...new Set(chains.flatMap((hops) => hops[0]?.fromColumn ?? []))],
    accepts: (row) => reached.some((values) => values(row).some((value) => accepted.has(value))),
  };
}

/** Sorter of `shape`'s unit rows that rebuilds each spilled row with {@link toUnitRow}. */
export function unitRowSorter(shape: Pick<UnitTableShape, 'legacyTable' | 'keyed' | 'keyColumns' | 'columns'>, options: UnitRowSorterOptions = {}): UnitRowSorter {
  return new UnitRowSorter(shape, (encoding, legacyProgramId) => toUnitRow(shape, decodeRow(shape.columns, encoding), legacyProgramId), options);
}

/** Streams the unit's projected legacy rows into a bounded sorter, grouped by resolved tenant. */
export async function readLegacyUnitRows(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'catalog' | 'config'>,
  shape: UnitTableShape,
  options: { database: string; tenants: TenantResolver } & UnitRowSorterOptions,
): Promise<LegacyUnitRows> {
  const { database, tenants } = options;
  const target = unitTarget(deps.catalog, shape.unit, shape.legacyTable);
  const selector = await rowSelectorFor(deps, indexesOf(tenants), database, shape, target.rowPredicate);
  const tenantColumns = tenantColumnsOf(tenantSourceOf(factsFor(deps, shape.legacyTable)));
  const encoded = shape.columns.flatMap((column) => (shape.folded && column.name === LEGACY_PROGRAM_ID_COLUMN ? [] : [column.name]));
  const columns = [...new Set([...encoded, ...selector.columns, ...tenantColumns])];

  const sorter = unitRowSorter(shape, options);
  const orphans = new Map<string, LegacyOrphans>();
  try {
    const stream = streamLegacyTable(deps, {
      table: shape.legacyTable,
      database,
      columns,
      ...(shape.keyed ? { keyColumns: shape.keyColumns } : {}),
    });
    for await (const source of stream) {
      if (!selector.accepts(source.row)) continue;
      const { tenantId, orphan } = tenants.resolve(shape.legacyTable, source.row);
      const values: Record<string, CanonicalValue> = {};
      for (const column of shape.columns) {
        if (!(column.name in source.row)) throw new Error(`legacy table ${shape.legacyTable} of database ${database} yields no column ${column.name}`);
        values[column.name] = source.row[column.name] ?? null;
      }
      const row = toUnitRow(shape, values, source.legacyProgramId);
      await sorter.add(tenantId, row);
      if (!orphan) continue;
      const listed = orphans.get(tenantId) ?? { keys: [], count: 0 };
      orphans.set(tenantId, listed);
      listed.count += 1;
      if (listed.keys.length < DIFFERENCE_LIMIT) listed.keys.push(shape.keyed ? row.key : sha256Hex(row.encoding));
    }
    await sorter.sort();
  } catch (error) {
    await sorter.dispose();
    throw error;
  }
  const sortedTenants = sorter.tenants();
  return {
    tenants: sortedTenants,
    counts: new Map(sortedTenants.map((tenantId) => [tenantId, sorter.count(tenantId)])),
    rows: (tenantId) => sorter.rows(tenantId),
    orphans,
    dispose: () => sorter.dispose(),
  };
}

/** Units whose reconciliation includes the legacy file-store objects: strategies-content's `file_object`, fed by `content-files`. */
export function fileUnitIds(config: Pick<MigrationConfig, 'owners'>): string[] {
  return [`${ownerByName(config, FILE_STORE_OWNER).schema}.${FILE_OBJECT_TABLE}`];
}

/** Store named by a bridge 409 `unsupportedFileStore` body, whose `message` carries it. */
function storeOf(error: UnsupportedFileStoreError): string {
  const message = typeof error.body === 'object' && error.body !== null ? (error.body as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message !== '' ? message : UNKNOWN_STORE;
}

/** Objects of a snapshot's recorded manifest, placed as the transfer places them. */
async function snapshotObjects(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'config' | 'db'>,
  snapshotSeq: number,
  database: string,
): Promise<LegacyObjects> {
  const result = await deps.db.withMetadata((tx) =>
    tx.query<{ state: string; manifest_complete: boolean }>(SNAPSHOT_MANIFEST_SQL, [snapshotSeq]),
  );
  const snapshot = result.rows[0];
  if (snapshot === undefined) throw new Error(`unknown snapshot ${String(snapshotSeq)}`);
  if (snapshot.state !== 'ready') throw new Error(`snapshot ${String(snapshotSeq)} is ${snapshot.state}, not ready`);
  // A ready snapshot without a complete manifest is one whose store takeSnapshot found unsupported.
  if (!snapshot.manifest_complete) {
    return {
      status: 'halted',
      store: UNKNOWN_STORE,
      reason: `snapshot ${String(snapshotSeq)} recorded no file manifest: its legacy file store is not ${SUPPORTED_FILE_STORE}`,
    };
  }
  const byTenant = new Map<string, ObjectEntry[]>();
  for (const planned of await planObjects(deps, snapshotSeq, { database })) {
    // Misplaced copies are never transferred, so they are not objects the target is expected to hold.
    if (planned.status !== 'transfer') continue;
    push(byTenant, planned.tenantId, { key: planned.key, size: planned.entry.size, sha256: planned.entry.sha256.toLowerCase(), orphan: planned.orphan });
  }
  return { status: 'compared', byTenant };
}

/** Objects of the live store listed site by site through the bridge, placed by `planObjects`' rule. */
async function liveObjects(deps: Pick<ReconcileLegacyDeps, 'legacy' | 'config' | 'bridge'>, database: string): Promise<LegacyObjects> {
  const sites = await readSnapshotSites(deps, database);
  const owners = await readSnapshotFileOwners(deps, database);
  const lookups: TenantLookups = { umbrellaSiteId: deps.config.umbrellaSiteId };
  const byTenant = new Map<string, ObjectEntry[]>();
  for (const siteId of sites) {
    const listing = await deps.bridge.filesList(siteId);
    if (listing.fileStore !== SUPPORTED_FILE_STORE) throw new FileStoreUnsupportedError(listing.fileStore, siteId);
    for (const file of listing.files) {
      const parsed = parseStoredName(file.name);
      if (parsed === null) continue;
      // A file without a `tfiles` row, or with a null site, resolves to the umbrella tenant as an orphan.
      const resolved = resolveTenant(TFILES_TENANT_SOURCE, { siteID: owners.get(parsed.fileId.toUpperCase()) ?? null }, lookups);
      if (!resolved.orphan && resolved.siteId.toLowerCase() !== siteId.toLowerCase()) continue;
      push(byTenant, resolved.tenantId, {
        key: objectKey(resolved.tenantId, parsed.fileId, parsed.variant, parsed.ext),
        size: Number(file.size),
        sha256: file.sha256.toLowerCase(),
        orphan: resolved.orphan,
      });
    }
  }
  return { status: 'compared', byTenant };
}

/**
 * Legacy file-store objects per tenant, keyed `<tenant>/<fileID><variant>.<ext>`: from the snapshot's manifest, or for
 * live points listed through the bridge. A store other than `fileDir` answers `halted` rather than throwing.
 */
export async function readLegacyObjects(
  deps: Pick<ReconcileLegacyDeps, 'legacy' | 'config' | 'db' | 'bridge'>,
  options: LegacyObjectsOptions,
): Promise<LegacyObjects> {
  try {
    if (options.legacySource === 'live') return await liveObjects(deps, options.database);
    const { snapshotSeq } = options;
    if (snapshotSeq === undefined || snapshotSeq === null) throw new TypeError('reading snapshot objects needs snapshotSeq');
    return await snapshotObjects(deps, snapshotSeq, options.database);
  } catch (error) {
    if (error instanceof FileStoreUnsupportedError) return { status: 'halted', store: error.fileStore, reason: error.message };
    if (error instanceof UnsupportedFileStoreError) return { status: 'halted', store: storeOf(error), reason: error.message };
    throw error;
  }
}
