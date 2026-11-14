// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Tenant isolation of the reporting schema, its export routes, its signed export URLs and its export-run task against PostgreSQL. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { cfUuid, errorSpec } from '@opt2/platform/legacy-compat';
import { CLOUD_TASKS_HEADERS, QUEUES, TaskTenantMismatchError, type TaskWireBody } from '@opt2/platform/tasks';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  defineIsolationSuite,
  expectPlatformTables,
  fixtureForTenant,
  mintTasksInvokerToken,
  pgAvailable,
  type InjectResponse,
  type IsolationEventOptions,
  type PlatformTableGroup,
  type TenantFixture,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/envelope.js';
import { FIXTURE_PREFIX } from '../../src/legacy/index.js';
import { createReportingRepository, type ReportingRepository } from '../../src/repo/repository.js';
import {
  EXPORT_BUCKET,
  EXPORT_DEFINITION,
  EXPORT_JOB,
  OWNED_TABLES,
  TSESSIONTRACKING,
  exportAttemptKey,
  exportObjectKey,
  type ExportJobRow,
} from '../../src/repo/tables.js';
import { exportRunTaskName } from '../../src/tasks/enqueue.js';
import { SERVICE, TEST_AS_OF, TEST_CLOCK, buildTestApp, headersFor, identityOf, queueRun, siteChangedEnvelope, type TestApp } from '../helpers/app.js';
import { LEGACY_SESSION_TRACKING_ROWS, definitionFor, jobFor } from '../helpers/fixtures.js';

type Row = Record<string, unknown>;

// pgAvailable rejects when PG_* is unset, so only the presence of PG_HOST is read here, to skip rather than fail.
const PG_READY = Boolean(process.env.PG_HOST) && (await pgAvailable());
const PLATFORM_GROUPS: readonly PlatformTableGroup[] = ['tenancy', 'migrationKit', 'events', 'outbox', 'tasks'];
const EXPORTER = Roles.reportingExporter;
const V1_EXPORTS = '/v1/reporting/exports';
const FIXTURE_EXPORTS = `${FIXTURE_PREFIX}/exports`;
const NOT_FOUND = FIXTURE_ERROR_MAP.notFound;
const RUN_QUEUE = QUEUES['reporting-export-run'];

let handle: TestApp<TenantDb> | undefined;
let repository: ReportingRepository | undefined;
let trackingIds = 0;

/** The app the outer beforeAll built; throws when building it failed. */
function built(): TestApp<TenantDb> {
  if (handle === undefined) throw new Error('The reporting test app was not built; see the beforeAll failure');
  return handle;
}

/** The repository over the app's schema; throws when the outer beforeAll failed. */
function repo(): ReportingRepository {
  if (repository === undefined) throw new Error('The reporting repository was not built; see the beforeAll failure');
  return repository;
}

/** A `session_tracking` row of `tenant` shaped as the legacy visit of its site (no site for umbrella), under a fresh tracking id. */
function sessionTrackingRow(tenant: TenantFixture): Row {
  const siteId = tenant.key === TENANT_UMBRELLA.key ? null : tenant.siteId;
  const legacy = LEGACY_SESSION_TRACKING_ROWS.find((row) => row.siteID === siteId);
  if (legacy === undefined) throw new TypeError(`LEGACY_SESSION_TRACKING_ROWS has no visit of site ${String(siteId)}`);
  const byColumn = new Map(Object.entries(legacy).map(([name, value]) => [name.toLowerCase(), value]));
  trackingIds += 1;
  const row: Row = Object.fromEntries(TSESSIONTRACKING.columns.map(({ name }) => [name, byColumn.get(name) ?? null]));
  return { ...row, tenant_id: tenant.tenantId, trackingid: trackingIds, entered: TEST_CLOCK.now() };
}

