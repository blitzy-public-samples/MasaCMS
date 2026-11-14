// Unit tests of the transition step engine over fakes and the committed cut-over versions.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { GatewayCallError, GatewayWaitTimeoutError, loadGroups, loadVersion, type CutoverStatus } from '../../src/cutover/index.js';
import type { MigrationContext } from '../../src/context.js';
import { GateConflict, UnknownLegacyTableError, loadUnitCatalog, type UnitCatalog } from '../../src/owners/index.js';
import { DrainTimeoutError } from '../../src/quiesce/index.js';
import { TRANSITION_STEP_NAMES } from '../../src/reports/index.js';
import { ProjectionTimeoutError } from '../../src/reverse/index.js';
import { SnapshotBlockedError } from '../../src/snapshot/index.js';
import { LeaseUnavailableError, WindowNotFoundError, contentUnits } from '../../src/windows/index.js';
import { LegacyRestartError } from '../../src/legacy/index.js';
import {
  TERMINAL_TRANSITION_STATES,
  TRANSITION_STEPS,
  TransitionAbortedError,
  TransitionPreconditionError,
  abortTransition,
  contractTransitionState,
  createTransitionStartupGuard,
  deriveTransitionPlan,
  initialTransitionProgress,
  planTransition,
  queuesToPause,
  runTransitionStep,
  type StepDeps,
  type TransitionProgress,
  type TransitionRecord,
  type TransitionStepNumber,
} from '../../src/transition/steps.js';

const m = vi.hoisted(() => ({
  acquireLeases: vi.fn(),
  releaseLeases: vi.fn(),
  takeSnapshot: vi.fn(),
  requireSnapshot: vi.fn(),
  restartFeedFor: vi.fn(),
  reconcileUnits: vi.fn(),
  writeReconciliationReport: vi.fn(),
  awaitDrained: vi.fn(),
  restartLegacy: vi.fn(),
  opt2SyncReady: vi.fn(),
  countStartupRows: vi.fn(),
  diffSnapshotManifests: vi.fn(),
  transferFiles: vi.fn(),
  readSchedulerState: vi.fn(),
  freezeLegacyBound: vi.fn(),
  sendReloadRequest: vi.fn(),
  unfreezeLegacyBound: vi.fn(),
}));

vi.mock('../../src/windows/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/windows/index.js')>()),
  acquireLeases: m.acquireLeases,
  releaseLeases: m.releaseLeases,
}));
vi.mock('../../src/windows/reload.js', async (orig) => ({
  ...(await orig<typeof import('../../src/windows/reload.js')>()),
  freezeLegacyBound: m.freezeLegacyBound,
  sendReloadRequest: m.sendReloadRequest,
  unfreezeLegacyBound: m.unfreezeLegacyBound,
}));
vi.mock('../../src/snapshot/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/snapshot/index.js')>()),
  takeSnapshot: m.takeSnapshot,
  requireSnapshot: m.requireSnapshot,
}));
vi.mock('../../src/apply/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/apply/index.js')>()),
  restartFeedFor: m.restartFeedFor,
}));
vi.mock('../../src/reconcile/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/reconcile/index.js')>()),
  reconcileUnits: m.reconcileUnits,
  writeReconciliationReport: m.writeReconciliationReport,
}));
vi.mock('../../src/quiesce/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/quiesce/index.js')>()),
  awaitDrained: m.awaitDrained,
}));
vi.mock('../../src/legacy/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/legacy/index.js')>()),
  restartLegacy: m.restartLegacy,
  opt2SyncReady: m.opt2SyncReady,
  countStartupRows: m.countStartupRows,
}));
vi.mock('../../src/files/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/files/index.js')>()),
  diffSnapshotManifests: m.diffSnapshotManifests,
  transferFiles: m.transferFiles,
}));
vi.mock('../../src/scheduler/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/scheduler/index.js')>()),
  readSchedulerState: m.readSchedulerState,
}));

const config = loadConfig();
const catalog = loadUnitCatalog(config.paths.tableOwnership);
const groups = loadGroups(config.paths.groupsFile);
const v1 = loadVersion(config.paths.cutoverDir, 'v0001');
const v2 = loadVersion(config.paths.cutoverDir, 'v0002');
const v3 = loadVersion(config.paths.cutoverDir, 'v0003');
// Free text no redaction pattern masks, so it reaches a log only if interpolated there.
const FREE_TEXT = ['Jane', 'Doe', 'salary', '91250'].join(' ');
const SERVICE_URLS = Object.fromEntries(
  ['identity', 'people', 'programs-sites', 'strategies-content', 'communications', 'reporting', 'surveys', 'timesheets', 'finance', 'e-signature'].map(
    (s, i) => [s, `http://127.0.0.1:${String(26211 + i)}`],
  ),
);

type Call = [string, ...unknown[]];

