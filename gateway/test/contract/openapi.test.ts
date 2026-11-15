/** Gateway contract: buildApp's routes and responses against contracts/openapi.yaml, and its identity and migration calls against theirs. */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, rolesForService, type RouteMatrixEntry } from '@opt2/platform/auth';
import { legacyErrorResponse } from '@opt2/platform/legacy-compat';
import { parseWritePosition } from '@opt2/platform/migration-kit';
import type { ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import {
  ROLE_SET,
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  findOperation,
  mintServiceToken,
  mintUserToken,
  testVerifier,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { SERVICE_NAME, SERVICE_VERSION } from '../../src/app.js';
import { loadInventoryFacts } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { CutoverTable } from '../../src/cutover/types.js';
import { PROJECTION_AWAIT_TIMEOUT_MS, createSessionBarrier } from '../../src/dispatcher/barrier.js';
import { EDGE_METHODS } from '../../src/dispatcher/dispatch.js';
import { RELAY_METHODS } from '../../src/dispatcher/relay.js';
import { createWriteWindowClient, type WindowCompleteResult, type WindowOpened } from '../../src/dispatcher/write-window.js';
import { IDENTITY_OPERATIONS, createIdentityClient, type LegacyDescribe } from '../../src/session/identity-client.js';
import { createLegacyJar } from '../../src/session/jar.js';
import {
  buildTestGateway,
  headersFor,
  identityServiceHeaders,
  migrationServiceHeaders,
  operatorHeaders,
  webServiceHeaders,
  type TestGateway,
} from '../helpers/app.js';
import { TEST_INSTANCE_ID } from '../helpers/env.js';
import type { RecordedRequest } from '../helpers/http-double.js';
import type { MemoryGatewayDb } from '../helpers/memory-store.js';
import type { TargetDouble } from '../helpers/target-double.js';
import { committedGroups, committedTable, cutoverTable } from '../helpers/versions.js';

type Json = Record<string, unknown>;
type Headers = Record<string, string>;
type HttpMethod = NonNullable<InjectOptions['method']>;
type IdentityOperationName = keyof typeof IDENTITY_OPERATIONS;

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
}

/** Auth declaration of a route or operation; absent flags are undefined and `requires` is sorted. */
interface RouteConfig {
  transport: unknown;
  requires: string[] | undefined;
  public: true | undefined;
  edge: true | undefined;
}

/** One contract operation with its auth declaration. */
interface ContractOperation {
  operationId: string;
  method: string;
  template: string;
  responses: Json;
  config: RouteConfig;
}

/** One request against an operation and the declared response key (a status or a range such as `2XX`) it must answer. */
interface Case {
  operationId: string;
  status: string;
  title: string;
  request(tg: TestGateway): Promise<InjectOptions>;
  before?(tg: TestGateway): void | Promise<void>;
  after?(tg: TestGateway): void | Promise<void>;
  verify?(res: InjectResponse, body: unknown, tg: TestGateway): void | Promise<void>;
}

/** One outbound call as the gateway's service client sent and received it. */
interface RecordedCall {
  req: ServiceRequest;
  res: ServiceResponse;
}

/** Parses a contract document resolved from this file. */
function loadContract(relative: string): OpenApiDoc {
  return parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as OpenApiDoc;
}

const DOC = loadContract('../../contracts/openapi.yaml');
const IDENTITY_DOC = loadContract('../../../services/identity/contracts/openapi.yaml');
const MIGRATION_DOC = loadContract('../../../migration/contracts/openapi.yaml');
const PIN = JSON.parse(readFileSync(new URL('../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const GATEWAY_OPERATION_IDS = [
  'healthz',
  'cutoverActivate',
  'cutoverFreeze',
  'cutoverUnfreeze',
  'cutoverStatus',
  'inflightClearOrphans',
  'legacySessionMarkUsed',
  'relayGet',
  'relayPost',
  'relayPut',
  'relayPatch',
  'relayDelete',
  'edgeGet',
  'edgeHead',
  'edgePost',
  'edgePut',
  'edgePatch',
  'edgeDelete',
  'edgeOptions',
];

/** Identity operations behind the nine IdentityClient methods. */
const IDENTITY_CALLED = [
  'mintUserToken',
  'authenticateRequest',
  'adoptSession',
  'getSessionState',
  'getSessionAdminSite',
  'getSessionSnapshot',
  'endSession',
  'claimCsrfToken',
  'settleCsrfClaims',
];

/** Migration operations behind the session barrier and the write-window client. */
const MIGRATION_CALLED = ['windowOpen', 'windowComplete', 'projectionAwait'];

const HTTP_METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as const;
const BRIDGE_PREFIX = '/gateway/legacy-bridge/';
const MISSING_SEGMENT = /\/missing(?:\/|$)/;
const FREEZE_ROUTE = 'admin:cdashboard.main';
const UNKNOWN_ROUTE = 'admin:nosuch.action';
const CONTENT_LIST_PATH = '/_api/json/v1/default/content';
const CONTENT_PATH = `${CONTENT_LIST_PATH}/C1`;
const MISSING_PATH = `${CONTENT_LIST_PATH}/missing`;
const RELAY_PATH = '/internal/v1/relay/people/opt2/people/ping';
const STUB_PATH = '/opt2/stub/notes';
const USED_AT = '2026-06-30T12:00:00.000';
const MARKED_SESSION = 'ids-contract-marked';
const STALE_SESSION = 'ids-contract-stale';
const DEAD_INSTANCE = 'gw-contract-dead';
const MARKED_TOKEN = randomBytes(32).toString('hex').toUpperCase();
/** The activation's compare-and-set in src/cutover/state.ts, as the memory store matches statements. */
const CAS_STATEMENT = 'UPDATE gateway.cutover_state SET table_version = $1';

const ACTIVATE = '/internal/v1/cutover/activate';
const FREEZE = '/internal/v1/cutover/freeze';
const UNFREEZE = '/internal/v1/cutover/unfreeze';
const STATUS = '/internal/v1/cutover/status';
const CLEAR = '/internal/v1/inflight:clear-orphans';
const markUsedUrl = (sid: string): string => `/internal/v1/legacy-sessions/${sid}:mark-used`;

function contractConfig(operation: Json): RouteConfig {
  const requires = operation['x-opt2-requires'] as string[] | undefined;
  return {
    transport: operation['x-opt2-transport'],
    requires: requires === undefined ? undefined : [...requires].sort(),
    public: operation['x-opt2-public'] === true ? true : undefined,
    edge: operation['x-opt2-edge'] === true ? true : undefined,
  };
}

function routeConfig(route: RouteMatrixEntry): RouteConfig {
  return {
    transport: route.transport,
    requires: route.requires === undefined ? undefined : [...route.requires].sort(),
    public: route.public === true ? true : undefined,
    edge: route.edge === true ? true : undefined,
  };
}

/** Every operation of the gateway contract, keyed by operationId. */
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
        config: contractConfig(operation),
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

/** Contract template of a Fastify url: `::` is a literal colon, `:name(re)` and `:name` are `{name}`, a trailing `*` is `{path}`. */
function templateOf(url: string): string {
  return url
    .replace(/::/g, '\u0000')
    .replace(/:([A-Za-z_]\w*)(?:\([^)]*\))?/g, '{$1}')
    .replace(/\u0000/g, ':')
    .replace(/\*$/, '{path}');
}

/** A concrete path the template matches with each parameter one segment, as findOperation matches parameters. */
function locatorPath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => name);
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
 * its status and any content type must be declared, and a body-less one only matches the pass-through response.
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

function memoryOf(tg: TestGateway): MemoryGatewayDb {
  if (tg.memory === undefined) throw new TypeError('the test gateway has no memory store');
  return tg.memory;
}

function target(tg: TestGateway, name: string): TargetDouble {
  const double = tg.targets[name];
  if (double === undefined) throw new TypeError(`no target double serves ${name}`);
  return double;
}

/** Page requests legacy received, bridge calls excepted. */
function legacyPages(tg: TestGateway): RecordedRequest[] {
  return tg.legacy.requests.filter((req) => !req.path.startsWith(BRIDGE_PREFIX));
}

function subjectFor(predicate: (subject: RoleSubject) => boolean, label: string): RoleSubject {
  const subject = ROLE_SET.find(predicate);
  if (subject === undefined) throw new TypeError(`ROLE_SET has no subject ${label}`);
  return subject;
}

/** Invocation-credential headers of each caller the cases present. */
const CALLER_HEADERS: Readonly<Record<string, () => Promise<Headers>>> = {
  operator: operatorHeaders,
  migration: migrationServiceHeaders,
  identity: identityServiceHeaders,
  web: webServiceHeaders,
  gateway: () => headersFor(subjectFor((subject) => subject.kind === 'service' && subject.caller === 'gateway', 'service:gateway')),
};

function callerHeaders(caller: string): Promise<Headers> {
  const headers = CALLER_HEADERS[caller];
  if (headers === undefined) throw new TypeError(`no headers for caller ${caller}`);
  return headers();
}

/** A system user's token for `site` beside the gateway's invocation credential. */
function userHeaders(site: string): Promise<Headers> {
  return headersFor(
    subjectFor((subject) => subject.kind === 'user' && subject.name === Roles.systemUser, Roles.systemUser),
    { site },
  );
}

/** User token of the last relayed web call, which the callee must receive unchanged. */
let relayedUserToken = '';

/** Legacy requests counted before a case that must reach legacy with none. */
let legacyBefore = 0;

/** Legacy session the mark-used case writes into. */
let markedLegacySession = '';

async function webWithUser(): Promise<Headers> {
  relayedUserToken = await mintUserToken({ sub: 'contract-tenant-a', site: 'tenant-a', roles: [Roles.systemUser] });
  return { authorization: `Bearer ${relayedUserToken}`, ...(await webServiceHeaders()) };
}

/** Seeds a jar mapping `sessionId` to the legacy session the cookies attach. */
async function seedJar(tg: TestGateway, sessionId: string, legacySessionId: string, cookies: Readonly<Record<string, string>>): Promise<void> {
  await createLegacyJar(tg.db).upsert({
    sessionId,
    legacySessionId,
    cookies: Object.fromEntries(
      Object.entries(cookies).map(([name, value]) => [name, { name, value, attributes: 'Path=/; HttpOnly' }]),
    ),
    mode: 'legacy-primary',
    hydratedEpoch: null,
  });
}

const tokenEntry = (token: string): { token: string; usedAt: string } => ({ token, usedAt: USED_AT });

/** The 401 and 403 answers of an operation: no credential, and a caller holding none of its roles. */
function credentialCases(operationId: string, url: string, method: HttpMethod, payload: object | undefined, wrongCaller: string): Case[] {
  const body = payload === undefined ? {} : { payload };
  return [
    {
      operationId,
      status: '401',
      title: 'without an invocation credential',
      request: async () => ({ method, url, ...body }),
    },
    {
      operationId,
      status: '403',
      title: `as ${wrongCaller}, which holds none of the required roles`,
      request: async () => ({ method, url, headers: await callerHeaders(wrongCaller), ...body }),
    },
  ];
}

const CONTROL_CASES: Case[] = [
  {
    operationId: 'edgeGet',
    status: '503',
    title: 'a JSON API read while no version is active, as the JSON envelope',
    before: (tg) => {
      legacyBefore = legacyPages(tg).length;
    },
    request: async () => ({ method: 'GET', url: CONTENT_LIST_PATH }),
    verify: (res, _body, tg) => {
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(legacyPages(tg)).toHaveLength(legacyBefore);
    },
  },
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
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await operatorHeaders(), payload: { tableVersion: 'one' } }),
    verify: (_res, body) => expect(body).toMatchObject({ apiversion: 'v1', error: { code: expect.any(String) } }),
  },
  {
    operationId: 'cutoverActivate',
    status: '400',
    title: 'a version without a file',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await operatorHeaders(), payload: { tableVersion: 'v0009' } }),
    verify: (_res, body) => expect(body).toMatchObject({ findings: [{ rule: 'unknown-version' }] }),
  },
  {
    operationId: 'cutoverActivate',
    status: '200',
    title: 'v0001 as the first version',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await operatorHeaders(), payload: { tableVersion: 'v0001' } }),
    verify: (_res, body, tg) => {
      expect(body).toEqual({ tableVersion: 'v0001', epoch: 1 });
      expect(memoryOf(tg).tables.cutover_state[0]).toMatchObject({
        table_version: 'v0001',
        previous_version: null,
        epoch: '1',
        activated_by: 'operator',
      });
    },
  },
  {
    operationId: 'cutoverActivate',
    status: '409',
    title: 'v0001 again, whose previous is no longer active',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await operatorHeaders(), payload: { tableVersion: 'v0001' } }),
    verify: (_res, body, tg) => {
      expect(body).toMatchObject({ findings: [{ rule: 'previous-mismatch' }] });
      expect(memoryOf(tg).tables.cutover_state[0]?.epoch).toBe('1');
    },
  },
  {
    operationId: 'cutoverActivate',
    status: '200',
    title: 'v0002 after v0001',
    request: async () => ({ method: 'POST', url: ACTIVATE, headers: await operatorHeaders(), payload: { tableVersion: 'v0002' } }),
    verify: (_res, body) => expect(body).toEqual({ tableVersion: 'v0002', epoch: 2 }),
  },
  ...(['operator', 'migration'] as const).map(
    (caller): Case => ({
      operationId: 'cutoverStatus',
      status: '200',
      title: `as ${caller}`,
      request: async () => ({ method: 'GET', url: STATUS, headers: await callerHeaders(caller) }),
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
          expect.objectContaining({ instanceId: TEST_INSTANCE_ID, seenEpoch: 2, live: true }),
        );
      },
    }),
  ),
  ...credentialCases('cutoverStatus', STATUS, 'GET', undefined, 'web'),
  {
    operationId: 'cutoverFreeze',
    status: '200',
    title: 'an entry of the active version',
    request: async () => ({ method: 'POST', url: FREEZE, headers: await operatorHeaders(), payload: { routes: [FREEZE_ROUTE] } }),
    verify: (_res, body, tg) => {
      expect(body).toMatchObject({ tableVersion: 'v0002', epoch: 3, frozen: [FREEZE_ROUTE] });
      expect(memoryOf(tg).tables.cutover_freeze.map((row) => row.route)).toEqual([FREEZE_ROUTE]);
    },
  },
  {
    operationId: 'cutoverFreeze',
    status: '400',
    title: 'a route the active version lacks, rolling its epoch back',
    request: async () => ({ method: 'POST', url: FREEZE, headers: await operatorHeaders(), payload: { routes: [UNKNOWN_ROUTE] } }),
    verify: (_res, body, tg) => {
      expect(body).toMatchObject({ findings: [{ rule: 'unknown-route', route: UNKNOWN_ROUTE }] });
      expect(memoryOf(tg).tables.cutover_state[0]?.epoch).toBe('3');
    },
  },
  ...credentialCases('cutoverFreeze', FREEZE, 'POST', { routes: [FREEZE_ROUTE] }, 'migration'),
  {
    operationId: 'cutoverUnfreeze',
    status: '200',
    title: 'the frozen entry',
    request: async () => ({ method: 'POST', url: UNFREEZE, headers: await operatorHeaders(), payload: { routes: [FREEZE_ROUTE] } }),
    verify: (_res, body, tg) => {
      expect(body).toMatchObject({ epoch: 4, frozen: [] });
      expect(memoryOf(tg).tables.cutover_freeze).toHaveLength(0);
    },
  },
  {
    operationId: 'cutoverUnfreeze',
    status: '400',
    title: 'a route neither frozen nor in the active version',
    request: async () => ({ method: 'POST', url: UNFREEZE, headers: await operatorHeaders(), payload: { routes: [UNKNOWN_ROUTE] } }),
    verify: (_res, body) => expect(body).toMatchObject({ findings: [{ rule: 'unknown-route' }] }),
  },
  ...credentialCases('cutoverUnfreeze', UNFREEZE, 'POST', { routes: [FREEZE_ROUTE] }, 'migration'),
  {
    operationId: 'inflightClearOrphans',
    status: '200',
    title: "a dead instance's legacy-side row after a legacy restart",
    before: (tg) => {
      const startedAt = new Date(Date.now() - 600_000);
      const { tables } = memoryOf(tg);
      tables.instance.push({ instance_id: DEAD_INSTANCE, seen_epoch: '1', started_at: startedAt, heartbeat_at: startedAt });
      tables.inflight.push({
        instance_id: DEAD_INSTANCE,
        request_id: 'r-1',
        route: 'page:render',
        side: 'legacy',
        window_id: null,
        started_at: startedAt,
      });
    },
    request: async () => ({
      method: 'POST',
      url: CLEAR,
      headers: await migrationServiceHeaders(),
      payload: { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'restart-1', at: new Date().toISOString() } },
    }),
    verify: (_res, body, tg) => {
      expect(body).toEqual({ cleared: 1 });
      expect(memoryOf(tg).tables.inflight).toHaveLength(0);
    },
  },
  {
    operationId: 'inflightClearOrphans',
    status: '400',
    title: 'target-side clearing with legacy-restart evidence',
    request: async () => ({
      method: 'POST',
      url: CLEAR,
      headers: await operatorHeaders(),
      payload: { side: 'target', evidence: { kind: 'legacy-restart', holderId: 'restart-1', at: new Date().toISOString() } },
    }),
  },
  ...credentialCases(
    'inflightClearOrphans',
    CLEAR,
    'POST',
    { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'restart-1', at: `${USED_AT}+00:00` } },
    'web',
  ),
  {
    operationId: 'legacySessionMarkUsed',
    status: '204',
    title: "into the mapped legacy session's ledger",
    before: async (tg) => {
      const { session, cookies } = tg.legacy.createSession();
      markedLegacySession = session.legacySessionId;
      await seedJar(tg, MARKED_SESSION, session.legacySessionId, cookies);
    },
    request: async () => ({
      method: 'POST',
      url: markUsedUrl(MARKED_SESSION),
      headers: await identityServiceHeaders(),
      payload: { tokens: [tokenEntry(MARKED_TOKEN)] },
    }),
    verify: (_res, _body, tg) => {
      expect(tg.legacy.usedTokens(markedLegacySession)).toEqual([tokenEntry(MARKED_TOKEN)]);
      expect(tg.legacy.bridgeCalls.at(-1)).toMatchObject({ op: 'markUsed', status: 200, legacySessionId: markedLegacySession });
    },
  },
  {
    operationId: 'legacySessionMarkUsed',
    status: '400',
    title: 'a token that is not 64 hex digits',
    request: async () => ({
      method: 'POST',
      url: markUsedUrl(MARKED_SESSION),
      headers: await identityServiceHeaders(),
      payload: { tokens: [tokenEntry('not-a-token')] },
    }),
  },
  {
    operationId: 'legacySessionMarkUsed',
    status: '404',
    title: 'a session without a jar',
    before: (tg) => {
      legacyBefore = tg.legacy.requests.length;
    },
    request: async () => ({
      method: 'POST',
      url: markUsedUrl('ids-contract-unknown'),
      headers: await identityServiceHeaders(),
      payload: { tokens: [tokenEntry(MARKED_TOKEN)] },
    }),
    verify: (_res, _body, tg) => expect(tg.legacy.requests).toHaveLength(legacyBefore),
  },
  {
    operationId: 'legacySessionMarkUsed',
    status: '503',
    title: 'a jar whose legacy session the bridge no longer attaches',
    before: (tg) => seedJar(tg, STALE_SESSION, 'masacms_1_2', { CFID: '1', CFTOKEN: '2' }),
    request: async () => ({
      method: 'POST',
      url: markUsedUrl(STALE_SESSION),
      headers: await identityServiceHeaders(),
      payload: { tokens: [tokenEntry(MARKED_TOKEN)] },
    }),
    verify: (_res, _body, tg) => expect(tg.legacy.bridgeCalls.at(-1)).toMatchObject({ op: 'markUsed', status: 409 }),
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
      expect(caller.name).toBe(SERVICE_NAME);
    },
  },
  ...credentialCases(relayOperation(method), RELAY_PATH, method, undefined, 'gateway'),
  {
    operationId: relayOperation(method),
    status: '404',
    title: 'an unknown service',
    request: async () => ({ method, url: '/internal/v1/relay/nosuch/x', headers: await webServiceHeaders() }),
  },
  {
    operationId: relayOperation(method),
    status: '503',
    title: 'a callee answering 503',
    before: (tg) => target(tg, 'people').setMode('503'),
    after: (tg) => target(tg, 'people').setMode('ok'),
    request: async () => ({ method, url: RELAY_PATH, headers: await webWithUser() }),
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
      verify: (_res, _body, tg) => expect(legacyPages(tg).at(-1)).toMatchObject({ method, path: CONTENT_PATH }),
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
      before: async (tg) => {
        await target(tg, 'stub').setMode('503');
        legacyBefore = legacyPages(tg).length;
      },
      after: (tg) => target(tg, 'stub').setMode('ok'),
      request: async () => ({ method, url: STUB_PATH, ...withBody(method) }),
      verify: (res, _body, tg) => {
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(legacyPages(tg)).toHaveLength(legacyBefore);
      },
    },
  ]),
  {
    operationId: 'edgeGet',
    status: '2XX',
    title: 'a web screen of the active version',
    request: async () => ({ method: 'GET', url: '/opt2/admin/finance/claims' }),
    verify: (_res, _body, tg) => expect(tg.web.requests.at(-1)?.path).toBe('/opt2/admin/finance/claims'),
  },
  {
    operationId: 'edgeGet',
    status: '4XX',
    title: 'the legacy bridge from outside, answered by the gateway',
    before: (tg) => {
      legacyBefore = tg.legacy.requests.length;
    },
    request: async () => ({ method: 'GET', url: `${BRIDGE_PREFIX}cfml/session.cfm?op=describe` }),
    verify: (res, _body, tg) => {
      expect(res.statusCode).toBe(404);
      expect(tg.legacy.requests).toHaveLength(legacyBefore);
    },
  },
  {
    operationId: 'edgeGet',
    status: '503',
    title: 'an admin legacy-write whose window cannot open, as the legacy error page',
    before: (tg) => {
      tg.migration.setOpen({ status: 503 });
      legacyBefore = legacyPages(tg).length;
    },
    after: (tg) => tg.migration.setOpen('ok'),
    request: async () => ({ method: 'GET', url: '/admin/?muraAction=carch.importcontent' }),
    verify: (res, _body, tg) => {
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(legacyPages(tg)).toHaveLength(legacyBefore);
    },
  },
];

