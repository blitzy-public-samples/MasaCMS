// Dispatcher header helpers, called directly and through the composed gateway over doubles.
import { LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  HOP_BY_HOP_HEADERS,
  applyLegacyHeaders,
  forwardedHeaders,
  isWebPagePath,
  isWebPageRedirect,
  normaliseWebResponseHeaders,
  withoutHeader,
} from '../../src/dispatcher/headers.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import type { TargetDouble } from '../helpers/target-double.js';

type Reply = Parameters<typeof applyLegacyHeaders>[0];
type Request = Parameters<typeof forwardedHeaders>[0];
type WebHeaders = Parameters<typeof normaliseWebResponseHeaders>[0];
type Received = TargetDouble['requests'][number];

const GENERATOR = 'Masa CMS 7.6.1';
const HSTS = 'max-age=1200';
const NEXT_CACHE_CONTROL = 'private, no-cache, no-store, max-age=0, must-revalidate';
const ADMIN_PAGE = '/admin/cusers/list?muraAction=cUsers.list';
const OPT2_PAGE = '/opt2/admin/finance/records';
const RAW = '/admin-raw/carch/loaddiff?muraAction=cArch.loaddiff';
const ACTION = '/admin-actions/cusers/update?muraAction=cUsers.update';
const ASSET = '/_next/static/chunks/main.js';
const NEXT_VARY = 'RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch';
const COOKIES = ['a=1; Path=/', 'b=2; Path=/; HttpOnly'];
const STUB_URL = '/opt2/stub/notes';
const LEGACY_URL = '/';
/** Inbound request headers: a forwarded chain, hop-by-hop ones, and one the inbound Connection lists. */
const INBOUND = {
  host: 'site.example',
  'x-forwarded-for': '203.0.113.7',
  'proxy-authorization': 'Basic eA==',
  te: 'trailers',
  'keep-alive': 'timeout=1',
  connection: 'x-req-drop',
  'x-req-drop': '1',
  'x-req-keep': '1',
};

/** A reply with only the header methods applyLegacyHeaders calls, matching names case-insensitively as Fastify does. */
function replyStub(initial: Record<string, string>): { reply: Reply; headers: Map<string, string>; added: Array<[string, string]> } {
  const headers = new Map(Object.entries(initial).map(([name, value]) => [name.toLowerCase(), value]));
  const added: Array<[string, string]> = [];
  const reply = {
    hasHeader: (name: string): boolean => headers.has(name.toLowerCase()),
    header(name: string, value: string) {
      added.push([name, value]);
      headers.set(name.toLowerCase(), value);
      return reply;
    },
  };
  return { reply: reply as unknown as Reply, headers, added };
}

/** A request with only the fields forwardedHeaders reads. */
function requestStub(fields: {
  headers?: Record<string, string | string[]>;
  ip?: string;
  remoteAddress?: string;
  protocol?: 'http' | 'https';
  host?: string;
}): Request {
  return {
    headers: fields.headers ?? {},
    ip: fields.ip ?? '10.0.0.5',
    protocol: fields.protocol ?? 'http',
    host: fields.host ?? 'gateway.internal',
    socket: { remoteAddress: fields.remoteAddress },
  } as unknown as Request;
}

describe('applyLegacyHeaders', () => {
  it.each<[string, Record<string, string>, Record<string, string>, Array<[string, string]>]>([
    [
      'adds Generator and HSTS when the reply has neither',
      {},
      { generator: GENERATOR, 'strict-transport-security': HSTS },
      [
        ['Generator', GENERATOR],
        ['Strict-Transport-Security', HSTS],
      ],
    ],
    [
      'keeps a Generator already set and adds only HSTS',
      { Generator: 'X' },
      { generator: 'X', 'strict-transport-security': HSTS },
      [['Strict-Transport-Security', HSTS]],
    ],
    [
      'changes nothing when both are already set',
      { generator: 'X', 'Strict-Transport-Security': 'max-age=0' },
      { generator: 'X', 'strict-transport-security': 'max-age=0' },
      [],
    ],
  ])('%s', (_label, initial, expected, added) => {
    const stub = replyStub(initial);
    applyLegacyHeaders(stub.reply);
    expect(Object.fromEntries(stub.headers)).toEqual(expected);
    expect(stub.added).toHaveLength(added.length);
    expect(stub.added).toEqual(expect.arrayContaining(added));
  });
});

