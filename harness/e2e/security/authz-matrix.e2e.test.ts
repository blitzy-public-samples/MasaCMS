// Gateway authorisation matrix: every declared route of every routed package, probed through the gateway per subject.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_USER_TOKEN, Roles, UndeclaredRouteError } from '@opt2/platform/auth';
import {
  ADMIN_LOGIN_REDIRECT_ACTION,
  ADMIN_NOACCESS_ACTION,
  LEGACY_ERROR_MAP,
  cfUuid,
  parseAdminUrl,
  type LegacyErrorSpec,
  type ParsedAdminUrl,
} from '@opt2/platform/legacy-compat';
import { baseEnvSchema, createService, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { ROLE_SET, TENANT_A, testVerifier, writeTestSecrets, type RoleSubject } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HttpResult, HttpSession } from '../../src/lib/http.js';
import { stateDir } from '../../src/lib/paths.js';
import { stableStringify } from '../../src/lib/report.js';
import {
  ROUTED_PACKAGES,
  diffOutcomes,
  expectationsFor,
  loadMatrices,
  matrixDir,
  matrixExportCommand,
  matrixFile,
  type Expectation,
  type LoadedMatrix,
  type MatrixDiff,
  type Observation,
} from '../../src/security/authz-matrix.js';
import {
  gatewaySession,
  redactSecrets,
  sessionForSubject,
  untrustedAuthHeaders,
  type SubjectSession,
} from '../helpers/admin-login.js';
import { resetMailpit } from '../helpers/mailpit.js';
import { readStack, requireTableVersion } from '../helpers/stack.js';

const TABLE_VERSION = 'v0002';
const HOOK_TIMEOUT_MS = 45 * 60_000;
const MAX_IN_FLIGHT = 8;
const FINDINGS_SHOWN = 20;

const execFileAsync = promisify(execFile);

/** The ROLE_SET subject named `name`. */
function roleSubject(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new Error(`ROLE_SET has no subject named ${name}`);
  return subject;
}

const ANONYMOUS_SUBJECT = roleSubject('anonymous').name;
/** Label of the cookie-less probes that carry a test-key s2 token the running stack must not trust. */
const FORGED_SUBJECT = 'forged-token';
/** Callee the forged test-key credentials are addressed to. */
const FORGED_AUDIENCE = 'gateway';
const SUBJECT_ORDER: readonly string[] = [...ROLE_SET.map((subject) => subject.name), FORGED_SUBJECT];
const SUBJECT_RANK: ReadonlyMap<string, number> = new Map(SUBJECT_ORDER.map((name, index) => [name, index]));

/** Caller-asserted context the gateway strips at the edge, sent on every probe. */
const FORGED_CONTEXT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-OPT2-Tenant-Id': TENANT_A.tenantId,
  'X-OPT2-Site': TENANT_A.siteId,
  'X-OPT2-Roles': `${Roles.s2},${Roles.platformOperator}`,
});

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const SITE_PARAMS: ReadonlySet<string> = new Set(['siteid', 'site']);
/** A Fastify path token: an escaped colon, a named parameter with an optional regex, or a wildcard. */
const PATH_TOKEN = /::|:(\w+)(?:\([^)]*\))?|\*/g;
const ADMIN_ROOT = /^\/admin\/?$/i;

/** Error-map rows with which the JSON API refuses a request's credentials. */
const AUTH_ERRORS: readonly LegacyErrorSpec[] = [
  LEGACY_ERROR_MAP.authorization,
  LEGACY_ERROR_MAP.invalidAccessToken,
  LEGACY_ERROR_MAP.accessTokenExpired,
];

/** Lower-cased admin access-gate actions and the deny status each stands for. */
const GATE_ACTIONS: ReadonlyMap<string, number> = new Map([
  ['clogin.main', 401],
  [ADMIN_LOGIN_REDIRECT_ACTION.toLowerCase(), 401],
  [ADMIN_NOACCESS_ACTION.toLowerCase(), 403],
]);

/** Why an expected-allow cell is left unsent. */
type SkipReason = 'session-ending' | 'not-read-only';

/** An expectation left unsent, with its reason. */
interface SkippedCell extends Pick<Expectation, 'package' | 'method' | 'url' | 'subject'> {
  reason: SkipReason;
}

/** An observation with the raw response status and what decided its verdict. */
interface Probe extends Observation {
  observedStatus: number;
  detail: string;
}

/** Verdict on one response; a denial's `status` is the 401 or 403 its refusal shape stands for. */
interface Verdict {
  verdict: 'denied' | 'allowed';
  status: number;
  detail: string;
}

/** Session and credential headers one probe is sent with. */
interface ProbeClient {
  session: HttpSession;
  headers: Record<string, string>;
}

