// The cut-over transition over PostgreSQL and gateway, owner, bridge and SQL Server doubles, moving the archive group to legacy.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  canonicalTypeForSqlServer,
  encodeKey,
  encodeRow,
  type CanonicalColumn,
  type ChangeRow,
  type LegacyChange,
} from '@opt2/platform/migration-kit';
import { ROLE_SET, TENANT_A, assertResponseMatchesOpenApi, authHeadersFor, loadOpenApiDocument, pgAvailable, testVerifier } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { CutoverVersion } from '../src/cutover/index.js';
import type { PubSubLike, SubscriptionLike } from '../src/quiesce/index.js';
import { readLogEntries, type TransitionLogEntry } from '../src/reports/index.js';
import { createProjector, type Projector } from '../src/reverse/index.js';
import { createSchedulerService, type SchedulerService } from '../src/scheduler/index.js';
import { buildApp } from '../src/server.js';
import {
  TRANSITION_STEPS,
  TransitionAbortedError,
  TransitionClaimLostError,
  TransitionInProgressError,
  TransitionNotFoundError,
  abortTransition,
  createTransitionService,
  createTransitionStartupGuard,
  deriveTransitionPlan,
  initialTransitionProgress,
  runTransitionStep,
  toTransitionView,
  type StepDeps,
  type TransitionRecord,
  type TransitionService,
  type TransitionServiceOptions,
  type TransitionStepNumber,
  type TransitionView,
} from '../src/transition/index.js';
import { STARTUP_WINDOW_HOLDER_ENV, createWindowService, leasesOf, type WindowService } from '../src/windows/index.js';

import { buildTestContext, withMigrationSchema, type MigrationSchemaHandle, type TestContext } from './helpers/context.js';
import { createMutableClock, createTestDirs, testEnv, type MutableClock } from './helpers/env.js';
import { createFakeLegacyDb, type Row } from './helpers/fake-legacy-db.js';
import {
  FIXTURE_CATALOG,
  FIXTURE_GROUP_IDS,
  FIXTURE_ROUTES,
  NATIVE_TASKS_SAMPLE,
  SITE_MONITOR_TASK,
  TABLES,
  UNITS,
  defineFixtureTables,
  fixtureEntries,
  fixtureGroups,
  fixtureVersion,
  personArchiveRow,
} from './helpers/fixtures.js';
import { createGatewayDouble, type GatewayDouble, type GatewayInflightRow } from './helpers/gateway-double.js';
import type { DoublePublishedEvent, OwnerDoubleState } from './helpers/owner-double.js';

const m = vi.hoisted(() => ({ restartLegacy: vi.fn(), createPubSub: vi.fn() }));

// The controlled restart is the restart port: a test never spawns OPT2_LEGACY_RESTART_CMD.
vi.mock('../src/legacy/restart.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  restartLegacy: m.restartLegacy,
}));
// The drain opens Pub/Sub itself and the transition passes it no client, so the factory is replaced; no emulator is reached.
vi.mock('../src/quiesce/subscriptions.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPubSub: m.createPubSub,
}));

const PG = await pgAvailable();

const V_A = 'v0201';
const V_B = 'v0202';
const ARCHIVE_GROUP = FIXTURE_GROUP_IDS.archive;
const SET_T = [UNITS.personArchive];
const ROLLBACK_BEFORE_REPORT = 'opt2/reports/reconciliation/rollback-before.json';
const ARCHIVED_TOPIC = 'people.person.archived.v1';
const PEOPLE_SWEEP_ENSURE = '/internal/v1/task-queues/people-outbox-sweep/ensure';
const EPOCH = 10;
const LIVE_INSTANCE = 'gw-1';
const LAGGING_INSTANCE = 'gw-3';
const ORPHAN_INSTANCE = 'gw-2';
const ORPHAN_REQUEST_ID = 'req-orphaned-archive-0001';
const ABANDONED_REQUEST_ID = 'req-abandoned-archive-0001';
const PUBSUB_PROJECT = 'opt2-transition-suite';
const SYNC_SQL = readFileSync(new URL('../sql/005_opt2_sync.sql', import.meta.url), 'utf8');
const MIGRATION_DOC = loadOpenApiDocument(new URL('../contracts/openapi.yaml', import.meta.url), parse) as object;
const SERVICES_DIR = fileURLToPath(new URL('../../services/', import.meta.url));

/** Every event topic the services' contracts define, by file name. */
const TOPICS: readonly string[] = readdirSync(SERVICES_DIR).flatMap((service) => {
  const dir = path.join(SERVICES_DIR, service, 'contracts', 'events');
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)) : [];
});

