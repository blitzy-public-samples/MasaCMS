/** The cUsers read routes over in-memory people rows, registry and identity: contract shapes, the `before()` gate, tenancy and `route()`. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, moduleRole, recordedRoutes } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import type { AccountView, AdminSessionState, GroupSummary, IdentityClient, UserGroupRow } from '../../src/legacy/identity-client.js';
import type { PeopleRepository } from '../../src/repo/repository.js';
import type { AddressRow, ExtendSubtypeRow, PersonRow } from '../../src/repo/tables.js';
import {
  parseDomain,
  registerAdminUserRoutes,
  removeLeadingDoubleSlash,
  routeRedirect,
  sanitizeHref,
} from '../../src/routes/admin-users.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string; 'x-opt2-transport'?: string; 'x-opt2-requires'?: string[] }>>;
};
const NOW = new Date(2026, 5, 30, 9, 15, 0, 0);
const SITE = 'tenant-a';
const UMBRELLA = 'umbrella';
const OTHER = 'tenant-b';
const ADMIN = 'A0000000-0000-0000-0000000000000001';
const JANE = 'A0000000-0000-0000-0000000000000002';
const ROOT = 'A0000000-0000-0000-0000000000000003';
const MEMBER = 'A0000000-0000-0000-0000000000000004';
const OUTSIDER = 'A0000000-0000-0000-0000000000000005';
const GROUP = 'B0000000-0000-0000-0000000000000001';
const MEMBER_GROUP = 'B0000000-0000-0000-0000000000000002';
const ADDRESS = 'C0000000-0000-0000-0000000000000001';
const SUBTYPE = 'D0000000-0000-0000-0000000000000001';
const USERS_MODULE = moduleRole('00000000000000000000000000000000008');
const SITE_MANAGER_MODULE = moduleRole('00000000000000000000000000000000000');

/** One registry row as `tenant_registry` stores it. */
function registryRow(site: string, publicPool: string, privatePool: string, domains: string[]) {
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
    domains,
    aggregate_version: '1',
    updated_at: NOW,
  };
}

const REGISTRY = [
  registryRow('default', 'default', 'default', ['www.default.test']),
  registryRow(OTHER, OTHER, OTHER, ['b.example.test']),
  registryRow(SITE, UMBRELLA, SITE, ['a.example.test', 'alias.example.test']),
  registryRow(UMBRELLA, UMBRELLA, UMBRELLA, ['umbrella.example.test']),
];

/** A person row of `site` holding only the columns a test names. */
function person(userid: string, site: string, names: Partial<PersonRow> = {}): PersonRow {
  return {
    userid, groupname: null, fname: null, lname: null, email: null, company: null, jobtitle: null, mobilephone: null,
    website: null, subtype: 'Default', ext: null, contactform: null, lastupdate: NOW, lastupdateby: 'Admin User',
    lastupdatebyid: ADMIN, siteid: site, subscribe: 1, notes: null, description: null, interests: null, keepprivate: 0,
    photofileid: null, imname: null, imservice: null, created: NOW, tags: null, row_version: '1', tenant_id: tenantIdForSite(site),
    ...names,
  } as PersonRow;
}

function account(userId: string, siteId: string, values: Partial<AccountView> = {}): AccountView {
  return {
    userId, siteId, username: userId.slice(-4), s2: 0, isPublic: 0, inactive: 0, type: 2, perm: 0, admin: 0, remoteId: null,
    lastLogin: '2026-06-29T08:00:00.000', passwordCreated: null, tablist: null, ...values,
  };
}

