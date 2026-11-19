/** Authorisation matrix of every strategies-content route through `app.inject`: declarations, legacy gates, transports, site binding and tenancy. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  AuthDenial,
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  Roles,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  hasAnyRole,
  isServiceRole,
  moduleRole,
  renderAuthDenial,
  rolesForService,
  serviceRole,
  transportForPath,
  type DenialResponse,
  type Opt2RouteConfig,
  type Role,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import {
  LEGACY_ERROR_MAP,
  LEGACY_ERROR_PAGE_HTML,
  LegacyFaultError,
  WWW_AUTHENTICATE,
  legacyDebuggingEnabled,
  legacyFaultOf,
  legacyRuntimeErrorResponse,
} from '@opt2/platform/legacy-compat';
import {
  IDENTITY_SERVICE,
  createService,
  loadEnv,
  type Clock,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { SIGNED_URL_TTL_S } from '@opt2/platform/storage';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  TEST_PUSH_KEY,
  authHeadersFor,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushTo,
  registryPayloads,
  testEnvelope,
  testVerifier,
  type InjectResponse,
  type PushTarget,
  type RoleSubject,
} from '@opt2/platform/testing';
import {
  CONTENT_SUBSCRIPTIONS,
  GROUP_CHANGED_SUBSCRIPTION,
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_SUBSCRIPTION,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_SUBSCRIPTION,
  PERMISSION_CHANGED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
} from '../../src/events/consumers.js';
import { FEED_AUTO_IMPORT_PATH, PUBLISH_SCHEDULED_CHANGESETS_PATH } from '../../src/jobs/index.js';
import { esapiEncode } from '../../src/legacy/admin-markup.js';
import type * as RouteRegistry from '../../src/routes/index.js';
import { CIRCUIT_ROUTE_REQUIRES, adminDenial, type GatedContentAdminCircuit } from '../../src/routes/v1/access.js';
import { contentQueues } from '../../src/tasks/port.js';
import {
  SITE_CONFIG_FLAGS_PATH,
  TEST_CLOCK,
  buildTestApp,
  feedManagerFlagsAnswer,
  testEnv,
  type ClientHandlers,
  type RecordedStatement,
  type StoredFeedManager,
  type TestApp,
} from '../helpers/app.js';
import { IDS, seedMemoryStorage, seedRecordingDb } from '../helpers/seed.js';
import {
  CONTENT_SUBJECTS,
  SUBJECT_CLAIMS,
  SUBJECT_USER_IDS,
  contentHeaders,
  pushQuery,
  serviceHeaders,
  tasksHeaders,
  type ContentServiceCaller,
  type TokenSubject,
} from '../helpers/tokens.js';

/** A route handler that ran: its `METHOD url` and what it threw, if anything. */
interface HandlerEntry {
  route: string;
  error?: unknown;
}

/** Handlers entered since the last reset. */
const HANDLER_ENTRIES = vi.hoisted((): HandlerEntry[] => []);

// Wraps the handler of every route registered from the content routes on, migration, consumer, job and queue-control routes included.
vi.mock('../../src/routes/index.js', async (importOriginal) => {
  const registry = await importOriginal<typeof RouteRegistry>();
  const registerRoutes = async (app: FastifyInstance, deps: RouteRegistry.RouteDeps): Promise<void> => {
    app.addHook('onRoute', (route) => {
      const handler = route.handler;
      route.handler = function (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
        const entry: HandlerEntry = { route: `${request.method} ${route.url}` };
        HANDLER_ENTRIES.push(entry);
        try {
          const answer = handler.call(this, request, reply);
          if (answer instanceof Promise) {
            answer.catch((error: unknown) => {
              entry.error = error;
            });
          }
          return answer;
        } catch (error) {
          entry.error = error;
          throw error;
        }
      };
    });
    await registry.registerRoutes(app, deps);
  };
  return { ...registry, registerRoutes };
});

type Headers = Record<string, string>;
type HttpMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';

const SERVICE = 'strategies-content';
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const COMMENTS_PROXY_URL = '/core/modules/v1/comments/ajax/commentsProxy.cfc';
const RATER_URL = '/core/modules/v1/rater/ajax/saveRate.cfm';
const FORM: Headers = Object.freeze({ 'content-type': 'application/x-www-form-urlencoded' });
const JSON_BODY: Headers = Object.freeze({ 'content-type': 'application/json' });
const CSRF_FIELDS = 'csrf_token=TOKEN&csrf_token_expires=260630130000000';
const REFERER = 'http://localhost:8080/admin/?muraAction=cArch.list&siteid=tenant-a';
const GATEWAY_ROLES: readonly Role[] = Object.freeze(rolesForService('gateway'));

const M = Object.freeze({
  siteManager: moduleRole('00000000000000000000000000000000000'),
  forms: moduleRole('00000000000000000000000000000000004'),
  categories: moduleRole('00000000000000000000000000000000010'),
  collections: moduleRole('00000000000000000000000000000000011'),
  changesets: moduleRole('00000000000000000000000000000000014'),
  comments: moduleRole('00000000000000000000000000000000015'),
});

/** Offset added to the business clock, which the signed-URL expiry test advances. */
let clockOffsetMs = 0;
const CLOCK: Clock = { now: () => new Date(TEST_CLOCK.now().getTime() + clockOffsetMs) };

/** identity's answers to the session reads the admitted admin cells make. */
const IDENTITY_HANDLERS: ClientHandlers = {
  [IDENTITY_SERVICE]: {
    'GET /v1/sessions/current/sites': () => ({ status: 200, headers: {}, body: { sites: [{ siteID: SITE_A, site: 'Tenant A' }] } }),
    'GET /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
    'POST /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
    'POST /v1/csrf/tokens': (req) => {
      const contexts = (req.json as { contexts?: string[] } | undefined)?.contexts ?? [];
      const tokens = contexts.map((context) => ({ context, csrf_token: 'TOKEN', csrf_token_expires: '260630130000000' }));
      return { status: 200, headers: {}, body: { tokens } };
    },
  },
};

/** programs-sites' stored `tsettings.feedManager` of every site, which its config-flags lookup answers to the cfeed gate. */
let storedFeedManager: StoredFeedManager = 1;

/** programs-sites' answers: each listed site's own settings to the lookup every stored feed reads, and its config flags. */
const SITES_HANDLERS: ClientHandlers = {
  'programs-sites': {
    [`POST ${SITE_CONFIG_FLAGS_PATH}`]: (req) => feedManagerFlagsAnswer(storedFeedManager)(req),
    'POST /internal/v1/sites/feed-settings:lookup': (req) => ({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: {
        items: (req.json as { siteIds: string[] }).siteIds.map((siteID) => ({
          siteID,
          contact: `webmaster@${siteID}.example`,
          javaLocale: 'en_US',
          domain: `${siteID}.example`,
          domainAliases: [],
          enforcePrimaryDomain: false,
          useSSL: false,
          remote: null,
        })),
      },
    }),
  },
};

const t: TestApp = await buildTestApp({ env: { LOG_LEVEL: 'fatal' }, clock: CLOCK, clientHandlers: { ...IDENTITY_HANDLERS, ...SITES_HANDLERS } });
seedRecordingDb(t.db);
seedMemoryStorage(t.storage);
const MATRIX: readonly RouteMatrixEntry[] = collectRouteMatrix(t.app).routes;

afterAll(async () => {
  await t.close();
});

/** Headers and the query string (without `?`) a request presents. */
interface Credential {
  headers: Headers;
  query: string;
}

/** What arrives on the wire: nothing, the gateway's invocation credential alone or beside a user token, a workload's, the push key or a tasks token. */
type Presents = 'nothing' | 'gateway' | 'user' | 'workload' | 'workload+user' | 'push-key' | 'tasks';

/** One identity of the matrix. */
interface Subject {
  name: string;
  presents: Presents;
  /** Roles the user token claims; empty without one. */
  userRoles: readonly Role[];
  /** Roles of the invocation credential or managed identity. */
  workloadRoles: readonly Role[];
  /** Site of the user token; undefined without one. */
  site: string | undefined;
  /** Whether the user token names a signed-in user rather than the anonymous principal. */
  signedIn: boolean;
  mint(transport: Transport, path: string): Promise<Credential>;
}

const headersOnly = async (headers: Promise<Headers>): Promise<Credential> => ({ headers: await headers, query: '' });

/** A user token of `site` beside the gateway's invocation credential, minted through the platform test signer. */
async function userCredential(claims: { sub: string; roles: readonly Role[]; site?: string; tid?: string; exp?: number }): Promise<Credential> {
  const site = claims.site ?? SITE_A;
  const [user, gateway] = await Promise.all([
    mintUserToken({ sub: claims.sub, site, roles: claims.roles, ...(claims.tid === undefined ? {} : { tid: claims.tid }), ...(claims.exp === undefined ? {} : { exp: claims.exp }) }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { headers: { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${gateway}` }, query: '' };
}

function roleSubject(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return subject;
}

function contentUser(name: TokenSubject): Subject {
  const claims = SUBJECT_CLAIMS[name];
  return {
    name,
    presents: 'user',
    userRoles: claims.roles,
    workloadRoles: GATEWAY_ROLES,
    site: claims.site,
    signedIn: true,
    mint: () => headersOnly(contentHeaders(name, { site: SITE_A })),
  };
}

function syntheticUser(role: string): Subject {
  const subject = roleSubject(role);
  return {
    name: role,
    presents: 'user',
    userRoles: subject.roles,
    workloadRoles: GATEWAY_ROLES,
    site: SITE_A,
    signedIn: true,
    mint: () => headersOnly(authHeadersFor(subject, { audience: SERVICE, site: SITE_A })),
  };
}

const CONTENT_CALLERS: Readonly<Record<string, ContentServiceCaller>> = Object.freeze({
  migration: 'platform.migration',
  operator: 'platform.operator',
  'programs-sites': 'service:programs-sites',
});

function workload(caller: string): Subject {
  const helperCaller = CONTENT_CALLERS[caller];
  return {
    name: serviceRole(caller),
    presents: 'workload',
    userRoles: [],
    workloadRoles: rolesForService(caller),
    site: undefined,
    signedIn: false,
    mint: () => headersOnly(helperCaller === undefined ? authHeadersFor(roleSubject(serviceRole(caller)), { audience: SERVICE }) : serviceHeaders(helperCaller)),
  };
}

/** `caller`'s invocation credential beside a tenant-a system user's token, as people and identity forward one. */
function workloadForUser(caller: string): Subject {
  return {
    name: `${serviceRole(caller)} for a tenant-a user`,
    presents: 'workload+user',
    userRoles: [Roles.systemUser],
    workloadRoles: rolesForService(caller),
    site: SITE_A,
    signedIn: true,
    async mint() {
      const [user, invocation] = await Promise.all([
        mintUserToken({ sub: SUBJECT_USER_IDS['system-user'], site: SITE_A, roles: [Roles.systemUser] }),
        mintServiceToken({ caller, audience: SERVICE }),
      ]);
      return { headers: { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` }, query: '' };
    },
  };
}

/** A tenant-a system user holding exactly `modules`, proving one AND condition or single-role path of a circuit gate. */
function gateProbe(name: string, modules: readonly Role[], index: number): Subject {
  const roles = [Roles.systemUser, ...modules];
  return {
    name,
    presents: 'user',
    userRoles: roles,
    workloadRoles: GATEWAY_ROLES,
    site: SITE_A,
    signedIn: true,
    mint: () => userCredential({ sub: `D0000000-0000-0000-00000000000000${String(index).padStart(2, '0')}`, roles }),
  };
}

const ANONYMOUS: Subject = {
  name: 'anonymous',
  presents: 'gateway',
  userRoles: [],
  workloadRoles: GATEWAY_ROLES,
  site: undefined,
  signedIn: false,
  mint: () => headersOnly(contentHeaders('anonymous')),
};

/** The gateway's anonymous principal (`sub` ''), the token every visitor's request carries. */
const VISITOR: Subject = {
  name: 'anonymous principal',
  presents: 'user',
  userRoles: [],
  workloadRoles: GATEWAY_ROLES,
  site: SITE_A,
  signedIn: false,
  mint: () => userCredential({ sub: '', roles: [] }),
};

const TASKS_INVOKER: Subject = {
  name: TASKS_INVOKER_ROLE,
  presents: 'tasks',
  userRoles: [],
  workloadRoles: [TASKS_INVOKER_ROLE],
  site: undefined,
  signedIn: false,
  mint: (transport, path) =>
    headersOnly(transport === 'cloud-tasks' ? tasksHeaders(path) : authHeadersFor(roleSubject(TASKS_INVOKER_ROLE), { audience: SERVICE })),
};

const PUSH_INVOKER: Subject = {
  name: PUBSUB_INVOKER_ROLE,
  presents: 'push-key',
  userRoles: [],
  workloadRoles: [PUBSUB_INVOKER_ROLE],
  site: undefined,
  signedIn: false,
  mint: async () => ({ headers: {}, query: pushQuery() }),
};

const SYNTHETIC_SUBJECTS: readonly string[] = [
  Roles.timesheetsEmployee,
  Roles.timesheetsPrimaryApprover,
  Roles.timesheetsSecondaryApprover,
  Roles.financePreparer,
  Roles.financeApprover,
  Roles.esignatureSigner,
  Roles.esignatureAuditor,
  Roles.reportingExporter,
  Roles.surveysManager,
  Roles.communicationsSender,
];

const GATE_PROBES: ReadonlyArray<readonly [string, readonly Role[]]> = [
  ['m:014 only', [M.changesets]],
  ['m:014+m:000', [M.changesets, M.siteManager]],
  ['m:015 only', [M.comments]],
  ['m:015+m:000', [M.comments, M.siteManager]],
  ['m:010 only', [M.categories]],
  ['m:010+m:000', [M.categories, M.siteManager]],
  ['m:011 only', [M.collections]],
  ['m:011+m:000', [M.collections, M.siteManager]],
  ['m:004 only', [M.forms]],
  ['m:000+m:004', [M.siteManager, M.forms]],
];

const SUBJECTS: readonly Subject[] = [
  ANONYMOUS,
  ...CONTENT_SUBJECTS.filter((name): name is TokenSubject => name !== 'anonymous').map(contentUser),
  VISITOR,
  ...SYNTHETIC_SUBJECTS.map(syntheticUser),
  ...['migration', 'operator', 'programs-sites', 'people', 'identity'].map(workload),
  workloadForUser('people'),
  workloadForUser('identity'),
  TASKS_INVOKER,
  PUSH_INVOKER,
  ...GATE_PROBES.map(([name, modules], index) => gateProbe(name, modules, index)),
];

function subjectNamed(name: string): Subject {
  const subject = SUBJECTS.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`No matrix subject named ${name}`);
  return subject;
}

