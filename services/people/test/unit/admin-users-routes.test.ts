/** The cUsers read routes over in-memory people rows, registry and identity: contract shapes, the `before()` gate, tenancy and `route()`. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, moduleRole, recordedRoutes } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { ServiceUnavailableError, createService, fixedClock, loadEnv, throwIfRequestAborted, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import type {
  AccountView,
  AdminSessionState,
  GroupSummary,
  IdentityClient,
  UserGroupRow,
  UserGroupsPage,
  UserGroupsWindow,
} from '../../src/legacy/identity-client.js';
import { getAdvancedSearch, getSearch, getUnassignedUsers, getUsers, newAdvancedSearchCriteria } from '../../src/domain/search.js';
import type { Page, PeopleRepository, PersonCursor, PersonOrderScope, PersonSortKey } from '../../src/repo/repository.js';
import type { AddressRow, ExtendSubtypeRow, PersonRow } from '../../src/repo/tables.js';
import type { components } from '../../src/generated/openapi.js';
import {
  parseDomain,
  registerAdminUserRoutes,
  removeLeadingDoubleSlash,
  routeRedirect,
  sanitizeHref,
} from '../../src/routes/admin-users.js';
import { IdentityDouble, personSearchKeys, personsById, personsInOrder } from '../helpers/search-doubles.js';

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
/** configBean `expirePasswords` of the routes under test, in days. */
const EXPIRE_PASSWORDS = 30;

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

/** `count` group rows shaped as the first of GROUP_ROWS, each under its own id, in listing order. */
function groupListing(count: number): UserGroupRow[] {
  return Array.from({ length: count }, (_, n) => ({ ...(GROUP_ROWS[0] as UserGroupRow), userId: `B1000000-0000-0000-${String(n).padStart(16, '0')}` }));
}

/** A tenant transaction of the fake database; only the tenant matters to the fake repository. */
function fakeTx(tenantId: string): TenantTx {
  return { tenantId } as unknown as TenantTx;
}

const tenantsRead: string[] = [];
const registryReads: string[] = [];
const REGISTRY_ENTRIES = /^SELECT site_id, tenant_id, .+ FROM people\.tenant_registry WHERE NOT deleted ORDER BY site_id$/;

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
  listPersonSearchKeys: (tx: TenantTx, scope: PersonOrderScope, orderBy: readonly PersonSortKey[]) => Promise.resolve(personSearchKeys(ofTenant(PERSONS, tx), scope, orderBy)),
  findPersons: (tx: TenantTx, userIds: readonly string[]) => Promise.resolve(personsById(ofTenant(PERSONS, tx), userIds)),
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
const groupReads: Array<readonly [siteId: string, isPublic: string]> = [];
/** The window of each identity group page read, in call order. */
const groupWindows: UserGroupsWindow[] = [];
/** The groups identity lists; a test may swap in a longer listing. */
let groupRows: readonly UserGroupRow[] = GROUP_ROWS;

