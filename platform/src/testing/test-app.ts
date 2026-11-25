/** Test-app scaffolding: request headers, the local environment and state directory, a fake task port, client-route patterns, SQL text and a fake-pool TenantDb. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_TOKEN } from '../auth/index.js';
import type { ServiceRequest, ServiceResponse } from '../service-kit/index.js';
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
} from '../tasks/port.js';
import { SYSTEM_TENANT_ID, tenantDbFromPool, type Pool, type QueryConfig, type QueryResult, type TenantDb } from '../tenancy/index.js';
import { roleSubjectNamed } from './authz-matrix.js';
import { TENANT_A } from './fixtures.js';
import { authHeadersFor, writeTestSecrets, type RoleSubject } from './tokens.js';

/** Options of a {@link HeadersFor} call. */
export interface HeadersForOptions {
  /** Site of a user token. */
  site?: string;
  /** Callee of the invocation credential. */
  audience?: string;
  /** `sub` of a user token; one per subject by default. */
  sub?: string;
}

/** `app.inject` headers presenting `subject`, or the ROLE_SET subject of that name; rejects with TypeError for an unknown name. */
export type HeadersFor = (subject: RoleSubject | string, options?: HeadersForOptions) => Promise<Record<string, string>>;

/** Local ports of the workloads, as `harness/repro/ports.env` fixes them. */
export const LOCAL_TEST_PORTS: Readonly<Record<string, number>> = Object.freeze({
  gateway: 8100,
  web: 8101,
  migration: 8102,
  identity: 8111,
  people: 8112,
  'programs-sites': 8113,
  'strategies-content': 8114,
  stub: 8199,
});

/** Options of {@link localTestEnv}. */
export interface LocalTestEnvOptions {
  /** `OPT2_SERVICE_NAME`; `PORT` is its local port unless `port` is given. */
  service: string;
  port?: number;
  /** `PG_DATABASE` and `PG_USER`; the password is a placeholder, as suites inject the database. */
  database: { name: string; user: string };
  /** Takes each `PG_*` value from `process.env` when set there. */
  pgFromProcessEnv?: boolean;
  /** Services of `OPT2_SERVICE_URLS`, in order, at their local ports. */
  callees: readonly string[];
  /** `OPT2_STATE_DIR` unless the overrides name it; a function runs only then. */
  stateDir: string | (() => string);
  /** Variables merged after the base and before the overrides. */
  extra?: Readonly<Record<string, string | undefined>>;
}

/** A task the fake port holds; a deleted or done task is a tombstone whose name stays reserved. */
export interface FakeTask {
  readonly input: CreateTaskInput;
  readonly deleted: boolean;
}

/** Member names of the task port, as {@link FakeTaskPort.calls} records them. */
export type TaskPortOp = Exclude<keyof TaskPort, 'kind'>;

/** One call the fake task port received, with its arguments as passed, trailing `undefined` ones dropped. */
export interface TaskPortCall {
  readonly op: TaskPortOp;
  readonly args: readonly unknown[];
}

/** Options of {@link createFakeTaskPort}. */
export interface FakeTaskPortOptions {
  /** Keys tasks by `(tenant, queue, name)` and reads `opts.tenantId` in `get` and `delete`, as the local adapter does. */
  tenantKeyed?: boolean;
  /** Marks matching tasks done at creation, or on `resumeQueue` while their queue is paused; `true` matches every task. */
  autoComplete?: boolean | ((input: CreateTaskInput) => boolean);
}

/** In-memory TaskPort that records its calls and never dispatches. */
export interface FakeTaskPort extends TaskPort {
  readonly kind: 'local';
  /** Every call, `close` included, in call order; a suite may empty it. */
  readonly calls: TaskPortCall[];
  /** Every created task by `<queue>/<name>`, or `<tenant>:<queue>/<name>` when tenant-keyed, tombstones included, in creation order. */
  readonly tasks: ReadonlyMap<string, FakeTask>;
  /** The same tasks as a list, in creation order. */
  readonly created: readonly FakeTask[];
  /** Tasks marked done by `autoComplete` or {@link FakeTaskPort.markDone}. */
  readonly done: ReadonlySet<FakeTask>;
  /** Makes the next `times` creates matching `target`, a queue or a predicate, or any create when omitted, throw after their input check; `null` drops every pending failure. */
  failCreate(target?: string | ((input: CreateTaskInput) => boolean) | null, times?: number): void;
  /** Marks the first created task named `name`, on `queue` and of `tenantId` when given, done; throws when none matches. */
  markDone(name: string, queue?: string, tenantId?: string): void;
  /** Forgets every call, task, tombstone, done mark, paused queue and pending failure. */
  clear(): void;
}