function harness(opts: { active: string; restartCmd?: string; inflight?: CutoverStatus['inflight']; instances?: CutoverStatus['instances'] }) {
  const calls: Call[] = [];
  let now = Date.parse('2026-06-30T12:00:00.000Z');
  const status: CutoverStatus = {
    tableVersion: opts.active,
    previous: null,
    epoch: 10,
    groupAuthority: {},
    frozen: [],
    instances: opts.instances ?? [{ instanceId: 'gw-1', seenEpoch: 10, heartbeatAt: '2026-06-30T12:00:00Z', live: true }],
    acknowledgedEpoch: 10,
    inflight: opts.inflight ?? [],
    sessionMode: 'target-primary',
  };
  const gateway = {
    status: vi.fn(async () => ({ ...status })),
    freeze: vi.fn(async (routes: readonly string[]) => {
      calls.push(['freeze', routes.length]);
      status.epoch += 1;
      return { ...status };
    }),
    unfreeze: vi.fn(async (routes: readonly string[]) => {
      calls.push(['unfreeze', routes.length]);
      status.epoch += 1;
      return { ...status };
    }),
    activate: vi.fn(async (v: string) => {
      calls.push(['activate', v]);
      status.tableVersion = v;
      status.epoch += 1;
      return { tableVersion: v, epoch: status.epoch };
    }),
    awaitEpoch: vi.fn(async (epoch: number) => {
      calls.push(['awaitEpoch', epoch]);
      return { ...status };
    }),
    awaitInflightDrained: vi.fn(async (routes: readonly string[]) => {
      calls.push(['awaitInflight', routes.length]);
      const live = new Set(status.instances.filter((i) => i.live).map((i) => i.instanceId));
      return { orphans: status.inflight.filter((row) => !live.has(row.instanceId)) };
    }),
    clearOrphans: vi.fn(async (req: { side: string; instanceIds?: string[] }) => {
      calls.push(['clearOrphans', req.side, req]);
      const before = status.inflight.length;
      status.inflight = status.inflight.filter((row) => row.side !== req.side || !(req.instanceIds ?? []).includes(row.instanceId));
      return { cleared: before - status.inflight.length };
    }),
  };
  const owners = {
    gate: vi.fn(async (owner: string, req: { op: string; units: string[]; state?: string; allowLegacy?: boolean }) => {
      calls.push(['gate', owner, req.op, req.units, req.state ?? req.allowLegacy ?? null]);
      return { units: [] };
    }),
    watermark: vi.fn(async () => ({ legacyTable: 'tfiles', direction: 'forward', snapshotSeq: 3, backupLsn: null, finishedAt: 'x' })),
  };
  const client = {
    request: vi.fn(async (req: { service: string; path: string }) => {
      calls.push(['queue', req.service, req.path]);
      return { status: 200, headers: {}, body: { queue: 'q', service: req.service, ensured: {} } };
    }),
    close: vi.fn(),
  };
  const exportJobs: string[][] = [];
  const pool = {
    request: () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('OBJECT_ID')) return { recordset: [{ present: 1 }] };
        const next = exportJobs.shift() ?? [];
        return { recordset: next.map((job_id) => ({ job_id })) };
      }),
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    env: { OPT2_SERVICE_URLS: SERVICE_URLS, OPT2_LEGACY_RESTART_CMD: opts.restartCmd, MURA_DATABASE: 'muradb_c62' },
    config,
    clock: { now: () => new Date(now) },
    logger,
    db: {},
    legacy: { live: async () => pool },
    bridge: {},
    catalog,
    owners,
    gateway,
    client,
    clientAs: () => client,
    close: async () => undefined,
  } as unknown as MigrationContext;
  const scheduler = {
    pauseFor: vi.fn(async () => {
      calls.push(['pauseFor']);
      return { siteMonitor: ['monitor'], surveys: [] };
    }),
    handOffSiteMonitorToTarget: vi.fn(async () => {
      calls.push(['handOffSiteMonitor']);
      return { deletedTasks: ['monitor'], cursor: null, recurringEnabled: true };
    }),
    handOffSurveysToTarget: vi.fn(async () => {
      calls.push(['handOffSurveys']);
      return { adopted: [], deleted: [] };
    }),
    restoreToLegacy: vi.fn(async (_units: unknown, scope: unknown) => {
      calls.push(['restoreToLegacy', scope]);
      return { siteMonitor: [], surveys: [] };
    }),
    resumePaused: vi.fn(async () => {
      calls.push(['resumePaused']);
      return { siteMonitor: [], surveys: [] };
    }),
  };
  const persisted: TransitionProgress[] = [];
  const projector = {
    awaitProjection: vi.fn(async (req: unknown) => {
      calls.push(['awaitProjection', req]);
      return { positions: new Map(), waitedMs: 1 };
    }),
  };
  const windows = { get: vi.fn(async (id: string) => ({ windowId: id, routeKey: 'admin:x', state: 'open', phase: 'executing' })) };
  const startupGuard = { ensureEmpty: vi.fn(async () => ({ initialCount: 0, reloaded: false, finalCount: 0 })) };
  const deps = {
    ctx,
    projector,
    windows,
    scheduler,
    startupGuard,
    persist: vi.fn(async (p: TransitionProgress) => {
      const copy = structuredClone(p);
      persisted.push(copy);
      calls.push(['persist', copy]);
    }),
    sleep: vi.fn(async (ms: number) => {
      now += ms;
    }),
  } as unknown as StepDeps;
  return { ctx, deps, calls, status, gateway, owners, client, scheduler, projector, windows, startupGuard, persisted, exportJobs, advance: (ms: number) => (now += ms) };
}

