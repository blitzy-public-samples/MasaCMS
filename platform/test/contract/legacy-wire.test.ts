// Masa wire format of target responses through service-kit: envelope, ETag, error map, challenges, CORS, 503 shapes, session cookies.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthDenial } from '../../src/auth/index.js';
import {
  INVALID_ACCESS_TOKEN_HEADER_SEQUENCE,
  LEGACY_ERROR_MAP,
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_HTML_CONTENT_TYPE,
  LEGACY_JSON_CONTENT_TYPE,
  LEGACY_SESSION_COOKIE_NAMES,
  LegacyApiError,
  LegacyServiceUnavailableError,
  WWW_AUTHENTICATE,
  apiUnavailableResponse,
  buildEnvelope as buildMasaEnvelope,
  corsHeaders,
  effectiveWwwAuthenticate,
  legacyHeaders,
  serializeResponse,
  serializeSaveResult,
  sessionCookieStrings,
  setCookieLegacy,
  type LegacyApiErrorType,
  type LegacyCookieConfig,
} from '../../src/legacy-compat/index.js';
import {
  baseEnvSchema,
  createService,
  legacyParamsOf,
  loadEnv,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyRequest,
} from '../../src/service-kit/index.js';
import { fixedClock, testVerifier, writeTestSecrets, type InjectResponse } from '../../src/testing/index.js';

const API_ROUTE = '/_api/json/v1/:siteid';
const API = '/_api/json/v1/default';
const NOW = '2026-06-30T12:00:00Z';
const PUBLIC = { config: { opt2: { public: true as const } } };
const CONTENT_ITEMS = [{ contentid: 'X', title: 'T' }];
const CORS_DOMAINS = ['example.org'];
const SESSION_TOKENS = { CFID: '1234', CFTOKEN: 'abcd', jsessionid: 'xyz' };
const ERROR_PAGE_FILE = new URL('../../../core/templates/error.html', import.meta.url);

// Catch blocks of processRequest (jsonApiUtility.cfc:1318-1402): type, status, code, message.
const ERROR_TABLE: ReadonlyArray<readonly [LegacyApiErrorType, number, string, string]> = [
  ['authorization', 401, 'invalid_request', 'Insufficient Account Permissions'],
  ['invalidAccessToken', 401, 'invalid_token', 'Invalid Access Token'],
  ['accessTokenExpired', 401, 'invalid_token', 'Access Token Expired'],
  ['disabled', 400, 'invalid_request', 'The JSON API disabled'],
  ['invalidParameters', 400, 'invalid_request', 'Invalid parameters'],
  ['invalidEntityCall', 400, 'invalid_request', 'Invalid reference to persisted entity'],
  ['invalidMethodCall', 400, 'invalid_request', 'Invalid method call'],
  ['badRequest', 400, 'invalid_request', 'Bad Request'],
  ['invalidTokens', 400, 'invalid_request', 'Invalid CSRF tokens'],
  ['server_error', 500, 'server_error', 'Unhandled Exception'],
];

/** Code and message of a literal ERROR_TABLE row. */
function errorBody(type: LegacyApiErrorType): { code: string; message: string } {
  const row = ERROR_TABLE.find(([t]) => t === type);
  if (row === undefined) throw new TypeError(`No literal row for ${type}`);
  return { code: row[2], message: row[3] };
}

// Final challenge per legacy denial (jsonApiUtility.cfc:483, 495-496, 500); later setHeader calls replace earlier ones.
const AUTH_CASES = [
  {
    name: 'basic-credentials',
    type: 'authorization',
    header: 'Basic',
    error: () => new LegacyApiError('authorization', { wwwAuthenticate: WWW_AUTHENTICATE.basic }),
  },
  {
    name: 'unknown-token',
    type: 'invalidAccessToken',
    header: 'Bearer',
    error: () =>
      new LegacyApiError('invalidAccessToken', {
        method: 'Not Available',
        wwwAuthenticate: effectiveWwwAuthenticate(INVALID_ACCESS_TOKEN_HEADER_SEQUENCE),
      }),
  },
  {
    name: 'expired-token',
    type: 'accessTokenExpired',
    header: 'Bearer error="invalid_access_token"',
    error: () => AuthDenial.expiredToken(),
  },
] as const;

