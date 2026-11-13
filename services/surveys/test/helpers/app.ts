// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Shared scaffolding of the surveys suites: the app built for `app.inject` over an in-memory database, task port, publisher and service client. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import type { GatePhase, GateState } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  ServiceUnavailableError,
  baseEnvSchema,
  loadEnv,
  systemClock,
  type BaseEnv,
  type Clock,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  assertCreateInput,
  resolvePageSize,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskInfo,
  type TaskPage,
  type TaskPageRequest,
  type TaskPort,
} from '@opt2/platform/tasks';
import {
  NON_TENANT_TABLES,
  TENANT_SETTING,
  tenantDbFromPool,
  tenantIdForSite,
  type Pool,
  type QueryConfig,
  type QueryResult,
  type SiteChangedPayload,
  type TenantDb,
} from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  authHeadersFor,
  businessClock,
  createCapturingPublisher,
  fixedClock,
  registryPayloads,
  seedRegistry as seedRegistryTable,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type RoleSubject,
} from '@opt2/platform/testing';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import type { components } from '../../src/generated/clients/communications.js';
import type { ScheduledTaskRecord } from '../../src/legacy/tasks-view.js';
import { OWNER, SCHEMA } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';

export { fixedClock };

const STATE_DIR_PREFIX = 'opt2-surveys-test-';
const COMMUNICATIONS = 'communications';
const SCHEDULED_TASKS_PATH = '/internal/v1/scheduled-tasks';
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let sharedStateDir: Promise<string> | undefined;

/** The process's state directory for {@link testEnv}, created and filled with the test secrets on first use; removed, best effort, at process exit. */
function testStateDir(): Promise<string> {
  sharedStateDir ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), STATE_DIR_PREFIX));
    process.once('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover temporary directory never fails the run.
      }
    });
    await writeTestSecrets(dir);
    return dir;
  })();
  return sharedStateDir;
}

/**
 * Local-mode environment of surveys, parsed by `loadEnv(baseEnvSchema)`; an override of `undefined` removes the variable.
 * An overridden `OPT2_STATE_DIR` gets no test secrets written to it.
 */
export async function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}): Promise<BaseEnv> {
  const source: Record<string, string | undefined> = {
    PORT: '8117',
    OPT2_SERVICE_NAME: OWNER,
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    // Never connected to: every suite injects its database.
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2_test',
    PG_USER: 'surveys_app',
    PG_PASSWORD: 'unused',
    PUBSUB_EMULATOR_HOST: 'localhost:8085',
    GOOGLE_CLOUD_PROJECT: 'opt2-local',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_GATEWAY_URL: 'http://127.0.0.1:8100',
    OPT2_MIGRATION_URL: 'http://127.0.0.1:8102',
    OPT2_SERVICE_URLS: JSON.stringify({
      communications: 'http://127.0.0.1:8115',
      surveys: 'http://127.0.0.1:8117',
      migration: 'http://127.0.0.1:8102',
    }),
    OPT2_STATE_DIR: 'OPT2_STATE_DIR' in overrides ? undefined : await testStateDir(),
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    TZ: 'UTC',
    ...overrides,
  };
  return loadEnv(baseEnvSchema, source);
}

/** Clock every suite shares: local `2026-06-30T12:00:00`, the seed's business date; other instants come from `fixedClock`. */
export const TEST_CLOCK: Clock = businessClock();

/** Selects task creations: an object matches when its `queue` equals and its `name` equals or matches the RegExp; a function decides itself. */
export type TaskMatcher = { queue?: string; name?: string | RegExp } | ((input: CreateTaskInput) => boolean);

/** In-memory `TaskPort` keyed by queue and task name as Cloud Tasks is; it never dispatches. */
export interface FakeTaskPort extends TaskPort {
  readonly kind: 'local';
  /** Inputs of the tasks actually created, in creation order. */
  readonly tasks: CreateTaskInput[];
  readonly closed: boolean;
  /** Makes matching creates reject with an Error naming the queue and task until the returned disposer runs. */
  failCreate(matcher: TaskMatcher): () => void;
}

function taskPredicate(matcher: TaskMatcher): (input: CreateTaskInput) => boolean {
  if (typeof matcher === 'function') return matcher;
  const { queue, name } = matcher;
  return (input) =>
    (queue === undefined || input.queue === queue) &&
    (name === undefined || (typeof name === 'string' ? input.name === name : name.test(input.name)));
}

/** Creates a {@link FakeTaskPort}; a repeated name, deleted ones included, answers `created: false` as ALREADY_EXISTS does. */
export function createFakeTaskPort(): FakeTaskPort {
  const records: { input: CreateTaskInput; live: boolean }[] = [];
  const tasks: CreateTaskInput[] = [];
  const paused = new Set<string>();
  const failures = new Set<(input: CreateTaskInput) => boolean>();
  let closed = false;

  const find = (queue: string, name: string) => records.find((task) => task.input.queue === queue && task.input.name === name);
  const infoOf = ({ input }: { input: CreateTaskInput }): TaskInfo => ({
    queue: input.queue,
    name: input.name,
    scheduleTime: new Date(input.scheduleTime.getTime()),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    status: 'pending',
    attempts: 0,
  });

  return {
    kind: 'local',
    tasks,
    get closed() {
      return closed;
    },
    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      assertCreateInput(input);
      for (const fails of failures) {
        if (fails(input)) throw new Error(`fake task port: injected create failure for ${input.queue}/${input.name}`);
      }
      if (find(input.queue, input.name) !== undefined) return { name: input.name, created: false };
      records.push({ input, live: true });
      tasks.push(input);
      return { name: input.name, created: true };
    },
    async delete(queue: string, name: string): Promise<DeleteTaskResult> {
      const task = find(queue, name);
      if (task === undefined || !task.live) return { name, deleted: false };
      task.live = false;
      return { name, deleted: true };
    },
    async list(queue: string, page: TaskPageRequest = {}): Promise<TaskPage> {
      const pageSize = resolvePageSize(page.pageSize);
      const live = records.filter((task) => task.live && task.input.queue === queue);
      const start = page.pageToken === undefined ? 0 : Number(page.pageToken);
      const end = start + pageSize;
      const listed = live.slice(start, end).map(infoOf);
      return end < live.length ? { tasks: listed, nextPageToken: String(end) } : { tasks: listed };
    },
    async get(queue: string, name: string): Promise<TaskInfo | undefined> {
      const task = find(queue, name);
      return task?.live === true ? infoOf(task) : undefined;
    },
    async pauseQueue(queue: string): Promise<void> {
      paused.add(queue);
    },
    async resumeQueue(queue: string): Promise<void> {
      paused.delete(queue);
    },
    async queueState(queue: string): Promise<QueueState> {
      return { queue, paused: paused.has(queue) };
    },
    async close(): Promise<void> {
      closed = true;
    },
    failCreate(matcher: TaskMatcher): () => void {
      const predicate = taskPredicate(matcher);
      failures.add(predicate);
      return () => {
        failures.delete(predicate);
      };
    },
  };
}

/** A canned service answer, or a function computing it from the request. */
export type ClientReply = ServiceResponse | ((req: ServiceRequest) => ServiceResponse | Promise<ServiceResponse>);

/** Answers a {@link ClientRecorder} starts with. */
export interface ClientRecorderHandlers {
  /** Replies keyed `'<service> <METHOD> <path>'`; a `{name}` path segment matches any one segment. */
  routes?: Readonly<Record<string, ClientReply>>;
  /** Records of the default communications scheduled-tasks answer; defaults to {@link defaultScheduledTasks}. */
  scheduledTasks?: (surveyId: string) => ScheduledTaskRecord[];
}

/** Fake service client: records each call, then answers from explicit replies, failure modes and defaults; it never reaches the network. */
export interface ClientRecorder {
  /** Every call in order, as the caller passed it. */
  readonly requests: ServiceRequest[];
  request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>>;
  /** Answers `service`'s `method` and `path` (`{name}` segments match any one segment) with `reply`, above earlier replies. */
  respond(service: string, method: ServiceRequest['method'], path: string, reply: ClientReply): void;
  /** Every later call without an explicit reply answers `status` with the legacy 503 envelope. */
  fail(status: number): void;
  /** Every later call without an explicit reply rejects with service-kit's ServiceUnavailableError. */
  unavailable(): void;
  /** Sets the `valid` the default identity CSRF consume answers; initially true. */
  csrfValid(valid: boolean): void;
  /** Clears the failure modes and explicit replies and restores CSRF validity; `requests` and the handlers stay. */
  reset(): void;
  /** Replaces `request` on the app's own service client, which the route modules captured at registration. */
  install(app: FastifyInstance): void;
}

type ScheduledTaskList = components['schemas']['ScheduledTaskList'];

interface ClientRoute {
  service: string;
  method: string;
  pattern: RegExp;
  reply: ClientReply;
}