const PERSONS = [
  person(JANE, SITE, { fname: 'Jane', lname: 'Doe', email: 'jane@example.test', photofileid: 'PHOTO-1' }),
  person(ROOT, SITE, { fname: 'Root', lname: 'Admin', ext: 12 }),
  person(MEMBER, UMBRELLA, { fname: 'Mo', lname: 'Member' }),
  person(OUTSIDER, OTHER, { fname: 'Out', lname: 'Sider' }),
];
const ACCOUNTS = new Map([
  [JANE, account(JANE, SITE)],
  [ROOT, account(ROOT, SITE, { s2: 1, admin: 1 })],
  [MEMBER, account(MEMBER, UMBRELLA, { isPublic: 1 })],
  [OUTSIDER, account(OUTSIDER, OTHER)],
]);
const MEMBERSHIPS = new Map([[ROOT, [GROUP]]]);
const ADDRESSES: AddressRow[] = [
  {
    tenant_id: tenantIdForSite(SITE), addressid: ADDRESS, userid: JANE, siteid: SITE, addressname: 'Home', address1: '1 Main St',
    address2: null, city: 'Springfield', state: null, zip: null, country: null, phone: null, fax: null, isprimary: 1,
    addressnotes: null, addressurl: null, longitude: 1.5, latitude: null, addressemail: null, hours: null,
  } as AddressRow,
];
const SUBTYPES: ExtendSubtypeRow[] = [
  { tenant_id: tenantIdForSite(SITE), subtypeid: SUBTYPE, siteid: SITE, type: '2', subtype: 'Staff', isactive: 1 } as ExtendSubtypeRow,
  { tenant_id: tenantIdForSite(SITE), subtypeid: 'D0000000-0000-0000-0000000000000002', siteid: SITE, type: '2', subtype: 'Old', isactive: 0 } as ExtendSubtypeRow,
  { tenant_id: tenantIdForSite(UMBRELLA), subtypeid: 'D0000000-0000-0000-0000000000000003', siteid: UMBRELLA, type: '2', subtype: 'Fan', isactive: 1 } as ExtendSubtypeRow,
];
const PRIVATE_GROUPS: GroupSummary[] = [{ groupId: GROUP, groupName: 'Admin', siteId: SITE, isPublic: 0, perm: 1 }];
const PUBLIC_GROUPS: GroupSummary[] = [{ groupId: MEMBER_GROUP, groupName: 'Fans', siteId: UMBRELLA, isPublic: 1, perm: 0 }];
const GROUP_ROWS: UserGroupRow[] = [
  { userId: GROUP, email: null, groupName: 'Admin', type: 1, lastLogin: null, lastUpdate: '2026-06-01T10:00:00.000', lastUpdateBy: 'Admin User', lastUpdateById: ADMIN, counter: 2, perm: 1, isPublic: 0 },
  { userId: 'B0000000-0000-0000-0000000000000009', email: null, groupName: 'Editors', type: null, lastLogin: null, lastUpdate: null, lastUpdateBy: null, lastUpdateById: null, counter: null, perm: 0, isPublic: 0 },
];

/** A tenant transaction of the fake database; only the tenant matters to the fake repository. */
function fakeTx(tenantId: string): TenantTx {
  return { tenantId } as unknown as TenantTx;
}

const tenantsRead: string[] = [];

/** A TenantDb whose metadata transactions answer the registry queries, and whose tenant transactions record the tenant. */
const db: TenantDb = {
  schema: 'people',
  withTenant: async (tenantId, fn) => {
    tenantsRead.push(tenantId);
    return fn(fakeTx(tenantId));
  },
  withMetadata: async (fn) =>
    fn({
      schema: 'people',
      query: async (sql: string, params: unknown[] = []) => {
        if (/ORDER BY site_id/.test(sql)) return { rows: REGISTRY.map((row) => ({ tenant_id: row.tenant_id, site_id: row.site_id })) };
        return { rows: REGISTRY.filter((row) => row.tenant_id === params[0]) };
      },
    } as never),
  end: async () => undefined,
};

const ofTenant = <R extends { tenant_id: string }>(rows: readonly R[], tx: TenantTx): R[] => rows.filter((row) => row.tenant_id === tx.tenantId);
const sameId = (a: string | null, b: string): boolean => a !== null && a.toUpperCase() === b.toUpperCase();

