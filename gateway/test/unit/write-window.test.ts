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
const RATING_UNIT = 'content.content_rating';
const MAILING_UNIT = 'communications.mailing_list_member';
const OPEN_PATH = '/internal/v1/windows';
const NO_FACTS: InventoryFacts = { get: () => undefined, routes: () => [] };

/** One target-authoritative and one legacy-authoritative legacy-write entry. */
const TABLE = cutoverTable({
  tableVersion: 'v0101',
  entries: [
    entry({ route: SAVE_RATE, owningService: 'strategies-content', kind: 'legacy-write', units: [RATING_UNIT], disposition: 'legacy-served' }),
    entry({ route: 'page:subscribe', owningService: 'communications', kind: 'legacy-write', units: [MAILING_UNIT], disposition: 'legacy-served' }),
  ],
  groupAuthority: { [`grp:${RATING_UNIT}`]: 'target', [`grp:${MAILING_UNIT}`]: 'legacy' },
});

/** Form of a rating POST; the inventory scopes `page:saverate` writes by siteid, userid and contentid. */
const RATE_FORM = { doaction: 'saveRate', siteid: 'tenant-a', contentid: 'C1', userid: 'U1', rate: '5' };

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

    const unwindowed = await post(gw, { doaction: 'subscribe', email: 'member@example.com' }, 'req-subscribe');
    expect(unwindowed.statusCode).toBe(200);
    expect(gw.legacy.requests).toHaveLength(1);
    expect(gw.migration.requests).toEqual([]);

    const windowed = await post(gw, RATE_FORM, 'req-rate');
    expect(windowed.statusCode).toBe(200);
    expect(gw.legacy.requests).toHaveLength(2);
    expect(gw.migration.windows).toEqual([
      expect.objectContaining({
        routeKey: SAVE_RATE,
        units: [RATING_UNIT],
        scope: { keys: { siteid: 'tenant-a', userid: 'U1', contentid: 'C1' } },
        requestId: 'req-rate',
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

  it.each(['/opt2/admin/communications/x', '/v1/surveys/x'])(
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
