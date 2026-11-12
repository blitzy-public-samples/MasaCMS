/** Logged-in sessions per authorisation-matrix subject, through the gateway or legacy directly, over HTTP only. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Roles, SYNTHETIC_ROLES, createLocalInvocationMinter, loadLocalSigningKeys } from '@opt2/platform/auth';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  authHeadersFor,
  registryPayloads,
  type RoleSubject,
} from '@opt2/platform/testing';
import {
  SEED_CREDENTIALS_FILE,
  adminLogin,
  jsonApiLogin,
  loadSecretStore,
  loadSeedStore,
  resolvePlaceholders,
  secretValues,
  type LoginCredentials,
  type LoginResult,
  type Origin,
  type ScenarioContext,
  type SeedStore,
} from '../../src/golden/session.js';
import { createHttpSession, type HttpResult, type HttpSession } from '../../src/lib/http.js';
import { secretsDir, stateDir } from '../../src/lib/paths.js';
import { gatewayUrl, legacyUrl } from './stack.js';

/** Where a session's requests go: the gateway, or legacy ColdFusion directly. */
export type { Origin };

/** Credentials of one login; `site` is the site of a seeded account. */
export interface Credentials extends LoginCredentials {
  site?: string;
}

/** A fresh session logged in as `subject`; it records who logged in, never the password. */
export interface SubjectSession {
  subject: RoleSubject;
  kind: 'anonymous' | 'admin' | 'member' | 'service';
  session: HttpSession;
  username?: string;
  site?: string;
  /** Invocation credential of a service subject, kept out of the session's headers. */
  invocationHeaders?: Record<string, string>;
}

const ADMIN_LOGOUT_PATH = '/admin/?muraAction=clogin.logout';
const REDACTED = '<redacted>';
const CONTEXT_ID = 'e2e-subjects';
/** `status` values with which legacy returns a refused admin login to `cLogin.main` (loginManager.cfc:211-240). */
const REFUSED_LOGIN_STATUSES: ReadonlySet<string> = new Set(['failed', 'challenge']);
const SECRET_REF = /^\$\{secret:(admin|qa_editor|seed:[^}]+)\}$/;
const USER_REF = /^\$\{user:([^:}]+):([^}]+)\}$/;
const CREDENTIAL_REF_FORMS = '${secret:admin}, ${secret:qa_editor}, ${secret:seed:<user>} or ${user:<site>:<role>}';

type UserLogin = { kind: 'member' } | { kind: 'admin'; ref: string };
type FixedUserSubject =
  | typeof Roles.member
  | typeof Roles.systemUser
  | 'editor'
  | typeof Roles.siteAdmin
  | typeof Roles.s2
  | 'other-tenant';

const userRef = (site: string, role: string): string => `\${user:${site}:${role}}`;

const FIXED_USER_LOGINS = {
  [Roles.member]: { kind: 'member' },
  [Roles.systemUser]: { kind: 'admin', ref: userRef(TENANT_A.siteId, Roles.systemUser) },
  editor: { kind: 'admin', ref: '${secret:qa_editor}' },
  [Roles.siteAdmin]: { kind: 'admin', ref: userRef(TENANT_A.siteId, Roles.siteAdmin) },
  [Roles.s2]: { kind: 'admin', ref: '${secret:admin}' },
  // Privileged in tenant-b, so a denial on tenant-a shows tenant scoping rather than role scoping.
  'other-tenant': { kind: 'admin', ref: userRef(TENANT_B.siteId, Roles.siteAdmin) },
} as const satisfies Record<FixedUserSubject, UserLogin>;

const ORIGINS = new WeakMap<HttpSession, Origin>();

let context: ScenarioContext | undefined;
let reservedUsernames: ReadonlySet<string> | undefined;

/** Values replaced by `<redacted>` in `text`, longest first so a value's prefix cannot leave a tail behind. */
function redactValues(text: string, values: Iterable<string>): string {
  const ordered = [...new Set(values)].filter((value) => value !== '').sort((a, b) => b.length - a.length);
  return ordered.reduce((masked, value) => masked.replaceAll(value, REDACTED), text);
}

