// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** registerV1Routes through app.inject over in-memory domain doubles: declarations, tenancy from the token, CSRF consumption, bodies and error envelopes. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger, validateLogRecord } from '@opt2/platform/logging';
import { withGatedTenant } from '@opt2/platform/migration-kit';
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
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  mintServiceToken,
  mintUserToken,
  testVerifier,
  type TenantFixture,
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
import type { CommunicationsRepository } from '../../src/repo/repository.js';
import type { MessageTemplateRow } from '../../src/repo/tables.js';
import { registerV1Routes } from '../../src/routes/v1.js';

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
const MESSAGE_ID = '7A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const SENDER = [Roles.systemUser, Roles.communicationsSender];

const TEMPLATES = '/v1/templates';
const MESSAGES = '/v1/messages';
const MESSAGE = `/v1/messages/${MESSAGE_ID}`;

const SESSION_ID = '0F1E2D3C-4B5A-6978-8796A5B4C3D2E1F0';
const CSRF_TOKEN = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const CSRF_EXPIRES = '260630120000123';
const CSRF_HEADERS: Readonly<Record<string, string>> = { 'x-csrf_token': CSRF_TOKEN, 'x-csrf_token_expires': CSRF_EXPIRES };
const INVALID_TOKENS = { code: 'invalid_request', message: 'Invalid CSRF tokens' };

const TEMPLATE_ROW: MessageTemplateRow = {
  tenant_id: TENANT_A.tenantId,
  template_id: TEMPLATE_ID,
  siteid: TENANT_A.siteId,
  name: 'Welcome',
  subject: 'Hello {{name}}',
  body_text: 'Hi {{name}}',
  body_html: '<p>Hi {{name}}</p>',
  created: new Date(2026, 5, 30, 9, 15, 7, 123),
  lastupdate: null,
};
const TEMPLATE_VIEW = {
  template_id: TEMPLATE_ID,
  siteid: TENANT_A.siteId,
  name: 'Welcome',
  subject: 'Hello {{name}}',
  body_text: 'Hi {{name}}',
  body_html: '<p>Hi {{name}}</p>',
  created: '2026-06-30T09:15:07',
  lastupdate: '',
};
const EDITED_TEMPLATE_ROW: MessageTemplateRow = { ...TEMPLATE_ROW, lastupdate: new Date(2026, 5, 30, 10, 0, 1, 500) };
const EDITED_TEMPLATE_VIEW = { ...TEMPLATE_VIEW, lastupdate: '2026-06-30T10:00:01' };

