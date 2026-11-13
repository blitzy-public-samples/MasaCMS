/** Deterministic people rows, identity accounts and token actors for tenants A, B, umbrella and the installed `default` site. */
import { Roles, moduleRole } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { BUSINESS_DATE, TENANT_A, TENANT_B, TENANT_UMBRELLA, asOf, businessClock, type Clock } from '@opt2/platform/testing';
import type { AccountView } from '../../src/legacy/identity-client.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import {
  ADDRESS,
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  FAVORITE,
  GROUP_NAME,
  INTEREST,
  PERSON,
  PERSON_ARCHIVE,
  TAG,
  type AddressRow,
  type ExtendAttributeRow,
  type ExtendDataRow,
  type ExtendSetRow,
  type ExtendSubtypeRow,
  type FavoriteRow,
  type GroupNameRow,
  type InterestRow,
  type PeopleTableName,
  type PersonArchiveRow,
  type PersonRow,
  type RosterOperationRow,
  type TagRow,
} from '../../src/repo/tables.js';

const SEED_CLOCK = businessClock();
/** Width of `stringvalue`, the left part of an extended value legacy stores beside `attributeValue`. */
const STRINGVALUE_WIDTH = 255;
// Integer keys start far above what the user_tag and extend_data_user_activity sequences issue within one suite, because
// seeded rows keep their own keys and never advance those sequences.
const ID_BASE = 1_000_000;

type CounterKey = 'person' | 'tagid' | 'dataid' | 'attributeid';
const counters: Record<CounterKey, number> = { person: 0, tagid: ID_BASE, dataid: ID_BASE, attributeid: ID_BASE };
/** Counter values after the fixed datasets were built; `resetFixtureCounters` returns to them. */
let floors: Record<CounterKey, number> = { ...counters };

function next(key: CounterKey): number {
  counters[key] += 1;
  return counters[key];
}

/** Restarts the builder counters: names repeat from `Person0001`, integer keys never reuse a fixed dataset's key. */
export function resetFixtureCounters(): void {
  Object.assign(counters, floors);
}

/** A fresh Date at noon of the business date, local time. */
function businessNoon(): Date {
  return SEED_CLOCK.now();
}

/** Local midnight of a `yyyy-mm-dd` day, as a `timestamp(3)` column holds it. */
function localDay(day: string): Date {
  return new Date(`${day}T00:00:00`);
}

/** The `yyyy-mm-dd` day `days` after `day`. */
function addDays(day: string, days: number): string {
  const date = localDay(day);
  date.setDate(date.getDate() + days);
  return asOf(date);
}

/** Tenant of a legacy site id; rows without one belong to tenant-a. */
function tenantFor(siteId: string | null | undefined): string {
  return siteId === null || siteId === undefined || siteId === '' ? TENANT_A.tenantId : tenantIdForSite(siteId);
}

/** The installed site, which no platform tenant fixture covers. */
export const DEFAULT_SITE = Object.freeze({ siteId: 'default', tenantId: tenantIdForSite('default') });

/** `effectiveFrom` of the seam-1 archive scenarios: the day after the business date. */
export const ARCHIVE_EFFECTIVE_FROM: string = addDays(BUSINESS_DATE, 1);

/** Open timesheet days of the archived person on or after `ARCHIVE_EFFECTIVE_FROM`, each of which becomes a blackout. */
export const OPEN_TIMESHEET_DAYS: readonly string[] = Object.freeze([0, 1, 2].map((days) => addDays(ARCHIVE_EFFECTIVE_FROM, days)));

/** A Type=2 `person` row; names and email follow the call-order counter, timestamps business noon. */
export function personRow(overrides: Partial<PersonRow> = {}): PersonRow {
  const seq = String(next('person')).padStart(4, '0');
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  return {
    tenant_id: tenantFor(siteid),
    userid: cfUuid(),
    groupname: null,
    fname: 'Test',
    lname: `Person${seq}`,
    email: `person${seq}@${siteid}.opt2.test`,
    company: null,
    jobtitle: null,
    mobilephone: null,
    website: null,
    subtype: 'Default',
    ext: null,
    contactform: null,
    lastupdate: businessNoon(),
    lastupdateby: 'System',
    lastupdatebyid: null,
    siteid,
    subscribe: 0,
    notes: null,
    description: null,
    interests: null,
    keepprivate: 0,
    photofileid: null,
    imname: null,
    imservice: null,
    created: businessNoon(),
    tags: null,
    row_version: '1',
    ...overrides,
  };
}

