/** The cUsers read routes over in-memory people rows, registry and identity: contract shapes, the `before()` gate, tenancy and `route()`. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, moduleRole, recordedRoutes } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import type { AccountView, AdminSessionState, GroupSummary, IdentityClient, UserGroupRow } from '../../src/legacy/identity-client.js';
import type { PeopleRepository, PersonOrderScope, PersonSortKey } from '../../src/repo/repository.js';
import type { AddressRow, ExtendSubtypeRow, PersonRow } from '../../src/repo/tables.js';
import {
  parseDomain,
  registerAdminUserRoutes,
  removeLeadingDoubleSlash,
  routeRedirect,
  sanitizeHref,
} from '../../src/routes/admin-users.js';
import { IdentityDouble, personsInOrder } from '../helpers/search-doubles.js';

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
const registryReads: string[] = [];
const REGISTRY_ENTRIES = /^SELECT site_id, tenant_id, .+ FROM people\.tenant_registry ORDER BY site_id$/;

/** A TenantDb whose metadata transactions record and answer the registry queries, and whose tenant transactions record the tenant. */
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
        registryReads.push(sql);
        if (REGISTRY_ENTRIES.test(sql)) return { rows: REGISTRY };
        if (/ORDER BY site_id/.test(sql)) return { rows: REGISTRY.map((row) => ({ tenant_id: row.tenant_id, site_id: row.site_id })) };
        if (/lower\(site_id\) = lower\(\$1\)/.test(sql)) return { rows: REGISTRY.filter((row) => sameId(row.site_id, String(params[0]))) };
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
  pagePersonsForSite: async (tx: TenantTx, siteId: string) => ({
    rows: ofTenant(PERSONS, tx).filter((row) => sameId(row.siteid, siteId)), next: null,
  }),
  pageQueryPersons: async (tx: TenantTx, query: { siteIds?: readonly string[] }) => ({
    rows: ofTenant(PERSONS, tx).filter((row) => query.siteIds === undefined || query.siteIds.some((siteId) => sameId(row.siteid, siteId))), next: null,
  }),
  pagePersonsInOrder: async (tx: TenantTx, scope: PersonOrderScope, opts: { orderBy: readonly PersonSortKey[] }) => ({
    rows: personsInOrder(ofTenant(PERSONS, tx), scope, opts.orderBy), next: null,
  }),
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
  // No roster operation is ever open over these rows.
  lockRosterUsers: () => Promise.resolve(),
  lockRosterTenant: () => Promise.resolve(),
  findOpenRosterOperations: () => Promise.resolve([]),
  countRosterOperations: () => Promise.resolve(0),
} as unknown as PeopleRepository;

let sessionState: AdminSessionState = {};
const saves: AdminSessionState[] = [];
const groupReads: Array<readonly [siteId: string, isPublic: number]> = [];
/** Errors the routes threw, as the service-kit error handler receives them. */
const routeErrors: Error[] = [];
const loginBlocks = new Map<string, string>();
const loginBlockCalls: { userId: string; removeBlock: boolean }[] = [];
const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`unexpected identity call ${name}`));
/** The account and membership lookups of the current test, with the ids each carried. */
const identityReads: { op: 'readAccounts' | 'readAccountsAllSites' | 'lookupMemberships'; userIds: string[] }[] = [];
// Every token here that reaches identity is of tenant-a, so `lookupAccounts` reads only its user pools; S2 alone reads every site.
const accountReads = new IdentityDouble(ACCOUNTS, MEMBERSHIPS, { db, tid: tenantIdForSite(SITE), s2: true });

