import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { DestinationStream } from 'pino';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  collectRouteMatrix,
  type AuthOverrides,
  type TransportAuthenticator,
  type UserClaims,
} from '../../src/auth/index.js';
import {
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_HTML_CONTENT_TYPE,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  etag,
  legacyErrorResponse,
} from '../../src/legacy-compat/index.js';
import { createLogger, validateLogRecord, type Logger } from '../../src/logging/index.js';
import { tenantIdForSite, type TenantDb } from '../../src/tenancy/index.js';
import {
  MemorySpanExporter,
  SpanKind,
  flushTracing,
  shutdownTracing,
  startSpan,
  startTracing,
} from '../../src/tracing/index.js';
import { ServiceUnavailableError, UnknownServiceError } from '../../src/service-kit/client.js';
import { currentRequestContext } from '../../src/service-kit/context.js';
import {
  LEGACY_POST_LIMIT_BYTES,
  createService,
  defaultSurfaceOf,
  legacyParamsOf,
  multipartFilesOf,
  sendLegacyResponse,
  type CreateServiceOptions,
} from '../../src/service-kit/create-service.js';
import { loadEnv, type BaseEnv } from '../../src/service-kit/env.js';

vi.mock('../../src/tracing/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tracing/index.js')>();
  return { ...actual, shutdownTracing: vi.fn(actual.shutdownTracing) };
});

const TENANT_A_ID = tenantIdForSite('tenant-a');
const USER_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const USER_TOKEN = 'user-token-a';
const SERVICE_CREDENTIAL = 'Bearer svc-gateway';

const CLAIMS: UserClaims = {
  iss: 'opt2-local-identity',
  aud: 'opt2-local',
  sub: USER_ID,
  sid: 'session-1',
  tid: TENANT_A_ID,
  site: 'tenant-a',
  roles: ['s2'],
  s2: true,
  epoch: 1,
  iat: 1_700_000_000,
  exp: 4_000_000_000,
};

const ENV: BaseEnv = loadEnv(undefined, {
  PORT: '26011',
  OPT2_SERVICE_NAME: 'people',
  OPT2_ENV: 'local',
  OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
  OPT2_TOKEN_ISSUER: 'opt2-local-identity',
  OPT2_TOKEN_AUDIENCE: 'opt2-local',
  OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-create-service-unit-unused'),
  TZ: 'UTC',
});

function managedTransport(transport: 'pubsub-push' | 'cloud-tasks'): TransportAuthenticator {
  return { transport, authenticate: async () => ({ service: { name: `${transport}-invoker`, roles: [] } }) };
}

const OVERRIDES: AuthOverrides = {
  userVerifier: {
    async verify(token) {
      if (token !== USER_TOKEN) throw AuthDenial.invalidToken();
      return CLAIMS;
    },
  },
  invocationVerifier: {
    async verify(header) {
      if (header !== SERVICE_CREDENTIAL) throw AuthDenial.unauthenticated('invalid-credential');
      return { name: 'gateway', roles: ['service:gateway'] };
    },
  },
  invocationMinter: { headersFor: async (target) => ({ [INVOCATION_HEADER]: `Bearer svc-${target.name}` }) },
  transports: { 'pubsub-push': managedTransport('pubsub-push'), 'cloud-tasks': managedTransport('cloud-tasks') },
};

const AUTHENTICATED = { [INVOCATION_HEADER]: SERVICE_CREDENTIAL, authorization: `Bearer ${USER_TOKEN}` };

type LogLine = Record<string, unknown>;

function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const destination: DestinationStream = { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) };
  return { logger: createLogger({ service: 'people', version: '1.0.0', env: 'local', destination }), lines };
}

const apps: FastifyInstance[] = [];

async function build(
  overrides: Partial<CreateServiceOptions> = {},
): Promise<{ app: FastifyInstance; lines: LogLine[] }> {
  const { logger, lines } = captureLogger();
  const app = await createService({
    name: 'people',
    version: '1.0.0',
    env: ENV,
    verifierOverride: OVERRIDES,
    logger,
    ...overrides,
  });
  apps.push(app);
  return { app, lines };
}

function completedLines(lines: LogLine[]): LogLine[] {
  return lines.filter((line) => line.message === 'request completed');
}

