// Route × subject authorisation expectations from exported role matrices, and their diff against observed responses.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  PUBSUB_INVOKER_ROLE,
  TASKS_INVOKER_ROLE,
  TRANSPORTS,
  UndeclaredRouteError,
  hasAnyRole,
  isServiceRole,
  rolesForService,
  validateRouteConfig,
  type ManagedTransport,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { z } from '@opt2/platform/service-kit';
import { ROLE_SET, type RoleSubject } from '@opt2/platform/testing';
import { repoPath, stateDir, type EnvLike } from '../lib/paths.js';

/** A package whose Fastify routes carry `config.opt2` declarations. */
export interface RoutedPackage {
  name: string;
  /** Package folder, relative to the repository root. */
  dir: string;
  /** Compiled module exporting `buildApp`, relative to `dir`. */
  appModule: string;
}

function servicePackage(name: string): RoutedPackage {
  return Object.freeze({ name, dir: `services/${name}`, appModule: 'dist/app.js' });
}

/** Every package the matrix covers; web is a Next.js app with no auth-declared Fastify routes. */
export const ROUTED_PACKAGES: readonly RoutedPackage[] = Object.freeze([
  Object.freeze({ name: 'gateway', dir: 'gateway', appModule: 'dist/app.js' }),
  Object.freeze({ name: 'migration', dir: 'migration', appModule: 'dist/server.js' }),
  ...[
    'identity',
    'people',
    'programs-sites',
    'strategies-content',
    'communications',
    'reporting',
    'surveys',
    'timesheets',
    'finance',
    'e-signature',
    'stub',
  ].map(servicePackage),
]);

/** Directory the exported matrices are written to, `<state>/security/matrices`. */
export function matrixDir(env?: EnvLike): string {
  return join(stateDir(env), 'security', 'matrices');
}

/** Matrix file of `pkg` in `dir`. */
export function matrixFile(dir: string, pkg: RoutedPackage): string {
  return join(dir, `${pkg.name}.json`);
}

/** `opt2-auth matrix` invocation that writes `pkg`'s matrix to `outFile`; it runs nothing. */
export function matrixExportCommand(
  pkg: RoutedPackage,
  outFile: string,
): { cwd: string; command: string; args: string[] } {
  const cwd = repoPath(pkg.dir);
  return {
    cwd,
    command: join(cwd, 'node_modules', '.bin', 'opt2-auth'),
    args: ['matrix', '--app', pkg.appModule, '--export', 'buildApp', '--out', outFile],
  };
}

