import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cfHash } from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DROPPED_HEADERS,
  DROPPED_HEADER_PREFIXES,
  ETAG_INVALID,
  ETAG_MISMATCH,
  ETAG_OK,
  KEPT_BY_VALUE_HEADERS,
  KEPT_BY_VALUE_PREFIXES,
  normaliseEtag,
  normaliseHeaders,
  type EtagRule,
  type NormalisedHeaders,
} from '../../../src/golden/normalise/headers.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import { applyOverrides, loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import { normaliseUrl } from '../../../src/golden/normalise/values.js';

interface EtagFixture {
  body: string;
  etag: string;
  mismatchingEtag: string;
  headers: Record<string, string>;
}

type RawHeaders = Record<string, string | string[]>;

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/http/headers-etag.json', import.meta.url)), 'utf8'),
) as EtagFixture;

const LEGACY_ORIGIN = 'http://127.0.0.1:8500';
const GATEWAY_ORIGIN = 'http://127.0.0.1:8100';
const ID_A = '2B3C4D5E-6F7A-4B8C-9D0E1F2A3B4C5D6E';
const ID_B = '3C4D5E6F-7A8B-4C9D-8E0F1A2B3C4D5E6F';
const LEGACY_TOKEN = 'FIXTURE-TOKEN-1';
const GATEWAY_TOKEN = 'FIXTURE-TOKEN-2';
const HTTP_DATE = 'Tue, 30 Jun 2026 13:15:00 GMT';

const VOLATILE_NAMES = [
  'date',
  'server',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'traceparent',
  'tracestate',
  'traceresponse',
  'x-request-id',
];

const titleCase = (name: string): string =>
  name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');

const upperHex = (algorithm: 'md5' | 'sha256', bytes: Buffer): string =>
  createHash(algorithm).update(bytes).digest('hex').toUpperCase();

const editLocation = (origin: string, id: string, token: string): string =>
  `${origin}/admin/?muraAction=cArch.edit&contentid=${id}&csrf_token=${token}`;

let rules: NormaliseRules;
let md5Rule: EtagRule;

/** `headers` normalised against the committed rules with fresh id ordinals. */
function normalise(headers: RawHeaders, rawBody?: string, withRules: NormaliseRules = rules): NormalisedHeaders {
  return normaliseHeaders(headers, rawBody, createIdOrdinals(), withRules);
}

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
  md5Rule = { ...rules.headers.etag, format: '^[0-9A-F]{32}$', selfConsistency: 'uppercase-md5-of-raw-body' };
});

describe('header rule constants', () => {
  it('drops exactly the ten volatile headers, named in lower case', () => {
    expect([...DROPPED_HEADERS].sort()).toStrictEqual([...VOLATILE_NAMES].sort());
    for (const name of DROPPED_HEADERS) expect(name).toBe(name.toLowerCase());
  });

  it('drops internal headers by the x-opt2- prefix', () => {
    expect(DROPPED_HEADER_PREFIXES).toStrictEqual(['x-opt2-']);
  });

  it('declares every volatile header in the committed drop rule', () => {
    const declared = new Set(rules.headers.drop.map((name) => name.toLowerCase()));
    for (const name of DROPPED_HEADERS) expect(declared.has(name)).toBe(true);
  });

  it('compares the legacy wire headers by value', () => {
    expect([...KEPT_BY_VALUE_HEADERS].sort()).toStrictEqual([
      'content-type',
      'generator',
      'strict-transport-security',
      'www-authenticate',
      'x-http-method-override',
    ]);
    expect(KEPT_BY_VALUE_PREFIXES).toStrictEqual(['access-control-']);
  });

  it('uses distinct ETag placeholders', () => {
    expect(new Set([ETAG_OK, ETAG_MISMATCH, ETAG_INVALID]).size).toBe(3);
  });
});

describe('headers-etag fixture', () => {
  it('carries the legacy hash of its body as its ETag', () => {
    expect(cfHash(FIXTURE.body)).toBe(FIXTURE.etag);
    expect(FIXTURE.headers.ETag).toBe(FIXTURE.etag);
    expect(FIXTURE.mismatchingEtag).not.toBe(FIXTURE.etag);
  });
});

