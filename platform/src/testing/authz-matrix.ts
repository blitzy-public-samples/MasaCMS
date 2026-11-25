/** Authorisation-matrix helpers: subject lookup, credential reuse, the hooks' expected verdict, rendered denials and matrix summaries. */
import {
  AuthDenial,
  MANAGED_INVOKER_NAMES,
  PUBSUB_INVOKER_ROLE,
  TASKS_INVOKER_ROLE,
  hasAnyRole,
  isServiceRole,
  renderAuthDenial,
  rolesForService,
  type DenialResponse,
  type Transport,
} from '../auth/index.js';
import { ROLE_SET, subjectSiteFor, type RoleSubject } from './tokens.js';

type DenialRequest = Parameters<typeof renderAuthDenial>[1];

/** Query parameters of a request, as a denial echoes them. */
export type QueryRecord = Readonly<Record<string, string>>;

/** Subjects every matrix must probe besides the workloads. */
export const MINIMUM_SUBJECTS = Object.freeze(['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const);

/** Statuses of an auth denial. */
export const DENIED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** Denials the auth hooks render, by distinct body and headers. */
export const DENIAL_KINDS: readonly AuthDenial[] = Object.freeze([
  AuthDenial.unauthenticated('missing-credential'),
  AuthDenial.invalidToken(),
  AuthDenial.expiredToken(),
  AuthDenial.forbidden(),
]);

/** Tokens live 300 s; reusing one for at most 120 s keeps a slow run from presenting an expired one. */
export const CREDENTIAL_REUSE_MS = 120_000;

/** Reuses the credential minted for `key` while it is fresh, else mints and keeps a new one. */
export type CredentialCache<T> = (key: string, mint: () => Promise<T>) => Promise<T>;

/** A route as the matrix judges it; the service transport when none is named. */
export interface MatrixRoute {
  transport?: Transport;
  requires?: readonly string[];
  public?: boolean;
  edge?: boolean;
  invocationOptional?: boolean;
  siteCheck?: boolean;
}

/** Options of {@link expectedAuthDenial}. */
export interface ExpectedDenialOptions {
  /** The `siteid` the probe supplies; the site check runs only when one is given. */
  requestSite?: string;
  /** Site user tokens were minted for, as passed to authHeadersFor; tenant-a by default. */
  tokenSite?: string;
  /** Whether the site check applies; the route's `siteCheck` by default. */
  siteCheck?: boolean;
}

/** One route × subject cell with the denial it is owed; undefined when the subject is admitted. */
export interface MatrixCell<R> {
  row: R;
  subject: RoleSubject;
  denial: AuthDenial | undefined;
}

/** What a probe answered, with the query it was sent with. */
export interface ProbeOutcome {
  status: number;
  body: string;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string | undefined>>;
  query: QueryRecord;
}

/** How {@link unexpectedVerdicts} reads a cell. */
export interface VerdictReader<C> {
  title(cell: C): string;
  /** Whether the cell must be admitted. */
  admits(cell: C): boolean;
  /** The status probed; undefined when the cell was not probed. */
  status(cell: C): number | undefined;
}

const [PUBSUB_INVOKER, TASKS_INVOKER] = MANAGED_INVOKER_NAMES;
const GATEWAY_ROLES: readonly string[] = Object.freeze(rolesForService('gateway'));
const SNIPPET = 160;

/** What authHeadersFor and subjectQueryFor present for a subject. */
type Presented = 'none' | 'user' | 'workload' | 'push-key' | 'tasks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A credential cache keyed by subject or probe; `now` is read on each call, so faked timers apply. */
export function createCredentialCache<T>(options: { reuseMs?: number; now?: () => number } = {}): CredentialCache<T> {
  const reuseMs = options.reuseMs ?? CREDENTIAL_REUSE_MS;
  const now = options.now ?? ((): number => Date.now());
  const minted = new Map<string, { mintedAt: number; value: Promise<T> }>();
  return (key, mint) => {
    const hit = minted.get(key);
    if (hit !== undefined && now() - hit.mintedAt < reuseMs) return hit.value;
    const value = mint();
    minted.set(key, { mintedAt: now(), value });
    return value;
  };
}

/** The subject of `subjects`, ROLE_SET by default, named `name`; throws TypeError when there is none. */
export function roleSubjectNamed(name: string, subjects: readonly RoleSubject[] = ROLE_SET): RoleSubject {
  const found = subjects.find((subject) => subject.name === name);
  if (found === undefined) throw new TypeError(subjects === ROLE_SET ? `ROLE_SET has no subject named ${name}` : `No subject named ${name}`);
  return found;
}

/** `body` parsed as JSON; undefined when it is not JSON. */
export function parsedJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether `body` is the legacy JSON API error envelope `{apiversion, method, params?, error: {code, message}}`. */
export function isErrorEnvelope(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.error) || !(body.params === undefined || isRecord(body.params))) return false;
  const { apiversion, method, error } = body;
  return typeof apiversion === 'string' && typeof method === 'string' && typeof error.code === 'string' && typeof error.message === 'string';
}