/** The repository reads the routes and the search domain make, over the in-memory rows. */
const repository = {
  findPerson: async (tx: TenantTx, userId: string) => ofTenant(PERSONS, tx).find((row) => sameId(row.userid, userId)) ?? null,
  queryPersons: async (tx: TenantTx) => ofTenant(PERSONS, tx),
  listPersonsForSite: async (tx: TenantTx, siteId: string) => ofTenant(PERSONS, tx).filter((row) => sameId(row.siteid, siteId)),
  listInterests: async (_tx: TenantTx, userId: string) => (userId === JANE ? [{ userid: JANE, categoryid: 'E0000000-0000-0000-0000000000000001' }] : []),
  listAddresses: async (tx: TenantTx, userId: string) => ofTenant(ADDRESSES, tx).filter((row) => sameId(row.userid, userId)),
  findAddress: async (tx: TenantTx, addressId: string) => ofTenant(ADDRESSES, tx).find((row) => sameId(row.addressid, addressId)) ?? null,
  // The address holds one date attribute and one text attribute.
  listExtendData: async (_tx: TenantTx, baseIds: readonly string[]) =>
    baseIds.includes(ADDRESS)
      ? [
          { dataid: 1, baseid: ADDRESS, attributeid: 7, siteid: SITE, attributevalue: '2026-06-01', datetimevalue: new Date(2026, 5, 1), numericvalue: null, stringvalue: '2026-06-01', remoteid: null },
          { dataid: 2, baseid: ADDRESS, attributeid: 8, siteid: SITE, attributevalue: 'Gate 4', datetimevalue: null, numericvalue: null, stringvalue: 'Gate 4', remoteid: null },
        ]
      : [],
  listExtendAttributes: async (_tx: TenantTx, filter: { attributeIds?: readonly number[] }) =>
    [
      { attributeid: 7, extendsetid: 'F1', siteid: SITE, name: 'movedIn', type: 'TextBox', validation: 'date', orderno: 1 },
      { attributeid: 8, extendsetid: 'F1', siteid: SITE, name: 'access', type: 'TextBox', validation: '', orderno: 2 },
    ].filter((row) => filter.attributeIds?.includes(row.attributeid) ?? true),
  listExtendSets: async () => [],
  listExtendSubtypes: async (tx: TenantTx, filter: { siteId: string; types?: readonly string[] }) =>
    ofTenant(SUBTYPES, tx).filter((row) => sameId(row.siteid, filter.siteId) && (filter.types === undefined || filter.types.includes(row.type ?? ''))),
} as unknown as PeopleRepository;

let sessionState: AdminSessionState = {};
const saves: AdminSessionState[] = [];
const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`unexpected identity call ${name}`));

/** Identity's reads over the in-memory accounts, groups and session state. */
const identity: IdentityClient = {
  prepare: unused('prepare'),
  commit: unused('commit'),
  abort: unused('abort'),
  finish: unused('finish'),
  revert: unused('revert'),
  operationState: unused('operationState'),
  readAccount: async (userId) => ACCOUNTS.get(userId),
  readAccounts: async (userIds) => new Map(userIds.flatMap((id) => (ACCOUNTS.has(id) ? [[id, ACCOUNTS.get(id) as AccountView] as const] : []))),
  userMemberships: unused('userMemberships'),
  membershipGroupIds: async (userId) => MEMBERSHIPS.get(userId) ?? [],
  siteGroups: async (_siteId, isPublic) => (isPublic === 1 ? PUBLIC_GROUPS : PRIVATE_GROUPS),
  userGroups: async () => GROUP_ROWS,
  actingUser: unused('actingUser'),
  adminSessionState: async () => sessionState,
  saveAdminSessionState: async (state) => {
    saves.push(state);
    sessionState = { ...sessionState, ...state };
    return sessionState;
  },
  sessionSites: async () => [
    { siteID: SITE, site: 'Tenant A' },
    { siteID: UMBRELLA, site: 'Umbrella' },
  ],
};

let stateDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-people-admin-users-'));
  await writeTestSecrets(stateDir);
  const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
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
    logger,
  });
  const photoFileExts = async (ids: readonly (string | null | undefined)[]) => new Map(ids.flatMap((id) => (id === 'PHOTO-1' ? [[id, 'jpg'] as const] : [])));
  await registerAdminUserRoutes(app, { db, repository, identity, clock: fixedClock(NOW), photoFileExts });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  sessionState = {};
  saves.length = 0;
  tenantsRead.length = 0;
});

/** Headers of web's call for a user of `site` holding `roles`. */
async function headersFor(roles: readonly string[], site = SITE): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await mintUserToken({ sub: ADMIN, sid: 'S-1', site, roles })}`,
    [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'web', audience: 'people' })}`,
  };
}

const S2 = [Roles.s2, Roles.systemUser];
const SITE_ADMIN = [Roles.siteAdmin, Roles.systemUser];

