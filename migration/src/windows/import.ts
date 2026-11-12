// Window import: after legacy executed a windowed request, sends the owners of its `target`-authoritative units the
// differences between the live legacy rows and their exports, applied as the owners' own `legacy-window` writes.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import {
  LEGACY_PROGRAM_ID_COLUMN,
  MAX_EXPORT_MATCH_LENGTH,
  decodeRow,
  encodeKey,
  encodeRow,
  mergeWritePosition,
  programTableName,
  resolveTenant,
  sha256Hex,
  type ApplyRequest,
  type CanonicalColumn,
  type CanonicalValue,
  type ExportTable,
  type ObjectManifestEntry,
  type TenantLookups,
  type TenantSource,
  type WritePositions,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';

import type { MigrationContext } from '../context.js';
import { diffKeyedStreams, diffMultisetStreams } from '../diff/index.js';
import {
  MAX_SCOPE_PARAMETERS,
  buildScopeFilter,
  compareCanonicalRows,
  describeLegacyTable,
  parseQualifiedName,
  readTableCatalog,
  rowInScope,
  streamLegacyTable,
  type CanonicalRow,
  type CatalogColumn,
  type ExtractScope,
  type ScopeFilter,
} from '../extract/index.js';
import { SUPPORTED_FILE_STORE, objectKey, parseStoredName, storePath, type StoredName } from '../files/index.js';
import type { components } from '../generated/openapi.js';
import { UnsupportedFileStoreError, quoteIdent, type LegacyDb, type LegacyFileEntry } from '../legacy/index.js';
import { OwnerCallError, type DataOwner, type ExportParams, type LegacyTableTarget, type Unit, type UnitCatalog } from '../owners/index.js';
import { FILE_OBJECT_UNIT } from '../reverse/files.js';

/** `windowOpen`'s scope: the writers' keyScope values, or the whole table. */
export type WindowScope = components['schemas']['WindowScope'];

/** Context members the import reads; target data only through `owners`, legacy rows through `legacy`, file bytes through `bridge`. */
// `config` is read for the backfill batch size, the umbrella site, the ownership file and the start-up guard table.
export type WindowImportContext = Pick<MigrationContext, 'config' | 'legacy' | 'catalog' | 'owners' | 'bridge' | 'logger'>;

/** One import attempt of a window; `units` lists only the window's `target`-authoritative units. */
export interface ImportInput {
  windowId: string;
  attempt: number;
  units: string[];
  scope: WindowScope;
}

/** What one attempt sent: `rows` counts rows the owners applied, `writePositions` the highest xid per owner. */
export interface ImportResult {
  rowsImported: number;
  perOwner: Record<string, { batches: number; rows: number }>;
  objectsTransferred: number;
  /** `content-files` keys whose legacy file is gone; strategies-content exposes no migration delete, so the caller logs them. */
  objectsRemoved: string[];
  /** True when `tcontent` was among the imported tables, so the caller runs the start-up guard check. */
  touchedContent: boolean;
  writePositions: Map<string, string>;
}

/** An attempt failed at a legacy read, an owner call or a row it cannot place; a later attempt recomputes the whole diff. */
export class WindowImportError extends Error {
  override readonly name = 'WindowImportError';
  readonly windowId: string;
  readonly owner: string | undefined;
  readonly table: string | undefined;

  constructor(windowId: string, message: string, details: { owner?: string; table?: string; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.windowId = windowId;
    this.owner = details.owner;
    this.table = details.table;
  }
}

/** Extract scope of a window scope: `table` for `{table: true}` or none, else each key lower-cased with its one value. */
export function toExtractScope(scope: WindowScope | undefined): ExtractScope {
  if (scope === undefined || !('keys' in scope)) return 'table';
  const keys: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(scope.keys)) (keys[name.toLowerCase()] ??= []).push(value);
  return keys;
}

/** Apply batch id `win:<windowId>:a<attempt>:<owner>:<table>:<seq>`, stable within an attempt and distinct across attempts. */
export function windowBatchId(windowId: string, attempt: number, owner: string, table: string, seq: number): string {
  return `win:${windowId}:a${String(attempt)}:${owner}:${table}:${String(seq)}`;
}

type ApplyRow = ApplyRequest['rows'][number];
type Discriminator = NonNullable<ApplyRow['discriminator']>;
type LegacyPool = Awaited<ReturnType<LegacyDb['live']>>;
type Values = Record<string, CanonicalValue>;

const PROGRAM_COLUMN: CanonicalColumn = Object.freeze({ name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' });
const LIVE_SITES_SQL = 'SELECT [SiteID], [filePoolID] FROM [dbo].[tsettings]';
const PROGRAM_SITES_SQL = 'SELECT [program_id], [siteID] FROM [synthetic].[program_site]';
// The image columns stay unread: only ownership and the parts of each object's content type are needed.
const LIVE_FILE_COLUMNS = ['siteID', 'contentType', 'contentSubType', 'fileExt'];
const FILES_TABLE = 'tfiles';
const FILES_TENANT_SOURCE: TenantSource = { kind: 'site', column: 'siteID' };
const OCTET_STREAM = 'application/octet-stream';
const FLV_EXT = 'flv';
const FLV_RENDITION_CONTENT_TYPE = 'image/jpeg';
const PREDICATE = /^\s*(owner\s+)?(\w+)\s*(?:=\s*(.+?)|in\s*\((.+)\))\s*$/i;
const CLASS_MAP_PREDICATE = /^\s*classMap\s+owner\s*=\s*(\S+)\s*$/i;
const LITERAL = /^\s*(?:'((?:[^']|'')*)'|(-?\d+))\s*$/;
const CHAIN_SEPARATOR = /,\s*then\s+/i;
const PLAIN_TABLE = /^[^.[\]]+$/;

/** Comparison form of a legacy value: SQL Server's default collation ignores case and trailing spaces. */
function norm(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = Buffer.isBuffer(value) ? value.toString('hex') : String(value);
  return text.replace(/ +$/, '').toLowerCase();
}

