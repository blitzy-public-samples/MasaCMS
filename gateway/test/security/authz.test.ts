/** In-process authorisation of the gateway through buildApp: route declarations, the subject matrix, the trust boundary and start-up. */
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  Roles,
  UndeclaredRouteError,
  collectRouteMatrix,
  hasAnyRole,
  rolesForService,
  serviceRole,
  signLocalServiceToken,
  type RouteMatrixEntry,
} from '@opt2/platform/auth';
import { signBridgeAssertion } from '@opt2/platform/legacy-compat';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import {
  ROLE_SET,
  TENANT_B,
  authHeadersFor,
  mintTasksInvokerToken,
  mintUserToken,
  subjectQueryFor,
  testSigningKeys,
  testVerifier,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { EDGE_METHODS } from '../../src/dispatcher/dispatch.js';
import { RELAY_METHODS } from '../../src/dispatcher/relay.js';
import { createGatewayDb } from '../helpers/gateway-db.js';
import {
  SERVICE,
  TARGET_SERVICES,
  gatewayEnv,
  serviceHeaders,
  startGatewayHarness,
  type Effects,
  type GatewayHarness,
} from '../helpers/gateway-app.js';
import type { RecordedRequest } from '../helpers/http-double.js';

type Headers = Record<string, string>;

/** One registered route with its declaration: exactly one of `requires` and `public`. */
interface ExpectedRoute {
  method: string;
  url: string;
  requires?: readonly string[];
  public?: true;
  edge?: true;
  siteCheck?: false;
}

/** A request an admitted subject's call answers without changing gateway state, and the upstream it reaches. */
interface Probe {
  url: string;
  payload?: object;
  admitted: number;
  reaches?: 'legacy' | 'people';
}

interface Cell {
  route: ExpectedRoute;
  subject: RoleSubject;
  allow: boolean;
}

interface Outcome {
  status: number;
  body: string;
  before: Effects;
  after: Effects;
  /** The request the probe's upstream received, when it received one. */
  forwarded: RecordedRequest | undefined;
}

const SITE_A = 'tenant-a';
const DENIED: ReadonlySet<number> = new Set([401, 403]);
const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;
const OPERATOR: readonly string[] = [Roles.platformOperator];
const OPERATOR_OR_MIGRATION: readonly string[] = [Roles.platformOperator, Roles.platformMigration];
const UNKNOWN_ROUTE = 'admin:nosuch.action';
const CONTENT_PATH = '/_api/json/v1/default/content/C1';
const RELAY_PATH = '/internal/v1/relay/people/opt2/people/ping';
const ALIAS_PATH = '/opt2/svc/people/opt2/people/ping';
const STATUS_PATH = '/internal/v1/cutover/status';
const MATRIX_TOKEN = randomBytes(32).toString('hex');
const RELAY_URL = '/internal/v1/relay/:service/*';
const EDGE_URL = '/*';

const EXPECTED: readonly ExpectedRoute[] = [
  { method: 'GET', url: '/healthz', public: true },
  { method: 'POST', url: '/internal/v1/cutover/activate', requires: OPERATOR },
  { method: 'POST', url: '/internal/v1/cutover/freeze', requires: OPERATOR },
  { method: 'POST', url: '/internal/v1/cutover/unfreeze', requires: OPERATOR },
  { method: 'GET', url: STATUS_PATH, requires: OPERATOR_OR_MIGRATION },
  { method: 'POST', url: '/internal/v1/inflight::clear-orphans', requires: OPERATOR_OR_MIGRATION },
  { method: 'POST', url: '/internal/v1/legacy-sessions/:sid(.+)::mark-used', requires: [serviceRole('identity')] },
  ...RELAY_METHODS.map((method): ExpectedRoute => ({ method, url: RELAY_URL, requires: [serviceRole('web')], siteCheck: false })),
  ...EDGE_METHODS.map((method): ExpectedRoute => ({ method, url: EDGE_URL, public: true, edge: true })),
];

const PROBES: Readonly<Record<string, Probe>> = {
  '/healthz': { url: '/healthz', admitted: 200 },
  // v0002 is active, so v0001's previous (none) mismatches: admitted calls answer 409 and change nothing.
  '/internal/v1/cutover/activate': { url: '/internal/v1/cutover/activate', payload: { tableVersion: 'v0001' }, admitted: 409 },
  '/internal/v1/cutover/freeze': { url: '/internal/v1/cutover/freeze', payload: { routes: [UNKNOWN_ROUTE] }, admitted: 400 },
  '/internal/v1/cutover/unfreeze': { url: '/internal/v1/cutover/unfreeze', payload: { routes: [UNKNOWN_ROUTE] }, admitted: 400 },
  [STATUS_PATH]: { url: STATUS_PATH, admitted: 200 },
  '/internal/v1/inflight::clear-orphans': {
    url: '/internal/v1/inflight:clear-orphans',
    payload: { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'matrix', at: '2000-01-01T00:00:00.000+00:00' } },
    admitted: 200,
  },
  '/internal/v1/legacy-sessions/:sid(.+)::mark-used': {
    url: '/internal/v1/legacy-sessions/ids-matrix-unknown:mark-used',
    payload: { tokens: [{ token: MATRIX_TOKEN, usedAt: '2026-06-30T12:00:00.000' }] },
    admitted: 404,
  },
  [RELAY_URL]: { url: RELAY_PATH, admitted: 200, reaches: 'people' },
  [EDGE_URL]: { url: CONTENT_PATH, admitted: 200, reaches: 'legacy' },
};

