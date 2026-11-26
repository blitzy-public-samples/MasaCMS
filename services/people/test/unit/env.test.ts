/** People's environment schema: the base variables, the password-expiry setting and the roster fault step, with its own name, its database and every `OPT2_SERVICE_URLS` callee required at start-up. */
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { serializeError } from '@opt2/platform/logging';
import { EnvValidationError, baseEnvSchema, loadEnv } from '@opt2/platform/service-kit';
import { peopleEnvSchema } from '../../src/app.js';
import type { RosterStep } from '../../src/domain/faults.js';

// Ports of harness/repro/ports.env.
const CALLEE_URLS = { people: 'http://127.0.0.1:8112', identity: 'http://127.0.0.1:8111', 'strategies-content': 'http://127.0.0.1:8114' };
const EVERY_CALLEE = [
  'OPT2_SERVICE_URLS.people: is required',
  'OPT2_SERVICE_URLS.identity: is required',
  'OPT2_SERVICE_URLS.strategies-content: is required',
];

/** A valid local people environment with `overrides`, `undefined` removing a variable. */
function localSource(overrides: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const source: Record<string, string | undefined> = {
    PORT: '8112',
    OPT2_SERVICE_NAME: 'people',
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2_people_test',
    PG_USER: 'people_app',
    PG_PASSWORD: 'unused',
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

/** What `loadEnv(peopleEnvSchema)` throws for a valid local environment with `overrides`; undefined when it parses. */
function refusal(overrides: Readonly<Record<string, string | undefined>>): unknown {
  try {
    loadEnv(peopleEnvSchema, localSource(overrides));
    return undefined;
  } catch (err) {
    return err;
  }
}

/** The issues `loadEnv(peopleEnvSchema)` reports for a valid local environment with `overrides`; none when it parses. */
function envIssues(overrides: Readonly<Record<string, string | undefined>>): string[] {
  const err = refusal(overrides);
  if (err === undefined) return [];
  if (err instanceof EnvValidationError) return err.issues;
  throw err;
}

describe('peopleEnvSchema', () => {
  it('reads the base variables, MURA_EXPIREPASSWORDS and OPT2_FAULT', () => {
    expect(Object.keys(peopleEnvSchema.shape)).toStrictEqual([...Object.keys(baseEnvSchema.shape), 'MURA_EXPIREPASSWORDS', 'OPT2_FAULT']);
  });

  it.each<[string, string | undefined, number | RosterStep | undefined]>([
    ['MURA_EXPIREPASSWORDS', undefined, 0],
    ['MURA_EXPIREPASSWORDS', '30', 30],
    ['MURA_EXPIREPASSWORDS', '', 0],
    ['MURA_EXPIREPASSWORDS', '{{expirePasswords}}', 0],
    ['OPT2_FAULT', undefined, undefined],
    ['OPT2_FAULT', 'roster:after-prepare', 'after-prepare'],
    ['OPT2_FAULT', 'identity:after-start', undefined],
  ])('parses %s %j as %j without rejecting it', (key, value, parsed) => {
    expect(loadEnv(peopleEnvSchema, localSource({ [key]: value }))[key as 'MURA_EXPIREPASSWORDS' | 'OPT2_FAULT']).toBe(parsed);
  });

  it.each<[string, Record<string, string | undefined>, string[]]>([
    ['parses a map naming every callee', {}, []],
    ...Object.keys(CALLEE_URLS).map((callee): [string, Record<string, string | undefined>, string[]] => [
      `names ${callee} when only it is missing from the map`,
      { OPT2_SERVICE_URLS: JSON.stringify(Object.fromEntries(Object.entries(CALLEE_URLS).filter(([name]) => name !== callee))) },
      [`OPT2_SERVICE_URLS.${callee}: is required`],
    ]),
    ['refuses the name of identity', { OPT2_SERVICE_NAME: 'identity' }, ['OPT2_SERVICE_NAME: must be people']],
    ['names OPT2_DB_AUTH when it is unset', { OPT2_DB_AUTH: undefined }, ['OPT2_DB_AUTH: is required']],
    ['names PG_DATABASE when it is unset', { PG_DATABASE: undefined }, ['PG_DATABASE: is required']],
    ['names every callee when OPT2_SERVICE_URLS is unset', { OPT2_SERVICE_URLS: undefined }, EVERY_CALLEE],
    ['names every callee when OPT2_SERVICE_URLS is {}', { OPT2_SERVICE_URLS: '{}' }, EVERY_CALLEE],
    [
      'names only the callees a partial map lacks',
      { OPT2_SERVICE_URLS: JSON.stringify({ identity: CALLEE_URLS.identity }) },
      ['OPT2_SERVICE_URLS.people: is required', 'OPT2_SERVICE_URLS.strategies-content: is required'],
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

  it.each<[string, Record<string, string | undefined>, string]>([
    [
      'every missing callee',
      { OPT2_SERVICE_URLS: undefined },
      'people: invalid environment (OPT2_SERVICE_URLS.people: is required; OPT2_SERVICE_URLS.identity: is required; OPT2_SERVICE_URLS.strategies-content: is required)',
    ],
    ['the missing database settings', { OPT2_DB_AUTH: undefined, PG_DATABASE: undefined }, 'people: invalid environment (OPT2_DB_AUTH: is required; PG_DATABASE: is required)'],
  ])('logs a refusal naming %s with its reason and no value', (_case, overrides, text) => {
    const err = refusal(overrides);
    expect(err).toBeInstanceOf(EnvValidationError);
    expect(serializeError(err).message).toBe(text);
  });
});
