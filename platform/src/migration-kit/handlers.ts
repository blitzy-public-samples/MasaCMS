/** Owner side of `/internal/v1/migration/*`: applies, exports, the change feed, position, watermarks and unit gates. */
import { Buffer } from 'node:buffer';
import {
  CanonicalEncodingError,
  decodeRow,
  encodeKey,
  formatCanonicalTimestamp,
  sha256Hex,
  type CanonicalColumn,
  type CanonicalValue,
} from './canonical.js';
import {
  LEGACY_PROGRAM_ID_COLUMN,
  MappingError,
  assertBatchTenant,
  parseProgramTable,
  programTableName,
  type BatchProgram,
  type Mapping,
} from './mapping.js';
import {
  GATE_PHASES,
  MIGRATION_BATCH_TABLE,
  MIGRATION_WATERMARK_TABLE,
  WATERMARK_DIRECTIONS,
  qualified,
  type ChangeOp,
  type WatermarkDirection,
} from './ddl.js';
import {
  GATE_WAIT_MS,
  GateConflictError,
  closeGates,
  createMigrationAuthority,
  ensureUnitGates,
  openGates,
  openOperations,
  readGates,
  setGatePhase,
  type UnitGate,
} from './gates.js';
import {
  CURSOR_START,
  DEFAULT_CHANGES_LIMIT,
  InvalidCursorError,
  MAX_CHANGES_LIMIT,
  currentPosition,
  readChanges,
  type ChangeRow,
} from './cursor.js';
import { RepositoryError, type Repository, type RepositoryRow, type TableDefinition, type WriteContext } from './repository.js';
import { hasWritePositionHeader } from './write-position.js';
import {
  InvalidTenantIdError,
  assertTenantId,
  registeredTenants,
  tenantIdForSite,
  withMetadata,
  withTenant,
  type Queryable,
  type TenantDb,
  type TenantTx,
} from '../tenancy/index.js';
import { OUTBOX_TABLE, outboxDrainCounts, registryTenants, type OutboxDrainCounts } from '../outbox/index.js';
import { INBOX_TABLE, isTopicName } from '../events/index.js';
import { Roles, type Opt2RouteConfig } from '../auth/index.js';
import { z, type FastifyInstance, type FastifyRequest } from '../service-kit/index.js';
import { LegacyApiError } from '../legacy-compat/index.js';
import { serializeError } from '../logging/index.js';

/** Path prefix of every migration endpoint a service exposes. */
export const MIGRATION_PATH_PREFIX = '/internal/v1/migration';

/** Export page size when the caller names none. */
export const DEFAULT_EXPORT_LIMIT = 1000;

/** Largest export page. */
export const MAX_EXPORT_LIMIT = 10_000;

/** Most legacy keys one export request filters by. */
export const MAX_EXPORT_KEYS = 100;

/** Longest `match` text an export accepts. */
export const MAX_EXPORT_MATCH_LENGTH = 4096;

/** Origins of a migration apply; the reverse projector skips their changelog rows. */
export const APPLY_ORIGINS = ['backfill', 'migration-feed', 'legacy-window'] as const;

/** Origin of a migration apply. */
export type ApplyOrigin = (typeof APPLY_ORIGINS)[number];

/** Status of a multi-transaction operation; the projector holds `open` rows and never projects `rolled-back` ones. */
export type OperationStatus = 'open' | 'done' | 'rolled-back';

/** One stored object of an owner's manifest, such as a content file variant or a finance attachment. */
export interface ObjectManifestEntry {
  key: string;
  size: number;
  sha256: string;
  contentType?: string;
  /** Legacy store path, e.g. `<siteid>/cache/file/<fileID>_small.png`. */
  legacyPath?: string;
}

/** One page of an owner's object manifest; `next` is the owner's position after it, null after the last page. */
export interface ObjectManifestPage {
  objects: ObjectManifestEntry[];
  next: string | null;
}

/** One target write an apply performed; `table` is the repository table, rows are as pg returns them. */
export interface AppliedChange {
  unit: string;
  table: string;
  op: ChangeOp;
  before?: RepositoryRow;
  after?: RepositoryRow;
  origin: ApplyOrigin;
  tenantId: string;
}

/** Settings of `registerMigrationHandlers`; `db` defaults to the `createService` pool. */
export interface MigrationHandlerOptions {
  owner: string;
  repository: Repository;
  mappings: readonly Mapping[];
  units: readonly string[];
  db?: TenantDb;
  /** Object manifest of a unit: an array is the whole manifest, returned with the first export page; a page is one manifest page, and the following pages ride on the following export pages. Keyed export pages carry none. */
  exportObjects?(
    tx: TenantTx,
    scope: { unit: string; tenantId: string; after?: string; limit?: number },
  ): Promise<ObjectManifestEntry[] | ObjectManifestPage>;
  /**
   * Writes the `state` events of one applied change in the apply transaction; `write` is the apply's own write
   * context (origin and migration authority), so the service's audited writes for the event pass the unit gate.
   */
  emitStateEvents?(tx: TenantTx, change: AppliedChange, write: WriteContext): Promise<void>;
  /** Statuses of operations; ids it omits fall back to the `open_operation` registry. */
  operationStatus?(db: TenantDb, operationIds: string[]): Promise<Record<string, OperationStatus>>;
  /** Site of a `Program_<id>` schema as `synthetic.program_site` maps it; required when a mapping takes its tenant from the program. */
  programSiteId?(programId: number): string | null | undefined;
}

/** Answer of `POST /apply`; `applied` plus `skipped` is the batch's row count unless it is a duplicate. */
export interface ApplyResponse {
  batchId: string;
  duplicate: boolean;
  applied: number;
  skipped: number;
}

/** One exported row in legacy form; `key` is the whole-row encoding for keyless tables. */
export interface ExportRow {
  key: string;
  row: string;
  hash: string;
  legacyProgramId?: number;
}

/** Rows of one mapping on an export page, encoded over `columns`. */
export interface ExportTable {
  unit: string;
  legacyTable: string;
  targetTable: string;
  keyless: boolean;
  columns: CanonicalColumn[];
  rows: ExportRow[];
}

/** One export page; `next` is the cursor of the following page, null after the last one. */
export interface ExportResponse {
  unit: string;
  tenantId: string;
  tables: ExportTable[];
  next: string | null;
  objects?: ObjectManifestEntry[];
}

