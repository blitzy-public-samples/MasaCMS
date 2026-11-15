/** In-process authorisation of the composed migration service through buildApp: contract routes, the subject matrix, transport separation and start-up. */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  AuthDenial,
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  Roles,
  SYNTHETIC_ROLES,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  hasAnyRole,
  isServiceRole,
  renderAuthDenial,
  rolesForService,
  serviceRole,
  type Opt2RouteConfig,
  type RouteMatrixEntry,
} from '@opt2/platform/auth';
import { createService, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  ROLE_SET,
  TENANT_A,
  TEST_PUSH_KEY,
  authHeadersFor,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  subjectQueryFor,
  testVerifier,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';

import { MIGRATION_ROUTES } from '../../src/routes/index.js';
import { buildApp } from '../../src/server.js';
import { buildTestContext, type TestContext } from '../helpers/context.js';

type Headers = Record<string, string>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const SERVICE_NAME = 'migration';
const SITE_A = TENANT_A.siteId;
const DENIED: ReadonlySet<number> = new Set([401, 403]);
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT']);
const JSON_HEADERS: Readonly<Headers> = Object.freeze({ 'content-type': 'application/json' });
const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;
const CONTRACT_URL = new URL('../../contracts/openapi.yaml', import.meta.url);
const CONTRACT_METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as const;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const CONTRACT_OPERATION_IDS = [
  'healthz',
  'windowOpen',
  'windowComplete',
  'windowGet',
  'windowResolve',
  'projectionAwait',
  'unitAuthority',
  'legacyStepRun',
  'gatesList',
  'transitionStart',
  'transitionGet',
  'schedulerStateGet',
  'schedulerStateImport',
  'backgroundSuspend',
  'backgroundResume',
  'faultSet',
  'faultClear',
] as const;

/** One contract operation of the migration service: its contract `path`, Fastify `url` and auth declaration. */
interface ExpectedRoute {
  operationId: (typeof CONTRACT_OPERATION_IDS)[number];
  method: Method;
  path: string;
  url: string;
  requires?: readonly string[];
  public?: true;
  siteCheck: boolean;
}

const GATEWAY = serviceRole('gateway');
const PROGRAMS_SITES = serviceRole('programs-sites');
const OPERATOR = Roles.platformOperator;

const EXPECTED_ROUTES: readonly ExpectedRoute[] = [
  { operationId: 'healthz', method: 'GET', path: '/healthz', url: '/healthz', public: true, siteCheck: true },
  {
    operationId: 'windowOpen',
    method: 'POST',
    path: '/internal/v1/windows',
    url: '/internal/v1/windows',
    requires: [GATEWAY, OPERATOR],
    siteCheck: false,
  },
  {
    operationId: 'windowGet',
    method: 'GET',
    path: '/internal/v1/windows/{windowId}',
    url: '/internal/v1/windows/:windowId',
    requires: [OPERATOR, GATEWAY],
    siteCheck: true,
  },
  {
    operationId: 'windowComplete',
    method: 'POST',
    path: '/internal/v1/windows/{windowId}:complete',
    url: '/internal/v1/windows/:windowId(^[^:/]+)::complete',
    requires: [GATEWAY, OPERATOR],
    siteCheck: true,
  },
  {
    operationId: 'windowResolve',
    method: 'POST',
    path: '/internal/v1/windows/{windowId}:resolve',
    url: '/internal/v1/windows/:windowId(^[^:/]+)::resolve',
    requires: [OPERATOR],
    siteCheck: true,
  },
  {
    operationId: 'projectionAwait',
    method: 'POST',
    path: '/internal/v1/projection/await',
    url: '/internal/v1/projection/await',
    requires: [GATEWAY],
    siteCheck: true,
  },
  {
    operationId: 'unitAuthority',
    method: 'GET',
    path: '/internal/v1/authority',
    url: '/internal/v1/authority',
    requires: [PROGRAMS_SITES, GATEWAY, OPERATOR],
    siteCheck: true,
  },
  {
    operationId: 'legacyStepRun',
    method: 'POST',
    path: '/internal/v1/legacy-steps',
    url: '/internal/v1/legacy-steps',
    requires: [PROGRAMS_SITES],
    siteCheck: false,
  },
  { operationId: 'gatesList', method: 'GET', path: '/internal/v1/gates', url: '/internal/v1/gates', requires: [OPERATOR], siteCheck: true },
  {
    operationId: 'transitionStart',
    method: 'POST',
    path: '/internal/v1/transitions',
    url: '/internal/v1/transitions',
    requires: [OPERATOR],
    siteCheck: true,
  },
  {
    operationId: 'transitionGet',
    method: 'GET',
    path: '/internal/v1/transitions/{transitionId}',
    url: '/internal/v1/transitions/:transitionId',
    requires: [OPERATOR],
    siteCheck: true,
  },
  {
    operationId: 'schedulerStateGet',
    method: 'GET',
    path: '/internal/v1/scheduler/state',
    url: '/internal/v1/scheduler/state',
    requires: [OPERATOR],
    siteCheck: true,
  },
  {
    operationId: 'schedulerStateImport',
    method: 'POST',
    path: '/internal/v1/scheduler/state:import',
    url: '/internal/v1/scheduler/state::import',
    requires: [OPERATOR],
    siteCheck: true,
  },
  {
    operationId: 'backgroundSuspend',
    method: 'POST',
    path: '/internal/v1/background:suspend',
    url: '/internal/v1/background::suspend',
    requires: [OPERATOR],
    siteCheck: true,
  },
  {
    operationId: 'backgroundResume',
    method: 'POST',
    path: '/internal/v1/background:resume',
    url: '/internal/v1/background::resume',
    requires: [OPERATOR],
    siteCheck: true,
  },
  { operationId: 'faultSet', method: 'PUT', path: '/internal/v1/faults/{name}', url: '/internal/v1/faults/:name', requires: [OPERATOR], siteCheck: true },
  {
    operationId: 'faultClear',
    method: 'DELETE',
    path: '/internal/v1/faults/{name}',
    url: '/internal/v1/faults/:name',
    requires: [OPERATOR],
    siteCheck: true,
  },
];

/** Every route but `/healthz`: the routes the service transport guards with roles. */
const SERVICE_ROWS = EXPECTED_ROUTES.filter((row) => row.public !== true);

function rowNamed(operationId: string): ExpectedRoute {
  const row = EXPECTED_ROUTES.find((candidate) => candidate.operationId === operationId);
  if (row === undefined) throw new TypeError(`EXPECTED_ROUTES has no ${operationId}`);
  return row;
}

function subjectNamed(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`ROLE_SET has no ${name}`);
  return subject;
}

