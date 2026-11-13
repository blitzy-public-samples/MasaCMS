/** The JSON API routes against Masa 7.6.1 oracle answers, over an in-memory registry and a throwaway `identity` schema: headers, CORS, route ownership, identity's named methods, group operations and access, saves, and REST credential delegation. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, etag } from '@opt2/platform/legacy-compat';
import { createLogger, type Logger } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import {
  EnvValidationError,
  createService,
  loadEnv,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, tenantIdForSite, withMetadata, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createCapturingPublisher,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { issueTokens } from '../../src/domain/csrf.js';
import { EN_GROUP_MESSAGES } from '../../src/domain/groups.js';
import { DEFAULT_LOGIN_SETTINGS, type LoginDeps } from '../../src/domain/login.js';
import { ensureSession, type SessionDeps } from '../../src/domain/sessions.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import type { BridgeRelay } from '../../src/legacy/bridge-relay.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';
import { registerLegacyApiRoutes, type LegacyApiRouteDeps, type LegacyApiSettings } from '../../src/routes/legacy-api.js';
import { createRecordingDb } from '../helpers/memory-repo.js';
import { TEST_PASSWORDS } from '../helpers/rows.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One legacy answer of `test/fixtures/legacy/json-api-answers.json`. */
interface OracleAnswer {
  caller: 'anonymous' | 'admin (S2)';
  request: string;
  status: number;
  contentType: string;
  hasEtag: boolean;
  body: string;
  wwwAuthenticate?: string;
  deletedCookies?: string[];
}

/** A response as the assertions read it. */
interface Answer {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

/** The verified caller a user token carries. */
interface Caller {
  sub: string;
  roles: readonly string[];
  sid?: string;
  site?: string;
}

/** A people client that records each call and answers with `answer`. */
type RecordingPeople = ServiceClient & { calls: ServiceRequest[]; answer: ServiceResponse };

/** validateEmail's outbound call, recording each request and answering with `reply`. */
interface RecordingFetch {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; method: string | undefined }>;
  reply: () => Promise<Response>;
}

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const ORACLE = (
  JSON.parse(readFileSync(new URL('../fixtures/legacy/json-api-answers.json', import.meta.url), 'utf8')) as { answers: Record<string, OracleAnswer> }
).answers;
const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const CLOCK = fixedClock(NOW);
const HOST = 'localhost:8080';
const SITE = 'default';
const SITE_B = 'tenant-b';
const SITE_C = 'tenant-c';
const API = `/_api/json/v1/${SITE}`;
const ENDPOINT_C = `http://${HOST}/index.cfm/_api/json/v1/${SITE_C}`;
const ADMIN_GROUP = '3BE10D43-C960-A7E5-0FB807B791D31787';
const EDITOR_GROUP = '3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D';
const SECRET = 'K0000000-0000-0000-0000000000000003';
const USERS_MODULE = 'm:008';
const SITE_MANAGER = 'm:000';
const FORM_BODY = { 'content-type': 'application/x-www-form-urlencoded' };
const LEGACY_JSON_TYPE = 'application/json;charset=utf-8';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const SETTINGS: LegacyApiSettings = Object.freeze({ adminSSL: false, context: '', appReloadKey: 'appreload', adminDomain: '' });
const FAST_LOGIN: LoginDeps['settings'] = { password: { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: 4 }, strikes: DEFAULT_LOGIN_SETTINGS.strikes };
const RELAY: BridgeRelay = { markUsed: () => Promise.resolve({ applied: true }) };
/** Well-formed values of every `MURA_<KEY>` setting the routes read. */
const VALID_MURA_ENV = { MURA_ADMINSSL: 'false', MURA_PORT: '', MURA_CONTEXT: '', MURA_ADMINDOMAIN: '', MURA_APPRELOADKEY: 'appreload' };
const noSleep = (): Promise<void> => Promise.resolve();

const S2: Caller = { sub: 'A0000000-0000-0000-0000000000000001', roles: [Roles.s2, Roles.systemUser] };
const SITE_ADMIN: Caller = { sub: 'A0000000-0000-0000-0000000000000002', roles: [Roles.siteAdmin, Roles.systemUser] };
const USERS_EDITOR: Caller = { sub: 'A0000000-0000-0000-0000000000000003', roles: [Roles.systemUser, USERS_MODULE] };
const MODULE_ONLY: Caller = { sub: 'A0000000-0000-0000-0000000000000004', roles: [USERS_MODULE] };
const MEMBER: Caller = { sub: 'A0000000-0000-0000-0000000000000005', roles: [Roles.member] };
const SITE_EDITOR: Caller = { sub: 'A0000000-0000-0000-0000000000000006', roles: [Roles.systemUser, SITE_MANAGER] };

const ERRORS = {
  authorization: { message: 'Insufficient Account Permissions', code: 'invalid_request' },
  invalidMethodCall: { message: 'Invalid method call', code: 'invalid_request' },
  invalidParameters: { message: 'Invalid parameters', code: 'invalid_request' },
  invalidTokens: { message: 'Invalid CSRF tokens', code: 'invalid_request' },
  serverError: { message: 'Unhandled Exception', code: 'server_error' },
} as const;

/** The legacy error envelope of `method`. */
function legacyError(method: string, error: (typeof ERRORS)[keyof typeof ERRORS]): Record<string, unknown> {
  return { apiversion: 'v1', method, error };
}

