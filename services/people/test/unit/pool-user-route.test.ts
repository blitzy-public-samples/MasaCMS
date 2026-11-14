/** The pool-user read of the e-signature fixture's signer check, over in-memory people rows, registry and identity accounts. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import type { AccountView, IdentityClient } from '../../src/legacy/identity-client.js';
import type { PeopleRepository } from '../../src/repo/repository.js';
import type { PersonRow } from '../../src/repo/tables.js';
import { registerAdminUserRoutes } from '../../src/routes/admin-users.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const NOW = new Date(2026, 5, 30, 9, 15, 0, 0);
const POOL_USER_PATH = '/internal/v1/users/pool-user';
const SITE = 'tenant-a';
const UMBRELLA = 'umbrella';
const OTHER = 'tenant-b';
// A site whose private pool is another site, so its own tenant is no user pool.
const POOLED_SITE = 'tenant-p';
const STAFF_POOL = 'tenant-p-staff';
const UNREGISTERED_SITE = 'tenant-z';
const SIGNER = 'A0000000-0000-0000-0000000000000001';
const MEMBER = 'A0000000-0000-0000-0000000000000003';
const OUTSIDER = 'A0000000-0000-0000-0000000000000004';
const OWN_SITE_USER = 'A0000000-0000-0000-0000000000000005';
const PENDING = 'A0000000-0000-0000-0000000000000006';
const POOL_STAFF = 'A0000000-0000-0000-0000000000000007';
const UNKNOWN = 'A0000000-0000-0000-00000000000000FF';
// A group's id: groups are identity's rows, so people holds no person under it.
const GROUP = 'B0000000-0000-0000-0000000000000001';

/** One registry row as `tenant_registry` stores it. */
function registryRow(site: string, publicPool: string, privatePool: string) {
  return {
    site_id: site,
    tenant_id: tenantIdForSite(site),
    public_user_pool_id: publicPool,
    private_user_pool_id: privatePool,
    category_pool_id: null,
    file_pool_id: null,
    display_pool_id: null,
    content_pool_ids: [],
    public_user_pool_tenant: tenantIdForSite(publicPool),
    private_user_pool_tenant: tenantIdForSite(privatePool),
    category_pool_tenant: null,
    file_pool_tenant: null,
    display_pool_tenant: null,
    content_pool_tenants: [],
    domains: [],
    aggregate_version: '1',
    updated_at: NOW,
  };
}

const REGISTRY = [
  registryRow(SITE, UMBRELLA, SITE),
  registryRow(OTHER, OTHER, OTHER),
  registryRow(UMBRELLA, UMBRELLA, UMBRELLA),
  registryRow(POOLED_SITE, UMBRELLA, STAFF_POOL),
];

/** A person row stored under `site`. */
function person(userid: string, site: string): PersonRow {
  return {
    userid, groupname: null, fname: 'Synthetic', lname: 'Person', email: null, company: null, jobtitle: null, mobilephone: null,
    website: null, subtype: 'Default', ext: null, contactform: null, lastupdate: NOW, lastupdateby: 'Admin User',
    lastupdatebyid: SIGNER, siteid: site, subscribe: 1, notes: null, description: null, interests: null, keepprivate: 0,
    photofileid: null, imname: null, imservice: null, created: NOW, tags: null, row_version: '1', tenant_id: tenantIdForSite(site),
  } as PersonRow;
}

function account(userId: string, siteId: string, isPublic = 0): AccountView {
  return {
    userId, siteId, username: userId.slice(-4), s2: 0, isPublic, inactive: 0, type: 2, perm: 0, admin: 0, remoteId: null,
    lastLogin: null, passwordCreated: null, tablist: null,
  };
}

const PERSONS = [
  person(SIGNER, SITE),
  person(MEMBER, UMBRELLA),
  person(OUTSIDER, OTHER),
  person(OWN_SITE_USER, POOLED_SITE),
  person(PENDING, SITE),
  person(POOL_STAFF, STAFF_POOL),
];
// PENDING has no account identity lists, as a roster create holds it before its commit.
const ACCOUNTS = new Map([
  [SIGNER, account(SIGNER, SITE)],
  [MEMBER, account(MEMBER, UMBRELLA, 1)],
  [OUTSIDER, account(OUTSIDER, OTHER)],
  [OWN_SITE_USER, account(OWN_SITE_USER, POOLED_SITE)],
  [POOL_STAFF, account(POOL_STAFF, STAFF_POOL)],
]);

const sameId = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

/** The tenants whose person rows were read, and the users each roster lock covered. */
const personReads: string[] = [];
const rosterLocks: Array<{ tenantId: string; userIds: readonly string[] }> = [];

/** A TenantDb answering the registry reads from REGISTRY; tenant transactions carry only their tenant. */
const db: TenantDb = {
  schema: 'people',
  withTenant: async (tenantId, fn) => fn({ tenantId } as unknown as TenantTx),
  withMetadata: async (fn) =>
    fn({
      schema: 'people',
      query: async (sql: string, params: unknown[] = []) => {
        if (/lower\(site_id\) = lower\(\$1\)/.test(sql)) return { rows: REGISTRY.filter((row) => sameId(row.site_id, String(params[0]))) };
        if (/WHERE tenant_id = \$1/.test(sql)) return { rows: REGISTRY.filter((row) => row.tenant_id === params[0]) };
        return { rows: REGISTRY };
      },
    } as never),
  end: async () => undefined,
};

