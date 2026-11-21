// Unit tests for the window-import-interrupted fault script, over a fake legacy pool, migration service, content owner and gateway status.
import { ServiceUnavailableError, UnknownServiceError, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runFeed, type FeedResult } from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import type { MigrationContext, ServiceCaller } from '../../src/context.js';
import { loadUnitCatalog } from '../../src/owners/index.js';
import type { RemoteFaults } from '../../src/faults/registry.js';
import { windowImportInterrupted, type WindowImportParams } from '../../src/faults/scripts/window-import-interrupted.js';
import type { FaultAssertion, FaultEnv, FaultRunOutput } from '../../src/faults/scripts/types.js';
import type { WriteWindow } from '../../src/windows/via-service.js';

vi.mock('../../src/apply/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apply/index.js')>()),
  runFeed: vi.fn(),
}));

const CONFIG = loadConfig();
const CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
const WINDOW_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const RESTORE_WINDOW_ID = '7B2C3D4E-5F60-4172-8394A51627384950';
const CONTENT_ID = '00000000000000000000000000000000001';
const CONTENT_HIST_ID = 'C0FFEE00-1111-2222-3333444455556666';
const OLD_CREDITS = 'Masa';
const NEW_CREDITS = `opt2-fault-${WINDOW_ID}`;
// The only unit of tcontent; target-authoritative in the committed v0002, whose public content read still routes to legacy.
const CONTENT_UNIT = 'content.content';
const CONTENT_OWNER = 'strategies-content';
// Target-authoritative in the committed v0002 and no unit of tcontent.
const TARGET_UNIT = 'reporting.export_job';
// No carry write entry writes it, so legacy-authoritative in every committed version.
const COMMITTED_LEGACY_UNIT = 'content.display_title_approval';
const DEFAULTS = windowImportInterrupted.paramsSchema.parse({});
const CONTENT_READ_PATH = `/_api/json/v1/tenant-a/content/${CONTENT_ID}`;

type Answer = Pick<ServiceResponse, 'status' | 'body'>;

/** Answers for the restoring window, which `resume` opens after clearing the fault. */
interface RestoreScript {
  open: Answer;
  complete: Answer;
  /** Answers of successive `windowGet` calls on the restoring window; the last repeats. */
  windows: Partial<WriteWindow>[];
  rowsAffected: number;
  updateError?: Error;
}

/** Per-test answers of the fakes. */
interface Script {
  tableVersion: string | null;
  rows: { ContentHistID: string; ContentID: string; Credits: string | null }[];
  rowsAffected: number;
  open: Answer;
  complete: Answer;
  /** Answers of successive `windowGet` calls; the last repeats. */
  windows: Partial<WriteWindow>[];
  /** Answer of each content read at the content owner. */
  read: () => Promise<Answer>;
  clearError?: Error;
  feed?: Partial<FeedResult>;
  restore: RestoreScript;
}

type ScriptOverrides = Partial<Omit<Script, 'restore'>> & { restore?: Partial<RestoreScript> };

interface Harness {
  env: FaultEnv;
  events: string[];
  /** Calls to the migration service. */
  requests: ServiceRequest[];
  /** Calls to any other service: the content reads. */
  reads: ServiceRequest[];
  inputs: Record<string, unknown>[];
  remote: { set: ReturnType<typeof vi.fn<RemoteFaults['set']>>; clear: ReturnType<typeof vi.fn<RemoteFaults['clear']>> };
  sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
}

function windowRecord(overrides: Partial<WriteWindow>): WriteWindow {
  return {
    windowId: WINDOW_ID,
    routeKey: 'fault:window-import-interrupted',
    units: [CONTENT_UNIT],
    scope: { keys: { siteid: 'tenant-a', contentid: CONTENT_ID } },
    state: 'import-pending',
    phase: 'import-pending',
    phases: [{ phase: 'executing', at: '2026-06-30T10:00:00.000Z' }],
    rowsImported: 0,
    outcome: 'pending',
    ...overrides,
  };
}

const answer = (status: number, body: unknown): Promise<Answer> => Promise.resolve({ status, body });

const envelope = (credits: string | null): Promise<Answer> => answer(200, { apiversion: 'v1', method: 'findOne', params: {}, data: { contentid: CONTENT_ID, credits } });

/** The service client's error for a content read the owner never answered within its timeout. */
const timedOut = (): Promise<Answer> => Promise.reject(new ServiceUnavailableError(CONTENT_OWNER, new DOMException('The operation was aborted due to timeout', 'TimeoutError')));