/** Answers one service call. */
export type ClientHandler = (req: ServiceRequest) => ServiceResponse | Promise<ServiceResponse>;

/** Options of {@link fakePoolTenantDb}. */
export interface FakePoolOptions<S> {
  schema: string;
  /** State of one new connection. */
  session: () => S;
  /** Answers one statement on a connection with its raw SQL text and bound values. */
  run: (session: S, sql: string, params: unknown[]) => Promise<QueryResult>;
  /** Runs when a connection is released, e.g. to drop the state of a transaction it left open. */
  release?: (session: S) => void;
  /** Whether a connect or query after `end()` throws, as pg's ended pool does; true by default. */
  refuseAfterEnd?: boolean;
}

/** The members of a TenantDb a fake pool backs. */
export type FakePoolTenantDb = Pick<TenantDb, 'schema' | 'withTenant' | 'withMetadata' | 'end'>;

/** `<METHOD> <path>` key of a client handler. */
export const CLIENT_ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;

/** Message pg's pool throws once it has ended. */
export const POOL_ENDED_MESSAGE = 'Cannot use a pool after calling end on the pool';

interface StoredTask {
  input: CreateTaskInput;
  deleted: boolean;
}

/** A {@link HeadersFor} over authHeadersFor; user tokens are minted for `defaults.site`, tenant-a unless given. */
export function createHeadersFor(defaults: { audience: string; site?: string }): HeadersFor {
  return async (subject, options = {}) => {
    const resolved = typeof subject === 'string' ? roleSubjectNamed(subject) : subject;
    return authHeadersFor(resolved, {
      site: options.site ?? defaults.site ?? TENANT_A.siteId,
      audience: options.audience ?? defaults.audience,
      ...(options.sub === undefined ? {} : { sub: options.sub }),
    });
  };
}

/** `http://127.0.0.1:<port>` of a port, or of a workload's local port; throws TypeError for an unknown workload. */
export function localTestUrl(target: string | number): string {
  return `http://127.0.0.1:${String(typeof target === 'number' ? target : localTestPort(target))}`;
}

function localTestPort(workload: string): number {
  const port = Object.hasOwn(LOCAL_TEST_PORTS, workload) ? LOCAL_TEST_PORTS[workload] : undefined;
  if (port === undefined) throw new TypeError(`No local test port for ${workload}`);
  return port;
}

