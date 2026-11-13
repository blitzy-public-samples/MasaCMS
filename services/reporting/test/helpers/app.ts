// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The reporting app under test: `buildApp` over the memory database or a throwaway PostgreSQL schema, a fake task port, local storage and scripted service calls. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { cfUuid, legacyErrorResponse, type LegacyApiErrorType } from '@opt2/platform/legacy-compat';
import { UNIT_GATE_TABLE, qualified, type GatePhase, type GateState } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  baseEnvSchema,
  loadEnv,
  type BaseEnv,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import {
  QUEUES,
  taskWireBody,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskInfo,
  type TaskPort,
  type TaskWireBody,
} from '@opt2/platform/tasks';
import { tenantIdForSite, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  BUSINESS_DATE,
  ROLE_SET,
  TENANT_A,
  authHeadersFor,
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pushTo,
  registryPayloads,
  runCleanup,
  seedRegistry,
  subjectSiteFor,
  testEnvelope,
  testVerifier,
  type CapturingPublisher,
  type Clock,
  type RoleSubject,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import {
  EXPORT_BUCKET,
  OWNED_TABLES,
  UNITS,
  exportObjectKey,
  type ExportDefinitionRow,
  type ExportFormat,
  type ExportJobRow,
  type ExportState,
  type ReportingUnit,
} from '../../src/repo/tables.js';
import { createExportRunEnqueuer, exportRunTaskName } from '../../src/tasks/enqueue.js';
import { createMemoryDb, type MemoryDb, type MemoryTable, type Row } from './memory-db.js';

/** Service under test, the audience of every invocation credential sent to it. */
export const SERVICE = 'reporting';

/** Clock of every test app: the shared business date at noon in the process zone. */
export const TEST_CLOCK: Clock = businessClock();

/** Business date every export run, and so every timesheets source read, is taken as of. */
export const TEST_AS_OF = BUSINESS_DATE;

/** The reporting contract, parsed once. */
export const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

/** The producer contracts reporting calls for export sources. */
export const PRODUCER_OPENAPI: Readonly<Record<'finance' | 'timesheets', object>> = Object.freeze({
  finance: parse(readFileSync(new URL('../../../finance/contracts/openapi.yaml', import.meta.url), 'utf8')) as object,
  timesheets: parse(readFileSync(new URL('../../../timesheets/contracts/openapi.yaml', import.meta.url), 'utf8')) as object,
});


/** Storage HMAC key of the test apps' local adapter; not a secret. */
const STORAGE_HMAC_KEY = 'opt2-reporting-gates-test-storage-key';

/** The process's time zone: `TZ` when set, else the zone `Intl` resolves. */
function processZone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Environment of a test app; the JWKS URL is never fetched, as the test verifier replaces the remote key set. */
export function testEnv(stateDir: string): BaseEnv {
  return loadEnv(baseEnvSchema, {
    PORT: '8116',
    OPT2_SERVICE_NAME: SERVICE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: stateDir,
    OPT2_SERVICE_URLS: JSON.stringify({
      [SERVICE]: 'http://127.0.0.1:8116',
      identity: 'http://127.0.0.1:8111',
      finance: 'http://127.0.0.1:8119',
      timesheets: 'http://127.0.0.1:8118',
    }),
    TZ: processZone(),
  });
}

/** One task port call, as `<op> <queue>`, with the input of a create. */
export interface TaskCall {
  op: string;
  queue: string;
  input?: CreateTaskInput;
}

/** A TaskPort over in-memory queues that records every call; it never dispatches. */
export interface FakeTaskPort extends TaskPort {
  readonly kind: 'local';
  readonly calls: TaskCall[];
  /** Live tasks, keyed `<queue>/<name>`. */
  readonly live: ReadonlyMap<string, CreateTaskInput>;
}

/** Creates a {@link FakeTaskPort}; a name created twice on a queue answers `created: false`, as Cloud Tasks does. */
export function createFakeTaskPort(): FakeTaskPort {
  const calls: TaskCall[] = [];
  const live = new Map<string, CreateTaskInput>();
  const paused = new Set<string>();
  const keyOf = (queue: string, name: string): string => `${queue}/${name}`;
  const infoOf = (input: CreateTaskInput): TaskInfo => ({
    queue: input.queue,
    name: input.name,
    scheduleTime: new Date(input.scheduleTime.getTime()),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    status: 'pending',
    attempts: 0,
  });
  return {
    kind: 'local',
    calls,
    live,
    create(input: CreateTaskInput): Promise<CreateTaskResult> {
      calls.push({ op: 'create', queue: input.queue, input });
      const key = keyOf(input.queue, input.name);
      if (live.has(key)) return Promise.resolve({ name: input.name, created: false });
      live.set(key, input);
      return Promise.resolve({ name: input.name, created: true });
    },
    delete(queue: string, name: string): Promise<DeleteTaskResult> {
      calls.push({ op: 'delete', queue });
      return Promise.resolve({ name, deleted: live.delete(keyOf(queue, name)) });
    },
    list(queue: string) {
      calls.push({ op: 'list', queue });
      return Promise.resolve({ tasks: [...live.values()].filter((input) => input.queue === queue).map(infoOf) });
    },
    get(queue: string, name: string): Promise<TaskInfo | undefined> {
      calls.push({ op: 'get', queue });
      const input = live.get(keyOf(queue, name));
      return Promise.resolve(input === undefined ? undefined : infoOf(input));
    },
    pauseQueue(queue: string): Promise<void> {
      calls.push({ op: 'pauseQueue', queue });
      paused.add(queue);
      return Promise.resolve();
    },
    resumeQueue(queue: string): Promise<void> {
      calls.push({ op: 'resumeQueue', queue });
      paused.delete(queue);
      return Promise.resolve();
    },
    queueState(queue: string): Promise<QueueState> {
      calls.push({ op: 'queueState', queue });
      return Promise.resolve({ queue, paused: paused.has(queue) });
    },
    close: (): Promise<void> => Promise.resolve(),
  };
}

/** The `X-csrf_token` pair a browser sends with a write. */
export interface CsrfPair {
  'x-csrf_token': string;
  'x-csrf_token_expires': string;
}

/** Answer of one scripted service call. */
export type ClientReply = (request: ServiceRequest) => ServiceResponse | Promise<ServiceResponse>;

/** One export scope check a scripted source made against reporting's `getExportSourceScope`, with its answer. */
export interface ScopeCheck {
  service: ExportProducer;
  exportId: string;
  siteId: string;
  status: number;
  body: unknown;
}

/** A source producer of reporting's exports. */
export type ExportProducer = 'finance' | 'timesheets';

/** Asks the reporting app under test for the scope of `exportId` on `siteId`, as `service`'s workload. */
export type ScopeLookup = (service: ExportProducer, exportId: string, siteId: string) => Promise<Omit<ScopeCheck, 'service' | 'exportId' | 'siteId'>>;

/**
 * The service client of a test app, recording every call: identity's CSRF ledger, and paged export source producers that, as the
 * real ones do, serve a read carrying no user token only once reporting's own scope route confirms its running job and claim.
 */
export interface ScriptedClient extends Pick<ServiceClient, 'request'> {
  readonly requests: ServiceRequest[];
  /** Every scope check the scripted producers made, in order. */
  readonly scopeChecks: ScopeCheck[];
  /** The answer a recorded request received, undefined when it was refused. */
  responseOf(request: ServiceRequest): ServiceResponse | undefined;
  /** A token identity accepts once, in session `sessionId`, for `context`. */
  issueCsrf(sessionId: string, context: string): CsrfPair;
  /** Replaces the answer to `service` `path` until `reset`. */
  answer(service: string, path: string, reply: ClientReply): void;
  /** Restores the default answers; issued tokens, recorded calls and scope checks stay. */
  reset(): void;
}

const CSRF_EXPIRES = '260630235959000';

/** The export reads of the timesheets and finance producers. */
export const SOURCE_PATHS: Readonly<Record<ExportProducer, string>> = Object.freeze({
  timesheets: '/internal/v1/timesheets/sheet-status',
  finance: '/internal/v1/finance/records',
});

/** The source each producer's export read serves. */
const PRODUCER_SOURCES: Readonly<Record<ExportProducer, string>> = Object.freeze({ timesheets: 'timesheets.sheets', finance: 'finance.records' });

/** Sheet status rows the timesheets stub answers, in its contract's `SheetStatusRow` shape. */
export const SHEET_STATUS_ROWS = Object.freeze([
  {
    timesheetId: '7E1A0000-0000-4000-8000000000000001',
    siteId: TENANT_A.siteId,
    personId: '7E1A0000-0000-4000-8000000000000002',
    periodStart: '2026-06-01T00:00:00',
    status: 'SUBMITTED',
    overdue: true,
    dayCount: 5,
    blackoutCount: 1,
    approvedCount: 0,
  },
]);

/** Finance records the finance stub answers, in its contract's `FinanceRecord` shape. */
export const FINANCE_RECORDS = Object.freeze([
  {
    record_id: 'F1A00000-0000-4000-8000000000000001',
    siteid: TENANT_A.siteId,
    title: 'Quarterly travel',
    amount: '1250.5000',
    period: '2026-06',
    state: 'SUBMITTED',
    version: 2,
    created: '2026-06-02T09:15:00',
    createdbyid: 'F1A00000-0000-4000-8000000000000002',
    lastupdate: '',
    lastupdatebyid: '',
  },
]);

function json(status: number, body: unknown): ServiceResponse {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

/** The legacy error envelope answer of `type`, with lower-cased header names as the service client returns them. */
function legacyError(type: LegacyApiErrorType): ServiceResponse {
  const { status, headers, body } = legacyErrorResponse(type);
  return { status, headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])), body: JSON.parse(body) as unknown };
}