/** The service client's error for a refused connection to the content owner. */
const refused = (): Promise<Answer> =>
  Promise.reject(new ServiceUnavailableError(CONTENT_OWNER, Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:20014'), { code: 'ECONNREFUSED' })));

function baseScript({ restore, ...overrides }: ScriptOverrides = {}): Script {
  return {
    tableVersion: 'v0002',
    rows: [{ ContentHistID: CONTENT_HIST_ID, ContentID: CONTENT_ID, Credits: OLD_CREDITS }],
    rowsAffected: 1,
    open: { status: 201, body: { windowId: WINDOW_ID, state: 'open', phase: 'executing' } },
    complete: { status: 200, body: { state: 'import-pending' } },
    windows: [{}],
    read: () => answer(503, { error: { type: 'serviceUnavailable' } }),
    ...overrides,
    restore: {
      open: { status: 201, body: { windowId: RESTORE_WINDOW_ID, state: 'open', phase: 'executing' } },
      complete: { status: 200, body: { state: 'closed' } },
      windows: [{ state: 'closed', outcome: 'imported' }],
      rowsAffected: 1,
      ...restore,
    },
  };
}

function harness(script: Script): Harness {
  const events: string[] = [];
  const requests: ServiceRequest[] = [];
  const reads: ServiceRequest[] = [];
  const inputs: Record<string, unknown>[] = [];
  const windows = [...script.windows];
  const restoreWindows = [...script.restore.windows];
  let now = Date.parse('2026-06-30T10:00:00.000Z');
  // Resume clears the fault before it opens the restoring window, so later opens and updates are the restore's.
  const restoring = (): boolean => events.includes('clear');
  const next = (answers: Partial<WriteWindow>[]): Partial<WriteWindow> => (answers.length > 1 ? answers.shift() : answers[0]) ?? {};

  const request = () => {
    const bound: Record<string, unknown> = {};
    const chain = {
      input(name: string, _type: unknown, value: unknown) {
        bound[name] = value;
        return chain;
      },
      query(text: string) {
        inputs.push(bound);
        if (text.startsWith('SELECT')) {
          events.push('select');
          return Promise.resolve({ recordset: script.rows, rowsAffected: [script.rows.length] });
        }
        if (restoring()) {
          events.push('restore:update');
          const { updateError, rowsAffected } = script.restore;
          return updateError === undefined ? Promise.resolve({ recordset: [], rowsAffected: [rowsAffected] }) : Promise.reject(updateError);
        }
        events.push('update');
        return Promise.resolve({ recordset: [], rowsAffected: [script.rowsAffected] });
      },
    };
    return chain;
  };

  const client: ServiceClient = {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      if (req.service !== 'migration') {
        reads.push(req);
        events.push('read');
        return { headers: {}, ...(await script.read()) } as ServiceResponse<T>;
      }
      requests.push(req);
      const restoreWindow = req.path.includes(RESTORE_WINDOW_ID);
      let reply: Answer;
      if (req.method === 'GET' && restoreWindow) {
        events.push('restore:get');
        reply = { status: 200, body: windowRecord({ windowId: RESTORE_WINDOW_ID, ...next(restoreWindows) }) };
      } else if (req.method === 'GET') {
        events.push('get');
        reply = { status: 200, body: windowRecord(next(windows)) };
      } else if (req.path.endsWith(':complete')) {
        events.push(restoreWindow ? 'restore:complete' : 'complete');
        reply = restoreWindow ? script.restore.complete : script.complete;
      } else {
        const restore = restoring();
        events.push(restore ? 'restore:open' : 'open');
        reply = restore ? script.restore.open : script.open;
      }
      return { headers: {}, ...reply } as ServiceResponse<T>;
    },
    close: () => Promise.resolve(),
  };

  const ctx = {
    config: CONFIG,
    catalog: CATALOG,
    legacy: { live: () => Promise.resolve({ request }) },
    gateway: { status: () => Promise.resolve({ tableVersion: script.tableVersion, epoch: 1 }) },
    clientAs: (caller: ServiceCaller) => {
      if (caller !== 'operator') throw new Error(`clientAs(${caller}) was called`);
      return client;
    },
  } as unknown as MigrationContext;

  const remote = {
    set: vi.fn<RemoteFaults['set']>(() => {
      events.push('arm');
      return Promise.resolve();
    }),
    clear: vi.fn<RemoteFaults['clear']>(() => {
      events.push('clear');
      return script.clearError === undefined ? Promise.resolve() : Promise.reject(script.clearError);
    }),
  };
  const sleep = vi.fn((ms: number) => {
    now += ms;
    return Promise.resolve();
  });
  vi.mocked(runFeed).mockImplementation(() => {
    events.push('feed');
    return Promise.resolve({
      snapshotSeq: 7,
      tableVersion: script.tableVersion,
      exitCode: 0,
      reconciliation: { point: 'after-feed-7', result: 'zero-difference', reportPath: '/reports/after-feed-7.json' },
      ...script.feed,
    } as FeedResult);
  });

  const env = { ctx, remote, sleep, clock: { now: () => new Date(now) }, logger: ctx.logger } as unknown as FaultEnv;
  return { env, events, requests, reads, inputs, remote, sleep };
}

const params = (overrides: Partial<WindowImportParams> = {}): WindowImportParams => ({ ...DEFAULTS, ...overrides });
const BOTH_UNITS = params({ units: [CONTENT_UNIT, TARGET_UNIT] });
/** The one content read each check sends: anonymous, to the owner of content.content, selecting `credits`, bounded by the read timeout. */
const OWNER_READ = { service: CONTENT_OWNER, method: 'GET', path: CONTENT_READ_PATH, query: { fields: 'credits' }, userToken: null, timeoutMs: DEFAULTS.readTimeoutMs };
/** Events of a restoring window that closes at once. */
const RESTORE_EVENTS = ['restore:open', 'restore:update', 'restore:complete', 'restore:get'];

beforeEach(() => {
  vi.mocked(runFeed).mockReset();
});

describe('window-import-interrupted parameters', () => {
  it('is the config fault window-import-interrupted and reconciles', () => {
    expect(windowImportInterrupted.name).toBe('window-import-interrupted');
    expect(windowImportInterrupted.reconciles).toBe(true);
    expect(CONFIG.faults.map((fault) => fault.name)).toContain(windowImportInterrupted.name);
  });

  it('applies the defaults', () => {
    expect(DEFAULTS).toStrictEqual({ siteId: 'tenant-a', readTimeoutMs: 35_000, closeTimeoutMs: 60_000 });
  });

  it.each([{ siteId: '' }, { units: [] }, { readTimeoutMs: 0 }, { closeTimeoutMs: 1.5 }, { windowId: WINDOW_ID }])('rejects %j', (input) => {
    expect(windowImportInterrupted.paramsSchema.safeParse(input).success).toBe(false);
  });
});

describe('window-import-interrupted run', () => {
  it('writes the row only between the window open and its complete, scoped to the site and content, then reads the content at its owner', async () => {
    const h = harness(baseScript());
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(h.events).toStrictEqual(['select', 'open', 'arm', 'update', 'complete', 'get', 'read']);
    expect(h.inputs).toStrictEqual([{ siteId: 'tenant-a' }, { credits: NEW_CREDITS, contentHistId: CONTENT_HIST_ID }]);
    expect(h.requests[0]).toMatchObject({
      service: 'migration',
      method: 'POST',
      path: '/internal/v1/windows',
      userToken: null,
      json: { routeKey: 'fault:window-import-interrupted', units: [CONTENT_UNIT, TARGET_UNIT], scope: { keys: { siteid: 'tenant-a', contentid: CONTENT_ID } } },
    });
    expect(h.requests[1]).toMatchObject({ path: `/internal/v1/windows/${WINDOW_ID}:complete`, json: { forwarded: true } });
    expect(h.requests[2]).toMatchObject({ method: 'GET', path: `/internal/v1/windows/${WINDOW_ID}`, userToken: null });
    expect(h.remote.set).toHaveBeenCalledExactlyOnceWith('window-import-interrupted', { windowId: WINDOW_ID });
    expect(h.reads).toStrictEqual([OWNER_READ]);
    expect(output.assertions.map(({ name, status }) => [name, status])).toStrictEqual([
      ['window-import-pending', 'pass'],
      ['read-not-superseded', 'pass'],
    ]);
    expect(output.details).toMatchObject({
      siteId: 'tenant-a',
      contentId: CONTENT_ID,
      contentHistId: CONTENT_HIST_ID,
      windowId: WINDOW_ID,
      oldCredits: OLD_CREDITS,
      newCredits: NEW_CREDITS,
      units: [CONTENT_UNIT, TARGET_UNIT],
      targetUnits: [CONTENT_UNIT, TARGET_UNIT],
      tableVersion: 'v0002',
      readOwner: CONTENT_OWNER,
    });
    expect(output.state).toStrictEqual({
      windowId: WINDOW_ID,
      completed: true,
      written: true,
      siteId: 'tenant-a',
      contentId: CONTENT_ID,
      contentHistId: CONTENT_HIST_ID,
      oldCredits: OLD_CREDITS,
      newCredits: NEW_CREDITS,
      units: [CONTENT_UNIT, TARGET_UNIT],
    });
  });

  it('defaults the window to the units of tcontent and skips both checks when none is target-authoritative', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', complete: { status: 200, body: { state: 'closed' } } }));
    const output = await windowImportInterrupted.run(h.env, params());

    expect(h.events).toStrictEqual(['select', 'open', 'arm', 'update', 'complete']);
    expect(h.requests[0]?.json).toMatchObject({ units: [CONTENT_UNIT] });
    expect(output.assertions).toStrictEqual([
      {
        name: 'window-import-pending',
        status: 'skipped',
        reason: 'the import-pending check cannot run under v0001: no unit of the window is target-authoritative, so the window closes no gates and imports nothing',
      },
      {
        name: 'read-not-superseded',
        status: 'skipped',
        reason: 'the protected-read check cannot run under v0001: no unit of the window is target-authoritative, so reads route to legacy',
      },
    ]);
    expect(output.state).toMatchObject({ completed: true, written: true, units: [CONTENT_UNIT] });
  });

  it('checks the pending window but skips both reads when no target-authoritative unit of the window holds tcontent', async () => {
    const h = harness(baseScript({ windows: [{}, { state: 'closed' }] }));
    const run = await windowImportInterrupted.run(h.env, params({ units: [TARGET_UNIT] }));
    const resumed = await windowImportInterrupted.resume(h.env, params(), run);

    const reason = 'no target-authoritative unit of the window holds tcontent under v0002';
    expect(h.reads).toStrictEqual([]);
    expect(run.details).toMatchObject({ targetUnits: [TARGET_UNIT], tableVersion: 'v0002' });
    expect(run.assertions).toStrictEqual([
      expect.objectContaining({ name: 'window-import-pending', status: 'pass' }),
      { name: 'read-not-superseded', status: 'skipped', reason },
    ]);
    expect(resumed.steps).toStrictEqual(['clear-fault', 'await-closed', 'restore-row']);
    expect(resumed.assertions).toMatchObject([
      { name: 'fault-cleared', status: 'pass' },
      { name: 'retry-closed', status: 'pass' },
      { name: 'target-read-current', status: 'skipped', reason },
      { name: 'row-restored', status: 'skipped', reason: `the restored value's propagation was not checked: ${reason}` },
    ]);
  });

  it('runs every check of the default tcontent window under v0002, then restores the row and reads it back at the owner', async () => {
    const read = vi
      .fn<() => Promise<Answer>>()
      .mockReturnValueOnce(answer(503, {}))
      .mockReturnValueOnce(envelope(NEW_CREDITS))
      .mockReturnValueOnce(envelope(OLD_CREDITS));
    const h = harness(baseScript({ windows: [{}, { state: 'closed', outcome: 'imported' }], read }));
    const run = await windowImportInterrupted.run(h.env, params());
    const resumed = await windowImportInterrupted.resume(h.env, params(), run);

    expect(h.events).toStrictEqual(['select', 'open', 'arm', 'update', 'complete', 'get', 'read', 'clear', 'get', 'read', ...RESTORE_EVENTS, 'read']);
    expect(h.inputs).toStrictEqual([
      { siteId: 'tenant-a' },
      { credits: NEW_CREDITS, contentHistId: CONTENT_HIST_ID },
      { credits: OLD_CREDITS, contentHistId: CONTENT_HIST_ID },
    ]);
    const restoreRequests = h.requests.filter((req) => req.method === 'POST').slice(2);
    expect(restoreRequests).toMatchObject([
      { path: '/internal/v1/windows', json: { routeKey: 'fault:window-import-interrupted', units: [CONTENT_UNIT], scope: { keys: { siteid: 'tenant-a', contentid: CONTENT_ID } } } },
      { path: `/internal/v1/windows/${RESTORE_WINDOW_ID}:complete`, json: { forwarded: true } },
    ]);
    expect(h.remote.set).toHaveBeenCalledOnce();
    expect(h.reads).toStrictEqual([OWNER_READ, OWNER_READ, OWNER_READ]);
    expect(runFeed).not.toHaveBeenCalled();
    expect(resumed.steps).toStrictEqual(['clear-fault', 'await-closed', 'reread-target', 'restore-row', 'reread-target']);
    expect([...run.assertions, ...resumed.assertions].map(({ name, status }) => [name, status])).toStrictEqual([
      ['window-import-pending', 'pass'],
      ['read-not-superseded', 'pass'],
      ['fault-cleared', 'pass'],
      ['retry-closed', 'pass'],
      ['target-read-current', 'pass'],
      ['row-restored', 'pass'],
    ]);
    expect(resumed.assertions[2]).toMatchObject({ detail: { owner: CONTENT_OWNER, status: 200, credits: NEW_CREDITS, expected: NEW_CREDITS } });
    expect(resumed.assertions[3]).toMatchObject({
      detail: {
        contentHistId: CONTENT_HIST_ID,
        credits: OLD_CREDITS,
        windowId: RESTORE_WINDOW_ID,
        rowsAffected: 1,
        completion: { state: 'closed' },
        closed: { elapsedMs: 0, window: { windowId: RESTORE_WINDOW_ID, state: 'closed' } },
        checks: [{ name: 'target-read-current', status: 'pass', detail: { owner: CONTENT_OWNER, status: 200, credits: OLD_CREDITS, expected: OLD_CREDITS } }],
      },
    });
  });

  it('fails when the window is not import-pending after the complete', async () => {
    const h = harness(baseScript({ windows: [{ state: 'closed', outcome: 'imported' }] }));
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(output.assertions[0]).toMatchObject({ name: 'window-import-pending', status: 'fail', reason: `window ${WINDOW_ID} is closed, not import-pending` });
  });

  const headersTimedOut = (): Promise<Answer> =>
    Promise.reject(new ServiceUnavailableError(CONTENT_OWNER, Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' })));
  it.each<[string, () => Promise<Answer>, 'pass' | 'fail', string | undefined, Record<string, unknown>]>([
    ['a legacy 503', () => answer(503, {}), 'pass', undefined, { status: 503 }],
    ['an outlasted wait', timedOut, 'pass', undefined, { read: 'waited', timeoutMs: DEFAULTS.readTimeoutMs }],
    ['an outlasted wait for the headers', headersTimedOut, 'pass', undefined, { read: 'waited', timeoutMs: DEFAULTS.readTimeoutMs }],
    ['the committed value', () => envelope(NEW_CREDITS), 'fail', 'the content owner answered the read instead of waiting or answering 503', { status: 200, credits: NEW_CREDITS }],
    ['the superseded value', () => envelope(OLD_CREDITS), 'fail', 'the superseded value was served', { status: 200, credits: OLD_CREDITS, oldCredits: OLD_CREDITS }],
    ['an unexpected value', () => envelope('other'), 'fail', 'a value legacy never committed was served', { status: 200, credits: 'other' }],
    ['a body that is not JSON', () => answer(200, '<html></html>'), 'fail', 'a value legacy never committed was served', { status: 200, credits: null }],
    ['a 404', () => answer(404, {}), 'fail', 'the content owner answered HTTP 404', { status: 404 }],
    [
      'a refused connection',
      refused,
      'fail',
      'the content read at strategies-content failed',
      { owner: CONTENT_OWNER, error: 'Service strategies-content unavailable (ECONNREFUSED)' },
    ],
    [
      'an owner without a URL',
      () => Promise.reject(new UnknownServiceError(CONTENT_OWNER)),
      'fail',
      'the content read at strategies-content failed',
      { error: 'No URL is configured for service strategies-content' },
    ],
  ])('judges a read at the content owner answered with %s', async (_label, read, status, reason, detail) => {
    const h = harness(baseScript({ read }));
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(h.reads).toStrictEqual([OWNER_READ]);
    const assertion = output.assertions.find((entry) => entry.name === 'read-not-superseded');
    expect(assertion).toMatchObject({ status, detail, ...(reason === undefined ? {} : { reason }) });
  });

  it('treats a null credits column served as an empty string as superseded', async () => {
    const h = harness(baseScript({ rows: [{ ContentHistID: CONTENT_HIST_ID, ContentID: CONTENT_ID, Credits: null }], read: () => envelope('') }));
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(output.assertions[1]).toMatchObject({ status: 'fail', detail: { credits: '', oldCredits: null }, reason: 'the superseded value was served' });
  });

  it('fails without opening a window when the site has no active approved page', async () => {
    const h = harness(baseScript({ rows: [] }));
    const output = await windowImportInterrupted.run(h.env, params());

    expect(h.events).toStrictEqual(['select']);
    expect(output.assertions).toStrictEqual([
      { name: 'window-import-pending', status: 'fail', detail: { siteId: 'tenant-a' }, reason: 'no active approved Page in tcontent for the site' },
    ]);
    expect(output.state).toBeUndefined();
  });

  it('fails without writing when the service refuses the window', async () => {
    const h = harness(baseScript({ open: { status: 503, body: { error: { message: 'lease-unavailable' } } } }));
    const output = await windowImportInterrupted.run(h.env, params());

    expect(h.events).toStrictEqual(['select', 'open']);
    expect(output.assertions[0]).toMatchObject({ status: 'fail', reason: 'the migration service refused the write window' });
    expect(output.state).toBeUndefined();
  });

  it('leaves the window to resume when the update changes no row', async () => {
    const h = harness(baseScript({ rowsAffected: 0 }));
    const output = await windowImportInterrupted.run(h.env, params());

    expect(h.events).toStrictEqual(['select', 'open', 'arm', 'update']);
    expect(output.assertions[0]).toMatchObject({ status: 'fail', detail: { rowsAffected: 0 }, reason: 'the in-window legacy UPDATE did not change exactly one row' });
    expect(output.state).toMatchObject({ completed: false, written: false });
  });

  it('leaves the window to resume when arming the fault fails', async () => {
    const h = harness(baseScript());
    h.remote.set.mockRejectedValueOnce(new Error('faultSet answered HTTP 400'));
    const output = await windowImportInterrupted.run(h.env, params());

    expect(h.events).toStrictEqual(['select', 'open']);
    expect(output.assertions[0]).toMatchObject({ status: 'fail', detail: { error: 'faultSet answered HTTP 400' } });
    expect(output.state).toMatchObject({ completed: false, written: false });
  });

  it('records a failed complete and leaves it for resume to repeat', async () => {
    const h = harness(baseScript({ complete: { status: 500, body: { error: { message: 'boom' } } } }));
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(output.details).toMatchObject({ completeError: 'Migration windowComplete answered HTTP 500: boom' });
    expect(output.state).toMatchObject({ completed: false, written: true });
    expect(output.assertions[0]).toMatchObject({ name: 'window-import-pending', status: 'pass' });
  });
});

describe('window-import-interrupted resume', () => {
  /** The state `run` hands resume for a window it completed after writing the row. */
  const runOutput = (state: Record<string, unknown> = {}): FaultRunOutput => ({
    assertions: [],
    state: {
      windowId: WINDOW_ID,
      completed: true,
      written: true,
      siteId: 'tenant-a',
      contentId: CONTENT_ID,
      contentHistId: CONTENT_HIST_ID,
      oldCredits: OLD_CREDITS,
      newCredits: NEW_CREDITS,
      units: [CONTENT_UNIT],
      ...state,
    },
  });

  it('clears the fault, polls until the retry closes the window, feeds the legacy-authoritative units, then restores the row through the feed', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{}, {}, { state: 'closed', outcome: 'imported' }] }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput());

    expect(h.events).toStrictEqual(['clear', 'get', 'get', 'get', 'feed', ...RESTORE_EVENTS, 'feed']);
    expect(h.inputs).toStrictEqual([{ credits: OLD_CREDITS, contentHistId: CONTENT_HIST_ID }]);
    expect(runFeed).toHaveBeenCalledTimes(2);
    expect(h.reads).toStrictEqual([]);
    expect(h.sleep.mock.calls).toStrictEqual([[1000], [1000]]);
    expect(h.remote.clear).toHaveBeenCalledExactlyOnceWith('window-import-interrupted');
    expect(h.remote.set).not.toHaveBeenCalled();
    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'rerun-feed', 'restore-row', 'rerun-feed']);
    expect(output.assertions).toMatchObject([
      { name: 'fault-cleared', status: 'pass' },
      { name: 'retry-closed', status: 'pass', detail: { elapsedMs: 2000, window: { state: 'closed' } } },
      { name: 'feed-propagated', status: 'pass', detail: { exitCode: 0, snapshotSeq: 7 } },
      { name: 'row-restored', status: 'pass', detail: { windowId: RESTORE_WINDOW_ID, rowsAffected: 1, checks: [{ name: 'feed-propagated', status: 'pass' }] } },
    ]);
    expect(output.details).toBeUndefined();
  });

  it('fails retry-closed when the window stays import-pending past the timeout', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001' }));
    const output = await windowImportInterrupted.resume(h.env, params({ closeTimeoutMs: 3000 }), runOutput());

    expect(h.sleep).toHaveBeenCalledTimes(3);
    expect(output.assertions[1]).toMatchObject({
      name: 'retry-closed',
      status: 'fail',
      detail: { elapsedMs: 3000, window: { state: 'import-pending' } },
      reason: `window ${WINDOW_ID} did not close within 3000 ms`,
    });
  });

  it('stops polling an aborted window', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{ state: 'aborted', outcome: 'aborted' }] }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput());

    expect(h.sleep).not.toHaveBeenCalled();
    expect(output.assertions[1]).toMatchObject({ name: 'retry-closed', status: 'fail', detail: { elapsedMs: 0 } });
  });

  it('fails feed-propagated on a non-zero feed exit', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{ state: 'closed' }], feed: { exitCode: 1 } }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput());

    expect(output.assertions[2]).toMatchObject({ name: 'feed-propagated', status: 'fail', reason: 'the forward feed ended with exit code 1' });
  });

  it('records a feed that throws as a failed assertion', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{ state: 'closed' }] }));
    vi.mocked(runFeed).mockRejectedValueOnce(new Error('snapshot failed'));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput());

    expect(output.assertions[2]).toMatchObject({ name: 'feed-propagated', status: 'fail', detail: { error: 'snapshot failed' } });
  });

  const STALE = 'the target does not serve the value legacy committed inside the window';
  it.each<[string, () => Promise<Answer>, 'pass' | 'fail', string | undefined, Record<string, unknown>]>([
    ['the committed value', () => envelope(NEW_CREDITS), 'pass', undefined, { owner: CONTENT_OWNER, status: 200, credits: NEW_CREDITS }],
    ['the superseded value', () => envelope(OLD_CREDITS), 'fail', STALE, { status: 200, credits: OLD_CREDITS }],
    ['a null credits column', () => envelope(null), 'fail', STALE, { status: 200, credits: null }],
    ['a 503', () => answer(503, {}), 'fail', STALE, { status: 503, credits: null }],
    ['an outlasted wait', timedOut, 'fail', STALE, { owner: CONTENT_OWNER, read: 'waited', timeoutMs: DEFAULTS.readTimeoutMs }],
    ['a refused connection', refused, 'fail', 'the content read at strategies-content failed', { owner: CONTENT_OWNER, error: 'Service strategies-content unavailable (ECONNREFUSED)' }],
  ])('re-reads the content at the owner of its target-authoritative unit and judges %s', async (_label, read, status, reason, detail) => {
    const reads = vi.fn<() => Promise<Answer>>().mockImplementationOnce(read).mockImplementation(() => envelope(OLD_CREDITS));
    const h = harness(baseScript({ windows: [{ state: 'closed' }], read: reads }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ units: [CONTENT_UNIT] }));

    expect(runFeed).not.toHaveBeenCalled();
    expect(h.reads).toStrictEqual([OWNER_READ, OWNER_READ]);
    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'reread-target', 'restore-row', 'reread-target']);
    expect(output.assertions[2]).toMatchObject({ name: 'target-read-current', status, detail, ...(reason === undefined ? {} : { reason }) });
    expect(output.assertions[3]).toMatchObject({ name: 'row-restored', status: 'pass' });
  });

  it('feeds and re-reads a window over units of both authorities, then restores the row through both', async () => {
    const read = vi.fn<() => Promise<Answer>>().mockReturnValueOnce(envelope(NEW_CREDITS)).mockReturnValueOnce(envelope(OLD_CREDITS));
    const h = harness(baseScript({ windows: [{ state: 'closed' }], read }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ units: [CONTENT_UNIT, COMMITTED_LEGACY_UNIT] }));

    expect(h.events).toStrictEqual(['clear', 'get', 'feed', 'read', ...RESTORE_EVENTS, 'feed', 'read']);
    expect(h.requests.find((req) => req.path === '/internal/v1/windows')?.json).toMatchObject({ units: [CONTENT_UNIT, COMMITTED_LEGACY_UNIT] });
    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'rerun-feed', 'reread-target', 'restore-row', 'rerun-feed', 'reread-target']);
    expect(output.assertions.map(({ name, status }) => [name, status])).toStrictEqual([
      ['fault-cleared', 'pass'],
      ['retry-closed', 'pass'],
      ['feed-propagated', 'pass'],
      ['target-read-current', 'pass'],
      ['row-restored', 'pass'],
    ]);
    expect(output.assertions[4]).toMatchObject({ detail: { checks: [{ name: 'feed-propagated', status: 'pass' }, { name: 'target-read-current', status: 'pass' }] } });
  });

  const RESTORED_NOT_SERVED = 'the restored value did not propagate: the target does not serve the value legacy committed inside the window';
  it.each<[string, Partial<RestoreScript>, () => Promise<Answer>, string, string[], boolean | undefined, Record<string, unknown>]>([
    [
      'the service refuses the restoring window',
      { open: { status: 503, body: {} } },
      () => envelope(OLD_CREDITS),
      'the migration service refused the restoring write window',
      ['restore:open'],
      undefined,
      { error: 'Service migration unavailable (HTTP_503)' },
    ],
    [
      'the restoring UPDATE throws',
      { updateError: new Error('Transaction was deadlocked') },
      () => envelope(OLD_CREDITS),
      'the restoring legacy UPDATE failed',
      RESTORE_EVENTS,
      false,
      { windowId: RESTORE_WINDOW_ID, updateError: 'Transaction was deadlocked', rowsAffected: 0 },
    ],
    [
      'the restoring UPDATE changes no row',
      { rowsAffected: 0 },
      () => envelope(OLD_CREDITS),
      'the restoring legacy UPDATE did not change exactly one row',
      RESTORE_EVENTS,
      false,
      { rowsAffected: 0, closed: { window: { state: 'closed' } } },
    ],
    [
      'the restoring window does not close',
      { complete: { status: 500, body: { error: { message: 'boom' } } }, windows: [{ state: 'open', phase: 'executing' }] },
      () => envelope(OLD_CREDITS),
      `window ${RESTORE_WINDOW_ID} did not close within 3000 ms`,
      [...RESTORE_EVENTS, 'restore:get', 'restore:get', 'restore:get'],
      true,
      { completeError: 'Migration windowComplete answered HTTP 500: boom', closed: { elapsedMs: 3000, window: { state: 'open' } } },
    ],
    [
      'the restoring window is aborted',
      { windows: [{ state: 'aborted', outcome: 'aborted' }] },
      () => envelope(OLD_CREDITS),
      `window ${RESTORE_WINDOW_ID} did not close within 3000 ms`,
      RESTORE_EVENTS,
      true,
      { closed: { elapsedMs: 0, window: { state: 'aborted' } } },
    ],
    [
      'the owner still serves the fault value',
      {},
      () => envelope(NEW_CREDITS),
      RESTORED_NOT_SERVED,
      [...RESTORE_EVENTS, 'read'],
      true,
      { checks: [expect.objectContaining({ name: 'target-read-current', status: 'fail', detail: { owner: CONTENT_OWNER, status: 200, credits: NEW_CREDITS, expected: OLD_CREDITS } })] },
    ],
    [
      'the owner answers 200 without credits',
      {},
      () => answer(200, { data: { contentid: CONTENT_ID } }),
      RESTORED_NOT_SERVED,
      [...RESTORE_EVENTS, 'read'],
      true,
      { checks: [expect.objectContaining({ name: 'target-read-current', status: 'fail', detail: { owner: CONTENT_OWNER, status: 200, credits: null, expected: OLD_CREDITS } })] },
    ],
  ])('fails row-restored without throwing when %s', async (_label, restore, restoreRead, reason, restoreEvents, forwarded, detail) => {
    const read = vi.fn<() => Promise<Answer>>().mockReturnValueOnce(envelope(NEW_CREDITS)).mockImplementation(restoreRead);
    const h = harness(baseScript({ windows: [{ state: 'closed' }], read, restore }));
    const output = await windowImportInterrupted.resume(h.env, params({ closeTimeoutMs: 3000 }), runOutput());

    expect(h.events).toStrictEqual(['clear', 'get', 'read', ...restoreEvents]);
    const completed = h.requests.find((req) => req.path === `/internal/v1/windows/${RESTORE_WINDOW_ID}:complete`);
    expect(completed?.json).toStrictEqual(forwarded === undefined ? undefined : { forwarded });
    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'reread-target', 'restore-row', ...(restoreEvents.includes('read') ? ['reread-target'] : [])]);
    expect(output.assertions.slice(0, 3).map(({ status }) => status)).toStrictEqual(['pass', 'pass', 'pass']);
    expect(output.assertions[3]).toMatchObject({ name: 'row-restored', status: 'fail', reason, detail: { contentHistId: CONTENT_HIST_ID, credits: OLD_CREDITS, ...detail } });
  });

  it('fails row-restored when the feed that carries the restored value fails under v0001', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{ state: 'closed' }] }));
    vi.mocked(runFeed)
      .mockResolvedValueOnce({ snapshotSeq: 7, tableVersion: 'v0001', exitCode: 0 } as FeedResult)
      .mockRejectedValueOnce(new Error('snapshot failed'));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput());

    expect(runFeed).toHaveBeenCalledTimes(2);
    expect(h.events).toStrictEqual(['clear', 'get', ...RESTORE_EVENTS]);
    expect(output.assertions.map(({ name, status }) => [name, status])).toStrictEqual([
      ['fault-cleared', 'pass'],
      ['retry-closed', 'pass'],
      ['feed-propagated', 'pass'],
      ['row-restored', 'fail'],
    ]);
    expect(output.assertions[3]).toMatchObject({
      reason: 'the restored value did not propagate: the forward feed failed',
      detail: { checks: [{ name: 'feed-propagated', status: 'fail', detail: { error: 'snapshot failed' } }] },
    });
  });

  it.each<[string, () => Promise<Answer>, 'pass' | 'fail']>([
    ['an empty string', () => envelope(''), 'pass'],
    ['null', () => envelope(null), 'pass'],
    ['no credits field', () => answer(200, { data: { contentid: CONTENT_ID } }), 'fail'],
  ])('restores a null credits column and judges the owner serving it as %s', async (_label, restoreRead, status) => {
    const read = vi.fn<() => Promise<Answer>>().mockReturnValueOnce(envelope(NEW_CREDITS)).mockImplementation(restoreRead);
    const h = harness(baseScript({ windows: [{ state: 'closed' }], read }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ oldCredits: null }));

    expect(h.inputs).toStrictEqual([{ credits: null, contentHistId: CONTENT_HIST_ID }]);
    expect(h.reads).toStrictEqual([OWNER_READ, OWNER_READ]);
    expect(output.assertions[3]).toMatchObject({ name: 'row-restored', status, detail: { credits: null } });
  });

  it('completes a window run left open, forwarded only when the row was written, and restores nothing when it was not', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{ state: 'closed', outcome: 'not-forwarded' }] }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ completed: false, written: false }));

    expect(h.events).toStrictEqual(['clear', 'complete', 'get']);
    expect(h.requests[0]).toMatchObject({ path: `/internal/v1/windows/${WINDOW_ID}:complete`, json: { forwarded: false } });
    expect(output.steps).toStrictEqual(['clear-fault', 'complete-window', 'await-closed']);
    expect(output.assertions.map(({ name }) => name)).toStrictEqual(['fault-cleared', 'retry-closed']);
    expect(output.details).toMatchObject({ completion: { state: 'import-pending' } });
  });

  it('repeats a failed complete with forwarded true once the row was written', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{ state: 'closed' }] }));
    await windowImportInterrupted.resume(h.env, params(), runOutput({ completed: false }));

    expect(h.requests[0]).toMatchObject({ path: `/internal/v1/windows/${WINDOW_ID}:complete`, json: { forwarded: true } });
  });

  it('fails fault-cleared on a rejected clear and records a failed complete without throwing, though the window is already closed', async () => {
    const h = harness(
      baseScript({ tableVersion: 'v0001', clearError: new Error('faultClear answered HTTP 503'), complete: { status: 400, body: {} }, windows: [{ state: 'closed' }] }),
    );
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ completed: false, written: false }));

    expect(output.details).toStrictEqual({ completeError: 'Migration windowComplete answered HTTP 400' });
    expect(output.assertions).toMatchObject([
      { name: 'fault-cleared', status: 'fail', detail: { error: 'faultClear answered HTTP 503' }, reason: 'the migration service did not confirm the fault was cleared' },
      { name: 'retry-closed', status: 'pass' },
    ]);
  });

  const CLEAR_REJECTED = new Error('faultClear answered HTTP 503');
  it.each<[string, FaultRunOutput | undefined, Error | undefined, FaultAssertion]>([
    ['run threw', undefined, undefined, { name: 'fault-cleared', status: 'pass' }],
    ['run opened no window', { assertions: [] }, undefined, { name: 'fault-cleared', status: 'pass' }],
    ['the state is malformed', { assertions: [], state: { windowId: WINDOW_ID } }, undefined, { name: 'fault-cleared', status: 'pass' }],
    [
      'run threw and the clear is rejected',
      undefined,
      CLEAR_REJECTED,
      { name: 'fault-cleared', status: 'fail', detail: { error: CLEAR_REJECTED.message }, reason: 'the migration service did not confirm the fault was cleared' },
    ],
  ])('only clears the fault when %s', async (_label, output, clearError, cleared) => {
    const h = harness(baseScript(clearError === undefined ? {} : { clearError }));
    await expect(windowImportInterrupted.resume(h.env, params(), output)).resolves.toStrictEqual({ steps: ['clear-fault'], assertions: [cleared] });
    expect(h.events).toStrictEqual(['clear']);
  });

  it('records a window read that keeps failing in the timed-out assertion', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001' }));
    const failing = h.env.ctx.clientAs('operator');
    vi.spyOn(failing, 'request').mockResolvedValue({ status: 404, headers: {}, body: { error: { message: 'No write window' } } });
    const output = await windowImportInterrupted.resume(h.env, params({ closeTimeoutMs: 1000 }), runOutput());

    expect(output.assertions[1]).toMatchObject({
      name: 'retry-closed',
      status: 'fail',
      detail: { window: null, error: 'Migration windowGet answered HTTP 404: No write window' },
    });
  });

  it('fails feed-propagated when the active version cannot be read', async () => {
    const h = harness(baseScript({ windows: [{ state: 'closed' }] }));
    vi.spyOn(h.env.ctx.gateway, 'status').mockRejectedValue(new Error('gateway unavailable'));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput());

    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'restore-row']);
    expect(output.assertions[2]).toMatchObject({ name: 'feed-propagated', status: 'fail', reason: 'the active cut-over version could not be read' });
    expect(output.assertions[3]).toMatchObject({ name: 'row-restored', status: 'fail', reason: 'the restored value did not propagate: the active cut-over version could not be read' });
  });
});
