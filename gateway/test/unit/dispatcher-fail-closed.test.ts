// Tests the fail-closed surface choice, envelope method, unavailability classification and the 503 it sends.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_ERROR_STATUS_TEXT,
  LegacyServiceUnavailableError,
  adminUnavailableResponse,
  apiUnavailableResponse,
  routeKeyForRequest,
  type LegacyUnavailableResponse,
  type RouteFamily,
  type RouteKeyResult,
} from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, type FastifyReply } from '@opt2/platform/service-kit';
import {
  failClosed,
  failContextFor,
  isLegacyUnavailable,
  isTargetUnavailable,
  neverSent,
  surfaceForFamily,
  type FailContext,
  type FailSurface,
} from '../../src/dispatcher/fail-closed.js';

/** A route key result of `family:body` with `params`, as routeKeyForRequest shapes it. */
function routeOf(
  family: RouteFamily,
  body: string,
  params: Record<string, string> = {},
  afterReload?: RouteKeyResult,
): RouteKeyResult {
  const baseKey = `${family}:${body}`;
  return { key: baseKey, baseKey, family, httpMethod: 'GET', params, afterReload };
}

/** An error carrying a Node-style `code`, optionally caused by `cause`. */
function coded(code: string, cause?: unknown): Error {
  return Object.assign(new Error(`transport failure ${code}`, { cause }), { code });
}

