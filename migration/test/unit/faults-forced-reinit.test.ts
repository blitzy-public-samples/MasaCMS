// Unit tests for the forced-reinit fault script, over a fake live tcontent table, transaction and guard collaborators.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runFeed, type FeedResult } from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { currentAuthority, type CurrentAuthority } from '../../src/cutover/index.js';
import { forcedReinit } from '../../src/faults/scripts/forced-reinit.js';
import type { FaultEnv, FaultRunOutput } from '../../src/faults/scripts/types.js';
import { STARTUP_COUNT_SQL } from '../../src/legacy/index.js';
import { holdersOf } from '../../src/windows/leases.js';
import type { WindowLifecycle } from '../../src/windows/legacy-steps.js';
import { freezeLegacyBound, runReloadWindowWith, unfreezeLegacyBound, type FrozenRoutes } from '../../src/windows/reload.js';
import { completeWindowViaService, openWindowViaService } from '../../src/windows/via-service.js';

/** One tcontent version of an active File node. */
interface Row {
  ContentHistID: string;
  ContentID: string;
  Body: string | null;
  Filename: string | null;
  URLTitle: string | null;
}

/** The fake live legacy database: committed rows, the open transaction's copy, and configured failures. */
interface FakeDb {
  committed: Row[];
  pending: Row[] | undefined;
  /** Matching rows outside the fake table, for a predicate already non-empty before the fault. */
  extraStartupRows: number;
  clearedRows: number;
  commitError: Error | undefined;
  rollbackError: Error | undefined;
  txCalls: string[];
}

const legacy = vi.hoisted(() => ({ db: undefined as unknown as FakeDb }));

vi.mock('mssql', async (importOriginal) => {
  // The driver is CommonJS: the script's `sql` is the module's default export.
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  /** Driver transaction stand-in over the fake database. */
  class FakeTransaction {
    begin(): Promise<void> {
      legacy.db.txCalls.push('begin');
      legacy.db.pending = legacy.db.committed.map((row) => ({ ...row }));
      return Promise.resolve();
    }
    request(): unknown {
      return fakeRequest(() => legacy.db.pending ?? legacy.db.committed);
    }
    commit(): Promise<void> {
      legacy.db.txCalls.push('commit');
      if (legacy.db.commitError !== undefined) return Promise.reject(legacy.db.commitError);
      legacy.db.committed = legacy.db.pending ?? legacy.db.committed;
      legacy.db.pending = undefined;
      return Promise.resolve();
    }
    rollback(): Promise<void> {
      legacy.db.txCalls.push('rollback');
      legacy.db.pending = undefined;
      return legacy.db.rollbackError === undefined ? Promise.resolve() : Promise.reject(legacy.db.rollbackError);
    }
  }
  return { ...actual, default: { ...actual.default, Transaction: FakeTransaction } };
});

vi.mock('../../src/windows/reload.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/windows/reload.js')>()),
  freezeLegacyBound: vi.fn(),
  unfreezeLegacyBound: vi.fn(),
  runReloadWindowWith: vi.fn(),
}));
vi.mock('../../src/windows/leases.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/windows/leases.js')>()),
  holdersOf: vi.fn(),
}));
vi.mock('../../src/windows/via-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/windows/via-service.js')>()),
  openWindowViaService: vi.fn(),
  completeWindowViaService: vi.fn(),
}));
vi.mock('../../src/cutover/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cutover/index.js')>()),
  currentAuthority: vi.fn(),
}));
vi.mock('../../src/apply/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apply/index.js')>()),
  runFeed: vi.fn(),
}));

const HIST_ID = 'A0000000-0000-0000-0000000000000001';
const CONTENT_ID = 'B0000000-0000-0000-0000000000000001';
const WINDOW_ID = 'C0000000-0000-0000-0000000000000001';
const CONTENT_UNITS = ['content.content', 'content.file'];
const FROZEN: FrozenRoutes = { routes: ['admin:carch.list', 'page:render'], epoch: 7 };
const NOT_CONVERTED = 'Masa did not convert the row (configBean readonly, or the reload did not re-run onApplicationStart)';
const ORIGINAL: Row = { ContentHistID: HIST_ID, ContentID: CONTENT_ID, Body: 'old-body', Filename: 'doc.pdf', URLTitle: 'doc' };

function matching(rows: readonly Row[]): number {
  return legacy.db.extraStartupRows + rows.filter((row) => row.Body === null && row.Filename !== null).length;
}

