/** People JSON API `user` and `address` value sets against Masa userDAO.read/readAddress, getFilteredValues and the save return struct. */
import { describe, expect, it } from 'vitest';
import { cfToNumber, legacyQuery } from '@opt2/platform/legacy-compat';
import { fixedClock } from '@opt2/platform/service-kit';
import { USER_BEAN_DEFAULTS } from '../../src/domain/person.js';
import {
  ADDRESS_BEAN_DEFAULTS,
  ADDRESS_EXCLUDED_KEYS,
  USER_EXCLUDED_KEYS,
  addressBeanValues,
  expansionTargets,
  filteredEntityValues,
  overlayRequestValues,
  saveResponse,
  userBeanValues,
  type EntityExtendData,
  type FilteredValuesOptions,
  type SaveOutcome,
  type UserEntitySource,
} from '../../src/domain/user-entity.js';
import type { AccountView } from '../../src/legacy/identity-client.js';
import type { AddressRow, PersonRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const TENANT_ID = '6f1c2b0e-3d4a-4c5b-9e8f-0a1b2c3d4e5f';
const USER_ID = 'B7D1A2C3-1E2F-4A5B-8C9D0E1F2A3B4C5D';
const ADMIN_ID = 'C8E2B3D4-2F3A-4B5C-9D0E1F2A3B4C5D6E';
const ADDRESS_ID = 'D9F3C4E5-3A4B-4C5D-0E1F2A3B4C5D6E7F';
const GROUP_A = 'E0A4D5F6-4B5C-4D6E-1F2A3B4C5D6E7F80';
const GROUP_B = 'F1B5E6A7-5C6D-4E7F-2A3B4C5D6E7F8091';
const CATEGORY_A = 'A2C6F7B8-6D7E-4F80-3B4C5D6E7F8091A2';
const LAST_UPDATE = new Date(2026, 4, 1, 9, 30, 0, 0);
const CREATED = new Date(2026, 0, 15, 8, 0, 0, 0);
const NO_EXTEND: EntityExtendData = { data: {}, extendSetId: '' };
const USER_LINKS = Object.freeze({ self: `http://localhost/index.cfm/_api/json/v1/default/user/${USER_ID}` });
const ADDRESS_LINKS = Object.freeze({ self: `http://localhost/index.cfm/_api/json/v1/default/address/${ADDRESS_ID}` });

// Keys of a stored user's findOne without fields, as the legacy oracle returns them.
const USER_RESPONSE_KEYS = [
  'addressid', 'categoryid', 'company', 'contactform', 'created', 'description', 'email', 'entityname', 'fname', 'groupid',
  'groupname', 'id', 'imname', 'imservice', 'inactive', 'interests', 'isnew', 'ispublic', 'jobtitle', 'keepprivate',
  'lastlogin', 'lastupdate', 'lastupdateby', 'lastupdatebyid', 'links', 'lname', 'mobilephone', 'newfile', 'notes',
  'passwordcreated', 'perm', 'photofileext', 'photofileid', 'primaryaddressid', 'remoteid', 's2', 'siteid', 'subscribe',
  'subtype', 'tablist', 'tags', 'type', 'userid', 'username', 'website',
];
// Keys of a stored address's findOne without fields, as the legacy oracle returns them.
const ADDRESS_RESPONSE_KEYS = [
  'address1', 'address2', 'addressemail', 'addressid', 'addressname', 'addressnotes', 'addressurl', 'city', 'country',
  'entityname', 'extendsetid', 'fax', 'hours', 'id', 'isnew', 'isprimary', 'latitude', 'links', 'longitude', 'phone',
  'siteid', 'state', 'subtype', 'type', 'userid', 'zip',
];
const USER_NUMERIC_KEYS = ['type', 's2', 'perm', 'inactive', 'ispublic', 'subscribe', 'keepprivate'];
const ADDRESS_NUMERIC_KEYS = ['isprimary', 'longitude', 'latitude'];

function personRow(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    tenant_id: TENANT_ID,
    userid: USER_ID,
    groupname: null,
    fname: '  Ada ',
    lname: 'Lovelace',
    email: 'ada@example.com',
    company: 'Analytical Engines',
    jobtitle: 'Analyst',
    mobilephone: null,
    website: 'https://example.com/ada',
    subtype: 'Default',
    ext: null,
    contactform: null,
    lastupdate: LAST_UPDATE,
    lastupdateby: 'Admin User',
    lastupdatebyid: ADMIN_ID,
    siteid: 'default',
    subscribe: 0,
    notes: null,
    description: 'Mathematician',
    interests: null,
    keepprivate: 1,
    photofileid: null,
    imname: null,
    imservice: null,
    created: CREATED,
    tags: 'math,engines',
    row_version: '3',
    ...overrides,
  };
}