/** Lookup form of a legacy table name: no `dbo.`, lower case. */
function tableKey(name: string): string {
  return name.replace(/^dbo\./i, '').toLowerCase();
}

/** Value of column `name` in `row`, matched case-insensitively as SQL Server resolves names; undefined when absent. */
function valueOf(row: Readonly<Record<string, unknown>>, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name];
  const lower = name.toLowerCase();
  const found = Object.keys(row).find((key) => key.toLowerCase() === lower);
  return found === undefined ? undefined : row[found];
}

function hasValue(row: Readonly<Record<string, unknown>>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(row).some((key) => key.toLowerCase() === lower);
}

function plainColumn(column: CanonicalColumn): CanonicalColumn {
  return column.scale === undefined ? { name: column.name, type: column.type } : { name: column.name, type: column.type, scale: column.scale };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ownership key an exported legacy table name stands for: folded mappings name their table without `Program_<id>`. */
function genericTableKey(catalog: Pick<UnitCatalog, 'foldProgramTable'>, name: string): string {
  if (PLAIN_TABLE.test(name)) {
    const probe = catalog.foldProgramTable(programTableName(0, name));
    if (probe.programId !== null) return tableKey(probe.legacyTable);
  }
  return tableKey(catalog.foldProgramTable(name).legacyTable);
}

/** One class entry of an `objectClass` split; `candidates` are the owners a class decided by stored data may have. */
interface ClassRule {
  readonly classes: readonly string[];
  readonly owner: string | undefined;
  readonly candidates: readonly string[];
}

// The unit catalog keeps only units, targets and keys, so tenant rules and split-predicate joins are read from the ownership file itself.
/** Ownership-file facts of one legacy table that tenant resolution and split predicates need. */
interface TableFacts {
  readonly name: string;
  readonly tenantResolution: string | undefined;
  readonly siteIdColumn: string | undefined;
  readonly tenantParentJoin: string | undefined;
  readonly splitBy: string | undefined;
  readonly splitParentJoin: string | undefined;
  readonly addressJoin: string | undefined;
  readonly resolve: string | undefined;
  readonly classMap: readonly ClassRule[];
}

const factsByFile = new Map<string, ReadonlyMap<string, TableFacts>>();

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const textsOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((item) => textOf(item) ?? []) : []);

function classRuleOf(raw: unknown): ClassRule {
  const rule = recordOf(raw);
  return { classes: textsOf(rule.classes), owner: textOf(rule.owner), candidates: Object.values(recordOf(rule.owners)).flatMap((owner) => textOf(owner) ?? []) };
}

/** Facts of every table of the ownership file `file`, by lookup key; read once per file. */
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
      splitParentJoin: textOf(recordOf(split.parent).join),
      addressJoin: textOf(split.addressJoin),
      resolve: textOf(split.resolve),
      classMap: Array.isArray(split.classMap) ? split.classMap.map(classRuleOf) : [],
    });
  }
  factsByFile.set(file, facts);
  return facts;
}

/** One hop of a join chain: `fromColumn` of the table the hop starts at equals `toColumn` of `toTable`. */
interface Hop {
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
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

/** Live legacy rows found by one key column, read once per key and memoised for the attempt. */
class LegacyLookups {
  readonly #legacy: Pick<LegacyDb, 'live'>;
  readonly #found = new Map<string, Map<string, Record<string, unknown>[]>>();

  constructor(legacy: Pick<LegacyDb, 'live'>) {
    this.#legacy = legacy;
  }

  /** Rows of `table` whose `keyColumn` equals each of `keys`, carrying `columns`, by normalised key. */
  async find(table: string, keyColumn: string, columns: readonly string[], keys: Iterable<unknown>): Promise<ReadonlyMap<string, Record<string, unknown>[]>> {
    const id = JSON.stringify([tableKey(table), keyColumn.toLowerCase(), columns.map((column) => column.toLowerCase())]);
    let found = this.#found.get(id);
    if (found === undefined) {
      found = new Map();
      this.#found.set(id, found);
    }
    const wanted = new Map<string, unknown>();
    for (const key of keys) {
      const normalised = norm(key);
      if (normalised !== undefined && !found.has(normalised)) wanted.set(normalised, key);
    }
    if (wanted.size === 0) return found;
    const pool: LegacyPool = await this.#legacy.live();
    const { schema, table: name } = parseQualifiedName(table);
    const select = [`${quoteIdent(keyColumn)} AS [k]`, ...columns.map((column, index) => `${quoteIdent(column)} AS [v${String(index)}]`)].join(', ');
    const values = [...wanted.values()];
    const fetched = new Map<string, Record<string, unknown>[]>([...wanted.keys()].map((key) => [key, []]));
    for (let start = 0; start < values.length; start += MAX_SCOPE_PARAMETERS) {
      const chunk = values.slice(start, start + MAX_SCOPE_PARAMETERS);
      const request = pool.request();
      chunk.forEach((value, index) => request.input(`p${String(index)}`, value));
      const params = chunk.map((_, index) => `@p${String(index)}`).join(', ');
      const result = await request.query<Record<string, unknown>>(
        `SELECT ${select} FROM ${quoteIdent(schema)}.${quoteIdent(name)} WHERE ${quoteIdent(keyColumn)} IN (${params})`,
      );
      for (const record of result.recordset) {
        const rows = fetched.get(norm(record.k) ?? '');
        rows?.push(Object.fromEntries(columns.map((column, index) => [column, record[`v${String(index)}`]])));
      }
    }
    for (const [key, rows] of fetched) found.set(key, rows);
    return found;
  }
}

/** Normalised values each row reaches through the first chain that yields any, ending at column `attr` of the chain's last table. */
async function resolveChains(
  lookups: LegacyLookups,
  chains: readonly Hop[][],
  attr: string,
  rows: readonly CanonicalRow[],
): Promise<Map<CanonicalRow, Set<string>>> {
  const resolved = new Map<CanonicalRow, Set<string>>();
  for (const hops of chains) {
    const first = hops[0];
    const pending = rows.filter((row) => !resolved.has(row));
    if (first === undefined || pending.length === 0) continue;
    let reached = new Map<CanonicalRow, unknown[]>(pending.map((row) => [row, [valueOf(row.row, first.fromColumn)]]));
    for (const [index, hop] of hops.entries()) {
      const next = hops[index + 1]?.fromColumn ?? attr;
      const found = await lookups.find(hop.toTable, hop.toColumn, [next], [...reached.values()].flat());
      reached = new Map(
        [...reached].map(([row, keys]) => [row, keys.flatMap((key) => (found.get(norm(key) ?? '') ?? []).map((record) => record[next]))]),
      );
    }
    for (const [row, values] of reached) {
      const set = new Set(values.flatMap((value) => norm(value) ?? []));
      if (set.size > 0) resolved.set(row, set);
    }
  }
  return resolved;
}

/** A live `tsettings` site and the directory Masa stores its files under: its `filePoolID`, else its own id. */
interface LiveSite {
  readonly siteId: string;
  readonly fileDir: string;
}

/** A live `tfiles` row's file-pool site and content type parts. */
interface LiveFile {
  readonly siteID: string | null;
  readonly contentType: string | null;
  readonly contentSubType: string | null;
  readonly fileExt: string | null;
}

/** One apply row with the `Program_<id>` its batch names. */
interface PlannedRow {
  readonly programId: number | undefined;
  readonly row: ApplyRow;
}

/** Where one table's apply rows go: the unit, the owner's legacy table name and the columns the rows are encoded over. */
interface ApplyTarget {
  readonly owner: DataOwner;
  readonly unit: string;
  /** Ownership name, used in batch ids. */
  readonly table: string;
  /** The owner mapping's legacy table name, as its export reports it. */
  readonly legacyTable: string;
  readonly tenantId: string;
  readonly columns: CanonicalColumn[];
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.replace(/ +$/, '') : '');

/** State one attempt shares across its tables and files: scope, lookups, live sites, results and batch sequences. */
class ImportSession {
  readonly ctx: WindowImportContext;
  readonly input: ImportInput;
  readonly scope: ExtractScope;
  readonly lookups: LegacyLookups;
  readonly result: ImportResult = {
    rowsImported: 0,
    perOwner: {},
    objectsTransferred: 0,
    objectsRemoved: [],
    touchedContent: false,
    writePositions: new Map(),
  };
  readonly #facts: ReadonlyMap<string, TableFacts>;
  readonly #sequences = new Map<string, number>();
  readonly #manifests = new Map<string, readonly ObjectManifestEntry[]>();
  #sites: Promise<readonly LiveSite[]> | undefined;
  #programSites: Promise<ReadonlyMap<number, string>> | undefined;

