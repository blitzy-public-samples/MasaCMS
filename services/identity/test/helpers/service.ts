/** Test-only composition of the identity service: createService and every implemented register* route function over the memory repository, a recording database and recording outbound ports. */
import { decodeJwt } from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INVOCATION_HEADER, Roles, moduleRole } from '@opt2/platform/auth';
import type { EventEnvelope } from '@opt2/platform/events';
import { createLogger, type Logger } from '@opt2/platform/logging';
import { registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import {
  createService,
  loadEnv,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { tenantIdForSite, type QueryResultRow } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  createCapturingPublisher,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  otherTenantSite,
  registryPayloads,
  testVerifier,
  writeTestSecrets,
  type RoleSubject,
} from '@opt2/platform/testing';
import { createAccountReads } from '../../src/domain/account-reads.js';
import { issueTokens } from '../../src/domain/csrf.js';
import { DEFAULT_LOGIN_SETTINGS, type LoginDeps } from '../../src/domain/login.js';
import { DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS, type LoginMailDeps, type LoginMailSiteSettings } from '../../src/domain/login-mail.js';
import { createTokenService } from '../../src/domain/tokens.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import type { BridgeRelay, LegacyUsedToken } from '../../src/legacy/bridge-relay.js';
import { createContentClient } from '../../src/legacy/content-client.js';
import { registerAdminGroupRoutes } from '../../src/routes/admin-groups.js';
import { registerAdminOAuthClientRoutes } from '../../src/routes/admin-oauth-clients.js';
import { registerAdminPermissionRoutes } from '../../src/routes/admin-permissions.js';
import { registerAdminSessionRoutes } from '../../src/routes/admin-sessions.js';
import { registerAccountReadRoutes } from '../../src/routes/internal-account-reads.js';
import { registerAccountRoutes } from '../../src/routes/internal-accounts.js';
import { registerCsrfRoutes } from '../../src/routes/internal-csrf.js';
import { registerSessionRoutes } from '../../src/routes/internal-sessions.js';
import { registerTokenRoutes } from '../../src/routes/internal-tokens.js';
import { registerLegacyApiRoutes, type LegacyApiSettings } from '../../src/routes/legacy-api.js';
import { createMemoryIdentityRepo, createRecordingDb, type IdentitySeed, type MemoryIdentityRepo, type RecordingDb } from './memory-repo.js';
import {
  ADMIN_S2,
  DEFAULT_SEED,
  EDITOR,
  MEMBER_B,
  POOLED_MEMBER,
  SITE_ADMIN_A,
  SYNTHETIC_MEMBERS,
  loginSnapshotFixture,
  sessionRow,
  type TestActor,
} from './rows.js';

/** The service's own name, the audience of every invocation credential it accepts. */
export const SERVICE = 'identity';

/** The business instant every clock-driven value of the suites is computed at. */
export const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);

export const CLOCK = fixedClock(NOW);

/** The site every matrix request addresses; user tokens name it unless a subject says otherwise. */
export const SITE_A = TENANT_A.siteId;

/** The installed site, registered beside the three platform fixtures. */
export const DEFAULT_SITE = 'default';

/** configBean values of the JSON API routes, fixed so no `MURA_*` variable of the host is read. */
export const LEGACY_SETTINGS: LegacyApiSettings = Object.freeze({ adminSSL: false, context: '', appReloadKey: 'appreload', adminDomain: '' });

const USERS_MODULE_ROLE = moduleRole('00000000000000000000000000000000008');
const SITE_MANAGER_MODULE_ROLE = moduleRole('00000000000000000000000000000000000');

/** Identity's declared module role beside the platform matrix: the Users grant alone, and with the Site Manager grant cUsers also requires. */
export const MODULE_SUBJECTS: readonly RoleSubject[] = Object.freeze([
  Object.freeze({ name: 'users-module', kind: 'user', roles: Object.freeze([Roles.systemUser, USERS_MODULE_ROLE]) }),
  Object.freeze({
    name: 'users-and-site-manager',
    kind: 'user',
    roles: Object.freeze([Roles.systemUser, USERS_MODULE_ROLE, SITE_MANAGER_MODULE_ROLE]),
  }),
] satisfies RoleSubject[]);

