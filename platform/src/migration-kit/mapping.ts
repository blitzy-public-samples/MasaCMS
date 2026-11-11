/** Declarative legacy↔target table mappings that drive the migration apply, export and changes handlers. */
import { Buffer } from 'node:buffer';
import { decodeRow, decodeValue, encodeKey, encodeRow, encodeValue } from './canonical.js';
import type { CanonicalColumn, CanonicalType, CanonicalValue } from './canonical.js';
import { assertTenantId, tenantIdForSite } from '../tenancy/index.js';

/** Target column recording the `Program_<id>` schema a folded row came from. */
export const LEGACY_PROGRAM_ID_COLUMN = 'legacy_program_id';

/** Masa pool site of the seed; rows with no resolvable tenant are loaded under its tenant. */
export const DEFAULT_UMBRELLA_SITE_ID = 'umbrella';

/** One mapped column; `type` and `scale` give the canonical value form shared by both sides. */
export interface MappingColumn {
  legacy: string;
  target: string;
  type: CanonicalType;
  scale?: number;
}

/** Selects the receiving owner's rows of a split table; without `column` the discriminator comes with the apply row. */
export interface SplitRule {
  by: 'Type' | 'baseTable' | 'objectClass';
  value: string | number | ReadonlyArray<string | number>;
  column?: string;
}

/** Where a row's tenant comes from: its site column, its parent row, its `Program_<id>` schema, or the umbrella site. */
export type TenantSource =
  | { kind: 'site'; column: string }
  | { kind: 'parent'; parentLegacyTable: string; columns: Record<string, string> }
  | { kind: 'program' }
  | { kind: 'umbrella' };

/** Declaration of one target table; `columns` are listed in legacy catalog order, `key: null` marks a keyless table. */
export interface MappingSpec {
  legacyTable: string;
  targetTable: string;
  unit?: string;
  columns: MappingColumn[];
  key: string[] | null;
  split?: SplitRule;
  fold?: 'Program';
  tenant?: TenantSource;
}

/** Options of `Mapping.toTarget`; `legacyProgramId` is required for folded mappings. */
export interface ToTargetOptions {
  legacyProgramId?: number | undefined;
}

/** A validated, frozen mapping between a legacy table (or an owner's share of it) and one target table. */
export interface Mapping {
  readonly legacyTable: string;
  readonly targetTable: string;
  readonly unit: string;
  readonly key: string[] | null;
  readonly keyless: boolean;
  readonly split: SplitRule | undefined;
  readonly fold: 'Program' | undefined;
  readonly tenant: TenantSource | undefined;
  readonly columns: MappingColumn[];
  readonly legacyColumns: CanonicalColumn[];
  readonly targetColumns: CanonicalColumn[];
  /** True when the row belongs to this owner under the split rule (always true without one). */
  acceptsRow(legacyValues: Readonly<Record<string, unknown>>, discriminator?: string | number | null): boolean;
  /** Target row with pg parameter values for the owned columns, plus `legacy_program_id` when folded. */
  toTarget(legacyValues: Readonly<Record<string, CanonicalValue>>, opts?: ToTargetOptions): Record<string, unknown>;
  /** Legacy-named row with the target row's values as returned by pg. */
  toLegacy(targetRow: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /** Canonical encoding of the target row over `legacyColumns`. */
  encodeLegacy(targetRow: Readonly<Record<string, unknown>>): string;
  /** Canonical key encoding of the target row; the whole-row encoding for keyless mappings. */
  encodeLegacyKey(targetRow: Readonly<Record<string, unknown>>): string;
  /** Owned values (and a split discriminator column) of a row encoded over `columns`, keyed by legacy name. */
  decodeLegacy(columns: readonly CanonicalColumn[], encoding: string): Record<string, CanonicalValue>;
}

/** Raised when a mapping declaration or a row does not fit its mapping; `table` names the legacy table. */
export class MappingError extends Error {
  override readonly name = 'MappingError';
  readonly table: string;

  constructor(table: string, message: string, options?: { cause?: unknown }) {
    super(`${table}: ${message}`, options);
    this.table = table;
  }
}

const MISSING: unique symbol = Symbol('missing');
const PROGRAM_TABLE = /^(?:\[Program_(0|[1-9]\d{0,14})\]|Program_(0|[1-9]\d{0,14}))\.(?:\[([^\]]+)\]|([^.[\]]+))$/i;
const SCHEMA_QUALIFIED = /^[^.\s]+\.[^.\s]+$/;
const PLAIN_TABLE = /^[^.[\]]+$/;

