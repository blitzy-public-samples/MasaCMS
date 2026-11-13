/** Provider contract of the gateway: buildApp's registered routes against contracts/openapi.yaml, and every operation's responses. */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, rolesForService } from '@opt2/platform/auth';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier, type InjectResponse } from '@opt2/platform/testing';
import { SERVICE_VERSION } from '../../src/app.js';
import { EDGE_METHODS } from '../../src/dispatcher/dispatch.js';
import { RELAY_METHODS } from '../../src/dispatcher/relay.js';
import { INSTANCE_ID, SERVICE, serviceHeaders, startGatewayHarness, type GatewayHarness } from '../helpers/gateway-app.js';

type Json = Record<string, unknown>;
type Headers = Record<string, string>;

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
}

/** One contract operation with its auth declaration. */
interface ContractOperation {
  operationId: string;
  method: string;
  template: string;
  responses: Json;
  transport: unknown;
  requires: string[] | undefined;
  public: boolean;
  edge: boolean;
}

/** One request against an operation and the declared response key (a status or a range such as `2XX`) it must answer. */
interface Case {
  operationId: string;
  status: string;
  title: string;
  request(h: GatewayHarness): Promise<InjectOptions>;
  before?(h: GatewayHarness): void | Promise<void>;
  after?(h: GatewayHarness): void | Promise<void>;
  verify?(res: InjectResponse, body: unknown, h: GatewayHarness): void | Promise<void>;
}

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const HTTP_METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as const;
const FREEZE_ROUTE = 'admin:cdashboard.main';
const UNKNOWN_ROUTE = 'admin:nosuch.action';
const CONTENT_PATH = '/_api/json/v1/default/content/C1';
const MISSING_PATH = '/_api/json/v1/default/content/missing';
const RELAY_PATH = '/internal/v1/relay/people/opt2/people/ping';
const STUB_PATH = '/opt2/stub/notes';
const USED_AT = '2026-06-30T12:00:00.000';
const MARKED_SESSION = 'ids-contract-marked';
const STALE_SESSION = 'ids-contract-stale';
const DEAD_INSTANCE = 'gw-contract-dead';

/** Every operation of the contract, keyed by operationId. */
const OPERATIONS: ReadonlyMap<string, ContractOperation> = new Map(
  Object.entries(DOC.paths).flatMap(([template, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = item[method] as Json | undefined;
      if (operation === undefined) return [];
      const entry: ContractOperation = {
        operationId: String(operation.operationId),
        method: method.toUpperCase(),
        template,
        responses: (operation.responses ?? {}) as Json,
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'] as string[] | undefined,
        public: operation['x-opt2-public'] === true,
        edge: operation['x-opt2-edge'] === true,
      };
      return [[entry.operationId, entry] as const];
    }),
  ),
);

function operationOf(operationId: string): ContractOperation {
  const operation = OPERATIONS.get(operationId);
  if (operation === undefined) throw new TypeError(`contract has no operation ${operationId}`);
  return operation;
}

/** A concrete path the operation's template matches, each parameter one segment. */
function locatorPath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => name);
}

/** Contract template of a Fastify route url: `:name(re)` and `:name` are `{name}`, `::` a literal colon, a trailing `*` `{path}`. */
function templateOf(url: string): string {
  return url
    .replace(/:([A-Za-z_]\w*)(\([^)]*\))?(?=::|\/|$)/g, '{$1}')
    .replace(/::/g, ':')
    .replace(/\*$/, '{path}');
}

/** The declared response key a status selects: the status, its range, else `default`. */
function statusKeyOf(operation: ContractOperation, status: number): string | undefined {
  return [String(status), `${String(status).charAt(0)}XX`, 'default'].find((key) => key in operation.responses);
}

/** Follows local `$ref`s from a response node to the response it names. */
function resolved(node: unknown): Json {
  let current = node as Json;
  for (let hops = 0; typeof current.$ref === 'string' && hops < 10; hops++) {
    current = (current.$ref as string)
      .slice(2)
      .split('/')
      .reduce<unknown>((at, segment) => (at as Json)[segment.replace(/~1/g, '/').replace(/~0/g, '~')], DOC) as Json;
  }
  return current;
}

function mediaTypeOf(header: string | string[] | number | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value === undefined ? undefined : String(value).split(';')[0]?.trim().toLowerCase();
}

