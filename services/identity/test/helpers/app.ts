/** Shared scaffolding of the identity suites: the app built for `app.inject` over in-memory database, task, publisher, Identity Platform and service-client fakes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeJwt } from 'jose';
import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  ServiceUnavailableError,
  currentRequestContext,
  loadEnv,
  type Clock,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  assertCreateInput,
  outboxSweepQueue,
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
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  authHeadersFor,
  businessClock,
  createCapturingPublisher,
  fixedClock,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type RoleSubject,
} from '@opt2/platform/testing';
import { SERVICE_NAME, buildApp, identityEnvSchema, type IdentityEnv } from '../../src/app.js';
import { USER_CLOSED_WAIT_MS } from '../../src/domain/account-operations.js';
import { CSRF_USED_TTL_HOURS, PENDING_LEGACY_WAIT_MS } from '../../src/domain/csrf.js';
import { DEFAULT_STRIKE_SETTINGS } from '../../src/domain/strikes.js';
import { createLocalTokenSigner, type IdentityPlatformAdapter, type TokenSigner } from '../../src/domain/tokens.js';
import { GATEWAY_SERVICE } from '../../src/legacy/bridge-relay.js';
import {
  createMemoryIdentityRepo,
  createRecordingDb,
  type IdentitySeed,
  type MemoryIdentityRepo,
  type RecordingDb,
  type RecordingDbSeed,
} from './memory-repo.js';
import { ALL_ACTORS, DEFAULT_SEED, type TestActor } from './rows.js';

export { fixedClock };

const STATE_DIR_PREFIX = 'opt2-identity-test-';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Local ports of the callees identity's env names, as `harness/repro/ports.env` fixes them. */
const LOCAL_PORTS = Object.freeze({
  gateway: 8100,
  migration: 8102,
  identity: 8111,
  people: 8112,
  'programs-sites': 8113,
  'strategies-content': 8114,
} as const);

const localUrl = (port: number): string => `http://127.0.0.1:${String(port)}`;

/** Clock every suite shares: local `2026-06-30T12:00:00`, the seed's business date. */
export const TEST_CLOCK: Clock = businessClock();

/** Durations suites step the clock across, derived from the domain's own settings. */
export const TIME_STEPS = Object.freeze({
  strikeBlockMs: DEFAULT_STRIKE_SETTINGS.blockedDurationMinutes * MINUTE_MS,
  csrfUsedTtlMs: CSRF_USED_TTL_HOURS * HOUR_MS,
  pendingLegacyWaitMs: PENDING_LEGACY_WAIT_MS,
  userClosedWaitMs: USER_CLOSED_WAIT_MS,
});

/** A clock frozen `ms` after `from` (default {@link TEST_CLOCK}); a negative `ms` steps back. */
export function clockAfter(ms: number, from: Clock = TEST_CLOCK): Clock {
  return fixedClock(from.now().getTime() + ms);
}

/** Queue of identity's only recurring chain, the outbox sweep. */
export const SWEEP_QUEUE = outboxSweepQueue(SERVICE_NAME);

/** A fresh state directory outside the checkout holding the platform test key pair and push key. */
export async function createTestStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), STATE_DIR_PREFIX));
  await writeTestSecrets(dir);
  return dir;
}

/**
 * The parsed local environment of identity, read from literals and `TZ` only. `OPT2_STATE_DIR` is `stateDir`, else a fresh
 * empty directory; `overrides` merge last, and an override of `undefined` removes the variable. The `PG_*` values are
 * never connected to, since suites inject the database.
 */
export function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}, stateDir?: string): IdentityEnv {
  const source: Record<string, string | undefined> = {
    PORT: String(LOCAL_PORTS.identity),
    OPT2_SERVICE_NAME: SERVICE_NAME,
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2_identity_test',
    PG_USER: 'identity_app',
    PG_PASSWORD: 'unused',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_JWKS_URL: `${localUrl(LOCAL_PORTS.identity)}/.well-known/jwks.json`,
    OPT2_GATEWAY_URL: localUrl(LOCAL_PORTS.gateway),
    OPT2_MIGRATION_URL: localUrl(LOCAL_PORTS.migration),
    OPT2_SERVICE_URLS: JSON.stringify(Object.fromEntries(Object.entries(LOCAL_PORTS).map(([service, port]) => [service, localUrl(port)]))),
    OPT2_STATE_DIR: stateDir ?? ('OPT2_STATE_DIR' in overrides ? undefined : mkdtempSync(path.join(tmpdir(), STATE_DIR_PREFIX))),
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    GOOGLE_CLOUD_PROJECT: 'opt2-local',
    TZ: process.env.TZ ?? 'UTC',
    ...overrides,
  };
  const defined = Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return loadEnv(identityEnvSchema, Object.fromEntries(defined));
}

