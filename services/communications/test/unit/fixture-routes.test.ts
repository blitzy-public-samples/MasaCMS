// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * registerFixtureRoutes through app.inject over in-memory domain doubles: declarations, method dispatch, tenancy, CSRF and envelopes;
 * then over PostgreSQL, values it cannot store.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
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
import { FIXTURE_ERROR_MAP, FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import { createCommunicationsRepository, type CommunicationsRepository } from '../../src/repo/repository.js';
import { UNITS, type MessageTemplateRow } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX, registerFixtureRoutes } from '../../src/routes/fixture.js';

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