/** A producer's 403: the legacy `authorization` envelope a refused export scope answers. */
function forbidden(): ServiceResponse {
  return { ...legacyError('authorization'), status: 403 };
}

/** Rows of page `index` (from 1) of `rows` in pages of `size`. */
function pageOf<R>(rows: readonly R[], index: number, size: number): R[] {
  return rows.slice((index - 1) * size, index * size);
}

/** The single text value of query parameter `name`, '' when absent or repeated. */
function queryText(request: ServiceRequest, name: string): string {
  const value = request.query?.[name];
  return typeof value === 'string' ? value : '';
}

/** Creates a {@link ScriptedClient} whose producers check scopes through `lookup`; a call no answer covers rejects, so the request under test fails loudly. */
export function createScriptedClient(lookup: ScopeLookup): ScriptedClient {
  const requests: ServiceRequest[] = [];
  const scopeChecks: ScopeCheck[] = [];
  const responses = new WeakMap<ServiceRequest, ServiceResponse>();
  const issued = new Map<string, { sessionId: string; context: string }>();
  const consumed = new Set<string>();
  let overrides = new Map<string, ClientReply>();

  /** `reply` behind `service`'s export scope check: a user token, or a scope reporting does not confirm as running under the read's claim, answers 403. */
  const scoped =
    (service: ExportProducer, reply: ClientReply): ClientReply =>
    async (request) => {
      if (request.userToken !== null) return forbidden();
      const [exportId, siteId, claim] = ['exportId', 'siteId', 'claim'].map((name) => queryText(request, name)) as [string, string, string];
      const checked = await lookup(service, exportId, siteId);
      scopeChecks.push({ service, exportId, siteId, ...checked });
      const scope = checked.body as { tenantId?: string; source?: string; state?: string; claim?: string };
      const confirmed =
        checked.status === 200 &&
        scope.tenantId === tenantIdForSite(siteId) &&
        scope.source === PRODUCER_SOURCES[service] &&
        scope.state === 'running' &&
        scope.claim === claim;
      return confirmed ? reply(request) : forbidden();
    };

  const defaults = new Map<string, ClientReply>([
    [
      `${IDENTITY_SERVICE} ${CSRF_CONSUME_PATH}`,
      (request) => {
        const { sessionId, token, context } = request.json as CsrfConsumeRequest;
        const grant = issued.get(token);
        const valid = grant !== undefined && grant.sessionId === sessionId && grant.context === context && !consumed.has(token);
        if (valid) consumed.add(token);
        return json(200, { valid });
      },
    ],
    [
      `timesheets ${SOURCE_PATHS.timesheets}`,
      scoped('timesheets', (request) => {
        const items = pageOf(SHEET_STATUS_ROWS, Number(queryText(request, 'pageIndex')), Number(queryText(request, 'itemsPerPage')));
        return json(200, { items, total: SHEET_STATUS_ROWS.length });
      }),
    ],
    [
      `finance ${SOURCE_PATHS.finance}`,
      scoped('finance', (request) => {
        const data = pageOf(FINANCE_RECORDS, Number(queryText(request, 'page')), Number(queryText(request, 'pageSize')));
        return json(200, { data, total: FINANCE_RECORDS.length });
      }),
    ],
  ]);

  return {
    requests,
    scopeChecks,
    responseOf: (request) => responses.get(request),
    issueCsrf(sessionId: string, context: string): CsrfPair {
      const token = cfUuid().replace(/-/g, '');
      issued.set(token, { sessionId, context });
      return { 'x-csrf_token': token, 'x-csrf_token_expires': CSRF_EXPIRES };
    },
    answer(service: string, callPath: string, reply: ClientReply): void {
      overrides.set(`${service} ${callPath}`, reply);
    },
    reset(): void {
      overrides = new Map();
    },
    async request<T>(request: ServiceRequest): Promise<ServiceResponse<T>> {
      requests.push(request);
      const key = `${request.service} ${request.path}`;
      const reply = overrides.get(key) ?? defaults.get(key);
      if (reply === undefined) throw new Error(`reporting called no scripted service: ${request.method} ${key}`);
      const response = await reply(request);
      responses.set(request, response);
      return response as ServiceResponse<T>;
    },
  };
}

