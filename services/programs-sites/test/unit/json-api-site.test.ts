/** JSON API `site` on the composed programs-sites app: legacy envelope and headers, the API site fallback and the token-site check. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ERROR_MAP, LEGACY_JSON_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, mintUserToken } from '@opt2/platform/testing';
import {
  JSON_API_SITE_FIELDS,
  jsonApiBaseUrl,
  jsonApiSiteValues,
  type JsonApiMode,
  type JsonApiSiteValues,
} from '../../src/legacy/json-api-site.js';
import { readBean, type SiteRow } from '../../src/legacy/site-fields.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

/** Headers and body of one injected call. */
interface Call {
  headers?: Record<string, string>;
  payload?: string;
}

// No shared fixture covers `default`; its registry row and its tokens carry this one tenant.
const DEFAULT_SITE = Object.freeze({ siteId: 'default', tenantId: '3f1c2a7e-5b9d-5e04-8a6c-2d7f1e9b0c41' });
const SITES = [DEFAULT_SITE, TENANT_A, TENANT_B] as const;
const ROWS: ReadonlyMap<string, SiteRow> = new Map(
  SITES.map(({ siteId, tenantId }): [string, SiteRow] => [
    siteId,
    { tenant_id: tenantId, siteid: siteId, site: `Site ${siteId}`, domain: `${siteId}.example.test` },
  ]),
);

const SERVER_NAME = 'sites.example.test';
const SERVER_PORT = '8113';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const CSRF_FIELDS = 'csrf_token=T&csrf_token_expires=E';
const SITE_ADMIN_ROLES = ['system-user', 'site-admin'];
// Under an unknown site the entity form answers invalidParameters on both sides; the direct method takes the fallback.
const UNKNOWN_SITE_FIND = '/_api/json/v1/no-such-site/site?method=findOne&entityName=site';
// The routes always carry the site segment, so an absent site arrives empty; legacy serves it from `default` too.
const ABSENT_SITE_FIND = '/_api/json/v1//site?method=findOne&entityName=site';
const INSUFFICIENT = { code: 'invalid_request', message: 'Insufficient Account Permissions' };
// configBean settings the endpoint and the route key read at registration; unset, they take the settings template values.
const LEGACY_SETTINGS_ENV = ['MURA_ADMINSSL', 'MURA_PORT', 'MURA_CONTEXT', 'MURA_ADMINDOMAIN', 'MURA_APPRELOADKEY'];

let t: TestApp;

beforeEach(async () => {
  for (const name of LEGACY_SETTINGS_ENV) vi.stubEnv(name, undefined);
  t = await buildTestApp();
  t.db.respond('SELECT tenant_id, site_id FROM programs_sites.tenant_registry', () =>
    SITES.map(({ siteId, tenantId }) => ({ tenant_id: tenantId, site_id: siteId })),
  );
  // As under forced RLS, a site row is visible only in its own tenant's transaction.
  t.db.respond('FROM "programs_sites"."site" WHERE', (params) => {
    const row = ROWS.get(String(params[1]));
    return row !== undefined && row.tenant_id === params[0] ? [row] : [];
  });
});

afterEach(async () => {
  await t.app.close();
  vi.unstubAllEnvs();
});

/** Injects `call` from the fixed client host. */
function send(method: 'GET' | 'POST', url: string, call: Call = {}) {
  const host = `${SERVER_NAME}:${SERVER_PORT}`;
  return t.app.inject({ method, url, headers: { host, ...call.headers }, payload: call.payload });
}

type Reply = Awaited<ReturnType<typeof send>>;

/** The endpoint legacy builds for the injected host. */
function baseUrl(mode: JsonApiMode, siteId: string): string {
  return jsonApiBaseUrl({
    requestProtocol: 'http',
    adminSSL: false,
    serverName: SERVER_NAME,
    serverPort: `:${SERVER_PORT}`,
    context: '',
    mode,
    siteId,
  });
}

/** The values legacy returns for seeded site `siteId` under its `mode` endpoint. */
function expectedSite(siteId: string, mode: JsonApiMode): JsonApiSiteValues {
  const row = ROWS.get(siteId);
  if (row === undefined) throw new Error(`No seeded site ${siteId}`);
  return jsonApiSiteValues(readBean(row), baseUrl(mode, siteId));
}

/** Headers of a site-admin without S2 whose token names `site` and tenant `tid`. */
async function siteAdminHeaders(site: string, tid: string): Promise<Record<string, string>> {
  const token = await mintUserToken({ sub: `test-site-admin-${site}`, site, tid, roles: SITE_ADMIN_ROLES });
  return { ...(await headersFor('site-admin', { site })), authorization: `Bearer ${token}` };
}

function defaultSiteHeaders(): Promise<Record<string, string>> {
  return siteAdminHeaders(DEFAULT_SITE.siteId, DEFAULT_SITE.tenantId);
}

function dataOf(res: Reply): JsonApiSiteValues {
  return res.json<{ data: JsonApiSiteValues }>().data;
}

/** Whether the request read any `programs_sites.site` row. */
function readAnySite(): boolean {
  return t.db.statements().some((statement) => statement.sql.includes('FROM "programs_sites"."site" WHERE'));
}

