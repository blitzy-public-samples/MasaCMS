// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheets' environment schema: the base variables with its own name, every `OPT2_SERVICE_URLS` callee and its database required at start-up. */
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { serializeError } from '@opt2/platform/logging';
import { EnvValidationError, baseEnvSchema, loadEnv } from '@opt2/platform/service-kit';
import { timesheetsEnvSchema } from '../../src/app.js';

// Ports of harness/repro/ports.env.
const CALLEE_URLS = { identity: 'http://127.0.0.1:8111', reporting: 'http://127.0.0.1:8116' };
const EVERY_CALLEE = ['OPT2_SERVICE_URLS.identity: is required', 'OPT2_SERVICE_URLS.reporting: is required'];

/** The refusal `loadEnv(timesheetsEnvSchema)` throws for a valid local environment with `overrides`; undefined when it parses. */
function envError(overrides: Readonly<Record<string, string | undefined>>): EnvValidationError | undefined {
  const source: Record<string, string | undefined> = {
    PORT: '8118',
    OPT2_SERVICE_NAME: 'timesheets',
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2',
    PG_USER: 'timesheets_app',
    PG_PASSWORD: 'unused',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify(CALLEE_URLS),
    OPT2_STATE_DIR: tmpdir(),
    TZ: 'UTC',
    ...overrides,
  };
  try {
    loadEnv(
      timesheetsEnvSchema,
      Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    );
    return undefined;
  } catch (err) {
    if (err instanceof EnvValidationError) return err;
    throw err;
  }
}

/** The issues of {@link envError}; none when the environment parses. */
function envIssues(overrides: Readonly<Record<string, string | undefined>>): string[] {
  return envError(overrides)?.issues ?? [];
}

describe('timesheetsEnvSchema', () => {
  it('reads only the base variables', () => {
    expect(Object.keys(timesheetsEnvSchema.shape)).toStrictEqual(Object.keys(baseEnvSchema.shape));
  });

  it.each<[string, Record<string, string | undefined>, string[]]>([
    ['parses a map naming every callee', {}, []],
    ['names every callee when OPT2_SERVICE_URLS is unset', { OPT2_SERVICE_URLS: undefined }, EVERY_CALLEE],
    ['names every callee when OPT2_SERVICE_URLS is {}', { OPT2_SERVICE_URLS: '{}' }, EVERY_CALLEE],
    [
      'names the callees beside another failed variable',
      { PORT: 'abc', OPT2_SERVICE_URLS: '{}' },
      [expect.stringMatching(/^PORT: /), ...EVERY_CALLEE],
    ],
    [
      'reports only its own issue for a map that is not JSON',
      { OPT2_SERVICE_URLS: 'not-json' },
      ['OPT2_SERVICE_URLS: OPT2_SERVICE_URLS must be a JSON object'],
    ],
    ['reports only its own issue for a JSON array', { OPT2_SERVICE_URLS: '[]' }, [expect.stringMatching(/^OPT2_SERVICE_URLS: /)]],
    ["refuses another service's name", { OPT2_SERVICE_NAME: 'finance' }, ['OPT2_SERVICE_NAME: must be timesheets']],
    ['reports only its own issue for a malformed service name', { OPT2_SERVICE_NAME: 'Timesheets' }, [expect.stringMatching(/^OPT2_SERVICE_NAME: (?!must be timesheets)/)]],
    ['requires OPT2_DB_AUTH', { OPT2_DB_AUTH: undefined }, ['OPT2_DB_AUTH: is required']],
    ['requires PG_DATABASE', { PG_DATABASE: undefined }, ['PG_DATABASE: is required']],
  ])('%s', (_case, overrides, issues) => {
    expect(envIssues(overrides)).toStrictEqual(issues);
  });

  it.each(Object.keys(CALLEE_URLS))('names OPT2_SERVICE_URLS.%s when only it is missing', (callee) => {
    const urls = Object.fromEntries(Object.entries(CALLEE_URLS).filter(([name]) => name !== callee));
    expect(envIssues({ OPT2_SERVICE_URLS: JSON.stringify(urls) })).toStrictEqual([`OPT2_SERVICE_URLS.${callee}: is required`]);
  });

  it('logs every refusal by name and value-free reason in one line', () => {
    const err = envError({ OPT2_SERVICE_NAME: 'finance', OPT2_DB_AUTH: undefined, OPT2_SERVICE_URLS: undefined });
    expect(serializeError(err).message).toBe(
      'finance: invalid environment (OPT2_SERVICE_NAME: must be timesheets; OPT2_DB_AUTH: is required; ' +
        'OPT2_SERVICE_URLS.identity: is required; OPT2_SERVICE_URLS.reporting: is required)',
    );
  });
});
