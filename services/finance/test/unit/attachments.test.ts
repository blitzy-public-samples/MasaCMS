// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance attachments end to end on the app: fixture and /v1 uploads into `finance-attachments`, the sendFile download, local signed URLs and migrated bytes. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// The service transport reads the invocation credential from this header; @opt2/platform/testing does not re-export it.
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { encodeRow, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { LOCAL_SIGNED_URL_PREFIX, loadStorageHmacKey, verifySignedUrl } from '@opt2/platform/storage';
import { TENANT_A, TENANT_B, mintServiceToken } from '@opt2/platform/testing';
import { financeAttachmentMapping } from '../../src/migration/mappings/finance-attachment.js';
import { ATTACHMENT_BUCKET, ATTACHMENT_CONTENT_FIELD, attachmentObjectKey, type FinanceAttachmentRow } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { attachmentRow, programBindingRow, recordRow, type AttachmentFixture } from '../helpers/records.js';

type Injected = Awaited<ReturnType<TestApp['app']['inject']>>;

/** Fixture metadata of one attachment, as finance.cfc answers an upload and lists it. */
type FixtureAttachment = {
  attachment_id: string;
  record_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created: string;
  createdbyid: string;
};

const BOUNDARY = 'opt2financeattachments';
const BASE_URL = 'http://finance.test';
const APPLY_URL = '/internal/v1/migration/apply';
/** Lifetime of a signed download URL, 15 minutes, stated literally rather than read from SIGNED_URL_TTL_S. */
const URL_TTL_S = 900;
const PREPARER_ID = 'A0B1C2D3-0101-4E5F-A0B1C2D3E4F5A6B7';
const APPROVER_ID = 'A0B1C2D3-0102-4E5F-A0B1C2D3E4F5A6B7';
const FILE_NAME = 'Reçu Q2.pdf';
const CONTENT_TYPE = 'application/pdf';
// envelope.cfc sendFile: `_` per non-ASCII code point in the quoted name, plus filename* of the UTF-8 bytes outside attr-char.
const DISPOSITION = `attachment; filename="Re_u Q2.pdf"; filename*=UTF-8''Re%C3%A7u%20Q2.pdf`;
const BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f, 0x00]), Buffer.from('\n%%EOF\n')]);
const SHA256 = createHash('sha256').update(BYTES).digest('hex');
const CSV_BYTES = Buffer.from('period,amount\r\n2026-06,1250.5000\r\n');
const MIGRATED_BYTES = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0x00]);
const FORBIDDEN = { apiversion: 'v1', method: 'invalid', error: { message: 'Insufficient Account Permissions', code: 'invalid_request' } };
/** The fixture's owned attachment columns plus the `varbinary(max)` content a backfill carries. */
const APPLY_COLUMNS: readonly CanonicalColumn[] = [...financeAttachmentMapping.legacyColumns, { name: ATTACHMENT_CONTENT_FIELD, type: 'b' }];

const fixtureRecord = recordRow({ title: 'Fixture attachments' });
const v1Record = recordRow({ title: 'v1 attachments' });
const migratedRecord = recordRow({ title: 'Migrated attachments' });
const typedRecord = recordRow({ title: 'Typed attachments' });

let nowMs = TEST_CLOCK.now().getTime();
const clock = { now: (): Date => new Date(nowMs) };

let t: TestApp;
let stateDir: string;
let upload: Injected;
let uploaded: FixtureAttachment;

/** A multipart/form-data body holding one file part named `field`. */
function multipart(field: string, fileName: string, contentType: string, bytes: Buffer): { headers: Record<string, string>; payload: Buffer } {
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  };
}

function asPreparer(): Promise<Record<string, string>> {
  return headersFor({ roles: [Roles.financePreparer] }, { site: TENANT_A.siteId, sub: PREPARER_ID });
}

function asApprover(): Promise<Record<string, string>> {
  return headersFor({ roles: [Roles.financeApprover] }, { site: TENANT_A.siteId, sub: APPROVER_ID });
}

/** The committed tenant-a attachment row `attachmentId`, if any. */
function storedAttachment(attachmentId: string): FinanceAttachmentRow | undefined {
  return t.db.rows('attachment', TENANT_A.tenantId).find((row) => row.attachment_id === attachmentId);
}

