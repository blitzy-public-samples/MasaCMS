// Backfill and projection order of the legacy tables, computed from the code relations the inventory records.
import { readFileSync } from 'node:fs';

import { LEGACY_PROGRAM_ID_COLUMN, parseProgramTable, programTableName } from '@opt2/platform/migration-kit';
import { z } from '@opt2/platform/service-kit';

import type { DataOwner, UnitCatalog } from '../owners/index.js';
import { writeJsonReport } from '../reports/index.js';
import type { ReportClock, ReportTarget } from '../reports/index.js';

/** Origin of an ordering edge: an inventory relation kind, or the implicit site and program-fold edges. */
export type OrderRelationKind = 'beanORM' | 'daoJoin' | 'programFk' | 'site' | 'programFold';

/** One side of a relation: a table and its joining column. */
export interface TableRef {
  table: string;
  column: string;
}

/** A child→parent relation; `child.column` holds the reference to `parent.column`. */
export interface OrderRelation {
  id: string;
  kind: OrderRelationKind;
  child: TableRef;
  parent: TableRef;
  source?: { path: string; lines: [number, number] };
}

/** The inventory's tables and relations as the order reads them. */
export interface OrderInventory {
  tables: ReadonlyArray<{ table: string; hasSiteId: boolean }>;
  relations: readonly OrderRelation[];
}

/** Unit-catalog lookups the order uses; `legacyTableOwner` names the owner of the unmigrated `synthetic.program_site`. */
export type OrderCatalog = Pick<
  UnitCatalog,
  'isMigratable' | 'isSplit' | 'ownersForLegacyTable' | 'legacyTableOwner' | 'keyColumnsOf' | 'units' | 'legacyTablesOf'
>;

/** Where a table's rows take their tenant: their own site column, an earlier parent row, or the umbrella site. */
export type TenantFrom = 'siteID' | 'parent' | 'umbrella';

/** One table of the order; `position` is 1-based and `parents` lists every parent table, broken back-references included. */
export interface OrderEntry {
  position: number;
  table: string;
  schema: string;
  owner: DataOwner | 'split';
  parents: readonly string[];
  tenantFrom: TenantFrom;
}

/** A back-reference column broken out of a cycle. */
export interface DeferredColumn {
  table: string;
  column: string;
  references: TableRef;
  relationId: string;
}

/** The computed order and the back-references broken to reach it. */
export interface DependencyOrder {
  order: readonly string[];
  entries: readonly OrderEntry[];
  /** Columns loaded as null in the first pass and set by a second patch pass. */
  deferred: readonly DeferredColumn[];
  /** Back-references whose mirrored relation is kept; they load with their values and need no patch. */
  relaxed: readonly DeferredColumn[];
  /** Member lists, sorted, of every cycle broken. */
  cycles: readonly (readonly string[])[];
  /** The relation a table inherits its tenant through, or null when it has a site column or no earlier parent. */
  parentOf(table: string): OrderRelation | null;
}

/** Inputs of {@link buildDependencyOrder}; `programIds` replaces the program ids found in the inputs. */
export interface BuildDependencyOrderOptions {
  inventory: OrderInventory;
  catalog: OrderCatalog;
  programIds?: readonly number[];
}

/** Inputs of {@link computeDependencyOrder}; a string `inventory` is a path read by {@link loadOrderInventory}. */
export interface ComputeDependencyOrderOptions {
  inventory: OrderInventory | string;
  catalog: OrderCatalog;
  reportsOpts?: { target: ReportTarget; clock?: ReportClock; generatedBy?: string } | null;
  programIds?: readonly number[];
}

/** Body of `migration-order.json`; `writeJsonReport` adds the head keys. */
export type MigrationOrderReport = {
  basis: { relations: string; kinds: readonly string[]; foreignKeysDeclared: 0; cyclePolicy: string };
  expectedHead: { provenance: 'planning'; tables: readonly string[] };
  order: readonly OrderEntry[];
  brokenCycles: readonly { tables: readonly string[]; backReferenceColumn: string; patchedInSecondPass: boolean }[];
};

