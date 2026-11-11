// Unit tests for the scheduler hand-off records in migration.scheduler_state: key ownership, schemas, locking and updates.
import { createHash } from 'node:crypto';

import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  SCHEDULER_KEYS,
  SCHEDULER_STATE_TABLE,
  SURVEY_TASK_PREFIX,
  SchedulerStateConflictError,
  SchedulerStateError,
  defaultSiteMonitorRecord,
  defaultSurveyTasksRecord,
  isSiteMonitorTask,
  isSurveyTask,
  readSchedulerKey,
  readSchedulerState,
  siteMonitorRecordSchema,
  surveyTasksRecordSchema,
  updateSchedulerKey,
  writeSchedulerKey,
  type NativeTask,
  type NativeTasksRecord,
  type SchedulerKey,
  type SiteMonitorRecord,
  type SurveyTasksRecord,
} from '../../src/scheduler/state.js';

const T1 = new Date('2026-06-30T12:00:00.000Z');
const T2 = new Date('2026-06-30T12:05:00.000Z');
const T3 = new Date('2026-06-30T12:10:00.000Z');
const T4 = new Date('2026-06-30T12:15:00.000Z');

const MONITOR: NativeTask = {
  task: '/var/www/index.cfm/_api/sitemonitor/',
  group: 'default',
  url: 'http://localhost:8080/index.cfm/_api/sitemonitor/',
  port: '8080',
  interval: '900',
  startDate: '06/30/2026',
  startTime: '00:15:00',
  requestTimeOut: '600',
  operation: 'HTTPRequest',
  paused: false,
};

const SURVEY_LAUNCH: NativeTask = {
  ...MONITOR,
  task: 'opt2-survey-41-launch',
  url: 'http://localhost:20000/surveys/41/launch',
  interval: 'once',
  startTime: '09:00:00',
};

const CAPTURE: NativeTasksRecord = {
  capturedAt: '2026-06-30 11:00:00',
  originalPing: false,
  siteMonitorTask: MONITOR.task,
  tasks: [MONITOR, SURVEY_LAUNCH],
  sourceSha256: createHash('sha256').update('native-tasks').digest('hex'),
  importedAt: T1.toISOString(),
};

interface Statement {
  sql: string;
  values: unknown[];
}

/** In-memory migration.scheduler_state with jsonb round-trips and rollback on a thrown error. */
class SchedulerTable {
  rows = new Map<string, unknown>();
  readonly statements: Statement[] = [];
  transactions = 0;

  seed(key: string, value: unknown): void {
    this.rows.set(key, structuredClone(value));
  }

  stored(key: string): unknown {
    return this.rows.get(key);
  }

  writes(): Statement[] {
    return this.statements.filter((statement) => statement.sql.startsWith('INSERT'));
  }

  db(): TenantDb {
    return {
      schema: 'migration',
      withTenant: () => Promise.reject(new Error('scheduler state never runs in a tenant transaction')),
      withMetadata: async <T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> => {
        this.transactions += 1;
        const before = new Map(this.rows);
        try {
          return await fn(this.tx());
        } catch (error) {
          this.rows = before;
          throw error;
        }
      },
      end: () => Promise.resolve(),
    };
  }

  tx(): MetadataTx {
    return {
      schema: 'migration',
      kind: 'metadata',
      onCommit: () => undefined,
      query: (text: unknown, values?: unknown[]) => Promise.resolve().then(() => this.run(String(text), values ?? [])),
    } as unknown as MetadataTx;
  }