const credentialCache = new Map<string, { mintedAt: number; credential: Promise<Credential> }>();

// User tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `subject`'s credential for a request to `path` on `entry`'s transport, reused while its tokens are fresh. */
function credentialFor(subject: Subject, entry: Pick<RouteMatrixEntry, 'transport'>, path: string): Promise<Credential> {
  const key = subject.presents === 'tasks' ? `${subject.name} ${entry.transport} ${path}` : subject.name;
  const hit = credentialCache.get(key);
  if (hit !== undefined && Date.now() - hit.mintedAt < CREDENTIAL_REUSE_MS) return hit.credential;
  const credential = subject.mint(entry.transport, path);
  credentialCache.set(key, { mintedAt: Date.now(), credential });
  return credential;
}

/** Verdict inputs beside the verified roles. */
interface AllowContext {
  /** A verified user token arrived, the anonymous principal's included. */
  userToken: boolean;
  /** `tsettings.feedManager` of the site, from the verified source the cfeed gate reads. */
  feedManager: boolean;
}

/** Methods and either one exact Fastify url or a url prefix. */
interface Match {
  methods: readonly HttpMethod[];
  url?: string;
  prefix?: string;
}

const at = (methods: string, url: string): Match => ({ methods: methods.split(',') as HttpMethod[], url });
const under = (methods: string, prefix: string): Match => ({ methods: methods.split(',') as HttpMethod[], prefix });

type Declared = { public: true; siteCheck: boolean } | { requires: readonly Role[]; siteCheck: boolean };

/** One route family of the literal table. */
interface Family {
  family: string;
  match: readonly Match[];
  transport: Transport;
  declared: Declared;
  /** The admin circuit whose `before()` gate the handler runs; its refusals are `denied-gate`. */
  circuit?: GatedContentAdminCircuit | 'cnav';
  /** Legacy's verdict over the verified roles, evaluated once the declaration admits the caller. */
  allow(roles: readonly Role[], ctx: AllowContext): boolean;
  /** The probe supplies `siteid=tenant-a`, which must be the user token's site. */
  siteScoped: boolean;
  /** WWW-Authenticate of the handler's own refusal when `allow` fails, as legacy's REST credential block sends it. */
  challenge?: string;
  /** The route admits a caller without an invocation credential. */
  invocationOptional?: true;
}

const ADMIN: readonly Role[] = [Roles.s2, Roles.siteAdmin];
const adminOrS2 = (roles: readonly Role[]): boolean => hasAnyRole(roles, ADMIN);
const withSiteManager = (roles: readonly Role[], module: Role): boolean => adminOrS2(roles) || (roles.includes(module) && roles.includes(M.siteManager));
const userTokenOnly = (_roles: readonly Role[], ctx: AllowContext): boolean => ctx.userToken;
const always = (): boolean => true;

const PUBLIC_LENIENT: Declared = { public: true, siteCheck: false };
const PUBLIC_CHECKED: Declared = { public: true, siteCheck: true };
const requiring = (...roles: Role[]): Declared => ({ requires: roles, siteCheck: true });

const PUSH_URLS = [
  '/internal/v1/events/strategies-content.identity.group.changed.v1',
  '/internal/v1/events/strategies-content.identity.membership.changed.v1',
  '/internal/v1/events/strategies-content.identity.permission.changed.v1',
  '/internal/v1/events/strategies-content.programs-sites.site.changed.v1',
];
const JOB_URLS = ['/internal/v1/jobs/feed-auto-import', '/internal/v1/jobs/publish-scheduled-changesets'];

const FAMILIES: readonly Family[] = [
  { family: 'health', match: [at('GET', '/healthz')], transport: 'service', declared: PUBLIC_CHECKED, allow: always, siteScoped: false, invocationOptional: true },
  {
    family: 'JSON API',
    match: ['/_api/json/v1', '/_api/ajax/v1', '/index.cfm/_api/json/v1', '/index.cfm/_api/ajax/v1'].flatMap((lead) =>
      [lead, `${lead}/:siteid`, `${lead}/:siteid/*`].map((url) => at('DELETE,GET,POST,PUT', url)),
    ),
    transport: 'service',
    declared: PUBLIC_LENIENT,
    allow: always,
    siteScoped: true,
  },
  {
    family: 'REST API',
    match: ['/_api/rest/v1', '/index.cfm/_api/rest/v1'].flatMap((lead) => [lead, `${lead}/:siteid`, `${lead}/:siteid/*`].map((url) => at('DELETE,GET,POST,PUT', url))),
    transport: 'service',
    declared: PUBLIC_LENIENT,
    allow: userTokenOnly,
    challenge: WWW_AUTHENTICATE.basic,
    siteScoped: true,
  },
  {
    family: 'feed',
    match: ['/_api/feed/v1', '/_api/feed/v1/*', '/tasks/feed', '/tasks/feed/*'].map((url) => at('GET', url)),
    transport: 'service',
    declared: PUBLIC_LENIENT,
    allow: userTokenOnly,
    siteScoped: true,
  },
  {
    family: 'render',
    match: [at('GET', '/_api/render/:size'), at('GET', '/tasks/render/:size')],
    transport: 'service',
    declared: PUBLIC_CHECKED,
    allow: userTokenOnly,
    siteScoped: false,
  },
  {
    family: 'variation resource',
    match: [at('GET', '/_api/resource/variation'), at('GET', '/_api/resource/variation/*')],
    transport: 'service',
    declared: PUBLIC_LENIENT,
    allow: always,
    siteScoped: false,
  },
  {
    family: 'comments proxy',
    match: [at('GET,POST', COMMENTS_PROXY_URL)],
    transport: 'service',
    declared: PUBLIC_LENIENT,
    allow: userTokenOnly,
    siteScoped: true,
  },
  {
    family: 'rater',
    match: [at('POST', RATER_URL)],
    transport: 'service',
    declared: PUBLIC_LENIENT,
    allow: userTokenOnly,
    siteScoped: true,
  },
  {
    // The template reads form fields only, so a GET fails it before any credential is read.
    family: 'rater without form fields',
    match: [at('GET', RATER_URL)],
    transport: 'service',
    declared: PUBLIC_LENIENT,
    allow: always,
    siteScoped: false,
  },
  {
    family: 'signed objects',
    match: [at('GET', '/opt2/files/content-files/:tenantId/:objectName')],
    transport: 'service',
    declared: PUBLIC_CHECKED,
    allow: always,
    siteScoped: false,
  },
  {
    family: 'signed-URL issuance',
    match: [at('GET', '/v1/sites/:siteid/files/:fileid/download-url')],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, M.siteManager),
    allow: (roles) => hasAnyRole(roles, [Roles.s2, Roles.siteAdmin, M.siteManager]),
    siteScoped: true,
  },
  {
    family: 'header prompts',
    match: [at('GET', '/v1/sites/:siteid/header-prompts')],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, Roles.systemUser),
    allow: (roles) => hasAnyRole(roles, [Roles.s2, Roles.siteAdmin, Roles.systemUser]),
    siteScoped: true,
  },
  {
    family: 'private interest groups',
    match: [at('GET', '/v1/sites/:siteid/private-interest-groups')],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, Roles.systemUser, Roles.member),
    allow: (roles) => hasAnyRole(roles, [Roles.s2, Roles.siteAdmin, Roles.systemUser, Roles.member]),
    siteScoped: true,
  },
  {
    family: 'content links',
    match: [at('POST', '/internal/v1/content::links')],
    transport: 'service',
    declared: requiring(serviceRole('people')),
    allow: always,
    siteScoped: false,
  },
  {
    family: 'file lookup',
    match: [at('POST', '/internal/v1/files::lookup')],
    transport: 'service',
    declared: requiring(serviceRole('people'), serviceRole('identity')),
    allow: userTokenOnly,
    siteScoped: false,
  },
  {
    family: 'migration',
    match: [
      at('POST', '/internal/v1/migration/apply'),
      at('GET', '/internal/v1/migration/changes'),
      at('GET', '/internal/v1/migration/export'),
      at('POST', '/internal/v1/migration/gate'),
      at('DELETE,GET,POST', '/internal/v1/migration/objects'),
      at('GET', '/internal/v1/migration/position'),
      at('GET,POST', '/internal/v1/migration/watermark'),
    ],
    transport: 'service',
    declared: requiring(Roles.platformMigration),
    allow: always,
    siteScoped: false,
  },
  {
    family: 'queue control',
    match: ['ensure', 'pause', 'resume'].map((op) => at('POST', `/internal/v1/task-queues/:queue/${op}`)),
    transport: 'service',
    declared: requiring(Roles.platformMigration, Roles.platformOperator),
    allow: always,
    siteScoped: false,
  },
  { family: 'push', match: PUSH_URLS.map((url) => at('POST', url)), transport: 'pubsub-push', declared: requiring(PUBSUB_INVOKER_ROLE), allow: always, siteScoped: false },
  { family: 'jobs', match: JOB_URLS.map((url) => at('POST', url)), transport: 'cloud-tasks', declared: requiring(TASKS_INVOKER_ROLE), allow: always, siteScoped: false },
  {
    family: 'carch',
    circuit: 'carch',
    match: [
      under('GET,POST', '/v1/raw/carch/'),
      at('GET', '/v1/sites/:siteid/content'),
      at('GET', '/v1/sites/:siteid/content/:contentid'),
      at('GET', '/v1/sites/:siteid/content/:contentid/history'),
      at('GET', '/v1/sites/:siteid/content/:contentid/multi-file-upload'),
      at('GET', '/v1/sites/:siteid/content/:contentid/versions/:contenthistid/audit'),
      at('GET', '/v1/sites/:siteid/content/drafts'),
      at('GET', '/v1/sites/:siteid/content/images'),
      at('GET', '/v1/sites/:siteid/content/tree'),
      at('GET', '/v1/sites/:siteid/content/versions/:contenthistid/summary'),
      at('GET', '/v1/sites/:siteid/feeds/display-fields'),
      at('GET', '/v1/sites/:siteid/files/image-details'),
      at('GET', '/v1/sites/:siteid/forms/:contentid/responses'),
      at('POST', '/v1/sites/:siteid/forms/:contentid/responses/delete'),
      at('GET,POST', '/v1/sites/:siteid/variation-targeting'),
    ],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, M.siteManager),
    allow: (roles) => hasAnyRole(roles, [Roles.s2, Roles.siteAdmin, M.siteManager]),
    siteScoped: true,
  },
  {
    family: 'cperm',
    circuit: 'cperm',
    match: [at('GET', '/v1/sites/:siteid/content/:contentid/crumbs')],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin),
    allow: adminOrS2,
    siteScoped: true,
  },
  {
    family: 'cchangesets',
    circuit: 'cchangesets',
    match: [
      under('GET,POST', '/v1/raw/cchangesets/'),
      at('GET,POST', '/v1/sites/:siteid/changesets'),
      at('GET', '/v1/sites/:siteid/changesets/:changesetid'),
      at('GET', '/v1/sites/:siteid/changesets/:changesetid/assignments'),
      at('POST', '/v1/sites/:siteid/changesets/:changesetid/delete'),
      at('POST', '/v1/sites/:siteid/changesets/:changesetid/items/:contenthistid/remove'),
      at('POST', '/v1/sites/:siteid/changesets/:changesetid/rollback'),
    ],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, M.changesets),
    allow: (roles) => withSiteManager(roles, M.changesets),
    siteScoped: true,
  },
  {
    family: 'ccomments',
    circuit: 'ccomments',
    match: [
      under('GET,POST', '/v1/raw/ccomments/'),
      at('GET', '/v1/sites/:siteid/comments'),
      at('POST', '/v1/sites/:siteid/comments/:commentid'),
      ...['approve', 'delete', 'spam', 'unapprove'].map((action) => at('POST', `/v1/sites/:siteid/comments/:commentid/${action}`)),
      at('POST', '/v1/sites/:siteid/comments/bulk'),
      at('POST', '/v1/sites/:siteid/comments/purge-deleted'),
    ],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, M.comments),
    allow: (roles) => withSiteManager(roles, M.comments),
    siteScoped: true,
  },
  {
    family: 'ccategory',
    circuit: 'ccategory',
    match: [at('GET,POST', '/v1/sites/:siteid/categories'), at('GET', '/v1/sites/:siteid/categories/:categoryid')],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, M.categories),
    allow: (roles) => withSiteManager(roles, M.categories),
    siteScoped: true,
  },
  {
    family: 'cfeed',
    circuit: 'cfeed',
    match: [
      under('GET,POST', '/v1/raw/cfeed/'),
      at('GET', '/v1/sites/:siteid/feeds'),
      at('GET', '/v1/sites/:siteid/feeds/:feedid'),
      at('GET', '/v1/sites/:siteid/feeds/:feedid/import'),
    ],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, M.collections),
    allow: (roles, ctx) => ctx.feedManager && withSiteManager(roles, M.collections),
    siteScoped: true,
  },
  {
    family: 'cchain',
    circuit: 'cchain',
    match: [
      at('GET,POST', '/v1/sites/:siteid/approval-chains'),
      at('GET', '/v1/sites/:siteid/approval-chains/:chainid'),
      at('GET', '/v1/sites/:siteid/approval-chains/:chainid/pending'),
      at('POST', '/v1/sites/:siteid/approval-chains/:chainid/delete'),
    ],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin),
    allow: adminOrS2,
    siteScoped: true,
  },
  {
    family: 'cform',
    circuit: 'cform',
    match: [under('GET,POST', '/v1/raw/cform/'), at('POST', '/v1/sites/:siteid/forms/import')],
    transport: 'service',
    declared: requiring(Roles.s2, Roles.siteAdmin, M.forms),
    allow: (roles) => hasAnyRole(roles, [Roles.s2, Roles.siteAdmin, M.siteManager]) && hasAnyRole(roles, [Roles.s2, Roles.siteAdmin, M.forms]),
    siteScoped: true,
  },
  { family: 'cnav', circuit: 'cnav', match: [under('GET,POST', '/v1/raw/cnav/')], transport: 'service', declared: PUBLIC_CHECKED, allow: always, siteScoped: true },
];

