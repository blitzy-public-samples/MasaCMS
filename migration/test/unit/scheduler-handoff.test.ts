// Unit tests for the scheduler hand-off of Masa's siteMonitor task.
import { SITEMONITOR_QUEUE } from '@opt2/platform/tasks';
import type { MetadataTx, QueryResult, QueryResultRow, TenantDb } from '@opt2/platform/tenancy';
import { describe, expect, it } from 'vitest';

import type {
  SchedulerDescription,
  SchedulerRestoreRequest,
  SchedulerSelection,
  ScheduledTaskDefinition,
} from '../../src/legacy/index.js';
import {
  SchedulerHandoffError,
  createSchedulerService,
  schedulerStateView,
  siteMonitorJobUnits,
  type SchedulerContext,
  type SchedulerScope,
  type SchedulerServiceOptions,
} from '../../src/scheduler/handoff.js';
import { defaultSiteMonitorRecord, type SchedulerRecordMap, type SiteMonitorRecord } from '../../src/scheduler/state.js';

const NOW = new Date('2026-06-30T12:00:00.000Z');
const MONITOR_NAME = '/srv/www/index.cfm/_api/sitemonitor/';
const LEGACY_CURSOR = '2026-06-30T11:45:00.000';
const TARGET_CURSOR = '2026-06-30T13:00:00.000';
const QUEUE_PATH = `/internal/v1/task-queues/${SITEMONITOR_QUEUE}`;
const MONITOR_UNIT = 'programs_sites.sitemonitor_state';
const MOVES: SchedulerScope = { siteMonitorUnits: [MONITOR_UNIT], siteMonitorEntryMoves: true };
const STAYS: SchedulerScope = { siteMonitorUnits: [MONITOR_UNIT], siteMonitorEntryMoves: false };

const MONITOR: ScheduledTaskDefinition = {
  task: MONITOR_NAME,
  group: 'DEFAULT',
  url: 'http://localhost:8080/index.cfm/_api/sitemonitor/',
  port: '8080',
  interval: '900',
  startDate: '06/30/2026',
  startTime: '00:15:00',
  requestTimeOut: '600',
  operation: '',
  paused: false,
};

/** A task an operator scheduled beside the monitor, carrying a callback token the state view must not show. */
const OTHER: ScheduledTaskDefinition = {
  ...MONITOR,
  task: 'ops-link-check',
  url: 'http://127.0.0.1:20000/ops/link-check.cfm?siteid=tenant-a&opt2TaskToken=t0ken',
  interval: 'once',
  startDate: '07/01/2026',
  startTime: '09:15:00',
};

/** In-memory migration.scheduler_state for the statements state.ts issues, rolled back when a transaction throws. */
class SchedulerTable {
  rows = new Map<string, unknown>();

