/** `/_api/resource/variation`: the branch gate against the shared route key, the unmatched page, the site binding and the fail-closed script. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { routeKeyForRequest } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, testVerifier, writeTestSecrets, type InjectResponse } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS } from '../../src/domain/context.js';
import { VARIATION_PATH, registerVariationRoutes, urlSiteId, type VariationQuery } from '../../src/routes/variation.js';
import { SERVICE, TEST_CLOCK, serviceHeaders, testEnv, userHeaders } from '../helpers/app.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const TEMPLATES = { [VARIATION_PATH]: VARIATION_PATH, [`${VARIATION_PATH}/{path}`]: `${VARIATION_PATH}/*` } as const;
const USER_ID = 'D1E2F3A4-0001-4A5B-8C7D9E0F1A2B3C4D';
const SITE_A = TENANT_A.siteId;
const HTML = 'text/html;charset=UTF-8';

type Headers = () => Promise<Record<string, string>>;
const anonymous: Headers = async () => ({});
const visitorOf = (site: string): Headers => () => userHeaders({ sub: '', site, roles: [] });
const gatewayOnly: Headers = () => serviceHeaders('gateway');

describe('urlSiteId', () => {
  it.each<[string, VariationQuery, string | undefined]>([
    ['no siteid', { feedid: 'x' }, undefined],
    ['an empty siteid, which isDefined still finds', { siteid: '' }, ''],
    ['the key without case', { SiteID: SITE_A }, SITE_A],
    ['a repeated key joined', { siteid: [SITE_A, 'b'] }, `${SITE_A},b`],
  ])('reads %s', (_label, query, expected) => {
    expect(urlSiteId(query)).toBe(expected);
  });
});

describe('variation routes', () => {
  let stateDir: string;
  const apps: Partial<Record<'off' | 'on', FastifyInstance>> = {};

  /** Sends a GET to the app whose `variations` setting is `setting` and checks the answer against the contract. */
  async function call(setting: 'off' | 'on', url: string, headers: Headers = visitorOf(SITE_A)): Promise<InjectResponse> {
    const app = apps[setting];
    if (app === undefined) throw new Error(`no ${setting} app`);
    const res = await app.inject({ method: 'GET', url, headers: await headers() });
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'GET',
      path: (url.split('?')[0] ?? url).replace(/\/$/, ''),
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  }

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-variation-'));
    await writeTestSecrets(stateDir);
    for (const [setting, variations] of [['off', false], ['on', true]] as const) {
      const app = await createService({
        name: SERVICE,
        version: '1.0.0',
        env: loadEnv(undefined, testEnv(stateDir)),
        clock: TEST_CLOCK,
        verifierOverride: testVerifier(SERVICE),
        logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
      });
      registerVariationRoutes(app, { domain: { config: { ...CONTENT_CONFIG_DEFAULTS, variations } } });
      await app.ready();
      apps[setting] = app;
    }
  });

  afterAll(async () => {
    await apps.off?.opt2.shutdown();
    await apps.on?.opt2.shutdown();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares both contract operations: public on the service transport, the site checked by the handler', () => {
    const declared = collectRouteMatrix(apps.off as FastifyInstance).routes.filter((route) => route.url.startsWith(VARIATION_PATH));
    expect(declared).toEqual(
      Object.entries(TEMPLATES).map(([template, url]) => {
        const operation = OPENAPI.paths[template]?.['get'] ?? {};
        expect(operation['x-opt2-route-keys']).toEqual(['variation:js']);
        expect(operation['x-opt2-public']).toBe(true);
        return { method: 'GET', url, transport: operation['x-opt2-transport'], public: true, siteCheck: false };
      }),
    );
  });

  it.each<[string, 'off' | 'on', string, Headers]>([
    ['the setting off', 'off', `${VARIATION_PATH}?siteid=${SITE_A}`, visitorOf(SITE_A)],
    ['the setting off, whatever site the url names and with no credential', 'off', `${VARIATION_PATH}?siteid=${TENANT_B.siteId}`, anonymous],
    ['the setting off, on a longer path', 'off', `${VARIATION_PATH}/js?siteid=${SITE_A}`, visitorOf(SITE_A)],
    ['no url siteid', 'on', VARIATION_PATH, anonymous],
    ['no url siteid, on the trailing-slash path', 'on', `${VARIATION_PATH}/`, visitorOf(SITE_A)],
  ])('answers the empty unmatched page with %s', async (_label, setting, url, headers) => {
    const res = await call(setting, url, headers);
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({ status: 200, type: HTML, body: '' });
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
  });

  it.each<[string, number, string, Headers]>([
    ['no credential', 401, `${VARIATION_PATH}?siteid=${SITE_A}`, anonymous],
    ['an invocation credential without a user token', 401, `${VARIATION_PATH}?siteid=${SITE_A}`, gatewayOnly],
    ['a siteid other than the token site', 403, `${VARIATION_PATH}?siteid=${TENANT_B.siteId}`, visitorOf(SITE_A)],
    ['a siteid other than the token site on a longer path', 403, `${VARIATION_PATH}/js?siteid=${TENANT_B.siteId}`, visitorOf(SITE_A)],
    ['the token site, whose script only the CFML runtime generates', 503, `${VARIATION_PATH}?siteid=${SITE_A.toUpperCase()}`, visitorOf(SITE_A)],
    ['the token site on a longer path', 503, `${VARIATION_PATH}/js?SiteID=${SITE_A}&contenttype=Page`, visitorOf(SITE_A)],
    ['an empty siteid', 503, `${VARIATION_PATH}?siteid=`, visitorOf(SITE_A)],
  ])('answers the taken branch with %s by %d', async (_label, status, url, headers) => {
    const res = await call('on', url, headers);
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
  });

  it.each<[string, Record<string, string>, boolean]>([
    ['the setting on with a url siteid', { siteid: SITE_A }, true],
    ['the setting on without a url siteid', {}, true],
    ['the setting off with a url siteid', { siteid: SITE_A }, false],
  ])('takes the branch exactly where the shared route key reads variation:js, for %s', async (_label, query, variations) => {
    const search = new URLSearchParams(query).toString();
    const res = await call(variations ? 'on' : 'off', search === '' ? VARIATION_PATH : `${VARIATION_PATH}?${search}`);
    const key = routeKeyForRequest({ method: 'GET', path: VARIATION_PATH, query, headers: {} }, { variationsEnabled: variations });
    expect(key.key === 'variation:js').toBe(res.statusCode !== 200);
  });
});
