// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** In-process authorisation matrix of every e-signature route: declarations, fixture role sets, admitted subjects, tenant and transport boundaries. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  Roles,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  hasAnyRole,
  isServiceRole,
  serviceRole,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, pushPath, type EventEnvelope } from '@opt2/platform/events';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { SITE_CHANGED_TOPIC } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  isAck,
  mintServiceToken,
  mintTasksInvokerToken,
  pushTo,
  registryPayloads,
  subjectSiteFor,
  testEnvelope,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/envelope.js';
import type { SignatureRequestRow } from '../../src/repo/tables.js';
import { FIXTURE_OPERATIONS, FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { V1_PREFIX } from '../../src/routes/v1.js';
import { CSRF_HEADERS, TEST_CLOCK, buildTestApp, type TestApp } from '../helpers/app.js';
import {
  AUDITOR_USER_ID,
  OTHER_USER_ID,
  SIGNER_USER_ID,
  SUBJECTS,
  headersFor,
  migrationHeaders,
  pushQuery,
  userHeaders,
} from '../helpers/tokens.js';

const SERVICE = 'e-signature';
const CONTRACT = new URL('../../contracts/openapi.yaml', import.meta.url);
const FIXTURE = '/legacy-fixtures/cfml/api.cfm/esignature';
const V1 = '/v1/esignature';
const MIGRATION = '/internal/v1/migration';
const PUSH_URL = '/internal/v1/events/e-signature.programs-sites.site.changed.v1';
const UNSEEDED_ID = 'E51A7E57-0000-4000-8000000000000001';
const SEEDED_ID = 'E51A7E57-0000-4000-8000000000000002';
const WRONG_PUSH_KEY = 'opt2-wrong-push-key';
const DENIED: ReadonlySet<number> = new Set([401, 403]);
const JSON_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json' };
const HTTP_METHODS: readonly string[] = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

type Method = 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT';

/** One route declaration as `collectRouteMatrix` reports it. */
interface ExpectedRoute {
  method: Method;
  url: string;
  transport: Transport;
  requires?: readonly string[];
  public?: true;
  siteCheck: boolean;
}

const SIGNERS: readonly string[] = [Roles.esignatureSigner];
const CHAIN_READERS: readonly string[] = [Roles.esignatureAuditor, Roles.esignatureSigner];
const MIGRATION_ONLY: readonly string[] = [Roles.platformMigration];

/** esignature.cfc role group of each fixture operation: requireAny for list, create and sign, authorizeChainReader for audit and verify. */
const FIXTURE_ROLES: Readonly<Record<string, readonly string[]>> = {
  [`GET ${FIXTURE}/requests`]: SIGNERS,
  [`POST ${FIXTURE}/requests`]: SIGNERS,
  [`POST ${FIXTURE}/requests/:id/sign`]: SIGNERS,
  [`GET ${FIXTURE}/requests/:id/audit`]: CHAIN_READERS,
  [`GET ${FIXTURE}/requests/:id/verify`]: CHAIN_READERS,
  [`POST ${FIXTURE}/requests/:id/verify`]: CHAIN_READERS,
};

const FIXTURE_URLS: readonly string[] = [`${FIXTURE}/requests`, `${FIXTURE}/requests/:id/audit`, `${FIXTURE}/requests/:id/sign`, `${FIXTURE}/requests/:id/verify`];
const FIXTURE_METHODS: readonly Method[] = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];

