// Unit tests for the persisted background suspension record and its in-process and remote APIs.
import { fixedClock, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import type { QueryResult } from 'pg';
import { describe, expect, it } from 'vitest';

import type { ServiceCaller } from '../../src/context.js';
import {
  BACKGROUND_KEY,
  BackgroundCallError,
  backgroundRecordSchema,
  backgroundStateView,
  createBackgroundState,
  defaultBackgroundRecord,
  remoteBackgroundState,
  type BackgroundRecord,
} from '../../src/quiesce/background.js';
import { SCHEDULER_STATE_TABLE, SchedulerStateError } from '../../src/scheduler/index.js';

const NOW = '2026-06-30T12:00:00.000Z';
const LATER = '2026-06-30T12:30:00.000Z';
const SELECT_SQL = `SELECT value FROM ${SCHEDULER_STATE_TABLE} WHERE key = $1`;
const UPSERT_SQL =
  `INSERT INTO ${SCHEDULER_STATE_TABLE} (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ` +
  'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at';

const RECORD: BackgroundRecord = {
  suspended: true,
  since: null,
  reason: 'golden capture',
  pushConfigs: {
    'timesheets.people.person.archived.v1': {
      pushEndpoint: 'http://127.0.0.1:23718/internal/v1/events/timesheets.people.person.archived.v1?key=REDACTED',
      attributes: { 'x-goog-version': 'v1' },
      oidcToken: { serviceAccountEmail: 'pubsub-invoker@opt2-c37.iam.gserviceaccount.com', audience: 'https://x.run.app' },
    },
  },
  pausedQueues: [
    { service: 'identity', queue: 'identity-outbox-sweep' },
    { service: 'programs-sites', queue: 'programs-sites-sitemonitor' },
  ],
  pausedTasks: ['/var/www/index.cfm/_api/sitemonitor/', 'opt2-survey-41-launch'],
};

/** In-memory `migration.scheduler_state` whose values make a JSON round trip, as jsonb does. */
class StateTable {
  readonly rows = new Map<string, unknown>();
  readonly statements: { sql: string; values: unknown[] }[] = [];

  db(): TenantDb {
    return {
      schema: 'migration',
      withTenant: () => Promise.reject(new Error('background state never runs in a tenant transaction')),
      withMetadata: <T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> => fn(this.tx()),
      end: () => Promise.resolve(),
    };
  }

  private tx(): MetadataTx {
    const query = (text: string, values: unknown[] = []): Promise<QueryResult> => Promise.resolve(this.run(text, values));
    return { schema: 'migration', kind: 'metadata', onCommit: () => undefined, query } as unknown as MetadataTx;
  }

  private run(sql: string, values: unknown[]): QueryResult {
    this.statements.push({ sql, values });
    const [key, json] = values as [string, string | undefined];
    if (sql === SELECT_SQL) {
      const rows = this.rows.has(key) ? [{ value: JSON.parse(JSON.stringify(this.rows.get(key))) as unknown }] : [];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    }
    if (sql === UPSERT_SQL && json !== undefined) {
      this.rows.set(key, JSON.parse(json));
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
    }
    throw new Error(`Unexpected statement: ${sql}`);
  }
}

function localState(table = new StateTable(), now = NOW) {
  return { table, state: createBackgroundState({ db: table.db(), clock: fixedClock(now) }) };
}

describe('createBackgroundState', () => {
  it('returns the default record and is not suspended when no row exists', async () => {
    const { table, state } = localState();
    await expect(state.get()).resolves.toEqual(defaultBackgroundRecord());
    await expect(state.isSuspended()).resolves.toBe(false);
    expect(table.statements).toEqual([
      { sql: SELECT_SQL, values: [BACKGROUND_KEY] },
      { sql: SELECT_SQL, values: [BACKGROUND_KEY] },
    ]);
  });

  it('stores a suspended record under key background, stamping since, and keeps push configs intact', async () => {
    const { table, state } = localState();
    const stored = await state.suspend({ ...RECORD, suspended: false });

    expect(stored).toEqual({ ...RECORD, since: NOW });
    expect(table.statements.at(-1)?.values[0]).toBe(BACKGROUND_KEY);
    const read = await state.get();
    expect(read).toEqual(stored);
    expect(JSON.stringify(read.pushConfigs)).toBe(JSON.stringify(RECORD.pushConfigs));
    await expect(state.isSuspended()).resolves.toBe(true);
  });

  it('keeps the since of a repeated suspend and lets the latest record win', async () => {
    const { state } = localState();
    const first = await state.suspend(RECORD);
    const merged = { ...first, pausedTasks: [...first.pausedTasks, 'opt2-survey-42-reminder-1'] };
    await state.suspend(merged);
    await expect(state.get()).resolves.toEqual({ ...merged, since: NOW });
  });

  it('resumes to the default record with resumedAt', async () => {
    const { state } = localState(new StateTable(), LATER);
    await state.suspend({ ...RECORD, since: NOW });
    const resumed = await state.resume();

    expect(resumed).toEqual({ ...defaultBackgroundRecord(), resumedAt: LATER });
    await expect(state.get()).resolves.toEqual(resumed);
    await expect(state.isSuspended()).resolves.toBe(false);
  });

  it('refuses a stored value that fails the schema', async () => {
    const table = new StateTable();
    table.rows.set(BACKGROUND_KEY, { suspended: 'yes' });
    const { state } = localState(table);
    const error = await state.get().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchedulerStateError);
    expect(error).toMatchObject({ key: BACKGROUND_KEY });
  });
});