/** Anonymous oracle answers whose request reads data beyond the registry; every admin answer does too. */
const ANONYMOUS_DATA_ANSWERS = new Set(['findOneDenied', 'restOauthUnknownClient', 'restTokenInfoUnknownToken']);
/** Oracle answers carrying an id the legacy bean generated, which the comparison takes from the response. */
const FRESH_ID_ANSWERS = new Set(['findNew', 'findNewFields', 'findNewPhotoExt', 'findOneUnknown']);
/** Oracle answers whose self link ACF orders differently from request to request, compared as a set of query pairs. */
const UNORDERED_SELF_ANSWERS = new Set(['findAllManyParams']);
/** Oracle answers with values the legacy install wrote, left out of the comparison: its time and its installing admin. */
const INSTALL_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['findOneAllFields', ['created', 'lastupdate', 'passwordcreated', 'lastupdateby', 'lastupdatebyid']],
]);
const MEMORY_ANSWERS = Object.keys(ORACLE).filter((name) => ORACLE[name]?.caller === 'anonymous' && !ANONYMOUS_DATA_ANSWERS.has(name));
const DATA_ANSWERS = Object.keys(ORACLE).filter((name) => !MEMORY_ANSWERS.includes(name));

function oracle(name: string): OracleAnswer {
  const answer = ORACLE[name];
  if (answer === undefined) throw new Error(`no oracle answer ${name}`);
  return answer;
}

/** The request path of an oracle answer. */
function oraclePath(answer: OracleAnswer): string {
  return answer.request.replace(/^GET /, '');
}

function quietLogger(): Logger {
  return createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
}

function recordingPeople(): RecordingPeople {
  const people: RecordingPeople = {
    calls: [],
    answer: { status: 200, headers: {}, body: { apiversion: 'v1', method: 'findOne', data: {} } },
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      people.calls.push(req);
      return Promise.resolve(people.answer as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };
  return people;
}

function recordingFetch(): RecordingFetch {
  const outbound: RecordingFetch = {
    calls: [],
    reply: () => Promise.reject(new TypeError('fetch failed')),
    fetch: (input, init) => {
      outbound.calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, method: init?.method });
      return outbound.reply();
    },
  };
  return outbound;
}

/** `Set-Cookie` values of a response without their expiry, as the oracle fixture records them. */
function cookiesWithoutExpiry(res: Answer): string[] {
  const cookies = res.headers['set-cookie'];
  const values = Array.isArray(cookies) ? cookies : cookies === undefined ? [] : [String(cookies)];
  return values.map((cookie) => cookie.replace(/;expires=[^;]*/i, ''));
}

/** The parsed envelope without the `data` keys in `omit`. */
function envelopeWithout(body: string, omit: readonly string[]): unknown {
  const envelope = JSON.parse(body) as { data?: Record<string, unknown> };
  for (const key of omit) delete envelope.data?.[key];
  return envelope;
}

/** The body with its `data.links.self` query pairs sorted. */
function withSortedSelf(body: string): string {
  const envelope = JSON.parse(body) as { data: { links: { self: string } } };
  const [base, query = ''] = envelope.data.links.self.split('?');
  envelope.data.links.self = `${base ?? ''}?${query.split('&').sort().join('&')}`;
  return JSON.stringify(envelope);
}

/** Asserts that `res` answers as the oracle did: status, content type, parsed body less `omit`, ETag rule and `WWW-Authenticate`. */
function expectOracleAnswer(res: Answer, answer: OracleAnswer, body = res.body, omit: readonly string[] = []): void {
  expect(res.statusCode).toBe(answer.status);
  expect(res.headers['content-type']).toBe(answer.contentType);
  expect(envelopeWithout(body, omit)).toEqual(envelopeWithout(answer.body, omit));
  expect(res.headers.etag).toBe(answer.hasEtag ? etag(res.body) : undefined);
  expect(res.headers['www-authenticate']).toBe(answer.wwwAuthenticate);
  if (answer.deletedCookies !== undefined) expect(cookiesWithoutExpiry(res)).toEqual(answer.deletedCookies);
}

/** The response body with the bean id legacy generated in place of the one identity generated. */
function withOracleId(res: Answer, answer: OracleAnswer): string {
  const ours = (JSON.parse(res.body) as { data: { userid: string } }).data.userid;
  const theirs = (JSON.parse(answer.body) as { data: { userid: string } }).data.userid;
  return res.body.replaceAll(ours, theirs);
}

let stateDir: string;
let gatewayToken: string;

/** Headers of a gateway-relayed call, with a user token for `caller` when given. */
async function headersFor(caller?: Caller): Promise<Record<string, string>> {
  const headers: Record<string, string> = { [INVOCATION_HEADER]: `Bearer ${gatewayToken}` };
  if (caller !== undefined) {
    headers.authorization = `Bearer ${await mintUserToken({ sub: caller.sub, sid: caller.sid, site: caller.site ?? SITE, roles: caller.roles })}`;
  }
  return headers;
}

