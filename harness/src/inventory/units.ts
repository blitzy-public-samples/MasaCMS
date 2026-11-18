// Resolves closure writes to the target-table units of opt2/table-ownership.json and records an item's write facts in
// the form the cut-over loader reads: one record per unit a write reaches, one per guarded write, unresolved calls deduplicated.
import path from 'node:path';
import {
  parseAttributes,
  sqlSpans,
  stripComments,
  type CfmlFunction,
  type ClosureWrite,
  type ComponentIndex,
  type ConditionalWrite,
  type FileStoreEvidence,
  type SourceTree,
  type UnresolvedRef,
} from './closure.js';
import {
  FILE_STORE_TABLE,
  ownershipEntryOf,
  parseRowPredicate,
  selectedByClassOwner,
  splitTargets,
  type OwnershipTarget,
  type SplitCoWrites,
  type VariantPredicates,
  type WriteSetOwners,
} from './disposition.js';
import type { SourceRef, WriterOverrides } from './overrides.js';
import { tableKey, type TableOwnership } from './tables.js';

/** Repository path of the reviewed writer overrides, as write and call records reference them. */
export const WRITER_OVERRIDES_REF = 'harness/inventory/writer-overrides.yaml';

/** Unit of a write to Masa's file store. */
export const FILE_STORE_UNIT = 'file-store';

/** Prefix of the unit of a written table that maps to no target unit: decision-list, retired or target-less. */
export const LEGACY_UNIT_PREFIX = 'legacy:';

/** Condition of a file-store write reached only under a guard the branch's request does not decide. */
export const UNDECIDED_FILE_STORE_GUARD = 'reached only under a guard the request predicates do not decide';

const USERS_TABLE = 'tusers';
const TYPE_COLUMN = 'type';
/** `tusers.Type` of a user row; group rows are Type 1. */
const USER_ROW_TYPE = '2';
const OWNER_ROW_PREDICATE = /^\s*owner\s/i;
const LOOKUP_DIRS: readonly string[] = ['admin', 'core'];

// Types

/** One target unit a closure write reaches. */
export interface InventoryWrite {
  unit: string;
  /** Inventory name of the written table; null for the file store. */
  legacyTable: string | null;
  op: string;
  via: string[];
  source: SourceRef;
  /** Undecided guards of a data-dependent write; null when a recorded path reaches it unconditionally. */
  condition: string | null;
  /** `harness/inventory/writer-overrides.yaml#<id>` of the override the write comes from. */
  override: string | null;
}

/** A write whose guard never holds on the item's branch, kept out of its write set. */
export interface InventoryConditionalWrite {
  kind: string;
  /** The one unit the write resolves to; null when it resolves to several or its table has no ownership entry. */
  unit: string | null;
  legacyTable: string | null;
  op: string | null;
  via: string[];
  source: SourceRef;
  guard: string;
}

/** A call the closure could not follow; `override` names the reviewed record whose span settles it. */
export interface InventoryUnresolvedCall {
  call: string;
  via: string[];
  source: SourceRef;
  override: string | null;
}

/** The write facts an inventoried item records. */
export interface ItemWriteFacts {
  writeSet: InventoryWrite[];
  conditionalWrites: InventoryConditionalWrite[];
  unresolvedCalls: InventoryUnresolvedCall[];
}

/** The write evidence of an item's closure. */
export interface WriteEvidenceSet {
  writes: readonly ClosureWrite[];
  conditionalWrites: readonly ConditionalWrite[];
  fileStoreEvidence: readonly FileStoreEvidence[];
  unresolved: readonly UnresolvedRef[];
}

/** Branch facts beyond the closure: its request predicates and whether its owner depends on stored data. */
export interface BranchFacts {
  predicates: VariantPredicates;
  storedDataOwner: boolean;
}