  constructor(ctx: WindowImportContext, input: ImportInput) {
    this.ctx = ctx;
    this.input = input;
    this.scope = toExtractScope(input.scope);
    this.lookups = new LegacyLookups(ctx.legacy);
    this.#facts = ownershipFacts(ctx.config.paths.tableOwnership);
  }

  get umbrellaSiteId(): string {
    return this.ctx.config.umbrellaSiteId;
  }

  /** Ownership facts of `table`; throws when the ownership file has no entry for it. */
  facts(table: string): TableFacts {
    const facts = this.#facts.get(tableKey(table));
    if (facts === undefined) throw new Error(`the ownership file records no legacy table ${table}`);
    return facts;
  }

  /** Live sites in site id order, read once. */
  sites(): Promise<readonly LiveSite[]> {
    this.#sites ??= this.#readSites();
    return this.#sites;
  }

  /** Tenants of every live site and the umbrella site, in order. */
  async tenants(): Promise<string[]> {
    const ids = new Set((await this.sites()).map((site) => tenantIdForSite(site.siteId)));
    ids.add(tenantIdForSite(this.umbrellaSiteId));
    return [...ids].sort();
  }

  /** `synthetic.program_site` as program id to site id, read once. */
  programSites(): Promise<ReadonlyMap<number, string>> {
    this.#programSites ??= this.#readProgramSites();
    return this.#programSites;
  }

  /** Next batch id of `owner`'s `table`; one sequence spans the table's units and tenants, so no two batches share an id. */
  nextBatchId(owner: string, table: string): string {
    const key = JSON.stringify([owner, table]);
    const seq = this.#sequences.get(key) ?? 0;
    this.#sequences.set(key, seq + 1);
    return windowBatchId(this.input.windowId, this.input.attempt, owner, table, seq);
  }

  addPositions(positions: WritePositions): void {
    this.result.writePositions = mergeWritePosition(this.result.writePositions, positions);
  }

  /** Keeps the object manifest an export of `unit` in `tenantId` carried. */
  recordManifest(unit: string, tenantId: string, objects: readonly ObjectManifestEntry[]): void {
    this.#manifests.set(JSON.stringify([unit, tenantId]), objects);
  }

  /** Object manifest of `unit` in `tenantId`: as an export of this attempt carried it, else read now. */
  async manifest(owner: DataOwner, unit: string, tenantId: string): Promise<readonly ObjectManifestEntry[]> {
    const known = this.#manifests.get(JSON.stringify([unit, tenantId]));
    if (known !== undefined) return known;
    const objects: ObjectManifestEntry[] = [];
    for await (const page of this.ctx.owners.exportPages(owner, { unit, tenantId })) objects.push(...(page.objects ?? []));
    this.recordManifest(unit, tenantId, objects);
    return objects;
  }

  /** Applies one tenant's rows as they arrive in backfill-size batches per `Program_<id>`, then the remainders in program order; returns the rows sent. */
  async send(target: ApplyTarget, rows: AsyncIterable<PlannedRow>): Promise<number> {
    const size = this.ctx.config.backfill.batchRows;
    const byProgram = new Map<number | undefined, ApplyRow[]>();
    let sent = 0;
    for await (const planned of rows) {
      const group = byProgram.get(planned.programId) ?? [];
      group.push(planned.row);
      byProgram.set(planned.programId, group);
      sent += 1;
      if (group.length < size) continue;
      byProgram.delete(planned.programId);
      await this.#apply(target, planned.programId, group);
    }
    for (const [programId, group] of [...byProgram].sort(([a], [b]) => (a ?? -1) - (b ?? -1))) await this.#apply(target, programId, group);
    return sent;
  }

