// Unit tests of the transition step engine over fakes and the committed cut-over versions.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { GatewayCallError, GatewayWaitTimeoutError, currentAuthority, loadGroups, loadVersion, type CutoverStatus } from '../../src/cutover/index.js';
import type { MigrationContext } from '../../src/context.js';
import { GateConflict, UnknownLegacyTableError, loadUnitCatalog, type UnitCatalog } from '../../src/owners/index.js';
import { DrainTimeoutError } from '../../src/quiesce/index.js';
import { DIFFERENCE_LIMIT } from '../../src/reconcile/index.js';
import { TRANSITION_STEP_NAMES } from '../../src/reports/index.js';
import { ProjectionTimeoutError } from '../../src/reverse/index.js';
import { SnapshotBlockedError } from '../../src/snapshot/index.js';
import { LeaseUnavailableError, WindowImportError, WindowNotFoundError, contentUnits } from '../../src/windows/index.js';
import type { FrozenRoutes } from '../../src/windows/reload.js';
import { LegacyRestartError, StartupGuardFrozenError } from '../../src/legacy/index.js';
import { TransitionClaimLostError, claimFences, type ClaimFence } from '../../src/transition/claim.js';
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
  type TransitionStartupGuard,
  type TransitionStepNumber,
} from '../../src/transition/steps.js';

const m = vi.hoisted(() => ({
  acquireLeases: vi.fn(),
  releaseLeases: vi.fn(),
  takeSnapshot: vi.fn(),
  requireSnapshot: vi.fn(),
  latestSnapshot: vi.fn(),
  restartFeedFor: vi.fn(),
  reconcileUnits: vi.fn(),
  writeReconciliationReport: vi.fn(),
  awaitDrained: vi.fn(),
  restartLegacy: vi.fn(),
  opt2SyncReady: vi.fn(),
  countStartupRows: vi.fn(),
  diffSnapshotManifests: vi.fn(),
  transferFiles: vi.fn(),
  removeDroppedObjects: vi.fn(),
  readSchedulerState: vi.fn(),
  freezeLegacyBound: vi.fn(),
  sendReloadRequest: vi.fn(),
  unfreezeLegacyBound: vi.fn(),
  importWindow: vi.fn(),
}));

vi.mock('../../src/windows/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/windows/index.js')>()),
  acquireLeases: m.acquireLeases,
  releaseLeases: m.releaseLeases,
  importWindow: m.importWindow,
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
  latestSnapshot: m.latestSnapshot,
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
  removeDroppedObjects: m.removeDroppedObjects,
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
  const startupGuard = {
    ensureEmpty: vi.fn<TransitionStartupGuard['ensureEmpty']>(async () => ({ initialCount: 0, reloaded: false, finalCount: 0 })),
    recover: vi.fn<TransitionStartupGuard['recover']>(async () => {
      calls.push(['recoverGuard']);
      return { initialCount: 1, reloaded: true, finalCount: 0 };
    }),
  };
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

/** A reconciliation entry of `unit` and `tenantId`; any `differences` make it differ. */
function unitEntry(unit: string, tenantId: string, differences: number) {
  return { unit, legacyTable: 'tusers', tenantId, legacyCount: 1, targetCount: 1, legacySha256: 'a', targetSha256: differences > 0 ? 'b' : 'a', differenceCount: differences, files: null };
}

/** A `reconcileUnits` report over `units`, with the summary and result they add up to. */
function reportOf(point: string, units: ReturnType<typeof unitEntry>[], tableVersion: string, snapshotSeq: number) {
  const differing = units.filter((entry) => entry.differenceCount > 0);
  return {
    point,
    tableVersion,
    snapshotSeq,
    units,
    result: differing.length > 0 ? 'difference' : 'zero-difference',
    summary: { differences: differing.reduce((sum, entry) => sum + entry.differenceCount, 0), unitsWithDifferences: new Set(differing.map((entry) => entry.unit)).size },
  };
}

/** The claim fence of a drive, which refuses every effect once `taken`. */
function claimFence(): ClaimFence {
  const fence: ClaimFence = {
    validUntil: Number.POSITIVE_INFINITY,
    taken: false,
    assert() {
      if (fence.taken) throw new TransitionClaimLostError('TRANSITION-0000-0000-000000000000001');
    },
  };
  return fence;
}

/** A fence another instance takes over once the drive has persisted a progress `takenOn` selects. */
function fenceTakenOn(h: ReturnType<typeof harness>, takenOn: (progress: TransitionProgress) => boolean): ClaimFence {
  const fence = claimFence();
  const persist = h.deps.persist;
  h.deps.persist = async (progress) => {
    await persist(progress);
    if (takenOn(progress)) fence.taken = true;
  };
  return fence;
}

async function runAll(h: ReturnType<typeof harness>, record: TransitionRecord, until: TransitionStepNumber = 8): Promise<TransitionRecord> {
  for (let step = record.lastStep + 1; step <= until; step++) {
    const out = await runTransitionStep(h.deps, record, step as TransitionStepNumber);
    record = { ...record, plan: out.plan ?? record.plan, progress: out.progress, lastStep: step as TransitionStepNumber };
  }
  return record;
}

