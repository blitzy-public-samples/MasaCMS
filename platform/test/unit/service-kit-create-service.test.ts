import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, maxHeaderSize, request as httpRequest, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';
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
import { REDACTED, createLogger, validateLogRecord, type Logger } from '../../src/logging/index.js';
import { tenantIdForSite, type TenantDb } from '../../src/tenancy/index.js';
import { mintUserToken } from '../../src/testing/index.js';
import {
  MemorySpanExporter,
  SpanKind,
  flushTracing,
  shutdownTracing,
  startSpan,
  startTracing,
} from '../../src/tracing/index.js';
import { ServiceUnavailableError, UnknownServiceError } from '../../src/service-kit/client.js';
import { currentRequestContext, throwIfRequestAborted } from '../../src/service-kit/context.js';
import {
  LEGACY_POST_LIMIT_BYTES,
  abandonOnDisconnect,
  createService,
  defaultSurfaceOf,
  isUnstorableTextError,
  legacyParamsOf,
  multipartFilesOf,
  recordOutcomeReason,
  sendLegacyResponse,
  type CreateServiceOptions,
  type LegacyParamsOptions,
} from '../../src/service-kit/create-service.js';
import { loadEnv, type BaseEnv } from '../../src/service-kit/env.js';
import { recordEventScope } from '../../src/service-kit/event-scope.js';

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