/** One `mintIdToken` call the fake Identity Platform received. */
export interface IdentityPlatformCall {
  readonly poolSiteId: string | null;
  readonly uid: string;
  readonly customClaims: Readonly<Record<string, unknown>>;
}

/** `IdentityPlatformAdapter` that records each call and mints numbered placeholder ID tokens. */
export interface FakeIdentityPlatform extends IdentityPlatformAdapter {
  readonly calls: IdentityPlatformCall[];
  /** Empties `calls`; token numbering continues. */
  clear(): void;
}

/** Lifetime Identity Platform reports for an ID token, in seconds. */
const FAKE_ID_TOKEN_LIFETIME_S = 3600;

/** Creates a {@link FakeIdentityPlatform}; the n-th call answers `fake-identity-platform-id-token.<n>`. */
export function createFakeIdentityPlatform(): FakeIdentityPlatform {
  const calls: IdentityPlatformCall[] = [];
  let minted = 0;
  return {
    calls,
    mintIdToken(poolSiteId, uid, customClaims) {
      calls.push({ poolSiteId, uid, customClaims: { ...customClaims } });
      minted += 1;
      return Promise.resolve({ idToken: `fake-identity-platform-id-token.${String(minted)}`, expiresIn: FAKE_ID_TOKEN_LIFETIME_S });
    },
    clear() {
      calls.length = 0;
    },
  };
}

/** A task the fake port holds; a deleted task is a tombstone whose name stays reserved. */
export interface FakeTask {
  readonly input: CreateTaskInput;
  readonly deleted: boolean;
}

/** In-memory `TaskPort` keyed by `(queue, name)` that never dispatches. */
export interface FakeTaskPort extends TaskPort {
  readonly kind: 'local';
  /** Every created task by `<queue>/<name>`, tombstones included, in creation order. */
  readonly tasks: ReadonlyMap<string, FakeTask>;
  /** Makes the next `times` creates on `queue`, or on any queue when omitted, throw after their input is checked. */
  failCreate(queue?: string, times?: number): void;
}

interface StoredTask {
  input: CreateTaskInput;
  deleted: boolean;
}

interface CreateFailure {
  queue: string | undefined;
  remaining: number;
}

const taskKey = (queue: string, name: string): string => `${queue}/${name}`;