/** Every subject the suites present: the platform ROLE_SET, then identity's module subjects. */
export const SUBJECTS: readonly RoleSubject[] = Object.freeze([...ROLE_SET, ...MODULE_SUBJECTS]);

/** The subject named `name`; throws for a name neither set holds. */
export function subjectNamed(name: string): RoleSubject {
  const subject = SUBJECTS.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`No subject named ${name}`);
  return subject;
}

/** The seeded actor whose rows and login snapshot stand behind a user subject's session. */
function actorOf(subject: RoleSubject): TestActor {
  if (subject.name === 's2') return ADMIN_S2;
  if (subject.name === 'member') return POOLED_MEMBER;
  if (subject.name === 'site-admin') return SITE_ADMIN_A;
  if (subject.name === 'other-tenant') return MEMBER_B;
  return SYNTHETIC_MEMBERS[subject.name] ?? EDITOR;
}

/** A 35-character CF UUID numbered `n` under the hex digit `prefix`. */
export function cfId(prefix: string, n: number): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

/** The signed-in session a user subject's token names: its id, user, tenant and CSRF secret. */
export interface SubjectSession {
  sessionId: string;
  userId: string;
  tenantId: string;
  csrfSecret: string;
  actor: TestActor;
}

/** The seeded session of each user subject, keyed by subject name. */
export const SUBJECT_SESSIONS: Readonly<Record<string, SubjectSession>> = Object.freeze(
  Object.fromEntries(
    SUBJECTS.filter((subject) => subject.kind === 'user').map((subject, index) => {
      const actor = actorOf(subject);
      return [
        subject.name,
        Object.freeze({
          sessionId: `S-${subject.name}`,
          userId: actor.account.userid,
          tenantId: actor.tenant.tenantId,
          csrfSecret: cfId('5', index + 1),
          actor,
        }),
      ];
    }),
  ),
);

/** The session row a subject session is stored as: active, signed in, with the actor's login-time snapshot. */
function subjectSessionRow(session: SubjectSession) {
  return sessionRow({
    tenant_id: session.tenantId,
    session_id: session.sessionId,
    user_id: session.userId,
    site_id: SITE_A,
    login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: session.actor })),
    csrf_secret: session.csrfSecret,
  });
}

/** The canonical actors' rows plus the signed-in session of every user subject. */
export function defaultSeed(extra: IdentitySeed = {}): IdentitySeed {
  return {
    ...DEFAULT_SEED,
    ...extra,
    sessions: [...Object.values(SUBJECT_SESSIONS).map(subjectSessionRow), ...(extra.sessions ?? [])],
  };
}

/**
 * A CSRF token and expiry for `context` under a session's secret, issued `laterMs` after the suites' clock; tokens are
 * deterministic per instant, so a second use of one context needs a later issue.
 */
export function csrfFor(session: Pick<SubjectSession, 'csrfSecret'>, context: string, laterMs = 0): { token: string; expires: string } {
  return issueTokens({ csrfSecret: session.csrfSecret }, { context, clock: fixedClock(new Date(NOW.getTime() + laterMs)) });
}

/** `tenant_registry` rows of the three platform fixtures and the installed `default` site, which owns every pool. */
export const REGISTRY_ROWS: readonly QueryResultRow[] = Object.freeze(
  [...registryPayloads(), { siteId: DEFAULT_SITE, contentPoolIds: [DEFAULT_SITE], domains: ['localhost'] }].map((payload) => {
    const pool = (value: string | null | undefined): string => value ?? payload.siteId;
    const pools = {
      public_user_pool: pool(payload.publicUserPoolId),
      private_user_pool: pool(payload.privateUserPoolId),
      category_pool: pool(payload.categoryPoolId),
      file_pool: pool(payload.filePoolId),
      display_pool: pool(payload.displayPoolId),
    };
    const content = [payload.contentPoolIds ?? []].flat();
    return Object.freeze({
      site_id: payload.siteId,
      tenant_id: tenantIdForSite(payload.siteId),
      ...Object.fromEntries(Object.entries(pools).flatMap(([column, site]) => [[`${column}_id`, site], [`${column}_tenant`, tenantIdForSite(site)]])),
      content_pool_ids: content,
      content_pool_tenants: content.map((site) => tenantIdForSite(site)),
      domains: payload.domains ?? [],
      aggregate_version: '1',
      updated_at: NOW,
    });
  }),
);

