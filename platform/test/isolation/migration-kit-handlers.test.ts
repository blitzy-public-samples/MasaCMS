import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordedRoutes } from '../../src/auth/hooks.js';
import { LOCAL_USER_TOKEN, Roles } from '../../src/auth/index.js';
import { inboxSql } from '../../src/events/index.js';
import { REDACTED, createLogger, validateLogRecord, type Logger } from '../../src/logging/index.js';
import { decodeRow, encodeKey, encodeRow, sha256Hex, type CanonicalColumn } from '../../src/migration-kit/canonical.js';
import { migrationKitSql } from '../../src/migration-kit/ddl.js';
import { GATE_WAIT_MS, createMigrationAuthority, endOperation, isMigrationAuthority } from '../../src/migration-kit/gates.js';
import {
  DEFAULT_EXPORT_LIMIT,
  MAX_EXPORT_KEYS,
  MAX_EXPORT_MATCH_LENGTH,
  MAX_PUBLISHED_LIMIT,
  MIGRATION_PATH_PREFIX,
  registerMigrationHandlers,
  type AppliedChange,
  type ChangesResponse,
  type ExportResponse,
  type ExportRow,
  type MigrationHandlerOptions,
  type ObjectManifestEntry,
  type ObjectManifestPage,
  type OperationStatus,
  type PositionResponse,
  type PublishedEvent,
  type WatermarkRecord,
} from '../../src/migration-kit/handlers.js';
import { defineMapping, type MappingColumn } from '../../src/migration-kit/mapping.js';
import {
  createRepository,
  type Repository,
  type RepositoryRow,
  type TableDefinition,
  type WriteContext,
} from '../../src/migration-kit/repository.js';
import { WRITE_POSITION_HEADER_LC, registerWritePositionHeader } from '../../src/migration-kit/write-position.js';
import { OutboxPayloadError, outboxSql } from '../../src/outbox/index.js';
import { recordUnpublishedEvents } from '../../src/service-kit/context.js';
import { UNPUBLISHED_EVENTS_HEADER, createService } from '../../src/service-kit/create-service.js';
import { loadEnv, type BaseEnv } from '../../src/service-kit/env.js';
import { rlsSql, tenantIdForSite, tenantRegistrySql, withMetadata, type TenantDb } from '../../src/tenancy/index.js';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, seedRegistry } from '../../src/testing/fixtures.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';
import { ROLE_SET, authHeadersFor, testVerifier, type RoleSubject } from '../../src/testing/tokens.js';

const OWNER = 'mk-handlers';
const BASE = 'mk_handlers';
const UNITS = ['mk.item', 'mk.tag_member', 'mk.memo', 'mk.score'];
const SORTED_UNITS = [...UNITS].sort();
// The horizon is cluster-wide, so another client's long transaction on a shared cluster can hold it back this long.
const HORIZON_WAIT_MS = 120_000;
/** Timeout of a test that waits on the horizon once. */
const HORIZON_TEST_TIMEOUT_MS = HORIZON_WAIT_MS + 30_000;

const ENV: BaseEnv = loadEnv(undefined, {
  PORT: '26012',
  OPT2_SERVICE_NAME: OWNER,
  OPT2_ENV: 'local',
  OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
  OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
  OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
  OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-mk-handlers-unused'),
  TZ: 'UTC',
});

const ITEM_LEGACY: CanonicalColumn[] = [
  { name: 'ItemID', type: 's' },
  { name: 'SiteID', type: 's' },
  { name: 'Name', type: 's' },
  { name: 'Qty', type: 'i' },
];
const TAG_LEGACY: CanonicalColumn[] = [
  { name: 'Label', type: 's' },
  { name: 'Weight', type: 'i' },
];
const NOTE_LEGACY: CanonicalColumn[] = [
  { name: 'NoteID', type: 's' },
  { name: 'Type', type: 's' },
  { name: 'Body', type: 's' },
];
const MEMO_LEGACY: CanonicalColumn[] = [
  { name: 'NoteID', type: 's' },
  { name: 'Body', type: 's' },
];
const SCORE_LEGACY: CanonicalColumn[] = [
  { name: 'ScoreID', type: 's' },
  { name: 'Points', type: 'i' },
];

const ITEM_COLUMNS: MappingColumn[] = [
  { legacy: 'ItemID', target: 'item_id', type: 's' },
  { legacy: 'SiteID', target: 'site_id', type: 's' },
  { legacy: 'Name', target: 'name', type: 's' },
  { legacy: 'Qty', target: 'qty', type: 'i' },
];
const MEMO_COLUMNS: MappingColumn[] = [
  { legacy: 'NoteID', target: 'note_id', type: 's' },
  { legacy: 'Body', target: 'body', type: 's' },
];

const ITEM_MAPPING = defineMapping({ legacyTable: 'tItems', targetTable: 'mk.item', columns: ITEM_COLUMNS, key: ['ItemID'] });
const TAG_MAPPING = defineMapping({
  legacyTable: 'tTagMembers',
  targetTable: 'mk.tag_member',
  columns: [
    { legacy: 'Label', target: 'label', type: 's' },
    { legacy: 'Weight', target: 'weight', type: 'i' },
  ],
  key: null,
});
const NOTE_MAPPING = defineMapping({
  legacyTable: 'tNotes',
  targetTable: 'mk.memo',
  columns: MEMO_COLUMNS,
  key: ['NoteID'],
  split: { by: 'Type', value: 'Memo', column: 'Type' },
});
const ARCHIVE_MAPPING = defineMapping({ legacyTable: 'tNoteArchive', targetTable: 'mk.memo', columns: MEMO_COLUMNS, key: ['NoteID'] });
const SCORE_MAPPING = defineMapping({
  legacyTable: 'Scores',
  targetTable: 'mk.score',
  fold: 'Program',
  columns: [
    { legacy: 'ScoreID', target: 'score_id', type: 's' },
    { legacy: 'Points', target: 'points', type: 'i' },
  ],
  key: ['ScoreID'],
});
const MAPPINGS = [ITEM_MAPPING, TAG_MAPPING, NOTE_MAPPING, ARCHIVE_MAPPING, SCORE_MAPPING];

const TABLES: TableDefinition[] = [
  {
    table: 'item',
    unit: 'mk.item',
    key: ['item_id'],
    columns: [
      { name: 'tenant_id', type: 's' },
      { name: 'item_id', type: 's' },
      { name: 'site_id', type: 's' },
      { name: 'name', type: 's' },
      { name: 'qty', type: 'i' },
    ],
  },
  {
    table: 'tag_member',
    unit: 'mk.tag_member',
    key: null,
    columns: [
      { name: 'tenant_id', type: 's' },
      { name: 'label', type: 's' },
      { name: 'weight', type: 'i' },
      { name: 'legacy_row_hash', type: 's' },
      { name: 'occurrence', type: 'i' },
    ],
  },
  {
    table: 'memo',
    unit: 'mk.memo',
    key: ['note_id'],
    columns: [
      { name: 'tenant_id', type: 's' },
      { name: 'note_id', type: 's' },
      { name: 'body', type: 's' },
    ],
  },
  {
    table: 'score',
    unit: 'mk.score',
    key: ['legacy_program_id', 'score_id'],
    columns: [
      { name: 'tenant_id', type: 's' },
      { name: 'legacy_program_id', type: 'i' },
      { name: 'score_id', type: 's' },
      { name: 'points', type: 'i' },
    ],
  },
  {
    table: 'note_log',
    key: ['note_id'],
    columns: [
      { name: 'tenant_id', type: 's' },
      { name: 'note_id', type: 's' },
      { name: 'text', type: 's' },
    ],
  },
];

const ITEM_SQL = [
  `CREATE TABLE ${BASE}.item (tenant_id uuid NOT NULL, item_id text NOT NULL, site_id text, name varchar(50), qty integer, PRIMARY KEY (tenant_id, item_id));`,
  rlsSql(BASE, 'item'),
].join('\n');

const TABLES_SQL = [
  ITEM_SQL,
  `CREATE TABLE ${BASE}.tag_member (tenant_id uuid NOT NULL, label text, weight integer, legacy_row_hash text NOT NULL,`,
  '  occurrence integer NOT NULL, PRIMARY KEY (tenant_id, legacy_row_hash, occurrence));',
  rlsSql(BASE, 'tag_member'),
  `CREATE TABLE ${BASE}.memo (tenant_id uuid NOT NULL, note_id text NOT NULL, body text, PRIMARY KEY (tenant_id, note_id));`,
  rlsSql(BASE, 'memo'),
  `CREATE TABLE ${BASE}.score (tenant_id uuid NOT NULL, legacy_program_id integer NOT NULL, score_id text NOT NULL, points integer,`,
  '  PRIMARY KEY (tenant_id, legacy_program_id, score_id));',
  rlsSql(BASE, 'score'),
  `CREATE TABLE ${BASE}.note_log (tenant_id uuid NOT NULL, note_id text NOT NULL, text text, PRIMARY KEY (tenant_id, note_id));`,
  rlsSql(BASE, 'note_log'),
].join('\n');

const LEDGER_COLUMNS: CanonicalColumn[] = [
  { name: 'entry_id', type: 's' },
  { name: 'kind', type: 's' },
  { name: 'amount', type: 'd', scale: 2 },
  { name: 'booked_at', type: 't' },
  { name: 'seq', type: 'i' },
];

/** Tables of units with no legacy table, which no mapping covers: a keyed ledger and a keyless ledger log. */
const LEDGER_TABLES: TableDefinition[] = [
  { table: 'ledger', unit: 'mk.ledger', key: ['entry_id'], columns: [{ name: 'tenant_id', type: 's' }, ...LEDGER_COLUMNS] },
  {
    table: 'ledger_log',
    unit: 'mk.ledger_log',
    key: null,
    columns: [
      { name: 'tenant_id', type: 's' },
      { name: 'line', type: 's' },
      { name: 'legacy_row_hash', type: 's' },
      { name: 'occurrence', type: 'i' },
    ],
  },
];

const LEDGER_SQL = [
  `CREATE TABLE ${BASE}.ledger (tenant_id uuid NOT NULL, entry_id text NOT NULL, kind text, amount numeric(9,2), booked_at timestamp(3) without time zone,`,
  '  seq integer, PRIMARY KEY (tenant_id, entry_id));',
  rlsSql(BASE, 'ledger'),
].join('\n');

const LEDGER_REPOSITORY = createRepository({ owner: OWNER, schema: BASE, tables: [...TABLES, ...LEDGER_TABLES] });

type RowOp = 'upsert' | 'insert' | 'delete';
type LegacyValues = Record<string, string | number | null>;

/** Logger whose JSON lines are collected in `lines`. */
function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const destination = { write: (chunk: string): void => void lines.push(JSON.parse(chunk) as Record<string, unknown>) };
  return { logger: createLogger({ service: OWNER, version: '1.0.0', env: 'local', destination }), lines };
}

/** A createService app for the owner, optionally over `pool`. */
function serviceApp(pool?: TenantDb, logger: Logger = captureLogger().logger): Promise<FastifyInstance> {
  return createService({ name: OWNER, version: '1.0.0', env: ENV, verifierOverride: testVerifier(OWNER), logger, ...(pool === undefined ? {} : { pool }) });
}

