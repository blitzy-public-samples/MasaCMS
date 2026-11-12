// Unit tests for the scheduler state routes over the real import and state reads on an in-memory scheduler_state: contract shape, idempotent re-import, the legacy 400 and 409, and auth.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { SchedulerDescription, ScheduledTaskDefinition } from '../../src/legacy/index.js';
import {
  SCHEDULER_ROUTES,
  registerSchedulerRoutes,
  type SchedulerBackgroundRecord,
  type SchedulerRouteDeps,
} from '../../src/routes/scheduler.js';
import { importNativeTasks, readSchedulerState, type SchedulerImportResult, type SiteMonitorRecord } from '../../src/scheduler/index.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const STATE_PATH = '/internal/v1/scheduler/state';
const IMPORT_PATH = '/internal/v1/scheduler/state:import';
const NOW = new Date('2026-06-30T12:00:00.000Z');
const SUSPENDED_SINCE = '2026-06-30T11:30:00.000Z';
const MONITOR_NAME = '/srv/www/index.cfm/_api/sitemonitor/';

const MONITOR: ScheduledTaskDefinition = {
  task: MONITOR_NAME,
  group: 'DEFAULT',
  url: 'http://localhost:8080/index.cfm/_api/sitemonitor/',
  port: '8080',
  interval: '900',
  startDate: '06/30/2026',
  startTime: '00:15:00',
  requestTimeOut: '600',
  operation: 'HTTPRequest',
  paused: false,
};

const SURVEY: ScheduledTaskDefinition = {
  ...MONITOR,
  task: 'opt2-survey-9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F-launch',
  url: 'http://localhost:8100/legacy-fixtures/cfml/api.cfm/surveys/launch?siteid=tenant-a&opt2TaskToken=fixture-task-token',
  interval: 'once',
  startTime: '09:00:00',
};

/** A `SchedulerImportRequest` body: tasks as `box cfconfig export` writes them, plus the original `ping`. */
function importBody(ping: boolean | null, ...tasks: ScheduledTaskDefinition[]) {
  return {
    ping,
    nativeTasks: tasks.map((task) => ({
      task: task.task,
      group: task.group,
      URL: task.url,
      httpPort: Number(task.port),
      interval: task.interval,
      startDate: task.startDate,
      startTime: task.startTime,
      requestTimeOut: Number(task.requestTimeOut),
      status: task.paused ? 'Paused' : 'Running',
    })),
  };
}

/** `migration.scheduler_state` in memory, answering the statements state.ts issues; a failed transaction is undone. */
class MemoryState {
  rows = new Map<string, unknown>();

  db(): TenantDb {
    return {
      schema: 'migration',
      withTenant: () => Promise.reject(new Error('scheduler state never runs in a tenant transaction')),
      withMetadata: async <T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> => {
        const before = new Map(this.rows);
        try {
          return await fn(this.tx());
        } catch (error) {
          this.rows = before;
          throw error;
        }
      },
      end: () => Promise.resolve(),
    } as unknown as TenantDb;
  }

  private tx(): MetadataTx {
    return {
      schema: 'migration',
      kind: 'metadata',
      onCommit: () => undefined,
      query: (text: unknown, values?: unknown[]) => Promise.resolve().then(() => this.run(String(text), values ?? [])),
    } as unknown as MetadataTx;
  }

