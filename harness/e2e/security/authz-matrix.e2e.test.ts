// Gateway authorisation matrix: every declared route the gateway reaches, probed at its edge paths per subject.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LOCAL_USER_TOKEN, Roles, UndeclaredRouteError } from '@opt2/platform/auth';
import {
  REQUEST_ID_HEADER,
  baseEnvSchema,
  createService,
  loadEnv,
  type BaseEnv,
  type FastifyInstance,
} from '@opt2/platform/service-kit';
import {
  BUCKETS,
  createLocalStorageAdapter,
  loadStorageHmacKey,
  objectKey,
  type BucketName,
  type LocalStorageAdapter,
} from '@opt2/platform/storage';
import { ROLE_SET, TENANT_A, testVerifier, writeTestSecrets, type RoleSubject } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { capturedLogOffsets, readCapturedLogLines } from '../../src/events/traces.js';
import { defaultRunner } from '../../src/lib/git.js';
import { loadInventoryVariants } from '../../src/inventory/route-keys.js';
import type { HttpSession } from '../../src/lib/http.js';
import { stateDir } from '../../src/lib/paths.js';
import { stableStringify } from '../../src/lib/report.js';
import {
  ROUTED_PACKAGES,
  diffOutcomes,
  expectationsFor,
  forgedExpectations,
  loadMatrices,
  matrixDir,
  matrixExportCommand,
  matrixFile,
  withEdgeGates,
  type EdgeGate,
  type Expectation,
  type LoadedMatrix,
  type MatrixDiff,
  type MatrixFinding,
  type Observation,
} from '../../src/security/authz-matrix.js';
import {
  classifyResponse,
  gatewayReach,
  indexRequestRecords,
  loadCutoverVersion,
  localFileSigner,
  newProbeRequestId,
  probedSignedBuckets,
  reachAccounting,
  reachVerdicts,
  skipReason,
  type GatewayPath,
  type ProbedRoute,
  type ReachMap,
  type ReachProbe,
  type ReachState,
  type ReachVerdict,
  type RequestRecordIndex,
  type SkippedCell,
} from '../../src/security/gateway-reach.js';
import {
  gatewaySession,
  redactSecrets,
  sessionForSubject,
  untrustedAuthHeaders,
  type SubjectSession,
} from '../helpers/admin-login.js';
import { resetMailpit } from '../helpers/mailpit.js';
import {
  readStack,
  requireTableVersion,
  restartService,
  withRestoredServices,
  type ServiceName,
} from '../helpers/stack.js';

const TABLE_VERSION = 'v0002';
const HOOK_TIMEOUT_MS = 45 * 60_000;
const MAX_IN_FLIGHT = 8;
const FINDINGS_SHOWN = 20;

/** Longest run of one package's `opt2-auth matrix` export; a fraction of the hook bound, which spans every export and the probes. */
const MATRIX_EXPORT_TIMEOUT_MS = 5 * 60_000;

/** The ROLE_SET subject named `name`. */
function roleSubject(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new Error(`ROLE_SET has no subject named ${name}`);
  return subject;
}

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

/** Lifetime of a signed-file probe URL, in seconds: each is signed by the request that sends it. */
const SIGNED_PROBE_TTL_S = 5 * 60;

/** Bytes and content type of the objects the signed-file probes download. */
const PROBE_OBJECT_BODY = Buffer.from('opt2 authz probe\n', 'utf8');
const PROBE_OBJECT_TYPE = 'text/plain';

/** One bucket's probe object: its key, and the `:tenantId/:objectName` values the owners' signed-file routes read. */
interface ProbeObject {
  bucket: BucketName;
  key: string;
  params: { tenantId: string; objectName: string };
}

/** A fresh tenant-a object of each bucket, keyed as the owners store objects: `<RFC 4122 tenant id>/<CF UUID>.txt`. */
function probeObjects(): ProbeObject[] {
  const tenantId = TENANT_A.tenantId;
  return BUCKETS.map((bucket) => {
    const key = objectKey({ tenantId, ext: 'txt' });
    return { bucket, key, params: { tenantId, objectName: key.slice(tenantId.length + 1) } };
  });
}

const SURVEYS_API = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const SIGNATURE_API = '/legacy-fixtures/cfml/api.cfm/esignature/requests';
const FIXTURE_GATE = 'the fixture handler requires a login (else 401) holding an admitted role group (else 403)';

