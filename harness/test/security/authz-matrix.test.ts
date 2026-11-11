// Unit suite of the authorisation-matrix builder: routed packages, export command, matrix loading, expectations and diff.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBSUB_INVOKER_ROLE,
  Roles,
  SYNTHETIC_ROLES,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  hasAnyRole,
  serviceRole,
  type RouteMatrix,
  type RouteMatrixEntry,
} from '@opt2/platform/auth';
import { ROLE_SET, SERVICE_CALLERS, type RoleSubject } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath } from '../../src/lib/paths.js';
import {
  MatrixError,
  ROUTED_PACKAGES,
  diffOutcomes,
  expectationsFor,
  loadMatrices,
  matrixDir,
  matrixExportCommand,
  matrixFile,
  routeMatrixFileSchema,
  type Expectation,
  type ExpectationReason,
  type LoadedMatrix,
  type Observation,
  type Outcome,
  type RoutedPackage,
} from '../../src/security/authz-matrix.js';

const SAMPLE_FILE = fileURLToPath(new URL('../fixtures/security/route-matrix.sample.json', import.meta.url));
const SAMPLE_TEXT = await readFile(SAMPLE_FILE, 'utf8');
const SAMPLE: RouteMatrix = routeMatrixFileSchema.parse(JSON.parse(SAMPLE_TEXT));

const HEALTH_URL = '/healthz';
const PUSH_URL = '/internal/v1/events/people.programs-sites.site.changed.v1';
const SWEEP_URL = '/internal/v1/outbox/sweep';
const CONTACT_URL = '/internal/v1/persons/:userId/contact';
const ARCHIVE_URL = '/legacy-fixtures/cfml/api.cfm/people/persons/:userId/archive';
const USERS_URL = '/v1/users';
const USERS_MODULE_ROLE = 'm:008';

const SERVICE_PACKAGE_NAMES = [
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
];

const REASONS = {
  public: true,
  role: true,
  anonymous: true,
  'missing-role': true,
  'other-tenant': true,
  'managed-transport': true,
} as const satisfies Record<ExpectationReason, true>;

/** The routed package called `name`. */
function packageNamed(name: string): RoutedPackage {
  const pkg = ROUTED_PACKAGES.find((candidate) => candidate.name === name);
  if (pkg === undefined) {
    throw new Error(`no routed package ${name}`);
  }
  return pkg;
}

const PEOPLE = packageNamed('people');

/** The sample route at `url`. */
function sampleRoute(url: string): RouteMatrixEntry {
  const route = SAMPLE.routes.find((candidate) => candidate.url === url);
  if (route === undefined) {
    throw new Error(`no sample route ${url}`);
  }
  return route;
}

/** `matrix` as the people package's loaded matrix. */
function peopleMatrix(matrix: RouteMatrix = SAMPLE): LoadedMatrix {
  return { package: PEOPLE.name, file: SAMPLE_FILE, matrix };
}

/** Expectations of `subjects` on the sample route at `url`. */
function expectationsAt(url: string, subjects: readonly RoleSubject[] = ROLE_SET): Expectation[] {
  return expectationsFor(peopleMatrix(), subjects).filter((expectation) => expectation.url === url);
}

/** Expectation of `subject` at `url` within `expectations`. */
function expectationOf(expectations: readonly Expectation[], url: string, subject: string): Expectation {
  const found = expectations.find((expectation) => expectation.url === url && expectation.subject === subject);
  if (found === undefined) {
    throw new Error(`no expectation for ${subject} at ${url}`);
  }
  return found;
}

/** Names of the subjects `expectations` allow. */
function allowedSubjects(expectations: readonly Expectation[]): Set<string> {
  return new Set(expectations.filter((expectation) => expectation.outcome === 'allow').map((e) => e.subject));
}

