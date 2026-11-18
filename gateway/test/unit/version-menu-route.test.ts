// Internal Version menu route: web reads the legacy server facts through the bridge's site.cfm?op=versionMenu.
import { readFile } from 'node:fs/promises';
import { INVOCATION_HEADER, recordedRoutes, rolesForService } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ServiceUnavailableError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { mintServiceToken, testVerifier } from '@opt2/platform/testing';
import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { registerVersionMenuRoute } from '../../src/admin/version-menu-route.js';
import type { LegacyVersionMenu, VersionMenuClient } from '../../src/session/bridge-client.js';
import { LEGACY_VERSION_MENU } from '../helpers/legacy-origin.js';

const VERSION_MENU_URL = '/internal/v1/legacy-server/version-menu';

const apps: FastifyInstance[] = [];
let menuContract: ValidateFunction;

beforeAll(async () => {
  const contract = parse(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
    components: { schemas: Record<string, AnySchemaObject> };
  };
  const schema = contract.components.schemas.LegacyVersionMenu;
  if (schema === undefined) throw new Error('contracts/openapi.yaml defines no components.schemas.LegacyVersionMenu');
  menuContract = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

/** A gateway app carrying only the Version menu route over a stub bridge client that counts its calls. */
async function versionMenuApp(
  read: VersionMenuClient['versionMenu'] = () => Promise.resolve(LEGACY_VERSION_MENU),
): Promise<{ app: FastifyInstance; calls: { count: number } }> {
  const calls = { count: 0 };
  const versionMenu: VersionMenuClient = {
    versionMenu() {
      calls.count += 1;
      return read();
    },
  };
  const app = await createService({
    name: 'gateway',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8100',
      OPT2_SERVICE_NAME: 'gateway',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('gateway'),
    logger: createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  await registerVersionMenuRoute(app, { versionMenu });
  await app.ready();
  return { app, calls };
}

/** Invocation credential of `caller` addressed to the gateway. */
async function credentialOf(caller: string): Promise<Record<string, string>> {
  const token = await mintServiceToken({ caller, audience: 'gateway', roles: rolesForService(caller) });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

describe('registerVersionMenuRoute', () => {
  it('declares the contract operation on the service transport, callable by web only', async () => {
    const { app } = await versionMenuApp();
    expect(recordedRoutes(app).filter((route) => route.url.startsWith('/internal/'))).toEqual([
      { method: 'GET', url: VERSION_MENU_URL, config: { transport: 'service', requires: ['service:web'] } },
    ]);
  });

  it.each<[string, LegacyVersionMenu]>([
    ['the ACF 2023 facts, without server.java', LEGACY_VERSION_MENU],
    ['a server reporting Java and no OS', { ...LEGACY_VERSION_MENU, javaVersion: '11.0.2', osName: null, osVersion: null }],
  ])("answers web's call with %s, as the contract declares", async (_label, menu) => {
    const { app, calls } = await versionMenuApp(() => Promise.resolve(menu));
    const res = await app.inject({ method: 'GET', url: VERSION_MENU_URL, headers: await credentialOf('web') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(menu);
    expect(menuContract(res.json())).toBe(true);
    expect(calls.count).toBe(1);
  });

  it('answers the legacy 503 when the bridge fails', async () => {
    const failure = new ServiceUnavailableError('legacy-bridge', new Error('legacy bridge site.versionMenu answered HTTP 500 serverError'));
    const { app, calls } = await versionMenuApp(() => Promise.reject(failure));
    const res = await app.inject({ method: 'GET', url: VERSION_MENU_URL, headers: await credentialOf('web') });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
    expect(calls.count).toBe(1);
  });

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['no credential', () => Promise.resolve({}), 401],
    ["the gateway's own credential", () => credentialOf('gateway'), 403],
    ['an identity credential', () => credentialOf('identity'), 403],
  ])('denies a caller presenting %s before reading the bridge', async (_label, headers, status) => {
    const { app, calls } = await versionMenuApp();
    const res = await app.inject({ method: 'GET', url: VERSION_MENU_URL, headers: await headers() });
    expect(res.statusCode).toBe(status);
    expect(calls.count).toBe(0);
  });
});
