// Activation, freeze and epoch protocol of the cut-over state over the memory gateway store, and the dispatcher's freeze wait.
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LegacyServiceUnavailableError, adminUnavailableResponse, apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { systemClock } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import {
  ActivationRejected,
  CutoverConflict,
  DEFAULT_FREEZE_WAIT_MS,
  POLL_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  createCutoverState,
  type CutoverState,
  type CutoverStateLogger,
} from '../../src/cutover/state.js';
import type { GroupsFile } from '../../src/cutover/types.js';
import { FREEZE_WAIT_MS } from '../../src/dispatcher/dispatch.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import type { LegacyOrigin } from '../helpers/legacy-origin.js';
import { createMemoryGatewayDb, type MemoryGatewayDb } from '../helpers/memory-store.js';
import {
  committedGroups,
  committedIndex,
  committedTable,
  committedVariants,
  cutoverTable,
  fakeCutoverState,
  writeCutoverDir,
  type FakeCutoverState,
} from '../helpers/versions.js';

const swap = vi.hoisted(() => ({ state: undefined as CutoverState | undefined }));

// buildApp creates its own cut-over state, so a suite hands the next gateway it builds a double through this wrapper.
vi.mock('../../src/cutover/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cutover/state.js')>();
  return {
    ...actual,
    createCutoverState: (opts: Parameters<typeof actual.createCutoverState>[0]): CutoverState => {
      const next = swap.state;
      swap.state = undefined;
      return next ?? actual.createCutoverState(opts);
    },
  };
});

const OPERATOR = 'service:operator';
const ROSTER_CREATE = 'admin:cusers.update{type=2,action=add}';
const PERM_UPDATE = 'admin:cperm.update';
const PERM_UPDATE_URL = '/admin/?muraAction=cPerm.update';
// Roster create is legacy in every committed version, so the write whose move is observed is the archive: people in v0002, legacy in v0003.
const ARCHIVE = 'fixture:people/persons/{id}/archive@post';
const ARCHIVE_URL = '/legacy-fixtures/cfml/api.cfm/people/persons/00532E14-B51F-226C-36938FA3E4A6396C/archive';
const URLENCODED = 'application/x-www-form-urlencoded';
const FAKED_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;

const silent: CutoverStateLogger = { info: () => undefined, error: () => undefined };

let cutoverDir: string;
let paths: GatewayPaths;
let groups: GroupsFile;
let gateway: TestGateway | undefined;
const started: CutoverState[] = [];

beforeAll(async () => {
  const [v0001, v0002, v0003] = await Promise.all([committedTable('v0001'), committedTable('v0002'), committedTable('v0003')]);
  groups = await committedGroups();
  const invalid = cutoverTable({
    tableVersion: 'v0004',
    previous: 'v0002',
    groupAuthority: v0002.groupAuthority,
    createdAt: v0002.createdAt,
    entries: v0002.entries.map((item) => (item.route === PERM_UPDATE ? { ...item, state: 'target' } : item)),
  });
  cutoverDir = await writeCutoverDir(v0001, { groups, extraTables: [v0002, v0003, invalid] });
  paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: cutoverDir });
  await writeFile(join(paths.versionsDir, 'v0005.json'), JSON.stringify({ tableVersion: 'v0005', previous: 'v0002' }));
});

afterAll(async () => {
  await rm(cutoverDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const state of started.splice(0)) state.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  swap.state = undefined;
  await gateway?.close();
  gateway = undefined;
});

/** A cut-over state of `instanceId` over `db` and the suite's cut-over directory; stopped after each test. */
function makeState(instanceId: string, db: MemoryGatewayDb): CutoverState {
  const state = createCutoverState({ db, clock: systemClock, paths, instanceId, logger: silent, variants: committedVariants(), groups });
  started.push(state);
  return state;
}