/** Outcome a subject gets on a route, derived from its declaration independently of the module. */
function expectedOutcome(route: RouteMatrixEntry, subject: RoleSubject): Outcome {
  const invoker = subject.kind === 'service' && hasAnyRole(subject.roles, [PUBSUB_INVOKER_ROLE, TASKS_INVOKER_ROLE]);
  if (route.transport !== 'service') {
    const invokerRole = route.transport === 'pubsub-push' ? PUBSUB_INVOKER_ROLE : TASKS_INVOKER_ROLE;
    const granted = subject.roles.includes(invokerRole) && hasAnyRole(subject.roles, route.requires ?? []);
    return invoker && granted ? 'allow' : 'deny';
  }
  if (subject.kind !== 'user') {
    return route.public === true || (!invoker && hasAnyRole(subject.roles, route.requires ?? [])) ? 'allow' : 'deny';
  }
  const roles = [...subject.roles, serviceRole('gateway')];
  const granted = route.public === true || hasAnyRole(roles, route.requires ?? []);
  const foreignSite = subject.crossTenant === true || subject.siteOverride !== undefined;
  return granted && !(foreignSite && route.siteCheck) ? 'allow' : 'deny';
}

/** Observation of `expectation`'s request answered with `status`. */
function observe(expectation: Expectation, status: number): Observation {
  const { package: pkg, method, url, subject } = expectation;
  return { package: pkg, method, url, subject, status };
}

/** Observations answering every expectation as expected: 200 for an allow, the expected status for a deny. */
function conformingObservations(expectations: readonly Expectation[]): Observation[] {
  return expectations.map((expectation) => observe(expectation, expectation.status ?? 200));
}

/** `observations` with `target`'s request answered with `status`. */
function answeredWith(observations: readonly Observation[], target: Expectation, status: number): Observation[] {
  return observations.map((observation) =>
    observation.url === target.url && observation.method === target.method && observation.subject === target.subject
      ? { ...observation, status }
      : observation,
  );
}

/** Rejection of `promise`, asserted to be a `MatrixError`. */
async function matrixErrorOf(promise: Promise<unknown>): Promise<MatrixError> {
  const err = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  expect(err).toBeInstanceOf(MatrixError);
  if (!(err instanceof MatrixError)) {
    throw new Error('expected a MatrixError');
  }
  return err;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opt2-authz-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ROUTED_PACKAGES', () => {
  it('lists the gateway, migration and the eleven services exactly once', () => {
    const dirs = ROUTED_PACKAGES.map((pkg) => pkg.dir);
    expect(ROUTED_PACKAGES).toHaveLength(13);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(new Set(dirs)).toEqual(
      new Set(['gateway', 'migration', ...SERVICE_PACKAGE_NAMES.map((name) => `services/${name}`)]),
    );
  });

  it('points the gateway and services at dist/app.js and migration at dist/server.js', () => {
    for (const pkg of ROUTED_PACKAGES) {
      expect(pkg.appModule, pkg.dir).toBe(pkg.dir === 'migration' ? 'dist/server.js' : 'dist/app.js');
    }
  });

  it('leaves out web, platform, harness and legacy-fixtures/seed', () => {
    const dirs = ROUTED_PACKAGES.map((pkg) => pkg.dir);
    for (const excluded of ['web', 'platform', 'harness', 'legacy-fixtures/seed']) {
      expect(dirs).not.toContain(excluded);
    }
  });

  it('gives every package its own matrix file', () => {
    const files = ROUTED_PACKAGES.map((pkg) => matrixFile(dir, pkg));
    expect(new Set(files).size).toBe(ROUTED_PACKAGES.length);
    expect(matrixFile(dir, PEOPLE)).toBe(join(dir, 'people.json'));
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ROUTED_PACKAGES)).toBe(true);
    expect(ROUTED_PACKAGES.every((pkg) => Object.isFrozen(pkg))).toBe(true);
  });
});

describe('matrixDir', () => {
  it('resolves to security/matrices under OPT2_STATE_DIR', () => {
    expect(matrixDir({ OPT2_STATE_DIR: dir })).toBe(join(dir, 'security', 'matrices'));
  });

  it('refuses a state directory inside the checkout', () => {
    expect(() => matrixDir({ OPT2_STATE_DIR: join(REPO_ROOT, 'state') })).toThrow(/OPT2_STATE_DIR must be outside/);
  });
});