describe('normaliseWebResponseHeaders', () => {
  it('keys headers lower-case, drops undefined values, stringifies numbers and copies lists', () => {
    const cookies = [...COOKIES];
    const out = normaliseWebResponseHeaders({ 'Content-Length': 12, 'X-Absent': undefined, 'Set-Cookie': cookies }, { path: RAW, statusCode: 200 });
    expect(out).toEqual({ 'content-length': '12', 'set-cookie': COOKIES });
    expect(out['set-cookie']).not.toBe(cookies);
  });

  it.each<[string, { path: string; statusCode: number } | undefined]>([
    ['without facts', undefined],
    ['in page mode', { path: ADMIN_PAGE, statusCode: 200 }],
    ['in raw mode', { path: RAW, statusCode: 200 }],
    ['in redirect mode', { path: ACTION, statusCode: 302 }],
  ])('drops x-nextjs-* headers in every mode (%s)', (_label, facts) => {
    const out = normaliseWebResponseHeaders({ 'X-NextJS-Cache': 'HIT', 'x-nextjs-matched-path': '/admin', 'x-kept': '1' }, facts);
    expect(out).toEqual(facts?.path === ADMIN_PAGE ? { 'x-kept': '1', 'content-type': LEGACY_HTML_CONTENT_TYPE } : { 'x-kept': '1' });
  });

  it.each<[string, string | string[], string | string[] | undefined]>([
    ['removes Next router members from Vary and keeps the rest', `${NEXT_VARY}, Accept-Encoding`, 'Accept-Encoding'],
    ['removes router members from a repeated Vary', ['rsc', 'Accept-Encoding,Cookie'], 'Accept-Encoding, Cookie'],
    ['drops Vary when only router members remain', NEXT_VARY, undefined],
    ['keeps a Vary without router members exactly as sent', 'Accept-Encoding,Cookie', 'Accept-Encoding,Cookie'],
  ])('%s', (_label, vary, expected) => {
    const out = normaliseWebResponseHeaders({ Vary: vary }, { path: RAW, statusCode: 200 });
    expect(out.vary).toEqual(expected);
    expect('vary' in out).toBe(expected !== undefined);
  });

  it.each([ADMIN_PAGE, OPT2_PAGE])('sets the legacy HTML content type on page-mode responses (%s)', (path) => {
    const out = normaliseWebResponseHeaders({ 'Content-Type': 'text/html; charset=utf-8' }, { path, statusCode: 200 });
    expect(out['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
  });

  it.each<[string, { path: string; statusCode: number } | undefined]>([
    ['raw mode', { path: RAW, statusCode: 200 }],
    ['redirect mode', { path: ACTION, statusCode: 302 }],
    ['no facts', undefined],
  ])('keeps Content-Type as sent outside page mode (%s)', (_label, facts) => {
    const out = normaliseWebResponseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }, facts);
    expect(out['content-type']).toBe('application/json; charset=utf-8');
  });

  it.each<[string, string, string | undefined]>([
    ["removes Next's own Cache-Control from page-mode responses", NEXT_CACHE_CONTROL, undefined],
    ['keeps any other Cache-Control on page-mode responses', 'no-cache', 'no-cache'],
  ])('%s', (_label, cacheControl, expected) => {
    const out = normaliseWebResponseHeaders({ 'Cache-Control': cacheControl }, { path: ADMIN_PAGE, statusCode: 200 });
    expect(out['cache-control']).toBe(expected);
  });

  it("keeps Next's Cache-Control outside page mode", () => {
    expect(normaliseWebResponseHeaders({ 'Cache-Control': NEXT_CACHE_CONTROL }, { path: RAW, statusCode: 200 })['cache-control']).toBe(
      NEXT_CACHE_CONTROL,
    );
  });

  it("rewrites a page-mode 307 to legacy's cflocation headers with the same Location and no body framing", () => {
    const out = normaliseWebResponseHeaders(
      {
        Location: './?muraAction=cUsers.list',
        'Cache-Control': NEXT_CACHE_CONTROL,
        Expires: '0',
        'Content-Length': '28',
        'Transfer-Encoding': 'chunked',
        'Set-Cookie': COOKIES,
      },
      { path: ADMIN_PAGE, statusCode: 307 },
    );
    expect(out).toEqual({
      location: './?muraAction=cUsers.list',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'content-type': LEGACY_HTML_CONTENT_TYPE,
      'set-cookie': COOKIES,
    });
  });

  it('keeps Expires, Cache-Control and framing on a 307 outside page mode', () => {
    const sent = { location: './', 'cache-control': 'max-age=5', expires: '0', 'content-length': '4' };
    expect(normaliseWebResponseHeaders(sent, { path: ACTION, statusCode: 307 })).toEqual(sent);
  });

  it('passes /_next/ responses unchanged', () => {
    const sent: WebHeaders = { 'x-nextjs-cache': 'HIT', vary: NEXT_VARY, 'cache-control': NEXT_CACHE_CONTROL, 'content-type': 'text/javascript' };
    expect(normaliseWebResponseHeaders(sent, { path: ASSET, statusCode: 307 })).toEqual(sent);
  });

  it('keeps Generator, HSTS, Content-Language, Content-Encoding, Set-Cookie, Location and Expires as sent', () => {
    const sent = {
      generator: 'Masa CMS 7.6.1',
      'strict-transport-security': HSTS,
      'content-language': 'en-US',
      'content-encoding': 'gzip',
      'set-cookie': [...COOKIES].reverse(),
      location: '/admin/?muraAction=cUsers.list',
      expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
    };
    expect(normaliseWebResponseHeaders(sent, { path: OPT2_PAGE, statusCode: 200 })).toEqual({
      ...sent,
      'content-type': LEGACY_HTML_CONTENT_TYPE,
    });
  });
});