/** Runs real event-loop turns, moving no fake time, until `done` holds or `max` turns have run; lets version-file reads finish. */
async function turns(done: () => boolean = () => false, max = 5000): Promise<void> {
  for (let turn = 0; turn < max && !done(); turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function seenEpoch(db: MemoryGatewayDb, instanceId: string): string | undefined {
  return db.tables.instance.find((row) => row.instance_id === instanceId)?.seen_epoch;
}

function storedState(db: MemoryGatewayDb): { table_version: string | null; epoch: string } | undefined {
  const row = db.tables.cutover_state[0];
  return row === undefined ? undefined : { table_version: row.table_version, epoch: row.epoch };
}

/** Requests legacy received outside the bridge. */
function pageRequests(legacy: LegacyOrigin): LegacyOrigin['requests'] {
  return legacy.requests.filter((req) => !req.path.startsWith('/gateway/legacy-bridge/'));
}

function targetRequests(test: TestGateway): number {
  return Object.values(test.targets).reduce((count, double) => count + double.requests.length, 0);
}

const archivePost = () =>
  ({ method: 'POST', url: ARCHIVE_URL, headers: { 'content-type': URLENCODED }, payload: 'effectiveFrom=2026-06-30' }) as const;

const permUpdatePost = () =>
  ({ method: 'POST', url: PERM_UPDATE_URL, headers: { 'content-type': URLENCODED }, payload: 'groupid=G1&siteid=default' }) as const;

// A target write in v0002 that the reload key sends to legacy, held by its own entry's freeze and by the reload entry's.
const TARGETING_SAVE = 'api:variationtargeting.save';
const RELOAD_HOLDS = ['reload:application', TARGETING_SAVE];
const RELOAD_TARGETING_URL = '/_api/json/v1/default/variationtargeting/?appreload';

const reloadTargetingPost = () =>
  ({ method: 'POST', url: RELOAD_TARGETING_URL, headers: { 'content-type': URLENCODED }, payload: 'contentid=C1&targetingjs=probe' }) as const;

describe('epoch read before write routing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
  });

  it('hands a write the stored version while reads keep the cached one until the next refresh', async () => {
    const db = createMemoryGatewayDb();
    const a = makeState('gw-a', db);
    const b = makeState('gw-b', db);
    await Promise.all([a.start(), b.start()]);
    await expect(b.readEpochForWrite()).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await a.activate({ tableVersion: 'v0001', actor: OPERATOR });
    const { epoch: activated } = await a.activate({ tableVersion: 'v0002', actor: OPERATOR });
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    await turns(() => seenEpoch(db, 'gw-b') === String(activated));
    const cached = b.active();
    expect(cached?.table.tableVersion).toBe('v0002');
    expect(cached?.entryFor(ARCHIVE)?.state).toBe('target');

    db.setActive('v0003', { previous: 'v0002', epoch: activated + 5 });
    expect(b.active()).toBe(cached);
    const { epoch, index } = await b.readEpochForWrite();

    expect(epoch).toBe(activated + 5);
    expect(index.table.tableVersion).toBe('v0003');
    expect(index.entryFor(ROSTER_CREATE)?.state).toBe('legacy');
    expect(index.entryFor(ARCHIVE)?.state).toBe('legacy');
    expect(seenEpoch(db, 'gw-b')).toBe(String(activated + 5));
  });
});

describe('epoch read before write routing at the edge', () => {
  it('sends a write to legacy as soon as the stored version moves it there, before any refresh', async () => {
    const db = createMemoryGatewayDb();
    gateway = await buildTestGateway({ version: 'v0002', db });
    const people = gateway.targets.people;
    expect(people).toBeDefined();
    const served = await gateway.app.inject(archivePost());
    expect(served.statusCode).toBe(200);
    expect(people?.requests.map((req) => req.path)).toEqual([ARCHIVE_URL]);
    expect(pageRequests(gateway.legacy)).toHaveLength(0);
    people?.clearRequests();

    db.setActive('v0003', { previous: 'v0002' });
    const res = await gateway.app.inject(archivePost());

    expect(res.statusCode).toBe(200);
    expect(pageRequests(gateway.legacy).map((req) => [req.method, req.path])).toEqual([['POST', ARCHIVE_URL]]);
    expect(targetRequests(gateway)).toBe(0);
  });
});

describe('read refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
  });

  it('serves the cached version to reads until the one-second refresh applies the stored one and heartbeats its epoch', async () => {
    const db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0001' } });
    const b = makeState('gw-b', db);
    await b.start();
    expect(b.active()?.table.tableVersion).toBe('v0001');
    expect(seenEpoch(db, 'gw-b')).toBe('1');

    db.setActive('v0002', { previous: 'v0001' });
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS - 1);
    await turns(undefined, 50);
    expect(b.active()?.table.tableVersion).toBe('v0001');
    expect(b.epoch()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await turns(() => seenEpoch(db, 'gw-b') === '2');
    expect(b.active()?.table.tableVersion).toBe('v0002');
    expect(seenEpoch(db, 'gw-b')).toBe('2');
  });
});

