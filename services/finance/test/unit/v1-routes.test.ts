// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1` and `/v2` finance routes through app.inject over a throwaway `finance` schema, the local storage adapter and an identity CSRF double, each answer checked against the contract. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger, validateLogRecord } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  createService,
  fixedClock,
  loadEnv,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
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
const V2_RECORDS = '/v2/finance/records';
const V2_ROLLUPS = '/v2/finance/rollups';
// One site per concern, so record lists and rollups see only that test's records.
const SITE_LIST = 'v1-list';
const SITE_LIFECYCLE = 'v1-lifecycle';
const SITE_FILES = 'v1-files';
const SITE_OTHER = 'v1-other';
const SITE_UNBOUND = 'v1-unbound';
const PREPARER = { roles: [Roles.financePreparer], sub: PREPARER_ID } as const;
const SESSION_ID = '0F1E2D3C-4B5A-6978-8796A5B4C3D2E1F0';
const CSRF_EXPIRES = '260630120000123';
const APPROVER = { roles: [Roles.financeApprover], sub: APPROVER_ID } as const;

/** One gateway call; `roles: null` sends no user token. */
interface Call {
  site: string;
  roles?: readonly string[] | null;
  sub?: string;
  json?: unknown;
  /** One multipart part; `filename` makes it a file part. */
  part?: { name: string; filename?: string; type?: string; body: string };
  /** CSRF request headers; a POST otherwise sends a fresh pair issued for the record id in its path. */
  csrf?: Readonly<Record<string, string>>;
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

describe.skipIf(!available)('finance /v1 and /v2 routes', () => {
  let handle: ThrowawaySchema;
  let stagingDb: TenantDb;
  let stateDir: string;
  let storage: LocalStorageAdapter;
  let app: FastifyInstance;
  /** Context identity issued each token for; a token is valid for that context alone. */
  const issued = new Map<string, string>();
  /** `token context` keys identity has consumed in the test session. */
  const consumed = new Set<string>();
  /** Every consume call the routes made, in order. */
  const consumeCalls: CsrfConsumeRequest[] = [];
  let identityStatus = 200;
  /** Every line the apps' loggers wrote, parsed. */
  const logLines: Array<Record<string, unknown>> = [];

  /** Identity's consume verdict: valid once per token and context, for the context the token was issued for. */
  function consume(request: ServiceRequest): ServiceResponse {
    if (request.service !== IDENTITY_SERVICE || request.method !== 'POST' || request.path !== CSRF_CONSUME_PATH) {
      throw new Error(`the finance /v1 routes call no other service: ${request.method} ${request.service} ${request.path}`);
    }
    const call = request.json as CsrfConsumeRequest;
    consumeCalls.push(call);
    const key = `${call.token} ${call.context}`;
    const valid = identityStatus === 200 && call.sessionId === SESSION_ID && issued.get(call.token) === call.context && !consumed.has(key);
    if (valid) consumed.add(key);
    return { status: identityStatus, headers: {}, body: identityStatus === 200 ? { valid } : undefined };
  }

  /** A fresh CSRF pair identity issued for `context`, as the record screen renders one per form. */
  function issueCsrf(context: string): Record<string, string> {
    const token = `V1ROUTES${String(issued.size + 1).padStart(24, '0')}`;
    issued.set(token, context);
    return { 'x-csrf_token': token, 'x-csrf_token_expires': CSRF_EXPIRES };
  }

  /** The `{id}` segment of a `/v1/finance/records/{id}/…` path as sent; '' for any other path. */
  function recordIdOf(url: string): string {
    return new URL(url, 'http://finance.test').pathname.split('/')[4] ?? '';
  }

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
      logger: createLogger({
        service: 'finance',
        version: '1.0.0',
        env: 'local',
        destination: { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) },
      }),
    });
    registerWritePositionHeader(built);
    await registerV1Routes(built, deps);
    await built.ready();
    vi.spyOn(built.opt2.client, 'request').mockImplementation((request: ServiceRequest) => Promise.resolve(consume(request)));
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
      ...(request.csrf ?? (method === 'POST' ? issueCsrf(recordIdOf(url)) : {})),
    };
    if (roles !== null) headers.authorization = `Bearer ${await mintUserToken({ site, roles, sub, sid: SESSION_ID })}`;
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
    consumeCalls.length = 0;
    identityStatus = 200;
  });

  it('declares exactly the contract /v1 and /v2 operations with their requires and transport', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => /^\/v[12]\//.test(route.url));
    expect(routes.map((route) => `${route.method} ${route.url}`)).toEqual([
      `GET ${RECORDS}`,
      `GET ${RECORDS}/:id`,
      `GET ${RECORDS}/:id/attachments`,
      `POST ${RECORDS}/:id/attachments`,
      `GET ${RECORDS}/:id/attachments/:aid/download-url`,
      `POST ${RECORDS}/:id/transitions/:action`,
      `GET ${RECORDS}/:id/versions`,
      `GET ${ROLLUPS}`,
      `GET ${V2_RECORDS}/:id`,
      `GET ${V2_RECORDS}/:id/attachments`,
      `GET ${V2_RECORDS}/:id/versions`,
      `GET ${V2_ROLLUPS}`,
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

  describe('complete /v1 lists and paged /v2 lists', () => {
    const SITE_PAGED = 'v1-paged';
    const DEFAULT_PAGE_SIZE = 50;
    const ROWS = DEFAULT_PAGE_SIZE + 1;
    const site = { site: SITE_PAGED };
    let id: string;

    /** The first `count` periods from 2022-01, in order. */
    const periods = (count: number): string[] =>
      Array.from({ length: count }, (_, n) => `${2022 + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`);

    /** Inserts `count` rollup rows of `siteId`'s program `programId`, one per period of `periods(count)`. */
    async function seedRollups(siteId: string, programId: number, count: number): Promise<void> {
      await handle.app.withTenant(tenantIdForSite(siteId), (tx) =>
        tx.query(
          `INSERT INTO ${handle.schema}.rollup (tenant_id, period, state, record_count, total_amount, computed_at, legacy_program_id)
           SELECT $1, to_char(date '2022-01-01' + (n - 1) * interval '1 month', 'YYYY-MM'), 'IN-PROGRESS', n, n, $2, $3
           FROM generate_series(1, $4::integer) AS n`,
          [tx.tenantId, NOW, programId, count],
        ),
      );
    }

    /** Each list: its `/v1` and `/v2` URL, its row key, and the keys of all its rows in order. */
    const LISTS: [string, () => string, () => string, (row: Record<string, any>) => unknown, () => unknown[]][] = [
      [
        'versions',
        () => `${RECORDS}/${id}/versions`,
        () => `${V2_RECORDS}/${id}/versions`,
        (row) => row.version,
        () => Array.from({ length: ROWS }, (_, n) => n + 1),
      ],
      [
        'attachments',
        () => `${RECORDS}/${id}/attachments`,
        () => `${V2_RECORDS}/${id}/attachments`,
        (row) => row.file_name,
        () => Array.from({ length: ROWS }, (_, n) => `f${n + 1}.pdf`),
      ],
      ['rollups', () => ROLLUPS, () => V2_ROLLUPS, (row) => row.period, () => periods(ROWS)],
    ];

    beforeAll(async () => {
      await setGates('open');
      await bind(SITE_PAGED, 5);
      id = await seed(SITE_PAGED, { title: 'History', amount: 1n, period: '2026-06' });
      await seedRollups(SITE_PAGED, 5, ROWS);
      await handle.app.withTenant(tenantIdForSite(SITE_PAGED), async (tx) => {
        const params = [tx.tenantId, id, PREPARER_ID, NOW, ROWS];
        await tx.query(
          `INSERT INTO ${handle.schema}.record_version (tenant_id, version_id, record_id, version, state, title, amount, period, action, actor_user_id, created, legacy_program_id)
           SELECT $1, 'EEEEEEEE-0000-0000-' || lpad(n::text, 16, '0'), $2, n, 'IN-PROGRESS', 'History', 1, '2026-06', 'edit', $3, $4, 5
           FROM generate_series(2, $5::integer) AS n`,
          params,
        );
        await tx.query(
          `INSERT INTO ${handle.schema}.attachment (tenant_id, attachment_id, record_id, file_name, content_type, size_bytes, sha256, object_key, created, createdbyid, legacy_program_id)
           SELECT $1, 'DDDDDDDD-0000-0000-' || lpad(n::text, 16, '0'), $2, 'f' || n || '.pdf', 'application/pdf', 1, repeat('a', 64), 'k-' || n,
                  $4::timestamp + n * interval '1 second', $3, 5
           FROM generate_series(1, $5::integer) AS n`,
          params,
        );
      });
    });

    it.each(LISTS)('answers every one of the %s on /v1 without a count, whatever page is asked', async (_case, v1, v2, key, keys) => {
      const complete = await call('GET', v1(), site);
      expect([complete.status, Object.keys(complete.body), complete.body.data.map(key)]).toEqual([200, ['data'], keys()]);
      expect((await call('GET', `${v1()}?page=2&pageSize=1`, site)).body).toEqual(complete.body);
      expect((await call('GET', `${v2()}?pageSize=1000`, site)).body).toEqual({ ...complete.body, total: ROWS });
    });

    it('embeds every version and attachment in the /v1 detail', async () => {
      const detail = (await call('GET', `${RECORDS}/${id}`, site)).body.data;
      const versions = (await call('GET', `${RECORDS}/${id}/versions`, site)).body.data;
      const attachments = (await call('GET', `${RECORDS}/${id}/attachments`, site)).body.data;
      expect([detail.versions.length, detail.attachments.length]).toEqual([ROWS, ROWS]);
      expect([detail.versions, detail.attachments]).toEqual([versions, attachments]);
      expect(Object.keys(detail).filter((field) => field.endsWith('_total'))).toEqual([]);
    });

    it('embeds the first page of versions and of attachments in the /v2 detail, with the count of each', async () => {
      const complete = (await call('GET', `${RECORDS}/${id}`, site)).body.data;
      const res = await call('GET', `${V2_RECORDS}/${id}`, site);
      expect([res.status, res.body.data]).toEqual([
        200,
        {
          ...complete,
          versions: complete.versions.slice(0, DEFAULT_PAGE_SIZE),
          versions_total: ROWS,
          attachments: complete.attachments.slice(0, DEFAULT_PAGE_SIZE),
          attachments_total: ROWS,
        },
      ]);
    });

    it.each(LISTS)('pages the %s on /v2 with the count of all, and answers an empty page past the end', async (_case, _v1, v2, key, keys) => {
      const page = async (query: string): Promise<Record<string, any>> => (await call('GET', `${v2()}${query}`, site)).body;
      const all = (await page('?pageSize=1000')).data as Record<string, any>[];
      expect(all.map(key)).toEqual(keys());
      expect(await page('')).toEqual({ data: all.slice(0, DEFAULT_PAGE_SIZE), total: ROWS });
      expect(await page('?page=2')).toEqual({ data: [all[DEFAULT_PAGE_SIZE]], total: ROWS });
      expect(await page('?page=2&pageSize=2')).toEqual({ data: all.slice(2, 4), total: ROWS });
      expect(await page('?page=3')).toEqual({ data: [], total: ROWS });
    });

    it.each(
      ['?pageSize=1001', '?page=0'].flatMap((query) =>
        [`${V2_RECORDS}/${MISSING_ID}/versions`, `${V2_RECORDS}/${MISSING_ID}/attachments`, V2_ROLLUPS].map((url) => `${url}${query}`),
      ),
    )('refuses %s as invalidParameters', async (url) => {
      expect((await call('GET', url, site)).status).toBe(400);
    });

    it('answers a /v1 record list page above the /v2 page size maximum', async () => {
      const res = await call('GET', `${RECORDS}?pageSize=1001`, site);
      expect([res.status, res.body.data.map((row: { record_id: string }) => row.record_id), res.body.total]).toEqual([200, [id], 1]);
    });

    it('answers every /v1 rollup past the 1000-row scan page', async () => {
      const SITE_SCAN = 'v1-scan';
      const SCAN_ROWS = 1001;
      await bind(SITE_SCAN, 7);
      await seedRollups(SITE_SCAN, 7, SCAN_ROWS);
      const complete = (await call('GET', ROLLUPS, { site: SITE_SCAN })).body.data as Record<string, any>[];
      expect(complete.map((row) => row.period)).toEqual(periods(SCAN_ROWS));
      const last = await call('GET', `${V2_ROLLUPS}?page=2&pageSize=1000`, { site: SITE_SCAN });
      expect(last.body).toEqual({ data: complete.slice(1000), total: SCAN_ROWS });
    });
  });

  describe('lowercase-spelled ids', () => {
    const SITE_CASE = 'v1-case';
    const site = { site: SITE_CASE };
    let id: string;
    let aid: string;

    beforeAll(async () => {
      await setGates('open');
      await bind(SITE_CASE, 6);
      id = await seed(SITE_CASE, { title: 'Case', amount: 1n, period: '2026-06' });
      const upload = await call('POST', `${RECORDS}/${id}/attachments`, { ...site, part: { name: 'file', filename: 'a.pdf', body: '%PDF' } });
      aid = upload.body.data.attachment_id as string;
    });

    it.each([
      ['the record detail', (record: string) => `${RECORDS}/${record}`],
      ['the version list', (record: string) => `${RECORDS}/${record}/versions`],
      ['the attachment list', (record: string) => `${RECORDS}/${record}/attachments`],
      ['a download URL', (record: string, attachment: string) => `${RECORDS}/${record}/attachments/${attachment}/download-url`],
      ['the /v2 record detail', (record: string) => `${V2_RECORDS}/${record}`],
      ['the /v2 version list', (record: string) => `${V2_RECORDS}/${record}/versions`],
      ['the /v2 attachment list', (record: string) => `${V2_RECORDS}/${record}/attachments`],
    ])('reads %s as the stored upper-case ids answer it', async (_case, url) => {
      const lower = await call('GET', url(id.toLowerCase(), aid.toLowerCase()), site);
      const stored = await call('GET', url(id, aid), site);
      expect([lower.status, stored.status]).toEqual([200, 200]);
      expect(lower.body).toEqual(stored.body);
    });

    it('uploads to and transitions the stored record', async () => {
      const upload = await call('POST', `${RECORDS}/${id.toLowerCase()}/attachments`, { ...site, part: { name: 'file', filename: 'b.pdf', body: '%PDF' } });
      expect([upload.status, upload.body.data.record_id]).toEqual([200, id]);
      const submit = await call('POST', `${RECORDS}/${id.toLowerCase()}/transitions/submit`, site);
      expect([submit.status, submit.body.data]).toEqual([200, expect.objectContaining({ record_id: id, state: 'SUBMITTED', version: 2 })]);
    });
  });

  it.each([
    ['the record detail', `${RECORDS}/${MISSING_ID}`, 404, 'finance.records', 'Not Found'],
    ['the version list', `${RECORDS}/${MISSING_ID}/versions`, 404, 'finance.records.versions', 'Not Found'],
    ['the attachment list', `${RECORDS}/${MISSING_ID}/attachments`, 404, 'finance.records.attachments', 'Not Found'],
    ['the /v2 record detail', `${V2_RECORDS}/${MISSING_ID}`, 404, 'finance.records', 'Not Found'],
    ['the /v2 version list', `${V2_RECORDS}/${MISSING_ID}/versions`, 404, 'finance.records.versions', 'Not Found'],
    ['the /v2 attachment list', `${V2_RECORDS}/${MISSING_ID}/attachments`, 404, 'finance.records.attachments', 'Not Found'],
  ])('answers a missing record on %s with the fixture notFound', async (_case, url, status, method, message) => {
    expect(await call('GET', url, { site: SITE_OTHER })).toMatchObject({ status, body: fixtureError(method, message) });
  });

  it.each([
    ['the record list', RECORDS, 'finance.records'],
    ['the rollups', ROLLUPS, 'finance.rollups'],
    ['the /v2 rollups', V2_ROLLUPS, 'finance.rollups'],
  ])('answers a tenant without a program on %s with invalidParameters', async (_case, url, method) => {
    expect(await call('GET', url, { site: SITE_UNBOUND })).toMatchObject({ status: 400, body: fixtureError(method, 'Invalid parameters') });
  });

  it("keeps another tenant's records out of reach", async () => {
    const id = await seed(SITE_OTHER, { title: 'Private', amount: 1n, period: '2026-06' });
    expect((await call('GET', `${RECORDS}/${id}`, { site: SITE_LIST })).status).toBe(404);
    expect((await call('GET', `${V2_RECORDS}/${id}`, { site: SITE_LIST })).status).toBe(404);
    expect((await call('POST', `${RECORDS}/${id}/transitions/submit`, { site: SITE_LIST })).status).toBe(404);
  });

  it.each([
    ['an anonymous caller', `${RECORDS}`, 'GET', { roles: null }, 401],
    ['a member', `${RECORDS}`, 'GET', { roles: [Roles.member] }, 403],
    ['a system user', `${ROLLUPS}`, 'GET', { roles: [Roles.systemUser] }, 403],
    ['another site named in siteid', `${RECORDS}?siteid=${SITE_OTHER}`, 'GET', {}, 403],
    ['an approver uploading', `${RECORDS}/${MISSING_ID}/attachments`, 'POST', APPROVER, 403],
  ] as const)('refuses %s before any CSRF token is consumed', async (_case, url, method, request, status) => {
    expect((await call(method, url, { site: SITE_LIST, ...request })).status).toBe(status);
    expect(consumeCalls).toEqual([]);
  });

  describe('a reporting exporter', () => {
    const SITE_EXPORT = 'v1-export';
    const EXPORTER = { roles: [Roles.reportingExporter], sub: 'CCCCCCCC-1111-2222-3333444455556666' } as const;
    let june: string;
    let may: string;

    beforeAll(async () => {
      await bind(SITE_EXPORT, 9);
      june = await seed(SITE_EXPORT, { title: 'Travel', amount: 9_805_000n, period: '2026-06' });
      may = await seed(SITE_EXPORT, { title: 'Licence', amount: 3_157_500n, period: '2026-05' });
    });

    it.each([
      ['every record', '?page=1&pageSize=1000', () => ({ ids: [june, may].sort(), total: 2 })],
      ['a state and a period', '?state=IN-PROGRESS&period=2026-06', () => ({ ids: [june], total: 1 })],
    ])('lists records for its export: %s', async (_case, query, expected) => {
      const res = await call('GET', `${RECORDS}${query}`, { site: SITE_EXPORT, ...EXPORTER });
      const { ids, total } = expected();
      expect([res.status, res.body.data.map((row: { record_id: string }) => row.record_id), res.body.total]).toEqual([200, ids, total]);
    });

    it.each([
      ['the record detail', 'GET', (id: string) => `${RECORDS}/${id}`],
      ['the version list', 'GET', (id: string) => `${RECORDS}/${id}/versions`],
      ['the attachment list', 'GET', (id: string) => `${RECORDS}/${id}/attachments`],
      ['a download URL', 'GET', (id: string) => `${RECORDS}/${id}/attachments/${MISSING_ID}/download-url`],
      ['the rollups', 'GET', () => `${ROLLUPS}?asOf=2026-06-30`],
      ['the /v2 record detail', 'GET', (id: string) => `${V2_RECORDS}/${id}`],
      ['the /v2 version list', 'GET', (id: string) => `${V2_RECORDS}/${id}/versions`],
      ['the /v2 attachment list', 'GET', (id: string) => `${V2_RECORDS}/${id}/attachments`],
      ['the /v2 rollups', 'GET', () => `${V2_ROLLUPS}?asOf=2026-06-30`],
      ['a transition', 'POST', (id: string) => `${RECORDS}/${id}/transitions/submit`],
    ] as const)('refuses it %s', async (_case, method, url) => {
      expect((await call(method, url(may), { site: SITE_EXPORT, ...EXPORTER })).status).toBe(403);
      expect(consumeCalls).toEqual([]);
    });
  });

  it('fails a write closed with the legacy 503 while the target is not write-authoritative', async () => {
    const id = await seed(SITE_OTHER, { title: 'Closed', amount: 1n, period: '2026-06' });
    await setGates('legacy');
    const res = await call('POST', `${RECORDS}/${id}/transitions/submit`, { site: SITE_OTHER });
    expect(res).toMatchObject({ status: 503, body: { apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } } });
  });

  it('answers a content type longer than its fixture column with server_error, storing nothing', async () => {
    const id = await seed(SITE_OTHER, { title: 'Overlong type', amount: 1n, period: '2026-06' });
    const part = { name: 'file', filename: 'a.txt', type: `text/${'x'.repeat(96)}`, body: 'a' };
    expect(await call('POST', `${RECORDS}/${id}/attachments`, { site: SITE_OTHER, part })).toMatchObject({
      status: 500,
      body: { error: { code: 'server_error', message: 'Unhandled Exception' } },
    });
    expect((await call('GET', `${RECORDS}/${id}/attachments`, { site: SITE_OTHER })).body.data).toEqual([]);
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

  describe('CSRF of the /v1 writes', () => {
    const SITE_CSRF = 'v1-csrf';
    const site = { site: SITE_CSRF };
    const PART = { name: 'file', filename: 'c.pdf', type: 'application/pdf', body: '%PDF' };

    /** Each write: its path tail, the envelope method of its refusals, and its request body. */
    const WRITES = [
      ['a transition', '/transitions/submit', 'finance.records.submit', {}],
      ['an upload', '/attachments', 'finance.records.attachments', { part: PART }],
    ] as const;

    /** The record's state, version and attachment count, read back through the routes. */
    async function stateOf(id: string): Promise<[string, number, number]> {
      const detail = (await call('GET', `${RECORDS}/${id}`, site)).body.data;
      return [detail.state, detail.version, detail.attachments.length];
    }

    beforeAll(async () => {
      await setGates('open');
      await bind(SITE_CSRF, 8);
    });

    it.each(WRITES)("has identity consume the pair of %s for the record id as sent, in the token's session", async (_case, tail, _method, body) => {
      const id = await seed(SITE_CSRF, { title: 'Consumed', amount: 1n, period: '2026-06' });
      const csrf = issueCsrf(id.toLowerCase());

      const res = await call('POST', `${RECORDS}/${id.toLowerCase()}${tail}`, { ...site, ...body, csrf });

      expect(res.status).toBe(200);
      expect(consumeCalls).toEqual([{ sessionId: SESSION_ID, token: csrf['x-csrf_token'], expires: CSRF_EXPIRES, context: id.toLowerCase() }]);
    });

    it.each(
      WRITES.flatMap(([write, ...rest]) =>
        (
          [
            ['no token', () => ({}), 0],
            ['a token without its expiry', () => ({ 'x-csrf_token': issueCsrf('')['x-csrf_token'] ?? '' }), 0],
            ["another record's token", () => issueCsrf(MISSING_ID), 1],
          ] as const
        ).map(([token, csrf, calls]) => [token, write, ...rest, csrf, calls] as const),
      ),
    )('answers %s on %s with invalidTokens, writing nothing', async (_token, _case, tail, method, body, csrf, calls) => {
      const id = await seed(SITE_CSRF, { title: 'Refused', amount: 1n, period: '2026-06' });

      const res = await call('POST', `${RECORDS}/${id}${tail}`, { ...site, ...body, csrf: csrf() });

      expect(res).toMatchObject({ status: 400, body: fixtureError(method, 'Invalid CSRF tokens') });
      expect(consumeCalls).toHaveLength(calls);
      expect(await stateOf(id)).toEqual(['IN-PROGRESS', 1, 0]);
    });

    it('accepts a token once and answers its replay with invalidTokens, writing one version', async () => {
      const id = await seed(SITE_CSRF, { title: 'Replayed', amount: 1n, period: '2026-06' });
      const csrf = issueCsrf(id);
      const edit = (): Promise<Answer> =>
        call('POST', `${RECORDS}/${id}/transitions/edit`, { ...site, csrf, json: { title: 'Replayed v2', amount: '2', period: '2026-06' } });

      const first = await edit();
      const replay = await edit();

      expect([first.status, replay.status]).toEqual([200, 400]);
      expect(replay.body).toEqual(fixtureError('finance.records.edit', 'Invalid CSRF tokens'));
      expect(await stateOf(id)).toEqual(['IN-PROGRESS', 2, 0]);
    });

    it.each(WRITES)('answers %s with the legacy 503 and writes nothing when identity cannot consume the token', async (_case, tail, _method, body) => {
      const id = await seed(SITE_CSRF, { title: 'Unavailable', amount: 1n, period: '2026-06' });
      identityStatus = 503;

      const res = await call('POST', `${RECORDS}/${id}${tail}`, { ...site, ...body });

      expect(res.status).toBe(503);
      identityStatus = 200;
      expect(await stateOf(id)).toEqual(['IN-PROGRESS', 1, 0]);
    });

    it('consumes no CSRF token on a read, even one sent with it', async () => {
      const id = await seed(SITE_CSRF, { title: 'Read', amount: 1n, period: '2026-06' });

      expect((await call('GET', `${RECORDS}/${id}`, { ...site, csrf: issueCsrf(id) })).status).toBe(200);
      expect(consumeCalls).toEqual([]);
    });
  });

  describe('outcome log lines', () => {
    const SITE_LOG = 'v1-log';
    const site = { site: SITE_LOG };
    const transition = (id: string, action: string, request: Omit<Call, 'site'> = {}): Promise<Answer> =>
      call('POST', `${RECORDS}/${id}/transitions/${action}`, { ...site, ...request });

    beforeAll(async () => {
      await setGates('open');
      await bind(SITE_LOG, 10);
    });

    it.each<[string, (id: string) => Promise<Answer>, number, string | null]>([
      ['a write without a CSRF token', (id) => transition(id, 'submit', { csrf: {} }), 400, 'request rejected: invalidTokens'],
      ['a role that may not take the action', (id) => transition(id, 'submit', APPROVER), 403, 'request denied: forbidden'],
      ['an illegal transition', (id) => transition(id, 'resubmit'), 409, null],
      [
        'an edit whose amount is not a string',
        (id) => transition(id, 'edit', { json: { title: 'reason-probe', amount: 12, period: '2026-06' } }),
        400,
        'request rejected: invalidParameters',
      ],
      [
        'an edited title PostgreSQL cannot store',
        (id) => transition(id, 'edit', { json: { title: 'reason-probe\u0000title', amount: '2', period: '2026-06' } }),
        400,
        'request rejected: 22021',
      ],
      ['a page outside the query schema', () => call('GET', `${V2_ROLLUPS}?page=0`, site), 400, 'request rejected: FST_ERR_VALIDATION'],
      ['a tenant without a program', () => call('GET', RECORDS, { site: SITE_UNBOUND }), 400, 'request rejected: invalidParameters'],
      ['no credential', () => call('GET', RECORDS, { ...site, roles: null }), 401, 'request denied: missing-credential'],
      ['another site named in siteid', () => call('GET', `${RECORDS}?siteid=${SITE_OTHER}`, site), 403, 'request denied: site-mismatch'],
      ['an unknown record', () => call('GET', `${RECORDS}/${MISSING_ID}`, site), 404, null],
    ])('logs %s with its fixed reason, if any, ahead of the completion line, writing nothing', async (_case, send, status, warning) => {
      const id = await seed(SITE_LOG, { title: 'Logged', amount: 1n, period: '2026-06' });
      const before = logLines.length;

      const res = await send(id);
      const lines = logLines.slice(before);

      expect(res.status).toBe(status);
      expect(lines.filter(({ severity, message }) => severity === 'WARNING' || message === 'request completed').map(({ severity, message }) => [severity, message])).toStrictEqual([
        ...(warning === null ? [] : [['WARNING', warning]]),
        ['INFO', 'request completed'],
      ]);
      expect(lines.filter(({ severity }) => severity === 'ERROR')).toEqual([]);
      for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
      expect(JSON.stringify(lines)).not.toMatch(/reason-probe|invalid byte sequence|0x00/);
      const detail = (await call('GET', `${RECORDS}/${id}`, site)).body.data;
      expect([detail.state, detail.version]).toEqual(['IN-PROGRESS', 1]);
    });
  });
});