/** The role-matrix subject named `name`. */
function subject(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no role subject ${name}`);
  return found;
}

/** Apply rows of `columns` encoded from legacy values. */
function rowsOf(columns: readonly CanonicalColumn[], entries: ReadonlyArray<[RowOp, LegacyValues]>): { op: RowOp; row: string }[] {
  return entries.map(([op, values]) => ({ op, row: encodeRow(columns, values) }));
}

/** The export row of legacy values under `key` (null for keyless tables). */
function exported(columns: readonly CanonicalColumn[], key: string[] | null, values: LegacyValues, legacyProgramId?: number): ExportRow {
  const row = encodeRow(columns, values);
  const out: ExportRow = { key: key === null ? row : encodeKey(columns, key, values), row, hash: sha256Hex(row) };
  if (legacyProgramId !== undefined) out.legacyProgramId = legacyProgramId;
  return out;
}

/** The object manifest the test app reports for a unit and tenant. */
function objectsOf(unit: string, tenantId: string): ObjectManifestEntry[] {
  return [{ key: `${tenantId}/${unit}`, size: 3, sha256: sha256Hex('obj'), contentType: 'text/plain' }];
}

/** `value` in the base64url JSON wire form of an export cursor. */
function cursorText(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function item(id: string, site: string, name: string, qty: number): LegacyValues {
  return { ItemID: id, SiteID: site, Name: name, Qty: qty };
}

function expectRejected(res: LightMyRequestResponse, message = 'Invalid parameters'): void {
  expect(res.statusCode, res.body).toBe(400);
  expect(res.json()).toMatchObject({ error: { message, code: 'invalid_request' } });
}

const idleDb: TenantDb = {
  schema: BASE,
  withTenant: () => Promise.reject(new Error('the database must not be reached')),
  withMetadata: () => Promise.reject(new Error('the database must not be reached')),
  end: () => Promise.resolve(),
};

/** Program-to-site map of the test apps: each test binds the programs it applies to the site it applies them under. */
const programSites = new Map<number, string>();

/** Maps each of `programIds` to `site`. */
function bindPrograms(site: string, ...programIds: number[]): void {
  for (const programId of programIds) programSites.set(programId, site);
}

/** Item names on which the shared state emitter fails: with its topic contract's rejection, or with any other error. */
const UNCONTRACTED_NAME = 'Uncontracted';
const EMITTER_FAILURE_NAME = 'Emitter failure';
/** Item name whose state event the shared emitter records as committed but unpublished, as an incomplete in-request flush does. */
const UNPUBLISHED_NAME = 'Unpublished';
const UNPUBLISHED_EVENT_ID = '0f7c6a52-0c8e-4d8e-9a43-0000000000aa';
const ITEM_TOPIC = 'mk.item.changed.v1';
const UNCONTRACTED_ERROR = '/itemId must match format "cfUuid"';

/** Handler options every test app shares. */
const BASE_OPTIONS = { owner: OWNER, mappings: MAPPINGS, units: UNITS, programSiteId: (programId: number) => programSites.get(programId) };

describe('registerMigrationHandlers registration', () => {
  const repository = createRepository({ owner: OWNER, schema: BASE, tables: TABLES });
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function freshApp(pool?: TenantDb, withHeader = true): Promise<FastifyInstance> {
    const app = await serviceApp(pool);
    apps.push(app);
    if (withHeader) registerWritePositionHeader(app);
    return app;
  }

  it('declares every migration endpoint under the prefix with platform.migration on the service transport', async () => {
    const app = await freshApp();
    registerMigrationHandlers(app, { ...BASE_OPTIONS, repository, db: idleDb });
    const routes = recordedRoutes(app)
      .filter((route) => route.url.startsWith(MIGRATION_PATH_PREFIX) && route.method !== 'HEAD')
      .map((route) => [route.method, route.url, route.config]);
    const config = { transport: 'service', requires: [Roles.platformMigration] };
    expect(MIGRATION_PATH_PREFIX).toBe('/internal/v1/migration');
    expect(routes).toEqual(
      [
        ['POST', 'apply'],
        ['GET', 'export'],
        ['GET', 'changes'],
        ['GET', 'position'],
        ['GET', 'watermark'],
        ['POST', 'watermark'],
        ['POST', 'gate'],
      ].map(([method, name]) => [method, `${MIGRATION_PATH_PREFIX}/${name as string}`, config]),
    );
  });

  it.each([
    ['logs the successful requests of the polled /changes alone at debug', 'opt2Log', 'changes', { successLevel: 'debug' }],
    ['answers an incomplete outbox flush of /apply alone with the legacy 503', 'opt2Outbox', 'apply', { incompleteFlush: 'unavailable' }],
  ] as const)('%s', async (_label, key, only, value) => {
    const app = await freshApp();
    const routeConfigs: unknown[][] = [];
    app.addHook('onRoute', (route) => {
      if (route.url.startsWith(MIGRATION_PATH_PREFIX)) routeConfigs.push([route.method, route.url, route.config?.[key]]);
    });
    registerMigrationHandlers(app, { ...BASE_OPTIONS, repository, db: idleDb });
    expect(routeConfigs).toEqual(
      [
        ['POST', 'apply'],
        ['GET', 'export'],
        ['GET', 'changes'],
        ['GET', 'position'],
        ['GET', 'watermark'],
        ['POST', 'watermark'],
        ['POST', 'gate'],
      ].map(([method, name]) => [method, `${MIGRATION_PATH_PREFIX}/${name as string}`, name === only ? value : undefined]),
    );
  });

  it.each([
    [
      'without registerWritePositionHeader',
      { db: idleDb },
      false,
      'registerMigrationHandlers needs registerWritePositionHeader(app) first',
    ],
    ['without options.db or a createService pool', {}, true, 'registerMigrationHandlers needs options.db or a createService pool'],
    ['for an owner other than the repository owner', { db: idleDb, owner: 'people' }, true, `Owner people differs from the repository owner ${OWNER}`],
    ['for a unit no table definition gates', { db: idleDb, units: [...UNITS, 'mk.ghost'] }, true, `Unit mk.ghost has no table definition in repository ${BASE}`],
    [
      'for a mapping whose unit is not a handler unit',
      { db: idleDb, units: ['mk.tag_member'], mappings: [ITEM_MAPPING] },
      true,
      'Mapping tItems -> mk.item: unit mk.item is not among the handler units',
    ],
    [
      'for a mapping whose table the repository gates as another unit',
      { db: idleDb, mappings: [defineMapping({ legacyTable: 'tItems', targetTable: 'mk.item', unit: 'mk.memo', columns: ITEM_COLUMNS, key: ['ItemID'] })] },
      true,
      'Mapping tItems -> mk.item: repository gates item as unit mk.item',
    ],
    [
      'for a mapped column with another canonical type',
      {
        db: idleDb,
        mappings: [defineMapping({ legacyTable: 'tItems', targetTable: 'mk.item', columns: [...ITEM_COLUMNS.slice(0, 3), { legacy: 'Qty', target: 'qty', type: 's' }], key: ['ItemID'] })],
      },
      true,
      'Mapping tItems -> mk.item: target column qty is missing or has another canonical type',
    ],
    [
      'for a mapped column the table lacks',
      {
        db: idleDb,
        mappings: [defineMapping({ legacyTable: 'tItems', targetTable: 'mk.item', columns: [...ITEM_COLUMNS, { legacy: 'Colour', target: 'colour', type: 's' }], key: ['ItemID'] })],
      },
      true,
      'Mapping tItems -> mk.item: target column colour is missing or has another canonical type',
    ],
    [
      'for a mapping taking its tenant from Program_<id> without options.programSiteId',
      { db: idleDb, programSiteId: undefined },
      true,
      'Mapping Scores -> mk.score: a Program_<id> tenant needs options.programSiteId',
    ],
    ['for a target-only table the repository does not declare', { db: idleDb, targetOnlyTables: ['ghost'] }, true, `ghost: is not a declared table of schema ${BASE}`],
    ['for a target-only table without a unit', { db: idleDb, targetOnlyTables: ['note_log'] }, true, 'Target-only table note_log: unit undefined is not among the handler units'],
    [
      'for a target-only table whose unit is not a handler unit',
      { db: idleDb, repository: LEDGER_REPOSITORY, targetOnlyTables: ['ledger'] },
      true,
      'Target-only table ledger: unit mk.ledger is not among the handler units',
    ],
    ['for a target-only table of a mapped unit', { db: idleDb, targetOnlyTables: ['item'] }, true, 'Target-only table item: unit mk.item is also mapped from a legacy table'],
    [
      'for a keyless target-only table',
      { db: idleDb, repository: LEDGER_REPOSITORY, units: [...UNITS, 'mk.ledger_log'], targetOnlyTables: ['ledger_log'] },
      true,
      'Target-only table ledger_log: has no key',
    ],
  ] as [string, Partial<MigrationHandlerOptions>, boolean, string][])('throws %s', async (_label, overrides, withHeader, message) => {
    const app = await freshApp(undefined, withHeader);
    expect(() => registerMigrationHandlers(app, { ...BASE_OPTIONS, repository, ...overrides })).toThrow(message);
  });

  it('uses the createService pool when options.db is absent', async () => {
    const app = await freshApp(idleDb);
    expect(() => registerMigrationHandlers(app, { ...BASE_OPTIONS, repository })).not.toThrow();
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('migration endpoints against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: Repository;
  let app: FastifyInstance;
  let logLines: Record<string, unknown>[];
  let migration: Record<string, string>;
  let gateway: Record<string, string>;
  const emitted: AppliedChange[] = [];
  const emitContexts: WriteContext[] = [];
  const statusCalls: string[][] = [];
  let sites = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: OWNER,
      extraSql: [migrationKitSql(BASE), tenantRegistrySql(BASE), outboxSql(BASE), inboxSql(BASE), TABLES_SQL],
    });
    repo = createRepository({ owner: OWNER, schema: handle.schema, tables: TABLES });
    const { logger, lines } = captureLogger();
    logLines = lines;
    app = await serviceApp(handle.app, logger);
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, {
      ...BASE_OPTIONS,
      repository: repo,
      exportObjects: (_tx, scope) => Promise.resolve(objectsOf(scope.unit, scope.tenantId)),
      emitStateEvents: (_tx, change, write) => {
        emitted.push(change);
        emitContexts.push(write);
        const name = change.after?.name;
        if (name === UNCONTRACTED_NAME) return Promise.reject(new OutboxPayloadError(ITEM_TOPIC, [UNCONTRACTED_ERROR]));
        if (name === EMITTER_FAILURE_NAME) return Promise.reject(new Error('state emitter unavailable'));
        if (name === UNPUBLISHED_NAME) recordUnpublishedEvents([UNPUBLISHED_EVENT_ID]);
        return Promise.resolve();
      },
      operationStatus: (_db, ids) => {
        statusCalls.push(ids);
        return Promise.resolve(
          Object.fromEntries(ids.filter((id) => id === 'op-hook').map((id): [string, OperationStatus] => [id, 'rolled-back'])),
        );
      },
    });
    await app.ready();
    [migration, gateway] = await Promise.all([
      authHeadersFor(subject('service:migration'), { audience: OWNER }),
      authHeadersFor(subject('service:gateway'), { audience: OWNER }),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  beforeEach(() => {
    emitted.length = 0;
    emitContexts.length = 0;
    statusCalls.length = 0;
  });

  function freshSite(): string {
    sites += 1;
    return `handlers-${sites}`;
  }

  function post(route: string, payload: unknown, headers: Record<string, string> = migration): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url: `${MIGRATION_PATH_PREFIX}${route}`, headers, payload: payload as Record<string, unknown> });
  }

  function get(route: string, query: Record<string, string | string[]> = {}, headers: Record<string, string> = migration): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}${route}`, headers, query });
  }

  /** Posts an apply batch (origin `backfill` unless given) and returns its parsed 200 answer. */
  async function applied(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await post('/apply', { origin: 'backfill', ...body });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Record<string, unknown>>();
  }

  /** The tenant's rows of `table` in `order`. */
  function stored(site: string, table: string, order: string): Promise<RepositoryRow[]> {
    return handle.app.withTenant(tenantIdForSite(site), async (tx) => (await tx.query(`SELECT * FROM ${handle.schema}.${table} ORDER BY ${order}`)).rows);
  }

  /** The tenant's recorded batches. */
  function batches(site: string): Promise<RepositoryRow[]> {
    return handle.app.withTenant(tenantIdForSite(site), async (tx) =>
      (await tx.query(`SELECT batch_id, legacy_table, origin, row_count FROM ${handle.schema}.migration_batch ORDER BY applied_at, batch_id`)).rows,
    );
  }

  /** The tenant's changelog rows in write order. */
  function changelog(site: string): Promise<{ xid: string; table: string; op: string; origin: string; request_id: string | null }[]> {
    return handle.app.withTenant(tenantIdForSite(site), async (tx) =>
      (
        await tx.query<{ xid: string; table: string; op: string; origin: string; request_id: string | null }>(
          `SELECT xid::text AS xid, "table", op, origin, request_id FROM ${handle.schema}.changelog ORDER BY seq`,
        )
      ).rows,
    );
  }

  async function watermarks(query: Record<string, string>): Promise<WatermarkRecord[]> {
    const res = await get('/watermark', query);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<WatermarkRecord[]>();
  }

  async function exportPage(query: Record<string, string | string[]>): Promise<ExportResponse> {
    const res = await get('/export', query);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ExportResponse>();
  }

  /** Polls `/changes` until it returns `count` rows; the horizon is cluster-wide, so an unrelated open transaction can hold it back. */
  async function changesUntil(query: Record<string, string>, count: number): Promise<ChangesResponse> {
    const deadline = Date.now() + HORIZON_WAIT_MS;
    for (;;) {
      const res = await get('/changes', query);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<ChangesResponse>();
      if (page.rows.length >= count || Date.now() > deadline) return page;
      await sleep(100);
    }
  }

  it('creates a legacy gate for every handler unit when the app becomes ready', async () => {
    const res = await post('/gate', { op: 'status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ units: SORTED_UNITS.map((unit) => ({ unit, state: 'legacy', holderId: null, phase: 'quiet' })) });
  });

  it.each([
    ['POST', '/apply'],
    ['GET', '/export'],
    ['GET', '/changes'],
    ['GET', '/position'],
    ['GET', '/watermark'],
    ['POST', '/watermark'],
    ['POST', '/gate'],
  ] as const)('answers %s %s with 401 without a credential and 403 for a service without platform.migration', async (method, route) => {
    const send = (headers: Record<string, string>): Promise<LightMyRequestResponse> =>
      method === 'POST' ? post(route, {}, headers) : get(route, {}, headers);
    expect((await send({})).statusCode).toBe(401);
    expect((await send(gateway)).statusCode).toBe(403);
  });

  it('upserts keyed rows, deletes by key, records each batch, emits state events and reports the write position', async () => {
    const site = freshSite();
    const tenantId = tenantIdForSite(site);
    const first = await post('/apply', {
      batchId: `${site}-b1`,
      origin: 'backfill',
      legacyTable: 'tItems',
      siteId: site,
      columns: ITEM_LEGACY,
      rows: rowsOf(ITEM_LEGACY, [
        ['upsert', item('i1', site, 'One', 1)],
        ['upsert', item('i2', site, 'Two', 2)],
      ]),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ batchId: `${site}-b1`, duplicate: false, applied: 2, skipped: 0 });
    const [firstWrite] = await changelog(site);
    expect(first.headers[WRITE_POSITION_HEADER_LC]).toBe(`${OWNER}=${firstWrite?.xid}`);
    const one = { tenant_id: tenantId, item_id: 'i1', site_id: site, name: 'One', qty: 1 };
    const two = { tenant_id: tenantId, item_id: 'i2', site_id: site, name: 'Two', qty: 2 };
    expect(emitted).toEqual([
      { unit: 'mk.item', table: 'item', op: 'insert', after: one, origin: 'backfill', tenantId },
      { unit: 'mk.item', table: 'item', op: 'insert', after: two, origin: 'backfill', tenantId },
    ]);
    expect(emitContexts.map((write) => [write.origin, write.requestId, isMigrationAuthority(write.authority)])).toEqual([
      ['backfill', `${site}-b1`, true],
      ['backfill', `${site}-b1`, true],
    ]);

    emitted.length = 0;
    const second = await applied({
      batchId: `${site}-b2`,
      origin: 'migration-feed',
      legacyTable: 'TITEMS',
      tenantId: tenantId.toUpperCase(),
      columns: ITEM_LEGACY,
      rows: rowsOf(ITEM_LEGACY, [
        ['upsert', item('i1', site, 'One', 5)],
        ['delete', item('i2', site, 'Two', 2)],
        ['delete', item('i9', site, 'Gone', 0)],
      ]),
    });
    expect(second).toEqual({ batchId: `${site}-b2`, duplicate: false, applied: 2, skipped: 1 });
    expect(await stored(site, 'item', 'item_id')).toEqual([{ ...one, qty: 5 }]);
    expect(emitted).toEqual([
      { unit: 'mk.item', table: 'item', op: 'update', before: one, after: { ...one, qty: 5 }, origin: 'migration-feed', tenantId },
      { unit: 'mk.item', table: 'item', op: 'delete', before: two, origin: 'migration-feed', tenantId },
    ]);
    expect(await batches(site)).toEqual([
      { batch_id: `${site}-b1`, legacy_table: 'tItems', origin: 'backfill', row_count: 2 },
      { batch_id: `${site}-b2`, legacy_table: 'TITEMS', origin: 'migration-feed', row_count: 3 },
    ]);
    expect((await changelog(site)).map((change) => [change.op, change.origin, change.request_id])).toEqual([
      ['insert', 'backfill', `${site}-b1`],
      ['insert', 'backfill', `${site}-b1`],
      ['update', 'migration-feed', `${site}-b2`],
      ['delete', 'migration-feed', `${site}-b2`],
    ]);
  });

  it('keeps a row applied and withholds, with a warning, the state event its topic contract rejects, then applies the rest', async () => {
    const site = freshSite();
    const tenantId = tenantIdForSite(site);
    logLines.length = 0;
    const res = await post('/apply', {
      batchId: `${site}-uncontracted`,
      origin: 'migration-feed',
      legacyTable: 'tItems',
      siteId: site,
      columns: ITEM_LEGACY,
      rows: rowsOf(ITEM_LEGACY, [
        ['upsert', item('i1', site, 'One', 1)],
        ['upsert', item('i2', site, UNCONTRACTED_NAME, 2)],
        ['upsert', item('i3', site, 'Three', 3)],
      ]),
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ batchId: `${site}-uncontracted`, duplicate: false, applied: 3, skipped: 0 });
    expect((await stored(site, 'item', 'item_id')).map((row) => [row.item_id, row.name])).toEqual([
      ['i1', 'One'],
      ['i2', UNCONTRACTED_NAME],
      ['i3', 'Three'],
    ]);
    expect(emitted.map((change) => change.after?.item_id)).toEqual(['i1', 'i2', 'i3']);
    expect(await batches(site)).toEqual([{ batch_id: `${site}-uncontracted`, legacy_table: 'tItems', origin: 'migration-feed', row_count: 3 }]);
    expect(logLines).toContainEqual(
      expect.objectContaining({
        severity: 'WARNING',
        tenantId,
        message: `migration apply withheld the ${ITEM_TOPIC} state event of a mk.item row of tItems: ${UNCONTRACTED_ERROR}`,
      }),
    );
    expect(logLines.filter((line) => line.severity === 'ERROR')).toEqual([]);
  });

  it('fails the whole batch when the state emitter fails otherwise', async () => {
    const site = freshSite();
    const res = await post('/apply', {
      batchId: `${site}-emitter-down`,
      origin: 'migration-feed',
      legacyTable: 'tItems',
      siteId: site,
      columns: ITEM_LEGACY,
      rows: rowsOf(ITEM_LEGACY, [
        ['upsert', item('i1', site, 'One', 1)],
        ['upsert', item('i2', site, EMITTER_FAILURE_NAME, 2)],
      ]),
    });

    expect(res.statusCode, res.body).toBe(500);
    expect(await stored(site, 'item', 'item_id')).toEqual([]);
    expect(await batches(site)).toEqual([]);
  });

  it('answers a committed batch whose state events were not all published with the legacy 503, its write position and the unpublished count, and its re-send as a duplicate', async () => {
    const site = freshSite();
    const batch = {
      batchId: `${site}-unpublished`,
      origin: 'backfill',
      legacyTable: 'tItems',
      siteId: site,
      columns: ITEM_LEGACY,
      rows: rowsOf(ITEM_LEGACY, [['upsert', item('i1', site, UNPUBLISHED_NAME, 1)]]),
    };
    logLines.length = 0;

    const res = await post('/apply', batch);

    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: { code: 'server_error', message: 'Unhandled Exception' } });
    expect(res.headers[UNPUBLISHED_EVENTS_HEADER.toLowerCase()]).toBe('1');
    const [write] = await changelog(site);
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBe(`${OWNER}=${write?.xid}`);
    expect(await batches(site)).toEqual([{ batch_id: batch.batchId, legacy_table: 'tItems', origin: 'backfill', row_count: 1 }]);
    const warnings = logLines.filter((line) => line.message === 'request answered 503: outbox publish of its committed events incomplete');
    expect(warnings).toMatchObject([
      {
        severity: 'WARNING',
        route: `${MIGRATION_PATH_PREFIX}/apply`,
        httpMethod: 'POST',
        error: { type: 'UnpublishedEventsError', message: 'Outbox publish of 1 committed event(s) incomplete before the answer; left to the sweep' },
      },
    ]);
    expect(validateLogRecord(warnings[0]).errors).toEqual([]);
    expect(logLines.filter((line) => String(line.message).startsWith('request abandoned'))).toEqual([]);

    const repeat = await post('/apply', batch);

    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json()).toEqual({ batchId: batch.batchId, duplicate: true, applied: 0, skipped: 0 });
    expect(repeat.headers[UNPUBLISHED_EVENTS_HEADER.toLowerCase()]).toBeUndefined();
    expect(await stored(site, 'item', 'item_id')).toMatchObject([{ item_id: 'i1', name: UNPUBLISHED_NAME, qty: 1 }]);
  });

  it('answers a repeated batchId as a duplicate without applying its rows or its watermark', async () => {
    const site = freshSite();
    bindPrograms(site, 21);
    const batch = (points: number, snapshotSeq: number): Record<string, unknown> => ({
      batchId: `${site}-repeat`,
      legacyTable: 'Program_21.Scores',
      siteId: site,
      columns: SCORE_LEGACY,
      rows: rowsOf(SCORE_LEGACY, [['upsert', { ScoreID: 's1', Points: points }]]),
      watermark: { direction: 'forward', snapshotSeq, finishedAt: '2026-06-30 10:00:00' },
    });
    expect(await applied(batch(1, 7))).toEqual({ batchId: `${site}-repeat`, duplicate: false, applied: 1, skipped: 0 });
    const repeat = await post('/apply', { origin: 'backfill', ...batch(99, 8) });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ batchId: `${site}-repeat`, duplicate: true, applied: 0, skipped: 0 });
    expect(repeat.headers).not.toHaveProperty(WRITE_POSITION_HEADER_LC);
    expect((await stored(site, 'score', 'score_id')).map((row) => row.points)).toEqual([1]);
    expect(await watermarks({ legacyTable: 'Program_21.Scores' })).toEqual([
      { legacyTable: 'Program_21.Scores', direction: 'forward', snapshotSeq: 7, backupLsn: null, finishedAt: '2026-06-30T10:00:00.000' },
    ]);
  });

  it('commits rows, batch record and watermark together and rolls all three back when a row is rejected', async () => {
    const site = freshSite();
    bindPrograms(site, 22);
    const batch = (secondOp: RowOp): Record<string, unknown> => ({
      batchId: `${site}-atomic`,
      origin: 'legacy-window',
      holderId: 'window-1',
      legacyTable: 'Program_22.Scores',
      siteId: site,
      columns: SCORE_LEGACY,
      rows: rowsOf(SCORE_LEGACY, [
        ['upsert', { ScoreID: 's1', Points: 1 }],
        [secondOp, { ScoreID: 's2', Points: 2 }],
      ]),
      watermark: { direction: 'reverse', snapshotSeq: 5, backupLsn: '123', finishedAt: '2026-06-30T11:00:00' },
    });
    expectRejected(await post('/apply', batch('insert')));
    expect(await stored(site, 'score', 'score_id')).toEqual([]);
    expect(await batches(site)).toEqual([]);
    expect(await watermarks({ legacyTable: 'Program_22.Scores' })).toEqual([]);

    expect(await applied(batch('upsert'))).toEqual({ batchId: `${site}-atomic`, duplicate: false, applied: 2, skipped: 0 });
    expect((await stored(site, 'score', 'score_id')).map((row) => [row.legacy_program_id, row.score_id])).toEqual([
      [22, 's1'],
      [22, 's2'],
    ]);
    expect(await batches(site)).toEqual([{ batch_id: `${site}-atomic`, legacy_table: 'Program_22.Scores', origin: 'legacy-window', row_count: 2 }]);
    expect(await watermarks({ legacyTable: 'Program_22.Scores' })).toEqual([
      { legacyTable: 'Program_22.Scores', direction: 'reverse', snapshotSeq: 5, backupLsn: '123', finishedAt: '2026-06-30T11:00:00.000' },
    ]);
    expect((await changelog(site)).map((change) => change.origin)).toEqual(['legacy-window', 'legacy-window']);
  });

  it('inserts identical keyless rows as separate occurrences, deletes one occurrence at a time and exports each occurrence', async () => {
    const site = freshSite();
    const tenantId = tenantIdForSite(site);
    const dup = { Label: 'dup', Weight: 1 };
    const solo = { Label: 'solo', Weight: 2 };
    const base = { legacyTable: 'tTagMembers', siteId: site, columns: TAG_LEGACY };
    expect(
      await applied({
        ...base,
        batchId: `${site}-t1`,
        rows: rowsOf(TAG_LEGACY, [
          ['insert', dup],
          ['insert', dup],
          ['insert', dup],
          ['insert', solo],
        ]),
      }),
    ).toMatchObject({ applied: 4, skipped: 0 });
    expect(
      await applied({
        ...base,
        batchId: `${site}-t2`,
        rows: rowsOf(TAG_LEGACY, [
          ['delete', dup],
          ['delete', { Label: 'none', Weight: 0 }],
        ]),
      }),
    ).toMatchObject({ applied: 1, skipped: 1 });
    expect((await stored(site, 'tag_member', 'label, occurrence')).map((row) => [row.label, row.weight, row.occurrence])).toEqual([
      ['dup', 1, 1],
      ['dup', 1, 2],
      ['solo', 2, 1],
    ]);

    const rows = [exported(TAG_LEGACY, null, dup), exported(TAG_LEGACY, null, dup), exported(TAG_LEGACY, null, solo)].sort((a, b) =>
      a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0,
    );
    expect(await exportPage({ unit: 'mk.tag_member', siteId: site })).toEqual({
      unit: 'mk.tag_member',
      tenantId,
      tables: [{ unit: 'mk.tag_member', legacyTable: 'tTagMembers', targetTable: 'mk.tag_member', keyless: true, columns: TAG_LEGACY, rows }],
      next: null,
      objects: objectsOf('mk.tag_member', tenantId),
    });
  });

  it('writes only the rows a split rule accepts and exports them under every mapping of their table', async () => {
    const site = freshSite();
    const tenantId = tenantIdForSite(site);
    const notes = {
      legacyTable: 'tNotes',
      siteId: site,
      columns: NOTE_LEGACY,
    };
    expect(
      await applied({
        ...notes,
        batchId: `${site}-n1`,
        rows: rowsOf(NOTE_LEGACY, [
          ['upsert', { NoteID: 'n1', Type: 'Memo', Body: 'kept' }],
          ['upsert', { NoteID: 'n2', Type: 'Task', Body: 'another owner' }],
          ['upsert', { NoteID: 'n3', Type: 'memo  ', Body: 'padded' }],
        ]),
      }),
    ).toMatchObject({ applied: 2, skipped: 1 });
    const misrouted = {
      ...notes,
      batchId: `${site}-n2`,
      rows: rowsOf(NOTE_LEGACY, [['upsert', { NoteID: 'n4', Type: 'Memo', Body: 'x' }]]),
      watermark: { direction: 'forward', snapshotSeq: 3, finishedAt: '2026-06-30 14:00:00' },
    };
    expectRejected(await post('/apply', { origin: 'backfill', ...misrouted, units: ['mk.item'] }));
    expect((await batches(site)).map((batch) => batch.batch_id)).toEqual([`${site}-n1`]);
    expect(await watermarks({ legacyTable: 'tNotes' })).toEqual([]);
    expect(await applied({ ...misrouted, units: ['mk.memo'] })).toEqual({ batchId: `${site}-n2`, duplicate: false, applied: 1, skipped: 0 });
    expect((await watermarks({ legacyTable: 'tNotes' })).map((mark) => [mark.direction, mark.snapshotSeq])).toEqual([['forward', 3]]);
    expect((await stored(site, 'memo', 'note_id')).map((row) => [row.note_id, row.body])).toEqual([
      ['n1', 'kept'],
      ['n3', 'padded'],
      ['n4', 'x'],
    ]);

    const rows = [
      exported(MEMO_LEGACY, ['NoteID'], { NoteID: 'n1', Body: 'kept' }),
      exported(MEMO_LEGACY, ['NoteID'], { NoteID: 'n3', Body: 'padded' }),
      exported(MEMO_LEGACY, ['NoteID'], { NoteID: 'n4', Body: 'x' }),
    ];
    const page = await exportPage({ unit: 'mk.memo', tenantId });
    expect(page.tables).toEqual([
      { unit: 'mk.memo', legacyTable: 'tNotes', targetTable: 'mk.memo', keyless: false, columns: MEMO_LEGACY, rows },
      { unit: 'mk.memo', legacyTable: 'tNoteArchive', targetTable: 'mk.memo', keyless: false, columns: MEMO_LEGACY, rows },
    ]);
  });

  /** A one-row Scores batch of a fresh site for `Program_<programId>`, which it binds to that site, carrying a forward watermark. */
  function scoresBatch(programId: number): Record<string, unknown> & { batchId: string; legacyTable: string; siteId: string } {
    const site = freshSite();
    bindPrograms(site, programId);
    return {
      batchId: `${site}-units`,
      legacyTable: `Program_${programId}.Scores`,
      siteId: site,
      columns: SCORE_LEGACY,
      rows: rowsOf(SCORE_LEGACY, [['upsert', { ScoreID: 's1', Points: 1 }]]),
      watermark: { direction: 'forward', snapshotSeq: programId, finishedAt: '2026-06-30 15:00:00' },
    };
  }

  it.each([
    ['an undeclared unit', 23, ['mk.scroe']],
    ['a unit of another owner', 24, ['people.person']],
    ['a unit of another legacy table', 25, ['mk.item']],
    ['a unit of another legacy table beside its own', 26, ['mk.score', 'mk.memo']],
  ] as [string, number, string[]][])('rejects an apply naming %s without recording its batch or watermark, so its corrected retry applies', async (_label, programId, units) => {
    const batch = scoresBatch(programId);
    expectRejected(await post('/apply', { origin: 'backfill', ...batch, units }));
    expect(await batches(batch.siteId)).toEqual([]);
    expect(await watermarks({ legacyTable: batch.legacyTable })).toEqual([]);
    expect(await applied({ ...batch, units: ['mk.score'] })).toEqual({ batchId: batch.batchId, duplicate: false, applied: 1, skipped: 0 });
    expect((await watermarks({ legacyTable: batch.legacyTable })).map((mark) => mark.snapshotSeq)).toEqual([programId]);
  });

  it('applies an empty units list as an empty subset, recording the batch and watermark with every row skipped', async () => {
    const batch = scoresBatch(27);
    expect(await applied({ ...batch, units: [] })).toEqual({ batchId: batch.batchId, duplicate: false, applied: 0, skipped: 1 });
    expect(await stored(batch.siteId, 'score', 'score_id')).toEqual([]);
    expect(await batches(batch.siteId)).toEqual([{ batch_id: batch.batchId, legacy_table: 'Program_27.Scores', origin: 'backfill', row_count: 1 }]);
    expect((await watermarks({ legacyTable: batch.legacyTable })).map((mark) => mark.snapshotSeq)).toEqual([27]);
  });

  it.each([
    ['maps to another site', 28, 'other', undefined],
    ['maps to no site', 29, 'none', undefined],
    ['maps to another site, with no unit to write', 30, 'other', []],
  ] as [string, number, 'other' | 'none', string[] | undefined][])(
    'rejects a Program_<id> batch whose program %s without recording its batch or watermark, so its corrected retry applies',
    async (_label, programId, binding, units) => {
      const batch = { ...scoresBatch(programId), ...(units === undefined ? {} : { units }) };
      if (binding === 'other') bindPrograms(freshSite(), programId);
      else programSites.delete(programId);
      expectRejected(await post('/apply', { origin: 'backfill', ...batch }));
      expect(await batches(batch.siteId)).toEqual([]);
      expect(await stored(batch.siteId, 'score', 'score_id')).toEqual([]);
      expect(await watermarks({ legacyTable: batch.legacyTable })).toEqual([]);
      bindPrograms(batch.siteId, programId);
      expect(await applied(batch)).toMatchObject({ batchId: batch.batchId, duplicate: false });
      expect((await watermarks({ legacyTable: batch.legacyTable })).map((mark) => mark.snapshotSeq)).toEqual([programId]);
    },
  );

  it('folds Program_<id> tables into one target table and exports it whole or per program', async () => {
    const site = freshSite();
    bindPrograms(site, 1, 2, 3);
    const scores = { siteId: site, columns: SCORE_LEGACY };
    await applied({ ...scores, batchId: `${site}-p1`, legacyTable: 'Program_1.Scores', rows: rowsOf(SCORE_LEGACY, [['upsert', { ScoreID: 's2', Points: 20 }], ['upsert', { ScoreID: 's1', Points: 10 }]]) });
    await applied({ ...scores, batchId: `${site}-p2`, legacyTable: '[Program_2].[Scores]', rows: rowsOf(SCORE_LEGACY, [['upsert', { ScoreID: 's1', Points: 30 }]]) });
    await applied({ ...scores, batchId: `${site}-p3`, legacyTable: 'Scores', legacyProgramId: 3, rows: rowsOf(SCORE_LEGACY, [['upsert', { ScoreID: 's9', Points: 40 }]]) });
    expect((await batches(site)).map((row) => row.legacy_table)).toEqual(['Program_1.Scores', 'Program_2.Scores', 'Program_3.Scores']);

    const whole = await exportPage({ unit: 'mk.score', siteId: site });
    expect(whole.tables.map((table) => table.rows)).toEqual([
      [
        exported(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's1', Points: 10 }, 1),
        exported(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's2', Points: 20 }, 1),
        exported(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's1', Points: 30 }, 2),
        exported(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's9', Points: 40 }, 3),
      ],
    ]);
    const second = await exportPage({ unit: 'mk.score', siteId: site, programId: '2', limit: '1' });
    expect(second.tables.map((table) => table.rows)).toEqual([[exported(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's1', Points: 30 }, 2)]]);
    expect(second.next).toEqual(expect.any(String));
    const rest = await exportPage({ unit: 'mk.score', siteId: site, programId: '2', after: second.next as string });
    expect(rest).toMatchObject({ tables: [{ rows: [] }], next: null });
    expect(rest).not.toHaveProperty('objects');
  });

  it('pages a unit export with a keyset cursor and returns the object manifest with the first page only', async () => {
    const site = freshSite();
    const tenantId = tenantIdForSite(site);
    const values = ['i5', 'i3', 'i1', 'i4', 'i2'].map((id, index) => item(id, site, `Item ${id}`, index));
    await applied({ batchId: `${site}-e1`, legacyTable: 'tItems', siteId: site, columns: ITEM_LEGACY, rows: rowsOf(ITEM_LEGACY, values.map((v): [RowOp, LegacyValues] => ['upsert', v])) });

    const pages: ExportResponse[] = [];
    let after: string | null = null;
    do {
      pages.push(await exportPage({ unit: 'mk.item', siteId: site, limit: '2', ...(after === null ? {} : { after }) }));
      after = pages.at(-1)?.next ?? null;
    } while (after !== null && pages.length < 5);

    const sorted = [...values].sort((a, b) => String(a.ItemID).localeCompare(String(b.ItemID)));
    const expected = sorted.map((v) => exported(ITEM_LEGACY, ['ItemID'], v));
    expect(pages.map((page) => page.tables.flatMap((table) => table.rows))).toEqual([expected.slice(0, 2), expected.slice(2, 4), expected.slice(4)]);
    expect(pages.map((page) => page.next === null)).toEqual([false, false, true]);
    expect(pages[0]?.objects).toEqual(objectsOf('mk.item', tenantId));
    expect(pages.slice(1).every((page) => !('objects' in page))).toBe(true);
  });

  it('exports only the rows of one key or of repeated keys, paged by its keyset cursor and without the object manifest', async () => {
    const site = freshSite();
    const values = ['i1', 'i2', 'i3', 'i4', 'i5'].map((id, index) => item(id, site, `Item ${id}`, index));
    await applied({ batchId: `${site}-k1`, legacyTable: 'tItems', siteId: site, columns: ITEM_LEGACY, rows: rowsOf(ITEM_LEGACY, values.map((v): [RowOp, LegacyValues] => ['upsert', v])) });
    const rowOf = (index: number): ExportRow => exported(ITEM_LEGACY, ['ItemID'], values[index] as LegacyValues);
    const keyOf = (id: string): string => encodeKey(ITEM_LEGACY, ['ItemID'], { ItemID: id });

    const single = await exportPage({ unit: 'mk.item', siteId: site, keys: keyOf('i3') });
    expect(single).toEqual({ unit: 'mk.item', tenantId: tenantIdForSite(site), tables: [expect.objectContaining({ legacyTable: 'tItems', rows: [rowOf(2)] })], next: null });
    const most = Array.from({ length: MAX_EXPORT_KEYS }, (_, n) => keyOf(n === 0 ? 'i5' : `absent-${String(n)}`));
    expect((await exportPage({ unit: 'mk.item', siteId: site, keys: most })).tables.flatMap((table) => table.rows)).toEqual([rowOf(4)]);

    const keys = [keyOf('i4'), keyOf('i2'), keyOf('absent'), keyOf('i4')];
    const pages: ExportResponse[] = [];
    let after: string | null = null;
    do {
      pages.push(await exportPage({ unit: 'mk.item', siteId: site, keys, limit: '1', ...(after === null ? {} : { after }) }));
      after = pages.at(-1)?.next ?? null;
    } while (after !== null && pages.length < 5);
    expect(pages.map((page) => page.tables.flatMap((table) => table.rows))).toEqual([[rowOf(1)], [rowOf(3)], []]);
    expect(pages.map((page) => page.next === null)).toEqual([false, false, true]);
    expect(pages.some((page) => 'objects' in page)).toBe(false);
  });

  it('filters a folded unit by legacy key across its programs, or within the one programId names', async () => {
    const site = freshSite();
    bindPrograms(site, 1, 2);
    const scores = { siteId: site, columns: SCORE_LEGACY };
    await applied({ ...scores, batchId: `${site}-k1`, legacyTable: 'Program_1.Scores', rows: rowsOf(SCORE_LEGACY, [['upsert', { ScoreID: 's1', Points: 10 }], ['upsert', { ScoreID: 's2', Points: 20 }]]) });
    await applied({ ...scores, batchId: `${site}-k2`, legacyTable: 'Program_2.Scores', rows: rowsOf(SCORE_LEGACY, [['upsert', { ScoreID: 's1', Points: 30 }]]) });
    const keys = encodeKey(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's1' });
    const rows = async (query: Record<string, string>): Promise<ExportRow[][]> =>
      (await exportPage({ unit: 'mk.score', siteId: site, keys, ...query })).tables.map((table) => table.rows);

    expect(await rows({})).toEqual([[exported(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's1', Points: 10 }, 1), exported(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's1', Points: 30 }, 2)]]);
    expect(await rows({ programId: '2' })).toEqual([[exported(SCORE_LEGACY, ['ScoreID'], { ScoreID: 's1', Points: 30 }, 2)]]);
  });

  it('filters every mapping of a shared target table by the same keys', async () => {
    const site = freshSite();
    await applied({
      batchId: `${site}-k1`,
      legacyTable: 'tNotes',
      siteId: site,
      columns: NOTE_LEGACY,
      rows: rowsOf(NOTE_LEGACY, [['upsert', { NoteID: 'n1', Type: 'Memo', Body: 'one' }], ['upsert', { NoteID: 'n2', Type: 'Memo', Body: 'two' }]]),
    });
    const page = await exportPage({ unit: 'mk.memo', siteId: site, keys: [encodeKey(MEMO_LEGACY, ['NoteID'], { NoteID: 'n2' })] });
    const row = exported(MEMO_LEGACY, ['NoteID'], { NoteID: 'n2', Body: 'two' });
    expect(page.tables.map((table) => [table.legacyTable, table.rows])).toEqual([['tNotes', [row]], ['tNoteArchive', [row]]]);
  });

  /** A fresh site's items i1–i5, by id, whose names and quantities the match cases select from. */
  async function matchItems(): Promise<{ site: string; byId: Record<string, LegacyValues> }> {
    const site = freshSite();
    const values = [item('i1', site, 'Alpha', 1), item('i2', site, 'alpha  ', 2), item('i3', site, 'Beta', 3), item('i4', site, 'Älpha', 4), { ...item('i5', site, '', -5), Name: null }];
    await applied({ batchId: `${site}-m1`, legacyTable: 'tItems', siteId: site, columns: ITEM_LEGACY, rows: rowsOf(ITEM_LEGACY, values.map((v): [RowOp, LegacyValues] => ['upsert', v])) });
    return { site, byId: Object.fromEntries(values.map((v) => [String(v.ItemID), v])) };
  }

  it.each([
    ['a text value in another case and with trailing spaces, plus the non-ASCII name', { NAME: ['ALPHA   '] }, ['i1', 'i2', 'i4']],
    ['integer values given as text and as JSON numbers', { qty: [' +3 ', -5, 'x', '1.5'] }, ['i3', 'i5']],
    ['either of two entries, plus the non-ASCII name', { Name: ['beta'], Qty: [1] }, ['i1', 'i3', 'i4']],
    ['no row, for entries whose values cannot equal a stored value', { Name: ['a\u0000'], Qty: ['x'] }, []],
    ['every row, for an entry naming a column the mapping does not store', { Name: ['beta'], Ghost: ['x'] }, ['i1', 'i2', 'i3', 'i4', 'i5']],
  ] as [string, Record<string, (string | number)[]>, string[]][])('exports, for a match, %s', async (_label, match, ids) => {
    const { site, byId } = await matchItems();
    const page = await exportPage({ unit: 'mk.item', siteId: site, match: JSON.stringify(match) });
    expect(page.tables).toEqual([
      { unit: 'mk.item', legacyTable: 'tItems', targetTable: 'mk.item', keyless: false, columns: ITEM_LEGACY, rows: ids.map((id) => exported(ITEM_LEGACY, ['ItemID'], byId[id] as LegacyValues)) },
    ]);
    expect(page.objects).toEqual(objectsOf('mk.item', tenantIdForSite(site)));
  });

  it('pages a matched export with the keyset cursor when each page repeats the match', async () => {
    const { site, byId } = await matchItems();
    const match = JSON.stringify({ name: ['alpha'] });
    const first = await exportPage({ unit: 'mk.item', siteId: site, match, limit: '2' });
    const rest = await exportPage({ unit: 'mk.item', siteId: site, match, limit: '2', after: first.next ?? '' });
    const rows = (...ids: string[]) => ids.map((id) => exported(ITEM_LEGACY, ['ItemID'], byId[id] as LegacyValues));
    expect([first, rest].map((page) => page.tables.flatMap((table) => table.rows))).toEqual([rows('i1', 'i2'), rows('i4')]);
    expect([first.next, rest.next]).toEqual([cursorText({ table: 'item', key: ['i2'] }), null]);
  });

  it('exports only the listed keys that also fall within the match', async () => {
    const { site, byId } = await matchItems();
    const keys = ['i1', 'i3'].map((id) => encodeKey(ITEM_LEGACY, ['ItemID'], { ItemID: id }));
    const page = await exportPage({ unit: 'mk.item', siteId: site, keys, match: JSON.stringify({ Name: ['alpha'] }) });
    expect(page.tables.flatMap((table) => table.rows)).toEqual([exported(ITEM_LEGACY, ['ItemID'], byId.i1 as LegacyValues)]);
  });

  it.each([
    ['an undeclared unit', { unit: 'mk.ghost', siteId: 'tenant-a' }],
    ['a programId for a unit without legacy_program_id', { unit: 'mk.item', siteId: 'tenant-a', programId: '1' }],
    ['a programId beyond the range of the legacy_program_id column', { unit: 'mk.score', siteId: 'tenant-a', programId: '99999999999' }],
    ['both tenantId and siteId', { unit: 'mk.item', siteId: 'tenant-a', tenantId: TENANT_A.tenantId }],
    ['neither tenantId nor siteId', { unit: 'mk.item' }],
    ['a tenantId that is not a UUID', { unit: 'mk.item', tenantId: 'tenant-a' }],
    ['a cursor that is not base64url JSON', { unit: 'mk.item', siteId: 'tenant-a', after: '!!' }],
    ['a cursor of the wrong shape', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ table: 'item' }) }],
    ['a cursor naming a table of another unit', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ table: 'score', key: ['1', 's1'] }) }],
    ['a cursor with the wrong key length', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ table: 'item', key: ['a', 'b'] }) }],
    ['a cursor key that is not an integer for an integer key column', { unit: 'mk.score', siteId: 'tenant-a', after: cursorText({ table: 'score', key: ['x', 's1'] }) }],
    ['a cursor key beyond the range of its integer key column', { unit: 'mk.score', siteId: 'tenant-a', after: cursorText({ table: 'score', key: ['99999999999', 's1'] }) }],
    ['a cursor key with an unpaired surrogate for a text key column', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ table: 'item', key: ['\uD800'] }) }],
    ['a cursor key with a NUL character for a text key column', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ table: 'item', key: ['a\u0000b'] }) }],
    ['a manifest cursor for a unit that returns its whole manifest', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ objects: 'p1' }) }],
    [
      'a row cursor with a manifest position for a unit that returns its whole manifest',
      { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ table: 'item', key: ['i1'], objects: 'p1' }) },
    ],
    ['a manifest cursor with an empty position', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ objects: '' }) }],
    ['a manifest cursor whose position is not text', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ objects: 1 }) }],
    ['a manifest cursor with an unknown field', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ objects: 'p1', page: 1 }) }],
    ['a manifest position beside a table without its key', { unit: 'mk.item', siteId: 'tenant-a', after: cursorText({ table: 'item', objects: 'p1' }) }],
    ['a limit of 0', { unit: 'mk.item', siteId: 'tenant-a', limit: '0' }],
    ['a limit above 10000', { unit: 'mk.item', siteId: 'tenant-a', limit: '10001' }],
    ['an unknown parameter', { unit: 'mk.item', siteId: 'tenant-a', page: '1' }],
    ['keys for a keyless unit', { unit: 'mk.tag_member', siteId: 'tenant-a', keys: encodeRow(TAG_LEGACY, { Label: 'a', Weight: 1 }) }],
    ['a key that is not a key encoding', { unit: 'mk.item', siteId: 'tenant-a', keys: 'i1' }],
    ['a key encoded with another type than its key column', { unit: 'mk.score', siteId: 'tenant-a', keys: encodeRow([{ name: 'ScoreID', type: 'i' }], { ScoreID: '1' }) }],
    ['a malformed key beside valid ones', { unit: 'mk.item', siteId: 'tenant-a', keys: [encodeKey(ITEM_LEGACY, ['ItemID'], { ItemID: 'i1' }), 's9:i1'] }],
    ['an empty key', { unit: 'mk.item', siteId: 'tenant-a', keys: '' }],
    ['a key with a NUL character for a text key column', { unit: 'mk.item', siteId: 'tenant-a', keys: encodeKey(ITEM_LEGACY, ['ItemID'], { ItemID: 'a\u0000b' }) }],
    [
      'more keys than one request takes',
      { unit: 'mk.item', siteId: 'tenant-a', keys: Array.from({ length: MAX_EXPORT_KEYS + 1 }, (_, n) => encodeKey(ITEM_LEGACY, ['ItemID'], { ItemID: `i${String(n)}` })) },
    ],
    ['a match that is not JSON', { unit: 'mk.item', siteId: 'tenant-a', match: '{"Name":' }],
    ['a match that is not a JSON object', { unit: 'mk.item', siteId: 'tenant-a', match: '["Name"]' }],
    ['a match naming no column', { unit: 'mk.item', siteId: 'tenant-a', match: '{}' }],
    ['a match entry without values', { unit: 'mk.item', siteId: 'tenant-a', match: '{"Name":[]}' }],
    ['a match value that is neither text nor an integer', { unit: 'mk.item', siteId: 'tenant-a', match: '{"Qty":[1.5]}' }],
    ['a match longer than its maximum', { unit: 'mk.item', siteId: 'tenant-a', match: JSON.stringify({ Name: ['x'.repeat(MAX_EXPORT_MATCH_LENGTH)] }) }],
  ] as [string, Record<string, string | string[]>][])('rejects an export with %s as invalidParameters', async (_label, query) => {
    expectRejected(await get('/export', query));
  });

  it('returns committed changes in (xid, seq) order with one legacy projection per mapping of their table', async () => {
    const site = freshSite();
    const tenantId = tenantIdForSite(site);
    const v1 = item('i1', site, 'Item', 1);
    const v2 = item('i1', site, 'Item', 2);
    const memo = { NoteID: 'n1', Body: 'memo' };
    const score = { ScoreID: 's1', Points: 7 };
    const dup = { Label: 'dup', Weight: 1 };
    const items = { legacyTable: 'tItems', siteId: site, columns: ITEM_LEGACY };
    const tags = { legacyTable: 'tTagMembers', siteId: site, columns: TAG_LEGACY };
    bindPrograms(site, 4);
    await applied({ ...items, batchId: `${site}-c1`, rows: rowsOf(ITEM_LEGACY, [['upsert', v1]]) });
    await applied({ ...items, batchId: `${site}-c2`, rows: rowsOf(ITEM_LEGACY, [['upsert', v2]]) });
    await applied({ batchId: `${site}-c3`, legacyTable: 'tNoteArchive', siteId: site, columns: MEMO_LEGACY, rows: rowsOf(MEMO_LEGACY, [['upsert', memo]]) });
    await applied({ batchId: `${site}-c4`, legacyTable: 'Program_4.Scores', siteId: site, columns: SCORE_LEGACY, rows: rowsOf(SCORE_LEGACY, [['upsert', score]]) });
    await applied({ ...tags, batchId: `${site}-c5`, rows: rowsOf(TAG_LEGACY, [['insert', dup]]) });
    await applied({ ...tags, batchId: `${site}-c6`, rows: rowsOf(TAG_LEGACY, [['delete', dup]]) });
    await handle.app.withTenant(tenantId, (tx) => repo.insert(tx, 'note_log', { note_id: 'l1', text: 'unmapped' }));

    const page = await changesUntil({ siteId: site }, 7);
    expect(page.rows.map((row) => [row.table, row.op, row.origin])).toEqual([
      ['item', 'insert', 'backfill'],
      ['item', 'update', 'backfill'],
      ['memo', 'insert', 'backfill'],
      ['score', 'insert', 'backfill'],
      ['tag_member', 'insert', 'backfill'],
      ['tag_member', 'delete', 'backfill'],
      ['note_log', 'insert', 'target'],
    ]);
    const itemKey = encodeKey(ITEM_LEGACY, ['ItemID'], v1);
    const memoChange = { key: encodeKey(MEMO_LEGACY, ['NoteID'], memo), before: null, after: encodeRow(MEMO_LEGACY, memo), columns: ['NoteID', 'Body'] };
    const tagKey = encodeRow(TAG_LEGACY, dup);
    expect(page.rows.map((row) => row.legacy)).toEqual([
      [{ unit: 'mk.item', legacyTable: 'tItems', key: itemKey, before: null, after: encodeRow(ITEM_LEGACY, v1), columns: ['ItemID', 'SiteID', 'Name', 'Qty'] }],
      [{ unit: 'mk.item', legacyTable: 'tItems', key: itemKey, before: encodeRow(ITEM_LEGACY, v1), after: encodeRow(ITEM_LEGACY, v2), columns: ['Qty'] }],
      [
        { unit: 'mk.memo', legacyTable: 'tNotes', ...memoChange },
        { unit: 'mk.memo', legacyTable: 'tNoteArchive', ...memoChange },
      ],
      [
        {
          unit: 'mk.score',
          legacyTable: 'Scores',
          key: encodeKey(SCORE_LEGACY, ['ScoreID'], score),
          before: null,
          after: encodeRow(SCORE_LEGACY, score),
          columns: ['ScoreID', 'Points'],
          legacyProgramId: 4,
        },
      ],
      [{ unit: 'mk.tag_member', legacyTable: 'tTagMembers', key: tagKey, before: null, after: tagKey, columns: ['Label', 'Weight'] }],
      [{ unit: 'mk.tag_member', legacyTable: 'tTagMembers', key: tagKey, before: tagKey, after: null, columns: ['Label', 'Weight'] }],
      [],
    ]);
    const last = page.rows.at(-1);
    expect(page).toMatchObject({ cursor: `${last?.xid}:${last?.seq}`, complete: true, operations: {} });
    expect(BigInt(page.horizon) > BigInt(last?.xid ?? '0')).toBe(true);

    const after = await get('/changes', { siteId: site, after: page.cursor });
    expect(after.json()).toMatchObject({ rows: [], cursor: page.cursor, complete: true });
    const first = await get('/changes', { tenantId, limit: '1' });
    const firstRow = page.rows[0];
    expect(first.json()).toMatchObject({ rows: [{ seq: firstRow?.seq }], cursor: `${firstRow?.xid}:${firstRow?.seq}`, complete: false });
  }, HORIZON_TEST_TIMEOUT_MS);

  it('reports each operation of a page as the status hook answers it, else open while registered, else done', async () => {
    const site = freshSite();
    const tenantId = tenantIdForSite(site);
    await withMetadata(handle.app, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.open_operation (operation_id, kind, units) VALUES ('op-open', 'roster', '{mk.audit}')`),
    );
    try {
      for (const [noteId, operationId] of [
        ['l1', 'op-hook'],
        ['l2', 'op-open'],
        ['l3', 'op-done'],
      ] as const) {
        await handle.app.withTenant(tenantId, (tx) => repo.insert(tx, 'note_log', { note_id: noteId, text: noteId }, { operationId }));
      }
      const page = await changesUntil({ siteId: site }, 3);
      expect(page.rows.map((row) => row.operationId)).toEqual(['op-hook', 'op-open', 'op-done']);
      expect(page.operations).toEqual({ 'op-hook': 'rolled-back', 'op-open': 'open', 'op-done': 'done' });
      expect(statusCalls.at(-1)).toEqual(['op-hook', 'op-open', 'op-done']);
    } finally {
      await endOperation(handle.app, 'op-open');
    }
  }, HORIZON_TEST_TIMEOUT_MS);

  it.each([
    ['a malformed cursor', { siteId: 'tenant-a', after: 'x' }],
    ['a limit of 0', { siteId: 'tenant-a', limit: '0' }],
    ['a limit above 10000', { siteId: 'tenant-a', limit: '10001' }],
    ['no tenant', {}],
  ] as [string, Record<string, string>][])('rejects a changes read with %s as invalidParameters', async (_label, query) => {
    expectRejected(await get('/changes', query));
  });

  it('reports the owner position, outbox drain counts and inbox receipts of every registered tenant', async () => {
    const site = freshSite();
    await applied({ batchId: `${site}-pos`, legacyTable: 'tItems', siteId: site, columns: ITEM_LEGACY, rows: rowsOf(ITEM_LEGACY, [['upsert', item('i1', site, 'P', 1)]]) });
    const [written] = await changelog(site);
    await seedRegistry(handle.app);
    const [e1, e2, e3] = [randomUUID(), randomUUID(), randomUUID()];
    const outbox = `INSERT INTO ${handle.schema}.outbox (tenant_id, event_id, topic, kind, ordering_key, envelope, held, created_at, published_at)
      VALUES ($1, $2, 'mk.item.changed.v1', 'state', 'k', '{}'::jsonb, $3, localtimestamp(3), $4)`;
    const inbox = `INSERT INTO ${handle.schema}.inbox (tenant_id, event_id, subscription, status) VALUES ($1, $2, $3, 'applied')`;
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      for (const [held, publishedAt] of [
        [false, null],
        [false, null],
        [true, null],
        [false, '2026-06-30 12:00:00'],
      ] as const) {
        await tx.query(outbox, [tx.tenantId, randomUUID(), held, publishedAt]);
      }
      await tx.query(inbox, [tx.tenantId, e1, 'mk-sub-x']);
      await tx.query(inbox, [tx.tenantId, e2, 'mk-sub-y']);
    });
    await handle.app.withTenant(TENANT_B.tenantId, (tx) => tx.query(inbox, [tx.tenantId, e1, 'mk-sub-x']));

    const res = await get('/position', { eventIds: `${e1.toUpperCase()}, ${e3},` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<PositionResponse>();
    const tenants = [
      { tenantId: TENANT_A.tenantId, unpublished: 2, held: 1 },
      { tenantId: TENANT_B.tenantId, unpublished: 0, held: 0 },
      { tenantId: TENANT_UMBRELLA.tenantId, unpublished: 0, held: 0 },
    ].sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
    expect(body).toEqual({
      owner: OWNER,
      position: expect.stringMatching(/^\d+$/),
      outbox: { tenants, unpublished: 2, held: 1 },
      inbox: { total: 3, bySubscription: { 'mk-sub-x': 2, 'mk-sub-y': 1 }, receipts: { [e1]: [TENANT_A.tenantId, TENANT_B.tenantId], [e3]: [] } },
    });
    expect(BigInt(body.position) >= BigInt(written?.xid ?? 'x')).toBe(true);

    const plain = await get('/position');
    expect(plain.json<PositionResponse>().inbox).toEqual({ total: 3, bySubscription: { 'mk-sub-x': 2, 'mk-sub-y': 1 } });
    expectRejected(await get('/position', { eventIds: 'not-a-uuid' }));
  });

  /** Inserts one outbox row of `topic` in `tenantId` and returns it as listed; `publishedAt` null leaves it unpublished. */
  async function outboxRow(
    tenantId: string,
    topic: string,
    options: { kind?: 'state' | 'process'; held?: boolean; publishedAt?: string | null } = {},
  ): Promise<PublishedEvent> {
    const eventId = randomUUID();
    const kind = options.kind ?? 'state';
    const { rows } = await handle.app.withTenant(tenantId, (tx) =>
      tx.query<{ seq: string }>(
        `INSERT INTO ${handle.schema}.outbox (tenant_id, event_id, topic, kind, ordering_key, envelope, held, created_at, published_at)
         VALUES ($1, $2, $3, $4, 'k', '{}'::jsonb, $5, localtimestamp(3), $6) RETURNING seq::text AS seq`,
        [tx.tenantId, eventId, topic, kind, options.held ?? false, options.publishedAt === undefined ? '2026-06-30 12:00:00' : options.publishedAt],
      ),
    );
    return { eventId, topic, tenantId, kind, seq: rows[0]?.seq ?? '' };
  }

  async function listing(topics: string, after?: string, limit?: number, through?: string): Promise<PositionResponse> {
    const res = await get('/position', {
      publishedTopics: topics,
      ...(after === undefined ? {} : { publishedAfter: after }),
      ...(limit === undefined ? {} : { publishedLimit: String(limit) }),
      ...(through === undefined ? {} : { publishedThrough: through }),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<PositionResponse>();
  }

  it('lists every published event of the asked topics by tenant, topic and id on an unpaged read, past unpublished rows and a page', async () => {
    await seedRegistry(handle.app);
    const [created, changed, unasked] = ['mk.unpaged.created.v1', 'mk.unpaged.changed.v1', 'mk.unpaged.unasked.v1'];
    const expected: PublishedEvent[] = [];
    for (const fixture of [TENANT_B, TENANT_A]) {
      await outboxRow(fixture.tenantId, created, { publishedAt: null });
      await outboxRow(fixture.tenantId, created, { held: true, publishedAt: null });
      expected.push(await outboxRow(fixture.tenantId, created, { kind: 'process' }));
      expected.push(await outboxRow(fixture.tenantId, changed));
      await outboxRow(fixture.tenantId, unasked);
    }
    const bulk = await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query<{ event_id: string; seq: string }>(
        `INSERT INTO ${handle.schema}.outbox (tenant_id, event_id, topic, kind, ordering_key, envelope, held, created_at, published_at)
         SELECT $1, gen_random_uuid(), $2, 'state', 'k', '{}'::jsonb, false, localtimestamp(3), localtimestamp(3) FROM generate_series(1, $3::int)
         RETURNING event_id::text AS event_id, seq::text AS seq`,
        [tx.tenantId, changed, MAX_PUBLISHED_LIMIT],
      ),
    );
    for (const row of bulk.rows) expected.push({ eventId: row.event_id, topic: changed, tenantId: TENANT_A.tenantId, kind: 'state', seq: row.seq });
    const order = (e: PublishedEvent): string => `${e.tenantId} ${e.topic} ${e.eventId}`;
    expected.sort((a, b) => (order(a) < order(b) ? -1 : 1));

    const unpaged = await listing(`${created},${changed}`);
    expect(unpaged.published).toHaveLength(MAX_PUBLISHED_LIMIT + 4);
    expect(unpaged.published).toEqual(expected);
    for (const member of ['publishedNext', 'publishedComplete', 'publishedFrontier', 'publishedUpTo']) expect(unpaged).not.toHaveProperty(member);
    expect((await listing('')).published).toEqual([]);
    const paged = await listing(changed, '0');
    expect(paged.published).toHaveLength(MAX_PUBLISHED_LIMIT);
    expect(paged).toMatchObject({ publishedComplete: false, publishedFrontier: bulk.rows.at(-1)?.seq });
    expect(paged).not.toHaveProperty('publishedUpTo');
  });

  it('lists the published events of the asked topics in every registered tenant by seq, with their kind, on a paged read', async () => {
    await seedRegistry(handle.app);
    const [created, changed, unasked] = ['mk.listed.created.v1', 'mk.listed.changed.v1', 'mk.listed.unasked.v1'];
    const expected: PublishedEvent[] = [];
    for (const fixture of [TENANT_UMBRELLA, TENANT_B, TENANT_A]) {
      expected.push(await outboxRow(fixture.tenantId, changed));
      expected.push(await outboxRow(fixture.tenantId, created, { kind: 'process' }));
      await outboxRow(fixture.tenantId, unasked);
    }

    const answer = await listing(` ${created},${changed}, `, '0');
    expect(answer).toMatchObject({
      published: expected,
      publishedNext: expected.at(-1)?.seq,
      publishedComplete: true,
      publishedFrontier: expected.at(-1)?.seq,
      publishedUpTo: 0,
    });
    const after = expected[2]?.seq ?? '';
    expect(await listing(`${created},${changed}`, after)).toMatchObject({ published: expected.slice(3), publishedComplete: true, publishedUpTo: 3 });
    expect(await listing('', '0')).toMatchObject({ published: [], publishedNext: '0', publishedComplete: true, publishedFrontier: '0', publishedUpTo: 0 });
    expect(await listing(created, '999999999999999999')).toMatchObject({
      published: [],
      publishedNext: '999999999999999999',
      publishedComplete: true,
      publishedFrontier: expected.filter((listed) => listed.topic === created).at(-1)?.seq,
    });
    expect((await get('/position')).json<PositionResponse>()).not.toHaveProperty('published');
    expectRejected(await get('/position', { publishedTopics: `${created},mk.listed.created` }));
  });

  it('lists the registry tenants, each site and its pools once, only when asked', async () => {
    await seedRegistry(handle.app);
    const poolOnly = tenantIdForSite('mk-pool-only');
    try {
      await withMetadata(handle.app, (tx) =>
        tx.query(`UPDATE ${handle.schema}.tenant_registry SET public_user_pool_id = 'mk-pool-only', public_user_pool_tenant = $1 WHERE site_id = $2`, [
          poolOnly,
          TENANT_B.siteId,
        ]),
      );

      const res = await get('/position', { registeredTenants: 'true' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<PositionResponse>().registeredTenants).toEqual([TENANT_A.tenantId, TENANT_B.tenantId, TENANT_UMBRELLA.tenantId, poolOnly].sort());
      expect((await get('/position', { registeredTenants: 'false' })).json<PositionResponse>()).not.toHaveProperty('registeredTenants');
      expect((await get('/position')).json<PositionResponse>()).not.toHaveProperty('registeredTenants');
      expectRejected(await get('/position', { registeredTenants: 'yes' }));
    } finally {
      await seedRegistry(handle.app);
    }
  });

  it('pages published events across tenants by seq, never past a tenant whose own page is full', async () => {
    await seedRegistry(handle.app);
    const topic = 'mk.paged.created.v1';
    const rows: PublishedEvent[] = [];
    for (const tenantId of [TENANT_A.tenantId, TENANT_A.tenantId, TENANT_B.tenantId, TENANT_A.tenantId, TENANT_B.tenantId]) rows.push(await outboxRow(tenantId, topic));

    const first = await listing(topic, undefined, 2);
    expect(first).toMatchObject({ published: rows.slice(0, 2), publishedNext: rows[1]?.seq, publishedComplete: false, publishedFrontier: rows[4]?.seq });
    const second = await listing(topic, first.publishedNext, 2);
    expect(second).toMatchObject({ published: rows.slice(2, 4), publishedNext: rows[3]?.seq, publishedComplete: false });
    // Only the page that completes the listing counts the rows behind its cursor.
    for (const page of [first, second]) expect(page).not.toHaveProperty('publishedUpTo');
    const third = await listing(topic, second.publishedNext, 2);
    expect(third).toMatchObject({ published: rows.slice(4), publishedNext: rows[4]?.seq, publishedComplete: true, publishedUpTo: 4 });
  });

  it.each<[string, { held?: boolean; publishedAt: null }]>([
    ['an unpublished row', { publishedAt: null }],
    ['a held row', { held: true, publishedAt: null }],
  ])('stops the cursor below %s of the asked topics until it is published', async (_label, blocking) => {
    await seedRegistry(handle.app);
    const topic = `mk.blocked${blocking.held === true ? 'held' : 'unpublished'}.created.v1`;
    const before = await outboxRow(TENANT_A.tenantId, topic);
    const blocker = await outboxRow(TENANT_B.tenantId, topic, blocking);
    const after = await outboxRow(TENANT_A.tenantId, topic);
    await outboxRow(TENANT_A.tenantId, 'mk.blocked.other.v1', { publishedAt: null });

    const blocked = await listing(topic, '0');
    expect(blocked).toMatchObject({ published: [before], publishedNext: String(BigInt(blocker.seq) - 1n), publishedComplete: false, publishedFrontier: after.seq });
    expect(await listing(topic, blocked.publishedNext)).toMatchObject({ published: [], publishedNext: blocked.publishedNext, publishedComplete: false });

    await handle.app.withTenant(TENANT_B.tenantId, (tx) =>
      tx.query(`UPDATE ${handle.schema}.outbox SET held = false, published_at = localtimestamp(3) WHERE event_id = $1`, [blocker.eventId]),
    );
    expect(await listing(topic, blocked.publishedNext)).toMatchObject({ published: [blocker, after], publishedNext: after.seq, publishedComplete: true, publishedUpTo: 1 });
  });

  it('counts a row published behind the cursor in publishedUpTo', async () => {
    await seedRegistry(handle.app);
    const topic = 'mk.behind.created.v1';
    const listed = await outboxRow(TENANT_A.tenantId, topic);
    const cursor = (await listing(topic, '0')).publishedNext;
    expect(cursor).toBe(listed.seq);
    // A row whose seq was assigned before the cursor passed it, committed afterwards.
    await handle.app.withTenant(TENANT_B.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.outbox (seq, tenant_id, event_id, topic, kind, ordering_key, envelope, held, created_at, published_at)
         OVERRIDING SYSTEM VALUE VALUES ($1::bigint - 1, $2, $3, $4, 'process', 'k', '{}'::jsonb, false, localtimestamp(3), localtimestamp(3))`,
        [listed.seq, tx.tenantId, randomUUID(), topic],
      ),
    );

    expect(await listing(topic, cursor)).toMatchObject({ published: [], publishedComplete: true, publishedUpTo: 2 });
  });

  it('pages through publishedThrough alone, neither listing nor blocking on later rows, and echoes it as publishedFrontier', async () => {
    await seedRegistry(handle.app);
    const topic = 'mk.frontier.created.v1';
    const first = await outboxRow(TENANT_A.tenantId, topic);
    const second = await outboxRow(TENANT_B.tenantId, topic);
    const head = await listing(topic, '0', 1);
    expect(head).toMatchObject({ published: [first], publishedComplete: false, publishedFrontier: second.seq });
    // Rows after the frontier: one published, one held unpublished; the pass through the frontier sees neither.
    const later = await outboxRow(TENANT_A.tenantId, topic);
    const held = await outboxRow(TENANT_B.tenantId, topic, { held: true, publishedAt: null });
    const frontier = head.publishedFrontier ?? '';

    const through = await listing(topic, head.publishedNext, undefined, frontier);
    expect(through).toEqual(
      expect.objectContaining({ published: [second], publishedNext: second.seq, publishedComplete: true, publishedFrontier: frontier, publishedUpTo: 1 }),
    );
    const alone = await get('/position', { publishedTopics: topic, publishedThrough: first.seq });
    expect(alone.json<PositionResponse>()).toMatchObject({ published: [first], publishedComplete: true, publishedFrontier: first.seq, publishedUpTo: 0 });
    // A page without the frontier reports the new head and stops below the held row.
    expect(await listing(topic, second.seq)).toMatchObject({ published: [later], publishedNext: later.seq, publishedComplete: false, publishedFrontier: held.seq });
  });

  it.each([
    ['a negative cursor', { publishedAfter: '-1' }],
    ['a cursor beyond bigint', { publishedAfter: '9999999999999999999' }],
    ['a frontier beyond bigint', { publishedThrough: '9999999999999999999' }],
    ['a limit of 0', { publishedLimit: '0' }],
    ['a limit above 1000', { publishedLimit: '1001' }],
  ])('rejects a published listing with %s as invalidParameters', async (_label, query) => {
    expectRejected(await get('/position', { publishedTopics: 'mk.listed.created.v1', ...query }));
  });

  it('stores watermarks under normalised Program_<id> names and lists them by table and direction', async () => {
    const mark = { direction: 'forward', snapshotSeq: 42, backupLsn: '1234567890123456789012345', finishedAt: '2026-06-30 12:00:00.5' };
    const stored1 = await post('/watermark', { legacyTable: '[Program_2].[Scores]', ...mark });
    expect(stored1.statusCode, stored1.body).toBe(200);
    expect(stored1.json()).toEqual({ ...mark, legacyTable: 'Program_2.Scores', finishedAt: '2026-06-30T12:00:00.500' });
    const reverse = await post('/watermark', { legacyTable: 'Program_2.Scores', direction: 'reverse', finishedAt: '2026-06-30T13:00:00' });
    expect(reverse.json()).toEqual({ legacyTable: 'Program_2.Scores', direction: 'reverse', snapshotSeq: null, backupLsn: null, finishedAt: '2026-06-30T13:00:00.000' });
    const replaced = await post('/watermark', { legacyTable: 'program_2.Scores', ...mark, snapshotSeq: 43 });
    expect(replaced.json()).toMatchObject({ legacyTable: 'Program_2.Scores', snapshotSeq: 43 });

    expect((await watermarks({ legacyTable: 'Program_2.Scores' })).map((record) => [record.direction, record.snapshotSeq])).toEqual([
      ['forward', 43],
      ['reverse', null],
    ]);
    expect(await watermarks({ legacyTable: '[Program_2].[Scores]', direction: 'reverse' })).toEqual([reverse.json()]);
    const all = await watermarks({ direction: 'forward' });
    expect(all.every((record) => record.direction === 'forward')).toBe(true);
    expect(all.map((record) => record.legacyTable)).toContain('Program_2.Scores');
  });

  it.each([
    ['POST', { legacyTable: 'tItems', direction: 'sideways', finishedAt: '2026-06-30 12:00:00' }],
    ['POST', { legacyTable: 'tItems', direction: 'forward', finishedAt: '2026-06-30T12:00:00Z' }],
    ['POST', { legacyTable: 'tItems', direction: 'forward', finishedAt: '2026-06-30 12:00:00', backupLsn: '12a' }],
    ['POST', { legacyTable: '', direction: 'forward', finishedAt: '2026-06-30 12:00:00' }],
    ['GET', { direction: 'sideways' }],
    ['GET', { table: 'tItems' }],
  ] as ['GET' | 'POST', Record<string, string>][])('rejects a %s watermark request with %j as invalidParameters', async (method, input) => {
    expectRejected(method === 'POST' ? await post('/watermark', input) : await get('/watermark', input));
  });

  it('closes, re-phases and reopens gates by compare-and-set on the holder, refusing other holders with 409', async () => {
    const gate = async (body: Record<string, unknown>): Promise<LightMyRequestResponse> => post('/gate', body);
    const conflict = (units: string[]): Record<string, unknown> => ({ error: 'gate-conflict', units });

    const legacyClose = await gate({ op: 'close', units: ['mk.item'], holderId: 'h1' });
    expect(legacyClose.statusCode).toBe(409);
    expect(legacyClose.json()).toEqual(conflict(['mk.item']));

    const closedGates = [
      { unit: 'mk.item', state: 'closed', holderId: 'h1', phase: 'quiet' },
      { unit: 'mk.tag_member', state: 'closed', holderId: 'h1', phase: 'quiet' },
    ];
    const closed = await gate({ op: 'close', units: ['mk.tag_member', 'mk.item'], holderId: 'h1', allowLegacy: true, timeoutMs: 2000 });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toEqual({ units: closedGates });
    expect((await gate({ op: 'close', units: ['mk.item', 'mk.tag_member'], holderId: 'h1', allowLegacy: true })).json()).toEqual({ units: closedGates });
    const taken = await gate({ op: 'close', units: ['mk.item'], holderId: 'h2', allowLegacy: true });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual(conflict(['mk.item']));

    const phased = await gate({ op: 'phase', units: ['mk.item'], holderId: 'h1', phase: 'executing' });
    expect(phased.json()).toEqual({ units: [{ unit: 'mk.item', state: 'closed', holderId: 'h1', phase: 'executing' }] });
    expect((await gate({ op: 'phase', units: ['mk.item'], holderId: 'h2', phase: 'importing' })).json()).toEqual(conflict(['mk.item']));

    const site = freshSite();
    expect(
      await applied({ batchId: `${site}-gated`, legacyTable: 'tItems', siteId: site, columns: ITEM_LEGACY, rows: rowsOf(ITEM_LEGACY, [['upsert', item('i1', site, 'G', 1)]]) }),
    ).toMatchObject({ applied: 1 });
    expect((await exportPage({ unit: 'mk.item', siteId: site })).tables[0]?.rows).toHaveLength(1);

    const foreignOpen = await gate({ op: 'open', units: ['mk.item'], holderId: 'h2' });
    expect(foreignOpen.statusCode).toBe(409);
    expect(foreignOpen.json()).toEqual(conflict(['mk.item']));
    const reopened = await gate({ op: 'open', units: ['mk.item', 'mk.tag_member'], holderId: 'h1' });
    expect(reopened.json()).toEqual({
      units: [
        { unit: 'mk.item', state: 'open', holderId: null, phase: 'quiet' },
        { unit: 'mk.tag_member', state: 'open', holderId: null, phase: 'quiet' },
      ],
    });

    expect((await gate({ op: 'close', units: ['mk.item'], holderId: 'h3' })).json()).toEqual({
      units: [{ unit: 'mk.item', state: 'closed', holderId: 'h3', phase: 'quiet' }],
    });
    expect((await gate({ op: 'open', units: ['mk.item'], holderId: 'h3', state: 'legacy' })).json()).toEqual({
      units: [{ unit: 'mk.item', state: 'legacy', holderId: null, phase: 'quiet' }],
    });
    expect((await gate({ op: 'status', units: ['mk.tag_member'] })).json()).toEqual({
      units: [{ unit: 'mk.tag_member', state: 'open', holderId: null, phase: 'quiet' }],
    });
  });

  it('answers the legacy 503 when an open operation keeps a gate from closing within timeoutMs', async () => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.open_operation (operation_id, kind, units) VALUES ('op-block', 'roster', '{mk.memo}')`),
    );
    try {
      const res = await post('/gate', { op: 'close', units: ['mk.memo'], holderId: 'h-blocked', allowLegacy: true, timeoutMs: 200 });
      expect(res.statusCode).toBe(503);
      expect((await post('/gate', { op: 'status', units: ['mk.memo'] })).json()).toEqual({
        units: [{ unit: 'mk.memo', state: 'legacy', holderId: null, phase: 'quiet' }],
      });
    } finally {
      await endOperation(handle.app, 'op-block');
    }
  });

  it.each([
    ['a unit the owner does not declare', { op: 'close', units: ['mk.item', 'people.person'], holderId: 'h' }],
    ['no units', { op: 'close', units: [], holderId: 'h' }],
    ['no holder', { op: 'open', units: ['mk.item'] }],
    ['an unknown op', { op: 'steal', units: ['mk.item'], holderId: 'h' }],
    ['a phase op without a phase', { op: 'phase', units: ['mk.item'], holderId: 'h' }],
    ['a timeout above the gate budget', { op: 'close', units: ['mk.item'], holderId: 'h', timeoutMs: GATE_WAIT_MS + 1 }],
    ['an open into the closed state', { op: 'open', units: ['mk.item'], holderId: 'h', state: 'closed' }],
  ] as [string, Record<string, unknown>][])('rejects a gate request with %s as invalidParameters', async (_label, body) => {
    expectRejected(await post('/gate', body));
  });

  const REJECTED_SITE = 'tenant-a';
  const okItem = encodeRow(ITEM_LEGACY, item('i1', REJECTED_SITE, 'N', 1));
  const applyBase = { batchId: 'rejected', origin: 'backfill', legacyTable: 'tItems', siteId: REJECTED_SITE, columns: ITEM_LEGACY, rows: [{ op: 'upsert', row: okItem }] };

  it.each([
    ['no batchId', { ...applyBase, batchId: undefined }],
    ['an unknown field', { ...applyBase, extra: true }],
    ['an unknown origin', { ...applyBase, origin: 'target' }],
    ['a legacy table the owner does not map', { ...applyBase, legacyTable: 'tGhost' }],
    ['both tenantId and siteId', { ...applyBase, tenantId: TENANT_A.tenantId }],
    ['columns lacking an owned column', { ...applyBase, columns: ITEM_LEGACY.slice(0, 3), rows: [{ op: 'upsert', row: encodeRow(ITEM_LEGACY.slice(0, 3), item('i1', REJECTED_SITE, 'N', 1)) }] }],
    ['an owned column encoded with another type', { ...applyBase, columns: [...ITEM_LEGACY.slice(0, 3), { name: 'Qty', type: 's' }] }],
    ['split rows without their split column', { ...applyBase, legacyTable: 'tNotes', columns: MEMO_LEGACY, rows: [] }],
    ['a row encoding that does not fit its columns', { ...applyBase, rows: [{ op: 'upsert', row: 's2:i1' }] }],
    ['a row of another site', { ...applyBase, rows: rowsOf(ITEM_LEGACY, [['upsert', item('i1', 'tenant-b', 'N', 1)]]) }],
    ['a legacyProgramId contradicting the Program_<id> name', { ...applyBase, legacyTable: 'Program_1.Scores', legacyProgramId: 2, columns: SCORE_LEGACY, rows: [] }],
    ['a legacyProgramId for a table that is not per-program', { ...applyBase, legacyProgramId: 1 }],
    ['a legacyProgramId beyond the range of the legacy_program_id column', { ...applyBase, legacyTable: 'Scores', legacyProgramId: 99999999999, columns: SCORE_LEGACY, rows: rowsOf(SCORE_LEGACY, [['upsert', { ScoreID: 's1', Points: 1 }]]) }],
    ['a Program_<id> name beyond the range of the legacy_program_id column', { ...applyBase, legacyTable: 'Program_99999999999.Scores', columns: SCORE_LEGACY, rows: rowsOf(SCORE_LEGACY, [['delete', { ScoreID: 's1', Points: 1 }]]) }],
    ['a Program_<id> name beyond the range of the legacy_program_id column and no rows', { ...applyBase, legacyTable: '[Program_2147483648].[Scores]', columns: SCORE_LEGACY, rows: [] }],
    ['a per-program table named without its Program_<id> and no rows', { ...applyBase, legacyTable: 'Scores', columns: SCORE_LEGACY, rows: [] }],
    ['an upsert into a keyless table', { ...applyBase, legacyTable: 'tTagMembers', columns: TAG_LEGACY, rows: rowsOf(TAG_LEGACY, [['upsert', { Label: 'a', Weight: 1 }]]) }],
    ['an insert into a keyed table', { ...applyBase, rows: [{ op: 'insert', row: okItem }] }],
  ] as [string, Record<string, unknown>][])('rejects an apply with %s as invalidParameters and records no batch', async (_label, body) => {
    // Bound to the batch site, so the range cases fail on the column, not on the program-site lookup.
    bindPrograms(REJECTED_SITE, 99999999999, 2147483648);
    expectRejected(await post('/apply', body));
    expect(await batches(REJECTED_SITE)).toEqual([]);
  });

  it.each([
    ['without its key value', 'RepositoryError', REDACTED, (site: string): LegacyValues => ({ ...item('i1', site, 'opt2-secret-key', 1), ItemID: null })],
    ['with a value longer than its column', 'error', 'PostgreSQL error 22001', (site: string): LegacyValues => item('i1', site, `opt2-secret-${'x'.repeat(50)}`, 1)],
    ['with an integer beyond the range of its column', 'error', 'PostgreSQL error 22003', (site: string): LegacyValues => item('i1', site, 'opt2-secret-qty', 2 ** 40)],
    ['with a NUL character in a text value', 'error', 'PostgreSQL error 22021', (site: string): LegacyValues => item('i1', site, 'opt2-secret-\u0000', 1)],
  ] as [string, string, string, (site: string) => LegacyValues][])(
    'rejects an apply row %s as badRequest, logs only its sanitized error and records no batch',
    async (_label, type, message, values) => {
      const site = freshSite();
      const batch = (row: LegacyValues): Record<string, unknown> => ({ ...applyBase, batchId: `${site}-unwritable`, siteId: site, rows: rowsOf(ITEM_LEGACY, [['upsert', row]]) });
      logLines.length = 0;
      const res = await post('/apply', batch(values(site)));
      expectRejected(res, 'Bad Request');
      expect(res.body).not.toContain('opt2-secret');
      expect(logLines).toContainEqual(
        expect.objectContaining({ severity: 'WARNING', message: 'migration request rejected', error: expect.objectContaining({ type, message }) }),
      );
      expect(logLines.filter((line) => line.severity === 'ERROR')).toEqual([]);
      expect(JSON.stringify(logLines)).not.toContain('opt2-secret');
      expect(await batches(site)).toEqual([]);
      expect(await applied(batch(item('i1', site, 'N', 1)))).toMatchObject({ duplicate: false, applied: 1 });
    },
  );

  it('logs the error type of a rejected request and keeps its rows out of the error body and the log', async () => {
    logLines.length = 0;
    const res = await post('/apply', { ...applyBase, rows: rowsOf(ITEM_LEGACY, [['upsert', item('secret-row', 'tenant-b', 'N', 1)]]) });
    expectRejected(res);
    expect(res.body).not.toContain('secret-row');
    expect(logLines).toContainEqual(
      expect.objectContaining({ message: 'migration request rejected', error: expect.objectContaining({ type: 'MappingError' }) }),
    );
    expect(JSON.stringify(logLines)).not.toContain('secret-row');
  });

  it.each([
    ['a malformed changes cursor', 'InvalidCursorError', ['opt2-secret-cursor'], () => get('/changes', { siteId: REJECTED_SITE, after: 'opt2-secret-cursor' })],
    ['an apply with an unknown field', 'ZodError', ['opt2SecretField'], () => post('/apply', { ...applyBase, opt2SecretField: true })],
    [
      'an apply row that fails its mapping',
      'MappingError',
      ['opt2-secret-row', 'SiteID'],
      () => post('/apply', { ...applyBase, rows: rowsOf(ITEM_LEGACY, [['upsert', item('opt2-secret-row', 'tenant-b', 'N', 1)]]) }),
    ],
  ] as [string, string, string[], () => Promise<LightMyRequestResponse>][])(
    'passes the logger only the sanitized error of %s and answers the legacy 400',
    async (_label, type, supplied, send) => {
      // Spies on the call arguments, ahead of the logger's own emission-time sanitizing.
      const warn = vi.spyOn(app.log, 'warn');
      try {
        const res = await send();
        expectRejected(res);
        const rejected = warn.mock.calls.filter((call) => call[1] === 'migration request rejected');
        const stack = expect.stringMatching(new RegExp(`^${type}: \\[REDACTED\\](?:\\n\\s+at \\S.*)*$`));
        expect(rejected).toEqual([[{ error: { type, message: REDACTED, stack } }, 'migration request rejected']]);
        for (const text of supplied) {
          expect(JSON.stringify(rejected)).not.toContain(text);
          expect(res.body).not.toContain(text);
        }
      } finally {
        warn.mockRestore();
      }
    },
  );
});

describe.skipIf(!available)('migration endpoints of a service without outbox, inbox or object manifest', () => {
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: `${OWNER}-bare`, schemaName: BASE, extraSql: [migrationKitSql(BASE), ITEM_SQL] });
    app = await serviceApp(handle.app);
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository: createRepository({ owner: OWNER, schema: handle.schema, tables: TABLES }),
      mappings: [ITEM_MAPPING, TAG_MAPPING],
      units: ['mk.item', 'mk.tag_member'],
    });
    await app.ready();
    headers = await authHeadersFor(subject('service:migration'), { audience: OWNER });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  it.each([
    ['an export', (): Promise<LightMyRequestResponse> => app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/export`, headers, query: { unit: 'mk.tag_member', siteId: 'tenant-a' } })],
    [
      'an apply',
      (): Promise<LightMyRequestResponse> =>
        app.inject({
          method: 'POST',
          url: `${MIGRATION_PATH_PREFIX}/apply`,
          headers,
          payload: { batchId: 'bare-tags', origin: 'backfill', legacyTable: 'tTagMembers', siteId: 'tenant-a', columns: TAG_LEGACY, rows: rowsOf(TAG_LEGACY, [['insert', { Label: 'a', Weight: 1 }]]) },
        }),
    ],
  ] as [string, () => Promise<LightMyRequestResponse>][])('answers the legacy 500, not a 400, when the database fails during %s, recording no batch', async (_label, send) => {
    const res = await send();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { message: 'Unhandled Exception', code: 'server_error' } });
    const recorded = await handle.app.withTenant(TENANT_A.tenantId, async (tx) => (await tx.query(`SELECT batch_id FROM ${handle.schema}.migration_batch`)).rows);
    expect(recorded).toEqual([]);
  });

  it('reports null outbox and inbox counts and exports a unit without an object manifest', async () => {
    const position = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/position`, headers });
    expect(position.statusCode, position.body).toBe(200);
    expect(position.json()).toEqual({ owner: OWNER, position: expect.stringMatching(/^\d+$/), outbox: null, inbox: null });
    const listing = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/position`, headers, query: { publishedTopics: 'mk.item.changed.v1' } });
    expect(listing.json<PositionResponse>().published).toEqual([]);

    const exportRes = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/export`, headers, query: { unit: 'mk.item', siteId: 'tenant-a' } });
    expect(exportRes.json()).toEqual({
      unit: 'mk.item',
      tenantId: TENANT_A.tenantId,
      tables: [{ unit: 'mk.item', legacyTable: 'tItems', targetTable: 'mk.item', keyless: false, columns: ITEM_LEGACY, rows: [] }],
      next: null,
    });
    const status = await app.inject({ method: 'POST', url: `${MIGRATION_PATH_PREFIX}/gate`, headers, payload: { op: 'status' } });
    expect(status.json()).toEqual({
      units: [
        { unit: 'mk.item', state: 'legacy', holderId: null, phase: 'quiet' },
        { unit: 'mk.tag_member', state: 'legacy', holderId: null, phase: 'quiet' },
      ],
    });
  });

  it.each([
    ['a manifest cursor', { objects: 'p1' }],
    ['a row cursor with a manifest position', { table: 'item', key: ['i1'], objects: 'p1' }],
  ])('rejects %s as invalidParameters when the owner has no object manifest', async (_label, cursor) => {
    const res = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/export`, headers, query: { unit: 'mk.item', siteId: 'tenant-a', after: cursorText(cursor) } });
    expectRejected(res);
  });
});