/** `row` as the route matrix records it, `requires` sorted. */
function matrixEntryOf(row: ExpectedRoute): RouteMatrixEntry {
  return {
    method: row.method,
    url: row.url,
    transport: 'service',
    ...(row.public === true ? { public: true as const } : { requires: [...(row.requires ?? [])].sort() }),
    siteCheck: row.siteCheck,
  };
}

/** `entry` with `requires` sorted, so declarations compare as role sets. */
function asRoleSet(entry: RouteMatrixEntry): RouteMatrixEntry {
  return entry.requires === undefined ? entry : { ...entry, requires: [...entry.requires].sort() };
}

const byMethodAndUrl = (a: RouteMatrixEntry, b: RouteMatrixEntry): number =>
  `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`, 'en');

const SAMPLE_PARAMS: Readonly<Record<string, string>> = { windowId: 'W-AUTHZ-0001', transitionId: 'T-AUTHZ-0001', name: 'projector-delay' };

/** `row.path` with each `{param}` replaced by its fixed sample; `:complete`-style suffixes are kept. */
function concretePath(row: ExpectedRoute): string {
  return row.path.replace(/\{(\w+)\}/g, (_match, name: string) => SAMPLE_PARAMS[name] ?? 'authz-sample');
}

/** A loopback TCP listener standing in for PostgreSQL: it counts every connection and drops it at once. */
interface DatabaseSentinel {
  port: number;
  connections(): number;
  close(): Promise<void>;
}