/** A changelog row in the legacy form of one mapping; `columns` are legacy names of the changed columns. */
export interface LegacyChange {
  unit: string;
  legacyTable: string;
  key: string;
  before: string | null;
  after: string | null;
  columns: string[];
  legacyProgramId?: number;
}

/** A changelog row with one legacy projection per mapping of its table; none for unmapped tables. */
export interface ProjectedChangeRow extends ChangeRow {
  legacy: LegacyChange[];
}

/** Answer of `GET /changes`. */
export interface ChangesResponse {
  rows: ProjectedChangeRow[];
  cursor: string;
  horizon: string;
  complete: boolean;
  operations: Record<string, OperationStatus>;
}

/** Inbox receipts over every registered tenant; `receipts` maps each asked event id to the tenants that applied it. */
export interface InboxCounts {
  total: number;
  bySubscription: Record<string, number>;
  receipts?: Record<string, string[]>;
}

/** A published outbox event: its id, topic and envelope tenant. */
export interface PublishedEvent {
  eventId: string;
  topic: string;
  tenantId: string;
}

/** Answer of `GET /position`; `outbox` and `inbox` are null when the service has no such table. */
export interface PositionResponse {
  owner: string;
  position: string;
  outbox: OutboxDrainCounts | null;
  inbox: InboxCounts | null;
  /** Published events of the asked `publishedTopics` in every registered tenant, by tenant, topic and id; empty without an outbox. */
  published?: PublishedEvent[];
}

/** One `migration_watermark` row; `finishedAt` is `YYYY-MM-DDTHH:MM:SS.mmm` wall-clock time. */
export interface WatermarkRecord {
  legacyTable: string;
  direction: WatermarkDirection;
  snapshotSeq: number | null;
  backupLsn: string | null;
  finishedAt: string;
}

/** Answer of `POST /gate`. */
export interface GateResponse {
  units: UnitGate[];
}

const ROUTE: { opt2: Opt2RouteConfig } = { opt2: { transport: 'service', requires: [Roles.platformMigration] } };
const EXPORT_CURSOR_COLUMN = '__opt2_export_key';
const ROW_HASH_COLUMN = 'legacy_row_hash';
const OCCURRENCE_COLUMN = 'occurrence';
const WATERMARK_COLUMNS =
  "legacy_table, direction, snapshot_seq::text AS snapshot_seq, backup_lsn::text AS backup_lsn, to_char(finished_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS') AS finished_at";
const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const UPPER_ASCII = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const nonEmpty = z.string().min(1);
const digits = z.string().regex(/^(0|[1-9]\d{0,14})$/).transform(Number);
const tenantFields = { tenantId: nonEmpty.optional(), siteId: nonEmpty.optional() };
const wallClock = z.string().refine((value) => {
  try {
    formatCanonicalTimestamp(value);
    return true;
  } catch {
    return false;
  }
}, 'expected a wall-clock timestamp without a zone');
const watermarkFields = {
  direction: z.enum(WATERMARK_DIRECTIONS),
  snapshotSeq: z.int().min(0).optional(),
  backupLsn: z.string().regex(/^\d{1,25}$/).optional(),
  finishedAt: wallClock,
};
const pageLimit = (max: number) => digits.pipe(z.number().min(1).max(max)).optional();

const applyBodySchema = z.strictObject({
  batchId: nonEmpty,
  origin: z.enum(APPLY_ORIGINS),
  legacyTable: nonEmpty,
  ...tenantFields,
  legacyProgramId: z.int().min(0).optional(),
  columns: z.array(z.strictObject({ name: nonEmpty, type: z.enum(['s', 'i', 'f', 'd', 't', 'b']), scale: z.int().min(0).optional() })).min(1),
  units: z.array(nonEmpty).optional(),
  holderId: nonEmpty.optional(),
  rows: z.array(
    z.strictObject({
      op: z.enum(['upsert', 'delete', 'insert']),
      row: z.string(),
      discriminator: z.union([z.string(), z.number()]).optional(),
    }),
  ),
  watermark: z.strictObject(watermarkFields).optional(),
});

const exportMatchSchema = z
  .string()
  .max(MAX_EXPORT_MATCH_LENGTH)
  .transform((text, ctx): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'match must be JSON text' });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .record(z.string(), z.array(z.union([z.string(), z.int()])).min(1))
      .refine((entries) => Object.keys(entries).length > 0, 'match must name a column'),
  );

const exportQuerySchema = z.strictObject({
  unit: nonEmpty,
  ...tenantFields,
  programId: digits.optional(),
  after: nonEmpty.optional(),
  match: exportMatchSchema.optional(),
  limit: pageLimit(MAX_EXPORT_LIMIT),
  // A repeated query parameter arrives as an array, a single one as a string.
  keys: z.union([nonEmpty.transform((key) => [key]), z.array(nonEmpty).min(1).max(MAX_EXPORT_KEYS)]).optional(),
});

const changesQuerySchema = z.strictObject({ ...tenantFields, after: nonEmpty.optional(), limit: pageLimit(MAX_CHANGES_LIMIT) });

const positionQuerySchema = z.strictObject({
  eventIds: z
    .string()
    .transform((ids) => ids.split(',').map((id) => id.trim()).filter((id) => id !== ''))
    .pipe(z.array(z.uuid()))
    .optional(),
  publishedTopics: z
    .string()
    .transform((topics) => topics.split(',').map((topic) => topic.trim()).filter((topic) => topic !== ''))
    .pipe(z.array(z.string().refine(isTopicName, 'expected a <service>.<entity>.<event>.v<major> topic')))
    .optional(),
});

const watermarkQuerySchema = z.strictObject({ legacyTable: nonEmpty.optional(), direction: z.enum(WATERMARK_DIRECTIONS).optional() });

const watermarkBodySchema = z.strictObject({ legacyTable: nonEmpty, ...watermarkFields });

