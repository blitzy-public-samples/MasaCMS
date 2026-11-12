/** Legacy role list, `session.mura` user struct, login snapshot, role map, site-scoped token roles and module checks of `src/domain/roles.ts`. */
import { describe, expect, it } from 'vitest';
import { Roles, SYNTHETIC_ROLES, moduleRole } from '@opt2/platform/auth';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, registryPayloads } from '@opt2/platform/testing';
import {
  ANONYMOUS_USER_STRUCT,
  buildLegacyRoleList,
  buildLoginSnapshot,
  buildUserStruct,
  loadRoleMap,
  membershipIdsFor,
  moduleGrantHeld,
  modulePermByRole,
  parseRoleMap,
  roleListHas,
  snapshotIsS2,
  tokenRolesFor,
  userStructOf,
  type LoginRows,
  type MembershipGroup,
  type ModuleGroupGrant,
  type RoleMap,
  type TokenRoleSite,
  type TokenRoles,
} from '../../src/domain/roles.js';
import type { CredentialRow, LoginSnapshot, LoginStateRow, PersonContactRow, UserAccountRow } from '../../src/repo/tables.js';

const PIN_SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const USER_ID = 'A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D';
const ADMIN_GROUP_ID = 'B2C3D4E5-F6A7-4B8C-9D0E1F2A3B4C5D6E';
const EDITORS_GROUP_ID = 'C3D4E5F6-A7B8-4C9D-0E1F2A3B4C5D6E7F';
const STAFF_GROUP_ID = 'D4E5F6A7-B8C9-4D0E-1F2A3B4C5D6E7F80';
const SUBSCRIBERS_GROUP_ID = 'E5F6A7B8-C9D0-4E1F-2A3B4C5D6E7F8091';
const TIMESHEETS_GROUP_ID = 'F6A7B8C9-D0E1-4F2A-3B4C5D6E7F809102';
const FINANCE_GROUP_ID = 'A7B8C9D0-E1F2-4A3B-4C5D6E7F80910213';
const USERS_MODULE = `${'0'.repeat(32)}008`;
const CONTENT_MODULE = `${'0'.repeat(32)}003`;
const PLUGIN_MODULE = 'B8C9D0E1-F2A3-4B4C-5D6E7F8091021324';
const PASSWORD_HASH = '$2a$10$synthetic.roles.fixture';
const LAST_LOGIN = new Date(2026, 5, 29, 17, 45, 30, 120);
// .999 s rounds up to the next second in a SQL Server datetime.
const PASSWORD_CREATED = new Date(2026, 2, 2, 8, 4, 9, 999);

const ROLE_MAP = await loadRoleMap();

function accountRow(overrides: Partial<UserAccountRow> = {}): UserAccountRow {
  return {
    tenant_id: TENANT_A.tenantId, userid: USER_ID, username: 'site_admin', type: 2, admin: 0, s2: 0, perm: 0, inactive: 0,
    ispublic: 0, siteid: TENANT_A.siteId, remoteid: '', tablist: '', opt2_state: 'active', ...overrides,
  };
}

function credentialRow(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return { tenant_id: TENANT_A.tenantId, userid: USER_ID, password: PASSWORD_HASH, passwordcreated: PASSWORD_CREATED, ...overrides };
}

function loginStateRow(lastlogin: Date | null): LoginStateRow {
  return { tenant_id: TENANT_A.tenantId, userid: USER_ID, lastlogin };
}

function contactRow(overrides: Partial<PersonContactRow> = {}): PersonContactRow {
  return {
    tenant_id: TENANT_A.tenantId, user_id: USER_ID, site_id: TENANT_A.siteId, email: 'site.admin@tenant-a.example.com', fname: 'Site',
    lname: 'Admin', company: 'Tenant A Programs', subtype: 'Default', aggregate_version: '1', updated_at: new Date(2026, 5, 1, 9, 0, 0),
    ...overrides,
  };
}

function group(groupId: string, groupName: string | null, siteId: string | null, isPublic: number | null): MembershipGroup {
  return { groupId, groupName, siteId, isPublic };
}

