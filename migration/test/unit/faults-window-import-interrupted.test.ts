// Unit tests for the window-import-interrupted fault script, over a fake legacy pool, migration service and gateway.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runFeed, type FeedResult } from '../../src/apply/index.js';
import { loadConfig, type ResolvedPaths } from '../../src/config.js';
import type { MigrationContext, ServiceCaller } from '../../src/context.js';
import type { CutoverVersion, GroupsFile } from '../../src/cutover/index.js';
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
const CONTENT_ID = '00000000000000000000000000000000001';
const CONTENT_HIST_ID = 'C0FFEE00-1111-2222-3333444455556666';
const OLD_CREDITS = 'Masa';
const NEW_CREDITS = `opt2-fault-${WINDOW_ID}`;
const GATEWAY_URL = 'http://gateway.test';
// content.content is legacy-authoritative in every committed version; content.variation_targeting is target-authoritative in v0002.
const CONTENT_UNIT = 'content.content';
const TARGET_UNIT = 'content.variation_targeting';
// Outside every group of the content read's units, so legacy-authoritative under both cut-over doubles.
const LEGACY_UNIT = 'people.person';
const DEFAULTS = windowImportInterrupted.paramsSchema.parse({});
const CONTENT_READ_ROUTE = 'api:content.findone';
/** Cut-over double: v0001 with the content read `target` and every group of its units target-authoritative. */
const CONTENT_TARGET_VERSION = 'v0099';
/** Cut-over double: v0001 with only the group of content.content target-authoritative, the content read still `legacy`. */
const CONTENT_UNIT_ONLY_VERSION = 'v0098';

/** Cut-over files holding the committed groups and both doubles, written once per suite. */
let contentTargetCutover: Pick<ResolvedPaths, 'cutoverDir' | 'groupsFile'>;

beforeAll(async () => {
  const cutoverDir = await mkdtemp(path.join(tmpdir(), 'opt2-window-fault-cutover-'));
  const groupsFile = path.join(cutoverDir, 'groups.json');
  await copyFile(CONFIG.paths.groupsFile, groupsFile);
  const groups = JSON.parse(await readFile(groupsFile, 'utf8')) as GroupsFile;
  const v0001 = JSON.parse(await readFile(path.join(CONFIG.paths.cutoverDir, 'versions', 'v0001.json'), 'utf8')) as CutoverVersion;
  const read = v0001.entries.find((entry) => entry.route === CONTENT_READ_ROUTE);
  if (read === undefined || !read.units.includes(CONTENT_UNIT)) throw new Error(`v0001 has no ${CONTENT_READ_ROUTE} entry reading ${CONTENT_UNIT}`);
  /** `target` for every group holding any of `units`. */
  const targetGroups = (units: readonly string[]): Record<string, 'target'> =>
    Object.fromEntries(groups.groups.filter((group) => group.units.some((unit) => units.includes(unit))).map((group) => [group.id, 'target']));
  const doubles: CutoverVersion[] = [
    { ...v0001, tableVersion: CONTENT_UNIT_ONLY_VERSION, previous: 'v0001', groupAuthority: { ...v0001.groupAuthority, ...targetGroups([CONTENT_UNIT]) } },
    {
      ...v0001,
      tableVersion: CONTENT_TARGET_VERSION,
      previous: 'v0001',
      groupAuthority: { ...v0001.groupAuthority, ...targetGroups(read.units) },
      entries: v0001.entries.map((entry) => (entry === read ? { ...entry, state: 'target' } : entry)),
    },
  ];
  await mkdir(path.join(cutoverDir, 'versions'));
  for (const version of doubles) await writeFile(path.join(cutoverDir, 'versions', `${version.tableVersion}.json`), JSON.stringify(version));
  contentTargetCutover = { cutoverDir, groupsFile };
});

afterAll(async () => {
  await rm(contentTargetCutover.cutoverDir, { recursive: true, force: true });
});

