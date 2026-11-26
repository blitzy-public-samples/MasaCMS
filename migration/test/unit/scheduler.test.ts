// Scheduler capture parsing, import and hand-off order over the bridge, owner and gateway doubles and a throwaway migration schema.
import { writeFile } from 'node:fs/promises';

import { SITEMONITOR_DEADLINE_S, SITEMONITOR_QUEUE } from '@opt2/platform/tasks';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  SchedulerHandoffError,
  SchedulerImportError,
  SchedulerStateConflictError,
  createSchedulerService,
  defaultNativeTasksFile,
  importSchedulerState,
  isSiteMonitorTask,
  nativeTasksDigest,
  nativeTasksFileSchema,
  normaliseNativeTasksFile,
  readSchedulerState,
  siteMonitorJobUnits,
  type NativeTask,
  type NativeTasksFile,
  type SchedulerImportResult,
  type SchedulerScope,
  type SchedulerService,
  type SchedulerStateSnapshot,
} from '../../src/scheduler/index.js';
import { formatWireTime, type BridgeDouble, type BridgeDoubleOptions } from '../helpers/bridge-double.js';
import { MIGRATION_SCHEMA_SKIP_REASON, buildTestContext, withMigrationSchema, type ServiceHandler, type TestContext } from '../helpers/context.js';
import {
  BOX_CFCONFIG_EXPORT_SAMPLE,
  FIXTURE_CATALOG,
  FIXTURE_CREATED_AT,
  FIXTURE_GATEWAY_ORIGIN,
  FIXTURE_ROUTES,
  NATIVE_TASKS_SAMPLE,
  OPERATOR_TASKS,
  SITE_MONITOR_TASK,
  V0002,
} from '../helpers/fixtures.js';
import type { OwnerDoubles } from '../helpers/owner-double.js';

const OPERATOR_NAMES: string[] = [...OPERATOR_TASKS];
const OPERATOR_TASK_LIST: readonly NativeTask[] = NATIVE_TASKS_SAMPLE.tasks.filter((task) => !isSiteMonitorTask(task, SITE_MONITOR_TASK));
const MONITOR = taskNamed(SITE_MONITOR_TASK);
const LEGACY_CURSOR = '2026-06-30T11:30:00.000';
const TARGET_CURSOR = '2026-06-30T13:45:00.000';
const QUEUE_CONTROL_PATH = `/internal/v1/task-queues/${SITEMONITOR_QUEUE}`;

/** Units of the `/_api/sitemonitor` job entry, whose state the v0001 to v0002 transition changes. */
const JOB_UNITS = siteMonitorJobUnits(V0002);
const MONITOR_MOVES: SchedulerScope = { siteMonitorUnits: JOB_UNITS, siteMonitorEntryMoves: true };

/** The fixture capture without Masa's monitor task, as ColdFusion holds it when `ping` is false. */
const NO_MONITOR_CAPTURE = { capturedAt: FIXTURE_CREATED_AT, originalPing: false, tasks: OPERATOR_TASK_LIST };

/** The fixture capture without the second operator task: a different capture of the same server. */
const REPLACEMENT_CAPTURE: NativeTasksFile = {
  ...NATIVE_TASKS_SAMPLE,
  tasks: NATIVE_TASKS_SAMPLE.tasks.filter((task) => task.task !== OPERATOR_TASKS[1]),
};

function taskNamed(name: string): NativeTask {
  const task = NATIVE_TASKS_SAMPLE.tasks.find((candidate) => candidate.task === name);
  if (task === undefined) throw new Error(`The fixture capture has no task ${name}`);
  return task;
}

/** `task` as the bridge recreates it with `repoint`: the gateway origin's scheme and host in the URL, its port in `port`. */
function repointed(task: NativeTask): NativeTask {
  const origin = new URL(FIXTURE_GATEWAY_ORIGIN);
  const url = new URL(task.url);
  return { ...task, url: `${origin.protocol}//${origin.hostname}${url.pathname}${url.search}`, port: origin.port, paused: false };
}

// Harness: one throwaway schema for the file, a fresh context and scheduler state per test

