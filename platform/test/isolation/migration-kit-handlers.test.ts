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
import { REDACTED, createLogger, type Logger } from '../../src/logging/index.js';
import { encodeKey, encodeRow, sha256Hex, type CanonicalColumn } from '../../src/migration-kit/canonical.js';
import { migrationKitSql } from '../../src/migration-kit/ddl.js';
import { GATE_WAIT_MS, endOperation, isMigrationAuthority } from '../../src/migration-kit/gates.js';
import {
  MIGRATION_PATH_PREFIX,
  registerMigrationHandlers,
  type AppliedChange,
  type ChangesResponse,
  type ExportResponse,
  type ExportRow,
  type MigrationHandlerOptions,
  type ObjectManifestEntry,
  type OperationStatus,
  type PositionResponse,
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
import { outboxSql } from '../../src/outbox/index.js';
import { createService } from '../../src/service-kit/create-service.js';
import { loadEnv, type BaseEnv } from '../../src/service-kit/env.js';
import { rlsSql, tenantIdForSite, tenantRegistrySql, withMetadata, type TenantDb } from '../../src/tenancy/index.js';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, seedRegistry } from '../../src/testing/fixtures.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';
import { ROLE_SET, authHeadersFor, testVerifier, type RoleSubject } from '../../src/testing/tokens.js';

const OWNER = 'mk-handlers';
const BASE = 'mk_handlers';
const UNITS = ['mk.item', 'mk.tag_member', 'mk.memo', 'mk.score'];
const SORTED_UNITS = [...UNITS].sort();
const HORIZON_WAIT_MS = 30_000;

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
  `CREATE TABLE ${BASE}.item (tenant_id uuid NOT NULL, item_id text NOT NULL, site_id text, name text, qty integer, PRIMARY KEY (tenant_id, item_id));`,
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
    registerMigrationHandlers(app, { owner: OWNER, repository, mappings: MAPPINGS, units: UNITS, db: idleDb });
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
  ] as [string, Partial<MigrationHandlerOptions>, boolean, string][])('throws %s', async (_label, overrides, withHeader, message) => {
    const app = await freshApp(undefined, withHeader);
    expect(() => registerMigrationHandlers(app, { owner: OWNER, repository, mappings: MAPPINGS, units: UNITS, ...overrides })).toThrow(message);
  });

  it('uses the createService pool when options.db is absent', async () => {
    const app = await freshApp(idleDb);
    expect(() => registerMigrationHandlers(app, { owner: OWNER, repository, mappings: MAPPINGS, units: UNITS })).not.toThrow();
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
      owner: OWNER,
      repository: repo,
      mappings: MAPPINGS,
      units: UNITS,
      exportObjects: (_tx, scope) => Promise.resolve(objectsOf(scope.unit, scope.tenantId)),
      emitStateEvents: (_tx, change, write) => {
        emitted.push(change);
        emitContexts.push(write);
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

  function get(route: string, query: Record<string, string> = {}, headers: Record<string, string> = migration): Promise<LightMyRequestResponse> {
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

  async function exportPage(query: Record<string, string>): Promise<ExportResponse> {
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

  it('answers a repeated batchId as a duplicate without applying its rows or its watermark', async () => {
    const site = freshSite();
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

  it('answers a database failure during an apply with the legacy 500 and records no batch', async () => {
    const site = freshSite();
    const batch = (qty: number): Record<string, unknown> => ({
      batchId: `${site}-overflow`,
      origin: 'backfill',
      legacyTable: 'tItems',
      siteId: site,
      columns: ITEM_LEGACY,
      rows: rowsOf(ITEM_LEGACY, [['upsert', item('i1', site, 'Big', qty)]]),
    });
    const res = await post('/apply', batch(2 ** 40));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
    expect(await batches(site)).toEqual([]);
    expect(await applied(batch(1))).toMatchObject({ duplicate: false, applied: 1 });
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

  /** A one-row Scores batch of a fresh site for `Program_<programId>`, carrying a forward watermark. */
  function scoresBatch(programId: number): Record<string, unknown> & { legacyTable: string; siteId: string } {
    const site = freshSite();
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

  it('folds Program_<id> tables into one target table and exports it whole or per program', async () => {
    const site = freshSite();
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
    ['a limit of 0', { unit: 'mk.item', siteId: 'tenant-a', limit: '0' }],
    ['a limit above 10000', { unit: 'mk.item', siteId: 'tenant-a', limit: '10001' }],
    ['an unknown parameter', { unit: 'mk.item', siteId: 'tenant-a', page: '1' }],
  ] as [string, Record<string, string>][])('rejects an export with %s as invalidParameters', async (_label, query) => {
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
  });

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
  });

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
    ['an upsert into a keyless table', { ...applyBase, legacyTable: 'tTagMembers', columns: TAG_LEGACY, rows: rowsOf(TAG_LEGACY, [['upsert', { Label: 'a', Weight: 1 }]]) }],
    ['an insert into a keyed table', { ...applyBase, rows: [{ op: 'insert', row: okItem }] }],
  ] as [string, Record<string, unknown>][])('rejects an apply with %s as invalidParameters and records no batch', async (_label, body) => {
    expectRejected(await post('/apply', body));
    expect(await batches(REJECTED_SITE)).toEqual([]);
  });

  it('rejects an apply row the repository cannot write as badRequest', async () => {
    expectRejected(await post('/apply', { ...applyBase, rows: rowsOf(ITEM_LEGACY, [['upsert', { ItemID: null, SiteID: REJECTED_SITE, Name: 'N', Qty: 1 }]]) }), 'Bad Request');
    expect(await batches(REJECTED_SITE)).toEqual([]);
  });

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

  it('answers the legacy 500, not a 400, when the database fails during an export', async () => {
    const res = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/export`, headers, query: { unit: 'mk.tag_member', siteId: 'tenant-a' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { message: 'Unhandled Exception', code: 'server_error' } });
  });

  it('reports null outbox and inbox counts and exports a unit without an object manifest', async () => {
    const position = await app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}/position`, headers });
    expect(position.statusCode, position.body).toBe(200);
    expect(position.json()).toEqual({ owner: OWNER, position: expect.stringMatching(/^\d+$/), outbox: null, inbox: null });

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
});
