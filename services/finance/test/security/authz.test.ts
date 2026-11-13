// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** In-process authorisation matrix of every finance route: admitted subjects, denial envelopes and effects, CSRF, site, tenant and transport boundaries, deny by default. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  type Opt2RouteConfig,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, type EventEnvelope } from '@opt2/platform/events';
import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN, LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import type { CsrfConsumeRequest } from '@opt2/platform/service-kit';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TEST_PUSH_KEY,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushKeyQuery,
  pushTo,
  registryPayloads,
  testEnvelope,
  type InjectResponse,
  type RoleSubject,
  type TenantFixture,
} from '@opt2/platform/testing';
import type { FinanceAction, FinanceState } from '../../src/domain/lifecycle.transitions.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/envelope.js';
import { ATTACHMENT_BUCKET, attachmentObjectKey } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { CSRF_HEADERS, TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

const SERVICE = 'finance';
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;

// Subject names of ROLE_SET, written out so every expectation below is literal.
const SYNTHETIC = [
  'timesheets.employee',
  'timesheets.primary-approver',
  'timesheets.secondary-approver',
  'finance.preparer',
  'finance.approver',
  'esignature.signer',
  'esignature.auditor',
  'reporting.exporter',
  'surveys.manager',
  'communications.sender',
] as const;

/** User subjects whose token names tenant-a, the site under test. */
const SITE_USERS = ['member', 'system-user', 'editor', 'site-admin', 's2', ...SYNTHETIC] as const;

const WORKLOADS = [
  'service:identity',
  'service:people',
  'service:programs-sites',
  'service:strategies-content',
  'service:communications',
  'service:reporting',
  'service:surveys',
  'service:timesheets',
  'service:finance',
  'service:e-signature',
  'service:stub',
  'service:gateway',
  'service:web',
  'service:migration',
  'service:operator',
  'service:pubsub-invoker',
  'service:tasks-invoker',
] as const;

const EVERYONE: readonly string[] = ['anonymous', ...SITE_USERS, 'other-tenant', ...WORKLOADS];

const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;

/** EVERYONE without `excluded`. */
function everyoneBut(...excluded: string[]): string[] {
  return EVERYONE.filter((name) => !excluded.includes(name));
}

/** Subjects presenting no user token: a user-role `requires` answers them 401. */
const NO_USER: readonly string[] = ['anonymous', ...WORKLOADS];

/** Subjects presenting no invocation credential on the service transport. */
const NO_INVOCATION: readonly string[] = ['anonymous', PUBSUB_INVOKER_ROLE, TASKS_INVOKER_ROLE];

const PREPARER = 'finance.preparer';
const APPROVER = 'finance.approver';
const EXPORTER = 'reporting.exporter';
const READ_ALLOW = [PREPARER, APPROVER] as const;

/** One concrete request; each subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  payload?: string | Buffer | Record<string, unknown>;
  headers?: Record<string, string>;
}

interface Declared {
  transport: Transport;
  requires?: readonly string[];
  public?: true;
}

interface Probe {
  title: string;
  /** Builds the request once per subject, so every lifecycle probe acts on a record of its own. */
  request: () => ProbeRequest;
  /** Subjects admitted: any status but 401, 403, 404 and 5xx. */
  allow: readonly string[];
  /** Denied subjects answered 401; every other denial is 403. */
  deny401: readonly string[];
  /** Subjects the lifecycle refuses after admission, once the token is consumed and the record read, as finance.cfc does. */
  lifecycleDenied?: readonly string[];
  /** Sends the probe as `subject` instead of injecting `request` with its credentials. */
  send?: (subject: RoleSubject, credentials: Record<string, string>) => Promise<InjectResponse>;
}

interface Expected {
  declared: Declared;
  probes: readonly Probe[];
}