function matches(match: Match, entry: Pick<RouteMatrixEntry, 'method' | 'url'>): boolean {
  if (!match.methods.includes(entry.method as HttpMethod)) return false;
  return match.url !== undefined ? entry.url === match.url : match.prefix !== undefined && entry.url.startsWith(match.prefix);
}

function familiesOf(entry: Pick<RouteMatrixEntry, 'method' | 'url'>): Family[] {
  return FAMILIES.filter((family) => family.match.some((match) => matches(match, entry)));
}

const routeKey = (entry: Pick<RouteMatrixEntry, 'method' | 'url'>): string => `${entry.method} ${entry.url}`;

/** What a cell answers: admitted, refused by the platform's credential, role or site checks, or refused by a circuit's `before()` gate. */
type Outcome = { kind: 'allowed' } | Denial;

/** A refusal, with legacy's WWW-Authenticate where its handler sends one. */
type Denial = { kind: 'denied-auth' | 'denied-gate'; status: 401 | 403; challenge?: string };

const ALLOWED: Outcome = Object.freeze({ kind: 'allowed' });
const AUTH_401: Denial = Object.freeze({ kind: 'denied-auth', status: 401 });
const AUTH_403: Denial = Object.freeze({ kind: 'denied-auth', status: 403 });

/** The roles the platform verifies from what `subject` presents: user roles without workload ones, then the workload's. */
function verifiedRoles(subject: Subject): Role[] {
  if (subject.presents === 'push-key' || subject.presents === 'tasks') return [];
  return [...new Set([...subject.userRoles.filter((role) => !isServiceRole(role)), ...subject.workloadRoles])];
}

/** The cell's expected outcome, from the literal table only: transport, declared roles, site, then legacy's verdict. */
function expectedOutcome(family: Family, subject: Subject, feedManager = true): Outcome {
  if (family.transport === 'pubsub-push') return subject.presents === 'push-key' ? ALLOWED : AUTH_401;
  if (family.transport === 'cloud-tasks') return subject.presents === 'tasks' ? ALLOWED : AUTH_401;
  // A tasks token is no invocation credential; where that credential may be absent, it fails verification as a user token.
  if (subject.presents === 'tasks') return AUTH_401;
  const declared = family.declared;
  // The push key is no invocation credential either, which only an invocationOptional route lets be absent.
  if (subject.presents === 'push-key' && family.invocationOptional !== true) return AUTH_401;
  const roles = verifiedRoles(subject);
  if ('requires' in declared && !hasAnyRole(roles, declared.requires)) {
    return !subject.signedIn && declared.requires.some((role) => !isServiceRole(role)) ? AUTH_401 : AUTH_403;
  }
  const userToken = subject.site !== undefined;
  if (family.siteScoped && userToken && subject.site !== SITE_A) return AUTH_403;
  if (!family.allow(roles, { userToken, feedManager })) {
    if (family.circuit !== undefined) return { kind: 'denied-gate', status: subject.signedIn ? 403 : 401 };
    return family.challenge === undefined ? AUTH_401 : { ...AUTH_401, challenge: family.challenge };
  }
  return ALLOWED;
}

/** What a cell observed: an outcome, or an answer that is neither a rendered denial nor an admitted handler's. */
type Observed = Outcome | { kind: 'unexplained'; status: number };

function sameOutcome(a: Observed, b: Outcome): boolean {
  return a.kind === b.kind && (a.kind === 'allowed' || (b.kind !== 'allowed' && a.status === b.status));
}

function outcomeLabel(outcome: Observed): string {
  if (outcome.kind === 'unexplained') return `unexplained (${outcome.status})`;
  return outcome.kind === 'allowed' ? 'allowed' : `denied (${outcome.status} ${outcome.kind === 'denied-gate' ? 'gate' : 'auth'})`;
}

/** One concrete request; a subject's credential is added when it is sent. */
interface Probe {
  method: HttpMethod;
  url: string;
  payload?: string | Buffer | Record<string, unknown>;
  headers?: Headers;
}

const OWN_QUEUE: string = contentQueues()[0] ?? 'content-scheduled-publish';

/** The value each path parameter of a probe takes; `siteid` is the site under test. */
function pathValues(site: string): Readonly<Record<string, string>> {
  return {
    siteid: site,
    contentid: IDS.content.section,
    contenthistid: IDS.hist.sectionDraft,
    changesetid: IDS.changesets.scheduledFuture,
    commentid: IDS.comments.unapproved,
    categoryid: IDS.categories.pooledChild,
    feedid: IDS.feeds.local,
    chainid: IDS.approval.chain,
    fileid: IDS.files.pdf,
    queue: OWN_QUEUE,
    size: 'file',
  };
}

/** A Fastify url with its parameters filled; `::` is Fastify's literal `:`. */
function fillPath(url: string, site: string): string {
  const values = pathValues(site);
  return url
    .split('::')
    .map((part) =>
      part.replace(/:(\w+)/g, (_whole, name: string) => {
        const value = values[name];
        if (value === undefined) throw new TypeError(`No probe value for path parameter ${name} of ${url}`);
        return value;
      }),
    )
    .join(':');
}

