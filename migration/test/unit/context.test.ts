// Unit tests for the shared migration context: injected ports stay untouched, created ports close newest first.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { INVOCATION_HEADER, rolesForService, verifyLocalServiceToken } from '@opt2/platform/auth';
import type { Logger } from '@opt2/platform/logging';
import { fixedClock, systemClock, type ServiceClient } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { testSigningKeys, writeTestSecrets } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { createMigrationContext, type CreateContextOptions } from '../../src/context.js';
import type { GatewayClient } from '../../src/cutover/gateway-client.js';
import { UnsupportedLegacyDatabaseError, loadMigrationEnv, type MigrationEnv } from '../../src/env.js';
import type { BridgeClient } from '../../src/legacy/bridge.js';
import type { LegacyDb } from '../../src/legacy/legacy-db.js';
import type { OwnersClient } from '../../src/owners/client.js';
import type { UnitCatalog } from '../../src/owners/units.js';

/** Close calls of the ports the context creates, in call order; a name in `failing` throws after its real close. */
const closes = vi.hoisted(() => {
  const order: string[] = [];
  const failing = new Set<string>();
  const record =
    (name: string, close: () => Promise<void>) =>
    async (): Promise<void> => {
      order.push(name);
      await close();
      if (failing.has(name)) throw new Error(`${name} close failed`);
    };
  return { order, failing, record };
});

vi.mock('@opt2/platform/tenancy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tenancy')>();
  return {
    ...actual,
    createPool: async (opts: Parameters<typeof actual.createPool>[0]) => {
      const db = await actual.createPool(opts);
      return { ...db, end: closes.record('db', () => db.end()) };
    },
  };
});

vi.mock('@opt2/platform/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/service-kit')>();
  return {
    ...actual,
    createServiceClient: (opts: Parameters<typeof actual.createServiceClient>[0]) => {
      const client = actual.createServiceClient(opts);
      return { request: client.request, close: closes.record(`client:${opts.self}`, () => client.close()) };
    },
  };
});

vi.mock('../../src/legacy/legacy-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/legacy/legacy-db.js')>();
  return {
    ...actual,
    createLegacyDb: (...args: Parameters<typeof actual.createLegacyDb>) => {
      const legacy = actual.createLegacyDb(...args);
      return { ...legacy, close: closes.record('legacy', () => legacy.close()) };
    },
  };
});

/** Creation order is db, migration client, legacy, then the operator client the gateway client needs. */
const CREATED_CLOSE_ORDER = ['client:operator', 'legacy', 'client:migration', 'db'];

let stateDir: string;

/** Placeholder environment of the migration service; no value is a real credential. */
function envSource(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: '8102',
    OPT2_SERVICE_NAME: 'migration',
    OPT2_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: 'opt2-unit',
    PUBSUB_EMULATOR_HOST: '127.0.0.1:8085',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: 'http://127.0.0.1:8111',
    OPT2_TOKEN_AUDIENCE: 'opt2',
    TZ: 'UTC',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'masa_services_unit',
    PG_USER: 'migration_app',
    PG_PASSWORD: 'not-a-secret',
    OPT2_STATE_DIR: stateDir,
    MURA_DBHOST: '127.0.0.1',
    MURA_DATABASE: 'muradb_unit',
    MURA_DBUSERNAME: 'unit-reader',
    MURA_DBPASSWORD: 'not-a-secret',
    LEGACY_ORIGIN: 'http://localhost:8080/',
    OPT2_BRIDGE_HMAC_KEY: 'not-a-key',
    ...overrides,
  };
}

const envWith = (overrides: NodeJS.ProcessEnv = {}): MigrationEnv => loadMigrationEnv(envSource(overrides));

const silentLogger = (): Logger => ({}) as Logger;

function fakeDb(schema = 'migration'): TenantDb {
  return { schema, withTenant: vi.fn(), withMetadata: vi.fn(), end: vi.fn(async () => undefined) };
}

function fakeClient(): ServiceClient {
  return { request: vi.fn(), close: vi.fn(async () => undefined) };
}