/** Headers of a legacy 503 keyed as light-my-request reports them. */
function lowerCased(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

interface Served {
  status: number;
  statusMessage: string;
  headers: Record<string, unknown>;
  body: string;
  returnedSameReply: boolean;
}

/** Runs `handle` as a GET route handler under Fastify inject and reports the response and failClosed's return. */
async function serve(handle: (reply: FastifyReply) => FastifyReply): Promise<Served> {
  const app = Fastify();
  let returnedSameReply = false;
  app.get('/', (_request, reply) => {
    returnedSameReply = handle(reply) === reply;
  });
  try {
    const res = await app.inject({ method: 'GET', url: '/' });
    return {
      status: res.statusCode,
      statusMessage: res.statusMessage,
      headers: res.headers,
      body: res.body,
      returnedSameReply,
    };
  } finally {
    await app.close();
  }
}

describe('surfaceForFamily', () => {
  it.each<[RouteFamily, FailSurface]>([
    ['api', 'api'],
    ['rest', 'api'],
    ['fixture', 'api'],
    ['sitemonitor', 'api'],
    ['feed', 'admin'],
    ['render', 'admin'],
    ['apiother', 'admin'],
    ['admin', 'admin'],
    ['page', 'admin'],
    ['cfc', 'admin'],
    ['cfm', 'admin'],
    ['reload', 'admin'],
    ['opt2', 'admin'],
  ])('answers family %s on the %s surface outside the OPT-2 envelope namespaces', (family, surface) => {
    expect(surfaceForFamily(family, '/some/route')).toBe(surface);
  });

  it.each([
    ['opt2', '/opt2/stub'],
    ['opt2', '/opt2/stub/items/42'],
    ['opt2', '/opt2/svc/people/users'],
    ['admin', '/internal/v1/relay'],
    ['page', '/Internal/V1/Relay/identity/sessions?next=/admin/'],
    [undefined, '/OPT2/SVC/x'],
  ] as const)('answers family %s on %s in the envelope whatever the family', (family, path) => {
    expect(surfaceForFamily(family, path)).toBe('api');
  });

  it.each(['/opt2/stubs', '/opt2/web/admin', '/internal/v1/relayed'])(
    'answers %s by its family when it only shares a namespace prefix',
    (path) => {
      expect(surfaceForFamily('opt2', path)).toBe('admin');
    },
  );

  it.each([
    ['/_api/json/v1/default/content/', 'api'],
    ['/_API/REST/v1/default/content?method=findOne', 'api'],
    ['/index.cfm/_api/json/v1/default/', 'api'],
    ['/INDEX.CFM/_api/ajax/v1/default/', 'api'],
    ['/tasks/feed/', 'api'],
    ['/index.cfm/tasks/render/file/', 'api'],
    ['/legacy-fixtures/cfml/api.cfm/finance/invoices', 'api'],
    ['/index.cfm/legacy-fixtures/cfml/api.cfm/surveys/surveys', 'api'],
    ['/', 'admin'],
    ['/index.cfm', 'admin'],
    ['/index.cfm?x=/_api/', 'admin'],
    ['/index.cfmx/_api/json/v1/', 'admin'],
    ['/admin/index.cfm/_api/json/v1/', 'admin'],
    ['/default/about/?next=/_api/json/v1/', 'admin'],
  ] as const)('answers the unkeyed path %s on the %s surface', (path, surface) => {
    expect(surfaceForFamily(undefined, path)).toBe(surface);
  });
});

describe('failContextFor', () => {
  it('chooses the surface from the path alone when no route key is known', () => {
    expect(failContextFor(undefined, '/index.cfm/_api/json/v1/default/')).toEqual({ surface: 'api' });
    expect(failContextFor(undefined, '/admin/')).toEqual({ surface: 'admin' });
  });

  it('reports no method or params on the admin surface', () => {
    const context = failContextFor(routeOf('admin', 'cusers.list', { muraaction: 'cUsers.list' }), '/admin/');
    expect(context).toStrictEqual({ surface: 'admin' });
  });

  it.each<[string, RouteKeyResult, string | undefined]>([
    ['legacy spelling of a resolved generic', routeOf('api', 'content.findone', { siteid: 'default' }), 'findOne'],
    ["caller's spelling of a direct method call", routeOf('api', 'content.findone', { method: 'FINDONE' }), 'FINDONE'],
    ['legacy spelling over a dotted method', routeOf('api', 'user.findone', { method: 'user.findOne' }), 'findOne'],
    ['legacy spelling over a stale method', routeOf('api', 'content.findone', { method: 'undefined' }), 'findOne'],
    ['legacy spelling of an empty-entity generic', routeOf('api', '.findmany', {}), 'findMany'],
    ['legacy spelling of a public method', routeOf('api', 'findcurrentuser', {}), 'findCurrentUser'],
    ['remote function name', routeOf('api', 'content.~myaction', {}), 'myaction'],
    ["caller's spelling of a remote function", routeOf('api', 'content.~myaction', { method: 'MyAction' }), 'MyAction'],
    ['REST resolved generic', routeOf('rest', 'content.findall', { method: 'findall' }), 'findall'],
    ['REST legacy spelling', routeOf('rest', 'user.findnew', {}), 'findNew'],
    ['supplied method of an HTTP-verb operation', routeOf('api', 'content.http-put', { method: 'x' }), 'x'],
    ['no method of an HTTP-verb operation', routeOf('api', 'content.http-delete', {}), undefined],
    ['supplied method of an error key', routeOf('api', '!invalid_method', { method: 'nosuch' }), 'nosuch'],
    ['supplied method of the REST oauth flow', routeOf('rest', 'oauth', { method: 'token' }), 'token'],
    ['no method of the REST oauth2 flow', routeOf('rest', 'oauth2', {}), undefined],
    ['no method of the REST tokeninfo flow', routeOf('rest', 'tokeninfo', {}), undefined],
    ['supplied method of a fixture route', routeOf('fixture', 'finance/invoices@get', { method: 'list' }), 'list'],
    ['no method of the site monitor', routeOf('sitemonitor', 'run', {}), undefined],
  ])('reports the %s in the envelope method', (_case, route, method) => {
    expect(failContextFor(route, '/_api/json/v1/default/')).toEqual({ surface: 'api', method, params: route.params });
  });

  it('reports the envelope method of an OPT-2 namespace route from its supplied value', () => {
    const route = routeOf('opt2', '/opt2/stub/items', { method: 'list' });
    expect(failContextFor(route, '/opt2/stub/items')).toEqual({ surface: 'api', method: 'list', params: route.params });
  });

  it('answers a reload on the surface and method of the route it reloads in front of', () => {
    const behind = routeOf('api', 'content.findone', { siteid: 'default' });
    const reload = routeOf('reload', 'application', { muraaction: 'cUsers.list' }, behind);
    expect(failContextFor(reload, '/_api/json/v1/default/content/abc')).toEqual({
      surface: 'api',
      method: 'findOne',
      params: behind.params,
    });
    const admin = routeOf('reload', 'application', {}, routeOf('admin', 'cusers.list', {}));
    expect(failContextFor(admin, '/admin/')).toStrictEqual({ surface: 'admin' });
  });

  it('answers a reload with no route behind it on the admin surface', () => {
    expect(failContextFor(routeOf('reload', 'application', {}), '/')).toStrictEqual({ surface: 'admin' });
  });

  it('derives the method from keys routeKeyForRequest computes', () => {
    const entityPath = '/index.cfm/_api/json/v1/default/content/abc';
    const entity = routeKeyForRequest({ method: 'GET', path: entityPath, query: {}, headers: {} });
    expect(failContextFor(entity, entityPath)).toMatchObject({ surface: 'api', method: 'findOne' });
    const reloadQuery = { muraAction: 'cUsers.list', appreload: '' };
    const reload = routeKeyForRequest({ method: 'GET', path: '/admin/', query: reloadQuery, headers: {} });
    expect(failContextFor(reload, '/admin/')).toStrictEqual({ surface: 'admin' });
  });
});

describe('isTargetUnavailable', () => {
  it.each([502, 503, 504])('classifies status %i as unavailable', (status) => {
    expect(isTargetUnavailable(status)).toBe(true);
  });

  it.each([200, 404, 500, 501, 505])('classifies status %i as an answer', (status) => {
    expect(isTargetUnavailable(status)).toBe(false);
  });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_CLOSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'FST_REPLY_FROM_TIMEOUT',
    'FST_REPLY_FROM_HTTP_REQUEST_TIMEOUT',
    'FST_REPLY_FROM_HTTP2_REQUEST_TIMEOUT',
    'FST_REPLY_FROM_HTTP2_SESSION_TIMEOUT',
    'FST_REPLY_FROM_GATEWAY_TIMEOUT',
    'FST_REPLY_FROM_SERVICE_UNAVAILABLE',
    'FST_REPLY_FROM_BAD_GATEWAY',
  ])('classifies transport code %s as unavailable on the error, its cause chain or a plain object', (code) => {
    expect(isTargetUnavailable(coded(code))).toBe(true);
    const wrapped = new Error('proxy failed', { cause: new Error('fetch failed', { cause: coded(code) }) });
    expect(isTargetUnavailable(wrapped)).toBe(true);
    expect(isTargetUnavailable({ code })).toBe(true);
    expect(isTargetUnavailable({ cause: { cause: { code } } })).toBe(true);
  });

  it('classifies a platform unavailable error anywhere in the cause chain as unavailable', () => {
    expect(isTargetUnavailable(new LegacyServiceUnavailableError())).toBe(true);
    expect(isTargetUnavailable(new ServiceUnavailableError('people', new Error('refused')))).toBe(true);
    const windowClosed = new LegacyServiceUnavailableError('closed', 'api', 'window');
    expect(isTargetUnavailable(new Error('dispatch failed', { cause: windowClosed }))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['an error without a code', new Error('boom')],
    ['an unrelated code', coded('ERR_INVALID_ARG_TYPE')],
    ['a validation error code', coded('FST_ERR_VALIDATION', new Error('bad body'))],
    ['a code that is not a string', { code: 503 }],
    ['a transport code as a bare string', 'ECONNREFUSED'],
    ['undefined', undefined],
    ['null', null],
    ['a boolean', true],
  ])('classifies %s as an answer', (_case, input) => {
    expect(isTargetUnavailable(input)).toBe(false);
  });

  it('stops at a cycle in the cause chain', () => {
    const self = new Error('self');
    self.cause = self;
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;
    expect(isTargetUnavailable(self)).toBe(false);
    expect(isTargetUnavailable(first)).toBe(false);
  });

  it('finds a transport code reached before the cause chain cycles back', () => {
    const outer: { cause?: unknown } = {};
    outer.cause = { cause: coded('ECONNRESET', outer) };
    expect(isTargetUnavailable(outer)).toBe(true);
  });
});