// configBean defaults sessionCookiesExpires to 'never' (configBean.cfc:214), so default session cookies expire in 30 years.
const COOKIE_CASES: ReadonlyArray<{ path: string; cfg: LegacyCookieConfig; expected: string[] }> = [
  {
    path: '/contract/cookies',
    cfg: {},
    expected: [
      'CFID=1234;expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;',
      'CFTOKEN=abcd;expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;',
      'JSESSIONID=xyz;expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;',
    ],
  },
  {
    path: '/contract/cookies-session',
    cfg: { sessionCookiesExpires: 'session' },
    expected: ['CFID=1234;path=/;HttpOnly;', 'CFTOKEN=abcd;path=/;HttpOnly;', 'JSESSIONID=xyz;path=/;HttpOnly;'],
  },
  {
    path: '/contract/cookies-secure',
    cfg: { sessionCookiesExpires: 'session', secureCookies: true, cookieDomain: 'example.org' },
    expected: [
      'CFID=1234;domain=example.org;path=/;secure;HttpOnly;',
      'CFTOKEN=abcd;domain=example.org;path=/;secure;HttpOnly;',
      'JSESSIONID=xyz;domain=example.org;path=/;secure;HttpOnly;',
    ],
  },
];

/** A findMany envelope over CONTENT_ITEMS echoing the request's merged params. */
function contentEnvelope(request: FastifyRequest) {
  return buildMasaEnvelope({
    method: 'findMany',
    params: legacyParamsOf(request),
    data: { items: CONTENT_ITEMS, entityname: 'content' },
  });
}

function registerRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { useDataNamespace?: string } }>(`${API_ROUTE}/content`, PUBLIC, async (request, reply) =>
    sendLegacyResponse(
      reply,
      serializeResponse(contentEnvelope(request), { useDataNamespace: request.query.useDataNamespace }),
    ),
  );
  app.get(`${API_ROUTE}/content-params`, PUBLIC, async (request, reply) =>
    sendLegacyResponse(reply, serializeResponse(contentEnvelope(request), { suppressAPIParams: false })),
  );
  app.get(`${API_ROUTE}/missing`, PUBLIC, async (request, reply) =>
    sendLegacyResponse(reply, serializeResponse(contentEnvelope(request), { mura404: true })),
  );
  app.post<{ Body: { title?: string } }>(`${API_ROUTE}/save`, PUBLIC, async (request, reply) => {
    const title = request.body.title ?? '';
    const data = title === '' ? { errors: { title: 'Required' } } : { title, errors: {} };
    return sendLegacyResponse(reply, serializeSaveResult({ method: 'save', params: legacyParamsOf(request), data }));
  });
  app.get<{ Params: { type: string } }>(`${API_ROUTE}/error/:type`, PUBLIC, async (request) => {
    throw new LegacyApiError(request.params.type);
  });
  for (const authCase of AUTH_CASES) {
    app.get(`${API_ROUTE}/auth/${authCase.name}`, PUBLIC, async () => {
      throw authCase.error();
    });
  }
  app.get(`${API_ROUTE}/protected`, { config: { opt2: { requires: ['s2'] } } }, async (request, reply) =>
    sendLegacyResponse(reply, serializeResponse(contentEnvelope(request))),
  );
  app.get(`${API_ROUTE}/boom`, PUBLIC, async () => {
    throw new Error('unexpected');
  });
  for (const path of [`${API_ROUTE}/unavailable`, '/admin/unavailable']) {
    app.get(path, PUBLIC, async () => {
      throw new LegacyServiceUnavailableError();
    });
  }
  app.get(`${API_ROUTE}/cors`, PUBLIC, async (request, reply) =>
    sendLegacyResponse(
      reply.headers(corsHeaders(request.headers.origin, CORS_DOMAINS)),
      serializeResponse(contentEnvelope(request)),
    ),
  );
  for (const { path, cfg } of COOKIE_CASES) {
    app.get(path, PUBLIC, async (request, reply) =>
      reply.header('Set-Cookie', sessionCookieStrings(SESSION_TOKENS, cfg, request.server.opt2.clock.now())).send(''),
    );
  }
}

/** Uppercase SHA-256 hex of the exact response bytes, computed independently of the port. */
function bodyHash(res: InjectResponse): string {
  return createHash('sha256').update(res.rawPayload).digest('hex').toUpperCase();
}

/** Asserts the headers legacy's onRequestStart adds to every response (onRequestStart_include.cfm:333-344). */
function expectLegacyHeaders(res: InjectResponse): void {
  expect(res.headers.generator).toBe('Masa CMS 7.6.1');
  expect(res.headers['strict-transport-security']).toBe('max-age=1200');
}

