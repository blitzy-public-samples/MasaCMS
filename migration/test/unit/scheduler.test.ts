// Scheduler capture parsing, import and hand-off order over the bridge, owner and gateway doubles and a throwaway migration schema.
import { writeFile } from 'node:fs/promises';

import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { SITEMONITOR_DEADLINE_S, SITEMONITOR_QUEUE } from '@opt2/platform/tasks';
import { TENANT_A } from '@opt2/platform/testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  SURVEY_TASK_PREFIX,
  SchedulerHandoffError,
  SchedulerImportError,
  SchedulerStateConflictError,
  createSchedulerService,
  defaultNativeTasksFile,
  importSchedulerState,
  isSiteMonitorTask,
  isSurveyTask,
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
  FIXTURE_SURVEY_ID,
  NATIVE_TASKS_SAMPLE,
  SITE_MONITOR_TASK,
  V0002,
} from '../helpers/fixtures.js';
import type { OwnerDoubleState, OwnerDoubles } from '../helpers/owner-double.js';

const LAUNCH_TASK = `${SURVEY_TASK_PREFIX}${FIXTURE_SURVEY_ID}-launch`;
const REMINDER_TASK = `${SURVEY_TASK_PREFIX}${FIXTURE_SURVEY_ID}-reminder-1`;
const SURVEY_NAMES = [LAUNCH_TASK, REMINDER_TASK];
const SURVEY_TASKS: readonly NativeTask[] = NATIVE_TASKS_SAMPLE.tasks.filter(isSurveyTask);
const MONITOR = taskNamed(SITE_MONITOR_TASK);
const LEGACY_CURSOR = '2026-06-30T11:30:00.000';
const TARGET_CURSOR = '2026-06-30T13:45:00.000';
const QUEUE_CONTROL_PATH = `/internal/v1/task-queues/${SITEMONITOR_QUEUE}`;

/** Units of the `/_api/sitemonitor` job entry, whose state the v0001 to v0002 transition changes. */
const JOB_UNITS = siteMonitorJobUnits(V0002);
const MONITOR_MOVES: SchedulerScope = { siteMonitorUnits: JOB_UNITS, siteMonitorEntryMoves: true };

/** The fixture capture without Masa's monitor task, as ColdFusion holds it when `ping` is false. */
const NO_MONITOR_CAPTURE = { capturedAt: FIXTURE_CREATED_AT, originalPing: false, tasks: SURVEY_TASKS };

/** The fixture capture without the survey reminder: a different capture of the same server. */
const REPLACEMENT_CAPTURE: NativeTasksFile = {
  ...NATIVE_TASKS_SAMPLE,
  tasks: NATIVE_TASKS_SAMPLE.tasks.filter((task) => task.task !== REMINDER_TASK),
};

function taskNamed(name: string): NativeTask {
  const task = NATIVE_TASKS_SAMPLE.tasks.find((candidate) => candidate.task === name);
  if (task === undefined) throw new Error(`The fixture capture has no task ${name}`);
  return task;
}

/** `task` as `scheduler.describe` lists it while it waits: not expired. */
function described(task: NativeTask): NativeTask {
  return { ...task, expired: false };
}

/** A survey launch due a month before the test clock, which ColdFusion holds expired. */
const EXPIRED_TASK: NativeTask = { ...taskNamed(LAUNCH_TASK), task: `${SURVEY_TASK_PREFIX}E0000000-0000-0000-0000000000000001-launch`, startDate: '06/01/2026' };
/** A local time after the launch task's start and before the reminder's. */
const LAUNCH_PASSED = new Date(2026, 6, 1, 12, 0, 0);

function byTask(a: NativeTask, b: NativeTask): number {
  return a.task < b.task ? -1 : a.task > b.task ? 1 : 0;
}

/** The start the bridge gives a past-due task it moves to now: 10 s ahead of the harness clock. */
function dueNow(h: { tc: TestContext }): Pick<NativeTask, 'startDate' | 'startTime'> {
  const runAt = new Date(h.tc.clock.now().getTime() + 10_000);
  return { startDate: cfDateTimeFormat(runAt, 'mm/dd/yyyy'), startTime: cfDateTimeFormat(runAt, 'HH:nn:ss') };
}

