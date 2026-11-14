// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting fixture routes through `app.inject` against a throwaway `reporting` schema, compared with legacy-fixtures/cfml/modules/reporting.cfc. */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { cfHash, cfUuid } from '@opt2/platform/legacy-compat';
import { REDACTED, createLogger, validateLogRecord } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import { TENANT_A, TENANT_B, createThrowawaySchema, mintServiceToken, mintUserToken, pgAvailable, seedRegistry, testVerifier, type ThrowawaySchema } from '@opt2/platform/testing';
import type { EnqueueExportRun, ReportingDeps } from '../../src/domain/deps.js';
import { FIXTURE_PREFIX, registerFixtureRoutes } from '../../src/legacy/index.js';
import { definitionRow, jobRow } from '../../src/legacy/serialize.js';
import { createReportingRepository } from '../../src/repo/repository.js';
import { EXPORT_BUCKET, EXPORT_JOB, EXPORT_STATES, UNITS, exportObjectKey, type ExportJobRow, type ExportState } from '../../src/repo/tables.js';
import { definitionFor, jobFor } from '../helpers/fixtures.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const P = `${FIXTURE_PREFIX}/exports`;
const EXPORTER = [Roles.systemUser, Roles.reportingExporter];
const USER_ID = '11111111-2222-3333-4444555566667777';
const SESSION_ID = 'fixture-routes-session';
const GOOD_TOKEN = 'VALIDCSRFTOKEN';
const CSRF = { 'x-csrf_token': GOOD_TOKEN, 'x-csrf_token_expires': '991231235959000' };
const OUTPUT = Buffer.from('a,b\r\n1,2\r\n');

const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

/** reporting.cfc `jobColumns`, named as envelope.cfc `rows()` lower-cases them. */
const JOB_KEYS = ['job_id', 'siteid', 'definition_id', 'format', 'state', 'requested_by_id', 'created', 'started_at', 'finished_at', 'error', 'file_name', 'content_type', 'output_sha256'];
/** envelope.cfc `listResponse` data keys, in the order it sets them. */
const LIST_KEYS = ['items', 'startindex', 'endindex', 'itemsperpage', 'totalitems', 'totalpages', 'pageindex'];
/** The test clock's instant in envelope.cfc's `yyyy-mm-dd'T'HH:nn:ss` mask. */
const CLOCK_TEXT = '2026-06-30T12:00:00';
const JOB_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';

// An unset PG_HOST skips the route suite without probing the server; the projection cases need no database.
const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe('fixture row projections', () => {
  const definition = definitionFor(TENANT_A, 'timesheets.sheets');

  it.each<[ExportState, string, string, string, string, string]>([
    ['queued', '', '', '', '', ''],
    ['running', CLOCK_TEXT, '', '', '', ''],
    ['done', CLOCK_TEXT, CLOCK_TEXT, '', `export-${JOB_ID}.csv`, 'text/csv'],
    ['failed', CLOCK_TEXT, CLOCK_TEXT, 'export-failed', '', ''],
  ])('projects a %s job onto the jobColumns in select order, NULL as an empty string', (state, startedAt, finishedAt, error, fileName, contentType) => {
    const row = jobFor(definition, { format: 'csv', state, jobId: JOB_ID });
    const projected = jobRow(row);
    expect(Object.keys(projected)).toStrictEqual(JOB_KEYS);
    expect(projected).toStrictEqual({
      job_id: JOB_ID,
      siteid: TENANT_A.siteId,
      definition_id: definition.definition_id,
      format: 'csv',
      state,
      requested_by_id: row.requested_by_id,
      created: CLOCK_TEXT,
      started_at: startedAt,
      finished_at: finishedAt,
      error,
      file_name: fileName,
      content_type: contentType,
      output_sha256: row.output_sha256 ?? '',
    });
  });

  it('renders a timestamp to the second in the process zone, as the fixture mask drops milliseconds', () => {
    const row = jobFor(definition, { format: 'pdf', state: 'running', at: new Date(2026, 0, 2, 3, 4, 5, 987) });
    expect(jobRow(row)).toMatchObject({ created: '2026-01-02T03:04:05', started_at: '2026-01-02T03:04:05', finished_at: '' });
  });

  it.each(['["record_id","title"]', 'record_id,title'])('projects a definition onto its catalog columns, keeping the columns text %j as stored', (columns) => {
    const row = definitionFor(TENANT_B, 'finance.records', { columns });
    const projected = definitionRow(row);
    expect(Object.keys(projected)).toStrictEqual(['definition_id', 'siteid', 'name', 'source', 'columns']);
    expect(projected).toStrictEqual({ definition_id: row.definition_id, siteid: TENANT_B.siteId, name: 'Finance records', source: 'finance.records', columns });
  });
});