/** Answers every registry read of `@opt2/platform/tenancy` from REGISTRY_ROWS, by its WHERE clause. */
export function registryAnswer(sql: string, values: readonly unknown[]): QueryResultRow[] {
  const [first] = values;
  const sorted = [...REGISTRY_ROWS].sort((a, b) => String(a.site_id).localeCompare(String(b.site_id), 'en'));
  let rows = sorted;
  if (/WHERE lower\(site_id\) = lower\(\$1\)/.test(sql)) rows = sorted.filter((row) => String(row.site_id).toLowerCase() === String(first).toLowerCase());
  else if (/WHERE public_user_pool_tenant = \$1 OR private_user_pool_tenant = \$1/.test(sql)) {
    rows = sorted.filter((row) => row.public_user_pool_tenant === first || row.private_user_pool_tenant === first);
  } else if (/WHERE tenant_id = \$1/.test(sql)) rows = sorted.filter((row) => row.tenant_id === first);
  const pooled = /SELECT (\w+) AS pool_tenant/.exec(sql)?.[1];
  return rows.map((row) => (pooled === undefined ? { ...row } : { ...row, pool_tenant: row[pooled] }));
}

/** A ServiceClient that records each call and answers with `answer`. */
export interface RecordingClient extends ServiceClient {
  readonly calls: ServiceRequest[];
  answer: ServiceResponse;
}

function recordingClient(): RecordingClient {
  const client: RecordingClient = {
    calls: [],
    answer: { status: 200, headers: {}, body: { apiversion: 'v1', method: 'findOne', data: {} } },
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      client.calls.push(req);
      return Promise.resolve(client.answer as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };
  return client;
}

/** strategies-content's `lookupFileExtensions` over the stored `files` (file id to `fileEXT`), recording each call. */
export interface RecordingContent extends ServiceClient {
  readonly calls: ServiceRequest[];
  readonly files: Map<string, string | null>;
}

function recordingContent(): RecordingContent {
  const content: RecordingContent = {
    calls: [],
    files: new Map(),
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      content.calls.push(req);
      if (req.service !== 'strategies-content' || req.method !== 'POST' || req.path !== '/internal/v1/files:lookup') {
        return Promise.reject(new Error(`unexpected request ${req.service} ${req.method} ${req.path}`));
      }
      const { fileIds } = req.json as { fileIds: string[] };
      const items = fileIds.flatMap((fileId) => (content.files.has(fileId) ? [{ fileId, fileExt: content.files.get(fileId) ?? null }] : []));
      return Promise.resolve({ status: 200, headers: {}, body: { items } as T });
    },
    close: () => Promise.resolve(),
  };
  return content;
}

/** A BridgeRelay that records each mark-used relay and reports it applied. */
export interface RecordingRelay extends BridgeRelay {
  readonly calls: Array<{ sessionId: string; tokens: readonly LegacyUsedToken[] }>;
}

function recordingRelay(): RecordingRelay {
  const relay: RecordingRelay = {
    calls: [],
    markUsed(sessionId, tokens) {
      relay.calls.push({ sessionId, tokens });
      return Promise.resolve({ applied: true });
    },
  };
  return relay;
}

/** `validateEmail`'s outbound fetch, recording each URL and failing as an unreachable host does. */
export interface RecordingFetch {
  readonly calls: string[];
  readonly fetch: typeof globalThis.fetch;
}

function recordingFetch(): RecordingFetch {
  const calls: string[] = [];
  return {
    calls,
    fetch: (input) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.reject(new TypeError('fetch failed'));
    },
  };
}

/** Login-mail settings answering every site by name. */
function mailSettings(): LoginMailDeps['settings'] {
  const site = (siteId: string): LoginMailSiteSettings => ({
    site: `Site ${siteId}`,
    contact: 'contact@example.test',
    sendLoginScript: '',
    editProfileURL: '',
    extranetSSL: false,
    useSSL: false,
    serverPort: '',
    context: '',
    extranetPublicRegNotify: '',
  });
  return {
    global: () => ({ ...DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS, title: 'Masa Admin' }),
    site,
    urlStem: (siteId, filename) => `/${siteId}/${filename}`,
  };
}