/** Identity's reads over the in-memory accounts, groups and session state. */
const identity: IdentityClient = {
  prepare: unused('prepare'),
  commit: unused('commit'),
  abort: unused('abort'),
  finish: unused('finish'),
  revert: unused('revert'),
  operationState: unused('operationState'),
  readAccount: async (userId) => ACCOUNTS.get(userId),
  readAccounts: async (userIds, where) => {
    identityReads.push({ op: 'readAccounts', userIds: [...userIds] });
    return accountReads.readAccounts(userIds, where);
  },
  readAccountsAllSites: async (userIds, where) => {
    identityReads.push({ op: 'readAccountsAllSites', userIds: [...userIds] });
    return accountReads.readAccountsAllSites(userIds, where);
  },
  countAccounts: (request) => accountReads.countAccounts(request),
  usernameCandidates: (request) => accountReads.usernameCandidates(request),
  lookupMemberships: async (userIds) => {
    identityReads.push({ op: 'lookupMemberships', userIds: [...userIds] });
    return accountReads.lookupMemberships(userIds);
  },
  userMemberships: unused('userMemberships'),
  membershipGroupIds: async (userId) => MEMBERSHIPS.get(userId) ?? [],
  siteGroups: async (_siteId, isPublic) => (isPublic === 1 ? PUBLIC_GROUPS : PRIVATE_GROUPS),
  userGroups: (siteId, isPublic) => {
    groupReads.push([siteId, isPublic]);
    return Promise.resolve(GROUP_ROWS);
  },
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
  loginBlock: async (userId, removeBlock) => {
    loginBlockCalls.push({ userId, removeBlock });
    if (removeBlock) loginBlocks.delete(userId);
    return loginBlocks.get(userId) ?? null;
  },
};