/** Injects a request and checks the answer against the contract. */
async function call(method: 'GET' | 'POST', url: string, headers: Record<string, string>, form?: Record<string, string>) {
  const res = await app.inject({
    method,
    url,
    headers: form === undefined ? headers : { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form === undefined ? undefined : new URLSearchParams(form).toString(),
  });
  const pathOnly = url.split('?')[0] ?? url;
  assertResponseMatchesOpenApi(OPENAPI, { method, path: pathOnly, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return { status: res.statusCode, body: res.statusCode === 200 ? (res.json() as Record<string, any>) : undefined };
}

describe('route() URL helpers [legacy: core/mura/utility.cfc:1326-1469]', () => {
  const options = { siteDomain: 'localhost', allowedDomains: ['localhost', 'Www.Example.test'] };

  it.each([
    ['/feedback-thank-you/', '/feedback-thank-you/'],
    ['http://localhost/page', 'http://localhost/page'],
    ['http://evil.com/page', 'http://localhost/page'],
    ['//external.com/path', '/external.com/path'],
    ['//evil.com/phishing', '/evil.com/phishing'],
    ['//', '/'],
    ['  /trimmed  ', '/trimmed'],
    ['https://www.example.test/ok', 'https://www.example.test/ok'],
    ['http://localhost//evil.com/x', 'http://localhost/x'],
    ['HTTP://evil.com', 'HTTP://localhost'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
  ])('sanitizeHref(%j) is %j', (href, expected) => {
    expect(sanitizeHref(href, options)).toBe(expected);
  });

  it('returns a blank href unchanged and fails where ACF left(…, 0) fails', () => {
    expect(sanitizeHref('   ', options)).toBe('   ');
    expect(() => sanitizeHref('http:///path', options)).toThrow(RangeError);
  });

  it.each([
    ['//x/y', '/x/y'],
    ['///x', '/x'],
    ['//', '/'],
    [' /a ', '/a'],
    ['http://h/p', 'http://h/p'],
  ])('removeLeadingDoubleSlash(%j) is %j', (url, expected) => {
    expect(removeLeadingDoubleSlash(url)).toBe(expected);
  });

  it.each([
    ['http://Host.example:8080/a', 'Host.example'],
    ['/relative/path', '/relative/path'],
    ['//abc/def', 'abc'],
    ['mailto:someone', 'mailto:someone'],
  ])('parseDomain(%j) is %j', (url, expected) => {
    expect(parseDomain(url)).toBe(expected);
  });

  it('routes to the sanitised return URL, the users list or the group', () => {
    const seen: string[] = [];
    const sanitize = (href: string): string => {
      seen.push(href);
      return `clean:${href}`;
    };
    const base = { siteid: SITE, ispublic: '0', routeid: '', returnurl: '' };
    expect(routeRedirect({ ...base, returnurl: ' //evil.test/x' }, sanitize)).toEqual({ url: 'clean:/evil.test/x' });
    expect(seen).toEqual(['/evil.test/x']);
    expect(routeRedirect(base, sanitize)).toEqual({ action: 'cUsers.listusers', params: { siteid: SITE, ispublic: '0' } });
    expect(routeRedirect({ ...base, routeid: GROUP, returnurl: '/ignored' }, sanitize)).toEqual({
      action: 'cUsers.editgroup',
      params: { siteid: SITE, userid: GROUP },
    });
    expect(seen).toHaveLength(1);
  });
});

describe('registration', () => {
  const OPERATIONS = ['listUserGroups', 'listUsers', 'searchUsers', 'getAdvancedSearch', 'setAdvancedSearch', 'getUserEdit', 'getAddressEdit', 'routeUser'];

  it('registers exactly the contract operations of these reads, with their transport and roles', () => {
    const declared = Object.entries(OPENAPI.paths).flatMap(([url, methods]) =>
      Object.entries(methods)
        .filter(([, op]) => OPERATIONS.includes(op.operationId ?? ''))
        .map(([method, op]) => ({ method: method.toUpperCase(), url, transport: op['x-opt2-transport'], requires: op['x-opt2-requires'] })),
    );
    const registered = recordedRoutes(app)
      // service-kit registers `/healthz` itself.
      .filter((route) => route.method !== 'HEAD' && route.url !== '/healthz')
      .map((route) => ({ method: route.method, url: route.url, transport: route.config.transport, requires: route.config.requires }));
    const order = (a: { method: string; url: string }, b: { method: string; url: string }): number => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`);
    expect(declared).toHaveLength(OPERATIONS.length);
    expect(registered.sort(order)).toEqual(declared.sort(order));
  });
});

describe('the cUsers gate', () => {
  it.each([
    ['anonymous', async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'web', audience: 'people' })}` }), 401],
    ['Users module only', () => headersFor([USERS_MODULE, Roles.systemUser]), 403],
    ['a member', () => headersFor([Roles.member]), 403],
  ])('refuses %s', async (_case, headers, status) => {
    for (const url of ['/v1/users/groups', '/v1/users', '/v1/users/search', '/v1/users/advanced-search', '/v1/users/edit', '/v1/users/address', '/v1/users/route']) {
      expect((await call('GET', url, await headers())).status, url).toBe(status);
    }
  });

  it('admits the Users and Site Manager module grants together', async () => {
    expect((await call('GET', '/v1/users/groups', await headersFor([USERS_MODULE, SITE_MANAGER_MODULE, Roles.systemUser]))).status).toBe(200);
  });

  it.each(['/v1/users/groups', '/v1/users', '/v1/users/edit', '/v1/users/route'])('refuses another site than the token’s on %s', async (url) => {
    expect((await call('GET', `${url}?siteid=${OTHER}`, await headersFor(S2))).status).toBe(403);
  });

  it('refuses siteid=all to a caller without S2', async () => {
    expect((await call('GET', '/v1/users?siteid=all', await headersFor(SITE_ADMIN))).status).toBe(403);
  });

  it('answers the legacy 503 for a token tenant the registry does not hold', async () => {
    expect((await call('GET', '/v1/users/edit?siteid=unknown-site', await headersFor(S2, 'unknown-site'))).status).toBe(503);
  });
});

describe('lists and searches', () => {
  it('lists the groups with nextN paging, resetting a start row past the end', async () => {
    const { body } = await call('GET', '/v1/users/groups?ispublic=0&startrow=50&recordsperpage=1', await headersFor(SITE_ADMIN));
    expect(body?.items).toHaveLength(2);
    expect(body?.items[0]).toMatchObject({ UserID: GROUP, Type: 1, Counter: 2, Perm: 1, isPublic: 0 });
    expect(body?.items[1]).not.toHaveProperty('Type');
    expect(body?.nextn).toMatchObject({ totalrecords: 2, recordsperpage: 1, startrow: 1, numberofpages: 2, next: 2 });
  });

  it("lists the private pool's users by name with their unassigned ids", async () => {
    const { body } = await call('GET', '/v1/users?ispublic=0', await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT, JANE]);
    expect(Object.keys(body?.items[0])).toEqual([
      'UserID', 'GroupName', 'Fname', 'Lname', 'UserName', 'Email', 'Type', 'subType', 'Admin', 'S2', 'LastUpdate', 'LastUpdateBy', 'isPublic', 'SiteID',
    ]);
    expect(body?.items[0].LastUpdate).toBe('2026-06-30T09:15:00.000');
    expect(body?.listUnassignedUsers).toEqual([JANE]);
  });

  it('lists only unassigned users, reusing that list for the marks', async () => {
    const { body } = await call('GET', '/v1/users?ispublic=0&unassigned=1', await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([JANE]);
    expect(body?.listUnassignedUsers).toEqual([JANE]);
  });

  it('reads the public pool for members and every site for an S2 siteid=all', async () => {
    const members = await call('GET', '/v1/users?ispublic=1', await headersFor(SITE_ADMIN));
    expect(members.body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([MEMBER]);
    const all = await call('GET', '/v1/users?siteid=ALL&ispublic=0', await headersFor(S2));
    expect(all.body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT, JANE, OUTSIDER]);
  });

  it('searches the pool with full user rows in bootstrap casing', async () => {
    const { body } = await call('GET', '/v1/users/search?ispublic=0&search=doe', await headersFor(S2));
    expect(body?.items).toHaveLength(1);
    expect(body?.items[0]).toMatchObject({ UserID: JANE, mobilePhone: null, isPublic: 0, photoFileExt: 'jpg', created: '2026-06-30T09:15:00.000' });
    expect(body?.listUnassignedUsers).toEqual([JANE]);
  });
});

describe('advanced search', () => {
  const form = {
    muraAction: 'cUsers.advancedSearch',
    param: '1,2',
    paramField1: 'tusers.lname^varchar',
    paramRelationship1: 'and',
    paramCriteria1: 'Doe',
    paramCondition1: 'Contains',
    paramField2: 'Select Field',
    paramRelationship2: 'and',
    paramCriteria2: 'x',
    paramCondition2: 'Equals',
    inActive: '0',
  };

  it("stores a posted form's criteria for the session, then runs them", async () => {
    const { body } = await call('POST', '/v1/users/advanced-search?ispublic=0', await headersFor(SITE_ADMIN), form);
    expect(saves).toEqual([
      {
        paramArray: [{ Field: 'tusers.lname^varchar', Relationship: 'and', Criteria: 'Doe', Condition: 'Contains' }],
        paramCount: 1,
        paramCircuit: 'cUsers',
        paramCategories: '',
        paramGroups: '',
        inActive: '0',
        membersOnly: 'false',
        visitorStatus: 'All',
      },
    ]);
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([JANE]);
    expect(body?.criteria.paramArray).toHaveLength(1);
    expect(body?.groups).toEqual([{ UserID: GROUP, GroupName: 'Admin', SiteID: SITE, isPublic: 0, Perm: 1 }]);
    expect(body?.listUnassignedUsers).toEqual([]);
  });

  it('keeps the stored criteria for a post without param, and the GET runs them; S2 people only for S2', async () => {
    sessionState = {
      paramArray: [{ Field: 'tusers.fname^varchar', Relationship: 'and', Criteria: 'Root', Condition: 'Equals' }],
      paramCount: 1,
      paramCircuit: 'cUsers',
    };
    const posted = await call('POST', '/v1/users/advanced-search?ispublic=0', await headersFor(S2), { inActive: '0' });
    expect(saves).toEqual([]);
    expect(posted.body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT]);
    const read = await call('GET', '/v1/users/advanced-search?ispublic=0', await headersFor(S2));
    expect(read.body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT]);
    const hidden = await call('GET', '/v1/users/advanced-search?ispublic=0', await headersFor(SITE_ADMIN));
    expect(hidden.body?.items).toEqual([]);
    expect(read.body?.criteria).toEqual({
      paramArray: [{ Field: 'tusers.fname^varchar', Relationship: 'and', Criteria: 'Root', Condition: 'Equals' }],
      inActive: '',
      paramCategories: '',
      paramGroups: '',
      membersOnly: 'false',
      visitorStatus: 'All',
    });
  });

  it('runs empty criteria over the member pool with the member groups', async () => {
    const { body } = await call('GET', '/v1/users/advanced-search?ispublic=1', await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([MEMBER]);
    expect(body?.groups).toEqual([{ UserID: MEMBER_GROUP, GroupName: 'Fans', SiteID: UMBRELLA, isPublic: 1, Perm: 0 }]);
  });
});

