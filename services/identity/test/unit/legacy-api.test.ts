/** The JSON API routes against Masa 7.6.1 oracle answers, over an in-memory registry and a throwaway `identity` schema: headers, CORS, route ownership, identity's named methods, group operations and access, saves, and REST credential delegation. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, etag } from '@opt2/platform/legacy-compat';
import { createLogger, validateLogRecord, type LogFn, type Logger } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import {
  EnvValidationError,
  SERVICE_CALL_TIMEOUT_MS,
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
import { ensureSession, sessionState, type SessionDeps } from '../../src/domain/sessions.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import type { BridgeRelay } from '../../src/legacy/bridge-relay.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';
import { feedHalted, feedRefused, legacyApiPrefixes, likeMatcher, lockdownRefused, registerLegacyApiRoutes, userRecordRefused, type LegacyApiRouteDeps, type LegacyApiSettings } from '../../src/routes/legacy-api.js';
import { validateHalted, validateRefused } from '../../src/routes/legacy-bean-validator.js';
import { authenticateRestRequest } from '../../src/routes/oauth.js';
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

/** An oracle answer of `validate` (fixture json-api-validate-answers.json); `refusal` marks a case identity answers with the legacy 503. */
interface ValidateAnswer {
  family: 'adhoc' | 'datatype' | 'comparison' | 'entity' | 'loadby';
  caller: 'admin' | 'anonymous';
  data: string;
  validations?: string;
  status: number;
  contentType: string;
  hasEtag: boolean;
  body: string;
  stacktraceRemoved?: true;
  refusal?: string;
}

const VALIDATE_ORACLE = (
  JSON.parse(readFileSync(new URL('../fixtures/legacy/json-api-validate-answers.json', import.meta.url), 'utf8')) as { answers: Record<string, ValidateAnswer> }
).answers;

/** Names of the validate answers of `family`, those identity refuses when `refused`. */
function validateAnswers(family: ValidateAnswer['family'], refused = false): string[] {
  return Object.keys(VALIDATE_ORACLE).filter((name) => VALIDATE_ORACLE[name]?.family === family && (VALIDATE_ORACLE[name]?.refusal !== undefined) === refused);
}

function validateAnswer(name: string): ValidateAnswer {
  const answer = VALIDATE_ORACLE[name];
  if (answer === undefined) throw new Error(`no validate answer ${name}`);
  return answer;
}

/** The request path of a validate answer. */
function validatePath(answer: ValidateAnswer): string {
  const validations = answer.validations === undefined ? '' : `&validations=${encodeURIComponent(answer.validations)}`;
  return `${API}/validate?entityname=group&data=${encodeURIComponent(answer.data)}${validations}`;
}

/** The caller of a validate answer: the oracle's admin is S2. */
function validateCaller(answer: ValidateAnswer): Caller | undefined {
  return answer.caller === 'admin' ? S2 : undefined;
}

/** Asserts that `res` answers as the oracle did: status, content type, parsed envelope with its `data` keys in order, and ETag rule. */
function expectValidateAnswer(res: Answer, answer: ValidateAnswer): void {
  const expected = JSON.parse(answer.body) as { data?: unknown };
  expect(res.statusCode).toBe(answer.status);
  expect(res.headers['content-type']).toBe(answer.contentType);
  expect(json(res)).toEqual(expected);
  if (typeof expected.data === 'object' && expected.data !== null) expect(Object.keys(dataOf(res))).toEqual(Object.keys(expected.data));
  expect(res.headers.etag).toBe(answer.hasEtag ? etag(res.body) : undefined);
}

/** An oracle answer of a group feed (fixture json-api-feed-answers.json); `refusal` marks a case identity answers with the legacy 503. */
interface FeedAnswer {
  family: 'distinct' | 'aggregate' | 'subquery' | 'join' | 'table' | 'sort' | 'fields' | 'bracket' | 'setter' | 'extended';
  path: string;
  status: number;
  contentType: string;
  hasEtag: boolean;
  body: string;
  stacktraceRemoved?: true;
  detail?: string;
  refusal?: string;
}

const FEED_FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/legacy/json-api-feed-answers.json', import.meta.url), 'utf8')) as {
  oracleOrigin: string;
  answers: Record<string, FeedAnswer>;
};
const FEED_ORACLE = FEED_FIXTURE.answers;

/** Names of the feed answers of `family`, those identity refuses when `refused`. */
function feedAnswers(family: FeedAnswer['family'], refused = false): string[] {
  return Object.keys(FEED_ORACLE).filter((name) => FEED_ORACLE[name]?.family === family && (FEED_ORACLE[name]?.refusal !== undefined) === refused);
}

function feedAnswer(name: string): FeedAnswer {
  const answer = FEED_ORACLE[name];
  if (answer === undefined) throw new Error(`no feed answer ${name}`);
  return answer;
}

/** Item ids of a feed page body, in item order. */
function itemIds(body: string): string[] {
  const data = (JSON.parse(body) as { data?: { items?: Array<{ userid?: string }> } }).data;
  return (data?.items ?? []).map((item) => item.userid ?? '');
}

type FeedEnvelope = { data?: { items?: Array<Record<string, unknown>>; links?: Record<string, string> } };

/** A findAll or findMany page with the query pairs of its url-scope links sorted: ACF iterates that scope in an order that varies from request to request. */
function withScopeLinksSorted(envelope: FeedEnvelope): FeedEnvelope {
  const links = envelope.data?.links;
  if (links === undefined || !/&method=find(all|many)&/i.test(links.self ?? '')) return envelope;
  for (const name of ['self', 'first', 'previous', 'next', 'last']) {
    const link = links[name];
    if (link === undefined) continue;
    const [base = '', query = ''] = link.split('?');
    links[name] = `${base}?${query.split('&').sort().join('&')}`;
  }
  return envelope;
}

/** The test clock's time as a feed item serializes it. */
const NOW_TEXT = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(NOW.getDate()).padStart(2, '0')}T${String(NOW.getHours()).padStart(2, '0')}:${String(NOW.getMinutes()).padStart(2, '0')}:${String(NOW.getSeconds()).padStart(2, '0')}`;

/**
 * Asserts that `res` answers as the oracle did: status, content type, parsed envelope on this host and ETag rule; a new bean's generated
 * id stands in for the oracle's, and the request time a NULL `passwordcreated` of `undated` rows reads (userBean.cfc:137) is the test clock's.
 */
function expectFeedAnswer(res: Answer, answer: FeedAnswer, seeded: readonly string[], undated: readonly string[] = []): void {
  let expected = answer.body.replaceAll(FEED_FIXTURE.oracleOrigin, `http://${HOST}`);
  const ours = itemIds(res.body);
  itemIds(expected).forEach((theirs, i) => {
    const generated = ours[i];
    if (!seeded.includes(theirs) && generated !== undefined) expected = expected.replaceAll(theirs, generated);
  });
  const envelope = JSON.parse(expected) as FeedEnvelope;
  for (const item of envelope.data?.items ?? []) {
    if (undated.includes(String(item.userid)) && 'passwordcreated' in item) item.passwordcreated = NOW_TEXT;
  }
  expect(res.statusCode).toBe(answer.status);
  expect(res.headers['content-type']).toBe(answer.contentType);
  expect(withScopeLinksSorted(json(res) as FeedEnvelope)).toEqual(withScopeLinksSorted(envelope));
  expect(res.headers.etag).toBe(answer.hasEtag ? etag(res.body) : undefined);
}

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