const schema = await withMigrationSchema();
const opened: TestContext[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((tc) => tc.close()));
});

afterAll(async () => {
  await schema?.drop();
});

/** `title`, with the skip reason appended when PG_HOST is unset. */
const pgTitle = (title: string): string => (schema === null ? `${title} (skipped: ${MIGRATION_SCHEMA_SKIP_REASON})` : title);

const QUEUE_ROUTE = /^\/internal\/v1\/task-queues\/(?<queue>[^/]+)\/(?<op>pause|resume|ensure)$/;
type QueueOp = Parameters<OwnerDoubles['client']['queueControl']>[2];

interface Harness {
  tc: TestContext;
  bridge: BridgeDouble;
  owners: OwnerDoubles;
  svc: SchedulerService;
  /** Writes `capture` as `${OPT2_PRISTINE_DIR}/native-tasks.json` and imports it. */
  importCapture(capture: unknown): Promise<SchedulerImportResult>;
  stored(): Promise<SchedulerStateSnapshot>;
  /** `<component> <op>` of every logged call except `scheduler.describe`, in call order. */
  trail(): string[];
  /** Bodies of the bridge calls of `op`, in call order. */
  bodies(op: string): unknown[];
}

/** A context over the doubles and the file's schema, with empty scheduler state and a sleep that advances its clock. */
async function openHarness(bridgeOptions: BridgeDoubleOptions = {}): Promise<Harness> {
  if (schema === null) throw new Error(MIGRATION_SCHEMA_SKIP_REASON);
  await schema.db.withMetadata((tx) => tx.query('DELETE FROM migration.scheduler_state'));
  const routed: { owners?: OwnerDoubles } = {};
  // programs-sites answers queue control from its owner double, which records every pause and ensured chain.
  const programsSites: ServiceHandler = async (req) => {
    const groups = QUEUE_ROUTE.exec(req.path)?.groups;
    if (routed.owners === undefined || groups?.queue === undefined || groups.op === undefined) {
      throw new Error(`Unrouted programs-sites call ${req.method} ${req.path}`);
    }
    const body = await routed.owners.client.queueControl('programs-sites', decodeURIComponent(groups.queue), groups.op as QueueOp);
    return { status: 200, headers: { 'content-type': 'application/json' }, body };
  };
  const tc = await buildTestContext({
    migrationDb: schema.db,
    catalog: FIXTURE_CATALOG,
    bridge: bridgeOptions,
    serviceHandlers: { 'programs-sites': programsSites },
  });
  opened.push(tc);
  const { bridge, owners } = tc;
  if (bridge === null || owners === null) throw new Error('The test context lacks its bridge or owner doubles');
  routed.owners = owners;
  const svc = createSchedulerService(tc.ctx, {
    sleep: (ms) => {
      tc.clock.advance(ms);
      return Promise.resolve();
    },
    pollIntervalMs: SITEMONITOR_DEADLINE_S * 1000,
  });
  return {
    tc,
    bridge,
    owners,
    svc,
    async importCapture(capture) {
      const file = defaultNativeTasksFile(tc.ctx.env);
      await writeFile(file, JSON.stringify(capture), 'utf8');
      return importSchedulerState(tc.ctx, file);
    },
    stored: () => readSchedulerState(tc.ctx.db, tc.clock.now()),
    trail: () => tc.log.entries.filter((entry) => entry.op !== 'scheduler.describe').map((entry) => `${entry.component} ${entry.op}`),
    bodies: (op) => bridge.calls.filter((call) => call.op === op).map((call) => call.body),
  };
}

/** Bridge tasks sorted by name. */
function bridgeTasks(h: Harness): NativeTask[] {
  return [...h.bridge.tasks.values()].sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));
}

// Capture parsing