  async #apply(target: ApplyTarget, programId: number | undefined, rows: ApplyRow[]): Promise<void> {
    const request: ApplyRequest = {
      batchId: this.nextBatchId(target.owner, target.table),
      origin: 'legacy-window',
      legacyTable: target.legacyTable,
      tenantId: target.tenantId,
      ...(programId === undefined ? {} : { legacyProgramId: programId }),
      columns: target.columns,
      units: [target.unit],
      holderId: this.input.windowId,
      rows,
    };
    const response = await this.ctx.owners.apply(target.owner, request);
    const stats = (this.result.perOwner[target.owner] ??= { batches: 0, rows: 0 });
    stats.batches += 1;
    stats.rows += response.applied;
    this.result.rowsImported += response.applied;
    this.addPositions(response.writePositions);
  }

  async #readSites(): Promise<readonly LiveSite[]> {
    const pool = await this.ctx.legacy.live();
    const result = await pool.request().query<{ SiteID: string | null; filePoolID: string | null }>(LIVE_SITES_SQL);
    const sites = new Map<string, LiveSite>();
    for (const row of result.recordset) {
      const siteId = trimmed(row.SiteID);
      if (siteId === '' || sites.has(siteId.toLowerCase())) continue;
      sites.set(siteId.toLowerCase(), { siteId, fileDir: trimmed(row.filePoolID) || siteId });
    }
    return [...sites.values()].sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0));
  }

  async #readProgramSites(): Promise<ReadonlyMap<number, string>> {
    const pool = await this.ctx.legacy.live();
    const result = await pool.request().query<{ program_id: number | string; siteID: string | null }>(PROGRAM_SITES_SQL);
    return new Map(result.recordset.map((row): [number, string] => [Number(row.program_id), trimmed(row.siteID)]));
  }
}

/** A legacy table's tenant rule over the rows it was prepared for. */
interface RowTenants {
  /** True when the rule reads the row's own site column, which the owner checks against the batch tenant. */
  readonly siteSourced: boolean;
  tenantOf(row: CanonicalRow): string;
}

function siteSourceOf(facts: TableFacts): Extract<TenantSource, { kind: 'site' }> {
  if (facts.siteIdColumn === undefined) throw new Error(`legacy table ${facts.name} records no site column`);
  return { kind: 'site', column: facts.siteIdColumn };
}

/** Tenant rule of `table` from its ownership entry through migration-kit `resolveTenant`, with the lookups `rows` need read first. */
async function rowTenantsFor(session: ImportSession, table: string, rows: readonly CanonicalRow[]): Promise<RowTenants> {
  const facts = session.facts(table);
  const rule = facts.tenantResolution ?? '';
  const lookups: TenantLookups = { umbrellaSiteId: session.umbrellaSiteId };
  const by =
    (source: TenantSource) =>
    (row: CanonicalRow): string =>
      resolveTenant(source, row.row, lookups, { legacyProgramId: row.legacyProgramId }).tenantId;
  if (rule === 'siteID' || rule === 'siteID-or-umbrella') return { siteSourced: true, tenantOf: by(siteSourceOf(facts)) };
  if (rule === 'program_site') {
    const sites = await session.programSites();
    lookups.programSiteId = (programId) => sites.get(programId);
    return { siteSourced: false, tenantOf: by({ kind: 'program' }) };
  }
  const hop = rule.startsWith('parent:') && facts.tenantParentJoin !== undefined ? chainHops(table, facts.tenantParentJoin)[0] : undefined;
  if (hop === undefined) throw new Error(`legacy table ${table} has tenant rule "${rule}", which the window import cannot apply`);
  const siteColumn = siteSourceOf(session.facts(hop.toTable)).column;
  const parents = await session.lookups.find(hop.toTable, hop.toColumn, [siteColumn], rows.map((row) => valueOf(row.row, hop.fromColumn)));
  lookups.parentSiteId = (_parentTable, key) => {
    const found = parents.get(norm(valueOf(key, hop.toColumn)) ?? '') ?? [];
    const sites = [...new Set(found.map((parent) => trimmed(parent[siteColumn])).filter((site) => site !== ''))];
    // A child of no parent, or of parents in several tenants, resolves to the umbrella tenant as an orphan.
    return new Set(sites.map(tenantIdForSite)).size === 1 ? (sites[0] ?? null) : null;
  };
  return { siteSourced: false, tenantOf: by({ kind: 'parent', parentLegacyTable: hop.toTable, columns: { [hop.fromColumn]: hop.toColumn } }) };
}

/** Which legacy rows of a split table belong to one unit, and the discriminator its apply rows carry. */
interface RowSelector {
  readonly discriminator: Discriminator | undefined;
  /** A predicate column the owner does not export, sent with every apply row so the owner can split it; `value` fills rows that lack it. */
  readonly carried?: { readonly column: CanonicalColumn; readonly value: string };
  /** Whether `row` is the unit's; `existing` tells it is among the unit's exported rows already. */
  accepts(row: CanonicalRow, existing: boolean): boolean;
}

const ALL_ROWS: RowSelector = { discriminator: undefined, accepts: () => true };

/** Literals of a predicate value list: quoted text or integers; undefined for anything else. */
function literalsOf(list: string): Discriminator[] | undefined {
  const literals: Discriminator[] = [];
  for (const part of list.split(',')) {
    const literal = LITERAL.exec(part);
    if (literal === null) return undefined;
    literals.push(literal[1] === undefined ? Number(literal[2]) : literal[1].replaceAll("''", "'"));
  }
  return literals;
}

