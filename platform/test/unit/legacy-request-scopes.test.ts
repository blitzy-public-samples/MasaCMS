import { describe, expect, it } from 'vitest';
import {
  PATH_PAIRS_HEADER,
  appendFormScopeValue,
  formScopeInputsOf,
  isJsonContentType,
  legacyScopeParams,
  legacyScopeValue,
  legacyScopesFrom,
  pathPairsHeaderValue,
  portcullisInputsOf,
  type LegacyScopes,
  type PortcullisScope,
} from '../../src/legacy-compat/index.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

/** A field part and a file part as `@fastify/multipart` attaches them to the body. */
const field = (fieldname: string, value: unknown) => ({ type: 'field', fieldname, value });
const file = (fieldname: string, filename: string) => ({ type: 'file', fieldname, filename });

describe('isJsonContentType', () => {
  it.each([
    ['application/json', true],
    ['APPLICATION/JSON-PATCH+JSON; charset=utf-8', true],
    ['application/jsonx', true],
    ['application/x-www-form-urlencoded', false],
    ['text/json', false],
    [['application/json'], false],
    [undefined, false],
  ])('reads %j as JSON: %s', (contentType, json) => {
    expect(isJsonContentType(contentType)).toBe(json);
  });
});

describe('legacyScopeValue and portcullisInputsOf', () => {
  it('joins repeated values with commas, takes a field part by value and a file part by name', () => {
    expect(legacyScopeValue(['a', field('t', 'b'), file('u', 'c.png')])).toBe('a,b,c.png');
    expect(legacyScopeValue(field('t', 'b'))).toBe('b');
    expect(legacyScopeValue(file('u', 'c.png'))).toBe('c.png');
    expect(legacyScopeValue('x')).toBe('x');
  });

  it('marks a name holding a file part to pass unscanned, in field order', () => {
    expect(portcullisInputsOf({ title: field('title', 'Hi'), up: [file('up', 'a.png'), file('up', 'b.png')], q: 'x' })).toStrictEqual([
      ['title', 'Hi', false],
      ['up', 'a.png,b.png', true],
      ['q', 'x', false],
    ]);
  });

  it.each([undefined, null, 'text', Buffer.from('a=1'), ['a']])('has no inputs for a %j body', (fields) => {
    expect(portcullisInputsOf(fields)).toStrictEqual([]);
  });

  // Own-oracle probes: url q=1&Q=2&r=3 holds q=1,2; Q=2&q=1 holds Q=2,1; q=1&Q=2&q=3 holds q=1,2,3; a urlencoded
  // form q=1&Q=2&q=3 holds Q=1,3,2 (ColdFusion upper-cases form names; the first spelling sent is kept here).
  it.each<[string, Record<string, unknown>, string | undefined, unknown[]]>([
    ['under the first spelling, in field order', { q: '1', Q: '2', r: '3' }, undefined, [['q', '1,2', false], ['r', '3', false]]],
    ['under an upper-case first spelling', { Q: '2', q: '1' }, undefined, [['Q', '2,1', false]]],
    ['a repeated spelling in field order without a target, as a urlencoded form holds it', { q: ['1', '3'], Q: '2' }, undefined, [['q', '1,3,2', false]]],
    ['a repeated spelling in the order the target sent it', { q: ['1', '3'], Q: '2' }, '/p?q=1&Q=2&q=3', [['q', '1,2,3', false]]],
    ['names the target sent with + and escapes', { 'a b': ['1', '3'], 'A B': '2' }, '/p?a+b=1&A%20B=2&&a%20b=3', [['a b', '1,2,3', false]]],
    ['a name the target sent with a malformed escape', { 'q%zz': ['1', '3'], 'Q%ZZ': '2' }, '/p?q%zz=1&Q%ZZ=2&q%zz=3', [['q%zz', '1,2,3', false]]],
    ['in field order when the target does not account for every value', { q: ['1', '3'], Q: '2' }, '/p?q=1&Q=2', [['q', '1,3,2', false]]],
    ['in field order when the target omits a spelling', { q: '1', Q: '2' }, '/p?q=1&qQ=2', [['q', '1,2', false]]],
    ['in field order when the target names a spelling the fields lack', { ab: '1', AB: '2' }, '/p?ab=1&Ab=2', [['ab', '1,2', false]]],
    ['in field order when the target sends a spelling more often', { q: '1', Q: '2' }, '/p?Q=2&q=1&Q=3', [['q', '1,2', false]]],
    ['in field order when the target has no query', { q: '1', Q: '2' }, '/p', [['q', '1,2', false]]],
    ['a file part with a field, passing unscanned', { up: file('up', 'a.png'), UP: 't' }, undefined, [['up', 'a.png,t', true]]],
    ['without an undefined value, and a parsed JSON field as its JSON', { q: undefined, Q: field('Q', { a: 1 }), QQ: 'x' }, undefined, [['q', '{"a":1}', false], ['QQ', 'x', false]]],
    // @fastify/multipart groups parts by exact name, so their interleaving across spellings is no longer known.
    ['multipart fields in field order, their interleaving across spellings unknown once parsed', { q: [field('q', '1'), field('q', '3')], Q: field('Q', '2') }, undefined, [['q', '1,3,2', false]]],
  ])('joins names differing only in case %s', (_label, fields, target, inputs) => {
    expect(portcullisInputsOf(fields, target)).toStrictEqual(inputs);
  });
});

