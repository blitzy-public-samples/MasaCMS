// Code relations between legacy tables: beanORM relation properties, DAO join predicates and fixture key columns.
import { z } from '@opt2/platform/service-kit';
import {
  parseCfmlComponent,
  resolveComponentPath,
  stripComments,
  type CfmlComponent,
  type CfmlProperty,
  type SourceTree,
} from './closure.js';
import { ENTITY_SCAN_ROOT, ormEntityIndex, type EntityEntry, type OrmEntityIndex } from './entities.js';
import { tableKey, type TableEntry } from './tables.js';

/** Evidence kind; the names are the ones `migration/src/order/dependency-order.ts` reads. */
export type RelationKind = 'orm-fk' | 'dao-join' | 'fixture-fk' | 'program-fold' | 'tenant-parent';

/** `fieldtype` of the beanORM relation property an `orm-fk` relation comes from. */
export type Cardinality = 'many-to-one' | 'one-to-many' | 'one-to-one';

/**
 * How child and parent were told apart: a relation declaration, the key side of a join predicate, or neither.
 * An `unknown` edge names no key side, so it carries no load order; its sides are in name order.
 */
export type Orientation = 'declared' | 'primary-key' | 'unknown';

/** Why the parent column is the one recorded. */
export type ParentKeyBasis =
  /** The property's explicit `loadkey`, which the related entity has. */
  | 'loadkey'
  /** The property's `fkcolumn`, kept as load key because the related entity has it (bean.cfc 131-139). */
  | 'fkcolumn'
  /** The related entity's primary key: its `fieldtype="id"` property or `variables.primaryKey`. */
  | 'entity-key'
  /** The built-in key of a domain bean absent from the tree (`site`, `user`, `content`). */
  | 'domain-bean'
  /** The table's sole primary-key column. */
  | 'table-key'
  /** A join predicate whose key side is unknown. */
  | 'join'
  /** A key column as `opt2/table-ownership.json` states it. */
  | 'ownership';

/** Repository-relative file and 1-based line span; `[1, 1]` when the evidence names no line. */
export interface RelationSource {
  path: string;
  lines: [number, number];
}

/** One edge; `child.columns` holds the reference to `parent.columns`, and is null only for a program fold. */
export interface Relation {
  id: string;
  kind: RelationKind;
  child: { table: string; columns: string[] | null };
  parent: { table: string; columns: string[] };
  /** Lowest `(path, line)` among the evidence for this edge. */
  source: RelationSource;
  /** The property's `cfc` attribute (`orm-fk` only). */
  cfc: string | null;
  cardinality: Cardinality | null;
  orientation: Orientation;
  /** How the parent column was chosen, and the component whose key it is when one was resolved. */
  parentKey: { basis: ParentKeyBasis; component: string | null };
  /** True when the child has no `siteID` and takes its tenant through this parent. */
  tenantDerivation: boolean;
}

/** Ownership file as {@link fixtureRelations} reads it: `tables[]` entries with their stated key fields. */
export interface FixtureOwnership {
  readonly tables: ReadonlyArray<{ readonly table: string; readonly [field: string]: unknown }>;
}

/** Inputs of {@link extractRelations}. */
export interface RelationInputs {
  entities: readonly EntityEntry[];
  tables: readonly TableEntry[];
  tree: SourceTree;
  /** ORM name index of `entities.ts`; derived from `entities` when absent. */
  index?: OrmEntityIndex;
  ownership: FixtureOwnership;
}

/** Tallies of `relations` by kind, of `unoriented`, and of the edges dropped for touching an uninventoried table. */
export interface RelationCounts {
  relations: number;
  ormFk: number;
  daoJoin: number;
  fixtureFk: number;
  programFold: number;
  tenantParent: number;
  unknownOrientation: number;
  relationsDropped: number;
}

/** Result of {@link extractRelations}. */
export interface RelationExtraction {
  /** Oriented edges, sorted by id: the inventory's `relations[]`. */
  relations: Relation[];
  /** Join edges with no key side, sorted by id; recorded apart because they carry no load order. */
  unoriented: Relation[];
  counts: RelationCounts;
  /** Ids of the edges dropped for touching a table the inventory does not list, sorted. */
  dropped: string[];
}

const RELATION_FIELDTYPES: ReadonlySet<string> = new Set(['many-to-one', 'one-to-many', 'one-to-one']);
const PRIMARY_KEY = 'primarykey';
/** bean.cfc 875: a nested relation loads its children by `parentid`. */
const NESTED_LOAD_KEY = 'parentid';
/** Bootstrap tables of the domain beans `site`, `user` and `content` (aliases at onApplicationStart_include.cfm 340, 345-346). */
const DOMAIN_BEANS: Readonly<Record<string, { table: string; column: string }>> = {
  site: { table: 'tsettings', column: 'SiteID' },
  user: { table: 'tusers', column: 'UserID' },
  content: { table: 'tcontent', column: 'ContentID' },
};
/** Content rows are referenced by the content id, not by the table's own `tcontent_ID` key. */
const CONTENT_ID_TABLE = 'tcontent';
const FIXTURE_TABLE = /^(?:synthetic|program_(?:\d+|n))\./i;
const PROGRAM_TABLE = /^program_(?:\d+|n)\./i;
const PROGRAM_SITE_TABLE = 'synthetic.program_site';
const OWNERSHIP_FILE = 'opt2/table-ownership.json';
const NO_LINE: [number, number] = [1, 1];
const KIND_RANK: Readonly<Record<RelationKind, number>> = { 'orm-fk': 0, 'fixture-fk': 1, 'program-fold': 2, 'dao-join': 3, 'tenant-parent': 4 };
const ORIENTATION_RANK: Readonly<Record<Orientation, number>> = { declared: 0, 'primary-key': 1, unknown: 2 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSource(a: RelationSource, b: RelationSource): number {
  return compareText(a.path, b.path) || a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1];
}