function probeOf(route: ExpectedRoute): Probe {
  const probe = PROBES[route.url];
  if (probe === undefined) throw new TypeError(`no probe for ${route.url}`);
  return probe;
}

/**
 * Roles a subject's credentials present to the service transport; `invalid` when they cannot verify there. A user
 * subject carries the gateway's own invocation credential beside its token; the managed-task token is no user token.
 */
function presentedRoles(subject: RoleSubject): string[] | 'invalid' {
  if (subject.kind === 'anonymous') return [];
  if (subject.kind === 'user') return [...subject.roles, ...rolesForService(SERVICE)];
  if (subject.caller === 'tasks-invoker') return 'invalid';
  if (subject.caller === 'pubsub-invoker') return [];
  return rolesForService(subject.caller ?? '');
}

function allowed(route: ExpectedRoute, subject: RoleSubject): boolean {
  if (route.edge === true) return true;
  const roles = presentedRoles(subject);
  if (roles === 'invalid') return false;
  return route.public === true || hasAnyRole(roles, route.requires ?? []);
}

const CELLS: readonly Cell[] = EXPECTED.flatMap((route) => ROLE_SET.map((subject) => ({ route, subject, allow: allowed(route, subject) })));

const titleOf = (cell: Cell): string => `${cell.route.method} ${cell.route.url} as ${cell.subject.name}`;

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Headers> }>();
// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

function credentialsOf(subject: RoleSubject): Promise<Headers> {
  const cached = credentialCache.get(subject.name);
  if (cached !== undefined && Date.now() - cached.mintedAt < CREDENTIAL_REUSE_MS) return cached.headers;
  const headers = authHeadersFor(subject, { audience: SERVICE, site: SITE_A });
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

function withQuery(url: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  return search === '' ? url : `${url}${url.includes('?') ? '&' : '?'}${search}`;
}

/** Upstreams whose received-request count changed between two effect snapshots. */
function reached(before: Effects, after: Effects): string[] {
  const names: string[] = [];
  for (const name of ['legacy', 'identity', 'migration'] as const) {
    if (after.upstream[name] !== before.upstream[name]) names.push(name);
  }
  for (const name of TARGET_SERVICES) {
    if (after.upstream.targets[name] !== before.upstream.targets[name]) names.push(name);
  }
  return names;
}

/** Header names of a recorded request that start with `x-opt2-` or carry an invocation credential. */
function internalHeaders(request: RecordedRequest | undefined): string[] {
  return Object.keys(request?.headers ?? {}).filter((name) => name.startsWith('x-opt2-') || name === INVOCATION_HEADER);
}

function isDenialEnvelope(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { apiversion?: unknown; error?: { code?: unknown } };
    return parsed.apiversion === 'v1' && typeof parsed.error?.code === 'string';
  } catch {
    return false;
  }
}