/** Report path under the reports directory. */
export const MIGRATION_ORDER_REPORT = 'migration-order.json';
/** Sites, which become tenants; every table with a site column follows it. */
export const SITE_ROOT_TABLE = 'tsettings';
/** Maps each `Program_<id>` schema to its site; every program table follows it. */
export const PROGRAM_SITE_TABLE = 'synthetic.program_site';
/** Head of the order as planned; informative, the computed order governs. */
export const EXPECTED_HEAD: readonly string[] = Object.freeze([
  'tsettings',
  'tusers',
  'tusersmemb',
  'tpermissions',
  'people children',
  'tcontent',
  'tcontent version children',
  'categories',
  'files and file objects',
  'approvals and change sets',
  'synthetic.program_site',
  'fixture modules',
]);

const GENERATED_BY = 'migration/src/order/dependency-order.ts';
const PROGRAM_SCHEMA_PATTERN = 'Program_N';
/** The fixture's `synthetic.program_site` rows: program 1 → `tenant-a`, 2 → `tenant-b`. */
const DEFAULT_PROGRAM_IDS: readonly number[] = Object.freeze([1, 2]);
const SITE_COLUMN = 'siteID';
const SITE_ROOT_COLUMN = 'SiteID';
const PROGRAM_SITE_COLUMN = 'program_id';
const TENANT_RANK: Readonly<Record<TenantFrom, number>> = { siteID: 0, parent: 1, umbrella: 2 };
const KIND_RANK: Readonly<Record<OrderRelationKind, number>> = { programFold: 0, beanORM: 1, programFk: 2, daoJoin: 3, site: 4 };

/** The inventory and its relations are inconsistent, or a cycle has no back-reference that can be broken. */
export class DependencyOrderError extends Error {
  override readonly name = 'DependencyOrderError';
}

const INVENTORY_KINDS = {
  'orm-fk': 'beanORM',
  'dao-join': 'daoJoin',
  'fixture-fk': 'programFk',
  'program-fold': 'programFold',
} as const satisfies Record<string, OrderRelationKind>;

const tableName = z.string().min(1);
const sourceSchema = z.object({ path: z.string().min(1), lines: z.tuple([z.number().int(), z.number().int()]) });
const tableRefSchema = z.object({ table: tableName, column: z.string().min(1) });
const inventoryColumns = z.tuple([z.string().min(1)]);

function withSource(relation: Omit<OrderRelation, 'source'>, source: OrderRelation['source']): OrderRelation {
  return source === undefined ? relation : { ...relation, source };
}

/** A relation already in {@link OrderRelation} form, as a serialised {@link OrderInventory} holds it. */
const orderRelationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['beanORM', 'daoJoin', 'programFk', 'site', 'programFold']),
    child: tableRefSchema,
    parent: tableRefSchema,
    source: sourceSchema.optional(),
  })
  .transform(({ source, ...relation }) => withSource(relation, source));

/** A relation as `opt2/inventory/legacy-inventory.json` records it; a program fold names no child column. */
const inventoryRelationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['orm-fk', 'dao-join', 'fixture-fk', 'program-fold']),
    child: z.object({ table: tableName, columns: inventoryColumns.nullable() }),
    parent: z.object({ table: tableName, columns: inventoryColumns }),
    source: sourceSchema.optional(),
  })
  .refine((relation) => relation.child.columns !== null || relation.kind === 'program-fold', {
    message: 'child.columns may be null only for a program-fold relation',
    path: ['child', 'columns'],
  })
  .transform(({ id, kind, child, parent, source }) =>
    withSource(
      {
        id,
        kind: INVENTORY_KINDS[kind],
        child: { table: child.table, column: child.columns?.[0] ?? LEGACY_PROGRAM_ID_COLUMN },
        parent: { table: parent.table, column: parent.columns[0] },
      },
      source,
    ),
  );

const inventorySchema = z.object({
  tables: z.array(
    z
      .object({ table: tableName, hasSiteId: z.boolean().nullable(), hasSiteIdLive: z.boolean().nullable().optional() })
      .transform(({ table, hasSiteId, hasSiteIdLive }) => ({ table, hasSiteId: hasSiteId ?? hasSiteIdLive ?? false })),
  ),
  relations: z.array(z.union([orderRelationSchema, inventoryRelationSchema])),
});

