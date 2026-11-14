/** The person domain as the cusers, ceditprofile and JSON API saves compose it, over fixture actors and the fixture registry, without PostgreSQL; per-function cases are in person-domain.test.ts. */
import { describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  businessClock,
  fixedClock,
  fixtureForTenant,
  poolTenantExpectation,
  registryPayloads,
} from '@opt2/platform/testing';
import {
  USER_BEAN_DEFAULTS,
  applySuperUserRule,
  applyUserInput,
  auditActorFor,
  fullName,
  lastUpdateInfo,
  newUserValues,
  normaliseParams,
  nullIfEmpty,
  resolveUserSite,
  restrictAdminInput,
  restrictProfileInput,
  splitUserValues,
  type CfNumeric,
  type UserSite,
  type UserValues,
} from '../../src/domain/person.js';
import type { AccountView, ActingUser } from '../../src/legacy/identity-client.js';
import { PERSON_COLUMNS, type PersonRow } from '../../src/repo/tables.js';
import { createRecordingDb, type RecordingDb } from '../helpers/app.js';
import {
  ADMIN_S2,
  OTHER_TENANT_PERSON,
  POOLED_MEMBER_PERSON,
  S2_USER,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  SYSTEM_USER_A_PERSON,
  accountFor,
  type TestActor,
} from '../helpers/fixtures.js';

const CLOCK = businessClock();

type VerifiedClaims = NonNullable<Parameters<typeof auditActorFor>[0]>;
type AuditStamp = ReturnType<typeof lastUpdateInfo>;

const REGISTRY_READ = /FROM people\.tenant_registry WHERE tenant_id = \$1$/;

/** The `tenant_registry` row `seedRegistry` stores for the platform fixture of `tenantId`; none for any other tenant. */
function fixtureRegistryRows(tenantId: unknown): Record<string, unknown>[] {
  const fixture = fixtureForTenant(String(tenantId));
  const site = registryPayloads().find((payload) => payload.siteId === fixture?.siteId);
  if (fixture === undefined || site === undefined) return [];
  return [
    {
      site_id: site.siteId,
      tenant_id: fixture.tenantId,
      public_user_pool_id: site.publicUserPoolId,
      private_user_pool_id: site.privateUserPoolId,
      category_pool_id: site.categoryPoolId,
      file_pool_id: site.filePoolId,
      display_pool_id: site.displayPoolId,
      content_pool_ids: site.contentPoolIds,
      public_user_pool_tenant: poolTenantExpectation(fixture, 'publicUser'),
      private_user_pool_tenant: poolTenantExpectation(fixture, 'privateUser'),
      category_pool_tenant: poolTenantExpectation(fixture, 'category'),
      file_pool_tenant: poolTenantExpectation(fixture, 'file'),
      display_pool_tenant: poolTenantExpectation(fixture, 'display'),
      content_pool_tenants: (site.contentPoolIds as string[]).map((siteId) => tenantIdForSite(siteId)),
      domains: site.domains,
      aggregate_version: '1',
      updated_at: CLOCK.now(),
    },
  ];
}

/** A recording database whose registry reads answer from the platform tenant fixtures. */
function fixtureRegistry(): RecordingDb {
  return createRecordingDb({ responses: [[REGISTRY_READ, (_text, values) => fixtureRegistryRows(values[0])]] });
}

/** The parameters of every registry read `db` received. */
function registryReads(db: RecordingDb): unknown[][] {
  return db.statements().flatMap((statement) => (REGISTRY_READ.test(statement.text) ? [[...statement.values]] : []));
}

/** `userBean.set` of a stored person row and its identity account, as `userManager.read` loads a user. */
function storedBean(person: PersonRow, account: AccountView): UserValues {
  const columns = Object.fromEntries(PERSON_COLUMNS.map((column) => [column, person[column]]));
  return applyUserInput(
    newUserValues(CLOCK),
    normaliseParams({
      ...columns,
      userid: person.userid,
      siteid: account.siteId,
      username: account.username,
      s2: account.s2,
      ispublic: account.isPublic,
      inactive: account.inactive,
      perm: account.perm,
      type: account.type,
      remoteid: account.remoteId,
      tablist: account.tablist,
    }),
  );
}

