// cnav.searchsitedata relay and registration against cnav.cfc, searchsitedata.cfm and the admin application gate.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate, type GateDecision } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { cnavScreens } from '@/screens/cnav';
import { CNAV_SEARCHSITEDATA_CONTENT_TYPE, loadSearchSiteData } from '@/screens/cnav/searchsitedata';
import {
  findScreen,
  routeKeyOf,
  type JsonScreen,
  type RawBody,
  type ScreenContext,
  type ScreenRequestBody,
} from '@/screens/registry';
import {
  SEARCH_SITE_DATA_EMPTY_QUERY,
  SEARCH_SITE_DATA_QUERY,
  searchSiteDataEmptyRelay,
  searchSiteDataMatchesRelay,
} from '../../fixtures/strategies-content/cnav';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  noSitesRequest,
  siteAdminRequest,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeCall,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

type Fields = Readonly<Record<string, string>>;
type Relay = typeof searchSiteDataMatchesRelay | typeof searchSiteDataEmptyRelay;

const SERVICE = 'strategies-content';
const PATH = '/v1/raw/cnav/searchsitedata';
const ACTION = { circuit: 'cnav', item: 'searchsitedata' } as const;
const LOGIN_LOCATION = './?muraAction=cLogin.main';
const ALLOW: GateDecision = { kind: 'allow' };

/** Both methods of the service route answering `reply`. */
const routesFor = (reply: FakeReply): FakeRouteTable => ({
  [routeKey('POST', SERVICE, PATH)]: reply,
  [routeKey('GET', SERVICE, PATH)]: reply,
});

/** The URL-encoded body of `fields`, as the header autocomplete posts it. */
function postedBody(fields: Fields): ScreenRequestBody {
  const form = new URLSearchParams(fields);
  return { contentType: 'application/x-www-form-urlencoded', body: new Blob([form.toString()]), form };
}

/** The S2 admin on cnav.searchsitedata with `rc`, posted unless `posted` is false, over `routes`. */
function contextFor(
  rc: Fields,
  routes: FakeRouteTable,
  posted = true,
): ScreenContext & { gateway: FakeGatewayClient } {
  const req = adminS2Request({ ...ACTION, rc });
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes), body: posted ? postedBody(rc) : undefined });
}

/** The relayed bytes. */
function bytesOf(raw: RawBody): Buffer {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(raw.body);
}

/** The `Location` a canned reply carries. */
const locationOf = (reply: FakeReply): string | undefined => reply.headers?.['location'];

/** The circuit's only definition, narrowed to its JSON mode. */
function searchSiteDataScreen(): JsonScreen {
  const [def] = cnavScreens;
  if (def?.mode !== 'json') throw new TypeError('Expected the cnav.searchsitedata JSON screen');
  return def;
}

