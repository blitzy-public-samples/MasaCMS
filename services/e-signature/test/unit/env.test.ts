// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature's process environment: the base variables with its own name, its database and its callees' URLs required at start-up. */
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAFE_ERROR_TEXT } from '@opt2/platform/logging';
import { EnvValidationError, baseEnvSchema, loadEnv } from '@opt2/platform/service-kit';
import { createCapturingPublisher } from '@opt2/platform/testing';
import { buildApp, esignatureEnvSchema } from '../../src/app.js';

// Ports of harness/repro/ports.env.
const CALLEE_URLS = { identity: 'http://127.0.0.1:8111', people: 'http://127.0.0.1:8112' };
const EVERY_CALLEE = ['OPT2_SERVICE_URLS.identity: is required', 'OPT2_SERVICE_URLS.people: is required'];

/** A valid local e-signature environment with `overrides`; an `undefined` override drops a variable. */
function envSource(overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const source: Record<string, string | undefined> = {
    PORT: '8120',
    OPT2_SERVICE_NAME: 'e-signature',
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'masa_services',
    PG_USER: 'esignature_app',
    PG_PASSWORD: 'unused',
    PUBSUB_EMULATOR_HOST: '127.0.0.1:8085',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify(CALLEE_URLS),
    OPT2_STATE_DIR: tmpdir(),
    TZ: 'UTC',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The error `loadEnv(esignatureEnvSchema)` throws for `overrides`; undefined when the environment parses. */
function envError(overrides: Readonly<Record<string, string | undefined>>): EnvValidationError | undefined {
  try {
    loadEnv(esignatureEnvSchema, envSource(overrides));
    return undefined;
  } catch (err) {
    if (err instanceof EnvValidationError) return err;
    throw err;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('esignatureEnvSchema', () => {
  it('reads only the base variables', () => {
    expect(Object.keys(esignatureEnvSchema.shape)).toStrictEqual(Object.keys(baseEnvSchema.shape));
  });

  it.each<[string, Record<string, string | undefined>, string[]]>([
    ['names every callee when OPT2_SERVICE_URLS is unset', { OPT2_SERVICE_URLS: undefined }, EVERY_CALLEE],
    ['names every callee when OPT2_SERVICE_URLS is {}', { OPT2_SERVICE_URLS: '{}' }, EVERY_CALLEE],
    ['names identity when only people is mapped', { OPT2_SERVICE_URLS: JSON.stringify({ people: CALLEE_URLS.people }) }, ['OPT2_SERVICE_URLS.identity: is required']],
    ['names people when only identity is mapped', { OPT2_SERVICE_URLS: JSON.stringify({ identity: CALLEE_URLS.identity }) }, ['OPT2_SERVICE_URLS.people: is required']],
    ['refuses another service name', { OPT2_SERVICE_NAME: 'finance' }, ['OPT2_SERVICE_NAME: must be e-signature']],
    ['refuses the name of a callee', { OPT2_SERVICE_NAME: 'people' }, ['OPT2_SERVICE_NAME: must be e-signature']],
    ['requires OPT2_DB_AUTH', { OPT2_DB_AUTH: undefined }, ['OPT2_DB_AUTH: is required']],
    ['requires PG_DATABASE', { PG_DATABASE: undefined }, ['PG_DATABASE: is required']],
    [
      'names the callees beside another failed variable',
      { PORT: 'abc', OPT2_SERVICE_URLS: '{}' },
      [expect.stringMatching(/^PORT: /), ...EVERY_CALLEE],
    ],
    ['reports only its own issue for a map that is not JSON', { OPT2_SERVICE_URLS: 'not-json' }, [expect.stringMatching(/^OPT2_SERVICE_URLS: /)]],
  ])('%s', (_case, overrides, issues) => {
    expect(envError(overrides)?.issues).toStrictEqual(issues);
  });

  it('parses an environment naming its own service, database and every callee', () => {
    expect(envError({})).toBeUndefined();
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    [
      'every missing callee',
      { OPT2_SERVICE_URLS: undefined },
      'e-signature: invalid environment (OPT2_SERVICE_URLS.identity: is required; OPT2_SERVICE_URLS.people: is required)',
    ],
    ['the expected service name', { OPT2_SERVICE_NAME: 'finance' }, 'finance: invalid environment (OPT2_SERVICE_NAME: must be e-signature)'],
    [
      'the missing database settings',
      { OPT2_DB_AUTH: undefined, PG_DATABASE: undefined },
      'e-signature: invalid environment (OPT2_DB_AUTH: is required; PG_DATABASE: is required)',
    ],
  ])('logs a refusal naming %s without any value', (_case, overrides, text) => {
    expect(envError(overrides)?.[SAFE_ERROR_TEXT]).toBe(text);
  });
});

describe('buildApp without an injected environment', () => {
  it('loads esignatureEnvSchema from process.env and refuses before acquiring anything', async () => {
    for (const key of Object.keys(baseEnvSchema.shape)) vi.stubEnv(key, undefined);
    for (const [key, value] of Object.entries(envSource({ OPT2_SERVICE_URLS: undefined }))) vi.stubEnv(key, value);

    await expect(buildApp({ publisher: createCapturingPublisher() })).rejects.toMatchObject({ name: 'EnvValidationError', issues: EVERY_CALLEE });
  });
});