const ROUTE_KEY = /^(\S+) (GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;

function pathPattern(template: string): RegExp {
  const source = template
    .split(/(\{[^}/]+\})/)
    .map((part) => (/^\{[^}/]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

function pathOnly(path: string): string {
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}

/** Value of query parameter `name`, from `req.query` or else the path's query string. */
function queryParam(req: ServiceRequest, name: string): string | undefined {
  const value = req.query?.[name];
  if (value !== undefined) return Array.isArray(value) ? value[0] : value;
  const query = req.path.indexOf('?');
  return query === -1 ? undefined : (new URLSearchParams(req.path.slice(query + 1)).get(name) ?? undefined);
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `YYYY-MM-DDTHH:mm:ss.SSS` of `date` in the process zone, the contracts' `LocalTimestamp`. */
function localIso(date: Date): string {
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/** Deterministic CF-format id of a survey's reminder `n`. */
function reminderTaskId(surveyId: string, n: number): string {
  const hex = createHash('sha256').update(`${surveyId}:reminder:${String(n)}`).digest('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 32)}`;
}

/**
 * Communications' records of a survey scheduled at version 1: its launch a day after `clock` (default TEST_CLOCK) on
 * `surveys-launch`, then reminder n (`reminders`, default 2) n hours later on `communications-reminders`.
 */
export function defaultScheduledTasks(surveyId: string, opts: { reminders?: number; clock?: Clock } = {}): ScheduledTaskRecord[] {
  const launchAt = (opts.clock ?? TEST_CLOCK).now().getTime() + DAY_MS;
  const launch: ScheduledTaskRecord = {
    taskName: `opt2-survey-${surveyId}-launch`,
    kind: 'survey-launch',
    n: null,
    targetRoute: `/internal/v1/tasks/surveys/${surveyId}/launch`,
    scheduleTime: localIso(new Date(launchAt)),
    status: 'scheduled',
    scheduleVersion: 1,
    queue: 'surveys-launch',
  };
  const reminders = Array.from({ length: opts.reminders ?? 2 }, (_, index): ScheduledTaskRecord => {
    const n = index + 1;
    return {
      taskName: `opt2-survey-${surveyId}-reminder-${String(n)}`,
      kind: 'survey-reminder',
      n,
      targetRoute: `/internal/v1/tasks/reminders/${reminderTaskId(surveyId, n)}`,
      scheduleTime: localIso(new Date(launchAt + n * 60 * MINUTE_MS)),
      status: 'scheduled',
      scheduleVersion: 1,
      queue: 'communications-reminders',
    };
  });
  return [launch, ...reminders];
}

/** Creates a {@link ClientRecorder}; throws TypeError for a `routes` key not shaped `'<service> <METHOD> <path>'`. */
export function createClientRecorder(handlers: ClientRecorderHandlers = {}): ClientRecorder {
  const requests: ServiceRequest[] = [];
  const configured: ClientRoute[] = [];
  let explicit: ClientRoute[] = [];
  let mode: { status: number } | 'unavailable' | undefined;
  let csrf = true;

  for (const [key, reply] of Object.entries(handlers.routes ?? {})) {
    const parsed = ROUTE_KEY.exec(key);
    if (parsed?.[1] === undefined || parsed[2] === undefined || parsed[3] === undefined) {
      throw new TypeError(`client route key must be '<service> <METHOD> <path>': ${key}`);
    }
    configured.push({ service: parsed[1], method: parsed[2], pattern: pathPattern(parsed[3]), reply });
  }
  const scheduledTasks = handlers.scheduledTasks ?? ((surveyId: string) => defaultScheduledTasks(surveyId));

  const matches = (route: ClientRoute, req: ServiceRequest): boolean =>
    route.service === req.service && route.method === req.method && route.pattern.test(pathOnly(req.path));

  function defaultReply(req: ServiceRequest): ServiceResponse | undefined {
    const path = pathOnly(req.path);
    if (req.service === IDENTITY_SERVICE && req.method === 'POST' && path === CSRF_CONSUME_PATH) {
      return { status: 200, headers: {}, body: { valid: csrf } };
    }
    const sourceId = queryParam(req, 'sourceId');
    if (
      req.service !== COMMUNICATIONS ||
      req.method !== 'GET' ||
      path !== SCHEDULED_TASKS_PATH ||
      queryParam(req, 'sourceType') !== 'survey' ||
      sourceId === undefined ||
      sourceId === ''
    ) {
      return undefined;
    }
    const items = scheduledTasks(sourceId);
    const versions = items.map((item) => item.scheduleVersion);
    const body: ScheduledTaskList = {
      sourceType: 'survey',
      sourceId,
      scheduleVersion: versions.length === 0 ? null : Math.max(...versions),
      items,
    };
    return { status: 200, headers: {}, body };
  }

  async function request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    requests.push({ ...req });
    const route = explicit.findLast((candidate) => matches(candidate, req)) ?? configured.findLast((candidate) => matches(candidate, req));
    if (route !== undefined) {
      return (typeof route.reply === 'function' ? await route.reply(req) : route.reply) as ServiceResponse<T>;
    }
    if (mode === 'unavailable') {
      throw new ServiceUnavailableError(req.service, Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    }
    if (mode !== undefined) {
      return { status: mode.status, headers: {}, body: JSON.parse(apiUnavailableResponse().body) as T };
    }
    const fallback = defaultReply(req);
    if (fallback === undefined) throw new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`);
    return fallback as ServiceResponse<T>;
  }

  return {
    requests,
    request,
    respond(service, method, path, reply) {
      explicit.push({ service, method, pattern: pathPattern(path), reply });
    },
    fail(status) {
      mode = { status };
    },
    unavailable() {
      mode = 'unavailable';
    },
    csrfValid(valid) {
      csrf = valid;
    },
    reset() {
      explicit = [];
      mode = undefined;
      csrf = true;
    },
    install(app) {
      Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
    },
  };
}

// Recording database: an in-memory interpreter of the SQL the surveys code and the platform issue against schema `surveys`.

/** A construct the recording database does not implement; surfaced as an unrecognised statement. */
class UnsupportedSql extends Error {
  override readonly name = 'UnsupportedSql';
}

function unsupported(what: string): never {
  throw new UnsupportedSql(what);
}

/** An Error shaped as node-postgres raises it, its SQLSTATE in `code`. */
function pgError(code: string, message: string): Error & { code: string; severity: string } {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

function unrecognised(sql: string, cause: unknown): Error {
  return new Error(`RecordingDb: unrecognised statement: ${sql}`, { cause });
}

type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'param' | 'op';

interface Token {
  kind: TokenKind;
  /** Lower-cased for words, verbatim otherwise. */
  value: string;
}

const OPERATORS = ['::', '<=', '>=', '<>', '!=', '&&', '||', '=>', '(', ')', ',', '.', ';', '=', '<', '>', '+', '-', '*', '/', '[', ']'];
const WORD_PATTERN = /[A-Za-z_][A-Za-z0-9_$]*/y;
const NUMBER_PATTERN = /\d+(?:\.\d+)?/y;
const PARAM_PATTERN = /\$(\d+)/y;

function stickyMatch(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) unsupported('an unterminated quote');
        const c = sql.charAt(j);
        if (c === ch) {
          if (sql.charAt(j + 1) !== ch) break;
          j += 1;
        }
        value += c;
        j += 1;
      }
      tokens.push({ kind: ch === "'" ? 'string' : 'quoted', value });
      i = j + 1;
      continue;
    }
    const param = stickyMatch(PARAM_PATTERN, sql, i);
    const number = param === null ? stickyMatch(NUMBER_PATTERN, sql, i) : null;
    const word = param === null && number === null ? stickyMatch(WORD_PATTERN, sql, i) : null;
    if (param !== null) tokens.push({ kind: 'param', value: param[1] as string });
    else if (number !== null) tokens.push({ kind: 'number', value: number[0] });
    else if (word !== null) tokens.push({ kind: 'word', value: word[0].toLowerCase() });
    const matched = param ?? number ?? word;
    if (matched !== null) {
      i += matched[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => sql.startsWith(candidate, i)) ?? unsupported(`character ${ch}`);
    tokens.push({ kind: 'op', value: op });
    i += op.length;
  }
  return tokens;
}

type Family = 'int8' | 'int4' | 'numeric' | 'float' | 'bool' | 'timestamp' | 'uuid' | 'json' | 'text';

/** A column or cast type: its value family and whether it is an array of that family. */
interface SqlType {
  family: Family;
  array: boolean;
}

const TYPE_FAMILIES: Readonly<Record<string, Family>> = {
  bigint: 'int8',
  int8: 'int8',
  bigserial: 'int8',
  serial8: 'int8',
  xid8: 'int8',
  integer: 'int4',
  int: 'int4',
  int4: 'int4',
  smallint: 'int4',
  int2: 'int4',
  serial: 'int4',
  numeric: 'numeric',
  decimal: 'numeric',
  real: 'float',
  float4: 'float',
  float8: 'float',
  boolean: 'bool',
  bool: 'bool',
  timestamp: 'timestamp',
  timestamptz: 'timestamp',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'json',
  text: 'text',
  varchar: 'text',
  char: 'text',
  bpchar: 'text',
  character: 'text',
  name: 'text',
  regclass: 'text',
};

type Expr =
  | { k: 'lit'; v: unknown }
  | { k: 'param'; i: number }
  | { k: 'col'; table?: string; name: string }
  | { k: 'default' }
  | { k: 'fn'; name: string; args: Expr[]; star: boolean; named: Record<string, Expr> }
  | { k: 'cast'; e: Expr; type: SqlType }
  | { k: 'not'; e: Expr }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'isnull'; e: Expr; not: boolean }
  | { k: 'istruth'; e: Expr; v: boolean; not: boolean }
  | { k: 'distinct'; l: Expr; r: Expr; not: boolean }
  | { k: 'in'; e: Expr; list: Expr[]; not: boolean }
  | { k: 'quantified'; op: string; l: Expr; r: Expr; all: boolean }
  | { k: 'row'; items: Expr[] }
  | { k: 'array'; items: Expr[] }
  | { k: 'sub'; q: SelectStmt };

type FnExpr = Extract<Expr, { k: 'fn' }>;

type SelectItem = { star: true; table?: string } | { star: false; e: Expr; alias?: string };

interface OrderItem {
  e: Expr;
  desc: boolean;
  nulls?: 'first' | 'last';
}

interface FromItem {
  source: { table: string } | { sub: SelectStmt };
  alias: string;
  on?: Expr;
}

interface Cte {
  name: string;
  q: SelectStmt;
}

interface SelectStmt {
  k: 'select';
  ctes: Cte[];
  distinct: boolean;
  items: SelectItem[];
  from: FromItem[];
  where?: Expr;
  groupBy: Expr[];
  orderBy: OrderItem[];
  limit?: Expr;
  offset?: Expr;
}

interface Assignment {
  column: string;
  e: Expr;
}

interface InsertStmt {
  k: 'insert';
  ctes: Cte[];
  table: string;
  alias?: string;
  columns?: string[];
  values?: Expr[][];
  select?: SelectStmt;
  conflict?: { target?: string[]; update?: { set: Assignment[]; where?: Expr } };
  returning: SelectItem[];
}

interface UpdateStmt {
  k: 'update';
  ctes: Cte[];
  table: string;
  alias: string;
  set: Assignment[];
  from: FromItem[];
  where?: Expr;
  returning: SelectItem[];
}

interface DeleteStmt {
  k: 'delete';
  ctes: Cte[];
  table: string;
  alias: string;
  where?: Expr;
  returning: SelectItem[];
}

type DataStmt = SelectStmt | InsertStmt | UpdateStmt | DeleteStmt;

type ControlStmt =
  | { k: 'begin' }
  | { k: 'commit' }
  | { k: 'rollback' }
  | { k: 'savepoint'; name: string }
  | { k: 'release'; name: string }
  | { k: 'rollback-to'; name: string };

/** A parsed statement and the catalog tables it names. */
interface Parsed {
  stmt: DataStmt | ControlStmt;
  tables: ReadonlySet<string>;
}

/** Unique key of a table: its primary key or a UNIQUE constraint. */
interface UniqueConstraint {
  columns: string[];
  nullsNotDistinct: boolean;
}

interface CatalogColumn {
  name: string;
  type: SqlType;
  notNull: boolean;
  identity: boolean;
  fallback?: Expr;
}

interface CatalogTable {
  name: string;
  columns: CatalogColumn[];
  columnNames: string[];
  constraints: UniqueConstraint[];
  /** False for the platform's non-tenant tables, which carry no RLS. */
  tenantOwned: boolean;
}

const RESERVED: ReadonlySet<string> = new Set([
  'select', 'from', 'where', 'group', 'order', 'by', 'limit', 'offset', 'for', 'join', 'inner', 'left', 'right', 'full',
  'cross', 'on', 'set', 'returning', 'values', 'union', 'having', 'and', 'or', 'not', 'as', 'is', 'in', 'null', 'true',
  'false', 'default', 'do', 'case', 'when', 'then', 'else', 'end', 'asc', 'desc', 'nulls', 'collate', 'into', 'with',
  'using', 'distinct', 'all', 'any', 'some', 'fetch', 'window', 'lateral',
]);

const COMPARISONS: ReadonlySet<string> = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);

/** Recursive-descent parser of the SQL subset; any other construct raises UnsupportedSql. */
class SqlParser {
  readonly tables = new Set<string>();

  constructor(
    private readonly tokens: readonly Token[],
    private readonly schema: string,
    private pos = 0,
  ) {}

  get position(): number {
    return this.pos;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isWord(word: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'word' && token.value === word;
  }

  private isOp(op: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'op' && token.value === op;
  }

  private acceptWord(...words: string[]): boolean {
    if (!words.every((word, i) => this.isWord(word, i))) return false;
    this.pos += words.length;
    return true;
  }

  private acceptOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.pos += 1;
    return true;
  }

  private here(): string {
    const token = this.peek();
    return token === undefined ? 'the end of the statement' : `${token.kind} ${token.value}`;
  }

  private expectWord(...words: string[]): void {
    if (!this.acceptWord(...words)) unsupported(`expected ${words.join(' ')} at ${this.here()}`);
  }

  private expectOp(op: string): void {
    if (!this.acceptOp(op)) unsupported(`expected ${op} at ${this.here()}`);
  }

  private identifier(): string {
    const token = this.peek();
    if (token?.kind !== 'word' && token?.kind !== 'quoted') return unsupported(`expected an identifier at ${this.here()}`);
    this.pos += 1;
    return token.value;
  }

  private list<T>(item: () => T): T[] {
    const items = [item()];
    while (this.acceptOp(',')) items.push(item());
    return items;
  }

  private parenthesized<T>(inner: () => T): T {
    this.expectOp('(');
    const value = inner();
    this.expectOp(')');
    return value;
  }

  private identifierList(): string[] {
    return this.parenthesized(() => this.list(() => this.identifier()));
  }

  private skipParenthesized(): void {
    this.expectOp('(');
    for (let depth = 1; depth > 0; this.pos += 1) {
      if (this.peek() === undefined) unsupported('unbalanced parentheses');
      if (this.isOp('(')) depth += 1;
      else if (this.isOp(')')) depth -= 1;
    }
  }

  private aliasIfAny(): string | undefined {
    if (this.acceptWord('as')) return this.identifier();
    const token = this.peek();
    if (token?.kind === 'quoted' || (token?.kind === 'word' && !RESERVED.has(token.value))) {
      this.pos += 1;
      return token.value;
    }
    return undefined;
  }

  /** A table name, bare or qualified by the recording schema; anything else is unsupported. */
  tableName(): string {
    const parts = [this.identifier()];
    while (this.acceptOp('.')) parts.push(this.identifier());
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== this.schema)) unsupported(`table ${parts.join('.')}`);
    const name = parts.at(-1) as string;
    this.tables.add(name);
    return name;
  }

  statement(): DataStmt | ControlStmt {
    const stmt = this.statementBody();
    this.acceptOp(';');
    if (this.pos < this.tokens.length) unsupported(`trailing ${this.here()}`);
    return stmt;
  }

  private statementBody(): DataStmt | ControlStmt {
    if (this.acceptWord('begin') || this.acceptWord('start', 'transaction')) {
      if (!this.acceptWord('transaction')) this.acceptWord('work');
      return { k: 'begin' };
    }
    if (this.acceptWord('commit') || this.acceptWord('end')) return { k: 'commit' };
    if (this.acceptWord('rollback')) {
      if (!this.acceptWord('transaction')) this.acceptWord('work');
      if (!this.acceptWord('to')) return { k: 'rollback' };
      this.acceptWord('savepoint');
      return { k: 'rollback-to', name: this.identifier() };
    }
    if (this.acceptWord('savepoint')) return { k: 'savepoint', name: this.identifier() };
    if (this.acceptWord('release')) {
      this.acceptWord('savepoint');
      return { k: 'release', name: this.identifier() };
    }
    const ctes: Cte[] = [];
    if (this.acceptWord('with')) {
      do {
        const name = this.identifier();
        this.expectWord('as');
        this.acceptWord('not');
        this.acceptWord('materialized');
        ctes.push({ name, q: this.parenthesized(() => this.select()) });
      } while (this.acceptOp(','));
    }
    const stmt: DataStmt = this.isWord('select')
      ? this.select()
      : this.isWord('insert')
        ? this.insert()
        : this.isWord('update')
          ? this.update()
          : this.isWord('delete')
            ? this.delete()
            : unsupported(`statement starting with ${this.here()}`);
    stmt.ctes = ctes;
    return stmt;
  }

  private select(): SelectStmt {
    this.expectWord('select');
    const distinct = this.acceptWord('distinct');
    const items = this.list(() => this.selectItem());
    const from = this.acceptWord('from') ? this.fromList() : [];
    const where = this.acceptWord('where') ? this.expr() : undefined;
    const groupBy = this.acceptWord('group', 'by') ? this.list(() => this.expr()) : [];
    const orderBy = this.acceptWord('order', 'by') ? this.list(() => this.orderItem()) : [];
    let limit: Expr | undefined;
    let offset: Expr | undefined;
    for (;;) {
      if (this.acceptWord('limit')) {
        limit = this.acceptWord('all') ? undefined : this.expr();
      } else if (this.acceptWord('offset')) {
        offset = this.expr();
        if (!this.acceptWord('rows')) this.acceptWord('row');
      } else {
        break;
      }
    }
    while (this.acceptWord('for')) this.lockClause();
    return { k: 'select', ctes: [], distinct, items, from, where, groupBy, orderBy, limit, offset };
  }

  // Row locks are accepted and ignored: every transaction runs in this process, and gate waits poll on their own.
  private lockClause(): void {
    const strength =
      this.acceptWord('update') || this.acceptWord('share') || this.acceptWord('no', 'key', 'update') || this.acceptWord('key', 'share');
    if (!strength) unsupported(`lock clause at ${this.here()}`);
    if (this.acceptWord('of')) this.list(() => this.identifier());
    if (!this.acceptWord('nowait')) this.acceptWord('skip', 'locked');
  }

  private selectItem(): SelectItem {
    if (this.acceptOp('*')) return { star: true };
    const token = this.peek();
    if ((token?.kind === 'word' || token?.kind === 'quoted') && this.isOp('.', 1) && this.isOp('*', 2)) {
      this.pos += 3;
      return { star: true, table: token.value };
    }
    const e = this.expr();
    const alias = this.aliasIfAny();
    return alias === undefined ? { star: false, e } : { star: false, e, alias };
  }

  private orderItem(): OrderItem {
    const e = this.expr();
    const desc = this.acceptWord('desc');
    if (!desc) this.acceptWord('asc');
    if (this.acceptWord('nulls', 'first')) return { e, desc, nulls: 'first' };
    if (this.acceptWord('nulls', 'last')) return { e, desc, nulls: 'last' };
    return { e, desc };
  }

  private fromList(): FromItem[] {
    const items = [this.fromItem()];
    for (;;) {
      if (this.acceptOp(',')) {
        items.push(this.fromItem());
      } else if (this.acceptWord('join') || this.acceptWord('inner', 'join')) {
        const item = this.fromItem();
        this.expectWord('on');
        items.push({ ...item, on: this.expr() });
      } else if (['left', 'right', 'full', 'cross', 'natural'].some((word) => this.isWord(word))) {
        unsupported('outer, cross and natural joins');
      } else {
        return items;
      }
    }
  }

  private fromItem(): FromItem {
    if (this.isOp('(')) {
      const sub = this.parenthesized(() => this.select());
      return { source: { sub }, alias: this.aliasIfAny() ?? unsupported('a FROM subquery without an alias') };
    }
    const table = this.tableName();
    return { source: { table }, alias: this.aliasIfAny() ?? table };
  }

  private returning(): SelectItem[] {
    return this.acceptWord('returning') ? this.list(() => this.selectItem()) : [];
  }

  private valueExpr(): Expr {
    return this.acceptWord('default') ? { k: 'default' } : this.expr();
  }

  private assignment(): Assignment {
    const column = this.identifier();
    this.expectOp('=');
    return { column, e: this.valueExpr() };
  }

  private insert(): InsertStmt {
    this.expectWord('insert', 'into');
    const table = this.tableName();
    const alias = this.acceptWord('as') ? this.identifier() : undefined;
    const columns = this.isOp('(') ? this.identifierList() : undefined;
    const stmt: InsertStmt = { k: 'insert', ctes: [], table, returning: [] };
    if (alias !== undefined) stmt.alias = alias;
    if (columns !== undefined) stmt.columns = columns;
    if (this.acceptWord('default', 'values')) stmt.values = [[]];
    else if (this.acceptWord('values')) stmt.values = this.list(() => this.parenthesized(() => this.list(() => this.valueExpr())));
    else if (this.isWord('select')) stmt.select = this.select();
    else unsupported(`INSERT source at ${this.here()}`);
    if (this.acceptWord('on', 'conflict')) {
      const target = this.isOp('(') ? this.identifierList() : undefined;
      if (this.isWord('on')) unsupported('ON CONFLICT ON CONSTRAINT');
      this.expectWord('do');
      if (this.acceptWord('nothing')) {
        stmt.conflict = target === undefined ? {} : { target };
      } else {
        this.expectWord('update', 'set');
        const set = this.list(() => this.assignment());
        const where = this.acceptWord('where') ? this.expr() : undefined;
        stmt.conflict = { ...(target === undefined ? {} : { target }), update: where === undefined ? { set } : { set, where } };
      }
    }
    stmt.returning = this.returning();
    return stmt;
  }

  private update(): UpdateStmt {
    this.expectWord('update');
    const table = this.tableName();
    const alias = this.aliasIfAny() ?? table;
    this.expectWord('set');
    const set = this.list(() => this.assignment());
    const from = this.acceptWord('from') ? this.fromList() : [];
    const where = this.acceptWord('where') ? this.expr() : undefined;
    return { k: 'update', ctes: [], table, alias, set, from, where, returning: this.returning() };
  }

  private delete(): DeleteStmt {
    this.expectWord('delete', 'from');
    const table = this.tableName();
    const alias = this.aliasIfAny() ?? table;
    const where = this.acceptWord('where') ? this.expr() : undefined;
    return { k: 'delete', ctes: [], table, alias, where, returning: this.returning() };
  }

  expr(): Expr {
    let left = this.and();
    while (this.acceptWord('or')) left = { k: 'bin', op: 'or', l: left, r: this.and() };
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.acceptWord('and')) left = { k: 'bin', op: 'and', l: left, r: this.not() };
    return left;
  }

  private not(): Expr {
    return this.acceptWord('not') ? { k: 'not', e: this.not() } : this.is();
  }

  private is(): Expr {
    let e = this.comparison();
    while (this.acceptWord('is')) {
      const not = this.acceptWord('not');
      if (this.acceptWord('null')) e = { k: 'isnull', e, not };
      else if (this.acceptWord('true')) e = { k: 'istruth', e, v: true, not };
      else if (this.acceptWord('false')) e = { k: 'istruth', e, v: false, not };
      else {
        this.expectWord('distinct', 'from');
        e = { k: 'distinct', l: e, r: this.comparison(), not };
      }
    }
    return e;
  }

  private comparison(): Expr {
    const l = this.membership();
    const token = this.peek();
    if (token?.kind !== 'op' || !COMPARISONS.has(token.value)) return l;
    this.pos += 1;
    const op = token.value === '!=' ? '<>' : token.value;
    if ((this.isWord('any') || this.isWord('some') || this.isWord('all')) && this.isOp('(', 1)) {
      const all = this.isWord('all');
      this.pos += 1;
      if (this.isOp('(') && this.isWord('select', 1)) unsupported('ANY or ALL over a subquery');
      return { k: 'quantified', op, l, r: this.parenthesized(() => this.expr()), all };
    }
    return { k: 'bin', op, l, r: this.membership() };
  }

  private membership(): Expr {
    const e = this.other();
    const not = this.isWord('not') && this.isWord('in', 1);
    if (not) this.pos += 1;
    if (!this.acceptWord('in')) return e;
    if (this.isOp('(') && this.isWord('select', 1)) unsupported('IN over a subquery');
    return { k: 'in', e, list: this.parenthesized(() => this.list(() => this.expr())), not };
  }

  private binaryLoop(ops: readonly string[], next: () => Expr): Expr {
    let left = next();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || !ops.includes(token.value)) return left;
      this.pos += 1;
      left = { k: 'bin', op: token.value, l: left, r: next() };
    }
  }

  private other(): Expr {
    return this.binaryLoop(['&&', '||'], () => this.additive());
  }

  private additive(): Expr {
    return this.binaryLoop(['+', '-'], () => this.multiplicative());
  }

  private multiplicative(): Expr {
    return this.binaryLoop(['*', '/'], () => this.unary());
  }

  private unary(): Expr {
    if (this.acceptOp('-')) return { k: 'neg', e: this.unary() };
    this.acceptOp('+');
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.acceptOp('::')) e = { k: 'cast', e, type: this.sqlType() };
      else if (this.acceptWord('collate')) this.identifier();
      else if (this.isOp('[')) unsupported('array subscripts');
      else return e;
    }
  }

  /** A type name with its precision, zone and array suffixes. */
  sqlType(): SqlType {
    let name = this.identifier();
    if (name === 'double' && this.acceptWord('precision')) name = 'float8';
    if (name === 'character' && this.acceptWord('varying')) name = 'varchar';
    if (this.isOp('(')) this.parenthesized(() => this.list(() => this.expr()));
    if (!this.acceptWord('without', 'time', 'zone')) this.acceptWord('with', 'time', 'zone');
    let array = false;
    while (this.acceptOp('[')) {
      this.expectOp(']');
      array = true;
    }
    const family = TYPE_FAMILIES[name] ?? unsupported(`type ${name}`);
    return { family, array };
  }

  private primary(): Expr {
    const token = this.peek() ?? unsupported('an expression at the end of the statement');
    this.pos += 1;
    switch (token.kind) {
      case 'param':
        return { k: 'param', i: Number(token.value) };
      case 'number':
        return { k: 'lit', v: Number(token.value) };
      case 'string':
        return { k: 'lit', v: token.value };
      case 'quoted':
        return this.columnRef(token.value);
      case 'word':
        return this.wordExpr(token.value);
      case 'op': {
        if (token.value !== '(') return unsupported(`operator ${token.value}`);
        if (this.isWord('select')) {
          const q = this.select();
          this.expectOp(')');
          return { k: 'sub', q };
        }
        const items = this.list(() => this.expr());
        this.expectOp(')');
        return items.length === 1 ? (items[0] as Expr) : { k: 'row', items };
      }
    }
  }

  private wordExpr(word: string): Expr {
    switch (word) {
      case 'null':
        return { k: 'lit', v: null };
      case 'true':
      case 'false':
        return { k: 'lit', v: word === 'true' };
      case 'array': {
        this.expectOp('[');
        const items = this.isOp(']') ? [] : this.list(() => this.expr());
        this.expectOp(']');
        return { k: 'array', items };
      }
      case 'localtimestamp':
      case 'current_timestamp':
        if (this.isOp('(')) this.parenthesized(() => this.expr());
        return { k: 'fn', name: word, args: [], star: false, named: {} };
      default:
        break;
    }
    if (word === 'row' && this.isOp('(')) return { k: 'row', items: this.parenthesized(() => this.list(() => this.expr())) };
    if (RESERVED.has(word) || ['case', 'exists', 'interval', 'cast'].includes(word)) unsupported(`keyword ${word} in an expression`);
    return this.isOp('(') ? this.call(word) : this.columnRef(word);
  }

  private columnRef(first: string): Expr {
    const parts = [first];
    while (this.isOp('.') && (this.peek(1)?.kind === 'word' || this.peek(1)?.kind === 'quoted')) {
      this.pos += 1;
      parts.push(this.identifier());
    }
    if (parts.length > 3) unsupported(`column reference ${parts.join('.')}`);
    const name = parts.at(-1) as string;
    return parts.length === 1 ? { k: 'col', name } : { k: 'col', table: parts.at(-2) as string, name };
  }

  private call(name: string): Expr {
    this.expectOp('(');
    if (this.acceptOp('*')) {
      this.expectOp(')');
      return { k: 'fn', name, args: [], star: true, named: {} };
    }
    const args: Expr[] = [];
    const named: Record<string, Expr> = {};
    if (!this.acceptOp(')')) {
      if (this.isWord('distinct')) unsupported(`${name}(DISTINCT …)`);
      do {
        const token = this.peek();
        if (token?.kind === 'word' && this.isOp('=>', 1)) {
          this.pos += 2;
          named[token.value] = this.expr();
        } else {
          args.push(this.expr());
        }
      } while (this.acceptOp(','));
      this.expectOp(')');
    }
    return { k: 'fn', name, args, star: false, named };
  }

  /** The column and constraint list of a `CREATE TABLE … (` body, read through its closing parenthesis. */
  tableBody(name: string): CatalogTable {
    const columns: CatalogColumn[] = [];
    const constraints: UniqueConstraint[] = [];
    do {
      if (this.acceptWord('primary', 'key')) {
        constraints.push({ columns: this.identifierList(), nullsNotDistinct: false });
      } else if (this.acceptWord('unique')) {
        const nullsNotDistinct = this.acceptWord('nulls', 'not', 'distinct');
        if (!nullsNotDistinct) this.acceptWord('nulls', 'distinct');
        constraints.push({ columns: this.identifierList(), nullsNotDistinct });
      } else if (this.acceptWord('check')) {
        this.skipParenthesized();
      } else {
        columns.push(this.columnDefinition(constraints));
      }
    } while (this.acceptOp(','));
    this.expectOp(')');
    return {
      name,
      columns,
      columnNames: columns.map((column) => column.name),
      constraints,
      tenantOwned: !(NON_TENANT_TABLES as readonly string[]).includes(name),
    };
  }

  private columnDefinition(constraints: UniqueConstraint[]): CatalogColumn {
    const name = this.identifier();
    const serial = this.isWord('bigserial') || this.isWord('serial') || this.isWord('serial8');
    const column: CatalogColumn = { name, type: this.sqlType(), notNull: serial, identity: serial };
    for (;;) {
      if (this.acceptWord('not', 'null')) column.notNull = true;
      else if (this.acceptWord('null')) column.notNull = false;
      else if (this.acceptWord('default')) column.fallback = this.expr();
      else if (this.acceptWord('primary', 'key')) {
        column.notNull = true;
        constraints.push({ columns: [name], nullsNotDistinct: false });
      } else if (this.acceptWord('unique')) constraints.push({ columns: [name], nullsNotDistinct: false });
      else if (this.acceptWord('check')) this.skipParenthesized();
      else if (this.acceptWord('generated')) {
        while (!this.acceptWord('identity')) this.identifier();
        column.identity = true;
        column.notNull = true;
      } else return column;
    }
  }
}

/** Tables of every `CREATE TABLE <schema>.<name>` in `ddl`. */
function parseCreateTables(ddl: string, schema: string): CatalogTable[] {
  const tokens = tokenize(ddl);
  const tables: CatalogTable[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token?.kind !== 'word' || token.value !== 'create' || next?.kind !== 'word' || next.value !== 'table') continue;
    const parser = new SqlParser(tokens, schema, i + 2);
    const name = parser.tableName();
    const open = tokens[parser.position];
    if (open?.kind !== 'op' || open.value !== '(') unsupported(`CREATE TABLE ${name} without a column list`);
    const reader = new SqlParser(tokens, schema, parser.position + 1);
    tables.push(reader.tableBody(name));
    i = reader.position - 1;
  }
  return tables;
}

let catalogCache: ReadonlyMap<string, CatalogTable> | undefined;

/** Tables of schema `surveys` as the service's own migrations create them, read once per process. */
function surveysCatalog(): ReadonlyMap<string, CatalogTable> {
  if (catalogCache === undefined) {
    const dir = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
    const ddl = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');
    catalogCache = new Map(parseCreateTables(ddl, SCHEMA).map((table) => [table.name, table]));
  }
  return catalogCache;
}


/** A `make_interval` or timestamp-difference value. */
class Interval {
  constructor(readonly ms: number) {}
}

/** A row constructor `(a, b, …)`, compared column by column. */
class RowValue {
  constructor(readonly values: readonly unknown[]) {}
}

/** Result of `unnest`, expanded into one output row per element. */
class SetReturning {
  constructor(readonly values: readonly unknown[]) {}
}

/** `pg_current_snapshot()`: the oldest running xid and the next xid to assign. */
class Snapshot {
  constructor(
    readonly xmin: bigint,
    readonly xmax: bigint,
  ) {}
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const NUMERIC_TEXT = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/;
const TIMESTAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const INT4_MAX = 2_147_483_647;
const TRUE_TEXT: ReadonlySet<string> = new Set(['t', 'true', 'y', 'yes', 'on', '1']);
const FALSE_TEXT: ReadonlySet<string> = new Set(['f', 'false', 'n', 'no', 'off', '0']);

function invalidInput(type: string, value: unknown): Error {
  return pgError('22P02', `invalid input syntax for type ${type}: "${String(value)}"`);
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && INTEGER_TEXT.test(value)) return BigInt(value.trim());
  throw invalidInput('bigint', value);
}

function toInteger(value: unknown): number {
  const result = typeof value === 'number' ? Math.round(value) : Number(toBigInt(value));
  if (Math.abs(result) > INT4_MAX) throw pgError('22003', 'integer out of range');
  return result;
}

/** A number or bigint for arithmetic and comparison; integer text becomes a bigint. */
function toNumeric(value: unknown): number | bigint {
  if (typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'string' && INTEGER_TEXT.test(value)) return BigInt(value.trim());
  if (typeof value === 'string' && NUMERIC_TEXT.test(value)) return Number(value);
  throw invalidInput('numeric', value);
}

/** Three-valued truth of a value: null stays unknown. */
function toBool3(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (TRUE_TEXT.has(text)) return true;
  if (FALSE_TEXT.has(text)) return false;
  throw invalidInput('boolean', value);
}

function isTrue(value: unknown): boolean {
  return toBool3(value) === true;
}

/** A `timestamp without time zone` value as a Date in the process zone; an offset in text is ignored, as PostgreSQL ignores it. */
function toTimestamp(value: unknown): Date {
  if (value instanceof Date) return new Date(value.getTime());
  const match = typeof value === 'string' ? TIMESTAMP_TEXT.exec(value.trim()) : null;
  if (match === null) throw pgError('22007', `invalid input syntax for type timestamp: "${String(value)}"`);
  const [, year, month, day, hours, minutes, seconds, fraction] = match;
  const ms = fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000);
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hours ?? 0), Number(minutes ?? 0), Number(seconds ?? 0), ms);
}

/** PostgreSQL's text output of a timestamp: seconds, then fractional digits without trailing zeros. */
function timestampText(date: Date): string {
  const base =
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const ms = date.getMilliseconds();
  return ms === 0 ? base : `${base}.${pad(ms, 3).replace(/0+$/, '')}`;
}

function arrayElementText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  const text = toText(value);
  return text === '' || text.toUpperCase() === 'NULL' || /[{},"\\\s]/.test(text) ? `"${text.replace(/["\\]/g, '\\$&')}"` : text;
}

/** The `::text` form of a value. */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return timestampText(value);
  if (Array.isArray(value)) return `{${value.map(arrayElementText).join(',')}}`;
  if (value instanceof RowValue) return `(${value.values.map((item) => (item === null ? '' : toText(item))).join(',')})`;
  if (value instanceof Interval) return `${String(value.ms / 1000)} seconds`;
  if (value instanceof Snapshot) return `${String(value.xmin)}:${String(value.xmax)}:`;
  return JSON.stringify(value);
}

/** Elements of a `{a,"b c",NULL}` array literal. */
function parseArrayLiteral(text: string): (string | null)[] {
  const body = text.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) throw pgError('22P02', `malformed array literal: "${text}"`);
  const inner = body.slice(1, -1);
  if (inner.trim() === '') return [];
  const items: (string | null)[] = [];
  let current = '';
  let quoted = false;
  let wasQuoted = false;
  const push = (): void => {
    items.push(wasQuoted ? current : current.trim().toUpperCase() === 'NULL' ? null : current.trim());
    current = '';
    wasQuoted = false;
  };
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner.charAt(i);
    if (quoted && ch === '\\') {
      i += 1;
      current += inner.charAt(i);
    } else if (ch === '"') {
      quoted = !quoted;
      wasQuoted = true;
    } else if (ch === ',' && !quoted) {
      push();
    } else {
      current += ch;
    }
  }
  push();
  return items;
}

function castScalar(value: unknown, family: Family): unknown {
  if (value === null || value === undefined) return null;
  switch (family) {
    case 'int8':
      return toBigInt(value);
    case 'int4':
      return toInteger(value);
    case 'numeric':
      if (typeof value === 'string' && !NUMERIC_TEXT.test(value)) throw invalidInput('numeric', value);
      return toText(value).trim();
    case 'float':
      return Number(toNumeric(value));
    case 'bool':
      return toBool3(value);
    case 'timestamp':
      return toTimestamp(value);
    case 'uuid': {
      const text = toText(value).trim();
      if (!UUID_TEXT.test(text)) throw invalidInput('uuid', value);
      return text.toLowerCase();
    }
    case 'json':
      if (typeof value !== 'string') return structuredClone(value);
      try {
        return JSON.parse(value) as unknown;
      } catch {
        throw invalidInput('json', value);
      }
    case 'text':
      return toText(value);
  }
}

/** `value` converted to `type`, as a cast or a column assignment converts it. */
function castValue(value: unknown, type: SqlType): unknown {
  if (value === null || value === undefined) return null;
  if (!type.array) return castScalar(value, type.family);
  const items: readonly unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? parseArrayLiteral(value) : [value];
  return items.map((item) => castScalar(item, type.family));
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Ordering of two values; null when either is NULL. Rows compare column by column, arrays with NULL elements last. */
function compareValues(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof RowValue && b instanceof RowValue) {
    for (let i = 0; i < Math.min(a.values.length, b.values.length); i += 1) {
      const c = compareValues(a.values[i], b.values[i]);
      if (c !== 0) return c;
    }
    return sign(a.values.length - b.values.length);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const [x, y] = [a[i] ?? null, b[i] ?? null];
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1;
        continue;
      }
      const c = compareValues(x, y) ?? 0;
      if (c !== 0) return c;
    }
    return sign(a.length - b.length);
  }
  if (a instanceof Interval && b instanceof Interval) return sign(a.ms - b.ms);
  if (a instanceof Date || b instanceof Date) return sign(toTimestamp(a).getTime() - toTimestamp(b).getTime());
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const [x, y] = [toBool3(a), toBool3(b)];
    return x === y ? 0 : x === true ? 1 : -1;
  }
  if (typeof a === 'number' || typeof a === 'bigint' || typeof b === 'number' || typeof b === 'bigint') {
    const [x, y] = [toNumeric(a), toNumeric(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    // uuid values compare case-insensitively; other text by code point, as COLLATE "C" does.
    const [x, y] = UUID_TEXT.test(a) && UUID_TEXT.test(b) ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return unsupported(`comparing ${typeof a} with ${typeof b}`);
}

function notDistinct(a: unknown, b: unknown): boolean {
  if (a instanceof RowValue && b instanceof RowValue) {
    return a.values.length === b.values.length && a.values.every((value, i) => notDistinct(value ?? null, b.values[i] ?? null));
  }
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return compareValues(a, b) === 0;
}

function keyEqual(a: unknown, b: unknown): boolean {
  return a === null || b === null ? a === b : compareValues(a, b) === 0;
}

function compareOp(op: string, c: number): boolean {
  switch (op) {
    case '=':
      return c === 0;
    case '<>':
      return c !== 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    default:
      return c >= 0;
  }
}

function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return parseArrayLiteral(value);
  return unsupported(`an array operand of type ${typeof value}`);
}

function arithmetic(op: string, l: unknown, r: unknown): unknown {
  if (l instanceof Date && r instanceof Interval) return new Date(l.getTime() + (op === '-' ? -r.ms : r.ms));
  if (l instanceof Interval && r instanceof Date && op === '+') return new Date(r.getTime() + l.ms);
  if (l instanceof Date && r instanceof Date && op === '-') return new Interval(l.getTime() - r.getTime());
  if (l instanceof Interval && r instanceof Interval) return new Interval(op === '-' ? l.ms - r.ms : l.ms + r.ms);
  const [x, y] = [toNumeric(l), toNumeric(r)];
  if (op === '/' && Number(y) === 0) throw pgError('22012', 'division by zero');
  const integral = (n: number | bigint): boolean => typeof n === 'bigint' || Number.isInteger(n);
  if ((typeof x === 'bigint' || typeof y === 'bigint') && integral(x) && integral(y)) {
    const [p, q] = [BigInt(x), BigInt(y)];
    return op === '+' ? p + q : op === '-' ? p - q : op === '*' ? p * q : p / q;
  }
  const [p, q] = [Number(x), Number(y)];
  if (op === '/') return Number.isInteger(p) && Number.isInteger(q) ? Math.trunc(p / q) : p / q;
  return op === '+' ? p + q : op === '-' ? p - q : p * q;
}

/** A binary operator other than AND and OR applied to evaluated operands. */
function applyOperator(op: string, l: unknown, r: unknown): unknown {
  if (COMPARISONS.has(op)) {
    const c = compareValues(l, r);
    return c === null ? null : compareOp(op, c);
  }
  if (l === null || l === undefined || r === null || r === undefined) return null;
  if (op === '||') return Array.isArray(l) || Array.isArray(r) ? [...asArray(l), ...asArray(r)] : toText(l) + toText(r);
  if (op === '&&') {
    const right = asArray(r);
    return asArray(l).some((x) => right.some((y) => compareValues(x, y) === 0));
  }
  return arithmetic(op, l, r);
}

const TO_CHAR_PATTERNS: readonly (readonly [string, (date: Date) => string])[] = [
  ['YYYY', (date) => pad(date.getFullYear(), 4)],
  ['HH24', (date) => pad(date.getHours())],
  ['HH12', (date) => pad(((date.getHours() + 11) % 12) + 1)],
  ['HH', (date) => pad(((date.getHours() + 11) % 12) + 1)],
  ['MM', (date) => pad(date.getMonth() + 1)],
  ['MI', (date) => pad(date.getMinutes())],
  ['MS', (date) => pad(date.getMilliseconds(), 3)],
  ['US', (date) => pad(date.getMilliseconds() * 1000, 6)],
  ['DD', (date) => pad(date.getDate())],
  ['SS', (date) => pad(date.getSeconds())],
];

/** `to_char(timestamp, format)` for the date and time patterns the platform formats with. */
function toChar(date: Date, format: string): string {
  let out = '';
  for (let i = 0; i < format.length; ) {
    if (format.charAt(i) === '"') {
      const end = format.indexOf('"', i + 1);
      out += format.slice(i + 1, end === -1 ? format.length : end);
      i = end === -1 ? format.length : end + 1;
      continue;
    }
    const pattern = TO_CHAR_PATTERNS.find(([name]) => format.startsWith(name, i));
    if (pattern === undefined) {
      out += format.charAt(i);
      i += 1;
    } else {
      out += pattern[1](date);
      i += pattern[0].length;
    }
  }
  return out;
}

function trimChars(text: string, chars: string, side: 'rtrim' | 'ltrim' | 'btrim'): string {
  const set = new Set([...chars]);
  const codepoints = [...text];
  let start = 0;
  let end = codepoints.length;
  if (side !== 'rtrim') while (start < end && set.has(codepoints[start] as string)) start += 1;
  if (side !== 'ltrim') while (end > start && set.has(codepoints[end - 1] as string)) end -= 1;
  return codepoints.slice(start, end).join('');
}

function translate(text: string, from: string, to: string): string {
  const source = [...from];
  const target = [...to];
  return [...text]
    .map((ch) => {
      const index = source.indexOf(ch);
      return index === -1 ? ch : (target[index] ?? '');
    })
    .join('');
}

/** Text key of a value tuple, for GROUP BY and DISTINCT. */
function keyText(values: readonly unknown[]): string {
  return JSON.stringify(
    values.map((value) =>
      value === null || value === undefined
        ? null
        : typeof value === 'bigint'
          ? `n${String(value)}`
          : value instanceof Date
            ? `t${String(value.getTime())}`
            : typeof value === 'string'
              ? `s${value}`
              : value,
    ),
  );
}

/** A stored value as node-postgres returns it: int8 as text, a fresh Date per timestamp, jsonb parsed. */
function toWire(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(toWire);
  if (value instanceof RowValue || value instanceof Interval || value instanceof Snapshot) return toText(value);
  if (value !== null && typeof value === 'object') return structuredClone(value);
  return value;
}

const AGGREGATES: ReadonlySet<string> = new Set(['count', 'max', 'min', 'sum', 'bool_or', 'bool_and']);

function hasAggregate(e: Expr): boolean {
  switch (e.k) {
    case 'fn':
      return AGGREGATES.has(e.name) || e.args.some(hasAggregate) || Object.values(e.named).some(hasAggregate);
    case 'cast':
    case 'not':
    case 'neg':
    case 'isnull':
    case 'istruth':
      return hasAggregate(e.e);
    case 'bin':
    case 'distinct':
    case 'quantified':
      return hasAggregate(e.l) || hasAggregate(e.r);
    case 'in':
      return hasAggregate(e.e) || e.list.some(hasAggregate);
    case 'row':
    case 'array':
      return e.items.some(hasAggregate);
    default:
      return false;
  }
}

/** Output name PostgreSQL gives an unaliased select expression. */
function derivedName(e: Expr): string {
  if (e.k === 'col' || e.k === 'fn') return e.name;
  if (e.k === 'cast' && (e.e.k === 'col' || e.e.k === 'fn')) return e.e.name;
  return '?column?';
}

function isTenantSetting(stmt: DataStmt): boolean {
  if (stmt.k !== 'select' || stmt.from.length > 0 || stmt.items.length !== 1) return false;
  const [item] = stmt.items;
  if (item === undefined || item.star || item.e.k !== 'fn' || item.e.name !== 'set_config') return false;
  const [name] = item.e.args;
  return name?.k === 'lit' && name.v === TENANT_SETTING;
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}


type Row = Record<string, unknown>;

/** One FROM entry bound to one of its rows; `table` is the catalog or CTE name, absent for a subquery. */
interface Binding {
  alias: string;
  table?: string;
  columns: readonly string[];
  row: Row;
}

/** Rows of a FROM entry, a CTE or a statement target. */
interface Source {
  alias: string;
  table?: string;
  columns: readonly string[];
  rows: Row[];
}

/** A statement's output columns and value tuples, before wire conversion. */
interface Output {
  columns: string[];
  rows: unknown[][];
}

interface Mutation extends Output {
  command: string;
  rowCount: number;
}

interface Scope {
  session: Session;
  params: readonly unknown[];
  ctes: Map<string, Source>;
  bindings: readonly Binding[];
  /** Rows of the current group, for aggregates. */
  group?: readonly Scope[];
  /** Enclosing row scope of a subquery. */
  outer?: Scope;
}

interface Projected {
  scope: Scope;
  values: unknown[];
}

type Undo =
  | { kind: 'insert'; table: string; row: Row }
  | { kind: 'update'; row: Row; before: Row }
  | { kind: 'delete'; table: string; row: Row; index: number };

/** One statement of a recorded transaction: its whitespace-collapsed SQL and bound values. */
export interface RecordedStatement {
  text: string;
  values: unknown[];
}

/** One transaction: `tenantId` is its `app.tenant_id`, null for a metadata transaction or a statement run outside a transaction. */
export interface RecordedTransaction {
  tenantId: string | null;
  /** Every statement after BEGIN except COMMIT, ROLLBACK and the tenant `set_config`. */
  statements: RecordedStatement[];
  committed: boolean;
}

/** One pooled connection and its open transaction. */
interface Session {
  inTransaction: boolean;
  aborted: boolean;
  xid: bigint | undefined;
  /** Transaction-local `set_config` values. */
  settings: Map<string, string>;
  undo: Undo[];
  savepoints: { name: string; mark: number }[];
  log: RecordedTransaction | undefined;
}

type FieldDef = QueryResult['fields'][number];

const FIRST_XID = 1000n;
const DEFAULT_GATE_HOLDER = 'recording-db';
const SETTING_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ['lock_timeout', '0'],
  ['statement_timeout', '0'],
]);
const DEFAULT_VALUE: unique symbol = Symbol('DEFAULT');