/** Kind and reason of the guard a write runs under on every path its closure records; undefined when a path has none. */
export type GuardOf = (w: ClosureWrite, conditionalWrites: readonly ConditionalWrite[]) => { kind: string; guard: string } | undefined;

/** An item's recorded write facts plus what its disposition reads. */
export interface ProjectedWrites extends ItemWriteFacts {
  /** The item's tables less those every write of which runs under a guard. */
  tables: string[];
  /** Owners of the resolved units, file store included, and the decision-list tables written. */
  owners: WriteSetOwners;
}

/** A unit a write resolves to, its owner (null for a legacy unit with none) and whether its table is on the decision list. */
interface ResolvedUnit {
  unit: string;
  owner: string | null;
  decision: boolean;
}

/** What a branch's writes are resolved against. */
interface Branch {
  request: ReadonlyMap<string, string | boolean | null>;
  written: ReadonlySet<string>;
  /** Owners of the co-written tables, split tables other than class-owner ones counted with their resolved targets. */
  coOwners: ReadonlySet<string>;
  /** `Type` values of the tusers rows the branch writes: empty when it writes none, null when one is undetermined. */
  userTypes: readonly string[] | null;
  storedDataOwner: boolean;
}

type OwnershipEntry = TableOwnership['tables'][number];

// Row-type evidence

const FIRST_FROM_TUSERS = /^\s*select\b(?:(?!\bfrom\b)[\s\S])*\bfrom\s+(?:\[?dbo\]?\s*\.\s*)?\[?tusers\]?(?![\w$])/i;
const TYPE_LITERAL = /(?<![\w$.])(?:\[?tusers\]?\s*\.\s*)?\[?type\]?\s*=\s*'?(\d+)'?(?![\w$])/gi;

/** `Type` literals the `tusers` reads of a function body filter on, as in `SELECT * FROM tusers WHERE … AND Type = 2`. */
export function tusersReadTypes(body: string): string[] {
  const text = stripComments(body);
  const types = new Set<string>();
  for (const span of sqlSpans(text)) {
    const sql = text.slice(span.start, span.end).replace(/<\/?cf[^>]*>/gi, ' ');
    if (!FIRST_FROM_TUSERS.test(sql)) continue;
    const where = /\bwhere\b([\s\S]*)$/i.exec(sql)?.[1] ?? '';
    for (const m of where.matchAll(TYPE_LITERAL)) if (m[1] !== undefined) types.add(m[1]);
  }
  return [...types].sort();
}

const ARGUMENT_VALUE = /\barguments\s*\./i;
const NON_PARAM_CF_TAG = /<\/?cf(?!queryparam\b)[^>]*>/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The functions of `functions` other than `self` that its body calls unqualified, as in `rs=getUserByEmail(…)`. */
function calledUnqualified(self: CfmlFunction, functions: readonly CfmlFunction[]): CfmlFunction[] {
  const body = stripComments(self.body);
  return functions.filter((g) => g !== self && new RegExp(String.raw`(?<![\w$.])${escapeRegExp(g.name)}\s*\(`, 'i').test(body));
}

/** Top-level comma-separated items of `text` from `from` to the `)` closing the list, or null when none closes it. */
function listItems(text: string, from: number): { items: string[]; end: number } | null {
  const items: string[] = [];
  let depth = 0;
  let start = from;
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth === 0) return { items: [...items, text.slice(start, i).trim()], end: i + 1 };
      depth--;
    } else if (c === ',' && depth === 0) {
      items.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** The value a SQL operand binds: a `<cfqueryparam>`'s `value` attribute, else the operand text up to its end. */
function boundValue(operand: string): string {
  const param = /^\s*<cfqueryparam\b/i.exec(operand);
  if (param === null) return /^[^\s)<]*/.exec(operand.trimStart())?.[0] ?? '';
  let quote = '';
  let i = param[0].length;
  for (; i < operand.length; i++) {
    const c = operand.charAt(i);
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      break;
    }
  }
  return parseAttributes(operand.slice(param[0].length, i).replace(/\/\s*$/, '')).value ?? '';
}