describe.skipIf(!available)('reporting fixture routes', () => {
  let handle: ThrowawaySchema;
  let storage: LocalStorageAdapter;
  let stateDir: string;
  let identity: http.Server;
  let app: FastifyInstance;
  const enqueued: Parameters<EnqueueExportRun>[0][] = [];
  const consumed: Array<{ context: string; token: string }> = [];
  let failEnqueue = false;
  const defs: Record<string, string> = {};
  const errorSpies: { mock: { calls: unknown[][] } }[] = [];
  const logLines: string[] = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await seedRegistry(handle.app);
    for (const site of [TENANT_A, TENANT_B]) {
      const id = cfUuid();
      defs[site.siteId] = id;
      await handle.app.withTenant(site.tenantId, (tx) =>
        tx.query(
          `INSERT INTO ${handle.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns) VALUES ($1, $2, $3, 'Sheets', 'timesheets.sheets', '["a"]')`,
          [site.tenantId, id, site.siteId],
        ),
      );
    }
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-fixture-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'reporting-fixture-test-hmac-key' });
    identity = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { context: string; token: string };
        consumed.push(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ valid: body.token === GOOD_TOKEN }));
      });
    });
    await new Promise<void>((resolve) => identity.listen(0, '127.0.0.1', resolve));
    app = await createService({
      name: 'reporting',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '21216',
        OPT2_SERVICE_NAME: 'reporting',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        OPT2_SERVICE_URLS: JSON.stringify({ identity: `http://127.0.0.1:${(identity.address() as AddressInfo).port}` }),
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('reporting'),
      pool: handle.app,
      logger: createLogger({ service: 'reporting', version: '1.0.0', env: 'local', destination: { write: (line: string) => void logLines.push(line) } }),
    });
    app.addHook('onRequest', async (request) => {
      errorSpies.push(vi.spyOn(request.log, 'error'));
    });
    const clock = fixedClock(NOW);
    const repository = createReportingRepository({ db: handle.app, storage, clock });
    const deps: ReportingDeps = {
      db: handle.app,
      repository,
      storage,
      clock,
      client: app.opt2.client,
      enqueue: async (input) => {
        if (failEnqueue) throw new Error('queue down');
        enqueued.push(input);
      },
      runScheduled: () => Promise.resolve(true),
    };
    await registerFixtureRoutes(app, deps);
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await new Promise((resolve) => identity?.close(resolve));
    await handle?.drop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  /** Moves every reporting gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: UNITS, holderId: 'fixture-routes-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'fixture-routes-test', state });
  }

  beforeEach(async () => {
    enqueued.length = 0;
    consumed.length = 0;
    failEnqueue = false;
    await setGates('open');
  });

  /** A user token of session SESSION_ID for `roles` on `site` plus the gateway's invocation credential. */
  async function headers(roles: readonly string[] = EXPORTER, site: string = TENANT_A.siteId): Promise<Record<string, string>> {
    const [token, inv] = await Promise.all([
      mintUserToken({ sub: USER_ID, site, roles, sid: SESSION_ID }),
      mintServiceToken({ caller: 'gateway', audience: 'reporting' }),
    ]);
    return { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: `Bearer ${inv}` };
  }

  /** The token identity mints for an active session without a login on `site` (sub '', no roles) plus the gateway's invocation credential. */
  async function anonymousHeaders(site: string = TENANT_A.siteId): Promise<Record<string, string>> {
    const [token, inv] = await Promise.all([
      mintUserToken({ sub: '', site, roles: [], sid: SESSION_ID }),
      mintServiceToken({ caller: 'gateway', audience: 'reporting' }),
    ]);
    return { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: `Bearer ${inv}` };
  }

  /** A JSON-body create as an exporter of tenant-a, with a valid CSRF token unless `extra` replaces it. */
  async function create(payload: Record<string, unknown>, extra: Record<string, string> = CSRF) {
    return app.inject({ method: 'POST', url: P, headers: { ...(await headers()), ...extra }, payload });
  }

  /** Asserts the envelope's ETag is the legacy hash of its exact body. */
  function expectEtag(res: { headers: Record<string, unknown>; body: string }): void {
    expect(res.headers.etag).toBe(cfHash(res.body));
  }

  /** Stores a done csv job of `site` with its output object; returns the job id. */
  async function storeDone(site = TENANT_A, fileName?: string): Promise<string> {
    const jobId = cfUuid();
    const key = exportObjectKey(site.tenantId, jobId, 'csv');
    await storage.put(EXPORT_BUCKET, key, OUTPUT, { contentType: 'text/csv' });
    const sha = createHash('sha256').update(OUTPUT).digest('hex');
    await handle.app.withTenant(site.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.export_job (tenant_id, job_id, siteid, definition_id, format, state, requested_by_id, created, started_at, finished_at, file_name, content_type, object_key, output_sha256)
         VALUES ($1,$2,$3,$4,'csv','done',$5,$6,$6,$6,$7,'text/csv',$8,$9)`,
        [site.tenantId, jobId, site.siteId, defs[site.siteId], USER_ID, NOW, fileName ?? `export-${jobId}.csv`, key, sha],
      ),
    );
    return jobId;
  }

  /** The seeded definition of `site` as a row `jobFor` builds jobs of. */
  function definitionOf(site = TENANT_A) {
    return definitionFor(site, 'timesheets.sheets', { definition_id: defs[site.siteId] as string });
  }

  /** Stores `row` with every `export_job` column as given. */
  async function storeJob(row: ExportJobRow): Promise<void> {
    const names = EXPORT_JOB.columns.map(({ name }) => name as keyof ExportJobRow);
    await handle.app.withTenant(row.tenant_id, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.export_job (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        names.map((name) => row[name]),
      ),
    );
  }

  it('declares the six routes, every path for GET and POST, with the contract annotations', () => {
    const routes = collectRouteMatrix(app).routes.filter((r) => r.url.startsWith(FIXTURE_PREFIX));
    expect(routes.map(({ method, url, requires, transport, siteCheck }) => [method, url.slice(FIXTURE_PREFIX.length), requires, transport, siteCheck])).toEqual(
      expect.arrayContaining([
        ['GET', '/exports', [Roles.reportingExporter], 'service', false],
        ['POST', '/exports', [Roles.reportingExporter], 'service', false],
        ['GET', '/exports/:id', [Roles.reportingExporter], 'service', false],
        ['POST', '/exports/:id', [Roles.reportingExporter], 'service', false],
        ['GET', '/exports/:id/download', [Roles.reportingExporter], 'service', false],
        ['POST', '/exports/:id/download', [Roles.reportingExporter], 'service', false],
      ]),
    );
    expect(routes).toHaveLength(6);
  });

  it('answers anonymous with the 401 fixture envelope', async () => {
    const res = await app.inject({ url: P });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(errorBody('reporting.exports', 'invalid_request', 'Insufficient Account Permissions'));
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expectEtag(res);
  });

  it('answers a user without reporting.exporter with 403 forbidden', async () => {
    const res = await app.inject({ url: `${P}/ABC/download`, headers: await headers([Roles.systemUser]) });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe(errorBody('reporting.exports.download', 'invalid_request', 'Insufficient Account Permissions'));
    expectEtag(res);
  });

  it('answers an invalid token with the bearer challenge', async () => {
    const res = await app.inject({ url: P, headers: { authorization: 'Bearer nope', [INVOCATION_HEADER]: (await headers())[INVOCATION_HEADER] as string } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeDefined();
  });

  const DENIED_ROUTES: ReadonlyArray<readonly [string, 'GET' | 'POST', string]> = [
    ['list', 'GET', P],
    ['detail', 'GET', `${P}/${JOB_ID}`],
    ['create', 'POST', P],
  ];
  const DENIALS: ReadonlyArray<readonly [string, () => Promise<Record<string, string>>, string, number, string]> = [
    ['an anonymous session', () => anonymousHeaders(), '', 401, 'Insufficient Account Permissions'],
    ['an anonymous session naming an unregistered siteid', () => anonymousHeaders(), '?siteid=nosuchsite', 400, 'Invalid parameters'],
    ['an unregistered token site', () => headers([], 'nosuchsite'), '', 400, 'Invalid parameters'],
    ['an unregistered token site naming it as siteid', () => headers([], 'nosuchsite'), '?siteid=nosuchsite', 400, 'Invalid parameters'],
    ['a no-role user naming an unregistered siteid', () => headers([Roles.systemUser]), '?siteid=nosuchsite', 400, 'Invalid parameters'],
    ['a no-role user', () => headers([Roles.systemUser]), '', 403, 'Insufficient Account Permissions'],
    ['a tenant-b exporter naming tenant-a', () => headers(EXPORTER, TENANT_B.siteId), `?siteid=${TENANT_A.siteId}`, 403, 'Insufficient Account Permissions'],
  ];

  it.each(DENIED_ROUTES.flatMap(([route, method, url]) => DENIALS.map(([who, credentials, query, status, message]) => [route, who, method, url, credentials, query, status, message] as const)))(
    'answers the %s route for %s as the fixture does, consuming no token and queueing nothing',
    async (_route, _who, method, url, credentials, query, status, message) => {
      const res = await app.inject({
        method,
        url: `${url}${query}`,
        headers: { ...(await credentials()), ...CSRF },
        ...(method === 'POST' ? { payload: { definitionId: defs[TENANT_A.siteId], format: 'csv' } } : {}),
      });
      expect(res.statusCode).toBe(status);
      expect(res.body).toBe(errorBody('reporting.exports', 'invalid_request', message));
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expectEtag(res);
      expect([consumed.length, enqueued.length]).toStrictEqual([0, 0]);
    },
  );

  it("creates a queued job whose run task carries neither the requester's session nor a token", async () => {
    const res = await create({ definitionId: defs[TENANT_A.siteId], format: 'csv', asOf: '2026-06-30' });
    expect(res.statusCode).toBe(200);
    expectEtag(res);
    const data = res.json().data;
    expect(data).toMatchObject({ siteid: 'tenant-a', definition_id: defs[TENANT_A.siteId], format: 'csv', state: 'queued', requested_by_id: USER_ID, started_at: '', error: '' });
    expect(res.json().method).toBe('reporting.exports');
    expect(enqueued).toHaveLength(1);
    const { job_id: jobId } = res.json<{ data: { job_id: string } }>().data;
    expect(enqueued[0]?.payload).toStrictEqual({ jobId, asOf: '2026-06-30' });
    expect(consumed).toEqual([expect.objectContaining({ context: '', token: GOOD_TOKEN })]);
  });

  it('treats a JSON null asOf as today', async () => {
    const res = await create({ definitionId: defs[TENANT_A.siteId], format: 'pdf', asOf: null });
    expect(res.statusCode).toBe(200);
    expect(enqueued[0]?.payload.asOf).toBe('2026-06-30');
  });

  it('creates a queued job of the stored definition for a lower-case definitionId, as SQL Server matches char(35)', async () => {
    const stored = defs[TENANT_A.siteId] as string;
    const res = await create({ definitionId: stored.toLowerCase(), format: 'csv' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ siteid: 'tenant-a', definition_id: stored, format: 'csv', state: 'queued' });
    expect(enqueued).toHaveLength(1);
  });

  it.each<[string, (def: string) => Record<string, unknown>, number, string]>([
    ['missing definition', () => ({ format: 'csv' }), 404, 'Not Found'],
    ['foreign definition', () => ({ definitionId: 'x', format: 'xlsx' }), 404, 'Not Found'],
    ['bad format', (def) => ({ definitionId: def, format: 'doc' }), 400, 'Invalid parameters'],
    ['missing format', (def) => ({ definitionId: def }), 400, 'Invalid parameters'],
    ['bad asOf', (def) => ({ definitionId: def, format: 'csv', asOf: '2026-02-30' }), 400, 'Invalid parameters'],
    ['empty asOf', (def) => ({ definitionId: def, format: 'csv', asOf: '' }), 400, 'Invalid parameters'],
  ])('rejects create with %s', async (_name, build, status, message) => {
    const res = await create(build(defs[TENANT_A.siteId] as string));
    expect(res.statusCode).toBe(status);
    expect(res.body).toBe(errorBody('reporting.exports', 'invalid_request', message));
    expect(enqueued).toHaveLength(0);
  });

  it('rejects create without a valid CSRF token', async () => {
    const res = await create({ definitionId: defs[TENANT_A.siteId], format: 'csv' }, { 'x-csrf_token': 'BAD', 'x-csrf_token_expires': '1' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe(errorBody('reporting.exports', 'invalid_request', 'Invalid CSRF tokens'));
  });

  const BAD_CSRF = { 'x-csrf_token': 'BAD', 'x-csrf_token_expires': '1' };
  const INVALID_CREATE = { definitionId: 'x', format: 'doc', asOf: '2026-02-30' };

  it.each<[string, () => Promise<Record<string, string>>, string, number, string, number]>([
    ['login before role, site and fields', async () => CSRF, '?siteid=nowhere', 401, 'Insufficient Account Permissions', 0],
    ['the site before login, role and fields', async () => ({ ...(await anonymousHeaders()), ...CSRF }), '?siteid=nowhere', 400, 'Invalid parameters', 0],
    ['the site before role and fields', async () => ({ ...(await headers([Roles.systemUser])), ...CSRF }), '?siteid=nowhere', 400, 'Invalid parameters', 0],
    ['login before role and fields', async () => ({ ...(await anonymousHeaders()), ...CSRF }), '', 401, 'Insufficient Account Permissions', 0],
    ['the role before CSRF and fields', async () => ({ ...(await headers([Roles.systemUser])), ...BAD_CSRF }), '', 403, 'Insufficient Account Permissions', 0],
    ['the site before CSRF and fields', async () => ({ ...(await headers()), ...BAD_CSRF }), '?siteid=nowhere', 400, 'Invalid parameters', 0],
    ['CSRF before the definition', async () => ({ ...(await headers()), ...BAD_CSRF }), '', 400, 'Invalid CSRF tokens', 1],
    ['the definition before format and asOf', async () => ({ ...(await headers()), ...CSRF }), '', 404, 'Not Found', 1],
  ])('answers a create failing several checks with the earliest, %s', async (_case, headersOf, query, status, message, csrfCalls) => {
    const res = await app.inject({ method: 'POST', url: `${P}${query}`, headers: await headersOf(), payload: INVALID_CREATE });
    expect(res.statusCode).toBe(status);
    expect(res.body).toBe(errorBody('reporting.exports', 'invalid_request', message));
    expect([consumed.length, enqueued.length]).toStrictEqual([csrfCalls, 0]);
  });

  it('answers another site or an unknown site as the fixture does', async () => {
    const other = await app.inject({ url: `${P}?siteid=tenant-b`, headers: await headers() });
    expect(other.statusCode).toBe(403);
    expect(other.body).toBe(errorBody('reporting.exports', 'invalid_request', 'Insufficient Account Permissions'));
    const unknown = await app.inject({ url: `${P}?siteid=nowhere`, headers: await headers() });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toBe(errorBody('reporting.exports', 'invalid_request', 'Invalid parameters'));
  });

  it.each<[string, () => Promise<Awaited<ReturnType<FastifyInstance['inject']>>>, number, string | null]>([
    ['a definition id PostgreSQL cannot look up', () => create({ definitionId: 'nul-probe\u0000', format: 'csv' }), 400, 'request rejected: 22021'],
    ['a NUL job id PostgreSQL cannot look up', async () => app.inject({ url: `${P}/nul-probe%00`, headers: await headers() }), 400, 'request rejected: 22021'],
    ['a NUL siteid PostgreSQL cannot look up', async () => app.inject({ url: `${P}?siteid=nul-probe%00`, headers: await headers() }), 400, 'request rejected: 22021'],
    ['an anonymous caller', () => app.inject({ url: P }), 401, 'request denied: missing-credential'],
    [
      'an anonymous create naming a NUL definition id',
      () => app.inject({ method: 'POST', url: P, headers: CSRF, payload: { definitionId: 'nul-probe\u0000', format: 'csv' } }),
      401,
      'request denied: missing-credential',
    ],
    ['a user without reporting.exporter', async () => app.inject({ url: P, headers: await headers([Roles.systemUser]) }), 403, 'request denied: forbidden'],
    ['an anonymous session', async () => app.inject({ url: P, headers: await anonymousHeaders() }), 401, 'request denied: authorization'],
    ['an unregistered token site', async () => app.inject({ url: P, headers: await headers([], 'nosuchsite') }), 400, 'request rejected: invalidParameters'],
    ['another site', async () => app.inject({ url: `${P}?siteid=tenant-b`, headers: await headers() }), 403, 'request denied: site-mismatch'],
    ['a create without a valid CSRF token', () => create({ definitionId: defs[TENANT_A.siteId], format: 'csv' }, {}), 400, 'request rejected: invalidTokens'],
    ['a bad format', () => create({ definitionId: defs[TENANT_A.siteId], format: 'doc' }), 400, 'request rejected: invalidParameters'],
    ['a missing definition', () => create({ format: 'csv' }), 404, null],
    ['an unhandled exception', async () => app.inject({ url: `${P}?pageIndex=${encodeURIComponent('1\u0663')}`, headers: await headers() }), 500, null],
  ])('logs %s with its fixed reason, if any, ahead of the completion line, queueing nothing', async (_case, send, status, warning) => {
    const stored = async (): Promise<number> => (await app.inject({ url: `${P}?itemsPerPage=1000`, headers: await headers() })).json().data.totalitems;
    const total = await stored();
    const before = logLines.length;
    const res = await send();
    const lines = logLines.slice(before).map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(res.statusCode).toBe(status);
    expect(lines.filter(({ severity, message }) => severity === 'WARNING' || message === 'request completed').map(({ severity, message }) => [severity, message])).toStrictEqual([
      ...(warning === null ? [] : [['WARNING', warning]]),
      ['INFO', 'request completed'],
    ]);
    expect(lines.filter(({ severity }) => severity === 'ERROR')).toHaveLength(status === 500 ? 1 : 0);
    for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
    expect(`${JSON.stringify(lines)}${res.body}`).not.toMatch(/nul-probe|invalid byte sequence|0x00/);
    expect([enqueued.length, await stored()]).toEqual([0, total]);
  });

  it('lists jobs with paging and rejects bad paging', async () => {
    await create({ definitionId: defs[TENANT_A.siteId], format: 'csv' });
    const res = await app.inject({ url: `${P}?itemsPerPage=1&pageIndex=1`, headers: await headers() });
    expect(res.statusCode).toBe(200);
    expectEtag(res);
    const data = res.json().data;
    expect(data).toMatchObject({ startindex: 1, endindex: 1, itemsperpage: 1, pageindex: 1 });
    expect(data.items).toHaveLength(1);
    expect(data.totalitems).toBeGreaterThanOrEqual(1);
    const defaults = await app.inject({ url: `${P}?pageIndex=&itemsPerPage=`, headers: await headers() });
    expect(defaults.json().data.itemsperpage).toBe(50);
    for (const query of ['pageIndex=abc', 'pageIndex=0', 'itemsPerPage=1001', 'pageIndex=1.5', 'pageIndex=%20%201']) {
      const bad = await app.inject({ url: `${P}?${query}`, headers: await headers() });
      expect(bad.statusCode, query).toBe(400);
      expect(bad.body).toBe(errorBody('reporting.exports', 'invalid_request', 'Invalid parameters'));
    }
    const far = await app.inject({ url: `${P}?pageIndex=999`, headers: await headers() });
    expect(far.json().data.items).toEqual([]);
  });

  it.each([
    ['\u0663', 400, errorBody('reporting.exports', 'invalid_request', 'Invalid parameters')],
    ['1\u0663', 500, errorBody('reporting.exports', 'server_error', 'Unhandled Exception')],
  ])('answers non-ASCII digit paging %j with %i, as ACF compares then fails int()', async (pageIndex, status, body) => {
    const res = await app.inject({ url: `${P}?pageIndex=${encodeURIComponent(pageIndex)}`, headers: await headers() });
    expect(res.statusCode).toBe(status);
    expect(res.body).toBe(body);
  });

  it('lists only the caller tenant jobs', async () => {
    const b = await storeDone(TENANT_B);
    const res = await app.inject({ url: `${P}?itemsPerPage=1000`, headers: await headers() });
    expect(res.json().data.items.map((j: { job_id: string }) => j.job_id)).not.toContain(b);
  });

  it('reads a job, ignoring id case and trailing spaces, and hides other tenants', async () => {
    const id = await storeDone();
    const res = await app.inject({ url: `${P}/${id.toLowerCase()}%20`, headers: await headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ job_id: id, state: 'done', file_name: `export-${id}.csv`, created: '2026-06-30T10:00:00' });
    expect(res.json().data).not.toHaveProperty('object_key');
    const b = await storeDone(TENANT_B);
    const hidden = await app.inject({ url: `${P}/${b}`, headers: await headers() });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(errorBody('reporting.exports', 'invalid_request', 'Not Found'));
    const dl = await app.inject({ url: `${P}/${b}/download`, headers: await headers() });
    expect(dl.statusCode).toBe(404);
    expect(dl.body).toBe(errorBody('reporting.exports.download', 'invalid_request', 'Not Found'));
  });

  it('resolves a request without siteid to the token site, so a tenant-b exporter reads and lists only tenant-b jobs', async () => {
    const own = await storeDone(TENANT_B);
    const other = await storeDone(TENANT_A);
    const tenantB = await headers(EXPORTER, TENANT_B.siteId);
    const read = await app.inject({ url: `${P}/${own}`, headers: tenantB });
    expect([read.statusCode, read.json().data.siteid]).toStrictEqual([200, TENANT_B.siteId]);
    const hidden = await app.inject({ url: `${P}/${other}`, headers: tenantB });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(errorBody('reporting.exports', 'invalid_request', 'Not Found'));
    const ids = (await app.inject({ url: `${P}?itemsPerPage=1000`, headers: tenantB })).json().data.items.map((j: { job_id: string }) => j.job_id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(other);
  });

  it.each(EXPORT_STATES)('answers a stored %s job in the envelope.cfc success shape, as jobRow projects it, alone and in the list', async (state) => {
    const row = jobFor(definitionOf(), { format: 'xlsx', state });
    await storeJob(row);
    const detail = await app.inject({ url: `${P}/${row.job_id}`, headers: await headers() });
    expect(detail.statusCode).toBe(200);
    expect(Object.keys(detail.json())).toStrictEqual(['apiversion', 'method', 'data']);
    expect(detail.json()).toStrictEqual({ apiversion: 'v1', method: 'reporting.exports', data: jobRow(row) });
    const list = (await app.inject({ url: `${P}?itemsPerPage=1000`, headers: await headers() })).json().data;
    expect(Object.keys(list)).toStrictEqual(LIST_KEYS);
    expect(list.items.filter((job: { job_id: string }) => job.job_id === row.job_id)).toStrictEqual([jobRow(row)]);
  });

  it('answers a download before done with the not-ready conflict', async () => {
    const created = await create({ definitionId: defs[TENANT_A.siteId], format: 'csv' });
    const id = created.json().data.job_id as string;
    const res = await app.inject({ url: `${P}/${id}/download`, headers: await headers() });
    expect(res.statusCode).toBe(409);
    expect(res.body).toBe(errorBody('reporting.exports.download', 'invalid_request', 'not-ready'));
    expectEtag(res);
  });

  it.each<ExportState>(['running', 'failed'])('answers a download of a stored %s job with the not-ready conflict', async (state) => {
    const row = jobFor(definitionOf(), { format: 'csv', state });
    await storeJob(row);
    const res = await app.inject({ url: `${P}/${row.job_id}/download`, headers: await headers() });
    expect(res.statusCode).toBe(409);
    expect(res.body).toBe(errorBody('reporting.exports.download', 'invalid_request', 'not-ready'));
  });

  it.each<[string, 'GET' | 'POST', Record<string, string>]>([
    ['a GET', 'GET', {}],
    ['a POST overridden to GET, without a CSRF token', 'POST', { 'x-http-method-override': 'GET' }],
  ])('downloads a done job output as an attachment for %s', async (_case, method, override) => {
    const id = await storeDone();
    const res = await app.inject({ method, url: `${P}/${id}/download`, headers: { ...(await headers()), ...override } });
    expect(res.statusCode).toBe(200);
    expect(consumed).toHaveLength(0);
    expect(res.rawPayload.equals(OUTPUT)).toBe(true);
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="export-${id}.csv"`);
    expect(res.headers['content-length']).toBe(String(OUTPUT.length));
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
  });

  it('answers server_error for a control character in the file name and for a missing object', async () => {
    const bad = await storeDone(TENANT_A, 'a\u0001.csv');
    const res = await app.inject({ url: `${P}/${bad}/download`, headers: await headers() });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(errorBody('reporting.exports.download', 'server_error', 'Unhandled Exception'));
    const gone = await storeDone();
    const job = (await app.inject({ url: `${P}/${gone}`, headers: await headers() })).json().data;
    await storage.delete(EXPORT_BUCKET, exportObjectKey(TENANT_A.tenantId, job.job_id, 'csv'));
    errorSpies.length = 0;
    const missing = await app.inject({ url: `${P}/${gone}/download`, headers: await headers() });
    expect(missing.statusCode).toBe(500);
    const calls = errorSpies.flatMap((s) => s.mock.calls).filter((c) => c[1] === 'unhandled fixture exception');
    const stack = expect.stringMatching(/^StorageObjectNotFoundError: \[REDACTED\]\n\s+at \S/);
    expect(calls).toStrictEqual([[{ error: { type: 'StorageObjectNotFoundError', message: REDACTED, stack } }, 'unhandled fixture exception']]);
    expect(JSON.stringify(calls)).not.toContain(job.job_id);
  });

  it('dispatches on X-HTTP-Method-Override', async () => {
    const list = await app.inject({ method: 'POST', url: P, headers: { ...(await headers()), 'x-http-method-override': 'get' }, payload: {} });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveProperty('items');
    const asCreate = await app.inject({ method: 'GET', url: `${P}?definitionId=${defs[TENANT_A.siteId]}&format=csv`, headers: { ...(await headers()), ...CSRF, 'x-http-method-override': 'POST' } });
    expect(asCreate.statusCode).toBe(200);
    expect(asCreate.json().data.state).toBe('queued');
    const none = await app.inject({ url: `${P}/X`, headers: { ...(await headers()), 'x-http-method-override': 'DELETE' } });
    expect(none.statusCode).toBe(404);
    expect(none.body).toBe(errorBody('reporting.exports', 'invalid_request', 'Not Found'));
  });

  it('reads a job for a POST overridden to GET, as api.cfm dispatches it, without a CSRF token', async () => {
    const id = await storeDone();
    const res = await app.inject({ method: 'POST', url: `${P}/${id}`, headers: { ...(await headers()), 'x-http-method-override': 'GET' }, payload: {} });
    expect(res.statusCode).toBe(200);
    expectEtag(res);
    expect(res.json()).toMatchObject({ apiversion: 'v1', method: 'reporting.exports', data: { job_id: id, state: 'done', file_name: `export-${id}.csv` } });
    expect(consumed).toHaveLength(0);
  });

  it.each<[string, string, string, Record<string, string>]>([
    ['a POST overridden to PUT on a job', '', 'reporting.exports', { 'x-http-method-override': 'PUT' }],
    ['a plain POST on a job', '', 'reporting.exports', {}],
    ['a POST overridden to PUT on a download', '/download', 'reporting.exports.download', { 'x-http-method-override': 'PUT' }],
    ['a plain POST on a download', '/download', 'reporting.exports.download', {}],
  ])('answers %s with the fixture notFound, as reporting.cfc handle() does', async (_case, action, method, override) => {
    const id = await storeDone();
    const res = await app.inject({ method: 'POST', url: `${P}/${id}${action}`, headers: { ...(await headers()), ...CSRF, ...override } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(errorBody(method, 'invalid_request', 'Not Found'));
    expectEtag(res);
    expect([consumed.length, enqueued.length]).toStrictEqual([0, 0]);
  });

  it('answers the legacy 503 when the units are not target-authoritative or the run cannot be scheduled', async () => {
    await setGates('legacy');
    const res = await create({ definitionId: defs[TENANT_A.siteId], format: 'csv' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toEqual({ message: 'Unhandled Exception', code: 'server_error' });
    await setGates('open');
    failEnqueue = true;
    const down = await create({ definitionId: defs[TENANT_A.siteId], format: 'csv' });
    expect(down.statusCode).toBe(503);
  });

  it('answers a 503 when identity cannot be reached for CSRF', async () => {
    const port = (identity.address() as AddressInfo).port;
    await new Promise((resolve) => identity.close(resolve));
    const res = await create({ definitionId: defs[TENANT_A.siteId], format: 'csv' });
    expect(res.statusCode).toBe(503);
    await new Promise<void>((resolve) => identity.listen(port, '127.0.0.1', resolve));
  });
});