describe('findOne', () => {
  it.each([
    ['json', 'json'],
    ['ajax', 'json'],
    ['rest', 'rest'],
  ] as const)(
    'answers an anonymous /_api/%s/v1 findOne of tenant-a with the stored site in the legacy envelope',
    async (family, mode) => {
      const res = await send('GET', `/_api/${family}/v1/tenant-a/site`);
      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual(['apiversion', 'data', 'method']);
      expect(body).toMatchObject({ apiversion: 'v1', method: 'findOne' });
      expect(body).not.toHaveProperty('params');
      const data = body.data as JsonApiSiteValues;
      expect(data).toEqual(expectedSite(TENANT_A.siteId, mode));
      expect(data.links.self).toBe(`${baseUrl(mode, TENANT_A.siteId)}/site`);
      expect(data.entityname).toBe('site');
      const fields = Object.keys(data).filter((key) => key !== 'id' && key !== 'entityname');
      expect(fields.sort()).toEqual([...new Set(JSON_API_SITE_FIELDS)].sort());
    },
  );

  it('ignores a fields selection, the site field list being fixed', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a/site?fields=domain');
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)).toEqual(expectedSite(TENANT_A.siteId, 'json'));
  });
});

describe('API site fallback', () => {
  it.each([
    ['an unregistered path site', UNKNOWN_SITE_FIND],
    ['an empty path site and no siteid', ABSENT_SITE_FIND],
  ])('serves the default site to a default-site token for %s', async (_label, url) => {
    const res = await send('GET', url, { headers: await defaultSiteHeaders() });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data).toEqual(expectedSite(DEFAULT_SITE.siteId, 'json'));
    expect(data.links.entities).toBe(`http://${SERVER_NAME}:${SERVER_PORT}/index.cfm/_api/json/v1/default`);
  });

  it.each([UNKNOWN_SITE_FIND, ABSENT_SITE_FIND])(
    'checks the default fallback site against a tenant-a token on %s and denies it with 403',
    async (url) => {
      const res = await send('GET', url, { headers: await headersFor('site-admin') });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: INSUFFICIENT });
      expect(readAnySite()).toBe(false);
    },
  );
});

describe('response headers', () => {
  it.each([
    ['an anonymous tenant-a findOne', '/_api/json/v1/tenant-a/site', false],
    ['a findOne under an unregistered path site', UNKNOWN_SITE_FIND, true],
    ['a findOne under an empty path site', ABSENT_SITE_FIND, true],
  ])('sends the legacy content type, a body ETag, Generator and HSTS on %s', async (_label, url, asDefaultSite) => {
    const res = await send('GET', url, asDefaultSite ? { headers: await defaultSiteHeaders() } : {});
    expect(res.statusCode).toBe(200);
    // As the legacy oracle answers: the servlet drops the space before charset, and ACF 2023 hash() is SHA-256.
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.headers.etag).toBe(createHash('sha256').update(res.body, 'utf8').digest('hex').toUpperCase());
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
  });
});

describe('token site check', () => {
  it.each([
    ['a siteid parameter', '/_api/json/v1/tenant-a/site?siteid=tenant-b', TENANT_A.tenantId],
    ['the path site', '/_api/json/v1/tenant-b/site', TENANT_A.tenantId],
    ['a siteid parameter, the token tid being tenant-b', '/_api/json/v1/tenant-a/site?siteid=tenant-b', TENANT_B.tenantId],
  ])('denies a tenant-a token naming registered tenant-b in %s with 403 and writes nothing', async (_label, url, tid) => {
    const res = await send('GET', url, { headers: await siteAdminHeaders(TENANT_A.siteId, tid) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: INSUFFICIENT });
    expect(readAnySite()).toBe(false);
    expect(t.db.writes()).toEqual([]);
  });
});

describe('save', () => {
  it('consumes a valid CSRF token, then denies a tenant-a save by a site-admin without S2 as authorization', async () => {
    t.client.csrfValid(true);
    const res = await send('POST', '/_api/json/v1/tenant-a/site', {
      headers: { ...(await headersFor('site-admin')), ...FORM },
      payload: `domain=saved.example.test&${CSRF_FIELDS}`,
    });
    const { status, code, message } = LEGACY_ERROR_MAP.authorization;
    expect(res.statusCode).toBe(401);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', error: INSUFFICIENT });
    expect({ code, message }).toEqual(INSUFFICIENT);
    expect(t.client.requestsTo('identity').map((call) => call.json)).toEqual([
      expect.objectContaining({ token: 'T', context: TENANT_A.siteId }),
    ]);
    expect(t.db.writes()).toEqual([]);
  });
});

describe('delete', () => {
  it.each([
    ['a direct delete method', '/_api/json/v1/tenant-a/site?method=delete&entityName=site&id=tenant-a', {}, 'delete'],
    ['an X-HTTP-Method-Override of DELETE', '/_api/json/v1/tenant-a/site', { 'x-http-method-override': 'DELETE' }, 'invalid'],
  ])(
    'leaves an S2 site.delete by %s to legacy with the legacy 503, consuming, reading and writing nothing',
    async (_label, url, override, reported) => {
      const res = await send('POST', url, {
        headers: { ...(await headersFor('s2')), ...FORM, ...override },
        payload: `id=tenant-a&${CSRF_FIELDS}`,
      });
      const { code, message } = LEGACY_ERROR_MAP.server_error;
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ apiversion: 'v1', method: reported, error: { code, message } });
      expect(t.client.requestsTo('identity')).toEqual([]);
      expect(readAnySite()).toBe(false);
      expect(t.db.writes()).toEqual([]);
    },
  );
});