const gateUnits = z.array(nonEmpty).min(1);
const gateBodySchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('close'),
    units: gateUnits,
    holderId: nonEmpty,
    phase: z.enum(GATE_PHASES).optional(),
    allowLegacy: z.boolean().optional(),
    timeoutMs: z.int().min(1).max(GATE_WAIT_MS).optional(),
  }),
  z.strictObject({ op: z.literal('phase'), units: gateUnits, holderId: nonEmpty, phase: z.enum(GATE_PHASES) }),
  z.strictObject({ op: z.literal('open'), units: gateUnits, holderId: nonEmpty, state: z.enum(['open', 'legacy']).optional() }),
  z.strictObject({ op: z.literal('status'), units: gateUnits.optional(), holderId: nonEmpty.optional() }),
]);

// A row cursor, with the manifest position while a paged manifest continues, or the manifest position alone once the rows are done.
const exportCursorSchema = z.union([
  z.strictObject({ table: nonEmpty, key: z.array(z.string()).min(1), objects: nonEmpty.optional() }),
  z.strictObject({ objects: nonEmpty }),
]);

/** Body of `POST /apply`. */
export type ApplyRequest = z.input<typeof applyBodySchema>;

/** Body of `POST /gate`. */
export type GateRequest = z.input<typeof gateBodySchema>;

/** Body of `POST /watermark`. */
export type WatermarkInput = z.input<typeof watermarkBodySchema>;

type ApplyBody = z.output<typeof applyBodySchema>;
type GateBody = z.output<typeof gateBodySchema>;
type Watermark = z.output<typeof watermarkBodySchema>;
type ExportMatch = z.output<typeof exportMatchSchema>;

/** A mapping with the repository table it writes and its target-to-legacy column names. */
interface PreparedMapping {
  readonly mapping: Mapping;
  readonly table: string;
  readonly definition: TableDefinition;
  readonly legacyNames: ReadonlyMap<string, string>;
}

/** One target table of a unit with its keyset order and the mappings that encode its rows. */
interface ExportSource {
  readonly table: string;
  readonly keyColumns: readonly string[];
  readonly orderExprs: readonly string[];
  readonly hasProgramColumn: boolean;
  readonly mappings: PreparedMapping[];
}

/** One `match` entry bound to the target column every mapping of a source stores it in. */
interface MatchTerm {
  readonly column: string;
  readonly type: 's' | 'i';
  readonly values: readonly (string | number)[];
}

/** Where an export page resumes: the source index and key it reads after, and the manifest position while a paged manifest continues. */
interface ExportStart {
  readonly index: number;
  readonly key: string[] | undefined;
  readonly objects: string | undefined;
}

/** Target key tuples a keyed export selects, over one list of target key columns. */
interface KeyFilter {
  readonly columns: readonly string[];
  readonly tuples: readonly (readonly unknown[])[];
}

/** A malformed request parameter detected after schema validation. */
class InvalidRequestError extends Error {
  override readonly name: string = 'InvalidRequestError';
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** True for a PostgreSQL data exception (SQLSTATE class 22), such as a bound value beyond its column type. */
function isDataException(err: unknown): boolean {
  return /^22/.test(String((err as { code?: unknown }).code));
}

/** The legacy 400 type of a request problem; row problems count only for applies; undefined keeps the error's own response. */
function rejectionOf(err: unknown, rows: boolean): 'invalidParameters' | 'badRequest' | undefined {
  if (
    err instanceof z.ZodError ||
    err instanceof InvalidRequestError ||
    err instanceof InvalidTenantIdError ||
    err instanceof InvalidCursorError
  ) {
    return 'invalidParameters';
  }
  if (!rows) return undefined;
  if (err instanceof MappingError || err instanceof CanonicalEncodingError) return 'invalidParameters';
  return err instanceof RepositoryError || (err instanceof Error && isDataException(err)) ? 'badRequest' : undefined;
}

/** Runs a handler body, answering request problems with the legacy 400 and logging their sanitized error. */
async function handle<T>(request: FastifyRequest, fn: () => T | Promise<T>, rows = false): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const type = rejectionOf(err, rows);
    if (type === undefined) throw err;
    request.log.warn({ error: serializeError(err) }, 'migration request rejected');
    // An empty params echo keeps a rejected batch's rows out of the error body.
    throw new LegacyApiError(type, { params: {} });
  }
}

/** The tenant named by exactly one of `tenantId` and `siteId`. */
function tenantOf(input: { tenantId?: string | undefined; siteId?: string | undefined }): string {
  if (input.tenantId !== undefined && input.siteId === undefined) return assertTenantId(input.tenantId);
  if (input.siteId !== undefined && input.tenantId === undefined) return tenantIdForSite(input.siteId);
  throw new InvalidRequestError('exactly one of tenantId and siteId is required');
}

/** `Program_<id>.<table>` for per-program names, the name unchanged otherwise. */
function normalisedLegacyName(name: string): string {
  const program = parseProgramTable(name);
  return program === null ? name : programTableName(program.programId, program.table);
}

/** Validates a mapping against the handler units and its repository table at registration. */
function prepareMapping(repository: Repository, units: ReadonlySet<string>, mapping: Mapping): PreparedMapping {
  const fail = (problem: string): Error => new Error(`Mapping ${mapping.legacyTable} -> ${mapping.targetTable}: ${problem}`);
  if (!units.has(mapping.unit)) throw fail(`unit ${mapping.unit} is not among the handler units`);
  // The target table's schema part is the logical service name; the repository's schema is the physical one.
  const table = mapping.targetTable.slice(mapping.targetTable.indexOf('.') + 1);
  const definition = repository.definition(table);
  if (definition.unit !== mapping.unit) throw fail(`repository gates ${table} as unit ${String(definition.unit)}`);
  const stored = new Map(definition.columns.map((column) => [column.name, column]));
  const mismatch = mapping.targetColumns.find((column) => {
    const found = stored.get(column.name);
    return found === undefined || found.type !== column.type || (column.type === 'd' && found.scale !== column.scale);
  });
  if (mismatch !== undefined) throw fail(`target column ${mismatch.name} is missing or has another canonical type`);
  return { mapping, table, definition, legacyNames: new Map(mapping.columns.map((column) => [column.target, column.legacy])) };
}