// api.cfm runs for every request method and resolves the site before esignature.cfc checks login and role, so the fixture routes are
// public on the platform with the site check off, and their handler applies FIXTURE_ROLES.
const EXPECTED_ROUTES: readonly ExpectedRoute[] = [
  { method: 'GET', url: '/healthz', transport: 'service', public: true, siteCheck: true },
  ...FIXTURE_URLS.flatMap((url) =>
    FIXTURE_METHODS.map((method): ExpectedRoute => ({ method, url, transport: 'service', public: true, siteCheck: false })),
  ),
  { method: 'GET', url: `${V1}/requests`, transport: 'service', requires: SIGNERS, siteCheck: true },
  { method: 'POST', url: `${V1}/requests`, transport: 'service', requires: SIGNERS, siteCheck: true },
  { method: 'GET', url: `${V1}/requests/:id`, transport: 'service', requires: CHAIN_READERS, siteCheck: true },
  { method: 'POST', url: `${V1}/requests/:id/sign`, transport: 'service', requires: SIGNERS, siteCheck: true },
  { method: 'GET', url: `${V1}/requests/:id/audit`, transport: 'service', requires: CHAIN_READERS, siteCheck: true },
  { method: 'GET', url: `${V1}/requests/:id/verify`, transport: 'service', requires: CHAIN_READERS, siteCheck: true },
  { method: 'POST', url: `${V1}/requests/:id/verify`, transport: 'service', requires: CHAIN_READERS, siteCheck: true },
  { method: 'POST', url: `${MIGRATION}/apply`, transport: 'service', requires: MIGRATION_ONLY, siteCheck: true },
  { method: 'GET', url: `${MIGRATION}/export`, transport: 'service', requires: MIGRATION_ONLY, siteCheck: true },
  { method: 'GET', url: `${MIGRATION}/changes`, transport: 'service', requires: MIGRATION_ONLY, siteCheck: true },
  { method: 'GET', url: `${MIGRATION}/position`, transport: 'service', requires: MIGRATION_ONLY, siteCheck: true },
  { method: 'GET', url: `${MIGRATION}/watermark`, transport: 'service', requires: MIGRATION_ONLY, siteCheck: true },
  { method: 'POST', url: `${MIGRATION}/watermark`, transport: 'service', requires: MIGRATION_ONLY, siteCheck: true },
  { method: 'POST', url: `${MIGRATION}/gate`, transport: 'service', requires: MIGRATION_ONLY, siteCheck: true },
  { method: 'POST', url: PUSH_URL, transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE], siteCheck: true },
];

const SYNTHETIC_SUBJECTS: readonly string[] = [
  'esignature.signer',
  'esignature.auditor',
  'timesheets.employee',
  'timesheets.primary-approver',
  'timesheets.secondary-approver',
  'finance.preparer',
  'finance.approver',
  'reporting.exporter',
  'surveys.manager',
  'communications.sender',
];

const REQUIRED_SUBJECTS: readonly string[] = [
  'anonymous',
  'member',
  'system-user',
  'editor',
  'site-admin',
  's2',
  'other-tenant',
  ...SYNTHETIC_SUBJECTS,
  'service:gateway',
  'service:migration',
  'service:operator',
  'service:pubsub-invoker',
  'service:tasks-invoker',
];

/** `<METHOD> <url>` of a route. */
function keyOf(route: { method: string; url: string }): string {
  return `${route.method} ${route.url}`;
}

/** Routes ordered by url, then method, as `collectRouteMatrix` orders them. */
function ordered<T extends { method: string; url: string }>(routes: readonly T[]): T[] {
  return [...routes].sort((a, b) => a.url.localeCompare(b.url, 'en') || a.method.localeCompare(b.method, 'en'));
}

/** A declaration in comparable form: `requires` sorted, `public` only when set. */
function comparable(route: ExpectedRoute | RouteMatrixEntry): Record<string, unknown> {
  return {
    method: route.method,
    url: route.url,
    transport: route.transport,
    ...(route.requires === undefined ? {} : { requires: [...route.requires].sort() }),
    ...(route.public === true ? { public: true } : {}),
    siteCheck: route.siteCheck,
  };
}

function isFixtureRoute(route: { url: string }): boolean {
  return route.url.startsWith(`${FIXTURE}/`);
}

function isV1Route(route: { url: string }): boolean {
  return route.url.startsWith(`${V1}/`);
}

/** One operation of `contracts/openapi.yaml`, its path in Fastify form. */
interface ContractOperation {
  method: string;
  url: string;
  transport: string | undefined;
  requires: string[];
  public: boolean;
  siteCheck: boolean;
}

