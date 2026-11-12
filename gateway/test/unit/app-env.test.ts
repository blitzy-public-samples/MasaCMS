// Tests gatewayEnvSchema through loadEnv, and the matcher's route-key wiring of the reload key and the legacy site registry.
import { randomBytes, randomUUID } from 'node:crypto';
import { fixedClock } from '@opt2/platform/testing';
import { EnvValidationError, loadEnv } from '@opt2/platform/service-kit';
import { describe, expect, it } from 'vitest';
import { createResponseModes } from '../../src/admin/response-modes.js';
import { createSiteRegistry } from '../../src/dispatcher/site-registry.js';
import { gatewayEnvSchema, routeKeyOptionsOf, type GatewayEnv } from '../../src/app.js';
import { EMPTY_BODY_PARAMS } from '../../src/dispatcher/body.js';
import { createMatcher, type Matcher } from '../../src/dispatcher/match.js';
import { RELAY_SERVICES } from '../../src/dispatcher/relay.js';

const PACKAGES = [
  'gateway',
  'web',
  'migration',
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
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

/** The matcher with no active version and app.ts's route-key options for `env` and `siteExists`. */
function matcherFor(env: GatewayEnv, siteExists?: (siteId: string) => boolean): Matcher {
  return createMatcher({
    state: { active: () => undefined },
    variants: { sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f', variants: [] },
    modes: createResponseModes({ get: () => undefined, routes: () => [] }),
    env,
    clock: fixedClock('2026-06-30T12:00:00Z'),
    routeKeyOptions: routeKeyOptionsOf(env, siteExists),
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

const CLOUD = { OPT2_ENV: 'cloud', OPT2_JWKS_URL: undefined, GOOGLE_CLOUD_PROJECT: 'opt2-plan' } as const;

describe('gatewayEnvSchema service destinations', () => {
  it('loads a complete local environment with every package URL', () => {
    const env = loadEnv(gatewayEnvSchema, sourceOf());

    expect(env.OPT2_SERVICE_URLS).toEqual(SERVICE_URLS);
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

  it('passes no site registry unless one is given', () => {
    const env = loadEnv(gatewayEnvSchema, sourceOf());
    const siteExists = (siteId: string): boolean => siteId === 'default';

    expect(routeKeyOptionsOf(env)).toEqual({ appReloadKey: 'appreload' });
    expect(routeKeyOptionsOf(env, siteExists)).toEqual({ appReloadKey: 'appreload', siteExists });
  });
});

describe('route-key wiring of the legacy site registry', () => {
  it.each<[string, string, [string, string]]>([
    ['an unknown JSON API site falls back to default and fails its check', '/_api/json/v1/nosuchsite/content', ['api:!invalidparameters', 'default']],
    ['an unknown url siteid falls back to default', '/_api/json/v1/?method=findOne&entityname=content&siteid=nosuchsite', ['api:!invalidparameters', 'default']],
    ['a registered site keeps its key', '/_api/json/v1/default/content', ['api:content.findall', 'default']],
    ['a registered site matches without case', '/_api/json/v1/Tenant-A/content', ['api:content.findall', 'Tenant-A']],
  ])('%s', async (_case, url, expected) => {
    const registry = createSiteRegistry({ list: () => Promise.resolve(['default', 'tenant-a']), logger: { error: () => undefined } });
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