/**
 * Reads the tables and relations of the inventory at `path`, either the legacy inventory or a serialised {@link OrderInventory}.
 * @throws DependencyOrderError naming the file and every schema issue.
 */
export function loadOrderInventory(path: string): OrderInventory {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DependencyOrderError(`inventory ${path} cannot be read as JSON: ${reason}`, { cause: error });
  }
  const parsed = inventorySchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new DependencyOrderError(`invalid inventory ${path}\n  ${issues.join('\n  ')}`, { cause: parsed.error });
  }
  return parsed.data;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders table names case-insensitively by UTF-16 code units, then by their exact form. */
export function compareTableNames(a: string, b: string): number {
  return compareCodeUnits(a.toLowerCase(), b.toLowerCase()) || compareCodeUnits(a, b);
}

function lower(column: string): string {
  return column.toLowerCase();
}

/** Ownership-file form of a table name: brackets and `dbo.` dropped, lower case, `Program_<id>` and `Program_N` schemas kept. */
function normaliseTable(name: string): string {
  const program = parseProgramTable(name);
  if (program !== null) return programTableName(program.programId, program.table.toLowerCase());
  const bare = name.replace(/[[\]]/g, '').replace(/^dbo\./i, '');
  const dot = bare.indexOf('.');
  if (dot === -1) return bare.toLowerCase();
  const schema = bare.slice(0, dot).toLowerCase();
  return `${schema === PROGRAM_SCHEMA_PATTERN.toLowerCase() ? PROGRAM_SCHEMA_PATTERN : schema}.${bare.slice(dot + 1).toLowerCase()}`;
}

function schemaOf(table: string): string {
  const dot = table.indexOf('.');
  return dot === -1 ? 'dbo' : table.slice(0, dot);
}

/** Table part of a normalised `Program_N.<table>` pattern, else null. */
function programPattern(table: string): string | null {
  return table.startsWith(`${PROGRAM_SCHEMA_PATTERN}.`) ? table.slice(PROGRAM_SCHEMA_PATTERN.length + 1) : null;
}

/** The normalised name, with a `Program_N` pattern made concrete for `programId`. */
function instantiate(name: string, programId: number): string {
  const table = normaliseTable(name);
  const generic = programPattern(table);
  return generic === null ? table : programTableName(programId, generic);
}

function expandTable(name: string, programIds: readonly number[]): string[] {
  const table = normaliseTable(name);
  return programPattern(table) === null ? [table] : programIds.map((id) => instantiate(table, id));
}

function isWildcard(table: string): boolean {
  return table.includes('*');
}

function matchesGlob(pattern: string, table: string): boolean {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(table);
}

function compareRelations(a: OrderRelation, b: OrderRelation): number {
  return (
    compareCodeUnits(a.id, b.id) ||
    compareCodeUnits(a.child.table, b.child.table) ||
    compareCodeUnits(a.child.column, b.child.column) ||
    compareCodeUnits(a.parent.table, b.parent.table) ||
    compareCodeUnits(a.parent.column, b.parent.column)
  );
}

/** Identity of an ordering constraint per column; SQL Server compares column names case-insensitively. */
function tripleKey(relation: OrderRelation): string {
  return `${relation.child.table}\u0000${lower(relation.child.column)}\u0000${relation.parent.table}`;
}

/** Frozen copy of `relation` between the concrete tables `child` and `parent`. */
function edgeOf(relation: OrderRelation, child: string, parent: string): OrderRelation {
  const from = relation.source;
  const source =
    from === undefined
      ? undefined
      : Object.freeze<NonNullable<OrderRelation['source']>>({ path: from.path, lines: [from.lines[0], from.lines[1]] });
  return Object.freeze(
    withSource(
      {
        id: relation.id,
        kind: relation.kind,
        child: Object.freeze({ table: child, column: relation.child.column }),
        parent: Object.freeze({ table: parent, column: relation.parent.column }),
      },
      source,
    ),
  );
}

function implicitEdge(kind: 'site' | 'programFold', child: TableRef, parent: TableRef): OrderRelation {
  return edgeOf({ id: `implicit:${kind}:${child.table}`, kind, child, parent }, child.table, parent.table);
}

