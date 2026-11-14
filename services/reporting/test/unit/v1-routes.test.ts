// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/reporting/exports`, the local export file route and the export source scope read through the full reporting app over a throwaway `reporting` schema. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles, serviceRole } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { sha256Hex } from '@opt2/platform/migration-kit';
import { SIGNED_URL_TTL_S } from '@opt2/platform/storage';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_LIST, assertResponseMatchesOpenApi, pgAvailable, type TenantFixture } from '@opt2/platform/testing';
import type { components } from '../../src/generated/openapi.js';
import { FIXTURE_ERROR_MAP, type FixtureErrorType } from '../../src/legacy/envelope.js';
import { EXPORT_BUCKET, exportObjectKey, type ExportJobRow, type ExportState } from '../../src/repo/tables.js';
import { toV1ExportJob } from '../../src/routes/v1.js';
import { exportRunTaskName } from '../../src/tasks/enqueue.js';
import { OPENAPI, REQUESTER, TEST_AS_OF, TEST_CLOCK, buildTestApp, headersFor, queuedRun, scopeUrl, type TestApp } from '../helpers/app.js';
import { definitionFor, jobFor, seedDefinitions } from '../helpers/fixtures.js';

type ExportJob = components['schemas']['ExportJob'];
type SignedUrl = components['schemas']['SignedUrl'];

/** What the contract assertions read of an injected response. */
interface InjectedResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}

// pgAvailable rejects when PG_HOST is unset, so the suites skip on that before probing the server.
const pgReady = Boolean(process.env.PG_HOST) && (await pgAvailable());

const EXPORTS = '/v1/reporting/exports';
const EXPORTER = Roles.reportingExporter;
const BYTES = Buffer.from('timesheet_id,status\r\n1,SUBMITTED\r\n');
const NOW_MS = TEST_CLOCK.now().getTime();
const FILE_PREFIX = `/opt2/files/${EXPORT_BUCKET}/`;

/** The test clock's time `hours` hours earlier. */
function hoursAgo(hours: number): Date {
  return new Date(NOW_MS - hours * 3_600_000);
}

/** Validates an injected response against the reporting contract operation of `method` `url`. */
function assertContract(method: string, url: string, res: InjectedResponse): void {
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'] as string | undefined,
    body: res.body,
  });
}

/** The fixture error envelope fields `/v1/reporting` answers for `type` under envelope `method`. */
function fixtureErrorOf(type: FixtureErrorType, method: string, message: string = FIXTURE_ERROR_MAP[type].message): object {
  return { apiversion: 'v1', method, error: { code: FIXTURE_ERROR_MAP[type].code, message } };
}

/** A done CSV job of `tenant`'s timesheet definition, created at `at`, whose stored output is {@link BYTES}. */
function doneJob(tenant: TenantFixture, at: Date = TEST_CLOCK.now()): ExportJobRow {
  return jobFor(definitionFor(tenant, 'timesheets.sheets'), { format: 'csv', state: 'done', at, output_sha256: sha256Hex(BYTES) });
}

/** Seeds `jobs`, storing each done job's output under its object key first, as a finished run leaves it. */
async function seedJobs(t: TestApp<TenantDb>, jobs: readonly ExportJobRow[]): Promise<void> {
  for (const job of jobs) {
    if (job.object_key !== null) await t.storage.put(EXPORT_BUCKET, job.object_key, BYTES, { contentType: job.content_type ?? '' });
  }
  await t.seed('export_job', jobs);
}

/** Deletes every fixture tenant's export jobs, so each test lists only the jobs it seeds. */
async function clearJobs(db: TenantDb): Promise<void> {
  for (const tenant of TENANT_LIST) {
    await withTenant(db, tenant.tenantId, (tx) => tx.query(`DELETE FROM ${tx.schema}.export_job`));
  }
}

/** `GET url` with the credentials of `subject` for `site`. */
async function getAs(t: TestApp<TenantDb>, url: string, subject: string = EXPORTER, site: string = TENANT_A.siteId) {
  return t.app.inject({ method: 'GET', url, headers: await headersFor(subject, site) });
}

