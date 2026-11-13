// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * registerFixtureRoutes through app.inject over in-memory domain doubles: declarations, method dispatch, tenancy, CSRF and envelopes;
 * then over PostgreSQL, values it cannot store; then over the recording database, the wire envelope, error rows and api.cfm check order.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { LEGACY_ERROR_MAP, LEGACY_JSON_CONTENT_TYPE, LegacyApiError, cfHash, type LegacyErrorSpec } from '@opt2/platform/legacy-compat';
import { createLogger, validateLogRecord } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  createService,
  fixedClock,
  loadEnv,
  type FastifyInstance,
  type ServiceRequest,
} from '@opt2/platform/service-kit';
import { siteForTenant, tenantForRegisteredSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { DomainDeps, MailDeps } from '../../src/domain/delivery.js';
import {
  getMessage,
  listMessages,
  submitMessage,
  type MessageDetailView,
  type MessagePage,
  type MessageView,
} from '../../src/domain/messages.js';
import { createTemplate, listTemplates, type TemplatePage } from '../../src/domain/templates.js';
import { FIXTURE_ROLES } from '../../src/legacy/fixture-auth.js';
import { FIXTURE_ERROR_MAP, FixtureApiError, fixtureMethod, type FixtureErrorType } from '../../src/legacy/fixture-envelope.js';
import { createCommunicationsRepository, type CommunicationsRepository } from '../../src/repo/repository.js';
import { UNITS, type MessageTemplateRow } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX, registerFixtureRoutes } from '../../src/routes/fixture.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, headersFor, type TestApp } from '../helpers/app.js';

vi.mock('../../src/domain/templates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/domain/templates.js')>()),
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
}));

vi.mock('../../src/domain/messages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/domain/messages.js')>()),
  listMessages: vi.fn(),
  submitMessage: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock('@opt2/platform/migration-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/migration-kit')>();
  return { ...actual, withGatedTenant: vi.fn(actual.withGatedTenant) };
});

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };

type OpenApiDoc = { paths: Record<string, Record<string, Record<string, unknown>>> };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;

const SCHEMA = 'communications';
const USER_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const TEMPLATE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const UPDATED_TEMPLATE_ID = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const MESSAGE_ID = '7A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const SENDER = [Roles.systemUser, Roles.communicationsSender];
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000123' };

const TEMPLATES = `${FIXTURE_PREFIX}/templates`;
const MESSAGES = `${FIXTURE_PREFIX}/messages`;
const MESSAGE = `${FIXTURE_PREFIX}/messages/${MESSAGE_ID}`;

const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const DENIED = { code: 'invalid_request', message: 'Insufficient Account Permissions' };
const INVALID_TOKENS = { code: 'invalid_request', message: 'Invalid CSRF tokens' };
const NOT_FOUND = { code: FIXTURE_ERROR_MAP.notFound.code, message: FIXTURE_ERROR_MAP.notFound.message };

const TEMPLATE_ROW: MessageTemplateRow = {
  tenant_id: TENANT_A.tenantId,
  template_id: TEMPLATE_ID,
  siteid: TENANT_A.siteId,
  name: 'Welcome',
  subject: 'Hello {{name}}',
  body_text: 'Hi {{name}}',
  body_html: '',
  created: new Date(2026, 5, 30, 9, 15, 7, 123),
  lastupdate: null,
};
const UPDATED_TEMPLATE_ROW: MessageTemplateRow = {
  ...TEMPLATE_ROW,
  template_id: UPDATED_TEMPLATE_ID,
  body_html: '<p>Hi {{name}}</p>',
  lastupdate: new Date(2026, 5, 30, 10, 0, 1, 500),
};
const TEMPLATE_VIEW = {
  template_id: TEMPLATE_ID,
  siteid: TENANT_A.siteId,
  name: 'Welcome',
  subject: 'Hello {{name}}',
  body_text: 'Hi {{name}}',
  body_html: '',
  created: '2026-06-30T09:15:07',
  lastupdate: '',
};
const UPDATED_TEMPLATE_VIEW = { ...TEMPLATE_VIEW, template_id: UPDATED_TEMPLATE_ID, body_html: '<p>Hi {{name}}</p>', lastupdate: '2026-06-30T10:00:01' };