const ADMIN_A = group(ADMIN_GROUP_ID, 'Admin', TENANT_A.siteId, 0);
const EDITORS_A = group(EDITORS_GROUP_ID, 'Editors', TENANT_A.siteId, 0);
const STAFF_A = group(STAFF_GROUP_ID, 'Program Staff', TENANT_A.siteId, 0);
const SUBSCRIBERS_UMBRELLA = group(SUBSCRIBERS_GROUP_ID, 'Subscribers', TENANT_UMBRELLA.siteId, 1);
const TIMESHEETS_A = group(TIMESHEETS_GROUP_ID, Roles.timesheetsEmployee, TENANT_A.siteId, 0);
const FINANCE_A = group(FINANCE_GROUP_ID, Roles.financeApprover, TENANT_A.siteId, 0);

function loginRows(overrides: Partial<LoginRows> = {}): LoginRows {
  return {
    account: accountRow(),
    credential: credentialRow(),
    loginState: loginStateRow(LAST_LOGIN),
    contact: contactRow(),
    groups: [ADMIN_A, EDITORS_A],
    ...overrides,
  };
}

const BARE_ROWS = loginRows({ credential: null, loginState: null, contact: null, groups: [] });

function siteOf(siteId: string): TokenRoleSite {
  const payload = registryPayloads().find((entry) => entry.siteId === siteId);
  if (payload === undefined) throw new Error(`The registry fixtures hold no site ${siteId}`);
  return { siteId: payload.siteId, privateUserPoolId: payload.privateUserPoolId ?? null, publicUserPoolId: payload.publicUserPoolId ?? null };
}

const SITE_A = siteOf(TENANT_A.siteId);
const SITE_B = siteOf(TENANT_B.siteId);
const SITE_UMBRELLA = siteOf(TENANT_UMBRELLA.siteId);
const REGISTERED_SITES = [SITE_A, SITE_B, SITE_UMBRELLA];
const UNREGISTERED_SITE: TokenRoleSite = { siteId: 'no-such-site', privateUserPoolId: null, publicUserPoolId: null };

const S2_ACCOUNT: Partial<UserAccountRow> = { username: 'admin', siteid: 'default', s2: 1 };
const PRIVATE_A_ACCOUNT: Partial<UserAccountRow> = { username: 'editor_a', siteid: TENANT_A.siteId };
const PRIVATE_B_ACCOUNT: Partial<UserAccountRow> = { username: 'editor_b', siteid: TENANT_B.siteId };
const PUBLIC_UMBRELLA_ACCOUNT: Partial<UserAccountRow> = { username: 'pool_member', siteid: TENANT_UMBRELLA.siteId, ispublic: 1 };

function snapshotFor(account: Partial<UserAccountRow>, groups: readonly MembershipGroup[] = []): Pick<LoginSnapshot, 'roleList'> {
  return { roleList: buildLegacyRoleList(accountRow(account), groups) };
}

function grant(moduleId: string, memberGroup: MembershipGroup): ModuleGroupGrant {
  return { moduleId, groupName: memberGroup.groupName, isPublic: memberGroup.isPublic };
}

const NO_GRANTS = { moduleGrants: [], roleMap: ROLE_MAP };
const NO_ACCESS: TokenRoles = { roles: [], hasSiteAccess: false };

function access(...roles: string[]): TokenRoles {
  return { roles, hasSiteAccess: true };
}

function roleMapWith(groups: unknown[]): { sourceSha: string; scope: string; groups: unknown[] } {
  return { sourceSha: PIN_SHA, scope: 'privateUserPool', groups };
}