describe('isWebPagePath and isWebPageRedirect', () => {
  it.each<[string, boolean]>([
    ['/admin/cusers/list', true],
    [ADMIN_PAGE, true],
    ['/admin/cusers/list#top', true],
    [OPT2_PAGE, true],
    ['/admin/cusers', false],
    ['/admin/cusers/list/extra', false],
    [RAW, false],
    [ACTION, false],
    ['/opt2/admin-actions/finance/submit', false],
    ['/opt2/admin/finance', false],
    [ASSET, false],
  ])('classifies %s as a page path: %s', (path, page) => {
    expect(isWebPagePath(path)).toBe(page);
  });

  it.each<[string, number, boolean]>([
    [ADMIN_PAGE, 307, true],
    [OPT2_PAGE, 307, true],
    [ADMIN_PAGE, 302, false],
    [ADMIN_PAGE, 308, false],
    [ACTION, 307, false],
  ])('treats %s answered %i as a page redirect: %s', (path, statusCode, redirect) => {
    expect(isWebPageRedirect({ path, statusCode })).toBe(redirect);
  });
});

describe('HOP_BY_HOP_HEADERS', () => {
  it('names the RFC 7230 hop-by-hop headers, lower-cased', () => {
    expect([...HOP_BY_HOP_HEADERS].sort()).toEqual(
      ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'].sort(),
    );
  });
});

describe('withoutHeader', () => {
  it('removes only the named header, matched case-insensitively, without changing the input', () => {
    const headers = { 'X-Test': '1', other: '2' };
    expect(withoutHeader(headers, 'x-test')).toEqual({ other: '2' });
    expect(headers).toEqual({ 'X-Test': '1', other: '2' });
  });

  it('removes every spelling of the name and copies a map without it unchanged', () => {
    expect(withoutHeader({ 'X-Test': '1', 'x-test': '2', other: '3' }, 'X-TEST')).toEqual({ other: '3' });
    const headers = { other: ['a', 'b'] };
    const copy = withoutHeader(headers, 'x-test');
    expect(copy).toEqual(headers);
    expect(copy).not.toBe(headers);
  });
});

