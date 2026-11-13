/** Typed builders over identity's row types, and the canonical seeded actors every identity suite shares. */
import { LEGACY_ADMIN_SENTINEL_ID, cfUuid } from '@opt2/platform/legacy-compat';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, businessClock, type TenantFixture } from '@opt2/platform/testing';
import { buildLoginSnapshot, loadRoleMap, type LoginRows, type MembershipGroup, type RoleMapEntry } from '../../src/domain/roles.js';
import { cfmxCompatHash } from '../../src/legacy/hash.js';
import type {
  CredentialRow,
  GroupAccountRow,
  LoginSnapshot,
  LoginStateRow,
  MembershipRow,
  OAuthClientRow,
  OAuthTokenRow,
  PermissionRow,
  PersonContactRow,
  SessionRow,
  UserAccountRow,
} from '../../src/repo/tables.js';
import type { IdentitySeed } from './memory-repo.js';

const NOON = businessClock('12:00:00');
const ONE_HOUR_MS = 3_600_000;

/** A fresh Date at noon of the business date, local time. */
function businessNoon(): Date {
  return NOON.now();
}

/** Lower-cased first block of a CF UUID, for readable unique defaults. */
function shortId(id: string): string {
  return id.slice(0, 8).toLowerCase();
}

/** Obviously synthetic plain passwords of the seeded actors; generated test data, not secrets. */
export const TEST_PASSWORDS = Object.freeze({
  default: 'opt2-test-user',
  admin: 'opt2-test-admin',
  editor: 'opt2-test-editor',
  siteAdmin: 'opt2-test-site-admin',
  pooledMember: 'opt2-test-pooled-member',
  memberB: 'opt2-test-member-b',
  synthetic: 'opt2-test-synthetic',
});

/** `tpermissions.Type` values: node verdicts and module grants. */
export type PermissionType = 'Editor' | 'Author' | 'Read' | 'Deny' | 'module';

/** A Type=2 `user_account` row of a private-pool system user of tenant-a. */
export function accountRow(overrides: Partial<UserAccountRow> = {}): UserAccountRow {
  const userid = overrides.userid ?? cfUuid();
  return {
    tenant_id: TENANT_A.tenantId,
    userid,
    username: `user_${shortId(userid)}`,
    type: 2,
    admin: null,
    s2: 0,
    perm: 0,
    inactive: 0,
    ispublic: 0,
    siteid: TENANT_A.siteId,
    remoteid: null,
    tablist: null,
    opt2_state: 'active',
    ...overrides,
  };
}

/** A `credential` row; `password` is the stored value, which defaults to the CFMX_COMPAT hash of `plainPassword`. */
export function credentialRow(overrides: Partial<CredentialRow> & { plainPassword?: string } = {}): CredentialRow {
  const { plainPassword = TEST_PASSWORDS.default, ...columns } = overrides;
  return {
    tenant_id: TENANT_A.tenantId,
    userid: cfUuid(),
    password: cfmxCompatHash(plainPassword),
    passwordcreated: businessNoon(),
    ...columns,
  };
}

/** A `login_state` row of a user who has not logged in yet. */
export function loginStateRow(overrides: Partial<LoginStateRow> = {}): LoginStateRow {
  return { tenant_id: TENANT_A.tenantId, userid: cfUuid(), lastlogin: null, ...overrides };
}

/** A Type=1 `group_account` row of tenant-a's private pool, its person-style columns null. */
export function groupRow(overrides: Partial<GroupAccountRow> = {}): GroupAccountRow {
  return {
    tenant_id: TENANT_A.tenantId,
    userid: cfUuid(),
    groupname: 'Test Group',
    fname: null,
    lname: null,
    username: null,
    password: null,
    passwordcreated: null,
    email: null,
    company: null,
    jobtitle: null,
    mobilephone: null,
    website: null,
    type: 1,
    subtype: 'Default',
    ext: null,
    contactform: null,
    admin: null,
    s2: 0,
    lastlogin: null,
    lastupdate: businessNoon(),
    lastupdateby: 'System',
    lastupdatebyid: null,
    perm: 0,
    inactive: 0,
    ispublic: 0,
    siteid: TENANT_A.siteId,
    subscribe: 0,
    notes: null,
    description: null,
    interests: null,
    keepprivate: 0,
    photofileid: null,
    imname: null,
    imservice: null,
    created: businessNoon(),
    remoteid: null,
    tags: null,
    tablist: null,
    row_version: '0',
    ...overrides,
  };
}

