// Gateway reach of declared routes: the edge paths that reach each route's owner, the verdict on a gateway answer,
// and the owner-log evidence that the owner's route handled a probe.
import { randomUUID } from 'node:crypto';
import type { RouteMatrixEntry } from '@opt2/platform/auth';
import {
  ADMIN_LOGIN_REDIRECT_ACTION,
  ADMIN_NOACCESS_ACTION,
  LEGACY_ERROR_MAP,
  cfUuid,
  matchRouteKey,
  normaliseRouteKey,
  parseAdminUrl,
  routeKeyForRequest,
  type LegacyErrorSpec,
  type ParsedAdminUrl,
  type RouteKeyResult,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';
import { LOCAL_SIGNED_URL_PREFIX, isBucketName, signLocalUrl } from '@opt2/platform/storage';
import { ROLE_SET, TENANT_A, type RoleSubject } from '@opt2/platform/testing';
import type { CapturedLogLine } from '../events/traces.js';
import { repoPath } from '../lib/paths.js';
import { readJson } from '../lib/report.js';
import { ROUTED_PACKAGES, type Expectation, type LoadedMatrix, type Observation } from './authz-matrix.js';

/** Dispatcher kinds of a cut-over entry. */
export const ENTRY_KINDS = Object.freeze(['read', 'write', 'legacy-write', 'job', 'static'] as const);

/** How the gateway dispatcher treats a cut-over entry. */
export type EntryKind = (typeof ENTRY_KINDS)[number];

const cutoverVersionSchema = z.object({
  tableVersion: z.string().regex(/^v\d{4}$/, 'must be vNNNN'),
  entries: z.array(
    z.object({
      route: z.string().min(1),
      owningService: z.string().min(1),
      state: z.enum(['legacy', 'target']),
      kind: z.enum(ENTRY_KINDS),
    }),
  ),
});

/** The fields of a cut-over version file the reach map reads. */
export type CutoverVersion = z.infer<typeof cutoverVersionSchema>;

/** One cut-over entry, as the reach map reads it. */
export type CutoverVersionEntry = CutoverVersion['entries'][number];

/** Package whose own Fastify routes answer before its edge catch-all. */
const GATEWAY_PACKAGE = 'gateway';
/** Path prefix of web's relay alias, which the gateway opens only to web's invocation credential. */
export const RELAY_ALIAS_PREFIX = '/opt2/svc/';
/** Route-key prefix on which the gateway verifies a local signed URL before forwarding it. */
const SIGNED_FILE_KEY_PREFIX = `opt2:${LOCAL_SIGNED_URL_PREFIX}`;
const GLOB_SUFFIX = '/**';
const SITE_PARAMS: ReadonlySet<string> = new Set(['siteid', 'site']);
/** A Fastify path token: an escaped colon, a named parameter with an optional regex, or a wildcard. */
const PATH_TOKEN = /::|:(\w+)(?:\([^)]*\))?|\*/g;
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
/** Entry kinds whose request changes state. */
const SIDE_EFFECT_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['write', 'legacy-write', 'job']);
const ADMIN_ROOT = /^\/admin\/?$/i;

/** Error-map rows with which the JSON API refuses a request's credentials. */
const AUTH_ERRORS: readonly LegacyErrorSpec[] = Object.freeze([
  LEGACY_ERROR_MAP.authorization,
  LEGACY_ERROR_MAP.invalidAccessToken,
  LEGACY_ERROR_MAP.accessTokenExpired,
]);

/** Lower-cased admin access-gate actions and the deny status each stands for. */
const GATE_ACTIONS: ReadonlyMap<string, number> = new Map([
  ['clogin.main', 401],
  [ADMIN_LOGIN_REDIRECT_ACTION.toLowerCase(), 401],
  [ADMIN_NOACCESS_ACTION.toLowerCase(), 403],
]);

/** Committed cut-over version file of `version`. */
export function cutoverVersionFile(version: string): string {
  return repoPath('gateway', 'cutover', 'versions', `${version}.json`);
}

/** Reads the entry fields of a cut-over version file; throws when it is malformed or names another version. */
export async function loadCutoverVersion(
  version: string,
  file: string = cutoverVersionFile(version),
): Promise<CutoverVersion> {
  const parsed = await readJson(file, cutoverVersionSchema);
  if (parsed.tableVersion !== version) {
    throw new Error(`${file}: tableVersion ${parsed.tableVersion} differs from the requested ${version}`);
  }
  return parsed;
}