/** The tenants and users the roster closure was awaited on, and the error it answers for a closed user. */
const openWaits: Array<{ tenantId: string; userId: string }> = [];
let closedError: Error | undefined;
const awaitOpen = async (_db: TenantDb, tenantId: string, userId: string): Promise<void> => {
  openWaits.push({ tenantId, userId });
  if (closedError !== undefined) throw closedError;
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
  app.addHook('onError', async (_request, _reply, error) => {
    routeErrors.push(error);
  });
  await registerAdminUserRoutes(app, { db, repository, identity, clock: fixedClock(NOW), photoFileExts, awaitPersonOpen: awaitOpen });
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
  groupReads.length = 0;
  routeErrors.length = 0;
  identityReads.length = 0;
  loginBlocks.clear();
  loginBlockCalls.length = 0;
  openWaits.length = 0;
  closedError = undefined;
  registryReads.length = 0;
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
/** The path prefixes of the user list reads: `/v1` answers every match, `/v2` only the page `nextn` selects. */
const VERSIONS = ['/v1', '/v2'] as const;

/** Injects a request and checks the answer against the contract. */
async function checked(method: 'GET' | 'POST', url: string, headers: Record<string, string>, form?: Record<string, string>) {
  const res = await app.inject({
    method,
    url,
    headers: form === undefined ? headers : { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form === undefined ? undefined : new URLSearchParams(form).toString(),
  });
  const pathOnly = url.split('?')[0] ?? url;
  assertResponseMatchesOpenApi(OPENAPI, { method, path: pathOnly, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** {@link checked}'s status, with the JSON body of a 200. */
async function call(method: 'GET' | 'POST', url: string, headers: Record<string, string>, form?: Record<string, string>) {
  const res = await checked(method, url, headers, form);
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
  const OPERATIONS = [
    'listUserGroups', 'listUsers', 'searchUsers', 'getAdvancedSearch', 'setAdvancedSearch', 'getUserEdit', 'getAddressEdit', 'routeUser', 'readCurrentUser',
    'listUsersV2', 'searchUsersV2', 'getAdvancedSearchV2', 'setAdvancedSearchV2',
  ];

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
    const urls = [
      '/v1/users/groups', '/v1/users', '/v1/users/search', '/v1/users/advanced-search', '/v1/users/edit', '/v1/users/address', '/v1/users/route',
      '/v2/users', '/v2/users/search', '/v2/users/advanced-search',
    ];
    for (const url of urls) {
      expect((await call('GET', url, await headers())).status, url).toBe(status);
    }
  });

  it('admits the Users and Site Manager module grants together', async () => {
    expect((await call('GET', '/v1/users/groups', await headersFor([USERS_MODULE, SITE_MANAGER_MODULE, Roles.systemUser]))).status).toBe(200);
  });

  it.each(['/v1/users/groups', '/v1/users', '/v1/users/edit', '/v1/users/route', '/v2/users'])('refuses another site than the token’s on %s', async (url) => {
    expect((await call('GET', `${url}?siteid=${OTHER}`, await headersFor(S2))).status).toBe(403);
  });

  it.each(VERSIONS)('refuses siteid=all on %s/users to a caller without S2', async (version) => {
    expect((await call('GET', `${version}/users?siteid=all`, await headersFor(SITE_ADMIN))).status).toBe(403);
  });

  it.each([
    '/v1/users/edit?siteid=unknown-site',
    '/v1/users?siteid=unknown-site&ispublic=0',
    '/v1/users/search?siteid=unknown-site&ispublic=0&search=jane',
    '/v1/users/search?siteid=unknown-site&ispublic=0&search=',
    '/v2/users?siteid=unknown-site&ispublic=0',
    '/v2/users/search?siteid=unknown-site&ispublic=0&search=jane',
    '/v2/users/search?siteid=unknown-site&ispublic=0&search=',
  ])('answers the legacy 503 for a token tenant the registry does not hold: %s', async (url) => {
    expect((await call('GET', url, await headersFor(S2, 'unknown-site'))).status).toBe(503);
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

  // `before()` scrubs a value the admin Portcullis scan does not leave boolean, such as 'abc' or ' false' (scanned to '"NO"'),
  // to 1 [legacy: admin/core/controllers/cusers.cfc:163]; the scan trims ' 0 ' to 0.
  it.each<[string, number]>([
    ['0', 0],
    ['0.0', 0],
    ['1', 1],
    ['1.0', 1],
    ['2', 2],
    ['-1', -1],
    [' 1', 1],
    [' 0 ', 0],
    ['0\u0001', 0],
    ['abc', 1],
    [' false', 1],
    ['\ttrue', 1],
    ['"0"', 1],
  ])('reads identity groups for ispublic %j as the number %j', async (ispublic, flag) => {
    expect((await call('GET', `/v1/users/groups?ispublic=${encodeURIComponent(ispublic)}`, await headersFor(SITE_ADMIN))).status).toBe(200);
    expect(groupReads).toEqual([[SITE, flag]]);
  });

  // Oracle: an admin's cUsers.list or cUsers.search with a boolean word answers ACF's 500 page, its h2 the message below;
  // the scan trims ' no', '\tFALSE\n' and ' True' to words first.
  it.each(
    ['yes', 'No', 'TRUE', 'false', ' no', '\tFALSE\n', ' True'].flatMap((ispublic) => [
      ['/v1/users/groups', ispublic, 'getUserGroups'] as const,
      ['/v1/users/search', ispublic, 'getSearch'] as const,
      ['/v2/users/search', ispublic, 'getSearch'] as const,
    ]),
  )(
    'answers %s the legacy server_error 500 for ispublic %j, with the %s argument error off the wire, before any read',
    async (url, ispublic, fn) => {
      const res = await checked('GET', `${url}?ispublic=${encodeURIComponent(ispublic)}&search=doe`, await headersFor(SITE_ADMIN));
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: { message: 'Unhandled Exception', code: 'server_error' } });
      expect(res.body).not.toMatch(/ISPUBLIC|numeric/);
      expect(routeErrors).toHaveLength(1);
      expect(routeErrors[0]).toMatchObject({ name: 'LegacyApiError', type: 'server_error' });
      expect((routeErrors[0]?.cause as Error).message).toBe(`The ISPUBLIC argument passed to the ${fn} function is not of type numeric.`);
      expect([groupReads, tenantsRead]).toEqual([[], []]);
    },
  );

  it.each(VERSIONS)("%s lists the private pool's users by name with their unassigned ids", async (version) => {
    const { body } = await call('GET', `${version}/users?ispublic=0`, await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT, JANE]);
    expect(Object.keys(body?.items[0])).toEqual([
      'UserID', 'GroupName', 'Fname', 'Lname', 'UserName', 'Email', 'Type', 'subType', 'Admin', 'S2', 'LastUpdate', 'LastUpdateBy', 'isPublic', 'SiteID',
    ]);
    expect(body?.items[0].LastUpdate).toBe('2026-06-30T09:15:00.000');
    expect(body?.listUnassignedUsers).toEqual([JANE]);
  });

  // Oracle: cUsers.listUsers lists only unassigned users for an unassigned value the scan leaves true, ' TRUE' trimmed included.
  type UnassignedCase = [version: string, unassigned: string, users: string[]];
  it.each<UnassignedCase>(
    VERSIONS.flatMap((version): UnassignedCase[] => [
      [version, '1', [JANE]],
      [version, ' yes', [JANE]],
      [version, ' TRUE', [JANE]],
      [version, ' true', [ROOT, JANE]],
      [version, '"1"', [ROOT, JANE]],
    ]),
  )('%s lists for unassigned %j the users %j, reusing an unassigned list for the marks', async (version, unassigned, users) => {
    const { body } = await call('GET', `${version}/users?ispublic=0&unassigned=${encodeURIComponent(unassigned)}`, await headersFor(SITE_ADMIN));
    expect((body?.items as Array<{ UserID: string }>).map((row) => row.UserID)).toEqual(users);
    expect(body?.listUnassignedUsers).toEqual([JANE]);
  });

  // Oracle: an admin's cUsers.listUsers binds a boolean word through `cf_sql_integer` and lists that pool, answering 200;
  // the scan trims padded words, and turns a padded lowercase literal into a quoted "YES" or "NO" that scrubs to 1.
  type WordCase = [version: string, ispublic: string, users: string[], unassigned: string[]];
  it.each<WordCase>(
    VERSIONS.flatMap((version): WordCase[] => [
      ...['yes', 'Yes', 'YES', 'true', 'True', 'TRUE', ' YES', 'True\n'].map((word): WordCase => [version, word, [MEMBER], [MEMBER]]),
      ...['no', 'No', 'NO', 'false', 'False', 'FALSE', '\tno', ' FALSE ', 'fALSE\u0001'].map((word): WordCase => [version, word, [ROOT, JANE], [JANE]]),
      ...[' false', 'false\n', '\u0001false'].map((word): WordCase => [version, word, [MEMBER], [MEMBER]]),
    ]),
  )('%s lists the pool of ispublic %j as its scanned 1 or 0 does, with the unassigned ids', async (version, ispublic, users, unassigned) => {
    const { status, body } = await call('GET', `${version}/users?ispublic=${encodeURIComponent(ispublic)}`, await headersFor(SITE_ADMIN));
    expect(status).toBe(200);
    expect((body?.items as Array<{ UserID: string }>).map((row) => row.UserID)).toEqual(users);
    expect(body?.listUnassignedUsers).toEqual(unassigned);
    expect(routeErrors).toEqual([]);
  });

  it.each<[version: string, ispublic: string, users: string[]]>(
    VERSIONS.flatMap((version): [string, string, string[]][] => [
      [version, 'no', [ROOT, JANE, OUTSIDER]],
      [version, 'TRUE', [MEMBER]],
    ]),
  )('%s reads every site for an S2 siteid=all with ispublic %j', async (version, ispublic, users) => {
    const { body } = await call('GET', `${version}/users?siteid=all&ispublic=${ispublic}`, await headersFor(S2));
    expect((body?.items as Array<{ UserID: string }>).map((row) => row.UserID)).toEqual(users);
  });

  it.each(VERSIONS)('%s reads the public pool for members', async (version) => {
    const { body } = await call('GET', `${version}/users?ispublic=1`, await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([MEMBER]);
  });

  // tenant-b's person is found only because the S2 read asks identity for every site's accounts, not the token's pools; the
  // default tenant holds no person, so it costs no lookup. Each tenant's persons are read by name.
  const EVERY_SITE_READS = [
    { op: 'readAccountsAllSites', userIds: [OUTSIDER] },
    { op: 'readAccountsAllSites', userIds: [ROOT, JANE] },
    { op: 'readAccountsAllSites', userIds: [MEMBER] },
  ];

  it.each<[string, string[], (typeof EVERY_SITE_READS)[number][]]>([
    // The list and its unassigned query each read every site once.
    ['/v1', [JANE, OUTSIDER], [...EVERY_SITE_READS, ...EVERY_SITE_READS]],
    ['/v2', [JANE, OUTSIDER], EVERY_SITE_READS],
  ])('%s reads every site once for an S2 siteid=all, with its people without a membership', async (version, unassigned, reads) => {
    const { body } = await call('GET', `${version}/users?siteid=ALL&ispublic=0`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT, JANE, OUTSIDER]);
    expect(body?.listUnassignedUsers).toEqual(unassigned);
    expect(identityReads.filter(({ op }) => op !== 'lookupMemberships')).toEqual(reads);
  });

  it.each<[string, string, number, string[]]>([
    ['a later page', 'ispublic=0&startrow=2&recordsperpage=1', 2, [JANE]],
    ['page 1 for a start row past the end', 'ispublic=0&startrow=50&recordsperpage=1', 1, [JANE]],
    ['a page of every site for S2', 'siteid=all&ispublic=0&startrow=3&recordsperpage=1', 3, [JANE, OUTSIDER]],
  ])('/v1 answers every match for %s, with nextn over them and every unassigned user', async (_label, query, startrow, unassigned) => {
    const { body } = await call('GET', `/v1/users?${query}`, await headersFor(S2));
    const items = query.startsWith('siteid=all') ? [ROOT, JANE, OUTSIDER] : [ROOT, JANE];
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: items.length, recordsperpage: 1, startrow });
    expect(body?.listUnassignedUsers).toEqual(unassigned);
  });

  it.each<[string, string, string[], number, string[]]>([
    ['the first page', 'ispublic=0&recordsperpage=1', [ROOT], 1, []],
    ['a later page', 'ispublic=0&startrow=2&recordsperpage=1', [JANE], 2, [JANE]],
    ['page 1 for a start row past the end', 'ispublic=0&startrow=50&recordsperpage=1', [ROOT], 1, []],
    ['a page of every site for S2', 'siteid=all&ispublic=0&startrow=3&recordsperpage=1', [OUTSIDER], 3, [OUTSIDER]],
  ])('/v2 answers only the people of %s, with nextn over every match', async (_label, query, items, startrow, unassigned) => {
    const { body } = await call('GET', `/v2/users?${query}`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: query.startsWith('siteid=all') ? 3 : 2, recordsperpage: 1, startrow });
    expect(body?.listUnassignedUsers).toEqual(unassigned);
    // One membership lookup, over the page's people only.
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([{ op: 'lookupMemberships', userIds: items }]);
  });

  it('/v2 marks every person of an unassigned-only page without another membership lookup', async () => {
    const { body } = await call('GET', '/v2/users?ispublic=0&unassigned=1&recordsperpage=1', await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([JANE]);
    expect(body?.listUnassignedUsers).toEqual([JANE]);
    // Identity's lookup applies the list's unassigned filter; the marks reuse the page.
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([]);
  });

  it.each<[string, string[], string[]]>([
    ['search=o&recordsperpage=1&startrow=2', [ROOT, JANE], [JANE]],
    // Jane is no match, but every unassigned user of the pool is marked.
    ['search=admin', [ROOT], [JANE]],
  ])('/v1 answers every search match of %s, with every unassigned user of the pool', async (query, items, unassigned) => {
    const { body } = await call('GET', `/v1/users/search?ispublic=0&${query}`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: items.length });
    expect(body?.listUnassignedUsers).toEqual(unassigned);
  });

  it.each<[string, string[], string[]]>([
    ['search=o&recordsperpage=1&startrow=1', [ROOT], []],
    ['search=o&recordsperpage=1&startrow=2', [JANE], [JANE]],
    ['search=admin', [ROOT], []],
  ])('/v2 answers only the search matches of the page of %s', async (query, items, unassigned) => {
    const { body } = await call('GET', `/v2/users/search?ispublic=0&${query}`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: query.startsWith('search=o') ? 2 : 1 });
    expect(body?.listUnassignedUsers).toEqual(unassigned);
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([{ op: 'lookupMemberships', userIds: items }]);
  });

  it.each<[string, string[]]>([
    ['/v1', [ROOT, JANE]],
    ['/v2', [JANE]],
  ])('%s answers the advanced-search matches for page 2, marking none', async (version, items) => {
    const { body } = await call('GET', `${version}/users/advanced-search?ispublic=0&startrow=2&recordsperpage=1`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: 2, recordsperpage: 1, startrow: 2 });
    expect(body?.listUnassignedUsers).toEqual([]);
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([]);
  });

  it.each(VERSIONS)('%s searches the pool with full user rows in bootstrap casing', async (version) => {
    const { body } = await call('GET', `${version}/users/search?ispublic=0&search=doe`, await headersFor(S2));
    expect(body?.items).toHaveLength(1);
    expect(body?.items[0]).toMatchObject({ UserID: JANE, mobilePhone: null, isPublic: 0, photoFileExt: 'jpg', created: '2026-06-30T09:15:00.000' });
    expect(body?.listUnassignedUsers).toEqual([JANE]);
  });
});