function newRecord(from: string, to: string): TransitionRecord {
  return {
    transitionId: 'TRANSITION-0000-0000-000000000000001',
    from,
    to,
    state: 'started',
    lastStep: 0,
    progress: initialTransitionProgress(),
    steps: [],
    startedAt: '2026-06-30T12:00:00.000Z',
    updatedAt: '2026-06-30T12:00:00.000Z',
  };
}

async function runAll(h: ReturnType<typeof harness>, record: TransitionRecord, until: TransitionStepNumber = 8): Promise<TransitionRecord> {
  for (let step = record.lastStep + 1; step <= until; step++) {
    const out = await runTransitionStep(h.deps, record, step as TransitionStepNumber);
    record = { ...record, plan: out.plan ?? record.plan, progress: out.progress, lastStep: step as TransitionStepNumber };
  }
  return record;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.acquireLeases.mockResolvedValue([]);
  m.releaseLeases.mockResolvedValue(1);
  m.takeSnapshot.mockResolvedValue({ seq: 7, databaseName: 'snap7', manifestComplete: true, fileStore: { status: 'ok', objects: 0 } });
  m.requireSnapshot.mockResolvedValue({ seq: 7, databaseName: 'snap7', manifestComplete: true, fileStore: { status: 'ok', objects: 0 } });
  m.restartFeedFor.mockResolvedValue({ snapshotSeq: 7, units: [], tables: [] });
  m.reconcileUnits.mockImplementation(async (_ctx: unknown, o: { point: string }) => ({
    point: o.point,
    result: 'zero-difference',
    summary: { differences: 0, unitsWithDifferences: 0 },
  }));
  m.writeReconciliationReport.mockImplementation(async (_ctx: unknown, r: { point: string }) => `/r/reconciliation/${r.point}.json`);
  m.awaitDrained.mockResolvedValue({ owners: [], polls: 1, elapsedMs: 0 });
  m.restartLegacy.mockResolvedValue({ exitCode: 0, durationMs: 1200 });
  m.opt2SyncReady.mockResolvedValue(true);
  m.countStartupRows.mockResolvedValue(0);
  m.readSchedulerState.mockResolvedValue({ sitemonitor: { nativeExisted: true, state: 'target' } });
  m.freezeLegacyBound.mockResolvedValue({ routes: ['r'], epoch: 3 });
  m.unfreezeLegacyBound.mockResolvedValue(undefined);
  m.sendReloadRequest.mockResolvedValue({ status: 200 });
  m.diffSnapshotManifests.mockResolvedValue({ toTransfer: [{ siteId: 'a', path: 'p' }] });
  m.transferFiles.mockResolvedValue({ transferred: 1, unchanged: 0 });
});