/** Pub/Sub subscribing every data owner to every contract topic, with empty dead-letter queues. */
function fakePubSub(consumers: readonly string[]): PubSubLike {
  const subscription = (name: string): SubscriptionLike => ({
    name: `projects/${PUBSUB_PROJECT}/subscriptions/${name.replace(/^projects\/[^/]+\/subscriptions\//, '')}`,
    getMetadata: () => Promise.resolve([{ enableMessageOrdering: true }]),
    modifyPushConfig: () => Promise.reject(new Error('A transition never changes push configs')),
    seek: () => Promise.reject(new Error('A transition never seeks')),
  });
  return {
    projectId: PUBSUB_PROJECT,
    getSubscriptions: () => Promise.resolve([consumers.flatMap((consumer) => TOPICS.map((topic) => subscription(`${consumer}.${topic}`)))]),
    subscription,
    close: () => Promise.resolve(),
    peekEventIds: () => Promise.resolve([]),
  };
}

/** The fixture routes with the archive group at `archive`; the monitor job lists the archive unit, so moving T pauses it. */
function archiveVersion(name: string, archive: 'legacy' | 'target', rollback: boolean): CutoverVersion {
  const authority = { [ARCHIVE_GROUP]: archive };
  const entries = fixtureEntries(name, authority).map((entry) =>
    entry.kind === 'job' ? { ...entry, units: [...new Set([...entry.units, UNITS.personArchive])].sort() } : entry,
  );
  const rollbackRefs = rollback
    ? [{ groups: [ARCHIVE_GROUP], rollbackSet: [ARCHIVE_GROUP], report: ROLLBACK_BEFORE_REPORT, evidence: [ROLLBACK_BEFORE_REPORT] }]
    : [];
  return fixtureVersion(name, authority, entries, { rollbackRefs });
}

const VERSION_A = archiveVersion(V_A, 'target', false);
const VERSION_B = archiveVersion(V_B, 'legacy', true);

function canonicalColumns(table: { columns: readonly { name: string; type: string }[] }): CanonicalColumn[] {
  return table.columns.map((column) => ({ name: column.name, ...canonicalTypeForSqlServer(column.type) }));
}

const ARCHIVE_COLUMNS = canonicalColumns(TABLES['synthetic.person_archive']);
const ARCHIVE = personArchiveRow();
/** A second archive of the same person that people holds but whose change never reaches legacy. */
const UNPROJECTED_ARCHIVE = personArchiveRow({ effective_from: new Date(2026, 6, 1) });
const ARCHIVED_EVENT: DoublePublishedEvent = {
  eventId: 'b5f0c1d2-7a3e-4c8b-9d10-2e3f4a5b6c7d',
  topic: ARCHIVED_TOPIC,
  tenantId: TENANT_A.tenantId,
  kind: 'process',
};

/** An insert changelog row of `unit` with its one legacy projection, as an owner's `GET /changes` lists it. */
function insertChange(
  unit: string,
  legacyTable: string,
  columns: readonly CanonicalColumn[],
  keyColumn: string,
  row: Row,
  xid: string,
): ChangeRow & { legacy: LegacyChange[] } {
  const key = encodeKey(columns, [keyColumn], row);
  const after = encodeRow(columns, row);
  return {
    xid,
    seq: '1',
    table: unit.slice(unit.indexOf('.') + 1),
    op: 'insert',
    key,
    before: null,
    after,
    columns: [],
    origin: 'target',
    actorUserId: null,
    actorService: null,
    at: '2026-06-30 11:00:00.000',
    requestId: null,
    operationId: null,
    legacy: [{ unit, legacyTable, key, before: null, after, columns: [] }],
  };
}

/** A sleep that moves `clock` on by the pause and yields once, so polling code under test never waits in real time. */
function clockSleep(clock: MutableClock): (ms: number) => Promise<void> {
  return async (ms) => {
    clock.advance(Math.max(0, ms));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}

/** Reads the transition until it is no longer running; the drive runs in the background of `start` and `resume`. */
async function settled(read: () => Promise<TransitionView>): Promise<TransitionView> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const view = await read();
    if (view.state !== 'running') return view;
    await delay(10);
  }
  throw new Error('The transition did not settle within 5 s');
}

