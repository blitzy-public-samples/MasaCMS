// Unit tests of the transition service over a throwaway `migration` schema, with the step engine mocked.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { LegacyApiError, cfUuid } from '@opt2/platform/legacy-compat';
import { REDACTED } from '@opt2/platform/logging';
import { systemClock } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import {
  TransitionAbortedError,
  TransitionPreconditionError,
  initialTransitionProgress,
  type StepDeps,
  type TransitionPlan,
  type TransitionProgress,
  type TransitionRecord,
  type TransitionStepNumber,
} from '../../src/transition/steps.js';

const m = vi.hoisted(() => ({
  planTransition: vi.fn(),
  runTransitionStep: vi.fn(),
  abortTransition: vi.fn(),
}));
vi.mock('../../src/transition/steps.js', async (orig) => ({
  ...(await orig<typeof import('../../src/transition/steps.js')>()),
  planTransition: m.planTransition,
  runTransitionStep: m.runTransitionStep,
  abortTransition: m.abortTransition,
}));

const { createTransitionService, toTransitionView, TransitionInProgressError, TransitionNotFoundError } = await import(
  '../../src/transition/service.js'
);

const CONFIG = loadConfig();
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const pg = await pgAvailable();
// Free text no redaction pattern masks, so it reaches a log only if interpolated there.
const FREE_TEXT = ['Jane', 'Doe', 'salary', '91250'].join(' ');

const PLAN: TransitionPlan = {
  from: 'v0001',
  to: 'v0002',
  setT: ['people.person'],
  toTarget: ['people.person'],
  toLegacy: [],
  entriesChanged: [
    {
      route: 'admin:cusers.update{type=2,action=add}',
      from: 'legacy',
      to: 'target',
      entry: { route: 'admin:cusers.update{type=2,action=add}', owningService: 'people', tableVersion: 'v0002', state: 'target', kind: 'write', units: ['people.person'], disposition: 'carry' },
    },
  ],
  legacyWriteEntries: ['page:doaction=updateprofile'],
  frozenRoutes: ['admin:cusers.update{type=2,action=add}'],
  owners: ['people'],
  siteMonitorEntryMoves: false,
  siteMonitorUnits: [],
  contentToTarget: false,
  exportJobsWriteT: false,
  returnsToLegacy: false,
};

