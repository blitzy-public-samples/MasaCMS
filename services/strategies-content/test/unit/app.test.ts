/** Composition root of strategies-content: start-up, contract-equal routes, consumer-only events, write positions, environment and shutdown. */
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { parse } from 'yaml';
import { SAFE_ERROR_TEXT, serializeError, type Logger } from '@opt2/platform/logging';
import { WRITE_POSITION_HEADER, hasWritePositionHeader } from '@opt2/platform/migration-kit';
import { createService, loadEnv } from '@opt2/platform/service-kit';
import { TENANT_A, createCapturingPublisher, testVerifier } from '@opt2/platform/testing';
import { buildApp, contentEnvSchema, type BuildAppOptions, type ContentEnv } from '../../src/app.js';
import * as consumers from '../../src/events/consumers.js';
import { FEED_AUTO_IMPORT_PATH, PUBLISH_SCHEDULED_CHANGESETS_PATH, registerJobRoutes } from '../../src/jobs/index.js';
import { CONTENT_SERVICE, contentQueues, createContentTaskPort } from '../../src/tasks/port.js';
import {
  SERVICE,
  buildTestApp,
  createFakeTaskPort,
  createMemoryStorage,
  createRecordingDb,
  testEnv,
  type TestApp,
} from '../helpers/app.js';
import { contentHeaders } from '../helpers/tokens.js';

vi.mock('../../src/tasks/port.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tasks/port.js')>();
  return { ...actual, createContentTaskPort: vi.fn(actual.createContentTaskPort) };
});

vi.mock('../../src/jobs/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/jobs/index.js')>();
  return { ...actual, registerJobRoutes: vi.fn(actual.registerJobRoutes) };
});

vi.mock('@opt2/platform/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/service-kit')>();
  return { ...actual, createService: vi.fn(actual.createService) };
});

/** Pub/Sub emulator address of the publisher buildApp creates itself; nothing is published, so nothing connects. */
const EMULATOR_HOST = '127.0.0.1:9';

type Json = Record<string, unknown>;

interface OpenApiDoc {
  paths: Record<string, Json>;
  components?: { parameters?: Record<string, Json> };
}

const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** An OpenAPI operation method in the upper case Fastify registers. */
type HttpMethod = Uppercase<(typeof OPERATION_METHODS)[number]>;

/** One contract operation as Fastify registers it. */
interface ContractRoute {
  operationId: string;
  method: HttpMethod;
  url: string;
}

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;

// The common-prefix tree, because the flattened one drops the static prefix before a trailing wildcard.
/** A `printRoutes()` line: tree indent, branch, radix-node fragment of the path, and the methods of a route ending there. */
const PRINTED_NODE = /^((?:│ {3}| {4})*)[├└]── (.+?)(?: \(([A-Z]+(?:, [A-Z]+)*)\))?$/;

/** Topics the consumers module names, from its `*_TOPIC` exports. */
const NAMED_TOPICS = Object.entries(consumers)
  .filter(([name]) => name.endsWith('_TOPIC'))
  .map(([, topic]) => String(topic))
  .sort();

/** A path or operation parameter with its `#/components/parameters/` reference resolved. */
function resolveParameter(param: Json): Json {
  const ref = param.$ref;
  if (typeof ref !== 'string') return param;
  const resolved = OPENAPI.components?.parameters?.[ref.replace('#/components/parameters/', '')];
  if (resolved === undefined) throw new Error(`contract parameter ${ref} does not resolve`);
  return resolved;
}

/** Every contract operation: each `x-opt2-fastify-path`, one or a list, when given, else `{name}` as `:name` and a final `x-opt2-wildcard` parameter as `*`. */
function contractRoutes(): ContractRoute[] {
  const routes: ContractRoute[] = [];
  for (const [template, item] of Object.entries(OPENAPI.paths)) {
    const shared = (item.parameters as Json[] | undefined) ?? [];
    for (const method of OPERATION_METHODS) {
      const op = item[method] as Json | undefined;
      if (op === undefined) continue;
      const params = [...shared, ...((op.parameters as Json[] | undefined) ?? [])].map(resolveParameter);
      const wildcards = new Set(params.filter((p) => p.in === 'path' && p['x-opt2-wildcard'] === true).map((p) => String(p.name)));
      const override = op['x-opt2-fastify-path'] as string | string[] | undefined;
      const urls =
        override !== undefined
          ? [override].flat()
          : [
              template
                .replace(/\{(\w+)\}$/, (whole: string, name: string) => (wildcards.has(name) ? '*' : whole))
                .replace(/\{(\w+)\}/g, ':$1'),
            ];
      for (const url of urls) routes.push({ operationId: String(op.operationId), method: method.toUpperCase() as HttpMethod, url });
    }
  }
  return routes;
}

