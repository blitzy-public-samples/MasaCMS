// Test-only composition of the migration route registrars over the real context, each wired to the module its dependency
// interface names; doubles stand only at the external boundaries: gateway and owner services, legacy SQL Server and bridge.
import { readFileSync } from 'node:fs';

import { rolesForService } from '@opt2/platform/auth';
import { BRIDGE_ASSERTION_HEADER, MemoryNonceStore, verifyBridgeAssertion } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import {
  ServiceUnavailableError,
  createService,
  loadEnv,
  systemClock,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  assertResponseMatchesOpenApi,
  findOperation,
  rewriteMigrationSql,
  testVerifier,
  type ContractViolation,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { parse } from 'yaml';

import { createMigrationContext, type MigrationContext } from '../../src/context.js';
import { createGatewayClient, currentAuthority } from '../../src/cutover/index.js';
import { migrationEnvSchema } from '../../src/env.js';
import { BRIDGE_JOBS, createBridgeClient, type LegacyDb, type SchedulerDescription } from '../../src/legacy/index.js';
import { createBackgroundState } from '../../src/quiesce/index.js';
import { createProjector, type StartupGuardRunner } from '../../src/reverse/index.js';
import { AUTHORITY_ROUTES, registerAuthorityRoutes } from '../../src/routes/authority.js';
import { BACKGROUND_ROUTES, registerBackgroundRoutes } from '../../src/routes/background.js';
import { LEGACY_STEP_ROUTES, registerLegacyStepRoutes } from '../../src/routes/legacy-steps.js';
import { PROJECTION_ROUTES, registerProjectionRoutes } from '../../src/routes/projection.js';
import { SCHEDULER_ROUTES, registerSchedulerRoutes } from '../../src/routes/scheduler.js';
import { SCHEDULER_STATE_TABLE, createSchedulerService } from '../../src/scheduler/index.js';
import { createWindowService } from '../../src/windows/index.js';

/** Service name, the audience of invocation credentials sent to the composed app. */
export const SERVICE = 'migration';

/** Origin of the legacy bridge double. */
const LEGACY_ORIGIN = 'http://legacy.route-suites.test';

/** The operations the composed registrars declare, in registration order. */
export const REGISTERED_OPERATIONS = Object.freeze([
  ...AUTHORITY_ROUTES,
  ...BACKGROUND_ROUTES,
  ...LEGACY_STEP_ROUTES,
  ...PROJECTION_ROUTES,
  ...SCHEDULER_ROUTES,
]);

/** Contract operations no registrar under `src/routes/` serves: the service has no `server.ts` composing their modules yet. */
export const ABSENT_OPERATIONS = Object.freeze([
  'faultClear',
  'faultSet',
  'gatesList',
  'transitionGet',
  'transitionStart',
  'windowComplete',
  'windowGet',
  'windowOpen',
  'windowResolve',
] as const);

// Low-entropy values assembled from parts: the suites never reach a database or a real bridge with them.
const BRIDGE_KEY = ['route', 'suites', 'bridge', 'key'].join('-');
const UNUSED_DB_PASSWORD = ['unused', 'by', 'route', 'suites'].join('-');

const ENV_SOURCE: NodeJS.ProcessEnv = {
  PORT: '8102',
  OPT2_SERVICE_NAME: SERVICE,
  OPT2_ENV: 'local',
  OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
  OPT2_TOKEN_ISSUER: 'opt2-local-identity',
  OPT2_TOKEN_AUDIENCE: 'opt2-local',
  TZ: 'UTC',
  GOOGLE_CLOUD_PROJECT: 'opt2-route-suites',
  PUBSUB_EMULATOR_HOST: '127.0.0.1:9',
  MURA_DBHOST: '127.0.0.1',
  MURA_DATABASE: 'muradb_route_suites',
  MURA_DBUSERNAME: 'route-suites',
  MURA_DBPASSWORD: UNUSED_DB_PASSWORD,
  LEGACY_ORIGIN,
  OPT2_BRIDGE_HMAC_KEY: BRIDGE_KEY,
};

/** An OpenAPI document as the suites read it. */
export interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

type Json = Record<string, unknown>;

/** Repository-relative contract file of each callee the package calls. */
const CONTRACT_FILES: Readonly<Record<string, string>> = Object.freeze({
  migration: 'migration/contracts/openapi.yaml',
  gateway: 'gateway/contracts/openapi.yaml',
  ...Object.fromEntries(
    ['identity', 'people', 'programs-sites', 'strategies-content', 'communications', 'reporting', 'surveys', 'timesheets', 'finance', 'e-signature'].map(
      (service) => [service, `services/${service}/contracts/openapi.yaml`],
    ),
  ),
});

const contracts = new Map<string, OpenApiDoc>();

/** The producer contract of `service`, parsed once; throws for a callee without one. */
export function producerContract(service: string): OpenApiDoc {
  let doc = contracts.get(service);
  if (doc === undefined) {
    const file = CONTRACT_FILES[service];
    if (file === undefined) throw new TypeError(`No contract is known for callee ${service}`);
    doc = parse(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')) as OpenApiDoc;
    contracts.set(service, doc);
  }
  return doc;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `node` with local `#/…` references followed until a non-reference node. */
function deref(doc: OpenApiDoc, node: unknown): unknown {
  let current = node;
  const seen = new Set<string>();
  while (isRecord(current) && typeof current.$ref === 'string' && current.$ref.startsWith('#/') && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split('/')
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((parent, segment) => (isRecord(parent) ? parent[segment] : undefined), doc);
  }
  return current;
}

interface Parameter {
  name: string;
  required: boolean;
  schema: unknown;
}

/** Parameters of an operation `in` the query or path, path-item ones first, references resolved. */
function parametersOf(doc: OpenApiDoc, template: string, operation: Json, location: 'query' | 'path'): Parameter[] {
  const item = deref(doc, doc.paths[template]);
  const shared: unknown[] = isRecord(item) && Array.isArray(item.parameters) ? item.parameters : [];
  const own: unknown[] = Array.isArray(operation.parameters) ? operation.parameters : [];
  return [...shared, ...own]
    .map((parameter) => deref(doc, parameter))
    .filter((parameter): parameter is Json => isRecord(parameter) && parameter.in === location)
    .map((parameter) => ({ name: String(parameter.name), required: parameter.required === true, schema: parameter.schema ?? {} }));
}

/** Path parameter values of `path` under `template`, decoded. */
function pathValuesOf(template: string, path: string): Record<string, string> {
  const names: string[] = [];
  const pattern = template
    .split(/(\{\w+\})/)
    .map((part) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (name === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(name);
      return '([^/]+)';
    })
    .join('');
  const match = new RegExp(`^${pattern}$`).exec(path);
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match?.[index + 1] ?? '')]));
}