/** A non-primary `user_address` row. */
export function addressRow(overrides: Partial<AddressRow> = {}): AddressRow {
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  return {
    tenant_id: tenantFor(siteid),
    addressid: cfUuid(),
    userid: cfUuid(),
    siteid,
    addressname: 'Home',
    address1: '1 Main Street',
    address2: null,
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    country: 'United States',
    phone: null,
    fax: null,
    isprimary: 0,
    addressnotes: null,
    addressurl: null,
    longitude: 0,
    latitude: 0,
    addressemail: null,
    hours: null,
    ...overrides,
  };
}

/** A `user_interest` row of tenant-a. */
export function interestRow(overrides: Partial<InterestRow> = {}): InterestRow {
  return { tenant_id: TENANT_A.tenantId, userid: cfUuid(), categoryid: cfUuid(), ...overrides };
}

/** A `user_tag` row with the next counter `tagid`. */
export function tagRow(overrides: Partial<TagRow> = {}): TagRow {
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  return { tenant_id: tenantFor(siteid), tagid: overrides.tagid ?? next('tagid'), userid: cfUuid(), siteid, tag: 'tag', ...overrides };
}

/** A `user_favorite` row bookmarking a content node. */
export function favoriteRow(overrides: Partial<FavoriteRow> = {}): FavoriteRow {
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  return {
    tenant_id: tenantFor(siteid),
    favoriteid: cfUuid(),
    userid: cfUuid(),
    favoritename: 'Home',
    favorite: cfUuid(),
    type: 'Page',
    siteid,
    datecreated: businessNoon(),
    columnnumber: null,
    rownumber: null,
    maxrssitems: null,
    ...overrides,
  };
}

/** An active `Default` user subtype (`tclassextend` of baseTable `tusers`), with `extendSubType`'s flag defaults. */
export function extendSubtypeRow(overrides: Partial<ExtendSubtypeRow> = {}): ExtendSubtypeRow {
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  return {
    tenant_id: tenantFor(siteid),
    subtypeid: cfUuid(),
    siteid,
    basetable: 'tusers',
    basekeyfield: 'userID',
    datatable: 'tclassextenddatauseractivity',
    type: 'User',
    subtype: 'Default',
    isactive: 1,
    notes: null,
    lastupdate: businessNoon(),
    datecreated: businessNoon(),
    lastupdateby: 'System',
    hassummary: 1,
    hasbody: 1,
    description: null,
    availablesubtypes: null,
    iconclass: null,
    hasassocfile: 1,
    hasconfigurator: 1,
    adminonly: 0,
    ...overrides,
  };
}

/** An active `extend_set` row in the `Default` container. */
export function extendSetRow(overrides: Partial<ExtendSetRow> = {}): ExtendSetRow {
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  return {
    tenant_id: tenantFor(siteid),
    extendsetid: cfUuid(),
    subtypeid: cfUuid(),
    categoryid: null,
    siteid,
    name: 'Default',
    orderno: 1,
    isactive: 1,
    container: 'Default',
    ...overrides,
  };
}

/** An optional `TextBox` attribute with the next counter `attributeid`. */
export function extendAttributeRow(overrides: Partial<ExtendAttributeRow> = {}): ExtendAttributeRow {
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  const attributeid = overrides.attributeid ?? next('attributeid');
  return {
    tenant_id: tenantFor(siteid),
    attributeid,
    extendsetid: cfUuid(),
    siteid,
    name: `attribute${attributeid}`,
    label: `Attribute ${attributeid}`,
    hint: null,
    type: 'TextBox',
    orderno: 1,
    isactive: 1,
    required: 'false',
    validation: null,
    regex: null,
    message: null,
    defaultvalue: null,
    optionlist: null,
    optionlabellist: null,
    adminonly: 0,
    ...overrides,
  };
}