describe('constants', () => {
  it('step names equal the run-log names and states map onto the contract', () => {
    expect(TRANSITION_STEPS.map((s) => s.name)).toEqual([...TRANSITION_STEP_NAMES]);
    expect(TRANSITION_STEPS.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(TERMINAL_TRANSITION_STATES).toEqual(['completed', 'aborted', 'failed']);
    expect(contractTransitionState('reconciling')).toBe('running');
    expect(contractTransitionState('aborting')).toBe('running');
    expect(contractTransitionState('failed')).toBe('aborted');
    expect(contractTransitionState('aborted')).toBe('aborted');
    expect(contractTransitionState('completed')).toBe('completed');
  });
});

describe('deriveTransitionPlan', () => {
  it('v0001 -> v0002 moves the carry groups to target only', () => {
    const plan = deriveTransitionPlan(v1, v2, groups, catalog);
    expect(plan.from).toBe('v0001');
    expect(plan.to).toBe('v0002');
    expect(plan.toLegacy).toEqual([]);
    expect(plan.setT).toEqual(plan.toTarget);
    expect(plan.setT).toContain('people.person_archive');
    expect(plan.setT).toContain('timesheets.blackout');
    expect(plan.setT).toEqual([...plan.setT].sort());
    expect(plan.returnsToLegacy).toBe(false);
    expect(plan.siteMonitorEntryMoves).toBe(true);
    expect(plan.exportJobsWriteT).toBe(true);
    expect(plan.contentToTarget).toBe(false);
    const routes = new Set(v1.entries.map((e) => e.route));
    expect(plan.frozenRoutes.every((r) => routes.has(r))).toBe(true);
    expect(plan.frozenRoutes.length).toBeGreaterThan(0);
    expect(plan.owners).toEqual([...new Set(plan.setT.map((u) => catalog.ownerOf(u)))].sort());
  });

  it('v0002 -> v0003 returns the roster set R to legacy', () => {
    const plan = deriveTransitionPlan(v2, v3, groups, catalog);
    expect(plan.setT).toEqual(['people.person_archive', 'timesheets.blackout']);
    expect(plan.toLegacy).toEqual(plan.setT);
    expect(plan.toTarget).toEqual([]);
    expect(plan.returnsToLegacy).toBe(true);
    expect(plan.owners).toEqual(['people', 'timesheets']);
    expect(plan.siteMonitorEntryMoves).toBe(false);
    expect(plan.exportJobsWriteT).toBe(false);
    expect(plan.entriesChanged.every((e) => e.entry.units.some((u) => plan.setT.includes(u)) || e.entry.kind !== 'write')).toBe(true);
  });

  it('treats a table the catalog does not list as feeding no unit', () => {
    const fake = {
      ownerOf: (u: string) => catalog.ownerOf(u),
      unitsForLegacyTable: (t: string) => {
        throw new UnknownLegacyTableError(t);
      },
    } as unknown as UnitCatalog;
    expect(deriveTransitionPlan(v2, v3, groups, fake).exportJobsWriteT).toBe(false);
    const boom = { ...fake, unitsForLegacyTable: () => { throw new Error('boom'); } } as unknown as UnitCatalog;
    expect(() => deriveTransitionPlan(v2, v3, groups, boom)).toThrow('boom');
  });
});

describe('queuesToPause', () => {
  it('pauses non-sweep queues whose creator or target owns T, at the creator', () => {
    expect(queuesToPause(['surveys'], SERVICE_URLS)).toEqual([{ service: 'communications', queue: 'surveys-launch' }]);
    expect(queuesToPause(['communications'], SERVICE_URLS)).toEqual([
      { service: 'communications', queue: 'communications-reminders' },
      { service: 'communications', queue: 'surveys-launch' },
    ]);
    expect(queuesToPause(['people', 'timesheets'], SERVICE_URLS)).toEqual([]);
    expect(queuesToPause(['surveys'], { surveys: 'http://x' })).toEqual([]);
    const all = queuesToPause(['strategies-content', 'programs-sites'], SERVICE_URLS);
    expect(all.some((q) => q.queue.endsWith('-outbox-sweep'))).toBe(false);
    expect(all).toContainEqual({ service: 'programs-sites', queue: 'content-feed-import' });
    expect(all).toContainEqual({ service: 'strategies-content', queue: 'content-scheduled-publish' });
  });
});

describe('planTransition preconditions', () => {
  it('refuses the active version, a version not following it, no active version, and a target move without opt2_sync', async () => {
    const h = harness({ active: 'v0002' });
    await expect(planTransition(h.ctx, 'v0002')).rejects.toMatchObject({ code: 'same-version', statusCode: 409 });
    const h1 = harness({ active: 'v0001' });
    await expect(planTransition(h1.ctx, 'v0003')).rejects.toMatchObject({ code: 'previous-mismatch' });
    const h0 = harness({ active: 'v0001' });
    h0.status.tableVersion = null;
    await expect(planTransition(h0.ctx, 'v0002')).rejects.toBeInstanceOf(TransitionPreconditionError);
    m.opt2SyncReady.mockResolvedValue(false);
    await expect(planTransition(h1.ctx, 'v0002')).rejects.toMatchObject({ code: 'opt2-sync-unavailable' });
    // Returning to legacy needs no opt2_sync check.
    const plan = await planTransition(h.ctx, 'v0003');
    expect(plan.toLegacy.length).toBe(2);
  });
});

describe('full run v0002 -> v0003', () => {
  it('drains with gates open, closes, projects, reconciles, activates, then reopens as legacy and unfreezes', async () => {
    const h = harness({ active: 'v0002' });
    const record = await runAll(h, newRecord('v0002', 'v0003'));
    const names = h.calls.map((c) => c[0]);
    const idx = (n: string) => names.indexOf(n);
    expect(idx('pauseFor')).toBeLessThan(idx('freeze'));
    expect(m.awaitDrained).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ owners: ['people', 'timesheets'], consumersWriting: record.plan?.setT }));
    const gateCalls = h.calls.filter((c) => c[0] === 'gate');
    expect(gateCalls.slice(0, 2).map((c) => c[2])).toEqual(['close', 'close']);
    expect(gateCalls.slice(0, 2).map((c) => c[4])).toEqual([null, null]);
    expect(idx('freeze')).toBeLessThan(idx('gate'));
    // Intents are persisted before the calls an abort must undo.
    const persistedBefore = (call: number) => h.calls.slice(0, call).filter((c) => c[0] === 'persist').at(-1)?.[1] as TransitionProgress;
    expect(persistedBefore(idx('freeze')).freezeRequested).toBe(true);
    expect(persistedBefore(idx('gate')).closedGates.map((g) => g.unit)).toContain((gateCalls[0]?.[3] as string[])[0]);
    expect(idx('awaitProjection')).toBeLessThan(idx('activate'));
    expect(h.calls.find((c) => c[0] === 'awaitProjection')?.[1]).toMatchObject({ owners: ['people', 'timesheets'], timeoutMs: config.projection.defaultAwaitTimeoutMs });
    expect(m.reconcileUnits).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ point: 'rollback-before', legacySource: 'live', database: 'muradb_c62', units: ['people.person_archive', 'timesheets.blackout'] }));
    expect(m.takeSnapshot).not.toHaveBeenCalled();
    const opens = gateCalls.filter((c) => c[2] === 'open');
    expect(opens.map((c) => c[4])).toEqual(['legacy', 'legacy']);
    expect(names.lastIndexOf('gate')).toBeGreaterThan(idx('activate'));
    expect(idx('unfreeze')).toBeGreaterThan(names.lastIndexOf('gate'));
    expect(h.calls.find((c) => c[0] === 'restoreToLegacy')?.[1]).toEqual({ siteMonitorUnits: record.plan?.siteMonitorUnits, siteMonitorEntryMoves: false });
    expect(m.releaseLeases).toHaveBeenCalledWith(h.ctx, record.transitionId);
    expect(record.progress.rebaselineRequired).toEqual(['people.person_archive', 'timesheets.blackout']);
    expect(record.progress.closedGates).toEqual([]);
    expect(record.progress.freezeRequested).toBe(false);
    expect(record.progress.reconciliation).toEqual({ point: 'rollback-before', result: 'zero-difference', differences: 0, reportPath: '/r/reconciliation/rollback-before.json' });
    expect(h.scheduler.handOffSiteMonitorToTarget).not.toHaveBeenCalled();
    expect(m.acquireLeases).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ units: record.plan?.setT, kind: 'transition', budgetMs: config.windows.openBudgetMs }));
    // Resuming step 8 repeats nothing that would fail on the new version.
    const unfreezes = h.gateway.unfreeze.mock.calls.length;
    await runTransitionStep(h.deps, { ...record, lastStep: 7 }, 8);
    expect(h.gateway.unfreeze.mock.calls.length).toBe(unfreezes);
    expect(h.scheduler.restoreToLegacy).toHaveBeenCalledTimes(1);
  });
});

