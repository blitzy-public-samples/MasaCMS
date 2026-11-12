// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance fixture routes through `app.inject` against a throwaway `finance` schema, compared with legacy-fixtures/cfml/modules/finance.cfc. */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { cfHash } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import { tenantDbFromPool, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createFinanceRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX, registerFixtureRoutes } from '../../src/routes/fixture.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const P = FIXTURE_PREFIX;
const PREPARER = [Roles.systemUser, Roles.financePreparer];
const APPROVER = [Roles.systemUser, Roles.financeApprover];
const BOTH = [Roles.financePreparer, Roles.financeApprover];
const USER_ID = '11111111-2222-3333-4444555566667777';
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const GOOD_TOKEN = 'VALIDCSRFTOKEN';
const CSRF = { 'x-csrf_token': GOOD_TOKEN, 'x-csrf_token_expires': '991231235959000' };
const VALID = { title: 'Q2 travel', amount: '1250.5', period: '2026-06' };
const FILE_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x0d]);
const BOUNDARY = 'opt2finance';

const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

const available = await pgAvailable();

describe.skipIf(!available)('finance fixture routes', () => {
  let handle: ThrowawaySchema;
  let stagingDb: TenantDb;
  let storage: LocalStorageAdapter;
  let stateDir: string;
  let identity: http.Server;
  let app: FastifyInstance;
  const consumed: Array<{ sessionId: string; token: string; context: string }> = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'finance', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    stagingDb = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
    await seedRegistry(handle.app);
    for (const [site, programId] of [
      [TENANT_A, 1],
      [TENANT_B, 2],
    ] as const) {
      await handle.app.withTenant(site.tenantId, (tx) =>
        tx.query(`INSERT INTO ${handle.schema}.program_binding (tenant_id, site_id, legacy_program_id, updated_at) VALUES ($1, $2, $3, $4)`, [
          site.tenantId,
          site.siteId,
          programId,
          NOW,
        ]),
      );
    }
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-finance-fixture-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'finance-fixture-test-hmac-key' });
    identity = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const consume = JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof consumed)[number];
        consumed.push(consume);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ valid: consume.token === GOOD_TOKEN }));
      });
    });
    await new Promise<void>((resolve) => identity.listen(0, '127.0.0.1', resolve));
    app = await createService({
      name: 'finance',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8119',
        OPT2_SERVICE_NAME: 'finance',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        OPT2_SERVICE_URLS: JSON.stringify({ identity: `http://127.0.0.1:${(identity.address() as AddressInfo).port}` }),
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('finance'),
      pool: handle.app,
      logger: createLogger({ service: 'finance', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerWritePositionHeader(app);
    const clock = fixedClock(NOW);
    const repository = createFinanceRepository({ db: handle.app, stagingDb, storage, clock });
    await registerFixtureRoutes(app, { db: handle.app, repository, storage, clock });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await new Promise((resolve) => identity?.close(resolve));
    await stagingDb?.end();
    await handle?.drop();
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Moves every finance gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: UNITS, holderId: 'fixture-routes-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'fixture-routes-test', state });
  }

  beforeEach(async () => {
    consumed.length = 0;
    await setGates('open');
  });

  /** A user token for `roles` on `site` plus the gateway's invocation credential. */
  async function headersFor(roles: readonly string[], site: string = TENANT_A.siteId): Promise<Record<string, string>> {
    const [token, invocation] = await Promise.all([
      mintUserToken({ sub: USER_ID, site, roles }),
      mintServiceToken({ caller: 'gateway', audience: 'finance' }),
    ]);
    return { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
  }

  /** A JSON-body POST as `roles`, with a valid CSRF token unless `csrf` is false. */
  async function post(url: string, roles: readonly string[], payload?: Record<string, unknown>, csrf = true): Promise<Injected> {
    const headers = { ...(await headersFor(roles)), ...(csrf ? CSRF : {}) };
    return app.inject({ method: 'POST', url: `${P}${url}`, headers, ...(payload === undefined ? {} : { payload }) });
  }

  /** A GET as `roles`. */
  async function get(url: string, roles: readonly string[] = APPROVER): Promise<Injected> {
    return app.inject({ url: `${P}${url}`, headers: await headersFor(roles) });
  }

  /** A record created by a preparer; returns its fixture row. */
  async function createRecord(): Promise<{ record_id: string; version: number }> {
    const res = await post('/records', PREPARER, VALID);
    expect(res.statusCode).toBe(200);
    return res.json().data;
  }

  /** A multipart body with one part named `field`. */
  function multipart(field: string, fileName?: string): Buffer {
    const disposition = fileName === undefined ? `name="${field}"` : `name="${field}"; filename="${fileName}"`;
    return Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; ${disposition}\r\nContent-Type: application/pdf\r\n\r\n`),
      fileName === undefined ? Buffer.from('not a file') : FILE_BYTES,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
  }

  /** Uploads a multipart body to record `id` as a preparer. */
  async function upload(id: string, body: Buffer): Promise<Injected> {
    const headers = { ...(await headersFor(PREPARER)), ...CSRF, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
    return app.inject({ method: 'POST', url: `${P}/records/${id}/attachments`, headers, payload: body });
  }

  it('declares the nine contract routes with the fixture role sets on the service transport, site-checked', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith(P));
    expect(routes.map(({ method, url, requires, transport, siteCheck }) => [method, url.slice(P.length), requires, transport, siteCheck])).toEqual([
      ['GET', '/records', BOTH, 'service', true],
      ['POST', '/records', [Roles.financePreparer], 'service', true],
      ['GET', '/records/:id', BOTH, 'service', true],
      ['POST', '/records/:id/:action', BOTH, 'service', true],
      ['GET', '/records/:id/attachments', BOTH, 'service', true],
      ['POST', '/records/:id/attachments', [Roles.financePreparer], 'service', true],
      ['GET', '/records/:id/attachments/:aid', BOTH, 'service', true],
      ['GET', '/records/:id/versions', BOTH, 'service', true],
      ['GET', '/rollups', BOTH, 'service', true],
    ]);
  });

  it.each<[string, () => Promise<Injected>, number, string]>([
    ['no credential', () => app.inject({ url: `${P}/records` }), 401, errorBody('finance.records', 'invalid_request', 'Insufficient Account Permissions')],
    [
      'a role-less user on a lifecycle action',
      async () => app.inject({ method: 'POST', url: `${P}/records/${MISSING_ID}/Submit`, headers: await headersFor([Roles.member]) }),
      403,
      errorBody('finance.records.submit', 'invalid_request', 'Insufficient Account Permissions'),
    ],
    ['an approver creating a record', () => post('/records', APPROVER, VALID), 403, errorBody('finance.records', 'invalid_request', 'Insufficient Account Permissions')],
    [
      'a siteid other than the token site',
      () => get(`/rollups?siteid=${TENANT_B.siteId}`),
      403,
      errorBody('finance.rollups', 'invalid_request', 'Insufficient Account Permissions'),
    ],
    [
      'a role-less user of an unregistered site',
      async () => app.inject({ url: `${P}/records`, headers: await headersFor([Roles.member], 'retired-site') }),
      400,
      errorBody('finance.records', 'invalid_request', 'Invalid parameters'),
    ],
  ])('answers %s in the fixture error envelope', async (_case, send, status, body) => {
    const res = await send();
    expect([res.statusCode, res.body]).toEqual([status, body]);
    expect(res.headers.etag).toBe(cfHash(res.body));
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
  });

  it('answers a rejected user token with its invalid_token envelope and bearer challenge', async () => {
    const invocation = (await headersFor(PREPARER))[INVOCATION_HEADER] ?? '';
    const res = await app.inject({ url: `${P}/records`, headers: { authorization: 'Bearer not-a-token', [INVOCATION_HEADER]: invocation } });
    expect([res.statusCode, res.json()]).toEqual([401, { apiversion: 'v1', method: 'finance.records', error: { code: 'invalid_token', message: 'Invalid Access Token' } }]);
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_access_token"');
  });

  it.each<[string, (id: string) => Promise<Injected>, number, string, string]>([
    ['path: an unknown action', (id) => post(`/records/${id}/archive`, PREPARER), 404, 'finance.records.archive', 'Not Found'],
    ['path: a POST to versions', (id) => post(`/records/${id}/versions`, PREPARER), 404, 'finance.records.versions', 'Not Found'],
    [
      'site: an unregistered token site',
      async () => app.inject({ url: `${P}/records`, headers: await headersFor(PREPARER, 'retired-site') }),
      400,
      'finance.records',
      'Invalid parameters',
    ],
    [
      'site: a site without a program',
      async () => app.inject({ url: `${P}/rollups`, headers: await headersFor(APPROVER, TENANT_UMBRELLA.siteId) }),
      400,
      'finance.rollups',
      'Invalid parameters',
    ],
    ['csrf: a write without a token', (id) => post(`/records/${id}/submit`, PREPARER, undefined, false), 400, 'finance.records.submit', 'Invalid CSRF tokens'],
    ['existence: an unknown record', () => get(`/records/${MISSING_ID}/versions`), 404, 'finance.records.versions', 'Not Found'],
    ['existence: an unknown attachment', (id) => get(`/records/${id}/attachments/${MISSING_ID}`), 404, 'finance.records.attachments', 'Not Found'],
    ['validation: an edit missing fields', (id) => post(`/records/${id}/edit`, PREPARER, { title: 'Only a title' }), 400, 'finance.records.edit', 'Invalid parameters'],
    ['validation: a JSON number amount', () => post('/records', PREPARER, { ...VALID, amount: 1250.5 }), 400, 'finance.records', 'Invalid parameters'],
    ['validation: a part that is not a file', (id) => upload(id, multipart('file')), 400, 'finance.records.attachments', 'Invalid parameters'],
    ['validation: a zero page size', (id) => get(`/records/${id}/attachments?itemsPerPage=0`), 400, 'finance.records.attachments', 'Invalid parameters'],
    ['validation: a page size over 1000', () => get('/records?itemsPerPage=1001'), 400, 'finance.records', 'Invalid parameters'],
    ['validation: a decimal page index', () => get('/rollups?pageIndex=1.5'), 400, 'finance.rollups', 'Invalid parameters'],
    ['validation: non-ASCII digits outside the bounds', () => get('/records?itemsPerPage=%D9%A1'), 400, 'finance.records', 'Invalid parameters'],
    ['validation: non-ASCII digits inside the bounds', () => get('/records?pageIndex=1%D9%A1'), 500, 'finance.records', 'Unhandled Exception'],
    ['state: an illegal transition', (id) => post(`/records/${id}/resubmit`, PREPARER), 409, 'finance.records.resubmit', 'illegalTransition'],
    ['state: a role that may not take the action', (id) => post(`/records/${id}/submit`, APPROVER), 403, 'finance.records.submit', 'Insufficient Account Permissions'],
  ])('fails on %s alone, leaving the record unchanged', async (_case, send, status, method, message) => {
    const { record_id: id } = await createRecord();
    const res = await send(id);
    expect([res.statusCode, res.json()]).toEqual([status, { apiversion: 'v1', method, error: { code: status === 500 ? 'server_error' : 'invalid_request', message } }]);
    const after = (await get(`/records/${id}`)).json().data;
    expect([after.state, after.version]).toEqual(['IN-PROGRESS', 1]);
  });

  it('creates, reads, edits and moves a record through its lifecycle with one version row each, rebuilding the rollup', async () => {
    const created = await post('/records', PREPARER, VALID);
    expect(created.json()).toMatchObject({ method: 'finance.records', data: { siteid: 'tenant-a', amount: '1250.5000', state: 'IN-PROGRESS', version: 1 } });
    expect(created.headers['x-opt2-write-position']).toMatch(/^finance=\d+$/);
    const id: string = created.json().data.record_id;

    const read = await get(`/records/${id.toLowerCase()}%20`);
    expect([read.statusCode, read.json().method, read.json().data]).toEqual([200, 'finance.records', created.json().data]);

    const edit = await post(`/records/${id}/edit`, PREPARER, { ...VALID, title: 'Q2 travel, revised', amount: '99.99' });
    expect(edit.json().data).toMatchObject({ title: 'Q2 travel, revised', amount: '99.9900', state: 'IN-PROGRESS', version: 2 });
    const submit = await post(`/records/${id}/SUBMIT`, PREPARER);
    expect([submit.statusCode, submit.json().method, submit.json().data.state]).toEqual([200, 'finance.records.submit', 'SUBMITTED']);
    const approve = await post(`/records/${id}/approve`, APPROVER);
    expect(approve.json().data).toMatchObject({ state: 'APPROVED', version: 4, lastupdatebyid: USER_ID, lastupdate: '2026-06-30T10:00:00' });

    const versions = await get(`/records/${id}/versions?pageIndex=2&itemsPerPage=3`);
    expect(versions.json()).toMatchObject({
      method: 'finance.records.versions',
      data: { startindex: 4, endindex: 4, itemsperpage: 3, totalitems: 4, totalpages: 2, pageindex: 2 },
    });
    expect(versions.json().data.items.map(({ version, action }: { version: number; action: string }) => [version, action])).toEqual([[4, 'approve']]);

    const records = await get('/records?itemsPerPage=1000');
    expect(records.json().data.items.find((row: { record_id: string }) => row.record_id === id)).toMatchObject({ state: 'APPROVED' });
    const rollups = await get('/rollups');
    expect(rollups.json().method).toBe('finance.rollups');
    expect(rollups.json().data.items).toContainEqual({ period: '2026-06', state: 'APPROVED', record_count: 1, total_amount: '99.9900', computed_at: '2026-06-30T10:00:00' });
  });

  it('reads record fields from a form body and has identity consume each write token for the route id as sent', async () => {
    const form = await app.inject({
      method: 'POST',
      url: `${P}/records`,
      headers: { ...(await headersFor(PREPARER)), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `title=Form&amount=-1.25&period=2026-07&csrf_token=${GOOD_TOKEN}&csrf_token_expires=991231235959000`,
    });
    expect([form.statusCode, form.json().data.amount]).toEqual([200, '-1.2500']);
    const id: string = form.json().data.record_id;
    expect((await post(`/records/${id.toLowerCase()}/submit`, PREPARER)).statusCode).toBe(200);
    expect(consumed.map(({ token, context }) => [token, context])).toEqual([
      [GOOD_TOKEN, ''],
      [GOOD_TOKEN, id.toLowerCase()],
    ]);
    expect(consumed.every(({ sessionId }) => sessionId.length > 0)).toBe(true);
  });

  it('stores the multipart file part, lists its metadata and downloads its bytes exactly', async () => {
    const { record_id: id } = await createRecord();
    const stored = await upload(id, multipart('FILE', 'scan é.pdf'));
    expect(stored.json()).toMatchObject({
      method: 'finance.records.attachments',
      data: { record_id: id, file_name: 'scan é.pdf', content_type: 'application/pdf', size_bytes: FILE_BYTES.length },
    });
    const attachmentId: string = stored.json().data.attachment_id;

    const listed = await get(`/records/${id}/attachments`);
    expect(listed.json().data).toMatchObject({ items: [stored.json().data], totalitems: 1 });

    const file = await get(`/records/${id}/attachments/${attachmentId.toLowerCase()}`, PREPARER);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(FILE_BYTES)).toBe(true);
    expect(file.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': String(FILE_BYTES.length),
      'content-disposition': `attachment; filename="scan _.pdf"; filename*=UTF-8''scan%20%C3%A9.pdf`,
    });
    expect(file.headers.etag).toBeUndefined();
  });

  it('fails a write closed with the legacy 503 while the finance units are legacy-authoritative', async () => {
    const { record_id: id } = await createRecord();
    await setGates('legacy');
    const res = await post(`/records/${id}/submit`, PREPARER);
    expect(res.statusCode).toBe(503);
    expect(res.json().method).not.toBe('finance.records.submit');
    await setGates('open');
    expect((await get(`/records/${id}`)).json().data.state).toBe('IN-PROGRESS');
  });
});