function withQuery(url: string, query: string): string {
  return query === '' ? url : `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/** A fresh contract-valid tenant-a envelope of the topic `subscription` consumes. */
function envelopeFor(subscription: string): ReturnType<typeof testEnvelope> {
  const tenantId = TENANT_A.tenantId;
  const groupId = IDS.groups.editor;
  switch (subscription) {
    case SITE_CHANGED_SUBSCRIPTION: {
      const site = registryPayloads().find((payload) => payload.siteId === SITE_A);
      if (site === undefined) throw new TypeError(`registryPayloads has no ${SITE_A} payload`);
      return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId, aggregateId: SITE_A, payload: site });
    }
    case GROUP_CHANGED_SUBSCRIPTION:
      return testEnvelope({
        topic: GROUP_CHANGED_TOPIC,
        tenantId,
        aggregateId: groupId,
        payload: { groupId, siteId: SITE_A, groupName: 'Editor', type: 1, isPublic: 0, poolTenantId: tenantId, deleted: false },
      });
    case PERMISSION_CHANGED_SUBSCRIPTION:
      return testEnvelope({
        topic: PERMISSION_CHANGED_TOPIC,
        tenantId,
        aggregateType: 'group',
        aggregateId: groupId,
        payload: { groupId, siteId: SITE_A, rows: [{ contentId: IDS.content.section, siteId: SITE_A, type: 'Editor' }] },
      });
    case MEMBERSHIP_CHANGED_SUBSCRIPTION:
      return testEnvelope({
        topic: MEMBERSHIP_CHANGED_TOPIC,
        tenantId,
        aggregateType: 'user',
        aggregateId: SUBJECT_USER_IDS.editor,
        payload: { userId: SUBJECT_USER_IDS.editor, siteId: SITE_A, groupIds: [groupId] },
      });
    default:
      throw new TypeError(`No envelope for subscription ${subscription}`);
  }
}

/** The subscription of a push route's url. */
function subscriptionOf(url: string): string {
  return url.slice('/internal/v1/events/'.length);
}

/** The delivery pushTo builds for `subscription`, without its push key, so each subject presents its own credential. */
async function pushProbe(subscription: string): Promise<Probe> {
  let captured: Probe | undefined;
  const recorder: PushTarget = {
    inject: ((options: { url: string; payload: Record<string, unknown> }) => {
      captured = { method: 'POST', url: options.url.split('?')[0] ?? options.url, payload: options.payload, headers: JSON_BODY };
      return Promise.resolve(undefined);
    }) as unknown as PushTarget['inject'],
  };
  await pushTo(recorder, subscription, envelopeFor(subscription));
  if (captured === undefined) throw new Error(`pushTo sent no delivery to ${subscription}`);
  return captured;
}

/** The system task body of one site-monitor step, as the programs-sites orchestrator sends it. */
const siteMonitorTask = (queue: string, step: string): Record<string, unknown> => ({
  queue,
  name: `${queue}-1782820800`,
  tenantId: null,
  payload: { step, theTime: '2026-06-30T12:00:00.000', lastMonitored: '2026-06-30T11:45:00.000' },
});

const OBJECT_PROBE_KEY = `${TENANT_A.tenantId}/${IDS.files.pdf}_authz.pdf`;
const OBJECT_PROBE_BYTES = Buffer.from('strategies-content authz probe');

const SEEDED_PDF_KEY = [...t.storage.objects.keys()].find((key) => key.endsWith(`${IDS.files.pdf}.pdf`)) ?? `missing ${IDS.files.pdf}.pdf`;
/** A signed local URL of the seeded umbrella PDF, the probe of the signed-object route. */
const SEEDED_PDF_URL = await t.storage.signedUrl('content-files', SEEDED_PDF_KEY);

const get = (url: string): Probe => ({ method: 'GET', url });
const postForm = (url: string, form: string): Probe => ({ method: 'POST', url, payload: form, headers: FORM });
const postJson = (url: string, json: Record<string, unknown>): Probe => ({ method: 'POST', url, payload: json, headers: JSON_BODY });

/** Requests a route serves the same way for every admitted caller, or that reach the action's ordinary path past its gate. */
const PROBE_OVERRIDES: Readonly<Record<string, (site: string) => Probe>> = {
  'GET /healthz': () => get('/healthz'),
  'GET /opt2/files/content-files/:tenantId/:objectName': () => get(SEEDED_PDF_URL),
  'POST /internal/v1/content::links': (site) => postJson('/internal/v1/content:links', { siteId: site, contentIds: [IDS.content.pageOne] }),
  'POST /internal/v1/files::lookup': () => postJson('/internal/v1/files:lookup', { fileIds: [IDS.files.pdf] }),
  'POST /internal/v1/migration/objects': () => ({
    method: 'POST',
    url: `/internal/v1/migration/objects?${new URLSearchParams({
      tenantId: TENANT_A.tenantId,
      fileId: IDS.files.pdf,
      variant: '_authz',
      ext: 'pdf',
      contentType: 'application/pdf',
      sha256: createHashHex(OBJECT_PROBE_BYTES),
    }).toString()}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: OBJECT_PROBE_BYTES,
  }),
  'GET /internal/v1/migration/objects': () => get(`/internal/v1/migration/objects?key=${encodeURIComponent(OBJECT_PROBE_KEY)}`),
  'DELETE /internal/v1/migration/objects': () => ({ method: 'DELETE', url: `/internal/v1/migration/objects?key=${encodeURIComponent(OBJECT_PROBE_KEY)}` }),
  'POST /internal/v1/migration/apply': () => postJson('/internal/v1/migration/apply', {}),
  'GET /internal/v1/migration/export': () => get(`/internal/v1/migration/export?unit=content.file&tenantId=${TENANT_A.tenantId}`),
  'GET /internal/v1/migration/changes': () => get(`/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`),
  'GET /internal/v1/migration/position': () => get('/internal/v1/migration/position'),
  'GET /internal/v1/migration/watermark': () => get('/internal/v1/migration/watermark'),
  'POST /internal/v1/migration/watermark': () => postJson('/internal/v1/migration/watermark', {}),
  'POST /internal/v1/migration/gate': () => postJson('/internal/v1/migration/gate', { op: 'status', units: ['content.file'] }),
  'POST /internal/v1/jobs/publish-scheduled-changesets': () =>
    postJson(PUBLISH_SCHEDULED_CHANGESETS_PATH, siteMonitorTask('content-scheduled-publish', 'publishScheduledChangesets')),
  'POST /internal/v1/jobs/feed-auto-import': (site) => postJson(`${FEED_AUTO_IMPORT_PATH}?siteid=${site}`, siteMonitorTask('content-feed-import', 'feedAutoImport')),
  'GET /v1/sites/:siteid/content': (site) => get(`/v1/sites/${site}/content?keywords=Page`),
  'GET /v1/sites/:siteid/private-interest-groups': (site) => get(`/v1/sites/${site}/private-interest-groups?groupsiteid=${site}`),
  'GET /v1/sites/:siteid/variation-targeting': (site) => get(`/v1/sites/${site}/variation-targeting?remoteid=authz-probe`),
  'POST /v1/sites/:siteid/variation-targeting': (site) => postForm(`/v1/sites/${site}/variation-targeting`, `remoteid=authz-probe&${CSRF_FIELDS}`),
  'POST /v1/sites/:siteid/changesets': (site) =>
    postForm(`/v1/sites/${site}/changesets`, `changesetid=${IDS.changesets.scheduledFuture}&name=Future%20Release&${CSRF_FIELDS}`),
  'POST /v1/sites/:siteid/changesets/:changesetid/items/:contenthistid/remove': (site) =>
    postForm(
      fillPath('/v1/sites/:siteid/changesets/:changesetid/items/:contenthistid/remove', site),
      `contenthistid=${IDS.hist.sectionDraft}&${CSRF_FIELDS}`,
    ),
  'POST /v1/sites/:siteid/categories': (site) =>
    postForm(`/v1/sites/${site}/categories`, `categoryid=${IDS.categories.pooledChild}&action=update&name=News&${CSRF_FIELDS}`),
};

/** The rc of a raw admin probe: tenant-a's section page, its draft, and the module, type and file the raw actions dereference. */
function rawFields(site: string): string {
  return new URLSearchParams({
    siteid: site,
    contentid: IDS.content.pageOne,
    contenthistid: IDS.hist.pageOneDraft,
    contenthistid1: IDS.hist.pageOneActive,
    contenthistid2: IDS.hist.pageOneDraft,
    parentid: IDS.content.section,
    moduleid: IDS.modules.content,
    type: 'Page',
    subtype: 'Default',
    fileid: IDS.files.pdf,
    changesetid: IDS.changesets.scheduledFuture,
    requestid: IDS.approval.request,
    action: 'approve',
    comment: 'authz probe',
    tab: '0',
    size: 'small',
    searchString: 'tenant',
  }).toString();
}

/** The rater's save form: a rating of tenant-a's first page in `site`. */
function raterFields(site: string): string {
  return `contentID=${IDS.content.pageOne}&siteID=${site}&userID=${SUBJECT_USER_IDS.member}&rate=4`;
}

/** The request a family sends to `entry` when no override names it. */
function familyProbe(family: Family, entry: RouteMatrixEntry, site: string): Probe {
  const url = fillPath(entry.url, site);
  const method = entry.method as HttpMethod;
  switch (family.family) {
    case 'JSON API':
    case 'REST API':
      return { method, url: url.endsWith('/*') ? `${url.slice(0, -2)}/notanentity` : url.includes(`/${site}`) ? url : `${url}?siteid=${site}` };
    case 'feed':
      return get(`${url.endsWith('/*') ? `${url.slice(0, -2)}/${site}` : url}?feedid=${IDS.feeds.local}&siteid=${site}`);
    case 'render':
      return get(`${url}?fileID=${IDS.files.pdf}`);
    case 'variation resource':
      return get(url.endsWith('/*') ? `${url.slice(0, -2)}/probe` : url);
    case 'comments proxy': {
      const fields = `method=getContentStats&contentID=${IDS.content.pageOne}&siteid=${site}`;
      return method === 'GET' ? get(`${url}?${fields}`) : postForm(url, fields);
    }
    case 'rater':
      return postForm(url, raterFields(site));
    case 'rater without form fields':
      return get(`${url}?${raterFields(site)}`);
    case 'queue control':
      return postJson(url, {});
    default:
      if (entry.url.startsWith('/v1/raw/')) {
        const fields = `${rawFields(site)}&${CSRF_FIELDS}`;
        return method === 'GET' ? get(`${url}?${fields}`) : postForm(url, fields);
      }
      return method === 'GET' ? get(url) : postForm(url, CSRF_FIELDS);
  }
}

/** The probe of `entry` naming `site`. */
async function probeFor(entry: RouteMatrixEntry, family: Family, site: string = SITE_A): Promise<Probe> {
  if (entry.transport === 'pubsub-push') return pushProbe(subscriptionOf(entry.url));
  const override = PROBE_OVERRIDES[routeKey(entry)];
  return override === undefined ? familyProbe(family, entry, site) : override(site);
}

function createHashHex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A request's response and every effect it left: handlers entered, statements, writes, storage puts and reads, tasks, CSRF consumes, session lookups. */
interface ProbeResult {
  res: InjectResponse;
  /** `METHOD path` as sent, without the query. */
  request: string;
  query: Record<string, string>;
  handlers: HandlerEntry[];
  statements: RecordedStatement[];
  writes: RecordedStatement[];
  puts: number;
  objectReads: number;
  tasksCreated: number;
  csrfConsumes: Array<{ context: string }>;
  sessionLookups: number;
}

/** Empties every recorder a cell reads and lets identity validate CSRF tokens again. */
function resetRecorders(): void {
  HANDLER_ENTRIES.length = 0;
  t.db.clear();
  t.storage.clear();
  t.taskPort.clear();
  t.client.clear();
  t.client.csrfValid = true;
  t.publisher.clear();
}

function resultOf(res: InjectResponse): ProbeResult {
  const sent = new URL(res.raw.req.url ?? '/', 'http://strategies-content.test');
  return {
    res,
    request: `${res.raw.req.method ?? ''} ${sent.pathname}`,
    query: Object.fromEntries(sent.searchParams),
    handlers: HANDLER_ENTRIES.map((entry) => ({ ...entry })),
    statements: [...t.db.statements],
    writes: t.db.writes(),
    puts: t.storage.calls.filter((call) => call.op === 'put').length,
    objectReads: t.storage.calls.filter((call) => call.op === 'get' || call.op === 'stream' || call.op === 'open').length,
    tasksCreated: t.taskPort.created.length,
    csrfConsumes: t.client.csrfConsumes.map(({ context }) => ({ context })),
    sessionLookups: t.client.requests.filter((req) => req.service === IDENTITY_SERVICE && req.method === 'GET' && req.path === '/v1/sessions/current').length,
  };
}

/** Sends `probe` with `credential` after resetting the recorders; `csrfValid` is identity's verdict on any token it consumes. */
async function send(probe: Probe, credential: Credential, csrfValid = true): Promise<ProbeResult> {
  resetRecorders();
  t.client.csrfValid = csrfValid;
  const res = await t.app.inject({
    method: probe.method,
    url: withQuery(probe.url, credential.query),
    headers: { ...probe.headers, ...credential.headers },
    ...(probe.payload === undefined ? {} : { payload: probe.payload }),
  });
  return resultOf(res);
}

