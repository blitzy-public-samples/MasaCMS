// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/finance` routes through app.inject over a throwaway `finance` schema and the local storage adapter, each answer checked against the contract. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter, type StoragePort } from '@opt2/platform/storage';
import { tenantDbFromPool, tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, createThrowawaySchema, mintServiceToken, mintUserToken, pgAvailable, testVerifier, type ThrowawaySchema } from '@opt2/platform/testing';
import { createRecord, type FinanceActor, type FinanceDomainDeps, type RecordInput } from '../../src/domain/records.js';
import { recordRow } from '../../src/legacy/serialize.js';
import { createFinanceRepository } from '../../src/repo/repository.js';
import { UNITS, type FinanceRecordRow } from '../../src/repo/tables.js';
import { registerV1Routes } from '../../src/routes/v1.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const NOW_TEXT = '2026-06-30T12:00:00';
const HMAC_KEY = 'finance-v1-routes-test-hmac-key';
const PREPARER_ID = 'AAAAAAAA-1111-2222-3333444455556666';
const APPROVER_ID = 'BBBBBBBB-1111-2222-3333444455556666';
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const RECORDS = '/v1/finance/records';
const ROLLUPS = '/v1/finance/rollups';
// One site per concern, so record lists and rollups see only that test's records.
const SITE_LIST = 'v1-list';
const SITE_LIFECYCLE = 'v1-lifecycle';
const SITE_FILES = 'v1-files';
const SITE_OTHER = 'v1-other';
const SITE_UNBOUND = 'v1-unbound';
const PREPARER = { roles: [Roles.financePreparer], sub: PREPARER_ID } as const;
const APPROVER = { roles: [Roles.financeApprover], sub: APPROVER_ID } as const;

/** One gateway call; `roles: null` sends no user token. */
interface Call {
  site: string;
  roles?: readonly string[] | null;
  sub?: string;
  json?: unknown;
  /** One multipart part; `filename` makes it a file part. */
  part?: { name: string; filename?: string; type?: string; body: string };
}

/** An injected answer, its JSON body already validated against the contract. */
interface Answer {
  status: number;
  body: Record<string, any>;
  headers: Record<string, unknown>;
}

