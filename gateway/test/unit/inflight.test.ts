/** In-flight write registry over the in-memory gateway schema: row ownership, evidence-backed orphan clearing and survival over time. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INSTANCE_LIVENESS_SECONDS,
  InflightEvidenceError,
  createInflightStore,
  type InflightClearInput,
  type InflightRow,
  type InflightStore,
  type OrphanEvidenceRecord,
} from '../../src/cutover/inflight.js';
import { createMemoryGatewayDb, type MemoryGatewayDb, type RecordedQuery } from '../helpers/memory-store.js';

const T0 = new Date('2026-06-30T12:00:00.000Z');
const ROUTE_LEGACY = 'page:saverate';
const ROUTE_TARGET = 'admin:cperm.update';
const ROUTE_OTHER = 'admin:cusers.update{type=1}';
const ROUTE_UNKNOWN = 'api:user.save';
const LEGACY_UNITS = ['content.content_rating', 'content.content_stats'];
const TARGET_UNITS = ['content.approval_assignment', 'identity.permission'];
const OTHER_UNITS = ['identity.group_account', 'identity.membership'];
const UNITS: ReadonlyMap<string, readonly string[]> = new Map([
  [ROUTE_LEGACY, LEGACY_UNITS],
  [ROUTE_TARGET, TARGET_UNITS],
  [ROUTE_OTHER, OTHER_UNITS],
]);
const INFLIGHT_DELETE = /^delete from (?:"gateway"|gateway)\.inflight\b/i;

let db: MemoryGatewayDb;

const store = (instanceId: string): InflightStore => createInflightStore({ db, instanceId, unitsOf: (route) => UNITS.get(route) });

const secondsFromT0 = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

const legacyRestart = (at = secondsFromT0(1)): OrphanEvidenceRecord => ({
  kind: 'legacy-restart',
  holderId: 'restart-1',
  at: at.toISOString(),
});

const gatesClosed = (units: readonly string[] | undefined, at = secondsFromT0(1)): OrphanEvidenceRecord => ({
  kind: 'gates-closed',
  holderId: 'trn-1',
  at: at.toISOString(),
  units,
});

const keys = (rows: readonly InflightRow[]): string[][] => rows.map((row) => [row.instanceId, row.requestId]);

const isInflightDelete = (query: RecordedQuery): boolean => INFLIGHT_DELETE.test(query.text);

/** Statements deleting from `gateway.inflight` that `fn` issued. */
async function inflightDeletesOf(fn: () => Promise<unknown>): Promise<RecordedQuery[]> {
  const from = db.queries.length;
  await fn();
  return db.queries.slice(from).filter(isInflightDelete);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = createMemoryGatewayDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('row ownership', () => {
  let a: InflightStore;
  let b: InflightStore;

  beforeEach(async () => {
    a = store('gw-a');
    b = store('gw-b');
    await a.register({ requestId: 'req-1', route: ROUTE_LEGACY, side: 'legacy' });
    await a.register({ requestId: 'req-2', route: ROUTE_TARGET, side: 'target' });
  });

  it("another instance's remove leaves the row and the forwarding instance's remove deletes it", async () => {
    expect(await b.remove('req-1')).toBe(false);
    expect(await b.list()).toContainEqual(expect.objectContaining({ instanceId: 'gw-a', requestId: 'req-1' }));

    expect(await a.remove('req-1')).toBe(true);
    expect(keys(await b.list())).toEqual([['gw-a', 'req-2']]);
    expect(await a.remove('req-1')).toBe(false);
  });

  it("lists every instance's rows, narrowed by side, routes and instance ids", async () => {
    await b.register({ requestId: 'req-1', route: ROUTE_TARGET, side: 'target' });

    expect(keys(await b.list())).toEqual([
      ['gw-a', 'req-1'],
      ['gw-a', 'req-2'],
      ['gw-b', 'req-1'],
    ]);
    expect(keys(await a.list({ side: 'target' }))).toEqual([
      ['gw-a', 'req-2'],
      ['gw-b', 'req-1'],
    ]);
    expect(keys(await a.list({ routes: [ROUTE_LEGACY] }))).toEqual([['gw-a', 'req-1']]);
    expect(keys(await a.list({ instanceIds: ['gw-a'] }))).toEqual([
      ['gw-a', 'req-1'],
      ['gw-a', 'req-2'],
    ]);
    expect(keys(await a.list({ side: 'target', routes: [ROUTE_TARGET], instanceIds: ['gw-b'] }))).toEqual([['gw-b', 'req-1']]);
    expect(await a.list({ routes: [] })).toEqual([]);
  });

  it('round-trips a registered window id and stores null when none is given', async () => {
    await a.register({ requestId: 'req-3', route: ROUTE_LEGACY, side: 'legacy', windowId: 'win-7' });

    const rows = await b.list({ instanceIds: ['gw-a'] });
    expect(rows.map((row) => [row.requestId, row.windowId])).toEqual([
      ['req-1', null],
      ['req-2', null],
      ['req-3', 'win-7'],
    ]);
    expect(rows).toContainEqual({
      instanceId: 'gw-a',
      requestId: 'req-3',
      route: ROUTE_LEGACY,
      side: 'legacy',
      windowId: 'win-7',
      startedAt: expect.any(String),
    });
    expect(rows.map((row) => Date.parse(row.startedAt))).toEqual([T0.getTime(), T0.getTime(), T0.getTime()]);
  });
});

describe('orphan evidence', () => {
  let live: InflightStore;

  beforeEach(async () => {
    db.heartbeat('gw-a', 0, secondsFromT0(-10));
    db.heartbeat('gw-live', 0);
    live = store('gw-live');
    await store('gw-a').register({ requestId: 'a-legacy', route: ROUTE_LEGACY, side: 'legacy' });
    await store('gw-a').register({ requestId: 'a-target', route: ROUTE_TARGET, side: 'target' });
    await live.register({ requestId: 'live-legacy', route: ROUTE_LEGACY, side: 'legacy' });
    await live.register({ requestId: 'live-target', route: ROUTE_TARGET, side: 'target' });
  });

  it("a controlled legacy restart clears only the dead instance's legacy-side row", async () => {
    const result = await live.clearOrphans({ side: 'legacy', evidence: legacyRestart() });

    expect(result).toEqual({
      cleared: 1,
      rows: [{ instanceId: 'gw-a', requestId: 'a-legacy', route: ROUTE_LEGACY, side: 'legacy', windowId: null, startedAt: expect.any(String) }],
    });
    expect(keys(await live.list())).toEqual([
      ['gw-a', 'a-target'],
      ['gw-live', 'live-legacy'],
      ['gw-live', 'live-target'],
    ]);
  });

  it("gates closed on every unit of its route clear only the dead instance's target-side row", async () => {
    const result = await live.clearOrphans({ side: 'target', evidence: gatesClosed(TARGET_UNITS) });

    expect(result.cleared).toBe(1);
    expect(keys(result.rows)).toEqual([['gw-a', 'a-target']]);
    expect(keys(await live.list())).toEqual([
      ['gw-a', 'a-legacy'],
      ['gw-live', 'live-legacy'],
      ['gw-live', 'live-target'],
    ]);
  });

  it.each<{ name: string; input: InflightClearInput }>([
    { name: 'legacy-restart evidence on the target side', input: { side: 'target', evidence: legacyRestart() } },
    { name: 'gates-closed evidence on the legacy side', input: { side: 'legacy', evidence: gatesClosed(LEGACY_UNITS) } },
    { name: 'gates-closed evidence naming no units', input: { side: 'target', evidence: gatesClosed([]) } },
    { name: 'gates-closed evidence without units', input: { side: 'target', evidence: gatesClosed(undefined) } },
  ])('rejects $name before issuing any statement', async ({ input }) => {
    const issued = db.queries.length;

    await expect(live.clearOrphans(input)).rejects.toBeInstanceOf(InflightEvidenceError);
    expect(db.queries).toHaveLength(issued);
    expect(db.tables.inflight).toHaveLength(4);
  });

  it("a live instance's rows survive both kinds of evidence, even when named", async () => {
    const legacy = await live.clearOrphans({ side: 'legacy', evidence: legacyRestart(), instanceIds: ['gw-live'] });
    const target = await live.clearOrphans({ side: 'target', evidence: gatesClosed(TARGET_UNITS), instanceIds: ['gw-live'] });

    expect([legacy, target]).toEqual([
      { cleared: 0, rows: [] },
      { cleared: 0, rows: [] },
    ]);
    expect(db.tables.inflight).toHaveLength(4);
  });

  it(`an instance counts as live while its heartbeat is at most ${INSTANCE_LIVENESS_SECONDS} s old`, async () => {
    db.heartbeat('gw-edge', 0, secondsFromT0(-INSTANCE_LIVENESS_SECONDS));
    await store('gw-edge').register({ requestId: 'edge-legacy', route: ROUTE_LEGACY, side: 'legacy' });
    expect(keys((await live.clearOrphans({ side: 'legacy', evidence: legacyRestart() })).rows)).toEqual([['gw-a', 'a-legacy']]);

    db.heartbeat('gw-edge', 0, secondsFromT0(-INSTANCE_LIVENESS_SECONDS - 0.001));
    expect(keys((await live.clearOrphans({ side: 'legacy', evidence: legacyRestart() })).rows)).toEqual([['gw-edge', 'edge-legacy']]);
  });

  it('instance and route filters narrow legacy-restart clearing; an instance without heartbeats is dead', async () => {
    await store('gw-gone').register({ requestId: 'gone-legacy', route: ROUTE_LEGACY, side: 'legacy' });
    await store('gw-gone').register({ requestId: 'gone-other', route: ROUTE_OTHER, side: 'legacy' });
    const evidence = legacyRestart();

    expect(keys((await live.clearOrphans({ side: 'legacy', evidence, routes: [ROUTE_OTHER] })).rows)).toEqual([['gw-gone', 'gone-other']]);
    expect(keys((await live.clearOrphans({ side: 'legacy', evidence, instanceIds: ['gw-gone'] })).rows)).toEqual([['gw-gone', 'gone-legacy']]);
    expect(await live.clearOrphans({ side: 'legacy', evidence, routes: [ROUTE_OTHER], instanceIds: ['gw-a'] })).toEqual({ cleared: 0, rows: [] });
    expect(keys(await live.list({ side: 'legacy' }))).toEqual([
      ['gw-a', 'a-legacy'],
      ['gw-live', 'live-legacy'],
    ]);
  });

  it('instance and route filters narrow gates-closed clearing', async () => {
    await store('gw-gone').register({ requestId: 'gone-target', route: ROUTE_TARGET, side: 'target' });
    await store('gw-gone').register({ requestId: 'gone-other', route: ROUTE_OTHER, side: 'target' });
    const evidence = gatesClosed([...TARGET_UNITS, ...OTHER_UNITS]);

    expect(keys((await live.clearOrphans({ side: 'target', evidence, routes: [ROUTE_OTHER] })).rows)).toEqual([['gw-gone', 'gone-other']]);
    expect(keys((await live.clearOrphans({ side: 'target', evidence, instanceIds: ['gw-a'] })).rows)).toEqual([['gw-a', 'a-target']]);
    expect(keys(await live.list({ side: 'target' }))).toEqual([
      ['gw-gone', 'gone-target'],
      ['gw-live', 'live-target'],
    ]);
  });

  it('closed gates leave a row whose route still has an open or unknown unit, without deleting anything', async () => {
    await store('gw-gone').register({ requestId: 'gone-unknown', route: ROUTE_UNKNOWN, side: 'target' });
    const partial = gatesClosed(['identity.permission', 'people.person']);

    expect(await inflightDeletesOf(() => live.clearOrphans({ side: 'target', evidence: partial }))).toEqual([]);
    expect(db.tables.inflight).toHaveLength(5);

    const result = await live.clearOrphans({ side: 'target', evidence: gatesClosed([...TARGET_UNITS, 'people.person']) });
    expect(keys(result.rows)).toEqual([['gw-a', 'a-target']]);
    expect(keys(await live.list({ side: 'target' }))).toEqual([
      ['gw-gone', 'gone-unknown'],
      ['gw-live', 'live-target'],
    ]);
  });

  it('evidence clears no row that started at or after its time', async () => {
    expect(await live.clearOrphans({ side: 'legacy', evidence: legacyRestart(T0) })).toEqual({ cleared: 0, rows: [] });
    expect(await live.clearOrphans({ side: 'target', evidence: gatesClosed(TARGET_UNITS, secondsFromT0(-1)) })).toEqual({ cleared: 0, rows: [] });
    expect(db.tables.inflight).toHaveLength(4);
  });
});

describe('time never clears', () => {
  let a: InflightStore;
  let live: InflightStore;

  beforeEach(async () => {
    db.heartbeat('gw-a', 0);
    a = store('gw-a');
    live = store('gw-live');
    await a.register({ requestId: 'a-legacy', route: ROUTE_LEGACY, side: 'legacy' });
    await a.register({ requestId: 'a-target', route: ROUTE_TARGET, side: 'target', windowId: 'win-1' });
    vi.advanceTimersByTime(10 * 60_000);
    db.heartbeat('gw-live', 0);
  });

  it('heartbeat loss alone never clears an in-flight row, however much time passes', async () => {
    const orphaned = await live.list({ instanceIds: ['gw-a'] });
    await live.register({ requestId: 'live-legacy', route: ROUTE_LEGACY, side: 'legacy' });

    expect(await live.remove('a-legacy')).toBe(false);
    expect(await live.summary()).toEqual([
      { instanceId: 'gw-a', route: ROUTE_TARGET, side: 'target', count: 1, oldestStartedAt: expect.any(String) },
      { instanceId: 'gw-a', route: ROUTE_LEGACY, side: 'legacy', count: 1, oldestStartedAt: expect.any(String) },
      { instanceId: 'gw-live', route: ROUTE_LEGACY, side: 'legacy', count: 1, oldestStartedAt: expect.any(String) },
    ]);
    expect(keys(orphaned)).toEqual([
      ['gw-a', 'a-legacy'],
      ['gw-a', 'a-target'],
    ]);
    expect(await live.list({ instanceIds: ['gw-a'] })).toEqual(orphaned);
    expect(orphaned.map((row) => Date.parse(row.startedAt))).toEqual([T0.getTime(), T0.getTime()]);
  });

  it('only remove and clearOrphans issue deletes from gateway.inflight', async () => {
    const quiet = [
      await inflightDeletesOf(() => live.register({ requestId: 'live-target', route: ROUTE_TARGET, side: 'target' })),
      await inflightDeletesOf(() => live.list()),
      await inflightDeletesOf(() => live.list({ side: 'legacy', routes: [ROUTE_LEGACY], instanceIds: ['gw-a'] })),
      await inflightDeletesOf(() => live.summary()),
    ];
    expect(quiet.flat()).toEqual([]);
    expect(db.tables.inflight).toHaveLength(3);

    const removed = await inflightDeletesOf(() => live.remove('live-target'));
    const cleared = await inflightDeletesOf(() =>
      live.clearOrphans({ side: 'target', evidence: gatesClosed(TARGET_UNITS, secondsFromT0(10 * 60 + 1)) }),
    );

    expect(removed).toEqual([{ text: expect.stringMatching(/WHERE instance_id = \$1 AND request_id = \$2$/), values: ['gw-live', 'live-target'] }]);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.text).toMatch(/^DELETE FROM "gateway"\.inflight AS i WHERE i\.side = \$1 /);
    expect(db.queries.filter(isInflightDelete)).toEqual([...removed, ...cleared]);
    expect(keys(await live.list())).toEqual([['gw-a', 'a-legacy']]);
  });
});