/** Database of a test app: the in-memory stand-in, or a throwaway PostgreSQL schema migrated from `db/migrations`. */
export type TestDbMode = 'recording' | 'pg';

/** Owned tables {@link TestApp.seed} writes, the `table` names of `OWNED_TABLES`. */
export type SeedTable = Extract<MemoryTable, 'export_definition' | 'export_job' | 'session_tracking'>;

/** Gate state of each unit in a new test app: the export units take target writes, session tracking stays legacy-authoritative. */
export const DEFAULT_GATES: Readonly<Record<ReportingUnit, GateState>> = Object.freeze({
  'reporting.export_definition': 'open',
  'reporting.export_job': 'open',
  'reporting.session_tracking': 'legacy',
});

/** Holder id of gates a test app closes; the gate table requires a holder exactly when a gate is closed. */
const TEST_GATE_HOLDER = 'reporting-test-app';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

/** The app under test and every recording its routes write to. */
export interface TestApp<D extends TenantDb = MemoryDb> {
  app: FastifyInstance;
  db: D;
  mode: TestDbMode;
  /** The throwaway schema of `'pg'` mode, dropped on close; undefined in `'recording'` mode. */
  throwaway: ThrowawaySchema | undefined;
  publisher: CapturingPublisher;
  tasks: FakeTaskPort;
  storage: LocalStorageAdapter;
  client: ScriptedClient;
  clock: Clock;
  stateDir: string;
  /** Adds committed rows to `table`, each in its own `tenant_id`'s transaction, bypassing the repository and so writing no changelog. */
  seed(table: SeedTable, rows: readonly Row[]): Promise<void>;
  /** Sets the gate of `unit` to `state` in `phase` (default quiet). */
  setGate(unit: ReportingUnit, state: GateState, phase?: GatePhase): Promise<void>;
  /** Closes the app, drops the throwaway schema and its roles, and removes the state directory; repeated calls share the first outcome. */
  close(): Promise<void>;
}