describe('freeze wait', () => {
  it.each([
    { name: 'DEFAULT_FREEZE_WAIT_MS', value: DEFAULT_FREEZE_WAIT_MS },
    { name: 'FREEZE_WAIT_MS', value: FREEZE_WAIT_MS },
  ])('sets $name to 30 000 ms', ({ value }) => {
    expect(value).toBe(30_000);
  });
});

describe('freeze', () => {
  let db: MemoryGatewayDb;
  let state: CutoverState;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0002', previous: 'v0001' } });
    state = makeState('gw-a', db);
    await state.start();
  });

  it('commits a new epoch and a freeze row without changing where the entry routes', async () => {
    const before = state.active()?.entryFor(PERM_UPDATE);
    expect(before).toBeDefined();
    expect(state.isFrozen(PERM_UPDATE)).toBe(false);

    const status = await state.freeze([PERM_UPDATE], 'op');

    expect(status.epoch).toBe(2);
    expect(status.frozen).toEqual([PERM_UPDATE]);
    expect(storedState(db)).toEqual({ table_version: 'v0002', epoch: '2' });
    expect(db.tables.cutover_freeze).toEqual([expect.objectContaining({ route: PERM_UPDATE, epoch: '2', frozen_by: 'op' })]);
    expect(state.epoch()).toBe(2);
    expect(state.isFrozen(PERM_UPDATE)).toBe(true);
    expect(state.isFrozen(ARCHIVE)).toBe(false);
    const after = state.active()?.entryFor(PERM_UPDATE);
    expect([after?.state, after?.owningService, after?.kind]).toEqual([before?.state, before?.owningService, before?.kind]);
  });

  it('refuses to freeze a route the active version lacks and commits nothing', async () => {
    const error = await state.freeze(['admin:no.such-action', PERM_UPDATE], 'op').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActivationRejected);
    expect((error as ActivationRejected).findings).toEqual([expect.objectContaining({ rule: 'unknown-route', route: 'admin:no.such-action' })]);
    expect(storedState(db)).toEqual({ table_version: 'v0002', epoch: '1' });
    expect(db.tables.cutover_freeze).toEqual([]);
    expect(state.isFrozen(PERM_UPDATE)).toBe(false);
  });

  it('keeps a frozen route waiting through 29 999 ms by default and answers false at 30 000 ms', async () => {
    await state.freeze([PERM_UPDATE], 'op');
    let settled: boolean | undefined;
    void state.waitUnfrozen(PERM_UPDATE).then((value) => {
      settled = value;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
  });

  it('resolves a frozen route\'s wait once another instance unfreezes it, deleting the row under a new epoch', async () => {
    await state.freeze([PERM_UPDATE], 'op');
    const operator = makeState('gw-op', db);
    let settled: boolean | undefined;
    void state.waitUnfrozen(PERM_UPDATE, DEFAULT_FREEZE_WAIT_MS).then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(settled).toBeUndefined();

    const status = await operator.unfreeze([PERM_UPDATE], 'op');
    expect(status.epoch).toBe(3);
    expect(status.frozen).toEqual([]);
    expect(db.tables.cutover_freeze).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(settled).toBe(true);
    expect(state.isFrozen(PERM_UPDATE)).toBe(false);
    expect(state.epoch()).toBe(3);
    expect(await state.waitUnfrozen(PERM_UPDATE, 0)).toBe(true);
  });
});