describe('matrixExportCommand', () => {
  it('builds the opt2-auth matrix invocation for a package', () => {
    const outFile = matrixFile(dir, PEOPLE);
    const cwd = repoPath(PEOPLE.dir);
    expect(matrixExportCommand(PEOPLE, outFile)).toEqual({
      cwd,
      command: join(cwd, 'node_modules', '.bin', 'opt2-auth'),
      args: ['matrix', '--app', PEOPLE.appModule, '--export', 'buildApp', '--out', outFile],
    });
  });

  it.each(ROUTED_PACKAGES.map((pkg) => [pkg.dir, pkg] as const))(
    'exports buildApp from the compiled module of %s',
    (_dir, pkg) => {
      const outFile = matrixFile(dir, pkg);
      const { cwd, command, args } = matrixExportCommand(pkg, outFile);
      expect(cwd).toBe(repoPath(pkg.dir));
      expect(command).toBe(join(repoPath(pkg.dir), 'node_modules', '.bin', 'opt2-auth'));
      expect(args[0]).toBe('matrix');
      expect(args.slice(args.indexOf('--app'), args.indexOf('--app') + 2)).toEqual(['--app', pkg.appModule]);
      expect(args.slice(args.indexOf('--export'), args.indexOf('--export') + 2)).toEqual(['--export', 'buildApp']);
      expect(args.slice(args.indexOf('--out'), args.indexOf('--out') + 2)).toEqual(['--out', outFile]);
    },
  );
});

describe('routeMatrixFileSchema', () => {
  const valid = { method: 'GET', url: '/v1/users', transport: 'service', requires: [USERS_MODULE_ROLE], siteCheck: true };

  it('accepts the sample matrix', () => {
    expect(routeMatrixFileSchema.safeParse(JSON.parse(SAMPLE_TEXT)).success).toBe(true);
    expect(SAMPLE.routes).toHaveLength(6);
  });

  it.each([
    ['an entry without url', { method: 'GET', transport: 'service', requires: ['s2'], siteCheck: true }],
    ['an entry without transport', { method: 'GET', url: '/v1/users', requires: ['s2'], siteCheck: true }],
    ['an entry without siteCheck', { method: 'GET', url: '/v1/users', transport: 'service', requires: ['s2'] }],
    ['a lower-case method', { ...valid, method: 'get' }],
    ['a url without a leading slash', { ...valid, url: 'v1/users' }],
    ['an unknown transport', { ...valid, transport: 'smtp' }],
    ['an empty requires list', { ...valid, requires: [] }],
    ['public set to false', { ...valid, public: false }],
    ['edge set to false', { ...valid, edge: false }],
    ['an unknown entry field', { ...valid, owner: 'people' }],
  ])('rejects %s', (_case, entry) => {
    expect(routeMatrixFileSchema.safeParse({ routes: [entry] }).success).toBe(false);
  });

  it('rejects an unknown top-level field and a missing routes list', () => {
    expect(routeMatrixFileSchema.safeParse({ routes: [valid], package: 'people' }).success).toBe(false);
    expect(routeMatrixFileSchema.safeParse({}).success).toBe(false);
  });
});

