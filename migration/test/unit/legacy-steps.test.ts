// Legacy site-monitor steps through the bridge and gateway doubles: run directly while their units are legacy, inside a window once one is target.
import { afterEach, describe, expect, it } from 'vitest';

import { BridgeError, type BridgeJobName } from '../../src/legacy/index.js';
import { LEGACY_STEP_ROUTE_KEY, WindowRefusedError, type LegacyStepInput, type WindowLifecycle } from '../../src/windows/index.js';
import { LegacyStepFailedError, runLegacyStepWith } from '../../src/windows/legacy-steps.js';
import type { BridgeDouble } from '../helpers/bridge-double.js';
import { buildTestContext, type TestContext } from '../helpers/context.js';
import { FIXTURE_ROUTES, UNITS } from '../helpers/fixtures.js';
import type { CallLog } from '../helpers/gateway-double.js';

type OpenRequest = Parameters<WindowLifecycle['open']>[0];
type OpenOptions = Parameters<WindowLifecycle['open']>[1];
type CompleteRequest = Parameters<WindowLifecycle['complete']>[1];

const WINDOW_COMPONENT = 'window';
const WINDOW_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const CURSOR = { theTime: '2026-06-30 12:00:00.000', lastMonitored: '2026-06-30 11:45:00.000' } as const;

/** A window lifecycle with the calls it received. */
interface RecordingLifecycle extends WindowLifecycle {
  readonly opened: Array<{ request: OpenRequest; opts: OpenOptions }>;
  readonly completed: Array<{ windowId: string; request: CompleteRequest }>;
}

/** Records each call in `log` too; `open` answers `WINDOW_ID`, or rejects with `refusal`, and `complete` answers `closed`. */
function recordingLifecycle(log: CallLog, refusal?: Error): RecordingLifecycle {
  const opened: RecordingLifecycle['opened'] = [];
  const completed: RecordingLifecycle['completed'] = [];
  return {
    opened,
    completed,
    open(request, opts) {
      log.append(WINDOW_COMPONENT, 'open', { request, opts });
      opened.push({ request, opts });
      return refusal === undefined ? Promise.resolve({ windowId: WINDOW_ID, state: 'open', phase: 'executing' }) : Promise.reject(refusal);
    },
    complete(windowId, request) {
      log.append(WINDOW_COMPONENT, 'complete', { windowId, request });
      completed.push({ windowId, request });
      return Promise.resolve({ state: 'closed' });
    },
  };
}

/** `<component>:<op>` of every shared-log entry, in call order. */
const sequence = (log: CallLog): string[] => log.entries.map((entry) => `${entry.component}:${entry.op}`);

let current: TestContext | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** A test context whose gateway double reports `active`, with its running bridge double and a recording lifecycle. */
async function contextWith(
  active: string | null,
  refusal?: Error,
): Promise<{ t: TestContext; bridge: BridgeDouble; lifecycle: RecordingLifecycle }> {
  const t = await buildTestContext({ gateway: { active } });
  current = t;
  if (t.bridge === null) throw new Error('buildTestContext started no bridge double');
  return { t, bridge: t.bridge, lifecycle: recordingLifecycle(t.log, refusal) };
}

describe('LEGACY_STEP_ROUTE_KEY', () => {
  it('is the site-monitor job route every legacy step window opens under', () => {
    expect(LEGACY_STEP_ROUTE_KEY).toBe('sitemonitor:run');
    expect(FIXTURE_ROUTES.siteMonitor).toBe(LEGACY_STEP_ROUTE_KEY);
  });
});

describe('runLegacyStepWith without a target unit', () => {
  it.each<[string, string | null, LegacyStepInput['units']]>([
    ['its inventory units are legacy under v0001', 'v0001', undefined],
    ['no version is active', null, undefined],
    ['its only unit is legacy under v0002', 'v0002', [UNITS.mailingList]],
  ])('runs jobs.cfm once, unwindowed, with the cursor unchanged when %s', async (_case, active, units) => {
    const step: BridgeJobName = 'publishScheduledChangesets';
    const { t, bridge, lifecycle } = await contextWith(active);

    const result = await runLegacyStepWith(t.ctx, lifecycle, { step, ...CURSOR, ...(units === undefined ? {} : { units }) });

    expect(sequence(t.log)).toEqual(['gateway:status', `bridge:jobs.${step}`]);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toMatchObject({ op: `jobs.${step}`, method: 'POST', status: 200, assertion: expect.objectContaining({ op: `jobs.${step}` }) });
    expect(bridge.calls[0]?.query).toEqual({ job: step, ...CURSOR });
    expect(lifecycle.opened).toEqual([]);
    expect(lifecycle.completed).toEqual([]);
    expect(result).toEqual({ response: { step, completed: true, serverTime: t.clock.now().toISOString() } });
  });
});

