/** In-process authorisation of the gateway through buildTestGateway: route declarations, the subject matrix, trust boundaries and start-up. */
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  AuthDenial,
  INVOCATION_HEADER,
  OPT2_HEADER_PREFIX,
  Roles,
  UndeclaredRouteError,
  collectRouteMatrix,
  hasAnyRole,
  isServiceRole,
  renderAuthDenial,
  rolesForService,
  serviceRole,
  type RouteMatrixEntry,
} from '@opt2/platform/auth';
import { signBridgeAssertion } from '@opt2/platform/legacy-compat';
import type { FastifyInstance, FastifyRequest } from '@opt2/platform/service-kit';
import {
  ROLE_SET,
  TENANT_B,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  subjectQueryFor,
  testVerifier,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { SERVICE_NAME, buildApp } from '../../src/app.js';
import { buildTestGateway, headersFor, type TestGateway } from '../helpers/app.js';
import { TEST_BRIDGE_KEY, TEST_CLOCK, prepareTestStateDir, testEnv } from '../helpers/env.js';
import type { RecordedRequest } from '../helpers/http-double.js';
import { createMemoryGatewayDb, type GatewayTables, type MemoryGatewayDb } from '../helpers/memory-store.js';
import { committedTable, cutoverTable, entry, type CommittedVersion } from '../helpers/versions.js';

type Headers = Record<string, string>;

/** One declared route of the gateway with the contract operation it implements. */
type ExpectedRoute = RouteMatrixEntry & { operationId: string };

const SITE_A = 'tenant-a';
const DENIED: ReadonlySet<number> = new Set([401, 403]);
const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;
const CONTRACT_URL = new URL('../../contracts/openapi.yaml', import.meta.url);
const CONTRACT_METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as const;
const BRIDGE_PREFIX = '/gateway/legacy-bridge/';

const ACTIVATE_URL = '/internal/v1/cutover/activate';
const FREEZE_URL = '/internal/v1/cutover/freeze';
const UNFREEZE_URL = '/internal/v1/cutover/unfreeze';
const STATUS_URL = '/internal/v1/cutover/status';
const STATUS_V2_URL = '/internal/v2/cutover/status';
const CLEAR_ORPHANS_URL = '/internal/v1/inflight::clear-orphans';
const MARK_USED_URL = '/internal/v1/legacy-sessions/:sid(.+)::mark-used';
const SITE_PATHS_URL = '/internal/v1/legacy-site-paths';
const VERSION_MENU_URL = '/internal/v1/legacy-server/version-menu';
const PLUGINS_URL = '/internal/v1/legacy-server/plugins';
const RELAY_URL = '/internal/v1/relay/:service/*';
const EDGE_URL = '/*';

const EDGE_PROBE_PATH = '/opt2-authz-probe';
const RELAY_PROBE_PATH = '/internal/v1/relay/people/v1/authz-probe';
const MARK_USED_PROBE_PATH = '/internal/v1/legacy-sessions/ids-authz-unmapped:mark-used';
const STUB_PATH = '/opt2/stub/notes';
const CONTENT_PATH = '/_api/json/v1/default/content/C1';
const RELAY_PATH = '/internal/v1/relay/people/v1/persons';
const ALIAS_PATH = '/opt2/svc/people/v1/persons';
const PROBE_TOKEN = randomBytes(32).toString('hex');
const JSON_BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);
const FORM_BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FORM_HEADERS: Readonly<Headers> = { 'content-type': 'application/x-www-form-urlencoded' };

const FROZEN_ROUTE = (await committedTable('v0001')).entries[0]?.route;
if (FROZEN_ROUTE === undefined) throw new TypeError('committed v0001 has no entry');

const EXPECTED_ROUTES: readonly ExpectedRoute[] = [
  { operationId: 'healthz', method: 'GET', url: '/healthz', transport: 'service', public: true, invocationOptional: true, siteCheck: true },
  {
    operationId: 'cutoverActivate',
    method: 'POST',
    url: ACTIVATE_URL,
    transport: 'service',
    requires: [Roles.platformOperator],
    siteCheck: true,
  },
  { operationId: 'cutoverFreeze', method: 'POST', url: FREEZE_URL, transport: 'service', requires: [Roles.platformOperator], siteCheck: true },
  {
    operationId: 'cutoverUnfreeze',
    method: 'POST',
    url: UNFREEZE_URL,
    transport: 'service',
    requires: [Roles.platformOperator],
    siteCheck: true,
  },
  {
    operationId: 'cutoverStatus',
    method: 'GET',
    url: STATUS_URL,
    transport: 'service',
    requires: [Roles.platformOperator, Roles.platformMigration],
    siteCheck: true,
  },
  {
    operationId: 'cutoverStatusV2',
    method: 'GET',
    url: STATUS_V2_URL,
    transport: 'service',
    requires: [Roles.platformOperator, Roles.platformMigration],
    siteCheck: true,
  },
  {
    operationId: 'inflightClearOrphans',
    method: 'POST',
    url: CLEAR_ORPHANS_URL,
    transport: 'service',
    requires: [Roles.platformOperator, Roles.platformMigration],
    siteCheck: true,
  },
  {
    operationId: 'legacySessionMarkUsed',
    method: 'POST',
    url: MARK_USED_URL,
    transport: 'service',
    requires: [serviceRole('identity')],
    siteCheck: true,
  },
  {
    operationId: 'legacySitePaths',
    method: 'GET',
    url: SITE_PATHS_URL,
    transport: 'service',
    requires: [serviceRole('web')],
    siteCheck: true,
  },
  {
    operationId: 'getLegacyVersionMenu',
    method: 'GET',
    url: VERSION_MENU_URL,
    transport: 'service',
    requires: [serviceRole('web')],
    siteCheck: true,
  },
  {
    operationId: 'getLegacyPlugins',
    method: 'GET',
    url: PLUGINS_URL,
    transport: 'service',
    requires: [serviceRole('web')],
    siteCheck: true,
  },
  { operationId: 'relayGet', method: 'GET', url: RELAY_URL, transport: 'service', requires: [serviceRole('web')], siteCheck: false },
  { operationId: 'relayPost', method: 'POST', url: RELAY_URL, transport: 'service', requires: [serviceRole('web')], siteCheck: false },
  { operationId: 'relayPut', method: 'PUT', url: RELAY_URL, transport: 'service', requires: [serviceRole('web')], siteCheck: false },
  { operationId: 'relayPatch', method: 'PATCH', url: RELAY_URL, transport: 'service', requires: [serviceRole('web')], siteCheck: false },
  { operationId: 'relayDelete', method: 'DELETE', url: RELAY_URL, transport: 'service', requires: [serviceRole('web')], siteCheck: false },
  { operationId: 'edgeGet', method: 'GET', url: EDGE_URL, transport: 'service', public: true, edge: true, siteCheck: true },
  { operationId: 'edgeHead', method: 'HEAD', url: EDGE_URL, transport: 'service', public: true, edge: true, siteCheck: true },
  { operationId: 'edgePost', method: 'POST', url: EDGE_URL, transport: 'service', public: true, edge: true, siteCheck: true },
  { operationId: 'edgePut', method: 'PUT', url: EDGE_URL, transport: 'service', public: true, edge: true, siteCheck: true },
  { operationId: 'edgePatch', method: 'PATCH', url: EDGE_URL, transport: 'service', public: true, edge: true, siteCheck: true },
  { operationId: 'edgeDelete', method: 'DELETE', url: EDGE_URL, transport: 'service', public: true, edge: true, siteCheck: true },
  { operationId: 'edgeOptions', method: 'OPTIONS', url: EDGE_URL, transport: 'service', public: true, edge: true, siteCheck: true },
];