/** Row value of a column, matched case-insensitively because SQL Server column names are case-insensitive. */
function lookup(row: Readonly<Record<string, unknown>>, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === wanted) return row[key];
  }
  return MISSING;
}

/** SQL Server equality form of a text value: trailing spaces are insignificant in its comparisons. */
function trimTrailing(text: string): string {
  return text.replace(/ +$/, '');
}

/** Site id of a row value, or null when it is not a non-empty string; `char(25)` siteID columns arrive space-padded. */
function siteText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const site = trimTrailing(value);
  return site === '' ? null : site;
}

/** Discriminator comparison key: SQL Server compares `Type`, `baseTable` and `objectClass` case- and padding-insensitively. */
function discriminatorKey(value: string | number | bigint | Buffer): string {
  return trimTrailing(Buffer.isBuffer(value) ? value.toString('utf8') : String(value)).toLowerCase();
}

function splitValues(split: SplitRule): ReadonlyArray<string | number> {
  return typeof split.value === 'string' || typeof split.value === 'number' ? [split.value] : split.value;
}

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts names case-insensitively, breaking ties by exact spelling. */
function sortNames(names: string[]): string[] {
  return names.sort((a, b) => codeUnitOrder(a.toLowerCase(), b.toLowerCase()) || codeUnitOrder(a, b));
}

function canonicalColumn(name: string, column: MappingColumn): CanonicalColumn {
  return Object.freeze(column.type === 'd' ? { name, type: column.type, scale: column.scale } : { name, type: column.type });
}

/** pg parameter for one canonical value: `i`/`d` as canonical text, `f` as number, `t` as `YYYY-MM-DD HH:MM:SS.mmm`, `b` as Buffer. */
function targetValue(table: string, column: MappingColumn, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (column.type === 's') {
    if (typeof raw !== 'string') throw new MappingError(table, `column ${column.legacy} expects text`);
    return raw;
  }
  if (column.type === 'b' && Buffer.isBuffer(raw)) return raw;
  const opts = { scale: column.scale, column: column.legacy };
  let canonical: CanonicalValue;
  try {
    canonical = decodeValue(column.type, encodeValue(column.type, raw, opts), opts);
  } catch (cause) {
    throw new MappingError(table, `column ${column.legacy} does not hold a canonical ${column.type} value`, { cause });
  }
  if (typeof canonical !== 'string') return canonical;
  if (column.type === 'f') return Number(canonical);
  return column.type === 't' ? canonical.replace('T', ' ') : canonical;
}

function frozen<T>(items: T[]): T[] {
  return Object.freeze(items) as T[];
}

function describeType(column: CanonicalColumn): string {
  return column.type === 'd' ? `d(${String(column.scale)})` : column.type;
}

/** Validated split rule with its accepted discriminator keys; the discriminator column takes the declared spelling. */
function prepareSplit(
  table: string,
  rule: SplitRule,
  byLegacy: ReadonlyMap<string, MappingColumn>,
  keyless: boolean,
): { split: SplitRule; accepted: ReadonlySet<string> } {
  const values = splitValues(rule);
  if (values.length === 0) throw new MappingError(table, 'split rule lists no values');
  const mapped = rule.column === undefined ? undefined : byLegacy.get(rule.column.toLowerCase());
  // A keyless row is hashed over every legacy column, so its discriminator cannot stay unmapped.
  if (keyless && rule.column !== undefined && mapped === undefined) {
    throw new MappingError(table, `keyless mapping must map its discriminator column ${rule.column}`);
  }
  const column = mapped?.legacy ?? rule.column;
  const value = typeof rule.value === 'object' ? Object.freeze([...rule.value]) : rule.value;
  const split: SplitRule = Object.freeze(column === undefined ? { by: rule.by, value } : { by: rule.by, value, column });
  return { split, accepted: new Set(values.map(discriminatorKey)) };
}

/** Tenant source used when none is declared: the `Program_<id>` schema when folded, else a mapped `siteID` column. */
function defaultTenant(folded: boolean, byLegacy: ReadonlyMap<string, MappingColumn>): TenantSource | undefined {
  if (folded) return { kind: 'program' };
  const site = byLegacy.get('siteid');
  return site === undefined ? undefined : { kind: 'site', column: site.legacy };
}

function freezeTenant(source: TenantSource): TenantSource {
  return Object.freeze(source.kind === 'parent' ? { ...source, columns: Object.freeze({ ...source.columns }) } : { ...source });
}