/** Identity's `listGroups` page of `rows` for `window`, at its default size of 1000 without a limit. */
function groupPage(rows: readonly UserGroupRow[], { offset, limit = 1000 }: UserGroupsWindow): UserGroupsPage {
  const page = rows.slice(offset, offset + limit);
  const next = offset + page.length;
  return { rows: page, total: rows.length, nextOffset: next < rows.length ? next : null };
}
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
  userGroupsPage: async (siteId, isPublic, window) => {
    groupReads.push([siteId, isPublic]);
    groupWindows.push(window);
    return groupPage(groupRows, window);
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
  groupFavoriteIds: unused('groupFavoriteIds'),
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
  await registerAdminUserRoutes(app, { db, repository, identity, clock: fixedClock(NOW), photoFileExts, awaitPersonOpen: awaitOpen, expirePasswords: EXPIRE_PASSWORDS });
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
  groupWindows.length = 0;
  groupRows = GROUP_ROWS;
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

type Schemas = components['schemas'];
/** The 200 bodies of the cUsers reads; `/v1` and `/v2` answer the same shapes. */
type UserList = Schemas['UserListPage'] | Schemas['UserListPageV2'];
type GroupList = Schemas['UserGroupsPage'] | Schemas['UserGroupsPageV2'];
type AdvancedSearch = Schemas['AdvancedSearchPage'] | Schemas['AdvancedSearchPageV2'];

/** {@link checked}'s status, with the JSON body of a 200 as its contract schema `T`. */
async function call<T = unknown>(method: 'GET' | 'POST', url: string, headers: Record<string, string>, form?: Record<string, string>) {
  const res = await checked(method, url, headers, form);
  return { status: res.statusCode, body: res.statusCode === 200 ? res.json<T>() : undefined };
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
    'readPoolUser', 'listUserGroupsV2', 'listUsersV2', 'searchUsersV2', 'getAdvancedSearchV2', 'setAdvancedSearchV2', 'listUserFeed',
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
      '/v2/users/groups', '/v2/users', '/v2/users/search', '/v2/users/advanced-search',
    ];
    for (const url of urls) {
      expect((await call('GET', url, await headers())).status, url).toBe(status);
    }
  });

  it.each(VERSIONS)('admits the Users and Site Manager module grants together on %s/users/groups', async (version) => {
    expect((await call('GET', `${version}/users/groups`, await headersFor([USERS_MODULE, SITE_MANAGER_MODULE, Roles.systemUser]))).status).toBe(200);
  });

  it.each(['/v1/users/groups', '/v1/users', '/v1/users/edit', '/v1/users/route', '/v2/users/groups', '/v2/users'])('refuses another site than the token’s on %s', async (url) => {
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

describe("cwebservice.edit's Connected Account feed [legacy: admin/core/views/cwebservice/edit.cfm:68]", () => {
  it.each([
    ['anonymous', async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'web', audience: 'people' })}` }), 401],
    ['a site admin', () => headersFor(SITE_ADMIN), 403],
    ['the Users and Site Manager module grants', () => headersFor([USERS_MODULE, SITE_MANAGER_MODULE, Roles.systemUser]), 403],
  ])('refuses %s, as the cWebService gate admits S2 only, before any read', async (_case, headers, status) => {
    expect((await call('GET', '/v1/users/feed?ispublic=0', await headers())).status).toBe(status);
    expect(tenantsRead).toEqual([]);
  });

  it('refuses another site than the token’s', async () => {
    expect((await call('GET', `/v1/users/feed?siteid=${OTHER}&ispublic=0`, await headersFor(S2))).status).toBe(403);
    expect(tenantsRead).toEqual([]);
  });

  it.each<[query: string, users: string[]]>([
    ['ispublic=0', [ROOT, JANE]],
    ['ispublic=1', [MEMBER]],
    ['', [MEMBER]],
  ])('lists the pool of %j by last name in full user rows, S2 people included', async (query, users) => {
    const { status, body } = await call<Schemas['UserFeed']>('GET', `/v1/users/feed?siteid=${SITE}&${query}`, await headersFor(S2));
    expect(status).toBe(200);
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(users);
    expect(Object.keys(body?.items[0] ?? {})).toEqual(expect.arrayContaining(['UserID', 'Fname', 'Lname', 'photoFileExt']));
  });

  it('refuses an ispublic other than 0 or 1 before any read', async () => {
    expect((await call('GET', '/v1/users/feed?ispublic=yes', await headersFor(S2))).status).toBe(400);
    expect(tenantsRead).toEqual([]);
  });

  it('answers the legacy 503 for a token tenant the registry does not hold', async () => {
    expect((await call('GET', '/v1/users/feed?ispublic=0', await headersFor(S2, 'unknown-site'))).status).toBe(503);
  });
});

describe('lists and searches', () => {
  it('lists the groups with nextN paging, resetting a start row past the end', async () => {
    const { body } = await call<GroupList>('GET', '/v1/users/groups?ispublic=0&startrow=50&recordsperpage=1', await headersFor(SITE_ADMIN));
    expect(body?.items).toHaveLength(2);
    expect(body?.items[0]).toMatchObject({ UserID: GROUP, Type: 1, Counter: 2, Perm: 1, isPublic: 0 });
    expect(body?.items[1]).not.toHaveProperty('Type');
    expect(body?.nextn).toMatchObject({ totalrecords: 2, recordsperpage: 1, startrow: 1, numberofpages: 2, next: 2 });
    // `/v1` reads identity's listing page by page at its default size.
    expect(groupWindows).toEqual([{ offset: 0 }]);
  });

  const EDITORS = GROUP_ROWS[1]?.userId ?? '';
  it.each<[string, string, string[], number, UserGroupsWindow[]]>([
    ['the first page', 'recordsperpage=1', [GROUP], 1, [{ offset: 0, limit: 1 }]],
    ['a later page', 'startrow=2&recordsperpage=1', [EDITORS], 2, [{ offset: 1, limit: 1 }]],
    // The iterator reads the start row as a page number, so start row 2 of pages of 3 lies past the end and shows page 1.
    ['page 1 for a page past the end', 'startrow=2&recordsperpage=3', [GROUP, EDITORS], 2, [{ offset: 3, limit: 3 }, { offset: 0, limit: 2 }]],
    ['page 1 for a start row past the end', 'startrow=50&recordsperpage=1', [GROUP], 1, [{ offset: 49, limit: 1 }, { offset: 0, limit: 1 }]],
    ['every group on the default page', '', [GROUP, EDITORS], 1, [{ offset: 0, limit: 25 }]],
  ])('/v2 asks identity only for the groups of %s, with nextn over every group', async (_label, query, items, startrow, windows) => {
    const { body } = await call<GroupList>('GET', `/v2/users/groups?ispublic=0&${query}`, await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: 2, startrow });
    expect(groupWindows).toEqual(windows);
  });

  it('/v2 answers the group rows as /v1 lists them', async () => {
    const v1 = await call('GET', '/v1/users/groups?ispublic=0', await headersFor(SITE_ADMIN));
    const v2 = await call('GET', '/v2/users/groups?ispublic=0', await headersFor(SITE_ADMIN));
    expect(v2.body).toEqual(v1.body);
  });

  it.each<[string, UserGroupsWindow[], [first: number, last: number]]>([
    ['recordsperpage=2500&startrow=1', [{ offset: 0, limit: 1000 }, { offset: 1000, limit: 1000 }, { offset: 2000, limit: 500 }], [0, 2499]],
    ['recordsperpage=1000&startrow=2', [{ offset: 1000, limit: 1000 }], [1000, 1999]],
    ['recordsperpage=1500&startrow=2', [{ offset: 1500, limit: 1000 }, { offset: 2500, limit: 500 }], [1500, 2999]],
  ])('/v2 reads the page of %s in identity pages of at most 1000 groups', async (query, windows, [first, last]) => {
    groupRows = groupListing(3000);
    const { body } = await call<GroupList>('GET', `/v2/users/groups?ispublic=0&${query}`, await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(groupRows.slice(first, last + 1).map((row) => row.userId));
    expect(body?.nextn).toMatchObject({ totalrecords: 3000 });
    expect(groupWindows).toEqual(windows);
  });

  it.each(VERSIONS)('%s answers an empty group listing with no items and nextn over none', async (version) => {
    groupRows = [];
    const { body } = await call('GET', `${version}/users/groups?ispublic=0`, await headersFor(SITE_ADMIN));
    expect(body).toEqual({ items: [], nextn: expect.objectContaining({ totalrecords: 0, numberofpages: 0, startrow: 1 }) });
    expect(groupWindows).toHaveLength(1);
  });

  it('/v1 writes every group of a listing longer than one identity page, in its order, with nextn over them', async () => {
    groupRows = groupListing(2500);
    const { body } = await call<GroupList>('GET', '/v1/users/groups?ispublic=0&startrow=11&recordsperpage=10', await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(groupRows.map((row) => row.userId));
    expect(body?.nextn).toMatchObject({ totalrecords: 2500, recordsperpage: 10, startrow: 11, numberofpages: 250 });
    expect(groupWindows).toEqual([{ offset: 0 }, { offset: 1000 }, { offset: 2000 }]);
  });

  // `before()` scrubs a value the admin Portcullis scan does not leave boolean, such as 'abc' or ' false' (scanned to '"NO"'),
  // to 1 [legacy: admin/core/controllers/cusers.cfc:163]; the scan trims ' 0 ' to 0.
  it.each<[string, string, string]>(
    VERSIONS.flatMap((version) =>
      (
        [
          ['0', '0'],
          ['0.0', '0.0'],
          ['1', '1'],
          ['1.0', '1.0'],
          ['2', '2'],
          ['-1', '-1'],
          [' 1', '1'],
          [' 0 ', '0'],
          ['0\u0001', '0'],
          ['abc', '1'],
          [' false', '1'],
          ['\ttrue', '1'],
          ['"0"', '1'],
          // Oracle: getUserGroups keeps a hex float as text, whose `eq 0` names the pool and whose Java reading is the bound flag.
          ['0x1p0', '0x1p0'],
          [' 0x1p3 ', '0x1p3'],
          ['0x1p-1080', '0x1p-1080'],
          ['0x10000p-1', '0x10000p-1'],
          ['0xAp0', '1'],
          ['1e309', '1'],
        ] as const
      ).map(([ispublic, flag]): [string, string, string] => [version, ispublic, flag]),
    ),
  )('%s reads identity groups for ispublic %j as the scrubbed text %j', async (version, ispublic, flag) => {
    expect((await call('GET', `${version}/users/groups?ispublic=${encodeURIComponent(ispublic)}`, await headersFor(SITE_ADMIN))).status).toBe(200);
    expect(groupReads).toEqual([[SITE, flag]]);
  });

  // Oracle: an admin's cUsers.list or cUsers.search with a boolean word answers ACF's 500 page, its h2 the message below;
  // the scan trims ' no', '\tFALSE\n' and ' True' to words first.
  it.each(
    ['yes', 'No', 'TRUE', 'false', ' no', '\tFALSE\n', ' True'].flatMap((ispublic) => [
      ['/v1/users/groups', ispublic, 'getUserGroups'] as const,
      ['/v2/users/groups', ispublic, 'getUserGroups'] as const,
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

  // Oracle: an admin's cUsers.list with these answers ACF's 500 page whose h2 is the cf_sql_numeric binding error below.
  it.each(
    ['-NaN', '+NaN', ' -NaN ', '0x1p1024'].flatMap((ispublic) => [
      ['/v1/users/groups', ispublic] as const,
      ['/v2/users/groups', ispublic] as const,
      ['/v1/users/search', ispublic] as const,
      ['/v2/users/search', ispublic] as const,
    ]),
  )('answers %s the legacy server_error 500 for ispublic %j, with the binding error off the wire, before any read', async (url, ispublic) => {
    const res = await checked('GET', `${url}?ispublic=${encodeURIComponent(ispublic)}&search=doe`, await headersFor(SITE_ADMIN));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { message: 'Unhandled Exception', code: 'server_error' } });
    expect(routeErrors).toHaveLength(1);
    expect((routeErrors[0]?.cause as Error).message).toBe(`Invalid data ${ispublic.trim()} for CFSQLTYPE CF_SQL_NUMERIC.`);
    expect([groupReads, tenantsRead]).toEqual([[], []]);
  });

  it.each(VERSIONS)("%s lists the private pool's users by name with their unassigned ids", async (version) => {
    const { body } = await call<UserList>('GET', `${version}/users?ispublic=0`, await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT, JANE]);
    expect(Object.keys(body?.items[0] ?? {})).toEqual([
      'UserID', 'GroupName', 'Fname', 'Lname', 'UserName', 'Email', 'Type', 'subType', 'Admin', 'S2', 'LastUpdate', 'LastUpdateBy', 'isPublic', 'SiteID',
    ]);
    expect(body?.items[0]?.LastUpdate).toBe('2026-06-30T09:15:00.000');
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
    const { body } = await call<UserList>('GET', `${version}/users?ispublic=0&unassigned=${encodeURIComponent(unassigned)}`, await headersFor(SITE_ADMIN));
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
    const { status, body } = await call<UserList>('GET', `${version}/users?ispublic=${encodeURIComponent(ispublic)}`, await headersFor(SITE_ADMIN));
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
    const { body } = await call<UserList>('GET', `${version}/users?siteid=all&ispublic=${ispublic}`, await headersFor(S2));
    expect((body?.items as Array<{ UserID: string }>).map((row) => row.UserID)).toEqual(users);
  });

  it.each(VERSIONS)('%s reads the public pool for members', async (version) => {
    const { body } = await call<UserList>('GET', `${version}/users?ispublic=1`, await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([MEMBER]);
  });

  // tenant-b's person is found only because the S2 read asks identity for every site's accounts, not the token's pools; the
  // default tenant holds no person, so it costs no lookup. Each tenant's persons are read by name.
  const EVERY_SITE_READS = [
    { op: 'readAccountsAllSites', userIds: [OUTSIDER] },
    { op: 'readAccountsAllSites', userIds: [ROOT, JANE] },
    { op: 'readAccountsAllSites', userIds: [MEMBER] },
  ];

  it.each(VERSIONS)('%s reads every site once for an S2 siteid=all, with its people without a membership', async (version) => {
    const { body } = await call<UserList>('GET', `${version}/users?siteid=ALL&ispublic=0`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT, JANE, OUTSIDER]);
    expect(body?.listUnassignedUsers).toEqual([JANE, OUTSIDER]);
    expect(identityReads.filter(({ op }) => op !== 'lookupMemberships')).toEqual(EVERY_SITE_READS);
    // The listed people's marks come from one membership lookup.
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([{ op: 'lookupMemberships', userIds: [ROOT, JANE, OUTSIDER] }]);
  });

  it.each<[string, string, number, string[]]>([
    ['a later page', 'ispublic=0&startrow=2&recordsperpage=1', 2, [JANE]],
    ['page 1 for a start row past the end', 'ispublic=0&startrow=50&recordsperpage=1', 1, [JANE]],
    ['a page of every site for S2', 'siteid=all&ispublic=0&startrow=3&recordsperpage=1', 3, [JANE, OUTSIDER]],
  ])('/v1 answers every match for %s, with nextn over them and every unassigned user', async (_label, query, startrow, unassigned) => {
    const { body } = await call<UserList>('GET', `/v1/users?${query}`, await headersFor(S2));
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
    const { body } = await call<UserList>('GET', `/v2/users?${query}`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: query.startsWith('siteid=all') ? 3 : 2, recordsperpage: 1, startrow });
    expect(body?.listUnassignedUsers).toEqual(unassigned);
    // One membership lookup, over the page's people only.
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([{ op: 'lookupMemberships', userIds: items }]);
  });

  // Oracle: cUsers.listusers and cUsers.search over two people read Val('1e2') and Val('1e1') as 1 and Val('2e-1') as 2.
  it.each<[string, string[], { recordsperpage: number; startrow: number }]>([
    ['/v2/users?startrow=1e2&recordsperpage=10', [ROOT, JANE], { recordsperpage: 10, startrow: 1 }],
    ['/v2/users?startrow=100&recordsperpage=1e1', [ROOT], { recordsperpage: 1, startrow: 1 }],
    ['/v2/users?startrow=2e-1&recordsperpage=1', [JANE], { recordsperpage: 1, startrow: 2 }],
    ['/v2/users/search?search=o&startrow=2e-1&recordsperpage=1e1', [JANE], { recordsperpage: 1, startrow: 2 }],
  ])('%s pages by startrow and recordsperpage as CFML Val reads them, without an exponent', async (url, items, paging) => {
    const { body } = await call<UserList>('GET', `${url}&siteid=${SITE}&ispublic=0`, await headersFor(S2));
    expect(body?.items).toMatchObject(items.map((UserID) => ({ UserID })));
    expect(body?.nextn).toMatchObject({ totalrecords: 2, ...paging });
  });

  it('/v2 marks every person of an unassigned-only page without another membership lookup', async () => {
    const { body } = await call<UserList>('GET', '/v2/users?ispublic=0&unassigned=1&recordsperpage=1', await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([JANE]);
    expect(body?.listUnassignedUsers).toEqual([JANE]);
    // Identity's lookup applies the list's unassigned filter; the marks reuse the page.
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([]);
  });

  it.each<[string, string[], string[]]>([
    ['search=o&recordsperpage=1&startrow=2', [ROOT, JANE], [JANE]],
    // Jane is no match, but every unassigned user of the pool is marked.
    ['search=admin', [ROOT], [JANE]],
    ['search=', [], [JANE]],
  ])('/v1 answers every search match of %s, with every unassigned user of the pool', async (query, items, unassigned) => {
    const { body } = await call<UserList>('GET', `/v1/users/search?ispublic=0&${query}`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: items.length });
    expect(body?.listUnassignedUsers).toEqual(unassigned);
    // The pool's unassigned users are read last, by name, from identity's unassigned account filter.
    expect(identityReads.at(-1)).toEqual({ op: 'readAccounts', userIds: [ROOT, JANE] });
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([]);
  });

  it.each<[string, string[], string[]]>([
    ['search=o&recordsperpage=1&startrow=1', [ROOT], []],
    ['search=o&recordsperpage=1&startrow=2', [JANE], [JANE]],
    ['search=admin', [ROOT], []],
  ])('/v2 answers only the search matches of the page of %s', async (query, items, unassigned) => {
    const { body } = await call<UserList>('GET', `/v2/users/search?ispublic=0&${query}`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: query.startsWith('search=o') ? 2 : 1 });
    expect(body?.listUnassignedUsers).toEqual(unassigned);
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([{ op: 'lookupMemberships', userIds: items }]);
  });

  it.each<[string, string[]]>([
    ['/v1', [ROOT, JANE]],
    ['/v2', [JANE]],
  ])('%s answers the advanced-search matches for page 2, marking none', async (version, items) => {
    const { body } = await call<AdvancedSearch>('GET', `${version}/users/advanced-search?ispublic=0&startrow=2&recordsperpage=1`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual(items);
    expect(body?.nextn).toMatchObject({ totalrecords: 2, recordsperpage: 1, startrow: 2 });
    expect(body?.listUnassignedUsers).toEqual([]);
    expect(identityReads.filter(({ op }) => op === 'lookupMemberships')).toEqual([]);
  });

  // Oracle: admin start-up's Portcullis scan trims `search=%20an%20` to `an` before cUsers.search reads it.
  it.each(VERSIONS)('%s searches the term trimmed by the admin start-up scan', async (version) => {
    const { body } = await call<UserList>('GET', `${version}/users/search?ispublic=0&search=%20doe%20`, await headersFor(S2));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([JANE]);
  });

  it.each(VERSIONS)('%s searches the pool with full user rows in bootstrap casing', async (version) => {
    const { body } = await call<UserList>('GET', `${version}/users/search?ispublic=0&search=doe`, await headersFor(S2));
    expect(body?.items).toHaveLength(1);
    expect(body?.items[0]).toMatchObject({ UserID: JANE, mobilePhone: null, isPublic: 0, photoFileExt: 'jpg', created: '2026-06-30T09:15:00.000' });
    expect(body?.listUnassignedUsers).toEqual([JANE]);
  });
});

describe('/v1 user lists over a pool larger than one identity lookup', () => {
  const POOL = 2500;
  const poolId = (n: number): string => `A1000000-0000-0000-${String(n).padStart(16, '0')}`;
  const poolPersons = Array.from({ length: POOL }, (_, n) =>
    person(poolId(n), SITE, { fname: `First ${n % 7}`, lname: `Person ${String(n % 1250).padStart(4, '0')}`, email: `p${n}@example.test` }),
  );
  const poolAccounts = new Map(poolPersons.map((row) => [row.userid, account(row.userid, SITE)]));
  // Every third person holds a membership.
  const poolMemberships = new Map(poolPersons.filter((_, n) => n % 3 === 0).map((row) => [row.userid, [GROUP]]));
  const reads = new IdentityDouble(poolAccounts, poolMemberships, { db, tid: tenantIdForSite(SITE), s2: true });
  const VIEWER = { tid: tenantIdForSite(SITE), site: SITE, isS2: true };
  /** The identity reads of the routes under test, with the ids each carried and whether it filtered to unassigned accounts. */
  const calls: { op: 'readAccounts' | 'lookupMemberships'; ids: number; unassigned: boolean }[] = [];
  /** The 1-based membership lookup that fails, if any. */
  let failingLookup: number | undefined;
  /** Resolves once the reads may go past the first person page of 1000. */
  let pastFirstPage: Promise<void> = Promise.resolve();
  let poolApp: FastifyInstance;

  const poolIdentity: IdentityClient = {
    ...identity,
    readAccounts: async (userIds, where) => {
      calls.push({ op: 'readAccounts', ids: userIds.length, unassigned: where?.unassigned === true });
      return reads.readAccounts(userIds, where);
    },
    countAccounts: (request) => reads.countAccounts(request),
    usernameCandidates: (request) => reads.usernameCandidates(request),
    lookupMemberships: async (userIds) => {
      calls.push({ op: 'lookupMemberships', ids: userIds.length, unassigned: false });
      if (calls.filter(({ op }) => op === 'lookupMemberships').length === failingLookup) {
        throw new ServiceUnavailableError('identity', new Error('identity lookupMemberships answered HTTP 503'));
      }
      return reads.lookupMemberships(userIds);
    },
  };

  // Keyset pages of `limit` persons, the cursor holding the next row's index.
  const poolRepository = {
    ...repository,
    pagePersonsInOrder: async (tx: TenantTx, scope: PersonOrderScope, opts: { orderBy: readonly PersonSortKey[]; after?: PersonCursor | null; limit: number }) => {
      const from = Number(opts.after?.keys[0] ?? 0);
      if (from > 0) await pastFirstPage;
      const rows = personsInOrder(ofTenant(poolPersons, tx), scope, opts.orderBy);
      const to = from + opts.limit;
      return { rows: rows.slice(from, to), next: to < rows.length ? { keys: [to], userid: '' } : null };
    },
  } as unknown as PeopleRepository;
  /** The collected reads `/v1` answered from before it streamed, as the oracle of its rows. */
  const oracle = { db, repo: poolRepository, identity: reads, clock: fixedClock(NOW) };

  beforeAll(async () => {
    const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    poolApp = await createService({
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
    await registerAdminUserRoutes(poolApp, { db, repository: poolRepository, identity: poolIdentity, clock: fixedClock(NOW), awaitPersonOpen: awaitOpen, expirePasswords: 0 });
    await poolApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await poolApp?.opt2.shutdown();
  });

  beforeEach(() => {
    calls.length = 0;
    failingLookup = undefined;
    pastFirstPage = Promise.resolve();
  });

  /** A site admin's GET of `url` from the pool service, checked against the contract. */
  async function poolCall<T = unknown>(url: string) {
    const res = await poolApp.inject({ method: 'GET', url, headers: await headersFor(S2) });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: url.split('?')[0] ?? url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return { status: res.statusCode, body: res.statusCode === 200 ? res.json<T>() : undefined };
  }

  const idsOf = (rows: ReadonlyArray<Record<string, unknown>> | undefined): unknown[] => (rows ?? []).map((row) => row.UserID ?? row.userID);
  const sizes = (op: 'readAccounts' | 'lookupMemberships'): number[] => calls.filter((c) => c.op === op).map((c) => c.ids);

  it('lists the pool in one pass, as many identity lookups as 1000-id batches, with the collected reads’ rows, order, nextn and marks', async () => {
    const { body } = await poolCall<UserList>('/v1/users?ispublic=0&startrow=11&recordsperpage=10');
    expect(calls).toEqual([1000, 1000, 500].flatMap((ids) => [
      { op: 'readAccounts', ids, unassigned: false },
      { op: 'lookupMemberships', ids, unassigned: false },
    ]));
    expect(idsOf(body?.items)).toEqual(idsOf((await getUsers(oracle, VIEWER, { siteid: SITE, ispublic: '0' })).rows));
    expect(body?.listUnassignedUsers).toEqual(idsOf((await getUnassignedUsers(oracle, VIEWER, { siteid: SITE, ispublic: '0' })).rows));
    // `/v2` pages the same rows and marks them the same way.
    const v2 = await poolCall<UserList>('/v2/users?ispublic=0&startrow=1&recordsperpage=2500');
    expect(body?.items).toEqual(v2.body?.items);
    expect(body?.listUnassignedUsers).toEqual(v2.body?.listUnassignedUsers);
    expect(body?.nextn).toEqual((await poolCall<UserList>('/v2/users?ispublic=0&startrow=11&recordsperpage=10')).body?.nextn);
  });

  it('lists the unassigned people only with the list itself as the marks, without a membership lookup', async () => {
    const { body } = await poolCall<UserList>('/v1/users?ispublic=0&unassigned=1');
    const unassigned = idsOf((await getUnassignedUsers(oracle, VIEWER, { siteid: SITE, ispublic: '0' })).rows);
    expect(idsOf(body?.items)).toEqual(unassigned);
    expect(body?.listUnassignedUsers).toEqual(unassigned);
    expect(calls).toEqual([1000, 1000, 500].map((ids) => ({ op: 'readAccounts', ids, unassigned: true })));
  });

  it.each<[term: string, matches: number]>([
    ['Person', 2100],
    ['Person 0001', 2],
  ])('searches the pool for %j once, then reads every unassigned user of the pool in 1000-person batches, as getUnassignedUsers orders them', async (term, matches) => {
    const { body } = await poolCall<UserList>(`/v1/users/search?ispublic=0&search=${encodeURIComponent(term)}`);
    const matched = (await getSearch(oracle, VIEWER, { search: term, siteid: SITE, isPublic: '0' })).rows;
    expect(idsOf(body?.items)).toEqual(idsOf(matched));
    expect(body?.nextn).toMatchObject({ totalrecords: matches });
    expect(body?.listUnassignedUsers).toEqual(idsOf((await getUnassignedUsers(oracle, VIEWER, { siteid: SITE, ispublic: '0' })).rows));
    expect(body?.listUnassignedUsers).toHaveLength(POOL - poolMemberships.size);
    // The pool pass is the last identity work, and no membership lookup is needed.
    const poolPass = [1000, 1000, 500].map((ids) => ({ op: 'readAccounts', ids, unassigned: true }));
    expect(calls.filter(({ unassigned }) => unassigned)).toEqual(poolPass);
    expect(calls.slice(-poolPass.length)).toEqual(poolPass);
    expect(sizes('lookupMemberships')).toEqual([]);
  });

  it('runs the advanced search once in 1000-person batches, with the collected search’s rows', async () => {
    const { body } = await poolCall<AdvancedSearch>('/v1/users/advanced-search?ispublic=0');
    expect(sizes('readAccounts')).toEqual([1000, 1000, 500]);
    expect(sizes('lookupMemberships')).toEqual([]);
    const collected = await getAdvancedSearch(oracle, VIEWER, newAdvancedSearchCriteria(), { siteid: SITE, isPublic: '0' });
    expect(idsOf(body?.items)).toEqual(idsOf(collected.rows));
    expect(body?.items).toEqual((await poolCall<AdvancedSearch>('/v2/users/advanced-search?ispublic=0&recordsperpage=2500')).body?.items);
    expect(body?.nextn).toMatchObject({ totalrecords: POOL });
  });

  it("lists the feed's first 1000 people by last name alone, ties in getAdvancedSearch's order, from one 1000-person read", async () => {
    const { body } = await poolCall<Schemas['UserFeed']>('/v1/users/feed?ispublic=0');
    const collected = idsOf((await getAdvancedSearch(oracle, VIEWER, newAdvancedSearchCriteria(), { siteid: SITE, isPublic: '0' })).rows);
    expect(idsOf(body?.items)).toEqual(collected.slice(0, 1000));
    expect(sizes('readAccounts')).toEqual([1000]);
    // Persons n and n + 1250 share a last name, and a first-name tie-break would reorder some of those pairs.
    const byName = idsOf((await getUsers(oracle, VIEWER, { siteid: SITE, ispublic: '0' })).rows).slice(0, 1000);
    expect(new Set(idsOf(body?.items))).toEqual(new Set(byName));
    expect(idsOf(body?.items)).not.toEqual(byName);
  });

  /** A GET of `url` on a real socket: the status, each body chunk as it arrived, and whether the body ended complete. */
  function streamed(url: string, headers: Record<string, string>, onChunk: (chunk: string) => void = () => undefined) {
    const { port } = poolApp.server.address() as AddressInfo;
    return new Promise<{ status: number; body: string; complete: boolean }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: url, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          onChunk(chunk);
        });
        // A body cut short also errors the response; `complete` reports it.
        res.on('error', () => undefined);
        res.on('close', () => resolve({ status: res.statusCode ?? 0, body, complete: res.complete }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('writes the first batch before the pool is read past it', async () => {
    let release = (): void => undefined;
    pastFirstPage = new Promise((resolve) => {
      release = resolve;
    });
    let firstChunk = '';
    const answer = await streamed('/v1/users?ispublic=0', await headersFor(S2), (chunk) => {
      if (firstChunk === '') {
        firstChunk = chunk;
        release();
      }
    });
    expect(firstChunk.startsWith('{"items":[{"UserID":')).toBe(true);
    expect(answer).toMatchObject({ status: 200, complete: true });
    expect((JSON.parse(answer.body) as { items: unknown[] }).items).toHaveLength(POOL);
  });

  it('answers the error response for a failure in the first batch, and cuts the body short for a later one', async () => {
    failingLookup = 1;
    const first = await poolCall('/v1/users?ispublic=0');
    expect(first.status).toBe(503);
    calls.length = 0;
    failingLookup = 2;
    const later = await streamed('/v1/users?ispublic=0', await headersFor(S2));
    expect(later.status).toBe(200);
    expect(later.complete).toBe(false);
    expect(() => JSON.parse(later.body)).toThrow();
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
    const { body } = await call<AdvancedSearch>('POST', `${version}/users/advanced-search?ispublic=0`, await headersFor(SITE_ADMIN), form);
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
    const posted = await call<AdvancedSearch>('POST', `${version}/users/advanced-search?ispublic=0`, await headersFor(S2), { inActive: '0' });
    expect(saves).toEqual([]);
    expect(posted.body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT]);
    const read = await call<AdvancedSearch>('GET', `${version}/users/advanced-search?ispublic=0`, await headersFor(S2));
    expect(read.body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([ROOT]);
    const hidden = await call<AdvancedSearch>('GET', `${version}/users/advanced-search?ispublic=0`, await headersFor(SITE_ADMIN));
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
    const { body } = await call<AdvancedSearch>('POST', `${version}/users/advanced-search?ispublic=${encodeURIComponent(ispublic)}`, await headersFor(SITE_ADMIN), posted);
    expect((body?.items as Array<{ UserID: string }>).map((row) => row.UserID)).toEqual(users);
    expect((body?.groups as Array<{ GroupName: string }>).map((row) => row.GroupName)).toEqual([group]);
  });

  it('runs empty criteria over the member pool with the member groups', async () => {
    const { body } = await call<AdvancedSearch>('GET', `${version}/users/advanced-search?ispublic=1`, await headersFor(SITE_ADMIN));
    expect(body?.items.map((row: { UserID: string }) => row.UserID)).toEqual([MEMBER]);
    expect(body?.groups).toEqual([{ UserID: MEMBER_GROUP, GroupName: 'Fans', SiteID: UMBRELLA, isPublic: 1, Perm: 0 }]);
  });
});

describe('list reads whose client disconnects', () => {
  /** Pages each listing and identity's group paging serve when read to the end. */
  const PAGES = 20;
  const STEP_MS = 25;
  const lines: Array<Record<string, unknown>> = [];
  let listening: FastifyInstance;
  let pageReads = 0;
  let groupPages = 0;
  /** Runs as each person page, group page or criteria save starts. */
  let working: () => void = () => undefined;

  /** One of PAGES pages of `rows`, a wait apart, as a pool too large for one scan batch pages. */
  async function personPage(rows: PersonRow[], after: PersonCursor | null | undefined): Promise<Page<PersonRow, PersonCursor>> {
    pageReads += 1;
    working();
    await sleep(STEP_MS);
    const index = Number(after?.keys[0] ?? 0) + 1;
    return { rows, next: index < PAGES ? { keys: [index], userid: '' } : null };
  }

  const pagingRepository = {
    ...repository,
    pagePersonsInOrder: (tx: TenantTx, scope: PersonOrderScope, opts: { orderBy: readonly PersonSortKey[]; after?: PersonCursor | null }) =>
      personPage(personsInOrder(ofTenant(PERSONS, tx), scope, opts.orderBy), opts.after),
    // A search page reads its pool's search keys in one read, so a disconnect during it stops the read before any account lookup.
    listPersonSearchKeys: async (tx: TenantTx, scope: PersonOrderScope, orderBy: readonly PersonSortKey[]) =>
      (await personPage(personsInOrder(ofTenant(PERSONS, tx), scope, orderBy), null)).rows,
    pageQueryPersons: (tx: TenantTx, query: { siteIds?: readonly string[] }, opts: { after?: PersonCursor | null }) =>
      personPage(ofTenant(PERSONS, tx).filter((row) => query.siteIds === undefined || query.siteIds.some((siteId) => sameId(row.siteid, siteId))), opts.after),
  } as unknown as PeopleRepository;

  const pagingIdentity: IdentityClient = {
    ...identity,
    // A total past every page keeps a /v2 page reading until the listing ends.
    countAccounts: () => Promise.resolve(10_000),
    // Identity's group paging, each page one service call, which checks the request's signal first.
    userGroupsPage: async (_siteId, _isPublic, { offset }) => {
      throwIfRequestAborted();
      groupPages += 1;
      working();
      await sleep(STEP_MS);
      return { rows: [...GROUP_ROWS], total: GROUP_ROWS.length * PAGES, nextOffset: offset + 1 < PAGES ? offset + 1 : null };
    },
    saveAdminSessionState: async (state) => {
      working();
      await sleep(STEP_MS * 4);
      return identity.saveAdminSessionState(state);
    },
  };

  beforeAll(async () => {
    const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) } });
    listening = await createService({
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
    await registerAdminUserRoutes(listening, { db, repository: pagingRepository, identity: pagingIdentity, clock: fixedClock(NOW), awaitPersonOpen: awaitOpen, expirePasswords: 0 });
    await listening.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await listening?.opt2.shutdown();
  });

  beforeEach(() => {
    lines.length = 0;
    pageReads = 0;
    groupPages = 0;
    working = () => undefined;
  });

  /** Sends a site admin's request on a real socket and destroys it once the read starts working; resolves with the abandoned line. */
  async function leave(method: 'GET' | 'POST', url: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
    const headers = await headersFor(SITE_ADMIN);
    const { port } = listening.server.address() as AddressInfo;
    const body = form === undefined ? undefined : new URLSearchParams(form).toString();
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method,
        path: url,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      });
      // The destroyed request's own socket error is the point of the test.
      req.on('error', () => undefined);
      req.on('close', () => resolve());
      working = () => {
        working = () => undefined;
        req.destroy();
      };
      req.end(body);
    });
    const abandoned = await vi.waitFor(
      () => {
        const found = lines.filter((line) => line.message === 'request abandoned');
        expect(found).toHaveLength(1);
        return found[0] as Record<string, unknown>;
      },
      { timeout: 5_000 },
    );
    expect(lines.filter((line) => line.severity === 'ERROR')).toEqual([]);
    return abandoned;
  }

  it.each<[url: string, route: string, reads: () => number]>([
    ['/v1/users?ispublic=0', '/v1/users', () => pageReads],
    ['/v2/users?ispublic=0', '/v2/users', () => pageReads],
    ['/v1/users/search?ispublic=0&search=doe', '/v1/users/search', () => pageReads],
    ['/v2/users/search?ispublic=0&search=doe', '/v2/users/search', () => pageReads],
    ['/v1/users/advanced-search?ispublic=0', '/v1/users/advanced-search', () => pageReads],
    ['/v2/users/advanced-search?ispublic=0', '/v2/users/advanced-search', () => pageReads],
    ['/v1/users/groups?ispublic=0', '/v1/users/groups', () => groupPages],
  ])('stops GET %s after its first page once the client disconnects', async (url, route, reads) => {
    expect(await leave('GET', url)).toMatchObject({ route, httpMethod: 'GET' });
    expect(reads()).toBeGreaterThanOrEqual(1);
    expect(reads()).toBeLessThan(PAGES);
  });

  it.each(VERSIONS)('stores the criteria of a %s advanced-search POST whose client disconnects during the save, then abandons the read', async (version) => {
    const posted = { param: '1', paramField1: 'tusers.lname^varchar', paramRelationship1: 'and', paramCriteria1: 'Doe', paramCondition1: 'Contains' };
    expect(await leave('POST', `${version}/users/advanced-search?ispublic=0`, posted)).toMatchObject({
      route: `${version}/users/advanced-search`,
      httpMethod: 'POST',
    });
    expect(saves).toMatchObject([{ paramArray: [{ Field: 'tusers.lname^varchar', Relationship: 'and', Criteria: 'Doe', Condition: 'Contains' }] }]);
    expect(pageReads).toBeLessThan(PAGES);
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
    const { status, body } = await call<Schemas['UserEditData']>('GET', `/v1/users/edit?userid=${JANE}${query}`, await headersFor(SITE_ADMIN));
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
    const { body } = await call<Schemas['UserEditData']>('GET', `/v1/users/edit?userid=${JANE}&ispublic=0`, await headersFor(SITE_ADMIN));
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
    const admin = await call<Schemas['UserEditData']>('GET', `/v1/users/edit?userid=${ROOT}`, await headersFor(SITE_ADMIN));
    expect(admin.body).toMatchObject({ lockedSuper: true, groupIds: [GROUP] });
    expect(admin.body?.user).toMatchObject({ S2: 1, Admin: 1, Ext: 12 });
    expect((await call<Schemas['UserEditData']>('GET', `/v1/users/edit?userid=${ROOT}`, await headersFor(S2))).body?.lockedSuper).toBe(false);
  });

  it('reads a new bean for an empty or unknown id, and keeps setispublic only for an admin', async () => {
    const fresh = await call<Schemas['UserEditData']>('GET', '/v1/users/edit?userid=&setispublic=0', await headersFor(SITE_ADMIN));
    expect(fresh.body).toMatchObject({ isNew: true, tempIsPublic: 0, addresses: [], groupIds: [] });
    expect(fresh.body?.user).toMatchObject({ Type: 2, isPublic: 1, SiteID: '', LastLogin: null });
    expect(fresh.body?.user.UserID).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
    const moduleUser = await call('GET', `/v1/users/edit?userid=${OUTSIDER}&setispublic=0`, await headersFor([USERS_MODULE, SITE_MANAGER_MODULE, Roles.systemUser]));
    expect(moduleUser.body).toMatchObject({ isNew: true, tempIsPublic: 1 });
    // A person of a site outside the token's user pools is never read.
    expect(tenantsRead).not.toContain(tenantIdForSite(OTHER));
  });

  it('reads the addressed address, or a new one under the requested id', async () => {
    const found = await call<Schemas['AddressEditData']>('GET', `/v1/users/address?userid=${JANE}&addressid=${ADDRESS}`, await headersFor(SITE_ADMIN));
    expect(found.body).toMatchObject({
      isNew: false,
      extendedAttributes: { movedIn: "{ts '2026-06-01 00:00:00'}", access: 'Gate 4' },
      address: { addressID: ADDRESS, city: 'Springfield' },
    });
    expect(found.body?.user).toMatchObject({ UserID: JANE });
    const missing = 'C0000000-0000-0000-0000000000000009';
    const other = await call('GET', `/v1/users/address?userid=${JANE}&addressid=${missing}`, await headersFor(SITE_ADMIN));
    expect(other.body).toMatchObject({ isNew: true, address: { addressID: missing, userID: JANE, city: null } });
    const fresh = await call<Schemas['AddressEditData']>('GET', `/v1/users/address?userid=${JANE}`, await headersFor(SITE_ADMIN));
    expect(fresh.body?.address.addressID).not.toBe(ADDRESS);
  });

  // A NULL PasswordCreated leaves userBean.init's now(), so only a dated old credential expires.
  it.each<[string, string, string | null, boolean]>([
    ['a new user', '', null, false],
    ['a stored user without a credential date', JANE, null, false],
    ['a stored user with a recent password', JANE, '2026-06-20T09:15:00.000', false],
    ['a stored user with a password older than the expiry', JANE, '2026-05-01T09:15:00.000', true],
  ])('answers passwordExpired for %s', async (_case, userId, passwordCreated, expired) => {
    const stored = ACCOUNTS.get(JANE) as AccountView;
    ACCOUNTS.set(JANE, { ...stored, passwordCreated });
    try {
      const { status, body } = await call<Schemas['UserEditData']>('GET', `/v1/users/edit?userid=${userId}`, await headersFor(SITE_ADMIN));
      expect(status).toBe(200);
      expect(body?.passwordExpired).toBe(expired);
    } finally {
      ACCOUNTS.set(JANE, stored);
    }
  });
});

describe('credential columns', () => {
  /** Every object key of `value`, at any depth. */
  function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysOf);
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  }

  it.each([
    ...VERSIONS.flatMap((version) => [`${version}/users?ispublic=0`, `${version}/users/search?ispublic=0&search=o`, `${version}/users/advanced-search?ispublic=0`]),
    `/v1/users/edit?userid=${JANE}`,
    '/v1/users/edit?userid=',
    `/v1/users/address?userid=${JANE}&addressid=${ADDRESS}`,
  ])('leaves Password and PasswordCreated out of every person row of %s', async (url) => {
    const stored = ACCOUNTS.get(JANE) as AccountView;
    ACCOUNTS.set(JANE, { ...stored, passwordCreated: '2026-05-01T09:15:00.000' });
    try {
      const { status, body } = await call('GET', url, await headersFor(S2));
      expect(status).toBe(200);
      const keys = keysOf(body);
      expect(keys).toContain('UserID');
      expect(keys.filter((key) => /^password(created)?$/i.test(key))).toEqual([]);
    } finally {
      ACCOUNTS.set(JANE, stored);
    }
  });

  type Body = Record<string, unknown>;
  type Tamper = (body: Body, key: string) => Body;
  it.each<[string, string, string, Tamper]>(
    ['PasswordCreated', 'Password', 'PASSWORDCREATED'].flatMap((key): [string, string, string, Tamper][] => [
      ['PersonRecord', key, `/v1/users/edit?userid=${JANE}`, (body, name) => ({ ...body, user: { ...(body.user as Body), [name]: null } })],
      ['UserListRow', key, '/v1/users/search?ispublic=0&search=o', (body, name) => ({ ...body, items: [{ ...(body.items as Body[])[0], [name]: null }] })],
    ]),
  )('the contract refuses a %s carrying %s', async (_schema, key, url, tamper) => {
    const { body } = await call<Body>('GET', url, await headersFor(S2));
    const response = { method: 'GET', path: url.split('?')[0] ?? url, status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
    expect(() => assertResponseMatchesOpenApi(OPENAPI, response)).not.toThrow();
    expect(() => assertResponseMatchesOpenApi(OPENAPI, { ...response, body: JSON.stringify(tamper(body ?? {}, key)) })).toThrow();
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

  // Oracle: the admin start-up scan's word filter turns `returnurl=javascript%3Aalert(1)` into `[INVALID]alert(1)`.
  it('redirects to the return URL the admin start-up scan leaves', async () => {
    const { body } = await call('GET', `/v1/users/route?returnurl=${encodeURIComponent('javascript:alert(1)')}`, await headersFor(SITE_ADMIN));
    expect(body).toEqual({ redirect: { url: '[INVALID]alert(1)' } });
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
    const { status, body } = await call<Schemas['CurrentUserRead']>('GET', `${CURRENT}&groupids=${GROUP},${MEMBER_GROUP}`, await identityHeaders({ sub, roles }));

    expect(status).toBe(200);
    expect(Object.keys(body?.data ?? {}).sort()).toEqual(USER_KEYS);
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
    const { status, body } = await call<Schemas['CurrentUserRead']>('GET', `${CURRENT}&groupids=${GROUP}`, await identityHeaders(user));

    expect(status).toBe(200);
    expect(Object.keys(body?.data ?? {}).sort()).toEqual(USER_KEYS);
    expect(body?.data).toMatchObject({ siteid: SITE, isnew: 1, ispublic: 1, subtype: 'Default', type: 'user', groupid: '', fname: '', lastlogin: '' });
    expect(body?.data.userid).toMatch(CF_UUID);
    expect(body?.data.userid).not.toBe(UNKNOWN);
    expect(body?.data.id).toBe(body?.data.userid);
    expect(body?.data.links).toEqual(linksOf(body?.data.userid ?? ''));
  });

  it('selects the requested fields plus userid, siteid and isnew', async () => {
    const { body } = await call<Schemas['CurrentUserRead']>('GET', `${CURRENT}&fields=fname,groupid&groupids=${GROUP}`, await identityHeaders({ sub: JANE, roles: [Roles.systemUser] }));

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
    const { status, body } = await call<Schemas['CurrentUserRead']>('GET', `${CURRENT}&fields=addresses`, await identityHeaders(user));

    expect(status).toBe(200);
    expect(Object.keys(body?.data ?? {}).sort()).toEqual(['addresses', 'entityname', 'id', 'isnew', 'siteid', 'type', 'userid']);
    expect(body?.data.addresses).toEqual(addresses);
    expect(body?.data.addresses?.map((row: Record<string, unknown>) => Object.keys(row))).toEqual(addresses.map((row) => Object.keys(row)));
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