function multipartBody(boundary: string, parts: Array<{ name: string; value: string; filename?: string; type?: string }>): string {
  const sections = parts.map(({ name, value, filename, type }) => {
    const disposition = `Content-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}`;
    const contentType = type === undefined ? '' : `\r\nContent-Type: ${type}`;
    return `--${boundary}\r\n${disposition}${contentType}\r\n\r\n${value}\r\n`;
  });
  return `${sections.join('')}--${boundary}--\r\n`;
}

const MIB = 1024 * 1024;

/** A lazily generated multipart body of `count` file or field parts of `mib` MiB each, with its length and the bytes pulled from it so far. */
function lazyMultipartBody(
  boundary: string,
  kind: 'file' | 'field',
  count: number,
  mib: number,
): { body: Readable; length: number; pulled: () => number } {
  const chunk = Buffer.alloc(MIB, 'x');
  const crlf = Buffer.from('\r\n');
  const tail = Buffer.from(`--${boundary}--\r\n`);
  const heads = Array.from({ length: count }, (_, i) => {
    const name = `part${String(i)}`;
    const filename = kind === 'file' ? `; filename="${name}.bin"` : '';
    return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename}\r\n\r\n`);
  });
  let pulled = 0;
  const take = (piece: Buffer): Buffer => {
    pulled += piece.length;
    return piece;
  };
  function* pieces(): Generator<Buffer> {
    for (const head of heads) {
      yield take(head);
      for (let n = 0; n < mib; n += 1) yield take(chunk);
      yield take(crlf);
    }
    yield take(tail);
  }
  const length = heads.reduce((sum, head) => sum + head.length + mib * MIB + crlf.length, tail.length);
  return { body: Readable.from(pieces()), length, pulled: () => pulled };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.mocked(shutdownTracing).mockClear();
});

describe('defaultSurfaceOf', () => {
  it.each([
    ['/admin', 'admin'],
    ['/admin/?muraAction=cusers.list', 'admin'],
    ['/admin-actions/cusers/update', 'admin'],
    ['/admin-raw/carch/loaddiff', 'admin'],
    ['/administrator', 'api'],
    ['/admin-actions', 'api'],
    ['/_api/json/v1/default/content', 'api'],
    ['/legacy-fixtures/cfml/api.cfm/people/persons', 'api'],
  ])('maps %s to %s', (url, surface) => {
    expect(defaultSurfaceOf({ url } as FastifyRequest)).toBe(surface);
  });
});

describe('createService options', () => {
  it('exposes the legacy post limit of 100 MB', () => {
    expect(LEGACY_POST_LIMIT_BYTES).toBe(104_857_600);
  });

  it('rejects pool and schema together with a TypeError', async () => {
    const pool = { end: vi.fn() } as unknown as TenantDb;
    await expect(build({ pool, schema: 'people' })).rejects.toBeInstanceOf(TypeError);
  });

  it('refuses a schema when the environment has no database settings', async () => {
    await expect(build({ schema: 'people' })).rejects.toThrow(/OPT2_DB_AUTH and PG_DATABASE/);
  });

  it('opens the schema pool from the environment and ends it on shutdown', async () => {
    const env: BaseEnv = {
      ...ENV,
      OPT2_DB_AUTH: 'password',
      PG_HOST: '127.0.0.1',
      PG_PORT: 9,
      PG_DATABASE: 'unused',
      PG_USER: 'unused',
      PG_PASSWORD: 'unused',
    };
    const { app } = await build({ env, schema: 'people' });
    expect(app.opt2.db?.schema).toBe('people');
    await app.opt2.shutdown();
  });

  it('builds the default logger and system clock when none are given', async () => {
    const app = await createService({ name: 'people', version: '1.0.0', env: ENV, verifierOverride: OVERRIDES });
    apps.push(app);
    expect(app.opt2).toMatchObject({ name: 'people', version: '1.0.0', env: ENV });
    expect(app.opt2.clock.now()).toBeInstanceOf(Date);
    expect(typeof app.opt2.logger.info).toBe('function');
    expect(app.opt2.db).toBeUndefined();
  });

  it('maps the gateway, migration and configured services on the service client', async () => {
    const received: Array<{ url?: string; credential?: string | string[] }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      received.push({ url: req.url, credential: req.headers[INVOCATION_HEADER] });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const env: BaseEnv = {
        ...ENV,
        OPT2_GATEWAY_URL: origin,
        OPT2_MIGRATION_URL: origin,
        OPT2_SERVICE_URLS: { identity: origin },
      };
      const { app } = await build({ env });
      for (const service of ['gateway', 'migration', 'identity']) {
        const response = await app.opt2.client.request({ service, method: 'GET', path: `/${service}` });
        expect(response).toMatchObject({ status: 200, body: { ok: true } });
      }
      await expect(app.opt2.client.request({ service: 'finance', method: 'GET', path: '/' })).rejects.toBeInstanceOf(
        UnknownServiceError,
      );
      expect(received).toStrictEqual([
        { url: '/gateway', credential: 'Bearer svc-gateway' },
        { url: '/migration', credential: 'Bearer svc-migration' },
        { url: '/identity', credential: 'Bearer svc-identity' },
      ]);
      await app.opt2.shutdown();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('health, deny by default and legacy headers', () => {
  it('answers /healthz publicly with the legacy headers, with and without the trailing slash', async () => {
    const { app } = await build();
    for (const url of ['/healthz', '/healthz/']) {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-request-id': 'probe-1' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({ status: 'ok' });
      expect(res.headers.generator).toBe('Masa CMS 7.6.1');
      expect(res.headers['strict-transport-security']).toBe('max-age=1200');
      expect(res.headers['x-request-id']).toBeUndefined();
    }
  });

  const NOT_FOUND_BODY = legacyErrorResponse('invalidMethodCall', { method: 'findOne', mura404: true }).body;
  const NOT_FOUND_HEAD = { status: 404, type: LEGACY_JSON_CONTENT_TYPE, body: NOT_FOUND_BODY, tag: etag(NOT_FOUND_BODY) };

  it.each([
    { label: 'a GET route', url: '/v1/get-only', methods: ['GET'], head: NOT_FOUND_HEAD },
    { label: '/healthz', url: '/healthz', methods: ['GET'], head: NOT_FOUND_HEAD },
    {
      label: 'a route declaring HEAD',
      url: '/v1/get-and-head',
      methods: ['GET', 'HEAD'],
      head: { status: 200, type: 'text/plain; charset=utf-8', body: 'listed', tag: undefined },
    },
  ])('registers only the methods $label declares and answers its HEAD with $head.status', async ({ url, methods, head }) => {
    const { app } = await build();
    app.get('/v1/get-only', { config: { opt2: { public: true } } }, () => 'listed');
    app.route({ method: ['GET', 'HEAD'], url: '/v1/get-and-head', config: { opt2: { public: true } }, handler: () => 'listed' });
    await app.ready();
    const registered = collectRouteMatrix(app).routes.filter((route) => route.url === url);
    expect(registered.map((route) => route.method)).toStrictEqual(methods);
    const res = await app.inject({ method: 'HEAD', url: `${url}?method=findOne` });
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body, tag: res.headers.etag }).toStrictEqual(head);
  });

  it('fails start-up for a route without a config.opt2 declaration', async () => {
    const { app } = await build();
    expect(() => app.get('/undeclared', async () => 'never')).toThrow(/no config\.opt2 declaration/);
    const { app: pluginApp } = await build();
    void pluginApp.register(async (child) => {
      child.get('/undeclared-in-plugin', async () => 'never');
    });
    await expect(pluginApp.ready()).rejects.toThrow(/no config\.opt2 declaration/);
  });

  it('keeps a header the route already set', async () => {
    const { app } = await build();
    app.get('/custom', { config: { opt2: { public: true } } }, async (_request, reply) =>
      reply.header('Generator', 'custom').send('x'),
    );
    const res = await app.inject({ method: 'GET', url: '/custom' });
    expect(res.headers.generator).toBe('custom');
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
  });

  it('answers a missing credential with the legacy 401 and the legacy headers', async () => {
    const { app } = await build();
    app.get('/secured', { config: { opt2: { requires: ['s2'] } } }, async () => 'never');
    const res = await app.inject({ method: 'GET', url: '/secured' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
  });
});

describe('legacy error mapping', () => {
  async function failing(error: unknown, url = '/fail'): Promise<FastifyInstance> {
    const { app } = await build();
    app.get(url, { config: { opt2: { public: true } } }, async () => {
      throw error;
    });
    return app;
  }

  it.each([
    ['badRequest', 400, 'invalid_request', 'Bad Request'],
    ['invalidAccessToken', 401, 'invalid_token', 'Invalid Access Token'],
    ['invalidTokens', 400, 'invalid_request', 'Invalid CSRF tokens'],
  ])('renders LegacyApiError(%s) as the legacy %i envelope', async (type, status, code, message) => {
    const app = await failing(new LegacyApiError(type));
    const res = await app.inject({ method: 'GET', url: '/fail?method=findOne&siteid=tenant-a' });
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.headers.etag).toMatch(/^[0-9A-F]+$/);
    expect(res.headers.etag).toBe(etag(res.body));
    expect(res.json()).toStrictEqual({ apiversion: 'v1', method: 'findOne', error: { code, message } });
    expect(res.body).toBe(legacyErrorResponse(type, { method: 'findOne' }).body);
  });

  it('prefers the method, params and challenge the LegacyApiError carries', async () => {
    const app = await failing(
      new LegacyApiError('invalidAccessToken', { method: 'findMany', wwwAuthenticate: 'Bearer error="invalid_access_token"' }),
    );
    const res = await app.inject({ method: 'GET', url: '/fail?method=findOne' });
    expect(res.json()).toMatchObject({ method: 'findMany' });
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_access_token"');
  });

  it('renders a thrown AuthDenial at its own status', async () => {
    const app = await failing(AuthDenial.siteMismatch());
    const res = await app.inject({ method: 'GET', url: '/fail' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } });
  });

  it('answers a siteid other than the token site with 403', async () => {
    const { app } = await build();
    app.get('/sites', { config: { opt2: { requires: ['s2'] } } }, async () => 'never');
    const res = await app.inject({ method: 'GET', url: '/sites?siteid=tenant-b', headers: AUTHENTICATED });
    expect(res.statusCode).toBe(403);
  });

  it('answers an unmatched API route with the 404 invalidMethodCall envelope', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/_api/json/v1/tenant-a/nothing?method=findOne' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.json()).toStrictEqual({
      apiversion: 'v1',
      method: 'findOne',
      error: { code: 'invalid_request', message: 'Invalid method call' },
    });
    expect(res.headers.etag).toBe(etag(res.body));
  });

  it('answers an unmatched admin route with the legacy error page at 404', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/admin/nothing' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
  });

  it('answers an unhandled API error with the 500 server_error envelope and logs it without detail', async () => {
    const { app, lines } = await build();
    app.get('/boom', { config: { opt2: { public: true } } }, async () => {
      throw new Error('password=hunter2 leaked');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toStrictEqual({
      apiversion: 'v1',
      method: 'invalid',
      error: { code: 'server_error', message: 'Unhandled Exception' },
    });
    expect(res.body).not.toMatch(/hunter2|\bat /);
    const errorLine = lines.find((line) => line.message === 'unhandled error');
    expect(errorLine).toMatchObject({ severity: 'ERROR', error: { type: 'Error' } });
    expect(validateLogRecord(errorLine).errors).toStrictEqual([]);
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });

  it('answers an unhandled admin error with the legacy error page and reason phrase', async () => {
    const app = await failing(new Error('boom'), '/admin-actions/carch/update');
    const res = await app.inject({ method: 'GET', url: '/admin-actions/carch/update' });
    expect(res.statusCode).toBe(500);
    expect(res.statusMessage).toBe(LEGACY_ERROR_STATUS_TEXT);
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
  });

  it.each([
    ['a LegacyServiceUnavailableError', new LegacyServiceUnavailableError()],
    ['a ServiceUnavailableError', new ServiceUnavailableError('identity', new Error('ECONNREFUSED'))],
  ])('answers %s on the API surface with the legacy 503 envelope and logs a warning', async (_label, error) => {
    const { app, lines } = await build();
    app.get('/busy', { config: { opt2: { public: true } } }, async () => {
      throw error;
    });
    const res = await app.inject({ method: 'GET', url: '/busy?method=save' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.json()).toStrictEqual({
      apiversion: 'v1',
      method: 'save',
      error: { code: 'server_error', message: 'Unhandled Exception' },
    });
    expect(lines.find((line) => line.message === 'service unavailable')).toMatchObject({ severity: 'WARNING' });
  });

  it.each([
    ['an admin-actions route', new LegacyServiceUnavailableError(), '/admin-actions/cusers/update'],
    ['an error that names the admin surface', new LegacyServiceUnavailableError('busy', 'admin'), '/_api/x'],
  ])('answers %s with the admin 503 page', async (_label, error, url) => {
    const app = await failing(error, url);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(503);
    expect(res.statusMessage).toBe(LEGACY_ERROR_STATUS_TEXT);
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
  });

  it('answers a schema validation failure with invalidParameters', async () => {
    const { app } = await build();
    app.get(
      '/validated',
      {
        config: { opt2: { public: true } },
        schema: { querystring: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
      async () => 'never',
    );
    const res = await app.inject({ method: 'GET', url: '/validated' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
  });

  it('answers a Fastify client error with badRequest', async () => {
    const { app } = await build();
    app.post('/small', { bodyLimit: 8, config: { opt2: { public: true } } }, async () => 'never');
    const res = await app.inject({
      method: 'POST',
      url: '/small',
      headers: { 'content-type': 'application/json' },
      payload: '{"payload":"far too long"}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Bad Request' } });
  });
});

describe('body parsing and legacy params', () => {
  async function echo(): Promise<FastifyInstance> {
    const { app } = await build();
    app.post('/echo', { config: { opt2: { public: true } } }, async (request) => ({
      bodyIsUndefined: request.body === undefined,
      isBuffer: Buffer.isBuffer(request.body),
      params: legacyParamsOf(request),
      files: multipartFilesOf(request).map(({ data, ...file }) => ({ ...file, data: data.toString('utf8') })),
    }));
    return app;
  }

  it.each([
    ['invalid JSON', 'application/json', '{not json'],
    ['an empty JSON body', 'application/json', ''],
    ['invalid JSON', 'application/json-patch+json', '{not json'],
    ['an empty JSON body', 'APPLICATION/JSONX; charset=utf-8', ''],
  ])('hands %s sent as %s to the handler as undefined', async (_label, contentType, payload) => {
    const app = await echo();
    const res = await app.inject({ method: 'POST', url: '/echo?a=1', headers: { 'content-type': contentType }, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ bodyIsUndefined: true, isBuffer: false, params: { a: '1' }, files: [] });
  });

  it.each([
    'application/json; charset=utf-8',
    'application/json-patch+json',
    'application/jsonx',
    'APPLICATION/JSON-PATCH+JSON; charset=utf-8',
  ])('merges a JSON body sent as %s over the query: scalars as strings, null as empty, objects kept', async (contentType) => {
    const app = await echo();
    const res = await app.inject({
      method: 'POST',
      url: '/echo?N=1&siteid=default',
      headers: { 'content-type': contentType },
      payload: '{"n":5,"flag":true,"nil":null,"obj":{"a":1},"arr":[1,2],"__proto__":{"polluted":true}}',
    });
    expect(res.json<{ params: unknown }>().params).toStrictEqual({
      siteid: 'default',
      n: '5',
      flag: 'true',
      nil: '',
      obj: { a: 1 },
      arr: [1, 2],
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('joins repeated form keys with commas and lets the body override the query ignoring case', async () => {
    const app = await echo();
    const res = await app.inject({
      method: 'POST',
      url: '/echo?siteid=default&q=z&tag=x&tag=y',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1&a=2&SiteID=tenant-b',
    });
    expect(res.json().params).toStrictEqual({ q: 'z', tag: 'x,y', a: '1,2', SiteID: 'tenant-b' });
  });

  it('takes multipart field values and file names, and buffers the files in body order', async () => {
    const app = await echo();
    const boundary = 'opt2boundary';
    const res = await app.inject({
      method: 'POST',
      url: '/echo?title=query',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [
        { name: 'title', value: 'Hello' },
        { name: 'newFile', value: 'png-bytes', filename: 'a.png', type: 'image/png' },
        { name: 'tag', value: 'one' },
        { name: 'attach', value: '%PDF', filename: 'b.pdf', type: 'application/pdf' },
        { name: 'tag', value: 'two' },
        { name: 'newFile', value: 'gif-bytes', filename: 'c.gif', type: 'image/gif' },
      ]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      params: { title: 'Hello', newFile: 'a.png,c.gif', tag: 'one,two', attach: 'b.pdf' },
      files: [
        { field: 'newFile', filename: 'a.png', mimetype: 'image/png', data: 'png-bytes' },
        { field: 'attach', filename: 'b.pdf', mimetype: 'application/pdf', data: '%PDF' },
        { field: 'newFile', filename: 'c.gif', mimetype: 'image/gif', data: 'gif-bytes' },
      ],
    });
  });

  it.each([
    { sent: 'with its Content-Length', kind: 'file', count: 4, mib: 75, declared: true, pulled: [0, 0] },
    { sent: 'chunked, as files', kind: 'file', count: 4, mib: 75, declared: false, pulled: [LEGACY_POST_LIMIT_BYTES, LEGACY_POST_LIMIT_BYTES + 4 * MIB] },
    { sent: 'chunked, as fields', kind: 'field', count: 300, mib: 1, declared: false, pulled: [LEGACY_POST_LIMIT_BYTES, LEGACY_POST_LIMIT_BYTES + 4 * MIB] },
  ] as const)(
    'answers a multipart body over the post limit sent $sent with badRequest, reading no further than the limit',
    async ({ kind, count, mib, declared, pulled: [least, most] }) => {
      const app = await echo();
      const boundary = 'opt2boundary';
      const { body, length, pulled } = lazyMultipartBody(boundary, kind, count, mib);
      expect(length).toBeGreaterThan(LEGACY_POST_LIMIT_BYTES);
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          ...(declared ? { 'content-length': String(length) } : {}),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers.connection).toBe('close');
      expect(res.body).toBe(legacyErrorResponse('badRequest').body);
      expect(pulled()).toBeGreaterThanOrEqual(least);
      expect(pulled()).toBeLessThanOrEqual(most);
    },
  );

  it('still buffers every file of a multipart body just under the post limit', async () => {
    const { app } = await build();
    app.post('/sizes', { config: { opt2: { public: true } } }, (request) =>
      multipartFilesOf(request).map(({ filename, data }) => ({ filename, size: data.length })),
    );
    const boundary = 'opt2boundary';
    const { body, length } = lazyMultipartBody(boundary, 'file', 3, 33);
    expect(length).toBeLessThan(LEGACY_POST_LIMIT_BYTES);
    const res = await app.inject({
      method: 'POST',
      url: '/sizes',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(length) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual(['part0.bin', 'part1.bin', 'part2.bin'].map((filename) => ({ filename, size: 33 * MIB })));
  });

  it('hands other content types to the handler as a raw Buffer', async () => {
    const app = await echo();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isBuffer: true, params: {}, files: [] });
  });

  it('writes a legacy response object with its status, headers, reason phrase and body', async () => {
    const { app } = await build();
    app.get('/legacy', { config: { opt2: { public: true } } }, async (_request, reply) =>
      sendLegacyResponse(reply, { status: 202, statusText: 'Queued', headers: { 'Content-Type': 'text/csv' }, body: 'a,b' }),
    );
    const res = await app.inject({ method: 'GET', url: '/legacy' });
    expect(res.statusCode).toBe(202);
    expect(res.statusMessage).toBe('Queued');
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.body).toBe('a,b');
  });
});

describe('request scope and context', () => {
  async function whoami(): Promise<FastifyInstance> {
    const { app } = await build();
    const handler = async (request: FastifyRequest) => {
      const store = currentRequestContext();
      return {
        scope: request.opt2,
        requestId: store?.requestId,
        tenantId: store?.tenantId,
        site: store?.site,
        userToken: store?.userToken,
        caller: store?.service?.name,
      };
    };
    app.get('/whoami', { config: { opt2: { requires: ['s2'] } } }, handler);
    app.post('/whoami', { config: { opt2: { requires: ['s2'] } } }, handler);
    return app;
  }

  it.each([
    ['GET', undefined],
    ['POST', '{"siteid":"tenant-a"}'],
  ] as const)('takes tenant and site from the verified token on %s, inside the request context', async (method, payload) => {
    const app = await whoami();
    const res = await app.inject({
      method,
      url: '/whoami',
      headers: { ...AUTHENTICATED, 'x-request-id': 'req-ctx', 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({
      scope: { tenantId: TENANT_A_ID, site: 'tenant-a' },
      requestId: 'req-ctx',
      tenantId: TENANT_A_ID,
      site: 'tenant-a',
      userToken: USER_TOKEN,
      caller: 'gateway',
    });
  });

  it('keeps the request context across body parsing on a real socket', async () => {
    const app = await whoami();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
      method: 'POST',
      headers: { ...AUTHENTICATED, 'x-request-id': 'req-socket', 'content-type': 'application/json' },
      body: JSON.stringify({ siteid: 'tenant-a', padding: 'x'.repeat(256 * 1024) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requestId: 'req-socket', tenantId: TENANT_A_ID, userToken: USER_TOKEN });
  });

  it('gives an anonymous request an empty scope', async () => {
    const { app } = await build();
    app.get('/anon', { config: { opt2: { public: true } } }, async (request) => ({ scope: request.opt2 }));
    const res = await app.inject({ method: 'GET', url: '/anon' });
    expect(res.json()).toStrictEqual({ scope: {} });
  });

  it('adds request, tenant, site, user and caller attributes to the active span', async () => {
    const exporter = new MemorySpanExporter();
    await startTracing({ serviceName: 'people', version: '1.0.0', exporter });
    try {
      const app = await whoami();
      await app.ready();
      await startSpan('server', SpanKind.SERVER, () =>
        app.inject({ method: 'GET', url: '/whoami', headers: { ...AUTHENTICATED, 'x-request-id': 'req-span' } }),
      );
      await flushTracing();
      const span = exporter.getFinishedSpans().find((finished) => finished.name === 'server');
      expect(span?.attributes).toMatchObject({
        'http.route': '/whoami',
        'opt2.request_id': 'req-span',
        'opt2.tenant_id': TENANT_A_ID,
        'opt2.site': 'tenant-a',
        'enduser.id': USER_ID,
        'opt2.caller': 'gateway',
      });
    } finally {
      await shutdownTracing();
    }
  });
});

describe('request log line', () => {
  it('writes exactly one valid line per request with the inbound request id and no query string', async () => {
    const { app, lines } = await build();
    app.get('/items/:id', { config: { opt2: { requires: ['s2'] } } }, async () => ({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/items/abc?key=push-key-value',
      headers: { ...AUTHENTICATED, 'x-request-id': 'req-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeUndefined();
    const completed = completedLines(lines);
    expect(completed).toHaveLength(1);
    const [line] = completed;
    expect(validateLogRecord(line).errors).toStrictEqual([]);
    expect(line).toMatchObject({
      severity: 'INFO',
      service: 'people',
      version: '1.0.0',
      requestId: 'req-123',
      route: '/items/:id',
      httpMethod: 'GET',
      statusCode: 200,
      tenantId: TENANT_A_ID,
      userId: USER_ID,
    });
    expect(line?.latencyMs).toEqual(expect.any(Number));
    expect(JSON.stringify(lines)).not.toContain('push-key-value');
  });

  it('logs an unmatched request by its path, without tenant or user', async () => {
    const { app, lines } = await build();
    await app.inject({ method: 'GET', url: '/nothing/here?key=push-key-value' });
    const completed = completedLines(lines);
    expect(completed).toHaveLength(1);
    expect(validateLogRecord(completed[0]).errors).toStrictEqual([]);
    expect(completed[0]).toMatchObject({ route: '/nothing/here', statusCode: 404 });
    expect(completed[0]).not.toHaveProperty('tenantId');
    expect(completed[0]).not.toHaveProperty('userId');
    expect(typeof completed[0]?.requestId).toBe('string');
  });
});

describe('graceful shutdown', () => {
  function fakeDb(end: () => Promise<void>): TenantDb & { end: ReturnType<typeof vi.fn> } {
    return { schema: 'people', withTenant: vi.fn(), withMetadata: vi.fn(), end: vi.fn(end) };
  }

  it('closes the app, then the pool, then tracing, once', async () => {
    const db = fakeDb(async () => undefined);
    const { app } = await build({ pool: db });
    const close = vi.spyOn(app, 'close');
    const first = app.opt2.shutdown();
    expect(app.opt2.shutdown()).toBe(first);
    await first;
    const traced = vi.mocked(shutdownTracing);
    expect(close).toHaveBeenCalledTimes(1);
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(traced).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(db.end.mock.invocationCallOrder[0] ?? 0);
    expect(db.end.mock.invocationCallOrder[0]).toBeLessThan(traced.mock.invocationCallOrder[0] ?? 0);
  });

  it('still closes the client, the pool and tracing, in order, when closing the app fails', async () => {
    const hookError = new Error('hook failed');
    const db = fakeDb(() => Promise.resolve());
    const { app } = await build({ pool: db });
    app.addHook('onClose', (_instance, done) => {
      done(hookError);
    });
    const clientClose = vi.spyOn(app.opt2.client, 'close');
    await expect(app.opt2.shutdown()).rejects.toBe(hookError);
    const traced = vi.mocked(shutdownTracing);
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(db.end.mock.calls).toHaveLength(1);
    expect(traced).toHaveBeenCalledTimes(1);
    expect(clientClose.mock.invocationCallOrder[0]).toBeLessThan(db.end.mock.invocationCallOrder[0] ?? 0);
    expect(db.end.mock.invocationCallOrder[0]).toBeLessThan(traced.mock.invocationCallOrder[0] ?? 0);
  });

  it('rejects with an AggregateError of every failed step, in step order, and still stops tracing', async () => {
    const hookError = new Error('hook failed');
    const poolError = new Error('pool stuck');
    const { app } = await build({ pool: fakeDb(() => Promise.reject(poolError)) });
    app.addHook('onClose', (_instance, done) => {
      done(hookError);
    });
    const failure: unknown = await app.opt2.shutdown().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors: unknown[] = (failure as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(hookError);
    expect(errors[1]).toBe(poolError);
    expect(vi.mocked(shutdownTracing)).toHaveBeenCalledTimes(1);
  });

  it('shuts down on SIGTERM and removes its listener once closed', async () => {
    const before = process.listeners('SIGTERM');
    const db = fakeDb(async () => undefined);
    const { app } = await build({ pool: db });
    const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    added[0]?.('SIGTERM');
    await vi.waitFor(() => expect(vi.mocked(shutdownTracing)).toHaveBeenCalledTimes(1));
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(process.listeners('SIGTERM')).not.toContain(added[0]);
    expect(app.opt2.shutdown()).toBeInstanceOf(Promise);
  });

  it('removes its SIGTERM listener when the app is closed directly', async () => {
    const before = process.listeners('SIGTERM');
    const { app } = await build();
    const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
    await app.close();
    expect(process.listeners('SIGTERM')).not.toContain(added[0]);
  });

  it.each([
    { failing: 'the pool', hookFails: false, types: ['Error'] },
    { failing: 'the app and the pool', hookFails: true, types: ['RangeError', 'Error'] },
  ])('logs each failure of a SIGTERM shutdown ($failing) and sets a failing exit code', async ({ hookFails, types }) => {
    const previousExitCode = process.exitCode;
    const before = process.listeners('SIGTERM');
    const { app, lines } = await build({ pool: fakeDb(async () => Promise.reject(new Error('pool stuck'))) });
    if (hookFails) {
      app.addHook('onClose', (_instance, done) => {
        done(new RangeError('hook failed'));
      });
    }
    const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
    try {
      added[0]?.('SIGTERM');
      await vi.waitFor(() => {
        expect(process.exitCode).toBe(1);
      });
      const failed = lines.filter((line) => line.message === 'shutdown failed');
      expect(failed.map((line) => line.severity)).toStrictEqual(types.map(() => 'ERROR'));
      expect(failed.map((line) => (line.error as { type?: unknown } | undefined)?.type)).toStrictEqual(types);
      expect(app.server.listening).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
