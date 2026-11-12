/** Site-monitor routes: the public legacy run, the recurring task chain and the cursor state, over PostgreSQL and a stub migration. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { SITEMONITOR_INTERVAL_S, SITEMONITOR_QUEUE, slotName, slotStartS, type CreateTaskInput, type TaskPort } from '@opt2/platform/tasks';
import { SYSTEM_TENANT_ID, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  assertResponseMatchesOpenApi,
  authHeadersFor,
  createThrowawaySchema,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type RoleSubject,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { runSiteMonitor } from '../../src/jobs/sitemonitor.js';
import { readState, writeCursor } from '../../src/repo/sitemonitor-state.js';
import { UNITS } from '../../src/repo/tables.js';
import { SITEMONITOR_RUN_PREFIXES, registerSiteMonitorRoutes } from '../../src/routes/sitemonitor.js';
import { buildTestApp } from '../helpers/app.js';

vi.mock('../../src/jobs/sitemonitor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/jobs/sitemonitor.js')>();
  return { ...actual, runSiteMonitor: vi.fn(actual.runSiteMonitor) };
});

const { runSiteMonitor: realRunSiteMonitor } =
  await vi.importActual<typeof import('../../src/jobs/sitemonitor.js')>('../../src/jobs/sitemonitor.js');

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const RUN_CONTRACT_PATH = '/_api/sitemonitor';
const TASK_PATH = '/internal/v1/jobs/sitemonitor';
const STATE_PATH = '/internal/v1/sitemonitor/state';

const RUN_AT = new Date(2026, 5, 30, 12, 0, 30, 250);
const RUN_AT_TEXT = '2026-06-30T12:00:30.250';
// Same minute-of-hour as RUN_AT − 30 min, so a pass sends reminders once.
const SEEDED = new Date(2026, 5, 30, 11, 30, 5, 125);
const SEEDED_TEXT = '2026-06-30T11:30:05.125';
const LEGACY_STEPS = [
  'sendReminders',
  'emailSend',
  'publishScheduledChangesets',
  'purgeDisplayWindow',
  'clearOldCommands',
  'onGlobalMonitor',
  'setCursor',
];
const SELF_URL = 'http://127.0.0.1:8113';
const JSON_BODY = { 'content-type': 'application/json' };

const clock = fixedClock(RUN_AT);
const available = await pgAvailable();
const runSpy = vi.mocked(runSiteMonitor);

/** Stub migration answering unit authority as all-legacy and each legacy step with `stepStatus`. */
interface StubMigration {
  server: Server;
  url: string;
  stepStatus: number;
  steps: string[];
}

/** Ordered record of successor creations and migration calls. */
const events: string[] = [];

async function startMigration(): Promise<StubMigration> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stub: StubMigration = {
    server,
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    stepStatus: 200,
    steps: [],
  };
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const pathname = (req.url ?? '').split('?')[0];
      events.push(`migration ${String(req.method)} ${String(pathname)}`);
      if (pathname === '/internal/v1/authority') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tableVersion: 'v0001', units: {}, allTarget: false }));
        return;
      }
      stub.steps.push((JSON.parse(body) as { step: string }).step);
      res.writeHead(stub.stepStatus, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return stub;
}

/** Task port recording each create; `failCreate` makes every create reject. */
function recordingPort(): TaskPort & { creates: CreateTaskInput[]; failCreate: boolean } {
  const port = {
    kind: 'local' as const,
    creates: [] as CreateTaskInput[],
    failCreate: false,
    async create(input: CreateTaskInput) {
      events.push(`create ${input.name}`);
      if (port.failCreate) throw new Error('queue unavailable');
      port.creates.push(input);
      return { name: input.name, created: true };
    },
    delete: async (_queue: string, name: string) => ({ name, deleted: false }),
    list: async () => ({ tasks: [] }),
    get: async () => undefined,
    pauseQueue: async () => undefined,
    resumeQueue: async () => undefined,
    queueState: async (queue: string) => ({ queue, paused: false }),
    close: async () => undefined,
  };
  return port;
}

// Never queried: only the route declarations run without PostgreSQL.
const NO_DB: TenantDb = {
  schema: 'programs_sites',
  withTenant: () => Promise.reject(new Error('no database')),
  withMetadata: () => Promise.reject(new Error('no database')),
  end: async () => undefined,
};

