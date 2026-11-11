/** Settings, declarations, legacy envelopes, CSRF consume, auth denials and fallbacks of the JSON API `site` routes. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { LEGACY_JSON_CONTENT_TYPE, etag } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  tenantIdForSite,
  type MetadataTx,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  authHeadersFor,
  mintUserToken,
  testVerifier,
  writeTestSecrets,
} from '@opt2/platform/testing';
import type { SitesDomain } from '../../src/domain/sites.js';
import type { components } from '../../src/generated/openapi.js';
import { SITE_ERROR_REQUIRED } from '../../src/legacy/validation.js';
import type { ProgramsSitesRepository } from '../../src/repo/repository.js';
import {
  JSON_API_SITE_PATHS,
  jsonApiLegacySettings,
  registerJsonApiSiteRoutes,
  type JsonApiLegacySettings,
} from '../../src/routes/json-api-site.js';

type ContractOperation = Record<string, unknown>;
type StoredSite = Awaited<ReturnType<ProgramsSitesRepository['readSite']>>;
type Subject = 's2' | 'site-admin';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const UUID_SITE = 'C0FFEE00-1234-5678-9ABCDEF012345678';
const REGISTRY = ['default', TENANT_A.siteId, TENANT_B.siteId, 'tenant-c', UUID_SITE].map((siteId) => ({
  site_id: siteId,
  tenant_id: tenantIdForSite(siteId),
}));
const SETTINGS: JsonApiLegacySettings = { adminSSL: false, context: '', appReloadKey: 'appreload' };
const BASE = 'http://localhost/index.cfm/_api';
const SITE: components['schemas']['Site'] = { SiteID: 'tenant-a', Site: 'Tenant A' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'content-type': 'application/json' };
const TOKEN_FIELDS = 'csrf_token=T&csrf_token_expires=E';
const UNAVAILABLE = { message: 'Unhandled Exception', code: 'server_error' };

/** Stub identity recording each CSRF consume call and answering it with `valid`. */
interface StubIdentity {
  server: Server;
  url: string;
  valid: boolean;
  status: number;
  calls: Array<Record<string, unknown>>;
}

/** One injected request: who sends it, extra headers and the body. */
interface Call {
  as?: Subject;
  site?: string;
  headers?: Record<string, string>;
  payload?: string | Record<string, unknown>;
}

let stateDir: string;
let identity: StubIdentity;
let app: FastifyInstance;
let rows: Map<string, Record<string, unknown>>;
let repository: { readSite: Mock<ProgramsSitesRepository['readSite']> };
let sites: { [K in Exclude<keyof SitesDomain, 'emitStateEvents'>]: Mock<SitesDomain[K]> };

const metadataTx: MetadataTx = {
  kind: 'metadata',
  schema: 'programs_sites',
  onCommit: () => undefined,
  query: async <R extends QueryResultRow>() =>
    ({ rows: REGISTRY, command: 'SELECT', rowCount: REGISTRY.length, oid: 0, fields: [] }) as unknown as QueryResult<R>,
};

const db: TenantDb = {
  schema: 'programs_sites',
  withMetadata: (fn) => fn(metadataTx),
  withTenant: (tenantId, fn) => {
    const tx: TenantTx = {
      kind: 'tenant',
      tenantId,
      schema: 'programs_sites',
      onCommit: () => undefined,
      query: () => Promise.reject(new Error('the recording repository runs no SQL')),
    };
    return fn(tx);
  },
  end: async () => undefined,
};

function seededRows(): Map<string, Record<string, unknown>> {
  return new Map(
    ['default', TENANT_A.siteId, TENANT_B.siteId, UUID_SITE].map((siteid) => [
      siteid,
      { siteid, site: `Site ${siteid}`, domain: `${siteid.toLowerCase()}.example.test` },
    ]),
  );
}

async function startIdentity(): Promise<StubIdentity> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stub: StubIdentity = { server, url, valid: true, status: 200, calls: [] };
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      stub.calls.push({ path: req.url, ...(JSON.parse(body) as Record<string, unknown>) });
      res.writeHead(stub.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ valid: stub.valid }));
    });
  });
  return stub;
}

