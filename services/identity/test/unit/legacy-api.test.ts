/** The JSON API routes against Masa 7.6.1 oracle answers over an in-memory registry: headers, CORS, route ownership, path forms, the MURA settings, identity's named methods without stored data, ad hoc validate rules, the error log and the LIKE matcher; and the REST token endpoint's path forms over a throwaway `identity` schema. */
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOCAL_SERVICE_TOKEN_TTL_SECONDS, collectRouteMatrix } from '@opt2/platform/auth';
import { etag, scannedRouteKey } from '@opt2/platform/legacy-compat';
import { validateLogRecord } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { EnvValidationError, SERVICE_CALL_TIMEOUT_MS, type FastifyInstance, type ServiceClient, type ServiceResponse } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createIdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';
import { legacyApiPrefixes, likeMatcher, registerLegacyApiRoutes, type LegacyApiRouteDeps, type LegacyApiSettings } from '../../src/routes/legacy-api.js';
import {
  ADMIN_GROUP,
  API,
  CLOCK,
  EDITOR_GROUP,
  ERRORS,
  FORM_BODY,
  HOST,
  LEGACY_JSON_TYPE,
  MEMBER,
  MEMORY_ANSWERS,
  MODULE_ONLY,
  NOW,
  OPENAPI,
  S2,
  SETTINGS,
  SITE,
  SITE_ADMIN,
  SITE_B,
  USERS_EDITOR,
  buildApp,
  capturingLogger,
  dataOf,
  expectOracleAnswer,
  expectValidateAnswer,
  headersFor,
  json,
  legacyError,
  oracle,
  oraclePath,
  quietLogger,
  recordingFetch,
  recordingPeople,
  registerLegacyApiState,
  routeDeps,
  send,
  validateAnswer,
  validateAnswers,
  validateCaller,
  validatePath,
  type Answer,
  type Caller,
  type Method,
} from '../helpers/legacy-api.js';
import { createRecordingDb } from '../helpers/memory-repo.js';

/** Well-formed values of every `MURA_<KEY>` setting the routes read. */
const VALID_MURA_ENV = { MURA_ADMINSSL: 'false', MURA_PORT: '', MURA_CONTEXT: '', MURA_ADMINDOMAIN: '', MURA_APPRELOADKEY: 'appreload' };

registerLegacyApiState();

// --- Registry-only calls: an in-memory registry of `default` (domain localhost) and `tenant-b` ---

/** Registry rows of the in-memory database. */
const MEMORY_REGISTRY = [
  { site_id: SITE, domains: ['localhost'] },
  { site_id: SITE_B, domains: [] as string[] },
].map(({ site_id, domains }) => ({
  site_id,
  tenant_id: tenantIdForSite(site_id),
  public_user_pool_id: site_id,
  private_user_pool_id: site_id,
  category_pool_id: site_id,
  file_pool_id: site_id,
  display_pool_id: site_id,
  content_pool_ids: [site_id],
  public_user_pool_tenant: tenantIdForSite(site_id),
  private_user_pool_tenant: tenantIdForSite(site_id),
  category_pool_tenant: tenantIdForSite(site_id),
  file_pool_tenant: tenantIdForSite(site_id),
  display_pool_tenant: tenantIdForSite(site_id),
  content_pool_tenants: [tenantIdForSite(site_id)],
  domains,
  aggregate_version: 1,
  updated_at: NOW,
}));
const REGISTRY_ENTRIES = /^SELECT site_id, tenant_id, .+ FROM identity\.tenant_registry WHERE NOT deleted ORDER BY site_id$/;