/**
 * Validates a response against its operation. A HEAD answer or a response without body and content type has no payload:
 * its status and any content type must be declared, and a body-less one only matches the pass-through response
 * (any media type, empty schema).
 */
function expectContract(operation: ContractOperation, res: InjectResponse): unknown {
  const contentType = res.headers['content-type'];
  const bodiless = operation.method === 'HEAD' || (res.body === '' && contentType === undefined);
  if (!bodiless) {
    return assertResponseMatchesOpenApi(DOC, {
      method: operation.method,
      path: locatorPath(operation.template),
      status: res.statusCode,
      contentType,
      body: res.body,
    });
  }
  const key = statusKeyOf(operation, res.statusCode);
  expect(key, `${operation.operationId} declares status ${res.statusCode}`).toBeDefined();
  const content = resolved(operation.responses[key as string]).content as Json | undefined;
  const mediaType = mediaTypeOf(contentType);
  if (content === undefined) return undefined;
  const declared = Object.keys(content).map((media) => media.toLowerCase());
  if (mediaType !== undefined) {
    expect(declared.some((media) => [mediaType, mediaType.replace(/\/.*$/, '/*'), '*/*'].includes(media))).toBe(true);
  } else {
    expect(declared).toEqual(['*/*']);
    expect((content['*/*'] as Json).schema).toEqual({});
  }
  return undefined;
}

async function userToken(site = 'tenant-a', roles: readonly string[] = [Roles.systemUser]): Promise<string> {
  return mintUserToken({ sub: `contract-${site}`, site, roles });
}

/** A browser's user token beside the gateway's own invocation credential, as identity-backed calls arrive. */
async function userHeaders(site = 'tenant-a'): Promise<Headers> {
  return { authorization: `Bearer ${await userToken(site)}`, ...(await serviceHeaders('gateway')) };
}

/** User token of the last relayed web call, which the callee must receive unchanged. */
let relayedUserToken = '';

/** Legacy requests a client could have caused, counted before a case that must reach legacy with none. */
let legacyBefore = 0;

async function webWithUser(): Promise<Headers> {
  relayedUserToken = await userToken();
  return { authorization: `Bearer ${relayedUserToken}`, ...(await serviceHeaders('web')) };
}

function bodyOf(res: InjectResponse): Json {
  return res.json<Json>();
}

/** Seeds a jar row mapping `sessionId` to the legacy session the cookies attach. */
function seedJar(h: GatewayHarness, sessionId: string, legacySessionId: string, cfid: string, cftoken: string): void {
  h.db.tables.jars.set(sessionId, {
    sessionId,
    legacySessionId,
    cookies: {
      CFID: { name: 'CFID', value: cfid, attributes: 'Path=/;HttpOnly' },
      CFTOKEN: { name: 'CFTOKEN', value: cftoken, attributes: 'Path=/;HttpOnly' },
    },
    mode: 'legacy-primary',
    hydratedEpoch: null,
    updatedAt: new Date(),
    identityEndPendingAt: null,
  });
}

const tokenEntry = (token: string): { token: string; usedAt: string } => ({ token, usedAt: USED_AT });
const MARKED_TOKEN = randomBytes(32).toString('hex').toUpperCase();

function credentialCases(operationId: string, url: string, method: 'GET' | 'POST', payload: unknown, wrongCaller: string): Case[] {
  return [
    {
      operationId,
      status: '401',
      title: 'without an invocation credential',
      request: async () => ({ method, url, ...(method === 'POST' ? { payload: payload as object } : {}) }),
    },
    {
      operationId,
      status: '403',
      title: `as ${wrongCaller}, which holds none of the required roles`,
      request: async () => ({
        method,
        url,
        headers: wrongCaller === 'user' ? await userHeaders() : await serviceHeaders(wrongCaller),
        ...(method === 'POST' ? { payload: payload as object } : {}),
      }),
    },
  ];
}

const ACTIVATE = '/internal/v1/cutover/activate';
const FREEZE = '/internal/v1/cutover/freeze';
const UNFREEZE = '/internal/v1/cutover/unfreeze';
const STATUS = '/internal/v1/cutover/status';
const CLEAR = '/internal/v1/inflight:clear-orphans';
const markUsedUrl = (sid: string): string => `/internal/v1/legacy-sessions/${sid}:mark-used`;