/** Secret values resolved so far, without building the context, so an error path never fails on a missing file. */
function knownSecretValues(): string[] {
  return context === undefined ? [] : secretValues(context);
}

/** A login the target or legacy refused; its message never carries a resolved secret. */
export class LoginFailedError extends Error {
  override readonly name = 'LoginFailedError';
  readonly username: string;
  readonly origin: string;

  constructor(username: string, origin: string, detail: string, options?: ErrorOptions) {
    super(redactValues(`login as ${username} at ${origin} failed: ${detail}`, knownSecretValues()), options);
    this.username = username;
    this.origin = origin;
  }
}

function track(session: HttpSession, origin: Origin): HttpSession {
  ORIGINS.set(session, origin);
  return session;
}

/** Fresh gateway session with its own cookie jar. */
export function gatewaySession(): HttpSession {
  return track(createHttpSession({ baseUrl: gatewayUrl() }), 'gateway');
}

/** Fresh legacy session with its own cookie jar. */
export function legacySession(): HttpSession {
  return track(createHttpSession({ baseUrl: legacyUrl() }), 'legacy');
}

function sessionFor(origin: Origin): HttpSession {
  return origin === 'gateway' ? gatewaySession() : legacySession();
}

function originLabel(session: HttpSession): string {
  const origin = new URL(session.baseUrl).origin;
  const name = ORIGINS.get(session);
  return name === undefined ? origin : `${name} ${origin}`;
}

/** Secret and seed stores over the environment and `${OPT2_STATE_DIR}/secrets/`, built once. */
function credentialContext(): ScenarioContext {
  if (context === undefined) {
    if (!existsSync(join(secretsDir(), SEED_CREDENTIALS_FILE))) {
      throw new Error('seed credentials not found; run harness/repro/up.sh');
    }
    context = {
      origin: 'gateway',
      baseUrl: gatewayUrl(),
      scenarioId: CONTEXT_ID,
      sessions: new Map(),
      bindings: new Map(),
      seedRows: new Map(),
      secrets: loadSecretStore(),
      seed: loadSeedStore(),
      env: process.env,
    };
  }
  return context;
}

function stringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`reserved.rehearsal.${key} in the seed config is not a list of strings`);
  }
  return value;
}

/** Lower-cased reserved usernames: configured ones plus the reserved persons', read through the seed store once. */
function loadReservedUsernames(seed: SeedStore): ReadonlySet<string> {
  const rehearsal = seed.select({ as: 'rehearsal', source: 'reserved', path: 'reserved.rehearsal' }) as Record<
    string,
    unknown
  >;
  const persons = stringList(rehearsal, 'persons').map((userID) => {
    const row = seed.select({ as: 'rehearsalPerson', source: 'dataset', path: 'masa.users', where: { userID } });
    const { username } = row as { username?: unknown };
    if (typeof username !== 'string') throw new Error(`reserved person ${userID} has no username in the seed dataset`);
    return username;
  });
  return new Set([...stringList(rehearsal, 'usernames'), ...persons].map((name) => name.toLowerCase()));
}

/** Throws for a reserved rollback-rehearsal identity, which only the GS-PE-RH scenarios may touch. */
function assertNotReserved(username: string): void {
  reservedUsernames ??= loadReservedUsernames(credentialContext().seed);
  if (reservedUsernames.has(username.toLowerCase())) {
    throw new Error(`${username} is a reserved rollback-rehearsal identity; only the GS-PE-RH scenarios may use it`);
  }
}

/** Username of the installed S2 account, as the golden session logins name it. */
function adminUsername(): string {
  const configured = process.env.MURA_ADMIN_USERNAME;
  return configured === undefined || configured === '' ? 'admin' : configured;
}

