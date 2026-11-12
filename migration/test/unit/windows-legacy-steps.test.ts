// Unit tests for legacy site-monitor steps: write-set derivation, window choice, bridge parameters and failure handling.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LegacyServiceUnavailableError, routeKeyForRequest } from '@opt2/platform/legacy-compat';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { BridgeError, BridgeTimeoutError, type BridgeClient, type BridgeJobName } from '../../src/legacy/index.js';
import { loadUnitCatalog } from '../../src/owners/units.js';
import {
  LEGACY_STEP_ROUTE_KEY,
  LEGACY_STEP_WINDOW_KIND,
  LegacyStepDeadlineError,
  LegacyStepFailedError,
  legacyStepUnits,
  runLegacyStepWith,
  type LegacyStepContext,
  type WindowLifecycle,
} from '../../src/windows/legacy-steps.js';

const CONFIG = loadConfig();
const CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
const WINDOW_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const WIRE_TIME = '2026-06-30T12:00:00.123';
const SERVER_TIME = new Date(WIRE_TIME).toISOString();
const CURSOR = { theTime: '2026-06-30 12:00:00.000', lastMonitored: '2026-06-30 11:45:00.000' };
const BOUNCE_UNITS = ['communications.email_return_stat', 'communications.email_stat'];
const NOW = Date.parse('2026-06-30T12:00:05.000Z');
/** A `deadlineAt` `ms` after the harness clock's start. */
const deadlineIn = (ms: number): string => new Date(NOW + ms).toISOString();

// Fixture version: the bounce units and the file store's tfiles unit are target, communications.email is legacy.
const FIXTURE_VERSION = 'v0099';
let cutoverDir: string;

beforeAll(() => {
  cutoverDir = mkdtempSync(path.join(os.tmpdir(), 'legacy-steps-'));
  mkdirSync(path.join(cutoverDir, 'versions'));
  const groups = [
    { id: 'grp:bounces', units: BOUNCE_UNITS },
    { id: 'grp:email', units: ['communications.email'] },
    { id: 'grp:file', units: ['content.file'] },
  ];
  writeFileSync(path.join(cutoverDir, 'groups.json'), JSON.stringify({ groups }));
  writeFileSync(
    path.join(cutoverDir, 'versions', `${FIXTURE_VERSION}.json`),
    JSON.stringify({
      tableVersion: FIXTURE_VERSION,
      groupAuthority: { 'grp:bounces': 'target', 'grp:email': 'legacy', 'grp:file': 'target' },
      entries: [],
    }),
  );
});

afterAll(() => rmSync(cutoverDir, { recursive: true, force: true }));

interface HarnessOptions {
  tableVersion?: string | null;
  committedCutover?: boolean;
  jobsRun?: BridgeClient['jobsRun'];
  open?: WindowLifecycle['open'];
  complete?: WindowLifecycle['complete'];
  /** Milliseconds the clock advances while a window opens. */
  openTakesMs?: number;
}

function harness(opts: HarnessOptions = {}) {
  let now = NOW;
  const clock = { now: () => new Date(now) };
  const jobsRun = vi.fn<BridgeClient['jobsRun']>(
    opts.jobsRun ??
      ((job, params) => Promise.resolve({ job, ...(params?.siteId === undefined ? {} : { siteId: params.siteId }), completed: true, serverTime: WIRE_TIME })),
  );
  const open = vi.fn<WindowLifecycle['open']>(
    opts.open ??
      (() => {
        now += opts.openTakesMs ?? 0;
        return Promise.resolve({ windowId: WINDOW_ID, state: 'open', phase: 'executing' });
      }),
  );
  const complete = vi.fn<WindowLifecycle['complete']>(opts.complete ?? (() => Promise.resolve({ state: 'closed' })));
  const status = vi.fn(() => Promise.resolve({ tableVersion: opts.tableVersion === undefined ? FIXTURE_VERSION : opts.tableVersion, epoch: 1 }));
  const info = vi.fn();
  const warn = vi.fn();
  const paths = opts.committedCutover
    ? CONFIG.paths
    : { ...CONFIG.paths, cutoverDir, groupsFile: path.join(cutoverDir, 'groups.json') };
  const ctx = {
    bridge: { jobsRun } as unknown as BridgeClient,
    gateway: { status } as unknown as LegacyStepContext['gateway'],
    config: { ...CONFIG, paths },
    catalog: CATALOG,
    logger: { info, warn } as unknown as LegacyStepContext['logger'],
    clock,
  } satisfies LegacyStepContext;
  return { ctx, lifecycle: { open, complete } satisfies WindowLifecycle, jobsRun, open, complete, status, info, warn };
}