/** An `extend_data_user_activity` row; `stringvalue` is the left 255 characters of `attributevalue`, as saveExtendedData stores it. */
export function extendDataRow(overrides: Partial<ExtendDataRow> = {}): ExtendDataRow {
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  const attributevalue = overrides.attributevalue === undefined ? 'Value' : overrides.attributevalue;
  return {
    tenant_id: tenantFor(siteid),
    dataid: overrides.dataid ?? next('dataid'),
    baseid: cfUuid(),
    attributeid: overrides.attributeid ?? next('attributeid'),
    siteid,
    attributevalue,
    remoteid: null,
    datetimevalue: null,
    numericvalue: null,
    stringvalue: (attributevalue ?? '').slice(0, STRINGVALUE_WIDTH),
    ...overrides,
  };
}

/** A `person_archive` row effective from `ARCHIVE_EFFECTIVE_FROM`, archived at business noon. */
export function personArchiveRow(overrides: Partial<PersonArchiveRow> = {}): PersonArchiveRow {
  const siteid = overrides.siteid ?? TENANT_A.siteId;
  return {
    tenant_id: tenantFor(siteid),
    archive_id: cfUuid(),
    person_id: cfUuid(),
    siteid,
    effective_from: localDay(ARCHIVE_EFFECTIVE_FROM),
    archived_at: businessNoon(),
    archived_by_id: null,
    archived_by: null,
    ...overrides,
  };
}

/** A `roster_operation` row of an admin update in state `started`. */
export function rosterOperationRow(overrides: Partial<RosterOperationRow> = {}): RosterOperationRow {
  return {
    tenant_id: TENANT_A.tenantId,
    operation_id: cfUuid(),
    kind: 'admin-update',
    user_id: cfUuid(),
    payload: '{}',
    before_image: null,
    identity_xid: null,
    state: 'started',
    error: null,
    started_at: businessNoon(),
    updated_at: businessNoon(),
    identity_unreachable_since: null,
    ...overrides,
  };
}

/** A `group_name` projection row of a private-pool group at aggregate version 1. */
export function groupNameRow(overrides: Partial<GroupNameRow> = {}): GroupNameRow {
  const siteId = overrides.site_id ?? TENANT_A.siteId;
  return {
    tenant_id: tenantFor(siteId),
    group_id: cfUuid(),
    site_id: siteId,
    group_name: 'Test Group',
    is_public: 0,
    deleted: false,
    aggregate_version: '1',
    ...overrides,
  };
}

/** One tenant's rows; `seedPeople` writes them in the field order of `SEED_TABLES`. */
export interface TenantPeopleSeed {
  readonly persons?: readonly PersonRow[];
  readonly addresses?: readonly AddressRow[];
  readonly interests?: readonly InterestRow[];
  readonly tags?: readonly TagRow[];
  readonly favorites?: readonly FavoriteRow[];
  readonly extendSubtypes?: readonly ExtendSubtypeRow[];
  readonly extendSets?: readonly ExtendSetRow[];
  readonly extendAttributes?: readonly ExtendAttributeRow[];
  readonly extendData?: readonly ExtendDataRow[];
  readonly archives?: readonly PersonArchiveRow[];
  readonly groupNames?: readonly GroupNameRow[];
}

/** People rows keyed by tenant id. */
export type PeopleSeed = Readonly<Record<string, TenantPeopleSeed>>;

// Fixed datasets are built once per process, so their ids stay stable across every suite of a run.

/** The installed super-user `admin` of site `default`. */
export const S2_USER: PersonRow = Object.freeze(
  personRow({ siteid: DEFAULT_SITE.siteId, fname: 'Admin', lname: 'User', email: 'admin@example.com', lastupdateby: 'Admin User' }),
);

