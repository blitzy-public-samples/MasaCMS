// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `GET /internal/v1/migration/objects` on the reporting app: a done job's output bytes, 404s, 400s and authorisation. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { EXPORT_BUCKET, exportObjectKey, type ExportJobRow } from '../../src/repo/tables.js';
import { OPENAPI, buildTestApp, headersFor, seedDefinition, seedJob, type TestApp } from '../helpers/app.js';

const OBJECTS_URL = '/internal/v1/migration/objects';
const JOB_UNIT = 'reporting.export_job';
const STORED = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f]);

let t: TestApp;
let stored: ExportJobRow;
let queued: ExportJobRow;
let unstored: ExportJobRow;
let otherTenant: ExportJobRow;

/** The read of `query` as `subject` presents it, checked against the contract. */
async function read(query: Record<string, string>, subject: string | null = 'service:migration') {
  const headers = subject === null ? {} : await headersFor(subject);
  const res = await t.app.inject({ method: 'GET', url: OBJECTS_URL, query, headers });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: OBJECTS_URL, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** A done xlsx job row like `base` under a new id, naming the object key of its output; nothing is stored under it yet. */
function doneRow(base: ExportJobRow): ExportJobRow {
  const jobId = cfUuid();
  return { ...base, job_id: jobId, format: 'xlsx', state: 'done', object_key: exportObjectKey(base.tenant_id, jobId, 'xlsx'), output_sha256: '0'.repeat(64) };
}

beforeAll(async () => {
  t = await buildTestApp();
  const definitionA = seedDefinition(t.db, TENANT_A.siteId);
  queued = await seedJob(t, definitionA, 'queued');
  stored = doneRow(queued);
  unstored = doneRow(queued);
  otherTenant = await seedJob(t, seedDefinition(t.db, TENANT_B.siteId), 'done');
  t.db.seed('export_job', [stored, unstored]);
  await t.storage.put(EXPORT_BUCKET, stored.object_key ?? '', STORED, { contentType: 'application/octet-stream' });
});

afterAll(async () => {
  await t?.close();
});

describe('migration object read', () => {
  it('declares the contract operation with its transport and required role', () => {
    const operation = (OPENAPI as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths[OBJECTS_URL]?.get;
    expect(collectRouteMatrix(t.app).routes.filter((route) => route.url === OBJECTS_URL)).toEqual([
      expect.objectContaining({ method: 'GET', transport: operation?.['x-opt2-transport'], requires: operation?.['x-opt2-requires'] }),
    ]);
  });

  it('streams the stored output of a done job as an octet stream of its length', async () => {
    const res = await read({ tenantId: TENANT_A.tenantId, jobId: stored.job_id });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(STORED.length));
    expect(res.rawPayload.equals(STORED)).toBe(true);
  });

  it("streams the output while the job unit's gate is closed", async () => {
    await t.setGate(JOB_UNIT, 'closed');
    try {
      const res = await read({ tenantId: TENANT_A.tenantId, jobId: stored.job_id });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(STORED)).toBe(true);
    } finally {
      await t.setGate(JOB_UNIT, 'open');
    }
  });

  it.each<[string, () => Record<string, string>]>([
    ['the tenant has no such job', () => ({ tenantId: TENANT_A.tenantId, jobId: cfUuid() })],
    ['the job belongs to another tenant', () => ({ tenantId: TENANT_A.tenantId, jobId: otherTenant.job_id })],
    ['the job row names no object', () => ({ tenantId: TENANT_A.tenantId, jobId: queued.job_id })],
    ['storage holds no object under the row key', () => ({ tenantId: TENANT_A.tenantId, jobId: unstored.job_id })],
  ])('answers the legacy 404 when %s', async (_label, query) => {
    const res = await read(query());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid method call' } });
  });

  it('answers the legacy 500 when storage fails other than by a missing object', async () => {
    vi.spyOn(t.storage, 'open').mockRejectedValueOnce(new Error('storage unavailable'));
    const res = await read({ tenantId: TENANT_A.tenantId, jobId: stored.job_id });
    expect(res.statusCode).toBe(500);
  });

  it.each<[string, Record<string, string>]>([
    ['a tenant id that is not a UUID', { tenantId: TENANT_A.siteId, jobId: cfUuid() }],
    ['a job id that is not a CF UUID', { tenantId: TENANT_A.tenantId, jobId: '6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c' }],
    ['no job id', { tenantId: TENANT_A.tenantId }],
    ['an undeclared parameter', { tenantId: TENANT_A.tenantId, jobId: cfUuid(), siteId: TENANT_A.siteId }],
  ])('refuses %s', async (_label, query) => {
    const res = await read(query);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });

  it.each<[string, string | null, number]>([
    ['no credential', null, 401],
    ['the operator service', 'service:operator', 403],
    ['another service', 'service:finance', 403],
    ['a reporting exporter user token', 'reporting.exporter', 403],
  ])('refuses %s', async (_label, subject, status) => {
    const res = await read({ tenantId: TENANT_A.tenantId, jobId: stored.job_id }, subject);
    expect(res.statusCode).toBe(status);
  });
});