/** Gates that admit fewer subjects than their routes declare; each turns a declared allow of any other subject into a deny. */
const EDGE_GATES: readonly EdgeGate[] = [
  {
    package: 'stub',
    routes: ['', '/:noteId', '/:noteId/projection'].map((tail) => `GET /opt2/stub/notes${tail}`),
    admits: [Roles.s2, 'editor'],
    because: "a path-only probe names no site, so its token is the default site's, where only s2 and editor hold roles",
  },
  {
    package: 'surveys',
    routes: ['', '/:id', '/:id/responses', '/:id/tasks'].map((tail) => `GET ${SURVEYS_API}${tail}`),
    admits: [Roles.surveysManager],
    because: FIXTURE_GATE,
  },
  { package: 'e-signature', routes: [`GET ${SIGNATURE_API}`], admits: [Roles.esignatureSigner], because: FIXTURE_GATE },
  {
    package: 'e-signature',
    routes: [`GET ${SIGNATURE_API}/:id/audit`, `GET ${SIGNATURE_API}/:id/verify`],
    admits: [Roles.esignatureSigner, Roles.esignatureAuditor],
    because: FIXTURE_GATE,
  },
];

/** Relay target filled into the gateway's `:service`: an unknown one is answered by the not-found handler, whose log names no relay route. */
const RELAY_PROBE_SERVICE = 'identity';

/** Longest wait for the owners' request records of the probes, which their processes write after answering. */
const EVIDENCE_WAIT_MS = 30_000;
const EVIDENCE_POLL_MS = 1_000;
const REACH_STATES: readonly ReachState[] = ['proven-by-control', 'proven-by-owner-denial', 'not-sent', 'failed'];

/** Owners of probed routes that log answers below 400 at debug, so they run at LOG_LEVEL=debug while probed. */
const DEBUG_SUCCESS_OWNERS: readonly ServiceName[] = ['gateway'];

/** Session and credential headers one probe is sent with. */
interface ProbeClient {
  session: HttpSession;
  headers: Record<string, string>;
}

/** One expectation sent to one edge path of its route. */
interface ProbeCell {
  expectation: Expectation;
  path: GatewayPath;
}

/** Identity of a route across matrix cells and reach entries. */
function routeKey(route: Pick<Expectation, 'package' | 'method' | 'url'>): string {
  return `${route.package}|${route.method}|${route.url}`;
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

/** Cells to send, one per expectation and edge path of a probed route, by subject in SUBJECT_ORDER, denies first. */
function sendPlan(
  expected: readonly Expectation[],
  probed: readonly ProbedRoute[],
): { send: ProbeCell[]; skipped: SkippedCell[] } {
  const pathsOf = new Map(probed.map((route) => [routeKey(route), route.paths]));
  const send: ProbeCell[] = [];
  const skipped: SkippedCell[] = [];
  for (const expectation of expected) {
    for (const path of pathsOf.get(routeKey(expectation)) ?? []) {
      const reason = skipReason(expectation, path);
      if (reason === undefined) {
        send.push({ expectation, path });
      } else {
        const { package: pkg, method, url, subject } = expectation;
        skipped.push({ package: pkg, method, url, subject, path: path.path, reason });
      }
    }
  }
  const rank = ({ expectation: cell }: ProbeCell): number =>
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
      await defaultRunner(command, args, { cwd, env, timeoutMs: MATRIX_EXPORT_TIMEOUT_MS });
    } catch (err) {
      const { code, stderr } = err as { code?: unknown; stderr?: unknown };
      if (code === 'ETIMEDOUT') {
        throw new Error(`opt2-auth matrix export of ${pkg.name} timed out after ${MATRIX_EXPORT_TIMEOUT_MS} ms`);
      }
      const output = typeof stderr === 'string' ? stderr : '';
      throw new Error(`opt2-auth matrix export of ${pkg.name} failed (exit ${String(code)}): ${redactSecrets(output)}`);
    }
  }
  return loadMatrices(dir);
}

/**
 * Sends every cell to its edge path under a fresh `x-request-id` and returns its observations; a subject's session
 * opens at its first cell. Only the request signs a signed-file path, with `hmacKey`, so observations stay unsigned.
 */
async function probeAll(cells: readonly ProbeCell[], hmacKey: Buffer): Promise<ReachProbe[]> {
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
  const probes: ReachProbe[] = [];
  await runPool(cells, MAX_IN_FLIGHT, async ({ expectation, path }) => {
    const { session, headers } = await clientFor(expectation.subject);
    const requestId = newProbeRequestId();
    const expires = Math.floor(Date.now() / 1000) + SIGNED_PROBE_TTL_S;
    const result = await session.request({
      method: expectation.method,
      path: path.signed === true ? localFileSigner(hmacKey, expires)(path.path) : path.path,
      headers: { ...FORGED_CONTEXT_HEADERS, ...headers, [REQUEST_ID_HEADER]: requestId },
      followRedirects: false,
    });
    const { status, detail } = classifyResponse(result);
    const { package: pkg, method, url, subject } = expectation;
    const sentTo = { path: path.path, ...(path.entry === undefined ? {} : { entry: path.entry.route }) };
    probes.push({ package: pkg, method, url, subject, status, observedStatus: result.status, detail, requestId, ...sentTo });
  });
  return probes;
}

