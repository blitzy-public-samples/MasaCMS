// Edge dispatcher orchestration over stand-in legacy and service servers and recorded fakes of every collaborator.
import { Buffer } from 'node:buffer';
import { request as httpRequest, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import replyFrom, { type FastifyReplyFromOptions } from '@fastify/reply-from';
import { INVOCATION_HEADER, recordedRoutes, rolesForService } from '@opt2/platform/auth';
import { apiUnavailableResponse, adminUnavailableResponse, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { createLogger, validateLogRecord, type Logger } from '@opt2/platform/logging';
import {
  Agent,
  IDENTITY_SERVICE,
  LEGACY_POST_LIMIT_BYTES,
  ServiceUnavailableError,
  createService,
  loadEnv,
  systemClock,
  type FastifyInstance,
} from '@opt2/platform/service-kit';
import { DatabaseUnavailableError, tenantIdForSite } from '@opt2/platform/tenancy';
import { mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CutoverEntry, EntryKind, RouteFacts, RoutingIndex } from '../../src/cutover/types.js';
import { BarrierTimeoutError } from '../../src/dispatcher/barrier.js';
import { EDGE_METHODS, EDGE_ROUTE_URL, RELAY_ALIAS_ROUTE, registerEdgeRoute, type DispatcherDeps } from '../../src/dispatcher/dispatch.js';
import { routedFailContext, type Destination, type MatchOutcome } from '../../src/dispatcher/match.js';
import type { PendingProbes } from '../../src/dispatcher/request-writes.js';
import { sendRequestTarget } from '../../src/dispatcher/request-target.js';
import { WindowOpenError } from '../../src/dispatcher/write-window.js';
import type { BridgeClient } from '../../src/session/bridge-client.js';
import { createCsrfContinuity, type CsrfHandle } from '../../src/session/csrf.js';
import type { IdentityClient, LegacyDescribe, SettleInput } from '../../src/session/identity-client.js';
import { createInvalidation, type LegacyLogoutOutcome } from '../../src/session/invalidation.js';
import type { JarCookies, JarRow, JarUpsert, LegacyJar, LockedJar } from '../../src/session/jar.js';
import type { SessionMode } from '../../src/session/mode.js';
import { createSessionResolver, type SessionResolution } from '../../src/session/resolve.js';
import { createSessionStateChecker } from '../../src/session/state-check.js';
import { sendBytes, startHttpDouble, type HttpDouble } from '../helpers/http-double.js';

const SILENT = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
const SESSION_ID = 'S1';
const RATING_UNIT = 'content.content_rating';
const MINTED_TENANT = '00000000-0000-4000-8000-0000000000a1';
const MINTED_USER = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
/** Claims identity minted the fake token cache's `user-token-1` with. */
const MINTED_CLAIMS = {
  iss: 'opt2-local-identity',
  aud: 'opt2-local',
  sub: MINTED_USER,
  sid: SESSION_ID,
  tid: MINTED_TENANT,
  site: 'default',
  roles: [],
  s2: false,
  epoch: 3,
  iat: 1_700_000_000,
  exp: 4_000_000_000,
};

/** The request start's cookies a cookieless desktop client receives on a session-managed target route, in order. */
const REQUEST_START_COOKIES = [
  expect.stringMatching(/^MXP_TRACKINGID=[0-9A-F]{8}%2D[0-9A-F]{4}%2D[0-9A-F]{4}%2D[0-9A-F]{16}; path=\/; HttpOnly; Max-Age=946080000; Expires=/),
  expect.stringMatching(/^mobileFormat=false; path=\/; HttpOnly; Max-Age=946080000; Expires=/),
];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile';

/** What the fake matcher answers for a request target and the index it is matched against. */
interface Script {
  entry?: Partial<CutoverEntry> & { route: string; kind: EntryKind };
  destination: 'legacy' | 'target' | 'unavailable' | 'bare' | 'relay';
  family?: RouteKeyResult['family'];
  /** The request's `siteid`; `null` when it names none. Default `default`. */
  siteId?: string | null;
  /** The method the route key reads after X-HTTP-Method-Override. Default `GET`. */
  httpMethod?: string;
  /** Routes besides the entry's whose freeze holds the request. */
  holdRoutes?: readonly string[];
  /** Probes the request's writes wait on. */
  pendingProbes?: PendingProbes;
}

const RELOAD_KEY = 'reload:application';

interface Harness {
  app: FastifyInstance;
  legacy: HttpDouble;
  svc: HttpDouble;
  /** Ordered collaborator calls. */
  calls: string[];
  deps: DispatcherDeps;
  frozen: Set<string>;
  setScript(script: (url: string, call: number) => Script): void;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A routing index whose `targetUnits` are target-authoritative and whose login group has `login` authority. */
function indexOf(version: string, targetUnits: readonly string[] = [], login: 'legacy' | 'target' = 'legacy'): RoutingIndex {
  return {
    table: { tableVersion: version } as RoutingIndex['table'],
    entryFor: () => undefined,
    matchKeys: [] as unknown as RoutingIndex['matchKeys'],
    unitAuthority: (unit) => (targetUnits.includes(unit) ? 'target' : 'legacy'),
    groupOf: () => undefined,
    groupAuthority: () => 'legacy',
    loginGroupAuthority: () => login,
  };
}

function session(mode: SessionMode, legacyCookies: JarCookies = {}, setCookies: string[] = []): SessionResolution {
  return { kind: 'session', sessionId: SESSION_ID, epoch: 3, mode, legacyCookies, setCookies };
}

/** A session resolution whose jar carries a pending identity end. */
function pendingSession(mode: SessionMode, legacyCookies: JarCookies = {}): SessionResolution {
  return { kind: 'session', sessionId: SESSION_ID, epoch: 3, mode, legacyCookies, setCookies: [], identityEndPending: true };
}

function jarRow(cookies: JarCookies): JarRow {
  return { sessionId: SESSION_ID, legacySessionId: 'L-1', cookies, mode: 'target-primary', hydratedEpoch: 3, updatedAt: new Date() };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** The url scope the fake matcher reports for a request target: repeated names comma-joined. */
function urlScopeOf(url: string): Record<string, string> {
  const scope = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(url.split('?')[1] ?? '')) {
    const previous = scope.get(name);
    scope.set(name, previous === undefined ? value : `${previous},${value}`);
  }
  return Object.fromEntries(scope);
}

/** `active: null` starts the gateway with no active version; `logger` defaults to a silent one; `cookieSettings` to Masa's defaults. */
async function harness(
  opts: {
    active?: RoutingIndex | null;
    facts?: Record<string, RouteFacts>;
    logger?: Logger;
    cookieSettings?: DispatcherDeps['cookieSettings'];
  } = {},
): Promise<Harness> {
  const facts = opts.facts ?? {};
  const calls: string[] = [];
  const frozen = new Set<string>();
  const legacy = await startHttpDouble((_req, res) => sendBytes(res, 200, 'legacy-body', { 'x-legacy': '1' }));
  const svc = await startHttpDouble((_req, res) => sendBytes(res, 200, 'svc-body', { 'content-type': 'text/plain' }));
  let script: (url: string, call: number) => Script = () => ({ destination: 'legacy' });
  const current = opts.active === null ? undefined : (opts.active ?? indexOf('v0001'));
  let matches = 0;
  const app = await createService({
    name: 'gateway',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8100',
      OPT2_SERVICE_NAME: 'gateway',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('gateway'),
    logger: opts.logger ?? SILENT,
  });

  const outcomeFor = (url: string, index: RoutingIndex | undefined): MatchOutcome => {
    const s = script(url, matches++);
    const path = url.split('?')[0] ?? url;
    if (s.destination === 'relay') {
      const rest = url.slice('/opt2/svc/'.length);
      const slash = rest.indexOf('/');
      const destination = { kind: 'relay' as const, service: rest.slice(0, slash), path: rest.slice(slash) };
      return { result: undefined, entry: undefined, destination, failContext: { surface: 'api' } };
    }
    const family = s.family ?? (path.startsWith('/admin') ? 'admin' : 'api');
    const key = family === 'reload' ? RELOAD_KEY : (s.entry?.route ?? `${family}:unlisted`);
    const siteId = s.siteId === undefined ? 'default' : s.siteId;
    const httpMethod = s.httpMethod ?? 'GET';
    const result: RouteKeyResult =
      siteId === null
        ? { key, baseKey: key, family, httpMethod, params: {} }
        : { key, baseKey: key, family, httpMethod, params: { siteid: siteId }, siteId };
    const destinations: Record<Script['destination'], Exclude<Destination, { kind: 'relay' }>> = {
      legacy: { kind: 'legacy' },
      target: { kind: 'target', service: 'people', serviceUrl: svc.url, path: url, isWeb: false },
      unavailable: { kind: 'unavailable', reason: 'no-service-url' },
      bare: { kind: 'bare', status: 404 },
      relay: { kind: 'unavailable', reason: 'no-service-url' },
    };
    const entry =
      s.entry === undefined
        ? undefined
        : ({ owningService: 'people', tableVersion: 'v0001', state: 'legacy', units: [], disposition: 'carry', ...s.entry } as CutoverEntry);
    const destination: Exclude<Destination, { kind: 'relay' }> =
      index === undefined ? { kind: 'unavailable', reason: 'no-active-version' } : destinations[s.destination];
    const failContext = routedFailContext(result, entry, destination, url);
    const holds = s.holdRoutes === undefined ? {} : { holdRoutes: s.holdRoutes };
    const pending = s.pendingProbes === undefined ? {} : { pendingProbes: s.pendingProbes };
    return { result, entry, destination, failContext, urlScope: urlScopeOf(url), scanFailed: false, ...holds, ...pending };
  };

  const deps: DispatcherDeps = {
    matcher: {
      match: vi.fn(async (request, _body, index) => {
        calls.push(`match:${index?.table.tableVersion ?? 'none'}`);
        return outcomeFor(request.url, index);
      }),
    },
    state: {
      active: () => current,
      readEpochForWrite: vi.fn(async () => {
        calls.push('readEpoch');
        if (current === undefined) throw new WindowOpenError('none', new Error('no active version'));
        return { epoch: 1, index: current };
      }),
      isFrozen: (route) => frozen.has(route),
      waitUnfrozen: vi.fn(async (route, ms = 30_000) => {
        calls.push(`wait:${route}`);
        const until = Date.now() + ms;
        while (frozen.has(route) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        return !frozen.has(route);
      }),
    },
    inflight: {
      register: vi.fn(async (input) => {
        calls.push(`register:${input.route}:${input.side}:${input.windowId ?? '-'}`);
      }),
      remove: vi.fn(async () => {
        calls.push('remove');
        return true;
      }),
      abandon: vi.fn(async () => {
        calls.push('abandon');
        return true;
      }),
    },
    windows: {
      open: vi.fn(async () => {
        calls.push('window.open');
        return { windowId: 'W1' };
      }),
      complete: vi.fn(async (windowId, input) => {
        calls.push(`window.complete:${windowId}:${String(input.forwarded)}:${input.legacyStatus ?? '-'}`);
        return { state: 'import-pending' as const };
      }),
      scope: vi.fn(() => ({ table: true as const })),
      probeOrphanArchive: vi.fn(() => {
        calls.push('probe.orphanArchive');
        return Promise.resolve(false);
      }),
    },
    staticFiles: {
      isCfml: vi.fn(() => {
        calls.push('probe.cfml');
        return Promise.resolve(true);
      }),
    },
    barrier: {
      declare: vi.fn(async (sessionId, owner) => {
        calls.push(`declare:${sessionId}:${owner}`);
      }),
      record: vi.fn(async () => undefined),
      release: vi.fn(async (sessionId, owner) => {
        calls.push(`release:${sessionId}:${owner}`);
      }),
      awaitForSession: vi.fn(async (sessionId) => {
        calls.push(`barrier:${sessionId}`);
      }),
      awaitPositions: vi.fn(async () => undefined),
      awaitOwners: vi.fn(async () => undefined),
    },
    resolver: {
      resolveSession: vi.fn(async (): Promise<SessionResolution> => ({ kind: 'none', setCookies: [] })),
      resolveLegacyBound: vi.fn(async (): Promise<SessionResolution> => ({ kind: 'none', setCookies: [] })),
      adoptAfterLegacy: vi.fn(async (_input, o): Promise<SessionResolution> => ({ kind: 'none', setCookies: [...o.setCookies] })),
    },
    tokenCache: { get: vi.fn(async () => ({ token: 'user-token-1', claims: MINTED_CLAIMS })) },
    identity: { adminSite: vi.fn(async () => ''), snapshot: vi.fn(async () => undefined) },
    stateCheck: {
      check: vi.fn(async () => ({ state: 'active' as const, epoch: 3, userId: 'U', siteId: 'default', epochChanged: false })),
    },
    hydrator: {
      ensureHydrated: vi.fn(async () => {
        calls.push('hydrate');
        return undefined;
      }),
    },
    carry: { beforeLegacy: vi.fn(async () => undefined), afterLegacy: vi.fn(async () => undefined) },
    csrf: {
      beforeLegacy: vi.fn(async () => {
        calls.push('csrf.before');
        return undefined;
      }),
      afterLegacy: vi.fn(async () => {
        calls.push('csrf.after');
      }),
    },
    invalidation: {
      afterTargetLogout: vi.fn(async (sessionId) => {
        calls.push(`afterTargetLogout:${sessionId}`);
      }),
      beforeLegacyLogout: vi.fn(async (sessionId) => {
        calls.push(`beforeLegacyLogout:${sessionId}`);
      }),
      afterLegacyLogout: vi.fn(async (sessionId) => {
        calls.push(`afterLegacyLogout:${sessionId}`);
      }),
      afterLegacyLogin: vi.fn(async (sessionId) => {
        calls.push(`afterLegacyLogin:${sessionId}`);
        return undefined;
      }),
      completePending: vi.fn(async (sessionId) => {
        calls.push(`completePending:${sessionId}`);
        return 'logged-out' as const;
      }),
      afterTargetLogin: vi.fn((sessionId: string) => {
        calls.push(`afterTargetLogin:${sessionId}`);
      }),
    },
    facts: { get: (route) => facts[route], routes: () => Object.keys(facts) },
    auth: app.opt2.auth,
    relay: {
      env: { OPT2_SERVICE_URLS: { people: svc.url } },
      invocation: app.opt2.auth.invocationMinter,
      barrier: {
        declare: async () => undefined,
        record: async () => undefined,
        release: async () => undefined,
        awaitPositions: async () => undefined,
        awaitOwners: async () => undefined,
      },
      sessionMode: () => 'legacy-primary',
    },
    legacyOrigin: legacy.url,
    cookieSettings: opts.cookieSettings ?? { secure: false, domain: '' },
    clock: systemClock,
  };

  // reply-from's own agent plus the gateway's request target, so legacy receives each path as sent.
  const undici = new Agent().compose(sendRequestTarget) as FastifyReplyFromOptions['undici'];
  await app.register(replyFrom, { undici, destroyAgent: true });
  await app.register(async (edge) => {
    edge.removeAllContentTypeParsers();
    edge.addContentTypeParser<Buffer>('*', { parseAs: 'buffer', bodyLimit: LEGACY_POST_LIMIT_BYTES }, (_request, body, done) =>
      done(null, body),
    );
    registerEdgeRoute(edge, deps);
  });
  await app.ready();
  closers.push(async () => {
    await app.opt2.shutdown();
    await Promise.all([legacy.close(), svc.close()]);
  });
  return {
    app,
    legacy,
    svc,
    calls,
    deps,
    frozen,
    setScript: (next) => {
      script = next;
      matches = 0;
    },
  };
}

/** The register, epoch, window and removal calls in order. */
const rowCalls = (calls: readonly string[]): string[] =>
  calls.filter((call) => /^(register|readEpoch|remove|abandon|window\.)/.test(call));

describe('registerEdgeRoute', () => {
  it('declares every edge method on the catch-all as a public edge route', async () => {
    const h = await harness();
    const edge = recordedRoutes(h.app).filter((route) => route.url === EDGE_ROUTE_URL);
    expect(edge.map((route) => route.method).sort()).toEqual([...EDGE_METHODS]);
    expect(new Set(edge.map((route) => JSON.stringify(route.config)))).toEqual(
      new Set([JSON.stringify({ public: true, edge: true, transport: 'service' })]),
    );
  });

  it.each([...EDGE_METHODS])('matches / and any path for %s', async (method) => {
    const h = await harness();
    expect((await h.app.inject({ method, url: '/' })).statusCode).toBe(200);
    expect((await h.app.inject({ method, url: '/a/b' })).statusCode).toBe(200);
    expect(h.legacy.requests.map((request) => request.url)).toEqual(['/', '/a/b']);
  });
});

describe('gateway-served answers', () => {
  it.each([
    ['/admin/?muraAction=cperm.main', adminUnavailableResponse()],
    ['/_api/json/v1/default/content', apiUnavailableResponse()],
  ])('answers %s with the legacy 503 while no version is active', async (url, expected) => {
    const h = await harness({ active: null });
    const res = await h.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(expected.headers['Content-Type']);
    if (url.startsWith('/admin')) expect(res.body).toBe(expected.body);
    else expect(JSON.parse(res.body)).toEqual(JSON.parse(expected.body));
    expect(h.legacy.requests).toHaveLength(0);
  });

  it('answers the bridge path with a bare 404', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'gateway:bridge', kind: 'read' }, destination: 'bare' }));
    const res = await h.app.inject({ method: 'GET', url: '/gateway/legacy-bridge/cfml/session.cfm' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('');
    expect(h.legacy.requests).toHaveLength(0);
  });

  it('fails closed on a body in a charset the gateway does not decode', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=Shift_JIS' },
      payload: 'a=1',
    });
    expect(res.statusCode).toBe(503);
    expect(h.legacy.requests).toHaveLength(0);
  });
});