/** `POST /v1/reporting/exports` with `payload` as `subject` of tenant-a, carrying a fresh token of the collection CSRF context. */
async function createAs(t: TestApp<TenantDb>, payload: Record<string, unknown>, subject: string = EXPORTER) {
  const headers = { ...(await headersFor(subject)), ...t.client.issueCsrf(REQUESTER.sid, '') };
  return t.app.inject({ method: 'POST', url: EXPORTS, headers, payload });
}

/** Task creations recorded since `from` calls. */
function taskCreatesSince(t: TestApp<TenantDb>, from: number): number {
  return t.tasks.calls.slice(from).filter((call) => call.op === 'create').length;
}

/** The signed URL `getExportDownloadUrl` issues for `job` to the tenant-a exporter. */
async function downloadUrlOf(t: TestApp<TenantDb>, job: ExportJobRow): Promise<SignedUrl> {
  const res = await getAs(t, `${EXPORTS}/${job.job_id}/download-url`);
  expect(res.statusCode).toBe(200);
  return res.json<{ data: SignedUrl }>().data;
}

describe.skipIf(!pgReady)('/v1/reporting/exports', () => {
  let t: TestApp<TenantDb>;
  const sheetsA = definitionFor(TENANT_A, 'timesheets.sheets');
  const financeA = definitionFor(TENANT_A, 'finance.records');

  beforeAll(async () => {
    t = await buildTestApp({ db: 'pg' });
    await seedDefinitions(t);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    await clearJobs(t.db);
  });

  /** Seeds three tenant-a jobs an hour apart and one tenant-b job older than all of them; returns the tenant-a jobs by creation. */
  async function seedListedJobs(): Promise<ExportJobRow[]> {
    const jobsA = [
      jobFor(sheetsA, { format: 'csv', state: 'queued', at: hoursAgo(3) }),
      jobFor(financeA, { format: 'xlsx', state: 'failed', at: hoursAgo(2) }),
      doneJob(TENANT_A, hoursAgo(1)),
    ];
    const jobB = jobFor(definitionFor(TENANT_B, 'finance.records'), { format: 'pdf', state: 'running', at: hoursAgo(4) });
    await seedJobs(t, [...jobsA, jobB]);
    return jobsA;
  }

  it("lists only the caller's tenant's jobs by creation, projected without tenant, object key or row version", async () => {
    const jobsA = await seedListedJobs();

    const res = await getAs(t, EXPORTS);

    expect(res.statusCode).toBe(200);
    assertContract('GET', EXPORTS, res);
    const body = res.json<{ data: ExportJob[]; total: number }>();
    expect(body).toStrictEqual({ data: jobsA.map(toV1ExportJob), total: 3 });
    for (const item of body.data) {
      expect(item).not.toHaveProperty('tenant_id');
      expect(item).not.toHaveProperty('object_key');
      expect(item).not.toHaveProperty('row_version');
    }
    const other = await getAs(t, EXPORTS, EXPORTER, TENANT_B.siteId);
    expect(other.json<{ total: number }>().total).toBe(1);
  });

  it.each([
    { query: '?page=1&pageSize=2', indexes: [0, 1] },
    { query: '?page=2&pageSize=2', indexes: [2] },
    { query: '?page=3&pageSize=2', indexes: [] },
  ])('pages the list for $query with the total of every job', async ({ query, indexes }) => {
    const jobsA = await seedListedJobs();

    const res = await getAs(t, `${EXPORTS}${query}`);

    expect(res.statusCode).toBe(200);
    assertContract('GET', EXPORTS, res);
    expect(res.json()).toStrictEqual({ data: indexes.map((index) => toV1ExportJob(jobsA[index] as ExportJobRow)), total: 3 });
  });

  it.each(['?page=0', '?pageSize=0', '?page=first'])('answers the legacy 400 to the list query %s', async (query) => {
    const res = await getAs(t, `${EXPORTS}${query}`);

    expect(res.statusCode).toBe(400);
    assertContract('GET', EXPORTS, res);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });

  it("reads the caller's own job and answers 404 for another tenant's job id", async () => {
    const own = doneJob(TENANT_A);
    const foreign = jobFor(definitionFor(TENANT_B, 'timesheets.sheets'), { format: 'csv', state: 'queued' });
    await seedJobs(t, [own, foreign]);

    const ownRes = await getAs(t, `${EXPORTS}/${own.job_id}`);
    expect(ownRes.statusCode).toBe(200);
    assertContract('GET', `${EXPORTS}/${own.job_id}`, ownRes);
    expect(ownRes.json()).toStrictEqual({ data: toV1ExportJob(own) });

    const foreignRes = await getAs(t, `${EXPORTS}/${foreign.job_id}`);
    expect(foreignRes.statusCode).toBe(404);
    assertContract('GET', `${EXPORTS}/${foreign.job_id}`, foreignRes);
    expect(foreignRes.json()).toMatchObject(fixtureErrorOf('notFound', 'reporting.exports'));

    const byOwner = await getAs(t, `${EXPORTS}/${foreign.job_id}`, EXPORTER, TENANT_B.siteId);
    expect(byOwner.json()).toStrictEqual({ data: toV1ExportJob(foreign) });
  });

  it('queues a job of a tenant definition and creates exactly one run task for it', async () => {
    const before = t.tasks.calls.length;

    const res = await createAs(t, { definitionId: sheetsA.definition_id, format: 'xlsx', asOf: TEST_AS_OF });

    expect(res.statusCode).toBe(200);
    assertContract('POST', EXPORTS, res);
    const job = res.json<{ data: ExportJob }>().data;
    expect(job).toMatchObject({
      siteid: TENANT_A.siteId,
      definition_id: sheetsA.definition_id,
      format: 'xlsx',
      state: 'queued',
      requested_by_id: REQUESTER.sub,
      started_at: '',
      finished_at: '',
      error: '',
      file_name: '',
      content_type: '',
      output_sha256: '',
    });
    expect(res.headers['x-opt2-write-position']).toMatch(/^reporting=\d+$/);
    expect(taskCreatesSince(t, before)).toBe(1);
    expect(queuedRun(t, job.job_id)).toStrictEqual({
      queue: 'reporting-export-run',
      name: exportRunTaskName(job.job_id),
      tenantId: TENANT_A.tenantId,
      payload: { jobId: job.job_id, asOf: TEST_AS_OF },
    });
    expect((await getAs(t, `${EXPORTS}/${job.job_id}`)).json()).toStrictEqual({ data: job });
  });

  it.each<{ name: string; payload: () => Record<string, unknown>; type: FixtureErrorType }>([
    { name: 'an unknown definition', payload: () => ({ definitionId: cfUuid(), format: 'csv' }), type: 'notFound' },
    {
      name: "another tenant's definition",
      payload: () => ({ definitionId: definitionFor(TENANT_B, 'timesheets.sheets').definition_id, format: 'csv' }),
      type: 'notFound',
    },
    { name: 'an unknown format', payload: () => ({ definitionId: sheetsA.definition_id, format: 'docx' }), type: 'invalidParameters' },
    {
      name: 'an impossible asOf date',
      payload: () => ({ definitionId: sheetsA.definition_id, format: 'csv', asOf: '2026-02-30' }),
      type: 'invalidParameters',
    },
  ])('refuses a create of $name with the contract status, queueing nothing', async ({ payload, type }) => {
    const before = t.tasks.calls.length;

    const res = await createAs(t, payload());

    expect(res.statusCode).toBe(FIXTURE_ERROR_MAP[type].status);
    assertContract('POST', EXPORTS, res);
    expect(res.json()).toMatchObject(fixtureErrorOf(type, 'reporting.exports'));
    expect(taskCreatesSince(t, before)).toBe(0);
    expect((await getAs(t, EXPORTS)).json<{ total: number }>().total).toBe(0);
  });

  it.each([
    { subject: 'anonymous', status: 401, method: 'GET' as const, url: EXPORTS },
    { subject: 'anonymous', status: 401, method: 'POST' as const, url: EXPORTS },
    { subject: Roles.member, status: 403, method: 'GET' as const, url: EXPORTS },
    { subject: Roles.member, status: 403, method: 'POST' as const, url: EXPORTS },
    { subject: Roles.member, status: 403, method: 'GET' as const, url: `${EXPORTS}/${cfUuid()}/download-url` },
  ])('answers $subject on $method $url with $status before any effect', async ({ subject, status, method, url }) => {
    const before = t.tasks.calls.length;
    const headers = await headersFor(subject);

    const res = await t.app.inject({ method, url, headers, ...(method === 'POST' ? { payload: { definitionId: sheetsA.definition_id, format: 'csv' } } : {}) });

    expect(res.statusCode).toBe(status);
    assertContract(method, url, res);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(t.tasks.calls.length).toBe(before);
    expect((await getAs(t, EXPORTS)).json<{ total: number }>().total).toBe(0);
  });

  it.each<ExportState>(['queued', 'running', 'failed'])('answers the not-ready 409 to a download URL of a %s job', async (state) => {
    const job = jobFor(sheetsA, { format: 'csv', state });
    await seedJobs(t, [job]);
    const url = `${EXPORTS}/${job.job_id}/download-url`;

    const res = await getAs(t, url);

    expect(res.statusCode).toBe(409);
    assertContract('GET', url, res);
    expect(res.json()).toMatchObject(fixtureErrorOf('conflict', 'reporting.exports.download', 'not-ready'));
  });

  it('issues a done job a local signed URL of its object, valid for SIGNED_URL_TTL_S from the test clock', async () => {
    const job = doneJob(TENANT_A);
    await seedJobs(t, [job]);
    const url = `${EXPORTS}/${job.job_id}/download-url`;

    const res = await getAs(t, url);

    expect(res.statusCode).toBe(200);
    assertContract('GET', url, res);
    const signed = res.json<{ data: SignedUrl }>().data;
    expect(signed.expiresAt).toBe(new Date(NOW_MS + SIGNED_URL_TTL_S * 1000).toISOString());
    const parsed = new URL(signed.url, 'http://localhost');
    expect(parsed.pathname.startsWith(`${FILE_PREFIX}${TENANT_A.tenantId}/`)).toBe(true);
    expect(parsed.pathname).toBe(`${FILE_PREFIX}${job.object_key ?? ''}`);
    expect(parsed.searchParams.get('expires')).toBe(String(Math.floor(NOW_MS / 1000) + SIGNED_URL_TTL_S));
    expect(parsed.searchParams.get('disposition')).toBe(`attachment; filename="${job.file_name ?? ''}"`);

    const foreign = await getAs(t, url, EXPORTER, TENANT_B.siteId);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject(fixtureErrorOf('notFound', 'reporting.exports.download'));
  });
});