describe('forwardedHeaders', () => {
  it.each<[string, Parameters<typeof requestStub>[0], Record<string, string>]>([
    [
      'starts the chain with the client address and takes proto and the original Host from the request',
      { headers: { host: 'site.example' } },
      { 'x-forwarded-for': '10.0.0.5', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'site.example' },
    ],
    [
      'appends the client address to an inbound chain',
      { headers: { host: 'site.example', 'x-forwarded-for': '203.0.113.7' }, protocol: 'https' },
      { 'x-forwarded-for': '203.0.113.7, 10.0.0.5', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'site.example' },
    ],
    [
      'joins a repeated inbound chain before appending',
      { headers: { host: 'site.example', 'x-forwarded-for': ['203.0.113.7', '198.51.100.2'] } },
      { 'x-forwarded-for': '203.0.113.7, 198.51.100.2, 10.0.0.5', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'site.example' },
    ],
    [
      'prefers the socket peer over request.ip',
      { headers: { host: 'site.example' }, ip: '203.0.113.9', remoteAddress: '127.0.0.1' },
      { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'site.example' },
    ],
    [
      'prefers an inbound proto and host',
      { headers: { host: 'gateway.run.app', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example' } },
      { 'x-forwarded-for': '10.0.0.5', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example' },
    ],
    [
      'falls back to request.host without a Host header',
      { host: 'site.example:8100' },
      { 'x-forwarded-for': '10.0.0.5', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'site.example:8100' },
    ],
  ])('%s', (_label, fields, expected) => {
    expect(forwardedHeaders(requestStub(fields))).toEqual(expected);
  });
});

describe('the composed gateway under v0001', () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await buildTestGateway({ version: 'v0001' });
  });

  afterEach(() => {
    stub().setResponse();
    gateway.legacy.setResponse();
    gateway.web.setResponse();
  });

  afterAll(async () => {
    await gateway.close();
  });

  function stub(): TargetDouble {
    const double = gateway.targets.stub;
    if (double === undefined) throw new Error('buildTestGateway started no stub double');
    return double;
  }

  it.each<[string, Record<string, string>, string]>([
    ['adds Generator and HSTS to a stub response that sets neither', {}, GENERATOR],
    ['keeps a Generator the stub sets and adds HSTS', { Generator: 'stub-x' }, 'stub-x'],
  ])('%s', async (_label, headers, generator) => {
    stub().setResponse({ headers: { 'content-type': 'text/plain', ...headers }, body: 'ok' });
    const res = await gateway.app.inject({ method: 'GET', url: STUB_URL });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
    expect(res.headers.generator).toBe(generator);
    expect(res.headers['strict-transport-security']).toBe(HSTS);
  });

  it('drops hop-by-hop headers and those Connection lists from a stub response', async () => {
    const dropped = { 'x-drop': '1', 'keep-alive': 'timeout=99', 'proxy-authenticate': 'Basic', 'proxy-authorization': 'x', te: 'trailers', upgrade: 'h2c' };
    stub().setResponse({ headers: { connection: 'x-drop', ...dropped, 'x-end': '2' }, body: 'ok' });
    const res = await gateway.app.inject({ method: 'GET', url: STUB_URL });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-end']).toBe('2');
    for (const name of Object.keys(dropped)) expect(res.headers[name], name).toBeUndefined();
  });

  it.each<[string, string, () => Received[]]>([
    ['the stub', STUB_URL, () => stub().requests],
    ['legacy', LEGACY_URL, () => gateway.legacy.requests],
  ])('sends %s X-Forwarded-* and no hop-by-hop or Connection-listed request header', async (_label, url, requests) => {
    const res = await gateway.app.inject({ method: 'GET', url, headers: INBOUND });
    expect(res.statusCode).toBe(200);
    const received = requests().findLast((request) => request.path === url);
    expect(received?.headers).toMatchObject({
      'x-forwarded-for': '203.0.113.7, 127.0.0.1',
      'x-forwarded-proto': 'http',
      'x-forwarded-host': 'site.example',
      'x-req-keep': '1',
    });
    for (const name of ['x-req-drop', 'proxy-authorization', 'te', 'keep-alive']) expect(received?.headers[name], name).toBeUndefined();
    expect(received?.headers.connection).not.toContain('x-req-drop');
  });

  it.each<[string, Record<string, string>]>([
    ['adds neither legacy header to a legacy response that sets neither', {}],
    ["passes legacy's own Generator and HSTS through unchanged", { Generator: GENERATOR, 'Strict-Transport-Security': 'max-age=600' }],
  ])('%s', async (_label, headers) => {
    gateway.legacy.setResponse({ headers: { 'content-type': 'text/html', ...headers }, body: '<html></html>' });
    const res = await gateway.app.inject({ method: 'GET', url: LEGACY_URL });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<html></html>');
    expect(res.headers.generator).toBe(headers.Generator);
    expect(res.headers['strict-transport-security']).toBe(headers['Strict-Transport-Security']);
  });

  it('passes a /_next/ asset from web through unnormalised, adding the legacy headers', async () => {
    const sent = { 'content-type': 'text/javascript', 'x-nextjs-cache': 'HIT', vary: 'RSC, Accept-Encoding', 'cache-control': NEXT_CACHE_CONTROL };
    gateway.web.setResponse({ headers: sent, body: 'x' });
    const res = await gateway.app.inject({ method: 'GET', url: ASSET });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ ...sent, generator: GENERATOR, 'strict-transport-security': HSTS });
  });
});

describe('the composed gateway under v0002', () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await buildTestGateway({ version: 'v0002' });
  });

  afterAll(async () => {
    await gateway.close();
  });

  it('normalises a page-mode web response and adds the legacy headers', async () => {
    gateway.web.setResponse({
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-nextjs-cache': 'HIT',
        vary: 'RSC, Next-Router-State-Tree, Accept-Encoding',
        'cache-control': NEXT_CACHE_CONTROL,
        'content-language': 'en-US',
      },
      body: '<html></html>',
    });
    const res = await gateway.app.inject({ method: 'GET', url: OPT2_PAGE });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<html></html>');
    expect(res.headers).toMatchObject({
      'content-type': LEGACY_HTML_CONTENT_TYPE,
      vary: 'Accept-Encoding',
      'content-language': 'en-US',
      generator: GENERATOR,
      'strict-transport-security': HSTS,
    });
    expect(res.headers['x-nextjs-cache']).toBeUndefined();
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