describe('full run v0001 -> v0002', () => {
  it('snapshots, brings T to it, hands schedulers to the target and reconciles post-cutover', async () => {
    const h = harness({ active: 'v0001' });
    h.exportJobs.push(['JOB-1'], []);
    const record = await runAll(h, newRecord('v0001', 'v0002'));
    expect(h.deps.sleep).toHaveBeenCalled();
    expect(m.takeSnapshot).toHaveBeenCalledWith(h.ctx, { kind: 'transition', holderId: record.transitionId });
    expect(m.restartFeedFor).toHaveBeenCalledWith(h.ctx, { units: record.plan?.toTarget, snapshotSeq: 7 });
    expect(m.transferFiles).not.toHaveBeenCalled();
    expect(m.reconcileUnits).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ point: 'post-cutover', snapshotSeq: 7 }));
    expect(h.scheduler.handOffSiteMonitorToTarget).toHaveBeenCalledTimes(1);
    expect(h.scheduler.handOffSurveysToTarget).toHaveBeenCalledTimes(1);
    expect(h.scheduler.restoreToLegacy).not.toHaveBeenCalled();
    expect(h.gateway.activate).toHaveBeenCalledWith('v0002');
    expect(record.progress.activatedEpoch).toBe(h.status.epoch - 1);
    const opens = h.calls.filter((c) => c[0] === 'gate' && c[2] === 'open');
    expect(opens.every((c) => c[4] === 'open')).toBe(true);
    const closes = h.calls.filter((c) => c[0] === 'gate' && c[2] === 'close');
    expect(closes.every((c) => c[4] === true)).toBe(true);
    const pauses = h.calls.filter((c) => c[0] === 'queue' && String(c[2]).endsWith('/pause'));
    const resumes = h.calls.filter((c) => c[0] === 'queue' && String(c[2]).endsWith('/resume'));
    expect(pauses.length).toBeGreaterThan(0);
    expect(resumes.length).toBe(pauses.length);
    expect(h.calls.some((c) => c[0] === 'queue' && String(c[2]).includes('programs-sites-sitemonitor/ensure'))).toBe(true);
    expect(record.progress.rebaselineRequired).toEqual([]);
    // Resume of step 7 after activation: no second activation.
    await runTransitionStep(h.deps, { ...record, lastStep: 6 }, 7);
    expect(h.gateway.activate).toHaveBeenCalledTimes(1);
  });

  it('logs only the queue and service of each recurring chain step 8 could not ensure, never the failure text', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'), 7);
    const answer = h.client.request.getMockImplementation();
    h.client.request.mockImplementation(async (req) => {
      if (req.path.endsWith('/ensure')) throw new Error(`queue control answered ${FREE_TEXT}`);
      return answer!(req);
    });
    vi.mocked(h.ctx.logger.warn).mockClear();
    await runTransitionStep(h.deps, record, 8);
    const warnings = vi.mocked(h.ctx.logger.warn).mock.calls;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual([
      expect.stringMatching(
        new RegExp(`^Transition ${record.transitionId}: recurring chains not ensured, left to the periodic reconcile: [a-z0-9-]+ on [a-z0-9-]+(, [a-z0-9-]+ on [a-z0-9-]+)*$`),
      ),
    ]);
    expect(JSON.stringify(warnings)).not.toContain(FREE_TEXT);
  });

  it('transfers files and runs the start-up guard when content moves', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'), 5);
    const plan = { ...record.plan!, contentToTarget: true, toTarget: [...record.plan!.toTarget, 'content.file'], setT: [...record.plan!.setT, 'content.file'] };
    const out = await runTransitionStep(h.deps, { ...record, plan, lastStep: 5 }, 6);
    expect(h.startupGuard.ensureEmpty).toHaveBeenCalledWith({ holderId: record.transitionId, exceptRoutes: plan.frozenRoutes });
    expect(m.diffSnapshotManifests).toHaveBeenCalledWith(h.ctx, 3, 7);
    expect(m.transferFiles).toHaveBeenCalledWith(h.ctx, 7, { only: [{ siteId: 'a', path: 'p' }] });
    expect(m.reconcileUnits).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({ units: expect.arrayContaining(['content.file', 'content.file_object']) }));
    expect(out.progress.startupGuard).toEqual({ initialCount: 0, reloaded: false, finalCount: 0 });
    // Resume reuses the snapshot; no watermark means a full transfer; a base at the snapshot transfers nothing.
    h.owners.watermark.mockResolvedValueOnce(null as never);
    await runTransitionStep(h.deps, { ...record, plan, progress: out.progress, lastStep: 5 }, 6);
    expect(m.requireSnapshot).toHaveBeenCalledWith(h.ctx, 7);
    expect(m.transferFiles).toHaveBeenLastCalledWith(h.ctx, 7, {});
    h.owners.watermark.mockResolvedValueOnce({ snapshotSeq: 7 } as never);
    m.transferFiles.mockClear();
    await runTransitionStep(h.deps, { ...record, plan, progress: out.progress, lastStep: 5 }, 6);
    expect(m.transferFiles).not.toHaveBeenCalled();
    // Incomplete manifest and a guard that cannot clear both abort.
    m.requireSnapshot.mockResolvedValueOnce({ seq: 7, manifestComplete: false, fileStore: { status: 'unsupported', fileStore: 's3', siteId: 'default' } });
    await expect(runTransitionStep(h.deps, { ...record, plan, progress: out.progress, lastStep: 5 }, 6)).rejects.toThrow(/s3/);
    m.requireSnapshot.mockResolvedValueOnce({ seq: 7, manifestComplete: false, fileStore: null });
    await expect(runTransitionStep(h.deps, { ...record, plan, progress: out.progress, lastStep: 5 }, 6)).rejects.toThrow(/no complete file manifest, so/);
    h.startupGuard.ensureEmpty.mockResolvedValueOnce({ initialCount: 2, reloaded: true, finalCount: 1 });
    await expect(runTransitionStep(h.deps, { ...record, plan, lastStep: 5 }, 6)).rejects.toBeInstanceOf(TransitionAbortedError);
  });
});

