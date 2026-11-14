/** Composition root of identity: the contract route set, the JWKS signer, JSON API path variants, consumers, the sweep chain and resource ownership. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { subscriptionName } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { baseEnvSchema, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import { SITE_CHANGED_TOPIC, tenantForRegisteredSite, type TenantDb } from '@opt2/platform/tenancy';
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
import type { Jwks, TokenSigner } from '../../src/domain/tokens.js';
import { createIdentityTaskPort } from '../../src/tasks/port.js';
import { CLOCK } from '../helpers/service.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  info: { version: string };
  paths: Record<string, Record<string, ContractOperation>>;
};
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
const SWEEP_QUEUE = 'identity-outbox-sweep';
const SITE_SUBSCRIPTION = subscriptionName(SERVICE_NAME, SITE_CHANGED_TOPIC);
const SIGNER_KEYS: Jwks = { keys: [{ kty: 'RSA', n: 'test-modulus', e: 'AQAB', kid: 'app-test-kid', alg: 'RS256', use: 'sig' }] };
const silentLogger = createLogger({ service: SERVICE_NAME, version: SERVICE_VERSION, env: 'local', destination: { write: () => undefined } });

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
    OPT2_SERVICE_URLS: JSON.stringify({ identity: 'http://127.0.0.1:8111' }),
    OPT2_STATE_DIR: stateDir,
    PUBSUB_EMULATOR_HOST: '127.0.0.1:9',
    LOG_LEVEL: 'error',
    TZ: 'UTC',
    ...overrides,
  });
}

describe('identity composition constants', () => {
  it('names the service, versions it as the contract does and reads only the base environment', () => {
    expect(SERVICE_NAME).toBe('identity');
    expect(SERVICE_VERSION).toBe(OPENAPI.info.version);
    expect(identityEnvSchema).toBe(baseEnvSchema);
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

    await expect(build({ env: cloud, db, publisher, taskPort: port })).rejects.toThrow('An Identity Platform adapter is required to mint tokens in the cloud');
    expect(end).not.toHaveBeenCalled();
    expect(publisherClose).not.toHaveBeenCalled();
    expect(portClose).not.toHaveBeenCalled();
    publisherClose.mockRestore();
    portClose.mockRestore();
  });
});
