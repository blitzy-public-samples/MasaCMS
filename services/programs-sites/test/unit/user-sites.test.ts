/** GET /v1/user-sites against legacy getUserSites and bindToDomain(isAdmin=true), over a stub identity and registry fakes. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { registeredTenants, tenantForRegisteredSite, tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { ROLE_SET, assertResponseMatchesOpenApi, authHeadersFor, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { bindToAdminDomain } from '../../src/domain/user-sites.js';
import type { ProgramsSitesRepository } from '../../src/repo/repository.js';
import type { SiteRow } from '../../src/repo/tables.js';
import { registerUserSiteRoutes } from '../../src/routes/user-sites.js';

vi.mock('@opt2/platform/tenancy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tenancy')>();
  return { ...actual, registeredTenants: vi.fn(), tenantForRegisteredSite: vi.fn() };
});

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SESSION_SITES_PATH = '/v1/sessions/current/sites';
const UNREACHABLE = 'http://127.0.0.1:9';

/** A stored site; `domainalias` and `showdashboard` default to NULL. */
function siteRow(siteid: string, site: string | null, orderno: number | null, domain: string | null, extra: Partial<SiteRow> = {}): SiteRow {
  return {
    tenant_id: tenantIdForSite(siteid),
    siteid,
    site,
    domain,
    domainalias: null,
    showdashboard: null,
    orderno,
    deploy: 0,
    lastdeployment: null,
    baseid: null,
    row_version: '1',
    publicuserpoolid: null,
    privateuserpoolid: null,
    displaypoolid: null,
    filepoolid: null,
    categorypoolid: null,
    contentpoolid: null,
    ...extra,
  };
}

const ROWS: readonly SiteRow[] = [
  siteRow('tenant-b', 'tenant b', null, 'b.example.test'),
  siteRow('default', 'Default', 2, 'localhost', { showdashboard: 1 }),
  siteRow('tenant-a', 'Tenant A', 1, 'a.example.test', { domainalias: 'alias.example.test\r\nwww.a.example.test', showdashboard: 0 }),
];

const SITE_DEFAULT = { siteid: 'default', site: 'Default', orderno: 2, domain: 'localhost', domainAlias: null, showDashboard: 1 };
const SITE_A = {
  siteid: 'tenant-a',
  site: 'Tenant A',
  orderno: 1,
  domain: 'a.example.test',
  domainAlias: 'alias.example.test\r\nwww.a.example.test',
  showDashboard: 0,
};
const SITE_B = { siteid: 'tenant-b', site: 'tenant b', orderno: null, domain: 'b.example.test', domainAlias: null, showDashboard: 0 };

/** Stub identity answering the session's sites with `status` and `body`, recording each call's Authorization. */
interface StubIdentity {
  server: Server;
  url: string;
  status: number;
  body: unknown;
  calls: Array<{ path: string | undefined; authorization: string | undefined }>;
}

let stateDir: string;
let identity: StubIdentity;
let rows: readonly SiteRow[];
const tenants: string[] = [];
const apps: FastifyInstance[] = [];

const db: TenantDb = {
  schema: 'programs_sites',
  withTenant: (tenantId, fn) => {
    tenants.push(tenantId);
    return fn({ tenantId } as unknown as TenantTx);
  },
  withMetadata: () => Promise.reject(new Error('the registry is faked')),
  end: () => Promise.resolve(),
};

const repository = {
  listSites: (tx: TenantTx) => Promise.resolve(rows.filter((row) => row.tenant_id === tx.tenantId)),
} as unknown as ProgramsSitesRepository;

async function startIdentity(): Promise<StubIdentity> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stub: StubIdentity = {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    status: 200,
    body: { sites: [] },
    calls: [],
  };
  server.on('request', (req, res) => {
    stub.calls.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(stub.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stub.body));
  });
  return stub;
}

