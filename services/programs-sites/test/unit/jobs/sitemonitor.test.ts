/** Site-monitor orchestrator: cursor, catch-up, step order, per-site gating, abort and deadline; default adapters against PostgreSQL. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import { fixedClock, type Clock } from '@opt2/platform/service-kit';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  SiteMonitorRunError,
  defaultCursorStore,
  registrySiteFlags,
  runSiteMonitor,
  type CursorStore,
  type MonitoredSite,
  type SiteFlagsSource,
} from '../../../src/jobs/sitemonitor.js';
import { SiteMonitorDeadlineError, type StepDispatcher, type StepInvocation, type StepOutcome } from '../../../src/jobs/dispatch.js';
import type { SiteMonitorStepName } from '../../../src/jobs/steps.js';
import { createProgramsSitesRepository } from '../../../src/repo/repository.js';
import { SITE, UNITS } from '../../../src/repo/tables.js';

const MINUTE_MS = 60_000;
const DEADLINE_MS = 600_000;
// Every orchestrator test injects its cursor and site ports, so the database is never reached.
const NO_DB = { schema: 'programs_sites' } as unknown as TenantDb;
const STORED = new Date(2026, 5, 30, 11, 30, 10);
const RUN_AT = new Date(2026, 5, 30, 12, 0, 45);

type FakeCursor = CursorStore & { writes: Date[] };

function fakeCursor(initial: Date | null, log: string[] = []): FakeCursor {
  let value = initial;
  const writes: Date[] = [];
  return {
    writes,
    async read() {
      log.push('cursor.read');
      return value;
    },
    async write(at) {
      log.push(`cursor.write@${at.getTime()}`);
      writes.push(at);
      value = at;
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

function run(dispatch: StepDispatcher, opts: { at?: Date; cursor?: CursorStore; sites?: SiteFlagsSource; clock?: Clock } = {}) {
  return runSiteMonitor({
    db: NO_DB,
    clock: opts.clock ?? fixedClock(opts.at ?? RUN_AT),
    dispatch,
    cursor: opts.cursor ?? fakeCursor(STORED),
    sites: opts.sites ?? fakeSites([]),
  });
}

async function runError(promise: Promise<unknown>): Promise<SiteMonitorRunError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SiteMonitorRunError);
  return err as SiteMonitorRunError;
}

describe('runSiteMonitor cursor', () => {
  it('defaults a missing cursor to theTime - 1 min and stores it before the first step', async () => {
    const theTime = new Date(2026, 5, 30, 12, 0, 30);
    const log: string[] = [];
    const cursor = fakeCursor(null, log);
    const dispatcher = recordingDispatcher({ log });

    await run(dispatcher, { at: theTime, cursor });

    expect(log.slice(0, 3)).toEqual(['cursor.read', `cursor.write@${theTime.getTime() - MINUTE_MS}`, 'dispatch:sendReminders']);
    expect(new Set(dispatcher.calls.map((c) => c.lastMonitored.getTime()))).toEqual(new Set([theTime.getTime() - MINUTE_MS]));
  });

  it('moves the cursor to theTime once, after setCursor succeeded', async () => {
    const log: string[] = [];
    const cursor = fakeCursor(STORED, log);
    const dispatcher = recordingDispatcher({ log });

    const result = await run(dispatcher, { cursor });

    expect(log.slice(-2)).toEqual(['dispatch:setCursor', `cursor.write@${RUN_AT.getTime()}`]);
    expect(cursor.writes.map((d) => d.getTime())).toEqual([RUN_AT.getTime()]);
    expect(result.theTime.getTime()).toBe(RUN_AT.getTime());
    expect(result.steps.map(label)).toEqual(dispatcher.calls.map(label));
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

    const err = await runError(run(dispatcher, { cursor, sites }));

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
    );

    expect([err.reason, err.step, err.siteId, err.cause]).toEqual(['deadline', 'feedAutoImport', 'A', undefined]);
    expect(err.completed.map(label)).toEqual(['sendReminders', 'emailSend', 'publishScheduledChangesets', 'trackBounces@A']);
    expect(dispatcher.calls.map(label).at(-1)).toBe('trackBounces@A');
    expect(cursor.writes).toEqual([]);
  });

  it('reports a dispatcher deadline error as reason deadline', async () => {
    const cause = new SiteMonitorDeadlineError('emailSend');

    const err = await runError(run(recordingDispatcher({ failOn: 'emailSend', error: cause })));

    expect([err.reason, err.step, err.cause, err.name]).toEqual(['deadline', 'emailSend', cause, 'SiteMonitorRunError']);
    expect(err.message).toContain('emailSend');
  });
});

const available = await pgAvailable();

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

  it('round-trips the cursor through the system-tenant row', async () => {
    const store = defaultCursorStore(handle.app, clock);
    const at = new Date(2026, 5, 30, 11, 59, 0, 123);

    expect(await store.read()).toBeNull();
    await store.write(at);

    expect((await store.read())?.getTime()).toBe(at.getTime());
  });

  it('runs on the default adapters when no ports are injected', async () => {
    const dispatcher = recordingDispatcher();

    await runSiteMonitor({ db: handle.app, clock, dispatch: dispatcher });

    expect(dispatcher.calls.filter((c) => c.siteId !== undefined).map(label)).toEqual([
      'feedAutoImport@alpha',
      'trackBounces@zeta',
      'onSiteMonitor@alpha',
      'onSiteMonitor@zeta',
    ]);
    expect((await defaultCursorStore(handle.app, clock).read())?.getTime()).toBe(clock.now().getTime());
  });
});
