/** People's JSON API `user` and `address` values, from people rows and identity's account to the legacy wire, against legacy oracle captures. */
import { describe, expect, it } from 'vitest';
import { createApiSerializer, entityPropertyHint, type ApiKeyHint, type ApiSerializerHint } from '@opt2/platform/legacy-compat';
import { TENANT_A, businessClock } from '@opt2/platform/testing';
import { USER_BEAN_DEFAULTS } from '../../src/domain/person.js';
import {
  ADDRESS_EXCLUDED_KEYS,
  USER_EXCLUDED_KEYS,
  addressBeanValues,
  addressesQuery,
  filteredEntityValues,
  overlayRequestValues,
  saveResponse,
  userBeanValues,
  type EntityExtendData,
  type FilteredValuesOptions,
  type UserEntitySource,
} from '../../src/domain/user-entity.js';
import type { AccountView } from '../../src/legacy/identity-client.js';
import type { AddressRow, PersonRow } from '../../src/repo/tables.js';
import { SYSTEM_USER_A_PERSON, USER_EXTENSION, accountFor, addressRow, extendDataRow, interestRow, personRow } from '../helpers/fixtures.js';

const CLOCK = businessClock();
const QA_EDITOR = '3BEC10FC-F5B5-5517-7E7F2072657EFB68';
const ADMIN = '3BE10CC9-9421-80A7-719F9D4816FA78E5';
const EDITOR_GROUP = '3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D';
const PRIMARY_ADDRESS = '3BEC1DE7-EC80-B66C-BD211EE74290A25E';
const INTEREST_CATEGORY = '4C1E9A20-7B3D-4E5F-8A9B0C1D2E3F4A5B';
const ADDRESS_SET = '5D2F0B31-8C4E-4F60-9BAC1D2E3F4A5B6C';
const NO_EXTEND: EntityExtendData = Object.freeze({ data: {}, extendSetId: '' });

// qa_editor's tusers values: Created, LastUpdate and PasswordCreated are the install's; each oracle saw its own LastLogin.
const INSTALLED_AT = '2026-11-13T02:44:29.340';
const SHARED_LAST_LOGIN = '2026-11-13T12:04:14.507';
const OWN_LAST_LOGIN = '2026-11-13T02:44:51.437';
const OWN_SAVED_AT = new Date(2026, 10, 13, 21, 38, 37, 17);