describe('JSON API over an in-memory registry', () => {
  const people = recordingPeople();
  const outbound = recordingFetch();
  let registryDown = false;
  const registryRows = <T>(rows: T[]): T[] => {
    if (registryDown) throw new Error('registry unavailable');
    return rows;
  };
  const db = createRecordingDb({
    responses: [
      [/SELECT tenant_id, site_id FROM identity\.tenant_registry WHERE NOT deleted ORDER BY site_id/, () => registryRows(MEMORY_REGISTRY.map(({ site_id, tenant_id }) => ({ site_id, tenant_id })))],
      [REGISTRY_ENTRIES, () => registryRows(MEMORY_REGISTRY)],
      [/FROM identity\.tenant_registry WHERE tenant_id = \$1/, (_sql, values) => registryRows(MEMORY_REGISTRY.filter((row) => row.tenant_id === values[0]))],
    ],
  });
  const repo = createIdentityRepository({ clock: CLOCK });
  const deps = routeDeps(db, repo, people, outbound.fetch, SETTINGS);
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(deps);
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
  });

  it('declares GET, POST, PUT and DELETE of the json, ajax and rest families, bare and behind /index.cfm, as the contract does: public, service transport, no hook site check', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => /^(?:\/index\.cfm)?\/_api\//.test(route.url) && route.method !== 'HEAD');
    const expected = new Map<string, unknown>();
    for (const [template, operations] of Object.entries(OPENAPI.paths)) {
      if (!template.startsWith('/_api/')) continue;
      for (const [method, operation] of Object.entries(operations)) {
        if (method === 'parameters') continue;
        for (const url of operation['x-opt2-fastify-path'] as string[]) {
          const entry = { method: method.toUpperCase(), url, transport: operation['x-opt2-transport'], public: operation['x-opt2-public'], siteCheck: false };
          expected.set(JSON.stringify(entry), entry);
        }
      }
    }
    expect(expected.size).toBe(24);
    expect(declared).toHaveLength(24);
    expect(declared).toEqual(expect.arrayContaining([...expected.values()]));
  });

  it.each(MEMORY_ANSWERS)('answers the oracle request %s as Masa 7.6.1 does', async (name) => {
    const answer = oracle(name);
    if (name === 'findCurrentUserAnonymous') {
      // People answers the user without the session's role lists, which identity adds.
      const user = Object.entries((JSON.parse(answer.body) as { data: Record<string, unknown> }).data).filter(
        ([key]) => !['memberships', 'membershipids', 'isloggedin'].includes(key),
      );
      people.answer = { status: 200, headers: {}, body: { data: Object.fromEntries(user) } };
      people.calls.length = 0;
    }
    if (name === 'validateEmail') {
      const fileContent = JSON.parse(answer.body) as string;
      outbound.reply = () => Promise.resolve(new Response(fileContent));
    }

    const res = await send(app, 'GET', oraclePath(answer), await headersFor());

    expectOracleAnswer(res, answer);
    if (name === 'findCurrentUserAnonymous') {
      // No user token to forward, so people reads a new bean of the call's site.
      expect(people.calls).toEqual([
        { service: 'people', method: 'GET', path: '/internal/v1/users/current', query: { siteid: SITE, endpoint: `http://${HOST}/index.cfm${API}`, adminpath: `http://${HOST}/admin` } },
      ]);
    }
  });

  it('sends an envelope with the uppercase SHA-256 ETag of its body and the Masa Generator and HSTS headers', async () => {
    const res = await send(app, 'GET', `${API}/group/properties`, await headersFor());

    expect(res.headers.etag).toBe(etag(res.body));
    expect(res.headers.etag).toMatch(/^[0-9A-F]{64}$/);
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
  });

  it('authenticates a call whose headers are built after the local service token lifetime has passed since the file started', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + (LOCAL_SERVICE_TOKEN_TTL_SECONDS + 1) * 1000);

      const res = await send(app, 'GET', `${API}/group/properties`, await headersFor(S2));

      expect(res.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a 200', `${API}/group/properties`, 200],
    ['an authorization 401', `${API}/group/new`, 401],
  ])('echoes the Origin of a registered site domain and its subdomains with credentials on %s, reading the registry in one statement', async (_label, url, status) => {
    for (const origin of ['http://localhost', 'https://www.localhost:8443']) {
      const before = db.statements().length;
      const res = await send(app, 'GET', url, { ...(await headersFor()), origin });

      expect(res.statusCode).toBe(status);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      const registryReads = db.statements().slice(before).filter((statement) => statement.sql.includes('tenant_registry'));
      expect(registryReads.map((statement) => statement.sql)).toEqual([expect.stringMatching(REGISTRY_ENTRIES)]);
    }
  });

  it('sends no CORS headers for an origin off every registered domain or a call without an Origin', async () => {
    const foreign = await send(app, 'GET', `${API}/group/properties`, { ...(await headersFor()), origin: 'http://localhost.evil.example' });
    const none = await send(app, 'GET', `${API}/group/properties`, await headersFor());

    for (const res of [foreign, none]) {
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('answers an unreadable registry with the unhandled-exception 500 and no Origin echo', async () => {
    registryDown = true;
    try {
      const res = await send(app, 'GET', `${API}/group/properties`, { ...(await headersFor()), origin: 'http://localhost' });

      expect(res.statusCode).toBe(500);
      expect(json(res)).toEqual(legacyError('invalid', ERRORS.serverError));
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      registryDown = false;
    }
  });

  it.each<[string, Method, string, Record<string, string>, Record<string, string> | undefined]>([
    ['a content findOne', 'GET', `${API}/content/00000000000000000000000000000000001`, {}, undefined],
    ['a group delete', 'DELETE', `${API}/group/${EDITOR_GROUP}`, {}, undefined],
    ['a POST overridden to DELETE', 'POST', `${API}/group/${EDITOR_GROUP}`, { 'x-http-method-override': 'DELETE' }, { groupname: 'Editor' }],
    ['an application reload', 'GET', `${API}/group/properties?appreload`, {}, undefined],
  ])('answers %s, which identity does not serve, with the legacy 404 envelope', async (_label, method, url, extra, form) => {
    const res = await send(app, method, url, { ...(await headersFor(S2)), ...extra }, form);

    expect(res.statusCode).toBe(404);
    expect(json(res)).toMatchObject({ apiversion: 'v1', error: ERRORS.invalidMethodCall });
    expect(res.headers.etag).toBe(etag(res.body));
  });

  // The gateway keys the target as sent through scannedRouteKey: onRequestStart tests url.appreload before the scan, whose
  // stripped name `appreload` of `app-reload` reloads nothing, and ColdFusion joins url names differing only in case.
  it.each<[string, string, string, number]>([
    ['a space-padded method', `${API}?method=%20findProperties%20&entityname=group`, 'api:group.findproperties', 200],
    ['a space-padded entityname', `${API}/findProperties?entityname=%20group%20`, 'api:group.findproperties', 200],
    ['app-reload, which the scan strips to the reload key', `${API}/group/properties?app-reload`, 'api:group.findproperties', 200],
    ['the reload key as sent', `${API}/group/properties?appreload`, 'reload:application', 404],
    ['entityname and ENTITYNAME, joined', `${API}?method=findProperties&entityname=group&ENTITYNAME=x`, 'api:group,x.findproperties', 404],
  ])('answers %s under the route key the gateway computes', async (_label, url, gatewayKey, status) => {
    const [path = '', search = ''] = url.split('?');
    const query: Record<string, string | string[]> = {};
    for (const [name, value] of new URLSearchParams(search)) {
      const previous = query[name];
      query[name] = previous === undefined ? value : [previous, value].flat();
    }
    const keyed = scannedRouteKey({ method: 'GET', path, url, query, headers: {} }, { appReloadKey: SETTINGS.appReloadKey });

    const res = await send(app, 'GET', url, await headersFor(S2));

    expect(keyed.result.key).toBe(gatewayKey);
    expect(res.statusCode).toBe(status);
    expect(json(res)).toMatchObject(status === 200 ? { method: 'findProperties' } : { error: ERRORS.invalidMethodCall });
  });

  // The gateway's body read keeps a multipart file part out of the form, so its name reaches the key only as a file.
  it('keys a multipart file part named method as the gateway does, by its file name alone', async () => {
    const url = `${API}/group/properties`;
    const boundary = '----opt2KeyBoundary';
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="method"; filename="findNew"\r\nContent-Type: text/plain\r\n\r\nx\r\n--${boundary}--\r\n`;
    const keyed = scannedRouteKey(
      { method: 'POST', path: url, url, query: {}, form: {}, headers: { 'content-type': contentType }, multipartFileNames: [{ field: 'method', filename: 'findNew' }] },
      { appReloadKey: SETTINGS.appReloadKey },
    );

    const res = await app.inject({ method: 'POST', url, headers: { host: HOST, ...(await headersFor(S2)), 'content-type': contentType }, payload });

    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    expect(keyed.result.key).toBe('api:group.findproperties');
    expect(res.statusCode).toBe(200);
    expect(json(res).method).toBe('findProperties');
  });

  it.each([
    ['a registered path site', `/_api/json/v1/${SITE_B}/group/properties`],
    ['a registered url siteid', `${API}/group/properties?siteid=${SITE_B}`],
    ['a registered url siteid the scan trims', `${API}/group/properties?siteid=%20${SITE_B}%09`],
  ])("refuses %s other than the token's site with 403", async (_label, url) => {
    const res = await send(app, 'GET', url, await headersFor(S2));

    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual(legacyError('invalid', ERRORS.authorization));
  });

  it("refuses a JSON body naming another registered site than the token's with 403", async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/group/properties`,
      headers: { ...(await headersFor(S2)), host: HOST, 'content-type': 'application/json' },
      payload: JSON.stringify({ siteid: SITE_B }),
    });

    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual(legacyError('invalid', ERRORS.authorization));
  });

  it("falls back to the default site for a call that names none, which another site's token may not address", async () => {
    people.calls.length = 0;
    people.answer = { status: 200, headers: {}, body: { data: { userid: '', siteid: SITE } } };

    const anonymous = await send(app, 'GET', '/_api/json/v1/findCurrentUser', await headersFor());
    const otherSite = await send(app, 'GET', '/_api/json/v1/findCurrentUser', await headersFor({ ...S2, site: SITE_B }));

    expect(anonymous.statusCode).toBe(200);
    expect(people.calls.map((call) => [call.path, call.query?.siteid])).toEqual([['/internal/v1/users/current', SITE]]);
    expect(otherSite.statusCode).toBe(403);
  });

  it('refuses a REST method call without a session user as authorization with WWW-Authenticate Basic', async () => {
    const res = await send(app, 'GET', `/_api/rest/v1/${SITE}/group`, await headersFor());

    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual(legacyError('invalid', ERRORS.authorization));
    expect(res.headers['www-authenticate']).toBe('Basic');
  });

  it("reads the anonymous user from people's readCurrentUser with the call's site, link bases, fields, expand and expanddepth", async () => {
    people.calls.length = 0;
    const addresses = [{ addressid: 'A1', isprimary: 1, latitude: 40.25 }];
    people.answer = { status: 200, headers: {}, body: { data: { userid: 'U1', fname: '', isnew: 1, score: 1.5, addresses } } };

    const res = await send(app, 'GET', `/_api/ajax/v1/${SITE}/findCurrentUser?fields=fname&expand=x&expanddepth=2`, await headersFor());

    expect(people.calls).toEqual([
      {
        service: 'people',
        method: 'GET',
        path: '/internal/v1/users/current',
        query: { siteid: SITE, endpoint: `http://${HOST}/index.cfm${API}`, adminpath: `http://${HOST}/admin`, fields: 'fname', expand: 'x', expanddepth: '2' },
      },
    ]);
    expect(json(res)).toEqual({
      apiversion: 'v1',
      method: 'findCurrentUser',
      data: { userid: 'U1', fname: '', isnew: 1, score: 1.5, addresses, memberships: [], membershipids: [], isloggedin: false },
    });
  });

  // Start-up's scan trims url values, drops NUL and replaces script before processRequest reads params.siteid and url.fields.
  it.each<[string, Record<string, string>]>([
    ['siteid=%20default%20&fields=%09fname%0A', { siteid: SITE, fields: 'fname' }],
    ['expand=%3Cscript%3Ealert(1)%3C%2Fscript%3Eaddresses', { siteid: SITE, expand: '[INVALID]addresses' }],
    ['expanddepth=2%00&fields=javascript:fname', { siteid: SITE, expanddepth: '2', fields: '[INVALID]fname' }],
  ])("forwards findCurrentUser's url %s to people as start-up's scan leaves it", async (query, forwarded) => {
    people.calls.length = 0;
    people.answer = { status: 200, headers: {}, body: { data: { userid: '', siteid: SITE } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser?${query}`, await headersFor());

    expect(res.statusCode).toBe(200);
    expect(people.calls.map((call) => call.query)).toEqual([{ endpoint: `http://${HOST}/index.cfm${API}`, adminpath: `http://${HOST}/admin`, ...forwarded }]);
  });

  it('flattens findCurrentUser for useDataNamespace=false in ACF key order', async () => {
    people.answer = { status: 200, headers: {}, body: { data: { userid: 'U1', fname: '', isnew: 1 } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser?useDataNamespace=false`, await headersFor());

    // Bins of the upper-cased keys: APIVERSION 0, MEMBERSHIPIDS 0, ISLOGGEDIN 6, USERID 8, METHOD 9, MEMBERSHIPS 10, ISNEW 13, FNAME 15.
    expect(res.body).toBe('{"apiversion":"v1","membershipids":[],"isloggedin":false,"userid":"U1","method":"findCurrentUser","memberships":[],"isnew":1,"fname":""}');
    expect(res.headers.etag).toBe(etag(res.body));
  });

  it("fails closed with the legacy 503 on findCurrentUser's ishuman field, which renders a CFML display object", async () => {
    people.answer = { status: 200, headers: {}, body: { data: { userid: 'U1' } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser?ishuman=1`, await headersFor());

    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({ error: ERRORS.serverError });
  });

  it.each([502, 503, 504])("answers people's %i to findCurrentUser with the legacy 503", async (status) => {
    people.calls.length = 0;
    people.answer = { status, headers: {}, body: legacyError('invalid', ERRORS.serverError) };

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor());

    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({ error: ERRORS.serverError });
    expect(people.calls).toHaveLength(1);
  });

  it.each<[string, ServiceResponse]>([
    ['a text body', { status: 200, headers: {}, body: 'not json' }],
    ['a body without data', { status: 200, headers: {}, body: {} }],
    ['data that is not a struct', { status: 200, headers: {}, body: { data: [1] } }],
    ['401 refusing the invocation', { status: 401, headers: {}, body: legacyError('invalid', ERRORS.authorization) }],
    ['403 refusing the site', { status: 403, headers: {}, body: legacyError('invalid', ERRORS.authorization) }],
    ['400 refusing the query', { status: 400, headers: {}, body: legacyError('invalid', ERRORS.invalidParameters) }],
  ])("answers people's %s with the unhandled-exception 500 under findCurrentUser", async (_label, answer) => {
    people.answer = answer;

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor());

    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual(legacyError('findCurrentUser', ERRORS.serverError));
  });

  it('asks BriteVerify once with the address as given and the empty API key, sending its answer as is', async () => {
    outbound.calls.length = 0;
    outbound.reply = () => Promise.resolve(new Response('{"status":"valid"}'));

    const res = await send(app, 'GET', `${API}/validateEmail?email=a%2Bb@example.test`, await headersFor());

    expect(outbound.calls).toEqual([{ url: 'https://bpi.briteverify.com/emails.json?address=a+b@example.test&apikey=', method: 'GET' }]);
    expect(res.body).toBe('"{\\"status\\":\\"valid\\"}"');
    expect(res.headers.etag).toBeUndefined();
  });

  it("answers an unreachable BriteVerify with ACF's Connection Failure filecontent", async () => {
    outbound.reply = () => Promise.reject(new TypeError('fetch failed'));

    const res = await send(app, 'GET', `${API}/validateEmail?email=a@example.test`, await headersFor());

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_TYPE);
    expect(res.body).toBe('"Connection Failure"');
    expect(res.headers.etag).toBeUndefined();
  });

  describe('with a BriteVerify that outlasts the deadline', () => {
    const DEADLINE_MS = 200;

    it.each<[string, typeof globalThis.fetch]>([
      ['never-ending body', () => Promise.resolve(new Response(new ReadableStream()))],
      [
        'never-settling exchange that honours its signal',
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason as Error);
            });
          }),
      ],
      [
        'headers and a partial body that stalls until the signal aborts',
        (_input, init) =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"status":'));
                  // undici errors the body of a response whose request signal aborts.
                  init?.signal?.addEventListener('abort', () => {
                    controller.error(init.signal?.reason);
                  });
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          ),
      ],
    ])("answers BriteVerify's %s with ACF's Connection Failure filecontent once validateEmailTimeoutMs passes", async (_label, stall) => {
      const signals: Array<AbortSignal | null | undefined> = [];
      const watched: typeof globalThis.fetch = (input, init) => {
        signals.push(init?.signal);
        return stall(input, init);
      };
      const bounded = await buildApp({ ...deps, fetch: watched, validateEmailTimeoutMs: DEADLINE_MS });
      try {
        const headers = await headersFor();
        const started = performance.now();

        const res = await send(bounded, 'GET', `${API}/validateEmail?email=a@example.test`, headers);

        expect(performance.now() - started).toBeLessThan(SERVICE_CALL_TIMEOUT_MS);
        expect(signals.map((signal) => (signal?.reason as DOMException | undefined)?.name)).toEqual(['TimeoutError']);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe(LEGACY_JSON_TYPE);
        expect(res.body).toBe('"Connection Failure"');
        expect(res.headers.etag).toBeUndefined();
      } finally {
        await bounded.opt2.shutdown();
      }
    });
  });

  it.each([
    ['X-Forwarded-Proto https', { 'x-forwarded-proto': 'HTTPS' }],
    ['a true Front-End-Https', { 'front-end-https': 'true' }],
  ])('builds https links for a request the proxy marks with %s', async (_label, proxy) => {
    const res = await send(app, 'GET', `${API}/group/properties`, { ...(await headersFor()), ...proxy, 'x-forwarded-host': 'www.example.test' });

    expect((dataOf(res).links as Record<string, string>).self).toBe('https://www.example.test/index.cfm/_api/json/v1/default/group/properties');
  });

  it('reports the tusers table of the group properties to a site admin and not to a Users-module editor', async () => {
    const admin = await send(app, 'GET', `${API}/group/properties`, await headersFor(SITE_ADMIN));
    const editor = await send(app, 'GET', `${API}/group/properties`, await headersFor(USERS_EDITOR));

    expect(dataOf(admin).table).toBe('tusers');
    expect(dataOf(editor)).not.toHaveProperty('table');
  });

  it.each([
    ["a member's own id", MEMBER, MEMBER.sub, { read: false, delete: true, save: true }],
    ["a member's own id in lower case", MEMBER, MEMBER.sub.toLowerCase(), { read: false, delete: true, save: true }],
    ['another id for a member', MEMBER, ADMIN_GROUP, { read: false, delete: false, save: false }],
    ['any id for a Users-module grant', MODULE_ONLY, ADMIN_GROUP, { read: true, delete: true, save: true }],
  ])('answers the group permissions of %s', async (_label, caller, id, expected) => {
    const res = await send(app, 'GET', `${API}/findPermissions?entityname=group&id=${id}`, await headersFor(caller));

    expect(json(res)).toEqual({ apiversion: 'v1', method: 'findPermissions', data: expected });
  });

  describe('validate of ad hoc rules (jsonApiUtility.cfc:3657-3700,3770-3780; beanValidator.cfc:80-480)', () => {
    it.each(validateAnswers('adhoc'))('answers the oracle ad hoc validation %s as Masa 7.6.1 does', async (name) => {
      const answer = validateAnswer(name);

      const res = await send(app, 'GET', validatePath(answer), await headersFor(validateCaller(answer)));

      expectValidateAnswer(res, answer);
    });

    it.each(validateAnswers('datatype'))('answers the oracle dataType validation %s as Masa 7.6.1 does', async (name) => {
      const answer = validateAnswer(name);

      const res = await send(app, 'GET', validatePath(answer), await headersFor(validateCaller(answer)));

      expectValidateAnswer(res, answer);
    });

    it.each(validateAnswers('comparison'))('answers the oracle comparison validation %s as Masa 7.6.1 does', async (name) => {
      const answer = validateAnswer(name);

      const res = await send(app, 'GET', validatePath(answer), await headersFor(validateCaller(answer)));

      expectValidateAnswer(res, answer);
    });

    it.each([...validateAnswers('adhoc', true), ...validateAnswers('datatype', true)])(
      'answers %s, which reaches a check of the ACF runtime, with the legacy 503 of EX-GROUP-VALIDATE',
      async (name) => {
        const answer = validateAnswer(name);

        const res = await send(app, 'GET', validatePath(answer), await headersFor(validateCaller(answer)));

        expect(res.statusCode).toBe(503);
        expect(json(res)).toMatchObject({ error: ERRORS.serverError });
      },
    );

    // Oracle (own ACF, POST of the same texts as a JSON body): start-up scans only the url and form scopes, so these
    // validations reach deserializeJSON as sent rather than re-serialized, and their errors iterate in another order.
    it('answers ad hoc validations posted in a JSON body in the order their unscanned text gives', async () => {
      const answer = validateAnswer('adhoc:key-order-12');

      const res = await app.inject({
        method: 'POST',
        url: `${API}/validate`,
        headers: { host: HOST, ...(await headersFor(S2)), 'content-type': 'application/json' },
        payload: JSON.stringify({ entityname: 'group', data: answer.data, validations: answer.validations }),
      });

      expect(res.statusCode).toBe(200);
      expect(json(res).method).toBe('validate');
      expect(Object.keys(dataOf(res))).toEqual(['bravo', 'whiskey', 'victor', 'echo', 'delta', 'alpha', 'charlie', 'foxtrot', 'zeta', 'yankee', 'mike', 'xray']);
    });

    // Oracle (own ACF): isValid('numeric') reads Java's double grammar without a type suffix; urlDecode turns a plain '+' into a space.
    it('checks dataType numeric as Masa 7.6.1 does for signed exponents, Infinity, NaN and hex floats', async () => {
      const values: Record<string, string> = {
        a: '0x1p3', b: '+NaN', c: '1e+3', d: '1E3', e: '-Infinity', f: '1e%2B3', h1: '0x.8p1', h2: '0X1P3', h3: '0x1.8p1', h4: '-0x1p3',
        h5: '0xp3', h6: '0x1p', h7: '0x1p3d', h8: 'Infinityd', h9: '0x1p-2', h10: '%2B0x1p%2B2', h11: '0x1.p1', h12: '0x.p1', h13: '1.0e3',
        h14: '1e3f', h15: 'NaN ', h16: '1e%2B309', h17: '-.5e-3', h18: '0x1P3', h19: '0Xa.Bp0',
      };
      const validations = { properties: Object.fromEntries(Object.keys(values).map((key) => [key, [{ required: true }, { dataType: 'numeric' }]])) };
      const path = `${API}/validate?entityname=group&data=${encodeURIComponent(JSON.stringify(values))}&validations=${encodeURIComponent(JSON.stringify(validations))}`;

      const res = await send(app, 'GET', path, await headersFor(S2));

      const invalid = ['c', 'h5', 'h6', 'h7', 'h8', 'h12', 'h14'];
      expect(json(res)).toEqual({ apiversion: 'v1', method: 'validate', data: Object.fromEntries(invalid.map((key) => [key, `The property named '${key}' is not valid`])) });
    });

    // isPostedFile reads the scanned form after processRequest appended params to it, url values included (jsonApiUtility.cfc:845).
    it.each<[string, string, Record<string, string> | undefined]>([
      ['a form value', '', { photo: 'x.upload' }],
      ['a padded form value', '', { photo: ' x.upload ' }],
      ['a url value', '&photo=x.upload', undefined],
    ])("treats a complex regex-checked property named by %s ending .upload as a posted file, halting at the ACF regex check", async (_label, query, form) => {
      const path = `${API}/validate?entityname=group&data=${encodeURIComponent('{"photo":[1]}')}&validations=${encodeURIComponent('{"properties":{"photo":[{"required":true},{"regex":"1"}]}}')}${query}`;

      const res = await send(app, form === undefined ? 'GET' : 'POST', path, await headersFor(S2), form);

      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ error: ERRORS.serverError });
    });

  });

  it('refuses validating a group to a caller without the Users module', async () => {
    const query = new URLSearchParams({ entityname: 'group', data: JSON.stringify({ entityname: 'group', userid: ADMIN_GROUP }) });

    const res = await send(app, 'GET', `${API}/validate?${query.toString()}`, await headersFor(MEMBER));

    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual(legacyError('validate', ERRORS.authorization));
  });

  it.each([
    ['MURA_ADMINSSL', 'maybe', 'must be a CFML boolean'],
    ['MURA_PORT', '70000', 'must be blank or a TCP port'],
    ['MURA_CONTEXT', 'masa', 'must be blank or a path from / or \\'],
    ['MURA_ADMINDOMAIN', 'admin.example.test/x', 'must be a comma list of host names'],
    ['MURA_APPRELOADKEY', 're load', 'must not contain whitespace or control characters'],
    ['MURA_STRICTHTML', 'maybe', 'must be a CFML boolean'],
    ['MURA_SESSIONBASEDLOCKDOWN', 'maybe', 'must be a CFML boolean'],
    ['MURA_SESSIONTIMEOUT', 'soon', 'must be blank or a number of minutes'],
    ['MURA_SESSIONTIMEOUT', 'Infinity', 'must be blank or a number of minutes'],
  ])('refuses to register with a malformed %s as an EnvValidationError naming it', async (name, value, message) => {
    for (const [setting, valid] of Object.entries(VALID_MURA_ENV)) vi.stubEnv(setting, valid);
    vi.stubEnv(name, value);
    try {
      const failure = registerLegacyApiRoutes(app, { ...deps, legacy: undefined });

      await expect(failure).rejects.toBeInstanceOf(EnvValidationError);
      await expect(failure).rejects.toMatchObject({ issues: [`${name}: ${message}`] });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('JSON API path forms', () => {
  const origin = 'http://localhost';
  const db = createRecordingDb({
    responses: [
      [/SELECT tenant_id, site_id FROM identity\.tenant_registry WHERE NOT deleted ORDER BY site_id/, () => MEMORY_REGISTRY.map(({ site_id, tenant_id }) => ({ site_id, tenant_id }))],
      [REGISTRY_ENTRIES, () => MEMORY_REGISTRY],
      [/FROM identity\.tenant_registry WHERE tenant_id = \$1/, (_sql, values) => MEMORY_REGISTRY.filter((row) => row.tenant_id === values[0])],
    ],
  });
  const behindContext: LegacyApiSettings = { ...SETTINGS, context: '/masa' };
  const apps: Partial<Record<'root' | 'context', FastifyInstance>> = {};

  beforeAll(async () => {
    const deps = (legacy: LegacyApiSettings): LegacyApiRouteDeps =>
      routeDeps(db, createIdentityRepository({ clock: CLOCK }), recordingPeople(), recordingFetch().fetch, legacy);
    apps.root = await buildApp(deps(SETTINGS), quietLogger(), legacyApiPrefixes());
    apps.context = await buildApp(deps(behindContext), quietLogger(), legacyApiPrefixes(behindContext.context));
  });

  afterAll(async () => {
    await Promise.all(Object.values(apps).map((app) => app?.opt2.shutdown()));
  });

  it.each<[string, 'root' | 'context', string, string]>([
    ['behind /index.cfm', 'root', '/index.cfm/_api/json/v1/default/group/properties', 'groupProperties'],
    ['in upper case', 'root', '/_API/JSON/V1/default/group/properties', 'groupProperties'],
    ['behind an upper-case /INDEX.CFM', 'root', '/INDEX.CFM/_api/json/v1/default/group/properties', 'groupProperties'],
    ['with a trailing slash', 'root', '/_api/json/v1/default/group/properties/', 'groupProperties'],
    ['as the bare family path with method parameters', 'root', '/_api/json/v1?method=findProperties&entityname=group', 'groupProperties'],
    ['as the bare family path behind /index.cfm', 'root', '/index.cfm/_api/json/v1?method=findProperties&entityname=group', 'groupProperties'],
    ['as the bare family path alone', 'root', '/_api/json/v1', 'unregisteredPathSite'],
    ['as a segment only starting with the family prefix', 'root', '/_api/json/v1x', 'unregisteredPathSite'],
    ['in the ajax family behind /index.cfm', 'root', '/index.cfm/_api/ajax/v1/default/group/properties', 'groupProperties'],
    ['in the ajax family in upper case', 'root', '/_API/AJAX/V1/default/group/properties', 'groupProperties'],
    ['in the rest family behind /index.cfm', 'root', '/index.cfm/_api/rest/v1/default/group/properties', 'restNoCredentials'],
    ['in the rest family in upper case', 'root', '/_API/REST/V1/default/group/properties', 'restNoCredentials'],
    ['behind the configured context', 'context', '/masa/_api/json/v1/default/group/new', 'findNewDenied'],
    ['behind the configured context and /index.cfm', 'context', '/masa/index.cfm/_api/rest/v1/default/group/properties', 'restNoCredentials'],
    ['in the rest family with an encoded oauth2 segment', 'root', '/_api/rest/v1/default/o%61uth2', 'restOauth2NoCredentials'],
    ['in the rest family behind /index.cfm with an encoded oauth2 segment', 'root', '/index.cfm/_api/rest/v1/default/o%61uth2', 'restOauth2NoCredentials'],
    ['behind the configured context and /index.cfm with an encoded oauth2 segment', 'context', '/masa/index.cfm/_api/rest/v1/default/o%61uth2', 'restOauth2NoCredentials'],
  ])('answers the JSON API %s as the oracle request and Masa 7.6.1 do: status, body, ETag and Origin echo', async (_label, appName, alias, name) => {
    const app = apps[appName];
    if (app === undefined) throw new Error(`no ${appName} app`);
    const answer = oracle(name);
    const headers = { ...(await headersFor()), origin };

    const canonical = await send(app, 'GET', oraclePath(answer), headers);
    const res = await app.inject({ method: 'GET', url: alias, headers: { host: HOST, ...headers } });

    // An alias answers as the contract operation of the canonical path it stands for.
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: oraclePath(answer), status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    expectOracleAnswer(canonical, answer);
    expectOracleAnswer(res, answer);
    expect(res.body).toBe(canonical.body);
    expect(res.headers.etag).toBe(canonical.headers.etag);
    for (const each of [canonical, res]) {
      expect(each.headers['access-control-allow-origin']).toBe(origin);
      expect(each.headers['access-control-allow-credentials']).toBe('true');
    }
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('REST token endpoint path forms against PostgreSQL', () => {
  /** A site identity does not register, so logging its user in raises nothing. */
  const GHOST = 'ghost';
  const USER = 'A0000000-0000-0000-0000000000000010';
  const CLIENT = 'C0000000-0000-0000-0000000000000010';
  const GRANT = { grant_type: 'client_credentials', client_id: CLIENT, client_secret: 'cc-secret' };
  let handle: ThrowawaySchema | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const { schema } = handle;
    const db = handle.app;
    const repo = createIdentityRepository({ clock: CLOCK, schema });
    await ensureUnitGates(db, IDENTITY_UNITS);
    await withMetadata(db, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await withMetadata(db, (tx) =>
      tx.query(
        `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $1, $1, $2, $2, 1, $3)',
        [SITE, tenantIdForSite(SITE), NOW],
      ),
    );
    // The token endpoint finds a client only in the API site's tenant.
    await withGatedTenant(db, tenantIdForSite(SITE), async (tx) => {
      await repo.insertAccount(tx, { userid: USER, username: 'ghost-user', type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: GHOST, remoteid: '', tablist: '' });
      await repo.upsertPersonContact(tx, { user_id: USER, site_id: GHOST, subtype: 'Default', aggregate_version: 1, fname: 'Ghost', lname: 'User', email: 'ghost@example.test', company: '' });
      await repo.insertOAuthClient(tx, {
        clientid: CLIENT, clientsecret: GRANT.client_secret, siteid: SITE, granttype: 'client_credentials', userid: USER, name: 'cc', created: NOW,
        lastupdate: NOW, description: null, redirecturl: null, lastupdatebidy: null, lastupdateby: null,
      });
    });
    app = await buildApp(routeDeps(db, repo, recordingPeople(), recordingFetch().fetch, SETTINGS));
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  /** A form-posted grant on `url`, checked against the contract operation of `canonical`. */
  async function grant(url: string, canonical: string): Promise<Answer> {
    if (app === undefined) throw new Error('PostgreSQL is not available');
    const res = await app.inject({ method: 'POST', url, headers: { host: HOST, ...(await headersFor()), ...FORM_BODY }, payload: new URLSearchParams(GRANT).toString() });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: canonical, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  /** The key the gateway computes for a grant on `url`. */
  function keyOf(url: string): string {
    return scannedRouteKey({ method: 'POST', path: url, url, query: {}, form: GRANT, headers: FORM_BODY }, { appReloadKey: SETTINGS.appReloadKey }).result.key;
  }

  /** Status, challenge, content type and body, with the token values a grant generates afresh masked. */
  function withoutFreshTokens(res: Answer): Record<string, unknown> {
    const parsed = json(res);
    const struct = (parsed.data ?? parsed) as Record<string, unknown>;
    let body = res.body;
    for (const key of ['access_token', 'refresh_token']) {
      const value = struct[key];
      if (typeof value === 'string') body = body.replaceAll(value, `<${key}>`);
    }
    return { status: res.statusCode, wwwAuthenticate: res.headers['www-authenticate'], contentType: res.headers['content-type'], body };
  }

  it.each<[string, string, string, string, number, Record<string, unknown>]>([
    ['an encoded oauth2, answering the bare token struct', `/_api/rest/v1/${SITE}/o%61uth2`, `/_api/rest/v1/${SITE}/oauth2`, 'rest:oauth2', 200, { token_type: 'Bearer', expires_in: 3600 }],
    ['an encoded oauth2 behind /index.cfm', `/index.cfm/_api/rest/v1/${SITE}/o%61uth2`, `/_api/rest/v1/${SITE}/oauth2`, 'rest:oauth2', 200, { token_type: 'Bearer', expires_in: 3600 }],
    ['an encoded oauth, whose envelope of a registered site raises', `/_api/rest/v1/${SITE}/o%61uth`, `/_api/rest/v1/${SITE}/oauth`, 'rest:oauth', 500, { error: ERRORS.serverError }],
    ['an encoded oauth behind /index.cfm', `/index.cfm/_api/rest/v1/${SITE}/o%61uth`, `/_api/rest/v1/${SITE}/oauth`, 'rest:oauth', 500, { error: ERRORS.serverError }],
  ])('answers a client_credentials grant on %s exactly as on the decoded bare path, under the same route key', async (_label, alias, bare, key, status, shape) => {
    const aliased = await grant(alias, bare);
    const direct = await grant(bare, bare);

    expect([keyOf(alias), keyOf(bare)]).toEqual([key, key]);
    expect(aliased.statusCode).toBe(status);
    expect(json(aliased)).toMatchObject(shape);
    for (const res of [aliased, direct]) expect(res.headers.etag).toBe(etag(res.body));
    expect(withoutFreshTokens(aliased)).toEqual(withoutFreshTokens(direct));
  });
});

describe('JSON API URLs from the MURA environment', () => {
  const people = recordingPeople();
  const db = createRecordingDb({
    responses: [[/SELECT tenant_id, site_id FROM identity\.tenant_registry WHERE NOT deleted ORDER BY site_id/, () => [{ site_id: SITE, tenant_id: tenantIdForSite(SITE) }]]],
  });
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = {
      MURA_ADMINSSL: 'yes',
      MURA_PORT: '8443',
      MURA_CONTEXT: '/masa/',
      MURA_ADMINDOMAIN: 'admin.example.test,cms.example.test',
      MURA_APPRELOADKEY: 'reloadnow',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    try {
      app = await buildApp(routeDeps(db, createIdentityRepository({ clock: CLOCK }), people, recordingFetch().fetch));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
  });

  /** Injects a call from `host`. */
  async function call(url: string, host: string, caller?: Caller): Promise<Answer> {
    return app.inject({ method: 'GET', url, headers: { ...(await headersFor(caller)), host } });
  }

  it('builds the endpoint with https, the configured port and context, and the admin path on the current admin domain', async () => {
    const offAdmin = await call(`${API}/group/new`, 'www.example.test:8080', S2);
    const onAdmin = await call(`${API}/group/new`, 'CMS.example.test:8080', S2);

    const links = (res: Answer): Record<string, string> => dataOf(res).links as Record<string, string>;
    expect(links(offAdmin).entities).toBe('https://www.example.test:8443/masa/index.cfm/_api/json/v1/default');
    // getCurrentAdminDomain() keeps the port of a host off the admin domains, and getAdminPath appends the configured port again.
    expect(links(offAdmin).edit).toMatch(/^https:\/\/www\.example\.test:8080:8443\/masa\/admin\/\?muraAction=cusers\.editgroup&siteid=default&userid=/);
    expect(links(onAdmin).edit).toMatch(/^https:\/\/CMS\.example\.test:8443\/masa\/admin\/\?muraAction=cusers\.editgroup&siteid=default&userid=/);
  });

  it("takes the request host's port when MURA_PORT is unset or a settings-template expression", async () => {
    for (const port of [undefined, '${cgi.SERVER_PORT}']) {
      for (const [name, value] of Object.entries({ ...VALID_MURA_ENV, MURA_PORT: port, MURA_CONTEXT: '{{context}}' })) vi.stubEnv(name, value);
      let local: FastifyInstance | undefined;
      try {
        local = await buildApp(routeDeps(db, createIdentityRepository({ clock: CLOCK }), people, recordingFetch().fetch));
        const res = await local.inject({ method: 'GET', url: `${API}/group/properties`, headers: { ...(await headersFor()), host: 'www.example.test:9090' } });

        expect((dataOf(res).links as Record<string, string>).self).toBe('http://www.example.test:9090/index.cfm/_api/json/v1/default/group/properties');
      } finally {
        vi.unstubAllEnvs();
        await local?.opt2.shutdown();
      }
    }
  });

  it('answers the configured application reload key with the legacy 404 envelope', async () => {
    const res = await call(`${API}/group/properties?reloadnow`, 'www.example.test');

    expect(res.statusCode).toBe(404);
    expect(json(res)).toMatchObject({ error: ERRORS.invalidMethodCall });
  });
});

describe('JSON API unhandled-exception log', () => {
  const captured = capturingLogger();
  const raw = 'connect ECONNREFUSED 10.0.0.7:443 for jane.doe@example.test with password=Hunter2-probe';
  const people: ServiceClient = {
    request: () => Promise.reject(Object.assign(new Error(raw), { code: 'ECONNREFUSED', syscall: 'connect' })),
    close: () => Promise.resolve(),
  };
  const db = createRecordingDb({
    responses: [[/FROM identity\.tenant_registry WHERE NOT deleted ORDER BY site_id/, () => [{ site_id: SITE, tenant_id: tenantIdForSite(SITE) }]]],
  });
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(routeDeps(db, createIdentityRepository({ clock: CLOCK }), people, recordingFetch().fetch, SETTINGS), captured.logger);
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
  });

  it('answers the unhandled-exception 500 and hands the logger only the serialized error, logged once under the request id', async () => {
    const res = await send(app, 'GET', `${API}/findCurrentUser`, { ...(await headersFor()), 'x-request-id': 'legacy-api-log-probe' });

    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual(legacyError('findCurrentUser', ERRORS.serverError));
    const record = { type: 'Error', message: 'connect ECONNREFUSED', stack: expect.stringMatching(/^Error: connect ECONNREFUSED(?:\n {4}at \S.*)+$/) };
    expect(captured.calls.filter(([, message]) => message === 'unhandled JSON API error')).toEqual([[{ error: record }, 'unhandled JSON API error']]);
    const lines = captured.lines.map((text) => JSON.parse(text) as Record<string, unknown>).filter((line) => line.message === 'unhandled JSON API error');
    expect(lines).toEqual([expect.objectContaining({ severity: 'ERROR', requestId: 'legacy-api-log-probe', error: record })]);
    expect(validateLogRecord(lines[0])).toStrictEqual({ valid: true, errors: [] });
    for (const text of [raw, 'jane.doe@example.test', 'password=', 'Hunter2-probe']) {
      expect(inspect(captured.calls, { depth: null })).not.toContain(text);
      expect(captured.lines.join('')).not.toContain(text);
    }
  });
});

describe('SQL Server LIKE matcher of group feeds', () => {
  it.each<[string, string, string, boolean]>([
    ['an empty pattern', '', '', true],
    ['an empty pattern', '', 'a', false],
    ['an all-% pattern', '%%%', '', true],
    ['_ as one UTF-16 code unit', '_', '\u{1F600}', false],
    ['_ as one UTF-16 code unit', '__', '\u{1F600}', true],
    ['a negated class', '[^a-c]x', 'dx', true],
    ['a negated class', '[^a-c]x', 'Ax', false],
    ['the whole value', 'abc', 'abcd', false],
    ['the whole value', 'bcd', 'abcd', false],
    ['the whole value', '%b', 'ab\n', false],
  ])('matches %s: %j against %j is %s', (_label, pattern, value, expected) => {
    expect(likeMatcher(pattern)(value)).toBe(expected);
  });
});
