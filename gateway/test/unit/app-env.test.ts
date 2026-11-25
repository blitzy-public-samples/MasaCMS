// Tests gatewayEnvSchema through loadEnv (own name, database keys, callees), the matcher's route-key wiring of the reload key and the legacy site registry, and the barrier's projected owners.
import { randomBytes, randomUUID } from 'node:crypto';
import { fixedClock } from '@opt2/platform/testing';
import { serializeError } from '@opt2/platform/logging';
import { EnvValidationError, loadEnv } from '@opt2/platform/service-kit';
import { describe, expect, it } from 'vitest';
import { createResponseModes } from '../../src/admin/response-modes.js';
import { createSiteRegistry } from '../../src/dispatcher/site-registry.js';
import { gatewayEnvSchema, projectedOwnersOf, routeKeyOptionsOf, type GatewayEnv } from '../../src/app.js';
import { loadTableOwnership } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { RoutingIndex } from '../../src/cutover/types.js';
import { EMPTY_BODY_PARAMS } from '../../src/dispatcher/body.js';
import { createMatcher, type Matcher } from '../../src/dispatcher/match.js';
import { RELAY_SERVICES } from '../../src/dispatcher/relay.js';
import { committedIndex, type CommittedVersion } from '../helpers/versions.js';

const PACKAGES = [
  'gateway',
  'web',
  'migration',
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'stub',
] as const;
const urlOf = (name: string): string => `http://127.0.0.1:${String(8100 + PACKAGES.indexOf(name as (typeof PACKAGES)[number]))}`;
const SERVICE_URLS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(PACKAGES.map((name) => [name, urlOf(name)])));
// Built at run time: a fixture reload key and bridge key, never a configured secret.
const FIXTURE_RELOAD_KEY = `FIXTURE-${randomUUID().slice(0, 8)}`;
const BRIDGE_KEY = randomBytes(16).toString('hex');