describe('normaliseHeaders', () => {
  it('normalises the fixture to sorted lower-case names with volatile headers dropped and the ETag checked', () => {
    const out = normalise(FIXTURE.headers, FIXTURE.body);
    expect(out).toStrictEqual({
      'content-type': 'application/json;charset=utf-8',
      etag: ETAG_OK,
      generator: 'Masa CMS 7.6.1',
      'strict-transport-security': 'max-age=1200',
    });
    expect(Object.keys(out)).toStrictEqual(Object.keys(out).sort());
  });

  it.each<[string, (name: string) => string]>([
    ['lower', (name) => name],
    ['upper', (name) => name.toUpperCase()],
    ['title', titleCase],
  ])('drops every volatile and x-opt2- header written in %s case', (_label, casing) => {
    const headers: RawHeaders = { Generator: 'Masa CMS 7.6.1' };
    for (const name of [...VOLATILE_NAMES, 'x-opt2-write-position', 'x-opt2-kind']) headers[casing(name)] = 'volatile';
    expect(normalise(headers)).toStrictEqual({ generator: 'Masa CMS 7.6.1' });
  });

  it.each<[string, string | string[]]>([
    ['a single cookie', `CFID=${LEGACY_TOKEN}; Path=/; HttpOnly`],
    ['several cookies', [`CFID=${LEGACY_TOKEN}; Path=/; HttpOnly`, `CFTOKEN=${GATEWAY_TOKEN}; Path=/; Secure`]],
  ])('leaves Set-Cookie with %s to the cookie rules', (_label, value) => {
    expect(normalise({ 'Set-Cookie': value, Generator: 'Masa CMS 7.6.1' })).toStrictEqual({
      generator: 'Masa CMS 7.6.1',
    });
    expect(normalise({ 'set-cookie': value })).toStrictEqual({});
  });

  it('drops a header named by a scenario override, but never an always-compared one', () => {
    const overridden = applyOverrides(
      rules,
      { dropHeaders: ['X-Debug', 'Generator', 'Access-Control-Allow-Origin'] },
      'GS-HEADERS-01',
    );
    const out = normalise(
      { 'X-Debug': 'trace on', Generator: 'Masa CMS 7.6.1', 'Access-Control-Allow-Origin': LEGACY_ORIGIN },
      undefined,
      overridden,
    );
    expect(out).toStrictEqual({ 'access-control-allow-origin': LEGACY_ORIGIN, generator: 'Masa CMS 7.6.1' });
  });

  it('keeps a volatile header the rules declare always compared', () => {
    const { compare } = rules.headers;
    const withDate: NormaliseRules = {
      ...rules,
      headers: { ...rules.headers, compare: { ...compare, alwaysCompared: [...compare.alwaysCompared, 'Date'] } },
    };
    expect(normalise({ Date: HTTP_DATE, Server: 'FIXTURE-SERVER' }, undefined, withDate)).toStrictEqual({
      date: '<ts:http-date>',
    });
  });

  it('keeps WWW-Authenticate, X-HTTP-Method-Override and Access-Control-* values exactly', () => {
    const headers: RawHeaders = {
      'WWW-Authenticate': 'Basic realm="Masa CMS"',
      'X-HTTP-Method-Override': 'PUT',
      'Access-Control-Allow-Origin': LEGACY_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, X-csrf_token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
      'Access-Control-Expose-Headers': `X-Ref-${ID_A}`,
    };
    const expected = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    expect(normalise(headers)).toStrictEqual(expected);
  });

  it('passes an unknown header with nothing volatile in it through unchanged', () => {
    expect(normalise({ 'X-Custom': 'fixture-value; mode=plain' })).toStrictEqual({
      'x-custom': 'fixture-value; mode=plain',
    });
  });

  it('normalises ids, origins and timestamps in the values of other headers', () => {
    expect(
      normalise({
        'Content-Disposition': `attachment; filename=${ID_A}.csv`,
        'Last-Modified': HTTP_DATE,
        'X-Note': `see ${LEGACY_ORIGIN}/x?id=${ID_A}`,
      }),
    ).toStrictEqual({
      'content-disposition': 'attachment; filename=<id:1>.csv',
      'last-modified': '<ts:http-date>',
      'x-note': 'see <origin>/x?id=<id:1>',
    });
  });

  it('numbers ids in sorted header-name order, whatever the recorded order', () => {
    const expected = { 'x-a': '<id:1>', 'x-b': '<id:2>' };
    expect(normalise({ 'X-B': ID_B, 'X-A': ID_A })).toStrictEqual(expected);
    expect(normalise({ 'X-A': ID_A, 'X-B': ID_B })).toStrictEqual(expected);
  });

  it('masks a non-empty token header and keeps an empty one visible', () => {
    expect(normalise({ 'X-csrf_token': LEGACY_TOKEN, 'X-CSRF_TOKEN_EXPIRES': '' })).toStrictEqual({
      'x-csrf_token': '<token>',
      'x-csrf_token_expires': '',
    });
  });

  it('merges a name recorded in several casings into one list in input order', () => {
    expect(normalise({ 'X-Custom': 'first', 'x-custom': ['second', `third ${ID_A}`] })).toStrictEqual({
      'x-custom': ['first', 'second', 'third <id:1>'],
    });
    expect(normalise({ Vary: ['Origin', 'Accept-Encoding'] })).toStrictEqual({ vary: ['Origin', 'Accept-Encoding'] });
  });

  it('normalises Location as normaliseUrl does a body URL', () => {
    const location = editLocation(LEGACY_ORIGIN, ID_A, LEGACY_TOKEN);
    const out = normalise({ Location: location });
    expect(out.location).toBe(normaliseUrl(location, createIdOrdinals(), rules));
    expect(out.location).toBe('<origin>/admin/?muraAction=carch.edit&contentid=<id:1>&csrf_token=<token>');
    expect(normalise({ Location: '/opt2/files/report.csv' })).toStrictEqual({ location: '<url>' });
  });

  it.each<[string, string, string]>([
    ['legacy origin', LEGACY_ORIGIN, ID_A],
    ['gateway origin', GATEWAY_ORIGIN, ID_B],
    ['localhost alias of the legacy origin', 'http://localhost:8500', ID_B],
  ])('normalises a Location on the %s to the same value', (_label, origin, id) => {
    const reference = normalise({ Location: editLocation(LEGACY_ORIGIN, ID_A, LEGACY_TOKEN) });
    expect(normalise({ location: editLocation(origin, id, GATEWAY_TOKEN) })).toStrictEqual(reference);
  });

  it.each<[string, RawHeaders, string]>([
    ['the shunter JSON type', { 'Content-Type': 'application/x-shunter+json;charset=utf-8' }, ETAG_OK],
    ['an upper-case JSON type', { 'Content-Type': 'Application/JSON' }, ETAG_OK],
    ['a repeated content type, by its first value', { 'Content-Type': ['application/json', 'text/plain'] }, ETAG_OK],
    ['an HTML type', { 'Content-Type': 'text/html;charset=utf-8' }, FIXTURE.etag],
    ['no content type', {}, FIXTURE.etag],
  ])('checks the ETag against the body for %s', (_label, contentType, expected) => {
    expect(normalise({ ...contentType, ETag: FIXTURE.etag }, FIXTURE.body).etag).toBe(expected);
  });

  it('marks an ETag that is not the hash of its own body', () => {
    const out = normalise({ 'Content-Type': 'application/json', ETag: FIXTURE.mismatchingEtag }, FIXTURE.body);
    expect(out.etag).toBe(ETAG_MISMATCH);
  });

  it('normalises a legacy golden response and its gateway replay to the same headers', () => {
    const legacyBody = `{"data":{"contentid":"${ID_A}"}}`;
    const gatewayBody = `{"data":{"contentid":"${ID_B}"}}`;
    const golden: RawHeaders = {
      'Content-Type': 'application/json;charset=utf-8',
      Date: HTTP_DATE,
      Server: 'FIXTURE-SERVER',
      'Content-Length': String(legacyBody.length),
      Connection: 'keep-alive',
      ETag: cfHash(legacyBody),
      Generator: 'Masa CMS 7.6.1',
      Location: editLocation(LEGACY_ORIGIN, ID_A, LEGACY_TOKEN),
      'Set-Cookie': [`CFID=${LEGACY_TOKEN}; Path=/; HttpOnly`],
      'Strict-Transport-Security': 'max-age=1200',
      'X-Request-Id': 'fixture-request-0001',
    };
    const traceparent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
    const replay: RawHeaders = {
      'content-type': 'application/json;charset=utf-8',
      date: 'Wed, 01 Jul 2026 09:00:00 GMT',
      'transfer-encoding': 'chunked',
      'keep-alive': 'timeout=5',
      etag: cfHash(gatewayBody),
      generator: 'Masa CMS 7.6.1',
      location: editLocation(GATEWAY_ORIGIN, ID_B, GATEWAY_TOKEN),
      'set-cookie': `CFID=${GATEWAY_TOKEN}; Path=/; HttpOnly`,
      'strict-transport-security': 'max-age=1200',
      traceparent,
      tracestate: 'opt2=fixture',
      traceresponse: traceparent,
      'x-opt2-write-position': 'people=1024',
      'x-request-id': 'fixture-request-0002',
    };

    const left = normaliseHeaders(golden, legacyBody, createIdOrdinals(), rules);
    const right = normaliseHeaders(replay, gatewayBody, createIdOrdinals(), rules);
    expect(right).toStrictEqual(left);
    expect(left).toStrictEqual({
      'content-type': 'application/json;charset=utf-8',
      etag: ETAG_OK,
      generator: 'Masa CMS 7.6.1',
      location: '<origin>/admin/?muraAction=carch.edit&contentid=<id:1>&csrf_token=<token>',
      'strict-transport-security': 'max-age=1200',
    });
  });
});

