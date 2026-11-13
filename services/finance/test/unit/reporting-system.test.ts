// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * `listExportRecords`, reporting's System read of an export job's finance records, through app.inject over the recording db and a
 * reporting double: the tenant comes from this service's registry once reporting confirms the stored job, never from the caller.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, type ServiceRequest } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, mintServiceToken, mintTasksInvokerToken, type InjectResponse, type TenantFixture } from '@opt2/platform/testing';
import type { FinanceState } from '../../src/domain/lifecycle.transitions.js';
import { EXPORT_RECORDS_PATH } from '../../src/routes/export-reads.js';
import { TEST_CLOCK, buildTestApp, headersFor, type ReportingScopeAnswer, type TestApp } from '../helpers/app.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const EXPORT_ID = 'E0A1B2C3-1111-4000-8000000000000001';
const OTHER_EXPORT_ID = 'E0A1B2C3-1111-4000-8000000000000002';
const CLAIM = '2';
const SEED_USER = 'F1A2B3C4-1111-4000-8000000000000001';
const SCOPE_PATH = `/internal/v1/exports/${EXPORT_ID}/source-scope`;
const FORBIDDEN = { code: LEGACY_ERROR_MAP.authorization.code, message: LEGACY_ERROR_MAP.authorization.message };

/** Reporting's answer for its job EXPORT_ID of `tenant`, running under CLAIM and reading the finance records, with `overrides`. */
function confirmed(tenant: TenantFixture = TENANT_A, overrides: Record<string, unknown> = {}): ReportingScopeAnswer {
  return {
    status: 200,
    body: { exportId: EXPORT_ID, tenantId: tenant.tenantId, siteId: tenant.siteId, source: 'finance.records', state: 'running', claim: CLAIM, ...overrides },
  };
}

/** The export read of tenant-a's job EXPORT_ID under CLAIM, page 1 of 2 records, `query` overriding any parameter. */
function readUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ exportId: EXPORT_ID, siteId: TENANT_A.siteId, claim: CLAIM, page: '1', pageSize: '2', ...query });
  return `${EXPORT_RECORDS_PATH}?${params.toString()}`;
}

let t: TestApp;
/** Ids of the records seeded for each tenant. */
const seeded: Record<string, string[]> = {};

/** Seeds a committed version-1 record of `tenant`; returns its id. */
function seedRecord(tenant: TenantFixture, title: string, state: FinanceState = 'SUBMITTED'): string {
  const [binding] = t.db.rows('program_binding', tenant.tenantId);
  if (binding === undefined) throw new TypeError(`no program binding for ${tenant.siteId}`);
  const id = cfUuid();
  t.db.seed('record', [
    {
      tenant_id: tenant.tenantId,
      record_id: id,
      siteid: tenant.siteId,
      title,
      amount: '125.0000',
      period: '2026-06',
      state,
      version: 1,
      created: TEST_CLOCK.now(),
      createdbyid: SEED_USER,
      legacy_program_id: binding.legacy_program_id,
    },
  ]);
  return id;
}