describe("bodies legacy's servlet container rejects", () => {
  const MULTIPART = 'multipart/form-data; boundary=x';
  const UNTERMINATED = '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\nvalue';
  /** The container's answer to such a body, sent before any CFML runs: none of Masa's headers. */
  const CONTAINER_PAGE = '<html><body>Error processing request</body></html>';
  const containerAnswer = (res: ServerResponse): void =>
    sendBytes(res, 500, CONTAINER_PAGE, { 'content-type': 'text/html;charset=UTF-8', 'set-cookie': 'container=1; Path=/' });

  it.each(
    [
      ['no boundary', 'multipart/form-data', 'x'],
      ['an unclosed boundary quote', 'multipart/form-data; boundary="x', '--x--\r\n'],
      ['a body not opening with its boundary', MULTIPART, 'preamble\r\n--x--\r\n'],
      ['content running to the end of the body', MULTIPART, UNTERMINATED],
      ['a header block ending the body', MULTIPART, '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\n'],
      ['a disposition other than form-data', MULTIPART, '--x\r\nContent-Disposition: attachment; name="a"\r\n\r\n1\r\n--x--\r\n'],
      ['a disposition without a quoted name', MULTIPART, '--x\r\nContent-Disposition: form-data; name=a\r\n\r\n1\r\n--x--\r\n'],
      ['a part without a disposition', MULTIPART, '--x\r\nContent-Type: text/plain\r\n\r\n1\r\n--x--\r\n'],
      ['a part Content-Type line without a value', MULTIPART, '--x\r\nContent-Disposition: form-data; name="a"\r\nContent-Type:x\r\n\r\n1\r\n--x--\r\n'],
      ['an illegal charset name', 'application/x-www-form-urlencoded; charset=@@', 'a=1'],
    ].flatMap(([body, contentType, payload]) =>
      [
        { route: 'legacy-bound', script: { destination: 'legacy' } as Script },
        { route: 'target-bound', script: { entry: { route: 'fixture:finance/records@post', kind: 'write', state: 'target' }, destination: 'target', family: 'fixture' } as Script },
      ].map((destination) => ({ body, contentType, payload, ...destination })),
    ),
  )('relays a $route request with $body to legacy as sent and passes its answer through untouched', async ({ contentType, payload, script }) => {
    const h = await harness();
    h.setScript(() => script);
    h.legacy.setHandler((_req, res) => containerAnswer(res));
    const url = '/legacy-fixtures/cfml/api.cfm/finance/records?x=1';
    const res = await h.app.inject({ method: 'POST', url, headers: { 'content-type': contentType, cookie: 'CFID=1' }, payload });
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
    expect(res.headers['set-cookie']).toBe('container=1; Path=/');
    expect(res.headers.generator).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.body).toBe(CONTAINER_PAGE);
    expect(h.legacy.requests).toHaveLength(1);
    const [received] = h.legacy.requests;
    expect(received?.url).toBe(url);
    expect(received?.headers['content-type']).toBe(contentType);
    expect(received?.headers.cookie).toBe('CFID=1');
    expect(received?.body.toString('latin1')).toBe(payload);
    expect(h.svc.requests).toHaveLength(0);
    // Matched once, without the body, for its family alone; no session, claim, barrier, row or window.
    expect(h.calls).toEqual(['match:v0001']);
    expect(vi.mocked(h.deps.matcher.match).mock.calls[0]?.[1]).toEqual({ form: {}, json: undefined, files: [] });
    expect(h.deps.resolver.resolveLegacyBound).not.toHaveBeenCalled();
    expect(h.deps.resolver.resolveSession).not.toHaveBeenCalled();
  });

  it("withholds legacy's session cookies from the relayed answer in target-primary, as from any legacy answer", async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    h.legacy.setHandler((_req, res) =>
      sendBytes(res, 500, CONTAINER_PAGE, { 'content-type': 'text/html;charset=UTF-8', 'set-cookie': ['JSESSIONID=L; Path=/', 'container=1; Path=/'] }),
    );
    const res = await h.app.inject({ method: 'POST', url: '/admin/', headers: { 'content-type': MULTIPART }, payload: UNTERMINATED });
    expect(res.statusCode).toBe(500);
    expect(res.headers['set-cookie']).toEqual(['container=1; Path=/']);
    expect(res.body).toBe(CONTAINER_PAGE);
  });

  it.each<{ label: string; url: string; script: Script; relayed: boolean; active?: null }>([
    { label: 'a legacy route while no version is active', url: '/admin/', script: { destination: 'legacy' }, relayed: false, active: null },
    { label: 'a legacy static file', url: '/admin/assets/css/admin.min.css', script: { destination: 'legacy', family: 'static' }, relayed: true },
    { label: "web's static file", url: '/_next/static/a.js', script: { entry: { route: 'static:/_next/**', kind: 'static', state: 'target' }, destination: 'target', family: 'static' }, relayed: false },
    { label: 'a target OPT-2 path', url: '/opt2/stub/items', script: { entry: { route: 'opt2:/opt2/stub/**', kind: 'write', state: 'target' }, destination: 'target', family: 'opt2' }, relayed: false },
    { label: 'the legacy bridge', url: '/gateway/legacy-bridge/cfml/session.cfm', script: { entry: { route: 'gateway:bridge', kind: 'read' }, destination: 'bare', family: 'bridge' }, relayed: false },
    { label: 'the relay alias', url: '/opt2/svc/people/x', script: { destination: 'relay' }, relayed: false },
  ])('sends such a body to $label only where legacy also serves it, failing closed elsewhere', async ({ url, script, relayed, active }) => {
    const h = await harness(active === null ? { active } : {});
    h.setScript(() => script);
    h.legacy.setHandler((_req, res) => containerAnswer(res));
    const res = await h.app.inject({ method: 'POST', url, headers: { 'content-type': MULTIPART }, payload: UNTERMINATED });
    expect(res.statusCode).toBe(relayed ? 500 : 503);
    expect(h.legacy.requests).toHaveLength(relayed ? 1 : 0);
    expect(h.svc.requests).toHaveLength(0);
  });
});