/** A complete local gateway environment, as `up.sh` passes it, with `overrides` applied and `undefined` entries removed. */
function sourceOf(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const source: Record<string, string | undefined> = {
    PORT: '8100',
    OPT2_SERVICE_NAME: 'gateway',
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'masa_services',
    PG_USER: 'gateway_app',
    PG_PASSWORD: 'unused',
    OPT2_JWKS_URL: `${urlOf('identity')}/.well-known/jwks.json`,
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify(SERVICE_URLS),
    TZ: 'UTC',
    LEGACY_ORIGIN: 'http://127.0.0.1:8080',
    OPT2_BRIDGE_HMAC_KEY: BRIDGE_KEY,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

/** Inventory facts naming no remote function. */
const NO_REMOTE_FUNCTIONS = { entityRemoteFunctions: {} };

/** The matcher with no active version and app.ts's route-key options for `env` and `siteExists`, without remote functions. */
function matcherFor(env: GatewayEnv, siteExists?: (siteId: string) => boolean): Matcher {
  return createMatcher({
    state: { active: () => undefined },
    variants: { sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f', variants: [] },
    modes: createResponseModes({ get: () => undefined, routes: () => [] }),
    env,
    clock: fixedClock('2026-06-30T12:00:00Z'),
    routeKeyOptions: routeKeyOptionsOf(env, NO_REMOTE_FUNCTIONS, siteExists),
  });
}

async function keyOf(matcher: Matcher, url: string): Promise<string | undefined> {
  return (await siteKeyOf(matcher, url))[0];
}

async function siteKeyOf(matcher: Matcher, url: string): Promise<[string | undefined, string | undefined]> {
  const { result } = await matcher.match({ url, method: 'GET', headers: {} }, EMPTY_BODY_PARAMS);
  return [result?.key, result?.siteId];
}

/** Issue lines `loadEnv` throws for `source`, or [] when it loads. */
function issuesOf(source: NodeJS.ProcessEnv): string[] {
  try {
    loadEnv(gatewayEnvSchema, source);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as EnvValidationError).issues;
  }
}

/** `SERVICE_URLS` without `names`, as the `OPT2_SERVICE_URLS` value. */
function urlsWithout(...names: string[]): string {
  return JSON.stringify(Object.fromEntries(Object.entries(SERVICE_URLS).filter(([name]) => !names.includes(name))));
}

const CLOUD = {
  OPT2_ENV: 'cloud',
  OPT2_JWKS_URL: undefined,
  GOOGLE_CLOUD_PROJECT: 'opt2-plan',
  OPT2_DB_AUTH: 'iam',
  CLOUD_SQL_INSTANCE: 'opt2-plan:us-central1:opt2-services',
  PG_PASSWORD: undefined,
} as const;

describe('gatewayEnvSchema process identity and database', () => {
  it.each(['web', 'people', 'identity'])('fails start-up naming OPT2_SERVICE_NAME when it is %s', (name) => {
    expect(issuesOf(sourceOf({ OPT2_SERVICE_NAME: name }))).toEqual(['OPT2_SERVICE_NAME: must be gateway']);
  });

  it.each([
    ['local', 'OPT2_DB_AUTH', {}],
    ['local', 'PG_DATABASE', {}],
    ['cloud', 'OPT2_DB_AUTH', CLOUD],
    ['cloud', 'PG_DATABASE', CLOUD],
  ])('fails start-up in %s naming %s when it is missing', (_mode, key, mode) => {
    expect(issuesOf(sourceOf({ ...mode, [key]: undefined }))).toEqual([`${key}: is required`]);
  });

  it('lists the name, the database keys and the callees in one logged line, naming keys only', () => {
    const source = sourceOf({
      OPT2_SERVICE_NAME: 'web',
      OPT2_DB_AUTH: undefined,
      PG_DATABASE: undefined,
      OPT2_SERVICE_URLS: urlsWithout('identity'),
    });

    expect(issuesOf(source)).toEqual([
      'OPT2_SERVICE_NAME: must be gateway',
      'OPT2_DB_AUTH: is required',
      'PG_DATABASE: is required',
      'OPT2_SERVICE_URLS.identity: is required',
    ]);
    let thrown: unknown;
    try {
      loadEnv(gatewayEnvSchema, source);
    } catch (error) {
      thrown = error;
    }
    expect(serializeError(thrown).message).toBe(
      'web: invalid environment (OPT2_SERVICE_NAME: must be gateway; OPT2_DB_AUTH: is required; PG_DATABASE: is required; OPT2_SERVICE_URLS.identity: is required)',
    );
  });
});

describe('gatewayEnvSchema service destinations', () => {
  it('loads a complete local environment with every package URL', () => {
    const env = loadEnv(gatewayEnvSchema, sourceOf());

    expect(env.OPT2_SERVICE_URLS).toEqual(SERVICE_URLS);
  });

  it('starts with a map naming only the kept services, the stub and migration at their ports.env ports', () => {
    const kept = {
      identity: 'http://127.0.0.1:8111',
      people: 'http://127.0.0.1:8112',
      'programs-sites': 'http://127.0.0.1:8113',
      'strategies-content': 'http://127.0.0.1:8114',
      web: 'http://127.0.0.1:8101',
      stub: 'http://127.0.0.1:8199',
      migration: 'http://127.0.0.1:8102',
    };

    const env = loadEnv(gatewayEnvSchema, sourceOf({ OPT2_SERVICE_URLS: JSON.stringify(kept) }));

    expect(env.OPT2_SERVICE_URLS).toEqual(kept);
    expect(RELAY_SERVICES).toEqual(['identity', 'people', 'programs-sites', 'strategies-content']);
  });

  it.each([...RELAY_SERVICES, 'web', 'stub'])('fails start-up naming OPT2_SERVICE_URLS.%s when it is missing', (name) => {
    expect(issuesOf(sourceOf({ OPT2_SERVICE_URLS: urlsWithout(name) }))).toEqual([`OPT2_SERVICE_URLS.${name}: is required`]);
  });

  it.each([
    ['the map entry alone', { OPT2_MIGRATION_URL: undefined }],
    ['OPT2_MIGRATION_URL alone', { OPT2_MIGRATION_URL: 'http://127.0.0.1:8102', OPT2_SERVICE_URLS: urlsWithout('migration') }],
    ['both', { OPT2_MIGRATION_URL: 'http://127.0.0.1:8102' }],
  ])('accepts migration from %s', (_case, overrides) => {
    expect(issuesOf(sourceOf(overrides))).toEqual([]);
  });

  it('fails start-up naming OPT2_MIGRATION_URL when neither key names migration', () => {
    expect(issuesOf(sourceOf({ OPT2_SERVICE_URLS: urlsWithout('migration') }))).toEqual([
      'OPT2_MIGRATION_URL: is required (or OPT2_SERVICE_URLS.migration)',
    ]);
  });

  it('does not require the stub in the cloud, where it is not deployed', () => {
    expect(issuesOf(sourceOf({ ...CLOUD, OPT2_SERVICE_URLS: urlsWithout('stub') }))).toEqual([]);
  });

  it('still requires every other callee in the cloud', () => {
    expect(issuesOf(sourceOf({ ...CLOUD, OPT2_SERVICE_URLS: urlsWithout('identity', 'web') }))).toEqual([
      'OPT2_SERVICE_URLS.identity: is required',
      'OPT2_SERVICE_URLS.web: is required',
    ]);
  });

  it('lists every missing callee with the other failures when the map is unset, naming keys only', () => {
    const issues = issuesOf(sourceOf({ OPT2_SERVICE_URLS: undefined, LEGACY_ORIGIN: undefined }));

    expect(issues).toEqual([
      'LEGACY_ORIGIN: is required',
      ...[...RELAY_SERVICES, 'web', 'stub'].map((name) => `OPT2_SERVICE_URLS.${name}: is required`),
      'OPT2_MIGRATION_URL: is required (or OPT2_SERVICE_URLS.migration)',
    ]);
  });

  it.each([
    ['is not JSON', 'not json', 'OPT2_SERVICE_URLS: OPT2_SERVICE_URLS must be a JSON object'],
    ['is an array', '["http://127.0.0.1:8111"]', 'OPT2_SERVICE_URLS: Invalid input: expected record, received array'],
  ])('reports only the map when it %s', (_case, value, issue) => {
    expect(issuesOf(sourceOf({ OPT2_SERVICE_URLS: value }))).toEqual([issue]);
  });

  it('reports an invalid entry as invalid, not missing, and still lists the missing ones', () => {
    const urls = JSON.stringify({ ...JSON.parse(urlsWithout('people')), web: 'web.internal' });

    const issues = issuesOf(sourceOf({ OPT2_SERVICE_URLS: urls }));

    expect(issues).toEqual(['OPT2_SERVICE_URLS.web: Invalid URL', 'OPT2_SERVICE_URLS.people: is required']);
    expect(issues.join('\n')).not.toContain('web.internal');
  });
});

describe('gatewayEnvSchema MURA_APPRELOADKEY', () => {
  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['whitespace', '  '],
  ])('defaults to Masa’s appreload when %s', (_case, value) => {
    expect(loadEnv(gatewayEnvSchema, sourceOf({ MURA_APPRELOADKEY: value })).MURA_APPRELOADKEY).toBe('appreload');
  });

  it('keeps a configured key', () => {
    expect(loadEnv(gatewayEnvSchema, sourceOf({ MURA_APPRELOADKEY: FIXTURE_RELOAD_KEY })).MURA_APPRELOADKEY).toBe(FIXTURE_RELOAD_KEY);
  });
});