/** Shape of one `opt2-auth matrix` output file; unknown fields are rejected. */
export const routeMatrixFileSchema = z
  .object({
    routes: z.array(
      z
        .object({
          method: z.string().regex(/^[A-Z]+$/, 'must be an upper-case HTTP method'),
          url: z.string().startsWith('/'),
          transport: z.enum(TRANSPORTS),
          requires: z.array(z.string()).min(1).optional(),
          // The exporter writes these flags only when set, so `false` is rejected like any other foreign value.
          public: z.literal(true).optional(),
          edge: z.literal(true).optional(),
          invocationOptional: z.literal(true).optional(),
          siteCheck: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict() satisfies z.ZodType<RouteMatrix>;

/** A matrix file that is missing, unexpected, malformed, or declares a route the platform refuses at start-up. */
export class MatrixError extends Error {
  override name = 'MatrixError';
  readonly package: string;
  /** `<METHOD> <url>` of the offending route. */
  readonly route?: string;

  constructor(pkg: string, detail: string, opts: { route?: string; cause?: unknown } = {}) {
    super(`authorisation matrix of ${pkg}: ${detail}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.package = pkg;
    this.route = opts.route;
  }
}

/** One package's validated matrix and the file it was read from. */
export interface LoadedMatrix {
  package: string;
  file: string;
  matrix: RouteMatrix;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readMatrixText(pkg: string, file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    const detail = missing ? 'is missing; export it with `opt2-auth matrix`' : `cannot be read: ${messageOf(err)}`;
    throw new MatrixError(pkg, `${file} ${detail}`, { cause: err });
  }
}

function parseMatrix(pkg: string, file: string, text: string): RouteMatrix {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new MatrixError(pkg, `${file} is not valid JSON: ${messageOf(err)}`, { cause: err });
  }
  const parsed = routeMatrixFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new MatrixError(pkg, `${file} is not a route matrix:\n${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  for (const route of parsed.data.routes) {
    try {
      // The platform's own start-up validation, so a route it would refuse can never be expected allowed.
      validateRouteConfig(route.method, route.url, route);
    } catch (err) {
      if (err instanceof UndeclaredRouteError) {
        throw new MatrixError(pkg, `${err.message} (refused at start-up)`, {
          route: `${route.method} ${route.url}`,
          cause: err,
        });
      }
      throw err;
    }
  }
  return parsed.data;
}

/** Validated matrix of each package from `dir`, in package order; throws `MatrixError` on a missing or foreign file. */
export async function loadMatrices(
  dir: string,
  opts: { packages?: readonly RoutedPackage[] } = {},
): Promise<LoadedMatrix[]> {
  const packages = opts.packages ?? ROUTED_PACKAGES;
  const loaded: LoadedMatrix[] = [];
  // Sequential, so the first missing package in package order is the one reported.
  for (const pkg of packages) {
    const file = matrixFile(dir, pkg);
    loaded.push({ package: pkg.name, file, matrix: parseMatrix(pkg.name, file, await readMatrixText(pkg.name, file)) });
  }
  const expected = new Set(packages.map((pkg) => basename(matrixFile(dir, pkg))));
  const [foreign] = (await readdir(dir)).filter((name) => name.endsWith('.json') && !expected.has(name)).sort();
  if (foreign !== undefined) {
    throw new MatrixError(basename(foreign, '.json'), `${join(dir, foreign)} belongs to no routed package`);
  }
  return loaded;
}

/** Whether a subject's request passes authorisation on a route. */
export type Outcome = 'allow' | 'deny';

/** Rule that decided an expectation. */
export type ExpectationReason =
  | 'public'
  | 'role'
  | 'anonymous'
  | 'missing-role'
  | 'other-tenant'
  | 'managed-transport'
  | 'refused-credential'
  | 'edge-gate';

/** Expected authorisation outcome of one subject on one route; `status` is set only for a deny. */
export interface Expectation {
  package: string;
  method: string;
  url: string;
  transport: Transport;
  subject: string;
  outcome: Outcome;
  status?: 401 | 403;
  reason: ExpectationReason;
  /** Edge path the cell is sent to, where its route is probed at several and each path is judged on its own. */
  path?: string;
}

type Verdict = Pick<Expectation, 'outcome' | 'status' | 'reason'>;

interface SubjectView {
  name: string;
  kind: 'anonymous' | 'user' | 'service';
  /** Roles the subject's request carries. */
  roles: readonly string[];
  /** Whether the subject's token names another site than the one under test. */
  otherTenant: boolean;
  /** Managed transport whose invoker the subject is. */
  invokerOf?: ManagedTransport;
}

/** Invoker role each managed transport authenticates. */
const INVOKER_ROLES: Readonly<Record<ManagedTransport, string>> = Object.freeze({
  'pubsub-push': PUBSUB_INVOKER_ROLE,
  'cloud-tasks': TASKS_INVOKER_ROLE,
});

const MANAGED_TRANSPORTS = TRANSPORTS.filter((transport): transport is ManagedTransport => transport !== 'service');

// User requests the gateway forwards carry its invocation credential and that credential's roles.
const USER_REQUEST_CALLER = 'gateway';

/** Package whose own routes see a subject's own credentials; the gateway forwards to every other package's routes. */
const GATEWAY_PACKAGE = 'gateway';

/** The only reader of `RoleSubject` fields; user roles include the gateway's, which only forwarded requests carry. */
function subjectView(subject: RoleSubject): SubjectView {
  const isUser = subject.kind === 'user';
  return {
    name: subject.name,
    kind: subject.kind,
    roles: isUser ? [...new Set([...subject.roles, ...rolesForService(USER_REQUEST_CALLER)])] : subject.roles,
    otherTenant: isUser && (subject.crossTenant === true || subject.siteOverride !== undefined),
    invokerOf:
      subject.kind === 'service'
        ? MANAGED_TRANSPORTS.find((transport) => subject.roles.includes(INVOKER_ROLES[transport]))
        : undefined,
  };
}

const allow = (reason: ExpectationReason): Verdict => ({ outcome: 'allow', reason });
const deny = (status: 401 | 403, reason: ExpectationReason): Verdict => ({ outcome: 'deny', status, reason });

/** A Fastify path token: an escaped colon, or a named parameter with an optional regex. */
const PATH_PARAM = /::|:(\w+)(?:\([^)]*\))?/g;

/** Whether `url` has a route param the site check reads: one named `siteid`, ignoring case. */
function hasSiteIdParam(url: string): boolean {
  return [...url.matchAll(PATH_PARAM)].some((match) => match[1]?.toLowerCase() === 'siteid');
}

/** The onRequest role check of the auth hooks. */
function roleVerdict(route: RouteMatrixEntry, roles: readonly string[], hasUser: boolean): Verdict {
  if (route.public === true) {
    return allow('public');
  }
  const requires = route.requires ?? [];
  if (hasAnyRole(roles, requires)) {
    return allow('role');
  }
  // The hooks answer 401 rather than 403 when no user token is present and the route admits a user role.
  return deny(!hasUser && requires.some((role) => !isServiceRole(role)) ? 401 : 403, 'missing-role');
}

/** Verdict of one subject on one route; `forwarded` when the gateway's forward attaches its own invocation credential. */
function verdictFor(route: RouteMatrixEntry, view: SubjectView, forwarded: boolean): Verdict {
  if (route.transport !== 'service') {
    return view.invokerOf === route.transport ? roleVerdict(route, view.roles, false) : deny(401, 'managed-transport');
  }
  // A public route still needs an invocation credential, which the gateway's forward supplies, unless it declares invocationOptional.
  const passesWithoutOwnCredential = route.public === true && (forwarded || route.invocationOptional === true);
  // A user's browser session presents no credential of its own, so the gateway's own routes see it as anonymous.
  if (view.kind === 'anonymous' || (view.kind === 'user' && !forwarded)) {
    return passesWithoutOwnCredential ? allow('public') : deny(401, 'anonymous');
  }
  // The gateway's invocation verifier refuses a managed invoker's credential, which its forward replaces with its own.
  if (view.invokerOf !== undefined) {
    if (!forwarded) return deny(401, 'refused-credential');
    return passesWithoutOwnCredential ? allow('public') : deny(401, 'managed-transport');
  }
  const verdict = roleVerdict(route, view.roles, view.kind === 'user');
  // The preHandler site check follows the role check, public routes included, and refuses only a supplied `siteid`
  // other than the token's site; a path-only request supplies one exactly where the template has a `siteid` param.
  const siteRefused = view.otherTenant && route.siteCheck && hasSiteIdParam(route.url);
  return verdict.outcome === 'allow' && siteRefused ? deny(403, 'other-tenant') : verdict;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Expectation of every subject on every non-edge route of `matrix` for a path-only request through the gateway, sorted
 * by package, url, method and subject.
 */
export function expectationsFor(matrix: LoadedMatrix, subjects: readonly RoleSubject[] = ROLE_SET): Expectation[] {
  const views = subjects.map(subjectView);
  const forwarded = matrix.package !== GATEWAY_PACKAGE;
  // An edge route forwards to another route, whose owning package's matrix carries the outcome.
  return matrix.matrix.routes
    .filter((route) => route.edge !== true)
    .flatMap((route) =>
      views.map(
        (view): Expectation => ({
          package: matrix.package,
          method: route.method,
          url: route.url,
          transport: route.transport,
          subject: view.name,
          ...verdictFor(route, view, forwarded),
        }),
      ),
    )
    .sort(
      (a, b) =>
        compareText(a.package, b.package) ||
        compareText(a.url, b.url) ||
        compareText(a.method, b.method) ||
        compareText(a.subject, b.subject),
    );
}

/** `expectation` with `verdict` in place of its own. */
function withVerdict(expectation: Expectation, verdict: Verdict): Expectation {
  const { status: _status, ...rest } = expectation;
  return { ...rest, ...verdict };
}

/** Kind of each of `subjects`, by name. */
function kindsOf(subjects: readonly RoleSubject[]): ReadonlyMap<string, RoleSubject['kind']> {
  return new Map(subjects.map((subject) => [subject.name, subject.kind]));
}

/** Anonymous's expectations relabelled `name`; the gateway's own routes refuse the forged token with 401. */
export function forgedExpectations(
  expected: readonly Expectation[],
  name: string,
  subjects: readonly RoleSubject[] = ROLE_SET,
): Expectation[] {
  const kinds = kindsOf(subjects);
  return expected
    .filter((expectation) => kinds.get(expectation.subject) === 'anonymous')
    .map((expectation) => {
      const forged = { ...expectation, subject: name };
      return forged.package === GATEWAY_PACKAGE ? withVerdict(forged, deny(401, 'refused-credential')) : forged;
    });
}

/** A gate the route declarations do not state: on its routes it denies every subject outside `admits`. */
export interface EdgeGate {
  package: string;
  /** `<METHOD> <url>` of each gated route. */
  routes: readonly string[];
  /** Names of the subjects the gate lets through to the declared verdict. */
  admits: readonly string[];
  because: string;
}

/**
 * `expected` with each gated route narrowed by its gate: a declared allow of a subject it does not admit becomes a deny,
 * 403 for a user and 401 otherwise, and every other cell keeps its declared verdict; throws `MatrixError` when a gate
 * names a route no expectation carries.
 */
export function withEdgeGates(
  expected: readonly Expectation[],
  gates: readonly EdgeGate[],
  subjects: readonly RoleSubject[] = ROLE_SET,
): Expectation[] {
  const routeOf = ({ package: pkg, method, url }: Expectation): string => `${pkg} ${method} ${url}`;
  const carried = new Set(expected.map(routeOf));
  const gateOf = new Map<string, EdgeGate>();
  for (const gate of gates) {
    for (const route of gate.routes) {
      if (!carried.has(`${gate.package} ${route}`)) {
        throw new MatrixError(gate.package, `edge gate names ${route}, which no expectation carries`, { route });
      }
      gateOf.set(`${gate.package} ${route}`, gate);
    }
  }
  const kinds = kindsOf(subjects);
  return expected.map((expectation) => {
    const gate = gateOf.get(routeOf(expectation));
    if (gate === undefined || expectation.outcome === 'deny' || gate.admits.includes(expectation.subject)) {
      return expectation;
    }
    return withVerdict(expectation, deny(kinds.get(expectation.subject) === 'user' ? 403 : 401, 'edge-gate'));
  });
}

/** Status one subject's request received on one route; `url` is the matrix route template. */
export interface Observation {
  package: string;
  method: string;
  url: string;
  subject: string;
  status: number;
  /** Edge path the request was sent to; it is matched to the expectation sent to the same path. */
  path?: string;
}

/** An observation that contradicts its expectation, or has none. */
export interface MatrixFinding {
  expectation?: Expectation;
  observation: Observation;
}

/** Comparison of expected and observed outcomes; `pass` is false on any finding but an unmatched deny. */
export interface MatrixDiff {
  unexpectedAllows: MatrixFinding[];
  unexpectedDenies: MatrixFinding[];
  statusMismatches: MatrixFinding[];
  missing: Expectation[];
  unmatched: Observation[];
  pass: boolean;
}

/** Route, subject and, where set, edge path of one cell. */
type CellRef = Pick<Observation, 'package' | 'method' | 'url' | 'subject' | 'path'>;

function routeSubjectKey(entry: CellRef): string {
  return `${entry.package}|${entry.method.toUpperCase()}|${entry.url}|${entry.subject}`;
}

/** Key of one cell; a cell carrying an edge path is keyed apart from its route's other paths. */
function outcomeKey(entry: CellRef): string {
  return entry.path === undefined ? routeSubjectKey(entry) : `${routeSubjectKey(entry)}|${entry.path}`;
}

/** Orders cells by package, method, url and subject, then by edge path. */
function cellOrder(a: CellRef, b: CellRef): number {
  return compareText(routeSubjectKey(a), routeSubjectKey(b)) || compareText(a.path ?? '', b.path ?? '');
}

/**
 * Judges each observation against the expectation of its cell, its edge path included where the cell carries one; 401
 * and 403 are denies, any other status passed authorisation.
 */
export function diffOutcomes(expected: readonly Expectation[], observed: readonly Observation[]): MatrixDiff {
  const governing = new Map<string, Expectation>();
  for (const expectation of expected) {
    const key = outcomeKey(expectation);
    const current = governing.get(key);
    // Registrations sharing a method and url share a key; a deny among them governs, so an allow is still flagged.
    if (current === undefined || (current.outcome === 'allow' && expectation.outcome === 'deny')) {
      governing.set(key, expectation);
    }
  }
  const unexpectedAllows: MatrixFinding[] = [];
  const unexpectedDenies: MatrixFinding[] = [];
  const statusMismatches: MatrixFinding[] = [];
  const unmatched: Observation[] = [];
  const seen = new Set<string>();
  for (const observation of observed) {
    const key = outcomeKey(observation);
    seen.add(key);
    const expectation = governing.get(key);
    const denied = observation.status === 401 || observation.status === 403;
    if (expectation === undefined) {
      unmatched.push(observation);
      if (!denied) {
        unexpectedAllows.push({ observation });
      }
    } else if (expectation.outcome === 'deny' && !denied) {
      unexpectedAllows.push({ expectation, observation });
    } else if (expectation.outcome === 'allow' && denied) {
      unexpectedDenies.push({ expectation, observation });
    } else if (expectation.outcome === 'deny' && observation.status !== expectation.status) {
      statusMismatches.push({ expectation, observation });
    }
  }
  const findingOrder = (a: MatrixFinding, b: MatrixFinding): number => cellOrder(a.observation, b.observation);
  const missing = expected.filter((expectation) => !seen.has(outcomeKey(expectation))).sort(cellOrder);
  return {
    unexpectedAllows: unexpectedAllows.sort(findingOrder),
    unexpectedDenies: unexpectedDenies.sort(findingOrder),
    statusMismatches: statusMismatches.sort(findingOrder),
    missing,
    unmatched: unmatched.sort(cellOrder),
    pass: [unexpectedAllows, unexpectedDenies, statusMismatches, missing].every((list) => list.length === 0),
  };
}
