/** Site-monitor orchestrator: cursor, run lease, catch-up, step order, per-site gating, abort and deadline; default adapters against PostgreSQL. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { SYSTEM_TENANT_ID, tenantIdForSite, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { ServiceUnavailableError, fixedClock, type Clock } from '@opt2/platform/service-kit';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  SiteMonitorRunError,
  SiteMonitorUnavailableError,
  defaultCursorStore,
  registrySiteFlags,
  runSiteMonitor,
  type CursorStore,
  type MonitoredSite,
  type SiteFlagsSource,
} from '../../../src/jobs/sitemonitor.js';
import { SiteMonitorDeadlineError, type StepDispatcher, type StepInvocation, type StepOutcome } from '../../../src/jobs/dispatch.js';
import type { SiteMonitorStepName } from '../../../src/jobs/steps.js';
import { OWNER, createProgramsSitesRepository } from '../../../src/repo/repository.js';
import { readCursor, writeCursor } from '../../../src/repo/sitemonitor-state.js';
import { SITE, UNITS } from '../../../src/repo/tables.js';

const MINUTE_MS = 60_000;
const DEADLINE_MS = 600_000;
// Every orchestrator test injects its cursor and site ports, so the database is never reached.
const NO_DB = { schema: 'programs_sites' } as unknown as TenantDb;
const STORED = new Date(2026, 5, 30, 11, 30, 10);
const RUN_AT = new Date(2026, 5, 30, 12, 0, 45);

/** In-memory lease port: stored cursor values, granted and released lease ids, and a takeover by another pass. */
interface FakeCursor extends CursorStore {
  writes: Date[];
  granted: string[];
  released: string[];
  takeOver(): void;
}

/** Lease port over cursor `initial`; answers the first `busy` acquires busy, and every release throws `releaseError` when set. */
function fakeCursor(initial: Date | null, opts: { log?: string[]; busy?: number; releaseError?: Error } = {}): FakeCursor {
  let value = initial;
  let holder: string | null = null;
  let busy = opts.busy ?? 0;
  const log = opts.log ?? [];
  const cursor: FakeCursor = {
    writes: [],
    granted: [],
    released: [],
    takeOver() {
      holder = 'another-pass';
    },
    async acquire(leaseId) {
      log.push('lease.acquire');
      if (busy > 0) {
        busy -= 1;
        return { status: 'busy' };
      }
      holder = leaseId;
      cursor.granted.push(leaseId);
      return { status: 'granted', lastMonitored: value };
    },
    async advance(leaseId, at) {
      log.push(`cursor.advance@${at.getTime()}`);
      if (holder !== leaseId) return false;
      cursor.writes.push(at);
      value = at;
      return true;
    },
    async release(leaseId) {
      log.push('lease.release');
      if (opts.releaseError !== undefined) throw opts.releaseError;
      cursor.released.push(leaseId);
      if (holder !== leaseId) return false;
      holder = null;
      return true;
    },
  };
  return cursor;
}

/** A clock that `sleep` moves forward, recording each wait. */
function sleepingClock(start: Date): { clock: Clock; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let now = start.getTime();
  const sleeps: number[] = [];
  return {
    clock: { now: () => new Date(now) },
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

function fakeSites(sites: MonitoredSite[]): SiteFlagsSource {
  return { list: async () => sites };
}

function site(siteId: string, flags: { eb?: boolean; fm?: boolean; orderNo: number; mail?: string }): MonitoredSite {
  return {
    siteId,
    tenantId: tenantIdForSite(siteId),
    emailBroadcaster: flags.eb ?? false,
    feedManager: flags.fm ?? false,
    mailServerUsername: flags.mail ?? '',
    orderNo: flags.orderNo,
  };
}

function label(inv: { step: SiteMonitorStepName | { step: SiteMonitorStepName }; siteId?: string }): string {
  const step = typeof inv.step === 'string' ? inv.step : inv.step.step;
  return inv.siteId === undefined ? step : `${step}@${inv.siteId}`;
}

interface RecordingDispatcher extends StepDispatcher {
  calls: StepInvocation[];
}

/** Records each invocation; throws `error` on `failOn` and runs `beforeAnswer` before answering. */
function recordingDispatcher(opts: { failOn?: SiteMonitorStepName; error?: unknown; log?: string[]; beforeAnswer?: (inv: StepInvocation) => void } = {}): RecordingDispatcher {
  const calls: StepInvocation[] = [];
  return {
    calls,
    async dispatch(inv) {
      calls.push(inv);
      opts.log?.push(`dispatch:${label(inv)}`);
      opts.beforeAnswer?.(inv);
      if (inv.step.step === opts.failOn) throw opts.error;
      const outcome: StepOutcome = {
        step: inv.step.step,
        ...(inv.siteId === undefined ? {} : { siteId: inv.siteId }),
        route: 'legacy',
        theTime: inv.theTime,
      };
      return outcome;
    },
  };
}

function run(
  dispatch: StepDispatcher,
  opts: { at?: Date; cursor?: CursorStore; sites?: SiteFlagsSource; clock?: Clock; sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number } = {},
) {
  return runSiteMonitor({
    db: NO_DB,
    clock: opts.clock ?? fixedClock(opts.at ?? RUN_AT),
    dispatch,
    cursor: opts.cursor ?? fakeCursor(STORED),
    sites: opts.sites ?? fakeSites([]),
    ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
    ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }),
  });
}

