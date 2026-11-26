/** `listPrivateInterestGroups` through `app.inject` over a throwaway `content` schema: private-pool reach, levels, ordering, denials and the multi-site halt. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, tenantRegistryConsumer } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  loadOpenApiDocument,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { PROFILE_INTEREST_SITES_EXCEPTION } from '../../src/domain/categories.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { registerInterestGroupRoutes } from '../../src/routes/v1/interest-groups.js';

type ContractOperation = Record<string, unknown>;

const SERVICE = 'strategies-content';
const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
const OPENAPI = loadOpenApiDocument(fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)), parse) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const CONTRACT_PATH = '/v1/sites/{siteid}/private-interest-groups';
const USER = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const id = (n: number): string => `A9000000-0000-0000-00000000000000${String(n).padStart(2, '0')}`;

/** A private user pool of two sites: pool-p, and pool-q, which names it in another case. */
const SITE_P = 'pool-p';
const SITE_Q = 'pool-q';
/** A site whose private user pool site is pool-q, itself in pool-p's pool. */
const SITE_T = 'site-t';

const C = {
  aNull: id(1),
  aAlpha: id(2),
  aBeta: id(3),
  aPlain: id(4),
  aZeta: id(5),
  aPlainChild: id(6),
  umbrella: id(7),
  b: id(8),
  pRoot: id(9),
  pChild: id(10),
  qRoot: id(11),
  tRoot: id(12),
} as const;

interface CategorySeed {
  site: string;
  categoryid: string;
  parentid?: string;
  name: string | null;
  isinterestgroup: number;
  isopen: number | null;
  filename?: string | null;
  urltitle?: string | null;
}

const CATEGORIES: readonly CategorySeed[] = [
  { site: TENANT_A.siteId, categoryid: C.aNull, name: null, isinterestgroup: 1, isopen: null, filename: null, urltitle: null },
  { site: TENANT_A.siteId, categoryid: C.aBeta, name: 'beta Topics', isinterestgroup: 1, isopen: 1 },
  { site: TENANT_A.siteId, categoryid: C.aAlpha, name: 'Alpha Topics', isinterestgroup: 1, isopen: 0 },
  { site: TENANT_A.siteId, categoryid: C.aPlain, name: 'Aardvark', isinterestgroup: 0, isopen: 1 },
  { site: TENANT_A.siteId, categoryid: C.aZeta, parentid: C.aAlpha, name: 'Zeta', isinterestgroup: 1, isopen: 1 },
  { site: TENANT_A.siteId, categoryid: C.aPlainChild, parentid: C.aAlpha, name: 'Plain Child', isinterestgroup: 0, isopen: 1 },
  { site: TENANT_UMBRELLA.siteId, categoryid: C.umbrella, name: 'Umbrella Interest', isinterestgroup: 1, isopen: 1 },
  { site: TENANT_B.siteId, categoryid: C.b, name: 'B Interest', isinterestgroup: 1, isopen: 1 },
  { site: SITE_P, categoryid: C.pRoot, name: 'P Root', isinterestgroup: 1, isopen: 1 },
  { site: SITE_P, categoryid: C.pChild, parentid: C.pRoot, name: 'P Child', isinterestgroup: 1, isopen: 1 },
  { site: SITE_Q, categoryid: C.qRoot, name: 'Q Root', isinterestgroup: 1, isopen: 1 },
  { site: SITE_T, categoryid: C.tRoot, name: 'T Root', isinterestgroup: 1, isopen: 1 },
];

/** The contract row of a seeded category. */
function item(seed: CategorySeed, hasKids = 0): Record<string, unknown> {
  return {
    siteID: seed.site,
    categoryID: seed.categoryid,
    name: seed.name ?? '',
    filename: seed.filename === undefined ? seed.categoryid.toLowerCase() : (seed.filename ?? ''),
    urltitle: seed.urltitle === undefined ? seed.categoryid.toLowerCase() : (seed.urltitle ?? ''),
    isOpen: seed.isopen,
    hasKids,
  };
}