function sha256Hex(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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

  it.each([
    { LOG_LEVEL: undefined, level: 'info' },
    { LOG_LEVEL: 'debug', level: 'debug' },
  ] as const)('builds the default logger at LOG_LEVEL $LOG_LEVEL ($level) and system clock when none are given', async ({ LOG_LEVEL, level }) => {
    const env: BaseEnv = { ...ENV, LOG_LEVEL };
    const app = await createService({ name: 'people', version: '1.0.0', env, verifierOverride: OVERRIDES });
    apps.push(app);
    expect(app.opt2).toMatchObject({ name: 'people', version: '1.0.0', env });
    expect(app.opt2.clock.now()).toBeInstanceOf(Date);
    expect(typeof app.opt2.logger.info).toBe('function');
    expect(app.opt2.logger.level).toBe(level);
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

describe('no-case path prefixes', () => {
  const PREFIXES = ['/_api/sitemonitor', '/index.cfm/_api/sitemonitor'];

  /** A service with a public probe under each prefix and one internal path, each echoing the URL it was routed under. */
  async function probed(overrides: Partial<CreateServiceOptions> = { noCasePathPrefixes: PREFIXES }): Promise<FastifyInstance> {
    const { app } = await build(overrides);
    for (const url of [...PREFIXES.map((prefix) => `${prefix}*`), '/internal/v1/probe']) {
      app.get(url, { config: { opt2: { public: true } } }, async (request) => ({ url: request.url, originalUrl: request.originalUrl }));
    }
    return app;
  }

  it.each([
    ['/_API/SITEMONITOR/', '/_api/sitemonitor/'],
    ['/_Api/SiteMonitor?siteid=Tenant-A&x=%2F&y=%41', '/_api/sitemonitor?siteid=Tenant-A&x=%2F&y=%41'],
    ['/_api/%53ITEMONITOR%2FRest?siteid=x', '/_api/sitemonitor%2FRest?siteid=x'],
    ['/%5F%61pi/sitemonitorX', '/_api/sitemonitorX'],
    ['/_api%2Fsitemonitor', '/_api/sitemonitor'],
    ['/_API%2fSITEMONITOR/', '/_api/sitemonitor/'],
    ['/Index.CFM/_Api/SiteMonitor/', '/index.cfm/_api/sitemonitor/'],
    ['/_api/sitemonitor', '/_api/sitemonitor'],
  ])('routes %s under the declared spelling as %s', async (url, routed) => {
    const app = await probed();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ url: routed, originalUrl: url });
  });

  it.each([
    ['a double-encoded slash', '/_api%252Fsitemonitor', 404],
    ['a malformed escape', '/_API/%ZZitemonitor', 400],
    ['an incomplete UTF-8 escape', '/_API/%C3itemonitor', 400],
    ['a shorter path', '/_API/SITEMONITO', 404],
    ['a prefix not at the start', '/x/_API/SITEMONITOR', 404],
    ['an internal path in another case', '/INTERNAL/v1/probe', 404],
  ])('leaves %s (%s) unrouted with %i', async (_label, url, status) => {
    const app = await probed();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(status);
  });

  it('routes the longest matching prefix under its own spelling', async () => {
    const { app } = await build({ noCasePathPrefixes: ['/_api', '/_api/sitemonitor'] });
    app.get('/_api/*', { config: { opt2: { public: true } } }, async (request) => request.url);
    const res = await app.inject({ method: 'GET', url: '/_API/SITEMONITOR/Run' });
    expect(res.body).toBe('/_api/sitemonitor/Run');
  });

  it.each([{}, { noCasePathPrefixes: [] }])('keeps routing case-sensitive with %j', async (overrides) => {
    const app = await probed(overrides);
    expect((await app.inject({ method: 'GET', url: '/_API/SITEMONITOR/' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/_api/sitemonitor/' })).statusCode).toBe(200);
  });

  it.each(['_api/sitemonitor', '', '/_api?x', '/a#b', '/a%20b', '/a b', '/ümlaut'])(
    'rejects the prefix %j with a TypeError',
    async (prefix) => {
      await expect(build({ noCasePathPrefixes: [prefix] })).rejects.toBeInstanceOf(TypeError);
    },
  );
});

describe('legacy fixture paths', () => {
  const API = '/legacy-fixtures/cfml/api.cfm';
  const LIST = `${API}/surveys/surveys`;
  const RESPONSES = `${API}/surveys/surveys/:id/responses`;
  const TARGETS = `${API}/surveys/surveys/:id/targets/:tail`;
  const ARCHIVE = `${API}/people/persons/:id/archive`;
  const SITEMONITOR = '/_api/sitemonitor*';
  const CATCH_ALL = '/*';
  const MIXED_UUID = 'e2840384-07BC-2b9d-3A32BF32E4F5E736';

  /** A service with public lower-case fixture probes and a catch-all, each echoing the route and URL it was routed under. */
  async function probed(overrides: Partial<CreateServiceOptions> = { legacyFixturePaths: true }): Promise<FastifyInstance> {
    const { app } = await build(overrides);
    for (const url of [LIST, RESPONSES, TARGETS, ARCHIVE, SITEMONITOR, CATCH_ALL]) {
      app.get(url, { config: { opt2: { public: true } } }, async (request) => ({ route: request.routeOptions.url, url: request.url }));
    }
    return app;
  }

  async function routed(app: FastifyInstance, url: string): Promise<unknown> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it.each([
    [`${API}/Surveys/SURVEYS?siteid=Tenant-A&X=%41`, LIST, `${API}/surveys/surveys?siteid=Tenant-A&X=%41`],
    [`${API}/SURVEYS/Surveys/`, LIST, `${API}/surveys/surveys/`],
    [`${API}/%53URVEYS/sur%76EYS`, LIST, `${API}/surveys/surveys`],
    [`${API}/SURVEYS/surveys/AbCd-Id/RESPONSES`, RESPONSES, `${API}/surveys/surveys/AbCd-Id/responses`],
    [`${API}/surveys/surveys/%41b%2Fc/Responses?Q=%2F`, RESPONSES, `${API}/surveys/surveys/%41b%2Fc/responses?Q=%2F`],
    [`${API}/surveys/surveys/AbCd-Id/Targets/BULK`, TARGETS, `${API}/surveys/surveys/AbCd-Id/targets/bulk`],
    [`${API}/surveys/surveys/X/Targets/Not%2DA%20UUID`, TARGETS, `${API}/surveys/surveys/X/targets/not-a%20uuid`],
    [`${API}/surveys/surveys/X/Targets/${MIXED_UUID}`, TARGETS, `${API}/surveys/surveys/X/targets/${MIXED_UUID}`],
    [`${API}/People/PERSONS/AbC/Archive/`, ARCHIVE, `${API}/people/persons/AbC/archive/`],
  ])('routes %s under %s as %s', async (url, route, rewritten) => {
    expect(await routed(await probed(), url)).toStrictEqual({ route, url: rewritten });
  });

  it.each([
    ['a prefix in another case', '/LEGACY-FIXTURES/cfml/api.cfm/Surveys/surveys'],
    ['another front-controller case', '/legacy-fixtures/cfml/API.cfm/Surveys/surveys'],
    ['one segment', `${API}/Surveys/`],
    ['six segments', `${API}/Surveys/surveys/X/Targets/BULK/Y`],
    ['no path info', `${API}?Surveys/SURVEYS`],
  ])('leaves %s as sent: %s', async (_label, url) => {
    expect(await routed(await probed(), url)).toStrictEqual({ route: CATCH_ALL, url });
  });

  it.each([{}, { legacyFixturePaths: false }])('keeps fixture paths case-sensitive with %j', async (overrides) => {
    const app = await probed(overrides);
    expect(await routed(app, `${API}/Surveys/SURVEYS`)).toStrictEqual({ route: CATCH_ALL, url: `${API}/Surveys/SURVEYS` });
    expect(await routed(app, LIST)).toStrictEqual({ route: LIST, url: LIST });
  });

  it('rewrites fixture paths and no-case prefixes in one service', async () => {
    const app = await probed({ legacyFixturePaths: true, noCasePathPrefixes: ['/_api/sitemonitor'] });
    expect(await routed(app, `${API}/Surveys/SURVEYS`)).toStrictEqual({ route: LIST, url: LIST });
    expect(await routed(app, '/_API/SiteMonitor?siteid=X')).toStrictEqual({ route: SITEMONITOR, url: '/_api/sitemonitor?siteid=X' });
  });
});

describe('path parameters', () => {
  // ACF's `<appname>_<CFID>_<CFTOKEN>` session id, assembled from low-entropy parts.
  const CF_SESSION_ID = `MURA${'C'.repeat(64)}_1621_${'b'.repeat(16)}-D0000000-0000-0000-0000000000000001`;
  const LONG_ID = 'x'.repeat(300);
  const LONGEST_ID = 'x'.repeat(maxHeaderSize);
  const PLAIN = '/internal/v1/sessions/:sid/state';
  const PATTERN = '/internal/v1/sessions/:sid(.+)::end';

  it.each([
    { label: 'a ColdFusion session id', sid: CF_SESSION_ID, length: 126, route: PLAIN, url: `/internal/v1/sessions/${CF_SESSION_ID}/state` },
    { label: 'a ColdFusion session id', sid: CF_SESSION_ID, length: 126, route: PATTERN, url: `/internal/v1/sessions/${CF_SESSION_ID}:end` },
    { label: 'a long id', sid: LONG_ID, length: 300, route: PLAIN, url: `/internal/v1/sessions/${LONG_ID}/state` },
    { label: 'a long id', sid: LONG_ID, length: 300, route: PATTERN, url: `/internal/v1/sessions/${LONG_ID}:end` },
    { label: 'an id at the header limit', sid: LONGEST_ID, length: maxHeaderSize, route: PLAIN, url: `/internal/v1/sessions/${LONGEST_ID}/state` },
    { label: 'an id at the header limit', sid: LONGEST_ID, length: maxHeaderSize, route: PATTERN, url: `/internal/v1/sessions/${LONGEST_ID}:end` },
  ])('routes $label of $length characters to $route with the parameter intact', async ({ sid, length, route, url }) => {
    expect(sid).toHaveLength(length);
    const { app } = await build();
    for (const declared of [PLAIN, PATTERN]) {
      app.get<{ Params: { sid: string } }>(declared, { config: { opt2: { public: true } } }, async (request) => ({
        route: request.routeOptions.url,
        sid: request.params.sid,
      }));
    }

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ route, sid });
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

  const refused = (): Error =>
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:26011'), { code: 'ECONNREFUSED', syscall: 'connect' });

  it.each([
    { code: '22021', file: 'mbutils.c', status: 400, errorCode: 'invalid_request', message: 'Invalid parameters', logged: false },
    { code: '22P05', file: 'jsonfuncs.c', status: 400, errorCode: 'invalid_request', message: 'Invalid parameters', logged: false },
    { code: '22P05', file: 'mbutils.c', status: 500, errorCode: 'server_error', message: 'Unhandled Exception', logged: true },
    { code: '22001', file: 'varchar.c', status: 500, errorCode: 'server_error', message: 'Unhandled Exception', logged: true },
  ])('answers PostgreSQL error $code from $file with $status, logging only an unhandled error', async ({ code, file, status, errorCode, message, logged }) => {
    const { app, lines } = await build();
    app.post('/notes', { config: { opt2: { public: true } } }, async () => {
      throw Object.assign(new Error('database refused the value'), { code, severity: 'ERROR', file });
    });
    const res = await app.inject({ method: 'POST', url: '/notes?method=save', payload: { title: 'a\u0000b' } });
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.json()).toStrictEqual({ apiversion: 'v1', method: 'save', error: { code: errorCode, message } });
    expect(lines.some((line) => line.message === 'unhandled error')).toBe(logged);
  });

  it.each([
    { label: 'a pg-shaped 22021', error: { code: '22021', severity: 'ERROR' }, expected: true },
    { label: 'a 22021 without a severity', error: { code: '22021' }, expected: false },
    { label: 'a 22021 with a non-string severity', error: { code: '22021', severity: 1 }, expected: false },
    { label: "JSON input's 22P05", error: { code: '22P05', severity: 'ERROR', file: 'jsonfuncs.c' }, expected: true },
    { label: "an encoding conversion's 22P05", error: { code: '22P05', severity: 'ERROR', file: 'mbutils.c' }, expected: false },
    { label: 'a 22P05 without a source file', error: { code: '22P05', severity: 'ERROR' }, expected: false },
    { label: 'a JSON 22P05 without a severity', error: { code: '22P05', file: 'jsonfuncs.c' }, expected: false },
    { label: 'another SQLSTATE', error: { code: '22P02', severity: 'ERROR' }, expected: false },
    { label: 'null', error: null, expected: false },
    { label: 'a string', error: '22021', expected: false },
  ])('isUnstorableTextError reads $label as $expected', ({ error, expected }) => {
    expect(isUnstorableTextError(error)).toBe(expected);
  });

  it.each([
    ['a LegacyServiceUnavailableError', new LegacyServiceUnavailableError(), 'LegacyServiceUnavailableError', REDACTED],
    [
      'a ServiceUnavailableError',
      new ServiceUnavailableError('identity', refused()),
      'ServiceUnavailableError',
      'Service identity unavailable (ECONNREFUSED)',
    ],
    [
      'an unavailability caused by a ServiceUnavailableError',
      Object.assign(new LegacyServiceUnavailableError('emailSend stopped for site tenant-a'), {
        cause: new ServiceUnavailableError('migration', refused()),
      }),
      'LegacyServiceUnavailableError',
      'Service migration unavailable (ECONNREFUSED)',
    ],
  ])('answers %s on the API surface with the legacy 503 envelope and logs a warning with its safe message', async (_label, error, type, message) => {
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
    const warning = lines.find((line) => line.message === 'service unavailable');
    expect(warning).toMatchObject({ severity: 'WARNING', error: { type, message } });
    expect(validateLogRecord(warning).errors).toStrictEqual([]);
    expect(JSON.stringify(warning)).not.toMatch(/127\.0\.0\.1|tenant-a|emailSend/);
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

  it('answers a valid user token with the legacy 503 envelope while the JWKS endpoint refuses connections', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const { app, lines } = await build({
      env: { ...ENV, OPT2_JWKS_URL: `http://127.0.0.1:${String(port)}/jwks` },
      verifierOverride: { ...OVERRIDES, userVerifier: undefined },
    });
    app.get('/_api/json/v1/tenant-a/users', { config: { opt2: { requires: ['s2'] } } }, async () => 'never');
    const token = await mintUserToken({ sub: USER_ID, site: 'tenant-a', roles: ['s2'] });
    const res = await app.inject({
      method: 'GET',
      url: '/_api/json/v1/tenant-a/users?method=findOne',
      headers: { [INVOCATION_HEADER]: SERVICE_CREDENTIAL, authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.headers.etag).toBe(etag(res.body));
    expect(res.json()).toStrictEqual({
      apiversion: 'v1',
      method: 'findOne',
      error: { code: 'server_error', message: 'Unhandled Exception' },
    });
    const warning = lines.find((line) => line.message === 'service unavailable');
    expect(warning).toMatchObject({ severity: 'WARNING', error: { type: 'KeySourceUnavailableError', message: 'connect ECONNREFUSED' } });
    expect(lines.some((line) => line.message === 'unhandled error')).toBe(false);
    expect(JSON.stringify(lines)).not.toContain(token);
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
  async function echo(options?: LegacyParamsOptions): Promise<FastifyInstance> {
    const { app } = await build();
    app.post('/echo', { config: { opt2: { public: true } } }, async (request) => ({
      bodyIsUndefined: request.body === undefined,
      isBuffer: Buffer.isBuffer(request.body),
      params: legacyParamsOf(request, options),
      files: await Promise.all(multipartFilesOf(request).map(async ({ stream, ...file }) => ({ ...file, data: await text(stream()) }))),
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

  it.each<[string, unknown]>([
    ['true', 'YES'],
    ['false', 'NO'],
    ['15', '15'],
    ['1.50e1', '15'],
    ['1.5', '1.5'],
    ['1e20', '1E+020'],
    ['null', ''],
    ['{"a":true,"n":1e20}', { a: true, n: 1e20 }],
    ['[true,15]', [true, 15]],
    ['"true"', 'true'],
  ])('renders a JSON body %s as CFML toString does under jsonScalars cfml, leaving query values as sent', async (json, expected) => {
    const app = await echo({ jsonScalars: 'cfml' });
    const res = await app.inject({
      method: 'POST',
      url: '/echo?q=true&n=1e20',
      headers: { 'content-type': 'application/json' },
      payload: `{"v":${json}}`,
    });
    expect(res.json<{ params: unknown }>().params).toStrictEqual({ q: 'true', n: '1e20', v: expected });
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

  it('takes multipart field values and file names, and spools the files in body order with their size and SHA-256', async () => {
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
        { field: 'newFile', filename: 'a.png', mimetype: 'image/png', data: 'png-bytes', size: 9, sha256: sha256Hex('png-bytes') },
        { field: 'attach', filename: 'b.pdf', mimetype: 'application/pdf', data: '%PDF', size: 4, sha256: sha256Hex('%PDF') },
        { field: 'newFile', filename: 'c.gif', mimetype: 'image/gif', data: 'gif-bytes', size: 9, sha256: sha256Hex('gif-bytes') },
      ],
    });
  });

  it.each([
    ['in one chunk', (bytes: Buffer): Buffer | Readable => bytes],
    ['a byte at a time', (bytes: Buffer): Buffer | Readable => Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])))],
  ])('reports each file part with its fileUpload content type, parameters included, sent %s', async (_label, payload) => {
    const app = await echo();
    const boundary = 'opt2boundary';
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: payload(
        Buffer.from(
          [
            `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n`,
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\none\r\n`,
            `--${boundary}\r\nContent-Disposition: form-data; name="blob"\r\nContent-Type: application/octet-stream; x=1\r\n\r\ntwo\r\n`,
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.bin"\r\n\r\nthree\r\n`,
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.htm"\r\nContent-Type:  Text/HTML ;\r\n Q=1\r\n\r\nfour\r\n`,
            `--${boundary}--\r\n`,
          ].join(''),
        ),
      ),
    });
    expect(res.statusCode).toBe(200);
    const files = res.json<{ files: Array<Record<string, unknown>> }>().files;
    expect(files.map(({ field, mimetype, contentType, data }) => ({ field, mimetype, contentType, data }))).toEqual([
      { field: 'file', mimetype: 'text/plain', contentType: 'text/plain; charset=utf-8', data: 'one' },
      { field: 'blob', mimetype: 'application/octet-stream', contentType: 'application/octet-stream; x=1', data: 'two' },
      { field: 'file', mimetype: 'text/plain', contentType: 'text/plain', data: 'three' },
      { field: 'file', mimetype: 'text/html', contentType: ' text/html ; q=1', data: 'four' },
    ]);
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

  it('still spools every file of a multipart body just under the post limit, counting and hashing each in full', async () => {
    const { app } = await build();
    app.post('/sizes', { config: { opt2: { public: true } } }, (request) =>
      Promise.all(
        multipartFilesOf(request).map(async ({ filename, size, sha256, stream }) => {
          const read = createHash('sha256');
          let length = 0;
          for await (const chunk of stream() as AsyncIterable<Buffer>) {
            length += chunk.length;
            read.update(chunk);
          }
          return { filename, size, sha256, read: { size: length, sha256: read.digest('hex') } };
        }),
      ),
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
    const sent = { size: 33 * MIB, sha256: sha256Hex(Buffer.alloc(33 * MIB, 'x')) };
    expect(res.json()).toStrictEqual(['part0.bin', 'part1.bin', 'part2.bin'].map((filename) => ({ filename, ...sent, read: sent })));
  });

  it.each([
    {
      outcome: 'a handled request',
      status: 200,
      body: (boundary: string): string | Readable =>
        multipartBody(boundary, [
          { name: 'a', value: 'one', filename: 'a.txt' },
          { name: 'b', value: 'two', filename: 'b.txt' },
        ]),
    },
    {
      outcome: 'a multipart body over the post limit',
      status: 400,
      body: (boundary: string): string | Readable => lazyMultipartBody(boundary, 'file', 4, 75).body,
    },
  ])('deletes every spooled temporary file once it has answered $outcome', async ({ status, body }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'opt2-create-service-spool-'));
    vi.stubEnv('TMPDIR', dir);
    try {
      const { app } = await build();
      const during: boolean[] = [];
      app.post('/spool', { config: { opt2: { public: true } } }, async (request) => {
        during.push(...(request.tmpUploads ?? []).map((file) => existsSync(file)));
        return multipartFilesOf(request).length;
      });
      // Added after the multipart plugin's, so it runs once that plugin's cleanup has finished.
      const responded = new Promise<string[]>((resolve) => {
        app.addHook('onResponse', async (request) => resolve(request.tmpUploads ?? []));
      });
      const boundary = 'opt2boundary';
      const res = await app.inject({
        method: 'POST',
        url: '/spool',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body(boundary),
      });
      expect(res.statusCode).toBe(status);
      const after = await responded;
      expect(after).toHaveLength(2);
      expect(after.every((file) => path.dirname(file) === dir && path.basename(file).startsWith('opt2-upload-'))).toBe(true);
      expect(during).toEqual(status === 200 ? [true, true] : []);
      expect(after.filter((file) => existsSync(file))).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('spools no file part once the response has closed, answering badRequest without reaching the handler', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'opt2-create-service-spool-'));
    vi.stubEnv('TMPDIR', dir);
    try {
      const { app } = await build();
      let handled = false;
      app.post('/spool', { config: { opt2: { public: true } } }, async () => {
        handled = true;
        return 'handled';
      });
      // Added after the service kit's hook: the response closes, as on a client disconnect, before the parts are read.
      app.addHook('preParsing', (_request, reply, payload, done) => {
        reply.raw.emit('close');
        done(null, payload);
      });
      const answered = new Promise<number>((resolve) => {
        app.addHook('onResponse', async (_request, reply) => resolve(reply.statusCode));
      });
      const boundary = 'opt2boundary';
      // light-my-request rejects once the response closes; the answer is read from onResponse.
      const injected = app
        .inject({
          method: 'POST',
          url: '/spool',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: multipartBody(boundary, [{ name: 'a', value: 'one', filename: 'a.txt' }]),
        })
        .catch((err: unknown) => err);
      expect(await answered).toBe(400);
      await injected;
      expect(handled).toBe(false);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
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

describe('abandoned requests', () => {
  const STEPS = 20;
  const STEP_MS = 25;

  /** A service whose GET and POST /scan await STEPS steps, each after `throwIfRequestAborted()`; `optIn` lets a disconnect abandon it. */
  async function scanService(optIn: boolean) {
    const { app, lines } = await build();
    let steps = 0;
    let markStarted = (): void => undefined;
    let markEnded = (): void => undefined;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const ended = new Promise<void>((resolve) => (markEnded = resolve));
    app.route({
      method: ['GET', 'POST'],
      url: '/scan',
      config: { opt2: { requires: ['s2'] } },
      handler: async (request) => {
        if (optIn) abandonOnDisconnect(request);
        try {
          for (let step = 0; step < STEPS; step += 1) {
            throwIfRequestAborted();
            steps += 1;
            markStarted();
            await sleep(STEP_MS);
          }
          return { steps, params: legacyParamsOf(request) };
        } finally {
          markEnded();
        }
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    return { app, lines, started, ended, steps: () => steps };
  }

  /** GETs /scan on the listening `app` and destroys the request once the handler has started, resolving when its socket closes. */
  function leaveScan(app: FastifyInstance, started: Promise<void>): Promise<void> {
    const { port } = app.server.address() as AddressInfo;
    return new Promise((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/scan', headers: { ...AUTHENTICATED, 'x-request-id': 'req-left' } });
      // The destroyed request's own socket error is the point of the test.
      req.on('error', () => undefined);
      req.on('close', () => resolve());
      req.end();
      void started.then(() => req.destroy());
    });
  }

  const abandonedLines = (lines: LogLine[]): LogLine[] => lines.filter((line) => line.message === 'request abandoned');

  it('stops an opted-in read once its client disconnects and logs it as abandoned, not as an error', async () => {
    const { app, lines, started, ended, steps } = await scanService(true);
    await leaveScan(app, started);
    await ended;
    expect(steps()).toBeLessThan(STEPS);
    const [abandoned] = await vi.waitFor(() => {
      const found = abandonedLines(lines);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(validateLogRecord(abandoned).errors).toStrictEqual([]);
    expect(abandoned).toMatchObject({
      severity: 'INFO',
      requestId: 'req-left',
      route: '/scan',
      httpMethod: 'GET',
      tenantId: TENANT_A_ID,
      userId: USER_ID,
    });
    expect(abandoned?.latencyMs).toEqual(expect.any(Number));
    expect(lines.filter((line) => line.severity === 'ERROR' || line.message === 'unhandled error')).toStrictEqual([]);
  });

  it('runs a read that did not opt in to its end after its client disconnects', async () => {
    const { app, lines, started, ended, steps } = await scanService(false);
    await leaveScan(app, started);
    await ended;
    expect(steps()).toBe(STEPS);
    expect(abandonedLines(lines)).toStrictEqual([]);
    expect(lines.filter((line) => line.severity === 'ERROR')).toStrictEqual([]);
  });

  it.each([
    ['JSON', 'application/json', '{"siteid":"tenant-a"}'],
    ['form', 'application/x-www-form-urlencoded', 'siteid=tenant-a'],
  ])('answers an opted-in POST with a consumed %s body on a real socket in full', async (_label, contentType, body) => {
    const { app, lines } = await scanService(true);
    const { port } = app.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${String(port)}/scan`, {
      method: 'POST',
      headers: { ...AUTHENTICATED, 'content-type': contentType },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ steps: STEPS, params: { siteid: 'tenant-a' } });
    expect(abandonedLines(lines)).toStrictEqual([]);
  });

  it.each([
    ['GET', undefined],
    ['POST', '{"siteid":"tenant-a"}'],
  ] as const)('answers an opted-in %s under inject in full', async (method, payload) => {
    const { app, lines } = await scanService(true);
    const res = await app.inject({ method, url: '/scan', headers: { ...AUTHENTICATED, 'content-type': 'application/json' }, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ steps: STEPS });
    expect(abandonedLines(lines)).toStrictEqual([]);
    expect(completedLines(lines)).toMatchObject([{ route: '/scan', httpMethod: method, statusCode: 200 }]);
  });
});

describe('HTTP server span name', () => {
  const ROUTE = '/v1/surveys/:surveyId/tasks';

  it.each([
    { label: 'a matched route', url: '/v1/surveys/S-1/tasks', headers: AUTHENTICATED, status: 200, name: `GET ${ROUTE}` },
    { label: 'a denied request on a declared route', url: '/v1/surveys/S-2/tasks', headers: {}, status: 401, name: `GET ${ROUTE}` },
    { label: 'an unmatched path', url: '/v1/surveys/S-3', headers: {}, status: 404, name: 'GET' },
  ])('is "$name" for $label on a real socket', async ({ url, headers, status, name }) => {
    const exporter = new MemorySpanExporter();
    await startTracing({ serviceName: 'people', version: '1.0.0', exporter });
    try {
      // Patches the http module this worker loaded before tracing started.
      createRequire(import.meta.url)('http');
      const { app } = await build();
      app.get(ROUTE, { config: { opt2: { requires: ['s2'] } } }, () => ({ ok: true }));
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(port)}${url}`, { headers });
      await res.arrayBuffer();
      expect(res.status).toBe(status);
      const span = await vi.waitFor(async () => {
        await flushTracing();
        const servers = exporter.getFinishedSpans().filter((finished) => finished.kind === SpanKind.SERVER);
        expect(servers).toHaveLength(1);
        return servers[0];
      });
      expect(span?.name).toBe(name);
      expect(span?.attributes['url.path']).toBe(url);
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

  const PRINCIPAL = { tenantId: TENANT_A_ID, userId: USER_ID };
  const ANONYMOUS = { tenantId: undefined, userId: undefined };

  interface OutcomeCase {
    label: string;
    method: 'GET' | 'POST';
    url: string;
    route: string;
    /** Defaults to the user token and the invocation credential. */
    headers?: Record<string, string>;
    payload?: string;
    status: number;
    warning: string | null;
    scope: typeof PRINCIPAL | typeof ANONYMOUS;
  }

  it.each<OutcomeCase>([
    { label: 'a 200', method: 'GET', url: '/items/a', route: '/items/:id', status: 200, warning: null, scope: PRINCIPAL },
    {
      label: 'a 401 without a credential',
      method: 'GET',
      url: '/items/a',
      route: '/items/:id',
      headers: {},
      status: 401,
      warning: 'request denied: missing-credential',
      scope: ANONYMOUS,
    },
    {
      label: 'a 401 with only the invocation credential',
      method: 'GET',
      url: '/items/a',
      route: '/items/:id',
      headers: { [INVOCATION_HEADER]: SERVICE_CREDENTIAL },
      status: 401,
      warning: 'request denied: missing-credential',
      scope: ANONYMOUS,
    },
    { label: 'a role-denied 403', method: 'GET', url: '/staff/a', route: '/staff/:id', status: 403, warning: 'request denied: forbidden', scope: PRINCIPAL },
    {
      label: 'a handler 403 with a recorded reason',
      method: 'GET',
      url: '/owned/a',
      route: '/owned/:id',
      status: 403,
      warning: 'request denied: notOwner',
      scope: PRINCIPAL,
    },
    {
      label: 'a site-mismatch 403',
      method: 'GET',
      url: '/items/a?siteid=tenant-b',
      route: '/items/:id',
      status: 403,
      warning: 'request denied: site-mismatch',
      scope: PRINCIPAL,
    },
    {
      label: 'a thrown LegacyApiError 400',
      method: 'GET',
      url: '/rejected/a',
      route: '/rejected/:id',
      status: 400,
      warning: 'request rejected: invalidParameters',
      scope: PRINCIPAL,
    },
    {
      label: 'a schema validation 400',
      method: 'GET',
      url: '/validated/a',
      route: '/validated/:id',
      status: 400,
      warning: 'request rejected: FST_ERR_VALIDATION',
      scope: PRINCIPAL,
    },
    {
      label: 'a Fastify client error 400',
      method: 'POST',
      url: '/small/a',
      route: '/small/:id',
      payload: '{"payload":"far too long"}',
      status: 400,
      warning: 'request rejected: FST_ERR_CTP_BODY_TOO_LARGE',
      scope: PRINCIPAL,
    },
    {
      label: 'a PostgreSQL 22021 400',
      method: 'POST',
      url: '/notes/a',
      route: '/notes/:id',
      payload: '{"title":"a\\u0000b"}',
      status: 400,
      warning: 'request rejected: 22021',
      scope: PRINCIPAL,
    },
    {
      label: 'a PostgreSQL JSON 22P05 400',
      method: 'POST',
      url: '/events/a',
      route: '/events/:id',
      payload: '{"title":"a\\u0000b"}',
      status: 400,
      warning: 'request rejected: 22P05',
      scope: PRINCIPAL,
    },
  ])(
    'writes the warning of $label, if any, ahead of its one completion line, both with the verified tenant and user',
    async ({ method, url, route, headers = AUTHENTICATED, payload, status, warning, scope }) => {
      const { app, lines } = await build();
      const s2 = { config: { opt2: { requires: ['s2'] } } };
      app.get('/items/:id', s2, async () => ({ ok: true }));
      app.get('/staff/:id', { config: { opt2: { requires: ['site-admin'] } } }, async () => 'never');
      app.get('/owned/:id', s2, async (request, reply) => {
        recordOutcomeReason(request, 'notOwner');
        return reply.code(403).send('denied');
      });
      app.get('/rejected/:id', s2, async () => {
        throw new LegacyApiError('invalidParameters');
      });
      app.get(
        '/validated/:id',
        { ...s2, schema: { querystring: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } } },
        async () => 'never',
      );
      app.post('/small/:id', { ...s2, bodyLimit: 8 }, async () => 'never');
      app.post('/notes/:id', s2, async () => {
        throw Object.assign(new Error('database refused the value'), { code: '22021', severity: 'ERROR' });
      });
      app.post('/events/:id', s2, async () => {
        throw Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05', severity: 'ERROR', file: 'jsonfuncs.c' });
      });
      const res = await app.inject({
        method,
        url: `${url}${url.includes('?') ? '&' : '?'}key=push-key-value`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(status);
      const warnings = lines.filter((line) => line.severity === 'WARNING');
      const completed = completedLines(lines);
      expect(warnings.map((line) => line.message)).toStrictEqual(warning === null ? [] : [warning]);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ severity: 'INFO' });
      for (const line of [...warnings, ...completed]) {
        expect(validateLogRecord(line).errors).toStrictEqual([]);
        expect(line).toMatchObject({ route, httpMethod: method, statusCode: status });
        expect({ tenantId: line.tenantId, userId: line.userId }).toStrictEqual(scope);
      }
      expect(lines.slice(-1 - warnings.length)).toStrictEqual([...warnings, ...completed]);
      expect(JSON.stringify(lines)).not.toContain('push-key-value');
    },
  );

  const DELIVERY = { eventId: '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b', tenantId: tenantIdForSite('tenant-b') };

  it.each([
    { label: 'a verified user', headers: AUTHENTICATED, scope: PRINCIPAL, verified: TENANT_A_ID },
    { label: 'no verified user', headers: {}, scope: { tenantId: DELIVERY.tenantId, userId: undefined }, verified: undefined },
  ])(
    'logs a recorded delivery with $label by its eventId and the verified tenant, else its own, leaving the verified scope unchanged',
    async ({ headers, scope, verified }) => {
      const { app, lines } = await build();
      let seen: unknown;
      app.post('/deliveries/:id', { config: { opt2: { public: true } } }, async (request) => {
        recordEventScope(request, DELIVERY);
        seen = { store: currentRequestContext()?.tenantId, request: request.opt2.tenantId };
        throw new LegacyServiceUnavailableError();
      });
      const res = await app.inject({ method: 'POST', url: '/deliveries/a', headers });
      expect(res.statusCode).toBe(503);
      expect(seen).toStrictEqual({ store: verified, request: verified });
      const outcome = lines.filter((line) => line.severity === 'WARNING' || line.message === 'request completed');
      expect(outcome.map((line) => line.message)).toStrictEqual(['service unavailable', 'request completed']);
      for (const line of outcome) {
        expect(validateLogRecord(line).errors).toStrictEqual([]);
        expect({ tenantId: line.tenantId, userId: line.userId, eventId: line.eventId }).toStrictEqual({
          ...scope,
          eventId: DELIVERY.eventId,
        });
      }
    },
  );
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