/** A seeded done job, its object key and the download URL `getExportDownloadUrl` issued for it. */
interface IssuedDownload {
  job: ExportJobRow;
  key: string;
  url: string;
}

describe.skipIf(!pgReady)(`GET ${FILE_PREFIX}:tenantId/:objectName`, () => {
  let t: TestApp<TenantDb>;

  beforeAll(async () => {
    t = await buildTestApp({ db: 'pg' });
    await seedDefinitions(t);
  });

  afterAll(async () => {
    await t?.close();
  });

  /** Seeds a done tenant-a job with its stored output and returns the download URL the `/v1` route issues for it. */
  async function issued(): Promise<IssuedDownload> {
    const job = doneJob(TENANT_A);
    await seedJobs(t, [job]);
    return { job, key: job.object_key ?? '', url: (await downloadUrlOf(t, job)).url };
  }

  it('serves the issued URL without credentials as the stored bytes, content type and length', async () => {
    const { job, url } = await issued();

    const res = await t.app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    assertContract('GET', url, res);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers['content-type']).toBe(job.content_type);
    expect(res.headers['content-length']).toBe(String(BYTES.length));
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${job.file_name ?? ''}"`);
  });

  it.each<{ name: string; reason: string; urlOf: (download: IssuedDownload) => string | Promise<string> }>([
    {
      name: 'one sig hex digit flipped',
      reason: 'bad-signature',
      urlOf: ({ url }) => url.replace(/sig=([0-9a-f])/, (_match, digit: string) => `sig=${digit === '0' ? '1' : '0'}`),
    },
    {
      name: 'another tenant in its path',
      reason: 'bad-signature',
      urlOf: ({ url }) => url.replace(`/${TENANT_A.tenantId}/`, `/${TENANT_B.tenantId}/`),
    },
    {
      name: 'another object name in its path',
      reason: 'bad-signature',
      urlOf: ({ job, url }) => url.replace(`/${job.job_id}.csv?`, `/${job.job_id}.pdf?`),
    },
    {
      name: 'an expiry before the test clock',
      reason: 'expired',
      // The test app hands its adapter the HMAC key inline and writes no secrets/storage-hmac-key, so the adapter itself signs the
      // expired URL rather than signLocalUrl with loadStorageHmacKey(stateDir).
      urlOf: ({ key }) => t.storage.signedUrl(EXPORT_BUCKET, key, { expiresS: -1 }),
    },
    {
      name: 'a signature for finance-attachments',
      reason: 'bad-signature',
      urlOf: async ({ key }) => (await t.storage.signedUrl('finance-attachments', key)).replace('/finance-attachments/', `/${EXPORT_BUCKET}/`),
    },
  ])('answers the legacy 403 to a URL with $name', async ({ reason, urlOf }) => {
    const url = await urlOf(await issued());
    expect(t.storage.verifySignedUrl(url)).toStrictEqual({ ok: false, reason });

    const res = await t.app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(403);
    assertContract('GET', url, res);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });

  it('answers the legacy 404 to a valid signature over a key holding no object', async () => {
    const url = await t.storage.signedUrl(EXPORT_BUCKET, exportObjectKey(TENANT_A.tenantId, cfUuid(), 'csv'));
    expect(t.storage.verifySignedUrl(url)).toMatchObject({ ok: true });

    const res = await t.app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(404);
    assertContract('GET', url, res);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });
});