const MESSAGE_VIEW: MessageView = {
  message_id: MESSAGE_ID,
  siteid: TENANT_A.siteId,
  template_id: '',
  to_address: 'ann@example.com',
  from_address: 'noreply@opt2.local',
  subject: 'Hello',
  body_text: 'Hi',
  body_html: '',
  state: 'delivered',
  created: '2026-06-30T09:15:07',
  sent_at: '2026-06-30T09:15:08',
};
const DETAIL: MessageDetailView = {
  ...MESSAGE_VIEW,
  history: [
    { status_id: 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6', message_id: MESSAGE_ID, status: 'queued', detail: '', mailpit_id: '', recorded_at: '2026-06-30T09:15:07' },
    { status_id: 'C2B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6', message_id: MESSAGE_ID, status: 'sent', detail: '', mailpit_id: '', recorded_at: '2026-06-30T09:15:08' },
    { status_id: 'C3B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6', message_id: MESSAGE_ID, status: 'delivered', detail: '', mailpit_id: 'MP-1', recorded_at: '2026-06-30T09:15:08' },
  ],
};

type Method = 'GET' | 'POST';

interface Call {
  method: Method;
  url: string;
  /** Token roles; null sends no token. */
  roles?: readonly string[] | null;
  tenant?: TenantFixture;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

describe('communications fixture routes', () => {
  const opened: TenantTx[] = [];
  const db: TenantDb = {
    schema: SCHEMA,
    withTenant: (tenantId, fn) => {
      const tx: TenantTx = Object.freeze({
        kind: 'tenant',
        tenantId,
        schema: SCHEMA,
        query: () => Promise.reject(new Error('the routes run no SQL of their own')),
        onCommit: () => undefined,
      });
      opened.push(tx);
      return fn(tx);
    },
    withMetadata: () => Promise.reject(new Error('the routes open no metadata transaction')),
    end: () => Promise.resolve(),
  };
  const unused = (): Promise<never> => Promise.reject(new Error('mail port reached past the mocked domain'));
  const domain: DomainDeps = {
    db,
    repository: {} as CommunicationsRepository,
    clock: fixedClock(new Date(2026, 5, 30, 9, 15, 7)),
    logger: createLogger({ service: SCHEMA, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  };
  const mailDeps: MailDeps = {
    ...domain,
    transport: { send: unused, close: () => Promise.resolve() },
    deliveryStatus: { confirm: unused },
    senderAddress: { fromEmail: unused },
  };
  const knownSites = new Set([TENANT_A.siteId, TENANT_B.siteId, 'default']);
  let app: FastifyInstance;
  let csrfValid: boolean;
  let identity: Mock<(req: ServiceRequest) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>>;

  const domainMocks = (): Mock[] => [listTemplates, createTemplate, listMessages, submitMessage, getMessage].map((fn) => vi.mocked(fn) as Mock);

  /** Injects one call with a user token unless `roles` is null, and checks the answer against the operation of `contractMethod`. */
  async function inject({ method, url, roles = SENDER, tenant = TENANT_A, body, headers = {} }: Call, contractMethod: Method = method) {
    const auth: Record<string, string> =
      roles === null
        ? {}
        : {
            authorization: `Bearer ${await mintUserToken({ site: tenant.siteId, roles, sub: USER_ID })}`,
            [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'communications' })}`,
          };
    const res = await app.inject({
      method,
      url,
      headers: { ...auth, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    assertResponseMatchesOpenApi(OPENAPI, {
      method: contractMethod,
      path: url,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  }

  beforeAll(async () => {
    app = await createService({
      name: SCHEMA,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8115',
        OPT2_SERVICE_NAME: SCHEMA,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SCHEMA),
      logger: createLogger({ service: SCHEMA, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    await registerFixtureRoutes(app, {
      db,
      siteLookup: { registeredSite: (siteId) => Promise.resolve(knownSites.has(siteId.toLowerCase()) ? siteId.toLowerCase() : undefined) },
      domain,
      mailDeps,
    });
    await app.ready();
    identity = vi.fn(() => Promise.resolve({ status: 200, headers: {}, body: { valid: csrfValid } }));
    vi.spyOn(app.opt2.client, 'request').mockImplementation(identity);
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
  });

  beforeEach(() => {
    opened.length = 0;
    csrfValid = true;
    identity.mockClear();
    vi.mocked(withGatedTenant).mockClear();
    for (const mock of domainMocks()) mock.mockReset();
    const templatePage: TemplatePage = { list: [TEMPLATE_ROW, UPDATED_TEMPLATE_ROW], pageIndex: 1, itemsPerPage: 2, totalItems: 3 };
    const messagePage: MessagePage = { list: [MESSAGE_VIEW], pageIndex: 1, itemsPerPage: 50, totalItems: 1 };
    vi.mocked(listTemplates).mockResolvedValue(templatePage);
    vi.mocked(createTemplate).mockResolvedValue(UPDATED_TEMPLATE_ROW);
    vi.mocked(listMessages).mockResolvedValue(messagePage);
    vi.mocked(submitMessage).mockResolvedValue(DETAIL);
    vi.mocked(getMessage).mockResolvedValue(DETAIL);
  });

  it('declares the five contract operations, each public with the site checked in the handler', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith(FIXTURE_PREFIX));
    expect(routes).toEqual(
      [
        ['GET', MESSAGES],
        ['POST', MESSAGES],
        ['GET', `${MESSAGES}/:id`],
        ['GET', TEMPLATES],
        ['POST', TEMPLATES],
      ].map(([method, url]) => ({ method, url, transport: 'service', public: true, siteCheck: false })),
    );
    for (const { method, url } of routes) {
      const operation = OPENAPI.paths[url.replace(':id', '{id}')]?.[method.toLowerCase()] ?? {};
      expect([operation['x-opt2-transport'], operation['x-opt2-public'], operation['x-opt2-site-check']]).toEqual(['service', true, false]);
    }
  });

  it.each<[string, TenantFixture, string]>([
    ['a tenant-a sender with a case-variant site', TENANT_A, 'TENANT-A'],
    ['a tenant-b sender', TENANT_B, 'tenant-b'],
  ])("lists the token tenant's templates for %s, dates to the second and a NULL lastupdate as ''", async (_case, tenant, siteid) => {
    const res = await inject({ method: 'GET', url: `${TEMPLATES}?siteid=${siteid}&pageIndex=1&itemsPerPage=2`, tenant });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'communications.templates',
      data: { items: [TEMPLATE_VIEW, UPDATED_TEMPLATE_VIEW], startindex: 1, endindex: 2, itemsperpage: 2, totalitems: 3, totalpages: 2, pageindex: 1 },
    });
    expect(vi.mocked(listTemplates).mock.calls).toEqual([[opened[0], { siteid, pageIndex: '1', itemsPerPage: '2', siteId: tenant.siteId }]]);
    expect(opened.map((tx) => tx.tenantId)).toEqual([tenant.tenantId]);
    expect(withGatedTenant).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
  });

  it('stores a template in a gated transaction once identity consumed the collection CSRF token', async () => {
    const body = { siteid: TENANT_A.siteId, name: 'Welcome', subject: 'Hello {{name}}', bodyHtml: '<p>Hi {{name}}</p>' };

    const res = await inject({ method: 'POST', url: TEMPLATES, body, headers: CSRF_HEADERS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'communications.templates', data: UPDATED_TEMPLATE_VIEW });
    expect(identity).toHaveBeenCalledTimes(1);
    expect(identity.mock.calls[0]?.[0]).toMatchObject({ service: IDENTITY_SERVICE, path: CSRF_CONSUME_PATH, json: { token: 'CSRF-TOKEN', context: '' } });
    expect(vi.mocked(withGatedTenant).mock.calls).toEqual([[db, TENANT_A.tenantId, expect.any(Function)]]);
    expect(vi.mocked(createTemplate).mock.calls).toEqual([[opened[0], domain, { siteId: TENANT_A.siteId, userId: USER_ID, input: body }]]);
    expect(opened.map((tx) => tx.tenantId)).toEqual([TENANT_A.tenantId]);
    expect(identity.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createTemplate).mock.invocationCallOrder[0]!);
  });

  it("lists the token tenant's messages in the paged-list shape", async () => {
    const res = await inject({ method: 'GET', url: `${MESSAGES}?siteid=tenant-a` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'communications.messages',
      data: { items: [MESSAGE_VIEW], startindex: 1, endindex: 1, itemsperpage: 50, totalitems: 1, totalpages: 1, pageindex: 1 },
    });
    expect(vi.mocked(listMessages).mock.calls).toEqual([[opened[0], { siteid: TENANT_A.siteId, siteId: TENANT_A.siteId }]]);
    expect(opened.map((tx) => tx.tenantId)).toEqual([TENANT_A.tenantId]);
  });

  it('submits a message with the mail deps under the token tenant, site and user, and answers its detail', async () => {
    const body = { siteid: TENANT_A.siteId, to: 'ann@example.com', subject: 'Hello', bodyText: 'Hi' };

    const res = await inject({ method: 'POST', url: MESSAGES, body, headers: CSRF_HEADERS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'communications.messages', data: DETAIL });
    expect(identity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitMessage).mock.calls).toEqual([[mailDeps, { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, userId: USER_ID, input: body }]]);
    expect(vi.mocked(submitMessage).mock.calls[0]?.[0]).toBe(mailDeps);
    expect(opened).toEqual([]);
  });

  it.each<[string, string, string]>([
    ['as stored', MESSAGE_ID, MESSAGE_ID],
    ['in lower case', MESSAGE_ID.toLowerCase(), MESSAGE_ID],
    ['with trailing spaces', `${MESSAGE_ID.toLowerCase()}%20%20`, MESSAGE_ID],
    ['with a leading space, kept', `%20${MESSAGE_ID}`, ` ${MESSAGE_ID}`],
  ])('reads the message detail of an id %s by its stored form', async (_case, segment, stored) => {
    const res = await inject({ method: 'GET', url: `${MESSAGES}/${segment}?siteid=tenant-a` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'communications.messages', data: DETAIL });
    expect(vi.mocked(getMessage).mock.calls).toEqual([[opened[0], stored]]);
    expect(opened.map((tx) => tx.tenantId)).toEqual([TENANT_A.tenantId]);
    expect(identity).not.toHaveBeenCalled();
  });

  it('answers a message the tenant lacks with the fixture notFound envelope', async () => {
    vi.mocked(getMessage).mockRejectedValueOnce(new FixtureApiError('notFound'));

    const res = await inject({ method: 'GET', url: MESSAGE });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'communications.messages', error: NOT_FOUND });
  });

  it('answers a domain invalidParameters with the fixture 400 envelope', async () => {
    vi.mocked(createTemplate).mockRejectedValueOnce(new LegacyApiError('invalidParameters'));

    const res = await inject({ method: 'POST', url: TEMPLATES, body: { name: '' }, headers: CSRF_HEADERS });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', method: 'communications.templates', error: INVALID_PARAMETERS });
  });

  it.each<[Method, string, string, string, () => unknown, boolean]>([
    ['POST', TEMPLATES, 'GET', 'communications.templates', () => listTemplates, false],
    ['GET', TEMPLATES, 'post', 'communications.templates', () => createTemplate, true],
    ['POST', MESSAGES, 'get', 'communications.messages', () => listMessages, false],
    ['GET', MESSAGES, 'POST', 'communications.messages', () => submitMessage, true],
  ])('dispatches %s %s overridden to %s on the effective method', async (method, url, override, envelope, handler, csrf) => {
    const res = await inject(
      { method, url: `${url}?siteid=tenant-a&name=Welcome`, headers: { 'x-http-method-override': override, ...CSRF_HEADERS } },
      override.toUpperCase() as Method,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: envelope });
    const called = domainMocks().filter((mock) => mock.mock.calls.length > 0);
    expect(called).toHaveLength(1);
    expect(called[0]).toBe(handler());
    expect(identity).toHaveBeenCalledTimes(csrf ? 1 : 0);
  });

  it.each<[Method, string, string]>([
    ['GET', TEMPLATES, 'DELETE'],
    ['POST', MESSAGES, 'PUT'],
    ['GET', MESSAGE, 'POST'],
  ])('answers %s %s overridden to the undeclared %s with notFound, after the site check and before any check of the caller', async (method, url, override) => {
    const res = await inject({ method, url, roles: null, headers: { 'x-http-method-override': override } });
    const unknownSite = await inject({ method, url: `${url}?siteid=nowhere`, roles: null, headers: { 'x-http-method-override': override } });

    expect([res.statusCode, res.json<{ error: unknown }>().error]).toEqual([404, NOT_FOUND]);
    expect([unknownSite.statusCode, unknownSite.json<{ error: unknown }>().error]).toEqual([400, INVALID_PARAMETERS]);
    expect(domainMocks().every((mock) => mock.mock.calls.length === 0)).toBe(true);
  });

  const ROUTES: ReadonlyArray<readonly [Method, string]> = [
    ['GET', TEMPLATES],
    ['POST', TEMPLATES],
    ['GET', MESSAGES],
    ['POST', MESSAGES],
    ['GET', MESSAGE],
  ];

  it.each(
    ROUTES.flatMap(([method, url]) =>
      (
        [
          ['an anonymous caller', null, TENANT_A.siteId, 401, DENIED],
          ['a user without communications.sender', [Roles.systemUser], TENANT_A.siteId, 403, DENIED],
          ['a sender naming another site', SENDER, TENANT_B.siteId, 403, DENIED],
          ['a sender naming an unknown site', SENDER, 'nowhere', 400, INVALID_PARAMETERS],
        ] as const
      ).map((c) => [method, url, ...c] as const),
    ),
  )('%s %s denies %s before the domain', async (method, url, _case, roles, siteid, status, error) => {
    const res = await inject({ method, url: `${url}?siteid=${siteid}`, roles, headers: CSRF_HEADERS });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error });
    expect(domainMocks().every((mock) => mock.mock.calls.length === 0)).toBe(true);
    expect(identity).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it.each<[string, Record<string, string>, boolean, number]>([
    ['without a token, before calling identity', {}, true, 0],
    ['with a token identity rejects', CSRF_HEADERS, false, 1],
  ])('answers invalidTokens on both write routes %s', async (_case, headers, valid, identityCalls) => {
    csrfValid = valid;
    for (const url of [TEMPLATES, MESSAGES]) {
      const res = await inject({ method: 'POST', url, body: { siteid: TENANT_A.siteId }, headers });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: INVALID_TOKENS });
    }
    expect(identity).toHaveBeenCalledTimes(identityCalls * 2);
    expect(domainMocks().every((mock) => mock.mock.calls.length === 0)).toBe(true);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('communications fixture routes over PostgreSQL', () => {
  const logLines: Array<Record<string, unknown>> = [];
  let handle: ThrowawaySchema;
  let app: FastifyInstance;

  beforeAll(async () => {
    const templates = await vi.importActual<typeof import('../../src/domain/templates.js')>('../../src/domain/templates.js');
    vi.mocked(createTemplate).mockImplementation(templates.createTemplate);
    vi.mocked(listTemplates).mockImplementation(templates.listTemplates);
    handle = await createThrowawaySchema({ service: SCHEMA, migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await seedRegistry(handle.app);
    const clock = fixedClock(new Date(2026, 5, 30, 9, 15, 7));
    const logger = createLogger({
      service: SCHEMA,
      version: '1.0.0',
      env: 'local',
      destination: { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) },
    });
    app = await createService({
      name: SCHEMA,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8115',
        OPT2_SERVICE_NAME: SCHEMA,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SCHEMA),
      logger,
    });
    const domain: DomainDeps = { db: handle.app, repository: createCommunicationsRepository({ clock, schema: handle.schema }), clock, logger };
    const unused = (): Promise<never> => Promise.reject(new Error('template routes send no mail'));
    await registerFixtureRoutes(app, {
      db: handle.app,
      // The route registry's lookup: the registered id of the site matching ignoring case.
      siteLookup: {
        registeredSite: (siteId) =>
          handle.app.withMetadata(async (tx) => {
            const tenantId = await tenantForRegisteredSite(tx, siteId);
            return tenantId === null ? undefined : ((await siteForTenant(tx, tenantId)) ?? undefined);
          }),
      },
      domain,
      mailDeps: { ...domain, transport: { send: unused, close: () => Promise.resolve() }, deliveryStatus: { confirm: unused }, senderAddress: { fromEmail: unused } },
    });
    await app.ready();
    vi.spyOn(app.opt2.client, 'request').mockResolvedValue({ status: 200, headers: {}, body: { valid: true } });
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  /** Templates stored for tenant-a. */
  async function storedTemplates(): Promise<number> {
    const { rows } = await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${handle.schema}.message_template`),
    );
    return rows[0]?.n ?? -1;
  }

  const NUL_TEMPLATE = { siteid: TENANT_A.siteId, name: 'nul-probe\u0000name', subject: 'Hello', bodyText: 'Hi' };

  it.each<[string, Omit<Call, 'tenant'>, number, { code: string; message: string }, string]>([
    ['a template name PostgreSQL cannot store', { method: 'POST', url: TEMPLATES, body: NUL_TEMPLATE, headers: CSRF_HEADERS }, 400, INVALID_PARAMETERS, 'request rejected: 22021'],
    ['an anonymous caller sending that name', { method: 'POST', url: TEMPLATES, body: NUL_TEMPLATE, roles: null }, 401, DENIED, 'request denied: authorization'],
    // A NUL inside the value: the Portcullis trim of a url siteid removes a trailing one.
    [
      'an anonymous caller naming a site PostgreSQL cannot look up',
      { method: 'GET', url: `${TEMPLATES}?siteid=nul-probe%00site`, roles: null },
      400,
      INVALID_PARAMETERS,
      'request rejected: 22021',
    ],
    ['a sender naming a site PostgreSQL cannot look up', { method: 'GET', url: `${TEMPLATES}?siteid=nul-probe%00site` }, 400, INVALID_PARAMETERS, 'request rejected: 22021'],
    [
      'a sender naming a site with a trailing NUL, trimmed to an unknown site',
      { method: 'GET', url: `${TEMPLATES}?siteid=nul-probe%00` },
      400,
      INVALID_PARAMETERS,
      'request rejected: invalidParameters',
    ],
    [
      'a blank template name',
      { method: 'POST', url: TEMPLATES, body: { ...NUL_TEMPLATE, name: ' ' }, headers: CSRF_HEADERS },
      400,
      INVALID_PARAMETERS,
      'request rejected: invalidParameters',
    ],
  ])('answers %s with the fixture %i envelope, storing nothing and logging its fixed reason', async (_case, call, status, error, warning) => {
    const { method, url, roles = SENDER, body, headers = {} } = call;
    const auth: Record<string, string> =
      roles === null
        ? {}
        : {
            authorization: `Bearer ${await mintUserToken({ site: TENANT_A.siteId, roles, sub: USER_ID })}`,
            [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SCHEMA })}`,
          };
    const before = logLines.length;

    const res = await app.inject({
      method,
      url,
      headers: { ...auth, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const lines = logLines.slice(before);

    expect([res.statusCode, res.json()]).toEqual([status, { apiversion: 'v1', method: 'communications.templates', error }]);
    expect(lines.filter(({ severity, message }) => severity === 'WARNING' || message === 'request completed').map(({ severity, message }) => [severity, message])).toStrictEqual([
      ['WARNING', warning],
      ['INFO', 'request completed'],
    ]);
    expect(lines.filter(({ severity }) => severity === 'ERROR')).toEqual([]);
    for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
    expect(`${JSON.stringify(lines)}${res.body}`).not.toMatch(/nul-probe|invalid byte sequence|0x00/);
    expect(await storedTemplates()).toBe(0);
  });
});

describe('communications fixture routes over the recording database', () => {
  const SENDER_ID = '11111111-2222-3333-4444555566667777';
  const TEMPLATE_A1 = 'A1000000-0000-0000-0000000000000001';
  const TEMPLATE_A2 = 'A1000000-0000-0000-0000000000000002';
  const TEMPLATE_B = 'B1000000-0000-0000-0000000000000001';
  const MESSAGE_A = 'A2000000-0000-0000-0000000000000001';
  const MESSAGE_B = 'B2000000-0000-0000-0000000000000001';
  const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
  const SITE_A = `?siteid=${TENANT_A.siteId}`;
  const CSRF = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000000' };
  const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
  const WRITE_STATEMENT = /^(INSERT|UPDATE|DELETE)\b/i;
  /** Headers onRequestStart_include.cfm adds to every legacy response. */
  const LEGACY_HEADERS = { generator: 'Masa CMS 7.6.1', 'strict-transport-security': 'max-age=1200' };
  const TEMPLATES_METHOD = fixtureMethod('templates');
  const MESSAGES_METHOD = fixtureMethod('messages');

  type Caller = 'sender' | 'senderB' | 'systemUser';
  type ErrorType = FixtureErrorType | 'authorization' | 'invalidParameters' | 'invalidTokens' | 'server_error';

  /** One injected request; no `as` sends it anonymously, a `body` is sent as JSON. */
  interface Req {
    method?: 'GET' | 'POST';
    url: string;
    as?: Caller;
    body?: unknown;
    headers?: Record<string, string>;
  }

  const at = (hours: number, minutes: number, seconds: number, ms = 0): Date => new Date(2026, 5, 30, hours, minutes, seconds, ms);

  const templateRow = (site: TenantFixture, templateId: string, name: string, created: Date) => ({
    tenant_id: site.tenantId,
    template_id: templateId,
    siteid: site.siteId,
    name,
    subject: 'Hello {{name}}',
    body_text: 'Hi {{name}}',
    body_html: '',
    created,
    lastupdate: null,
  });
  const messageRow = (site: TenantFixture, messageId: string) => ({
    tenant_id: site.tenantId,
    message_id: messageId,
    siteid: site.siteId,
    template_id: null,
    to_address: 'ann@example.com',
    from_address: 'noreply@opt2.local',
    subject: 'Hello',
    body_text: 'Hi',
    body_html: '',
    state: 'delivered',
    created: at(9, 0, 0),
    sent_at: at(9, 0, 1),
    source: 'send',
  });
  const statusRow = (site: TenantFixture, statusId: string, messageId: string, status: string, recordedAt: Date, mailpitId: string | null = null) => ({
    tenant_id: site.tenantId,
    status_id: statusId,
    message_id: messageId,
    status,
    detail: null,
    mailpit_id: mailpitId,
    recorded_at: recordedAt,
    source: 'send',
  });

  /** envelope.cfc rows() of a seeded template: dates to the second, NULL lastupdate as ''. */
  const templateView = (templateId: string, name: string, created: string) => ({
    template_id: templateId,
    siteid: TENANT_A.siteId,
    name,
    subject: 'Hello {{name}}',
    body_text: 'Hi {{name}}',
    body_html: '',
    created,
    lastupdate: '',
  });
  const messageView = (site: TenantFixture, messageId: string) => ({
    message_id: messageId,
    siteid: site.siteId,
    template_id: '',
    to_address: 'ann@example.com',
    from_address: 'noreply@opt2.local',
    subject: 'Hello',
    body_text: 'Hi',
    body_html: '',
    state: 'delivered',
    created: '2026-06-30T09:00:00',
    sent_at: '2026-06-30T09:00:01',
  });
  const historyView = (statusId: string, messageId: string, status: string, recordedAt: string, mailpitId = '') => ({
    status_id: statusId,
    message_id: messageId,
    status,
    detail: '',
    mailpit_id: mailpitId,
    recorded_at: recordedAt,
  });

  /** The envelope.cfc respond() body: params suppressed, so apiversion, method, then data or error. */
  const successBody = (method: string, data: unknown): string => JSON.stringify({ apiversion: 'v1', method, data });
  const errorBody = (method: string, { code, message }: LegacyErrorSpec): string =>
    JSON.stringify({ apiversion: 'v1', method, error: { code, message } });
  /** The fixture error-map row of `type`: FIXTURE_ERROR_MAP for fixture-only types, LEGACY_ERROR_MAP for reused ones. */
  const rowOf = (type: ErrorType): LegacyErrorSpec =>
    Object.hasOwn(FIXTURE_ERROR_MAP, type) ? FIXTURE_ERROR_MAP[type as FixtureErrorType] : LEGACY_ERROR_MAP[type as Exclude<ErrorType, FixtureErrorType>];

  let t: TestApp;
  let tokens: Record<Caller, Record<string, string>>;

  beforeAll(async () => {
    const [templates, messages] = await Promise.all([
      vi.importActual<typeof import('../../src/domain/templates.js')>('../../src/domain/templates.js'),
      vi.importActual<typeof import('../../src/domain/messages.js')>('../../src/domain/messages.js'),
    ]);
    vi.mocked(listTemplates).mockImplementation(templates.listTemplates);
    vi.mocked(createTemplate).mockImplementation(templates.createTemplate);
    vi.mocked(listMessages).mockImplementation(messages.listMessages);
    vi.mocked(submitMessage).mockImplementation(messages.submitMessage);
    vi.mocked(getMessage).mockImplementation(messages.getMessage);
    const db = createRecordingDb(
      {
        message_template: [
          templateRow(TENANT_A, TEMPLATE_A1, 'Welcome', at(9, 0, 0)),
          templateRow(TENANT_A, TEMPLATE_A2, 'Reminder', at(10, 0, 0)),
          templateRow(TENANT_B, TEMPLATE_B, 'Welcome B', at(9, 0, 0)),
        ],
        message: [messageRow(TENANT_A, MESSAGE_A), messageRow(TENANT_B, MESSAGE_B)],
        // Stored out of order, with a recorded_at tie that status_id breaks.
        delivery_status: [
          statusRow(TENANT_A, 'C3000000-0000-0000-0000000000000003', MESSAGE_A, 'delivered', at(9, 0, 1), 'MP-1'),
          statusRow(TENANT_A, 'C1000000-0000-0000-0000000000000001', MESSAGE_A, 'queued', at(9, 0, 0)),
          statusRow(TENANT_A, 'C2000000-0000-0000-0000000000000002', MESSAGE_A, 'sent', at(9, 0, 1)),
          statusRow(TENANT_B, 'D1000000-0000-0000-0000000000000001', MESSAGE_B, 'queued', at(9, 0, 0)),
        ],
      },
      { clock: TEST_CLOCK },
    );
    t = await buildTestApp({ db });
    tokens = {
      sender: await headersFor(FIXTURE_ROLES.sender, { sub: SENDER_ID }),
      senderB: await headersFor(FIXTURE_ROLES.sender, { site: TENANT_B.siteId }),
      systemUser: await headersFor(Roles.systemUser),
    };
  });

  afterAll(async () => {
    await t?.app.close();
  });

  /** Injects `req` and returns its wire view, the row-changing statements it ran and its identity CSRF consume calls. */
  async function send({ method = 'GET', url, as, body, headers = {} }: Req) {
    const mark = t.db.transactions.length;
    const callMark = t.client.requests.length;
    const res = await t.app.inject({
      method,
      url,
      headers: { ...(as === undefined ? {} : tokens[as]), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return {
      status: res.statusCode,
      body: res.body,
      headers: res.headers,
      writes: t.db.transactions
        .slice(mark)
        .flatMap((tx) => tx.statements.map((statement) => statement.text))
        .filter((text) => WRITE_STATEMENT.test(text)),
      csrfCalls: t.client.requests.slice(callMark).filter((req) => req.path === CSRF_CONSUME_PATH).length,
    };
  }

  type Sent = Awaited<ReturnType<typeof send>>;

  /** Asserts envelope.cfc respond(): status, exact body, JSON content type, ETag = cfHash(body) and the legacy headers. */
  function expectFixtureResponse(res: Sent, status: number, body: string): void {
    expect(res.status).toBe(status);
    expect(res.body).toBe(body);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.headers['etag']).toBe(cfHash(res.body));
    // ACF 2023 hash() defaults to SHA-256, so the legacy ETag is 64 hex digits rather than MD5's 32.
    expect(res.headers['etag']).toMatch(/^[0-9A-F]{64}$/);
    expect(res.headers).toMatchObject(LEGACY_HEADERS);
  }

  it('names the envelope methods as api.cfm does, without the id segment', () => {
    expect([TEMPLATES_METHOD, MESSAGES_METHOD, fixtureMethod('Messages', '')]).toEqual([
      'communications.templates',
      'communications.messages',
      'communications.messages',
    ]);
  });

  describe('success envelope for a tenant-a sender', () => {
    it('lists one page of the site templates in the paged-list shape', async () => {
      const res = await send({ url: `${FIXTURE_PREFIX}/templates${SITE_A}&pageIndex=2&itemsPerPage=1`, as: 'sender' });
      const data = { items: [templateView(TEMPLATE_A2, 'Reminder', '2026-06-30T10:00:00')], startindex: 2, endindex: 2, itemsperpage: 1, totalitems: 2, totalpages: 2, pageindex: 2 };

      expectFixtureResponse(res, 200, successBody(TEMPLATES_METHOD, data));
      expect(Object.keys(JSON.parse(res.body) as object)).toEqual(['apiversion', 'method', 'data']);
      expect(res.writes).toEqual([]);
    });

    it('lists the site messages in the paged-list shape', async () => {
      const res = await send({ url: `${FIXTURE_PREFIX}/messages${SITE_A}`, as: 'sender' });
      const data = { items: [messageView(TENANT_A, MESSAGE_A)], startindex: 1, endindex: 1, itemsperpage: 50, totalitems: 1, totalpages: 1, pageindex: 1 };

      expectFixtureResponse(res, 200, successBody(MESSAGES_METHOD, data));
      expect(res.writes).toEqual([]);
    });

    it('reads a message detail with history ordered by recorded_at, then status_id', async () => {
      const res = await send({ url: `${FIXTURE_PREFIX}/messages/${MESSAGE_A}${SITE_A}`, as: 'sender' });
      const history = [
        historyView('C1000000-0000-0000-0000000000000001', MESSAGE_A, 'queued', '2026-06-30T09:00:00'),
        historyView('C2000000-0000-0000-0000000000000002', MESSAGE_A, 'sent', '2026-06-30T09:00:01'),
        historyView('C3000000-0000-0000-0000000000000003', MESSAGE_A, 'delivered', '2026-06-30T09:00:01', 'MP-1'),
      ];

      expectFixtureResponse(res, 200, successBody(MESSAGES_METHOD, { ...messageView(TENANT_A, MESSAGE_A), history }));
      expect(res.writes).toEqual([]);
    });

    it('stores a template once identity consumed the collection token, answering the stored row', async () => {
      const body = { name: 'Digest', subject: 'Weekly {{week}}', bodyText: 'Week {{week}}' };
      const res = await send({ method: 'POST', url: `${FIXTURE_PREFIX}/templates${SITE_A}`, as: 'sender', body, headers: CSRF });
      const id = (JSON.parse(res.body) as { data: { template_id: string } }).data.template_id;
      const view = {
        template_id: id,
        siteid: TENANT_A.siteId,
        name: 'Digest',
        subject: 'Weekly {{week}}',
        body_text: 'Week {{week}}',
        body_html: '',
        created: '2026-06-30T12:00:00',
        lastupdate: '2026-06-30T12:00:00',
      };

      expect(id).toMatch(CF_UUID);
      expectFixtureResponse(res, 200, successBody(TEMPLATES_METHOD, view));
      expect(res.csrfCalls).toBe(1);
      expect(res.writes.map((text) => text.split(' (')[0])).toEqual(['INSERT INTO "communications"."message_template"', 'INSERT INTO "communications"."changelog"']);
      expect(t.db.rows('message_template')).toContainEqual(expect.objectContaining({ tenant_id: TENANT_A.tenantId, template_id: id, name: 'Digest' }));
    });

    it('sends a templated message and answers its detail, history queued, sent, delivered, as a later read does', async () => {
      const body = { templateId: TEMPLATE_A1, to: 'bob@example.com', variables: { name: 'Bob' } };
      const res = await send({ method: 'POST', url: `${FIXTURE_PREFIX}/messages${SITE_A}`, as: 'sender', body, headers: CSRF });
      const { data } = JSON.parse(res.body) as { data: { message_id: string; history: { status_id: string }[] } };
      const id = data.message_id;
      const [queued = '', sent = '', delivered = ''] = data.history.map((entry) => entry.status_id);
      const detail = {
        message_id: id,
        siteid: TENANT_A.siteId,
        template_id: TEMPLATE_A1,
        to_address: 'bob@example.com',
        from_address: 'noreply@opt2.local',
        subject: 'Hello Bob',
        body_text: 'Hi Bob',
        body_html: '',
        state: 'delivered',
        created: '2026-06-30T12:00:00',
        sent_at: '2026-06-30T12:00:00',
        history: [
          historyView(queued, id, 'queued', '2026-06-30T12:00:00'),
          historyView(sent, id, 'sent', '2026-06-30T12:00:00'),
          historyView(delivered, id, 'delivered', '2026-06-30T12:00:00', `mailpit-${id}`),
        ],
      };

      for (const value of [id, queued, sent, delivered]) expect(value).toMatch(CF_UUID);
      expectFixtureResponse(res, 200, successBody(MESSAGES_METHOD, detail));
      expect(res.csrfCalls).toBe(1);
      expect(t.mail.sent.at(-1)).toMatchObject({ to: 'bob@example.com', subject: 'Hello Bob', text: 'Hi Bob', messageId: id });

      const read = await send({ url: `${FIXTURE_PREFIX}/messages/${id.toLowerCase()}${SITE_A}`, as: 'sender' });

      expectFixtureResponse(read, 200, res.body);
      expect(read.writes).toEqual([]);
    });
  });

  it.each(['templates', 'messages'])('answers a POST overridden to GET on %s exactly as the GET, writing nothing and consuming no token', async (resource) => {
    const url = `${FIXTURE_PREFIX}/${resource}${SITE_A}`;
    const get = await send({ url, as: 'sender' });
    const overridden = await send({
      method: 'POST',
      url,
      as: 'sender',
      body: { name: 'Ignored', to: 'ignored@example.com' },
      headers: { ...CSRF, 'x-http-method-override': 'GET' },
    });

    expectFixtureResponse(overridden, 200, get.body);
    expect(overridden.writes).toEqual([]);
    expect(overridden.csrfCalls).toBe(0);
  });

  it('answers a tenant-b message to a tenant-b sender, the tenant coming from the token', async () => {
    const res = await send({ url: `${FIXTURE_PREFIX}/messages/${MESSAGE_B}?siteid=${TENANT_B.siteId}`, as: 'senderB' });
    const history = [historyView('D1000000-0000-0000-0000000000000001', MESSAGE_B, 'queued', '2026-06-30T09:00:00')];

    expectFixtureResponse(res, 200, successBody(MESSAGES_METHOD, { ...messageView(TENANT_B, MESSAGE_B), history }));
  });

  it.each<[string, Req, ErrorType, string]>([
    ['an anonymous caller', { url: `${FIXTURE_PREFIX}/templates${SITE_A}` }, 'authorization', TEMPLATES_METHOD],
    ['a user without communications.sender', { url: `${FIXTURE_PREFIX}/templates${SITE_A}`, as: 'systemUser' }, 'forbidden', TEMPLATES_METHOD],
    ['a sender naming another site', { url: `${FIXTURE_PREFIX}/messages?siteid=${TENANT_B.siteId}`, as: 'sender' }, 'forbidden', MESSAGES_METHOD],
    ['an unknown site', { url: `${FIXTURE_PREFIX}/messages?siteid=nowhere`, as: 'sender' }, 'invalidParameters', MESSAGES_METHOD],
    ['an unknown message id', { url: `${FIXTURE_PREFIX}/messages/${UNKNOWN_ID}${SITE_A}`, as: 'sender' }, 'notFound', MESSAGES_METHOD],
    ['a tenant-b message id read by a tenant-a sender', { url: `${FIXTURE_PREFIX}/messages/${MESSAGE_B}${SITE_A}`, as: 'sender' }, 'notFound', MESSAGES_METHOD],
    [
      'a tenant-b template sent by a tenant-a sender',
      { method: 'POST', url: `${FIXTURE_PREFIX}/messages${SITE_A}`, as: 'sender', body: { templateId: TEMPLATE_B, to: 'bob@example.com' }, headers: CSRF },
      'notFound',
      MESSAGES_METHOD,
    ],
    [
      'a method the path does not declare',
      { url: `${FIXTURE_PREFIX}/templates${SITE_A}`, as: 'sender', headers: { 'x-http-method-override': 'DELETE' } },
      'notFound',
      TEMPLATES_METHOD,
    ],
    [
      'a template without a name',
      { method: 'POST', url: `${FIXTURE_PREFIX}/templates${SITE_A}`, as: 'sender', body: { subject: 'Hello', bodyText: 'Hi' }, headers: CSRF },
      'invalidParameters',
      TEMPLATES_METHOD,
    ],
    [
      'a message to an invalid address',
      { method: 'POST', url: `${FIXTURE_PREFIX}/messages${SITE_A}`, as: 'sender', body: { to: 'not-an-address', subject: 'Hello', bodyText: 'Hi' }, headers: CSRF },
      'invalidParameters',
      MESSAGES_METHOD,
    ],
    ['paging beyond 1000 items', { url: `${FIXTURE_PREFIX}/messages${SITE_A}&itemsPerPage=1001`, as: 'sender' }, 'invalidParameters', MESSAGES_METHOD],
    [
      'a write without CSRF tokens',
      { method: 'POST', url: `${FIXTURE_PREFIX}/templates${SITE_A}`, as: 'sender', body: { name: 'Digest', subject: 'Hello', bodyText: 'Hi' } },
      'invalidTokens',
      TEMPLATES_METHOD,
    ],
    [
      'in-range non-ASCII paging digits',
      { url: `${FIXTURE_PREFIX}/templates${SITE_A}&pageIndex=${encodeURIComponent('1٣')}`, as: 'sender' },
      'server_error',
      TEMPLATES_METHOD,
    ],
  ])('answers %s with its error-map row, writing nothing', async (_case, req, type, method) => {
    const res = await send(req);

    expectFixtureResponse(res, rowOf(type).status, errorBody(method, rowOf(type)));
    expect(Object.keys(JSON.parse(res.body) as object)).toEqual(['apiversion', 'method', 'error']);
    expect(res.writes).toEqual([]);
  });

  describe('api.cfm check order, with two checks failing at once', () => {
    it('answers an unknown resource under the prefix with 404 before checking the caller or the site', async () => {
      const res = await send({ url: `${FIXTURE_PREFIX}/subscribers?siteid=nowhere` });

      expect(res.status).toBe(404);
      // Status and method only: no cut-over entry routes such a path to communications, and service-kit's not-found
      // answers it in the JSON API error shape rather than envelope.cfc's.
      expect(JSON.parse(res.body)).toMatchObject({ apiversion: 'v1', method: 'invalid' });
      expect(res.writes).toEqual([]);
    });

    it.each<[string, Req, ErrorType, string]>([
      ['the site check precedes the login check', { method: 'POST', url: `${FIXTURE_PREFIX}/templates?siteid=nowhere`, body: {} }, 'invalidParameters', TEMPLATES_METHOD],
      ['the site check precedes the role check', { url: `${FIXTURE_PREFIX}/messages?siteid=nowhere`, as: 'systemUser' }, 'invalidParameters', MESSAGES_METHOD],
      [
        'the token-site check refuses another site to a caller without the role',
        { url: `${FIXTURE_PREFIX}/messages/${UNKNOWN_ID}?siteid=${TENANT_B.siteId}`, as: 'systemUser' },
        'forbidden',
        MESSAGES_METHOD,
      ],
      [
        'the site check precedes the method check',
        { url: `${FIXTURE_PREFIX}/templates?siteid=nowhere`, headers: { 'x-http-method-override': 'DELETE' } },
        'invalidParameters',
        TEMPLATES_METHOD,
      ],
      ['the login check precedes the existence check', { url: `${FIXTURE_PREFIX}/messages/${UNKNOWN_ID}${SITE_A}` }, 'authorization', MESSAGES_METHOD],
      ['the role check precedes the existence check', { url: `${FIXTURE_PREFIX}/messages/${UNKNOWN_ID}${SITE_A}`, as: 'systemUser' }, 'forbidden', MESSAGES_METHOD],
      ['the login check precedes validation', { method: 'POST', url: `${FIXTURE_PREFIX}/templates${SITE_A}`, body: {}, headers: CSRF }, 'authorization', TEMPLATES_METHOD],
      ['the role check precedes the CSRF check', { method: 'POST', url: `${FIXTURE_PREFIX}/messages${SITE_A}`, as: 'systemUser', body: {} }, 'forbidden', MESSAGES_METHOD],
      [
        'the CSRF check precedes the template existence check',
        { method: 'POST', url: `${FIXTURE_PREFIX}/messages${SITE_A}`, as: 'sender', body: { templateId: UNKNOWN_ID } },
        'invalidTokens',
        MESSAGES_METHOD,
      ],
      [
        'the existence check precedes an invalid filter',
        { url: `${FIXTURE_PREFIX}/messages/${UNKNOWN_ID}${SITE_A}&itemsPerPage=0`, as: 'sender' },
        'notFound',
        MESSAGES_METHOD,
      ],
      [
        'the template existence check precedes validation of the missing fields',
        { method: 'POST', url: `${FIXTURE_PREFIX}/messages${SITE_A}`, as: 'sender', body: { templateId: UNKNOWN_ID }, headers: CSRF },
        'notFound',
        MESSAGES_METHOD,
      ],
    ])('%s', async (_case, req, type, method) => {
      const res = await send(req);

      expectFixtureResponse(res, rowOf(type).status, errorBody(method, rowOf(type)));
      expect(res.writes).toEqual([]);
    });
  });

});