describe('gatewayEnvSchema MURA_SESSIONTIMEOUT', () => {
  it.each<[string, string | undefined, number]>([
    ['unset', undefined, 180],
    ['blank', ' ', 180],
    ['below one minute', '0.5', 180],
    ['an expression', '${sessionTimeout}', 180],
    ['a template expression', '{{sessionTimeout}}', 180],
    ['a number of minutes', ' 45 ', 45],
    ['a fractional number of minutes', '90.5', 90.5],
  ])('reads %s (%j) as %d minutes, as identity does', (_case, value, minutes) => {
    expect(loadEnv(gatewayEnvSchema, sourceOf({ MURA_SESSIONTIMEOUT: value })).MURA_SESSIONTIMEOUT).toBe(minutes);
  });

  it.each(['soon', 'Infinity'])('fails start-up naming MURA_SESSIONTIMEOUT for %j', (value) => {
    expect(issuesOf(sourceOf({ MURA_SESSIONTIMEOUT: value }))).toEqual(['MURA_SESSIONTIMEOUT: must be blank or a number of minutes']);
  });
});

describe('gatewayEnvSchema MURA_REQUESTTIMEOUT', () => {
  it.each<[string, string | undefined, number]>([
    ['unset', undefined, 1000],
    ['blank', ' ', 1000],
    ['a number of seconds', ' 600 ', 600],
    ['a fractional number of seconds', '0.5', 0.5],
  ])('reads %s (%j) as %d seconds, as Masa sets its request timeout', (_case, value, seconds) => {
    expect(loadEnv(gatewayEnvSchema, sourceOf({ MURA_REQUESTTIMEOUT: value })).MURA_REQUESTTIMEOUT).toBe(seconds);
  });

  it.each(['soon', 'Infinity', '0', '-5', '${requesttimeout}'])('fails start-up naming MURA_REQUESTTIMEOUT for %j', (value) => {
    expect(issuesOf(sourceOf({ MURA_REQUESTTIMEOUT: value }))).toEqual([
      'MURA_REQUESTTIMEOUT: must be blank or a positive number of seconds',
    ]);
  });
});