// The ACF 2023 oracle's form-scope value for one name posted with these values, url-encoded and multipart alike; it
// reads a file part as the upload's temporary path, '' when no file is chosen, which the port reads as the file name.
const FORM_JOINS: ReadonlyArray<readonly [readonly (string | { readonly file: string })[], string]> = [
  [['', { file: '' }], ''],
  [[{ file: '' }, ''], ''],
  [['x', { file: '' }], 'x'],
  [[{ file: '' }, { file: '' }], ''],
  [['', { file: 'p.png' }], 'p.png'],
  [['', ''], ''],
  [['a', '', 'b'], 'a,b'],
  [['', 'b'], 'b'],
  [[' ', 'b'], ' ,b'],
  [['a', ' '], 'a'],
  [['', ' '], ''],
  [['\t', 'x'], '\t,x'],
  [['', 'a', ''], 'a'],
  [['a', ','], 'a,,'],
  [['', ','], ','],
  [[',', { file: '' }], ','],
];

describe('appendFormScopeValue and formScopeInputsOf', () => {
  const cases = FORM_JOINS.map(([values, joined]) => [JSON.stringify(values), values, joined] as const);

  it.each(cases)('joins a form name posted as %s into %j, where the url scope keeps every value', (_label, values, joined) => {
    const texts = values.map((value) => (typeof value === 'string' ? value : value.file));
    const parts = values.map((value) => (typeof value === 'string' ? field('v', value) : file('v', value.file)));
    const hasFile = values.some((value) => typeof value !== 'string');

    expect(texts.reduce<string | undefined>(appendFormScopeValue, undefined)).toBe(joined);
    expect(formScopeInputsOf({ v: parts })).toStrictEqual([['v', joined, hasFile]]);
    if (!hasFile) expect(formScopeInputsOf({ v: texts })).toStrictEqual([['v', joined, false]]);
    expect(portcullisInputsOf({ v: parts })).toStrictEqual([['v', texts.join(','), hasFile]]);
  });

  it.each<[string, Record<string, unknown>, unknown[]]>([
    ['an empty spelling before a filled one', { v: '', V: 'b' }, [['v', 'b', false]]],
    ['a blank spelling before a filled one', { q: ' ', Q: 'b' }, [['q', ' ,b', false]]],
    ['an empty value between repeated spellings', { v: ['a', ''], V: 'b' }, [['v', 'a,b', false]]],
    ['a text field beside an empty file part', { newFile: '', NEWFILE: file('NEWFILE', '') }, [['newFile', '', true]]],
    ['a filled file part after an empty text field', { newFile: field('newFile', ''), NewFile: file('NewFile', 'me.png') }, [['newFile', 'me.png', true]]],
  ])('joins names differing only in case, %s, as the form scope does', (_label, fields, inputs) => {
    expect(formScopeInputsOf(fields)).toStrictEqual(inputs);
  });

  it.each([undefined, 'text', ['a']])('has no inputs for a %j body', (fields) => {
    expect(formScopeInputsOf(fields)).toStrictEqual([]);
  });
});