describe('LEGACY_STEP_ROUTE_KEY', () => {
  it('is the platform route key of /_api/sitemonitor and windows use the sitemonitor-step kind', () => {
    const key = routeKeyForRequest({ method: 'GET', path: '/index.cfm/_api/sitemonitor/', query: {}, headers: {} }).key;
    expect(key).toBe(LEGACY_STEP_ROUTE_KEY);
    expect(LEGACY_STEP_WINDOW_KIND).toBe('sitemonitor-step');
  });
});

describe('legacyStepUnits', () => {
  it.each<[BridgeJobName, string[]]>([
    ['trackBounces', BOUNCE_UNITS],
    ['emailSend', ['communications.email', ...BOUNCE_UNITS]],
    ['sendReminders', []],
    ['clearOldCommands', []],
    ['purgeDisplayWindow', []],
    ['onGlobalMonitor', []],
    ['onSiteMonitor', []],
    ['setCursor', []],
  ])('derives the migration units of %s from the inventory', (step, units) => {
    expect(legacyStepUnits(harness().ctx, step)).toEqual(units);
  });

  it.each<BridgeJobName>(['publishScheduledChangesets', 'feedAutoImport'])(
    'maps the file store of %s to the tfiles unit and drops decision-list tables',
    (step) => {
      const units = legacyStepUnits(harness().ctx, step);
      expect(units).toContain('content.file');
      expect(units.filter((unit) => unit.startsWith('legacy:') || unit === 'file-store')).toEqual([]);
      expect(units).toEqual([...new Set(units)].sort());
    },
  );
});