// GET /index.cfm/_api/json/v1/default/{user,address}/<id> bodies of the shared oracle (logged in as admin), verbatim.
const SHARED_USER = `{"apiversion":"v1","data":{"mobilephone":"","lname":"Editor","email":"qa_editor@example.com","contactform":"","lastupdate":"2026-11-13T02:44:29","keepprivate":0,"userid":"${QA_EDITOR}","username":"qa_editor","id":"${QA_EDITOR}","lastupdatebyid":"${ADMIN}","type":"user","subtype":"Default","categoryid":"","fname":"QA","company":"","tablist":"","newfile":"","ispublic":0,"imservice":"","isnew":0,"jobtitle":"","website":"","lastlogin":"2026-11-13T12:04:14","tags":"","s2":0,"links":{"all":"http://localhost:8080/index.cfm/_api/json/v1/default/user","permissions":"http://localhost:8080/index.cfm/_api/json/v1/default/user/${QA_EDITOR}/permissions","properties":"http://localhost:8080/index.cfm/_api/json/v1/default/user/properties","edit":"http://localhost:8080/admin/?muraAction=cusers.edituser&siteid=default&userid=${QA_EDITOR}","self":"http://localhost:8080/index.cfm/_api/json/v1/default/user/${QA_EDITOR}","entities":"http://localhost:8080/index.cfm/_api/json/v1/default"},"notes":"","created":"2026-11-13T02:44:29","groupname":"","perm":0,"description":"","addressid":"","imname":"","passwordcreated":"2026-11-13T02:44:29","photofileid":"","interests":"","siteid":"default","primaryaddressid":"","subscribe":1,"remoteid":"","groupid":"${EDITOR_GROUP}","inactive":0,"photofileext":"","lastupdateby":"Admin User","entityname":"user"},"method":"findOne"}`;
const SHARED_USER_FNAME_LNAME = `{"apiversion":"v1","data":{"lname":"Editor","userid":"${QA_EDITOR}","id":"${QA_EDITOR}","siteid":"default","isnew":0,"type":"user","entityname":"user","fname":"QA"},"method":"findOne"}`;
const SHARED_USER_ADDRESSES = `{"apiversion":"v1","data":{"userid":"${QA_EDITOR}","addresses":[{"address1":"","address2":"","addressemail":"","addressid":"${PRIMARY_ADDRESS}","addressname":"Primary","addressnotes":"","addressurl":"","city":"","country":"","fax":"","hours":"","isprimary":1,"latitude":0,"longitude":0,"phone":"","siteid":"default","state":"","userid":"${QA_EDITOR}","zip":""}],"id":"${QA_EDITOR}","siteid":"default","isnew":0,"type":"user","entityname":"user"},"method":"findOne"}`;
const SHARED_USER_WITH_PASSWORD_AND_LINKS = `{"apiversion":"v1","data":{"lname":"Editor","links":{"all":"http://localhost:8080/index.cfm/_api/json/v1/default/user","permissions":"http://localhost:8080/index.cfm/_api/json/v1/default/user/${QA_EDITOR}/permissions","properties":"http://localhost:8080/index.cfm/_api/json/v1/default/user/properties","edit":"http://localhost:8080/admin/?muraAction=cusers.edituser&siteid=default&userid=${QA_EDITOR}","self":"http://localhost:8080/index.cfm/_api/json/v1/default/user/${QA_EDITOR}","entities":"http://localhost:8080/index.cfm/_api/json/v1/default"},"userid":"${QA_EDITOR}","id":"${QA_EDITOR}","siteid":"default","isnew":0,"type":"user","entityname":"user","fname":"QA"},"method":"findOne"}`;
const SHARED_ADDRESS = `{"apiversion":"v1","data":{"zip":"","longitude":0,"phone":"","links":{"all":"http://localhost:8080/index.cfm/_api/json/v1/default/address","site":"http://localhost:8080/index.cfm/_api/json/v1/default/site","permissions":"http://localhost:8080/index.cfm/_api/json/v1/default/address/${PRIMARY_ADDRESS}/permissions","properties":"http://localhost:8080/index.cfm/_api/json/v1/default/address/properties","self":"http://localhost:8080/index.cfm/_api/json/v1/default/address/${PRIMARY_ADDRESS}","entities":"http://localhost:8080/index.cfm/_api/json/v1/default","user":"http://localhost:8080/index.cfm/_api/json/v1/default/user/${QA_EDITOR}"},"state":"","country":"","addressid":"${PRIMARY_ADDRESS}","userid":"${QA_EDITOR}","addressname":"Primary","addressemail":"","id":"${PRIMARY_ADDRESS}","address1":"","type":"Address","address2":"","subtype":"Default","addressurl":"","extendsetid":"","siteid":"default","city":"","hours":"","isprimary":1,"fax":"","isnew":0,"addressnotes":"","latitude":0,"entityname":"address"},"method":"findOne"}`;
const SHARED_ADDRESS_CITY_PASSWORD = `{"apiversion":"v1","data":{"city":"","addressid":"${PRIMARY_ADDRESS}","id":"${PRIMARY_ADDRESS}","siteid":"default","isnew":0,"entityname":"address"},"method":"findOne"}`;

