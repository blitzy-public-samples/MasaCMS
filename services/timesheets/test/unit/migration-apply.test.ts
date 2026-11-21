// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Migration applies of `Program_<id>.blackout` batches, folded only under the tenant `synthetic.program_site` maps the program to. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { encodeRow, programTableName, type CanonicalValue } from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_B, type TenantFixture } from '@opt2/platform/testing';
import { blackoutMapping } from '../../src/migration/mappings/index.js';
import { buildTestApp, serviceHeaders, type TestApp } from '../helpers/app.js';

const APPLY_URL = '/internal/v1/migration/apply';

type Injected = Awaited<ReturnType<TestApp['app']['inject']>>;

/** A fixture blackout row in canonical value form. */
const BLACKOUT: Readonly<Record<string, CanonicalValue>> = {
  blackout_id: 'F6A7B8C9-D0E1-4F5A-3B4C5D6E7F8091A2',
  day_id: 'B2C3D4E5-F6A7-4B1C-9D0E1F2A3B4C5D6E',
  person_id: 'C3D4E5F6-A7B8-4C2D-0E1F2A3B4C5D6E7F',
  archive_id: null,
  reason: '',
  created: '2026-06-16T08:00:00.000',
};

describe('migration apply of Program_<id>.blackout batches', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
  });

  afterEach(async () => {
    await t.app.close();
  });

  /** Backfills the blackout row as `Program_<programId>.blackout` under `tenant`'s site. */
  async function apply(programId: number, tenant: TenantFixture): Promise<Injected> {
    return t.app.inject({
      method: 'POST',
      url: APPLY_URL,
      headers: await serviceHeaders('migration', [Roles.platformMigration]),
      payload: {
        batchId: `blackout-${String(programId)}-${tenant.siteId}`,
        origin: 'backfill',
        legacyTable: programTableName(programId, blackoutMapping.legacyTable),
        siteId: tenant.siteId,
        columns: blackoutMapping.legacyColumns,
        rows: [{ op: 'upsert', row: encodeRow(blackoutMapping.legacyColumns, BLACKOUT) }],
      },
    });
  }

  it.each([
    [1, TENANT_A],
    [2, TENANT_B],
  ] as const)('folds Program_%i rows into the tenant of its program site', async (programId, tenant) => {
    const res = await apply(programId, tenant);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ applied: 1, skipped: 0 });
    expect(t.db.rowsOf('blackout').map((row) => [row.tenant_id, row.legacy_program_id])).toEqual([[tenant.tenantId, programId]]);
  });

  it.each([
    ['Program_1 rows under tenant-b', 1, TENANT_B],
    ['Program_2 rows under tenant-a', 2, TENANT_A],
    ['rows of Program_3, which synthetic.program_site does not map', 3, TENANT_A],
  ] as const)('rejects %s as invalidParameters and writes nothing', async (_label, programId, tenant) => {
    const res = await apply(programId, tenant);

    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(t.db.writes).toEqual([]);
    expect(t.db.rowsOf('blackout')).toEqual([]);
  });
});