/** The v1 download URL of the fixture upload, as an approver asks for it. */
async function downloadUrl(): Promise<{ url: string; expiresAt: string }> {
  const res = await t.app.inject({
    url: `/v1/finance/records/${fixtureRecord.record_id}/attachments/${uploaded.attachment_id}/download-url`,
    headers: await asApprover(),
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ data: { url: string; expiresAt: string } }>().data;
}

/** The legacy `Program_1.finance_attachment` row of `fixture`, its bytes under `content`. */
function legacyAttachment(fixture: AttachmentFixture): Record<string, unknown> {
  return { ...financeAttachmentMapping.toLegacy(fixture.row), [ATTACHMENT_CONTENT_FIELD]: fixture.bytes };
}

/** Backfills `legacyRow` into tenant-a as the migration service does. */
async function applyAttachment(batchId: string, legacyRow: Record<string, unknown>): Promise<Injected> {
  const token = await mintServiceToken({ caller: 'migration', audience: 'finance', roles: ['platform.migration'] });
  return t.app.inject({
    method: 'POST',
    url: APPLY_URL,
    headers: { [INVOCATION_HEADER]: `Bearer ${token}` },
    payload: {
      batchId,
      origin: 'backfill',
      legacyTable: 'Program_1.finance_attachment',
      tenantId: TENANT_A.tenantId,
      columns: APPLY_COLUMNS,
      rows: [{ op: 'upsert', row: encodeRow(APPLY_COLUMNS, legacyRow) }],
    },
  });
}

beforeAll(async () => {
  t = await buildTestApp({
    clock,
    seed: { record: [fixtureRecord, v1Record, migratedRecord, typedRecord], program_binding: [programBindingRow(TENANT_A.siteId)] },
  });
  stateDir = t.stateDir;
  const body = multipart('file', FILE_NAME, CONTENT_TYPE, BYTES);
  upload = await t.app.inject({
    method: 'POST',
    url: `${FIXTURE_PREFIX}/records/${fixtureRecord.record_id}/attachments`,
    headers: { ...(await asPreparer()), ...body.headers },
    payload: body.payload,
  });
  uploaded = upload.json<{ data: FixtureAttachment }>().data;
});

afterEach(() => {
  nowMs = TEST_CLOCK.now().getTime();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await t?.app.opt2.shutdown();
  expect(existsSync(stateDir)).toBe(false);
});

describe('fixture attachment routes', () => {
  it('runs on the local storage adapter under a temporary state directory', () => {
    expect(t.storage.kind).toBe('local');
    expect(existsSync(stateDir)).toBe(true);
  });

  it('stores a multipart upload as a finance-attachments object and answers its metadata without bytes or key', async () => {
    expect(upload.statusCode).toBe(200);
    expect(uploaded).toEqual({
      attachment_id: expect.any(String),
      record_id: fixtureRecord.record_id,
      file_name: FILE_NAME,
      content_type: CONTENT_TYPE,
      size_bytes: BYTES.length,
      sha256: SHA256,
      created: '2026-06-30T12:00:00',
      createdbyid: PREPARER_ID,
    });
    expect(isCfUuid(uploaded.attachment_id)).toBe(true);

    const row = storedAttachment(uploaded.attachment_id);
    const key = attachmentObjectKey(TENANT_A.tenantId, uploaded.attachment_id, FILE_NAME);
    expect(row?.object_key).toBe(key);
    expect(row).not.toHaveProperty(ATTACHMENT_CONTENT_FIELD);
    expect(upload.body).not.toContain(key);
    expect(upload.body).not.toContain('object_key');
    expect((await t.storage.get(ATTACHMENT_BUCKET, key)).equals(BYTES)).toBe(true);
    expect(await t.storage.head(ATTACHMENT_BUCKET, key)).toEqual({ size: BYTES.length, sha256: SHA256, contentType: CONTENT_TYPE });
  });

  it('lists the upload on the fixture and /v1 attachment lists', async () => {
    const headers = await asApprover();
    const fixtureList = await t.app.inject({ url: `${FIXTURE_PREFIX}/records/${fixtureRecord.record_id}/attachments`, headers });
    expect(fixtureList.statusCode).toBe(200);
    expect(fixtureList.json().data).toMatchObject({ items: [uploaded], totalitems: 1 });

    const v1List = await t.app.inject({ url: `/v1/finance/records/${fixtureRecord.record_id}/attachments`, headers });
    expect(v1List.statusCode).toBe(200);
    expect(v1List.json()).toEqual({ data: [uploaded] });
  });

  it('downloads the attachment as its exact bytes under the sendFile headers', async () => {
    const res = await t.app.inject({
      url: `${FIXTURE_PREFIX}/records/${fixtureRecord.record_id}/attachments/${uploaded.attachment_id}`,
      headers: await asApprover(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-disposition': DISPOSITION,
      'content-length': String(BYTES.length),
      'content-type': CONTENT_TYPE,
      generator: 'Masa CMS 7.6.1',
      'strict-transport-security': 'max-age=1200',
    });
    expect(res.headers.etag).toBeUndefined();
  });

  it.each<[string, () => [recordId: string, attachmentId: string]]>([
    ['an attachment id no record holds', () => [fixtureRecord.record_id, cfUuid()]],
    ['the attachment of another record', () => [v1Record.record_id, uploaded.attachment_id]],
  ])('answers notFound to the download of %s', async (_case, ids) => {
    const [recordId, attachmentId] = ids();
    const res = await t.app.inject({ url: `${FIXTURE_PREFIX}/records/${recordId}/attachments/${attachmentId}`, headers: await asApprover() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'finance.records.attachments',
      error: { code: 'invalid_request', message: 'Not Found' },
    });
  });
});

describe('/v1 attachments and local signed URLs', () => {
  it('stores a /v1 upload under its attachment key and answers the fixture metadata', async () => {
    const body = multipart('file', 'ledger.csv', 'text/csv', CSV_BYTES);
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/finance/records/${v1Record.record_id}/attachments`,
      headers: { ...(await asPreparer()), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: FixtureAttachment }>();
    expect(data).toMatchObject({
      record_id: v1Record.record_id,
      file_name: 'ledger.csv',
      content_type: 'text/csv',
      size_bytes: CSV_BYTES.length,
      sha256: createHash('sha256').update(CSV_BYTES).digest('hex'),
      createdbyid: PREPARER_ID,
    });
    const key = attachmentObjectKey(TENANT_A.tenantId, data.attachment_id, 'ledger.csv');
    expect(storedAttachment(data.attachment_id)?.object_key).toBe(key);
    expect((await t.storage.get(ATTACHMENT_BUCKET, key)).equals(CSV_BYTES)).toBe(true);
  });

  it('issues a local signed URL for the stored object, valid for 900 s and naming the fixture disposition', async () => {
    const { url, expiresAt } = await downloadUrl();
    const startMs = TEST_CLOCK.now().getTime();
    const expires = Math.floor(startMs / 1000) + URL_TTL_S;
    expect(url.startsWith(`${LOCAL_SIGNED_URL_PREFIX}${ATTACHMENT_BUCKET}/`)).toBe(true);
    expect(new URL(url, BASE_URL).searchParams.get('expires')).toBe(String(expires));
    expect(new URL(url, BASE_URL).searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(new Date(startMs + URL_TTL_S * 1000).toISOString());
    expect(verifySignedUrl(url, startMs, await loadStorageHmacKey(stateDir))).toEqual({
      ok: true,
      bucket: ATTACHMENT_BUCKET,
      key: attachmentObjectKey(TENANT_A.tenantId, uploaded.attachment_id, FILE_NAME),
      expires,
      disposition: DISPOSITION,
    });
  });

  it('serves the signed URL as the stored bytes under the stored content type', async () => {
    const { url } = await downloadUrl();
    const res = await t.app.inject({ url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': CONTENT_TYPE,
      'content-length': String(BYTES.length),
      'content-disposition': DISPOSITION,
    });
  });

  it.each<[string, (url: string) => string]>([
    ['whose sig was tampered', (url) => url.replace(/sig=([0-9a-f])/, (_match, first: string) => `sig=${first === '0' ? '1' : '0'}`)],
    ['whose object path was altered', (url) => url.replace(`/${TENANT_A.tenantId}/`, `/${TENANT_B.tenantId}/`)],
    ['whose disposition was dropped', (url) => url.replace(/&disposition=[^&]*/, '')],
  ])('answers 403 to a signed URL %s', async (_case, tamper) => {
    const { url } = await downloadUrl();
    const altered = tamper(url);
    expect(altered).not.toBe(url);
    const res = await t.app.inject({ url: altered });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN);
  });

  it('serves the signed URL through its last second and answers 403 once it has expired', async () => {
    const { url } = await downloadUrl();
    const expires = Number(new URL(url, BASE_URL).searchParams.get('expires'));
    nowMs = expires * 1000 + 999;
    expect((await t.app.inject({ url })).statusCode).toBe(200);
    nowMs = (expires + 1) * 1000;
    const res = await t.app.inject({ url });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN);
  });
});

describe('attachment Content-Type parameters', () => {
  const STORED_TYPE = 'text/plain; charset=utf-8';

  /** The fixture download of `typedRecord`'s attachment `attachmentId`. */
  async function fixtureDownload(attachmentId: string): Promise<Injected> {
    return t.app.inject({ url: `${FIXTURE_PREFIX}/records/${typedRecord.record_id}/attachments/${attachmentId}`, headers: await asApprover() });
  }

  /** The download of `typedRecord`'s attachment `attachmentId` through its /v1 signed URL. */
  async function signedDownload(attachmentId: string): Promise<Injected> {
    const res = await t.app.inject({
      url: `/v1/finance/records/${typedRecord.record_id}/attachments/${attachmentId}/download-url`,
      headers: await asApprover(),
    });
    expect(res.statusCode).toBe(200);
    return t.app.inject({ url: res.json<{ data: { url: string } }>().data.url });
  }

  // finance.cfc stores fileUpload's contentType/contentSubType, which keeps the part's parameters, lower-cased.
  it.each([
    ['fixture', 'text/plain; charset=utf-8', `${FIXTURE_PREFIX}/records/${typedRecord.record_id}/attachments`, fixtureDownload],
    ['/v1', 'Text/Plain; Charset=UTF-8', `/v1/finance/records/${typedRecord.record_id}/attachments`, signedDownload],
  ])('stores a %s upload sent as %s with its parameters and downloads it under that content type', async (_route, sent, url, download) => {
    const body = multipart('file', 'notes.txt', sent, CSV_BYTES);
    const res = await t.app.inject({ method: 'POST', url, headers: { ...(await asPreparer()), ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(200);
    const { attachment_id: attachmentId, content_type: contentType } = res.json<{ data: FixtureAttachment }>().data;
    expect(contentType).toBe(STORED_TYPE);
    expect(storedAttachment(attachmentId)?.content_type).toBe(STORED_TYPE);
    const key = attachmentObjectKey(TENANT_A.tenantId, attachmentId, 'notes.txt');
    expect((await t.storage.head(ATTACHMENT_BUCKET, key))?.contentType).toBe(STORED_TYPE);

    const file = await download(attachmentId);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe(STORED_TYPE);
    expect(file.rawPayload.equals(CSV_BYTES)).toBe(true);
  });
});

describe('migration apply of varbinary attachment bytes', () => {
  it('stores bytes whose sha256 matches as an object and keeps only its key on the row', async () => {
    const fixture = attachmentRow(migratedRecord, { fileName: 'scan.PDF', contentType: CONTENT_TYPE, bytes: MIGRATED_BYTES });
    const res = await applyAttachment('attachments-test-match', legacyAttachment(fixture));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ batchId: 'attachments-test-match', duplicate: false, applied: 1, skipped: 0 });

    const row = storedAttachment(fixture.row.attachment_id);
    expect(row).toMatchObject({
      record_id: migratedRecord.record_id,
      file_name: 'scan.PDF',
      content_type: CONTENT_TYPE,
      size_bytes: MIGRATED_BYTES.length,
      sha256: createHash('sha256').update(MIGRATED_BYTES).digest('hex'),
      legacy_program_id: 1,
    });
    expect(row).not.toHaveProperty(ATTACHMENT_CONTENT_FIELD);
    const [tenant, objectName = ''] = (row?.object_key ?? '').split('/');
    expect(tenant).toBe(TENANT_A.tenantId);
    expect(objectName.endsWith('.pdf')).toBe(true);
    expect(isCfUuid(objectName.slice(0, -'.pdf'.length))).toBe(true);
    expect((await t.storage.get(ATTACHMENT_BUCKET, row?.object_key ?? '')).equals(MIGRATED_BYTES)).toBe(true);

    const download = await t.app.inject({
      url: `${FIXTURE_PREFIX}/records/${migratedRecord.record_id}/attachments/${fixture.row.attachment_id}`,
      headers: await asApprover(),
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(MIGRATED_BYTES)).toBe(true);
  });

  it('refuses bytes whose sha256 differs from the row, storing no object, row or batch', async () => {
    const fixture = attachmentRow(migratedRecord, { fileName: 'scan.pdf', contentType: CONTENT_TYPE, bytes: MIGRATED_BYTES });
    const put = vi.spyOn(t.storage, 'put');
    const wrongSha = createHash('sha256').update('other bytes').digest('hex');
    const res = await applyAttachment('attachments-test-mismatch', { ...legacyAttachment(fixture), sha256: wrongSha });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Bad Request' } });
    expect(put).not.toHaveBeenCalled();
    expect(storedAttachment(fixture.row.attachment_id)).toBeUndefined();
    expect(t.db.rows('staged_object', TENANT_A.tenantId)).toEqual([]);

    const retried = await applyAttachment('attachments-test-mismatch', legacyAttachment(fixture));
    expect(retried.json()).toEqual({ batchId: 'attachments-test-mismatch', duplicate: false, applied: 1, skipped: 0 });
    expect(put).toHaveBeenCalledTimes(1);
  });
});