function child(parent: Scope, bindings: readonly Binding[]): Scope {
  return { session: parent.session, params: parent.params, ctes: parent.ctes, bindings, outer: parent };
}

function bindingOf(source: Source, row: Row): Binding {
  return source.table === undefined
    ? { alias: source.alias, columns: source.columns, row }
    : { alias: source.alias, table: source.table, columns: source.columns, row };
}

function sourceOf(table: CatalogTable, alias: string, rows: Row[] = []): Source {
  return { alias, table: table.name, columns: table.columnNames, rows };
}

function starBindings(bindings: readonly Binding[], table: string | undefined): readonly Binding[] {
  if (table === undefined) return bindings;
  const found = bindings.find((binding) => binding.alias === table) ?? bindings.find((binding) => binding.table === table);
  return found === undefined ? unsupported(`${table}.*`) : [found];
}

function outputColumns(items: readonly SelectItem[], sources: readonly Source[]): string[] {
  return items.flatMap((item) => {
    if (!item.star) return [item.alias ?? derivedName(item.e)];
    if (item.table === undefined) return sources.flatMap((source) => source.columns);
    const found = sources.find((source) => source.alias === item.table) ?? sources.find((source) => source.table === item.table);
    return found === undefined ? unsupported(`${item.table}.*`) : [...found.columns];
  });
}