// The same reads on an own oracle restored from the pristine install, after SQL set the columns its rows below name.
const OWN_USER = `{"apiversion":"v1","data":{"mobilephone":"555-0100","lname":"Editor","email":"qa_editor@example.com","contactform":"0","lastupdate":"2026-11-13T21:38:37","keepprivate":0,"userid":"${QA_EDITOR}","username":"qa_editor","id":"${QA_EDITOR}","lastupdatebyid":"${ADMIN}","type":"user","subtype":"Default","categoryid":"${INTEREST_CATEGORY}","fname":"QA","company":"Acme","tablist":"Basic","newfile":"","ispublic":0,"imservice":"","isnew":0,"jobtitle":"","website":"","lastlogin":"2026-11-13T02:44:51","tags":"alpha,beta","s2":0,"links":{"all":"http://localhost:21480/index.cfm/_api/json/v1/default/user","permissions":"http://localhost:21480/index.cfm/_api/json/v1/default/user/${QA_EDITOR}/permissions","properties":"http://localhost:21480/index.cfm/_api/json/v1/default/user/properties","edit":"http://localhost:21480/admin/?muraAction=cusers.edituser&siteid=default&userid=${QA_EDITOR}","self":"http://localhost:21480/index.cfm/_api/json/v1/default/user/${QA_EDITOR}","entities":"http://localhost:21480/index.cfm/_api/json/v1/default"},"notes":"","created":"2026-11-13T02:44:29","groupname":"","perm":0,"description":"","addressid":"","imname":"","passwordcreated":"2026-11-13T02:44:29","photofileid":"","interests":"","siteid":"default","primaryaddressid":"","subscribe":0,"remoteid":"R-1","groupid":"${EDITOR_GROUP}","inactive":0,"photofileext":"","lastupdateby":"Admin User","entityname":"user"},"method":"findOne"}`;
const OWN_USER_COMPANY_CATEGORY = `{"apiversion":"v1","data":{"categoryid":"${INTEREST_CATEGORY}","userid":"${QA_EDITOR}","id":"${QA_EDITOR}","siteid":"default","isnew":0,"type":"user","entityname":"user","company":"Acme"},"method":"findOne"}`;
const OWN_ADDRESS = `{"apiversion":"v1","data":{"zip":"","longitude":-73.98,"phone":"","links":{"all":"http://localhost:21480/index.cfm/_api/json/v1/default/address","site":"http://localhost:21480/index.cfm/_api/json/v1/default/site","permissions":"http://localhost:21480/index.cfm/_api/json/v1/default/address/${PRIMARY_ADDRESS}/permissions","properties":"http://localhost:21480/index.cfm/_api/json/v1/default/address/properties","self":"http://localhost:21480/index.cfm/_api/json/v1/default/address/${PRIMARY_ADDRESS}","entities":"http://localhost:21480/index.cfm/_api/json/v1/default","user":"http://localhost:21480/index.cfm/_api/json/v1/default/user/${QA_EDITOR}"},"state":"","country":"","addressid":"${PRIMARY_ADDRESS}","userid":"${QA_EDITOR}","addressname":"Primary","addressemail":"","id":"${PRIMARY_ADDRESS}","address1":"12 Main St","type":"Address","address2":"","subtype":"Default","addressurl":"","extendsetid":"","siteid":"default","city":"New York","hours":"","isprimary":1,"fax":"","isnew":0,"addressnotes":"","latitude":40.7128,"entityname":"address"},"method":"findOne"}`;