function accountView(overrides: Partial<AccountView> = {}): AccountView {
  return {
    userId: USER_ID,
    siteId: 'default',
    username: 'ada',
    s2: 0,
    isPublic: 0,
    inactive: 1,
    type: 2,
    perm: 0,
    admin: 0,
    remoteId: null,
    lastLogin: '2026-06-29T17:45:12.250',
    passwordCreated: '2026-02-01T08:00:00.000',
    tablist: null,
    ...overrides,
  };
}

function userSource(overrides: Partial<UserEntitySource> = {}): UserEntitySource {
  return { person: personRow(), account: accountView(), groupIds: [], categoryIds: [], extend: NO_EXTEND, photoFileExt: '', ...overrides };
}

function addressRow(overrides: Partial<AddressRow> = {}): AddressRow {
  return {
    tenant_id: TENANT_ID,
    addressid: ADDRESS_ID,
    userid: USER_ID,
    siteid: 'default',
    addressname: 'Home',
    address1: ' 12 Crescent Rd ',
    address2: null,
    city: 'London',
    state: null,
    zip: 'NW1',
    country: 'UK',
    phone: '020 7946 0000',
    fax: null,
    isprimary: 1,
    addressnotes: null,
    addressurl: null,
    longitude: -0.1276,
    latitude: 51.5072,
    addressemail: 'ada@example.com',
    hours: null,
    ...overrides,
  };
}

function userOptions(overrides: Partial<FilteredValuesOptions> = {}): FilteredValuesOptions {
  return { entityName: 'user', pk: 'userid', links: USER_LINKS, isEntityNameMatch: false, ...overrides };
}

function addressOptions(overrides: Partial<FilteredValuesOptions> = {}): FilteredValuesOptions {
  return { entityName: 'address', pk: 'addressid', links: ADDRESS_LINKS, isEntityNameMatch: false, ...overrides };
}

function withoutKeys(values: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key)));
}

/** The CFML numerics of `keys`, whether the bean holds them as numbers or numeric text. */
function numerics(values: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, cfToNumber(values[key])]));
}

function sortedKeys(values: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(values).sort();
}