/** Contract operations as `METHOD path` in the route tree's spelling, where an escaped `::` reads as `:`. */
function contractRouteTexts(): string[] {
  return contractRoutes().map((route) => `${route.method} ${route.url.replaceAll('::', ':')}`).sort();
}

/** Every registered route as `METHOD path` from Fastify's route tree, without the HEAD routes Fastify derives from GET. */
function registeredRoutes(app: TestApp['app']): string[] {
  const parents: string[] = [];
  const routes: string[] = [];
  for (const line of app.printRoutes().split('\n')) {
    if (line === '') continue;
    const match = PRINTED_NODE.exec(line);
    if (match === null) throw new Error(`route tree line not understood: ${line}`);
    const [, indent = '', fragment = '', methods] = match;
    const depth = indent.length / 4;
    const url = (depth === 0 ? '' : (parents[depth - 1] ?? '')) + fragment;
    parents.length = depth;
    parents.push(url);
    for (const method of methods?.split(', ') ?? []) {
      if (method !== 'HEAD') routes.push(`${method} ${url}`);
    }
  }
  return routes.sort();
}

/** Platform routes the composition root wires beside the route registry. */
const PLATFORM_ROUTES: ReadonlyArray<readonly [HttpMethod, string]> = [
  ['POST', '/internal/v1/migration/apply'],
  ['GET', '/internal/v1/migration/export'],
  ['GET', '/internal/v1/migration/changes'],
  ['GET', '/internal/v1/migration/position'],
  ['GET', '/internal/v1/migration/watermark'],
  ['POST', '/internal/v1/migration/watermark'],
  ['POST', '/internal/v1/migration/gate'],
  ['POST', '/internal/v1/migration/objects'],
  ...consumers.CONTENT_SUBSCRIPTIONS.map((subscription) => ['POST', `/internal/v1/events/${subscription}`] as const),
  ['POST', PUBLISH_SCHEDULED_CHANGESETS_PATH],
  ['POST', FEED_AUTO_IMPORT_PATH],
  ...(['pause', 'resume', 'ensure'] as const).map((op) => ['POST', `/internal/v1/task-queues/:queue/${op}`] as const),
];

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe('strategies-content start-up', () => {
  it('builds through buildApp, readies again and never listens', async () => {
    await expect(t.app.ready()).resolves.toBe(t.app);
    expect(t.app.server.listening).toBe(false);
  });

  it('answers GET /healthz with 200', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('strategies-content routes against contracts/openapi.yaml', () => {
  it('registers every contract operation', () => {
    const missing = contractRoutes()
      .filter((route) => !t.app.hasRoute({ method: route.method, url: route.url }))
      .map((route) => `${route.operationId}: ${route.method} ${route.url}`);
    expect(missing).toEqual([]);
  });

  it('registers exactly the contract operations and nothing else', () => {
    expect(registeredRoutes(t.app)).toEqual(contractRouteTexts());
  });
});

describe('strategies-content platform routes', () => {
  it.each(PLATFORM_ROUTES)('registers %s %s', (method, url) => {
    expect(t.app.hasRoute({ method, url })).toBe(true);
  });

  it('pushes the four consumed topics to strategies-content subscriptions and names the site-monitor job paths', () => {
    expect(consumers.CONTENT_SUBSCRIPTIONS).toEqual([
      'strategies-content.programs-sites.site.changed.v1',
      'strategies-content.identity.group.changed.v1',
      'strategies-content.identity.permission.changed.v1',
      'strategies-content.identity.membership.changed.v1',
    ]);
    expect([PUBLISH_SCHEDULED_CHANGESETS_PATH, FEED_AUTO_IMPORT_PATH]).toEqual([
      '/internal/v1/jobs/publish-scheduled-changesets',
      '/internal/v1/jobs/feed-auto-import',
    ]);
  });
});

describe('strategies-content as a consumer only', () => {
  it('registers no outbox sweep and creates tasks on no outbox-sweep queue', () => {
    for (const method of ['GET', 'POST'] as const) {
      expect(t.app.hasRoute({ method, url: '/internal/v1/outbox/sweep' })).toBe(false);
    }
    expect(registeredRoutes(t.app).filter((route) => route.includes('/outbox'))).toEqual([]);
    expect(contentQueues()).toEqual(['content-scheduled-publish']);
  });

  it('names only topics other services produce, in code and in the contract, and holds no event contracts of its own', () => {
    expect(NAMED_TOPICS).toEqual([
      'identity.group.changed.v1',
      'identity.membership.changed.v1',
      'identity.permission.changed.v1',
      'programs-sites.site.changed.v1',
    ]);
    const contractTopics = Object.values(OPENAPI.paths).flatMap((item) =>
      OPERATION_METHODS.flatMap((method) => {
        const op = item[method] as Json | undefined;
        return op?.['x-opt2-topic'] === undefined ? [] : [[String(op['x-opt2-topic']), String(op['x-opt2-topic-schema'])] as const];
      }),
    );
    expect(contractTopics.map(([topic]) => topic).sort()).toEqual(NAMED_TOPICS);
    for (const [topic, schema] of contractTopics) {
      expect(topic.startsWith(`${CONTENT_SERVICE}.`)).toBe(false);
      expect(schema).toMatch(/^\.\.\/\.\.\/(identity|programs-sites)\/contracts\/events\//);
    }
    expect(existsSync(new URL('../../contracts/events', import.meta.url))).toBe(false);
  });

  it('serves a read route without touching an outbox, publishing or reporting a write position', async () => {
    t.db.clear();
    t.publisher.clear();
    const res = await t.app.inject({
      method: 'GET',
      url: `/v1/sites/${TENANT_A.siteId}/categories`,
      headers: await contentHeaders('site-admin'),
    });
    expect(res.statusCode).toBe(200);
    expect(t.db.statements.filter((statement) => /\boutbox\b/i.test(statement.sql))).toEqual([]);
    expect(t.publisher.published).toEqual([]);
    expect(t.publisher.raw).toEqual([]);
    expect(res.headers[WRITE_POSITION_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('registers the write-position header hook', () => {
    expect(hasWritePositionHeader(t.app)).toBe(true);
  });
});

describe('contentEnvSchema MURA_VARIATIONS', () => {
  it.each<[string | undefined, boolean]>([
    [undefined, false],
    ['', false],
    ['true', true],
    ['yes', true],
    ['1', true],
    ['TRUE', true],
    ['Yes', true],
    ['false', false],
    ['no', false],
    ['0', false],
    ['NO', false],
  ])('parses %j as the ColdFusion boolean %s', (value, expected) => {
    const result = contentEnvSchema.safeParse(testEnv(t.stateDir, { MURA_VARIATIONS: value }));
    expect(result.success).toBe(true);
    expect(result.data?.MURA_VARIATIONS).toBe(expected);
  });

  it.each(['on', 'off', '2', 'y', ' true'])('rejects %j', (value) => {
    const result = contentEnvSchema.safeParse(testEnv(t.stateDir, { MURA_VARIATIONS: value }));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['MURA_VARIATIONS'], message: 'must be true, yes, 1, false, no or 0' }),
    ]);
  });

  it('carries the parsed flag into the app environment and fails start-up on an invalid value', async () => {
    const yes = await buildTestApp({ env: { MURA_VARIATIONS: 'yes' } });
    try {
      expect(yes.env.MURA_VARIATIONS).toBe(true);
    } finally {
      await yes.close();
    }
    expect(t.env.MURA_VARIATIONS).toBe(false);
    await expect(buildTestApp({ env: { MURA_VARIATIONS: 'maybe' } })).rejects.toThrow(/MURA_VARIATIONS: must be true, yes, 1, false, no or 0/);
  });
});

describe('contentEnvSchema MURA_SORTPERMISSION', () => {
  it.each<[string | undefined, string]>([
    [undefined, ''],
    ['', ''],
    ['  ', ''],
    ['author', 'author'],
    ['AUTHOR', 'AUTHOR'],
    ['editor', 'editor'],
  ])('reads %j as the sortPermission %j', (value, expected) => {
    const result = contentEnvSchema.safeParse(testEnv(t.stateDir, { MURA_SORTPERMISSION: value }));
    expect(result.success).toBe(true);
    expect(result.data?.MURA_SORTPERMISSION).toBe(expected);
  });
});

describe('contentEnvSchema process requirements', () => {
  const CALLEE_URLS: Readonly<Record<string, string>> = {
    [SERVICE]: 'http://127.0.0.1:8114',
    identity: 'http://127.0.0.1:8111',
    'programs-sites': 'http://127.0.0.1:8113',
  };
  /** The callee map with every required URL but `callee`'s. */
  const urlsWithout = (callee: string): string =>
    JSON.stringify(Object.fromEntries(Object.entries(CALLEE_URLS).filter(([name]) => name !== callee)));
  const CALLEES =
    'OPT2_SERVICE_URLS.strategies-content: is required; OPT2_SERVICE_URLS.identity: is required; OPT2_SERVICE_URLS.programs-sites: is required';

  it.each<[string, Record<string, string | undefined>, string[], string]>([
    ['another service name', { OPT2_SERVICE_NAME: 'people' }, ['OPT2_SERVICE_NAME: must be strategies-content'], 'people: invalid environment (OPT2_SERVICE_NAME: must be strategies-content)'],
    [
      'no identity URL',
      { OPT2_SERVICE_URLS: urlsWithout('identity') },
      ['OPT2_SERVICE_URLS.identity: is required'],
      'strategies-content: invalid environment (OPT2_SERVICE_URLS.identity: is required)',
    ],
    [
      'no programs-sites URL',
      { OPT2_SERVICE_URLS: urlsWithout('programs-sites') },
      ['OPT2_SERVICE_URLS.programs-sites: is required'],
      'strategies-content: invalid environment (OPT2_SERVICE_URLS.programs-sites: is required)',
    ],
    [
      'no URL of its own',
      { OPT2_SERVICE_URLS: urlsWithout(SERVICE) },
      ['OPT2_SERVICE_URLS.strategies-content: is required'],
      'strategies-content: invalid environment (OPT2_SERVICE_URLS.strategies-content: is required)',
    ],
    [
      'no callee map',
      { OPT2_SERVICE_URLS: undefined },
      ['OPT2_SERVICE_URLS.strategies-content: is required', 'OPT2_SERVICE_URLS.identity: is required', 'OPT2_SERVICE_URLS.programs-sites: is required'],
      `strategies-content: invalid environment (${CALLEES})`,
    ],
    ['no OPT2_DB_AUTH', { OPT2_DB_AUTH: undefined }, ['OPT2_DB_AUTH: is required'], 'strategies-content: invalid environment (OPT2_DB_AUTH: is required)'],
    ['no PG_DATABASE', { PG_DATABASE: undefined }, ['PG_DATABASE: is required'], 'strategies-content: invalid environment (PG_DATABASE: is required)'],
  ])('refuses %s, naming each variable with its value-free reason', (_case, overrides, issues, safeText) => {
    let thrown: unknown;
    try {
      loadEnv(contentEnvSchema, testEnv(t.stateDir, overrides));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ name: 'EnvValidationError', issues });
    expect((thrown as { [SAFE_ERROR_TEXT]?: unknown })[SAFE_ERROR_TEXT]).toBe(safeText);
  });

  it('is the environment buildApp reads by default', async () => {
    for (const [key, value] of Object.entries(testEnv(t.stateDir, { OPT2_SERVICE_NAME: 'people' }))) vi.stubEnv(key, value);
    try {
      await expect(buildApp()).rejects.toMatchObject({
        name: 'EnvValidationError',
        issues: expect.arrayContaining(['OPT2_SERVICE_NAME: must be strategies-content']),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('strategies-content buildApp resources', () => {
  /** buildApp over `env` with the test verifier and memory storage; `opts` adds the injected pool, publisher or task port. */
  function build(env: ContentEnv, opts: Omit<BuildAppOptions, 'env'> = {}): ReturnType<typeof buildApp> {
    return buildApp({ env, clock: t.clock, verifierOverride: testVerifier(SERVICE), storage: createMemoryStorage({ clock: t.clock }), ...opts });
  }

  afterEach(() => {
    // Drops unconsumed one-off results and restores the real factories later builds in this file run through.
    vi.mocked(createContentTaskPort).mockReset();
    vi.mocked(registerJobRoutes).mockReset();
    vi.mocked(createService).mockReset();
  });

  it('rejects a local start-up without PUBSUB_EMULATOR_HOST before acquiring a task port', async () => {
    vi.mocked(createContentTaskPort).mockClear();
    await expect(build(t.env, { db: createRecordingDb() })).rejects.toThrow(/PUBSUB_EMULATOR_HOST: is required when OPT2_ENV=local/);
    expect(createContentTaskPort).not.toHaveBeenCalled();
  });

  it('creates its own task port over the pool and publisher on the emulator, and closes the port when the app closes', async () => {
    const db = createRecordingDb();
    const port = createFakeTaskPort();
    const portClose = vi.spyOn(port, 'close');
    vi.mocked(createContentTaskPort).mockResolvedValueOnce(port);
    const env: ContentEnv = { ...t.env, PUBSUB_EMULATOR_HOST: EMULATOR_HOST };

    const app = await build(env, { db });
    try {
      await app.ready();
      expect(vi.mocked(createContentTaskPort)).toHaveBeenLastCalledWith(env, expect.objectContaining({ db, clock: t.clock }));
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
    expect(portClose).toHaveBeenCalledTimes(1);
  });

  /** Makes buildApp's own task port a fake and its job-route registration throw; returns the failure and the port's close spy. */
  function failAfterTaskPort() {
    const failure = new Error('job route registration failed');
    const port = createFakeTaskPort();
    const portClose = vi.spyOn(port, 'close');
    vi.mocked(createContentTaskPort).mockResolvedValueOnce(port);
    vi.mocked(registerJobRoutes).mockImplementationOnce(() => {
      throw failure;
    });
    return { failure, portClose };
  }

  it('closes its own task port, leaves an injected pool open and rethrows when a step after createService fails', async () => {
    const { failure, portClose } = failAfterTaskPort();
    // The recording pool is frozen, so its end is observed on a copy.
    const db = { ...createRecordingDb(), end: vi.fn(async (): Promise<void> => undefined) };

    await expect(build(t.env, { db, publisher: createCapturingPublisher() })).rejects.toBe(failure);
    expect(portClose).toHaveBeenCalledTimes(1);
    expect(db.end).not.toHaveBeenCalled();
  });

  /** Has createService, asked for the `content` pool, open a recording pool whose end rejects with `endFailure` if given; returns it and the app's cleanup failure logs. */
  function openRecordingPool(endFailure?: Error) {
    // The recording pool is frozen, so its end is observed on a copy.
    const pool = { ...createRecordingDb(), end: vi.fn((): Promise<void> => (endFailure === undefined ? Promise.resolve() : Promise.reject(endFailure))) };
    let logError: MockInstance<Logger['error']> | undefined;
    vi.mocked(createService).mockImplementationOnce(async (options) => {
      const actual = await vi.importActual<typeof import('@opt2/platform/service-kit')>('@opt2/platform/service-kit');
      const app = await actual.createService({ ...options, schema: undefined, pool });
      logError = vi.spyOn(app.opt2.logger, 'error');
      return app;
    });
    const cleanupFailures = () => logError?.mock.calls.filter(([, message]) => message === 'start-up cleanup failed');
    return { pool, cleanupFailures };
  }

  it.each<[string, Error | undefined]>([
    ['ends', undefined],
    ['logs the failure to end', new Error('pool end failed')],
  ])('closes its own task port, %s the pool createService opened and rethrows when a step after createService fails', async (_, endFailure) => {
    const { failure, portClose } = failAfterTaskPort();
    const { pool, cleanupFailures } = openRecordingPool(endFailure);

    await expect(build(t.env, { publisher: createCapturingPublisher() })).rejects.toBe(failure);
    expect(vi.mocked(createService).mock.lastCall?.[0]).toMatchObject({ schema: 'content' });
    expect(vi.mocked(createService).mock.lastCall?.[0]).not.toHaveProperty('pool');
    expect(portClose).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(cleanupFailures()).toEqual(endFailure === undefined ? [] : [[{ error: serializeError(endFailure) }, 'start-up cleanup failed']]);
  });

  it('rethrows the start-up failure when closing its own task port also fails, leaving the injected publisher open', async () => {
    const { failure, portClose } = failAfterTaskPort();
    portClose.mockRejectedValueOnce(new Error('task port close failed'));
    const publisher = createCapturingPublisher();
    const publisherClose = vi.spyOn(publisher, 'close');

    await expect(build(t.env, { db: createRecordingDb(), publisher })).rejects.toBe(failure);
    expect(portClose).toHaveBeenCalledTimes(1);
    expect(publisherClose).not.toHaveBeenCalled();
  });
});

describe('strategies-content shutdown', () => {
  it('closes the app and its state directory without error, leaving the injected task port and publisher to the caller', async () => {
    const own = await buildTestApp();
    const taskPortClose = vi.spyOn(own.taskPort, 'close');
    const publisherClose = vi.spyOn(own.publisher, 'close');

    await expect(own.close()).resolves.toBeUndefined();
    await expect(own.close()).resolves.toBeUndefined();

    expect(existsSync(own.stateDir)).toBe(false);
    await expect(own.app.inject({ method: 'GET', url: '/healthz' })).rejects.toMatchObject({ code: 'FST_ERR_REOPENED_CLOSE_SERVER' });
    expect(taskPortClose).not.toHaveBeenCalled();
    expect(publisherClose).not.toHaveBeenCalled();
    await expect(own.taskPort.close()).resolves.toBeUndefined();
  });
});