/** `task` as the bridge recreates it with `repoint`: the gateway origin's scheme and host in the URL, its port in `port`. */
function repointed(task: NativeTask): NativeTask {
  const origin = new URL(FIXTURE_GATEWAY_ORIGIN);
  const url = new URL(task.url);
  return { ...task, url: `${origin.protocol}//${origin.hostname}${url.pathname}${url.search}`, port: origin.port, paused: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// Catalog with the surveys schedule unit, whose export supplies the schedule version a survey task adoption carries

type Catalog = typeof FIXTURE_CATALOG;
type CatalogUnit = ReturnType<Catalog['units']>[number];
type CatalogTarget = ReturnType<Catalog['unitsForLegacyTable']>[number];

const SURVEY_SCHEDULE_UNIT = 'surveys.survey_schedule';
const SURVEY_SCHEDULE_TABLE = 'synthetic.survey_schedule';
const SURVEY_UNIT: CatalogUnit = Object.freeze({
  id: SURVEY_SCHEDULE_UNIT,
  owner: 'surveys',
  schema: 'surveys',
  legacyTables: Object.freeze([SURVEY_SCHEDULE_TABLE]),
});
const SURVEY_TARGET: CatalogTarget = Object.freeze({
  unit: SURVEY_SCHEDULE_UNIT,
  owner: 'surveys',
  rowPredicate: null,
  keyColumns: Object.freeze(['schedule_id']),
  ownedColumns: 'whole-table',
  objectColumns: Object.freeze({}),
});
const isScheduleTable = (table: string): boolean => table.toLowerCase() === SURVEY_SCHEDULE_TABLE;

const CATALOG: Catalog = Object.freeze({
  ...FIXTURE_CATALOG,
  units: () => [...FIXTURE_CATALOG.units(), SURVEY_UNIT],
  unit: (id: string) => (id === SURVEY_SCHEDULE_UNIT ? SURVEY_UNIT : FIXTURE_CATALOG.unit(id)),
  ownerOf: (id: string) => (id === SURVEY_SCHEDULE_UNIT ? SURVEY_UNIT.owner : FIXTURE_CATALOG.ownerOf(id)),
  unitsOfOwner: (owner: string) => (owner === SURVEY_UNIT.owner ? [SURVEY_UNIT] : FIXTURE_CATALOG.unitsOfOwner(owner)),
  legacyTablesOf: (id: string) => (id === SURVEY_SCHEDULE_UNIT ? SURVEY_UNIT.legacyTables : FIXTURE_CATALOG.legacyTablesOf(id)),
  unitsForLegacyTable: (table: string) => (isScheduleTable(table) ? [SURVEY_TARGET] : FIXTURE_CATALOG.unitsForLegacyTable(table)),
  keyColumnsOf: (table: string) => (isScheduleTable(table) ? SURVEY_TARGET.keyColumns : FIXTURE_CATALOG.keyColumnsOf(table)),
});

const SCHEDULE_COLUMNS: NonNullable<Parameters<OwnerDoubleState['seedRows']>[3]> = [
  { name: 'schedule_id', type: 's' },
  { name: 'survey_id', type: 's' },
  { name: 'schedule_version', type: 'i' },
];

// ---------------------------------------------------------------------------------------------------------------------
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
    catalog: CATALOG,
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

/** Seeds the surveys owner with the fixture survey's schedule row, version `version`, in tenant-a. */
function seedSchedule(h: Harness, version: number): void {
  h.owners
    .owner('surveys')
    .seedRows(SURVEY_SCHEDULE_TABLE, TENANT_A.tenantId, [{ schedule_id: 'schedule-1', survey_id: FIXTURE_SURVEY_ID, schedule_version: version }], SCHEDULE_COLUMNS);
}

/** Bridge tasks sorted by name. */
function bridgeTasks(h: Harness): NativeTask[] {
  return [...h.bridge.tasks.values()].sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------------
// Capture parsing

describe('native task capture parsing', () => {
  it.each([
    ['native-tasks.json', NATIVE_TASKS_SAMPLE],
    ['box cfconfig export', BOX_CFCONFIG_EXPORT_SAMPLE],
  ])('normalises the %s form to the capture holding Masa monitor task and the survey tasks', (_form, raw) => {
    const doc = normaliseNativeTasksFile(raw);

    expect(doc).toEqual({ capturedAt: FIXTURE_CREATED_AT, originalPing: true, siteMonitorTask: SITE_MONITOR_TASK, tasks: NATIVE_TASKS_SAMPLE.tasks });
    expect(doc.tasks.filter((task) => isSiteMonitorTask(task, doc.siteMonitorTask))).toEqual([
      expect.objectContaining({ task: SITE_MONITOR_TASK, operation: 'HTTPRequest', startTime: '00:15:00', interval: '900', requestTimeOut: '600' }),
    ]);
    expect(SURVEY_TASK_PREFIX).toBe('opt2-survey-');
    expect(doc.tasks.filter(isSurveyTask).map((task) => task.task)).toEqual(SURVEY_NAMES);
    expect(nativeTasksDigest(doc)).toBe(nativeTasksDigest(normaliseNativeTasksFile(NATIVE_TASKS_SAMPLE)));
  });

  it.each([
    ['its ACF name', { task: SITE_MONITOR_TASK, url: '' }, undefined, true],
    ['its Lucee name', { task: 'siteMonitor', url: '' }, undefined, true],
    ['its URL under any name', { task: 'masa-monitor', url: 'http://localhost:8080/index.cfm/_api/sitemonitor/' }, undefined, true],
    ['the name scheduler.describe reports', { task: 'custom-monitor', url: '' }, 'custom-monitor', true],
    ['neither, for a survey task', { task: LAUNCH_TASK, url: taskNamed(LAUNCH_TASK).url }, SITE_MONITOR_TASK, false],
    ['neither, for another API route', { task: 'feed', url: 'http://localhost/index.cfm/_api/feed/v1/' }, undefined, false],
  ])('identifies the site monitor by %s', (_by, task, name, expected) => {
    expect(isSiteMonitorTask(task, name)).toBe(expected);
    expect(isSurveyTask(task)).toBe(task.task.startsWith(SURVEY_TASK_PREFIX));
  });

  it('normalises a ping=false capture without a monitor task to one with no native site monitor', () => {
    const doc = normaliseNativeTasksFile(NO_MONITOR_CAPTURE);

    expect(doc).toMatchObject({ originalPing: false, siteMonitorTask: null });
    expect(doc.tasks.map((task) => task.task)).toEqual(SURVEY_NAMES);
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

// ---------------------------------------------------------------------------------------------------------------------
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
    expect((await h.stored()).nativeTasks).toMatchObject({ sourceSha256: replaced.sourceSha256, tasks: [MONITOR, taskNamed(LAUNCH_TASK)] });
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

// ---------------------------------------------------------------------------------------------------------------------
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

    expect(await h.svc.pauseFor(JOB_UNITS, MONITOR_MOVES)).toEqual({ siteMonitor: [SITE_MONITOR_TASK], surveys: [] });
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
    expect([...h.bridge.tasks.keys()].sort()).toEqual(SURVEY_NAMES);

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
    const h = await openHarness({ tasks: SURVEY_TASKS, ping: false });
    await h.importCapture(NO_MONITOR_CAPTURE);
    const cursor = formatWireTime(h.bridge.cursor.lastMonitored);
    h.tc.log.clear();

    expect(await h.svc.pauseFor(JOB_UNITS, MONITOR_MOVES)).toEqual({ siteMonitor: [], surveys: [] });
    await h.tc.gateway.activate(V0002.tableVersion);
    expect(await h.svc.handOffSiteMonitorToTarget()).toEqual({ deletedTasks: [], cursor, recurringEnabled: false });

    expect(h.trail()).toEqual(['gateway activate', 'bridge jobs.getCursor', 'owner:programs-sites putSiteMonitorState']);
    expect(bridgeTasks(h)).toEqual(SURVEY_TASKS);
    const programsSites = h.owners.owner('programs-sites');
    expect(programsSites.siteMonitorState.lastMonitored).toBe(cursor);
    expect(programsSites.queueControls).toEqual([]);
    expect((await h.stored()).sitemonitor).toMatchObject({ state: 'target', nativeExisted: false, cursorHandedOff: cursor });
  });

  it('resumes after an aborted transition only what pauseFor paused, and records nothing as paused', async () => {
    const h = await openHarness();
    await h.importCapture(NATIVE_TASKS_SAMPLE);

    expect(await h.svc.pauseFor([...JOB_UNITS, SURVEY_SCHEDULE_UNIT], MONITOR_MOVES)).toEqual({ siteMonitor: [SITE_MONITOR_TASK], surveys: SURVEY_NAMES });
    expect(bridgeTasks(h).every((task) => task.paused)).toBe(true);

    expect(await h.svc.resumePaused()).toEqual({ siteMonitor: [SITE_MONITOR_TASK], surveys: SURVEY_NAMES });
    expect(bridgeTasks(h)).toEqual(NATIVE_TASKS_SAMPLE.tasks);
    expect(await h.stored()).toMatchObject({ sitemonitor: { state: 'legacy', nativePaused: null }, surveyTasks: { state: 'legacy', paused: null } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Survey tasks, restoration and suspension

const ADOPTED = [
  { name: LAUNCH_TASK, siteId: 'tenant-a', scheduleTime: '2026-07-01T09:00:00.000', scheduleVersion: 2, scheduledImmediately: false },
  { name: REMINDER_TASK, siteId: 'tenant-a', scheduleTime: '2026-07-02T09:00:00.000', scheduleVersion: 2, scheduledImmediately: false },
];

/** Imports the fixture capture, seeds schedule version 2 and runs a transition's pause, freeze and activation of the job and survey units. */
async function pausedAndActivated(h: Harness): Promise<void> {
  await h.importCapture(NATIVE_TASKS_SAMPLE);
  seedSchedule(h, 2);
  await h.svc.pauseFor([...JOB_UNITS, SURVEY_SCHEDULE_UNIT], MONITOR_MOVES);
  await h.tc.gateway.freeze([FIXTURE_ROUTES.siteMonitor]);
  await h.tc.gateway.activate(V0002.tableVersion);
}

describe.skipIf(schema === null)(pgTitle('survey task hand-off and restoration to legacy'), () => {
  it('pauses the survey tasks, adopts each into communications with its schedule version, then deletes them on ColdFusion', async () => {
    const h = await openHarness();
    await pausedAndActivated(h);
    h.tc.log.clear();

    expect(await h.svc.handOffSurveysToTarget()).toEqual({ adopted: SURVEY_NAMES, deleted: SURVEY_NAMES });
    expect(h.trail()).toEqual([
      'bridge scheduler.pause',
      'owner:surveys exportPages',
      'owner:communications adoptScheduledTasks',
      'bridge scheduler.delete',
    ]);
    expect(h.bodies('scheduler.pause').at(-1)).toEqual({ prefix: SURVEY_TASK_PREFIX });
    expect(h.bodies('scheduler.delete')).toEqual([{ prefix: SURVEY_TASK_PREFIX }]);
    const communications = h.owners.owner('communications');
    expect([...communications.adoptedTasks.values()]).toEqual(ADOPTED);
    expect([...h.bridge.tasks.keys()]).toEqual([SITE_MONITOR_TASK]);
    const { surveyTasks } = await h.stored();
    expect(surveyTasks).toMatchObject({ state: 'adopted', adoptedNames: SURVEY_NAMES, paused: null, adoptedAt: h.tc.clock.now().toISOString() });
    expect(surveyTasks.definitions).toEqual(SURVEY_TASKS.map(described));

    h.tc.log.clear();
    expect(await h.svc.handOffSurveysToTarget()).toEqual({ adopted: SURVEY_NAMES, deleted: [] });
    expect(h.trail()).toEqual([]);
    expect(communications.adoptedTasks.size).toBe(2);
  });

  it('retries a hand-off whose delete failed, adopting idempotently by name', async () => {
    const h = await openHarness();
    await pausedAndActivated(h);
    h.bridge.failNext('scheduler.delete', 500);

    await expect(h.svc.handOffSurveysToTarget()).rejects.toMatchObject({ name: 'SchedulerHandoffError', step: 'delete' });
    expect((await h.stored()).surveyTasks).toMatchObject({ state: 'legacy', paused: 'transition', definitions: SURVEY_TASKS });

    expect(await h.svc.handOffSurveysToTarget()).toEqual({ adopted: SURVEY_NAMES, deleted: SURVEY_NAMES });
    const communications = h.owners.owner('communications');
    expect(communications.calls.filter((call) => call.method === 'adoptScheduledTasks')).toHaveLength(2);
    expect([...communications.adoptedTasks.values()]).toEqual(ADOPTED);
    expect((await h.stored()).surveyTasks.state).toBe('adopted');
  });

  it('restores to legacy: disables the target trigger, hands the cursor back, recreates the tasks at the gateway, cancels the adopted ones', async () => {
    const h = await openHarness();
    await pausedAndActivated(h);
    await h.svc.handOffSiteMonitorToTarget({ lastMonitored: LEGACY_CURSOR });
    await h.svc.handOffSurveysToTarget();
    const programsSites = h.owners.owner('programs-sites');
    programsSites.siteMonitorState = { lastMonitored: TARGET_CURSOR, updatedAt: null };
    const before = h.tc.clock.now().getTime();
    h.tc.log.clear();

    expect(await h.svc.restoreToLegacy([...JOB_UNITS, SURVEY_SCHEDULE_UNIT], MONITOR_MOVES)).toEqual({
      siteMonitor: [SITE_MONITOR_TASK],
      surveys: SURVEY_NAMES,
    });
    expect(h.trail()).toEqual([
      `client:programs-sites POST ${QUEUE_CONTROL_PATH}/pause`,
      'owner:programs-sites queueControl.pause',
      'owner:programs-sites siteMonitorState',
      'bridge jobs.setCursor',
      'bridge scheduler.restore',
      'owner:communications cancelAdoptedScheduledTasks',
      'owner:communications cancelAdoptedScheduledTasks',
      'bridge scheduler.restore',
    ]);
    expect(h.tc.clock.now().getTime() - before).toBe(SITEMONITOR_DEADLINE_S * 1000);
    expect(programsSites.pausedQueues.has(SITEMONITOR_QUEUE)).toBe(true);
    expect(formatWireTime(h.bridge.cursor.lastMonitored)).toBe(TARGET_CURSOR);
    expect(h.bodies('scheduler.restore')).toEqual([
      { tasks: [MONITOR], repoint: true, paused: false },
      { tasks: SURVEY_TASKS.map(described), repoint: true, paused: false },
    ]);
    expect(bridgeTasks(h)).toEqual(NATIVE_TASKS_SAMPLE.tasks.map(repointed));

    const communications = h.owners.owner('communications');
    expect(communications.cancelledTasks).toEqual(SURVEY_NAMES);
    expect(communications.adoptedTasks.size).toBe(0);
    expect(await h.stored()).toMatchObject({
      sitemonitor: { state: 'legacy', nativePaused: null, targetTriggerDisabled: true },
      surveyTasks: { state: 'legacy', adoptedNames: [], paused: null },
    });
  });

  it('resumes after an aborted transition a survey task whose start passed during the pause at once, and never one ColdFusion held expired', async () => {
    const h = await openHarness({ tasks: [...NATIVE_TASKS_SAMPLE.tasks, EXPIRED_TASK] });
    await h.importCapture(NATIVE_TASKS_SAMPLE);

    expect(await h.svc.pauseFor([...JOB_UNITS, SURVEY_SCHEDULE_UNIT], MONITOR_MOVES)).toEqual({ siteMonitor: [SITE_MONITOR_TASK], surveys: SURVEY_NAMES });
    expect((await h.stored()).surveyTasks.definitions.find((task) => task.task === EXPIRED_TASK.task)).toMatchObject({ expired: true });
    h.tc.clock.set(LAUNCH_PASSED);

    expect(await h.svc.resumePaused()).toEqual({ siteMonitor: [SITE_MONITOR_TASK], surveys: SURVEY_NAMES });
    expect(h.bodies('scheduler.resume').at(-1)).toEqual({ tasks: SURVEY_NAMES });
    expect(h.bridge.tasks.get(LAUNCH_TASK)).toMatchObject({ paused: false, ...dueNow(h) });
    expect(h.bridge.tasks.get(REMINDER_TASK)).toEqual(taskNamed(REMINDER_TASK));
    expect(h.bridge.tasks.get(EXPIRED_TASK.task)).toEqual(EXPIRED_TASK);
  });

  it('adopts no survey task ColdFusion held expired, and restores it expired beside one moved to now', async () => {
    const h = await openHarness({ tasks: [...NATIVE_TASKS_SAMPLE.tasks, EXPIRED_TASK] });
    await pausedAndActivated(h);

    expect(await h.svc.handOffSurveysToTarget()).toEqual({ adopted: SURVEY_NAMES, deleted: [...SURVEY_NAMES, EXPIRED_TASK.task].sort() });
    expect([...h.owners.owner('communications').adoptedTasks.values()]).toEqual(ADOPTED);
    h.tc.clock.set(LAUNCH_PASSED);

    expect((await h.svc.restoreToLegacy([SURVEY_SCHEDULE_UNIT], { siteMonitorUnits: JOB_UNITS, siteMonitorEntryMoves: false })).surveys).toEqual(
      [...SURVEY_NAMES, EXPIRED_TASK.task].sort(),
    );
    expect(h.bodies('scheduler.restore')).toEqual([
      { tasks: [...SURVEY_TASKS.map(described), { ...EXPIRED_TASK, expired: true }].sort(byTask), repoint: true, paused: false },
    ]);
    const live = (await h.tc.ctx.bridge.schedulerDescribe()).tasks;
    expect(live.find((task) => task.task === LAUNCH_TASK)).toMatchObject({ paused: false, expired: false, ...dueNow(h) });
    expect(live.find((task) => task.task === REMINDER_TASK)).toMatchObject({ paused: false, expired: false, startDate: '07/02/2026' });
    expect(live.find((task) => task.task === EXPIRED_TASK.task)).toMatchObject({ paused: false, expired: true, startDate: EXPIRED_TASK.startDate });
  });

  it('pauseAll pauses every native and fixture task and restoreAll recreates them, persisting each pause', async () => {
    const h = await openHarness();
    await h.importCapture(NATIVE_TASKS_SAMPLE);

    expect(await h.svc.pauseAll()).toEqual({ siteMonitor: [SITE_MONITOR_TASK], surveys: SURVEY_NAMES });
    expect(bridgeTasks(h).every((task) => task.paused)).toBe(true);
    expect(await h.stored()).toMatchObject({ sitemonitor: { nativePaused: 'suspend' }, surveyTasks: { paused: 'suspend', definitions: SURVEY_TASKS } });

    expect(await h.svc.restoreAll()).toEqual({ siteMonitor: [SITE_MONITOR_TASK], surveys: SURVEY_NAMES });
    expect(bridgeTasks(h)).toEqual(NATIVE_TASKS_SAMPLE.tasks.map(repointed));
    expect(await h.stored()).toMatchObject({ sitemonitor: { state: 'legacy', nativePaused: null }, surveyTasks: { state: 'legacy', paused: null } });
  });
});

describe.skipIf(schema === null)(pgTitle('hand-off failures'), () => {
  it.each([
    ['handOffSiteMonitorToTarget', 'scheduler.delete', 'delete', (svc: SchedulerService) => svc.handOffSiteMonitorToTarget()],
    ['handOffSiteMonitorToTarget', 'jobs.getCursor', 'cursor-read', (svc: SchedulerService) => svc.handOffSiteMonitorToTarget()],
    ['handOffSurveysToTarget', 'scheduler.pause', 'pause', (svc: SchedulerService) => svc.handOffSurveysToTarget()],
    ['restoreAll', 'scheduler.restore', 'restore', (svc: SchedulerService) => svc.restoreAll()],
  ])('%s with a failed bridge %s raises SchedulerHandoffError at step %s and records no hand-off', async (_method, op, step, run) => {
    const h = await openHarness();
    await pausedAndActivated(h);
    h.bridge.failNext(op, 500);

    const error: unknown = await run(h.svc).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchedulerHandoffError);
    expect(error).toMatchObject({ step });
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(await h.stored()).toMatchObject({ sitemonitor: { state: 'legacy' }, surveyTasks: { state: 'legacy' } });
  });
});