/** Validates `values` against the declared `parameters` as one object, unknown names refused. */
function assertParameters(doc: OpenApiDoc, req: ServiceRequest, template: string, kind: string, parameters: Parameter[], values: Json): void {
  const verb = req.method.toLowerCase();
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.schema])),
  };
  const probe = probeDoc(doc, `${req.service} ${verb} ${template} ${kind}`, template, verb, {
    description: kind,
    content: { 'application/json': { schema } },
  });
  assertResponseMatchesOpenApi(probe, { method: req.method, path: req.path, status: 200, contentType: 'application/json', body: values });
}

const probes = new Map<string, OpenApiDoc>();

/** `doc` with only `template`'s `verb` answering 200 with `content`, so the platform's response checker validates request parts. */
function probeDoc(doc: OpenApiDoc, key: string, template: string, verb: string, response: unknown): OpenApiDoc {
  let probe = probes.get(key);
  if (probe === undefined) {
    probe = { ...doc, paths: { [template]: { [verb]: { responses: { '200': response } } } } };
    probes.set(key, probe);
  }
  return probe;
}

/** The query `req` sends, its undefined values dropped as the service client drops them. */
function sentQuery(req: ServiceRequest): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(req.query ?? {}).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
}

/** One outbound call the package made, the producer operation it reached and the status it was answered with. */
export interface ContractCall {
  caller: string;
  req: ServiceRequest;
  operationId: string;
  status?: number;
}