describe('native task capture parsing', () => {
  it.each([
    ['native-tasks.json', NATIVE_TASKS_SAMPLE],
    ['box cfconfig export', BOX_CFCONFIG_EXPORT_SAMPLE],
  ])('normalises the %s form to the capture holding Masa monitor task and the operator tasks', (_form, raw) => {
    const doc = normaliseNativeTasksFile(raw);

    expect(doc).toEqual({ capturedAt: FIXTURE_CREATED_AT, originalPing: true, siteMonitorTask: SITE_MONITOR_TASK, tasks: NATIVE_TASKS_SAMPLE.tasks });
    expect(doc.tasks.filter((task) => isSiteMonitorTask(task, doc.siteMonitorTask))).toEqual([
      expect.objectContaining({ task: SITE_MONITOR_TASK, operation: 'HTTPRequest', startTime: '00:15:00', interval: '900', requestTimeOut: '600' }),
    ]);
    expect(doc.tasks.filter((task) => !isSiteMonitorTask(task, doc.siteMonitorTask)).map((task) => task.task)).toEqual(OPERATOR_NAMES);
    expect(nativeTasksDigest(doc)).toBe(nativeTasksDigest(normaliseNativeTasksFile(NATIVE_TASKS_SAMPLE)));
  });

  it.each([
    ['its ACF name', { task: SITE_MONITOR_TASK, url: '' }, undefined, true],
    ['its Lucee name', { task: 'siteMonitor', url: '' }, undefined, true],
    ['its URL under any name', { task: 'masa-monitor', url: 'http://localhost:8080/index.cfm/_api/sitemonitor/' }, undefined, true],
    ['the name scheduler.describe reports', { task: 'custom-monitor', url: '' }, 'custom-monitor', true],
    ['neither, for an operator task', { task: OPERATOR_TASKS[0], url: taskNamed(OPERATOR_TASKS[0]).url }, SITE_MONITOR_TASK, false],
    ['neither, for another API route', { task: 'feed', url: 'http://localhost/index.cfm/_api/feed/v1/' }, undefined, false],
  ])('identifies the site monitor by %s', (_by, task, name, expected) => {
    expect(isSiteMonitorTask(task, name)).toBe(expected);
  });

  it('normalises a ping=false capture without a monitor task to one with no native site monitor', () => {
    const doc = normaliseNativeTasksFile(NO_MONITOR_CAPTURE);

    expect(doc).toMatchObject({ originalPing: false, siteMonitorTask: null });
    expect(doc.tasks.map((task) => task.task)).toEqual(OPERATOR_NAMES);
    expect(doc.tasks.some((task) => isSiteMonitorTask(task, doc.siteMonitorTask))).toBe(false);
  });

  it('digests a capture independently of key order, task order and capture time, and differently once a task changes', () => {
    const digest = nativeTasksDigest(normaliseNativeTasksFile(NATIVE_TASKS_SAMPLE));
    const reordered = {
      tasks: [...NATIVE_TASKS_SAMPLE.tasks].reverse().map((task) => Object.fromEntries(Object.entries(task).reverse())),
      siteMonitorTask: SITE_MONITOR_TASK,
      originalPing: true,
      capturedAt: '2026-06-02T00:00:00Z',
    };
    const changed = { ...NATIVE_TASKS_SAMPLE, tasks: NATIVE_TASKS_SAMPLE.tasks.map((task) => (task === MONITOR ? { ...task, interval: '600' } : task)) };

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(nativeTasksDigest(normaliseNativeTasksFile(reordered))).toBe(digest);
    expect(nativeTasksDigest(normaliseNativeTasksFile(changed))).not.toBe(digest);
  });

  it.each([
    ['a task without a name', { ...NATIVE_TASKS_SAMPLE, tasks: [{ ...MONITOR, task: '' }] }],
    ['a paused flag that is not a boolean', { ...NATIVE_TASKS_SAMPLE, tasks: [{ ...MONITOR, paused: 'no' }] }],
    ['a capture time that is not ISO-8601', { ...NATIVE_TASKS_SAMPLE, capturedAt: '06/01/2026' }],
    ['no task list', { capturedAt: FIXTURE_CREATED_AT, originalPing: true }],
  ])('rejects a capture with %s', (_title, raw) => {
    expect(nativeTasksFileSchema.safeParse(raw).success).toBe(false);
    expect(() => normaliseNativeTasksFile(raw)).toThrow(SchedulerImportError);
  });
});

// Import into migration.scheduler_state

