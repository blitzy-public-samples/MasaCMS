// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheets' environment schema: the base variables with every `OPT2_SERVICE_URLS` callee required at start-up. */
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { EnvValidationError, baseEnvSchema, loadEnv } from '@opt2/platform/service-kit';
import { timesheetsEnvSchema } from '../../src/app.js';

// Ports of harness/repro/ports.env.
const CALLEE_URLS = { identity: 'http://127.0.0.1:8111', reporting: 'http://127.0.0.1:8116' };
const EVERY_CALLEE = ['OPT2_SERVICE_URLS.identity: is required', 'OPT2_SERVICE_URLS.reporting: is required'];

/** The issues `loadEnv(timesheetsEnvSchema)` reports for a valid local environment with `overrides`; none when it parses. */
function envIssues(overrides: Readonly<Record<string, string | undefined>>): string[] {
  const source: Record<string, string | undefined> = {
    PORT: '8118',
    OPT2_SERVICE_NAME: 'timesheets',
    OPT2_ENV: 'local',
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
    return [];
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues;
    throw err;
  }
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
      'names only the callees a partial map lacks',
      { OPT2_SERVICE_URLS: JSON.stringify({ identity: CALLEE_URLS.identity }) },
      ['OPT2_SERVICE_URLS.reporting: is required'],
    ],
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
  ])('%s', (_case, overrides, issues) => {
    expect(envIssues(overrides)).toStrictEqual(issues);
  });
});