/**
 * Checks one outbound call against its producer's contract: the operation exists on the service transport, admits the caller's
 * workload roles, takes no user token, accepts the path values, declares every query parameter sent and receives every required
 * one, and accepts the body.
 * @returns the producer's operation id. @throws ContractAssertionError naming every violation.
 */
export function assertCallMatchesContract(caller: string, req: ServiceRequest): string {
  const doc = producerContract(req.service);
  const { template, operation } = findOperation(doc, req.method, req.path);
  const context = `${req.service} ${req.method} ${template} as ${caller}`;
  const violations: ContractViolation[] = [];
  const violation = (instancePath: string, message: string, keyword: string): void => {
    violations.push({ instancePath, message, keyword });
  };
  if (operation['x-opt2-transport'] !== 'service') violation('/x-opt2-transport', `is ${String(operation['x-opt2-transport'])}, not service`, 'transport');
  const requires = Array.isArray(operation['x-opt2-requires']) ? (operation['x-opt2-requires'] as string[]) : [];
  if (!rolesForService(caller).some((role) => requires.includes(role))) violation('/x-opt2-requires', `admits none of ${caller}'s roles`, 'requires');
  if (req.userToken !== null) violation('/userToken', 'a workload call must send no user token', 'userToken');
  if (violations.length > 0) throw new ContractAssertionError(context, violations);

  const pathParameters = parametersOf(doc, template, operation, 'path');
  if (pathParameters.length > 0) assertParameters(doc, req, template, 'path', pathParameters, pathValuesOf(template, req.path));
  assertParameters(doc, req, template, 'query', parametersOf(doc, template, operation, 'query'), sentQuery(req));

  const verb = req.method.toLowerCase();
  const body = deref(doc, operation.requestBody);
  const content = isRecord(body) && isRecord(body.content) ? body.content : undefined;
  if (req.json !== undefined) {
    // An operation without a JSON body takes no fields, so only an empty object passes.
    if (content?.['application/json'] === undefined) {
      if (!isRecord(req.json) || Object.keys(req.json).length > 0) violation('/requestBody', 'declares no application/json body', 'requestBody');
    } else {
      const probe = probeDoc(doc, `${req.service} ${verb} ${template} body`, template, verb, body);
      assertResponseMatchesOpenApi(probe, { method: req.method, path: req.path, status: 200, contentType: 'application/json', body: req.json });
    }
  } else if (req.body !== undefined) {
    const mediaType = req.headers?.['content-type'] ?? '';
    if (content?.[mediaType] === undefined) violation('/requestBody', `declares no ${mediaType || '(none)'} body`, 'requestBody');
  } else if (isRecord(body) && body.required === true) {
    violation('/requestBody', 'is required but none was sent', 'requestBody');
  }
  if (violations.length > 0) throw new ContractAssertionError(context, violations);
  return String(operation.operationId);
}

/** Checks a producer answer against the operation `req` reached; a streamed 2xx body is checked for its declared media type only. */
export function assertAnswerMatchesContract(req: ServiceRequest, res: ServiceResponse): void {
  const doc = producerContract(req.service);
  const header = res.headers['content-type'];
  const contentType = (Array.isArray(header) ? header[0] : header) ?? 'application/json';
  const streamed = req.stream === true && res.status >= 200 && res.status <= 299;
  assertResponseMatchesOpenApi(doc, { method: req.method, path: req.path, status: res.status, contentType, body: streamed ? '' : res.body });
}

/** Answers one outbound call; throwing stands for a callee that cannot be reached. */
export type Responder = (req: ServiceRequest) => ServiceResponse | Promise<ServiceResponse>;