/** The person reads findPersonRows makes, and the roster observer's lock and operation reads, over PERSONS. */
const repository = {
  findPerson: async (tx: TenantTx, userId: string) => {
    personReads.push(tx.tenantId);
    return PERSONS.find((row) => row.tenant_id === tx.tenantId && sameId(row.userid, userId)) ?? null;
  },
  listInterests: async () => [],
  listAddresses: async () => [],
  listExtendData: async () => [],
  listExtendAttributes: async () => [],
  listExtendSets: async () => [],
  listExtendSubtypes: async () => [],
  lockRosterUsers: async (tx: TenantTx, userIds: readonly string[]) => {
    rosterLocks.push({ tenantId: tx.tenantId, userIds });
  },
  lockRosterTenant: async () => undefined,
  findOpenRosterOperations: async () => [],
  countRosterOperations: async () => 0,
} as unknown as PeopleRepository;

/** Identity's account read alone; any other call fails the test. */
const identity = new Proxy({ readAccount: async (userId: string) => ACCOUNTS.get(userId) } as Partial<IdentityClient>, {
  get: (target, name: string) => target[name as keyof IdentityClient] ?? (() => Promise.reject(new Error(`unexpected identity call ${name}`))),
}) as IdentityClient;

let stateDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-people-pool-user-'));
  await writeTestSecrets(stateDir);
  app = await createService({
    name: 'people',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8112',
      OPT2_SERVICE_NAME: 'people',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('people'),
    logger: createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  await registerAdminUserRoutes(app, { db, repository, identity, clock: fixedClock(NOW) });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  personReads.length = 0;
  rosterLocks.length = 0;
});

/** The invocation credential of `caller`, beside a user token of `site` for `sub` unless `sub` is undefined. */
async function headers(caller: string, sub: string | undefined, site = SITE): Promise<Record<string, string>> {
  const invocation = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: 'people' })}` };
  if (sub === undefined) return invocation;
  return { ...invocation, authorization: `Bearer ${await mintUserToken({ sub, site, roles: [Roles.systemUser, Roles.esignatureSigner] })}` };
}

/** GETs the pool-user read with `query`, checking the answer against the contract. */
async function read(query: string, requestHeaders: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url: `${POOL_USER_PATH}?${query}`, headers: requestHeaders });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: POOL_USER_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

describe("the pool-user read of the e-signature fixture's poolUserId [legacy: legacy-fixtures/cfml/modules/esignature.cfc:274-285]", () => {
  it.each([
    ['a public-pool user', SITE, MEMBER, UMBRELLA],
    ['a private-pool user', SITE, SIGNER, SITE],
    ['a user by a lower-cased id', SITE, SIGNER.toLowerCase(), SITE],
    ["a user of a private pool that is another site's", POOLED_SITE, POOL_STAFF, STAFF_POOL],
  ])("reads %s as its stored id, site and type for e-signature with the signer's token", async (_label, site, userId, siteid) => {
    const res = await read(`siteid=${site}&userid=${userId}`, await headers('e-signature', SIGNER, site));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userid: userId.toUpperCase(), siteid, type: 2 });
  });

  it("reads only the token site's two pool tenants, each under the user's roster lock", async () => {
    await read(`siteid=${POOLED_SITE}&userid=${UNKNOWN}`, await headers('e-signature', SIGNER, POOLED_SITE));

    const pools = [tenantIdForSite(UMBRELLA), tenantIdForSite(STAFF_POOL)];
    expect(personReads).toEqual(pools);
    expect(rosterLocks).toEqual(pools.map((tenantId) => ({ tenantId, userIds: [UNKNOWN] })));
  });

  it.each([
    ['an unknown id', SITE, UNKNOWN],
    ['a group id', SITE, GROUP],
    ["another site's user", SITE, OUTSIDER],
    ["a user of the site's own tenant when it is no user pool", POOLED_SITE, OWN_SITE_USER],
    ['a person whose account identity does not list', SITE, PENDING],
  ])('answers the legacy 404 for %s', async (_label, site, userId) => {
    const res = await read(`siteid=${site}&userid=${userId}`, await headers('e-signature', SIGNER, site));

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid method call' } });
  });

  it.each<[string, () => Promise<Record<string, string>>, string, number]>([
    ['no user token', () => headers('e-signature', undefined), `siteid=${SITE}&userid=${SIGNER}`, 401],
    ['an anonymous session token', () => headers('e-signature', ''), `siteid=${SITE}&userid=${SIGNER}`, 401],
    ['no credential at all', () => Promise.resolve({}), `siteid=${SITE}&userid=${SIGNER}`, 401],
    ["the gateway's credential", () => headers('gateway', SIGNER), `siteid=${SITE}&userid=${SIGNER}`, 403],
    ["identity's credential", () => headers('identity', SIGNER), `siteid=${SITE}&userid=${SIGNER}`, 403],
    ["a siteid other than the token's site", () => headers('e-signature', SIGNER), `siteid=${OTHER}&userid=${OUTSIDER}`, 403],
    ['a call without a userid', () => headers('e-signature', SIGNER), `siteid=${SITE}`, 400],
  ])('refuses %s before any person read', async (_label, requestHeaders, query, status) => {
    const res = await read(query, await requestHeaders());

    expect(res.statusCode).toBe(status);
    expect(personReads).toEqual([]);
  });

  it('answers the legacy 503 for a token whose tenant has no registry entry', async () => {
    const res = await read(`userid=${SIGNER}`, await headers('e-signature', SIGNER, UNREGISTERED_SITE));

    expect(res.statusCode).toBe(503);
    expect(personReads).toEqual([]);
  });
});