describe('edit reads', () => {
  it('reads a stored person with the tab data of the Edit User screen', async () => {
    const { body } = await call('GET', `/v1/users/edit?userid=${JANE}&ispublic=0`, await headersFor(SITE_ADMIN));
    expect(body).toMatchObject({
      isNew: false,
      tempIsPublic: 0,
      lockedSuper: false,
      blockedUntil: null,
      groupIds: [],
      categoryIds: ['E0000000-0000-0000-0000000000000001'],
      subTypes: [{ subTypeID: SUBTYPE, type: '2', subType: 'Staff' }],
      sites: [{ siteID: SITE, site: 'Tenant A' }, { siteID: UMBRELLA, site: 'Umbrella' }],
      errors: {},
      retained: false,
      extendedAttributes: {},
    });
    expect(body?.user).toMatchObject({ UserID: JANE, Fname: 'Jane', Type: 2, isPublic: 0, SiteID: SITE, photoFileExt: 'jpg', Ext: null, LastLogin: '2026-06-29T08:00:00.000' });
    expect(body?.addresses).toEqual([expect.objectContaining({ addressID: ADDRESS, addressName: 'Home', isPrimary: 1, longitude: 1.5 })]);
    expect(body?.privateGroups).toEqual([{ UserID: GROUP, GroupName: 'Admin', Site: 'Tenant A', SiteID: SITE, isPublic: 0, Perm: 1 }]);
    expect(body?.publicGroups).toEqual([{ UserID: MEMBER_GROUP, GroupName: 'Fans', Site: 'Umbrella', SiteID: UMBRELLA, isPublic: 1, Perm: 0 }]);
  });

  it("locks an S2 person's account fields for a caller without S2, and not for an S2 caller", async () => {
    const admin = await call('GET', `/v1/users/edit?userid=${ROOT}`, await headersFor(SITE_ADMIN));
    expect(admin.body).toMatchObject({ lockedSuper: true, groupIds: [GROUP] });
    expect(admin.body?.user).toMatchObject({ S2: 1, Admin: 1, Ext: 12 });
    expect((await call('GET', `/v1/users/edit?userid=${ROOT}`, await headersFor(S2))).body?.lockedSuper).toBe(false);
  });

  it('reads a new bean for an empty or unknown id, and keeps setispublic only for an admin', async () => {
    const fresh = await call('GET', '/v1/users/edit?userid=&setispublic=0', await headersFor(SITE_ADMIN));
    expect(fresh.body).toMatchObject({ isNew: true, tempIsPublic: 0, addresses: [], groupIds: [] });
    expect(fresh.body?.user).toMatchObject({ Type: 2, isPublic: 1, SiteID: '', LastLogin: null, PasswordCreated: '2026-06-30T09:15:00.000' });
    expect(fresh.body?.user.UserID).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
    const moduleUser = await call('GET', `/v1/users/edit?userid=${OUTSIDER}&setispublic=0`, await headersFor([USERS_MODULE, SITE_MANAGER_MODULE, Roles.systemUser]));
    expect(moduleUser.body).toMatchObject({ isNew: true, tempIsPublic: 1 });
    // A person of a site outside the token's user pools is never read.
    expect(tenantsRead).not.toContain(tenantIdForSite(OTHER));
  });

  it('reads the addressed address, or a new one under the requested id', async () => {
    const found = await call('GET', `/v1/users/address?userid=${JANE}&addressid=${ADDRESS}`, await headersFor(SITE_ADMIN));
    expect(found.body).toMatchObject({
      isNew: false,
      extendedAttributes: { movedIn: "{ts '2026-06-01 00:00:00'}", access: 'Gate 4' },
      address: { addressID: ADDRESS, city: 'Springfield' },
    });
    expect(found.body?.user).toMatchObject({ UserID: JANE });
    const missing = 'C0000000-0000-0000-0000000000000009';
    const other = await call('GET', `/v1/users/address?userid=${JANE}&addressid=${missing}`, await headersFor(SITE_ADMIN));
    expect(other.body).toMatchObject({ isNew: true, address: { addressID: missing, userID: JANE, city: null } });
    const fresh = await call('GET', `/v1/users/address?userid=${JANE}`, await headersFor(SITE_ADMIN));
    expect(fresh.body?.address.addressID).not.toBe(ADDRESS);
  });
});