/** Reporting's workload credential addressed to finance, as its export runs send it. */
async function reportingHeaders(): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'reporting', audience: 'finance' })}` };
}

/** Sends `url` with `headers`, returning the answer and what it read, wrote and looked up. */
async function send(url: string, headers: Record<string, string>): Promise<{ res: InjectResponse; tenantReads: string[]; writes: number; lookups: ServiceRequest[] }> {
  t.db.clear();
  const before = t.reporting.lookups.length;
  const res = await t.app.inject({ method: 'GET', url, headers });
  // Transaction control and the registry lookup that resolves the site are not reads of the tenant's data.
  const tenantReads = t.db
    .queries()
    .map((query) => query.sql)
    .filter((sql) => !/^(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql) && !/set_config\(/.test(sql) && !/finance\.tenant_registry/.test(sql));
  return { res, tenantReads, writes: t.db.writes().length, lookups: t.reporting.lookups.slice(before) };
}

/** Validates `res` against `listExportRecords` in the finance contract. */
function assertContract(res: InjectResponse): void {
  assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: EXPORT_RECORDS_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
}

/** The `error` of a legacy envelope body. */
function errorOf(res: InjectResponse): unknown {
  return (JSON.parse(res.body) as { error?: unknown }).error;
}

beforeAll(async () => {
  t = await buildTestApp();
  seeded[TENANT_A.tenantId] = ['Alpha', 'Bravo', 'Charlie'].map((title) => seedRecord(TENANT_A, title));
  seeded[TENANT_B.tenantId] = [seedRecord(TENANT_B, 'Other tenant')];
});

afterAll(async () => {
  await t?.app.close();
});

beforeEach(() => {
  t.reporting.answer(confirmed());
});

describe('a confirmed export scope', () => {
  it.each([
    ['the job site', TENANT_A.siteId],
    ['the job site in another case', TENANT_A.siteId.toUpperCase()],
  ])(
    "answers the registry tenant's records as the record list pages them, after one scope lookup sending %s and no user token",
    async (_case, siteId) => {
      const { res, tenantReads, writes, lookups } = await send(readUrl({ siteId }), await reportingHeaders());

      expect(res.statusCode, res.body).toBe(200);
      assertContract(res);
      const listed = await t.app.inject({ method: 'GET', url: '/v1/finance/records?page=1&pageSize=2', headers: await headersFor('finance.preparer', { site: TENANT_A.siteId }) });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(JSON.parse(res.body)).toStrictEqual(JSON.parse(listed.body));
      const body = JSON.parse(res.body) as { data: Array<{ record_id: string; siteid: string }>; total: number };
      expect(body.total).toBe(seeded[TENANT_A.tenantId]?.length);
      expect(body.data.map((row) => row.siteid)).toStrictEqual([TENANT_A.siteId, TENANT_A.siteId]);
      expect(body.data.every((row) => seeded[TENANT_A.tenantId]?.includes(row.record_id))).toBe(true);
      expect(tenantReads.length).toBeGreaterThan(0);
      expect(writes).toBe(0);
      expect(lookups).toStrictEqual([{ service: 'reporting', method: 'GET', path: SCOPE_PATH, query: { siteId }, userToken: null }]);
    },
  );

  it('answers the last page and the count of all records', async () => {
    const { res } = await send(readUrl({ page: '2' }), await reportingHeaders());

    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[]; total: number };
    expect([body.data.length, body.total]).toStrictEqual([1, 3]);
  });
});

describe('an export scope reporting does not confirm', () => {
  it.each<[string, ReportingScopeAnswer]>([
    ['another job', confirmed(TENANT_A, { exportId: OTHER_EXPORT_ID })],
    ['the job under another tenant', confirmed(TENANT_A, { tenantId: TENANT_B.tenantId })],
    ['the job on another site', confirmed(TENANT_A, { siteId: TENANT_B.siteId })],
    ['a job reading the timesheets', confirmed(TENANT_A, { source: 'timesheets.sheets' })],
    ['a queued job', confirmed(TENANT_A, { state: 'queued' })],
    ['a done job', confirmed(TENANT_A, { state: 'done' })],
    ['a failed job', confirmed(TENANT_A, { state: 'failed' })],
    ['a job its run has since reclaimed', confirmed(TENANT_A, { claim: '3' })],
    ["reporting's notFound", { status: 404, body: { error: { code: 'invalid_request', message: 'Not Found' } } }],
    ["reporting's refusal", { status: 403, body: { error: FORBIDDEN } }],
    ['a body that is no scope', { status: 200, body: null }],
  ])('refuses %s with 403 before any read of the tenant, writing nothing', async (_case, answer) => {
    t.reporting.answer(answer);

    const { res, tenantReads, writes, lookups } = await send(readUrl(), await reportingHeaders());

    expect([res.statusCode, errorOf(res)]).toStrictEqual([403, FORBIDDEN]);
    assertContract(res);
    expect({ tenantReads, writes, lookups: lookups.length }).toStrictEqual({ tenantReads: [], writes: 0, lookups: 1 });
  });

  it("refuses a tenant-b site reporting confirms only for tenant-a's job, reading neither tenant", async () => {
    const { res, tenantReads, lookups } = await send(readUrl({ siteId: TENANT_B.siteId }), await reportingHeaders());

    expect([res.statusCode, errorOf(res)]).toStrictEqual([403, FORBIDDEN]);
    expect({ tenantReads, lookups: lookups.map((lookup) => lookup.query) }).toStrictEqual({ tenantReads: [], lookups: [{ siteId: TENANT_B.siteId }] });
  });

  it('refuses a site the registry does not hold without asking reporting', async () => {
    const { res, tenantReads, lookups } = await send(readUrl({ siteId: 'no-such-site' }), await reportingHeaders());

    expect([res.statusCode, errorOf(res)]).toStrictEqual([403, FORBIDDEN]);
    expect({ tenantReads, lookups }).toStrictEqual({ tenantReads: [], lookups: [] });
  });

  it.each<[string, ReportingScopeAnswer]>([
    ['answers 503', { status: 503, body: { error: { code: 'server_error', message: 'Service Unavailable' } } }],
    ['answers 500', { status: 500 }],
    ['cannot be reached', new ServiceUnavailableError('reporting', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))],
  ])('answers the legacy 503 when reporting %s, reading nothing of the tenant', async (_case, answer) => {
    t.reporting.answer(answer);

    const { res, tenantReads, writes } = await send(readUrl(), await reportingHeaders());

    expect(res.statusCode, res.body).toBe(503);
    assertContract(res);
    expect({ tenantReads, writes }).toStrictEqual({ tenantReads: [], writes: 0 });
  });
});

describe('credentials and parameters', () => {
  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ["an exporter's user token through the gateway", () => headersFor('reporting.exporter', { site: TENANT_A.siteId }), 403],
    ["the timesheets workload's credential", async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'timesheets', audience: 'finance' })}` }), 403],
    ['the gateway credential carrying the exporter role', async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'finance', roles: ['reporting.exporter'] })}` }), 403],
    ["reporting's credential addressed to timesheets", async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'reporting', audience: 'timesheets' })}` }), 401],
    ['a tasks-invoker token', async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'finance' })}` }), 401],
    ['no credential', () => Promise.resolve({}), 401],
  ])('refuses %s before any lookup or read', async (_case, headers, status) => {
    const { res, tenantReads, lookups } = await send(readUrl(), await headers());

    expect(res.statusCode, res.body).toBe(status);
    expect({ tenantReads, lookups }).toStrictEqual({ tenantReads: [], lookups: [] });
  });

  it.each([
    ['no claim', { claim: '' }],
    ['a malformed job id', { exportId: 'not-a-job' }],
    ['a page of 0', { page: '0' }],
    ['a page size above 1000', { pageSize: '1001' }],
  ])('answers 400 to %s before any lookup', async (_case, query) => {
    const params = new URLSearchParams(readUrl(query).split('?')[1]);
    for (const [name, value] of Object.entries(query)) if (value === '') params.delete(name);

    const { res, tenantReads, lookups } = await send(`${EXPORT_RECORDS_PATH}?${params.toString()}`, await reportingHeaders());

    expect(res.statusCode, res.body).toBe(400);
    assertContract(res);
    expect({ tenantReads, lookups }).toStrictEqual({ tenantReads: [], lookups: [] });
  });
});