/** Options of {@link buildTestApp}. */
export interface TestAppOptions {
  /** `'recording'` by default; `'pg'` needs the `PG_*` variables. */
  db?: TestDbMode;
  /** Gate states over {@link DEFAULT_GATES}, set before the app answers its first request. */
  gates?: Partial<Record<ReportingUnit, GateState>>;
  /** False leaves `tenant_registry` empty instead of holding the fixture sites. */
  registry?: boolean;
  /** Adds routes after the service's own and before `ready`, as a later registration would. */
  declare?: (app: FastifyInstance) => unknown;
}

/** Sets the stored gate row of `unit` directly, as fixture setup rather than the migration service's compare-and-set. */
async function setGateRow(db: TenantDb, unit: ReportingUnit, state: GateState, phase: GatePhase): Promise<void> {
  const holder = state === 'closed' ? TEST_GATE_HOLDER : null;
  const result = await withMetadata(db, (tx) =>
    tx.query(`UPDATE ${qualified(tx.schema, UNIT_GATE_TABLE)} SET state = $2, holder_id = $3, phase = $4 WHERE unit = $1`, [unit, state, holder, phase]),
  );
  if (result.rowCount !== 1) throw new Error(`no ${UNIT_GATE_TABLE} row holds ${unit}`);
}