/** One concrete request; a subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: NonNullable<InjectOptions['method']>;
  url: string;
  payload?: string | object;
  headers?: Headers;
}

/** What an admitted subject's probe of a route answers and reaches. */
interface Probe {
  admitted: number;
  /** The one upstream an admitted probe reaches. */
  reaches?: 'legacy' | 'people';
  /** Admitted probes change cut-over state, so they run on a fresh gateway with this version active (none when absent). */
  fresh?: { version?: CommittedVersion };
}

const PROBES: Readonly<Record<string, Probe>> = {
  '/healthz': { admitted: 200 },
  [ACTIVATE_URL]: { admitted: 200, fresh: {} },
  [FREEZE_URL]: { admitted: 200, fresh: { version: 'v0001' } },
  [UNFREEZE_URL]: { admitted: 200, fresh: { version: 'v0001' } },
  [STATUS_URL]: { admitted: 200 },
  [STATUS_V2_URL]: { admitted: 200 },
  [CLEAR_ORPHANS_URL]: { admitted: 200 },
  // No jar maps the probe's sid, so an admitted call answers the legacy 404.
  [MARK_USED_URL]: { admitted: 404 },
  // An admitted call of any of these reads the values from the bridge's site.cfm.
  [SITE_PATHS_URL]: { admitted: 200, reaches: 'legacy' },
  [VERSION_MENU_URL]: { admitted: 200, reaches: 'legacy' },
  [PLUGINS_URL]: { admitted: 200, reaches: 'legacy' },
  [RELAY_URL]: { admitted: 200, reaches: 'people' },
  [EDGE_URL]: { admitted: 200, reaches: 'legacy' },
};

function probeOf(row: ExpectedRoute): Probe {
  const probe = PROBES[row.url];
  if (probe === undefined) throw new TypeError(`no probe for ${row.url}`);
  return probe;
}

/** The request `row` is probed with; bodies satisfy the contract schemas, so an admitted probe reaches its handler. */
function requestFor(row: ExpectedRoute): ProbeRequest {
  const method = row.method as ProbeRequest['method'];
  switch (row.url) {
    case ACTIVATE_URL:
      return { method, url: row.url, payload: { tableVersion: 'v0001' } };
    case FREEZE_URL:
    case UNFREEZE_URL:
      return { method, url: row.url, payload: { routes: [FROZEN_ROUTE] } };
    case CLEAR_ORPHANS_URL:
      return {
        method,
        url: '/internal/v1/inflight:clear-orphans',
        payload: { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'authz-probe', at: '2000-01-01T00:00:00.000+00:00' } },
      };
    case MARK_USED_URL:
      return { method, url: MARK_USED_PROBE_PATH, payload: { tokens: [{ token: PROBE_TOKEN, usedAt: '2026-06-30T12:00:00.000' }] } };
    case SITE_PATHS_URL:
      return { method, url: `${SITE_PATHS_URL}?sessionSite=default&host=localhost&themeSite=default` };
    case RELAY_URL:
      return { method, url: RELAY_PROBE_PATH, ...(JSON_BODY_METHODS.has(row.method) ? { payload: {} } : {}) };
    case EDGE_URL:
      return { method, url: EDGE_PROBE_PATH, ...(FORM_BODY_METHODS.has(row.method) ? { payload: 'probe=1', headers: FORM_HEADERS } : {}) };
    default:
      return { method, url: row.url };
  }
}

function rowNamed(operationId: string): ExpectedRoute {
  const row = EXPECTED_ROUTES.find((candidate) => candidate.operationId === operationId);
  if (row === undefined) throw new TypeError(`EXPECTED_ROUTES has no ${operationId}`);
  return row;
}

function subjectNamed(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return subject;
}

/** Credentials `headersFor(subject)` presents to the service transport. */
interface Presented {
  /** Roles of the invocation credential; absent when none is sent. */
  invocation?: readonly string[];
  /** Non-workload roles of the bearer user token. */
  userRoles?: readonly string[];
  /** `Authorization` carries a bearer token that is no user token. */
  foreignBearer?: true;
}

/** A user subject's token travels beside the gateway's own invocation credential; managed invokers send none. */
function presentedBy(subject: RoleSubject): Presented {
  if (subject.kind === 'anonymous') return {};
  if (subject.kind === 'user') {
    return { invocation: rolesForService(SERVICE_NAME), userRoles: subject.roles.filter((role) => !isServiceRole(role)) };
  }
  if (subject.caller === 'pubsub-invoker') return {};
  if (subject.caller === 'tasks-invoker') return { foreignBearer: true };
  return { invocation: subject.roles };
}

/** The denial the service transport and `row`'s roles give `subject`; undefined when the subject is admitted. */
function expectedDenial(row: ExpectedRoute, subject: RoleSubject): AuthDenial | undefined {
  if (row.edge === true) return undefined;
  const { invocation, userRoles = [], foreignBearer } = presentedBy(subject);
  if (invocation === undefined && row.invocationOptional !== true) return AuthDenial.unauthenticated('missing-credential');
  if (foreignBearer === true) return AuthDenial.invalidToken();
  if (row.public === true) return undefined;
  return hasAnyRole([...userRoles, ...(invocation ?? [])], row.requires ?? []) ? undefined : AuthDenial.forbidden();
}