/** The claims the platform verifier returns for a fixture actor's user token. */
function claimsOf(actor: TestActor, tid: string): VerifiedClaims {
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: actor.sub,
    sid: `sid-${actor.sub}`,
    tid,
    site: actor.site,
    roles: [...actor.roles],
    s2: actor.s2,
    epoch: 1,
    iat: 0,
    exp: 300,
  };
}

describe('a new user bean', () => {
  const TEXT_PROPERTIES = [
    'userid',
    'groupname',
    'fname',
    'lname',
    'email',
    'company',
    'jobtitle',
    'website',
    'mobilephone',
    'notes',
    'description',
    'interests',
    'photofileid',
    'imname',
    'imservice',
    'tags',
    'tablist',
  ] as const;

  it('starts every name, contact, profile and tab-list property empty and has no user id before a save', () => {
    expect(Object.fromEntries(TEXT_PROPERTIES.map((key) => [key, USER_BEAN_DEFAULTS[key]]))).toEqual(
      Object.fromEntries(TEXT_PROPERTIES.map((key) => [key, ''])),
    );
  });

  it('splits into a person of NULL text stamped at the clock and a public Type 2 account without password or groups', () => {
    const t = new Date(2026, 5, 30, 9, 15, 30, 250);
    const values = newUserValues(fixedClock(t));
    expect(values).toMatchObject({ passwordcreated: t, lastupdate: t, created: t });

    const { person, account } = splitUserValues(values);
    const text = PERSON_COLUMNS.filter((column) => typeof USER_BEAN_DEFAULTS[column as keyof typeof USER_BEAN_DEFAULTS] === 'string' && column !== 'subtype');
    const nulls = Object.fromEntries(text.map((column) => [column, nullIfEmpty(values[column] as string)]));
    expect(Object.values(nulls).every((value) => value === null)).toBe(true);
    expect(person).toEqual({ ...nulls, subtype: 'Default', ext: null, lastupdate: t, created: t, subscribe: 1, keepprivate: 0 });
    expect(account).toEqual({
      siteId: '',
      account: { UserName: '', S2: 0, Perm: 0, InActive: 0, isPublic: 1, Admin: 0, remoteID: '', tablist: '', Type: 2 },
      groupIds: [],
      switchToPublic: false,
      switchToPrivate: false,
    });
  });
});

describe('posted user input', () => {
  it('reads FNAME, fname and FName as one property, the last posted casing winning', () => {
    const input = normaliseParams({ FNAME: 'Ada', fname: 'Bea', FName: 'Cy', LName: 'Lee' });
    expect([...input.keys()]).toEqual(['fname', 'lname']);

    const values = applyUserInput(newUserValues(CLOCK), input);
    expect(Object.keys(values).filter((key) => key.toLowerCase() === 'fname')).toEqual(['fname']);
    expect(splitUserValues(values).person).toMatchObject({ fname: 'Cy', lname: 'Lee' });
  });

  it('keeps the first 50 characters of a trimmed lastUpdateBy', () => {
    const posted = `  ${'0123456789'.repeat(6)}\t `;
    const values = applyUserInput(newUserValues(CLOCK), normaliseParams({ lastUpdateBy: posted }));
    expect(values.lastupdateby).toBe('0123456789'.repeat(5));
    expect(splitUserValues(values).person.lastupdateby).toBe(posted.trim().slice(0, 50));
  });

  it.each<[string, unknown, number]>([
    ['numeric keepPrivate text replaces the stored value', ' 0 ', 0],
    ['a numeric keepPrivate replaces the stored value', 0, 0],
    ['non-numeric keepPrivate text keeps the stored value', 'no', 1],
    ['an empty keepPrivate keeps the stored value', '', 1],
  ])('%s', (_label, posted, expected) => {
    const stored = applyUserInput(newUserValues(CLOCK), normaliseParams({ keepPrivate: 1 }));
    const values = applyUserInput(stored, normaliseParams({ keepPrivate: posted }));
    expect(values.keepprivate).toBe(expected);
    expect(splitUserValues(values).person.keepprivate).toBe(expected);
  });

  it('sets type through setType and keeps unknown keys on the bean without writing them to either side', () => {
    const values = applyUserInput(newUserValues(CLOCK), normaliseParams({ type: ' 2 ', favoriteColor: ' teal ', Nickname: 'Syd' }));
    expect(values).toMatchObject({ type: 2, favoritecolor: 'teal', nickname: 'Syd' });
    expect(JSON.stringify(splitUserValues(values))).not.toMatch(/teal|Syd/);
    expect(applyUserInput(values, normaliseParams({ type: 'Group' })).type).toBe(1);
  });

  it('names a stored user by first and last name, the label an anonymous save stamps', () => {
    const values = storedBean(SYSTEM_USER_A_PERSON, accountFor(SYSTEM_USER_A_PERSON));
    expect(fullName(values)).toBe('Sydney System');
    expect(lastUpdateInfo(undefined, values).lastupdateby).toBe(fullName(values));
  });
});

