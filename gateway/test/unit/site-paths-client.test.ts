import { Buffer } from 'node:buffer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_ASSERTION_HEADER, MemoryNonceStore, verifyBridgeAssertion, type BridgeAssertionPayload } from '@opt2/platform/legacy-compat';
import { Agent, SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError, fixedClock } from '@opt2/platform/service-kit';
import {
  createSitePathsClient,
  type LegacyRequestFacts,
  type SitePathsClientOptions,
  type SitePathsQuery,
} from '../../src/session/bridge-client.js';
import { sendBytes, sendJson, startHttpDouble, type HttpDouble, type RecordedRequest } from '../helpers/http-double.js';

const SITE_PAGE = '/gateway/legacy-bridge/cfml/site.cfm';
// A test key, not a secret.
const KEY = 'opt2-site-paths-test-key-0001';
const NOW = new Date('2026-06-30T12:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const SERVER_TIME = '2026-06-30T12:00:00.000';
const ALL: SitePathsQuery = { sessionSite: 'default', apiSite: 'default', feedSite: 'tenant-b', themeSite: 'tenant-a', initSite: 'default' };
const FACTS: LegacyRequestFacts = { host: 'cms.example.test:8443', forwardedProto: 'https', frontEndHttps: 'on' };
const VALUES = {
  restEndpoint: 'https://cms.example.test/_api/rest/v1/default',
  feedEndpoint: 'https://cms.example.test/_api/feed/v1/tenant-b',
  themeAssetPath: '/sites/tenant-a/themes/MyTheme',
  initThemeAssetPath: 'https://cms.example.test/themes/default',
};

let double: HttpDouble;
let dispatcher: Agent;

function client(overrides: Partial<SitePathsClientOptions> = {}) {
  return createSitePathsClient({ legacyOrigin: double.url, hmacKey: KEY, clock: fixedClock(NOW), dispatcher, ...overrides });
}

function claimsOf(req: RecordedRequest | undefined): { assertion: string; claims: BridgeAssertionPayload } {
  const assertion = req?.headers[BRIDGE_ASSERTION_HEADER.toLowerCase()];
  if (typeof assertion !== 'string') throw new TypeError('no bridge assertion sent');
  const [b64 = ''] = assertion.split('.');
  return { assertion, claims: JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as BridgeAssertionPayload };
}

async function failureOf(pending: Promise<unknown>): Promise<ServiceUnavailableError> {
  const error = await pending.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ServiceUnavailableError);
  expect(error).toMatchObject({ service: 'legacy-bridge' });
  return error as ServiceUnavailableError;
}

beforeAll(async () => {
  double = await startHttpDouble((_req, res) => sendJson(res, 200, { ...VALUES, serverTime: SERVER_TIME }));
  dispatcher = new Agent();
});

beforeEach(() => {
  double.setHandler((_req, res) => sendJson(res, 200, { ...VALUES, serverTime: SERVER_TIME }));
  double.clearRequests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await dispatcher.close();
  await double.close();
});