/** Everything a request may change: the gateway schema and what every double received. */
interface Effects {
  tables: GatewayTables;
  queries: number;
  /** Requests received, by double name: legacy, identity, migration and every target, web included. */
  requests: Record<string, number>;
  bridgeCalls: number;
  identityCalls: Record<string, number>;
  windows: number;
  awaits: number;
}

/** What one request answered and left behind. */
interface Outcome {
  status: number;
  body: string;
  headers: Headers;
  /** Query the request was sent with, which a denial echoes. */
  query: Headers;
  before: Effects;
  after: Effects;
}

function memoryOf(gw: TestGateway): MemoryGatewayDb {
  if (gw.memory === undefined) throw new TypeError('the test gateway has no memory store');
  return gw.memory;
}

/** Every double of `gw` by name. */
function doublesOf(gw: TestGateway): Array<[string, { requests: readonly RecordedRequest[] }]> {
  return [['legacy', gw.legacy], ['identity', gw.identity], ['migration', gw.migration], ...Object.entries(gw.targets)];
}

/** A deep snapshot of {@link Effects}. */
function effectsOf(gw: TestGateway): Effects {
  const memory = memoryOf(gw);
  return {
    tables: structuredClone(memory.tables),
    queries: memory.queries.length,
    requests: Object.fromEntries(doublesOf(gw).map(([name, double]) => [name, double.requests.length])),
    bridgeCalls: gw.legacy.bridgeCalls.length,
    identityCalls: { ...gw.identity.calls },
    windows: gw.migration.windows.length,
    awaits: gw.migration.awaits.length,
  };
}

/** Names of the doubles whose received-request count changed. */
function reached(before: Effects, after: Effects): string[] {
  return Object.keys(after.requests).filter((name) => after.requests[name] !== before.requests[name]);
}

/** Keys of {@link Effects} that differ. */
function changedEffects(before: Effects, after: Effects): string[] {
  return (Object.keys(after) as Array<keyof Effects>).filter((key) => !isDeepStrictEqual(after[key], before[key]));
}

/** Page requests legacy received, bridge calls excepted. */
function legacyPages(gw: TestGateway): RecordedRequest[] {
  return gw.legacy.requests.filter((request) => !request.path.startsWith(BRIDGE_PREFIX));
}

/** Header names of a recorded request that start with `x-opt2-` or carry an invocation credential. */
function internalHeaders(request: RecordedRequest | undefined): string[] {
  return Object.keys(request?.headers ?? {}).filter((name) => name.startsWith(OPT2_HEADER_PREFIX) || name === INVOCATION_HEADER);
}

/** Values of the invocation credential and every `X-Opt2-*` header in `headers`. */
function trustValues(headers: Record<string, string | string[] | undefined>): string[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    const lower = name.toLowerCase();
    if (lower !== INVOCATION_HEADER && !lower.startsWith(OPT2_HEADER_PREFIX)) return [];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  });
}

