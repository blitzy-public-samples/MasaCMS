// Provider contract of the composed migration service: `buildApp` registers exactly the contract's operations, each with the
// transport, roles and site check its operation declares.
import { readFileSync } from 'node:fs';

import { collectRouteMatrix } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { LegacyDb } from '../../src/legacy/index.js';
import type { OwnersClient } from '../../src/owners/index.js';
import { buildApp } from '../../src/server.js';
import { createTestDirs, testEnv, type TestDirs } from '../helpers/env.js';
import { createGatewayDouble } from '../helpers/gateway-double.js';
import { memoryMigrationDb, type OpenApiDoc } from '../helpers/route-app.js';

type Json = Record<string, unknown>;

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** The Fastify url of a contract path: a literal colon is written `::`, a `{param}` segment `:param`. */
function fastifyUrl(path: string): string {
  return path.replace(/:(?=[a-z])/g, '::').replace(/\{(\w+)\}/g, ':$1');
}

/** A registered url without the parameter patterns a registrar adds where a literal colon follows a parameter. */
function withoutPatterns(url: string): string {
  return url.replace(/\([^)]*\)/g, '');
}

const OPERATIONS = Object.entries(DOC.paths).flatMap(([path, item]) =>
  HTTP_METHODS.flatMap((verb) => {
    const operation = item[verb] as Json | undefined;
    return operation === undefined ? [] : [{ method: verb.toUpperCase(), url: fastifyUrl(path), operation }];
  }),
);

const refuse = (): Promise<never> => Promise.reject(new Error('the route contract suite never reaches legacy SQL Server'));
const legacy = { live: refuse, database: refuse, transaction: refuse, close: () => Promise.resolve() } as unknown as LegacyDb;

let dirs: TestDirs;
let app: FastifyInstance;

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
});

afterAll(async () => {
  await app?.close();
  await dirs?.cleanup();
});

const byRoute = (a: { method: string; url: string }, b: { method: string; url: string }): number =>
  `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`, 'en');

describe('the composed migration service', () => {
  it("registers the contract's seventeen operations and no other route", () => {
    const registered = collectRouteMatrix(app).routes.map(({ method, url }) => `${method} ${withoutPatterns(url)}`);
    expect(OPERATIONS).toHaveLength(17);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.sort()).toEqual(OPERATIONS.map(({ method, url }) => `${method} ${url}`).sort());
  });

  it('declares every route with the transport, roles and site check of its contract operation', () => {
    // `requires` is an any-of set, so its order is not compared.
    const declared = collectRouteMatrix(app).routes.map((route) => ({
      ...route,
      url: withoutPatterns(route.url),
      ...(route.requires ? { requires: [...route.requires].sort() } : {}),
    }));
    const expected = OPERATIONS.map(({ method, url, operation }) =>
      operation.operationId === 'healthz'
        ? { method, url, transport: 'service', public: true, siteCheck: true }
        : {
            method,
            url,
            transport: operation['x-opt2-transport'],
            requires: [...(operation['x-opt2-requires'] as string[])].sort(),
            siteCheck: operation['x-opt2-site-check'] !== false,
          },
    );
    expect(declared.sort(byRoute)).toEqual(expected.sort(byRoute));
  });
});