/** Selector of `classMap owner = <owner>`: the row's class names its owner, statically or through stored data. */
function classMapSelector(facts: TableFacts, owner: string): RowSelector {
  const column = facts.splitBy;
  if (column === undefined || facts.classMap.length === 0) throw new Error(`legacy table ${facts.name} declares no class map`);
  return {
    discriminator: owner,
    accepts(row, existing) {
      const objectClass = norm(valueOf(row.row, column));
      const rule = objectClass === undefined ? undefined : facts.classMap.find((entry) => entry.classes.some((name) => norm(name) === objectClass));
      if (rule === undefined) return existing;
      if (rule.owner !== undefined) return rule.owner === owner;
      if (!rule.candidates.includes(owner)) return false;
      // The owner of such a class is read from its stored object, so a new row is never guessed: the attempt fails closed.
      if (!existing) throw new Error(`the owner of ${facts.name} ${column} "${objectClass ?? ''}" depends on its stored object, which the window import does not read`);
      return true;
    },
  };
}

/**
 * Selector of a unit's row predicate: a column of the table compared in the row, or a value reached through the
 * ownership file's parent or `resolve` joins. Rows no join reaches count as the unit's when it already holds them.
 */
async function rowSelectorFor(
  session: ImportSession,
  table: string,
  target: LegacyTableTarget,
  columns: readonly CanonicalColumn[],
  exported: readonly CanonicalColumn[],
  rows: readonly CanonicalRow[],
): Promise<RowSelector> {
  const predicate = target.rowPredicate;
  if (predicate === null) return ALL_ROWS;
  const facts = session.facts(table);
  const classOwner = CLASS_MAP_PREDICATE.exec(predicate)?.[1];
  if (classOwner !== undefined) return classMapSelector(facts, classOwner);
  const match = PREDICATE.exec(predicate);
  const attr = match?.[2];
  const literals = literalsOf(match?.[3] ?? match?.[4] ?? '');
  const first = literals?.[0];
  if (match === null || attr === undefined || literals === undefined || first === undefined) {
    throw new Error(`row predicate "${predicate}" of ${table} has a form the window import cannot evaluate`);
  }
  const accepted = new Set(literals.flatMap((literal) => norm(literal) ?? []));
  const viaParent = match[1] !== undefined;
  const live = viaParent ? undefined : columns.find((column) => column.name.toLowerCase() === attr.toLowerCase());
  if (live !== undefined) {
    const inExport = exported.some((column) => column.name.toLowerCase() === attr.toLowerCase());
    return {
      discriminator: undefined,
      // A column split (tusers `Type`) names its column in the owner's mapping, so apply rows must carry it even
      // when the owner exports only its own share of the row.
      ...(inExport ? {} : { carried: { column: live, value: String(first) } }),
      accepts: (row) => accepted.has(norm(valueOf(row.row, attr)) ?? ''),
    };
  }
  const chains = (viaParent ? [facts.splitParentJoin, facts.addressJoin] : [facts.resolve]).flatMap((chain) =>
    chain === undefined ? [] : [chainHops(table, chain)],
  );
  if (chains.length === 0) throw new Error(`row predicate "${predicate}" of ${table} names no ownership join to evaluate it`);
  const resolved = await resolveChains(session.lookups, chains, attr, rows);
  return {
    discriminator: first,
    accepts: (row, existing) => {
      const values = resolved.get(row);
      return values === undefined ? existing : [...values].some((value) => accepted.has(value));
    },
  };
}

/** Columns one table is compared and applied over, taken from the owner's export. */
interface TableLayout {
  /** The owner's legacy columns, which apply rows are encoded over. */
  readonly columns: CanonicalColumn[];
  /** `columns`, plus `legacy_program_id` for folded tables: what both sides are encoded and diffed over. */
  readonly compare: CanonicalColumn[];
  /** Key in `compare` spelling; empty for a keyless mapping. */
  readonly keyNames: string[];
  readonly folded: boolean;
}

function exportColumnName(columns: readonly CanonicalColumn[], name: string): string {
  const found = columns.find((column) => column.name === name) ?? columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
  if (found === undefined) throw new Error(`the owner's export carries no key column ${name}`);
  return found.name;
}

// Keyed-ness follows the owner's mapping, since it decides whether an apply row may be upserted or inserted.
function layoutOf(definition: ExportTable, target: LegacyTableTarget, folded: boolean): TableLayout {
  const columns = definition.columns.map(plainColumn);
  const compare = folded ? [...columns, PROGRAM_COLUMN] : columns;
  const keyNames = definition.keyless
    ? []
    : [...target.keyColumns.map((name) => exportColumnName(columns, name)), ...(folded ? [LEGACY_PROGRAM_ID_COLUMN] : [])];
  return { columns, compare, keyNames, folded };
}

// Both sides are rebuilt here with key values in canonical text form, so one comparator orders legacy and target rows alike.
/** A row over the layout's comparison columns. */
function canonicalRowOf(table: string, layout: TableLayout, values: Values, legacyProgramId: number | undefined): CanonicalRow {
  const encoding = encodeRow(layout.compare, values);
  const keyed = layout.keyNames.length > 0;
  return {
    table,
    ...(legacyProgramId === undefined ? {} : { legacyProgramId }),
    key: keyed ? encodeKey(layout.compare, layout.keyNames, values) : encoding,
    keyValues: keyed ? layout.keyNames.map((name) => values[name] ?? null) : [],
    encoding,
    row: values,
  };
}

/** A legacy row's values of the layout's comparison columns; throws when the live table lacks one the owner maps. */
function projected(layout: TableLayout, row: CanonicalRow, table: string): Values {
  const values: Values = {};
  for (const column of layout.compare) {
    if (!hasValue(row.row, column.name)) throw new Error(`live legacy table ${table} has no column ${column.name}, which its owner maps`);
    values[column.name] = valueOf(row.row, column.name) as CanonicalValue;
  }
  return values;
}

/** Reads every export page `params` names, handing each page's `table` entry to `onTable` as it arrives; records the pages' object manifest. */
async function readTenantExport(
  session: ImportSession,
  owner: DataOwner,
  params: ExportParams,
  table: string,
  onTable: (exported: ExportTable) => void,
): Promise<void> {
  const key = tableKey(table);
  const objects: ObjectManifestEntry[] = [];
  for await (const page of session.ctx.owners.exportPages(owner, params)) {
    objects.push(...(page.objects ?? []));
    for (const exported of page.tables) {
      if (exported.unit === params.unit && genericTableKey(session.ctx.catalog, exported.legacyTable) === key) onTable(exported);
    }
  }
  session.recordManifest(params.unit, params.tenantId, objects);
}