/** `url` with `query`, a record or encoded text, appended; unchanged when the query is empty. */
export function withQuery(url: string, query: QueryRecord | string): string {
  const search = typeof query === 'string' ? query : new URLSearchParams(query).toString();
  return search === '' ? url : `${url}${url.includes('?') ? '&' : '?'}${search}`;
}

/** Each header of `res` as one string, list values joined by `, `. */
export function headerStrings(res: { readonly headers: Readonly<Record<string, string | number | string[] | undefined>> }): Record<string, string> {
  return Object.fromEntries(Object.entries(res.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]));
}

/** The response renderAuthDenial gives `denial` for a request with `query`, a record or the request url. */
export function renderedDenial(denial: AuthDenial, query: QueryRecord | string): DenialResponse {
  const params = typeof query === 'string' ? Object.fromEntries(new URL(query, 'http://opt2.test').searchParams) : { ...query };
  return renderAuthDenial(denial, { query: params } as unknown as DenialRequest);
}

/** The rendering among `kinds`, at `status` when given, whose body is exactly `body`. */
export function renderedDenialMatching(
  body: string,
  query: QueryRecord | string,
  options: { status?: number; kinds?: readonly AuthDenial[] } = {},
): DenialResponse | undefined {
  return (options.kinds ?? DENIAL_KINDS)
    .filter((denial) => options.status === undefined || denial.statusCode === options.status)
    .map((denial) => renderedDenial(denial, query))
    .find((rendered) => rendered.body === body);
}

/** Every way `outcome` departs from `expected`'s rendering, or from any rendering of `expected` kinds at its status: status, envelope, body and headers. */
export function authDenialProblems(outcome: ProbeOutcome, expected: AuthDenial | readonly AuthDenial[]): string[] {
  const snippet = outcome.body.slice(0, SNIPPET);
  const problems: string[] = [];
  let rendered: DenialResponse | undefined;
  if (expected instanceof AuthDenial) {
    rendered = renderedDenial(expected, outcome.query);
    if (outcome.status !== rendered.status) problems.push(`answered ${outcome.status}, expected ${rendered.status}: ${snippet}`);
  } else if (!DENIED_STATUSES.has(outcome.status)) {
    return [`expected 401 or 403, answered ${outcome.status}: ${snippet}`];
  }
  if (!isErrorEnvelope(parsedJson(outcome.body))) problems.push(`not the legacy error envelope: ${snippet}`);
  if (rendered === undefined) {
    rendered = renderedDenialMatching(outcome.body, outcome.query, { status: outcome.status, kinds: expected as readonly AuthDenial[] });
    if (rendered === undefined) return [...problems, `body is not one renderAuthDenial builds: ${snippet}`];
  } else if (outcome.body !== rendered.body) {
    problems.push(`body ${snippet} is not ${rendered.body}`);
  }
  for (const [name, value] of Object.entries(rendered.headers)) {
    const sent = outcome.headers[name.toLowerCase()];
    if (sent !== value) problems.push(`header ${name} is ${String(sent)}, not ${value}`);
  }
  return problems;
}

function presentedBy(subject: RoleSubject): Presented {
  if (subject.kind === 'anonymous') return 'none';
  if (subject.kind === 'user') return 'user';
  if (subject.caller === undefined) throw new TypeError(`Service subject ${subject.name} has no caller`);
  if (subject.caller === PUBSUB_INVOKER) return 'push-key';
  if (subject.caller === TASKS_INVOKER) return 'tasks';
  return 'workload';
}