/** One concrete edge path; `entry` is the cut-over entry it matches, absent on the gateway's own routes. */
export interface GatewayPath {
  path: string;
  entry?: { route: string; kind: EntryKind };
}

/** Whether a route is served by the gateway itself or forwarded to its owner by a cut-over entry. */
export type ReachKind = 'gateway-own' | 'cut-over';

/** A declared route the gateway reaches, with every edge path that reaches it; its {@link ReachVerdict} says whether it was probed. */
export interface ProbedRoute {
  package: string;
  method: string;
  url: string;
  reach: ReachKind;
  paths: GatewayPath[];
}

/** Why no edge path reaches a declared route. */
export type NotProbedReason = 'served-by-gateway' | 'no-target-entry';

/** A declared route no edge path reaches, and the suite that covers it instead. */
export interface NotProbedRoute {
  package: string;
  method: string;
  url: string;
  reason: NotProbedReason;
  detail: string;
  coveredBy: string;
}

/** Every non-edge declared route, probed or not, for one cut-over version. */
export interface ReachMap {
  tableVersion: string;
  probed: ProbedRoute[];
  notProbed: NotProbedRoute[];
}

/** Inputs of {@link gatewayReach}; `sign` turns an `/opt2/files/<bucket>/<key>` path into the signed URL to send. */
export interface ReachInputs {
  matrices: readonly LoadedMatrix[];
  version: CutoverVersion;
  variants: readonly VariantDeclaration[];
  sign: (path: string) => string;
  /** Values of named parameters of the gateway's own routes, by name; any other parameter gets a fresh CF UUID. */
  gatewayParams?: Readonly<Record<string, string>>;
}

/** Cut-over lookup the gateway dispatcher would make for a concrete path. */
interface Routing {
  result: RouteKeyResult;
  entry: CutoverVersionEntry | undefined;
}

/** Per-version state shared by every route's classification. */
interface ReachContext {
  inputs: ReachInputs;
  entries: ReadonlyMap<string, CutoverVersionEntry>;
  gatewayRoutes: readonly RouteMatrixEntry[];
  routing(method: string, path: string): Routing;
}

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIALS, '\\$&');
}

const patterns = new Map<string, RegExp>();

/** Anchored matcher of a Fastify route template: a parameter spans one segment, a wildcard the rest. */
function templatePattern(url: string): RegExp {
  let pattern = patterns.get(url);
  if (pattern === undefined) {
    let source = '';
    let last = 0;
    for (const match of url.matchAll(PATH_TOKEN)) {
      source += escapeRegExp(url.slice(last, match.index));
      source += match[0] === '::' ? ':' : match[1] === undefined ? '.*' : '[^/]+';
      last = match.index + match[0].length;
    }
    pattern = new RegExp(`^${source}${escapeRegExp(url.slice(last))}$`);
    patterns.set(url, pattern);
  }
  return pattern;
}

/** Fastify precedence rank of each template segment: static 0, parametric 1, wildcard 2. */
function segmentRanks(url: string): number[] {
  return url.split('/').map((segment) => {
    const unescaped = segment.replaceAll('::', '');
    return /:\w/.test(unescaped) ? 1 : unescaped.includes('*') ? 2 : 0;
  });
}