const CONTROL_CASES: Case[] = [
  {
    operationId: 'healthz',
    status: '200',
    title: 'anonymous liveness',
    request: async () => ({ method: 'GET', url: '/healthz' }),
    verify: (_res, body) => expect(body).toEqual({ status: 'ok' }),
  },
  {
    operationId: 'healthz',
    status: '401',
    title: 'with a bearer that is no user token',
    request: async () => ({ method: 'GET', url: '/healthz', headers: { authorization: 'Bearer not-a-token' } }),
  },
  {
    operationId: 'healthz',
    status: '403',
    title: "with a siteid other than the user token's site",
    request: async () => ({ method: 'GET', url: '/healthz?siteid=tenant-b', headers: await userHeaders('tenant-a') }),
  },
  ...credentialCases('cutoverActivate', ACTIVATE, 'POST', { tableVersion: 'v0001' }, 'web'),
  {
    operationId: 'cutoverActivate',
    status: '400',
    title: 'a malformed table version',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await serviceHeaders('operator'), payload: { tableVersion: 'one' } }),
    verify: (_res, body) => expect(body).toMatchObject({ apiversion: 'v1', error: { code: expect.any(String) } }),
  },
  {
    operationId: 'cutoverActivate',
    status: '400',
    title: 'a version without a file',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await serviceHeaders('operator'), payload: { tableVersion: 'v0009' } }),
    verify: (_res, body) => expect(body).toMatchObject({ findings: [{ rule: 'unknown-version' }] }),
  },
  {
    operationId: 'cutoverActivate',
    status: '200',
    title: 'v0001 as the first version',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await serviceHeaders('operator'), payload: { tableVersion: 'v0001' } }),
    verify: (_res, body, h) => {
      expect(body).toEqual({ tableVersion: 'v0001', epoch: 1 });
      expect(h.db.tables.state).toMatchObject({ tableVersion: 'v0001', previousVersion: null, epoch: 1n, activatedBy: 'operator' });
    },
  },
  {
    operationId: 'cutoverActivate',
    status: '409',
    title: 'v0001 again, whose previous is no longer active',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await serviceHeaders('operator'), payload: { tableVersion: 'v0001' } }),
    verify: (_res, body, h) => {
      expect(body).toMatchObject({ findings: [{ rule: 'previous-mismatch' }] });
      expect(h.db.tables.state.epoch).toBe(1n);
    },
  },
  {
    operationId: 'cutoverActivate',
    status: '200',
    title: 'v0002 after v0001',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await serviceHeaders('operator'), payload: { tableVersion: 'v0002' } }),
    verify: (_res, body) => expect(body).toEqual({ tableVersion: 'v0002', epoch: 2 }),
  },
  ...(['operator', 'migration'] as const).map(
    (caller): Case => ({
      operationId: 'cutoverStatus',
      status: '200',
      title: `as ${caller}`,
      request: async () => ({ method: 'GET', url: STATUS, headers: await serviceHeaders(caller) }),
      verify: (_res, body) => {
        expect(body).toMatchObject({
          tableVersion: 'v0002',
          previous: 'v0001',
          epoch: 2,
          frozen: [],
          acknowledgedEpoch: 2,
          inflight: [],
          sessionMode: 'legacy-primary',
        });
        expect((body as { instances: unknown[] }).instances).toContainEqual(
          expect.objectContaining({ instanceId: INSTANCE_ID, seenEpoch: 2, live: true }),
        );
      },
    }),
  ),
  ...credentialCases('cutoverStatus', STATUS, 'GET', undefined, 'web'),
  {
    operationId: 'cutoverFreeze',
    status: '200',
    title: 'an entry of the active version',
    request: async () => ({ method: 'POST', url: FREEZE, headers: await serviceHeaders('operator'), payload: { routes: [FREEZE_ROUTE] } }),
    verify: (_res, body, h) => {
      expect(body).toMatchObject({ tableVersion: 'v0002', epoch: 3, frozen: [FREEZE_ROUTE] });
      expect([...h.db.tables.freezes.keys()]).toEqual([FREEZE_ROUTE]);
    },
  },
  {
    operationId: 'cutoverFreeze',
    status: '400',
    title: 'a route the active version lacks, rolling its epoch back',
    request: async () => ({ method: 'POST', url: FREEZE, headers: await serviceHeaders('operator'), payload: { routes: [UNKNOWN_ROUTE] } }),
    verify: (_res, body, h) => {
      expect(body).toMatchObject({ findings: [{ rule: 'unknown-route', route: UNKNOWN_ROUTE }] });
      expect(h.db.tables.state.epoch).toBe(3n);
    },
  },
  ...credentialCases('cutoverFreeze', FREEZE, 'POST', { routes: [FREEZE_ROUTE] }, 'migration'),
  {
    operationId: 'cutoverUnfreeze',
    status: '200',
    title: 'the frozen entry',
    request: async () => ({ method: 'POST', url: UNFREEZE, headers: await serviceHeaders('operator'), payload: { routes: [FREEZE_ROUTE] } }),
    verify: (_res, body, h) => {
      expect(body).toMatchObject({ epoch: 4, frozen: [] });
      expect(h.db.tables.freezes.size).toBe(0);
    },
  },
  {
    operationId: 'cutoverUnfreeze',
    status: '400',
    title: 'a route neither frozen nor in the active version',
    request: async () => ({ method: 'POST', url: UNFREEZE, headers: await serviceHeaders('operator'), payload: { routes: [UNKNOWN_ROUTE] } }),
    verify: (_res, body) => expect(body).toMatchObject({ findings: [{ rule: 'unknown-route' }] }),
  },
  ...credentialCases('cutoverUnfreeze', UNFREEZE, 'POST', { routes: [FREEZE_ROUTE] }, 'migration'),
  {
    operationId: 'inflightClearOrphans',
    status: '200',
    title: "a dead instance's legacy-side row after a legacy restart",
    before: (h) => {
      const startedAt = new Date(Date.now() - 600_000);
      h.db.tables.instances.set(DEAD_INSTANCE, {
        instanceId: DEAD_INSTANCE,
        seenEpoch: 1n,
        startedAt,
        heartbeatAt: startedAt,
      });
      h.db.tables.inflight.set(`${DEAD_INSTANCE}\u0000r-1`, {
        instanceId: DEAD_INSTANCE,
        requestId: 'r-1',
        route: 'page:render',
        side: 'legacy',
        windowId: null,
        startedAt,
      });
    },
    request: async () => ({
      method: 'POST',
      url: CLEAR,
      headers: await serviceHeaders('migration'),
      payload: { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'restart-1', at: new Date().toISOString() } },
    }),
    verify: (_res, body, h) => {
      expect(body).toEqual({ cleared: 1 });
      expect(h.db.tables.inflight.size).toBe(0);
    },
  },
  {
    operationId: 'inflightClearOrphans',
    status: '400',
    title: 'target-side clearing with legacy-restart evidence',
    request: async () => ({
      method: 'POST',
      url: CLEAR,
      headers: await serviceHeaders('operator'),
      payload: { side: 'target', evidence: { kind: 'legacy-restart', holderId: 'restart-1', at: new Date().toISOString() } },
    }),
  },
  ...credentialCases(
    'inflightClearOrphans',
    CLEAR,
    'POST',
    { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'restart-1', at: USED_AT.concat('+00:00') } },
    'web',
  ),
  {
    operationId: 'legacySessionMarkUsed',
    status: '204',
    title: "into the mapped legacy session's ledger",
    before: (h) => {
      const { session } = h.legacy.openSession();
      seedJar(h, MARKED_SESSION, session.sessionId, session.cfid, session.cftoken);
    },
    request: async () => ({
      method: 'POST',
      url: markUsedUrl(MARKED_SESSION),
      headers: await serviceHeaders('identity'),
      payload: { tokens: [tokenEntry(MARKED_TOKEN)] },
    }),
    verify: (_res, _body, h) => {
      const legacySessionId = h.db.tables.jars.get(MARKED_SESSION)?.legacySessionId ?? '';
      expect(h.legacy.sessions.get(legacySessionId)?.usedTokens).toEqual([tokenEntry(MARKED_TOKEN)]);
    },
  },
  {
    operationId: 'legacySessionMarkUsed',
    status: '400',
    title: 'a token that is not 64 hex digits',
    request: async () => ({
      method: 'POST',
      url: markUsedUrl(MARKED_SESSION),
      headers: await serviceHeaders('identity'),
      payload: { tokens: [tokenEntry('not-a-token')] },
    }),
  },
  {
    operationId: 'legacySessionMarkUsed',
    status: '404',
    title: 'a session without a jar',
    request: async () => ({
      method: 'POST',
      url: markUsedUrl('ids-contract-unknown'),
      headers: await serviceHeaders('identity'),
      payload: { tokens: [tokenEntry(MARKED_TOKEN)] },
    }),
  },
  {
    operationId: 'legacySessionMarkUsed',
    status: '503',
    title: 'a jar whose legacy session the bridge no longer attaches',
    before: (h) => seedJar(h, STALE_SESSION, 'masacms_1_2', '1', '2'),
    request: async () => ({
      method: 'POST',
      url: markUsedUrl(STALE_SESSION),
      headers: await serviceHeaders('identity'),
      payload: { tokens: [tokenEntry(MARKED_TOKEN)] },
    }),
  },
  ...credentialCases('legacySessionMarkUsed', markUsedUrl(MARKED_SESSION), 'POST', { tokens: [tokenEntry(MARKED_TOKEN)] }, 'operator'),
];