/** The installed `qa_editor` system user of site `default`. */
export const EDITOR_USER: PersonRow = Object.freeze(
  personRow({ siteid: DEFAULT_SITE.siteId, fname: 'QA', lname: 'Editor', email: 'qa_editor@default.opt2.test' }),
);

/** tenant-a's site administrator, in its own private pool. */
export const SITE_ADMIN_A_PERSON: PersonRow = Object.freeze(
  personRow({ siteid: TENANT_A.siteId, fname: 'Sasha', lname: 'Admin', email: 'site_admin_a@tenant-a.opt2.test', jobtitle: 'Site Administrator' }),
);

/** A tenant-a system user holding the Users and core module grants. */
export const MODULE_USER_A_PERSON: PersonRow = Object.freeze(
  personRow({ siteid: TENANT_A.siteId, fname: 'Morgan', lname: 'Module', email: 'module_user_a@tenant-a.opt2.test' }),
);

/** A tenant-a system user holding only the Users module grant. */
export const MODULE_008_ONLY_PERSON: PersonRow = Object.freeze(
  personRow({ siteid: TENANT_A.siteId, fname: 'Max', lname: 'Usersonly', email: 'module_008_only@tenant-a.opt2.test' }),
);

/** A tenant-a system user with addresses, interests, tags, a favorite and extended data. */
export const SYSTEM_USER_A_PERSON: PersonRow = Object.freeze(
  personRow({
    siteid: TENANT_A.siteId,
    fname: 'Sydney',
    lname: 'System',
    email: 'system_user_a@tenant-a.opt2.test',
    company: 'OPT-2 Test Company',
    jobtitle: 'Analyst',
    mobilephone: '555-0100',
    website: 'https://tenant-a.opt2.test',
    subscribe: 1,
    tags: 'alpha,beta',
  }),
);

/** tenant-a users whose values exercise the legacy CSV writer: a comma, trailing spaces, embedded quotes and no email. */
export const CSV_QUIRK_PERSONS: readonly PersonRow[] = Object.freeze([
  Object.freeze(personRow({ siteid: TENANT_A.siteId, fname: 'Casey', lname: 'Comma', email: 'csv_comma@tenant-a.opt2.test', company: 'Acme, Inc.' })),
  Object.freeze(personRow({ siteid: TENANT_A.siteId, fname: 'Taylor  ', lname: 'Spaces   ', email: 'csv_spaces@tenant-a.opt2.test' })),
  Object.freeze(
    personRow({ siteid: TENANT_A.siteId, fname: 'Quinn', lname: 'Quote', email: 'csv_quote@tenant-a.opt2.test', company: 'The "Quoted" Company' }),
  ),
  // Legacy stores an empty email as NULL.
  Object.freeze(personRow({ siteid: TENANT_A.siteId, fname: 'Emery', lname: 'Noemail', email: null })),
]);

/** Every person stored in tenant-a: its private user pool. */
export const TENANT_A_SYSTEM_USERS: readonly PersonRow[] = Object.freeze([
  SITE_ADMIN_A_PERSON,
  MODULE_USER_A_PERSON,
  MODULE_008_ONLY_PERSON,
  SYSTEM_USER_A_PERSON,
  ...CSV_QUIRK_PERSONS,
]);

/** A public member of tenant-a, stored in its public user pool `umbrella`. */
export const POOLED_MEMBER_PERSON: PersonRow = Object.freeze(
  personRow({ siteid: TENANT_UMBRELLA.siteId, fname: 'Pat', lname: 'Pooled', email: 'pooled_member@umbrella.opt2.test' }),
);

/** The pooled person the seam-1 archive scenarios archive; never archived by the seed. */
export const ARCHIVE_PERSON: PersonRow = Object.freeze(
  personRow({ siteid: TENANT_UMBRELLA.siteId, fname: 'Alex', lname: 'Archive', email: 'archive_person@umbrella.opt2.test' }),
);

/** Every person stored in umbrella: tenant-a's public members. */
export const TENANT_A_PUBLIC_MEMBERS: readonly PersonRow[] = Object.freeze([
  POOLED_MEMBER_PERSON,
  Object.freeze(personRow({ siteid: TENANT_UMBRELLA.siteId, fname: 'Robin', lname: 'Member', email: 'robin_member@umbrella.opt2.test' })),
  ARCHIVE_PERSON,
]);