/** Creates a {@link FakeTaskPort}; a repeated `(queue, name)`, live or deleted, answers `created: false` as ALREADY_EXISTS does. */
export function createFakeTaskPort(): FakeTaskPort {
  const tasks = new Map<string, StoredTask>();
  const paused = new Set<string>();
  const failures: CreateFailure[] = [];

  const live = (queue: string, name: string): StoredTask | undefined => {
    const task = tasks.get(taskKey(queue, name));
    return task === undefined || task.deleted ? undefined : task;
  };
  const infoOf = ({ input }: StoredTask): TaskInfo => ({
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

    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      assertCreateInput(input);
      const failure = failures.find((entry) => entry.remaining > 0 && (entry.queue === undefined || entry.queue === input.queue));
      if (failure !== undefined) {
        failure.remaining -= 1;
        throw new Error(`fake task port: injected create failure on ${input.queue}/${input.name}`);
      }
      const key = taskKey(input.queue, input.name);
      if (tasks.has(key)) return { name: input.name, created: false };
      tasks.set(key, { input, deleted: false });
      return { name: input.name, created: true };
    },

    async delete(queue: string, name: string): Promise<DeleteTaskResult> {
      const task = live(queue, name);
      if (task !== undefined) task.deleted = true;
      return { name, deleted: task !== undefined };
    },

    async list(queue: string, page?: TaskPageRequest): Promise<TaskPage> {
      const pageSize = resolvePageSize(page?.pageSize);
      const queued = [...tasks.values()].filter((task) => task.input.queue === queue && !task.deleted);
      const start = page?.pageToken === undefined ? 0 : Number(page.pageToken);
      const end = start + pageSize;
      const listed = queued.slice(start, end).map(infoOf);
      return end < queued.length ? { tasks: listed, nextPageToken: String(end) } : { tasks: listed };
    },

    async get(queue: string, name: string): Promise<TaskInfo | undefined> {
      const task = live(queue, name);
      return task === undefined ? undefined : infoOf(task);
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

    close: (): Promise<void> => Promise.resolve(),

    failCreate(queue, times = 1) {
      failures.push({ queue, remaining: times });
    },
  };
}

/** Answers one service call. */
export type ClientHandler = (req: ServiceRequest) => ServiceResponse | Promise<ServiceResponse>;

/** Handlers per callee: one for every call, or several keyed `'<METHOD> <path>'`, where a `{name}` segment matches any one segment. */
export type ClientHandlers = Readonly<Record<string, ClientHandler | Readonly<Record<string, ClientHandler>>>>;

/** A request path to match: a template whose `{name}` segments match one segment each, or a RegExp tested on the path. */
export type PathMatcher = string | RegExp;

/** One mark-used relay the default gateway handler applied; `sid` is decoded from the path. */
export interface MarkedUsed {
  readonly sid: string;
  readonly tokens: ReadonlyArray<{ readonly token: string; readonly usedAt: string }>;
}

/** Fake service client: records each call, then answers from the newest matching handler, else from the gateway and people defaults. */
export interface ClientRecorder extends ServiceClient {
  readonly requests: ServiceRequest[];
  readonly markedUsed: MarkedUsed[];
  /** Recorded calls to `service`, optionally only those whose path matches `path`. */
  requestsTo(service: string, path?: PathMatcher): ServiceRequest[];
  /** Adds a handler above every earlier handler and the defaults. */
  on(service: string, method: ServiceRequest['method'], path: PathMatcher, handler: ClientHandler): void;
  /** Makes the next call to `service` whose path matches `path` throw `ServiceUnavailableError` once it is recorded. */
  failNext(service: string, path: PathMatcher): void;
  /** Empties `requests` and `markedUsed`; handlers and pending failures stay. */
  clear(): void;
  /** Makes every later call throw, as a closed client's would. */
  close(): Promise<void>;
  /**
   * Patches `request` and `close` onto `app.opt2.client` in place, since the routes and the bridge relay hold that object
   * from registration; the patched `close` still closes the client it replaced.
   */
  install(app: FastifyInstance): void;
}

interface ClientRoute {
  readonly service: string;
  /** Undefined matches every method. */
  readonly method: ServiceRequest['method'] | undefined;
  readonly pattern: RegExp;
  readonly handler: ClientHandler;
}

interface PendingFailure {
  readonly service: string;
  readonly pattern: RegExp;
}

/** Callee name of people in `OPT2_SERVICE_URLS`. */
const PEOPLE_SERVICE = 'people';
const CURRENT_USER_PATH = '/internal/v1/users/current';
const MARK_USED_PATH = /^\/internal\/v1\/legacy-sessions\/([^/]+):mark-used$/;
const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
const ANY_PATH = /^/;
const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'content-type': 'application/json;charset=utf-8' });

/** Seeded actors by upper-cased `UserID`, the people rows the default current-user read answers. */
const ACTORS_BY_USER_ID: ReadonlyMap<string, TestActor> = new Map(ALL_ACTORS.map((actor) => [actor.account.userid.toUpperCase(), actor]));