describe('aborts', () => {
  it('a reconciliation difference aborts at step 6 and the abort undoes gates, freeze, queues, tasks and leases', async () => {
    const h = harness({ active: 'v0001' });
    m.reconcileUnits.mockResolvedValueOnce({ point: 'post-cutover', result: 'difference', summary: { differences: 3, unitsWithDifferences: 1 } });
    let record = await runAll(h, newRecord('v0001', 'v0002'), 5);
    const err = await runTransitionStep(h.deps, record, 6).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransitionAbortedError);
    expect((err as TransitionAbortedError).step).toBe(6);
    expect((err as TransitionAbortedError).reason).toContain('/r/reconciliation/post-cutover.json');
    record = { ...record, progress: h.persisted.at(-1)! };
    h.calls.length = 0;
    const cleaned = await abortTransition(h.deps, record);
    expect(h.gateway.activate).not.toHaveBeenCalled();
    const opens = h.calls.filter((c) => c[0] === 'gate');
    expect(opens.every((c) => c[2] === 'open' && c[4] === 'legacy')).toBe(true);
    expect(opens.flatMap((c) => c[3] as string[]).sort()).toEqual(record.plan?.setT);
    const names = h.calls.map((c) => c[0]);
    expect(names.indexOf('unfreeze')).toBeGreaterThan(names.lastIndexOf('gate'));
    expect(h.scheduler.resumePaused).toHaveBeenCalled();
    expect(m.releaseLeases).toHaveBeenCalledWith(h.ctx, record.transitionId);
    expect(cleaned.closedGates).toEqual([]);
    expect(cleaned.pausedQueues).toEqual([]);
    expect(cleaned.freezeRequested).toBe(false);
    expect(cleaned.schedulerPause).toBeUndefined();
    expect(h.status.tableVersion).toBe('v0001');
    // A gate another holder took is skipped; abort completes.
    h.owners.gate.mockRejectedValueOnce(new GateConflict('people', { error: 'gate-conflict', units: ['people.person_archive'] }));
    await expect(abortTransition(h.deps, record)).resolves.toBeDefined();
    h.owners.gate.mockRejectedValueOnce(new Error('down'));
    await expect(abortTransition(h.deps, record)).rejects.toThrow('down');
  });

  it('logs the abort as a fixed line naming the transition and its version, never the reason', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'), 5);
    vi.mocked(h.ctx.logger.warn).mockClear();
    await abortTransition(h.deps, { ...record, abortReason: `difference in ${FREE_TEXT}` });
    expect(vi.mocked(h.ctx.logger.warn).mock.calls).toEqual([[`Transition ${record.transitionId} to v0002 aborting`]]);
  });

  it('refuses to abort an activated transition and aborts before a plan with leases only', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'), 7);
    await expect(abortTransition(h.deps, record)).rejects.toThrow(/no longer abort/);
    await expect(abortTransition(h.deps, { ...record, lastStep: 6 })).rejects.toThrow(/already active/);
    const fresh = await abortTransition(h.deps, newRecord('v0001', 'v0002'));
    expect(fresh).toEqual(initialTransitionProgress());
    expect(h.scheduler.resumePaused).not.toHaveBeenCalled();
  });

  it('a lease blocker aborts naming each holder, a write window with its route and phase', async () => {
    const h = harness({ active: 'v0002' });
    m.acquireLeases.mockRejectedValueOnce(new LeaseUnavailableError(['people.person_archive'], 'T', ['WIN-1', 'TR-2']));
    h.windows.get.mockImplementation(async (id: string) => {
      if (id === 'TR-2') throw new WindowNotFoundError(id);
      return { windowId: id, routeKey: 'admin:cusers.update', state: 'open', phase: 'executing' } as never;
    });
    const lease = await runTransitionStep(h.deps, newRecord('v0002', 'v0003'), 1).catch((e: unknown) => e);
    expect((lease as TransitionAbortedError).reason).toMatch(/WIN-1 \(admin:cusers.update, open, phase executing\); TR-2 \(no write window\)/);
    m.acquireLeases.mockRejectedValueOnce(new LeaseUnavailableError(['x'], 'T', []));
    await expect(runTransitionStep(h.deps, newRecord('v0002', 'v0003'), 1)).rejects.toThrow(/another holder/);
    m.acquireLeases.mockRejectedValueOnce(new LeaseUnavailableError(['x'], 'T', ['W']));
    h.windows.get.mockRejectedValueOnce(new Error('db'));
    await expect(runTransitionStep(h.deps, newRecord('v0002', 'v0003'), 1)).rejects.toThrow('db');
    await expect(runTransitionStep(h.deps, { ...newRecord('v0002', 'v0003'), plan: undefined }, 4)).rejects.toThrow(/no plan/);
  });

  type Rejectable = { mockRejectedValueOnce(error: unknown): unknown };
  const blockers: { name: string; from: string; to: string; step: TransitionStepNumber; target: (h: ReturnType<typeof harness>) => Rejectable; blocker: () => Error }[] = [
    { name: 'lease', from: 'v0002', to: 'v0003', step: 1, target: () => m.acquireLeases, blocker: () => new LeaseUnavailableError(['x'], 'T', ['W']) },
    { name: 'epoch ack', from: 'v0002', to: 'v0003', step: 2, target: (h) => h.gateway.awaitEpoch, blocker: () => new GatewayWaitTimeoutError({ kind: 'epoch', epoch: 11, lagging: [] }) },
    { name: 'in-flight drain', from: 'v0002', to: 'v0003', step: 3, target: (h) => h.gateway.awaitInflightDrained, blocker: () => new GatewayWaitTimeoutError({ kind: 'inflight', pending: [] }) },
    { name: 'effect drain', from: 'v0002', to: 'v0003', step: 4, target: () => m.awaitDrained, blocker: () => new DrainTimeoutError(5, []) },
    { name: 'gate holder', from: 'v0002', to: 'v0003', step: 5, target: (h) => h.owners.gate, blocker: () => new GateConflict('people', { error: 'gate-conflict', units: ['people.person_archive'] }) },
    { name: 'projection', from: 'v0002', to: 'v0003', step: 6, target: (h) => h.projector.awaitProjection, blocker: () => new ProjectionTimeoutError([], 5000) },
    { name: 'snapshot lease', from: 'v0001', to: 'v0002', step: 6, target: () => m.takeSnapshot, blocker: () => new SnapshotBlockedError([{ holderId: 'W', kind: 'window', units: ['x'] }]) },
    { name: 'activation refusal', from: 'v0002', to: 'v0003', step: 7, target: (h) => h.gateway.activate, blocker: () => new GatewayCallError('cutoverActivate', 409, { findings: [] }) },
  ];

  async function before(from: string, to: string, step: TransitionStepNumber): Promise<{ h: ReturnType<typeof harness>; record: TransitionRecord }> {
    const h = harness({ active: from });
    const record = step === 1 ? newRecord(from, to) : await runAll(h, newRecord(from, to), (step - 1) as TransitionStepNumber);
    return { h, record };
  }

  it.each(blockers)('step $step aborts on a $name blocker', async ({ from, to, step, target, blocker }) => {
    const { h, record } = await before(from, to, step);
    target(h).mockRejectedValueOnce(blocker());
    await expect(runTransitionStep(h.deps, record, step)).rejects.toMatchObject({ name: 'TransitionAbortedError', step });
  });

  it.each(blockers)('step $step passes any other $name failure through unchanged', async ({ from, to, step, target }) => {
    const { h, record } = await before(from, to, step);
    const failure = step === 7 ? new GatewayCallError('cutoverActivate', 503, {}) : new Error('unavailable');
    target(h).mockRejectedValueOnce(failure);
    await expect(runTransitionStep(h.deps, record, step)).rejects.toBe(failure);
  });
});