describe('user-pool rule over the fixture registry', () => {
  const A = TENANT_A.tenantId;
  const B = TENANT_B.tenantId;
  const UMBRELLA = TENANT_UMBRELLA.tenantId;

  it.each<[string, string, Record<string, unknown>, CfNumeric, UserSite]>([
    ['switchToPublic puts a tenant-a user in its public pool umbrella', A, { siteid: 'tenant-a', switchToPublic: '1' }, 0,
      { siteId: TENANT_UMBRELLA.siteId, poolTenantId: UMBRELLA, isPublic: 1, poolSwitch: 'public' }],
    ['switchToPrivate puts a tenant-a user in its private pool tenant-a', A, { siteid: 'tenant-a', switchToPrivate: '1' }, 1,
      { siteId: TENANT_A.siteId, poolTenantId: A, isPublic: 0, poolSwitch: 'private' }],
    ['a private tenant-a user without a switch lands in the private pool', A, { siteid: 'tenant-a' }, 0,
      { siteId: TENANT_A.siteId, poolTenantId: A, isPublic: 0, poolSwitch: null }],
    ['a public tenant-a user without a switch lands in the public pool', A, { siteid: 'tenant-a' }, 1,
      { siteId: TENANT_UMBRELLA.siteId, poolTenantId: UMBRELLA, isPublic: 1, poolSwitch: null }],
    ['a public tenant-b user stays in tenant-b', B, { siteid: 'tenant-b' }, 1,
      { siteId: TENANT_B.siteId, poolTenantId: B, isPublic: 1, poolSwitch: null }],
    ['a private tenant-b user stays in tenant-b', B, { siteid: 'tenant-b' }, 0,
      { siteId: TENANT_B.siteId, poolTenantId: B, isPublic: 0, poolSwitch: null }],
  ])('%s', async (_label, tid, posted, isPublic, expected) => {
    const input = normaliseParams(posted);
    const current = applyUserInput({ ...newUserValues(CLOCK), ispublic: isPublic }, input);
    await expect(resolveUserSite(fixtureRegistry(), tid, input, current)).resolves.toEqual(expected);
  });

  it("reads the token tenant's registry entry once, whatever site the request posts", async () => {
    const registry = fixtureRegistry();
    const input = normaliseParams({ siteid: TENANT_A.siteId });
    const site = await resolveUserSite(registry, B, input, applyUserInput(newUserValues(CLOCK), input));
    expect(site).toEqual({ siteId: TENANT_B.siteId, poolTenantId: B, isPublic: 1, poolSwitch: null });
    expect(registryReads(registry)).toEqual([[B]]);
  });

  it.each([
    ['an empty', ''],
    ['a whitespace', ' \t'],
  ])('keeps the current site without a registry read for %s posted siteid', async (_label, siteid) => {
    const registry = fixtureRegistry();
    const current = storedBean(SYSTEM_USER_A_PERSON, accountFor(SYSTEM_USER_A_PERSON));
    const site = await resolveUserSite(registry, A, normaliseParams({ siteid, switchToPublic: '1' }), current);
    expect(site).toEqual({ siteId: TENANT_A.siteId, poolTenantId: A, isPublic: 0, poolSwitch: null });
    expect(registry.statements()).toEqual([]);
  });
});

