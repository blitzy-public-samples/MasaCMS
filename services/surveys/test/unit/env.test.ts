// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Surveys' process schema: the base variables with its own name, its database and every callee URL required at start-up. */
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { serializeError } from '@opt2/platform/logging';
import { EnvValidationError, baseEnvSchema, loadEnv } from '@opt2/platform/service-kit';
import { surveysEnvSchema } from '../../src/app.js';

// Ports of harness/repro/ports.env.
const CALLEE_URLS = { surveys: 'http://127.0.0.1:8117', identity: 'http://127.0.0.1:8111', communications: 'http://127.0.0.1:8115' };
const EVERY_CALLEE = Object.keys(CALLEE_URLS).map((callee) => `OPT2_SERVICE_URLS.${callee}: is required`);

/** Valid local environment of surveys with `overrides`; an override of `undefined` removes the variable. */
function source(overrides: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    PORT: '8117',
    OPT2_SERVICE_NAME: 'surveys',
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'masa_services',
    PG_USER: 'surveys_app',
    PG_PASSWORD: 'unused',
    PUBSUB_EMULATOR_HOST: 'localhost:8085',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify(CALLEE_URLS),
    OPT2_STATE_DIR: tmpdir(),
    TZ: 'UTC',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The `EnvValidationError` `loadEnv(surveysEnvSchema)` throws for `overrides`; undefined when it parses. */
function envError(overrides: Readonly<Record<string, string | undefined>>): EnvValidationError | undefined {
  try {
    loadEnv(surveysEnvSchema, source(overrides));
    return undefined;
  } catch (err) {
    if (err instanceof EnvValidationError) return err;
    throw err;
  }
}

const without = (callee: keyof typeof CALLEE_URLS): string =>
  JSON.stringify(Object.fromEntries(Object.entries(CALLEE_URLS).filter(([name]) => name !== callee)));

describe('surveysEnvSchema', () => {
  it('reads only the base variables', () => {
    expect(Object.keys(surveysEnvSchema.shape)).toStrictEqual(Object.keys(baseEnvSchema.shape));
  });

  it.each<[string, Record<string, string | undefined>, string[]]>([
    ['parses an environment naming surveys, its database and every callee', {}, []],
    ['refuses another service name', { OPT2_SERVICE_NAME: 'communications' }, ['OPT2_SERVICE_NAME: must be surveys']],
    ['names every callee when OPT2_SERVICE_URLS is unset', { OPT2_SERVICE_URLS: undefined }, EVERY_CALLEE],
    ['names every callee when OPT2_SERVICE_URLS is {}', { OPT2_SERVICE_URLS: '{}' }, EVERY_CALLEE],
    ['names a missing surveys entry', { OPT2_SERVICE_URLS: without('surveys') }, ['OPT2_SERVICE_URLS.surveys: is required']],
    ['names a missing identity entry', { OPT2_SERVICE_URLS: without('identity') }, ['OPT2_SERVICE_URLS.identity: is required']],
    [
      'names a missing communications entry',
      { OPT2_SERVICE_URLS: without('communications') },
      ['OPT2_SERVICE_URLS.communications: is required'],
    ],
    ['requires OPT2_DB_AUTH', { OPT2_DB_AUTH: undefined }, ['OPT2_DB_AUTH: is required']],
    ['requires PG_DATABASE', { PG_DATABASE: undefined }, ['PG_DATABASE: is required']],
    [
      'names the callees beside another failed variable',
      { PORT: 'abc', OPT2_SERVICE_URLS: '{}' },
      [expect.stringMatching(/^PORT: /), ...EVERY_CALLEE],
    ],
    ['reports only its own issue for a map that is not JSON', { OPT2_SERVICE_URLS: 'not-json' }, [expect.stringMatching(/^OPT2_SERVICE_URLS: /)]],
  ])('%s', (_case, overrides, issues) => {
    expect(envError(overrides)?.issues ?? []).toStrictEqual(issues);
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    [
      'every missing callee',
      { OPT2_SERVICE_URLS: undefined },
      'surveys: invalid environment (OPT2_SERVICE_URLS.surveys: is required; OPT2_SERVICE_URLS.identity: is required; OPT2_SERVICE_URLS.communications: is required)',
    ],
    ['the database settings', { OPT2_DB_AUTH: undefined, PG_DATABASE: undefined }, 'surveys: invalid environment (OPT2_DB_AUTH: is required; PG_DATABASE: is required)'],
    // The prefix is the OPT2_SERVICE_NAME the process was given.
    ['the wrong service name', { OPT2_SERVICE_NAME: 'communications' }, 'communications: invalid environment (OPT2_SERVICE_NAME: must be surveys)'],
  ])('logs %s by name and reason only', (_case, overrides, text) => {
    expect(serializeError(envError(overrides))).toMatchObject({ type: 'EnvValidationError', message: text });
  });
});