/** Sends `entry`'s probe as `subject`; the push invoker delivers through pushTo, as the emulator does. */
async function sendCell(entry: RouteMatrixEntry, family: Family, subject: Subject, site: string = SITE_A): Promise<ProbeResult> {
  if (entry.transport === 'pubsub-push' && subject.presents === 'push-key') {
    resetRecorders();
    const subscription = subscriptionOf(entry.url);
    return resultOf(await pushTo(t.app, subscription, envelopeFor(subscription)));
  }
  const probe = await probeFor(entry, family, site);
  return send(probe, await credentialFor(subject, entry, probe.url.split('?')[0] ?? probe.url));
}

type DenialRequest = Parameters<typeof renderAuthDenial>[1];

const DENIAL_KINDS: readonly AuthDenial[] = [
  AuthDenial.unauthenticated('missing-credential'),
  AuthDenial.invalidToken(),
  AuthDenial.expiredToken(),
  AuthDenial.forbidden(),
];

/** The platform's rendering of an auth denial that `result` answered exactly, if any. */
function renderedDenialOf(result: ProbeResult): DenialResponse | undefined {
  const request = { query: result.query } as unknown as DenialRequest;
  return DENIAL_KINDS.filter((denial) => denial.statusCode === result.res.statusCode)
    .map((denial) => renderAuthDenial(denial, request))
    .find((rendered) => rendered.body === result.res.body);
}

/** A handler's own 4xx/5xx answer to its probe that still shows admission: its routes, status and identifying predicate. */
interface HandlerAnswer {
  routes: readonly string[];
  status: number;
  matches(result: ProbeResult): boolean;
}

/** `<class>: <message>` of what the entered handler threw; undefined when it threw nothing. */
function thrownBy(result: ProbeResult): string | undefined {
  const error = result.handlers[0]?.error;
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : undefined;
}

const threw =
  (expected: string | RegExp) =>
  (result: ProbeResult): boolean => {
    const thrown = thrownBy(result);
    return thrown !== undefined && (typeof expected === 'string' ? thrown === expected : expected.test(thrown));
  };
const answered = (body: string) => (result: ProbeResult): boolean => result.res.body === body;
const halted = (action: string) => threw(new RegExp(`^CarchHaltedError: carch\\.${action}: `));

/** The JSON API error envelope legacy answers `method` with for the map row `type`. */
function legacyEnvelope(type: keyof typeof LEGACY_ERROR_MAP, method: string): string {
  const { message, code } = LEGACY_ERROR_MAP[type];
  return JSON.stringify({ apiversion: 'v1', method, error: { message, code } });
}

const apiRoutes = (suffix: string): string[] =>
  ['/_api/json/v1', '/_api/ajax/v1', '/_api/rest/v1']
    .flatMap((lead) => [lead, `/index.cfm${lead}`])
    .flatMap((lead) => ['DELETE', 'GET', 'POST', 'PUT'].map((method) => `${method} ${lead}${suffix}`));
const rawRoutes = (circuit: string, action: string): string[] => ['GET', 'POST'].map((method) => `${method} /v1/raw/${circuit}/${action}`);

const HANDLER_ANSWERS: readonly HandlerAnswer[] = [
  // Legacy's JSON API envelopes for a request naming no entity or method, the site alone (findall) and /notanentity.
  { routes: apiRoutes(''), status: 400, matches: answered(legacyEnvelope('invalidParameters', 'invalid')) },
  { routes: apiRoutes('/:siteid'), status: 404, matches: answered(legacyEnvelope('invalidMethodCall', 'findall')) },
  { routes: apiRoutes('/:siteid/*'), status: 404, matches: answered(legacyEnvelope('invalidMethodCall', 'invalid')) },
  // Halted views: they print values another service holds, so the handler answers legacy's 503.
  ...['loadsite', 'siteparents'].map((action) => ({
    routes: rawRoutes('cfeed', action),
    status: 503,
    matches: threw('LegacyServiceUnavailableError: The collection search fragments print labels and site names this service does not hold'),
  })),
  {
    routes: ['GET /v1/sites/:siteid/feeds/:feedid'],
    status: 503,
    matches: threw('LegacyServiceUnavailableError: The collection edit model needs site values this service does not hold'),
  },
  ...(
    [
      ['', 'list prints preview URLs'],
      ['/:changesetid', 'edit prints a preview URL'],
      ['/:changesetid/assignments', 'assignments prints preview URLs'],
    ] as const
  ).map(([suffix, prints]) => ({
    routes: [`GET /v1/sites/:siteid/changesets${suffix}`],
    status: 503,
    matches: threw(`LegacyServiceUnavailableError: cChangesets.${prints} built from site settings this service does not hold`),
  })),
  ...['loadclassconfigurator', 'loadexpirenotify', 'loadnotify'].map((action) => ({ routes: rawRoutes('carch', action), status: 503, matches: halted(action) })),
  { routes: ['GET /v1/sites/:siteid/content/:contentid/multi-file-upload'], status: 503, matches: halted('multifileupload') },
  { routes: ['GET /v1/sites/:siteid/files/image-details'], status: 503, matches: halted('imagedetails') },
  // The probe omits a field the action reads, which legacy's CFML fails on with the same undefined-element error.
  ...(
    [
      ['carch', 'assocfiles', 'UndefinedLegacyElementError: Element PROPERTY is undefined in RC.'],
      ['carch', 'downloaddata', 'Error: Element SORTBY is undefined in a CFML structure referenced as part of an expression.'],
      ['carch', 'loadcategoryassignment', 'UndefinedLegacyElementError: Element CATEGORYASSIGNMENT is undefined in RC.'],
      ['carch', 'loadcategoryfeaturestartstop', 'UndefinedLegacyElementError: Element CATEGORYASSIGNMENT is undefined in RC.'],
      ['carch', 'loadclass', 'UndefinedLegacyElementError: Element CLASSID is undefined in RC.'],
      ['carch', 'loadsitesection', 'RangeError: Element RSTOP is undefined in RC.'],
      ['carch', 'refreshsitesection', 'RangeError: Element RSTOP is undefined in RC.'],
      ['carch', 'savecopyinfo', 'UndefinedLegacyElementError: Element COPYALL is undefined in RC.'],
      ['carch', 'savequickedit', 'UndefinedLegacyElementError: Element RC.attribute is undefined in ARGUMENTS.'],
      ['cform', 'getdataset', 'CformRequestError: Element RC.fieldID is undefined in ARGUMENTS.'],
      ['cform', 'getdialog', 'CformRequestError: Element RC.dialog is undefined in ARGUMENTS.'],
      ['cform', 'getfield', 'CformRequestError: Element RC.formID is undefined in ARGUMENTS.'],
      ['cform', 'getfieldtemplate', 'CformRequestError: Element RC.fieldtype is undefined in ARGUMENTS.'],
    ] as const
  ).map(([circuit, action, error]) => ({ routes: rawRoutes(circuit, action), status: 500, matches: threw(error) })),
  // The probe names no feedid: the server_error naming legacy's fault, which web prints as onError's page.
  {
    routes: rawRoutes('cfeed', 'update'),
    status: 500,
    matches: (result) =>
      /json/.test(String(result.res.headers['content-type'])) && legacyFaultOf(result.res.json())?.message === 'Element RC.feedid is undefined in ARGUMENTS.',
  },
  { routes: ['POST /v1/sites/:siteid/forms/import'], status: 500, matches: threw('CformRequestError: Element FORMZIP is undefined in FORM.') },
  { routes: ['POST /v1/sites/:siteid/variation-targeting'], status: 500, matches: threw('UndefinedLegacyElementError: Element INITJS is undefined in RC.') },
  // RecordingDb answers every seeded row of a table, unfiltered and without joined or aliased columns, so these reads fail past admission.
  ...(
    [
      [rawRoutes('carch', 'draftpromptdata'), "TypeError: Cannot read properties of undefined (reading 'getTime')"],
      [rawRoutes('carch', 'loadsiteflat'), 'SyntaxError: Cannot convert NaN0 to a BigInt'],
      // The batched crumb walk keeps only rows matching each related row's id, which RecordingDb's alias-less answers never carry, so the crumbs read empty.
      [rawRoutes('carch', 'loadselectedrelatedcontent'), 'RangeError: The element at position 1 cannot be found.'],
      [rawRoutes('carch', 'loadtagarray'), 'TypeError: text is not iterable'],
      [['GET /v1/sites/:siteid/approval-chains/:chainid/pending'], "TypeError: Cannot read properties of undefined (reading 'toUpperCase')"],
      [['GET /v1/sites/:siteid/content'], "TypeError: Cannot read properties of null (reading 'toLowerCase')"],
      [['POST /internal/v1/content::links'], "TypeError: Cannot read properties of undefined (reading 'replace')"],
      [['GET /v1/sites/:siteid/categories', 'GET /v1/sites/:siteid/categories/:categoryid'], `Error: Category ${IDS.categories.pooledParent} is its own ancestor`],
    ] as const
  ).map(([routes, error]) => ({ routes, status: 500, matches: threw(error) })),
  // Past RecordingDb's ignored publishdate cutoff the seed's change sets fail to save, inside the job's tenant transaction.
  {
    routes: ['POST /internal/v1/jobs/publish-scheduled-changesets'],
    status: 500,
    matches: (result) =>
      threw("ContentSaveDataError: The attribute 'PARENTID' is required when saving content.")(result) &&
      result.statements.some((statement) => statement.tenantId !== null),
  },
  // Every url field is a call argument, so the push key's `key` field makes legacy's component call unrunnable.
  {
    routes: [`GET ${COMMENTS_PROXY_URL}`, `POST ${COMMENTS_PROXY_URL}`],
    status: 500,
    matches: (result) => 'key' in result.query && answered(LEGACY_ERROR_PAGE_HTML)(result),
  },
  // A GET posts no form fields, so the rater's save answers onError's page for the missing contentID before any credential is read.
  {
    routes: [`GET ${RATER_URL}`],
    status: 500,
    matches: answered(
      legacyRuntimeErrorResponse(new LegacyFaultError('Element CONTENTID is undefined in FORM.'), {
        debuggingEnabled: legacyDebuggingEnabled(),
        encodeHtml: (text) => esapiEncode('html', text),
      }).body,
    ),
  },
  // A tenant-b caller's render of tenant-a's file finds no row in its own tenant: legacy's empty 404.
  {
    routes: ['GET /_api/render/:size', 'GET /tasks/render/:size'],
    status: 404,
    matches: (result) => {
      const tenants = new Set(result.statements.flatMap((statement) => (statement.tenantId === null ? [] : [statement.tenantId.toLowerCase()])));
      return result.res.body === '' && tenants.size === 1 && tenants.has(TENANT_B.tenantId.toLowerCase());
    },
  },
  // No manifest row records the probe's key: the handler's legacy 404 envelope.
  { routes: ['GET /internal/v1/migration/objects'], status: 404, matches: answered(legacyEnvelope('invalidMethodCall', 'invalid')) },
  // The probe's empty body names no change, watermark or queue settings: the handler's Invalid parameters answer.
  {
    routes: ['POST /internal/v1/migration/apply', 'POST /internal/v1/migration/watermark', 'POST /internal/v1/task-queues/:queue/ensure'],
    status: 400,
    matches: threw('LegacyApiError: invalidParameters: Invalid parameters'),
  },
  // The probed local feed has no channel link, so the import's fetch of '' fails before any request is sent.
  { routes: ['GET /v1/sites/:siteid/feeds/:feedid/import'], status: 500, matches: threw('TypeError: Failed to parse URL from ') },
];

/** createService registers /healthz before the handler witness, so its exact answer stands in for entry. */
const HEALTHZ_BODY = JSON.stringify({ status: 'ok' });

/** Whether a route handler ran and answered 2xx/3xx or with one of its enumerated answers. */
function admitted(result: ProbeResult): boolean {
  const status = result.res.statusCode;
  const [handler] = result.handlers;
  if (handler === undefined) return result.request === 'GET /healthz' && status === 200 && result.res.body === HEALTHZ_BODY;
  if (status >= 200 && status < 400) return true;
  return HANDLER_ANSWERS.some((answer) => answer.routes.includes(handler.route) && answer.status === status && answer.matches(result));
}