/** A `membership` row linking `userid` to `groupid`. */
export function membershipRow(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return { tenant_id: TENANT_A.tenantId, userid: cfUuid(), groupid: cfUuid(), ...overrides };
}

/** A `permission` row; defaults to an Editor verdict on tenant-a's home node. */
export function permissionRow(overrides: Omit<Partial<PermissionRow>, 'type'> & { type?: PermissionType } = {}): PermissionRow {
  return {
    tenant_id: TENANT_A.tenantId,
    contentid: LEGACY_ADMIN_SENTINEL_ID,
    groupid: cfUuid(),
    siteid: TENANT_A.siteId,
    type: 'Editor',
    ...overrides,
  };
}

/** An active target-primary `session` row without a user or login snapshot. */
export function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    tenant_id: TENANT_A.tenantId,
    session_id: cfUuid(),
    user_id: null,
    site_id: TENANT_A.siteId,
    login_snapshot: null,
    epoch: '1',
    csrf_secret: cfUuid(),
    mode: 'target-primary',
    state: 'active',
    jar_ref: null,
    created_at: businessNoon(),
    updated_at: businessNoon(),
    ended_at: null,
    admin_state: null,
    ...overrides,
  };
}

/** A `client_credentials` `oauth_client` row of tenant-a. */
export function oauthClientRow(overrides: Partial<OAuthClientRow> = {}): OAuthClientRow {
  return {
    tenant_id: TENANT_A.tenantId,
    clientsecret: cfUuid(),
    siteid: TENANT_A.siteId,
    granttype: 'client_credentials',
    userid: null,
    clientid: cfUuid(),
    name: 'OPT-2 Test Client',
    created: businessNoon(),
    lastupdate: businessNoon(),
    description: null,
    redirecturl: null,
    lastupdatebidy: null,
    lastupdateby: null,
    ...overrides,
  };
}

/** A `client_credentials` `oauth_token` row of a client and a user, expiring one hour after business noon. */
export function oauthTokenRow(overrides: Partial<OAuthTokenRow> = {}): OAuthTokenRow {
  return {
    tenant_id: TENANT_A.tenantId,
    granttype: 'client_credentials',
    userid: cfUuid(),
    clientid: cfUuid(),
    accesscode: null,
    data: null,
    expires: new Date(businessNoon().getTime() + ONE_HOUR_MS),
    token: cfUuid(),
    ...overrides,
  };
}

/** A `person_contact` projection row of a tenant-a user. */
export function personContactRow(overrides: Partial<PersonContactRow> = {}): PersonContactRow {
  const userId = overrides.user_id ?? cfUuid();
  const siteId = overrides.site_id ?? TENANT_A.siteId;
  return {
    tenant_id: TENANT_A.tenantId,
    user_id: userId,
    site_id: siteId,
    email: `user_${shortId(userId)}@${siteId ?? TENANT_A.siteId}.opt2.test`,
    fname: 'Test',
    lname: 'User',
    company: null,
    subtype: 'Default',
    aggregate_version: '1',
    updated_at: businessNoon(),
    groupname: null,
    jobtitle: null,
    mobilephone: null,
    website: null,
    ext: null,
    contactform: null,
    subscribe: null,
    notes: null,
    description: null,
    interests: null,
    keepprivate: null,
    photofileid: null,
    imname: null,
    imservice: null,
    tags: null,
    created: null,
    lastupdate: null,
    lastupdateby: null,
    lastupdatebyid: null,
    ...overrides,
  };
}

