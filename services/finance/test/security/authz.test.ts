// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Authorisation matrix of every finance route, its expected admissions derived from the route declarations alone. */
import { readFile, readdir } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PUBSUB_INVOKER_ROLE,
  Roles,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  hasAnyRole,
  type RouteMatrixEntry,
} from '@opt2/platform/auth';
import type { Clock } from '@opt2/platform/service-kit';
import { ROLE_SET, TENANT_A, TENANT_B, pushKeyQuery, type RoleSubject } from '@opt2/platform/testing';
import { financeLifecycle, type FinanceAction, type FinanceState } from '../../src/domain/lifecycle.transitions.js';
import { ATTACHMENT_BUCKET, type FinanceAttachmentRow, type FinanceRecordRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { attachmentRow, programBindingRow, recordRow } from '../helpers/records.js';

const CONTRACT = new URL('../../contracts/openapi.yaml', import.meta.url);
const URL_BASE = 'http://finance.test';
const FIXTURE = '/legacy-fixtures/cfml/api.cfm/finance';
const FINANCE_PREFIXES: readonly string[] = [`${FIXTURE}/`, '/v1/finance/', '/v2/finance/'];
const FILE_ROUTE_PREFIX = `/opt2/files/${ATTACHMENT_BUCKET}/`;
const MIGRATION_PREFIX = '/internal/v1/migration/';
const TRANSPORT_NAMES: readonly string[] = ['service', 'pubsub-push', 'cloud-tasks'];
const HTTP_METHODS: readonly string[] = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

const PREPARER = Roles.financePreparer;
const APPROVER = Roles.financeApprover;
const FINANCE_ROLES: readonly string[] = financeLifecycle.roles;

const PDF = 'application/pdf';
const FILE_BYTES = Buffer.from('%PDF-1.4 finance authz probe\n');
const OTHER_BYTES = Buffer.from('%PDF-1.4 finance authz foreign object\n');
const RECORD_FIELDS: Readonly<Record<string, string>> = { title: 'Authz probe', amount: '125.0000', period: '2026-06' };
const BOUNDARY = 'opt2financeauthz';
const MULTIPART = Buffer.from(
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="probe.pdf"\r\nContent-Type: ${PDF}\r\n\r\n` +
    `${FILE_BYTES.toString('latin1')}\r\n--${BOUNDARY}--\r\n`,
  'latin1',
);
/** Lifetime of a local signed URL. */
const SIGNED_URL_TTL_MS = 900_000;

/** The running export job reporting confirms to finance's export read. */
const EXPORT_SCOPE: Readonly<Record<string, string>> = { exportId: 'E0A1B2C3-0000-4000-8000000000000001', siteId: TENANT_A.siteId, claim: '2' };

/** Query a handler authorises on after the hook: the export read serves only a job reporting confirms. */
const HANDLER_QUERIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'GET /internal/v1/finance/records': { ...EXPORT_SCOPE, page: '1', pageSize: '50' },
};

const READERS: readonly string[] = [PREPARER, APPROVER];
const WRITERS: readonly string[] = [PREPARER];

/** finance.cfc `requireAny` of each non-transition finance route: readRoles, or writeRoles for record and attachment creation. */
const ORACLE: Readonly<Record<string, readonly string[]>> = {
  [`GET ${FIXTURE}/records`]: READERS,
  [`POST ${FIXTURE}/records`]: WRITERS,
  [`GET ${FIXTURE}/records/:id`]: READERS,
  [`GET ${FIXTURE}/records/:id/versions`]: READERS,
  [`GET ${FIXTURE}/records/:id/attachments`]: READERS,
  [`POST ${FIXTURE}/records/:id/attachments`]: WRITERS,
  [`GET ${FIXTURE}/records/:id/attachments/:aid`]: READERS,
  [`GET ${FIXTURE}/rollups`]: READERS,
  'GET /v1/finance/records': READERS,
  'GET /v1/finance/records/:id': READERS,
  'GET /v1/finance/records/:id/versions': READERS,
  'GET /v1/finance/records/:id/attachments': READERS,
  'POST /v1/finance/records/:id/attachments': WRITERS,
  'GET /v1/finance/records/:id/attachments/:aid/download-url': READERS,
  'GET /v1/finance/rollups': READERS,
  // The /v2 paged reads serve the same operations as their /v1 counterparts, so they carry the same fixture role sets.
  'GET /v2/finance/records/:id': READERS,
  'GET /v2/finance/records/:id/versions': READERS,
  'GET /v2/finance/records/:id/attachments': READERS,
  'GET /v2/finance/rollups': READERS,
};

/** Lifecycle routes: finance.cfc admits readRoles, then usp_finance_transition decides the action by role. */
const TRANSITION_ROUTES: readonly string[] = [`POST ${FIXTURE}/records/:id/:action`, 'POST /v1/finance/records/:id/transitions/:action'];

type LifecycleRow = (typeof financeLifecycle.rows)[number];

/** Distinct states some lifecycle row starts from, in row order. */
const FROM_STATES: readonly FinanceState[] = [...new Set(financeLifecycle.rows.flatMap((row) => row.from))];

/** Roles the lifecycle lets take `action`. */
function actionRoles(action: FinanceAction): string[] {
  return [...new Set(financeLifecycle.rows.filter((row) => row.action === action).flatMap((row) => row.roles))];
}

/** The first lifecycle row `roles` may take, else the first a preparer may take. */
function rowFor(roles: readonly string[]): LifecycleRow {
  const row =
    financeLifecycle.rows.find((candidate) => hasAnyRole(roles, candidate.roles)) ??
    financeLifecycle.rows.find((candidate) => hasAnyRole(WRITERS, candidate.roles));
  if (row === undefined) throw new TypeError('the finance lifecycle has no preparer action');
  return row;
}

/** The first state `action` is legal from. */
function fromStateOf(action: FinanceAction): FinanceState {
  const [state] = financeLifecycle.rows.find((row) => row.action === action)?.from ?? [];
  if (state === undefined) throw new TypeError(`the finance lifecycle has no row for ${action}`);
  return state;
}

function keyOf(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

function isTransition(route: Pick<RouteMatrixEntry, 'url'>): boolean {
  return route.url.includes('/:action');
}

function isFinanceRoute(route: Pick<RouteMatrixEntry, 'url'>): boolean {
  return FINANCE_PREFIXES.some((prefix) => route.url.startsWith(prefix));
}

function isAllowed(status: number): boolean {
  return status !== 401 && status !== 403;
}

/** Routes the matrix probes without the body or query their handler validates, so an admitted request answers 400. */
const VALIDATION_PROBES: ReadonlySet<string> = new Set([
  'POST /internal/v1/events/finance.programs-sites.site.changed.v1',
  `POST ${MIGRATION_PREFIX}apply`,
  `POST ${MIGRATION_PREFIX}gate`,
  `POST ${MIGRATION_PREFIX}watermark`,
  `GET ${MIGRATION_PREFIX}changes`,
  `GET ${MIGRATION_PREFIX}export`,
  `GET ${MIGRATION_PREFIX}objects`,
]);

/** Status an admitted matrix request answers. */
function admittedStatus(route: Pick<RouteMatrixEntry, 'method' | 'url'>): number {
  return VALIDATION_PROBES.has(keyOf(route)) ? 400 : 200;
}

/** A finance app over the shared seed, with its stored attachment and the signed URLs of both stored objects. */
interface Harness {
  t: TestApp;
  /** Tenant-a record per lifecycle from-state. */
  records: ReadonlyMap<FinanceState, FinanceRecordRow>;
  /** The IN-PROGRESS record, holding `attachment`. */
  readRecord: FinanceRecordRow;
  attachment: FinanceAttachmentRow;
  /** Path and query of `attachment`'s signed URL. */
  fileUrl: string;
  /** Path and query of the second stored object's signed URL. */
  otherUrl: string;
}

async function signedPath(t: TestApp, row: FinanceAttachmentRow): Promise<string> {
  const { pathname, search } = new URL(await t.storage.signedUrl(ATTACHMENT_BUCKET, row.object_key), URL_BASE);
  return `${pathname}${search}`;
}

/** Builds a finance app seeded with both program bindings, a tenant-a record per from-state and two stored attachments. */
async function openApp(clock?: Clock): Promise<Harness> {
  const records = new Map(FROM_STATES.map((state) => [state, recordRow({ state, siteid: TENANT_A.siteId })] as const));
  const readRecord = records.get('IN-PROGRESS');
  if (readRecord === undefined) throw new TypeError('no lifecycle row starts from IN-PROGRESS');
  const main = attachmentRow(readRecord, { fileName: 'probe.pdf', contentType: PDF, bytes: FILE_BYTES });
  const other = attachmentRow(readRecord, { fileName: 'other.pdf', contentType: PDF, bytes: OTHER_BYTES });
  const t = await buildTestApp({
    ...(clock === undefined ? {} : { clock }),
    seed: {
      program_binding: [TENANT_A, TENANT_B].map((tenant) => programBindingRow(tenant.siteId)),
      record: [...records.values()],
      attachment: [main.row, other.row],
    },
  });
  try {
    for (const { row, bytes } of [main, other]) await t.storage.put(ATTACHMENT_BUCKET, row.object_key, bytes, { contentType: row.content_type });
    t.reporting.answer({ status: 200, body: { ...EXPORT_SCOPE, tenantId: TENANT_A.tenantId, source: 'finance.records', state: 'running' } });
    return { t, records, readRecord, attachment: main.row, fileUrl: await signedPath(t, main.row), otherUrl: await signedPath(t, other.row) };
  } catch (err) {
    await t.app.close();
    throw err;
  }
}

/** Runs `use` on a fresh app and closes it. */
async function withApp<T>(use: (h: Harness) => Promise<T>, clock?: Clock): Promise<T> {
  const h = await openApp(clock);
  try {
    return await use(h);
  } finally {
    await h.t.app.close();
  }
}

type SubjectClass = 'anonymous' | 'user' | 'service' | 'push-invoker' | 'tasks-invoker';

function classOf(subject: RoleSubject): SubjectClass {
  if (subject.kind === 'anonymous') return 'anonymous';
  if (subject.kind === 'user') return 'user';
  if (subject.roles.includes(PUBSUB_INVOKER_ROLE)) return 'push-invoker';
  if (subject.roles.includes(TASKS_INVOKER_ROLE)) return 'tasks-invoker';
  return 'service';
}

/** A user whose token names a site other than tenant-a, the site under test. */
function isOtherTenant(subject: RoleSubject): boolean {
  return subject.kind === 'user' && (subject.crossTenant === true || (subject.siteOverride ?? TENANT_A.siteId) !== TENANT_A.siteId);
}

interface Credential {
  headers: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
}

const minted = new Map<string, { at: number; credential: Promise<Credential> }>();

// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `subject`'s local credential for finance: platform-minted tokens, or the push key for the push invoker. */
function credentialFor(subject: RoleSubject): Promise<Credential> {
  const cached = minted.get(subject.name);
  if (cached !== undefined && Date.now() - cached.at < CREDENTIAL_REUSE_MS) return cached.credential;
  const credential = mintCredential(subject);
  minted.set(subject.name, { at: Date.now(), credential });
  return credential;
}

async function mintCredential(subject: RoleSubject): Promise<Credential> {
  switch (classOf(subject)) {
    case 'anonymous':
      return { headers: {}, query: {} };
    case 'push-invoker':
      return { headers: {}, query: Object.fromEntries(new URLSearchParams(pushKeyQuery())) };
    default:
      return { headers: await headersFor(subject, { site: TENANT_A.siteId }), query: {} };
  }
}

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';
const METHODS: readonly Method[] = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

function methodOf(route: RouteMatrixEntry): Method {
  const method = METHODS.find((candidate) => candidate === route.method);
  if (method === undefined) throw new TypeError(`${keyOf(route)}: no request builder for this method`);
  return method;
}

interface InjectRequest {
  method: Method;
  url: string;
  headers: Record<string, string>;
  payload?: string | Buffer;
}

interface RequestOptions {
  /** Lifecycle action of a transition route; defaults to the first the subject's roles may take. */
  action?: FinanceAction;
  /** `siteid` query a user sends to a non-public service route; defaults to tenant-a, null sends none. */
  siteid?: string | null;
  /** `siteid` sent in the body, form-encoded or as JSON. */
  bodySiteId?: { siteid: string; form: boolean };
}

/** Value of path parameter `name` from the seed; an unseeded name fails, so a new route forces an update here. */
function paramValue(h: Harness, route: RouteMatrixEntry, name: string, action: FinanceAction): string {
  const key = h.attachment.object_key;
  switch (name) {
    case 'id': {
      const record = isTransition(route) ? h.records.get(fromStateOf(action)) : h.readRecord;
      if (record === undefined) throw new TypeError(`${keyOf(route)}: no record seeded in ${fromStateOf(action)}`);
      return record.record_id;
    }
    case 'action':
      return action;
    case 'aid':
      return h.attachment.attachment_id;
    case 'tenantId':
      return key.slice(0, key.indexOf('/'));
    case 'objectName':
      return key.slice(key.indexOf('/') + 1);
    default:
      throw new TypeError(`${keyOf(route)}: no seed value for path parameter :${name}`);
  }
}

/** Body of a write: valid record fields for create and edit, the upload's multipart file, else an empty JSON object. */
function bodyFor(route: RouteMatrixEntry, action: FinanceAction, site?: RequestOptions['bodySiteId']): { contentType: string; payload: string | Buffer } | undefined {
  if (route.method === 'GET' || route.method === 'HEAD') return undefined;
  if (route.url.endsWith('/attachments')) return { contentType: `multipart/form-data; boundary=${BOUNDARY}`, payload: MULTIPART };
  const recordFields = route.url === `${FIXTURE}/records` || (isTransition(route) && action === 'edit');
  const fields = { ...(recordFields ? RECORD_FIELDS : {}), ...(site === undefined ? {} : { siteid: site.siteid }) };
  if (isTransition(route) && Object.keys(fields).length === 0) return undefined;
  if (site?.form === true) return { contentType: 'application/x-www-form-urlencoded', payload: new URLSearchParams(fields).toString() };
  return { contentType: 'application/json', payload: JSON.stringify(fields) };
}

function withQuery(path: string, query: Readonly<Record<string, string>>): string {
  const url = new URL(path, URL_BASE);
  for (const [name, value] of Object.entries(query)) url.searchParams.append(name, value);
  return `${url.pathname}${url.search}`;
}

/** `app.inject` options sending `subject` to `route`, path parameters filled from the seed and the file route signed. */
async function requestFor(h: Harness, route: RouteMatrixEntry, subject: RoleSubject, options: RequestOptions = {}): Promise<InjectRequest> {
  const credential = await credentialFor(subject);
  const action = options.action ?? rowFor(subject.roles).action;
  const path = route.url.replace(/:(\w+)/g, (_match, name: string) => paramValue(h, route, name, action));
  const signed = route.url.startsWith(FILE_ROUTE_PREFIX) ? Object.fromEntries(new URL(h.fileUrl, URL_BASE).searchParams) : {};
  const query: Record<string, string> = { ...signed, ...HANDLER_QUERIES[keyOf(route)], ...credential.query };
  const siteid = options.siteid === undefined ? TENANT_A.siteId : options.siteid;
  if (siteid !== null && classOf(subject) === 'user' && route.transport === 'service' && route.public !== true) query.siteid = siteid;
  const headers: Record<string, string> = { ...credential.headers };
  const body = bodyFor(route, action, options.bodySiteId);
  if (body !== undefined) headers['content-type'] = body.contentType;
  return { method: methodOf(route), url: withQuery(path, query), headers, ...(body === undefined ? {} : { payload: body.payload }) };
}

/** Files under the app's local storage, across buckets. */
async function storedObjects(stateDir: string): Promise<number> {
  try {
    const entries = await readdir(`${stateDir}/storage`, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** What one request answered and did: its status and body, committed writes, objects stored and tenants its statements ran under. */
interface Outcome {
  status: number;
  body: Buffer;
  writes: number;
  objects: number;
  tenants: string[];
}

async function send(h: Harness, route: RouteMatrixEntry, subject: RoleSubject, options: RequestOptions = {}): Promise<Outcome> {
  const request = await requestFor(h, route, subject, options);
  h.t.db.clear();
  const before = await storedObjects(h.t.stateDir);
  const res = await h.t.app.inject(request);
  return {
    status: res.statusCode,
    body: res.rawPayload,
    writes: h.t.db.writes().length,
    objects: (await storedObjects(h.t.stateDir)) - before,
    tenants: [...new Set(h.t.db.queries().flatMap((query) => (query.tenantId === null ? [] : [query.tenantId])))],
  };
}

/** Whether an admitted request left its route's effects: none for a validation probe; rows, plus one object for an upload, for a finance write. */
function hasAdmittedEffects(route: RouteMatrixEntry, outcome: Outcome): boolean {
  if (VALIDATION_PROBES.has(keyOf(route))) return outcome.writes === 0 && outcome.objects === 0;
  if (route.method !== 'POST' || !isFinanceRoute(route)) return true;
  return outcome.writes > 0 && outcome.objects === (route.url.endsWith('/attachments') ? 1 : 0);
}

/** Whether `route`'s declaration admits `subject`, from its public flag, transport, `requires` and `siteCheck` alone. */
function expectAllowed(route: RouteMatrixEntry, subject: RoleSubject): boolean {
  const kind = classOf(subject);
  // A presented bearer token is always verified: the service scheme refuses the tasks-invoker token in Authorization even on a public route.
  if (route.public === true) return !(route.transport === 'service' && kind === 'tasks-invoker');
  const granted = hasAnyRole(subject.roles, route.requires ?? []);
  switch (route.transport) {
    case 'pubsub-push':
      return kind === 'push-invoker' && granted;
    case 'cloud-tasks':
      return kind === 'tasks-invoker' && granted;
    default:
      return (kind === 'user' || kind === 'service') && granted && !(isOtherTenant(subject) && route.siteCheck);
  }
}

/** `METHOD url` of each contract operation marked `x-opt2-public: true`, its path in Fastify form. */
function contractPublicOperations(contract: string): string[] {
  const found: string[] = [];
  let inPaths = false;
  let path: string | undefined;
  let method: string | undefined;
  for (const line of contract.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPaths = /^paths:\s*$/.test(line);
      path = undefined;
      method = undefined;
      continue;
    }
    if (!inPaths) continue;
    const pathKey = /^ {2}(['"]?)(\/.*?)\1:\s*$/.exec(line);
    if (pathKey !== null || /^ {2}\S/.test(line)) {
      path = pathKey?.[2];
      method = undefined;
      continue;
    }
    const methodKey = /^ {4}(\S+):/.exec(line);
    if (methodKey !== null) {
      method = HTTP_METHODS.find((candidate) => candidate === methodKey[1]);
      continue;
    }
    if (path !== undefined && method !== undefined && /^ {6,}x-opt2-public:\s*true\s*$/.test(line)) {
      found.push(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`);
    }
  }
  return found;
}

