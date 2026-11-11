/** Legacy wire vectors of the people contract: JSON API user and address bodies and favorites template bodies, as the legacy oracle answers them. */
import { readFileSync } from 'node:fs';
import { createApiSerializer, entityPropertyHint, type ApiKeyHint } from '@opt2/platform/legacy-compat';
import { ContractAssertionError, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const CONTRACT = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as Record<string, unknown>;

const USER_ID = 'AF240756-C1CD-6298-60C0CAF70AACAE2B';
const ADMIN_ID = 'AF1841AB-0ED4-34A5-AF2596AB342BA3E6';
const ADDRESS_ID = 'AF240BF8-CD42-BD2B-56E2A2B69C1F8E05';
const JSON_TYPE = 'application/json;charset=utf-8';
const TEXT_TYPE = 'text/html;charset=UTF-8';
const FAVORITES = '/core/modules/v1/favorites/ajax';

// GET /_api/json/v1/default/{user,address}/<id|new> bodies; the two decimal addresses come from an oracle whose coordinates were set first.
const USER_QA_EDITOR = '{"apiversion":"v1","data":{"mobilephone":"","lname":"Editor","email":"qa_editor@example.com","contactform":"0","lastupdate":"2026-11-10T09:07:57","keepprivate":0,"userid":"AF240756-C1CD-6298-60C0CAF70AACAE2B","username":"qa_editor","id":"AF240756-C1CD-6298-60C0CAF70AACAE2B","lastupdatebyid":"AF1841AB-0ED4-34A5-AF2596AB342BA3E6","type":"user","subtype":"Default","categoryid":"","fname":"QA","company":"","tablist":"","newfile":"","ispublic":0,"imservice":"","isnew":0,"jobtitle":"","website":"","lastlogin":"2026-11-11T18:26:37","tags":"","s2":0,"links":{"all":"http://localhost:8080/index.cfm/_api/json/v1/default/user","permissions":"http://localhost:8080/index.cfm/_api/json/v1/default/user/AF240756-C1CD-6298-60C0CAF70AACAE2B/permissions","properties":"http://localhost:8080/index.cfm/_api/json/v1/default/user/properties","edit":"http://localhost:8080/admin/?muraAction=cusers.edituser&siteid=default&userid=AF240756-C1CD-6298-60C0CAF70AACAE2B","self":"http://localhost:8080/index.cfm/_api/json/v1/default/user/AF240756-C1CD-6298-60C0CAF70AACAE2B","entities":"http://localhost:8080/index.cfm/_api/json/v1/default"},"notes":"","created":"2026-11-10T09:07:57","groupname":"","perm":0,"description":"","addressid":"","imname":"","passwordcreated":"2026-11-10T09:07:57","photofileid":"","interests":"","siteid":"default","primaryaddressid":"","subscribe":1,"remoteid":"","groupid":"AF23F22F-D28E-CBBD-5A2FF00600256C68","inactive":0,"photofileext":"","lastupdateby":"Admin User","entityname":"user"},"method":"findOne"}';
const USER_ADMIN = '{"apiversion":"v1","data":{"mobilephone":"","lname":"User","email":"admin@example.com","contactform":"","lastupdate":"2026-11-10T09:06:40","keepprivate":0,"userid":"AF1841AB-0ED4-34A5-AF2596AB342BA3E6","username":"admin","id":"AF1841AB-0ED4-34A5-AF2596AB342BA3E6","lastupdatebyid":"22FC551F-FABE-EA01-C6EDD0885DDC1682","type":"user","subtype":"Default","categoryid":"","fname":"Admin","company":"","tablist":"","newfile":"","ispublic":0,"imservice":"","isnew":0,"jobtitle":"","website":"","lastlogin":"2026-11-11T21:48:07","tags":"","s2":1,"links":{"all":"http://localhost:8080/index.cfm/_api/json/v1/default/user","permissions":"http://localhost:8080/index.cfm/_api/json/v1/default/user/AF1841AB-0ED4-34A5-AF2596AB342BA3E6/permissions","properties":"http://localhost:8080/index.cfm/_api/json/v1/default/user/properties","edit":"http://localhost:8080/admin/?muraAction=cusers.edituser&siteid=default&userid=AF1841AB-0ED4-34A5-AF2596AB342BA3E6","self":"http://localhost:8080/index.cfm/_api/json/v1/default/user/AF1841AB-0ED4-34A5-AF2596AB342BA3E6","entities":"http://localhost:8080/index.cfm/_api/json/v1/default"},"notes":"","created":"2026-11-10T09:06:40","groupname":"","perm":0,"description":"","addressid":"","imname":"","passwordcreated":"2026-11-10T09:07:20","photofileid":"","interests":"","siteid":"default","primaryaddressid":"","subscribe":0,"remoteid":"","groupid":"","inactive":0,"photofileext":"","lastupdateby":"System","entityname":"user"},"method":"findOne"}';
const USER_NEW = '{"apiversion":"v1","data":{"mobilephone":"","lname":"","email":"","contactform":"","lastupdate":"2026-11-11T21:47:45","keepprivate":0,"userid":"FDCFE9AB-A507-9844-239F29F531D90D21","username":"","id":"FDCFE9AB-A507-9844-239F29F531D90D21","lastupdatebyid":"","type":"user","subtype":"Default","categoryid":"","fname":"","company":"","tablist":"","newfile":"","ispublic":1,"imservice":"","isnew":1,"jobtitle":"","website":"","lastlogin":"","tags":"","s2":0,"links":{"all":"http://localhost:8080/index.cfm/_api/json/v1/default/user","permissions":"http://localhost:8080/index.cfm/_api/json/v1/default/user/FDCFE9AB-A507-9844-239F29F531D90D21/permissions","properties":"http://localhost:8080/index.cfm/_api/json/v1/default/user/properties","edit":"http://localhost:8080/admin/?muraAction=cusers.edituser&siteid=default&userid=FDCFE9AB-A507-9844-239F29F531D90D21","self":"http://localhost:8080/index.cfm/_api/json/v1/default/user/FDCFE9AB-A507-9844-239F29F531D90D21","entities":"http://localhost:8080/index.cfm/_api/json/v1/default"},"notes":"","created":"2026-11-11T21:47:45","groupname":"","perm":0,"description":"","addressid":"","imname":"","passwordcreated":"2026-11-11T21:47:45","photofileid":"","interests":"","siteid":"default","primaryaddressid":"","subscribe":1,"remoteid":"","groupid":"","inactive":0,"photofileext":"","lastupdateby":"","entityname":"user"},"method":"findNew"}';
const ADDRESS_PRIMARY = '{"apiversion":"v1","data":{"zip":"","longitude":0,"phone":"","links":{"all":"http://localhost:8080/index.cfm/_api/json/v1/default/address","site":"http://localhost:8080/index.cfm/_api/json/v1/default/site","permissions":"http://localhost:8080/index.cfm/_api/json/v1/default/address/AF240BF8-CD42-BD2B-56E2A2B69C1F8E05/permissions","properties":"http://localhost:8080/index.cfm/_api/json/v1/default/address/properties","self":"http://localhost:8080/index.cfm/_api/json/v1/default/address/AF240BF8-CD42-BD2B-56E2A2B69C1F8E05","entities":"http://localhost:8080/index.cfm/_api/json/v1/default","user":"http://localhost:8080/index.cfm/_api/json/v1/default/user/AF240756-C1CD-6298-60C0CAF70AACAE2B"},"state":"","country":"","addressid":"AF240BF8-CD42-BD2B-56E2A2B69C1F8E05","userid":"AF240756-C1CD-6298-60C0CAF70AACAE2B","addressname":"Primary","addressemail":"","id":"AF240BF8-CD42-BD2B-56E2A2B69C1F8E05","address1":"","type":"Address","address2":"","subtype":"Default","addressurl":"","extendsetid":"","siteid":"default","city":"","hours":"","isprimary":1,"fax":"","isnew":0,"addressnotes":"","latitude":0,"entityname":"address"},"method":"findOne"}';
const ADDRESS_NEW = '{"apiversion":"v1","data":{"zip":"","longitude":0,"phone":"","links":{"all":"http://localhost:8080/index.cfm/_api/json/v1/default/address","site":"http://localhost:8080/index.cfm/_api/json/v1/default/site","permissions":"http://localhost:8080/index.cfm/_api/json/v1/default/address/FDCFF02D-CE0F-717B-EB06BF9DB770147B/permissions","properties":"http://localhost:8080/index.cfm/_api/json/v1/default/address/properties","self":"http://localhost:8080/index.cfm/_api/json/v1/default/address/FDCFF02D-CE0F-717B-EB06BF9DB770147B","entities":"http://localhost:8080/index.cfm/_api/json/v1/default"},"state":"","country":"","addressid":"FDCFF02D-CE0F-717B-EB06BF9DB770147B","userid":"","addressname":"","addressemail":"","id":"FDCFF02D-CE0F-717B-EB06BF9DB770147B","address1":"","type":"Address","address2":"","subtype":"Default","addressurl":"","extendsetid":"","siteid":"default","city":"","hours":"","isprimary":0,"fax":"","isnew":0,"addressnotes":"","latitude":0,"entityname":"address"},"method":"findNew"}';
const ADDRESS_DECIMAL = '{"apiversion":"v1","data":{"zip":"","longitude":-73.98,"phone":"","links":{"all":"http://localhost:20080/index.cfm/_api/json/v1/default/address","site":"http://localhost:20080/index.cfm/_api/json/v1/default/site","permissions":"http://localhost:20080/index.cfm/_api/json/v1/default/address/AF240BF8-CD42-BD2B-56E2A2B69C1F8E05/permissions","properties":"http://localhost:20080/index.cfm/_api/json/v1/default/address/properties","self":"http://localhost:20080/index.cfm/_api/json/v1/default/address/AF240BF8-CD42-BD2B-56E2A2B69C1F8E05","entities":"http://localhost:20080/index.cfm/_api/json/v1/default","user":"http://localhost:20080/index.cfm/_api/json/v1/default/user/AF240756-C1CD-6298-60C0CAF70AACAE2B"},"state":"","country":"","addressid":"AF240BF8-CD42-BD2B-56E2A2B69C1F8E05","userid":"AF240756-C1CD-6298-60C0CAF70AACAE2B","addressname":"Primary","addressemail":"","id":"AF240BF8-CD42-BD2B-56E2A2B69C1F8E05","address1":"","type":"Address","address2":"","subtype":"Default","addressurl":"","extendsetid":"","siteid":"default","city":"","hours":"","isprimary":1,"fax":"","isnew":0,"addressnotes":"","latitude":40.7128,"entityname":"address"},"method":"findOne"}';
const ADDRESS_TINY_LARGE = '{"apiversion":"v1","data":{"zip":"","longitude":123456.789,"phone":"","links":{"all":"http://localhost:20080/index.cfm/_api/json/v1/default/address","site":"http://localhost:20080/index.cfm/_api/json/v1/default/site","permissions":"http://localhost:20080/index.cfm/_api/json/v1/default/address/AF23FE61-EA1F-9CA6-1CADC0B2B27C342D/permissions","properties":"http://localhost:20080/index.cfm/_api/json/v1/default/address/properties","self":"http://localhost:20080/index.cfm/_api/json/v1/default/address/AF23FE61-EA1F-9CA6-1CADC0B2B27C342D","entities":"http://localhost:20080/index.cfm/_api/json/v1/default","user":"http://localhost:20080/index.cfm/_api/json/v1/default/user/AF23F22F-D28E-CBBD-5A2FF00600256C68"},"state":"","country":"","addressid":"AF23FE61-EA1F-9CA6-1CADC0B2B27C342D","userid":"AF23F22F-D28E-CBBD-5A2FF00600256C68","addressname":"Primary","addressemail":"","id":"AF23FE61-EA1F-9CA6-1CADC0B2B27C342D","address1":"","type":"Address","address2":"","subtype":"Default","addressurl":"","extendsetid":"","siteid":"default","city":"","hours":"","isprimary":1,"fax":"","isnew":0,"addressnotes":"","latitude":0.0001,"entityname":"address"},"method":"findOne"}';
// Site-less roots: an unknown `siteid` serves `default`, whose address findAll rejects the parameters; REST without a credential.
const SITELESS_UNKNOWN_SITE = '{"apiversion":"v1","method":"findAll","error":{"message":"Invalid parameters","code":"invalid_request"}}';
const SITELESS_REST_UNAUTHORIZED = '{"apiversion":"v1","method":"invalid","error":{"message":"Insufficient Account Permissions","code":"invalid_request"}}';
// Favorites templates: a Page and an RSS save, a delete and an RSS delete.
const FAVORITE_SAVED_PAGE = '{"lid":"FDB7586BDF4AD87B4B1C071AFB7A9FD9","favoriteid":"FDB7586B-DF4A-D87B-4B1C071AFB7A9FD9","link":"<a href=\\"\\" onClick=\\"return deleteFavorite(\\\'FDB7586B-DF4A-D87B-4B1C071AFB7A9FD9\\\', \\\'favoriteFDB7586BDF4AD87B4B1C071AFB7A9FD9\\\');\\" title=\\"remove from favorites\\" class=\\"remove\\"></a> <a href=\\\'/\\\'>Home</a>"}';
const FAVORITE_SAVED_RSS = '{"lid":"FDC77431EE51212C4D4BAA43E0E0E521","favoriteid":"FDC77431-EE51-212C-4D4BAA43E0E0E521","link":"<a href=\\"\\" onClick=\\"return deleteFavorite(\\\'FDC77431-EE51-212C-4D4BAA43E0E0E521\\\', \\\'favoriteFDC77431EE51212C4D4BAA43E0E0E521\\\');\\" title=\\"remove from favorites\\" class=\\"remove\\"></a> <a href=\\\'/\\\'>Feed \\"One\\"</a>"}';
const FAVORITE_REMOVED = 'Your favorite has been removed.';
const RSS_FAVORITES_DELETED = '';

type Component = 'UserEntity' | 'AddressEntity';

// One GET probe per component schema, so the platform response assertion validates the component itself.
const COMPONENT_PROBE = {
  ...CONTRACT,
  paths: Object.fromEntries(
    (['UserEntity', 'AddressEntity'] as const).map((name) => [
      `/probe/${name}`,
      { get: { responses: { '200': { description: name, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } } } },
    ]),
  ),
};

/** Numeric bean properties; registerEntity hints each by its `numeric` datatype, so they serialize unquoted. */
const NUMERIC_FIELDS: ReadonlyArray<readonly [Component, string]> = [
  ['UserEntity', 's2'],
  ['UserEntity', 'perm'],
  ['UserEntity', 'inactive'],
  ['UserEntity', 'ispublic'],
  ['UserEntity', 'subscribe'],
  ['UserEntity', 'keepprivate'],
  ['AddressEntity', 'isprimary'],
  ['AddressEntity', 'longitude'],
  ['AddressEntity', 'latitude'],
];
const NUMERIC_VALUES = [0, 1, -1, -73.98, 40.7128, 0.0001, 123456.789];

/** Validates `data` against a component schema; throws ContractAssertionError on a violation. */
function assertComponent(component: Component, data: unknown): void {
  assertResponseMatchesOpenApi(COMPONENT_PROBE, { method: 'GET', path: `/probe/${component}`, status: 200, contentType: 'application/json', body: data });
}

/** The `data` member of a legacy envelope text. */
function dataOf(body: string): unknown {
  return (JSON.parse(body) as { data: unknown }).data;
}

/** The serializer hints registerEntity installs for the numeric bean properties. */
function entityHints(): ApiKeyHint[] {
  const hint = entityPropertyHint('numeric');
  if (hint === undefined) throw new Error('no serializer hint for the numeric datatype');
  return NUMERIC_FIELDS.map(([, key]) => ({ key, hint }));
}

describe('legacy JSON API user and address reads', () => {
  it.each([
    ['qa_editor read', 'UserEntity', USER_QA_EDITOR],
    ['admin read', 'UserEntity', USER_ADMIN],
    ['new user', 'UserEntity', USER_NEW],
    ['primary address read', 'AddressEntity', ADDRESS_PRIMARY],
    ['new address', 'AddressEntity', ADDRESS_NEW],
    ['address with decimal coordinates', 'AddressEntity', ADDRESS_DECIMAL],
    ['address with tiny and large coordinates', 'AddressEntity', ADDRESS_TINY_LARGE],
  ] as const)('the %s data matches %s', (_case, component, body) => {
    assertComponent(component, dataOf(body));
  });

  it.each([
    [`/_api/json/v1/default/user/${USER_ID}`, 200, USER_QA_EDITOR],
    [`/_api/json/v1/default/user/${ADMIN_ID}`, 200, USER_ADMIN],
    ['/_api/json/v1/default/user/new', 200, USER_NEW],
    [`/_api/json/v1/default/address/${ADDRESS_ID}`, 200, ADDRESS_PRIMARY],
    ['/_api/json/v1/default/address/new', 200, ADDRESS_NEW],
    ['/_api/json/v1', 200, USER_QA_EDITOR],
    ['/_api/ajax/v1', 200, USER_QA_EDITOR],
    ['/_api/json/v1', 200, ADDRESS_PRIMARY],
    ['/_api/json/v1', 400, SITELESS_UNKNOWN_SITE],
    ['/_api/rest/v1', 401, SITELESS_REST_UNAUTHORIZED],
  ] as const)('GET %s %i matches its operation', (path, status, body) => {
    assertResponseMatchesOpenApi(CONTRACT, { method: 'GET', path, status, contentType: JSON_TYPE, body });
  });

  it.each([
    ['qa_editor read', 'UserEntity', USER_QA_EDITOR, 's2'],
    ['primary address read', 'AddressEntity', ADDRESS_PRIMARY, 'isprimary'],
  ] as const)('the %s data with %s.%s quoted is rejected', (_case, component, body, key) => {
    const data = dataOf(body) as Record<string, unknown>;
    expect(() => assertComponent(component, { ...data, [key]: String(data[key]) })).toThrow(ContractAssertionError);
  });

  it('rejects a user read carrying `extendsetid`, which legacy removes from users only', () => {
    const body = USER_QA_EDITOR.replace('"entityname":"user"', '"extendsetid":"","entityname":"user"');
    const path = `/_api/json/v1/default/user/${USER_ID}`;
    expect(() => assertResponseMatchesOpenApi(CONTRACT, { method: 'GET', path, status: 200, contentType: JSON_TYPE, body })).toThrow(
      ContractAssertionError,
    );
  });
});

describe('platform serializer with the legacy entity hints', () => {
  it.each(NUMERIC_FIELDS.flatMap(([component, key]) => NUMERIC_VALUES.map((value) => [component, key, value] as const)))(
    '%s %s %d serializes as an unquoted number the schema accepts',
    (component, key, value) => {
      const text = createApiSerializer(entityHints()).serialize({ [key]: value });
      expect(text).toBe(`{"${key}":${String(value)}}`);
      assertComponent(component, JSON.parse(text));
    },
  );

  it.each(NUMERIC_FIELDS)('%s %s accepts the empty string of a NULL column', (component, key) => {
    const text = createApiSerializer(entityHints()).serialize({ [key]: '' });
    expect(text).toBe(`{"${key}":""}`);
    assertComponent(component, JSON.parse(text));
  });

  it.each(NUMERIC_FIELDS)('%s %s rejects the quoted text an unhinted key serializes as', (component, key) => {
    const text = createApiSerializer().serialize({ [key]: 1 });
    expect(text).toBe(`{"${key}":"1"}`);
    expect(() => assertComponent(component, JSON.parse(text))).toThrow(ContractAssertionError);
  });
});

describe('favorites template bodies', () => {
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
  const bodies = [
    [`${FAVORITES}/saveFavorite.cfm`, FAVORITE_SAVED_PAGE],
    [`${FAVORITES}/saveFavorite.cfm`, FAVORITE_SAVED_RSS],
    [`${FAVORITES}/deleteFavorite.cfm`, FAVORITE_REMOVED],
    [`${FAVORITES}/deleteRSSFavorite.cfm`, RSS_FAVORITES_DELETED],
  ] as const;

  it.each(methods.flatMap((method) => bodies.map(([path, body]) => [method, path, body] as const)))(
    '%s %s answers the legacy body',
    (method, path, body) => {
      assertResponseMatchesOpenApi(CONTRACT, { method, path, status: 200, contentType: TEXT_TYPE, body });
    },
  );

  it.each([
    ['saveFavorite.cfm', 'upper-case keys', FAVORITE_SAVED_PAGE.replace('"lid"', '"LID"').replace('"favoriteid"', '"FAVORITEID"')],
    ['saveFavorite.cfm', 'keys out of the legacy order', FAVORITE_SAVED_PAGE.replace(/^\{("lid":"[0-9A-F]{32}"),("favoriteid":"[^"]+")/, '{$2,$1')],
    ['deleteFavorite.cfm', 'other text', 'Your favorite was removed.'],
    ['deleteRSSFavorite.cfm', 'a non-empty body', FAVORITE_REMOVED],
  ])('%s rejects %s', (template, _case, body) => {
    expect(() =>
      assertResponseMatchesOpenApi(CONTRACT, { method: 'GET', path: `${FAVORITES}/${template}`, status: 200, contentType: TEXT_TYPE, body }),
    ).toThrow(ContractAssertionError);
  });
});