/** Freezes the mocked `freezeLegacyBound` issued, each only after its `beforeFreeze` resolved. */
const issuedFreezes: FrozenRoutes[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  issuedFreezes.length = 0;
  m.acquireLeases.mockResolvedValue([]);
  m.releaseLeases.mockResolvedValue(1);
  m.takeSnapshot.mockResolvedValue({ seq: 7, databaseName: 'snap7', manifestComplete: true, fileStore: { status: 'ok', objects: 0 } });
  m.requireSnapshot.mockResolvedValue({ seq: 7, databaseName: 'snap7', manifestComplete: true, fileStore: { status: 'ok', objects: 0 } });
  m.restartFeedFor.mockResolvedValue({ snapshotSeq: 7, units: [], tables: [] });
  m.reconcileUnits.mockImplementation(async (ctx: MigrationContext, o: { point: string; snapshotSeq: number | null }) => ({
    point: o.point,
    tableVersion: (await ctx.gateway.status()).tableVersion,
    snapshotSeq: o.snapshotSeq,
    units: [],
    result: 'zero-difference',
    summary: { differences: 0, unitsWithDifferences: 0 },
  }));
  m.writeReconciliationReport.mockImplementation(async (_ctx: unknown, r: { point: string }) => `/r/reconciliation/${r.point}.json`);
  m.awaitDrained.mockResolvedValue({ owners: [], polls: 1, elapsedMs: 0 });
  m.restartLegacy.mockResolvedValue({ exitCode: 0, durationMs: 1200 });
  m.opt2SyncReady.mockResolvedValue(true);
  m.countStartupRows.mockResolvedValue(0);
  m.readSchedulerState.mockResolvedValue({ sitemonitor: { nativeExisted: true, state: 'target' } });
  m.freezeLegacyBound.mockImplementation(async (_ctx: unknown, opts?: { beforeFreeze?: (planned: FrozenRoutes) => Promise<void> }) => {
    const planned = { routes: ['r'], epoch: 3 };
    await opts?.beforeFreeze?.(planned);
    issuedFreezes.push(planned);
    return planned;
  });
  m.unfreezeLegacyBound.mockResolvedValue(undefined);
  m.sendReloadRequest.mockResolvedValue({ status: 200 });
  m.diffSnapshotManifests.mockResolvedValue({ toTransfer: [{ siteId: 'a', path: 'p' }] });
  m.transferFiles.mockResolvedValue({ transferred: 1, unchanged: 0 });
  m.importWindow.mockResolvedValue({ rowsImported: 2, perOwner: {}, objectsTransferred: 0, objectsRemoved: [], touchedContent: false, writePositions: new Map() });
  m.removeDroppedObjects.mockResolvedValue({ deleted: 2 });
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
    expect(h.startupGuard.ensureEmpty).toHaveBeenCalledWith({ holderId: record.transitionId, exceptRoutes: plan.frozenRoutes, onFrozen: expect.any(Function) });
    expect(m.diffSnapshotManifests).toHaveBeenCalledWith(h.ctx, 3, 7);
    expect(m.transferFiles).toHaveBeenCalledWith(h.ctx, 7, { only: [{ siteId: 'a', path: 'p' }] });
    expect(m.removeDroppedObjects).toHaveBeenCalledWith(h.ctx, await m.diffSnapshotManifests.mock.results[0]?.value);
    const firstCall = (fn: { mock: { invocationCallOrder: number[] } }): number => fn.mock.invocationCallOrder[0] ?? 0;
    expect(firstCall(m.transferFiles)).toBeLessThan(firstCall(m.removeDroppedObjects));
    expect(firstCall(m.removeDroppedObjects)).toBeLessThan(firstCall(m.restartFeedFor));
    expect(h.ctx.logger.info).toHaveBeenCalledWith(
      `Transition ${record.transitionId}: file objects of snapshot 7 since 3: 1 stored, 0 unchanged, 2 deleted`,
    );
    expect(m.reconcileUnits).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({ units: expect.arrayContaining(['content.file', 'content.file_object']) }));
    expect(out.progress.startupGuard).toEqual({ initialCount: 0, reloaded: false, finalCount: 0 });
    // Resume reuses the snapshot; no watermark means a full transfer with no base to remove from; a base at the snapshot transfers nothing.
    h.owners.watermark.mockResolvedValueOnce(null as never);
    m.removeDroppedObjects.mockClear();
    await runTransitionStep(h.deps, { ...record, plan, progress: out.progress, lastStep: 5 }, 6);
    expect(m.requireSnapshot).toHaveBeenCalledWith(h.ctx, 7);
    expect(m.transferFiles).toHaveBeenLastCalledWith(h.ctx, 7, {});
    expect(m.removeDroppedObjects).not.toHaveBeenCalled();
    h.owners.watermark.mockResolvedValueOnce({ snapshotSeq: 7 } as never);
    m.transferFiles.mockClear();
    await runTransitionStep(h.deps, { ...record, plan, progress: out.progress, lastStep: 5 }, 6);
    expect(m.transferFiles).not.toHaveBeenCalled();
    expect(m.removeDroppedObjects).not.toHaveBeenCalled();
    // Incomplete manifest and a guard that cannot clear both abort.
    m.requireSnapshot.mockResolvedValueOnce({ seq: 7, manifestComplete: false, fileStore: { status: 'unsupported', fileStore: 's3', siteId: 'default' } });
    await expect(runTransitionStep(h.deps, { ...record, plan, progress: out.progress, lastStep: 5 }, 6)).rejects.toThrow(/s3/);
    m.requireSnapshot.mockResolvedValueOnce({ seq: 7, manifestComplete: false, fileStore: null });
    await expect(runTransitionStep(h.deps, { ...record, plan, progress: out.progress, lastStep: 5 }, 6)).rejects.toThrow(/no complete file manifest, so/);
    h.startupGuard.ensureEmpty.mockRejectedValueOnce(new StartupGuardFrozenError(1));
    await expect(runTransitionStep(h.deps, { ...record, plan, lastStep: 5 }, 6)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 6 });
  });
});