/** Effects handlers leave, counted since the last `resetEffects`. */
export interface Effects {
  statements: number;
  writes: number;
  repoWrites: number;
  events: number;
  relayed: number;
  /** Service calls to people and strategies-content. */
  calls: number;
  fetches: number;
}

/** The composed service and the recorders behind it. */
export interface IdentityTestApp {
  app: FastifyInstance;
  db: RecordingDb;
  repo: MemoryIdentityRepo;
  relay: RecordingRelay;
  people: RecordingClient;
  content: RecordingContent;
  outbound: RecordingFetch;
  /** Envelopes written to `identity.outbox` by committed transactions, in commit order. */
  outboxEvents(): EventEnvelope[];
  /** Forgets every recorded statement, write, relay and call; stored rows stay. */
  resetEffects(): void;
  effects(): Effects;
  close(): Promise<void>;
}

const BCRYPT_TEST_ROUNDS = 4;
const noSleep = (): Promise<void> => Promise.resolve();

function quietLogger(): Logger {
  return createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });
}

/** Options of {@link buildIdentityApp}; `ready: false` leaves the instance open to further registrations. */
export interface BuildOptions {
  ready?: boolean;
}

/** Builds the identity service with every implemented route family registered; `seed` defaults to `defaultSeed()`. */
export async function buildIdentityApp(seed: IdentitySeed = defaultSeed(), opts: BuildOptions = {}): Promise<IdentityTestApp> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-gates-'));
  await writeTestSecrets(stateDir);
  const env = loadEnv(undefined, {
    PORT: '8111',
    OPT2_SERVICE_NAME: SERVICE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: stateDir,
    TZ: 'UTC',
  });
  const db = createRecordingDb();
  // clear() drops responders, so the registry answer is installed again after every reset.
  const answerRegistry = (): void => db.respond(/FROM identity\.tenant_registry\b/, registryAnswer);
  answerRegistry();
  const repo = createMemoryIdentityRepo(seed, { clock: CLOCK });
  const events = createIdentityEvents(repo);
  const relay = recordingRelay();
  const people = recordingClient();
  const content = recordingContent();
  const outbound = recordingFetch();
  const logger = quietLogger();
  createOutbox({ service: SERVICE, db, publisher: createCapturingPublisher(), logger, clock: CLOCK, payloadValidators: identityPayloadValidators });

  const app = await createService({ name: SERVICE, version: '1.0.0', env, verifierOverride: testVerifier(SERVICE), logger });
  registerWritePositionHeader(app);
  const password = { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: BCRYPT_TEST_ROUNDS };
  const sessions = { db, repo, clock: CLOCK };
  const login: LoginDeps = { db, repo, clock: CLOCK, settings: { ...DEFAULT_LOGIN_SETTINGS, password: { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: BCRYPT_TEST_ROUNDS } }, sleep: noSleep };
  const csrf = { db, repo, bridge: relay, clock: CLOCK, sleep: noSleep };
  const groups = { db, repo, events, clock: CLOCK, settings: { password, hashAlgorithm: 'CFMX_COMPAT' as const }, sleep: noSleep };
  const oauth = { db, repo, clock: CLOCK };
  const rest = { oauth, login, sessions };
  const permissions = { db, repo, events };

  await registerAdminSessionRoutes(app, {
    login,
    sessions,
    csrf,
    loginMail: { db, repo, events, clock: CLOCK, settings: mailSettings(), sleep: noSleep },
    permissions,
    db,
  });
  await registerAdminGroupRoutes(app, { groups, content: createContentClient(content), sessions, csrf });
  await registerAdminPermissionRoutes(app, { permissions, reverseLookup: { db, repo }, csrf });
  await registerAdminOAuthClientRoutes(app, { oauth, sessions, csrf });
  await registerTokenRoutes(app, { tokens: createTokenService({ env, clock: CLOCK, db, repo }), rest });
  await registerSessionRoutes(app, { sessions });
  await registerCsrfRoutes(app, { csrf });
  await registerAccountRoutes(app, { accounts: { db, repo, events, clock: CLOCK, sleep: noSleep } });
  await registerAccountReadRoutes(app, { db, accountReads: createAccountReads({ repo, clock: CLOCK, closedUserWaitMs: 0, gateWaitMs: 0 }) });
  await registerLegacyApiRoutes(app, { groups, login, sessions, csrf, rest, client: people, db, fetch: outbound.fetch, legacy: LEGACY_SETTINGS });
  if (opts.ready !== false) await app.ready();

  // The relay, client and fetch logs are append-only, so effects count from the lengths at the last reset.
  let marks = { relayed: 0, calls: 0, fetches: 0 };
  const serviceCalls = (): number => people.calls.length + content.calls.length;
  const outboxEvents = (): EventEnvelope[] =>
    db
      .writes()
      .filter((write) => write.verb === 'INSERT' && write.table === 'identity.outbox')
      .map((write) => JSON.parse(String(write.values[5])) as EventEnvelope);
  return {
    app,
    db,
    repo,
    relay,
    people,
    content,
    outbound,
    outboxEvents,
    resetEffects() {
      db.clear();
      answerRegistry();
      repo.clear();
      marks = { relayed: relay.calls.length, calls: serviceCalls(), fetches: outbound.calls.length };
    },
    effects() {
      return {
        statements: db.statements().length,
        writes: db.writes().length,
        repoWrites: repo.writes().length,
        events: outboxEvents().length,
        relayed: relay.calls.length - marks.relayed,
        calls: serviceCalls() - marks.calls,
        fetches: outbound.calls.length - marks.fetches,
      };
    },
    async close() {
      await app.opt2.shutdown();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/** Options of {@link credentialsFor}. */
export interface CredentialOptions {
  /** Site of a user token; defaults to tenant-a, or another tenant's site for `crossTenant` subjects. */
  site?: string;
  /** Invocation credential addressed to another callee than identity. */
  audience?: string;
}

/**
 * Headers presenting `subject`: a user arrives through the gateway with its seeded session's token, a workload with its
 * own invocation credential, the push invoker with nothing (its key travels in the query), the tasks invoker in `Authorization`.
 */
export async function credentialsFor(subject: RoleSubject, opts: CredentialOptions = {}): Promise<Record<string, string>> {
  const audience = opts.audience ?? SERVICE;
  if (subject.kind === 'anonymous') return {};
  if (subject.kind === 'user') {
    const session = SUBJECT_SESSIONS[subject.name];
    if (session === undefined) throw new TypeError(`No seeded session for ${subject.name}`);
    const site = opts.site ?? (subject.crossTenant === true ? otherTenantSite(SITE_A) : SITE_A);
    const [userToken, gatewayToken] = await Promise.all([
      mintUserToken({ sub: session.userId, sid: session.sessionId, site, roles: subject.roles, s2: subject.s2 }),
      mintServiceToken({ caller: 'gateway', audience }),
    ]);
    return { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${gatewayToken}` };
  }
  const caller = subject.caller ?? '';
  if (caller === 'pubsub-invoker') return {};
  if (caller === 'tasks-invoker') return { authorization: `Bearer ${await mintServiceToken({ caller, audience })}` };
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience, roles: [...subject.roles] })}` };
}

/** Headers of workload `caller` relaying a user token of `session` for `roles`, as a service calls identity for its user. */
export async function relayedCredentials(caller: string, session: SubjectSession, roles: readonly string[], site = SITE_A): Promise<Record<string, string>> {
  const [userToken, invocation] = await Promise.all([
    mintUserToken({ sub: session.userId, sid: session.sessionId, site, roles }),
    mintServiceToken({ caller, audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

/** The `sid` claim of the bearer user token in `headers`; undefined without one. */
export function sessionIdOf(headers: Record<string, string>): string | undefined {
  const bearer = headers.authorization?.replace(/^Bearer /, '');
  if (bearer === undefined) return undefined;
  const { sid } = decodeJwt(bearer);
  return typeof sid === 'string' ? sid : undefined;
}
