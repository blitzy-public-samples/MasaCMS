import { readFileSync } from 'node:fs';
import { CookieJar } from 'tough-cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpSession,
  HttpRequestError,
  type FetchLike,
  type HttpRequest,
  type MultipartFile,
} from '../../src/lib/http.js';

// No listener on this port; every request goes to an injected fetch stub.
const BASE = 'http://127.0.0.1:8500/';
const SET_COOKIE_PREFIX = 'Set-Cookie: ';

/** Set-Cookie values of the fixture, one array per blank-line-separated block. */
const SET_COOKIE_BLOCKS: string[][] = readFileSync(
  new URL('../fixtures/http/set-cookie-login.txt', import.meta.url),
  'utf8',
)
  .split(/\r?\n\s*\r?\n/)
  .map((block) =>
    block
      .split(/\r?\n/)
      .filter((line) => line.startsWith(SET_COOKIE_PREFIX))
      .map((line) => line.slice(SET_COOKIE_PREFIX.length)),
  )
  .filter((block) => block.length > 0);

const [LOGIN = [], LOGOUT = [], RELOGIN = []] = SET_COOKIE_BLOCKS;

/** `name=value` of a Set-Cookie line, as a Cookie header carries it. */
function pair(line: string): string {
  return line.split(';', 1)[0]?.trim() ?? '';
}

/** Cookie header a jar holding exactly `lines` sends. */
function cookieOf(lines: readonly string[]): string {
  return lines.map(pair).join('; ');
}

interface Call {
  url: string;
  init: RequestInit;
}

interface Reply {
  status?: number;
  headers?: [string, string][];
  body?: ConstructorParameters<typeof Response>[0];
}

function reply({ status = 200, headers = [], body = null }: Reply = {}): Response {
  return new Response(body, { status, headers });
}

function setCookieHeaders(lines: readonly string[]): [string, string][] {
  return lines.map((line) => ['set-cookie', line]);
}

/** Fetch stub answering each call with the next scripted response, recording every call; rejects on an aborted signal as fetch does. */
function scripted(...replies: Response[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    init.signal?.throwIfAborted();
    const next = replies.shift();
    if (next === undefined) throw new Error(`Unscripted request: ${init.method ?? ''} ${url}`);
    return next;
  };
  return { fetch, calls };
}

/** Fetch stub answering the first `redirects` calls with 302 to `/r<n>`, then 200. */
function redirectChain(redirects: number): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return calls.length <= redirects ? reply({ status: 302, headers: [['location', `/r${calls.length}`]] }) : reply();
  };
  return { fetch, calls };
}

/** Fetch stub running the next step per call and ignoring the signal, as a misbehaving fetch would. */
function stepped(...steps: (() => Promise<Response>)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = steps.shift();
    return next === undefined ? Promise.reject(new Error(`Unscripted request: ${url}`)) : next();
  };
  return { fetch, calls };
}

const never = (): Promise<Response> => new Promise<Response>(() => undefined);

/** Step answering `make()` after `ms`. */
function after(ms: number, make: () => Response): () => Promise<Response> {
  return () => new Promise<Response>((resolve) => setTimeout(() => resolve(make()), ms));
}

/** Body stream holding one chunk that never ends; `cancelled()` gives the reason it was cancelled with. */
function endlessBody(): { stream: ReadableStream<Uint8Array>; cancelled: () => unknown } {
  let reason: unknown;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
    },
    cancel(why) {
      reason = why;
    },
  });
  return { stream, cancelled: () => reason };
}

