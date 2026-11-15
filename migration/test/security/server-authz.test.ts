// Deny-by-default of the composed migration service: every route `buildApp` registers refuses anonymous callers, user tokens
// without an invocation credential and every workload its contract operation does not admit, and lets the admitted ones through.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, collectRouteMatrix, hasAnyRole, rolesForService } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { SERVICE_CALLERS, TENANT_A, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { LegacyDb } from '../../src/legacy/index.js';
import type { OwnersClient } from '../../src/owners/index.js';
import { buildApp } from '../../src/server.js';
import { createTestDirs, testEnv, type TestDirs } from '../helpers/env.js';
import { createGatewayDouble } from '../helpers/gateway-double.js';
import { memoryMigrationDb, type OpenApiDoc } from '../helpers/route-app.js';

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const HTTP_METHODS = ['get', 'post', 'put', 'delete'] as const;

/** Path parameter values that pass each parameter's pattern, so an admitted request reaches its handler. */
const PATH_VALUES: Readonly<Record<string, string>> = {
  windowId: '9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F',
  transitionId: '1A2B3C4D-5E6F-4A7B-8C9D0E1F2A3B4C5D',
  name: 'projector-delay',
};

/** One non-public contract operation and the workloads its roles admit. */
interface GuardedRoute {
  operationId: string;
  method: Method;
  /** Fastify url: a literal colon is written `::`, a `{param}` segment `:param`. */
  pattern: string;
  /** A concrete request url. */
  url: string;
  requires: string[];
}

const GUARDED: readonly GuardedRoute[] = Object.entries(DOC.paths).flatMap(([path, item]) =>
  HTTP_METHODS.flatMap((verb) => {
    const operation = item[verb] as Json | undefined;
    if (operation === undefined || operation.operationId === 'healthz') return [];
    const pattern = path.replace(/:(?=[a-z])/g, '::').replace(/\{(\w+)\}/g, ':$1');
    const url = path.replace(/\{(\w+)\}/g, (_match, name: string) => PATH_VALUES[name] ?? name);
    const requires = operation['x-opt2-requires'] as string[];
    return [{ operationId: String(operation.operationId), method: verb.toUpperCase() as Method, pattern, url, requires }];
  }),
);

const refuse = (): Promise<never> => Promise.reject(new Error('the authorisation suite never reaches legacy SQL Server'));
const legacy = { live: refuse, database: refuse, transaction: refuse, close: () => Promise.resolve() } as unknown as LegacyDb;
const DENIED: ReadonlySet<number> = new Set([401, 403]);

let dirs: TestDirs;
let app: FastifyInstance;
const tokens = new Map<string, string>();

beforeAll(async () => {
  dirs = await createTestDirs();
  app = await buildApp({
    env: testEnv({ dirs, LOG_LEVEL: 'fatal' }),
    verifierOverride: testVerifier('migration'),
    db: memoryMigrationDb().db,
    legacy,
    owners: {} as OwnersClient,
    gateway: createGatewayDouble(),
    startBackground: false,
  });
  for (const caller of SERVICE_CALLERS) tokens.set(caller, await mintServiceToken({ caller, audience: 'migration' }));
});

afterAll(async () => {
  await app?.close();
  await dirs?.cleanup();
});

function inject(route: GuardedRoute, headers: Record<string, string>): Promise<{ statusCode: number }> {
  return app.inject({ method: route.method, url: route.url, headers });
}

describe('deny-by-default of the composed migration service', () => {
  it('guards the sixteen non-public contract operations, every one registered', () => {
    const registered = collectRouteMatrix(app)
      .routes.filter((route) => route.public !== true)
      // A registrar adds a parameter pattern where a literal colon follows a parameter.
      .map(({ method, url }) => `${method} ${url.replace(/\([^)]*\)/g, '')}`);
    expect(GUARDED).toHaveLength(16);
    expect(registered.sort()).toEqual(GUARDED.map(({ method, pattern }) => `${method} ${pattern}`).sort());
  });

  it.each(GUARDED.map((route) => [route.operationId, route] as const))('%s refuses anonymous callers with 401', async (_id, route) => {
    expect((await inject(route, {})).statusCode).toBe(401);
  });

  it.each(GUARDED.map((route) => [route.operationId, route] as const))(
    '%s refuses a user token presented without an invocation credential',
    async (_id, route) => {
      const token = await mintUserToken({ sub: 'authz-user', site: TENANT_A.siteId, roles: ['s2', 'site-admin', 'system-user'], s2: true });
      expect(DENIED.has((await inject(route, { authorization: `Bearer ${token}` })).statusCode)).toBe(true);
    },
  );

  it.each(GUARDED.map((route) => [route.operationId, route] as const))(
    '%s admits exactly the workloads its contract roles name',
    async (_id, route) => {
      const outcomes = await Promise.all(
        SERVICE_CALLERS.map(async (caller) => {
          const { statusCode } = await inject(route, { [INVOCATION_HEADER]: `Bearer ${tokens.get(caller) ?? ''}` });
          return { caller, admitted: hasAnyRole(rolesForService(caller), route.requires), statusCode };
        }),
      );
      for (const { caller, admitted, statusCode } of outcomes) {
        expect({ caller, denied: DENIED.has(statusCode) }).toEqual({ caller, denied: !admitted });
      }
      expect(outcomes.some(({ admitted }) => admitted)).toBe(true);
    },
  );
});