/** tenant-b's site administrator. */
export const OTHER_TENANT_PERSON: PersonRow = Object.freeze(
  personRow({ siteid: TENANT_B.siteId, fname: 'Blake', lname: 'Admin', email: 'site_admin_b@tenant-b.opt2.test' }),
);

/** A tenant-b system user archived before the business date. */
export const ARCHIVED_PERSON_B: PersonRow = Object.freeze(
  personRow({ siteid: TENANT_B.siteId, fname: 'Casey', lname: 'Former', email: 'former_b@tenant-b.opt2.test' }),
);

/** tenant-b's system users. */
export const TENANT_B_USERS: readonly PersonRow[] = Object.freeze([
  OTHER_TENANT_PERSON,
  Object.freeze(personRow({ siteid: TENANT_B.siteId, fname: 'Bailey', lname: 'Builder', email: 'bailey_b@tenant-b.opt2.test' })),
  ARCHIVED_PERSON_B,
]);

/** A public member of tenant-b, which owns its public user pool. */
export const MEMBER_B_PERSON: PersonRow = Object.freeze(
  personRow({ siteid: TENANT_B.siteId, fname: 'Jordan', lname: 'Member', email: 'member_b@tenant-b.opt2.test', tags: 'gamma' }),
);

/** tenant-b's public members. */
export const TENANT_B_MEMBERS: readonly PersonRow[] = Object.freeze([MEMBER_B_PERSON]);

/** The archive record of `ARCHIVED_PERSON_B`, effective a month before the business date. */
export const TENANT_B_ARCHIVE: PersonArchiveRow = Object.freeze(
  personArchiveRow({
    person_id: ARCHIVED_PERSON_B.userid,
    siteid: TENANT_B.siteId,
    effective_from: localDay(addDays(BUSINESS_DATE, -29)),
    archived_by_id: OTHER_TENANT_PERSON.userid,
    archived_by: 'Blake Admin',
  }),
);

/** The owner columns of a child row of `person`. */
function ownedBy(person: PersonRow): { tenant_id: string; userid: string; siteid: string | null } {
  return { tenant_id: person.tenant_id, userid: person.userid, siteid: person.siteid };
}

/** Addresses: two for `SYSTEM_USER_A_PERSON` and one for each other owner, exactly one primary per user. */
const ADDRESSES: readonly AddressRow[] = Object.freeze([
  Object.freeze(addressRow({ ...ownedBy(SYSTEM_USER_A_PERSON), addressname: 'Home', isprimary: 1, phone: '555-0101' })),
  Object.freeze(
    addressRow({ ...ownedBy(SYSTEM_USER_A_PERSON), addressname: 'Work', address1: '200 Office Park', city: 'Chicago', zip: '60601' }),
  ),
  Object.freeze(addressRow({ ...ownedBy(SITE_ADMIN_A_PERSON), addressname: 'Office', isprimary: 1 })),
  Object.freeze(addressRow({ ...ownedBy(POOLED_MEMBER_PERSON), addressname: 'Home', isprimary: 1, city: 'Riverside' })),
  Object.freeze(addressRow({ ...ownedBy(MEMBER_B_PERSON), addressname: 'Home', isprimary: 1, city: 'Lakeside', state: 'WI', zip: '53001' })),
]);

/** Interests: two categories for `SYSTEM_USER_A_PERSON`, one for each other owner. */
const INTERESTS: readonly InterestRow[] = Object.freeze(
  [SYSTEM_USER_A_PERSON, SYSTEM_USER_A_PERSON, POOLED_MEMBER_PERSON, MEMBER_B_PERSON].map((person) =>
    Object.freeze(interestRow({ tenant_id: person.tenant_id, userid: person.userid })),
  ),
);