/**
 * The denial the platform auth hooks give `subject` on `route` when it presents authHeadersFor's credentials and
 * subjectQueryFor's query; undefined when it is admitted. Handler-level checks are the caller's.
 */
export function expectedAuthDenial(route: MatrixRoute, subject: RoleSubject, options: ExpectedDenialOptions = {}): AuthDenial | undefined {
  if (route.edge === true) return undefined;
  const transport = route.transport ?? 'service';
  const presented = presentedBy(subject);
  let roles: readonly string[];
  if (transport === 'pubsub-push') {
    if (presented === 'user' || presented === 'tasks') return AuthDenial.unauthenticated('wrong-scheme');
    if (presented !== 'push-key') return AuthDenial.unauthenticated('missing-credential');
    roles = [PUBSUB_INVOKER_ROLE];
  } else if (transport === 'cloud-tasks') {
    if (presented === 'user') return AuthDenial.unauthenticated('invalid-credential');
    if (presented !== 'tasks') return AuthDenial.unauthenticated('missing-credential');
    roles = [TASKS_INVOKER_ROLE];
  } else {
    const invocation = presented === 'user' || presented === 'workload';
    if (!invocation && route.invocationOptional !== true) return AuthDenial.unauthenticated('missing-credential');
    // The service transport verifies any Authorization bearer as a user token, which a tasks token is not.
    if (presented === 'tasks') return AuthDenial.invalidToken();
    roles = presented === 'user' ? [...subject.roles.filter((role) => !isServiceRole(role)), ...GATEWAY_ROLES] : presented === 'workload' ? subject.roles : [];
  }
  if (route.requires !== undefined && !hasAnyRole(roles, route.requires)) {
    return presented !== 'user' && route.requires.some((role) => !isServiceRole(role)) ? AuthDenial.unauthenticated('missing-credential') : AuthDenial.forbidden();
  }
  const { requestSite } = options;
  const siteChecked = options.siteCheck ?? route.siteCheck !== false;
  if (presented === 'user' && transport === 'service' && siteChecked && requestSite !== undefined) {
    if (subjectSiteFor(subject, options.tokenSite).toLowerCase() !== requestSite.toLowerCase()) return AuthDenial.siteMismatch();
  }
  return undefined;
}

/** Every `rows` × `subjects` cell with the denial `denialOf` owes it, {@link expectedAuthDenial} by default. */
export function matrixCells<R extends MatrixRoute>(
  rows: readonly R[],
  subjects: readonly RoleSubject[] = ROLE_SET,
  denialOf: (row: R, subject: RoleSubject) => AuthDenial | undefined = (row, subject) => expectedAuthDenial(row, subject),
): MatrixCell<R>[] {
  return rows.flatMap((row) => subjects.map((subject) => ({ row, subject, denial: denialOf(row, subject) })));
}

/** `<title>: <status>` of cells owed a denial yet not denied, unprobed included, and of cells owed admission yet denied. */
export function unexpectedVerdicts<C>(cells: readonly C[], reader: VerdictReader<C>): { unexpectedAllows: string[]; unexpectedDenies: string[] } {
  const mismatched = (allowed: boolean): string[] =>
    cells
      .filter((cell) => reader.admits(cell) === allowed)
      .filter((cell) => DENIED_STATUSES.has(reader.status(cell) ?? 0) === allowed)
      .map((cell) => `${reader.title(cell)}: ${reader.status(cell) ?? 'not probed'}`);
  return { unexpectedAllows: mismatched(false), unexpectedDenies: mismatched(true) };
}

/** Registered keys the table lacks, table keys nothing registers, and registered keys after their first occurrence. */
export function routeTableCoverage(registered: readonly string[], expected: readonly string[]): { missing: string[]; extra: string[]; duplicated: string[] } {
  return {
    missing: registered.filter((key) => !expected.includes(key)),
    extra: expected.filter((key) => !registered.includes(key)),
    duplicated: registered.filter((key, index) => registered.indexOf(key) !== index),
  };
}