/** Request stand-in answering the script's statements and the start-up count over `rows()`. */
function fakeRequest(rows: () => Row[]) {
  const inputs = new Map<string, unknown>();
  const request = {
    input(name: string, _type: unknown, value: unknown) {
      inputs.set(name, value);
      return request;
    },
    query(text: string) {
      const answer = (recordset: unknown[], rowsAffected = recordset.length) => Promise.resolve({ recordset, rowsAffected: [rowsAffected] });
      if (text === STARTUP_COUNT_SQL) return answer([{ n: matching(rows()) }]);
      if (text.startsWith('SELECT TOP 1')) return answer(rows().filter((row) => row.Body !== null).slice(0, 1));
      if (text.startsWith('UPDATE tcontent SET Body = NULL')) {
        for (const row of rows()) if (row.ContentHistID === inputs.get('h')) row.Body = null;
        return answer([], legacy.db.clearedRows);
      }
      if (text.startsWith('SELECT Body')) {
        const found = rows().find((row) => row.ContentHistID === inputs.get('h'));
        return answer(found === undefined ? [] : [{ Body: found.Body, Filename: found.Filename, URLTitle: found.URLTitle }]);
      }
      return Promise.reject(new Error(`unexpected SQL: ${text}`));
    },
  };
  return request;
}

/** Masa's start-up conversion: Body = Filename on every matching row, with a uniquified filename. */
function convertRows(): void {
  for (const row of legacy.db.committed) {
    if (row.Body === null && row.Filename !== null) Object.assign(row, { Body: row.Filename, Filename: `${row.Filename}-1`, URLTitle: 'doc-1' });
  }
}

/** A reload window that opens and completes through `lifecycle`, converting rows unless Masa is read-only. */
function reloadWith(opts: { convert: boolean }) {
  return async (_ctx: unknown, lifecycle: WindowLifecycle) => {
    const { windowId } = await lifecycle.open(
      { routeKey: 'startup-guard:reload', units: CONTENT_UNITS, scope: { table: true }, requestId: 'req-1' },
      { kind: 'reload' },
    );
    if (opts.convert) convertRows();
    const { state } = await lifecycle.complete(windowId, { forwarded: true, legacyStatus: 200 });
    if (state === 'unknown') throw new Error('unexpected window state');
    return { windowId, legacyStatus: 200, windowState: state, startupRowsRemaining: matching(legacy.db.committed) };
  };
}

function authorityOf(targetUnits: readonly string[]): CurrentAuthority {
  const target = new Set(targetUnits);
  return { tableVersion: 'v0001', epoch: 1, units: new Map(), targetUnits: target, isTargetAuthoritative: (unit) => target.has(unit), anyTarget: target.size > 0 };
}

function feedResult(exitCode: 0 | 1): FeedResult {
  return {
    snapshotSeq: 4,
    tableVersion: 'v0001',
    bases: {},
    tables: [],
    files: { status: 'up-to-date', from: 3, to: 4 },
    reconciliation: { point: 'after-feed-4', result: exitCode === 0 ? 'zero-difference' : 'difference', reportPath: '/reports/after-feed-4.json' },
    exitCode,
  };
}

function envOf(): FaultEnv {
  const pool = { request: () => fakeRequest(() => legacy.db.committed) };
  const ctx = {
    legacy: { live: () => Promise.resolve(pool) },
    catalog: { units: () => [...CONTENT_UNITS, 'identity.user_account'].map((id) => ({ id })) },
    gateway: {},
    config: { paths: {} },
  } as unknown as MigrationContext;
  return { ctx } as unknown as FaultEnv;
}

beforeEach(() => {
  vi.clearAllMocks();
  legacy.db = { committed: [{ ...ORIGINAL }], pending: undefined, extraStartupRows: 0, clearedRows: 1, commitError: undefined, rollbackError: undefined, txCalls: [] };
  vi.mocked(holdersOf).mockResolvedValue(new Map());
  vi.mocked(freezeLegacyBound).mockResolvedValue(FROZEN);
  vi.mocked(unfreezeLegacyBound).mockResolvedValue(undefined);
  vi.mocked(runReloadWindowWith).mockImplementation(reloadWith({ convert: true }));
  vi.mocked(openWindowViaService).mockResolvedValue({ windowId: WINDOW_ID, state: 'open', phase: 'executing' });
  vi.mocked(completeWindowViaService).mockResolvedValue({ state: 'closed' });
  vi.mocked(currentAuthority).mockResolvedValue(authorityOf([]));
  vi.mocked(runFeed).mockResolvedValue(feedResult(0));
});

const byName = (output: { assertions: { name: string; status: string }[] }) =>
  Object.fromEntries(output.assertions.map((assertion) => [assertion.name, assertion.status]));

