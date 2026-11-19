import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DestinationStream } from 'pino';
import { errorCodes, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
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
import { REDACTED, createLogger, serializeError, validateLogRecord, type Logger } from '../../src/logging/index.js';
import { DatabaseUnavailableError, tenantIdForSite, type TenantDb } from '../../src/tenancy/index.js';
import { mintUserToken } from '../../src/testing/index.js';
import {
  MemorySpanExporter,
  SpanKind,
  flushTracing,
  shutdownTracing,
  startSpan,
  startTracing,
} from '../../src/tracing/index.js';
import { SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError, UnknownServiceError } from '../../src/service-kit/client.js';
import { currentRequestContext, recordUnpublishedEvents, throwIfRequestAborted } from '../../src/service-kit/context.js';
import {
  FLUSH_ANSWER_MARGIN_MS,
  LEGACY_MAX_POST_CONTENT_LENGTH,
  LEGACY_POST_LIMIT_BYTES,
  SERVICE_MAX_HEADER_SIZE,
  abandonOnDisconnect,
  createService,
  defaultSurfaceOf,
  isBodyTooLargeError,
  isUnstorableTextError,
  legacyParamsOf,
  legacyScopesOf,
  multipartFilesOf,
  recordLogScope,
  recordOutcomeReason,
  sendLegacyResponse,
  UNMATCHED_ROUTE,
  UNPUBLISHED_EVENTS_HEADER,
  type CreateServiceOptions,
  type LegacyParamsOptions,
  type Opt2RouteOutboxConfig,
  type RequestLogScope,
} from '../../src/service-kit/create-service.js';
import { EnvValidationError, loadEnv, type BaseEnv } from '../../src/service-kit/env.js';
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

function captureLogger(level?: string): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const destination: DestinationStream = { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) };
  return { logger: createLogger({ service: 'people', version: '1.0.0', env: 'local', level, destination }), lines };
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

/** Reason phrase and body of the legacy container's answer to an oversized POST, as the legacy oracle sends them. */
const POST_SIZE_STATUS_TEXT = 'Post Size exceeds the maximum limit.';
const POST_SIZE_PAGE = `<html><head><title>Error</title></head><body>${POST_SIZE_STATUS_TEXT}</body></html>`;