// POST /index.cfm/_api/json/v1/default/user/<qa_editor> on the own oracle: a duplicate username (403), then a valid save (200).
const OWN_SAVE_FAILED = `{"apiversion":"v1","data":{"mobilephone":"","errors":{"username":"The username 'admin' that you entered is being used by another user."},"lname":"Editor","email":"qa_editor@example.com","contactform":"","lastupdate":"2026-11-13T02:44:29","keepprivate":0,"userid":"${QA_EDITOR}","username":"admin","id":"${QA_EDITOR}","lastupdatebyid":"${ADMIN}","type":"user","subtype":"Default","categoryid":"","fname":"Changed","company":"","tablist":"","newfile":"","ispublic":0,"imservice":"","isnew":0,"jobtitle":"","website":"","lastlogin":"2026-11-13T02:44:51","tags":"","s2":0,"links":{"all":"http://localhost:21480/index.cfm/_api/json/v1/default/user","permissions":"http://localhost:21480/index.cfm/_api/json/v1/default/user/${QA_EDITOR}/permissions","properties":"http://localhost:21480/index.cfm/_api/json/v1/default/user/properties","self":"http://localhost:21480/index.cfm/_api/json/v1/default/user/${QA_EDITOR}","entities":"http://localhost:21480/index.cfm/_api/json/v1/default"},"notes":"","created":"2026-11-13T02:44:29","groupname":"","perm":0,"description":"","addressid":"","imname":"","passwordcreated":"2026-11-13T02:44:29","photofileid":"","saveerrors":"","interests":"","siteid":"default","primaryaddressid":"","subscribe":1,"remoteid":"","groupid":"${EDITOR_GROUP}","inactive":0,"photofileext":"","lastupdateby":"Admin User","entityname":"user"},"method":"save"}`;
const OWN_SAVE_OK = `{"apiversion":"v1","data":{"mobilephone":"","errors":{},"lname":"Editor","email":"qa_editor@example.com","contactform":"","lastupdate":"2026-11-13T21:38:37","keepprivate":0,"userid":"${QA_EDITOR}","username":"qa_editor","id":"${QA_EDITOR}","lastupdatebyid":"${ADMIN}","type":"user","subtype":"Default","categoryid":"","fname":"QA","company":"","tablist":"","newfile":"","ispublic":0,"imservice":"","isnew":0,"jobtitle":"","website":"","lastlogin":"2026-11-13T02:44:51","tags":"","s2":0,"links":{"all":"http://localhost:21480/index.cfm/_api/json/v1/default/user","permissions":"http://localhost:21480/index.cfm/_api/json/v1/default/user/${QA_EDITOR}/permissions","properties":"http://localhost:21480/index.cfm/_api/json/v1/default/user/properties","self":"http://localhost:21480/index.cfm/_api/json/v1/default/user/${QA_EDITOR}","entities":"http://localhost:21480/index.cfm/_api/json/v1/default"},"notes":"","created":"2026-11-13T02:44:29","groupname":"","perm":0,"description":"","addressid":"","imname":"","passwordcreated":"2026-11-13T02:44:29","photofileid":"","saveerrors":"","interests":"","siteid":"default","primaryaddressid":"","subscribe":1,"remoteid":"","groupid":"${EDITOR_GROUP}","inactive":0,"photofileext":"","lastupdateby":"Admin User","entityname":"user"},"method":"save"}`;
const USERNAME_TAKEN = "The username 'admin' that you entered is being used by another user.";

/** userBean and addressBean property types registerEntity hints on the shared serializer (userBean.cfc:78-120, addressBean.cfc:80-101). */
const PROPERTY_TYPES: ReadonlyArray<readonly [key: string, type: 'numeric' | 'date']> = [
  ...['type', 's2', 'perm', 'inactive', 'ispublic', 'subscribe', 'keepprivate', 'isnew'].map((key) => [key, 'numeric'] as const),
  ...['passwordcreated', 'lastlogin', 'lastupdate', 'created'].map((key) => [key, 'date'] as const),
  ...['isprimary', 'longitude', 'latitude'].map((key) => [key, 'numeric'] as const),
];

function hintOf(type: string): ApiSerializerHint {
  const hint = entityPropertyHint(type);
  if (hint === undefined) throw new Error(`registerEntity installs no hint for the ${type} datatype`);
  return hint;
}

const ENTITY_HINTS: readonly ApiKeyHint[] = PROPERTY_TYPES.map(([key, type]) => ({ key, hint: hintOf(type) }));

/** The `data` member of a body the JSON API serializer writes for `data`, parsed. */
function wire(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return (JSON.parse(createApiSerializer(ENTITY_HINTS).serialize({ data })) as { data: Record<string, unknown> }).data;
}

/** The `data` member of a captured legacy body. */
function oracleData(body: string): Record<string, unknown> {
  return (JSON.parse(body) as { data: Record<string, unknown> }).data;
}

/** The `links` member of a captured legacy body; `{}` where the body selected no links. */
function oracleLinks(body: string): Record<string, string> {
  return (oracleData(body).links ?? {}) as Record<string, string>;
}

function sortedKeys(values: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(values).sort();
}

/** Wall-clock text of a LocalTimestamp as the Date the people row holds. */
function localDate(text: string): Date {
  return new Date(text);
}