/** Starts a {@link DatabaseSentinel} on an ephemeral `127.0.0.1` port. */
async function startSentinel(): Promise<DatabaseSentinel> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('The database sentinel has no TCP address');
  return {
    port: address.port,
    connections: () => connections,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

let sentinel: DatabaseSentinel;
let tc: TestContext;
let app: FastifyInstance;

/** Everything a request can reach beyond the app: the gateway, bridge and owner doubles, legacy SQL Server and the `migration` schema. */
interface Effects {
  gatewayCalls: number;
  bridgeRequests: number;
  callLog: number;
  legacyStatements: number;
  legacyCommits: number;
  databaseConnections: number;
}

/** A snapshot of {@link Effects}. */
function effects(): Effects {
  return {
    gatewayCalls: tc.gateway.calls.length,
    bridgeRequests: (tc.bridge?.calls.length ?? 0) + (tc.bridge?.rejected.length ?? 0),
    callLog: tc.log.entries.length,
    legacyStatements: tc.legacy.statements.length,
    legacyCommits: tc.legacy.commits.length,
    databaseConnections: sentinel.connections(),
  };
}

const SETTLE_QUIET_MS = 50;
const SETTLE_LIMIT_MS = 5_000;

/** Waits until no effect changed for {@link SETTLE_QUIET_MS}, so work an admitted handler left running lands before later probes. */
async function settle(): Promise<void> {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  let last = effects();
  for (;;) {
    await sleep(SETTLE_QUIET_MS);
    const current = effects();
    if (isDeepStrictEqual(current, last)) return;
    if (Date.now() > deadline) throw new Error(`Effects still changing after ${String(SETTLE_LIMIT_MS)} ms: ${JSON.stringify(current)}`);
    last = current;
  }
}

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Headers> }>();
// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `authHeadersFor(subject)` on tenant-a addressed to the migration service, reused while its tokens are fresh. */
function credentialsOf(subject: RoleSubject): Promise<Headers> {
  const cached = credentialCache.get(subject.name);
  if (cached !== undefined && Date.now() - cached.mintedAt < CREDENTIAL_REUSE_MS) return cached.headers;
  const headers = authHeadersFor(subject, { site: SITE_A, audience: SERVICE_NAME });
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

/** `X-Serverless-Authorization` carrying `caller`'s local service token addressed to `audience`. */
async function invocationHeaders(caller: string, audience: string = SERVICE_NAME): Promise<Headers> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience })}` };
}

/** A tenant-a user token of `roles`. */
function userToken(roles: readonly string[]): Promise<string> {
  return mintUserToken({ sub: 'test-authz-user', tid: TENANT_A.tenantId, site: SITE_A, roles });
}

/** One concrete request; credentials are added when it is sent. */
interface ProbeRequest {
  method: Method;
  url: string;
  payload?: string;
  headers?: Headers;
}

/** `row` at its concrete path; POST and PUT carry `payload` as JSON, `{}` by default, so an admitted handler stops at validation. */
function requestFor(row: ExpectedRoute, payload = '{}'): ProbeRequest {
  const url = concretePath(row);
  return BODY_METHODS.has(row.method) ? { method: row.method, url, payload, headers: { ...JSON_HEADERS } } : { method: row.method, url };
}

/** What one request answered and left behind. */
interface Outcome {
  status: number;
  body: string;
  headers: Headers;
  /** Query the request was sent with, which a denial echoes as `params`. */
  query: Headers;
  before: Effects;
  after: Effects;
}

function withQuery(url: string, query: Headers): string {
  const search = new URLSearchParams(query).toString();
  return search === '' ? url : `${url}${url.includes('?') ? '&' : '?'}${search}`;
}

function headerStrings(res: InjectResponse): Headers {
  return Object.fromEntries(Object.entries(res.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]));
}

/** Sends `request` with `credentials` and `query` and records its answer and effects. */
async function send(request: ProbeRequest, credentials: Headers, query: Headers = {}): Promise<Outcome> {
  const before = effects();
  const res = await app.inject({
    method: request.method,
    url: withQuery(request.url, query),
    headers: { ...request.headers, ...credentials },
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  });
  return { status: res.statusCode, body: res.body, headers: headerStrings(res), query, before, after: effects() };
}

function parsedBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `body` is the legacy JSON API error envelope `{apiversion, method, params?, error: {code, message}}`; empty params are left out. */
function isErrorEnvelope(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.error) || !(body.params === undefined || isRecord(body.params))) return false;
  const { apiversion, method, error } = body;
  return typeof apiversion === 'string' && typeof method === 'string' && typeof error.code === 'string' && typeof error.message === 'string';
}

const UNAUTHENTICATED = AuthDenial.unauthenticated('missing-credential');
const INVALID_CREDENTIAL = AuthDenial.unauthenticated('invalid-credential');
const DENIAL_KINDS: readonly AuthDenial[] = [UNAUTHENTICATED, AuthDenial.invalidToken(), AuthDenial.expiredToken(), AuthDenial.forbidden()];
const UNAUTHENTICATED_CODES: ReadonlySet<unknown> = new Set(['invalid_request', 'invalid_token']);

/** The response renderAuthDenial gives `denial` for a request sent with `query`. */
function renderedFor(denial: AuthDenial, query: Headers): { status: number; body: string; headers: Record<string, string> } {
  const rendered = renderAuthDenial(denial, { query } as unknown as FastifyRequest);
  return { status: rendered.status, body: String(rendered.body), headers: rendered.headers };
}

/** Every way `outcome` departs from `denial` as the auth hooks answer it: status, envelope, exact body, headers and no effect. */
function denialProblems(outcome: Outcome, denial: AuthDenial): string[] {
  const rendered = renderedFor(denial, outcome.query);
  const problems: string[] = [];
  if (outcome.status !== rendered.status) problems.push(`answered ${outcome.status}, expected ${rendered.status}: ${outcome.body.slice(0, 160)}`);
  const body = parsedBody(outcome.body);
  if (!isErrorEnvelope(body)) problems.push(`not the legacy error envelope: ${outcome.body.slice(0, 160)}`);
  const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  if (outcome.status === 401 && !UNAUTHENTICATED_CODES.has(code)) problems.push(`401 with error code ${String(code)}`);
  if (outcome.body !== rendered.body) problems.push(`body ${outcome.body.slice(0, 160)} is not ${rendered.body}`);
  for (const [name, value] of Object.entries(rendered.headers)) {
    const sent = outcome.headers[name.toLowerCase()];
    if (sent !== value) problems.push(`header ${name} is ${String(sent)}, not ${value}`);
  }
  const changed = (Object.keys(outcome.after) as Array<keyof Effects>).filter((key) => outcome.after[key] !== outcome.before[key]);
  if (changed.length > 0) problems.push(`denial changed ${changed.join(', ')}`);
  return problems;
}

/** Every way an admitted `outcome` of `row` looks refused: a 401 or 403, any auth-denial body, or a health check other than 200. */
function admissionProblems(row: ExpectedRoute, outcome: Outcome): string[] {
  if (DENIED.has(outcome.status)) return [`expected admission, answered ${outcome.status}: ${outcome.body.slice(0, 160)}`];
  const problems: string[] = [];
  if (DENIAL_KINDS.some((denial) => renderedFor(denial, outcome.query).body === outcome.body)) {
    problems.push(`admitted with an auth-denial body: ${outcome.body.slice(0, 160)}`);
  }
  if (row.public === true && outcome.status !== 200) problems.push(`health check answered ${outcome.status}: ${outcome.body.slice(0, 160)}`);
  return problems;
}

/** The credentials a subject's headers present, as the service transport reads them. */
interface Presented {
  /** Roles of the verified invocation credential; absent when none reaches the route. */
  invocation?: readonly string[];
  /** Non-workload roles of the user token. */
  userRoles?: readonly string[];
  /** A bearer in `Authorization` that is no user token. */
  foreignBearer?: true;
}

/** What `authHeadersFor(subject)` presents: users arrive with the gateway's invocation credential, the push identity with none. */
function presentedBy(subject: RoleSubject): Presented {
  if (subject.kind === 'anonymous') return {};
  if (subject.kind === 'user') {
    return { invocation: rolesForService('gateway'), userRoles: subject.roles.filter((role) => !isServiceRole(role)) };
  }
  if (subject.caller === 'pubsub-invoker') return {};
  if (subject.caller === 'tasks-invoker') return { foreignBearer: true };
  return { invocation: subject.roles };
}

/** The denial the service transport and `row`'s roles give `subject`; undefined when the subject is admitted. */
function expectedDenial(row: ExpectedRoute, subject: RoleSubject): AuthDenial | undefined {
  const { invocation, userRoles = [], foreignBearer } = presentedBy(subject);
  if (invocation === undefined && row.public !== true) return UNAUTHENTICATED;
  // The service transport verifies any Authorization bearer as a user token, so a tasks token is refused on /healthz too.
  if (foreignBearer === true) return AuthDenial.invalidToken();
  if (row.public === true) return undefined;
  return hasAnyRole([...userRoles, ...(invocation ?? [])], row.requires ?? []) ? undefined : AuthDenial.forbidden();
}

/** One route × subject cell of the matrix, with the denial it must answer, if any. */
interface Cell {
  row: ExpectedRoute;
  subject: RoleSubject;
  denial: AuthDenial | undefined;
}

const CELLS: readonly Cell[] = EXPECTED_ROUTES.flatMap((row) =>
  ROLE_SET.map((subject) => ({ row, subject, denial: expectedDenial(row, subject) })),
);

function titleOf(cell: Cell): string {
  const verdict = cell.denial === undefined ? 'allows' : `denies (${cell.denial.statusCode})`;
  return `${cell.row.method} ${cell.row.path} ${verdict} ${cell.subject.name}`;
}

function cellOf(operationId: string, subjectName: string): Cell {
  const cell = CELLS.find((candidate) => candidate.row.operationId === operationId && candidate.subject.name === subjectName);
  if (cell === undefined) throw new TypeError(`no cell for ${subjectName} on ${operationId}`);
  return cell;
}

/** A probed cell's status and every way it departed from its expectation. */
interface Verdict {
  status: number;
  problems: string[];
}

/** Sends `cell`'s probe with the subject's credentials and judges the outcome. */
async function verdictOf(cell: Cell): Promise<Verdict> {
  const outcome = await send(requestFor(cell.row), await credentialsOf(cell.subject), subjectQueryFor(cell.subject));
  const problems = cell.denial === undefined ? admissionProblems(cell.row, outcome) : denialProblems(outcome, cell.denial);
  return { status: outcome.status, problems };
}

/** A contract operation's method, path and auth declaration. */
interface ContractOperation {
  operationId: string;
  method: string;
  path: string;
  transport: unknown;
  requires: unknown;
  public: unknown;
  siteCheck: unknown;
}

/** Every operation of `migration/contracts/openapi.yaml` with its `x-opt2-*` declaration, ordered by operationId. */
async function contractOperations(): Promise<ContractOperation[]> {
  const contract = parse(await readFile(CONTRACT_URL, 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(contract.paths)
    .flatMap(([path, item]) =>
      CONTRACT_METHODS.flatMap((method) => {
        const operation = item[method];
        if (!isRecord(operation)) return [];
        return [
          {
            operationId: String(operation.operationId),
            method: method.toUpperCase(),
            path,
            transport: operation['x-opt2-transport'],
            requires: operation['x-opt2-requires'],
            public: operation['x-opt2-public'],
            siteCheck: operation['x-opt2-site-check'] ?? true,
          },
        ];
      }),
    )
    .sort((a, b) => a.operationId.localeCompare(b.operationId, 'en'));
}

/** The table's rows in the shape of {@link contractOperations}. */
function tableOperations(): ContractOperation[] {
  return EXPECTED_ROUTES.map((row) => ({
    operationId: row.operationId,
    method: row.method,
    path: row.path,
    transport: 'service',
    requires: row.requires,
    public: row.public,
    siteCheck: row.siteCheck,
  })).sort((a, b) => a.operationId.localeCompare(b.operationId, 'en'));
}

beforeAll(async () => {
  sentinel = await startSentinel();
  tc = await buildTestContext({
    env: {
      PG_HOST: '127.0.0.1',
      PG_PORT: String(sentinel.port),
      PG_DATABASE: 'opt2_migration_authz',
      PG_USER: 'migration_app',
      // Never sent: the sentinel drops every connection before PostgreSQL would ask for it.
      PG_PASSWORD: ['authz', 'sentinel', 'unused'].join('-'),
      LOG_LEVEL: 'fatal',
    },
    migrationDb: false,
  });
  app = await buildApp({
    env: tc.ctx.env,
    clock: tc.clock,
    verifierOverride: testVerifier(SERVICE_NAME),
    legacy: tc.ctx.legacy,
    owners: tc.ctx.owners,
    gateway: tc.ctx.gateway,
    bridge: tc.ctx.bridge,
    startBackground: false,
  });
}, 120_000);

afterAll(async () => {
  // shutdown() also closes the service client and the sentinel-backed pool that app.close() leaves open.
  await app?.opt2.shutdown();
  await tc?.close();
  await sentinel?.close();
});

describe('route declarations', () => {
  it('every origin the composed app can reach is loopback', () => {
    const { env } = tc.ctx;
    const urls = [
      env.LEGACY_ORIGIN,
      env.OPT2_JWKS_URL,
      env.OPT2_GATEWAY_URL,
      env.OPT2_MIGRATION_URL,
      env.OTEL_EXPORTER_OTLP_ENDPOINT,
      ...Object.values(env.OPT2_SERVICE_URLS ?? {}),
    ];
    const hosts = [
      ...urls.filter((url): url is string => url !== undefined).map((url) => new URL(url).hostname),
      ...[env.PUBSUB_EMULATOR_HOST].filter((host): host is string => host !== undefined).map((host) => new URL(`http://${host}`).hostname),
      env.PG_HOST,
      env.MURA_DBHOST,
    ];
    expect(hosts.filter((host) => host === undefined || !LOOPBACK_HOSTS.has(host))).toEqual([]);
    expect({ host: env.PG_HOST, port: env.PG_PORT }).toEqual({ host: '127.0.0.1', port: sentinel.port });
  });

  it('declares exactly the seventeen contract operations', () => {
    const ids = EXPECTED_ROUTES.map((row) => row.operationId);
    expect({ rows: ids.length, unique: new Set(ids).size }).toEqual({ rows: 17, unique: 17 });
    expect([...ids].sort()).toEqual([...CONTRACT_OPERATION_IDS].sort());
    expect(MIGRATION_ROUTES).toHaveLength(16);
    expect(MIGRATION_ROUTES.map(({ operationId, method, path, url }) => ({ operationId, method, path, url }))).toEqual(
      MIGRATION_ROUTES.map(({ operationId }) => {
        const { method, path, url } = rowNamed(operationId);
        return { operationId, method, path, url };
      }),
    );
    const registered = new Set<string>(MIGRATION_ROUTES.map((route) => route.operationId));
    expect(ids.filter((id) => !registered.has(id))).toEqual(['healthz']);
  });

  it('the table declares each operation as the contract does', async () => {
    expect(tableOperations()).toEqual(await contractOperations());
  });

  it('registered route matrix equals the expected table', () => {
    const registered = collectRouteMatrix(app).routes.map(asRoleSet).sort(byMethodAndUrl);
    expect(registered).toEqual(EXPECTED_ROUTES.map(matrixEntryOf).sort(byMethodAndUrl));
    const guarded = registered.filter((entry) => entry.url !== '/healthz');
    expect(guarded.filter((entry) => entry.transport !== 'service' || entry.public === true || (entry.requires ?? []).length === 0)).toEqual([]);
  });

  it('role set covers every subject class', () => {
    const names = ROLE_SET.map((subject) => subject.name);
    expect(names).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS, ...SYNTHETIC_ROLES, GATEWAY, PROGRAMS_SITES]));
    expect(subjectNamed('other-tenant').crossTenant).toBe(true);
    const carrying = (role: string): string[] => ROLE_SET.filter((subject) => subject.roles.includes(role)).map((subject) => subject.name);
    expect({ operator: carrying(Roles.platformOperator), migration: carrying(Roles.platformMigration) }).toEqual({
      operator: [serviceRole('operator')],
      migration: [serviceRole('migration')],
    });
  });
});