/** Operations under `paths:`, read by indentation: path keys at 2 spaces, methods at 4, `x-opt2-*` at 6 and `requires` items at 8. */
function contractOperations(contract: string): ContractOperation[] {
  const operations: ContractOperation[] = [];
  let inPaths = false;
  let path: string | undefined;
  let operation: ContractOperation | undefined;
  let inRequires = false;
  for (const line of contract.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      inPaths = /^paths:\s*$/.test(line);
      path = undefined;
      operation = undefined;
      continue;
    }
    if (!inPaths) continue;
    if (/^ {2}\S/.test(line)) {
      path = /^ {2}(['"]?)(\/[^'"]*)\1:\s*$/.exec(line)?.[2];
      operation = undefined;
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      const method = /^ {4}([a-z]+):\s*$/.exec(line)?.[1];
      operation =
        path !== undefined && method !== undefined && HTTP_METHODS.includes(method)
          ? { method: method.toUpperCase(), url: path.replace(/\{(\w+)\}/g, ':$1'), transport: undefined, requires: [], public: false, siteCheck: true }
          : undefined;
      if (operation !== undefined) operations.push(operation);
      inRequires = false;
      continue;
    }
    if (operation === undefined) continue;
    if (/^ {6}\S/.test(line)) {
      const extension = /^ {6}x-opt2-(transport|public|site-check|requires):\s*(.*?)\s*$/.exec(line);
      inRequires = extension?.[1] === 'requires';
      if (extension?.[1] === 'transport') operation.transport = extension[2];
      if (extension?.[1] === 'public') operation.public = extension[2] === 'true';
      if (extension?.[1] === 'site-check') operation.siteCheck = extension[2] !== 'false';
      continue;
    }
    const item = /^ {8}- (\S+)\s*$/.exec(line);
    if (inRequires && item?.[1] !== undefined) operation.requires.push(item[1]);
  }
  return operations;
}

/** A contract operation in the form of `comparable`. */
function comparableOperation(operation: ContractOperation): Record<string, unknown> {
  return {
    method: operation.method,
    url: operation.url,
    transport: operation.transport,
    ...(operation.requires.length === 0 ? {} : { requires: [...operation.requires].sort() }),
    ...(operation.public ? { public: true } : {}),
    siteCheck: operation.siteCheck,
  };
}

/** Whether `subject` is the managed Pub/Sub push identity. */
function isPushInvoker(subject: RoleSubject): boolean {
  return subject.kind === 'service' && subject.roles.includes(PUBSUB_INVOKER_ROLE);
}

/** Whether `subject` is the managed Cloud Tasks identity. */
function isTasksInvoker(subject: RoleSubject): boolean {
  return subject.kind === 'service' && subject.roles.includes(TASKS_INVOKER_ROLE);
}

/** Whether `subject` presents an invocation credential: users through the gateway, workloads other than the managed invokers. */
function presentsInvocation(subject: RoleSubject): boolean {
  return subject.kind === 'user' || (subject.kind === 'service' && !isPushInvoker(subject) && !isTasksInvoker(subject));
}

/** Roles the hook grants `subject`: a user's token roles beside the gateway's workload role, or the workload's own roles. */
function grantedRoles(subject: RoleSubject): string[] {
  if (subject.kind === 'user') return [...subject.roles.filter((role) => !isServiceRole(role)), serviceRole('gateway')];
  return [...subject.roles];
}

/** A user whose token names a site of another tenant than tenant-a, the site under test. */
function isOtherSite(subject: RoleSubject): boolean {
  return subject.kind === 'user' && subjectSiteFor(subject, TENANT_A.siteId) !== TENANT_A.siteId;
}

/** Exact outcome of one cell: admitted (any status but 401 and 403), or the denial status. */
type Verdict = 'allow' | 401 | 403;

/** api.cfm and esignature.cfc in order: the site (403 for another tenant), the method's operation (notFound), login (401), then the role (403). */
function fixtureVerdict(route: RouteMatrixEntry, subject: RoleSubject): Verdict {
  if (isOtherSite(subject)) return 403;
  const roles = FIXTURE_ROLES[keyOf(route)];
  if (roles === undefined) return 'allow';
  if (subject.kind !== 'user') return 401;
  return hasAnyRole(subject.roles, roles) ? 'allow' : 403;
}

/** The verdict `route`'s declaration gives `subject`; fixture routes add their handler's FIXTURE_ROLES check. */
function expectedVerdict(route: RouteMatrixEntry, subject: RoleSubject): Verdict {
  const requires = route.requires ?? [];
  if (route.transport === 'pubsub-push') return isPushInvoker(subject) && hasAnyRole(grantedRoles(subject), requires) ? 'allow' : 401;
  if (route.transport === 'cloud-tasks') return isTasksInvoker(subject) && hasAnyRole(grantedRoles(subject), requires) ? 'allow' : 401;
  // The tasks-invoker token in Authorization is verified as a user token and refused, public routes included.
  if (isTasksInvoker(subject)) return 401;
  if (route.public === true) return isFixtureRoute(route) ? fixtureVerdict(route, subject) : 'allow';
  if (!presentsInvocation(subject)) return 401;
  if (!hasAnyRole(grantedRoles(subject), requires)) {
    return subject.kind !== 'user' && requires.some((role) => !isServiceRole(role)) ? 401 : 403;
  }
  return route.siteCheck && isOtherSite(subject) ? 403 : 'allow';
}

function matches(verdict: Verdict, status: number): boolean {
  return verdict === 'allow' ? !DENIED.has(status) : status === verdict;
}

/** The registry payload of tenant-a as a `programs-sites.site.changed.v1` envelope. */
function siteChangedEnvelope(): EventEnvelope {
  const site = registryPayloads().find((payload) => payload.siteId === TENANT_A.siteId);
  if (site === undefined) throw new TypeError(`registryPayloads has no ${TENANT_A.siteId} payload`);
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: TENANT_A.siteId, payload: site });
}