describe('forwarding', () => {
  it('passes an unmoved request to legacy with Host, client Authorization and body, without internal headers', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/index.cfm/_api/json/v1/default/content?a=1&a=2',
      headers: {
        host: 'site.example',
        authorization: 'Basic dTpw',
        'x-opt2-original-url': '/forged',
        'x-serverless-authorization': 'Bearer forged',
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-legacy']).toBe('1');
    const received = h.legacy.requests[0];
    expect(received?.url).toBe('/index.cfm/_api/json/v1/default/content?a=1&a=2');
    expect(received?.headers.host).toBe('site.example');
    expect(received?.headers.authorization).toBe('Basic dTpw');
    expect(received?.headers['x-opt2-original-url']).toBeUndefined();
    expect(received?.headers['x-serverless-authorization']).toBeUndefined();
    expect([...(received?.body ?? [])]).toEqual([1, 2, 3]);
    expect(vi.mocked(h.deps.resolver.resolveLegacyBound).mock.calls[0]?.[0].query).toEqual({ a: '1,2' });
  });

  it.each(
    [
      { ending: 'inside its first header block', payload: '--x\r\nbroken' },
      { ending: 'right after its first delimiter', payload: '--x' },
    ].flatMap((body) =>
      [
        { route: 'legacy-bound', side: 'legacy' as const, script: { destination: 'legacy' } as Script },
        {
          route: 'target-bound',
          side: 'svc' as const,
          script: { entry: { route: 'fixture:finance/records@post', kind: 'write', state: 'target' }, destination: 'target', family: 'fixture' } as Script,
        },
      ].map((destination) => ({ ...body, ...destination })),
    ),
  )('forwards a $route multipart body ending $ending as sent, its Content-Length intact', async ({ payload, side, script }) => {
    const h = await harness();
    h.setScript(() => script);
    const url = '/legacy-fixtures/cfml/api.cfm/finance/records';
    const res = await h.app.inject({ method: 'POST', url, headers: { 'content-type': 'multipart/form-data; boundary=x' }, payload });
    expect(res.statusCode).toBe(200);
    expect(h[side].requests).toHaveLength(1);
    const [received] = h[side].requests;
    expect(received?.headers['content-length']).toBe(String(Buffer.byteLength(payload)));
    expect(received?.body.toString('latin1')).toBe(payload);
  });

  it('sends a target route to its service with the session token and its own invocation credential', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: 'target' }, destination: 'target' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary', {}, ['CFID=1;path=/;']));
    const res = await h.app.inject({
      method: 'GET',
      url: '/_api/json/v1/default/content/x',
      headers: { authorization: 'Basic dTpw', 'x-opt2-thing': '1', 'x-opt2-path-pairs': 'title=onLoad', 'x-serverless-authorization': 'Bearer forged' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(['CFID=1;path=/;', ...REQUEST_START_COOKIES]);
    const received = h.svc.requests[0];
    expect(received?.headers.authorization).toBe('Bearer user-token-1');
    expect(received?.headers['x-serverless-authorization']).toMatch(/^Bearer (?!forged)/);
    expect(received?.headers['x-opt2-thing']).toBeUndefined();
    // Only web's relay may name path pairs; a client's own header would keep its values from the owner's scan.
    expect(received?.headers['x-opt2-path-pairs']).toBeUndefined();
    expect(h.deps.tokenCache.get).toHaveBeenCalledWith(SESSION_ID, 'default', 3);
    expect(h.legacy.requests).toHaveLength(0);
  });

  it.each<[string, RouteKeyResult['family'], string | null, string, string, boolean]>([
    ['an admin request naming its site, over the stored one', 'admin', 'tenant-b', 'tenant-a', 'tenant-b', false],
    ['an admin request without a site, for the stored site', 'admin', null, 'tenant-a', 'tenant-a', true],
    ['an admin request with an empty siteid, for the stored site', 'admin', '', 'tenant-a', 'tenant-a', true],
    ['an admin request without a site, for default when none is stored', 'admin', null, '', 'default', true],
    ['a non-admin request without a site, for default', 'api', null, 'tenant-a', 'default', false],
    ['a non-admin request with an empty siteid, for default', 'api', '', 'tenant-a', 'default', false],
  ])('mints the user token of %s', async (_label, family, siteId, stored, expected, readsStored) => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: `${family}:screen`, kind: 'read', state: 'target' }, destination: 'target', family, siteId }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary'));
    vi.mocked(h.deps.identity.adminSite).mockResolvedValue(stored);
    const res = await h.app.inject({ method: 'GET', url: family === 'admin' ? '/admin/?muraAction=screen' : '/_api/json/v1/content' });
    expect(res.statusCode).toBe(200);
    expect(h.deps.tokenCache.get).toHaveBeenCalledWith(SESSION_ID, expected, 3);
    expect(h.deps.identity.adminSite).toHaveBeenCalledTimes(readsStored ? 1 : 0);
    if (readsStored) expect(h.deps.identity.adminSite).toHaveBeenCalledWith(SESSION_ID);
    expect(h.svc.requests[0]?.headers.authorization).toBe('Bearer user-token-1');
  });

  it('reads no stored admin site for an ended session, which is forwarded anonymously', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:screen', kind: 'read', state: 'target' }, destination: 'target', siteId: null }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary'));
    vi.mocked(h.deps.stateCheck.check).mockResolvedValueOnce({ state: 'ended', epoch: 4, userId: '', siteId: '', epochChanged: true });
    await h.app.inject({ method: 'GET', url: '/admin/?muraAction=screen' });
    expect(h.deps.identity.adminSite).not.toHaveBeenCalled();
    expect(h.deps.tokenCache.get).not.toHaveBeenCalled();
    expect(h.svc.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('fails closed with the admin 503, calling no service, when identity cannot report the stored admin site', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:screen', kind: 'read', state: 'target' }, destination: 'target', siteId: null }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary'));
    vi.mocked(h.deps.identity.adminSite).mockRejectedValueOnce(new ServiceUnavailableError(IDENTITY_SERVICE, new Error('down')));
    const res = await h.app.inject({ method: 'GET', url: '/admin/?muraAction=screen' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(adminUnavailableResponse().body);
    expect(h.deps.tokenCache.get).not.toHaveBeenCalled();
    expect(h.svc.requests).toHaveLength(0);
  });

  it.each([
    ['refused', (svc: HttpDouble) => svc.close()],
    ['502', (svc: HttpDouble) => svc.setHandler((_req, res) => sendBytes(res, 502, 'bad gateway'))],
    ['503', (svc: HttpDouble) => svc.setHandler((_req, res) => sendBytes(res, 503, 'unavailable'))],
  ])('fails closed when the owner is %s, never calling legacy', async (_case, breakService) => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: 'target' }, destination: 'target' }));
    await breakService(h.svc);
    const res = await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual(JSON.parse(apiUnavailableResponse({ method: 'findOne' }).body));
    expect(h.legacy.requests).toHaveLength(0);
  });

  it('answers identity credential responses verbatim, Origin echo included, without calling the service', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'rest:content', kind: 'read', state: 'target' }, destination: 'target', family: 'rest' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce({
      kind: 'response',
      status: 401,
      headers: {
        'Access-Control-Allow-Origin': 'http://localhost',
        'Access-Control-Allow-Credentials': 'true',
        'www-authenticate': 'Bearer error="invalid_token"',
      },
      body: '{"error":"invalid_token"}',
    });
    const res = await h.app.inject({ method: 'GET', url: '/_api/rest/v1/default/content', headers: { origin: 'http://localhost' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(res.body).toBe('{"error":"invalid_token"}');
    expect(h.svc.requests).toHaveLength(0);
  });

  it.each<[string, SessionResolution, string | undefined]>([
    [
      'its session',
      { kind: 'session', sessionId: SESSION_ID, epoch: 3, mode: 'legacy-primary', legacyCookies: {}, setCookies: [], consumedParams: ['access_token', 'client_id'] },
      'access_token,client_id',
    ],
    ['a session that consumed nothing', session('legacy-primary'), undefined],
  ])('forwards a REST continuation in %s unchanged, naming only the params identity consumed', async (_label, resolution, consumed) => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'rest:content', kind: 'read', state: 'target' }, destination: 'target', family: 'rest' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(resolution);
    const res = await h.app.inject({
      method: 'POST',
      url: '/_api/rest/v1/default/content?access_token=T&x=a%20b',
      // A client's own consumed-params header is a forgery the gateway drops.
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-opt2-consumed-params': 'method,siteid' },
      payload: 'client_id=C&y=%C3%A9',
    });
    expect(res.statusCode).toBe(200);
    const received = h.svc.requests[0];
    expect(received?.url).toBe('/_api/rest/v1/default/content?access_token=T&x=a%20b');
    expect(received?.body.toString('latin1')).toBe('client_id=C&y=%C3%A9');
    expect(received?.headers['content-length']).toBe('20');
    expect(received?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(received?.headers['x-opt2-consumed-params']).toBe(consumed);
  });

  it('forwards an ended target session anonymously after ending its legacy session', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: 'target' }, destination: 'target' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary'));
    vi.mocked(h.deps.stateCheck.check).mockResolvedValueOnce({ state: 'ended', epoch: 4, userId: '', siteId: '', epochChanged: true });
    await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x' });
    expect(h.calls).toContain(`afterTargetLogout:${SESSION_ID}`);
    expect(h.svc.requests[0]?.headers.authorization).toBeUndefined();
  });

  it.each<[string, string | null, string]>([
    ['naming no site', null, 'default'],
    ['naming its site', 'tenant-a', 'tenant-a'],
  ])("forwards a REST request %s with the token its resolution minted at the request's token site, never reading its state again", async (_label, siteId, tokenSite) => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'rest:content', kind: 'read', state: 'target' }, destination: 'target', family: 'rest', siteId }));
    vi.mocked(h.deps.resolver.resolveSession).mockImplementationOnce(async (_input, { mintToken }) => {
      if (mintToken === undefined) throw new TypeError('the dispatcher passed no token minter');
      return { ...session('legacy-primary'), token: await mintToken(SESSION_ID, 3) };
    });
    vi.mocked(h.deps.stateCheck.check).mockResolvedValue({ state: 'ended', epoch: 4, userId: '', siteId: '', epochChanged: true });
    const res = await h.app.inject({ method: 'GET', url: '/_api/rest/v1/default/content' });
    expect(res.statusCode).toBe(200);
    expect(h.deps.stateCheck.check).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.tokenCache.get).mock.calls).toEqual([[SESSION_ID, tokenSite, 3]]);
    expect(h.svc.requests[0]?.headers.authorization).toBe('Bearer user-token-1');
    expect(h.calls).not.toContain(`afterTargetLogout:${SESSION_ID}`);
  });

  it('maps target session Set-Cookie onto the jar in target-primary, keeping deletions and other cookies', async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    h.setScript(() => ({ entry: { route: 'admin:clogin.login', kind: 'write', state: 'target' }, destination: 'target' }));
    const jar: JarCookies = {
      CFID: { name: 'cfid', value: 'L1', attributes: 'path=/;HttpOnly;' },
      JSESSIONID: { name: 'JSESSIONID', value: 'LJ', attributes: 'path=/;' },
    };
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('target-primary', jar));
    const deletion = 'JSESSIONID=;expires=Thu, 01-Jan-1970 00:00:00 GMT;path=/;';
    h.svc.setHandler((_req, res) => sendBytes(res, 200, 'ok', { 'set-cookie': ['CFID=T9;Path=/', deletion, 'x=1', 'CFTOKEN=T2;path=/;'] }));
    const res = await h.app.inject({ method: 'POST', url: '/admin/?muraAction=clogin.login' });
    expect(res.headers['set-cookie']).toEqual(['cfid=T9;path=/;HttpOnly;', deletion, 'x=1', 'CFTOKEN=T2;path=/;', ...REQUEST_START_COOKIES]);
  });

  it.each<[string, string, SessionResolution, string[]]>([
    ['a login in an active session', 'admin:clogin.login', session('target-primary'), ['target', `afterTargetLogin:${SESSION_ID}`, `release:${SESSION_ID}:people`]],
    ['a write that logs no one in', 'admin:cusers.update', session('target-primary'), ['target', `release:${SESSION_ID}:people`]],
    ['a login without a session', 'admin:clogin.login', { kind: 'none', setCookies: [] }, ['target']],
  ])('forgets the session tokens and state for %s only between the target answer and the response', async (_label, route, resolution, sequence) => {
    const facts: Record<string, RouteFacts> = {
      'admin:clogin.login': { route: 'admin:clogin.login', csrfValidation: 'validates', writeSet: [], keyScope: [], sessionEffects: ['login'] },
      'admin:cusers.update': { route: 'admin:cusers.update', csrfValidation: 'validates', writeSet: ['tusers'], keyScope: [], sessionEffects: ['none'] },
    };
    const h = await harness({ active: indexOf('v0002', [], 'target'), facts });
    h.setScript(() => ({ entry: { route, kind: 'write', state: 'target' }, destination: 'target' }));
    vi.mocked(h.deps.resolver).resolveSession.mockResolvedValueOnce(resolution);
    h.svc.setHandler((_req, res) => {
      h.calls.push('target');
      sendBytes(res, 302, '', { location: './?muraAction=cSettings.list' });
    });
    const res = await h.app.inject({ method: 'POST', url: `/admin/?muraAction=${route.slice('admin:'.length)}` });
    expect(res.statusCode).toBe(302);
    expect(h.calls.filter((call) => /^(target|afterTargetLogin:|release:)/.test(call))).toEqual(sequence);
  });

  it('ends both sessions when the target serves a logout', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:clogin.logout', kind: 'read', state: 'target' }, destination: 'target' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary'));
    await h.app.inject({ method: 'GET', url: '/admin/?muraAction=clogin.logout' });
    expect(h.calls).toContain(`afterTargetLogout:${SESSION_ID}`);
  });

  it('answers the legacy 503 without the target logout cookies when the legacy session cannot be ended', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:clogin.logout', kind: 'read', state: 'target' }, destination: 'target' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary'));
    vi.mocked(h.deps.invalidation.afterTargetLogout).mockRejectedValueOnce(new Error('legacy bridge unavailable'));
    h.svc.setHandler((_req, res) => sendBytes(res, 302, '', { 'set-cookie': ['CFID=;expires=Thu, 01-Jan-1970 00:00:00 GMT;path=/;'] }));
    const res = await h.app.inject({ method: 'GET', url: '/admin/?muraAction=clogin.logout' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(adminUnavailableResponse().body);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(h.svc.requests).toHaveLength(1);
  });

  it.each<[LegacyLogoutOutcome, boolean]>([
    ['logged-out', false],
    ['unknown', false],
    ['kept', true],
  ])(
    'judges a pending identity end from the browser legacy cookies before the target: %s forwards the session: %s',
    async (outcome, withSession) => {
      const h = await harness();
      h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: 'target' }, destination: 'target' }));
      vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(pendingSession('legacy-primary'));
      vi.mocked(h.deps.invalidation.completePending).mockResolvedValueOnce(outcome);
      const headers = { cookie: 'CFID=B1; CFTOKEN=B2; z=9', 'user-agent': 'OPT2-browser' };
      const res = await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x', headers });
      expect(res.statusCode).toBe(200);
      const [pendingId, held] = vi.mocked(h.deps.invalidation.completePending).mock.calls[0] ?? [];
      expect([pendingId, held?.userAgent]).toEqual([SESSION_ID, 'OPT2-browser']);
      expect(Object.fromEntries(Object.entries(held?.cookies ?? {}).map(([key, entry]) => [key, entry.value]))).toEqual({
        CFID: 'B1',
        CFTOKEN: 'B2',
      });
      expect(vi.mocked(h.deps.stateCheck.check).mock.calls.length > 0).toBe(withSession);
      expect(h.svc.requests[0]?.headers.authorization).toBe(withSession ? 'Bearer user-token-1' : undefined);
    },
  );

  it.each(['target', 'legacy'] as const)(
    'answers the legacy 503 and forwards nothing to %s when a pending identity end cannot complete',
    async (destination) => {
      const h = await harness();
      h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: destination }, destination }));
      const flagged = pendingSession('legacy-primary');
      vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(flagged);
      vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValueOnce(flagged);
      vi.mocked(h.deps.invalidation.completePending).mockRejectedValueOnce(new BarrierTimeoutError('identity', new Error('down')));
      const res = await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x' });
      expect(res.statusCode).toBe(503);
      expect(h.svc.requests).toHaveLength(0);
      expect(h.legacy.requests).toHaveLength(0);
    },
  );

  it.each(['target', 'legacy'] as const)(
    'ends the legacy session an ended target-primary session still holds before resolving a %s-bound request',
    async (destination) => {
      const h = await harness({ active: indexOf('v0002', [], 'target') });
      h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: destination }, destination }));
      const ended = { state: 'ended' as const, epoch: 5, userId: '', siteId: '', epochChanged: true };
      const active = { state: 'active' as const, epoch: 3, userId: 'U', siteId: 'default', epochChanged: false };
      vi.mocked(h.deps.stateCheck.check).mockImplementation(async (sessionId) => (sessionId === 'T-ENDED' ? ended : active));
      for (const resolve of [h.deps.resolver.resolveSession, h.deps.resolver.resolveLegacyBound]) {
        vi.mocked(resolve).mockImplementationOnce(async () => {
          h.calls.push('resolve');
          return { kind: 'none', setCookies: [] };
        });
      }
      const res = await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x', headers: { cookie: 'JSESSIONID=T-ENDED; z=9' } });
      expect(res.statusCode).toBe(200);
      expect(h.calls.filter((call) => call === 'afterTargetLogout:T-ENDED' || call === 'resolve')).toEqual([
        'afterTargetLogout:T-ENDED',
        'resolve',
      ]);
    },
  );

  it.each(['target', 'legacy'] as const)(
    'answers the legacy 503 before any resolution when the owed legacy end of a %s-bound request fails',
    async (destination) => {
      const h = await harness({ active: indexOf('v0002', [], 'target') });
      h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: destination }, destination }));
      vi.mocked(h.deps.stateCheck.check).mockResolvedValue({ state: 'ended', epoch: 5, userId: '', siteId: '', epochChanged: true });
      vi.mocked(h.deps.invalidation.afterTargetLogout).mockRejectedValueOnce(
        new BarrierTimeoutError('legacy-bridge', new Error('refused')),
      );
      const res = await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x', headers: { cookie: 'JSESSIONID=T-ENDED' } });
      expect(res.statusCode).toBe(503);
      expect(h.deps.resolver.resolveSession).not.toHaveBeenCalled();
      expect(h.deps.resolver.resolveLegacyBound).not.toHaveBeenCalled();
      expect(h.svc.requests).toHaveLength(0);
      expect(h.legacy.requests).toHaveLength(0);
    },
  );

  /** Legacy's cookies for a static request: a new session pair and its other cookies. */
  const STATIC_SET_COOKIES = ['CFID=L1;path=/;', 'CFTOKEN=L2;path=/;', 'MXP_TRACKINGID=M1;path=/;', 'mobileFormat=false;path=/;'];
  /** What adoption after legacy re-emits for them: target values under legacy's names and attributes. */
  const ADOPTED_SET_COOKIES = ['CFID=T1;path=/;', 'CFTOKEN=T2;path=/;', 'MXP_TRACKINGID=M1;path=/;', 'mobileFormat=false;path=/;'];

  it.each<{ label: string; mode: SessionMode; route: string; url: string; cookie?: string; adopted: boolean; expected: string[] }>([
    {
      label: "re-emits the session legacy creates for a cookieless target-primary client as adoption's cookies",
      mode: 'target-primary',
      route: 'static:/core/modules/**',
      url: '/core/modules/v1/nope.js',
      adopted: true,
      expected: ADOPTED_SET_COOKIES,
    },
    {
      label: "withholds legacy's session cookies from a target-primary client naming a target session",
      mode: 'target-primary',
      route: 'widgets:redirect',
      url: '/tasks/widgets/',
      cookie: 'CFID=T1; CFTOKEN=T2',
      adopted: false,
      expected: STATIC_SET_COOKIES.slice(2),
    },
    {
      label: "passes legacy's cookies unchanged in legacy-primary",
      mode: 'legacy-primary',
      route: 'static:/admin/assets/**',
      url: '/admin/assets/css/admin.css',
      adopted: false,
      expected: STATIC_SET_COOKIES,
    },
  ])('skips session work for static entries and $label', async ({ mode, route, url, cookie, adopted, expected }) => {
    const h = await harness(mode === 'target-primary' ? { active: indexOf('v0002', [], 'target') } : {});
    h.setScript(() => ({ entry: { route, kind: 'static' }, destination: 'legacy' }));
    vi.mocked(h.deps.resolver.adoptAfterLegacy).mockResolvedValue(session('target-primary', {}, ADOPTED_SET_COOKIES));
    h.legacy.setHandler((_req, res) => {
      sendBytes(res, 200, 'static', { 'set-cookie': STATIC_SET_COOKIES });
    });

    const res = await h.app.inject({ method: 'GET', url, headers: cookie === undefined ? {} : { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(expected);
    expect(h.legacy.requests[0]?.headers.cookie).toBe(cookie);
    expect(vi.mocked(h.deps.resolver.adoptAfterLegacy).mock.calls.map(([, options]) => options)).toEqual(
      adopted ? [{ mode, setCookies: STATIC_SET_COOKIES, siteId: 'default' }] : [],
    );
    for (const sessionWork of [
      h.deps.resolver.resolveLegacyBound,
      h.deps.stateCheck.check,
      h.deps.barrier.awaitForSession,
      h.deps.hydrator.ensureHydrated,
      h.deps.csrf.beforeLegacy,
      h.deps.carry.beforeLegacy,
    ]) {
      expect(sessionWork).not.toHaveBeenCalled();
    }
  });
});

describe('relay alias', () => {
  it('refuses without web credential or with another caller, and relays web calls with their query', async () => {
    const h = await harness();
    h.setScript(() => ({ destination: 'relay' }));
    const credential = async (caller: string): Promise<Record<string, string>> => ({
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: 'gateway', roles: rolesForService(caller) })}`,
    });
    expect((await h.app.inject({ method: 'GET', url: '/opt2/svc/people/v1/users' })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/opt2/svc/people/v1/users', headers: await credential('people') })).statusCode).toBe(403);
    const invalid = await h.app.inject({ method: 'GET', url: '/opt2/svc/people/v1/users', headers: { [INVOCATION_HEADER]: 'Bearer x' } });
    expect(invalid.statusCode).toBe(401);
    const relayed = await h.app.inject({ method: 'GET', url: '/opt2/svc/people/v1/users?q=1', headers: await credential('web') });
    expect(relayed.statusCode).toBe(200);
    expect(h.svc.requests.map((request) => request.url)).toEqual(['/v1/users?q=1']);
  });
});

describe('request log lines', () => {
  type LogLine = Record<string, unknown>;
  type Scope = { tenantId: string | undefined; userId: string | undefined };

  const NO_SCOPE: Scope = { tenantId: undefined, userId: undefined };
  const TARGET_ENTRY = { route: 'api:content.findone', kind: 'read', state: 'target' } as const;
  const RELAY_USER = 'B2C3D4E5-F607-1829-3A4B5C6D7E8F9001';

  /** Web's invocation credential and a user token of `RELAY_USER`. */
  const webCallWithUser = async (): Promise<Record<string, string>> => ({
    [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'web', audience: 'gateway', roles: rolesForService('web') })}`,
    authorization: `Bearer ${await mintUserToken({ sub: RELAY_USER, site: 'tenant-a', roles: ['system-user'] })}`,
  });

  interface LineCase {
    label: string;
    url: string;
    script: Script;
    /** The session resolution of a target-bound request; anonymous when absent. */
    resolved?: SessionResolution;
    /** `sub` of the token minted for the session; `MINTED_USER` when absent. */
    sub?: string;
    headers?: () => Promise<Record<string, string>>;
    status: number;
    route: string;
    warning: string | null;
    scope: Scope;
  }

  it.each<LineCase>([
    {
      label: 'a legacy-bound request of an unlisted key',
      url: '/_api/json/v1/default/content?q=opt2-secret-query',
      script: { destination: 'legacy' },
      status: 200,
      route: 'api:unlisted',
      warning: null,
      scope: NO_SCOPE,
    },
    {
      label: 'a legacy-bound entry',
      url: '/admin/?muraAction=cusers.list&q=opt2-secret-query',
      script: { entry: { route: 'admin:cusers.list', kind: 'read' }, destination: 'legacy' },
      status: 200,
      route: 'admin:cusers.list',
      warning: null,
      scope: NO_SCOPE,
    },
    {
      label: 'an anonymous target-bound request',
      url: '/_api/json/v1/default/content/x?q=opt2-secret-query',
      script: { entry: TARGET_ENTRY, destination: 'target' },
      status: 200,
      route: TARGET_ENTRY.route,
      warning: null,
      scope: NO_SCOPE,
    },
    {
      label: 'a target-bound request of a session',
      url: '/_api/json/v1/default/content/x?q=opt2-secret-query',
      script: { entry: TARGET_ENTRY, destination: 'target' },
      resolved: session('legacy-primary'),
      status: 200,
      route: TARGET_ENTRY.route,
      warning: null,
      scope: { tenantId: MINTED_TENANT, userId: MINTED_USER },
    },
    {
      label: 'a target-bound request of a session not logged in',
      url: '/_api/json/v1/default/content/x?q=opt2-secret-query',
      script: { entry: TARGET_ENTRY, destination: 'target' },
      resolved: session('legacy-primary'),
      sub: '',
      status: 200,
      route: TARGET_ENTRY.route,
      warning: null,
      scope: { tenantId: MINTED_TENANT, userId: undefined },
    },
    {
      label: 'a gateway-served 404',
      url: '/gateway/legacy-bridge/cfml/session.cfm?q=opt2-secret-query',
      script: { entry: { route: 'gateway:bridge', kind: 'read' }, destination: 'bare' },
      status: 404,
      route: 'gateway:bridge',
      warning: null,
      scope: NO_SCOPE,
    },
    {
      label: 'a relay alias call without the web credential',
      url: '/opt2/svc/people/v1/users?q=opt2-secret-query',
      script: { destination: 'relay' },
      status: 403,
      route: RELAY_ALIAS_ROUTE,
      warning: 'request denied',
      scope: NO_SCOPE,
    },
    {
      label: "web's relay alias call with a user token",
      url: '/opt2/svc/people/v1/users?q=opt2-secret-query',
      script: { destination: 'relay' },
      headers: webCallWithUser,
      status: 200,
      route: RELAY_ALIAS_ROUTE,
      warning: null,
      scope: { tenantId: tenantIdForSite('tenant-a'), userId: RELAY_USER },
    },
  ])('logs $label under its route, tenant and user, never the catch-all', async ({ url, script, resolved, sub, headers, status, route, warning, scope }) => {
    const lines: LogLine[] = [];
    const destination = { write: (chunk: string): void => void lines.push(JSON.parse(chunk) as LogLine) };
    const h = await harness({ logger: createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination }) });
    // Only the request's own lines, not the plugins' start-up warnings.
    lines.length = 0;
    h.setScript(() => script);
    if (resolved !== undefined) vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(resolved);
    if (sub !== undefined) vi.mocked(h.deps.tokenCache.get).mockResolvedValueOnce({ token: 'user-token-1', claims: { ...MINTED_CLAIMS, sub } });
    const res = await h.app.inject({ method: 'GET', url, headers: await headers?.() });
    expect(res.statusCode).toBe(status);
    const outcomes = lines.filter((line) => line.severity === 'WARNING' || line.message === 'request completed');
    expect(outcomes.map((line) => line.message)).toStrictEqual([...(warning === null ? [] : [warning]), 'request completed']);
    for (const line of outcomes) {
      expect(validateLogRecord(line).errors).toStrictEqual([]);
      expect(line).toMatchObject({ route, httpMethod: 'GET', statusCode: status });
      expect({ tenantId: line.tenantId, userId: line.userId }).toStrictEqual(scope);
    }
    expect(JSON.stringify(lines)).not.toContain('opt2-secret-query');
  });
});