describe('userBeanValues (userDAO.read, setUserBeanMetaData, getAllValues)', () => {
  it('sets the read columns over the userBean.init defaults, then the membership and interest ids, and marks the bean stored', () => {
    const values = userBeanValues(userSource({ groupIds: [GROUP_A, GROUP_B], categoryIds: [CATEGORY_A], photoFileExt: 'png' }), CLOCK);

    expect(withoutKeys(values, USER_NUMERIC_KEYS)).toStrictEqual(
      withoutKeys(
        {
          ...USER_BEAN_DEFAULTS,
          userid: USER_ID,
          groupname: '',
          fname: 'Ada',
          lname: 'Lovelace',
          username: 'ada',
          passwordcreated: new Date(2026, 1, 1, 8, 0, 0, 0),
          email: 'ada@example.com',
          company: 'Analytical Engines',
          jobtitle: 'Analyst',
          mobilephone: '',
          website: 'https://example.com/ada',
          subtype: 'Default',
          contactform: '',
          lastlogin: new Date(2026, 5, 29, 17, 45, 12, 250),
          lastupdate: LAST_UPDATE,
          lastupdateby: 'Admin User',
          lastupdatebyid: ADMIN_ID,
          siteid: 'default',
          notes: '',
          description: 'Mathematician',
          interests: '',
          photofileid: '',
          imname: '',
          imservice: '',
          created: CREATED,
          remoteid: '',
          tags: 'math,engines',
          tablist: '',
          photofileext: 'png',
          groupid: `${GROUP_A},${GROUP_B}`,
          categoryid: CATEGORY_A,
          isnew: 0,
        },
        USER_NUMERIC_KEYS,
      ),
    );
    expect(numerics(values, USER_NUMERIC_KEYS)).toStrictEqual({ type: 2, s2: 0, perm: 0, inactive: 1, ispublic: 0, subscribe: 0, keepprivate: 1 });
  });

  it('reads NULL columns as empty text and keeps the init value wherever the setter ignores it', () => {
    const values = userBeanValues(
      userSource({
        person: personRow({ email: null, lastupdate: null, created: null }),
        account: accountView({ username: null, lastLogin: null, passwordCreated: null }),
      }),
      CLOCK,
    );

    expect(values).toMatchObject({
      email: '',
      username: '',
      lastlogin: '',
      passwordcreated: NOW,
      lastupdate: '',
      created: '',
      photofileext: '',
      groupid: '',
      categoryid: '',
    });
  });

  it('rejects an account timestamp that is not an identity LocalTimestamp', () => {
    expect(() => userBeanValues(userSource({ account: accountView({ lastLogin: '2026-06-29 17:45:12' }) }), CLOCK)).toThrow(
      '2026-06-29 17:45:12 is not an identity LocalTimestamp',
    );
  });

  it('appends extended data without overwriting a bean key in any case and merges set ids with case-sensitive listFind', () => {
    const anniversary = new Date(2020, 0, 2, 0, 0, 0, 0);
    const values = userBeanValues(
      userSource({ extend: { data: { favoriteColor: 'teal', FNAME: 'Shadow', anniversary }, extendSetId: 'SET-1,,SET-2,SET-1,set-1' } }),
      CLOCK,
    );

    expect(values).toMatchObject({ favoriteColor: 'teal', anniversary, fname: 'Ada', extendsetid: 'SET-1,SET-2,set-1' });
    expect(Object.hasOwn(values, 'FNAME')).toBe(false);
  });

  it('keeps an extended attribute named __proto__ as a data key', () => {
    const data = JSON.parse('{"__proto__":"shadow"}') as EntityExtendData['data'];
    const values = userBeanValues(userSource({ extend: { data, extendSetId: '' } }), CLOCK);

    expect(Object.getOwnPropertyDescriptor(values, '__proto__')?.value).toBe('shadow');
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
  });
});