/** Username and password `ref` names; throws for an unsupported form or a reserved rehearsal identity. */
export function credentialsFor(ref: string): Credentials {
  const ctx = credentialContext();
  const user = USER_REF.exec(ref);
  if (user !== null) {
    const username = resolvePlaceholders(ref, ctx);
    assertNotReserved(username);
    return { username, password: resolvePlaceholders(`\${secret:seed:${username}}`, ctx), site: user[1] as string };
  }
  const secret = SECRET_REF.exec(ref)?.[1];
  if (secret === undefined) {
    throw new Error(`unsupported credential reference ${ref}; expected ${CREDENTIAL_REF_FORMS}`);
  }
  const username =
    secret === 'admin' ? adminUsername() : secret === 'qa_editor' ? secret : secret.slice('seed:'.length);
  assertNotReserved(username);
  return { username, password: resolvePlaceholders(ref, ctx) };
}

/** `text` with every secret value resolved so far replaced by `<redacted>`. */
export function redactSecrets(text: string): string {
  return redactValues(text, secretValues(credentialContext()));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** LoginFailedError for `creds` with the attempted password stripped; a cause that quoted it is left out. */
function loginFailed(session: HttpSession, creds: Credentials, detail: string, cause?: unknown): LoginFailedError {
  const { password } = creds;
  const formEncoded = new URLSearchParams({ p: password }).toString().slice('p='.length);
  const masked = redactValues(detail, [password, encodeURIComponent(password), formEncoded]);
  const options = cause === undefined || masked !== detail ? undefined : { cause };
  return new LoginFailedError(creds.username, originLabel(session), masked, options);
}

/** Whether `url` is legacy's `cLogin.main` page reporting a refused or challenged login. */
function isRefusedLogin(url: string): boolean {
  const params = new Map<string, string>();
  for (const [name, value] of new URL(url).searchParams) params.set(name.toLowerCase(), value.toLowerCase());
  return params.get('muraaction') === 'clogin.main' && REFUSED_LOGIN_STATUSES.has(params.get('status') ?? '');
}

/** URL of the first hop that reached or redirected to a refused-login page, or undefined. */
function refusedHop(result: HttpResult): string | undefined {
  for (const hop of result.hops) {
    if (isRefusedLogin(hop.url)) return hop.url;
    if (hop.location !== undefined && URL.canParse(hop.location, hop.url)) {
      const target = new URL(hop.location, hop.url).href;
      if (isRefusedLogin(target)) return target;
    }
  }
  return undefined;
}

/** Admin login through the `clogin.main` form; returns the final response, throws LoginFailedError when refused. */
export async function loginAdmin(session: HttpSession, creds: Credentials): Promise<HttpResult> {
  let outcome: LoginResult;
  try {
    outcome = await adminLogin(session, { username: creds.username, password: creds.password });
  } catch (err) {
    throw loginFailed(session, creds, `the admin login exchange failed: ${messageOf(err)}`, err);
  }
  const { result, ok } = outcome;
  const refused = refusedHop(result);
  if (refused !== undefined) {
    const status = new URL(refused).searchParams.get('status');
    const detail = `legacy answered cLogin.main with status=${status} (final HTTP ${result.status})`;
    throw loginFailed(session, creds, detail);
  }
  if (!ok) {
    const detail = `no admin session after HTTP ${result.status} at ${new URL(result.url).pathname}`;
    throw loginFailed(session, creds, detail);
  }
  return result;
}

/** Public-pool login through the JSON API `login` method on `site`; throws LoginFailedError unless it succeeds. */
export async function loginMember(session: HttpSession, site: string, creds: Credentials): Promise<HttpResult> {
  let outcome: LoginResult;
  try {
    // The golden exchange: tokens for context `login`, then POST /_api/json/v1/<site>/login, which legacy resolves
    // to the same `login` method, with `siteid` from the path, as a root POST carrying method=login.
    outcome = await jsonApiLogin(session, { username: creds.username, password: creds.password, site });
  } catch (err) {
    throw loginFailed(session, creds, `the JSON API login on ${site} failed: ${messageOf(err)}`, err);
  }
  const { result, ok } = outcome;
  if (result.status !== 200 || !ok) {
    const answer = ok ? 'status success' : 'no status success';
    throw loginFailed(session, creds, `the JSON API login on ${site} answered HTTP ${result.status} with ${answer}`);
  }
  return result;
}

/** Admin logout, following legacy's redirect to `home.redirect`; returns the final response. */
export function logout(session: HttpSession): Promise<HttpResult> {
  return session.get(ADMIN_LOGOUT_PATH);
}

/** Site whose public user pool members of `site` belong to: the fixture registry's pool, else the site itself. */
function publicUserPoolOf(site: string): string {
  const wanted = site.toLowerCase();
  return registryPayloads().find((payload) => payload.siteId === wanted)?.publicUserPoolId ?? site;
}

/** Login of a `user` subject: a fixed subject's entry, else the tenant-a user in the synthetic role's group. */
function userLogin(subject: RoleSubject): UserLogin {
  const { name } = subject;
  if (Object.hasOwn(FIXED_USER_LOGINS, name)) return FIXED_USER_LOGINS[name as FixedUserSubject];
  if (SYNTHETIC_ROLES.includes(name)) return { kind: 'admin', ref: userRef(TENANT_A.siteId, name) };
  // ROLE_SET names are typed string, so a user subject this file does not know can only fail here, at runtime.
  throw new Error(`no login is defined for user subject ${name}`);
}

function subjectNamed(name: string): RoleSubject {
  const found = ROLE_SET.find((subject) => subject.name === name);
  if (found === undefined) throw new Error(`no ROLE_SET subject is named ${name}`);
  return found;
}

/** Local invocation credential of a service subject, addressed to the gateway. */
async function invocationHeadersFor(subject: RoleSubject): Promise<Record<string, string>> {
  const { caller } = subject;
  if (caller === undefined) throw new Error(`service subject ${subject.name} has no caller`);
  const keys = await loadLocalSigningKeys(stateDir(), { requirePrivate: true });
  const minter = createLocalInvocationMinter({ keys, caller, roles: [...subject.roles] });
  return minter.headersFor({ name: 'gateway', url: gatewayUrl() });
}

/**
 * Fresh session for `subject` (a ROLE_SET entry or its name) on `origin` (default gateway); `site` is the member
 * login site (default tenant-a, whose public user pool is umbrella).
 */
export async function sessionForSubject(
  subject: RoleSubject | string,
  opts: { origin?: Origin; site?: string } = {},
): Promise<SubjectSession> {
  const resolved = typeof subject === 'string' ? subjectNamed(subject) : subject;
  const session = sessionFor(opts.origin ?? 'gateway');
  const { kind } = resolved;
  switch (kind) {
    case 'anonymous':
      return { subject: resolved, kind: 'anonymous', session };
    case 'service':
      return { subject: resolved, kind: 'service', session, invocationHeaders: await invocationHeadersFor(resolved) };
    case 'user': {
      const login = userLogin(resolved);
      if (login.kind === 'member') {
        const site = opts.site ?? TENANT_A.siteId;
        const creds = credentialsFor(userRef(publicUserPoolOf(site), Roles.member));
        await loginMember(session, site, creds);
        return { subject: resolved, kind: 'member', session, username: creds.username, site };
      }
      const creds = credentialsFor(login.ref);
      await loginAdmin(session, creds);
      return { subject: resolved, kind: 'admin', session, username: creds.username, site: creds.site };
    }
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled subject kind ${String(unhandled)}`);
    }
  }
}

/** Test-key headers for `subject`, which the running stack does not trust: for rejection assertions only. */
export function untrustedAuthHeaders(
  subject: RoleSubject,
  opts: { site: string; audience: string },
): Promise<Record<string, string>> {
  return authHeadersFor(subject, opts);
}