/** A fresh row of owned `table` for `tenant` that meets every constraint of 0002_reporting.sql. */
function rowFor(table: string, tenant: TenantFixture): Row {
  switch (table) {
    case EXPORT_DEFINITION.table:
      return definitionFor(tenant, 'finance.records', { definition_id: cfUuid() });
    case EXPORT_JOB.table:
      return jobFor(definitionFor(tenant, 'finance.records'), { format: 'csv' });
    case TSESSIONTRACKING.table:
      return sessionTrackingRow(tenant);
    default:
      throw new TypeError(`reporting has no owned table ${table}`);
  }
}

/** Writes a fresh row of `table` for `tenant` through the reporting repository, so its unit gate and changelog hooks run. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  await repo().insert(tx, table, rowFor(table, tenant));
}

/** Every row of `table` visible in `tx`; RLS is the only filter. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** A contract-valid site.changed envelope of the fixture site of `tenantId`. */
function siteChangedOf(tenantId: string) {
  const fixture = fixtureForTenant(tenantId);
  if (fixture === undefined) throw new TypeError(`No tenant fixture has tenant ${tenantId}`);
  return siteChangedEnvelope(fixture.siteId);
}

/** Export job ids stored under `tenant`, read under its RLS, sorted. */
async function storedJobIds(tenant: TenantFixture): Promise<string[]> {
  return withTenant(built().db, tenant.tenantId, async (tx) => {
    const { rows } = await tx.query<{ job_id: string }>(`SELECT job_id FROM "${tx.schema}"."${EXPORT_JOB.table}" ORDER BY job_id`);
    return rows.map((row) => row.job_id);
  });
}

/** Stored export job ids of each fixture tenant, by fixture key. */
async function jobIdsByTenant(): Promise<Record<string, string[]>> {
  const ids: Record<string, string[]> = {};
  for (const tenant of TENANT_LIST) ids[tenant.key] = await storedJobIds(tenant);
  return ids;
}

/** Live tasks and task creates the fake task port has recorded. */
function taskCounts(): { live: number; creates: number } {
  const { tasks } = built();
  return { live: tasks.live.size, creates: tasks.calls.filter((call) => call.op === 'create').length };
}

/** The stored job `jobId` as `tenant` sees it, or undefined. */
async function storedJob(tenant: TenantFixture, jobId: string): Promise<ExportJobRow | undefined> {
  return withTenant(built().db, tenant.tenantId, async (tx) => {
    const { rows } = await tx.query<ExportJobRow>(`SELECT * FROM "${tx.schema}"."${EXPORT_JOB.table}" WHERE job_id = $1`, [jobId]);
    return rows[0];
  });
}

/** GETs `url` with a reporting.exporter token of `tenant`'s site. */
async function get(url: string, tenant: TenantFixture): Promise<InjectResponse> {
  return built().app.inject({ method: 'GET', url, headers: await headersFor(EXPORTER, { site: tenant.siteId }) });
}

/** POSTs a CSV export of `definitionId` to `url` with a reporting.exporter token of `tenant`'s site and a CSRF token identity accepts. */
async function create(url: string, tenant: TenantFixture, definitionId: string): Promise<InjectResponse> {
  const t = built();
  const headers = { ...(await headersFor(EXPORTER, { site: tenant.siteId })), ...t.client.issueCsrf(identityOf({ name: EXPORTER }).sid, '') };
  return t.app.inject({ method: 'POST', url, headers, payload: { definitionId, format: 'csv' } });
}

/** The tenantless-event case of the shared suite over reporting's site registry consumer. */
const SITE_CHANGED_EVENT: IsolationEventOptions = {
  app: () => handle?.app,
  subscription: SITE_CHANGED_SUBSCRIPTION,
  envelopeFor: siteChangedOf,
  // A getter: the app's capturing publisher exists only once the outer beforeAll has built the app.
  get publisher() {
    return built().publisher;
  },
};

/** Status and envelope of a JSON answer, without its echoed params. */
function answerOf(res: InjectResponse): Row {
  const body = res.json<Row>();
  return { status: res.statusCode, apiversion: body.apiversion, method: body.method, error: body.error };
}