const relayOperation = (method: string): string => `relay${method.charAt(0)}${method.slice(1).toLowerCase()}`;
const edgeOperation = (method: string): string => `edge${method.charAt(0)}${method.slice(1).toLowerCase()}`;
const withBody = (method: string): Partial<InjectOptions> =>
  method === 'GET' || method === 'HEAD' || method === 'DELETE' || method === 'OPTIONS'
    ? {}
    : { payload: 'contract-body', headers: { 'content-type': 'text/plain' } };

const RELAY_CASES: Case[] = RELAY_METHODS.flatMap((method): Case[] => [
  {
    operationId: relayOperation(method),
    status: '2XX',
    title: "web's call with a user token",
    request: async () => {
      const body = withBody(method);
      return { method, url: RELAY_PATH, ...body, headers: { ...body.headers, ...(await webWithUser()) } };
    },
    verify: async (_res, body) => {
      const echo = body as { method: string; path: string; authorization?: string; serverlessAuthorization?: string };
      expect({ method: echo.method, path: echo.path, authorization: echo.authorization }).toEqual({
        method,
        path: '/opt2/people/ping',
        authorization: `Bearer ${relayedUserToken}`,
      });
      const caller = await testVerifier('people').invocationVerifier.verify(String(echo.serverlessAuthorization));
      expect(caller.name).toBe(SERVICE);
    },
  },
  ...credentialCases(relayOperation(method), RELAY_PATH, 'GET', undefined, 'gateway').map((c) => ({
    ...c,
    request: async (h: GatewayHarness) => ({ ...(await c.request(h)), method }),
  })),
  {
    operationId: relayOperation(method),
    status: '404',
    title: 'an unknown service',
    request: async () => ({ method, url: '/internal/v1/relay/nosuch/x', headers: await serviceHeaders('web') }),
  },
  {
    operationId: relayOperation(method),
    status: '503',
    title: 'a callee answering 503',
    before: (h) => h.target('people').setMode('503'),
    after: (h) => h.target('people').setMode('ok'),
    request: async () => ({ method, url: RELAY_PATH, headers: await serviceHeaders('web') }),
    verify: (_res, body) => expect(body).toMatchObject({ error: { code: 'server_error' } }),
  },
]);