describe.skipIf(schema === null)(pgTitle('scheduler capture import'), () => {
  it('imports a capture once, reports an identical capture in either form unchanged and replaces a different one', async () => {
    const h = await openHarness();
    const normalised = normaliseNativeTasksFile(NATIVE_TASKS_SAMPLE);
    const sourceSha256 = nativeTasksDigest(normalised);

    expect(await h.importCapture(NATIVE_TASKS_SAMPLE)).toEqual({
      imported: true,
      reason: 'imported',
      nativeExisted: true,
      siteMonitorTask: SITE_MONITOR_TASK,
      taskCount: 3,
      sourceSha256,
    });
    const first = await h.stored();
    expect(first.nativeTasks).toMatchObject({ capturedAt: FIXTURE_CREATED_AT, originalPing: true, siteMonitorTask: SITE_MONITOR_TASK, tasks: normalised.tasks, sourceSha256 });
    expect(first.sitemonitor).toMatchObject({ nativeExisted: true, originalPing: true, definition: MONITOR, state: 'legacy', nativePaused: null });

    for (const same of [NATIVE_TASKS_SAMPLE, BOX_CFCONFIG_EXPORT_SAMPLE]) {
      expect(await h.importCapture(same)).toMatchObject({ imported: false, reason: 'unchanged', sourceSha256 });
    }
    expect((await h.stored()).nativeTasks?.importedAt).toBe(first.nativeTasks?.importedAt);

    const replaced = await h.importCapture(REPLACEMENT_CAPTURE);
    expect(replaced).toMatchObject({ imported: true, reason: 'replaced', nativeExisted: true, taskCount: 2 });
    expect(replaced.sourceSha256).not.toBe(sourceSha256);
    expect((await h.stored()).nativeTasks).toMatchObject({ sourceSha256: replaced.sourceSha256, tasks: [MONITOR, taskNamed(OPERATOR_TASKS[0])] });
  });

  it('records a ping=false capture without the monitor task as no native task', async () => {
    const h = await openHarness();

    expect(await h.importCapture(NO_MONITOR_CAPTURE)).toMatchObject({ imported: true, reason: 'imported', nativeExisted: false, siteMonitorTask: null, taskCount: 2 });
    expect((await h.stored()).sitemonitor).toMatchObject({ nativeExisted: false, originalPing: false, definition: null, state: 'legacy' });
  });

  it('refuses a different capture once the monitor is handed off, keeping the stored one', async () => {
    const h = await openHarness();
    const { sourceSha256 } = await h.importCapture(NATIVE_TASKS_SAMPLE);
    await h.svc.handOffSiteMonitorToTarget({ lastMonitored: LEGACY_CURSOR });

    const conflict: unknown = await h.importCapture(REPLACEMENT_CAPTURE).catch((caught: unknown) => caught);
    expect(conflict).toBeInstanceOf(SchedulerStateConflictError);
    expect(conflict).toMatchObject({ key: 'sitemonitor' });
    expect(await h.importCapture(NATIVE_TASKS_SAMPLE)).toMatchObject({ reason: 'unchanged' });
    const stored = await h.stored();
    expect(stored.nativeTasks?.sourceSha256).toBe(sourceSha256);
    expect(stored.sitemonitor).toMatchObject({ state: 'target', definition: MONITOR });
  });
});

// Site-monitor hand-off order