const MESSAGE_VIEW: MessageView = {
  message_id: MESSAGE_ID,
  siteid: TENANT_A.siteId,
  template_id: TEMPLATE_ID,
  to_address: 'ann@example.com',
  from_address: 'noreply@opt2.local',
  subject: 'Hello Ann',
  body_text: 'Hi Ann',
  body_html: '<p>Hi Ann</p>',
  state: 'failed',
  created: '2026-06-30T09:15:07',
  sent_at: '',
};
const DETAIL: MessageDetailView = {
  ...MESSAGE_VIEW,
  history: [
    { status_id: 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6', message_id: MESSAGE_ID, status: 'queued', detail: '', mailpit_id: '', recorded_at: '2026-06-30T09:15:07' },
    { status_id: 'C2B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6', message_id: MESSAGE_ID, status: 'failed', detail: 'smtp-error', mailpit_id: '', recorded_at: '2026-06-30T09:15:08' },
  ],
};

type Method = 'GET' | 'POST';
type Domain = 'listTemplates' | 'createTemplate' | 'listMessages' | 'submitMessage' | 'getMessage';

const DOMAIN: Readonly<Record<Domain, () => Mock>> = {
  listTemplates: () => vi.mocked(listTemplates) as Mock,
  createTemplate: () => vi.mocked(createTemplate) as Mock,
  listMessages: () => vi.mocked(listMessages) as Mock,
  submitMessage: () => vi.mocked(submitMessage) as Mock,
  getMessage: () => vi.mocked(getMessage) as Mock,
};

/** Each route with the domain function it calls. */
const ROUTES: ReadonlyArray<readonly [Method, string, Domain]> = [
  ['GET', TEMPLATES, 'listTemplates'],
  ['POST', TEMPLATES, 'createTemplate'],
  ['GET', MESSAGES, 'listMessages'],
  ['POST', MESSAGES, 'submitMessage'],
  ['GET', MESSAGE, 'getMessage'],
];

const WRITES = ROUTES.filter(([method]) => method === 'POST');
const READS = ROUTES.filter(([method]) => method === 'GET');

interface Call {
  method: Method;
  url: string;
  /** Token roles; null sends no token. */
  roles?: readonly string[] | null;
  tenant?: TenantFixture;
  json?: Record<string, unknown>;
  form?: string;
  /** CSRF request headers; a POST sends the issued pair unless given others. */
  csrf?: Readonly<Record<string, string>>;
}

describe('communications /v1 routes', () => {
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
  let app: FastifyInstance;
  let outbound: Mock;
  /** Every line the service logger wrote, parsed. */
  const logLines: Array<Record<string, unknown>> = [];
  /** Context identity issued each token for; a token is valid for that context alone. */
  let issued: Map<string, string>;
  /** `session token context` keys identity has consumed. */
  let consumed: Set<string>;
  let identityStatus: number;

  const called = (): Domain[] => (Object.keys(DOMAIN) as Domain[]).filter((name) => DOMAIN[name]().mock.calls.length > 0);

  /** Identity's consume verdict: valid once per session, token and context, for the context the token was issued for. */
  function consume(request: ServiceRequest): ServiceResponse {
    if (request.service !== IDENTITY_SERVICE || request.method !== 'POST' || request.path !== CSRF_CONSUME_PATH) {
      throw new Error(`the /v1 routes call no other service: ${request.method} ${request.service} ${request.path}`);
    }
    const { sessionId, token, context } = request.json as CsrfConsumeRequest;
    const key = `${sessionId} ${token} ${context}`;
    const valid = identityStatus === 200 && issued.get(token) === context && !consumed.has(key);
    if (valid) consumed.add(key);
    return { status: identityStatus, headers: {}, body: identityStatus === 200 ? { valid } : undefined };
  }

  /** Injects one gateway call, with a user token unless `roles` is null, and checks the answer against the contract. */
  async function inject({ method, url, roles = SENDER, tenant = TENANT_A, json, form, csrf = method === 'POST' ? CSRF_HEADERS : {} }: Call) {
    const headers: Record<string, string> = {
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SCHEMA })}`,
      ...csrf,
    };
    if (roles !== null) headers.authorization = `Bearer ${await mintUserToken({ site: tenant.siteId, roles, sub: USER_ID, sid: SESSION_ID })}`;
    let payload: string | undefined;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    } else if (form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = form;
    }
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
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
      logger: createLogger({
        service: SCHEMA,
        version: '1.0.0',
        env: 'local',
        destination: { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) },
      }),
    });
    await registerV1Routes(app, { db, domain, mailDeps });
    await app.ready();
    outbound = vi.fn((request: ServiceRequest) => Promise.resolve(consume(request)));
    vi.spyOn(app.opt2.client, 'request').mockImplementation(outbound);
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
  });

  beforeEach(() => {
    opened.length = 0;
    outbound.mockClear();
    issued = new Map([[CSRF_TOKEN, '']]);
    consumed = new Set();
    identityStatus = 200;
    vi.mocked(withGatedTenant).mockClear();
    for (const name of Object.keys(DOMAIN) as Domain[]) DOMAIN[name]().mockReset();
    const templatePage: TemplatePage = { list: [TEMPLATE_ROW, EDITED_TEMPLATE_ROW], pageIndex: 2, itemsPerPage: 2, totalItems: 4 };
    const messagePage: MessagePage = { list: [MESSAGE_VIEW], pageIndex: 1, itemsPerPage: 50, totalItems: 1 };
    vi.mocked(listTemplates).mockResolvedValue(templatePage);
    vi.mocked(createTemplate).mockResolvedValue(TEMPLATE_ROW);
    vi.mocked(listMessages).mockResolvedValue(messagePage);
    vi.mocked(submitMessage).mockResolvedValue(DETAIL);
    vi.mocked(getMessage).mockResolvedValue(DETAIL);
  });

  it('declares the five contract operations for communications.sender with the site check on', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/v1/'));
    expect(routes).toEqual(
      [
        ['GET', MESSAGES],
        ['POST', MESSAGES],
        ['GET', `${MESSAGES}/:messageId`],
        ['GET', TEMPLATES],
        ['POST', TEMPLATES],
      ].map(([method, url]) => ({ method, url, transport: 'service', requires: [Roles.communicationsSender], siteCheck: true })),
    );
    for (const { method, url, transport, requires } of routes) {
      const operation = OPENAPI.paths[url.replace(':messageId', '{messageId}')]?.[method.toLowerCase()] ?? {};
      expect([operation['x-opt2-transport'], operation['x-opt2-requires']]).toEqual([transport, requires]);
    }
  });

  it.each<[string, TenantFixture, string]>([
    ['a tenant-a sender naming its site', TENANT_A, '&siteid=tenant-a'],
    ['a tenant-b sender without a siteid', TENANT_B, ''],
  ])("lists the token tenant's templates for %s, dates to the second and a NULL lastupdate as ''", async (_case, tenant, siteQuery) => {
    const res = await inject({ method: 'GET', url: `${TEMPLATES}?pageIndex=2&itemsPerPage=2${siteQuery}`, tenant });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { items: [TEMPLATE_VIEW, EDITED_TEMPLATE_VIEW], startindex: 3, endindex: 4, itemsperpage: 2, totalitems: 4, totalpages: 2, pageindex: 2 },
    });
    const params = siteQuery === '' ? {} : { siteid: tenant.siteId };
    expect(DOMAIN.listTemplates().mock.calls).toEqual([[opened[0], { pageIndex: '2', itemsPerPage: '2', ...params, siteId: tenant.siteId }]]);
    expect(opened.map((tx) => tx.tenantId)).toEqual([tenant.tenantId]);
    expect(withGatedTenant).not.toHaveBeenCalled();
  });

  it.each<[string, Pick<Call, 'json' | 'form'>, Record<string, unknown>]>([
    ['a JSON body', { json: { name: 'Welcome', subject: 'Hello {{name}}', bodyText: 'Hi {{name}}' } }, { name: 'Welcome', subject: 'Hello {{name}}', bodyText: 'Hi {{name}}' }],
    ['a form body', { form: 'name=Welcome&subject=Hello+%7B%7Bname%7D%7D&bodyText=Hi' }, { name: 'Welcome', subject: 'Hello {{name}}', bodyText: 'Hi' }],
  ])('stores a template from %s in a gated transaction of the token tenant', async (_case, body, input) => {
    const res = await inject({ method: 'POST', url: TEMPLATES, ...body });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: TEMPLATE_VIEW });
    expect(vi.mocked(withGatedTenant).mock.calls).toEqual([[db, TENANT_A.tenantId, expect.any(Function)]]);
    expect(DOMAIN.createTemplate().mock.calls).toEqual([[opened[0], domain, { siteId: TENANT_A.siteId, userId: USER_ID, input }]]);
    expect(opened.map((tx) => tx.tenantId)).toEqual([TENANT_A.tenantId]);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("lists the token tenant's messages in the paged-list shape", async () => {
    const res = await inject({ method: 'GET', url: MESSAGES });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { items: [MESSAGE_VIEW], startindex: 1, endindex: 1, itemsperpage: 50, totalitems: 1, totalpages: 1, pageindex: 1 },
    });
    expect(DOMAIN.listMessages().mock.calls).toEqual([[opened[0], { siteId: TENANT_A.siteId }]]);
    expect(opened.map((tx) => tx.tenantId)).toEqual([TENANT_A.tenantId]);
  });

  it.each<[string, Pick<Call, 'json' | 'form'>, Record<string, unknown>]>([
    ['a JSON body', { json: { templateId: TEMPLATE_ID, variables: { name: 'Ann' }, to: 'ann@example.com' } }, { templateId: TEMPLATE_ID, variables: { name: 'Ann' }, to: 'ann@example.com' }],
    ['a form body', { form: `templateId=${TEMPLATE_ID}&variables=%7B%22name%22%3A%22Ann%22%7D&to=ann%40example.com` }, { templateId: TEMPLATE_ID, variables: '{"name":"Ann"}', to: 'ann@example.com' }],
  ])('submits a message from %s with the mail deps under the token tenant, site and user', async (_case, body, input) => {
    const res = await inject({ method: 'POST', url: MESSAGES, ...body });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: DETAIL });
    expect(DOMAIN.submitMessage().mock.calls).toEqual([[mailDeps, { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, userId: USER_ID, input }]]);
    expect(DOMAIN.submitMessage().mock.calls[0]?.[0]).toBe(mailDeps);
    expect(opened).toEqual([]);
  });

  it.each([MESSAGE_ID, MESSAGE_ID.toLowerCase()])('reads the detail of message %s under the token tenant, with the id as sent', async (id) => {
    const res = await inject({ method: 'GET', url: `${MESSAGES}/${id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: DETAIL });
    expect(DOMAIN.getMessage().mock.calls).toEqual([[opened[0], id]]);
    expect(opened.map((tx) => tx.tenantId)).toEqual([TENANT_A.tenantId]);
  });

  it.each<[Method, string, Domain]>([
    ['GET', MESSAGE, 'getMessage'],
    ['POST', MESSAGES, 'submitMessage'],
  ])('answers a fixture notFound from %s %s with the 404 envelope of communications.messages', async (method, url, name) => {
    DOMAIN[name]().mockRejectedValueOnce(new FixtureApiError('notFound'));

    const res = await inject({ method, url, ...(method === 'POST' ? { json: { templateId: TEMPLATE_ID, to: 'ann@example.com' } } : {}) });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      apiversion: 'v1',
      method: 'communications.messages',
      error: { code: FIXTURE_ERROR_MAP.notFound.code, message: FIXTURE_ERROR_MAP.notFound.message },
    });
  });

  it.each(ROUTES)('answers a domain invalidParameters on %s %s with the legacy 400', async (method, url, name) => {
    DOMAIN[name]().mockRejectedValueOnce(new LegacyApiError('invalidParameters'));

    const res = await inject({ method, url, ...(method === 'POST' ? { json: {} } : {}) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(called()).toEqual([name]);
  });

  it('answers a closed gate on a template write with the legacy 503', async () => {
    DOMAIN.createTemplate().mockRejectedValueOnce(new LegacyServiceUnavailableError('gate closed', 'auto', 'unit-gate-closed'));

    const res = await inject({ method: 'POST', url: TEMPLATES, json: { name: 'Welcome' } });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
  });

  it.each(
    ROUTES.flatMap(([method, url]) =>
      (
        [
          ['an anonymous caller', null, '', 401],
          ['a user without communications.sender', [Roles.systemUser, Roles.surveysManager], '', 403],
          ['a sender naming another site', SENDER, '?siteid=tenant-b', 403],
        ] as const
      ).map((c) => [method, url, ...c] as const),
    ),
  )('%s %s denies %s before its CSRF token and the domain', async (method, url, _case, roles, query, status) => {
    const res = await inject({ method, url: `${url}${query}`, roles, ...(method === 'POST' ? { json: { name: 'Welcome' } } : {}) });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(called()).toEqual([]);
    expect(opened).toEqual([]);
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each(WRITES)("%s %s has identity consume the posted pair for the empty context in the token's session first", async (method, url, name) => {
    const res = await inject({ method, url, json: { name: 'Welcome' } });

    expect(res.statusCode).toBe(200);
    expect(outbound.mock.calls).toEqual([
      [{ service: IDENTITY_SERVICE, method: 'POST', path: CSRF_CONSUME_PATH, json: { sessionId: SESSION_ID, token: CSRF_TOKEN, expires: CSRF_EXPIRES, context: '' } }],
    ]);
    expect(outbound.mock.invocationCallOrder[0]).toBeLessThan(DOMAIN[name]().mock.invocationCallOrder[0] ?? 0);
  });

  it.each(WRITES)('%s %s takes the pair from the csrf_token form fields when no header carries it', async (method, url, name) => {
    const form = `name=Welcome&csrf_token=${CSRF_TOKEN}&csrf_token_expires=${CSRF_EXPIRES}`;
    const res = await inject({ method, url, form, csrf: {} });

    expect(res.statusCode).toBe(200);
    expect(outbound.mock.calls[0]?.[0]).toMatchObject({ json: { token: CSRF_TOKEN, expires: CSRF_EXPIRES, context: '' } });
    expect(called()).toEqual([name]);
  });

  it.each(
    WRITES.flatMap(([method, url]) =>
      (
        [
          ['no token', {}, 0],
          ['a token without its expiry', { 'x-csrf_token': CSRF_TOKEN }, 0],
          ['an empty token', { 'x-csrf_token': '', 'x-csrf_token_expires': CSRF_EXPIRES }, 0],
          ['a token issued for another context', { 'x-csrf_token': 'B'.repeat(32), 'x-csrf_token_expires': CSRF_EXPIRES }, 1],
        ] as const
      ).map((c) => [method, url, ...c] as const),
    ),
  )('%s %s answers %s with invalidTokens and writes nothing', async (method, url, _case, csrf, consumeCalls) => {
    issued.set('B'.repeat(32), TEMPLATE_ID);

    const res = await inject({ method, url, json: { name: 'Welcome' }, csrf });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: INVALID_TOKENS });
    expect(outbound).toHaveBeenCalledTimes(consumeCalls);
    expect(called()).toEqual([]);
    expect(opened).toEqual([]);
    expect(withGatedTenant).not.toHaveBeenCalled();
  });

  it.each(WRITES)('%s %s accepts a token once and answers its replay with invalidTokens', async (method, url, name) => {
    const first = await inject({ method, url, json: { name: 'Welcome' } });
    const replay = await inject({ method, url, json: { name: 'Welcome' } });

    expect([first.statusCode, replay.statusCode]).toEqual([200, 400]);
    expect(replay.json()).toMatchObject({ apiversion: 'v1', error: INVALID_TOKENS });
    expect(DOMAIN[name]().mock.calls).toHaveLength(1);
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it.each(WRITES)('%s %s answers the legacy 503 and writes nothing when identity cannot consume the token', async (method, url) => {
    identityStatus = 503;

    const res = await inject({ method, url, json: { name: 'Welcome' } });

    expect(res.statusCode).toBe(503);
    expect(called()).toEqual([]);
    expect(opened).toEqual([]);
  });

  it.each(READS)('%s %s consumes no CSRF token, even one sent with it', async (method, url, name) => {
    const res = await inject({ method, url, csrf: CSRF_HEADERS });

    expect(res.statusCode).toBe(200);
    expect(outbound).not.toHaveBeenCalled();
    expect(called()).toEqual([name]);
  });

  const NUL_REFUSAL = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021', severity: 'ERROR' });
  const PROBE_MESSAGE = { templateId: TEMPLATE_ID, to: 'reason-probe@example.com' };

  it.each<[string, Call, unknown, number, string | null]>([
    ['a refused CSRF token', { method: 'POST', url: TEMPLATES, json: { name: 'reason-probe' }, csrf: {} }, undefined, 400, 'request rejected: invalidTokens'],
    ['an anonymous caller', { method: 'GET', url: TEMPLATES, roles: null }, undefined, 401, 'request denied: missing-credential'],
    ['a user without communications.sender', { method: 'GET', url: MESSAGES, roles: [Roles.systemUser] }, undefined, 403, 'request denied: forbidden'],
    ['a sender naming another site', { method: 'GET', url: `${TEMPLATES}?siteid=tenant-b` }, undefined, 403, 'request denied: site-mismatch'],
    ['a domain validation failure', { method: 'POST', url: TEMPLATES, json: { name: ' ' } }, new LegacyApiError('invalidParameters'), 400, 'request rejected: invalidParameters'],
    [
      'a fixture refusal whose message carries request text',
      { method: 'POST', url: MESSAGES, json: PROBE_MESSAGE },
      new FixtureApiError('invalidParameters', 'reason-probe@example.com'),
      400,
      'request rejected: invalidParameters',
    ],
    ['a fixture forbidden', { method: 'GET', url: MESSAGE }, new FixtureApiError('forbidden'), 403, 'request denied: forbidden'],
    ['a value PostgreSQL cannot store', { method: 'POST', url: MESSAGES, json: PROBE_MESSAGE }, NUL_REFUSAL, 400, 'request rejected: 22021'],
    ['a fixture notFound', { method: 'GET', url: MESSAGE }, new FixtureApiError('notFound'), 404, null],
  ])('logs %s with its fixed reason, if any, ahead of the completion line', async (_case, request, rejection, status, warning) => {
    if (rejection !== undefined) for (const name of Object.keys(DOMAIN) as Domain[]) DOMAIN[name]().mockRejectedValueOnce(rejection);
    const before = logLines.length;

    const res = await inject(request);
    const lines = logLines.slice(before);

    expect(res.statusCode).toBe(status);
    expect(lines.filter(({ severity, message }) => severity === 'WARNING' || message === 'request completed').map(({ severity, message }) => [severity, message])).toStrictEqual([
      ...(warning === null ? [] : [['WARNING', warning]]),
      ['INFO', 'request completed'],
    ]);
    expect(lines.filter(({ severity }) => severity === 'ERROR')).toEqual([]);
    for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
    expect(JSON.stringify(lines)).not.toMatch(/reason-probe|invalid byte sequence|0x00/);
  });
});