/** The application gate's redirect to `muraAction`. */
const redirectTo = (muraAction: string): GateDecision => ({
  kind: 'redirect',
  location: expect.stringContaining(`/?muraAction=${muraAction}`),
});

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('loadSearchSiteData', () => {
  it('forwards only searchString and siteid', async () => {
    const ctx = contextFor(
      {
        ...SEARCH_SITE_DATA_QUERY,
        muraAction: 'core:cnav.searchsitedata',
        csrf_token: FIXED_CSRF.token,
        startrow: '11',
        unrelated: 'ignored',
      },
      routesFor(searchSiteDataMatchesRelay),
    );

    await loadSearchSiteData(ctx);

    expect(ctx.gateway.calls).toStrictEqual([
      {
        service: SERVICE,
        method: 'POST',
        path: PATH,
        query: { siteid: SEARCH_SITE_DATA_QUERY.siteid },
        form: { searchString: SEARCH_SITE_DATA_QUERY.searchString },
      },
    ]);
  });

  it.each<[string, boolean, Fields, Pick<FakeCall, 'method' | 'query' | 'form'>]>([
    [
      'a posted searchString',
      true,
      { searchString: 'tenant' },
      { method: 'POST', query: { siteid: 'default' }, form: { searchString: 'tenant' } },
    ],
    [
      'a posted empty searchString',
      true,
      { searchString: '' },
      { method: 'POST', query: { siteid: 'default' }, form: { searchString: '' } },
    ],
    ['no posted searchString', true, {}, { method: 'POST', query: { siteid: 'default' }, form: {} }],
    [
      'a URL searchString',
      false,
      { searchString: 'tenant' },
      { method: 'GET', query: { siteid: 'default', searchString: 'tenant' } },
    ],
    [
      'an empty URL searchString',
      false,
      { searchString: '' },
      { method: 'GET', query: { siteid: 'default', searchString: '' } },
    ],
    ['no URL searchString', false, {}, { method: 'GET', query: { siteid: 'default' } }],
    [
      'a searchString in another case',
      true,
      { SEARCHSTRING: 'tenant' },
      { method: 'POST', query: { siteid: 'default' }, form: { searchString: 'tenant' } },
    ],
  ])('forwards %s as present or absent', async (_label, posted, rc, expected) => {
    const ctx = contextFor(rc, routesFor(searchSiteDataEmptyRelay), posted);

    await loadSearchSiteData(ctx);

    expect(ctx.gateway.calls).toStrictEqual([{ service: SERVICE, path: PATH, ...expected }]);
  });

  it.each<[string, Relay]>([
    ['matches', searchSiteDataMatchesRelay],
    ['empty', searchSiteDataEmptyRelay],
  ])('relays the %s answer unchanged', async (_label, relay) => {
    const raw = await loadSearchSiteData(contextFor(SEARCH_SITE_DATA_QUERY, routesFor(relay)));

    expect(raw).toStrictEqual({
      status: relay.status,
      contentType: relay.headers['content-type'],
      body: Buffer.from(relay.body, 'utf8'),
    });
    expect(raw.contentType).toBe(CNAV_SEARCHSITEDATA_CONTENT_TYPE);
    expect(raw.headers?.['location']).toEqual(locationOf(relay));
    expect(bytesOf(raw).toString('utf8')).toBe(relay.body);
  });

  it('answers the legacy content type when the service sends none', async () => {
    const reply: FakeReply = { status: 200, body: searchSiteDataEmptyRelay.body };

    const raw = await loadSearchSiteData(contextFor(SEARCH_SITE_DATA_EMPTY_QUERY, routesFor(reply)));

    expect(raw.contentType).toBe(CNAV_SEARCHSITEDATA_CONTENT_TYPE);
    expect(bytesOf(raw).toString('utf8')).toBe(searchSiteDataEmptyRelay.body);
  });

  it('relays a Location unchanged', async () => {
    const redirect = {
      ...searchSiteDataEmptyRelay,
      status: 302,
      headers: { ...searchSiteDataEmptyRelay.headers, location: LOGIN_LOCATION },
    };

    const raw = await loadSearchSiteData(contextFor(SEARCH_SITE_DATA_QUERY, routesFor(redirect)));

    expect(raw.status).toBe(302);
    expect(raw.headers).toStrictEqual({ location: locationOf(redirect) });
    expect(raw.headers?.['location']).toBe(LOGIN_LOCATION);
  });

  it.each<[number, typeof GatewayDenialError | typeof GatewayUnavailableError]>([
    [401, GatewayDenialError],
    [403, GatewayDenialError],
    [503, GatewayUnavailableError],
  ])('fails on HTTP %i', async (status, errorType) => {
    const ctx = contextFor(SEARCH_SITE_DATA_QUERY, routesFor({ status, body: '' }));

    const error: unknown = await loadSearchSiteData(ctx).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(errorType);
    expect(error).toMatchObject({ service: SERVICE, status });
  });
});

describe('cnavScreens', () => {
  it('registers one strategies-content JSON action', () => {
    const def = searchSiteDataScreen();

    expect(cnavScreens).toHaveLength(1);
    expect(routeKeyOf(def)).toBe('admin:cnav.searchsitedata');
    expect(def).toMatchObject({ circuit: 'cnav', action: 'searchsitedata', mode: 'json', owner: 'strategies-content' });
    expect(def.variant).toBeUndefined();
    expect(def.load).toBe(loadSearchSiteData);
  });

  // The registry is deliberately unmocked here, so this resolves through the real circuit registration.
  it.each([
    ['cnav', 'searchsitedata'],
    ['core:cNav', 'searchSiteData'],
  ])('is the registry screen of %s.%s', (circuit, action) => {
    expect(findScreen(circuit, action, {})).toBe(searchSiteDataScreen());
  });

  it('answers the loaded JSON as is', async () => {
    const def = searchSiteDataScreen();
    const ctx = contextFor(SEARCH_SITE_DATA_QUERY, routesFor(searchSiteDataMatchesRelay));

    const data: unknown = await def.load?.(ctx);
    const raw = await def.json(ctx, data);

    expect(raw).toBe(data);
    expect(raw).toStrictEqual({
      status: searchSiteDataMatchesRelay.status,
      contentType: CNAV_SEARCHSITEDATA_CONTENT_TYPE,
      body: Buffer.from(searchSiteDataMatchesRelay.body, 'utf8'),
    });
  });

  it('has no controller gate', () => {
    expect(searchSiteDataScreen().gate).toBeUndefined();
  });

  it.each<[string, () => AdminRequest, GateDecision]>([
    ['anonymous', () => anonymousRequest(ACTION), ALLOW],
    ['the S2 admin', () => adminS2Request(ACTION), ALLOW],
    ['qa_editor', () => editorRequest(ACTION), ALLOW],
    ['a tenant-a site admin', () => siteAdminRequest('tenant-a', ACTION), ALLOW],
    ['a site-less public member', () => noSitesRequest({ s2IsPrivate: false }, ACTION), redirectTo('clogin.logout')],
    ['a site-less private user', () => noSitesRequest({ s2IsPrivate: true }, ACTION), redirectTo('cMessage.noaccess')],
  ])('answers %s with the application gate alone', async (_label, request, expected) => {
    const req = request();

    const decision = await runGate(req, searchSiteDataScreen().gate);

    expect(decision).toEqual(await runGate(req));
    expect(decision).toEqual(expected);
  });
});