describe('orphans and export jobs', () => {
  const orphan = { instanceId: 'gw-dead', route: '', side: 'legacy' as const, count: 1, oldestStartedAt: '2026-06-30T11:59:00Z' };
  const dead = { instanceId: 'gw-dead', seenEpoch: 5, heartbeatAt: '2026-06-30T11:00:00Z', live: false };
  const live = { instanceId: 'gw-1', seenEpoch: 10, heartbeatAt: '2026-06-30T12:00:00Z', live: true };

  it('without a restart command the transition aborts naming the orphan; time alone clears nothing', async () => {
    const plan = deriveTransitionPlan(v2, v3, groups, catalog);
    const row = { ...orphan, route: plan.frozenRoutes[0]! };
    const h = harness({ active: 'v0002', inflight: [row], instances: [live, dead] });
    const record = await runAll(h, newRecord('v0002', 'v0003'), 2);
    h.advance(3_600_000);
    const err = (await runTransitionStep(h.deps, record, 3).catch((e: unknown) => e)) as TransitionAbortedError;
    expect(err.step).toBe(3);
    expect(err.reason).toContain(row.route);
    expect(err.reason).toContain('gw-dead');
    expect(h.gateway.clearOrphans).not.toHaveBeenCalled();
    expect(m.restartLegacy).not.toHaveBeenCalled();
  });

  it('with a restart command restarts once, clears with evidence, leases the content units and continues', async () => {
    const plan = deriveTransitionPlan(v2, v3, groups, catalog);
    const row = { ...orphan, route: plan.frozenRoutes[0]! };
    const target = { ...orphan, side: 'target' as const, route: plan.frozenRoutes[0]!, instanceId: 'gw-dead' };
    const h = harness({ active: 'v0002', restartCmd: 'restart.sh', inflight: [row, target], instances: [live, dead] });
    const record = await runAll(h, newRecord('v0002', 'v0003'), 3);
    expect(m.restartLegacy).toHaveBeenCalledTimes(1);
    expect(m.restartLegacy).toHaveBeenCalledWith(h.ctx.env, { timeoutMs: config.windows.gatewayLeaseMs, extraEnv: { OPT2_STARTUP_WINDOW_HOLDER: record.transitionId } });
    const legacyClear = h.calls.find((c) => c[0] === 'clearOrphans' && c[1] === 'legacy')?.[2];
    expect(legacyClear).toMatchObject({ side: 'legacy', evidence: { kind: 'legacy-restart', holderId: record.transitionId }, instanceIds: ['gw-dead'] });
    expect(record.progress.legacyOrphansCleared).toMatchObject({ cleared: 1, durationMs: 1200 });
    expect(record.progress.extraLeasedUnits).toEqual(contentUnits(catalog));
    expect(m.acquireLeases).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({ units: contentUnits(catalog), kind: 'transition' }));
    expect(record.progress.targetOrphans).toHaveLength(1);
    const after5 = await runAll(h, record, 5);
    const targetClear = h.calls.find((c) => c[0] === 'clearOrphans' && c[1] === 'target')?.[2];
    expect(targetClear).toMatchObject({ evidence: { kind: 'gates-closed', units: plan.setT } });
    expect(after5.progress.targetOrphansCleared).toBe(1);
    const names = h.calls.map((c) => c[0]);
    expect(names.lastIndexOf('gate')).toBeLessThan(names.lastIndexOf('clearOrphans'));
  });

  it('a failed restart aborts and orphans left after a restart abort', async () => {
    const plan = deriveTransitionPlan(v2, v3, groups, catalog);
    const row = { ...orphan, route: plan.frozenRoutes[0]! };
    const h = harness({ active: 'v0002', restartCmd: 'restart.sh', inflight: [row], instances: [live, dead] });
    const record = await runAll(h, newRecord('v0002', 'v0003'), 2);
    m.restartLegacy.mockRejectedValueOnce(new LegacyRestartError('exit 1', { exitCode: 1, signal: null, timedOut: false, outputTail: '' }));
    await expect(runTransitionStep(h.deps, record, 3)).rejects.toMatchObject({ step: 3 });
    m.restartLegacy.mockRejectedValueOnce(new Error('spawn'));
    await expect(runTransitionStep(h.deps, record, 3)).rejects.toThrow('spawn');
    h.gateway.clearOrphans.mockResolvedValueOnce({ cleared: 0 });
    await expect(runTransitionStep(h.deps, record, 3)).rejects.toThrow(/remain after the restart/);
  });

  it('waits for fixture export jobs and aborts naming those still running', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'), 2);
    h.exportJobs.push(...Array.from({ length: 2000 }, () => ['JOB-9']));
    const err = (await runTransitionStep(h.deps, record, 3).catch((e: unknown) => e)) as TransitionAbortedError;
    expect(err.reason).toContain('JOB-9');
  });
});

