/** Shared scaffolding of the identity suites: the app built for `app.inject` over in-memory database, task, publisher, Identity Platform and service-client fakes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeJwt } from '@opt2/platform/auth';
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
import { outboxSweepQueue, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  CLIENT_ROUTE_KEY,
  businessClock,
  clientPathPattern,
  createCapturingPublisher,
  createFakeTaskPort,
  createHeadersFor,
  createTestStateDir as sharedCreateTestStateDir,
  fixedClock,
  localTestEnv,
  localTestUrl,
  pathWithoutQuery,
  testVerifier,
  type CapturingPublisher,
  type ClientHandler,
  type FakeTaskPort,
} from '@opt2/platform/testing';
import { SERVICE_NAME, buildApp, identityEnvSchema, type IdentityEnv } from '../../src/app.js';
import { USER_CLOSED_WAIT_MS } from '../../src/domain/account-operations.js';
import { CSRF_USED_TTL_HOURS, PENDING_LEGACY_WAIT_MS } from '../../src/domain/csrf.js';
import { DEFAULT_STRIKE_SETTINGS } from '../../src/domain/strikes.js';
import { createLocalTokenSigner, type IdentityPlatformAdapter, type TokenSigner } from '../../src/domain/tokens.js';
import { GATEWAY_SERVICE } from '../../src/legacy/bridge-relay.js';
import type { SiteMailSettings } from '../../src/legacy/sites-client.js';
import {
  createMemoryIdentityRepo,
  createRecordingDb,
  type IdentitySeed,
  type MemoryIdentityRepo,
  type RecordingDb,
  type RecordingDbSeed,
} from './memory-repo.js';
import { ALL_ACTORS, DEFAULT_SEED, type TestActor } from './rows.js';

export { createFakeTaskPort, fixedClock, type ClientHandler, type FakeTaskPort };

const STATE_DIR_PREFIX = 'opt2-identity-test-';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

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

/** Overrides that turn the local database settings into the cloud's IAM ones; suites still inject the database. */
export const CLOUD_DB_OVERRIDES: Readonly<Record<string, string | undefined>> = Object.freeze({
  OPT2_DB_AUTH: 'iam',
  CLOUD_SQL_INSTANCE: 'opt2-test:us-central1:opt2',
  PG_PASSWORD: undefined,
});

/** A fresh state directory under the OS temp directory holding the platform test key pair and push key. */
export const createTestStateDir = (): Promise<string> => sharedCreateTestStateDir(STATE_DIR_PREFIX);

/** Identity's parsed local environment; `OPT2_STATE_DIR` is `stateDir`, else a fresh empty directory, and an `undefined` override removes a variable. */
export function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}, stateDir?: string): IdentityEnv {
  const urls = { OPT2_GATEWAY_URL: localTestUrl('gateway'), OPT2_MIGRATION_URL: localTestUrl('migration') };
  const options = {
    service: SERVICE_NAME,
    database: { name: 'opt2_identity_test', user: 'identity_app' },
    callees: ['gateway', 'migration', 'identity', 'people', 'programs-sites', 'strategies-content'],
    stateDir: () => stateDir ?? mkdtempSync(path.join(tmpdir(), STATE_DIR_PREFIX)),
    extra: { ...urls, OPT2_STORAGE_ADAPTER: 'local', GOOGLE_CLOUD_PROJECT: 'opt2-local', TZ: process.env.TZ ?? 'UTC' },
  };
  return loadEnv(identityEnvSchema, localTestEnv(options, overrides));
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

/** Handlers per callee: one for every call, or several keyed `'<METHOD> <path>'`, where a `{name}` segment matches any one segment. */
export type ClientHandlers = Readonly<Record<string, ClientHandler | Readonly<Record<string, ClientHandler>>>>;

/** A request path to match: a template whose `{name}` segments match one segment each, or a RegExp tested on the path. */
export type PathMatcher = string | RegExp;

/** One mark-used relay the default gateway handler applied; `sid` is decoded from the path. */
export interface MarkedUsed {
  readonly sid: string;
  readonly tokens: ReadonlyArray<{ readonly token: string; readonly usedAt: string }>;
}

/** Fake service client: records each call, then answers from the newest matching handler, else from the gateway, people and programs-sites defaults. */
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
const SITES_SERVICE = 'programs-sites';
const MAIL_SETTINGS_PATH = '/internal/v1/sites/mail-settings:lookup';
const MARK_USED_PATH = /^\/internal\/v1\/legacy-sessions\/([^/]+):mark-used$/;
const ANY_PATH = /^/;
const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'content-type': 'application/json;charset=utf-8' });

