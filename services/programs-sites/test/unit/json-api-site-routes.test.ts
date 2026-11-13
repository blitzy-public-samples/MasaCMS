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
import { EnvValidationError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
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
import { SiteColumnTruncationError, type SitesDomain } from '../../src/domain/sites.js';
import type { components } from '../../src/generated/openapi.js';
import { SITE_ERROR_REQUIRED } from '../../src/legacy/validation.js';
import type { ProgramsSitesRepository } from '../../src/repo/repository.js';
import {
  JSON_API_SITE_PATHS,
  JSON_API_SITE_PREFIXES,
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
const ORIGIN_DOMAINS: Readonly<Record<string, string[]>> = {
  default: ['localhost'],
  [TENANT_A.siteId]: ['tenant-a.example.test', 'alias.example.test'],
};
const REGISTRY = ['default', TENANT_A.siteId, TENANT_B.siteId, 'tenant-c', UUID_SITE].map((siteId) => ({
  site_id: siteId,
  tenant_id: tenantIdForSite(siteId),
  domains: ORIGIN_DOMAINS[siteId] ?? [],
}));
const SETTINGS: JsonApiLegacySettings = { adminSSL: false, context: '', appReloadKey: 'appreload', adminDomain: '' };
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

let metadataReads: number;

// Every registry query answers the rows; one bound to a tenant id answers that tenant's row.
const metadataTx: MetadataTx = {
  kind: 'metadata',
  schema: 'programs_sites',
  onCommit: () => undefined,
  query: async <R extends QueryResultRow>(_text: unknown, values?: unknown[]) => {
    const selected = values === undefined ? REGISTRY : REGISTRY.filter((row) => row.tenant_id === values[0]);
    return {
      rows: selected,
      command: 'SELECT',
      rowCount: selected.length,
      oid: 0,
      fields: [],
    } as unknown as QueryResult<R>;
  },
};

const db: TenantDb = {
  schema: 'programs_sites',
  withMetadata: (fn) => {
    metadataReads += 1;
    return fn(metadataTx);
  },
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
    // As app.ts routes them.
    noCasePathPrefixes: JSON_API_SITE_PREFIXES,
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
  metadataReads = 0;
  rows = seededRows();
  repository = {
    readSite: vi.fn<ProgramsSitesRepository['readSite']>(
      async (_tx, siteId) => (rows.get(siteId) ?? null) as StoredSite,
    ),
  };
  sites = {
    listSites: vi.fn<SitesDomain['listSites']>(async () => []),
    readSite: vi.fn<SitesDomain['readSite']>(async () => ({ site: SITE, isNew: 0, extendSets: [], imageSizes: [] })),
    readShellSite: vi.fn<SitesDomain['readShellSite']>(async () => ({ site: { SiteID: SITE.SiteID }, isNew: 0 })),
    updateSite: vi.fn<SitesDomain['updateSite']>(async () => ({ written: true, errors: {}, site: SITE })),
    saveOrderAndDeploy: vi.fn<SitesDomain['saveOrderAndDeploy']>(async () => ({ written: true, sites: [] })),
    hrefDomains: vi.fn<SitesDomain['hrefDomains']>(async () => ({ allowedDomains: [], siteDomain: '' })),
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

type Verb = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'PATCH';

/** A request path in the contract's spelling: no front controller, the API prefix in lower case and no trailing slash. */
function contractPath(url: string): string {
  const path = url.split('?', 1)[0] ?? url;
  return path
    .replace(/^\/index\.cfm(?=\/)/i, '')
    .replace(/^\/(?:_|%5F)api\/(json|ajax|rest)\/v1[^/]*/i, (_lead, family: string) => `/_api/${family.toLowerCase()}/v1`)
    .replace(/(.)\/$/, '$1');
}

/** Injects `call` and checks the answer against the contract. */
async function send(method: Verb, url: string, call: Call = {}) {
  const credentials = call.as === undefined ? {} : await headersAs(call.as, call.site ?? TENANT_A.siteId);
  const res = await app.inject({ method, url, headers: { ...credentials, ...call.headers }, payload: call.payload });
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: contractPath(url),
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
    [{ MURA_ADMINSSL: '' }, { adminSSL: false }],
    [{ MURA_ADMINSSL: '${adminSSL}' }, { adminSSL: false }],
    [{ MURA_PORT: '8080' }, { serverPort: ':8080' }],
    [{ MURA_PORT: '80' }, { serverPort: '' }],
    [{ MURA_PORT: '443' }, { serverPort: '' }],
    [{ MURA_PORT: ' ' }, { serverPort: '' }],
    [{ MURA_PORT: '${cgi.SERVER_PORT}' }, {}],
    [{ MURA_PORT: '{{port}}' }, {}],
    [{ MURA_CONTEXT: '/masa/' }, { context: '/masa' }],
    [{ MURA_CONTEXT: '\\masa\\' }, { context: '\\masa' }],
    [{ MURA_CONTEXT: ' ' }, { context: '' }],
    [{ MURA_CONTEXT: '{{context}}' }, { context: '' }],
    [{ MURA_APPRELOADKEY: 'reloadnow' }, { appReloadKey: 'reloadnow' }],
    [{ MURA_APPRELOADKEY: '' }, { appReloadKey: '' }],
    [{ MURA_ADMINDOMAIN: 'admin.example.test,B.example.test' }, { adminDomain: 'admin.example.test,B.example.test' }],
    [{ MURA_ADMINDOMAIN: 'a.example.test,,b.example.test' }, { adminDomain: 'a.example.test,,b.example.test' }],
    [{ MURA_ADMINDOMAIN: ' ' }, { adminDomain: '' }],
    [{ MURA_ADMINDOMAIN: '${adminDomain}' }, { adminDomain: '' }],
  ])('overrides the template with %j', (env, override) => {
    expect(jsonApiLegacySettings(env)).toStrictEqual({ ...SETTINGS, ...override });
  });

  it.each([
    ['MURA_ADMINSSL', 'maybe'],
    ['MURA_PORT', 'garbage'],
    ['MURA_PORT', '0'],
    ['MURA_PORT', '65536'],
    ['MURA_PORT', ' 8080'],
    ['MURA_CONTEXT', 'masa'],
    ['MURA_CONTEXT', '/ma sa'],
    ['MURA_CONTEXT', '/masa?x'],
    ['MURA_ADMINDOMAIN', 'https://admin.example.test'],
    ['MURA_ADMINDOMAIN', 'admin.example.test:8443'],
    ['MURA_ADMINDOMAIN', 'admin.example.test/admin'],
    ['MURA_ADMINDOMAIN', 'admin.example.test, b.example.test'],
    ['MURA_APPRELOADKEY', 'reload now'],
    ['MURA_APPRELOADKEY', 'reload\u0000'],
  ])('rejects %s=%j with an error naming the variable', (key, value) => {
    expect(() => jsonApiLegacySettings({ [key]: value })).toThrow(EnvValidationError);
    expect(() => jsonApiLegacySettings({ [key]: value })).toThrow(new RegExp(`^  ${key}: `, 'm'));
  });
});

describe('JSON_API_SITE_PATHS', () => {
  it('leads every path under the json, ajax and rest API prefixes, with and without the front controller, and is frozen', () => {
    expect(JSON_API_SITE_PREFIXES).toEqual([
      '/_api/json/v1',
      '/index.cfm/_api/json/v1',
      '/_api/ajax/v1',
      '/index.cfm/_api/ajax/v1',
      '/_api/rest/v1',
      '/index.cfm/_api/rest/v1',
    ]);
    expect(JSON_API_SITE_PATHS).toEqual(JSON_API_SITE_PREFIXES.map((prefix) => `${prefix}*`));
    expect(Object.isFrozen(JSON_API_SITE_PREFIXES)).toBe(true);
    expect(Object.isFrozen(JSON_API_SITE_PATHS)).toBe(true);
  });
});

describe('route declarations', () => {
  it('declare every verb on every path as the public contract operations whose site check the handler runs', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => /^(?:\/index\.cfm)?\/_api\//.test(route.url));
    const expected = new Map<string, Record<string, unknown>>();
    for (const operations of Object.values(OPENAPI.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const fastifyPath = operation['x-opt2-fastify-path'];
        if (method === 'parameters' || typeof fastifyPath !== 'string') continue;
        for (const url of [fastifyPath, `/index.cfm${fastifyPath}`]) {
          const route = {
            method: method.toUpperCase(),
            url,
            transport: operation['x-opt2-transport'],
            public: operation['x-opt2-public'],
            siteCheck: false,
          };
          expected.set(`${route.method} ${url}`, route);
        }
      }
    }
    expect(expected.size).toBe(42);
    expect(declared).toEqual(expect.arrayContaining([...expected.values()]));
    expect(declared).toHaveLength(42);
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

  it('rejects registration under a malformed MURA_ setting of process.env, naming it', async () => {
    vi.stubEnv('MURA_PORT', 'garbage');
    const deps = {
      db,
      repository: repository as unknown as ProgramsSitesRepository,
      sites: { ...sites, emitStateEvents: vi.fn() },
    };
    await expect(registerJsonApiSiteRoutes(app, deps)).rejects.toThrow(/^ {2}MURA_PORT: /m);
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
    ['GET', '?method=findMany', {}, 'findMany'],
    ['GET', '?method=validate', {}, 'validate'],
    ['DELETE', '?method=findAll&entityName=content', {}, 'findAll'],
  ])('%s %s %j is not served here and answers the legacy 503', async (method, query, headers, reported) => {
    const res = await send(method as Verb, `/_api/json/v1/tenant-a/site${query}`, { headers });
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
        { locale: '' },
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
      { locale: '' },
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

  it.each([
    ['a save', '/_api/json/v1/tenant-a/site', 'save'],
    ['a direct save', '/_api/json/v1/tenant-a/site?method=Save&entityName=site&id=tenant-a', 'Save'],
  ])('answers %s of a value longer than its tsettings column 500 server_error under its method', async (_label, url, method) => {
    sites.updateSite.mockRejectedValueOnce(new SiteColumnTruncationError('Site'));
    const res = await send('POST', url, { as: 's2', headers: FORM, payload: `site=${'S'.repeat(300)}&${TOKEN_FIELDS}` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ apiversion: 'v1', method, error: UNAVAILABLE });
  });

  it('lets any other update failure through to the platform error handler', async () => {
    sites.updateSite.mockRejectedValueOnce(new Error('next week is an invalid date or time string.'));
    const res = await send('POST', '/_api/json/v1/tenant-a/site', { as: 's2', headers: FORM, payload: TOKEN_FIELDS });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: UNAVAILABLE });
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
      { locale: '' },
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
      { locale: '' },
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
      { locale: '' },
    );
  });
});

describe('CORS origin echo', () => {
  /** The response's CORS headers, undefined when absent. */
  function corsOf(res: { headers: Record<string, unknown> }) {
    return {
      origin: res.headers['access-control-allow-origin'],
      credentials: res.headers['access-control-allow-credentials'],
    };
  }

  const echo = (origin: string) => ({ origin, credentials: 'true' });
  const none = { origin: undefined, credentials: undefined };

  it.each([
    ['http://localhost:3000', true],
    ['https://sub.localhost', true],
    ['HTTP://LOCALHOST', true],
    ['http://tenant-a.example.test', true],
    ['https://www.alias.example.test:8443', true],
    ['http://evil.example', false],
    ['http://notlocalhost', false],
    ['http://localhost.evil.example', false],
    ['localhost', true],
  ])('GET with Origin %s echoes it with credentials: %s, from one registry read', async (origin, echoed) => {
    metadataReads = 0;
    const res = await send('GET', '/_api/json/v1/tenant-a/site', { headers: { origin } });
    expect(res.statusCode).toBe(200);
    expect(corsOf(res)).toEqual(echoed ? echo(origin) : none);
    expect(metadataReads).toBe(1);
  });

  it('sends neither header without an Origin', async () => {
    const res = await send('GET', '/_api/json/v1/unknown/site');
    expect(res.statusCode).toBe(400);
    expect(corsOf(res)).toEqual(none);
  });

  it.each([
    ['a json save', 'POST', '/_api/json/v1/tenant-a/site', { as: 's2', headers: FORM, payload: TOKEN_FIELDS }, 200],
    ['a rest save', 'POST', '/_api/rest/v1/tenant-a/site', { as: 's2', headers: FORM, payload: 'domain=x.test' }, 200],
    ['an unknown site', 'GET', '/_api/ajax/v1/tenant-a/site?siteid=unknown', {}, 400],
    ['a save without a token', 'POST', '/_api/json/v1/tenant-a/site', { as: 's2', headers: FORM, payload: 'x=1' }, 400],
    ['a body legacy cannot read', 'POST', '/_api/json/v1/tenant-a/site', { headers: JSON_BODY, payload: '[1]' }, 500],
    [
      'a rest save without S2',
      'POST',
      '/_api/rest/v1/tenant-a/site',
      { as: 'site-admin', headers: FORM, payload: 'x=1' },
      401,
    ],
    ['another site', 'GET', '/_api/json/v1/tenant-b/site', { as: 's2' }, 403],
    ['a method not served here', 'GET', '/_api/json/v1/tenant-a/site?method=swagger', {}, 503],
    [
      'a site create',
      'POST',
      '/_api/json/v1/tenant-a/site?method=save&entityName=site',
      { as: 's2', headers: FORM, payload: TOKEN_FIELDS },
      503,
    ],
  ] as const)('echoes an allowed Origin on %s (%s %s)', async (_label, method, url, call, status) => {
    const origin = 'http://localhost:3000';
    const res = await send(method, url, { ...call, headers: { ...('headers' in call ? call.headers : {}), origin } });
    expect(res.statusCode).toBe(status);
    expect(corsOf(res)).toEqual(echo(origin));
  });

  const INVALID_BEARER = { authorization: 'Bearer invalid-test-token' };
  const INVALID_TOKEN = legacyError('invalid', 'Invalid Access Token', 'invalid_token');

  it.each(
    (['json', 'ajax', 'rest'] as const).flatMap((family) =>
      (['GET', 'POST'] as const).flatMap((method) =>
        (
          [
            ['http://localhost:3000', true],
            ['http://evil.example', false],
          ] as const
        ).map(([origin, echoed]) => [family, method, origin, echoed] as const),
      ),
    ),
  )('denies an invalid bearer on %s %s with 401, echoing Origin %s: %s', async (family, method, origin, echoed) => {
    metadataReads = 0;
    const headers = { ...(method === 'POST' ? FORM : {}), ...INVALID_BEARER, origin };
    const payload = method === 'POST' ? TOKEN_FIELDS : undefined;
    const res = await send(method, `/_api/${family}/v1/tenant-a/site`, { headers, payload });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(INVALID_TOKEN);
    expect(corsOf(res)).toEqual(echoed ? echo(origin) : none);
    expect(metadataReads).toBe(1);
    expect(repository.readSite).not.toHaveBeenCalled();
  });

  it.each([
    ['the handler', {}, 500, legacyError('invalid', 'Unhandled Exception', 'server_error')],
    ['an auth denial', INVALID_BEARER, 401, INVALID_TOKEN],
  ])('sends the answer of %s without the echo when the registry read fails', async (_label, headers, status, body) => {
    const read = vi.spyOn(db, 'withMetadata').mockRejectedValueOnce(new Error('registry unavailable'));
    try {
      const origin = 'http://localhost:3000';
      const res = await send('GET', '/_api/json/v1/tenant-a/site', { headers: { ...headers, origin } });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual(body);
      expect(corsOf(res)).toEqual(none);
      expect(read).toHaveBeenCalledTimes(1);
      expect(repository.readSite).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it.each([
    ['admin.example.test', { host: 'admin.example.test:8443' }, 'https://admin.example.test', true],
    [
      'x.test,Admin.example.test',
      { 'x-forwarded-host': 'admin.EXAMPLE.test:8443', host: 'gw' },
      'http://admin.example.test',
      true,
    ],
    ['admin.example.test', { host: 'other.example.test' }, 'http://other.example.test', true],
    ['admin.example.test', { host: 'other.example.test:8080' }, 'http://other.example.test', false],
    ['', { host: 'admin.example.test' }, 'http://admin.example.test', false],
  ])('with adminDomain %j and host headers %j, echoes Origin %s: %s', async (adminDomain, headers, origin, echoed) => {
    await restart({ ...SETTINGS, adminDomain });
    const res = await send('GET', '/_api/json/v1/tenant-a/site', { headers: { ...headers, origin } });
    expect(res.statusCode).toBe(200);
    expect(corsOf(res)).toEqual(echoed ? echo(origin) : none);
  });
});

const TENANT_A_BASE = `${BASE}/json/v1/tenant-a`;
const TENANT_A_FIND_ONE = { apiversion: 'v1', method: 'findOne', data: siteValues(TENANT_A_BASE, 'tenant-a', 'tenant-a.example.test') };
// Oracle ETag of `{"apiversion":"v1","data":"","method":"undefined"}`, the answer of a verb the entity route calls nothing for.
const EMPTY_RESULT_ETAG = 'C518090A00E2AA315DED12599D338246338788AE5AE875FD4C6757E85A945037';
const EMPTY_RESULT = '{"apiversion":"v1","data":"","method":"undefined"}';

/** A paged site collection of `items` under `base`, one page of 1000. */
function collection(base: string, items: unknown[], self: string, overrides: Record<string, unknown> = {}) {
  const count = new Set(items.map((item) => (item as { siteid: string }).siteid)).size;
  const page = count > 0 ? { pageindex: 1, totalpages: 1, startindex: 1, endindex: count } : { pageindex: 0, totalpages: 0, startindex: 0, endindex: 0 };
  return {
    ...page,
    itemsperpage: 1000,
    totalitems: count,
    links: { permissions: `${base}/site/permissions`, properties: `${base}/site/properties`, self, entities: base },
    items,
    entityname: 'site',
    ...overrides,
  };
}

/** The data of a 200 envelope reporting `method`. */
function dataOf(res: { statusCode: number; json: () => unknown }, method: string): Record<string, unknown> {
  expect(res.statusCode).toBe(200);
  const body = res.json() as { method: string; data: Record<string, unknown> };
  expect(body.method).toBe(method);
  return body.data;
}

describe('path, method and case forms', () => {
  it.each([
    ['GET', '/_api/json/v1/tenant-a/site/tenant-a'],
    ['GET', '/_api/json/v1/tenant-a/site/new'],
    ['GET', '/_api/json/v1/tenant-a/site/properties'],
    ['GET', '/_api/json/v1/tenant-a/site/tenant-a/permissions'],
    ['GET', '/_api/json/v1/tenant-a/sites'],
    ['GET', '/_API/JSON/V1/tenant-a/site'],
    ['GET', '/index.cfm/_api/json/v1/tenant-a/site'],
    ['GET', '/INDEX.CFM/_Api/Json/V1/tenant-a/site'],
    ['GET', '/%5Fapi/json/v1/tenant-a/site'],
    ['GET', '/_api/json/v1x/tenant-a/site'],
    ['GET', '/_api/json/v1/tenant-a/site/'],
    ['GET', '/_api/json/v1/tenant-a?method=findOne&entityname=site'],
    ['GET', '/_api/json/v1/tenant-a/findOne?entityname=site'],
    ['GET', '/_api/json/v1/tenant-a?method=site.findMany'],
    ['POST', '/_api/json/v1/tenant-a/site/tenant-a'],
    ['PUT', '/_api/json/v1/tenant-a/site/tenant-a'],
    ['DELETE', '/_api/json/v1/tenant-a/site/tenant-a'],
    ['OPTIONS', '/_api/json/v1/tenant-a/site/tenant-a'],
    ['PATCH', '/_api/json/v1/tenant-a/site/new'],
  ] as const)('%s %s answers the tenant-a findOne as legacy does', async (method, url) => {
    const res = await send(method, url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(TENANT_A_FIND_ONE);
    expect(identity.calls).toEqual([]);
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it.each([
    ['/_api/json/v1/tenant-a/SITE', 'SITE'],
    ['/_api/json/v1/tenant-a?method=findOne&entityname=Site', 'Site'],
  ])('%s reports the entity name as spelled, links staying lowercase', async (url, entityname) => {
    const res = await send('GET', url);
    expect(res.json()).toEqual({ ...TENANT_A_FIND_ONE, data: { ...TENANT_A_FIND_ONE.data, entityname } });
  });

  it.each([
    ['/_api/json/v1/tenant-a/site/x/y/z', 'GET', 200],
    ['/_api/json/v1/tenant-a/site/x/y/z', 'POST', 400],
  ] as const)('%s under %s resolves as the entity route of the path site', async (url, method, status) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(status);
  });

  it.each([
    ['OPTIONS', '/_api/json/v1/tenant-a/site'],
    ['PATCH', '/_api/json/v1/tenant-a/site'],
    ['OPTIONS', '/_api/json/v1/tenant-a/site/tenant-a/permissions'],
  ] as const)('%s %s calls nothing and answers the empty result with method undefined', async (method, url) => {
    const res = await send(method, url);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(EMPTY_RESULT);
    expect(res.headers.etag).toBe(EMPTY_RESULT_ETAG);
    expect(repository.readSite).not.toHaveBeenCalled();
  });

  it.each([
    ['PUT', 400, legacyError('save', 'Invalid CSRF tokens')],
    ['DELETE', 401, legacyError('delete', 'Insufficient Account Permissions')],
  ] as const)('anonymous %s of the entity path answers the %s the method it resolves to raises', async (method, status, body) => {
    const res = await send(method, '/_api/json/v1/tenant-a/site');
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
    expect(identity.calls).toEqual([]);
    expect(sites.updateSite).not.toHaveBeenCalled();
  });
});

describe('HEAD', () => {
  it.each([
    ['/_api/json/v1/tenant-a/site/tenant-a', 200],
    ['/index.cfm/_API/json/v1/tenant-a/SITE/tenant-a', 200],
    ['/_api/json/v1/tenant-a?method=findPermissions&entityname=site&id=x', 200],
    ['/_api/json/v1/tenant-a?method=findMany&entityname=site', 500],
    ['/_api/json/v1', 400],
    ['/_api/json/v1/tenant-a/site/tenant-a?ishuman', 503],
  ])('HEAD %s sends the GET answer status %s and ETag without a body or length', async (url, status) => {
    const get = await send('GET', url);
    const head = await send('HEAD', url);
    expect([get.statusCode, head.statusCode]).toEqual([status, status]);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBeUndefined();
    expect(head.headers.etag).toBe(get.headers.etag);
    expect(head.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(head.headers.generator).toBe('Masa CMS 7.6.1');
  });

  it.each(['/_api/json/v1/tenant-a/site', '/_api/json/v1/tenant-a/site/x/permissions'])(
    'HEAD %s, a verb the entity route calls nothing for, sends the empty result ETag',
    async (url) => {
      const head = await send('HEAD', url);
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers.etag).toBe(EMPTY_RESULT_ETAG);
    },
  );

  it('HEAD of a tenant-b site with a tenant-a token is refused with 403 headers alone', async () => {
    const head = await send('HEAD', '/_api/json/v1/tenant-b/site/tenant-b', { as: 's2' });
    expect(head.statusCode).toBe(403);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBeUndefined();
  });
});

describe('findAll, findMany and findQuery', () => {
  const item = (siteid: string, base = TENANT_A_BASE) => siteValues(base, siteid, `${siteid}.example.test`);
  const self = (query: string) => `${TENANT_A_BASE}/?&${query}`;

  it.each([
    ['?method=findAll&entityname=site', 'findAll', [item('tenant-a')], self('method=findAll&expanddepth=1&entityname=site&pageIndex=1')],
    ['/findAll?entityname=site', 'findAll', [item('tenant-a')], self('expanddepth=1&method=findall&entityname=site&pageIndex=1')],
    ['?method=findAll&entityname=site&siteid=tenant-b', 'findAll', [item('tenant-b')], self('method=findAll&expanddepth=1&siteid=tenant-b&entityname=site&pageIndex=1')],
    ['?method=findAll&entityname=site&contentpoolid=*', 'findAll', [item('tenant-a')], self('method=findAll&expanddepth=1&entityname=site&contentpoolid=*&pageIndex=1')],
    ['?method=findMany&entityname=site&ids=tenant-a,TENANT-A', 'findMany', [item('tenant-a'), item('tenant-a')], self('method=findMany&ids=tenant-a,TENANT-A&expanddepth=1&entityname=site&pageIndex=1')],
    ['?method=findMany&entityname=site&ids=tenant-b', 'findMany', [], self('method=findMany&ids=tenant-b&entityname=site&pageIndex=0')],
    ['?method=findQuery&entityname=site&domain=tenant-a.example.test', 'findQuery', [item('tenant-a')], `${TENANT_A_BASE}/site/?method=findQuery&entityname=site&domain=tenant-a.example.test&pageIndex=1`],
    ['?method=findQuery&entityname=site&domain=nomatch', 'findQuery', [], `${TENANT_A_BASE}/site/?method=findQuery&entityname=site&domain=nomatch&pageIndex=0`],
    ['?method=findQuery&entityname=site&domain=like%5Etenant%25&innerJoin=content', 'findQuery', [item('tenant-a')], `${TENANT_A_BASE}/site/?method=findQuery&entityname=site&domain=like%5Etenant%25&innerJoin=content&pageIndex=1`],
    ['?method=findQuery&entityname=site&domain=NULL', 'findQuery', [], `${TENANT_A_BASE}/site/?method=findQuery&entityname=site&domain=NULL&pageIndex=0`],
  ])('GET %s answers the paged site feed of the scope site', async (query, method, items, link) => {
    const res = await send('GET', `/_api/json/v1/tenant-a${query}`);
    expect(dataOf(res, method)).toEqual(collection(TENANT_A_BASE, items, link));
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it('reads each listed site of the feed in its own tenant', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a?method=findAll&entityname=site&siteid=tenant-b');
    expect(res.statusCode).toBe(200);
    expect(reads()).toEqual([[TENANT_B.tenantId, 'tenant-b']]);
  });

  it('answers countOnly with the count as text', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a?method=findAll&entityname=site&countonly=true');
    expect(res.body).toBe('{"apiversion":"v1","data":{"count":"1"},"method":"findAll"}');
  });

  it('answers a distinct feed as generic beans that link only their entities', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a?method=findAll&entityname=site&distinct=true');
    const data = dataOf(res, 'findAll');
    expect(data).toMatchObject({ entityname: 'bean', totalitems: 1 });
    expect(Object.keys(data.links as object)).toEqual(['self', 'entities']);
    expect(data.items).toEqual([{ ...item('tenant-a'), links: { entities: TENANT_A_BASE } }]);
  });

  it('pages past the rows with blank sites as the query iterator does', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a?method=findAll&entityname=site&pageindex=0&itemsperpage=2');
    const data = dataOf(res, 'findAll');
    expect(data).toMatchObject({ pageindex: 0, itemsperpage: 2, totalpages: 1, totalitems: 1, startindex: -1, endindex: 0 });
    expect(data.items).toEqual([siteValues(TENANT_A_BASE, '', ''), siteValues(TENANT_A_BASE, '', '')]);
    expect(Object.keys(data.links as object)).toEqual(['permissions', 'properties', 'next', 'self', 'entities']);
  });

  it('adds the posted fieldnames of a form body to the self link', async () => {
    const res = await send('POST', '/_api/json/v1/tenant-a?method=findAll&entityname=site', { headers: FORM, payload: 'a=1&B=2&b=3' });
    const data = dataOf(res, 'findAll');
    expect((data.links as { self: string }).self).toMatch(/[?&]fieldnames=A,B(&|$)/);
  });

  it.each([
    ['?method=findMany&entityname=site', 500, legacyError('findMany', 'Unhandled Exception', 'server_error')],
    ['?method=findAll&entityname=site&offset=1', 500, legacyError('findAll', 'Unhandled Exception', 'server_error')],
    ['?method=findAll&entityname=site&sort=-bogus', 500, legacyError('findAll', 'Unhandled Exception', 'server_error')],
    ['?method=findAll&entityname=site&maxitems=-1', 500, legacyError('findAll', 'Unhandled Exception', 'server_error')],
    ['?method=findQuery&entityname=site&bogus=1', 500, legacyError('findQuery', 'Unhandled Exception', 'server_error')],
    ['?method=findQuery&entityname=site&orderno=abc', 500, legacyError('findQuery', 'Unhandled Exception', 'server_error')],
    ['?method=findQuery&entityname=site&tcontent.title=x', 500, legacyError('findQuery', 'Unhandled Exception', 'server_error')],
    ['?method=findQuery&entityname=site&params=x', 500, legacyError('findQuery', 'Unhandled Exception', 'server_error')],
    ['?method=findQuery&entityname=site&changesetid=1', 500, legacyError('findQuery', 'Unhandled Exception', 'server_error')],
    ['?method=findAll&entityname=site&sort=tusers.username', 401, legacyError('findAll', 'Insufficient Account Permissions')],
    ['?method=findQuery&entityname=site&sum=orderno', 503, { apiversion: 'v1', method: 'findQuery', error: UNAVAILABLE }],
    ['?method=findQuery&entityname=site&distinct=true', 503, { apiversion: 'v1', method: 'findQuery', error: UNAVAILABLE }],
    ['?method=findQuery&entityname=site&dbo.tsettings.domain=x', 503, { apiversion: 'v1', method: 'findQuery', error: UNAVAILABLE }],
  ])('GET %s answers %s as the legacy query fails, or the legacy 503 where it is not reproduced', async (query, status, body) => {
    const res = await send('GET', `/_api/json/v1/tenant-a${query}`);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
  });
});

describe('findNew, findProperties and findPermissions', () => {
  it('answers a new site bean seeded with the scope site id', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a?method=findNew&entityname=site');
    expect(dataOf(res, 'findNew')).toEqual(siteValues(TENANT_A_BASE, 'tenant-a', '', 1));
    expect(repository.readSite).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, '', false],
    ['site-admin' as const, '', true],
    ['s2' as const, '&properties=siteid,bogus', true],
  ])('answers the site properties to %s, the table only to an admin', async (as, query, table) => {
    const res = await send('GET', `/_api/json/v1/tenant-a?method=findProperties&entityname=site${query}`, { as });
    const data = dataOf(res, 'findProperties');
    expect(data).toMatchObject({ entityname: 'site', primarykey: 'siteid', displayname: 'site', public: true });
    expect('table' in data).toBe(table);
    expect((data.properties as Array<{ name: string }>).map(({ name }) => name)).toEqual(query === '' ? ['domain', 'siteid'] : ['siteid']);
    expect(data.links).toEqual({
      swagger_json: `${TENANT_A_BASE}/swagger?mode=json&entities=site`,
      endpoint: `${TENANT_A_BASE}/site`,
      swagger_rest: `${TENANT_A_BASE}/swagger?mode=rest&entities=site`,
      self: `${TENANT_A_BASE}/site/properties`,
      entities: TENANT_A_BASE,
    });
  });

  it.each([
    [undefined, { read: true, delete: false, save: false }],
    ['site-admin' as const, { read: true, delete: false, save: false }],
    ['s2' as const, { read: true, delete: true, save: true }],
  ])('answers the site permissions of %s', async (as, permissions) => {
    const res = await send('GET', '/_api/json/v1/tenant-a?method=findPermissions&entityname=site&id=nosuch', { as });
    expect(dataOf(res, 'findPermissions')).toEqual(permissions);
  });

  it.each([
    ['?method=findPermissions&entityname=site', 'findPermissions'],
    ['?method=findProperties&entityname=site&properties=links', 'findProperties'],
  ])('GET %s answers server_error as the legacy method raises', async (query, method) => {
    const res = await send('GET', `/_api/json/v1/tenant-a${query}`);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(legacyError(method, 'Unhandled Exception', 'server_error'));
  });

  it('refuses an ishuman findNew with the legacy 503, the CFML form protection not being rendered here', async () => {
    const res = await send('GET', '/_api/json/v1/tenant-a?method=findNew&entityname=site&ishuman=1');
    expect(res.statusCode).toBe(503);
  });
});

describe('validate', () => {
  const encoded = (value: unknown) => encodeURIComponent(JSON.stringify(value));

  it.each([
    [{ entityname: 'site', siteid: 'admin' }, undefined, { siteid: "The 'SiteID' variable == invalid." }],
    [{ entityname: 'SITE', siteid: ' Tasks ' }, undefined, { siteid: "The 'SiteID' variable == invalid." }],
    [{ entityname: 'site', siteid: 'tenant-b' }, undefined, {}],
    [{ entityname: 'site', siteid: 123 }, undefined, {}],
    [[1], undefined, { invalid: 'Invalid validation request' }],
    [{}, [], { invalid: 'Invalid validation request' }],
    [{ bean: 'site', loadby: 'domain', domain: 'x' }, undefined, {}],
    [{}, { x: 1 }, {}],
  ])('validates data %j with validations %j', async (data, validations, errors) => {
    const query = `&data=${encoded(data)}${validations === undefined ? '' : `&validations=${encoded(validations)}`}`;
    const res = await send('GET', `/_api/json/v1/tenant-a?method=validate&entityname=site${query}`);
    expect(dataOf(res, 'validate')).toEqual(errors);
  });

  it('reads a JSON body data struct as sent', async () => {
    const res = await send('POST', '/_api/json/v1/tenant-a?method=validate&entityname=site', {
      headers: JSON_BODY,
      payload: { data: { entityname: 'site', siteid: 'admin' } },
    });
    expect(dataOf(res, 'validate')).toEqual({ siteid: "The 'SiteID' variable == invalid." });
  });

  it.each([
    ['notjson', undefined, 400, legacyError('validate', 'Invalid parameters')],
    [encoded({ entityname: 'site', siteid: { a: 1 } }), undefined, 500, legacyError('validate', 'Unhandled Exception', 'server_error')],
    [encoded({ bean: 'site', loadby: 'domain' }), undefined, 500, legacyError('validate', 'Unhandled Exception', 'server_error')],
    [encoded({ bean: 'site', loadby: 'orderby' }), undefined, 400, legacyError('validate', 'Invalid parameters')],
    [encoded({}), encoded({ properties: { value: [{ required: true }] }, conditions: {} }), 500, legacyError('validate', 'Unhandled Exception', 'server_error')],
    [encoded({ entityname: 'content' }), undefined, 503, { apiversion: 'v1', method: 'validate', error: UNAVAILABLE }],
    [encoded({}), encoded({ properties: { domain: [{ required: true }] } }), 503, { apiversion: 'v1', method: 'validate', error: UNAVAILABLE }],
  ])('answers data %s with validations %s as status %s', async (data, validations, status, body) => {
    const query = `&data=${data}${validations === undefined ? '' : `&validations=${validations}`}`;
    const res = await send('GET', `/_api/json/v1/tenant-a?method=validate&entityname=site${query}`);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
  });
});

describe('delete', () => {
  it.each([
    ['DELETE', '/_api/json/v1/tenant-a/site', {}],
    ['GET', '/_api/json/v1/tenant-a?method=delete&entityname=site&id=tenant-a', {}],
    ['POST', '/_api/json/v1/tenant-a/site', { headers: { 'x-http-method-override': 'DELETE' } }],
  ] as const)('refuses %s %s by a caller without S2 with authorization before any CSRF check', async (method, url, call) => {
    const res = await send(method, url, { as: 'site-admin', ...call });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(legacyError('delete', 'Insufficient Account Permissions'));
    expect(identity.calls).toEqual([]);
    expect(sites.updateSite).not.toHaveBeenCalled();
  });

  it('answers an S2 json delete without a token as invalidTokens, consuming nothing', async () => {
    const res = await send('DELETE', '/_api/json/v1/tenant-a/site', { as: 's2' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(legacyError('delete', 'Invalid CSRF tokens'));
    expect(identity.calls).toEqual([]);
  });

  it.each([
    ['json', { headers: FORM, payload: TOKEN_FIELDS }, 1],
    ['rest', {}, 0],
  ] as const)('answers an authorised %s delete with the server_error the site bean raises, deleting nothing', async (family, call, consumed) => {
    const res = await send('DELETE', `/_api/${family}/v1/tenant-a/site`, { as: 's2', ...call });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(legacyError('delete', 'Unhandled Exception', 'server_error'));
    expect(identity.calls).toHaveLength(consumed);
    expect(identity.calls.map((consume) => consume.context)).toEqual(consumed === 1 ? ['tenant-a'] : []);
    expect(sites.updateSite).not.toHaveBeenCalled();
    expect(sites.saveOrderAndDeploy).not.toHaveBeenCalled();
  });

  it.each([
    ['?method=delete&entityname=site&id=nosuch', 200, { apiversion: 'v1', data: '', method: 'delete' }],
    ['?method=delete&entityname=site', 500, legacyError('delete', 'Unhandled Exception', 'server_error')],
  ])('answers a direct %s as legacy does without a stored site', async (query, status, body) => {
    const res = await send('GET', `/_api/json/v1/tenant-a${query}`, { as: 's2' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
    expect(identity.calls).toEqual([]);
  });
});
