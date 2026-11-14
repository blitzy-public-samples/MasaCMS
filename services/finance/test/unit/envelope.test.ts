// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * Finance fixture wire bytes: serialized rows inside the envelope, and fixture responses through the app, against envelope.cfc respond().
 * The envelope helpers alone are covered by legacy-envelope.test.ts and the row projections alone by serialize.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_ADMIN_SENTINEL_ID, LEGACY_JSON_CONTENT_TYPE, cfHash, legacyHeaders } from '@opt2/platform/legacy-compat';
import { TRANSITION_ERROR_CODES } from '@opt2/platform/state-machine';
import { fixtureList, fixtureMethod, fixtureSuccess } from '../../src/legacy/envelope.js';
import * as wire from '../../src/legacy/serialize.js';
import type { FinanceRollupRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { attachmentRow, programBindingRow, recordRow, versionRow } from '../helpers/records.js';

const FX = '/legacy-fixtures/cfml/api.cfm/finance';
const RECORD_ID = '0A1B2C3D-4E5F-6A7B-8C9D0E1F2A3B4C5D';
const VERSION_ID = '11111111-2222-3333-4444555566667777';
const ATTACHMENT_ID = '99999999-8888-7777-6666555544443333';
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const ADMIN = LEGACY_ADMIN_SENTINEL_ID;
// envelope.cfc rows() renders TEST_CLOCK's local 2026-06-30 12:00:00 with mask yyyy-mm-dd'T'HH:nn:ss.
const STAMP = '2026-06-30T12:00:00';
const PDF = '%PDF-1.7';
const PDF_SHA256 = '86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b';

const RECORD = recordRow({ id: RECORD_ID, state: 'SUBMITTED', version: 2, amount: '1234.5000' });
const VERSION = { ...versionRow(RECORD, { action: 'submit', version: 2 }), version_id: VERSION_ID };
const ATTACHMENT = { ...attachmentRow(RECORD, { fileName: 'scan.pdf', contentType: 'application/pdf', bytes: PDF }).row, attachment_id: ATTACHMENT_ID };
const ROLLUP: FinanceRollupRow = {
  tenant_id: RECORD.tenant_id,
  period: '2026-06',
  state: 'SUBMITTED',
  record_count: 1,
  total_amount: '1234.5000',
  computed_at: TEST_CLOCK.now(),
  legacy_program_id: RECORD.legacy_program_id,
  row_version: '1',
};

// envelope.cfc hints version, size_bytes and record_count as integers; every other scalar, money included, serializes as a string.
const RECORD_JSON =
  `{"record_id":"${RECORD_ID}","siteid":"tenant-a","title":"Test record","amount":"1234.5000","period":"2026-06","state":"SUBMITTED",` +
  `"version":2,"created":"${STAMP}","createdbyid":"${ADMIN}","lastupdate":"${STAMP}","lastupdatebyid":"${ADMIN}"}`;
const VERSION_JSON =
  `{"version_id":"${VERSION_ID}","record_id":"${RECORD_ID}","version":2,"state":"SUBMITTED","title":"Test record","amount":"1234.5000",` +
  `"period":"2026-06","action":"submit","actor_user_id":"${ADMIN}","created":"${STAMP}"}`;
const ATTACHMENT_JSON =
  `{"attachment_id":"${ATTACHMENT_ID}","record_id":"${RECORD_ID}","file_name":"scan.pdf","content_type":"application/pdf","size_bytes":8,` +
  `"sha256":"${PDF_SHA256}","created":"${STAMP}","createdbyid":"${ADMIN}"}`;
const ROLLUP_JSON = `{"period":"2026-06","state":"SUBMITTED","record_count":1,"total_amount":"1234.5000","computed_at":"${STAMP}"}`;

const successBody = (method: string, data: string): string => `{"apiversion":"v1","method":"${method}","data":${data}}`;
const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;
/** `data` of envelope.cfc listResponse() for a single-row first page of 50. */
const onePage = (row: string): string =>
  `{"items":[${row}],"startindex":1,"endindex":1,"itemsperpage":50,"totalitems":1,"totalpages":1,"pageindex":1}`;

describe('serialized fixture rows in the envelope', () => {
  const params = { siteid: 'tenant-a' };

  it.each<[string, string, unknown, string]>([
    ['a record', fixtureMethod('records'), wire.recordRow(RECORD), RECORD_JSON],
    ['a version', fixtureMethod('records', 'versions'), wire.versionRow(VERSION), VERSION_JSON],
    ['attachment metadata', fixtureMethod('records', 'attachments', ATTACHMENT_ID), wire.attachmentRow(ATTACHMENT), ATTACHMENT_JSON],
    ['a stored rollup', fixtureMethod('rollups'), wire.rollupRow(ROLLUP), ROLLUP_JSON],
    [
      'a computed rollup',
      fixtureMethod('rollups'),
      wire.rollupRow({ period: '2026-06', state: 'SUBMITTED', recordCount: 1, totalAmount: 12_345_000n, computedAt: TEST_CLOCK.now() }),
      ROLLUP_JSON,
    ],
  ])('writes %s byte for byte as envelope.cfc does: lower-case keys, hinted integers, other scalars as strings', (_label, method, data, json) => {
    const res = fixtureSuccess({ method, params }, data);

    expect(res.body).toBe(successBody(method, json));
    expect(res.headers).toStrictEqual({ 'Content-Type': LEGACY_JSON_CONTENT_TYPE, ETag: cfHash(successBody(method, json)) });
  });

  it('nests wire rows in a list page unchanged', () => {
    const method = fixtureMethod('records');
    const res = fixtureList({ method, params }, [wire.recordRow(RECORD)], { total: 1, pageIndex: 1, itemsPerPage: 50 });

    expect(res.body).toBe(successBody(method, onePage(RECORD_JSON)));
  });
});

describe('fixture responses through the app', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp({
      seed: {
        program_binding: [programBindingRow('tenant-a')],
        record: [RECORD],
        record_version: [VERSION],
        attachment: [ATTACHMENT],
        rollup: [ROLLUP],
      },
    });
  });

  afterEach(async () => {
    await t.app.close();
  });

  /** A request to the finance fixture module as a tenant-a user holding `roles`, or with no credential at all. */
  async function send(method: 'GET' | 'POST', url: string, roles?: readonly string[]): Promise<Awaited<ReturnType<TestApp['app']['inject']>>> {
    const headers = roles === undefined ? {} : await headersFor({ roles }, { site: 'tenant-a' });
    return t.app.inject({ method, url: `${FX}${url}`, headers });
  }

  /** Asserts the status, exact body and the wire headers legacy sends with an envelope.cfc response. */
  function expectWire(res: Awaited<ReturnType<typeof send>>, status: number, body: string): void {
    expect([res.statusCode, res.body]).toEqual([status, body]);
    const { generator, 'strict-transport-security': hsts } = res.headers;
    expect({ Generator: generator, 'Strict-Transport-Security': hsts }).toStrictEqual(legacyHeaders());
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.headers.etag).toBe(cfHash(res.body));
  }

  it.each<[string, string, string, string]>([
    ['a record', `/records/${RECORD_ID}`, 'finance.records', RECORD_JSON],
    ['a record page', '/records', 'finance.records', onePage(RECORD_JSON)],
    ['a version page', `/records/${RECORD_ID}/versions`, 'finance.records.versions', onePage(VERSION_JSON)],
    ['an attachment metadata page', `/records/${RECORD_ID}/attachments`, 'finance.records.attachments', onePage(ATTACHMENT_JSON)],
    ['a rollup page', '/rollups', 'finance.rollups', onePage(ROLLUP_JSON)],
  ])('answers %s with the fixture success bytes and legacy headers', async (_label, url, method, data) => {
    expectWire(await send('GET', url, ['finance.preparer']), 200, successBody(method, data));
  });

  it.each<[string, () => Promise<Awaited<ReturnType<typeof send>>>, number, string, string, string]>([
    ['no credential as authorization', () => send('GET', '/records'), 401, 'finance.records', 'invalid_request', 'Insufficient Account Permissions'],
    [
      'a role the transition row excludes as forbidden',
      () => send('POST', `/records/${RECORD_ID}/approve`, ['finance.preparer']),
      403,
      'finance.records.approve',
      'invalid_request',
      'Insufficient Account Permissions',
    ],
    [
      'an action the state has no row for as conflict',
      () => send('POST', `/records/${RECORD_ID}/resubmit`, ['finance.preparer']),
      409,
      'finance.records.resubmit',
      'invalid_request',
      TRANSITION_ERROR_CODES.illegal,
    ],
    ['an unknown record as notFound', () => send('GET', `/records/${MISSING_ID}`, ['finance.approver']), 404, 'finance.records', 'invalid_request', 'Not Found'],
    [
      'a zero page size as invalidParameters',
      () => send('GET', '/records?itemsPerPage=0', ['finance.approver']),
      400,
      'finance.records',
      'invalid_request',
      'Invalid parameters',
    ],
  ])('answers %s in the fixture error envelope with legacy headers', async (_label, request, status, method, code, message) => {
    expectWire(await request(), status, errorBody(method, code, message));
  });

  it('answers an unexpected failure as server_error with legacy headers', async () => {
    t.db.failNext(/"record" WHERE "record_id" = \$1$/, new Error('boom'));

    expectWire(await send('GET', `/records/${RECORD_ID}`, ['finance.preparer']), 500, errorBody('finance.records', 'server_error', 'Unhandled Exception'));
  });
});