function matcherPattern(matcher: PathMatcher): RegExp {
  if (matcher instanceof RegExp) return matcher;
  const source = matcher
    .split(/(\{[^}/]+\})/)
    .map((part) => (/^\{[^}/]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

function pathOnly(requestPath: string): string {
  const query = requestPath.indexOf('?');
  return query === -1 ? requestPath : requestPath.slice(0, query);
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `sub` of the call's user token: the explicit `userToken`, else the request context's verified user; undefined without one. */
function requestedUserId(req: ServiceRequest): string | undefined {
  if (req.userToken === null) return undefined;
  if (typeof req.userToken === 'string') {
    const { sub } = decodeJwt(req.userToken);
    return sub;
  }
  return currentRequestContext()?.user?.sub;
}

/** People's serialization of a seeded actor's person columns; NULL reads as ''. */
function personData(actor: TestActor): Record<string, unknown> {
  const { account, contact } = actor;
  return {
    id: account.userid,
    userid: account.userid,
    siteid: actor.siteId,
    fname: contact.fname ?? '',
    lname: contact.lname ?? '',
    email: contact.email ?? '',
    company: contact.company ?? '',
    subtype: contact.subtype ?? 'Default',
    isnew: 0,
    entityname: 'user',
  };
}

/** The new user bean people's `readCurrentUser` answers for an unknown or absent user, rather than a 404: a fresh id under the call's site. */
function newUserData(siteId: string): Record<string, unknown> {
  const id = cfUuid();
  return { id, userid: id, siteid: siteId, fname: '', lname: '', email: '', company: '', subtype: 'Default', isnew: 1, entityname: 'user' };
}

/** Creates a {@link ClientRecorder} over `handlers`, which rank below handlers added later through `on`. */
export function createClientRecorder(handlers: ClientHandlers = {}): ClientRecorder {
  const requests: ServiceRequest[] = [];
  const markedUsed: MarkedUsed[] = [];
  const routes: ClientRoute[] = [];
  const failures: PendingFailure[] = [];
  let closed = false;

  for (const [service, entry] of Object.entries(handlers)) {
    if (typeof entry === 'function') {
      routes.push({ service, method: undefined, pattern: ANY_PATH, handler: entry });
      continue;
    }
    for (const [key, handler] of Object.entries(entry)) {
      const parsed = ROUTE_KEY.exec(key);
      if (parsed?.[1] === undefined || parsed[2] === undefined) throw new TypeError(`client handler key must be '<METHOD> <path>': ${key}`);
      routes.push({ service, method: parsed[1] as ServiceRequest['method'], pattern: matcherPattern(parsed[2]), handler });
    }
  }

  const defaults: readonly ClientRoute[] = [
    {
      service: GATEWAY_SERVICE,
      method: 'POST',
      pattern: MARK_USED_PATH,
      handler: (req) => {
        const sid = decodeURIComponent(MARK_USED_PATH.exec(pathOnly(req.path))?.[1] ?? '');
        const { tokens } = req.json as { tokens: Array<{ token: string; usedAt: string }> };
        markedUsed.push({ sid, tokens: tokens.map(({ token, usedAt }) => ({ token, usedAt })) });
        return { status: 204, headers: {}, body: undefined };
      },
    },
    {
      service: PEOPLE_SERVICE,
      method: 'GET',
      pattern: matcherPattern(CURRENT_USER_PATH),
      handler: (req) => {
        const userId = requestedUserId(req);
        const actor = userId === undefined ? undefined : ACTORS_BY_USER_ID.get(userId.toUpperCase());
        const data = actor === undefined ? newUserData(firstValue(req.query?.siteid) ?? '') : personData(actor);
        return { status: 200, headers: { ...JSON_HEADERS }, body: { data } };
      },
    },
  ];

  const matches = (route: ClientRoute, req: ServiceRequest): boolean =>
    route.service === req.service && (route.method === undefined || route.method === req.method) && route.pattern.test(pathOnly(req.path));

  async function request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (closed) throw new Error(`client recorder: closed before ${req.service} ${req.method} ${req.path}`);
    requests.push(req);
    const failure = failures.findIndex((entry) => entry.service === req.service && entry.pattern.test(pathOnly(req.path)));
    if (failure !== -1) {
      failures.splice(failure, 1);
      const refused = Object.assign(new Error(`connect ECONNREFUSED (${req.service})`), { code: 'ECONNREFUSED' });
      throw new ServiceUnavailableError(req.service, refused);
    }
    const route = routes.findLast((candidate) => matches(candidate, req)) ?? defaults.find((candidate) => matches(candidate, req));
    if (route === undefined) throw new Error(`client recorder: no handler for ${req.service} ${req.method} ${req.path}`);
    return (await route.handler(req)) as ServiceResponse<T>;
  }

  async function close(): Promise<void> {
    closed = true;
  }

  return {
    requests,
    markedUsed,
    request,
    close,
    requestsTo(service, matcher) {
      const pattern = matcher === undefined ? ANY_PATH : matcherPattern(matcher);
      return requests.filter((req) => req.service === service && pattern.test(pathOnly(req.path)));
    },
    on(service, method, matcher, handler) {
      routes.push({ service, method, pattern: matcherPattern(matcher), handler });
    },
    failNext(service, matcher) {
      failures.push({ service, pattern: matcherPattern(matcher) });
    },
    clear() {
      requests.length = 0;
      markedUsed.length = 0;
    },
    install(app) {
      const target = app.opt2.client;
      const replaced = target.close.bind(target);
      Object.assign(target, {
        request,
        close: async (): Promise<void> => {
          await close();
          await replaced();
        },
      });
    },
  };
}

/** Options of {@link buildTestApp}; it creates every fake it is not given. */
export interface BuildTestAppOptions<
  D extends TenantDb = RecordingDb,
  P extends TaskPort = FakeTaskPort,
  I extends IdentityPlatformAdapter = FakeIdentityPlatform,
> {
  /** Merged last into {@link testEnv}; `undefined` removes a variable. */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  /** Replaces the recording database, for example with a throwaway schema's `app`. */
  db?: D;
  /** Rows of the memory repository; every canonical actor by default. */
  seed?: IdentitySeed;
  /** Gates of the recording database; ignored with `db`. */
  gates?: RecordingDbSeed['gates'];
  handlers?: ClientHandlers;
  identityPlatform?: I;
  taskPort?: P;
}

/** An identity app, not yet ready, and the fakes behind it. */
export interface TestApp<D extends TenantDb = RecordingDb, P extends TaskPort = FakeTaskPort, I extends IdentityPlatformAdapter = FakeIdentityPlatform> {
  app: FastifyInstance;
  env: IdentityEnv;
  publisher: CapturingPublisher;
  taskPort: P;
  client: ClientRecorder;
  db: D;
  /** Serves domain-level calls beside `db`; the app's own repository reads and writes through `db`. */
  repo: MemoryIdentityRepo;
  identityPlatform: I;
  signer: TokenSigner;
  clock: Clock;
  /** Holds the platform test secrets; removed when the app closes. */
  stateDir: string;
}

/**
 * Builds identity over the fakes and installs the client recorder; callers run `ready` and `close`. A failed build
 * removes the state directory it created and rethrows.
 */
export function buildTestApp<
  D extends TenantDb = RecordingDb,
  P extends TaskPort = FakeTaskPort,
  I extends IdentityPlatformAdapter = FakeIdentityPlatform,
>(opts?: BuildTestAppOptions<D, P, I>): Promise<TestApp<D, P, I>>;
export async function buildTestApp(
  opts: BuildTestAppOptions<TenantDb, TaskPort, IdentityPlatformAdapter> = {},
): Promise<TestApp<TenantDb, TaskPort, IdentityPlatformAdapter>> {
  const stateDir = await createTestStateDir();
  const removeStateDir = (): void => {
    rmSync(stateDir, { recursive: true, force: true });
  };
  try {
    const env = testEnv(opts.env, stateDir);
    const clock = opts.clock ?? TEST_CLOCK;
    const db = opts.db ?? createRecordingDb({ gates: opts.gates });
    const repo = createMemoryIdentityRepo(opts.seed ?? DEFAULT_SEED, { clock });
    const publisher = createCapturingPublisher();
    const taskPort = opts.taskPort ?? createFakeTaskPort();
    const identityPlatform = opts.identityPlatform ?? createFakeIdentityPlatform();
    const client = createClientRecorder(opts.handlers);
    const signer = createLocalTokenSigner({ stateDir });

    const app = await buildApp({ env, clock, verifierOverride: testVerifier(), db, publisher, taskPort, identityPlatform, signer });
    app.addHook('onClose', async () => {
      removeStateDir();
    });
    client.install(app);
    return { app, env, publisher, taskPort, client, db, repo, identityPlatform, signer, clock, stateDir };
  } catch (err) {
    removeStateDir();
    throw err;
  }
}

/** Options of {@link headersFor}. */
export interface HeadersForOptions {
  /** Site of a user token; `tenant-a` by default. */
  site?: string;
  /** Callee of the invocation credential; identity by default. */
  audience?: string;
  /** Masa `UserID` of a user token; one per subject by default. */
  sub?: string;
}

function roleSubjectNamed(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return found;
}

/** `app.inject` headers presenting `subject`, or the `ROLE_SET` subject of that name, to identity; rejects with TypeError for an unknown name. */
export async function headersFor(subject: RoleSubject | string, opts: HeadersForOptions = {}): Promise<Record<string, string>> {
  const resolved = typeof subject === 'string' ? roleSubjectNamed(subject) : subject;
  return authHeadersFor(resolved, {
    site: opts.site ?? TENANT_A.siteId,
    audience: opts.audience ?? SERVICE_NAME,
    ...(opts.sub === undefined ? {} : { sub: opts.sub }),
  });
}
