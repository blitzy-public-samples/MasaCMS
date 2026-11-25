// Internal plugins route: web reads the installed plugins through the bridge's site.cfm?op=plugins.
import { INVOCATION_HEADER, recordedRoutes, rolesForService } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ServiceUnavailableError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { loadOpenApiDocument, mintServiceToken, testVerifier } from '@opt2/platform/testing';
import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { registerPluginsRoute } from '../../src/admin/plugins-route.js';
import type { LegacyPlugin, PluginListClient } from '../../src/session/bridge-client.js';
import { LEGACY_PLUGINS } from '../helpers/legacy-origin.js';

const PLUGINS_URL = '/internal/v1/legacy-server/plugins';

const apps: FastifyInstance[] = [];
let pluginsContract: ValidateFunction;

beforeAll(async () => {
  const contract = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as {
    components: { schemas: Record<string, AnySchemaObject> };
  };
  const { schemas } = contract.components;
  // Each `#/components/schemas/<name>` reference inlined, so ajv compiles the schema alone.
  const inline = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(inline);
    if (typeof node !== 'object' || node === null) return node;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === 'string') return inline(schemas[ref.replace('#/components/schemas/', '')]);
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(value)]));
  };
  pluginsContract = new Ajv2020({ allErrors: true, strict: true }).compile(inline(schemas.LegacyPlugins) as AnySchemaObject);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

/** A gateway app carrying only the plugins route over a stub bridge client that counts its calls. */
async function pluginsApp(
  read: PluginListClient['plugins'] = () => Promise.resolve(LEGACY_PLUGINS),
): Promise<{ app: FastifyInstance; calls: { count: number } }> {
  const calls = { count: 0 };
  const plugins: PluginListClient = {
    plugins() {
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
  await registerPluginsRoute(app, { plugins });
  await app.ready();
  return { app, calls };
}

/** Invocation credential of `caller` addressed to the gateway. */
async function credentialOf(caller: string): Promise<Record<string, string>> {
  const token = await mintServiceToken({ caller, audience: 'gateway', roles: rolesForService(caller) });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

describe('registerPluginsRoute', () => {
  it('declares the contract operation on the service transport, callable by web only', async () => {
    const { app } = await pluginsApp();
    expect(recordedRoutes(app).filter((route) => route.url.startsWith('/internal/'))).toEqual([
      { method: 'GET', url: PLUGINS_URL, config: { transport: 'service', requires: ['service:web'] } },
    ]);
  });

  it.each<[string, LegacyPlugin[]]>([
    ['the deployed golden plugin', LEGACY_PLUGINS],
    ['no installed plugin', []],
  ])("answers web's call with %s, as the contract declares", async (_label, plugins) => {
    const { app, calls } = await pluginsApp(() => Promise.resolve(plugins));
    const res = await app.inject({ method: 'GET', url: PLUGINS_URL, headers: await credentialOf('web') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plugins });
    expect(pluginsContract(res.json())).toBe(true);
    expect(calls.count).toBe(1);
  });

  it('answers the legacy 503 when the bridge fails', async () => {
    const failure = new ServiceUnavailableError('legacy-bridge', new Error('legacy bridge site.plugins answered HTTP 500 serverError'));
    const { app, calls } = await pluginsApp(() => Promise.reject(failure));
    const res = await app.inject({ method: 'GET', url: PLUGINS_URL, headers: await credentialOf('web') });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
    expect(calls.count).toBe(1);
  });

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['no credential', () => Promise.resolve({}), 401],
    ["the gateway's own credential", () => credentialOf('gateway'), 403],
    ['an identity credential', () => credentialOf('identity'), 403],
  ])('denies a caller presenting %s before reading the bridge', async (_label, headers, status) => {
    const { app, calls } = await pluginsApp();
    const res = await app.inject({ method: 'GET', url: PLUGINS_URL, headers: await headers() });
    expect(res.statusCode).toBe(status);
    expect(calls.count).toBe(0);
  });
});