describe('buildLegacyRoleList [legacy: core/mura/user/userUtility.cfc:315-336]', () => {
  it.each([
    {
      when: 'a private user lists each group as name;siteid;isPublic, then the S2IsPrivate pair and the username entry',
      account: accountRow(),
      groups: [ADMIN_A, EDITORS_A],
      expected: 'Admin;tenant-a;0,Editors;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,site_admin;username;tenant-a',
    },
    {
      when: 'a public user carries the S2IsPublic pair and its public group keeps isPublic 1',
      account: accountRow(PUBLIC_UMBRELLA_ACCOUNT),
      groups: [SUBSCRIBERS_UMBRELLA],
      expected: 'Subscribers;umbrella;1,S2IsPublic;umbrella,S2IsPublic,pool_member;username;umbrella',
    },
    {
      when: 'tusers.S2 = 1 appends S2 after the pool pair',
      account: accountRow(S2_ACCOUNT),
      groups: [],
      expected: 'S2IsPrivate;default,S2IsPrivate,S2,admin;username;default',
    },
    {
      when: 'a user in no group starts with the pool pair',
      account: accountRow(),
      groups: [],
      expected: 'S2IsPrivate;tenant-a,S2IsPrivate,site_admin;username;tenant-a',
    },
    {
      when: 'NULL columns render as empty text and a NULL ispublic or s2 reads as false',
      account: accountRow({ username: null, siteid: null, ispublic: null, s2: null }),
      groups: [group(ADMIN_GROUP_ID, null, null, null)],
      expected: ';;,S2IsPrivate;,S2IsPrivate,;username;',
    },
  ])('$when', ({ account, groups, expected }) => {
    expect(buildLegacyRoleList(account, groups)).toBe(expected);
  });
});

describe('membershipIdsFor [legacy: core/mura/user/userUtility.cfc:380]', () => {
  it.each([
    {
      when: 'lists the group ids in role-list order, then the user id',
      groups: [ADMIN_A, EDITORS_A],
      expected: `${ADMIN_GROUP_ID},${EDITORS_GROUP_ID},${USER_ID}`,
    },
    { when: 'holds only the user id when the user belongs to no group', groups: [], expected: USER_ID },
  ])('$when', ({ groups, expected }) => {
    expect(membershipIdsFor(groups, USER_ID)).toBe(expected);
  });
});

describe('buildUserStruct [legacy: core/mura/user/userUtility.cfc:765-783]', () => {
  it('copies the login rows into the logged-in session.mura struct, with the pre-login lastlogin and datetime-rounded timestamps', () => {
    expect(buildUserStruct(loginRows())).toEqual({
      isLoggedIn: true,
      userID: USER_ID,
      username: 'site_admin',
      siteID: 'tenant-a',
      subtype: 'Default',
      password: PASSWORD_HASH,
      fname: 'Site',
      lname: 'Admin',
      email: 'site.admin@tenant-a.example.com',
      remoteID: '',
      company: 'Tenant A Programs',
      lastlogin: '2026-06-29T17:45:30.120',
      passwordCreated: '2026-03-02T08:04:10.000',
      memberships: 'Admin;tenant-a;0,Editors;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,site_admin;username;tenant-a',
      membershipids: `${ADMIN_GROUP_ID},${EDITORS_GROUP_ID},${USER_ID}`,
    });
  });

  it('reads person fields as empty text and subtype as Default without a person_contact row, and timestamps as empty text without credential or login state', () => {
    expect(buildUserStruct(BARE_ROWS)).toMatchObject({
      subtype: 'Default', password: '', fname: '', lname: '', email: '', company: '', lastlogin: '', passwordCreated: '',
      membershipids: USER_ID,
    });
  });

  it('renders NULL person_contact, credential, login-state and account columns as empty text', () => {
    const rows = loginRows({
      account: accountRow({ remoteid: null }),
      credential: credentialRow({ password: null, passwordcreated: null }),
      loginState: loginStateRow(null),
      contact: contactRow({ fname: null, lname: null, email: null, company: null, subtype: null }),
    });
    expect(buildUserStruct(rows)).toMatchObject({
      subtype: '', password: '', fname: '', lname: '', email: '', company: '', remoteID: '', lastlogin: '', passwordCreated: '',
    });
  });
});

describe('ANONYMOUS_USER_STRUCT [legacy: core/mura/user/userUtility.cfc:784-801]', () => {
  it('holds the not-logged-in session.mura values and cannot be changed', () => {
    expect(ANONYMOUS_USER_STRUCT).toEqual({
      isLoggedIn: false, userID: '', siteID: '', subtype: 'Default', username: '', password: '', fname: '', lname: '', company: '',
      lastlogin: '', passwordCreated: '', email: '', remoteID: '', memberships: '', membershipids: '', showTrace: false,
    });
    expect(Object.isFrozen(ANONYMOUS_USER_STRUCT)).toBe(true);
  });
});