describe('gatewayEnvSchema MURA_SECURECOOKIES and MURA_COOKIEDOMAIN', () => {
  it.each<[string, string | undefined, boolean]>([
    ['unset', undefined, false],
    ['blank', ' ', false],
    ['false', 'false', false],
    ['true', 'true', true],
    ['yes in any case, padded', ' YES ', true],
    ['a non-zero number', '1', true],
    ['zero', '0', false],
    ['a value that is no CFML boolean', 'on', false],
    ['an expression', '${secureCookies}', false],
    ['a template expression', '{{true}}', false],
  ])('reads MURA_SECURECOOKIES %s (%j) as %s, as web does', (_case, value, secure) => {
    expect(loadEnv(gatewayEnvSchema, sourceOf({ MURA_SECURECOOKIES: value })).MURA_SECURECOOKIES).toBe(secure);
  });

  it.each<[string, string | undefined, string]>([
    ['unset', undefined, ''],
    ['blank', '', ''],
    ['a domain with a leading dot', '.example.test', '.example.test'],
    ['a host name', 'example.test', 'example.test'],
    ['an expression', '${cookieDomain}', ''],
    ['a template expression', '{{cookieDomain}}', ''],
  ])('reads MURA_COOKIEDOMAIN %s (%j) as %j', (_case, value, domain) => {
    expect(loadEnv(gatewayEnvSchema, sourceOf({ MURA_COOKIEDOMAIN: value })).MURA_COOKIEDOMAIN).toBe(domain);
  });
});

describe('route-key wiring of the reload key', () => {
  it.each([
    ['the configured key', `/?${FIXTURE_RELOAD_KEY}`, 'reload:application'],
    ['the configured key in another case', `/index.cfm?${FIXTURE_RELOAD_KEY.toLowerCase()}=1`, 'reload:application'],
    ['the default key', '/?appreload', 'page:render'],
  ])('keys %s under a configured key as %s', async (_case, url, key) => {
    const matcher = matcherFor(loadEnv(gatewayEnvSchema, sourceOf({ MURA_APPRELOADKEY: FIXTURE_RELOAD_KEY })));

    await expect(keyOf(matcher, url)).resolves.toBe(key);
  });

  it('keys the default key as the reload when none is configured', async () => {
    const matcher = matcherFor(loadEnv(gatewayEnvSchema, sourceOf()));

    await expect(keyOf(matcher, '/?appreload')).resolves.toBe('reload:application');
    await expect(keyOf(matcher, `/?${FIXTURE_RELOAD_KEY}`)).resolves.toBe('page:render');
  });

  it('passes the inventory remote functions, and no site registry unless one is given', () => {
    const env = loadEnv(gatewayEnvSchema, sourceOf());
    const siteExists = (siteId: string): boolean => siteId === 'default';
    const entityRemoteFunctions = { comment: ['flag'] };

    expect(routeKeyOptionsOf(env, { entityRemoteFunctions })).toEqual({ appReloadKey: 'appreload', entityRemoteFunctions });
    expect(routeKeyOptionsOf(env, { entityRemoteFunctions }, siteExists)).toEqual({
      appReloadKey: 'appreload',
      entityRemoteFunctions,
      siteExists,
    });
  });
});