  private run(sql: string, values: unknown[]): QueryResult {
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) return result([]);
    if (sql.startsWith('SELECT key, value FROM migration.scheduler_state')) {
      const keys = (values[0] as string[]).filter((key) => this.rows.has(key));
      return result(keys.map((key) => ({ key, value: structuredClone(this.rows.get(key)) })));
    }
    const [key, json] = values as [string, string];
    if (sql.startsWith('SELECT value FROM migration.scheduler_state WHERE key = $1')) {
      return result(this.rows.has(key) ? [{ value: structuredClone(this.rows.get(key)) }] : []);
    }
    if (sql.startsWith('INSERT INTO migration.scheduler_state')) {
      this.rows.set(key, JSON.parse(json));
      return result([], 1);
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

function result(rows: QueryResultRow[], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

const clock = fixedClock(NOW);
let store = new MemoryState();
let live: SchedulerDescription;
let backgroundRecord: SchedulerBackgroundRecord;

// The scheduler service's `state` and `importState`, as createSchedulerService binds them, over the in-memory table and a live describe.
const scheduler = {
  state: vi.fn<SchedulerRouteDeps['scheduler']['state']>(async () => ({ stored: await readSchedulerState(store.db(), clock.now()), live })),
  importState: vi.fn<SchedulerRouteDeps['scheduler']['importState']>((body) => importNativeTasks({ db: store.db(), clock }, body)),
};
const background = { get: vi.fn(() => Promise.resolve(backgroundRecord)) };
let app: FastifyInstance;

beforeAll(async () => {
  app = await createService({
    name: 'migration',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8102',
      OPT2_SERVICE_NAME: 'migration',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('migration'),
    logger: createLogger({ service: 'migration', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  registerSchedulerRoutes(app, { scheduler, background });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  store = new MemoryState();
  live = { ping: false, siteMonitorTask: MONITOR_NAME, tasks: [], serverTime: '2026-06-30 12:00:00' };
  backgroundRecord = { suspended: false, since: null };
  scheduler.state.mockClear();
  scheduler.importState.mockClear();
});

/** Invocation-credential headers of `caller`, optionally with a user token. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-admin', site: 'default', roles: [Roles.s2] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}`;
  return headers;
}

/** Injects a request and checks the answer against the contract operation at `path`. */
async function call(method: 'GET' | 'POST', path: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method,
    url: path,
    headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

const operator = () => headersFor('operator');
const importCapture = async (body: unknown) => call('POST', IMPORT_PATH, await operator(), body);
const lastImport = (): Promise<SchedulerImportResult> => scheduler.importState.mock.results.at(-1)?.value as Promise<SchedulerImportResult>;

describe('route declaration', () => {
  it('matches the contract operations, transport and roles', () => {
    const get = OPENAPI.paths[STATE_PATH]?.get ?? {};
    const post = OPENAPI.paths[IMPORT_PATH]?.post ?? {};
    expect(SCHEDULER_ROUTES).toEqual([
      { operationId: get.operationId, method: 'GET', path: STATE_PATH, url: STATE_PATH },
      { operationId: post.operationId, method: 'POST', path: IMPORT_PATH, url: '/internal/v1/scheduler/state::import' },
    ]);
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith(STATE_PATH));
    expect(declared).toEqual([
      expect.objectContaining({ method: 'GET', url: STATE_PATH, transport: get['x-opt2-transport'], requires: get['x-opt2-requires'] }),
      expect.objectContaining({ method: 'POST', url: '/internal/v1/scheduler/state::import', transport: post['x-opt2-transport'], requires: post['x-opt2-requires'] }),
    ]);
  });
});

describe('schedulerStateGet', () => {
  it('reports no capture, no monitor and running background work before any import', async () => {
    const res = await call('GET', STATE_PATH, await operator());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ping: null,
      nativeTaskExisted: false,
      siteMonitor: { state: 'none' },
      tasks: [],
      fixtureTasks: [],
      background: { suspended: false },
    });
  });

  it('reports the live paused monitor, the survey tasks without their token and the suspension', async () => {
    await importCapture(importBody(true, MONITOR, SURVEY));
    live = { ...live, tasks: [{ ...MONITOR, paused: true }, { ...SURVEY, paused: true }] };
    backgroundRecord = { suspended: true, since: SUSPENDED_SINCE };

    const res = await call('GET', STATE_PATH, await operator());

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      ping: true,
      nativeTaskExisted: true,
      siteMonitor: { state: 'paused' },
      tasks: [{ name: MONITOR_NAME, status: 'paused', interval: '900', requestTimeOut: '600' }],
      fixtureTasks: [{ name: SURVEY.task, status: 'paused' }],
      background: { suspended: true, since: SUSPENDED_SINCE },
    });
    expect(body.fixtureTasks[0].url).not.toContain('opt2TaskToken');
  });
});

describe('schedulerStateImport', () => {
  it('imports a new capture once and answers the state after it', async () => {
    const body = importBody(true, MONITOR, SURVEY);
    const res = await importCapture(body);

    expect(res.statusCode).toBe(200);
    expect(scheduler.importState).toHaveBeenCalledExactlyOnceWith(body);
    await expect(lastImport()).resolves.toMatchObject({ imported: true, reason: 'imported', nativeExisted: true, taskCount: 2 });
    expect(res.json()).toMatchObject({
      ping: true,
      nativeTaskExisted: true,
      siteMonitor: { state: 'captured' },
      tasks: [{ name: MONITOR_NAME, status: 'captured' }],
      fixtureTasks: [],
      background: { suspended: false },
    });
  });

  it('leaves the stored capture untouched when the same capture is imported again', async () => {
    const body = importBody(false, MONITOR);
    const first = await importCapture(body);
    const stored = structuredClone([...store.rows]);

    const again = await importCapture(body);

    expect(again.statusCode).toBe(200);
    await expect(lastImport()).resolves.toMatchObject({ imported: false, reason: 'unchanged' });
    expect([...store.rows]).toEqual(stored);
    expect(again.json()).toEqual(first.json());
  });

  it.each([
    ['no task list', { ping: true }],
    ['a task without a name', { ping: true, nativeTasks: [{ URL: 'http://localhost/' }] }],
    ['no ping', { nativeTasks: [] }],
    ['an array', []],
  ])('answers %s with the legacy 400 without reading state', async (_label, body) => {
    const res = await importCapture(body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(store.rows.size).toBe(0);
    expect(scheduler.state).not.toHaveBeenCalled();
  });

  it('answers a body that is not JSON, which service-kit parses to no body, with the legacy 400', async () => {
    const res = await importCapture('{"nativeTasks": [');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(scheduler.importState).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(store.rows.size).toBe(0);
  });

  it('answers a different capture after the monitor was handed off with the legacy 409 and keeps the stored capture', async () => {
    const original = importBody(true, MONITOR);
    await importCapture(original);
    const monitor = store.rows.get('sitemonitor') as SiteMonitorRecord;
    store.rows.set('sitemonitor', { ...monitor, state: 'target', handedOffAt: NOW.toISOString() });
    const stored = structuredClone([...store.rows]);

    const res = await importCapture(importBody(false, MONITOR, SURVEY));

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: expect.stringContaining('handed off') } });
    expect([...store.rows]).toEqual(stored);

    const same = await importCapture(original);
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ siteMonitor: { state: 'handed-off', handedOffAt: NOW.toISOString() } });
  });

  it('propagates a storage failure as a server error', async () => {
    scheduler.importState.mockRejectedValueOnce(new Error('connection terminated'));

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await app.inject({ method: 'POST', url: IMPORT_PATH, headers: await operator(), payload: importBody(true, MONITOR) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('auth', () => {
  it.each([
    ['GET', STATE_PATH, undefined],
    ['POST', IMPORT_PATH, importBody(true, MONITOR)],
  ] as const)('%s %s admits the operator and refuses every other caller', async (method, path, body) => {
    expect((await call(method, path, await headersFor('operator'), body)).statusCode).toBe(200);
    for (const caller of ['migration', 'gateway', 'programs-sites', 'people']) {
      expect((await call(method, path, await headersFor(caller), body)).statusCode).toBe(403);
    }
    expect((await call(method, path, await headersFor(null), body)).statusCode).toBe(401);
    expect((await call(method, path, await headersFor(null, true), body)).statusCode).toBe(401);
    expect(scheduler.importState).toHaveBeenCalledTimes(method === 'POST' ? 1 : 0);
  });
});
