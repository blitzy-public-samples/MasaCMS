import { describe, expect, it } from 'vitest';
import {
  LEGACY_JSON_CONTENT_TYPE,
  LEGACY_SHUNTER_CONTENT_TYPE,
  LegacyJsonSerializer,
  buildEnvelope,
  cfHash,
  cfIsBoolean,
  cfIsDate,
  cfIsNumeric,
  createApiSerializer,
  etag,
  formatSerializerDate,
  formatSerializerUtcDate,
  getApiVersion,
  legacyQuery,
  paramsWithoutMethod,
  serializeResponse,
  serializeSaveResult,
  type LegacyEnvelope,
  type SerializeResponseOptions,
} from '../../src/legacy-compat/index.js';

const LOCAL = new Date(2026, 5, 30, 12, 0, 0);
const NESTED_BODY = '{"apiversion":"v1","method":"findOne","data":{"id":"a1","title":"Home"}}';
const FLAT_BODY = '{"apiversion":"v1","method":"findOne","id":"a1","title":"Home"}';

function envelope(): LegacyEnvelope {
  return buildEnvelope({ method: 'findOne', params: { siteid: 'default' }, data: { id: 'a1', title: 'Home' } });
}

function bodyOf(data: unknown, opts: SerializeResponseOptions = {}): string {
  return serializeResponse(buildEnvelope({ method: 'findOne', data }), opts).body;
}

describe('buildEnvelope', () => {
  it('builds apiversion, method, params and data in legacy key order', () => {
    const result = envelope();
    expect(result).toEqual({ apiversion: 'v1', method: 'findOne', params: { siteid: 'default' }, data: { id: 'a1', title: 'Home' } });
    expect(Object.keys(result)).toEqual(['apiversion', 'method', 'params', 'data']);
    expect(result.apiversion).toBe(getApiVersion());
  });

  it('puts error in place of data', () => {
    const error = { type: 'badRequest', message: 'Bad Request' };
    const result = buildEnvelope({ method: 'save', params: { siteid: 'default' }, data: { id: 'a1' }, error });
    expect(result).toEqual({ apiversion: 'v1', method: 'save', params: { siteid: 'default' }, error });
    expect(Object.keys(result)).toEqual(['apiversion', 'method', 'params', 'error']);
  });

  it('omits params when none are given', () => {
    expect(Object.keys(buildEnvelope({ method: 'findMany', data: [] }))).toEqual(['apiversion', 'method', 'data']);
  });
});