describe('legacyScopesFrom', () => {
  it('scans the url and form scopes apart, renamed names after the rest and stripped-name copies last', () => {
    const query = Object.assign(Object.create(null) as Record<string, unknown>, { 'site-id': ' tenant-b ', 'amp;q': 'x\u0000y', r: ['1', '2'] });
    const scopes: LegacyScopes = legacyScopesFrom({ query, body: { fname: '<script>x</script>Al', 'a b': '1' }, headers: FORM });
    expect(scopes).toStrictEqual({
      url: { entries: [['site-id', 'tenant-b'], ['r', '1,2'], ['q', 'xy'], ['siteid', 'tenant-b']], failed: false },
      form: { entries: [['fname', '[INVALID]Al']], failed: false },
      json: false,
      jsonBody: undefined,
    });
  });

  it('leaves the form scope empty beside a JSON body, which it hands on as sent', () => {
    const body = { 'site-id': ' tenant-b ', fname: '<script>' };
    const scopes = legacyScopesFrom({ query: { q: ' x ' }, body, headers: JSON_TYPE });
    expect(scopes).toStrictEqual({ url: { entries: [['q', 'x']], failed: false }, form: { entries: [], failed: false }, json: true, jsonBody: body });
    expect(scopes.jsonBody).toBe(body);
  });

  it('keeps a failed url scope to its name and NUL fixes, and the form as posted after it', () => {
    const scopes = legacyScopesFrom({ query: { q: 'null', 'amp;r': ' a\u0000 ' }, body: { 'site-id': ' x ', fname: '<script>' }, headers: FORM });
    expect(scopes.url).toStrictEqual({ entries: [['q', 'null'], ['r', ' a ']], failed: true });
    expect(scopes.form).toStrictEqual({ entries: [['site-id', ' x '], ['fname', '<script>']], failed: false });
  });

  it('flags a failed form scan', () => {
    expect(legacyScopesFrom({ query: {}, body: { q: '[null]' }, headers: FORM }).form).toStrictEqual({ entries: [['q', '[null]']], failed: true });
  });

  // Own-oracle probes of the url scope as onRequestStart's scan leaves it.
  it.each<[string, string, Array<[string, string]>]>([
    ['q=%201%20&Q=%3Cscript%3Ex%3C/script%3E2', '/p?q=%201%20&Q=%3Cscript%3Ex%3C/script%3E2', [['q', '1 ,[INVALID]2']]],
    ['q=1&Q=null', '/p?q=1&Q=null', [['q', '1,null']]],
    ['q=null&Q=null', '/p?q=null&Q=null', [['q', 'null,null']]],
    ['Q=[1]&q=2', '/p?Q=%5B1%5D&q=2', [['Q', '[1],2']]],
    ['amp;q=1&Q=2&q=3', '/p?amp;q=1&Q=2&q=3', [['Q', '1']]],
    ['q=+a&Q=b+', '/p?q=+a&Q=b+', [['q', 'a,b']]],
    ['q=1&Q=2&q=3', '/p?q=1&Q=2&q=3', [['q', '1,2,3']]],
  ])('scans the joined value of url %s as one, the scan never faulting on a part', (_label, url, entries) => {
    const query: Record<string, string[]> = {};
    for (const [name, value] of new URLSearchParams(url.slice(url.indexOf('?') + 1))) (query[name] ??= []).push(value);
    expect(legacyScopesFrom({ query, body: undefined, headers: {}, url }).url).toStrictEqual({ entries, failed: false });
  });

  // Own-oracle probes of a multipart part typed application/json: the form scope holds its text, which the scan reads.
  it.each<[string, unknown, string]>([
    ['a JSON array as sent', field('groupname', '["<script>x</script>"]'), '["[INVALID]"]'],
    ['a JSON string as sent', field('groupname', '"<script>x</script>"'), '"[INVALID]"'],
    ['a JSON object as sent', field('groupname', '{"b":1,"a":"<script>x</script>"}'), '{"a":"[INVALID]","b":1}'],
    ['a JSON number as sent', field('groupname', '1.50'), '1.50'],
    ['a padded JSON string as sent', field('groupname', '  "  padded  "  '), '"padded"'],
    ['a JSON boolean as sent', field('groupname', 'true'), 'true'],
    ['a parsed JSON array', field('groupname', ['<script>x</script>']), '["[INVALID]"]'],
    ['a parsed JSON object', field('groupname', { b: 1, a: '<script>x</script>' }), '{"a":"[INVALID]","b":1}'],
    ['a parsed JSON boolean', field('groupname', true), 'true'],
    ['repeated parts, parsed ones as their JSON', [field('groupname', [1, 2]), field('groupname', '<script>y</script>'), field('groupname', { a: true })], '[1,2],[INVALID],{"a":true}'],
  ])('scans a multipart field holding %s as its text', (_label, part, scanned) => {
    expect(legacyScopesFrom({ query: {}, body: { groupname: part }, headers: {} }).form).toStrictEqual({
      entries: [['groupname', scanned]],
      failed: false,
    });
  });

  it('joins a form scope in field order, the first spelling sent kept', () => {
    expect(legacyScopesFrom({ query: {}, body: { q: '1', Q: '2', r: '3' }, headers: FORM }).form).toStrictEqual({
      entries: [['q', '1,2'], ['r', '3']],
      failed: false,
    });
  });

  it.each<[string, Record<string, unknown>, Array<[string, string]>]>([
    ['a text newfile and an empty file part', { newfile: [field('newfile', ''), file('newfile', '')] }, [['newfile', '']]],
    ['repeated values around an empty one', { v: ['a', '', 'b'] }, [['v', 'a,b']]],
    ['an empty value before a filled one', { v: ['', 'b'] }, [['v', 'b']]],
    ['a comma beside an empty file part', { v: [field('v', ','), file('v', '')] }, [['v', ',']]],
    ['names differing only in case, the empty spelling first', { newFile: '', NEWFILE: file('NEWFILE', '') }, [['newFile', '']]],
  ])('joins the form scope of %s as ACF does', (_label, body, entries) => {
    expect(legacyScopesFrom({ query: {}, body, headers: {} }).form).toStrictEqual({ entries, failed: false });
  });

  it('keeps every value of a repeated url name while the form scope skips the empty one', () => {
    const scopes = legacyScopesFrom({ query: { x: ['', 'b'] }, body: { x: ['', 'b'] }, headers: FORM, url: '/p?x=&x=b' });
    expect(scopes.url).toStrictEqual({ entries: [['x', ',b']], failed: false });
    expect(scopes.form).toStrictEqual({ entries: [['x', 'b']], failed: false });
  });

  it('has empty scopes for a request without query or body', () => {
    expect(legacyScopesFrom({ query: undefined, body: Buffer.from('raw'), headers: {} })).toStrictEqual({
      url: { entries: [], failed: false },
      form: { entries: [], failed: false },
      json: false,
      jsonBody: undefined,
    });
  });

  // Own-oracle probes (admin/index.cfm/ccategory/update/<pair>): legacy stores a path pair raw, and a posted name beside a
  // pair name the scan would rename or strip onto it.
  it.each<[string, Array<[string, string]>, Record<string, string>, Record<string, string>]>([
    ['smart quotes', [['name', 'f10-sq\u201Cq\u201D']], { name: 'f10-sq\u201Cq\u201D' }, { name: 'f10-sq\u201Cq\u201D' }],
    ['an onLoad word', [['name', 'f10-wd-onLoad']], { name: 'f10-wd-onLoad' }, { name: 'f10-wd-onLoad' }],
    ['a filtered tag', [['name', 'f10-tg-<xss>']], { name: 'f10-tg-<xss>' }, { name: 'f10-tg-<xss>' }],
    ['outer spaces', [['name', ' f10-sp ']], { name: ' f10-sp ' }, { name: ' f10-sp ' }],
    ['a dotted name beside the posted name', [['na.me', 'path']], { 'na.me': 'path', name: 'form' }, { 'na.me': 'path', name: 'form' }],
    ['an amp; name beside the posted name', [['amp;name', 'path']], { 'amp;name': 'path', name: 'form' }, { 'amp;name': 'path', name: 'form' }],
    ['a NUL name beside the posted name', [['na\0me', 'path']], { 'na\0me': 'path', name: 'form' }, { 'na\0me': 'path', name: 'form' }],
    ['a name without a name character', [['-', 'x']], { '-': 'x', q: ' y ' }, { '-': 'x', q: 'y' }],
    ['a value the relay changed, which is scanned', [['name', 'path']], { name: ' onLoad ' }, { name: '[INVALID]' }],
    ['a name the relay did not send', [['other', 'onLoad']], { name: 'onLoad' }, { name: '[INVALID]' }],
  ])('keeps a relayed path pair with %s as sent, in either scope', (_label, pairs, sent, params) => {
    const headers = { [PATH_PAIRS_HEADER.toLowerCase()]: pathPairsHeaderValue(pairs) };
    const url = legacyScopesFrom({ query: sent, body: undefined, headers }).url;
    const form = legacyScopesFrom({ query: {}, body: sent, headers: { ...FORM, ...headers } }).form;
    expect([url.failed, form.failed]).toEqual([false, false]);
    expect(legacyScopeParams(url)).toStrictEqual(Object.assign(Object.create(null) as object, params));
    expect(legacyScopeParams(form)).toStrictEqual(Object.assign(Object.create(null) as object, params));
  });

  it('keeps relayed path pairs ahead of the scanned entries, which a stripped copy of a posted name then replaces', () => {
    const headers = { ...FORM, [PATH_PAIRS_HEADER.toLowerCase()]: pathPairsHeaderValue([['Name', 'p\u201C']]) };
    expect(legacyScopesFrom({ query: {}, body: { 'na-me': 'f', name: 'p\u201C' }, headers }).form).toStrictEqual({
      entries: [['name', 'p\u201C'], ['na-me', 'f'], ['name', 'f']],
      failed: false,
    });
  });

  it('passes a file part and a JSON body as before, and scans every entry of a request without the header', () => {
    const pairs = { [PATH_PAIRS_HEADER.toLowerCase()]: pathPairsHeaderValue([['up', 'a\u201C.png'], ['q', 'onLoad']]) };
    expect(legacyScopesFrom({ query: {}, body: { up: file('up', 'a\u201C.png'), q: 'onLoad' }, headers: pairs }).form.entries).toStrictEqual([
      ['q', 'onLoad'],
      ['up', 'a\u201C.png'],
    ]);
    const json = legacyScopesFrom({ query: { q: 'onLoad' }, body: { q: 'onLoad' }, headers: { ...JSON_TYPE, ...pairs } });
    expect([json.url.entries, json.form.entries, json.jsonBody]).toStrictEqual([[['q', 'onLoad']], [], { q: 'onLoad' }]);
    expect(legacyScopesFrom({ query: { q: 'onLoad' }, body: { q: 'onLoad' }, headers: FORM })).toMatchObject({
      url: { entries: [['q', '[INVALID]']] },
      form: { entries: [['q', '[INVALID]']] },
    });
  });

  it('names path pairs in a urlencoded header value, none for no pairs', () => {
    expect(pathPairsHeaderValue([['na.me', 'a b\u201C&'], ['x', '\0']])).toBe('na.me=a+b%E2%80%9C%26&x=%00');
    expect(pathPairsHeaderValue([])).toBeUndefined();
  });
});

describe('legacyScopeParams', () => {
  it('lets a later name replace an earlier one ignoring case, under its own spelling, as route-key text', () => {
    const scope: PortcullisScope = {
      entries: [['SiteID', 'a'], ['q', '1'], ['siteid', 'b'], ['__proto__', 'p'], ['n', 5], ['o', { a: 1 }], ['u', undefined]],
      failed: false,
    };
    const params = legacyScopeParams(scope);
    expect(Object.getPrototypeOf(params)).toBeNull();
    expect(Object.entries(params)).toStrictEqual([
      ['q', '1'],
      ['siteid', 'b'],
      ['__proto__', 'p'],
      ['n', '5'],
      ['o', '{"a":1}'],
      ['u', ''],
    ]);
  });
});