/** Concrete tables a normalised relation side names: a wildcard matches nodes, any other name is kept when it is a node. */
function resolveSide(table: string, nodes: ReadonlySet<string>): string[] {
  if (isWildcard(table)) return [...nodes].filter((node) => matchesGlob(table, node));
  return nodes.has(table) ? [table] : [];
}

/** Edges of `relation` between nodes; `Program_N` sides become one edge per program id, both sides on the same program. */
function expandRelation(relation: OrderRelation, programIds: readonly number[], nodes: ReadonlySet<string>): OrderRelation[] {
  const child = normaliseTable(relation.child.table);
  const parent = normaliseTable(relation.parent.table);
  const pairs: [string, string][] =
    programPattern(child) === null && programPattern(parent) === null
      ? [[child, parent]]
      : programIds.map((id) => [instantiate(child, id), instantiate(parent, id)]);
  const edges: OrderRelation[] = [];
  for (const [childName, parentName] of pairs) {
    for (const childTable of resolveSide(childName, nodes)) {
      for (const parentTable of resolveSide(parentName, nodes)) {
        if (childTable !== parentTable) edges.push(edgeOf(relation, childTable, parentTable));
      }
    }
  }
  return edges;
}

function concreteProgramIds(names: Iterable<string>): number[] {
  const ids = new Set<number>();
  for (const name of names) {
    const program = parseProgramTable(name);
    if (program !== null) ids.add(program.programId);
  }
  return [...ids].sort((a, b) => a - b);
}

interface Graph {
  readonly nodes: readonly string[];
  readonly incoming: ReadonlyMap<string, readonly OrderRelation[]>;
  readonly outgoing: ReadonlyMap<string, readonly OrderRelation[]>;
  /** Tables whose rows carry their own site; `Program_<id>` tables resolve theirs through `synthetic.program_site`. */
  readonly siteTenant: ReadonlySet<string>;
}

function buildGraph(inventory: OrderInventory, catalog: OrderCatalog, programIds: readonly number[]): Graph {
  const candidates = new Set<string>();
  const add = (name: string): void => {
    for (const table of expandTable(name, programIds)) if (!isWildcard(table)) candidates.add(table);
  };
  for (const { table } of inventory.tables) add(table);
  for (const { child, parent } of inventory.relations) {
    add(child.table);
    add(parent.table);
  }
  for (const unit of catalog.units()) for (const table of catalog.legacyTablesOf(unit.id)) add(table);
  const nodeSet = new Set([...candidates].sort(compareTableNames).filter((table) => catalog.isMigratable(table)));
  // The fold mapping does not migrate, yet program tables take their tenant through it, so it heads them in the order.
  if ([...nodeSet].some((table) => parseProgramTable(table) !== null)) nodeSet.add(PROGRAM_SITE_TABLE);
  const nodes = [...nodeSet].sort(compareTableNames);

  const keys = new Set<string>();
  const edges: OrderRelation[] = [];
  const keep = (edge: OrderRelation): void => {
    const key = tripleKey(edge);
    if (keys.has(key)) return;
    keys.add(key);
    edges.push(edge);
  };
  inventory.relations
    .flatMap((relation) => expandRelation(relation, programIds, nodeSet))
    .sort(compareRelations)
    .forEach(keep);

  const siteEvidence = new Set<string>([PROGRAM_SITE_TABLE]);
  for (const { table, hasSiteId } of inventory.tables) {
    if (hasSiteId) for (const name of expandTable(table, programIds)) siteEvidence.add(name);
  }
  for (const edge of edges) {
    if (lower(edge.child.column) === lower(SITE_COLUMN) && edge.parent.table === SITE_ROOT_TABLE) siteEvidence.add(edge.child.table);
  }

  const siteRoot: TableRef = { table: SITE_ROOT_TABLE, column: SITE_ROOT_COLUMN };
  const programSite: TableRef = { table: PROGRAM_SITE_TABLE, column: PROGRAM_SITE_COLUMN };
  for (const table of nodes) {
    if (table !== SITE_ROOT_TABLE && nodeSet.has(SITE_ROOT_TABLE) && siteEvidence.has(table)) {
      keep(implicitEdge('site', { table, column: SITE_COLUMN }, siteRoot));
    }
    if (parseProgramTable(table) !== null) keep(implicitEdge('programFold', { table, column: LEGACY_PROGRAM_ID_COLUMN }, programSite));
  }
  edges.sort(compareRelations);

  const incoming = new Map<string, OrderRelation[]>(nodes.map((table) => [table, []]));
  const outgoing = new Map<string, OrderRelation[]>(nodes.map((table) => [table, []]));
  for (const edge of edges) {
    incoming.get(edge.child.table)?.push(edge);
    outgoing.get(edge.parent.table)?.push(edge);
  }
  const siteTenant = new Set(nodes.filter((table) => siteEvidence.has(table) && parseProgramTable(table) === null));
  return { nodes, incoming, outgoing, siteTenant };
}