function outcomeOf(result: ProbeResult): Observed {
  if (renderedDenialOf(result) !== undefined) {
    const status = result.res.statusCode === 401 ? 401 : 403;
    return { kind: result.sessionLookups > 0 ? 'denied-gate' : 'denied-auth', status };
  }
  return admitted(result) ? ALLOWED : { kind: 'unexplained', status: result.res.statusCode };
}

/** Every way a refused `result` departs from the rendered denial, with legacy's `challenge` where it sends one, before any handler effect. */
function denialProblems(result: ProbeResult, at: string, challenge?: string): string[] {
  const rendered = renderedDenialOf(result);
  if (rendered === undefined) return [`${at}: ${result.res.statusCode} is not a rendered auth denial: ${result.res.body.slice(0, 200)}`];
  const problems: string[] = [];
  const headers = Object.entries(rendered.headers).filter(([name]) => name.toLowerCase() !== 'www-authenticate');
  for (const [name, value] of headers) {
    const sent = result.res.headers[name.toLowerCase()];
    if (String(sent) !== value) problems.push(`${at}: header ${name} is ${String(sent)}, not ${value}`);
  }
  const expectedChallenge = challenge ?? Object.entries(rendered.headers).find(([name]) => name.toLowerCase() === 'www-authenticate')?.[1];
  const sentChallenge = result.res.headers['www-authenticate'];
  if ((sentChallenge === undefined ? undefined : String(sentChallenge)) !== expectedChallenge) {
    problems.push(`${at}: WWW-Authenticate is ${String(sentChallenge)}, not ${String(expectedChallenge)}`);
  }
  const effects = { writes: result.writes.length, puts: result.puts, tasks: result.tasksCreated, csrfConsumes: result.csrfConsumes.length };
  if (Object.values(effects).some((count) => count > 0)) problems.push(`${at}: denial left effects ${JSON.stringify(effects)}`);
  return problems;
}

function describeResult(result: ProbeResult): string {
  const thrown = thrownBy(result);
  return `${result.res.statusCode} ${result.res.body.slice(0, 200)}${thrown === undefined ? '' : ` (the handler threw ${thrown})`}`;
}

const unexpectedAllows: string[] = [];
const unexpectedDenies: string[] = [];
const wrongDenials: string[] = [];

const REPO_ROOT = new URL('../../../../', import.meta.url);

