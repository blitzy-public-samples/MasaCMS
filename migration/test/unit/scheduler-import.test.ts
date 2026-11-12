// Unit tests for the import of the native ColdFusion scheduler capture into migration.scheduler_state.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { fixedClock } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MigrationContext } from '../../src/context.js';
import {
  NATIVE_TASKS_FILE_NAME,
  SchedulerImportError,
  defaultNativeTasksFile,
  importNativeTasks,
  importSchedulerRequest,
  importSchedulerState,
  nativeTasksDigest,
  normaliseNativeTasksFile,
  type NativeTasksFile,
} from '../../src/scheduler/import.js';
import {
  SchedulerStateConflictError,
  defaultSiteMonitorRecord,
  type NativeTask,
  type SchedulerRecordMap,
  type SiteMonitorRecord,
} from '../../src/scheduler/state.js';

const T1 = new Date('2026-06-30T12:00:00.000Z');
const T2 = new Date('2026-06-30T12:05:00.000Z');
const CAPTURED_AT = '2026-06-30T11:00:00Z';
const MONITOR_NAME = '/var/www/index.cfm/_api/sitemonitor/';

const MONITOR: NativeTask = {
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

const SURVEY: NativeTask = {
  ...MONITOR,
  task: 'opt2-survey-41-launch',
  url: 'http://localhost:20000/surveys/41/launch',
  interval: 'once',
  startTime: '09:00:00',
  paused: true,
};

const CAPTURE: NativeTasksFile = {
  capturedAt: CAPTURED_AT,
  originalPing: true,
  siteMonitorTask: MONITOR_NAME,
  tasks: [SURVEY, MONITOR],
};

/** The CAPTURE tasks as `box cfconfig export` writes them: keyed by name, `URL`, `httpPort`, `status`, no operation. */
function cfconfigTask(task: NativeTask): Record<string, unknown> {
  return {
    task: task.task,
    group: task.group,
    URL: task.url,
    httpPort: Number(task.port),
    interval: task.interval === 'once' ? task.interval : Number(task.interval),
    startDate: task.startDate,
    startTime: task.startTime,
    requestTimeOut: Number(task.requestTimeOut),
    status: task.paused ? 'Paused' : 'Running',
    username: 'scheduler',
    password: 'not-stored',
  };
}

const CFCONFIG_CAPTURE = {
  capturedAt: CAPTURED_AT,
  ping: true,
  siteMonitorTask: MONITOR_NAME,
  scheduledTasks: Object.fromEntries([MONITOR, SURVEY].map((task) => [task.task, cfconfigTask(task)])),
};

/** In-memory migration.scheduler_state for the statements state.ts issues, rolled back when a transaction throws. */
class SchedulerTable {
  rows = new Map<string, unknown>();
  inserts = 0;

  seed(key: string, value: unknown): void {
    this.rows.set(key, structuredClone(value));
  }

  stored<K extends keyof SchedulerRecordMap>(key: K): SchedulerRecordMap[K] {
    return this.rows.get(key) as SchedulerRecordMap[K];
  }

  db(): TenantDb {
    return {
      schema: 'migration',
      withTenant: () => Promise.reject(new Error('scheduler state never runs in a tenant transaction')),
      withMetadata: async <T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> => {
        const before = new Map(this.rows);
        const insertsBefore = this.inserts;
        try {
          return await fn(this.tx());
        } catch (error) {
          this.rows = before;
          this.inserts = insertsBefore;
          throw error;
        }
      },
      end: () => Promise.resolve(),
    };
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
    const [key, json] = values as [string, string];
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) return result([]);
    if (sql.startsWith('SELECT value FROM migration.scheduler_state WHERE key = $1')) {
      return result(this.rows.has(key) ? [{ value: structuredClone(this.rows.get(key)) }] : []);
    }
    if (sql.startsWith('INSERT INTO migration.scheduler_state')) {
      this.inserts += 1;
      this.rows.set(key, JSON.parse(json));
      return result([], 1);
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

function result(rows: QueryResultRow[], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

function deps(table: SchedulerTable, at = T1) {
  return { db: table.db(), clock: fixedClock(at) };
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'scheduler-import-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeCapture(name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf8');
  return file;
}

describe('defaultNativeTasksFile', () => {
  it('names native-tasks.json in OPT2_PRISTINE_DIR', () => {
    expect(NATIVE_TASKS_FILE_NAME).toBe('native-tasks.json');
    expect(defaultNativeTasksFile({ OPT2_PRISTINE_DIR: '/srv/pristine' })).toBe('/srv/pristine/native-tasks.json');
  });

  it('falls back to $HOME/.opt2/pristine when OPT2_PRISTINE_DIR is unset', () => {
    expect(defaultNativeTasksFile({ OPT2_PRISTINE_DIR: undefined })).toBe(path.join(homedir(), '.opt2', 'pristine', 'native-tasks.json'));
  });
});

describe('normaliseNativeTasksFile', () => {
  it('sorts the tasks of a native-tasks.json document by name', () => {
    expect(normaliseNativeTasksFile(CAPTURE)).toEqual({ ...CAPTURE, tasks: [MONITOR, SURVEY] });
  });

  it('maps a box cfconfig export keyed by name, with status Paused, to the same capture and digest', () => {
    const normalised = normaliseNativeTasksFile(CFCONFIG_CAPTURE);
    expect(normalised).toEqual(normaliseNativeTasksFile(CAPTURE));
    expect(normalised.tasks.find((task) => task.task === SURVEY.task)?.paused).toBe(true);
    expect(JSON.stringify(normalised)).not.toContain('not-stored');
    expect(nativeTasksDigest(normalised)).toBe(nativeTasksDigest(normaliseNativeTasksFile(CAPTURE)));
  });

  it('maps a box cfconfig export array, with wire field names and defaults, to the wire shape', () => {
    const normalised = normaliseNativeTasksFile({
      capturedAt: CAPTURED_AT,
      scheduledTasks: [{ task: 'nightly', url: 'http://localhost:8080/nightly.cfm', port: '8080', paused: true }],
    });
    expect(normalised).toEqual({
      capturedAt: CAPTURED_AT,
      originalPing: null,
      siteMonitorTask: null,
      tasks: [
        {
          task: 'nightly',
          group: '',
          url: 'http://localhost:8080/nightly.cfm',
          port: '8080',
          interval: '',
          startDate: '',
          startTime: '',
          requestTimeOut: '',
          operation: 'HTTPRequest',
          paused: true,
        },
      ],
    });
  });

  it.each([
    ['an array', [CAPTURE], 'must be a JSON object'],
    ['a document without tasks', { capturedAt: CAPTURED_AT, ping: false }, 'has neither a tasks array nor scheduledTasks'],
    ['a cfconfig export without a capture time', { ping: true, scheduledTasks: CFCONFIG_CAPTURE.scheduledTasks }, 'capturedAt'],
    ['the HTTP request body, which is not a file form', { nativeTasks: [cfconfigTask(MONITOR)], ping: true }, 'has neither'],
    ['a capture time that is not a date-time', { ...CAPTURE, capturedAt: 'yesterday' }, 'capturedAt'],
    ['a task without a name', { ...CAPTURE, tasks: [{ ...MONITOR, task: '' }] }, 'tasks'],
    ['a task record that is not an object', { capturedAt: CAPTURED_AT, scheduledTasks: ['siteMonitor'] }, 'tasks'],
    ['scheduledTasks that is neither array nor object', { capturedAt: CAPTURED_AT, scheduledTasks: 'none' }, 'tasks'],
  ])('rejects %s with SchedulerImportError', (_case, raw, problem) => {
    expect(() => normaliseNativeTasksFile(raw)).toThrow(SchedulerImportError);
    expect(() => normaliseNativeTasksFile(raw)).toThrow(problem);
  });
});

describe('nativeTasksDigest', () => {
  it('is lowercase hex SHA-256, independent of key order and capture time, and changes with any task field', () => {
    const digest = nativeTasksDigest(normaliseNativeTasksFile(CAPTURE));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const reordered = { tasks: [SURVEY, MONITOR], siteMonitorTask: MONITOR_NAME, originalPing: true, capturedAt: '2026-07-01T00:00:00Z' };
    expect(nativeTasksDigest(normaliseNativeTasksFile(reordered))).toBe(digest);
    const changed = { ...CAPTURE, tasks: [SURVEY, { ...MONITOR, interval: '600' }] };
    expect(nativeTasksDigest(normaliseNativeTasksFile(changed))).not.toBe(digest);
  });
});

describe('importNativeTasks', () => {
  it('stores the capture and the monitor definition, keeping the hand-off flags and the survey record', async () => {
    const table = new SchedulerTable();
    const current: SiteMonitorRecord = { ...defaultSiteMonitorRecord(T1), nativePaused: 'suspend', targetTriggerDisabled: true };
    const surveys = { state: 'legacy', definitions: [], paused: null, adoptedNames: [], updatedAt: T1.toISOString() };
    table.seed('sitemonitor', current);
    table.seed('surveyTasks', surveys);

    const outcome = await importNativeTasks(deps(table, T2), CAPTURE);
    const sourceSha256 = nativeTasksDigest(normaliseNativeTasksFile(CAPTURE));
    expect(outcome).toEqual({ imported: true, reason: 'imported', nativeExisted: true, siteMonitorTask: MONITOR_NAME, taskCount: 2, sourceSha256 });
    expect(table.stored('nativeTasks')).toEqual({
      capturedAt: CAPTURED_AT,
      originalPing: true,
      siteMonitorTask: MONITOR_NAME,
      tasks: [MONITOR, SURVEY],
      sourceSha256,
      importedAt: T2.toISOString(),
    });
    expect(table.stored('sitemonitor')).toEqual({
      ...current,
      nativeExisted: true,
      originalPing: true,
      definition: MONITOR,
      state: 'legacy',
      updatedAt: T2.toISOString(),
    });
    expect(table.stored('surveyTasks')).toEqual(surveys);
  });

  it('records a capture without the monitor task, as ping=false leaves it, as nativeExisted false', async () => {
    const table = new SchedulerTable();
    const outcome = await importNativeTasks(deps(table), { capturedAt: CAPTURED_AT, originalPing: false, tasks: [SURVEY] });
    expect(outcome).toMatchObject({ imported: true, reason: 'imported', nativeExisted: false, siteMonitorTask: null, taskCount: 1 });
    expect(table.stored('sitemonitor')).toMatchObject({
      nativeExisted: false,
      originalPing: false,
      definition: null,
      state: 'legacy',
    });
  });

  it('finds a monitor task by the name the capture reports', async () => {
    const table = new SchedulerTable();
    const custom = { ...MONITOR, task: 'Masa monitor', url: 'http://localhost:8080/monitor.cfm' };
    const outcome = await importNativeTasks(deps(table), { ...CAPTURE, siteMonitorTask: 'Masa monitor', tasks: [custom] });
    expect(outcome).toMatchObject({ nativeExisted: true, siteMonitorTask: 'Masa monitor' });
    expect(table.stored('sitemonitor').definition).toEqual(custom);
  });

  it('replaces a different capture before the hand-off', async () => {
    const table = new SchedulerTable();
    await importNativeTasks(deps(table), CAPTURE);
    const outcome = await importNativeTasks(deps(table, T2), { ...CAPTURE, originalPing: false, tasks: [SURVEY] });
    expect(outcome).toMatchObject({ imported: true, reason: 'replaced', nativeExisted: false, taskCount: 1 });
    expect(table.stored('nativeTasks').importedAt).toBe(T2.toISOString());
    expect(table.stored('sitemonitor')).toMatchObject({ nativeExisted: false, definition: null });
  });

  it('refuses a different capture after the monitor was handed off, writing nothing', async () => {
    const table = new SchedulerTable();
    await importNativeTasks(deps(table), CAPTURE);
    const handedOff = { ...table.stored('sitemonitor'), state: 'target', handedOffAt: T1.toISOString() };
    table.seed('sitemonitor', handedOff);
    const capture = structuredClone(table.stored('nativeTasks'));
    const inserts = table.inserts;

    await expect(importNativeTasks(deps(table, T2), { ...CAPTURE, tasks: [MONITOR] })).rejects.toThrow(SchedulerStateConflictError);
    expect(table.stored('nativeTasks')).toEqual(capture);
    expect(table.stored('sitemonitor')).toEqual(handedOff);
    expect(table.inserts).toBe(inserts);
    await expect(importNativeTasks(deps(table, T2), CFCONFIG_CAPTURE)).resolves.toMatchObject({ reason: 'unchanged' });
  });
});

describe('importSchedulerRequest', () => {
  it.each([true, null])('stores a body with ping %s at the import time, sorted, with the digest of the same file capture', async (ping) => {
    const table = new SchedulerTable();
    const body = { nativeTasks: Object.values(CFCONFIG_CAPTURE.scheduledTasks).reverse(), ping };

    const outcome = await importSchedulerRequest(deps(table, T2), body);
    const sourceSha256 = nativeTasksDigest(normaliseNativeTasksFile({ ...CAPTURE, originalPing: ping }));
    expect(outcome).toEqual({ imported: true, reason: 'imported', nativeExisted: true, siteMonitorTask: MONITOR_NAME, taskCount: 2, sourceSha256 });
    expect(table.stored('nativeTasks')).toEqual({
      capturedAt: T2.toISOString(),
      originalPing: ping,
      siteMonitorTask: MONITOR_NAME,
      tasks: [MONITOR, SURVEY],
      sourceSha256,
      importedAt: T2.toISOString(),
    });
    expect(JSON.stringify(table.rows.get('nativeTasks'))).not.toContain('not-stored');
  });

  it('rejects a task entry that fails the task schema with SchedulerImportError, writing nothing', async () => {
    const table = new SchedulerTable();
    const error = await importSchedulerRequest(deps(table), { nativeTasks: [{ URL: 'http://localhost/' }], ping: true }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SchedulerImportError);
    expect((error as SchedulerImportError).message).toContain('nativeTasks fail the task schema');
    expect(table.inserts).toBe(0);
  });

  it.each([
    ['before', {}],
    ['after', { state: 'target', handedOffAt: T1.toISOString() }],
  ] as const)('reports the body of a capture whose file names its monitor unchanged %s the hand-off', async (_when, handOff) => {
    const table = new SchedulerTable();
    const imported = await importNativeTasks(deps(table), CAPTURE);
    const monitor = { ...table.stored('sitemonitor'), ...handOff };
    table.seed('sitemonitor', monitor);
    const inserts = table.inserts;

    const body = { nativeTasks: Object.values(CFCONFIG_CAPTURE.scheduledTasks), ping: true };
    await expect(importSchedulerRequest(deps(table, T2), body)).resolves.toEqual({ ...imported, imported: false, reason: 'unchanged' });
    expect(table.inserts).toBe(inserts);
    expect(table.stored('sitemonitor')).toEqual(monitor);
  });
});

describe('importSchedulerState', () => {
  function context(table: SchedulerTable, at = T1) {
    const info = vi.fn();
    const ctx = { ...deps(table, at), logger: { info } as unknown as MigrationContext['logger'] };
    return { ctx, info };
  }

  it('imports a native-tasks.json file once and reports the second import unchanged', async () => {
    const file = await writeCapture('native-tasks.json', JSON.stringify(CAPTURE, null, 2));
    const table = new SchedulerTable();
    const first = context(table);

    const imported = await importSchedulerState(first.ctx, file);
    expect(imported).toMatchObject({ imported: true, reason: 'imported', nativeExisted: true, taskCount: 2 });
    expect(table.inserts).toBe(2);
    expect(first.info).toHaveBeenCalledTimes(1);
    expect(first.info.mock.calls[0]?.[0]).toContain(`${file} imported: 2 tasks, native site monitor ${MONITOR_NAME}`);

    const second = context(table, T2);
    const unchanged = await importSchedulerState(second.ctx, file);
    expect(unchanged).toEqual({ ...imported, imported: false, reason: 'unchanged' });
    expect(table.inserts).toBe(2);
    expect(table.stored('nativeTasks').importedAt).toBe(T1.toISOString());
    expect(second.info.mock.calls[0]?.[0]).toContain('unchanged');
  });

  it('logs an absent monitor for a capture without one', async () => {
    const file = await writeCapture('no-monitor.json', JSON.stringify({ ...CAPTURE, siteMonitorTask: null, tasks: [SURVEY] }));
    const { ctx, info } = context(new SchedulerTable());
    await importSchedulerState(ctx, file);
    expect(info.mock.calls[0]?.[0]).toContain('native site monitor absent');
  });

  it('raises SchedulerImportError naming the path of a file that is not JSON', async () => {
    const file = await writeCapture('broken.json', '{"tasks": [');
    const { ctx } = context(new SchedulerTable());
    await expect(importSchedulerState(ctx, file)).rejects.toThrow(SchedulerImportError);
    await expect(importSchedulerState(ctx, file)).rejects.toThrow(`${file} is not valid JSON`);
  });

  // Fixed and ten characters, so the whole value fits the excerpt V8 quotes around an unexpected token.
  const canary = ['canary', '7c1'].join('-');

  it.each([
    [
      'an unquoted task password',
      `{\n  "capturedAt": "${CAPTURED_AT}",\n  "scheduledTasks": {"siteMonitor": {"username": "scheduler", "password": ${canary}}}\n}`,
      '',
    ],
    [
      'a task URL with credentials followed by a trailing comma',
      [
        '{',
        `  "capturedAt": "${CAPTURED_AT}",`,
        '  "tasks": [{',
        '    "task": "siteMonitor",',
        `    "url": "http://scheduler:${canary}@localhost:8080/",`,
        '  }]',
        '}',
      ].join('\n'),
      ' at line 6 column 3',
    ],
    [
      'a capture truncated after a task password',
      `{"capturedAt": "${CAPTURED_AT}", "scheduledTasks": {"siteMonitor": {"username": "scheduler", "password": "${canary}", "URL":`,
      '',
    ],
  ])('raises SchedulerImportError for %s without quoting the capture', async (_case, content, location) => {
    const file = await writeCapture('credential-capture.json', content);
    const { ctx, info } = context(new SchedulerTable());

    const error = await importSchedulerState(ctx, file).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SchedulerImportError);
    const { message, stack, cause } = error as SchedulerImportError;
    expect(message).toBe(`${file} is not valid JSON${location}`);
    expect(cause).toBeUndefined();
    for (const text of [message, stack, String(error)]) expect(text).not.toContain(canary);
    expect(info).not.toHaveBeenCalled();
  });

  it('propagates the error of a missing file unchanged', async () => {
    const { ctx } = context(new SchedulerTable());
    await expect(importSchedulerState(ctx, path.join(dir, 'absent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
