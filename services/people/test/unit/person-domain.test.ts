/** Masa userBean shaping of a Type=2 save: init defaults, setters, the user-pool rule, controller input rules and the person/account split. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, legacyQuery } from '@opt2/platform/legacy-compat';
import { tenantIdForSite, withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  seedRegistry,
  type ThrowawaySchema,
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
  type AccountControls,
  type UserSite,
  type UserValues,
} from '../../src/domain/person.js';
import { lastUpdateInfo as repositoryLastUpdateInfo } from '../../src/repo/repository.js';
import { PERSON_COLUMNS } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const CLOCK = fixedClock(NOW);
// queryNew column list of userBean.init [legacy: core/mura/user/userBean.cfc:162].
const ADDRESS_COLUMNS =
  'addressid,userid,siteid,address1,address2,city,state,zip,country,isPrimary,addressName,addressNotes,phone,fax,addressURL,longitude,latitude,addressEmail,hours'.split(',');
const SITE_ID_REQUIRED = "The attribute 'SITEID' is required when saving a user.";

/** `userBean.set` of posted `params` over `current` (a new bean by default). */
function applied(params: Record<string, unknown>, current: UserValues = newUserValues(CLOCK)): UserValues {
  return applyUserInput(current, normaliseParams(params));
}

function bean(overrides: Partial<UserValues>): UserValues {
  return { ...newUserValues(CLOCK), ...overrides };
}

describe('userBean.init defaults', () => {
  it('holds the legacy init values, Member (ispublic 1) and subtype Default included', () => {
    expect(USER_BEAN_DEFAULTS).toMatchObject({
      userid: '',
      type: 2,
      subtype: 'Default',
      s2: 0,
      perm: 0,
      inactive: 0,
      ispublic: 1,
      subscribe: 1,
      keepprivate: 0,
      passedprotect: true,
      extenddatatable: 'tclassextenddatauseractivity',
      isnew: 1,
      lastlogin: '',
      groupid: '',
      errors: {},
    });
    expect(Object.isFrozen(USER_BEAN_DEFAULTS)).toBe(true);
  });

  it('starts addresses as an empty query of the legacy address columns', () => {
    expect(USER_BEAN_DEFAULTS.addresses).toEqual(legacyQuery(ADDRESS_COLUMNS, []));
  });
});

describe('newUserValues', () => {
  it('adds passwordcreated, lastupdate and created at the clock time to the defaults', () => {
    expect(newUserValues(CLOCK)).toEqual({
      ...USER_BEAN_DEFAULTS,
      passwordcreated: NOW,
      lastupdate: NOW,
      created: NOW,
      addresses: legacyQuery(ADDRESS_COLUMNS, []),
      errors: {},
    });
  });

  it('gives each bean its own dates, address query and mutable error struct', () => {
    const first = newUserValues(CLOCK);
    const second = newUserValues(CLOCK);
    expect(first.created).not.toBe(first.lastupdate);
    expect(first.addresses).not.toBe(second.addresses);
    expect(first.addresses).not.toBe(USER_BEAN_DEFAULTS.addresses);
    expect(Object.isFrozen(first.errors)).toBe(false);
  });
});

describe('normaliseParams', () => {
  it('lower-cases keys, and a key repeated in another casing keeps the later value', () => {
    expect([...normaliseParams({ FName: 'Pat', LNAME: 'Lee', fname: 'Ada' })]).toEqual([
      ['fname', 'Ada'],
      ['lname', 'Lee'],
    ]);
  });
});