describe('loadMatrices', () => {
  /** Writes `content` as `pkg`'s matrix file in `dir`; a non-string is serialized as JSON. */
  async function writeMatrix(pkg: RoutedPackage, content: unknown): Promise<string> {
    const file = matrixFile(dir, pkg);
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  }

  it('loads the sample as the people matrix', async () => {
    const file = matrixFile(dir, PEOPLE);
    await copyFile(SAMPLE_FILE, file);
    const loaded = await loadMatrices(dir, { packages: [PEOPLE] });
    expect(loaded).toEqual([{ package: 'people', file, matrix: SAMPLE }]);
    expect(loaded[0]?.matrix.routes).toHaveLength(6);
  });

  it('loads every routed package in package order by default', async () => {
    for (const pkg of ROUTED_PACKAGES) {
      await copyFile(SAMPLE_FILE, matrixFile(dir, pkg));
    }
    const loaded = await loadMatrices(dir);
    expect(loaded.map((matrix) => matrix.package)).toEqual(ROUTED_PACKAGES.map((pkg) => pkg.name));
    expect(loaded.map((matrix) => matrix.file)).toEqual(ROUTED_PACKAGES.map((pkg) => matrixFile(dir, pkg)));
  });

  it('ignores files that are not JSON', async () => {
    await copyFile(SAMPLE_FILE, matrixFile(dir, PEOPLE));
    await writeFile(join(dir, 'notes.txt'), 'exported by opt2-auth');
    await writeFile(join(dir, 'identity.json.bak'), '{}');
    await expect(loadMatrices(dir, { packages: [PEOPLE] })).resolves.toHaveLength(1);
  });

  it('returns nothing for an empty package list over an empty directory', async () => {
    await expect(loadMatrices(dir, { packages: [] })).resolves.toEqual([]);
  });

  it('reports the first missing package in package order for an empty directory', async () => {
    const err = await matrixErrorOf(loadMatrices(dir));
    expect(err.package).toBe('gateway');
    expect(err.message).toBe(
      `authorisation matrix of gateway: ${matrixFile(dir, packageNamed('gateway'))} is missing; export it with \`opt2-auth matrix\``,
    );
    expect(err.route).toBeUndefined();
  });

  it('reports a missing package even when a later one is present', async () => {
    await copyFile(SAMPLE_FILE, matrixFile(dir, PEOPLE));
    const err = await matrixErrorOf(loadMatrices(dir, { packages: [packageNamed('identity'), PEOPLE] }));
    expect(err.package).toBe('identity');
    expect(err.message).toContain('is missing');
  });

  it('reports a missing directory as the missing matrix of its first package', async () => {
    const err = await matrixErrorOf(loadMatrices(join(dir, 'absent'), { packages: [PEOPLE] }));
    expect(err.package).toBe('people');
    expect(err.message).toContain(`${join(dir, 'absent', 'people.json')} is missing`);
    expect(err.cause).toMatchObject({ code: 'ENOENT' });
  });

  it('propagates the directory read error for a missing directory when no package is expected', async () => {
    const rejection = await loadMatrices(join(dir, 'absent'), { packages: [] }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(rejection).not.toBeInstanceOf(MatrixError);
    expect(rejection).toMatchObject({ code: 'ENOENT' });
  });

  it('reports a matrix path that cannot be read as a file', async () => {
    await mkdir(matrixFile(dir, PEOPLE));
    const err = await matrixErrorOf(loadMatrices(dir, { packages: [PEOPLE] }));
    expect(err.message).toContain(`${matrixFile(dir, PEOPLE)} cannot be read: `);
    expect(err.cause).toMatchObject({ code: 'EISDIR' });
  });

  it('rejects content that is not JSON', async () => {
    const file = await writeMatrix(PEOPLE, '{"routes": [');
    const err = await matrixErrorOf(loadMatrices(dir, { packages: [PEOPLE] }));
    expect(err.package).toBe('people');
    expect(err.message).toContain(`${file} is not valid JSON: `);
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it('rejects a file that is not a route matrix', async () => {
    const file = await writeMatrix(PEOPLE, { routes: [{ method: 'GET' }] });
    const err = await matrixErrorOf(loadMatrices(dir, { packages: [PEOPLE] }));
    expect(err.message).toContain(`${file} is not a route matrix:\n`);
    expect(err.message).toContain('url');
    expect(err.route).toBeUndefined();
  });

  it.each([
    ['neither requires nor public', { method: 'GET', url: '/v1/notes', transport: 'service', siteCheck: true }],
    [
      'both requires and public',
      { method: 'GET', url: '/v1/notes', transport: 'service', requires: ['s2'], public: true, siteCheck: true },
    ],
    [
      'a managed path on the service transport',
      { method: 'POST', url: '/internal/v1/events/people.notes', transport: 'service', requires: ['s2'], siteCheck: true },
    ],
    [
      'a public managed route',
      { method: 'POST', url: '/internal/v1/tasks/notes', transport: 'cloud-tasks', public: true, siteCheck: true },
    ],
    [
      'an edge route that is not public',
      { method: 'GET', url: '/v1/notes', transport: 'service', requires: ['s2'], edge: true, siteCheck: true },
    ],
  ])('rejects a route the platform refuses at start-up: %s', async (_case, route) => {
    await writeMatrix(PEOPLE, { routes: [route] });
    const err = await matrixErrorOf(loadMatrices(dir, { packages: [PEOPLE] }));
    expect(err.package).toBe('people');
    expect(err.route).toBe(`${route.method} ${route.url}`);
    expect(err.message).toMatch(/\(refused at start-up\)$/);
    expect(err.cause).toBeInstanceOf(UndeclaredRouteError);
  });

  it('rejects the alphabetically first JSON file that belongs to no routed package', async () => {
    await copyFile(SAMPLE_FILE, matrixFile(dir, PEOPLE));
    await writeFile(join(dir, 'web.json'), '{"routes":[]}');
    await writeFile(join(dir, 'legacy.json'), '{"routes":[]}');
    const err = await matrixErrorOf(loadMatrices(dir, { packages: [PEOPLE] }));
    expect(err.package).toBe('legacy');
    expect(err.message).toBe(`authorisation matrix of legacy: ${join(dir, 'legacy.json')} belongs to no routed package`);
    expect(err.cause).toBeUndefined();
  });

  it('treats a package left out of the package list as foreign', async () => {
    await copyFile(SAMPLE_FILE, matrixFile(dir, PEOPLE));
    await copyFile(SAMPLE_FILE, matrixFile(dir, packageNamed('identity')));
    const err = await matrixErrorOf(loadMatrices(dir, { packages: [PEOPLE] }));
    expect(err.package).toBe('identity');
  });

  it('names itself MatrixError', async () => {
    const err = await matrixErrorOf(loadMatrices(dir, { packages: [PEOPLE] }));
    expect(err.name).toBe('MatrixError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('expectationsFor', () => {
  const userSubjects = ROLE_SET.filter((subject) => subject.kind === 'user');
  const userNames = userSubjects.map((subject) => subject.name);

  it('expects every subject on every route exactly once', () => {
    const expectations = expectationsFor(peopleMatrix());
    expect(expectations).toHaveLength(SAMPLE.routes.length * ROLE_SET.length);
    const keys = new Set(expectations.map((e) => `${e.method} ${e.url} ${e.subject}`));
    expect(keys.size).toBe(expectations.length);
  });

  it('covers anonymous, the user roles, other-tenant, each synthetic role and each service role', () => {
    const names = ROLE_SET.map((subject) => subject.name);
    const required = [
      'anonymous',
      Roles.member,
      Roles.systemUser,
      'editor',
      Roles.siteAdmin,
      Roles.s2,
      'other-tenant',
      ...SYNTHETIC_ROLES,
      ...SERVICE_CALLERS.map(serviceRole),
    ];
    expect(SYNTHETIC_ROLES).toHaveLength(10);
    expect(names).toEqual(expect.arrayContaining(required));
    expect(new Set(expectationsFor(peopleMatrix()).map((e) => e.subject))).toEqual(new Set(names));
  });

  it('sorts expectations by url, method and subject and tags them with package and transport', () => {
    const expectations = expectationsFor(peopleMatrix());
    const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const sorted = [...expectations].sort(
      (a, b) => compare(a.url, b.url) || compare(a.method, b.method) || compare(a.subject, b.subject),
    );
    expect(expectations).toEqual(sorted);
    for (const expectation of expectations) {
      expect(expectation.package).toBe('people');
      expect(expectation.transport).toBe(sampleRoute(expectation.url).transport);
    }
  });

  it('agrees with the independent verdict for every route and subject', () => {
    for (const route of SAMPLE.routes) {
      const expectations = expectationsAt(route.url);
      for (const subject of ROLE_SET) {
        expect(expectationOf(expectations, route.url, subject.name).outcome, `${subject.name} ${route.url}`).toBe(
          expectedOutcome(route, subject),
        );
      }
    }
  });

  it('allows every subject on the public /healthz except the other-tenant user the site check refuses', () => {
    const expectations = expectationsAt(HEALTH_URL);
    expect(expectationOf(expectations, HEALTH_URL, 'anonymous')).toMatchObject({ outcome: 'allow', reason: 'public' });
    for (const expectation of expectations) {
      expect(expectation, expectation.subject).toMatchObject(
        expectation.subject === 'other-tenant'
          ? { outcome: 'deny', status: 403, reason: 'other-tenant' }
          : { outcome: 'allow', reason: 'public' },
      );
      expect(expectation.outcome === 'allow').toBe(expectation.status === undefined);
    }
  });

  it('allows /v1/users exactly to the user subjects holding m:008', () => {
    const usersModuleUser: RoleSubject = { name: 'users-module', kind: 'user', roles: [Roles.systemUser, USERS_MODULE_ROLE] };
    const subjects = [...ROLE_SET, usersModuleUser];
    const route = sampleRoute(USERS_URL);
    const holders = subjects.filter(
      (subject) => subject.kind === 'user' && hasAnyRole(subject.roles, route.requires ?? []),
    );
    expect(allowedSubjects(expectationsAt(USERS_URL, subjects))).toEqual(new Set(holders.map((s) => s.name)));
    expect(expectationOf(expectationsAt(USERS_URL, subjects), USERS_URL, 'users-module')).toMatchObject({
      outcome: 'allow',
      reason: 'role',
    });
  });

  it('denies /v1/users with 403 to user tokens and 401 to bare service credentials', () => {
    const expectations = expectationsAt(USERS_URL);
    for (const name of userNames) {
      expect(expectationOf(expectations, USERS_URL, name), name).toMatchObject({
        outcome: 'deny',
        status: 403,
        reason: 'missing-role',
      });
    }
    expect(expectationOf(expectations, USERS_URL, serviceRole('identity'))).toMatchObject({
      outcome: 'deny',
      status: 401,
      reason: 'missing-role',
    });
    expect(expectationOf(expectations, USERS_URL, 'anonymous')).toMatchObject({
      outcome: 'deny',
      status: 401,
      reason: 'anonymous',
    });
  });

  it('allows the archive route to s2 and site-admin and denies anonymous, member, system-user and editor', () => {
    const expectations = expectationsAt(ARCHIVE_URL);
    for (const name of [Roles.s2, Roles.siteAdmin]) {
      expect(expectationOf(expectations, ARCHIVE_URL, name), name).toMatchObject({ outcome: 'allow', reason: 'role' });
    }
    for (const name of ['anonymous', Roles.member, Roles.systemUser, 'editor']) {
      expect(expectationOf(expectations, ARCHIVE_URL, name).outcome, name).toBe('deny');
    }
    expect(allowedSubjects(expectations)).toEqual(new Set([Roles.s2, Roles.siteAdmin]));
  });

  it.each([
    ['pubsub-push', PUSH_URL, PUBSUB_INVOKER_ROLE],
    ['cloud-tasks', SWEEP_URL, TASKS_INVOKER_ROLE],
  ])('denies user tokens on the %s transport and allows only its invoker', (transport, url, invokerRole) => {
    const expectations = expectationsAt(url);
    const invokers = ROLE_SET.filter((subject) => subject.kind === 'service' && subject.roles.includes(invokerRole));
    expect(invokers).toHaveLength(1);
    expect(allowedSubjects(expectations)).toEqual(new Set(invokers.map((subject) => subject.name)));
    for (const expectation of expectations) {
      expect(expectation.transport).toBe(transport);
      if (expectation.outcome === 'deny') {
        expect(expectation, expectation.subject).toMatchObject({ status: 401, reason: 'managed-transport' });
      } else {
        expect(expectation.reason).toBe('role');
      }
    }
    for (const name of ['anonymous', ...userNames]) {
      expect(expectationOf(expectations, url, name).outcome, name).toBe('deny');
    }
  });

  it('refuses the managed invokers on service-transport routes unless the route is public', () => {
    const expectations = expectationsFor(peopleMatrix());
    for (const caller of ['pubsub-invoker', 'tasks-invoker']) {
      for (const url of [CONTACT_URL, ARCHIVE_URL, USERS_URL]) {
        expect(expectationOf(expectations, url, serviceRole(caller)), `${caller} ${url}`).toMatchObject({
          outcome: 'deny',
          status: 401,
          reason: 'managed-transport',
        });
      }
      expect(expectationOf(expectations, HEALTH_URL, serviceRole(caller)).outcome).toBe('allow');
    }
  });

  it('allows the service:identity route only to the identity workload', () => {
    const expectations = expectationsAt(CONTACT_URL);
    expect(allowedSubjects(expectations)).toEqual(new Set([serviceRole('identity')]));
    for (const name of userNames) {
      expect(expectationOf(expectations, CONTACT_URL, name), name).toMatchObject({
        outcome: 'deny',
        status: 403,
        reason: 'missing-role',
      });
    }
    expect(expectationOf(expectations, CONTACT_URL, serviceRole('gateway'))).toMatchObject({
      outcome: 'deny',
      status: 403,
      reason: 'missing-role',
    });
  });

  it('denies other-tenant on every route even where its roles satisfy requires', () => {
    const expectations = expectationsFor(peopleMatrix());
    for (const route of SAMPLE.routes) {
      expect(expectationOf(expectations, route.url, 'other-tenant').outcome, route.url).toBe('deny');
    }
    for (const url of [HEALTH_URL, ARCHIVE_URL]) {
      expect(expectationOf(expectations, url, 'other-tenant'), url).toMatchObject({ status: 403, reason: 'other-tenant' });
    }
    expect(expectationOf(expectations, ARCHIVE_URL, Roles.siteAdmin).outcome).toBe('allow');
  });

  it('treats a user whose token names another site like the other-tenant user', () => {
    const siteOverride: RoleSubject = {
      name: 'site-override',
      kind: 'user',
      roles: [Roles.systemUser, Roles.siteAdmin],
      siteOverride: 'tenant-b',
    };
    expect(expectationOf(expectationsAt(ARCHIVE_URL, [siteOverride]), ARCHIVE_URL, 'site-override')).toMatchObject({
      outcome: 'deny',
      status: 403,
      reason: 'other-tenant',
    });
  });

  it('lets other-tenant through on routes whose handler performs the site check', () => {
    const matrix: RouteMatrix = { routes: [{ ...sampleRoute(ARCHIVE_URL), siteCheck: false }] };
    const expectations = expectationsFor(peopleMatrix(matrix));
    expect(expectationOf(expectations, ARCHIVE_URL, 'other-tenant')).toMatchObject({ outcome: 'allow', reason: 'role' });
  });

  it('skips edge routes', () => {
    const edge: RouteMatrixEntry = {
      method: 'GET',
      url: '/admin/',
      transport: 'service',
      public: true,
      edge: true,
      siteCheck: true,
    };
    const expectations = expectationsFor(peopleMatrix({ routes: [edge, sampleRoute(USERS_URL)] }));
    expect(new Set(expectations.map((e) => e.url))).toEqual(new Set([USERS_URL]));
    expect(expectations).toHaveLength(ROLE_SET.length);
  });

  it('expands only the subjects it is given', () => {
    const subjects = ROLE_SET.filter((subject) => subject.name === 'anonymous' || subject.name === Roles.s2);
    expect(subjects).toHaveLength(2);
    const expectations = expectationsFor(peopleMatrix(), subjects);
    expect(expectations).toHaveLength(SAMPLE.routes.length * 2);
    expect(new Set(expectations.map((e) => e.subject))).toEqual(new Set(['anonymous', Roles.s2]));
  });

  it('assigns every expectation reason the module declares', () => {
    const reasons = new Set(expectationsFor(peopleMatrix()).map((e) => e.reason));
    expect(reasons).toEqual(new Set(Object.keys(REASONS)));
  });

  it('sets a 401 or 403 status on every deny and none on an allow', () => {
    for (const expectation of expectationsFor(peopleMatrix())) {
      if (expectation.outcome === 'allow') {
        expect(expectation.status).toBeUndefined();
      } else {
        expect([401, 403]).toContain(expectation.status);
      }
    }
  });
});

describe('diffOutcomes', () => {
  const expectations = expectationsFor(peopleMatrix());
  const conforming = conformingObservations(expectations);
  const deniedMember = expectationOf(expectations, USERS_URL, Roles.member);
  const allowedAnonymous = expectationOf(expectations, HEALTH_URL, 'anonymous');

  it('passes when every observation matches its expectation', () => {
    expect(diffOutcomes(expectations, conforming)).toEqual({
      unexpectedAllows: [],
      unexpectedDenies: [],
      statusMismatches: [],
      missing: [],
      unmatched: [],
      pass: true,
    });
  });

  it('fails on one expected deny observed as allowed, naming its route and subject', () => {
    const diff = diffOutcomes(expectations, answeredWith(conforming, deniedMember, 200));
    expect(diff.pass).toBe(false);
    expect(diff.unexpectedAllows).toEqual([{ expectation: deniedMember, observation: observe(deniedMember, 200) }]);
    expect(diff.unexpectedAllows[0]?.observation).toMatchObject({ url: USERS_URL, subject: Roles.member });
    expect(diff.unexpectedDenies).toEqual([]);
  });

  it('passes but lists an expected allow observed as denied', () => {
    const diff = diffOutcomes(expectations, answeredWith(conforming, allowedAnonymous, 401));
    expect(diff.pass).toBe(true);
    expect(diff.unexpectedAllows).toEqual([]);
    expect(diff.unexpectedDenies).toEqual([
      { expectation: allowedAnonymous, observation: observe(allowedAnonymous, 401) },
    ]);
  });

  it('lists a deny answered with the other deny status as a status mismatch without failing', () => {
    const diff = diffOutcomes(expectations, answeredWith(conforming, deniedMember, 401));
    expect(diff.pass).toBe(true);
    expect(diff.statusMismatches).toEqual([{ expectation: deniedMember, observation: observe(deniedMember, 401) }]);
    expect(diff.unexpectedAllows).toEqual([]);
    expect(diff.unexpectedDenies).toEqual([]);
  });

  it.each([200, 204, 302, 400, 404, 409, 500, 503])('counts status %i as passing authorisation', (status) => {
    const diff = diffOutcomes(expectations, answeredWith(conforming, deniedMember, status));
    expect(diff.pass).toBe(false);
    expect(diff.unexpectedAllows).toHaveLength(1);
    expect(diffOutcomes(expectations, answeredWith(conforming, allowedAnonymous, status)).pass).toBe(true);
  });

  it('lists expectations without an observation as missing, in key order, without failing', () => {
    const observed = conforming.filter(
      (o) => !(o.url === HEALTH_URL && o.subject === 'anonymous') && !(o.url === USERS_URL && o.subject === Roles.member),
    );
    const diff = diffOutcomes(expectations, observed);
    expect(diff.pass).toBe(true);
    expect(diff.missing).toEqual([allowedAnonymous, deniedMember]);
  });

  it('fails on an allowed observation without an expectation and only records an unmatched deny', () => {
    const stray: Observation = { package: 'people', method: 'DELETE', url: USERS_URL, subject: Roles.member, status: 204 };
    const refused: Observation = { ...stray, method: 'PUT', status: 403 };
    const diff = diffOutcomes(expectations, [...conforming, refused, stray]);
    expect(diff.pass).toBe(false);
    expect(diff.unexpectedAllows).toEqual([{ observation: stray }]);
    expect(diff.unmatched).toEqual([stray, refused]);
    expect(diff.statusMismatches).toEqual([]);
  });

  it('matches observation methods case-insensitively', () => {
    const lowerCase = conforming.map((observation) => ({ ...observation, method: observation.method.toLowerCase() }));
    const diff = diffOutcomes(expectations, lowerCase);
    expect(diff.missing).toEqual([]);
    expect(diff.unmatched).toEqual([]);
    expect(diff.pass).toBe(true);
  });

  it.each([
    ['allow first', ['allow', 'deny'] as const],
    ['deny first', ['deny', 'allow'] as const],
  ])('lets a deny govern registrations sharing a method and url (%s)', (_order, outcomes) => {
    const shared = outcomes.map(
      (outcome): Expectation =>
        outcome === 'allow'
          ? { ...deniedMember, outcome: 'allow', status: undefined, reason: 'role' }
          : { ...deniedMember, outcome: 'deny', status: 403, reason: 'missing-role' },
    );
    const diff = diffOutcomes(shared, [observe(deniedMember, 200)]);
    expect(diff.pass).toBe(false);
    expect(diff.unexpectedAllows).toEqual([
      { expectation: shared.find((e) => e.outcome === 'deny'), observation: observe(deniedMember, 200) },
    ]);
    expect(diff.missing).toEqual([]);
  });

  it('sorts findings by package, method, url and subject', () => {
    const userDenies = ROLE_SET.filter((subject) => subject.kind === 'user').map((subject) =>
      expectationOf(expectations, USERS_URL, subject.name),
    );
    const observed = [...userDenies].reverse().map((expectation) => observe(expectation, 200));
    const diff = diffOutcomes(expectations, observed);
    const subjects = diff.unexpectedAllows.map((finding) => finding.observation.subject);
    expect(subjects).toEqual([...subjects].sort());
    expect(subjects).toHaveLength(userDenies.length);
    const missingKeys = diff.missing.map((e) => `${e.method}|${e.url}|${e.subject}`);
    expect(missingKeys).toEqual([...missingKeys].sort());
  });
});
