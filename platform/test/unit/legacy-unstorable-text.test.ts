// Tests the text PostgreSQL cannot hold as legacy does: unpaired surrogates as legacy's answers write them, and the requests storing them or NUL halted to legacy.
import { describe, expect, it } from 'vitest';
import {
  NUL_TEXT_HALT_VARIANT,
  SURROGATE_TEXT_HALT_VARIANT,
  javaUtf8Text,
  scannedRouteKey,
  textHaltedRouteKey,
  type RouteKeyOptions,
  type ScannedRouteKeyRequest,
} from '../../src/legacy-compat/index.js';

const JSON_TYPE = 'application/json';
const URLENCODED = 'application/x-www-form-urlencoded';
const FIXTURE = '/legacy-fixtures/cfml/api.cfm';
const SIGN = `${FIXTURE}/esignature/requests/A1B2C3D4-E5F6-7890-ABCDEF1234567890/sign`;
const SIGN_KEY = 'fixture:esignature/requests/{id}/sign@post';
const API = '/_api/json/v1/tenant-a';
const REST = '/_api/rest/v1/tenant-a';
const ADMIN = '/admin/index.cfm';
const ID = 'A1B2C3D4-E5F6-7890-ABCDEF1234567890';
/** Route-key options under which `flag` is a remote function of comments, as the inventory declares it. */
const FLAG: RouteKeyOptions = { entityRemoteFunctions: { comment: ['flag'] } };

/** A request as sent: target, method, and an optional body with its content type. */
interface Sent {
  url: string;
  method?: string;
  contentType?: string;
  /** A JSON value parsed as the gateway parses a JSON body, or url-encoded form text. */
  body?: unknown;
  /** Headers in place of the content type's. */
  headers?: ScannedRouteKeyRequest['headers'];
}

