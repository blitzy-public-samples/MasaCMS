/** The JSON API routes against Masa 7.6.1 oracle answers over an in-memory registry: headers, CORS, route ownership, path forms, the MURA settings, identity's named methods without stored data, ad hoc validate rules, the error log and the LIKE matcher. */
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { etag } from '@opt2/platform/legacy-compat';
import { validateLogRecord } from '@opt2/platform/logging';
import { EnvValidationError, SERVICE_CALL_TIMEOUT_MS, type FastifyInstance, type ServiceClient, type ServiceResponse } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { createIdentityRepository } from '../../src/repo/repository.js';
import { legacyApiPrefixes, likeMatcher, registerLegacyApiRoutes, type LegacyApiRouteDeps, type LegacyApiSettings } from '../../src/routes/legacy-api.js';
import {
  ADMIN_GROUP,
  API,
  CLOCK,
  EDITOR_GROUP,
  ERRORS,
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
const REGISTRY_ENTRIES = /^SELECT site_id, tenant_id, .+ FROM identity\.tenant_registry ORDER BY site_id$/;

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
      [/SELECT tenant_id, site_id FROM identity\.tenant_registry ORDER BY site_id/, () => registryRows(MEMORY_REGISTRY.map(({ site_id, tenant_id }) => ({ site_id, tenant_id })))],
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
    ['a save that uploads a photo', 'POST', `${API}/group/${EDITOR_GROUP}`, {}, { groupname: 'Editor', newFile: 'photo.png' }],
    ['a save that removes the photo', 'POST', `${API}/group/${EDITOR_GROUP}`, {}, { groupname: 'Editor', removePhotoFile: 'true' }],
    ['a save with extended data', 'POST', `${API}/group/${EDITOR_GROUP}`, {}, { groupname: 'Editor', extendSetID: 'X' }],
    ['an application reload', 'GET', `${API}/group/properties?appreload`, {}, undefined],
  ])('answers %s, which identity does not serve, with the legacy 404 envelope', async (_label, method, url, extra, form) => {
    const res = await send(app, method, url, { ...(await headersFor(S2)), ...extra }, form);

    expect(res.statusCode).toBe(404);
    expect(json(res)).toMatchObject({ apiversion: 'v1', error: ERRORS.invalidMethodCall });
    expect(res.headers.etag).toBe(etag(res.body));
  });

  it.each([
    ['a registered path site', `/_api/json/v1/${SITE_B}/group/properties`],
    ['a registered url siteid', `${API}/group/properties?siteid=${SITE_B}`],
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

  it("fails closed with the legacy 503 on findCurrentUser's ishuman field, which renders a CFML display object", async () => {
    people.answer = { status: 200, headers: {}, body: { data: { userid: 'U1' } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser?ishuman=1`, await headersFor());

    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({ error: ERRORS.serverError });
  });

  it("answers people's 503 to findCurrentUser with the legacy 503", async () => {
    people.answer = { status: 503, headers: {}, body: legacyError('invalid', ERRORS.serverError) };

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor());

    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({ error: ERRORS.serverError });
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
      [/SELECT tenant_id, site_id FROM identity\.tenant_registry ORDER BY site_id/, () => MEMORY_REGISTRY.map(({ site_id, tenant_id }) => ({ site_id, tenant_id }))],
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

describe('JSON API URLs from the MURA environment', () => {
  const people = recordingPeople();
  const db = createRecordingDb({
    responses: [[/SELECT tenant_id, site_id FROM identity\.tenant_registry ORDER BY site_id/, () => [{ site_id: SITE, tenant_id: tenantIdForSite(SITE) }]]],
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
    responses: [[/FROM identity\.tenant_registry ORDER BY site_id/, () => [{ site_id: SITE, tenant_id: tenantIdForSite(SITE) }]]],
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