describe('fail-closed lines', () => {
  type LogLine = Record<string, unknown>;
  const TARGET_READ = { route: 'api:content.findone', kind: 'read', state: 'target' } as const;
  const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED', syscall: 'connect' });

  interface FailCase {
    label: string;
    active?: null;
    script?: Script;
    setup?: (h: Harness) => unknown;
    method?: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    payload?: string;
    severity: 'ERROR' | 'WARNING';
    message: string;
    route: string | undefined;
    /** Type of the logged error; undefined when the line carries none. */
    errorType?: string;
  }

  it.each<FailCase>([
    {
      label: 'identity unavailable before a target forward',
      script: { entry: TARGET_READ, destination: 'target' },
      setup: (h) => vi.mocked(h.deps.resolver.resolveSession).mockRejectedValueOnce(new ServiceUnavailableError(IDENTITY_SERVICE, refused())),
      url: '/_api/json/v1/default/content/x',
      severity: 'ERROR',
      message: 'fail-closed: identity unavailable before forwarding to people',
      route: TARGET_READ.route,
      errorType: 'ServiceUnavailableError',
    },
    {
      label: 'the database unavailable before a target write registers',
      script: { entry: { route: 'opt2:/opt2/stub/**', kind: 'write', state: 'target' }, destination: 'target' },
      setup: (h) => vi.mocked(h.deps.inflight.register).mockRejectedValueOnce(new DatabaseUnavailableError('ECONNREFUSED', refused())),
      method: 'POST',
      url: '/opt2/stub/notes',
      severity: 'ERROR',
      message: 'fail-closed: database unavailable before forwarding to people',
      route: 'opt2:/opt2/stub/**',
      errorType: 'DatabaseUnavailableError',
    },
    {
      label: 'a barrier timeout before a legacy forward',
      script: { entry: { route: 'admin:cusers.list', kind: 'read' }, destination: 'legacy' },
      setup: (h) => {
        vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValueOnce(session('legacy-primary'));
        vi.mocked(h.deps.barrier.awaitForSession).mockRejectedValueOnce(new BarrierTimeoutError('identity=1', new Error('timeout')));
      },
      url: '/admin/?muraAction=cusers.list',
      severity: 'ERROR',
      message: 'fail-closed: barrier timeout before forwarding to legacy',
      route: 'admin:cusers.list',
      errorType: 'BarrierTimeoutError',
    },
    {
      label: 'a refused owner',
      script: { entry: TARGET_READ, destination: 'target' },
      setup: (h) => h.svc.close(),
      url: '/_api/json/v1/default/content/x',
      severity: 'ERROR',
      message: 'fail-closed: people unavailable',
      route: TARGET_READ.route,
      errorType: 'FastifyError',
    },
    {
      label: 'an owner answering 503',
      script: { entry: TARGET_READ, destination: 'target' },
      setup: (h) => h.svc.setHandler((_req, res) => sendBytes(res, 503, 'unavailable')),
      url: '/_api/json/v1/default/content/x',
      severity: 'ERROR',
      message: 'fail-closed: people unavailable: answered 503',
      route: TARGET_READ.route,
    },
    {
      label: 'an owner without a service URL',
      script: { entry: TARGET_READ, destination: 'unavailable' },
      url: '/_api/json/v1/default/content/x',
      severity: 'ERROR',
      message: 'fail-closed: people has no service URL',
      route: TARGET_READ.route,
    },
    {
      label: 'no active version',
      active: null,
      url: '/_api/json/v1/default/content',
      severity: 'ERROR',
      message: 'fail-closed: no cut-over version is active',
      route: 'api:unlisted',
    },
    {
      label: 'a freeze outlasting the wait',
      script: { entry: { route: 'api:r', kind: 'read' }, destination: 'legacy' },
      setup: (h) => {
        h.frozen.add('api:r');
        vi.mocked(h.deps.state.waitUnfrozen).mockResolvedValueOnce(false);
      },
      url: '/_api/json/v1/default/r',
      severity: 'WARNING',
      message: 'fail-closed: legacy entry frozen past the 30000 ms wait',
      route: 'api:r',
    },
    {
      label: 'a body in a charset the gateway does not decode',
      method: 'POST',
      url: '/admin/',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=Shift_JIS' },
      payload: 'a=1',
      severity: 'WARNING',
      message: 'fail-closed: request body unreadable',
      route: undefined,
      errorType: 'UnreadableBodyError',
    },
  ])('logs $label as one $severity fail-closed line with its route key and the 503', async (c) => {
    const lines: LogLine[] = [];
    const destination = { write: (chunk: string): void => void lines.push(JSON.parse(chunk) as LogLine) };
    const logger = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination });
    const h = await harness({ logger, ...(c.active === null ? { active: null } : {}) });
    lines.length = 0;
    if (c.script !== undefined) h.setScript(() => c.script as Script);
    await c.setup?.(h);
    const method = c.method ?? 'GET';
    const res = await h.app.inject({ method, url: c.url, headers: c.headers, payload: c.payload });
    expect(res.statusCode).toBe(503);
    await settle();
    const failed = lines.filter((line) => String(line.message).startsWith('fail-closed'));
    expect(failed).toHaveLength(1);
    const [line] = failed;
    expect(line).toMatchObject({ severity: c.severity, message: c.message, httpMethod: method, statusCode: 503 });
    expect(line?.route).toBe(c.route);
    if (c.errorType === undefined) expect(line).not.toHaveProperty('error');
    else expect(line?.error).toMatchObject({ type: c.errorType });
    expect(validateLogRecord(line).errors).toStrictEqual([]);
  });
});

describe('freeze', () => {
  it('serves a frozen read once released within the wait, and answers 503 when it is not', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'api:r', kind: 'read' }, destination: 'legacy' }));
    h.frozen.add('api:r');
    setTimeout(() => h.frozen.delete('api:r'), 50);
    expect((await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/r' })).statusCode).toBe(200);
    h.frozen.add('api:r');
    vi.mocked(h.deps.state.waitUnfrozen).mockResolvedValueOnce(false);
    expect((await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/r' })).statusCode).toBe(503);
    expect(h.legacy.requests).toHaveLength(1);
  });

  it('removes a frozen write row before waiting, and answers 503 when the freeze outlasts the wait', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:w', kind: 'write' }, destination: 'legacy' }));
    h.frozen.add('admin:w');
    vi.mocked(h.deps.state.waitUnfrozen).mockImplementationOnce(async (route) => {
      h.calls.push(`wait:${route}`);
      return false;
    });
    expect((await h.app.inject({ method: 'POST', url: '/admin/?muraAction=w' })).statusCode).toBe(503);
    expect(rowCalls(h.calls)).toEqual(['register:admin:w:legacy:-', 'readEpoch', 'remove']);
    expect(h.calls.indexOf('remove')).toBeLessThan(h.calls.indexOf('wait:admin:w'));
    expect(h.legacy.requests).toHaveLength(0);
  });

  it.each<[string, Script['entry'], string]>([
    ['a request without an entry', undefined, 'admin:home.redirect'],
    ['a legacy-write', { route: 'admin:w', kind: 'legacy-write' }, RELOAD_KEY],
  ])('holds %s while a route its outcome is held by is frozen, serving it once released and answering 503 when not', async (_label, entry, held) => {
    const h = await harness();
    h.setScript(() => ({ entry, destination: 'legacy', family: 'reload', holdRoutes: [held] }));
    h.frozen.add(held);
    setTimeout(() => h.frozen.delete(held), 50);
    expect((await h.app.inject({ method: 'POST', url: '/admin/?appreload&muraAction=w' })).statusCode).toBe(200);
    expect(h.calls).toContain(`wait:${held}`);
    h.frozen.add(held);
    vi.mocked(h.deps.state.waitUnfrozen).mockResolvedValueOnce(false);
    expect((await h.app.inject({ method: 'POST', url: '/admin/?appreload&muraAction=w' })).statusCode).toBe(503);
    expect(h.legacy.requests).toHaveLength(1);
  });

  it('registers again and re-reads the epoch once a frozen write is released', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:w', kind: 'write' }, destination: 'legacy' }));
    h.frozen.add('admin:w');
    setTimeout(() => h.frozen.delete('admin:w'), 50);
    expect((await h.app.inject({ method: 'POST', url: '/admin/?muraAction=w' })).statusCode).toBe(200);
    await settle();
    expect(rowCalls(h.calls)).toEqual([
      'register:admin:w:legacy:-',
      'readEpoch',
      'remove',
      'register:admin:w:legacy:-',
      'readEpoch',
      'remove',
    ]);
  });
});

describe('write entries', () => {
  it.each<['GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string, boolean]>([
    ['GET', 'GET', false],
    ['HEAD', 'HEAD', false],
    ['OPTIONS', 'OPTIONS', false],
    ['POST', 'POST', true],
    ['PUT', 'PUT', true],
    ['PATCH', 'PATCH', true],
    ['DELETE', 'DELETE', true],
    ['GET', 'DELETE', true],
    ['POST', 'GET', true],
  ])('declares a %s to a target write entry whose route key reads %s in the session barrier: %s', async (method, keyMethod, declares) => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'opt2:/opt2/stub/**', kind: 'write', state: 'target' }, destination: 'target', httpMethod: keyMethod }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary'));
    expect((await h.app.inject({ method, url: '/opt2/stub/notes' })).statusCode).toBe(200);
    await settle();
    const declaration = h.calls.filter((call) => call.startsWith('declare:') || call.startsWith('release:'));
    expect(declaration).toEqual(declares ? [`declare:${SESSION_ID}:people`, `release:${SESSION_ID}:people`] : []);
    expect(h.svc.requests.map((received) => received.method)).toEqual([method]);
  });

  it('registers before reading the epoch and removes the row once the response completed', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:cusers.update', kind: 'write', state: 'target' }, destination: 'target' }));
    expect((await h.app.inject({ method: 'POST', url: '/admin/?muraAction=cusers.update' })).statusCode).toBe(200);
    await settle();
    expect(rowCalls(h.calls)).toEqual(['register:admin:cusers.update:target:-', 'readEpoch', 'remove']);
  });

  it.each<[string, (res: ServerResponse) => void]>([
    ['drops the connection after receiving the request', (res) => res.socket?.destroy()],
    [
      'breaks its response off mid-body',
      (res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
        res.write('partial', () => res.socket?.destroy());
      },
    ],
  ])('marks the row abandoned, never removing it, when the target %s', async (_case, answer) => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:cusers.update', kind: 'write', state: 'target' }, destination: 'target' }));
    h.svc.setHandler((_req, res) => answer(res));
    await h.app.inject({ method: 'POST', url: '/admin/?muraAction=cusers.update' }).catch(() => undefined);
    await settle();
    expect(rowCalls(h.calls)).toEqual(['register:admin:cusers.update:target:-', 'readEpoch', 'abandon']);
    expect(h.deps.inflight.abandon).toHaveBeenCalledOnce();
  });

  it('removes the row and answers 503 when the fresh version is unavailable', async () => {
    const h = await harness();
    h.setScript((_url, call) => ({ entry: { route: 'admin:w', kind: 'write' }, destination: call === 0 ? 'legacy' : 'unavailable' }));
    expect((await h.app.inject({ method: 'POST', url: '/admin/?muraAction=w' })).statusCode).toBe(503);
    expect(rowCalls(h.calls)).toEqual(['register:admin:w:legacy:-', 'readEpoch', 'remove']);
  });

  it.each([
    ['side', { route: 'admin:w', kind: 'write', state: 'target' } as const, 'target' as const, 'register:admin:w:target:-'],
    ['entry', { route: 'admin:w{type=1}', kind: 'write' } as const, 'legacy' as const, 'register:admin:w{type=1}:legacy:-'],
  ])('re-registers and re-reads the epoch when the fresh version changes the %s', async (_case, entry, destination, second) => {
    const h = await harness();
    h.setScript((_url, call) => (call === 0 ? { entry: { route: 'admin:w', kind: 'write' }, destination: 'legacy' } : { entry, destination }));
    expect((await h.app.inject({ method: 'POST', url: '/admin/?muraAction=w' })).statusCode).toBe(200);
    await settle();
    expect(rowCalls(h.calls)).toEqual(['register:admin:w:legacy:-', 'readEpoch', 'remove', second, 'readEpoch', 'remove']);
  });

  it('fails closed and removes the row when the epoch cannot be read', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:w', kind: 'write' }, destination: 'legacy' }));
    vi.mocked(h.deps.state.readEpochForWrite).mockRejectedValueOnce(new BarrierTimeoutError('epoch', new Error('db')));
    expect((await h.app.inject({ method: 'POST', url: '/admin/?muraAction=w' })).statusCode).toBe(503);
    expect(h.calls).toContain('remove');
  });

  it('releases the row and propagates an error that is not unavailability', async () => {
    const h = await harness();
    h.setScript((_url, call) => (call === 0 ? { entry: { route: 'admin:w', kind: 'write' }, destination: 'legacy' } : { destination: 'relay' }));
    expect((await h.app.inject({ method: 'POST', url: '/admin/?muraAction=w' })).statusCode).toBe(500);
    expect(h.calls).toContain('remove');
    expect(h.legacy.requests).toHaveLength(0);
  });
});