function sha256Hex(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A lazily generated multipart body of `count` file, field or JSON-typed field parts of `mib` MiB each, with its length and the bytes pulled from it so far. */
function lazyMultipartBody(
  boundary: string,
  kind: 'file' | 'field' | 'json',
  count: number,
  mib: number,
): { body: Readable; length: number; pulled: () => number } {
  const chunk = Buffer.alloc(MIB, 'x');
  const crlf = Buffer.from('\r\n');
  const tail = Buffer.from(`--${boundary}--\r\n`);
  const heads = Array.from({ length: count }, (_, i) => {
    const name = `part${String(i)}`;
    const filename = kind === 'file' ? `; filename="${name}.bin"` : '';
    const type = kind === 'json' ? '\r\nContent-Type: application/json' : '';
    return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename}${type}\r\n\r\n`);
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
  it('exposes the 100 MiB body bound and the legacy container POST limit of 20 MiB + 1', () => {
    expect(LEGACY_POST_LIMIT_BYTES).toBe(104_857_600);
    expect(LEGACY_MAX_POST_CONTENT_LENGTH).toBe(20_971_521);
  });

  it('rejects pool and schema together with a TypeError', async () => {
    const pool = { end: vi.fn() } as unknown as TenantDb;
    await expect(build({ pool, schema: 'people' })).rejects.toBeInstanceOf(TypeError);
  });

  it.each<[string, Partial<BaseEnv>, string[], string]>([
    ['no database settings', {}, ['OPT2_DB_AUTH: is required', 'PG_DATABASE: is required'], 'people: invalid environment (OPT2_DB_AUTH: is required; PG_DATABASE: is required)'],
    ['no OPT2_DB_AUTH', { PG_DATABASE: 'unused' }, ['OPT2_DB_AUTH: is required'], 'people: invalid environment (OPT2_DB_AUTH: is required)'],
    ['no PG_DATABASE', { OPT2_DB_AUTH: 'password' }, ['PG_DATABASE: is required'], 'people: invalid environment (PG_DATABASE: is required)'],
  ])('refuses a schema with %s by an EnvValidationError naming each missing variable', async (_case, settings, issues, safeText) => {
    const error = await build({ env: { ...ENV, ...settings }, schema: 'people' }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).issues).toEqual(issues);
    expect(serializeError(error).message).toBe(safeText);
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
    app.get('/v1/get-only', { config: { opt2: { public: true, invocationOptional: true } } }, () => 'listed');
    app.route({ method: ['GET', 'HEAD'], url: '/v1/get-and-head', config: { opt2: { public: true, invocationOptional: true } }, handler: () => 'listed' });
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
    app.get('/custom', { config: { opt2: { public: true, invocationOptional: true } } }, async (_request, reply) =>
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
      app.get(url, { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => ({ url: request.url, originalUrl: request.originalUrl }));
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
    app.get('/_api/*', { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => request.url);
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
      app.get(url, { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => ({ route: request.routeOptions.url, url: request.url }));
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
  const LONGEST_ID = 'x'.repeat(SERVICE_MAX_HEADER_SIZE);
  const PLAIN = '/internal/v1/sessions/:sid/state';
  const PATTERN = '/internal/v1/sessions/:sid(.+)::end';

  it.each([
    { label: 'a ColdFusion session id', sid: CF_SESSION_ID, length: 126, route: PLAIN, url: `/internal/v1/sessions/${CF_SESSION_ID}/state` },
    { label: 'a ColdFusion session id', sid: CF_SESSION_ID, length: 126, route: PATTERN, url: `/internal/v1/sessions/${CF_SESSION_ID}:end` },
    { label: 'a long id', sid: LONG_ID, length: 300, route: PLAIN, url: `/internal/v1/sessions/${LONG_ID}/state` },
    { label: 'a long id', sid: LONG_ID, length: 300, route: PATTERN, url: `/internal/v1/sessions/${LONG_ID}:end` },
    { label: 'an id at the header limit', sid: LONGEST_ID, length: SERVICE_MAX_HEADER_SIZE, route: PLAIN, url: `/internal/v1/sessions/${LONGEST_ID}/state` },
    { label: 'an id at the header limit', sid: LONGEST_ID, length: SERVICE_MAX_HEADER_SIZE, route: PATTERN, url: `/internal/v1/sessions/${LONGEST_ID}:end` },
  ])('routes $label of $length characters to $route with the parameter intact', async ({ sid, length, route, url }) => {
    expect(sid).toHaveLength(length);
    const { app } = await build();
    for (const declared of [PLAIN, PATTERN]) {
      app.get<{ Params: { sid: string } }>(declared, { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => ({
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
    app.get(url, { config: { opt2: { public: true, invocationOptional: true } } }, async () => {
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

  it('reports the fault a server_error LegacyApiError carries as its stacktrace', async () => {
    const stacktrace = { Message: 'Element RC.userBean is undefined in ARGUMENTS.', Type: 'Expression' };
    const app = await failing(new LegacyApiError('server_error', { stacktrace }));
    const res = await app.inject({ method: 'GET', url: '/fail?method=findOne' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toStrictEqual({
      apiversion: 'v1',
      method: 'findOne',
      error: { message: 'Unhandled Exception', code: 'server_error', stacktrace: { message: stacktrace.Message, type: stacktrace.Type } },
    });
    expect(res.headers.etag).toBe(etag(res.body));
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
    app.get('/boom', { config: { opt2: { public: true, invocationOptional: true } } }, async () => {
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
    app.post('/notes', { config: { opt2: { public: true, invocationOptional: true } } }, async () => {
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
    app.get('/busy', { config: { opt2: { public: true, invocationOptional: true } } }, async () => {
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

  it.each([
    {
      surface: 'API',
      path: '/legacy-fixtures/cfml/api.cfm/timesheets/sheets',
      contentType: LEGACY_JSON_CONTENT_TYPE,
      read: (body: string): unknown => JSON.parse(body),
      expected: { apiversion: 'v1', method: 'save', error: { code: 'server_error', message: 'Unhandled Exception' } },
    },
    {
      surface: 'admin',
      path: '/admin-actions/cusers/update',
      contentType: LEGACY_HTML_CONTENT_TYPE,
      read: (body: string): unknown => body,
      expected: LEGACY_ERROR_PAGE_HTML,
    },
  ])('answers a DatabaseUnavailableError on the $surface surface with the legacy 503 and one ERROR line', async ({ path: url, contentType, read, expected }) => {
    const { app, lines } = await build();
    app.get(url, { config: { opt2: { public: true, invocationOptional: true } } }, () => {
      throw new DatabaseUnavailableError('ECONNREFUSED', refused());
    });
    const res = await app.inject({ method: 'GET', url: `${url}?method=save` });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(contentType);
    expect(read(res.body)).toStrictEqual(expected);
    const logged = lines.filter((line) => line.severity === 'ERROR' || line.severity === 'WARNING');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      severity: 'ERROR',
      message: 'database unavailable',
      error: { type: 'DatabaseUnavailableError', message: 'Database unavailable (ECONNREFUSED)' },
    });
    expect(validateLogRecord(logged[0]).errors).toStrictEqual([]);
    expect(JSON.stringify(lines)).not.toMatch(/127\.0\.0\.1|26011/);
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
        config: { opt2: { public: true, invocationOptional: true } },
        schema: { querystring: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
      async () => 'never',
    );
    const res = await app.inject({ method: 'GET', url: '/validated' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
  });

  const CLOSED_BODY = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'account'],
    properties: {
      kind: { type: 'string' },
      account: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
    },
  } as const;
  const CLOSED_VALID = { kind: 'create', account: { name: 'Pat' } };

  /** A service echoing the body of a route whose schema, nested object included, declares `additionalProperties: false`. */
  async function closedBodyRoute(): Promise<FastifyInstance> {
    const { app } = await build();
    app.post('/closed', { config: { opt2: { public: true, invocationOptional: true } }, schema: { body: CLOSED_BODY } }, (request, reply) => reply.send({ body: request.body }));
    return app;
  }

  it.each([
    ['a top-level', { ...CLOSED_VALID, evil: 1 }],
    ['a nested', { ...CLOSED_VALID, account: { ...CLOSED_VALID.account, Evil: 'x' } }],
  ])('answers %s property an additionalProperties: false schema does not declare with invalidParameters', async (_label, payload) => {
    const app = await closedBodyRoute();
    const res = await app.inject({ method: 'POST', url: '/closed', payload });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
  });

  it('hands a body an additionalProperties: false schema admits to the handler unchanged', async () => {
    const app = await closedBodyRoute();
    const res = await app.inject({ method: 'POST', url: '/closed', payload: CLOSED_VALID });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ body: CLOSED_VALID });
  });

  it('answers a Fastify client error with badRequest', async () => {
    const { app } = await build();
    app.post('/small', { bodyLimit: 8, config: { opt2: { public: true, invocationOptional: true } } }, async () => 'never');
    const res = await app.inject({
      method: 'POST',
      url: '/small',
      headers: { 'content-type': 'no-subtype' },
      payload: '{"payload":"far too long"}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Bad Request' } });
  });
});

describe('body parsing and legacy params', () => {
  async function echo(options?: LegacyParamsOptions): Promise<FastifyInstance> {
    const { app } = await build();
    app.post('/echo', { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => ({
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

  it('attaches a JSON-typed multipart part without a file name as a field holding its text, in body order', async () => {
    const { app } = await build();
    const view = (part: unknown): unknown => {
      const { type, fieldname, mimetype, value } = part as Record<string, unknown>;
      return { type, fieldname, mimetype, value };
    };
    app.post('/raw', { config: { opt2: { public: true, invocationOptional: true } } }, async (request) =>
      Object.fromEntries(Object.entries(request.body as Record<string, unknown>).map(([name, held]) => [name, Array.isArray(held) ? held.map(view) : view(held)])),
    );
    const boundary = 'opt2boundary';
    const res = await app.inject({
      method: 'POST',
      url: '/raw',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [
        { name: 'tag', value: '[1.50]', type: 'application/json' },
        { name: 'tag', value: 'two' },
        { name: 'one', value: '{not json', type: 'application/json-patch+json' },
        { name: 'tag', value: '{"a":1}', type: 'application/json' },
      ]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({
      tag: [
        { type: 'field', fieldname: 'tag', mimetype: 'application/json', value: '[1.50]' },
        { type: 'field', fieldname: 'tag', mimetype: 'text/plain', value: 'two' },
        { type: 'field', fieldname: 'tag', mimetype: 'application/json', value: '{"a":1}' },
      ],
      one: { type: 'field', fieldname: 'one', mimetype: 'application/json-patch+json', value: '{not json' },
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
    const { params, files } = res.json<{ params: Record<string, unknown>; files: Array<Record<string, unknown>> }>();
    // ColdFusion holds the octet stream without a file name as form text, so the files after it keep their own types.
    expect(params).toMatchObject({ title: 'Hello', blob: 'two' });
    expect(files.map(({ field, mimetype, contentType, data }) => ({ field, mimetype, contentType, data }))).toEqual([
      { field: 'file', mimetype: 'text/plain', contentType: 'text/plain; charset=utf-8', data: 'one' },
      { field: 'file', mimetype: 'text/plain', contentType: 'text/plain', data: 'three' },
      { field: 'file', mimetype: 'text/html', contentType: ' text/html ; q=1', data: 'four' },
    ]);
  });

  describe('a multipart body without its close delimiter', () => {
    const boundary = 'opt2boundary';
    const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    const close = `--${boundary}--\r\n`;
    const parts = multipartBody(boundary, [
      { name: 'title', value: 'Hello' },
      { name: 'attach', value: 'pdf-bytes', filename: 'a.pdf', type: 'application/pdf' },
    ]).slice(0, -close.length);
    const read = {
      bodyIsUndefined: false,
      isBuffer: false,
      params: { title: 'Hello', attach: 'a.pdf' },
      files: [{ field: 'attach', filename: 'a.pdf', mimetype: 'application/pdf', contentType: 'application/pdf', size: 9, sha256: sha256Hex('pdf-bytes'), data: 'pdf-bytes' }],
    };
    const nothingRead = { bodyIsUndefined: true, isBuffer: false, params: {}, files: [] };

    /** Status and JSON body of `payload` posted to `/echo` through inject or a real socket. */
    async function send(app: FastifyInstance, via: 'inject' | 'socket', payload: string): Promise<{ status: number; json: unknown }> {
      if (via === 'inject') {
        const res = await app.inject({ method: 'POST', url: '/echo', headers, payload });
        return { status: res.statusCode, json: res.json() };
      }
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(port)}/echo`, { method: 'POST', headers, body: payload });
      return { status: res.status, json: await res.json() };
    }

    /** Bodies legacy reads as complete, each sent by inject and over a real socket. */
    const readAsComplete = [
      { ending: 'right after a delimiter', payload: `${parts}--${boundary}`, expected: read },
      { ending: 'inside a header block', payload: `${parts}--${boundary}\r\nbroken`, expected: read },
      { ending: "inside a file part's header block", payload: `${parts}--${boundary}\r\nContent-Disposition: form-data; name="b"; filename="b.txt"`, expected: read },
      { ending: 'past an empty header block', payload: `${parts}--${boundary}\r\n\r\ntrailing`, expected: read },
      { ending: 'right after its first delimiter', payload: `--${boundary}`, expected: nothingRead },
      { ending: 'inside its first header block', payload: `--${boundary}\r\nbroken`, expected: nothingRead },
    ].flatMap((row) => (['inject', 'socket'] as const).map((via) => ({ ...row, via })));

    it.each(readAsComplete)('hands the parts before a body end $ending to the handler, files spooled whole, sent by $via', async ({ payload, expected, via }) => {
      const app = await echo();
      expect(await send(app, via, payload)).toStrictEqual({ status: 200, json: expected });
    });

    it.each(readAsComplete)('hands a body ending $ending to a context parsing every body as a raw Buffer as sent, sent by $via', async ({ payload, via }) => {
      const { app } = await build();
      await app.register(async (raw) => {
        raw.removeAllContentTypeParsers();
        raw.addContentTypeParser<Buffer>('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
        raw.post('/echo', { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => ({
          body: Buffer.isBuffer(request.body) ? request.body.toString('latin1') : null,
        }));
      });
      expect(await send(app, via, payload)).toStrictEqual({ status: 200, json: { body: payload } });
    });

    it.each(
      [
        { ending: "inside a part's content", payload: `${parts}--${boundary}\r\nContent-Disposition: form-data; name="late"\r\n\r\nunterminated` },
        { ending: "right after a part's header block", payload: `${parts}--${boundary}\r\nContent-Disposition: form-data; name="late"\r\n\r\n` },
      ].flatMap((row) => (['inject', 'socket'] as const).map((via) => ({ ...row, via }))),
    )('answers a body ending $ending with the 500 server_error envelope before the handler, sent by $via', async ({ payload, via }) => {
      const { app, lines } = await build();
      let handled = false;
      app.post('/echo', { config: { opt2: { public: true, invocationOptional: true } } }, async () => {
        handled = true;
        return 'handled';
      });
      expect(await send(app, via, payload)).toMatchObject({ status: 500, json: { error: { code: 'server_error', message: 'Unhandled Exception' } } });
      expect(handled).toBe(false);
      expect(lines.filter((line) => line.message === 'unhandled error')).toHaveLength(1);
    });
  });

  describe('a multipart body whose header block a delimiter interrupts', () => {
    const headers = { 'content-type': 'multipart/form-data; boundary=x' };
    const title = '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\nT\r\n';
    const titled = { bodyIsUndefined: false, isBuffer: false, params: { title: 'T' }, files: [] };
    const nothingRead = { bodyIsUndefined: true, isBuffer: false, params: {}, files: [] };
    const file = '--x\r\nContent-Disposition: form-data; name="attach"; filename="a.pdf"\r\nContent-Type: application/pdf; v=1\r\n\r\npdf-bytes\r\n';
    const fileRead = {
      bodyIsUndefined: false,
      isBuffer: false,
      params: { attach: 'a.pdf' },
      files: [{ field: 'attach', filename: 'a.pdf', mimetype: 'application/pdf', contentType: 'application/pdf; v=1', size: 9, sha256: sha256Hex('pdf-bytes'), data: 'pdf-bytes' }],
    };
    // Legacy reads a delimiter line inside a header block as one more header line, and a later disposition line wins.
    const bodies = [
      { shape: 'a delimiter line and the close', payload: '--x\r\nbroken\r\n--x--\r\n', expected: nothingRead },
      { shape: 'the close without its CRLF', payload: '--x\r\nbroken\r\n--x--', expected: nothingRead },
      { shape: 'a part after the delimiter line', payload: `--x\r\nbroken\r\n${title}--x--\r\n`, expected: titled },
      { shape: 'a disposition line before the delimiter line', payload: `--x\r\nContent-Disposition: form-data; name="zzz"\r\n${title}--x--\r\n`, expected: titled },
      { shape: 'two delimiter lines', payload: `--x\r\nbroken\r\n--x\r\nstill broken\r\n${title}--x--\r\n`, expected: titled },
      { shape: 'a complete part before it', payload: `${title}--x\r\nbroken\r\n--x--\r\n`, expected: titled },
      { shape: 'its end after the delimiter line', payload: '--x\r\nbroken\r\n--x\r\nbroken', expected: nothingRead },
      { shape: 'a file part after the delimiter line', payload: `--x\r\nbroken\r\n${file}--x--\r\n`, expected: fileRead },
      {
        shape: 'a header block over 80 KiB before it',
        payload: `--x\r\nContent-Disposition: form-data; name="big"\r\nX-Long: ${'y'.repeat(90 * 1024)}\r\n\r\nB\r\n--x\r\nbroken\r\n${title}--x--\r\n`,
        expected: { ...titled, params: { big: 'B', title: 'T' } },
      },
    ];
    // Sent in one chunk, a body completes only if each piece the scanner cuts reaches busboy as its own write.
    const deliveries = [
      { sent: 'in one chunk', size: Number.MAX_SAFE_INTEGER, via: 'inject' },
      { sent: 'in one chunk', size: Number.MAX_SAFE_INTEGER, via: 'socket' },
      ...[1, 3, 7].map((size) => ({ sent: `in ${String(size)}-byte chunks`, size, via: 'inject' })),
    ] as const;

    it.each(bodies.flatMap((body) => deliveries.map((delivery) => ({ ...body, ...delivery }))))(
      'hands the form of a body with $shape to the handler, sent $sent by $via',
      async ({ payload, expected, size, via }) => {
        const app = await echo();
        const bytes = Buffer.from(payload, 'latin1');
        if (via === 'socket') {
          await app.listen({ port: 0, host: '127.0.0.1' });
          const { port } = app.server.address() as AddressInfo;
          const res = await fetch(`http://127.0.0.1:${String(port)}/echo`, { method: 'POST', headers, body: bytes });
          expect({ status: res.status, json: await res.json() }).toStrictEqual({ status: 200, json: expected });
          return;
        }
        const chunks: Buffer[] = [];
        for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
        const res = await app.inject({ method: 'POST', url: '/echo', headers, payload: chunks.length === 1 ? bytes : Readable.from(chunks) });
        expect({ status: res.statusCode, json: res.json() }).toStrictEqual({ status: 200, json: expected });
      },
      5_000,
    );
  });

  it.each([
    { sent: 'by PUT with its Content-Length', method: 'PUT', kind: 'file', count: 4, mib: 75, declared: true, pulled: [0, 0] },
    { sent: 'chunked, as files', method: 'POST', kind: 'file', count: 4, mib: 75, declared: false, pulled: [LEGACY_POST_LIMIT_BYTES, LEGACY_POST_LIMIT_BYTES + 4 * MIB] },
    { sent: 'chunked, as fields', method: 'POST', kind: 'field', count: 300, mib: 1, declared: false, pulled: [LEGACY_POST_LIMIT_BYTES, LEGACY_POST_LIMIT_BYTES + 4 * MIB] },
    { sent: 'chunked, as JSON-typed fields', method: 'POST', kind: 'json', count: 2, mib: 75, declared: false, pulled: [LEGACY_POST_LIMIT_BYTES, LEGACY_POST_LIMIT_BYTES + 4 * MIB] },
  ] as const)(
    'answers a multipart body over the body bound sent $sent with the Post Size page, reading no further than the bound',
    async ({ method, kind, count, mib, declared, pulled: [least, most] }) => {
      const { app } = await build();
      app.route({ method, url: '/upload', config: { opt2: { public: true, invocationOptional: true } }, handler: () => 'never' });
      const boundary = 'opt2boundary';
      const { body, length, pulled } = lazyMultipartBody(boundary, kind, count, mib);
      expect(length).toBeGreaterThan(LEGACY_POST_LIMIT_BYTES);
      const res = await app.inject({
        method,
        url: '/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          ...(declared ? { 'content-length': String(length) } : {}),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.statusMessage).toBe(POST_SIZE_STATUS_TEXT);
      expect(res.headers.connection).toBe('close');
      expect(res.body).toBe(POST_SIZE_PAGE);
      expect(pulled()).toBeGreaterThanOrEqual(least);
      expect(pulled()).toBeLessThanOrEqual(most);
    },
  );

  it('still spools every file of a multipart body just under the body bound, counting and hashing each in full', async () => {
    const { app } = await build();
    app.put('/sizes', { config: { opt2: { public: true, invocationOptional: true } } }, (request) =>
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
      method: 'PUT',
      url: '/sizes',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(length) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const sent = { size: 33 * MIB, sha256: sha256Hex(Buffer.alloc(33 * MIB, 'x')) };
    expect(res.json()).toStrictEqual(['part0.bin', 'part1.bin', 'part2.bin'].map((filename) => ({ filename, ...sent, read: sent })));
  });

  it.each([
    { outcome: 'a handled request', send: 'inject', fail: false, status: 200, spooled: 2, errors: [] },
    { outcome: 'a handled request on a real socket', send: 'socket', fail: false, status: 200, spooled: 2, errors: [] },
    { outcome: 'a handler error', send: 'inject', fail: true, status: 500, spooled: 2, errors: ['unhandled error'] },
    { outcome: 'a multipart body over the post limit', send: 'over-limit', fail: false, status: 400, spooled: 2, errors: [] },
    { outcome: 'a client abort mid-upload', send: 'abort', fail: false, status: undefined, spooled: 1, errors: ['unhandled error'] },
  ] as const)('deletes every spooled temporary file once after $outcome, logging no failed delete', async ({ send, fail, status, spooled, errors }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'opt2-create-service-spool-'));
    vi.stubEnv('TMPDIR', dir);
    try {
      const { app, lines } = await build();
      const errorMessages = (): unknown[] => lines.filter((line) => line.severity === 'ERROR').map((line) => line.message);
      const values = ['one', 'two'];
      // The spool directory while the files exist, and the plugin's own upload list, which must hold none of them.
      const listings: string[][] = [];
      const pluginUploads: Array<string[] | null> = [];
      const snapshot = async (request: FastifyRequest): Promise<void> => {
        listings.push(await readdir(dir));
        pluginUploads.push(request.tmpUploads);
      };
      app.post('/spool', { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => {
        const read = await Promise.all(multipartFilesOf(request).map((file) => text(file.stream())));
        await snapshot(request);
        if (fail) throw new Error('handler failed');
        return read;
      });
      // Runs ahead of the error handler, before the response cleanup.
      app.addHook('onError', async (request) => {
        await snapshot(request);
      });
      // Added after the service kit's, so it runs once the response cleanup has finished.
      const responded = new Promise<number>((resolve) => {
        app.addHook('onResponse', async (_request, reply) => resolve(reply.statusCode));
      });
      const boundary = 'opt2boundary';
      const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
      const small = multipartBody(boundary, values.map((value) => ({ name: value, value, filename: `${value}.txt` })));
      if (send === 'inject' || send === 'over-limit') {
        const payload = send === 'inject' ? small : lazyMultipartBody(boundary, 'file', 4, 75).body;
        const res = await app.inject({ method: 'POST', url: '/spool', headers, payload });
        expect(res.statusCode).toBe(status);
        if (status === 200) expect(res.json()).toStrictEqual(values);
      } else {
        await app.listen({ port: 0, host: '127.0.0.1' });
        const { port } = app.server.address() as AddressInfo;
        if (send === 'socket') {
          const res = await fetch(`http://127.0.0.1:${String(port)}/spool`, { method: 'POST', headers, body: small });
          expect(res.status).toBe(status);
          expect(await res.json()).toStrictEqual(values);
        } else {
          const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/spool', headers: { ...headers, 'content-length': String(8 * MIB) } });
          req.on('error', () => undefined);
          req.write(`--${boundary}\r\nContent-Disposition: form-data; name="one"; filename="one.bin"\r\n\r\n`);
          req.write(Buffer.alloc(MIB, 'x'));
          const spooling = await vi.waitFor(
            async () => {
              const now = await readdir(dir);
              expect(now).toHaveLength(1);
              return now;
            },
            { timeout: 5000 },
          );
          listings.push(spooling);
          req.destroy();
        }
      }
      const drained = async (): Promise<void> => {
        expect(await readdir(dir)).toEqual([]);
      };
      if (send === 'abort') {
        // The response never finishes, so onResponse never runs: the close starts the deletion, and the request ends with its error line.
        await vi.waitFor(drained, { timeout: 5000 });
        await vi.waitFor(() => expect(errorMessages()).toStrictEqual(errors), { timeout: 5000 });
      } else {
        expect(await responded).toBe(status);
        await drained();
      }
      expect(listings[0]).toHaveLength(spooled);
      expect(listings[0]?.every((name) => name.startsWith('opt2-upload-'))).toBe(true);
      expect(pluginUploads.length).toBeGreaterThan(0);
      expect(pluginUploads.every((list) => list === null)).toBe(true);
      expect(errorMessages()).toStrictEqual(errors);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('logs a spooled file it cannot delete as one ERROR line and still writes the completion line', async () => {
    const dir = await mkdtemp(`${tmpdir()}/opt2-create-service-spool-`);
    vi.stubEnv('TMPDIR', dir);
    try {
      const { app, lines } = await build();
      app.post('/spool', { config: { opt2: { public: true, invocationOptional: true } } }, async () => {
        // A directory in the spool file's place makes its delete fail.
        const spooled = `${dir}/${(await readdir(dir))[0] ?? ''}`;
        await rm(spooled);
        await mkdir(spooled);
        return 'handled';
      });
      const responded = new Promise<void>((resolve) => {
        app.addHook('onResponse', (_request, _reply, done) => {
          resolve();
          done();
        });
      });
      const boundary = 'opt2boundary';
      const res = await app.inject({
        method: 'POST',
        url: '/spool',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [{ name: 'a', value: 'one', filename: 'a.txt' }]),
      });
      expect(res.statusCode).toBe(200);
      await responded;
      const errors = lines.filter((line) => line.severity === 'ERROR');
      expect(errors).toMatchObject([{ message: 'upload cleanup failed', error: { type: 'SystemError', message: 'rm ERR_FS_EISDIR' } }]);
      expect(validateLogRecord(errors[0]).errors).toStrictEqual([]);
      expect(completedLines(lines)).toMatchObject([{ route: '/spool', statusCode: 200 }]);
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
      app.post('/spool', { config: { opt2: { public: true, invocationOptional: true } } }, async () => {
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
    app.get('/legacy', { config: { opt2: { public: true, invocationOptional: true } } }, async (_request, reply) =>
      sendLegacyResponse(reply, { status: 202, statusText: 'Queued', headers: { 'Content-Type': 'text/csv' }, body: 'a,b' }),
    );
    const res = await app.inject({ method: 'GET', url: '/legacy' });
    expect(res.statusCode).toBe(202);
    expect(res.statusMessage).toBe('Queued');
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.body).toBe('a,b');
  });
});

describe('legacy script protection of params', () => {
  async function echo(
    path = '/echo',
    overrides: Partial<CreateServiceOptions> = {},
  ): Promise<{ app: FastifyInstance; lines: LogLine[]; handled: () => number }> {
    const { app, lines } = await build(overrides);
    let calls = 0;
    app.route({
      method: ['GET', 'POST'],
      url: path,
      config: { opt2: { public: true, invocationOptional: true } },
      handler: async (request) => {
        calls += 1;
        return { params: legacyParamsOf(request), files: multipartFilesOf(request).map(({ field, filename }) => ({ field, filename })) };
      },
    });
    return { app, lines, handled: () => calls };
  }

  it('scans the query and a form body as Masa start-up does', async () => {
    const { app } = await echo();
    const res = await app.inject({
      method: 'POST',
      url: '/echo?title=%3Cscript%3Ex%3C%2Fscript%3E&x-y=%20onload%20&a%20b=dropped&search=%20padded%20&startrow=%2B3',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams([
        ['fname', '<script>alert(1)</script>Aaliyah'],
        ['lname', 'Frami<img src=x onerror=alert(1)>'],
        ['company', 'javascript:alert(1)'],
        ['groupname', "<script>alert('xss')</script>' OR 1=1--"],
        ['body', ' <script>kept '],
        ['amp;notes', ' a\u0000b '],
      ]).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().params).toStrictEqual({
      title: '[INVALID]',
      'x-y': 'onload',
      xy: '[INVALID]',
      search: 'padded',
      startrow: '+3',
      fname: '[INVALID]Aaliyah',
      lname: 'Frami<img src=x [INVALID]=alert(1)>',
      company: '[INVALID]alert(1)',
      groupname: "[INVALID]' OR 1=1--",
      body: ' <script>kept ',
      notes: 'ab',
    });
  });

  it('scans the query beside a JSON body, which it leaves as deserialized', async () => {
    const { app } = await echo();
    const res = await app.inject({
      method: 'POST',
      url: '/echo?q=%20%3Cscript%3E%20',
      headers: { 'content-type': 'application/json' },
      payload: '{"fname":"<script>x</script>","pad":" y ","a b":"kept"}',
    });
    expect(res.json().params).toStrictEqual({ q: '[INVALID]', fname: '<script>x</script>', pad: ' y ', 'a b': 'kept' });
  });

  it('scans multipart fields and keeps file part names as sent, under the names the scan keeps', async () => {
    const { app } = await echo();
    const boundary = 'opt2boundary';
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [
        { name: 'title', value: '<script>x</script>' },
        { name: 'tag', value: ' padded ' },
        { name: 'up-load', value: 'png-bytes', filename: ' <script>a.png', type: 'image/png' },
        { name: 'a b', value: 'gif-bytes', filename: 'b.gif', type: 'image/gif' },
      ]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({
      params: { title: '[INVALID]', tag: 'padded', 'up-load': ' <script>a.png', upload: ' <script>a.png' },
      files: [
        { field: 'up-load', filename: ' <script>a.png' },
        { field: 'a b', filename: 'b.gif' },
      ],
    });
  });

  // Own-oracle probes: ColdFusion's form scope holds every part without a file name as its text, whatever its type.
  it.each<[string, Array<{ name: string; value: string; type?: string }>, Record<string, string>]>([
    ['a JSON array', [{ name: 'groupname', value: '["<script>x</script>"]', type: 'application/json' }], { groupname: '["[INVALID]"]' }],
    ['a JSON string', [{ name: 'groupname', value: '"<script>x</script>"', type: 'application/json' }], { groupname: '"[INVALID]"' }],
    ['a JSON object', [{ name: 'groupname', value: '{"b":1,"a":"<script>x</script>"}', type: 'application/json' }], { groupname: '{"a":"[INVALID]","b":1}' }],
    ['a JSON number', [{ name: 'groupname', value: '1.50', type: 'application/json' }], { groupname: '1.50' }],
    ['a padded JSON string', [{ name: 'groupname', value: '  "  padded  "  ', type: 'application/json' }], { groupname: '"padded"' }],
    ['a JSON boolean', [{ name: 'groupname', value: 'true', type: 'application/json' }], { groupname: 'true' }],
    ['JSON doubles and a long', [{ name: 'groupname', value: '[1e2, 1.0, 9007199254740993]', type: 'application/json' }], { groupname: '[100.0,1.0,9007199254740993]' }],
    ['text that is no JSON', [{ name: 'groupname', value: 'not json <script>x</script>', type: 'application/json' }], { groupname: 'not json [INVALID]' }],
    ['an empty value', [{ name: 'groupname', value: '', type: 'application/json' }], { groupname: '' }],
    ['a __proto__ key', [{ name: 'groupname', value: '{"__proto__":{"x":1}}', type: 'application/json' }], { groupname: '{"__proto__":{"x":1}}' }],
    ['a typed charset', [{ name: 'groupname', value: '"<b>ok</b> onload"', type: 'APPLICATION/JSON; charset=utf-8' }], { groupname: '"<b>ok</b> [INVALID]"' }],
    ['an octet stream', [{ name: 'groupname', value: '<script>x</script>', type: 'application/octet-stream' }], { groupname: '[INVALID]' }],
    [
      'repeated parts',
      [
        { name: 'g', value: '[1,2]', type: 'application/json' },
        { name: 'g', value: '<script>y</script>' },
        { name: 'G', value: '{"a":true}', type: 'application/json' },
      ],
      { g: '[1,2],[INVALID],{"a":true}' },
    ],
  ])('scans a multipart field part without a file name holding %s as the text it was sent as', async (_label, parts, params) => {
    const { app } = await echo();
    const boundary = 'opt2boundary';
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, parts),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ params, files: [] });
  });

  it('keeps a JSON-typed part with a file name a file, its name passing unscanned', async () => {
    const { app } = await echo();
    const boundary = 'opt2boundary';
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [{ name: 'up', value: '["<script>x</script>"]', filename: '<script>a.json', type: 'application/json' }]),
    });
    expect(res.json()).toStrictEqual({ params: { up: '<script>a.json' }, files: [{ field: 'up', filename: '<script>a.json' }] });
  });

  it('answers the legacy error page for a JSON-typed multipart null on a root-served path', async () => {
    const { app, handled } = await echo('/tasks/echo');
    const boundary = 'opt2boundary';
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/echo',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [{ name: 'groupname', value: 'null', type: 'application/json' }]),
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(handled()).toBe(0);
  });

  it.each([
    ['GET', '/_api/json/v1/default/echo?q=null', undefined],
    ['GET', '/legacy-fixtures/cfml/api.cfm/finance/records?amp;-=1', undefined],
    ['POST', '/tasks/echo', 'comment=%5B1%2C%5Bnull%5D%5D'],
  ])('answers %s %s with the legacy error page when the scan fails on a root-served path', async (method, url, payload) => {
    const { app, lines, handled } = await echo(url.split('?')[0]);
    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      ...(payload === undefined ? {} : { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.statusMessage).toBe(LEGACY_ERROR_STATUS_TEXT);
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(handled()).toBe(0);
    expect(lines.find((line) => line.message === 'script protection scan failed')).toMatchObject({ severity: 'ERROR' });
  });

  it.each([
    ['GET', '/legacy-fixtures/cfml/api.cfm/finance/records?q=null', undefined, { q: 'null' }],
    ['POST', '/tasks/echo', 'comment=%5B1%2C%5Bnull%5D%5D', { comment: '[1,[null]]' }],
  ])('passes %s %s to the route with legacyStartupScan false', async (method, url, payload, params) => {
    const { app, lines, handled } = await echo(url.split('?')[0], { legacyStartupScan: false });
    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      ...(payload === undefined ? {} : { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().params).toStrictEqual(params);
    expect(handled()).toBe(1);
    expect(lines.some((line) => line.message === 'script protection scan failed')).toBe(false);
  });

  it('answers a failed url scan on a root-served path before authenticating', async () => {
    const { app } = await build();
    app.get('/_api/json/v1/:siteid/secured', { config: { opt2: { requires: ['s2'] } } }, async () => 'never');
    const unscanned = await app.inject({ method: 'GET', url: '/_api/json/v1/default/secured?q=1' });
    expect(unscanned.statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/_api/json/v1/default/secured?q=%5Bnull%5D' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
  });

  describe('containerRefusesTarget', () => {
    /** An app refusing a target whose query holds a malformed escape, with an s2-only root-served route that counts its runs. */
    async function refusing(): Promise<{ app: FastifyInstance; lines: LogLine[]; handled: () => number }> {
      const { app, lines } = await build({ containerRefusesTarget: (request) => /%(?![0-9A-Fa-f]{2})/.test(request.url) });
      let calls = 0;
      app.get('/core/secured', { config: { opt2: { requires: ['s2'] } } }, () => {
        calls += 1;
        return 'never';
      });
      return { app, lines, handled: () => calls };
    }

    it.each([
      ['a refused target failing the scan', '/core/secured?x=null&y=%', 400],
      ['a refused target', '/core/secured?y=%ZZ', 400],
      ['a refused unmatched target failing the scan', '/core/nothing?x=null&y=%', 400],
      ['an accepted target failing the scan', '/core/secured?x=null&y=%41', 500],
      ['an accepted target', '/core/secured?y=%41', 401],
    ])('answers %s, %s, with %i: the refusal ahead of the start-up scan, the scan ahead of auth', async (_case, url, status) => {
      const { app, handled } = await refusing();
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(status);
      expect(handled()).toBe(0);
    });

    it("answers a refused target with the container's empty 400 that closes the connection, without Date, Generator or HSTS", async () => {
      const { app, lines } = await refusing();
      const res = await app.inject({ method: 'GET', url: '/core/secured?x=null&y=%', headers: AUTHENTICATED });
      expect([res.statusCode, res.statusMessage, res.body]).toStrictEqual([400, 'Bad Request', '']);
      expect(res.headers).toStrictEqual({ 'content-length': '0', connection: 'close' });
      expect(lines.map((line) => [line.severity, line.message, line.statusCode])).toStrictEqual([
        ['WARNING', 'request rejected: container-refused-target', 400],
        ['INFO', 'request completed', 400],
      ]);
    });
  });

  describe('skipsStartupScan', () => {
    /** An app skipping the scan under `/core/skipped/` and refusing a target whose query holds a malformed escape, with an echo route there. */
    function skipping(): Promise<{ app: FastifyInstance; lines: LogLine[]; handled: () => number }> {
      return echo('/core/skipped/echo', {
        containerRefusesTarget: (request) => /%(?![0-9A-Fa-f]{2})/.test(request.url),
        skipsStartupScan: (request) => request.url.startsWith('/core/skipped/'),
      });
    }

    it.each<[string, 'GET' | 'POST', string, number, string | undefined, number]>([
      ['a skipped target failing the url scan', 'GET', '/core/skipped/echo?x=null', 200, undefined, 1],
      ['a skipped target failing the form scan', 'POST', '/core/skipped/echo', 200, 'x=null', 1],
      ['a skipped unmatched target failing the scan', 'GET', '/core/skipped/missing.cfm?x=null', 404, undefined, 0],
      ['an unskipped unmatched target failing the url scan', 'GET', '/core/missing.cfm?x=null', 500, undefined, 0],
      ['an unskipped unmatched target failing the form scan', 'POST', '/core/missing.cfm', 500, 'x=null', 0],
      ['a refused skipped target failing the scan', 'GET', '/core/skipped/echo?x=null&y=%', 400, undefined, 0],
    ])('answers %s, %s %s, with %i: the refusal first, then the scan unless skipped', async (_case, method, url, status, payload, runs) => {
      const { app, handled } = await skipping();
      const res = await app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload }),
      });
      expect(res.statusCode).toBe(status);
      expect(handled()).toBe(runs);
    });

    it('answers skipped targets failing the scan as the route and the not-found handler do, logging no scan failure', async () => {
      const { app, lines } = await skipping();
      const routed = await app.inject({ method: 'GET', url: '/core/skipped/echo?x=null&q=%3Cscript%3E' });
      expect(routed.json<{ params: unknown }>().params).toStrictEqual({ x: 'null', q: '<script>' });
      const unmatched = await app.inject({ method: 'GET', url: '/core/skipped/missing.cfm?x=null' });
      expect(unmatched.body).toBe(legacyErrorResponse('invalidMethodCall', { method: undefined, params: { x: 'null' }, mura404: true }).body);
      expect(lines.some((line) => line.message === 'script protection scan failed')).toBe(false);
    });
  });

  it('keeps the name and NUL fixes of a failed url scan elsewhere, and the form as posted after it', async () => {
    const { app } = await echo('/admin-actions/cusers/update');
    const res = await app.inject({
      method: 'POST',
      url: '/admin-actions/cusers/update?q=null&r=%20%3Cscript%3E%00&amp;s=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a%20b=1&fname=%3Cscript%3E',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().params).toStrictEqual({ q: 'null', r: ' <script>', s: '1', 'a b': '1', fname: '<script>' });
    const formFails = await app.inject({
      method: 'POST',
      url: '/admin-actions/cusers/update?title=%3Cscript%3E',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'q=%5Bnull%5D&fname=%20%3Cscript%3E%20',
    });
    expect(formFails.json().params).toStrictEqual({ title: '[INVALID]', q: '[null]', fname: ' <script> ' });
  });

  it.each([
    ['GET', '/index.cfm/_api/json/v1/default/echo', '/index.cfm/_api/json/v1/default/echo?x=null'],
    ['GET', '/index.cfm/_api/sitemonitor', '/index.cfm/_api/sitemonitor?x=null'],
    ['GET', '/index.cfm/tasks/feed', '/index.cfm/tasks/feed?x=null'],
    ['GET', '/index.cfm', '/index.cfm?x=null'],
    ['GET', '/_api', '/_api?x=null'],
    ['GET', '/tasks', '/tasks?x=null'],
    ['GET', '/core/modules/v1/comments/ajax/commentsProxy.cfc', '/core/modules/v1/comments/ajax/commentsProxy.cfc?commentID=null'],
    ['POST', '/core/modules/v1/favorites/ajax/saveFavorite.cfm', '/core/modules/v1/favorites/ajax/saveFavorite.cfm?x=null'],
    ['GET', '/_api/feed/v1*', '/%5Fapi/feed/v1/x?x=null'],
  ])('answers the legacy error page for a failed scan on root-served route %s %s', async (method, route, url) => {
    const { app, handled } = await echo(route);
    const res = await app.inject({ method: method as 'GET' | 'POST', url });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(handled()).toBe(0);
  });

  it.each([
    ['/index.cfm/_api/json/v1/default/nothing?x=null', 500],
    ['/core/modules/v1/rater/ajax/missing.cfm?x=null', 500],
    ['/v1/nothing?x=null', 404],
    ['/coreish?x=null', 404],
  ])('answers an unmatched %s with status %i', async (url, status) => {
    const { app } = await build();
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(status);
  });

  it('answers a failed scan under a no-case prefix, such as a configured context, in any letter case', async () => {
    const { app, handled } = await echo('/ctx/_api/json/v1*', { noCasePathPrefixes: ['/ctx/_api/json/v1'] });
    const res = await app.inject({ method: 'GET', url: '/CTX/_API/json/v1/default?x=null' });
    expect(res.statusCode).toBe(500);
    expect(handled()).toBe(0);
  });

  it.each(['/v1/groups', '/v2/finance/rollups', '/internal/v1/lookup', '/opt2/files/b/t/o', '/.well-known/jwks.json', '/admin/x', '/_apix', '/index.cfmx', '/tasksx/y', '/legacy-fixturesx'])(
    'passes a failed scan on the target-native or unlisted path %s to the route',
    async (route) => {
      const { app, handled } = await echo(route);
      const res = await app.inject({ method: 'GET', url: `${route}?x=null&siteid=%20tenant-a%20` });
      expect(res.statusCode).toBe(200);
      expect(res.json().params).toStrictEqual({ x: 'null', siteid: ' tenant-a ' });
      expect(handled()).toBe(1);
    },
  );

  it('answers /healthz with a failed scan', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/healthz?x=null' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ status: 'ok' });
  });

  it('answers an unmatched route with the scanned params, a failed scan included', async () => {
    const { app } = await build();
    const failed = await app.inject({ method: 'GET', url: '/nothing?method=find&q=%3Cscript%3E&r=%5Bnull%5D' });
    expect(failed.statusCode).toBe(404);
    expect(failed.body).toBe(
      legacyErrorResponse('invalidMethodCall', { method: 'find', params: { method: 'find', q: '<script>', r: '[null]' }, mura404: true }).body,
    );
    const scanned = await app.inject({ method: 'GET', url: '/nothing?method=find&q=%3Cscript%3E' });
    expect(scanned.body).toBe(
      legacyErrorResponse('invalidMethodCall', { method: 'find', params: { method: 'find', q: '[INVALID]' }, mura404: true }).body,
    );
  });
});