/** Verdicts over the owners' log lines written since `fromOffsets`, re-read until no route fails or EVIDENCE_WAIT_MS passes. */
async function awaitVerdicts(
  judge: (index: RequestRecordIndex) => ReachVerdict[],
  packages: readonly string[],
  fromOffsets: Readonly<Record<string, number>>,
): Promise<ReachVerdict[]> {
  // Owners log after answering, so the evidence is re-read briefly.
  const deadline = Date.now() + EVIDENCE_WAIT_MS;
  for (;;) {
    const verdicts = judge(indexRequestRecords(readCapturedLogLines({ packages, fromOffsets })));
    if (!verdicts.some((verdict) => verdict.state === 'failed') || Date.now() >= deadline) return verdicts;
    await sleep(EVIDENCE_POLL_MS);
  }
}

/** `<package> <METHOD> <url>` of a cell, the unsigned edge path an observation was sent to, and its subject. */
function cellLabel(cell: Observation | Expectation): string {
  const sentTo = 'path' in cell ? ` at ${String(cell.path)}` : '';
  return `${cell.package} ${cell.method} ${cell.url}${sentTo} as ${cell.subject}`;
}

/** Asserts that `result` holds no finding, listing the first FINDINGS_SHOWN of each kind and every total on failure. */
function expectNoFindings(result: MatrixDiff): void {
  const judged = ({ expectation: e, observation: o }: MatrixFinding): string => {
    const wanted = e === undefined ? 'no cell' : `${[e.outcome, e.status].filter(Boolean).join(' ')} (${e.reason})`;
    return `${cellLabel(o)}: HTTP ${o.status}, expected ${wanted}`;
  };
  const findings: Record<string, string[]> = {
    unexpectedAllows: result.unexpectedAllows.map(judged),
    unexpectedDenies: result.unexpectedDenies.map(judged),
    statusMismatches: result.statusMismatches.map(judged),
    missing: result.missing.map((e) => `${cellLabel(e)}: not observed`),
  };
  const totals = Object.entries(findings).map(([kind, lines]) => `${lines.length} ${kind}`);
  const shown = Object.entries(findings).flatMap(([kind, lines]) =>
    lines.slice(0, FINDINGS_SHOWN).map((line) => `${kind}: ${line}`),
  );
  expect(shown, `${totals.join(', ')}; the first ${FINDINGS_SHOWN} of each are listed`).toEqual([]);
  expect(result.pass).toBe(true);
}