const EDGE_CASES: Case[] = [
  ...EDGE_METHODS.flatMap((method): Case[] => [
    {
      operationId: edgeOperation(method),
      status: '2XX',
      title: 'a legacy JSON API read, passed through',
      request: async () => ({ method, url: CONTENT_PATH, ...withBody(method) }),
      verify: (_res, _body, h) => expect(h.legacy.pages().at(-1)).toMatchObject({ method, path: CONTENT_PATH }),
    },
    {
      operationId: edgeOperation(method),
      status: '4XX',
      title: "legacy's own 404, passed through",
      request: async () => ({ method, url: MISSING_PATH, ...withBody(method) }),
    },
    {
      operationId: edgeOperation(method),
      status: '503',
      title: 'a target entry whose owner answers 503, never retried on legacy',
      before: async (h) => {
        await h.target('stub').setMode('503');
        legacyBefore = h.legacy.pages().length;
      },
      after: (h) => h.target('stub').setMode('ok'),
      request: async () => ({ method, url: STUB_PATH, ...withBody(method) }),
      verify: (res, _body, h) => {
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(h.legacy.pages()).toHaveLength(legacyBefore);
      },
    },
  ]),
  {
    operationId: 'edgeGet',
    status: '2XX',
    title: 'a web screen of the active version',
    request: async () => ({ method: 'GET', url: '/opt2/admin/finance/claims' }),
    verify: (_res, _body, h) => expect(h.target('web').requests.at(-1)?.path).toBe('/opt2/admin/finance/claims'),
  },
  {
    operationId: 'edgeGet',
    status: '4XX',
    title: 'the legacy bridge from outside, answered by the gateway',
    before: (h) => {
      legacyBefore = h.legacy.forwarded().length;
    },
    request: async () => ({ method: 'GET', url: '/gateway/legacy-bridge/cfml/session.cfm?op=describe' }),
    verify: (res, _body, h) => {
      expect(res.statusCode).toBe(404);
      expect(h.legacy.forwarded()).toHaveLength(legacyBefore);
    },
  },
  {
    operationId: 'edgeGet',
    status: '503',
    title: 'an admin legacy-write whose window cannot open, as the legacy error page',
    before: (h) => {
      h.migration.setOpen({ status: 503 });
      legacyBefore = h.legacy.pages().length;
    },
    after: (h) => h.migration.setOpen('ok'),
    request: async () => ({ method: 'GET', url: '/admin/?muraAction=carch.importcontent' }),
    verify: (res, _body, h) => {
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(h.legacy.pages()).toHaveLength(legacyBefore);
    },
  },
];