  private run(sql: string, values: unknown[]): QueryResult {
    this.statements.push({ sql, values });
    const [first] = values;
    if (sql === `SELECT key, value FROM ${SCHEDULER_STATE_TABLE} WHERE key = ANY($1::text[])`) {
      const keys = first as string[];
      return result([...this.rows].filter(([key]) => keys.includes(key)).map(([key, value]) => ({ key, value: structuredClone(value) })));
    }
    if (
      sql === `SELECT value FROM ${SCHEDULER_STATE_TABLE} WHERE key = $1` ||
      sql === `SELECT value FROM ${SCHEDULER_STATE_TABLE} WHERE key = $1 FOR UPDATE`
    ) {
      const key = first as string;
      return result(this.rows.has(key) ? [{ value: structuredClone(this.rows.get(key)) }] : []);
    }
    if (sql === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))') {
      return result([{ pg_advisory_xact_lock: '' }]);
    }
    if (
      sql ===
      `INSERT INTO ${SCHEDULER_STATE_TABLE} (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ` +
        'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at'
    ) {
      const [key, json] = values as [string, string];
      this.rows.set(key, JSON.parse(json));
      return result([], 1);
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

function result(rows: QueryResultRow[], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

function siteMonitor(overrides: Partial<SiteMonitorRecord> = {}): SiteMonitorRecord {
  return { ...defaultSiteMonitorRecord(T1), nativeExisted: true, originalPing: true, definition: MONITOR, ...overrides };
}

describe('scheduler state keys', () => {
  it('owns the sitemonitor, nativeTasks and surveyTasks rows of migration.scheduler_state', () => {
    expect(SCHEDULER_STATE_TABLE).toBe('migration.scheduler_state');
    expect(SCHEDULER_KEYS).toEqual({ siteMonitor: 'sitemonitor', nativeTasks: 'nativeTasks', surveyTasks: 'surveyTasks' });
    expect(SURVEY_TASK_PREFIX).toBe('opt2-survey-');
  });
});

describe('isSiteMonitorTask', () => {
  it.each([
    ['the Lucee task name', { task: 'siteMonitor', url: 'http://localhost:8080/' }, undefined, true],
    ['the task name in any case', { task: 'SITEMONITOR', url: 'http://localhost:8080/' }, null, true],
    ['the ACF task name', { task: '/var/www/index.cfm/_api/sitemonitor/', url: 'http://localhost:8080/' }, undefined, true],
    ['a request to /_api/sitemonitor', { task: 'nightly', url: 'http://localhost:8080/_api/sitemonitor' }, undefined, true],
    ['a request to /_api/sitemonitor/ with a query', { task: 'nightly', url: 'http://gw/_api/sitemonitor/?siteid=default' }, null, true],
    ['the name scheduler.describe reports', { task: 'Masa monitor', url: 'http://localhost:8080/' }, 'Masa monitor', true],
    ['a longer path segment', { task: 'nightly', url: 'http://localhost:8080/_api/sitemonitors' }, undefined, false],
    ['an empty describe name', { task: '', url: 'http://localhost:8080/' }, '', false],
    ['a survey task', { task: 'opt2-survey-41-launch', url: SURVEY_LAUNCH.url }, MONITOR.task, false],
  ])('classifies %s, %j named %j, as the monitor: %s', (_case, task, name, expected) => {
    expect(isSiteMonitorTask(task, name)).toBe(expected);
  });
});

describe('isSurveyTask', () => {
  it.each([
    ['opt2-survey-41-launch', true],
    ['opt2-survey-41-reminder-1', true],
    ['opt2-surveys', false],
    ['OPT2-SURVEY-41-launch', false],
    ['siteMonitor', false],
  ])('classifies %s as a survey task: %s', (task, expected) => {
    expect(isSurveyTask({ task })).toBe(expected);
  });
});

describe('default records', () => {
  it('starts the site monitor on legacy with no captured native task', () => {
    const record = defaultSiteMonitorRecord(T1);

    expect(record).toEqual({
      nativeExisted: false,
      originalPing: null,
      definition: null,
      state: 'legacy',
      nativePaused: null,
      targetTriggerDisabled: false,
      updatedAt: '2026-06-30T12:00:00.000Z',
    });
    expect(siteMonitorRecordSchema.parse(record)).toEqual(record);
  });

  it('starts the survey tasks on legacy, unpaused and unadopted', () => {
    const record = defaultSurveyTasksRecord(T2);

    expect(record).toEqual({ state: 'legacy', definitions: [], paused: null, adoptedNames: [], updatedAt: T2.toISOString() });
    expect(surveyTasksRecordSchema.parse(record)).toEqual(record);
  });
});

describe('readSchedulerKey', () => {
  it('returns null for an absent row', async () => {
    const table = new SchedulerTable();

    expect(await readSchedulerKey(table.db(), 'nativeTasks')).toBeNull();
  });

  it('returns the stored record', async () => {
    const table = new SchedulerTable();
    table.seed('nativeTasks', CAPTURE);

    expect(await readSchedulerKey(table.db(), 'nativeTasks')).toEqual(CAPTURE);
    expect(table.statements).toEqual([{ sql: `SELECT value FROM ${SCHEDULER_STATE_TABLE} WHERE key = $1`, values: ['nativeTasks'] }]);
  });

  it('throws SchedulerStateError naming the key when the stored record fails its schema', async () => {
    const table = new SchedulerTable();
    table.seed('sitemonitor', { ...siteMonitor(), state: 'handed-off' });

    const error = await readSchedulerKey(table.db(), 'sitemonitor').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SchedulerStateError);
    expect(error).toMatchObject({ name: 'SchedulerStateError', key: 'sitemonitor' });
    expect((error as SchedulerStateError).message).toMatch(/^The stored sitemonitor scheduler state fails its schema: /);
    expect((error as SchedulerStateError).message).toContain('state');
    expect((error as SchedulerStateError).cause).toBeDefined();
  });

  it('refuses a key it does not own before any statement runs', async () => {
    const table = new SchedulerTable();
    table.seed('background', { paused: true });

    await expect(readSchedulerKey(table.db(), 'background' as string as SchedulerKey)).rejects.toThrow(
      new TypeError('background is not a scheduler state key'),
    );
    expect(table.transactions).toBe(0);
  });
});

describe('readSchedulerState', () => {
  it('substitutes defaults stamped with now for absent rows and null for an absent capture', async () => {
    const table = new SchedulerTable();

    expect(await readSchedulerState(table.db(), T3)).toEqual({
      sitemonitor: defaultSiteMonitorRecord(T3),
      nativeTasks: null,
      surveyTasks: defaultSurveyTasksRecord(T3),
    });
  });

  it('reads only its own keys in one transaction and ignores the quiesce module background row', async () => {
    const table = new SchedulerTable();
    const monitor = siteMonitor({ nativePaused: 'suspend' });
    table.seed('sitemonitor', monitor);
    table.seed('nativeTasks', CAPTURE);
    table.seed('background', { anything: 'goes' });

    const state = await readSchedulerState(table.db(), T3);

    expect(state).toEqual({ sitemonitor: monitor, nativeTasks: CAPTURE, surveyTasks: defaultSurveyTasksRecord(T3) });
    expect(table.transactions).toBe(1);
    expect(table.statements).toEqual([
      {
        sql: `SELECT key, value FROM ${SCHEDULER_STATE_TABLE} WHERE key = ANY($1::text[])`,
        values: [['sitemonitor', 'nativeTasks', 'surveyTasks']],
      },
    ]);
  });

  it('throws SchedulerStateError when a stored record fails its schema', async () => {
    const table = new SchedulerTable();
    table.seed('surveyTasks', { ...defaultSurveyTasksRecord(T1), state: 'paused' });

    await expect(readSchedulerState(table.db(), T3)).rejects.toMatchObject({ name: 'SchedulerStateError', key: 'surveyTasks' });
  });
});

describe('writeSchedulerKey', () => {
  it('upserts the validated record as jsonb and returns it as stored', async () => {
    const table = new SchedulerTable();
    const withExtra = { ...CAPTURE, note: 'not part of the record' } as NativeTasksRecord;

    const stored = await table.db().withMetadata((tx) => writeSchedulerKey(tx, 'nativeTasks', withExtra));

    expect(stored).toEqual(CAPTURE);
    expect(table.stored('nativeTasks')).toEqual(CAPTURE);
    expect(table.writes()).toEqual([
      {
        sql:
          `INSERT INTO ${SCHEDULER_STATE_TABLE} (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ` +
          'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at',
        values: ['nativeTasks', JSON.stringify(CAPTURE)],
      },
    ]);
  });

  it.each<[string, SchedulerKey, unknown]>([
    ['a site-monitor state outside legacy and target', 'sitemonitor', { ...siteMonitor(), state: 'handed-off' }],
    ['a pause reason other than transition or suspend', 'sitemonitor', { ...siteMonitor(), nativePaused: 'operator' }],
    ['an updatedAt without a UTC offset', 'sitemonitor', { ...siteMonitor(), updatedAt: '2026-06-30 12:00:00' }],
    ['a definition without a task name', 'sitemonitor', { ...siteMonitor(), definition: { ...MONITOR, task: '' } }],
    ['an upper-case capture hash', 'nativeTasks', { ...CAPTURE, sourceSha256: CAPTURE.sourceSha256.toUpperCase() }],
    ['a capture without its capture time', 'nativeTasks', { ...CAPTURE, capturedAt: '' }],
    ['a survey state outside legacy and adopted', 'surveyTasks', { ...defaultSurveyTasksRecord(T1), state: 'paused' }],
    ['a non-string adopted task name', 'surveyTasks', { ...defaultSurveyTasksRecord(T1), adoptedNames: [41] }],
  ])('refuses %s before any statement runs', async (_case, key, value) => {
    const table = new SchedulerTable();

    const error = await table
      .db()
      .withMetadata((tx) => writeSchedulerKey(tx, key, value as never))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SchedulerStateError);
    expect((error as SchedulerStateError).key).toBe(key);
    expect((error as SchedulerStateError).message).toMatch(new RegExp(`^The new ${key} scheduler state fails its schema: `));
    expect(table.statements).toEqual([]);
    expect(table.rows.size).toBe(0);
  });
});