/** Tarjan's strongly connected components of size two or more over `childrenOf`, each sorted by {@link compareTableNames}. */
function cyclicComponents(tables: readonly string[], childrenOf: (table: string) => readonly string[]): string[][] {
  const marks = new Map<string, { index: number; low: number }>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (table: string): { index: number; low: number } => {
    const mark = { index: marks.size, low: marks.size };
    marks.set(table, mark);
    stack.push(table);
    onStack.add(table);
    for (const child of childrenOf(table)) {
      const seen = marks.get(child);
      if (seen === undefined) mark.low = Math.min(mark.low, visit(child).low);
      else if (onStack.has(child)) mark.low = Math.min(mark.low, seen.index);
    }
    if (mark.low === mark.index) {
      const component = stack.splice(stack.lastIndexOf(table));
      for (const member of component) onStack.delete(member);
      if (component.length > 1) components.push(component.sort(compareTableNames));
    }
    return mark;
  };
  for (const table of tables) if (!marks.has(table)) visit(table);
  return components;
}

type Break = 'deferred' | 'relaxed';

interface Sorted {
  readonly order: string[];
  readonly broken: ReadonlyMap<OrderRelation, Break>;
  readonly cycles: string[][];
}

/**
 * Kahn's sort taking `tsettings`, then the smallest ready table, first. On a stall it breaks the cycle whose smallest member is smallest:
 * the first member, in name order, all of whose in-cycle back-references are either mirrored by a kept relation on the
 * same column pair (relaxed) or held in a non-key column (deferred) has those back-references broken.
 * @throws DependencyOrderError when no member of the cycle qualifies.
 */
function sortTables(graph: Graph, catalog: OrderCatalog): Sorted {
  const remaining = new Set(graph.nodes);
  const broken = new Map<OrderRelation, Break>();
  const order: string[] = [];
  const cycles: string[][] = [];
  const intoOf = (table: string): readonly OrderRelation[] => graph.incoming.get(table) ?? [];
  const active = (edge: OrderRelation): boolean => !broken.has(edge);
  const isMirror = (edge: OrderRelation, candidate: OrderRelation): boolean =>
    candidate.parent.table === edge.child.table &&
    lower(candidate.child.column) === lower(edge.parent.column) &&
    lower(candidate.parent.column) === lower(edge.child.column);

  const breakCycle = (): void => {
    const children = (table: string): string[] =>
      (graph.outgoing.get(table) ?? []).filter((edge) => active(edge) && remaining.has(edge.child.table)).map((edge) => edge.child.table);
    const cycle = cyclicComponents([...remaining], children).sort((a, b) => compareTableNames(a[0] ?? '', b[0] ?? ''))[0];
    if (cycle === undefined) throw new DependencyOrderError(`no cycle found among the unordered tables ${[...remaining].join(', ')}`);
    const members = new Set(cycle);
    for (const member of cycle) {
      const keyColumns = new Set(catalog.keyColumnsOf(member).map(lower));
      const plan = intoOf(member)
        .filter((edge) => active(edge) && members.has(edge.parent.table))
        .map((edge): [OrderRelation, Break | null] => {
          if (intoOf(edge.parent.table).some((candidate) => active(candidate) && isMirror(edge, candidate))) return [edge, 'relaxed'];
          return [edge, keyColumns.has(lower(edge.child.column)) ? null : 'deferred'];
        });
      if (plan.every(([, how]) => how !== null)) {
        for (const [edge, how] of plan) if (how !== null) broken.set(edge, how);
        if (!cycles.some((recorded) => recorded.join('\u0000') === cycle.join('\u0000'))) cycles.push(cycle);
        return;
      }
    }
    throw new DependencyOrderError(`cycle ${cycle.join(', ')} has no member whose back-references are all non-key or mirrored`);
  };

  const isReady = (table: string): boolean => intoOf(table).every((edge) => !active(edge) || !remaining.has(edge.parent.table));
  while (remaining.size > 0) {
    // Sites become tenants, the umbrella included, so the site table leads even tables without any parent.
    const next = remaining.has(SITE_ROOT_TABLE) && isReady(SITE_ROOT_TABLE) ? SITE_ROOT_TABLE : [...remaining].find(isReady);
    if (next === undefined) {
      breakCycle();
      continue;
    }
    order.push(next);
    remaining.delete(next);
  }
  return { order, broken, cycles };
}