/** Groups prepared mappings into each unit's target tables, in declaration order. */
function exportSources(prepared: readonly PreparedMapping[]): Map<string, ExportSource[]> {
  const byUnit = new Map<string, ExportSource[]>();
  for (const entry of prepared) {
    const sources = byUnit.get(entry.mapping.unit) ?? [];
    const existing = sources.find((source) => source.table === entry.table);
    if (existing !== undefined) {
      existing.mappings.push(entry);
      continue;
    }
    const { definition } = entry;
    const types = new Map(definition.columns.map((column) => [column.name, column.type]));
    const keyColumns = definition.key ?? [ROW_HASH_COLUMN, OCCURRENCE_COLUMN];
    sources.push({
      table: entry.table,
      keyColumns,
      // Text keys compare bytewise, so the order and the keyset predicate never depend on the database collation.
      orderExprs: keyColumns.map((name) => (types.get(name) === 's' ? `(${ident(name)})::text COLLATE "C"` : ident(name))),
      hasProgramColumn: types.has(LEGACY_PROGRAM_ID_COLUMN),
      mappings: [entry],
    });
    byUnit.set(entry.mapping.unit, sources);
  }
  return byUnit;
}

/** Throws MappingError unless the encoded columns carry every owned column, with its type, and the split column. */
function assertEncodedColumns(mapping: Mapping, columns: readonly CanonicalColumn[]): void {
  const sent = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const wrong = mapping.legacyColumns.find((owned) => {
    const column = sent.get(owned.name.toLowerCase());
    return column === undefined || column.type !== owned.type || (owned.type === 'd' && column.scale !== owned.scale);
  });
  if (wrong !== undefined) throw new MappingError(mapping.legacyTable, `columns do not carry owned column ${wrong.name} as ${wrong.type}`);
  const split = mapping.split?.column;
  if (split !== undefined && !sent.has(split.toLowerCase())) {
    throw new MappingError(mapping.legacyTable, `columns do not carry the split column ${split}`);
  }
}

/** The handler database: `options.db`, else the `createService` pool; throws when there is neither. */
function handlerDb(app: FastifyInstance, options: MigrationHandlerOptions): TenantDb {
  const runtime = app.opt2 as { db?: TenantDb } | undefined;
  const db = options.db ?? runtime?.db;
  if (db === undefined) throw new Error('registerMigrationHandlers needs options.db or a createService pool');
  return db;
}