function relationOf(output: Output, alias: string): Source {
  return {
    alias,
    columns: output.columns,
    rows: output.rows.map((values) => Object.fromEntries(output.columns.map((column, i) => [column, values[i] ?? null]))),
  };
}

function expandSetReturning(outputs: readonly Projected[]): Projected[] {
  return outputs.flatMap((output) => {
    const sets = output.values.filter((value): value is SetReturning => value instanceof SetReturning);
    if (sets.length === 0) return [output];
    const length = Math.max(...sets.map((set) => set.values.length));
    return Array.from({ length }, (_, i) => ({
      scope: output.scope,
      values: output.values.map((value) => (value instanceof SetReturning ? (value.values[i] ?? null) : value)),
    }));
  });
}

function sortCompare(a: unknown, b: unknown, item: OrderItem): number {
  const nullsFirst = item.nulls === undefined ? item.desc : item.nulls === 'first';
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : nullsFirst ? -1 : 1;
  if (b === null || b === undefined) return nullsFirst ? 1 : -1;
  const c = compareValues(a, b) ?? 0;
  return item.desc ? -c : c;
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((column) => b.includes(column));
}

function uniqueViolation(table: CatalogTable, constraint: UniqueConstraint): Error {
  return pgError('23505', `duplicate key value violates unique constraint "${table.name}_${constraint.columns.join('_')}_key"`);
}