describe('updateSchedulerKey', () => {
  it('takes the key advisory lock, then reads the row for update, before writing', async () => {
    const table = new SchedulerTable();

    await updateSchedulerKey(table.db(), 'sitemonitor', (current) => ({ ...current, nativeExisted: true }), T2);

    expect(table.transactions).toBe(1);
    expect(table.statements.map(({ sql, values }) => [sql.split(' ')[0], sql.endsWith('FOR UPDATE'), values[0]])).toEqual([
      ['SELECT', false, 'migration.scheduler_state:sitemonitor'],
      ['SELECT', true, 'sitemonitor'],
      ['INSERT', false, 'sitemonitor'],
    ]);
    expect(table.statements[0]?.sql).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  });

  it('passes the default to the first update of a stamped key and stamps updatedAt from now', async () => {
    const table = new SchedulerTable();
    const fn = vi.fn((current: SiteMonitorRecord) => ({ ...current, nativeExisted: true, definition: MONITOR, updatedAt: '2000-01-01T00:00:00.000Z' }));

    const stored = await updateSchedulerKey(table.db(), 'sitemonitor', fn, T2);

    expect(fn).toHaveBeenCalledWith(defaultSiteMonitorRecord(T2));
    expect(stored).toEqual({ ...defaultSiteMonitorRecord(T2), nativeExisted: true, definition: MONITOR, updatedAt: T2.toISOString() });
    expect(table.stored('sitemonitor')).toEqual(stored);
  });

  it('passes null for an absent capture and stores the capture unstamped', async () => {
    const table = new SchedulerTable();
    const fn = vi.fn((current: NativeTasksRecord | null) => current ?? CAPTURE);

    const stored = await updateSchedulerKey(table.db(), 'nativeTasks', fn, T3);

    expect(fn).toHaveBeenCalledWith(null);
    expect(stored).toEqual(CAPTURE);
    expect(table.stored('nativeTasks')).toEqual(CAPTURE);
    expect(table.stored('nativeTasks')).not.toHaveProperty('updatedAt');
  });

  it('leaves the row untouched when fn returns current', async () => {
    const table = new SchedulerTable();
    const monitor = siteMonitor({ state: 'target', handedOffAt: T1.toISOString() });
    table.seed('sitemonitor', monitor);

    const returned = await updateSchedulerKey(table.db(), 'sitemonitor', (current) => current, T4);

    expect(returned).toEqual(monitor);
    expect(table.writes()).toEqual([]);
    expect(table.stored('sitemonitor')).toEqual(monitor);
  });

  it('aborts without writing when fn refuses the update with SchedulerStateConflictError', async () => {
    const table = new SchedulerTable();
    const monitor = siteMonitor({ state: 'target' });
    table.seed('sitemonitor', monitor);
    const refusal = new SchedulerStateConflictError('sitemonitor', 'the monitor is already on target');

    await expect(
      updateSchedulerKey(
        table.db(),
        'sitemonitor',
        (current) => {
          if (current.state === 'target') throw refusal;
          return { ...current, state: 'target' };
        },
        T4,
      ),
    ).rejects.toBe(refusal);

    expect(refusal).toMatchObject({
      name: 'SchedulerStateConflictError',
      key: 'sitemonitor',
      reason: 'the monitor is already on target',
      message: 'Scheduler state sitemonitor conflict: the monitor is already on target',
    });
    expect(table.writes()).toEqual([]);
    expect(table.stored('sitemonitor')).toEqual(monitor);
  });

  it('refuses a stored record that fails its schema without calling fn', async () => {
    const table = new SchedulerTable();
    table.seed('sitemonitor', { ...siteMonitor(), targetTriggerDisabled: 'yes' });
    const fn = vi.fn((current: SiteMonitorRecord) => current);

    await expect(updateSchedulerKey(table.db(), 'sitemonitor', fn, T2)).rejects.toThrow(
      /^The stored sitemonitor scheduler state fails its schema: /,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a result that fails its schema and writes nothing', async () => {
    const table = new SchedulerTable();
    table.seed('surveyTasks', defaultSurveyTasksRecord(T1));

    await expect(
      updateSchedulerKey(table.db(), 'surveyTasks', (current) => ({ ...current, paused: 'operator' as never }), T2),
    ).rejects.toMatchObject({ name: 'SchedulerStateError', key: 'surveyTasks' });

    expect(table.writes()).toEqual([]);
    expect(table.stored('surveyTasks')).toEqual(defaultSurveyTasksRecord(T1));
  });

  it('refuses a key it does not own before opening a transaction', async () => {
    const table = new SchedulerTable();
    const fn = vi.fn();

    await expect(updateSchedulerKey(table.db(), 'background' as string as SchedulerKey, fn, T2)).rejects.toThrow(
      new TypeError('background is not a scheduler state key'),
    );
    expect(table.transactions).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('records the site-monitor hand-off from capture through pause and target to restoration', async () => {
    const table = new SchedulerTable();
    const db = table.db();

    await updateSchedulerKey(db, 'sitemonitor', (current) => ({ ...current, nativeExisted: true, originalPing: 'true', definition: MONITOR }), T1);
    await updateSchedulerKey(db, 'sitemonitor', (current) => ({ ...current, nativePaused: 'transition' }), T2);
    await updateSchedulerKey(
      db,
      'sitemonitor',
      (current) => ({ ...current, state: 'target', nativePaused: null, cursorHandedOff: '2026-06-30 12:09:58', handedOffAt: T3.toISOString() }),
      T3,
    );
    expect(await readSchedulerKey(db, 'sitemonitor')).toEqual({
      nativeExisted: true,
      originalPing: 'true',
      definition: MONITOR,
      cursorHandedOff: '2026-06-30 12:09:58',
      state: 'target',
      nativePaused: null,
      targetTriggerDisabled: false,
      handedOffAt: T3.toISOString(),
      updatedAt: T3.toISOString(),
    });

    await updateSchedulerKey(db, 'sitemonitor', (current) => ({ ...current, state: 'legacy', targetTriggerDisabled: true }), T4);

    expect((await readSchedulerState(db, T4)).sitemonitor).toMatchObject({
      state: 'legacy',
      targetTriggerDisabled: true,
      handedOffAt: T3.toISOString(),
      updatedAt: T4.toISOString(),
    });
  });

  it('records the survey task pause with each definition as it was, then their adoption', async () => {
    const table = new SchedulerTable();
    const db = table.db();
    const reminder: NativeTask = { ...SURVEY_LAUNCH, task: 'opt2-survey-41-reminder-1', paused: true };

    await updateSchedulerKey(db, 'surveyTasks', (current) => ({ ...current, definitions: [SURVEY_LAUNCH, reminder], paused: 'transition' }), T2);
    const adopted = await updateSchedulerKey(
      db,
      'surveyTasks',
      (current): SurveyTasksRecord => ({
        ...current,
        state: 'adopted',
        paused: null,
        adoptedNames: current.definitions.map((definition) => definition.task),
        adoptedAt: T3.toISOString(),
      }),
      T3,
    );

    expect(adopted).toEqual({
      state: 'adopted',
      definitions: [SURVEY_LAUNCH, reminder],
      paused: null,
      adoptedNames: ['opt2-survey-41-launch', 'opt2-survey-41-reminder-1'],
      adoptedAt: T3.toISOString(),
      updatedAt: T3.toISOString(),
    });
    expect((await readSchedulerState(db, T4)).surveyTasks).toEqual(adopted);
  });
});