describe('write windows', () => {
  const saveRate = (): Script => ({ entry: { route: 'page:saverate', kind: 'legacy-write', units: [RATING_UNIT] }, destination: 'legacy' });

  it('opens no window when no unit is target-authoritative', async () => {
    const h = await harness();
    h.setScript(saveRate);
    expect((await h.app.inject({ method: 'POST', url: '/?doaction=saveRate' })).statusCode).toBe(200);
    expect(h.deps.windows.open).not.toHaveBeenCalled();
  });

  it('answers 503 before legacy executes when the window cannot open', async () => {
    const h = await harness({ active: indexOf('v0002', [RATING_UNIT]) });
    h.setScript(saveRate);
    vi.mocked(h.deps.windows.open).mockImplementationOnce(async () => {
      h.calls.push('window.open');
      throw new WindowOpenError('page:saverate', new Error('refused'));
    });
    expect((await h.app.inject({ method: 'POST', url: '/?doaction=saveRate' })).statusCode).toBe(503);
    expect(h.legacy.requests).toHaveLength(0);
    expect(rowCalls(h.calls)).toEqual(['register:page:saverate:legacy:-', 'readEpoch', 'window.open', 'remove']);
  });

  it('returns the buffered legacy response after completing the window with its status, also on import-pending', async () => {
    const h = await harness({ active: indexOf('v0002', [RATING_UNIT]) });
    h.setScript(saveRate);
    h.legacy.setHandler((_req, res) => sendBytes(res, 201, 'saved', { 'set-cookie': ['a=1', 'a=1'] }));
    const res = await h.app.inject({ method: 'POST', url: '/?doaction=saveRate' });
    expect([res.statusCode, res.body, res.headers['set-cookie']]).toEqual([201, 'saved', ['a=1', 'a=1']]);
    expect(h.deps.windows.open).toHaveBeenCalledWith({ routeKey: 'page:saverate', units: [RATING_UNIT], scope: { table: true }, requestId: expect.any(String) });
    expect(rowCalls(h.calls)).toEqual([
      'register:page:saverate:legacy:-',
      'readEpoch',
      'window.open',
      'remove',
      'register:page:saverate:legacy:W1',
      'readEpoch',
      'remove',
      'window.complete:W1:true:201',
    ]);
  });

  it('closes the window and routes again when the entry froze while the row was re-registered', async () => {
    const h = await harness({ active: indexOf('v0002', [RATING_UNIT]) });
    h.setScript(saveRate);
    let reads = 0;
    vi.mocked(h.deps.state.readEpochForWrite).mockImplementation(async () => {
      reads += 1;
      h.calls.push('readEpoch');
      if (reads === 2) h.frozen.add('page:saverate');
      if (reads === 3) h.frozen.delete('page:saverate');
      return { epoch: reads, index: indexOf('v0002', [RATING_UNIT]) };
    });
    expect((await h.app.inject({ method: 'POST', url: '/?doaction=saveRate' })).statusCode).toBe(200);
    expect(rowCalls(h.calls).slice(0, 7)).toEqual([
      'register:page:saverate:legacy:-',
      'readEpoch',
      'window.open',
      'remove',
      'register:page:saverate:legacy:W1',
      'readEpoch',
      'window.complete:W1:false:-',
    ]);
    expect(h.calls.filter((call) => call === 'window.open')).toHaveLength(2);
    expect(h.legacy.requests).toHaveLength(1);
  });

  it.each([
    { name: 'the client goes before legacy answers', status: 201, leave: true, reported: '201' },
    { name: 'legacy answers a status Fastify rejects', status: 600, leave: false, reported: '-' },
  ])('completes the window once as forwarded after legacy completed when $name', async ({ status, leave, reported }) => {
    const h = await harness({ active: indexOf('v0002', [RATING_UNIT]) });
    h.setScript(saveRate);
    let received: () => void = () => undefined;
    const atLegacy = new Promise<void>((resolve) => {
      received = resolve;
    });
    h.legacy.setHandler(async (_req, res) => {
      received();
      await new Promise((resolve) => setTimeout(resolve, 200));
      sendBytes(res, status, 'saved');
    });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = h.app.server.address() as AddressInfo;

    const answered = new Promise<number | undefined>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/?doaction=saveRate', method: 'POST', agent: false }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode));
      });
      req.once('error', () => resolve(undefined));
      req.end();
      if (leave) void atLegacy.then(() => req.destroy());
    });

    expect(await answered).toBe(leave ? undefined : 503);
    await vi.waitFor(() => expect(h.calls).toContain(`window.complete:W1:true:${reported}`));
    await settle();
    expect(rowCalls(h.calls).slice(4)).toEqual([
      'register:page:saverate:legacy:W1',
      'readEpoch',
      'remove',
      `window.complete:W1:true:${reported}`,
    ]);
    expect(h.legacy.requests).toHaveLength(1);
  });

  it("scopes a reload's window by the reload key, and closes it and routes again when a route it is held by froze meanwhile", async () => {
    const h = await harness({ active: indexOf('v0002', [RATING_UNIT]) });
    h.setScript(() => ({ ...saveRate(), family: 'reload', holdRoutes: [RELOAD_KEY] }));
    let reads = 0;
    vi.mocked(h.deps.state.readEpochForWrite).mockImplementation(async () => {
      reads += 1;
      h.calls.push('readEpoch');
      if (reads === 2) h.frozen.add(RELOAD_KEY);
      if (reads === 3) h.frozen.delete(RELOAD_KEY);
      return { epoch: reads, index: indexOf('v0002', [RATING_UNIT]) };
    });
    expect((await h.app.inject({ method: 'POST', url: '/?appreload&doaction=saveRate' })).statusCode).toBe(200);
    expect(vi.mocked(h.deps.windows.scope).mock.calls.map(([route]) => route)).toEqual([RELOAD_KEY, RELOAD_KEY]);
    expect(h.deps.windows.open).toHaveBeenCalledWith({ routeKey: 'page:saverate', units: [RATING_UNIT], scope: { table: true }, requestId: expect.any(String) });
    expect(rowCalls(h.calls).slice(0, 7)).toEqual([
      'register:page:saverate:legacy:-',
      'readEpoch',
      'window.open',
      'remove',
      'register:page:saverate:legacy:W1',
      'readEpoch',
      'window.complete:W1:false:-',
    ]);
    expect(h.calls.filter((call) => call === 'window.open')).toHaveLength(2);
    expect(h.legacy.requests).toHaveLength(1);
  });

  it('completes the window as not forwarded when legacy never received the request', async () => {
    const h = await harness({ active: indexOf('v0002', [RATING_UNIT]) });
    h.setScript(saveRate);
    await h.legacy.close();
    expect((await h.app.inject({ method: 'POST', url: '/?doaction=saveRate' })).statusCode).toBe(503);
    expect(h.calls).toEqual(expect.arrayContaining(['window.complete:W1:false:-', 'csrf.after', 'remove']));
  });

  it('completes the window as not forwarded when session work fails before forwarding', async () => {
    const h = await harness({ active: indexOf('v0002', [RATING_UNIT]) });
    h.setScript(saveRate);
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValueOnce(session('legacy-primary'));
    vi.mocked(h.deps.barrier.awaitForSession).mockRejectedValueOnce(new BarrierTimeoutError('identity=9', new Error('timeout')));
    expect((await h.app.inject({ method: 'POST', url: '/?doaction=saveRate' })).statusCode).toBe(503);
    expect(h.calls).toContain('window.complete:W1:false:-');
    expect(h.legacy.requests).toHaveLength(0);
  });
});

describe('request probes', () => {
  const ARCHIVE_UNIT = 'content.filename_archive';
  /** A page render waiting on the orphan archive probe until a probe answer reaches the matcher, then writing the archive unit. */
  const probedRender = (afterProbe: Script['destination'] = 'legacy') => (_url: string, call: number): Script =>
    call === 0
      ? { entry: { route: 'page:render', kind: 'read' }, destination: 'legacy', family: 'page', pendingProbes: { orphanArchive: [ARCHIVE_UNIT] } }
      : { entry: { route: 'page:render', kind: 'legacy-write', units: [ARCHIVE_UNIT] }, destination: call === 1 ? 'legacy' : afterProbe, family: 'page' };

  /** Makes the orphan archive probe answer `orphan`, recording the filenames it is asked about, and window opens record their units. */
  function answerOrphan(h: Harness, orphan: boolean): void {
    h.deps.windows.probeOrphanArchive = (filenames) => {
      h.calls.push(`probe.orphanArchive:${filenames.join(',')}`);
      return Promise.resolve(orphan);
    };
    h.deps.windows.open = (input) => {
      h.calls.push(`window.open:${input.routeKey}:${input.units.join(',')}`);
      return Promise.resolve({ windowId: 'W1' });
    };
  }

  it('asks after the barrier and the claims, then opens the window over the units the answer adds before legacy runs', async () => {
    const h = await harness({ active: indexOf('v0002', [ARCHIVE_UNIT]) });
    h.setScript(probedRender());
    answerOrphan(h, true);
    h.deps.resolver.resolveLegacyBound = () => Promise.resolve(session('legacy-primary'));
    h.legacy.setHandler((_req, res) => {
      h.calls.push('legacy');
      sendBytes(res, 404, 'not found');
    });

    expect((await h.app.inject({ method: 'GET', url: '/missing/page/' })).statusCode).toBe(404);
    expect(h.calls.filter((call) => /^(barrier|csrf\.before|probe|window|legacy$)/.test(call))).toEqual([
      `barrier:${SESSION_ID}`,
      'csrf.before',
      'probe.orphanArchive:404,missing,missing/page,page',
      `window.open:page:render:${ARCHIVE_UNIT}`,
      'legacy',
      'window.complete:W1:true:404',
    ]);
  });

  it('asks nothing when the units the probe would add are legacy-authoritative', async () => {
    const h = await harness({ active: indexOf('v0002') });
    h.setScript(probedRender());
    answerOrphan(h, true);
    expect((await h.app.inject({ method: 'GET', url: '/missing/' })).statusCode).toBe(200);
    expect(h.calls.filter((call) => /^(probe|window)/.test(call))).toEqual([]);
  });

  it('answers 503 before legacy executes when routing moves the request off legacy while it is probed', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const destination = { write: (chunk: string): void => void lines.push(JSON.parse(chunk) as Record<string, unknown>) };
    const logger = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination });
    const h = await harness({ active: indexOf('v0002', [ARCHIVE_UNIT]), logger });
    h.setScript(probedRender('target'));
    answerOrphan(h, true);

    expect((await h.app.inject({ method: 'GET', url: '/missing/' })).statusCode).toBe(503);
    await settle();
    expect(lines.filter((line) => String(line.message).startsWith('fail-closed')).map((line) => line.message)).toEqual([
      'fail-closed: routing changed while probing before forwarding to legacy',
    ]);
    expect(h.legacy.requests).toHaveLength(0);
    expect(h.svc.requests).toHaveLength(0);
    expect(h.calls.filter((call) => /^(probe|window)/.test(call))).toEqual(['probe.orphanArchive:404,missing']);
    expect(rowCalls(h.calls).at(-1)).toBe('remove');
  });
});