describe('route admission matrix', () => {
  const verdicts = new Map<string, Verdict>();

  beforeAll(async () => {
    // Denials first: an admitted handler may finish its own reads after it answered, which no denial may be charged with.
    const ordered = [...CELLS.filter((cell) => cell.denial !== undefined), ...CELLS.filter((cell) => cell.denial === undefined)];
    for (const cell of ordered) verdicts.set(titleOf(cell), await verdictOf(cell));
    await settle();
  }, 120_000);

  /** The probed status of `cell`; 0 when it was not probed. */
  const statusOf = (cell: Cell): number => verdicts.get(titleOf(cell))?.status ?? 0;

  it('probes every route once per ROLE_SET subject', () => {
    expect(new Set(CELLS.map(titleOf)).size).toBe(EXPECTED_ROUTES.length * ROLE_SET.length);
  });

  it.each(CELLS.map((cell) => [titleOf(cell)] as const))('%s', (title) => {
    expect(verdicts.get(title)?.problems ?? [`${title} was not probed`]).toEqual([]);
  });

  it('zero unexpected allows and denies', () => {
    const mismatched = (allowed: boolean): string[] =>
      CELLS.filter((cell) => (cell.denial === undefined) === allowed)
        .filter((cell) => DENIED.has(statusOf(cell)) === allowed)
        .map((cell) => `${titleOf(cell)}: ${statusOf(cell)}`);
    expect({ unexpectedAllows: mismatched(false), unexpectedDenies: mismatched(true) }).toEqual({
      unexpectedAllows: [],
      unexpectedDenies: [],
    });
  });

  it.each([
    [GATEWAY, ['windowOpen', 'windowComplete', 'projectionAwait']],
    [PROGRAMS_SITES, ['unitAuthority', 'legacyStepRun']],
    [serviceRole('operator'), ['transitionStart', 'transitionGet', 'faultSet', 'faultClear']],
  ] as const)('known callers are allowed: %s on %j', (subjectName, operationIds) => {
    const refused = operationIds
      .map((operationId) => cellOf(operationId, subjectName))
      .filter((cell) => cell.denial !== undefined || DENIED.has(statusOf(cell)))
      .map((cell) => `${titleOf(cell)}: ${statusOf(cell)}`);
    expect(refused).toEqual([]);
  });

  // Users reach the service with the gateway's invocation credential, so only that credential may admit them.
  it('no user subject is allowed on any service route by its own roles: users are admitted exactly where the gateway credential is', () => {
    const gatewayAdmitted = (row: ExpectedRoute): boolean => !DENIED.has(statusOf(cellOf(row.operationId, GATEWAY)));
    const departures = SERVICE_ROWS.flatMap((row) =>
      ROLE_SET.filter((subject) => subject.kind === 'user')
        .map((subject) => cellOf(row.operationId, subject.name))
        .filter((cell) => !DENIED.has(statusOf(cell)) !== gatewayAdmitted(row))
        .map((cell) => `${titleOf(cell)}: ${statusOf(cell)}`),
    );
    expect(departures).toEqual([]);
  });
});