/** The rejection of `promise`, asserted to be an instance of `type`. */
async function runError<E>(promise: Promise<unknown>, type: abstract new (...args: never[]) => E): Promise<E> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(type);
  return err as E;
}

describe('runSiteMonitor cursor', () => {
  it('defaults a missing cursor to theTime - 1 min and stores it before the first step', async () => {
    const theTime = new Date(2026, 5, 30, 12, 0, 30);
    const log: string[] = [];
    const cursor = fakeCursor(null, { log });
    const dispatcher = recordingDispatcher({ log });

    await run(dispatcher, { at: theTime, cursor });

    expect(log.slice(0, 3)).toEqual(['lease.acquire', `cursor.advance@${theTime.getTime() - MINUTE_MS}`, 'dispatch:sendReminders']);
    expect(new Set(dispatcher.calls.map((c) => c.lastMonitored.getTime()))).toEqual(new Set([theTime.getTime() - MINUTE_MS]));
  });

  it('moves the cursor to theTime once, after setCursor succeeded', async () => {
    const log: string[] = [];
    const cursor = fakeCursor(STORED, { log });
    const dispatcher = recordingDispatcher({ log });

    const result = await run(dispatcher, { cursor });

    expect(log.slice(-3)).toEqual(['dispatch:setCursor', `cursor.advance@${RUN_AT.getTime()}`, 'lease.release']);
    expect(cursor.writes.map((d) => d.getTime())).toEqual([RUN_AT.getTime()]);
    expect(result.theTime.getTime()).toBe(RUN_AT.getTime());
    expect(result.steps.map(label)).toEqual(dispatcher.calls.map(label));
  });
});

