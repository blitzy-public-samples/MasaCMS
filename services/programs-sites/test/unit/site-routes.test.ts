/** Request mapping, CSRF skip semantics and contract shape of the site-settings routes over a recording SitesDomain. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, collectRouteMatrix } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  assertResponseMatchesOpenApi,
  authHeadersFor,
  mintServiceToken,
  mintUserToken,
  testVerifier,
  writeTestSecrets,
} from '@opt2/platform/testing';
import { createSitesDomain, type SitesDomain } from '../../src/domain/sites.js';
import type { components } from '../../src/generated/openapi.js';
import { createProgramsSitesRepository } from '../../src/repo/repository.js';
import { registerSiteRoutes } from '../../src/routes/sites.js';
import { TEST_CLOCK, createRecordingDb } from '../helpers/app.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const SITE_PATHS = [
  '/v1/sites',
  '/v1/sites/order',
  '/v1/sites/{siteId}',
  '/v1/sites/{siteId}/shell',
  '/v1/sites/{siteId}/user-pool-sites',
  '/v1/sites/{siteId}/update',
  '/v1/href-domains',
];
const SITE_ROW: components['schemas']['SiteListItem'] = {
  siteid: 'tenant-a',
  site: 'Tenant A',
  domain: 'tenant-a.example.test',
  orderno: 1,
  deploy: 1,
  lastDeployment: null,
};
const SITE: components['schemas']['Site'] = { SiteID: 'tenant-a', Site: 'Tenant A' };
const SHELL_SITE: components['schemas']['ShellSite'] = { SiteID: 'tenant-a', Site: 'Tenant A', EmailBroadcaster: 0 };
const DOMAINS: components['schemas']['HrefDomains'] = { allowedDomains: ['localhost', 'alias.example'], siteDomain: 'localhost' };
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
/** Awaited before each service-transport authentication of the current test, when set. */
let authenticateDelay: (() => Promise<void>) | undefined;
/** Log records the service wrote during the current test. */
let logLines: Record<string, unknown>[] = [];
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
  authenticateDelay = undefined;
  logLines = [];
  sites = {
    listSites: vi.fn<SitesDomain['listSites']>(async () => [SITE_ROW]),
    readSite: vi.fn<SitesDomain['readSite']>(async () => ({ site: SITE, isNew: 0, extendSets: [], imageSizes: [] })),
    readShellSite: vi.fn<SitesDomain['readShellSite']>(async () => ({ site: SHELL_SITE, isNew: 0 })),
    readUserPoolSites: vi.fn<SitesDomain['readUserPoolSites']>(async () => ({ sites: [SHELL_SITE] })),
    updateSite: vi.fn<SitesDomain['updateSite']>(async () => ({ written: true, errors: {}, site: SITE })),
    saveOrderAndDeploy: vi.fn<SitesDomain['saveOrderAndDeploy']>(async () => ({ written: true, sites: [SITE_ROW] })),
    hrefDomains: vi.fn<SitesDomain['hrefDomains']>(async () => DOMAINS),
  };
  const verifier = testVerifier('programs-sites');
  const { authenticate } = verifier.transports.service;
  verifier.transports.service.authenticate = async (req, opts) => {
    await authenticateDelay?.();
    return authenticate(req, opts);
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
    verifierOverride: verifier,
    pool: db,
    logger: createLogger({
      service: 'programs-sites',
      version: '1.0.0',
      env: 'local',
      destination: { write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>) },
    }),
  });
  await registerSiteRoutes(app, { db, sites: { ...sites, emitStateEvents: vi.fn() } });
  await app.ready();
});

afterEach(async () => {
  await app.opt2.shutdown();
});

type SubjectName = 's2' | 'site-admin' | 'editor' | 'member' | 'anonymous' | 'service:gateway' | 'service:people';

async function headersAs(name: SubjectName, { site = 'tenant-a', sub }: { site?: string; sub?: string } = {}) {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new Error(`No role subject ${name}`);
  return authHeadersFor(subject, { audience: 'programs-sites', site, sub });
}