/** `X-Serverless-Authorization` of `caller`'s local service token addressed to `audience`. */
async function invocationHeaders(caller: string, audience: string = SERVICE_NAME): Promise<Headers> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience })}` };
}

/** The bearer user token `headersFor(subject)` presents. */
async function userTokenOf(subject: RoleSubject): Promise<string> {
  const { authorization } = await headersFor(subject);
  if (authorization === undefined) throw new TypeError(`${subject.name} presents no user token`);
  return authorization.replace(/^Bearer /, '');
}

/** The name of the workload whose invocation credential a callee received. */
async function callerSeenBy(callee: string, request: RecordedRequest | undefined): Promise<string | undefined> {
  const credential = request?.headers[INVOCATION_HEADER];
  if (typeof credential !== 'string') return undefined;
  const caller = await testVerifier(callee).invocationVerifier.verify(credential).catch(() => undefined);
  return caller?.name;
}

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Headers> }>();
// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `headersFor(subject)`, reused across probes while its tokens are fresh. */
function credentialsOf(subject: RoleSubject): Promise<Headers> {
  const cached = credentialCache.get(subject.name);
  if (cached !== undefined && Date.now() - cached.mintedAt < CREDENTIAL_REUSE_MS) return cached.headers;
  const headers = headersFor(subject);
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

function withQuery(url: string, query: Headers): string {
  const search = new URLSearchParams(query).toString();
  return search === '' ? url : `${url}${url.includes('?') ? '&' : '?'}${search}`;
}

function headerStrings(res: InjectResponse): Headers {
  return Object.fromEntries(
    Object.entries(res.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]),
  );
}

/** Sends `request` with `credentials` and `query` to `gw` and records its answer and effects. */
async function send(gw: TestGateway, request: ProbeRequest, credentials: Headers, query: Headers = {}): Promise<Outcome> {
  const before = effectsOf(gw);
  const res = await gw.app.inject({
    method: request.method,
    url: withQuery(request.url, query),
    headers: { ...request.headers, ...credentials },
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  });
  return { status: res.statusCode, body: res.body, headers: headerStrings(res), query, before, after: effectsOf(gw) };
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

/** Whether `body` is the legacy JSON API error envelope `{apiversion, method, params?, error: {code, message}}`. */
function isErrorEnvelope(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.error) || !(body.params === undefined || isRecord(body.params))) return false;
  const { apiversion, method, error } = body;
  return typeof apiversion === 'string' && typeof method === 'string' && typeof error.code === 'string' && typeof error.message === 'string';
}

/** Every way `outcome` departs from `denial` as renderAuthDenial answers it: status, body, headers and no effect anywhere. */
function denialProblems(outcome: Outcome, denial: AuthDenial): string[] {
  const rendered = renderAuthDenial(denial, { query: outcome.query } as unknown as FastifyRequest);
  const problems: string[] = [];
  if (outcome.status !== rendered.status) problems.push(`answered ${outcome.status}, expected ${rendered.status}: ${outcome.body.slice(0, 160)}`);
  if (!isErrorEnvelope(parsedBody(outcome.body))) problems.push(`not the legacy error envelope: ${outcome.body.slice(0, 160)}`);
  if (outcome.body !== String(rendered.body)) problems.push(`body ${outcome.body.slice(0, 160)} is not ${String(rendered.body)}`);
  for (const [name, value] of Object.entries(rendered.headers)) {
    const sent = outcome.headers[name.toLowerCase()];
    if (sent !== value) problems.push(`header ${name} is ${String(sent)}, not ${value}`);
  }
  const changed = changedEffects(outcome.before, outcome.after);
  if (changed.length > 0) problems.push(`denial changed ${changed.join(', ')}`);
  return problems;
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
  const verdict = cell.denial === undefined ? 'allowed' : `denied with ${cell.denial.statusCode}`;
  return `${cell.subject.name} is ${verdict} on ${cell.row.method} ${cell.row.url}`;
}

/** Every way an admitted cell's outcome departs from its probe: status, the one upstream reached and the handler's effect. */
async function admissionProblems(gw: TestGateway, cell: Cell, outcome: Outcome): Promise<string[]> {
  const { row } = cell;
  const probe = probeOf(row);
  if (DENIED.has(outcome.status)) return [`expected admission, answered ${outcome.status}: ${outcome.body.slice(0, 160)}`];
  const problems: string[] = [];
  if (outcome.status !== probe.admitted) problems.push(`admitted with ${outcome.status}, expected ${probe.admitted}: ${outcome.body.slice(0, 160)}`);
  const upstreams = reached(outcome.before, outcome.after);
  if (!isDeepStrictEqual(upstreams, probe.reaches === undefined ? [] : [probe.reaches])) {
    problems.push(`reached [${upstreams.join(', ')}], expected [${probe.reaches ?? ''}]`);
  }
  if (probe.reaches !== undefined) {
    const count = (outcome.after.requests[probe.reaches] ?? 0) - (outcome.before.requests[probe.reaches] ?? 0);
    if (count !== 1) problems.push(`${probe.reaches} received ${count} requests, expected 1`);
  }
  const before = outcome.before.tables;
  const after = outcome.after.tables;
  const cutoverState = (tables: GatewayTables): unknown => [tables.cutover_state, tables.cutover_freeze];
  if (probe.fresh === undefined && !isDeepStrictEqual(cutoverState(after), cutoverState(before))) problems.push('changed the cut-over state');
  const body = parsedBody(outcome.body);
  const frozen = isRecord(body) && Array.isArray(body.frozen) ? (body.frozen as unknown[]) : undefined;
  switch (row.url) {
    case ACTIVATE_URL:
      if (!isRecord(body) || body.tableVersion !== 'v0001') problems.push(`activation answered ${outcome.body}`);
      break;
    case FREEZE_URL:
      if (frozen?.includes(FROZEN_ROUTE) !== true) problems.push(`freeze answered ${outcome.body.slice(0, 160)}`);
      break;
    case UNFREEZE_URL:
      if (frozen === undefined || frozen.includes(FROZEN_ROUTE)) problems.push(`unfreeze answered ${outcome.body.slice(0, 160)}`);
      break;
    case CLEAR_ORPHANS_URL:
      if (!isDeepStrictEqual(body, { cleared: 0 })) problems.push(`clearing orphans answered ${outcome.body}`);
      if (!isDeepStrictEqual(after, before)) problems.push('clearing orphans changed gateway rows');
      break;
    case EDGE_URL: {
      const page = legacyPages(gw).at(-1);
      if (page?.method !== row.method) problems.push(`legacy received ${page?.method ?? 'nothing'}, expected ${row.method}`);
      if (internalHeaders(page).length > 0) problems.push(`legacy received ${internalHeaders(page).join(', ')}`);
      break;
    }
    case RELAY_URL: {
      const caller = await callerSeenBy('people', gw.targets.people?.requests.at(-1));
      if (caller !== SERVICE_NAME) problems.push(`people received a credential of ${caller ?? 'nobody'}, not the gateway`);
      break;
    }
    default:
      break;
  }
  return problems;
}

/** A probed cell's status and every way it departed from its expectation. */
interface Verdict {
  status: number;
  problems: string[];
}

/** Sends `cell`'s probe on the gateway it needs and judges the outcome. */
async function verdictOf(shared: TestGateway, cell: Cell): Promise<Verdict> {
  const probe = probeOf(cell.row);
  const request = requestFor(cell.row);
  const credentials = await credentialsOf(cell.subject);
  const query = subjectQueryFor(cell.subject);
  if (cell.denial !== undefined) {
    const outcome = await send(shared, request, credentials, query);
    return { status: outcome.status, problems: denialProblems(outcome, cell.denial) };
  }
  if (probe.fresh === undefined) {
    const outcome = await send(shared, request, credentials, query);
    return { status: outcome.status, problems: await admissionProblems(shared, cell, outcome) };
  }
  const fresh = await buildTestGateway(probe.fresh.version === undefined ? {} : { version: probe.fresh.version });
  try {
    const outcome = await send(fresh, request, credentials, query);
    return { status: outcome.status, problems: await admissionProblems(fresh, cell, outcome) };
  } finally {
    await fresh.close();
  }
}

/** A contract operation's method and auth declaration, keyed by operationId. */
interface ContractOperation {
  operationId: string;
  method: string;
  transport: unknown;
  requires: unknown;
  public: unknown;
  edge: unknown;
}

/** Every operation of `gateway/contracts/openapi.yaml` with its `x-opt2-*` declaration, ordered by operationId. */
async function contractOperations(): Promise<ContractOperation[]> {
  const contract = parse(await readFile(CONTRACT_URL, 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  return Object.values(contract.paths)
    .flatMap((item) =>
      CONTRACT_METHODS.flatMap((method) => {
        const operation = item[method];
        if (!isRecord(operation)) return [];
        return [
          {
            operationId: String(operation.operationId),
            method: method.toUpperCase(),
            transport: operation['x-opt2-transport'],
            requires: operation['x-opt2-requires'],
            public: operation['x-opt2-public'],
            edge: operation['x-opt2-edge'],
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
    transport: row.transport,
    requires: row.requires,
    public: row.public,
    edge: row.edge,
  })).sort((a, b) => a.operationId.localeCompare(b.operationId, 'en'));
}

/** The matrix gateway, with v0001 active. */
let gw: TestGateway;

beforeAll(async () => {
  gw = await buildTestGateway({ version: 'v0001' });
}, 120_000);

afterAll(async () => {
  await gw?.close();
});

describe('route declarations', () => {
  it('declared gateway routes equal the expected table', () => {
    const expected = EXPECTED_ROUTES.map(({ operationId: _operationId, ...entry }) => entry).sort(
      (a, b) => a.url.localeCompare(b.url, 'en') || a.method.localeCompare(b.method, 'en'),
    );
    expect(collectRouteMatrix(gw.app).routes).toEqual(expected);
  });

  it('the table has one row per contract operation, declared as the contract declares it', async () => {
    const ids = EXPECTED_ROUTES.map((row) => row.operationId);
    expect({ rows: ids.length, unique: new Set(ids).size }).toEqual({ rows: 23, unique: 23 });
    expect(tableOperations()).toEqual(await contractOperations());
  });

  it('ROLE_SET holds the minimum subjects, with other-tenant minted for another tenant', () => {
    expect(ROLE_SET.map((subject) => subject.name)).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS]));
    expect(subjectNamed('other-tenant').crossTenant).toBe(true);
  });
});

describe('route admission matrix', () => {
  const verdicts = new Map<string, Verdict>();

  beforeAll(async () => {
    for (const cell of CELLS) verdicts.set(titleOf(cell), await verdictOf(gw, cell));
  }, 300_000);

  it('probes every declared route once per ROLE_SET subject', () => {
    expect(new Set(CELLS.map(titleOf)).size).toBe(EXPECTED_ROUTES.length * ROLE_SET.length);
  });

  it.each(CELLS.map((cell) => [titleOf(cell)] as const))('%s', (title) => {
    expect(verdicts.get(title)?.problems ?? [`${title} was not probed`]).toEqual([]);
  });

  it('zero unexpected allows and denies', () => {
    const mismatched = (allowed: boolean): string[] =>
      CELLS.filter((cell) => (cell.denial === undefined) === allowed)
        .filter((cell) => DENIED.has(verdicts.get(titleOf(cell))?.status ?? 0) === allowed)
        .map((cell) => `${titleOf(cell)}: ${verdicts.get(titleOf(cell))?.status ?? 'not probed'}`);
    expect({ unexpectedAllows: mismatched(false), unexpectedDenies: mismatched(true) }).toEqual({
      unexpectedAllows: [],
      unexpectedDenies: [],
    });
  });
});

describe('user tokens on service routes', () => {
  const placements: ReadonlyArray<readonly [string, (token: string) => Headers, AuthDenial]> = [
    ['in Authorization alone', (token) => ({ authorization: `Bearer ${token}` }), AuthDenial.unauthenticated('missing-credential')],
    [
      'as the invocation credential',
      (token) => ({ [INVOCATION_HEADER]: `Bearer ${token}` }),
      AuthDenial.unauthenticated('invalid-credential'),
    ],
  ];
  const cases = ['cutoverActivate', 'cutoverStatus', 'legacySessionMarkUsed', 'getLegacyVersionMenu', 'relayGet'].flatMap((operationId) =>
    [Roles.siteAdmin, Roles.s2].flatMap((subject) =>
      placements.map(([placement, headers, denial]) => ({ operationId, subject, placement, headers, denial })),
    ),
  );

  it.each(cases)("refuses $subject's user token $placement on $operationId", async ({ operationId, subject, headers, denial }) => {
    const token = await userTokenOf(subjectNamed(subject));
    const outcome = await send(gw, requestFor(rowNamed(operationId)), headers(token));
    expect(denialProblems(outcome, denial)).toEqual([]);
  });
});

describe('workload credentials on internal routes', () => {
  const status = (): ProbeRequest => requestFor(rowNamed('cutoverStatus'));

  /** An operator token minted on a Date faked an hour back, since mintServiceToken takes no lifetime. */
  const expiredOperator = async (): Promise<Headers> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() - 3_600_000);
      return await invocationHeaders('operator');
    } finally {
      vi.useRealTimers();
    }
  };

  /** An operator token whose signature no longer verifies; altered after minting, as the suite signs no token itself. */
  const tamperedOperator = async (): Promise<Headers> => {
    const token = await mintServiceToken({ caller: 'operator', audience: SERVICE_NAME });
    const at = token.lastIndexOf('.') + 8;
    return { [INVOCATION_HEADER]: `Bearer ${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}` };
  };

  it.each<[string, () => Promise<Headers>]>([
    ['an expired operator token', expiredOperator],
    ['an operator token addressed to people', () => invocationHeaders('operator', 'people')],
    ['an operator token with a tampered signature', tamperedOperator],
    [
      "the operator's credential beside a Basic credential",
      async () => ({ ...(await invocationHeaders('operator')), authorization: `Basic ${Buffer.from('operator:x').toString('base64')}` }),
    ],
    [
      'a managed-task token as an invocation credential',
      async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE_NAME })}` }),
    ],
    ["a browser's legacy session cookie", async () => ({ cookie: gw.legacy.createSession().cookieHeader })],
  ])('refuses %s before any handler runs', async (_label, credentials) => {
    const outcome = await send(gw, status(), await credentials());
    expect(denialProblems(outcome, AuthDenial.unauthenticated('invalid-credential'))).toEqual([]);
  });
});