/** A logger that keeps the arguments of every log call, on it and its children, and every line it writes. */
function capturingLogger(): { logger: Logger; calls: unknown[][]; lines: string[] } {
  const calls: unknown[][] = [];
  const lines: string[] = [];
  const recording = (inner: Logger): Logger => {
    const forward =
      (level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'): LogFn =>
      (...args: unknown[]) => {
        calls.push(args);
        Reflect.apply(inner[level], inner, args);
      };
    return {
      get level() {
        return inner.level;
      },
      set level(level: string) {
        inner.level = level;
      },
      fatal: forward('fatal'),
      error: forward('error'),
      warn: forward('warn'),
      info: forward('info'),
      debug: forward('debug'),
      trace: forward('trace'),
      child: (bindings) => recording(inner.child(bindings)),
      isLevelEnabled: (level) => inner.isLevelEnabled(level),
      flush: (cb) => inner.flush(cb),
    };
  };
  const root = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: (line: string) => void lines.push(line) } });
  return { logger: recording(root), calls, lines };
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

/** An identity service with only the JSON API routes registered, routing `noCasePathPrefixes` in any letter case. */
async function buildApp(deps: LegacyApiRouteDeps, logger: Logger = quietLogger(), noCasePathPrefixes: readonly string[] = []): Promise<FastifyInstance> {
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
    logger,
    noCasePathPrefixes,
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
    const stalling = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"status":');
    });
    let stallingOrigin = '';

    beforeAll(async () => {
      await new Promise<void>((resolve) => stalling.listen(0, '127.0.0.1', resolve));
      stallingOrigin = `http://127.0.0.1:${String((stalling.address() as AddressInfo).port)}`;
    });

    afterAll(async () => {
      stalling.closeAllConnections();
      await new Promise((resolve) => stalling.close(resolve));
    });

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
        'real headers and stalled body',
        (input, init) => {
          const target = new URL(input instanceof Request ? input.url : input);
          return fetch(new URL(`${target.pathname}${target.search}`, stallingOrigin), init);
        },
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

// --- Calls that read or write identity data ---

const available = await pgAvailable();