describe('neverSent', () => {
  it.each<[unknown, boolean]>([
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), true],
    [{ code: 'ENOTFOUND' }, true],
    [{ code: 'EAI_AGAIN' }, true],
    [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, true],
    [{ code: 'ECONNRESET' }, false],
    [{ code: 'UND_ERR_HEADERS_TIMEOUT' }, false],
    [{ code: 'FST_REPLY_FROM_TIMEOUT' }, false],
    [{ code: 'UND_ERR_SOCKET' }, false],
    [new Error('no code'), false],
    [{ code: 7 }, false],
    [undefined, false],
    [null, false],
  ])('classifies %o as never sent: %s', (error, expected) => {
    expect(neverSent(error)).toBe(expected);
  });
});

describe('isLegacyUnavailable', () => {
  it.each<[string, unknown]>([
    ['a service-kit ServiceUnavailableError', new ServiceUnavailableError('identity', coded('ETIMEDOUT'))],
    ['a legacy-compat LegacyServiceUnavailableError', new LegacyServiceUnavailableError('closed', 'admin', 'window')],
  ])('recognises %s', (_case, error) => {
    expect(isLegacyUnavailable(error)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a plain Error', new Error('Service Unavailable')],
    ['a transport-coded Error', coded('ECONNREFUSED')],
    ['a look-alike object', { name: 'LegacyServiceUnavailableError', surface: 'auto', message: 'Service Unavailable' }],
    ['undefined', undefined],
  ])('rejects %s', (_case, error) => {
    expect(isLegacyUnavailable(error)).toBe(false);
  });

  it('narrows to the platform error so its surface is readable', () => {
    const error: unknown = new LegacyServiceUnavailableError('frozen', 'api', 'freeze');
    expect(isLegacyUnavailable(error) ? error.surface : undefined).toBe('api');
  });
});

describe('failClosed', () => {
  const JSON_TYPE = 'application/json;charset=utf-8';
  const HTML_TYPE = 'text/html;charset=UTF-8';
  it.each<[string, FailContext, LegacyUnavailableResponse, string, string]>([
    [
      'the JSON API envelope with the resolved method',
      { surface: 'api', method: 'findOne', params: { siteid: 'default', method: 'findOne' } },
      apiUnavailableResponse({ method: 'findOne', params: { siteid: 'default', method: 'findOne' } }),
      JSON_TYPE,
      'Service Unavailable',
    ],
    [
      'the JSON API envelope without a method',
      { surface: 'api' },
      apiUnavailableResponse(),
      JSON_TYPE,
      'Service Unavailable',
    ],
    ['the admin error page', { surface: 'admin' }, adminUnavailableResponse(), HTML_TYPE, LEGACY_ERROR_STATUS_TEXT],
    [
      'the admin error page ignoring API inputs',
      { surface: 'admin', method: 'findOne', params: { a: '1' } },
      adminUnavailableResponse(),
      HTML_TYPE,
      LEGACY_ERROR_STATUS_TEXT,
    ],
  ])('answers 503 with %s and drops headers copied before it', async (_case, ctx, expected, type, reason) => {
    const served = await serve((reply) => {
      reply.header('x-upstream-trace', 'abc123').header('set-cookie', 'CFID=1001; Path=/').header('etag', '"stale"');
      return failClosed(reply, ctx);
    });
    expect(served.status).toBe(503);
    expect(served.statusMessage).toBe(reason);
    expect(served.body).toBe(expected.body);
    expect(served.headers['content-type']).toBe(type);
    expect(served.headers).toMatchObject(lowerCased(expected.headers));
    expect(served.headers['etag']).toBe(expected.headers['ETag']);
    expect(served.headers).not.toHaveProperty('x-upstream-trace');
    expect(served.headers).not.toHaveProperty('set-cookie');
    expect(served.returnedSameReply).toBe(true);
  });

  it('answers the JSON API envelope with the method failContextFor resolves', async () => {
    const ctx = failContextFor(routeOf('api', 'content.findone', { siteid: 'default' }), '/_api/json/v1/default/');
    const served = await serve((reply) => failClosed(reply, ctx));
    expect(JSON.parse(served.body)).toEqual({
      apiversion: 'v1',
      method: 'findOne',
      error: { message: 'Unhandled Exception', code: 'server_error' },
    });
    expect(served.headers['content-type']).toBe(JSON_TYPE);
  });

  type ReplyStep = (reply: FastifyReply) => void;
  const nothing: ReplyStep = () => undefined;
  it.each<[string, ReplyStep, ReplyStep, { sent: boolean; headersSent: boolean }, number, string]>([
    [
      'already sent',
      (reply) => void reply.code(200).send('served'),
      nothing,
      { sent: true, headersSent: true },
      200,
      'served',
    ],
    [
      'whose head already left',
      (reply) => void reply.raw.writeHead(206, { 'content-type': 'text/plain' }),
      (reply) => void reply.raw.end('partial'),
      { sent: false, headersSent: true },
      206,
      'partial',
    ],
  ])('leaves a reply %s untouched', async (_case, start, finish, state, status, body) => {
    let stateAtCall: { sent: boolean; headersSent: boolean } | undefined;
    const served = await serve((reply) => {
      start(reply);
      stateAtCall = { sent: reply.sent, headersSent: reply.raw.headersSent };
      const returned = failClosed(reply, { surface: 'admin' });
      finish(reply);
      return returned;
    });
    expect(stateAtCall).toEqual(state);
    expect(served.status).toBe(status);
    expect(served.body).toBe(body);
    expect(served.returnedSameReply).toBe(true);
  });
});
