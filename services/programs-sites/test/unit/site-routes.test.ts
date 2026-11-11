/** Request mapping, CSRF skip semantics and contract shape of the site-settings routes over a recording SitesDomain. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  assertResponseMatchesOpenApi,
  authHeadersFor,
  testVerifier,
  writeTestSecrets,
} from '@opt2/platform/testing';
import type { SitesDomain } from '../../src/domain/sites.js';
import type { components } from '../../src/generated/openapi.js';
import { registerSiteRoutes } from '../../src/routes/sites.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const SITE_PATHS = ['/v1/sites', '/v1/sites/order', '/v1/sites/{siteId}', '/v1/sites/{siteId}/update'];
const SITE_ROW: components['schemas']['SiteListItem'] = {
  siteid: 'tenant-a',
  site: 'Tenant A',
  domain: 'tenant-a.example.test',
  orderno: 1,
  deploy: 1,
  lastDeployment: null,
};
const SITE: components['schemas']['Site'] = { SiteID: 'tenant-a', Site: 'Tenant A' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'content-type': 'application/json' };
const TOKEN_FIELDS = 'csrf_token=T&csrf_token_expires=E';

/** Stub identity recording each CSRF consume call and answering it with `valid`. */
interface StubIdentity {
  server: Server;
  url: string;
  valid: boolean;
  status: number;
  calls: Array<Record<string, unknown>>;
}

let stateDir: string;
let identity: StubIdentity;
let app: FastifyInstance;
let sites: { [K in Exclude<keyof SitesDomain, 'emitStateEvents'>]: Mock<SitesDomain[K]> };

const db: TenantDb = {
  schema: 'programs_sites',
  withTenant: () => Promise.reject(new Error('the recording domain runs no SQL')),
  withMetadata: () => Promise.reject(new Error('the recording domain runs no SQL')),
  end: async () => undefined,
};

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

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-site-routes-'));
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
  sites = {
    listSites: vi.fn<SitesDomain['listSites']>(async () => [SITE_ROW]),
    readSite: vi.fn<SitesDomain['readSite']>(async () => ({ site: SITE, isNew: 0, extendSets: [], imageSizes: [] })),
    updateSite: vi.fn<SitesDomain['updateSite']>(async () => ({ written: true, errors: {}, site: SITE })),
    saveOrderAndDeploy: vi.fn<SitesDomain['saveOrderAndDeploy']>(async () => ({ written: true, sites: [SITE_ROW] })),
  };
  app = await createService({
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
  await registerSiteRoutes(app, { db, sites: { ...sites, emitStateEvents: vi.fn() } });
  await app.ready();
});

afterEach(async () => {
  await app.opt2.shutdown();
});

async function headersAs(name: 's2' | 'site-admin'): Promise<Record<string, string>> {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new Error(`No role subject ${name}`);
  return authHeadersFor(subject, { audience: 'programs-sites', site: 'tenant-a' });
}

/** Injects a request as `as` and checks the answer against the contract. */
async function send(
  method: 'GET' | 'POST',
  url: string,
  as: 's2' | 'site-admin',
  extra: Record<string, string> = {},
  payload?: string | Record<string, unknown>,
) {
  const res = await app.inject({ method, url, headers: { ...(await headersAs(as)), ...extra }, payload });
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

describe('route declarations', () => {
  it('match the contract operations', async () => {
    const declared = collectRouteMatrix(app).routes;
    const expected = SITE_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: template.replace('{siteId}', ':siteId'),
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
          siteCheck: true,
        })),
    );
    expect(expected).toHaveLength(4);
    expect(declared.filter((route) => route.url.startsWith('/v1/sites'))).toEqual(
      expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))),
    );
    expect(declared.filter((route) => route.url.startsWith('/v1/sites'))).toHaveLength(4);
  });
});

