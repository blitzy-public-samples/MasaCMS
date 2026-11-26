/** The stub's environment schema: the base variables with its own name, its database and its own URL required at start-up. */
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeError } from '@opt2/platform/logging';
import { EnvValidationError, baseEnvSchema, loadEnv } from '@opt2/platform/service-kit';
import { buildApp, stubEnvSchema } from '../../src/app.js';

// Ports of harness/repro/ports.env.
const STUB_URL = 'http://127.0.0.1:8199';
const OWN_URL = 'OPT2_SERVICE_URLS.stub: is required';

/** A valid local stub environment with `overrides`; an `undefined` override drops a variable. */
function sourceWith(overrides: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return {
    PORT: '8199',
    OPT2_SERVICE_NAME: 'stub',
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2',
    PG_USER: 'stub_app',
    PG_PASSWORD: 'unused',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify({ stub: STUB_URL }),
    OPT2_STATE_DIR: tmpdir(),
    TZ: 'UTC',
    ...overrides,
  };
}

/** The issues `loadEnv(stubEnvSchema)` reports for `sourceWith(overrides)` and the text its start-up line logs; none when it parses. */
function envFailure(overrides: Readonly<Record<string, string | undefined>>): { issues: string[]; logged?: string } {
  const source = sourceWith(overrides);
  try {
    loadEnv(stubEnvSchema, Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)));
    return { issues: [] };
  } catch (err) {
    if (err instanceof EnvValidationError) return { issues: err.issues, logged: serializeError(err).message };
    throw err;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stubEnvSchema', () => {
  it('reads only the base variables', () => {
    expect(Object.keys(stubEnvSchema.shape)).toStrictEqual(Object.keys(baseEnvSchema.shape));
  });

  it.each<[string, Record<string, string | undefined>, string[], string | undefined]>([
    ['parses a map naming its own URL', {}, [], undefined],
    [
      'refuses another service name',
      { OPT2_SERVICE_NAME: 'people' },
      ['OPT2_SERVICE_NAME: must be stub'],
      'people: invalid environment (OPT2_SERVICE_NAME: must be stub)',
    ],
    ['names its own URL when OPT2_SERVICE_URLS is unset', { OPT2_SERVICE_URLS: undefined }, [OWN_URL], `stub: invalid environment (${OWN_URL})`],
    ['names its own URL when OPT2_SERVICE_URLS is {}', { OPT2_SERVICE_URLS: '{}' }, [OWN_URL], `stub: invalid environment (${OWN_URL})`],
    [
      'names its own URL when the map names only other services',
      { OPT2_SERVICE_URLS: JSON.stringify({ identity: 'http://127.0.0.1:8111' }) },
      [OWN_URL],
      `stub: invalid environment (${OWN_URL})`,
    ],
    ['requires OPT2_DB_AUTH', { OPT2_DB_AUTH: undefined }, ['OPT2_DB_AUTH: is required'], 'stub: invalid environment (OPT2_DB_AUTH: is required)'],
    ['requires PG_DATABASE', { PG_DATABASE: undefined }, ['PG_DATABASE: is required'], 'stub: invalid environment (PG_DATABASE: is required)'],
    [
      'lists every requirement beside another failed variable',
      { TZ: undefined, OPT2_SERVICE_NAME: 'gateway', PG_DATABASE: undefined, OPT2_SERVICE_URLS: '{}' },
      ['TZ: is required', 'OPT2_SERVICE_NAME: must be stub', 'PG_DATABASE: is required', OWN_URL],
      `gateway: invalid environment (TZ: is required; OPT2_SERVICE_NAME: must be stub; PG_DATABASE: is required; ${OWN_URL})`,
    ],
    [
      'reports only its own issue for a map that is not JSON',
      { OPT2_SERVICE_URLS: 'not-json' },
      ['OPT2_SERVICE_URLS: OPT2_SERVICE_URLS must be a JSON object'],
      expect.stringMatching(/^stub: invalid environment \(OPT2_SERVICE_URLS: [^;]+\)$/),
    ],
  ])('%s', (_case, overrides, issues, logged) => {
    expect(envFailure(overrides)).toStrictEqual(logged === undefined ? { issues } : { issues, logged });
  });

  it('is the schema buildApp reads process.env with when given no env', async () => {
    const source = sourceWith({ OPT2_SERVICE_URLS: undefined });
    // Every base variable the host sets is replaced, so only the dropped map can fail.
    for (const key of Object.keys(baseEnvSchema.shape)) vi.stubEnv(key, source[key]);

    await expect(buildApp()).rejects.toMatchObject({ name: 'EnvValidationError', issues: [OWN_URL] });
  });
});