/** Injects a request as `as` and checks the answer against the contract. */
async function send(
  method: 'GET' | 'POST',
  url: string,
  as: SubjectName,
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
    const routes = declared.filter((route) => route.url.startsWith('/v1/'));
    expect(expected).toHaveLength(7);
    expect(routes).toEqual(expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))));
    expect(routes).toHaveLength(7);
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
    expect(sites.listSites).toHaveBeenCalledWith(db, expect.objectContaining({ site: 'tenant-a', s2: true }), {
      ...options,
      signal: expect.any(AbortSignal),
    });
    expect(sites.listSites.mock.calls[0]?.[2]?.signal?.aborted).toBe(false);
  });

  it('answers a failed list of a connected client with the legacy 503, as before', async () => {
    sites.listSites.mockRejectedValueOnce(new LegacyServiceUnavailableError());
    const res = await send('GET', '/v1/sites', 's2');
    expect(res.statusCode).toBe(503);
    expect(logLines.find((line) => line.message === 'service unavailable')).toMatchObject({ severity: 'WARNING' });
  });

  it.each([
    ['completes', false],
    ['disconnects first', true],
  ])('over HTTP, aborts the list signal only when the client %s', async (_label, disconnect) => {
    let signal: AbortSignal | undefined;
    let entered!: () => void;
    const listing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    sites.listSites.mockImplementation(
      (_db, _claims, options) =>
        new Promise((resolve, reject) => {
          signal = options?.signal;
          entered();
          if (!disconnect) {
            resolve([SITE_ROW]);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
        }),
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const req = request({ host: '127.0.0.1', port, path: '/v1/sites', headers: await headersAs('s2') });
    const answered = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      req.on('response', (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
    });
    req.end();
    await listing;

    if (disconnect) {
      answered.catch(() => undefined);
      req.destroy();
      await vi.waitFor(() => expect(logLines.map((line) => line.message)).toContain('client closed the request'));
      expect(signal?.aborted).toBe(true);
      expect(logLines.find((line) => line.message === 'client closed the request')).toMatchObject({
        severity: 'INFO',
        route: '/v1/sites',
        httpMethod: 'GET',
        latencyMs: expect.any(Number),
      });
    } else {
      expect(await answered).toEqual({ status: 200, body: JSON.stringify([SITE_ROW]) });
      await vi.waitFor(() => expect(logLines.map((line) => line.message)).toContain('request completed'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(signal?.aborted).toBe(false);
    }
    expect(logLines.filter((line) => line.severity === 'ERROR')).toEqual([]);
  });

  it.each([
    ['completes', false],
    ['disconnects during authentication', true],
  ])('over HTTP, reads every registered tenant only when the client %s', async (_label, disconnect) => {
    const siteIds = Array.from({ length: 74 }, (_, n) => `site-${n}`);
    const recording = createRecordingDb();
    recording.respond(
      'SELECT tenant_id, site_id FROM programs_sites.tenant_registry ORDER BY site_id',
      siteIds.map((siteId) => ({ tenant_id: tenantIdForSite(siteId), site_id: siteId })),
    );
    const domain = createSitesDomain({ repo: createProgramsSitesRepository({ clock: TEST_CLOCK }) });
    let signal: AbortSignal | undefined;
    let abortedOnEntry: boolean | undefined;
    sites.listSites.mockImplementation(async (_db, claims, options) => {
      signal = options?.signal;
      abortedOnEntry = signal?.aborted;
      return domain.listSites(recording, claims, options);
    });
    let authenticating!: () => void;
    let release!: () => void;
    let replyClosed!: () => void;
    const authStarted = new Promise<void>((resolve) => {
      authenticating = resolve;
    });
    const authReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      replyClosed = resolve;
    });
    authenticateDelay = async () => {
      authenticating();
      await authReleased;
    };
    app.server.on('request', (_req, res) => res.once('close', replyClosed));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const req = request({ host: '127.0.0.1', port, path: '/v1/sites', headers: await headersAs('s2') });
    const answered = new Promise<number | undefined>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
    });
    req.end();
    await authStarted;
    const siteReads = () =>
      recording
        .statements()
        .filter((statement) => statement.kind === 'tenant' && statement.sql.startsWith('SELECT * FROM "programs_sites"."site"'));

    if (disconnect) {
      answered.catch(() => undefined);
      req.destroy();
      await closed;
      release();
      await vi.waitFor(() => expect(logLines.map((line) => line.message)).toContain('client closed the request'));
      expect(abortedOnEntry).toBe(true);
      expect(recording.statements()).toEqual([]);
      expect(logLines.find((line) => line.message === 'client closed the request')).toMatchObject({
        severity: 'INFO',
        route: '/v1/sites',
        httpMethod: 'GET',
        latencyMs: expect.any(Number),
      });
    } else {
      release();
      expect(await answered).toBe(200);
      await vi.waitFor(() => expect(logLines.map((line) => line.message)).toContain('request completed'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(abortedOnEntry).toBe(false);
      expect(signal?.aborted).toBe(false);
      expect(new Set(siteReads().map((statement) => statement.tenantId))).toEqual(new Set(siteIds.map((siteId) => tenantIdForSite(siteId))));
    }
    expect(siteReads()).toHaveLength(disconnect ? 0 : siteIds.length);
    expect(logLines.filter((line) => line.severity === 'ERROR')).toEqual([]);
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

  it.each([
    ['an absent orderID', FORM, `orderno=1&deploy=1&sortBy=orderno&${TOKEN_FIELDS}`],
    ['a complex JSON list value', JSON_BODY, { orderID: ['a'], csrf_token: 'T', csrf_token_expires: 'E' }],
  ])('answers invalidParameters for %s before the CSRF check and the writes', async (_label, headers, payload) => {
    const res = await send('POST', '/v1/sites/order', 's2', headers, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(identity.calls).toHaveLength(0);
    expect(sites.saveOrderAndDeploy).not.toHaveBeenCalled();
    expect(sites.listSites).not.toHaveBeenCalled();
  });
});

describe('GET /v1/sites/:siteId', () => {
  it('reads the path site', async () => {
    const res = await send('GET', '/v1/sites/tenant-a', 'site-admin');
    expect(res.statusCode).toBe(200);
    expect(sites.readSite).toHaveBeenCalledWith(db, expect.objectContaining({ site: 'tenant-a' }), 'tenant-a');
  });

  it('refuses an editor, whose role reads only the shell settings', async () => {
    const res = await send('GET', '/v1/sites/tenant-a', 'editor');
    expect(res.statusCode).toBe(403);
    expect(sites.readSite).not.toHaveBeenCalled();
  });
});

describe('GET /v1/sites/:siteId/shell', () => {
  it.each<SubjectName>(['editor', 'site-admin', 's2'])('reads the path site for %s', async (as) => {
    const res = await send('GET', '/v1/sites/tenant-a/shell', as);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ site: SHELL_SITE, isNew: 0 });
    expect(sites.readShellSite).toHaveBeenCalledWith(db, expect.objectContaining({ site: 'tenant-a' }), 'tenant-a');
  });

  it.each<[SubjectName, number]>([
    ['member', 403],
    ['anonymous', 401],
  ])('refuses %s with %i', async (as, status) => {
    const res = await send('GET', '/v1/sites/tenant-a/shell', as);
    expect(res.statusCode).toBe(status);
    expect(sites.readShellSite).not.toHaveBeenCalled();
  });

  it('refuses an editor token for another site', async () => {
    const url = '/v1/sites/tenant-a/shell';
    const res = await app.inject({ method: 'GET', url, headers: await headersAs('editor', { site: 'tenant-b' }) });
    const { statusCode: status, body } = res;
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: url, status, contentType: res.headers['content-type'], body });
    expect(status).toBe(403);
    expect(sites.readShellSite).not.toHaveBeenCalled();
  });
});