async function startApp(legacy: JsonApiLegacySettings | undefined): Promise<FastifyInstance> {
  const service = await createService({
    name: 'programs-sites',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8113',
      OPT2_SERVICE_NAME: 'programs-sites',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_SERVICE_URLS: JSON.stringify({ identity: identity.url }),
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('programs-sites'),
    pool: db,
    logger: createLogger({
      service: 'programs-sites',
      version: '1.0.0',
      env: 'local',
      destination: { write: () => undefined },
    }),
  });
  await registerJsonApiSiteRoutes(service, {
    db,
    repository: repository as unknown as ProgramsSitesRepository,
    sites: { ...sites, emitStateEvents: vi.fn() },
    legacy,
  });
  await service.ready();
  return service;
}

async function restart(legacy: JsonApiLegacySettings | undefined): Promise<void> {
  await app.opt2.shutdown();
  app = await startApp(legacy);
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-json-api-site-'));
  await writeTestSecrets(stateDir);
  identity = await startIdentity();
});

afterAll(async () => {
  await new Promise((resolve) => identity.server.close(resolve));
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  identity.valid = true;
  identity.status = 200;
  identity.calls.length = 0;
  rows = seededRows();
  repository = {
    readSite: vi.fn<ProgramsSitesRepository['readSite']>(
      async (_tx, siteId) => (rows.get(siteId) ?? null) as StoredSite,
    ),
  };
  sites = {
    listSites: vi.fn<SitesDomain['listSites']>(async () => []),
    readSite: vi.fn<SitesDomain['readSite']>(async () => ({ site: SITE, isNew: 0, extendSets: [], imageSizes: [] })),
    updateSite: vi.fn<SitesDomain['updateSite']>(async () => ({ written: true, errors: {}, site: SITE })),
    saveOrderAndDeploy: vi.fn<SitesDomain['saveOrderAndDeploy']>(async () => ({ written: true, sites: [] })),
  };
  app = await startApp(SETTINGS);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.opt2.shutdown();
});

async function headersAs(name: Subject, site: string): Promise<Record<string, string>> {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new Error(`No role subject ${name}`);
  return authHeadersFor(subject, { audience: 'programs-sites', site });
}

