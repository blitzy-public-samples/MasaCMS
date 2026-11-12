// Edge dispatcher orchestration over stand-in legacy and service servers and recorded fakes of every collaborator.
import { Buffer } from 'node:buffer';
import replyFrom from '@fastify/reply-from';
import { INVOCATION_HEADER, recordedRoutes, rolesForService } from '@opt2/platform/auth';
import { apiUnavailableResponse, adminUnavailableResponse, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import {
  LEGACY_POST_LIMIT_BYTES,
  createService,
  loadEnv,
  systemClock,
  type FastifyInstance,
} from '@opt2/platform/service-kit';
import { mintServiceToken, testVerifier } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CutoverEntry, EntryKind, RouteFacts, RoutingIndex } from '../../src/cutover/types.js';
import { BarrierTimeoutError } from '../../src/dispatcher/barrier.js';
import { EDGE_METHODS, EDGE_ROUTE_URL, registerEdgeRoute, type DispatcherDeps } from '../../src/dispatcher/dispatch.js';
import { failContextFor } from '../../src/dispatcher/fail-closed.js';
import type { Destination, MatchOutcome } from '../../src/dispatcher/match.js';
import { WindowOpenError } from '../../src/dispatcher/write-window.js';
import type { JarCookies, JarRow } from '../../src/session/jar.js';
import type { SessionMode } from '../../src/session/mode.js';
import type { SessionResolution } from '../../src/session/resolve.js';
import { sendBytes, startHttpDouble, type HttpDouble } from '../helpers/http-double.js';

const SILENT = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
const SESSION_ID = 'S1';
const RATING_UNIT = 'content.content_rating';

/** What the fake matcher answers for a request target and the index it is matched against. */
interface Script {
  entry?: Partial<CutoverEntry> & { route: string; kind: EntryKind };
  destination: 'legacy' | 'target' | 'unavailable' | 'bare' | 'relay';
  family?: RouteKeyResult['family'];
}

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