describe('user tokens on service routes', () => {
  const USER_SUBJECTS = ROLE_SET.filter((subject) => subject.kind === 'user');

  it.each(SERVICE_ROWS.map((row) => [`${row.method} ${row.path}`, row] as const))(
    '%s refuses every user subject presenting its user token without an invocation credential',
    async (_title, row) => {
      const problems: string[] = [];
      for (const subject of USER_SUBJECTS) {
        const { authorization } = await credentialsOf(subject);
        if (authorization === undefined) throw new TypeError(`${subject.name} presents no user token`);
        const outcome = await send(requestFor(row), { authorization });
        problems.push(...denialProblems(outcome, UNAUTHENTICATED).map((problem) => `${subject.name}: ${problem}`));
      }
      expect(problems).toEqual([]);
    },
  );
});

/** Service routes the gateway's own invocation credential does not open, so a user token's claimed roles are all that could. */
const NOT_GATEWAY_ROWS = SERVICE_ROWS.filter((row) => !hasAnyRole(rolesForService('gateway'), row.requires ?? []));

/** A credential set refused before any handler runs, on each of `rows`, with `denial`. */
interface Refusal {
  title: string;
  rows: readonly ExpectedRoute[];
  denial: AuthDenial;
  credentials: () => Promise<Headers>;
  query?: Headers;
  /** POST and PUT body in place of `{}`. */
  payload?: string;
}