describe.skipIf(!available)('migration export match over a table whose mappings store different columns', () => {
  const NARROW_ARCHIVE = defineMapping({ legacyTable: 'tNoteArchive', targetTable: 'mk.memo', columns: MEMO_COLUMNS.slice(0, 1), key: ['NoteID'] });
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: `${OWNER}-match`, schemaName: BASE, extraSql: [migrationKitSql(BASE), TABLES_SQL] });
    app = await serviceApp(handle.app);
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository: createRepository({ owner: OWNER, schema: handle.schema, tables: TABLES }),
      mappings: [NOTE_MAPPING, NARROW_ARCHIVE],
      units: ['mk.memo'],
    });
    await app.ready();
    headers = await authHeadersFor(subject('service:migration'), { audience: OWNER });
    const notes = rowsOf(NOTE_LEGACY, [
      ['upsert', { NoteID: 'n1', Type: 'Memo', Body: 'kept' }],
      ['upsert', { NoteID: 'n2', Type: 'Memo', Body: 'other' }],
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `${MIGRATION_PATH_PREFIX}/apply`,
      headers,
      payload: { batchId: 'match-notes', origin: 'backfill', legacyTable: 'tNotes', siteId: 'tenant-a', columns: NOTE_LEGACY, rows: notes },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await handle.drop();
  });

  it.each([
    ['filters both mappings by a column both store', { noteid: ['N1'] }, ['n1']],
    ['exports both mappings whole for a column one does not store', { Body: ['kept'] }, ['n1', 'n2']],
  ] as [string, Record<string, string[]>, string[]][])('%s', async (_label, match, ids) => {
    const res = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/export`, headers, query: { unit: 'mk.memo', siteId: 'tenant-a', match: JSON.stringify(match) } });
    expect(res.statusCode, res.body).toBe(200);
    const keys = ids.map((id) => encodeKey(MEMO_LEGACY, ['NoteID'], { NoteID: id }));
    expect(res.json<ExportResponse>().tables.map((table) => [table.legacyTable, table.rows.map((row) => row.key)])).toEqual([
      ['tNotes', keys],
      ['tNoteArchive', keys],
    ]);
  });
});

describe.skipIf(!available)('migration endpoints of a service paging its object manifest', () => {
  type ManifestScope = Parameters<NonNullable<MigrationHandlerOptions['exportObjects']>>[1];
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let sites = 0;
  const manifests = new Map<string, ObjectManifestEntry[]>();
  const calls: ManifestScope[] = [];

  /** Up to `limit` of the tenant's manifest entries after the entry keyed `after`; `next` is the last key while entries remain. */
  function manifestPage(scope: ManifestScope): ObjectManifestPage {
    const entries = manifests.get(scope.tenantId) ?? [];
    const from = scope.after === undefined ? 0 : entries.findIndex((entry) => entry.key === scope.after) + 1;
    const objects = entries.slice(from, from + (scope.limit ?? DEFAULT_EXPORT_LIMIT));
    return { objects, next: from + objects.length < entries.length ? (objects.at(-1)?.key ?? null) : null };
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: `${OWNER}-paged`, schemaName: BASE, extraSql: [migrationKitSql(BASE), ITEM_SQL] });
    app = await serviceApp(handle.app);
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository: createRepository({ owner: OWNER, schema: handle.schema, tables: TABLES }),
      mappings: [ITEM_MAPPING],
      units: ['mk.item'],
      exportObjects: (_tx, scope) => {
        calls.push(scope);
        return Promise.resolve(manifestPage(scope));
      },
    });
    await app.ready();
    headers = await authHeadersFor(subject('service:migration'), { audience: OWNER });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  /** `list` cut into consecutive pieces of `sizes`; a null size stands for a page without rows and stays null. */
  function chunks<T>(list: readonly T[], sizes: readonly (number | null)[]): (T[] | null)[] {
    let from = 0;
    return sizes.map((size) => {
      if (size === null) return null;
      from += size;
      return list.slice(from - size, from);
    });
  }

  it.each([
    {
      ending: 'before the rows',
      rowCount: 5,
      objectCount: 3,
      limit: 2,
      rowPages: [2, 2, 1],
      objectPages: [2, 1, null],
      cursors: (ids: string[], keys: string[]) => [{ table: 'item', key: [ids[1]], objects: keys[1] }, { table: 'item', key: [ids[3]] }, null],
      afters: (keys: string[]) => [undefined, keys[1]],
    },
    {
      ending: 'after the rows',
      rowCount: 3,
      objectCount: 7,
      limit: 2,
      rowPages: [2, 1, null, null],
      objectPages: [2, 2, 2, 1],
      cursors: (ids: string[], keys: string[]) => [{ table: 'item', key: [ids[1]], objects: keys[1] }, { objects: keys[3] }, { objects: keys[5] }, null],
      afters: (keys: string[]) => [undefined, keys[1], keys[3], keys[5]],
    },
    {
      ending: 'with the first page of a unit without rows',
      rowCount: 0,
      objectCount: 3,
      limit: undefined,
      rowPages: [0],
      objectPages: [3],
      cursors: () => [null],
      afters: () => [undefined],
    },
  ])('delivers a paged manifest across the export pages, ending $ending', async ({ rowCount, objectCount, limit, rowPages, objectPages, cursors, afters }) => {
    sites += 1;
    const site = `paged-${sites}`;
    const tenantId = tenantIdForSite(site);
    const values = Array.from({ length: rowCount }, (_, n) => item(`i${n}`, site, `Item ${n}`, n));
    if (rowCount > 0) {
      const res = await app.inject({
        method: 'POST',
        url: `${MIGRATION_PATH_PREFIX}/apply`,
        headers,
        payload: { batchId: `${site}-rows`, origin: 'backfill', legacyTable: 'tItems', siteId: site, columns: ITEM_LEGACY, rows: rowsOf(ITEM_LEGACY, values.map((v): [RowOp, LegacyValues] => ['upsert', v])) },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const manifest = Array.from({ length: objectCount }, (_, n) => ({ key: `${tenantId}/obj-${n}`, size: n, sha256: sha256Hex(`obj-${n}`), contentType: 'text/plain' }));
    manifests.set(tenantId, manifest);

    const pages: ExportResponse[] = [];
    let after: string | null = null;
    do {
      const query = { unit: 'mk.item', siteId: site, ...(limit === undefined ? {} : { limit: String(limit) }), ...(after === null ? {} : { after }) };
      const res = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/export`, headers, query });
      expect(res.statusCode, res.body).toBe(200);
      pages.push(res.json<ExportResponse>());
      after = pages.at(-1)?.next ?? null;
    } while (after !== null && pages.length < 10);

    const ids = values.map((v) => String(v.ItemID));
    const keys = manifest.map((entry) => entry.key);
    const rows = values.map((v) => exported(ITEM_LEGACY, ['ItemID'], v));
    expect(pages.map((page) => (page.tables.length === 0 ? null : page.tables.flatMap((table) => table.rows)))).toEqual(chunks(rows, rowPages));
    expect(pages.map((page) => ('objects' in page ? page.objects : null))).toEqual(chunks(manifest, objectPages));
    expect(pages.flatMap((page) => page.objects ?? [])).toEqual(manifest);
    expect(pages.map((page) => page.next)).toEqual(cursors(ids, keys).map((cursor) => (cursor === null ? null : cursorText(cursor))));
    expect(calls.filter((call) => call.tenantId === tenantId)).toEqual(
      afters(keys).map((position) => ({ unit: 'mk.item', tenantId, limit: limit ?? DEFAULT_EXPORT_LIMIT, ...(position === undefined ? {} : { after: position }) })),
    );
  });

  it.each([
    ['a manifest cursor with an empty position', { objects: '' }],
    ['a row cursor naming a table of no unit', { table: 'score', key: ['1', 's1'], objects: 'p1' }],
  ])('rejects %s as invalidParameters without asking for the manifest', async (_label, cursor) => {
    calls.length = 0;
    const res = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/export`, headers, query: { unit: 'mk.item', siteId: 'tenant-a', after: cursorText(cursor) } });
    expectRejected(res);
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!available)('migration applies of a mapping whose table has a target-only column', () => {
  const VERSIONED: TableDefinition = {
    table: 'versioned',
    unit: 'mk.versioned',
    key: ['item_id'],
    columns: [
      { name: 'tenant_id', type: 's' },
      { name: 'item_id', type: 's' },
      { name: 'name', type: 's' },
      { name: 'row_version', type: 'i' },
    ],
  };
  const VERSIONED_LEGACY: CanonicalColumn[] = [
    { name: 'ItemID', type: 's' },
    { name: 'Name', type: 's' },
  ];
  const VERSIONED_MAPPING = defineMapping({
    legacyTable: 'tVersioned',
    targetTable: 'mk.versioned',
    columns: [
      { legacy: 'ItemID', target: 'item_id', type: 's' },
      { legacy: 'Name', target: 'name', type: 's' },
    ],
    key: ['ItemID'],
  });
  const site = 'versioned-site';
  const tenantId = tenantIdForSite(site);
  const pending: Parameters<NonNullable<MigrationHandlerOptions['targetOnlyColumns']>>[1][] = [];
  const emitted: AppliedChange[] = [];
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: `${OWNER}-versioned`,
      schemaName: BASE,
      extraSql: [
        migrationKitSql(BASE),
        `CREATE TABLE ${BASE}.versioned (tenant_id uuid NOT NULL, item_id text NOT NULL, name text, row_version bigint NOT NULL DEFAULT 0,
           PRIMARY KEY (tenant_id, item_id));`,
        rlsSql(BASE, 'versioned'),
      ],
    });
    app = await serviceApp(handle.app);
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository: createRepository({ owner: OWNER, schema: handle.schema, tables: [VERSIONED] }),
      mappings: [VERSIONED_MAPPING],
      units: ['mk.versioned'],
      emitStateEvents: (_tx, change) => {
        emitted.push(change);
        return Promise.resolve();
      },
      targetOnlyColumns: (_tx, change) => {
        pending.push(change);
        return Promise.resolve({ row_version: String(BigInt(String(change.before?.row_version ?? 0)) + 1n) });
      },
    });
    await app.ready();
    headers = await authHeadersFor(subject('service:migration'), { audience: OWNER });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  /** Applies one upsert of item v1 named `name` and returns the 200 answer. */
  async function applyName(batchId: string, origin: string, name: string): Promise<LightMyRequestResponse> {
    const rows = rowsOf(VERSIONED_LEGACY, [['upsert', { ItemID: 'v1', Name: name }]]);
    const res = await app.inject({
      method: 'POST',
      url: `${MIGRATION_PATH_PREFIX}/apply`,
      headers,
      payload: { batchId, origin, legacyTable: 'tVersioned', siteId: site, columns: VERSIONED_LEGACY, rows },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res;
  }

  it('writes the hook columns in the applied write itself and leaves a row the target already holds unwritten but positioned', async () => {
    expect((await applyName('versioned-b1', 'backfill', 'One')).json()).toEqual({ batchId: 'versioned-b1', duplicate: false, applied: 1, skipped: 0 });
    expect((await applyName('versioned-b2', 'migration-feed', 'Two')).json()).toEqual({ batchId: 'versioned-b2', duplicate: false, applied: 1, skipped: 0 });
    const resent = await applyName('versioned-b3', 'migration-feed', 'Two');
    expect(resent.json()).toEqual({ batchId: 'versioned-b3', duplicate: false, applied: 1, skipped: 0 });
    // An unchanged batch is positioned at its own transaction, which wrote only the batch record.
    const position = /^[^=]+=(\d+)$/.exec(String(resent.headers[WRITE_POSITION_HEADER_LC]))?.[1];
    const [batch] = await handle.app.withTenant(tenantId, async (tx) =>
      (await tx.query<{ xmin: string }>(`SELECT xmin::text AS xmin FROM ${handle.schema}.migration_batch WHERE batch_id = 'versioned-b3'`)).rows,
    );
    expect(resent.headers[WRITE_POSITION_HEADER_LC]).toBe(`${OWNER}=${position}`);
    expect((BigInt(position ?? '0') & 0xffff_ffffn).toString()).toBe(batch?.xmin);

    const one = { tenant_id: tenantId, item_id: 'v1', name: 'One', row_version: '1' };
    const two = { ...one, name: 'Two', row_version: '2' };
    expect(pending).toEqual([
      { unit: 'mk.versioned', table: 'versioned', row: { item_id: 'v1', name: 'One' } },
      { unit: 'mk.versioned', table: 'versioned', row: { item_id: 'v1', name: 'Two' }, before: one },
    ]);
    expect(emitted.map((change) => [change.op, change.after])).toEqual([
      ['insert', one],
      ['update', two],
    ]);
    const log = await handle.app.withTenant(tenantId, async (tx) =>
      (await tx.query<{ op: string; columns: string[]; after: string; request_id: string }>(
        `SELECT op, columns, after, request_id FROM ${handle.schema}.changelog ORDER BY seq`,
      )).rows,
    );
    expect(log).toEqual([
      { op: 'insert', columns: ['item_id', 'name', 'row_version'], after: encodeRow(VERSIONED.columns, one), request_id: 'versioned-b1' },
      { op: 'update', columns: ['name', 'row_version'], after: encodeRow(VERSIONED.columns, two), request_id: 'versioned-b2' },
    ]);
  });
});

describe.skipIf(!available)('migration endpoints of a service with a target-only table', () => {
  const SITE = TENANT_A.siteId;
  const LEDGER_ROWS: LegacyValues[] = [
    { entry_id: 'e3', kind: 'credit', amount: '7.25', booked_at: '2026-06-30 11:00:00', seq: 3 },
    { entry_id: 'e1', kind: 'debit', amount: '12.5', booked_at: '2026-06-30 09:30:00.5', seq: 1 },
    { entry_id: 'e2', kind: null, amount: null, booked_at: null, seq: null },
  ];
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: `${OWNER}-target-only`, schemaName: BASE, extraSql: [migrationKitSql(BASE), ITEM_SQL, LEDGER_SQL] });
    const repository = createRepository({ owner: OWNER, schema: handle.schema, tables: [...TABLES, ...LEDGER_TABLES] });
    app = await serviceApp(handle.app);
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, { owner: OWNER, repository, mappings: [ITEM_MAPPING], units: ['mk.item', 'mk.ledger'], targetOnlyTables: ['ledger'] });
    await app.ready();
    headers = await authHeadersFor(subject('service:migration'), { audience: OWNER });
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      for (const row of LEDGER_ROWS) await repository.insert(tx, 'ledger', row, { authority: createMigrationAuthority() });
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  async function exportOf(query: Record<string, string>): Promise<ExportResponse> {
    const res = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/export`, headers, query: { unit: 'mk.ledger', siteId: SITE, ...query } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ExportResponse>();
  }

  it('exports its rows over its own columns, paged by the keyset cursor and filtered by keys', async () => {
    const table = { unit: 'mk.ledger', legacyTable: '', targetTable: 'mk.ledger', keyless: false, columns: LEDGER_COLUMNS };
    const byId = Object.fromEntries(LEDGER_ROWS.map((values) => [String(values.entry_id), exported(LEDGER_COLUMNS, ['entry_id'], values)]));
    const [e1, e2, e3] = [byId.e1, byId.e2, byId.e3] as ExportRow[];

    const first = await exportOf({ limit: '2' });
    expect(first).toEqual({ unit: 'mk.ledger', tenantId: TENANT_A.tenantId, tables: [{ ...table, rows: [e1, e2] }], next: cursorText({ table: 'ledger', key: ['e2'] }) });
    expect(decodeRow(first.tables[0]?.columns ?? [], first.tables[0]?.rows[0]?.row ?? '')).toEqual({
      entry_id: 'e1',
      kind: 'debit',
      amount: '12.50',
      booked_at: '2026-06-30T09:30:00.500',
      seq: '1',
    });
    expect(await exportOf({ limit: '2', after: first.next as string })).toEqual({ unit: 'mk.ledger', tenantId: TENANT_A.tenantId, tables: [{ ...table, rows: [e3] }], next: null });
    expect((await exportOf({ keys: encodeKey(LEDGER_COLUMNS, ['entry_id'], { entry_id: 'e3' }) })).tables).toEqual([{ ...table, rows: [e3] }]);
  });

  it.each([
    ['its table name', 'ledger'],
    ['its unit name', 'mk.ledger'],
  ])('refuses an apply naming %s as invalidParameters, writing nothing', async (_label, legacyTable) => {
    const res = await app.inject({
      method: 'POST',
      url: `${MIGRATION_PATH_PREFIX}/apply`,
      headers,
      payload: { batchId: `target-only-${legacyTable}`, origin: 'backfill', legacyTable, siteId: SITE, columns: LEDGER_COLUMNS, rows: rowsOf(LEDGER_COLUMNS, [['upsert', { ...LEDGER_ROWS[0], entry_id: 'e9' }]]) },
    });
    expectRejected(res);
    expect((await exportOf({})).tables.flatMap((table) => table.rows.map((row) => decodeRow(LEDGER_COLUMNS, row.row).entry_id))).toEqual(['e1', 'e2', 'e3']);
  });

  it('feeds its writes to the change feed without a legacy projection', async () => {
    const deadline = Date.now() + HORIZON_WAIT_MS;
    let page: ChangesResponse;
    for (;;) {
      const res = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/changes`, headers, query: { siteId: SITE } });
      expect(res.statusCode, res.body).toBe(200);
      page = res.json<ChangesResponse>();
      if (page.rows.length >= LEDGER_ROWS.length || Date.now() > deadline) break;
      await sleep(100);
    }
    expect(page.rows.map((row) => [row.table, row.op, row.legacy])).toEqual(LEDGER_ROWS.map(() => ['ledger', 'insert', []]));
  }, HORIZON_TEST_TIMEOUT_MS);
});