function jarRow(cookies: JarCookies): JarRow {
  return { sessionId: SESSION_ID, legacySessionId: 'L-1', cookies, mode: 'target-primary', hydratedEpoch: 3, updatedAt: new Date() };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** `active: null` starts the gateway with no active version. */
async function harness(opts: { active?: RoutingIndex | null; facts?: Record<string, RouteFacts> } = {}): Promise<Harness> {
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
    logger: SILENT,
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
    const key = s.entry?.route ?? `${family}:unlisted`;
    const result: RouteKeyResult = { key, baseKey: key, family, httpMethod: 'GET', params: { siteid: 'default' }, siteId: 'default' };
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
    return { result, entry, destination, failContext: failContextFor(result, url) };
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
    },
    barrier: {
      record: vi.fn(async () => undefined),
      awaitForSession: vi.fn(async (sessionId) => {
        calls.push(`barrier:${sessionId}`);
      }),
    },
    resolver: {
      resolveSession: vi.fn(async (): Promise<SessionResolution> => ({ kind: 'none', setCookies: [] })),
      resolveLegacyBound: vi.fn(async (): Promise<SessionResolution> => ({ kind: 'none', setCookies: [] })),
      adoptAfterLegacy: vi.fn(async (_input, o): Promise<SessionResolution> => ({ kind: 'none', setCookies: [...o.setCookies] })),
    },
    tokenCache: { get: vi.fn(async () => 'user-token-1') },
    stateCheck: {
      check: vi.fn(async () => ({ state: 'active' as const, epoch: 3, userId: 'U', siteId: 'default', epochChanged: false })),
    },
    hydrator: {
      ensureHydrated: vi.fn(async () => {
        calls.push('hydrate');
        return undefined;
      }),
    },
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
      afterLegacyLogout: vi.fn(async (sessionId) => {
        calls.push(`afterLegacyLogout:${sessionId}`);
      }),
      afterLegacyLogin: vi.fn(async (sessionId) => {
        calls.push(`afterLegacyLogin:${sessionId}`);
        return undefined;
      }),
    },
    facts: { get: (route) => facts[route], routes: () => Object.keys(facts) },
    auth: app.opt2.auth,
    relay: {
      env: { OPT2_SERVICE_URLS: { people: svc.url } },
      invocation: app.opt2.auth.invocationMinter,
      barrier: { record: async () => undefined },
      sessionMode: () => 'legacy-primary',
    },
    legacyOrigin: legacy.url,
    clock: systemClock,
  };

  await app.register(replyFrom);
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
  calls.filter((call) => /^(register|readEpoch|remove|window\.)/.test(call));

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

  it('fails closed on a body whose params cannot be read', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'POST', url: '/admin/', headers: { 'content-type': 'multipart/form-data' }, payload: 'x' });
    expect(res.statusCode).toBe(503);
    expect(h.legacy.requests).toHaveLength(0);
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

  it('sends a target route to its service with the session token and its own invocation credential', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'api:content.findone', kind: 'read', state: 'target' }, destination: 'target' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary', {}, ['CFID=1;path=/;']));
    const res = await h.app.inject({
      method: 'GET',
      url: '/_api/json/v1/default/content/x',
      headers: { authorization: 'Basic dTpw', 'x-opt2-thing': '1', 'x-serverless-authorization': 'Bearer forged' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(['CFID=1;path=/;']);
    const received = h.svc.requests[0];
    expect(received?.headers.authorization).toBe('Bearer user-token-1');
    expect(received?.headers['x-serverless-authorization']).toMatch(/^Bearer (?!forged)/);
    expect(received?.headers['x-opt2-thing']).toBeUndefined();
    expect(h.deps.tokenCache.get).toHaveBeenCalledWith(SESSION_ID, 'default', 3);
    expect(h.legacy.requests).toHaveLength(0);
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

  it('answers identity credential responses verbatim without calling the service', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'rest:content', kind: 'read', state: 'target' }, destination: 'target', family: 'rest' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce({
      kind: 'response',
      status: 401,
      headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
      body: '{"error":"invalid_token"}',
    });
    const res = await h.app.inject({ method: 'GET', url: '/_api/rest/v1/default/content' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(res.body).toBe('{"error":"invalid_token"}');
    expect(h.svc.requests).toHaveLength(0);
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
    expect(res.headers['set-cookie']).toEqual(['cfid=T9;path=/;HttpOnly;', deletion, 'x=1', 'CFTOKEN=T2;path=/;']);
  });

  it('ends both sessions when the target serves a logout', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:clogin.logout', kind: 'read', state: 'target' }, destination: 'target' }));
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce(session('legacy-primary'));
    await h.app.inject({ method: 'GET', url: '/admin/?muraAction=clogin.logout' });
    expect(h.calls).toContain(`afterTargetLogout:${SESSION_ID}`);
  });

  it('skips session work for static entries', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'static:/admin/assets/**', kind: 'static' }, destination: 'legacy' }));
    expect((await h.app.inject({ method: 'GET', url: '/admin/assets/css/admin.css' })).statusCode).toBe(200);
    expect(h.deps.resolver.resolveLegacyBound).not.toHaveBeenCalled();
    expect(h.deps.csrf.beforeLegacy).not.toHaveBeenCalled();
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
  it('registers before reading the epoch and removes the row once the response completed', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'admin:cusers.update', kind: 'write', state: 'target' }, destination: 'target' }));
    expect((await h.app.inject({ method: 'POST', url: '/admin/?muraAction=cusers.update' })).statusCode).toBe(200);
    await settle();
    expect(rowCalls(h.calls)).toEqual(['register:admin:cusers.update:target:-', 'readEpoch', 'remove']);
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

  it('ends both sessions after a legacy logout', async () => {
    const h = await harness();
    h.setScript(() => ({ entry: { route: 'page:logout', kind: 'legacy-write' }, destination: 'legacy', family: 'page' }));
    vi.mocked(h.deps.resolver.resolveLegacyBound).mockResolvedValue(session('legacy-primary'));
    await h.app.inject({ method: 'GET', url: '/?doaction=logout' });
    expect(h.calls).toContain(`afterLegacyLogout:${SESSION_ID}`);
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