/** One matrix request: the route, the subject, the declared expectation and what the request did. */
interface Cell extends Outcome {
  route: RouteMatrixEntry;
  subject: RoleSubject;
  expected: boolean;
}

function cellName(cell: Cell): string {
  return `${keyOf(cell.route)} × ${cell.subject.name} (${cell.status})`;
}

let matrix: readonly RouteMatrixEntry[] = [];
const cells: Cell[] = [];

function routeByKey(key: string): RouteMatrixEntry {
  const route = matrix.find((candidate) => keyOf(candidate) === key);
  if (route === undefined) throw new TypeError(`the finance app registers no ${key}`);
  return route;
}

beforeAll(async () => {
  matrix = await withApp(async (h) => collectRouteMatrix(h.t.app).routes);
  for (const route of matrix) {
    await withApp(async (h) => {
      for (const subject of ROLE_SET) cells.push({ route, subject, expected: expectAllowed(route, subject), ...(await send(h, route, subject)) });
    });
  }
}, 180_000);


/** One oracle request: a finance route, a transition route's lifecycle action, the finance role sending it and whether the fixture grants it. */
interface OracleCell {
  key: string;
  label: string;
  action?: FinanceAction;
  role: string;
  grant: boolean;
}

const ORACLE_CELLS: readonly OracleCell[] = [
  ...Object.entries(ORACLE).flatMap(([key, granted]) => FINANCE_ROLES.map((role) => ({ key, label: key, role, grant: granted.includes(role) }))),
  ...TRANSITION_ROUTES.flatMap((key) =>
    financeLifecycle.actions.flatMap((action) =>
      FINANCE_ROLES.map((role) => ({ key, label: `${key} ${action}`, action, role, grant: actionRoles(action).includes(role) })),
    ),
  ),
];

