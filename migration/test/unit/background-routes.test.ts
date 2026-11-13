// Unit tests for the background suspend and resume routes over the real background state on an in-memory scheduler_state: contract shape, the stored record, the legacy 400 and auth.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { BACKGROUND_KEY, createBackgroundState, defaultBackgroundRecord, type BackgroundRecord } from '../../src/quiesce/index.js';
import { BACKGROUND_ROUTES, registerBackgroundRoutes } from '../../src/routes/background.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const SUSPEND_PATH = '/internal/v1/background:suspend';
const RESUME_PATH = '/internal/v1/background:resume';
const NOW = '2026-06-30T12:00:00.000Z';
const SINCE = '2026-06-30T11:30:00.000Z';

const RECORD: BackgroundRecord = {
  suspended: true,
  since: null,
  reason: 'golden capture',
  pushConfigs: {
    'timesheets.people.person.archived.v1': {
      pushEndpoint: 'http://127.0.0.1:22918/internal/v1/events/timesheets.people.person.archived.v1?key=REDACTED',
      attributes: { 'x-goog-version': 'v1' },
    },
  },
  pausedQueues: [{ service: 'programs-sites', queue: 'programs-sites-sitemonitor' }],
  pausedTasks: ['opt2-survey-41-launch'],
};

/** `migration.scheduler_state` in memory; values make a JSON round trip, as jsonb does. */
class StateTable {
  readonly rows = new Map<string, unknown>();
  writes = 0;

  db(): TenantDb {
    const tx = { schema: 'migration', kind: 'metadata', onCommit: () => undefined, query: (text: string, values: unknown[] = []) => this.run(text, values) };
    return {
      schema: 'migration',
      withTenant: () => Promise.reject(new Error('background state never runs in a tenant transaction')),
      withMetadata: <T>(fn: (metadata: MetadataTx) => Promise<T>): Promise<T> => fn(tx as unknown as MetadataTx),
      end: () => Promise.resolve(),
    };
  }

  private run(sql: string, values: unknown[]): Promise<QueryResult> {
    const [key, json] = values as [string, string | undefined];
    if (sql.startsWith('SELECT value FROM migration.scheduler_state')) {
      const rows = this.rows.has(key) ? [{ value: JSON.parse(JSON.stringify(this.rows.get(key))) as unknown }] : [];
      return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
    }
    if (sql.startsWith('INSERT INTO migration.scheduler_state') && json !== undefined) {
      this.rows.set(key, JSON.parse(json));
      this.writes += 1;
      return Promise.resolve({ rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });
    }
    return Promise.reject(new Error(`unexpected statement: ${sql}`));
  }
}

let table = new StateTable();
let state = createBackgroundState({ db: table.db(), clock: fixedClock(NOW) });
// Delegates to the state of the current test, so each test starts from an empty table.
const background = {
  get: vi.fn(() => state.get()),
  suspend: vi.fn((record: BackgroundRecord) => state.suspend(record)),
  resume: vi.fn(() => state.resume()),
};
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
  registerBackgroundRoutes(app, { background });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  table = new StateTable();
  state = createBackgroundState({ db: table.db(), clock: fixedClock(NOW) });
  background.get.mockClear();
  background.suspend.mockClear();
  background.resume.mockClear();
});

/** Invocation-credential headers of `caller`, optionally with a user token. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-admin', site: 'default', roles: [Roles.s2] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}`;
  return headers;
}

/** Injects a POST and checks the answer against the contract operation at `path`. */
async function post(path: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: path,
    headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

const operator = () => headersFor('operator');

describe('route declaration', () => {
  it('matches the contract operations, transport and roles', () => {
    const suspend = OPENAPI.paths[SUSPEND_PATH]?.post ?? {};
    const resume = OPENAPI.paths[RESUME_PATH]?.post ?? {};
    expect(BACKGROUND_ROUTES).toEqual([
      { operationId: suspend.operationId, method: 'POST', path: SUSPEND_PATH, url: '/internal/v1/background::suspend' },
      { operationId: resume.operationId, method: 'POST', path: RESUME_PATH, url: '/internal/v1/background::resume' },
    ]);
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/internal/v1/background'));
    expect(declared).toHaveLength(2);
    expect(declared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'POST', url: '/internal/v1/background::suspend', transport: suspend['x-opt2-transport'], requires: suspend['x-opt2-requires'] }),
        expect.objectContaining({ method: 'POST', url: '/internal/v1/background::resume', transport: resume['x-opt2-transport'], requires: resume['x-opt2-requires'] }),
      ]),
    );
  });
});