function lower(name: string): string {
  return name.toLowerCase();
}

/** `rel:<childTable>.<childColumn>-><parentTable>.<parentColumn>`, lower-cased; a program fold names no child column. */
function relationId(child: Relation['child'], parent: Relation['parent']): string {
  const from = child.columns === null ? child.table : `${child.table}.${child.columns.join(',')}`;
  return lower(`rel:${from}->${parent.table}.${parent.columns.join(',')}`);
}

function relation(fields: Omit<Relation, 'id'>): Relation {
  return { id: relationId(fields.child, fields.parent), ...fields };
}

function point(path: string, line: number): RelationSource {
  return { path, lines: [line, line] };
}

/** Table entries by {@link tableKey}. */
function tableIndex(tables: readonly TableEntry[]): Map<string, TableEntry> {
  return new Map(tables.map((t) => [tableKey(t.table), t]));
}

/** The table's declared spelling of `column`, else `column` as written. */
function columnCase(table: TableEntry | undefined, column: string): string {
  return table?.columns.find((c) => lower(c.name) === lower(column))?.name ?? column;
}

function soleKey(table: TableEntry | undefined): string | null {
  return table !== undefined && table.primaryKey.length === 1 ? (table.primaryKey[0] ?? null) : null;
}

/** True for an oriented edge whose child is known to have no site column. */
function derivesTenant(childHasSiteId: boolean | null | undefined, orientation: Orientation): boolean {
  return orientation !== 'unknown' && childHasSiteId === false;
}

/** The preferred record of each id: a known orientation first, then declared kinds, then orientation, then the lowest source. */
function bestPerId(relations: Iterable<Relation>): Relation[] {
  const best = new Map<string, Relation>();
  const unknown = (r: Relation): number => (r.orientation === 'unknown' ? 1 : 0);
  for (const r of relations) {
    const held = best.get(r.id);
    const better =
      held === undefined ||
      (unknown(r) - unknown(held) ||
        KIND_RANK[r.kind] - KIND_RANK[held.kind] ||
        ORIENTATION_RANK[r.orientation] - ORIENTATION_RANK[held.orientation] ||
        compareSource(r.source, held.source)) < 0;
    if (better) best.set(r.id, r);
  }
  return [...best.values()].sort((a, b) => compareText(a.id, b.id));
}

// ---------------------------------------------------------------------------------------------------------------
// Component model
// ---------------------------------------------------------------------------------------------------------------

interface DeclaredProperty {
  prop: CfmlProperty;
  path: string;
}

/** An entity as a relation addresses it; `component` is null for a built-in domain bean. */
interface EntityTarget {
  table: string;
  key: string | null;
  /** Every column the entity declares as a key: its primary key and its `fieldtype="id"` properties. */
  keys: readonly string[];
  component: string | null;
  properties: ReadonlyMap<string, DeclaredProperty>;
}

interface Model {
  tree: SourceTree;
  tables: ReadonlyMap<string, TableEntry>;
  /** Entities with a table, in id order. */
  entities: readonly EntityEntry[];
  target(entity: EntityEntry): EntityTarget;
  /** The entity a property's `cfc` names, or null when nothing in the tree or the domain-bean map declares it. */
  resolve(cfc: string): EntityTarget | null;
  /** Whether the entity has `column`, as `bean.has()` answers it: a declared property or a column of its table. */
  has(target: EntityTarget, column: string): boolean;
}