describe('reconciliation evidence around activation', () => {
  const order = (fn: { mock: { invocationCallOrder: number[] } }): number[] => fn.mock.invocationCallOrder;
  const opensGate = (h: ReturnType<typeof harness>): boolean => h.owners.gate.mock.calls.some(([, req]) => req.op === 'open');

  it('a forward step 6 writes no report and keeps its verdict as pre-activation evidence', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'), 5);
    const out = await runTransitionStep(h.deps, record, 6);
    expect(m.reconcileUnits).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ point: 'post-cutover', legacySource: 'live', snapshotSeq: 7, units: record.plan?.setT }));
    expect(m.writeReconciliationReport).not.toHaveBeenCalled();
    expect(out.progress.reconciliation).toBeUndefined();
    expect(out.progress.preActivationReconciliation).toEqual({ result: 'zero-difference', differences: 0, unitsWithDifferences: 0, tableVersion: 'v0001', snapshotSeq: 7, differingEntries: [] });
    expect(h.persisted.at(-1)?.preActivationReconciliation).toEqual(out.progress.preActivationReconciliation);
  });

  it('a step-6 difference aborts naming every differing unit and keeps the first DIFFERENCE_LIMIT differing entries', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'), 5);
    const tenants = Array.from({ length: DIFFERENCE_LIMIT }, (_, i) => `site${String(i).padStart(3, '0')}`);
    const units = [unitEntry('people.person_archive', 'default', 0), ...tenants.map((t) => unitEntry('people.person_archive', t, 1)), unitEntry('timesheets.blackout', 'default', 2)];
    m.reconcileUnits.mockResolvedValueOnce(reportOf('post-cutover', units, 'v0001', 7));
    const err = (await runTransitionStep(h.deps, record, 6).catch((e: unknown) => e)) as TransitionAbortedError;
    expect(err).toBeInstanceOf(TransitionAbortedError);
    expect(err.step).toBe(6);
    expect(err.reason).toBe(`Reconciliation before activation found ${String(DIFFERENCE_LIMIT + 2)} differences in 2 units: people.person_archive, timesheets.blackout`);
    expect(m.writeReconciliationReport).not.toHaveBeenCalled();
    const evidence = h.persisted.at(-1)?.preActivationReconciliation;
    expect(err.details).toEqual(evidence);
    expect(evidence).toMatchObject({ result: 'difference', differences: DIFFERENCE_LIMIT + 2, unitsWithDifferences: 2, tableVersion: 'v0001', snapshotSeq: 7 });
    expect(evidence?.differingEntries).toHaveLength(DIFFERENCE_LIMIT);
    expect(evidence?.differingEntries[0]).toEqual({ unit: 'people.person_archive', legacyTable: 'tusers', tenantId: 'site000', differenceCount: 1 });
    expect(evidence?.differingEntries.some((entry) => entry.tenantId === 'default')).toBe(false);
    expect(h.persisted.at(-1)?.reconciliation).toBeUndefined();
  });

  it('writes post-cutover.json only once activation is acknowledged, with the version then active, before anything reopens', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'));
    expect(m.writeReconciliationReport).toHaveBeenCalledTimes(1);
    expect(m.writeReconciliationReport.mock.calls[0]?.[1]).toMatchObject({ point: 'post-cutover', tableVersion: 'v0002', snapshotSeq: 7 });
    expect(record.progress.preActivationReconciliation?.tableVersion).toBe('v0001');
    expect(record.progress.reconciliation).toEqual({ point: 'post-cutover', result: 'zero-difference', differences: 0, reportPath: '/r/reconciliation/post-cutover.json' });
    const activated = order(h.gateway.activate)[0]!;
    const acknowledged = order(h.gateway.awaitEpoch)[h.gateway.awaitEpoch.mock.calls.findIndex(([epoch]) => epoch === record.progress.activatedEpoch)]!;
    const reconciled = order(m.reconcileUnits)[1]!;
    const written = order(m.writeReconciliationReport)[0]!;
    const firstOpen = order(h.owners.gate)[h.owners.gate.mock.calls.findIndex(([, req]) => req.op === 'open')]!;
    const reopened = Math.min(
      order(h.scheduler.handOffSiteMonitorToTarget)[0]!,
      order(h.scheduler.handOffSurveysToTarget)[0]!,
      firstOpen,
      order(h.gateway.unfreeze)[0]!,
      order(m.releaseLeases)[0]!,
    );
    expect(activated).toBeLessThan(acknowledged);
    expect(acknowledged).toBeLessThan(reconciled);
    expect(reconciled).toBeLessThan(written);
    expect(written).toBeLessThan(reopened);
    // A resumed step 8 keeps a zero-difference report; without a transition snapshot the latest ready one is recorded.
    await runTransitionStep(h.deps, { ...record, lastStep: 7 }, 8);
    expect(m.reconcileUnits).toHaveBeenCalledTimes(2);
    const bare: TransitionProgress = { ...record.progress };
    delete bare.snapshotSeq;
    delete bare.reconciliation;
    m.latestSnapshot.mockResolvedValueOnce({ seq: 9 });
    await runTransitionStep(h.deps, { ...record, progress: bare, lastStep: 7 }, 8);
    expect(m.latestSnapshot).toHaveBeenCalledWith(h.ctx);
    expect(m.writeReconciliationReport).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({ point: 'post-cutover', snapshotSeq: 9 }));
  });

  it('a post-activation difference throws at step 8 before any hand-off, gate open, unfreeze or lease release', async () => {
    const h = harness({ active: 'v0001' });
    const record = await runAll(h, newRecord('v0001', 'v0002'), 7);
    m.reconcileUnits.mockResolvedValueOnce(reportOf('post-cutover', [unitEntry('timesheets.blackout', 'default', 2)], 'v0002', 7));
    const err = (await runTransitionStep(h.deps, record, 8).catch((e: unknown) => e)) as TransitionAbortedError;
    expect(err).toBeInstanceOf(TransitionAbortedError);
    expect(err.step).toBe(8);
    expect(err.reason).toBe('Reconciliation post-cutover found 2 differences in 1 units; see /r/reconciliation/post-cutover.json');
    expect(opensGate(h)).toBe(false);
    expect(h.scheduler.handOffSiteMonitorToTarget).not.toHaveBeenCalled();
    expect(h.scheduler.handOffSurveysToTarget).not.toHaveBeenCalled();
    expect(h.gateway.unfreeze).not.toHaveBeenCalled();
    expect(m.releaseLeases).not.toHaveBeenCalled();
    expect(h.scheduler.resumePaused).not.toHaveBeenCalled();
    const progress = h.persisted.at(-1)!;
    expect(progress.reconciliation).toEqual({ point: 'post-cutover', result: 'difference', differences: 2, reportPath: '/r/reconciliation/post-cutover.json' });
    expect(progress.closedGates).toHaveLength(record.plan!.setT.length);
    // A recorded difference is reconciled again before a resumed step reopens anything.
    await runTransitionStep(h.deps, { ...record, progress }, 8);
    expect(m.writeReconciliationReport).toHaveBeenCalledTimes(2);
    expect(opensGate(h)).toBe(true);
  });

  it('a return to legacy writes rollback-before.json in step 6, before activation, and no post-cutover report', async () => {
    const h = harness({ active: 'v0002' });
    const record = await runAll(h, newRecord('v0002', 'v0003'));
    expect(m.reconcileUnits).toHaveBeenCalledTimes(1);
    expect(m.writeReconciliationReport).toHaveBeenCalledTimes(1);
    expect(m.writeReconciliationReport.mock.calls[0]?.[1]).toMatchObject({ point: 'rollback-before', tableVersion: 'v0002' });
    expect(order(m.writeReconciliationReport)[0]).toBeLessThan(order(h.gateway.activate)[0]!);
    expect(record.progress.preActivationReconciliation).toBeUndefined();
  });
});