/**
 * Tenant source of each table, in order. A table without its own site inherits through its unbroken relation ranked by
 * the parent's tenant source (siteID, parent, umbrella), then kind (programFold, beanORM, programFk, daoJoin, site), then
 * a parent sharing an owner with the child (a `tusersinterests` row follows its user, not its pooled category), then
 * parent name, child column and relation id.
 */
function inheritTenants(
  sorted: Sorted,
  graph: Graph,
  catalog: OrderCatalog,
): { parents: Map<string, OrderRelation | null>; tenantFrom: Map<string, TenantFrom> } {
  const parents = new Map<string, OrderRelation | null>();
  const tenantFrom = new Map<string, TenantFrom>();
  const tenantRank = (edge: OrderRelation): number => TENANT_RANK[tenantFrom.get(edge.parent.table) ?? 'umbrella'];
  const ownerRank = (edge: OrderRelation): number => {
    const childOwners = catalog.ownersForLegacyTable(edge.child.table);
    return catalog.ownersForLegacyTable(edge.parent.table).some((owner) => childOwners.includes(owner)) ? 0 : 1;
  };
  for (const table of sorted.order) {
    const ownSite = graph.siteTenant.has(table);
    const parent = ownSite
      ? null
      : ((graph.incoming.get(table) ?? [])
          .filter((edge) => !sorted.broken.has(edge))
          .sort(
            (a, b) =>
              tenantRank(a) - tenantRank(b) ||
              KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
              ownerRank(a) - ownerRank(b) ||
              compareTableNames(a.parent.table, b.parent.table) ||
              compareCodeUnits(a.child.column, b.child.column) ||
              compareCodeUnits(a.id, b.id),
          )[0] ?? null);
    parents.set(table, parent);
    tenantFrom.set(table, ownSite ? 'siteID' : parent === null ? 'umbrella' : 'parent');
  }
  return { parents, tenantFrom };
}

/** Owner recorded for an ordered table; the unmigrated `synthetic.program_site` has no targets, so its table owner is used. */
function ownerOf(catalog: OrderCatalog, table: string): DataOwner | 'split' {
  if (catalog.isSplit(table)) return 'split';
  const owner = catalog.ownersForLegacyTable(table)[0] ?? catalog.legacyTableOwner(table);
  if (owner === 'decision-list' || owner === 'retired') throw new DependencyOrderError(`ordered table ${table} is owned by "${owner}"`);
  return owner;
}

function defaultProgramIds(inventory: OrderInventory, catalog: OrderCatalog): readonly number[] {
  const ids = concreteProgramIds([
    ...inventory.tables.map(({ table }) => table),
    ...inventory.relations.flatMap(({ child, parent }) => [child.table, parent.table]),
    ...catalog.units().flatMap((unit) => catalog.legacyTablesOf(unit.id)),
  ]);
  return ids.length > 0 ? ids : DEFAULT_PROGRAM_IDS;
}

/**
 * Orders every migratable table of the inventory, the catalog's units and the relation endpoints so that parents precede
 * children, breaking cycles as {@link sortTables} describes; pure, deterministic and frozen.
 * @throws DependencyOrderError for an unbreakable cycle; UnknownLegacyTableError for a table the ownership file does not list.
 */