describe.skipIf(schema === null)(pgTitle('site-monitor hand-off order'), () => {
  it.each([
    ['reads the legacy cursor through jobs.getCursor', undefined],
    ['seeds a supplied lastMonitored without reading legacy', LEGACY_CURSOR],
  ])('pauses the native task before the freeze, deletes it after activation and %s', async (_title, lastMonitored) => {
    const h = await openHarness();
    await h.importCapture(NATIVE_TASKS_SAMPLE);
    const cursor = lastMonitored ?? formatWireTime(h.bridge.cursor.lastMonitored);
    h.tc.log.clear();

    expect(await h.svc.pauseFor(JOB_UNITS, MONITOR_MOVES)).toEqual({ siteMonitor: [SITE_MONITOR_TASK] });
    expect(h.bridge.tasks.get(SITE_MONITOR_TASK)?.paused).toBe(true);
    expect((await h.stored()).sitemonitor.nativePaused).toBe('transition');
    await h.tc.gateway.freeze([FIXTURE_ROUTES.siteMonitor]);
    await h.tc.gateway.activate(V0002.tableVersion);

    expect(await h.svc.handOffSiteMonitorToTarget(lastMonitored === undefined ? undefined : { lastMonitored })).toEqual({
      deletedTasks: [SITE_MONITOR_TASK],
      cursor,
      recurringEnabled: true,
    });
    expect(h.trail()).toEqual([
      'bridge scheduler.pause',
      'gateway freeze',
      'gateway activate',
      'bridge scheduler.pause',
      'bridge scheduler.delete',
      ...(lastMonitored === undefined ? ['bridge jobs.getCursor'] : []),
      'owner:programs-sites putSiteMonitorState',
      `client:programs-sites POST ${QUEUE_CONTROL_PATH}/ensure`,
      'owner:programs-sites queueControl.ensure',
    ]);
    expect(h.bodies('scheduler.delete')).toEqual([{ tasks: [SITE_MONITOR_TASK] }]);
    expect([...h.bridge.tasks.keys()].sort()).toEqual(OPERATOR_NAMES);

    const programsSites = h.owners.owner('programs-sites');
    expect(programsSites.siteMonitorState.lastMonitored).toBe(cursor);
    expect(programsSites.queueControls).toEqual([{ service: 'programs-sites', queue: SITEMONITOR_QUEUE, op: 'ensure' }]);
    expect((await h.stored()).sitemonitor).toMatchObject({
      state: 'target',
      nativeExisted: true,
      cursorHandedOff: cursor,
      nativePaused: null,
      targetTriggerDisabled: false,
      handedOffAt: h.tc.clock.now().toISOString(),
    });
  });

  it('without a native task (ping=false) deletes nothing and enables no chain, but still seeds the cursor', async () => {
    const h = await openHarness({ tasks: OPERATOR_TASK_LIST, ping: false });
    await h.importCapture(NO_MONITOR_CAPTURE);
    const cursor = formatWireTime(h.bridge.cursor.lastMonitored);
    h.tc.log.clear();

    expect(await h.svc.pauseFor(JOB_UNITS, MONITOR_MOVES)).toEqual({ siteMonitor: [] });
    await h.tc.gateway.activate(V0002.tableVersion);
    expect(await h.svc.handOffSiteMonitorToTarget()).toEqual({ deletedTasks: [], cursor, recurringEnabled: false });

    expect(h.trail()).toEqual(['gateway activate', 'bridge jobs.getCursor', 'owner:programs-sites putSiteMonitorState']);
    expect(bridgeTasks(h)).toEqual(OPERATOR_TASK_LIST);
    const programsSites = h.owners.owner('programs-sites');
    expect(programsSites.siteMonitorState.lastMonitored).toBe(cursor);
    expect(programsSites.queueControls).toEqual([]);
    expect((await h.stored()).sitemonitor).toMatchObject({ state: 'target', nativeExisted: false, cursorHandedOff: cursor });
  });

  it('resumes after an aborted transition only what pauseFor paused, and records nothing as paused', async () => {
    const h = await openHarness();
    await h.importCapture(NATIVE_TASKS_SAMPLE);

    expect(await h.svc.pauseFor(JOB_UNITS, MONITOR_MOVES)).toEqual({ siteMonitor: [SITE_MONITOR_TASK] });
    expect(bridgeTasks(h).map((task) => [task.task, task.paused])).toEqual([[SITE_MONITOR_TASK, true], ...OPERATOR_NAMES.map((name) => [name, false])]);

    expect(await h.svc.resumePaused()).toEqual({ siteMonitor: [SITE_MONITOR_TASK] });
    expect(bridgeTasks(h)).toEqual(NATIVE_TASKS_SAMPLE.tasks);
    expect(await h.stored()).toMatchObject({ sitemonitor: { state: 'legacy', nativePaused: null } });
  });
});

// Restoration and suspension