describe.skipIf(!PG_READY)('reporting tenant isolation', () => {
  beforeAll(async () => {
    // Session tracking is legacy-authoritative by default; opened so the suite can write it through the repository.
    handle = await buildTestApp({ db: 'pg', gates: { 'reporting.session_tracking': 'open' } });
    repository = createReportingRepository({ db: handle.db, storage: handle.storage, clock: TEST_CLOCK });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('creates the tenancy, migration-kit, inbox, outbox and task queue tables with RLS forced on the tenant-owned ones', async () => {
    const schema = built().throwaway;
    if (schema === undefined) throw new Error('The pg test app holds no throwaway schema');
    await expectPlatformTables(schema, { groups: PLATFORM_GROUPS });
  });

  // The shared suite also asserts the catalog (forced RLS with USING and WITH CHECK, no bypassing role), so it is not repeated here.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => handle?.throwaway,
      name: 'reporting owned tables',
      tables: OWNED_TABLES.map(({ table }) => table),
      writeAs,
      readAs,
      rowFor,
      event: SITE_CHANGED_EVENT,
    },
  );

  describe('export routes, tenant from the token only', () => {
    const DEFINITION_A = definitionFor(TENANT_A, 'finance.records');
    const DEFINITION_B = definitionFor(TENANT_B, 'finance.records');
    const OUTPUT_A = Buffer.from('record_id,title,amount,state\r\nF1A00000-0000-4000-8000000000000001,Quarterly travel,1250.5000,SUBMITTED\r\n');
    const DONE_A = jobFor(DEFINITION_A, { format: 'csv', state: 'done' });
    const QUEUED_B = jobFor(DEFINITION_B, { format: 'csv' });
    const OUTSIDERS = [TENANT_B, TENANT_UMBRELLA] as const;
    const JOB_PATHS = [`${V1_EXPORTS}/:id`, `${V1_EXPORTS}/:id/download-url`, `${FIXTURE_EXPORTS}/:id`, `${FIXTURE_EXPORTS}/:id/download`] as const;
    let doneA: ExportJobRow = DONE_A;

    /** Markers of tenant A data a response to another tenant must not carry: its stored job ids and its definition, file and output. */
    async function tenantAMarkers(): Promise<string[]> {
      return [...(await storedJobIds(TENANT_A)), DEFINITION_A.definition_id, String(doneA.file_name), String(doneA.output_sha256)];
    }

    /** The tenant A markers that occur in `body`. */
    async function leakedIn(body: string): Promise<string[]> {
      return (await tenantAMarkers()).filter((marker) => body.includes(marker));
    }

    /** The signed download URL of tenant A's done job, issued to a tenant A exporter. */
    async function signedUrlOfA(): Promise<string> {
      const res = await get(`${V1_EXPORTS}/${doneA.job_id}/download-url`, TENANT_A);
      expect(res.statusCode).toBe(200);
      return res.json<{ data: { url: string } }>().data.url;
    }

    beforeAll(async () => {
      const t = built();
      const key = exportObjectKey(TENANT_A.tenantId, DONE_A.job_id, 'csv');
      const put = await t.storage.put(EXPORT_BUCKET, key, OUTPUT_A, { contentType: 'text/csv' });
      doneA = { ...DONE_A, object_key: key, output_sha256: put.sha256 };
      await t.seed('export_definition', [DEFINITION_A, DEFINITION_B]);
      await t.seed('export_job', [doneA, QUEUED_B]);
    });

    it('a tenant A exporter lists, reads and downloads its own job on /v1 and the fixture routes', async () => {
      const own = await storedJobIds(TENANT_A);
      const v1List = await get(V1_EXPORTS, TENANT_A);
      const v1Job = await get(`${V1_EXPORTS}/${doneA.job_id}`, TENANT_A);
      const fixtureList = await get(`${FIXTURE_EXPORTS}?siteid=${TENANT_A.siteId}&itemsPerPage=1000`, TENANT_A);
      const fixtureJob = await get(`${FIXTURE_EXPORTS}/${doneA.job_id}`, TENANT_A);
      const download = await get(`${FIXTURE_EXPORTS}/${doneA.job_id}/download`, TENANT_A);

      expect(own).toContain(doneA.job_id);
      expect([v1List, v1Job, fixtureList, fixtureJob, download].map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(v1List.json<{ data: Array<{ job_id: string }> }>().data.map((job) => job.job_id).sort()).toEqual(own);
      expect(fixtureList.json<{ data: { items: Array<{ job_id: string }> } }>().data.items.map((job) => job.job_id).sort()).toEqual(own);
      expect(v1Job.json<{ data: { job_id: string } }>().data.job_id).toBe(doneA.job_id);
      expect(fixtureJob.json<{ data: { job_id: string } }>().data.job_id).toBe(doneA.job_id);
      expect(download.rawPayload.equals(OUTPUT_A)).toBe(true);
    });

    it('a tenant A exporter streams its job output through the signed download URL', async () => {
      const res = await built().app.inject({ method: 'GET', url: await signedUrlOfA() });

      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(OUTPUT_A)).toBe(true);
    });

    it.each(OUTSIDERS)('a tenant $key exporter lists only its own jobs and never a tenant A job', async (reader) => {
      const own = await storedJobIds(reader);
      const v1 = await get(V1_EXPORTS, reader);
      const fixture = await get(`${FIXTURE_EXPORTS}?siteid=${reader.siteId}&itemsPerPage=1000`, reader);

      expect(own.length).toBeGreaterThanOrEqual(1);
      expect([v1.statusCode, fixture.statusCode]).toEqual([200, 200]);
      expect(v1.json<{ data: Array<{ job_id: string }> }>().data.map((job) => job.job_id).sort()).toEqual(own);
      expect(fixture.json<{ data: { items: Array<{ job_id: string }> } }>().data.items.map((job) => job.job_id).sort()).toEqual(own);
      expect(await leakedIn(v1.body), 'tenant A data in the /v1 list').toEqual([]);
      expect(await leakedIn(fixture.body), 'tenant A data in the fixture list').toEqual([]);
    });

    it.each(OUTSIDERS.flatMap((reader) => JOB_PATHS.map((path) => ({ reader, path }))))(
      'a tenant $reader.key exporter gets the never-stored answer for a tenant A job on $path',
      async ({ reader, path }) => {
        const foreign = await get(path.replace(':id', doneA.job_id), reader);
        const missing = await get(path.replace(':id', cfUuid()), reader);

        expect(answerOf(foreign)).toMatchObject({
          status: NOT_FOUND.status,
          apiversion: 'v1',
          error: { code: NOT_FOUND.code, message: NOT_FOUND.message },
        });
        expect(answerOf(foreign)).toEqual(answerOf(missing));
        expect(foreign.json()).not.toHaveProperty('data');
        expect(await leakedIn(foreign.body)).toEqual([]);
      },
    );

    it.each([V1_EXPORTS, FIXTURE_EXPORTS])('refuses a tenant B exporter naming siteid tenant-a on %s with 403 and no tenant A data', async (url) => {
      const res = await get(`${url}?siteid=${TENANT_A.siteId}`, TENANT_B);

      expect(res.statusCode).toBe(403);
      expect(res.json()).not.toHaveProperty('data');
      expect(await leakedIn(res.body)).toEqual([]);
    });

    it.each([V1_EXPORTS, FIXTURE_EXPORTS])('refuses a tenant B export of the tenant A definition on %s and stores no job or task', async (url) => {
      const jobsBefore = await jobIdsByTenant();
      const tasksBefore = taskCounts();

      const res = await create(url, TENANT_B, DEFINITION_A.definition_id);

      expect(answerOf(res)).toMatchObject({ status: NOT_FOUND.status, error: { code: NOT_FOUND.code, message: NOT_FOUND.message } });
      expect(res.json()).not.toHaveProperty('data');
      expect(await jobIdsByTenant()).toEqual(jobsBefore);
      expect(taskCounts()).toEqual(tasksBefore);
    });

    it('a tenant A signed URL re-addressed to tenant B answers 403 and streams no bytes', async () => {
      const url = await signedUrlOfA();
      const tampered = url.replace(`/${TENANT_A.tenantId}/`, `/${TENANT_B.tenantId}/`);

      const res = await built().app.inject({ method: 'GET', url: tampered });

      expect(tampered).not.toBe(url);
      expect(res.statusCode).toBe(403);
      expect(res.rawPayload.includes(OUTPUT_A)).toBe(false);
      expect(res.json()).toHaveProperty('error');
    });
  });

  describe('export-run task, tenant from the stored job only', () => {
    const DEFINITION = definitionFor(TENANT_A, 'finance.records', { definition_id: cfUuid() });
    const QUEUED_A = jobFor(DEFINITION, { format: 'csv' });
    const RUN_PATH = RUN_QUEUE.targetPath.replace('{exportId}', QUEUED_A.job_id);

    /** Delivers `body` to the job's run route as the tasks-invoker would. */
    async function deliver(body: TaskWireBody): Promise<InjectResponse> {
      return built().app.inject({
        method: 'POST',
        url: RUN_PATH,
        headers: {
          authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`,
          [CLOUD_TASKS_HEADERS.taskName]: body.name,
          [CLOUD_TASKS_HEADERS.queueName]: body.queue,
        },
        payload: { ...body },
      });
    }

    beforeAll(async () => {
      const t = built();
      await t.seed('export_definition', [DEFINITION]);
      await t.seed('export_job', [QUEUED_A]);
    });

    it('refuses a run task naming tenant B for a tenant A job and leaves the job queued with no output', async () => {
      const t = built();
      const wire = await queueRun(t, QUEUED_A);
      const before = await storedJob(TENANT_A, QUEUED_A.job_id);

      const res = await deliver({ ...wire, tenantId: TENANT_B.tenantId });

      const refusal = errorSpec(new TaskTenantMismatchError(TENANT_B.tenantId, wire.name).type);
      expect(wire).toMatchObject({
        queue: RUN_QUEUE.name,
        name: exportRunTaskName(QUEUED_A.job_id),
        tenantId: TENANT_A.tenantId,
        payload: { jobId: QUEUED_A.job_id, asOf: TEST_AS_OF },
      });
      expect(res.statusCode).toBe(refusal.status);
      expect(res.json()).toMatchObject({ error: { code: refusal.code, message: refusal.message } });
      expect(before).toMatchObject({ state: 'queued', row_version: '1', object_key: null });
      expect(await storedJob(TENANT_A, QUEUED_A.job_id)).toEqual(before);
      expect(await storedJob(TENANT_B, QUEUED_A.job_id)).toBeUndefined();
      expect(await t.storage.head(EXPORT_BUCKET, exportObjectKey(TENANT_A.tenantId, QUEUED_A.job_id, 'csv'))).toBeNull();
      // The key the first claim of the job would store its output under.
      expect(await t.storage.head(EXPORT_BUCKET, exportAttemptKey(TENANT_A.tenantId, QUEUED_A.job_id, 'csv', '2'))).toBeNull();
    });

    it('runs the same task under tenant A, moving the job out of queued', async () => {
      const wire = await queueRun(built(), QUEUED_A);

      const res = await deliver(wire);

      const stored = await storedJob(TENANT_A, QUEUED_A.job_id);
      const firstClaimKey = exportAttemptKey(TENANT_A.tenantId, QUEUED_A.job_id, 'csv', '2');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ jobId: QUEUED_A.job_id, state: 'done' });
      expect(stored).toMatchObject({ state: 'done', object_key: firstClaimKey });
      expect(await built().storage.head(EXPORT_BUCKET, firstClaimKey)).not.toBeNull();
    });
  });
});