/** Owner export filter of a scoped read: each term's live column with its values; none for a whole-table filter or one too long to send. */
function exportMatchOf(filter: ScopeFilter): ExportParams['match'] {
  if (filter.kind !== 'filtered') return undefined;
  const match = Object.fromEntries(filter.terms.map((term) => [term.column.name, term.values]));
  return JSON.stringify(match).length <= MAX_EXPORT_MATCH_LENGTH ? match : undefined;
}

/** How one table is compared: the owner's table definition, its layout, and the scope and filter both sides read with. */
interface TablePlan {
  readonly definition: ExportTable;
  readonly layout: TableLayout;
  readonly scope: ExtractScope;
  readonly filter: ScopeFilter;
}

/** The scope both sides read with and its filter, widened to the whole table when the export lacks a column the filter tests. */
function tableScope(
  session: ImportSession,
  table: string,
  columns: readonly CatalogColumn[],
  filter: ScopeFilter,
  layout: TableLayout,
): { scope: ExtractScope; filter: ScopeFilter } {
  const testable = filter.terms.every((term) => layout.compare.some((column) => column.name.toLowerCase() === term.column.name.toLowerCase()));
  if (testable) return { scope: session.scope, filter };
  // A target row whose scope column the owner does not export cannot be placed in or out of scope, and leaving it out
  // would hide a legacy delete, so both sides compare the whole table instead.
  session.ctx.logger.info(`window ${session.input.windowId} compares all of ${table}: its owner's export lacks a scope column`);
  return { scope: 'table', filter: buildScopeFilter(columns, 'table') };
}

/** Apply rows turning `before` (target) into `after` (legacy) as the diff finds them: upserts and deletes for keyed mappings, one insert or delete per occurrence otherwise. */
async function* plannedRows(
  layout: TableLayout,
  writableColumns: readonly string[] | undefined,
  selector: RowSelector,
  applyColumns: readonly CanonicalColumn[],
  before: readonly CanonicalRow[],
  after: readonly CanonicalRow[],
): AsyncGenerator<PlannedRow, void, undefined> {
  const { carried, discriminator } = selector;
  const plan = (op: ApplyRow['op'], row: CanonicalRow): PlannedRow => {
    let encoding = row.encoding;
    if (carried !== undefined) {
      const name = carried.column.name;
      const value = hasValue(row.row, name) ? (valueOf(row.row, name) as CanonicalValue) : carried.value;
      encoding = encodeRow(applyColumns, { ...row.row, [name]: value });
    } else if (layout.folded) {
      encoding = encodeRow(applyColumns, row.row);
    }
    return { programId: row.legacyProgramId, row: { op, row: encoding, ...(discriminator === undefined ? {} : { discriminator }) } };
  };
  if (layout.keyNames.length > 0) {
    for await (const change of diffKeyedStreams(before, after, { columns: layout.compare, ...(writableColumns === undefined ? {} : { writableColumns }) })) {
      yield change.op === 'delete' ? plan('delete', change.before) : plan('upsert', change.after);
    }
    return;
  }
  for await (const change of diffMultisetStreams(before, after)) {
    for (let index = 0; index < change.removed; index++) yield plan('delete', change.row);
    for (let index = 0; index < change.added; index++) yield plan('insert', change.row);
  }
}

function programText(row: ExportTable['rows'][number], table: string): string {
  if (row.legacyProgramId === undefined) throw new Error(`the owner exported a row of folded table ${table} without its program id`);
  return String(row.legacyProgramId);
}

/** Brings one unit's share of one legacy table in step with the live legacy rows in the window's scope. */
async function importTable(session: ImportSession, unit: string, table: string, target: LegacyTableTarget): Promise<void> {
  const { ctx } = session;
  const deps = { legacy: ctx.legacy, catalog: ctx.catalog };
  const shape = await describeLegacyTable(deps, { table });
  const { columns: liveColumns } = await readTableCatalog(await ctx.legacy.live(), shape.parts[0]?.ref ?? table);
  const liveFilter = buildScopeFilter(liveColumns, session.scope);
  const match = exportMatchOf(liveFilter);

  // The owner may return more rows than the match names, so each tenant's rows are filtered here as they arrive.
  const first: { plan?: TablePlan } = {};
  const targetByTenant = new Map<string, CanonicalRow[]>();
  const tenantOfKey = new Map<string, string>();
  const readTarget = (tenantId: string): Promise<void> => {
    const rows: CanonicalRow[] = [];
    targetByTenant.set(tenantId, rows);
    return readTenantExport(session, target.owner, { unit, tenantId, match }, table, (exported) => {
      if (first.plan === undefined) {
        const layout = layoutOf(exported, target, shape.folded);
        first.plan = { definition: exported, layout, ...tableScope(session, table, liveColumns, liveFilter, layout) };
      }
      const { definition, layout, filter } = first.plan;
      for (const exportRow of exported.rows) {
        const values: Values = decodeRow(definition.columns, exportRow.row);
        if (layout.folded) values[LEGACY_PROGRAM_ID_COLUMN] = programText(exportRow, table);
        if (!rowInScope(filter, values)) continue;
        const row = canonicalRowOf(table, layout, values, exportRow.legacyProgramId);
        rows.push(row);
        if (!tenantOfKey.has(row.key)) tenantOfKey.set(row.key, tenantId);
      }
    });
  };
  for (const tenantId of await session.tenants()) await readTarget(tenantId);
  if (first.plan === undefined) throw new Error(`${target.owner} exports no ${table} table for unit ${unit}`);
  const { definition, layout, scope } = first.plan;

  const selector = await rowSelectorFor(session, table, target, shape.columns, layout.columns, []);
  const carried = selector.carried?.column;
  const applyColumns = carried === undefined ? layout.columns : [...layout.columns, carried];
  const legacyByTenant = new Map<string, CanonicalRow[]>();
  const place = async (sources: readonly CanonicalRow[]): Promise<void> => {
    const accepting = await rowSelectorFor(session, table, target, shape.columns, layout.columns, sources);
    const tenants = await rowTenantsFor(session, table, sources);
    for (const source of sources) {
      const values = projected(layout, source, table);
      if (carried !== undefined) values[carried.name] = valueOf(source.row, carried.name) as CanonicalValue;
      const row = canonicalRowOf(table, layout, values, source.legacyProgramId);
      const known = tenantOfKey.get(row.key);
      if (!accepting.accepts(source, known !== undefined)) continue;
      // A row placed through its parent or program keeps the tenant its owner holds it in; a site-sourced row follows
      // its site, which the owner checks against the batch tenant.
      const tenantId = tenants.siteSourced ? tenants.tenantOf(source) : (known ?? tenants.tenantOf(source));
      const rows = legacyByTenant.get(tenantId) ?? [];
      rows.push(row);
      legacyByTenant.set(tenantId, rows);
    }
  };
  let chunk: CanonicalRow[] = [];
  for await (const source of streamLegacyTable(deps, { table, scope })) {
    chunk.push(source);
    if (chunk.length < ctx.config.backfill.batchRows) continue;
    await place(chunk);
    chunk = [];
  }
  await place(chunk);
  for (const tenantId of legacyByTenant.keys()) {
    if (!targetByTenant.has(tenantId)) await readTarget(tenantId);
  }

  const writableColumns = target.ownedColumns === 'whole-table' ? undefined : target.ownedColumns;
  let sent = 0;
  for (const tenantId of [...new Set([...targetByTenant.keys(), ...legacyByTenant.keys()])].sort()) {
    const before = (targetByTenant.get(tenantId) ?? []).sort(compareCanonicalRows);
    const after = (legacyByTenant.get(tenantId) ?? []).sort(compareCanonicalRows);
    targetByTenant.delete(tenantId);
    legacyByTenant.delete(tenantId);
    const rows = plannedRows(layout, writableColumns, selector, applyColumns, before, after);
    sent += await session.send({ owner: target.owner, unit, table, legacyTable: definition.legacyTable, tenantId, columns: applyColumns }, rows);
  }
  if (sent > 0) ctx.logger.info(`window ${session.input.windowId} sent ${String(sent)} ${table} changes to ${target.owner} unit ${unit}`);
}