interface LogCall {
  level: string;
  args: unknown[];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.skipIf(!pg)('transition service against PostgreSQL', () => {
  let schema: ThrowawaySchema;
  let db: TenantDb;
  let reportsDir: string;
  let active: string;
  let logs: LogCall[];
  let calls: { step: number; lastStep: number }[];
  let behaviour: Map<number, (deps: StepDeps, record: TransitionRecord) => Promise<{ plan?: TransitionPlan; progress: TransitionProgress }>>;

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'migration', migrationsDir: MIGRATIONS_DIR });
    db = schema.app;
  });

  afterAll(async () => {
    await schema?.drop();
  });

  beforeEach(async () => {
    reportsDir = mkdtempSync(path.join(os.tmpdir(), 'transition-service-'));
    active = 'v0001';
    logs = [];
    calls = [];
    behaviour = new Map();
    m.planTransition.mockReset();
    m.planTransition.mockImplementation(async (_ctx: unknown, to: string) => ({ ...PLAN, to }));
    m.runTransitionStep.mockReset();
    m.runTransitionStep.mockImplementation(async (deps: StepDeps, record: TransitionRecord, step: TransitionStepNumber) => {
      calls.push({ step, lastStep: record.lastStep });
      const custom = behaviour.get(step);
      if (custom !== undefined) return custom(deps, record);
      if (step === 7) active = record.to;
      return { plan: step === 1 ? { ...PLAN, to: record.to } : record.plan, progress: { ...record.progress } };
    });
    m.abortTransition.mockReset();
    m.abortTransition.mockImplementation(async (_deps: StepDeps, record: TransitionRecord) => ({ ...record.progress, closedGates: [], extraLeasedUnits: [] }));
    await db.withMetadata((tx) => tx.query(`DELETE FROM ${tx.schema}.transition`));
  });

  function service() {
    const log = (level: string) => (...args: unknown[]) => logs.push({ level, args });
    const ctx = {
      env: { OPT2_REPORTS_DIR: reportsDir },
      config: CONFIG,
      clock: systemClock,
      logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
      db,
      gateway: { status: async () => ({ tableVersion: active, epoch: 1 }) },
    } as unknown as MigrationContext;
    return createTransitionService(ctx, {
      projector: { awaitProjection: async () => ({ positions: new Map(), waitedMs: 0 }) },
      windows: { get: async () => Promise.reject(new Error('none')) },
      scheduler: {} as never,
      startupGuard: { ensureEmpty: async () => ({ initialCount: 0, reloaded: false, finalCount: 0 }) },
    });
  }

  async function settle(svc: ReturnType<typeof service>, id: string, states = ['completed', 'aborted']) {
    for (let i = 0; i < 400; i += 1) {
      const view = await svc.get(id);
      if (states.includes(view.state)) return view;
      await delay(10);
    }
    throw new Error(`transition ${id} did not settle`);
  }

  async function row(id: string) {
    const { rows } = await db.withMetadata((tx) => tx.query(`SELECT * FROM ${tx.schema}.transition WHERE transition_id = $1`, [id]));
    return rows[0] as Record<string, unknown>;
  }

  function logEntry(id: string) {
    const doc = JSON.parse(readFileSync(path.join(reportsDir, 'transitions.json'), 'utf8')) as { transitions: Record<string, unknown>[]; sourceSha: string };
    return { doc, entry: doc.transitions.find((t) => t.transitionId === id) };
  }

  function contract(body: unknown, status = 200) {
    const [method, route] = status === 202 ? ['POST', '/internal/v1/transitions'] : ['GET', '/internal/v1/transitions/x'];
    assertResponseMatchesOpenApi(DOC, { method, path: route, status, contentType: 'application/json', body });
  }

  async function seedRow(lastStep: number, state: string, steps: unknown[] = []) {
    const id = cfUuid();
    const progress = initialTransitionProgress();
    const { closedGates, ...rest } = progress;
    await db.withMetadata((tx) =>
      tx.query(
        `INSERT INTO ${tx.schema}.transition (transition_id, from_version, to_version, state, step, units, entries, frozen_routes, paused, closed_gates, requested_by, started_at, updated_at)
         VALUES ($1, 'v0001', 'v0002', $2, $3, $4::text[], $5::jsonb, $6::text[], $7::jsonb, $8::jsonb, 'platform.operator', now(), now())`,
        [id, state, Math.min(lastStep + 1, 8), PLAN.setT, JSON.stringify({ plan: lastStep === 0 ? null : PLAN, steps }), PLAN.frozenRoutes, JSON.stringify(rest), JSON.stringify(closedGates)],
      ),
    );
    return id;
  }

  it('runs all eight steps, persists between them and mirrors the row into transitions.json', async () => {
    const svc = service();
    const view = await svc.start({ to: 'v0002' });
    contract(view, 202);
    expect(view).toMatchObject({ fromVersion: 'v0001', toVersion: 'v0002', state: 'running', step: 1, units: [], frozenRoutes: [] });
    const done = await settle(svc, view.transitionId);
    contract(done);
    expect(done).toMatchObject({ state: 'completed', step: 8, units: PLAN.setT, frozenRoutes: PLAN.frozenRoutes });
    expect(done.finishedAt).toBeDefined();
    expect(calls.map((c) => [c.step, c.lastStep])).toEqual([[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7]]);
    await svc.stop();
    const r = await row(view.transitionId);
    expect(r).toMatchObject({ state: 'completed', step: 8, requested_by: 'platform.operator', units: PLAN.setT, error: null });
    const { doc, entry } = logEntry(view.transitionId);
    expect(doc.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(entry).toMatchObject({
      from: 'v0001',
      to: 'v0002',
      setT: PLAN.setT,
      entriesChanged: [PLAN.entriesChanged[0]?.route],
      legacyWriteEntries: PLAN.legacyWriteEntries,
      outcome: 'activated',
    });
    expect((entry?.steps as { result: string }[]).map((s) => s.result)).toEqual(Array(8).fill('ok'));
    await svc.stop();
  });

  it('refuses a second start while one runs, and a precondition or unknown version before inserting', async () => {
    const hold = deferred();
    behaviour.set(2, async (_d, record) => {
      await hold.promise;
      return { plan: record.plan, progress: record.progress };
    });
    const svc = service();
    const first = await svc.start({ to: 'v0002' });
    const second = await svc.start({ to: 'v0002' }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(TransitionInProgressError);
    expect(second).toMatchObject({ statusCode: 409, activeId: first.transitionId });
    hold.resolve();
    await settle(svc, first.transitionId);

    m.planTransition.mockRejectedValueOnce(new TransitionPreconditionError('same-version', 'v0002 is already the active cut-over version'));
    await expect(svc.start({ to: 'v0002' })).rejects.toMatchObject({ statusCode: 409, code: 'same-version' });
    m.planTransition.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/x/versions/v0009.json' }));
    await expect(svc.start({ to: 'v0009' })).rejects.toBeInstanceOf(LegacyApiError);
    m.planTransition.mockRejectedValueOnce(Object.assign(new Error('ENOENT groups'), { code: 'ENOENT', path: '/x/groups.json' }));
    await expect(svc.start({ to: 'v0009' })).rejects.toThrow('ENOENT groups');
    const { rows } = await db.withMetadata((tx) => tx.query(`SELECT count(*)::int AS n FROM ${tx.schema}.transition`));
    expect(rows[0]).toEqual({ n: 1 });
    await svc.stop();
  });

  it('maps a lost insert race on transition_active_uidx to TransitionInProgressError', async () => {
    let other = '';
    m.planTransition.mockImplementationOnce(async () => {
      other = await seedRow(0, 'started');
      return PLAN;
    });
    const svc = service();
    const error = await svc.start({ to: 'v0002' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransitionInProgressError);
    expect(error).toMatchObject({ activeId: other });
    await svc.stop();
  });

  it.each([
    ['refusal at step 4', 4, () => new TransitionAbortedError(4, 'Effects did not drain')],
    ['plain error at step 3', 3, () => new Error('owner down')],
    ['refusal at step 7', 7, () => new TransitionAbortedError(7, 'The gateway refused to activate v0002 (HTTP 409)')],
  ])('aborts before activation on a %s', async (_label, step, makeError) => {
    behaviour.set(step, async () => {
      throw makeError();
    });
    const svc = service();
    const { transitionId } = await svc.start({ to: 'v0002' });
    const view = await settle(svc, transitionId);
    contract(view);
    const message = makeError().message;
    expect(view).toMatchObject({ state: 'aborted', step, error: { step, message, state: 'aborted' } });
    expect(m.abortTransition).toHaveBeenCalledTimes(1);
    expect(m.abortTransition.mock.calls[0]?.[1]).toMatchObject({ abortReason: message });
    expect(await row(transitionId)).toMatchObject({ state: 'aborted', step, error: { step, message } });
    await svc.stop();
    const { entry } = logEntry(transitionId);
    expect(entry).toMatchObject({ outcome: 'aborted', abortReason: message });
    expect((entry?.steps as { result: string }[]).at(-1)?.result).toBe('aborted');
    await svc.stop();
  });

  it('keeps a failed undo aborting, gates closed, and resume finishes it', async () => {
    behaviour.set(5, async (deps, record) => {
      await deps.persist({ ...record.progress, closedGates: [{ owner: 'people', unit: 'people.person', prior: 'legacy' }] });
      throw new TransitionAbortedError(5, 'gates held by another holder');
    });
    m.abortTransition.mockRejectedValueOnce(new Error('owner unreachable'));
    const svc = service();
    const { transitionId } = await svc.start({ to: 'v0002' });
    for (let i = 0; i < 200 && m.abortTransition.mock.calls.length === 0; i += 1) await delay(10);
    await svc.stop();
    const r = await row(transitionId);
    expect(r).toMatchObject({ state: 'aborting', step: 5, closed_gates: [{ owner: 'people', unit: 'people.person', prior: 'legacy' }] });
    expect(logs.some((l) => l.level === 'error' && String(l.args.at(-1)).includes('undo failed'))).toBe(true);

    const seen: unknown[] = [];
    m.abortTransition.mockImplementationOnce(async (_deps: StepDeps, record: TransitionRecord) => {
      seen.push(structuredClone({ lastStep: record.lastStep, closedGates: record.progress.closedGates, reason: record.abortReason }));
      return { ...record.progress, closedGates: [] };
    });
    const next = service();
    const resumed = await next.resume();
    expect(resumed).toMatchObject({ state: 'running', error: { step: 5, state: 'aborting' } });
    const view = await settle(next, transitionId);
    expect(view.state).toBe('aborted');
    expect(seen).toEqual([{ lastStep: 4, closedGates: [{ owner: 'people', unit: 'people.person', prior: 'legacy' }], reason: 'gates held by another holder' }]);
    expect((await row(transitionId)).closed_gates).toEqual([]);
    await next.stop();
  });

  it('leaves a plain failure of step 7 running and resume retries it', async () => {
    let fails = 1;
    behaviour.set(7, async (_d, record) => {
      if (fails-- > 0) throw new Error('gateway timeout');
      active = record.to;
      return { plan: record.plan, progress: record.progress };
    });
    const svc = service();
    const { transitionId } = await svc.start({ to: 'v0002' });
    for (let i = 0; i < 200 && !logs.some((l) => String(l.args.at(-1)).includes('runs again on resume')); i += 1) await delay(10);
    const stuck = await svc.get(transitionId);
    contract(stuck);
    expect(stuck).toMatchObject({ state: 'running', step: 7, error: { step: 7, message: 'gateway timeout', name: 'activate' } });
    expect(m.abortTransition).not.toHaveBeenCalled();
    await svc.resume();
    const view = await settle(svc, transitionId);
    expect(view).toMatchObject({ state: 'completed', step: 8 });
    expect(view.error).toBeUndefined();
    await svc.stop();
    const { entry } = logEntry(transitionId);
    expect((entry?.steps as { step: number; result: string }[]).filter((s) => s.step === 7).map((s) => s.result)).toEqual(['error', 'ok']);
    await svc.stop();
  });

  it.each<[string, () => void, string, (id: string) => string, string, string]>([
    [
      'a step failure that aborts',
      () => behaviour.set(3, () => Promise.reject(new Error(`owner answered ${FREE_TEXT}`))),
      'warn',
      (id) => `Transition ${id} step 3 failed, so it aborts`,
      'Error',
      REDACTED,
    ],
    [
      'a step failure after activation',
      () => behaviour.set(7, () => Promise.reject(new Error(`gateway answered ${FREE_TEXT}`))),
      'error',
      (id) => `Transition ${id} step 7 failed and runs again on resume`,
      'Error',
      REDACTED,
    ],
    [
      'a refusal after activation',
      () => behaviour.set(8, () => Promise.reject(new TransitionAbortedError(8, `cannot hand off ${FREE_TEXT}`))),
      'error',
      (id) => `Transition ${id} to v0002 failed`,
      'TransitionAbortedError',
      REDACTED,
    ],
    [
      'an undo that fails',
      () => {
        behaviour.set(5, () => Promise.reject(new TransitionAbortedError(5, 'gates held by another holder')));
        m.abortTransition.mockRejectedValueOnce(new Error(`owner answered ${FREE_TEXT}`));
      },
      'error',
      (id) => `Transition ${id} undo failed; it stays aborting with its gates closed until resumed`,
      'Error',
      REDACTED,
    ],
    [
      'a refused undo',
      () => {
        behaviour.set(6, () => {
          active = 'v0002';
          return Promise.reject(new TransitionAbortedError(6, 'difference'));
        });
        m.abortTransition.mockRejectedValueOnce(new Error(`cannot abort: ${FREE_TEXT}`));
      },
      'error',
      (id) => `Transition ${id} to v0002 failed`,
      'Error',
      REDACTED,
    ],
    [
      'a report mirror that fails',
      () => writeFileSync(path.join(reportsDir, 'transitions.json'), `{"transitions": ${FREE_TEXT}`),
      'error',
      (id) => `Recording transition ${id} in transitions.json failed`,
      'SyntaxError',
      REDACTED,
    ],
    [
      'a loop that stops when its record cannot be stored',
      () => behaviour.set(3, () => Promise.reject(new Error(`\u0000 ${FREE_TEXT}`))),
      'error',
      (id) => `Transition ${id} stopped and continues from its persisted state on resume`,
      // node-postgres names its server errors `error`.
      'error',
      'PostgreSQL error 22P05',
    ],
  ])('logs %s as a fixed line with the safe error, never the error text', async (_label, arrange, level, lineOf, type, message) => {
    arrange();
    const svc = service();
    const { transitionId } = await svc.start({ to: 'v0002' });
    const line = lineOf(transitionId);
    for (let i = 0; i < 400 && !logs.some((l) => l.args.at(-1) === line); i += 1) await delay(10);
    await svc.stop();
    expect(logs.find((l) => l.args.at(-1) === line)).toEqual({ level, args: [{ error: expect.objectContaining({ type, message }) }, line] });
    expect(JSON.stringify(logs)).not.toContain(FREE_TEXT);
  });

  it('marks a refusal after activation, or a refused undo, as failed', async () => {
    behaviour.set(8, async () => {
      throw new TransitionAbortedError(8, 'cannot hand off');
    });
    const svc = service();
    const a = await svc.start({ to: 'v0002' });
    const failed = await settle(svc, a.transitionId);
    expect(failed).toMatchObject({ state: 'aborted', step: 8, error: { step: 8, state: 'failed', message: 'cannot hand off' } });
    expect((await row(a.transitionId)).state).toBe('failed');
    expect(m.abortTransition).not.toHaveBeenCalled();

    behaviour.clear();
    active = 'v0001';
    behaviour.set(6, async () => {
      active = 'v0002';
      throw new TransitionAbortedError(6, 'difference');
    });
    m.abortTransition.mockRejectedValueOnce(new Error('cannot abort: v0002 is already active'));
    const b = await svc.start({ to: 'v0002' });
    const refused = await settle(svc, b.transitionId);
    expect(refused.error).toMatchObject({ state: 'failed', step: 6 });
    expect(String(refused.error?.message)).toContain('the abort was refused');
    await svc.stop();
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('resumes a running row with lastStep %i at the next step', async (lastStep) => {
    const steps = lastStep === 0 ? [] : [{ step: lastStep, name: 'x', startedAt: '2026-06-30T12:00:00.000Z' }];
    const id = await seedRow(lastStep, 'started', steps);
    const svc = service();
    const resumed = await svc.resume();
    expect(resumed).toMatchObject({ transitionId: id, step: lastStep + 1 });
    const view = await settle(svc, id);
    expect(view.state).toBe('completed');
    expect(calls.map((c) => c.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].filter((s) => s > lastStep));
    if (lastStep > 0) {
      const stored = (await row(id)).entries as { steps: { result: string; detail?: string }[] };
      expect(stored.steps[0]).toMatchObject({ result: 'error', detail: 'interrupted' });
    }
    await svc.stop();
  });

  it('stop waits at the step boundary and leaves the row resumable', async () => {
    const hold = deferred();
    let entered = false;
    behaviour.set(2, async (deps, record) => {
      entered = true;
      await deps.persist({ ...record.progress, freezeRequested: true });
      expect((await row(record.transitionId)).paused).toMatchObject({ freezeRequested: true });
      await hold.promise;
      return { plan: record.plan, progress: record.progress };
    });
    const svc = service();
    const { transitionId } = await svc.start({ to: 'v0002' });
    for (let i = 0; i < 200 && !entered; i += 1) await delay(10);
    const stopped = svc.stop();
    hold.resolve();
    await stopped;
    expect(await row(transitionId)).toMatchObject({ state: 'quiescing', step: 3 });
    expect(calls.map((c) => c.step)).toEqual([1, 2]);
    behaviour.clear();
    const next = service();
    await next.resume();
    expect((await settle(next, transitionId)).state).toBe('completed');
    expect(calls.map((c) => c.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await next.stop();
  });

  it('shows the reconciliation report repository-relative and answers unknown ids and no active row', async () => {
    behaviour.set(6, async (_d, record) => ({
      plan: record.plan,
      progress: {
        ...record.progress,
        snapshotSeq: 4,
        reconciliation: { point: 'post-cutover', result: 'zero-difference', differences: 0, reportPath: path.join(reportsDir, 'reconciliation', 'post-cutover.json') },
      },
    }));
    const svc = service();
    const { transitionId } = await svc.start({ to: 'v0002' });
    const view = await settle(svc, transitionId);
    contract(view);
    expect(view.reconciliation).toEqual({ report: 'opt2/reports/reconciliation/post-cutover.json', differences: 0, point: 'post-cutover', result: 'zero-difference' });
    expect(await row(transitionId)).toMatchObject({ snapshot_seq: 4, reconciliation: { point: 'post-cutover', differences: 0 } });
    await svc.stop();
    expect(logEntry(transitionId).entry).toMatchObject({ reconciliation: { point: 'post-cutover', differences: 0, path: 'opt2/reports/reconciliation/post-cutover.json' } });
    await expect(svc.get(cfUuid())).rejects.toBeInstanceOf(TransitionNotFoundError);
    await expect(svc.get(cfUuid())).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.resume()).toBeNull();
    await svc.stop();
  });

  it('builds the contract view from a bare record', () => {
    const view = toTransitionView({
      transitionId: cfUuid(),
      from: 'v0002',
      to: 'v0003',
      state: 'started',
      lastStep: 0,
      progress: initialTransitionProgress(),
      steps: [],
      startedAt: '2026-06-30T12:00:00.000Z',
      updatedAt: '2026-06-30T12:00:00.000Z',
    });
    contract(view);
    expect(view).toEqual({ transitionId: view.transitionId, fromVersion: 'v0002', toVersion: 'v0003', state: 'running', step: 1, units: [], frozenRoutes: [], startedAt: '2026-06-30T12:00:00.000Z' });
  });

  afterEach(() => {
    rmSync(reportsDir, { recursive: true, force: true });
  });
});