/** The value `promise` rejects with; fails when it resolves. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('expected a rejection'),
    (err: unknown) => err,
  );
}

/** The value `fn` throws; fails when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return expect.unreachable('expected a throw');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('set-cookie-login fixture', () => {
  it('holds the login, logout and second-login blocks', () => {
    expect(SET_COOKIE_BLOCKS.map((block) => block.length)).toEqual([4, 1, 3]);
  });
});

describe('createHttpSession request building', () => {
  it.each<{ label: string; baseUrl: string; path?: string; query?: HttpRequest['query']; expected: string }>([
    {
      label: 'a relative path against the base URL',
      baseUrl: 'http://127.0.0.1:8500/admin/',
      path: 'index.cfm',
      expected: 'http://127.0.0.1:8500/admin/index.cfm',
    },
    { label: 'the base URL when no path is given', baseUrl: BASE, expected: BASE },
    {
      label: 'an absolute URL over the base URL',
      baseUrl: BASE,
      path: 'http://localhost:8500/_api/json/v1/default/content',
      expected: 'http://localhost:8500/_api/json/v1/default/content',
    },
    {
      label: 'query values appended, arrays repeated',
      baseUrl: BASE,
      path: '/admin/',
      query: { muraAction: 'cUsers.list', siteid: ['default', 'tenant-a'] },
      expected: `${BASE}admin/?muraAction=cUsers.list&siteid=default&siteid=tenant-a`,
    },
    {
      label: "the path's own query kept verbatim before the extra query",
      baseUrl: BASE,
      path: '/x?q=a%20b',
      query: { k: 'v w' },
      expected: `${BASE}x?q=a%20b&k=v+w`,
    },
    { label: 'an empty query as no query', baseUrl: BASE, path: '/x?q=1', query: {}, expected: `${BASE}x?q=1` },
    { label: 'an empty array as no query', baseUrl: BASE, path: '/x', query: { k: [] }, expected: `${BASE}x` },
  ])('requests $label', async ({ baseUrl, path, query, expected }) => {
    const { fetch, calls } = scripted(reply());
    const result = await createHttpSession({ baseUrl, fetch }).request({
      ...(path === undefined ? {} : { path }),
      ...(query === undefined ? {} : { query }),
    });

    expect(calls.map((call) => call.url)).toEqual([expected]);
    expect(result.url).toBe(expected);
    expect(result.hops.map((hop) => hop.url)).toEqual([expected]);
  });

  it('sends GET by default, with manual redirects, no body and a signal following the caller signal', async () => {
    const { fetch, calls } = scripted(reply());
    const controller = new AbortController();
    await createHttpSession({ baseUrl: BASE, fetch }).request({ path: '/', signal: controller.signal });

    const { signal, ...init } = calls[0]?.init ?? {};
    expect(init).toEqual({ method: 'GET', headers: {}, body: undefined, redirect: 'manual' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it.each<{ label: string; abortBeforeCall: number }>([
    { label: 'before the first request', abortBeforeCall: 0 },
    { label: 'while following a redirect', abortBeforeCall: 1 },
  ])('rejects when the caller signal aborts $label', async ({ abortBeforeCall }) => {
    const controller = new AbortController();
    const { fetch, calls } = scripted(reply({ status: 302, headers: [['location', '/next']] }), reply());
    const aborting: FetchLike = async (url, init) => {
      if (calls.length === abortBeforeCall) controller.abort();
      return fetch(url, init);
    };

    await expect(
      createHttpSession({ baseUrl: BASE, fetch: aborting }).get('/', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(abortBeforeCall + 1);
    expect(calls.every((call) => call.init.signal?.aborted === true)).toBe(true);
  });

  it('upper-cases the method and lower-cases header names, request headers over defaults', async () => {
    const { fetch, calls } = scripted(reply());
    const session = createHttpSession({
      baseUrl: BASE,
      fetch,
      defaultHeaders: { 'User-Agent': 'opt2-harness', Accept: 'text/html' },
    });
    const result = await session.request({ method: 'patch', path: '/', headers: { ACCEPT: 'application/json', 'X-Trace': '1' } });

    const expected = { 'user-agent': 'opt2-harness', accept: 'application/json', 'x-trace': '1' };
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(calls[0]?.init.headers).toEqual(expected);
    expect(result.hops[0]).toMatchObject({ method: 'PATCH', requestHeaders: expected });
  });

  it('get and post set the method and path', async () => {
    const { fetch, calls } = scripted(reply(), reply());
    const session = createHttpSession({ baseUrl: BASE, fetch });
    await session.get('/admin/', { query: { muraAction: 'clogin.main' } });
    await session.post('/admin/index.cfm', { form: { muraAction: 'cLogin.login' } });

    expect(calls.map((call) => [call.init.method, call.url, call.init.body])).toEqual([
      ['GET', `${BASE}admin/?muraAction=clogin.main`, undefined],
      ['POST', `${BASE}admin/index.cfm`, 'muraAction=cLogin.login'],
    ]);
  });
});

describe('createHttpSession request bodies', () => {
  const bytes = new TextEncoder().encode('raw');

  it.each<{ label: string; req: HttpRequest; body: string | Uint8Array; contentType?: string }>([
    {
      label: 'a form record, arrays repeated',
      req: { form: { a: ['1', '2'], b: 'x y' } },
      body: 'a=1&a=2&b=x+y',
      contentType: 'application/x-www-form-urlencoded',
    },
    {
      label: 'URLSearchParams as given',
      req: { form: new URLSearchParams([['z', '1'], ['a', '2']]) },
      body: 'z=1&a=2',
      contentType: 'application/x-www-form-urlencoded',
    },
    { label: 'JSON', req: { json: { siteid: 'default', ids: [1] } }, body: '{"siteid":"default","ids":[1]}', contentType: 'application/json' },
    { label: 'a raw string without a content type', req: { body: 'plain' }, body: 'plain' },
    { label: 'raw bytes without a content type', req: { body: bytes }, body: bytes },
  ])('encodes $label', async ({ req, body, contentType }) => {
    const { fetch, calls } = scripted(reply());
    const result = await createHttpSession({ baseUrl: BASE, fetch }).request({ ...req, method: 'POST' });

    expect(calls[0]?.init.body).toEqual(body);
    expect(result.hops[0]?.requestHeaders['content-type']).toBe(contentType);
  });

  it('lets a caller content type override the encoded one', async () => {
    const { fetch, calls } = scripted(reply());
    await createHttpSession({ baseUrl: BASE, fetch }).request({
      method: 'POST',
      json: {},
      headers: { 'Content-Type': 'application/vnd.api+json' },
    });

    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/vnd.api+json' });
  });

  const notes: MultipartFile = {
    name: 'file',
    filename: 'notes.txt',
    contentType: 'text/plain',
    data: new TextEncoder().encode('hello'),
  };

  it.each<{ label: string; multipart: NonNullable<HttpRequest['multipart']>; fields: [string, string][]; files: string[] }>([
    {
      label: 'fields and files',
      multipart: { fields: { siteid: 'default', tags: ['a', 'b'] }, files: [notes] },
      fields: [['siteid', 'default'], ['tags', 'a'], ['tags', 'b']],
      files: ['file:notes.txt:text/plain:hello'],
    },
    { label: 'no parts', multipart: {}, fields: [], files: [] },
  ])('encodes multipart with $label as bytes under the encoder boundary', async ({ multipart, fields, files }) => {
    const { fetch, calls } = scripted(reply());
    const result = await createHttpSession({ baseUrl: BASE, fetch }).request({ method: 'POST', multipart });

    const contentType = result.hops[0]?.requestHeaders['content-type'] ?? '';
    const body = calls[0]?.init.body;
    expect(contentType).toMatch(/^multipart\/form-data; boundary=\S+$/);
    expect(body).toBeInstanceOf(Uint8Array);

    const parsed = await new Response(body as Uint8Array, { headers: { 'content-type': contentType } }).formData();
    const seenFields: [string, string][] = [];
    const seenFiles: string[] = [];
    for (const [name, value] of parsed.entries()) {
      if (typeof value === 'string') seenFields.push([name, value]);
      else seenFiles.push(`${name}:${value.name}:${value.type}:${await value.text()}`);
    }
    expect(seenFields).toEqual(fields);
    expect(seenFiles).toEqual(files);
  });

  it.each<{ req: HttpRequest; kinds: string }>([
    { req: { form: { a: '1' }, json: {} }, kinds: 'form, json' },
    { req: { json: {}, multipart: {}, body: 'x' }, kinds: 'json, multipart, body' },
  ])('rejects more than one body kind: $kinds', async ({ req, kinds }) => {
    const { fetch, calls } = scripted();

    await expect(createHttpSession({ baseUrl: BASE, fetch }).request(req)).rejects.toThrow(
      `HttpRequest accepts one body kind, got: ${kinds}`,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('createHttpSession responses', () => {
  it('exposes status, lower-cased headers, bytes, text and json', async () => {
    const payload = '{"apiversion":"v1","data":{"id":1}}';
    const { fetch } = scripted(
      reply({
        status: 201,
        headers: [['Content-Type', 'application/json; charset=utf-8'], ['X-Custom', 'v'], ...setCookieHeaders(LOGIN)],
        body: payload,
      }),
    );
    const result = await createHttpSession({ baseUrl: BASE, fetch }).get('/_api/json/v1/default/');

    expect(result.status).toBe(201);
    expect(result.headers).toEqual({ 'content-type': 'application/json; charset=utf-8', 'x-custom': 'v', 'set-cookie': LOGIN });
    expect(result.hops[0]?.responseHeaders).toEqual(result.headers);
    expect(result.bytes).toEqual(new TextEncoder().encode(payload));
    expect(result.text).toBe(payload);
    expect(result.json<{ data: { id: number } }>().data.id).toBe(1);
  });

  it('throws HttpRequestError from json() on a non-JSON body, keeping the parse error as the cause only', async () => {
    const { fetch } = scripted(reply({ headers: [['content-type', 'text/html']], body: '<html>Masa</html>' }));
    const result = await createHttpSession({ baseUrl: BASE, fetch }).get('/');

    expect(result.text).toBe('<html>Masa</html>');
    const err = thrownBy(() => result.json());
    expect(err).toBeInstanceOf(HttpRequestError);
    expect(err).toMatchObject({
      name: 'HttpRequestError',
      message: 'response body is not JSON: GET http://127.0.0.1:8500/ (hop 1, status 200)',
      method: 'GET',
      target: BASE,
      hop: 1,
      status: 200,
    });
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
    expect((err as Error).message).not.toMatch(/html|Masa/);
  });

  it('gives set-cookie as an empty array when the response sets none', async () => {
    const { fetch } = scripted(reply());
    const result = await createHttpSession({ baseUrl: BASE, fetch }).get('/');

    expect(result.headers['set-cookie']).toEqual([]);
    expect(result.hops[0]?.setCookie).toEqual([]);
  });

  it.each<{ label: string; contentType?: string; body: number[]; text: string }>([
    { label: 'the declared charset', contentType: 'text/html; charset=iso-8859-1', body: [0x63, 0x61, 0x66, 0xe9], text: 'café' },
    { label: 'a quoted charset', contentType: 'text/plain; Charset="windows-1252"', body: [0x80], text: '€' },
    { label: 'UTF-8 without a charset', contentType: 'text/plain', body: [0x63, 0x61, 0x66, 0xc3, 0xa9], text: 'café' },
    { label: 'UTF-8 for an unknown charset label', contentType: 'text/plain; charset=x-unknown', body: [0xc3, 0xa9], text: 'é' },
    { label: 'UTF-8 without a content type', body: [0xc3, 0xa9], text: 'é' },
  ])('decodes text with $label', async ({ contentType, body, text }) => {
    const { fetch } = scripted(
      reply({ headers: contentType === undefined ? [] : [['content-type', contentType]], body: new Uint8Array(body) }),
    );
    const result = await createHttpSession({ baseUrl: BASE, fetch }).get('/');

    expect(result.text).toBe(text);
    expect(Array.from(result.bytes)).toEqual(body);
  });
});

describe('createHttpSession cookies', () => {
  it('stores the login Set-Cookie lines and sends them on the next request', async () => {
    const { fetch, calls } = scripted(reply({ headers: setCookieHeaders(LOGIN) }), reply());
    const session = createHttpSession({ baseUrl: BASE, fetch });
    const login = await session.get('/admin/');
    await session.get('/admin/');

    expect(login.hops[0]?.setCookie).toEqual(LOGIN);
    expect(calls[0]?.init.headers).toEqual({});
    expect(calls[1]?.init.headers).toEqual({ cookie: cookieOf(LOGIN) });
    expect(await session.cookieHeader()).toBe(cookieOf(LOGIN));
  });

  it('keeps every raw line in the hop, including one the jar rejects', async () => {
    const { fetch } = scripted(reply({ headers: setCookieHeaders(LOGIN) }));
    const session = createHttpSession({ baseUrl: 'http://localhost:8500/', fetch });
    const result = await session.get('/admin/');

    const accepted = LOGIN.filter((line) => !/Domain=127\.0\.0\.1/i.test(line));
    expect(accepted).toHaveLength(LOGIN.length - 1);
    expect(result.hops[0]?.setCookie).toEqual(LOGIN);
    expect(await session.cookieHeader()).toBe(cookieOf(accepted));
  });

  it('drops the cookie a logout expires and keeps the unrotated session values on the second login', async () => {
    const { fetch } = scripted(
      reply({ headers: setCookieHeaders(LOGIN) }),
      reply({ headers: setCookieHeaders(LOGOUT) }),
      reply({ headers: setCookieHeaders(RELOGIN) }),
    );
    const session = createHttpSession({ baseUrl: BASE, fetch });
    const expiredName = pair(LOGOUT[0] ?? '').split('=', 1)[0] ?? '';
    const remaining = LOGIN.filter((line) => pair(line).split('=', 1)[0] !== expiredName);

    await session.post('/admin/index.cfm');
    expect(await session.cookieHeader()).toBe(cookieOf(LOGIN));
    await session.get('/admin/', { query: { muraAction: 'clogin.logout' } });
    expect(remaining).toHaveLength(LOGIN.length - 1);
    expect(await session.cookieHeader()).toBe(cookieOf(remaining));
    await session.post('/admin/index.cfm');
    const relogin = await session.cookieHeader();
    expect(relogin).toBe(cookieOf(RELOGIN));
    expect(relogin).toBe(cookieOf(remaining));
  });

  it('sends a caller Cookie header instead of the jar on every hop', async () => {
    const explicit = pair(RELOGIN[2] ?? '');
    const { fetch, calls } = scripted(
      reply({ status: 302, headers: [['location', '/admin/'], ...setCookieHeaders(LOGIN)] }),
      reply(),
    );
    await createHttpSession({ baseUrl: BASE, fetch }).get('/admin/index.cfm', { headers: { Cookie: explicit } });

    expect(calls.map((call) => call.init.headers)).toEqual([{ cookie: explicit }, { cookie: explicit }]);
  });

  it('uses a provided jar', async () => {
    const jar = new CookieJar();
    await jar.setCookie(LOGIN[0] ?? '', BASE);
    const { fetch, calls } = scripted(reply());
    const session = createHttpSession({ baseUrl: BASE, fetch, jar });
    await session.get('/');

    expect(session.jar).toBe(jar);
    expect(calls[0]?.init.headers).toEqual({ cookie: pair(LOGIN[0] ?? '') });
  });

  it('gives each session without a jar its own empty one', async () => {
    const { fetch, calls } = scripted(reply({ headers: setCookieHeaders(LOGIN) }), reply());
    const first = createHttpSession({ baseUrl: BASE, fetch });
    const second = createHttpSession({ baseUrl: BASE, fetch });
    await first.get('/');
    await second.get('/');

    expect(first.jar).not.toBe(second.jar);
    expect(calls[1]?.init.headers).toEqual({});
    expect(await first.cookieHeader()).toBe(cookieOf(LOGIN));
    expect(await second.cookieHeader()).toBe('');
  });

  it.each<{ label: string; url?: string; expected: boolean }>([
    { label: 'the base URL by default', expected: false },
    { label: 'a relative URL against the base URL', url: 'admin/index.cfm', expected: true },
    { label: 'an absolute URL', url: `${BASE}admin/`, expected: true },
  ])('cookieHeader resolves $label', async ({ url, expected }) => {
    const scoped = (LOGIN[0] ?? '').replace('path=/', 'path=/admin/');
    const { fetch } = scripted(reply({ headers: setCookieHeaders([scoped]) }));
    const session = createHttpSession({ baseUrl: BASE, fetch });
    await session.get('/admin/');

    expect(await session.cookieHeader(url)).toBe(expected ? pair(scoped) : '');
  });
});

describe('createHttpSession redirects', () => {
  it('follows a login redirect chain, recording each hop and sending the cookies it set', async () => {
    const { fetch, calls } = scripted(
      reply({ status: 302, headers: [['location', './'], ...setCookieHeaders(LOGIN)], body: 'moved' }),
      reply({ body: 'Site Content' }),
    );
    const session = createHttpSession({ baseUrl: BASE, fetch, defaultHeaders: { 'User-Agent': 'opt2-harness' } });
    const result = await session.post('/admin/index.cfm', { form: { muraAction: 'cLogin.login' } });

    expect(calls.map((call) => [call.init.method, call.url, call.init.body])).toEqual([
      ['POST', `${BASE}admin/index.cfm`, 'muraAction=cLogin.login'],
      ['GET', `${BASE}admin/`, undefined],
    ]);
    expect(result).toMatchObject({ status: 200, url: `${BASE}admin/`, text: 'Site Content' });
    expect(result.hops).toHaveLength(2);
    expect(result.hops[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}admin/index.cfm`,
      status: 302,
      location: './',
      setCookie: LOGIN,
      requestHeaders: { 'user-agent': 'opt2-harness', 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(result.hops[1]).toEqual({
      method: 'GET',
      url: `${BASE}admin/`,
      status: 200,
      setCookie: [],
      requestHeaders: { 'user-agent': 'opt2-harness', cookie: cookieOf(LOGIN) },
      responseHeaders: { 'content-type': 'text/plain;charset=UTF-8', 'set-cookie': [] },
    });
  });

  it('attributes each Set-Cookie line to its own hop and sends the jar as it stands at each hop', async () => {
    const { fetch, calls } = scripted(
      reply({ status: 302, headers: [['location', '/admin/?muraAction=clogin.logout'], ...setCookieHeaders(LOGIN)] }),
      reply({ status: 302, headers: [['location', '/admin/?muraAction=clogin.main'], ...setCookieHeaders(LOGOUT)] }),
      reply({ body: 'login form' }),
    );
    const remaining = LOGIN.filter((line) => !line.startsWith('userid='));
    const result = await createHttpSession({ baseUrl: BASE, fetch }).get('/admin/');

    expect(result).toMatchObject({ status: 200, url: `${BASE}admin/?muraAction=clogin.main` });
    expect(result.hops.map(({ status, location, setCookie }) => ({ status, location, setCookie }))).toEqual([
      { status: 302, location: '/admin/?muraAction=clogin.logout', setCookie: LOGIN },
      { status: 302, location: '/admin/?muraAction=clogin.main', setCookie: LOGOUT },
      { status: 200, location: undefined, setCookie: [] },
    ]);
    expect(calls.map((call) => (call.init.headers as Record<string, string>).cookie)).toEqual([
      undefined,
      cookieOf(LOGIN),
      cookieOf(remaining),
    ]);
  });

  const bodyHeaders = {
    'Content-Language': 'en',
    'Content-Encoding': 'identity',
    'Content-Location': '/form',
    'X-Keep': '1',
  };

  it.each<{ status: number; method: string; next: string; keepsBody: boolean }>([
    { status: 301, method: 'POST', next: 'GET', keepsBody: false },
    { status: 302, method: 'POST', next: 'GET', keepsBody: false },
    { status: 303, method: 'POST', next: 'GET', keepsBody: false },
    { status: 303, method: 'PUT', next: 'GET', keepsBody: false },
    { status: 303, method: 'DELETE', next: 'GET', keepsBody: false },
    { status: 301, method: 'PUT', next: 'PUT', keepsBody: true },
    { status: 302, method: 'PATCH', next: 'PATCH', keepsBody: true },
    { status: 302, method: 'DELETE', next: 'DELETE', keepsBody: true },
    { status: 303, method: 'GET', next: 'GET', keepsBody: true },
    { status: 303, method: 'HEAD', next: 'HEAD', keepsBody: true },
    { status: 301, method: 'GET', next: 'GET', keepsBody: true },
    { status: 302, method: 'HEAD', next: 'HEAD', keepsBody: true },
    { status: 307, method: 'POST', next: 'POST', keepsBody: true },
    { status: 308, method: 'PUT', next: 'PUT', keepsBody: true },
  ])('follows $status after $method as $next', async ({ status, method, next, keepsBody }) => {
    const { fetch, calls } = scripted(reply({ status, headers: [['location', '/next']] }), reply());
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const result = await createHttpSession({ baseUrl: BASE, fetch }).request({
      method,
      path: '/start',
      headers: bodyHeaders,
      ...(hasBody ? { form: { a: '1' } } : {}),
    });

    const [first, second] = result.hops;
    expect(calls.map((call) => call.init.method)).toEqual([method, next]);
    expect(calls[1]?.url).toBe(`${BASE}next`);
    if (keepsBody) {
      expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
      expect(second?.requestHeaders).toEqual(first?.requestHeaders);
    } else {
      expect(calls[1]?.init.body).toBeUndefined();
      expect(second?.requestHeaders).toEqual({ 'x-keep': '1' });
    }
  });

  it('resends multipart bytes and boundary on 307', async () => {
    const { fetch, calls } = scripted(reply({ status: 307, headers: [['location', '/upload2']] }), reply());
    const result = await createHttpSession({ baseUrl: BASE, fetch }).post('/upload', {
      multipart: { fields: { siteid: 'default' } },
    });

    expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
    expect(result.hops[1]?.requestHeaders['content-type']).toBe(result.hops[0]?.requestHeaders['content-type']);
  });

  it('resolves each Location against the URL of the hop that returned it', async () => {
    const locations = ['c', '/d/e?x=1', 'f', 'http://localhost:8500/g'];
    const { fetch, calls } = scripted(
      ...locations.map((location) => reply({ status: 302, headers: [['location', location]] })),
      reply(),
    );
    const result = await createHttpSession({ baseUrl: BASE, fetch }).get('/a/b');

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}a/b`,
      `${BASE}a/c`,
      `${BASE}d/e?x=1`,
      `${BASE}d/f`,
      'http://localhost:8500/g',
    ]);
    expect(result.hops.map((hop) => hop.location)).toEqual([...locations, undefined]);
    expect(result.url).toBe('http://localhost:8500/g');
  });

  it('cancels the body of a redirect it follows', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = scripted(new Response(stream, { status: 302, headers: [['location', '/next']] }), reply());
    await createHttpSession({ baseUrl: BASE, fetch }).get('/');

    expect(cancelled).toBe(true);
  });

  it('returns the redirect itself when followRedirects is false', async () => {
    const { fetch, calls } = scripted(
      reply({ status: 302, headers: [['location', './'], ...setCookieHeaders(LOGIN)], body: 'moved' }),
    );
    const session = createHttpSession({ baseUrl: BASE, fetch });
    const result = await session.post('/admin/index.cfm', { followRedirects: false });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ status: 302, url: `${BASE}admin/index.cfm`, text: 'moved' });
    expect(result.headers.location).toBe('./');
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]).toMatchObject({ status: 302, location: './', setCookie: LOGIN });
    expect(await session.cookieHeader()).toBe(cookieOf(LOGIN));
  });

  it.each<{ label: string; status: number; location?: string }>([
    { label: 'a redirect status without Location', status: 302 },
    { label: 'a Location on 201', status: 201, location: '/created' },
    { label: 'a Location on 300', status: 300, location: '/choice' },
    { label: 'a Location on 304', status: 304, location: '/cached' },
    { label: 'a 500 without Location', status: 500 },
  ])('stops at $label', async ({ status, location }) => {
    const { fetch, calls } = scripted(reply({ status, headers: location === undefined ? [] : [['location', location]] }));
    const result = await createHttpSession({ baseUrl: BASE, fetch }).get('/');

    expect(calls).toHaveLength(1);
    expect(result.status).toBe(status);
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]?.location).toBe(location);
  });

  it.each<{ label: string; maxRedirects?: number; redirects: number; throws: boolean }>([
    { label: 'follows exactly maxRedirects redirects', maxRedirects: 2, redirects: 2, throws: false },
    { label: 'throws on one redirect beyond maxRedirects', maxRedirects: 2, redirects: 3, throws: true },
    { label: 'throws on the first redirect for maxRedirects 0', maxRedirects: 0, redirects: 1, throws: true },
    { label: 'follows 20 redirects by default', redirects: 20, throws: false },
    { label: 'throws on the 21st redirect by default', redirects: 21, throws: true },
  ])('$label', async ({ maxRedirects, redirects, throws }) => {
    const { fetch, calls } = redirectChain(redirects);
    const session = createHttpSession({ baseUrl: BASE, fetch, ...(maxRedirects === undefined ? {} : { maxRedirects }) });
    const limit = maxRedirects ?? 20;
    const query = { csrf_token: 'q1' };

    if (throws) {
      const err = await rejectionOf(session.get('/loop', { query }));
      const last = limit === 0 ? `${BASE}loop` : `${BASE}r${limit}`;
      expect(err).toBeInstanceOf(HttpRequestError);
      expect(err).toMatchObject({
        message: `Too many redirects (maxRedirects=${limit}): GET ${last} (hop ${limit + 1}, status 302)`,
        target: last,
        hop: limit + 1,
        status: 302,
      });
      expect((err as Error).message).not.toContain('q1');
      expect(calls).toHaveLength(limit + 1);
    } else {
      const result = await session.get('/loop', { query });
      expect(result.status).toBe(200);
      expect(result.hops).toHaveLength(redirects + 1);
      expect(result.url).toBe(`${BASE}r${redirects}`);
    }
  });
});

describe('createHttpSession cross-origin redirects', () => {
  const credentials = {
    Authorization: 'Bearer a1',
    'Proxy-Authorization': 'Basic p1',
    'X-Serverless-Authorization': 'Bearer s1',
    Cookie: 'explicit=c1',
    'X-Keep': '1',
  };
  const sentCredentials = {
    authorization: 'Bearer a1',
    'proxy-authorization': 'Basic p1',
    'x-serverless-authorization': 'Bearer s1',
    cookie: 'explicit=c1',
    'x-keep': '1',
  };

  it.each<{ label: string; status: number; method: string; destination: string; next: string }>([
    { label: 'host', status: 302, method: 'GET', destination: 'http://localhost:8500/next', next: 'GET' },
    { label: 'port', status: 307, method: 'GET', destination: 'http://127.0.0.1:8501/next', next: 'GET' },
    { label: 'scheme', status: 308, method: 'HEAD', destination: 'https://127.0.0.1:8500/next', next: 'HEAD' },
    { label: 'host', status: 303, method: 'POST', destination: 'http://localhost:8500/next', next: 'GET' },
  ])('follows $status after $method to another $label without credential headers', async (row) => {
    const { status, method, destination, next } = row;
    const { fetch, calls } = scripted(reply({ status, headers: [['location', destination]] }), reply());
    const session = createHttpSession({ baseUrl: BASE, fetch });
    await session.jar.setCookie('dest=1; Path=/', destination);
    const result = await session.request({
      method,
      path: '/start',
      headers: credentials,
      ...(method === 'POST' ? { form: { a: '1' } } : {}),
    });

    expect(result.status).toBe(200);
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      [method, `${BASE}start`],
      [next, destination],
    ]);
    expect(calls[0]?.init.headers).toMatchObject(sentCredentials);
    expect(calls[1]?.init.body).toBeUndefined();
    expect(calls[1]?.init.headers).toEqual({ 'x-keep': '1', cookie: 'dest=1' });
  });

  it('keeps credential headers on a same-origin redirect', async () => {
    const { fetch, calls } = scripted(reply({ status: 302, headers: [['location', '/next']] }), reply());
    await createHttpSession({ baseUrl: BASE, fetch }).get('/start', { headers: credentials });

    expect(calls.map((call) => call.init.headers)).toEqual([sentCredentials, sentCredentials]);
  });

  it('does not restore credential headers when a later redirect returns to the first origin', async () => {
    const { fetch, calls } = scripted(
      reply({ status: 302, headers: [['location', 'http://localhost:8500/b']] }),
      reply({ status: 302, headers: [['location', `${BASE}a`]] }),
      reply(),
    );
    await createHttpSession({ baseUrl: BASE, fetch }).get('/start', { headers: credentials });

    expect(calls.map((call) => [call.url, call.init.headers])).toEqual([
      [`${BASE}start`, sentCredentials],
      ['http://localhost:8500/b', { 'x-keep': '1' }],
      [`${BASE}a`, { 'x-keep': '1' }],
    ]);
  });

  it.each<{ status: number; method: string }>([
    { status: 307, method: 'POST' },
    { status: 308, method: 'PUT' },
    { status: 302, method: 'PATCH' },
  ])('refuses to resend a $method body to another origin on $status', async ({ status, method }) => {
    const location = 'http://localhost:8500/upload';
    const { fetch, calls } = scripted(reply({ status, headers: [['location', location]] }), reply());
    const err = await rejectionOf(
      createHttpSession({ baseUrl: BASE, fetch }).request({ method, path: '/upload?k=q1', form: { password: 'p1' } }),
    );

    expect(err).toBeInstanceOf(HttpRequestError);
    expect(err).toMatchObject({
      message: `refusing to resend the request body to another origin: ${method} ${BASE}upload (hop 1, status ${status})`,
      hop: 1,
      status,
    });
    expect((err as Error).message).not.toMatch(/q1|p1/);
    expect(calls).toHaveLength(1);
  });
});

describe('createHttpSession deadline', () => {
  type Steps = (body: ReadableStream<Uint8Array>) => (() => Promise<Response>)[];
  /** 302 to `/next` whose body's cancel() never settles. */
  const stalledRedirect = async (): Promise<Response> =>
    reply({
      status: 302,
      headers: [['location', '/next']],
      body: new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => undefined) }),
    });

  it.each<{ label: string; timeoutMs: number; steps: Steps; expected: string; cancelsBody: boolean }>([
    {
      label: 'a response that never arrives',
      timeoutMs: 30,
      steps: () => [never],
      expected: `timed out after 30 ms: GET ${BASE}admin/ (hop 1)`,
      cancelsBody: false,
    },
    {
      label: 'a body that never ends',
      timeoutMs: 30,
      steps: (body) => [async () => new Response(body)],
      expected: `timed out after 30 ms: GET ${BASE}admin/ (hop 1, status 200)`,
      cancelsBody: true,
    },
    {
      label: 'hops that each fit but together outlast it',
      timeoutMs: 60,
      steps: () => [after(40, () => reply({ status: 302, headers: [['location', '/next']] })), after(40, () => reply())],
      expected: `timed out after 60 ms: GET ${BASE}next (hop 2)`,
      cancelsBody: false,
    },
    {
      label: 'a redirect body cancel that never settles',
      timeoutMs: 30,
      steps: () => [stalledRedirect],
      expected: `timed out after 30 ms: GET ${BASE}admin/ (hop 1, status 302)`,
      cancelsBody: false,
    },
  ])('rejects with HttpRequestError on $label', async ({ timeoutMs, steps, expected, cancelsBody }) => {
    const body = endlessBody();
    const { fetch, calls } = stepped(...steps(body.stream));
    const err = await rejectionOf(createHttpSession({ baseUrl: BASE, fetch }).get('/admin/', { timeoutMs }));

    expect(err).toBeInstanceOf(HttpRequestError);
    expect((err as Error).message).toBe(expected);
    expect((err as Error).cause).toMatchObject({ name: 'TimeoutError' });
    expect(body.cancelled()).toBe(cancelsBody ? (err as Error).cause : undefined);
    expect(calls).toHaveLength((err as HttpRequestError).hop);
  });

  it.each<{ label: string; session?: number; request?: number; expected: number }>([
    { label: 'the 300 s default when neither sets one', expected: 300_000 },
    { label: 'the session timeoutMs when the request sets none', session: 1_000, expected: 1_000 },
    { label: 'the request timeoutMs over the session one', session: 1_000, request: 2_000, expected: 2_000 },
  ])('takes the deadline from $label', async ({ session, request, expected }) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetch } = scripted(reply());
    await createHttpSession({ baseUrl: BASE, fetch, ...(session === undefined ? {} : { timeoutMs: session }) }).get(
      '/',
      request === undefined ? {} : { timeoutMs: request },
    );

    expect(timeout.mock.calls).toEqual([[expected]]);
  });

  it.each<{ label: string; steps: Steps }>([
    { label: 'waiting for the response', steps: () => [never] },
    { label: 'reading the body', steps: (body) => [async () => new Response(body)] },
    { label: 'cancelling a redirect body', steps: () => [stalledRedirect] },
  ])('rejects with the caller abort reason when the caller aborts first, while $label', async ({ steps }) => {
    const controller = new AbortController();
    const body = endlessBody();
    const { fetch } = stepped(...steps(body.stream));
    setTimeout(() => controller.abort(), 10);
    const err = await rejectionOf(
      createHttpSession({ baseUrl: BASE, fetch }).get('/', { signal: controller.signal, timeoutMs: 5_000 }),
    );

    expect(err).toMatchObject({ name: 'AbortError' });
    expect(err).toBe(controller.signal.reason);
  });
});