const PK_ASSIGNMENT = /\bvariables\.primaryKey\s*=\s*(["'])([A-Za-z_][\w$]*)\1/i;

/** Properties of a component and its ancestors; the first declaration of a name wins, as bean.cfc 815 applies them. */
function declaredProperties(chain: readonly CfmlComponent[]): Map<string, DeclaredProperty> {
  const out = new Map<string, DeclaredProperty>();
  for (const comp of chain) {
    for (const prop of comp.properties) if (!out.has(lower(prop.name))) out.set(lower(prop.name), { prop, path: comp.path });
  }
  return out;
}

function idProperties(properties: ReadonlyMap<string, DeclaredProperty>): string[] {
  return [...properties.values()].filter((p) => lower(p.prop.attrs.fieldtype ?? '') === 'id').map((p) => p.prop.name);
}

/**
 * The key `getPrimaryKey()` returns: for an ORM entity its last `id` property other than `histid` (bean.cfc 835-839),
 * for any other bean its `variables.primaryKey` (bean.cfc 587-589), else its `id` property.
 */
function entityKey(entity: EntityEntry, chain: readonly CfmlComponent[], ids: readonly string[]): string | null {
  const ormKey = ids.filter((n) => lower(n) !== 'histid').at(-1) ?? ids.at(-1) ?? null;
  if (entity.class === 'orm-concrete') return ormKey;
  for (const comp of chain) {
    const assigned = PK_ASSIGNMENT.exec(comp.text)?.[2];
    if (assigned !== undefined) return assigned;
  }
  return ormKey;
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.cfc$/i, '');
}

function createModel(tree: SourceTree, entities: readonly EntityEntry[], index: OrmEntityIndex, tables: readonly TableEntry[]): Model {
  const byTable = tableIndex(tables);
  const parsed = new Map<string, CfmlComponent | null>();
  const parse = (p: string): CfmlComponent | null => {
    if (!parsed.has(p)) parsed.set(p, tree.exists(p) ? parseCfmlComponent(p, tree.readText(p)) : null);
    return parsed.get(p) ?? null;
  };
  const chainOf = (p: string): CfmlComponent[] => {
    const out: CfmlComponent[] = [];
    const seen = new Set<string>();
    for (let cur: string | null = p; cur !== null && !seen.has(cur); ) {
      seen.add(cur);
      const comp = parse(cur);
      if (comp === null) break;
      out.push(comp);
      const ext = comp.declaration.attrs.extends;
      cur = ext === undefined || ext === '' ? null : resolveComponentPath(ext, cur, tree);
    }
    return out;
  };

  const tabled = entities
    .filter((e) => !e.pattern && e.table !== null && (e.class === 'orm-concrete' || e.class === 'domain-bean'))
    .sort((a, b) => compareText(a.id, b.id));
  const byPath = new Map<string, EntityEntry>();
  const byName = new Map<string, EntityEntry>();
  const byStem = new Map<string, EntityEntry>();
  // ORM entities take a shared name first, as the ORM name index does.
  for (const e of [...tabled.filter((t) => t.class === 'orm-concrete'), ...tabled.filter((t) => t.class !== 'orm-concrete')]) {
    if (!byPath.has(e.source.path)) byPath.set(e.source.path, e);
    const name = e.registeredName === null ? null : lower(e.registeredName);
    if (name !== null && !byName.has(name)) byName.set(name, e);
    if (!byStem.has(lower(baseName(e.source.path)))) byStem.set(lower(baseName(e.source.path)), e);
  }

  const targets = new Map<string, EntityTarget>();
  const target = (e: EntityEntry): EntityTarget => {
    const held = targets.get(e.id);
    if (held !== undefined) return held;
    const chain = chainOf(e.source.path);
    const properties = declaredProperties(chain);
    const ids = idProperties(properties);
    const table = e.table ?? '';
    const key = entityKey(e, chain, ids) ?? soleKey(byTable.get(tableKey(table)));
    const keys = [...new Set([key, ...ids].filter((k): k is string => k !== null).map(lower))];
    const made: EntityTarget = { table, key, keys, component: e.source.path, properties };
    targets.set(e.id, made);
    return made;
  };

  const resolve = (cfc: string): EntityTarget | null => {
    const name = lower(cfc.trim());
    const ormPath = index.byEntityName.get(name);
    const entity = (ormPath === undefined ? undefined : byPath.get(ormPath)) ?? byName.get(name) ?? byStem.get(name);
    if (entity !== undefined) return target(entity);
    if (!Object.hasOwn(DOMAIN_BEANS, name)) return null;
    const domain = DOMAIN_BEANS[name] as { table: string; column: string };
    const key = domain.table === CONTENT_ID_TABLE ? domain.column : (soleKey(byTable.get(domain.table)) ?? domain.column);
    return { table: domain.table, key, keys: [lower(key)], component: null, properties: new Map() };
  };

  const has = (t: EntityTarget, column: string): boolean =>
    t.properties.has(lower(column)) || byTable.get(tableKey(t.table))?.columns.some((c) => lower(c.name) === lower(column)) === true;

  return { tree, tables: byTable, entities: tabled, target, resolve, has };
}

// ---------------------------------------------------------------------------------------------------------------
// ORM relations
// ---------------------------------------------------------------------------------------------------------------

/** `primaryKey` stands for the entity's own key (bean.cfc 271-275). */
function translateKey(name: string, ownKey: string | null): string | null {
  return lower(name) === PRIMARY_KEY ? ownKey : name;
}

/** Both sides name one column of one table: such an edge records no reference. */
function sameColumn(a: { table: string; column: string | null }, b: { table: string; column: string | null }): boolean {
  return tableKey(a.table) === tableKey(b.table) && lower(a.column ?? '') === lower(b.column ?? '');
}

function attr(prop: CfmlProperty, name: string): string | null {
  const value = prop.attrs[name]?.trim();
  return value === undefined || value === '' ? null : value;
}

/**
 * The edge one relation property declares, following bean.cfc 867-1012 and its load at 131-143 and 242-257.
 * many-to-one and one-to-one: this entity's `fkcolumn` (default its key) refers to the related entity's load key,
 * which is `loadkey` (default `fkcolumn`) while the related entity has it, else the related key.
 * one-to-many: the related entity's load key, under the same default and fallback, refers to this entity's `fkcolumn`.
 */
function propertyRelation(self: EntityTarget, related: EntityTarget, declared: DeclaredProperty, model: Model): Relation | null {
  const { prop, path } = declared;
  const cardinality = lower(attr(prop, 'fieldtype') ?? '') as Cardinality;
  const cfc = attr(prop, 'cfc') ?? attr(prop, 'relatesto') ?? '';
  const fkColumn = attr(prop, 'fkcolumn') ?? 'primaryKey';
  const nested = lower(attr(prop, 'nested') ?? '') === 'true';
  const declaredLoadKey = nested ? NESTED_LOAD_KEY : attr(prop, 'loadkey');
  const loadKey = declaredLoadKey ?? fkColumn;
  let child: { table: string; column: string | null };
  let parent: { table: string; column: string | null };
  let basis: ParentKeyBasis;
  if (cardinality === 'one-to-many') {
    const childKey = model.has(related, loadKey) ? loadKey : fkColumn;
    child = { table: related.table, column: translateKey(childKey, self.key) };
    parent = { table: self.table, column: translateKey(fkColumn, self.key) };
    basis = lower(fkColumn) === PRIMARY_KEY ? 'entity-key' : 'fkcolumn';
  } else {
    child = { table: self.table, column: translateKey(fkColumn, self.key) };
    if (lower(loadKey) !== PRIMARY_KEY && model.has(related, loadKey)) {
      parent = { table: related.table, column: loadKey };
      basis = declaredLoadKey === null ? 'fkcolumn' : 'loadkey';
    } else {
      parent = { table: related.table, column: related.key };
      basis = related.component === null ? 'domain-bean' : 'entity-key';
    }
  }
  if (child.column === null || parent.column === null || sameColumn(child, parent)) return null;
  const childTable = model.tables.get(tableKey(child.table));
  const parentTable = model.tables.get(tableKey(parent.table));
  return relation({
    kind: 'orm-fk',
    child: { table: child.table, columns: [columnCase(childTable, child.column)] },
    parent: { table: parent.table, columns: [columnCase(parentTable, parent.column)] },
    source: point(path, prop.line),
    cfc,
    cardinality,
    orientation: 'declared',
    parentKey: { basis, component: cardinality === 'one-to-many' ? self.component : related.component },
    tenantDerivation: derivesTenant(childTable?.hasSiteId, 'declared'),
  });
}

function ormRelationsOf(model: Model): Relation[] {
  const out: Relation[] = [];
  for (const entity of model.entities) {
    const self = model.target(entity);
    for (const declared of self.properties.values()) {
      const fieldtype = lower(attr(declared.prop, 'fieldtype') ?? '');
      const cfc = attr(declared.prop, 'cfc') ?? attr(declared.prop, 'relatesto');
      // A non-persistent property stores no column, so it records no reference.
      if (!RELATION_FIELDTYPES.has(fieldtype) || cfc === null || lower(attr(declared.prop, 'persistent') ?? '') === 'false') continue;
      const related = model.resolve(cfc);
      const made = related === null ? null : propertyRelation(self, related, declared, model);
      if (made !== null) out.push(made);
    }
  }
  return out;
}

/**
 * Relations declared by the `many-to-one`, `one-to-many` and `one-to-one` properties of every concrete ORM entity and
 * table-mapped domain bean, inherited properties included. `cfc` resolves through the entity name index, then the
 * entities' registered names and file stems, then the domain-bean map. `tables` supplies column spelling, the
 * `has()` check and `tenantDerivation`. Deduplicated by id and sorted.
 */
export function extractOrmRelations(
  entities: readonly EntityEntry[],
  tree: SourceTree,
  index: OrmEntityIndex = ormEntityIndex(entities),
  tables: readonly TableEntry[] = [],
): Relation[] {
  return bestPerId(ormRelationsOf(createModel(tree, entities, index, tables)));
}

// ---------------------------------------------------------------------------------------------------------------
// DAO join predicates
// ---------------------------------------------------------------------------------------------------------------

interface SqlSpan {
  start: number;
  end: number;
  tag: boolean;
}

/** Index after the `#…#` expression whose body starts at `from`; quotes inside it open nested strings. */
function hashEnd(text: string, from: number): number {
  let j = from;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === '#') return j + 1;
    j = c === '"' || c === "'" ? stringEnd(text, j) : j + 1;
  }
  return text.length;
}