describe('addressBeanValues (userDAO.readAddress, getAllValues)', () => {
  it('holds the addressBean.init values, a stored-or-new address being isnew 0', () => {
    expect(ADDRESS_BEAN_DEFAULTS).toStrictEqual({
      addressid: '',
      userid: '',
      siteid: '',
      isprimary: 0,
      address1: '',
      address2: '',
      fax: '',
      city: '',
      state: '',
      zip: '',
      phone: '',
      country: '',
      addressname: '',
      addressemail: '',
      addressnotes: '',
      addressurl: '',
      hours: '',
      longitude: 0,
      latitude: 0,
      errors: {},
      extenddatatable: 'tclassextenddatauseractivity',
      isnew: 0,
      type: 'Address',
      subtype: 'Default',
      extendsetid: '',
    });
    expect(Object.isFrozen(ADDRESS_BEAN_DEFAULTS)).toBe(true);
  });

  it('sets the select * columns trimmed over the init values, without the target-only tenant_id', () => {
    const values = addressBeanValues({ address: addressRow(), extend: NO_EXTEND });

    expect(withoutKeys(values, ADDRESS_NUMERIC_KEYS)).toStrictEqual(
      withoutKeys(
        {
          ...ADDRESS_BEAN_DEFAULTS,
          addressid: ADDRESS_ID,
          userid: USER_ID,
          siteid: 'default',
          addressname: 'Home',
          address1: '12 Crescent Rd',
          address2: '',
          city: 'London',
          state: '',
          zip: 'NW1',
          country: 'UK',
          phone: '020 7946 0000',
          fax: '',
          addressnotes: '',
          addressurl: '',
          addressemail: 'ada@example.com',
          hours: '',
          errors: {},
        },
        ADDRESS_NUMERIC_KEYS,
      ),
    );
    expect(numerics(values, ADDRESS_NUMERIC_KEYS)).toStrictEqual({ isprimary: 1, longitude: -0.1276, latitude: 51.5072 });
  });

  it('keeps the init 0 where setIsPrimary, setLongitude and setLatitude ignore a NULL, with an errors struct of its own', () => {
    const values = addressBeanValues({ address: addressRow({ isprimary: null, longitude: null, latitude: null }), extend: NO_EXTEND });

    expect(numerics(values, ADDRESS_NUMERIC_KEYS)).toStrictEqual({ isprimary: 0, longitude: 0, latitude: 0 });
    expect(values.errors).not.toBe(ADDRESS_BEAN_DEFAULTS.errors);
    expect(Object.isFrozen(values.errors)).toBe(false);
  });

  it('appends extended data without overwriting an address key and merges its set ids', () => {
    const values = addressBeanValues({ address: addressRow(), extend: { data: { deliveryNotes: 'Side door', City: 'Paris' }, extendSetId: 'SET-9' } });

    expect(values).toMatchObject({ deliveryNotes: 'Side door', city: 'London', extendsetid: 'SET-9' });
    expect(Object.hasOwn(values, 'City')).toBe(false);
  });
});

describe('getFilteredValues excluded keys', () => {
  it('removes the bean keys of every entity, and the user and group keys from users', () => {
    const beanKeys = [
      'addobjects', 'removeobjects', 'sourceiterator', 'frommuracache', 'errors', 'instanceid', 'primarykey', 'extenddatatable',
      'extenddata', 'extendautocomplete', 'saveerrors', 'password',
    ];
    expect([...ADDRESS_EXCLUDED_KEYS].sort()).toStrictEqual([...beanKeys].sort());
    expect([...USER_EXCLUDED_KEYS].sort()).toStrictEqual([...beanKeys, 'ukey', 'hkey', 'passedprotect', 'extendsetid', 'addresses'].sort());
  });
});