/** Resolves once `ready` holds, polling in real time. */
async function eventually(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (ready()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}


/** Hands out the owner's next xid as the position of a committed write. */
function takeXid(state: OwnerDoubleState): string {
  const xid = state.nextXid;
  state.nextXid = (BigInt(xid) + 1n).toString();
  return xid;
}

/** Settings of one scenario. */
interface ScenarioOptions {
  /** Raw variables over the test env, such as `OPT2_LEGACY_RESTART_CMD`. */
  env?: Partial<Record<string, string>>;
  /** Adds a legacy-bound write of the archive route still registered by an instance that died a minute before. */
  orphan?: boolean;
  /** Adds a target-bound write of the archive route that the live instance abandoned a minute before. */
  abandoned?: boolean;
  /** People also holds an archive whose change never reaches legacy, so step 6 reconciles a difference. */
  unprojected?: boolean;
}

/** The step engine over a scenario, outside any service: its record, ports and one step at a time. */
interface Engine {
  deps: StepDeps;
  record(): TransitionRecord;
  /** Runs `step` and records its outcome as completed, as the service does. */
  step(step: TransitionStepNumber): Promise<void>;
}

/** One arranged transition from `V_A` to `V_B` and the doubles behind it. */
interface Scenario {
  t: TestContext;
  clock: MutableClock;
  people: OwnerDoubleState;
  /** A transition service over the scenario, stopped after the test. */
  service(): TransitionService;
  /** The step engine over a fresh record from `V_A` to `V_B`, continuing after `seed.lastStep` when given. */
  engine(seed?: Partial<Pick<TransitionRecord, 'plan' | 'lastStep'>>): Engine;
}

/** Undo work of the running test, run in reverse order after it. */
const cleanups: (() => Promise<unknown>)[] = [];

describe('deriveTransitionPlan', () => {
  it('derives the archive units as T, freezes the archive route and leaves the content group untouched', () => {
    const plan = deriveTransitionPlan(VERSION_A, VERSION_B, fixtureGroups(), FIXTURE_CATALOG);

    expect(plan).toMatchObject({
      from: V_A,
      to: V_B,
      setT: SET_T,
      toTarget: [],
      toLegacy: SET_T,
      legacyWriteEntries: [],
      frozenRoutes: [FIXTURE_ROUTES.archive],
      owners: ['people'],
      siteMonitorEntryMoves: false,
      contentToTarget: false,
      returnsToLegacy: true,
    });
    expect(plan.entriesChanged.map(({ route, from, to }) => [route, from, to])).toEqual([[FIXTURE_ROUTES.archive, 'target', 'legacy']]);
    expect(plan.siteMonitorUnits).toContain(UNITS.personArchive);
    const content = fixtureGroups().groups.find((group) => group.id === FIXTURE_GROUP_IDS.content);
    expect(content?.units.length).toBeGreaterThan(0);
    expect(plan.setT.filter((unit) => content?.units.includes(unit))).toEqual([]);
  });
});

describe.skipIf(!PG)('transition (requires PostgreSQL: PG_* unset)', () => {
  let schema: MigrationSchemaHandle;

  beforeAll(async () => {
    const handle = await withMigrationSchema();
    if (handle === null) throw new Error('PostgreSQL became unreachable after the availability probe');
    schema = handle;
  });

  afterAll(async () => {
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.db.withMetadata(async (tx) => {
      for (const table of ['transition', 'unit_lease', 'scheduler_state', 'projector_cursor', 'write_window', 'snapshot']) {
        await tx.query(`DELETE FROM ${tx.schema}.${table}`);
      }
    });
    m.restartLegacy.mockReset();
    m.createPubSub.mockReset();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /**
   * Archive group `target` under `V_A`; people's unpublished archive event publishes once its outbox sweep is ensured, which
   * the shared log records as `owner:people publish`.
   */
  async function arrange(options: ScenarioOptions = {}): Promise<Scenario> {
    const clock = createMutableClock();
    const sleep = clockSleep(clock);
    const inflight: GatewayInflightRow[] =
      options.orphan === true
        ? [
            {
              instance: ORPHAN_INSTANCE,
              requestId: ORPHAN_REQUEST_ID,
              route: FIXTURE_ROUTES.archive,
              side: 'legacy',
              startedAt: clock.now().getTime() - 60_000,
              orphan: true,
            },
          ]
        : [];
    if (options.abandoned === true) {
      inflight.push({
        instance: LIVE_INSTANCE,
        requestId: ABANDONED_REQUEST_ID,
        route: FIXTURE_ROUTES.archive,
        side: 'target',
        startedAt: clock.now().getTime() - 60_000,
        abandoned: true,
        units: [...(VERSION_A.entries.find((entry) => entry.route === FIXTURE_ROUTES.archive)?.units ?? [])],
      });
    }
    const lagging: { gateway?: GatewayDouble } = {};
    // The lagging instance sees a new epoch only once an epoch wait has polled.
    const gatewaySleep = async (ms: number): Promise<void> => {
      await sleep(ms);
      lagging.gateway?.ackEpoch(LAGGING_INSTANCE, lagging.gateway.snapshot().epoch);
    };
    const t = await buildTestContext({
      clock,
      env: options.env,
      legacySeed: true,
      migrationDb: schema.db,
      cutover: { versions: [VERSION_A, VERSION_B] },
      gateway: {
        active: V_A,
        epoch: EPOCH,
        inflight,
        instances: [LIVE_INSTANCE, LAGGING_INSTANCE],
        manualAck: [LAGGING_INSTANCE],
        clock,
        sleep: gatewaySleep,
      },
      bridge: { clock, tasks: NATIVE_TASKS_SAMPLE.tasks.filter((task) => task.task === SITE_MONITOR_TASK) },
    });
    cleanups.push(() => t.close());
    lagging.gateway = t.gateway;
    await (await t.legacy.live()).request().batch(SYNC_SQL);
    await writeFile(
      path.join(t.dirs.stateDir, 'fixtures.json'),
      JSON.stringify({ available: true, reason: null, checkedAt: clock.now().toISOString() }),
    );
    m.createPubSub.mockImplementation(() => fakePubSub(t.ctx.config.dataOwners));

    if (t.owners === null) throw new Error('The scenario runs over owner doubles');
    const people = t.owners.owner('people');
    people.setGate(UNITS.personArchive, { state: 'open' });

    const archives = options.unprojected === true ? [ARCHIVE, UNPROJECTED_ARCHIVE] : [ARCHIVE];
    people.seedRows(TABLES['synthetic.person_archive'].qualified, TENANT_A.tenantId, archives, ARCHIVE_COLUMNS);
    const archiveXid = takeXid(people);
    people.changesScript.set(TENANT_A.tenantId, [
      {
        rows: [insertChange(UNITS.personArchive, 'synthetic.person_archive', ARCHIVE_COLUMNS, 'archive_id', ARCHIVE, archiveXid)],
        horizon: people.nextXid,
      },
    ]);
    const sweepEnsured = (): boolean => t.client.calls.some((call) => call.service === 'people' && call.method === 'POST' && call.path === PEOPLE_SWEEP_ENSURE);
    people.positionScript = (_call, state) => {
      if (!sweepEnsured()) return { unpublished: 1 };
      if (!state.published.some((event) => event.eventId === ARCHIVED_EVENT.eventId)) {
        state.published.push({ ...ARCHIVED_EVENT });
        t.log.append('owner:people', 'publish', { eventId: ARCHIVED_EVENT.eventId });
      }
      return { unpublished: 0 };
    };

    const projector: Projector = createProjector(t.ctx, {
      startupGuard: { run: () => Promise.reject(new Error('No projector batch of this suite touches tcontent')) },
    });
    // Stands in for the projector loop, which would have run a cycle between the await's polls.
    const projectorPort: TransitionServiceOptions['projector'] = {
      async awaitProjection(req) {
        if (!(await projector.runOnce()).leader) throw new Error("The suite's projector did not lead its cycle");
        return projector.awaitProjection(req);
      },
    };
    const windows: WindowService = createWindowService(t.ctx, { projector: projectorPort, sleep });
    const scheduler: SchedulerService = createSchedulerService(t.ctx, { sleep });
    const serviceOptions: TransitionServiceOptions = { projector: projectorPort, windows, scheduler, sleep };

    return {
      t,
      clock,
      people,
      service() {
        const service = createTransitionService(t.ctx, serviceOptions);
        cleanups.push(() => service.stop());
        return service;
      },
      engine(seed = {}) {
        const at = clock.now().toISOString();
        let record: TransitionRecord = {
          transitionId: cfUuid(),
          from: V_A,
          to: V_B,
          state: 'started',
          lastStep: 0,
          progress: initialTransitionProgress(),
          steps: [],
          startedAt: at,
          updatedAt: at,
          ...seed,
        };
        const deps: StepDeps = {
          ctx: t.ctx,
          projector: projectorPort,
          windows,
          scheduler,
          startupGuard: createTransitionStartupGuard(t.ctx),
          sleep,
          persist: (progress) => {
            record = { ...record, progress: structuredClone(progress) };
            return Promise.resolve();
          },
        };
        return {
          deps,
          record: () => record,
          async step(step) {
            const outcome = await runTransitionStep(deps, record, step);
            record = { ...record, plan: outcome.plan ?? record.plan, progress: outcome.progress, lastStep: step };
          },
        };
      },
    };
  }

  /** Position in the shared call log of the first entry of `component` and `op`. */
  function at(s: Scenario, component: string, op: string): number {
    return s.t.log.indexOf(component, op);
  }

  /** Position in the shared call log of the last entry matching `match`, or -1. */
  function lastAt(s: Scenario, match: (component: string, op: string) => boolean): number {
    return s.t.log.entries.findLastIndex((entry) => match(entry.component, entry.op));
  }

  function siteMonitorTask(s: Scenario) {
    const task = s.t.bridge?.tasks.get(SITE_MONITOR_TASK);
    if (task === undefined) throw new Error('The bridge double lost the native site monitor task');
    return task;
  }

  function bridgeOps(s: Scenario): string[] {
    return (s.t.bridge?.calls ?? []).map((call) => call.op);
  }

  async function reportOf(s: Scenario, file: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(s.t.dirs.reportsDir, file), 'utf8')) as Record<string, unknown>;
  }

  async function logEntryOf(s: Scenario, transitionId: string): Promise<TransitionLogEntry | undefined> {
    const entries = await readLogEntries<TransitionLogEntry>(s.t.dirs.reportsDir, 'transitions.json');
    return entries.find((entry) => entry.transitionId === transitionId);
  }

  /** Queue-control calls with operation `op`, as `<service> <queue>`. */
  function queueCalls(s: Scenario, op: 'pause' | 'resume'): string[] {
    return s.t.client.calls
      .filter((call) => call.method === 'POST' && call.path.startsWith('/internal/v1/task-queues/') && call.path.endsWith(`/${op}`))
      .map((call) => `${call.service} ${call.path.split('/')[4] ?? ''}`);
  }

  /** The gate state each T unit holds at its owner. */
  function gatesOfT(s: Scenario) {
    return { [UNITS.personArchive]: s.people.gates.get(UNITS.personArchive) };
  }

  it('drains a pending archive event while the gates are open, projects T into legacy, reconciles it to zero and activates V_B', async () => {
    const s = await arrange();
    const service = s.service();

    const started = await service.start({ to: V_B });
    expect(started).toMatchObject({ fromVersion: V_A, toVersion: V_B, state: 'running', step: 1 });
    const done = await settled(() => service.get(started.transitionId));
    // The drive mirrors its last write into transitions.json after the row; stopping waits for it.
    await service.stop();

    expect(done).toMatchObject({
      state: 'completed',
      step: 8,
      units: SET_T,
      frozenRoutes: [FIXTURE_ROUTES.archive],
      reconciliation: { report: ROLLBACK_BEFORE_REPORT, point: 'rollback-before', result: 'zero-difference', differences: 0 },
    });
    expect(done.error).toBeUndefined();

    const sweptAt = at(s, 'client:people', `POST ${PEOPLE_SWEEP_ENSURE}`);
    const publishedAt = at(s, 'owner:people', 'publish');
    const closedAt = at(s, 'owner:people', 'gate.close');
    const frozenAt = at(s, 'gateway', 'freeze');
    const activatedAt = at(s, 'gateway', 'activate');
    const unfrozenAt = at(s, 'gateway', 'unfreeze');
    expect(sweptAt).toBeGreaterThanOrEqual(0);
    expect(publishedAt).toBeGreaterThan(sweptAt);
    expect(closedAt).toBeGreaterThan(publishedAt);
    expect(frozenAt).toBeGreaterThanOrEqual(0);
    expect(frozenAt).toBeLessThan(closedAt);
    expect(activatedAt).toBeGreaterThan(closedAt);
    // The rollback-before reconciliation is the last read of the owners' exports.
    expect(lastAt(s, (component, op) => component.startsWith('owner:') && op.startsWith('export'))).toBeLessThan(activatedAt);
    expect(lastAt(s, (component, op) => component.startsWith('owner:') && op === 'gate.open')).toBeLessThan(unfrozenAt);
    expect(unfrozenAt).toBeGreaterThan(activatedAt);
    expect(s.t.log.ops('gateway').at(-1)).toBe('unfreeze');
    expect(s.t.log.ops('gateway').filter((op) => op === 'activate')).toHaveLength(1);
    // The freeze and the activation each waited for the lagging instance to see their epoch.
    const awaited = s.t.gateway.calls.filter((call) => call.op === 'awaitEpoch').map((call) => (call.args as { epoch: number }).epoch);
    expect(awaited).toEqual([EPOCH + 1, EPOCH + 2]);
    expect(s.t.gateway.snapshot().instances.find((instance) => instance.instanceId === LAGGING_INSTANCE)?.seenEpoch).toBeGreaterThanOrEqual(EPOCH + 2);

    expect(s.t.legacy.rows(TABLES['synthetic.person_archive'].qualified)).toEqual([ARCHIVE]);
    expect(await reportOf(s, 'reconciliation/rollback-before.json')).toMatchObject({
      point: 'rollback-before',
      result: 'zero-difference',
      tableVersion: V_A,
    });

    expect(gatesOfT(s)).toEqual({
      [UNITS.personArchive]: { unit: UNITS.personArchive, state: 'legacy', holderId: null, phase: 'quiet' },
    });
    expect(await leasesOf(s.t.ctx, started.transitionId)).toEqual([]);
    expect(s.t.gateway.snapshot()).toMatchObject({ tableVersion: V_B, frozen: [] });

    // Masa's monitor task (onApplicationStart_include.cfm:561-575) was paused before the freeze and resumed after the unfreeze.
    expect(siteMonitorTask(s)).toMatchObject({ interval: '900', requestTimeOut: '600', paused: false });
    expect(bridgeOps(s).filter((op) => op === 'scheduler.pause' || op === 'scheduler.resume')).toEqual(['scheduler.pause', 'scheduler.resume']);
    expect(at(s, 'bridge', 'scheduler.pause')).toBeLessThan(frozenAt);
    expect(at(s, 'bridge', 'scheduler.resume')).toBeGreaterThan(unfrozenAt);
    // T's owners create no queue other than their outbox sweeps, which keep running.
    expect(queueCalls(s, 'pause')).toEqual([]);
    expect(queueCalls(s, 'resume')).toEqual([]);

    expect(await logEntryOf(s, started.transitionId)).toMatchObject({
      from: V_A,
      to: V_B,
      setT: SET_T,
      entriesChanged: [FIXTURE_ROUTES.archive],
      legacyWriteEntries: [],
      outcome: 'activated',
      reconciliation: { point: 'rollback-before', result: 'zero-difference', differences: 0, path: ROLLBACK_BEFORE_REPORT },
      steps: TRANSITION_STEPS.map(({ step, name }): unknown => expect.objectContaining({ step, name, result: 'ok' })),
    });
  });

  it('aborts before activation when step 6 reconciles a difference, undoing every side effect and keeping V_A active', async () => {
    const s = await arrange({ unprojected: true });
    const service = s.service();

    const { transitionId } = await service.start({ to: V_B });
    const aborted = await settled(() => service.get(transitionId));
    await service.stop();

    expect(aborted).toMatchObject({
      state: 'aborted',
      step: 6,
      error: { step: 6, name: 'final-state-and-reconcile', state: 'aborted' },
      reconciliation: { point: 'rollback-before', differences: 1 },
    });
    expect(aborted.error?.message).toMatch(/^Reconciliation rollback-before found 1 differences in 1 units/);
    expect(aborted.reconciliation?.result).not.toBe('zero-difference');

    expect(s.t.log.ops('gateway')).not.toContain('activate');
    expect(s.t.gateway.snapshot()).toMatchObject({ tableVersion: V_A, frozen: [] });
    expect(at(s, 'gateway', 'unfreeze')).toBeGreaterThan(at(s, 'gateway', 'freeze'));
    const reopened = s.t.log.entries.filter((entry) => entry.op === 'gate.open').map(({ component, args }) => [component, args]);
    expect(reopened).toEqual([['owner:people', { op: 'open', units: [UNITS.personArchive], holderId: transitionId, state: 'open' }]]);
    expect(gatesOfT(s)).toEqual({
      [UNITS.personArchive]: { unit: UNITS.personArchive, state: 'open', holderId: null, phase: 'quiet' },
    });
    expect(await leasesOf(s.t.ctx, transitionId)).toEqual([]);
    expect(siteMonitorTask(s).paused).toBe(false);
    expect(bridgeOps(s).filter((op) => op === 'scheduler.pause' || op === 'scheduler.resume')).toEqual(['scheduler.pause', 'scheduler.resume']);
    expect(queueCalls(s, 'resume')).toEqual(queueCalls(s, 'pause'));
    expect(await logEntryOf(s, transitionId)).toMatchObject({ outcome: 'aborted', abortReason: aborted.error?.message });

    // Run again over the derived plan, step 6 refuses the same way, which is what aborted the transition.
    const engine = s.engine({ plan: deriveTransitionPlan(VERSION_A, VERSION_B, fixtureGroups(), FIXTURE_CATALOG), lastStep: 5 });
    const refusal = await engine.step(6).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TransitionAbortedError);
    expect(refusal).toMatchObject({ step: 6, details: { point: 'rollback-before', differences: 1 } });
  });

  it('clears an orphaned legacy-bound write only after one controlled restart, then completes the transition', async () => {
    const s = await arrange({ orphan: true, env: { OPT2_LEGACY_RESTART_CMD: 'opt2-legacy-restart' } });
    m.restartLegacy.mockImplementation(() => {
      s.t.log.append('legacy', 'restart');
      return Promise.resolve({ exitCode: 0, durationMs: 12 });
    });
    s.clock.advance(10 * s.t.ctx.config.windows.gatewayLeaseMs);
    expect(s.t.gateway.inflightRows()).toMatchObject([{ requestId: ORPHAN_REQUEST_ID, route: FIXTURE_ROUTES.archive, orphan: true }]);
    const service = s.service();

    const { transitionId } = await service.start({ to: V_B });
    expect(await settled(() => service.get(transitionId))).toMatchObject({ state: 'completed', step: 8 });

    expect(m.restartLegacy).toHaveBeenCalledTimes(1);
    expect(m.restartLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ OPT2_LEGACY_RESTART_CMD: 'opt2-legacy-restart' }),
      expect.objectContaining({ extraEnv: { [STARTUP_WINDOW_HOLDER_ENV]: transitionId } }),
    );
    const anyString: unknown = expect.any(String);
    expect(s.t.gateway.calls.filter((call) => call.op === 'clearOrphans')).toEqual([
      {
        op: 'clearOrphans',
        args: { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: transitionId, at: anyString }, instanceIds: [ORPHAN_INSTANCE] },
      },
    ]);
    expect(at(s, 'legacy', 'restart')).toBeGreaterThan(at(s, 'gateway', 'freeze'));
    expect(at(s, 'gateway', 'clearOrphans')).toBeGreaterThan(at(s, 'legacy', 'restart'));
    expect(at(s, 'owner:people', 'publish')).toBeGreaterThan(at(s, 'gateway', 'clearOrphans'));
    expect(s.t.gateway.inflightRows()).toEqual([]);
    expect(await leasesOf(s.t.ctx, transitionId)).toEqual([]);
    expect(s.t.gateway.snapshot().tableVersion).toBe(V_B);
  });

  it("hands a target-bound write the live gateway abandoned to step 5, whose closed gates clear it, then completes", async () => {
    const s = await arrange({ abandoned: true });
    expect(s.t.gateway.snapshotV2().inflight).toMatchObject([
      { instanceId: LIVE_INSTANCE, route: FIXTURE_ROUTES.archive, side: 'target', count: 1, orphaned: true },
    ]);
    const service = s.service();

    const { transitionId } = await service.start({ to: V_B });
    expect(await settled(() => service.get(transitionId))).toMatchObject({ state: 'completed', step: 8 });

    expect(m.restartLegacy).not.toHaveBeenCalled();
    const anyString: unknown = expect.any(String);
    expect(s.t.gateway.calls.filter((call) => call.op === 'clearOrphans')).toEqual([
      {
        op: 'clearOrphans',
        args: { side: 'target', evidence: { kind: 'gates-closed', holderId: transitionId, at: anyString, units: SET_T }, instanceIds: [LIVE_INSTANCE] },
      },
    ]);
    const closedAt = at(s, 'owner:people', 'gate.close');
    expect(at(s, 'gateway', 'clearOrphans')).toBeGreaterThan(closedAt);
    expect(s.t.gateway.inflightRows()).toEqual([]);
    expect(s.t.gateway.snapshot().tableVersion).toBe(V_B);
  });

  it('refuses at step 3 naming the orphan when no restart command is set, however far the clock has run', async () => {
    const s = await arrange({ orphan: true });
    s.clock.advance(12 * s.t.ctx.config.transition.drainTimeoutMs);
    const engine = s.engine();
    await engine.step(1);
    await engine.step(2);

    const refusal = await engine.step(3).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(TransitionAbortedError);
    expect(refusal).toMatchObject({
      step: 3,
      details: { orphans: [{ side: 'legacy', route: FIXTURE_ROUTES.archive, instanceId: ORPHAN_INSTANCE, count: 1 }] },
    });
    const reason = (refusal as TransitionAbortedError).reason;
    expect(reason).toContain('OPT2_LEGACY_RESTART_CMD is not set');
    expect(reason).toContain(`legacy ${FIXTURE_ROUTES.archive} on instance ${ORPHAN_INSTANCE}`);
    expect(m.restartLegacy).not.toHaveBeenCalled();
    expect(s.t.gateway.calls.some((call) => call.op === 'clearOrphans')).toBe(false);

    const undone = await abortTransition(engine.deps, engine.record());

    expect(undone).toMatchObject({ pausedQueues: [], closedGates: [], extraLeasedUnits: [], freezeRequested: false });
    expect(s.t.gateway.snapshot()).toMatchObject({ tableVersion: V_A, frozen: [] });
    expect(await leasesOf(s.t.ctx, engine.record().transitionId)).toEqual([]);
    expect(siteMonitorTask(s).paused).toBe(false);
    // The gateway row keeps its request id: the contract's in-flight view groups rows by instance and route.
    expect(s.t.gateway.inflightRows()).toMatchObject([{ requestId: ORPHAN_REQUEST_ID, route: FIXTURE_ROUTES.archive, orphan: true }]);
    expect(
      toTransitionView({ ...engine.record(), progress: undone, state: 'aborted', abortReason: reason, finishedAt: s.clock.now().toISOString() }),
    ).toMatchObject({ state: 'aborted', step: 3, error: { step: 3, name: 'confirm-inflight-finished', message: reason } });
  });

  it('resumes a drive stopped in step 5 from its persisted step in a new service, running each side effect once', async () => {
    const s = await arrange();
    // A drive that finds its claim gone stops without undoing anything, as a process exit leaves it.
    s.people.failNext('gate', { once: new TransitionClaimLostError('process-exit') });
    const first = s.service();

    const { transitionId } = await first.start({ to: V_B });
    await eventually(() => s.people.calls.some((call) => call.method === 'gate'), 'the first gate call of step 5');
    await first.stop();
    expect(await first.get(transitionId)).toMatchObject({ state: 'running', step: 5 });
    expect(s.t.gateway.snapshot()).toMatchObject({ tableVersion: V_A, frozen: [FIXTURE_ROUTES.archive] });

    const second = s.service();
    await expect(second.start({ to: V_B })).rejects.toBeInstanceOf(TransitionInProgressError);
    await expect(second.get(cfUuid())).rejects.toBeInstanceOf(TransitionNotFoundError);
    await second.resume();
    expect(await settled(() => second.get(transitionId))).toMatchObject({ state: 'completed', step: 8 });

    const gatewayOps = s.t.log.ops('gateway');
    expect(gatewayOps.filter((op) => op === 'freeze')).toHaveLength(1);
    expect(gatewayOps.filter((op) => op === 'activate')).toHaveLength(1);
    expect(s.t.log.entries.filter((entry) => entry.op === `POST ${PEOPLE_SWEEP_ENSURE}`).length).toBeGreaterThanOrEqual(1);
    expect(at(s, 'owner:people', 'publish')).toBeLessThan(at(s, 'owner:people', 'gate.close'));
    expect(bridgeOps(s).filter((op) => op === 'scheduler.pause')).toHaveLength(1);
    expect(gatesOfT(s)[UNITS.personArchive]).toMatchObject({ state: 'legacy', holderId: null });
    expect(s.t.legacy.rows(TABLES['synthetic.person_archive'].qualified)).toEqual([ARCHIVE]);

    const { rows } = await schema.db.withMetadata((tx) =>
      tx.query<{ state: string; entries: { steps: { step: number; result?: string }[] } }>(
        `SELECT state, entries FROM ${tx.schema}.transition WHERE transition_id = $1`,
        [transitionId],
      ),
    );
    expect(rows[0]?.state).toBe('completed');
    expect(rows[0]?.entries.steps.map(({ step, result }) => [step, result])).toEqual([
      [1, 'ok'],
      [2, 'ok'],
      [3, 'ok'],
      [4, 'ok'],
      [5, 'error'],
      [5, 'ok'],
      [6, 'ok'],
      [7, 'ok'],
      [8, 'ok'],
    ]);
  });

  it('starts a transition for platform.operator with 202 and reads it with 200 as the contract declares, refusing other callers', async () => {
    const dirs = await createTestDirs();
    cleanups.push(() => dirs.cleanup());
    const legacy = createFakeLegacyDb();
    defineFixtureTables(legacy);
    await (await legacy.live()).request().batch(SYNC_SQL);
    // Committed versions: v0003 returns the roster group set to legacy after v0002; the bridge is unreachable.
    const app = await buildApp({
      env: testEnv({ dirs, LOG_LEVEL: 'fatal' }),
      verifierOverride: testVerifier('migration'),
      db: schema.db,
      legacy,
      gateway: createGatewayDouble({ active: 'v0002', epoch: 1 }),
      startBackground: false,
    });
    cleanups.push(() => app.close());
    const subject = (caller: string) => {
      const found = ROLE_SET.find((candidate) => candidate.kind === 'service' && candidate.caller === caller);
      if (found === undefined) throw new Error(`No role subject for ${caller}`);
      return found;
    };
    const operator = await authHeadersFor(subject('operator'), { audience: 'migration' });
    const migration = await authHeadersFor(subject('migration'), { audience: 'migration' });
    const inject = async (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) => {
      const res = await app.inject({
        method,
        url,
        headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      assertResponseMatchesOpenApi(MIGRATION_DOC, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
      return res;
    };
    const START = '/internal/v1/transitions';

    expect((await inject('POST', START, migration, { toVersion: 'v0003' })).statusCode).toBe(403);
    const started = await inject('POST', START, operator, { toVersion: 'v0003' });
    expect(started.statusCode).toBe(202);
    const view = started.json<TransitionView>();
    expect(view).toMatchObject({ fromVersion: 'v0002', toVersion: 'v0003', state: 'running', step: 1 });

    const url = `${START}/${view.transitionId}`;
    const read = await inject('GET', url, operator);
    expect(read.statusCode).toBe(200);
    expect(read.json<TransitionView>()).toMatchObject({ transitionId: view.transitionId, fromVersion: 'v0002', toVersion: 'v0003' });
    expect((await inject('GET', url, migration)).statusCode).toBe(403);

    // The background drive cannot pause the legacy tasks through the unreachable bridge, so it aborts at step 2.
    const final = await settled(async () => {
      const res = await inject('GET', url, operator);
      expect(res.statusCode).toBe(200);
      return res.json<TransitionView>();
    });
    expect(final).toMatchObject({ state: 'aborted', step: 2, error: { step: 2, name: 'stop-new-work' } });
  });
});