describe('applyUserInput', () => {
  it.each([
    ['trims posted text kept under its own key', { email: '  pat@example.com\t', company: 'Acme' }, { email: 'pat@example.com', company: 'Acme' }],
    ['keeps a posted number as its CFML text', { perm: 1, notes: 1e20, website: 0.5 }, { perm: '1', notes: '1E+020', website: '0.5' }],
    ['keeps a complex value of a key without a setter unchanged', { interests: ['I1', 'I2'] }, { interests: ['I1', 'I2'] }],
    ['cuts lastUpdateBy to 50 characters after trimming', { lastUpdateBy: `  ${'x'.repeat(60)}` }, { lastupdateby: 'x'.repeat(50) }],
    ['trims groupID and categoryID', { groupID: ' G1,G2 ', categoryID: '\tC1 ' }, { groupid: 'G1,G2', categoryid: 'C1' }],
    ['reads a NULL groupID as empty text', { groupID: null }, { groupid: '' }],
    ['sets username and password through the no-cache setters', { usernameNoCache: ' pat ', passwordNoCache: ' pw-1 ' }, { username: 'pat', password: 'pw-1' }],
    ['maps firstName and lastName onto fname and lname', { firstName: ' Pat ', lastName: 'Lee' }, { fname: 'Pat', lname: 'Lee' }],
    ['sets type 1 for group in any case', { type: 'Group' }, { type: 1 }],
    ['sets type 2 for any other text', { type: 'member' }, { type: 2 }],
    ['keeps a numeric type as its number', { type: ' 1 ' }, { type: 1 }],
    ['sets a numeric keepPrivate', { keepPrivate: ' 1 ' }, { keepprivate: 1 }],
    ['ignores a non-numeric keepPrivate', { keepPrivate: 'yes' }, { keepprivate: 0 }],
    ['sets a boolean passedProtect as posted', { passedProtect: 'no' }, { passedprotect: 'no' }],
    ['ignores a non-boolean passedProtect', { passedProtect: 'maybe' }, { passedprotect: true }],
    ['sets a new trimmed subType', { subType: ' Staff ' }, { subtype: 'Staff' }],
    ['keeps a subType that differs only in case', { subType: 'DEFAULT' }, { subtype: 'Default' }],
    ['ignores an empty subType', { subType: '' }, { subtype: 'Default' }],
    ['sets a trimmed siteID', { siteID: ' tenant-a ' }, { siteid: 'tenant-a' }],
    ['sets an errors struct', { errors: { email: 'Required' } }, { errors: { email: 'Required' } }],
    ['ignores errors that are not a struct', { errors: 'invalid' }, { errors: {} }],
    ['ignores an errors array', { errors: ['invalid'] }, { errors: {} }],
    ['ignores an errors date', { errors: NOW }, { errors: {} }],
    ['ignores an errors query', { errors: legacyQuery(['email'], [{ email: 'Required' }]) }, { errors: {} }],
    ['sets addresses that are not a query', { addresses: '' }, { addresses: '' }],
    ['ignores an addresses query', { addresses: legacyQuery(['addressid'], [{ addressid: 'A1' }]) }, { addresses: legacyQuery(ADDRESS_COLUMNS, []) }],
  ] as const)('%s', (_label, params, expected) => {
    expect(applied(params)).toMatchObject(expected);
  });

  it('keeps the current siteid when the posted one differs only in case', () => {
    expect(applied({ siteid: 'tenant-a' }, bean({ siteid: 'Tenant-A' })).siteid).toBe('Tenant-A');
  });

  it.each([
    ['a date', NOW, NOW],
    ['date text', '6/30/2026', new Date(2026, 5, 30)],
  ])('sets lastLogin and passwordCreated from %s', (_label, posted, expected) => {
    expect(applied({ lastLogin: posted, passwordCreated: posted })).toMatchObject({ lastlogin: expected, passwordcreated: expected });
  });

  it('ignores lastLogin and passwordCreated given text no date parser accepts', () => {
    expect(applied({ lastLogin: 'soon', passwordCreated: 'soon' })).toMatchObject({ lastlogin: '', passwordcreated: NOW });
  });

  it.each([
    ['a date as is', new Date(2026, 0, 2, 3, 4, 5), new Date(2026, 0, 2, 3, 4, 5)],
    ['ISO text with a T separator', '2026-06-23T14:22:35', new Date(2026, 5, 23, 14, 22, 35)],
    ['ODBC-style spaced date-time text', '2026-06-23 14:22:35', new Date(2026, 5, 23, 14, 22, 35)],
    ['locale date text', 'June 30, 2026', new Date(2026, 5, 30)],
    ['month-name date text without a comma', 'Jun 30 2026', new Date(2026, 5, 30)],
    ['an impossible calendar day as empty text', '02/30/2026', ''],
    ['text no date parser accepts as empty text', 'not a date', ''],
  ])('parses lastUpdate and created from %s', (_label, posted, expected) => {
    expect(applied({ lastUpdate: posted, created: posted })).toMatchObject({ lastupdate: expected, created: expected });
  });

  it('throws where ACF rejects a complex value for a text setter', () => {
    expect(() => applied({ groupID: { id: 'G1' } })).toThrow(new TypeError('The groupID value is not a simple value'));
  });

  it('stores a posted __proto__ as a data key without touching any prototype', () => {
    const values = applyUserInput(newUserValues(CLOCK), normaliseParams(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>));
    expect(Object.getOwnPropertyDescriptor(values, '__proto__')?.value).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect((values as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('leaves the current values unchanged', () => {
    const current = newUserValues(CLOCK);
    applied({ fname: 'Pat', type: 'group' }, current);
    expect(current).toEqual(newUserValues(CLOCK));
  });
});

describe('resolveUserSite without a posted siteid', () => {
  const noRegistry: TenantDb = {
    schema: 'people',
    withTenant: () => Promise.reject(new Error('unexpected tenant read')),
    withMetadata: () => Promise.reject(new Error('unexpected registry read')),
    end: () => Promise.resolve(),
  };

  it.each<[string, Record<string, unknown>]>([
    ['a whitespace siteid', { siteid: ' \t' }],
    ['a blank siteid with a posted switchToPublic', { siteid: '', switchtopublic: '1' }],
    ['no siteid with a posted switchToPrivate', { switchtoprivate: '1' }],
  ])('keeps the current site, its tenant and visibility without a registry read or pool switch for %s', async (_label, params) => {
    const site = await resolveUserSite(noRegistry, TENANT_B.tenantId, normaliseParams(params), bean({ siteid: 'tenant-a', ispublic: 0 }));
    expect(site).toEqual({ siteId: 'tenant-a', poolTenantId: TENANT_A.tenantId, isPublic: 0, poolSwitch: null });
  });

  it('throws the SITEID-required error when the current siteid is blank too', async () => {
    await expect(resolveUserSite(noRegistry, TENANT_A.tenantId, normaliseParams({ siteid: '' }), bean({ siteid: ' ' }))).rejects.toThrow(SITE_ID_REQUIRED);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('resolveUserSite against a seeded tenant registry', () => {
  // A registered site whose pool ids and pool tenants are NULL.
  const OWN_POOL_SITE = 'tenant-c';
  const OWN_POOL_TENANT = tenantIdForSite(OWN_POOL_SITE);
  let handle: ThrowawaySchema | undefined;
  let registry: TenantDb;

  beforeAll(async () => {
    const created = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    handle = created;
    registry = created.app;
    await seedRegistry(registry);
    await withMetadata(registry, (tx) =>
      tx.query(`INSERT INTO ${created.schema}.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, LOCALTIMESTAMP(3))`, [
        OWN_POOL_SITE,
        OWN_POOL_TENANT,
      ]),
    );
  });

  afterAll(async () => {
    await handle?.drop();
  });

  const A = TENANT_A.tenantId;
  it.each<[string, string, Record<string, unknown>, Partial<UserValues>, UserSite]>([
    ['a public user lands in the public user pool', A, { siteid: 'tenant-a' }, { siteid: 'tenant-a', ispublic: 1 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: null }],
    ['a private user lands in the private user pool', A, { siteid: 'tenant-a' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'tenant-a', poolTenantId: A, isPublic: 0, poolSwitch: null }],
    ['numeric ispublic text 0 reads as private', A, { siteid: 'tenant-a' }, { siteid: 'tenant-a', ispublic: ' 0 ' },
      { siteId: 'tenant-a', poolTenantId: A, isPublic: 0, poolSwitch: null }],
    ['non-numeric ispublic reads as public and stays text', A, { siteid: 'tenant-a' }, { siteid: 'tenant-a', ispublic: 'x' },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 'x', poolSwitch: null }],
    ['switchToPublic 1 moves a private user to the public pool', A, { siteid: 'tenant-a', switchtopublic: ' 1 ' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: 'public' }],
    ['a switch CFML reads as the number 1', A, { siteid: 'tenant-a', switchtopublic: '1.0' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: 'public' }],
    ['switchToPrivate 1 moves a public user to the private pool', A, { siteid: 'tenant-a', switchtoprivate: '1' }, { siteid: 'umbrella', ispublic: 1 },
      { siteId: 'tenant-a', poolTenantId: A, isPublic: 0, poolSwitch: 'private' }],
    ['switchToPublic wins over switchToPrivate', A, { siteid: 'tenant-a', switchtopublic: '1', switchtoprivate: '1' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: 'public' }],
    ['a switch flag other than 1 is ignored', A, { siteid: 'tenant-a', switchtopublic: '0', switchtoprivate: 'yes' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'tenant-a', poolTenantId: A, isPublic: 0, poolSwitch: null }],
    ['a pool id differing only in case keeps the current site id', A, { siteid: 'tenant-a' }, { siteid: 'UMBRELLA', ispublic: 1 },
      { siteId: 'UMBRELLA', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: null }],
    ['a switch takes the pool id as registered', A, { siteid: 'tenant-a', switchtopublic: '1' }, { siteid: 'UMBRELLA', ispublic: 1 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: 'public' }],
    ['a site that is its own user pool keeps its site', TENANT_B.tenantId, { siteid: 'tenant-b' }, { siteid: 'tenant-b', ispublic: 1 },
      { siteId: 'tenant-b', poolTenantId: TENANT_B.tenantId, isPublic: 1, poolSwitch: null }],
    ['a NULL public pool defaults to the site and its tenant', OWN_POOL_TENANT, { siteid: OWN_POOL_SITE }, { siteid: OWN_POOL_SITE, ispublic: 1 },
      { siteId: OWN_POOL_SITE, poolTenantId: OWN_POOL_TENANT, isPublic: 1, poolSwitch: null }],
    ['a NULL private pool defaults to the site and its tenant', OWN_POOL_TENANT, { siteid: OWN_POOL_SITE, switchtoprivate: '1' }, { siteid: OWN_POOL_SITE, ispublic: 1 },
      { siteId: OWN_POOL_SITE, poolTenantId: OWN_POOL_TENANT, isPublic: 0, poolSwitch: 'private' }],
  ])('%s', async (_label, tid, params, current, expected) => {
    await expect(resolveUserSite(registry, tid, normaliseParams(params), bean(current))).resolves.toEqual(expected);
  });

  it('answers service unavailable for a tenant without a registry entry', async () => {
    const unregistered = tenantIdForSite('tenant-unregistered');
    const outcome = resolveUserSite(registry, unregistered, normaliseParams({ siteid: 'tenant-a' }), bean({ siteid: 'tenant-a' }));
    await expect(outcome).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(outcome).rejects.toMatchObject({
      message: `Tenant ${unregistered} has no site registry entry`,
      surface: 'auto',
      reason: 'tenant-unregistered',
    });
  });
});

describe('fullName', () => {
  it.each([
    ['a user is the trimmed first and last name', { type: 2, fname: ' Pat', lname: 'Lee ', groupname: 'Editors' }, 'Pat Lee'],
    ['a user without a first name is the last name', { type: '2', fname: '', lname: 'Lee', groupname: '' }, 'Lee'],
    ['numeric type text compares as a number', { type: '2.0', fname: 'Pat', lname: '', groupname: '' }, 'Pat'],
    ['a group is its group name', { type: 1, fname: 'Pat', lname: 'Lee', groupname: 'Editors' }, 'Editors'],
  ] as const)('%s', (_label, values, expected) => {
    expect(fullName(values)).toBe(expected);
  });
});

describe('restrictAdminInput', () => {
  const posted = normaliseParams({
    action: 'Update',
    userid: 'U1',
    s2: '1',
    username: 'pat',
    password: 'pw-1',
    password2: 'pw-1',
    passwordNoCache: 'pw-1',
    email: 'pat@example.com',
    inactive: '0',
    isPublic: '1',
    fname: 'Pat',
  });
  const keys = (input: ReadonlyMap<string, unknown>): string[] => [...input.keys()];

  it('lets a super user post every key, s2 included', () => {
    const { input, action } = restrictAdminInput(posted, { actorIsSuperUser: true, targetIsS2: true });
    expect(input).toEqual(posted);
    expect(input).not.toBe(posted);
    expect(action).toBe('Update');
  });

  it('drops s2 for a non-super user editing a user that is not S2', () => {
    const { input, action } = restrictAdminInput(posted, { actorIsSuperUser: false, targetIsS2: false });
    expect(keys(input)).toEqual(keys(posted).filter((key) => key !== 's2'));
    expect(action).toBe('Update');
  });

  it('drops s2 and the account keys for a non-super user editing an S2 user', () => {
    const { input, action } = restrictAdminInput(posted, { actorIsSuperUser: false, targetIsS2: true });
    expect(keys(input)).toEqual(['action', 'userid', 'fname']);
    expect(action).toBe('Update');
  });

  it.each(['delete', 'DELETE'])('turns a non-super user action %s on an S2 user into invalid', (posting) => {
    const { input, action } = restrictAdminInput(new Map([['action', posting]]), { actorIsSuperUser: false, targetIsS2: true });
    expect(action).toBe('invalid');
    expect(input.get('action')).toBe('invalid');
  });

  it('keeps a super user delete of an S2 user', () => {
    expect(restrictAdminInput(new Map([['action', 'Delete']]), { actorIsSuperUser: true, targetIsS2: true }).action).toBe('Delete');
  });

  it('reads a missing action as empty text', () => {
    expect(restrictAdminInput(new Map(), { actorIsSuperUser: false, targetIsS2: true }).action).toBe('');
  });

  it('leaves the posted input unchanged', () => {
    const before = [...posted];
    restrictAdminInput(posted, { actorIsSuperUser: false, targetIsS2: true });
    expect([...posted]).toEqual(before);
  });
});

describe('restrictProfileInput', () => {
  const session = { userId: 'SESSION-USER', siteId: 'tenant-a' };

  it('takes userid and siteid from the session and drops the account-level keys', () => {
    const posted = normaliseParams({ userid: 'OTHER', siteid: 'tenant-b', isPublic: '1', s2: '1', type: '1', groupID: 'G1', fname: 'Pat' });
    const restricted = restrictProfileInput(posted, session);
    expect(Object.fromEntries(restricted)).toEqual({ userid: 'SESSION-USER', siteid: 'tenant-a', fname: 'Pat' });
    expect(posted.get('userid')).toBe('OTHER');
  });

  it('adds userid and siteid when they were not posted', () => {
    expect(Object.fromEntries(restrictProfileInput(new Map([['fname', 'Pat']]), session))).toEqual({
      fname: 'Pat',
      userid: 'SESSION-USER',
      siteid: 'tenant-a',
    });
  });
});

describe('applySuperUserRule', () => {
  it.each([
    ['a non-super user cannot keep s2', 1, false, { s2: 0, ispublic: 1 }],
    ['a super user keeps s2 and an S2 user is never public', 1, true, { s2: 1, ispublic: 0 }],
    ['boolean text s2 counts as S2', 'yes', true, { s2: 'yes', ispublic: 0 }],
    ['a super user saving a non-S2 user leaves ispublic', 0, true, { s2: 0, ispublic: 1 }],
  ] as const)('%s', (_label, s2, actorIsSuperUser, expected) => {
    const values = bean({ s2, ispublic: 1 });
    expect(applySuperUserRule(values, actorIsSuperUser)).toMatchObject(expected);
    expect(values).toMatchObject({ s2, ispublic: 1 });
  });

  it('throws for an s2 CFML cannot read as a boolean', () => {
    expect(() => applySuperUserRule(bean({ s2: 'abc' }), true)).toThrow(TypeError);
  });
});

describe('nullIfEmpty', () => {
  it.each([
    ['', null],
    [null, null],
    [undefined, null],
    [' ', ' '],
    ['x', 'x'],
  ])('maps %j to %j', (value, expected) => {
    expect(nullIfEmpty(value)).toBe(expected);
  });
});

describe('splitUserValues', () => {
  const saved = applied({
    userid: 'U1',
    siteid: 'tenant-a',
    fname: 'Pat',
    lname: 'Lee',
    email: 'pat@example.com',
    company: '',
    jobtitle: 'Analyst',
    mobilephone: '555-0100',
    website: 'https://example.com',
    subtype: 'Staff',
    ext: '7',
    contactform: 'email',
    lastupdateby: 'Ada Admin',
    lastupdatebyid: 'ACTOR',
    subscribe: '0',
    notes: 'n',
    description: '',
    interests: 'I1,I2',
    keepprivate: '1.9',
    photofileid: '',
    imname: 'pat',
    imservice: 'xmpp',
    tags: 't1,t2',
    username: 'pat',
    password: '',
    s2: '0',
    perm: '0',
    inactive: '1',
    ispublic: '0',
    remoteid: 'R1',
    groupid: 'G1,,G2,',
  });

  it("splits people's 24 person columns from identity's account change", () => {
    const { person, account } = splitUserValues(saved);
    expect(Object.keys(person)).toEqual([...PERSON_COLUMNS]);
    expect(person).toEqual({
      groupname: null,
      fname: 'Pat',
      lname: 'Lee',
      email: 'pat@example.com',
      company: null,
      jobtitle: 'Analyst',
      mobilephone: '555-0100',
      website: 'https://example.com',
      subtype: 'Staff',
      ext: null,
      contactform: 'email',
      lastupdate: NOW,
      lastupdateby: 'Ada Admin',
      lastupdatebyid: 'ACTOR',
      subscribe: 0,
      notes: 'n',
      description: null,
      interests: 'I1,I2',
      keepprivate: 1,
      photofileid: null,
      imname: 'pat',
      imservice: 'xmpp',
      created: NOW,
      tags: 't1,t2',
    });
    expect(account).toEqual({
      siteId: 'tenant-a',
      account: { UserName: 'pat', S2: 0, Perm: 0, InActive: 1, isPublic: 0, Admin: 0, remoteID: 'R1', tablist: '', Type: 2 },
      groupIds: ['G1', 'G2'],
      switchToPublic: false,
      switchToPrivate: false,
    });
  });

  it.each([
    ['a posted tablist, trimmed by the setter', applied({ tabList: ' Basic,Extended ' }, saved), 'Basic,Extended'],
    ['a stored NULL tablist as empty text, which identity stores as NULL', { ...saved, tablist: null as unknown as string }, ''],
  ])('carries %s', (_label, values, tablist) => {
    expect(splitUserValues(values).account.account.tablist).toBe(tablist);
  });

  it.each<[string, AccountControls | undefined, Record<string, unknown>, { switchToPublic: boolean; switchToPrivate: boolean }]>([
    ["resolveUserSite's public switch", { poolSwitch: 'public' }, {}, { switchToPublic: true, switchToPrivate: false }],
    ["resolveUserSite's private switch", { poolSwitch: 'private' }, {}, { switchToPublic: false, switchToPrivate: true }],
    ['no applied switch', { poolSwitch: null }, {}, { switchToPublic: false, switchToPrivate: false }],
    ['no controls', undefined, {}, { switchToPublic: false, switchToPrivate: false }],
    ['posted switch keys without an applied switch', {}, { switchtopublic: '1', switchtoprivate: '1' }, { switchToPublic: false, switchToPrivate: false }],
    ['a posted switch other than the applied one', { poolSwitch: 'private' }, { switchtopublic: '1' }, { switchToPublic: false, switchToPrivate: true }],
  ])('carries %s as the pool flags, ignoring posted switch keys', (_label, controls, posted, flags) => {
    expect(splitUserValues({ ...saved, ...posted }, controls).account).toMatchObject(flags);
  });

  it.each([
    ['no controls', undefined, {}],
    ["ceditprofile's updateGroups false", { updateGroups: false }, { updateGroups: false }],
    ['an originID', { originID: 'tenant-a' }, { originID: 'tenant-a' }],
    ['both controls', { updateGroups: true, originID: '' }, { updateGroups: true, originID: '' }],
  ])('carries %s as the membership controls of userManager.update', (_label, controls, expected) => {
    const { account } = splitUserValues(saved, controls);
    expect({ updateGroups: account.updateGroups, originID: account.originID }).toEqual({ updateGroups: undefined, originID: undefined, ...expected });
  });

  it("keeps an S2 save's pool visibility for identity's S2 rule when split before applySuperUserRule", () => {
    const values = applied({ siteid: 'umbrella', s2: '1', ispublic: '1' }, saved);
    expect(splitUserValues(values).account).toMatchObject({ siteId: 'umbrella', account: { S2: 1, isPublic: 1 } });
    expect(splitUserValues(applySuperUserRule(values, true)).account.account.isPublic).toBe(0);
  });

  it('carries a posted password and any non-zero s2 as 1', () => {
    const { account } = splitUserValues({ ...saved, password: 'pw-1', s2: '2' });
    expect(account.account).toMatchObject({ Password: 'pw-1', S2: 1 });
  });

  it('writes NULL for a date column that holds no date', () => {
    const { person } = splitUserValues(applied({ lastUpdate: 'not a date', created: 'soon' }, saved));
    expect(person).toMatchObject({ lastupdate: null, created: null });
  });

  it('writes no groups for an empty groupid', () => {
    expect(splitUserValues({ ...saved, groupid: '' }).account.groupIds).toEqual([]);
  });

  it.each([
    ['a group', { type: 'group' }, 'splitUserValues splits Type=2 users only'],
    ['a non-numeric int column', { subscribe: 'yes' }, 'Cannot convert yes to a number'],
    ['a complex text column', { notes: { text: 'n' } }, 'The notes value is not a simple value'],
  ])('throws for %s', (_label, posted, message) => {
    expect(() => splitUserValues(applied(posted, saved))).toThrow(new TypeError(message));
  });
});

describe('auditActorFor', () => {
  const claims: UserClaims = {
    iss: 'opt2-identity',
    aud: 'people',
    sub: 'ACTOR',
    sid: 'SESSION-1',
    tid: TENANT_A.tenantId,
    site: 'tenant-a',
    roles: ['site-admin'],
    s2: false,
    epoch: 1,
    iat: 0,
    exp: 1,
  };
  const acting = { userId: 'IDENTITY-ACTOR', fname: 'Ada', lname: 'Admin' };
  const person = { userid: 'U1', fname: 'Pat', lname: 'Lee' };

  it('names the logged-in session user by the verified subject and identity names', () => {
    expect(auditActorFor(claims, acting)).toEqual({ userId: 'ACTOR', fname: 'Ada', lname: 'Admin', isLoggedIn: true });
    expect(lastUpdateInfo(auditActorFor(claims, acting), person)).toEqual({ lastupdateby: 'Ada Admin', lastupdatebyid: 'ACTOR' });
  });

  it.each([
    ['anonymous', undefined, acting],
    ['without identity names', claims, undefined],
  ])('has no actor when %s, so the person stamps itself', (_label, who, names) => {
    expect(auditActorFor(who, names)).toBeUndefined();
    expect(lastUpdateInfo(auditActorFor(who, names), person)).toEqual({ lastupdateby: 'Pat Lee', lastupdatebyid: 'U1' });
  });

  it("re-exports the repository's lastUpdateInfo", () => {
    expect(lastUpdateInfo).toBe(repositoryLastUpdateInfo);
  });
});