// Wire values measured on the ACF 2023 oracle: ACF's hash() defaults to SHA-256, so the ETag is 64 uppercase hex
// characters rather than MD5, and the servlet container drops the space before `charset`.
/** Asserts serializeResponse's content type and ETag (jsonApiUtility.cfc:1473, 1508) plus the legacy headers. */
function expectJsonWire(res: InjectResponse): void {
  expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
  expect(res.headers.etag).toMatch(/^[0-9A-F]{64}$/);
  expect(res.headers.etag).toBe(bodyHash(res));
  expectLegacyHeaders(res);
}

let app: FastifyInstance | undefined;
let stateDir: string | undefined;

/** The app under test; fails when beforeAll did not build it. */
function server(): FastifyInstance {
  if (app === undefined) throw new Error('app was not built');
  return app;
}

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'opt2-legacy-wire-'));
  await writeTestSecrets(stateDir);
  const env = loadEnv(baseEnvSchema, {
    // Never bound: every request goes through app.inject.
    PORT: '8199',
    OPT2_SERVICE_NAME: 'contract',
    OPT2_ENV: 'local',
    OPT2_STATE_DIR: stateDir,
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    TZ: 'UTC',
  });
  app = await createService({
    name: 'contract',
    version: '0.0.0',
    env,
    verifierOverride: testVerifier(),
    clock: fixedClock(NOW),
  });
  registerRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
});

describe('JSON API success envelope', () => {
  it('answers {apiversion, method, data} without params by default', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/content?fields=title` });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['apiversion', 'data', 'method']);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findMany',
      data: { items: CONTENT_ITEMS, entityname: 'content' },
    });
  });

  it('sends the legacy JSON content type, an ETag of the exact body and the legacy headers', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/content` });
    expectJsonWire(res);
    expect(LEGACY_JSON_CONTENT_TYPE).toBe(res.headers['content-type']);
    expect(legacyHeaders()).toEqual({
      Generator: res.headers.generator,
      'Strict-Transport-Security': res.headers['strict-transport-security'],
    });
  });

  it('echoes the request params when suppressAPIParams is off', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/content-params?fields=title` });
    expect(res.json()).toMatchObject({ apiversion: 'v1', method: 'findMany', params: { fields: 'title' } });
    expectJsonWire(res);
  });

  it.each(['false', 'no', '0'])('flattens data into the top level when useDataNamespace is %s', async (value) => {
    const res = await server().inject({ method: 'GET', url: `${API}/content?useDataNamespace=${value}` });
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findMany', items: CONTENT_ITEMS, entityname: 'content' });
    expectJsonWire(res);
  });

  it.each(['true', 'yes', 'maybe'])('keeps the data namespace when useDataNamespace is %s', async (value) => {
    const res = await server().inject({ method: 'GET', url: `${API}/content?useDataNamespace=${value}` });
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findMany',
      data: { items: CONTENT_ITEMS, entityname: 'content' },
    });
  });

  it('answers 404 with the data envelope when request.mura404 is set', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/missing` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findMany',
      data: { items: CONTENT_ITEMS, entityname: 'content' },
    });
    expectJsonWire(res);
  });

  it('answers 403 with the data envelope when a save returns errors', async () => {
    const res = await server().inject({ method: 'POST', url: `${API}/save`, payload: { title: '' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', data: { errors: { title: 'Required' } } });
    expectJsonWire(res);
  });

  it('answers 200 when a save returns an empty errors struct', async () => {
    const res = await server().inject({ method: 'POST', url: `${API}/save`, payload: { title: 'Home' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', data: { title: 'Home', errors: {} } });
  });
});

describe('JSON API error envelopes', () => {
  it.each(ERROR_TABLE)('answers %s with %i %s "%s"', async (type, status, code, message) => {
    expect(LEGACY_ERROR_MAP[type]).toEqual({ status, code, message });
    const res = await server().inject({ method: 'GET', url: `${API}/error/${type}?method=findOne` });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findOne', error: { code, message } });
    expectJsonWire(res);
  });

  it('answers an exception type no catch block names with the 500 server_error envelope', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/error/invalid_token?method=findOne` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findOne', error: errorBody('server_error') });
    expectJsonWire(res);
  });

  it('answers an unexpected exception with the 500 server_error envelope', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/boom` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: errorBody('server_error') });
    expectJsonWire(res);
  });

  it.each([
    ['?method=notAMethod', 'invalid'],
    ['?method=findOne', 'findOne'],
    ['', 'invalid'],
  ])('reports the method of %j as %s', async (query, reported) => {
    const res = await server().inject({ method: 'GET', url: `${API}/error/badRequest${query}` });
    expect(res.json()).toEqual({ apiversion: 'v1', method: reported, error: errorBody('badRequest') });
  });
});

describe('WWW-Authenticate challenges', () => {
  it('holds the legacy challenge literals', () => {
    expect(WWW_AUTHENTICATE.basic).toBe('Basic');
    expect(WWW_AUTHENTICATE.bearer).toBe('Bearer');
    expect(WWW_AUTHENTICATE.bearerInvalidAccessToken).toBe('Bearer error="invalid_access_token"');
    expect(INVALID_ACCESS_TOKEN_HEADER_SEQUENCE).toEqual(['Bearer error="invalid_access_token"', 'Bearer']);
  });

  it.each(AUTH_CASES)('answers $name with 401 $type and WWW-Authenticate: $header', async ({ name, type, header }) => {
    const res = await server().inject({ method: 'GET', url: `${API}/auth/${name}` });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(header);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: errorBody(type) });
    expectJsonWire(res);
  });

  it('answers a request lacking the required role with the 401 authorization envelope and no challenge', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/protected?method=findOne` });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findOne', error: errorBody('authorization') });
    expectJsonWire(res);
  });
});

describe('legacy 503 shapes', () => {
  it('answers the server_error envelope with status 503 on API routes', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/unavailable?method=findOne` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findOne', error: errorBody('server_error') });
    expect(res.body).toBe(apiUnavailableResponse({ method: 'findOne' }).body);
    expectJsonWire(res);
  });

  it('answers the legacy 503 error page on admin routes', async () => {
    const res = await server().inject({ method: 'GET', url: '/admin/unavailable' });
    expect(res.statusCode).toBe(503);
    expect(res.statusMessage).toBe('An Error Occurred');
    expect(LEGACY_ERROR_STATUS_TEXT).toBe(res.statusMessage);
    // Oracle-measured wire form of CFML page output: no space before `charset`.
    expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
    expect(LEGACY_HTML_CONTENT_TYPE).toBe(res.headers['content-type']);
    expect(res.rawPayload.equals(readFileSync(ERROR_PAGE_FILE))).toBe(true);
    expect(res.rawPayload.equals(Buffer.from(LEGACY_ERROR_PAGE_HTML, 'utf8'))).toBe(true);
    expectLegacyHeaders(res);
  });
});