async function readYaml(relative: string): Promise<unknown> {
  return parseYaml(await readFile(new URL(relative, REPO_ROOT), 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('strategies-content authorisation matrix', () => {
  describe('the literal route table', () => {
    it('matches every registered route with exactly one family', () => {
      const unmatched = MATRIX.filter((entry) => familiesOf(entry).length !== 1).map(
        (entry) => `${routeKey(entry)} matches ${familiesOf(entry).map((family) => family.family).join(', ') || 'no family'}`,
      );
      expect(unmatched).toEqual([]);
    });

    it('has no stale entry: every url and method of every family names a registered route', () => {
      const stale = FAMILIES.flatMap((family) =>
        family.match.flatMap((match) =>
          match.methods
            .filter((method) => !MATRIX.some((entry) => matches({ ...match, methods: [method] }, entry)))
            .map((method) => `${family.family}: ${method} ${match.url ?? `${match.prefix ?? ''}…`}`),
        ),
      );
      expect(stale).toEqual([]);
    });

    it("declares each route's transport, roles, public flag, optional invocation credential and site check as its family does", () => {
      const declared = (entry: Pick<RouteMatrixEntry, 'transport' | 'requires' | 'public' | 'invocationOptional' | 'siteCheck'>) => ({
        transport: entry.transport,
        ...(entry.requires === undefined ? {} : { requires: [...entry.requires] }),
        ...(entry.public === true ? { public: true } : {}),
        ...(entry.invocationOptional === true ? { invocationOptional: true } : {}),
        siteCheck: entry.siteCheck,
      });
      const drift = MATRIX.flatMap((entry) => {
        const [family] = familiesOf(entry);
        if (family === undefined) return [];
        const expected = declared({
          transport: family.transport,
          siteCheck: family.declared.siteCheck,
          ...('requires' in family.declared ? { requires: [...family.declared.requires] } : { public: true as const }),
          ...(family.invocationOptional === true ? { invocationOptional: true as const } : {}),
        });
        return JSON.stringify(declared(entry)) === JSON.stringify(expected) ? [] : [`${routeKey(entry)}: ${JSON.stringify(declared(entry))} ≠ ${JSON.stringify(expected)}`];
      });
      expect(drift).toEqual([]);
      expect(MATRIX.filter((entry) => entry.edge === true).map(routeKey)).toEqual([]);
    });

    it('enumerates handler answers of registered routes only', () => {
      const registered = new Set(MATRIX.map(routeKey));
      expect(HANDLER_ANSWERS.flatMap((answer) => answer.routes).filter((route) => !registered.has(route))).toEqual([]);
    });

    it('declares on every route the transport transportForPath gives its url', () => {
      expect(MATRIX.filter((entry) => transportForPath(entry.url) !== entry.transport).map(routeKey)).toEqual([]);
    });

    it("lists each gated circuit's roles as access.ts declares them", () => {
      const circuits = FAMILIES.filter((family): family is Family & { circuit: GatedContentAdminCircuit } => family.circuit !== undefined && family.circuit !== 'cnav');
      const table = Object.fromEntries(circuits.map((family) => [family.circuit, 'requires' in family.declared ? [...family.declared.requires] : []]));
      const declared = Object.fromEntries(Object.entries(CIRCUIT_ROUTE_REQUIRES).map(([circuit, roles]) => [circuit, [...roles]]));
      expect(declared).toEqual(table);
    });

    it('names the four consumed subscriptions and the two site-monitor job paths', () => {
      expect([...PUSH_URLS].sort()).toEqual(CONTENT_SUBSCRIPTIONS.map((subscription) => `/internal/v1/events/${subscription}`).sort());
      expect([...JOB_URLS].sort()).toEqual([FEED_AUTO_IMPORT_PATH, PUBLISH_SCHEDULED_CHANGESETS_PATH].sort());
    });

    it('keeps cnav public as the inventory role override and the contract both record it', async () => {
      const overrides = await readYaml('harness/inventory/role-overrides.yaml');
      const cnav = isRecord(overrides) && Array.isArray(overrides.overrides) ? overrides.overrides.find((row: unknown) => isRecord(row) && row.id === 'role:cnav.*') : undefined;
      expect(isRecord(cnav) ? cnav.requiredRole : undefined).toBe('public');
      const inventory = JSON.parse(await readFile(new URL('opt2/inventory/legacy-inventory.json', REPO_ROOT), 'utf8')) as { controllers: Array<{ id: string; requiredRole?: { override?: string } }> };
      expect(inventory.controllers.find((controller) => controller.id === 'ctl:cnav')?.requiredRole?.override).toBe('harness/inventory/role-overrides.yaml#role:cnav.*');
      const contract = await readYaml('services/strategies-content/contracts/openapi.yaml');
      const paths = isRecord(contract) && isRecord(contract.paths) ? contract.paths : {};
      const operations = Object.entries(paths)
        .filter(([path]) => path.startsWith('/v1/raw/cnav/'))
        .flatMap(([, item]) => (isRecord(item) ? Object.values(item).filter(isRecord) : []));
      expect(operations.length).toBeGreaterThan(0);
      expect(operations.map((operation) => [operation['x-opt2-public'], operation['x-opt2-requires']])).toEqual(operations.map(() => [true, undefined]));
      expect(familiesOf({ method: 'GET', url: '/v1/raw/cnav/searchsitedata' }).map((family) => family.declared)).toEqual([PUBLIC_CHECKED]);
    });

    it('probes the content subjects, the synthetic roles, the platform callers, both managed invokers and every gate probe', () => {
      const names = SUBJECTS.map((subject) => subject.name);
      expect(new Set(names).size).toBe(names.length);
      const required = [
        ...CONTENT_SUBJECTS,
        ...SYNTHETIC_SUBJECTS,
        serviceRole('migration'),
        serviceRole('operator'),
        serviceRole('programs-sites'),
        TASKS_INVOKER_ROLE,
        PUBSUB_INVOKER_ROLE,
        ...GATE_PROBES.map(([name]) => name),
      ];
      expect(required.filter((name) => !names.includes(name))).toEqual([]);
      expect(subjectNamed('other-tenant').site).toBe(SITE_B);
      expect(subjectNamed('editor').userRoles).toContain(M.siteManager);
    });
  });

  const passes = [
    ...MATRIX.map((entry) => ({ entry, feedManager: true, key: routeKey(entry) })),
    // The cfeed routes again on a site whose stored feedManager is 0, which cfeed.cfc:87 refuses to every caller.
    ...MATRIX.filter((entry) => familiesOf(entry)[0]?.family === 'cfeed').map((entry) => ({ entry, feedManager: false, key: `${routeKey(entry)} (feedManager 0)` })),
  ];
  for (const { entry, feedManager, key } of passes) {
    const [family] = familiesOf(entry);
    describe(key, () => {
      if (!feedManager) {
        beforeAll(() => {
          storedFeedManager = 0;
        });
        afterAll(() => {
          storedFeedManager = 1;
        });
      }
      const cells = SUBJECTS.map((subject) => {
        const expected = family === undefined ? undefined : expectedOutcome(family, subject, feedManager);
        const label = expected === undefined ? 'no family' : outcomeLabel(expected);
        return { title: `${key} × ${subject.name} → ${label}`, subject, expected };
      });
      it.each(cells)('$title', async ({ title, subject, expected }) => {
        if (family === undefined || expected === undefined) throw new Error(`${routeKey(entry)} has no family in the literal table`);
        const result = await sendCell(entry, family, subject);
        const observed = outcomeOf(result);
        const problems: string[] = [];
        if (!sameOutcome(observed, expected)) {
          const line = `${title}: observed ${outcomeLabel(observed)}, ${describeResult(result)}`;
          problems.push(line);
          // An expected denial that is not rendered counts as an allow; an expected allow that is not admitted, as a deny.
          if (expected.kind !== 'allowed' && (observed.kind === 'allowed' || observed.kind === 'unexplained')) unexpectedAllows.push(line);
          else if (expected.kind === 'allowed') unexpectedDenies.push(line);
          else wrongDenials.push(line);
        }
        const [handler] = result.handlers;
        if (observed.kind === 'allowed' && handler !== undefined && handler.route !== routeKey(entry)) {
          problems.push(`${title}: answered by the ${result.handlers.map((entered) => entered.route).join(', ')} handler`);
        }
        if (observed.kind === 'denied-auth' || observed.kind === 'denied-gate') {
          problems.push(...denialProblems(result, title, expected.kind === 'allowed' ? undefined : expected.challenge));
        }
        expect(problems).toEqual([]);
      });
    });
  }

  it('zero unexpected allows, zero unexpected denies and zero denials of the wrong kind', () => {
    expect({ unexpectedAllows, unexpectedDenies, wrongDenials }).toEqual({ unexpectedAllows: [], unexpectedDenies: [], wrongDenials: [] });
  });
});

const SERVICE_TRANSPORT: Pick<RouteMatrixEntry, 'transport'> = Object.freeze({ transport: 'service' });

/** `subject`'s credential on a service route. */
const credentialOf = (name: string): Promise<Credential> => credentialFor(subjectNamed(name), SERVICE_TRANSPORT, '');

/** The body `renderAuthDenial` gives `denial` for a request with `query`. */
function denialBody(denial: AuthDenial, query: Record<string, string> = {}): string {
  return renderAuthDenial(denial, { query } as unknown as DenialRequest).body;
}

function entryNamed(method: HttpMethod, url: string): RouteMatrixEntry {
  const entry = MATRIX.find((candidate) => candidate.method === method && candidate.url === url);
  if (entry === undefined) throw new TypeError(`No registered route ${method} ${url}`);
  return entry;
}

function familyOf(entry: RouteMatrixEntry): Family {
  const [family] = familiesOf(entry);
  if (family === undefined) throw new TypeError(`${routeKey(entry)} has no family`);
  return family;
}

describe('legacy handler gates', () => {
  const saveForm = `contentid=${IDS.content.section}&title=Probe&${CSRF_FIELDS}`;

  // The content save writes the decision-list table tcontenteventreminders, so it stays on legacy for every subject.
  it.each([
    ['json', 'member'],
    ['json', 'system-user'],
    ['json', 'editor'],
    ['rest', 'system-user'],
  ])('POST /_api/%s/v1/tenant-a/content × %s → the withheld save answers the legacy 503, consuming no token and writing nothing', async (family, name) => {
    const result = await send(postForm(`/_api/${family}/v1/${SITE_A}/content`, saveForm), await credentialOf(name));
    expect(result.res.statusCode).toBe(503);
    expect({ writes: result.writes.length, csrfConsumes: result.csrfConsumes }).toEqual({ writes: 0, csrfConsumes: [] });
  });

  it.each<[string, () => Promise<Credential>, keyof typeof LEGACY_ERROR_MAP]>([
    ['an expired user token', () => userCredential({ sub: SUBJECT_USER_IDS['site-admin'], roles: [Roles.siteAdmin], exp: Math.floor(Math.min(Date.now(), CLOCK.now().getTime()) / 1000) - 60 }), 'accessTokenExpired'],
    [
      'a tampered user token',
      async () => {
        const credential = await userCredential({ sub: SUBJECT_USER_IDS['site-admin'], roles: [Roles.siteAdmin] });
        const bearer = credential.headers.authorization ?? '';
        const tampered = `${bearer.slice(0, -4)}${bearer.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
        return { ...credential, headers: { ...credential.headers, authorization: tampered } };
      },
      'invalidAccessToken',
    ],
  ])('GET /_api/rest/v1/tenant-a/content × %s → denied (401 invalid_token) with the legacy bearer challenge', async (_label, credential, type) => {
    const result = await send(get(`/_api/rest/v1/${SITE_A}/content/${IDS.content.pageOne}`), await credential());
    const { status, code, message } = LEGACY_ERROR_MAP[type];
    expect(result.res.statusCode).toBe(status);
    expect(JSON.parse(result.res.body)).toMatchObject({ error: { code, message } });
    expect(code).toBe('invalid_token');
    expect(result.res.headers['www-authenticate']).toBe(WWW_AUTHENTICATE.bearerInvalidAccessToken);
    expect(denialProblems(result, type)).toEqual([]);
  });

  it.each([undefined, REFERER])('GET /v1/sites/tenant-a/changesets × m:014 only, Referer %s → denied (403 gate): the forbidden envelope, no Location', async (referer) => {
    const probe = get(`/v1/sites/${SITE_A}/changesets`);
    const result = await send({ ...probe, headers: referer === undefined ? {} : { referer } }, await credentialOf('m:014 only'));
    expect(outcomeOf(result)).toEqual({ kind: 'denied-gate', status: 403 });
    expect(result.res.body).toBe(denialBody(AuthDenial.forbidden()));
    expect(result.res.headers.location).toBeUndefined();
    expect(denialProblems(result, 'cchangesets gate')).toEqual([]);
  });

  /** The request parts `secure()` reads: the verified user, the Referer and the url scope. */
  function secureRequest(sub: string | undefined, headers: Headers, query: Headers): FastifyRequest {
    const user = sub === undefined ? undefined : { sub, sid: 's', tid: TENANT_A.tenantId, site: SITE_A, roles: [], s2: false, epoch: 0 };
    const url = withQuery('/v1/sites/tenant-a/changesets', new URLSearchParams(query).toString());
    return { opt2Auth: { user, roles: [], transport: 'service' }, headers, query, url, body: undefined } as unknown as FastifyRequest;
  }

  it.each<[string, string | undefined, Headers, Headers, unknown]>([
    ['a signed-in user with a Referer', SUBJECT_USER_IDS['system-user'], { referer: REFERER }, {}, { kind: 'back', location: REFERER }],
    ['a signed-in user without one', SUBJECT_USER_IDS['system-user'], {}, {}, { kind: 'back', location: './' }],
    [
      'the anonymous principal',
      '',
      {},
      { compactDisplay: 'true' },
      { kind: 'login', redirect: { circuit: 'cLogin', action: 'main', params: [['compactDisplay', 'true']] } },
    ],
    ['a caller without a user token', undefined, {}, {}, { kind: 'login', redirect: { circuit: 'cLogin', action: 'main', params: [] } }],
  ])("secure() sends %s where legacy's controller.cfc:83-92 and utility.cfc:302-309 do", (_label, sub, headers, query, redirect) => {
    const denial = adminDenial(secureRequest(sub, headers, query));
    expect({ status: denial.statusCode, redirect: denial.redirect }).toEqual({ status: sub === undefined || sub === '' ? 401 : 403, redirect });
  });

  afterEach(() => {
    storedFeedManager = 1;
  });

  const GATE_403: Outcome = Object.freeze({ kind: 'denied-gate', status: 403 });

  it.each(
    (
      [
        [1, 's2', '0', ALLOWED],
        [1, 's2', 'false', ALLOWED],
        [1, 'm:011+m:000', '0', ALLOWED],
        [1, 'm:011 only', '1', GATE_403],
        [0, 's2', '1', GATE_403],
        [0, 's2', 'true', GATE_403],
        [0, 'm:011+m:000', '1', GATE_403],
        ['absent', 's2', '1', GATE_403],
      ] as const
    ).map(([stored, name, flag, expected]) => ({ stored, name, flag, expected, label: outcomeLabel(expected) })),
  )(
    'GET /v1/sites/tenant-a/feeds?hasfeedmanager=$flag × $name when programs-sites answers feedManager $stored → $label, whatever the request says',
    async ({ stored, name, flag, expected }) => {
      storedFeedManager = stored;
      const result = await send(get(`/v1/sites/${SITE_A}/feeds?hasfeedmanager=${flag}&hasFeedManager=${flag}`), await credentialOf(name));
      expect(outcomeOf(result), describeResult(result)).toEqual(expected);
      expect(expectedOutcome(familyOf(entryNamed('GET', '/v1/sites/:siteid/feeds')), subjectNamed(name), stored === 1)).toEqual(expected);
    },
  );
});

/** Inbox receipts a request recorded. */
function inboxWrites(result: ProbeResult): RecordedStatement[] {
  return result.statements.filter((statement) => /^INSERT INTO "?\w+"?\."?inbox"?/i.test(statement.sql));
}

/** A tenant-a user token claiming both managed invoker roles and S2, beside the gateway's credential. */
const invokerClaimingUser = (): Promise<Credential> =>
  userCredential({ sub: SUBJECT_USER_IDS.s2, roles: [PUBSUB_INVOKER_ROLE, TASKS_INVOKER_ROLE, Roles.s2] });

const invocationOf = async (caller: string, roles?: string[]): Promise<Credential> => ({
  headers: { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: SERVICE, ...(roles === undefined ? {} : { roles }) })}` },
  query: '',
});

const tasksTokenFor = async (audience: string): Promise<Credential> => ({
  headers: { authorization: `Bearer ${await mintTasksInvokerToken({ audience })}` },
  query: '',
});

/** CF-format and RFC 4122 ids, which differ between two otherwise equal responses. */
const IDS_IN_BODY = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-?[0-9A-F]{12,16}/gi;

describe('transport separation', () => {
  const managed = MATRIX.filter((entry) => entry.transport !== 'service');
  const serviceRoutes = MATRIX.filter((entry) => entry.transport === 'service');

  const MANAGED_REFUSALS: ReadonlyArray<readonly [string, (entry: RouteMatrixEntry) => Promise<Credential>]> = [
    ['an s2 user token beside the gateway credential', () => credentialOf('s2')],
    ['a user token claiming both invoker roles', () => invokerClaimingUser()],
    ['the migration invocation credential', () => invocationOf('migration', [serviceRole('migration'), Roles.platformMigration])],
    ['a pubsub-invoker service token in the invocation header', () => invocationOf('pubsub-invoker', [PUBSUB_INVOKER_ROLE])],
    ['no credential', async () => ({ headers: {}, query: '' })],
    [
      'the other managed credential',
      async (entry) => (entry.transport === 'pubsub-push' ? tasksTokenFor(SERVICE) : { headers: {}, query: `key=${encodeURIComponent(TEST_PUSH_KEY)}` }),
    ],
    [
      'its own credential addressed wrongly',
      async (entry) => (entry.transport === 'pubsub-push' ? { headers: {}, query: 'key=opt2-wrong-push-key' } : tasksTokenFor('identity')),
    ],
  ];

  describe.each(managed.map((entry) => ({ entry, key: routeKey(entry) })))('$key', ({ entry }) => {
    it.each(MANAGED_REFUSALS.map(([label, credential]) => ({ label, credential })))(
      `${routeKey(entry)} × $label → denied (401 auth), no inbox receipt and no task`,
      async ({ credential }) => {
        const result = await send(await probeFor(entry, familyOf(entry)), await credential(entry));
        expect(outcomeOf(result), describeResult(result)).toEqual(AUTH_401);
        expect(denialProblems(result, routeKey(entry))).toEqual([]);
        expect({ inbox: inboxWrites(result).length, tasks: result.tasksCreated }).toEqual({ inbox: 0, tasks: 0 });
      },
    );

    it(`${routeKey(entry)} × its managed credential → allowed`, async () => {
      const invoker = entry.transport === 'pubsub-push' ? PUSH_INVOKER : TASKS_INVOKER;
      const result = await sendCell(entry, familyOf(entry), invoker);
      expect(outcomeOf(result), describeResult(result)).toEqual(ALLOWED);
      // The seed's due change set cannot publish against RecordingDb rows, so admission is shown by the handler's tenant transaction.
      expect(result.statements.some((statement) => statement.tenantId !== null), describeResult(result)).toBe(true);
    });
  });

  it.each(serviceRoutes.map((entry) => ({ entry, key: routeKey(entry) })))('$key × a tasks-invoker token in Authorization → denied (401 invalid token)', async ({ entry }) => {
    const probe = await probeFor(entry, familyOf(entry));
    const result = await send(probe, await tasksTokenFor(SERVICE));
    expect(outcomeOf(result), describeResult(result)).toEqual(AUTH_401);
    expect(denialProblems(result, routeKey(entry))).toEqual([]);
  });

  it.each(serviceRoutes.map((entry) => ({ entry, key: routeKey(entry), declared: entry.invocationOptional === true ? 'answered as anonymous' : 'denied (401 auth)' })))(
    '$key × the push key → $declared',
    async ({ entry }) => {
      const probe = await probeFor(entry, familyOf(entry));
      const pushed = await send(probe, { headers: {}, query: pushQuery() });
      if (entry.invocationOptional !== true) {
        expect(outcomeOf(pushed), describeResult(pushed)).toEqual(AUTH_401);
        expect(denialProblems(pushed, routeKey(entry))).toEqual([]);
        return;
      }
      const anonymous = await send({ ...probe, url: withQuery(probe.url, pushQuery()) }, await credentialOf('anonymous'));
      const comparable = (result: ProbeResult) => ({ status: result.res.statusCode, body: result.res.body.replace(IDS_IN_BODY, '<id>'), writes: result.writes.length });
      expect(comparable(pushed)).toEqual(comparable(anonymous));
    },
  );
});

/** Every string id of `value`, nested objects included. */
function idsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return isRecord(value) ? Object.values(value).flatMap(idsOf) : [];
}

/** Seed ids of tenant-a and of its umbrella pools, which no tenant-b caller may ever see; the Masa sentinels are shared and excluded. */
const TENANT_A_SEED_IDS: readonly string[] = idsOf(IDS).filter((id) => /^A[0-9A-F]{7}-/.test(id));
const FOREIGN_TENANTS: readonly string[] = [TENANT_A.tenantId, TENANT_UMBRELLA.tenantId].map((id) => id.toLowerCase());

describe('site binding and tenancy', () => {
  it.each(
    (
      [
        ['the path', () => get(`/v1/sites/${SITE_B}/content/tree`)],
        ['the query', () => get(`/v1/raw/carch/loadsiteflat?${rawFields(SITE_B)}`)],
        ['the form', () => postForm('/v1/raw/carch/unlocknode', `${rawFields(SITE_B)}&${CSRF_FIELDS}`)],
        ['the JSON API path', () => get(`/_api/json/v1/${SITE_B}/notanentity`)],
        ['the comments proxy call', () => get(`${COMMENTS_PROXY_URL}?method=getContentStats&contentID=${IDS.content.pageOne}&siteid=${SITE_B}`)],
        ['the rater form', () => postForm(RATER_URL, raterFields(SITE_B))],
        ['the feed request', () => get(`/_api/feed/v1?feedid=${IDS.feeds.local}&siteid=${SITE_B}`)],
      ] as const
    ).map(([where, probe]) => ({ where, probe })),
  )('tenant-b in $where × a tenant-a site-admin → denied (403 site mismatch), before any effect', async ({ probe }) => {
    const result = await send(probe(), await credentialOf('site-admin'));
    expect(outcomeOf(result), describeResult(result)).toEqual(AUTH_403);
    expect(result.res.body).toBe(denialBody(AuthDenial.siteMismatch(), result.query));
    expect(denialProblems(result, 'site mismatch')).toEqual([]);
  });

  it.each([
    ['GET /v1/sites/<tid>/content/tree', () => get(`/v1/sites/${TENANT_A.tenantId}/content/tree`)],
    ['GET /v1/raw/carch/loadsiteflat?siteid=<tid>', () => get(`/v1/raw/carch/loadsiteflat?${rawFields(TENANT_A.tenantId)}`)],
  ])("%s × a tenant-a site-admin → denied (403): siteid is compared with the token's site, never its tid", async (_label, probe) => {
    const result = await send(probe(), await credentialOf('site-admin'));
    expect(outcomeOf(result), describeResult(result)).toEqual(AUTH_403);
    expect(denialProblems(result, 'tid as siteid')).toEqual([]);
  });

  it("GET /v1/sites/tenant-a/content/tree × a site-admin token of site tenant-a whose tid is tenant-b's → allowed, reading only that tid", async () => {
    const credential = await userCredential({ sub: SUBJECT_USER_IDS['site-admin'], roles: [Roles.systemUser, Roles.siteAdmin], tid: TENANT_B.tenantId });
    const result = await send(get(`/v1/sites/${SITE_A}/content/tree`), credential);
    expect(outcomeOf(result), describeResult(result)).toEqual(ALLOWED);
    const tenants = new Set(result.statements.flatMap((statement) => (statement.tenantId === null ? [] : [statement.tenantId.toLowerCase()])));
    expect([...tenants]).toEqual([TENANT_B.tenantId.toLowerCase()]);
  });

  it.each(MATRIX.map((entry) => ({ entry, key: routeKey(entry) })))(
    '$key × other-tenant on its own tenant-b probe → runs only in tenant-b and reveals no tenant-a data',
    async ({ entry }) => {
      const probe = await probeFor(entry, familyOf(entry), SITE_B);
      const result = await send(probe, await credentialFor(subjectNamed('other-tenant'), entry, probe.url.split('?')[0] ?? probe.url));
      // Handlers echo requested ids (an unknown chain answers as a new bean), so only ids the probe did not send count as leaks.
      const sent = `${probe.url} ${typeof probe.payload === 'string' ? probe.payload : JSON.stringify(probe.payload ?? '')}`.toUpperCase();
      const tenants = [...new Set(result.statements.flatMap((statement) => (statement.tenantId === null ? [] : [statement.tenantId.toLowerCase()])))];
      const foreignWrites = result.writes.filter((statement) => statement.params.some((param) => typeof param === 'string' && FOREIGN_TENANTS.includes(param.toLowerCase())));
      expect(
        {
          tenants: tenants.filter((tenant) => tenant !== TENANT_B.tenantId.toLowerCase()),
          leakedIds: TENANT_A_SEED_IDS.filter((id) => !sent.includes(id.toUpperCase()) && result.res.body.toUpperCase().includes(id.toUpperCase())),
          foreignWrites: foreignWrites.map((statement) => statement.sql.slice(0, 80)),
        },
        describeResult(result),
      ).toEqual({ tenants: [], leakedIds: [], foreignWrites: [] });
    },
  );

  describe('signed objects on GET /opt2/files/content-files/*', () => {
    const anonymous = (): Promise<Credential> => credentialOf('anonymous');
    const seeded = (): Buffer => t.storage.objects.get(SEEDED_PDF_KEY)?.bytes ?? Buffer.alloc(0);

    it('GET <a URL getFileDownloadUrl issued> × anonymous → allowed (200), streaming the stored bytes and content type', async () => {
      const issued = await send(get(`/v1/sites/${SITE_A}/files/${IDS.files.pdf}/download-url`), await credentialOf('site-admin'));
      expect(issued.res.statusCode, describeResult(issued)).toBe(200);
      const { url } = JSON.parse(issued.res.body) as { url: string };
      const result = await send(get(url), await anonymous());
      expect(result.res.statusCode).toBe(200);
      expect(result.res.rawPayload.equals(seeded())).toBe(true);
      expect(result.res.headers['content-type']).toBe('application/pdf');
    });

    it.each([
      ['a tampered sig', (url: string) => url.replace(/([?&]sig=)([0-9A-Za-z_-])/, (_whole, lead: string, first: string) => `${lead}${first === 'A' ? 'B' : 'A'}`)],
      ['a missing sig', (url: string) => url.replace(/[?&]sig=[^&]*/, '')],
    ])('GET <the seeded URL with %s> × anonymous → denied (403 auth), reading no object', async (_label, alter) => {
      const url = alter(SEEDED_PDF_URL);
      expect(url).not.toBe(SEEDED_PDF_URL);
      const result = await send(get(url), await anonymous());
      expect(outcomeOf(result), describeResult(result)).toEqual(AUTH_403);
      expect(denialProblems(result, 'signed object')).toEqual([]);
      expect(result.objectReads).toBe(0);
    });

    it(`GET <a URL issued ${SIGNED_URL_TTL_S + 1} s ago> × anonymous → denied (403 auth), reading no object`, async () => {
      const url = await t.storage.signedUrl('content-files', SEEDED_PDF_KEY);
      clockOffsetMs = (SIGNED_URL_TTL_S + 1) * 1000;
      try {
        const result = await send(get(url), await anonymous());
        expect(outcomeOf(result), describeResult(result)).toEqual(AUTH_403);
        expect(denialProblems(result, 'expired signed object')).toEqual([]);
        expect(result.objectReads).toBe(0);
      } finally {
        clockOffsetMs = 0;
      }
    });
  });
});

describe('reproduced legacy weaknesses', () => {
  it('POST /v1/raw/carch/approvalaction × site-admin without a CSRF token → allowed, applying the approval and consuming no token', async () => {
    const form = new URLSearchParams({ siteid: SITE_A, requestID: IDS.approval.request, action: 'approve', comment: 'approved without a token' }).toString();
    const result = await send(postForm('/v1/raw/carch/approvalaction', form), await credentialOf('site-admin'));
    expect(result.res.statusCode, describeResult(result)).toBe(200);
    expect(result.writes.length).toBeGreaterThan(0);
    expect(result.csrfConsumes).toEqual([]);
  });

  it('cChangesets.publish, which checks no CSRF token, has no target route: POST /v1/sites/tenant-a/changesets/<id>/publish × site-admin → 404, writing nothing', async () => {
    expect(MATRIX.filter((entry) => /\/changesets\b.*publish/i.test(entry.url)).map(routeKey)).toEqual([]);
    const result = await send(postForm(`/v1/sites/${SITE_A}/changesets/${IDS.changesets.scheduledFuture}/publish`, 'csrf_token='), await credentialOf('site-admin'));
    expect(result.res.statusCode).toBe(404);
    expect({ writes: result.writes.length, csrfConsumes: result.csrfConsumes }).toEqual({ writes: 0, csrfConsumes: [] });
  });

  it("POST /v1/sites/tenant-a/changesets/<id>/rollback × site-admin with a refused token → one consume (changesetid), no write, legacy's edit redirect", async () => {
    const changesetId = IDS.changesets.scheduledFuture;
    const result = await send(postForm(`/v1/sites/${SITE_A}/changesets/${changesetId}/rollback`, CSRF_FIELDS), await credentialOf('site-admin'), false);
    expect(result.res.statusCode, describeResult(result)).toBe(200);
    expect(JSON.parse(result.res.body)).toEqual({
      saved: false,
      errors: {},
      redirect: { circuit: 'cChangesets', action: 'edit', params: [['changesetID', changesetId], ['siteID', SITE_A]] },
    });
    expect({ writes: result.writes.length, csrfConsumes: result.csrfConsumes }).toEqual({ writes: 0, csrfConsumes: [{ context: changesetId }] });
  });

  it('POST /v1/sites/tenant-a/categories (ccategory.update) × site-admin with a refused token → one consume (categoryid), no write', async () => {
    const categoryId = IDS.categories.pooledChild;
    const form = `categoryid=${categoryId}&action=update&name=News&${CSRF_FIELDS}`;
    const result = await send(postForm(`/v1/sites/${SITE_A}/categories`, form), await credentialOf('site-admin'), false);
    expect(outcomeOf(result), describeResult(result)).toEqual(ALLOWED);
    expect({ writes: result.writes.length, csrfConsumes: result.csrfConsumes }).toEqual({ writes: 0, csrfConsumes: [{ context: categoryId }] });
  });
});

describe('undeclared routes', () => {
  it.each<[string, (app: FastifyInstance) => unknown]>([
    ['no config.opt2', (app) => app.get('/undeclared', async () => ({}))],
    ['an empty requires list', (app) => app.get('/undeclared', { config: { opt2: { requires: [] } } }, async () => ({}))],
    ['both requires and public', (app) => app.get('/undeclared', { config: { opt2: { requires: [Roles.s2], public: true } } }, async () => ({}))],
    [
      'the service transport on a Cloud Tasks path',
      (app) => app.post('/internal/v1/jobs/x', { config: { opt2: { requires: [TASKS_INVOKER_ROLE], transport: 'service' } satisfies Opt2RouteConfig } }, async () => ({})),
    ],
    [
      'a public managed route',
      (app) => app.post('/internal/v1/events/strategies-content.undeclared.v1', { config: { opt2: { public: true, transport: 'pubsub-push' } } }, async () => ({})),
    ],
  ])('fails start-up for a route with %s', async (_label, declare) => {
    const env = loadEnv(undefined, testEnv(t.stateDir, { LOG_LEVEL: 'fatal' }));
    const app = await createService({ name: `${SERVICE}-undeclared`, version: '0.0.0', env, verifierOverride: testVerifier() });
    try {
      const startUp = (async () => {
        await app.register(async (scope) => {
          declare(scope);
        });
        await app.ready();
      })();
      await expect(startUp).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  it.each([
    ['GET', '/v1/sites/tenant-a/undeclared', 's2'],
    ['GET', '/internal/v1/undeclared', serviceRole('migration')],
    ['DELETE', '/internal/v1/migration/apply', serviceRole('migration')],
    ['POST', '/v1/sites/tenant-a/header-prompts', 's2'],
    ['GET', '/v1/sites/tenant-a/undeclared', 'anonymous'],
  ] as const)('%s %s × %s → the legacy 404, with no effect', async (method, url, name) => {
    const result = await send({ method, url }, await credentialOf(name));
    expect({ status: result.res.statusCode, writes: result.writes.length, statements: result.statements.length }).toEqual({ status: 404, writes: 0, statements: 0 });
  });
});