describe('createTransitionStartupGuard', () => {
  it('does nothing without matching rows and reloads with legacy-bound entries frozen otherwise', async () => {
    const h = harness({ active: 'v0001' });
    const guard = createTransitionStartupGuard(h.ctx);
    m.countStartupRows.mockResolvedValueOnce(0);
    expect(await guard.ensureEmpty({ holderId: 'T', exceptRoutes: ['a'] })).toEqual({ initialCount: 0, reloaded: false, finalCount: 0 });
    expect(m.sendReloadRequest).not.toHaveBeenCalled();
    m.countStartupRows.mockResolvedValueOnce(4).mockResolvedValueOnce(0);
    expect(await guard.ensureEmpty({ holderId: 'T', exceptRoutes: ['a'] })).toEqual({ initialCount: 4, reloaded: true, finalCount: 0 });
    expect(m.freezeLegacyBound).toHaveBeenCalledWith(h.ctx, { exceptRoutes: ['a'] });
    expect(m.unfreezeLegacyBound).toHaveBeenCalledWith(h.ctx, { routes: ['r'], epoch: 3 });
    m.countStartupRows.mockResolvedValueOnce(4);
    m.sendReloadRequest.mockRejectedValueOnce(new Error('reload'));
    await expect(guard.ensureEmpty({ holderId: 'T', exceptRoutes: [] })).rejects.toThrow('reload');
    expect(m.unfreezeLegacyBound).toHaveBeenCalledTimes(2);
  });
});