function aborted(): Error {
  return pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
}

function commandResult(command: string): QueryResult {
  return { command, rowCount: null, oid: 0, fields: [], rows: [] };
}

function fieldOf(name: string): FieldDef {
  return { name, tableID: 0, columnID: 0, dataTypeID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' };
}

/** Comma-separated or array content pool ids, trimmed and de-duplicated ignoring case; an empty list is the site itself. */
function contentPoolOf(value: SiteChangedPayload['contentPoolIds'], siteId: string): string[] {
  const items = value === undefined || value === null ? [] : typeof value === 'string' ? value.split(',') : value;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of items) {
    const id = item.trim();
    if (id !== '' && !seen.has(id.toLowerCase())) {
      seen.add(id.toLowerCase());
      ids.push(id);
    }
  }
  return ids.length > 0 ? ids : [siteId];
}

/** Tables, transactions and the interpreter behind a {@link RecordingDb}. */
class RecordingEngine {
  readonly transactions: RecordedTransaction[] = [];
  ended = false;
  private readonly tables = new Map<string, Row[]>();
  private readonly sequences = new Map<string, bigint>();
  private readonly openXids = new Set<bigint>();
  private readonly parsed = new Map<string, Parsed>();
  private nextXid = FIRST_XID;

  constructor(
    private readonly catalog: ReadonlyMap<string, CatalogTable>,
    private readonly clock: Clock,
  ) {
    for (const name of catalog.keys()) this.tables.set(name, []);
  }

  newSession(): Session {
    return { inTransaction: false, aborted: false, xid: undefined, settings: new Map(), undo: [], savepoints: [], log: undefined };
  }

  /** Runs one statement on `session`, as a pooled client's `query` does. */
  async run(session: Session, input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    if (this.ended) throw new Error('Cannot use a pool after calling end on the pool');
    const text = typeof input === 'string' ? input : input.text;
    const configValues: unknown[] | undefined = typeof input === 'string' ? undefined : input.values;
    const params = [...(configValues ?? values ?? [])];
    const sql = collapse(text);
    const { stmt, tables } = this.parse(sql);
    switch (stmt.k) {
      case 'begin':
        if (!session.inTransaction) this.begin(session);
        return commandResult('BEGIN');
      case 'commit':
        return commandResult(this.commit(session));
      case 'rollback':
        this.finish(session, false);
        return commandResult('ROLLBACK');
      case 'savepoint':
      case 'release':
      case 'rollback-to':
        return this.savepoint(session, stmt, sql, params);
      default:
        return this.data(session, stmt, tables, sql, params);
    }
  }

  /** A connection returned to the pool with its transaction still open is rolled back, as pg destroys it. */
  release(session: Session): void {
    if (session.inTransaction) this.finish(session, false);
  }

  table(name: string): CatalogTable {
    return this.catalog.get(name) ?? unsupported(`table ${name}`);
  }

  /** Stored rows of `name`, every tenant, converted as pg returns them. */
  storedRows(name: string): Record<string, unknown>[] {
    const table = this.catalog.get(name);
    if (table === undefined) throw new TypeError(`RecordingDb has no table ${name}`);
    return this.rowsOf(name).map((row) => Object.fromEntries(table.columnNames.map((column) => [column, toWire(row[column] ?? null)])));
  }

  /** Stores `given` in `name` with every omitted column defaulted; no RLS check, undo entry or log record. */
  seedRow(name: string, given: Readonly<Record<string, unknown>>): Row {
    const row = this.seedValues(name, given);
    this.rowsOf(name).push(row);
    return row;
  }