let stateDir: string;
let migration: StubMigration;
let handle: ThrowawaySchema | undefined;
let db: TenantDb;
let app: FastifyInstance;
const port = recordingPort();

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-sitemonitor-routes-'));
  await writeTestSecrets(stateDir);
  migration = await startMigration();
  db = NO_DB;
  if (available) {
    handle = await createThrowawaySchema({
      service: 'programs-sites',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle?.schema ?? ''}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    // The service's shutdown ends its pool; drop() ends the throwaway pools itself.
    db = { ...handle.app, end: async () => undefined };
  }
  const serviceUrls = { 'programs-sites': SELF_URL, migration: migration.url };
  app = await createService({
    name: 'programs-sites',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8113',
      OPT2_SERVICE_NAME: 'programs-sites',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_SERVICE_URLS: JSON.stringify(serviceUrls),
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('programs-sites'),
    clock,
    noCasePathPrefixes: SITEMONITOR_RUN_PREFIXES,
    pool: db,
    logger: createLogger({ service: 'programs-sites', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  await registerSiteMonitorRoutes(app, { db, port, clock, serviceUrls });
  await app.ready();
});

afterAll(async () => {
  await app.opt2.shutdown();
  await handle?.drop();
  await new Promise((resolve) => migration.server.close(resolve));
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  events.length = 0;
  migration.steps.length = 0;
  migration.stepStatus = 200;
  port.creates.length = 0;
  port.failCreate = false;
  runSpy.mockClear();
  runSpy.mockImplementation(realRunSiteMonitor);
  if (handle !== undefined) await writeCursor(db, SEEDED, clock);
});

function subject(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No role subject ${name}`);
  return found;
}

function headersAs(name: string): Promise<Record<string, string>> {
  return authHeadersFor(subject(name), { audience: 'programs-sites' });
}

/** A system task wire body for the chain slot containing RUN_AT. */
function taskBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const slot = slotStartS(Math.floor(RUN_AT.getTime() / 1000), SITEMONITOR_INTERVAL_S);
  return { queue: SITEMONITOR_QUEUE, name: slotName(SITEMONITOR_QUEUE, slot), tenantId: null, payload: { slotStartS: slot }, ...overrides };
}

/** Checks a response against the contract operation of `contractPath`. */
function assertContract(method: string, contractPath: string, res: { statusCode: number; headers: Record<string, unknown>; body: string }): void {
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: contractPath,
    status: res.statusCode,
    contentType: res.headers['content-type'] as string | undefined,
    body: res.body,
  });
}

describe('route declarations', () => {
  it('declare the contract operations, the public run on every legacy path form', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.includes('sitemonitor'));
    const contractTemplate = (url: string): string => url.replace(/^\/index\.cfm/, '').replace(/\*$/, '');
    const expected: RouteMatrixEntry[] = [
      ...['/_api/sitemonitor*', '/index.cfm/_api/sitemonitor*'].flatMap((url) =>
        ['GET', 'POST'].map((method) => ({ method, url, transport: 'service' as const, public: true as const, siteCheck: false })),
      ),
      { method: 'POST', url: TASK_PATH, transport: 'cloud-tasks', requires: ['service:tasks-invoker'], siteCheck: true },
      { method: 'GET', url: STATE_PATH, transport: 'service', requires: ['platform.migration'], siteCheck: true },
      { method: 'PUT', url: STATE_PATH, transport: 'service', requires: ['platform.migration'], siteCheck: true },
    ];
    expect(declared).toHaveLength(expected.length);
    expect(declared).toEqual(expect.arrayContaining(expected));
    for (const route of declared) {
      const operation = OPENAPI.paths[contractTemplate(route.url)]?.[route.method.toLowerCase()];
      expect(operation, `${route.method} ${route.url}`).toBeDefined();
      expect(route.transport).toBe(operation?.['x-opt2-transport']);
      expect(route.requires).toEqual(operation?.['x-opt2-requires']);
      expect(route.public).toBe(operation?.['x-opt2-public']);
    }
  });
});

describe('letter case of the legacy paths', () => {
  const PASS = { theTime: RUN_AT, lastMonitored: SEEDED, steps: [] };

  it.each([
    ['GET', '/INTERNAL/v1/sitemonitor/state', 'service:migration'],
    ['PUT', '/internal/v1/SITEMONITOR/state', 'service:migration'],
    ['POST', '/Internal/v1/jobs/sitemonitor', 'service:tasks-invoker'],
  ] as const)('answers %s %s with 404 and never runs the monitor', async (method, url, caller) => {
    const res = await app.inject({ method, url, headers: await headersAs(caller) });

    expect(res.statusCode).toBe(404);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('runs the monitor for GET /_API/SITEMONITOR/ on the app buildApp composes', async () => {
    runSpy.mockResolvedValueOnce(PASS);
    const { app: built } = await buildTestApp();
    try {
      const res = await built.inject({ method: 'GET', url: '/_API/SITEMONITOR/' });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('');
      expect(runSpy).toHaveBeenCalledTimes(1);
    } finally {
      await built.opt2.shutdown();
    }
  });
});

describe.skipIf(!available)('cursor state', () => {
  it('reads null fields before the cursor row exists', async () => {
    await withTenant(db, SYSTEM_TENANT_ID, (tx) => tx.query(`DELETE FROM ${tx.schema}.sitemonitor_state`));
    const res = await app.inject({ method: 'GET', url: STATE_PATH, headers: await headersAs('service:migration') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lastMonitored: null, updatedAt: null });
    assertContract('GET', STATE_PATH, res);
  });

  it('stores a seeded cursor and reads it back with its update time', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: STATE_PATH,
      headers: { ...(await headersAs('service:migration')), ...JSON_BODY },
      payload: { lastMonitored: '2026-06-30T09:15:00.007' },
    });
    const read = await app.inject({ method: 'GET', url: STATE_PATH, headers: await headersAs('service:migration') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lastMonitored: '2026-06-30T09:15:00.007', updatedAt: RUN_AT_TEXT });
    expect(read.json()).toEqual(res.json());
    expect((await readState(db)).lastMonitored).toEqual(new Date(2026, 5, 30, 9, 15, 0, 7));
    assertContract('PUT', STATE_PATH, res);
    assertContract('GET', STATE_PATH, read);
  });

  it.each([
    ['an empty object', {}],
    ['a null cursor', { lastMonitored: null }],
    ['a space separator', { lastMonitored: '2026-06-30 09:15:00.000' }],
    ['an offset', { lastMonitored: '2026-06-30T09:15:00.000Z' }],
    ['seconds without milliseconds', { lastMonitored: '2026-06-30T09:15:00' }],
    ['an impossible date', { lastMonitored: '2026-02-30T09:15:00.000' }],
    ['an extra property', { lastMonitored: '2026-06-30T09:15:00.000', updatedAt: null }],
    ['a body that is not JSON', 'lastMonitored='],
  ])('answers badRequest for %s and keeps the cursor', async (_label, payload) => {
    const res = await app.inject({
      method: 'PUT',
      url: STATE_PATH,
      headers: { ...(await headersAs('service:migration')), ...JSON_BODY },
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect((await readState(db)).lastMonitored).toEqual(SEEDED);
    assertContract('PUT', STATE_PATH, res);
  });
});

describe.skipIf(!available)('public legacy run', () => {
  it.each([
    ['GET', '/_api/sitemonitor'],
    ['POST', '/_api/sitemonitor'],
    ['GET', '/_api/sitemonitor/'],
    ['GET', '/_api/sitemonitorX?siteid=tenant-b'],
    ['GET', '/index.cfm/_api/sitemonitor/'],
    ['POST', '/index.cfm/_api/sitemonitor'],
    ['GET', '/_API/SITEMONITOR/'],
    ['POST', '/Index.CFM/_Api/SiteMonitor'],
    ['GET', '/_api/%53ITEMONITOR?siteid=x'],
    ['GET', '/_api%2Fsitemonitor'],
  ] as const)('%s %s runs one pass and answers the empty legacy page', async (method, url) => {
    const res = await app.inject({ method, url });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(migration.steps).toEqual(LEGACY_STEPS);
    expect(await readState(db)).toEqual({ lastMonitored: RUN_AT, updatedAt: RUN_AT });
    expect(port.creates).toEqual([]);
    assertContract(method, RUN_CONTRACT_PATH, res);
  });

  it('ignores a siteid that differs from the user token site', async () => {
    const res = await app.inject({ method: 'GET', url: '/_api/sitemonitor/?siteid=tenant-b', headers: await headersAs('site-admin') });

    expect(res.statusCode).toBe(200);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [500, 500],
    [503, 503],
  ])('answers %i from a legacy step as %i and leaves the cursor', async (stepStatus, status) => {
    migration.stepStatus = stepStatus;
    const res = await app.inject({ method: 'GET', url: '/index.cfm/_api/sitemonitor/' });

    expect(res.statusCode).toBe(status);
    expect(migration.steps).toEqual(['sendReminders']);
    expect((await readState(db)).lastMonitored).toEqual(SEEDED);
    assertContract('GET', RUN_CONTRACT_PATH, res);
  });
});

describe.skipIf(!available)('recurring task route', () => {
  it('creates the next slot before the pass and answers the run result', async () => {
    const body = taskBody();
    const res = await app.inject({
      method: 'POST',
      url: TASK_PATH,
      headers: { ...(await headersAs('service:tasks-invoker')), ...JSON_BODY },
      payload: body,
    });

    const successor = slotName(SITEMONITOR_QUEUE, (body.payload as { slotStartS: number }).slotStartS + SITEMONITOR_INTERVAL_S);
    expect(res.statusCode).toBe(200);
    expect(events[0]).toBe(`create ${successor}`);
    expect(port.creates).toEqual([
      expect.objectContaining({ queue: SITEMONITOR_QUEUE, name: successor, url: `${SELF_URL}${TASK_PATH}`, deadlineS: 600 }),
    ]);
    expect(port.creates[0]?.tenantId).toBeUndefined();
    expect(res.json()).toEqual({
      theTime: RUN_AT_TEXT,
      lastMonitored: SEEDED_TEXT,
      steps: LEGACY_STEPS.map((step) => ({ step, routedTo: 'legacy', status: 'completed', theTime: RUN_AT_TEXT })),
    });
    expect((await readState(db)).lastMonitored).toEqual(RUN_AT);
    assertContract('POST', TASK_PATH, res);
  });

  it('reports a target step with its site and task', async () => {
    const task = { queue: 'content-feed-import', name: 'content-feed-import-1782820800-feed-auto-import', created: true };
    runSpy.mockResolvedValueOnce({
      theTime: RUN_AT,
      lastMonitored: SEEDED,
      steps: [{ step: 'feedAutoImport', siteId: 'tenant-a', route: 'target', theTime: RUN_AT, task }],
    });
    const res = await app.inject({
      method: 'POST',
      url: TASK_PATH,
      headers: { ...(await headersAs('service:tasks-invoker')), ...JSON_BODY },
      payload: taskBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      theTime: RUN_AT_TEXT,
      lastMonitored: SEEDED_TEXT,
      steps: [{ step: 'feedAutoImport', routedTo: 'target', status: 'completed', siteId: 'tenant-a', theTime: RUN_AT_TEXT, task }],
    });
    assertContract('POST', TASK_PATH, res);
  });

  it('answers 503 without running when the successor cannot be created', async () => {
    port.failCreate = true;
    const res = await app.inject({
      method: 'POST',
      url: TASK_PATH,
      headers: { ...(await headersAs('service:tasks-invoker')), ...JSON_BODY },
      payload: taskBody(),
    });

    expect(res.statusCode).toBe(503);
    expect(runSpy).not.toHaveBeenCalled();
    expect(events.filter((event) => event.startsWith('migration'))).toEqual([]);
    expect((await readState(db)).lastMonitored).toEqual(SEEDED);
    assertContract('POST', TASK_PATH, res);
  });
});

describe.skipIf(!available)('authorisation', () => {
  const PASS = { theTime: RUN_AT, lastMonitored: SEEDED, steps: [] };
  // Subjects presenting no credential the service transport verifies.
  const unauthenticatedOnService = new Set(['anonymous', 'service:pubsub-invoker', 'service:tasks-invoker']);

  it.each(ROLE_SET.map((s) => [s.name] as const))('%s', async (name) => {
    runSpy.mockResolvedValue(PASS);
    const headers = await headersAs(name);
    const run = await app.inject({ method: 'GET', url: '/_api/sitemonitor', headers });
    const task = await app.inject({ method: 'POST', url: TASK_PATH, headers: { ...headers, ...JSON_BODY }, payload: taskBody() });
    const read = await app.inject({ method: 'GET', url: STATE_PATH, headers });
    const write = await app.inject({
      method: 'PUT',
      url: STATE_PATH,
      headers: { ...headers, ...JSON_BODY },
      payload: { lastMonitored: SEEDED_TEXT },
    });

    // Only the tasks-invoker token, which the service transport cannot verify as a user token, is refused the public run.
    expect(run.statusCode).toBe(name === 'service:tasks-invoker' ? 401 : 200);
    expect(task.statusCode).toBe(name === 'service:tasks-invoker' ? 200 : 401);
    const stateStatus = name === 'service:migration' ? 200 : unauthenticatedOnService.has(name) ? 401 : 403;
    expect([read.statusCode, write.statusCode]).toEqual([stateStatus, stateStatus]);
    // Exactly one of the public run and the task route admits each subject.
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