describe('buildLoginSnapshot and userStructOf', () => {
  it.each([
    {
      when: 'stores the user struct and its role list, with the pre-login lastlogin',
      rows: loginRows(),
      expected: {
        userid: USER_ID, username: 'site_admin', siteid: 'tenant-a', subtype: 'Default', password: PASSWORD_HASH, fname: 'Site', lname: 'Admin',
        email: 'site.admin@tenant-a.example.com', remoteid: '', company: 'Tenant A Programs', lastlogin: '2026-06-29T17:45:30.120',
        passwordcreated: '2026-03-02T08:04:10.000',
        roleList: 'Admin;tenant-a;0,Editors;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,site_admin;username;tenant-a',
        membershipIds: `${ADMIN_GROUP_ID},${EDITORS_GROUP_ID},${USER_ID}`,
      },
    },
    {
      when: 'stores missing timestamps as NULL and missing person fields as empty text',
      rows: BARE_ROWS,
      expected: {
        userid: USER_ID, username: 'site_admin', siteid: 'tenant-a', subtype: 'Default', password: '', fname: '', lname: '', email: '',
        remoteid: '', company: '', lastlogin: null, passwordcreated: null,
        roleList: 'S2IsPrivate;tenant-a,S2IsPrivate,site_admin;username;tenant-a', membershipIds: USER_ID,
      },
    },
  ])('$when', ({ rows, expected }) => {
    expect(buildLoginSnapshot(rows)).toEqual(expected);
  });

  it.each([
    { when: 'a full login', rows: loginRows() },
    { when: 'a login without credential, login state, person_contact or groups', rows: BARE_ROWS },
  ])('hydrates the same session.mura struct the login built for $when', ({ rows }) => {
    expect(userStructOf(buildLoginSnapshot(rows))).toEqual(buildUserStruct(rows));
  });

  it('reads NULL snapshot columns as empty text', () => {
    const snapshot: LoginSnapshot = {
      userid: USER_ID, username: null, siteid: null, subtype: null, password: null, fname: null, lname: null, email: null, remoteid: null,
      company: null, lastlogin: null, passwordcreated: null, roleList: '', membershipIds: USER_ID,
    };
    expect(userStructOf(snapshot)).toEqual({
      isLoggedIn: true, userID: USER_ID, username: '', siteID: '', subtype: '', password: '', fname: '', lname: '', email: '', remoteID: '',
      company: '', lastlogin: '', passwordCreated: '', memberships: '', membershipids: USER_ID,
    });
  });
});

describe('roleListHas and snapshotIsS2 [legacy: core/mura/permission.cfc:312,676,691]', () => {
  it.each([
    { when: 'finds an exact item', list: 'Admin;tenant-a;0,S2', entry: 'S2', expected: true },
    { when: 'rejects an item that differs in case', list: 'admin;tenant-a;0,s2', entry: 'Admin;tenant-a;0', expected: false },
    { when: 'never matches a prefix of an item', list: 'S2IsPrivate;tenant-a,S2IsPrivate', entry: 'S2', expected: false },
    { when: 'skips empty items', list: 'a,,b', entry: '', expected: false },
    { when: 'finds an item after an empty one', list: 'a,,b', entry: 'b', expected: true },
  ])('without ignoreCase, as listFind, it $when', ({ list, entry, expected }) => {
    expect(roleListHas(list, entry)).toBe(expected);
  });

  it.each([
    { when: 'matches an item that differs in case', list: 'S2ISPRIVATE;Tenant-A', entry: 'S2IsPrivate;tenant-a', expected: true },
    { when: 'folds the Kelvin sign to k as Java does', list: '\u212Aey', entry: 'key', expected: true },
    { when: 'matches sharp s and capital sharp s as Java does', list: 'stra\u00dfe', entry: 'STRA\u1e9eE', expected: true },
    { when: 'never matches items of another length', list: 'stra\u00dfe', entry: 'STRASSE', expected: false },
    { when: 'skips empty items', list: 'a,,b', entry: '', expected: false },
  ])('with ignoreCase, as listFindNoCase, it $when', ({ list, entry, expected }) => {
    expect(roleListHas(list, entry, { ignoreCase: true })).toBe(expected);
  });

  it.each([
    { when: 'holds S2', roleList: 'S2IsPrivate;default,S2IsPrivate,S2,admin;username;default', expected: true },
    { when: 'lacks S2', roleList: 'S2IsPrivate;default,S2IsPrivate,admin;username;default', expected: false },
    { when: 'holds only a lower-case s2', roleList: 's2,admin;username;default', expected: false },
  ])('snapshotIsS2 is $expected when the role list $when', ({ roleList, expected }) => {
    expect(snapshotIsS2({ roleList })).toBe(expected);
  });
});