/** The raw local-mode environment of a service; `overrides` merge last, and an `undefined` value removes the variable. */
export function localTestEnv(options: LocalTestEnvOptions, overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const pg = (name: string, fallback: string): string => (options.pgFromProcessEnv === true ? process.env[name] || fallback : fallback);
  const stateDir = 'OPT2_STATE_DIR' in overrides ? undefined : typeof options.stateDir === 'string' ? options.stateDir : options.stateDir();
  const merged: Record<string, string | undefined> = {
    PORT: String(options.port ?? localTestPort(options.service)),
    OPT2_SERVICE_NAME: options.service,
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: pg('PG_HOST', '127.0.0.1'),
    PG_PORT: pg('PG_PORT', '5432'),
    PG_DATABASE: pg('PG_DATABASE', options.database.name),
    PG_USER: pg('PG_USER', options.database.user),
    // loadEnv reads a blank password as missing, which OPT2_DB_AUTH=password rejects.
    PG_PASSWORD: pg('PG_PASSWORD', 'unused'),
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    // Never fetched: testVerifier() replaces JWKS verification.
    OPT2_JWKS_URL: `${localTestUrl('identity')}/.well-known/jwks.json`,
    OPT2_SERVICE_URLS: JSON.stringify(Object.fromEntries(options.callees.map((callee) => [callee, localTestUrl(callee)]))),
    OPT2_STATE_DIR: stateDir,
    OPT2_TASKS_ADAPTER: 'local',
    TZ: process.env.TZ || 'UTC',
    ...options.extra,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** A fresh state directory under the OS temp directory holding the platform test key pair and push key. */
export async function createTestStateDir(prefix = 'opt2-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await writeTestSecrets(dir);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/** Creates a {@link FakeTaskPort}; a repeated key, live, deleted or done, answers `created: false` as ALREADY_EXISTS does, and only a `tenantKeyed` port reads the `opts` of `get` and `delete`. */
export function createFakeTaskPort(options: FakeTaskPortOptions = {}): FakeTaskPort {
  const { tenantKeyed = false, autoComplete = false } = options;
  const calls: TaskPortCall[] = [];
  const tasks = new Map<string, StoredTask>();
  const created: StoredTask[] = [];
  const done = new Set<StoredTask>();
  const awaitingResume = new Set<StoredTask>();
  const paused = new Set<string>();
  const failures: Array<{ matches: (input: CreateTaskInput) => boolean; remaining: number }> = [];

  const record = (op: TaskPortOp, ...args: unknown[]): void => {
    let length = args.length;
    while (length > 0 && args[length - 1] === undefined) length -= 1;
    calls.push({ op, args: args.slice(0, length) });
  };
  // A tenant-less task belongs to the system tenant, as in the local adapter.
  const tenantOf = (input: CreateTaskInput): string => input.tenantId ?? SYSTEM_TENANT_ID;
  const keyOf = (queue: string, name: string, tenant: string): string => (tenantKeyed ? `${tenant}:${queue}/${name}` : `${queue}/${name}`);
  const isLive = (task: StoredTask | undefined): task is StoredTask => task !== undefined && !task.deleted && !done.has(task);
  const liveAt = (queue: string, name: string, tenant = SYSTEM_TENANT_ID): StoredTask | undefined => {
    const task = tasks.get(keyOf(queue, name, tenant));
    return isLive(task) ? task : undefined;
  };
  const complete = (task: StoredTask): void => {
    done.add(task);
    awaitingResume.delete(task);
  };
  const completesItself = (input: CreateTaskInput): boolean => (typeof autoComplete === 'function' ? autoComplete(input) : autoComplete);
  const infoOf = ({ input }: StoredTask): TaskInfo => ({
    queue: input.queue,
    name: input.name,
    scheduleTime: new Date(input.scheduleTime.getTime()),
    ...(input.tenantId === undefined || (tenantKeyed && input.tenantId === SYSTEM_TENANT_ID) ? {} : { tenantId: input.tenantId }),
    status: 'pending',
    attempts: 0,
  });

  return {
    kind: 'local',
    calls,
    tasks,
    created,
    done,

    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      record('create', input);
      assertCreateInput(input);
      const failure = failures.find((entry) => entry.remaining > 0 && entry.matches(input));
      if (failure !== undefined) {
        failure.remaining -= 1;
        throw new Error(`fake task port: injected create failure on ${input.queue}/${input.name}`);
      }
      const key = keyOf(input.queue, input.name, tenantOf(input));
      if (tasks.has(key)) return { name: input.name, created: false };
      const task = { input, deleted: false };
      tasks.set(key, task);
      created.push(task);
      if (completesItself(input)) {
        if (paused.has(input.queue)) awaitingResume.add(task);
        else complete(task);
      }
      return { name: input.name, created: true };
    },

    async delete(queue: string, name: string, opts?: { tenantId?: string }): Promise<DeleteTaskResult> {
      record('delete', queue, name, opts);
      // Tenant-keyed without a tenant, the system tenant is searched first and then every other one, as in the local adapter.
      const task =
        liveAt(queue, name, opts?.tenantId) ??
        (tenantKeyed && opts?.tenantId === undefined ? created.find((candidate) => isLive(candidate) && candidate.input.queue === queue && candidate.input.name === name) : undefined);
      if (task === undefined) return { name, deleted: false };
      task.deleted = true;
      awaitingResume.delete(task);
      return { name, deleted: true };
    },

    async list(queue: string, page?: TaskPageRequest): Promise<TaskPage> {
      record('list', queue, page);
      const pageSize = resolvePageSize(page?.pageSize);
      const queued = created.filter((task) => task.input.queue === queue && isLive(task));
      const start = page?.pageToken === undefined ? 0 : Number(page.pageToken);
      const end = start + pageSize;
      const listed = queued.slice(start, end).map(infoOf);
      return end < queued.length ? { tasks: listed, nextPageToken: String(end) } : { tasks: listed };
    },

    async get(queue: string, name: string, opts?: { tenantId?: string }): Promise<TaskInfo | undefined> {
      record('get', queue, name, opts);
      const task = liveAt(queue, name, opts?.tenantId);
      return task === undefined ? undefined : infoOf(task);
    },

    async pauseQueue(queue: string): Promise<void> {
      record('pauseQueue', queue);
      paused.add(queue);
    },

    async resumeQueue(queue: string): Promise<void> {
      record('resumeQueue', queue);
      paused.delete(queue);
      for (const task of [...awaitingResume]) {
        if (task.input.queue === queue) complete(task);
      }
    },

    async queueState(queue: string): Promise<QueueState> {
      record('queueState', queue);
      return { queue, paused: paused.has(queue) };
    },

    async close(): Promise<void> {
      record('close');
    },

    failCreate(target, times = 1) {
      if (target === null) {
        failures.length = 0;
        return;
      }
      const matches = typeof target === 'function' ? target : (input: CreateTaskInput): boolean => target === undefined || input.queue === target;
      failures.push({ matches, remaining: times });
    },

    markDone(name, queue, tenantId) {
      const task = created.find(
        (candidate) =>
          candidate.input.name === name &&
          (queue === undefined || candidate.input.queue === queue) &&
          (tenantId === undefined || tenantOf(candidate.input) === tenantId),
      );
      if (task === undefined) {
        throw new Error(`fake task port holds no task ${tenantId === undefined ? '' : `${tenantId}:`}${queue === undefined ? '' : `${queue}/`}${name}`);
      }
      complete(task);
    },

    clear() {
      calls.length = 0;
      tasks.clear();
      created.length = 0;
      done.clear();
      awaitingResume.clear();
      paused.clear();
      failures.length = 0;
    },
  };
}

/** A RegExp matching a request path to `template`, whose `{name}` segments match one segment each; a RegExp is returned as is. */
export function clientPathPattern(template: string | RegExp): RegExp {
  if (template instanceof RegExp) return template;
  const source = template
    .split(/(\{[^}/]+\})/)
    .map((part) => (/^\{[^}/]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

/** `requestPath` without its query. */
export function pathWithoutQuery(requestPath: string): string {
  const query = requestPath.indexOf('?');
  return query === -1 ? requestPath : requestPath.slice(0, query);
}

/** `sql` with each whitespace run as one space, trimmed. */
export function collapseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Index of the `)` closing the `(` at `open`, skipping text inside any of `quotes`; -1 when unbalanced. */
export function closingParen(text: string, open: number, quotes = "'"): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (quotes.includes(ch)) {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `text` split at commas outside parentheses and text inside any of `quotes`, each part trimmed and empty parts dropped. */
export function splitTopLevel(text: string, quotes = "'"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (quotes.includes(ch)) {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** tenantDbFromPool over a fake pool whose connections answer through `run`; the returned object delegates, as tenantDbFromPool freezes its own. */
export function fakePoolTenantDb<S>(options: FakePoolOptions<S>): FakePoolTenantDb {
  const refuseAfterEnd = options.refuseAfterEnd ?? true;
  let ended = false;
  const refuseIfEnded = (): void => {
    if (ended && refuseAfterEnd) throw new Error(POOL_ENDED_MESSAGE);
  };
  // Structurally the pg.Pool members tenantDbFromPool and its transaction runner call.
  const pool = {
    async connect() {
      refuseIfEnded();
      const session = options.session();
      return {
        async query(input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
          refuseIfEnded();
          const sql = typeof input === 'string' ? input : input.text;
          const params: unknown[] = [...((typeof input === 'string' ? undefined : input.values) ?? values ?? [])];
          return options.run(session, sql, params);
        },
        release: (): void => options.release?.(session),
      };
    },
    async end(): Promise<void> {
      ended = true;
    },
    // tenantDbFromPool subscribes to pool events; no fake connection emits one.
    on: (): void => undefined,
  };
  const base = tenantDbFromPool(pool as unknown as Pool, { schema: options.schema });
  return {
    schema: base.schema,
    withTenant: (tenantId, fn, callOptions) => base.withTenant(tenantId, fn, callOptions),
    withMetadata: (fn, callOptions) => base.withMetadata(fn, callOptions),
    end: () => base.end(),
  };
}