describe('normaliseEtag', () => {
  it('returns ETAG_OK for the legacy hash of the body, with or without the rule', () => {
    expect(normaliseEtag(FIXTURE.etag, FIXTURE.body)).toBe(ETAG_OK);
    expect(normaliseEtag(FIXTURE.etag, FIXTURE.body, rules.headers.etag)).toBe(ETAG_OK);
  });

  it('returns ETAG_MISMATCH for a well-formed hash of another body', () => {
    expect(normaliseEtag(FIXTURE.mismatchingEtag, FIXTURE.body)).toBe(ETAG_MISMATCH);
    expect(normaliseEtag(FIXTURE.mismatchingEtag, FIXTURE.body, rules.headers.etag)).toBe(ETAG_MISMATCH);
    expect(normaliseEtag(cfHash(`${FIXTURE.body} `), FIXTURE.body, rules.headers.etag)).toBe(ETAG_MISMATCH);
  });

  it('returns ETAG_MISMATCH for a hash taken over the Latin-1 bytes of a non-ASCII body', () => {
    const latin1 = upperHex('sha256', Buffer.from(FIXTURE.body, 'latin1'));
    expect(Buffer.byteLength(FIXTURE.body, 'utf8')).toBeGreaterThan(FIXTURE.body.length);
    expect(normaliseEtag(latin1, FIXTURE.body, rules.headers.etag)).toBe(ETAG_MISMATCH);
  });

  it.each<[string, string]>([
    ['a short token', 'abc'],
    ['31 hex digits', 'A'.repeat(31)],
    ['63 hex digits', FIXTURE.etag.slice(0, 63)],
    ['65 hex digits', `${FIXTURE.etag}0`],
    ['lower-case hex', FIXTURE.etag.toLowerCase()],
    ['an empty value', ''],
    ['a 32-digit MD5', cfHash(FIXTURE.body, 'CFMX_COMPAT')],
    ['a weak validator', `W/"${FIXTURE.etag}"`],
  ])('returns ETAG_INVALID for %s', (_label, value) => {
    expect(normaliseEtag(value, FIXTURE.body)).toBe(ETAG_INVALID);
    expect(normaliseEtag(value, FIXTURE.body, rules.headers.etag)).toBe(ETAG_INVALID);
  });

  it('treats an absent body as empty', () => {
    expect(normaliseEtag(cfHash(''), undefined, rules.headers.etag)).toBe(ETAG_OK);
    expect(normaliseEtag(FIXTURE.etag, undefined)).toBe(ETAG_MISMATCH);
  });

  it.each<[string, string, string]>([
    ['the legacy hash', `"${FIXTURE.etag}"`, `"${ETAG_OK}"`],
    ['another body hash', `"${FIXTURE.mismatchingEtag}"`, `"${ETAG_MISMATCH}"`],
    ['nothing', '""', `"${ETAG_INVALID}"`],
  ])('keeps the quotes around the placeholder of a quoted ETag holding %s', (_label, value, expected) => {
    expect(normaliseEtag(value, FIXTURE.body, rules.headers.etag)).toBe(expected);
  });

  it('treats a lone double quote as an unquoted malformed ETag', () => {
    expect(normaliseEtag('"', FIXTURE.body)).toBe(ETAG_INVALID);
  });

  it('returns the placeholders a rule declares', () => {
    const custom: EtagRule = { ...rules.headers.etag, placeholder: '<etag:same>', mismatchPlaceholder: '<etag:other>' };
    expect(normaliseEtag(FIXTURE.etag, FIXTURE.body, custom)).toBe('<etag:same>');
    expect(normaliseEtag(FIXTURE.mismatchingEtag, FIXTURE.body, custom)).toBe('<etag:other>');
    expect(normaliseEtag('abc', FIXTURE.body, custom)).toBe(ETAG_INVALID);
  });

  describe('under an MD5 self-consistency rule', () => {
    it('accepts the CFMX_COMPAT MD5 of the body, taken over its Latin-1 bytes', () => {
      const md5 = cfHash(FIXTURE.body, 'CFMX_COMPAT');
      expect(md5).toBe(upperHex('md5', Buffer.from(FIXTURE.body, 'latin1')));
      expect(normaliseEtag(md5, FIXTURE.body, md5Rule)).toBe(ETAG_OK);
    });

    it('returns ETAG_MISMATCH for an MD5 over the UTF-8 bytes of a non-ASCII body', () => {
      expect(normaliseEtag(upperHex('md5', Buffer.from(FIXTURE.body, 'utf8')), FIXTURE.body, md5Rule)).toBe(
        ETAG_MISMATCH,
      );
    });

    it.each<[string, string]>([
      ['the SHA-256 legacy hash', FIXTURE.etag],
      ['31 hex digits', 'A'.repeat(31)],
      ['lower-case hex', cfHash(FIXTURE.body, 'CFMX_COMPAT').toLowerCase()],
    ])('returns ETAG_INVALID for %s', (_label, value) => {
      expect(normaliseEtag(value, FIXTURE.body, md5Rule)).toBe(ETAG_INVALID);
    });
  });
});