describe('frozen entries at the edge', () => {
  let fake: FakeCutoverState;

  beforeEach(async () => {
    fake = fakeCutoverState(await committedIndex('v0002'));
    swap.state = fake;
    gateway = await buildTestGateway({ version: 'v0002' });
  });

  it.each([
    { label: 'admin legacy-write', route: PERM_UPDATE, request: permUpdatePost, expected: adminUnavailableResponse() },
    {
      label: 'fixture target write',
      route: ARCHIVE,
      request: archivePost,
      expected: {
        ...apiUnavailableResponse(),
        body: '{"apiversion":"v1","method":"people.persons.archive","error":{"code":"server_error","message":"Unhandled Exception"}}',
      },
    },
  ])('holds a frozen $label for 30 000 ms, then answers the legacy 503 without reaching either side', async ({ route, request, expected }) => {
    const test = gateway as TestGateway;
    await fake.freeze([route], 'op');
    const wait = vi.spyOn(fake, 'waitUnfrozen').mockResolvedValue(false);

    const res = await test.app.inject(request());

    expect(wait).toHaveBeenCalledExactlyOnceWith(route, 30_000);
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(expected.headers['Content-Type']);
    expect(res.body).toBe(expected.body);
    expect(test.legacy.requests).toHaveLength(0);
    expect(targetRequests(test)).toBe(0);
  });

  it.each([
    { label: 'admin legacy-write', route: PERM_UPDATE, request: permUpdatePost, path: '/admin/', side: 'legacy' },
    { label: 'fixture target write', route: ARCHIVE, request: archivePost, path: ARCHIVE_URL, side: 'people' },
  ])('sends a frozen $label that is unfrozen within its wait to its unfrozen destination', async ({ route, request, path, side }) => {
    const test = gateway as TestGateway;
    expect(fake.active()?.entryFor(route)?.state).toBe(side === 'legacy' ? 'legacy' : 'target');
    await fake.freeze([route], 'op');
    const wait = vi.spyOn(fake, 'waitUnfrozen').mockImplementationOnce(async (frozen) => {
      await fake.unfreeze([frozen], 'op');
      return true;
    });

    const res = await test.app.inject(request());

    expect(wait).toHaveBeenCalledExactlyOnceWith(route, 30_000);
    expect(res.statusCode).toBe(200);
    const legacyPaths = pageRequests(test.legacy).map((req) => req.path);
    const people = test.targets.people?.requests.map((req) => req.path) ?? [];
    expect(side === 'legacy' ? legacyPaths : people).toEqual([path]);
    expect(side === 'legacy' ? targetRequests(test) : legacyPaths.length).toBe(0);
  });

  it.each(RELOAD_HOLDS)('holds a reload in front of a target write while %s is frozen, then answers the API 503 reaching neither side', async (route) => {
    const test = gateway as TestGateway;
    await fake.freeze([route], 'op');
    const wait = vi.spyOn(fake, 'waitUnfrozen').mockResolvedValue(false);

    const res = await test.app.inject(reloadTargetingPost());

    expect(wait).toHaveBeenCalledExactlyOnceWith(route, 30_000);
    const expected = apiUnavailableResponse();
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(expected.headers['Content-Type']);
    expect(JSON.parse(res.body)).toMatchObject({ error: (JSON.parse(expected.body) as { error: unknown }).error });
    expect(pageRequests(test.legacy)).toHaveLength(0);
    expect(targetRequests(test)).toBe(0);
    expect(test.migration.windows).toEqual([]);
  });

  it.each(RELOAD_HOLDS)('sends a reload in front of a target write that an unfreeze of %s releases to legacy inside its window', async (route) => {
    const test = gateway as TestGateway;
    await fake.freeze([route], 'op');
    const wait = vi.spyOn(fake, 'waitUnfrozen').mockImplementationOnce(async (frozen) => {
      await fake.unfreeze([frozen], 'op');
      return true;
    });

    const res = await test.app.inject(reloadTargetingPost());

    expect(wait).toHaveBeenCalledExactlyOnceWith(route, 30_000);
    expect(res.statusCode).toBe(200);
    expect(pageRequests(test.legacy).map((req) => req.url)).toEqual([RELOAD_TARGETING_URL]);
    expect(targetRequests(test)).toBe(0);
    const index = fake.active();
    const reloadAndWrite = [...(index?.entryFor(TARGETING_SAVE)?.units ?? []), ...(index?.entryFor('reload:application')?.units ?? [])];
    const units = [...new Set(reloadAndWrite)].filter((unit) => index?.unitAuthority(unit) === 'target');
    expect(units).toContain('content.variation_targeting');
    expect(test.migration.windows).toEqual([expect.objectContaining({ routeKey: TARGETING_SAVE, units, scope: { table: true } })]);
  });
});