/** Every port as a recording fake, so a context built from them can do no I/O of its own. */
function injectedPorts() {
  return {
    clock: fixedClock('2026-06-30T12:00:00.000Z'),
    logger: silentLogger(),
    db: fakeDb(),
    legacy: { close: vi.fn(async () => undefined) } as unknown as LegacyDb,
    bridge: { schedulerDescribe: vi.fn() } as unknown as BridgeClient,
    catalog: { units: vi.fn(() => []) } as unknown as UnitCatalog,
    owners: { position: vi.fn() } as unknown as OwnersClient,
    gateway: { status: vi.fn() } as unknown as GatewayClient,
    client: fakeClient(),
  } satisfies CreateContextOptions;
}

/** Loopback server answering `{}` that records each request's path and invocation credential into `seen`. */
async function probeServer(seen: { path: string; credential: string }[]): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', credential: String(req.headers[INVOCATION_HEADER]) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'opt2-migration-context-'));
  await writeTestSecrets(stateDir);
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  closes.order.length = 0;
  closes.failing.clear();
  vi.restoreAllMocks();
});

describe('createMigrationContext', () => {
  it('uses every injected port without calling or closing it', async () => {
    const ports = injectedPorts();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const ctx = await createMigrationContext({ env: envWith(), ...ports });

    expect(ctx).toMatchObject({ ...ports, config: loadConfig() });
    await ctx.close();

    expect(closes.order).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(ports.client.request).not.toHaveBeenCalled();
    expect(ports.client.close).not.toHaveBeenCalled();
    expect(ports.db.end).not.toHaveBeenCalled();
    expect(ports.legacy.close).not.toHaveBeenCalled();
  });

  it('memoises clientAs per caller and answers the migration caller with the context client', async () => {
    const ports = injectedPorts();
    const ctx = await createMigrationContext({ env: envWith(), ...ports });

    const operator = ctx.clientAs('operator');
    expect(ctx.clientAs('operator')).toBe(operator);
    expect(operator).not.toBe(ports.client);
    expect(ctx.clientAs('migration')).toBe(ports.client);
    await ctx.close();
  });

  it('creates the ports options omit, with the migration schema pool and the ownership catalog', async () => {
    const ctx = await createMigrationContext({ env: envWith(), logger: silentLogger() });

    expect(ctx.db.schema).toBe('migration');
    expect(ctx.clock).toBe(systemClock);
    expect(ctx.catalog.units().length).toBeGreaterThan(0);
    expect(ctx.clientAs('migration')).toBe(ctx.client);
    await ctx.close();
  });

  it.each([
    { failing: [], messages: [] },
    { failing: ['legacy'], messages: ['legacy close failed'] },
    { failing: ['legacy', 'db'], messages: ['legacy close failed', 'db close failed'] },
  ])('closes every created port newest first with $failing failing', async ({ failing, messages }) => {
    const ctx = await createMigrationContext({ env: envWith(), logger: silentLogger() });
    for (const name of failing) closes.failing.add(name);

    const outcome: unknown = await ctx.close().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(closes.order).toEqual(CREATED_CLOSE_ORDER);
    expect(outcome instanceof AggregateError).toBe(messages.length > 1);
    const errors = outcome instanceof AggregateError ? outcome.errors : outcome === undefined ? [] : [outcome];
    expect(errors.map((error: Error) => error.message)).toEqual(messages);
  });

  it('shares one close across calls and refuses new clients afterwards', async () => {
    const ctx = await createMigrationContext({ env: envWith(), logger: silentLogger() });

    const first = ctx.close();
    expect(ctx.close()).toBe(first);
    await first;

    expect(closes.order).toEqual(CREATED_CLOSE_ORDER);
    expect(() => ctx.clientAs('operator')).toThrow('The migration context is closed');
  });

  it.each([
    { name: 'the legacy database is MySQL', options: () => ({ env: envWith({ MURA_DBTYPE: 'mysql' }) }), error: UnsupportedLegacyDatabaseError },
    {
      name: 'the database settings are missing',
      options: () => ({ env: envWith({ OPT2_DB_AUTH: '' }) }),
      error: new Error('Schema migration needs OPT2_DB_AUTH and PG_DATABASE'),
    },
    {
      name: 'the injected pool is not the migration schema',
      options: () => ({ env: envWith(), db: fakeDb('people') }),
      error: new TypeError('The migration context needs the migration schema pool, got people'),
    },
  ])('rejects without opening anything when $name', async ({ options, error }) => {
    await expect(createMigrationContext({ logger: silentLogger(), ...options() })).rejects.toThrow(error);
    expect(closes.order).toEqual([]);
  });

  it.each([
    { failing: [], aggregate: false },
    { failing: ['db'], aggregate: true },
  ])('closes what it opened when a later port fails, with $failing failing to close', async ({ failing, aggregate }) => {
    const failure = new Error('gateway port unavailable');
    for (const name of failing) closes.failing.add(name);
    const options: CreateContextOptions = {
      env: envWith(),
      logger: silentLogger(),
      get gateway(): GatewayClient {
        throw failure;
      },
    };

    const outcome: unknown = await createMigrationContext(options).catch((error: unknown) => error);

    expect(closes.order).toEqual(['legacy', 'client:migration', 'db']);
    if (aggregate) expect((outcome as AggregateError).errors).toEqual([failure, new Error('db close failed')]);
    else expect(outcome).toBe(failure);
  });

  it('writes default log lines to stderr, leaving stdout to the command summary', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write');
    const { logger: _injected, ...ports } = injectedPorts();
    const ctx = await createMigrationContext({ env: envWith(), ...ports });

    ctx.logger.info('migration context ready');

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"message":"migration context ready"'));
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining('migration context ready'));
    await ctx.close();
  });

  it('loads the local signing keys at the first call and retries a failed load at the next', async () => {
    const { base, close } = await probeServer([]);
    const emptyStateDir = await mkdtemp(path.join(os.tmpdir(), 'opt2-migration-context-nokeys-'));
    try {
      const env = envWith({ OPT2_GATEWAY_URL: base, OPT2_STATE_DIR: emptyStateDir });
      const ctx = await createMigrationContext({ env, logger: silentLogger() });
      const probe = () => ctx.client.request({ service: 'gateway', method: 'GET', path: '/probe', userToken: null });

      await expect(probe()).rejects.toThrow();
      await writeTestSecrets(emptyStateDir);
      await expect(probe()).resolves.toMatchObject({ status: 200 });
      await ctx.close();
    } finally {
      await close();
      await rm(emptyStateDir, { recursive: true, force: true });
    }
  });

  it("signs each caller's local service token for the callee named by the gateway and migration URLs", async () => {
    const seen: { path: string; credential: string }[] = [];
    const { base, close } = await probeServer(seen);
    try {
      const env = envWith({ OPT2_GATEWAY_URL: base, OPT2_MIGRATION_URL: base });
      const ctx = await createMigrationContext({ env, logger: silentLogger() });
      await ctx.client.request({ service: 'gateway', method: 'GET', path: '/as-migration', userToken: null });
      await ctx.clientAs('operator').request({ service: 'migration', method: 'GET', path: '/as-operator', userToken: null });
      await ctx.close();
    } finally {
      await close();
    }

    const { publicKey } = await testSigningKeys();
    const verify = (credential: string, audience: string) =>
      verifyLocalServiceToken(credential.replace(/^Bearer /, ''), { publicKey, audience });
    expect(seen.map(({ path: requested }) => requested)).toEqual(['/as-migration', '/as-operator']);
    await expect(verify(seen[0]?.credential ?? '', 'gateway')).resolves.toEqual({
      name: 'migration',
      roles: rolesForService('migration'),
    });
    await expect(verify(seen[1]?.credential ?? '', 'migration')).resolves.toEqual({
      name: 'operator',
      roles: rolesForService('operator'),
    });
  });
});
