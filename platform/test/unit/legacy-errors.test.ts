import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_METHODS,
  LEGACY_ERROR_MAP,
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LegacyApiError,
  LegacyServiceUnavailableError,
  ROUTE_FAMILIES,
  adminUnavailableResponse,
  apiUnavailableResponse,
  errorSpec,
  etag,
  isDefinedApiName,
  isValidVariableName,
  legacyErrorResponse,
  renderUnavailable,
  reportedMethod,
  unavailableResponseFor,
  unavailableSurfaceForFamily,
  type ApiNameContext,
  type ApiUnavailableOptions,
  type LegacyApiErrorType,
  type LegacyErrorResponseOptions,
  type UnavailableSurface,
} from '../../src/legacy-compat/index.js';

const JSON_CONTENT_TYPE = 'application/json;charset=utf-8';
// Wire form on the legacy oracle: the servlet container drops the space before `charset`.
const HTML_CONTENT_TYPE = 'text/html;charset=UTF-8';
const LEGACY_HEADERS = { 'Strict-Transport-Security': 'max-age=1200', Generator: 'Masa CMS 7.6.1' };

const ERROR_ROWS: { type: LegacyApiErrorType; status: number; code: string; message: string }[] = [
  { type: 'authorization', status: 401, code: 'invalid_request', message: 'Insufficient Account Permissions' },
  { type: 'invalidAccessToken', status: 401, code: 'invalid_token', message: 'Invalid Access Token' },
  { type: 'accessTokenExpired', status: 401, code: 'invalid_token', message: 'Access Token Expired' },
  { type: 'disabled', status: 400, code: 'invalid_request', message: 'The JSON API disabled' },
  { type: 'invalidParameters', status: 400, code: 'invalid_request', message: 'Invalid parameters' },
  { type: 'invalidEntityCall', status: 400, code: 'invalid_request', message: 'Invalid reference to persisted entity' },
  { type: 'invalidMethodCall', status: 400, code: 'invalid_request', message: 'Invalid method call' },
  { type: 'badRequest', status: 400, code: 'invalid_request', message: 'Bad Request' },
  { type: 'invalidTokens', status: 400, code: 'invalid_request', message: 'Invalid CSRF tokens' },
  { type: 'server_error', status: 500, code: 'server_error', message: 'Unhandled Exception' },
];

// Anonymous GETs against Masa 7.6.1 on ACF 2023: /index.cfm/_api/json/v1/default/nosuchentity and
// /index.cfm/_api/json/v1/default/user/?fields=username.
const ORACLE_ERRORS: {
  label: string;
  type: LegacyApiErrorType;
  opts: LegacyErrorResponseOptions;
  status: number;
  body: string;
  etag: string;
}[] = [
  {
    label: 'an unknown entity route',
    type: 'invalidEntityCall',
    opts: { params: { siteid: 'default', entityname: 'nosuchentity' } },
    status: 400,
    body: '{"apiversion":"v1","method":"invalid","error":{"message":"Invalid reference to persisted entity","code":"invalid_request"}}',
    etag: 'FCA97FC3E7B0F1280463BDBCA975F6EF4464AB4F12DA96F21894D8DB494D8572',
  },
  {
    label: 'an anonymous user query',
    type: 'authorization',
    opts: { method: 'findQuery', params: { siteid: 'default', entityname: 'user', fields: 'username' } },
    status: 401,
    body: '{"apiversion":"v1","method":"findQuery","error":{"message":"Insufficient Account Permissions","code":"invalid_request"}}',
    etag: 'D203B063A91EDCCF5A3669192822EE3D8EA19321999C13DB875064E24598ACBE',
  },
];