/** Inserts `rows` into owned `table` of PostgreSQL `db`, one transaction per tenant, naming the catalogue columns each row sets. */
async function insertRows(db: TenantDb, table: SeedTable, rows: readonly Row[]): Promise<void> {
  const definition = OWNED_TABLES.find((candidate) => candidate.table === table);
  if (definition === undefined) throw new TypeError(`${table} is not an owned reporting table`);
  const catalogue = definition.columns.map((column) => column.name);
  const byTenant = new Map<string, Row[]>();
  for (const row of rows) {
    const unknown = Object.keys(row).filter((name) => !catalogue.includes(name));
    if (unknown.length > 0) throw new TypeError(`${table} has no column ${unknown.join(', ')}`);
    if (typeof row.tenant_id !== 'string') throw new TypeError(`a ${table} seed row needs a tenant_id`);
    byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), row]);
  }
  for (const [tenantId, tenantRows] of byTenant) {
    await withTenant(db, tenantId, async (tx) => {
      for (const row of tenantRows) {
        const columns = catalogue.filter((name) => name in row);
        const placeholders = columns.map((_, i) => `$${String(i + 1)}`).join(', ');
        await tx.query(
          `INSERT INTO ${qualified(tx.schema, table)} (${columns.join(', ')}) VALUES (${placeholders})`,
          columns.map((name) => row[name]),
        );
      }
    });
  }
}

/** A contract-valid `programs-sites.site.changed.v1` envelope of the fixture site `siteId`. */
export function siteChangedEnvelope(siteId: string, aggregateVersion = 1) {
  const payload = registryPayloads().find((candidate) => candidate.siteId === siteId);
  if (payload === undefined) throw new TypeError(`registryPayloads has no ${siteId} payload`);
  return testEnvelope({ topic: 'programs-sites.site.changed.v1', tenantId: tenantIdForSite(siteId), aggregateId: siteId, aggregateVersion, payload });
}

/** The path of reporting's `getExportSourceScope` for `exportId` on `siteId`. */
export function scopeUrl(exportId: string, siteId: string): string {
  return `/internal/v1/exports/${encodeURIComponent(exportId)}/source-scope?siteId=${encodeURIComponent(siteId)}`;
}

/** A lookup answering scope checks from `app`'s own `getExportSourceScope`, called with the producer's invocation credential. */
function scopeLookupOf(app: FastifyInstance): ScopeLookup {
  return async (service, exportId, siteId) => {
    const credential = `Bearer ${await mintServiceToken({ caller: service, audience: SERVICE })}`;
    const res = await app.inject({ method: 'GET', url: scopeUrl(exportId, siteId), headers: { [INVOCATION_HEADER]: credential } });
    return { status: res.statusCode, body: res.json<unknown>() };
  };
}

/**
 * Builds reporting through `buildApp` with every route its source registers, sets the unit gates, fills the tenant registry with the
 * fixture sites (site.changed pushes in memory, the platform seeder in PostgreSQL), and installs the scripted service client.
 */
