// Migration endpoints beside a gated target write route of the same service; per-endpoint cases live in migration-kit-handlers.test.ts.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, LOCAL_USER_TOKEN, Roles } from '../../src/auth/index.js';
import { eventsSql } from '../../src/events/index.js';
import {
  CURSOR_START,
  MIGRATION_PATH_PREFIX,
  WRITE_POSITION_HEADER_LC,
  createRepository,
  defineMapping,
  encodeKey,
  encodeRow,
  migrationKitSql,
  parseWritePosition,
  registerMigrationHandlers,
  registerWritePositionHeader,
  sha256Hex,
  tableChecksum,
  withGatedTenant,
  type ApplyResponse,
  type CanonicalColumn,
  type ChangesResponse,
  type ExportResponse,
  type GateResponse,
  type PositionResponse,
  type ProjectedChangeRow,
  type Repository,
  type TableDefinition,
} from '../../src/migration-kit/index.js';
import { outboxSql } from '../../src/outbox/index.js';
import { baseEnvSchema, createService, fixedClock, loadEnv, z, type FastifyInstance } from '../../src/service-kit/index.js';
import { rlsSql, tenantRegistrySql, withTenant } from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  runCleanup,
  seedRegistry,
  testPgConfig,
  testVerifier,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const OWNER = 'isomh';
const NOTE_UNIT = 'isomh.note';
const AUTHOR = 'isomh-author';
const ROUTE_GATE_BUDGET_MS = 1_000;
const HORIZON_WAIT_MS = 30_000;

const ENV = loadEnv(baseEnvSchema, {
  PORT: '65000',
  OPT2_SERVICE_NAME: OWNER,
  OPT2_ENV: 'local',
  OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
  OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
  OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
  OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-isomh-unused'),
  TZ: 'UTC',
});

const NOTE_SQL = [
  `CREATE TABLE ${OWNER}.note (tenant_id uuid NOT NULL, id char(35) PRIMARY KEY, body text, row_version integer NOT NULL DEFAULT 0);`,
  rlsSql(OWNER, 'note'),
].join('\n');

const NOTE_LEGACY: CanonicalColumn[] = [
  { name: 'NoteID', type: 's' },
  { name: 'Body', type: 's' },
];

const NOTE_TABLE: TableDefinition = {
  table: 'note',
  unit: NOTE_UNIT,
  key: ['id'],
  columns: [
    { name: 'tenant_id', type: 's' },
    { name: 'id', type: 's' },
    { name: 'body', type: 's' },
    { name: 'row_version', type: 'i' },
  ],
};

const NOTE_MAPPING = defineMapping({
  legacyTable: 'tNotes',
  targetTable: NOTE_UNIT,
  columns: [
    { legacy: 'NoteID', target: 'id', type: 's' },
    { legacy: 'Body', target: 'body', type: 's' },
  ],
  key: ['NoteID'],
});

const NOTE_BODY = z.strictObject({ id: z.string().length(35), body: z.string().nullable() });

type NoteValues = z.infer<typeof NOTE_BODY>;

/** A 35-character CF-format UUID numbered `n`. */
function noteId(n: number): string {
  return `00000000-0000-0000-${String(n).padStart(16, '0')}`;
}

function note(n: number, body: string | null): NoteValues {
  return { id: noteId(n), body };
}

/** The legacy-named values of a note. */
function legacyNote(values: NoteValues): Record<string, string | null> {
  return { NoteID: values.id, Body: values.body };
}

/** Upsert rows of an apply batch, encoded over the legacy columns. */
function applyRows(notes: readonly NoteValues[]): { op: 'upsert'; row: string }[] {
  return notes.map((values) => ({ op: 'upsert', row: encodeRow(NOTE_LEGACY, legacyNote(values)) }));
}

/** The owner's xid in a response's write-position header, which must name only this owner. */
function writtenXid(res: LightMyRequestResponse): string {
  const positions = parseWritePosition(res.headers[WRITE_POSITION_HEADER_LC] as string | undefined);
  expect([...positions.keys()]).toEqual([OWNER]);
  const xid = positions.get(OWNER) as string;
  expect(BigInt(xid) > 0n).toBe(true);
  return xid;
}

/** Asserts the legacy JSON API 503 of a write that committed nothing. */
function expectUnavailable(res: LightMyRequestResponse): void {
  expect(res.statusCode, res.body).toBe(503);
  expect(res.json()).toMatchObject({ error: { code: 'server_error', message: 'Unhandled Exception' } });
  expect(res.headers).not.toHaveProperty(WRITE_POSITION_HEADER_LC);
}

function changeSummary(row: ProjectedChangeRow): unknown[] {
  return [row.xid, row.table, row.op, row.origin, row.actorUserId, row.actorService, row.requestId];
}