/** qa_editor as people and identity hold it; each oracle's row differs only where `overrides` names it. */
function qaEditor(
  overrides: { person?: Partial<PersonRow>; account?: Partial<AccountView>; categoryIds?: readonly string[] } = {},
): UserEntitySource {
  const person = personRow({
    userid: QA_EDITOR,
    siteid: 'default',
    fname: 'QA',
    lname: 'Editor',
    email: 'qa_editor@example.com',
    lastupdate: localDate(INSTALLED_AT),
    lastupdateby: 'Admin User',
    lastupdatebyid: ADMIN,
    subscribe: 1,
    created: localDate(INSTALLED_AT),
    ...overrides.person,
  });
  return {
    person,
    account: accountFor(person, { lastLogin: SHARED_LAST_LOGIN, passwordCreated: INSTALLED_AT, ...overrides.account }),
    groupIds: [EDITOR_GROUP],
    categoryIds: overrides.categoryIds ?? [],
    extend: NO_EXTEND,
    photoFileExt: '',
  };
}

/** The own oracle's qa_editor after the SQL update its user captures were taken from. */
function ownQaEditor(): UserEntitySource {
  const interest = interestRow({ userid: QA_EDITOR, categoryid: INTEREST_CATEGORY });
  return qaEditor({
    person: { company: '  Acme  ', tags: 'alpha,beta', subscribe: 0, mobilephone: '555-0100', contactform: '0', lastupdate: OWN_SAVED_AT },
    account: { remoteId: 'R-1', tablist: 'Basic', lastLogin: OWN_LAST_LOGIN },
    categoryIds: [interest.categoryid],
  });
}

/** qa_editor's primary address as people holds it. */
function primaryAddress(overrides: Partial<AddressRow> = {}): AddressRow {
  return addressRow({
    addressid: PRIMARY_ADDRESS,
    userid: QA_EDITOR,
    siteid: 'default',
    addressname: 'Primary',
    address1: null,
    city: null,
    state: null,
    zip: null,
    country: null,
    isprimary: 1,
    ...overrides,
  });
}

function userOptions(links: Readonly<Record<string, string>>, overrides: Partial<FilteredValuesOptions> = {}): FilteredValuesOptions {
  return { entityName: 'user', pk: 'userid', links, isEntityNameMatch: false, ...overrides };
}

function addressOptions(links: Readonly<Record<string, string>>, overrides: Partial<FilteredValuesOptions> = {}): FilteredValuesOptions {
  return { entityName: 'address', pk: 'addressid', links, isEntityNameMatch: false, ...overrides };
}