/** The installed `default` site, which no platform tenant fixture covers. */
export const DEFAULT_SITE_TENANT = Object.freeze({ key: 'default' as const, siteId: 'default', tenantId: tenantIdForSite('default') });

/** The tenant an actor's rows are stored under. */
export type ActorTenant = TenantFixture | typeof DEFAULT_SITE_TENANT;

/** A seeded user with every identity row a login reads, and its plain password. */
export interface TestActor {
  readonly key: string;
  readonly tenant: ActorTenant;
  readonly siteId: string;
  readonly account: UserAccountRow;
  readonly credential: CredentialRow;
  readonly loginState: LoginStateRow;
  readonly contact: PersonContactRow;
  readonly groups: readonly GroupAccountRow[];
  readonly memberships: readonly MembershipRow[];
  readonly plainPassword: string;
}

/** The `rsGetRoles` row of a group. */
export function membershipGroupOf(group: GroupAccountRow): MembershipGroup {
  return { groupId: group.userid, groupName: group.groupname, siteId: group.siteid, isPublic: group.ispublic };
}

/** Options of {@link loginSnapshotFixture}; `groups` replaces the actor's own, `overrides` replaces login rows. */
export interface LoginSnapshotFixtureOptions {
  actor: TestActor;
  groups?: readonly GroupAccountRow[];
  overrides?: Partial<LoginRows>;
}

/** The login snapshot `loginByQuery` fixes for the actor's rows. */
export function loginSnapshotFixture(opts: LoginSnapshotFixtureOptions): LoginSnapshot {
  const { actor, groups = actor.groups, overrides = {} } = opts;
  return buildLoginSnapshot({
    account: actor.account,
    credential: actor.credential,
    loginState: actor.loginState,
    contact: actor.contact,
    groups: groups.map(membershipGroupOf),
    ...overrides,
  });
}

interface ActorSpec {
  key: string;
  tenant: ActorTenant;
  username: string;
  fname: string;
  lname: string;
  email: string;
  plainPassword: string;
  ispublic: number;
  s2?: number;
  lastlogin?: Date | null;
  groupNames?: readonly string[];
}

/** An actor of `spec` whose groups are private-pool groups of its own site, frozen so suites cannot alter shared rows. */
function defineActor(spec: ActorSpec): TestActor {
  const { tenantId: tenant_id, siteId } = spec.tenant;
  const account = accountRow({ tenant_id, siteid: siteId, username: spec.username, s2: spec.s2 ?? 0, ispublic: spec.ispublic });
  const { userid } = account;
  const groups = (spec.groupNames ?? []).map((groupname) => Object.freeze(groupRow({ tenant_id, siteid: siteId, groupname })));
  return Object.freeze({
    key: spec.key,
    tenant: spec.tenant,
    siteId,
    account: Object.freeze(account),
    credential: Object.freeze(credentialRow({ tenant_id, userid, plainPassword: spec.plainPassword })),
    loginState: Object.freeze(loginStateRow({ tenant_id, userid, lastlogin: spec.lastlogin ?? null })),
    contact: Object.freeze(personContactRow({ tenant_id, user_id: userid, site_id: siteId, email: spec.email, fname: spec.fname, lname: spec.lname })),
    groups: Object.freeze(groups),
    memberships: Object.freeze(groups.map((group) => Object.freeze(membershipRow({ tenant_id, userid, groupid: group.userid })))),
    plainPassword: spec.plainPassword,
  });
}

/** The installed super-user `admin` of site `default`. */
export const ADMIN_S2: TestActor = defineActor({
  key: 'admin-s2',
  tenant: DEFAULT_SITE_TENANT,
  username: 'admin',
  fname: 'Admin',
  lname: 'User',
  email: 'admin@localhost.com',
  plainPassword: TEST_PASSWORDS.admin,
  ispublic: 0,
  s2: 1,
  lastlogin: businessNoon(),
});