describe('GET /v1/sites/:siteId/user-pool-sites', () => {
  const url = '/v1/sites/tenant-a/user-pool-sites';

  it.each<SubjectName>(['editor', 'site-admin', 's2'])('reads the path site for %s', async (as) => {
    const res = await send('GET', url, as);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sites: [SHELL_SITE] });
    expect(sites.readUserPoolSites).toHaveBeenCalledWith(db, expect.objectContaining({ site: 'tenant-a' }), 'tenant-a');
  });

  it.each<[SubjectName, number]>([
    ['member', 403],
    ['anonymous', 401],
  ])('refuses %s with %i', async (as, status) => {
    const res = await send('GET', url, as);
    expect(res.statusCode).toBe(status);
    expect(sites.readUserPoolSites).not.toHaveBeenCalled();
  });

  it('refuses an editor token for another site with 403', async () => {
    const res = await app.inject({ method: 'GET', url, headers: await headersAs('editor', { site: 'tenant-b' }) });
    const { statusCode: status, body } = res;
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: url, status, contentType: res.headers['content-type'], body });
    expect(status).toBe(403);
    expect(sites.readUserPoolSites).not.toHaveBeenCalled();
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
      'a lower-case action',
      { siteid: 'tenant-a', action: 'update', site: 'Renamed', useSSL: 1 },
      'tenant-a',
      { siteid: 'tenant-a', action: 'update', site: 'Renamed', useSSL: '1' },
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

  it.each([
    ['an absent action', url, JSON_BODY, { siteid: 'tenant-a', site: 'Renamed' }],
    ['action Add', url, JSON_BODY, { siteid: 'tenant-a', action: 'Add' }],
    ['action Delete', url, FORM, 'siteid=tenant-a&action=Delete'],
    ['an absent siteid', url, JSON_BODY, { action: 'Update', site: 'Renamed' }],
    ['a complex JSON value', url, JSON_BODY, { siteid: 'tenant-a', action: 'Update', site: { name: 'Renamed' } }],
    ['a path siteId of 26 characters', `/v1/sites/${'a'.repeat(26)}/update`, FORM, 'siteid=&action=Update'],
  ])('answers invalidParameters for %s before the CSRF check and the update', async (_label, path, headers, body) => {
    const token = { 'x-csrf_token': 'T', 'x-csrf_token_expires': 'E' };
    const res = await send('POST', path, 's2', { ...headers, ...token }, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(identity.calls).toHaveLength(0);
    expect(sites.updateSite).not.toHaveBeenCalled();
    expect(sites.readSite).not.toHaveBeenCalled();
  });

  it('admits a path siteId of 25 characters to the site check', async () => {
    const res = await send('POST', `/v1/sites/${'a'.repeat(25)}/update`, 's2', FORM, 'siteid=&action=Update');
    expect(res.statusCode).toBe(403);
    expect(identity.calls).toHaveLength(0);
    expect(sites.updateSite).not.toHaveBeenCalled();
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

describe('GET /v1/href-domains', () => {
  it.each([
    ['a gateway invocation without a user token', 'service:gateway', undefined, '/v1/href-domains?siteid=default', 'default'],
    ['an anonymous-session token', 'member', '', '/v1/href-domains?SiteID=tenant-a', 'tenant-a'],
    ['a member token without a siteid', 'member', undefined, '/v1/href-domains', ''],
    ['an empty siteid', 'member', '', '/v1/href-domains?siteid=', ''],
  ] as const)('answers the domains for %s', async (_label, as, sub, url, siteId) => {
    const res = await send('GET', url, as, await headersAs(as, { sub }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DOMAINS);
    expect(sites.hrefDomains).toHaveBeenCalledExactlyOnceWith(db, siteId);
  });

  it.each([
    ['no credential', async () => ({}), 401],
    [
      'a user token without an invocation credential',
      async () => ({ authorization: `Bearer ${await mintUserToken({ sub: '', site: 'default', roles: [] })}` }),
      401,
    ],
    ['an invalid invocation credential', async () => ({ [INVOCATION_HEADER]: 'Bearer invalid' }), 401],
    [
      'a gateway invocation addressed to another service',
      async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'people' })}` }),
      401,
    ],
    ['the invocation of a service other than the gateway', async () => headersAs('service:people'), 403],
    ["a siteid other than the token's site", async () => headersAs('member', { sub: '' }), 403],
  ] as const)('refuses %s', async (_label, headersOf, status) => {
    const res = await send('GET', '/v1/href-domains?siteid=default', 'anonymous', await headersOf());
    expect(res.statusCode).toBe(status);
    expect(sites.hrefDomains).not.toHaveBeenCalled();
  });
});