/** A Pub/Sub push body delivering `envelope` to the e-signature site subscription. */
function pushBody(envelope: EventEnvelope): Record<string, unknown> {
  return { ...buildPushBody({ data: encodeEnvelope(envelope), messageId: randomUUID(), subscription: SITE_CHANGED_SUBSCRIPTION }) };
}

/** One `app.inject` request without credentials. */
interface ProbeRequest {
  method: Method;
  url: string;
  headers: Record<string, string>;
  payload?: Record<string, unknown>;
}

function methodOf(route: RouteMatrixEntry): Method {
  const method = FIXTURE_METHODS.find((candidate) => candidate === route.method);
  if (method === undefined) throw new TypeError(`${keyOf(route)}: no request builder for this method`);
  return method;
}

/**
 * The matrix request of `route` as `subject`: the unseeded id in the path, `siteid` of tenant-a where the platform or the fixture
 * checks it, the push key for the push invoker only, a push delivery or `{}` as a POST body.
 */
function probeFor(route: RouteMatrixEntry, subject: RoleSubject): ProbeRequest {
  const query = new URLSearchParams();
  if (isFixtureRoute(route) || (route.transport === 'service' && route.public !== true && route.siteCheck)) query.set('siteid', TENANT_A.siteId);
  if (isPushInvoker(subject)) for (const [name, value] of new URLSearchParams(pushQuery())) query.set(name, value);
  const path = route.url.replace(':id', UNSEEDED_ID);
  const url = query.size === 0 ? path : `${path}?${query.toString()}`;
  const method = methodOf(route);
  if (method !== 'POST') return { method, url, headers: {} };
  return { method, url, headers: { ...JSON_HEADERS }, payload: route.transport === 'pubsub-push' ? pushBody(siteChangedEnvelope()) : {} };
}

/** What one request answered and left: status, body and the writes and people reads it caused. */
interface Outcome {
  status: number;
  body: string;
  writes: number;
  peopleCalls: number;
  tenants: string[];
}

/** Sends `request` with `credentials` on `t`, counting its committed writes, people reads and transaction tenants. */
async function send(t: TestApp, request: ProbeRequest, credentials: Readonly<Record<string, string>> = {}): Promise<Outcome> {
  t.db.clear();
  const peopleBefore = t.peopleClient.calls.length;
  const res: InjectResponse = await t.app.inject({
    method: request.method,
    url: request.url,
    headers: { ...request.headers, ...credentials },
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  });
  return {
    status: res.statusCode,
    body: res.body,
    writes: t.db.writes().length,
    peopleCalls: t.peopleClient.calls.length - peopleBefore,
    tenants: [...new Set(t.db.queries().flatMap((query) => (query.tenantId === null ? [] : [query.tenantId.toLowerCase()])))],
  };
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `error.code` and `error.message` of an error envelope, undefined for any other body. */
function errorOf(body: string): { code: unknown; message: unknown } | undefined {
  const envelope = parsed(body);
  if (!isRecord(envelope) || !isRecord(envelope.error)) return undefined;
  return { code: envelope.error.code, message: envelope.error.message };
}

/** One route × subject cell of the matrix. */
interface Cell extends Outcome {
  route: RouteMatrixEntry;
  subject: RoleSubject;
  expected: Verdict;
}

/** A cell whose status departs from its verdict. */
interface Mismatch {
  method: string;
  url: string;
  subject: string;
  expected: Verdict;
  status: number;
}

function subjectNamed(name: string): RoleSubject {
  const subject = SUBJECTS.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`SUBJECTS has no subject named ${name}`);
  return subject;
}

let t: TestApp;
let matrix: readonly RouteMatrixEntry[] = [];

function routeOf(method: Method, url: string): RouteMatrixEntry {
  const route = matrix.find((candidate) => candidate.method === method && candidate.url === url);
  if (route === undefined) throw new TypeError(`the e-signature app registers no ${method} ${url}`);
  return route;
}

beforeAll(async () => {
  t = await buildTestApp();
  matrix = collectRouteMatrix(t.app).routes;
});

afterAll(async () => {
  await t?.app.close();
});