describe('filteredEntityValues of a user', () => {
  const stored = userBeanValues(userSource({ extend: { data: { favoriteColor: 'teal' }, extendSetId: 'SET-1' } }), CLOCK);

  it('without fields returns every kept value under lower-cased names, plus id, a links copy, type and entityname', () => {
    const result = filteredEntityValues({ ...stored, password: 'never-shown' }, userOptions());

    expect(sortedKeys(result)).toStrictEqual([...USER_RESPONSE_KEYS, 'favoritecolor'].sort());
    expect(result).toMatchObject({ id: USER_ID, userid: USER_ID, type: 'user', entityname: 'user', isnew: 0, fname: 'Ada', favoritecolor: 'teal' });
    expect(result.links).toStrictEqual(USER_LINKS);
    expect(result.links).not.toBe(USER_LINKS);
  });

  it.each([undefined, '', '*', 'fname,*', 'all'])('treats fields %j as every field', (fields) => {
    expect(sortedKeys(filteredEntityValues(stored, userOptions({ fields })))).toStrictEqual([...USER_RESPONSE_KEYS, 'favoritecolor'].sort());
  });

  it('with fields returns the listed values plus the forced userID, siteid and isnew, never the password', () => {
    const result = filteredEntityValues(stored, userOptions({ fields: 'fname,password,fullname' }));

    expect(result).toStrictEqual({
      fname: 'Ada',
      fullname: 'Ada Lovelace',
      userid: USER_ID,
      siteid: 'default',
      isnew: 0,
      id: USER_ID,
      type: 'user',
      entityname: 'user',
    });
  });

  it.each([
    ['fname,links', USER_LINKS],
    ['fname,LINKS', ''],
  ])('with fields %j adds links only when arrayFind finds "links"', (fields, links) => {
    expect(filteredEntityValues(stored, userOptions({ fields })).links).toStrictEqual(links);
  });

  it.each(['extendeddata', 'ExtendedData'])('expands the %s field into the extended attribute values', (field) => {
    const result = filteredEntityValues(stored, userOptions({ fields: field, extendSetData: { favoriteColor: 'teal', Anniversary: '2020-01-02' } }));

    expect(result).toMatchObject({ favoritecolor: 'teal', anniversary: '2020-01-02' });
    expect(Object.hasOwn(result, 'extendeddata')).toBe(false);
  });

  it('reads the last segment of a dotted field and an unknown property as empty text', () => {
    const result = filteredEntityValues(stored, userOptions({ fields: 'user.fname,nosuchfield' }));

    expect(result).toMatchObject({ 'user.fname': 'Ada', nosuchfield: '' });
  });

  it('prefers a getter result the route supplies', () => {
    const addresses = legacyQuery(['addressid', 'userid'], [{ addressid: ADDRESS_ID, userid: USER_ID }]);
    const result = filteredEntityValues(stored, userOptions({ fields: 'addresses', getters: { addresses } }));

    expect(result.addresses).toBe(addresses);
  });

  it('answers the userBean getters from the bean values', () => {
    const result = filteredEntityValues(stored, userOptions({ fields: 'firstname,lastname,primarykey,extendbaseid,entityname,entitydisplayname' }));

    expect(result).toMatchObject({
      firstname: 'Ada',
      lastname: 'Lovelace',
      primarykey: 'userID',
      extendbaseid: USER_ID,
      entityname: 'user',
      entitydisplayname: 'user',
    });
  });

  it.each([
    [{ type: 2, fname: 'Ada', lname: 'Lovelace' }, 'Ada Lovelace', 'user'],
    [{ type: '2', fname: '', lname: 'Lovelace' }, 'Lovelace', 'user'],
    [{ type: 1, groupname: 'Editors' }, 'Editors', 'group'],
  ])('getFullName and getEntityName of %j', (overrides, fullname, entityName) => {
    const result = filteredEntityValues({ ...stored, ...overrides }, userOptions({ fields: 'fullname,entitydisplayname' }));

    expect(result).toMatchObject({ fullname, entitydisplayname: entityName });
  });

  it('fails as ACF does when getFullName meets a complex name', () => {
    expect(() => filteredEntityValues({ ...stored, fname: { first: 'Ada' } }, userOptions({ fields: 'fullname' }))).toThrow(
      'Complex object types cannot be converted to simple values.',
    );
  });

  it('fails on the displayInterval field, which neither bean defines', () => {
    expect(() => filteredEntityValues(stored, userOptions({ fields: 'displayinterval' }))).toThrow('The user bean has no display interval');
  });

  it.each([
    [2, 'user'],
    [1, 'group'],
    ['1', 'group'],
  ])('reports type %j as %s', (type, expected) => {
    expect(filteredEntityValues({ ...stored, type }, userOptions()).type).toBe(expected);
  });

  it.each([
    [{ expanded: 0 }, true],
    [{ expanded: true }, false],
    [{ expanded: 1 }, false],
    [{ expanded: true, isEntityNameMatch: true }, true],
  ])('with %j applies fields: %s', (opts, appliesFields) => {
    const keys = sortedKeys(filteredEntityValues(stored, userOptions({ fields: 'fname', ...opts })));

    expect(keys).toStrictEqual(
      appliesFields ? ['entityname', 'fname', 'id', 'isnew', 'siteid', 'type', 'userid'] : [...USER_RESPONSE_KEYS, 'favoritecolor'].sort(),
    );
  });
});