/** Every case against the gateway that starts with no active version, in order: activation precedes routing. */
const CASES: readonly Case[] = [...CONTROL_CASES, ...RELAY_CASES, ...EDGE_CASES];

let tg: TestGateway;

beforeAll(async () => {
  tg = await buildTestGateway();
  const { headers, body } = legacyErrorResponse('invalidMethodCall', { mura404: true });
  tg.legacy.setResponse((req) => (MISSING_SEGMENT.test(req.path) ? { status: 404, headers, body } : {}));
}, 120_000);

afterAll(async () => {
  await tg?.close();
});

describe('gateway contract document', () => {
  it('is OpenAPI 3.1.0 at the package version and the pinned source SHA', () => {
    expect({ openapi: DOC.openapi, version: DOC.info.version, sha: DOC.info['x-source-sha'] }).toEqual({
      openapi: '3.1.0',
      version: SERVICE_VERSION,
      sha: PIN.sha,
    });
  });

  it('declares exactly the gateway operation ids', () => {
    expect([...OPERATIONS.keys()].sort()).toEqual([...GATEWAY_OPERATION_IDS].sort());
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

describe('registered routes', () => {
  let routes: RouteMatrixEntry[];

  beforeAll(() => {
    // The contract declares a HEAD operation, so routes are compared as collected.
    ({ routes } = collectRouteMatrix(tg.app));
  });

  it("registers exactly the contract's operations", () => {
    const registered = routes.map((route) => `${route.method} ${templateOf(route.url)}`).sort();
    const declared = [...OPERATIONS.values()].map((operation) => `${operation.method} ${operation.template}`).sort();
    expect(registered).toEqual(declared);
  });

  it.each([...OPERATIONS.values()].map((operation) => [operation.operationId, operation] as const))(
    '%s is registered with its transport, roles, public and edge flags',
    (_operationId, operation) => {
      const route = routes.find((entry) => entry.method === operation.method && templateOf(entry.url) === operation.template);
      expect(route, `${operation.method} ${operation.template} is registered`).toBeDefined();
      expect(routeConfig(route as RouteMatrixEntry)).toEqual(operation.config);
    },
  );
});

describe('gateway responses through buildApp', () => {
  it.each(CASES.map((c) => [c.operationId, c.status, c.title, c] as const))('%s %s: %s', async (_operationId, _status, _title, c) => {
    const operation = operationOf(c.operationId);
    await c.before?.(tg);
    try {
      const res = await tg.app.inject(await c.request(tg));
      expect(statusKeyOf(operation, res.statusCode), `${c.operationId} answered ${res.statusCode}: ${res.body}`).toBe(c.status);
      const body = expectContract(operation, res);
      await c.verify?.(res, body, tg);
    } finally {
      await c.after?.(tg);
    }
  });
});

describe('cut-over activation refused on a fixture cut-over directory', () => {
  const activate = operationOf('cutoverActivate');
  let fixture: TestGateway;
  let servedRoute: string;

  // buildTestGateway serves fixture versions only beside a seeded fixture version, so the refusals follow an active v0001.
  beforeAll(async () => {
    const [v0001, v0002, groups] = await Promise.all([committedTable('v0001'), committedTable('v0002'), committedGroups()]);
    const served = v0001.entries.find((item) => item.disposition === 'legacy-served' && item.state === 'legacy' && item.kind === 'read');
    if (served === undefined) throw new TypeError('v0001 has no legacy-served read entry');
    servedRoute = served.route;
    const invalid: CutoverTable = cutoverTable({
      tableVersion: 'v9001',
      previous: 'v0001',
      groupAuthority: v0001.groupAuthority,
      rollbackRefs: v0001.rollbackRefs,
      createdAt: v0001.createdAt,
      entries: v0001.entries.map((item) => (item.route === servedRoute ? { ...item, state: 'target' } : item)),
    });
    fixture = await buildTestGateway({ version: v0001, extraTables: [invalid, v0002], groups });
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it('answers ValidationFindings for a version that breaks a cut-over rule', async () => {
    const res = await fixture.app.inject({ method: 'POST', url: ACTIVATE, headers: await operatorHeaders(), payload: { tableVersion: 'v9001' } });
    expect(res.statusCode).toBe(400);
    const body = expectContract(activate, res) as { findings: unknown[] };
    expect(body.findings).toContainEqual(expect.objectContaining({ rule: 'legacy-served-never-target', route: servedRoute }));
    expect(memoryOf(fixture).tables.cutover_state[0]?.table_version).toBe('v0001');
  });

  it('answers the conflict status when another operation commits between read and compare-and-set', async () => {
    const memory = memoryOf(fixture);
    const epoch = memory.tables.cutover_state[0]?.epoch;
    memory.respond(CAS_STATEMENT, []);
    const res = await fixture.app.inject({ method: 'POST', url: ACTIVATE, headers: await operatorHeaders(), payload: { tableVersion: 'v0002' } });
    expect(res.statusCode).toBe(409);
    expect(expectContract(activate, res)).toMatchObject({ findings: [{ rule: 'previous-mismatch' }] });
    expect(memory.tables.cutover_state[0]).toMatchObject({ table_version: 'v0001', epoch });
  });
});

describe('invocation credentials the contract names', () => {
  it('accepts a service token only from the scheme the contract declares, X-Serverless-Authorization', async () => {
    const token = await mintServiceToken({ caller: 'operator', audience: SERVICE_NAME, roles: rolesForService('operator') });
    const inHeader = await tg.app.inject({ method: 'GET', url: STATUS, headers: { [INVOCATION_HEADER]: `Bearer ${token}` } });
    const asBearer = await tg.app.inject({ method: 'GET', url: STATUS, headers: { authorization: `Bearer ${token}` } });
    expect([inHeader.statusCode, asBearer.statusCode]).toEqual([200, 401]);
    expect(asBearer.json<Json>()).toMatchObject({ apiversion: 'v1', error: { code: expect.any(String) } });
  });
});

describe("the gateway's identity and migration calls against their producer contracts", () => {
  const CONSUMER_SESSION = 'ids-contract-consumer';
  const CONSUMER_USER = 'contract-consumer-user';
  const CONSUMER_EPOCH = 3;
  const CSRF_KEY = 'contract-csrf-key';
  const CSRF_TOKEN = randomBytes(32).toString('hex').toUpperCase();
  const WRITE_POSITION = 'identity=1234,people=5678';
  const PROJECTED_OWNERS: ReadonlySet<string> = new Set(['identity', 'people']);
  const WINDOW_ROUTE = 'admin:cusers.update{type=2,action=delete}';
  const WINDOW_UNITS = ['people.person'];
  const DESCRIBE: LegacyDescribe = {
    sessionId: 'CONTRACT-LEGACY-SESSION',
    isLoggedIn: true,
    user: {
      userID: CONSUMER_USER,
      username: 'contract',
      siteID: 'default',
      subtype: 'Default',
      password: '',
      fname: 'Contract',
      lname: 'Consumer',
      email: 'contract@example.com',
      remoteID: '',
      company: '',
      lastlogin: '',
      passwordCreated: '',
    },
    memberships: Roles.systemUser,
    membershipIds: CONSUMER_USER,
    csrfSecretKey: CSRF_KEY,
    usedTokens: [],
    siteId: 'default',
    serverTime: USED_AT,
  };

  const calls: RecordedCall[] = [];
  const identityResults: Partial<Record<IdentityOperationName, unknown>> = {};
  const opened: WindowOpened[] = [];
  let completed: WindowCompleteResult | undefined;
  let awaitsBefore = 0;
  let windowsBefore = 0;

  beforeAll(async () => {
    tg.identity.clearRequests();
    tg.migration.clearRequests();
    awaitsBefore = tg.migration.awaits.length;
    windowsBefore = tg.migration.windows.length;
    const inner = tg.app.opt2.client;
    const recorded: ServiceClient = {
      async request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
        const res = await inner.request<T>(req);
        calls.push({ req, res });
        return res;
      },
      close: () => inner.close(),
    };
    tg.identity.setSession({
      sessionId: CONSUMER_SESSION,
      userId: CONSUMER_USER,
      epoch: CONSUMER_EPOCH,
      state: 'active',
      mode: 'legacy-primary',
      roles: [Roles.systemUser],
      snapshot: {
        sessionId: CONSUMER_SESSION,
        epoch: CONSUMER_EPOCH,
        loginSnapshot: { user: { userID: CONSUMER_USER }, roles: [Roles.systemUser] },
        csrfSecretKey: CSRF_KEY,
        usedTokens: [],
      },
    });

    const identity = createIdentityClient(recorded);
    identityResults.mintToken = await identity.mintToken({ sessionId: CONSUMER_SESSION, siteId: 'default' });
    identityResults.authenticate = await identity.authenticate({
      method: 'GET',
      path: CONTENT_LIST_PATH,
      headers: { accept: 'application/json' },
      query: {},
    });
    identityResults.adopt = await identity.adopt({ describe: DESCRIBE, siteId: 'default' });
    identityResults.state = await identity.state(CONSUMER_SESSION);
    identityResults.adminSite = await identity.adminSite(CONSUMER_SESSION);
    identityResults.snapshot = await identity.snapshot(CONSUMER_SESSION);
    identityResults.claim = await identity.claim({ sessionId: CONSUMER_SESSION, token: CSRF_TOKEN, expires: '260630130000000', context: 'contract' });
    identityResults.settle = await identity.settle({ sessionId: CONSUMER_SESSION, consumed: [CSRF_TOKEN], released: [] });
    identityResults.end = await identity.end(CONSUMER_SESSION, 'logout');

    const barrier = createSessionBarrier({ db: tg.db, client: recorded, projectedOwners: () => PROJECTED_OWNERS });
    await barrier.record(CONSUMER_SESSION, parseWritePosition(WRITE_POSITION));
    await barrier.awaitForSession(CONSUMER_SESSION);
    await barrier.awaitOwners([...PROJECTED_OWNERS]);

    const windows = createWriteWindowClient({ client: recorded, facts: await loadInventoryFacts(resolveGatewayPaths(tg.env)) });
    const open = { routeKey: WINDOW_ROUTE, units: WINDOW_UNITS };
    opened.push(await windows.open({ ...open, scope: { table: true }, requestId: 'contract-window-table' }));
    const keyed = await windows.open({ ...open, scope: { keys: { siteid: 'tenant-a' } }, requestId: 'contract-window-keys' });
    opened.push(keyed);
    completed = await windows.complete(keyed.windowId, { forwarded: true, legacyStatus: 200 });
  }, 60_000);

  it('returns what identity answered from every operation the client implements', () => {
    expect(Object.keys(identityResults).sort()).toEqual(Object.keys(IDENTITY_OPERATIONS).sort());
    for (const name of Object.keys(IDENTITY_OPERATIONS) as IdentityOperationName[]) {
      const { method, path } = IDENTITY_OPERATIONS[name];
      const wanted = path.replace('{sid}', CONSUMER_SESSION);
      const call = calls.find((c) => c.req.service === 'identity' && c.req.method === method && c.req.path === wanted);
      expect(call, `${name} reached ${method} ${wanted}`).toBeDefined();
      const body = call?.res.body;
      expect(identityResults[name], name).toEqual(name === 'adminSite' ? (body as { siteId: string }).siteId : body);
    }
    expect(identityResults.state).toMatchObject({ state: 'active', epoch: CONSUMER_EPOCH, userId: CONSUMER_USER });
    expect(identityResults.snapshot).toMatchObject({ sessionId: CONSUMER_SESSION, csrfSecretKey: CSRF_KEY });
  });

  it('awaits recorded positions and owners through projectionAwait, then drops the confirmed positions', () => {
    expect(tg.migration.awaits.slice(awaitsBefore).map((entry) => entry.body)).toEqual([
      { positions: { identity: '1234', people: '5678' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
      { owners: ['identity', 'people'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
    ]);
    expect(memoryOf(tg).tables.session_barrier.filter((row) => row.session_id === CONSUMER_SESSION)).toEqual([]);
  });

  it('opens windows with a table and a keyed scope and completes one with the legacy outcome', () => {
    const windows = tg.migration.windows.slice(windowsBefore);
    expect(opened).toEqual(windows.map(({ windowId }) => ({ windowId })));
    expect(windows.map(({ routeKey, units, scope, requestId }) => ({ routeKey, units, scope, requestId }))).toEqual([
      { routeKey: WINDOW_ROUTE, units: WINDOW_UNITS, scope: { table: true }, requestId: 'contract-window-table' },
      { routeKey: WINDOW_ROUTE, units: WINDOW_UNITS, scope: { keys: { siteid: 'tenant-a' } }, requestId: 'contract-window-keys' },
    ]);
    expect(windows[1]?.completion).toEqual({ forwarded: true, legacyStatus: 200 });
    expect(completed).toEqual({ state: 'closed' });
  });

  it.each([
    ['identity', IDENTITY_DOC, IDENTITY_CALLED],
    ['migration', MIGRATION_DOC, MIGRATION_CALLED],
  ] as const)('reaches only declared %s operations, each the gateway calls, with valid requests and its invocation credential', async (callee, doc, called) => {
    const { requests } = callee === 'identity' ? tg.identity : tg.migration;
    const verifier = testVerifier(callee).invocationVerifier;
    const reached = new Set<string>();
    for (const req of requests) {
      reached.add(String(findOperation(doc, req.method, req.path).operation.operationId));
      assertRequestMatchesOpenApi(doc, {
        method: req.method,
        path: req.url,
        headers: req.headers,
        contentType: req.headers['content-type'],
        body: req.body.length === 0 ? undefined : req.body.toString('utf8'),
      });
      const credential = req.headers[INVOCATION_HEADER];
      expect(typeof credential, `${req.method} ${req.path} carries ${INVOCATION_HEADER}`).toBe('string');
      expect((await verifier.verify(String(credential))).name).toBe(SERVICE_NAME);
      expect(req.headers.authorization, `${req.method} ${req.path} carries no user token`).toBeUndefined();
    }
    expect([...reached].sort()).toEqual([...called].sort());
  });

  it('receives only answers that match the producer contracts', () => {
    expect(calls).toHaveLength(tg.identity.requests.length + tg.migration.requests.length);
    for (const { req, res } of calls) {
      assertResponseMatchesOpenApi(req.service === 'identity' ? IDENTITY_DOC : MIGRATION_DOC, {
        method: req.method,
        path: req.path,
        status: res.status,
        contentType: res.headers['content-type'],
        body: res.body,
      });
    }
  });
});