describe('runSiteMonitor run lease', () => {
  it('waits while another pass holds the lease and takes theTime after the grant', async () => {
    const { clock, sleep, sleeps } = sleepingClock(RUN_AT);
    const cursor = fakeCursor(STORED, { busy: 2 });
    const dispatcher = recordingDispatcher();

    const result = await run(dispatcher, { clock, cursor, sleep, pollIntervalMs: 250 });

    const granted = RUN_AT.getTime() + 500;
    expect(sleeps).toEqual([250, 250]);
    expect(result.theTime.getTime()).toBe(granted);
    for (const call of dispatcher.calls) {
      expect([call.runAt.getTime(), call.deadlineAt.getTime(), call.lastMonitored.getTime()]).toEqual([
        granted,
        RUN_AT.getTime() + DEADLINE_MS,
        STORED.getTime(),
      ]);
    }
    expect(cursor.writes.map((d) => d.getTime())).toEqual([granted]);
  });

  it('stops with reason deadline before any step when the lease stays busy until the queue deadline', async () => {
    const { clock, sleep, sleeps } = sleepingClock(RUN_AT);
    const cursor = fakeCursor(STORED, { busy: Number.POSITIVE_INFINITY });
    const dispatcher = recordingDispatcher();

    const err = await runError(run(dispatcher, { clock, cursor, sleep, pollIntervalMs: 250_000 }), SiteMonitorUnavailableError);

    expect([err.reason, err.step, err.siteId, err.completed, err.surface]).toEqual(['deadline', undefined, undefined, [], 'auto']);
    expect(sleeps).toEqual([250_000, 250_000, 100_000]);
    expect(dispatcher.calls).toEqual([]);
    expect([cursor.writes, cursor.granted, cursor.released]).toEqual([[], [], []]);
  });

  it('stops with reason deadline and leaves the cursor when another pass took the lease before setCursor advanced it', async () => {
    const cursor = fakeCursor(STORED);
    const dispatcher = recordingDispatcher({
      beforeAnswer: (inv) => {
        if (inv.step.step === 'setCursor') cursor.takeOver();
      },
    });

    const err = await runError(run(dispatcher, { cursor }), SiteMonitorUnavailableError);

    expect([err.reason, err.step, err.completed.at(-1)?.step]).toEqual(['deadline', 'setCursor', 'setCursor']);
    expect(cursor.writes).toEqual([]);
  });

  it.each([
    { name: 'a completed pass', failOn: undefined },
    { name: 'a failed pass', failOn: 'emailSend' as const },
  ])('releases the lease it was granted after $name', async ({ failOn }) => {
    const cursor = fakeCursor(STORED);

    await run(recordingDispatcher({ failOn, error: new Error('step failed') }), { cursor }).catch(() => undefined);

    expect(cursor.granted).toHaveLength(1);
    expect(cursor.granted[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(cursor.released).toEqual(cursor.granted);
  });

  it.each([
    { name: 'keeps the error of a failed pass', failOn: 'emailSend' as const, expected: 'step' as const },
    { name: 'rejects a completed pass', failOn: undefined, expected: 'release' as const },
  ])('a failing release $name', async ({ failOn, expected }) => {
    const errors = { step: new Error('step failed'), release: new Error('release failed') };
    const cursor = fakeCursor(STORED, { releaseError: errors.release });

    const err = await run(recordingDispatcher({ failOn, error: errors.step }), { cursor }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err instanceof SiteMonitorRunError ? err.cause : err).toBe(errors[expected]);
  });
});

describe('runSiteMonitor reminder catch-up', () => {
  // contentServer.cfc:677 compares minute-of-hour only.
  it.each([
    { name: 'minutes differ', theTime: new Date(2026, 5, 30, 12, 0, 30), stored: new Date(2026, 5, 30, 11, 59, 0), count: 2 },
    { name: 'just before the window minute', theTime: new Date(2026, 5, 30, 12, 0, 0, 0), stored: new Date(2026, 5, 30, 11, 29, 59, 999), count: 2 },
    { name: 'end of the window minute', theTime: new Date(2026, 5, 30, 12, 0, 0, 0), stored: new Date(2026, 5, 30, 11, 30, 59, 999), count: 1 },
    { name: 'same minute in another hour', theTime: new Date(2026, 5, 30, 12, 0, 20), stored: new Date(2026, 5, 30, 10, 30, 10), count: 1 },
    { name: 'same minute', theTime: new Date(2026, 5, 30, 12, 0, 45), stored: new Date(2026, 5, 30, 11, 30, 10), count: 1 },
  ])('$name: sendReminders runs $count time(s)', async ({ theTime, stored, count }) => {
    const dispatcher = recordingDispatcher();

    await run(dispatcher, { at: theTime, cursor: fakeCursor(stored) });

    const reminders = dispatcher.calls.filter((c) => c.step.step === 'sendReminders');
    const expected = count === 2 ? [theTime.getTime() - 30 * MINUTE_MS, theTime.getTime()] : [theTime.getTime()];
    expect(reminders.map((c) => c.theTime.getTime())).toEqual(expected);
    expect(dispatcher.calls.slice(0, count).map(label)).toEqual(Array.from({ length: count }, () => 'sendReminders'));
  });
});

describe('runSiteMonitor step order and gating', () => {
  it('runs every step in legacy order, interleaving bounces and feeds per site and onSiteMonitor by orderNo', async () => {
    const dispatcher = recordingDispatcher();
    const sites = fakeSites([
      site('A', { eb: true, fm: true, orderNo: 2 }),
      site('B', { fm: true, orderNo: 1 }),
      site('C', { orderNo: 3 }),
    ]);

    await run(dispatcher, { at: new Date(2026, 5, 30, 12, 0, 30), cursor: fakeCursor(new Date(2026, 5, 30, 11, 59, 0)), sites });

    expect(dispatcher.calls.map(label)).toEqual([
      'sendReminders',
      'sendReminders',
      'emailSend',
      'publishScheduledChangesets',
      'trackBounces@A',
      'feedAutoImport@A',
      'feedAutoImport@B',
      'purgeDisplayWindow',
      'clearOldCommands',
      'onGlobalMonitor',
      'onSiteMonitor@B',
      'onSiteMonitor@A',
      'onSiteMonitor@C',
      'setCursor',
    ]);
  });

  it('stamps every invocation with the run time and the queue deadline', async () => {
    const dispatcher = recordingDispatcher();

    await run(dispatcher, { sites: fakeSites([site('A', { eb: true, fm: true, orderNo: 1 })]) });

    for (const call of dispatcher.calls) {
      expect([call.runAt.getTime(), call.deadlineAt.getTime(), call.lastMonitored.getTime()]).toEqual([
        RUN_AT.getTime(),
        RUN_AT.getTime() + DEADLINE_MS,
        STORED.getTime(),
      ]);
    }
    const purge = dispatcher.calls.find((c) => c.step.step === 'purgeDisplayWindow');
    expect(purge?.theTime.getTime()).toBe(RUN_AT.getTime());
  });

  // contentServer.cfc:694 discards listAppend's result.
  it('runs trackBounces for every broadcaster site, even when two share a mail user', async () => {
    const dispatcher = recordingDispatcher();
    const sites = fakeSites([
      site('x', { eb: true, orderNo: 1, mail: 'bounce@example.com' }),
      site('y', { eb: true, orderNo: 1, mail: 'bounce@example.com' }),
      site('z', { orderNo: 1, mail: 'bounce@example.com' }),
    ]);

    await run(dispatcher, { sites });

    expect(dispatcher.calls.filter((c) => c.step.step === 'trackBounces').map(label)).toEqual(['trackBounces@x', 'trackBounces@y']);
  });

  it('runs feedAutoImport only for feed-manager sites', async () => {
    const dispatcher = recordingDispatcher();

    await run(dispatcher, { sites: fakeSites([site('on', { fm: true, orderNo: 1 }), site('off', { eb: true, orderNo: 1 })]) });

    expect(dispatcher.calls.filter((c) => c.step.step === 'feedAutoImport').map(label)).toEqual(['feedAutoImport@on']);
  });

  it('orders onSiteMonitor by orderNo with NULL first and ties by siteId, reading the sites once', async () => {
    const dispatcher = recordingDispatcher();
    let reads = 0;
    const listed = [site('m', { orderNo: 5 }), site('b', { orderNo: 5 }), site('n', { orderNo: Number.NEGATIVE_INFINITY })];
    const sites: SiteFlagsSource = {
      list: async () => {
        reads += 1;
        return listed;
      },
    };

    await run(dispatcher, { sites });

    expect(dispatcher.calls.filter((c) => c.step.step === 'onSiteMonitor').map(label)).toEqual([
      'onSiteMonitor@n',
      'onSiteMonitor@b',
      'onSiteMonitor@m',
    ]);
    expect(reads).toBe(1);
    expect(listed.map((s) => s.siteId)).toEqual(['m', 'b', 'n']);
  });
});

describe('runSiteMonitor abort', () => {
  it('stops at a failed step and leaves the cursor unchanged', async () => {
    const error = new Error('changeset publish failed');
    const cursor = fakeCursor(STORED);
    const dispatcher = recordingDispatcher({ failOn: 'publishScheduledChangesets', error });
    const sites: SiteFlagsSource = { list: () => Promise.reject(new Error('sites must not be read')) };

    const err = await runError(run(dispatcher, { cursor, sites }), SiteMonitorRunError);

    expect(err).not.toBeInstanceOf(LegacyServiceUnavailableError);
    expect([err.reason, err.step, err.siteId, err.cause]).toEqual(['step-failed', 'publishScheduledChangesets', undefined, error]);
    expect(err.completed.map(label)).toEqual(['sendReminders', 'emailSend']);
    expect(dispatcher.calls.map(label)).toEqual(['sendReminders', 'emailSend', 'publishScheduledChangesets']);
    expect(cursor.writes).toEqual([]);
  });

  it('stops with reason deadline before the next step once the queue deadline has passed', async () => {
    let now = RUN_AT.getTime();
    const cursor = fakeCursor(STORED);
    const dispatcher = recordingDispatcher({
      beforeAnswer: (inv) => {
        if (inv.step.step === 'trackBounces') now = RUN_AT.getTime() + DEADLINE_MS;
      },
    });

    const err = await runError(
      run(dispatcher, { clock: { now: () => new Date(now) }, cursor, sites: fakeSites([site('A', { eb: true, fm: true, orderNo: 1 })]) }),
      SiteMonitorUnavailableError,
    );

    expect([err.reason, err.step, err.siteId, err.cause, err.surface]).toEqual(['deadline', 'feedAutoImport', 'A', undefined, 'auto']);
    expect(err.completed.map(label)).toEqual(['sendReminders', 'emailSend', 'publishScheduledChangesets', 'trackBounces@A']);
    expect(dispatcher.calls.map(label).at(-1)).toBe('trackBounces@A');
    expect(cursor.writes).toEqual([]);
  });

  it.each([
    { name: 'a dispatcher deadline', cause: new SiteMonitorDeadlineError('emailSend'), reason: 'deadline', surface: 'auto' },
    { name: 'an unavailable service', cause: new ServiceUnavailableError('migration', new Error('connect ECONNREFUSED')), reason: 'step-failed', surface: 'auto' },
    { name: 'a legacy unavailable admin surface', cause: new LegacyServiceUnavailableError('gate closed', 'admin'), reason: 'step-failed', surface: 'admin' },
  ])('reports $name as the legacy 503 with its run context and surface', async ({ cause, reason, surface }) => {
    const err = await runError(run(recordingDispatcher({ failOn: 'emailSend', error: cause })), SiteMonitorUnavailableError);

    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect([err.reason, err.step, err.siteId, err.cause, err.surface, err.name]).toEqual([
      reason,
      'emailSend',
      undefined,
      cause,
      surface,
      'SiteMonitorUnavailableError',
    ]);
    expect(err.completed.map(label)).toEqual(['sendReminders']);
    expect(err.message).toContain('emailSend');
  });
});

const available = await pgAvailable();

/** 2026-06-30 at the given local time. */
function at(hours: number, minutes: number, seconds = 0, ms = 0): Date {
  return new Date(2026, 5, 30, hours, minutes, seconds, ms);
}

/** One `sitemonitor_state` changelog row's provenance. */
interface StateChange {
  tenant_id: string;
  op: string;
  origin: string;
  actor_service: string | null;
}

describe.skipIf(!available)('site-monitor adapters against PostgreSQL', () => {
  const clock = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
  let handle: ThrowawaySchema;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'programs-sites',
      migrationsDir: fileURLToPath(new URL('../../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    const repo = createProgramsSitesRepository({ clock, schema: handle.schema });
    // [siteid, emailbroadcaster, feedmanager, mailserverusername, orderno]; 'ghost' is registered without a site row.
    const rows: Array<[string, number | null, number | null, string | null, number | null]> = [
      ['zeta', 1, 0, 'z@example.com', 2],
      ['alpha', null, 1, null, null],
      ['ghost', 1, 1, 'g@example.com', 3],
    ];
    for (const [siteid, emailbroadcaster, feedmanager, mailserverusername, orderno] of rows) {
      const tenantId = tenantIdForSite(siteid);
      await withMetadata(handle.app, (tx) =>
        tx.query(`INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, $3)`, [
          siteid,
          tenantId,
          clock.now(),
        ]),
      );
      if (siteid === 'ghost') continue;
      await withGatedTenant(handle.app, tenantId, (tx) =>
        repo.insert(tx, SITE.table, {
          siteid,
          site: siteid,
          emailbroadcaster,
          emailbroadcasterlimit: 0,
          feedmanager,
          mailserverusername,
          orderno,
          deploy: 0,
        }),
      );
    }
  });

  afterAll(async () => {
    await handle?.drop();
  });

  /** The orchestrator's lease port with a clock fixed at `now`. */
  function store(now: Date): CursorStore {
    return defaultCursorStore(handle.app, fixedClock(now));
  }

  /** The stored lease columns. */
  function lease(): Promise<{ lease_id: string | null; lease_until: Date | null } | undefined> {
    return withTenant(handle.app, SYSTEM_TENANT_ID, async (tx) =>
      (await tx.query<{ lease_id: string | null; lease_until: Date | null }>(`SELECT lease_id, lease_until FROM ${handle.schema}.sitemonitor_state`)).rows[0],
    );
  }

  /** The changelog rows of `sitemonitor_state`, in write order. */
  function stateChanges(): Promise<StateChange[]> {
    return withTenant(handle.app, SYSTEM_TENANT_ID, async (tx) =>
      (
        await tx.query<StateChange>(
          `SELECT tenant_id, op, origin, actor_service FROM ${handle.schema}.changelog WHERE "table" = 'sitemonitor_state' ORDER BY seq`,
        )
      ).rows,
    );
  }

  it('lists registered sites that have a site row, by siteId, with CFML flags', async () => {
    expect(await registrySiteFlags(handle.app, clock).list()).toEqual([
      {
        siteId: 'alpha',
        tenantId: tenantIdForSite('alpha'),
        emailBroadcaster: false,
        feedManager: true,
        mailServerUsername: '',
        orderNo: Number.NEGATIVE_INFINITY,
      },
      { siteId: 'zeta', tenantId: tenantIdForSite('zeta'), emailBroadcaster: true, feedManager: false, mailServerUsername: 'z@example.com', orderNo: 2 },
    ]);
  });

  it('grants exactly one of two concurrent first acquirers, then frees the lease on release', async () => {
    const store = defaultCursorStore(handle.app, fixedClock(at(11, 0)));
    const [a, b] = [randomUUID(), randomUUID()];
    // Two open pool connections, so both acquirers' transactions overlap instead of one waiting for a connect.
    await Promise.all([readCursor(handle.app), readCursor(handle.app)]);

    const grants = await Promise.all([store.acquire(a, at(11, 10)), store.acquire(b, at(11, 10))]);
    const winner = grants[0]?.status === 'granted' ? a : b;

    expect(grants.map((g) => g.status).sort()).toEqual(['busy', 'granted']);
    expect(grants.find((g) => g.status === 'granted')).toEqual({ status: 'granted', lastMonitored: null });
    expect(await store.release(winner)).toBe(true);
    expect(await lease()).toEqual({ lease_id: null, lease_until: null });
    expect(await stateChanges()).toEqual([
      { tenant_id: SYSTEM_TENANT_ID, op: 'insert', origin: 'target', actor_service: OWNER },
      { tenant_id: SYSTEM_TENANT_ID, op: 'update', origin: 'target', actor_service: OWNER },
    ]);
  });

  it('round-trips the cursor through the system-tenant row', async () => {
    const stored = at(11, 59, 0, 123);

    expect(await readCursor(handle.app)).toBeNull();
    await writeCursor(handle.app, stored, clock);

    expect((await readCursor(handle.app))?.getTime()).toBe(stored.getTime());
  });

  it('writeCursor sets the cursor unconditionally, one system-tenant changelog row per write with its provenance', async () => {
    const logged = (await stateChanges()).length;
    const newer = new Date(2026, 5, 30, 11, 59, 30);
    const older = new Date(2026, 5, 30, 11, 0, 0);

    await writeCursor(handle.app, newer, clock);
    await writeCursor(handle.app, older, clock, { actorService: 'migration' });

    expect((await readCursor(handle.app))?.getTime()).toBe(older.getTime());
    expect((await stateChanges()).slice(logged)).toEqual([
      { tenant_id: SYSTEM_TENANT_ID, op: 'update', origin: 'target', actor_service: null },
      { tenant_id: SYSTEM_TENANT_ID, op: 'update', origin: 'target', actor_service: 'migration' },
    ]);
  });

  it('runs on the default adapters when no ports are injected, recording each lease and cursor write as programs-sites', async () => {
    const dispatcher = recordingDispatcher();
    const logged = (await stateChanges()).length;

    await runSiteMonitor({ db: handle.app, clock, dispatch: dispatcher });

    expect(dispatcher.calls.filter((c) => c.siteId !== undefined).map(label)).toEqual([
      'feedAutoImport@alpha',
      'trackBounces@zeta',
      'onSiteMonitor@alpha',
      'onSiteMonitor@zeta',
    ]);
    expect((await readCursor(handle.app))?.getTime()).toBe(clock.now().getTime());
    expect(await lease()).toEqual({ lease_id: null, lease_until: null });
    expect((await stateChanges()).slice(logged)).toEqual(
      Array.from({ length: 3 }, () => ({ tenant_id: SYSTEM_TENANT_ID, op: 'update', origin: 'target', actor_service: OWNER })),
    );
  });

  it('lets another holder take the lease only after it lapsed, and the old holder can then neither advance nor release', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const logged = (await stateChanges()).length;

    expect(await store(at(12, 10)).acquire(a, at(12, 11))).toEqual({ status: 'granted', lastMonitored: clock.now() });
    expect(await store(at(12, 10, 59, 999)).acquire(b, at(12, 12))).toEqual({ status: 'busy' });
    expect(await store(at(12, 11)).acquire(b, at(12, 12))).toMatchObject({ status: 'granted' });
    expect(await store(at(12, 11)).advance(a, at(12, 11))).toBe(false);
    expect(await store(at(12, 11)).release(a)).toBe(false);
    expect(await lease()).toEqual({ lease_id: b, lease_until: at(12, 12) });
    expect(await store(at(12, 11, 30)).advance(b, at(12, 11, 30))).toBe(true);
    expect(await store(at(12, 11, 30)).release(b)).toBe(true);

    expect((await readCursor(handle.app))?.getTime()).toBe(at(12, 11, 30).getTime());
    expect((await stateChanges()).slice(logged).map((c) => c.actor_service)).toEqual([OWNER, OWNER, OWNER, OWNER]);
  });

  it('never moves the cursor backwards and writes no changelog row for a stale advance', async () => {
    const holder = randomUUID();
    const before = (await readCursor(handle.app))?.getTime();
    const logged = (await stateChanges()).length;

    await store(at(12, 20)).acquire(holder, at(12, 30));
    expect(await store(at(12, 20)).advance(holder, at(12, 0))).toBe(true);
    expect((await readCursor(handle.app))?.getTime()).toBe(before);
    expect(await store(at(12, 20)).advance(holder, at(12, 20))).toBe(true);
    await store(at(12, 20)).release(holder);

    expect((await readCursor(handle.app))?.getTime()).toBe(at(12, 20).getTime());
    expect((await stateChanges()).slice(logged)).toHaveLength(3);
  });

  it('serialises two concurrent passes: the second covers the first pass end to its own run time', async () => {
    let now = at(12, 30).getTime();
    const shared: Clock = { now: () => new Date(now) };
    let reachedSetCursor!: () => void;
    let releaseSetCursor!: () => void;
    const blocked = new Promise<void>((resolve) => (reachedSetCursor = resolve));
    const gate = new Promise<void>((resolve) => (releaseSetCursor = resolve));
    const first = recordingDispatcher({
      beforeAnswer: (inv) => {
        if (inv.step.step === 'setCursor') reachedSetCursor();
      },
    });
    const slowFirst: StepDispatcher = {
      async dispatch(inv) {
        const outcome = await first.dispatch(inv);
        if (inv.step.step === 'setCursor') await gate;
        return outcome;
      },
    };
    const second = recordingDispatcher();
    const sleeps: number[] = [];

    const firstPass = runSiteMonitor({ db: handle.app, clock: shared, dispatch: slowFirst });
    await blocked;
    now = at(12, 30, 5).getTime();
    const secondPass = runSiteMonitor({
      db: handle.app,
      clock: shared,
      dispatch: second,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        releaseSetCursor();
        await firstPass;
      },
    });
    const [one, two] = await Promise.all([firstPass, secondPass]);

    expect(sleeps).toEqual([1000]);
    expect([one.theTime, two.theTime]).toEqual([at(12, 30), at(12, 30, 6)]);
    expect(new Set(second.calls.map((c) => c.lastMonitored.getTime()))).toEqual(new Set([at(12, 30).getTime()]));
    expect((await readCursor(handle.app))?.getTime()).toBe(at(12, 30, 6).getTime());
    expect(await lease()).toEqual({ lease_id: null, lease_until: null });
  });
});