describe.each(VERSIONS)('advanced search under %s', (version) => {
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
    const { body } = await call('POST', `${version}/users/advanced-search?ispublic=0`, await headersFor(SITE_ADMIN), form);
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
    const posted = await call('POST', `${version}/users/advanced-search?ispublic=0`, await headersFor(S2), { inActive: '0' });
    expect(saves).toEqual([]);
    expect(posted.body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT]);
    const read = await call('GET', `${version}/users/advanced-search?ispublic=0`, await headersFor(S2));
    expect(read.body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT]);
    const hidden = await call('GET', `${version}/users/advanced-search?ispublic=0`, await headersFor(SITE_ADMIN));
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

  // A boolean word `rc.ispublic` is no number, so the criterion's `ispublic` stays the feed's, and `getIsPublic() eq 0` or
  // `eq 1` reads a word as its 0 or 1 [legacy: core/mura/user/userGateway.cfc:211-218]; `rc.ispublic == 1` picks the groups.
  it.each<[ispublic: string, criterion: string, users: string[], group: string]>([
    ['yes', 'no', [JANE], 'Fans'],
    [' YES', 'False', [JANE], 'Fans'],
    ['no', 'TRUE', [MEMBER], 'Admin'],
    ['yes', 'abc', [JANE, MEMBER], 'Fans'],
  ])('reads, for ispublic %j and an ispublic criterion %j, the users %j with the %s groups', async (ispublic, criterion, users, group) => {
    const posted = { param: '1', paramField1: 'ispublic', paramRelationship1: 'and', paramCriteria1: criterion, paramCondition1: 'Equals' };
    const { body } = await call('POST', `${version}/users/advanced-search?ispublic=${encodeURIComponent(ispublic)}`, await headersFor(SITE_ADMIN), posted);
    expect((body?.items as Array<{ UserID: string }>).map((row) => row.UserID)).toEqual(users);
    expect((body?.groups as Array<{ GroupName: string }>).map((row) => row.GroupName)).toEqual([group]);
  });

  it('runs empty criteria over the member pool with the member groups', async () => {
    const { body } = await call('GET', `${version}/users/advanced-search?ispublic=1`, await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([MEMBER]);
    expect(body?.groups).toEqual([{ UserID: MEMBER_GROUP, GroupName: 'Fans', SiteID: UMBRELLA, isPublic: 1, Perm: 0 }]);
  });
});

