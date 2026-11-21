/** Identity's migration applies of Type=2 tusers rows split over user_account, credential and login_state, against PostgreSQL. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER_LC, encodeRow, type ApplyRequest, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { tusersCredentialMapping, tusersLoginStateMapping, tusersUserAccountMapping } from '../../src/migration/mappings/index.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PG_READY = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'].every((name) => Boolean(process.env[name])) && (await pgAvailable());
const TYPE2_MAPPINGS = [tusersUserAccountMapping, tusersCredentialMapping, tusersLoginStateMapping];
/** The tusers columns the three Type=2 mappings read, once each. */
const COLUMNS: CanonicalColumn[] = [...new Map(TYPE2_MAPPINGS.flatMap((mapping) => mapping.legacyColumns).map((column) => [column.name, column])).values()];

describe.skipIf(!PG_READY)('tusers applies against PostgreSQL', () => {
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'identity', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    ({ app } = await buildTestApp({ db: schema.app }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  /** A tenant-a batch of one Type=2 tusers upsert of `userId` that last logged in at `lastLogin`. */
  function tusersBatch(userId: string, lastLogin: string, origin: ApplyRequest['origin']): ApplyRequest {
    const row = {
      ...Object.fromEntries(COLUMNS.map((column) => [column.name, null])),
      UserID: userId,
      UserName: `user_${userId.slice(0, 8)}`,
      Password: 'stored-hash',
      PasswordCreated: '2026-06-01 08:00:00',
      Type: 2,
      Admin: 0,
      S2: 0,
      InActive: 0,
      isPublic: 0,
      SiteID: TENANT_A.siteId,
      LastLogin: lastLogin,
    };
    return {
      batchId: `tusers-${cfUuid()}`,
      origin,
      legacyTable: 'tusers',
      siteId: TENANT_A.siteId,
      columns: COLUMNS.map((column) => ({ ...column })),
      units: TYPE2_MAPPINGS.map((mapping) => mapping.unit),
      rows: [{ op: 'upsert', row: encodeRow(COLUMNS, row) }],
    };
  }

  it('writes a LastLogin-only change as one login_state update and a resent unchanged row as nothing but its write position', async () => {
    const userId = cfUuid();
    const headers = await headersFor('service:migration');
    const batches = [
      tusersBatch(userId, '2026-06-30 09:00:00', 'backfill'),
      tusersBatch(userId, '2026-06-30 12:34:56.997', 'migration-feed'),
      tusersBatch(userId, '2026-06-30 12:34:56.997', 'migration-feed'),
    ];
    const responses = [];
    for (const body of batches) {
      const res = await app.inject({ method: 'POST', url: '/internal/v1/migration/apply', headers, payload: body });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toStrictEqual({ batchId: body.batchId, duplicate: false, applied: 1, skipped: 0 });
      responses.push(res);
    }

    // The resent batch writes no row, and its own transaction is its write position.
    const xids = responses.map((res) => /^identity=(\d+)$/.exec(String(res.headers[WRITE_POSITION_HEADER_LC]))?.[1]);
    expect(xids).toStrictEqual([expect.stringMatching(/^\d+$/), expect.stringMatching(/^\d+$/), expect.stringMatching(/^\d+$/)]);
    expect(BigInt(xids[2] as string) > BigInt(xids[1] as string)).toBe(true);
    const log = await withTenant(schema.app, TENANT_A.tenantId, async (tx) =>
      (
        await tx.query<{ table: string; op: string; columns: string[]; request_id: string }>(
          `SELECT "table", op, columns, request_id FROM ${schema.schema}.changelog WHERE request_id = ANY($1::text[]) ORDER BY seq`,
          [batches.map((body) => body.batchId)],
        )
      ).rows,
    );
    expect(log.filter((row) => row.request_id === batches[0]?.batchId).map((row) => [row.table, row.op])).toStrictEqual([
      ['user_account', 'insert'],
      ['credential', 'insert'],
      ['login_state', 'insert'],
    ]);
    expect(log.filter((row) => row.request_id !== batches[0]?.batchId)).toStrictEqual([
      { table: 'login_state', op: 'update', columns: ['lastlogin'], request_id: batches[1]?.batchId },
    ]);
  });
});