  setGate(unit: string, state: GateState, phase: GatePhase, holderId?: string): void {
    const values = { unit, state, phase, holder_id: state === 'closed' ? (holderId ?? DEFAULT_GATE_HOLDER) : null };
    const existing = this.rowsOf('unit_gate').find((row) => row.unit === unit);
    if (existing === undefined) this.seedRow('unit_gate', values);
    else Object.assign(existing, this.seedValues('unit_gate', values));
  }

  /** Upserts one `tenant_registry` row per payload, by tenant, with the pools and tenants the site-changed consumer derives. */
  seedRegistry(payloads: readonly SiteChangedPayload[]): void {
    const rows = this.rowsOf('tenant_registry');
    for (const payload of payloads) {
      const { siteId } = payload;
      const [publicUser, privateUser, category, file, display] = [
        payload.publicUserPoolId,
        payload.privateUserPoolId,
        payload.categoryPoolId,
        payload.filePoolId,
        payload.displayPoolId,
      ].map((id) => (id === undefined || id === null || id === '' ? siteId : id)) as [string, string, string, string, string];
      const content = contentPoolOf(payload.contentPoolIds, siteId);
      const tenantId = tenantIdForSite(siteId);
      const values = {
        site_id: siteId,
        tenant_id: tenantId,
        public_user_pool_id: publicUser,
        private_user_pool_id: privateUser,
        category_pool_id: category,
        file_pool_id: file,
        display_pool_id: display,
        content_pool_ids: content,
        public_user_pool_tenant: tenantIdForSite(publicUser),
        private_user_pool_tenant: tenantIdForSite(privateUser),
        category_pool_tenant: tenantIdForSite(category),
        file_pool_tenant: tenantIdForSite(file),
        display_pool_tenant: tenantIdForSite(display),
        content_pool_tenants: content.map((id) => tenantIdForSite(id)),
        domains: payload.domains ?? [],
        aggregate_version: 1,
        updated_at: this.now(),
      };
      const existing = rows.find((row) => row.tenant_id === tenantId);
      if (existing === undefined) this.seedRow('tenant_registry', values);
      else Object.assign(existing, this.seedValues('tenant_registry', values));
    }
  }

  reset(): void {
    for (const rows of this.tables.values()) rows.length = 0;
    this.transactions.length = 0;
    this.sequences.clear();
    this.openXids.clear();
    this.nextXid = FIRST_XID;
  }

  private now(): Date {
    return new Date(this.clock.now().getTime());
  }

  private rowsOf(name: string): Row[] {
    return this.tables.get(name) ?? unsupported(`table ${name}`);
  }

  private seedValues(name: string, given: Readonly<Record<string, unknown>>): Row {
    const table = this.catalog.get(name);
    if (table === undefined) throw new TypeError(`RecordingDb has no table ${name}`);
    const columns = Object.keys(given).filter((column) => given[column] !== undefined);
    const stray = columns.find((column) => !table.columnNames.includes(column));
    if (stray !== undefined) throw new TypeError(`RecordingDb table ${name} has no column ${stray}`);
    const session = this.newSession();
    try {
      const row = this.buildRow(table, columns, columns.map((column) => given[column]), this.root(session, []));
      this.checkNotNull(table, row);
      return row;
    } finally {
      if (session.xid !== undefined) this.openXids.delete(session.xid);
    }
  }

  private root(session: Session, params: readonly unknown[]): Scope {
    return { session, params, ctes: new Map(), bindings: [] };
  }

  private parse(sql: string): Parsed {
    let parsed = this.parsed.get(sql);
    if (parsed === undefined) {
      try {
        const parser = new SqlParser(tokenize(sql), SCHEMA);
        parsed = { stmt: parser.statement(), tables: parser.tables };
      } catch (err) {
        throw unrecognised(sql, err);
      }
      this.parsed.set(sql, parsed);
    }
    return parsed;
  }

  private begin(session: Session): void {
    const log: RecordedTransaction = { tenantId: null, statements: [], committed: false };
    this.transactions.push(log);
    Object.assign(session, { inTransaction: true, aborted: false, log });
  }

  private commit(session: Session): string {
    if (!session.inTransaction) return 'COMMIT';
    const committed = !session.aborted;
    this.finish(session, committed);
    return committed ? 'COMMIT' : 'ROLLBACK';
  }

  private finish(session: Session, commit: boolean): void {
    if (!commit) this.revert(session, 0);
    if (session.log !== undefined) session.log.committed = commit;
    if (session.xid !== undefined) this.openXids.delete(session.xid);
    session.settings.clear();
    Object.assign(session, { inTransaction: false, aborted: false, xid: undefined, undo: [], savepoints: [], log: undefined });
  }

  private revert(session: Session, mark: number): void {
    while (session.undo.length > mark) {
      const entry = session.undo.pop() as Undo;
      if (entry.kind === 'update') {
        for (const key of Object.keys(entry.row)) delete entry.row[key];
        Object.assign(entry.row, entry.before);
        continue;
      }
      const rows = this.rowsOf(entry.table);
      if (entry.kind === 'insert') {
        const index = rows.indexOf(entry.row);
        if (index >= 0) rows.splice(index, 1);
      } else {
        rows.splice(Math.min(entry.index, rows.length), 0, entry.row);
      }
    }
  }

  private savepoint(session: Session, stmt: Extract<ControlStmt, { name: string }>, sql: string, params: unknown[]): QueryResult {
    if (!session.inTransaction) {
      const label = stmt.k === 'savepoint' ? 'SAVEPOINT' : stmt.k === 'release' ? 'RELEASE SAVEPOINT' : 'ROLLBACK TO SAVEPOINT';
      throw pgError('25P01', `${label} can only be used in transaction blocks`);
    }
    session.log?.statements.push({ text: sql, values: params });
    if (stmt.k === 'savepoint') {
      if (session.aborted) throw aborted();
      session.savepoints.push({ name: stmt.name, mark: session.undo.length });
      return commandResult('SAVEPOINT');
    }
    const index = session.savepoints.map((savepoint) => savepoint.name).lastIndexOf(stmt.name);
    const savepoint = session.savepoints[index];
    if (savepoint === undefined) throw pgError('3B001', `savepoint "${stmt.name}" does not exist`);
    if (stmt.k === 'release') {
      if (session.aborted) throw aborted();
      session.savepoints.length = index;
      return commandResult('RELEASE');
    }
    this.revert(session, savepoint.mark);
    session.savepoints.length = index + 1;
    session.aborted = false;
    return commandResult('ROLLBACK');
  }

  private data(session: Session, stmt: DataStmt, tables: ReadonlySet<string>, sql: string, params: unknown[]): QueryResult {
    if (session.aborted) throw aborted();
    const autocommit = !session.inTransaction;
    if (autocommit) this.begin(session);
    const log = session.log as RecordedTransaction;
    const setsTenant = isTenantSetting(stmt);
    if (!setsTenant) log.statements.push({ text: sql, values: params });
    const mark = session.undo.length;
    try {
      if (tables.has('unit_gate')) this.materializeGates();
      const result = this.execute(stmt, this.root(session, params));
      if (setsTenant) log.tenantId = this.tenantOf(session);
      if (autocommit) this.finish(session, true);
      return result;
    } catch (err) {
      // A failed statement leaves no partial write and, as in PostgreSQL, aborts its transaction.
      this.revert(session, mark);
      if (autocommit) this.finish(session, false);
      else session.aborted = true;
      throw err instanceof UnsupportedSql ? unrecognised(sql, err) : err;
    }
  }

  // A gate read for a surveys unit without a row answers open, so suites need no gate set-up even after clear().
  private materializeGates(): void {
    const rows = this.rowsOf('unit_gate');
    for (const unit of UNITS) {
      if (!rows.some((row) => row.unit === unit)) this.seedRow('unit_gate', { unit, state: 'open', phase: 'quiet', holder_id: null });
    }
  }

  private tenantOf(session: Session): string | null {
    const value = session.settings.get(TENANT_SETTING);
    return value === undefined || value === '' ? null : value.toLowerCase();
  }

  private assignXid(session: Session): bigint {
    if (session.xid === undefined) {
      session.xid = this.nextXid;
      this.nextXid += 1n;
      this.openXids.add(session.xid);
    }
    return session.xid;
  }

  private snapshot(): Snapshot {
    let xmin = this.nextXid;
    for (const xid of this.openXids) if (xid < xmin) xmin = xid;
    return new Snapshot(xmin, this.nextXid);
  }

  private execute(stmt: DataStmt, scope: Scope): QueryResult {
    for (const cte of stmt.ctes) {
      const source = relationOf(this.select(cte.q, scope), cte.name);
      scope.ctes.set(cte.name, { ...source, table: cte.name });
    }
    const out: Mutation =
      stmt.k === 'select'
        ? { command: 'SELECT', ...this.select(stmt, scope), rowCount: -1 }
        : stmt.k === 'insert'
          ? this.insert(stmt, scope)
          : stmt.k === 'update'
            ? this.update(stmt, scope)
            : this.delete(stmt, scope);
    const rows = out.rows.map((values) => Object.fromEntries(out.columns.map((column, i) => [column, toWire(values[i] ?? null)])));
    return { command: out.command, rowCount: out.rowCount < 0 ? rows.length : out.rowCount, oid: 0, fields: out.columns.map(fieldOf), rows };
  }