/** Tenant-a users holding a finance lifecycle role. */
function financeSubjects(): RoleSubject[] {
  return ROLE_SET.filter((subject) => subject.kind === 'user' && !isOtherTenant(subject) && hasAnyRole(subject.roles, FINANCE_ROLES));
}

function financeSubject(role: string): RoleSubject {
  const subject = financeSubjects().find((candidate) => candidate.roles.includes(role));
  if (subject === undefined) throw new TypeError(`ROLE_SET has no tenant-a user holding ${role}`);
  return subject;
}

/** Sends every finance-role subject to every finance route `select` keeps and its roles admit, once per `variantsOf` option set; lists each not answered 403 without a write. */
async function siteMismatches(
  select: (route: RouteMatrixEntry) => boolean,
  variantsOf: (route: RouteMatrixEntry) => readonly RequestOptions[],
): Promise<{ sent: number; offending: string[] }> {
  const routes = matrix.filter((route) => isFinanceRoute(route) && select(route));
  return withApp(async (h) => {
    let sent = 0;
    const offending: string[] = [];
    for (const subject of financeSubjects()) {
      for (const route of routes.filter((candidate) => hasAnyRole(subject.roles, candidate.requires ?? []))) {
        for (const options of variantsOf(route)) {
          const outcome = await send(h, route, subject, options);
          sent += 1;
          if (outcome.status !== 403 || outcome.writes !== 0 || outcome.objects !== 0) {
            const form = options.bodySiteId?.form === true ? ' (form)' : '';
            offending.push(`${keyOf(route)} × ${subject.name}${form} (${outcome.status}): ${outcome.writes} writes, ${outcome.objects} objects`);
          }
        }
      }
    }
    return { sent, offending };
  });
}