let h: GatewayHarness;
const outcomes = new Map<string, Outcome>();

beforeAll(async () => {
  h = await startGatewayHarness({ activate: ['v0001', 'v0002'] });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

/** Injects `opts` and returns its answer with the effects before and after it. */
async function observed(opts: InjectOptions): Promise<{ res: InjectResponse; before: Effects; after: Effects }> {
  const before = h.effects();
  const res = await h.app.inject(opts);
  return { res, before, after: h.effects() };
}

async function outcomeOf(cell: Cell): Promise<Outcome> {
  const probe = probeOf(cell.route);
  const headers = await credentialsOf(cell.subject);
  const { res, before, after } = await observed({
    method: cell.route.method as InjectOptions['method'],
    url: withQuery(probe.url, subjectQueryFor(cell.subject)),
    headers,
    ...(probe.payload === undefined ? {} : { payload: probe.payload }),
  });
  const forwarded =
    probe.reaches === 'legacy' ? h.legacy.pages().at(-1) : probe.reaches === 'people' ? h.target('people').requests.at(-1) : undefined;
  return { status: res.statusCode, body: res.body, before, after, forwarded };
}

/** Everything wrong with one cell's outcome; empty when it was admitted or denied as declared and left no stray effect. */
async function verdictOf(cell: Cell, outcome: Outcome): Promise<string[]> {
  const problems: string[] = [];
  const probe = probeOf(cell.route);
  const admitted = !DENIED.has(outcome.status);
  const upstreams = reached(outcome.before, outcome.after);
  if (admitted !== cell.allow) problems.push(`expected ${cell.allow ? 'admission' : 'denial'}, answered ${outcome.status}`);
  if (!isDeepStrictEqual(outcome.after.db, outcome.before.db)) problems.push('changed gateway rows');
  if (!cell.allow) {
    if (upstreams.length > 0) problems.push(`denied but reached ${upstreams.join(', ')}`);
    if (!isDenialEnvelope(outcome.body)) problems.push(`denial is not the legacy error envelope: ${outcome.body}`);
    return problems;
  }
  if (outcome.status !== probe.admitted) problems.push(`admitted with ${outcome.status}, expected ${probe.admitted}: ${outcome.body}`);
  if (!isDeepStrictEqual(upstreams, probe.reaches === undefined ? [] : [probe.reaches])) {
    problems.push(`reached [${upstreams.join(', ')}], expected [${probe.reaches ?? ''}]`);
  }
  if (probe.reaches === 'legacy' && internalHeaders(outcome.forwarded).length > 0) {
    problems.push(`legacy received ${internalHeaders(outcome.forwarded).join(', ')}`);
  }
  if (probe.reaches === 'people') {
    const credential = String(outcome.forwarded?.headers[INVOCATION_HEADER]);
    const caller = await testVerifier('people').invocationVerifier.verify(credential).catch(() => undefined);
    if (caller?.name !== SERVICE) problems.push(`the callee received a credential of ${caller?.name ?? 'nobody'}, not the gateway`);
  }
  return problems;
}

describe('route declarations', () => {
  it('registers exactly the declared routes, each requiring roles or public', () => {
    const comparable = (route: ExpectedRoute | RouteMatrixEntry): Record<string, unknown> => ({
      method: route.method,
      url: route.url,
      ...(route.requires === undefined ? {} : { requires: [...route.requires].sort() }),
      ...(route.public === true ? { public: true } : {}),
      ...(route.edge === true ? { edge: true } : {}),
      ...(route.siteCheck === false ? { siteCheck: false } : {}),
    });
    const order = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
      `${String(a.url)} ${String(a.method)}`.localeCompare(`${String(b.url)} ${String(b.method)}`);
    const matrix = collectRouteMatrix(h.app).routes;
    expect(matrix.every((route) => route.transport === 'service')).toBe(true);
    expect(matrix.map(comparable).sort(order)).toEqual(EXPECTED.map(comparable).sort(order));
  });

  it('ROLE_SET holds the minimum subjects, with other-tenant minted for another tenant', () => {
    expect(ROLE_SET.map((subject) => subject.name)).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS]));
    expect(ROLE_SET.find((subject) => subject.name === 'other-tenant')?.crossTenant).toBe(true);
  });
});