/** Per-test answers of the fakes. */
interface Script {
  tableVersion: string | null;
  /** Cut-over files replacing the committed ones, for a version they hold. */
  cutover?: Pick<ResolvedPaths, 'cutoverDir' | 'groupsFile'>;
  rows: { ContentHistID: string; ContentID: string; Credits: string | null }[];
  rowsAffected: number;
  open: Pick<ServiceResponse, 'status' | 'body'>;
  complete: Pick<ServiceResponse, 'status' | 'body'>;
  /** Answers of successive `windowGet` calls; the last repeats. */
  windows: Partial<WriteWindow>[];
  read: () => Promise<Response>;
  clearError?: Error;
  feed?: Partial<FeedResult>;
}

interface Harness {
  env: FaultEnv;
  events: string[];
  requests: ServiceRequest[];
  inputs: Record<string, unknown>[];
  remote: { set: ReturnType<typeof vi.fn<RemoteFaults['set']>>; clear: ReturnType<typeof vi.fn<RemoteFaults['clear']>> };
  sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
  fetchUrls: string[];
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const envelope = (credits: string | null): Response => json(200, { apiversion: 'v1', method: 'findOne', params: {}, data: { contentid: CONTENT_ID, credits } });

function baseScript(overrides: Partial<Script> = {}): Script {
  return {
    tableVersion: 'v0002',
    rows: [{ ContentHistID: CONTENT_HIST_ID, ContentID: CONTENT_ID, Credits: OLD_CREDITS }],
    rowsAffected: 1,
    open: { status: 201, body: { windowId: WINDOW_ID, state: 'open', phase: 'executing' } },
    complete: { status: 200, body: { state: 'import-pending' } },
    windows: [{}],
    read: () => Promise.resolve(json(503, { error: { type: 'serviceUnavailable' } })),
    ...overrides,
  };
}

/** {@link baseScript} under the cut-over double, where content reads reach the target. */
function contentTargetScript(overrides: Partial<Script> = {}): Script {
  return baseScript({ tableVersion: CONTENT_TARGET_VERSION, cutover: contentTargetCutover, ...overrides });
}

function harness(script: Script): Harness {
  const events: string[] = [];
  const requests: ServiceRequest[] = [];
  const inputs: Record<string, unknown>[] = [];
  const fetchUrls: string[] = [];
  const windows = [...script.windows];
  let now = Date.parse('2026-06-30T10:00:00.000Z');

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
        events.push('update');
        return Promise.resolve({ recordset: [], rowsAffected: [script.rowsAffected] });
      },
    };
    return chain;
  };

  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      requests.push(req);
      let answer: Pick<ServiceResponse, 'status' | 'body'>;
      if (req.method === 'GET') {
        events.push('get');
        const next = windows.length > 1 ? windows.shift() : windows[0];
        answer = { status: 200, body: windowRecord(next ?? {}) };
      } else if (req.path.endsWith(':complete')) {
        events.push('complete');
        answer = script.complete;
      } else {
        events.push('open');
        answer = script.open;
      }
      return Promise.resolve({ headers: {}, ...answer } as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };

  const ctx = {
    env: { OPT2_GATEWAY_URL: GATEWAY_URL },
    config: script.cutover === undefined ? CONFIG : { ...CONFIG, paths: { ...CONFIG.paths, ...script.cutover } },
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
  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL) => {
      events.push('fetch');
      fetchUrls.push(String(url));
      return script.read();
    }),
  );
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
  return { env, events, requests, inputs, remote, sleep, fetchUrls };
}

const params = (overrides: Partial<WindowImportParams> = {}): WindowImportParams => ({ ...DEFAULTS, ...overrides });
const BOTH_UNITS = params({ units: [CONTENT_UNIT, TARGET_UNIT] });