describe('backgroundRecordSchema', () => {
  it.each([
    ['a since without offset', { since: '2026-06-30 12:00:00' }],
    ['a paused queue without service', { pausedQueues: [{ service: '', queue: 'identity-outbox-sweep' }] }],
    ['a push config that is not an object', { pushConfigs: { sub: 'http://x' } }],
    ['a missing pausedTasks', { pausedTasks: undefined }],
  ])('rejects %s', (_label, change) => {
    expect(backgroundRecordSchema.safeParse({ ...RECORD, ...change }).success).toBe(false);
  });

  it('accepts the default record and a resumed one', () => {
    expect(backgroundRecordSchema.parse(defaultBackgroundRecord())).toEqual(defaultBackgroundRecord());
    expect(backgroundRecordSchema.parse({ ...defaultBackgroundRecord(), resumedAt: LATER }).resumedAt).toBe(LATER);
  });
});

describe('backgroundStateView', () => {
  it.each([
    [defaultBackgroundRecord(), { suspended: false }],
    [{ ...RECORD, since: NOW }, { suspended: true, since: NOW }],
  ])('maps the record to BackgroundState', (record, view) => {
    expect(backgroundStateView(record)).toEqual(view);
  });
});

interface Call {
  caller: ServiceCaller;
  request: ServiceRequest;
}

/** Service clients per caller that record every call and answer with `answer`. */
function fakeClients(answer: (request: ServiceRequest) => ServiceResponse | Promise<ServiceResponse>) {
  const calls: Call[] = [];
  const clientAs = (caller: ServiceCaller): ServiceClient => ({
    request: async <T>(request: ServiceRequest) => {
      calls.push({ caller, request });
      return (await answer(request)) as ServiceResponse<T>;
    },
    close: () => Promise.resolve(),
  });
  return { calls, clientAs };
}

describe('remoteBackgroundState', () => {
  it('posts the record once as operator and returns the record the service stored', async () => {
    const service = localState();
    const { calls, clientAs } = fakeClients(async (request) => {
      await service.state.suspend(request.json as BackgroundRecord);
      return { status: 200, headers: {}, body: { suspended: true, since: NOW } };
    });
    const remote = remoteBackgroundState({ db: service.table.db(), clock: fixedClock(LATER), clientAs });

    await expect(remote.suspend(RECORD)).resolves.toEqual({ ...RECORD, since: NOW });
    expect(calls).toEqual([
      {
        caller: 'operator',
        request: { service: 'migration', method: 'POST', path: '/internal/v1/background:suspend', json: RECORD, userToken: null },
      },
    ]);
  });

  it('posts resume once without a body', async () => {
    const service = localState(new StateTable(), LATER);
    const { calls, clientAs } = fakeClients(async () => {
      await service.state.resume();
      return { status: 200, headers: {}, body: { suspended: false } };
    });
    const remote = remoteBackgroundState({ db: service.table.db(), clock: fixedClock(LATER), clientAs });

    await expect(remote.resume()).resolves.toEqual({ ...defaultBackgroundRecord(), resumedAt: LATER });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toMatchObject({ method: 'POST', path: '/internal/v1/background:resume', json: undefined });
  });

  it('reads through the database without calling the service', async () => {
    const service = localState();
    const { calls, clientAs } = fakeClients(() => ({ status: 500, headers: {}, body: undefined }));
    const remote = remoteBackgroundState({ db: service.table.db(), clock: fixedClock(NOW), clientAs });

    await expect(remote.isSuspended()).resolves.toBe(false);
    await expect(remote.get()).resolves.toEqual(defaultBackgroundRecord());
    expect(calls).toEqual([]);
  });

  it.each([
    ['suspend', 403, { error: { message: 'Insufficient permissions' } }, 'Migration backgroundSuspend answered HTTP 403: Insufficient permissions'],
    ['resume', 500, undefined, 'Migration backgroundResume answered HTTP 500'],
  ] as const)('throws BackgroundCallError when %s answers %i', async (operation, status, body, message) => {
    const service = localState();
    const { clientAs } = fakeClients(() => ({ status, headers: {}, body }));
    const remote = remoteBackgroundState({ db: service.table.db(), clock: fixedClock(NOW), clientAs });

    const error = await (operation === 'suspend' ? remote.suspend(RECORD) : remote.resume()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackgroundCallError);
    expect(error).toMatchObject({ status, body, message });
    expect(service.table.rows.has(BACKGROUND_KEY)).toBe(false);
  });
});