/** A `qa_editor`-style system user of tenant-a's private pool, in its non-admin `Editor` group. */
export const EDITOR: TestActor = defineActor({
  key: 'editor',
  tenant: TENANT_A,
  username: 'qa_editor',
  fname: 'QA',
  lname: 'Editor',
  email: `qa_editor@${TENANT_A.siteId}.opt2.test`,
  plainPassword: TEST_PASSWORDS.editor,
  ispublic: 0,
  groupNames: ['Editor'],
});

/** A system user of tenant-a's private pool in its `Admin` group. */
export const SITE_ADMIN_A: TestActor = defineActor({
  key: 'site-admin-a',
  tenant: TENANT_A,
  username: 'site_admin_a',
  fname: 'Site',
  lname: 'Admin',
  email: `site_admin_a@${TENANT_A.siteId}.opt2.test`,
  plainPassword: TEST_PASSWORDS.siteAdmin,
  ispublic: 0,
  groupNames: ['Admin'],
});

/** A public-pool member stored in `umbrella`, tenant-a's public user pool. */
export const POOLED_MEMBER: TestActor = defineActor({
  key: 'pooled-member',
  tenant: TENANT_UMBRELLA,
  username: 'pooled_member',
  fname: 'Pooled',
  lname: 'Member',
  email: `pooled_member@${TENANT_UMBRELLA.siteId}.opt2.test`,
  plainPassword: TEST_PASSWORDS.pooledMember,
  ispublic: 1,
});

/** A public member of tenant-b. */
export const MEMBER_B: TestActor = defineActor({
  key: 'member-b',
  tenant: TENANT_B,
  username: 'member_b',
  fname: 'Member',
  lname: 'B',
  email: `member_b@${TENANT_B.siteId}.opt2.test`,
  plainPassword: TEST_PASSWORDS.memberB,
  ispublic: 1,
});

/** A tenant-a private-pool user in the group of one role-map entry. */
function syntheticMember({ groupName, role }: RoleMapEntry): TestActor {
  const username = `synthetic_${role.replace(/[^A-Za-z0-9]/g, '_')}`;
  return defineActor({
    key: `synthetic:${role}`,
    tenant: TENANT_A,
    username,
    fname: 'Synthetic',
    lname: role,
    email: `${username}@${TENANT_A.siteId}.opt2.test`,
    plainPassword: TEST_PASSWORDS.synthetic,
    ispublic: 0,
    groupNames: [groupName],
  });
}

/** One tenant-a private-pool user per role-map group, keyed by the synthetic role it grants. */
export const SYNTHETIC_MEMBERS: Readonly<Record<string, TestActor>> = Object.freeze(
  Object.fromEntries((await loadRoleMap()).groups.map((entry) => [entry.role, syntheticMember(entry)])),
);

/** Every canonical actor, synthetic members last. */
export const ALL_ACTORS: readonly TestActor[] = Object.freeze([
  ADMIN_S2,
  EDITOR,
  SITE_ADMIN_A,
  POOLED_MEMBER,
  MEMBER_B,
  ...Object.values(SYNTHETIC_MEMBERS),
]);

/** The memory-repo seed of `actors`' rows; a group shared by several actors is seeded once. */
export function actorSeed(...actors: readonly TestActor[]): IdentitySeed {
  const groups = new Map<string, GroupAccountRow>();
  for (const group of actors.flatMap((actor) => actor.groups)) {
    const key = `${group.tenant_id}/${group.userid.toUpperCase()}`;
    if (!groups.has(key)) groups.set(key, group);
  }
  return {
    accounts: actors.map((actor) => actor.account),
    credentials: actors.map((actor) => actor.credential),
    loginStates: actors.map((actor) => actor.loginState),
    groups: [...groups.values()],
    memberships: actors.flatMap((actor) => actor.memberships),
    personContacts: actors.map((actor) => actor.contact),
  };
}

/** The seed of every canonical actor. */
export const DEFAULT_SEED: IdentitySeed = actorSeed(...ALL_ACTORS);
