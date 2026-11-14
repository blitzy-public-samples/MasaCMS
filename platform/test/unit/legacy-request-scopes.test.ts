import { describe, expect, it } from 'vitest';
import {
  isJsonContentType,
  legacyScopeParams,
  legacyScopeValue,
  legacyScopesFrom,
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

  it('has empty scopes for a request without query or body', () => {
    expect(legacyScopesFrom({ query: undefined, body: Buffer.from('raw'), headers: {} })).toStrictEqual({
      url: { entries: [], failed: false },
      form: { entries: [], failed: false },
      json: false,
      jsonBody: undefined,
    });
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