describe('route declarations', () => {
  it('serves the fixture module and the v1 routes under their prefixes', () => {
    expect({ fixture: FIXTURE_PREFIX, v1: V1_PREFIX, push: pushPath(SITE_CHANGED_SUBSCRIPTION) }).toEqual({ fixture: FIXTURE, v1: V1, push: PUSH_URL });
  });

  it('declares exactly the expected routes', () => {
    expect(EXPECTED_ROUTES).toHaveLength(44);
    expect(ordered(matrix).map(comparable)).toEqual(ordered(EXPECTED_ROUTES).map(comparable));
  });

  it('fixture role sets equal esignature.cfc', () => {
    const declared = Object.fromEntries(FIXTURE_OPERATIONS.map((operation) => [keyOf(operation), [...operation.requires].sort()]));
    const oracle = Object.fromEntries(Object.entries(FIXTURE_ROLES).map(([key, roles]) => [key, [...roles].sort()]));
    expect(declared).toEqual(oracle);
    const roles = new Set([...FIXTURE_OPERATIONS.flatMap((operation) => operation.requires), ...matrix.filter(isV1Route).flatMap((route) => route.requires ?? [])]);
    expect([...roles].sort()).toEqual([Roles.esignatureAuditor, Roles.esignatureSigner].sort());
  });

  it('declarations equal the contract', async () => {
    const operations = contractOperations(await readFile(CONTRACT, 'utf8'));
    expect(operations).toHaveLength(matrix.length);
    expect(ordered(operations).map(comparableOperation)).toEqual(ordered(matrix).map(comparable));
  });

  it('only contract-declared public routes are public', async () => {
    const declared = contractOperations(await readFile(CONTRACT, 'utf8')).filter((operation) => operation.public).map(keyOf).sort();
    const exposed = matrix.filter((route) => route.public === true).map(keyOf).sort();
    expect(exposed).toEqual(declared);
    expect(exposed.filter((key) => !key.includes(` ${FIXTURE}/`))).toEqual(['GET /healthz']);
  });
});

describe('authorisation matrix', () => {
  const cells: Cell[] = [];

  beforeAll(async () => {
    for (const route of matrix) {
      for (const subject of SUBJECTS) {
        const outcome = await send(t, probeFor(route, subject), await headersFor(subject, { site: TENANT_A.siteId }));
        cells.push({ route, subject, expected: expectedVerdict(route, subject), ...outcome });
      }
    }
  });

  it('subjects include every required identity', () => {
    const names = SUBJECTS.map((subject) => subject.name);
    expect(REQUIRED_SUBJECTS.filter((name) => !names.includes(name))).toEqual([]);
    const carriers = (role: string): string[] => SUBJECTS.filter((subject) => subject.roles.includes(role)).map((subject) => subject.name);
    expect({ migration: carriers(Roles.platformMigration), operator: carriers(Roles.platformOperator) }).toEqual({
      migration: ['service:migration'],
      operator: ['service:operator'],
    });
    expect(subjectNamed('other-tenant').crossTenant).toBe(true);
  });

  it('probes every route once per subject', () => {
    expect(matrix).toHaveLength(EXPECTED_ROUTES.length);
    expect(cells).toHaveLength(matrix.length * SUBJECTS.length);
    expect(new Set(cells.map((cell) => `${keyOf(cell.route)} × ${cell.subject.name}`)).size).toBe(cells.length);
  });

  it('zero unexpected allows and zero unexpected denies', () => {
    const mismatches: Mismatch[] = cells
      .filter((cell) => !matches(cell.expected, cell.status))
      .map((cell) => ({ method: cell.route.method, url: cell.route.url, subject: cell.subject.name, expected: cell.expected, status: cell.status }));
    expect(mismatches).toEqual([]);
  });

  it('every route admits at least one subject', () => {
    expect(matrix.filter((route) => !cells.some((cell) => cell.route === route && cell.expected === 'allow')).map(keyOf)).toEqual([]);
  });

  it('denials leave no write and no people read', () => {
    const offending = cells
      .filter((cell) => DENIED.has(cell.status) && (cell.writes !== 0 || cell.peopleCalls !== 0))
      .map((cell) => `${keyOf(cell.route)} × ${cell.subject.name}: ${cell.writes} writes, ${cell.peopleCalls} people reads`);
    expect(offending).toEqual([]);
  });

  it('answers every denial in an error envelope', () => {
    const offending = cells
      .filter((cell) => DENIED.has(cell.status) && cell.route.method !== 'HEAD')
      .filter((cell) => {
        const error = errorOf(cell.body);
        return error === undefined || typeof error.code !== 'string' || typeof error.message !== 'string';
      })
      .map((cell) => `${keyOf(cell.route)} × ${cell.subject.name} (${cell.status}): ${cell.body.slice(0, 160)}`);
    expect(offending).toEqual([]);
  });

  it('other-tenant answers 403 on every fixture and v1 route', () => {
    const probed = cells.filter((cell) => cell.subject.name === 'other-tenant' && (isFixtureRoute(cell.route) || isV1Route(cell.route)));
    expect(probed).toHaveLength(FIXTURE_URLS.length * FIXTURE_METHODS.length + matrix.filter(isV1Route).length);
    expect(probed.filter((cell) => cell.status !== 403).map((cell) => `${keyOf(cell.route)} (${cell.status})`)).toEqual([]);
  });
});