describe('route declarations', () => {
  it('declares requires or public, and a transport, on every route', () => {
    expect(matrix.length).toBeGreaterThan(0);
    const problems = matrix.flatMap((route) => {
      const requires = route.requires !== undefined && route.requires.length > 0;
      const isPublic = route.public === true;
      return [
        ...(requires === isPublic || (route.requires !== undefined && !requires) ? [`${keyOf(route)}: requires ${JSON.stringify(route.requires)}, public ${String(isPublic)}`] : []),
        ...(TRANSPORT_NAMES.includes(route.transport) ? [] : [`${keyOf(route)}: transport ${route.transport}`]),
      ];
    });
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('exposes only the public routes the contract declares', async () => {
    const declared = contractPublicOperations(await readFile(CONTRACT, 'utf8'));
    expect(declared.length).toBeGreaterThan(0);
    const declaresHead = declared.some((key) => key.startsWith('HEAD '));
    const exposed = matrix.filter((route) => route.public === true && (route.method !== 'HEAD' || declaresHead)).map(keyOf);
    expect([...exposed].sort()).toEqual([...declared].sort());
  });
});

describe('authorisation matrix', () => {
  it('runs every route for every ROLE_SET subject', () => {
    expect(cells.length).toBe(matrix.length * ROLE_SET.length);
  });

  it('allows no subject a route does not declare for it', () => {
    const offending = cells.filter((cell) => !cell.expected && isAllowed(cell.status)).map(cellName);
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('admits every subject a route declares for it', () => {
    expect([...VALIDATION_PROBES].filter((key) => !cells.some((cell) => cell.expected && keyOf(cell.route) === key))).toEqual([]);
    const offending = cells
      .filter((cell) => cell.expected && cell.status !== admittedStatus(cell.route))
      .map((cell) => `${cellName(cell)}: expected ${admittedStatus(cell.route)}`);
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('leaves the writes and objects of each admitted request', () => {
    const probed = cells.filter((cell) => cell.expected && cell.status === admittedStatus(cell.route));
    expect(probed.some((cell) => cell.route.method === 'POST' && isFinanceRoute(cell.route))).toBe(true);
    const offending = probed
      .filter((cell) => !hasAdmittedEffects(cell.route, cell))
      .map((cell) => `${cellName(cell)}: ${cell.writes} writes, ${cell.objects} objects`);
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('denies without touching the database or storage', () => {
    const offending = cells
      .filter((cell) => !isAllowed(cell.status) && (cell.writes !== 0 || cell.objects !== 0))
      .map((cell) => `${cellName(cell)}: ${cell.writes} writes, ${cell.objects} objects`);
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('answers 403 to other-tenant tokens on every non-public service route', () => {
    const probed = cells.filter((cell) => isOtherTenant(cell.subject) && cell.route.transport === 'service' && cell.route.public !== true);
    expect(probed.length).toBeGreaterThan(0);
    const offending = probed.filter((cell) => cell.status !== 403).map(cellName);
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('refuses every user subject on push and migration routes', () => {
    const probed = cells.filter(
      (cell) =>
        (cell.route.transport === 'pubsub-push' || cell.route.url.startsWith(MIGRATION_PREFIX)) &&
        (classOf(cell.subject) === 'anonymous' || classOf(cell.subject) === 'user'),
    );
    expect(probed.length).toBeGreaterThan(0);
    const offending = probed.filter((cell) => isAllowed(cell.status) || cell.writes !== 0 || cell.objects !== 0).map(cellName);
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('refuses managed-delivery credentials on user routes', () => {
    const probed = cells.filter(
      (cell) =>
        cell.route.transport === 'service' &&
        cell.route.public !== true &&
        (classOf(cell.subject) === 'push-invoker' || classOf(cell.subject) === 'tasks-invoker'),
    );
    expect(probed.length).toBeGreaterThan(0);
    const offending = probed.filter((cell) => isAllowed(cell.status) || cell.writes !== 0 || cell.objects !== 0).map(cellName);
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('runs allowed requests in the token tenant only', () => {
    const probed = cells.filter(
      (cell) => cell.expected && cell.status === admittedStatus(cell.route) && cell.subject.kind === 'user' && !isOtherTenant(cell.subject),
    );
    expect(probed.some((cell) => cell.tenants.includes(TENANT_A.tenantId))).toBe(true);
    const offending = probed
      .filter((cell) => cell.tenants.some((tenant) => tenant !== TENANT_A.tenantId))
      .map((cell) => `${cellName(cell)}: ${cell.tenants.join(', ')}`);
    expect(offending, offending.join('\n')).toEqual([]);
  });
});

describe('fixture role sets', () => {
  it('declares each finance route with exactly its fixture role set', () => {
    const finance = matrix.filter(isFinanceRoute);
    const keys = finance.map(keyOf);
    const transitions = finance.filter(isTransition).map(keyOf);
    expect({
      unmapped: keys.filter((key) => !Object.hasOwn(ORACLE, key) && !transitions.includes(key)),
      stale: Object.keys(ORACLE).filter((key) => !keys.includes(key)),
      transitions: [...transitions].sort(),
    }).toEqual({ unmapped: [], stale: [], transitions: [...TRANSITION_ROUTES].sort() });

    // Fixture and lifecycle routes admit exactly the legacy role set; /v1 and /v2 reads may add OPT-2 roles such as the exporter.
    const exact = (route: RouteMatrixEntry): boolean => route.url.startsWith(`${FIXTURE}/`) || isTransition(route);
    const lifecycleRoles = [...new Set(financeLifecycle.actions.flatMap(actionRoles))].sort();
    const declared = finance.map((route) => [
      keyOf(route),
      (route.requires ?? []).filter((role) => exact(route) || FINANCE_ROLES.includes(role)).sort(),
    ]);
    const oracle = finance.map((route) => [keyOf(route), isTransition(route) ? lifecycleRoles : [...(ORACLE[keyOf(route)] ?? [])].sort()]);
    expect(Object.fromEntries(declared)).toEqual(Object.fromEntries(oracle));

    // usp_finance_transition grants submit, resubmit and edit to the preparer, approve and reject to the approver.
    const actionsOf = (role: string): string[] => financeLifecycle.actions.filter((action) => actionRoles(action).includes(role)).sort();
    expect({ [PREPARER]: actionsOf(PREPARER), [APPROVER]: actionsOf(APPROVER) }).toEqual({
      [PREPARER]: ['edit', 'resubmit', 'submit'],
      [APPROVER]: ['approve', 'reject'],
    });
  });

  it.each(ORACLE_CELLS)(
    'grants finance.preparer and finance.approver exactly the fixture role sets: $label as $role',
    async ({ key, action, role, grant }) => {
      const route = routeByKey(key);
      const outcome = await withApp((h) => send(h, route, financeSubject(role), action === undefined ? {} : { action }));
      if (grant) {
        const detail = `${outcome.status}: ${outcome.writes} writes, ${outcome.objects} objects ${outcome.body.toString('utf8').slice(0, 200)}`;
        expect(outcome.status, detail).toBe(admittedStatus(route));
        expect(hasAdmittedEffects(route, outcome), detail).toBe(true);
      } else {
        expect({ status: outcome.status, writes: outcome.writes, objects: outcome.objects }).toEqual({ status: 403, writes: 0, objects: 0 });
      }
    },
  );
});

describe('site boundary', () => {
  it('answers 403 when siteid in the query differs from the token site', async () => {
    expect(matrix.filter((route) => isFinanceRoute(route) && !route.siteCheck).map(keyOf)).toEqual([]);
    const { sent, offending } = await siteMismatches(
      () => true,
      () => [{ siteid: TENANT_B.siteId }],
    );
    expect(sent).toBeGreaterThan(0);
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('answers 403 when siteid in the body differs from the token site', async () => {
    const { sent, offending } = await siteMismatches(
      (route) => route.method === 'POST' && !route.url.endsWith('/attachments'),
      // Fixture writes read form or JSON fields, as legacy merges them; the /v1 transition reads JSON only.
      (route) => (route.url.startsWith(`${FIXTURE}/`) ? [false, true] : [false]).map((form) => ({ siteid: null, bodySiteId: { siteid: TENANT_B.siteId, form } })),
    );
    expect(sent).toBeGreaterThan(0);
    expect(offending, offending.join('\n')).toEqual([]);
  });
});

describe('signed attachment URLs', () => {
  it('serves an attachment only for a valid signature', async () => {
    const res = await withApp((h) => h.t.app.inject({ method: 'GET', url: h.fileUrl }));
    expect({ status: res.statusCode, contentType: res.headers['content-type'], served: res.rawPayload.equals(FILE_BYTES) }).toEqual({
      status: 200,
      contentType: PDF,
      served: true,
    });
  });

  it('rejects a missing, tampered or foreign signature', async () => {
    const answers = await withApp(async (h) => {
      const signed = new URL(h.fileUrl, URL_BASE);
      const edited = (edit: (params: URLSearchParams) => void): string => {
        const copy = new URL(signed);
        edit(copy.searchParams);
        return `${copy.pathname}${copy.search}`;
      };
      const flip = (hex: string): string => `${hex.startsWith('0') ? '1' : '0'}${hex.slice(1)}`;
      const urls: Record<string, string> = {
        'no expires or sig': signed.pathname,
        'a flipped sig character': edited((params) => params.set('sig', flip(params.get('sig') ?? ''))),
        'a changed expires': edited((params) => params.set('expires', String(Number(params.get('expires')) + 1))),
        "another object's signature": `${signed.pathname}${new URL(h.otherUrl, URL_BASE).search}`,
      };
      const out: Record<string, { status: number; served: boolean }> = {};
      for (const [label, url] of Object.entries(urls)) {
        const res = await h.t.app.inject({ method: 'GET', url });
        out[label] = { status: res.statusCode, served: res.rawPayload.equals(FILE_BYTES) };
      }
      return out;
    });

    let offsetMs = 0;
    const clock: Clock = { now: () => new Date(TEST_CLOCK.now().getTime() + offsetMs) };
    answers['an expired signature'] = await withApp(async (h) => {
      offsetMs = SIGNED_URL_TTL_MS + 1_000;
      const res = await h.t.app.inject({ method: 'GET', url: h.fileUrl });
      return { status: res.statusCode, served: res.rawPayload.equals(FILE_BYTES) };
    }, clock);

    expect(answers).toEqual(Object.fromEntries(Object.keys(answers).map((label) => [label, { status: 403, served: false }])));
    expect(Object.keys(answers)).toHaveLength(5);
  });
});

describe('deny by default', () => {
  it('fails start-up for a route that declares neither requires nor public', async () => {
    const built = await buildTestApp({ ready: false });
    try {
      await expect(
        (async () => {
          built.app.get('/opt2/test/undeclared', async () => ({}));
          await built.app.ready();
        })(),
      ).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await built.app.close().catch(() => undefined);
    }
  });
});