describe('gateway authorisation matrix', () => {
  let loaded: LoadedMatrix[];
  let reach: ReachMap;
  let verdicts: ReachVerdict[];
  let diff: MatrixDiff;
  let forgedDiff: MatrixDiff;
  let reportFile: string;
  let probing = false;
  let storage: LocalStorageAdapter | undefined;
  const stored: ProbeObject[] = [];

  beforeAll(async () => {
    await requireTableVersion(TABLE_VERSION);
    loaded = await exportMatrices();
    const [version, { variants }, hmacKey] = await Promise.all([
      loadCutoverVersion(TABLE_VERSION),
      loadInventoryVariants(),
      loadStorageHmacKey(stateDir()),
    ]);
    const objects = probeObjects();
    reach = gatewayReach({
      matrices: loaded,
      version,
      variants,
      gatewayParams: { service: RELAY_PROBE_SERVICE },
      signedFileParams: Object.fromEntries(objects.map(({ bucket, params }) => [bucket, params])),
    });
    // The owners serve signed-file probes from the stack's local storage, so each probed bucket gets its object.
    storage = await createLocalStorageAdapter({ stateDir: stateDir(), hmacKey });
    const buckets = new Set(probedSignedBuckets(reach));
    for (const object of objects.filter(({ bucket }) => buckets.has(bucket))) {
      stored.push(object);
      await storage.put(object.bucket, object.key, PROBE_OBJECT_BODY, { contentType: PROBE_OBJECT_TYPE });
    }
    const expected = withEdgeGates(loaded.flatMap((matrix) => expectationsFor(matrix, ROLE_SET)), EDGE_GATES);
    const forgedExpected = forgedExpectations(expected, FORGED_SUBJECT);
    const { send, skipped } = sendPlan([...expected, ...forgedExpected], reach.probed);
    const owners = [...new Set(reach.probed.map((route) => route.package))];
    const observed = await withRestoredServices(DEBUG_SUCCESS_OWNERS, async () => {
      for (const name of DEBUG_SUCCESS_OWNERS) await restartService(name, { extraEnv: { LOG_LEVEL: 'debug' } });
      const fromOffsets = capturedLogOffsets({ packages: owners });
      probing = true;
      const observations = await probeAll(send, hmacKey);
      const judge = (index: RequestRecordIndex): ReachVerdict[] =>
        reachVerdicts(reach.probed, [...expected, ...forgedExpected], observations, skipped, index);
      return { probes: observations, verdicts: await awaitVerdicts(judge, owners, fromOffsets) };
    });
    const { probes } = observed;
    verdicts = observed.verdicts;
    const forged = (entry: { subject: string }): boolean => entry.subject === FORGED_SUBJECT;
    const role = (entry: { subject: string }): boolean => !forged(entry);
    // Only sent cells are judged, each at its unsigned edge path; skipped and unreached cells are reported on their own,
    // so `missing` names lost probes.
    const sent = send.map(({ expectation, path }): Expectation => ({ ...expectation, path: path.path }));
    diff = diffOutcomes(sent.filter(role), probes.filter(role));
    forgedDiff = diffOutcomes(sent.filter(forged), probes.filter(forged));
    const securityDir = join(stateDir(), 'security');
    await mkdir(securityDir, { recursive: true });
    const report = {
      tableVersion: TABLE_VERSION,
      packages: loaded.map(({ package: name, file, matrix }) => ({ name, file, routes: matrix.routes.length })),
      subjects: SUBJECT_ORDER,
      reach: {
        reachable: { count: reach.probed.length, routes: reach.probed },
        notProbed: { count: reach.notProbed.length, routes: reach.notProbed },
      },
      sent: probes.length,
      skipped: { count: skipped.length, entries: skipped },
      ownerEvidence: {
        counts: Object.fromEntries(
          REACH_STATES.map((state) => [state, verdicts.filter((verdict) => verdict.state === state).length]),
        ),
        routes: verdicts,
      },
      diff,
      forgedDiff,
    };
    reportFile = join(securityDir, 'gateway-matrix.json');
    await writeFile(reportFile, stableStringify(report), 'utf8');
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      const local = storage;
      if (local !== undefined) await Promise.all(stored.map(({ bucket, key }) => local.delete(bucket, key)));
    } finally {
      // Probes of send-login and forgot-password routes may have sent mail.
      if (probing) await resetMailpit();
    }
  });

  it('loads one route matrix per routed package', () => {
    expect(loaded.map((matrix) => matrix.package)).toEqual(ROUTED_PACKAGES.map((pkg) => pkg.name));
  });

  it('accounts for every non-edge declared route exactly once, as probed or as covered by its package suite', () => {
    expect(reachAccounting(loaded, reach)).toEqual({ missing: [], repeated: [], undeclared: [] });
  });

  it("proves from the owner's own request log that its route handled every route probed through the gateway", () => {
    const failed = verdicts.filter((verdict) => verdict.state === 'failed');
    const shown = failed.slice(0, FINDINGS_SHOWN).map((verdict) => {
      const judged = verdict.judged
        .slice(0, FINDINGS_SHOWN)
        .map((probe) => `${probe.subject} HTTP ${probe.observedStatus}, owner ${probe.ownerStatus ?? 'no record'}`);
      const more = verdict.judged.length - judged.length;
      const listed = more > 0 ? [...judged, `${more} more in gateway-matrix.json`] : judged;
      return `${verdict.package} ${verdict.method} ${verdict.url}: ${verdict.reason ?? ''} [${listed.join('; ')}]`;
    });
    expect(shown, `${failed.length} route(s) without owner evidence; the first ${shown.length} are listed`).toEqual([]);
  });

  it('reports zero unexpected allows, unexpected denies, wrong denial statuses and lost probes for every route and role subject', () => {
    expectNoFindings(diff);
  });

  it("gives forged user tokens anonymous's verdict where the gateway forwards and refuses them on its own routes", () => {
    expectNoFindings(forgedDiff);
  });

  it('writes signed-file probes to the matrix report as unsigned paths only', async () => {
    const text = await readFile(reportFile, 'utf8');
    const written = (JSON.parse(text) as { reach: { reachable: { routes: ProbedRoute[] } } }).reach.reachable.routes;
    expect(written.some((route) => route.paths.some((path) => path.signed === true))).toBe(true);
    // A count, so a failure prints no signature.
    expect(text.match(/[?&](?:sig|expires)=/g)?.length ?? 0, `${reportFile}: signed query values`).toBe(0);
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