/** Injects `call` and checks the answer against the contract. */
async function send(method: 'GET' | 'POST', url: string, call: Call = {}) {
  const credentials = call.as === undefined ? {} : await headersAs(call.as, call.site ?? TENANT_A.siteId);
  const res = await app.inject({ method, url, headers: { ...credentials, ...call.headers }, payload: call.payload });
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

/** The tenant and site of each repository read, in order. */
function reads(): Array<[string, string]> {
  return repository.readSite.mock.calls.map(([tx, siteId]) => [tx.tenantId, siteId]);
}

function siteValues(base: string, siteid: string, domain: string, isnew: 0 | 1 = 0) {
  const links = {
    entities: base,
    all: `${base}/site`,
    properties: `${base}/site/properties`,
    self: `${base}/site`,
    permissions: `${base}/site/${siteid}/permissions`,
  };
  return { links, domain, siteid, isnew, id: siteid, entityname: 'site' };
}

function legacyError(method: string, message: string, code = 'invalid_request') {
  return { apiversion: 'v1', method, error: { message, code } };
}

describe('jsonApiLegacySettings', () => {
  it('takes the settings template values when no MURA_ variable is set', () => {
    expect(jsonApiLegacySettings({})).toStrictEqual(SETTINGS);
  });

  it.each([
    [{ MURA_ADMINSSL: 'true' }, { adminSSL: true }],
    [{ MURA_ADMINSSL: 'Yes' }, { adminSSL: true }],
    [{ MURA_ADMINSSL: '0' }, { adminSSL: false }],
    [{ MURA_ADMINSSL: 'maybe' }, { adminSSL: false }],
    [{ MURA_ADMINSSL: '${adminSSL}' }, { adminSSL: false }],
    [{ MURA_PORT: '8080' }, { serverPort: ':8080' }],
    [{ MURA_PORT: '80' }, { serverPort: '' }],
    [{ MURA_PORT: '443' }, { serverPort: '' }],
    [{ MURA_PORT: ' ' }, { serverPort: '' }],
    [{ MURA_PORT: '${cgi.SERVER_PORT}' }, {}],
    [{ MURA_PORT: '{{port}}' }, {}],
    [{ MURA_CONTEXT: '/masa/' }, { context: '/masa' }],
    [{ MURA_CONTEXT: '\\masa\\' }, { context: '\\masa' }],
    [{ MURA_CONTEXT: '{{context}}' }, { context: '' }],
    [{ MURA_APPRELOADKEY: 'reloadnow' }, { appReloadKey: 'reloadnow' }],
  ])('overrides the template with %j', (env, override) => {
    expect(jsonApiLegacySettings(env)).toStrictEqual({ ...SETTINGS, ...override });
  });
});

describe('JSON_API_SITE_PATHS', () => {
  it('names the site entity path of the json, ajax and rest families and is frozen', () => {
    expect(JSON_API_SITE_PATHS).toEqual([
      '/_api/json/v1/:siteid/site',
      '/_api/ajax/v1/:siteid/site',
      '/_api/rest/v1/:siteid/site',
    ]);
    expect(Object.isFrozen(JSON_API_SITE_PATHS)).toBe(true);
  });
});

describe('route declarations', () => {
  it('declare GET and POST on every path as the public contract operations whose site check the handler runs', () => {
    const declared = collectRouteMatrix(app).routes;
    const expected = Object.entries(OPENAPI.paths)
      .filter(([template]) => template.endsWith('/site'))
      .flatMap(([template, operations]) =>
        Object.entries(operations)
          .filter(([method]) => method !== 'parameters')
          .map(([method, operation]) => ({
            method: method.toUpperCase(),
            url: template.replace('{siteid}', ':siteid'),
            transport: operation['x-opt2-transport'],
            public: operation['x-opt2-public'],
            siteCheck: false,
          })),
      );
    expect(expected).toHaveLength(6);
    expect(declared.filter((route) => route.url.startsWith('/_api/'))).toEqual(expect.arrayContaining(expected));
    expect(declared.filter((route) => route.url.startsWith('/_api/'))).toHaveLength(6);
  });
});

describe('findOne', () => {
  it.each([
    ['json', 'json'],
    ['ajax', 'json'],
    ['rest', 'rest'],
  ])(
    'GET /_api/%s/v1/tenant-a/site answers the site envelope with links under the %s endpoint',
    async (family, mode) => {
      const res = await send('GET', `/_api/${family}/v1/tenant-a/site`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        apiversion: 'v1',
        method: 'findOne',
        data: siteValues(`${BASE}/${mode}/v1/tenant-a`, 'tenant-a', 'tenant-a.example.test'),
      });
      expect(res.headers).toMatchObject({
        'content-type': LEGACY_JSON_CONTENT_TYPE,
        etag: etag(res.body),
        generator: 'Masa CMS 7.6.1',
        'strict-transport-security': 'max-age=1200',
      });
      expect(res.headers.etag).toMatch(/^[0-9A-F]{64}$/);
      expect(reads()).toEqual([[TENANT_A.tenantId, 'tenant-a']]);
      expect(sites.updateSite).not.toHaveBeenCalled();
    },
  );

  it('reads in the token tenant, not the registry tenant, for a signed-in caller', async () => {
    const userToken = await mintUserToken({
      sub: 'test-pooled',
      site: TENANT_A.siteId,
      tid: TENANT_UMBRELLA.tenantId,
      roles: ['system-user'],
    });
    const headers = { ...(await headersAs('site-admin', TENANT_A.siteId)), authorization: `Bearer ${userToken}` };
    const res = await send('GET', '/_api/json/v1/tenant-a/site', { headers });
    expect(res.statusCode).toBe(200);
    expect(reads()).toEqual([[TENANT_UMBRELLA.tenantId, 'tenant-a']]);
  });

  it.each([
    ['GET', '?method=findOne&entityName=site', 'findOne'],
    ['GET', '?method=FINDONE&entityName=site', 'FINDONE'],
    ['GET', '?method=site.findAll', 'findOne'],
    ['GET', '?method=site.properties', 'findOne'],
    ['POST', '?method=site.save', 'findOne'],
  ])('%s with %s resolves to findOne and reports method %s', async (method, query, reported) => {
    const res = await send(method as 'GET' | 'POST', `/_api/json/v1/tenant-a/site${query}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: reported,
      data: siteValues(`${BASE}/json/v1/tenant-a`, 'tenant-a', 'tenant-a.example.test'),
    });
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it('reports the site id as the path spells it and links from the registered id', async () => {
    const res = await send('GET', '/_api/json/v1/TENANT-A/site');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findOne',
      data: siteValues(`${BASE}/json/v1/tenant-a`, 'TENANT-A', 'tenant-a.example.test'),
    });
    expect(reads()).toEqual([[TENANT_A.tenantId, 'tenant-a']]);
  });

  it('answers the defaulted new site for a registered site without a stored row', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-c/site');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findOne',
      data: siteValues(`${BASE}/json/v1/tenant-c`, 'tenant-c', '', 1),
    });
  });

  it('reads the site a direct call names in siteid, under the path site endpoint', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a/site?method=findOne&entityName=site&siteid=tenant-b');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findOne',
      data: siteValues(`${BASE}/json/v1/tenant-a`, 'tenant-b', 'tenant-b.example.test'),
    });
    expect(reads()).toEqual([[TENANT_B.tenantId, 'tenant-b']]);
  });

  it('serves the default site to a direct call under an unregistered path site', async () => {
    const res = await send('GET', '/_api/json/v1/unknown/site?method=findOne&entityName=site');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findOne',
      data: siteValues(`${BASE}/json/v1/default`, 'default', 'default.example.test'),
    });
  });

  it('moves the data keys to the top level when useDataNamespace is false and ignores a field list', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a/site?useDataNamespace=false&fields=domain&fields=site');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findOne',
      ...siteValues(`${BASE}/json/v1/tenant-a`, 'tenant-a', 'tenant-a.example.test'),
    });
  });

  it.each([
    [{ 'x-forwarded-proto': 'HTTPS' }, 'https://localhost'],
    [{ 'front-end-https': 'yes' }, 'https://localhost'],
    [{ 'front-end-https': 'maybe' }, 'http://localhost'],
    [{ 'x-forwarded-host': 'client.example.test:8443' }, 'http://client.example.test:8443'],
    [{ 'x-forwarded-host': 'a.example.test:80, b.example.test' }, 'http://a.example.test'],
    [{ host: '[::1]:8080' }, 'http://[::1]:8080'],
  ])('builds the endpoint of request headers %j on %s', async (headers, origin) => {
    const res = await send('GET', '/_api/json/v1/tenant-a/site', { headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { links: { entities: `${origin}/index.cfm/_api/json/v1/tenant-a` } } });
  });

  it.each([
    [{ ...SETTINGS, adminSSL: true }, {}, 'https://localhost/index.cfm'],
    [{ ...SETTINGS, serverPort: ':9090', context: '/masa' }, {}, 'http://localhost:9090/masa/index.cfm'],
    [{ ...SETTINGS, serverPort: '' }, { host: 'localhost:8113' }, 'http://localhost/index.cfm'],
  ])('builds the endpoint of settings %j and headers %j on %s', async (legacy, headers, prefix) => {
    await restart(legacy);
    const res = await send('GET', '/_api/json/v1/tenant-a/site', { headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { links: { entities: `${prefix}/_api/json/v1/tenant-a` } } });
  });

  it('defaults to the MURA_ settings of process.env, the reload key included', async () => {
    vi.stubEnv('MURA_ADMINSSL', 'true');
    vi.stubEnv('MURA_PORT', '8443');
    vi.stubEnv('MURA_CONTEXT', '/masa');
    vi.stubEnv('MURA_APPRELOADKEY', 'reloadnow');
    await restart(undefined);
    const read = await send('GET', '/_api/json/v1/tenant-a/site?appreload');
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      data: { links: { entities: 'https://localhost:8443/masa/index.cfm/_api/json/v1/tenant-a' } },
    });
    const reload = await send('GET', '/_api/json/v1/tenant-a/site?reloadnow');
    expect(reload.statusCode).toBe(503);
    expect(repository.readSite).toHaveBeenCalledTimes(1);
  });
});

describe('resolution errors', () => {
  it.each([
    ['GET', '?siteid=unknown', {}, 400, legacyError('invalid', 'Invalid parameters')],
    ['GET', '?method=method', {}, 400, legacyError('method', 'Invalid method call')],
    ['GET', '?method=1x.findOne', {}, 400, legacyError('findOne', 'Invalid reference to persisted entity')],
    ['GET', '?muraPointInTime=now', {}, 500, legacyError('invalid', 'Unhandled Exception', 'server_error')],
    [
      'POST',
      '',
      { headers: JSON_BODY, payload: '[1]' },
      500,
      legacyError('invalid', 'Unhandled Exception', 'server_error'),
    ],
  ])('%s %s answers the legacy error envelope', async (method, query, call, status, body) => {
    const res = await send(method as 'GET' | 'POST', `/_api/json/v1/tenant-a/site${query}`, call);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
    expect(repository.readSite).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '?appreload', {}, 'invalid'],
    ['GET', '?method=findOne', {}, 'findOne'],
    ['GET', '?method=findOne&entityName=content', {}, 'findOne'],
    ['GET', '?method=swagger', {}, 'swagger'],
    ['POST', '', { 'x-http-method-override': 'DELETE' }, 'invalid'],
  ])('%s %s %j is not served here and answers the legacy 503', async (method, query, headers, reported) => {
    const res = await send(method as 'GET' | 'POST', `/_api/json/v1/tenant-a/site${query}`, { headers });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ apiversion: 'v1', method: reported, error: UNAVAILABLE });
    expect(repository.readSite).not.toHaveBeenCalled();
  });

  it.each([
    ['an anonymous caller', undefined],
    ['a default-site token', 'default'],
  ])(
    'lets an unregistered path site select the default API for %s, then answers invalidParameters',
    async (_label, site) => {
      const res = await send('GET', '/_api/json/v1/unknown/site', site === undefined ? {} : { as: 's2', site });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual(legacyError('invalid', 'Invalid parameters'));
    },
  );
});

describe('site checks', () => {
  it.each([
    ['GET', '/_api/json/v1/tenant-b/site', {}],
    ['GET', '/_api/json/v1/tenant-a/site?siteid=tenant-b', {}],
    ['GET', '/_api/json/v1/unknown/site', {}],
    ['POST', '/_api/json/v1/tenant-a/site', { headers: FORM, payload: `siteid=tenant-b&${TOKEN_FIELDS}` }],
    ['POST', '/_api/json/v1/tenant-a/site', { headers: JSON_BODY, payload: { siteid: 'tenant-b' } }],
  ])('deny a tenant-a token %s %s %j that addresses another site with 403', async (method, url, call) => {
    const res = await send(method as 'GET' | 'POST', url, { as: 's2', ...call });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(legacyError('invalid', 'Insufficient Account Permissions'));
    expect(repository.readSite).not.toHaveBeenCalled();
    expect(identity.calls).toEqual([]);
    expect(sites.updateSite).not.toHaveBeenCalled();
  });
});

describe('save', () => {
  const posted = {
    domain: 'saved.example.test',
    csrf_token: 'T',
    csrf_token_expires: 'E',
    method: 'undefined',
    siteid: 'tenant-a',
    entityname: 'site',
    id: 'tenant-a',
  };

  it.each([
    ['json', FORM, `domain=saved.example.test&${TOKEN_FIELDS}`],
    ['ajax', { ...FORM, 'x-csrf_token': 'T', 'x-csrf_token_expires': 'E' }, 'domain=saved.example.test'],
  ])(
    'POST /_api/%s/v1/tenant-a/site consumes the token under the site id and answers the reloaded site',
    async (family, headers, payload) => {
      sites.updateSite.mockImplementationOnce(async (_db, _claims, siteId) => {
        rows.set(siteId, { ...rows.get(siteId), domain: 'saved.example.test' });
        return { written: true, errors: {}, site: SITE };
      });
      const res = await send('POST', `/_api/${family}/v1/tenant-a/site`, { as: 's2', headers, payload });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        apiversion: 'v1',
        method: 'save',
        data: {
          ...siteValues(`${BASE}/json/v1/tenant-a`, 'tenant-a', 'saved.example.test'),
          saveerrors: '',
          errors: {},
        },
      });
      expect(identity.calls).toEqual([
        {
          path: '/internal/v1/csrf/consume',
          sessionId: expect.any(String),
          token: 'T',
          expires: 'E',
          context: 'tenant-a',
        },
      ]);
      expect(sites.updateSite).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ site: 'tenant-a', tid: TENANT_A.tenantId, s2: true }),
        'tenant-a',
        posted,
      );
      expect(reads()).toEqual([
        [TENANT_A.tenantId, 'tenant-a'],
        [TENANT_A.tenantId, 'tenant-a'],
      ]);
    },
  );

  it('answers invalidTokens and writes nothing when identity rejects the token', async () => {
    identity.valid = false;
    const res = await send('POST', '/_api/json/v1/tenant-a/site', { as: 's2', headers: FORM, payload: TOKEN_FIELDS });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(legacyError('save', 'Invalid CSRF tokens'));
    expect(identity.calls).toHaveLength(1);
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it.each([
    ['an S2 token without a token', 's2' as const, 'domain=x.example.test'],
    ['an anonymous caller, who has no session', undefined, TOKEN_FIELDS],
  ])('answers invalidTokens without consuming anything for %s', async (_label, as, payload) => {
    const res = await send('POST', '/_api/json/v1/tenant-a/site', { as, headers: FORM, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(legacyError('save', 'Invalid CSRF tokens'));
    expect(identity.calls).toEqual([]);
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it('answers the legacy 503 and writes nothing when identity fails', async () => {
    identity.status = 500;
    const res = await send('POST', '/_api/json/v1/tenant-a/site', { as: 's2', headers: FORM, payload: TOKEN_FIELDS });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: UNAVAILABLE });
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it('consumes the token, then denies a token without S2 with authorization', async () => {
    const res = await send('POST', '/_api/json/v1/tenant-a/site', {
      as: 'site-admin',
      headers: FORM,
      payload: TOKEN_FIELDS,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(legacyError('save', 'Insufficient Account Permissions'));
    expect(identity.calls).toHaveLength(1);
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it('saves over the sessionless REST API for an S2 token without consuming a token', async () => {
    const res = await send('POST', '/_api/rest/v1/tenant-a/site', {
      as: 's2',
      headers: FORM,
      payload: 'domain=saved.example.test',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'save',
      data: {
        ...siteValues(`${BASE}/rest/v1/tenant-a`, 'tenant-a', 'tenant-a.example.test'),
        saveerrors: '',
        errors: {},
      },
    });
    expect(identity.calls).toEqual([]);
    expect(sites.updateSite).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ site: 'tenant-a', s2: true }),
      'tenant-a',
      expect.objectContaining({ domain: 'saved.example.test' }),
    );
  });

  it.each([
    ['an anonymous caller', undefined],
    ['a token without S2', 'site-admin' as const],
  ])('denies a REST save by %s with authorization', async (_label, as) => {
    const res = await send('POST', '/_api/rest/v1/tenant-a/site', {
      as,
      headers: FORM,
      payload: 'domain=x.example.test',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(legacyError('save', 'Insufficient Account Permissions'));
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it.each([
    ['reapplies the posted values', 'domain=posted.example.test', 'posted.example.test', ''],
    [
      'keeps the stored values when the request sets saveErrors',
      'domain=posted.example.test&saveErrors=true',
      'tenant-a.example.test',
      true,
    ],
  ])('answers 403 with the domain errors and %s', async (_label, payload, domain, saveerrors) => {
    sites.updateSite.mockResolvedValueOnce({ written: true, errors: { siteid: SITE_ERROR_REQUIRED }, site: SITE });
    const res = await send('POST', '/_api/rest/v1/tenant-a/site', { as: 's2', headers: FORM, payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'save',
      data: {
        ...siteValues(`${BASE}/rest/v1/tenant-a`, 'tenant-a', domain),
        saveerrors,
        errors: { siteid: SITE_ERROR_REQUIRED },
      },
    });
  });

  it('answers a direct save 200 with the method as requested, errors included', async () => {
    sites.updateSite.mockResolvedValueOnce({ written: true, errors: { siteid: SITE_ERROR_REQUIRED }, site: SITE });
    const res = await send('POST', '/_api/rest/v1/tenant-a/site?method=Save&entityName=site&id=tenant-a', { as: 's2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      apiversion: 'v1',
      method: 'Save',
      data: { errors: { siteid: SITE_ERROR_REQUIRED } },
    });
    expect(sites.updateSite).toHaveBeenCalledWith(
      db,
      expect.anything(),
      'tenant-a',
      expect.objectContaining({ method: 'Save', id: 'tenant-a' }),
    );
  });

  it('flattens the saved site when useDataNamespace is false', async () => {
    const res = await send('POST', '/_api/rest/v1/tenant-a/site', {
      as: 's2',
      headers: FORM,
      payload: 'useDataNamespace=false',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'save',
      ...siteValues(`${BASE}/rest/v1/tenant-a`, 'tenant-a', 'tenant-a.example.test'),
      saveerrors: '',
      errors: {},
    });
  });

  it('passes multipart fields by value and file parts by name', async () => {
    const boundary = 'opt2-json-api-site';
    const payload = [
      `--${boundary}\r\nContent-Disposition: form-data; name="domain"\r\n\r\nsaved.example.test\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="newPlaceholderImg"; filename="placeholder.png"\r\n`,
      'Content-Type: image/png\r\n\r\nPNG\r\n',
      `--${boundary}--\r\n`,
    ].join('');
    const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    const res = await send('POST', '/_api/rest/v1/tenant-a/site', { as: 's2', headers, payload });
    expect(res.statusCode).toBe(200);
    expect(sites.updateSite.mock.calls[0]?.[3]).toMatchObject({
      domain: 'saved.example.test',
      newplaceholderimg: 'placeholder.png',
    });
  });

  it.each([
    ['a direct save without an id', '/_api/json/v1/tenant-a/site?method=save&entityName=site', 'tenant-a', 'save', 0],
    [
      'a direct save of another site id',
      '/_api/json/v1/tenant-a/site?method=save&entityName=site&id=tenant-b',
      'tenant-a',
      'save',
      0,
    ],
    ['the save of a registered site without a row', '/_api/json/v1/tenant-c/site', 'tenant-c', 'invalid', 1],
  ])('answers %s with the legacy 503 before any token is consumed', async (_label, url, site, reported, readCount) => {
    const res = await send('POST', url, { as: 's2', site, headers: FORM, payload: TOKEN_FIELDS });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ apiversion: 'v1', method: reported, error: UNAVAILABLE });
    expect(repository.readSite).toHaveBeenCalledTimes(readCount);
    expect(identity.calls).toEqual([]);
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it('saves a direct call whose id is the site but for case and trailing spaces, under that context', async () => {
    const url = '/_api/json/v1/tenant-a/site?method=save&entityName=site&id=TENANT-A%20';
    const res = await send('POST', url, { as: 's2', headers: FORM, payload: TOKEN_FIELDS });
    expect(res.statusCode).toBe(200);
    expect(identity.calls).toEqual([expect.objectContaining({ context: 'TENANT-A ' })]);
    expect(sites.updateSite).toHaveBeenCalledWith(
      db,
      expect.anything(),
      'tenant-a',
      expect.objectContaining({ id: 'TENANT-A ' }),
    );
  });

  it('saves a uuid-named site through a direct call without an id, consuming the token under context new', async () => {
    const url = `/_api/json/v1/${UUID_SITE}/site?method=save&entityName=site`;
    const res = await send('POST', url, { as: 's2', site: UUID_SITE, headers: FORM, payload: TOKEN_FIELDS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: 'save', data: { siteid: UUID_SITE, id: UUID_SITE } });
    expect(identity.calls).toEqual([expect.objectContaining({ context: 'new' })]);
    expect(sites.updateSite).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ site: UUID_SITE }),
      UUID_SITE,
      expect.anything(),
    );
  });
});