/** Concrete path of a route template: site params as tenant-a, other params as unknown CF UUIDs, `*` as a suffix. */
function fillPath(url: string): string {
  return url.replace(PATH_TOKEN, (token: string, name: string | undefined) => {
    if (token === '::') return ':';
    if (name === undefined) return `opt2-authz-probe/${cfUuid()}`;
    return SITE_PARAMS.has(name.toLowerCase()) ? TENANT_A.siteId : cfUuid();
  });
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

/** Whether a response refused the request, read from its status, its envelope or its admin redirect. */
function classify(result: HttpResult): Verdict {
  const { status } = result;
  const denied = (as: number, detail: string): Verdict => ({ verdict: 'denied', status: as, detail });
  if (status === 401 || status === 403) return denied(status, `HTTP ${status}`);
  // No route answers this caller; diffOutcomes counts only 401 and 403 as denies, so it is recorded as a 403.
  if (status === 404) return denied(403, 'HTTP 404');
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
  return { verdict: 'allowed', status, detail: `HTTP ${status}` };
}

/** Runs `task` on each item in order with at most `limit` in flight; the first failure stops dispatch and rejects. */
async function runPool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next] as T;
      next += 1;
      try {
        await task(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Why an expected-allow cell is left unsent, or undefined to send it; expected denies are always sent. */
function skipReason(expectation: Expectation): SkipReason | undefined {
  if (expectation.outcome === 'deny') return undefined;
  if (/logout/i.test(expectation.url)) return 'session-ending';
  return READ_ONLY_METHODS.has(expectation.method) ? undefined : 'not-read-only';
}

/** Cells to send, grouped by subject in SUBJECT_ORDER with each subject's denies first, and the cells left unsent. */
function sendPlan(expected: readonly Expectation[]): { send: Expectation[]; skipped: SkippedCell[] } {
  const send: Expectation[] = [];
  const skipped: SkippedCell[] = [];
  for (const expectation of expected) {
    const reason = skipReason(expectation);
    if (reason === undefined) {
      send.push(expectation);
    } else {
      const { package: pkg, method, url, subject } = expectation;
      skipped.push({ package: pkg, method, url, subject, reason });
    }
  }
  const rank = (cell: Expectation): number =>
    (SUBJECT_RANK.get(cell.subject) ?? SUBJECT_ORDER.length) * 2 + (cell.outcome === 'deny' ? 0 : 1);
  return { send: send.sort((a, b) => rank(a) - rank(b)), skipped };
}

/** Exports each routed package's matrix with `opt2-auth matrix`, one after another, then loads them all. */
async function exportMatrices(): Promise<LoadedMatrix[]> {
  const dir = matrixDir();
  await mkdir(dir, { recursive: true });
  const { processes } = readStack();
  for (const pkg of ROUTED_PACKAGES) {
    const { command, args, cwd } = matrixExportCommand(pkg, matrixFile(dir, pkg));
    // buildApp reads its configuration from the environment, so each export runs with the env up.sh started it with.
    const env = { ...process.env, ...processes[pkg.name]?.env };
    try {
      await execFileAsync(command, args, { cwd, env });
    } catch (err) {
      const { code, stderr } = err as { code?: unknown; stderr?: unknown };
      const output = typeof stderr === 'string' ? stderr : '';
      throw new Error(`opt2-auth matrix export of ${pkg.name} failed (exit ${String(code)}): ${redactSecrets(output)}`);
    }
  }
  return loadMatrices(dir);
}

/** Sends every cell through the gateway and returns its observations; a subject's session opens at its first cell. */
async function probeAll(cells: readonly Expectation[]): Promise<Probe[]> {
  const sessions = new Map<string, Promise<SubjectSession>>();
  const forgedAs = roleSubject(Roles.s2);
  const clientFor = async (subject: string): Promise<ProbeClient> => {
    if (subject === FORGED_SUBJECT) {
      const headers = await untrustedAuthHeaders(forgedAs, { site: TENANT_A.siteId, audience: FORGED_AUDIENCE });
      return { session: gatewaySession(), headers };
    }
    let opened = sessions.get(subject);
    if (opened === undefined) {
      opened = sessionForSubject(roleSubject(subject), { origin: 'gateway' });
      sessions.set(subject, opened);
    }
    const { session, invocationHeaders } = await opened;
    return { session, headers: invocationHeaders ?? {} };
  };
  const probes: Probe[] = [];
  await runPool(cells, MAX_IN_FLIGHT, async (cell) => {
    const { session, headers } = await clientFor(cell.subject);
    const result = await session.request({
      method: cell.method,
      path: fillPath(cell.url),
      headers: { ...FORGED_CONTEXT_HEADERS, ...headers },
      followRedirects: false,
    });
    const { status, detail } = classify(result);
    const { package: pkg, method, url, subject } = cell;
    probes.push({ package: pkg, method, url, subject, status, observedStatus: result.status, detail });
  });
  return probes;
}

/** Asserts that `result` holds no unexpected allow, listing the first findings and their total on failure. */
function expectNoUnexpectedAllows(result: MatrixDiff): void {
  const shown = result.unexpectedAllows
    .slice(0, FINDINGS_SHOWN)
    .map(({ observation: o }) => `${o.package} ${o.method} ${o.url} as ${o.subject}: HTTP ${o.status}`);
  const total = result.unexpectedAllows.length;
  expect(shown, `${total} unexpected allow(s); the first ${shown.length} are listed`).toEqual([]);
}

describe('gateway authorisation matrix', () => {
  let loaded: LoadedMatrix[];
  let diff: MatrixDiff;
  let forgedDiff: MatrixDiff;
  let probing = false;

  beforeAll(async () => {
    await requireTableVersion(TABLE_VERSION);
    loaded = await exportMatrices();
    const expected = loaded.flatMap((matrix) => expectationsFor(matrix, ROLE_SET));
    const forgedExpected = expected
      .filter((expectation) => expectation.subject === ANONYMOUS_SUBJECT)
      .map((expectation) => ({ ...expectation, subject: FORGED_SUBJECT }));
    const { send, skipped } = sendPlan([...expected, ...forgedExpected]);
    probing = true;
    const probes = await probeAll(send);
    const forged = (entry: { subject: string }): boolean => entry.subject === FORGED_SUBJECT;
    const role = (entry: { subject: string }): boolean => !forged(entry);
    // Only sent cells are judged, so `missing` names lost probes, never the skipped cells reported beside it.
    diff = diffOutcomes(send.filter(role), probes.filter(role));
    forgedDiff = diffOutcomes(send.filter(forged), probes.filter(forged));
    const securityDir = join(stateDir(), 'security');
    await mkdir(securityDir, { recursive: true });
    const report = {
      tableVersion: TABLE_VERSION,
      packages: loaded.map(({ package: name, file, matrix }) => ({ name, file, routes: matrix.routes.length })),
      subjects: SUBJECT_ORDER,
      sent: probes.length,
      skipped: { count: skipped.length, entries: skipped },
      diff,
      forgedDiff,
    };
    await writeFile(join(securityDir, 'gateway-matrix.json'), stableStringify(report), 'utf8');
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    // Probes of send-login and forgot-password routes may have sent mail.
    if (probing) await resetMailpit();
  });

  it('loads one route matrix per routed package', () => {
    expect(loaded.map((matrix) => matrix.package)).toEqual(ROUTED_PACKAGES.map((pkg) => pkg.name));
  });

  it('reports zero unexpected allows for every route and role subject', () => {
    expectNoUnexpectedAllows(diff);
  });

  it('denies forged user tokens wherever anonymous is denied', () => {
    expectNoUnexpectedAllows(forgedDiff);
  });
});

const PROBE_SERVICE = 'authz-undeclared-probe';
const PROBE_ROUTE = '/undeclared-probe';

describe('deny-by-default start-up', () => {
  let probeStateDir: string | undefined;
  let env: BaseEnv;

  beforeAll(async () => {
    probeStateDir = await mkdtemp(join(tmpdir(), 'opt2-authz-undeclared-'));
    // testVerifier() leaves the invocation verifier to the local defaults, which load these key files.
    await writeTestSecrets(probeStateDir);
    env = loadEnv(baseEnvSchema, {
      // Never listened on; loadEnv refuses port 0.
      PORT: '65535',
      OPT2_SERVICE_NAME: PROBE_SERVICE,
      OPT2_ENV: 'local',
      // Never fetched: testVerifier() supplies the user-token key set.
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
      OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
      OPT2_STATE_DIR: probeStateDir,
      OPT2_SERVICE_URLS: '{}',
      OPT2_TASKS_ADAPTER: 'local',
      OPT2_STORAGE_ADAPTER: 'local',
      TZ: 'UTC',
    });
  });

  afterAll(async () => {
    if (probeStateDir !== undefined) await rm(probeStateDir, { recursive: true, force: true });
  });

  /** The probe service, before its probe route is registered. */
  function probeService(): Promise<FastifyInstance> {
    return createService({ name: PROBE_SERVICE, version: '0.0.0', env, verifierOverride: testVerifier() });
  }

  /** Queues the probe route, carrying `config` when given, in a child plugin that loads on ready(). */
  function registerProbeRoute(app: FastifyInstance, config?: { opt2: { public: true } }): void {
    // Not awaited, nor returned from an async function: either would load the plugin, and throw, before ready().
    app.register(async (child) => {
      child.get(PROBE_ROUTE, config === undefined ? {} : { config }, async () => ({}));
    });
  }

  it('fails start-up for a route without config.opt2', async () => {
    const app = await probeService();
    registerProbeRoute(app);
    try {
      await expect(app.ready()).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      // A failed instance may rethrow its start-up error on close.
      await app.close().catch(() => undefined);
    }
  });

  it('starts when the same route declares config.opt2.public', async () => {
    const app = await probeService();
    registerProbeRoute(app, { opt2: { public: true } });
    try {
      await app.ready();
    } finally {
      await app.close();
    }
  });
});