describe('inbound trust headers', () => {
  const SENTINELS: Readonly<Headers> = {
    [INVOCATION_HEADER]: 'Bearer forged-invocation',
    'x-opt2-write-position': 'identity=1',
    'x-opt2-bridge-assertion': 'forged',
    'x-opt2-original-url': '/forged',
    'x-opt2-probe': 'forged',
  };
  const DESTINATIONS = [
    ['legacy-bound', EDGE_PROBE_PATH, 'legacy'],
    ['target-bound', STUB_PATH, 'stub'],
  ] as const;
  const SERVICE_SUBJECTS = ROLE_SET.filter((subject) => subject.kind === 'service');

  /** Sends a GET with `headers` and returns the doubles reached and every inbound trust-header value one of them received. */
  async function probe(url: string, headers: Headers, query: Headers = {}): Promise<{ reached: string[]; leaked: string[] }> {
    const sent = new Set(trustValues(headers));
    const before = Object.fromEntries(doublesOf(gw).map(([name, double]) => [name, double.requests.length]));
    await gw.app.inject({ method: 'GET', url: withQuery(url, query), headers });
    const received = doublesOf(gw).map(([name, double]) => [name, double.requests.slice(before[name] ?? 0)] as const);
    return {
      reached: received.filter(([, requests]) => requests.length > 0).map(([name]) => name),
      leaked: received.flatMap(([name, requests]) =>
        requests.flatMap((request) => trustValues(request.headers).filter((value) => sent.has(value)).map((value) => `${name}: ${value}`)),
      ),
    };
  }

  it.each(DESTINATIONS)('a %s edge request forwards none of the inbound trust headers', async (_label, url, destination) => {
    const { reached: upstreams, leaked } = await probe(url, SENTINELS);
    expect({ reachedDestination: upstreams.includes(destination), leaked }).toEqual({ reachedDestination: true, leaked: [] });
  });

  it.each(SERVICE_SUBJECTS.flatMap((subject) => DESTINATIONS.map(([label, url, destination]) => [subject.name, label, url, destination, subject] as const)))(
    "%s's own invocation credential on a %s edge request is stripped with the other trust headers",
    async (_name, _label, url, destination, subject) => {
      const headers = { ...SENTINELS, ...(await credentialsOf(subject)) };
      const { reached: upstreams, leaked } = await probe(url, headers, subjectQueryFor(subject));
      expect({ reachedDestination: upstreams.includes(destination), leaked }).toEqual({ reachedDestination: true, leaked: [] });
    },
  );

  it("admits on the gateway's own routes only a siteid equal to the user token's site", async () => {
    const headers = await headersFor(subjectNamed('other-tenant'), { site: SITE_A });
    const [own, foreign] = await Promise.all([
      gw.app.inject({ method: 'GET', url: `/healthz?siteid=${TENANT_B.siteId}`, headers }),
      gw.app.inject({ method: 'GET', url: `/healthz?siteid=${SITE_A}`, headers }),
    ]);
    expect([own.statusCode, foreign.statusCode]).toEqual([200, 403]);
  });
});