describe('filteredEntityValues of an address', () => {
  const stored = addressBeanValues({ address: addressRow(), extend: NO_EXTEND });
  const userExpansion = Object.freeze({ id: USER_ID, entityname: 'user' });
  const siteExpansion = Object.freeze({ id: 'default', entityname: 'site' });

  it('without fields keeps extendsetid and the bean type, and adds id, links and entityname', () => {
    const result = filteredEntityValues(stored, addressOptions());

    expect(sortedKeys(result)).toStrictEqual(ADDRESS_RESPONSE_KEYS);
    expect(result).toMatchObject({ id: ADDRESS_ID, type: 'Address', subtype: 'Default', entityname: 'address', extendsetid: '', isnew: 0 });
    expect(result.links).toStrictEqual(ADDRESS_LINKS);
  });

  it('with fields returns the listed values plus the forced addressID, siteid and isnew', () => {
    const result = filteredEntityValues(stored, addressOptions({ fields: 'city,password' }));

    expect(result).toStrictEqual({ city: 'London', addressid: ADDRESS_ID, siteid: 'default', isnew: 0, id: ADDRESS_ID, entityname: 'address' });
  });

  it('answers the addressBean getters from the bean values', () => {
    const result = filteredEntityValues(stored, addressOptions({ fields: 'primarykey,extendbaseid,entityname,entitydisplayname' }));

    expect(result).toMatchObject({ primarykey: 'addressID', extendbaseid: ADDRESS_ID, entityname: 'address', entitydisplayname: 'address' });
  });

  it('places the expanded user and site under their relation names', () => {
    const result = filteredEntityValues(
      stored,
      addressOptions({ expandLinks: 'all', expansions: { user: userExpansion, site: siteExpansion } }),
    );

    expect(sortedKeys(result)).toStrictEqual([...ADDRESS_RESPONSE_KEYS, 'site', 'user'].sort());
    expect(result.user).toBe(userExpansion);
    expect(result.site).toBe(siteExpansion);
  });

  it.each([undefined, { user: {} }])('fails when expansions %j lack a relation expandEntity follows', (expansions) => {
    expect(() => filteredEntityValues(stored, addressOptions({ expandLinks: 'all', expansions }))).toThrow(/relation of the address was not expanded/);
  });
});

describe('expansionTargets (expandEntity hasOne relations)', () => {
  const address = addressBeanValues({ address: addressRow(), extend: NO_EXTEND });

  it('names the user and site findOne an address expands, at the next depth', () => {
    expect(expansionTargets(address, { entityName: 'address', expandLinks: 'all' })).toStrictEqual([
      { name: 'user', entityName: 'user', id: USER_ID, expanded: 1 },
      { name: 'site', entityName: 'site', id: 'default', expanded: 1 },
    ]);
  });

  it.each([
    ['*', ['user', 'site']],
    ['ALL', ['user', 'site']],
    ['site', ['site']],
    ['User', ['user']],
    ['site,user', ['user', 'site']],
    ['crumbs', []],
    ['', []],
  ])('with expand %j follows %j', (expandLinks, names) => {
    expect(expansionTargets(address, { entityName: 'address', expandLinks }).map((target) => target.name)).toStrictEqual(names);
  });

  it.each([
    [{ expanded: false }, 1],
    [{ expanded: 1 }, undefined],
    [{ expanded: true }, undefined],
    [{ expanded: true, expandDepth: 2 }, 2],
    [{ expanded: 1, expandDepth: 'deep' }, undefined],
    [{ expanded: 2, expandDepth: '3' }, 3],
    [{ expanded: 1, isAggregateQuery: true }, 1],
  ])('with %j expands at depth %j', (opts, depth) => {
    const targets = expansionTargets(address, { entityName: 'address', expandLinks: 'site', ...opts });

    expect(targets.map((target) => target.expanded)).toStrictEqual(depth === undefined ? [] : [depth]);
  });

  it('follows no relation of a user', () => {
    expect(expansionTargets(userBeanValues(userSource(), CLOCK), { entityName: 'user', expandLinks: 'all' })).toStrictEqual([]);
  });
});