describe('serializeResponse status and content type', () => {
  it('answers 200 with only the legacy content type and ETag headers by default', () => {
    const result = serializeResponse(envelope());
    expect(result.status).toBe(200);
    expect(Object.keys(result.headers)).toEqual(['Content-Type', 'ETag']);
    expect(result.headers['Content-Type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    // The servlet container sends setContentType('application/json; charset=utf-8') without the space.
    expect(LEGACY_JSON_CONTENT_TYPE).toBe('application/json;charset=utf-8');
  });

  it('answers the requested status', () => {
    expect(serializeResponse(envelope(), { statusCode: 400 }).status).toBe(400);
  });

  it.each([200, 400, 500])('answers 404 for mura404 when status %i is requested', (statusCode) => {
    expect(serializeResponse(envelope(), { statusCode, mura404: true }).status).toBe(404);
  });
});

describe('serializeResponse params suppression', () => {
  it('drops params by default', () => {
    expect(serializeResponse(envelope()).body).toBe(NESTED_BODY);
  });

  it('keeps params when suppressAPIParams is false', () => {
    expect(serializeResponse(envelope(), { suppressAPIParams: false }).body).toBe(
      '{"apiversion":"v1","method":"findOne","params":{"siteid":"default"},"data":{"id":"a1","title":"Home"}}',
    );
  });

  it('drops params in any case and keeps a null params, which isDefined does not see', () => {
    expect(serializeResponse({ apiversion: 'v1', method: 'findOne', Params: { a: 'b' } }).body).toBe(
      '{"apiversion":"v1","method":"findOne"}',
    );
    expect(serializeResponse({ apiversion: 'v1', method: 'findOne', params: null }).body).toBe(
      '{"apiversion":"v1","method":"findOne","params":null}',
    );
  });

  it('leaves the caller envelope unchanged', () => {
    const input = envelope();
    serializeResponse(input, { useDataNamespace: false });
    expect(input).toEqual(envelope());
  });
});

describe('serializeResponse data namespace', () => {
  it.each<{ useDataNamespace: unknown; useDataNamespaceForAPI?: boolean; flattened: boolean }>([
    { useDataNamespace: false, flattened: true },
    { useDataNamespace: 'false', flattened: true },
    { useDataNamespace: 'NO', flattened: true },
    { useDataNamespace: 0, flattened: true },
    { useDataNamespace: '0', flattened: true },
    { useDataNamespace: true, flattened: false },
    { useDataNamespace: 'yes', flattened: false },
    { useDataNamespace: '1', flattened: false },
    { useDataNamespace: undefined, flattened: false },
    { useDataNamespace: 'maybe', flattened: false },
    { useDataNamespace: undefined, useDataNamespaceForAPI: false, flattened: true },
    { useDataNamespace: 'maybe', useDataNamespaceForAPI: false, flattened: true },
    { useDataNamespace: 'true', useDataNamespaceForAPI: false, flattened: false },
  ])(
    'useDataNamespace $useDataNamespace with useDataNamespaceForAPI $useDataNamespaceForAPI flattens struct data: $flattened',
    ({ useDataNamespace, useDataNamespaceForAPI, flattened }) => {
      const result = serializeResponse(envelope(), { useDataNamespace, useDataNamespaceForAPI });
      expect(result.body).toBe(flattened ? FLAT_BODY : NESTED_BODY);
    },
  );

  it.each<[string, unknown, string]>([
    ['an array', ['a', 1], '["a","1"]'],
    ['a string', 'text', '"text"'],
    ['a query', legacyQuery(['ID'], [{ id: 7 }]), '[{"id":"7"}]'],
    ['a date', LOCAL, '"June, 30 2026 12:00:00"'],
    ['null', null, 'null'],
  ])('keeps data holding %s under data when flattening is requested', (_label, data, json) => {
    expect(bodyOf(data, { useDataNamespace: false })).toBe(`{"apiversion":"v1","method":"findOne","data":${json}}`);
  });
});

describe('serializeResponse shunter layout', () => {
  it('uses the legacy wire form of the shunter content type', () => {
    expect(LEGACY_SHUNTER_CONTENT_TYPE).toBe('application/x-shunter+json;charset=utf-8');
  });

  it.each<{ label: string; data: Record<string, unknown>; shunter: boolean; body: string }>([
    {
      label: 'shunter true with a layout',
      data: { shunter: true, layout: 'two-col', id: 'a1' },
      shunter: true,
      body: '{"apiversion":"v1","method":"findOne","data":{"shunter":true,"layout":"two-col","id":"a1"},"layout":"two-col"}',
    },
    {
      label: 'Shunter "yes" with a struct Layout',
      data: { Shunter: 'yes', Layout: { name: 'grid' } },
      shunter: true,
      body: '{"apiversion":"v1","method":"findOne","data":{"shunter":"yes","layout":{"name":"grid"}},"layout":{"name":"grid"}}',
    },
    {
      label: 'shunter true without a layout',
      data: { shunter: true },
      shunter: false,
      body: '{"apiversion":"v1","method":"findOne","data":{"shunter":true}}',
    },
    {
      label: 'shunter true with a null layout',
      data: { shunter: true, layout: null },
      shunter: false,
      body: '{"apiversion":"v1","method":"findOne","data":{"shunter":true,"layout":null}}',
    },
    {
      label: 'shunter false with a layout',
      data: { shunter: false, layout: 'two-col' },
      shunter: false,
      body: '{"apiversion":"v1","method":"findOne","data":{"shunter":false,"layout":"two-col"}}',
    },
    {
      label: 'a non-boolean shunter with a layout',
      data: { shunter: 'maybe', layout: 'two-col' },
      shunter: false,
      body: '{"apiversion":"v1","method":"findOne","data":{"shunter":"maybe","layout":"two-col"}}',
    },
  ])('$label answers the shunter content type: $shunter', ({ data, shunter, body }) => {
    const result = serializeResponse(buildEnvelope({ method: 'findOne', data }));
    expect(result.headers['Content-Type']).toBe(shunter ? LEGACY_SHUNTER_CONTENT_TYPE : LEGACY_JSON_CONTENT_TYPE);
    expect(result.body).toBe(body);
  });

  it('applies no shunter layout once data is flattened away', () => {
    const result = serializeResponse(buildEnvelope({ method: 'findOne', data: { shunter: true, layout: 'two-col' } }), {
      useDataNamespace: false,
    });
    expect(result.headers['Content-Type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(result.body).toBe('{"apiversion":"v1","method":"findOne","shunter":true,"layout":"two-col"}');
  });
});

describe('serializeResponse ETag', () => {
  // ACF 2023 hash() with no algorithm is SHA-256, so legacy ETags are 64 uppercase hex digits rather than MD5.
  it('sets ETag to the uppercase SHA-256 of a body serialized as {}', () => {
    const result = serializeResponse({});
    expect(result.body).toBe('{}');
    expect(result.headers['ETag']).toBe('44136FA355B3678A1146AD16F7E8649E94FB4FC21FE77E8310C060F61CAAFF8A');
    expect(etag('{}')).toBe(result.headers['ETag']);
    expect(cfHash('{}')).toBe(result.headers['ETag']);
  });

  it('hashes the exact body sent for each response shape', () => {
    const shapes: SerializeResponseOptions[] = [{}, { suppressAPIParams: false }, { useDataNamespace: false }];
    const results = shapes.map((opts) => serializeResponse(envelope(), opts));
    for (const { body, headers } of results) {
      expect(headers['ETag']).toBe(etag(body));
      expect(headers['ETag']).toMatch(/^[0-9A-F]{64}$/);
    }
    expect(new Set(results.map((r) => r.headers['ETag'])).size).toBe(shapes.length);
  });

  it('serializes with the given serializer instead of the API key hints', () => {
    const data = { code: '5', password: 'p' };
    expect(bodyOf(data)).toBe('{"apiversion":"v1","method":"findOne","data":{"code":5,"password":"p"}}');
    const result = serializeResponse(buildEnvelope({ method: 'findOne', data }), {
      serializer: new LegacyJsonSerializer().exclude('password'),
    });
    expect(result.body).toBe('{"apiversion":"v1","method":"findOne","data":{"code":"5"}}');
    expect(result.headers['ETag']).toBe(etag(result.body));
  });
});

// Expected orders are ACF 2023 bins of the upper-cased keys (APIVERSION 0, A 1, B 2, DATA 5, LAYOUT 7, METHOD 9, ERROR 10,
// TITLE 10, PARAMS 11, ID 11, __PROTO__ 13) or bodies captured from the legacy oracle.
describe('serializeResponse ACF key order', () => {
  const ERROR = { code: 'invalid_request', message: 'Invalid parameters' };

  it.each<{ label: string; response: LegacyEnvelope; opts?: SerializeResponseOptions; body: string }>([
    {
      label: 'a success envelope',
      response: envelope(),
      body: '{"apiversion":"v1","data":{"id":"a1","title":"Home"},"method":"findOne"}',
    },
    {
      label: 'a success envelope with params kept',
      response: envelope(),
      opts: { suppressAPIParams: false },
      body: '{"apiversion":"v1","data":{"id":"a1","title":"Home"},"method":"findOne","params":{"siteid":"default"}}',
    },
    {
      label: 'an error envelope',
      response: buildEnvelope({ method: 'save', params: { siteid: 'default' }, error: ERROR }),
      body: '{"apiversion":"v1","method":"save","error":{"code":"invalid_request","message":"Invalid parameters"}}',
    },
    {
      label: 'an error envelope with params kept',
      response: buildEnvelope({ method: 'save', params: { siteid: 'default' }, error: ERROR }),
      opts: { suppressAPIParams: false },
      body: '{"apiversion":"v1","method":"save","error":{"code":"invalid_request","message":"Invalid parameters"},"params":{"siteid":"default"}}',
    },
    {
      label: 'flattened data',
      response: envelope(),
      opts: { useDataNamespace: 'false' },
      body: '{"apiversion":"v1","method":"findOne","title":"Home","id":"a1"}',
    },
    {
      label: 'flattened data with params kept, ID chained after PARAMS in its bin',
      response: envelope(),
      opts: { useDataNamespace: 'false', suppressAPIParams: false },
      body: '{"apiversion":"v1","method":"findOne","title":"Home","params":{"siteid":"default"},"id":"a1"}',
    },
    {
      label: 'flattened data overwriting Method ignoring case',
      response: buildEnvelope({ method: 'findOne', params: {}, data: { Method: 'x', b: '2', a: '1' } }),
      opts: { useDataNamespace: 'false' },
      body: '{"apiversion":"v1","a":"1","b":"2","method":"x"}',
    },
    {
      label: 'flattened csrf tokens (legacy generateCSRFTokens?useDataNamespace=false)',
      response: buildEnvelope({ method: 'generateCSRFTokens', params: {}, data: { csrf_token: 'T', csrf_token_expires: 'E' } }),
      opts: { useDataNamespace: 'false' },
      body: '{"apiversion":"v1","csrf_token":"T","method":"generateCSRFTokens","csrf_token_expires":"E"}',
    },
    {
      label: 'a shunter layout',
      response: buildEnvelope({ method: 'findOne', data: { shunter: true, layout: 'two-col', id: 'a1' } }),
      body: '{"apiversion":"v1","data":{"shunter":true,"layout":"two-col","id":"a1"},"layout":"two-col","method":"findOne"}',
    },
  ])('orders $label as ACF iterates the response struct', ({ response, opts, body }) => {
    const result = serializeResponse(response, { ...opts, keyOrder: 'acf' });
    expect(result.body).toBe(body);
    expect(result.headers['ETag']).toBe(etag(body));
  });

  // Data and flattened key orders captured from the legacy oracle: group/properties (one table resize) and findCurrentUser (three).
  it.each<{ label: string; data: readonly string[]; flattened: readonly string[] }>([
    {
      label: 'group/properties',
      data: ['displayname', 'properties', 'historical', 'links', 'dynamic', 'primarykey', 'public', 'bundleable', 'orderby', 'entityname', 'scaffold'],
      flattened: [
        'apiversion', 'displayname', 'properties', 'historical', 'links', 'dynamic', 'primarykey', 'method', 'public', 'bundleable', 'orderby',
        'entityname', 'scaffold',
      ],
    },
    {
      label: 'findCurrentUser',
      data: [
        'mobilephone', 'lname', 'email', 'contactform', 'lastupdate', 'keepprivate', 'userid', 'username', 'id', 'lastupdatebyid', 'type', 'subtype',
        'categoryid', 'fname', 'company', 'tablist', 'newfile', 'ispublic', 'imservice', 'isnew', 'jobtitle', 'website', 'lastlogin', 'tags', 's2',
        'membershipids', 'links', 'notes', 'created', 'groupname', 'perm', 'description', 'addressid', 'memberships', 'imname', 'passwordcreated',
        'photofileid', 'interests', 'isloggedin', 'siteid', 'primaryaddressid', 'subscribe', 'remoteid', 'groupid', 'inactive', 'photofileext',
        'lastupdateby', 'entityname',
      ],
      flattened: [
        'apiversion', 'mobilephone', 'lname', 'email', 'contactform', 'lastupdate', 'keepprivate', 'userid', 'username', 'id', 'type',
        'lastupdatebyid', 'subtype', 'categoryid', 'fname', 'company', 'tablist', 'newfile', 'ispublic', 'method', 'imservice', 'isnew', 'jobtitle',
        'website', 'lastlogin', 'tags', 's2', 'membershipids', 'links', 'notes', 'created', 'groupname', 'perm', 'description', 'addressid',
        'memberships', 'imname', 'passwordcreated', 'photofileid', 'interests', 'isloggedin', 'siteid', 'primaryaddressid', 'subscribe', 'remoteid',
        'groupid', 'inactive', 'photofileext', 'lastupdateby', 'entityname',
      ],
    },
  ])('flattens $label data across table resizes in the legacy order', ({ data, flattened }) => {
    const values = Object.fromEntries(data.map((key) => [key, 'x']));
    const response = buildEnvelope({ method: 'm', params: { siteid: 'default' }, data: values });

    const nested = serializeResponse(response, { keyOrder: 'acf' });
    const flat = serializeResponse(response, { keyOrder: 'acf', useDataNamespace: false });

    expect(Object.keys(JSON.parse(nested.body) as object)).toEqual(['apiversion', 'data', 'method']);
    expect(Object.keys(JSON.parse(flat.body) as object)).toEqual(flattened);
    expect(flat.headers['ETag']).toBe(etag(flat.body));
  });

  it('passes the key order through serializeSaveResult', () => {
    const result = serializeSaveResult({ method: 'save', params: { siteid: 'default' }, data: { id: 'a1', errors: {} } }, { keyOrder: 'acf' });
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"apiversion":"v1","data":{"id":"a1","errors":{}},"method":"save"}');
  });

  it.each<{ opts: SerializeResponseOptions; body: string }>([
    { opts: {}, body: NESTED_BODY },
    { opts: { suppressAPIParams: false }, body: '{"apiversion":"v1","method":"findOne","params":{"siteid":"default"},"data":{"id":"a1","title":"Home"}}' },
    { opts: { useDataNamespace: false }, body: FLAT_BODY },
  ])('keeps insertion order by default and for keyOrder insertion with $opts', ({ opts, body }) => {
    expect(serializeResponse(envelope(), opts).body).toBe(body);
    expect(serializeResponse(envelope(), { ...opts, keyOrder: 'insertion' }).body).toBe(body);
  });
});

describe('serializeSaveResult', () => {
  it.each<{ label: string; data: unknown; status: number }>([
    { label: 'a non-empty errors struct', data: { id: 'a1', errors: { username: 'Required' } }, status: 403 },
    { label: 'a non-empty Errors struct in another case', data: { id: 'a1', Errors: { email: 'Invalid' } }, status: 403 },
    { label: 'an empty errors struct', data: { id: 'a1', errors: {} }, status: 200 },
    { label: 'no errors key', data: { id: 'a1' }, status: 200 },
    { label: 'a non-struct errors value', data: { id: 'a1', errors: 'none' }, status: 200 },
    { label: 'non-struct data', data: ['a1'], status: 200 },
  ])('answers $status for data with $label', ({ data, status }) => {
    expect(serializeSaveResult({ method: 'save', params: { siteid: 'default' }, data }).status).toBe(status);
  });

  it('echoes params without method or path values when params are not suppressed', () => {
    const result = serializeSaveResult(
      { method: 'save', params: { method: 'save', siteid: 'default', newfile: '/tmp/upload.png' }, data: { id: 'a1', errors: {} } },
      { suppressAPIParams: false },
    );
    expect(result.body).toBe('{"apiversion":"v1","method":"save","params":{"siteid":"default"},"data":{"id":"a1","errors":{}}}');
  });

  it('answers 404 for mura404 even when the save has errors', () => {
    const result = serializeSaveResult(
      { method: 'save', params: {}, data: { errors: { title: 'Required' } } },
      { mura404: true },
    );
    expect(result.status).toBe(404);
  });
});

describe('paramsWithoutMethod', () => {
  it('removes method, _cacheid and cacheid in any case and leaves the input unchanged', () => {
    const params = { Method: 'findOne', _CACHEID: '1', cacheid: '2', siteid: 'default', entityname: 'content' };
    expect(paramsWithoutMethod(params)).toEqual({ siteid: 'default', entityname: 'content' });
    expect(params).toHaveProperty('Method', 'findOne');
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['fields[name]', { 'fields[name]': 'x', fieldsname: 'y', other: 'z' }, { 'fields[name]': 'x', other: 'z' }],
    ['filter[title]', { 'filter[title]': 'x', FilterTitle: 'y' }, { 'filter[title]': 'x' }],
    ['a[b][c]', { 'a[b][c]': 'x', ac: 'y', ab: 'z' }, { 'a[b][c]': 'x', ab: 'z' }],
    ['ids[]', { 'ids[]': '1', ids: '2' }, { 'ids[]': '1' }],
    ['[', { '[': 'x', '': 'y' }, { '[': 'x' }],
  ])('for %s deletes the joined first and last bracket names and keeps the bracketed key', (_key, params, expected) => {
    expect(paramsWithoutMethod(params)).toEqual(expected);
  });

  it('drops simple values holding a slash or backslash and keeps complex values', () => {
    const params = {
      file: '/var/www/assets/a.pdf',
      winpath: 'C:\\inetpub\\a.pdf',
      returnurl: 'http://example.com/x',
      'fields[path]': '/tmp/x',
      title: 'Home',
      count: 5,
      flag: true,
      filter: { path: '/x' },
      ids: ['/x'],
    };
    expect(paramsWithoutMethod(params)).toEqual({ title: 'Home', count: 5, flag: true, filter: { path: '/x' }, ids: ['/x'] });
  });
});

describe('envelope bodies through the API serializer', () => {
  it('lower-cases keys at every depth', () => {
    expect(bodyOf({ SiteID: 'default', Nested: { InnerKey: 'v' } })).toBe(
      '{"apiversion":"v1","method":"findOne","data":{"siteid":"default","nested":{"innerkey":"v"}}}',
    );
  });

  it('quotes numbers without a hint and passes an integer hint down to unhinted children', () => {
    const data = { totalitems: '12', siteid: 5, pageindex: { a: '3', b: 'x' }, items: [{ id: 1, count: 3 }] };
    expect(bodyOf(data)).toBe(
      '{"apiversion":"v1","method":"findOne","data":{"totalitems":12,"siteid":"5","pageindex":{"a":3,"b":"x"},"items":[{"id":"1","count":"3"}]}}',
    );
  });

  // jsonSerializer.cfc rereplace has scope "one", so later control characters stay in numeric strings quoted raw.
  it('strips the first control character of the final text and hashes the stripped body', () => {
    const result = serializeResponse(buildEnvelope({ method: 'findOne', data: { a: '12\u0001', b: '7\u0002', c: 'x\u0003' } }));
    expect(result.body).toBe('{"apiversion":"v1","method":"findOne","data":{"a":"12","b":"7\u0002","c":"x\\u0003"}}');
    expect(result.headers['ETag']).toBe(etag(result.body));
  });

  it('serializes a LegacyQuery as row structs in column order with hinted columns and NULL cells as empty strings', () => {
    const users = legacyQuery(['USERID', 'FNAME', 'TOTALITEMS'], [
      { UserID: 'A1', fname: 'Ann', totalitems: '3' },
      { userid: 'B2', fname: null },
    ]);
    expect(bodyOf(users)).toBe(
      '{"apiversion":"v1","method":"findOne","data":[{"userid":"A1","fname":"Ann","totalitems":3},{"userid":"B2","fname":"","totalitems":""}]}',
    );
  });

  it('omits excluded keys and formats asDate and asUtcDate keys from local dates', () => {
    const serializer = createApiSerializer().exclude('Password').asDate('lastUpdate').asUtcDate('created');
    const data = { userid: 'A1', password: 'p', lastupdate: LOCAL, start: LOCAL, created: LOCAL };
    expect(formatSerializerDate(LOCAL)).toBe('2026-06-30T12:00:00');
    expect(formatSerializerUtcDate(LOCAL)).toMatch(/^2026-06-30T12:00:00[+-]\d{2,3}:\d{2}$/);
    expect(bodyOf(data, { serializer })).toBe(
      `{"apiversion":"v1","method":"findOne","data":{"userid":"A1","lastupdate":"2026-06-30T12:00:00","start":"2026-06-30T12:00:00","created":"${formatSerializerUtcDate(LOCAL)}"}}`,
    );
  });

  it('writes only the date for an asUtcDate value at 23:59', () => {
    const serializer = new LegacyJsonSerializer().asUtcDate('created');
    expect(serializer.serialize({ created: new Date(2026, 5, 30, 23, 59, 30) })).toBe('{"created":"2026-06-30"}');
  });
});

describe('CFML predicates', () => {
  it.each<[string, unknown, boolean, (v: unknown) => boolean]>([
    ['cfIsNumeric', '5', true, cfIsNumeric],
    ['cfIsNumeric', '1e3', true, cfIsNumeric],
    ['cfIsNumeric', 'abc', false, cfIsNumeric],
    ['cfIsBoolean', 'yes', true, cfIsBoolean],
    ['cfIsBoolean', 'no', true, cfIsBoolean],
    ['cfIsBoolean', 'true', true, cfIsBoolean],
    ['cfIsBoolean', '1', true, cfIsBoolean],
    ['cfIsBoolean', 'maybe', false, cfIsBoolean],
    ['cfIsDate', LOCAL, true, cfIsDate],
    ['cfIsDate', new Date(Number.NaN), false, cfIsDate],
    // Date-typed values reach the serializer as Date objects, so date text is never a date here.
    ['cfIsDate', '2026-06-30', false, cfIsDate],
    ['cfIsDate', 'abc', false, cfIsDate],
  ])('%s(%j) is %s', (_name, value, expected, predicate) => {
    expect(predicate(value)).toBe(expected);
  });
});
