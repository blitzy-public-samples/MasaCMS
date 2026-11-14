/** Composition root of identity: the role-map start-up check, the cloud Identity Platform adapter, the contract route set, the JWKS signer, JSON API path variants, consumers, the sweep chain and resource ownership. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { decodeJwt } from 'jose';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cloudUserTokenSettings, collectRouteMatrix } from '@opt2/platform/auth';
import { subscriptionName } from '@opt2/platform/events';
import { createLogger, serializeError } from '@opt2/platform/logging';
import { EnvValidationError, baseEnvSchema, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import { SITE_CHANGED_TOPIC, SYSTEM_TENANT_ID, tenantForRegisteredSite, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createCapturingPublisher,
  createThrowawaySchema,
  pgAvailable,
  pushTo,
  registryPayloads,
  testEnvelope,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SERVICE_NAME, SERVICE_VERSION, buildApp, identityEnvSchema, type BuildAppOptions } from '../../src/app.js';
import { SIGN_IN_WITH_CUSTOM_TOKEN_URL, type Jwks, type TokenSigner } from '../../src/domain/tokens.js';
import { createIdentityTaskPort } from '../../src/tasks/port.js';
import { createFakeTaskPort, createTestStateDir, headersFor, testEnv } from '../helpers/app.js';
import { recordTenantListing, testFirebaseApp } from '../helpers/firebase.js';
import { createRecordingDb } from '../helpers/memory-repo.js';
import { SITE_ADMIN_A, loginSnapshotFixture, sessionRow } from '../helpers/rows.js';
import { CLOCK } from '../helpers/service.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  info: { version: string };
  paths: Record<string, Record<string, ContractOperation>>;
};
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
const SWEEP_QUEUE = 'identity-outbox-sweep';
const SITE_SUBSCRIPTION = subscriptionName(SERVICE_NAME, SITE_CHANGED_TOPIC);
const SESSION_READ = /^SELECT \* FROM "identity"\."session" WHERE "tenant_id" = \$1 AND "session_id" = \$2$/;
const SIGNER_KEYS: Jwks = { keys: [{ kty: 'RSA', n: 'test-modulus', e: 'AQAB', kid: 'app-test-kid', alg: 'RS256', use: 'sig' }] };
const silentLogger = createLogger({ service: SERVICE_NAME, version: SERVICE_VERSION, env: 'local', destination: { write: () => undefined } });
// Ports of harness/repro/ports.env; the gateway comes from OPT2_GATEWAY_URL.
const CALLEE_URLS = { identity: 'http://127.0.0.1:8111', people: 'http://127.0.0.1:8112', 'strategies-content': 'http://127.0.0.1:8114' };

/** Route declaration as the route matrix and the contract both state it. */
interface Declared {
  key: string;
  transport: unknown;
  requires: string[];
  public: boolean;
}

/** Every contract operation as `METHOD /fastify/:pattern`, with its declared authorisation. */
function contractOperations(): Declared[] {
  return Object.entries(OPENAPI.paths).flatMap(([template, operations]) =>
    Object.entries(operations)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => ({
        key: `${method.toUpperCase()} ${template.replace(/\{([^}]+)\}/g, ':$1')}`,
        transport: operation['x-opt2-transport'],
        requires: [...((operation['x-opt2-requires'] as string[] | undefined) ?? [])].sort(),
        public: operation['x-opt2-public'] === true,
      })),
  );
}

/** Registered routes with Fastify's escaped literal colons unescaped. */
function registeredRoutes(app: FastifyInstance): Declared[] {
  return collectRouteMatrix(app).routes.map((route) => ({
    key: `${route.method} ${route.url.replace(/\(\.\+\)::/g, ':').replace(/::/g, ':')}`,
    transport: route.transport,
    requires: [...(route.requires ?? [])].sort(),
    public: route.public === true,
  }));
}

/** The registered route serving a contract operation: the exact pattern, else the JSON API family wildcard covering it. */
function servingRoute(routes: readonly Declared[], key: string): Declared | undefined {
  return routes.find((route) => route.key === key) ?? routes.find((route) => route.key.endsWith('*') && key.startsWith(`${route.key.slice(0, -1)}/`));
}