const CASES: readonly Case[] = [...CONTROL_CASES, ...RELAY_CASES, ...EDGE_CASES];

let h: GatewayHarness;

beforeAll(async () => {
  h = await startGatewayHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('gateway contract document', () => {
  it('is OpenAPI 3.1.0 at the package version and the pinned source SHA', () => {
    expect({ openapi: DOC.openapi, version: DOC.info.version, sha: DOC.info['x-source-sha'] }).toEqual({
      openapi: '3.1.0',
      version: SERVICE_VERSION,
      sha: PIN.sha,
    });
  });

  it('declares exactly the routes buildApp registers, with their transport, roles, public and edge flags', () => {
    const registered = collectRouteMatrix(h.app).routes.map((route) => ({
      method: route.method,
      template: templateOf(route.url),
      transport: route.transport,
      requires: route.requires === undefined ? undefined : [...route.requires].sort(),
      public: route.public === true,
      edge: route.edge === true,
    }));
    const declared = [...OPERATIONS.values()].map((operation) => ({
      method: operation.method,
      template: operation.template,
      transport: operation.transport,
      requires: operation.requires === undefined ? undefined : [...operation.requires].sort(),
      public: operation.public,
      edge: operation.edge,
    }));
    const order = (a: { method: string; template: string }, b: { method: string; template: string }): number =>
      `${a.template} ${a.method}`.localeCompare(`${b.template} ${b.method}`);
    expect(registered.sort(order)).toEqual(declared.sort(order));
  });

  it('exercises every declared response of every operation', () => {
    const declared = [...OPERATIONS.values()].flatMap((operation) =>
      Object.keys(operation.responses)
        .filter((key) => key !== 'default')
        .map((key) => `${operation.operationId} ${key}`),
    );
    const exercised = new Set(CASES.map((c) => `${c.operationId} ${c.status}`));
    expect(declared.filter((entry) => !exercised.has(entry))).toEqual([]);
    expect([...exercised].filter((entry) => !declared.includes(entry))).toEqual([]);
  });
});

describe('gateway responses through buildApp', () => {
  it.each(CASES.map((c) => [c.operationId, c.status, c.title, c] as const))('%s %s: %s', async (_operationId, _status, _title, c) => {
    const operation = operationOf(c.operationId);
    await c.before?.(h);
    try {
      const res = await h.app.inject(await c.request(h));
      expect(statusKeyOf(operation, res.statusCode), `${c.operationId} answered ${res.statusCode}: ${res.body}`).toBe(c.status);
      const body = expectContract(operation, res);
      await c.verify?.(res, body, h);
    } finally {
      await c.after?.(h);
    }
  });
});

describe('invocation credentials the contract names', () => {
  it('accepts a service token only from the scheme the contract declares, X-Serverless-Authorization', async () => {
    const token = await mintServiceToken({ caller: 'operator', audience: SERVICE, roles: rolesForService('operator') });
    const inHeader = await h.app.inject({ method: 'GET', url: STATUS, headers: { [INVOCATION_HEADER]: `Bearer ${token}` } });
    const asBearer = await h.app.inject({ method: 'GET', url: STATUS, headers: { authorization: `Bearer ${token}` } });
    expect([inHeader.statusCode, asBearer.statusCode]).toEqual([200, 401]);
    expect(bodyOf(asBearer)).toMatchObject({ apiversion: 'v1', error: { code: expect.any(String) } });
  });
});