describe('aborts', () => {
  it('a reconciliation difference aborts at step 6 and the abort undoes gates, freeze, queues, tasks and leases', async () => {
    const h = harness({ active: 'v0001' });
    m.reconcileUnits.mockResolvedValueOnce(reportOf('post-cutover', [unitEntry('people.person_archive', 'default', 3)], 'v0001', 7));
    let record = await runAll(h, newRecord('v0001', 'v0002'), 5);
    const err = await runTransitionStep(h.deps, record, 6).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransitionAbortedError);
    expect((err as TransitionAbortedError).step).toBe(6);
    expect((err as TransitionAbortedError).reason).toContain('people.person_archive');
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

describe('controlled legacy restart of step 3', () => {
  type Gate = { op: string; units: string[]; phase?: string; state?: string; holderId?: string };
  type Harness = ReturnType<typeof harness>;
  const live = { instanceId: 'gw-1', seenEpoch: 10, heartbeatAt: '2026-06-30T12:00:00Z', live: true };
  const dead = { instanceId: 'gw-dead', seenEpoch: 5, heartbeatAt: '2026-06-30T11:00:00Z', live: false };
  const touched = { rowsImported: 1, perOwner: {}, objectsTransferred: 0, objectsRemoved: [], touchedContent: true, writePositions: new Map() };
  const restartFailure = () => new LegacyRestartError('exit 1', { exitCode: 1, signal: null, timedOut: false, outputTail: '' });
  const order = (fn: { mock: { invocationCallOrder: number[] } }, index = 0): number => fn.mock.invocationCallOrder[index] ?? Number.NaN;
  const gates = (h: Harness): Gate[] => h.owners.gate.mock.calls.map(([, req]) => req as Gate);
  /** Call order of the first gate call `match` selects. */
  const gateAt = (h: Harness, match: (req: Gate) => boolean): number => order(h.owners.gate, gates(h).findIndex(match));
  const attempts = (): number[] => m.importWindow.mock.calls.map(([, input]) => (input as { attempt: number }).attempt);

  /** A v0002 -> v0003 transition after step 2 with an orphaned legacy write, and the content units `target`-authoritative under v0002. */
  async function atStep3(orphaned = true) {
    const plan = deriveTransitionPlan(v2, v3, groups, catalog);
    const row = { instanceId: 'gw-dead', route: plan.frozenRoutes[0]!, side: 'legacy' as const, count: 1, oldestStartedAt: '2026-06-30T11:59:00Z' };
    const h = harness({ active: 'v0002', restartCmd: 'restart.sh', inflight: orphaned ? [row] : [], instances: [live, dead] });
    const record = await runAll(h, newRecord('v0002', 'v0003'), 2);
    const authority = await currentAuthority({ gateway: h.gateway, config: config.paths });
    const fenced = contentUnits(catalog).filter((unit) => authority.isTargetAuthoritative(unit));
    expect(fenced.length).toBeGreaterThan(0);
    return { h, record, fenced };
  }

  it('closes and projects to the target-authoritative content gates, restarts, imports them whole and reopens them before step 4', async () => {
    const { h, record, fenced } = await atStep3();
    const after3 = await runAll(h, record, 3);
    const ofFenced = (req: Gate): boolean => req.units.length > 0 && req.units.every((unit) => fenced.includes(unit));
    const restart = order(m.restartLegacy);
    const persists = (h.deps.persist as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder;
    const intent = persists.filter((at) => at < restart).length - 1;
    expect(h.persisted[intent]?.orphanRestart).toMatchObject({ units: fenced, phase: 'executing', restartedAt: expect.any(String) });
    expect(h.persisted[intent]?.orphanRestart?.completedAt).toBeUndefined();
    const completion = h.persisted.findIndex((progress) => progress.orphanRestart?.completedAt !== undefined);
    const sequence = [
      order(m.acquireLeases, m.acquireLeases.mock.calls.length - 1),
      gateAt(h, (req) => req.op === 'close' && ofFenced(req)),
      order(h.projector.awaitProjection),
      gateAt(h, (req) => req.op === 'phase' && req.phase === 'executing'),
      persists[intent]!,
      restart,
      persists[completion]!,
      gateAt(h, (req) => req.op === 'phase' && req.phase === 'importing'),
      order(h.gateway.clearOrphans),
      order(m.importWindow),
      gateAt(h, (req) => req.op === 'open' && ofFenced(req)),
    ];
    expect(sequence.every((at, i) => i === 0 || at > sequence[i - 1]!)).toBe(true);
    expect(gates(h).find((req) => req.op === 'close')).toMatchObject({ units: fenced, phase: 'quiet', holderId: record.transitionId });
    expect(h.projector.awaitProjection).toHaveBeenCalledWith({
      owners: [...new Set(fenced.map((unit) => catalog.ownerOf(unit)))].sort(),
      timeoutMs: config.projection.defaultAwaitTimeoutMs,
    });
    expect(m.importWindow).toHaveBeenCalledWith(h.ctx, { windowId: record.transitionId, attempt: 1, units: fenced, scope: { table: true } });
    expect(h.persisted[persists.filter((at) => at < order(m.importWindow)).length - 1]?.orphanRestart?.importAttempts).toBe(1);
    expect(gates(h).find((req) => req.op === 'open')).toMatchObject({ units: fenced, state: 'open', holderId: record.transitionId });
    expect(h.startupGuard.ensureEmpty).not.toHaveBeenCalled();
    expect(after3.progress.closedGates).toEqual([]);
    expect(after3.progress.orphanRestart).toBeUndefined();
    await runAll(h, after3, 4);
    expect(gateAt(h, (req) => req.op === 'open' && ofFenced(req))).toBeLessThan(order(m.awaitDrained));
  });

  const refusals: { name: string; refuse: (h: Harness, fenced: string[]) => void }[] = [
    {
      name: 'a content gate another holder holds',
      refuse: (h, fenced) => h.owners.gate.mockRejectedValueOnce(new GateConflict('strategies-content', { error: 'gate-conflict', units: fenced })),
    },
    { name: 'a projection that does not catch up', refuse: (h) => h.projector.awaitProjection.mockRejectedValueOnce(new ProjectionTimeoutError([], 5000)) },
  ];

  it.each(refusals)('aborts before the restart on $name, and the abort reopens the recorded gates without importing', async ({ refuse }) => {
    const { h, record, fenced } = await atStep3();
    refuse(h, fenced);
    await expect(runTransitionStep(h.deps, record, 3)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 3 });
    expect(m.restartLegacy).not.toHaveBeenCalled();
    const progress = h.persisted.at(-1)!;
    expect(progress.closedGates.map((gate) => gate.unit)).toEqual(fenced);
    expect(progress.orphanRestart?.restartedAt).toBeUndefined();
    const cleaned = await abortTransition(h.deps, { ...record, progress });
    expect(m.importWindow).not.toHaveBeenCalled();
    expect(gates(h).filter((req) => req.op === 'open')).toEqual([expect.objectContaining({ units: fenced, state: 'open' })]);
    expect(cleaned.closedGates).toEqual([]);
    expect(cleaned.orphanRestart).toBeUndefined();
  });

  it('an abort after a failed restart restarts again before importing, then imports before resetting any gate, and throws with the gates closed while the import fails', async () => {
    const { h, record, fenced } = await atStep3();
    m.restartLegacy.mockRejectedValueOnce(restartFailure());
    await expect(runTransitionStep(h.deps, record, 3)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 3 });
    let progress = h.persisted.at(-1)!;
    expect(progress.orphanRestart).toMatchObject({ units: fenced, restartedAt: expect.any(String) });
    expect(progress.orphanRestart?.completedAt).toBeUndefined();
    const failure = new WindowImportError(record.transitionId, 'legacy read failed');
    m.importWindow.mockRejectedValueOnce(failure);
    await expect(abortTransition(h.deps, { ...record, progress })).rejects.toBe(failure);
    expect(m.restartLegacy).toHaveBeenCalledTimes(2);
    expect(m.restartLegacy).toHaveBeenLastCalledWith(h.ctx.env, { timeoutMs: config.windows.gatewayLeaseMs, extraEnv: { OPT2_STARTUP_WINDOW_HOLDER: record.transitionId } });
    expect(order(m.restartLegacy, 1)).toBeLessThan(gateAt(h, (req) => req.op === 'phase' && req.phase === 'importing'));
    expect(gates(h).filter((req) => req.op === 'open')).toEqual([]);
    expect(h.gateway.unfreeze).not.toHaveBeenCalled();
    expect(h.scheduler.resumePaused).not.toHaveBeenCalled();
    expect(m.releaseLeases).not.toHaveBeenCalled();
    progress = h.persisted.at(-1)!;
    expect(progress.orphanRestart?.completedAt).toEqual(expect.any(String));
    expect(progress.closedGates.map((gate) => gate.unit)).toEqual(fenced);
    const cleaned = await abortTransition(h.deps, { ...record, progress });
    expect(m.restartLegacy).toHaveBeenCalledTimes(2);
    expect(attempts()).toEqual([1, 2]);
    expect(gateAt(h, (req) => req.op === 'phase' && req.phase === 'importing')).toBeLessThan(order(m.importWindow));
    expect(order(m.importWindow, 1)).toBeLessThan(gateAt(h, (req) => req.op === 'open'));
    expect(cleaned.orphanRestart).toBeUndefined();
    expect(cleaned.closedGates).toEqual([]);
    expect(m.releaseLeases).toHaveBeenCalledWith(h.ctx, record.transitionId);
  });

  it('an abort whose restart after a failed one fails again refuses, importing, reopening, unfreezing and releasing nothing', async () => {
    const { h, record, fenced } = await atStep3();
    m.restartLegacy.mockRejectedValueOnce(restartFailure()).mockRejectedValueOnce(restartFailure());
    await expect(runTransitionStep(h.deps, record, 3)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 3 });
    const progress = h.persisted.at(-1)!;
    await expect(abortTransition(h.deps, { ...record, progress })).rejects.toMatchObject({
      name: 'TransitionAbortedError',
      step: 3,
      details: { units: fenced },
    });
    expect(m.restartLegacy).toHaveBeenCalledTimes(2);
    expect(m.importWindow).not.toHaveBeenCalled();
    expect(gates(h).filter((req) => req.op === 'open')).toEqual([]);
    expect(h.gateway.unfreeze).not.toHaveBeenCalled();
    expect(h.scheduler.resumePaused).not.toHaveBeenCalled();
    expect(m.releaseLeases).not.toHaveBeenCalled();
    const kept = h.persisted.at(-1)!;
    expect(kept.closedGates.map((gate) => gate.unit)).toEqual(fenced);
    expect(kept.orphanRestart).toMatchObject({ units: fenced, restartedAt: expect.any(String) });
    expect(kept.orphanRestart?.completedAt).toBeUndefined();
  });

  const cutShort: { name: string; restartedAt?: string; completedAt?: string; restarts: number; imports: number }[] = [
    { name: 'after its restart completed', restartedAt: '2026-06-30T12:00:00.000Z', completedAt: '2026-06-30T12:00:01.000Z', restarts: 0, imports: 1 },
    { name: 'after its restart intent, restarting legacy again first', restartedAt: '2026-06-30T12:00:00.000Z', restarts: 1, imports: 1 },
    { name: 'before its restart intent', restarts: 0, imports: 0 },
  ];

  it.each(cutShort)('a resumed step 3 without orphans finishes a restart cut short $name', async ({ restartedAt, completedAt, restarts, imports }) => {
    const { h, record, fenced } = await atStep3(false);
    const progress: TransitionProgress = {
      ...record.progress,
      closedGates: fenced.map((unit) => ({ owner: catalog.ownerOf(unit), unit, prior: 'open' as const })),
      orphanRestart: { units: fenced, phase: 'executing', importAttempts: 0, ...(restartedAt === undefined ? {} : { restartedAt }), ...(completedAt === undefined ? {} : { completedAt }) },
    };
    const out = await runTransitionStep(h.deps, { ...record, progress }, 3);
    expect(m.restartLegacy).toHaveBeenCalledTimes(restarts);
    if (restarts > 0) expect(order(m.restartLegacy)).toBeLessThan(order(m.importWindow));
    expect(m.importWindow).toHaveBeenCalledTimes(imports);
    expect(gates(h).at(-1)).toMatchObject({ op: 'open', units: fenced, state: 'open' });
    expect(out.progress.orphanRestart).toBeUndefined();
    expect(out.progress.closedGates).toEqual([]);
  });

  it('runs the start-up guard after an import touching tcontent and imports again after its reload, before reopening', async () => {
    const { h, record, fenced } = await atStep3();
    m.importWindow.mockResolvedValueOnce(touched);
    h.startupGuard.ensureEmpty.mockResolvedValueOnce({ initialCount: 3, reloaded: true, finalCount: 0 });
    await runTransitionStep(h.deps, record, 3);
    expect(h.startupGuard.ensureEmpty).toHaveBeenCalledWith({ holderId: record.transitionId, exceptRoutes: record.plan!.frozenRoutes, onFrozen: expect.any(Function) });
    expect(attempts()).toEqual([1, 2]);
    expect(order(h.startupGuard.ensureEmpty)).toBeLessThan(order(m.importWindow, 1));
    expect(order(m.importWindow, 1)).toBeLessThan(gateAt(h, (req) => req.op === 'open'));
    expect(gates(h).at(-1)).toMatchObject({ op: 'open', units: fenced });
  });

  it('a guard freeze kept after the restart import aborts step 3 with the gates closed; the abort lifts it, imports, then reopens', async () => {
    const { h, record, fenced } = await atStep3();
    const kept = { routes: ['legacy:a'], epoch: 12 };
    m.importWindow.mockResolvedValueOnce(touched);
    h.startupGuard.ensureEmpty.mockImplementationOnce(async ({ onFrozen }) => {
      await onFrozen(kept);
      throw new StartupGuardFrozenError(1);
    });
    await expect(runTransitionStep(h.deps, record, 3)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 3, details: { remaining: 1 } });
    const progress = h.persisted.at(-1)!;
    expect(progress.startupGuardFreeze).toEqual(kept);
    expect(progress.closedGates.map((gate) => gate.unit)).toEqual(fenced);
    expect(gates(h).filter((req) => req.op === 'open')).toEqual([]);
    const cleaned = await abortTransition(h.deps, { ...record, progress });
    expect(h.startupGuard.recover).toHaveBeenCalledWith({ holderId: record.transitionId, frozen: kept });
    expect(order(h.startupGuard.recover)).toBeLessThan(order(m.importWindow, 1));
    expect(order(m.importWindow, 1)).toBeLessThan(gateAt(h, (req) => req.op === 'open'));
    expect(attempts()).toEqual([1, 2]);
    expect(cleaned.startupGuardFreeze).toBeUndefined();
    expect(cleaned.orphanRestart).toBeUndefined();
    expect(cleaned.closedGates).toEqual([]);
  });

  const lostClaims: { name: string; restarts: number; arrange(h: Harness, record: TransitionRecord): Promise<() => Promise<unknown>> }[] = [
    { name: 'step 3', restarts: 0, arrange: async (h, record) => () => runTransitionStep(h.deps, record, 3) },
    {
      name: 'an abort after a failed restart',
      restarts: 1,
      async arrange(h, record) {
        m.restartLegacy.mockRejectedValueOnce(restartFailure());
        await expect(runTransitionStep(h.deps, record, 3)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 3 });
        const progress = h.persisted.at(-1)!;
        return () => abortTransition(h.deps, { ...record, progress });
      },
    },
  ];

  it.each(lostClaims)('$name restarts nothing once the claim is found taken while its restart intent is recorded', async ({ restarts, arrange }) => {
    const { h, record } = await atStep3();
    const act = await arrange(h, record);
    const fence = fenceTakenOn(h, (progress) => progress.orphanRestart?.restartedAt !== undefined && progress.orphanRestart.completedAt === undefined);
    await expect(claimFences.run(fence, act)).rejects.toBeInstanceOf(TransitionClaimLostError);
    expect(m.restartLegacy).toHaveBeenCalledTimes(restarts);
    expect(h.gateway.clearOrphans).not.toHaveBeenCalled();
    expect(m.importWindow).not.toHaveBeenCalled();
    expect(gates(h).filter((req) => req.op === 'open')).toEqual([]);
    expect(m.releaseLeases).not.toHaveBeenCalled();
  });
});