describe('sessions of legacy-bound requests', () => {
  it('awaits the session barrier before legacy and fails closed on its timeout', async () => {
    const h = await harness();
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('legacy-primary'));
    expect((await h.app.inject({ method: 'GET', url: '/admin/' })).statusCode).toBe(200);
    expect(h.calls.indexOf(`barrier:${SESSION_ID}`)).toBeGreaterThanOrEqual(0);
    vi.mocked(h.deps.barrier.awaitForSession).mockRejectedValueOnce(new BarrierTimeoutError('identity=1', new Error('timeout')));
    expect((await h.app.inject({ method: 'GET', url: '/admin/' })).statusCode).toBe(503);
    expect(h.legacy.requests).toHaveLength(1);
  });

  /** A handle of a token claimed pending-legacy for S1. */
  const claimed = (): CsrfHandle => ({
    sessionId: SESSION_ID,
    legacySessionId: 'L-1',
    legacyCookies: {},
    claimedTokens: ['TOKEN-9'],
    since: '2026-06-30 12:00:00.000',
    setCookies: [],
  });

  it('takes the legacy-primary CSRF claim while the session barrier is awaited', async () => {
    const h = await harness();
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('legacy-primary'));
    let claimStarted!: () => void;
    const started = new Promise<void>((resolve) => (claimStarted = resolve));
    vi.mocked(h.deps.barrier.awaitForSession).mockImplementationOnce(async (sessionId) => {
      h.calls.push(`barrier:${sessionId}`);
      // A barrier awaited before the claim starts would never return.
      await started;
      h.calls.push('barrier.done');
    });
    vi.mocked(h.deps.csrf.beforeLegacy).mockImplementationOnce(async () => {
      h.calls.push('csrf.before');
      claimStarted();
      return claimed();
    });
    const res = await h.app.inject({ method: 'POST', url: '/admin/', headers: { 'x-csrf_token': 'TOKEN-9' } });

    expect(res.statusCode).toBe(200);
    expect(h.calls.filter((call) => /^(barrier|csrf)/.test(call))).toEqual([
      `barrier:${SESSION_ID}`,
      'csrf.before',
      'barrier.done',
      'csrf.after',
    ]);
    expect(h.deps.csrf.afterLegacy).toHaveBeenCalledWith(claimed(), expect.any(Date));
  });

  it('releases the claim taken beside a legacy-primary barrier that times out, forwarding nothing', async () => {
    const h = await harness();
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('legacy-primary'));
    vi.mocked(h.deps.barrier.awaitForSession).mockRejectedValueOnce(new BarrierTimeoutError('people=9', new Error('timeout')));
    vi.mocked(h.deps.csrf.beforeLegacy).mockResolvedValueOnce(claimed());
    const res = await h.app.inject({ method: 'POST', url: '/admin/', headers: { 'x-csrf_token': 'TOKEN-9' } });

    expect([res.statusCode, res.body]).toEqual([503, adminUnavailableResponse().body]);
    expect(h.legacy.requests).toHaveLength(0);
    expect(h.deps.csrf.afterLegacy).toHaveBeenCalledWith(claimed(), undefined);
  });

  it('answers a resolution response verbatim', async () => {
    const h = await harness();
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValueOnce({ kind: 'response', status: 400, headers: {}, body: 'no' });
    const res = await h.app.inject({ method: 'GET', url: '/admin/' });
    expect([res.statusCode, res.body]).toEqual([400, 'no']);
    expect(h.legacy.requests).toHaveLength(0);
  });

  it('hydrates in target-primary before claiming CSRF, sends the jar cookies in place and re-emits adopted cookies', async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    const jar: JarCookies = {
      CFID: { name: 'CFID', value: 'L1', attributes: 'path=/;' },
      JSESSIONID: { name: 'JSESSIONID', value: 'LJ', attributes: 'path=/;HttpOnly' },
    };
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('target-primary', jar));
    vi.mocked(h.deps.hydrator.ensureHydrated).mockImplementation(async () => {
      h.calls.push('hydrate');
      return jarRow(jar);
    });
    vi.mocked(h.deps.resolver.adoptAfterLegacy).mockResolvedValue(session('target-primary', jar, ['JSESSIONID=TJ;path=/;HttpOnly', 'o=1']));
    h.legacy.setHandler((_req, res) => sendBytes(res, 200, 'ok', { 'set-cookie': ['JSESSIONID=NEW;path=/;HttpOnly', 'o=1'] }));
    const res = await h.app.inject({ method: 'GET', url: '/admin/', headers: { cookie: 'a=1; CFID=T1;; b=2; JSESSIONID=TJ; CFTOKEN=TT' } });
    expect(res.statusCode).toBe(200);
    expect(h.legacy.requests[0]?.headers.cookie).toBe('a=1; CFID=L1; b=2; JSESSIONID=LJ');
    expect(res.headers['set-cookie']).toEqual(['JSESSIONID=TJ;path=/;HttpOnly', 'o=1']);
    expect(h.calls.indexOf('hydrate')).toBeLessThan(h.calls.indexOf('csrf.before'));
    expect(h.calls).toContain('csrf.after');
  });

  it.each<{ label: string; mode: SessionMode; family: RouteKeyResult['family']; url: string; carried: boolean }>([
    { label: 'a target-primary admin request', mode: 'target-primary', family: 'admin', url: '/admin/?muraAction=cArch.loadSiteFlat', carried: true },
    { label: 'a legacy-primary admin request', mode: 'legacy-primary', family: 'admin', url: '/admin/?muraAction=cArch.loadSiteFlat', carried: true },
    { label: 'a target-primary page request', mode: 'target-primary', family: 'page', url: '/tenant-a/', carried: false },
    { label: 'a legacy-primary JSON API request', mode: 'legacy-primary', family: 'api', url: '/_api/json/v1/default/content', carried: false },
  ])('carries the session values target routes keep before legacy serves $label only when it is an admin one', async ({ mode, family, url, carried }) => {
    const h = await harness(mode === 'target-primary' ? { active: indexOf('v0002', [], 'target') } : {});
    h.setScript(() => ({ destination: 'legacy', family }));
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session(mode));
    vi.mocked(h.deps.hydrator.ensureHydrated).mockResolvedValue(jarRow({}));
    vi.mocked(h.deps.carry.beforeLegacy).mockImplementation(async () => {
      h.calls.push('carry');
    });
    h.legacy.setHandler((_req, res) => {
      h.calls.push('legacy');
      sendBytes(res, 200, 'ok');
    });

    const res = await h.app.inject({ method: 'POST', url, headers: { 'user-agent': 'OPT2-browser' } });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(h.deps.carry.beforeLegacy).mock.calls).toEqual(carried ? [[SESSION_ID, mode, { userAgent: 'OPT2-browser' }]] : []);
    expect(h.calls.filter((call) => ['csrf.before', 'carry', 'legacy'].includes(call))).toEqual(
      carried ? ['csrf.before', 'carry', 'legacy'] : ['csrf.before', 'legacy'],
    );
  });

  /** Facts of a legacy login, whose response logs the session in again. */
  const LOGIN_FACTS: Record<string, RouteFacts> = {
    'admin:clogin.login': { route: 'admin:clogin.login', csrfValidation: 'none', writeSet: [], keyScope: [], sessionEffects: ['login'] },
  };

  it.each<{ label: string; mode: SessionMode; family: RouteKeyResult['family']; route?: string; url: string; imported: boolean }>([
    { label: 'a target-primary admin request', mode: 'target-primary', family: 'admin', url: '/admin/?muraAction=cArch.siteManagerTab&tab=1', imported: true },
    { label: 'a legacy-primary admin request', mode: 'legacy-primary', family: 'admin', url: '/admin/?muraAction=cArch.siteManagerTab&tab=1', imported: true },
    { label: 'a target-primary page request', mode: 'target-primary', family: 'page', url: '/tenant-a/', imported: false },
    { label: 'a legacy-primary JSON API request', mode: 'legacy-primary', family: 'api', url: '/_api/json/v1/default/content', imported: false },
    { label: 'an admin logout', mode: 'target-primary', family: 'admin', route: 'admin:clogin.logout', url: '/admin/?muraAction=cLogin.logout', imported: false },
    { label: 'an admin login', mode: 'legacy-primary', family: 'admin', route: 'admin:clogin.login', url: '/admin/?muraAction=cLogin.login', imported: false },
  ])('imports the shared values legacy changed once it completed $label only when it is an admin request but a login or logout', async (c) => {
    const h = await harness({ ...(c.mode === 'target-primary' ? { active: indexOf('v0002', [], 'target') } : {}), facts: LOGIN_FACTS });
    h.setScript(() => ({ destination: 'legacy', family: c.family, ...(c.route === undefined ? {} : { entry: { route: c.route, kind: 'read' as const } }) }));
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session(c.mode));
    vi.mocked(h.deps.hydrator.ensureHydrated).mockResolvedValue(jarRow({}));
    vi.mocked(h.deps.carry.afterLegacy).mockImplementation(async () => {
      h.calls.push('carry.after');
    });
    h.legacy.setHandler((_req, res) => {
      h.calls.push('legacy');
      sendBytes(res, 200, 'legacy-body');
    });

    const res = await h.app.inject({ method: 'GET', url: c.url, headers: { 'user-agent': 'OPT2-browser' } });

    expect([res.statusCode, res.body]).toEqual([200, 'legacy-body']);
    expect(vi.mocked(h.deps.carry.afterLegacy).mock.calls).toEqual(c.imported ? [[SESSION_ID, c.mode, { userAgent: 'OPT2-browser' }]] : []);
    expect(h.calls.filter((call) => ['legacy', 'csrf.after', 'carry.after'].includes(call))).toEqual(
      c.imported ? ['legacy', 'csrf.after', 'carry.after'] : ['legacy', 'csrf.after'],
    );
  });

  it('answers legacy own response when the import after it fails', async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('target-primary'));
    vi.mocked(h.deps.hydrator.ensureHydrated).mockResolvedValue(jarRow({}));
    vi.mocked(h.deps.carry.afterLegacy).mockRejectedValueOnce(new ServiceUnavailableError(IDENTITY_SERVICE, new Error('down')));
    h.legacy.setHandler((_req, res) => sendBytes(res, 200, 'legacy-body', { 'x-legacy': '1' }));

    const res = await h.app.inject({ method: 'GET', url: '/admin/?muraAction=cArch.siteManagerTab&tab=1' });

    expect([res.statusCode, res.body, res.headers['x-legacy']]).toEqual([200, 'legacy-body', '1']);
    expect(h.deps.carry.afterLegacy).toHaveBeenCalledTimes(1);
  });

  it('carries nothing for a target-primary admin request whose session has no hydrated legacy session', async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('target-primary'));

    expect((await h.app.inject({ method: 'GET', url: '/admin/?muraAction=cArch.loadSiteFlat' })).statusCode).toBe(200);
    expect(h.deps.carry.beforeLegacy).not.toHaveBeenCalled();
  });

  it('answers the legacy 503 and releases the claim when the carry fails, forwarding nothing', async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('target-primary'));
    vi.mocked(h.deps.hydrator.ensureHydrated).mockResolvedValue(jarRow({}));
    vi.mocked(h.deps.csrf.beforeLegacy).mockResolvedValueOnce(claimed());
    vi.mocked(h.deps.carry.beforeLegacy).mockRejectedValueOnce(new ServiceUnavailableError(IDENTITY_SERVICE, new Error('down')));

    const res = await h.app.inject({ method: 'POST', url: '/admin/?muraAction=cArch.loadSiteFlat', headers: { 'x-csrf_token': 'TOKEN-9' } });

    expect([res.statusCode, res.body]).toEqual([503, adminUnavailableResponse().body]);
    expect(h.legacy.requests).toHaveLength(0);
    expect(h.deps.csrf.afterLegacy).toHaveBeenCalledWith(claimed(), undefined);
  });

  it('withholds legacy session cookies when adoption after legacy fails in target-primary', async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    vi.mocked(h.deps.resolver.adoptAfterLegacy).mockRejectedValueOnce(new Error('identity down'));
    h.legacy.setHandler((_req, res) => sendBytes(res, 200, 'ok', { 'set-cookie': ['CFID=NEW;path=/;', 'o=1'] }));
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.headers['set-cookie']).toEqual(['o=1']);
  });

  it('strips the browser session cookies for an ended target-primary session', async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('target-primary'));
    vi.mocked(h.deps.stateCheck.check).mockResolvedValue({ state: 'ended', epoch: 4, userId: '', siteId: '', epochChanged: true });
    await h.app.inject({ method: 'GET', url: '/admin/', headers: { cookie: 'CFID=T1; z=9' } });
    expect(h.legacy.requests[0]?.headers.cookie).toBe('z=9');
    expect(h.calls).toContain(`afterTargetLogout:${SESSION_ID}`);
    expect(h.deps.hydrator.ensureHydrated).not.toHaveBeenCalled();
  });

  it('sends a restored jar after a switch back and hands its cookies to the browser before legacy own', async () => {
    const h = await harness();
    const jar: JarCookies = { CFID: { name: 'CFID', value: 'R1', attributes: 'path=/;' } };
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('legacy-primary', jar, ['CFID=R1;path=/;']));
    h.legacy.setHandler((_req, res) => sendBytes(res, 200, 'ok', { 'set-cookie': ['o=1'] }));
    const res = await h.app.inject({ method: 'GET', url: '/admin/', headers: { cookie: 'CFID=T1; z=9' } });
    expect(h.legacy.requests[0]?.headers.cookie).toBe('CFID=R1; z=9');
    expect(res.headers['set-cookie']).toEqual(['CFID=R1;path=/;', 'o=1']);
  });

  /** Logouts legacy serves: a page logout, and identity's logout keys while their units are not all target-authoritative, as in v0002. */
  const LEGACY_SERVED_LOGOUTS: ReadonlyArray<{ route: string; kind: EntryKind; family: RouteKeyResult['family']; url: string }> = [
    { route: 'page:logout', kind: 'legacy-write', family: 'page', url: '/?doaction=logout' },
    { route: 'admin:clogin.logout', kind: 'read', family: 'admin', url: '/admin/?muraAction=cLogin.logout' },
    { route: 'api:logout', kind: 'read', family: 'api', url: '/_api/json/v1/default/logout' },
  ];
  const LOGOUT_SESSIONS: ReadonlyArray<{ mode: SessionMode; cookie: string; jar: JarCookies; held: Record<string, string> }> = [
    { mode: 'legacy-primary', cookie: 'CFID=B1; CFTOKEN=B2; z=9', jar: {}, held: { CFID: 'B1', CFTOKEN: 'N2' } },
    {
      mode: 'target-primary',
      cookie: `JSESSIONID=${SESSION_ID}; CFID=T1; z=9`,
      jar: { CFID: { name: 'CFID', value: 'L1', attributes: 'path=/;' } },
      held: { CFID: 'L1', CFTOKEN: 'N2' },
    },
  ];

  it.each(LEGACY_SERVED_LOGOUTS.flatMap((logout) => LOGOUT_SESSIONS.map((held) => ({ ...logout, ...held }))))(
    'marks the identity end pending before legacy logs a $mode session out at $route, then hands the end the cookies legacy holds',
    async ({ route, kind, family, url, mode, cookie, jar, held }) => {
      const h = await harness(mode === 'target-primary' ? { active: indexOf('v0002', [], 'target') } : {});
      h.setScript(() => ({ entry: { route, kind }, destination: 'legacy', family }));
      vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session(mode));
      vi.mocked(h.deps.hydrator.ensureHydrated).mockResolvedValue(jarRow(jar));
      h.legacy.setHandler((_req, res) => {
        h.calls.push('legacy');
        sendBytes(res, 200, 'logged out', { 'set-cookie': ['CFTOKEN=N2;path=/;HttpOnly'] });
      });
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie, 'user-agent': 'OPT2-browser' } });
      expect(res.statusCode).toBe(200);
      expect(h.calls.filter((call) => call === 'legacy' || call.includes('Logout:'))).toEqual([
        `beforeLegacyLogout:${SESSION_ID}`,
        'legacy',
        `afterLegacyLogout:${SESSION_ID}`,
      ]);
      expect(h.deps.invalidation.beforeLegacyLogout).toHaveBeenCalledWith(SESSION_ID, mode);
      const [endedId, facts] = vi.mocked(h.deps.invalidation.afterLegacyLogout).mock.calls[0] ?? [];
      expect(endedId).toBe(SESSION_ID);
      expect([facts?.userAgent, facts?.mode]).toEqual(['OPT2-browser', mode]);
      expect(Object.fromEntries(Object.entries(facts?.cookies ?? {}).map(([key, entry]) => [key, entry.value]))).toEqual(held);
    },
  );

  it('answers the legacy 503 instead of legacy logout when identity cannot end the session', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'page:logout', kind: 'legacy-write' }, destination: 'legacy', family: 'page' }));
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('legacy-primary'));
    vi.mocked(h.deps.invalidation.afterLegacyLogout).mockRejectedValueOnce(new Error('identity unavailable'));
    h.legacy.setHandler((_req, res) => sendBytes(res, 302, '', { location: '/', 'set-cookie': ['CFID=1001;path=/;'] }));
    const res = await h.app.inject({ method: 'GET', url: '/?doaction=logout' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(adminUnavailableResponse().body);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
    expect(h.legacy.requests).toHaveLength(1);
    await settle();
    expect(rowCalls(h.calls)).toEqual(['register:page:logout:legacy:-', 'readEpoch', 'remove']);
  });

  describe('a target-primary legacy logout over the session invalidation and an in-memory jar', () => {
    const LIVE: JarCookies = { CFID: { name: 'CFID', value: 'L1', attributes: 'path=/;' } };

    const SECRET = 'CSRF-SECRET-S1';

    /** Epoch identity re-adopts the logged-out legacy session at. */
    const READOPTED_EPOCH = 5;

    /**
     * Identity's end refuses while `identity.down`; its adoption re-activates the session under its id, as identity
     * keys it by the legacy session id. The jar's mark is refused with `markFails`. Legacy describes the session logged
     * in under identity's secret while `legacy.loggedIn`, and refuses every describe while `legacy.unreadable`.
     */
    async function logoutHarness(opts: { markFails?: boolean } = {}) {
      const h = await harness({ active: indexOf('v0002', [], 'target') });
      const initial = jarRow(LIVE);
      const rows = new Map<string, JarRow>([[SESSION_ID, initial]]);
      const identity = { down: true, ended: false };
      const legacy = { loggedIn: false, unreadable: false };
      const clear = (sessionId: string, updatedAt?: Date): Promise<void> => {
        h.calls.push(`clear:${sessionId}`);
        const row = rows.get(sessionId);
        if (row !== undefined && (updatedAt === undefined || row.updatedAt.getTime() === updatedAt.getTime())) {
          const { identityEndPendingAt: _cleared, ...kept } = row;
          rows.set(sessionId, kept);
        }
        return Promise.resolve();
      };
      // The jar statements of a locked section, over the same rows.
      const locked = {
        get: (sessionId: string) => Promise.resolve(rows.get(sessionId)),
        lockNative: () => Promise.resolve(),
        drop: (sessionId: string) => Promise.resolve(rows.delete(sessionId)),
        clearIdentityEndPending: clear,
        upsert: (input: JarUpsert) => {
          h.calls.push(`upsert:${input.sessionId}:${String(input.hydratedEpoch)}`);
          const pending = rows.get(input.sessionId)?.identityEndPendingAt;
          const row: JarRow = { ...input, updatedAt: new Date(), ...(pending === undefined ? {} : { identityEndPendingAt: pending }) };
          rows.set(input.sessionId, row);
          return Promise.resolve(row);
        },
      } as unknown as LockedJar;
      h.deps.invalidation = createInvalidation({
        identity: {
          adopt: ({ describe }) => {
            h.calls.push(`identity.adopt:${describe.sessionId}`);
            identity.ended = false;
            return Promise.resolve({ sessionId: SESSION_ID, epoch: READOPTED_EPOCH, setCookie: [] });
          },
          end: (sessionId) => {
            h.calls.push(`identity.end:${sessionId}`);
            if (identity.down) return Promise.reject(new ServiceUnavailableError(IDENTITY_SERVICE, new Error('down')));
            identity.ended = true;
            return Promise.resolve({ ended: true, epoch: 4 });
          },
          snapshot: (sessionId) =>
            Promise.resolve(
              identity.ended
                ? undefined
                : { sessionId, epoch: 3, loginSnapshot: { user: { userID: 'U' }, roles: [] }, csrfSecretKey: SECRET, usedTokens: [] },
            ),
        },
        bridge: {
          describe: (cookies, call) => {
            const values = Object.values(cookies).map((held) => (typeof held === 'string' ? held : held.value));
            h.calls.push(`describe:${values.join(',')}:${call?.userAgent ?? '-'}`);
            if (legacy.unreadable) return Promise.reject(new ServiceUnavailableError('legacy-bridge', new Error('describe refused')));
            const body = { sessionId: 'L-1', isLoggedIn: legacy.loggedIn, csrfSecretKey: legacy.loggedIn ? SECRET : 'NEW' };
            return Promise.resolve({ body: body as LegacyDescribe, setCookies: [] });
          },
          end: () => Promise.reject(new Error('a legacy logout ends no legacy session')),
        },
        jar: {
          withSessionLock: (_sessionId, fn) => fn(locked),
          get: (sessionId) => Promise.resolve(rows.get(sessionId)),
          drop: (sessionId) => Promise.resolve(rows.delete(sessionId)),
          markIdentityEndPending: (sessionId) => {
            h.calls.push(`mark:${sessionId}`);
            if (opts.markFails) {
              return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
            }
            const row = rows.get(sessionId);
            if (row !== undefined) rows.set(sessionId, { ...row, identityEndPendingAt: row.identityEndPendingAt ?? new Date() });
            return Promise.resolve();
          },
          clearIdentityEndPending: clear,
        },
        tokenCache: { drop: () => undefined },
        state: { forget: () => undefined },
      });
      // Resolution flags a marked jar, as the session resolver does.
      const resolved = (): Promise<SessionResolution> => {
        const row = rows.get(SESSION_ID);
        if (row === undefined) return Promise.resolve({ kind: 'none', setCookies: [] });
        const marked = row.identityEndPendingAt !== undefined;
        return Promise.resolve(marked ? pendingSession('target-primary', row.cookies) : session('target-primary', row.cookies));
      };
      vi.mocked(h.deps.resolver.resolveSession).mockImplementation(resolved);
      vi.mocked(h.deps.resolver.resolveLegacyBound).mockImplementation(resolved);
      vi.mocked(h.deps.hydrator.ensureHydrated).mockImplementation(() => Promise.resolve(rows.get(SESSION_ID)));
      h.setScript((url) => {
        if (url.includes('doaction=logout')) {
          return { entry: { route: 'page:logout', kind: 'legacy-write' }, destination: 'legacy', family: 'page' };
        }
        if (url.startsWith('/admin/')) return { entry: { route: 'admin:cdashboard.main', kind: 'read' }, destination: 'legacy', family: 'admin' };
        return { entry: { route: 'api:content.findone', kind: 'read', state: 'target' }, destination: 'target' };
      });
      h.legacy.setHandler((_req, res) => {
        h.calls.push('legacy');
        sendBytes(res, 200, 'logged out');
      });
      return { h, rows, initial, identity, legacy };
    }

    it('answers the legacy 503 and releases the exchange without legacy or identity when the mark fails', async () => {
      const { h, rows, initial } = await logoutHarness({ markFails: true });
      const res = await h.app.inject({ method: 'GET', url: '/?doaction=logout' });
      expect(res.statusCode).toBe(503);
      expect(res.body).toBe(adminUnavailableResponse().body);
      expect(h.legacy.requests).toHaveLength(0);
      expect(h.calls.filter((call) => call.startsWith('identity.end'))).toEqual([]);
      expect(rows.get(SESSION_ID)).toBe(initial);
      expect(h.calls).toContain('csrf.after');
      expect(rowCalls(h.calls)).toEqual(['register:page:logout:legacy:-', 'readEpoch', 'remove']);
    });

    it('keeps the mark while identity cannot end the session, then re-adopts the logged-out legacy session once it can', async () => {
      const { h, rows, initial, identity } = await logoutHarness();
      expect((await h.app.inject({ method: 'GET', url: '/?doaction=logout' })).statusCode).toBe(503);
      expect(h.calls.filter((call) => /^(mark|legacy$|identity\.end)/.test(call))).toEqual([
        `mark:${SESSION_ID}`,
        'legacy',
        `identity.end:${SESSION_ID}`,
      ]);
      expect(rows.get(SESSION_ID)?.identityEndPendingAt).toBeInstanceOf(Date);

      expect((await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x' })).statusCode).toBe(503);
      expect(h.svc.requests).toHaveLength(0);
      expect(rows.get(SESSION_ID)?.identityEndPendingAt).toBeInstanceOf(Date);
      expect(h.deps.tokenCache.get).not.toHaveBeenCalled();

      identity.down = false;
      expect((await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x' })).statusCode).toBe(200);
      // The pending end completes and the session goes on, logged out, under its id and the jar legacy kept.
      expect(h.calls.filter((call) => /^(identity\.(end|adopt)|upsert|clear)/.test(call)).slice(-4)).toEqual([
        `identity.end:${SESSION_ID}`,
        'identity.adopt:L-1',
        `clear:${SESSION_ID}`,
        `upsert:${SESSION_ID}:${READOPTED_EPOCH}`,
      ]);
      expect(rows.get(SESSION_ID)).toEqual({ ...initial, hydratedEpoch: READOPTED_EPOCH, updatedAt: expect.any(Date) });
      expect(h.svc.requests).toHaveLength(1);
      expect(vi.mocked(h.deps.tokenCache.get).mock.calls.map(([sessionId]) => sessionId)).toEqual([SESSION_ID]);
    });

    it.each<{ name: string; loggedIn: boolean; status: number; ended: boolean }>([
      { name: 'a redirect that left legacy logged in keeps both sessions and the jar', loggedIn: true, status: 302, ended: false },
      {
        name: 'a logout legacy performed ends identity and re-adopts the logged-out legacy session, keeping the jar',
        loggedIn: false,
        status: 200,
        ended: true,
      },
    ])('judges the logout by describing the jar cookies legacy holds: $name', async ({ loggedIn, status, ended }) => {
      const { h, rows, initial, identity, legacy } = await logoutHarness();
      identity.down = false;
      legacy.loggedIn = loggedIn;
      h.legacy.setHandler((_req, res) => {
        h.calls.push('legacy');
        sendBytes(res, status, '', status === 302 ? { location: '/tenant-a/' } : {});
      });
      const headers = { cookie: `JSESSIONID=${SESSION_ID}; CFID=T1`, 'user-agent': 'OPT2-browser' };
      const res = await h.app.inject({ method: 'GET', url: '/tenant-a/?doaction=logout', headers });
      expect([res.statusCode, res.headers.location]).toEqual([status, status === 302 ? '/tenant-a/' : undefined]);
      expect(h.legacy.requests[0]?.headers.cookie).toBe('CFID=L1');
      expect(h.calls.filter((call) => /^(mark|legacy$|describe|clear|upsert|identity\.(end|adopt))/.test(call))).toEqual([
        `mark:${SESSION_ID}`,
        'legacy',
        'describe:L1:OPT2-browser',
        ...(ended
          ? [
              `identity.end:${SESSION_ID}`,
              'describe:L1:OPT2-browser',
              'identity.adopt:L-1',
              `clear:${SESSION_ID}`,
              `upsert:${SESSION_ID}:${READOPTED_EPOCH}`,
            ]
          : [`clear:${SESSION_ID}`]),
      ]);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(rows.get(SESSION_ID)).toEqual(
        ended ? { ...initial, hydratedEpoch: READOPTED_EPOCH, updatedAt: expect.any(Date) } : initial,
      );

      // Either way the next requests act in the same session, and legacy receives the ColdFusion session it kept.
      expect((await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x', headers })).statusCode).toBe(200);
      expect(h.svc.requests[0]?.headers.authorization).toBe('Bearer user-token-1');
      const page = await h.app.inject({ method: 'GET', url: '/admin/', headers });
      expect(h.legacy.requests.at(-1)?.headers.cookie).toBe('CFID=L1');
      expect(page.headers['set-cookie']).toBeUndefined();
    });

    it.each<{ name: string; unreadable: boolean }>([
      { name: 'serves them with the session while legacy still holds the login', unreadable: false },
      { name: 'serves them anonymously while legacy cannot be described', unreadable: true },
    ])('for a target-bound and a legacy-bound request during a pending logout, $name, ending nothing', async ({ unreadable }) => {
      const { h, rows, identity, legacy } = await logoutHarness();
      identity.down = false;
      legacy.loggedIn = true;
      legacy.unreadable = unreadable;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived!: () => void;
      const logoutArrived = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      h.legacy.setHandler(async (req, res) => {
        if (!req.url.includes('doaction=logout')) {
          sendBytes(res, 200, 'legacy-body');
          return;
        }
        // Masa's site-domain redirect, answered before the doaction runs, so legacy keeps the login.
        arrived();
        await held;
        sendBytes(res, 302, '', { location: '/tenant-a/' });
      });
      const headers = { cookie: `JSESSIONID=${SESSION_ID}; CFID=T1; z=9`, 'user-agent': 'OPT2-browser' };
      const logout = h.app.inject({ method: 'GET', url: '/tenant-a/?doaction=logout', headers });
      await logoutArrived;
      expect(rows.get(SESSION_ID)?.identityEndPendingAt).toBeInstanceOf(Date);

      const [target, page] = await Promise.all([
        h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x', headers }),
        h.app.inject({ method: 'GET', url: '/admin/', headers }),
      ]);
      release();
      expect([target.statusCode, page.statusCode, (await logout).statusCode]).toEqual([200, 200, 302]);

      expect(h.svc.requests[0]?.headers.authorization).toBe(unreadable ? undefined : 'Bearer user-token-1');
      expect(h.legacy.requests.find((request) => request.url === '/admin/')?.headers.cookie).toBe(unreadable ? 'z=9' : 'CFID=L1; z=9');
      expect(h.calls.filter((call) => call.startsWith('identity.end'))).toEqual([]);
      expect(identity.ended).toBe(false);
      // A kept logout clears its mark; an unknown one keeps the session marked for the next request to judge.
      expect(rows.get(SESSION_ID)).toMatchObject({ cookies: LIVE });
      expect(rows.get(SESSION_ID)?.identityEndPendingAt !== undefined).toBe(unreadable);
    });
  });

  it('completes a pending identity end before legacy sees the target-primary request without session cookies', async () => {
    const h = await harness({ active: indexOf('v0002', [], 'target') });
    const jar: JarCookies = { CFID: { name: 'CFID', value: 'L1', attributes: 'path=/;' } };
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValueOnce(pendingSession('target-primary', jar));
    await h.app.inject({ method: 'GET', url: '/admin/', headers: { cookie: 'CFID=T1; z=9' } });
    expect(h.calls.indexOf(`completePending:${SESSION_ID}`)).toBeLessThan(h.calls.indexOf(`barrier:${SESSION_ID}`));
    // The browser's CFID carries identity's value, so the logout is judged by the jar's legacy cookies.
    expect(vi.mocked(h.deps.invalidation.completePending).mock.calls[0]?.[1].cookies).toEqual(jar);
    expect(h.legacy.requests[0]?.headers.cookie).toBe('z=9');
    expect(h.deps.hydrator.ensureHydrated).not.toHaveBeenCalled();
    expect(h.deps.invalidation.afterTargetLogout).not.toHaveBeenCalled();
  });

  it('settles a claimed token from the ledger legacy left after its streamed body completed, before the client response ends', async () => {
    const h = await harness();
    const TOKEN = 'TOKEN-7';
    const save: RouteFacts = { route: 'api:content.save', csrfValidation: 'validates', writeSet: [], keyScope: [], sessionEffects: [] };
    const ledger: string[] = [];
    let legacyEnded = false;
    let settleDone = false;
    const reads: boolean[] = [];
    const settled: SettleInput[] = [];
    const live: JarCookies = { CFID: { name: 'CFID', value: 'L1', attributes: 'path=/;' } };
    h.deps.csrf = createCsrfContinuity({
      identity: {
        claim: async () => ({ state: 'pending-legacy' }),
        settle: async (input) => {
          settled.push(input);
          await new Promise((resolve) => setTimeout(resolve, 100));
          settleDone = true;
          return { used: input.consumed.length, released: input.released.length };
        },
      },
      bridge: {
        markUsed: () => Promise.reject(new Error('no token is used yet')),
        usedSince: async () => {
          reads.push(legacyEnded);
          return { body: { tokens: ledger.map((token) => ({ token, usedAt: '2026-06-30 12:00:01.000' })), serverTime: '' }, setCookies: [] };
        },
      },
      sessions: { resolveLegacyBound: async () => session('legacy-primary') },
      jar: { get: async () => ({ ...jarRow(live), mode: 'legacy-primary' as const }) },
      facts: { get: (route) => (route === save.route ? save : undefined), routes: () => [save.route] },
    });
    h.setScript(() => ({ entry: { route: 'api:content.save', kind: 'read' }, destination: 'legacy' }));
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('legacy-primary'));
    h.legacy.setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('validating ');
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Legacy's own validation consumes the token only after its headers and first bytes were flushed.
      ledger.push(TOKEN);
      legacyEnded = true;
      res.end('done');
    });

    const res = await h.app.inject({ method: 'POST', url: '/_api/json/v1/default/content/', headers: { 'x-csrf_token': TOKEN } });
    const doneAtEnd = settleDone;

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('validating done');
    expect(reads).toEqual([true]);
    expect(settled).toEqual([{ sessionId: SESSION_ID, consumed: [TOKEN], released: [] }]);
    expect(doneAtEnd).toBe(true);
  });

  it('settles no claim when legacy resets the connection mid-body, so the claim stays pending', async () => {
    const h = await harness();
    const handle: CsrfHandle = {
      sessionId: SESSION_ID,
      legacySessionId: 'L-1',
      legacyCookies: {},
      claimedTokens: ['TOKEN-8'],
      since: '2026-06-30 12:00:00.000',
      setCookies: [],
    };
    vi.mocked(h.deps.csrf.beforeLegacy).mockResolvedValueOnce(handle);
    h.legacy.setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
      res.write('partial');
      await new Promise((resolve) => setTimeout(resolve, 50));
      res.socket?.destroy();
    });
    await h.app.inject({ method: 'POST', url: '/admin/', headers: { 'x-csrf_token': 'TOKEN-8' } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.legacy.requests).toHaveLength(1);
    expect(h.deps.csrf.afterLegacy).not.toHaveBeenCalled();
  });

  it.each([
    ['stream', [] as string[]],
    ['buffer', [RATING_UNIT]],
  ] as const)('adopts a %s-mode legacy login into the adopted session only after legacy completed', async (mode, targetUnits) => {
    const facts: Record<string, RouteFacts> = {
      'page:login': { route: 'page:login', csrfValidation: 'none', writeSet: [], keyScope: [], sessionEffects: ['login'] },
    };
    const h = await harness({ active: indexOf('v0002', targetUnits, 'target'), facts });
    h.setScript(() => ({ entry: { route: 'page:login', kind: 'legacy-write', units: [RATING_UNIT] }, destination: 'legacy', family: 'page' }));
    vi.mocked(h.deps.resolver.adoptAfterLegacy).mockResolvedValueOnce({
      kind: 'session',
      sessionId: 'S-ADOPTED',
      epoch: 1,
      mode: 'target-primary',
      legacyCookies: {},
      setCookies: ['JSESSIONID=S-ADOPTED;path=/;'],
    });
    let legacyEnded = false;
    const endedAtLogin: boolean[] = [];
    vi.mocked(h.deps.invalidation.afterLegacyLogin).mockImplementationOnce(async (sessionId) => {
      h.calls.push(`afterLegacyLogin:${sessionId}`);
      endedAtLogin.push(legacyEnded);
      return undefined;
    });
    h.legacy.setHandler(async (_req, res) => {
      res.writeHead(302, { location: '/', 'set-cookie': ['CFTOKEN=N2;path=/;'] });
      res.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, 100));
      legacyEnded = true;
      res.end();
    });
    const res = await h.app.inject({ method: 'POST', url: '/?doaction=login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['set-cookie']).toEqual(['JSESSIONID=S-ADOPTED;path=/;']);
    expect(vi.mocked(h.deps.invalidation.afterLegacyLogin).mock.calls.map(([id, sessionMode]) => [id, sessionMode])).toEqual([
      ['S-ADOPTED', 'target-primary'],
    ]);
    expect(endedAtLogin).toEqual([true]);
    expect(h.calls.indexOf('csrf.after')).toBeLessThan(h.calls.indexOf('afterLegacyLogin:S-ADOPTED'));
    if (mode === 'buffer') {
      expect(h.calls.indexOf('afterLegacyLogin:S-ADOPTED')).toBeLessThan(h.calls.indexOf('window.complete:W1:true:302'));
    }
  });

  it('adopts a legacy login with the browser cookies plus those legacy set', async () => {
    const facts: Record<string, RouteFacts> = {
      'page:login': { route: 'page:login', csrfValidation: 'none', writeSet: [], keyScope: [], sessionEffects: ['login'] },
    };
    const h = await harness({ facts });
    h.setScript(() => ({ entry: { route: 'page:login', kind: 'legacy-write' }, destination: 'legacy', family: 'page' }));
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('legacy-primary'));
    h.legacy.setHandler((_req, res) => sendBytes(res, 302, '', { 'set-cookie': ['CFTOKEN=N2;path=/;'] }));
    await h.app.inject({ method: 'POST', url: '/?doaction=login', headers: { cookie: 'CFID=C1', 'user-agent': 'ua' } });
    expect(h.calls).toContain(`afterLegacyLogin:${SESSION_ID}`);
    const [, mode, legacyFacts] = vi.mocked(h.deps.invalidation.afterLegacyLogin).mock.calls[0] ?? [];
    expect(mode).toBe('legacy-primary');
    expect(legacyFacts?.userAgent).toBe('ua');
    expect(Object.fromEntries(Object.entries(legacyFacts?.cookies ?? {}).map(([key, cookie]) => [key, cookie.value]))).toEqual({
      CFID: 'C1',
      CFTOKEN: 'N2',
    });
  });
});

