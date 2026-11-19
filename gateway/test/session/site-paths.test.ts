// Web's legacy site-path read through buildApp: the browser's host facts reach legacy, and legacy's first-touch values come back unchanged.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestGateway, webServiceHeaders, type TestGateway } from '../helpers/app.js';

const URL_BASE = '/internal/v1/legacy-site-paths';
const ALL_SITES = { apiSite: 'default', feedSite: 'default', themeSite: 'default', initSite: 'default' };

let gw: TestGateway;

async function read(query: Record<string, string>) {
  return gw.app.inject({ method: 'GET', url: `${URL_BASE}?${new URLSearchParams(query).toString()}`, headers: await webServiceHeaders() });
}

beforeAll(async () => {
  gw = await buildTestGateway();
}, 120_000);

beforeEach(() => {
  gw.legacy.resetSitePaths();
  gw.legacy.failSitePaths();
  gw.legacy.clearRequests();
});

afterAll(async () => {
  await gw?.close();
});

describe('GET /internal/v1/legacy-site-paths', () => {
  it("answers the values legacy kept from the first request, which the gateway neither computes nor caches", async () => {
    const first = await read({ sessionSite: 'default', host: 'a.example.test', forwardedProto: 'https', ...ALL_SITES });
    const later = await read({ sessionSite: 'default', host: 'b.example.test:8080', ...ALL_SITES });
    gw.legacy.resetSitePaths();
    const rebuilt = await read({ sessionSite: 'default', host: 'b.example.test:8080', ...ALL_SITES });

    const kept = {
      restEndpoint: 'https://a.example.test/_api/rest/v1/default',
      feedEndpoint: 'https://a.example.test/_api/feed/v1/default',
      themeAssetPath: '/themes/default',
      initThemeAssetPath: 'https://a.example.test/themes/default',
    };
    expect([first.statusCode, first.json()]).toEqual([200, kept]);
    expect([later.statusCode, later.json()]).toEqual([200, kept]);
    expect(rebuilt.json()).toEqual({
      restEndpoint: 'http://b.example.test:8080/_api/rest/v1/default',
      feedEndpoint: 'http://b.example.test:8080/_api/feed/v1/default',
      themeAssetPath: '/themes/default',
      initThemeAssetPath: 'http://b.example.test:8080/themes/default',
    });
    expect(gw.legacy.sitePathsCalls).toHaveLength(3);
  });

  it.each<[string, Record<string, string>]>([
    ['themeSite', { themeAssetPath: '/themes/default' }],
    ['feedSite', { feedEndpoint: 'http://tenant-a.localhost/_api/feed/v1/tenant-b' }],
  ])('sends a lone %s and the host facts to site.cfm?op=paths, without cookies or credentials', async (param, answer) => {
    const res = await read({ sessionSite: 'tenant-a', host: 'tenant-a.localhost', forwardedProto: 'http', frontEndHttps: 'on', [param]: 'tenant-b' });

    expect([res.statusCode, res.json()]).toEqual([200, answer]);
    const [call] = gw.legacy.sitePathsCalls;
    expect(call?.request.url).toBe(`/gateway/legacy-bridge/cfml/site.cfm?op=paths&siteid=tenant-a&${param}=tenant-b`);
    expect(call?.request.headers).toMatchObject({
      host: 'tenant-a.localhost',
      'x-forwarded-proto': 'http',
      'front-end-https': 'on',
      'user-agent': 'opt2-legacy-bridge-bot',
    });
    expect(call?.request.headers.cookie).toBeUndefined();
    expect(call?.request.headers.authorization).toBeUndefined();
    expect(call?.request.headers['x-serverless-authorization']).toBeUndefined();
    expect(call?.body).toMatchObject(answer);
  });

  it.each<[string, Record<string, string>]>([
    ['no session site', { host: 'localhost', themeSite: 'default' }],
    ['an empty session site', { sessionSite: '', host: 'localhost', themeSite: 'default' }],
    ['no host', { sessionSite: 'default', themeSite: 'default' }],
    ['a host with a space', { sessionSite: 'default', host: 'local host', themeSite: 'default' }],
    ['a header value with a line break', { sessionSite: 'default', host: 'localhost', forwardedProto: 'https\r\nX-Evil: 1', themeSite: 'default' }],
    ['no site named', { sessionSite: 'default', host: 'localhost' }],
  ])('answers 400 for %s, reaching nothing', async (_case, query) => {
    const res = await read(query);

    expect(res.statusCode).toBe(400);
    expect(gw.legacy.requests).toHaveLength(0);
  });

  it('answers the legacy 503 when the bridge answers without a value', async () => {
    gw.legacy.failSitePaths(200);

    const res = await read({ sessionSite: 'default', host: 'localhost', themeSite: 'default' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});