describe('route admission matrix', () => {
  const unexpectedAllows: string[] = [];
  const unexpectedDenies: string[] = [];

  beforeAll(async () => {
    for (const cell of CELLS) {
      const outcome = await outcomeOf(cell);
      outcomes.set(titleOf(cell), outcome);
      const admitted = !DENIED.has(outcome.status);
      if (admitted && !cell.allow) unexpectedAllows.push(`${titleOf(cell)}: ${outcome.status}`);
      if (!admitted && cell.allow) unexpectedDenies.push(`${titleOf(cell)}: ${outcome.status}`);
    }
  }, 300_000);

  it('probes every declared route once per ROLE_SET subject', () => {
    expect(new Set(CELLS.map(titleOf)).size).toBe(EXPECTED.length * ROLE_SET.length);
  });

  it.each(CELLS.map((cell) => [titleOf(cell), cell] as const))('%s', async (title, cell) => {
    const outcome = outcomes.get(title);
    if (outcome === undefined) throw new Error(`${title} was not probed`);
    expect(await verdictOf(cell, outcome)).toEqual([]);
  });

  it('zero unexpected allows and denies', () => {
    expect({ unexpectedAllows, unexpectedDenies }).toEqual({ unexpectedAllows: [], unexpectedDenies: [] });
  });
});

