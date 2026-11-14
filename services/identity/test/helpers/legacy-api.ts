/** Shared fixtures of the identity JSON API suites: Masa 7.6.1 oracle answers and their checks, callers, recording doubles and the route app for `app.inject`. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { etag } from '@opt2/platform/legacy-compat';
import { createLogger, type LogFn, type Logger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, fixedClock, mintServiceToken, mintUserToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { DEFAULT_LOGIN_SETTINGS, type LoginDeps } from '../../src/domain/login.js';
import type { SessionDeps } from '../../src/domain/sessions.js';
import { createIdentityEvents } from '../../src/events/publish.js';
import type { BridgeRelay } from '../../src/legacy/bridge-relay.js';
import type { IdentityRepository } from '../../src/repo/repository.js';
import { registerLegacyApiRoutes, type LegacyApiRouteDeps, type LegacyApiSettings } from '../../src/routes/legacy-api.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One legacy answer of `test/fixtures/legacy/json-api-answers.json`. */
export interface OracleAnswer {
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
export interface Answer {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

/** The verified caller a user token carries. */
export interface Caller {
  sub: string;
  roles: readonly string[];
  sid?: string;
  site?: string;
}

/** A people client that records each call and answers with `answer`. */
export type RecordingPeople = ServiceClient & { calls: ServiceRequest[]; answer: ServiceResponse };

/** validateEmail's outbound call, recording each request and answering with `reply`. */
export interface RecordingFetch {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; method: string | undefined }>;
  reply: () => Promise<Response>;
}

export const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const ORACLE = (
  JSON.parse(readFileSync(new URL('../fixtures/legacy/json-api-answers.json', import.meta.url), 'utf8')) as { answers: Record<string, OracleAnswer> }
).answers;
export const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
export const CLOCK = fixedClock(NOW);
export const HOST = 'localhost:8080';
export const SITE = 'default';
export const SITE_B = 'tenant-b';
export const API = `/_api/json/v1/${SITE}`;
export const ADMIN_GROUP = '3BE10D43-C960-A7E5-0FB807B791D31787';
export const EDITOR_GROUP = '3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D';
export const USERS_MODULE = 'm:008';
const FORM_BODY = { 'content-type': 'application/x-www-form-urlencoded' };
export const LEGACY_JSON_TYPE = 'application/json;charset=utf-8';
export const SETTINGS: LegacyApiSettings = Object.freeze({ adminSSL: false, context: '', appReloadKey: 'appreload', adminDomain: '' });
const FAST_LOGIN: LoginDeps['settings'] = { password: { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: 4 }, strikes: DEFAULT_LOGIN_SETTINGS.strikes };
const RELAY: BridgeRelay = { markUsed: () => Promise.resolve({ applied: true }) };
const noSleep = (): Promise<void> => Promise.resolve();

export const S2: Caller = { sub: 'A0000000-0000-0000-0000000000000001', roles: [Roles.s2, Roles.systemUser] };
export const SITE_ADMIN: Caller = { sub: 'A0000000-0000-0000-0000000000000002', roles: [Roles.siteAdmin, Roles.systemUser] };
export const USERS_EDITOR: Caller = { sub: 'A0000000-0000-0000-0000000000000003', roles: [Roles.systemUser, USERS_MODULE] };
export const MODULE_ONLY: Caller = { sub: 'A0000000-0000-0000-0000000000000004', roles: [USERS_MODULE] };
export const MEMBER: Caller = { sub: 'A0000000-0000-0000-0000000000000005', roles: [Roles.member] };

export const ERRORS = {
  authorization: { message: 'Insufficient Account Permissions', code: 'invalid_request' },
  invalidMethodCall: { message: 'Invalid method call', code: 'invalid_request' },
  invalidParameters: { message: 'Invalid parameters', code: 'invalid_request' },
  invalidTokens: { message: 'Invalid CSRF tokens', code: 'invalid_request' },
  serverError: { message: 'Unhandled Exception', code: 'server_error' },
} as const;

/** The legacy error envelope of `method`. */
export function legacyError(method: string, error: (typeof ERRORS)[keyof typeof ERRORS]): Record<string, unknown> {
  return { apiversion: 'v1', method, error };
}

/** Anonymous oracle answers whose request reads data beyond the registry; every admin answer does too. */
const ANONYMOUS_DATA_ANSWERS = new Set(['findOneDenied', 'restOauthUnknownClient', 'restTokenInfoUnknownToken']);
export const MEMORY_ANSWERS = Object.keys(ORACLE).filter((name) => ORACLE[name]?.caller === 'anonymous' && !ANONYMOUS_DATA_ANSWERS.has(name));
export const DATA_ANSWERS = Object.keys(ORACLE).filter((name) => !MEMORY_ANSWERS.includes(name));

/** An oracle answer of `validate` (fixture json-api-validate-answers.json); `refusal` marks a case identity answers with the legacy 503. */
export interface ValidateAnswer {
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
export function validateAnswers(family: ValidateAnswer['family'], refused = false): string[] {
  return Object.keys(VALIDATE_ORACLE).filter((name) => VALIDATE_ORACLE[name]?.family === family && (VALIDATE_ORACLE[name]?.refusal !== undefined) === refused);
}

export function validateAnswer(name: string): ValidateAnswer {
  const answer = VALIDATE_ORACLE[name];
  if (answer === undefined) throw new Error(`no validate answer ${name}`);
  return answer;
}

/** The request path of a validate answer. */
export function validatePath(answer: ValidateAnswer): string {
  const validations = answer.validations === undefined ? '' : `&validations=${encodeURIComponent(answer.validations)}`;
  return `${API}/validate?entityname=group&data=${encodeURIComponent(answer.data)}${validations}`;
}

/** The caller of a validate answer: the oracle's admin is S2. */
export function validateCaller(answer: ValidateAnswer): Caller | undefined {
  return answer.caller === 'admin' ? S2 : undefined;
}

/** Asserts that `res` answers as the oracle did: status, content type, parsed envelope with its `data` keys in order, and ETag rule. */
export function expectValidateAnswer(res: Answer, answer: ValidateAnswer): void {
  const expected = JSON.parse(answer.body) as { data?: unknown };
  expect(res.statusCode).toBe(answer.status);
  expect(res.headers['content-type']).toBe(answer.contentType);
  expect(json(res)).toEqual(expected);
  if (typeof expected.data === 'object' && expected.data !== null) expect(Object.keys(dataOf(res))).toEqual(Object.keys(expected.data));
  expect(res.headers.etag).toBe(answer.hasEtag ? etag(res.body) : undefined);
}

export function oracle(name: string): OracleAnswer {
  const answer = ORACLE[name];
  if (answer === undefined) throw new Error(`no oracle answer ${name}`);
  return answer;
}

/** The request path of an oracle answer. */
export function oraclePath(answer: OracleAnswer): string {
  return answer.request.replace(/^GET /, '');
}

export function quietLogger(): Logger {
  return createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
}

/** A logger that keeps the arguments of every log call, on it and its children, and every line it writes. */
export function capturingLogger(): { logger: Logger; calls: unknown[][]; lines: string[] } {
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

export function recordingPeople(): RecordingPeople {
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

export function recordingFetch(): RecordingFetch {
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
export function cookiesWithoutExpiry(res: Answer): string[] {
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

/** Asserts that `res` answers as the oracle did: status, content type, parsed body less `omit`, ETag rule and `WWW-Authenticate`. */
export function expectOracleAnswer(res: Answer, answer: OracleAnswer, body = res.body, omit: readonly string[] = []): void {
  expect(res.statusCode).toBe(answer.status);
  expect(res.headers['content-type']).toBe(answer.contentType);
  expect(envelopeWithout(body, omit)).toEqual(envelopeWithout(answer.body, omit));
  expect(res.headers.etag).toBe(answer.hasEtag ? etag(res.body) : undefined);
  expect(res.headers['www-authenticate']).toBe(answer.wwwAuthenticate);
  if (answer.deletedCookies !== undefined) expect(cookiesWithoutExpiry(res)).toEqual(answer.deletedCookies);
}

let stateDir: string;
let gatewayToken: string;

/** Headers of a gateway-relayed call, with a user token for `caller` when given. */
export async function headersFor(caller?: Caller): Promise<Record<string, string>> {
  const headers: Record<string, string> = { [INVOCATION_HEADER]: `Bearer ${gatewayToken}` };
  if (caller !== undefined) {
    headers.authorization = `Bearer ${await mintUserToken({ sub: caller.sub, sid: caller.sid, site: caller.site ?? SITE, roles: caller.roles })}`;
  }
  return headers;
}

/** Injects a call from host `localhost:8080`, form fields as a form post, and checks the answer against the contract. */
export async function send(
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

export function json(res: Answer): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

/** The `data` struct of an envelope answer. */
export function dataOf(res: Answer): Record<string, unknown> {
  return json(res).data as Record<string, unknown>;
}

/** The JSON API route dependencies over `db`, with `legacy` settings or, when undefined, the `MURA_<KEY>` environment. */
export function routeDeps(db: TenantDb, repo: IdentityRepository, client: ServiceClient, fetch: typeof globalThis.fetch, legacy?: LegacyApiSettings): LegacyApiRouteDeps {
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
export async function buildApp(deps: LegacyApiRouteDeps, logger: Logger = quietLogger(), noCasePathPrefixes: readonly string[] = []): Promise<FastifyInstance> {
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

/** Registers the file hooks that write the test secrets {@link buildApp} reads and mint the gateway token {@link headersFor} sends. */
export function registerLegacyApiState(): void {
  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-legacy-api-'));
    await writeTestSecrets(stateDir);
    gatewayToken = await mintServiceToken({ caller: 'gateway', audience: 'identity' });
  });

  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
}