const seedOf = (categoryid: string): CategorySeed => {
  const seed = CATEGORIES.find((candidate) => candidate.categoryid === categoryid);
  if (seed === undefined) throw new TypeError(`No seeded category ${categoryid}`);
  return seed;
};

describe.skipIf(!(await pgAvailable()))('listPrivateInterestGroups', () => {
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  /** The errors the route raised, as the error handler receives them. */
  const routeErrors: Error[] = [];

  /** A user token of `site` with `roles` and the gateway's invocation credential. */
  const headersFor = async (site: string, roles: readonly string[] = [Roles.systemUser]): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await mintUserToken({ sub: USER, site, roles: [...roles] })}`,
    [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`,
  });

  /** GETs the level of `query` under the token site `site`, checking the answer against the contract. */
  const list = async (site: string, query: Record<string, string>, opts: { path?: string; headers?: Record<string, string> } = {}) => {
    const path = `/v1/sites/${opts.path ?? site}/private-interest-groups`;
    const res = await app.inject({ method: 'GET', url: `${path}?${new URLSearchParams(query).toString()}`, headers: opts.headers ?? (await headersFor(site)) });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  };

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE, schemaName: 'content', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await seedRegistry(handle.app);
    for (const payload of [
      { siteId: SITE_P, privateUserPoolId: SITE_P },
      { siteId: SITE_Q, privateUserPoolId: SITE_P.toUpperCase() },
      { siteId: SITE_T, privateUserPoolId: SITE_Q },
    ]) {
      const tenantId = tenantIdForSite(payload.siteId);
      await handle.app.withTenant(tenantId, (tx) => tenantRegistryConsumer.apply(tx, { tenantId, aggregateVersion: 1, payload }));
    }
    for (const seed of CATEGORIES) {
      await handle.app.withTenant(tenantIdForSite(seed.site), (tx) =>
        tx.query(
          `INSERT INTO ${handle.schema}.category (tenant_id, categoryid, siteid, parentid, name, isinterestgroup, isopen, filename, urltitle)` +
            ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            tx.tenantId,
            seed.categoryid,
            seed.site,
            seed.parentid ?? null,
            seed.name,
            seed.isinterestgroup,
            seed.isopen,
            seed.filename === undefined ? seed.categoryid.toLowerCase() : seed.filename,
            seed.urltitle === undefined ? seed.categoryid.toLowerCase() : seed.urltitle,
          ],
        ),
      );
    }
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8114',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: process.env.TZ ?? 'UTC',
      }),
      clock: CLOCK,
      verifierOverride: testVerifier(SERVICE),
      pool: handle.app,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    const repository = createContentRepository({ clock: CLOCK, schema: handle.schema });
    app.addHook('onError', async (_request, _reply, error) => {
      routeErrors.push(error);
    });
    await registerInterestGroupRoutes(app, { domain: { db: handle.app, repository } });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  it('registers the contract operation with its transport and roles', () => {
    const operation = OPENAPI.paths[CONTRACT_PATH]?.get ?? {};
    expect(collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/v1/'))).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: '/v1/sites/:siteid/private-interest-groups',
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
      }),
    ]);
  });

  it("lists the top level of the token site's own interest groups by name, NULL first, with every child counted", async () => {
    const res = await list(TENANT_A.siteId, { groupsiteid: TENANT_A.siteId });
    expect(res.statusCode).toBe(200);
    // Neither umbrella, tenant-a's category pool, nor tenant-b is read: legacy joins tsettings on the category's own site.
    expect(res.json()).toEqual({ items: [item(seedOf(C.aNull)), item(seedOf(C.aAlpha), 2), item(seedOf(C.aBeta))] });
  });

  it.each([
    ['the site id in another case', { groupsiteid: TENANT_A.siteId.toUpperCase() }, [item(seedOf(C.aNull)), item(seedOf(C.aAlpha), 2), item(seedOf(C.aBeta))]],
    ['an empty parent id as the top level', { groupsiteid: TENANT_A.siteId, parentid: '' }, [item(seedOf(C.aNull)), item(seedOf(C.aAlpha), 2), item(seedOf(C.aBeta))]],
    ['a parent id in another case, its interest children only', { groupsiteid: TENANT_A.siteId, parentid: C.aAlpha.toLowerCase() }, [item(seedOf(C.aZeta))]],
    ['a parent without interest children', { groupsiteid: TENANT_A.siteId, parentid: C.aBeta }, []],
  ])('reads %s', async (_label, query, items) => {
    const res = await list(TENANT_A.siteId, query);
    expect({ status: res.statusCode, body: res.json() }).toEqual({ status: 200, body: { items } });
  });

  it.each([
    ['a site of the pool, which reads the one site holding the level', SITE_Q, SITE_P, { parentid: C.pRoot }, [item(seedOf(C.pChild))]],
    ['the token site, its pool named in another case', SITE_Q, SITE_Q, { parentid: C.pRoot }, [item(seedOf(C.pChild))]],
    ["the token site's private pool site, whose own pool is another", SITE_T, SITE_Q, { parentid: C.pRoot }, [item(seedOf(C.pChild))]],
    ["the token site, reading its own pool's sites only", SITE_T, SITE_T, {}, [item(seedOf(C.tRoot))]],
  ])('admits %s', async (_label, site, groupsiteid, query, items) => {
    const res = await list(site, { groupsiteid, ...query });
    expect({ status: res.statusCode, body: res.json() }).toEqual({ status: 200, body: { items } });
  });

  it('answers the legacy 503 naming its exceptions entry for a level two sites of the pool hold, whose order needs site names', async () => {
    routeErrors.length = 0;
    const res = await list(SITE_Q, { groupsiteid: SITE_P });
    expect(res.statusCode).toBe(503);
    expect(routeErrors).toEqual([
      expect.objectContaining({ reason: 'private-interest-groups-halted', message: expect.stringContaining(`(${PROFILE_INTEREST_SITES_EXCEPTION})`) }),
    ]);
    expect(PROFILE_INTEREST_SITES_EXCEPTION).toBe('EX-PROFILE-INTEREST-SITES');
  });

  it.each([
    ["another tenant's site", TENANT_A.siteId, TENANT_B.siteId],
    ["the site's category pool", TENANT_A.siteId, TENANT_UMBRELLA.siteId],
    ['a site the registry does not hold', TENANT_A.siteId, 'no-such-site'],
    ['a site outside the pool of the private pool site', SITE_T, SITE_P],
  ])('refuses %s with 403, reading no row', async (_label, site, groupsiteid) => {
    const res = await list(site, { groupsiteid });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('Interest');
  });

  it.each<[string, () => Promise<Record<string, string>>, string, Record<string, string>, number]>([
    ['a path site other than the token site', () => headersFor(TENANT_A.siteId), TENANT_B.siteId, { groupsiteid: TENANT_B.siteId }, 403],
    ['a token without a listed role', () => headersFor(TENANT_A.siteId, []), TENANT_A.siteId, { groupsiteid: TENANT_A.siteId }, 403],
    ['no user token', async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` }), TENANT_A.siteId, { groupsiteid: TENANT_A.siteId }, 401],
    ['no groupsiteid', () => headersFor(TENANT_A.siteId), TENANT_A.siteId, {}, 400],
    ['a parent id longer than 35 characters', () => headersFor(TENANT_A.siteId), TENANT_A.siteId, { groupsiteid: TENANT_A.siteId, parentid: `${C.aAlpha}0` }, 400],
  ])('refuses %s', async (_label, headers, path, query, status) => {
    const res = await list(TENANT_A.siteId, query, { path, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });

  it('answers the legacy 500 for a token site the registry does not hold yet', async () => {
    const res = await list('unregistered-site', { groupsiteid: TENANT_A.siteId });
    expect(res.statusCode).toBe(500);
  });
});