/** A service client of `caller` whose every call and answer must match the producer's contract; each call is appended to `calls`. */
export function contractClient(caller: string, respond: Responder, calls: ContractCall[]): ServiceClient {
  return {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      const call: ContractCall = { caller, req, operationId: assertCallMatchesContract(caller, req) };
      calls.push(call);
      const res = await respond(req);
      call.status = res.status;
      assertAnswerMatchesContract(req, res);
      return res as ServiceResponse<T>;
    },
    close: () => Promise.resolve(),
  };
}

/** A JSON answer. */
export function jsonAnswer(status: number, body: unknown, headers: Record<string, string> = {}): ServiceResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body };
}

/** The callee could not be reached, as the platform service client reports it. */
export function unreachable(service: string): ServiceUnavailableError {
  return new ServiceUnavailableError(service, Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
}

/** Statements and transactions a TenantDb ran since the last reset. */
interface DbRecording {
  db: TenantDb;
  transactions: number;
  statements: string[];
  reset(): void;
}

/** `db` with every transaction and statement counted. */
function recordingDb(db: TenantDb): DbRecording {
  const recording: DbRecording = {
    db: {
      schema: db.schema,
      withTenant: (tenantId, fn, options) => {
        recording.transactions += 1;
        return db.withTenant(tenantId, (tx) => fn({ ...tx, query: countQueries(tx.query.bind(tx)) }), options);
      },
      withMetadata: (fn, options) => {
        recording.transactions += 1;
        return db.withMetadata((tx) => fn({ ...tx, query: countQueries(tx.query.bind(tx)) }), options);
      },
      end: () => db.end(),
    },
    transactions: 0,
    statements: [],
    reset() {
      recording.transactions = 0;
      recording.statements = [];
    },
  };
  function countQueries(query: MetadataTx['query']): MetadataTx['query'] {
    return ((text: string | QueryConfig, values?: unknown[]) => {
      recording.statements.push(typeof text === 'string' ? text : text.text);
      return query(text, values);
    }) as MetadataTx['query'];
  }
  return recording;
}

function queryResult(rows: QueryResultRow[], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

const SELECT_KEYS = `SELECT key, value FROM ${SCHEDULER_STATE_TABLE} WHERE key = ANY($1::text[])`;
const SELECT_KEY = `SELECT value FROM ${SCHEDULER_STATE_TABLE} WHERE key = $1`;
const LOCK_KEY = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const UPSERT_PREFIX = `INSERT INTO ${SCHEDULER_STATE_TABLE} (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key)`;

/** A `migration` schema database and the way to empty it between cases. */
export interface MigrationDb {
  db: TenantDb;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * `migration.scheduler_state` in memory, answering exactly the statements the scheduler and background modules issue; any other
 * statement fails the call, and a failed transaction is undone. The same statements run on PostgreSQL in {@link postgresMigrationDb}.
 */
export function memoryMigrationDb(): MigrationDb {
  let rows = new Map<string, unknown>();
  const run = (text: string, values: readonly unknown[]): QueryResult => {
    if (text === LOCK_KEY) return queryResult([]);
    if (text === SELECT_KEYS) {
      const keys = (values[0] as string[]).filter((key) => rows.has(key));
      return queryResult(keys.map((key) => ({ key, value: structuredClone(rows.get(key)) })));
    }
    const key = String(values[0]);
    if (text === SELECT_KEY || text === `${SELECT_KEY} FOR UPDATE`) {
      return queryResult(rows.has(key) ? [{ value: structuredClone(rows.get(key)) }] : []);
    }
    if (text.startsWith(UPSERT_PREFIX)) {
      rows.set(key, JSON.parse(String(values[1])) as unknown);
      return queryResult([], 1);
    }
    throw new Error(`The in-memory migration schema does not run: ${text}`);
  };
  const db: TenantDb = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('The migration schema has no tenant tables')),
    async withMetadata(fn) {
      const before = new Map(rows);
      const tx = {
        schema: 'migration',
        kind: 'metadata',
        onCommit: () => undefined,
        query: (text: string | QueryConfig, values?: unknown[]) => Promise.resolve().then(() => run(typeof text === 'string' ? text : text.text, values ?? [])),
      } as unknown as MetadataTx;
      try {
        return await fn(tx);
      } catch (error) {
        rows = before;
        throw error;
      }
    },
    end: () => Promise.resolve(),
  };
  return {
    db,
    clear: () => {
      rows = new Map();
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}

/**
 * The `migration` schema statements on a migrated PostgreSQL throwaway schema: each statement's `migration.` qualifier is rewritten
 * to the throwaway schema exactly as the platform rewrites the migrations that created it.
 */
export function postgresMigrationDb(schema: ThrowawaySchema): MigrationDb {
  const target = schema.schema;
  const bind = (tx: MetadataTx): MetadataTx =>
    ({
      ...tx,
      schema: 'migration',
      query: (text: string | QueryConfig, values?: unknown[]) =>
        typeof text === 'string'
          ? tx.query(rewriteMigrationSql(text, 'migration', target), values)
          : tx.query({ ...text, text: rewriteMigrationSql(text.text, 'migration', target) }, values),
    }) as MetadataTx;
  const db: TenantDb = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('The migration schema has no tenant tables')),
    withMetadata: (fn, options) => schema.app.withMetadata((tx) => fn(bind(tx)), options),
    end: () => Promise.resolve(),
  };
  return {
    db,
    clear: () => schema.app.withMetadata(async (tx) => void (await tx.query(`DELETE FROM ${target}.scheduler_state`))),
    close: () => schema.drop(),
  };
}

/** One `opt2_sync.projector_checkpoint` row of the legacy double: batches applied through `appliedHorizon`, no effect owed. */
export interface CheckpointFixture {
  owner: string;
  tenantId: string;
  appliedHorizon: string;
}

const CHECKPOINT_SELECT_PREFIX = 'SELECT owner, tenant_id, CONVERT(varchar(20), cursor_xid) AS cursor_xid';
const LIVE_SITES = 'SELECT DISTINCT SiteID FROM dbo.tsettings WHERE SiteID IS NOT NULL';

/** What the external boundaries answer; a suite changes it between requests. */
export interface BoundaryState {
  /** Active version the gateway reports; null before `v0001`. */
  tableVersion: string | null;
  /** The gateway cannot be reached. */
  gatewayDown: boolean;
  /** Current write position each owner reports. */
  positions: Map<string, string>;
  /** Live `tsettings` site ids. */
  sites: string[];
  checkpoints: CheckpointFixture[];
  /** `scheduler.describe` of the legacy bridge. */
  live: SchedulerDescription;
  /** `jobs.cfm` answers every step with a 500, as a manager method that threw. */
  jobsFailing: boolean;
}

/** The gateway's contract `CutoverStatus` for `tableVersion`. */
function cutoverStatus(tableVersion: string | null): unknown {
  const at = '2026-06-30T12:00:00.000Z';
  return {
    tableVersion,
    previous: tableVersion === 'v0002' ? 'v0001' : tableVersion === 'v0003' ? 'v0002' : null,
    epoch: 7,
    groupAuthority: {},
    frozen: [],
    instances: [{ instanceId: 'gw-1', seenEpoch: 7, heartbeatAt: at, live: true }],
    acknowledgedEpoch: 7,
    inflight: [],
    sessionMode: 'legacy-primary',
  };
}

/** The gateway and owner services as the composed routes call them: cut-over status and current write positions. */
function boundaryResponder(state: BoundaryState): Responder {
  return (req) => {
    if (req.service === 'gateway') {
      if (state.gatewayDown) throw unreachable('gateway');
      if (req.method === 'GET' && req.path === '/internal/v1/cutover/status') return jsonAnswer(200, cutoverStatus(state.tableVersion));
    } else if (req.method === 'GET' && req.path === '/internal/v1/migration/position') {
      const position = state.positions.get(req.service);
      if (position === undefined) throw unreachable(req.service);
      return jsonAnswer(200, { owner: req.service, position, outbox: null, inbox: null });
    }
    throw new Error(`The composed routes made an unexpected call: ${req.service} ${req.method} ${req.path}`);
  };
}

/** Live legacy SQL Server reads of the projection barrier, `tsettings` site ids and checkpoints by owner; each pool use and query counts. */
function legacyDouble(state: BoundaryState, counter: { reads: number }): LegacyDb {
  const pool = {
    request() {
      const inputs = new Map<string, unknown>();
      return {
        input(name: string, ...rest: unknown[]) {
          inputs.set(name, rest.at(-1));
          return this;
        },
        cancel: () => undefined,
        query(text: string) {
          counter.reads += 1;
          if (text === LIVE_SITES) return Promise.resolve({ recordset: state.sites.map((SiteID) => ({ SiteID })) });
          if (text.startsWith(CHECKPOINT_SELECT_PREFIX)) {
            const owners = new Set([...inputs].filter(([name]) => /^o\d+$/.test(name)).map(([, value]) => value));
            const recordset = state.checkpoints
              .filter((row) => owners.has(row.owner))
              .map((row) => ({
                owner: row.owner,
                tenant_id: row.tenantId,
                cursor_xid: row.appliedHorizon,
                cursor_seq: '1',
                applied_horizon: row.appliedHorizon,
                batch_id: 'route-suites-batch',
                rows_applied: 1,
                updated_at: null,
                pending_effects: null,
                ready_horizon: null,
              }));
            return Promise.resolve({ recordset });
          }
          return Promise.reject(new Error(`The legacy double does not run: ${text}`));
        },
      };
    },
  };
  const refuse = (): Promise<never> => Promise.reject(new Error('The composed routes only read the live legacy database'));
  return {
    live: () => {
      counter.reads += 1;
      return Promise.resolve(pool as unknown as Awaited<ReturnType<LegacyDb['live']>>);
    },
    database: refuse,
    transaction: refuse,
    close: () => Promise.resolve(),
  };
}

/** Wire time `jobs.cfm` answers a step with: legacy wall-clock time without an offset. */
const JOBS_SERVER_TIME = '2026-06-30T12:00:00.123';

/** A bridge JSON answer. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * `scheduler.cfm` and `jobs.cfm` of the legacy bridge: verifies each single-use assertion as its guard does, refusing with an
 * empty 403, and answers `scheduler.describe` and every `jobs.<step>` POST.
 */
function bridgeFetch(state: BoundaryState, counter: { calls: number }): typeof globalThis.fetch {
  const nonces = new MemoryNonceStore();
  return (input, init) => {
    counter.calls += 1;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const verdict = verifyBridgeAssertion(headers.get(BRIDGE_ASSERTION_HEADER) ?? '', BRIDGE_KEY, nonces);
    const page = /\/gateway\/legacy-bridge\/cfml\/(\w+)\.cfm$/.exec(url.pathname)?.[1];
    const op = url.searchParams.get(page === 'jobs' ? 'job' : 'op');
    if (!verdict.ok || verdict.payload.op !== `${String(page)}.${String(op)}`) {
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    if (page === 'scheduler' && op === 'describe' && init?.method === 'GET') return Promise.resolve(jsonResponse(200, state.live));
    if (page === 'jobs' && op !== null && (BRIDGE_JOBS as readonly string[]).includes(op) && init?.method === 'POST') {
      if (state.jobsFailing) return Promise.resolve(jsonResponse(500, { error: 'server_error', message: `jobs.${op} failed` }));
      const siteId = url.searchParams.get('siteid');
      return Promise.resolve(jsonResponse(200, { job: op, ...(siteId === null ? {} : { siteId }), completed: true, serverTime: JOBS_SERVER_TIME }));
    }
    return Promise.reject(new Error(`The bridge double does not serve ${init?.method ?? 'GET'} ${url.pathname}?${url.searchParams.toString()}`));
  };
}

/** The projector loop never starts in the route suites, so the guard is never asked to commit a batch. */
const UNSTARTED_LOOP_GUARD: StartupGuardRunner = {
  run: () => Promise.reject(new Error('The projector loop is not started in the route suites')),
};

/** Every effect a request can leave behind. */
export interface Effects {
  transactions: number;
  statements: number;
  serviceCalls: number;
  bridgeCalls: number;
  legacyReads: number;
}

/** The composed app, its context, the boundary state it answers from and the effects it records. */
export interface RouteApp {
  app: FastifyInstance;
  ctx: MigrationContext;
  state: BoundaryState;
  /** Outbound service calls since the last reset, each checked against its producer's contract. */
  calls: ContractCall[];
  effects(): Effects;
  resetEffects(): void;
  close(): Promise<void>;
}

/** Boundary state of a fresh app: `v0002` active, every owner and site reachable, nothing captured on ColdFusion. */
export function defaultBoundaryState(): BoundaryState {
  return {
    tableVersion: 'v0002',
    gatewayDown: false,
    positions: new Map(),
    sites: ['default', 'tenant-a', 'tenant-b', 'umbrella'],
    checkpoints: [],
    live: { ping: false, siteMonitorTask: '/index.cfm/_api/sitemonitor/', tasks: [], serverTime: '2026-06-30 12:00:00' },
    jobsFailing: false,
  };
}

/** Options of {@link buildRouteApp}. */
export interface BuildRouteAppOptions {
  db: TenantDb;
  /** Adds routes after the registrars and before `ready`, for start-up checks. */
  extraRoutes?: (app: FastifyInstance) => void;
}

/** Composes and readies the app; on a start-up failure everything it opened is closed and the error propagates. */
export async function buildRouteApp(options: BuildRouteAppOptions): Promise<RouteApp> {
  const state = defaultBoundaryState();
  const calls: ContractCall[] = [];
  const recording = recordingDb(options.db);
  const legacyCounter = { reads: 0 };
  const bridgeCounter = { calls: 0 };
  const env = loadEnv(migrationEnvSchema, ENV_SOURCE);
  const logger = createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });
  const client = contractClient(SERVICE, boundaryResponder(state), calls);
  const ctx = await createMigrationContext({
    env,
    clock: systemClock,
    logger,
    db: recording.db,
    legacy: legacyDouble(state, legacyCounter),
    bridge: createBridgeClient({ origin: LEGACY_ORIGIN, key: BRIDGE_KEY, fetch: bridgeFetch(state, bridgeCounter) }),
    client,
    gateway: createGatewayClient({ migrationClient: client, operatorClient: contractClient('operator', boundaryResponder(state), calls) }),
  });
  let app: FastifyInstance | undefined;
  try {
    app = await createService({ name: SERVICE, version: '1.0.0', env, verifierOverride: testVerifier(SERVICE), logger });
    const background = createBackgroundState(ctx);
    const projector = createProjector(ctx, { startupGuard: UNSTARTED_LOOP_GUARD });
    registerAuthorityRoutes(app, { authority: () => currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths }), catalog: ctx.catalog });
    registerBackgroundRoutes(app, { background });
    // The route suites run no step whose units are target-authoritative, so no window ever opens over the in-memory schema.
    registerLegacyStepRoutes(app, { windows: createWindowService(ctx, { projector }) });
    registerProjectionRoutes(app, { projector, defaultTimeoutMs: ctx.config.projection.defaultAwaitTimeoutMs });
    registerSchedulerRoutes(app, { scheduler: createSchedulerService(ctx), background });
    options.extraRoutes?.(app);
    await app.ready();
  } catch (error) {
    await app?.close().catch(() => undefined);
    await ctx.close();
    throw error;
  }
  const ready = app;
  return {
    app: ready,
    ctx,
    state,
    calls,
    effects: () => ({
      transactions: recording.transactions,
      statements: recording.statements.length,
      serviceCalls: calls.length,
      bridgeCalls: bridgeCounter.calls,
      legacyReads: legacyCounter.reads,
    }),
    resetEffects() {
      recording.reset();
      calls.length = 0;
      bridgeCounter.calls = 0;
      legacyCounter.reads = 0;
    },
    async close() {
      await ready.opt2.shutdown();
      await ctx.close();
    },
  };
}