describe('CORS origin echo', () => {
  it.each([
    ['https://www.example.org', true],
    ['https://example.org:8443', true],
    ['https://WWW.Example.ORG', true],
    ['https://badexample.org', false],
    ['https://evil.test', false],
  ])('answers Origin %s with echo=%s', async (origin, echoed) => {
    const res = await server().inject({ method: 'GET', url: `${API}/cors`, headers: { origin } });
    expect(res.headers['access-control-allow-origin']).toBe(echoed ? origin : undefined);
    expect(res.headers['access-control-allow-credentials']).toBe(echoed ? 'true' : undefined);
    expectJsonWire(res);
  });

  it('sends no CORS headers without an Origin', async () => {
    const res = await server().inject({ method: 'GET', url: `${API}/cors` });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('legacy session cookies', () => {
  it.each(COOKIE_CASES)('sets the setSessionCookies values on $path', async ({ path, expected }) => {
    const res = await server().inject({ method: 'GET', url: path });
    const cookies = [res.headers['set-cookie']].flat();
    expect(cookies).toEqual(expected);
    expect(cookies.map((cookie) => String(cookie).split('=')[0])).toEqual([...LEGACY_SESSION_COOKIE_NAMES]);
    expectLegacyHeaders(res);
  });

  it.each([
    [1, 'Wed, 01-Jul-2026 12:00:00 GMT'],
    ['now', 'Mon, 29-Jun-2026 12:00:00 GMT'],
    ['never', 'Fri, 30-Jun-2056 12:00:00 GMT'],
  ] as const)('renders expires=%s as the GMT date before path=/', (expires, date) => {
    const cookie = setCookieLegacy({ name: 'opt2Pref', value: 'v', expires }, {}, new Date(NOW));
    expect(cookie).toBe(`OPT2PREF=v;expires=${date};path=/;HttpOnly;`);
    expect(/expires=([^;]*);path=\/;/.exec(cookie)?.[1]).toMatch(
      /^[A-Z][a-z]{2}, \d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}:\d{2} GMT$/,
    );
  });
});