/** Content type of one stored object of a `tfiles` row, as Masa's s3 store would give it; octet-stream without a typed row. */
function contentTypeOf(ext: string, file: LiveFile | undefined, flvRenditionExt: string): string {
  if (!file?.contentType || !file.contentSubType) return OCTET_STREAM;
  const fileExt = (file.fileExt ?? '').toLowerCase();
  const lower = ext.toLowerCase();
  if (lower === fileExt) return `${file.contentType}/${file.contentSubType}`;
  return fileExt === FLV_EXT && lower === flvRenditionExt.toLowerCase() ? FLV_RENDITION_CONTENT_TYPE : OCTET_STREAM;
}

/** A listed legacy file with the tenant, `content-files` key and content type it is stored under. */
interface PlannedObject {
  readonly dir: string;
  readonly file: LegacyFileEntry;
  readonly name: StoredName;
  readonly tenantId: string;
  readonly key: string;
  readonly contentType: string;
}

/** Store directories of live sites the window's scope reaches: each scoped site's own and its file pool's, else every site's. */
async function fileDirs(session: ImportSession): Promise<string[]> {
  const sites = await session.sites();
  const scoped = session.scope === 'table' ? undefined : session.scope.siteid?.map((value) => norm(value));
  const dirs = new Map<string, string>();
  for (const site of sites) {
    if (scoped !== undefined && !scoped.includes(site.siteId.toLowerCase())) continue;
    for (const dir of scoped === undefined ? [site.siteId] : [site.siteId, site.fileDir]) {
      if (!dirs.has(dir.toLowerCase())) dirs.set(dir.toLowerCase(), dir);
    }
  }
  return [...dirs.values()].sort();
}

/** Live `tfiles` rows of `fileIds`, by upper-cased `fileID`. */
async function liveFiles(session: ImportSession, fileIds: readonly string[]): Promise<Map<string, LiveFile>> {
  const found = await session.lookups.find(FILES_TABLE, 'fileID', LIVE_FILE_COLUMNS, fileIds);
  const files = new Map<string, LiveFile>();
  for (const fileId of fileIds) {
    const row = found.get(norm(fileId) ?? '')?.[0];
    if (row === undefined) continue;
    const text = (column: string): string | null => (typeof row[column] === 'string' ? row[column] : null);
    files.set(fileId.toUpperCase(), { siteID: text('siteID'), contentType: text('contentType'), contentSubType: text('contentSubType'), fileExt: text('fileExt') });
  }
  return files;
}

/**
 * Sends strategies-content every file the scoped store directories hold that its manifest lacks or holds with other
 * bytes, and lists the manifest objects those directories no longer hold.
 * @throws UnsupportedFileStoreError when the legacy store is not `fileDir`.
 */
