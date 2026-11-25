// Write windows of legacy-write entries: the open call's bound, and the whole gateway against the migration and legacy doubles.
// scopeFor and the shapes of the open and complete calls are covered once, in write-window-client.test.ts.
import { Buffer } from 'node:buffer';
import { adminUnavailableResponse } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InventoryFacts } from '../../src/cutover/types.js';
import {
  WINDOW_OPEN_BUDGET_MS,
  WINDOW_OPEN_TIMEOUT_MS,
  WindowOpenError,
  createWriteWindowClient,
} from '../../src/dispatcher/write-window.js';
import { buildTestGateway, type TestGateway, type TestGatewayOptions } from '../helpers/app.js';
import type { InflightRowRecord } from '../helpers/memory-store.js';
import type { OpenBehaviour } from '../helpers/migration-double.js';
import { cutoverTable, entry } from '../helpers/versions.js';

const SAVE_RATE = 'page:saverate';
const FAVORITE_DELETE = 'cfm:/core/modules/v1/favorites/ajax/deleterssfavorite.cfm';
const SAVE_FORM = 'page:saveform';
const RATING_UNIT = 'content.content_rating';
const FAVORITE_UNIT = 'people.user_favorite';
const FORM_UNIT = 'content.form_response_packet';
const OPEN_PATH = '/internal/v1/windows';
const NO_FACTS: InventoryFacts = { get: () => undefined, routes: () => [] };

/** Two target-authoritative and one legacy-authoritative legacy-write entries. */
const TABLE = cutoverTable({
  tableVersion: 'v0101',
  entries: [
    entry({ route: SAVE_RATE, owningService: 'strategies-content', kind: 'legacy-write', units: [RATING_UNIT], disposition: 'legacy-served' }),
    entry({ route: FAVORITE_DELETE, owningService: 'people', kind: 'legacy-write', units: [FAVORITE_UNIT], disposition: 'legacy-served' }),
    entry({ route: SAVE_FORM, owningService: 'strategies-content', kind: 'legacy-write', units: [FORM_UNIT], disposition: 'legacy-served' }),
  ],
  groupAuthority: { [`grp:${RATING_UNIT}`]: 'target', [`grp:${FAVORITE_UNIT}`]: 'target', [`grp:${FORM_UNIT}`]: 'legacy' },
});

/** Form of a rating POST; the inventory scopes `page:saverate` writes by the whole table. */
const RATE_FORM = { doaction: 'saveRate', siteid: 'tenant-a', contentid: 'C1', userid: 'U1', rate: '5' };

/** A favorite delete; the inventory scopes its writes by the user and site. */
const FAVORITE_URL = '/core/modules/v1/favorites/ajax/deleterssfavorite.cfm?siteid=tenant-a&userid=U1&favoriteid=F1';

const CONTENT_UNIT = 'content.content';
const TARGETING_UNIT = 'content.variation_targeting';
const TARGETING_SAVE = 'api:variationtargeting.save';

/** TABLE plus the reload entry and a target write, every unit of them target-authoritative. */
const RELOAD_TABLE = cutoverTable({
  tableVersion: 'v0102',
  entries: [
    ...TABLE.entries,
    entry({ route: 'reload:application', owningService: 'strategies-content', kind: 'legacy-write', units: [CONTENT_UNIT], disposition: 'legacy-served' }),
    entry({ route: TARGETING_SAVE, owningService: 'strategies-content', state: 'target', kind: 'write', units: [TARGETING_UNIT] }),
  ],
  groupAuthority: { ...TABLE.groupAuthority, [`grp:${CONTENT_UNIT}`]: 'target', [`grp:${TARGETING_UNIT}`]: 'target' },
});

const ADMIN_503 = adminUnavailableResponse();

let gateway: TestGateway | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await gateway?.close();
  gateway = undefined;
});

async function start(opts: Pick<TestGatewayOptions, 'legacy' | 'migration' | 'version'> = {}): Promise<TestGateway> {
  gateway = await buildTestGateway({ version: TABLE, services: [], ...opts });
  return gateway;
}

function post(gw: TestGateway, form: Record<string, string>, requestId: string) {
  return gw.app.inject({
    method: 'POST',
    url: '/index.cfm',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-request-id': requestId },
    payload: new URLSearchParams(form).toString(),
  });
}

/** A copy of the gateway's in-flight rows. */
function inflightRows(gw: TestGateway): InflightRowRecord[] {
  if (gw.memory === undefined) throw new Error('the test gateway has no memory store');
  return gw.memory.tables.inflight.map((row) => ({ ...row }));
}