describe('forced-reinit fault script', () => {
  it('is the config fault forced-reinit and reconciles afterwards', () => {
    expect(forcedReinit.name).toBe('forced-reinit');
    expect(forcedReinit.reconciles).toBe(true);
    expect(loadConfig().faults.map((fault) => fault.name)).toContain(forcedReinit.name);
  });

  it.each([
    [{}, { siteId: 'tenant-a' }],
    [{ siteId: 'tenant-b' }, { siteId: 'tenant-b' }],
  ])('parses %j as %j', (input, expected) => {
    expect(forcedReinit.paramsSchema.parse(input)).toStrictEqual(expected);
  });

  it.each([{ siteId: '' }, { siteId: 3 }, { site: 'tenant-a' }])('rejects %j', (input) => {
    expect(forcedReinit.paramsSchema.safeParse(input).success).toBe(false);
  });
});

describe('forced-reinit run', () => {
  it.each([
    [
      'the predicate already matches rows',
      () => {
        legacy.db.extraStartupRows = 2;
      },
      { name: 'predicate-empty-before', status: 'fail', detail: { count: 2 }, reason: 'start-up predicate already non-empty' },
    ],
    [
      'a content unit is leased',
      () => {
        vi.mocked(holdersOf).mockResolvedValue(new Map([['content.file', 'W-1']]));
      },
      { name: 'content-units-free', status: 'fail', detail: { holders: { 'content.file': 'W-1' } }, reason: 'content units are leased' },
    ],
    [
      'the site has no active File content with a body',
      () => {
        legacy.db.committed = [{ ...ORIGINAL, Body: null, Filename: null }];
      },
      { name: 'guard-triggered', status: 'fail', detail: { siteId: 'tenant-a' }, reason: 'no active File content with a body for the site' },
    ],
  ])('stops before any write when %s', async (_label, arrange, failed) => {
    arrange();
    const output = await forcedReinit.run(envOf(), { siteId: 'tenant-a' });

    expect(output.assertions.at(-1)).toStrictEqual(failed);
    expect(output.assertions.slice(0, -1).every((assertion) => assertion.status === 'pass')).toBe(true);
    expect(output.details).toStrictEqual({ siteId: 'tenant-a' });
    expect(output.state).toBeUndefined();
    expect(legacy.db.txCalls).toStrictEqual([]);
    expect(freezeLegacyBound).not.toHaveBeenCalled();
  });

  it('clears the row in a transaction committed under the guard: freeze, commit, reload window, unfreeze', async () => {
    const env = envOf();
    const output = await forcedReinit.run(env, { siteId: 'tenant-a' });

    expect(holdersOf).toHaveBeenCalledWith(env.ctx, CONTENT_UNITS);
    expect(legacy.db.txCalls).toStrictEqual(['begin', 'commit']);
    expect(freezeLegacyBound).toHaveBeenCalledExactlyOnceWith(env.ctx);
    expect(unfreezeLegacyBound).toHaveBeenCalledExactlyOnceWith(env.ctx, FROZEN);
    expect(openWindowViaService).toHaveBeenCalledExactlyOnceWith(env.ctx, {
      routeKey: 'startup-guard:reload',
      units: CONTENT_UNITS,
      scope: { table: true },
    });
    expect(completeWindowViaService).toHaveBeenCalledExactlyOnceWith(env.ctx, WINDOW_ID, { forwarded: true });

    const reload = { windowId: WINDOW_ID, legacyStatus: 200, windowState: 'closed', startupRowsRemaining: 0 };
    const before = { Body: 'old-body', Filename: 'doc.pdf', URLTitle: 'doc' };
    const after = { Body: 'doc.pdf', Filename: 'doc.pdf-1', URLTitle: 'doc-1' };
    expect(output).toStrictEqual({
      assertions: [
        { name: 'predicate-empty-before', status: 'pass', detail: { count: 0 } },
        { name: 'content-units-free', status: 'pass' },
        { name: 'guard-triggered', status: 'pass', detail: { guarded: true, count: 1 } },
        { name: 'guard-sequence', status: 'pass', detail: { order: ['freeze', 'commit', 'reload-window', 'unfreeze'], reload } },
        { name: 'predicate-empty-after', status: 'pass', detail: { count: 0 } },
        { name: 'row-converted', status: 'pass', detail: { before, after } },
      ],
      details: {
        siteId: 'tenant-a',
        contentHistId: HIST_ID,
        contentId: CONTENT_ID,
        before,
        after,
        order: ['freeze', 'commit', 'reload-window', 'unfreeze'],
        reload,
        error: null,
      },
      state: { contentHistId: HIST_ID },
    });
  });

  it('fails the conversion with the readonly reason and keeps the freeze in state when Masa leaves Body null', async () => {
    vi.mocked(runReloadWindowWith).mockImplementation(reloadWith({ convert: false }));
    const output = await forcedReinit.run(envOf(), { siteId: 'tenant-a' });

    expect(byName(output)).toStrictEqual({
      'predicate-empty-before': 'pass',
      'content-units-free': 'pass',
      'guard-triggered': 'fail',
      'guard-sequence': 'fail',
      'predicate-empty-after': 'fail',
      'row-converted': 'fail',
    });
    expect(output.assertions.find((assertion) => assertion.name === 'row-converted')?.reason).toBe(NOT_CONVERTED);
    expect(output.details?.['order']).toStrictEqual(['freeze', 'commit', 'reload-window']);
    expect(output.details?.['error']).toMatchObject({ name: 'StartupGuardFrozenError' });
    expect(unfreezeLegacyBound).not.toHaveBeenCalled();
    expect(output.state).toStrictEqual({ contentHistId: HIST_ID, frozen: FROZEN });
  });

  it.each([
    [
      'the freeze fails',
      () => {
        vi.mocked(freezeLegacyBound).mockRejectedValue(new Error('freeze timed out'));
      },
      ['freeze', 'unfreeze'],
      ['begin', 'rollback'],
    ],
    [
      'the commit fails',
      () => {
        legacy.db.commitError = new Error('connection lost');
      },
      ['freeze', 'commit', 'unfreeze'],
      ['begin', 'commit', 'rollback'],
    ],
    [
      'the update changes no row',
      () => {
        legacy.db.clearedRows = 0;
      },
      [],
      ['begin', 'rollback'],
    ],
  ])('rolls back and skips the conversion check when %s', async (_label, arrange, order, txCalls) => {
    arrange();
    const output = await forcedReinit.run(envOf(), { siteId: 'tenant-a' });

    expect(legacy.db.txCalls).toStrictEqual(txCalls);
    expect(legacy.db.committed).toStrictEqual([ORIGINAL]);
    expect(output.details?.['order']).toStrictEqual(order);
    expect(byName(output)).toMatchObject({ 'guard-triggered': 'fail', 'guard-sequence': 'fail', 'predicate-empty-after': 'pass', 'row-converted': 'skipped' });
    expect(output.state).toStrictEqual({ contentHistId: HIST_ID });
  });

  it('reports a failed rollback beside the commit failure', async () => {
    legacy.db.commitError = new Error('connection lost');
    legacy.db.rollbackError = new Error('transaction already ended');
    const output = await forcedReinit.run(envOf(), { siteId: 'tenant-a' });

    expect(output.details).toMatchObject({
      error: { name: 'Error', message: 'connection lost' },
      rollbackError: { name: 'Error', message: 'transaction already ended' },
    });
  });

  it('records the freeze as held when unfreezing fails after the conversion', async () => {
    vi.mocked(unfreezeLegacyBound).mockRejectedValue(new Error('gateway unavailable'));
    const output = await forcedReinit.run(envOf(), { siteId: 'tenant-a' });

    expect(byName(output)).toMatchObject({ 'guard-triggered': 'fail', 'guard-sequence': 'pass', 'row-converted': 'pass' });
    expect(output.details?.['error']).toStrictEqual({ name: 'Error', message: 'gateway unavailable' });
    expect(output.state).toStrictEqual({ contentHistId: HIST_ID, frozen: FROZEN });
  });

  it('turns a failed post-guard read into failed assertions', async () => {
    const env = envOf();
    const live = await env.ctx.legacy.live();
    const reads = vi.spyOn(live, 'request');
    vi.mocked(runReloadWindowWith).mockImplementation(async (ctx, lifecycle) => {
      const result = await reloadWith({ convert: true })(ctx, lifecycle);
      reads.mockImplementation(() => {
        throw new Error('pool closed');
      });
      return result;
    });
    const output = await forcedReinit.run(env, { siteId: 'tenant-a' });

    const failure = { status: 'fail', detail: { error: { name: 'Error', message: 'pool closed' } } };
    expect(output.assertions.slice(-2)).toStrictEqual([
      { name: 'predicate-empty-after', ...failure },
      { name: 'row-converted', ...failure },
    ]);
  });
});