// The web screens and REST writes these cases forward are target only from v0002.
describe('with v0002 active', () => {
  let v2: TestGateway;

  beforeAll(async () => {
    v2 = await buildTestGateway({ version: 'v0002' });
  }, 120_000);

  afterAll(async () => {
    await v2?.close();
  });

  /** The target double serving `name`. */
  const target = (name: string) => {
    const double = v2.targets[name];
    if (double === undefined) throw new TypeError(`no target double serves ${name}`);
    return double;
  };

  /** Injects `opts` and returns its answer with the effects before and after it. */
  async function observed(opts: InjectOptions): Promise<{ res: InjectResponse; before: Effects; after: Effects }> {
    const before = effectsOf(v2);
    const res = await v2.app.inject(opts);
    return { res, before, after: effectsOf(v2) };
  }

  describe('browser-to-legacy trust boundary', () => {
    it('strips invocation credentials and X-Opt2-* headers from a legacy-bound request, keeping Host and Authorization', async () => {
      const basic = `Basic ${Buffer.from(`visitor:${randomUUID()}`).toString('base64')}`;
      const forged = {
        host: 'tenant-a.example.test',
        authorization: basic,
        ...(await invocationHeaders('web')),
        'x-opt2-bridge-assertion': signBridgeAssertion({ op: 'session.describe' }, TEST_BRIDGE_KEY),
        'x-opt2-write-position': 'people=1',
        'x-opt2-original-url': '/admin/',
      };
      const res = await v2.app.inject({ method: 'GET', url: CONTENT_PATH, headers: forged });
      const received = legacyPages(v2).at(-1);
      expect(res.statusCode).toBe(200);
      expect({
        internal: internalHeaders(received),
        host: received?.headers.host,
        authorization: received?.headers.authorization,
        forwardedHost: received?.headers['x-forwarded-host'],
      }).toEqual({ internal: [], host: forged.host, authorization: basic, forwardedHost: forged.host });
    });

    it.each([
      ['GET', '/gateway/legacy-bridge/cfml/session.cfm?op=describe', 'session.describe'],
      ['POST', '/gateway/legacy-bridge/cfml/session.cfm?op=markUsed', 'session.markUsed'],
      ['GET', '/gateway/legacy-bridge/cfml/site.cfm?op=list', 'site.list'],
      ['GET', '/gateway/legacy-bridge/cfml/site.cfm?op=paths&siteid=default&themeSite=default', 'site.paths'],
      ['GET', '/gateway/legacy-bridge/cfml/site.cfm?op=versionMenu', 'site.versionMenu'],
    ] as const)('answers %s %s with a validly signed assertion from outside as 404, reaching nothing', async (method, url, op) => {
      const { res, before, after } = await observed({
        method,
        url,
        headers: { 'x-opt2-bridge-assertion': signBridgeAssertion({ op }, TEST_BRIDGE_KEY) },
        ...(method === 'POST' ? { payload: { tokens: [] } } : {}),
      });
      expect({ status: res.statusCode, body: res.body, reached: reached(before, after) }).toEqual({ status: 404, body: '', reached: [] });
    });
  });

  describe('web relay trust boundary', () => {
    const userToken = (): Promise<string> => mintUserToken({ sub: 'relay-user', site: SITE_A, roles: [Roles.systemUser] });

    it.each<[string, (token: string) => Promise<Headers>, number]>([
      ["web's credential and a user token", async (token) => ({ authorization: `Bearer ${token}`, ...(await invocationHeaders('web')) }), 200],
      [
        "the gateway's own credential and a user token",
        async (token) => ({ authorization: `Bearer ${token}`, ...(await invocationHeaders(SERVICE_NAME)) }),
        403,
      ],
      ['a user token alone', async (token) => ({ authorization: `Bearer ${token}` }), 403],
      ['no credential', async () => ({}), 403],
      [
        "web's credential addressed to people",
        async (token) => ({ authorization: `Bearer ${token}`, ...(await invocationHeaders('web', 'people')) }),
        401,
      ],
    ])('the edge relay alias with %s', async (_label, credentials, status) => {
      const token = await userToken();
      const { res, before, after } = await observed({ method: 'GET', url: ALIAS_PATH, headers: await credentials(token) });
      expect(res.statusCode).toBe(status);
      if (status !== 200) {
        expect({ envelope: isErrorEnvelope(parsedBody(res.body)), reached: reached(before, after) }).toEqual({ envelope: true, reached: [] });
        return;
      }
      const received = target('people').requests.at(-1);
      expect({
        reached: reached(before, after),
        authorization: received?.headers.authorization,
        caller: await callerSeenBy('people', received),
      }).toEqual({ reached: ['people'], authorization: `Bearer ${token}`, caller: SERVICE_NAME });
    });

    it("records the callee's write position for the session, strips it and the caller's X-Opt2-* headers", async () => {
      const token = await mintUserToken({ sub: 'relay-writer', sid: 'ids-relay-writer', site: SITE_A, roles: [Roles.systemUser] });
      target('people').setWritePosition('people=42');
      try {
        const res = await v2.app.inject({
          method: 'POST',
          url: RELAY_PATH,
          headers: {
            authorization: `Bearer ${token}`,
            ...(await invocationHeaders('web')),
            'content-type': 'application/json',
            'x-opt2-write-position': 'people=99999',
            'x-opt2-original-url': '/forged',
          },
          payload: { note: 'relay write' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-opt2-write-position']).toBeUndefined();
        expect(internalHeaders(target('people').requests.at(-1)).filter((name) => name !== INVOCATION_HEADER)).toEqual([]);
        expect(memoryOf(v2).tables.session_barrier.filter((row) => row.session_id === 'ids-relay-writer')).toEqual([
          expect.objectContaining({ owner: 'people', xid: '42', pending: 0 }),
        ]);
      } finally {
        target('people').setWritePosition();
      }
    });
  });

  describe('legacy site paths trust boundary', () => {
    const url = `${SITE_PATHS_URL}?sessionSite=default&host=localhost&themeSite=default`;

    it.each<[string, () => Promise<Headers>, number]>([
      ["web's credential", () => invocationHeaders('web'), 200],
      [
        "web's credential beside a user token, which the route does not act for",
        async () => ({ authorization: `Bearer ${await mintUserToken({ sub: 'paths-user', site: SITE_A, roles: [Roles.systemUser] })}`, ...(await invocationHeaders('web')) }),
        200,
      ],
      [
        "a user token claiming web's role beside the gateway's own credential",
        async () => ({ authorization: `Bearer ${await mintUserToken({ sub: 'paths-forger', site: SITE_A, roles: [serviceRole('web')] })}`, ...(await invocationHeaders(SERVICE_NAME)) }),
        403,
      ],
      ["web's credential addressed to people", () => invocationHeaders('web', 'people'), 401],
      ['no credential', async () => ({}), 401],
    ])('with %s', async (_label, credentials, status) => {
      const { res, before, after } = await observed({ method: 'GET', url, headers: await credentials() });
      expect({ status: res.statusCode, reached: reached(before, after) }).toEqual({ status, reached: status === 200 ? ['legacy'] : [] });
    });
  });

  describe('site-scoped user tokens', () => {
    const claimsOf = (token: string) => testVerifier().userVerifier.verify(token);
    const adminSiteCalls = (): number => v2.identity.requests.filter((req) => req.path.endsWith('/admin-site')).length;

    it.each<[string, string, string, string, boolean]>([
      ['a site-less web screen', '/opt2/admin/finance/claims', 'tenant-b', 'tenant-b', true],
      ['a site-less web screen of a session without an admin site', '/opt2/admin/finance/claims', '', 'default', true],
      ['a web screen naming its siteid', '/opt2/admin/finance/claims?siteid=tenant-a', 'tenant-b', 'tenant-a', false],
      ['a site-less non-web target', '/opt2/stub/notes', 'tenant-b', 'default', false],
      ['a non-web target naming its siteid', '/opt2/stub/notes?siteid=tenant-b', 'tenant-a', 'tenant-b', false],
    ])('%s gets a token for its site', async (_label, url, adminSite, expectedSite, readsAdminSite) => {
      const callee = url.startsWith('/opt2/admin/') ? 'web' : 'stub';
      v2.identity.setAdminSite(adminSite);
      const consulted = adminSiteCalls();
      const forged = await mintUserToken({ sub: 'forger', site: TENANT_B.siteId, roles: [Roles.s2, Roles.systemUser] });
      const res = await v2.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${forged}`, ...(await invocationHeaders('web')), 'x-opt2-original-url': '/forged' },
      });
      expect(res.statusCode).toBe(200);
      const minted = v2.identity.minted.at(-1);
      const received = target(callee).requests.at(-1);
      expect({
        siteId: minted?.request.siteId,
        authorization: received?.headers.authorization,
        tokenSite: (await claimsOf(minted?.token ?? '')).site,
        readsAdminSite: adminSiteCalls() > consulted,
        caller: await callerSeenBy(callee, received),
        internal: internalHeaders(received).filter((name) => name !== INVOCATION_HEADER),
      }).toEqual({
        siteId: expectedSite,
        authorization: `Bearer ${minted?.token ?? ''}`,
        tokenSite: expectedSite,
        readsAdminSite,
        caller: SERVICE_NAME,
        internal: [],
      });
    });

    it('forwards an admin request whose url scope the scan fails on to legacy as sent, which admin start-up answers itself', async () => {
      const url = '/admin/?muraAction=cUsers.list&x=null';
      const res = await v2.app.inject({ method: 'GET', url });
      expect({ status: res.statusCode, received: legacyPages(v2).at(-1)?.url }).toEqual({ status: 200, received: url });
    });
  });
});

/** A version whose one entry, the REST variation-targeting save, is served on its target. */
const REST_TARGET_TABLE = cutoverTable({
  tableVersion: 'v0101',
  entries: [
    entry({
      route: 'rest:variationtargeting.save',
      owningService: 'strategies-content',
      kind: 'write',
      state: 'target',
      units: ['content.variation_targeting'],
    }),
  ],
});

describe('REST writes served on their target', () => {
  let rest: TestGateway;

  beforeAll(async () => {
    rest = await buildTestGateway({ version: REST_TARGET_TABLE });
  }, 120_000);

  afterAll(async () => {
    await rest?.close();
  });

  const claimsOf = (token: string) => testVerifier().userVerifier.verify(token);

  /** The target double serving `name`. */
  const target = (name: string) => {
    const double = rest.targets[name];
    if (double === undefined) throw new TypeError(`no target double serves ${name}`);
    return double;
  };

  it("forwards a REST write with identity's token for the path's site, never the client's credential", async () => {
    const basic = `Basic ${Buffer.from(`rest-user:${randomUUID()}`).toString('base64')}`;
    rest.identity.restSession(basic, { sessionId: 'ids-rest-writer', userId: 'U-REST', siteId: SITE_A, adminSite: '', roles: [Roles.systemUser] });
    const res = await rest.app.inject({
      method: 'POST',
      url: `/_api/rest/v1/${SITE_A}/variationtargeting`,
      headers: { authorization: basic, 'content-type': 'application/json' },
      payload: { variationid: 'V1' },
    });
    expect(res.statusCode).toBe(200);
    const minted = rest.identity.minted.at(-1);
    const received = target('strategies-content').requests.at(-1);
    expect({
      authenticatedSite: rest.identity.authentications.at(-1)?.siteId,
      token: minted?.request,
      authorization: received?.headers.authorization,
      claims: await claimsOf(minted?.token ?? ''),
    }).toEqual({
      authenticatedSite: SITE_A,
      token: { sessionId: 'ids-rest-writer', siteId: SITE_A },
      authorization: `Bearer ${minted?.token ?? ''}`,
      claims: expect.objectContaining({ sub: 'U-REST', sid: 'ids-rest-writer', site: SITE_A, roles: [Roles.systemUser] }),
    });
  });

  it('authenticates a REST request on its url and form scopes as start-up script protection leaves them, forwarding it as sent', async () => {
    const url = `/_api/rest/v1/${SITE_A}/variationtargeting?variationid=%20V1%20&amp;note=n%00`;
    const payload = 'title=+%3Cscript%3Ex%3C%2Fscript%3Eok+';
    const res = await rest.app.inject({ method: 'POST', url, headers: FORM_HEADERS, payload });
    expect(res.statusCode).toBe(200);
    const authenticated = rest.identity.authentications.at(-1);
    const received = target('strategies-content').requests.at(-1);
    expect({ query: authenticated?.query, form: authenticated?.form, url: received?.url, body: received?.body.toString('utf8') }).toEqual({
      query: { variationid: 'V1', note: 'n' },
      form: expect.objectContaining({ variationid: 'V1', note: 'n', title: '[INVALID]ok' }),
      url,
      body: payload,
    });
  });

  // Legacy answers a scan fault from onRequestStart, before its JSON API reads any credential.
  it.each<[string, string, string, string]>([
    ['url', `/_api/rest/v1/${SITE_A}/variationtargeting?x=null`, 'application/json', '{"variationid":"V1"}'],
    ['form', `/_api/rest/v1/${SITE_A}/variationtargeting`, 'application/x-www-form-urlencoded', 'variationid=V1&x=%5Bnull%5D'],
  ])(
    "forwards a REST request whose %s scope legacy's scan fails on to its service unauthenticated, never asking identity",
    async (_scope, url, type, payload) => {
      const denial = { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"error":"denied"}' };
      const authorization = `Basic ${Buffer.from(`intruder:${randomUUID()}`).toString('base64')}`;
      const service = target('strategies-content');
      rest.identity.onAuthenticate(() => ({ outcome: 'denied', sessionId: null, legacyResponse: denial }));
      service.setResponse({ status: 500, headers: { 'Content-Type': 'text/html;charset=UTF-8' }, body: 'error page' });
      try {
        const asked = rest.identity.authentications.length;
        const faulted = await rest.app.inject({ method: 'POST', url, headers: { authorization, 'content-type': type }, payload });
        const received = service.requests.at(-1);
        const clean = await rest.app.inject({
          method: 'POST',
          url: `/_api/rest/v1/${SITE_A}/variationtargeting`,
          headers: { authorization, 'content-type': type },
          payload: type === 'application/json' ? payload : 'variationid=V1',
        });
        expect({
          faulted: [faulted.statusCode, faulted.body],
          forwarded: { url: received?.url, authorization: received?.headers.authorization },
          clean: [clean.statusCode, clean.body],
          asked: rest.identity.authentications.length - asked,
        }).toEqual({
          faulted: [500, 'error page'],
          forwarded: { url, authorization: undefined },
          clean: [401, denial.body],
          asked: 1,
        });
      } finally {
        rest.identity.onAuthenticate(undefined);
        service.setResponse();
      }
    },
  );

  it('forwards an unauthenticated REST write without any Authorization', async () => {
    const service = target('strategies-content');
    const before = service.requests.length;
    const res = await rest.app.inject({
      method: 'POST',
      url: `/_api/rest/v1/${SITE_A}/variationtargeting`,
      headers: { authorization: `Basic ${Buffer.from(`unknown:${randomUUID()}`).toString('base64')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(service.requests).toHaveLength(before + 1);
    expect(service.requests.at(-1)?.headers.authorization).toBeUndefined();
  });
});

describe('deny by default at start-up', () => {
  /** Builds the gateway without background loops, lets `declare` add a route and awaits `ready`; everything it opened is closed. */
  async function startWith(declare: (app: FastifyInstance) => unknown): Promise<void> {
    await prepareTestStateDir();
    const db = createMemoryGatewayDb();
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({ env: testEnv(), clock: TEST_CLOCK, verifierOverride: testVerifier(), db, startBackground: false });
      declare(app);
      await app.ready();
    } finally {
      // shutdown() also ends the injected store.
      await (app === undefined ? db.end() : app.opt2.shutdown().catch(() => undefined));
    }
  }

  const handler = async (): Promise<object> => ({});

  it.each<[string, (app: FastifyInstance) => unknown]>([
    ['no config.opt2', (app) => app.get('/internal/v1/undeclared', handler)],
    ['a config.opt2 declaring neither requires nor public', (app) => app.get('/internal/v1/undeclared', { config: { opt2: {} } }, handler)],
    ['an empty requires list', (app) => app.get('/internal/v1/undeclared', { config: { opt2: { requires: [] } } }, handler)],
    [
      'both requires and public',
      (app) => app.get('/internal/v1/undeclared', { config: { opt2: { requires: [Roles.platformOperator], public: true } } }, handler),
    ],
    [
      'an edge flag on a role-gated route',
      (app) => app.get('/undeclared-edge', { config: { opt2: { requires: [Roles.platformOperator], edge: true } } }, handler),
    ],
    [
      'the service transport on a managed-task path',
      (app) => app.post('/internal/v1/tasks/undeclared', { config: { opt2: { transport: 'service', requires: [Roles.platformOperator] } } }, handler),
    ],
    [
      'no config.opt2 inside a plugin scope',
      (app) =>
        app.register(async (scope) => {
          scope.get('/opt2-undeclared', async () => 'never');
        }),
    ],
  ])('fails start-up for a route with %s', async (_label, declare) => {
    await expect(startWith(declare)).rejects.toBeInstanceOf(UndeclaredRouteError);
  });

  it('starts when every added route declares its roles', async () => {
    await expect(
      startWith((app) => app.get('/internal/v1/declared', { config: { opt2: { requires: [Roles.platformOperator] } } }, handler)),
    ).resolves.toBeUndefined();
  });
});