describe('loadRoleMap and parseRoleMap', () => {
  it('loads config/role-map.json once per process: ten private-pool groups named after the ten synthetic roles', () => {
    expect(ROLE_MAP.sourceSha).toBe(PIN_SHA);
    expect(ROLE_MAP.scope).toBe('privateUserPool');
    expect(ROLE_MAP.groups.map(({ role }) => role)).toEqual([
      'timesheets.employee', 'timesheets.primary-approver', 'timesheets.secondary-approver', 'finance.preparer', 'finance.approver',
      'esignature.signer', 'esignature.auditor', 'reporting.exporter', 'surveys.manager', 'communications.sender',
    ]);
    expect(ROLE_MAP.groups.map(({ role }) => role)).toEqual([...SYNTHETIC_ROLES]);
    expect(ROLE_MAP.groups.map(({ groupName }) => groupName)).toEqual([...SYNTHETIC_ROLES]);
    expect(loadRoleMap()).toBe(loadRoleMap());
  });

  it('keeps only the sourceSha, scope and each group\'s groupName and role', () => {
    const parsed = parseRoleMap({ ...roleMapWith([{ groupName: 'Payroll Clerks', role: Roles.financePreparer, note: 'seeded' }]), extra: true });
    expect(parsed).toEqual(roleMapWith([{ groupName: 'Payroll Clerks', role: Roles.financePreparer }]));
  });

  it.each([
    { when: 'null', value: null },
    { when: 'an array', value: [] },
    { when: 'a map without sourceSha', value: { scope: 'privateUserPool', groups: [] } },
    { when: 'a map scoped to another pool', value: { ...roleMapWith([]), scope: 'publicUserPool' } },
    { when: 'a map whose groups is not an array', value: { ...roleMapWith([]), groups: {} } },
    { when: 'a null group', value: roleMapWith([null]) },
    { when: 'a group with an empty name', value: roleMapWith([{ groupName: '', role: Roles.financePreparer }]) },
    { when: 'a group without a role', value: roleMapWith([{ groupName: 'Payroll Clerks' }]) },
    { when: 'a group mapped to a non-synthetic role', value: roleMapWith([{ groupName: 'Admin', role: Roles.s2 }]) },
  ])('rejects $when with a TypeError', ({ value }) => {
    expect(() => parseRoleMap(value)).toThrow(TypeError);
  });
});