describe('backgroundSuspend', () => {
  it('stores the record as suspended since now and answers the suspension', async () => {
    const res = await post(SUSPEND_PATH, await operator(), RECORD);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suspended: true, since: NOW });
    expect(table.rows.get(BACKGROUND_KEY)).toEqual({ ...RECORD, since: NOW });
  });

  it('keeps a supplied since and lets a repeated suspend replace the record', async () => {
    await post(SUSPEND_PATH, await operator(), { ...RECORD, since: SINCE });
    const again = { ...RECORD, since: SINCE, pausedTasks: [...RECORD.pausedTasks, 'opt2-survey-41-reminder-1'] };

    const res = await post(SUSPEND_PATH, await operator(), again);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suspended: true, since: SINCE });
    expect(table.rows.get(BACKGROUND_KEY)).toEqual(again);
  });

  it.each([
    ['no paused tasks', { suspended: true, since: null, reason: null, pushConfigs: {}, pausedQueues: [] }],
    ['a suspended flag that is not a boolean', { ...RECORD, suspended: 'yes' }],
    ['a since that is not a timestamp', { ...RECORD, since: 'yesterday' }],
    ['a paused queue without a name', { ...RECORD, pausedQueues: [{ service: 'identity', queue: '' }] }],
    ['an extra top-level key', { ...RECORD, background: { suspended: true } }],
    ['an array', [RECORD]],
    ['a body that is not JSON, which service-kit parses to no body', '{"suspended": tr'],
  ])('answers %s with the legacy 400 and stores nothing', async (_label, body) => {
    const res = await post(SUSPEND_PATH, await operator(), body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(background.suspend).not.toHaveBeenCalled();
    expect(table.rows.size).toBe(0);
  });

  it('propagates a storage failure as a server error', async () => {
    background.suspend.mockRejectedValueOnce(new Error('connection terminated'));

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await app.inject({ method: 'POST', url: SUSPEND_PATH, headers: await operator(), payload: RECORD });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('backgroundResume', () => {
  it('clears a suspended record and answers running background work', async () => {
    await post(SUSPEND_PATH, await operator(), RECORD);

    const res = await post(RESUME_PATH, await operator());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suspended: false });
    expect(background.resume).toHaveBeenCalledOnce();
    expect(table.rows.get(BACKGROUND_KEY)).toEqual({ ...defaultBackgroundRecord(), resumedAt: NOW });
  });

  it('writes nothing while nothing is suspended', async () => {
    const res = await post(RESUME_PATH, await operator());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suspended: false });
    expect(background.resume).not.toHaveBeenCalled();
    expect(table.writes).toBe(0);
  });
});

describe('auth', () => {
  it.each([
    [SUSPEND_PATH, RECORD],
    [RESUME_PATH, undefined],
  ] as const)('POST %s admits the operator and refuses every other caller', async (path, body) => {
    expect((await post(path, await headersFor('operator'), body)).statusCode).toBe(200);
    for (const caller of ['migration', 'gateway', 'programs-sites', 'people']) {
      expect((await post(path, await headersFor(caller), body)).statusCode).toBe(403);
    }
    expect((await post(path, await headersFor(null), body)).statusCode).toBe(401);
    expect((await post(path, await headersFor(null, true), body)).statusCode).toBe(401);
    // Only the operator's suspend writes; a resume with nothing suspended never does.
    expect(table.writes).toBe(path === SUSPEND_PATH ? 1 : 0);
  });
});