describe('denial shape', () => {
  // `envelope` is the fixture envelope's `method`; the /v1 routes answer in the platform's legacy error envelope.
  const SAMPLES = [
    { subject: 'anonymous', method: 'GET', url: `${FIXTURE}/requests`, status: 401, type: 'authorization', envelope: 'esignature.requests' },
    { subject: 'editor', method: 'POST', url: `${FIXTURE}/requests/:id/sign`, status: 403, type: 'forbidden', envelope: 'esignature.requests.sign' },
    { subject: 'anonymous', method: 'GET', url: `${V1}/requests`, status: 401, type: 'authorization', envelope: undefined },
    { subject: 'editor', method: 'POST', url: `${V1}/requests/:id/sign`, status: 403, type: 'authorization', envelope: undefined },
  ] as const;

  it.each(SAMPLES)('$subject on $method $url answers $status $type', async ({ subject, method, url, status, type, envelope }) => {
    const named = subjectNamed(subject);
    const outcome = await send(t, probeFor(routeOf(method, url), named), await headersFor(named));
    const spec = FIXTURE_ERROR_MAP[type];
    const body = parsed(outcome.body);
    expect({
      status: outcome.status,
      error: errorOf(outcome.body),
      ...(envelope === undefined ? {} : { method: isRecord(body) ? body.method : undefined }),
      writes: outcome.writes,
      peopleCalls: outcome.peopleCalls,
    }).toEqual({
      status,
      error: { code: spec.code, message: spec.message },
      ...(envelope === undefined ? {} : { method: envelope }),
      writes: 0,
      peopleCalls: 0,
    });
  });
});

describe('tenant from the token only', () => {
  const DOCUMENT = Buffer.from('%PDF-1.7 e-signature authz probe\n');
  const SEEDED_REQUEST: SignatureRequestRow = {
    tenant_id: TENANT_A.tenantId,
    request_id: SEEDED_ID,
    siteid: TENANT_A.siteId,
    document_name: 'authz-probe.pdf',
    document_sha256: createHash('sha256').update(DOCUMENT).digest('hex'),
    document: DOCUMENT,
    signer_user_id: SIGNER_USER_ID,
    state: 'PENDING',
    created: TEST_CLOCK.now(),
    createdbyid: SIGNER_USER_ID,
    row_version: '1',
  };
  const CREATE_FIELDS = { documentName: 'authz-create.pdf', documentBase64: DOCUMENT.toString('base64'), signerUserId: SIGNER_USER_ID };
  /** Query parameters and the header a caller could use to name tenant A instead of its token's tenant. */
  const TENANT_HINT_QUERY = new URLSearchParams({ tid: TENANT_A.tenantId, tenant_id: TENANT_A.tenantId, tenantId: TENANT_A.tenantId }).toString();
  const TENANT_HINT_HEADERS = { 'x-opt2-tenant': TENANT_A.tenantId };

  let v: TestApp;

  beforeAll(async () => {
    v = await buildTestApp({ seed: { signature_request: [SEEDED_REQUEST] } });
  });

  afterAll(async () => {
    await v?.app.close();
  });

  const signerA = (): Promise<Record<string, string>> => userHeaders({ sub: SIGNER_USER_ID, site: TENANT_A.siteId, roles: [Roles.esignatureSigner] });
  const auditorA = (): Promise<Record<string, string>> => userHeaders({ sub: AUDITOR_USER_ID, site: TENANT_A.siteId, roles: [Roles.esignatureAuditor] });
  const auditorB = (): Promise<Record<string, string>> => userHeaders({ sub: OTHER_USER_ID, site: TENANT_B.siteId, roles: [Roles.esignatureAuditor] });

  /** A create request on `url` for the site `siteid`, its fields in a JSON body. */
  function createRequest(url: string, siteid: string): ProbeRequest {
    return { method: 'POST', url: `${url}?siteid=${siteid}`, headers: { ...JSON_HEADERS, ...CSRF_HEADERS }, payload: { ...CREATE_FIELDS } };
  }

  it.each([`${FIXTURE}/requests`, `${V1}/requests`])('POST %s with another tenant siteid answers 403 without a write', async (url) => {
    const denied = await send(v, createRequest(url, TENANT_B.siteId), await signerA());
    expect({ status: denied.status, writes: denied.writes, peopleCalls: denied.peopleCalls }).toEqual({ status: 403, writes: 0, peopleCalls: 0 });
    const admitted = await send(v, createRequest(url, TENANT_A.siteId), await signerA());
    expect({ status: admitted.status, written: admitted.writes > 0, tenants: admitted.tenants }).toEqual({
      status: 200,
      written: true,
      tenants: [TENANT_A.tenantId.toLowerCase()],
    });
  });

  it('a tenant-a auditor reads the tenant-a request', async () => {
    const outcome = await send(v, { method: 'GET', url: `${V1}/requests/${SEEDED_ID}`, headers: {} }, await auditorA());
    const body = parsed(outcome.body);
    expect({ status: outcome.status, requestId: isRecord(body) ? body.request_id : undefined }).toEqual({ status: 200, requestId: SEEDED_ID });
  });

  it('a tenant-b auditor naming tenant a outside its token gets 404 on v1', async () => {
    const outcome = await send(
      v,
      { method: 'GET', url: `${V1}/requests/${SEEDED_ID}?${TENANT_HINT_QUERY}`, headers: { ...TENANT_HINT_HEADERS } },
      await auditorB(),
    );
    expect({ status: outcome.status, error: errorOf(outcome.body), tenants: outcome.tenants }).toEqual({
      status: 404,
      error: { code: FIXTURE_ERROR_MAP.notFound.code, message: FIXTURE_ERROR_MAP.notFound.message },
      tenants: [TENANT_B.tenantId.toLowerCase()],
    });
  });

  it('a tenant-b auditor naming tenant a outside its token gets the fixture notFound envelope', async () => {
    const outcome = await send(
      v,
      { method: 'GET', url: `${FIXTURE}/requests/${SEEDED_ID}/audit?${TENANT_HINT_QUERY}`, headers: { ...TENANT_HINT_HEADERS } },
      await auditorB(),
    );
    const body = parsed(outcome.body);
    expect({
      status: outcome.status,
      method: isRecord(body) ? body.method : undefined,
      error: errorOf(outcome.body),
      tenants: outcome.tenants,
    }).toEqual({
      status: FIXTURE_ERROR_MAP.notFound.status,
      method: 'esignature.requests.audit',
      error: { code: FIXTURE_ERROR_MAP.notFound.code, message: FIXTURE_ERROR_MAP.notFound.message },
      tenants: [TENANT_B.tenantId.toLowerCase()],
    });
  });
});