describe('route-key wiring of the legacy site registry', () => {
  it.each<[string, string, [string, string]]>([
    ['an unknown JSON API site falls back to default and fails its check', '/_api/json/v1/nosuchsite/content', ['api:!invalidparameters', 'default']],
    ['an unknown url siteid falls back to default', '/_api/json/v1/?method=findOne&entityname=content&siteid=nosuchsite', ['api:!invalidparameters', 'default']],
    ['a registered site keeps its key', '/_api/json/v1/default/content', ['api:content.findall', 'default']],
    ['a registered site matches without case', '/_api/json/v1/Tenant-A/content', ['api:content.findall', 'Tenant-A']],
  ])('%s', async (_case, url, expected) => {
    const listing = { sites: ['default', 'tenant-a'], bindings: [], adminDomain: '' };
    const registry = createSiteRegistry({ list: () => Promise.resolve(listing), logger: { error: () => undefined } });
    await registry.start();
    try {
      const matcher = matcherFor(loadEnv(gatewayEnvSchema, sourceOf()), registry.siteExists);

      await expect(siteKeyOf(matcher, url)).resolves.toEqual(expected);
    } finally {
      registry.stop();
    }
  });

  it('treats every site as existing without a registry, the route-matrix export default', async () => {
    const matcher = matcherFor(loadEnv(gatewayEnvSchema, sourceOf()));

    await expect(siteKeyOf(matcher, '/_api/json/v1/nosuchsite/content')).resolves.toEqual(['api:content.findall', 'nosuchsite']);
  });
});

describe('projected owners of the active version', () => {
  const ownership = loadTableOwnership(resolveGatewayPaths({}));
  // v0003 returns R to legacy, which leaves people no target-authoritative unit and identity its permission group.
  const V0002_OWNERS = ['identity', 'people', 'programs-sites', 'strategies-content'];

  it.each<[CommittedVersion, string[]]>([
    ['v0001', []],
    ['v0002', V0002_OWNERS],
    ['v0003', V0002_OWNERS.filter((owner) => owner !== 'people')],
  ])('are the table-ownership owners of the units %s makes target-authoritative', async (version, owners) => {
    const index = await committedIndex(version);
    const projected = projectedOwnersOf((await ownership).units, () => index);

    expect([...projected()].sort()).toEqual(owners);
  });

  it('are none before any version is active, and the last seen version stays in force while the cache is stale', async () => {
    const [v0002, v0001] = await Promise.all([committedIndex('v0002'), committedIndex('v0001')]);
    let active: RoutingIndex | undefined;
    const projected = projectedOwnersOf((await ownership).units, () => active);

    expect(projected().size).toBe(0);
    active = v0002;
    const first = projected();
    expect(first.has('people')).toBe(true);
    expect(projected()).toBe(first);
    active = undefined;
    expect(projected()).toBe(first);
    active = v0001;
    expect(projected().has('people')).toBe(false);
  });

  it('reads unit authority once per routing index', async () => {
    const index = await committedIndex('v0002');
    let reads = 0;
    const counted: RoutingIndex = {
      ...index,
      unitAuthority: (unit) => {
        reads += 1;
        return index.unitAuthority(unit);
      },
    };
    const { units } = await ownership;
    const projected = projectedOwnersOf(units, () => counted);

    projected();
    projected();
    expect(reads).toBe(units.length);
  });
});