/** A multipart/form-data body holding `part` alone. */
function multipartBody(part: NonNullable<Call['part']>, boundary: string): Buffer {
  const disposition = `form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}`;
  const type = part.type === undefined ? '' : `Content-Type: ${part.type}\r\n`;
  return Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n${part.body}\r\n--${boundary}--\r\n`);
}

const available = await pgAvailable();

describe.skipIf(!available)('finance /v1 routes', () => {
  let handle: ThrowawaySchema;
  let stagingDb: TenantDb;
  let stateDir: string;
  let storage: LocalStorageAdapter;
  let app: FastifyInstance;

  /** Deps over the throwaway schema with `port` as attachment storage. */
  function depsWith(port: StoragePort): FinanceDomainDeps & { db: TenantDb } {
    const clock = fixedClock(NOW);
    return { db: handle.app, storage: port, clock, repository: createFinanceRepository({ db: handle.app, stagingDb, storage: port, clock }) };
  }

  /** A finance app carrying the write-position header and the `/v1` routes over `deps`. */
  async function v1App(deps: FinanceDomainDeps & { db: TenantDb }): Promise<FastifyInstance> {
    const built = await createService({
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
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('finance'),
      logger: createLogger({ service: 'finance', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerWritePositionHeader(built);
    await registerV1Routes(built, deps);
    await built.ready();
    return built;
  }

  async function bind(siteId: string, programId: number): Promise<void> {
    const tenantId = tenantIdForSite(siteId);
    await handle.app.withTenant(tenantId, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.program_binding (tenant_id, site_id, legacy_program_id, updated_at) VALUES ($1, $2, $3, $4)`, [
        tenantId,
        siteId,
        programId,
        NOW,
      ]),
    );
  }

  /** Creates a record of `siteId` through the domain and returns its id. */
  async function seed(siteId: string, input: RecordInput): Promise<string> {
    const actor: FinanceActor = { userId: PREPARER_ID, siteId };
    const { record } = await handle.app.withTenant(tenantIdForSite(siteId), (tx) => createRecord(tx, depsWith(storage), input, actor));
    return record.record_id;
  }

  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: UNITS, holderId: 'v1-routes-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'v1-routes-test', state });
  }

  /** Injects one gateway call and validates the answer against the contract. */
  async function call(method: 'GET' | 'POST', url: string, request: Call, target: FastifyInstance = app): Promise<Answer> {
    const { site, roles = PREPARER.roles, sub = PREPARER_ID } = request;
    const headers: Record<string, string> = {
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'finance' })}`,
    };
    if (roles !== null) headers.authorization = `Bearer ${await mintUserToken({ site, roles, sub })}`;
    let payload: string | Buffer | undefined;
    if (request.json !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(request.json);
    } else if (request.part !== undefined) {
      headers['content-type'] = 'multipart/form-data; boundary=v1routes';
      payload = multipartBody(request.part, 'v1routes');
    }
    const res = await target.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, any>, headers: res.headers };
  }

  /** The fixture error envelope `call` answers for `method`, `message` and the `invalid_request` code. */
  function fixtureError(method: string, message: string): Record<string, unknown> {
    return { apiversion: 'v1', method, error: { code: 'invalid_request', message } };
  }

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-finance-v1-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY, now: () => NOW.getTime() });
    handle = await createThrowawaySchema({ service: 'finance', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    stagingDb = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
    for (const [index, site] of [SITE_LIST, SITE_LIFECYCLE, SITE_FILES, SITE_OTHER].entries()) await bind(site, index + 1);
    app = await v1App(depsWith(storage));
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await setGates('open');
  });

  it('declares exactly the contract /v1 operations with their requires and transport', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/v1/'));
    expect(routes.map((route) => `${route.method} ${route.url}`)).toEqual([
      `GET ${RECORDS}`,
      `GET ${RECORDS}/:id`,
      `GET ${RECORDS}/:id/attachments`,
      `POST ${RECORDS}/:id/attachments`,
      `GET ${RECORDS}/:id/attachments/:aid/download-url`,
      `POST ${RECORDS}/:id/transitions/:action`,
      `GET ${RECORDS}/:id/versions`,
      `GET ${ROLLUPS}`,
    ]);
    for (const route of routes) {
      const operation = OPENAPI.paths[route.url.replace(/:(\w+)/g, '{$1}')]?.[route.method.toLowerCase()];
      expect([route.transport, route.requires]).toEqual([operation?.['x-opt2-transport'], operation?.['x-opt2-requires']]);
    }
  });

  describe('record list', () => {
    let ordered: string[];
    let june: string[];

    beforeAll(async () => {
      const office = await seed(SITE_LIST, { title: 'Office', amount: 12_500_000n, period: '2026-06' });
      const travel = await seed(SITE_LIST, { title: 'Travel', amount: 9_805_000n, period: '2026-06' });
      const licence = await seed(SITE_LIST, { title: 'Licence', amount: 3_157_500n, period: '2026-05' });
      // Records created at one instant are listed by id, as the fixture orders them.
      ordered = [office, travel, licence].sort();
      june = [office, travel].sort();
    });

    it('answers the first 50 records in fixture order with the count of all', async () => {
      const res = await call('GET', RECORDS, { site: SITE_LIST });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.data.map((row: { record_id: string }) => row.record_id)).toEqual(ordered);
      expect(res.body.data.find((row: { title: string }) => row.title === 'Office')).toMatchObject({
        siteid: SITE_LIST,
        amount: '1250.0000',
        state: 'IN-PROGRESS',
        version: 1,
        created: NOW_TEXT,
        createdbyid: PREPARER_ID,
        lastupdate: '',
        lastupdatebyid: '',
      });
    });

    it.each([
      ['page 2 of size 2', '?page=2&pageSize=2', () => ({ ids: [ordered[2]], total: 3 })],
      ['a period, paged', '?period=2026-06&pageSize=1&page=2', () => ({ ids: [june[1]], total: 2 })],
      ['a state with no records', '?state=APPROVED', () => ({ ids: [], total: 0 })],
      ['a state and a period', '?state=IN-PROGRESS&period=2026-05', () => ({ ids: [ordered.find((id) => !june.includes(id))], total: 1 })],
    ])('pages and filters: %s', async (_case, query, expected) => {
      const res = await call('GET', `${RECORDS}${query}`, { site: SITE_LIST, ...APPROVER });
      const { ids, total } = expected();
      expect([res.body.data.map((row: { record_id: string }) => row.record_id), res.body.total]).toEqual([ids, total]);
    });

    it.each(['?state=DONE', '?period=2026-13', '?page=0', '?pageSize=x'])('refuses the query %s as invalidParameters', async (query) => {
      expect((await call('GET', `${RECORDS}${query}`, { site: SITE_LIST })).status).toBe(400);
    });
  });

  it('runs the lifecycle with fixture errors, writes a version per action and rebuilds the rollups', async () => {
    const submitted = await seed(SITE_LIFECYCLE, { title: 'Travel', amount: 9_805_000n, period: '2026-06' });
    const edited = await seed(SITE_LIFECYCLE, { title: 'Office', amount: 12_500_000n, period: '2026-06' });
    const site = { site: SITE_LIFECYCLE };
    const transition = (id: string, action: string, request: Omit<Call, 'site'> = {}): Promise<Answer> =>
      call('POST', `${RECORDS}/${id}/transitions/${action}`, { ...site, ...request });

    const submit = await transition(submitted, 'submit');
    expect(submit.status).toBe(200);
    expect(submit.body.data).toMatchObject({ record_id: submitted, state: 'SUBMITTED', version: 2, lastupdate: NOW_TEXT, lastupdatebyid: PREPARER_ID });
    expect(submit.headers['x-opt2-write-position']).toMatch(/^finance=\d+$/);
    expect(await transition(submitted, 'approve')).toMatchObject({ status: 403, body: fixtureError('finance.records.approve', 'Insufficient Account Permissions') });
    expect(await transition(submitted, 'submit')).toMatchObject({ status: 409, body: fixtureError('finance.records.submit', 'illegalTransition') });
    expect((await transition(submitted, 'approve', APPROVER)).body.data).toMatchObject({ state: 'APPROVED', version: 3, lastupdatebyid: APPROVER_ID });

    // A JSON-number amount is refused as finance.cfc refuses a non-string amount; the record is checked before the fields.
    expect(await transition(edited, 'edit', { json: { title: 'Office', amount: 12, period: '2026-06' } })).toMatchObject({
      status: 400,
      body: fixtureError('finance.records.edit', 'Invalid parameters'),
    });
    expect((await transition(edited, 'edit')).status).toBe(400);
    expect(await transition(MISSING_ID, 'edit', { json: {} })).toMatchObject({ status: 404, body: fixtureError('finance.records.edit', 'Not Found') });
    expect((await transition(edited, 'archive')).status).toBe(400);
    const edit = await transition(edited, 'edit', { json: { title: 'Office v2', amount: ' 1000.5 ', period: '2026-07' } });
    expect(edit.body.data).toMatchObject({ title: 'Office v2', amount: '1000.5000', period: '2026-07', state: 'IN-PROGRESS', version: 2 });

    const versions = await call('GET', `${RECORDS}/${submitted}/versions`, { ...site, ...APPROVER });
    expect(versions.body.data.map((row: { version: number; action: string; state: string }) => [row.version, row.action, row.state])).toEqual([
      [1, 'create', 'IN-PROGRESS'],
      [2, 'submit', 'SUBMITTED'],
      [3, 'approve', 'APPROVED'],
    ]);
    const rollups = await call('GET', `${ROLLUPS}?asOf=2026-06-30`, site);
    expect(rollups.body.data).toEqual([
      { period: '2026-06', state: 'APPROVED', record_count: 1, total_amount: '980.5000', computed_at: NOW_TEXT },
      { period: '2026-07', state: 'IN-PROGRESS', record_count: 1, total_amount: '1000.5000', computed_at: NOW_TEXT },
    ]);
    expect((await call('GET', `${ROLLUPS}?asOf=30-06-2026`, site)).status).toBe(400);
  });

  it('uploads, lists and signs attachments, and embeds versions and attachments in the record detail', async () => {
    const id = await seed(SITE_FILES, { title: 'Receipts', amount: 3_157_500n, period: '2026-05' });
    const site = { site: SITE_FILES };
    const upload = await call('POST', `${RECORDS}/${id}/attachments`, {
      ...site,
      part: { name: 'file', filename: 'receipt.pdf', type: 'application/pdf', body: '%PDF-1' },
    });
    expect(upload.status).toBe(200);
    expect(upload.body.data).toMatchObject({
      record_id: id,
      file_name: 'receipt.pdf',
      content_type: 'application/pdf',
      size_bytes: 6,
      created: NOW_TEXT,
      createdbyid: PREPARER_ID,
    });
    expect(upload.headers['x-opt2-write-position']).toMatch(/^finance=\d+$/);
    const aid = upload.body.data.attachment_id as string;

    expect(await call('POST', `${RECORDS}/${id}/attachments`, { ...site, part: { name: 'file', body: 'a field, not a file' } })).toMatchObject({
      status: 400,
      body: fixtureError('finance.records.attachments', 'Invalid parameters'),
    });
    expect((await call('POST', `${RECORDS}/${MISSING_ID}/attachments`, { ...site, part: { name: 'other', body: 'x' } })).status).toBe(404);
    expect((await call('GET', `${RECORDS}/${id}/attachments`, site)).body.data).toEqual([upload.body.data]);

    const signed = await call('GET', `${RECORDS}/${id}/attachments/${aid}/download-url`, { ...site, ...APPROVER });
    const expires = NOW.getTime() / 1000 + 900;
    expect(signed.body.data.expiresAt).toBe(new Date(expires * 1000).toISOString());
    expect(signed.body.data.url).toMatch(
      new RegExp(`^/opt2/files/finance-attachments/${tenantIdForSite(SITE_FILES)}/${aid}\\.pdf\\?expires=${expires}&sig=[0-9a-f]{64}&disposition=`),
    );
    expect(storage.verifySignedUrl(signed.body.data.url as string, NOW.getTime())).toMatchObject({ ok: true, disposition: 'attachment; filename="receipt.pdf"' });
    const other = await seed(SITE_FILES, { title: 'Other', amount: 1n, period: '2026-05' });
    expect(await call('GET', `${RECORDS}/${other}/attachments/${aid}/download-url`, site)).toMatchObject({
      status: 404,
      body: fixtureError('finance.records.attachments', 'Not Found'),
    });

    const detail = await call('GET', `${RECORDS}/${id}`, site);
    const stored = await handle.app.withTenant(tenantIdForSite(SITE_FILES), async (tx) =>
      (await tx.query<FinanceRecordRow>(`SELECT * FROM ${handle.schema}.record WHERE record_id = $1`, [id])).rows,
    );
    expect(detail.body.data).toEqual({
      ...recordRow(stored[0] as FinanceRecordRow),
      versions: [expect.objectContaining({ record_id: id, version: 1, action: 'create' })],
      attachments: [upload.body.data],
    });
  });

  it.each([
    ['the record detail', `${RECORDS}/${MISSING_ID}`, 404, 'finance.records', 'Not Found'],
    ['the version list', `${RECORDS}/${MISSING_ID}/versions`, 404, 'finance.records.versions', 'Not Found'],
    ['the attachment list', `${RECORDS}/${MISSING_ID}/attachments`, 404, 'finance.records.attachments', 'Not Found'],
  ])('answers a missing record on %s with the fixture notFound', async (_case, url, status, method, message) => {
    expect(await call('GET', url, { site: SITE_OTHER })).toMatchObject({ status, body: fixtureError(method, message) });
  });

  it.each([
    ['the record list', RECORDS, 'finance.records'],
    ['the rollups', ROLLUPS, 'finance.rollups'],
  ])('answers a tenant without a program on %s with invalidParameters', async (_case, url, method) => {
    expect(await call('GET', url, { site: SITE_UNBOUND })).toMatchObject({ status: 400, body: fixtureError(method, 'Invalid parameters') });
  });

  it("keeps another tenant's records out of reach", async () => {
    const id = await seed(SITE_OTHER, { title: 'Private', amount: 1n, period: '2026-06' });
    expect((await call('GET', `${RECORDS}/${id}`, { site: SITE_LIST })).status).toBe(404);
    expect((await call('POST', `${RECORDS}/${id}/transitions/submit`, { site: SITE_LIST })).status).toBe(404);
  });

  it.each([
    ['an anonymous caller', `${RECORDS}`, 'GET', { roles: null }, 401],
    ['a member', `${RECORDS}`, 'GET', { roles: [Roles.member] }, 403],
    ['a system user', `${ROLLUPS}`, 'GET', { roles: [Roles.systemUser] }, 403],
    ['another site named in siteid', `${RECORDS}?siteid=${SITE_OTHER}`, 'GET', {}, 403],
    ['an approver uploading', `${RECORDS}/${MISSING_ID}/attachments`, 'POST', APPROVER, 403],
  ] as const)('refuses %s', async (_case, url, method, request, status) => {
    expect((await call(method, url, { site: SITE_LIST, ...request })).status).toBe(status);
  });

  it('fails a write closed with the legacy 503 while the target is not write-authoritative', async () => {
    const id = await seed(SITE_OTHER, { title: 'Closed', amount: 1n, period: '2026-06' });
    await setGates('legacy');
    const res = await call('POST', `${RECORDS}/${id}/transitions/submit`, { site: SITE_OTHER });
    expect(res).toMatchObject({ status: 503, body: { apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } } });
  });

  it('leaves errors it does not map to the service-kit handler', async () => {
    const id = await seed(SITE_OTHER, { title: 'Unstored', amount: 1n, period: '2026-06' });
    const failing: StoragePort = { ...storage, put: () => Promise.reject(new Error('disk gone')) };
    const failingApp = await v1App(depsWith(failing));
    try {
      const res = await call('POST', `${RECORDS}/${id}/attachments`, { site: SITE_OTHER, part: { name: 'file', filename: 'a.txt', body: 'a' } }, failingApp);
      expect(res).toMatchObject({ status: 500, body: { error: { code: 'server_error', message: 'Unhandled Exception' } } });
    } finally {
      await failingApp.opt2.shutdown();
    }
  });
});