/** One `user_tag` row per item of each person's `tags` list. */
const TAGS: readonly TagRow[] = Object.freeze(
  [SYSTEM_USER_A_PERSON, MEMBER_B_PERSON].flatMap((person) =>
    (person.tags ?? '').split(',').map((tag) => Object.freeze(tagRow({ ...ownedBy(person), tag }))),
  ),
);

const FAVORITES: readonly FavoriteRow[] = Object.freeze([
  Object.freeze(favoriteRow({ ...ownedBy(SYSTEM_USER_A_PERSON), favoritename: 'Team Page' })),
]);

const USER_SUBTYPE: ExtendSubtypeRow = Object.freeze(extendSubtypeRow({ siteid: TENANT_A.siteId }));
const USER_SET: ExtendSetRow = Object.freeze(extendSetRow({ siteid: TENANT_A.siteId, subtypeid: USER_SUBTYPE.subtypeid, name: 'Employment' }));
const USER_ATTRIBUTES = Object.freeze({
  required: Object.freeze(
    extendAttributeRow({
      extendsetid: USER_SET.extendsetid,
      siteid: TENANT_A.siteId,
      name: 'employeeNumber',
      label: 'Employee Number',
      orderno: 1,
      required: 'true',
      message: 'Employee Number is required.',
    }),
  ),
  regex: Object.freeze(
    extendAttributeRow({
      extendsetid: USER_SET.extendsetid,
      siteid: TENANT_A.siteId,
      name: 'badgeCode',
      label: 'Badge Code',
      orderno: 2,
      validation: 'Regex',
      regex: '^[A-Z]{2}[0-9]{4}$',
      message: 'Badge Code must be two capital letters followed by four digits.',
    }),
  ),
  // A File-attribute save reaches strategies-content's file store, so people withholds it.
  photo: Object.freeze(
    extendAttributeRow({ extendsetid: USER_SET.extendsetid, siteid: TENANT_A.siteId, name: 'badgePhoto', label: 'Badge Photo', orderno: 3, type: 'File' }),
  ),
});

const USER_EXTENSION_DATA: readonly ExtendDataRow[] = Object.freeze(
  (
    [
      [USER_ATTRIBUTES.required, 'E1001'],
      [USER_ATTRIBUTES.regex, 'AB1234'],
    ] as const
  ).map(([attribute, value]) =>
    Object.freeze(
      extendDataRow({ siteid: TENANT_A.siteId, baseid: SYSTEM_USER_A_PERSON.userid, attributeid: attribute.attributeid, attributevalue: value }),
    ),
  ),
);

/** tenant-a's `User`/`Default` extension: one set with a required, a regex-validated and a File attribute, and one user's values. */
export const USER_EXTENSION = Object.freeze({
  subtype: USER_SUBTYPE,
  set: USER_SET,
  attributes: USER_ATTRIBUTES,
  /** The user whose values `extendData` holds. */
  userId: SYSTEM_USER_A_PERSON.userid,
  extendData: USER_EXTENSION_DATA,
});

/** Group-name projections of each site's `Admin` group and umbrella's public `Members` group. */
const GROUP_NAMES: readonly GroupNameRow[] = Object.freeze(
  (
    [
      [TENANT_A.siteId, 'Admin', 0],
      [TENANT_UMBRELLA.siteId, 'Members', 1],
      [TENANT_B.siteId, 'Admin', 0],
      [DEFAULT_SITE.siteId, 'Admin', 0],
    ] as const
  ).map(([siteId, name, isPublic]) => Object.freeze(groupNameRow({ site_id: siteId, group_name: name, is_public: isPublic }))),
);

/** The rows of `rows` stored under `tenantId`. */
function inTenant<R extends { tenant_id: string }>(rows: readonly R[], tenantId: string): readonly R[] {
  return Object.freeze(rows.filter((row) => row.tenant_id === tenantId));
}