describe('runLegacyStepWith with a target unit', () => {
  it.each<[string, BridgeJobName, string | undefined, LegacyStepInput['units'], string[], OpenRequest['scope']]>([
    ['scoped to its site', 'feedAutoImport', 'tenant-a', undefined, [UNITS.content], { keys: { siteid: 'tenant-a' } }],
    ['scoped to the table without a site', 'publishScheduledChangesets', undefined, undefined, [UNITS.content], { table: true }],
    ['leasing every unit when only one is target', 'emailSend', undefined, [UNITS.content, UNITS.mailingList], [UNITS.content, UNITS.mailingList], { table: true }],
  ])('opens a window, runs jobs.cfm, then completes it forwarded, %s', async (_case, step, siteId, units, leased, scope) => {
    const { t, bridge, lifecycle } = await contextWith('v0002');
    const site = siteId === undefined ? {} : { siteId };

    const result = await runLegacyStepWith(t.ctx, lifecycle, { step, ...site, ...CURSOR, ...(units === undefined ? {} : { units }) });

    expect(sequence(t.log)).toEqual(['gateway:status', 'window:open', `bridge:jobs.${step}`, 'window:complete']);
    expect(lifecycle.opened).toEqual([
      { request: { routeKey: LEGACY_STEP_ROUTE_KEY, units: leased, scope, requestId: expect.any(String) }, opts: { kind: 'sitemonitor-step' } },
    ]);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]?.query).toEqual({ job: step, ...(siteId === undefined ? {} : { siteid: siteId }), ...CURSOR });
    expect(lifecycle.completed).toEqual([{ windowId: WINDOW_ID, request: { forwarded: true } }]);
    expect(result).toEqual({
      response: { step, completed: true, serverTime: t.clock.now().toISOString(), ...(step === 'feedAutoImport' ? site : {}), windowId: WINDOW_ID },
      windowState: 'closed',
    });
  });

  it('propagates a refused window unchanged and never calls jobs.cfm', async () => {
    const refusal = new WindowRefusedError(WINDOW_ID, 'lease-unavailable', new Error('units leased by a transition'));
    const { t, bridge, lifecycle } = await contextWith('v0002', refusal);

    await expect(runLegacyStepWith(t.ctx, lifecycle, { step: 'feedAutoImport', siteId: 'tenant-a', ...CURSOR })).rejects.toBe(refusal);

    expect(sequence(t.log)).toEqual(['gateway:status', 'window:open']);
    expect(bridge.calls).toEqual([]);
    expect(bridge.jobRuns).toEqual([]);
    expect(lifecycle.completed).toEqual([]);
  });

  it.each<[string, string, number, (bridge: BridgeDouble) => void]>([
    ['answers 500', 'tenant-a', 500, (bridge) => bridge.failNext('jobs.feedAutoImport', 500, { error: 'serverError', message: 'Exception' })],
    ['answers 404 for an unregistered site', 'tenant-z', 404, () => undefined],
  ])('completes the window forwarded, then throws the step failure, when jobs.cfm %s', async (_case, siteId, status, arrange) => {
    const { t, bridge, lifecycle } = await contextWith('v0002');
    arrange(bridge);

    const error: unknown = await runLegacyStepWith(t.ctx, lifecycle, { step: 'feedAutoImport', siteId, ...CURSOR }).catch((e: unknown) => e);

    expect(sequence(t.log)).toEqual(['gateway:status', 'window:open', 'bridge:jobs.feedAutoImport', 'window:complete']);
    expect(bridge.calls[0]?.status).toBe(status);
    expect(lifecycle.completed).toEqual([{ windowId: WINDOW_ID, request: { forwarded: true } }]);
    expect(error).toBeInstanceOf(LegacyStepFailedError);
    expect(error).toMatchObject({ step: 'feedAutoImport', siteId, windowId: WINDOW_ID, reason: 'legacy-step-failed' });
    expect((error as LegacyStepFailedError).cause).toBeInstanceOf(BridgeError);
    expect((error as LegacyStepFailedError).cause).toMatchObject({ op: 'jobs.feedAutoImport', status });
  });
});