/** Negative when Fastify tries template `a` before `b`: the first segment whose rank differs decides. */
function compareSpecificity(a: string, b: string): number {
  const ranksA = segmentRanks(a);
  const ranksB = segmentRanks(b);
  for (let i = 0; i < Math.min(ranksA.length, ranksB.length); i += 1) {
    const diff = (ranksA[i] ?? 0) - (ranksB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return ranksB.length - ranksA.length;
}

/** The route among `routes` that Fastify serves `path` with, if any. */
function servingRoute(path: string, routes: readonly RouteMatrixEntry[]): RouteMatrixEntry | undefined {
  return routes
    .filter((route) => templatePattern(route.url).test(path))
    .sort((a, b) => compareSpecificity(a.url, b.url))[0];
}

/** Names of the named non-site parameters of a template, the positions {@link fillTemplate} fills from `values`. */
function freeParams(url: string): string[] {
  const names: string[] = [];
  for (const match of url.matchAll(PATH_TOKEN)) {
    const name = match[1];
    if (name !== undefined && !SITE_PARAMS.has(name.toLowerCase())) names.push(name);
  }
  return names;
}

/** Concrete path of a template: site params as tenant-a, other named params from `values` in order, `*` as `suffix`. */
function fillTemplate(url: string, values: readonly string[], suffix: string): string {
  let next = 0;
  return url.replace(PATH_TOKEN, (token: string, name: string | undefined) => {
    if (token === '::') return ':';
    if (name === undefined) return suffix;
    if (SITE_PARAMS.has(name.toLowerCase())) return TENANT_A.siteId;
    const value = values[next] as string;
    next += 1;
    return value;
  });
}

/** Every value tuple taking each position's default or a literal, all-default first. */
function valueTuples(defaults: readonly string[], literals: readonly string[]): string[][] {
  let tuples: string[][] = [[]];
  for (const fallback of defaults) {
    const choices = [fallback, ...literals];
    tuples = tuples.flatMap((tuple) => choices.map((choice) => [...tuple, choice]));
  }
  return tuples;
}

/** Literal path segments of `owner`'s target entries in `family`, the values a named parameter may stand for. */
function entryLiterals(entries: Iterable<CutoverVersionEntry>, owner: string, family: string): string[] {
  const prefix = `${family}:`;
  const literals = new Set<string>();
  for (const entry of entries) {
    const key = normaliseRouteKey(entry.route);
    if (entry.owningService !== owner || entry.state !== 'target' || !key.startsWith(prefix)) continue;
    for (const segment of key.slice(prefix.length).replace(/@[a-z]+$/, '').split('/')) {
      if (segment !== '' && segment !== '**' && !segment.startsWith('{')) literals.add(segment);
    }
  }
  return [...literals].sort();
}

/** Whether `route` is a glob entry, whose kind covers every method under its prefix. */
function isGlobRoute(route: string): boolean {
  return route.endsWith(GLOB_SUFFIX);
}

/** The gateway route or alias that answers `method path` before the edge catch-all, or undefined. */
function gatewayServer(context: ReachContext, method: string, path: string): string | undefined {
  if (path.startsWith(RELAY_ALIAS_PREFIX)) return `the relay alias ${RELAY_ALIAS_PREFIX}`;
  const own = servingRoute(
    path,
    context.gatewayRoutes.filter((route) => route.method === method),
  );
  return own === undefined ? undefined : `gateway route ${own.method} ${own.url}`;
}

/** Why the cut-over lookup of a path does not reach `owner`. */
function routingDetail({ result, entry }: Routing, owner: string): string {
  if (entry === undefined) return `key ${result.key} matches no entry, so legacy serves it`;
  const matched = `key ${result.key} matches ${entry.route}`;
  if (entry.owningService === GATEWAY_PACKAGE) return `${matched}, which the gateway answers with 404`;
  if (entry.state !== 'target') return `${matched}, ${entry.state} in this version`;
  return `${matched}, owned by ${entry.owningService} rather than ${owner}`;
}

/** The per-package `test:security` suite that covers routes the gateway cannot reach. */
function securitySuiteOf(pkg: string): string {
  const dir = ROUTED_PACKAGES.find((candidate) => candidate.name === pkg)?.dir ?? pkg;
  return `npm run test:security in ${dir}`;
}

function notProbed(pkg: string, route: RouteMatrixEntry, reason: NotProbedReason, detail: string): NotProbedRoute {
  return { package: pkg, method: route.method, url: route.url, reason, detail, coveredBy: securitySuiteOf(pkg) };
}

/** Reach of one non-edge route of `matrix`. */
function reachOf(context: ReachContext, matrix: LoadedMatrix, route: RouteMatrixEntry): ProbedRoute | NotProbedRoute {
  const pkg = matrix.package;
  const { method, url } = route;
  const given = pkg === GATEWAY_PACKAGE ? (context.inputs.gatewayParams ?? {}) : {};
  const defaults = freeParams(url).map((name) => (Object.hasOwn(given, name) ? (given[name] as string) : cfUuid()));
  const suffix = `opt2-authz-probe/${cfUuid()}`;
  const defaultPath = fillTemplate(url, defaults, suffix);
  if (pkg === GATEWAY_PACKAGE) {
    return { package: pkg, method, url, reach: 'gateway-own', paths: [{ path: defaultPath }] };
  }
  const server = gatewayServer(context, method, defaultPath);
  if (server !== undefined) {
    return notProbed(pkg, route, 'served-by-gateway', `${server} answers ${method} ${defaultPath}`);
  }

  const siblings = matrix.matrix.routes.filter((candidate) => candidate.method === method && candidate.edge !== true);
  const family = context.routing(method, defaultPath).result.family;
  const paths: GatewayPath[] = [];
  const reached = new Set<string>();
  for (const values of valueTuples(defaults, entryLiterals(context.entries.values(), pkg, family))) {
    const path = fillTemplate(url, values, suffix);
    if (servingRoute(path, siblings) !== route || gatewayServer(context, method, path) !== undefined) continue;
    const { result, entry } = context.routing(method, path);
    const owned = entry !== undefined && entry.owningService === pkg && entry.state === 'target';
    if (!owned || reached.has(entry.route)) continue;
    reached.add(entry.route);
    const signed = result.key.startsWith(SIGNED_FILE_KEY_PREFIX);
    paths.push({ path: signed ? context.inputs.sign(path) : path, entry: { route: entry.route, kind: entry.kind } });
  }
  if (paths.length > 0) return { package: pkg, method, url, reach: 'cut-over', paths };

  const owner = servingRoute(defaultPath, siblings);
  const detail =
    owner !== route && owner !== undefined
      ? `${defaultPath} is served by ${owner.method} ${owner.url}`
      : routingDetail(context.routing(method, defaultPath), pkg);
  return notProbed(pkg, route, 'no-target-entry', detail);
}

/** Classifies every non-edge route of `matrices` for `version`: probed with its edge paths, or not probed and why. */
export function gatewayReach(inputs: ReachInputs): ReachMap {
  const entries = new Map(inputs.version.entries.map((entry) => [normaliseRouteKey(entry.route), entry]));
  const matchKeys = [...entries.keys()];
  const gatewayMatrix = inputs.matrices.find((matrix) => matrix.package === GATEWAY_PACKAGE);
  const gatewayRoutes = gatewayMatrix?.matrix.routes.filter((route) => route.edge !== true) ?? [];
  const context: ReachContext = {
    inputs,
    entries,
    gatewayRoutes,
    routing(method, path) {
      const result = routeKeyForRequest({ method, path, query: {}, headers: {} }, { variants: inputs.variants });
      const route = matchRouteKey(result, matchKeys);
      return { result, entry: route === undefined ? undefined : entries.get(normaliseRouteKey(route)) };
    },
  };
  const probed: ProbedRoute[] = [];
  const notProbedRoutes: NotProbedRoute[] = [];
  for (const matrix of inputs.matrices) {
    for (const route of matrix.matrix.routes.filter((candidate) => candidate.edge !== true)) {
      const reach = reachOf(context, matrix, route);
      if ('paths' in reach) probed.push(reach);
      else notProbedRoutes.push(reach);
    }
  }
  return { tableVersion: inputs.version.tableVersion, probed, notProbed: notProbedRoutes };
}

/** Signer of local `/opt2/files/<bucket>/<key>` paths with `hmacKey`, valid until `expires` (epoch seconds). */
export function localFileSigner(hmacKey: Buffer, expires: number): (path: string) => string {
  return (path) => {
    const [bucket = '', ...key] = path.slice(LOCAL_SIGNED_URL_PREFIX.length).split('/');
    if (!path.startsWith(LOCAL_SIGNED_URL_PREFIX) || !isBucketName(bucket) || key.length === 0) {
      throw new Error(`${path} is not a local signed-file path`);
    }
    return signLocalUrl({ bucket, key: key.map(decodeURIComponent).join('/'), expires }, hmacKey);
  };
}

/** `<package> <METHOD> <url>` of a route. */
function routeLabel(route: Pick<ProbedRoute, 'package' | 'method' | 'url'>): string {
  return `${route.package} ${route.method} ${route.url}`;
}

/** Labels of the non-edge routes `reach` leaves out, lists more than once, or lists without a declaration. */
export function reachAccounting(
  matrices: readonly LoadedMatrix[],
  reach: Pick<ReachMap, 'probed' | 'notProbed'>,
): { missing: string[]; repeated: string[]; undeclared: string[] } {
  const counts = new Map<string, number>();
  for (const route of [...reach.probed, ...reach.notProbed]) {
    counts.set(routeLabel(route), (counts.get(routeLabel(route)) ?? 0) + 1);
  }
  const declared = matrices.flatMap((matrix) =>
    matrix.matrix.routes
      .filter((route) => route.edge !== true)
      .map((route) => routeLabel({ ...route, package: matrix.package })),
  );
  const declaredSet = new Set(declared);
  return {
    missing: declared.filter((label) => !counts.has(label)),
    repeated: [...counts].filter(([, count]) => count > 1).map(([label]) => label),
    undeclared: [...counts.keys()].filter((label) => !declaredSet.has(label)),
  };
}

/** Why an expected-allow cell is left unsent. */
export type SkipReason = 'session-ending' | 'not-read-only';

/** Why an expected-allow cell is left unsent on `path`, or undefined to send it; expected denies are always sent. */
export function skipReason(
  cell: Pick<Expectation, 'outcome' | 'method' | 'url'>,
  path: GatewayPath,
): SkipReason | undefined {
  if (cell.outcome === 'deny') return undefined;
  if (/logout/i.test(cell.url)) return 'session-ending';
  if (!READ_ONLY_METHODS.has(cell.method)) return 'not-read-only';
  const { entry } = path;
  // A glob entry's kind sums up every method under its prefix, so a read method on it is judged by the method alone.
  const sideEffect = entry !== undefined && SIDE_EFFECT_KINDS.has(entry.kind) && !isGlobRoute(entry.route);
  return sideEffect ? 'not-read-only' : undefined;
}

/** Whether an expected-allow cell proves reach: any subject on the gateway's own routes, else users or anonymous. */
export function isControl(
  cell: Pick<Expectation, 'outcome' | 'subject'>,
  reach: ReachKind,
  subjects: readonly RoleSubject[] = ROLE_SET,
): boolean {
  if (cell.outcome !== 'allow') return false;
  const kind = subjects.find((subject) => subject.name === cell.subject)?.kind;
  // The gateway strips a caller's invocation credential before an owner, so a service subject reaches only the gateway.
  return kind !== undefined && (reach === 'gateway-own' || kind !== 'service');
}

/** An observation through the gateway, with the edge path and `x-request-id` it was sent with and what decided its verdict. */
export interface ReachProbe extends Observation {
  path: string;
  entry?: string;
  requestId: string;
  observedStatus: number;
  detail: string;
}

/** An expected-allow cell left unsent, with its edge path and reason. */
export interface SkippedCell extends Pick<Expectation, 'package' | 'method' | 'url' | 'subject'> {
  path: string;
  reason: SkipReason;
}

/** Prefix of every probe's `x-request-id`. */
export const PROBE_REQUEST_ID_PREFIX = 'opt2-authz-';

/** A fresh probe `x-request-id`; service-kit adopts it as both the gateway's and the owner's request id. */
export function newProbeRequestId(): string {
  return `${PROBE_REQUEST_ID_PREFIX}${randomUUID()}`;
}

/** Message of the line service-kit logs for every answered request. */
export const REQUEST_COMPLETED_MESSAGE = 'request completed';

const requestRecordSchema = z.object({
  message: z.literal(REQUEST_COMPLETED_MESSAGE),
  requestId: z.string(),
  route: z.string(),
  httpMethod: z.string(),
  statusCode: z.number().int(),
});

/** A `request completed` line of package `source`; `route` is the matched route template, or the raw path when none matched. */
export interface RequestRecord {
  source: string;
  requestId: string;
  route: string;
  httpMethod: string;
  statusCode: number;
}

/** Request records by request id. */
export type RequestRecordIndex = ReadonlyMap<string, readonly RequestRecord[]>;

/** The request record a captured log line holds, or undefined for a non-JSON line or any other message. */
export function parseRequestRecord({ source, line }: CapturedLogLine): RequestRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = requestRecordSchema.safeParse(parsed);
  if (!record.success) return undefined;
  const { requestId, route, httpMethod, statusCode } = record.data;
  return { source, requestId, route, httpMethod, statusCode };
}

/** Indexes the request records among `lines` by request id. */
export function indexRequestRecords(lines: Iterable<CapturedLogLine>): RequestRecordIndex {
  const index = new Map<string, RequestRecord[]>();
  for (const line of lines) {
    const record = parseRequestRecord(line);
    if (record === undefined) continue;
    const known = index.get(record.requestId);
    if (known === undefined) index.set(record.requestId, [record]);
    else known.push(record);
  }
  return index;
}

type RouteRef = Pick<Observation, 'package' | 'method' | 'url'>;

/** The owner's record of `probe`: logged by `route`'s package under the probe's request id, at its template and method. */
export function ownerRecord(
  route: RouteRef,
  probe: Pick<ReachProbe, 'requestId'>,
  index: RequestRecordIndex,
): RequestRecord | undefined {
  return index
    .get(probe.requestId)
    ?.find((record) => record.source === route.package && record.route === route.url && record.httpMethod === route.method);
}

/** How a reachable route's owner reach was settled; `not-sent` routes are not claimed as gateway-probed. */
export type ReachState = 'proven-by-control' | 'proven-by-owner-denial' | 'not-sent' | 'failed';

/** Which probes a verdict was judged on: authorised controls, deny-expected probes, or none. */
export type ReachBasis = 'control' | 'deny' | 'none';

/** One judged probe: the gateway's status and the owner's logged status, null without an owner record. */
export interface ProbeEvidence {
  subject: string;
  path: string;
  requestId: string;
  observedStatus: number;
  ownerStatus: number | null;
}

/** Owner-reach verdict of one reachable route; `proving` counts the `judged` probes whose owner record proves reach. */
export interface ReachVerdict {
  package: string;
  method: string;
  url: string;
  reach: ReachKind;
  state: ReachState;
  sent: number;
  basis: ReachBasis;
  proving: number;
  judged: ProbeEvidence[];
  reason?: string;
  coveredBy?: string;
}

function isDenied(status: number): boolean {
  return status === 401 || status === 403;
}

/** Whether an owner status shows an authorised control handled by the owner's route: no denial and no 5xx. */
function provesControl(status: number): boolean {
  return !isDenied(status) && status < 500;
}

function sameRoute(a: RouteRef, b: RouteRef): boolean {
  return a.package === b.package && a.method === b.method && a.url === b.url;
}

/** Verdict of a route none of whose cells was observed: `not-sent` when every cell is an allow left unsent. */
function unsentVerdict(
  route: ProbedRoute,
  cells: readonly Expectation[],
  skipped: readonly SkippedCell[],
): ReachVerdict {
  const { package: pkg, method, url, reach } = route;
  const base = { package: pkg, method, url, reach, sent: 0, basis: 'none' as const, proving: 0, judged: [] };
  const unsent = skipped.filter((cell) => sameRoute(cell, route));
  const allUnsent =
    cells.length > 0 &&
    cells.every((cell) => cell.outcome === 'allow' && unsent.some((skip) => skip.subject === cell.subject));
  if (!allUnsent) return { ...base, state: 'failed', reason: 'no probe of this route was observed' };
  const reasons = [...new Set(unsent.map((cell) => cell.reason))].sort().join(', ');
  return {
    ...base,
    state: 'not-sent',
    reason: `every cell is an allow left unsent (${reasons})`,
    coveredBy: securitySuiteOf(pkg),
  };
}

/**
 * Owner-reach verdict of every reachable route: proven by a control its owner's route answered below 500 undenied,
 * else, when no control was sent, by a deny probe its owner's route refused with 401 or 403.
 */
export function reachVerdicts(
  probed: readonly ProbedRoute[],
  expected: readonly Expectation[],
  probes: readonly ReachProbe[],
  skipped: readonly SkippedCell[],
  index: RequestRecordIndex,
  subjects: readonly RoleSubject[] = ROLE_SET,
): ReachVerdict[] {
  return probed.map((route) => {
    const { package: pkg, method, url, reach } = route;
    const cells = expected.filter((cell) => sameRoute(cell, route));
    const sent = probes.filter((probe) => sameRoute(probe, route));
    if (sent.length === 0) return unsentVerdict(route, cells, skipped);
    const subjectsWhere = (keep: (cell: Expectation) => boolean): Set<string> =>
      new Set(cells.filter(keep).map((cell) => cell.subject));
    const controlSubjects = subjectsWhere((cell) => isControl(cell, reach, subjects));
    const denySubjects = subjectsWhere((cell) => cell.outcome === 'deny');
    const controls = sent.filter((probe) => controlSubjects.has(probe.subject));
    const denials = sent.filter((probe) => denySubjects.has(probe.subject));
    const basis: ReachBasis = controls.length > 0 ? 'control' : denials.length > 0 ? 'deny' : 'none';
    const judged = (basis === 'control' ? controls : denials).map(
      (probe): ProbeEvidence => ({
        subject: probe.subject,
        path: probe.path,
        requestId: probe.requestId,
        observedStatus: probe.observedStatus,
        ownerStatus: ownerRecord(route, probe, index)?.statusCode ?? null,
      }),
    );
    const proves = basis === 'control' ? provesControl : isDenied;
    const proving = judged.filter((probe) => probe.ownerStatus !== null && proves(probe.ownerStatus)).length;
    const base = { package: pkg, method, url, reach, sent: sent.length, basis, proving, judged };
    if (proving > 0) return { ...base, state: basis === 'control' ? 'proven-by-control' : 'proven-by-owner-denial' };
    const reason =
      basis === 'control'
        ? `no authorised control has an owner record of ${method} ${url} answered below 500 without a denial`
        : basis === 'deny'
          ? `no deny probe has an owner record of ${method} ${url} refused with 401 or 403`
          : 'neither an authorised control nor a deny cell was sent';
    return { ...base, state: 'failed', reason };
  });
}

/** Response facts the classifier reads; an `HttpResult` satisfies it. */
export interface GatewayResponse {
  status: number;
  url: string;
  text: string;
  headers: Record<string, string | string[]>;
}

/** Verdict on one response; a denial's `status` is the 401 or 403 its refusal shape stands for. */
export interface ResponseVerdict {
  verdict: 'denied' | 'allowed';
  status: number;
  detail: string;
}

/** The credential-refusal error row a Masa JSON envelope body carries, if any. */
function authErrorOf(text: string): LegacyErrorSpec | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return AUTH_ERRORS.find((spec) => error?.code === spec.code && error?.message === spec.message);
}

