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
export type ExpectationReason = 'public' | 'role' | 'anonymous' | 'missing-role' | 'other-tenant' | 'managed-transport';

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

// User requests arrive through the gateway, so they also carry its invocation credential and that credential's roles.
const USER_REQUEST_CALLER = 'gateway';

/** The only reader of `RoleSubject` fields. */
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

function verdictFor(route: RouteMatrixEntry, view: SubjectView): Verdict {
  if (route.transport !== 'service') {
    return view.invokerOf === route.transport ? roleVerdict(route, view.roles, false) : deny(401, 'managed-transport');
  }
  if (view.kind === 'anonymous') {
    return route.public === true ? allow('public') : deny(401, 'anonymous');
  }
  // Managed invokers present no invocation credential here, and the invocation verifier refuses theirs.
  if (view.invokerOf !== undefined) {
    return route.public === true ? allow('public') : deny(401, 'managed-transport');
  }
  const verdict = roleVerdict(route, view.roles, view.kind === 'user');
  // The site check runs in preHandler, after the role check, and also on public routes once a user token is verified.
  return verdict.outcome === 'allow' && view.otherTenant && route.siteCheck ? deny(403, 'other-tenant') : verdict;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Expectation of every subject on every non-edge route of `matrix`, sorted by package, url, method and subject. */
export function expectationsFor(matrix: LoadedMatrix, subjects: readonly RoleSubject[] = ROLE_SET): Expectation[] {
  const views = subjects.map(subjectView);
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
          ...verdictFor(route, view),
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

/** Status one subject's request received on one route; `url` is the matrix route template. */
export interface Observation {
  package: string;
  method: string;
  url: string;
  subject: string;
  status: number;
}

/** An observation that contradicts its expectation, or has none. */
export interface MatrixFinding {
  expectation?: Expectation;
  observation: Observation;
}

/** Comparison of expected and observed outcomes; `pass` is false on an unexpected allow or unobserved expectation. */
export interface MatrixDiff {
  unexpectedAllows: MatrixFinding[];
  unexpectedDenies: MatrixFinding[];
  statusMismatches: MatrixFinding[];
  missing: Expectation[];
  unmatched: Observation[];
  pass: boolean;
}

function outcomeKey(entry: Pick<Observation, 'package' | 'method' | 'url' | 'subject'>): string {
  return `${entry.package}|${entry.method.toUpperCase()}|${entry.url}|${entry.subject}`;
}

function byKey<T>(keyOf: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => compareText(keyOf(a), keyOf(b));
}

/** Judges each observation against its expectation; 401 and 403 are denies, any other status passed authorisation. */
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
  const findingOrder = byKey((finding: MatrixFinding) => outcomeKey(finding.observation));
  const missing = expected.filter((expectation) => !seen.has(outcomeKey(expectation))).sort(byKey(outcomeKey));
  return {
    unexpectedAllows: unexpectedAllows.sort(findingOrder),
    unexpectedDenies: unexpectedDenies.sort(findingOrder),
    statusMismatches: statusMismatches.sort(findingOrder),
    missing,
    unmatched: unmatched.sort(byKey(outcomeKey)),
    pass: unexpectedAllows.length === 0 && missing.length === 0,
  };
}