describe('migration endpoints beside a gated target write route', () => {
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  let repository: Repository;
  let migration: Record<string, string>;
  let gatewayCredential: string;

  beforeAll(async () => {
    const pg = testPgConfig();
    if (!(await pgAvailable())) {
      throw new Error(`PostgreSQL at ${pg.host}:${String(pg.port)} is unreachable; PG_HOST and PG_PORT must name a running server`);
    }
    handle = await createThrowawaySchema({
      service: OWNER,
      extraSql: [migrationKitSql(OWNER), tenantRegistrySql(OWNER), outboxSql(OWNER), eventsSql(OWNER), NOTE_SQL],
    });
    const db = handle.app;
    await seedRegistry(db);
    repository = createRepository({ owner: OWNER, schema: handle.schema, tables: [NOTE_TABLE] });
    app = await createService({
      name: OWNER,
      version: 'test',
      env: ENV,
      verifierOverride: testVerifier(OWNER),
      clock: fixedClock('2026-06-30T12:00:00'),
      pool: db,
    });
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, { owner: OWNER, repository, mappings: [NOTE_MAPPING], units: [NOTE_UNIT] });
    app.post('/v1/notes', { config: { opt2: { requires: [Roles.siteAdmin] } } }, (request) => {
      const values = NOTE_BODY.parse(request.body);
      return withGatedTenant(db, request.opt2.tenantId as string, (tx) => repository.insert(tx, 'note', values), {
        budgetMs: ROUTE_GATE_BUDGET_MS,
      });
    });
    await app.ready();
    const [migrationToken, gatewayToken] = await Promise.all([
      mintServiceToken({ caller: 'migration', audience: OWNER, roles: [Roles.platformMigration] }),
      mintServiceToken({ caller: 'gateway', audience: OWNER }),
    ]);
    migration = { [INVOCATION_HEADER]: `Bearer ${migrationToken}` };
    gatewayCredential = `Bearer ${gatewayToken}`;
  });

  afterAll(async () => {
    await runCleanup('migration-handlers suite', [() => app?.close(), () => handle?.drop()]);
  });

  function post(route: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url: `${MIGRATION_PATH_PREFIX}${route}`, headers: migration, payload });
  }

  function get(route: string, query: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'GET', url: `${MIGRATION_PATH_PREFIX}${route}`, headers: migration, query });
  }

  /** Posts a note through the target write route as a site-admin of `site`. */
  async function postNote(site: string, values: NoteValues, requestId?: string): Promise<LightMyRequestResponse> {
    const token = await mintUserToken({ sub: AUTHOR, site, roles: [Roles.systemUser, Roles.siteAdmin] });
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: gatewayCredential };
    if (requestId !== undefined) headers['x-request-id'] = requestId;
    return app.inject({ method: 'POST', url: '/v1/notes', headers, payload: values });
  }

  async function gate(body: Record<string, unknown>): Promise<GateResponse> {
    const res = await post('/gate', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<GateResponse>();
  }

  /** Moves the note unit to `state` as a transition does: close as its holder, then reopen into the new authority. */
  async function transitionTo(state: 'open' | 'legacy'): Promise<void> {
    await gate({ op: 'close', units: [NOTE_UNIT], holderId: 'transition', allowLegacy: true });
    expect((await gate({ op: 'open', units: [NOTE_UNIT], holderId: 'transition', state })).units).toEqual([
      { unit: NOTE_UNIT, state, holderId: null, phase: 'quiet' },
    ]);
  }

  function storedIds(tenantId: string): Promise<string[]> {
    return withTenant(handle.app, tenantId, async (tx) =>
      (await tx.query<{ id: string }>(`SELECT id FROM ${handle.schema}.note ORDER BY id`)).rows.map((row) => row.id),
    );
  }

  /** Polls `/changes` after `after` until its horizon passes `xid`; the horizon is cluster-wide, so another open transaction can hold it back. */
  async function changesThrough(siteId: string, after: string, xid: string): Promise<ChangesResponse> {
    const deadline = Date.now() + HORIZON_WAIT_MS;
    for (;;) {
      const res = await get('/changes', { siteId, after });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<ChangesResponse>();
      if (BigInt(page.horizon) > BigInt(xid) || Date.now() > deadline) return page;
      await sleep(100);
    }
  }

  it('answers target writes with the legacy 503 while the unit is legacy or closed, as a migration apply passes the closed gate', async () => {
    const site = TENANT_A.siteId;
    await transitionTo('legacy');
    const refusedAt = Date.now();
    expectUnavailable(await postNote(site, note(1, 'legacy')));
    expect(Date.now() - refusedAt).toBeLessThan(ROUTE_GATE_BUDGET_MS);

    await transitionTo('open');
    let reopened: GateResponse;
    try {
      expect((await gate({ op: 'close', units: [NOTE_UNIT], holderId: 'H1' })).units).toEqual([
        { unit: NOTE_UNIT, state: 'closed', holderId: 'H1', phase: 'quiet' },
      ]);
      const waitedFrom = Date.now();
      const [blocked, applied] = await Promise.all([
        postNote(site, note(2, 'blocked')).then((res) => ({ res, ms: Date.now() - waitedFrom })),
        post('/apply', {
          batchId: 'isomh-window-1',
          origin: 'legacy-window',
          holderId: 'H1',
          legacyTable: 'tNotes',
          siteId: site,
          columns: NOTE_LEGACY,
          rows: applyRows([note(3, 'imported')]),
        }),
      ]);
      expectUnavailable(blocked.res);
      expect(blocked.ms).toBeGreaterThanOrEqual(ROUTE_GATE_BUDGET_MS * 0.75);
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json<ApplyResponse>()).toEqual({ batchId: 'isomh-window-1', duplicate: false, applied: 1, skipped: 0 });
      writtenXid(applied);
      expect(await storedIds(TENANT_A.tenantId)).toEqual([noteId(3)]);
    } finally {
      reopened = await gate({ op: 'open', units: [NOTE_UNIT], holderId: 'H1' });
    }
    expect(reopened.units).toEqual([{ unit: NOTE_UNIT, state: 'open', holderId: null, phase: 'quiet' }]);

    const accepted = await postNote(site, note(2, 'accepted'));
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ tenant_id: TENANT_A.tenantId, id: noteId(2), body: 'accepted', row_version: 0 });
    expect(await storedIds(TENANT_A.tenantId)).toEqual([noteId(2), noteId(3)]);
  });

  it('serves a target write at its reported write position on /changes and pages past it to a later migration apply', async () => {
    await transitionTo('open');
    const site = TENANT_UMBRELLA.siteId;
    const created = await postNote(site, note(10, 'first'), 'isomh-changes-1');
    expect(created.statusCode, created.body).toBe(200);
    const xid = writtenXid(created);

    const first = await changesThrough(site, CURSOR_START, xid);
    const v1 = legacyNote(note(10, 'first'));
    const v2 = legacyNote(note(10, 'second'));
    const key = encodeKey(NOTE_LEGACY, ['NoteID'], v1);
    expect(first.rows.map(changeSummary)).toEqual([[xid, 'note', 'insert', 'target', AUTHOR, 'gateway', 'isomh-changes-1']]);
    expect(first.rows[0]?.legacy).toEqual([
      { unit: NOTE_UNIT, legacyTable: 'tNotes', key, before: null, after: encodeRow(NOTE_LEGACY, v1), columns: ['NoteID', 'Body'] },
    ]);
    expect(first.cursor).toBe(`${xid}:${String(first.rows[0]?.seq)}`);

    const position = await get('/position');
    expect(position.statusCode, position.body).toBe(200);
    expect(BigInt(position.json<PositionResponse>().position) >= BigInt(xid)).toBe(true);

    const updated = await post('/apply', {
      batchId: 'isomh-feed-1',
      origin: 'migration-feed',
      legacyTable: 'tNotes',
      siteId: site,
      columns: NOTE_LEGACY,
      rows: applyRows([note(10, 'second')]),
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const fedXid = writtenXid(updated);
    expect(BigInt(fedXid) > BigInt(xid)).toBe(true);

    const next = await changesThrough(site, first.cursor, fedXid);
    expect(next.rows.map(changeSummary)).toEqual([[fedXid, 'note', 'update', 'migration-feed', null, 'migration', 'isomh-feed-1']]);
    expect(next.rows[0]?.legacy).toEqual([
      {
        unit: NOTE_UNIT,
        legacyTable: 'tNotes',
        key,
        before: encodeRow(NOTE_LEGACY, v1),
        after: encodeRow(NOTE_LEGACY, v2),
        columns: ['Body'],
      },
    ]);
  });

  it('exports target-written and applied rows with the reconciliation checksum of the stored rows', async () => {
    await transitionTo('open');
    const site = TENANT_B.siteId;
    for (const values of [note(20, 'plain'), note(21, 'colon: café ✓'), note(22, null)]) {
      const res = await postNote(site, values);
      expect(res.statusCode, res.body).toBe(200);
    }
    const applied = await post('/apply', {
      batchId: 'isomh-backfill-1',
      origin: 'backfill',
      legacyTable: 'tNotes',
      siteId: site,
      columns: NOTE_LEGACY,
      rows: applyRows([note(23, ''), note(24, 'N')]),
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json<ApplyResponse>()).toMatchObject({ duplicate: false, applied: 2 });

    const res = await get('/export', { unit: NOTE_UNIT, siteId: site });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<ExportResponse>();
    expect(page).toMatchObject({ unit: NOTE_UNIT, tenantId: TENANT_B.tenantId, next: null });
    const rows = page.tables.flatMap((table) => table.rows);
    expect(rows.map((row) => row.hash)).toEqual(rows.map((row) => sha256Hex(row.row)));

    const stored = await withTenant(handle.app, TENANT_B.tenantId, async (tx) =>
      (await tx.query<NoteValues>(`SELECT id, body FROM ${handle.schema}.note`)).rows,
    );
    const local = stored.map((values) => {
      const legacy = legacyNote(values);
      return { key: encodeKey(NOTE_LEGACY, ['NoteID'], legacy), row: encodeRow(NOTE_LEGACY, legacy) };
    });
    expect(tableChecksum(rows)).toEqual(tableChecksum(local));
    expect(tableChecksum(rows).count).toBe(5);
  });
});