describe('legacy-primary legacy-bound requests while identity is unavailable', () => {
  const IDENTITY_DOWN = new ServiceUnavailableError(
    IDENTITY_SERVICE,
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8111'), { code: 'ECONNREFUSED' }),
  );
  const MAPPED_ID = 'M1';
  const LEGACY_SESSION_ID = 'L-1';
  const LEGACY_COOKIES = 'CFID=1001; CFTOKEN=12345678; JSESSIONID=L-J';
  const TOKEN = 'B'.repeat(32);
  const FACTS: Record<string, RouteFacts> = {
    'admin:clogin.login': {
      route: 'admin:clogin.login',
      csrfValidation: 'validates',
      writeSet: [],
      keyScope: [],
      sessionEffects: ['login'],
    },
    'admin:carch.update': {
      route: 'admin:carch.update',
      csrfValidation: 'validates',
      writeSet: ['content'],
      keyScope: [],
      sessionEffects: [],
    },
  };
  const DESCRIBED: LegacyDescribe = {
    sessionId: LEGACY_SESSION_ID,
    isLoggedIn: true,
    user: {
      userID: 'U1',
      username: 'admin',
      siteID: 'default',
      subtype: 'Default',
      password: '',
      fname: '',
      lname: '',
      email: '',
      remoteID: '',
      company: '',
      lastlogin: '',
      passwordCreated: '',
    },
    memberships: 'Admin;default;0',
    membershipIds: 'G1,U1',
    csrfSecretKey: 'SECRET',
    usedTokens: [],
    siteId: 'default',
    serverTime: '2026-06-30 12:00:00.000',
  };

  interface DownOptions {
    active?: RoutingIndex;
    /** Fields of the jar row mapping the browser's legacy session to M1; no row when absent. */
    mapped?: Partial<JarRow>;
    /** The bridge refuses as well. */
    bridgeDown?: boolean;
  }

  /** The dispatcher over the real session resolver, state checker and CSRF continuity, every identity call refused. */
  async function identityDown(opts: DownOptions = {}): Promise<Harness> {
    const h = await harness({ active: opts.active, facts: FACTS });
    const rows = new Map<string, JarRow>();
    if (opts.mapped !== undefined) {
      rows.set(MAPPED_ID, {
        sessionId: MAPPED_ID,
        legacySessionId: LEGACY_SESSION_ID,
        cookies: {},
        mode: 'legacy-primary',
        hydratedEpoch: null,
        updatedAt: new Date(),
        ...opts.mapped,
      });
    }
    const refuse = (op: string) => (): Promise<never> => {
      h.calls.push(`identity.${op}`);
      return Promise.reject(IDENTITY_DOWN);
    };
    const identity: IdentityClient = {
      mintToken: refuse('mintToken'),
      authenticate: refuse('authenticate'),
      adopt: refuse('adopt'),
      state: refuse('state'),
      adminSite: refuse('adminSite'),
      adminState: refuse('adminState'),
      importAdminState: refuse('importAdminState'),
      snapshot: refuse('snapshot'),
      end: refuse('end'),
      claim: refuse('claim'),
      settle: refuse('settle'),
    };
    const bridgeCall = (op: string) => (): Promise<never> => {
      h.calls.push(`bridge.${op}`);
      return Promise.reject(new ServiceUnavailableError('legacy-bridge', new Error(`${op} refused`)));
    };
    const bridge = {
      describe: opts.bridgeDown === true ? bridgeCall('describe') : () => Promise.resolve({ body: DESCRIBED, setCookies: [] }),
      markUsed: bridgeCall('markUsed'),
      usedSince: bridgeCall('usedSince'),
    } as unknown as BridgeClient;
    const jar = {
      get: (sessionId: string) => Promise.resolve(rows.get(sessionId)),
      findByLegacySessionId: (legacySessionId: string) =>
        Promise.resolve([...rows.values()].find((row) => row.legacySessionId === legacySessionId)),
    } as unknown as LegacyJar;
    const state = createSessionStateChecker({ identity, clock: systemClock, tokenCache: { drop: () => undefined } });
    h.deps.resolver = createSessionResolver({ identity, bridge, jar, state });
    h.deps.csrf = createCsrfContinuity({ identity, bridge, sessions: h.deps.resolver, jar, facts: h.deps.facts });
    h.legacy.setHandler((_req, res) => {
      h.calls.push('legacy');
      sendBytes(res, 200, 'legacy-body');
    });
    return h;
  }

  /** Adds `params` to every matched request's merged params, as its form body would. */
  function withParams(h: Harness, params: Record<string, string>): void {
    const match = vi.mocked(h.deps.matcher.match);
    const original = match.getMockImplementation();
    if (original === undefined) throw new Error('the harness matcher has no implementation');
    match.mockImplementation(async (...args) => {
      const outcome = await original(...args);
      if (outcome.result === undefined) return outcome;
      return { ...outcome, result: { ...outcome.result, params: { ...outcome.result.params, ...params } } };
    });
  }

  const identityCalls = (h: Harness): string[] => h.calls.filter((call) => call.startsWith('identity.'));

  it('forwards a login POST whose validating token identity can neither adopt nor claim, answering legacy own 302', async () => {
    const h = await identityDown();
    h.setScript(() => ({ entry: { route: 'admin:clogin.login', kind: 'write' }, destination: 'legacy', family: 'admin' }));
    withParams(h, { muraAction: 'cLogin.login', csrf_token: TOKEN, csrf_token_expires: '260630153456789' });
    h.legacy.setHandler((_req, res) => {
      sendBytes(res, 302, '', { location: './' });
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/index.cfm',
      headers: { cookie: LEGACY_COOKIES, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `muraAction=cLogin.login&csrf_token=${TOKEN}`,
    });

    expect([res.statusCode, res.headers.location]).toEqual([302, './']);
    expect(h.legacy.requests.map((request) => [request.method, request.headers.cookie])).toEqual([['POST', LEGACY_COOKIES]]);
    expect(identityCalls(h)).toEqual(['identity.adopt']);
    expect(h.calls.filter((call) => call.startsWith('bridge.'))).toEqual([]);
  });

  it.each<{ name: string; method: 'GET' | 'POST'; route: string; kind: EntryKind; params: Record<string, string> }>([
    { name: 'an admin page', method: 'GET', route: 'admin:cdashboard.main', kind: 'read', params: {} },
    { name: 'a validating save carrying a token', method: 'POST', route: 'admin:carch.update', kind: 'write', params: { csrf_token: TOKEN } },
  ])('forwards $name of a mapped session behind the barrier of the mapped session, with the browser cookies', async (c) => {
    const h = await identityDown({ mapped: {} });
    h.setScript(() => ({ entry: { route: c.route, kind: c.kind }, destination: 'legacy', family: 'admin' }));
    withParams(h, c.params);
    const res = await h.app.inject({ method: c.method, url: '/admin/', headers: { cookie: LEGACY_COOKIES } });

    expect([res.statusCode, res.body]).toEqual([200, 'legacy-body']);
    expect(h.calls.filter((call) => call.startsWith('barrier:') || call === 'legacy')).toEqual([`barrier:${MAPPED_ID}`, 'legacy']);
    expect(h.legacy.requests[0]?.headers.cookie).toBe(LEGACY_COOKIES);
    expect(new Set(identityCalls(h))).toEqual(new Set(['identity.state']));
    expect(h.calls.filter((call) => call.startsWith('bridge.'))).toEqual([]);
  });

  it('marks the identity end of a mapped session pending before legacy logs it out, answering the 503 identity owes', async () => {
    const h = await identityDown({ mapped: {} });
    h.setScript(() => ({ entry: { route: 'page:logout', kind: 'legacy-write' }, destination: 'legacy', family: 'page' }));
    vi.mocked(h.deps.invalidation.afterLegacyLogout).mockImplementationOnce((sessionId) => {
      h.calls.push(`afterLegacyLogout:${sessionId}`);
      return Promise.reject(IDENTITY_DOWN);
    });
    const res = await h.app.inject({ method: 'GET', url: '/?doaction=logout', headers: { cookie: LEGACY_COOKIES } });

    expect(res.statusCode).toBe(503);
    expect(h.calls.filter((call) => call === 'legacy' || call.includes('Logout:'))).toEqual([
      `beforeLegacyLogout:${MAPPED_ID}`,
      'legacy',
      `afterLegacyLogout:${MAPPED_ID}`,
    ]);
    expect(h.deps.invalidation.beforeLegacyLogout).toHaveBeenCalledWith(MAPPED_ID, 'legacy-primary');
  });

  it.each<{ name: string; options: DownOptions; destination: 'legacy' | 'target'; cookie: string; arrange?: (h: Harness) => void }>([
    {
      name: 'a target-primary legacy-bound request',
      options: { active: indexOf('v0002', [], 'target') },
      destination: 'legacy',
      cookie: `JSESSIONID=${MAPPED_ID}; CFID=T-CFID`,
    },
    { name: 'a legacy-primary target-bound request', options: { mapped: {} }, destination: 'target', cookie: LEGACY_COOKIES },
    {
      name: 'a mapped session whose barrier times out',
      options: { mapped: {} },
      destination: 'legacy',
      cookie: LEGACY_COOKIES,
      arrange: (h) => {
        vi.mocked(h.deps.barrier.awaitForSession).mockRejectedValueOnce(new BarrierTimeoutError('people=9', new Error('timeout')));
      },
    },
    {
      name: 'a mapped session whose pending identity end cannot complete',
      options: { mapped: { identityEndPendingAt: new Date() } },
      destination: 'legacy',
      cookie: LEGACY_COOKIES,
      arrange: (h) => {
        vi.mocked(h.deps.invalidation.completePending).mockRejectedValueOnce(IDENTITY_DOWN);
      },
    },
    { name: 'a request the legacy bridge cannot describe', options: { mapped: {}, bridgeDown: true }, destination: 'legacy', cookie: LEGACY_COOKIES },
  ])('fails closed for $name', async ({ options, destination, cookie, arrange }) => {
    const h = await identityDown(options);
    h.setScript(() => ({ entry: { route: 'admin:cdashboard.main', kind: 'read' }, destination }));
    arrange?.(h);
    const res = await h.app.inject({ method: 'GET', url: '/admin/', headers: { cookie } });

    expect([res.statusCode, res.body]).toEqual([503, adminUnavailableResponse().body]);
    expect(h.legacy.requests).toHaveLength(0);
    expect(h.svc.requests).toHaveLength(0);
  });
});

describe('Set-Cookie of legacy-primary target-served responses', () => {
  const TRACKING = 'MXP_TRACKINGID=TRACK-1; path=/; HttpOnly';
  const MOBILE = 'mobileFormat=false; path=/; HttpOnly';

  it.each<[string, Record<string, string>, unknown[] | undefined]>([
    ['an established session', { cookie: 'CFID=1001; CFTOKEN=T1; MXP_TRACKINGID=TRACK-0; mobileFormat=false' }, undefined],
    ['a cookieless first contact', {}, [TRACKING, REQUEST_START_COOKIES[1]]],
    ['a cookieless iPhone', { 'user-agent': IPHONE }, [TRACKING, expect.stringMatching(/^mobileFormat=true; path=\/; HttpOnly; Max-Age=946080000; Expires=/)]],
    ['a client holding only MXP_TRACKINGID', { cookie: 'MXP_TRACKINGID=TRACK-0' }, [REQUEST_START_COOKIES[1]]],
  ])('carry for %s the request start cookies legacy would set, keeping the describe MXP_TRACKINGID it owes', async (_label, headers, expected) => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: 'target' }, destination: 'target' }));
    const rows = new Map<string, JarRow>();
    h.deps.resolver = createSessionResolver({
      identity: { adopt: async () => ({ sessionId: SESSION_ID, epoch: 3, setCookie: [] }) } as unknown as IdentityClient,
      bridge: {
        describe: async () => ({ body: { sessionId: 'L-1' } as LegacyDescribe, setCookies: [TRACKING, MOBILE] }),
      } as unknown as BridgeClient,
      jar: {
        get: async () => undefined,
        findByLegacySessionId: async () => undefined,
        rebind: async (input: JarUpsert) => {
          const row: JarRow = { ...input, updatedAt: new Date() };
          rows.set(input.sessionId, row);
          return row;
        },
      } as unknown as LegacyJar,
      state: {
        check: async () => ({ state: 'active' as const, epoch: 3, userId: 'U', siteId: 'default', epochChanged: false }),
        forget: () => undefined,
      },
    });
    const res = await h.app.inject({ method: 'GET', url: '/_api/json/v1/default/content/x', headers });

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(expected);
    expect(rows.get(SESSION_ID)?.legacySessionId).toBe('L-1');
  });
});