function lowerCased(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** A ServiceClient that never answers and rejects, as the platform client does, once the call's own bound elapses. */
function silentBoundedClient(): ServiceClient & { calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const request = (req: ServiceRequest): Promise<ServiceResponse> => {
    calls.push(req);
    return new Promise((_resolve, reject) => {
      setTimeout(() => reject(new ServiceUnavailableError(req.service, new Error('The operation was aborted due to timeout'))), req.timeoutMs);
    });
  };
  return { calls, request: request as ServiceClient['request'], close: async () => undefined };
}

describe('window open bound', () => {
  it("waits out migration's whole open budget and fails as WindowOpenError only once the call bound lapses", async () => {
    vi.useFakeTimers();
    const client = silentBoundedClient();
    const windows = createWriteWindowClient({ client, facts: NO_FACTS });
    let outcome: unknown = 'pending';
    void windows.open({ routeKey: SAVE_RATE, units: [RATING_UNIT], scope: { table: true }, requestId: 'req-bound' }).then(
      () => {
        outcome = 'opened';
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await vi.advanceTimersByTimeAsync(WINDOW_OPEN_BUDGET_MS);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(WINDOW_OPEN_TIMEOUT_MS - WINDOW_OPEN_BUDGET_MS - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toBeInstanceOf(WindowOpenError);
    expect(outcome).toMatchObject({ routeKey: SAVE_RATE, reason: 'window-unavailable' });
    expect(client.calls).toHaveLength(1);
  });
});

describe('legacy-write dispatch through the gateway', () => {
  it('opens one window, with the route key, target units and request scope, only when a unit is target-authoritative', async () => {
    const gw = await start();

    const unwindowed = await post(gw, { doaction: 'saveform', siteid: 'tenant-a' }, 'req-saveform');
    expect(unwindowed.statusCode).toBe(200);
    expect(gw.legacy.requests).toHaveLength(1);
    expect(gw.migration.requests).toEqual([]);

    const windowed = await post(gw, RATE_FORM, 'req-rate');
    expect(windowed.statusCode).toBe(200);
    const keyed = await gw.app.inject({ method: 'GET', url: FAVORITE_URL, headers: { 'x-request-id': 'req-favorite' } });
    expect(keyed.statusCode).toBe(200);
    expect(gw.legacy.requests).toHaveLength(3);
    expect(gw.migration.windows).toEqual([
      expect.objectContaining({ routeKey: SAVE_RATE, units: [RATING_UNIT], scope: { table: true }, requestId: 'req-rate' }),
      expect.objectContaining({
        routeKey: FAVORITE_DELETE,
        units: [FAVORITE_UNIT],
        scope: { keys: { siteid: 'tenant-a', userid: 'U1' } },
        requestId: 'req-favorite',
      }),
    ]);
  });

  it.each<[string, OpenBehaviour]>([
    ['a 503 refusal', { status: 503 }],
    ['a dropped connection', 'refuse'],
  ])('answers the legacy 503 before legacy executes when the window open meets %s', async (_label, open) => {
    const gw = await start({ migration: { open } });

    const res = await post(gw, RATE_FORM, 'req-refused');

    expect(res.statusCode).toBe(ADMIN_503.status);
    expect(res.headers).toMatchObject(lowerCased(ADMIN_503.headers));
    expect(res.body).toBe(ADMIN_503.body);
    expect(gw.migration.requests.map((req) => req.path)).toEqual([OPEN_PATH]);
    expect(gw.migration.windows).toEqual([]);
    expect(gw.legacy.requests).toEqual([]);
    expect(inflightRows(gw)).toEqual([]);
  });

  it("keeps a request whose window open hangs away from legacy until migration's answer is lost, then answers the legacy 503", async () => {
    const gw = await start({ migration: { open: 'hang' } });
    let answered = false;
    const pending = post(gw, RATE_FORM, 'req-hang').then((res) => {
      answered = true;
      return res;
    });

    await vi.waitFor(() => expect(gw.migration.requests.map((req) => req.path)).toEqual([OPEN_PATH]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    expect(gw.legacy.requests).toEqual([]);

    // The open's bound is the platform client's AbortSignal, which fake timers cannot advance, so the answer is lost instead.
    await gw.migration.close();
    const res = await pending;

    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(ADMIN_503.body);
    expect(gw.legacy.requests).toEqual([]);
    expect(inflightRows(gw)).toEqual([]);
  });

  it("returns legacy's buffered status, headers and bytes only after reporting legacy's outcome to migration", async () => {
    const gw = await start({ legacy: { autoCreateSession: false } });
    const bytes = Buffer.concat([Buffer.from('{"rating":4.5}'), Buffer.from([0x00, 0xff, 0xfe])]);
    const setCookies = ['RATED_C1=1; Path=/', 'MURA_RATE=4.5; Path=/; HttpOnly'];
    let legacyAnsweredAt: number | undefined;
    let respondedBeforeCompletion: boolean | undefined;
    let responded = false;
    gw.legacy.setResponse(() => {
      legacyAnsweredAt = performance.now();
      return { status: 201, headers: { 'Content-Type': 'application/octet-stream', 'X-Rating': '4.5' }, body: bytes, setCookies };
    });
    gw.migration.setComplete(() => {
      respondedBeforeCompletion = responded;
      return 'closed';
    });

    const res = await post(gw, RATE_FORM, 'req-buffered').then((answer) => {
      responded = true;
      return answer;
    });
    const respondedAt = performance.now();

    const [window] = gw.migration.windows;
    expect(window?.completion).toEqual({ forwarded: true, legacyStatus: 201 });
    expect(respondedBeforeCompletion).toBe(false);
    expect(window?.completedAt).toBeGreaterThan(legacyAnsweredAt ?? Number.POSITIVE_INFINITY);
    expect(window?.completedAt).toBeLessThanOrEqual(respondedAt);
    expect(res.statusCode).toBe(201);
    expect(res.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'x-rating': '4.5',
      'x-legacy-double': '1',
      'set-cookie': setCookies,
    });
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it("still returns legacy's buffered response when the window import stays pending", async () => {
    const gw = await start();
    gw.migration.setComplete('import-pending');
    gw.legacy.setResponse({ status: 302, headers: { Location: '/tenant-a/rated/' }, body: '' });

    const res = await post(gw, RATE_FORM, 'req-pending');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/tenant-a/rated/');
    expect(gw.migration.windows.map((window) => window.completion)).toEqual([{ forwarded: true, legacyStatus: 302 }]);
  });

  it.each([
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/variationtargeting', 'rest:variationtargeting.save{session}'],
    ['DELETE', '/Index.cfm/_api/rest/v1/tenant-a/variationtargeting/A1B2C3D4-E5F6-7890-ABCDEF1234567890', 'rest:variationtargeting.delete{session}'],
  ])('under v0002 serves a session-managed REST %s %s on legacy inside a window of its {session} legacy-write', async (method, url, routeKey) => {
    gateway = await buildTestGateway({ version: 'v0002', services: ['strategies-content'] });
    const gw = gateway;

    const res = await gw.app.inject({ method, url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'siteid=tenant-a' });

    expect(res.statusCode).toBe(200);
    // v0002 runs target-primary, so the gateway adopts the session legacy opened for the call.
    expect(gw.legacy.requests.map((req) => [req.method, req.url])).toEqual([
      [method, url],
      ['GET', '/gateway/legacy-bridge/cfml/session.cfm?op=describe'],
    ]);
    expect(gw.migration.windows).toEqual([
      expect.objectContaining({
        routeKey,
        units: ['content.variation_targeting'],
        scope: { table: true },
        completion: { forwarded: true, legacyStatus: 200 },
      }),
    ]);
    expect(gw.targets['strategies-content']?.requests).toEqual([]);
  });

  it.each([
    ['POST', '/_api/rest/v1/tenant-a/variationtargeting', 'siteid=tenant-a', 'rest:variationtargeting.save{siteid}'],
    ['DELETE', '/_api/rest/v1/tenant-a/variationtargeting/A1B2C3D4-E5F6-7890-ABCDEF1234567890?siteid=tenant-a', '', 'rest:variationtargeting.delete{siteid}'],
  ])('under v0002 serves a sessionless REST %s %s carrying a siteid on legacy inside a window of its {siteid} legacy-write, never asking identity', async (method, url, payload, routeKey) => {
    gateway = await buildTestGateway({ version: 'v0002', services: ['strategies-content'] });
    const gw = gateway;
    const basic = `Basic ${Buffer.from('rest-user:rest-secret').toString('base64')}`;
    gw.identity.restSession(basic, { sessionId: 'ids-rest', userId: 'U-REST', siteId: 'tenant-a', adminSite: '', roles: ['systemUser'] });

    const res = await gw.app.inject({ method, url, headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, payload });

    expect(res.statusCode).toBe(200);
    // v0002 runs target-primary, so the gateway asks the bridge after legacy's answer, as for every legacy-served call.
    expect(gw.legacy.requests.map((req) => [req.method, req.url])).toEqual([
      [method, url],
      ['GET', '/gateway/legacy-bridge/cfml/session.cfm?op=describe'],
    ]);
    expect(gw.migration.windows).toEqual([
      expect.objectContaining({
        routeKey,
        units: ['content.variation_targeting'],
        completion: { forwarded: true, legacyStatus: 200 },
      }),
    ]);
    expect(gw.identity.authentications).toEqual([]);
    expect(gw.targets['strategies-content']?.requests).toEqual([]);
  });

  it("under v0002 serves a Site Manager sort of the home page on legacy inside a table-wide window, since legacy's contentid-only updates reach every site's row", async () => {
    gateway = await buildTestGateway({ version: 'v0002', services: ['strategies-content'] });
    const gw = gateway;
    const url = '/admin/?muraAction=cArch.list&siteid=tenant-a&moduleid=00000000000000000000000000000000000&topid=00000000000000000000000000000000001';

    const res = await gw.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-request-id': 'req-sort' },
      payload: 'startrow=1&orderperm=editor&sorted=true&orderid=C1&orderid=C2',
    });

    expect(res.statusCode).toBe(200);
    expect(gw.legacy.requests.map((req) => [req.method, req.url])).toContainEqual(['POST', url]);
    expect(gw.migration.windows).toEqual([
      expect.objectContaining({
        routeKey: 'admin:carch.list{sharedid}',
        units: [CONTENT_UNIT],
        scope: { table: true },
        requestId: 'req-sort',
        completion: { forwarded: true, legacyStatus: 200 },
      }),
    ]);
    expect(gw.targets['strategies-content']?.requests).toEqual([]);
  });

  it('under v0002 keeps a sessionless REST variation-targeting save on strategies-content, outside any window', async () => {
    gateway = await buildTestGateway({ version: 'v0002', services: ['strategies-content'] });
    const gw = gateway;
    const basic = `Basic ${Buffer.from('rest-user:rest-secret').toString('base64')}`;
    gw.identity.restSession(basic, { sessionId: 'ids-rest', userId: 'U-REST', siteId: 'tenant-a', adminSite: '', roles: ['systemUser'] });

    const res = await gw.app.inject({
      method: 'POST',
      url: '/index.cfm/_api/rest/v1/tenant-a/variationtargeting',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'variationid=V1',
    });

    expect(res.statusCode).toBe(200);
    expect(gw.targets['strategies-content']?.requests.map((req) => req.url)).toEqual(['/index.cfm/_api/rest/v1/tenant-a/variationtargeting']);
    expect(gw.legacy.requests).toEqual([]);
    expect(gw.migration.windows).toEqual([]);
  });

  it('registers the windowed request in flight with its window id and removes the row once legacy answered', async () => {
    const gw = await start();
    let duringLegacy: InflightRowRecord[] = [];
    gw.legacy.setResponse(() => {
      duringLegacy = inflightRows(gw);
      return { status: 200, body: 'rated' };
    });

    const res = await post(gw, RATE_FORM, 'req-inflight');

    expect(res.statusCode).toBe(200);
    const windowIds = gw.migration.windows.map((window) => window.windowId);
    expect(windowIds).toEqual([expect.any(String)]);
    expect(duringLegacy).toEqual([
      expect.objectContaining({ request_id: 'req-inflight', route: SAVE_RATE, side: 'legacy', window_id: windowIds[0] }),
    ]);
    expect(inflightRows(gw)).toEqual([]);
  });

  it.each(['/opt2/unmatched/x'])(
    'opens the window of the legacy entry point that serves the unmatched OPT-2 namespace path %s',
    async (url) => {
      const gw = await start();

      const res = await gw.app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-request-id': 'req-opt2' },
        payload: new URLSearchParams(RATE_FORM).toString(),
      });

      expect(res.statusCode).toBe(200);
      expect(gw.legacy.requests.map((req) => req.url)).toEqual([url]);
      expect(gw.migration.windows).toEqual([expect.objectContaining({ routeKey: SAVE_RATE, units: [RATING_UNIT], requestId: 'req-opt2' })]);
    },
  );

  it.each<[string, string, Record<string, string>, string, string[]]>([
    ['a target write', '/_api/json/v1/default/variationtargeting/?appreload', { contentid: 'C1', targetingjs: 'probe' }, TARGETING_SAVE, [TARGETING_UNIT, CONTENT_UNIT]],
    ['a request-scoped legacy-write', '/index.cfm?appreload', RATE_FORM, SAVE_RATE, [RATING_UNIT, CONTENT_UNIT]],
  ])(
    'runs a reload in front of %s on legacy in one table-wide window over its units and the reload units, in flight as its route',
    async (_label, url, form, route, units) => {
      const gw = await start({ version: RELOAD_TABLE });
      let duringLegacy: InflightRowRecord[] = [];
      gw.legacy.setResponse(() => {
        duringLegacy = inflightRows(gw);
        return { status: 200, body: 'reloaded' };
      });

      const res = await gw.app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-request-id': 'req-reload' },
        payload: new URLSearchParams(form).toString(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('reloaded');
      expect(gw.legacy.requests.map((req) => req.url)).toEqual([url]);
      expect(gw.migration.windows).toEqual([
        expect.objectContaining({ routeKey: route, units, scope: { table: true }, requestId: 'req-reload', completion: { forwarded: true, legacyStatus: 200 } }),
      ]);
      expect(duringLegacy).toEqual([expect.objectContaining({ request_id: 'req-reload', route, side: 'legacy' })]);
      expect(inflightRows(gw)).toEqual([]);
    },
  );
});