describe('runLegacyStepWith', () => {
  it.each<[string, HarnessOptions, BridgeJobName, readonly string[] | undefined]>([
    ['only legacy units', {}, 'emailSend', ['communications.email']],
    ['no active version', { tableVersion: null }, 'trackBounces', undefined],
    ['decision-list units only', {}, 'clearOldCommands', undefined],
  ])('runs the bridge step without a window for %s', async (_case, opts, step, units) => {
    const h = harness(opts);
    const result = await runLegacyStepWith(h.ctx, h.lifecycle, { step, ...CURSOR, ...(units === undefined ? {} : { units }) });

    expect(h.open).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.jobsRun).toHaveBeenCalledExactlyOnceWith(step, { siteId: undefined, ...CURSOR });
    expect(result).toEqual({ response: { step, completed: true, serverTime: SERVER_TIME } });
  });

  it('reads no authority for a step without migration units', async () => {
    const h = harness();
    await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'onGlobalMonitor', ...CURSOR });
    expect(h.status).not.toHaveBeenCalled();
  });

  it('runs a step with a target unit in a sitemonitor-step window scoped to its site', async () => {
    const h = harness();
    const result = await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR });

    expect(h.open).toHaveBeenCalledExactlyOnceWith(
      { routeKey: LEGACY_STEP_ROUTE_KEY, units: BOUNCE_UNITS, scope: { keys: { siteid: 'tenant-a' } }, requestId: expect.any(String) },
      { kind: 'sitemonitor-step' },
    );
    expect(h.jobsRun).toHaveBeenCalledExactlyOnceWith('trackBounces', { siteId: 'tenant-a', ...CURSOR });
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(WINDOW_ID, { forwarded: true });
    expect(h.open.mock.invocationCallOrder[0]).toBeLessThan(h.jobsRun.mock.invocationCallOrder[0] ?? 0);
    expect(h.jobsRun.mock.invocationCallOrder[0]).toBeLessThan(h.complete.mock.invocationCallOrder[0] ?? 0);
    expect(result).toEqual({
      response: { step: 'trackBounces', completed: true, serverTime: SERVER_TIME, siteId: 'tenant-a', windowId: WINDOW_ID },
      windowState: 'closed',
    });
    expect(h.info).toHaveBeenCalledOnce();
  });

  it('leases every migration unit of the step, scopes a siteless step to the table and warns on import-pending', async () => {
    const h = harness({ complete: () => Promise.resolve({ state: 'import-pending' }) });
    const result = await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'purgeDisplayWindow', ...CURSOR, units: ['file-store', 'legacy:tcontent', 'communications.email'] });

    expect(h.open.mock.calls[0]?.[0]).toMatchObject({ units: ['communications.email', 'content.file'], scope: { table: true } });
    expect(result.windowState).toBe('import-pending');
    expect(h.warn).toHaveBeenCalledOnce();
  });

  it('sends setCursor its run time as value', async () => {
    const h = harness();
    await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'setCursor', ...CURSOR });
    expect(h.jobsRun).toHaveBeenCalledExactlyOnceWith('setCursor', { value: CURSOR.theTime });
  });

  it('completes the window when the bridge step fails, then throws the 503 error carrying the bridge failure', async () => {
    const bridgeError = new BridgeError('jobs.trackBounces', 500, { error: 'serverError' });
    const h = harness({ jobsRun: () => Promise.reject(bridgeError) });
    const error: unknown = await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR }).catch((e: unknown) => e);

    expect(h.complete).toHaveBeenCalledExactlyOnceWith(WINDOW_ID, { forwarded: true });
    expect(error).toBeInstanceOf(LegacyStepFailedError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ step: 'trackBounces', siteId: 'tenant-a', windowId: WINDOW_ID, reason: 'legacy-step-failed', cause: bridgeError });
  });

  it('throws the 503 error without a window id when an unwindowed step fails', async () => {
    const cause = new TypeError('fetch failed');
    const h = harness({ jobsRun: () => Promise.reject(cause) });
    const error: unknown = await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'sendReminders', ...CURSOR }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyStepFailedError);
    expect(error).toMatchObject({ windowId: undefined, cause });
  });

  it('reports both failures when the bridge step and the completion fail, and a lone completion failure unchanged', async () => {
    const completeError = new Error('complete failed');
    const both = harness({ jobsRun: () => Promise.reject(new Error('bridge')), complete: () => Promise.reject(completeError) });
    const error: unknown = await runLegacyStepWith(both.ctx, both.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([expect.any(LegacyStepFailedError), completeError]);

    const lone = harness({ complete: () => Promise.reject(completeError) });
    await expect(runLegacyStepWith(lone.ctx, lone.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR })).rejects.toBe(completeError);
  });

  it('propagates an open refusal unchanged and never runs the bridge step', async () => {
    const refusal = new LegacyServiceUnavailableError('refused', 'auto', 'lease-unavailable');
    const h = harness({ open: () => Promise.reject(refusal) });

    await expect(runLegacyStepWith(h.ctx, h.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR })).rejects.toBe(refusal);
    expect(h.jobsRun).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ['at this instant', deadlineIn(0)],
    ['a second ago', deadlineIn(-1_000)],
  ])('throws the deadline error without reading authority, opening a window or calling the bridge for a deadlineAt %s', async (_label, deadlineAt) => {
    const h = harness();
    const error: unknown = await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR, deadlineAt }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyStepDeadlineError);
    expect(error).toBeInstanceOf(LegacyStepFailedError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({
      name: 'LegacyStepDeadlineError',
      step: 'trackBounces',
      siteId: 'tenant-a',
      windowId: undefined,
      reason: 'legacy-step-deadline',
      message: 'Legacy site-monitor step trackBounces for site tenant-a did not complete before its deadline',
    });
    expect(h.status).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.jobsRun).not.toHaveBeenCalled();
  });

  it.each<[string, BridgeJobName, string | undefined, number, number]>([
    ['outside a window', 'sendReminders', undefined, 0, 4_000],
    ['in a window, after the time its opening took', 'trackBounces', 'tenant-a', 1_500, 2_500],
  ])('bounds the bridge call %s by the time left before deadlineAt', async (_label, step, siteId, openTakesMs, timeoutMs) => {
    const h = harness({ openTakesMs });
    await runLegacyStepWith(h.ctx, h.lifecycle, { step, ...CURSOR, ...(siteId === undefined ? {} : { siteId }), deadlineAt: deadlineIn(4_000) });

    expect(h.jobsRun).toHaveBeenCalledExactlyOnceWith(step, { siteId, ...CURSOR }, { timeoutMs });
  });

  it('passes the bridge no options without deadlineAt, so the bridge bound applies', async () => {
    const h = harness();
    await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR });

    expect(h.jobsRun.mock.calls[0]).toEqual(['trackBounces', { siteId: 'tenant-a', ...CURSOR }]);
  });

  it('completes the window unforwarded and throws the deadline error when deadlineAt passes while it opens', async () => {
    const h = harness({ openTakesMs: 1_000 });
    const error: unknown = await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR, deadlineAt: deadlineIn(1_000) }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(LegacyStepDeadlineError);
    expect(error).toMatchObject({ windowId: WINDOW_ID, cause: undefined });
    expect(h.jobsRun).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(WINDOW_ID, { forwarded: false });
  });

  it('leaves the window executing, warns and throws the deadline error when the bridge times out in a window', async () => {
    const timeout = new BridgeTimeoutError('jobs.trackBounces', 4_000, new DOMException('The operation timed out.', 'TimeoutError'));
    const h = harness({ jobsRun: () => Promise.reject(timeout) });
    const error: unknown = await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'trackBounces', siteId: 'tenant-a', ...CURSOR, deadlineAt: deadlineIn(4_000) }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(LegacyStepDeadlineError);
    expect(error).toMatchObject({ step: 'trackBounces', siteId: 'tenant-a', windowId: WINDOW_ID, cause: timeout });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledExactlyOnceWith(
      { requestId: expect.any(String) },
      `Legacy step trackBounces for site tenant-a did not answer within 4000 ms; window ${WINDOW_ID} is left executing`,
    );
  });

  it('throws the deadline error when the bridge times out outside a window', async () => {
    const timeout = new BridgeTimeoutError('jobs.sendReminders', 600_000, new DOMException('The operation timed out.', 'TimeoutError'));
    const h = harness({ jobsRun: () => Promise.reject(timeout) });
    const error: unknown = await runLegacyStepWith(h.ctx, h.lifecycle, { step: 'sendReminders', ...CURSOR }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyStepDeadlineError);
    expect(error).toMatchObject({ windowId: undefined, cause: timeout });
  });

  it('runs every step without a window under the committed v0002', async () => {
    const h = harness({ tableVersion: 'v0002', committedCutover: true });
    const runs: Array<[BridgeJobName, string?]> = [
      ['sendReminders'],
      ['emailSend'],
      ['publishScheduledChangesets'],
      ['trackBounces', 'tenant-a'],
      ['feedAutoImport', 'tenant-a'],
      ['purgeDisplayWindow'],
      ['clearOldCommands'],
      ['onGlobalMonitor'],
      ['onSiteMonitor', 'tenant-a'],
      ['setCursor'],
    ];
    for (const [step, siteId] of runs) {
      await runLegacyStepWith(h.ctx, h.lifecycle, { step, ...CURSOR, ...(siteId === undefined ? {} : { siteId }) });
    }
    expect(h.open).not.toHaveBeenCalled();
    expect(h.jobsRun).toHaveBeenCalledTimes(runs.length);
  });
});