beforeEach(() => {
  vi.mocked(runFeed).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  it('writes the row only between the window open and its complete, scoped to the site and content', async () => {
    const h = harness(contentTargetScript());
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(h.events).toStrictEqual(['select', 'open', 'arm', 'update', 'complete', 'get', 'fetch']);
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
    expect(h.fetchUrls).toStrictEqual([`${GATEWAY_URL}/_api/json/v1/tenant-a/content/${CONTENT_ID}`]);
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
      tableVersion: CONTENT_TARGET_VERSION,
    });
    expect(output.state).toStrictEqual({
      windowId: WINDOW_ID,
      completed: true,
      written: true,
      siteId: 'tenant-a',
      contentId: CONTENT_ID,
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

  it('checks the pending window but skips the read without a gateway call while content reads route to legacy', async () => {
    const h = harness(baseScript());
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(h.events).toStrictEqual(['select', 'open', 'arm', 'update', 'complete', 'get']);
    expect(h.fetchUrls).toStrictEqual([]);
    expect(output.details).toMatchObject({ targetUnits: [TARGET_UNIT], tableVersion: 'v0002' });
    expect(output.assertions).toStrictEqual([
      expect.objectContaining({ name: 'window-import-pending', status: 'pass' }),
      { name: 'read-not-superseded', status: 'skipped', reason: 'the content read (api:content.findone) routes to legacy under v0002' },
    ]);
  });

  it('fails when the window is not import-pending after the complete', async () => {
    const h = harness(baseScript({ windows: [{ state: 'closed', outcome: 'imported' }] }));
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(output.assertions[0]).toMatchObject({ name: 'window-import-pending', status: 'fail', reason: `window ${WINDOW_ID} is closed, not import-pending` });
  });

  it.each<[string, () => Promise<Response>, 'pass' | 'fail', string | undefined]>([
    ['a legacy 503', () => Promise.resolve(json(503, {})), 'pass', undefined],
    ['an outlasted wait', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), 'pass', undefined],
    ['the committed value', () => Promise.resolve(envelope(NEW_CREDITS)), 'pass', undefined],
    ['the superseded value', () => Promise.resolve(envelope(OLD_CREDITS)), 'fail', 'the superseded value was served'],
    ['an unexpected value', () => Promise.resolve(envelope('other')), 'fail', 'a value legacy never committed was served'],
    ['a body that is not JSON', () => Promise.resolve(new Response('<html></html>', { status: 200 })), 'fail', 'a value legacy never committed was served'],
    ['a 404', () => Promise.resolve(json(404, {})), 'fail', 'the gateway answered HTTP 404'],
    ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'fail', 'the gateway read failed'],
  ])('judges a read answered with %s', async (_label, read, status, reason) => {
    const h = harness(contentTargetScript({ read }));
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    const assertion = output.assertions.find((entry) => entry.name === 'read-not-superseded');
    expect(assertion).toMatchObject({ status, ...(reason === undefined ? {} : { reason }) });
  });

  it('treats a null credits column served as an empty string as superseded', async () => {
    const h = harness(contentTargetScript({ rows: [{ ContentHistID: CONTENT_HIST_ID, ContentID: CONTENT_ID, Credits: null }], read: () => Promise.resolve(envelope('')) }));
    const output = await windowImportInterrupted.run(h.env, BOTH_UNITS);

    expect(output.assertions[1]).toMatchObject({ status: 'fail', reason: 'the superseded value was served' });
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
    state: { windowId: WINDOW_ID, completed: true, written: true, siteId: 'tenant-a', contentId: CONTENT_ID, newCredits: NEW_CREDITS, units: [CONTENT_UNIT], ...state },
  });

  it('clears the fault, polls until the retry closes the window and feeds the legacy-authoritative units', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{}, {}, { state: 'closed', outcome: 'imported' }] }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput());

    expect(h.events).toStrictEqual(['clear', 'get', 'get', 'get', 'feed']);
    expect(h.sleep.mock.calls).toStrictEqual([[1000], [1000]]);
    expect(h.remote.clear).toHaveBeenCalledExactlyOnceWith('window-import-interrupted');
    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'rerun-feed']);
    expect(output.assertions).toMatchObject([
      { name: 'fault-cleared', status: 'pass' },
      { name: 'retry-closed', status: 'pass', detail: { elapsedMs: 2000, window: { state: 'closed' } } },
      { name: 'feed-propagated', status: 'pass', detail: { exitCode: 0, snapshotSeq: 7 } },
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

  it.each<[string, () => Promise<Response>, 'pass' | 'fail']>([
    ['the committed value', () => Promise.resolve(envelope(NEW_CREDITS)), 'pass'],
    ['the superseded value', () => Promise.resolve(envelope(OLD_CREDITS)), 'fail'],
    ['a 503', () => Promise.resolve(json(503, {})), 'fail'],
    ['an outlasted wait', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), 'fail'],
    ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'fail'],
  ])('re-reads target-authoritative units and judges %s', async (_label, read, status) => {
    const h = harness(contentTargetScript({ windows: [{ state: 'closed' }], read }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ units: [CONTENT_UNIT] }));

    expect(runFeed).not.toHaveBeenCalled();
    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'reread-target']);
    expect(output.assertions[2]).toMatchObject({ name: 'target-read-current', status });
  });

  it('feeds and re-reads a window over units of both authorities', async () => {
    const h = harness(contentTargetScript({ windows: [{ state: 'closed' }], read: () => Promise.resolve(envelope(NEW_CREDITS)) }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ units: [CONTENT_UNIT, LEGACY_UNIT] }));

    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'rerun-feed', 'reread-target']);
    expect(output.assertions.map(({ name, status }) => [name, status])).toStrictEqual([
      ['fault-cleared', 'pass'],
      ['retry-closed', 'pass'],
      ['feed-propagated', 'pass'],
      ['target-read-current', 'pass'],
    ]);
  });

  it('feeds a window over units of both authorities and skips the target read while content reads route to legacy', async () => {
    const h = harness(baseScript({ windows: [{ state: 'closed' }], read: () => Promise.resolve(envelope(NEW_CREDITS)) }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ units: [CONTENT_UNIT, TARGET_UNIT] }));

    expect(h.fetchUrls).toStrictEqual([]);
    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed', 'rerun-feed']);
    expect(output.assertions).toMatchObject([
      { name: 'fault-cleared', status: 'pass' },
      { name: 'retry-closed', status: 'pass' },
      { name: 'feed-propagated', status: 'pass' },
      { name: 'target-read-current', status: 'skipped', reason: 'the content read (api:content.findone) routes to legacy under v0002' },
    ]);
  });

  it('skips both reads without a gateway call while content.content is target-authoritative but the content read routes to legacy', async () => {
    const h = harness(baseScript({ tableVersion: CONTENT_UNIT_ONLY_VERSION, cutover: contentTargetCutover, windows: [{}, { state: 'closed' }] }));
    const run = await windowImportInterrupted.run(h.env, params());
    const resumed = await windowImportInterrupted.resume(h.env, params(), run);

    const reason = `the content read (api:content.findone) routes to legacy under ${CONTENT_UNIT_ONLY_VERSION}`;
    expect(h.fetchUrls).toStrictEqual([]);
    expect(run.details).toMatchObject({ units: [CONTENT_UNIT], targetUnits: [CONTENT_UNIT] });
    expect(run.assertions).toStrictEqual([
      expect.objectContaining({ name: 'window-import-pending', status: 'pass' }),
      { name: 'read-not-superseded', status: 'skipped', reason },
    ]);
    expect(resumed.steps).toStrictEqual(['clear-fault', 'await-closed']);
    expect(resumed.assertions).toMatchObject([
      { name: 'fault-cleared', status: 'pass' },
      { name: 'retry-closed', status: 'pass' },
      { name: 'target-read-current', status: 'skipped', reason },
    ]);
  });

  it('completes a window run left open, forwarded only when the row was written', async () => {
    const h = harness(baseScript({ tableVersion: 'v0001', windows: [{ state: 'closed', outcome: 'not-forwarded' }] }));
    const output = await windowImportInterrupted.resume(h.env, params(), runOutput({ completed: false, written: false }));

    expect(h.events).toStrictEqual(['clear', 'complete', 'get']);
    expect(h.requests[0]).toMatchObject({ path: `/internal/v1/windows/${WINDOW_ID}:complete`, json: { forwarded: false } });
    expect(output.steps).toStrictEqual(['clear-fault', 'complete-window', 'await-closed']);
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

    expect(output.steps).toStrictEqual(['clear-fault', 'await-closed']);
    expect(output.assertions[2]).toMatchObject({ name: 'feed-propagated', status: 'fail', reason: 'the active cut-over version could not be read' });
  });
});