describe('GET /v1/sites', () => {
  it.each([
    ['', { sortBy: 'site', sortDirection: undefined }],
    ['?sortBy=bogus&SORTDIRECTION=DESC', { sortBy: 'bogus', sortDirection: 'DESC' }],
    ['?sortBy=', { sortBy: '', sortDirection: undefined }],
    ['?sortBy=site&sortBy=domain', { sortBy: 'site,domain', sortDirection: undefined }],
  ])('passes the sort of %j as rc holds it', async (query, options) => {
    const res = await send('GET', `/v1/sites${query}`, 's2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([SITE_ROW]);
    expect(sites.listSites).toHaveBeenCalledWith(db, expect.objectContaining({ site: 'tenant-a', s2: true }), options);
  });
});

describe('POST /v1/sites/order', () => {
  const order = `orderID=a&orderID=b&orderno=1&orderno=2&deploy=1&deploy=0&sortBy=orderno&${TOKEN_FIELDS}`;

  it('saves the comma lists of repeated fields when the token is valid', async () => {
    const res = await send('POST', '/v1/sites/order', 's2', FORM, order);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: true, sites: [SITE_ROW] });
    expect(sites.saveOrderAndDeploy.mock.calls[0]?.[2]).toEqual({
      sortBy: 'orderno',
      sortDirection: undefined,
      orderno: '1,2',
      orderID: 'a,b',
      deploy: '1,0',
    });
    expect(identity.calls).toEqual([
      expect.objectContaining({ path: '/internal/v1/csrf/consume', token: 'T', expires: 'E', context: 'updatesites' }),
    ]);
  });

  it.each([
    ['a rejected token', order, 1],
    ['no token', 'orderID=a&orderno=1&sortBy=orderno', 0],
  ])('skips the writes on %s and lists the sites', async (_label, payload, consumeCalls) => {
    identity.valid = false;
    const res = await send('POST', '/v1/sites/order', 's2', FORM, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: false, sites: [SITE_ROW] });
    expect(sites.saveOrderAndDeploy).not.toHaveBeenCalled();
    expect(sites.listSites.mock.calls[0]?.[2]).toEqual({ sortBy: 'orderno', sortDirection: undefined });
    expect(identity.calls).toHaveLength(consumeCalls);
  });

  it('answers the legacy 503 and writes nothing when identity fails', async () => {
    identity.status = 500;
    const res = await send('POST', '/v1/sites/order', 's2', FORM, order);
    expect(res.statusCode).toBe(503);
    expect(sites.saveOrderAndDeploy).not.toHaveBeenCalled();
  });

  it('answers invalidParameters for a complex JSON list value', async () => {
    const body = { orderID: ['a'], csrf_token: 'T', csrf_token_expires: 'E' };
    const res = await send('POST', '/v1/sites/order', 's2', JSON_BODY, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(sites.saveOrderAndDeploy).not.toHaveBeenCalled();
  });
});

describe('GET /v1/sites/:siteId', () => {
  it('reads the path site', async () => {
    const res = await send('GET', '/v1/sites/tenant-a', 'site-admin');
    expect(res.statusCode).toBe(200);
    expect(sites.readSite).toHaveBeenCalledWith(db, expect.objectContaining({ site: 'tenant-a' }), 'tenant-a');
  });
});

describe('POST /v1/sites/:siteId/update', () => {
  const url = '/v1/sites/tenant-a/update';

  it('writes nothing and answers the stored site when the token is rejected', async () => {
    identity.valid = false;
    const payload = `siteid=tenant-a&action=Update&site=Renamed&${TOKEN_FIELDS}`;
    const res = await send('POST', url, 'site-admin', FORM, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: false, errors: {}, site: SITE });
    expect(sites.updateSite).not.toHaveBeenCalled();
    expect(identity.calls).toEqual([expect.objectContaining({ context: 'tenant-a' })]);
  });

  it.each([
    [
      'an absent siteid',
      { action: 'Update', site: 'Renamed', useSSL: 1 },
      'tenant-a',
      { action: 'Update', site: 'Renamed', useSSL: '1', siteid: 'tenant-a' },
    ],
    ['an empty siteid', { siteid: '', action: 'Update' }, 'tenant-a', { siteid: 'tenant-a', action: 'Update' }],
    ['a posted SiteID', { SiteID: 'TENANT-A', action: 'Update' }, 'TENANT-A', { SiteID: 'TENANT-A', action: 'Update' }],
  ])('updates with %s resolved as rc.siteID', async (_label, body, context, form) => {
    const res = await send('POST', url, 's2', { ...JSON_BODY, 'x-csrf_token': 'T', 'x-csrf_token_expires': 'E' }, body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: true, errors: {}, site: SITE });
    expect(identity.calls).toEqual([expect.objectContaining({ context })]);
    expect(sites.updateSite).toHaveBeenCalledWith(db, expect.objectContaining({ site: 'tenant-a' }), 'tenant-a', form);
  });

  it('passes multipart file parts by name and lets a foreign branch answer the legacy 503', async () => {
    const boundary = 'opt2-site-routes';
    const fields = { siteid: 'tenant-a', action: 'Update', csrf_token: 'T', csrf_token_expires: 'E' };
    const payload = [
      ...Object.entries(fields).map(
        ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
      `--${boundary}\r\nContent-Disposition: form-data; name="newPlaceholderImg"; filename="placeholder.png"\r\n`,
      'Content-Type: image/png\r\n\r\nPNG\r\n',
      `--${boundary}--\r\n`,
    ].join('');
    const foreign = new LegacyServiceUnavailableError('foreign branch', 'auto', 'foreign-branch');
    sites.updateSite.mockRejectedValueOnce(foreign);
    const res = await send('POST', url, 's2', { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload);
    expect(res.statusCode).toBe(503);
    const form = sites.updateSite.mock.calls[0]?.[3];
    expect(form).toMatchObject({ siteid: 'tenant-a', newPlaceholderImg: 'placeholder.png' });
  });
});