describe('transport separation', () => {
  const noCredential = async (): Promise<Record<string, string>> => ({});
  const tasksInvoker = async (): Promise<Record<string, string>> => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` });
  const pubsubServiceToken = (): Promise<string> => mintServiceToken({ caller: 'pubsub-invoker', audience: SERVICE, roles: [PUBSUB_INVOKER_ROLE] });
  /** The headers of `credentials` with `header` removed. */
  const without = (credentials: () => Promise<Record<string, string>>, header: string) => async (): Promise<Record<string, string>> =>
    Object.fromEntries(Object.entries(await credentials()).filter(([name]) => name.toLowerCase() !== header.toLowerCase()));
  const signerToken = (): Promise<Record<string, string>> => userHeaders({ sub: SIGNER_USER_ID, roles: [Roles.esignatureSigner] });

  /** The anonymous matrix request of `method` `url`, with `key` added to its query when set. */
  function request(method: Method, url: string, key?: string): ProbeRequest {
    const probe = probeFor(routeOf(method, url), subjectNamed('anonymous'));
    if (key === undefined) return probe;
    return { ...probe, url: `${probe.url}${probe.url.includes('?') ? '&' : '?'}${new URLSearchParams({ key }).toString()}` };
  }

  it('admits a push delivery carrying the push key', async () => {
    const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope());
    expect(isAck(res), res.body).toBe(true);
  });

  const PUSH_KEY = new URLSearchParams(pushQuery()).get('key') ?? '';

  const PUSH_REFUSALS: ReadonlyArray<{ title: string; key?: string; credentials: () => Promise<Record<string, string>>; status: number }> = [
    { title: 'no key', credentials: noCredential, status: 401 },
    { title: 'a wrong key', key: WRONG_PUSH_KEY, credentials: noCredential, status: 401 },
    { title: 'an s2 user token and no key', credentials: () => headersFor('s2'), status: 401 },
    { title: 'the push key beside an s2 user token', key: PUSH_KEY, credentials: () => headersFor('s2'), status: 401 },
    { title: 'a pubsub-invoker service token in Authorization', credentials: async () => ({ authorization: `Bearer ${await pubsubServiceToken()}` }), status: 401 },
    { title: 'a pubsub-invoker service token as invocation credential', credentials: async () => ({ [INVOCATION_HEADER]: `Bearer ${await pubsubServiceToken()}` }), status: 401 },
  ];

  it.each(PUSH_REFUSALS)('refuses push delivery with $title', async ({ key, credentials, status }) => {
    const outcome = await send(t, request('POST', PUSH_URL, key), await credentials());
    expect({ status: outcome.status, writes: outcome.writes }).toEqual({ status, writes: 0 });
  });

  const MIGRATION_ROUTES: ReadonlyArray<readonly [Method, string]> = [
    ['GET', `${MIGRATION}/position`],
    ['POST', `${MIGRATION}/gate`],
  ];

  it.each(MIGRATION_ROUTES)('admits the migration identity on %s %s', async (method, url) => {
    const outcome = await send(t, request(method, url), await migrationHeaders());
    expect(DENIED.has(outcome.status)).toBe(false);
  });

  const MIGRATION_REFUSALS: ReadonlyArray<{ title: string; key?: string; credentials: () => Promise<Record<string, string>>; status: number }> = [
    { title: 'an s2 user', credentials: () => headersFor('s2'), status: 403 },
    { title: 'a user token without an invocation credential', credentials: without(() => headersFor('s2'), INVOCATION_HEADER), status: 401 },
    { title: 'the push key alone', key: PUSH_KEY, credentials: noCredential, status: 401 },
    { title: 'the tasks-invoker token', credentials: tasksInvoker, status: 401 },
    { title: 'the operator workload', credentials: () => headersFor('platform.operator'), status: 403 },
  ];

  it.each(MIGRATION_ROUTES.flatMap(([method, url]) => MIGRATION_REFUSALS.map((refusal) => ({ method, url, ...refusal }))))(
    'refuses $title on $method $url',
    async ({ method, url, key, credentials, status }) => {
      const outcome = await send(t, request(method, url, key), await credentials());
      expect({ status: outcome.status, writes: outcome.writes }).toEqual({ status, writes: 0 });
    },
  );

  const USER_ROUTES: readonly string[] = [`${FIXTURE}/requests`, `${V1}/requests`];

  const USER_REFUSALS: ReadonlyArray<{ title: string; key?: string; credentials: () => Promise<Record<string, string>> }> = [
    { title: 'the push key alone', key: PUSH_KEY, credentials: noCredential },
    { title: 'the tasks-invoker token', credentials: tasksInvoker },
    { title: 'a pubsub-invoker service token', credentials: async () => ({ [INVOCATION_HEADER]: `Bearer ${await pubsubServiceToken()}` }) },
    { title: 'a pubsub-invoker service token in Authorization', credentials: async () => ({ authorization: `Bearer ${await pubsubServiceToken()}` }) },
    { title: 'a signer token without an invocation credential', credentials: without(signerToken, INVOCATION_HEADER) },
  ];

  it.each(USER_ROUTES)('admits a tenant-a signer on GET %s', async (url) => {
    const outcome = await send(t, request('GET', url), await signerToken());
    expect(outcome.status).toBe(200);
  });

  it.each(USER_ROUTES.flatMap((url) => USER_REFUSALS.map((refusal) => ({ url, ...refusal }))))(
    'refuses $title on GET $url',
    async ({ url, key, credentials }) => {
      const outcome = await send(t, request('GET', url, key), await credentials());
      expect({ denied: DENIED.has(outcome.status), writes: outcome.writes, peopleCalls: outcome.peopleCalls }).toEqual({
        denied: true,
        writes: 0,
        peopleCalls: 0,
      });
    },
  );
});

describe('deny by default at start-up', () => {
  /** Builds an e-signature app before `ready`, lets `declare` add a route and awaits `ready`; the app is always closed. */
  async function startWith(declare: (app: FastifyInstance) => unknown): Promise<void> {
    const built = await buildTestApp({ ready: false });
    try {
      declare(built.app);
      await built.app.ready();
    } finally {
      await built.app.close().catch(() => undefined);
    }
  }

  it.each<[string, (app: FastifyInstance) => unknown]>([
    ['no config.opt2', (app) => app.get('/opt2/esignature/undeclared', async () => 'x')],
    [
      'an empty requires list',
      (app) => app.get('/opt2/esignature/undeclared', { config: { opt2: { transport: 'service', requires: [] } } }, async () => 'x'),
    ],
  ])('fails start-up for a route with %s', async (_label, declare) => {
    await expect(startWith(declare)).rejects.toBeInstanceOf(UndeclaredRouteError);
  });
});