describe('createTransitionStartupGuard', () => {
  const frozen = { routes: ['r'], epoch: 3 };
  const counts = (...values: number[]) => values.forEach((value) => m.countStartupRows.mockResolvedValueOnce(value));

  it('does nothing without matching rows, else records the freeze before reloading and unfreezes once no row matches', async () => {
    const h = harness({ active: 'v0001' });
    const guard = createTransitionStartupGuard(h.ctx);
    const onFrozen = vi.fn(async () => undefined);
    counts(0);
    expect(await guard.ensureEmpty({ holderId: 'T', exceptRoutes: ['a'], onFrozen })).toEqual({ initialCount: 0, reloaded: false, finalCount: 0 });
    expect(m.freezeLegacyBound).not.toHaveBeenCalled();
    expect(m.sendReloadRequest).not.toHaveBeenCalled();
    counts(4, 0);
    expect(await guard.ensureEmpty({ holderId: 'T', exceptRoutes: ['a'], onFrozen })).toEqual({ initialCount: 4, reloaded: true, finalCount: 0 });
    expect(m.freezeLegacyBound).toHaveBeenCalledWith(h.ctx, { exceptRoutes: ['a'], beforeFreeze: onFrozen });
    expect(onFrozen).toHaveBeenCalledWith(frozen);
    expect(issuedFreezes).toEqual([frozen]);
    expect(onFrozen.mock.invocationCallOrder[0]).toBeLessThan(m.sendReloadRequest.mock.invocationCallOrder[0]!);
    expect(m.unfreezeLegacyBound).toHaveBeenCalledWith(h.ctx, frozen);
    expect(m.unfreezeLegacyBound.mock.invocationCallOrder[0]).toBeGreaterThan(m.sendReloadRequest.mock.invocationCallOrder[0]!);
  });

  it('freezes, unfreezes and reloads nothing and rethrows when the freeze cannot be recorded while rows match', async () => {
    const h = harness({ active: 'v0001' });
    m.countStartupRows.mockResolvedValue(4);
    const onFrozen = vi.fn(async () => Promise.reject(new Error('database unavailable while recording freeze')));
    await expect(createTransitionStartupGuard(h.ctx).ensureEmpty({ holderId: 'T', exceptRoutes: [], onFrozen })).rejects.toThrow('database unavailable');
    expect(onFrozen).toHaveBeenCalledWith(frozen);
    expect(issuedFreezes).toEqual([]);
    expect(m.unfreezeLegacyBound).not.toHaveBeenCalled();
    expect(m.sendReloadRequest).not.toHaveBeenCalled();
  });

  const keptAfter: { name: string; rows: number[]; reload?: Error; remaining: number | undefined }[] = [
    { name: 'a failed reload', rows: [4], reload: new Error('reload'), remaining: undefined },
    { name: 'rows still matching', rows: [4, 2], remaining: 2 },
  ];

  it.each(keptAfter)('ensureEmpty keeps the recorded freeze after $name', async ({ rows, reload, remaining }) => {
    const h = harness({ active: 'v0001' });
    counts(...rows);
    if (reload !== undefined) m.sendReloadRequest.mockRejectedValueOnce(reload);
    const onFrozen = vi.fn(async () => undefined);
    const err = await createTransitionStartupGuard(h.ctx).ensureEmpty({ holderId: 'T', exceptRoutes: [], onFrozen }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartupGuardFrozenError);
    expect((err as StartupGuardFrozenError).remaining).toBe(remaining);
    expect(onFrozen).toHaveBeenCalledWith(frozen);
    expect(m.unfreezeLegacyBound).not.toHaveBeenCalled();
  });

  it.each(keptAfter)('recover keeps the freeze after $name and freezes nothing', async ({ rows, reload, remaining }) => {
    const h = harness({ active: 'v0001' });
    counts(...rows);
    if (reload !== undefined) m.sendReloadRequest.mockRejectedValueOnce(reload);
    await expect(createTransitionStartupGuard(h.ctx).recover({ holderId: 'T', frozen })).rejects.toMatchObject({ name: 'StartupGuardFrozenError', remaining });
    expect(m.freezeLegacyBound).not.toHaveBeenCalled();
    expect(m.unfreezeLegacyBound).not.toHaveBeenCalled();
  });

  it('recover reloads under the kept freeze and unfreezes it once no row matches', async () => {
    const h = harness({ active: 'v0001' });
    counts(4, 0);
    expect(await createTransitionStartupGuard(h.ctx).recover({ holderId: 'T', frozen })).toEqual({ initialCount: 4, reloaded: true, finalCount: 0 });
    expect(m.freezeLegacyBound).not.toHaveBeenCalled();
    expect(m.sendReloadRequest).toHaveBeenCalledTimes(1);
    expect(m.unfreezeLegacyBound).toHaveBeenCalledWith(h.ctx, frozen);
  });

  const lostClaim: { name: string; run(guard: TransitionStartupGuard, fence: ClaimFence): Promise<unknown> }[] = [
    {
      name: 'ensureEmpty, once its freeze record finds the claim taken,',
      run: (guard, fence) =>
        guard.ensureEmpty({
          holderId: 'T',
          exceptRoutes: [],
          onFrozen: async () => {
            fence.taken = true;
          },
        }),
    },
    {
      name: 'recover',
      run: (guard, fence) => {
        fence.taken = true;
        return guard.recover({ holderId: 'T', frozen });
      },
    },
  ];

  it.each(lostClaim)('$name sends no reload for a drive that lost its claim and keeps the freeze', async ({ run }) => {
    const h = harness({ active: 'v0001' });
    counts(4);
    const fence = claimFence();
    const err = await claimFences.run(fence, () => run(createTransitionStartupGuard(h.ctx), fence)).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'StartupGuardFrozenError', cause: expect.any(TransitionClaimLostError) });
    expect(m.sendReloadRequest).not.toHaveBeenCalled();
    expect(m.unfreezeLegacyBound).not.toHaveBeenCalled();
  });
});

