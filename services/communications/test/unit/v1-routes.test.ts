// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** registerV1Routes through app.inject over in-memory domain doubles: declarations, tenancy from the token, bodies and error envelopes. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
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

interface Call {
  method: Method;
  url: string;
  /** Token roles; null sends no token. */
  roles?: readonly string[] | null;
  tenant?: TenantFixture;
  json?: Record<string, unknown>;
  form?: string;
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

  const called = (): Domain[] => (Object.keys(DOMAIN) as Domain[]).filter((name) => DOMAIN[name]().mock.calls.length > 0);

  /** Injects one gateway call, with a user token unless `roles` is null, and checks the answer against the contract. */
  async function inject({ method, url, roles = SENDER, tenant = TENANT_A, json, form }: Call) {
    const headers: Record<string, string> = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SCHEMA })}` };
    if (roles !== null) headers.authorization = `Bearer ${await mintUserToken({ site: tenant.siteId, roles, sub: USER_ID })}`;
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
      logger: createLogger({ service: SCHEMA, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    await registerV1Routes(app, { db, domain, mailDeps });
    await app.ready();
    outbound = vi.fn(() => Promise.reject(new Error('the /v1 routes call no other service')));
    vi.spyOn(app.opt2.client, 'request').mockImplementation(outbound);
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
  });

  beforeEach(() => {
    opened.length = 0;
    outbound.mockClear();
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
    expect(outbound).not.toHaveBeenCalled();
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
  )('%s %s denies %s before the domain', async (method, url, _case, roles, query, status) => {
    const res = await inject({ method, url: `${url}${query}`, roles, ...(method === 'POST' ? { json: { name: 'Welcome' } } : {}) });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(called()).toEqual([]);
    expect(opened).toEqual([]);
  });
});