describe.skipIf(!available)('JSON API against PostgreSQL', () => {
  const people = recordingPeople();
  const outbound = recordingFetch();
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
    app = await buildApp(routeDeps(handle.app, repo, people, outbound.fetch, SETTINGS));
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
    ['a user record', SITE, () => `${API}/group/${ids.userAccount}`, /at userRecordRefused .*\\n\s+at loadedUserRefused /],
    ['the ishuman field', SITE, () => `${API}/group/${ADMIN_GROUP}?ishuman=1`, /at unavailable .*\\n\s+at assertNoHumanCheck /],
    ['extended data fields', SITE, () => `${API}/group/${ADMIN_GROUP}?fields=groupname,extendeddata`, /at unavailable .*\\n\s+at filteredValues /],
    ["a photo's file extension", SITE_B, () => `/_api/json/v1/${SITE_B}/group/${ids.pictured}?fields=photofileext`, /at unavailable .*\\n\s+at beanValue /],
  ])('fails closed with the legacy 503 on a findOne of %s', async (_label, site, url, frames) => {
    const captured = capturingLogger();
    const logged = await buildApp(routeDeps(handle.app, repo, people, outbound.fetch, SETTINGS), captured.logger);
    try {
      const res = await send(logged, 'GET', url(), await headersFor({ ...S2, site }));

      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ error: ERRORS.serverError });
      // The logger redacts the message, whose entry the refusing helper names; its stack shows the helper and the refusing site.
      expect(captured.lines.find((line) => line.includes('service unavailable'))).toMatch(frames);
    } finally {
      await logged.opt2.shutdown();
    }
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
    ['a user feed', 'type=2'],
    ['a user feed by name', 'type=user'],
  ])('fails closed with the legacy 503 of EX-GROUP-FEED on a group query with %s', async (_label, query) => {
    const captured = capturingLogger();
    const logged = await buildApp(routeDeps(handle.app, repo, people, outbound.fetch, SETTINGS), captured.logger);
    try {
      const res = await send(logged, 'GET', `${API}/group?ispublic=0&${query}`, await headersFor(S2));

      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ error: ERRORS.serverError });
      // The logger redacts the message, whose entry the refusing helper names; its stack shows the helper and the refusing site.
      expect(captured.lines.find((line) => line.includes('service unavailable'))).toMatch(/at feedHalted .*\\n\s+at feedPage /);
      expect(feedHalted('A user feed', 'user-feed')).toMatchObject({ message: 'A user feed stays on legacy (EX-GROUP-FEED)', reason: 'user-feed' });
    } finally {
      await logged.opt2.shutdown();
    }
  });

  it.each<[string, Record<string, string>]>([
    ['naming the client credentials the gateway exchange consumed', { 'x-opt2-consumed-params': 'client_id,client_secret' }],
    ['without a consumed-params header', {}],
  ])('keys a REST group collection whose only query param is client_id to findQuery %s', async (_label, consumed) => {
    const url = `/_api/rest/v1/${SITE_C}/group?client_id=C1`;
    const member = await inSession(MEMBER, SITE_C, `Members;${SITE_C};1`);
    const admin = await inSession(S2, SITE_C, 'S2');

    const asMember = await send(app, 'GET', url, { ...(await headersFor(member)), ...consumed });
    const asAdmin = await send(app, 'GET', url, { ...(await headersFor(admin)), ...consumed });

    // The registered site's sessionless event raises inside findQuery, ahead of its access check and its feed.
    for (const res of [asMember, asAdmin]) {
      expect(res.statusCode).toBe(500);
      expect(json(res)).toEqual(legacyError('findQuery', ERRORS.serverError));
    }
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
    // getFilteredValues left `url.expanddepth` behind once an item was packaged (oracle answer distinct:findmany-fields).
    expect((dataOf(listed).links as Record<string, string>).self).toBe(
      `http://${HOST}/index.cfm/_api/json/v1/${SITE_B}/?&ids=${listedIds}&expanddepth=1&method=findmany&entityname=group&pageIndex=1`,
    );
  });

  describe('bounded group feeds', () => {
    const SITE_P = 'tenant-feed-pages';
    /** Groups seeded in userid order: seven public ones, two private ones and an S2 one, which S2 keeps private. */
    const SEEDED: ReadonlyArray<{ name: string; perm: number; ispublic: 0 | 1; s2: number }> = [
      { name: 'golf', perm: 0, ispublic: 1, s2: 0 },
      { name: 'Foxtrot', perm: 1, ispublic: 1, s2: 0 },
      { name: 'echo', perm: 0, ispublic: 1, s2: 0 },
      { name: 'delta', perm: 1, ispublic: 1, s2: 0 },
      { name: 'charlie', perm: 0, ispublic: 1, s2: 0 },
      { name: 'Bravo', perm: 1, ispublic: 1, s2: 0 },
      { name: 'alpha', perm: 0, ispublic: 1, s2: 0 },
      { name: 'Hotel', perm: 1, ispublic: 0, s2: 0 },
      { name: 'india', perm: 0, ispublic: 0, s2: 0 },
      { name: 'Juliet', perm: 0, ispublic: 0, s2: 1 },
    ];
    type Order = 'userid' | 'name' | '-name' | '-perm';
    const userids: string[] = [];
    const statements: string[] = [];
    /** Each statement `paged` ran with the rows it returned. */
    const transferred: Array<{ text: string; rows: number }> = [];
    let countedReads = 0;
    let paged: FastifyInstance;

    beforeAll(async () => {
      await registerSite(SITE_P);
      await gated(SITE_P, async (tx) => {
        for (const { name, perm, ispublic, s2 } of SEEDED) {
          const userid = nextId('B');
          userids.push(userid);
          await repo.insertGroup(tx, { ...groupInput(name, SITE_P, ispublic, { perm, s2 }), userid }, null);
        }
      });
      const pagedRepo = createIdentityRepository({ clock: CLOCK, schema: handle.schema, pageSize: 2 });
      const counting: IdentityRepository = {
        ...pagedRepo,
        listCountedGroups: (...args) => {
          countedReads += 1;
          return pagedRepo.listCountedGroups(...args);
        },
      };
      const recordingDb: TenantDb = {
        ...handle.app,
        withTenant: (tenantId, fn) =>
          handle.app.withTenant(tenantId, (tx) => {
            const query = (async (text: string, values?: unknown[]) => {
              statements.push(text);
              const result = await tx.query(text, values);
              transferred.push({ text, rows: result.rows.length });
              return result;
            }) as TenantTx['query'];
            return fn({ ...tx, query });
          }),
      };
      paged = await buildApp(routeDeps(recordingDb, counting, people, recordingFetch().fetch, SETTINGS));
    });

    afterAll(async () => {
      await paged?.opt2.shutdown();
    });

    /** The seeded names a feed of `pools` (and the seeds `only` lists) shows, fully sorted by `order`, ties by userid. */
    function referenceOrder(order: Order, pools: readonly number[], superUser: boolean, only?: readonly number[]): string[] {
      const by = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
      const keyed = (a: (typeof SEEDED)[number], b: (typeof SEEDED)[number]): number =>
        order === 'name' ? by(a.name.toLowerCase(), b.name.toLowerCase())
          : order === '-name' ? by(b.name.toLowerCase(), a.name.toLowerCase())
            : order === '-perm' ? b.perm - a.perm
              : 0;
      return SEEDED.map((group, n) => ({ ...group, n, userid: userids[n] ?? '' }))
        .filter((group) => pools.includes(group.ispublic) && (superUser || group.s2 === 0) && (only === undefined || only.includes(group.n)))
        .sort((a, b) => keyed(a, b) || by(a.userid, b.userid))
        .map((group) => group.name);
    }

    /** `request`'s answer and the length of each array of stored group rows sorted while it ran. */
    async function withGroupSorts(request: () => Promise<Answer>): Promise<{ res: Answer; sorted: number[] }> {
      const sort = vi.spyOn(Array.prototype, 'sort');
      try {
        const res = await request();
        const sorted = (sort.mock.contexts as unknown[])
          .filter((rows): rows is object[] => Array.isArray(rows) && rows.length > 0 && rows.every((row) => typeof row === 'object' && row !== null && 'password' in row && 'groupname' in row))
          .map((rows) => rows.length);
        return { res, sorted };
      } finally {
        sort.mockRestore();
      }
    }

    it.each<[string, Caller, string, Order, readonly number[], readonly number[] | undefined, number[], number, number, number]>([
      ['findAll by itemsPerPage and pageIndex', S2, 'findAll?entityname=group&itemsPerPage=2&pageIndex=3', 'userid', [1], undefined, [4, 5], 7, 4, 3],
      ['findAll by a startindex inside a page', S2, 'findAll?entityname=group&itemsPerPage=3&startindex=5&sort=groupname', 'name', [1], undefined, [4, 5], 7, 3, 2],
      ['findAll by a startindex after a pageIndex', S2, 'findAll?entityname=group&itemsPerPage=2&pageIndex=1&startindex=4&sort=-groupname', '-name', [1], undefined, [3], 7, 4, 2],
      ['findAll by maxItems ending inside the last page', S2, 'findAll?entityname=group&maxItems=5&itemsPerPage=2&pageIndex=3&sort=-perm', '-perm', [1], undefined, [4], 5, 3, 3],
      ['findAll by a pageIndex beyond the last page', S2, 'findAll?entityname=group&itemsPerPage=2&pageIndex=9&sort=groupname', 'name', [1], undefined, [0, 1], 7, 4, 1],
      ['findAll by one item per page at the last startindex', S2, 'findAll?entityname=group&itemsPerPage=1&startindex=7&sort=-perm', '-perm', [1], undefined, [6], 7, 7, 7],
      ['findAll of every item', S2, 'findAll?entityname=group&itemsPerPage=*&sort=groupname', 'name', [1], undefined, [0, 1, 2, 3, 4, 5, 6], 7, 1, 1],
      ['findAll by a fractional itemsPerPage', S2, 'findAll?entityname=group&itemsPerPage=1.5&pageIndex=3', 'userid', [1], undefined, [3, 4], 7, 5, 3],
      ['findAll by a negative itemsPerPage from a startindex', S2, 'findAll?entityname=group&itemsPerPage=-1&startindex=4', 'userid', [1], undefined, [3], 7, -7, -4],
      ['findQuery of both pools by nextn', S2, 'group?ispublic=*&nextn=3&pageIndex=2&sort=groupname', 'name', [0, 1], undefined, [3, 4, 5], 10, 4, 2],
      ['findQuery of both pools under maxItems', S2, 'group?ispublic=*&maxItems=8&itemsPerPage=3&pageIndex=3&sort=-perm', '-perm', [0, 1], undefined, [6, 7], 8, 3, 3],
      ['findQuery of both pools without S2 groups', SITE_ADMIN, 'group?ispublic=*&itemsPerPage=4&pageIndex=3&sort=groupname', 'name', [0, 1], undefined, [8], 9, 3, 3],
      ['findMany of listed ids', S2, 'findMany?entityname=group&itemsPerPage=2&pageIndex=2&sort=groupname', 'name', [1], [0, 6, 3, 7], [2], 3, 2, 2],
    ])('pages %s as a full sort of every selected group does, whatever the read page size', async (_label, caller, path, order, pools, only, positions, totalItems, totalPages, pageIndex) => {
      const ids = only === undefined ? '' : `&ids=${only.map((n) => userids[n] ?? '').join(',')}`;
      const url = `/_api/json/v1/${SITE_P}/${path}${ids}`;
      const headers = await headersFor({ ...caller, site: SITE_P });
      const reference = referenceOrder(order, pools, caller === S2, only);

      const res = await send(paged, 'GET', url, headers);
      const unpaged = await send(app, 'GET', url, headers);

      expect(res.statusCode).toBe(200);
      expect(namesOf(res)).toEqual(positions.map((n) => reference[n]));
      expect(dataOf(res)).toMatchObject({ totalitems: totalItems, totalpages: totalPages, pageindex: pageIndex });
      expect(res.body).toBe(unpaged.body);
    });

    it.each<[string, () => string, number[], boolean, number[]]>([
      ['a findAll page of two at pageIndex 2', () => 'findAll?entityname=group&itemsPerPage=2&pageIndex=2', [4], true, []],
      ['a findAll under maxItems 3', () => 'findAll?entityname=group&maxItems=3', [3], true, []],
      ['a findAll page of one at startindex 3', () => 'findAll?entityname=group&itemsPerPage=1&startindex=3', [3], true, []],
      ['a findQuery page of nextn 2 over both pools', () => 'group?ispublic=*&nextn=2', [2, 2], true, [4]],
      ['a findAll of every item', () => 'findAll?entityname=group&itemsPerPage=*', [7], true, []],
      ['a findQuery by perm sorted by name under maxItems 2', () => 'group?perm=1&maxItems=2&sort=-groupname', [2], true, []],
      ['a findMany page of one of three ids', () => `findMany?entityname=group&itemsPerPage=1&ids=${[0, 3, 6].map((n) => userids[n] ?? '').join(',')}`, [1], true, []],
      ['a findAll page that addresses no row, as its count alone', () => 'findAll?entityname=group&itemsPerPage=-1', [1], false, []],
    ])('reads %s in one identity statement per pool that filters, orders, counts and cuts, transferring only the rows its page can address', async (_label, path, rows, cut, merged) => {
      const headers = await headersFor({ ...S2, site: SITE_P });
      statements.length = 0;
      transferred.length = 0;

      const { res, sorted } = await withGroupSorts(() => send(paged, 'GET', `/_api/json/v1/${SITE_P}/${path()}`, headers));

      expect(res.statusCode).toBe(200);
      const feeds = transferred.filter(({ text }) => text.includes('"group_account"'));
      expect(feeds.map((read) => read.rows)).toEqual(rows);
      expect(feeds.every(({ text }) => /^SELECT .*\(SELECT count\(\*\)::integer FROM \(SELECT 1 FROM .* WHERE .* LIMIT \$6\) c\)/s.test(text))).toBe(true);
      expect(feeds.every(({ text }) => / ORDER BY .* LIMIT \$\d+$/s.test(text) === cut)).toBe(true);
      expect(sorted).toEqual(merged);
      expect(statements.some((text) => /^(DECLARE|FETCH|CLOSE)\b/.test(text) || /"membership"|"account_operation"/.test(text))).toBe(false);
      expect(countedReads).toBe(0);
    });

    it('falls back to the fenced cursor scan for a LIKE class, which PostgreSQL LIKE lacks', async () => {
      const headers = await headersFor({ ...S2, site: SITE_P });
      statements.length = 0;

      const res = await send(paged, 'GET', `/_api/json/v1/${SITE_P}/group?groupname=begins%5E%5Bab%5D&sort=groupname`, headers);

      expect(res.statusCode).toBe(200);
      expect(namesOf(res)).toEqual(['alpha', 'Bravo']);
      const declared = statements.filter((text) => text.startsWith('DECLARE'));
      expect(declared.length).toBeGreaterThan(0);
      expect(declared.every((text) => text.includes('"group_account"'))).toBe(true);
      expect(statements.filter((text) => text.startsWith('FETCH')).length).toBeGreaterThan(0);
    });
  });

  describe('group feed LIKE patterns', () => {
    const SITE_L = 'tenant-like';
    const LONG_A = 'a'.repeat(255);
    const NAMES = ['Alpha', 'alpine', 'Bravo', 'a.b', 'axb', 'x[y', 'Cost$(9)+', 'Line\nTwo', LONG_A];

    beforeAll(async () => {
      await registerSite(SITE_L);
      await gated(SITE_L, async (tx) => {
        for (const name of NAMES) await repo.insertGroup(tx, { ...groupInput(name, SITE_L, 1), userid: nextId('B') }, null);
      });
    });

    /** The findQuery answer of `groupname=<criteria>` on the LIKE site, to S2. */
    async function queryByName(criteria: string): Promise<Answer> {
      return send(app, 'GET', `/_api/json/v1/${SITE_L}/group?groupname=${encodeURIComponent(criteria)}`, await headersFor({ ...S2, site: SITE_L }));
    }

    it.each<[string, string, string[]]>([
      ['an all-% pattern', '*', NAMES],
      ['% as any run', 'begins^a%b', ['a.b', 'axb']],
      ['_ as exactly one character', 'begins^Brav__', []],
      ['_ as any character, a newline included', 'begins^Line_Two', ['Line\nTwo']],
      ['a class', 'begins^[ab]l', ['Alpha', 'alpine']],
      ['a class range', 'ends^[n-p]', ['Bravo', 'Line\nTwo']],
      ['an unterminated [ as a literal', 'contains^x[y', ['x[y']],
      ['case-insensitivity', 'begins^ALP', ['Alpha', 'alpine']],
      ['a value anchored at its start', 'begins^lp', []],
      ['regex metacharacters as literals', 'contains^$(9)+', ['Cost$(9)+']],
      ['a dot as a literal', 'begins^a.b', ['a.b']],
      ['an asterisk after a condition as a literal', 'begins^a*', []],
    ])('selects groups by %s through findQuery', async (_label, criteria, expected) => {
      const res = await queryByName(criteria);

      expect(res.statusCode).toBe(200);
      expect(namesOf(res).sort()).toEqual([...expected].sort());
    });

    it.each([
      ['a%a%a%a%a%a%a%a%a%b', 'begins^a%a%a%a%a%a%a%a%a%b'],
      ['a long %a%a…%b', `*${'a*'.repeat(100)}b`],
    ])('answers the backtracking pattern %s against a 255-character run of a quickly with no match', async (_label, criteria) => {
      const started = performance.now();
      const res = await queryByName(criteria);
      const elapsed = performance.now() - started;

      expect(res.statusCode).toBe(200);
      expect(namesOf(res)).toEqual([]);
      expect(elapsed).toBeLessThan(500);
    });
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

    describe('with a lockdown check (userUtility.cfc:179-259; oracle answers of lockdowncheck true, 1, yes, 2, abc, \'\' and false)', () => {
      let cookieLockdown: FastifyInstance;

      beforeAll(async () => {
        cookieLockdown = await buildApp(routeDeps(handle.app, repo, people, outbound.fetch, { ...SETTINGS, sessionBasedLockdown: false }));
      });

      afterAll(async () => {
        await cookieLockdown?.opt2.shutdown();
      });

      /** An account named `username` holding one strike from a wrong attempt, and a fresh anonymous login of its own. */
      async function struckLogin(username: string): Promise<{ sessionId: string; headers: Record<string, string>; tokens: Record<string, string> }> {
        await seedAccount(SITE, username, TEST_PASSWORDS.editor);
        const first = await anonymousLogin();
        await send(app, 'POST', `${API}/login`, first.headers, { username, password: TEST_PASSWORDS.admin, ...first.tokens });
        expect(await strikeOf(username)).toMatchObject({ strikes: 1 });
        return anonymousLogin();
      }

      function adminStateOf(sessionId: string): Promise<unknown> {
        return withTenant(handle.app, SYSTEM_TENANT_ID, (tx) => repo.readSessionAdminState(tx, sessionId));
      }

      it.each(['true', '1', 'yes', '2'])(
        'passes a cookie-based check of %j as success without a cookie or a login, clearing the strikes',
        async (lockdowncheck) => {
          const username = `jsonapi-lock-${lockdowncheck}`;
          const { sessionId, headers, tokens } = await struckLogin(username);

          const res = await send(cookieLockdown, 'POST', `${API}/login`, headers, { username, password: TEST_PASSWORDS.editor, lockdowncheck, ...tokens });

          expect(json(res)).toEqual({ apiversion: 'v1', method: 'login', data: { status: 'success' } });
          expect(res.headers['set-cookie']).toBeUndefined();
          expect(await withTenant(handle.app, SYSTEM_TENANT_ID, (tx) => repo.findSession(tx, sessionId))).toMatchObject({ user_id: null });
          expect(await strikeOf(username)).toMatchObject({ strikes: 0 });
          expect(await adminStateOf(sessionId)).toEqual({ blockLoginUntil: '' });
        },
      );

      it.each(['abc', ''])('answers a check of %j that CFML cannot read as a boolean with the 500 of the conversion, keeping the strikes', async (lockdowncheck) => {
        const username = `jsonapi-lock-unreadable-${lockdowncheck}`;
        const { sessionId, headers, tokens } = await struckLogin(username);

        const res = await send(app, 'POST', `${API}/login`, headers, { username, password: TEST_PASSWORDS.editor, lockdowncheck, ...tokens });

        expect(res.statusCode).toBe(500);
        expect(json(res)).toEqual({ apiversion: 'v1', method: 'login', error: { message: 'Unhandled Exception', code: 'server_error' } });
        expect(await withTenant(handle.app, SYSTEM_TENANT_ID, (tx) => repo.findSession(tx, sessionId))).toMatchObject({ user_id: null });
        expect(await strikeOf(username)).toMatchObject({ strikes: 1 });
        expect(await adminStateOf(sessionId)).toEqual({ blockLoginUntil: '' });
      });

      it('answers a check with a wrong password as failed with a strike, as the login does', async () => {
        const username = 'jsonapi-lock-wrong';
        const { headers, tokens } = await struckLogin(username);

        const res = await send(app, 'POST', `${API}/login`, headers, { username, password: TEST_PASSWORDS.admin, lockdowncheck: 'true', ...tokens });

        expect(json(res)).toEqual({ apiversion: 'v1', method: 'login', data: { status: 'failed' } });
        expect(await strikeOf(username)).toMatchObject({ strikes: 2 });
      });

      it('logs in for a check of "false"', async () => {
        const username = 'jsonapi-lock-false';
        const { sessionId, headers, tokens } = await struckLogin(username);

        const res = await send(app, 'POST', `${API}/login`, headers, { username, password: TEST_PASSWORDS.editor, lockdowncheck: 'false', ...tokens });

        expect(json(res)).toEqual({ apiversion: 'v1', method: 'login', data: { status: 'success' } });
        expect(await withTenant(handle.app, SYSTEM_TENANT_ID, (tx) => repo.findSession(tx, sessionId))).not.toMatchObject({ user_id: null });
      });

      it('refuses a passed session-based check, the configBean default, with the legacy 503 of EX-LOGIN-LOCKDOWN before clearing strikes', async () => {
        const username = 'jsonapi-lock-session';
        const { sessionId, headers, tokens } = await struckLogin(username);
        const captured = capturingLogger();
        const logged = await buildApp(routeDeps(handle.app, repo, people, outbound.fetch, SETTINGS), captured.logger);
        try {
          const res = await send(logged, 'POST', `${API}/login`, headers, { username, password: TEST_PASSWORDS.editor, lockdowncheck: 'true', ...tokens });

          expect(res.statusCode).toBe(503);
          // The logger redacts the message, whose entry the refusing helper names; its stack shows the helper.
          expect(captured.lines.find((line) => line.includes('service unavailable'))).toContain('at lockdownRefused');
          expect(lockdownRefused().message).toBe('A session-based lockdown check is refused (EX-LOGIN-LOCKDOWN)');
          expect(await strikeOf(username)).toMatchObject({ strikes: 1 });
          expect(await adminStateOf(sessionId)).toEqual({});
        } finally {
          await logged.opt2.shutdown();
        }
      });
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
    people.answer = { status: 200, headers: {}, body: { data: { userid: USERS_EDITOR.sub, ispublic: 0, s2: 0 } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor(caller));

    expect(people.calls.map((call) => call.path)).toEqual(['/internal/v1/users/current']);
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
    people.calls.length = 0;
    people.answer = { status: 200, headers: {}, body: { data: { userid: '' } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser`, await headersFor({ sub: '', sid: sessionId, roles: [] }));

    expect(dataOf(res)).toEqual({ userid: '', memberships: [], membershipids: [], isloggedin: false });
    expect(people.calls.map((call) => call.query)).toEqual([{ siteid: SITE, endpoint: `http://${HOST}/index.cfm${API}`, adminpath: `http://${HOST}/admin` }]);
  });

  it("answers a member's findCurrentUser with people's read of their own user and identity's current membership ids, not a 401", async () => {
    const member = await inSession({ sub: nextId('E'), roles: [Roles.member] }, SITE, `Editor;${SITE};0,S2IsPublic;${SITE}`, EDITOR_GROUP);
    await gated(SITE, (tx) => repo.replaceMemberships(tx, { userId: member.sub, groupIds: [EDITOR_GROUP, ADMIN_GROUP] }));
    people.calls.length = 0;
    people.answer = { status: 200, headers: {}, body: { data: { userid: member.sub, isnew: 0, groupid: `${ADMIN_GROUP},${EDITOR_GROUP}` } } };

    const res = await send(app, 'GET', `${API}/findCurrentUser?fields=groupid`, await headersFor(member));

    expect(res.statusCode).toBe(200);
    expect(people.calls).toEqual([
      {
        service: 'people',
        method: 'GET',
        path: '/internal/v1/users/current',
        query: { siteid: SITE, endpoint: `http://${HOST}/index.cfm${API}`, adminpath: `http://${HOST}/admin`, fields: 'groupid', groupids: `${ADMIN_GROUP},${EDITOR_GROUP}` },
      },
    ]);
    expect(dataOf(res)).toEqual({
      userid: member.sub,
      isnew: 0,
      groupid: `${ADMIN_GROUP},${EDITOR_GROUP}`,
      memberships: [`Editor;${SITE};0`, `S2IsPublic;${SITE}`],
      membershipids: [EDITOR_GROUP],
      isloggedin: true,
    });
  });

  describe("findCurrentUser memberships of the token site's user pools", () => {
    /** A site with its own private pool whose public pool is `tenant-b`. */
    const SITE_POOLED = 'tenant-pooled-member';

    beforeAll(async () => {
      await withMetadata(handle.app, (tx) =>
        tx.query(
          `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
            ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $1, $3, $2, $4, 1, $5)',
          [SITE_POOLED, tenantIdForSite(SITE_POOLED), SITE_B, tenantIdForSite(SITE_B), NOW],
        ),
      );
    });

    it.each([
      ['a membership row whose group is stored in a registered tenant outside the pools', SITE, (): Array<[string, string]> => [[SITE, EDITOR_GROUP], [SITE, ids.visible]], (): string[] => [EDITOR_GROUP]],
      ['a membership row of the same user id stored in a registered tenant outside the pools', SITE, (): Array<[string, string]> => [[SITE, EDITOR_GROUP], [SITE_B, ADMIN_GROUP]], (): string[] => [EDITOR_GROUP]],
      ["a public-pool membership stored in the pool's tenant beside a row stored outside the pools", SITE_POOLED, (): Array<[string, string]> => [[SITE_B, ids.visible], [SITE, ADMIN_GROUP]], (): string[] => [ids.visible]],
    ])("sends people only the token site's user-pool groups past %s", async (_label, site, rows, expected) => {
      const member = await inSession({ sub: nextId('E'), roles: [Roles.member] }, site, '');
      for (const [rowSite, groupId] of rows()) await gated(rowSite, (tx) => repo.addMembership(tx, member.sub, groupId));
      people.calls.length = 0;
      people.answer = { status: 200, headers: {}, body: { data: { userid: member.sub } } };

      const res = await send(app, 'GET', `/_api/json/v1/${site}/findCurrentUser`, await headersFor(member));

      expect(res.statusCode).toBe(200);
      expect(people.calls.map((call) => call.query?.groupids)).toEqual([expected().join(',')]);
    });
  });

  describe('REST continuations of a registered site, whose sessionless events raise (jsonApiUtility.cfc:1486-1487)', () => {
    it.each<[string, Method, () => string, Record<string, string> | undefined, string]>([
      ['login', 'POST', () => '/login', { username: 'jsonapi-rest', password: 'x' }, 'login'],
      ['login with a lockdown check', 'POST', () => '/login', { username: 'jsonapi-rest', password: 'x', lockdowncheck: 'true' }, 'login'],
      ['logout', 'POST', () => '/logout', undefined, 'logout'],
      ['generateCSRFTokens', 'GET', () => '/generateCSRFTokens?context=cusers.update', undefined, 'generateCSRFTokens'],
      ['findCurrentUser', 'GET', () => '/findCurrentUser', undefined, 'findCurrentUser'],
      ['validateEmail', 'GET', () => '/validateEmail?email=a@example.test', undefined, 'validateEmail'],
      ['findOne', 'GET', () => `/group/${ids.helpers}`, undefined, 'findOne'],
      ['direct findAll, reported as spelled', 'GET', () => '/findall?entityname=group', undefined, 'findall'],
      ['findQuery', 'GET', () => '/group?groupname=Helpers', undefined, 'findQuery'],
      ['findMany', 'GET', () => `/group?id=${ADMIN_GROUP},${EDITOR_GROUP}`, undefined, 'findMany'],
      ['findNew', 'GET', () => '/group/new', undefined, 'findNew'],
      ['findProperties', 'GET', () => '/group/properties', undefined, 'findProperties'],
      ['findPermissions', 'GET', () => '/group/permissions', undefined, 'findPermissions'],
      ['findPermissions on the <id>/permissions path, which keeps params.method', 'GET', () => `/group/${ids.helpers}/permissions`, undefined, 'invalid'],
      ['validate', 'GET', () => '/validate?entityname=group&data=%7B%7D', undefined, 'validate'],
      ['validate of data that is not a struct', 'GET', () => '/validate?entityname=group&data=%5B1%5D', undefined, 'validate'],
    ])("answers %s with legacy's unhandled-exception 500 at its sessionless event, calling no service", async (_label, method, path, form, reported) => {
      const caller = await inSession(S2, SITE_C, 'S2');
      people.calls.length = 0;
      outbound.calls.length = 0;

      const res = await send(app, method, `/_api/rest/v1/${SITE_C}${path()}`, await headersFor(caller), form);

      expect(res.statusCode).toBe(500);
      expect(json(res)).toEqual(legacyError(reported, ERRORS.serverError));
      expect(res.headers.etag).toBe(etag(res.body));
      expect(people.calls).toEqual([]);
      expect(outbound.calls).toEqual([]);
      // Only logout runs before its envelope raises, deleting the remember-me cookies and ending the request's session.
      const loggedOut = reported === 'logout';
      expect(cookiesWithoutExpiry(res)).toEqual(loggedOut ? oracle('logoutAnonymous').deletedCookies : []);
      expect(await gated(SITE_C, (tx) => repo.findSession(tx, caller.sid ?? ''))).toMatchObject(loggedOut ? { user_id: null } : { state: 'active', user_id: S2.sub });
    });

    it('answers validate data that is not JSON with invalidParameters, raised before its event (jsonApiUtility.cfc:3705-3711)', async () => {
      const caller = await inSession(S2, SITE_C, 'S2');

      const res = await send(app, 'GET', `/_api/rest/v1/${SITE_C}/validate?entityname=group&data=notjson`, await headersFor(caller));

      expect(res.statusCode).toBe(400);
      expect(json(res)).toEqual(legacyError('validate', ERRORS.invalidParameters));
    });

    it('answers a group read with the 500 after a migrated token restored its session JSON, which raises nothing itself', async () => {
      const { rest } = routeDeps(handle.app, repo, people, outbound.fetch, SETTINGS);
      const token = nextId('T');
      const data = readFileSync(new URL('../fixtures/legacy/oauth-token-data.json', import.meta.url), 'utf8');
      const expires = new Date(NOW.getTime() + 3_600_000);
      await gated(SITE_C, (tx) => repo.insertToken(tx, { token, granttype: 'password', clientid: nextId('C'), userid: S2.sub, accesscode: null, data, expires }));
      const url = `/_api/rest/v1/${SITE_C}/group/${ids.helpers}`;

      const outcome = await authenticateRestRequest(rest, { path: url, httpMethod: 'GET', headers: { authorization: `Bearer ${token}` }, query: {}, params: {}, siteId: SITE_C });
      if (outcome.kind !== 'session') throw new Error(`expected a restored session, got ${outcome.status} ${outcome.body}`);
      const state = await sessionState(rest.sessions, outcome.sessionId);
      const res = await send(app, 'GET', url, await headersFor({ sub: state.userId, sid: outcome.sessionId, site: SITE_C, roles: [Roles.systemUser, USERS_MODULE] }));

      expect(state).toMatchObject({ state: 'active', userId: '7E3C1A20-5B4D-4F6E-8A9B0C1D2E3F4A5B' });
      expect(res.statusCode).toBe(500);
      expect(json(res)).toEqual(legacyError('findOne', ERRORS.serverError));
    });
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
      ['a direct S2 save posting type 2', S2, () => `/_api/json/v1/${SITE_C}/save`, (): Record<string, string> => ({ entityname: 'group', id: ids.helpers, type: '2', ...csrfFields(ids.helpers) }), 'group-save-user', /at userRecordRefused .*\\n\s+at save /],
      ["a Users-module editor's new group, whose stripped type stays the new bean's 2", USERS_EDITOR, () => GROUP_C, (): Record<string, string> => ({ groupname: 'Fresh', ...csrfFields('new') }), 'group-save-user', /at userRecordRefused .*\\n\s+at save /],
      ['an S2 save of an id naming a stored user', S2, () => `${GROUP_C}/${ids.userAccount}`, (): Record<string, string> => ({ groupname: 'Mine', ...csrfFields(ids.userAccount) }), 'group-api-user-record', /at userRecordRefused .*\\n\s+at loadedUserRefused /],
    ])('fails closed with the legacy 503 of EX-GROUP-USER-RECORD on %s, which writes a user record', async (_label, who, url, form, reason, frames) => {
      const caller = await inSession(who, SITE_C, who === S2 ? 'S2' : `Editor;${SITE_C};0`);
      const captured = capturingLogger();
      const logged = await buildApp(routeDeps(handle.app, repo, people, outbound.fetch, SETTINGS), captured.logger);
      try {
        const res = await send(logged, 'POST', url(), await headersFor(caller), form());

        expect(res.statusCode).toBe(503);
        expect(await groupOf(ids.helpers)).toMatchObject({ groupname: 'Helpers', isnew: 0 });
        // The logger redacts the message, whose entry the refusing helper names; its stack shows the helper and the refusing site.
        expect(captured.lines.find((line) => line.includes('service unavailable'))).toMatch(frames);
        expect(userRecordRefused('A case', reason)).toMatchObject({ message: 'A case is refused (EX-GROUP-USER-RECORD)', reason });
      } finally {
        await logged.opt2.shutdown();
      }
    });

    it.each([
      ['an entity-route save without a CSRF token', () => `/_api/rest/v1/${SITE_C}/group/${ids.helpers}`, false],
      ['an entity-route save from a session that has ended', () => `/_api/rest/v1/${SITE_C}/group/${ids.helpers}`, true],
      ['a direct save', () => `/_api/rest/v1/${SITE_C}/save`, false],
    ])("answers %s over REST with legacy's unhandled-exception 500, before any check or write (jsonApiUtility.cfc:1905)", async (_label, url, ended) => {
      const caller = await inSession(S2, SITE_C, 'S2');
      if (ended) await gated(SITE_C, (tx) => repo.updateSession(tx, caller.sid ?? '', { state: 'ended' }));

      const res = await send(app, 'POST', url(), await headersFor(caller), { entityname: 'group', id: ids.helpers, groupname: 'Late', remoteid: 'r-1' });

      expect(res.statusCode).toBe(500);
      expect(json(res)).toEqual(legacyError('save', ERRORS.serverError));
      expect(await groupOf(ids.helpers)).toMatchObject({ groupname: 'Helpers' });
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

const ALPHA = 'F0000000-0000-0000-0000000000000001';
const BETA = 'F0000000-0000-0000-0000000000000002';
const GAMMA = 'F0000000-0000-0000-0000000000000003';
const ORACLE_ADMIN = '3BE10CC9-9421-80A7-719F9D4816FA78E5';

/** A group of the oracle's `default` site: `columns` over empty values. */
function oracleGroup(userid: string, groupname: string, columns: Partial<GroupInput>): GroupInput {
  return {
    userid, groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 1, siteid: SITE,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '', ...columns,
  };
}

describe.skipIf(!available)('JSON API validate of the user and group beans against PostgreSQL (jsonApiUtility.cfc:3736-3805; userBean.cfc:446-500)', () => {
  const DELTA = 'F0000000-0000-0000-0000000000000004';
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let app: FastifyInstance;

  function gated<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(SITE), fn);
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const { schema } = handle;
    repo = createIdentityRepository({ clock: CLOCK, schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    createOutbox({ service: 'identity', db: handle.app, publisher: createCapturingPublisher(), logger: quietLogger(), clock: CLOCK, payloadValidators: identityPayloadValidators });
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $1, $1, $2, $2, 1, $3)',
        [SITE, tenantIdForSite(SITE), NOW],
      ),
    );
    // The oracle's default site: its system groups, the public groups the fixture answers read, and its two accounts.
    await gated(async (tx) => {
      await repo.insertGroup(tx, oracleGroup(ADMIN_GROUP, 'Admin', { perm: 1, subscribe: 0, ispublic: 0 }), null);
      await repo.insertGroup(tx, oracleGroup(EDITOR_GROUP, 'Editor', { password: 'stored-hash', contactform: '0', ispublic: 0 }), null);
      await repo.insertGroup(tx, oracleGroup(ALPHA, 'Alpha', { email: 'alpha@example.test', remoteid: 'r-a', tags: 'red,blue' }), null);
      await repo.insertGroup(tx, oracleGroup(BETA, 'Beta', { email: 'beta@example.test', remoteid: 'r-b', tags: 'red' }), null);
      await repo.insertGroup(tx, oracleGroup(GAMMA, 'Gamma', { inactive: 1, remoteid: 'r-c' }), null);
      await repo.insertGroup(tx, oracleGroup(DELTA, 'Delta', { remoteid: 'r-d' }), null);
      await repo.replaceGroupInterests(tx, { groupId: ALPHA, categoryIds: ['C0000000-0000-0000-0000000000000001', 'C0000000-0000-0000-0000000000000002'] });
      await repo.replaceGroupInterests(tx, { groupId: BETA, categoryIds: ['C0000000-0000-0000-0000000000000002'] });
      const extended = { siteid: SITE, attributevalue: 'v', remoteid: null, datetimevalue: null, numericvalue: null, stringvalue: 'v' };
      await repo.replaceGroupExtendData(tx, { groupId: DELTA, rows: [{ attributeId: 7, values: extended }] });
      // The install and the admin save stamped these audit columns on the oracle's system groups.
      await tx.query(
        `UPDATE ${schema}.group_account SET lastupdateby = CASE userid WHEN $2 THEN 'System' WHEN $3 THEN 'Admin User' END,` +
          ' lastupdatebyid = CASE userid WHEN $3 THEN $4 END WHERE tenant_id = $1',
        [tx.tenantId, ADMIN_GROUP, EDITOR_GROUP, ORACLE_ADMIN],
      );
      for (const [userid, username] of [[ORACLE_ADMIN, 'admin'], ['3BEC10FC-F5B5-5517-7E7F2072657EFB68', 'qa_editor']] as const) {
        await repo.insertAccount(tx, { userid, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: SITE, remoteid: '', tablist: '' });
      }
    });
    app = await buildApp(routeDeps(handle.app, repo, recordingPeople(), recordingFetch().fetch, SETTINGS));
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  it.each(validateAnswers('entity'))('answers the oracle entity validation %s as Masa 7.6.1 does', async (name) => {
    const answer = validateAnswer(name);

    const res = await send(app, 'GET', validatePath(answer), await headersFor(validateCaller(answer)));

    expectValidateAnswer(res, answer);
  });

  it.each(validateAnswers('loadby'))('answers the oracle loadby validation %s as Masa 7.6.1 does', async (name) => {
    const answer = validateAnswer(name);

    const res = await send(app, 'GET', validatePath(answer), await headersFor(validateCaller(answer)));

    expectValidateAnswer(res, answer);
  });

  it.each([...validateAnswers('entity', true), ...validateAnswers('loadby', true)])(
    'answers %s, which reads another owner, the session or one user record, with the legacy 503 of its exceptions entry',
    async (name) => {
      const answer = validateAnswer(name);

      const res = await send(app, 'GET', validatePath(answer), await headersFor(validateCaller(answer)));

      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ error: ERRORS.serverError });
    },
  );

  it.each([
    ['EX-GROUP-VALIDATE', 'validate-entity', { entityname: 'content' }],
    ['EX-GROUP-VALIDATE', 'validate-session-site', { bean: 'group', loadby: 'remoteid', remoteid: 'r-a', siteid: '' }],
    ['EX-GROUP-VALIDATE-DATA', 'validate-loadby-user', { bean: 'user', loadby: 'username', username: 'admin' }],
    ['EX-GROUP-VALIDATE-DATA', 'validate-user-record', { entityname: 'group', userid: ORACLE_ADMIN }],
    ['EX-GROUP-VALIDATE-DATA', 'validate-user-record', { bean: 'group', loadby: 'userid', userid: ORACLE_ADMIN }],
    ['EX-GROUP-VALIDATE-DATA', 'validate-user-record', { bean: 'user', loadby: 'groupid', groupid: ORACLE_ADMIN }],
    ['EX-GROUP-VALIDATE-DATA', 'validate-extended-data', { entityname: 'group', userid: DELTA }],
    ['EX-GROUP-VALIDATE-DATA', 'validate-extended-data', { bean: 'group', loadby: 'remoteid', remoteid: 'r-d' }],
  ])('refuses with the legacy 503 and logs %s for the %s case of %j', async (entry, reason, data) => {
    const captured = capturingLogger();
    const logged = await buildApp(routeDeps(handle.app, repo, recordingPeople(), recordingFetch().fetch, SETTINGS), captured.logger);
    try {
      const res = await send(logged, 'GET', `${API}/validate?entityname=group&data=${encodeURIComponent(JSON.stringify(data))}`, await headersFor(S2));

      expect(res.statusCode).toBe(503);
      // The logger redacts the message, whose entry the refusing helper names; its stack shows which one refused.
      const warning = captured.lines.find((line) => line.includes('service unavailable'));
      expect(warning).toContain(entry === 'EX-GROUP-VALIDATE' ? 'at validateHalted' : 'at validateRefused');
      expect([validateHalted, validateRefused].map((refusal) => refusal('A case', reason).message)).toContain(`A case ${entry === 'EX-GROUP-VALIDATE' ? 'stays on legacy' : 'is refused'} (${entry})`);
    } finally {
      await logged.opt2.shutdown();
    }
  });

  it('refuses a user or group bean validation under stricthtml, whose pass reads every property, and still answers ad hoc rules', async () => {
    const strict = await buildApp(routeDeps(handle.app, repo, recordingPeople(), recordingFetch().fetch, { ...SETTINGS, strictHtml: true }));
    try {
      const bean = await send(strict, 'GET', `${API}/validate?entityname=group&data=${encodeURIComponent(JSON.stringify({ entityname: 'group', userid: ALPHA }))}`, await headersFor(S2));
      const adHoc = validateAnswer('anon:adhoc');
      const rules = await send(strict, 'GET', validatePath(adHoc), await headersFor(validateCaller(adHoc)));

      expect(bean.statusCode).toBe(503);
      expectValidateAnswer(rules, adHoc);
    } finally {
      await strict.opt2.shutdown();
    }
  });
});


describe.skipIf(!available)('JSON API group feeds against PostgreSQL (userGateway.cfc:164-592; jsonApiUtility.cfc:2712-2920,4981-4996)', () => {
  const INTEREST_ONE = 'C0000000-0000-0000-0000000000000001';
  const INTEREST_TWO = 'C0000000-0000-0000-0000000000000002';
  const SEEDED = [ADMIN_GROUP, EDITOR_GROUP, ALPHA, BETA, GAMMA];
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const { schema } = handle;
    repo = createIdentityRepository({ clock: CLOCK, schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    createOutbox({ service: 'identity', db: handle.app, publisher: createCapturingPublisher(), logger: quietLogger(), clock: CLOCK, payloadValidators: identityPayloadValidators });
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $1, $1, $2, $2, 1, $3)',
        [SITE, tenantIdForSite(SITE), NOW],
      ),
    );
    // The oracle's default site: its system groups and the public groups with their tags, interests, addresses, favorite and membership.
    await withGatedTenant(handle.app, tenantIdForSite(SITE), async (tx) => {
      await repo.insertGroup(tx, oracleGroup(ADMIN_GROUP, 'Admin', { perm: 1, subscribe: 0, ispublic: 0 }), null);
      await repo.insertGroup(tx, oracleGroup(EDITOR_GROUP, 'Editor', { contactform: '0', ispublic: 0 }), null);
      await repo.insertGroup(tx, oracleGroup(ALPHA, 'Alpha', { email: 'alpha@example.test', remoteid: 'r-a', tags: 'red,blue' }), null);
      await repo.insertGroup(tx, oracleGroup(BETA, 'Beta', { email: 'beta@example.test', remoteid: 'r-b', tags: 'red' }), null);
      await repo.insertGroup(tx, oracleGroup(GAMMA, 'Gamma', { inactive: 1, remoteid: 'r-c' }), null);
      // The oracle's public groups carry the dates its seed wrote, and no password date or audit actor.
      await tx.query(
        `UPDATE ${schema}.group_account SET created = $3::timestamp + (CASE userid WHEN $4 THEN 1 WHEN $5 THEN 2 ELSE 0 END) * interval '1 day',` +
          ' lastupdate = $3::timestamp + (CASE userid WHEN $4 THEN 1 WHEN $5 THEN 2 ELSE 0 END) * interval \'1 day\', passwordcreated = NULL,' +
          ' lastupdateby = NULL, lastupdatebyid = NULL WHERE tenant_id = $1 AND userid = ANY($2::text[])',
        [tx.tenantId, [ALPHA, BETA, GAMMA], '2026-01-01 00:00:00', BETA, GAMMA],
      );
      // Migrated tag rows keep the oracle's IDENTITY values, which tuserstags.tagid criteria read.
      for (const [tagid, userid, tag] of [[1, ALPHA, 'red'], [2, ALPHA, 'blue'], [3, BETA, 'red']] as const) {
        await tx.query(`INSERT INTO ${schema}.user_tag (tenant_id, tagid, userid, siteid, tag) VALUES ($1, $2, $3, $4, $5)`, [tx.tenantId, tagid, userid, SITE, tag]);
      }
      await repo.replaceGroupInterests(tx, { groupId: ALPHA, categoryIds: [INTEREST_ONE, INTEREST_TWO] });
      await repo.replaceGroupInterests(tx, { groupId: BETA, categoryIds: [INTEREST_TWO] });
      for (const [userid, addressid, addressname, city, isprimary, longitude, latitude] of [
        [EDITOR_GROUP, '3BEA17DE-AC7A-6DA4-1E7D093F02DAF72E', 'Primary', '', 1, 0, 0],
        [ALPHA, 'D0000000-0000-0000-0000000000000001', 'HQ', 'Springfield', 1, null, null],
        [ALPHA, 'D0000000-0000-0000-0000000000000002', 'Branch', 'Shelbyville', 0, null, null],
        [BETA, 'D0000000-0000-0000-0000000000000003', 'Main', 'Ogdenville', 1, 1.5, -2.25],
      ] as const) {
        await repo.insertGroupAddress(tx, { userid, addressid, siteid: SITE, addressname, city, isprimary });
        await tx.query(`UPDATE ${schema}.user_address SET longitude = $3, latitude = $4 WHERE tenant_id = $1 AND addressid = $2`, [
          tx.tenantId,
          addressid,
          longitude,
          latitude,
        ]);
      }
      await tx.query(
        `INSERT INTO ${schema}.user_favorite (tenant_id, favoriteid, userid, favoritename, favorite, type, siteid, datecreated, columnnumber,` +
          " rownumber, maxrssitems) VALUES ($1, 'A0000000-0000-0000-0000000000000001', $2, 'Fav', 'x', 'Content', $3, '2026-01-05 00:00:00', 2, 3, 5)",
        [tx.tenantId, BETA, SITE],
      );
      await repo.replaceMemberships(tx, { userId: BETA, groupIds: [EDITOR_GROUP] });
    });
    app = await buildApp(routeDeps(handle.app, repo, recordingPeople(), recordingFetch().fetch, SETTINGS));
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  async function feedOf(name: string): Promise<Answer> {
    return send(app, 'GET', feedAnswer(name).path, await headersFor(S2));
  }

  it.each(feedAnswers('distinct'))('answers the oracle distinct feed %s, iterated as generic beans, as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED, [ALPHA, BETA, GAMMA]);
  });

  it.each(feedAnswers('aggregate'))('answers the oracle aggregate feed %s as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  it.each(feedAnswers('subquery'))('answers the oracle membership or interest filter %s as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  it.each(feedAnswers('join'))('answers the oracle joined feed %s as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  it.each(feedAnswers('table'))('answers the oracle reference to another table %s as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  it.each(feedAnswers('sort'))('answers the oracle ordering %s as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  it.each(feedAnswers('fields'))('answers the oracle field selection %s as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  it.each(feedAnswers('bracket'))('answers the oracle bracketed name %s as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  it.each(feedAnswers('setter'))('answers the oracle feed setter %s as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  it.each(feedAnswers('extended'))('answers the oracle name %s, which no request scope keeps, as Masa 7.6.1 does', async (name) => {
    expectFeedAnswer(await feedOf(name), feedAnswer(name), SEEDED);
  });

  /** Refusals of stored rows, SQL Server's plan over them or the database name (EX-GROUP-FEED-DATA); the rest stay on legacy (EX-GROUP-FEED). */
  const DATA_REFUSALS = new Set(['feed-join-sort-tie', 'feed-typed-param', 'feed-database-name']);
  const FEED_FAMILIES: ReadonlyArray<FeedAnswer['family']> = ['distinct', 'aggregate', 'subquery', 'join', 'table', 'sort', 'fields', 'bracket', 'setter', 'extended'];

  it.each(FEED_FAMILIES.flatMap((family) => feedAnswers(family, true)))(
    'answers %s, which reads another owner, the legacy runtime or the stored rows, with the legacy 503 its exceptions entry names',
    async (name) => {
      const captured = capturingLogger();
      const logged = await buildApp(routeDeps(handle.app, repo, recordingPeople(), recordingFetch().fetch, SETTINGS), captured.logger);
      try {
        const res = await send(logged, 'GET', feedAnswer(name).path, await headersFor(S2));

        expect(res.statusCode).toBe(503);
        expect(json(res)).toMatchObject({ error: ERRORS.serverError });
        // The logger redacts the message, whose entry the refusing helper names; its stack shows which one refused.
        const reason = feedAnswer(name).refusal ?? '';
        const data = DATA_REFUSALS.has(reason);
        expect(captured.lines.find((line) => line.includes('service unavailable'))).toContain(`at ${data ? 'feedRefused' : 'feedHalted'}`);
        expect((data ? feedRefused : feedHalted)('A case', reason).message).toBe(
          data ? 'A case is refused (EX-GROUP-FEED-DATA)' : 'A case stays on legacy (EX-GROUP-FEED)',
        );
      } finally {
        await logged.opt2.shutdown();
      }
    },
  );

  describe('with one group per cursor page', () => {
    let paged: FastifyInstance;
    let countedReads = 0;

    beforeAll(async () => {
      const pagedRepo = createIdentityRepository({ clock: CLOCK, schema: handle.schema, pageSize: 1 });
      const counting: IdentityRepository = {
        ...pagedRepo,
        listCountedGroups: (...args) => {
          countedReads += 1;
          return pagedRepo.listCountedGroups(...args);
        },
      };
      paged = await buildApp(routeDeps(handle.app, counting, recordingPeople(), recordingFetch().fetch, SETTINGS));
    });

    afterAll(async () => {
      await paged?.opt2.shutdown();
    });

    it.each(FEED_FAMILIES.flatMap((family) => [...feedAnswers(family), ...feedAnswers(family, true)]))(
      'answers %s as it does from a single page, its child rows read page by page and no member count loaded',
      async (name) => {
        const answer = feedAnswer(name);

        const res = await send(paged, 'GET', answer.path, await headersFor(S2));

        if (answer.refusal === undefined) expectFeedAnswer(res, answer, SEEDED, answer.family === 'distinct' ? [ALPHA, BETA, GAMMA] : []);
        else expect([res.statusCode, res.body]).toEqual([503, (await feedOf(name)).body]);
        expect(countedReads).toBe(0);
      },
    );
  });

});
