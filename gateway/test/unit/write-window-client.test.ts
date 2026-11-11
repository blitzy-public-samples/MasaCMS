// Tests the write-window client alone: scope derivation, the open and complete calls, and the open call's longer bound.
import { LegacyServiceUnavailableError, normaliseRouteKey } from '@opt2/platform/legacy-compat';
import {
  createServiceClient,
  ServiceUnavailableError,
  UnknownServiceError,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import type { InventoryFacts, RouteFacts } from '../../src/cutover/types.js';
import { isLegacyUnavailable } from '../../src/dispatcher/fail-closed.js';
import {
  WINDOW_OPEN_BUDGET_MS,
  WINDOW_OPEN_TIMEOUT_MS,
  WindowOpenError,
  createWriteWindowClient,
  scopeFor,
  type WindowOpenInput,
} from '../../src/dispatcher/write-window.js';
import { sendJson, startHttpDouble, type HttpDouble } from '../helpers/http-double.js';

/** Inventory facts holding only each route's keyScope. */
function factsOf(entries: Record<string, string[]>): InventoryFacts {
  const byRoute = new Map<string, RouteFacts>(
    Object.entries(entries).map(([route, keyScope]) => [
      normaliseRouteKey(route),
      { route, csrfValidation: 'none', writeSet: [], keyScope, sessionEffects: [] },
    ]),
  );
  return { get: (key) => byRoute.get(normaliseRouteKey(key)), routes: () => [...byRoute.keys()] };
}

const FACTS = factsOf({
  'admin:cusers.update': ['siteid', 'userid'],
  'admin:cusers.update{photo}': ['table'],
  'admin:csettings.updatesite': [],
  'fixture:people/persons/{id}/archive@post': ['userid'],
  'page:saverate': ['constructor'],
});

const OPEN: WindowOpenInput = {
  routeKey: 'admin:cusers.update{type=2,action=delete}',
  units: ['people.person'],
  scope: { table: true },
  requestId: 'req-1',
};

/** A ServiceClient whose every call is recorded and answered by `answer`. */
function stubClient(answer: (req: ServiceRequest) => Promise<ServiceResponse>): ServiceClient & { calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const request = async (req: ServiceRequest): Promise<ServiceResponse> => {
    calls.push(req);
    return answer(req);
  };
  return { calls, request: request as ServiceClient['request'], close: async () => undefined };
}

function answer(status: number, body: unknown): () => Promise<ServiceResponse> {
  return async () => ({ status, headers: {}, body });
}

function unavailable(): Promise<never> {
  return Promise.reject(new ServiceUnavailableError('migration', new Error('connect ECONNREFUSED')));
}

describe('scopeFor', () => {
  it.each<[string, string, Record<string, unknown>, Record<string, string>, unknown]>([
    ['a value missing from request and session widens to the table', 'admin:cusers.update', { SiteID: 'tenant-a' }, {}, { table: true }],
    ['request values match keyScope names case-insensitively', 'admin:cusers.update', { SiteID: 'tenant-a', USERID: 'U1' }, {}, { keys: { siteid: 'tenant-a', userid: 'U1' } }],
    ['the session supplies a value the request lacks', 'admin:cusers.update', { userid: 'U1' }, { siteid: 'default' }, { keys: { siteid: 'default', userid: 'U1' } }],
    ['a request value overrides the session value', 'admin:cusers.update', { siteid: 'tenant-b', userid: 'U1' }, { siteid: 'default' }, { keys: { siteid: 'tenant-b', userid: 'U1' } }],
    ['an empty request value falls back to the session', 'admin:cusers.update', { siteid: '', userid: 'U1' }, { siteid: 'default' }, { keys: { siteid: 'default', userid: 'U1' } }],
    ['an empty value on both sides widens to the table', 'admin:cusers.update', { siteid: '', userid: 'U1' }, { siteid: '' }, { table: true }],
    ['a complex request value counts as missing', 'admin:cusers.update', { siteid: ['a'], userid: 'U1' }, {}, { table: true }],
    ['a variant without facts uses its base key', 'admin:cusers.update{type=2,action=delete}', { siteid: 'a', userid: 'U1' }, {}, { keys: { siteid: 'a', userid: 'U1' } }],
    ['a variant with facts uses its own', 'ADMIN:cusers.update{photo}', { siteid: 'a', userid: 'U1' }, {}, { table: true }],
    ['an empty keyScope widens to the table', 'admin:csettings.updatesite', { siteid: 'a' }, {}, { table: true }],
    ['a route without facts widens to the table', 'admin:carch.update', { siteid: 'a' }, {}, { table: true }],
    ['fixture id segments are not variants', 'fixture:people/persons/{id}/archive@post', { userid: 'U9' }, {}, { keys: { userid: 'U9' } }],
    ['inherited object members are not session values', 'page:saverate', {}, {}, { table: true }],
  ])('%s', (_label, routeKey, params, session, expected) => {
    expect(scopeFor(FACTS, routeKey, params, session)).toEqual(expected);
  });

  it('is exposed on the client over its facts', () => {
    const windows = createWriteWindowClient({ client: stubClient(answer(200, {})), facts: FACTS });
    expect(windows.scope('admin:cusers.update', { siteid: 'a', userid: 'U1' }, {})).toEqual({ keys: { siteid: 'a', userid: 'U1' } });
  });
});

describe('open', () => {
  it('posts the input to migration with no user token, bounded by the budget plus the call bound', async () => {
    const client = stubClient(answer(201, { windowId: 'W1', state: 'open', phase: 'executing' }));
    const windows = createWriteWindowClient({ client, facts: FACTS });
    await expect(windows.open(OPEN)).resolves.toEqual({ windowId: 'W1' });
    expect(client.calls).toEqual([
      {
        service: 'migration',
        method: 'POST',
        path: '/internal/v1/windows',
        json: OPEN,
        userToken: null,
        timeoutMs: WINDOW_OPEN_TIMEOUT_MS,
      },
    ]);
    expect([WINDOW_OPEN_BUDGET_MS, WINDOW_OPEN_TIMEOUT_MS]).toEqual([30_000, 40_000]);
  });

  it.each<[string, () => Promise<ServiceResponse>]>([
    ['a 503 refusal', answer(503, { error: { type: 'serviceUnavailable' } })],
    ['a 400 answer', answer(400, {})],
    ['an answer without a window id', answer(201, { state: 'open' })],
    ['an unreachable migration service', unavailable],
  ])('rejects %s with WindowOpenError, a legacy 503 condition', async (_label, reply) => {
    const windows = createWriteWindowClient({ client: stubClient(reply), facts: FACTS });
    const err = await windows.open(OPEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WindowOpenError);
    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(isLegacyUnavailable(err)).toBe(true);
    expect(err).toMatchObject({ routeKey: OPEN.routeKey, surface: 'auto', reason: 'window-unavailable' });
  });

  it('propagates a configuration error unchanged', async () => {
    const missing = new UnknownServiceError('migration');
    const windows = createWriteWindowClient({ client: stubClient(() => Promise.reject(missing)), facts: FACTS });
    await expect(windows.open(OPEN)).rejects.toBe(missing);
  });
});

describe('complete', () => {
  it.each<[string, () => Promise<ServiceResponse>, string]>([
    ['returns closed', answer(200, { state: 'closed' }), 'closed'],
    ['returns import-pending as is', answer(200, { state: 'import-pending' }), 'import-pending'],
    ['returns unknown for an unknown window', answer(200, { state: 'unknown' }), 'unknown'],
    ['maps a state outside the contract to unknown', answer(200, { state: 'open' }), 'unknown'],
    ['maps an empty body to unknown', answer(200, undefined), 'unknown'],
    ['maps a text body to unknown', answer(200, 'Service Unavailable'), 'unknown'],
    ['maps a non-2xx answer to unknown', answer(500, { state: 'closed' }), 'unknown'],
    ['maps an unreachable service to unknown without throwing', unavailable, 'unknown'],
    ['maps any other failure to unknown without throwing', () => Promise.reject(new Error('boom')), 'unknown'],
  ])('%s', async (_label, reply, state) => {
    const client = stubClient(reply);
    const windows = createWriteWindowClient({ client, facts: FACTS });
    await expect(windows.complete('W/1 2', { forwarded: true, legacyStatus: 302 })).resolves.toEqual({ state });
    expect(client.calls).toEqual([
      {
        service: 'migration',
        method: 'POST',
        path: '/internal/v1/windows/W%2F1%202:complete',
        json: { forwarded: true, legacyStatus: 302 },
        userToken: null,
      },
    ]);
  });
});

describe('with the platform service client', () => {
  let double: HttpDouble | undefined;

  afterEach(async () => {
    await double?.close();
    double = undefined;
  });

  it('lets open outlast the client bound while complete stays held to it', async () => {
    double = await startHttpDouble((req, res) => {
      setTimeout(() => {
        if (req.path === '/internal/v1/windows') sendJson(res, 201, { windowId: 'W1', state: 'open', phase: 'executing' });
        else sendJson(res, 200, { state: 'closed' });
      }, 300);
    });
    const client = createServiceClient({
      serviceUrls: { migration: double.url },
      self: 'gateway',
      credentials: { headersFor: async () => ({}) },
      timeoutMs: 100,
    });
    try {
      const windows = createWriteWindowClient({ client, facts: FACTS });
      await expect(windows.open(OPEN)).resolves.toEqual({ windowId: 'W1' });
      await expect(windows.complete('W1', { forwarded: false })).resolves.toEqual({ state: 'unknown' });
      expect(JSON.parse(double.requests[0]?.body.toString('utf8') ?? '')).toEqual(OPEN);
      expect(double.requests[0]?.headers.authorization).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