describe('a user read on the legacy wire (userDAO.read, getAllValues, getFilteredValues)', () => {
  it.each([
    ['the shared oracle', qaEditor, SHARED_USER],
    ["the own oracle, with identity's remoteid and tablist, people's interest row and an untrimmed company", ownQaEditor, OWN_USER],
  ])('matches %s', (_oracle, source, body) => {
    const values = userBeanValues(source(), CLOCK);

    expect(wire(filteredEntityValues(values, userOptions(oracleLinks(body))))).toStrictEqual(oracleData(body));
  });

  it.each([
    ['fname,lname', qaEditor, SHARED_USER_FNAME_LNAME],
    ['fname,lname,password,links', qaEditor, SHARED_USER_WITH_PASSWORD_AND_LINKS],
    ['company,categoryid', ownQaEditor, OWN_USER_COMPANY_CATEGORY],
  ])('with fields=%s matches the captured body', (fields, source, body) => {
    const values = userBeanValues(source(), CLOCK);
    const links = oracleLinks(SHARED_USER);

    expect(wire(filteredEntityValues(values, userOptions(links, { fields })))).toStrictEqual(oracleData(body));
  });

  it("with fields=addresses writes getAddresses()' rows in ACF's column order, as the captured body does", () => {
    const values = userBeanValues(qaEditor(), CLOCK);
    const getters = { addresses: addressesQuery([primaryAddress()]) };
    const text = createApiSerializer(ENTITY_HINTS).serialize({ data: filteredEntityValues(values, userOptions({}, { fields: 'addresses', getters })) });
    const oracle = oracleData(SHARED_USER_ADDRESSES);

    expect((JSON.parse(text) as { data: unknown }).data).toStrictEqual(oracle);
    expect(text).toContain(`"addresses":${JSON.stringify(oracle.addresses)}`);
  });

  it('keeps every bean key but USER_EXCLUDED_KEYS, adding id, links and entityname, as the captured read does', () => {
    const values = userBeanValues(qaEditor(), CLOCK);
    const kept = Object.keys(values).filter((key) => !USER_EXCLUDED_KEYS.includes(key));

    expect([...kept, 'id', 'links', 'entityname'].sort()).toStrictEqual(sortedKeys(oracleData(SHARED_USER)));
    expect(USER_EXCLUDED_KEYS.filter((key) => Object.hasOwn(oracleData(SHARED_USER), key))).toStrictEqual([]);
  });

  it('writes the userBean.init values of the keys no tusers column, membership or interest feeds', () => {
    const data = wire(filteredEntityValues(userBeanValues({ ...qaEditor(), groupIds: [] }, CLOCK), userOptions({})));
    const keys = ['newfile', 'primaryaddressid', 'addressid', 'groupid', 'categoryid'] as const;

    expect(Object.fromEntries(keys.map((key) => [key, data[key]]))).toStrictEqual(Object.fromEntries(keys.map((key) => [key, USER_BEAN_DEFAULTS[key]])));
  });

  it("merges a fixture person, its identity account, interest rows and stored extended values into one body", () => {
    const person = SYSTEM_USER_A_PERSON;
    const interests = [interestRow({ userid: person.userid }), interestRow({ userid: person.userid })];
    const { required, regex } = USER_EXTENSION.attributes;
    const stored = [
      extendDataRow({ siteid: TENANT_A.siteId, baseid: person.userid, attributeid: required.attributeid, attributevalue: '1001' }),
      ...USER_EXTENSION.extendData.filter((row) => row.attributeid === regex.attributeid),
    ];
    const names = new Map(Object.values(USER_EXTENSION.attributes).map((attribute) => [attribute.attributeid, attribute.name ?? '']));
    const extend: EntityExtendData = {
      data: Object.fromEntries(stored.map((row) => [names.get(row.attributeid) ?? '', row.attributevalue ?? ''])),
      extendSetId: stored.map(() => USER_EXTENSION.set.extendsetid).join(','),
    };
    const source: UserEntitySource = {
      person,
      account: accountFor(person, { remoteId: 'EMP-1001', tablist: 'Basic,Extended' }),
      groupIds: [],
      categoryIds: interests.map((interest) => interest.categoryid),
      extend,
      photoFileExt: '',
    };

    const data = wire(filteredEntityValues(userBeanValues(source, CLOCK), userOptions({})));

    expect(data).toMatchObject({
      userid: person.userid,
      id: person.userid,
      fname: 'Sydney',
      lname: 'System',
      email: 'system_user_a@tenant-a.opt2.test',
      company: 'OPT-2 Test Company',
      jobtitle: 'Analyst',
      mobilephone: '555-0100',
      tags: 'alpha,beta',
      subscribe: 1,
      lastupdate: '2026-06-30T12:00:00',
      username: 'system_user_a',
      siteid: TENANT_A.siteId,
      s2: 0,
      ispublic: 0,
      inactive: 0,
      perm: 0,
      remoteid: 'EMP-1001',
      tablist: 'Basic,Extended',
      lastlogin: '',
      passwordcreated: '2026-06-30T12:00:00',
      type: 'user',
      groupid: '',
      categoryid: interests.map((interest) => interest.categoryid).join(','),
      employeenumber: '1001',
      badgecode: 'AB1234',
      photofileext: '',
      isnew: 0,
    });
    expect(Object.hasOwn(data, 'extendsetid')).toBe(false);
  });
});