export function buildTestApp(options?: TestAppOptions & { db?: 'recording' }): Promise<TestApp>;
export function buildTestApp(options: TestAppOptions & { db: 'pg' }): Promise<TestApp<TenantDb>>;
export function buildTestApp(options: TestAppOptions): Promise<TestApp<TenantDb>>;
export async function buildTestApp(options: TestAppOptions = {}): Promise<TestApp<TenantDb>> {
  // Recording even when PostgreSQL is reachable: the contract and security suites seed and read the MemoryDb directly.
  const mode = options.db ?? 'recording';
  const gates: Record<ReportingUnit, GateState> = { ...DEFAULT_GATES, ...options.gates };
  const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-gates-'));
  let app: FastifyInstance | undefined;
  let throwaway: ThrowawaySchema | undefined;
  const teardown = (): Promise<void> =>
    runCleanup('reporting test app', [() => app?.close(), () => throwaway?.drop(), () => rm(stateDir, { recursive: true, force: true })]);
  try {
    let db: TenantDb;
    let memory: MemoryDb | undefined;
    if (mode === 'pg') {
      throwaway = await createThrowawaySchema({ service: SERVICE, migrationsDir: MIGRATIONS_DIR });
      db = throwaway.app;
      if (options.registry !== false) await seedRegistry(db, db.schema);
    } else {
      memory = createMemoryDb({ now: () => TEST_CLOCK.now() });
      memory.seed(
        'unit_gate',
        UNITS.map((unit) => ({
          unit,
          state: gates[unit],
          holder_id: gates[unit] === 'closed' ? TEST_GATE_HOLDER : null,
          phase: 'quiet',
          updated_at: TEST_CLOCK.now(),
        })),
      );
      db = memory;
    }
    const publisher = createCapturingPublisher();
    const tasks = createFakeTaskPort();
    const storage = await createLocalStorageAdapter({ stateDir, hmacKey: STORAGE_HMAC_KEY, now: () => TEST_CLOCK.now().getTime() });
    app = await buildApp({
      env: testEnv(stateDir),
      clock: TEST_CLOCK,
      verifierOverride: testVerifier(SERVICE),
      db,
      publisher,
      storage,
      tasks,
    });
    const client = createScriptedClient(scopeLookupOf(app));
    // ReportingDeps holds this same client object, so the domain's producer reads are scripted too.
    vi.spyOn(app.opt2.client, 'request').mockImplementation((request) => client.request(request));
    options.declare?.(app);
    // ready() inserts a legacy gate for every unit the PostgreSQL schema does not hold yet.
    await app.ready();
    if (mode === 'pg') {
      for (const unit of UNITS) await setGateRow(db, unit, gates[unit], 'quiet');
    }
    if (memory !== undefined && options.registry !== false) {
      for (const payload of registryPayloads()) {
        const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(payload.siteId));
        if (res.statusCode !== 204) throw new Error(`registry push of ${payload.siteId} answered ${res.statusCode} ${res.body}`);
      }
    }
    const seeded = memory;
    let closing: Promise<void> | undefined;
    return {
      app,
      db,
      mode,
      throwaway,
      publisher,
      tasks,
      storage,
      client,
      clock: TEST_CLOCK,
      stateDir,
      async seed(table, rows) {
        if (seeded === undefined) await insertRows(db, table, rows);
        else seeded.seed(table, rows);
      },
      setGate: (unit, state, phase = 'quiet') => setGateRow(db, unit, state, phase),
      close: () => (closing ??= teardown()),
    };
  } catch (err) {
    try {
      await teardown();
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], `reporting test app failed to build: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }
}

/** Seeds an export definition of `site` reading `source`, and returns it. */
export function seedDefinition(db: MemoryDb, site: string, source = 'timesheets.sheets'): ExportDefinitionRow {
  const row: ExportDefinitionRow = {
    tenant_id: tenantIdForSite(site),
    definition_id: cfUuid(),
    siteid: site,
    name: `${source} export`,
    source,
    columns: source === 'finance.records' ? '["record_id","title","amount","state"]' : '["timesheet_id","person_id","status","overdue"]',
  };
  db.seed('export_definition', [row]);
  return row;
}

/** User and session of every seeded job: the reporting exporter of ROLE_SET. */
export const REQUESTER: { sub: string; sid: string } = identityOf({ name: Roles.reportingExporter });

const RUN_QUEUE = QUEUES['reporting-export-run'];

/** Seeds a job of `definition` in `state`, requested by {@link REQUESTER}; a done job's output is stored first, so its pointer names a real object. */
export async function seedJob(
  t: Pick<TestApp, 'db' | 'storage'>,
  definition: ExportDefinitionRow,
  state: ExportState,
  format: ExportFormat = 'csv',
): Promise<ExportJobRow> {
  const jobId = cfUuid();
  const created = new Date(TEST_CLOCK.now().getTime() - 60 * 60 * 1000);
  const finished = state === 'done' || state === 'failed';
  const row: ExportJobRow = {
    tenant_id: definition.tenant_id,
    job_id: jobId,
    siteid: definition.siteid,
    definition_id: definition.definition_id,
    format,
    state,
    requested_by_id: REQUESTER.sub,
    created,
    started_at: state === 'queued' ? null : created,
    finished_at: finished ? created : null,
    error: state === 'failed' ? 'export-failed' : null,
    file_name: null,
    content_type: null,
    object_key: null,
    output_sha256: null,
    row_version: state === 'queued' ? '1' : '3',
  };
  if (state === 'done') {
    const key = exportObjectKey(definition.tenant_id, jobId, format);
    const put = await t.storage.put(EXPORT_BUCKET, key, Buffer.from('timesheet_id,status\r\n1,SUBMITTED\r\n'), { contentType: 'text/csv' });
    Object.assign(row, { file_name: `export-${jobId}.${format}`, content_type: 'text/csv', object_key: key, output_sha256: put.sha256 });
  }
  t.db.seed('export_job', [row]);
  return row;
}

/** The wire body the task adapters POST for the live run task of job `jobId`. */
export function queuedRun(t: Pick<TestApp, 'tasks'>, jobId: string): TaskWireBody {
  const task = t.tasks.live.get(`${RUN_QUEUE.name}/${exportRunTaskName(jobId)}`);
  if (task === undefined) throw new Error(`no run task is queued for export job ${jobId}`);
  return taskWireBody(task);
}

/** Queues the run of seeded `job` through reporting's own enqueuer, as its create does, and returns its wire body. */
export async function queueRun(t: Pick<TestApp, 'app' | 'tasks'>, job: Pick<ExportJobRow, 'tenant_id' | 'job_id'>): Promise<TaskWireBody> {
  const enqueue = createExportRunEnqueuer({ tasks: t.tasks, serviceUrls: t.app.opt2.env.OPT2_SERVICE_URLS, clock: TEST_CLOCK });
  await enqueue({ tenantId: job.tenant_id, jobId: job.job_id, payload: { jobId: job.job_id, asOf: TEST_AS_OF } });
  return queuedRun(t, job.job_id);
}

/** Fixed CF-format Masa UserID and session id of each subject name, so CSRF tokens can be issued, and user tokens minted, for its session. */
export function identityOf(subject: Pick<RoleSubject, 'name'>): { sub: string; sid: string } {
  const hex = [...subject.name].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).toUpperCase().padStart(8, '0');
  return { sub: `${hex}-0000-4000-8000000000000001`, sid: `${hex}-0000-4000-8000000000000002` };
}

/** Options of {@link headersFor}. */
export interface HeadersOptions {
  /** Site a user token is minted for; tenant-a by default. */
  site?: string;
}

/** The ROLE_SET subject called `name`; throws TypeError for a name ROLE_SET lacks. */
function roleSubjectNamed(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return found;
}

/**
 * Credentials of `subject`, a RoleSubject or the name of one in ROLE_SET, for the reporting app: a user's token minted for the site
 * (`site` itself or `site.site`, tenant-a by default) in its fixed session.
 */
export async function headersFor(subject: RoleSubject | string, site: string | HeadersOptions = TENANT_A.siteId): Promise<Record<string, string>> {
  const resolved = typeof subject === 'string' ? roleSubjectNamed(subject) : subject;
  const siteId = typeof site === 'string' ? site : (site.site ?? TENANT_A.siteId);
  if (resolved.kind !== 'user') return authHeadersFor(resolved, { audience: SERVICE, site: siteId });
  const { sub, sid } = identityOf(resolved);
  const [user, invocation] = await Promise.all([
    mintUserToken({ sub, sid, site: subjectSiteFor(resolved, siteId), roles: resolved.roles, s2: resolved.s2 }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}