const errorBody = (method: string, message: string, code: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"message":"${message}","code":"${code}"}}`;

describe('LEGACY_ERROR_MAP', () => {
  it.each(ERROR_ROWS)('maps $type to $status $code "$message"', ({ type, status, code, message }) => {
    expect(LEGACY_ERROR_MAP[type]).toEqual({ status, code, message });
    expect(errorSpec(type)).toBe(LEGACY_ERROR_MAP[type]);
  });

  it('holds the nine named catch blocks and the catch (Any e) fallback, in legacy order', () => {
    expect(Object.keys(LEGACY_ERROR_MAP)).toEqual(ERROR_ROWS.map((row) => row.type));
  });

  it('freezes the map and every row', () => {
    expect(Object.isFrozen(LEGACY_ERROR_MAP)).toBe(true);
    expect(Object.values(LEGACY_ERROR_MAP).every((row) => Object.isFrozen(row))).toBe(true);
  });

  it.each(['invalid_token', 'Expression', 'database', '', 'toString', '__proto__'])(
    'falls back to the catch (Any e) row for the unnamed type "%s"',
    (type) => {
      expect(errorSpec(type)).toBe(LEGACY_ERROR_MAP.server_error);
    },
  );
});

describe('legacyErrorResponse', () => {
  it.each(ERROR_ROWS)(
    'answers $type with $status and the {apiversion, method, error} envelope, params suppressed',
    ({ type, status, code, message }) => {
      const response = legacyErrorResponse(type, { method: 'findOne', params: { method: 'findOne', siteid: 'default' } });
      expect(response).toEqual({
        status,
        headers: { 'Content-Type': JSON_CONTENT_TYPE, ETag: etag(response.body) },
        body: errorBody('findOne', message, code),
      });
    },
  );

  it.each(ORACLE_ERRORS)('reproduces the legacy status, bytes and ETag of $label', ({ type, opts, status, body, etag: tag }) => {
    expect(legacyErrorResponse(type, opts)).toEqual({
      status,
      headers: { 'Content-Type': JSON_CONTENT_TYPE, ETag: tag },
      body,
    });
  });

  it('answers an unnamed type with the 500 server_error envelope', () => {
    const response = legacyErrorResponse('invalid_token', { method: 'findOne' });
    expect(response.status).toBe(500);
    expect(response.body).toBe(errorBody('findOne', 'Unhandled Exception', 'server_error'));
  });

  it('echoes params without method when suppressAPIParams is false', () => {
    const { body } = legacyErrorResponse('badRequest', {
      method: 'login',
      params: { method: 'login', siteid: 'default' },
      suppressAPIParams: false,
    });
    expect(body).toBe(
      '{"apiversion":"v1","method":"login","params":{"siteid":"default"},"error":{"message":"Bad Request","code":"invalid_request"}}',
    );
  });

  it('forces status 404 when request.mura404 is set', () => {
    const response = legacyErrorResponse('badRequest', { method: 'findOne', mura404: true });
    expect(response.status).toBe(404);
    expect(response.body).toBe(errorBody('findOne', 'Bad Request', 'invalid_request'));
  });

  it('adds the WWW-Authenticate value set before the throw', () => {
    const response = legacyErrorResponse('invalidAccessToken', { wwwAuthenticate: 'Bearer' });
    expect(response.status).toBe(401);
    expect(response.headers).toEqual({ 'Content-Type': JSON_CONTENT_TYPE, ETag: etag(response.body), 'WWW-Authenticate': 'Bearer' });
  });

  it('reports the method under the request context it is given', () => {
    expect(legacyErrorResponse('badRequest', { method: 'origin', methodCtx: { hasOrigin: true } }).body).toBe(
      errorBody('origin', 'Bad Request', 'invalid_request'),
    );
    expect(legacyErrorResponse('badRequest', { method: 'origin' }).body).toBe(
      errorBody('invalid', 'Bad Request', 'invalid_request'),
    );
  });
});

describe('LegacyApiError', () => {
  it('carries its type, response options and a message naming the legacy error', () => {
    const err = new LegacyApiError('invalidAccessToken', {
      method: 'findOne',
      params: { siteid: 'default' },
      methodCtx: { restMode: true },
      wwwAuthenticate: 'Bearer error="invalid_access_token"',
      data: { reason: 'expired' },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LegacyApiError);
    expect(err).toMatchObject({
      name: 'LegacyApiError',
      type: 'invalidAccessToken',
      message: 'invalidAccessToken: Invalid Access Token',
      method: 'findOne',
      params: { siteid: 'default' },
      methodCtx: { restMode: true },
      wwwAuthenticate: 'Bearer error="invalid_access_token"',
      data: { reason: 'expired' },
    });
  });

  it('leaves every option undefined when none is given', () => {
    const err = new LegacyApiError('badRequest');
    expect(err.message).toBe('badRequest: Bad Request');
    expect([err.method, err.params, err.methodCtx, err.wwwAuthenticate, err.data]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('names the fallback message for a type no catch block names', () => {
    expect(new LegacyApiError('invalid_token').message).toBe('invalid_token: Unhandled Exception');
  });

  it('renders through legacyErrorResponse with its own options', () => {
    const err = new LegacyApiError('accessTokenExpired', { method: 'findOne', wwwAuthenticate: 'Bearer' });
    const response = legacyErrorResponse(err.type, err);
    expect(response.status).toBe(401);
    expect(response.headers['WWW-Authenticate']).toBe('Bearer');
    expect(response.body).toBe(errorBody('findOne', 'Access Token Expired', 'invalid_token'));
  });
});

describe('LegacyServiceUnavailableError', () => {
  it('defaults to the auto surface with no reason', () => {
    const err = new LegacyServiceUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({
      name: 'LegacyServiceUnavailableError',
      message: 'Service Unavailable',
      surface: 'auto',
      reason: undefined,
    });
  });

  it('keeps an explicit message, surface and reason', () => {
    expect(new LegacyServiceUnavailableError('gate closed', 'api', 'gate-timeout')).toMatchObject({
      message: 'gate closed',
      surface: 'api',
      reason: 'gate-timeout',
    });
  });

  it('matches instanceof for its subclasses', () => {
    class GateTimeout extends LegacyServiceUnavailableError {}
    const err: unknown = new GateTimeout('gate closed', 'admin');
    expect(err instanceof LegacyServiceUnavailableError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof LegacyApiError).toBe(false);
  });
});

describe('reportedMethod', () => {
  it.each<{ name: string; valid: boolean; defined: boolean; reported: string }>([
    { name: 'findOne', valid: true, defined: true, reported: 'findOne' },
    { name: 'login', valid: true, defined: true, reported: 'login' },
    { name: 'FINDONE', valid: true, defined: true, reported: 'FINDONE' },
    { name: 'getBean', valid: true, defined: true, reported: 'getBean' },
    { name: 'e', valid: true, defined: false, reported: 'e' },
    { name: 'E', valid: true, defined: false, reported: 'E' },
    { name: 'content', valid: true, defined: false, reported: 'invalid' },
    { name: 'submitForm', valid: true, defined: false, reported: 'invalid' },
    { name: 'undefined', valid: true, defined: false, reported: 'invalid' },
    { name: '1abc', valid: false, defined: false, reported: 'invalid' },
    { name: 'a-b', valid: false, defined: false, reported: 'invalid' },
    { name: 'a.b', valid: false, defined: false, reported: 'invalid' },
    { name: '', valid: false, defined: false, reported: 'invalid' },
  ])('reports "$name" as "$reported" (variable name: $valid, defined: $defined)', ({ name, valid, defined, reported }) => {
    expect(isValidVariableName(name)).toBe(valid);
    expect(isDefinedApiName(name)).toBe(defined);
    expect(reportedMethod(name)).toBe(reported);
  });

  it('reports invalid when legacy never set the method', () => {
    expect(reportedMethod(undefined)).toBe('invalid');
  });

  it.each<{ name: string; ctx: ApiNameContext; reported: string }>([
    { name: 'origin', ctx: { hasOrigin: true }, reported: 'origin' },
    { name: 'origin', ctx: {}, reported: 'invalid' },
    { name: 'isBasicAuth', ctx: { restMode: true }, reported: 'isBasicAuth' },
    { name: 'myPluginMethod', ctx: { registeredMethods: ['mypluginmethod'] }, reported: 'myPluginMethod' },
    { name: 'myPluginMethod', ctx: {}, reported: 'invalid' },
  ])('reports "$name" as "$reported" with context $ctx', ({ name, ctx, reported }) => {
    expect(reportedMethod(name, ctx)).toBe(reported);
  });

  it('reports each of the ten entity-generic methods as itself', () => {
    const generic = ['save', 'delete', 'findOne', 'findMany', 'findAll', 'findNew', 'findQuery', 'findProperties', 'findPermissions', 'validate'];
    expect(GENERIC_METHODS).toEqual(generic);
    expect(generic.map((name) => reportedMethod(name))).toEqual(generic);
  });
});

describe('apiUnavailableResponse', () => {
  it('answers 503 with the server_error envelope, its ETag and the legacy headers', () => {
    const body = errorBody('login', 'Unhandled Exception', 'server_error');
    expect(apiUnavailableResponse({ method: 'login', params: { method: 'login', siteid: 'default' } })).toEqual({
      status: 503,
      headers: { 'Content-Type': JSON_CONTENT_TYPE, ETag: etag(body), ...LEGACY_HEADERS },
      body,
    });
  });

  it('reports invalid when no method was resolved', () => {
    expect(apiUnavailableResponse().body).toBe(errorBody('invalid', 'Unhandled Exception', 'server_error'));
  });

  it('echoes params only when suppressAPIParams is false', () => {
    const { body } = apiUnavailableResponse({
      method: 'findOne',
      params: { method: 'findOne', siteid: 'default' },
      suppressAPIParams: false,
    });
    expect(body).toBe(
      '{"apiversion":"v1","method":"findOne","params":{"siteid":"default"},"error":{"message":"Unhandled Exception","code":"server_error"}}',
    );
  });

  it('takes the Generator version and HSTS max-age, omitting HSTS at 0', () => {
    const response = apiUnavailableResponse({ method: 'findOne', version: '7.6.2', hstsMaxAge: 0 });
    expect(response.headers).toEqual({ 'Content-Type': JSON_CONTENT_TYPE, ETag: etag(response.body), Generator: 'Masa CMS 7.6.2' });
  });
});

describe('adminUnavailableResponse', () => {
  it('answers 503 "An Error Occurred" with the legacy error page as HTML and the legacy headers', () => {
    expect(adminUnavailableResponse()).toEqual({
      status: 503,
      statusText: 'An Error Occurred',
      headers: { 'Content-Type': HTML_CONTENT_TYPE, ...LEGACY_HEADERS },
      body: LEGACY_ERROR_PAGE_HTML,
    });
    expect(LEGACY_ERROR_STATUS_TEXT).toBe('An Error Occurred');
  });

  it('takes the Generator version and HSTS max-age', () => {
    expect(adminUnavailableResponse({ version: '7.6.2', hstsMaxAge: 600 }).headers).toEqual({
      'Content-Type': HTML_CONTENT_TYPE,
      'Strict-Transport-Security': 'max-age=600',
      Generator: 'Masa CMS 7.6.2',
    });
  });
});

describe('LEGACY_ERROR_PAGE_HTML', () => {
  it('is 488 UTF-8 bytes with 15 CRLF line endings and no bare CR or LF', () => {
    expect(Buffer.byteLength(LEGACY_ERROR_PAGE_HTML, 'utf8')).toBe(488);
    expect(LEGACY_ERROR_PAGE_HTML.match(/\r\n/g)).toHaveLength(15);
    expect(LEGACY_ERROR_PAGE_HTML).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
  });

  it('equals core/templates/error.html byte for byte', async () => {
    const legacy = await readFile(new URL('../../../core/templates/error.html', import.meta.url));
    expect(Buffer.from(LEGACY_ERROR_PAGE_HTML, 'utf8').equals(legacy)).toBe(true);
  });
});

describe('unavailableResponseFor', () => {
  const ctx: ApiUnavailableOptions = { method: 'findOne', params: { method: 'findOne', siteid: 'default' } };

  it('renders the JSON API 503 on the api surface', () => {
    expect(unavailableResponseFor('api', ctx)).toEqual(apiUnavailableResponse(ctx));
  });

  it('renders the error page on the admin surface, ignoring the API options', () => {
    expect(unavailableResponseFor('admin', ctx)).toEqual(adminUnavailableResponse());
  });
});

describe('renderUnavailable', () => {
  const API_FAMILIES: ReadonlySet<string> = new Set(['api', 'rest', 'feed', 'render', 'fixture', 'opt2']);
  const surfaceOf = (family: string): UnavailableSurface => (API_FAMILIES.has(family) ? 'api' : 'admin');
  const ctx: ApiUnavailableOptions = { method: 'login' };

  it.each(ROUTE_FAMILIES.map((family) => ({ family, surface: surfaceOf(family) })))(
    'renders an auto-surface error on the $surface surface for the $family family',
    ({ family, surface }) => {
      expect(unavailableSurfaceForFamily(family)).toBe(surface);
      expect(renderUnavailable(new LegacyServiceUnavailableError(), family, ctx)).toEqual(
        unavailableResponseFor(surface, ctx),
      );
    },
  );

  it.each<[UnavailableSurface, string]>([
    ['api', 'admin'],
    ['admin', 'api'],
  ])('keeps an explicit %s surface over the %s family', (surface, family) => {
    expect(renderUnavailable(new LegacyServiceUnavailableError('closed', surface), family, ctx)).toEqual(
      unavailableResponseFor(surface, ctx),
    );
  });
});