const REFUSALS: readonly Refusal[] = [
  {
    title: 'a request without X-Serverless-Authorization before any handler runs, even with an s2 user token and a malformed body',
    rows: SERVICE_ROWS,
    denial: UNAUTHENTICATED,
    credentials: async () => ({ authorization: `Bearer ${await userToken([Roles.systemUser, Roles.s2])}` }),
    payload: '{not json',
  },
  {
    title: 'a user token presented as the invocation credential',
    rows: SERVICE_ROWS,
    denial: INVALID_CREDENTIAL,
    credentials: async () => ({ [INVOCATION_HEADER]: `Bearer ${await userToken([Roles.systemUser, Roles.s2])}` }),
  },
  {
    title: 'a service token minted for another audience',
    rows: SERVICE_ROWS,
    denial: INVALID_CREDENTIAL,
    credentials: () => invocationHeaders('gateway', 'identity'),
  },
  {
    title: 'a managed Cloud Tasks credential on service routes',
    rows: SERVICE_ROWS,
    denial: UNAUTHENTICATED,
    credentials: async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE_NAME })}` }),
  },
  {
    title: 'the local push key alone',
    rows: SERVICE_ROWS,
    denial: UNAUTHENTICATED,
    credentials: () => Promise.resolve({}),
    query: { key: TEST_PUSH_KEY },
  },
  {
    title: 'a tasks-invoker token beside the gateway invocation credential',
    rows: EXPECTED_ROUTES,
    denial: AuthDenial.invalidToken(),
    credentials: async () => ({
      authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE_NAME })}`,
      ...(await invocationHeaders('gateway')),
    }),
  },
  {
    title: 'a user token claiming workload roles beside the gateway invocation credential',
    rows: NOT_GATEWAY_ROWS,
    denial: AuthDenial.forbidden(),
    credentials: async () => ({
      authorization: `Bearer ${await userToken([Roles.platformOperator, Roles.platformMigration, GATEWAY, PROGRAMS_SITES, Roles.s2])}`,
      ...(await invocationHeaders('gateway')),
    }),
  },
  {
    title: 'a pubsub-invoker invocation credential, the managed push scheme',
    rows: SERVICE_ROWS,
    denial: UNAUTHENTICATED,
    credentials: async () => ({
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'pubsub-invoker', audience: SERVICE_NAME, roles: [PUBSUB_INVOKER_ROLE] })}`,
    }),
  },
  {
    title: 'a tasks-invoker invocation credential, the managed task scheme',
    rows: SERVICE_ROWS,
    denial: UNAUTHENTICATED,
    credentials: async () => ({
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'tasks-invoker', audience: SERVICE_NAME, roles: [TASKS_INVOKER_ROLE] })}`,
    }),
  },
];