describe('tokenRolesFor [legacy: core/mura/permission.cfc:312,338-344,676,689-691]', () => {
  it.each(REGISTERED_SITES.map((site) => ({ site })))('grants s2 to an S2 user on registered site $site.siteId', ({ site }) => {
    expect(tokenRolesFor(snapshotFor(S2_ACCOUNT), site, NO_GRANTS)).toEqual(access(Roles.s2));
  });

  it.each([
    { when: 'the site whose private pool holds the Admin group', site: SITE_A, expected: access(Roles.siteAdmin, Roles.systemUser) },
    { when: 'a site with its own private pool', site: SITE_B, expected: NO_ACCESS },
    { when: 'the pool site', site: SITE_UMBRELLA, expected: NO_ACCESS },
  ])('grants a private-pool Admin member site-admin only on $when', ({ site, expected }) => {
    expect(tokenRolesFor(snapshotFor(PRIVATE_A_ACCOUNT, [ADMIN_A]), site, NO_GRANTS)).toEqual(expected);
  });

  it('matches the Admin group name exactly', () => {
    const lowerAdmin = group(ADMIN_GROUP_ID, 'admin', TENANT_A.siteId, 0);
    expect(tokenRolesFor(snapshotFor(PRIVATE_A_ACCOUNT, [lowerAdmin]), SITE_A, NO_GRANTS)).toEqual(access(Roles.systemUser));
  });

  it('maps core module grants of the user\'s groups to module roles in ascending order and ignores plugin module grants', () => {
    const moduleGrants = [
      grant(USERS_MODULE, EDITORS_A), grant(PLUGIN_MODULE, EDITORS_A), grant(CONTENT_MODULE, EDITORS_A), grant(USERS_MODULE, STAFF_A),
    ];
    const result = tokenRolesFor(snapshotFor(PRIVATE_A_ACCOUNT, [EDITORS_A, STAFF_A]), SITE_A, { moduleGrants, roleMap: ROLE_MAP });
    expect(result).toEqual(access(moduleRole(CONTENT_MODULE), moduleRole(USERS_MODULE), Roles.systemUser));
    expect(moduleRole(USERS_MODULE)).toBe('m:008');
  });

  it.each([
    {
      when: 'a private grant matches the site\'s private-pool group',
      account: PRIVATE_A_ACCOUNT, groups: [EDITORS_A], moduleGrant: grant(USERS_MODULE, EDITORS_A),
      expected: access(moduleRole(USERS_MODULE), Roles.systemUser),
    },
    {
      when: 'a public grant matches the site\'s public-pool group',
      account: PUBLIC_UMBRELLA_ACCOUNT, groups: [SUBSCRIBERS_UMBRELLA], moduleGrant: grant(USERS_MODULE, SUBSCRIBERS_UMBRELLA),
      expected: access(moduleRole(USERS_MODULE), Roles.member),
    },
    {
      when: 'the grant belongs to a group the user is not in',
      account: PRIVATE_A_ACCOUNT, groups: [STAFF_A], moduleGrant: grant(USERS_MODULE, EDITORS_A),
      expected: access(Roles.systemUser),
    },
    {
      when: 'a private grant names a group of the public pool',
      account: PUBLIC_UMBRELLA_ACCOUNT, groups: [SUBSCRIBERS_UMBRELLA], moduleGrant: { moduleId: USERS_MODULE, groupName: 'Subscribers', isPublic: 0 },
      expected: access(Roles.member),
    },
  ])('grants module roles on tenant-a only when $when', ({ account, groups, moduleGrant, expected }) => {
    expect(tokenRolesFor(snapshotFor(account, groups), SITE_A, { moduleGrants: [moduleGrant], roleMap: ROLE_MAP })).toEqual(expected);
  });

  it.each([
    { when: 'a tenant-a private-pool user on tenant-a', account: PRIVATE_A_ACCOUNT, site: SITE_A, expected: access(Roles.systemUser) },
    {
      when: 'a private-pool user whose site id differs in case',
      account: { username: 'editor_a', siteid: 'TENANT-A' }, site: SITE_A, expected: access(Roles.systemUser),
    },
    { when: 'a tenant-a private-pool user on tenant-b', account: PRIVATE_A_ACCOUNT, site: SITE_B, expected: NO_ACCESS },
    {
      when: 'an umbrella public-pool user on tenant-a, whose public pool is umbrella',
      account: PUBLIC_UMBRELLA_ACCOUNT, site: SITE_A, expected: access(Roles.member),
    },
    { when: 'an umbrella public-pool user on umbrella', account: PUBLIC_UMBRELLA_ACCOUNT, site: SITE_UMBRELLA, expected: access(Roles.member) },
    { when: 'an umbrella public-pool user on tenant-b', account: PUBLIC_UMBRELLA_ACCOUNT, site: SITE_B, expected: NO_ACCESS },
  ])('grants pool roles to $when', ({ account, site, expected }) => {
    expect(tokenRolesFor(snapshotFor(account), site, NO_GRANTS)).toEqual(expected);
  });

  it.each([
    {
      when: 'role-map groups in the site\'s private pool grant their roles in role-map order',
      account: PRIVATE_A_ACCOUNT, groups: [FINANCE_A, TIMESHEETS_A],
      expected: access(Roles.systemUser, Roles.timesheetsEmployee, Roles.financeApprover),
    },
    {
      when: 'a role-map group name matches without regard to case',
      account: PRIVATE_A_ACCOUNT, groups: [group(TIMESHEETS_GROUP_ID, 'Timesheets.Employee', TENANT_A.siteId, 0)],
      expected: access(Roles.systemUser, Roles.timesheetsEmployee),
    },
    {
      when: 'a role-map group of another site\'s private pool grants nothing',
      account: PRIVATE_B_ACCOUNT, groups: [group(TIMESHEETS_GROUP_ID, Roles.timesheetsEmployee, TENANT_B.siteId, 0)],
      expected: NO_ACCESS,
    },
    {
      when: 'a public group named after a synthetic role grants nothing beyond member',
      account: PUBLIC_UMBRELLA_ACCOUNT, groups: [group(TIMESHEETS_GROUP_ID, Roles.timesheetsEmployee, TENANT_UMBRELLA.siteId, 1)],
      expected: access(Roles.member),
    },
  ])('$when', ({ account, groups, expected }) => {
    expect(tokenRolesFor(snapshotFor(account, groups), SITE_A, NO_GRANTS)).toEqual(expected);
  });

  it('never carries group memberships as token roles', () => {
    const result = tokenRolesFor(snapshotFor(PRIVATE_A_ACCOUNT, [EDITORS_A, STAFF_A, SUBSCRIBERS_UMBRELLA]), SITE_A, NO_GRANTS);
    expect(result).toEqual(access(Roles.systemUser));
  });

  it('gives site access through a private-pool group alone, with only the roles its grants carry', () => {
    const snapshot = snapshotFor({ username: 'outside_editor', siteid: 'default' }, [EDITORS_A]);
    expect(tokenRolesFor(snapshot, SITE_A, NO_GRANTS)).toEqual(access());
    expect(tokenRolesFor(snapshot, SITE_A, { moduleGrants: [grant(USERS_MODULE, EDITORS_A)], roleMap: ROLE_MAP })).toEqual(access(moduleRole(USERS_MODULE)));
  });

  it('orders roles s2, site-admin, module roles, system-user, then role-map roles, each once', () => {
    const roleMap: RoleMap = parseRoleMap(roleMapWith([{ groupName: 'Editors', role: Roles.timesheetsEmployee }, ...ROLE_MAP.groups]));
    const options = { moduleGrants: [grant(USERS_MODULE, EDITORS_A), grant(USERS_MODULE, ADMIN_A)], roleMap };
    const s2Snapshot = snapshotFor(S2_ACCOUNT, [ADMIN_A, EDITORS_A, EDITORS_A, TIMESHEETS_A]);
    expect(tokenRolesFor(s2Snapshot, SITE_A, options)).toEqual(access('s2', 'site-admin', 'm:008', 'timesheets.employee'));
    const privateS2Snapshot = snapshotFor({ ...S2_ACCOUNT, siteid: TENANT_A.siteId }, [ADMIN_A, TIMESHEETS_A]);
    expect(tokenRolesFor(privateS2Snapshot, SITE_A, options)).toEqual(access('s2', 'site-admin', 'm:008', 'system-user', 'timesheets.employee'));
  });

  it.each([
    { when: 'a private-pool user', account: PRIVATE_B_ACCOUNT, expected: access(Roles.systemUser) },
    { when: 'a public-pool user', account: { username: 'member_b', siteid: TENANT_B.siteId, ispublic: 1 }, expected: access(Roles.member) },
  ])('reads an empty registry pool as the site\'s own id for $when', ({ account, expected }) => {
    const ownPools: TokenRoleSite = { siteId: TENANT_B.siteId, privateUserPoolId: null, publicUserPoolId: null };
    expect(tokenRolesFor(snapshotFor(account), ownPools, NO_GRANTS)).toEqual(expected);
  });

  it.each([
    { when: 'a private-pool Admin member', account: PRIVATE_A_ACCOUNT, groups: [ADMIN_A, TIMESHEETS_A] },
    { when: 'a public-pool user', account: PUBLIC_UMBRELLA_ACCOUNT, groups: [SUBSCRIBERS_UMBRELLA] },
  ])('grants no roles on a site outside the registry to $when', ({ account, groups }) => {
    const moduleGrants = groups.map((memberGroup) => grant(USERS_MODULE, memberGroup));
    expect(tokenRolesFor(snapshotFor(account, groups), UNREGISTERED_SITE, { moduleGrants, roleMap: ROLE_MAP })).toEqual(NO_ACCESS);
  });
});