  stored<K extends keyof SchedulerRecordMap>(key: K): SchedulerRecordMap[K] {
    return this.rows.get(key) as SchedulerRecordMap[K];
  }

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

/** Doubles of the bridge, owners and service client sharing one call log, and a clock the injected sleep advances. */
function harness(tasks: ScheduledTaskDefinition[], monitor?: Partial<SiteMonitorRecord>) {
  const h = {
    calls: [] as string[],
    logs: [] as string[],
    table: new SchedulerTable(),
    live: structuredClone(tasks),
    legacyCursor: LEGACY_CURSOR as string | null,
    targetCursor: TARGET_CURSOR as string | null,
    restoreBodies: [] as SchedulerRestoreRequest[],
    ensureStatus: 200,
    failNext: null as string | null,
    nowMs: NOW.getTime(),
  };
  if (monitor !== undefined) h.table.rows.set('sitemonitor', { ...defaultSiteMonitorRecord(NOW), ...monitor });

  const op = (name: string, sel: SchedulerSelection) => {
    h.calls.push(`bridge.${name} ${JSON.stringify(sel)}`);
    if (h.failNext === name) {
      h.failNext = null;
      return Promise.reject(new Error(`bridge ${name} failed`));
    }
    const hit = h.live.filter((task) => sel.tasks?.includes(task.task) === true || (sel.prefix !== undefined && task.task.startsWith(sel.prefix)));
    // As scheduler.cfm: pause and resume leave an expired task as it is and name it in `expired`.
    const acted = name === 'delete' ? hit : hit.filter((task) => task.expired !== true);
    if (name === 'pause' || name === 'resume') acted.forEach((task) => (task.paused = name === 'pause'));
    if (name === 'delete') h.live = h.live.filter((task) => !hit.includes(task));
    const expired = name === 'delete' ? {} : { expired: hit.filter((task) => !acted.includes(task)).map((task) => task.task) };
    return Promise.resolve({ op: name, tasks: acted.map((task) => task.task), ...expired, serverTime: '' });
  };

  const bridge = {
    schedulerDescribe: (): Promise<SchedulerDescription> => {
      h.calls.push('bridge.describe');
      return Promise.resolve({ ping: false, siteMonitorTask: MONITOR_NAME, tasks: structuredClone(h.live), serverTime: '' });
    },
    schedulerPause: (sel: SchedulerSelection) => op('pause', sel),
    schedulerResume: (sel: SchedulerSelection) => op('resume', sel),
    schedulerDelete: (sel: SchedulerSelection) => op('delete', sel),
    schedulerRestore: (body: SchedulerRestoreRequest) => {
      h.calls.push(`bridge.restore ${JSON.stringify({ tasks: body.tasks.map((task) => task.task), repoint: body.repoint, paused: body.paused })}`);
      h.restoreBodies.push(structuredClone(body));
      // A definition captured expired is recreated expired, neither paused nor resumed.
      for (const task of body.tasks) {
        h.live = [...h.live.filter((other) => other.task !== task.task), { ...task, paused: task.expired === true ? false : body.paused }];
      }
      const expired = body.tasks.filter((task) => task.expired === true).map((task) => task.task);
      return Promise.resolve({ op: 'restore', tasks: body.tasks.map((task) => task.task), expired, serverTime: '' });
    },
    schedulerRepoint: (task: Partial<ScheduledTaskDefinition> = {}) => {
      h.calls.push(`bridge.repoint ${task.task ?? ''}`);
      return Promise.resolve({ op: 'repoint', tasks: [task.task ?? MONITOR_NAME], serverTime: '' });
    },
    getCursor: () => {
      h.calls.push('bridge.getCursor');
      return Promise.resolve({ job: 'getCursor', lastMonitored: h.legacyCursor, serverTime: '' });
    },
    jobsRun: (job: string, params: { value?: string } = {}) => {
      h.calls.push(`bridge.${job} ${params.value ?? ''}`);
      return Promise.resolve({ job, completed: true, serverTime: '' });
    },
  };

  const owners = {
    putSiteMonitorState: (input: { lastMonitored: string }) => {
      h.calls.push(`programs-sites.putSiteMonitorState ${input.lastMonitored}`);
      h.targetCursor = input.lastMonitored;
      return Promise.resolve({ lastMonitored: input.lastMonitored, updatedAt: null });
    },
    siteMonitorState: () => {
      h.calls.push('programs-sites.siteMonitorState');
      return Promise.resolve({ lastMonitored: h.targetCursor, updatedAt: null });
    },
  };

  const client = {
    request: (req: { service: string; path: string }) => {
      h.calls.push(`${req.service} POST ${req.path}`);
      const status = req.path.endsWith('/ensure') ? h.ensureStatus : 200;
      return Promise.resolve({ status, headers: {}, body: { queue: SITEMONITOR_QUEUE, service: req.service } });
    },
    close: () => Promise.resolve(),
  };

  const ctx = {
    env: { OPT2_SERVICE_URLS: { 'programs-sites': 'http://127.0.0.1:20013' } },
    db: h.table.db(),
    bridge,
    owners,
    client,
    clock: { now: () => new Date(h.nowMs) },
    logger: { info: (message: string) => h.logs.push(message) },
  } as unknown as SchedulerContext;

  const service = (options: SchedulerServiceOptions = {}) =>
    createSchedulerService(ctx, {
      sleep: (ms) => {
        h.nowMs += ms;
        return Promise.resolve();
      },
      ...options,
    });
  return { h, ctx, service };
}

const NATIVE: Partial<SiteMonitorRecord> = { nativeExisted: true, originalPing: true, definition: MONITOR };
const NO_NATIVE: Partial<SiteMonitorRecord> = { nativeExisted: false, originalPing: false, definition: null };

describe('siteMonitorJobUnits', () => {
  it('returns the sorted, de-duplicated units of job entries only', () => {
    const entries = [
      { kind: 'job', units: ['b.x', 'a.y'] },
      { kind: 'read', units: ['z.z'] },
      { kind: 'job', units: ['a.y'] },
    ];
    expect(siteMonitorJobUnits({ entries } as never)).toEqual(['a.y', 'b.x']);
  });
});

describe('site monitor hand-off', () => {
  it('pauses before the freeze, then deletes, seeds the cursor and ensures the chain after activation', async () => {
    const { h, service } = harness([MONITOR, OTHER], NATIVE);
    const svc = service();

    expect(await svc.pauseFor([MONITOR_UNIT], STAYS)).toEqual({ siteMonitor: [MONITOR_NAME] });
    expect(h.table.stored('sitemonitor').nativePaused).toBe('transition');
    h.calls.push('gateway.activate');

    expect(await svc.handOffSiteMonitorToTarget()).toEqual({ deletedTasks: [MONITOR_NAME], cursor: LEGACY_CURSOR, recurringEnabled: true });
    expect(h.calls.filter((call) => call !== 'bridge.describe')).toEqual([
      `bridge.pause {"tasks":["${MONITOR_NAME}"]}`,
      'gateway.activate',
      `bridge.pause {"tasks":["${MONITOR_NAME}"]}`,
      `bridge.delete {"tasks":["${MONITOR_NAME}"]}`,
      'bridge.getCursor',
      `programs-sites.putSiteMonitorState ${LEGACY_CURSOR}`,
      `programs-sites POST ${QUEUE_PATH}/ensure`,
    ]);
    expect(h.table.stored('sitemonitor')).toMatchObject({
      state: 'target',
      cursorHandedOff: LEGACY_CURSOR,
      nativePaused: null,
      targetTriggerDisabled: false,
      handedOffAt: NOW.toISOString(),
    });
    expect(h.logs).toContain(`scheduler hand-off delete site monitor: ${MONITOR_NAME}`);
  });

  it('answers a repeated hand-off without any call', async () => {
    const { h, service } = harness([MONITOR], NATIVE);
    const svc = service();
    await svc.handOffSiteMonitorToTarget();
    h.calls.length = 0;
    expect(await svc.handOffSiteMonitorToTarget()).toEqual({ deletedTasks: [], cursor: LEGACY_CURSOR, recurringEnabled: false });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['without a native task, a null legacy cursor seeds nothing', NO_NATIVE, undefined, null, []],
    ['a supplied cursor is seeded without reading legacy', NO_NATIVE, '2026-06-30T10:00:00.000', LEGACY_CURSOR, ['programs-sites.putSiteMonitorState 2026-06-30T10:00:00.000']],
    ['a supplied null cursor seeds nothing', NATIVE, null, LEGACY_CURSOR, []],
  ] as const)('%s', async (_title, monitor, lastMonitored, legacyCursor, seeded) => {
    const { h, service } = harness([], monitor);
    h.legacyCursor = legacyCursor;
    const result = await service().handOffSiteMonitorToTarget(lastMonitored === undefined ? {} : { lastMonitored });
    expect(h.calls.filter((call) => call.startsWith('programs-sites.put'))).toEqual(seeded);
    expect(h.calls.includes('bridge.getCursor')).toBe(lastMonitored === undefined);
    expect(h.calls.some((call) => call.includes(QUEUE_PATH))).toBe(monitor.nativeExisted === true);
    expect(result.recurringEnabled).toBe(monitor.nativeExisted === true);
  });

  it('raises a reconcile SchedulerHandoffError and keeps the monitor on legacy when the chain cannot be ensured', async () => {
    const { h, service } = harness([MONITOR], NATIVE);
    h.ensureStatus = 503;
    await expect(service().handOffSiteMonitorToTarget()).rejects.toMatchObject({ name: 'SchedulerHandoffError', step: 'reconcile' });
    expect(h.table.stored('sitemonitor').state).toBe('legacy');
  });

  it('names the failing bridge step and keeps its cause', async () => {
    const { h, service } = harness([MONITOR], NATIVE);
    h.failNext = 'delete';
    const error = await service()
      .handOffSiteMonitorToTarget()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchedulerHandoffError);
    expect(error).toMatchObject({ step: 'delete', message: 'Scheduler hand-off step delete failed: bridge delete failed' });
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('leaves the monitor alone when the units miss it and its entry does not move', async () => {
    const { h, service } = harness([MONITOR], NATIVE);
    expect(await service().pauseFor(['people.person'], STAYS)).toEqual({ siteMonitor: [] });
    expect(h.calls).toEqual(['bridge.describe']);
  });

  it('restores to legacy: pauses the target trigger, waits the queue deadline, hands the cursor back and re-points the task', async () => {
    const { h, service } = harness([MONITOR], NATIVE);
    const svc = service({ pollIntervalMs: 60_000 });
    await svc.handOffSiteMonitorToTarget();
    h.targetCursor = TARGET_CURSOR;
    h.calls.length = 0;
    const pausedAt = h.nowMs;

    expect(await svc.restoreToLegacy(MOVES)).toEqual({ siteMonitor: [MONITOR_NAME] });
    expect(h.nowMs - pausedAt).toBe(600_000);
    expect(h.calls).toEqual([
      `programs-sites POST ${QUEUE_PATH}/pause`,
      'programs-sites.siteMonitorState',
      `bridge.setCursor ${TARGET_CURSOR}`,
      `bridge.restore {"tasks":["${MONITOR_NAME}"],"repoint":true,"paused":false}`,
    ]);
    expect(h.table.stored('sitemonitor')).toMatchObject({ state: 'legacy', nativePaused: null, targetTriggerDisabled: true });

    h.calls.length = 0;
    await svc.handOffSiteMonitorToTarget();
    expect(h.calls).toContain(`programs-sites POST ${QUEUE_PATH}/resume`);
    expect(h.table.stored('sitemonitor').targetTriggerDisabled).toBe(false);
  });

  it('ends the in-flight wait by slept time when the clock does not move', async () => {
    const { h, service } = harness([MONITOR], NATIVE);
    let slept = 0;
    const svc = service({
      sleep: (ms) => {
        slept += ms;
        return Promise.resolve();
      },
    });
    await svc.handOffSiteMonitorToTarget();
    h.targetCursor = null;
    await svc.restoreToLegacy(MOVES);
    expect(slept).toBe(600_000);
    expect(h.calls.some((call) => call.startsWith('bridge.setCursor'))).toBe(false);
  });

  it('re-points the native task only while it is captured and on legacy', async () => {
    const native = harness([MONITOR], { ...NATIVE, nativePaused: 'transition' });
    expect(await native.service().repointNative()).toEqual({ repointed: true, tasks: [MONITOR_NAME] });
    expect(native.h.table.stored('sitemonitor').nativePaused).toBeNull();

    const none = harness([], NO_NATIVE);
    expect(await none.service().repointNative()).toEqual({ repointed: false, tasks: [] });
    expect(none.h.calls).toEqual([]);
  });
});

describe('suspend and resume', () => {
  it('restoreAll on an empty state makes no bridge call and writes nothing', async () => {
    const { h, service } = harness([]);
    expect(await service().restoreAll()).toEqual({ siteMonitor: [] });
    expect(h.calls).toEqual([]);
    expect(h.table.rows.size).toBe(0);
  });

  it('pauseAll is idempotent and restoreAll recreates the captured monitor', async () => {
    const { h, service } = harness([MONITOR, OTHER], NATIVE);
    const svc = service();
    expect(await svc.pauseAll()).toEqual({ siteMonitor: [MONITOR_NAME] });
    await svc.pauseAll();
    expect(h.table.stored('sitemonitor').nativePaused).toBe('suspend');
    expect(h.live.find((task) => task.task === OTHER.task)?.paused).toBe(false);

    h.calls.length = 0;
    expect(await svc.restoreAll()).toEqual({ siteMonitor: [MONITOR_NAME] });
    expect(h.calls).toEqual([`bridge.restore {"tasks":["${MONITOR_NAME}"],"repoint":true,"paused":false}`]);
    expect(h.table.stored('sitemonitor').nativePaused).toBeNull();
  });
});

describe('scheduler status', () => {
  it('imports a request body through importSchedulerRequest', async () => {
    const { h, service } = harness([]);
    const result = await service().importState({ nativeTasks: [{ ...MONITOR }], ping: true });
    expect(result).toMatchObject({ imported: true, reason: 'imported', nativeExisted: true, taskCount: 1 });
    expect(h.table.stored('sitemonitor')).toMatchObject({ nativeExisted: true, definition: MONITOR });
  });

  it.each([
    ['live tasks', { ...NATIVE, originalPing: 'Yes' }, [MONITOR, { ...OTHER, paused: true }], 'active', true],
    ['a handed-off monitor', { ...NATIVE, state: 'target', originalPing: 'off', cursorHandedOff: LEGACY_CURSOR, handedOffAt: NOW.toISOString() }, [], 'handed-off', null],
    ['a captured, paused monitor', { ...NATIVE, originalPing: 'false' }, [{ ...MONITOR, paused: true }], 'paused', false],
    ['nothing captured', NO_NATIVE, [], 'none', false],
  ] as const)('maps %s to the SchedulerState contract', async (_title, monitor, live, state, ping) => {
    const { service } = harness([...live], monitor as Partial<SiteMonitorRecord>);
    const view = schedulerStateView(await service().state(), { suspended: false });
    expect(view).toMatchObject({ ping, nativeTaskExisted: monitor.nativeExisted, siteMonitor: { state }, background: { suspended: false } });
    expect(view.tasks.map((task) => task.name)).toEqual(state === 'none' ? [] : [MONITOR_NAME]);
    expect(JSON.stringify(view)).not.toContain('t0ken');
    if (state === 'handed-off') {
      expect(view.siteMonitor).toEqual({ state, handedOffAt: NOW.toISOString(), lastMonitored: LEGACY_CURSOR });
      expect(view.tasks).toMatchObject([{ name: MONITOR_NAME, status: 'deleted' }]);
    }
  });

  it('marks a stored monitor definition absent from ColdFusion as captured', async () => {
    const { service } = harness([], NATIVE);
    const view = schedulerStateView(await service().state(), { suspended: true });
    expect(view.tasks).toMatchObject([{ name: MONITOR_NAME, status: 'captured' }]);
  });
});