async function importFiles(session: ImportSession, unit: string, owner: DataOwner): Promise<void> {
  const { ctx } = session;
  const dirs = await fileDirs(session);
  const lookups: TenantLookups = { umbrellaSiteId: session.umbrellaSiteId };
  const planned: PlannedObject[] = [];
  const present = new Set<string>();
  for (const dir of dirs) {
    const listing = await ctx.bridge.filesList(dir);
    if (listing.fileStore !== SUPPORTED_FILE_STORE) {
      throw new UnsupportedFileStoreError('files.list', { error: 'unsupportedFileStore', message: listing.fileStore });
    }
    const stored = listing.files.flatMap((file) => {
      const name = parseStoredName(file.name);
      return name === null ? [] : [{ file, name }];
    });
    const files = await liveFiles(session, stored.map(({ name }) => name.fileId));
    for (const { file, name } of stored) {
      const row = files.get(name.fileId.toUpperCase());
      // A file without a `tfiles` row resolves to the umbrella tenant as an orphan, as the backfill places it.
      const resolved = resolveTenant(FILES_TENANT_SOURCE, { siteID: row?.siteID ?? null }, lookups);
      // The owner's keys lower-case the extension.
      const key = objectKey(resolved.tenantId, name.fileId, name.variant, name.ext.toLowerCase());
      present.add(key.toLowerCase());
      // Masa reads a file only from its row's site directory, so a copy elsewhere is never sent.
      if (!resolved.orphan && resolved.siteId.toLowerCase() !== dir.toLowerCase()) continue;
      planned.push({ dir, file, name, tenantId: resolved.tenantId, key, contentType: contentTypeOf(name.ext, row, ctx.config.fileStore.flvRenditionExt) });
    }
  }

  const listedDirs = new Set(dirs.map((dir) => dir.toLowerCase()));
  const listedTenants = new Set(dirs.map((dir) => tenantIdForSite(dir)));
  const manifest = new Map<string, ObjectManifestEntry & { tenantId: string }>();
  for (const tenantId of [...new Set([...listedTenants, ...planned.map((object) => object.tenantId)])].sort()) {
    for (const object of await session.manifest(owner, unit, tenantId)) manifest.set(object.key.toLowerCase(), { ...object, tenantId });
  }

  for (const object of planned.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const stored = manifest.get(object.key.toLowerCase());
    const expected = object.file.sha256.toLowerCase();
    if (stored !== undefined && stored.sha256.toLowerCase() === expected && stored.size === object.file.size) continue;
    const { bytes } = await ctx.bridge.filesGet(object.dir, object.file.name);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== expected) throw new Error(`legacy file ${storePath(object.dir, object.file.name)} hashes to ${sha256}, not its listing's ${expected}`);
    const put = await ctx.owners.putObject(
      { tenantId: object.tenantId, fileId: object.name.fileId, variant: object.name.variant, ext: object.name.ext, contentType: object.contentType, sha256 },
      bytes,
    );
    session.result.objectsTransferred += 1;
    session.addPositions(put.writePositions);
  }

  for (const [key, entry] of manifest) {
    if (present.has(key)) continue;
    const dir = entry.legacyPath?.split('/')[0]?.toLowerCase();
    if (dir === undefined ? listedTenants.has(entry.tenantId) : listedDirs.has(dir)) session.result.objectsRemoved.push(entry.key);
  }
  if (session.result.objectsTransferred > 0 || session.result.objectsRemoved.length > 0) {
    ctx.logger.info(
      `window ${session.input.windowId} transferred ${String(session.result.objectsTransferred)} files; ` +
        `${String(session.result.objectsRemoved.length)} ${owner} manifest objects have no legacy file`,
    );
  }
}

/** Runs one step, turning any failure but an unsupported file store into a WindowImportError naming the owner and table. */
async function guarded<T>(windowId: string, where: { owner?: string; table?: string }, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WindowImportError || error instanceof UnsupportedFileStoreError) throw error;
    const owner = error instanceof OwnerCallError ? error.owner : where.owner;
    throw new WindowImportError(windowId, `window ${windowId} import of ${where.table ?? 'its units'} failed: ${messageOf(error)}`, {
      ...(owner === undefined ? {} : { owner }),
      ...(where.table === undefined ? {} : { table: where.table }),
      cause: error,
    });
  }
}

/** The strategies-content unit fed by `tfiles`, whose export carries the `content-files` manifest. */
function fileUnitOf(catalog: Pick<UnitCatalog, 'units'>): { unit: string; owner: DataOwner } {
  const schema = FILE_OBJECT_UNIT.slice(0, FILE_OBJECT_UNIT.indexOf('.'));
  const found: Unit | undefined = catalog
    .units()
    .find((candidate) => candidate.schema === schema && candidate.legacyTables.some((table) => tableKey(table) === FILES_TABLE));
  if (found === undefined) throw new Error(`no ${schema} unit is fed by ${FILES_TABLE}`);
  return { unit: found.id, owner: found.owner };
}

/**
 * Imports what legacy wrote inside window `input.windowId`: for each unit's legacy tables, the scoped differences between
 * the live legacy rows and the owner's export are applied as `legacy-window` writes; units fed by `tfiles` (or
 * `content.file_object`) also move the store's new and changed files. No retry: a failed attempt is safe to repeat.
 * @throws WindowImportError on any legacy, bridge or owner failure; UnsupportedFileStoreError when the store is not `fileDir`.
 */
export async function importWindow(ctx: WindowImportContext, input: ImportInput): Promise<ImportResult> {
  const session = await guarded(input.windowId, {}, () => Promise.resolve(new ImportSession(ctx, input)));
  const contentTable = tableKey(ctx.config.startupGuard.table);
  let filesWanted = false;
  const fileUnits: { unit: string; owner: DataOwner }[] = [];
  for (const unit of [...new Set(input.units)].sort()) {
    if (unit === FILE_OBJECT_UNIT) {
      filesWanted = true;
      continue;
    }
    const tables = await guarded(input.windowId, {}, () => Promise.resolve(ctx.catalog.legacyTablesOf(unit)));
    for (const table of tables) {
      const target = await guarded(input.windowId, { table }, () => {
        const found = ctx.catalog.unitsForLegacyTable(table).find((candidate) => candidate.unit === unit);
        return found === undefined ? Promise.reject(new Error(`unit ${unit} is not a target of its legacy table ${table}`)) : Promise.resolve(found);
      });
      await guarded(input.windowId, { owner: target.owner, table }, () => importTable(session, unit, table, target));
      if (genericTableKey(ctx.catalog, table) === contentTable) session.result.touchedContent = true;
      if (tableKey(table) === FILES_TABLE) fileUnits.push({ unit, owner: target.owner });
    }
  }
  if (filesWanted || fileUnits.length > 0) {
    await guarded(input.windowId, { table: FILES_TABLE }, async () => {
      const fileUnit = fileUnits[0] ?? fileUnitOf(ctx.catalog);
      await importFiles(session, fileUnit.unit, fileUnit.owner);
    });
  }
  session.result.objectsRemoved.sort();
  return session.result;
}