/** programs-sites with only the user-site route, calling identity at `identityUrl`. */
async function appWith({ identityUrl = identity.url, adminDomain = '' } = {}): Promise<FastifyInstance> {
  const app = await createService({
    name: 'programs-sites',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8113',
      OPT2_SERVICE_NAME: 'programs-sites',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_SERVICE_URLS: JSON.stringify({ identity: identityUrl }),
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('programs-sites'),
    pool: db,
    logger: createLogger({ service: 'programs-sites', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  registerUserSiteRoutes(app, { db, repository, adminDomain });
  await app.ready();
  return app;
}

type SubjectName = 's2' | 'site-admin' | 'editor' | 'member' | 'anonymous';

/** GETs `url` as `as` and checks the answer against the contract. */
async function send(url: string, as: SubjectName, app?: FastifyInstance) {
  const subject = ROLE_SET.find((candidate) => candidate.name === as);
  if (subject === undefined) throw new Error(`No role subject ${as}`);
  const headers = await authHeadersFor(subject, { audience: 'programs-sites', site: 'tenant-a' });
  const res = await (app ?? (await appWith())).inject({ method: 'GET', url, headers });
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'GET',
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return { res, headers };
}

/** identity's answer for a session whose `siteArray` is `siteIds`. */
const sessionSites = (...siteIds: string[]) => ({ sites: siteIds.map((siteID) => ({ siteID, site: siteID })) });

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-user-sites-'));
  await writeTestSecrets(stateDir);
  identity = await startIdentity();
});

afterAll(async () => {
  await new Promise((resolve) => identity.server.close(resolve));
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  rows = ROWS;
  tenants.length = 0;
  Object.assign(identity, { status: 200, body: { sites: [] }, calls: [] });
  vi.mocked(registeredTenants).mockImplementation(() =>
    Promise.resolve(
      rows.map((row) => ({ tenantId: row.tenant_id, siteId: row.siteid })).sort((a, b) => a.siteId.localeCompare(b.siteId)),
    ),
  );
  vi.mocked(tenantForRegisteredSite).mockImplementation((_db, siteId) =>
    Promise.resolve(rows.find((row) => row.siteid.toLowerCase() === siteId.toLowerCase())?.tenant_id ?? null),
  );
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.opt2.shutdown();
});

describe('bindToAdminDomain', () => {
  it.each<[string, SiteRow[], string, string, string | null]>([
    [
      'a complete match beats an earlier partial match',
      [siteRow('www', 'www', 1, 'www.example.com'), siteRow('apex', 'apex', 2, 'example.com')],
      'example.com',
      '',
      'apex',
    ],
    [
      'a complete match ignores case and the port',
      [siteRow('a', 'a', 1, 'other.test'), siteRow('b', 'b', 2, 'Example.COM')],
      'example.com:8080',
      '',
      'b',
    ],
    [
      'an alias on a CRLF- or LF-separated line matches completely',
      [siteRow('a', 'a', 1, 'a.test'), siteRow('b', 'b', 2, 'b.test', { domainalias: 'x.test\r\n\r\nalias.test\ny.test' })],
      'ALIAS.test',
      '',
      'b',
    ],
    [
      'a partial match finds the host inside a domain or alias',
      [siteRow('a', 'a', 1, 'a.test'), siteRow('b', 'b', 2, 'b.test', { domainalias: 'cms.example.org' })],
      'example',
      '',
      'b',
    ],
    [
      'a partial match is case-sensitive, so the first site by bind order, NULL first, is the fallback',
      [siteRow('late', 'late', 9, 'www.example.com'), siteRow('null', 'null', null, 'n.test'), siteRow('early', 'e', 1, 'e.test')],
      'Example',
      '',
      'null',
    ],
    ['the admin domain, compared without case, binds no site', [siteRow('a', 'a', 1, 'a.test')], 'ADMIN.example.com:443', 'admin.example.com', null],
    ['no registered site binds none', [], 'localhost', 'admin.example.com', null],
  ])('%s', (_name, sites, host, adminDomain, expected) => {
    expect(bindToAdminDomain(sites, host, adminDomain)).toBe(expected);
  });
});

describe('GET /v1/user-sites', () => {
  it('lists every registered site in name order for an S2 token without asking identity', async () => {
    const { res } = await send('/v1/user-sites', 's2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sites: [SITE_DEFAULT, SITE_A, SITE_B] });
    expect(identity.calls).toEqual([]);
  });

  it.each<[string, SubjectName, string[], unknown[]]>([
    ['the session sites of a site admin', 'site-admin', ['tenant-b', 'default'], [SITE_DEFAULT, SITE_B]],
    ['the session sites of a system user, unregistered and repeated ids skipped', 'editor', ['tenant-a', 'gone', 'tenant-a'], [SITE_A]],
    ['only exact-case session site ids', 'editor', ['TENANT-A', 'default'], [SITE_DEFAULT]],
    ['no site for an empty siteArray', 'site-admin', [], []],
  ])('lists %s, forwarding the user token to identity', async (_name, as, siteArray, expected) => {
    identity.body = sessionSites(...siteArray);
    const { res, headers } = await send('/v1/user-sites', as);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sites: expected });
    expect(identity.calls).toEqual([{ path: SESSION_SITES_PATH, authorization: headers.authorization }]);
  });

  it('reads only the tenants of the session sites when no host is given', async () => {
    identity.body = sessionSites('tenant-a');
    await send('/v1/user-sites', 'editor');
    expect(tenants).toEqual([tenantIdForSite('tenant-a')]);
  });

  it.each<[string, SubjectName, string, string, string | null]>([
    ['an alias of the bound site', 's2', 'alias.example.test:8443', '', 'tenant-a'],
    ['a site the user does not administer', 'editor', 'b.example.test', '', 'tenant-b'],
    ['the admin domain', 's2', 'Admin.Example.Test', 'admin.example.test', null],
    ['an unmatched host to the first site by bind order', 'editor', 'elsewhere.test', '', 'tenant-b'],
  ])('binds %s over every registered site', async (_name, as, host, adminDomain, bound) => {
    identity.body = sessionSites('default');
    const app = await appWith({ adminDomain });
    const { res } = await send(`/v1/user-sites?host=${encodeURIComponent(host)}`, as, app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sites: as === 's2' ? [SITE_DEFAULT, SITE_A, SITE_B] : [SITE_DEFAULT], boundSiteId: bound });
  });

  it('binds no site when none is registered', async () => {
    rows = [];
    const { res } = await send('/v1/user-sites?host=localhost', 's2');
    expect(res.json()).toEqual({ sites: [], boundSiteId: null });
  });

  it('answers invalidParameters for a repeated host', async () => {
    const { res } = await send('/v1/user-sites?host=a&host=b', 's2');
    expect(res.statusCode).toBe(400);
  });

  it.each<[SubjectName, number]>([
    ['anonymous', 401],
    ['member', 403],
  ])('refuses %s with %i before asking identity', async (as, status) => {
    const { res } = await send('/v1/user-sites', as);
    expect(res.statusCode).toBe(status);
    expect(identity.calls).toEqual([]);
  });

  it.each<[string, number, unknown, number]>([
    ['refuses the token', 401, { error: 'authorization' }, 401],
    ['refuses the session', 403, { error: 'authorization' }, 403],
    ['is unavailable', 503, { error: 'unavailable' }, 503],
    ['fails', 500, { error: 'server_error' }, 503],
    ['answers a body off its contract', 200, { sites: [{ site: 'Default' }] }, 503],
  ])('maps identity that %s (HTTP %i) to its legacy status', async (_name, status, body, expected) => {
    Object.assign(identity, { status, body });
    const { res } = await send('/v1/user-sites', 'site-admin');
    expect(res.statusCode).toBe(expected);
  });

  it('answers the legacy 503 when identity is unreachable', async () => {
    const { res } = await send('/v1/user-sites', 'editor', await appWith({ identityUrl: UNREACHABLE }));
    expect(res.statusCode).toBe(503);
  });
});