describe('modulePermByRole and moduleGrantHeld [legacy: core/mura/permission.cfc:312,338-344]', () => {
  it.each([
    { when: 'an S2 user on a site without its groups', account: S2_ACCOUNT, groups: [], site: SITE_B, expected: true },
    { when: "a member of the site's private-pool Admin group", account: PRIVATE_A_ACCOUNT, groups: [ADMIN_A], site: SITE_A, expected: true },
    { when: "an Admin member of another site's private pool", account: PRIVATE_A_ACCOUNT, groups: [ADMIN_A], site: SITE_UMBRELLA, expected: false },
    {
      when: 'a member of a group named admin',
      account: PRIVATE_A_ACCOUNT, groups: [group(ADMIN_GROUP_ID, 'admin', TENANT_A.siteId, 0)], site: SITE_A, expected: false,
    },
    {
      when: 'an Admin member whose group site differs in case from the pool id',
      account: PRIVATE_A_ACCOUNT, groups: [group(ADMIN_GROUP_ID, 'Admin', 'TENANT-A', 0)], site: SITE_A, expected: false,
    },
    {
      when: 'an Admin member of a site outside the registry, whose pool is its own id',
      account: PRIVATE_A_ACCOUNT, groups: [group(ADMIN_GROUP_ID, 'Admin', UNREGISTERED_SITE.siteId, 0)], site: UNREGISTERED_SITE, expected: true,
    },
    { when: 'a private-pool user in no Admin group', account: PRIVATE_A_ACCOUNT, groups: [EDITORS_A], site: SITE_A, expected: false },
  ])('modulePermByRole is $expected for $when', ({ account, groups, site, expected }) => {
    expect(modulePermByRole(snapshotFor(account, groups), site)).toBe(expected);
  });

  it.each([
    { when: "a private grant to the user's private-pool group", account: PRIVATE_A_ACCOUNT, groups: [EDITORS_A], moduleGrant: grant(USERS_MODULE, EDITORS_A), expected: true },
    {
      when: "a public grant to the user's public-pool group",
      account: PUBLIC_UMBRELLA_ACCOUNT, groups: [SUBSCRIBERS_UMBRELLA], moduleGrant: grant(USERS_MODULE, SUBSCRIBERS_UMBRELLA), expected: true,
    },
    { when: 'a grant of another module', account: PRIVATE_A_ACCOUNT, groups: [EDITORS_A], moduleGrant: grant(CONTENT_MODULE, EDITORS_A), expected: false },
    {
      when: 'a grant whose group name differs in case',
      account: PRIVATE_A_ACCOUNT, groups: [EDITORS_A], moduleGrant: { moduleId: USERS_MODULE, groupName: 'editors', isPublic: 0 }, expected: false,
    },
    { when: 'a grant to a group the user is not in', account: PRIVATE_A_ACCOUNT, groups: [STAFF_A], moduleGrant: grant(USERS_MODULE, EDITORS_A), expected: false },
  ])('moduleGrantHeld of the Users module on tenant-a is $expected for $when', ({ account, groups, moduleGrant, expected }) => {
    expect(moduleGrantHeld(snapshotFor(account, groups), SITE_A, USERS_MODULE, [moduleGrant])).toBe(expected);
  });
});