  private select(q: SelectStmt, parent: Scope): Output {
    const sources = q.from.map((item) => this.source(item, parent));
    let combos: Binding[][] = [[]];
    q.from.forEach((item, index) => {
      combos = this.join(combos, sources[index] as Source, item.on, parent);
    });
    const where = q.where;
    const scopes = combos.map((bindings) => child(parent, bindings)).filter((scope) => where === undefined || isTrue(this.evaluate(where, scope)));
    const columns = outputColumns(q.items, sources);
    const grouped =
      q.groupBy.length > 0 || q.items.some((item) => !item.star && hasAggregate(item.e)) || q.orderBy.some((item) => hasAggregate(item.e));
    let outputs: Projected[];
    if (grouped) {
      const groups = new Map<string, Scope[]>();
      if (q.groupBy.length === 0) groups.set('', scopes);
      for (const scope of q.groupBy.length === 0 ? [] : scopes) {
        const key = keyText(q.groupBy.map((e) => this.evaluate(e, scope)));
        const members = groups.get(key);
        if (members === undefined) groups.set(key, [scope]);
        else members.push(scope);
      }
      outputs = [...groups.values()].map((members) => {
        const scope: Scope = { ...child(parent, members[0]?.bindings ?? []), group: members };
        return { scope, values: this.project(q.items, scope) };
      });
    } else {
      outputs = scopes.map((scope) => ({ scope, values: this.project(q.items, scope) }));
    }
    outputs = expandSetReturning(outputs);
    if (q.orderBy.length > 0) outputs = this.order(outputs, q.orderBy, columns);
    if (q.distinct) {
      const seen = new Set<string>();
      outputs = outputs.filter((output) => {
        const key = keyText(output.values);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const offset = q.offset === undefined ? 0 : (this.count(q.offset, parent, 'OFFSET') ?? 0);
    const limit = q.limit === undefined ? undefined : this.count(q.limit, parent, 'LIMIT');
    return { columns, rows: outputs.slice(offset, limit === undefined ? undefined : offset + limit).map((output) => output.values) };
  }

  /** A LIMIT or OFFSET value; NULL means none. */
  private count(e: Expr, scope: Scope, clause: string): number | undefined {
    const value = this.evaluate(e, scope);
    if (value === null) return undefined;
    const n = Number(toBigInt(value));
    if (n < 0) throw pgError('2201W', `${clause} must not be negative`);
    return n;
  }

  private source(item: FromItem, scope: Scope): Source {
    if ('sub' in item.source) return relationOf(this.select(item.source.sub, scope), item.alias);
    const { table } = item.source;
    const cte = scope.ctes.get(table);
    if (cte !== undefined) return { ...cte, alias: item.alias };
    const def = this.table(table);
    return sourceOf(def, item.alias, this.visible(def, scope.session));
  }

  private join(combos: readonly Binding[][], source: Source, on: Expr | undefined, parent: Scope): Binding[][] {
    const joined: Binding[][] = [];
    for (const combo of combos) {
      for (const row of source.rows) {
        const bindings = [...combo, bindingOf(source, row)];
        if (on === undefined || isTrue(this.evaluate(on, child(parent, bindings)))) joined.push(bindings);
      }
    }
    return joined;
  }

  private project(items: readonly SelectItem[], scope: Scope): unknown[] {
    return items.flatMap((item) =>
      item.star
        ? starBindings(scope.bindings, item.table).flatMap((binding) => binding.columns.map((column) => binding.row[column] ?? null))
        : [this.evaluate(item.e, scope)],
    );
  }

  private order(outputs: readonly Projected[], orderBy: readonly OrderItem[], columns: readonly string[]): Projected[] {
    const keyed = outputs.map((output) => ({ output, keys: orderBy.map((item) => this.orderKey(item, output, columns)) }));
    keyed.sort((x, y) => {
      for (const [i, item] of orderBy.entries()) {
        const c = sortCompare(x.keys[i], y.keys[i], item);
        if (c !== 0) return c;
      }
      return 0;
    });
    return keyed.map(({ output }) => output);
  }

  /** A sort key: a bare name of an output column or an output position sorts by that output, anything else by its value over the input row. */
  private orderKey(item: OrderItem, output: Projected, columns: readonly string[]): unknown {
    const { e } = item;
    if (e.k === 'col' && e.table === undefined && columns.includes(e.name)) return output.values[columns.indexOf(e.name)] ?? null;
    if (e.k === 'lit' && typeof e.v === 'number' && Number.isInteger(e.v)) return output.values[e.v - 1] ?? null;
    return this.evaluate(e, output.scope);
  }

  private evaluate(e: Expr, scope: Scope): unknown {
    switch (e.k) {
      case 'lit':
        return e.v;
      case 'param':
        if (e.i < 1 || e.i > scope.params.length) {
          throw pgError('08P01', `bind message supplies ${String(scope.params.length)} parameters, but the statement requires $${String(e.i)}`);
        }
        return scope.params[e.i - 1] ?? null;
      case 'col':
        return this.resolve(scope, e.table, e.name);
      case 'default':
        return unsupported('DEFAULT outside an INSERT or UPDATE value');
      case 'fn':
        return this.call(e, scope);
      case 'cast':
        return castValue(this.evaluate(e.e, scope), e.type);
      case 'not': {
        const value = toBool3(this.evaluate(e.e, scope));
        return value === null ? null : !value;
      }
      case 'neg': {
        const value = this.evaluate(e.e, scope);
        return value === null ? null : arithmetic('-', 0, value);
      }
      case 'bin':
        return this.binary(e, scope);
      case 'isnull': {
        const isNull = this.evaluate(e.e, scope) === null;
        return e.not ? !isNull : isNull;
      }
      case 'istruth': {
        const holds = toBool3(this.evaluate(e.e, scope)) === e.v;
        return e.not ? !holds : holds;
      }
      case 'distinct': {
        const same = notDistinct(this.evaluate(e.l, scope), this.evaluate(e.r, scope));
        return e.not ? same : !same;
      }
      case 'in': {
        const value = this.evaluate(e.e, scope);
        let unknown = false;
        for (const item of e.list) {
          const c = compareValues(value, this.evaluate(item, scope));
          if (c === 0) return !e.not;
          if (c === null) unknown = true;
        }
        return unknown ? null : e.not;
      }
      case 'quantified': {
        const left = this.evaluate(e.l, scope);
        const right = this.evaluate(e.r, scope);
        if (right === null) return null;
        const results = asArray(right).map((item) => applyOperator(e.op, left, item));
        if (e.all) return results.includes(false) ? false : results.includes(null) ? null : true;
        return results.includes(true) ? true : results.includes(null) ? null : false;
      }
      case 'row':
        return new RowValue(e.items.map((item) => this.evaluate(item, scope)));
      case 'array':
        return e.items.map((item) => this.evaluate(item, scope));
      case 'sub': {
        const { rows } = this.select(e.q, scope);
        if (rows.length > 1) throw pgError('21000', 'more than one row returned by a subquery used as an expression');
        return rows[0]?.[0] ?? null;
      }
    }
  }

  private binary(e: Extract<Expr, { k: 'bin' }>, scope: Scope): unknown {
    if (e.op === 'and' || e.op === 'or') {
      const decisive = e.op === 'or';
      const left = toBool3(this.evaluate(e.l, scope));
      if (left === decisive) return decisive;
      const right = toBool3(this.evaluate(e.r, scope));
      if (right === decisive) return decisive;
      return left === null || right === null ? null : !decisive;
    }
    return applyOperator(e.op, this.evaluate(e.l, scope), this.evaluate(e.r, scope));
  }

  private resolve(scope: Scope, table: string | undefined, name: string): unknown {
    for (let current: Scope | undefined = scope; current !== undefined; current = current.outer) {
      const bindings = current.bindings;
      const binding =
        table === undefined
          ? bindings.find((candidate) => candidate.columns.includes(name))
          : (bindings.find((candidate) => candidate.alias === table) ?? bindings.find((candidate) => candidate.table === table));
      if (binding !== undefined && binding.columns.includes(name)) return binding.row[name] ?? null;
    }
    throw pgError('42703', `column ${table === undefined ? '' : `${table}.`}${name} does not exist`);
  }

  private call(e: FnExpr, scope: Scope): unknown {
    if (AGGREGATES.has(e.name)) return this.aggregate(e, scope);
    if (e.name === 'coalesce') {
      for (const arg of e.args) {
        const value = this.evaluate(arg, scope);
        if (value !== null) return value;
      }
      return null;
    }
    if (e.name === 'make_interval') return this.interval(e, scope);
    const args = e.args.map((arg) => this.evaluate(arg, scope));
    const [a, b, c] = [args[0] ?? null, args[1] ?? null, args[2] ?? null];
    switch (e.name) {
      case 'lower':
        return a === null ? null : toText(a).toLowerCase();
      case 'upper':
        return a === null ? null : toText(a).toUpperCase();
      case 'rtrim':
      case 'ltrim':
      case 'btrim':
        return a === null || (args.length > 1 && b === null) ? null : trimChars(toText(a), args.length > 1 ? toText(b) : ' ', e.name);
      case 'length':
      case 'char_length':
      case 'character_length':
        return a === null ? null : [...toText(a)].length;
      case 'octet_length':
        return a === null ? null : Buffer.byteLength(toText(a), 'utf8');
      case 'translate':
        return a === null || b === null || c === null ? null : translate(toText(a), toText(b), toText(c));
      case 'nullif':
        return compareValues(a, b) === 0 ? null : a;
      case 'to_char':
        return a === null || b === null ? null : toChar(toTimestamp(a), toText(b));
      case 'localtimestamp':
      case 'current_timestamp':
      case 'now':
        return this.now();
      case 'set_config': {
        if (a === null) throw pgError('22004', 'SET requires parameter name');
        const value = b === null ? '' : toText(b);
        scope.session.settings.set(toText(a), value);
        return value;
      }
      case 'current_setting': {
        const name = a === null ? '' : toText(a);
        const value = scope.session.settings.get(name) ?? SETTING_DEFAULTS.get(name);
        if (value !== undefined) return value;
        if (toBool3(b) === true) return null;
        throw pgError('42704', `unrecognized configuration parameter "${name}"`);
      }
      // Advisory locks never block: every transaction runs in this process.
      case 'pg_advisory_xact_lock':
        return '';
      case 'hashtextextended':
        return a === null ? null : BigInt.asIntN(64, BigInt(`0x${createHash('sha256').update(`${toText(a)}:${String(b)}`).digest('hex').slice(0, 16)}`));
      case 'pg_current_xact_id':
        return this.assignXid(scope.session);
      case 'pg_current_snapshot':
        return this.snapshot();
      case 'pg_snapshot_xmin':
      case 'pg_snapshot_xmax':
        if (!(a instanceof Snapshot)) return unsupported(`${e.name} of a non-snapshot`);
        return e.name === 'pg_snapshot_xmin' ? a.xmin : a.xmax;
      case 'to_regclass':
        return a === null ? null : this.regclass(toText(a));
      case 'unnest':
        return new SetReturning(a === null ? [] : asArray(a));
      default:
        return unsupported(`function ${e.name}`);
    }
  }

  private aggregate(e: FnExpr, scope: Scope): unknown {
    const group = scope.group ?? unsupported(`aggregate ${e.name} outside a grouped SELECT`);
    if (e.star) return e.name === 'count' ? BigInt(group.length) : unsupported(`${e.name}(*)`);
    const arg = e.args[0] ?? unsupported(`${e.name}() without an argument`);
    const values = group.map((member) => this.evaluate(arg, member)).filter((value) => value !== null);
    switch (e.name) {
      case 'count':
        return BigInt(values.length);
      case 'max':
      case 'min': {
        const wanted = e.name === 'max' ? 1 : -1;
        return values.reduce<unknown>((best, value) => (best === null || sign(compareValues(value, best) ?? 0) === wanted ? value : best), null);
      }
      case 'sum':
        return values.length === 0 ? null : values.slice(1).reduce<unknown>((total, value) => arithmetic('+', total, value), values[0]);
      case 'bool_or':
        return values.length === 0 ? null : values.some((value) => toBool3(value) === true);
      default:
        return values.length === 0 ? null : values.every((value) => toBool3(value) === true);
    }
  }

  private interval(e: FnExpr, scope: Scope): Interval | null {
    if (e.args.length > 0) return unsupported('positional make_interval arguments');
    const factors: Readonly<Record<string, number>> = { weeks: 7 * DAY_MS, days: DAY_MS, hours: 60 * MINUTE_MS, mins: MINUTE_MS, secs: 1000 };
    let ms = 0;
    for (const [name, arg] of Object.entries(e.named)) {
      const factor = factors[name] ?? unsupported(`make_interval(${name} => …)`);
      const value = this.evaluate(arg, scope);
      if (value === null) return null;
      ms += Number(toNumeric(value)) * factor;
    }
    return new Interval(ms);
  }

  /** `to_regclass`: the name when it is a table of the recording schema, otherwise null. */
  private regclass(name: string): string | null {
    const parts = name.split('.').map((part) => part.replace(/^"|"$/g, ''));
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== SCHEMA)) return null;
    return this.catalog.has(parts.at(-1) ?? '') ? name : null;
  }

  private column(table: CatalogTable, name: string): CatalogColumn {
    const found = table.columns.find((column) => column.name === name);
    if (found === undefined) throw pgError('42703', `column "${name}" of relation "${table.name}" does not exist`);
    return found;
  }

  private visible(table: CatalogTable, session: Session): Row[] {
    const rows = this.rowsOf(table.name);
    if (!table.tenantOwned) return [...rows];
    const tenant = this.tenantOf(session);
    return tenant === null ? [] : rows.filter((row) => row.tenant_id === tenant);
  }

  private checkNotNull(table: CatalogTable, row: Row): void {
    const missing = table.columns.find((column) => column.notNull && row[column.name] === null);
    if (missing !== undefined) {
      throw pgError('23502', `null value in column "${missing.name}" of relation "${table.name}" violates not-null constraint`);
    }
  }

  /** NOT NULL, then the forced RLS policy's WITH CHECK: a tenant-owned row must carry the transaction's tenant. */
  private checkRow(table: CatalogTable, row: Row, session: Session): void {
    this.checkNotNull(table, row);
    if (!table.tenantOwned) return;
    const tenant = this.tenantOf(session);
    if (tenant === null || row.tenant_id !== tenant) {
      throw pgError('42501', `new row violates row-level security policy for table "${table.name}"`);
    }
  }

  private buildRow(table: CatalogTable, columns: readonly string[], values: readonly unknown[], scope: Scope): Row {
    const row: Row = {};
    for (const column of table.columns) {
      const index = columns.indexOf(column.name);
      const given = index === -1 ? DEFAULT_VALUE : values[index];
      row[column.name] = given === DEFAULT_VALUE ? this.defaultOf(table, column, scope) : castValue(given ?? null, column.type);
    }
    return row;
  }

  private defaultOf(table: CatalogTable, column: CatalogColumn, scope: Scope): unknown {
    if (column.identity) {
      const key = `${table.name}.${column.name}`;
      const next = (this.sequences.get(key) ?? 0n) + 1n;
      this.sequences.set(key, next);
      return castValue(next, column.type);
    }
    // Gates ensured at start-up are open, not the DDL's `legacy`, so target writes need no gate set-up.
    if (table.name === 'unit_gate' && column.name === 'state') return 'open';
    return column.fallback === undefined ? null : castValue(this.evaluate(column.fallback, scope), column.type);
  }

  /** The stored row clashing with `row` on a unique key, the arbiter keys first; `self` is the row being updated. */
  private conflictOf(
    table: CatalogTable,
    row: Row,
    target: readonly string[] | undefined,
    self?: Row,
  ): { row: Row; constraint: UniqueConstraint; arbiter: boolean } | undefined {
    const arbiters = target === undefined ? table.constraints : table.constraints.filter((constraint) => sameColumns(constraint.columns, target));
    if (target !== undefined && arbiters.length === 0) {
      throw pgError('42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
    }
    for (const constraint of [...arbiters, ...table.constraints.filter((candidate) => !arbiters.includes(candidate))]) {
      const values = constraint.columns.map((column) => row[column] ?? null);
      if (!constraint.nullsNotDistinct && values.includes(null)) continue;
      const clash = this.rowsOf(table.name).find(
        (other) => other !== self && constraint.columns.every((column, i) => keyEqual(other[column] ?? null, values[i] ?? null)),
      );
      if (clash !== undefined) return { row: clash, constraint, arbiter: arbiters.includes(constraint) };
    }
    return undefined;
  }

  private insert(q: InsertStmt, scope: Scope): Mutation {
    const table = this.table(q.table);
    const columns = q.columns ?? table.columnNames;
    for (const name of columns) this.column(table, name);
    const tuples: unknown[][] =
      q.select === undefined
        ? (q.values ?? []).map((tuple) => tuple.map((e) => (e.k === 'default' ? DEFAULT_VALUE : this.evaluate(e, scope))))
        : this.select(q.select, scope).rows;
    const target = sourceOf(table, q.alias ?? table.name);
    const rows: unknown[][] = [];
    let rowCount = 0;
    for (const tuple of tuples) {
      if (tuple.length !== columns.length) {
        throw pgError('42601', `INSERT has more ${tuple.length > columns.length ? 'expressions than target columns' : 'target columns than expressions'}`);
      }
      const stored = this.place(table, q, this.buildRow(table, columns, tuple, scope), scope);
      if (stored === undefined) continue;
      rowCount += 1;
      if (q.returning.length > 0) rows.push(this.project(q.returning, child(scope, [bindingOf(target, stored)])));
    }
    return { command: 'INSERT', columns: outputColumns(q.returning, [target]), rows, rowCount };
  }

  /** Stores a proposed row, or resolves its key clash by ON CONFLICT; returns the row inserted or updated, undefined when skipped. */
  private place(table: CatalogTable, q: InsertStmt, row: Row, scope: Scope): Row | undefined {
    const { session } = scope;
    this.checkRow(table, row, session);
    const conflict = this.conflictOf(table, row, q.conflict?.target);
    if (conflict === undefined) {
      this.assignXid(session);
      this.rowsOf(table.name).push(row);
      session.undo.push({ kind: 'insert', table: table.name, row });
      return row;
    }
    if (q.conflict === undefined || !conflict.arbiter) throw uniqueViolation(table, conflict.constraint);
    const { update } = q.conflict;
    if (update === undefined) return undefined;
    const existing = conflict.row;
    const conflictScope = child(scope, [
      bindingOf(sourceOf(table, q.alias ?? table.name), existing),
      { alias: 'excluded', columns: table.columnNames, row },
    ]);
    if (update.where !== undefined && !isTrue(this.evaluate(update.where, conflictScope))) return undefined;
    if (table.tenantOwned && existing.tenant_id !== this.tenantOf(session)) {
      throw pgError('42501', `new row violates row-level security policy (USING expression) for table "${table.name}"`);
    }
    this.apply(table, existing, this.assign(table, existing, update.set, conflictScope), session);
    return existing;
  }

  /** `row` with `set` evaluated over its old values. */
  private assign(table: CatalogTable, row: Row, set: readonly Assignment[], scope: Scope): Row {
    const next: Row = { ...row };
    for (const { column, e } of set) {
      const def = this.column(table, column);
      next[column] = e.k === 'default' ? this.defaultOf(table, def, scope) : castValue(this.evaluate(e, scope), def.type);
    }
    return next;
  }

  private apply(table: CatalogTable, row: Row, next: Row, session: Session): void {
    this.checkRow(table, next, session);
    const clash = this.conflictOf(table, next, undefined, row);
    if (clash !== undefined) throw uniqueViolation(table, clash.constraint);
    this.assignXid(session);
    session.undo.push({ kind: 'update', row, before: { ...row } });
    Object.assign(row, next);
  }

  private update(q: UpdateStmt, scope: Scope): Mutation {
    const table = this.table(q.table);
    for (const { column } of q.set) this.column(table, column);
    const target = sourceOf(table, q.alias, this.visible(table, scope.session));
    const sources = q.from.map((item) => this.source(item, scope));
    let combos: Binding[][] = target.rows.map((row) => [bindingOf(target, row)]);
    q.from.forEach((item, index) => {
      combos = this.join(combos, sources[index] as Source, item.on, scope);
    });
    const where = q.where;
    const matched = combos.map((bindings) => child(scope, bindings)).filter((s) => where === undefined || isTrue(this.evaluate(where, s)));
    const updated = new Set<Row>();
    const rows: unknown[][] = [];
    for (const rowScope of matched) {
      const row = (rowScope.bindings[0] as Binding).row;
      if (updated.has(row)) continue;
      updated.add(row);
      this.apply(table, row, this.assign(table, row, q.set, rowScope), scope.session);
      if (q.returning.length > 0) rows.push(this.project(q.returning, rowScope));
    }
    return { command: 'UPDATE', columns: outputColumns(q.returning, [target, ...sources]), rows, rowCount: updated.size };
  }

  private delete(q: DeleteStmt, scope: Scope): Mutation {
    const table = this.table(q.table);
    const target = sourceOf(table, q.alias, this.visible(table, scope.session));
    const where = q.where;
    const matched = target.rows
      .map((row) => child(scope, [bindingOf(target, row)]))
      .filter((rowScope) => where === undefined || isTrue(this.evaluate(where, rowScope)));
    const stored = this.rowsOf(table.name);
    const rows: unknown[][] = [];
    for (const rowScope of matched) {
      const row = (rowScope.bindings[0] as Binding).row;
      const index = stored.indexOf(row);
      this.assignXid(scope.session);
      stored.splice(index, 1);
      scope.session.undo.push({ kind: 'delete', table: table.name, row, index });
      if (q.returning.length > 0) rows.push(this.project(q.returning, rowScope));
    }
    return { command: 'DELETE', columns: outputColumns(q.returning, [target]), rows, rowCount: matched.length };
  }
}

/** Rows, gates and registry a {@link RecordingDb} starts with. */
export interface RecordingDbSeed {
  /** Rows per table stored before any statement runs; omitted columns take their defaults. */
  rows?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  gates?: Readonly<Record<string, { state: GateState; phase?: GatePhase; holderId?: string }>>;
  /** `true` seeds the platform fixture sites, a list seeds those payloads. */
  registry?: boolean | readonly SiteChangedPayload[];
  /** Clock of `LOCALTIMESTAMP` and seeded timestamps; defaults to the system clock. */
  clock?: Clock;
}

/** `TenantDb` of schema `surveys` over the platform transaction runner and an in-memory interpreter of its SQL, with forced RLS. */
export interface RecordingDb extends TenantDb {
  /** Transactions in start order; one run outside a transaction is recorded as its own. */
  readonly transactions: readonly RecordedTransaction[];
  /** Rows of `table` as stored, every tenant, in insertion order, as pg returns them. */
  rows(table: string): Record<string, unknown>[];
  /** Sets a unit's gate; a closed gate is held by `holderId`, default `recording-db`. */
  setGate(unit: string, state: GateState, phase?: GatePhase, holderId?: string): void;
  /** Upserts the `tenant_registry` rows the site-changed consumer derives from `payloads`, by default the platform fixture sites. */
  seedRegistry(payloads?: readonly SiteChangedPayload[]): void;
  /** Empties every table and the transaction log, and restarts xids and sequences. */
  clear(): void;
}

const recordingDbs = new WeakSet<object>();

function isRecordingDb(db: TenantDb): db is RecordingDb {
  return recordingDbs.has(db);
}

/**
 * Creates a {@link RecordingDb}; nothing connects to PostgreSQL. Statements the interpreter cannot answer throw
 * `RecordingDb: unrecognised statement: <sql>`; constraint, RLS and type failures throw pg-shaped errors with their SQLSTATE.
 */
export function createRecordingDb(seed: RecordingDbSeed = {}): RecordingDb {
  const engine = new RecordingEngine(surveysCatalog(), seed.clock ?? systemClock);
  for (const [table, rows] of Object.entries(seed.rows ?? {})) {
    for (const row of rows) engine.seedRow(table, row);
  }
  for (const [unit, gate] of Object.entries(seed.gates ?? {})) engine.setGate(unit, gate.state, gate.phase ?? 'quiet', gate.holderId);
  if (seed.registry !== undefined && seed.registry !== false) engine.seedRegistry(seed.registry === true ? registryPayloads() : seed.registry);

  const fakePool = {
    async connect() {
      if (engine.ended) throw new Error('Cannot use a pool after calling end on the pool');
      const session = engine.newSession();
      return {
        query: (input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> => engine.run(session, input, values),
        release: (): void => engine.release(session),
      };
    },
    query: (input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> => engine.run(engine.newSession(), input, values),
    async end(): Promise<void> {
      engine.ended = true;
    },
    on: (): void => undefined,
  };
  const base = tenantDbFromPool(fakePool as unknown as Pool, { schema: SCHEMA });

  // tenantDbFromPool freezes its TenantDb, so the recording members sit on an object that delegates to it.
  const db: RecordingDb = {
    schema: base.schema,
    withTenant: (tenantId, fn) => base.withTenant(tenantId, fn),
    withMetadata: (fn, options) => base.withMetadata(fn, options),
    end: () => base.end(),
    transactions: engine.transactions,
    rows: (table) => engine.storedRows(table),
    setGate: (unit, state, phase = 'quiet', holderId) => engine.setGate(unit, state, phase, holderId),
    seedRegistry: (payloads = registryPayloads()) => engine.seedRegistry(payloads),
    clear: () => engine.reset(),
  };
  recordingDbs.add(db);
  return db;
}

type EventPublisher = NonNullable<BuildAppOptions['publisher']>;

/** Options of {@link buildTestApp}; it creates every fake it is not given. */
export interface TestAppOptions<D extends TenantDb = RecordingDb, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher> {
  /** Merged into {@link testEnv}. */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  /** A RecordingDb by default; a throwaway schema's `app` handle for suites that need PostgreSQL itself. */
  db?: D;
  publisher?: E;
  taskPort?: P;
  client?: ClientRecorder;
  verifierOverride?: BuildAppOptions['verifierOverride'];
  /** Seeds the fixture sites into `tenant_registry` before the build; default true. */
  seedRegistry?: boolean;
}

/** A ready app and the fakes behind it. */
export interface TestApp<D extends TenantDb = RecordingDb, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher> {
  app: FastifyInstance;
  publisher: E;
  taskPort: P;
  client: ClientRecorder;
  db: D;
  clock: Clock;
  env: BaseEnv;
}

/**
 * Builds the surveys app over the fakes, installs the client recorder and awaits `ready`; it never listens. Apps built in
 * one process share the outbox runtime of their schema, so the latest build's publisher and database serve every flush.
 * Unless `env` names `OPT2_STATE_DIR`, the app gets its own state directory, removed when it closes. On failure it closes
 * the app it built, removes that directory and rethrows the original error.
 */
export function buildTestApp<D extends TenantDb = RecordingDb, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher>(
  opts?: TestAppOptions<D, P, E>,
): Promise<TestApp<D, P, E>>;
export async function buildTestApp(
  opts: TestAppOptions<TenantDb, TaskPort, EventPublisher> = {},
): Promise<TestApp<TenantDb, TaskPort, EventPublisher>> {
  const clock = opts.clock ?? TEST_CLOCK;
  // Test workers are killed without an exit event, so an app gets its own state directory, removed when it closes.
  const ownStateDir = opts.env !== undefined && 'OPT2_STATE_DIR' in opts.env ? undefined : mkdtempSync(join(tmpdir(), STATE_DIR_PREFIX));
  const removeStateDir = (): void => {
    if (ownStateDir !== undefined) rmSync(ownStateDir, { recursive: true, force: true });
  };
  let app: FastifyInstance | undefined;
  try {
    if (ownStateDir !== undefined) await writeTestSecrets(ownStateDir);
    const env = await testEnv(ownStateDir === undefined ? opts.env : { ...opts.env, OPT2_STATE_DIR: ownStateDir });
    const db = opts.db ?? createRecordingDb({ clock });
    if (opts.seedRegistry !== false) {
      if (isRecordingDb(db)) db.seedRegistry();
      // The handle's own schema, so a throwaway schema is seeded rather than `surveys`.
      else await seedRegistryTable(db);
    }
    const publisher = opts.publisher ?? createCapturingPublisher();
    const taskPort = opts.taskPort ?? createFakeTaskPort();
    const client = opts.client ?? createClientRecorder();
    app = await buildApp({ env, clock, verifierOverride: opts.verifierOverride ?? testVerifier(), db, publisher, taskPort });
    app.addHook('onClose', async () => {
      removeStateDir();
    });
    client.install(app);
    await app.ready();
    return { app, publisher, taskPort, client, db, clock, env };
  } catch (err) {
    await app?.close().catch(() => undefined);
    removeStateDir();
    throw err;
  }
}

function roleSubjectNamed(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return found;
}

/**
 * `app.inject` headers presenting `subject`, or the `ROLE_SET` subject of that name, to surveys; user tokens are minted
 * for `site`, `tenant-a` by default, with `sub` as the Masa UserID when given. Throws TypeError for a name `ROLE_SET` lacks.
 */
export function headersFor(subject: RoleSubject | string, opts: { site?: string; sub?: string } = {}): Promise<Record<string, string>> {
  const resolved = typeof subject === 'string' ? roleSubjectNamed(subject) : subject;
  return authHeadersFor(resolved, { site: opts.site ?? TENANT_A.siteId, audience: OWNER, sub: opts.sub });
}