describe('transport separation', () => {
  it.each(REFUSALS.flatMap((refusal) => refusal.rows.map((row) => [`${row.method} ${row.path} refuses ${refusal.title}`, row, refusal] as const)))(
    '%s',
    async (_title, row, { denial, credentials, query, payload }) => {
      const outcome = await send(requestFor(row, payload), await credentials(), query);
      expect(denialProblems(outcome, denial)).toEqual([]);
    },
  );
});

describe('deny by default at start-up', () => {
  /** Builds a bare migration service, lets `declare` add a route and readies it; the app is shut down either way. */
  async function startWith(declare: (service: FastifyInstance) => unknown): Promise<void> {
    const service = await createService({ name: SERVICE_NAME, version: '1.0.0', env: tc.ctx.env, verifierOverride: testVerifier(SERVICE_NAME) });
    try {
      declare(service);
      await service.ready();
    } finally {
      await service.opt2.shutdown().catch(() => undefined);
    }
  }

  /** Expects start-up with `declare`'s route to fail with UndeclaredRouteError, thrown at registration or by `ready()`. */
  async function expectStartupFailure(declare: (service: FastifyInstance) => unknown): Promise<void> {
    await expect(startWith(declare)).rejects.toBeInstanceOf(UndeclaredRouteError);
  }

  const handler = (): Promise<Record<string, never>> => Promise.resolve({});
  const declared = (opt2: unknown): { config: { opt2: Opt2RouteConfig } } => ({ config: { opt2: opt2 as Opt2RouteConfig } });

  it.each<[string, (service: FastifyInstance) => unknown]>([
    ['no config.opt2', (service) => service.get('/internal/v1/undeclared', handler)],
    ['an empty requires list', (service) => service.get('/internal/v1/undeclared', declared({ transport: 'service', requires: [] }), handler)],
    ['both requires and public', (service) => service.get('/internal/v1/undeclared', declared({ requires: [OPERATOR], public: true }), handler)],
    ['an unknown transport', (service) => service.get('/internal/v1/undeclared', declared({ requires: [OPERATOR], transport: 'bogus' }), handler)],
    [
      'the cloud-tasks transport on a service path',
      (service) => service.get('/internal/v1/undeclared', declared({ requires: [TASKS_INVOKER_ROLE], transport: 'cloud-tasks' }), handler),
    ],
  ])('fails start-up for a route with %s', async (_label, declare) => {
    await expectStartupFailure(declare);
  });

  it('starts when the added route declares its roles', async () => {
    const declare = (service: FastifyInstance): unknown =>
      service.get('/internal/v1/declared', declared({ transport: 'service', requires: [OPERATOR] }), handler);
    await expect(startWith(declare)).resolves.toBeUndefined();
  });
});