describe('a kept start-up guard freeze', () => {
  const kept = { routes: ['legacy:a'], epoch: 12 };

  async function atStep6(h: ReturnType<typeof harness>): Promise<TransitionRecord> {
    const record = await runAll(h, newRecord('v0001', 'v0002'), 5);
    return { ...record, plan: { ...record.plan!, contentToTarget: true } };
  }

  it('is recorded by step 6, which aborts while it is kept; the abort lifts it before reopening anything, or undoes nothing', async () => {
    const h = harness({ active: 'v0001' });
    const record = await atStep6(h);
    h.startupGuard.ensureEmpty.mockImplementationOnce(async ({ onFrozen }) => {
      await onFrozen(kept);
      throw new StartupGuardFrozenError(2);
    });
    await expect(runTransitionStep(h.deps, record, 6)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 6, details: { remaining: 2 } });
    expect(m.takeSnapshot).not.toHaveBeenCalled();
    const aborting = { ...record, progress: h.persisted.at(-1)! };
    expect(aborting.progress.startupGuardFreeze).toEqual(kept);
    h.calls.length = 0;
    h.startupGuard.recover.mockRejectedValueOnce(new StartupGuardFrozenError(2));
    await expect(abortTransition(h.deps, aborting)).rejects.toBeInstanceOf(StartupGuardFrozenError);
    expect(h.calls.map((c) => c[0]).filter((name) => name !== 'recoverGuard' && name !== 'persist')).toEqual([]);
    expect(m.releaseLeases).not.toHaveBeenCalled();
    const cleaned = await abortTransition(h.deps, aborting);
    expect(h.startupGuard.recover).toHaveBeenLastCalledWith({ holderId: record.transitionId, frozen: kept });
    const names = h.calls.map((c) => c[0]);
    expect(names.lastIndexOf('recoverGuard')).toBeLessThan(names.indexOf('gate'));
    expect(names.indexOf('gate')).toBeLessThan(names.indexOf('unfreeze'));
    const firstGate = h.calls.findIndex((c) => c[0] === 'gate');
    expect((h.calls.slice(0, firstGate).filter((c) => c[0] === 'persist').at(-1)?.[1] as TransitionProgress).startupGuardFreeze).toBeUndefined();
    expect(cleaned.startupGuardFreeze).toBeUndefined();
    expect(cleaned.closedGates).toEqual([]);
  });

  it('is recovered, not frozen again, by a resumed step 6, which then goes on or aborts keeping it', async () => {
    const h = harness({ active: 'v0001' });
    const record = await atStep6(h);
    const resumed = { ...record, progress: { ...record.progress, startupGuardFreeze: kept } };
    h.startupGuard.recover.mockRejectedValueOnce(new StartupGuardFrozenError(undefined));
    const before = h.persisted.length;
    await expect(runTransitionStep(h.deps, resumed, 6)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 6 });
    expect(h.persisted.slice(before).some((p) => p.startupGuardFreeze === undefined)).toBe(false);
    const out = await runTransitionStep(h.deps, resumed, 6);
    expect(h.startupGuard.ensureEmpty).not.toHaveBeenCalled();
    expect(h.startupGuard.recover).toHaveBeenLastCalledWith({ holderId: record.transitionId, frozen: kept });
    expect(out.progress.startupGuardFreeze).toBeUndefined();
    expect(out.progress.startupGuard).toEqual({ initialCount: 1, reloaded: true, finalCount: 0 });
    expect(m.takeSnapshot).toHaveBeenCalledTimes(1);
  });

  const unrecorded: { name: string; arrange(h: ReturnType<typeof harness>, record: TransitionRecord): Promise<TransitionRecord> }[] = [
    {
      name: 'a step-6 difference found once rows began to match',
      async arrange(h, record) {
        m.reconcileUnits.mockResolvedValueOnce(reportOf('post-cutover', [unitEntry('people.person_archive', 'default', 3)], 'v0001', 7));
        await expect(runTransitionStep(h.deps, record, 6)).rejects.toMatchObject({ name: 'TransitionAbortedError', step: 6 });
        m.countStartupRows.mockResolvedValue(4);
        return { ...record, progress: h.persisted.at(-1)! };
      },
    },
    {
      name: 'a step-6 guard that could not record its freeze',
      async arrange(h, record) {
        m.countStartupRows.mockResolvedValue(4);
        const persist = h.deps.persist;
        h.deps.persist = async (progress) => {
          if (progress.startupGuardFreeze !== undefined) throw new Error('database unavailable while recording freeze');
          await persist(progress);
        };
        await expect(runTransitionStep(h.deps, record, 6)).rejects.toThrow('database unavailable');
        h.deps.persist = persist;
        expect(issuedFreezes).toEqual([]);
        return { ...record, progress: h.persisted.at(-1)! };
      },
    },
  ];

  it.each(unrecorded)('an abort after $name, with no freeze recorded, reopens nothing while rows match the start-up predicate', async ({ arrange }) => {
    const h = harness({ active: 'v0001' });
    h.deps.startupGuard = createTransitionStartupGuard(h.ctx);
    const aborting = await arrange(h, await atStep6(h));
    expect(aborting.progress.startupGuardFreeze).toBeUndefined();
    h.calls.length = 0;
    await expect(abortTransition(h.deps, aborting)).rejects.toMatchObject({ name: 'StartupGuardFrozenError', remaining: 4 });
    expect(h.calls.map((c) => c[0]).filter((name) => name !== 'persist')).toEqual([]);
    expect(m.unfreezeLegacyBound).not.toHaveBeenCalled();
    expect(h.scheduler.resumePaused).not.toHaveBeenCalled();
    expect(m.releaseLeases).not.toHaveBeenCalled();
    const kept = h.persisted.at(-1)!;
    expect(kept.startupGuardFreeze).toEqual({ routes: ['r'], epoch: 3 });
    expect(kept.closedGates.length).toBeGreaterThan(0);
    m.countStartupRows.mockResolvedValue(0);
    const gatesBefore = h.owners.gate.mock.calls.length;
    const cleaned = await abortTransition(h.deps, { ...aborting, progress: kept });
    expect(m.unfreezeLegacyBound).toHaveBeenCalledWith(h.ctx, kept.startupGuardFreeze);
    const reopened = h.owners.gate.mock.invocationCallOrder.slice(gatesBefore);
    expect(reopened.length).toBeGreaterThan(0);
    expect(reopened.every((at) => at > m.unfreezeLegacyBound.mock.invocationCallOrder[0]!)).toBe(true);
    expect(cleaned.startupGuardFreeze).toBeUndefined();
    expect(cleaned.closedGates).toEqual([]);
  });
});