describe('request start cookies and Content-Encoding of target-served responses', () => {
  const FIND_ONE: Script = { entry: { route: 'api:content.findone', kind: 'read', state: 'target' }, destination: 'target' };
  const FIND_ONE_URL = '/_api/json/v1/default/content/x';
  const ADMIN_LIST: Script = { entry: { route: 'admin:cusers.list', kind: 'read', state: 'target' }, destination: 'target' };
  const ADMIN_LIST_URL = '/admin/?muraAction=cUsers.list';
  const RATER_URL = '/core/modules/v1/rater/ajax/saveRate.cfm';
  const RATER: Script = {
    entry: { route: 'cfm:/core/modules/v1/rater/ajax/saverate.cfm', kind: 'write', state: 'target' },
    destination: 'target',
    family: 'cfm',
  };
  const SECURE_DOMAIN = { secure: true, domain: '.example.test' };
  const MASA_DEFAULTS = { secure: false, domain: '' };

  it('sends a cookieless client the request start cookies after the session and target cookies', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:cusers.list', kind: 'read', state: 'target' }, destination: 'target' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary', {}, ['CFID=1;path=/;', 'CFTOKEN=2;path=/;']));
    h.svc.setHandler((_req, res) => sendBytes(res, 302, '', { 'set-cookie': ['ADMINSIDEBAR=off; path=/'] }));
    const res = await h.app.inject({ method: 'GET', url: '/admin/?muraAction=cUsers.list', headers: { 'accept-encoding': 'identity' } });

    expect(res.statusCode).toBe(302);
    expect(res.headers['set-cookie']).toEqual(['CFID=1;path=/;', 'CFTOKEN=2;path=/;', 'ADMINSIDEBAR=off; path=/', ...REQUEST_START_COOKIES]);
    expect(res.headers['content-encoding']).toBe('identity');
  });

  // `attributes` is a pattern of what utility.setCookie writes between `path=/; ` and `HttpOnly; `.
  it.each<[label: string, method: 'GET' | 'POST', url: string, script: Script, settings: DispatcherDeps['cookieSettings'], attributes: string]>([
    ['an admin page under secureCookies and cookieDomain', 'GET', ADMIN_LIST_URL, ADMIN_LIST, SECURE_DOMAIN, 'domain=\\.example\\.test; secure; '],
    ['the rater under secureCookies and cookieDomain', 'POST', RATER_URL, RATER, SECURE_DOMAIN, 'domain=\\.example\\.test; secure; '],
    ['the rater under Masa’s defaults', 'POST', RATER_URL, RATER, MASA_DEFAULTS, ''],
  ])('writes the request start cookies of %s as utility.setCookie does', async (_label, method, url, script, settings, attributes) => {
    const h = await harness({ cookieSettings: settings });
    h.setScript(() => script);
    const res = await h.app.inject({ method, url });

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual([
      expect.stringMatching(
        new RegExp(`^MXP_TRACKINGID=[0-9A-F]{8}%2D[0-9A-F]{4}%2D[0-9A-F]{4}%2D[0-9A-F]{16}; path=/; ${attributes}HttpOnly; Max-Age=946080000; Expires=[^;]+ GMT$`),
      ),
      expect.stringMatching(new RegExp(`^mobileFormat=false; path=/; ${attributes}HttpOnly; Max-Age=946080000; Expires=[^;]+ GMT$`)),
    ]);
  });

  it.each<[label: string, url: string, headers: Record<string, string>, payload: string | undefined, expected: unknown[] | undefined]>([
    ['a client holding both cookies', FIND_ONE_URL, { cookie: 'MXP_TRACKINGID=X; mobileformat=true' }, undefined, undefined],
    ['an iPhone', FIND_ONE_URL, { cookie: 'MXP_TRACKINGID=X', 'user-agent': IPHONE }, undefined, [expect.stringMatching(/^mobileFormat=true; path=\/; HttpOnly; /)]],
    [
      'a boolean url mobileFormat, over its cookie',
      `${FIND_ONE_URL}?mobileFormat=yes`,
      { cookie: 'MXP_TRACKINGID=X; mobileFormat=false' },
      undefined,
      [expect.stringMatching(/^mobileFormat=yes; path=\/; HttpOnly; /)],
    ],
    [
      'a boolean form mobileFormat, over the url one',
      `${FIND_ONE_URL}?mobileFormat=false`,
      { cookie: 'MXP_TRACKINGID=X', 'content-type': 'application/x-www-form-urlencoded' },
      'mobileFormat=1',
      [expect.stringMatching(/^mobileFormat=1; path=\/; HttpOnly; /)],
    ],
    ['an admin preview, which skips mobileFormat', `${FIND_ONE_URL}?muraadminpreview`, {}, undefined, REQUEST_START_COOKIES.slice(0, 1)],
  ])('sends %s only the request start cookies legacy would', async (_label, url, headers, payload, expected) => {
    const h = await harness();
    h.setScript(() => FIND_ONE);
    const res = await h.app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(expected);
  });

  it.each<[label: string, script: Script, url: string, cookies: unknown[] | undefined, encoding: string | undefined]>([
    ['a JSON API route', FIND_ONE, FIND_ONE_URL, REQUEST_START_COOKIES, 'identity'],
    [
      'a sessionless REST route',
      { entry: { route: 'rest:content.findone', kind: 'read', state: 'target' }, destination: 'target', family: 'rest' },
      '/_api/rest/v1/default/content/x',
      undefined,
      'identity',
    ],
    [
      "web's runtime files",
      { entry: { route: 'static:/_next/**', kind: 'static', state: 'target' }, destination: 'target', family: 'static' },
      '/_next/static/chunk.js',
      undefined,
      undefined,
    ],
    [
      'an OPT-2 path',
      { entry: { route: 'opt2:/opt2/finance/**', kind: 'read', state: 'target' }, destination: 'target', family: 'opt2' },
      '/opt2/finance/v1/invoices',
      undefined,
      undefined,
    ],
    ['a legacy-served route, unchanged', { entry: { route: 'api:content.findone', kind: 'read' }, destination: 'legacy' }, FIND_ONE_URL, undefined, undefined],
  ])('answers a cookieless client negotiating identity on %s', async (_label, script, url, cookies, encoding) => {
    const h = await harness();
    h.setScript(() => script);
    const res = await h.app.inject({ method: 'GET', url, headers: { 'accept-encoding': 'identity' } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(cookies);
    expect(res.headers['content-encoding']).toBe(encoding);
  });

  it.each<[string | undefined, string | undefined]>([
    ['identity', 'identity'],
    ['gzip, *', 'identity'],
    ['gzip, deflate, br', undefined],
    ['identity;q=0', undefined],
    [undefined, undefined],
  ])('answers Accept-Encoding %j on a target route with Content-Encoding %j', async (acceptEncoding, encoding) => {
    const h = await harness();
    h.setScript(() => FIND_ONE);
    const res = await h.app.inject({
      method: 'GET',
      url: FIND_ONE_URL,
      headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
    });

    expect(res.headers['content-encoding']).toBe(encoding);
  });

  it("adds Content-Encoding to identity's legacy answer, which sets no request start cookie", async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'rest:content.findone', kind: 'read', state: 'target' }, destination: 'target', family: 'rest' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce({
      kind: 'response',
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic' },
      body: '{}',
    });
    const res = await h.app.inject({ method: 'GET', url: '/_api/rest/v1/default/content/x', headers: { 'accept-encoding': 'identity' } });

    expect([res.statusCode, res.headers['www-authenticate'], res.headers['content-encoding']]).toEqual([401, 'Basic', 'identity']);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(h.svc.requests).toHaveLength(0);
  });
});