function envFor(stateDir: string, overrides: Readonly<Record<string, string | undefined>> = {}): BaseEnv {
  return loadEnv(identityEnvSchema, {
    PORT: '8111',
    OPT2_SERVICE_NAME: SERVICE_NAME,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_GATEWAY_URL: 'http://127.0.0.1:8100',
    OPT2_SERVICE_URLS: JSON.stringify(CALLEE_URLS),
    OPT2_STATE_DIR: stateDir,
    PUBSUB_EMULATOR_HOST: '127.0.0.1:9',
    LOG_LEVEL: 'error',
    TZ: 'UTC',
    ...overrides,
  });
}

/** The issues `loadEnv(identityEnvSchema)` reports for `envFor(…, overrides)`; none when it parses. */
function envIssues(overrides: Readonly<Record<string, string | undefined>>): string[] {
  try {
    envFor(tmpdir(), overrides);
    return [];
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues;
    throw err;
  }
}

describe('identity composition constants', () => {
  it('names the service, versions it as the contract does and reads only the base variables', () => {
    expect(SERVICE_NAME).toBe('identity');
    expect(SERVICE_VERSION).toBe(OPENAPI.info.version);
    expect(Object.keys(identityEnvSchema.shape)).toStrictEqual(Object.keys(baseEnvSchema.shape));
  });

  const everyCallee = [
    'OPT2_SERVICE_URLS.identity: is required',
    'OPT2_SERVICE_URLS.people: is required',
    'OPT2_SERVICE_URLS.strategies-content: is required',
  ];
  it.each<[string, Record<string, string | undefined>, string[]]>([
    ['parses a map naming every callee beside OPT2_GATEWAY_URL', {}, []],
    [
      'parses a map naming the gateway without OPT2_GATEWAY_URL',
      { OPT2_GATEWAY_URL: undefined, OPT2_SERVICE_URLS: JSON.stringify({ ...CALLEE_URLS, gateway: 'http://127.0.0.1:8100' }) },
      [],
    ],
    ['names every callee when OPT2_SERVICE_URLS is unset', { OPT2_SERVICE_URLS: undefined }, everyCallee],
    ['names every callee when OPT2_SERVICE_URLS is {}', { OPT2_SERVICE_URLS: '{}' }, everyCallee],
    [
      'names only the callees a partial map lacks',
      { OPT2_SERVICE_URLS: JSON.stringify({ people: CALLEE_URLS.people }) },
      ['OPT2_SERVICE_URLS.identity: is required', 'OPT2_SERVICE_URLS.strategies-content: is required'],
    ],
    [
      'names OPT2_GATEWAY_URL when neither it nor the map names the gateway',
      { OPT2_GATEWAY_URL: undefined },
      ['OPT2_GATEWAY_URL: is required (or OPT2_SERVICE_URLS.gateway)'],
    ],
    [
      'names the callees beside another failed variable',
      { PORT: 'abc', OPT2_SERVICE_URLS: '{}' },
      [expect.stringMatching(/^PORT: /), ...everyCallee],
    ],
    [
      'reports only its own issue for a map that is not JSON',
      { OPT2_GATEWAY_URL: undefined, OPT2_SERVICE_URLS: 'not-json' },
      ['OPT2_SERVICE_URLS: OPT2_SERVICE_URLS must be a JSON object'],
    ],
    [
      'reports only its own issue for a JSON array',
      { OPT2_GATEWAY_URL: undefined, OPT2_SERVICE_URLS: '[]' },
      [expect.stringMatching(/^OPT2_SERVICE_URLS: /)],
    ],
  ])('identityEnvSchema %s', (_case, overrides, issues) => {
    expect(envIssues(overrides)).toStrictEqual(issues);
  });
});