/** Validates the declared columns, returning them keyed by lower-cased legacy name in declared order. */
function indexColumns(table: string, declared: readonly MappingColumn[], reserved: ReadonlySet<string>): Map<string, MappingColumn> {
  if (declared.length === 0) throw new MappingError(table, 'maps no columns');
  const byLegacy = new Map<string, MappingColumn>();
  const targets = new Set<string>();
  for (const column of declared) {
    const lower = column.legacy.toLowerCase();
    if (byLegacy.has(lower)) throw new MappingError(table, `legacy column ${column.legacy} is mapped twice`);
    if (targets.has(column.target)) throw new MappingError(table, `target column ${column.target} is mapped twice`);
    if (reserved.has(column.target)) throw new MappingError(table, `target column ${column.target} is managed by the platform`);
    try {
      encodeValue(column.type, null, { scale: column.scale, column: column.legacy });
    } catch (cause) {
      throw new MappingError(table, `column ${column.legacy} has an invalid canonical type or scale`, { cause });
    }
    byLegacy.set(lower, Object.freeze({ ...column }));
    targets.add(column.target);
  }
  return byLegacy;
}

/** Validates a mapping declaration once and returns the frozen mapping. */
export function defineMapping(spec: MappingSpec): Mapping {
  const table = spec.legacyTable;
  const keyless = spec.key === null;
  const folded = spec.fold === 'Program';
  const unit = spec.unit ?? spec.targetTable;
  if (!SCHEMA_QUALIFIED.test(spec.targetTable) || !SCHEMA_QUALIFIED.test(unit)) {
    throw new MappingError(table, `target table ${spec.targetTable} and unit ${unit} must be schema-qualified`);
  }
  if (folded) {
    // The repository hashes keyless rows over every stored column, which would then include legacy_program_id.
    if (keyless) throw new MappingError(table, 'a keyless table cannot be folded');
    if (!PLAIN_TABLE.test(table)) throw new MappingError(table, 'a folded mapping names its table without the Program_<id> schema');
  }
  const reserved = new Set(['tenant_id', ...(keyless ? ['legacy_row_hash', 'occurrence'] : []), ...(folded ? [LEGACY_PROGRAM_ID_COLUMN] : [])]);
  const byLegacy = indexColumns(table, spec.columns, reserved);

  let key: string[] | null = null;
  if (spec.key !== null) {
    if (spec.key.length === 0) throw new MappingError(table, 'key lists no columns; declare key: null for a table without a primary key');
    key = spec.key.map((name) => {
      const column = byLegacy.get(name.toLowerCase());
      if (column === undefined) throw new MappingError(table, `key column ${name} is not a mapped legacy column`);
      return column.legacy;
    });
    if (new Set(key).size !== key.length) throw new MappingError(table, 'key lists a column twice');
  }
  const prepared = spec.split === undefined ? undefined : prepareSplit(table, spec.split, byLegacy, keyless);
  const split = prepared?.split;

  const declaredTenant = spec.tenant ?? defaultTenant(folded, byLegacy);
  if (declaredTenant?.kind === 'site' && (byLegacy.get(declaredTenant.column.toLowerCase())?.type ?? 's') !== 's') {
    throw new MappingError(table, `tenant column ${declaredTenant.column} must be text`);
  }
  if (declaredTenant?.kind === 'parent' && Object.keys(declaredTenant.columns).length === 0) {
    throw new MappingError(table, 'parent tenant source lists no key columns');
  }
  const tenant = declaredTenant === undefined ? undefined : freezeTenant(declaredTenant);

  const columns = frozen([...byLegacy.values()]);
  const legacyColumns = frozen(columns.map((column) => canonicalColumn(column.legacy, column)));
  const programColumn: CanonicalColumn = Object.freeze({ name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' });
  const targetColumns = frozen([...columns.map((column) => canonicalColumn(column.target, column)), ...(folded ? [programColumn] : [])]);
  const frozenKey = key === null ? null : frozen(key);

  const acceptsRow = (legacyValues: Readonly<Record<string, unknown>>, discriminator?: string | number | null): boolean => {
    if (prepared === undefined) return true;
    const fromRow = prepared.split.column === undefined ? MISSING : lookup(legacyValues, prepared.split.column);
    const value: unknown = fromRow === MISSING ? discriminator : fromRow;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint' && !Buffer.isBuffer(value)) return false;
    return prepared.accepted.has(discriminatorKey(value));
  };

  const toTarget = (legacyValues: Readonly<Record<string, CanonicalValue>>, opts: ToTargetOptions = {}): Record<string, unknown> => {
    const entries = columns.map((column): [string, unknown] => {
      const raw = lookup(legacyValues, column.legacy);
      if (raw === MISSING) throw new MappingError(table, `row has no value for column ${column.legacy}`);
      return [column.target, targetValue(table, column, raw)];
    });
    if (folded) {
      const id = opts.legacyProgramId;
      if (id === undefined || !Number.isSafeInteger(id) || id < 0) {
        throw new MappingError(table, 'a folded row needs a non-negative integer legacyProgramId');
      }
      entries.push([LEGACY_PROGRAM_ID_COLUMN, String(id)]);
    }
    return Object.fromEntries(entries);
  };

  const toLegacy = (targetRow: Readonly<Record<string, unknown>>): Record<string, unknown> =>
    Object.fromEntries(columns.map((column): [string, unknown] => {
      if (!Object.hasOwn(targetRow, column.target)) throw new MappingError(table, `target row has no column ${column.target}`);
      return [column.legacy, targetRow[column.target]];
    }));

  const encodeLegacy = (targetRow: Readonly<Record<string, unknown>>): string => encodeRow(legacyColumns, toLegacy(targetRow));

  const encodeLegacyKey = (targetRow: Readonly<Record<string, unknown>>): string =>
    frozenKey === null ? encodeLegacy(targetRow) : encodeKey(legacyColumns, frozenKey, toLegacy(targetRow));

  const decodeLegacy = (requestColumns: readonly CanonicalColumn[], encoding: string): Record<string, CanonicalValue> => {
    let decoded: Record<string, CanonicalValue>;
    try {
      decoded = decodeRow(requestColumns, encoding);
    } catch (cause) {
      throw new MappingError(table, 'row encoding does not match its columns', { cause });
    }
    const byName = new Map(requestColumns.map((column) => [column.name.toLowerCase(), column]));
    const entries = legacyColumns.map((owned): [string, CanonicalValue] => {
      const source = byName.get(owned.name.toLowerCase());
      if (source === undefined) throw new MappingError(table, `row columns lack owned column ${owned.name}`);
      if (describeType(source) !== describeType(owned)) {
        throw new MappingError(table, `column ${owned.name} is mapped as ${describeType(owned)} but encoded as ${describeType(source)}`);
      }
      return [owned.name, decoded[source.name] ?? null];
    });
    const discriminator = split?.column;
    if (discriminator !== undefined && !byLegacy.has(discriminator.toLowerCase())) {
      const source = byName.get(discriminator.toLowerCase());
      if (source !== undefined) entries.push([discriminator, decoded[source.name] ?? null]);
    }
    return Object.fromEntries(entries);
  };

  return Object.freeze({
    legacyTable: table,
    targetTable: spec.targetTable,
    unit,
    key: frozenKey,
    keyless,
    split,
    fold: folded ? 'Program' : undefined,
    tenant,
    columns,
    legacyColumns,
    targetColumns,
    acceptsRow,
    toTarget,
    toLegacy,
    encodeLegacy,
    encodeLegacyKey,
    decodeLegacy,
  } satisfies Mapping);
}


/** `Program_<id>.<table>`, the legacy name of a per-program fixture table. */
export function programTableName(programId: number, table: string): string {
  if (!Number.isSafeInteger(programId) || programId < 0) throw new MappingError(table, 'program id must be a non-negative integer');
  if (!PLAIN_TABLE.test(table)) throw new MappingError(table, 'program table name must be unqualified and unbracketed');
  return `Program_${String(programId)}.${table}`;
}

/** Program id and table of `Program_<id>.<table>` or `[Program_<id>].[<table>]`; null for any other name. */
export function parseProgramTable(name: string): { programId: number; table: string } | null {
  const match = PROGRAM_TABLE.exec(name);
  if (match === null) return null;
  return { programId: Number(match[1] ?? match[2]), table: match[3] ?? match[4] ?? '' };
}

/** Lookups the orchestrator supplies: the umbrella site, parent-row sites and `synthetic.program_site`. */
export interface TenantLookups {
  umbrellaSiteId: string;
  parentSiteId?(parentLegacyTable: string, parentKey: Record<string, unknown>): string | null | undefined;
  programSiteId?(programId: number): string | null | undefined;
}

/** A row's tenant and site; `orphan` marks a row placed under the umbrella tenant because its own was unresolvable. */
export interface ResolvedTenant {
  tenantId: string;
  siteId: string;
  orphan: boolean;
}

function sourceSite(
  source: TenantSource,
  row: Readonly<Record<string, unknown>>,
  lookups: TenantLookups,
  legacyProgramId: number | undefined,
): string | null {
  switch (source.kind) {
    case 'site':
      return siteText(lookup(row, source.column));
    case 'parent': {
      const parentKey: Array<[string, unknown]> = [];
      for (const [child, parent] of Object.entries(source.columns)) {
        const value = lookup(row, child);
        if (value === MISSING || value === null || value === undefined) return null;
        parentKey.push([parent, value]);
      }
      return siteText(lookups.parentSiteId?.(source.parentLegacyTable, Object.fromEntries(parentKey)));
    }
    case 'program':
      return legacyProgramId === undefined ? null : siteText(lookups.programSiteId?.(legacyProgramId));
    case 'umbrella':
      return siteText(lookups.umbrellaSiteId);
  }
}

/** Tenant of a legacy row from its source; an unresolvable row resolves to the umbrella tenant with `orphan: true`. */
export function resolveTenant(
  source: TenantSource,
  row: Readonly<Record<string, unknown>>,
  lookups: TenantLookups,
  opts: { legacyProgramId?: number | undefined } = {},
): ResolvedTenant {
  const site = sourceSite(source, row, lookups, opts.legacyProgramId);
  if (site !== null) return { tenantId: tenantIdForSite(site), siteId: site, orphan: false };
  const umbrella = siteText(lookups.umbrellaSiteId) ?? lookups.umbrellaSiteId;
  return { tenantId: tenantIdForSite(umbrella), siteId: umbrella, orphan: true };
}

/** Throws `MappingError` when a site-sourced row's site belongs to a tenant other than the batch tenant. */
export function assertBatchTenant(mapping: Mapping, legacyValues: Readonly<Record<string, unknown>>, tenantId: string): void {
  const source = mapping.tenant;
  if (source?.kind !== 'site') return;
  const site = siteText(lookup(legacyValues, source.column));
  if (site === null) return;
  if (tenantIdForSite(site) !== assertTenantId(tenantId)) {
    throw new MappingError(mapping.legacyTable, `site column ${source.column} names a site outside the batch tenant`);
  }
}

function coverageKey(mapping: Mapping): string {
  if (mapping.split === undefined) return mapping.legacyTable;
  return `${mapping.legacyTable}{${mapping.split.by}=${splitValues(mapping.split).map(String).join(',')}}`;
}

/** Owned legacy columns, sorted, per legacy table (suffixed `{<by>=<value>}` when split); mappings sharing a key merge. */
export function mappingCoverage(mappings: readonly Mapping[]): Record<string, string[]> {
  const byKey = new Map<string, Map<string, string>>();
  for (const mapping of mappings) {
    const key = coverageKey(mapping);
    const owned = byKey.get(key) ?? new Map<string, string>();
    for (const column of mapping.legacyColumns) {
      if (!owned.has(column.name.toLowerCase())) owned.set(column.name.toLowerCase(), column.name);
    }
    byKey.set(key, owned);
  }
  return Object.fromEntries([...byKey].map(([key, owned]): [string, string[]] => [key, sortNames([...owned.values()])]));
}

type CoverageIndex = Map<string, { table: string; columns: Map<string, string> }>;

function indexCoverage(coverage: Readonly<Record<string, readonly string[]>>): CoverageIndex {
  const index: CoverageIndex = new Map();
  for (const [table, names] of Object.entries(coverage)) {
    const entry = index.get(table.toLowerCase()) ?? { table, columns: new Map<string, string>() };
    for (const name of names) {
      if (!entry.columns.has(name.toLowerCase())) entry.columns.set(name.toLowerCase(), name);
    }
    index.set(table.toLowerCase(), entry);
  }
  return index;
}

function absentColumns(from: CoverageIndex, other: CoverageIndex): Record<string, string[]> {
  const out: Array<[string, string[]]> = [];
  for (const [lower, entry] of from) {
    const present = other.get(lower)?.columns;
    const names = [...entry.columns].filter(([column]) => present?.has(column) !== true).map(([, name]) => name);
    if (names.length > 0) out.push([entry.table, sortNames(names)]);
  }
  return Object.fromEntries(out);
}

/** Columns expected but not mapped (`missing`) and mapped but not expected (`extra`), compared case-insensitively. */
export function diffCoverage(
  expected: Readonly<Record<string, readonly string[]>>,
  actual: Readonly<Record<string, readonly string[]>>,
): { missing: Record<string, string[]>; extra: Record<string, string[]> } {
  const want = indexCoverage(expected);
  const have = indexCoverage(actual);
  return { missing: absentColumns(want, have), extra: absentColumns(have, want) };
}