const V1 = '/v1/finance';
const V2 = '/v2/finance';
const FX = FIXTURE_PREFIX;
const PUSH_URL = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const OBJECTS_URL = '/internal/v1/migration/objects';
const EXPORT_RECORDS_URL = '/internal/v1/finance/records';
/** The running export job reporting confirms to the records read the matrix probes. */
const EXPORT_ID = 'E0A1B2C3-0000-4000-8000000000000001';
const EXPORT_CLAIM = '2';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const NEW_RECORD = { title: 'Authz probe', amount: '12.5', period: '2026-06' } as const;
const EDIT_BODY = { title: 'Authz probe, edited', amount: '99.5', period: '2026-06' } as const;
const SEED_USER = 'F1A2B3C4-0000-4000-8000000000000001';
/** A well-formed record id no tenant holds. */
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const BOUNDARY = 'opt2financeauthz';
const FILE_BYTES = Buffer.from('%PDF-1.4 finance authz probe\n');
const MULTIPART = Buffer.from(
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="probe.pdf"\r\nContent-Type: application/pdf\r\n\r\n` +
    `${FILE_BYTES.toString('latin1')}\r\n--${BOUNDARY}--\r\n`,
  'latin1',
);
const UPLOAD_HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } as const;

const READERS: Declared = { transport: 'service', requires: [PREPARER, APPROVER] };
const PREPARERS: Declared = { transport: 'service', requires: [PREPARER] };
const LIST_READERS: Declared = { transport: 'service', requires: [PREPARER, APPROVER, EXPORTER] };
const MIGRATION: Declared = { transport: 'service', requires: ['platform.migration'] };
const REPORTING_RUN: Declared = { transport: 'service', requires: ['service:reporting'] };
const PUBLIC: Declared = { transport: 'service', public: true };
const PUSH: Declared = { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] };

let t: TestApp;
let matrix: RouteMatrix;
/** Tenant-a record every read probe addresses, holding the attachment uploaded in `beforeAll`. */
let readRecord: string;
let attachmentId: string;
/** Path and query of the local signed URL of that attachment. */
let fileUrl: string;

/** The tenant's program, from the recording db's default bindings. */
function programOf(tenant: TenantFixture): number {
  const [binding] = t.db.rows('program_binding', tenant.tenantId);
  if (binding === undefined) throw new TypeError(`no program binding for ${tenant.siteId}`);
  return binding.legacy_program_id;
}

/** Seeds a committed version-1 record of `tenant` in `state`; returns its id. */
function seedRecord(state: FinanceState, tenant: TenantFixture = TENANT_A): string {
  const id = cfUuid();
  t.db.seed('record', [
    {
      tenant_id: tenant.tenantId,
      record_id: id,
      siteid: tenant.siteId,
      title: 'Authz probe',
      amount: '125.0000',
      period: '2026-06',
      state,
      version: 1,
      created: TEST_CLOCK.now(),
      createdbyid: SEED_USER,
      legacy_program_id: programOf(tenant),
    },
  ]);
  return id;
}

/** The stored state and version of tenant-a record `id`. */
function storedRecord(id: string, tenant: TenantFixture = TENANT_A): { state: string; version: number } | undefined {
  const row = t.db.rows('record', tenant.tenantId).find((candidate) => candidate.record_id === id);
  return row === undefined ? undefined : { state: row.state, version: row.version };
}

function get(url: string): ProbeRequest {
  return { method: 'GET', url };
}

function upload(url: string): ProbeRequest {
  return { method: 'POST', url, headers: UPLOAD_HEADERS, payload: MULTIPART };
}

function probe(title: string, request: () => ProbeRequest, allow: readonly string[], deny401: readonly string[], extra: Partial<Probe> = {}): Probe {
  return { title, request, allow, deny401, ...extra };
}

/** A route of user roles, probed once: admitted for `allow`, 401 for subjects without a user token. */
function userRoute(declared: Declared, allow: readonly string[], title: string, request: () => ProbeRequest): Expected {
  return { declared, probes: [probe(title, request, allow, NO_USER)] };
}

/** A migration-kit route, for the migration workload alone. */
function migrationRoute(request: ProbeRequest): Expected {
  return { declared: MIGRATION, probes: [probe(`${request.method} ${request.url}`, () => request, ['service:migration'], NO_INVOCATION)] };
}

/** The migration read of attachment `id`'s stored bytes under tenant `tenantId`. */
function objectRead(tenantId: string, id: string): ProbeRequest {
  return get(`${OBJECTS_URL}?tenantId=${tenantId}&attachmentId=${id}`);
}

/** Every legal finance action and state it applies from, with the one role the lifecycle lets take it. */
const ACTIONS: readonly { action: FinanceAction; from: FinanceState; role: typeof PREPARER | typeof APPROVER }[] = [
  { action: 'submit', from: 'IN-PROGRESS', role: PREPARER },
  { action: 'approve', from: 'SUBMITTED', role: APPROVER },
  { action: 'approve', from: 'RE-SUBMITTED', role: APPROVER },
  { action: 'reject', from: 'SUBMITTED', role: APPROVER },
  { action: 'reject', from: 'RE-SUBMITTED', role: APPROVER },
  { action: 'resubmit', from: 'REJECTED', role: PREPARER },
  { action: 'edit', from: 'IN-PROGRESS', role: PREPARER },
  { action: 'edit', from: 'REJECTED', role: PREPARER },
];

/** One probe per action on a fresh record: the route admits both finance roles, the lifecycle only the action's. */
function lifecycleRoute(url: (id: string, action: FinanceAction) => string): Expected {
  return {
    declared: READERS,
    probes: ACTIONS.map(({ action, from, role }) =>
      probe(
        `${action} from ${from}`,
        () => ({
          method: 'POST',
          url: url(seedRecord(from), action),
          ...(action === 'edit' ? { headers: JSON_HEADERS, payload: { ...EDIT_BODY } } : {}),
        }),
        [role],
        NO_USER,
        { lifecycleDenied: [role === PREPARER ? APPROVER : PREPARER] },
      ),
    ),
  };
}

/** A contract-valid `programs-sites.site.changed.v1` envelope of tenant-a. */
function siteChangedEnvelope(): EventEnvelope {
  const payload = registryPayloads().find((candidate) => candidate.siteId === SITE_A);
  if (payload === undefined) throw new TypeError(`registryPayloads has no ${SITE_A} payload`);
  return testEnvelope({ topic: 'programs-sites.site.changed.v1', tenantId: TENANT_A.tenantId, aggregateId: SITE_A, payload });
}

/** The site.changed push as Pub/Sub sends it, without the push key in the URL. */
function pushWithoutKey(): ProbeRequest {
  const body = buildPushBody({ data: encodeEnvelope(siteChangedEnvelope()), messageId: randomUUID(), subscription: SITE_CHANGED_SUBSCRIPTION });
  return { method: 'POST', url: PUSH_URL, headers: JSON_HEADERS, payload: { ...body } };
}

/** `request` with the local push key, or `key`, added to its query. */
function withPushKey(request: ProbeRequest, key: string = TEST_PUSH_KEY): ProbeRequest {
  return { ...request, url: `${request.url}${request.url.includes('?') ? '&' : '?'}${pushKeyQuery(key)}` };
}

/** Delivers the site.changed push as `subject`: the invoker through the local push key, everyone else with only its own credentials. */
function sendPush(subject: RoleSubject, credentials: Record<string, string>): Promise<InjectResponse> {
  if (subject.name === PUBSUB_INVOKER_ROLE) return pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope());
  return inject(pushWithoutKey(), credentials);
}

/** Every registered route, keyed `<METHOD> <fastify url>`, with its declaration and tenant-a probes. */
const EXPECTED: Readonly<Record<string, Expected>> = {
  'GET /healthz': {
    declared: PUBLIC,
    // A tasks-invoker token in Authorization is verified, and refused, as a user token on the public service route.
    probes: [probe('GET /healthz', () => get('/healthz'), everyoneBut(TASKS_INVOKER_ROLE), [TASKS_INVOKER_ROLE])],
  },
  [`POST ${PUSH_URL}`]: {
    declared: PUSH,
    probes: [probe('site.changed push', pushWithoutKey, [PUBSUB_INVOKER_ROLE], everyoneBut(PUBSUB_INVOKER_ROLE), { send: sendPush })],
  },
  'POST /internal/v1/migration/apply': migrationRoute({ method: 'POST', url: '/internal/v1/migration/apply', headers: JSON_HEADERS, payload: {} }),
  'GET /internal/v1/migration/changes': migrationRoute(get(`/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`)),
  'GET /internal/v1/migration/export': migrationRoute(get(`/internal/v1/migration/export?unit=finance.record&tenantId=${TENANT_A.tenantId}`)),
  'POST /internal/v1/migration/gate': migrationRoute({ method: 'POST', url: '/internal/v1/migration/gate', headers: JSON_HEADERS, payload: {} }),
  // The reverse projector's read of an attachment's bytes, probed on the tenant-a attachment uploaded in `beforeAll`.
  [`GET ${OBJECTS_URL}`]: {
    declared: MIGRATION,
    probes: [probe('attachment object read', () => objectRead(TENANT_A.tenantId, attachmentId), ['service:migration'], NO_INVOCATION)],
  },
  'GET /internal/v1/migration/position': migrationRoute(get('/internal/v1/migration/position')),
  // Reporting's export runs act as System: the records read admits its workload credential alone, for the job reporting confirms.
  [`GET ${EXPORT_RECORDS_URL}`]: {
    declared: REPORTING_RUN,
    probes: [
      probe(
        'export records read',
        () => get(`${EXPORT_RECORDS_URL}?exportId=${EXPORT_ID}&siteId=${SITE_A}&claim=${EXPORT_CLAIM}&page=1&pageSize=50`),
        ['service:reporting'],
        NO_INVOCATION,
      ),
    ],
  },
  'GET /internal/v1/migration/watermark': migrationRoute(get('/internal/v1/migration/watermark')),
  'POST /internal/v1/migration/watermark': migrationRoute({ method: 'POST', url: '/internal/v1/migration/watermark', headers: JSON_HEADERS, payload: {} }),
  // finance.cfc gates reads and lifecycle actions with readRoles, record and attachment creation with writeRoles.
  [`GET ${FX}/records`]: userRoute(READERS, READ_ALLOW, 'fixture record list', () => get(`${FX}/records`)),
  [`POST ${FX}/records`]: userRoute(PREPARERS, [PREPARER], 'fixture record create', () => ({
    method: 'POST',
    url: `${FX}/records`,
    headers: JSON_HEADERS,
    payload: { ...NEW_RECORD },
  })),
  [`GET ${FX}/records/:id`]: userRoute(READERS, READ_ALLOW, 'fixture record read', () => get(`${FX}/records/${readRecord}`)),
  [`POST ${FX}/records/:id/:action`]: lifecycleRoute((id, action) => `${FX}/records/${id}/${action}`),
  [`GET ${FX}/records/:id/attachments`]: userRoute(READERS, READ_ALLOW, 'fixture attachment list', () => get(`${FX}/records/${readRecord}/attachments`)),
  [`POST ${FX}/records/:id/attachments`]: userRoute(PREPARERS, [PREPARER], 'fixture attachment upload', () =>
    upload(`${FX}/records/${readRecord}/attachments`),
  ),
  [`GET ${FX}/records/:id/attachments/:aid`]: userRoute(READERS, READ_ALLOW, 'fixture attachment download', () =>
    get(`${FX}/records/${readRecord}/attachments/${attachmentId}`),
  ),
  [`GET ${FX}/records/:id/versions`]: userRoute(READERS, READ_ALLOW, 'fixture version list', () => get(`${FX}/records/${readRecord}/versions`)),
  [`GET ${FX}/rollups`]: userRoute(READERS, READ_ALLOW, 'fixture rollups', () => get(`${FX}/rollups`)),
  // The signed URL is the credential; any other presented credential is still verified.
  [`GET /opt2/files/${ATTACHMENT_BUCKET}/:tenantId/:objectName`]: {
    declared: PUBLIC,
    probes: [probe('signed attachment URL', () => get(fileUrl), everyoneBut(TASKS_INVOKER_ROLE), [TASKS_INVOKER_ROLE])],
  },
  // The record list also admits the reporting exporter.
  [`GET ${V1}/records`]: userRoute(LIST_READERS, [...READ_ALLOW, EXPORTER], 'record list', () => get(`${V1}/records`)),
  [`GET ${V1}/records/:id`]: userRoute(READERS, READ_ALLOW, 'record detail', () => get(`${V1}/records/${readRecord}`)),
  [`GET ${V1}/records/:id/attachments`]: userRoute(READERS, READ_ALLOW, 'attachment list', () => get(`${V1}/records/${readRecord}/attachments`)),
  [`POST ${V1}/records/:id/attachments`]: userRoute(PREPARERS, [PREPARER], 'attachment upload', () => upload(`${V1}/records/${readRecord}/attachments`)),
  [`GET ${V1}/records/:id/attachments/:aid/download-url`]: userRoute(READERS, READ_ALLOW, 'attachment download URL', () =>
    get(`${V1}/records/${readRecord}/attachments/${attachmentId}/download-url`),
  ),
  [`POST ${V1}/records/:id/transitions/:action`]: lifecycleRoute((id, action) => `${V1}/records/${id}/transitions/${action}`),
  [`GET ${V1}/records/:id/versions`]: userRoute(READERS, READ_ALLOW, 'version list', () => get(`${V1}/records/${readRecord}/versions`)),
  [`GET ${V1}/rollups`]: userRoute(READERS, READ_ALLOW, 'rollups', () => get(`${V1}/rollups`)),
  [`GET ${V2}/records/:id`]: userRoute(READERS, READ_ALLOW, 'paged record detail', () => get(`${V2}/records/${readRecord}`)),
  [`GET ${V2}/records/:id/attachments`]: userRoute(READERS, READ_ALLOW, 'paged attachments', () => get(`${V2}/records/${readRecord}/attachments`)),
  [`GET ${V2}/records/:id/versions`]: userRoute(READERS, READ_ALLOW, 'paged versions', () => get(`${V2}/records/${readRecord}/versions`)),
  [`GET ${V2}/rollups`]: userRoute(READERS, READ_ALLOW, 'paged rollups', () => get(`${V2}/rollups`)),
};

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

const HTTP_METHODS: readonly string[] = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** `<METHOD> <url>` of a route. */
function keyOf(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

/** A declaration in comparable form: `requires` sorted, defaults dropped. */
function comparable(declared: Declared | RouteMatrixEntry): Record<string, unknown> {
  return {
    transport: declared.transport,
    ...(declared.requires === undefined ? {} : { requires: [...declared.requires].sort() }),
    ...(declared.public === true ? { public: true } : {}),
    ...('siteCheck' in declared && declared.siteCheck === false ? { siteCheck: false } : {}),
    ...('edge' in declared && declared.edge === true ? { edge: true } : {}),
  };
}

/** Each contract operation's `x-opt2-*` declaration, keyed like the route matrix. */
function contractDeclarations(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(OPENAPI.paths).flatMap(([template, item]) =>
      Object.entries(item)
        .filter(([method]) => HTTP_METHODS.includes(method))
        .map(([method, operation]) => {
          const op = operation as { 'x-opt2-transport': Transport; 'x-opt2-requires'?: string[]; 'x-opt2-public'?: boolean };
          const declared: Declared = {
            transport: op['x-opt2-transport'],
            ...(op['x-opt2-requires'] === undefined ? {} : { requires: op['x-opt2-requires'] }),
            ...(op['x-opt2-public'] === true ? { public: true as const } : {}),
          };
          return [`${method.toUpperCase()} ${template.replace(/\{(\w+)\}/g, ':$1')}`, comparable(declared)];
        }),
    ),
  );
}

/** Request effects since a {@link mark}. */
interface Effects {
  statements: readonly string[];
  writes: number;
  published: number;
  /** Identity CSRF consume calls. */
  consumed: number;
  /** Attachment objects added to storage. */
  objects: number;
}

interface Mark {
  consumed: number;
  objects: number;
}

/** Files under the local `finance-attachments` bucket. */
function storedObjects(): number {
  const dir = path.join(t.stateDir, 'storage', ATTACHMENT_BUCKET);
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Empties the db and publisher logs and snapshots the CSRF calls and stored objects. */
function mark(): Mark {
  t.db.clear();
  t.publisher.clear();
  return { consumed: t.csrf.calls.length, objects: storedObjects() };
}

function effectsSince(from: Mark): Effects {
  return {
    statements: t.db.queries().map((query) => query.sql),
    writes: t.db.writes().length,
    published: t.publisher.published.length + t.publisher.raw.length,
    consumed: t.csrf.calls.length - from.consumed,
    objects: storedObjects() - from.objects,
  };
}

/** Effects with the statements left out, for checks that admit a handler's reads. */
function sideEffects({ statements: _reads, ...effects }: Effects): Omit<Effects, 'statements'> {
  return effects;
}

const QUIET: Omit<Effects, 'statements'> = { writes: 0, published: 0, consumed: 0, objects: 0 };

/** The only statements a hook denial of a fixture route runs: auth.cfc resolveSite's registry lookup, in its own transaction. */
const FIXTURE_DENIAL_READ = /^(?:BEGIN|COMMIT|SELECT set_config\('app\.tenant_id', \$1, true\)|SELECT [\w, ]+ FROM finance\.tenant_registry WHERE [^;]+)$/;

interface ErrorBody {
  code: string;
  message: string;
}

function errorBody({ code, message }: ErrorBody): ErrorBody {
  return { code, message };
}

/** Error bodies a refusal may carry: the platform's legacy JSON API rows, or the fixture's own forbidden row. */
const DENIAL_ERRORS: Readonly<Record<401 | 403, readonly ErrorBody[]>> = {
  401: [LEGACY_ERROR_MAP.authorization, LEGACY_ERROR_MAP.invalidAccessToken, LEGACY_ERROR_MAP.accessTokenExpired].map(errorBody),
  403: [FIXTURE_ERROR_MAP.forbidden, LEGACY_ERROR_MAP.authorization].map(errorBody),
};

const FORBIDDEN = errorBody(LEGACY_ERROR_MAP.authorization);
const INVALID_TOKENS = errorBody(LEGACY_ERROR_MAP.invalidTokens);
const INVALID_PARAMETERS = errorBody(LEGACY_ERROR_MAP.invalidParameters);
/** The unmatched-route envelope, which a migration object read without an object answers. */
const NOT_FOUND = errorBody(LEGACY_ERROR_MAP.invalidMethodCall);

/** The `error` object of a legacy envelope response, or undefined when the body is not one. */
function errorOf(res: InjectResponse): ErrorBody | undefined {
  let body: unknown;
  try {
    body = JSON.parse(res.body) as unknown;
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as { error?: unknown };
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : undefined;
}

function inject(request: ProbeRequest, credentials: Record<string, string>): Promise<InjectResponse> {
  const { method, url, payload, headers } = request;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Record<string, string>> }>();

// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `headersFor(subject)` on tenant-a, CSRF headers included for users, reused across probes while its tokens are fresh. */
function credentialsOf(subject: RoleSubject): Promise<Record<string, string>> {
  const cached = credentialCache.get(subject.name);
  if (cached !== undefined && Date.now() - cached.mintedAt < CREDENTIAL_REUSE_MS) return cached.headers;
  const headers = headersFor(subject, { site: SITE_A });
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

/** Every way one probe sent as one subject departs from its expectation. */
async function mismatchesOf(key: string, item: Probe, subject: RoleSubject): Promise<string[]> {
  const credentials = await credentialsOf(subject);
  const request = item.request();
  const before = mark();
  const res = item.send === undefined ? await inject(request, credentials) : await item.send(subject, credentials);
  const effects = effectsSince(before);
  const at = `${key} ${item.title} as ${subject.name}`;
  if (res.statusCode === 404) return [`${at}: 404, so the probe missed its route: ${res.body.slice(0, 200)}`];
  const admitted = res.statusCode !== 401 && res.statusCode !== 403;
  const shouldAdmit = item.allow.includes(subject.name);
  if (admitted !== shouldAdmit) {
    return [`${at}: expected ${shouldAdmit ? 'admission' : 'denial'}, got ${res.statusCode} ${res.body.slice(0, 200)}`];
  }
  if (admitted) {
    if (res.statusCode >= 500) return [`${at}: admitted request failed with ${res.statusCode} ${res.body.slice(0, 200)}`];
    // Reads write nothing and, as in legacy, consume no CSRF token.
    if (request.method === 'GET' && (effects.writes !== 0 || effects.consumed !== 0)) {
      return [`${at}: admitted read left effects ${JSON.stringify(sideEffects(effects))}`];
    }
    return [];
  }

  const problems: string[] = [];
  const lifecycle = item.lifecycleDenied?.includes(subject.name) === true;
  const status = item.deny401.includes(subject.name) ? 401 : 403;
  if (res.statusCode !== status) problems.push(`${at}: expected ${status}, got ${res.statusCode} ${res.body.slice(0, 200)}`);
  const error = errorOf(res);
  if (error === undefined) {
    problems.push(`${at}: denial is not a legacy error envelope: ${res.body.slice(0, 200)}`);
  } else if (!DENIAL_ERRORS[res.statusCode as 401 | 403].some((allowed) => isDeepStrictEqual(allowed, error))) {
    problems.push(`${at}: unexpected denial error ${JSON.stringify(error)}`);
  }
  if (lifecycle) {
    // The lifecycle decides after the token is consumed and the record read under lock; it writes and stores nothing.
    if (!isDeepStrictEqual(sideEffects(effects), { ...QUIET, consumed: 1 })) {
      problems.push(`${at}: lifecycle denial left effects ${JSON.stringify(sideEffects(effects))}`);
    }
    return problems;
  }
  const reads = effects.statements.filter((sql) => !(key.includes(FX) && FIXTURE_DENIAL_READ.test(sql)));
  if (reads.length > 0 || !isDeepStrictEqual(sideEffects(effects), QUIET)) {
    problems.push(`${at}: denial left effects ${JSON.stringify({ ...sideEffects(effects), statements: reads })}`);
  }
  return problems;
}

/** Status, error body and effects of `request` sent with `credentials`. */
async function outcomeOf(
  request: ProbeRequest,
  credentials: Record<string, string>,
): Promise<{ status: number; error: ErrorBody | undefined; effects: Effects }> {
  const before = mark();
  const res = await inject(request, credentials);
  return { status: res.statusCode, error: errorOf(res), effects: effectsSince(before) };
}

/** The `sid` claim of the user token in `credentials`. */
function sessionOf(credentials: Record<string, string>): string {
  const [, payload = ''] = (credentials.authorization ?? '').replace(/^Bearer /, '').split('.');
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sid: string }).sid;
}

beforeAll(async () => {
  t = await buildTestApp();
  matrix = collectRouteMatrix(t.app);
  readRecord = seedRecord('IN-PROGRESS');
  const uploaded = await inject(upload(`${V1}/records/${readRecord}/attachments`), await headersFor(PREPARER, { site: SITE_A }));
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  attachmentId = (JSON.parse(uploaded.body) as { data: { attachment_id: string } }).data.attachment_id;
  const signed = await inject(get(`${V1}/records/${readRecord}/attachments/${attachmentId}/download-url`), await headersFor(APPROVER, { site: SITE_A }));
  expect(signed.statusCode, signed.body).toBe(200);
  const { pathname, search } = new URL((JSON.parse(signed.body) as { data: { url: string } }).data.url, 'http://finance.test');
  fileUrl = `${pathname}${search}`;
  t.reporting.answer({
    status: 200,
    body: { exportId: EXPORT_ID, tenantId: TENANT_A.tenantId, siteId: SITE_A, source: 'finance.records', state: 'running', claim: EXPORT_CLAIM },
  });
});

afterAll(async () => {
  await t?.app.close();
});

describe('route declarations', () => {
  it('lists every registered route exactly once in the expectations', () => {
    const registered = matrix.routes.map(keyOf);
    const expected = Object.keys(EXPECTED);
    expect({
      missing: registered.filter((key) => !expected.includes(key)),
      extra: expected.filter((key) => !registered.includes(key)),
      duplicated: registered.filter((key, index) => registered.indexOf(key) !== index),
    }).toEqual({ missing: [], extra: [], duplicated: [] });
  });

  it('declares each route with its expected transport, roles and public flag, site-checked', () => {
    const actual = Object.fromEntries(matrix.routes.map((route) => [keyOf(route), comparable(route)]));
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([key, entry]) => [key, comparable(entry.declared)]));
    expect(actual).toEqual(expected);
  });

  it('registers exactly the contract operations, each with its x-opt2 transport, roles and public flag', () => {
    const actual = Object.fromEntries(matrix.routes.map((route) => [keyOf(route), comparable(route)]));
    expect(actual).toEqual(contractDeclarations());
  });

  it('probes the full ROLE_SET subject set', () => {
    const names = ROLE_SET.map((subject) => subject.name);
    expect(names).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS]));
    expect([...names].sort()).toEqual([...EVERYONE].sort());
  });

  it('names only ROLE_SET subjects, and never one both admitted and denied', () => {
    const probes = Object.entries(EXPECTED).flatMap(([key, entry]) => entry.probes.map((item) => [key, item] as const));
    const named = probes.flatMap(([, item]) => [...item.allow, ...item.deny401, ...(item.lifecycleDenied ?? [])]);
    const overlapping = probes.flatMap(([key, item]) =>
      item.allow.filter((name) => item.deny401.includes(name) || item.lifecycleDenied?.includes(name)).map((name) => `${key} ${item.title}: ${name}`),
    );
    expect({ unknown: named.filter((name) => !EVERYONE.includes(name)), overlapping }).toEqual({ unknown: [], overlapping: [] });
  });
});

describe('route admission', () => {
  for (const [key, entry] of Object.entries(EXPECTED)) {
    it(`admits exactly the expected subjects on ${key}, and denials leave no effect`, { timeout: 120_000 }, async () => {
      const mismatches: string[] = [];
      for (const item of entry.probes) {
        for (const subject of ROLE_SET) mismatches.push(...(await mismatchesOf(key, item, subject)));
      }
      expect(mismatches).toEqual([]);
    });
  }
});

/** One CSRF-validated write: the subject it admits, its request on record `id`, and the context identity validates the token for. */
interface CsrfWrite {
  subject: string;
  /** State of the record the write acts on; undefined for the collection create. */
  state?: FinanceState;
  request: (id: string) => ProbeRequest;
  context: (id: string) => string;
}

// Each write sends the record id lower-cased: identity validates the token for the id as sent.
const CSRF_WRITES: Readonly<Record<string, CsrfWrite>> = {
  [`POST ${V1}/records/:id/transitions/:action`]: {
    subject: PREPARER,
    state: 'IN-PROGRESS',
    request: (id) => ({ method: 'POST', url: `${V1}/records/${id.toLowerCase()}/transitions/submit` }),
    context: (id) => id.toLowerCase(),
  },
  [`POST ${V1}/records/:id/attachments`]: {
    subject: PREPARER,
    state: 'IN-PROGRESS',
    request: (id) => upload(`${V1}/records/${id.toLowerCase()}/attachments`),
    context: (id) => id.toLowerCase(),
  },
  // api.cfm passes the collection's empty route id as the context.
  [`POST ${FX}/records`]: {
    subject: PREPARER,
    request: () => ({ method: 'POST', url: `${FX}/records`, headers: JSON_HEADERS, payload: { ...NEW_RECORD } }),
    context: () => '',
  },
  [`POST ${FX}/records/:id/:action`]: {
    subject: APPROVER,
    state: 'SUBMITTED',
    request: (id) => ({ method: 'POST', url: `${FX}/records/${id.toLowerCase()}/approve` }),
    context: (id) => id.toLowerCase(),
  },
  [`POST ${FX}/records/:id/attachments`]: {
    subject: PREPARER,
    state: 'IN-PROGRESS',
    request: (id) => upload(`${FX}/records/${id.toLowerCase()}/attachments`),
    context: (id) => id.toLowerCase(),
  },
};

/** A fresh record for `write`, or '' for the collection create. */
function csrfTarget(write: CsrfWrite): string {
  return write.state === undefined ? '' : seedRecord(write.state);
}

describe('CSRF on writes', () => {
  const writes = Object.entries(CSRF_WRITES);

  it('covers every user-facing write route the service registers', () => {
    const declaredWrites = Object.keys(EXPECTED).filter((key) => key.startsWith('POST ') && !key.includes('/internal/'));
    expect(Object.keys(CSRF_WRITES).sort()).toEqual(declaredWrites.sort());
  });

  it.each(writes)('refuses %s without a token, consuming and writing nothing', async (_key, write) => {
    const id = csrfTarget(write);
    const outcome = await outcomeOf(write.request(id), await headersFor(write.subject, { site: SITE_A, csrf: false }));
    expect({ status: outcome.status, error: outcome.error, effects: sideEffects(outcome.effects) }).toEqual({
      status: 400,
      error: INVALID_TOKENS,
      effects: QUIET,
    });
    if (id !== '') expect(storedRecord(id)).toEqual({ state: write.state, version: 1 });
  });

  it.each(writes)('refuses %s whose token identity rejects, writing nothing', async (_key, write) => {
    const id = csrfTarget(write);
    t.csrf.answer(false);
    try {
      const outcome = await outcomeOf(write.request(id), await headersFor(write.subject, { site: SITE_A }));
      expect({ status: outcome.status, error: outcome.error, effects: sideEffects(outcome.effects) }).toEqual({
        status: 400,
        error: INVALID_TOKENS,
        effects: { ...QUIET, consumed: 1 },
      });
    } finally {
      t.csrf.answer(true);
    }
    if (id !== '') expect(storedRecord(id)).toEqual({ state: write.state, version: 1 });
  });

  it.each(writes)('admits %s once for a valid token, then refuses its replay once identity holds it used', async (_key, write) => {
    const id = csrfTarget(write);
    const credentials = await headersFor(write.subject, { site: SITE_A });
    const request = write.request(id);
    const consume: CsrfConsumeRequest = {
      sessionId: sessionOf(credentials),
      token: CSRF_HEADERS[CSRF_HEADER_TOKEN] ?? '',
      expires: CSRF_HEADERS[CSRF_HEADER_EXPIRES] ?? '',
      context: write.context(id),
    };

    const first = mark();
    const accepted = await inject(request, credentials);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(t.csrf.calls.slice(first.consumed)).toEqual([consume]);
    expect(effectsSince(first).writes).toBeGreaterThan(0);
    const after = id === '' ? undefined : storedRecord(id);

    t.csrf.answer(false);
    try {
      const replay = mark();
      const refused = await inject(request, credentials);
      expect({ status: refused.statusCode, error: errorOf(refused), effects: sideEffects(effectsSince(replay)) }).toEqual({
        status: 400,
        error: INVALID_TOKENS,
        effects: { ...QUIET, consumed: 1 },
      });
      expect(t.csrf.calls.slice(replay.consumed)).toEqual([consume]);
    } finally {
      t.csrf.answer(true);
    }
    if (id !== '') expect(storedRecord(id)).toEqual(after);
  });
});

/** Routes a user token admits, each with its first probe and the first subject it admits. */
function userProbes(): [string, Probe, string][] {
  return Object.entries(EXPECTED).flatMap(([key, entry]): [string, Probe, string][] => {
    const [first] = entry.probes;
    const subject = first?.allow[0];
    const userRoles = entry.declared.requires?.some((role) => (SITE_USERS as readonly string[]).includes(role)) === true;
    return userRoles && first !== undefined && subject !== undefined ? [[key, first, subject]] : [];
  });
}

/** `request` with `siteid=<site>` added to its query under `name`. */
function withSiteId(request: ProbeRequest, site: string, name = 'siteid'): ProbeRequest {
  return { ...request, url: `${request.url}${request.url.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(site)}` };
}

describe('site boundary', () => {
  it.each(userProbes())('refuses a tenant-a token sent with siteid=tenant-b on %s before any read', async (_key, item, subject) => {
    const outcome = await outcomeOf(withSiteId(item.request(), SITE_B), await headersFor(subject, { site: SITE_A }));
    expect(outcome).toEqual({ status: 403, error: FORBIDDEN, effects: { ...QUIET, statements: [] } });
  });

  it.each(userProbes())('admits a tenant-a token sent with siteid=tenant-a on %s', async (_key, item, subject) => {
    const { status } = await outcomeOf(withSiteId(item.request(), SITE_A), await headersFor(subject, { site: SITE_A }));
    expect(status === 401 || status === 403 || status === 404 || status >= 500, String(status)).toBe(false);
  });

  it.each<[string, ProbeRequest]>([
    ['a mixed-case SiteID query', withSiteId({ method: 'POST', url: `${FX}/records`, headers: JSON_HEADERS, payload: { ...NEW_RECORD } }, SITE_B, 'SiteID')],
    ['a JSON body siteid', { method: 'POST', url: `${FX}/records`, headers: JSON_HEADERS, payload: { ...NEW_RECORD, siteid: SITE_B } }],
    [
      'a form body siteid',
      {
        method: 'POST',
        url: `${V1}/records/${UNKNOWN_ID}/transitions/submit`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `siteid=${SITE_B}`,
      },
    ],
  ])('refuses %s naming tenant-b on a write, consuming and writing nothing', async (_label, request) => {
    const outcome = await outcomeOf(request, await headersFor(PREPARER, { site: SITE_A }));
    expect({ status: outcome.status, error: outcome.error, effects: sideEffects(outcome.effects) }).toEqual({
      status: 403,
      error: FORBIDDEN,
      effects: QUIET,
    });
  });
});

describe('tenant boundary', () => {
  /** A tenant-b user holding both finance roles, its token naming site tenant-b. */
  const tenantB = (): Promise<Record<string, string>> => headersFor({ roles: ['system-user', PREPARER, APPROVER] }, { site: SITE_B });

  it('answers every tenant-a record and attachment read of a tenant-b finance user 404', async () => {
    const credentials = await tenantB();
    const reads = [
      `${V1}/records/${readRecord}`,
      `${V1}/records/${readRecord}/versions`,
      `${V1}/records/${readRecord}/attachments`,
      `${V1}/records/${readRecord}/attachments/${attachmentId}/download-url`,
      `${V2}/records/${readRecord}`,
      `${V2}/records/${readRecord}/versions`,
      `${V2}/records/${readRecord}/attachments`,
      `${FX}/records/${readRecord}`,
      `${FX}/records/${readRecord}/versions`,
      `${FX}/records/${readRecord}/attachments`,
      `${FX}/records/${readRecord}/attachments/${attachmentId}`,
    ];
    const outcomes = [];
    for (const url of reads) {
      const { status, effects } = await outcomeOf(get(url), credentials);
      outcomes.push({ url, status, effects: sideEffects(effects) });
    }
    expect(outcomes).toEqual(reads.map((url) => ({ url, status: 404, effects: QUIET })));
  });

  it.each<[string, (id: string) => ProbeRequest]>([
    ['the /v1 approve', (id) => ({ method: 'POST', url: `${V1}/records/${id}/transitions/approve` })],
    ['the /v1 upload', (id) => upload(`${V1}/records/${id}/attachments`)],
    ['the fixture approve', (id) => ({ method: 'POST', url: `${FX}/records/${id}/approve` })],
    ['the fixture edit', (id) => ({ method: 'POST', url: `${FX}/records/${id}/edit`, headers: JSON_HEADERS, payload: { ...EDIT_BODY } })],
    ['the fixture upload', (id) => upload(`${FX}/records/${id}/attachments`)],
  ])('answers %s of a tenant-a record by a tenant-b finance user 404, writing nothing', async (_label, request) => {
    const id = seedRecord('SUBMITTED');
    const { status, effects } = await outcomeOf(request(id), await tenantB());
    expect({ status, writes: effects.writes, objects: effects.objects, published: effects.published }).toEqual({
      status: 404,
      writes: 0,
      objects: 0,
      published: 0,
    });
    expect(storedRecord(id)).toEqual({ state: 'SUBMITTED', version: 1 });
  });

  it.each([`${V1}/records`, `${FX}/records`])('lists no tenant-a record to a tenant-b finance user on %s', async (url) => {
    const ownRecord = seedRecord('IN-PROGRESS', TENANT_B);
    const res = await inject(get(url), await tenantB());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(ownRecord);
    const tenantARecords = t.db.rows('record', TENANT_A.tenantId).map((row) => row.record_id);
    expect(tenantARecords.filter((id) => res.body.includes(id))).toEqual([]);
  });

  it("refuses a signed URL re-pointed at another tenant's object path", async () => {
    const repointed = fileUrl.replace(`/${TENANT_A.tenantId}/`, `/${TENANT_B.tenantId}/`);
    expect(repointed).not.toBe(fileUrl);
    const { status, effects } = await outcomeOf(get(repointed), {});
    expect({ status, effects: sideEffects(effects) }).toEqual({ status: 403, effects: QUIET });
    const original = await inject(get(fileUrl), {});
    expect([original.statusCode, original.rawPayload.equals(FILE_BYTES)]).toEqual([200, true]);
  });
});

describe('migration object read', () => {
  const TENANT_B_BYTES = Buffer.from('%PDF-1.4 finance tenant-b migration probe\n');
  /** A tenant-b attachment whose stored object holds TENANT_B_BYTES. */
  let tenantBAttachment: string;
  /** A tenant-a attachment row with no object stored under its key. */
  let unstoredAttachment: string;

  /** Seeds an attachment row of `bytes` on a fresh record of `tenant`; returns its id and object key. */
  function seedAttachment(tenant: TenantFixture, bytes: Buffer): { id: string; key: string } {
    const id = cfUuid();
    const key = attachmentObjectKey(tenant.tenantId, id, 'probe.pdf');
    t.db.seed('attachment', [
      {
        tenant_id: tenant.tenantId,
        attachment_id: id,
        record_id: seedRecord('IN-PROGRESS', tenant),
        file_name: 'probe.pdf',
        content_type: 'application/pdf',
        size_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        object_key: key,
        created: TEST_CLOCK.now(),
        createdbyid: SEED_USER,
        legacy_program_id: programOf(tenant),
      },
    ]);
    return { id, key };
  }

  /** The response and effects of `request` sent as the migration workload, with the tenants its statements ran under. */
  async function migrationRead(request: ProbeRequest): Promise<{ res: InjectResponse; effects: Effects; tenants: string[] }> {
    const credentials = await headersFor('service:migration');
    const before = mark();
    const res = await inject(request, credentials);
    const tenants = [...new Set(t.db.queries().flatMap((query) => (query.tenantId === null ? [] : [query.tenantId])))];
    return { res, effects: effectsSince(before), tenants };
  }

  beforeAll(async () => {
    const stored = seedAttachment(TENANT_B, TENANT_B_BYTES);
    await t.storage.put(ATTACHMENT_BUCKET, stored.key, TENANT_B_BYTES, { contentType: 'application/pdf' });
    tenantBAttachment = stored.id;
    unstoredAttachment = seedAttachment(TENANT_A, FILE_BYTES).id;
  });

  it.each<[string, () => [TenantFixture, string, Buffer]]>([
    ['the tenant-a attachment uploaded through /v1', () => [TENANT_A, attachmentId, FILE_BYTES]],
    ['a tenant-b attachment', () => [TENANT_B, tenantBAttachment, TENANT_B_BYTES]],
  ])('streams the stored bytes of %s under its own tenant alone, writing nothing', async (_label, target) => {
    const [tenant, id, bytes] = target();
    const { res, effects, tenants } = await migrationRead(objectRead(tenant.tenantId, id));
    expect({
      status: res.statusCode,
      contentType: res.headers['content-type'],
      contentLength: res.headers['content-length'],
      body: res.rawPayload.toString('latin1'),
      tenants,
      effects: sideEffects(effects),
    }).toEqual({
      status: 200,
      contentType: 'application/octet-stream',
      contentLength: String(bytes.length),
      body: bytes.toString('latin1'),
      tenants: [tenant.tenantId],
      effects: QUIET,
    });
  });

  it.each<[string, () => [TenantFixture, string]]>([
    ['an attachment id no tenant holds', () => [TENANT_A, UNKNOWN_ID]],
    ['the tenant-a attachment asked of tenant-b', () => [TENANT_B, attachmentId]],
    ['a tenant-b attachment asked of tenant-a', () => [TENANT_A, tenantBAttachment]],
    ['a tenant-a row with no stored object', () => [TENANT_A, unstoredAttachment]],
  ])('answers %s with the legacy 404, reading only the named tenant and writing nothing', async (_label, target) => {
    const [tenant, id] = target();
    const { res, effects, tenants } = await migrationRead(objectRead(tenant.tenantId, id));
    expect({ status: res.statusCode, error: errorOf(res), tenants, effects: sideEffects(effects) }).toEqual({
      status: 404,
      error: NOT_FOUND,
      tenants: [tenant.tenantId],
      effects: QUIET,
    });
  });

  it.each<[string, () => string]>([
    ['no query', () => OBJECTS_URL],
    ['no tenantId', () => `${OBJECTS_URL}?attachmentId=${attachmentId}`],
    ['no attachmentId', () => `${OBJECTS_URL}?tenantId=${TENANT_A.tenantId}`],
    ['a site id as tenantId', () => `${OBJECTS_URL}?tenantId=${SITE_A}&attachmentId=${attachmentId}`],
    ['an RFC 4122 attachmentId', () => `${OBJECTS_URL}?tenantId=${TENANT_A.tenantId}&attachmentId=${randomUUID()}`],
    ['two tenantIds', () => `${objectRead(TENANT_A.tenantId, attachmentId).url}&tenantId=${TENANT_B.tenantId}`],
    ['a siteid naming tenant-b', () => `${objectRead(TENANT_A.tenantId, attachmentId).url}&siteid=${SITE_B}`],
  ])('refuses a read with %s as invalid parameters before any statement', async (_label, url) => {
    const { res, effects } = await migrationRead(get(url()));
    expect({ status: res.statusCode, error: errorOf(res), effects }).toEqual({ status: 400, error: INVALID_PARAMETERS, effects: { ...QUIET, statements: [] } });
  });

  it('refuses a finance user token claiming the migration roles, beside the gateway credential, before any statement', async () => {
    const roles = ['system-user', PREPARER, APPROVER, 'service:migration', 'platform.migration'];
    const userToken = `Bearer ${await mintUserToken({ sub: SEED_USER, site: SITE_A, roles })}`;
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const outcome = await outcomeOf(objectRead(TENANT_A.tenantId, attachmentId), { authorization: userToken, [INVOCATION_HEADER]: gatewayToken });
    expect(outcome).toEqual({ status: 403, error: FORBIDDEN, effects: { ...QUIET, statements: [] } });
  });
});

describe('transport separation', () => {
  const v1List = get(`${V1}/records`);
  const fixtureList = get(`${FX}/records`);
  const position = get('/internal/v1/migration/position');
  const objects = (): ProbeRequest => objectRead(TENANT_A.tenantId, attachmentId);

  /** Asserts that every request in `requests` sent with `credentials` is answered 401 without effect. */
  async function expectUnauthenticated(requests: readonly ProbeRequest[], credentials: Record<string, string>): Promise<void> {
    for (const request of requests) {
      const { status, effects } = await outcomeOf(request, credentials);
      expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: { ...QUIET, statements: [] } });
    }
  }

  it.each(['s2', PREPARER])('refuses the %s user token on the push route, with or without the push key', async (name) => {
    await expectUnauthenticated([pushWithoutKey(), withPushKey(pushWithoutKey())], await headersFor(name, { site: SITE_A }));
  });

  it('refuses a tasks-invoker token on user, migration and push routes, with or without the gateway invocation credential', async () => {
    const tasksToken = `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`;
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const presented: Record<string, string>[] = [{ authorization: tasksToken }, { authorization: tasksToken, [INVOCATION_HEADER]: gatewayToken }];
    for (const credentials of presented) {
      await expectUnauthenticated([v1List, fixtureList, position, objects(), pushWithoutKey()], credentials);
    }
  });

  it('refuses the push key on user and migration routes, alone or beside the gateway invocation credential', async () => {
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    await expectUnauthenticated([withPushKey(v1List), withPushKey(fixtureList), withPushKey(position), withPushKey(objects())], {});
    await expectUnauthenticated([withPushKey(v1List), withPushKey(fixtureList)], { [INVOCATION_HEADER]: gatewayToken });
  });

  it('refuses a wrong push key on the push route', async () => {
    await expectUnauthenticated([withPushKey(pushWithoutKey(), `${TEST_PUSH_KEY}-wrong`)], {});
  });

  it('refuses an invocation credential addressed to another service', async () => {
    const userToken = `Bearer ${await mintUserToken({ sub: SEED_USER, site: SITE_A, roles: ['system-user', PREPARER, APPROVER] })}`;
    const gatewayElsewhere = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'communications' })}`;
    const migrationRoles = ['service:migration', 'platform.migration'];
    const migrationElsewhere = `Bearer ${await mintServiceToken({ caller: 'migration', audience: 'communications', roles: migrationRoles })}`;
    await expectUnauthenticated([v1List, fixtureList], { authorization: userToken, [INVOCATION_HEADER]: gatewayElsewhere });
    await expectUnauthenticated([position, objects()], { [INVOCATION_HEADER]: migrationElsewhere });
  });

  it.each<[string, Parameters<typeof mintUserToken>[0]]>([
    ['an expired user token', { sub: SEED_USER, site: SITE_A, roles: [PREPARER], iat: Math.floor(Date.now() / 1000) - 600 }],
    ['a user token of another audience', { sub: SEED_USER, site: SITE_A, roles: [PREPARER], aud: 'opt2-elsewhere' }],
    ['a user token of another issuer', { sub: SEED_USER, site: SITE_A, roles: [PREPARER], iss: 'opt2-elsewhere-identity' }],
  ])('refuses %s beside a valid gateway invocation credential', async (_label, claims) => {
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    await expectUnauthenticated([v1List, fixtureList], { authorization: `Bearer ${await mintUserToken(claims)}`, [INVOCATION_HEADER]: gatewayToken });
  });
});