/** Index after the CFML string literal opening at `at`: doubled quotes and `##` escape, `#…#` interpolates. */
function stringEnd(text: string, at: number): number {
  const quote = text.charAt(at);
  let j = at + 1;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === quote) {
      if (text.charAt(j + 1) !== quote) return j + 1;
      j += 2;
    } else if (c === '#') {
      j = text.charAt(j + 1) === '#' ? j + 2 : hashEnd(text, j + 1);
    } else {
      j++;
    }
  }
  return text.length;
}

/** Index after the tag opening at `at`, skipping quoted attribute values. */
function tagEnd(text: string, at: number): number {
  let j = at + 1;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === '>') return j + 1;
    j = c === '"' || c === "'" ? stringEnd(text, j) : j + 1;
  }
  return text.length;
}

/** SQL text spans of comment-stripped CFML: `<cfquery>` bodies and the literals given to queryExecute, `sql=` or setSql. */
function sqlSpans(text: string): SqlSpan[] {
  const spans: SqlSpan[] = [];
  for (const m of text.matchAll(/<cfquery\b/gi)) {
    const start = tagEnd(text, m.index);
    const close = text.slice(start).search(/<\/cfquery/i);
    spans.push({ start, end: close < 0 ? text.length : start + close, tag: true });
  }
  for (const m of text.matchAll(/(?:\bqueryExecute\s*\(\s*|\bsql\s*=\s*|\bsetSql\s*\(\s*)(["'])/gi)) {
    const quoteAt = m.index + m[0].length - 1;
    spans.push({ start: quoteAt + 1, end: Math.max(quoteAt + 1, stringEnd(text, quoteAt) - 1), tag: false });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** `text` with `[from, to)` overwritten by `fill`, newlines kept so offsets and lines stay valid. */
function blank(text: string, from: number, to: number, fill = ' '): string {
  return text.slice(0, from) + text.slice(from, to).replace(/[^\r\n]/g, fill) + text.slice(to);
}

/** Script-literal SQL with each doubled `quote` (CFML's escape of one quote) made a space and the quote; `#…#` untouched. */
function unescapeQuotes(sql: string, quote: string): string {
  let s = sql;
  for (let i = 0; i < s.length; ) {
    const c = s.charAt(i);
    if (c === quote && s.charAt(i + 1) === quote) {
      s = blank(s, i, i + 1);
      i += 2;
    } else if (c === '#') {
      i = s.charAt(i + 1) === '#' ? i + 2 : hashEnd(s, i + 1);
    } else {
      i++;
    }
  }
  return s;
}

/**
 * SQL of one span with offsets kept: CFML tags blanked, `#…#` expressions turned into `_` runs (so a dynamic table
 * never resolves), SQL string literals emptied and `--` and block comments blanked.
 */
function sanitiseSql(sql: string, tag: boolean): string {
  let s = sql;
  if (tag) {
    for (let i = s.search(/<\/?cf/i); i >= 0; ) {
      const end = tagEnd(s, i);
      s = blank(s, i, end);
      const next = s.slice(end).search(/<\/?cf/i);
      i = next < 0 ? -1 : end + next;
    }
  }
  for (let i = 0; i < s.length; ) {
    if (s.charAt(i) !== '#') {
      i++;
    } else if (s.charAt(i + 1) === '#') {
      i += 2;
    } else {
      const end = hashEnd(s, i + 1);
      s = blank(s, i, end, '_');
      i = end;
    }
  }
  for (let i = 0; i < s.length; ) {
    const c = s.charAt(i);
    if (c === "'") {
      let j = i + 1;
      while (j < s.length && !(s.charAt(j) === "'" && s.charAt(j + 1) !== "'")) j += s.charAt(j) === "'" ? 2 : 1;
      s = blank(s, i + 1, j);
      i = j + 1;
    } else if (c === '-' && s.charAt(i + 1) === '-') {
      const eol = s.indexOf('\n', i);
      const end = eol < 0 ? s.length : eol;
      s = blank(s, i, end);
      i = end;
    } else if (c === '/' && s.charAt(i + 1) === '*') {
      const close = s.indexOf('*/', i + 2);
      const end = close < 0 ? s.length : close + 2;
      s = blank(s, i, end);
      i = end;
    } else {
      i++;
    }
  }
  return s;
}

const IDENT = String.raw`(?:\[[^\]\r\n]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){1,2}`;
const PREDICATE = new RegExp(String.raw`(?<![\w$.\]])(${QUALIFIED})\s*=(?!=)\s*(${QUALIFIED})(?![\w$.[(])`, 'g');
/** `x [NOT] IN (SELECT [DISTINCT] y FROM …`: a semi-join of column `x` to the subquery's column `y`. */
const SEMI_JOIN = new RegExp(
  String.raw`(?<![\w$.\]])(${QUALIFIED}|${IDENT})\s+(?:not\s+)?in\s*\(\s*select\s+(?:distinct\s+)?(${QUALIFIED}|${IDENT})\s+from\s`,
  'gi',
);
const QUALIFIED_REF = new RegExp(String.raw`^${QUALIFIED}$`);
const TABLE_REF = new RegExp(String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`, 'y');
const ALIAS = new RegExp(String.raw`(?:as\s+)?(${IDENT})`, 'iy');
const FROM_OR_JOIN = /\b(from|join)\b/gi;
const SQL_WORDS: ReadonlySet<string> = new Set(
  (
    'all and apply as asc between by case cross delete desc else end except exists fetch for from full go group having ' +
    'in inner insert intersect into is join left like limit merge natural nolock not null offset on option or order ' +
    'outer output pivot returning right select set straight_join tablesample then top union unpivot update using values ' +
    'when where window with'
  ).split(' '),
);

function unbracket(part: string): string {
  return part.trim().replace(/^\[|\]$/g, '');
}

/** Lookup key of a table reference as SQL spells it: brackets and the `dbo` schema dropped. */
function sqlTableKey(ref: string): string {
  const parts = ref.split('.').map(unbracket).filter((p) => lower(p) !== 'dbo');
  return tableKey(parts.join('.'));
}

function skipSpace(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s.charAt(j))) j++;
  return j;
}

/** Index after the parenthesis group opening at `at`. */
function parenEnd(s: string, at: number): number {
  let depth = 0;
  for (let j = at; j < s.length; j++) {
    if (s.charAt(j) === '(') depth++;
    else if (s.charAt(j) === ')' && --depth === 0) return j + 1;
  }
  return s.length;
}

/** Skips table hints: `with (nolock)` or a bare `(nolock)`. */
function skipHints(s: string, i: number): number {
  let j = skipSpace(s, i);
  const withHint = /^with\s*\(/i.exec(s.slice(j, j + 12));
  if (withHint !== null) return skipSpace(s, parenEnd(s, j + withHint[0].length - 1));
  if (s.charAt(j) === '(') j = skipSpace(s, parenEnd(s, j));
  return j;
}

/**
 * Aliases of the `FROM` lists and `JOIN` items of one span, lower-cased, to their table keys. A derived table, or an
 * alias bound to two tables, maps to null and resolves to nothing. `tables`, when given, collects every table key named.
 */
function aliasesOf(sql: string, tables?: Set<string>): Map<string, string | null> {
  const aliases = new Map<string, string | null>();
  const bind = (alias: string, table: string | null): void => {
    const key = lower(unbracket(alias));
    const held = aliases.get(key);
    aliases.set(key, held === undefined || held === table ? table : null);
  };
  for (const m of sql.matchAll(FROM_OR_JOIN)) {
    let i = m.index + m[0].length;
    for (;;) {
      i = skipSpace(sql, i);
      let table: string | null = null;
      if (sql.charAt(i) === '(') {
        i = parenEnd(sql, i);
      } else {
        TABLE_REF.lastIndex = i;
        const ref = TABLE_REF.exec(sql);
        if (ref === null || SQL_WORDS.has(lower(ref[0]))) break;
        table = sqlTableKey(ref[0]);
        tables?.add(table);
        i = TABLE_REF.lastIndex;
      }
      i = skipHints(sql, i);
      ALIAS.lastIndex = i;
      const alias = ALIAS.exec(sql);
      if (alias?.[1] !== undefined && !SQL_WORDS.has(lower(unbracket(alias[1])))) {
        bind(alias[1], table);
        i = skipHints(sql, ALIAS.lastIndex);
      }
      if (lower(m[1] ?? '') !== 'from' || sql.charAt(skipSpace(sql, i)) !== ',') break;
      i = skipSpace(sql, i) + 1;
    }
  }
  return aliases;
}

/** 1-based line lookup over one text. */
function lineIndex(text: string): (offset: number) => number {
  const breaks: number[] = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) breaks.push(i);
  return (offset) => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((breaks[mid] ?? Infinity) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

interface JoinSide {
  table: TableEntry;
  column: string;
}

/** Table and column one side of a predicate names, through the span's aliases or a bare inventoried table name. */
function joinSide(ref: string, aliases: ReadonlyMap<string, string | null>, tables: ReadonlyMap<string, TableEntry>): JoinSide | null {
  const parts = ref.split('.').map(unbracket);
  const column = parts.at(-1) ?? '';
  const qualifier = parts.slice(0, -1);
  const bound = qualifier.length === 1 ? aliases.get(lower(qualifier[0] ?? '')) : undefined;
  if (bound === null) return null;
  const table = tables.get(bound ?? sqlTableKey(qualifier.join('.')));
  return table === undefined ? null : { table, column: columnCase(table, column) };
}

/** One side of a semi-join: a qualified reference as {@link joinSide} reads it, else the only `scope` table with the column. */
function semiJoinSide(
  ref: string,
  scope: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string | null>,
  tables: ReadonlyMap<string, TableEntry>,
): JoinSide | null {
  if (QUALIFIED_REF.test(ref)) return joinSide(ref, aliases, tables);
  const column = unbracket(ref);
  if (SQL_WORDS.has(lower(column))) return null;
  const [only, ...more] = [...scope].flatMap((key) => {
    const table = tables.get(key);
    return table?.columns.some((c) => lower(c.name) === lower(column)) === true ? [table] : [];
  });
  return only === undefined || more.length > 0 ? null : { table: only, column: columnCase(only, column) };
}

/** Lower-cased key columns per table key: the sole primary key, and every key the table's entities declare. */
function keyColumns(model: Model): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>();
  const add = (table: string, column: string): void => {
    const key = tableKey(table);
    keys.set(key, (keys.get(key) ?? new Set()).add(lower(column)));
  };
  for (const t of model.tables.values()) {
    const sole = soleKey(t);
    if (sole !== null) add(t.table, sole);
  }
  for (const e of model.entities) for (const k of model.target(e).keys) add(e.table ?? '', k);
  return keys;
}

/** A join edge oriented child → parent: the side whose column is a key of its table is the parent. */
function joinRelation(a: JoinSide, b: JoinSide, keys: ReadonlyMap<string, ReadonlySet<string>>, source: RelationSource): Relation {
  const isKey = (s: JoinSide): boolean => keys.get(tableKey(s.table.table))?.has(lower(s.column)) === true;
  const label = (s: JoinSide): string => lower(`${s.table.table}.${s.column}`);
  let child = a;
  let parent = b;
  let orientation: Orientation = 'primary-key';
  if (isKey(a) && !isKey(b)) {
    child = b;
    parent = a;
  } else if (isKey(a) === isKey(b)) {
    orientation = 'unknown';
    [child, parent] = compareText(label(a), label(b)) <= 0 ? [a, b] : [b, a];
  }
  const tableKeyed = lower(soleKey(parent.table) ?? '') === lower(parent.column);
  const basis: ParentKeyBasis = orientation === 'unknown' ? 'join' : tableKeyed ? 'table-key' : 'entity-key';
  return relation({
    kind: 'dao-join',
    child: { table: child.table.table, columns: [child.column] },
    parent: { table: parent.table.table, columns: [parent.column] },
    source,
    cfc: null,
    cardinality: null,
    orientation,
    parentKey: { basis, component: null },
    tenantDerivation: derivesTenant(child.table.hasSiteId, orientation),
  });
}

function daoJoinsOf(model: Model): Relation[] {
  const keys = keyColumns(model);
  const out: Relation[] = [];
  for (const file of model.tree.list(ENTITY_SCAN_ROOT, { ext: ['cfc'], recursive: true })) {
    const text = stripComments(model.tree.readText(file));
    const lineAt = lineIndex(text);
    for (const span of sqlSpans(text)) {
      const body = text.slice(span.start, span.end);
      const sql = sanitiseSql(span.tag ? body : unescapeQuotes(body, text.charAt(span.start - 1)), span.tag);
      const aliases = aliasesOf(sql);
      const record = (a: JoinSide | null, b: JoinSide | null, at: number): void => {
        if (a === null || b === null || sameColumn({ table: a.table.table, column: a.column }, { table: b.table.table, column: b.column })) {
          return;
        }
        out.push(joinRelation(a, b, keys, point(file, lineAt(span.start + at))));
      };
      for (const m of sql.matchAll(PREDICATE)) {
        record(joinSide(m[1] ?? '', aliases, model.tables), joinSide(m[2] ?? '', aliases, model.tables), m.index);
      }
      for (const m of sql.matchAll(SEMI_JOIN)) {
        const outerRef = m[1] ?? '';
        const open = sql.indexOf('(', m.index + outerRef.length);
        const close = parenEnd(sql, open);
        const inner = new Set<string>();
        const outer = new Set<string>();
        aliasesOf(sql.slice(open + 1, close), inner);
        aliasesOf(blank(sql, open, close), outer);
        record(semiJoinSide(outerRef, outer, aliases, model.tables), semiJoinSide(m[2] ?? '', inner, aliases, model.tables), m.index);
      }
    }
  }
  return out;
}

/**
 * Join predicates `a.x = b.y` in the comment-stripped SQL of every `core/mura/**.cfc`: `JOIN … ON` items and
 * old-style comma joins, with aliases resolved, and `x [NOT] IN (SELECT y FROM …)` semi-joins, whose unqualified column
 * belongs to the only table in its scope that has it. Only pairs of inventoried tables are kept; each edge keeps its
 * lowest `(path, line)`. `entities` adds their declared keys to the tables' own for orientation.
 */
export function extractDaoJoins(tree: SourceTree, tables: readonly TableEntry[], entities: readonly EntityEntry[] = []): Relation[] {
  return bestPerId(daoJoinsOf(createModel(tree, entities, ormEntityIndex(entities), tables)));
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture relations
// ---------------------------------------------------------------------------------------------------------------

const keyList = z.array(z.string().min(1));

/** The key fields of a fixture or tenant-parent entry that `tableOwnershipSchema` passes through unvalidated. */
const fixtureEntrySchema = z.looseObject({
  table: z.string().min(1),
  primaryKey: keyList.optional(),
  columns: keyList.optional(),
  hasSiteId: z.boolean().nullable().optional(),
  tenantParent: z.looseObject({ table: z.string().min(1), join: z.string().min(1) }).optional(),
  source: z
    .looseObject({ path: z.string().min(1), lines: z.tuple([z.int().min(1), z.int().min(1)]).nullable().optional() })
    .optional(),
});

type FixtureEntry = z.infer<typeof fixtureEntrySchema>;

function schemaOf(table: string): string {
  return lower(table.slice(0, Math.max(0, table.indexOf('.'))));
}

/** A program table may refer to its own program schema or to `synthetic`; a synthetic table only to `synthetic`. */
function inScope(child: string, parent: string): boolean {
  return schemaOf(parent) === 'synthetic' || schemaOf(parent) === schemaOf(child);
}

/** The entry's stated source; its lines, or `[1, 1]` where the file states none. */
function entrySource(entry: FixtureEntry): RelationSource {
  if (entry.source === undefined) return { path: OWNERSHIP_FILE, lines: NO_LINE };
  const lines = entry.source.lines;
  return { path: entry.source.path, lines: lines === null || lines === undefined ? NO_LINE : [lines[0], lines[1]] };
}

function fixtureRelation(child: FixtureEntry, childColumn: string, parent: FixtureEntry, parentColumn: string): Relation {
  return relation({
    kind: 'fixture-fk',
    child: { table: child.table, columns: [childColumn] },
    parent: { table: parent.table, columns: [parentColumn] },
    source: entrySource(child),
    cfc: null,
    cardinality: null,
    orientation: 'declared',
    parentKey: { basis: 'ownership', component: null },
    tenantDerivation: derivesTenant(child.hasSiteId, 'declared'),
  });
}

/** Child and parent columns of a stated `tenantParent.join` (`<child>.<col> = <parent>.<col>`), in either order. */
function tenantParentColumns(entry: FixtureEntry, parentTable: string): { child: string; parent: string } | null {
  const sides = (entry.tenantParent?.join ?? '').split('=').map((s) => s.trim());
  if (sides.length !== 2) return null;
  const split = (side: string): { table: string; column: string } => ({
    table: lower(side.slice(0, Math.max(0, side.lastIndexOf('.')))),
    column: side.slice(side.lastIndexOf('.') + 1),
  });
  const [a, b] = sides.map(split) as [{ table: string; column: string }, { table: string; column: string }];
  const own = lower(entry.table);
  const other = lower(parentTable);
  if (a.table === own && b.table === other) return { child: a.column, parent: b.column };
  if (b.table === own && a.table === other) return { child: b.column, parent: a.column };
  return null;
}

/**
 * `fixture-fk` edges of the `synthetic.*` and `Program_N.*` entries of the ownership file, from their stated key
 * fields only: a `tenantParent.join`, and each column that is the sole `primaryKey` of another fixture table in scope.
 * Each program table also gets its `program-fold` edge to `synthetic.program_site` when that entry states its key.
 * An entry without stated key columns yields nothing. Table names are kept as the file states them.
 */
export function fixtureRelations(ownership: FixtureOwnership): Relation[] {
  const entries = ownership.tables.filter((t) => FIXTURE_TABLE.test(t.table)).map((t) => fixtureEntrySchema.parse(t));
  const byName = new Map(entries.map((e) => [lower(e.table), e]));
  const parentsByKey = new Map<string, FixtureEntry[]>();
  for (const e of entries) {
    const key = e.primaryKey?.length === 1 ? e.primaryKey[0] : undefined;
    if (key !== undefined) parentsByKey.set(lower(key), [...(parentsByKey.get(lower(key)) ?? []), e]);
  }
  const out: Relation[] = [];
  for (const child of entries) {
    const stated = child.tenantParent === undefined ? undefined : byName.get(lower(child.tenantParent.table));
    const join = stated === undefined ? null : tenantParentColumns(child, stated.table);
    if (stated !== undefined && join !== null) out.push(fixtureRelation(child, join.child, stated, join.parent));
    for (const column of child.columns ?? []) {
      for (const parent of parentsByKey.get(lower(column)) ?? []) {
        if (parent !== child && inScope(child.table, parent.table)) out.push(fixtureRelation(child, column, parent, parent.primaryKey?.[0] ?? column));
      }
    }
  }
  const site = byName.get(PROGRAM_SITE_TABLE);
  const siteKey = site?.primaryKey?.length === 1 ? site.primaryKey[0] : undefined;
  if (site !== undefined && siteKey !== undefined) {
    for (const program of entries.filter((e) => PROGRAM_TABLE.test(e.table))) {
      out.push(
        relation({
          kind: 'program-fold',
          child: { table: program.table, columns: null },
          parent: { table: site.table, columns: [siteKey] },
          source: entrySource(site),
          cfc: null,
          cardinality: null,
          orientation: 'declared',
          parentKey: { basis: 'ownership', component: null },
          tenantDerivation: true,
        }),
      );
    }
  }
  return bestPerId(out);
}

/**
 * `tenant-parent` edges of the ownership file's Masa entries: each stated `tenantParent.join`, from the child to the
 * parent whose row gives it its tenant (`tenantResolution: parent:<table>`), sourced at the child entry. A code
 * relation of the same columns takes precedence in {@link extractRelations}.
 */
export function tenantParentRelations(ownership: FixtureOwnership): Relation[] {
  const out: Relation[] = [];
  for (const raw of ownership.tables) {
    if (FIXTURE_TABLE.test(raw.table) || raw.tenantParent === undefined) continue;
    const child = fixtureEntrySchema.parse(raw);
    const parent = child.tenantParent?.table ?? '';
    const join = tenantParentColumns(child, parent);
    if (join === null) continue;
    out.push(
      relation({
        kind: 'tenant-parent',
        child: { table: child.table, columns: [join.child] },
        parent: { table: parent, columns: [join.parent] },
        source: entrySource(child),
        cfc: null,
        cardinality: null,
        orientation: 'declared',
        parentKey: { basis: 'ownership', component: null },
        tenantDerivation: derivesTenant(child.hasSiteId, 'declared'),
      }),
    );
  }
  return bestPerId(out);
}

// ---------------------------------------------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------------------------------------------

/** `r` with inventory table names and column spelling, its id recomputed and its tenant derivation from `child`. */
function canonical(r: Relation, child: TableEntry, parent: TableEntry): Relation {
  const { id: _stale, ...fields } = r;
  return relation({
    ...fields,
    child: { table: child.table, columns: r.child.columns === null ? null : r.child.columns.map((c) => columnCase(child, c)) },
    parent: { table: parent.table, columns: r.parent.columns.map((c) => columnCase(parent, c)) },
    tenantDerivation: r.kind === 'program-fold' || derivesTenant(child.hasSiteId, r.orientation),
  });
}

/** Unordered endpoint pair of an edge. */
function endpoints(r: Relation): string {
  const ends = [
    `${tableKey(r.child.table)}.${lower((r.child.columns ?? []).join(','))}`,
    `${tableKey(r.parent.table)}.${lower(r.parent.columns.join(','))}`,
  ].sort(compareText);
  return ends.join('|');
}

/**
 * The deduplicated union of the ORM, DAO-join, fixture and tenant-parent relations, each list sorted by id. Edges are
 * re-keyed to the inventory's table names; one touching a table the inventory does not list is dropped and counted.
 * Join edges of unknown orientation go to `unoriented`, except where an oriented edge joins the same two columns.
 */
export function extractRelations(inputs: RelationInputs): RelationExtraction {
  const { entities, tables, tree, ownership } = inputs;
  const model = createModel(tree, entities, inputs.index ?? ormEntityIndex(entities), tables);
  const dropped = new Set<string>();
  const kept: Relation[] = [];
  for (const r of [...ormRelationsOf(model), ...daoJoinsOf(model), ...fixtureRelations(ownership), ...tenantParentRelations(ownership)]) {
    const child = model.tables.get(tableKey(r.child.table));
    const parent = model.tables.get(tableKey(r.parent.table));
    if (child === undefined || parent === undefined) dropped.add(r.id);
    else kept.push(canonical(r, child, parent));
  }
  const unique = bestPerId(kept);
  // dependency-order.ts reads every relations[] entry as child → parent, so an edge with no key side stays out of it.
  const relations = unique.filter((r) => r.orientation !== 'unknown');
  const oriented = new Set(relations.map(endpoints));
  const unoriented = unique.filter((r) => r.orientation === 'unknown' && !oriented.has(endpoints(r)));
  const count = (kind: RelationKind): number => relations.filter((r) => r.kind === kind).length;
  return {
    relations,
    unoriented,
    counts: {
      relations: relations.length,
      ormFk: count('orm-fk'),
      daoJoin: count('dao-join'),
      fixtureFk: count('fixture-fk'),
      programFold: count('program-fold'),
      tenantParent: count('tenant-parent'),
      unknownOrientation: unoriented.length,
      relationsDropped: dropped.size,
    },
    dropped: [...dropped].sort(compareText),
  };
}