describe('siteid check on the scanned scopes', () => {
  async function staff(): Promise<{ app: FastifyInstance; handled: () => number }> {
    const { app } = await build();
    let calls = 0;
    app.post('/v1/staff', { config: { opt2: { requires: ['s2'] } } }, async (request) => {
      calls += 1;
      return { params: legacyParamsOf(request) };
    });
    return { app, handled: () => calls };
  }

  const form = (pairs: Array<[string, string]>) => ({
    headers: { ...AUTHENTICATED, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(pairs).toString(),
  });
  const parts = (list: Array<{ name: string; value: string; filename?: string }>) => ({
    headers: { ...AUTHENTICATED, 'content-type': 'multipart/form-data; boundary=opt2siteid' },
    payload: multipartBody('opt2siteid', list),
  });
  const json = (body: unknown) => ({ headers: { ...AUTHENTICATED, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

  it.each([
    ['a form site-id', form([['site-id', 'tenant-b']])],
    ['a form siteid the scan replaces with a later SITEID', form([['siteid', 'tenant-b'], ['SITEID', 'tenant-a']])],
    ['a multipart site-id field', parts([{ name: 'site-id', value: ' tenant-b ' }])],
    ['a multipart siteid file part, read by its file name', parts([{ name: 'siteid', value: 'x', filename: 'tenant-b' }])],
    ['a form siteid posted after a failed url scan, which leaves it untrimmed', { ...form([['siteid', ' tenant-a ']]), url: '/v1/staff?x=null' }],
  ])('answers 403 to %s without running the handler', async (_label, request) => {
    const { app, handled } = await staff();
    const res = await app.inject({ method: 'POST', url: '/v1/staff', ...request });
    expect(res.statusCode).toBe(403);
    expect(handled()).toBe(0);
  });

  it.each([
    ['a padded form siteid', form([['siteid', ' tenant-a ']]), 'tenant-a'],
    ['a padded form site-id', form([['site-id', ' tenant-a ']]), 'tenant-a'],
    ['a form siteid with a NUL', form([['siteid', 'tenant\u0000-a']]), 'tenant-a'],
    ['a padded multipart site-id', parts([{ name: 'site-id', value: ' tenant-a ' }]), 'tenant-a'],
    ['a padded url siteid', { ...form([]), url: '/v1/staff?siteid=%20tenant-a%20' }, 'tenant-a'],
    ['another site under a JSON site-id', json({ 'site-id': 'tenant-b' }), undefined],
    ['the token site under a JSON siteid', json({ siteid: 'tenant-a' }), 'tenant-a'],
  ])('admits %s, the handler reading siteid %j', async (_label, request, siteid) => {
    const { app, handled } = await staff();
    const res = await app.inject({ method: 'POST', url: '/v1/staff', ...request });
    expect(res.statusCode).toBe(200);
    expect(res.json().params.siteid).toBe(siteid);
    expect(handled()).toBe(1);
  });

  it('keeps a JSON site-id under its own name in the params', async () => {
    const { app } = await staff();
    const res = await app.inject({ method: 'POST', url: '/v1/staff', ...json({ 'site-id': 'tenant-b' }) });
    expect(res.json().params).toStrictEqual({ 'site-id': 'tenant-b' });
  });
});

describe('legacyScopesOf', () => {
  async function scopes(): Promise<FastifyInstance> {
    const { app } = await build();
    app.post('/scopes', { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => {
      const { url, form, json, jsonBody } = legacyScopesOf(request);
      return { url, form, json, jsonBodyIsBody: jsonBody === request.body, jsonBody };
    });
    return app;
  }

  it('returns the scanned url and form scopes apart, CF-joined and in scope order, with their failure flags', async () => {
    const app = await scopes();
    const res = await app.inject({
      method: 'POST',
      url: '/scopes?q=%20x%20&w-z=onClick&w-z=2',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'k=%3Cscript%3E&q=%5Bnull%5D',
    });
    expect(res.json()).toStrictEqual({
      url: { entries: [['q', 'x'], ['w-z', 'onClick,2'], ['wz', '[INVALID],2']], failed: false },
      form: { entries: [['k', '<script>'], ['q', '[null]']], failed: true },
      json: false,
      jsonBodyIsBody: false,
    });
  });

  it('leaves the form scope empty and hands on a JSON body as sent', async () => {
    const app = await scopes();
    const res = await app.inject({ method: 'POST', url: '/scopes?q=null', headers: { 'content-type': 'application/json' }, payload: '{"siteid":" a ","n":null}' });
    expect(res.json()).toStrictEqual({
      url: { entries: [['q', 'null']], failed: true },
      form: { entries: [], failed: false },
      json: true,
      jsonBodyIsBody: true,
      jsonBody: { siteid: ' a ', n: null },
    });
  });
});

describe('legacy container POST size limit', () => {
  /** An app whose s2-only `/sized`, `/internal/v1/sized` and 8-byte `/small` routes answer the byte length of the body they read. */
  async function sized(): Promise<{ app: FastifyInstance; lines: LogLine[] }> {
    const built = await build();
    for (const [url, bodyLimit] of [['/sized'], ['/internal/v1/sized'], ['/small', 8]] as const) {
      built.app.route({
        method: ['GET', 'POST', 'PUT'],
        url,
        config: { opt2: { requires: ['s2'] } },
        bodyLimit,
        handler: (request) => ({ length: Buffer.isBuffer(request.body) ? request.body.length : 0 }),
      });
    }
    return built;
  }

  /** Asserts the container's Post Size page: status, reason phrase, exact body and only the container's own headers. */
  function expectPostSizePage(res: { statusCode: number; statusMessage: string; headers: Record<string, unknown>; body: string }): void {
    expect(res.statusCode).toBe(400);
    expect(res.statusMessage).toBe(POST_SIZE_STATUS_TEXT);
    expect(res.body).toBe(POST_SIZE_PAGE);
    expect(res.headers).toMatchObject({ 'content-type': LEGACY_HTML_CONTENT_TYPE, 'content-length': '95' });
    expect(Object.keys(res.headers).filter((name) => !['connection', 'date'].includes(name)).sort()).toStrictEqual([
      'content-length',
      'content-type',
    ]);
  }

  function outcomeLines(lines: LogLine[]): unknown[][] {
    for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
    return lines.map((line) => [line.severity, line.message, line.statusCode]);
  }

  it.each([
    { length: LEGACY_MAX_POST_CONTENT_LENGTH + 1, url: '/sized?siteid=tenant-a' },
    { length: 100 * MIB + 4096, url: '/sized?siteid=tenant-a' },
    // The container answers before Masa's start-up scan, which this query fails on a root-served path.
    { length: LEGACY_MAX_POST_CONTENT_LENGTH + 1, url: '/_api/json/v1/tenant-a/content?q=null' },
  ])(
    'answers a POST declaring $length bytes to $url with the Post Size page before auth, logging one WARNING and one INFO line',
    async ({ length, url }) => {
      const { app, lines } = await sized();
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', 'content-length': String(length) },
        payload: '{}',
      });
      expectPostSizePage(res);
      expect(outcomeLines(lines)).toStrictEqual([
        ['WARNING', 'request rejected: FST_ERR_CTP_BODY_TOO_LARGE', 400],
        ['INFO', 'request completed', 400],
      ]);
    },
  );

  it.each([
    { label: 'a POST declaring the largest length the container accepts', method: 'POST', url: '/sized', size: LEGACY_MAX_POST_CONTENT_LENGTH, declared: true },
    { label: 'a PUT over the POST limit', method: 'PUT', url: '/sized', size: 25 * MIB, declared: true },
    { label: 'a GET over the POST limit', method: 'GET', url: '/sized', size: 25 * MIB, declared: true },
    { label: 'a chunked POST over the POST limit', method: 'POST', url: '/sized', size: 25 * MIB, declared: false },
    { label: 'a service-to-service POST over the POST limit', method: 'POST', url: '/internal/v1/sized', size: 25 * MIB, declared: true },
  ] as const)('hands $label to the handler', async ({ method, url, size, declared }) => {
    const { app } = await sized();
    const bytes = Buffer.alloc(size, 'x');
    const res = await app.inject({
      method,
      url,
      headers: { ...AUTHENTICATED, 'content-type': 'application/octet-stream', ...(declared ? { 'content-length': String(size) } : {}) },
      payload: declared ? bytes : Readable.from([bytes]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ length: method === 'GET' ? 0 : size });
  });

  it.each([
    { label: 'a PUT declaring more than the body bound', method: 'PUT', url: '/sized', declared: { 'content-length': String(LEGACY_POST_LIMIT_BYTES + 1) } },
    { label: "a POST over its route's bodyLimit", method: 'POST', url: '/small', declared: {} },
  ] as const)('answers the body-limit error of $label with the Post Size page and a WARNING line', async ({ method, url, declared }) => {
    const { app, lines } = await sized();
    const res = await app.inject({
      method,
      url,
      headers: { ...AUTHENTICATED, 'content-type': 'application/octet-stream', ...declared },
      payload: 'far too long',
    });
    expectPostSizePage(res);
    expect(outcomeLines(lines)).toStrictEqual([
      ['WARNING', 'request rejected: FST_ERR_CTP_BODY_TOO_LARGE', 400],
      ['INFO', 'request completed', 400],
    ]);
  });

  /** Writes `head` to `port`, then `body` once `100 Continue` arrives, and resolves to every byte answered up to `until`. */
  function exchange(port: number, head: readonly string[], body: string, until: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let answered = '';
      const socket = connect(port, '127.0.0.1', () => socket.write(`${head.join('\r\n')}\r\n\r\n`));
      socket.setEncoding('latin1');
      socket.on('data', (chunk: string) => {
        answered += chunk;
        if (answered.endsWith('100 Continue\r\n\r\n')) socket.write(body);
        if (answered.endsWith(until)) socket.destroy();
      });
      socket.on('error', reject);
      socket.on('close', () => resolve(answered));
    });
  }

  it.each([
    { label: 'an oversized POST with Expect', length: LEGACY_MAX_POST_CONTENT_LENGTH + 1, expects: true, interim: false, connection: 'close' },
    { label: 'an oversized POST without Expect', length: LEGACY_MAX_POST_CONTENT_LENGTH + 1, expects: false, interim: false, connection: 'keep-alive' },
    { label: 'an accepted POST with Expect', length: 2, expects: true, interim: true, connection: 'keep-alive' },
  ])('answers $label over HTTP with Connection: $connection and an interim 100 only when it accepts', async ({ length, expects, interim, connection }) => {
    const { app } = await sized();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const head = [
      'POST /sized HTTP/1.1',
      'Host: localhost',
      'Content-Type: application/octet-stream',
      `Content-Length: ${String(length)}`,
      `${INVOCATION_HEADER}: ${SERVICE_CREDENTIAL}`,
      `Authorization: Bearer ${USER_TOKEN}`,
      ...(expects ? ['Expect: 100-continue'] : []),
    ];
    const accepted = length <= LEGACY_MAX_POST_CONTENT_LENGTH;
    const raw = await exchange((app.server.address() as AddressInfo).port, head, 'xx', accepted ? '{"length":2}' : POST_SIZE_PAGE);
    expect(raw.startsWith('HTTP/1.1 100 Continue\r\n\r\n')).toBe(interim);
    const final = raw.replace('HTTP/1.1 100 Continue\r\n\r\n', '');
    expect(final.split('\r\n')[0]).toBe(accepted ? 'HTTP/1.1 200 OK' : `HTTP/1.1 400 ${POST_SIZE_STATUS_TEXT}`);
    expect(final.toLowerCase()).toContain(`\r\nconnection: ${connection}\r\n`);
    expect(final.endsWith(accepted ? '{"length":2}' : `\r\n\r\n${POST_SIZE_PAGE}`)).toBe(true);
  });

  it.each([
    ['the Fastify body-limit error', new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE(), true],
    ['another Fastify client error', new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(), false],
    ['a plain object carrying the code', { code: 'FST_ERR_CTP_BODY_TOO_LARGE' }, false],
  ])('isBodyTooLargeError recognises %s: %s', (_label, err, expected) => {
    expect(isBodyTooLargeError(err)).toBe(expected);
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
    app.get('/anon', { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => ({ scope: request.opt2 }));
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

describe('requests whose outbox publish was incomplete', () => {
  const EVENT_IDS = ['0f7c6a52-0c8e-4d8e-9a43-000000000001', '0f7c6a52-0c8e-4d8e-9a43-000000000002'];
  const ABANDONED = 'request abandoned: outbox publish of its committed events incomplete';
  const UNAVAILABLE = 'request answered 503: outbox publish of its committed events incomplete';
  const UNPUBLISHED_ERROR = { type: 'UnpublishedEventsError', message: 'Outbox publish of 2 committed event(s) incomplete before the answer; left to the sweep' };
  const REQUEST = { method: 'POST', url: '/notes', headers: { ...AUTHENTICATED, 'x-request-id': 'req-unpublished' } } as const;

  /** A service whose POST /notes, with `outbox` as its `opt2Outbox`, records EVENT_IDS as unpublished, then answers through `answer`, and whose GET /plain records nothing. */
  async function notesService(answer: (reply: FastifyReply) => unknown = (reply) => reply.send({ ok: true }), outbox?: Opt2RouteOutboxConfig) {
    const { app, lines } = await build();
    app.post('/notes', { config: { opt2: { requires: ['s2'] }, ...(outbox === undefined ? {} : { opt2Outbox: outbox }) } }, async (_request, reply) => {
      recordUnpublishedEvents(EVENT_IDS);
      return answer(reply);
    });
    app.get('/plain', { config: { opt2: { requires: ['s2'] } } }, async () => ({ ok: true }));
    return { app, lines };
  }

  const abandonedLines = (lines: LogLine[]): LogLine[] => lines.filter((line) => line.message === ABANDONED);
  const unavailableLines = (lines: LogLine[]): LogLine[] => lines.filter((line) => line.message === UNAVAILABLE);
  const LEGACY_503_BODY = { apiversion: 'v1', method: 'save', error: { code: 'server_error', message: 'Unhandled Exception' } };

  it.each<[number, Opt2RouteOutboxConfig | undefined]>([
    [200, undefined],
    [201, undefined],
    [302, undefined],
    [200, { incompleteFlush: 'withhold' }],
  ])('abandons a %i answer under opt2Outbox %o without sending it and logs one WARNING with the request id', async (status, outbox) => {
    const { app, lines } = await notesService((reply) => reply.code(status).send({ ok: true }), outbox);

    await expect(app.inject(REQUEST)).rejects.toMatchObject({ code: 'LIGHT_ECONNRESET' });

    const [abandoned] = await vi.waitFor(() => {
      const found = abandonedLines(lines);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(validateLogRecord(abandoned).errors).toStrictEqual([]);
    expect(abandoned).toMatchObject({
      severity: 'WARNING',
      requestId: 'req-unpublished',
      route: '/notes',
      httpMethod: 'POST',
      tenantId: TENANT_A_ID,
      userId: USER_ID,
      error: UNPUBLISHED_ERROR,
    });
    expect(abandoned?.latencyMs).toEqual(expect.any(Number));
    expect(unavailableLines(lines)).toStrictEqual([]);
    expect(completedLines(lines)).toStrictEqual([]);
    expect(lines.filter((line) => line.severity === 'ERROR')).toStrictEqual([]);
  });

  it.each([200, 201, 302])('answers a %i of a route set to unavailable with the legacy 503 and the unpublished count, one WARNING and its completion line', async (status) => {
    const { app, lines } = await notesService((reply) => reply.code(status).send({ ok: true }), { incompleteFlush: 'unavailable' });

    const res = await app.inject({ ...REQUEST, url: '/notes?method=save' });

    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.json()).toStrictEqual(LEGACY_503_BODY);
    expect(res.headers[UNPUBLISHED_EVENTS_HEADER.toLowerCase()]).toBe(String(EVENT_IDS.length));
    expect(res.headers.generator).toEqual(expect.any(String));
    const warnings = unavailableLines(lines);
    expect(warnings).toHaveLength(1);
    expect(validateLogRecord(warnings[0]).errors).toStrictEqual([]);
    expect(warnings[0]).toMatchObject({
      severity: 'WARNING',
      requestId: 'req-unpublished',
      route: '/notes',
      httpMethod: 'POST',
      tenantId: TENANT_A_ID,
      userId: USER_ID,
      error: UNPUBLISHED_ERROR,
    });
    expect(warnings[0]?.latencyMs).toEqual(expect.any(Number));
    expect(abandonedLines(lines)).toStrictEqual([]);
    expect(completedLines(lines)).toMatchObject([{ requestId: 'req-unpublished', route: '/notes', httpMethod: 'POST', statusCode: 503 }]);
    expect(lines.filter((line) => line.severity === 'ERROR')).toStrictEqual([]);
  });

  it.each(
    [
      { label: 'a 400 the handler sends', answer: (reply: FastifyReply) => reply.code(400).send({ ok: false }), status: 400 },
      {
        label: 'the legacy 503 of an unavailable dependency',
        answer: () => {
          throw new LegacyServiceUnavailableError();
        },
        status: 503,
      },
      {
        label: 'the 500 of an unhandled error',
        answer: () => {
          throw new Error('failed after its commit');
        },
        status: 500,
      },
    ].flatMap((answerCase) => [undefined, { incompleteFlush: 'unavailable' } as const].map((outbox) => ({ ...answerCase, outbox }))),
  )('passes $label unchanged under opt2Outbox $outbox', async ({ answer, status, outbox }) => {
    const { app, lines } = await notesService(answer, outbox);

    const res = await app.inject(REQUEST);

    expect(res.statusCode).toBe(status);
    expect(res.headers[UNPUBLISHED_EVENTS_HEADER.toLowerCase()]).toBeUndefined();
    expect(abandonedLines(lines)).toStrictEqual([]);
    expect(unavailableLines(lines)).toStrictEqual([]);
    expect(completedLines(lines)).toMatchObject([{ requestId: 'req-unpublished', route: '/notes', statusCode: status }]);
  });

  it('answers requests that recorded nothing in full before and after an abandoned one', async () => {
    const { app, lines } = await notesService();

    expect((await app.inject({ method: 'GET', url: '/plain', headers: AUTHENTICATED })).statusCode).toBe(200);
    await expect(app.inject(REQUEST)).rejects.toMatchObject({ code: 'LIGHT_ECONNRESET' });
    const after = await app.inject({ method: 'GET', url: '/plain', headers: AUTHENTICATED });

    expect(after.statusCode).toBe(200);
    expect(after.json()).toStrictEqual({ ok: true });
    expect(completedLines(lines)).toMatchObject([
      { route: '/plain', statusCode: 200 },
      { route: '/plain', statusCode: 200 },
    ]);
    expect(abandonedLines(lines)).toHaveLength(1);
  });

  it('closes the socket of an abandoned request on a real listener, which keeps serving other requests', async () => {
    const { app, lines } = await notesService();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    await expect(fetch(`http://127.0.0.1:${String(port)}/notes`, { method: 'POST', headers: REQUEST.headers })).rejects.toMatchObject({
      cause: { code: 'UND_ERR_SOCKET' },
    });
    const after = await fetch(`http://127.0.0.1:${String(port)}/plain`, { headers: AUTHENTICATED });

    expect(after.status).toBe(200);
    expect(await after.json()).toStrictEqual({ ok: true });
    expect(abandonedLines(lines)).toMatchObject([{ requestId: 'req-unpublished' }]);
  });

  /** A service whose POST /flush-by, with `outbox` as its `opt2Outbox`, answers its request context's flushBy, or null. */
  async function flushByService(outbox?: Opt2RouteOutboxConfig) {
    const { app } = await build();
    app.post('/flush-by', { config: { opt2: { requires: ['s2'] }, ...(outbox === undefined ? {} : { opt2Outbox: outbox }) } }, async () => ({
      flushBy: currentRequestContext()?.flushBy ?? null,
    }));
    return app;
  }

  it('bounds the flushes of a route set to unavailable by its arrival plus SERVICE_CALL_TIMEOUT_MS less FLUSH_ANSWER_MARGIN_MS', async () => {
    const app = await flushByService({ incompleteFlush: 'unavailable' });
    const before = Date.now();

    const res = await app.inject({ method: 'POST', url: '/flush-by', headers: AUTHENTICATED });

    const { flushBy } = res.json<{ flushBy: number }>();
    expect(flushBy).toBeGreaterThanOrEqual(before + SERVICE_CALL_TIMEOUT_MS - FLUSH_ANSWER_MARGIN_MS);
    expect(flushBy).toBeLessThanOrEqual(Date.now() + SERVICE_CALL_TIMEOUT_MS - FLUSH_ANSWER_MARGIN_MS);
  });

  it.each<[string, Opt2RouteOutboxConfig | undefined]>([
    ['withhold', { incompleteFlush: 'withhold' }],
    ['no opt2Outbox', undefined],
  ])('leaves the flushes of a route under %s unbounded by the request', async (_label, outbox) => {
    const app = await flushByService(outbox);

    const res = await app.inject({ method: 'POST', url: '/flush-by', headers: AUTHENTICATED });

    expect(res.json()).toStrictEqual({ flushBy: null });
  });

  it('delivers the 503 of a route set to unavailable on a real listener, which keeps serving other requests', async () => {
    const { app, lines } = await notesService(undefined, { incompleteFlush: 'unavailable' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${String(port)}/notes?method=save`, { method: 'POST', headers: REQUEST.headers });
    const after = await fetch(`http://127.0.0.1:${String(port)}/plain`, { headers: AUTHENTICATED });

    expect(res.status).toBe(503);
    expect(res.headers.get(UNPUBLISHED_EVENTS_HEADER)).toBe(String(EVENT_IDS.length));
    expect(await res.json()).toStrictEqual(LEGACY_503_BODY);
    expect(after.status).toBe(200);
    expect(unavailableLines(lines)).toMatchObject([{ requestId: 'req-unpublished' }]);
    expect(abandonedLines(lines)).toStrictEqual([]);
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

  it('logs an unmatched request under UNMATCHED_ROUTE, without tenant or user', async () => {
    const { app, lines } = await build();
    await app.inject({ method: 'GET', url: '/nothing/here?key=push-key-value' });
    const completed = completedLines(lines);
    expect(completed).toHaveLength(1);
    expect(validateLogRecord(completed[0]).errors).toStrictEqual([]);
    expect(completed[0]).toMatchObject({ route: UNMATCHED_ROUTE, statusCode: 404 });
    expect(completed[0]).not.toHaveProperty('tenantId');
    expect(completed[0]).not.toHaveProperty('userId');
    expect(typeof completed[0]?.requestId).toBe('string');
    expect(JSON.stringify(lines)).not.toContain('nothing/here');
  });

  // Session and secret values are assembled at run time, so no literal credential appears in source; the person is fictional.
  const CFID = ['4017', '2291'].join('');
  const CFTOKEN = ['c0a8f3e1', '9b2d', '4e6f'].join('-');
  const PATH_SECRET = ['opt2', 'path', 'secret'].join('-');
  /** A legacy session id, `MURA<hash>_<CFID>_<CFTOKEN>`, longer than Fastify's default 100-character parameter limit. */
  const SESSION_ID = `MURA${'7E3A'.repeat(24)}_${CFID}_${CFTOKEN}`;

  it.each([
    { label: 'an unmatched path carrying a secret segment', url: `/opt2/stub/notes/${PATH_SECRET}`, status: 404, route: UNMATCHED_ROUTE, warnings: [], leaks: [PATH_SECRET] },
    { label: 'a legacy session id parameter', url: `/x/${SESSION_ID}/state`, status: 200, route: '/x/:sid/state', warnings: [], leaks: [CFID, CFTOKEN] },
    {
      label: "a session id parameter over the router's limit",
      url: `/x/${SESSION_ID}_${'0'.repeat(SERVICE_MAX_HEADER_SIZE)}/state`,
      status: 404,
      route: UNMATCHED_ROUTE,
      warnings: [],
      leaks: [CFID, CFTOKEN],
    },
    {
      label: 'a malformed escape',
      url: `/x/${PATH_SECRET}%zz/state`,
      status: 400,
      route: UNMATCHED_ROUTE,
      warnings: ['request rejected: FST_ERR_BAD_URL'],
      leaks: [PATH_SECRET],
    },
    {
      label: "an unmatched path carrying a person's name and email",
      url: '/v1/users/Aaliyah/Okonkwo/aaliyah.okonkwo@example.com/profile',
      status: 404,
      route: UNMATCHED_ROUTE,
      warnings: [],
      leaks: ['Aaliyah', 'Okonkwo', 'aaliyah.okonkwo'],
    },
    { label: 'a matched route carrying a secret parameter', url: `/x/${PATH_SECRET}/state`, status: 200, route: '/x/:sid/state', warnings: [], leaks: [PATH_SECRET] },
  ])('logs $label under $route, with no path text in any line', async ({ url, status, route, warnings, leaks }) => {
    const { app, lines } = await build();
    app.get('/x/:sid/state', { config: { opt2: { public: true, invocationOptional: true } } }, () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(status);
    const outcomes = lines.filter((line) => line.severity === 'WARNING' || line.message === 'request completed');
    expect(outcomes.map((line) => line.message)).toStrictEqual([...warnings, 'request completed']);
    for (const line of outcomes) expect(line).toMatchObject({ route, httpMethod: 'GET', statusCode: status });
    for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
    const logged = JSON.stringify(lines);
    for (const leak of leaks) expect(logged).not.toContain(leak);
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
      app.post('/deliveries/:id', { config: { opt2: { public: true, invocationOptional: true } } }, async (request) => {
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

  const RECORDED = { route: 'fixture:people.persons.archive', tenantId: tenantIdForSite('tenant-b'), userId: 'C3D4E5F6-0718-293A-4B5C6D7E8F900112' };
  const RECORDED_SCOPE = { tenantId: RECORDED.tenantId, userId: RECORDED.userId };

  interface RecordedCase {
    label: string;
    headers: Record<string, string>;
    records: RequestLogScope[];
    status: number;
    reason: string | null;
    warning: string | null;
    scope: typeof PRINCIPAL | typeof ANONYMOUS | typeof RECORDED_SCOPE;
    verified: string | undefined;
  }

  it.each<RecordedCase>([
    { label: 'a public 200', headers: {}, records: [RECORDED], status: 200, reason: null, warning: null, scope: RECORDED_SCOPE, verified: undefined },
    {
      label: 'a handler 403 recorded in two steps',
      headers: {},
      records: [{ route: RECORDED.route }, { tenantId: RECORDED.tenantId, userId: RECORDED.userId }],
      status: 403,
      reason: 'notOwner',
      warning: 'request denied: notOwner',
      scope: RECORDED_SCOPE,
      verified: undefined,
    },
    { label: 'a recorded route alone', headers: {}, records: [{ route: RECORDED.route }], status: 200, reason: null, warning: null, scope: ANONYMOUS, verified: undefined },
    {
      label: 'empty values after a recorded scope',
      headers: {},
      records: [RECORDED, { route: '', tenantId: '', userId: '' }],
      status: 200,
      reason: null,
      warning: null,
      scope: RECORDED_SCOPE,
      verified: undefined,
    },
    {
      label: 'empty values alone',
      headers: {},
      records: [{ route: RECORDED.route }, { route: '', tenantId: '', userId: '' }],
      status: 200,
      reason: null,
      warning: null,
      scope: ANONYMOUS,
      verified: undefined,
    },
    { label: 'a verified user', headers: AUTHENTICATED, records: [RECORDED], status: 200, reason: null, warning: null, scope: PRINCIPAL, verified: TENANT_A_ID },
  ])(
    'logs $label under the recorded route, with the verified tenant and user else the recorded ones, leaving the request context unchanged',
    async ({ headers, records, status, reason, warning, scope, verified }) => {
      const { app, lines } = await build();
      let seen: unknown;
      app.get('/recorded/:id', { config: { opt2: { public: true, invocationOptional: true } } }, async (request, reply) => {
        for (const record of records) recordLogScope(request, record);
        if (reason !== null) recordOutcomeReason(request, reason);
        seen = { store: currentRequestContext()?.tenantId, user: currentRequestContext()?.user?.sub, request: request.opt2.tenantId };
        return reply.code(status).send('answered');
      });
      const res = await app.inject({ method: 'GET', url: '/recorded/a?key=push-key-value', headers });
      expect(res.statusCode).toBe(status);
      expect(seen).toStrictEqual({ store: verified, user: verified === undefined ? undefined : USER_ID, request: verified });
      const outcomes = lines.filter((line) => line.severity === 'WARNING' || line.message === 'request completed');
      expect(outcomes.map((line) => line.message)).toStrictEqual([...(warning === null ? [] : [warning]), 'request completed']);
      for (const line of outcomes) {
        expect(validateLogRecord(line).errors).toStrictEqual([]);
        expect(line).toMatchObject({ route: RECORDED.route, httpMethod: 'GET', statusCode: status });
        expect({ tenantId: line.tenantId, userId: line.userId }).toStrictEqual(scope);
      }
      expect(JSON.stringify(lines)).not.toContain('push-key-value');
    },
  );

  it.each([
    { label: 'a polled 200', url: '/polled/ok', headers: AUTHENTICATED, expected: [['DEBUG', 'request completed', 200]] },
    { label: 'a polled 302', url: '/polled/moved', headers: AUTHENTICATED, expected: [['DEBUG', 'request completed', 302]] },
    {
      label: 'a polled 401',
      url: '/polled/ok',
      headers: {},
      expected: [
        ['WARNING', 'request denied: missing-credential', 401],
        ['INFO', 'request completed', 401],
      ],
    },
    { label: 'a polled 404', url: '/polled/missing', headers: AUTHENTICATED, expected: [['INFO', 'request completed', 404]] },
    {
      label: 'a polled 500',
      url: '/polled/broken',
      headers: AUTHENTICATED,
      expected: [
        ['ERROR', 'unhandled error', null],
        ['INFO', 'request completed', 500],
      ],
    },
    { label: 'a 200 of a route without the opt-in', url: '/plain/ok', headers: AUTHENTICATED, expected: [['INFO', 'request completed', 200]] },
  ])("logs $label at the level the route's opt2Log and the status select", async ({ url, headers, expected }) => {
    const { logger, lines } = captureLogger('debug');
    const { app } = await build({ logger });
    const answer = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
      const { id } = request.params;
      if (id === 'broken') throw new Error('poll failed');
      if (id === 'moved') return reply.redirect('/polled/ok');
      return reply.code(id === 'missing' ? 404 : 200).send({ id });
    };
    app.get('/polled/:id', { config: { opt2: { requires: ['s2'] }, opt2Log: { successLevel: 'debug' } } }, answer);
    app.get('/plain/:id', { config: { opt2: { requires: ['s2'] } } }, answer);
    await app.inject({ method: 'GET', url, headers });
    const outcomes = lines.filter((line) => line.severity !== 'DEBUG' || line.message === 'request completed');
    expect(outcomes.map((line) => [line.severity, line.message, line.statusCode ?? null])).toStrictEqual(expected);
    for (const line of outcomes) expect(validateLogRecord(line).errors).toStrictEqual([]);
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