describe('createHttpSession failures', () => {
  const socketError = (): Error => Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });

  it.each<{ label: string; path: string; cause: Error; expected: string }>([
    {
      label: 'a refused connection',
      path: '/admin/?csrf_token=s3cr3t',
      cause: new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED s3cr3t'), { code: 'ECONNREFUSED' }),
      }),
      expected: `request failed (ECONNREFUSED): GET ${BASE}admin/ (hop 1)`,
    },
    {
      label: 'a socket error on a URL with userinfo and a fragment',
      path: 'http://user:s3cr3t@127.0.0.1:8500/admin/#s3cr3t',
      cause: new TypeError('fetch failed', { cause: socketError() }),
      expected: `request failed (UND_ERR_SOCKET): GET ${BASE}admin/ (hop 1)`,
    },
    {
      label: 'an error without a system code',
      path: '/admin/',
      cause: Object.assign(new Error('s3cr3t'), { code: 's3cr3t' }),
      expected: `request failed: GET ${BASE}admin/ (hop 1)`,
    },
  ])('reports $label with method, origin, path and hop only', async ({ path, cause, expected }) => {
    const fetch: FetchLike = () => Promise.reject(cause);
    const err = await rejectionOf(
      createHttpSession({ baseUrl: BASE, fetch }).get(path, { headers: { Authorization: 'Bearer s3cr3t' } }),
    );

    expect(err).toBeInstanceOf(HttpRequestError);
    expect(err).toMatchObject({ message: expected, method: 'GET', target: `${BASE}admin/`, hop: 1, status: undefined });
    expect((err as Error).cause).toBe(cause);
    expect((err as Error).message).not.toContain('s3cr3t');
  });

  it('reports the hop that failed after a redirect', async () => {
    const cause = new TypeError('fetch failed', { cause: socketError() });
    const { fetch } = stepped(
      async () => reply({ status: 302, headers: [['location', '/next?k=s3cr3t']] }),
      () => Promise.reject(cause),
    );
    const err = await rejectionOf(createHttpSession({ baseUrl: BASE, fetch }).get('/start'));

    expect(err).toBeInstanceOf(HttpRequestError);
    expect(err).toMatchObject({ message: `request failed (UND_ERR_SOCKET): GET ${BASE}next (hop 2)`, hop: 2 });
    expect((err as Error).cause).toBe(cause);
  });

  it.each<{ label: string; status: number; headers: [string, string][]; what: string }>([
    { label: 'a body read failure', status: 502, headers: [], what: 'response body read failed' },
    {
      label: 'a failed redirect body cancel',
      status: 302,
      headers: [['location', '/next']],
      what: 'redirect body cancel failed',
    },
  ])('reports $label with the response status', async ({ status, headers, what }) => {
    const cause = new TypeError('terminated s3cr3t', { cause: socketError() });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(cause);
      },
    });
    const { fetch, calls } = scripted(new Response(stream, { status, headers }), reply());
    const err = await rejectionOf(createHttpSession({ baseUrl: BASE, fetch }).get('/admin/?csrf_token=s3cr3t'));

    expect(err).toBeInstanceOf(HttpRequestError);
    expect(err).toMatchObject({
      message: `${what} (UND_ERR_SOCKET): GET ${BASE}admin/ (hop 1, status ${status})`,
      hop: 1,
      status,
    });
    expect((err as Error).cause).toBe(cause);
    expect((err as Error).message).not.toContain('s3cr3t');
    expect(calls).toHaveLength(1);
  });

  it('rejects an unparsable redirect Location with the hop that returned it', async () => {
    const { fetch, calls } = scripted(reply({ status: 302, headers: [['location', 'http://[::1']] }));
    const err = await rejectionOf(createHttpSession({ baseUrl: BASE, fetch }).get('/start'));

    expect(err).toBeInstanceOf(HttpRequestError);
    expect((err as Error).message).toBe(`invalid redirect location: GET ${BASE}start (hop 1, status 302)`);
    expect(calls).toHaveLength(1);
  });
});

describe('createHttpSession default fetch', () => {
  it('uses the global fetch when none is injected', async () => {
    const { fetch, calls } = scripted(reply({ body: 'ok' }));
    vi.stubGlobal('fetch', fetch);
    const result = await createHttpSession({ baseUrl: BASE }).get('/');

    expect(result.text).toBe('ok');
    expect(calls.map((call) => call.url)).toEqual([BASE]);
  });
});