/** The fixed tenant's seed: its persons and every dataset row stored under it. */
function tenantSeed(tenantId: string, persons: readonly PersonRow[]): TenantPeopleSeed {
  return Object.freeze({
    persons,
    addresses: inTenant(ADDRESSES, tenantId),
    interests: inTenant(INTERESTS, tenantId),
    tags: inTenant(TAGS, tenantId),
    favorites: inTenant(FAVORITES, tenantId),
    extendSubtypes: inTenant([USER_EXTENSION.subtype], tenantId),
    extendSets: inTenant([USER_EXTENSION.set], tenantId),
    extendAttributes: inTenant(Object.values(USER_EXTENSION.attributes), tenantId),
    extendData: inTenant(USER_EXTENSION.extendData, tenantId),
    archives: inTenant([TENANT_B_ARCHIVE], tenantId),
    groupNames: inTenant(GROUP_NAMES, tenantId),
  });
}

/** Every fixed dataset, keyed by the tenant that stores it: tenant-a, umbrella, tenant-b and `default`. */
export const DEFAULT_PEOPLE_SEED: PeopleSeed = Object.freeze({
  [TENANT_A.tenantId]: tenantSeed(TENANT_A.tenantId, TENANT_A_SYSTEM_USERS),
  [TENANT_UMBRELLA.tenantId]: tenantSeed(TENANT_UMBRELLA.tenantId, TENANT_A_PUBLIC_MEMBERS),
  [TENANT_B.tenantId]: tenantSeed(TENANT_B.tenantId, Object.freeze([...TENANT_B_USERS, ...TENANT_B_MEMBERS])),
  [DEFAULT_SITE.tenantId]: tenantSeed(DEFAULT_SITE.tenantId, Object.freeze([S2_USER, EDITOR_USER])),
});

floors = { ...counters, person: 0 };
resetFixtureCounters();

const PUBLIC_MEMBER_IDS: ReadonlySet<string> = new Set([...TENANT_A_PUBLIC_MEMBERS, ...TENANT_B_MEMBERS].map((person) => person.userid));
const S2_USER_IDS: ReadonlySet<string> = new Set([S2_USER.userid]);

/** The username of `person`: its email's local part, else `user_` and the first block of its id. */
function usernameOf(person: Pick<PersonRow, 'userid' | 'email'>): string {
  const local = person.email?.split('@')[0] ?? '';
  return local !== '' ? local : `user_${person.userid.slice(0, 8).toLowerCase()}`;
}

/**
 * The active Type=2 account identity holds for `person`: `isPublic` 1 for the fixed public members, else 0,
 * and `s2` 1 only for `S2_USER`, the installed super-user.
 */
export function accountFor(person: Pick<PersonRow, 'userid' | 'siteid' | 'email'>, overrides: Partial<AccountView> = {}): AccountView {
  return {
    userId: person.userid,
    siteId: person.siteid ?? '',
    username: usernameOf(person),
    s2: S2_USER_IDS.has(person.userid) ? 1 : 0,
    isPublic: PUBLIC_MEMBER_IDS.has(person.userid) ? 1 : 0,
    inactive: 0,
    type: 2,
    perm: 0,
    admin: null,
    remoteId: null,
    lastLogin: null,
    passwordCreated: null,
    tablist: null,
    ...overrides,
  };
}

/** The accounts of every person in `seed`, for `IdentityDouble.seedAccounts`. */
export function accountsForSeed(seed: PeopleSeed): AccountView[] {
  return Object.values(seed).flatMap((tenant) => (tenant.persons ?? []).map((person) => accountFor(person)));
}

/** The claims of a user token a people suite presents. */
export interface TestActor {
  sub: string;
  site: string;
  roles: string[];
  s2: boolean;
}

const USERS_MODULE = moduleRole('00000000000000000000000000000000008');
const CORE_MODULE = moduleRole('00000000000000000000000000000000000');

function actor(person: PersonRow, site: string, roles: string[], s2 = false): TestActor {
  return Object.freeze({ sub: person.userid, site, roles, s2 });
}