describe('saveResponse (the save return struct)', () => {
  it.each<SaveOutcome>([
    { saveErrors: false, errors: {} },
    { saveErrors: '', errors: {} },
    { saveErrors: true, errors: { email: 'Please enter a valid email address.' } },
  ])('copies the filtered values, then saveerrors and errors, from %j', (outcome) => {
    const filtered = Object.freeze({ id: USER_ID, fname: 'Ada', saveerrors: 'read by fields' });

    expect(saveResponse(filtered, outcome)).toStrictEqual({ id: USER_ID, fname: 'Ada', saveerrors: outcome.saveErrors, errors: outcome.errors });
  });
});

describe('overlayRequestValues (posted values re-applied after a failed save)', () => {
  const failed = { saveErrors: false, errors: { email: 'Please enter a valid email address.' } } as const;

  it.each([
    [false, failed.errors, true],
    ['', failed.errors, true],
    ['no', failed.errors, true],
    [true, failed.errors, false],
    ['yes', failed.errors, false],
    [false, {}, false],
    ['', {}, false],
  ])('with saveErrors %j and errors %j overlays: %s', (saveErrors, errors, overlays) => {
    const values = userBeanValues(userSource(), CLOCK);
    const result = overlayRequestValues(values, new Map([['fname', 'Grace']]), { entityName: 'user', saveErrors, errors });

    expect(result.fname).toBe(overlays ? 'Grace' : 'Ada');
    if (!overlays) expect(result).toBe(values);
  });

  it('sets only the keys the re-read user holds, through the userBean setters and under the bean spelling', () => {
    const values = userBeanValues(userSource({ extend: { data: { favoriteColor: 'teal' }, extendSetId: '' } }), CLOCK);
    const input = new Map<string, unknown>([
      ['fname', '  Grace '],
      ['favoritecolor', 'navy'],
      ['lastupdateby', 'x'.repeat(60)],
      ['keepprivate', 'sometimes'],
      ['siteid', 'other-site'],
      ['nosuchkey', 'ignored'],
    ]);
    const result = overlayRequestValues(values, input, { entityName: 'user', ...failed });

    expect(result).toMatchObject({ fname: 'Grace', favoriteColor: 'navy', lastupdateby: 'x'.repeat(50), siteid: 'other-site' });
    expect(cfToNumber(result.keepprivate)).toBe(1);
    expect(Object.hasOwn(result, 'favoritecolor')).toBe(false);
    expect(Object.hasOwn(result, 'nosuchkey')).toBe(false);
    expect(values.fname).toBe('Ada');
  });

  it('sets only the keys the re-read address holds, through the addressBean setters', () => {
    const values = addressBeanValues({ address: addressRow(), extend: NO_EXTEND });
    const input = new Map<string, unknown>([
      ['city', ' Paris '],
      ['isprimary', 'yes'],
      ['longitude', '2.3522'],
      ['latitude', 48.8566],
      ['siteid', 'DEFAULT'],
      ['subtype', 'Office'],
      ['type', ' '],
      ['nosuchkey', 'ignored'],
    ]);
    const result = overlayRequestValues(values, input, { entityName: 'address', ...failed });

    expect(result).toMatchObject({ city: 'Paris', siteid: 'default', subtype: 'Office', type: 'Address' });
    expect(numerics(result, ADDRESS_NUMERIC_KEYS)).toStrictEqual({ isprimary: 1, longitude: 2.3522, latitude: 48.8566 });
    expect(Object.hasOwn(result, 'nosuchkey')).toBe(false);
    expect(values.city).toBe('London');
  });

  it.each([
    ['not a struct', {}],
    [{ city: 'Required' }, { city: 'Required' }],
  ])('setErrors takes a posted errors value %j only as a struct', (posted, expected) => {
    const values = addressBeanValues({ address: addressRow(), extend: NO_EXTEND });

    expect(overlayRequestValues(values, new Map([['errors', posted]]), { entityName: 'address', ...failed }).errors).toStrictEqual(expected);
  });
});