describe('route()', () => {
  it('clears the retained edit bean and sends a return URL through sanitizeHref over the registry', async () => {
    sessionState = { mura: { editBean: { userBean: {} }, errors: '' } };
    const { body } = await call('GET', `/v1/users/route?returnurl=${encodeURIComponent('http://evil.test//x.test/p')}`, await headersFor(SITE_ADMIN));
    expect(body).toEqual({ redirect: { url: 'http://a.example.test/p' } });
    expect(saves).toEqual([{ mura: { errors: '' } }]);
    const allowed = await call('GET', `/v1/users/route?returnurl=${encodeURIComponent('https://ALIAS.example.test/q')}`, await headersFor(SITE_ADMIN));
    expect(allowed.body).toEqual({ redirect: { url: 'https://ALIAS.example.test/q' } });
  });

  it('redirects to the users list or the group without touching a session holding no edit bean', async () => {
    sessionState = { mura: { errors: '' } };
    const list = await call('GET', '/v1/users/route?ispublic=0', await headersFor(SITE_ADMIN));
    expect(list.body).toEqual({ redirect: { action: 'cUsers.listusers', params: { siteid: SITE, ispublic: '0' } } });
    const group = await call('GET', `/v1/users/route?routeid=${GROUP}`, await headersFor(SITE_ADMIN));
    expect(group.body).toEqual({ redirect: { action: 'cUsers.editgroup', params: { siteid: SITE, userid: GROUP } } });
    sessionState = {};
    expect((await call('GET', '/v1/users/route', await headersFor(S2))).status).toBe(200);
    expect(saves).toEqual([]);
  });
});