/** The installed super-user on site `default`. */
export const ADMIN_S2: TestActor = actor(S2_USER, DEFAULT_SITE.siteId, [Roles.systemUser, Roles.s2], true);
/** A member of tenant-a's private-pool `Admin` group. */
export const SITE_ADMIN_A: TestActor = actor(SITE_ADMIN_A_PERSON, TENANT_A.siteId, [Roles.systemUser, Roles.siteAdmin]);
/** A tenant-a user with the Users and core module grants, which the `cusers` gate accepts together. */
export const MODULE_USER_A: TestActor = actor(MODULE_USER_A_PERSON, TENANT_A.siteId, [Roles.systemUser, USERS_MODULE, CORE_MODULE]);
/** A tenant-a user with the Users module grant alone, which the `cusers` gate refuses. */
export const MODULE_008_ONLY: TestActor = actor(MODULE_008_ONLY_PERSON, TENANT_A.siteId, [Roles.systemUser, USERS_MODULE]);
/** A `qa_editor`-style system user on site `default` without user-module access. */
export const EDITOR: TestActor = actor(EDITOR_USER, DEFAULT_SITE.siteId, [Roles.systemUser]);
/** A plain tenant-a system user. */
export const SYSTEM_USER_A: TestActor = actor(SYSTEM_USER_A_PERSON, TENANT_A.siteId, [Roles.systemUser]);
/** A tenant-a public member whose row lives in `umbrella`. */
export const MEMBER_POOLED: TestActor = actor(POOLED_MEMBER_PERSON, TENANT_A.siteId, [Roles.member]);
/** A tenant-b public member. */
export const MEMBER_B: TestActor = actor(MEMBER_B_PERSON, TENANT_B.siteId, [Roles.member]);
/** tenant-b's site administrator, foreign to every tenant-a resource. */
export const OTHER_TENANT: TestActor = actor(OTHER_TENANT_PERSON, TENANT_B.siteId, [Roles.systemUser, Roles.siteAdmin]);

/** Every actor above. */
export const ALL_ACTORS: readonly TestActor[] = Object.freeze([
  ADMIN_S2,
  SITE_ADMIN_A,
  MODULE_USER_A,
  MODULE_008_ONLY,
  EDITOR,
  SYSTEM_USER_A,
  MEMBER_POOLED,
  MEMBER_B,
  OTHER_TENANT,
]);

/** The table each seed field is written to, in write order: extension definitions before the rows that reference them. */
const SEED_TABLES = {
  extendSubtypes: EXTEND_SUBTYPE.table,
  extendSets: EXTEND_SET.table,
  extendAttributes: EXTEND_ATTRIBUTE.table,
  persons: PERSON.table,
  addresses: ADDRESS.table,
  interests: INTEREST.table,
  tags: TAG.table,
  favorites: FAVORITE.table,
  extendData: EXTEND_DATA.table,
  archives: PERSON_ARCHIVE.table,
  groupNames: GROUP_NAME.table,
} as const satisfies Record<keyof TenantPeopleSeed, PeopleTableName>;

const SEED_CONTEXT: WriteContext = Object.freeze({ origin: 'backfill', actorService: 'people-test-seed' });

/** Options of `seedPeople`; `clock` stamps the changelog rows and defaults to business noon. */
export interface SeedPeopleOptions {
  clock?: Clock;
}

/**
 * Writes `seed` through the people repository, one tenant transaction per tenant, and returns it; the people unit gates
 * must be open. Each row is stored exactly as given, with one changelog row.
 */
export async function seedPeople(db: TenantDb, seed: PeopleSeed, opts: SeedPeopleOptions = {}): Promise<PeopleSeed> {
  const repo = createPeopleRepository({ clock: opts.clock ?? businessClock(), schema: db.schema });
  const fields = Object.keys(SEED_TABLES) as (keyof typeof SEED_TABLES)[];
  for (const [tenantId, rows] of Object.entries(seed)) {
    await withTenant(db, tenantId, async (tx) => {
      // Rows go through the gated, audited platform insert as a backfill stores them: the typed save helpers would stamp
      // timestamps and reissue tag and extended-data ids from their sequences, so the stored rows would differ from the seed.
      for (const field of fields) {
        for (const row of rows[field] ?? []) {
          await repo.insert(tx, SEED_TABLES[field], row, SEED_CONTEXT);
        }
      }
    });
  }
  return seed;
}