describe('forced-reinit resume', () => {
  const outputWith = (frozen?: FrozenRoutes): FaultRunOutput => ({
    assertions: [],
    state: { contentHistId: HIST_ID, ...(frozen === undefined ? {} : { frozen }) },
  });

  it.each([
    ['the freeze run left in place', FROZEN, false],
    ['a fresh freeze', undefined, true],
  ])('converts remaining rows under %s and unfreezes once none match', async (_label, held, freshFreeze) => {
    legacy.db.committed = [{ ...ORIGINAL, Body: null }];
    const env = envOf();
    const output = await forcedReinit.resume(env, { siteId: 'tenant-a' }, outputWith(held));

    expect(vi.mocked(freezeLegacyBound).mock.calls.length > 0).toBe(freshFreeze);
    expect(unfreezeLegacyBound).toHaveBeenCalledExactlyOnceWith(env.ctx, FROZEN);
    expect(output.steps).toStrictEqual(['reload-again', 'rerun-feed']);
    expect(output.assertions[0]).toMatchObject({ name: 'resume-predicate-empty', status: 'pass', detail: { count: 1 } });
    expect(legacy.db.committed[0]?.Body).toBe('doc.pdf');
  });

  it('keeps the freeze and fails when the reload leaves matching rows', async () => {
    legacy.db.committed = [{ ...ORIGINAL, Body: null }];
    vi.mocked(runReloadWindowWith).mockImplementation(reloadWith({ convert: false }));
    const output = await forcedReinit.resume(envOf(), { siteId: 'tenant-a' }, undefined);

    expect(unfreezeLegacyBound).not.toHaveBeenCalled();
    expect(output.assertions[0]).toMatchObject({
      name: 'resume-predicate-empty',
      status: 'fail',
      detail: { error: { name: 'StartupGuardFrozenError' } },
    });
  });

  it('only lifts a held freeze when no row matches', async () => {
    const env = envOf();
    const output = await forcedReinit.resume(env, { siteId: 'tenant-a' }, outputWith(FROZEN));

    expect(runReloadWindowWith).not.toHaveBeenCalled();
    expect(unfreezeLegacyBound).toHaveBeenCalledExactlyOnceWith(env.ctx, FROZEN);
    expect(output.steps).toStrictEqual(['unfreeze-held', 'rerun-feed']);
    expect(byName(output)).toStrictEqual({ 'held-freeze-lifted': 'pass', 'resume-predicate-empty': 'pass', 'feed-propagated': 'pass' });
  });

  it.each([
    ['every content unit is legacy-authoritative', [], ['rerun-feed'], CONTENT_UNITS],
    ['one content unit is still legacy-authoritative', ['content.content'], ['rerun-feed'], ['content.file']],
    ['every content unit is target-authoritative', CONTENT_UNITS, [], []],
  ])('runs the feed only for legacy-authoritative content units: %s', async (_label, targetUnits, steps, feedUnits) => {
    vi.mocked(currentAuthority).mockResolvedValue(authorityOf(targetUnits));
    const output = await forcedReinit.resume(envOf(), { siteId: 'tenant-a' }, outputWith());

    expect(output.steps).toStrictEqual(steps);
    expect(vi.mocked(runFeed).mock.calls.length).toBe(steps.length);
    expect(output.details).toStrictEqual({ startupRows: 0, feedUnits });
    expect(freezeLegacyBound).not.toHaveBeenCalled();
    expect(runReloadWindowWith).not.toHaveBeenCalled();
  });

  it.each([
    [
      'reconciles with differences',
      () => vi.mocked(runFeed).mockResolvedValue(feedResult(1)),
      {
        name: 'feed-propagated',
        status: 'fail',
        detail: { snapshotSeq: 4, point: 'after-feed-4', result: 'difference', reportPath: '/reports/after-feed-4.json' },
        reason: 'the feed reconciliation found differences',
      },
    ],
    [
      'throws',
      () => vi.mocked(runFeed).mockRejectedValue(new Error('snapshot failed')),
      { name: 'feed-propagated', status: 'fail', detail: { error: { name: 'Error', message: 'snapshot failed' } } },
    ],
  ])('fails feed-propagated when the feed %s', async (_label, arrange, failed) => {
    arrange();
    const output = await forcedReinit.resume(envOf(), { siteId: 'tenant-a' }, outputWith());

    expect(output.assertions.at(-1)).toStrictEqual(failed);
  });

  it('passes feed-propagated with the zero-difference reconciliation', async () => {
    const output = await forcedReinit.resume(envOf(), { siteId: 'tenant-a' }, outputWith());

    expect(output.assertions.at(-1)).toStrictEqual({
      name: 'feed-propagated',
      status: 'pass',
      detail: { snapshotSeq: 4, point: 'after-feed-4', result: 'zero-difference', reportPath: '/reports/after-feed-4.json' },
    });
  });
});