/** Seeded actors by upper-cased `UserID`, the people rows the default current-user read answers. */
const ACTORS_BY_USER_ID: ReadonlyMap<string, TestActor> = new Map(ALL_ACTORS.map((actor) => [actor.account.userid.toUpperCase(), actor]));

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

/** programs-sites' mail settings of a local site under `siteId` (`default` for ''), named `Site <id>`, with the bean's defaults. */
export function siteMailSettingsOf(siteId: string): SiteMailSettings {
  const siteID = siteId === '' ? 'default' : siteId;
  return {
    siteID,
    site: `Site ${siteID}`,
    contact: '',
    sendLoginScript: '',
    editProfileURL: '?display=editProfile',
    extranetSSL: false,
    useSSL: false,
    extranetPublicRegNotify: '',
    remote: null,
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
      const parsed = CLIENT_ROUTE_KEY.exec(key);
      if (parsed?.[1] === undefined || parsed[2] === undefined) throw new TypeError(`client handler key must be '<METHOD> <path>': ${key}`);
      routes.push({ service, method: parsed[1] as ServiceRequest['method'], pattern: clientPathPattern(parsed[2]), handler });
    }
  }

  const defaults: readonly ClientRoute[] = [
    {
      service: GATEWAY_SERVICE,
      method: 'POST',
      pattern: MARK_USED_PATH,
      handler: (req) => {
        const sid = decodeURIComponent(MARK_USED_PATH.exec(pathWithoutQuery(req.path))?.[1] ?? '');
        const { tokens } = req.json as { tokens: Array<{ token: string; usedAt: string }> };
        markedUsed.push({ sid, tokens: tokens.map(({ token, usedAt }) => ({ token, usedAt })) });
        return { status: 204, headers: {}, body: undefined };
      },
    },
    {
      service: PEOPLE_SERVICE,
      method: 'GET',
      pattern: clientPathPattern(CURRENT_USER_PATH),
      handler: (req) => {
        const userId = requestedUserId(req);
        const actor = userId === undefined ? undefined : ACTORS_BY_USER_ID.get(userId.toUpperCase());
        const data = actor === undefined ? newUserData(firstValue(req.query?.siteid) ?? '') : personData(actor);
        return { status: 200, headers: { ...JSON_HEADERS }, body: { data } };
      },
    },
    {
      service: SITES_SERVICE,
      method: 'POST',
      pattern: clientPathPattern(MAIL_SETTINGS_PATH),
      handler: (req) => {
        const { siteIds } = req.json as { siteIds: string[] };
        return { status: 200, headers: { ...JSON_HEADERS }, body: { items: siteIds.map(siteMailSettingsOf) } };
      },
    },
  ];

  const matches = (route: ClientRoute, req: ServiceRequest): boolean =>
    route.service === req.service && (route.method === undefined || route.method === req.method) && route.pattern.test(pathWithoutQuery(req.path));

  async function request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (closed) throw new Error(`client recorder: closed before ${req.service} ${req.method} ${req.path}`);
    requests.push(req);
    const failure = failures.findIndex((entry) => entry.service === req.service && entry.pattern.test(pathWithoutQuery(req.path)));
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
      const pattern = matcher === undefined ? ANY_PATH : clientPathPattern(matcher);
      return requests.filter((req) => req.service === service && pattern.test(pathWithoutQuery(req.path)));
    },
    on(service, method, matcher, handler) {
      routes.push({ service, method, pattern: clientPathPattern(matcher), handler });
    },
    failNext(service, matcher) {
      failures.push({ service, pattern: clientPathPattern(matcher) });
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

/** `app.inject` headers presenting a subject, or the `ROLE_SET` subject of that name, to identity, with tenant-a user tokens by default. */
export const headersFor = createHeadersFor({ audience: SERVICE_NAME });