describe('workload credentials on internal routes', () => {
  const expiredOperator = async (): Promise<Headers> => {
    const token = await signLocalServiceToken({ keys: await testSigningKeys(), caller: 'operator', audience: SERVICE, ttlSeconds: -120 });
    return { [INVOCATION_HEADER]: `Bearer ${token}` };
  };
  const foreignOperator = async (): Promise<Headers> => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const token = await signLocalServiceToken({
      keys: { privateKey, publicKey, kid: (await testSigningKeys()).kid },
      caller: 'operator',
      audience: SERVICE,
    });
    return { [INVOCATION_HEADER]: `Bearer ${token}` };
  };

  it.each<[string, () => Promise<Headers>]>([
    ['an expired operator token', expiredOperator],
    ['an operator token addressed to people', () => serviceHeaders('operator', 'people')],
    ['an operator token signed by a key identity does not hold', foreignOperator],
    [
      "the operator's credential beside a Basic credential",
      async () => ({ ...(await serviceHeaders('operator')), authorization: `Basic ${Buffer.from('operator:x').toString('base64')}` }),
    ],
    [
      'a managed-task token as an invocation credential',
      async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` }),
    ],
    ["a browser's legacy session cookie", async () => ({ cookie: h.legacy.openSession().cookie })],
  ])('refuses %s before any handler runs', async (_label, credentials) => {
    const { res, before, after } = await observed({ method: 'GET', url: STATUS_PATH, headers: await credentials() });
    expect({ status: res.statusCode, envelope: isDenialEnvelope(res.body), reached: reached(before, after) }).toEqual({
      status: 401,
      envelope: true,
      reached: [],
    });
  });
});

describe('browser-to-legacy trust boundary', () => {
  it('strips invocation credentials and X-Opt2-* headers from a legacy-bound request, keeping Host and Authorization', async () => {
    const basic = `Basic ${Buffer.from(`visitor:${randomUUID()}`).toString('base64')}`;
    const forged = {
      host: 'tenant-a.example.test',
      authorization: basic,
      ...(await serviceHeaders('web')),
      'x-opt2-bridge-assertion': signBridgeAssertion({ op: 'session.describe' }, h.bridgeKey),
      'x-opt2-write-position': 'people=1',
      'x-opt2-original-url': '/admin/',
    };
    const res = await h.app.inject({ method: 'GET', url: CONTENT_PATH, headers: forged });
    const received = h.legacy.pages().at(-1);
    expect(res.statusCode).toBe(200);
    expect({
      internal: internalHeaders(received),
      host: received?.headers.host,
      authorization: received?.headers.authorization,
      forwardedHost: received?.headers['x-forwarded-host'],
    }).toEqual({ internal: [], host: forged.host, authorization: basic, forwardedHost: forged.host });
  });

  it.each([
    ['GET', '/gateway/legacy-bridge/cfml/session.cfm?op=describe', 'session.describe'],
    ['POST', '/gateway/legacy-bridge/cfml/session.cfm?op=markUsed', 'session.markUsed'],
    ['GET', '/gateway/legacy-bridge/cfml/site.cfm?op=list', 'site.list'],
  ] as const)('answers %s %s with a validly signed assertion from outside as 404, reaching nothing', async (method, url, op) => {
    const { res, before, after } = await observed({
      method,
      url,
      headers: { 'x-opt2-bridge-assertion': signBridgeAssertion({ op }, h.bridgeKey) },
      ...(method === 'POST' ? { payload: { tokens: [] } } : {}),
    });
    expect({ status: res.statusCode, body: res.body, reached: reached(before, after) }).toEqual({ status: 404, body: '', reached: [] });
  });
});

describe('web relay trust boundary', () => {
  const userToken = (): Promise<string> => mintUserToken({ sub: 'relay-user', site: SITE_A, roles: [Roles.systemUser] });

  it.each<[string, (token: string) => Promise<Headers>, number]>([
    ["web's credential and a user token", async (token) => ({ authorization: `Bearer ${token}`, ...(await serviceHeaders('web')) }), 200],
    ["the gateway's own credential and a user token", async (token) => ({ authorization: `Bearer ${token}`, ...(await serviceHeaders('gateway')) }), 403],
    ['a user token alone', async (token) => ({ authorization: `Bearer ${token}` }), 403],
    ['no credential', async () => ({}), 403],
    ["web's credential addressed to people", async (token) => ({ authorization: `Bearer ${token}`, ...(await serviceHeaders('web', 'people')) }), 401],
  ])('the edge relay alias with %s', async (_label, credentials, status) => {
    const token = await userToken();
    const { res, before, after } = await observed({ method: 'GET', url: ALIAS_PATH, headers: await credentials(token) });
    expect(res.statusCode).toBe(status);
    if (status !== 200) {
      expect({ envelope: isDenialEnvelope(res.body), reached: reached(before, after) }).toEqual({ envelope: true, reached: [] });
      return;
    }
    const received = h.target('people').requests.at(-1);
    const caller = await testVerifier('people').invocationVerifier.verify(String(received?.headers[INVOCATION_HEADER]));
    expect({ reached: reached(before, after), authorization: received?.headers.authorization, caller: caller.name }).toEqual({
      reached: ['people'],
      authorization: `Bearer ${token}`,
      caller: SERVICE,
    });
  });

  it("records the callee's write position for the session, strips it and the caller's X-Opt2-* headers", async () => {
    const token = await mintUserToken({ sub: 'relay-writer', sid: 'ids-relay-writer', site: SITE_A, roles: [Roles.systemUser] });
    h.target('people').setWritePosition('people=42');
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: RELAY_PATH,
        headers: {
          authorization: `Bearer ${token}`,
          ...(await serviceHeaders('web')),
          'content-type': 'application/json',
          'x-opt2-write-position': 'people=99999',
          'x-opt2-original-url': '/forged',
        },
        payload: { note: 'relay write' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-opt2-write-position']).toBeUndefined();
      expect(internalHeaders(h.target('people').requests.at(-1)).filter((name) => name !== INVOCATION_HEADER)).toEqual([]);
      expect([...h.db.tables.barriers.values()].filter((row) => row.sessionId === 'ids-relay-writer')).toEqual([
        expect.objectContaining({ owner: 'people', xid: 42n, pending: 0 }),
      ]);
    } finally {
      h.target('people').setWritePosition();
    }
  });
});

describe('site-scoped user tokens', () => {
  const claimsOf = (token: string) => testVerifier().userVerifier.verify(token);
  const adminSiteCalls = (): number => h.identity.requests.filter((req) => req.path.endsWith('/admin-site')).length;

  it.each<[string, string, string, string, boolean]>([
    ['a site-less web screen', '/opt2/admin/finance/claims', 'tenant-b', 'tenant-b', true],
    ['a site-less web screen of a session without an admin site', '/opt2/admin/finance/claims', '', 'default', true],
    ['a web screen naming its siteid', '/opt2/admin/finance/claims?siteid=tenant-a', 'tenant-b', 'tenant-a', false],
    ['a site-less non-web target', '/opt2/stub/notes', 'tenant-b', 'default', false],
    ['a non-web target naming its siteid', '/opt2/stub/notes?siteid=tenant-b', 'tenant-a', 'tenant-b', false],
  ])('%s gets a token for its site', async (_label, url, adminSite, expectedSite, readsAdminSite) => {
    const callee = url.startsWith('/opt2/admin/') ? 'web' : 'stub';
    h.identity.setAdminSite(adminSite);
    const consulted = adminSiteCalls();
    const forged = await mintUserToken({ sub: 'forger', site: TENANT_B.siteId, roles: [Roles.s2, Roles.systemUser] });
    const res = await h.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${forged}`, ...(await serviceHeaders('web')), 'x-opt2-original-url': '/forged' },
    });
    expect(res.statusCode).toBe(200);
    const minted = h.identity.minted.at(-1);
    const received = h.target(callee).requests.at(-1);
    const caller = await testVerifier(callee).invocationVerifier.verify(String(received?.headers[INVOCATION_HEADER]));
    expect({
      siteId: minted?.request.siteId,
      authorization: received?.headers.authorization,
      tokenSite: (await claimsOf(minted?.token ?? '')).site,
      readsAdminSite: adminSiteCalls() > consulted,
      caller: caller.name,
      internal: internalHeaders(received).filter((name) => name !== INVOCATION_HEADER),
    }).toEqual({
      siteId: expectedSite,
      authorization: `Bearer ${minted?.token ?? ''}`,
      tokenSite: expectedSite,
      readsAdminSite,
      caller: SERVICE,
      internal: [],
    });
  });

  it("forwards a REST write with identity's token for the path's site, never the client's credential", async () => {
    const basic = `Basic ${Buffer.from(`rest-user:${randomUUID()}`).toString('base64')}`;
    h.identity.restSession(basic, {
      sessionId: 'ids-rest-writer',
      userId: 'U-REST',
      siteId: SITE_A,
      adminSite: '',
      roles: [Roles.systemUser],
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/_api/rest/v1/${SITE_A}/variationtargeting`,
      headers: { authorization: basic, 'content-type': 'application/json' },
      payload: { variationid: 'V1' },
    });
    expect(res.statusCode).toBe(200);
    const minted = h.identity.minted.at(-1);
    const received = h.target('strategies-content').requests.at(-1);
    expect({
      authenticatedSite: h.identity.authentications.at(-1)?.siteId,
      token: minted?.request,
      authorization: received?.headers.authorization,
      claims: await claimsOf(minted?.token ?? ''),
    }).toEqual({
      authenticatedSite: SITE_A,
      token: { sessionId: 'ids-rest-writer', siteId: SITE_A },
      authorization: `Bearer ${minted?.token ?? ''}`,
      claims: expect.objectContaining({ sub: 'U-REST', sid: 'ids-rest-writer', site: SITE_A, roles: [Roles.systemUser] }),
    });
  });

  it('forwards an unauthenticated REST write without any Authorization', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/_api/rest/v1/${SITE_A}/variationtargeting`,
      headers: { authorization: `Basic ${Buffer.from(`unknown:${randomUUID()}`).toString('base64')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(h.target('strategies-content').requests.at(-1)?.headers.authorization).toBeUndefined();
  });

  it("admits on the gateway's own routes only a siteid equal to the user token's site", async () => {
    const other = ROLE_SET.find((subject) => subject.name === 'other-tenant');
    if (other === undefined) throw new Error('ROLE_SET has no other-tenant subject');
    const headers = await authHeadersFor(other, { audience: SERVICE, site: SITE_A });
    const [own, foreign] = await Promise.all([
      h.app.inject({ method: 'GET', url: `/healthz?siteid=${TENANT_B.siteId}`, headers }),
      h.app.inject({ method: 'GET', url: `/healthz?siteid=${SITE_A}`, headers }),
    ]);
    expect([own.statusCode, foreign.statusCode]).toEqual([200, 403]);
  });
});

describe('deny by default at start-up', () => {
  /** Builds a gateway without background loops, lets `declare` add a route and awaits `ready`; everything it opened is closed. */
  async function startWith(declare: (app: FastifyInstance) => unknown): Promise<void> {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-gateway-authz-'));
    const unreachable = 'http://127.0.0.1:9';
    let app: FastifyInstance | undefined;
    try {
      const env = gatewayEnv(
        {
          legacy: unreachable,
          identity: unreachable,
          migration: unreachable,
          targets: Object.fromEntries(TARGET_SERVICES.map((name) => [name, unreachable])),
        },
        stateDir,
        randomBytes(32).toString('hex'),
      );
      app = await buildApp({ env, verifierOverride: testVerifier(SERVICE), db: createGatewayDb(), startBackground: false });
      declare(app);
      await app.ready();
    } finally {
      await app?.opt2.shutdown().catch(() => undefined);
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  const handler = async (): Promise<object> => ({});

  it.each<[string, (app: FastifyInstance) => unknown]>([
    ['no config.opt2', (app) => app.get('/internal/v1/undeclared', handler)],
    ['an empty requires list', (app) => app.get('/internal/v1/undeclared', { config: { opt2: { requires: [] } } }, handler)],
    [
      'both requires and public',
      (app) => app.get('/internal/v1/undeclared', { config: { opt2: { requires: [Roles.platformOperator], public: true } } }, handler),
    ],
    [
      'an edge flag on a role-gated route',
      (app) => app.get('/undeclared-edge', { config: { opt2: { requires: [Roles.platformOperator], edge: true } } }, handler),
    ],
    [
      'the service transport on a managed-task path',
      (app) => app.post('/internal/v1/tasks/undeclared', { config: { opt2: { transport: 'service', requires: [Roles.platformOperator] } } }, handler),
    ],
  ])('fails start-up for a route with %s', async (_label, declare) => {
    await expect(startWith(declare)).rejects.toBeInstanceOf(UndeclaredRouteError);
  });

  it('starts when every added route declares its roles', async () => {
    await expect(
      startWith((app) => app.get('/internal/v1/declared', { config: { opt2: { requires: [Roles.platformOperator] } } }, handler)),
    ).resolves.toBeUndefined();
  });
});