/** Imports the fixture capture and runs a transition's pause, freeze and activation of the job units. */
async function pausedAndActivated(h: Harness): Promise<void> {
  await h.importCapture(NATIVE_TASKS_SAMPLE);
  await h.svc.pauseFor(JOB_UNITS, MONITOR_MOVES);
  await h.tc.gateway.freeze([FIXTURE_ROUTES.siteMonitor]);
  await h.tc.gateway.activate(V0002.tableVersion);
}

describe.skipIf(schema === null)(pgTitle('restoration to legacy and suspension'), () => {
  it('restores to legacy: disables the target trigger, hands the cursor back, recreates the monitor at the gateway', async () => {
    const h = await openHarness();
    await pausedAndActivated(h);
    await h.svc.handOffSiteMonitorToTarget({ lastMonitored: LEGACY_CURSOR });
    const programsSites = h.owners.owner('programs-sites');
    programsSites.siteMonitorState = { lastMonitored: TARGET_CURSOR, updatedAt: null };
    const before = h.tc.clock.now().getTime();
    h.tc.log.clear();

    expect(await h.svc.restoreToLegacy(MONITOR_MOVES)).toEqual({ siteMonitor: [SITE_MONITOR_TASK] });
    expect(h.trail()).toEqual([
      `client:programs-sites POST ${QUEUE_CONTROL_PATH}/pause`,
      'owner:programs-sites queueControl.pause',
      'owner:programs-sites siteMonitorState',
      'bridge jobs.setCursor',
      'bridge scheduler.restore',
    ]);
    expect(h.tc.clock.now().getTime() - before).toBe(SITEMONITOR_DEADLINE_S * 1000);
    expect(programsSites.pausedQueues.has(SITEMONITOR_QUEUE)).toBe(true);
    expect(formatWireTime(h.bridge.cursor.lastMonitored)).toBe(TARGET_CURSOR);
    expect(h.bodies('scheduler.restore')).toEqual([{ tasks: [MONITOR], repoint: true, paused: false }]);
    expect(bridgeTasks(h)).toEqual([repointed(MONITOR), ...OPERATOR_TASK_LIST]);
    expect((await h.stored()).sitemonitor).toMatchObject({ state: 'legacy', nativePaused: null, targetTriggerDisabled: true });
  });

  it('pauseAll pauses the native task and restoreAll recreates it, persisting the pause', async () => {
    const h = await openHarness();
    await h.importCapture(NATIVE_TASKS_SAMPLE);

    expect(await h.svc.pauseAll()).toEqual({ siteMonitor: [SITE_MONITOR_TASK] });
    expect(bridgeTasks(h).map((task) => [task.task, task.paused])).toEqual([[SITE_MONITOR_TASK, true], ...OPERATOR_NAMES.map((name) => [name, false])]);
    expect((await h.stored()).sitemonitor).toMatchObject({ nativePaused: 'suspend' });

    expect(await h.svc.restoreAll()).toEqual({ siteMonitor: [SITE_MONITOR_TASK] });
    expect(bridgeTasks(h)).toEqual([repointed(MONITOR), ...OPERATOR_TASK_LIST]);
    expect((await h.stored()).sitemonitor).toMatchObject({ state: 'legacy', nativePaused: null });
  });
});

describe.skipIf(schema === null)(pgTitle('hand-off failures'), () => {
  it.each([
    ['handOffSiteMonitorToTarget', 'scheduler.delete', 'delete', (svc: SchedulerService) => svc.handOffSiteMonitorToTarget()],
    ['handOffSiteMonitorToTarget', 'jobs.getCursor', 'cursor-read', (svc: SchedulerService) => svc.handOffSiteMonitorToTarget()],
    ['restoreAll', 'scheduler.restore', 'restore', (svc: SchedulerService) => svc.restoreAll()],
  ])('%s with a failed bridge %s raises SchedulerHandoffError at step %s and records no hand-off', async (_method, op, step, run) => {
    const h = await openHarness();
    await pausedAndActivated(h);
    h.bridge.failNext(op, 500);

    const error: unknown = await run(h.svc).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchedulerHandoffError);
    expect(error).toMatchObject({ step });
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect((await h.stored()).sitemonitor).toMatchObject({ state: 'legacy' });
  });
});