describe('edit reads', () => {
  it.each([
    { query: '', removeBlock: false },
    { query: '&removeBlock=', removeBlock: true },
    { query: '&REMOVEBLOCK', removeBlock: true },
    { query: '&removeblock=false', removeBlock: true },
    { query: '&ReMoVeBlOcK=anything', removeBlock: true },
  ])('reads the identity-owned block with query "$query"', async ({ query, removeBlock }) => {
    const blockedUntil = '2026-06-30T09:30:00.000';
    loginBlocks.set(JANE, blockedUntil);
    const { status, body } = await call('GET', `/v1/users/edit?userid=${JANE}${query}`, await headersFor(SITE_ADMIN));
    expect(status).toBe(200);
    expect(body?.blockedUntil).toBe(removeBlock ? null : blockedUntil);
    expect(loginBlockCalls).toEqual([{ userId: JANE, removeBlock }]);
  });

  it.each(['', '&removeBlock='])('does not load strikes for a new or username-less bean with query "%s"', async (query) => {
    const fresh = await call('GET', `/v1/users/edit?userid=${query}`, await headersFor(SITE_ADMIN));
    expect(fresh.body).toMatchObject({ isNew: true, blockedUntil: null });
    const account = ACCOUNTS.get(JANE) as AccountView;
    ACCOUNTS.set(JANE, { ...account, username: '' });
    try {
      const unnamed = await call('GET', `/v1/users/edit?userid=${JANE}${query}`, await headersFor(SITE_ADMIN));
      expect(unnamed.body).toMatchObject({ isNew: false, blockedUntil: null });
      expect(loginBlockCalls).toEqual([]);
    } finally {
      ACCOUNTS.set(JANE, account);
    }
  });

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
  it('clears the retained edit bean and sends a return URL through sanitizeHref over the registry, read in one statement', async () => {
    sessionState = { mura: { editBean: { userBean: {} }, errors: '' } };
    const { body } = await call('GET', `/v1/users/route?returnurl=${encodeURIComponent('http://evil.test//x.test/p')}`, await headersFor(SITE_ADMIN));
    expect(body).toEqual({ redirect: { url: 'http://a.example.test/p' } });
    expect(registryReads).toEqual([expect.stringMatching(REGISTRY_ENTRIES)]);
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

describe("the current user read of identity's findCurrentUser [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:2268-2382]", () => {
  const ENDPOINT = `http://localhost:8080/index.cfm/_api/json/v1/${SITE}`;
  const ADMIN_PATH = 'http://localhost:8080/admin';
  const CURRENT = `/internal/v1/users/current?siteid=${SITE}&endpoint=${encodeURIComponent(ENDPOINT)}&adminpath=${encodeURIComponent(ADMIN_PATH)}`;
  const UNKNOWN = 'A0000000-0000-0000-0000000000000099';
  const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
  // The legacy oracle's anonymous findCurrentUser keys, less the session's role lists identity adds.
  const USER_KEYS = [
    'addressid', 'categoryid', 'company', 'contactform', 'created', 'description', 'email', 'entityname', 'fname', 'groupid',
    'groupname', 'id', 'imname', 'imservice', 'inactive', 'interests', 'isnew', 'ispublic', 'jobtitle', 'keepprivate',
    'lastlogin', 'lastupdate', 'lastupdateby', 'lastupdatebyid', 'links', 'lname', 'mobilephone', 'newfile', 'notes',
    'passwordcreated', 'perm', 'photofileext', 'photofileid', 'primaryaddressid', 'remoteid', 's2', 'siteid', 'subscribe',
    'subtype', 'tablist', 'tags', 'type', 'userid', 'username', 'website',
  ];

  /** Identity's invocation credential, with a user token for `sub` holding `roles` when given. */
  async function identityHeaders(user?: { sub: string; roles: readonly string[]; site?: string }): Promise<Record<string, string>> {
    const headers: Record<string, string> = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'identity', audience: 'people' })}` };
    if (user !== undefined) headers.authorization = `Bearer ${await mintUserToken({ sub: user.sub, sid: 'S-9', site: user.site ?? SITE, roles: user.roles })}`;
    return headers;
  }

  /** The links legacy builds for `userId`, with the edit link when given. */
  function linksOf(userId: string, edit?: string): Record<string, string> {
    return {
      entities: ENDPOINT,
      ...(edit === undefined ? {} : { edit }),
      all: `${ENDPOINT}/user`,
      properties: `${ENDPOINT}/user/properties`,
      self: `${ENDPOINT}/user/${userId}`,
      permissions: `${ENDPOINT}/user/${userId}/permissions`,
    };
  }

  it.each([
    ['web with a member token', async () => ({ ...(await identityHeaders({ sub: MEMBER, roles: [Roles.member] })), [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'web', audience: 'people' })}` }), 403],
    ['web without a user token', async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'web', audience: 'people' })}` }), 403],
    ['no invocation credential', async () => ({}), 401],
  ])('serves identity alone, refusing %s', async (_label, headers, status) => {
    expect((await call('GET', CURRENT, await headers())).status).toBe(status);
  });

  it.each([
    ['a member, from the public user pool', MEMBER, [Roles.member], { siteid: UMBRELLA, ispublic: 1, fname: 'Mo', photofileext: '' }, undefined],
    [
      'a system user, with the edit link',
      JANE,
      [Roles.systemUser],
      { siteid: SITE, ispublic: 0, fname: 'Jane', photofileext: 'jpg' },
      `${ADMIN_PATH}/?muraAction=cusers.edituser&siteid=${SITE}&userid=${JANE}`,
    ],
  ])("reads %s as the token's own stored user, with identity's membership ids", async (_label, sub, roles, values, edit) => {
    const { status, body } = await call('GET', `${CURRENT}&groupids=${GROUP},${MEMBER_GROUP}`, await identityHeaders({ sub, roles }));

    expect(status).toBe(200);
    expect(Object.keys(body?.data).sort()).toEqual(USER_KEYS);
    expect(body?.data).toMatchObject({
      ...values,
      id: sub,
      userid: sub,
      isnew: 0,
      type: 'user',
      entityname: 'user',
      groupid: `${GROUP},${MEMBER_GROUP}`,
      s2: 0,
      inactive: 0,
      subscribe: 1,
      created: '2026-06-30T09:15:00',
      lastlogin: '2026-06-29T08:00:00',
      // A NULL PasswordCreated leaves userBean.init's now().
      passwordcreated: '2026-06-30T09:15:00',
    });
    expect(body?.data.links).toEqual(linksOf(sub, edit));
    expect(openWaits).toEqual([tenantIdForSite(SITE), tenantIdForSite(UMBRELLA)].map((tenantId) => ({ tenantId, userId: sub })));
  });

  it.each([
    ['an anonymous call', undefined],
    ['a user people holds no person of', { sub: UNKNOWN, roles: [Roles.systemUser] }],
  ])("reads a new bean under a fresh id and the call's site for %s", async (_label, user) => {
    const { status, body } = await call('GET', `${CURRENT}&groupids=${GROUP}`, await identityHeaders(user));

    expect(status).toBe(200);
    expect(Object.keys(body?.data).sort()).toEqual(USER_KEYS);
    expect(body?.data).toMatchObject({ siteid: SITE, isnew: 1, ispublic: 1, subtype: 'Default', type: 'user', groupid: '', fname: '', lastlogin: '' });
    expect(body?.data.userid).toMatch(CF_UUID);
    expect(body?.data.userid).not.toBe(UNKNOWN);
    expect(body?.data.id).toBe(body?.data.userid);
    expect(body?.data.links).toEqual(linksOf(body?.data.userid));
  });

  it('selects the requested fields plus userid, siteid and isnew', async () => {
    const { body } = await call('GET', `${CURRENT}&fields=fname,groupid&groupids=${GROUP}`, await identityHeaders({ sub: JANE, roles: [Roles.systemUser] }));

    expect(body?.data).toEqual({ fname: 'Jane', groupid: GROUP, userid: JANE, siteid: SITE, isnew: 0, id: JANE, type: 'user', entityname: 'user' });
  });

  // Jane's stored row as the oracle serializes `tuseraddresses`: alphabetical columns, NULL as '', numerics unquoted.
  const JANE_ADDRESSES: Record<string, unknown>[] = [
    {
      address1: '1 Main St', address2: '', addressemail: '', addressid: ADDRESS, addressname: 'Home', addressnotes: '', addressurl: '',
      city: 'Springfield', country: '', fax: '', hours: '', isprimary: 1, latitude: '', longitude: 1.5, phone: '', siteid: SITE,
      state: '', userid: JANE, zip: '',
    },
  ];

  it.each([
    ['a stored user', { sub: JANE, roles: [Roles.systemUser] }, JANE_ADDRESSES],
    ['an anonymous call', undefined, []],
    ['a user people holds no person of', { sub: UNKNOWN, roles: [Roles.systemUser] }, []],
  ])("selects getAddresses()' rows as fields=addresses for %s", async (_label, user, addresses: Record<string, unknown>[]) => {
    const { status, body } = await call('GET', `${CURRENT}&fields=addresses`, await identityHeaders(user));

    expect(status).toBe(200);
    expect(Object.keys(body?.data).sort()).toEqual(['addresses', 'entityname', 'id', 'isnew', 'siteid', 'type', 'userid']);
    expect(body?.data.addresses).toEqual(addresses);
    expect(body?.data.addresses.map((row: Record<string, unknown>) => Object.keys(row))).toEqual(addresses.map((row) => Object.keys(row)));
  });

  it.each([
    ["a siteid other than the token's site", CURRENT.replace(`siteid=${SITE}`, `siteid=${OTHER}`), 403],
    ['a call without the link bases', `/internal/v1/users/current?siteid=${SITE}`, 400],
  ])('refuses %s', async (_label, url, status) => {
    expect((await call('GET', url, await identityHeaders({ sub: JANE, roles: [Roles.systemUser] }))).status).toBe(status);
  });

  it('answers the legacy 503 for a user an open roster operation keeps closed', async () => {
    closedError = new LegacyServiceUnavailableError(`Roster operation R-1 keeps user ${JANE} closed`, 'auto', 'roster-closed');

    expect((await call('GET', CURRENT, await identityHeaders({ sub: JANE, roles: [Roles.systemUser] }))).status).toBe(503);
    expect(tenantsRead).toEqual([]);
  });
});