export function buildDependencyOrder({ inventory, catalog, programIds }: BuildDependencyOrderOptions): DependencyOrder {
  const graph = buildGraph(inventory, catalog, programIds ?? defaultProgramIds(inventory, catalog));
  const sorted = sortTables(graph, catalog);
  const { parents, tenantFrom } = inheritTenants(sorted, graph, catalog);
  const entries = sorted.order.map((table, index) =>
    Object.freeze({
      position: index + 1,
      table,
      schema: schemaOf(table),
      owner: ownerOf(catalog, table),
      parents: Object.freeze([...new Set((graph.incoming.get(table) ?? []).map((edge) => edge.parent.table))].sort(compareTableNames)),
      tenantFrom: tenantFrom.get(table) ?? 'umbrella',
    }),
  );
  const brokenAs = (how: Break): readonly DeferredColumn[] =>
    Object.freeze(
      [...sorted.broken]
        .filter(([, broken]) => broken === how)
        .map(([{ child, parent, id }]) => Object.freeze({ table: child.table, column: child.column, references: parent, relationId: id })),
    );
  return Object.freeze({
    order: Object.freeze([...sorted.order]),
    entries: Object.freeze(entries),
    deferred: brokenAs('deferred'),
    relaxed: brokenAs('relaxed'),
    cycles: Object.freeze(sorted.cycles.map((cycle) => Object.freeze([...cycle]))),
    parentOf: (table: string) => parents.get(normaliseTable(table)) ?? null,
  });
}

/** The relation `table` inherits its tenant through in `order`, as {@link DependencyOrder.parentOf}. */
export function parentOf(order: DependencyOrder, table: string): OrderRelation | null {
  return order.parentOf(table);
}

/** Report body of `order`: its entries and one broken-cycle item per deferred or relaxed back-reference. */
export function toMigrationOrderReport(order: DependencyOrder): MigrationOrderReport {
  // A member whose back-references were broken leaves every later cycle, so the last cycle holding it is the one broken.
  const cycleOf = (table: string): readonly string[] => order.cycles.findLast((cycle) => cycle.includes(table)) ?? [];
  const items = (columns: readonly DeferredColumn[], patchedInSecondPass: boolean) =>
    columns.map(({ table, column }) => ({ tables: cycleOf(table), backReferenceColumn: `${table}.${column}`, patchedInSecondPass }));
  return {
    basis: {
      relations: 'opt2/inventory/legacy-inventory.json relations[]',
      kinds: ['beanORM fkcolumn/cfc property', 'DAO join predicate in core/mura/**', 'Program_<id> fixture foreign-key column'],
      foreignKeysDeclared: 0,
      cyclePolicy: 'load without back-reference column, patch in second pass; a back-reference mirrored by a kept relation loads unchanged',
    },
    expectedHead: { provenance: 'planning', tables: EXPECTED_HEAD },
    order: order.entries,
    brokenCycles: [...items(order.deferred, true), ...items(order.relaxed, false)],
  };
}

/** Writes `order` as `migration-order.json` under the target's reports directory, stamped with its source SHA. */
export async function writeMigrationOrderReport(
  target: ReportTarget,
  order: DependencyOrder,
  opts: { clock?: ReportClock; generatedBy?: string } = {},
): Promise<{ path: string; report: Record<string, unknown> }> {
  return writeJsonReport(target, MIGRATION_ORDER_REPORT, toMigrationOrderReport(order), {
    clock: opts.clock,
    generatedBy: opts.generatedBy ?? GENERATED_BY,
    status: 'generated',
  });
}

/** Loads the inventory when given a path, builds the order and, with `reportsOpts`, writes its report. */
export async function computeDependencyOrder(options: ComputeDependencyOrderOptions): Promise<DependencyOrder> {
  const inventory = typeof options.inventory === 'string' ? loadOrderInventory(options.inventory) : options.inventory;
  const order = buildDependencyOrder({ inventory, catalog: options.catalog, programIds: options.programIds });
  const reports = options.reportsOpts;
  if (reports) await writeMigrationOrderReport(reports.target, order, { clock: reports.clock, generatedBy: reports.generatedBy });
  return order;
}