/**
 * Whether the `insert`, `update` or `delete` of `table` in SQL `text` binds every `key` column to a value drawn from
 * the call's arguments, so it touches only the row of the object it was called for: false when a key is bound to
 * another value (a column of a query row it loops over) or not bound (a delete by siteid, an insert from a select);
 * null when `text` holds no such statement.
 */
export function statementKeysOneRow(text: string, op: string, table: string, key: readonly string[]): boolean | null {
  const sql = text.replace(NON_PARAM_CF_TAG, ' ');
  const target = String.raw`(?:\[?dbo\]?\s*\.\s*)?\[?${escapeRegExp(table)}\]?(?![\w$])`;
  if (op === 'insert') {
    const m = new RegExp(String.raw`\binsert\s+into\s+${target}\s*\(`, 'i').exec(sql);
    if (m === null) return null;
    const columns = listItems(sql, m.index + m[0].length);
    if (columns === null) return null;
    const values = /^\s*values\s*\(/i.exec(sql.slice(columns.end));
    const bound = values === null ? null : listItems(sql, columns.end + values[0].length);
    if (bound === null) return false;
    const names = columns.items.map((c) => c.replace(/[[\]`"]/g, '').trim().toLowerCase());
    return key.every((k) => {
      const at = names.indexOf(k);
      return at >= 0 && ARGUMENT_VALUE.test(boundValue(bound.items[at] ?? ''));
    });
  }
  if (op !== 'update' && op !== 'delete') return null;
  const head = op === 'update' ? String.raw`\bupdate\s+${target}\s+set\b` : String.raw`\bdelete\s+(?:from\s+)?${target}`;
  const m = new RegExp(head, 'i').exec(sql);
  if (m === null) return null;
  const rest = sql.slice(m.index + m[0].length);
  const where = /\bwhere\b/i.exec(rest);
  if (where === null) return false;
  const clause = rest.slice(where.index + where[0].length);
  return key.every((k) => {
    const eq = new RegExp(String.raw`(?<![\w$])(?:\[?[\w$]+\]?\s*\.\s*)?\[?${escapeRegExp(k)}\]?\s*=\s*`, 'i').exec(clause);
    return eq !== null && ARGUMENT_VALUE.test(boundValue(clause.slice(eq.index + eq[0].length)));
  });
}

/**
 * Lookups over the source a write's row identity is read from. `typeOn` gives the row `Type` of the tusers row a write
 * keys on, read from the call path: the nearest function on `via` whose own tusers read, else that of a same-component
 * function it calls unqualified, filters on a single `Type` literal selected that row, as the login lookups select the
 * session user and `getUserByEmail` the forgot-password user by `Type = 2`.
 */
export class RowTypeLookups {
  private files: Map<string, string[]> | null = null;
  private readonly byLabel = new Map<string, string | null>();
  private readonly lines = new Map<string, string[]>();

  constructor(
    private readonly tree: SourceTree,
    private readonly index: ComponentIndex,
  ) {}

  /**
   * Whether the statement at a write's source binds the table's `key` columns to the call's arguments
   * ({@link statementKeysOneRow}); null when no key is known or the source holds no such statement.
   */
  keysOneRow(write: Pick<ClosureWrite, 'table' | 'op' | 'source'>, key: readonly string[]): boolean | null {
    if (write.table === null || key.length === 0 || !this.tree.exists(write.source.path)) return null;
    let lines = this.lines.get(write.source.path);
    if (lines === undefined) {
      lines = stripComments(this.tree.readText(write.source.path)).split('\n');
      this.lines.set(write.source.path, lines);
    }
    const [from, to] = write.source.lines;
    return statementKeysOneRow(lines.slice(from - 1, to).join('\n'), write.op, write.table, key);
  }

  /** `Type` of the nearest lookup on `via`, or null when no function on it filters tusers on one literal. */
  typeOn(via: readonly string[]): string | null {
    for (let i = via.length - 1; i >= 0; i--) {
      const type = this.typeOf(via[i] ?? '');
      if (type !== null) return type;
    }
    return null;
  }

  private typeOf(label: string): string | null {
    const cached = this.byLabel.get(label);
    if (cached !== undefined) return cached;
    const dot = label.lastIndexOf('.');
    const types = new Set<string>();
    if (dot > 0) {
      const fn = label.slice(dot + 1).toLowerCase();
      for (const file of this.filesByBase().get(label.slice(0, dot).toLowerCase()) ?? []) {
        const functions = this.index.parsed(file)?.functions ?? [];
        const found = functions.find((f) => f.name.toLowerCase() === fn);
        if (found === undefined) continue;
        const own = tusersReadTypes(found.body);
        const read = own.length > 0 ? own : calledUnqualified(found, functions).flatMap((g) => tusersReadTypes(g.body));
        for (const type of read) types.add(type);
      }
    }
    const [only] = types;
    const type = types.size === 1 && only !== undefined ? only : null;
    this.byLabel.set(label, type);
    return type;
  }

  private filesByBase(): Map<string, string[]> {
    if (this.files === null) {
      const files = new Map<string, string[]>();
      for (const file of LOOKUP_DIRS.flatMap((dir) => this.tree.list(dir, { ext: ['cfc'], recursive: true }))) {
        const base = path.posix.basename(file).replace(/\.cfc$/i, '').toLowerCase();
        files.set(base, [...(files.get(base) ?? []), file]);
      }
      this.files = files;
    }
    return this.files;
  }
}

// Resolution

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function overrideRef(id: string): string {
  return `${WRITER_OVERRIDES_REF}#${id}`;
}

function ownedColumns(target: OwnershipTarget): string[] {
  const columns: unknown = (target as { ownedColumns?: unknown }).ownedColumns;
  return Array.isArray(columns) ? columns.filter((c): c is string => typeof c === 'string').map((c) => c.toLowerCase()) : [];
}

/** Lower-cased primary-key columns an ownership entry records; empty when it records none. */
function primaryKeyOf(entry: OwnershipEntry): string[] {
  const key: unknown = (entry as { primaryKey?: unknown }).primaryKey;
  return Array.isArray(key) ? key.filter((c): c is string => typeof c === 'string').map((c) => c.toLowerCase()) : [];
}

function typeValues(target: OwnershipTarget): string[] | null {
  const predicate = parseRowPredicate(target.rowPredicate);
  return predicate !== null && 'column' in predicate && predicate.column === TYPE_COLUMN ? predicate.values : null;
}

/** `pool` filtered by `keep`, or the whole pool when nothing is kept. */
function narrowed(pool: readonly OwnershipTarget[], keep: (t: OwnershipTarget) => boolean): OwnershipTarget[] {
  const kept = pool.filter(keep);
  return kept.length > 0 ? kept : [...pool];
}

function sameSpan(a: SourceRef, b: SourceRef): boolean {
  return a.path === b.path && a.lines[0] === b.lines[0] && a.lines[1] === b.lines[1];
}

function sortKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

function compareWrites(a: InventoryWrite, b: InventoryWrite): number {
  return (
    compareText(a.unit, b.unit) ||
    compareText(a.legacyTable ?? '', b.legacyTable ?? '') ||
    compareText(a.op, b.op) ||
    compareText(a.source.path, b.source.path) ||
    a.source.lines[0] - b.source.lines[0] ||
    a.source.lines[1] - b.source.lines[1] ||
    Number(a.condition !== null) - Number(b.condition !== null) ||
    compareText(a.via.join('\n'), b.via.join('\n')) ||
    compareText(a.override ?? '', b.override ?? '') ||
    compareText(a.condition ?? '', b.condition ?? '')
  );
}

function compareConditional(a: InventoryConditionalWrite, b: InventoryConditionalWrite): number {
  return compareText(a.unit ?? '', b.unit ?? '') || compareGuardedWrite(a, b);
}

/** Order of guarded writes regardless of unit: table, op, source, kind, then call path. */
function compareGuardedWrite(a: InventoryConditionalWrite, b: InventoryConditionalWrite): number {
  return (
    compareText(a.legacyTable ?? '', b.legacyTable ?? '') ||
    compareText(a.op ?? '', b.op ?? '') ||
    compareText(a.source.path, b.source.path) ||
    a.source.lines[0] - b.source.lines[0] ||
    a.source.lines[1] - b.source.lines[1] ||
    compareText(a.kind, b.kind) ||
    compareText(a.via.join('\n'), b.via.join('\n'))
  );
}

function compareCalls(a: InventoryUnresolvedCall, b: InventoryUnresolvedCall): number {
  return (
    compareText(a.source.path, b.source.path) ||
    a.source.lines[0] - b.source.lines[0] ||
    a.source.lines[1] - b.source.lines[1] ||
    compareText(a.call, b.call) ||
    compareText(a.via.join('\n'), b.via.join('\n'))
  );
}

/** The first record per key of `records` sorted by `compare`. */
function firstPerKey<T>(records: readonly T[], compare: (a: T, b: T) => number, key: (r: T) => string): T[] {
  const seen = new Set<string>();
  return [...records].sort(compare).filter((r) => {
    const k = key(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * One record per (kind, legacyTable, op, source) of per-unit guarded-write records: the first call path in code-unit
 * order, and the unit when every record of the write names the same one, else null.
 */
export function collapseConditionalWrites(records: readonly InventoryConditionalWrite[]): InventoryConditionalWrite[] {
  const byWrite = new Map<string, { first: InventoryConditionalWrite; units: Set<string | null> }>();
  for (const r of [...records].sort(compareGuardedWrite)) {
    const key = sortKey(r.kind, r.legacyTable ?? '', r.op ?? '', r.source.path, ...r.source.lines);
    const seen = byWrite.get(key);
    if (seen === undefined) byWrite.set(key, { first: r, units: new Set([r.unit]) });
    else seen.units.add(r.unit);
  }
  return [...byWrite.values()]
    .map(({ first, units }) => ({ ...first, unit: units.size === 1 ? first.unit : null }))
    .sort(compareConditional);
}

/** Operation of a file-store call: a delete or purge removes stored objects, every other call writes them. */
function fileStoreOp(method: string): string {
  return /^(delete|purge)/i.test(method) ? 'delete' : 'write';
}

/** Resolves writes to ownership units and projects item write facts; records each entry branch's units per writing component. */
export class UnitResolver {
  private readonly byComponent = new Map<string, { owners: Set<string>; decisionTables: Set<string>; tables: Set<string> }>();

  constructor(
    private readonly ownership: TableOwnership,
    private readonly overrides: WriterOverrides,
    private readonly lookups: RowTypeLookups,
  ) {}

  /**
   * Write facts of one item from its closure evidence; `tables` is the item's table list. With `record`, each resolved
   * write also counts toward its component's owners ({@link ownersOfComponent}).
   */
  project(evidence: WriteEvidenceSet, facts: BranchFacts, guardOf: GuardOf, tables: readonly string[], record = true): ProjectedWrites {
    const open: ClosureWrite[] = [];
    const guarded: Array<{ w: ClosureWrite & { table: string }; kind: string; guard: string }> = [];
    for (const w of evidence.writes) {
      if (w.table === null) continue;
      const g = guardOf(w, evidence.conditionalWrites);
      if (g === undefined) open.push(w);
      else guarded.push({ w: { ...w, table: w.table }, ...g });
    }
    const openTables = new Set(open.map((w) => tableKey(w.table ?? '')));
    const guardedOnly = new Set(guarded.map((g) => tableKey(g.w.table)).filter((key) => !openTables.has(key)));
    const kept = tables.filter((t) => !guardedOnly.has(tableKey(t)));
    const fileStore = evidence.fileStoreEvidence.length > 0;
    const branch = this.branch(fileStore ? [...kept, FILE_STORE_TABLE] : kept, open, facts);

    const owners = new Set<string>();
    const decisionTables = new Set<string>();
    const count = (table: string, units: readonly ResolvedUnit[]): void => {
      for (const u of units) {
        if (u.owner !== null) owners.add(u.owner);
        if (u.decision) decisionTables.add(table);
      }
    };
    const writes: InventoryWrite[] = [];
    for (const w of open) {
      const table = w.table ?? '';
      const units = this.unitsOf(table, w.columns, w.via, branch, w);
      count(table, units);
      if (record) this.note(w.component, table, units);
      const condition = w.conditional ? this.conditionOf(w, evidence.conditionalWrites) : null;
      const override = w.override === undefined ? null : overrideRef(w.override);
      for (const u of units) writes.push({ unit: u.unit, legacyTable: table, op: w.op, via: [...w.via], source: w.source, condition, override });
    }
    for (const e of evidence.fileStoreEvidence) {
      writes.push({
        unit: FILE_STORE_UNIT,
        legacyTable: null,
        op: e.op ?? fileStoreOp(e.method),
        via: [...e.via],
        source: e.source,
        condition: e.conditional ? UNDECIDED_FILE_STORE_GUARD : null,
        override: null,
      });
    }
    if (fileStore) count(FILE_STORE_TABLE, this.unitsOf(FILE_STORE_TABLE, null, [], branch));
    // A listed table no recorded write reaches still counts toward the owners, resolved from the branch alone.
    for (const table of kept) if (!openTables.has(tableKey(table))) count(table, this.unitsOf(table, null, [], branch));

    const conditional: InventoryConditionalWrite[] = guarded.flatMap(({ w, kind, guard }) => {
      const units: Array<string | null> =
        ownershipEntryOf(this.ownership, w.table) === undefined ? [null] : this.unitsOf(w.table, w.columns, w.via, branch, w).map((u) => u.unit);
      return units.map((unit) => ({ kind, unit, legacyTable: w.table, op: w.op, via: [...w.via], source: w.source, guard }));
    });
    const calls = evidence.unresolved.map((u): InventoryUnresolvedCall => ({ call: u.expr, via: [...u.via], source: u.source, override: this.settling(u) }));

    return {
      writeSet: firstPerKey(writes, compareWrites, (r) => sortKey(r.unit, r.legacyTable ?? '', r.op, r.source.path, ...r.source.lines)),
      conditionalWrites: collapseConditionalWrites(conditional),
      unresolvedCalls: firstPerKey(calls, compareCalls, (r) => sortKey(r.call, r.source.path, ...r.source.lines)),
      tables: kept,
      owners: { owners: [...owners].sort(compareText), decisionTables: [...decisionTables].sort(compareText) },
    };
  }

  /**
   * Owners of a component's writes: the union of the units its writes resolved to in every recorded branch, plus the
   * tables of `tables` no recorded write of it reached, resolved with `tables` as the co-written set.
   */
  ownersOfComponent(component: string, tables: readonly string[]): WriteSetOwners {
    const seen = this.byComponent.get(component);
    const owners = new Set(seen?.owners ?? []);
    const decisionTables = new Set(seen?.decisionTables ?? []);
    const branch = this.branch(tables, [], { predicates: {}, storedDataOwner: false });
    for (const table of tables) {
      if (seen?.tables.has(tableKey(table)) === true) continue;
      for (const u of this.unitsOf(table, null, [], branch)) {
        if (u.owner !== null) owners.add(u.owner);
        if (u.decision) decisionTables.add(table);
      }
    }
    return { owners: [...owners].sort(compareText), decisionTables: [...decisionTables].sort(compareText) };
  }

  /** The reviewed record whose source span holds the call's first line: a writer override, else a settled call. */
  settling(u: Pick<UnresolvedRef, 'source'>): string | null {
    const line = u.source.lines[0];
    const covers = (s: SourceRef): boolean => s.path === u.source.path && s.lines[0] <= line && line <= s.lines[1];
    const hit = [...this.overrides.writers, ...(this.overrides.settledCalls ?? [])].filter((o) => covers(o.source)).map((o) => o.id);
    const [first] = hit.sort(compareText);
    return first === undefined ? null : overrideRef(first);
  }

  private note(component: string, table: string, units: readonly ResolvedUnit[]): void {
    let acc = this.byComponent.get(component);
    if (acc === undefined) {
      acc = { owners: new Set(), decisionTables: new Set(), tables: new Set() };
      this.byComponent.set(component, acc);
    }
    acc.tables.add(tableKey(table));
    for (const u of units) {
      if (u.owner !== null) acc.owners.add(u.owner);
      if (u.decision) acc.decisionTables.add(table);
    }
  }

  /** Undecided guard texts the closure recorded for `w`, joined in code-unit order; null when it recorded none. */
  private conditionOf(w: ClosureWrite, conditionalWrites: readonly ConditionalWrite[]): string | null {
    const key = tableKey(w.table ?? '');
    const texts = [...new Set(conditionalWrites.filter((c) => tableKey(c.table) === key && sameSpan(c.source, w.source)).map((c) => c.condition))];
    return texts.length === 0 ? null : texts.sort(compareText).join(' || ');
  }

  private branch(tables: readonly string[], open: readonly ClosureWrite[], facts: BranchFacts): Branch {
    const request = new Map(Object.entries(facts.predicates).map(([name, value]) => [name.toLowerCase(), value] as const));
    const coOwners = new Set<string>();
    for (const table of tables) {
      const entry = ownershipEntryOf(this.ownership, table);
      if (entry !== undefined && !['split', 'decision-list', 'retired'].includes(entry.owner)) coOwners.add(entry.owner);
    }
    const users = ownershipEntryOf(this.ownership, USERS_TABLE);
    const requested = users === undefined ? null : this.requestedType(users, request);
    const types = new Set<string>();
    let undetermined = false;
    for (const w of open) {
      if (w.table === null || tableKey(w.table) !== USERS_TABLE) continue;
      const type = requested ?? this.lookups.typeOn(w.via);
      if (type === null) undetermined = true;
      else types.add(type);
    }
    const branch: Branch = {
      request,
      written: new Set(tables.map(tableKey)),
      coOwners,
      userTypes: undetermined ? null : [...types].sort(compareText),
      storedDataOwner: facts.storedDataOwner,
    };
    // A split co-write counts with the owners of the targets it resolves to; class-owner splits read them, so they do not.
    const coSplit = (table: string): OwnershipEntry | undefined => {
      const entry = ownershipEntryOf(this.ownership, table);
      return entry?.owner === 'split' && !selectedByClassOwner(entry.targets) ? entry : undefined;
    };
    const resolved = new Set<string>();
    for (const w of open) {
      const entry = w.table === null ? undefined : coSplit(w.table);
      if (entry === undefined) continue;
      resolved.add(tableKey(entry.table));
      for (const t of this.splitUnits(entry, w.columns, w.via, branch, w)) coOwners.add(t.owner);
    }
    for (const table of tables) {
      const entry = coSplit(table);
      if (entry !== undefined && !resolved.has(tableKey(entry.table))) for (const t of this.splitUnits(entry, null, [], branch)) coOwners.add(t.owner);
    }
    return branch;
  }

  /** Units of one write of `table`, `write` when it is a recorded one; throws when the ownership file assigns the table no owner. */
  private unitsOf(table: string, columns: readonly string[] | null, via: readonly string[], branch: Branch, write?: ClosureWrite): ResolvedUnit[] {
    const entry = ownershipEntryOf(this.ownership, table);
    if (entry === undefined) throw new Error(`table ownership assigns no owner to written table ${table}`);
    const legacy = `${LEGACY_UNIT_PREFIX}${table}`;
    if (entry.owner === 'retired') return [{ unit: legacy, owner: null, decision: false }];
    if (entry.owner === 'decision-list') return [{ unit: legacy, owner: null, decision: true }];
    if (entry.owner !== 'split') {
      return entry.targets.length === 0
        ? [{ unit: legacy, owner: entry.owner, decision: false }]
        : entry.targets.map((t) => ({ unit: t.unit, owner: t.owner, decision: false }));
    }
    return this.splitUnits(entry, columns, via, branch, write).map((t) => ({ unit: t.unit, owner: t.owner, decision: false }));
  }

  /**
   * Targets of a split table a write reaches: the request and co-write selection, then the targets owning a written
   * column, then the targets of the row `Type` the evidence gives.
   */
  private splitUnits(
    entry: OwnershipEntry,
    columns: readonly string[] | null,
    via: readonly string[],
    branch: Branch,
    write?: ClosureWrite,
  ): OwnershipTarget[] {
    let pool = splitTargets(entry.targets, branch.request, this.coWritesFor(entry, branch, write));
    if (columns !== null) {
      const written = new Set(columns.map((c) => c.toLowerCase()));
      pool = narrowed(pool, (t) => ownedColumns(t).some((c) => written.has(c)));
    }
    const types = this.rowTypes(entry, via, branch);
    if (types !== null) pool = narrowed(pool, (t) => typeValues(t)?.some((v) => types.includes(v)) ?? true);
    return pool;
  }

  /**
   * What selects the targets of a split write: the branch's co-writes, or nothing when the branch's owner is held in
   * stored data, or when a class-owner write's statement is not keyed to the one object it was called for.
   */
  private coWritesFor(entry: OwnershipEntry, branch: Branch, write: ClosureWrite | undefined): SplitCoWrites | null {
    if (branch.storedDataOwner) return null;
    if (write !== undefined && selectedByClassOwner(entry.targets) && this.lookups.keysOneRow(write, primaryKeyOf(entry)) === false) return null;
    return { written: branch.written, owners: branch.coOwners };
  }

  /**
   * `Type` values of the row a write touches: the request's `type`, else the lookup on its call path; for a row an
   * owning tusers row types, also the types of the tusers rows the branch writes, and `Type = 2` when it writes none
   * and its owner is not held in stored data, since only group saves, which write the group's row, write group rows.
   */
  private rowTypes(entry: OwnershipEntry, via: readonly string[], branch: Branch): readonly string[] | null {
    if (!entry.targets.some((t) => typeValues(t) !== null)) return null;
    const requested = this.requestedType(entry, branch.request);
    if (requested !== null) return [requested];
    const looked = this.lookups.typeOn(via);
    if (looked !== null) return [looked];
    if (!entry.targets.some((t) => typeof t.rowPredicate === 'string' && OWNER_ROW_PREDICATE.test(t.rowPredicate))) return null;
    if (branch.userTypes === null) return null;
    if (branch.userTypes.length > 0) return branch.userTypes;
    return branch.storedDataOwner ? null : [USER_ROW_TYPE];
  }

  /** The request's `type` value when a `Type` target of `entry` names it; null otherwise (a content `type=Page` says nothing of rows). */
  private requestedType(entry: OwnershipEntry, request: ReadonlyMap<string, string | boolean | null>): string | null {
    const requested = request.get(TYPE_COLUMN);
    if (typeof requested !== 'string') return null;
    const value = requested.toLowerCase();
    return entry.targets.some((t) => typeValues(t)?.includes(value) === true) ? value : null;
  }
}