describe.skipIf(!pgReady)('GET /internal/v1/exports/:exportId/source-scope', () => {
  let t: TestApp<TenantDb>;
  const sheetsA = definitionFor(TENANT_A, 'timesheets.sheets');

  beforeAll(async () => {
    t = await buildTestApp({ db: 'pg' });
    await seedDefinitions(t);
  });

  afterAll(async () => {
    await t?.close();
  });

  it("answers the source's producer workload with the running job's stored scope and claim", async () => {
    const job = jobFor(sheetsA, { format: 'csv', state: 'running' });
    await seedJobs(t, [job]);
    const url = scopeUrl(job.job_id, TENANT_A.siteId);

    const res = await getAs(t, url, serviceRole('timesheets'));

    expect(res.statusCode).toBe(200);
    assertContract('GET', url, res);
    expect(res.json()).toStrictEqual({
      exportId: job.job_id,
      tenantId: TENANT_A.tenantId,
      siteId: TENANT_A.siteId,
      source: 'timesheets.sheets',
      state: 'running',
      claim: job.row_version,
    });
  });

  it.each<{ name: string; caller: string; siteId: string; known: boolean }>([
    { name: "another source's producer", caller: 'finance', siteId: TENANT_A.siteId, known: true },
    { name: "another site's request", caller: 'timesheets', siteId: TENANT_B.siteId, known: true },
    { name: 'an unregistered site', caller: 'timesheets', siteId: 'no-such-site', known: true },
    { name: 'an unknown job', caller: 'timesheets', siteId: TENANT_A.siteId, known: false },
  ])('answers the legacy 404 to $name', async ({ caller, siteId, known }) => {
    const job = jobFor(sheetsA, { format: 'csv', state: 'running' });
    await seedJobs(t, [job]);
    const url = scopeUrl(known ? job.job_id : cfUuid(), siteId);

    const res = await getAs(t, url, serviceRole(caller));

    expect(res.statusCode).toBe(404);
    assertContract('GET', url, res);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });
});