describe('identity buildApp with an invalid role map', () => {
  afterEach(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it.each([
    { invalid: 'is not JSON', text: '{bad json', reason: /^role-map\.json: .+ JSON/, cause: SyntaxError },
    {
      invalid: 'maps a group to an unknown role',
      text: JSON.stringify({ sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f', scope: 'privateUserPool', groups: [{ groupName: 'Payroll', role: 'timesheets.bogus-role' }] }),
      reason: /^role-map\.json: role-map\.json group .+ needs a groupName and a synthetic role$/,
      cause: TypeError,
    },
  ])('refuses to start when role-map.json $invalid', async ({ text, reason, cause }) => {
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      const readFile = ((file: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) =>
        String(file).endsWith('/config/role-map.json')
          ? Promise.resolve(text)
          : (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof actual.readFile;
      return { ...actual, readFile };
    });
    const fresh = await import('../../src/app.js');

    const refused = await fresh.buildApp({ env: envFor(path.join(tmpdir(), 'identity-unused-state')) }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(refused?.name).toBe('RoleMapError');
    expect(refused?.message).toMatch(reason);
    expect(refused?.cause).toBeInstanceOf(cause);
    expect(serializeError(refused).message).toBe('identity: invalid configuration file role-map.json');
  });
});

describe('identity buildApp in the cloud', () => {
  it('mints through the Identity Platform adapter it builds from the project tenants', async () => {
    const session = 'S0000000-0000-0000-0000000000000001';
    const user = SITE_ADMIN_A.account.userid;
    const { issuer, audience } = cloudUserTokenSettings('proj');
    const stateDir = await createTestStateDir();
    const env = testEnv(
      {
        OPT2_ENV: 'cloud',
        OPT2_DB_AUTH: undefined,
        OPT2_TASKS_ADAPTER: 'cloud',
        OPT2_STORAGE_ADAPTER: 'cloud',
        GOOGLE_CLOUD_PROJECT: 'proj',
        OPT2_TOKEN_ISSUER: issuer,
        OPT2_TOKEN_AUDIENCE: audience,
        LOG_LEVEL: 'error',
      },
      stateDir,
    );
    const db = createRecordingDb();
    const stored = sessionRow({
      tenant_id: SYSTEM_TENANT_ID,
      session_id: session,
      user_id: user,
      site_id: TENANT_A.siteId,
      login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: SITE_ADMIN_A })),
      epoch: '3',
    });
    db.respond((sql, values) => SESSION_READ.test(sql) && values[0] === SYSTEM_TENANT_ID && values[1] === session, [stored]);
    const firebaseApp = await testFirebaseApp('identity-app-cloud');
    const pageTokens = recordTenantListing(firebaseApp, [
      { tenants: [{ tenantId: 'umbrella-2b4c6', displayName: 'umbrella' }], pageToken: 'page-2' },
      { tenants: [{ tenantId: 'tenant-a-8d0f2', displayName: 'tenant-a' }] },
    ]);
    const exchanges: string[] = [];
    const passThrough = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) !== SIGN_IN_WITH_CUSTOM_TOKEN_URL) return passThrough(input, init);
      exchanges.push(String(init?.body));
      return Promise.resolve(new Response(JSON.stringify({ idToken: 'recorded-id-token', expiresIn: '3600', refreshToken: 'refresh' })));
    });
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({
        env, clock: CLOCK, verifierOverride: testVerifier(SERVICE_NAME), db, publisher: createCapturingPublisher(), taskPort: createFakeTaskPort(), firebaseApp,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/v1/tokens',
        headers: { ...(await headersFor('service:gateway')), 'content-type': 'application/json' },
        payload: JSON.stringify({ sessionId: session, siteId: TENANT_A.siteId }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ token: 'recorded-id-token', epoch: 3, claims: { iss: issuer, aud: 'proj', sub: user, sid: session, site: TENANT_A.siteId } });
      expect(pageTokens).toEqual([undefined, 'page-2']);
      expect(exchanges).toHaveLength(1);
      const body = JSON.parse(exchanges[0] ?? '{}') as { token: string; tenantId: string };
      expect(body.tenantId).toBe('tenant-a-8d0f2');
      expect(decodeJwt(body.token)).toMatchObject({ uid: user, tenant_id: 'tenant-a-8d0f2' });
    } finally {
      await app?.close();
      fetchSpy.mockRestore();
      await deleteApp(firebaseApp);
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('identity buildApp over a throwaway schema', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let port: TaskPort;
  let app: FastifyInstance;
  const signer: TokenSigner = { sign: () => Promise.resolve('unused'), jwks: () => Promise.resolve(SIGNER_KEYS) };
  const publisher = createCapturingPublisher();

  function build(options: BuildAppOptions = {}): Promise<FastifyInstance> {
    return buildApp({ env: envFor(stateDir), clock: CLOCK, verifierOverride: testVerifier(SERVICE_NAME), db: handle.app, ...options });
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE_NAME, migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-app-'));
    await writeTestSecrets(stateDir);
    port = await createIdentityTaskPort(envFor(stateDir), { db: handle.app, clock: CLOCK, logger: silentLogger });
    // The dispatcher is stopped so the sweep chain's task stays pending and nothing is sent to OPT2_SERVICE_URLS.
    await port.close();
    app = await build({ publisher, taskPort: port, signer });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('answers health and publishes the injected signer key set', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const jwks = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(jwks.statusCode).toBe(200);
    expect(jwks.json()).toEqual(SIGNER_KEYS);
  });

  it('serves every contract operation with its declared transport and roles, and nothing else', () => {
    const routes = registeredRoutes(app);
    const contract = contractOperations();
    const contractKeys = new Set(contract.map((operation) => operation.key));
    const unserved = contract.filter((operation) => servingRoute(routes, operation.key) === undefined).map((operation) => operation.key);
    const undeclared = routes.filter((route) => !route.key.endsWith('*') && !contractKeys.has(route.key)).map((route) => route.key);

    expect({ unserved, undeclared }).toEqual({ unserved: [], undeclared: [] });
    for (const operation of contract) {
      const route = servingRoute(routes, operation.key);
      expect({ key: operation.key, transport: route?.transport, public: route?.public }).toEqual({
        key: operation.key,
        transport: operation.transport,
        public: operation.public,
      });
      if (!operation.public) expect({ key: operation.key, requires: route?.requires }).toEqual({ key: operation.key, requires: operation.requires });
    }
  });

  it.each([
    ['/index.cfm/_api/json/v1/default/group/properties', '/_api/json/v1/default/group/properties'],
    ['/_API/JSON/V1/default/group/properties', '/_api/json/v1/default/group/properties'],
    ['/INDEX.CFM/_api/rest/v1/default/group/properties', '/_api/rest/v1/default/group/properties'],
  ])('routes the JSON API path %s like %s', async (variantUrl, plainUrl) => {
    const plain = await app.inject({ method: 'GET', url: plainUrl });
    const variant = await app.inject({ method: 'GET', url: variantUrl });

    expect(plain.statusCode).not.toBe(404);
    expect({ status: variant.statusCode, body: variant.body }).toEqual({ status: plain.statusCode, body: plain.body });
  });

  it('starts its outbox-sweep chain when ready', async () => {
    expect((await port.list(SWEEP_QUEUE)).tasks.length).toBeGreaterThan(0);
  });

  it('applies site registry events delivered to its push subscription', async () => {
    const payload = registryPayloads().find((entry) => entry.siteId === TENANT_A.siteId);
    if (payload === undefined) throw new Error(`registryPayloads has no ${TENANT_A.siteId} entry`);
    const envelope = testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateType: 'site', aggregateId: payload.siteId, payload });

    expect((await pushTo(app, SITE_SUBSCRIPTION, envelope)).statusCode).toBe(204);
    expect(await handle.app.withMetadata((tx) => tenantForRegisteredSite(tx, TENANT_A.siteId))).toBe(TENANT_A.tenantId);
  });

  it('starts with its own publisher and leaves injected resources open when it closes', async () => {
    const publisherClose = vi.spyOn(publisher, 'close');
    const portClose = vi.spyOn(port, 'close');
    const own = await build({ taskPort: port, signer });
    await own.ready();
    expect((await own.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await own.close();

    const injected = await build({ publisher, taskPort: port, signer });
    await injected.close();

    expect(publisherClose).not.toHaveBeenCalled();
    expect(portClose).not.toHaveBeenCalled();
    publisherClose.mockRestore();
    portClose.mockRestore();
  });

  it('rethrows a failed start-up without ending the injected pool or closing injected resources', async () => {
    const end = vi.fn(() => Promise.resolve());
    const db = Object.create(handle.app, { end: { value: end } }) as TenantDb;
    const publisherClose = vi.spyOn(publisher, 'close');
    const portClose = vi.spyOn(port, 'close');
    const cloud = envFor(stateDir, { OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: 'opt2-test', PUBSUB_EMULATOR_HOST: undefined, OPT2_JWKS_URL: undefined });
    const firebaseApp = await testFirebaseApp('identity-app-refused-listing');
    getAuth(firebaseApp).tenantManager().listTenants = () => Promise.reject(new Error('PERMISSION_DENIED: identitytoolkit.tenants.list'));

    try {
      await expect(build({ env: cloud, db, publisher, taskPort: port, firebaseApp })).rejects.toThrow('PERMISSION_DENIED: identitytoolkit.tenants.list');
      expect(end).not.toHaveBeenCalled();
      expect(publisherClose).not.toHaveBeenCalled();
      expect(portClose).not.toHaveBeenCalled();
    } finally {
      publisherClose.mockRestore();
      portClose.mockRestore();
      await deleteApp(firebaseApp);
    }
  });
});