describe('activation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
  });

  it('refuses a version whose previous is not the active one and leaves the epoch and version unchanged', async () => {
    const db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0001' } });
    const state = makeState('gw-a', db);
    await state.start();

    const error = await state.activate({ tableVersion: 'v0003', actor: OPERATOR }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CutoverConflict);
    expect((error as CutoverConflict).findings.map((finding) => finding.rule)).toEqual(['previous-mismatch']);
    expect(storedState(db)).toEqual({ table_version: 'v0001', epoch: '1' });
    expect(state.epoch()).toBe(1);
    expect(state.active()?.table.tableVersion).toBe('v0001');
  });

  it('refuses an activation another operation overtook after its epoch was read', async () => {
    const db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0001' } });
    const state = makeState('gw-a', db);
    db.respond(/^update cutover_state set table_version/, []);

    const error = await state.activate({ tableVersion: 'v0002', actor: OPERATOR }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CutoverConflict);
    expect((error as CutoverConflict).findings).toEqual([expect.objectContaining({ rule: 'previous-mismatch' })]);
    expect(storedState(db)).toEqual({ table_version: 'v0001', epoch: '1' });
  });

  it.each([
    { tableVersion: 'v0004', rule: 'legacy-write-always-legacy' },
    { tableVersion: 'v0005', rule: 'schema' },
    { tableVersion: 'v0099', rule: 'unknown-version' },
  ])('refuses $tableVersion with $rule findings and commits nothing', async ({ tableVersion, rule }) => {
    const db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0002', previous: 'v0001' } });
    const state = makeState('gw-a', db);
    await state.start();

    const error = await state.activate({ tableVersion, actor: OPERATOR }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActivationRejected);
    const { findings } = error as ActivationRejected;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings).toContainEqual(expect.objectContaining({ rule }));
    expect(storedState(db)).toEqual({ table_version: 'v0002', epoch: '1' });
    expect(state.epoch()).toBe(1);
    expect(state.active()?.table.tableVersion).toBe('v0002');
  });
});

describe('visibility and status', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
  });

  it('counts an activation visible only once a live lagging instance reports its epoch on its refresh tick', async () => {
    const db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0001' } });
    const a = makeState('gw-a', db);
    const b = makeState('gw-b', db);
    await Promise.all([a.start(), b.start()]);
    const { epoch } = await a.activate({ tableVersion: 'v0002', actor: OPERATOR });
    let visible: boolean | undefined;
    void a.awaitVisible(epoch, 5_000).then((value) => {
      visible = value;
    });

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS - 1);
    expect(visible).toBeUndefined();
    expect(seenEpoch(db, 'gw-b')).toBe(String(epoch - 1));

    await vi.advanceTimersByTimeAsync(1);
    await turns(() => seenEpoch(db, 'gw-b') === String(epoch));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(visible).toBe(true);
  });

  it('answers false at its timeout while a live instance lags, then resolves once that instance reports the epoch', async () => {
    const db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0001' } });
    const a = makeState('gw-a', db);
    await a.start();
    const { epoch } = await a.activate({ tableVersion: 'v0002', actor: OPERATOR });
    db.heartbeat('gw-b', epoch - 1);
    let timedOut: boolean | undefined;
    void a.awaitVisible(epoch, 1_000).then((value) => {
      timedOut = value;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(timedOut).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut).toBe(false);

    let visible: boolean | undefined;
    void a.awaitVisible(epoch, 5_000).then((value) => {
      visible = value;
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(visible).toBeUndefined();
    db.heartbeat('gw-b', epoch);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(visible).toBe(true);
  });

  it('ignores a lagging instance whose heartbeat is older than 3 s', async () => {
    const db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0001' } });
    const a = makeState('gw-a', db);
    await a.start();
    const { epoch } = await a.activate({ tableVersion: 'v0002', actor: OPERATOR });
    db.heartbeat('gw-gone', epoch - 1, new Date(Date.now() - 3_001));

    expect(await a.awaitVisible(epoch, 1_000)).toBe(true);
    expect((await a.status()).instances).toContainEqual(expect.objectContaining({ instanceId: 'gw-gone', live: false }));
  });

  it('reports the active version, epoch, frozen routes and every instance with its liveness', async () => {
    const db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0002', previous: 'v0001' } });
    const a = makeState('gw-a', db);
    const b = makeState('gw-b', db);
    await Promise.all([a.start(), b.start()]);
    await a.freeze([PERM_UPDATE], 'op');
    db.heartbeat('gw-gone', 0, new Date(Date.now() - 4_000));

    const status = await a.status();

    expect(status).toMatchObject({
      tableVersion: 'v0002',
      previous: 'v0001',
      epoch: 2,
      frozen: [PERM_UPDATE],
      acknowledgedEpoch: 1,
      inflight: [],
      sessionMode: 'target-primary',
    });
    expect(status.groupAuthority).toEqual(a.active()?.table.groupAuthority);
    expect(status.instances).toEqual([
      { instanceId: 'gw-a', seenEpoch: 2, heartbeatAt: expect.any(String), live: true },
      { instanceId: 'gw-b', seenEpoch: 1, heartbeatAt: expect.any(String), live: true },
      { instanceId: 'gw-gone', seenEpoch: 0, heartbeatAt: expect.any(String), live: false },
    ]);
  });
});
