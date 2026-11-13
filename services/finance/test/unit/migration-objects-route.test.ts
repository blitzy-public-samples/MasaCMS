// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `GET /internal/v1/migration/objects` on the finance app: an uploaded attachment's bytes, 404s, 400s and authorisation. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { ATTACHMENT_BUCKET, attachmentObjectKey } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

const OBJECTS_URL = '/internal/v1/migration/objects';
const RECORD_ID = 'A0B1C2D3-0001-4E5F-A0B1C2D3E4F5A6B7';
const OTHER_TENANT_ID = 'A0B1C2D3-0002-4E5F-A0B1C2D3E4F5A6B7';
const UNSTORED_ID = 'A0B1C2D3-0003-4E5F-A0B1C2D3E4F5A6B7';
const UNKNOWN_ID = 'A0B1C2D3-0004-4E5F-A0B1C2D3E4F5A6B7';
const PREPARER_ID = 'A0B1C2D3-0005-4E5F-A0B1C2D3E4F5A6B7';
const UPLOADED = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f]);
const BOUNDARY = 'migrationobjects';

let t: TestApp;
let uploadedId: string;

/** An attachment row of `tenantId` under program `programId`, its object key named for `fileName`. */
function attachmentRow(tenantId: string, attachmentId: string, programId: number) {
  return {
    tenant_id: tenantId,
    attachment_id: attachmentId,
    record_id: RECORD_ID,
    file_name: 'scan.pdf',
    content_type: 'application/pdf',
    size_bytes: 3,
    sha256: '0'.repeat(64),
    object_key: attachmentObjectKey(tenantId, attachmentId, 'scan.pdf'),
    created: TEST_CLOCK.now(),
    createdbyid: PREPARER_ID,
    legacy_program_id: programId,
  };
}

/** The read of `query` as `subject` presents it, checked against the contract. */
async function read(query: Record<string, string>, subject: Parameters<typeof headersFor>[0] | null = 'service:migration') {
  const headers = subject === null ? {} : await headersFor(subject, { csrf: false });
  const res = await t.app.inject({ method: 'GET', url: OBJECTS_URL, query, headers });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: OBJECTS_URL, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

beforeAll(async () => {
  t = await buildTestApp({
    seed: {
      record: [
        {
          tenant_id: TENANT_A.tenantId,
          record_id: RECORD_ID,
          siteid: TENANT_A.siteId,
          title: 'Receipts',
          amount: '12.5000',
          period: '2026-06',
          state: 'IN-PROGRESS',
          version: 1,
          created: TEST_CLOCK.now(),
          createdbyid: PREPARER_ID,
          legacy_program_id: 1,
        },
      ],
      attachment: [attachmentRow(TENANT_B.tenantId, OTHER_TENANT_ID, 2), attachmentRow(TENANT_A.tenantId, UNSTORED_ID, 1)],
    },
  });
  await t.storage.put(ATTACHMENT_BUCKET, attachmentObjectKey(TENANT_B.tenantId, OTHER_TENANT_ID, 'scan.pdf'), Buffer.from('tenant b'), {
    contentType: 'application/pdf',
  });
  const upload = await t.app.inject({
    method: 'POST',
    url: `/v1/finance/records/${RECORD_ID}/attachments`,
    headers: { ...(await headersFor({ roles: [Roles.financePreparer] }, { sub: PREPARER_ID })), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="receipt.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      UPLOADED,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  });
  expect(upload.statusCode).toBe(200);
  uploadedId = upload.json<{ data: { attachment_id: string } }>().data.attachment_id;
});

afterAll(async () => {
  await t?.app.opt2.shutdown();
});

describe('migration object read', () => {
  it('declares the contract operation with its transport and required role', () => {
    const operation = OPENAPI.paths[OBJECTS_URL]?.get;
    expect(collectRouteMatrix(t.app).routes.filter((route) => route.url === OBJECTS_URL)).toEqual([
      expect.objectContaining({ method: 'GET', transport: operation?.['x-opt2-transport'], requires: operation?.['x-opt2-requires'] }),
    ]);
  });

  it('streams the bytes of an uploaded attachment as an octet stream of their length', async () => {
    const res = await read({ tenantId: TENANT_A.tenantId, attachmentId: uploadedId });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(UPLOADED.length));
    expect(res.rawPayload.equals(UPLOADED)).toBe(true);
  });

  it.each<[string, () => Record<string, string>]>([
    ['the tenant has no such attachment', () => ({ tenantId: TENANT_A.tenantId, attachmentId: UNKNOWN_ID })],
    ['the attachment belongs to another tenant', () => ({ tenantId: TENANT_A.tenantId, attachmentId: OTHER_TENANT_ID })],
    ['the uploaded attachment is asked of another tenant', () => ({ tenantId: TENANT_B.tenantId, attachmentId: uploadedId })],
    ['storage holds no object under the row key', () => ({ tenantId: TENANT_A.tenantId, attachmentId: UNSTORED_ID })],
  ])('answers the legacy 404 when %s', async (_label, query) => {
    const res = await read(query());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid method call' } });
  });

  it('answers the legacy 500 when storage fails other than by a missing object', async () => {
    vi.spyOn(t.storage, 'open').mockRejectedValueOnce(new Error('storage unavailable'));
    const res = await read({ tenantId: TENANT_A.tenantId, attachmentId: uploadedId });
    expect(res.statusCode).toBe(500);
  });

  it.each<[string, Record<string, string>]>([
    ['a tenant id that is not a UUID', { tenantId: TENANT_A.siteId, attachmentId: UNKNOWN_ID }],
    ['an attachment id that is not a CF UUID', { tenantId: TENANT_A.tenantId, attachmentId: '6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c' }],
    ['no attachment id', { tenantId: TENANT_A.tenantId }],
    ['an undeclared parameter', { tenantId: TENANT_A.tenantId, attachmentId: UNKNOWN_ID, siteId: TENANT_A.siteId }],
  ])('refuses %s', async (_label, query) => {
    const res = await read(query);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });

  it.each<[string, Parameters<typeof headersFor>[0] | null, number]>([
    ['no credential', null, 401],
    ['the operator service', 'service:operator', 403],
    ['another service', 'service:reporting', 403],
    ['a finance preparer user token', 'finance.preparer', 403],
  ])('refuses %s', async (_label, subject, status) => {
    const res = await read({ tenantId: TENANT_A.tenantId, attachmentId: uploadedId }, subject);
    expect(res.statusCode).toBe(status);
  });
});
