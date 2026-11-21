// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance's environment schema: the base variables with its own name, its database and every callee's URL required at start-up. */
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeError } from '@opt2/platform/logging';
import { EnvValidationError, baseEnvSchema, loadEnv } from '@opt2/platform/service-kit';
import { buildApp, financeEnvSchema } from '../../src/app.js';

// Ports of harness/repro/ports.env.
const CALLEE_URLS = { identity: 'http://127.0.0.1:8111', reporting: 'http://127.0.0.1:8116' };
const EVERY_CALLEE = ['OPT2_SERVICE_URLS.identity: is required', 'OPT2_SERVICE_URLS.reporting: is required'];

/** A valid local finance environment with `overrides`; an `undefined` override drops a variable. */
function sourceWith(overrides: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return {
    PORT: '8119',
    OPT2_SERVICE_NAME: 'finance',
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2',
    PG_USER: 'finance_app',
    PG_PASSWORD: 'unused',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify(CALLEE_URLS),
    OPT2_STATE_DIR: tmpdir(),
    TZ: 'UTC',
    ...overrides,
  };
}

/** The issues `loadEnv(financeEnvSchema)` reports for `sourceWith(overrides)` and the text its start-up line logs; none when it parses. */
function envFailure(overrides: Readonly<Record<string, string | undefined>>): { issues: string[]; logged?: string } {
  const source = sourceWith(overrides);
  try {
    loadEnv(financeEnvSchema, Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)));
    return { issues: [] };
  } catch (err) {
    if (err instanceof EnvValidationError) return { issues: err.issues, logged: serializeError(err).message };
    throw err;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('financeEnvSchema', () => {
  it('reads only the base variables', () => {
    expect(Object.keys(financeEnvSchema.shape)).toStrictEqual(Object.keys(baseEnvSchema.shape));
  });

  it.each<[string, Record<string, string | undefined>, string[], string | undefined]>([
    ['parses a map naming every callee', {}, [], undefined],
    [
      'refuses another service name',
      { OPT2_SERVICE_NAME: 'reporting' },
      ['OPT2_SERVICE_NAME: must be finance'],
      'reporting: invalid environment (OPT2_SERVICE_NAME: must be finance)',
    ],
    [
      'names every callee when OPT2_SERVICE_URLS is unset',
      { OPT2_SERVICE_URLS: undefined },
      EVERY_CALLEE,
      'finance: invalid environment (OPT2_SERVICE_URLS.identity: is required; OPT2_SERVICE_URLS.reporting: is required)',
    ],
    [
      'names every callee when OPT2_SERVICE_URLS is {}',
      { OPT2_SERVICE_URLS: '{}' },
      EVERY_CALLEE,
      'finance: invalid environment (OPT2_SERVICE_URLS.identity: is required; OPT2_SERVICE_URLS.reporting: is required)',
    ],
    [
      'names identity when only reporting is mapped',
      { OPT2_SERVICE_URLS: JSON.stringify({ reporting: CALLEE_URLS.reporting }) },
      ['OPT2_SERVICE_URLS.identity: is required'],
      'finance: invalid environment (OPT2_SERVICE_URLS.identity: is required)',
    ],
    [
      'names reporting when only identity is mapped',
      { OPT2_SERVICE_URLS: JSON.stringify({ identity: CALLEE_URLS.identity }) },
      ['OPT2_SERVICE_URLS.reporting: is required'],
      'finance: invalid environment (OPT2_SERVICE_URLS.reporting: is required)',
    ],
    ['requires OPT2_DB_AUTH', { OPT2_DB_AUTH: undefined }, ['OPT2_DB_AUTH: is required'], 'finance: invalid environment (OPT2_DB_AUTH: is required)'],
    ['requires PG_DATABASE', { PG_DATABASE: undefined }, ['PG_DATABASE: is required'], 'finance: invalid environment (PG_DATABASE: is required)'],
    [
      'lists every requirement beside another failed variable',
      { PORT: 'abc', OPT2_SERVICE_NAME: 'people', OPT2_DB_AUTH: undefined, OPT2_SERVICE_URLS: '{}' },
      [expect.stringMatching(/^PORT: /), 'OPT2_SERVICE_NAME: must be finance', 'OPT2_DB_AUTH: is required', ...EVERY_CALLEE],
      expect.stringMatching(
        /^people: invalid environment \(PORT: [^;]+; OPT2_SERVICE_NAME: must be finance; OPT2_DB_AUTH: is required; OPT2_SERVICE_URLS\.identity: is required; OPT2_SERVICE_URLS\.reporting: is required\)$/,
      ),
    ],
    [
      'reports only its own issue for a map that is not JSON',
      { OPT2_SERVICE_URLS: 'not-json' },
      ['OPT2_SERVICE_URLS: OPT2_SERVICE_URLS must be a JSON object'],
      expect.stringMatching(/^finance: invalid environment \(OPT2_SERVICE_URLS: [^;]+\)$/),
    ],
  ])('%s', (_case, overrides, issues, logged) => {
    expect(envFailure(overrides)).toStrictEqual(logged === undefined ? { issues } : { issues, logged });
  });

  it('is the schema buildApp reads process.env with when given no env', async () => {
    const source = sourceWith({ OPT2_SERVICE_URLS: undefined });
    // Every base variable the host sets is replaced, so only the dropped map can fail.
    for (const key of Object.keys(baseEnvSchema.shape)) vi.stubEnv(key, source[key]);

    await expect(buildApp()).rejects.toMatchObject({ name: 'EnvValidationError', issues: EVERY_CALLEE });
  });
});