describe('createSitePathsClient', () => {
  it("sends a signed GET to site.cfm?op=paths with the browser's host facts, as the bridge bot without cookies", async () => {
    await expect(client().paths(ALL, FACTS)).resolves.toEqual(VALUES);

    expect(double.requests).toHaveLength(1);
    const [req] = double.requests;
    expect(req?.method).toBe('GET');
    expect(req?.url).toBe(`${SITE_PAGE}?op=paths&siteid=default&apiSite=default&feedSite=tenant-b&themeSite=tenant-a&initSite=default`);
    expect(req?.headers).toMatchObject({
      host: FACTS.host,
      'x-forwarded-proto': 'https',
      'front-end-https': 'on',
      'user-agent': 'opt2-legacy-bridge-bot',
      accept: 'application/json',
    });
    expect(req?.headers.cookie).toBeUndefined();
    expect(req?.body).toHaveLength(0);
    const { assertion, claims } = claimsOf(req);
    const { exp, nonce, ...named } = claims;
    expect(named).toEqual({ aud: 'legacy-bridge', op: 'site.paths', sid: '', sub: '', siteId: 'default' });
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(exp - NOW_SECONDS).toBe(60);
    expect(verifyBridgeAssertion(assertion, KEY, new MemoryNonceStore(), NOW)).toMatchObject({ ok: true });
  });

  it.each<[string, SitePathsQuery, Partial<typeof VALUES>, string]>([
    ['the endpoint alone', { sessionSite: 'default', apiSite: 'tenant-a' }, { restEndpoint: VALUES.restEndpoint }, '&apiSite=tenant-a'],
    ['the feed endpoint alone', { sessionSite: 'tenant-b', feedSite: 'tenant-b' }, { feedEndpoint: VALUES.feedEndpoint }, '&feedSite=tenant-b'],
    [
      'the two theme paths',
      { sessionSite: 'tenant-a', themeSite: 'tenant-a', initSite: 'tenant-a' },
      { themeAssetPath: VALUES.themeAssetPath, initThemeAssetPath: VALUES.initThemeAssetPath },
      '&themeSite=tenant-a&initSite=tenant-a',
    ],
    ['an empty site, which legacy reads as default', { sessionSite: 'default', themeSite: '' }, { themeAssetPath: VALUES.themeAssetPath }, '&themeSite='],
  ])('names and returns only %s', async (_case, query, expected, params) => {
    await expect(client().paths(query, { host: 'localhost' })).resolves.toEqual(expected);

    const [req] = double.requests;
    expect(req?.url).toBe(`${SITE_PAGE}?op=paths&siteid=${encodeURIComponent(query.sessionSite)}${params}`);
    expect(req?.headers.host).toBe('localhost');
    expect(req?.headers['x-forwarded-proto']).toBeUndefined();
    expect(req?.headers['front-end-https']).toBeUndefined();
  });

  it('encodes site ids and keeps a legacy origin path, its trailing slashes dropped', async () => {
    await client({ legacyOrigin: `${double.url}/legacy//` }).paths({ sessionSite: 'a b&c', apiSite: 'd/e' }, { host: 'localhost' });

    expect(double.requests[0]?.url).toBe(`/legacy${SITE_PAGE}?op=paths&siteid=a%20b%26c&apiSite=d%2Fe`);
    expect(claimsOf(double.requests[0]).claims.siteId).toBe('a b&c');
  });

  it('reads values ColdFusion serialised as numbers as text', async () => {
    double.setHandler((_req, res) => sendBytes(res, 200, '{"themeAssetPath":42,"serverTime":"x"}'));

    await expect(client().paths({ sessionSite: 'default', themeSite: 'default' }, FACTS)).resolves.toEqual({ themeAssetPath: '42' });
  });

  it('bounds the call with the service-call timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await client().paths(ALL, FACTS);

    expect(timeout).toHaveBeenCalledWith(SERVICE_CALL_TIMEOUT_MS);
  });

  it.each<{ status: number; body: string; error?: string }>([
    { status: 302, body: '' },
    { status: 400, body: '{"error":"badRequest","message":"siteid is required"}', error: 'badRequest' },
    { status: 403, body: '' },
    { status: 500, body: '{"error":"serverError","message":"expression"}', error: 'serverError' },
  ])('fails closed on HTTP $status', async ({ status, body, error }) => {
    double.setHandler((_req, res) => sendBytes(res, status, body));

    const failure = await failureOf(client().paths(ALL, FACTS));

    expect(failure.cause).toMatchObject({
      message: `legacy bridge site.paths answered HTTP ${String(status)}${error === undefined ? '' : ` ${error}`}`,
      status,
      error,
    });
  });

  it.each([
    ['a missing requested value', '{"restEndpoint":"/r","themeAssetPath":"/themes/default","initThemeAssetPath":"/x"}'],
    ['a null value', '{"restEndpoint":null,"themeAssetPath":"/t","initThemeAssetPath":"/x"}'],
    ['an object value', '{"restEndpoint":{},"themeAssetPath":"/t","initThemeAssetPath":"/x"}'],
    ['a JSON null body', 'null'],
  ])('fails closed on a 2xx with %s', async (_case, body) => {
    double.setHandler((_req, res) => sendBytes(res, 200, body, { 'content-type': 'application/json; charset=utf-8' }));

    const failure = await failureOf(client().paths(ALL, FACTS));

    expect(failure.cause).toMatchObject({ message: 'legacy bridge site.paths answered without a requested value' });
  });

  it('fails closed on a 2xx that is not JSON', async () => {
    double.setHandler((_req, res) => sendBytes(res, 200, '<html>Masa CMS</html>', { 'content-type': 'text/html' }));

    expect((await failureOf(client().paths(ALL, FACTS))).cause).toBeInstanceOf(SyntaxError);
  });

  it('fails closed when nothing answers', async () => {
    const closed = await startHttpDouble(() => undefined);
    await closed.close();

    expect((await failureOf(client({ legacyOrigin: closed.url }).paths(ALL, FACTS))).cause).toMatchObject({ code: 'ECONNREFUSED' });
  });
});