describe('admin and profile input restrictions', () => {
  it("keeps an S2 user's account keys from a site admin, applies the rest and voids a delete", () => {
    const target = accountFor(S2_USER);
    const restriction = { actorIsSuperUser: SITE_ADMIN_A.s2, targetIsS2: isCfUuid(S2_USER.userid) && target.s2 !== 0 };
    const posted = normaliseParams({
      action: 'Update',
      userid: S2_USER.userid,
      siteid: target.siteId,
      s2: '0',
      username: 'hijack',
      password: 'pw-hijack',
      password2: 'pw-hijack',
      passwordNoCache: 'pw-hijack',
      email: 'hijack@example.test',
      inactive: '1',
      isPublic: '1',
      fname: 'Renamed',
    });
    const { input, action } = restrictAdminInput(posted, restriction);
    expect(action).toBe('Update');

    const { person, account } = splitUserValues(applyUserInput(storedBean(S2_USER, target), input));
    expect(person).toMatchObject({ fname: 'Renamed', email: S2_USER.email });
    expect(account.account).toEqual({ UserName: target.username, S2: 1, Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', tablist: '', Type: 2 });
    expect(restrictAdminInput(normaliseParams({ action: 'delete', userid: S2_USER.userid }), restriction).action).toBe('invalid');
  });

  it.each<[string, TestActor, number, Partial<UserValues>]>([
    ['a site admin posting s2 cannot make an ordinary user S2', SITE_ADMIN_A, 0, { s2: 0, ispublic: '1' }],
    ['a super user posting s2 makes an ordinary user S2 and private', ADMIN_S2, 1, { s2: '1', ispublic: 0 }],
  ])('%s', (_label, viewer, s2, ruled) => {
    const target = accountFor(POOLED_MEMBER_PERSON);
    const posted = normaliseParams({ action: 'Update', userid: POOLED_MEMBER_PERSON.userid, s2: '1', username: 'renamed' });
    const { input } = restrictAdminInput(posted, { actorIsSuperUser: viewer.s2, targetIsS2: target.s2 !== 0 });
    const values = applyUserInput(storedBean(POOLED_MEMBER_PERSON, target), input);

    expect(splitUserValues(values).account.account).toMatchObject({ UserName: 'renamed', S2: s2, isPublic: 1 });
    expect(applySuperUserRule(values, viewer.s2)).toMatchObject(ruled);
  });

  it('saves a profile as the session user in its stored site, without account-level keys or group changes', () => {
    const stored = accountFor(SYSTEM_USER_A_PERSON);
    const posted = normaliseParams({
      userid: OTHER_TENANT_PERSON.userid,
      siteid: TENANT_B.siteId,
      isPublic: '1',
      s2: '1',
      type: '1',
      groupID: 'G1',
      jobTitle: 'Lead',
    });
    const input = restrictProfileInput(posted, { userId: SYSTEM_USER_A.sub, siteId: stored.siteId });
    expect(Object.fromEntries(input)).toEqual({ userid: SYSTEM_USER_A.sub, siteid: TENANT_A.siteId, jobtitle: 'Lead' });

    const { person, account } = splitUserValues(applyUserInput(storedBean(SYSTEM_USER_A_PERSON, stored), input), { updateGroups: false });
    expect(person.jobtitle).toBe('Lead');
    expect(account).toMatchObject({ siteId: TENANT_A.siteId, groupIds: [], updateGroups: false, account: { S2: 0, isPublic: 0, Type: 2 } });
  });
});

describe('lastUpdate audit stamp', () => {
  const FORGED_ID = 'F0000000-0000-0000-0000000000000000';
  const LONG_NAMES: ActingUser = { userId: 'not-the-token-subject', fname: 'Bartholomew-Alexander', lname: 'Fitzwilliam-Montgomery-Smythe' };

  it.each<[string, VerifiedClaims | undefined, ActingUser | undefined, AuditStamp]>([
    ['a logged-in site admin from verified claims and identity names cut to 50 characters', claimsOf(SITE_ADMIN_A, TENANT_A.tenantId), LONG_NAMES,
      { lastupdateby: 'Bartholomew-Alexander Fitzwilliam-Montgomery-Smyth', lastupdatebyid: SITE_ADMIN_A.sub }],
    ['an anonymous save with the saved person itself', undefined, undefined,
      { lastupdateby: 'Sydney System', lastupdatebyid: SYSTEM_USER_A_PERSON.userid }],
  ])('stamps %s, ignoring a posted lastUpdateBy and lastUpdateByID', (_label, claims, acting, expected) => {
    const posted = normaliseParams({ lastUpdateBy: 'Forged Name', LastUpdateByID: FORGED_ID });
    const values = applyUserInput(storedBean(SYSTEM_USER_A_PERSON, accountFor(SYSTEM_USER_A_PERSON)), posted);
    const { person } = splitUserValues(values);
    expect(person).toMatchObject({ lastupdateby: 'Forged Name', lastupdatebyid: FORGED_ID });

    const audit = lastUpdateInfo(auditActorFor(claims, acting), { userid: values.userid, fname: values.fname, lname: values.lname });
    expect({ ...person, ...audit }).toMatchObject(expected);
  });
});

describe('person and account split', () => {
  const NUMERIC_OR_DATE: ReadonlySet<string> = new Set(['ext', 'lastupdate', 'created', 'subscribe', 'keepprivate']);

  it('gives people exactly the person columns and identity only the account, credential and membership fields', () => {
    const personPosted = Object.fromEntries(PERSON_COLUMNS.filter((column) => !NUMERIC_OR_DATE.has(column)).map((column) => [column, `person-${column}`]));
    const accountPosted = {
      username: 'acct-user',
      password: 'acct-pass',
      s2: '1',
      isPublic: '0',
      inactive: '1',
      perm: '1',
      remoteID: 'acct-remote',
      tabList: 'acct-tabs',
      type: '2',
      siteid: TENANT_A.siteId,
      groupID: 'G-1,G-2',
    };
    const values = applyUserInput(newUserValues(CLOCK), normaliseParams({ ...personPosted, subscribe: '0', keepPrivate: '1', ...accountPosted }));
    const { person, account } = splitUserValues(values);

    expect(Object.keys(person)).toEqual([...PERSON_COLUMNS]);
    expect(person).toMatchObject({ ...personPosted, ext: null, subscribe: 0, keepprivate: 1, lastupdate: CLOCK.now(), created: CLOCK.now() });
    expect(account).toEqual({
      siteId: TENANT_A.siteId,
      account: { UserName: 'acct-user', Password: 'acct-pass', S2: 1, Perm: 1, InActive: 1, isPublic: 0, Admin: 0, remoteID: 'acct-remote', tablist: 'acct-tabs', Type: 2 },
      groupIds: ['G-1', 'G-2'],
      switchToPublic: false,
      switchToPrivate: false,
    });

    const accountKeys = [...Object.keys(account), ...Object.keys(account.account)].map((key) => key.toLowerCase());
    expect(accountKeys.filter((key) => (PERSON_COLUMNS as readonly string[]).includes(key))).toEqual([]);
    expect(JSON.stringify(account)).not.toContain('person-');
    expect(JSON.stringify(person)).not.toMatch(/acct-|G-1/);
  });
});
