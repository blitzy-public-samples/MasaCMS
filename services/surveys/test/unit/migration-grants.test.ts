// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey-response grants derived from `survey_target` rows that arrive through the migration apply endpoint. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import {
  MIGRATION_PATH_PREFIX,
  encodeRow,
  registerMigrationHandlers,
  registerWritePositionHeader,
  type ApplyOrigin,
} from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { withMetadata } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  authHeadersFor,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type InjectResponse,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { MAPPINGS, surveyMapping, surveyTargetMapping } from '../../src/migration/mappings/index.js';
import { SURVEY_RESPONSE_GRANT } from '../../src/repo/grants.js';
import { OWNER, createSurveysRepository } from '../../src/repo/repository.js';
import { SURVEY_TARGET, UNITS } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const CREATED = '2026-06-30T09:00:00.000';
const USER_ID = '11111111-2222-3333-4444555566667777';
const WINDOW_HOLDER = 'window-grants';

type RowOp = 'upsert' | 'delete';
type LegacyTarget = { target_id: string; survey_id: string; siteID: string; group_name: string | null; created: string };

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)('survey-response grants of migration applies', () => {
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let batches = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await seedRegistry(handle.app, handle.schema);
    app = await createService({
      name: OWNER,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '24416',
        OPT2_SERVICE_NAME: OWNER,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
        OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(OWNER),
      logger: createLogger({ service: OWNER, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
      pool: handle.app,
    });
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository: createSurveysRepository({ clock: fixedClock(NOW), schema: handle.schema }),
      mappings: MAPPINGS,
      units: UNITS,
    });
    await app.ready();
    const migration = ROLE_SET.find((subject) => subject.name === 'service:migration');
    if (migration === undefined) throw new Error('no service:migration subject');
    headers = await authHeadersFor(migration, { audience: OWNER });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  function post(route: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.inject({ method: 'POST', url: `${MIGRATION_PATH_PREFIX}${route}`, headers, payload });
  }

  /** Posts one tenant-A batch of `legacyTable` and returns its parsed 200 answer. */
  async function apply(
    legacyTable: string,
    rows: ReadonlyArray<[RowOp, Record<string, unknown>]>,
    extra: { batchId?: string; origin?: ApplyOrigin; holderId?: string } = {},
  ): Promise<Record<string, unknown>> {
    batches += 1;
    const mapping = legacyTable === surveyMapping.legacyTable ? surveyMapping : surveyTargetMapping;
    const res = await post('/apply', {
      batchId: extra.batchId ?? `grants-${batches}`,
      origin: extra.origin ?? 'backfill',
      legacyTable,
      siteId: TENANT_A.siteId,
      columns: mapping.legacyColumns,
      rows: rows.map(([op, values]) => ({ op, row: encodeRow(mapping.legacyColumns, values) })),
      ...(extra.holderId === undefined ? {} : { holderId: extra.holderId }),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Record<string, unknown>>();
  }

  /** One legacy tenant-A survey row titled `title`. */
  function legacySurvey(surveyId: string, title = 'Pulse'): Record<string, unknown> {
    return {
      survey_id: surveyId,
      siteID: TENANT_A.siteId,
      title,
      status: 'DRAFT',
      created: CREATED,
      createdByID: USER_ID,
      lastUpdate: null,
      lastUpdateByID: null,
      launched_at: null,
    };
  }

  /** Backfills one tenant-A survey and returns its id. */
  async function backfillSurvey(): Promise<string> {
    const surveyId = cfUuid();
    await apply(surveyMapping.legacyTable, [['upsert', legacySurvey(surveyId)]]);
    return surveyId;
  }

  function target(surveyId: string, siteID: string, groupName: string | null = null): LegacyTarget {
    return { target_id: cfUuid(), survey_id: surveyId, siteID, group_name: groupName, created: CREATED };
  }

  function applyTargets(rows: ReadonlyArray<[RowOp, LegacyTarget]>, extra?: Parameters<typeof apply>[2]): Promise<Record<string, unknown>> {
    return apply(surveyTargetMapping.legacyTable, rows, extra);
  }

  /** Grantees of tenant A's `survey-response` grants on `surveyId`, sorted; a stored tenant-A survey grants tenant A itself. */
  async function grantees(surveyId: string): Promise<string[]> {
    const { rows } = await withMetadata(handle.app, (tx) =>
      tx.query<{ grantee_tenant: string }>(
        `SELECT grantee_tenant FROM ${handle.schema}.tenant_grant WHERE grantor_tenant = $1 AND kind = $2 AND resource_id = $3 ORDER BY grantee_tenant`,
        [TENANT_A.tenantId, SURVEY_RESPONSE_GRANT, surveyId],
      ),
    );
    return rows.map((row) => row.grantee_tenant);
  }

  function sorted(...tenants: string[]): string[] {
    return [...tenants].sort();
  }

  it('grants each registered tenant of the backfilled targets other than the survey tenant, emitting no events', async () => {
    const surveyId = await backfillSurvey();
    const result = await applyTargets([
      ['upsert', target(surveyId, 'tenant-b')],
      ['upsert', target(surveyId, 'TENANT-B ', 'Panel')],
      ['upsert', target(surveyId, 'umbrella', 'Board')],
      ['upsert', target(surveyId, TENANT_A.siteId)],
      ['upsert', target(surveyId, 'tenant-z')],
    ]);

    expect(result).toMatchObject({ duplicate: false, applied: 5, skipped: 0 });
    expect(await grantees(surveyId)).toEqual(sorted(TENANT_A.tenantId, TENANT_B.tenantId, TENANT_UMBRELLA.tenantId));
    const outbox = await handle.app.withTenant(TENANT_A.tenantId, (tx) => tx.query(`SELECT 1 FROM ${handle.schema}.outbox`));
    expect(outbox.rows).toEqual([]);
  });

  it('applies nothing and grants nothing for a repeated batchId', async () => {
    const surveyId = await backfillSurvey();
    const batchId = `grants-repeat-${surveyId}`;
    await applyTargets([['upsert', target(surveyId, 'tenant-b')]], { batchId });
    const repeat = await applyTargets([['upsert', target(surveyId, 'umbrella')]], { batchId });

    expect(repeat).toEqual({ batchId, duplicate: true, applied: 0, skipped: 0 });
    expect(await grantees(surveyId)).toEqual(sorted(TENANT_A.tenantId, TENANT_B.tenantId));
  });

  it('re-syncs on migration-feed moves and deletes, dropping a tenant only with its last target', async () => {
    const surveyId = await backfillSurvey();
    const first = target(surveyId, 'tenant-b');
    const second = target(surveyId, 'Tenant-B', 'Panel');
    const other = target(surveyId, 'umbrella');
    await applyTargets([
      ['upsert', first],
      ['upsert', second],
      ['upsert', other],
    ]);
    const feed = { origin: 'migration-feed' } as const;

    await applyTargets([['upsert', { ...other, siteID: TENANT_A.siteId }]], feed);
    expect(await grantees(surveyId)).toEqual(sorted(TENANT_A.tenantId, TENANT_B.tenantId));
    await applyTargets([['delete', first]], feed);
    expect(await grantees(surveyId)).toEqual(sorted(TENANT_A.tenantId, TENANT_B.tenantId));
    expect(await applyTargets([['delete', second], ['delete', first]], feed)).toMatchObject({ applied: 1, skipped: 1 });
    expect(await grantees(surveyId)).toEqual([TENANT_A.tenantId]);
  });

  it.each<ApplyOrigin>(['backfill', 'migration-feed'])(
    'grants the survey tenant its own grant on a %s survey upsert, keeps it on a repeat and drops only it with the survey delete',
    async (origin) => {
      const surveyId = cfUuid();
      await apply(surveyMapping.legacyTable, [['upsert', legacySurvey(surveyId)]], { origin });
      expect(await grantees(surveyId)).toEqual([TENANT_A.tenantId]);
      await applyTargets([['upsert', target(surveyId, 'tenant-b')]], { origin });
      await apply(surveyMapping.legacyTable, [['upsert', legacySurvey(surveyId, 'Renamed')]], { origin });
      expect(await grantees(surveyId)).toEqual(sorted(TENANT_A.tenantId, TENANT_B.tenantId));

      const removed = await apply(surveyMapping.legacyTable, [['delete', legacySurvey(surveyId, 'Renamed')]], { origin });

      expect(removed).toMatchObject({ duplicate: false, applied: 1 });
      expect(await grantees(surveyId)).toEqual([TENANT_B.tenantId]);
    },
  );

  it('writes the grant of a legacy-window import while the target unit is in the importing phase', async () => {
    const surveyId = await backfillSurvey();
    const units = [SURVEY_TARGET.unit];
    expect((await post('/gate', { op: 'close', units, holderId: WINDOW_HOLDER, allowLegacy: true })).statusCode).toBe(200);
    try {
      const phased = await post('/gate', { op: 'phase', units, holderId: WINDOW_HOLDER, phase: 'importing' });
      expect(phased.json()).toEqual({ units: [{ unit: SURVEY_TARGET.unit, state: 'closed', holderId: WINDOW_HOLDER, phase: 'importing' }] });
      const started = Date.now();

      const result = await applyTargets([['upsert', target(surveyId, 'tenant-b')]], { origin: 'legacy-window', holderId: WINDOW_HOLDER });

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result).toMatchObject({ duplicate: false, applied: 1 });
      expect(await grantees(surveyId)).toEqual(sorted(TENANT_A.tenantId, TENANT_B.tenantId));
    } finally {
      await post('/gate', { op: 'open', units, holderId: WINDOW_HOLDER, state: 'legacy' });
    }
  });
});