/** Injects a call from host `localhost:8080`, form fields as a form post, and checks the answer against the contract. */
async function send(
  app: FastifyInstance,
  method: Method,
  url: string,
  headers: Record<string, string> = {},
  form?: Record<string, string>,
): Promise<Answer> {
  const res = await app.inject({
    method,
    url,
    headers: { host: HOST, ...headers, ...(form === undefined ? {} : FORM_BODY) },
    payload: form === undefined ? undefined : new URLSearchParams(form).toString(),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

function json(res: Answer): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

/** The `data` struct of an envelope answer. */
function dataOf(res: Answer): Record<string, unknown> {
  return json(res).data as Record<string, unknown>;
}

/** The group names of a list answer's items, in order. */
function namesOf(res: Answer): unknown[] {
  return (dataOf(res).items as Array<{ groupname: unknown }>).map((item) => item.groupname);
}

/** The JSON API route dependencies over `db`, with `legacy` settings or, when undefined, the `MURA_<KEY>` environment. */
function routeDeps(db: TenantDb, repo: IdentityRepository, client: ServiceClient, fetch: typeof globalThis.fetch, legacy?: LegacyApiSettings): LegacyApiRouteDeps {
  const sessions: SessionDeps = { db, repo, clock: CLOCK };
  const login: LoginDeps = { db, repo, clock: CLOCK, settings: FAST_LOGIN, sleep: noSleep };
  return {
    groups: {
      db,
      repo,
      events: createIdentityEvents(repo),
      clock: CLOCK,
      settings: { password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 }, hashAlgorithm: 'CFMX_COMPAT' },
      sleep: noSleep,
    },
    login,
    sessions,
    csrf: { db, repo, bridge: RELAY, clock: CLOCK, sleep: noSleep },
    rest: { oauth: { db, repo, clock: CLOCK }, login, sessions },
    client,
    db,
    fetch,
    ...(legacy === undefined ? {} : { legacy }),
  };
}

/** An identity service with only the JSON API routes registered. */
async function buildApp(deps: LegacyApiRouteDeps): Promise<FastifyInstance> {
  const app = await createService({
    name: 'identity',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8111',
      OPT2_SERVICE_NAME: 'identity',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('identity'),
    logger: quietLogger(),
  });
  await registerLegacyApiRoutes(app, deps);
  await app.ready();
  return app;
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-legacy-api-'));
  await writeTestSecrets(stateDir);
  gatewayToken = await mintServiceToken({ caller: 'gateway', audience: 'identity' });
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

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
      [/FROM identity\.tenant_registry ORDER BY site_id/, () => registryRows(MEMORY_REGISTRY.map(({ site_id, tenant_id }) => ({ site_id, tenant_id })))],
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

  it('declares GET, POST, PUT and DELETE of the json, ajax and rest families as the contract does: public, service transport, no hook site check', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/_api/') && route.method !== 'HEAD');
    const expected = new Map<string, unknown>();
    for (const [template, operations] of Object.entries(OPENAPI.paths)) {
      if (!template.startsWith('/_api/')) continue;
      for (const [method, operation] of Object.entries(operations)) {
        if (method === 'parameters') continue;
        const entry = { method: method.toUpperCase(), url: operation['x-opt2-fastify-path'], transport: operation['x-opt2-transport'], public: operation['x-opt2-public'], siteCheck: false };
        expected.set(JSON.stringify(entry), entry);
      }
    }
    expect(expected.size).toBe(12);
    expect(declared).toHaveLength(12);
    expect(declared).toEqual(expect.arrayContaining([...expected.values()]));
  });

  it.each(MEMORY_ANSWERS)('answers the oracle request %s as Masa 7.6.1 does', async (name) => {
    const answer = oracle(name);
    if (name === 'findCurrentUserAnonymous') {
      // People answers the user without the session's role lists, which identity adds.
      const user = Object.entries((JSON.parse(answer.body) as { data: Record<string, unknown> }).data).filter(
        ([key]) => !['memberships', 'membershipids', 'isloggedin'].includes(key),
      );
      people.answer = { status: 200, headers: {}, body: { apiversion: 'v1', method: 'findOne', data: Object.fromEntries(user) } };
    }
    if (name === 'validateEmail') {
      const fileContent = JSON.parse(answer.body) as string;
      outbound.reply = () => Promise.resolve(new Response(fileContent));
    }

    const res = await send(app, 'GET', oraclePath(answer), await headersFor());

    expectOracleAnswer(res, answer);
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
  ])('echoes the Origin of a registered site domain and its subdomains with credentials on %s', async (_label, url, status) => {
    for (const origin of ['http://localhost', 'https://www.localhost:8443']) {
      const res = await send(app, 'GET', url, { ...(await headersFor()), origin });

      expect(res.statusCode).toBe(status);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
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
    people.answer = { status: 200, headers: {}, body: { apiversion: 'v1', method: 'findOne', data: { userid: '', siteid: SITE } } };

    const anonymous = await send(app, 'GET', '/_api/json/v1/findCurrentUser', await headersFor());
    const otherSite = await send(app, 'GET', '/_api/json/v1/findCurrentUser', await headersFor({ ...S2, site: SITE_B }));

    expect(anonymous.statusCode).toBe(200);
    expect(people.calls.map((call) => call.path)).toEqual([`/_api/json/v1/${SITE}/user/new`]);
    expect(otherSite.statusCode).toBe(403);
  });

  it('refuses a REST method call without a session user as authorization with WWW-Authenticate Basic', async () => {
    const res = await send(app, 'GET', `/_api/rest/v1/${SITE}/group`, await headersFor());

    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual(legacyError('invalid', ERRORS.authorization));
    expect(res.headers['www-authenticate']).toBe('Basic');
  });

  it("reads the anonymous user from people's user findOne in the call's family, forwarding fields, expand and expanddepth", async () => {
    people.calls.length = 0;
    const addresses = [{ addressid: 'A1', isprimary: 1, latitude: 40.25 }];
    people.answer = { status: 200, headers: {}, body: { apiversion: 'v1', method: 'findOne', data: { userid: 'U1', fname: '', isnew: 1, score: 1.5, addresses } } };

    const res = await send(app, 'GET', `/_api/ajax/v1/${SITE}/findCurrentUser?fields=fname&expand=x&expanddepth=2`, await headersFor());

    expect(people.calls).toEqual([
      { service: 'people', method: 'GET', path: `/_api/ajax/v1/${SITE}/user/new`, query: { fields: 'fname', expand: 'x', expanddepth: '2' } },
    ]);
    expect(json(res)).toEqual({
      apiversion: 'v1',
      method: 'findCurrentUser',
      data: { userid: 'U1', fname: '', isnew: 1, score: 1.5, addresses, memberships: [], membershipids: [], isloggedin: false },
    });
  });

  it("re-emits people's error envelope under findCurrentUser with its status and WWW-Authenticate", async () => {
    people.answer = { status: 401, headers: { 'www-authenticate': 'Basic' }, body: legacyError('findOne', ERRORS.authorization) };

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor());

    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual(legacyError('findCurrentUser', ERRORS.authorization));
    expect(res.headers['www-authenticate']).toBe('Basic');
    expect(res.headers.etag).toBe(etag(res.body));
  });

  it("answers people's 503 with the legacy 503", async () => {
    people.answer = { status: 503, headers: {}, body: legacyError('invalid', ERRORS.serverError) };

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor());

    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({ error: ERRORS.serverError });
  });

  it.each<[string, ServiceResponse]>([
    ['a text body', { status: 200, headers: {}, body: 'not json' }],
    ['an error status without an error struct', { status: 404, headers: {}, body: { apiversion: 'v1' } }],
    ['data that is not a struct', { status: 200, headers: {}, body: { apiversion: 'v1', data: [1] } }],
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

  it.each([
    ['another entity', { entityname: 'content' }, {}],
    ['ad hoc validation rules', {}, { groupname: { required: true } }],
    ['a loadby bean', { bean: 'content', loadby: 'contentid' }, {}],
  ])('fails closed with the legacy 503 when validating %s', async (_label, data, validations) => {
    const query = new URLSearchParams({ entityname: 'group', data: JSON.stringify(data), validations: JSON.stringify(validations) });

    const res = await send(app, 'GET', `${API}/validate?${query.toString()}`, await headersFor());

    expect(res.statusCode).toBe(503);
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

describe('JSON API URLs from the MURA environment', () => {
  const people = recordingPeople();
  const db = createRecordingDb({
    responses: [[/FROM identity\.tenant_registry ORDER BY site_id/, () => [{ site_id: SITE, tenant_id: tenantIdForSite(SITE) }]]],
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

// --- Calls that read or write identity data ---

const available = await pgAvailable();

describe.skipIf(!available)('JSON API against PostgreSQL', () => {
  const people = recordingPeople();
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let app: FastifyInstance;
  let seq = 0;
  const ids = { userAccount: '', visible: '', supers: '', dormant: '', pictured: '', helpers: '' };

  function nextId(prefix: string): string {
    seq += 1;
    return `${prefix}0000000-0000-0000-${String(seq).padStart(16, '0')}`;
  }

  function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(site), fn);
  }

  async function registerSite(site: string): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $1, $1, $2, $2, 1, $3)',
        [site, tenantIdForSite(site), NOW],
      ),
    );
  }

  function groupInput(groupname: string, siteid: string, ispublic: 0 | 1, extra: Partial<GroupInput> = {}): GroupInput {
    return {
      groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
      website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic, siteid,
      subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
      remoteid: '', tags: '', tablist: '', ...extra,
    };
  }

  async function seedAccount(site: string, username: string, password?: string): Promise<string> {
    const userId = nextId('E');
    const stored = password === undefined ? undefined : await bcrypt.hash(password, (await bcrypt.genSalt(4)).replace(/^\$2b\$/, '$2a$'));
    await gated(site, async (tx) => {
      await repo.insertAccount(tx, { userid: userId, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: site, remoteid: '', tablist: '' });
      if (stored !== undefined) await repo.writeCredential(tx, userId, { password: stored, passwordcreated: NOW });
    });
    return userId;
  }

  /** `caller` in a new active session of `site` whose login-time role list and membership ids are given. */
  async function inSession(caller: Caller, site: string, roleList: string, membershipIds = ''): Promise<Caller> {
    const sid = `S-legacy-api-${nextId('S')}`;
    const snapshot = {
      userid: caller.sub, username: 'jsonapi', siteid: site, subtype: 'Default', password: null, fname: 'Json', lname: 'Api', email: null,
      remoteid: null, company: null, lastlogin: null, passwordcreated: null, roleList, membershipIds,
    };
    await gated(site, (tx) =>
      repo.insertSession(tx, { session_id: sid, csrf_secret: SECRET, mode: 'target-primary', state: 'active', user_id: caller.sub, site_id: site, login_snapshot: JSON.stringify(snapshot) }),
    );
    return { ...caller, sid, site };
  }

  function csrfFields(context: string, secret = SECRET): Record<string, string> {
    const { token, expires } = issueTokens({ csrfSecret: secret }, { context, clock: CLOCK });
    return { [CSRF_FIELD_TOKEN]: token, [CSRF_FIELD_EXPIRES]: expires };
  }

  function strikeOf(username: string): Promise<unknown> {
    return gated(SITE, (tx) => repo.readStrike(tx, username));
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const { schema } = handle;
    repo = createIdentityRepository({ clock: CLOCK, schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    createOutbox({ service: 'identity', db: handle.app, publisher: createCapturingPublisher(), logger: quietLogger(), clock: CLOCK, payloadValidators: identityPayloadValidators });
    for (const site of [SITE, SITE_B, SITE_C]) await registerSite(site);
    // The oracle's `default` site holds these two system groups and no member group.
    await gated(SITE, async (tx) => {
      await repo.insertGroup(tx, { ...groupInput('Admin', SITE, 0, { perm: 1 }), userid: ADMIN_GROUP }, null);
      await repo.insertGroup(tx, { ...groupInput('Editor', SITE, 0, { contactform: '0' }), userid: EDITOR_GROUP }, null);
    });
    ids.userAccount = await seedAccount(SITE, 'jsonapi-account');
    ids.visible = nextId('B');
    ids.supers = nextId('B');
    ids.dormant = nextId('B');
    ids.pictured = nextId('B');
    ids.helpers = nextId('B');
    await gated(SITE_B, async (tx) => {
      await repo.insertGroup(tx, { ...groupInput('Visible', SITE_B, 1, { email: 'b@example.test' }), userid: ids.visible }, null);
      await repo.insertGroup(tx, { ...groupInput('Supers', SITE_B, 0, { s2: 1, email: 'c@example.test' }), userid: ids.supers }, null);
      await repo.insertGroup(tx, { ...groupInput('Dormant', SITE_B, 1, { inactive: 1, email: 'a@example.test' }), userid: ids.dormant }, null);
      await repo.insertGroup(tx, { ...groupInput('Pictured', SITE_B, 0, { photofileid: 'F0000000-0000-0000-0000000000000001' }), userid: ids.pictured }, null);
    });
    await gated(SITE_C, (tx) => repo.insertGroup(tx, { ...groupInput('Helpers', SITE_C, 1, { email: 'helpers@example.test' }), userid: ids.helpers }, null));
    app = await buildApp(routeDeps(handle.app, repo, people, recordingFetch().fetch, SETTINGS));
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  it.each(DATA_ANSWERS)('answers the oracle request %s as Masa 7.6.1 does', async (name) => {
    const answer = oracle(name);
    const caller = answer.caller === 'anonymous' ? undefined : S2;

    const res = await send(app, 'GET', oraclePath(answer), await headersFor(caller));

    const body = FRESH_ID_ANSWERS.has(name) ? withOracleId(res, answer) : res.body;
    const unordered = UNORDERED_SELF_ANSWERS.has(name);
    const expected = unordered ? { ...answer, body: withSortedSelf(answer.body) } : answer;

    expectOracleAnswer(res, expected, unordered ? withSortedSelf(body) : body, INSTALL_FIELDS.get(name));
  });

  it.each([
    ['findAll', `${API}/group`],
    ['findNew', `${API}/group/new`],
    ['findQuery', `${API}/group?groupname=Admin`],
    ['findMany', `${API}/group?id=${ADMIN_GROUP},${EDITOR_GROUP}`],
    ['findOne', `${API}/group/${ADMIN_GROUP}`],
  ])('serves %s to S2, site admins and Users-module grants, and refuses anonymous, member and editor callers as authorization', async (operation, url) => {
    for (const caller of [S2, SITE_ADMIN, MODULE_ONLY]) {
      const res = await send(app, 'GET', url, await headersFor(caller));
      expect(res.statusCode).toBe(200);
      expect(json(res).method).toBe(operation);
    }
    for (const caller of [undefined, MEMBER, SITE_EDITOR]) {
      const res = await send(app, 'GET', url, await headersFor(caller));
      expect(res.statusCode).toBe(401);
      expect(json(res)).toEqual(legacyError(operation, ERRORS.authorization));
    }
  });

  it('links a stored group to its cUsers edit page only for a logged-in system user holding the Users module', async () => {
    const editor = await send(app, 'GET', `${API}/group/${ADMIN_GROUP}`, await headersFor(USERS_EDITOR));
    const moduleOnly = await send(app, 'GET', `${API}/group/${ADMIN_GROUP}`, await headersFor(MODULE_ONLY));

    expect((dataOf(editor).links as Record<string, string>).edit).toBe(`http://${HOST}/admin/?muraAction=cusers.editgroup&siteid=default&userid=${ADMIN_GROUP}`);
    expect(dataOf(moduleOnly).links).not.toHaveProperty('edit');
  });

  it.each([
    ['a user record', SITE, () => `${API}/group/${ids.userAccount}`],
    ['the ishuman field', SITE, () => `${API}/group/${ADMIN_GROUP}?ishuman=1`],
    ['extended data fields', SITE, () => `${API}/group/${ADMIN_GROUP}?fields=groupname,extendeddata`],
    ["a photo's file extension", SITE_B, () => `/_api/json/v1/${SITE_B}/group/${ids.pictured}?fields=photofileext`],
  ])('fails closed with the legacy 503 on a findOne of %s', async (_label, site, url) => {
    const res = await send(app, 'GET', url(), await headersFor({ ...S2, site }));

    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({ error: ERRORS.serverError });
  });

  it.each([
    ['findQuery', `${API}/group?ispublic=0&nosuchattribute=x&offset=1`],
    ['findAll', `${API}/findAll?entityname=group&distinct=true&offset=1`],
    ['findMany', `${API}/group?id=${ADMIN_GROUP},${EDITOR_GROUP}&distinct=true&offset=2`],
  ])('answers %s with a numeric offset as the unhandled-exception 500, ahead of any feed clause identity fails closed on', async (method, url) => {
    const res = await send(app, 'GET', url, await headersFor(S2));

    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual(legacyError(method, ERRORS.serverError));
  });

  it.each([
    ['findOne without an id', 'findOne', `${API}/findOne?entityname=group`],
    ['findMany without ids', 'findMany', `${API}/findMany?entityname=group`],
  ])('answers a direct %s with the unhandled-exception 500 of its undefined argument', async (_label, method, url) => {
    const res = await send(app, 'GET', url, await headersFor(S2));

    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual(legacyError(method, ERRORS.serverError));
  });

  it.each([
    ['a distinct feed', 'distinct=true'],
    ['a membership filter', 'groupid=x'],
    ['a tag filter', 'tag=x'],
    ['an extended attribute filter', 'nosuchattribute=x'],
    ['an aggregate', 'sum=perm'],
    ['an inner join', 'innerJoin=content'],
    ['a bracketed name', 'filter%5Bgroupname%5D=x'],
    ['a changeset filter', 'changesetid=x'],
    ['a user feed', 'type=2'],
    ['a user feed by name', 'type=user'],
    ["another table's column", 'tfiles.fileid=x'],
    ["another table's ordering", 'sort=tfiles.fileext'],
    ['a feed setter identity does not reproduce', 'params=x'],
  ])('fails closed with the legacy 503 on a group query with %s', async (_label, query) => {
    const res = await send(app, 'GET', `${API}/group?ispublic=0&${query}`, await headersFor(S2));

    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({ error: ERRORS.serverError });
  });

  it('lists S2 groups only to an S2 caller and filters by inactive', async () => {
    const url = `/_api/json/v1/${SITE_B}/group?ispublic=*&groupname=neq%5EPictured`;
    const asS2 = await send(app, 'GET', url, await headersFor({ ...S2, site: SITE_B }));
    const asSiteAdmin = await send(app, 'GET', url, await headersFor({ ...SITE_ADMIN, site: SITE_B }));
    const inactive = await send(app, 'GET', `${url}&inactive=1`, await headersFor({ ...S2, site: SITE_B }));

    expect(namesOf(asS2)).toEqual(['Visible', 'Supers', 'Dormant']);
    expect(namesOf(asSiteAdmin)).toEqual(['Visible', 'Dormant']);
    expect(namesOf(inactive)).toEqual(['Dormant']);
  });

  it.each([
    ['sortBy a sort option with sortDirection desc', 'sortBy=email&sortDirection=desc', ['Supers', 'Visible', 'Dormant']],
    ['a sortDirection other than asc or desc, which leaves ascending', 'sortBy=email&sortDirection=sideways', ['Dormant', 'Visible', 'Supers']],
    ['sort ahead of sortBy', 'sortBy=email&sortDirection=desc&sort=groupname', ['Dormant', 'Supers', 'Visible']],
  ])('orders a group query by %s', async (_label, query, expected) => {
    const res = await send(app, 'GET', `/_api/json/v1/${SITE_B}/group?ispublic=*&groupname=neq%5EPictured&${query}`, await headersFor({ ...S2, site: SITE_B }));

    expect(namesOf(res)).toEqual(expected);
  });

  it('answers a group query sorted by an extended attribute, which no group holds, with every group', async () => {
    const res = await send(app, 'GET', `/_api/json/v1/${SITE_B}/group?ispublic=*&groupname=neq%5EPictured&sortBy=nosuchattribute`, await headersFor({ ...S2, site: SITE_B }));

    expect(namesOf(res).sort()).toEqual(['Dormant', 'Supers', 'Visible']);
  });

  it.each([
    ['a startindex', 'itemsPerPage=1&startindex=2', ['Dormant'], 2],
    ['a limit', 'limit=1', ['Visible'], 1],
    ['a size', 'size=1', ['Visible'], 1],
    ['maxItems', 'maxItems=1', ['Visible'], 1],
  ])('pages a findAll of the public pool by %s', async (_label, query, expected, totalItems) => {
    const res = await send(app, 'GET', `/_api/json/v1/${SITE_B}/findAll?entityname=group&${query}`, await headersFor({ ...S2, site: SITE_B }));

    expect(namesOf(res)).toEqual(expected);
    expect(dataOf(res).totalitems).toBe(totalItems);
  });

  it('answers findMany in the order of its ids unless sorted', async () => {
    const listedIds = `${ids.visible},${ids.dormant}`;
    const caller = await headersFor({ ...S2, site: SITE_B });

    const listed = await send(app, 'GET', `/_api/json/v1/${SITE_B}/findMany?entityname=group&ids=${listedIds}`, caller);
    const reversed = await send(app, 'GET', `/_api/json/v1/${SITE_B}/group?id=${ids.dormant},${ids.visible}`, caller);
    const sorted = await send(app, 'GET', `/_api/json/v1/${SITE_B}/findMany?entityname=group&ids=${listedIds}&sort=-groupname`, caller);

    expect(namesOf(listed)).toEqual(['Visible', 'Dormant']);
    expect(namesOf(reversed)).toEqual(['Dormant', 'Visible']);
    expect(namesOf(sorted)).toEqual(['Visible', 'Dormant']);
    expect((dataOf(listed).links as Record<string, string>).self).toBe(
      `http://${HOST}/index.cfm/_api/json/v1/${SITE_B}/?&ids=${listedIds}&method=findmany&entityname=group&pageIndex=1`,
    );
  });

  it.each([
    ['a user id no group holds', () => ({ entityname: 'user', userid: nextId('D') })],
    ['a group without a user id', () => ({ entityname: 'group' })],
  ])("fails closed with the legacy 503 when validating %s, whose new bean takes people's user rules", async (_label, data) => {
    const query = new URLSearchParams({ entityname: 'group', data: JSON.stringify(data()) });

    const res = await send(app, 'GET', `${API}/validate?${query.toString()}`, await headersFor(S2));

    expect(res.statusCode).toBe(503);
  });

  describe('login', () => {
    /** An anonymous session, the user token naming it, and a `login` token of its secret. */
    async function anonymousLogin(): Promise<{ sessionId: string; csrfSecret: string; headers: Record<string, string>; tokens: Record<string, string> }> {
      const sessionId = `S-legacy-api-login-${nextId('S')}`;
      const { csrfSecret } = await ensureSession({ db: handle.app, repo, clock: CLOCK }, { sessionId, mode: 'target-primary' });
      return { sessionId, csrfSecret, headers: await headersFor({ sub: '', sid: sessionId, roles: [] }), tokens: csrfFields('login', csrfSecret) };
    }

    it('logs the session in under its own id on a valid login token and right credentials', async () => {
      const userId = await seedAccount(SITE, 'jsonapi-lucy', TEST_PASSWORDS.editor);
      const { sessionId, headers, tokens } = await anonymousLogin();

      const res = await send(app, 'POST', `${API}/login`, headers, { username: 'jsonapi-lucy', password: TEST_PASSWORDS.editor, ...tokens });

      expect(json(res)).toEqual({ apiversion: 'v1', method: 'login', data: { status: 'success' } });
      expect(await withTenant(handle.app, SYSTEM_TENANT_ID, (tx) => repo.findSession(tx, sessionId))).toMatchObject({ user_id: userId, state: 'active' });
    });

    it('answers a wrong password as failed with one strike', async () => {
      await seedAccount(SITE, 'jsonapi-max', TEST_PASSWORDS.editor);
      const { headers, tokens } = await anonymousLogin();

      const res = await send(app, 'POST', `${API}/login`, headers, { username: 'jsonapi-max', password: TEST_PASSWORDS.admin, ...tokens });

      expect(json(res)).toEqual({ apiversion: 'v1', method: 'login', data: { status: 'failed' } });
      expect(await strikeOf('jsonapi-max')).toMatchObject({ strikes: 1 });
    });

    it.each([
      ['no token', false],
      ['a token of another context', true],
    ])("answers a login with %s as legacy's 'Invalid CSFR Tokens' without a strike or a login", async (_label, withToken) => {
      const username = `jsonapi-ned-${String(withToken)}`;
      await seedAccount(SITE, username, TEST_PASSWORDS.editor);
      const { sessionId, csrfSecret, headers } = await anonymousLogin();
      const tokens = withToken ? csrfFields('logout', csrfSecret) : {};

      const res = await send(app, 'POST', `${API}/login`, headers, { username, password: TEST_PASSWORDS.editor, ...tokens });

      expect(json(res)).toEqual({ apiversion: 'v1', method: 'login', data: { status: 'Invalid CSFR Tokens' } });
      expect(await strikeOf(username)).toBeNull();
      expect(await withTenant(handle.app, SYSTEM_TENANT_ID, (tx) => repo.findSession(tx, sessionId))).toMatchObject({ user_id: null });
    });

    it('fails closed with the legacy 503 on a lockdown login', async () => {
      const { headers, tokens } = await anonymousLogin();

      const res = await send(app, 'POST', `${API}/login`, headers, { username: 'x', password: 'y', lockdowncheck: 'true', ...tokens });

      expect(res.statusCode).toBe(503);
    });
  });

  it('logs a session out under its id and deletes the userHash and userid cookies', async () => {
    const caller = await inSession(S2, SITE, 'S2');

    const res = await send(app, 'POST', `${API}/logout`, await headersFor(caller));

    expect(json(res)).toEqual({ apiversion: 'v1', method: 'logout', data: { status: 'success' } });
    expect(cookiesWithoutExpiry(res)).toEqual(oracle('logoutAnonymous').deletedCookies);
    expect(String(res.headers['set-cookie'])).toContain(';expires=');
    expect(await gated(SITE, (tx) => repo.findSession(tx, caller.sid ?? ''))).toMatchObject({ user_id: null });
  });

  it("issues one CSRF token for the context under the session's secret, and refuses a call without an active session", async () => {
    const caller = await inSession(SITE_EDITOR, SITE, `Editor;${SITE};0`);
    const expected = issueTokens({ csrfSecret: SECRET }, { context: 'cusers.update', clock: CLOCK });

    const res = await send(app, 'GET', `${API}/generateCSRFTokens?context=cusers.update`, await headersFor(caller));
    const unknown = await send(app, 'GET', `${API}/generateCSRFTokens?context=cusers.update`, await headersFor({ ...SITE_EDITOR, sid: 'S-unknown' }));

    expect(json(res)).toEqual({ apiversion: 'v1', method: 'generateCSRFTokens', data: { csrf_token: expected.token, csrf_token_expires: expected.expires } });
    expect(expected.token).toMatch(/^[0-9A-F]{64}$/);
    expect(expected.expires).toMatch(/^\d{15}$/);
    expect(unknown.statusCode).toBe(401);
  });

  it("adds the session's login-time memberships, membership ids and login flag to people's current user", async () => {
    const caller = await inSession(USERS_EDITOR, SITE, `Admin;${SITE};0,S2IsPrivate;${SITE}`, `${ADMIN_GROUP},${USERS_EDITOR.sub}`);
    people.calls.length = 0;
    people.answer = { status: 200, headers: {}, body: { apiversion: 'v1', method: 'findOne', data: { userid: USERS_EDITOR.sub, ispublic: 0, s2: 0 } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor(caller));

    expect(people.calls.map((call) => call.path)).toEqual([`${API}/user/${USERS_EDITOR.sub}`]);
    expect(dataOf(res)).toEqual({
      userid: USERS_EDITOR.sub,
      ispublic: 0,
      s2: 0,
      memberships: [`Admin;${SITE};0`, `S2IsPrivate;${SITE}`],
      membershipids: [ADMIN_GROUP, USERS_EDITOR.sub],
      isloggedin: true,
    });
  });

  it('answers an anonymous session with no memberships and isloggedin false', async () => {
    const sessionId = `S-legacy-api-anon-${nextId('S')}`;
    await ensureSession({ db: handle.app, repo, clock: CLOCK }, { sessionId, mode: 'target-primary' });
    people.answer = { status: 200, headers: {}, body: { apiversion: 'v1', method: 'findOne', data: { userid: '' } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor({ sub: '', sid: sessionId, roles: [] }));

    expect(dataOf(res)).toEqual({ userid: '', memberships: [], membershipids: [], isloggedin: false });
  });

  describe('group save', () => {
    const GROUP_C = `/_api/json/v1/${SITE_C}/group`;

    async function groupOf(id: string): Promise<Record<string, unknown>> {
      return dataOf(await send(app, 'GET', `${GROUP_C}/${id}?fields=groupname,ispublic,s2,email,siteid`, await headersFor({ ...S2, site: SITE_C })));
    }

    it('creates a group under a fresh id for S2 with the token of context new, keeping the posted visibility', async () => {
      const caller = await inSession(S2, SITE_C, 'S2');

      const res = await send(app, 'POST', GROUP_C, await headersFor(caller), { groupname: 'Reviewers', isPublic: '0', ...csrfFields('new') });

      const data = dataOf(res);
      expect(res.statusCode).toBe(200);
      expect(json(res).method).toBe('save');
      expect(data.userid).toMatch(CF_UUID);
      expect(data).toEqual({
        links: {
          entities: ENDPOINT_C,
          all: `${ENDPOINT_C}/group`,
          properties: `${ENDPOINT_C}/group/properties`,
          self: `${ENDPOINT_C}/group/${String(data.userid)}`,
          permissions: `${ENDPOINT_C}/group/${String(data.userid)}/permissions`,
        },
        userid: data.userid,
        groupname: 'Reviewers',
        ispublic: 0,
        siteid: SITE_C,
        type: 'group',
        subtype: 'Default',
        remoteid: '',
        isnew: 0,
        id: data.userid,
        entityname: 'group',
        saveerrors: false,
        errors: {},
      });
      expect(await groupOf(String(data.userid))).toMatchObject({ groupname: 'Reviewers', ispublic: 0, isnew: 0 });
    });

    it('saves a direct call posting type group as a group', async () => {
      const caller = await inSession(S2, SITE_C, 'S2');

      const res = await send(app, 'POST', `/_api/json/v1/${SITE_C}/save`, await headersFor(caller), {
        entityname: 'group', id: ids.helpers, type: 'group', remoteid: 'r-0', ...csrfFields(ids.helpers),
      });

      expect(res.statusCode).toBe(200);
      expect(json(res).method).toBe('save');
      expect(dataOf(res)).toMatchObject({ type: 'group', remoteid: 'r-0', errors: {} });
    });

    it("strips a Users-module editor's visibility, type, S2 flag, the Admin name and another record's email before updating", async () => {
      const caller = await inSession(USERS_EDITOR, SITE_C, `Editor;${SITE_C};0`);

      const res = await send(app, 'POST', `${GROUP_C}/${ids.helpers}`, await headersFor(caller), {
        groupname: 'admin', isPublic: '0', type: '2', s2: '1', email: 'changed@example.test', userid: ids.helpers, ...csrfFields(ids.helpers),
      });

      expect(res.statusCode).toBe(200);
      expect(await groupOf(ids.helpers)).toMatchObject({ groupname: 'Helpers', ispublic: 1, s2: 0, email: 'helpers@example.test' });
    });

    it('answers a save whose bean reports errors with 403 and the errors, writing nothing', async () => {
      const caller = await inSession(S2, SITE_C, 'S2');

      const res = await send(app, 'POST', GROUP_C, await headersFor(caller), { groupname: 'Spam', passedProtect: 'false', ...csrfFields('new') });

      const data = dataOf(res);
      expect(res.statusCode).toBe(403);
      expect(data).toMatchObject({ groupname: 'Spam', isnew: 1, saveerrors: false });
      expect(data.errors).toEqual({ spam: EN_GROUP_MESSAGES['captcha.spam'] });
      expect(await groupOf(String(data.userid))).toMatchObject({ isnew: 1 });
    });

    it.each([
      ['no token', {}],
      ['the token of context new for a stored id', null],
    ])('refuses a save with %s as invalid CSRF tokens', async (_label, tokens) => {
      const caller = await inSession(S2, SITE_C, 'S2');

      const res = await send(app, 'POST', `${GROUP_C}/${ids.helpers}`, await headersFor(caller), { groupname: 'Renamed', ...(tokens ?? csrfFields('new')) });

      expect(res.statusCode).toBe(400);
      expect(json(res)).toEqual(legacyError('save', ERRORS.invalidTokens));
      expect(await groupOf(ids.helpers)).toMatchObject({ groupname: 'Helpers' });
    });

    it("refuses a member's save of a group as authorization", async () => {
      const caller = await inSession(MEMBER, SITE_C, `Members;${SITE_C};1`);

      const res = await send(app, 'POST', `${GROUP_C}/${ids.helpers}`, await headersFor(caller), { groupname: 'Mine', ...csrfFields(ids.helpers) });

      expect(res.statusCode).toBe(401);
      expect(json(res)).toEqual(legacyError('save', ERRORS.authorization));
    });

    it.each([
      ['a direct S2 save posting type 2', S2, `/_api/json/v1/${SITE_C}/save`, (): Record<string, string> => ({ entityname: 'group', id: ids.helpers, type: '2', ...csrfFields(ids.helpers) })],
      ["a Users-module editor's new group, whose stripped type stays the new bean's 2", USERS_EDITOR, GROUP_C, (): Record<string, string> => ({ groupname: 'Fresh', ...csrfFields('new') })],
    ])('fails closed with the legacy 503 on %s, which writes a user record', async (_label, who, url, form) => {
      const caller = await inSession(who, SITE_C, who === S2 ? 'S2' : `Editor;${SITE_C};0`);

      const res = await send(app, 'POST', url, await headersFor(caller), form());

      expect(res.statusCode).toBe(503);
      expect(await groupOf(ids.helpers)).toMatchObject({ groupname: 'Helpers', isnew: 0 });
    });

    it('refuses a REST save from a session that has ended as a missing credential', async () => {
      const caller = await inSession(S2, SITE_C, 'S2');
      await gated(SITE_C, (tx) => repo.updateSession(tx, caller.sid ?? '', { state: 'ended' }));

      const res = await send(app, 'POST', `/_api/rest/v1/${SITE_C}/group/${ids.helpers}`, await headersFor(caller), { groupname: 'Late' });

      expect(res.statusCode).toBe(401);
      expect(await groupOf(ids.helpers)).toMatchObject({ groupname: 'Helpers' });
    });

    it('saves over REST without a CSRF token, as a sessionless REST call does', async () => {
      const caller = await inSession(S2, SITE_C, 'S2');

      const res = await send(app, 'POST', `/_api/rest/v1/${SITE_C}/group/${ids.helpers}`, await headersFor(caller), { groupname: 'Helpers', remoteid: 'r-1' });

      expect(res.statusCode).toBe(200);
      expect(dataOf(res)).toMatchObject({ remoteid: 'r-1', errors: {} });
    });

    it('leaves a group delete under its CSRF context to legacy with the 404 envelope', async () => {
      const caller = await inSession(S2, SITE_C, 'S2');

      const res = await send(app, 'DELETE', `${GROUP_C}/${ids.helpers}`, await headersFor(caller), csrfFields(ids.helpers));

      expect(res.statusCode).toBe(404);
      expect(json(res)).toMatchObject({ error: ERRORS.invalidMethodCall });
      expect(await groupOf(ids.helpers)).toMatchObject({ groupname: 'Helpers', isnew: 0 });
    });
  });
});