describe('an address read on the legacy wire (userDAO.readAddress, getAllValues, getFilteredValues)', () => {
  it.each([
    ['the shared oracle', primaryAddress(), SHARED_ADDRESS],
    ['the own oracle, with an untrimmed address1 and decimal coordinates', primaryAddress({ address1: '  12 Main St  ', city: 'New York', longitude: -73.98, latitude: 40.7128 }), OWN_ADDRESS],
  ])('matches %s', (_oracle, address, body) => {
    const values = addressBeanValues({ address, extend: NO_EXTEND });

    expect(wire(filteredEntityValues(values, addressOptions(oracleLinks(body))))).toStrictEqual(oracleData(body));
  });

  it('with fields=city,password matches the captured body', () => {
    const values = addressBeanValues({ address: primaryAddress(), extend: NO_EXTEND });

    expect(wire(filteredEntityValues(values, addressOptions(oracleLinks(SHARED_ADDRESS), { fields: 'city,password' })))).toStrictEqual(
      oracleData(SHARED_ADDRESS_CITY_PASSWORD),
    );
  });

  it('keeps every bean key but ADDRESS_EXCLUDED_KEYS, adding id, links and entityname, as the captured read does', () => {
    const values = addressBeanValues({ address: primaryAddress(), extend: NO_EXTEND });
    const kept = Object.keys(values).filter((key) => !ADDRESS_EXCLUDED_KEYS.includes(key));

    expect([...kept, 'id', 'links', 'entityname'].sort()).toStrictEqual(sortedKeys(oracleData(SHARED_ADDRESS)));
    expect(ADDRESS_EXCLUDED_KEYS.filter((key) => Object.hasOwn(oracleData(SHARED_ADDRESS), key))).toStrictEqual([]);
  });

  it('writes tiny and large stored coordinates unquoted, as ACF prints them', () => {
    const values = addressBeanValues({ address: primaryAddress({ longitude: 123456.789, latitude: 0.0001 }), extend: NO_EXTEND });
    const text = createApiSerializer(ENTITY_HINTS).serialize(filteredEntityValues(values, addressOptions({})));

    expect(text).toContain('"longitude":123456.789');
    expect(text).toContain('"latitude":0.0001');
  });

  it('writes stored extended values under lower-cased names as quoted text, keeping the set ids', () => {
    const address = addressRow({ userid: SYSTEM_USER_A_PERSON.userid, siteid: TENANT_A.siteId });
    const stored = extendDataRow({ siteid: TENANT_A.siteId, baseid: address.addressid, attributevalue: '7' });
    const extend: EntityExtendData = { data: { deliveryFloor: stored.attributevalue ?? '' }, extendSetId: ADDRESS_SET };

    const data = wire(filteredEntityValues(addressBeanValues({ address, extend }), addressOptions({})));

    expect(data).toMatchObject({ addressid: address.addressid, deliveryfloor: '7', extendsetid: ADDRESS_SET, city: 'Springfield', isprimary: 0 });
  });
});

describe('the save return struct on the legacy wire (jsonApiUtility.cfc:2046-2063)', () => {
  const posted = (username: string, fname: string): Map<string, unknown> =>
    new Map<string, unknown>([
      ['userid', QA_EDITOR],
      ['siteid', 'default'],
      ['username', username],
      ['fname', fname],
      ['lname', 'Editor'],
      ['email', 'qa_editor@example.com'],
      ['type', '2'],
    ]);

  it.each([
    [
      'a failed save, with the posted values over the re-read user',
      posted('admin', '  Changed '),
      { saveErrors: '', errors: { username: USERNAME_TAKEN } },
      qaEditor({ account: { lastLogin: OWN_LAST_LOGIN } }),
      OWN_SAVE_FAILED,
    ],
    [
      'a saved user, re-read as stored and with an empty errors struct',
      posted('qa_editor', 'QA'),
      { saveErrors: '', errors: {} },
      qaEditor({ person: { lastupdate: OWN_SAVED_AT }, account: { lastLogin: OWN_LAST_LOGIN } }),
      OWN_SAVE_OK,
    ],
  ])('matches the captured body of %s', (_case, input, outcome, reread, body) => {
    const values = overlayRequestValues(userBeanValues(reread, CLOCK), input, { entityName: 'user', ...outcome });
    const filtered = filteredEntityValues(values, userOptions(oracleLinks(body), { expanded: true }));

    expect(wire(saveResponse(filtered, outcome))).toStrictEqual(oracleData(body));
  });
});