describe('deny by default', () => {
  it.each<[string, string, Opt2RouteConfig | undefined]>([
    ['declares no config.opt2', `${V1}/undeclared-probe`, undefined],
    ['declares both requires and public', `${V1}/both-probe`, { requires: [PREPARER], public: true }],
    ['declares an empty requires list', `${V1}/empty-probe`, { requires: [] }],
    ['is a public push route', '/internal/v1/events/finance.public-probe', { public: true, transport: 'pubsub-push' }],
    ['declares the service transport on a push path', '/internal/v1/events/finance.service-probe', { transport: 'service', requires: [PREPARER] }],
  ])('fails start-up of the buildApp instance when a route %s', async (_label, url, opt2) => {
    const built = await buildTestApp({ ready: false });
    try {
      const startUp = (async () => {
        built.app.get(url, opt2 === undefined ? {} : { config: { opt2 } }, async () => ({}));
        await built.app.ready();
      })();
      const failure = await startUp.then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(UndeclaredRouteError);
      expect(failure).toMatchObject({ method: 'GET', url });
    } finally {
      await built.app.close().catch(() => undefined);
    }
  });

  it.each<[string, ProbeRequest]>([
    ['a /v1 record create', { method: 'POST', url: `${V1}/records`, headers: JSON_HEADERS, payload: { ...NEW_RECORD } }],
    ['a /v1 record update', { method: 'PUT', url: `${V1}/records/${UNKNOWN_ID}`, headers: JSON_HEADERS, payload: { ...EDIT_BODY } }],
    ['a /v1 record delete', { method: 'DELETE', url: `${V1}/records/${UNKNOWN_ID}` }],
    ['a /v2 transition', { method: 'POST', url: `${V2}/records/${UNKNOWN_ID}/transitions/submit` }],
    ['an outbox sweep', { method: 'POST', url: '/internal/v1/outbox/sweep', headers: JSON_HEADERS, payload: {} }],
    ['a task callback', { method: 'POST', url: '/internal/v1/tasks/finance-probe', headers: JSON_HEADERS, payload: {} }],
  ])('answers %s, which no route declares, 404 without effect', async (_label, request) => {
    const preparer = await headersFor({ roles: ['system-user', PREPARER, APPROVER] }, { site: SITE_A });
    const outcome = await outcomeOf(request, preparer);
    expect({ status: outcome.status, effects: outcome.effects }).toEqual({ status: 404, effects: { ...QUIET, statements: [] } });
  });
});