/** Whether `location` is legacy `backUp()`'s target without a Referer: `./`, or the admin root naming no action. */
function isBackUpTarget(location: string, base: string, action: ParsedAdminUrl | undefined): boolean {
  if (location === './') return true;
  return action === undefined && URL.canParse(location, base) && ADMIN_ROOT.test(new URL(location, base).pathname);
}

/** Whether a response refused the request, read from its status, envelope or admin redirect; 404 is never a denial. */
export function classifyResponse(result: GatewayResponse): ResponseVerdict {
  const { status } = result;
  const denied = (as: number, detail: string): ResponseVerdict => ({ verdict: 'denied', status: as, detail });
  if (isDenied(status)) return denied(status, `HTTP ${status}`);
  const authError = authErrorOf(result.text);
  if (authError !== undefined) {
    return denied(authError.status, `HTTP ${status} ${authError.code}: ${authError.message}`);
  }
  const location = result.headers.location;
  if (status >= 300 && status < 400 && typeof location === 'string') {
    const action = parseAdminUrl(location);
    const target = action === undefined ? undefined : `${action.circuit}.${action.action}`.toLowerCase();
    const gate = target === undefined ? undefined : GATE_ACTIONS.get(target);
    if (gate !== undefined) return denied(gate, `HTTP ${status} to ${target}`);
    if (isBackUpTarget(location, result.url, action)) return denied(403, `HTTP ${status} to the back-up target`);
    const path = URL.canParse(location, result.url) ? new URL(location, result.url).pathname : 'an unparsable location';
    return { verdict: 'allowed', status, detail: `HTTP ${status} to ${target ?? path}` };
  }
  const detail = status === 404 ? 'HTTP 404: no route or resource answered, which is not a denial' : `HTTP ${status}`;
  return { verdict: 'allowed', status, detail };
}