/** Url or form fields as the gateway parses them. */
function fieldsOf(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

/** The route-key request of `sent`, a POST unless it names its method. */
function requestOf({ url, method = 'POST', contentType = JSON_TYPE, body, headers }: Sent): ScannedRouteKeyRequest {
  const at = url.indexOf('?');
  const request: ScannedRouteKeyRequest = {
    url,
    method,
    path: at === -1 ? url : url.slice(0, at),
    query: fieldsOf(at === -1 ? '' : url.slice(at + 1)),
    headers: headers ?? { 'content-type': contentType },
  };
  if (contentType === URLENCODED) request.form = fieldsOf(String(body));
  else if (body !== undefined) request.jsonBody = body;
  return request;
}

/** `depth` nested arrays around `inner`. */
function nested(depth: number, inner: unknown): unknown {
  let value = inner;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

describe('javaUtf8Text', () => {
  it.each<[string, string, string]>([
    ['empty text', '', ''],
    ['text without surrogates, NUL included', 'a\u0000b \u00e9\u2713', 'a\u0000b \u00e9\u2713'],
    ['a lone high surrogate', '\ud800x', '?x'],
    ['a lone low surrogate', 'x\udc00', 'x?'],
    ['a surrogate pair', '\ud83d\ude00', '\ud83d\ude00'],
    ['a high surrogate before a pair', '\ud83d\ud83d\ude00', '?\ud83d\ude00'],
    ['a low surrogate after a pair', '\ud83d\ude00\ude00', '\ud83d\ude00?'],
    ['a reversed pair', '\ude00\ud83d', '??'],
    ['surrogates at both ends', '\udfff-\ud800', '?-?'],
  ])('writes %s as Java UTF-8 encodes it', (_label, text, written) => {
    expect(javaUtf8Text(text)).toBe(written);
  });
});

describe('textHaltedRouteKey', () => {
  it.each<[string, Sent, string]>([
    ['a fixture create whose title holds a NUL', { url: `${FIXTURE}/finance/records`, body: { title: 'a\u0000b', amount: '1.0000' } }, 'fixture:finance/records@post'],
    ['a fixture edit', { url: `${FIXTURE}/finance/records/A1B2C3D4-E5F6-7890-ABCDEF1234567890/edit`, body: { title: '\u0000' } }, 'fixture:finance/records/{id}/edit@post'],
    ['a JSON API save', { url: '/_api/json/v1/tenant-a/variationtargeting/', body: { initjs: 'x\u0000' } }, 'api:variationtargeting.save'],
    ['a REST save', { url: '/_api/rest/v1/tenant-a/variationtargeting', body: { targetingjs: '\u0000' } }, 'rest:variationtargeting.save'],
    ['a nested value', { url: `${FIXTURE}/communications/messages`, body: { variables: { name: ['a', 'b\u0000'] } } }, 'fixture:communications/messages@post'],
    ['a key', { url: `${FIXTURE}/surveys/surveys`, body: { 'ti\u0000tle': 'x' } }, 'fixture:surveys/surveys@post'],
    ['a value nested past any stack depth', { url: `${FIXTURE}/surveys/surveys`, body: { answers: nested(200_000, '\u0000') } }, 'fixture:surveys/surveys@post'],
    ['a sign whose typedName also holds an unpaired surrogate', { url: SIGN, body: { typedName: '\ud800\u0000' } }, 'fixture:esignature/requests/{id}/sign@post'],
    [
      'a body under a repeated Content-Type header',
      { url: `${FIXTURE}/timesheets/days/A1B2C3D4-E5F6-7890-ABCDEF1234567890/submit`, headers: { 'Content-Type': ['application/json; charset=utf-8'] }, body: { comment: '\u0000' } },
      'fixture:timesheets/days/{id}/submit@post',
    ],
    [
      'a fixture write whose path id holds a NUL, under a form body',
      { url: `${FIXTURE}/timesheets/days/A1B2C3D4%00-E5F6-7890-ABCDEF1234567890/submit`, contentType: URLENCODED, body: 'comment=x' },
      'fixture:timesheets/days/{id}/submit@post',
    ],
    ['a fixture path whose action holds a NUL', { url: `${FIXTURE}/finance/records/abc/ed%00it`, body: {} }, 'fixture:finance/records/{id}/ed\u0000it@post'],
    ['a person archive whose path id holds a NUL', { url: `${FIXTURE}/people/persons/abc%00def/archive`, body: {} }, 'fixture:people/persons/{id}/archive@post'],
    ['a timesheet read whose path id ends in a NUL', { url: `${FIXTURE}/timesheets/sheets/${ID}%00/status`, method: 'GET' }, 'fixture:timesheets/sheets/{id}/status@get'],
    ['a finance attachment read whose attachment id holds a NUL', { url: `${FIXTURE}/finance/records/${ID}/attachments/abc%00def`, method: 'GET' }, 'fixture:finance/records/{id}/attachments/abc\u0000def@get'],
    ['a finance edit whose path id and JSON body hold a NUL', { url: `${FIXTURE}/finance/records/abc%00def/edit`, body: { title: 'a\u0000b' } }, 'fixture:finance/records/{id}/edit@post'],
    ['a JSON API delete whose 35-character path id holds a NUL', { url: `${API}/category/${ID.slice(0, 34)}%00`, method: 'DELETE' }, 'api:category.delete'],
    ['a REST save whose path id holds a NUL', { url: `${REST}/variationtargeting/${ID.slice(0, 8)}%00${ID.slice(9)}`, method: 'PUT', body: {} }, 'rest:variationtargeting.save'],
    ['a JSON API delete whose path-pair id holds a NUL', { url: `${API}/delete/entityname/comment/id/${ID}%00`, method: 'DELETE' }, 'api:comment.delete'],
    ['a JSON API save whose path-pair value holds a NUL', { url: `${API}/save/entityname/category/name/a%00b`, contentType: URLENCODED, body: '' }, 'api:category.save'],
    ['a REST login whose path-pair username holds a NUL', { url: `${REST}/login/username/admin%00/password/x`, method: 'GET' }, 'rest:login'],
    ['a JSON API delete whose site segment holds a NUL', { url: `/_api/json/v1/tenant%00-a/category/${ID}`, method: 'DELETE' }, 'api:category.delete'],
    ['a JSON API save whose entity segment holds a NUL', { url: `${API}/cate%00gory/`, body: {} }, 'api:cate\u0000gory.save'],
    ['a JSON API read whose path id holds a NUL', { url: `${API}/content/${ID.slice(0, 34)}%00`, method: 'GET' }, 'api:content.findone'],
    ['a REST save whose Basic client secret holds a NUL', { url: `${REST}/category/`, headers: { authorization: `Basic ${Buffer.from(`${ID}:s\u0000`).toString('base64')}` } }, 'rest:category.save'],
    ['an admin create whose path-pair value holds a NUL', { url: `${ADMIN}/cusers/update/fname/a%00b?muraAction=cUsers.update`, contentType: URLENCODED, body: 'type=2&action=Add' }, 'admin:cusers.update'],
    ['an admin save keyed by its path whose path-pair value holds a NUL', { url: `${ADMIN}/cfeed/update/name/a%00b`, contentType: URLENCODED, body: 'action=add' }, 'admin:cfeed.update'],
    ['an admin save whose path-pair name holds a NUL beside a posted name', { url: `${ADMIN}/ccategory/update/na%00me/x`, contentType: URLENCODED, body: 'name=Real' }, 'admin:ccategory.update'],
    ['an admin save whose last path segment names a NUL', { url: `${ADMIN}/cchangesets/save/x%00`, contentType: URLENCODED, body: 'name=a' }, 'admin:cchangesets.save'],
    ['an admin address save whose path-pair value is only a NUL', { url: `${ADMIN}/cusers/updateaddress/address1/%00?muraAction=cUsers.updateAddress`, method: 'GET' }, 'admin:cusers.updateaddress'],
    ['a reporting export list, a read', { url: `${FIXTURE}/reporting/exports`, method: 'GET', body: { pageIndex: '1\u0000' } }, 'fixture:reporting/exports@get'],
    ['a survey schedule path whose action holds a NUL', { url: `${FIXTURE}/surveys/surveys/${ID}/sched%00ule`, body: {} }, 'fixture:surveys/surveys/{id}/sched\u0000ule@post'],
  ])('halts %s under the NUL variant of its base key', (_label, sent, base) => {
    const { result, unhalted } = textHaltedRouteKey(requestOf(sent));
    expect([result.key, result.variant, unhalted?.key]).toStrictEqual([`${base}{${NUL_TEXT_HALT_VARIANT}}`, NUL_TEXT_HALT_VARIANT, base]);
    expect(result.params).toStrictEqual(unhalted?.params);
  });

  it.each<[string, Sent, string]>([
    ['a finance create whose title holds a lone high surrogate', { url: `${FIXTURE}/finance/records?siteid=tenant-a`, body: { title: '\ud800x', amount: '1' } }, 'fixture:finance/records@post'],
    [
      'a finance create sent as a GET overridden to POST',
      { url: `${FIXTURE}/finance/records`, method: 'GET', headers: { 'content-type': JSON_TYPE, 'x-http-method-override': 'POST' }, body: { title: '\ud800' } },
      'fixture:finance/records@post',
    ],
    ['a finance edit whose title holds a lone low surrogate', { url: `${FIXTURE}/finance/records/${ID}/edit`, body: { title: 'x\udc00' } }, 'fixture:finance/records/{id}/edit@post'],
    ['a template create', { url: `${FIXTURE}/communications/templates`, body: { name: 'N', subject: '\udfff' } }, 'fixture:communications/templates@post'],
    ['a message filled from a nested template variable', { url: `${FIXTURE}/communications/messages`, body: { templateId: 'T1', variables: { name: ['a', '\ud800'] } } }, 'fixture:communications/messages@post'],
    ['a signature request whose document name holds one', { url: `${FIXTURE}/esignature/requests`, body: { documentName: '\ud800.pdf' } }, 'fixture:esignature/requests@post'],
    ['a sign whose typedName holds one', { url: SIGN, body: { typedName: 'Ada \ud800' } }, SIGN_KEY],
    ['a sign whose lone low surrogate is in the last spelling legacy merges', { url: SIGN, body: { TypedName: 'Ada', typedname: '\udc00' } }, SIGN_KEY],
    ['a sign whose unpaired surrogate is in another param', { url: SIGN, body: { typedName: 'Ada', note: '\ud800' } }, SIGN_KEY],
    ['a survey create whose key holds one', { url: `${FIXTURE}/surveys/surveys`, body: { 'ti\ud800tle': 'x' } }, 'fixture:surveys/surveys@post'],
    ['a survey response', { url: `${FIXTURE}/surveys/surveys/${ID}/responses`, body: { answers: '{"q1":"\ud800"}' } }, 'fixture:surveys/surveys/{id}/responses@post'],
    ['a bulk target group', { url: `${FIXTURE}/surveys/surveys/${ID}/targets/bulk`, body: { targets: [{ siteID: 'tenant-a', groupName: '\udbff' }] } }, 'fixture:surveys/surveys/{id}/targets/bulk@post'],
    ['a timesheet day submit', { url: `${FIXTURE}/timesheets/days/${ID}/submit`, body: { comment: '\ud800' } }, 'fixture:timesheets/days/{id}/submit@post'],
    ['a timesheet day primary approval', { url: `${FIXTURE}/timesheets/days/${ID}/primary-approve`, body: { comment: '\ud800' } }, 'fixture:timesheets/days/{id}/primary-approve@post'],
    ['a timesheet day secondary approval', { url: `${FIXTURE}/timesheets/days/${ID}/secondary-approve`, body: { comment: '\ud800' } }, 'fixture:timesheets/days/{id}/secondary-approve@post'],
    ['a timesheet day return', { url: `${FIXTURE}/timesheets/days/${ID}/return`, body: { comment: '\ud800' } }, 'fixture:timesheets/days/{id}/return@post'],
    ['a timesheet day resubmit', { url: `${FIXTURE}/timesheets/days/${ID}/resubmit`, body: { comment: '\ud800' } }, 'fixture:timesheets/days/{id}/resubmit@post'],
  ])('halts %s under the surrogate variant of its base key', (_label, sent, base) => {
    const { result, unhalted } = textHaltedRouteKey(requestOf(sent));
    expect([result.key, result.variant, unhalted?.key]).toStrictEqual([`${base}{${SURROGATE_TEXT_HALT_VARIANT}}`, SURROGATE_TEXT_HALT_VARIANT, base]);
    expect(result.params).toStrictEqual(unhalted?.params);
  });

  it.each<[string, Sent]>([
    ['a finance create whose title holds a surrogate pair', { url: `${FIXTURE}/finance/records`, body: { title: '\ud83d\ude00x' } }],
    ['a sign whose typedName holds a surrogate pair', { url: SIGN, body: { typedName: 'Ada \ud83d\ude00' } }],
    ['a sign without a typedName', { url: SIGN, body: { count: 1, signed: true, note: null } }],
    ['an unpaired surrogate on a reporting export create, which stores no request text', { url: `${FIXTURE}/reporting/exports`, body: { definitionId: ID, format: 'csv', note: '\ud800' } }],
    ['an unpaired surrogate on a survey schedule, which stores no request text', { url: `${FIXTURE}/surveys/surveys/${ID}/schedule`, body: { launchAt: '\ud800' } }],
    ['an unpaired surrogate on a finance submit, which stores no request text', { url: `${FIXTURE}/finance/records/${ID}/submit`, body: { note: '\ud800' } }],
    ['an unpaired surrogate on a person archive, which stores no request text', { url: `${FIXTURE}/people/persons/${ID}/archive`, body: { effectiveFrom: '\ud800' } }],
    ['an unpaired surrogate in a fixture read', { url: `${FIXTURE}/finance/records`, method: 'GET', body: { title: '\ud800' } }],
    ['a fixture JSON array body holding an unpaired surrogate, which api.cfm does not merge', { url: `${FIXTURE}/finance/records`, body: ['\ud800'] }],
    ['an unpaired surrogate in a JSON API save, which Masa binds as varchar and stores as `?`', { url: `${API}/variationtargeting/`, body: { initjs: '\ud800x' } }],
    ['an unpaired surrogate in a REST save', { url: `${REST}/variationtargeting`, body: { targetingjs: 'y\udc00' } }],
    ['a form value encoding a surrogate, which legacy decodes to U+FFFD', { url: `${FIXTURE}/finance/records`, contentType: URLENCODED, body: 'title=%ED%A0%80x' }],
    ['a JSON body sent without a content type', { url: `${FIXTURE}/finance/records`, headers: { 'content-type': undefined }, body: { title: '\u0000' } }],
    ['a url NUL, which the scan strips', { url: `${FIXTURE}/finance/records?title=a%00b`, method: 'GET', body: undefined }],
    ['a form NUL, which the scan strips', { url: `${FIXTURE}/finance/records`, contentType: URLENCODED, body: 'title=a%00b' }],
    ['a url name holding a NUL, which the scan copies to its stripped name', { url: `${API}/variationtargeting/?init%00js=a`, contentType: URLENCODED, body: 'targetingjs=c' }],
    ['a form name holding a NUL', { url: `${FIXTURE}/finance/records`, contentType: URLENCODED, body: 'ti%00tle=a&amount=1' }],
    ['an admin form name holding a NUL', { url: '/admin/?muraAction=cUsers.update', contentType: URLENCODED, body: 'type=1&action=Add&groupna%00me=x' }],
    ['an admin path-pair value holding a NUL that the form replaces', { url: `${ADMIN}/ccategory/update/name/a%00b?muraAction=cCategory.update`, contentType: URLENCODED, body: 'name=Real' }],
    ['a NUL in an admin action segment, which keys an action no entry lists', { url: `${ADMIN}/cus%00ers/update`, contentType: URLENCODED, body: 'type=1' }],
    ['a NUL in an admin action segment the url action replaces', { url: `${ADMIN}/cus%00ers/update?muraAction=cUsers.update`, contentType: URLENCODED, body: 'type=1' }],
    ['an admin path pair holding an escaped percent sign, which FW/1 reads as text', { url: `${ADMIN}/ccategory/update/name/a%2500b`, contentType: URLENCODED, body: '' }],
    ['a reload whose admin path pair holds a NUL, which legacy always serves', { url: `${ADMIN}/cusers/update/fname/a%00b?appreload`, contentType: URLENCODED, body: 'type=2' }],
    ['a JSON body legacy does not read for its content type', { url: `${FIXTURE}/finance/records`, contentType: 'text/plain', body: { title: '\u0000' } }],
    ['a JSON array body, which legacy does not merge', { url: '/_api/json/v1/tenant-a/variationtargeting/', body: ['\u0000'] }],
    ['a JSON body of an admin action, which reads no JSON body', { url: '/admin/?muraAction=cUsers.update', body: { type: '\u0000' } }],
    ['a JSON body of a page', { url: '/', body: { doaction: '\u0000' } }],
    ['a JSON body of an OPT-2 path', { url: '/opt2/stub/ping', body: { x: '\u0000' } }],
    ['a reload, which legacy always serves', { url: '/_api/json/v1/tenant-a/variationtargeting/?appreload', body: { initjs: '\u0000' } }],
    ['a fixture path id holding an escaped percent sign, which api.cfm reads as text', { url: `${FIXTURE}/finance/records/abc%2500def`, method: 'GET' }],
    ['a JSON API path segment holding a NUL that only names a path param, which parseParamsFromPath strips', { url: `${API}/variationtargeting/abc%00def`, method: 'GET' }],
    ['a NUL in a path-pair name, which parseParamsFromPath strips', { url: `${API}/save/entityname/category/na%00me/x`, contentType: URLENCODED, body: '' }],
    ['a NUL in path segments after a 35-character id, which processRequest never reads', { url: `${API}/category/${ID}/x/y%00`, method: 'DELETE' }],
    ['a NUL in a REST OAuth endpoint segment, matched only against names', { url: `${REST}/oauth2/token%00`, method: 'GET' }],
    ['a NUL in the site segment of a REST OAuth path, which falls back to the default site', { url: '/_api/rest/v1/de%00fault/oauth', method: 'GET' }],
    ['a NUL in a REST login path-pair name', { url: `${REST}/login/x%00`, method: 'GET' }],
    ['a path NUL of a family that takes no path params', { url: '/_api/feed/v1/a%00b?feedid=x', method: 'GET' }],
    ['a NUL in a fixture folder template path', { url: '/legacy-fixtures/cfml/seed.cfm/a%00b', method: 'GET' }],
  ])('keys %s as scannedRouteKey does', (_label, sent) => {
    const request = requestOf(sent);
    expect(textHaltedRouteKey(request)).toStrictEqual(scannedRouteKey(request));
  });

  it.each<[string, Sent, string]>([
    ['an export create whose definitionId holds a NUL', { url: `${FIXTURE}/reporting/exports`, body: { definitionId: `${ID}\u0000`, format: 'csv' } }, 'fixture:reporting/exports@post'],
    ['an export create whose siteid, format and asOf hold one', { url: `${FIXTURE}/reporting/exports`, body: { siteid: 'tenant-a\u0000', definitionId: ID, format: 'csv\u0000', asOf: '\u0000' } }, 'fixture:reporting/exports@post'],
    ['an export create whose unread key and value hold one', { url: `${FIXTURE}/reporting/exports`, body: { definitionId: ID, format: 'csv', 'no\u0000te': 'x\u0000' } }, 'fixture:reporting/exports@post'],
    [
      'an export create sent as a GET overridden to POST',
      { url: `${FIXTURE}/reporting/exports`, method: 'GET', headers: { 'content-type': JSON_TYPE, 'x-http-method-override': 'POST' }, body: { definitionId: '\u0000' } },
      'fixture:reporting/exports@post',
    ],
    ['a survey schedule whose path id holds a NUL', { url: `${FIXTURE}/surveys/surveys/${ID}%00/schedule`, body: { launchAt: '2026-07-01T09:00:00' } }, 'fixture:surveys/surveys/{id}/schedule@post'],
    ['a survey schedule whose launchAt holds one', { url: `${FIXTURE}/surveys/surveys/${ID}/schedule`, body: { launchAt: '2026-07-01T09:00:00\u0000' } }, 'fixture:surveys/surveys/{id}/schedule@post'],
    [
      'a survey schedule whose reminders and their JSON text hold one',
      { url: `${FIXTURE}/surveys/surveys/${ID}/schedule`, body: { launchAt: '2026-07-01T09:00:00', reminders: [{ offsetMinutes: '5\u0000' }], text: '[{"x":"a\u0000"}]' } },
      'fixture:surveys/surveys/{id}/schedule@post',
    ],
    ['a finance read whose path id holds a NUL', { url: `${FIXTURE}/finance/records/abc%00def?siteid=tenant-a`, method: 'GET' }, 'fixture:finance/records/{id}@get'],
    ['a finance attachment read whose record id is only a NUL', { url: `${FIXTURE}/finance/records/%00/attachments/${ID}`, method: 'GET' }, 'fixture:finance/records/{id}/attachments/{id}@get'],
    ['a finance submit whose path id holds a NUL, under a form body', { url: `${FIXTURE}/finance/records/${ID.slice(0, 8)}%00${ID.slice(8)}/submit`, contentType: URLENCODED, body: 'x=1' }, 'fixture:finance/records/{id}/submit@post'],
    ['a survey response list whose path id ends in a NUL', { url: `${FIXTURE}/surveys/surveys/${ID}%00/responses`, method: 'GET' }, 'fixture:surveys/surveys/{id}/responses@get'],
    ['a survey launch whose path id holds a NUL', { url: `${FIXTURE}/surveys/surveys/abc%00def/launch`, method: 'GET' }, 'fixture:surveys/surveys/{id}/launch@get'],
    ['an e-signature sign whose path id is a NUL, under a JSON body without one', { url: `${FIXTURE}/esignature/requests/%00/sign`, body: { typedName: 'Ada' } }, SIGN_KEY],
  ])('keys %s, which the target answers as legacy does, under its base key unhalted', (_label, sent, base) => {
    const request = requestOf(sent);
    const keyed = textHaltedRouteKey(request);
    expect(keyed).toStrictEqual(scannedRouteKey(request));
    expect([keyed.result.key, keyed.unhalted]).toStrictEqual([base, undefined]);
  });

  it.each<[string, string, RouteKeyOptions, string | undefined]>([
    ['the bean a path id holding a NUL loads', `${API}/comment/${ID.slice(0, 34)}%00/flag`, FLAG, 'api:comment.~flag'],
    ['a segment after the function, which legacy never reads', `${API}/comment/flag/x%00`, FLAG, undefined],
    ['the same path, a path pair whose value holds the NUL when flag is no remote function', `${API}/comment/flag/x%00`, {}, 'api:comment.findall'],
  ])('keys a comment flag whose NUL lands in %s by where it lands', (_label, url, options, base) => {
    const request = requestOf({ url, contentType: URLENCODED, body: '' });
    const { result, unhalted } = textHaltedRouteKey(request, options);
    if (base === undefined) expect(textHaltedRouteKey(request, options)).toStrictEqual(scannedRouteKey(request, options));
    else expect([result.key, unhalted?.key]).toStrictEqual([`${base}{${NUL_TEXT_HALT_VARIANT}}`, base]);
  });

  it('keys a scan-halted request holding a NUL under the scan variant, as scannedRouteKey does', () => {
    const request = requestOf({ url: '/_api/json/v1/tenant-a/?method=findOne&entityname=user&a-b=one&a.b=two', body: { x: '\u0000' } });
    const keyed = textHaltedRouteKey(request);
    expect(keyed).toStrictEqual(scannedRouteKey(request));
    expect([keyed.result.key, keyed.unhalted?.key]).toStrictEqual(['api:user.findone{scriptprotect=fault}', 'api:user.findone']);
  });

  it.each<[string, Sent, Record<string, string>]>([
    ['a url value, its NUL stripped', { url: `${FIXTURE}/finance/records?title=a%00b`, method: 'GET' }, { title: 'ab' }],
    ['a url name, kept beside its stripped copy', { url: `${FIXTURE}/finance/records?ti%00tle=a`, method: 'GET' }, { 'ti\u0000tle': 'a', title: 'a' }],
    ['a form name, kept beside its stripped copy', { url: `${FIXTURE}/finance/records`, contentType: URLENCODED, body: 'ti%00tle=a' }, { 'ti\u0000tle': 'a', title: 'a' }],
    ['an admin path-pair value, unscanned', { url: `${ADMIN}/cusers/update/fname/%20a%00b`, contentType: URLENCODED, body: 'type=2' }, { fname: ' a\u0000b' }],
  ])('leaves %s in the params legacy reads', (_label, sent, params) => {
    expect(textHaltedRouteKey(requestOf(sent)).result.params).toMatchObject(params);
  });
});