/** Cursor of the following export page from the row and manifest positions; null when neither continues. */
function encodeExportCursor(rows: { table: string; key: readonly string[] } | null, objects: string | null): string | null {
  if (rows === null && objects === null) return null;
  // Without a manifest position the cursor is the plain row cursor, so owners returning a whole manifest keep their cursors.
  const cursor = { ...rows, ...(objects === null ? {} : { objects }) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Position of an export cursor among the unit's tables and in its paged manifest; throws InvalidRequestError when it
 * does not fit them, or carries a manifest position for an owner without a manifest.
 */
function parseExportCursor(text: string, sources: readonly ExportSource[], hasManifest: boolean): ExportStart {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidRequestError('export cursor is not base64url JSON');
  }
  const cursor = exportCursorSchema.parse(raw);
  if (cursor.objects !== undefined && !hasManifest) throw new InvalidRequestError('export cursor carries a manifest position, but the owner has no object manifest');
  if (!('table' in cursor)) return { index: sources.length, key: undefined, objects: cursor.objects };
  const index = sources.findIndex((source) => source.table === cursor.table);
  if (index < 0 || sources[index]?.keyColumns.length !== cursor.key.length) {
    throw new InvalidRequestError('export cursor does not name a table of this unit');
  }
  const { keyColumns, mappings } = sources[index];
  try {
    encodeKey((mappings[0] as PreparedMapping).definition.columns, keyColumns, Object.fromEntries(keyColumns.map((name, i) => [name, cursor.key[i]])));
  } catch (err) {
    throw err instanceof CanonicalEncodingError ? new InvalidRequestError('export cursor key does not fit its key column types') : err;
  }
  return { index, key: cursor.key, objects: cursor.objects };
}

/**
 * The source's key filters for legacy key encodings, one per distinct target key of its mappings; throws
 * InvalidRequestError for a keyless mapping or a key that does not decode over a mapping's key columns.
 */
function keyFilters(source: ExportSource, keys: readonly string[]): KeyFilter[] {
  const byColumns = new Map<string, { columns: string[]; tuples: Map<string, unknown[]> }>();
  for (const { mapping } of source.mappings) {
    for (const key of keys) {
      let target: Record<string, unknown>;
      try {
        target = mapping.targetKey(key);
      } catch (err) {
        throw err instanceof MappingError ? new InvalidRequestError(`export keys do not fit the key of ${mapping.legacyTable}`) : err;
      }
      const columns = Object.keys(target);
      const id = JSON.stringify(columns);
      const filter = byColumns.get(id) ?? { columns, tuples: new Map<string, unknown[]>() };
      const tuple = Object.values(target);
      filter.tuples.set(JSON.stringify(tuple), tuple);
      byColumns.set(id, filter);
    }
  }
  return [...byColumns.values()].map(({ columns, tuples }) => ({ columns, tuples: [...tuples.values()] }));
}

/** `match` bound to target columns of `source`; undefined (export it whole) unless every mapping stores each entry's column in one text or integer column. */
function matchTerms(source: ExportSource, match: ExportMatch): MatchTerm[] | undefined {
  const { definition } = source.mappings[0] as PreparedMapping;
  const terms: MatchTerm[] = [];
  for (const [name, values] of Object.entries(match)) {
    const wanted = name.toLowerCase();
    const targets = new Set(source.mappings.map(({ mapping }) => mapping.columns.find((column) => column.legacy.toLowerCase() === wanted)?.target));
    const [column] = targets;
    const type = definition.columns.find((stored) => stored.name === column)?.type;
    if (targets.size !== 1 || column === undefined || (type !== 's' && type !== 'i')) return undefined;
    terms.push({ column, type, values });
  }
  return terms;
}

/** OR of `terms` compared as SQL Server does, also true for non-ASCII text the caller compares itself; `false` when no term has a value. */
function matchSql(terms: readonly MatchTerm[], bind: (value: string[]) => string): string {
  const predicates = terms.flatMap(({ column, type, values }) => {
    const text = `(${ident(column)})::text`;
    if (type === 's') {
      const wanted = values.map((value) => String(value).replace(/ +$/, '').toLowerCase()).filter((value) => !value.includes('\u0000'));
      if (wanted.length === 0) return [];
      return [
        `(translate(rtrim(${text}, ' '), '${UPPER_ASCII}', '${UPPER_ASCII.toLowerCase()}') = ANY(${bind(wanted)}::text[])` +
          ` OR octet_length(${text}) <> char_length(${text}))`,
      ];
    }
    const integers = values.flatMap((value) => (typeof value === 'number' || INTEGER_TEXT.test(value) ? [BigInt(value).toString()] : []));
    // Canonical integer columns include booleans, whose text is true or false.
    const wanted = integers.flatMap((value) => (value === '1' ? [value, 'true'] : value === '0' ? [value, 'false'] : [value]));
    return wanted.length === 0 ? [] : [`${text} = ANY(${bind(wanted)}::text[])`];
  });
  return predicates.length === 0 ? 'false' : `(${predicates.join(' OR ')})`;
}

/**
 * Up to `limit` rows of one table after the keyset position `after` and within `match`, each with its key values as text;
 * `filters` keeps only rows of the listed keys.
 */
async function selectExportRows(
  tx: TenantTx,
  source: ExportSource,
  after: readonly string[] | undefined,
  programId: number | undefined,
  match: readonly MatchTerm[] | undefined,
  limit: number,
  filters: readonly KeyFilter[] | undefined,
): Promise<RepositoryRow[]> {
  const values: unknown[] = [tx.tenantId];
  const bind = (value: unknown): string => `$${String(values.push(value))}`;
  const where = ['"tenant_id" = $1'];
  if (programId !== undefined) where.push(`${ident(LEGACY_PROGRAM_ID_COLUMN)} = ${bind(programId)}`);
  if (after !== undefined) {
    const params = after.map(bind);
    where.push(`(${source.orderExprs.join(', ')}) > (${params.join(', ')})`);
  }
  if (match !== undefined) where.push(matchSql(match, bind));
  if (filters !== undefined) {
    const matches = filters.map(({ columns, tuples }) => {
      const rows = tuples.map((tuple) => `(${tuple.map(bind).join(', ')})`);
      return `(${columns.map(ident).join(', ')}) IN (${rows.join(', ')})`;
    });
    where.push(`(${matches.join(' OR ')})`);
  }
  const limitParam = bind(limit);
  const { rows } = await tx.query(
    `SELECT *, ARRAY[${source.keyColumns.map((name) => `(${ident(name)})::text`).join(', ')}] AS ${ident(EXPORT_CURSOR_COLUMN)}
       FROM ${qualified(tx.schema, source.table)} WHERE ${where.join(' AND ')}
      ORDER BY ${source.orderExprs.map((expr) => `${expr} NULLS FIRST`).join(', ')} LIMIT ${limitParam}`,
    values,
  ).catch((err: unknown) => {
    // Column widths and NUL characters are beyond the canonical types; binding such a cursor value, programId or key raises SQLSTATE class 22.
    throw (after !== undefined || programId !== undefined || filters !== undefined) && isDataException(err)
      ? new InvalidRequestError('export cursor key, programId or keys do not fit their columns')
      : err;
  });
  return rows;
}

/** One target row in the legacy form of `mapping`. */
function exportRow(mapping: Mapping, row: RepositoryRow): ExportRow {
  const encoded = mapping.encodeLegacy(row);
  const out: ExportRow = { key: mapping.keyless ? encoded : mapping.encodeLegacyKey(row), row: encoded, hash: sha256Hex(encoded) };
  if (mapping.fold !== undefined) out.legacyProgramId = Number(row[LEGACY_PROGRAM_ID_COLUMN]);
  return out;
}

interface WatermarkDbRow {
  legacy_table: string;
  direction: WatermarkDirection;
  snapshot_seq: string | null;
  backup_lsn: string | null;
  finished_at: string;
}

function toWatermark(row: WatermarkDbRow): WatermarkRecord {
  return {
    legacyTable: row.legacy_table,
    direction: row.direction,
    snapshotSeq: row.snapshot_seq === null ? null : Number(row.snapshot_seq),
    backupLsn: row.backup_lsn,
    finishedAt: row.finished_at,
  };
}

/** Inserts or replaces the watermark of `legacyTable` and `direction` in the caller's transaction. */
async function upsertWatermark(
  q: Queryable,
  schema: string,
  legacyTable: string,
  mark: Omit<Watermark, 'legacyTable'>,
): Promise<WatermarkRecord> {
  const { rows } = await q.query<WatermarkDbRow>(
    `INSERT INTO ${qualified(schema, MIGRATION_WATERMARK_TABLE)} (legacy_table, direction, snapshot_seq, backup_lsn, finished_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (legacy_table, direction) DO UPDATE
       SET snapshot_seq = EXCLUDED.snapshot_seq, backup_lsn = EXCLUDED.backup_lsn, finished_at = EXCLUDED.finished_at
     RETURNING ${WATERMARK_COLUMNS}`,
    [legacyTable, mark.direction, mark.snapshotSeq ?? null, mark.backupLsn ?? null, mark.finishedAt],
  );
  return toWatermark(rows[0] as WatermarkDbRow);
}

/**
 * Registers the migration endpoints of one owner under {@link MIGRATION_PATH_PREFIX}, each requiring `platform.migration`.
 * Throws when `registerWritePositionHeader(app)` has not run, no database is available, a mapping or unit does not fit the repository,
 * or a mapping takes its tenant from `Program_<id>` without `options.programSiteId`.
 */
export function registerMigrationHandlers(app: FastifyInstance, options: MigrationHandlerOptions): void {
  const { owner, repository } = options;
  const db = handlerDb(app, options);
  if (!hasWritePositionHeader(app)) throw new Error('registerMigrationHandlers needs registerWritePositionHeader(app) first');
  if (owner !== repository.owner) throw new Error(`Owner ${owner} differs from the repository owner ${repository.owner}`);
  const units = [...new Set(options.units)];
  const unitSet: ReadonlySet<string> = new Set(units);
  const gated = new Set(repository.units());
  const ungated = units.find((unit) => !gated.has(unit));
  if (ungated !== undefined) throw new Error(`Unit ${ungated} has no table definition in repository ${repository.schema}`);
  const prepared = options.mappings.map((mapping) => prepareMapping(repository, unitSet, mapping));
  const programSourced = options.mappings.find((mapping) => mapping.tenant?.kind === 'program');
  if (programSourced !== undefined && options.programSiteId === undefined) {
    throw new Error(`Mapping ${programSourced.legacyTable} -> ${programSourced.targetTable}: a Program_<id> tenant needs options.programSiteId`);
  }
  const byLegacyTable = new Map<string, PreparedMapping[]>();
  const byTargetTable = new Map<string, PreparedMapping[]>();
  for (const entry of prepared) {
    const legacyKey = entry.mapping.legacyTable.toLowerCase();
    byLegacyTable.set(legacyKey, [...(byLegacyTable.get(legacyKey) ?? []), entry]);
    byTargetTable.set(entry.table, [...(byTargetTable.get(entry.table) ?? []), entry]);
  }
  const sourcesByUnit = exportSources(prepared);

  app.addHook('onReady', async () => {
    await ensureUnitGates(db, units);
  });

  /** Applies one decoded row through one mapping; null when a delete found nothing to remove. */
  async function applyRow(
    tx: TenantTx,
    entry: PreparedMapping,
    op: ApplyBody['rows'][number]['op'],
    row: RepositoryRow,
    ctx: WriteContext,
  ): Promise<Pick<AppliedChange, 'op' | 'before' | 'after'> | null> {
    const { mapping, table, definition } = entry;
    if (op === 'delete') {
      const removed = mapping.keyless
        ? await repository.deleteOne(tx, table, row, ctx)
        : await repository.delete(tx, table, row, ctx);
      return removed === null ? null : { op: 'delete', before: removed };
    }
    if (mapping.keyless) {
      if (op !== 'insert') throw new InvalidRequestError(`${mapping.legacyTable} has no key; rows are inserted or deleted`);
      return { op: 'insert', after: await repository.insert(tx, table, row, ctx) };
    }
    if (op !== 'upsert') throw new InvalidRequestError(`${mapping.legacyTable} is keyed; rows are upserted or deleted`);
    const key = definition.key ?? [];
    // The stored row is read first only to report the change as an insert or an update with its before-image.
    const { rows } = await tx.query(
      `SELECT * FROM ${qualified(tx.schema, table)} WHERE "tenant_id" = $1 AND ${key
        .map((column, i) => `${ident(column)} = $${i + 2}`)
        .join(' AND ')} FOR UPDATE`,
      [tx.tenantId, ...key.map((column) => row[column] ?? null)],
    );
    const before = rows[0];
    const after = await repository.upsert(tx, table, row, ctx);
    return before === undefined ? { op: 'insert', after } : { op: 'update', before, after };
  }

  async function apply(body: ApplyBody): Promise<ApplyResponse> {
    const tenantId = tenantOf(body);
    const program = parseProgramTable(body.legacyTable);
    if (program !== null && body.legacyProgramId !== undefined && body.legacyProgramId !== program.programId) {
      throw new InvalidRequestError('legacyProgramId contradicts the Program_<id> table name');
    }
    const legacyTable = program?.table ?? body.legacyTable;
    const legacyProgramId = program?.programId ?? body.legacyProgramId;
    const candidates = byLegacyTable.get(legacyTable.toLowerCase());
    if (candidates === undefined) throw new InvalidRequestError(`${owner} maps no legacy table ${legacyTable}`);
    if (legacyProgramId !== undefined && candidates.some((entry) => entry.mapping.fold === undefined)) {
      throw new InvalidRequestError(`${legacyTable} is not a per-program table`);
    }
    const batchProgram: BatchProgram = { legacyProgramId, programSiteId: options.programSiteId };
    // A program-sourced tenant does not depend on the rows, so a batch that writes none is held to it as well.
    for (const entry of candidates) {
      if (entry.mapping.tenant?.kind === 'program') assertBatchTenant(entry.mapping, {}, tenantId, batchProgram);
    }
    const unmapped = body.units?.find((unit) => !candidates.some((entry) => entry.mapping.unit === unit));
    if (unmapped !== undefined) throw new InvalidRequestError(`${owner} maps ${legacyTable} to no unit ${unmapped}`);
    const allowed = body.units === undefined ? undefined : new Set(body.units);
    const writable = candidates.filter((entry) => allowed === undefined || allowed.has(entry.mapping.unit));
    for (const entry of writable) assertEncodedColumns(entry.mapping, body.columns);
    const batchTable = legacyProgramId === undefined ? body.legacyTable : programTableName(legacyProgramId, legacyTable);
    const ctx: WriteContext = {
      origin: body.origin,
      authority: createMigrationAuthority({ batchId: body.batchId, holderId: body.holderId }),
      requestId: body.batchId,
    };

    return withTenant(db, tenantId, async (tx) => {
      const recorded = await tx.query(
        `INSERT INTO ${qualified(tx.schema, MIGRATION_BATCH_TABLE)} (tenant_id, batch_id, legacy_table, origin, row_count)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING batch_id`,
        [tenantId, body.batchId, batchTable, body.origin, body.rows.length],
      );
      if (recorded.rows.length === 0) return { batchId: body.batchId, duplicate: true, applied: 0, skipped: 0 };
      if (legacyProgramId !== undefined) {
        // Bound alone, a program id beyond its column type is told apart from a row value the database rejects.
        for (const table of new Set(writable.map((entry) => entry.table))) {
          await tx
            .query(`SELECT 1 FROM ${qualified(tx.schema, table)} WHERE ${ident(LEGACY_PROGRAM_ID_COLUMN)} = $1 LIMIT 0`, [legacyProgramId])
            .catch((err: unknown) => {
              throw isDataException(err) ? new InvalidRequestError('legacyProgramId does not fit the legacy_program_id column') : err;
            });
        }
      }
      let applied = 0;
      for (const input of body.rows) {
        const values = decodeRow(body.columns, input.row);
        let wrote = false;
        for (const entry of writable) {
          if (!entry.mapping.acceptsRow(values, input.discriminator)) continue;
          assertBatchTenant(entry.mapping, values, tenantId, batchProgram);
          const target = entry.mapping.toTarget(values, { legacyProgramId });
          const change = await applyRow(tx, entry, input.op, target, ctx);
          if (change === null) continue;
          wrote = true;
          await options.emitStateEvents?.(
            tx,
            { ...change, unit: entry.mapping.unit, table: entry.table, origin: body.origin, tenantId },
            ctx,
          );
        }
        if (wrote) applied += 1;
      }
      if (body.watermark !== undefined) await upsertWatermark(tx, tx.schema, batchTable, body.watermark);
      return { batchId: body.batchId, duplicate: false, applied, skipped: body.rows.length - applied };
    });
  }

  async function exportUnit(query: z.output<typeof exportQuerySchema>): Promise<ExportResponse> {
    const tenantId = tenantOf(query);
    if (!unitSet.has(query.unit)) throw new InvalidRequestError(`${owner} declares no unit ${query.unit}`);
    const sources = sourcesByUnit.get(query.unit) ?? [];
    const { programId, keys } = query;
    if (programId !== undefined && sources.some((source) => !source.hasProgramColumn)) {
      throw new InvalidRequestError(`unit ${query.unit} is not folded from per-program tables`);
    }
    const filters = keys === undefined ? undefined : sources.map((source) => keyFilters(source, keys));
    const start: ExportStart =
      query.after === undefined
        ? { index: 0, key: undefined, objects: undefined }
        : parseExportCursor(query.after, sources, options.exportObjects !== undefined);
    const limit = query.limit ?? DEFAULT_EXPORT_LIMIT;
    let remaining = limit;

    // No gate wait: exports run while a window or transition holds the unit's gates.
    return withTenant(db, tenantId, async (tx) => {
      const tables: ExportTable[] = [];
      let rowsNext: { table: string; key: string[] } | null = null;
      for (let index = start.index; index < sources.length && remaining > 0; index += 1) {
        const source = sources[index] as ExportSource;
        const match = query.match === undefined ? undefined : matchTerms(source, query.match);
        const rows = await selectExportRows(tx, source, index === start.index ? start.key : undefined, programId, match, remaining, filters?.[index]);
        for (const { mapping } of source.mappings) {
          tables.push({
            unit: mapping.unit,
            legacyTable: mapping.legacyTable,
            targetTable: mapping.targetTable,
            keyless: mapping.keyless,
            columns: mapping.legacyColumns,
            rows: rows.map((row) => exportRow(mapping, row)),
          });
        }
        remaining -= rows.length;
        const last = rows.at(-1);
        if (remaining === 0 && last !== undefined) rowsNext = { table: source.table, key: last[EXPORT_CURSOR_COLUMN] as string[] };
      }
      const page: ExportResponse = { unit: query.unit, tenantId, tables, next: null };
      let objectsNext: string | null = null;
      // The manifest lists objects, not keyed rows, so a keyed page carries none.
      if (options.exportObjects !== undefined && keys === undefined && (query.after === undefined || start.objects !== undefined)) {
        const scope = { unit: query.unit, tenantId, limit, ...(start.objects === undefined ? {} : { after: start.objects }) };
        const manifest = await options.exportObjects(tx, scope);
        if (Array.isArray(manifest)) {
          if (start.objects !== undefined) throw new InvalidRequestError('export cursor carries a manifest position, but the unit returns its whole manifest');
          page.objects = manifest;
        } else {
          page.objects = manifest.objects;
          objectsNext = manifest.next;
        }
      }
      page.next = encodeExportCursor(rowsNext, objectsNext);
      return page;
    });
  }

  /** The legacy forms of one changelog row, one per mapping of its table. */
  function projectChange(row: ChangeRow): LegacyChange[] {
    const entries = byTargetTable.get(row.table);
    if (entries === undefined) return [];
    const columns = (entries[0] as PreparedMapping).definition.columns;
    const before = row.before === null ? undefined : decodeRow(columns, row.before);
    const after = row.after === null ? undefined : decodeRow(columns, row.after);
    // The changelog's CHECK constraint guarantees at least one image; the before-image locates the legacy row.
    const located = (before ?? after) as Record<string, CanonicalValue>;
    return entries.map(({ mapping, legacyNames }) => {
      const change: LegacyChange = {
        unit: mapping.unit,
        legacyTable: mapping.legacyTable,
        key: mapping.encodeLegacyKey(located),
        before: before === undefined ? null : mapping.encodeLegacy(before),
        after: after === undefined ? null : mapping.encodeLegacy(after),
        columns: row.columns.flatMap((name) => {
          const legacy = legacyNames.get(name);
          return legacy === undefined ? [] : [legacy];
        }),
      };
      if (mapping.fold !== undefined) change.legacyProgramId = Number(located[LEGACY_PROGRAM_ID_COLUMN]);
      return change;
    });
  }

  /** Status of every operation the page's rows belong to. */
  async function operationStatuses(rows: readonly ChangeRow[]): Promise<Record<string, OperationStatus>> {
    const ids = [...new Set(rows.flatMap((row) => (row.operationId === null ? [] : [row.operationId])))];
    if (ids.length === 0) return {};
    const reported = (await options.operationStatus?.(db, ids)) ?? {};
    const unreported = ids.filter((id) => !Object.hasOwn(reported, id));
    const open = new Set(unreported.length === 0 ? [] : (await openOperations(db)).map((operation) => operation.operationId));
    return Object.fromEntries(
      ids.map((id): [string, OperationStatus] => [id, Object.hasOwn(reported, id) ? (reported[id] as OperationStatus) : open.has(id) ? 'open' : 'done']),
    );
  }

  /** Inbox receipts of every registered tenant, each counted in its own tenant transaction. */
  async function inboxCounts(eventIds: readonly string[] | undefined): Promise<InboxCounts> {
    const table = qualified(db.schema, INBOX_TABLE);
    const asked = eventIds === undefined ? undefined : [...new Set(eventIds.map((id) => id.toLowerCase()))];
    const bySubscription = new Map<string, number>();
    const receipts = new Map<string, string[]>((asked ?? []).map((id) => [id, []]));
    let total = 0;
    const tenants = new Set((await registeredTenants(db)).map((entry) => entry.tenantId));
    for (const tenantId of tenants) {
      await withTenant(db, tenantId, async (tx) => {
        const counted = await tx.query<{ subscription: string; count: string }>(
          `SELECT subscription, count(*)::text AS count FROM ${table} GROUP BY subscription`,
        );
        for (const { subscription, count } of counted.rows) {
          bySubscription.set(subscription, (bySubscription.get(subscription) ?? 0) + Number(count));
          total += Number(count);
        }
        if (asked === undefined) return;
        const found = await tx.query<{ event_id: string }>(
          `SELECT event_id::text AS event_id FROM ${table} WHERE event_id = ANY($1::uuid[])`,
          [asked],
        );
        for (const { event_id: eventId } of found.rows) receipts.get(eventId)?.push(tx.tenantId);
      });
    }
    const counts: InboxCounts = { total, bySubscription: Object.fromEntries(bySubscription) };
    if (asked !== undefined) counts.receipts = Object.fromEntries(receipts);
    return counts;
  }

  /** Published outbox events of `topics` in every registered tenant, each tenant read in its own transaction. */
  async function publishedEvents(topics: readonly string[]): Promise<PublishedEvent[]> {
    const table = qualified(db.schema, OUTBOX_TABLE);
    const tenantIds = [...new Set((await registryTenants(db)).map((id) => id.toLowerCase()))].sort();
    const published: PublishedEvent[] = [];
    // Sequential, so the listing holds at most one pooled connection at a time.
    for (const tenantId of tenantIds) {
      await withTenant(db, tenantId, async (tx) => {
        const { rows } = await tx.query<{ event_id: string; topic: string }>(
          `SELECT event_id::text AS event_id, topic FROM ${table}` +
            ' WHERE published_at IS NOT NULL AND topic = ANY($1::text[]) ORDER BY topic, event_id',
          [topics],
        );
        for (const row of rows) published.push({ eventId: row.event_id, topic: row.topic, tenantId: tx.tenantId });
      });
    }
    return published;
  }

  async function position(query: z.output<typeof positionQuerySchema>): Promise<PositionResponse> {
    const present = await withMetadata(db, async (tx) => {
      const { rows } = await tx.query<{ outbox: boolean; inbox: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS outbox, to_regclass($2) IS NOT NULL AS inbox',
        [qualified(tx.schema, OUTBOX_TABLE), qualified(tx.schema, INBOX_TABLE)],
      );
      return rows[0] as { outbox: boolean; inbox: boolean };
    });
    const answer: PositionResponse = {
      owner,
      position: await currentPosition(db),
      // A service that publishes no events has no outbox: null tells a drain there is nothing to wait for.
      outbox: present.outbox ? await outboxDrainCounts(db) : null,
      inbox: present.inbox ? await inboxCounts(query.eventIds) : null,
    };
    if (query.publishedTopics !== undefined) {
      answer.published = present.outbox ? await publishedEvents(query.publishedTopics) : [];
    }
    return answer;
  }

  function runGate(body: GateBody): Promise<UnitGate[]> {
    switch (body.op) {
      case 'close':
        return closeGates(db, {
          units: body.units,
          holderId: body.holderId,
          phase: body.phase,
          allowLegacy: body.allowLegacy,
          timeoutMs: body.timeoutMs,
        });
      case 'phase':
        return setGatePhase(db, { units: body.units, holderId: body.holderId, phase: body.phase });
      case 'open':
        return openGates(db, { units: body.units, holderId: body.holderId, state: body.state });
      case 'status':
        return readGates(db, body.units ?? units);
    }
  }

  app.post(`${MIGRATION_PATH_PREFIX}/apply`, { config: ROUTE }, (request) =>
    handle(request, () => apply(applyBodySchema.parse(request.body)), true),
  );

  app.get(`${MIGRATION_PATH_PREFIX}/export`, { config: ROUTE }, (request) =>
    handle(request, () => exportUnit(exportQuerySchema.parse(request.query))),
  );

  app.get(`${MIGRATION_PATH_PREFIX}/changes`, { config: ROUTE }, async (request): Promise<ChangesResponse> => {
    const page = await handle(request, async () => {
      const query = changesQuerySchema.parse(request.query);
      return readChanges(db, {
        tenantId: tenantOf(query),
        after: query.after ?? CURSOR_START,
        limit: query.limit ?? DEFAULT_CHANGES_LIMIT,
      });
    });
    const rows = page.rows.map((row): ProjectedChangeRow => ({ ...row, legacy: projectChange(row) }));
    // Read after the rows, so a status is never older than the rows it describes.
    const operations = await operationStatuses(page.rows);
    return { rows, cursor: page.cursor, horizon: page.horizon, complete: page.complete, operations };
  });

  app.get(`${MIGRATION_PATH_PREFIX}/position`, { config: ROUTE }, async (request) => {
    return position(await handle(request, () => positionQuerySchema.parse(request.query)));
  });

  app.get(`${MIGRATION_PATH_PREFIX}/watermark`, { config: ROUTE }, async (request): Promise<WatermarkRecord[]> => {
    const query = await handle(request, () => watermarkQuerySchema.parse(request.query));
    const legacyTable = query.legacyTable === undefined ? null : normalisedLegacyName(query.legacyTable);
    const { rows } = await withMetadata(db, (tx) =>
      tx.query<WatermarkDbRow>(
        `SELECT ${WATERMARK_COLUMNS} FROM ${qualified(tx.schema, MIGRATION_WATERMARK_TABLE)}
          WHERE ($1::text IS NULL OR legacy_table = $1) AND ($2::text IS NULL OR direction = $2)
          ORDER BY legacy_table, direction`,
        [legacyTable, query.direction ?? null],
      ),
    );
    return rows.map(toWatermark);
  });

  app.post(`${MIGRATION_PATH_PREFIX}/watermark`, { config: ROUTE }, async (request): Promise<WatermarkRecord> => {
    const { legacyTable, ...mark } = await handle(request, () => watermarkBodySchema.parse(request.body));
    return withMetadata(db, (tx) => upsertWatermark(tx, tx.schema, normalisedLegacyName(legacyTable), mark));
  });

  app.post(`${MIGRATION_PATH_PREFIX}/gate`, { config: ROUTE }, async (request, reply) => {
    const body = await handle(request, () => {
      const parsed = gateBodySchema.parse(request.body);
      const foreign = (parsed.units ?? []).filter((unit) => !unitSet.has(unit));
      if (foreign.length > 0) throw new InvalidRequestError(`${owner} declares no unit ${foreign.join(', ')}`);
      return parsed;
    });
    try {
      const result: GateResponse = { units: await runGate(body) };
      return result;
    } catch (err) {
      if (err instanceof GateConflictError) return reply.code(409).send({ error: 'gate-conflict', units: err.units });
      throw err;
    }
  });
}
