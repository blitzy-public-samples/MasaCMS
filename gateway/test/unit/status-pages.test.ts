/** Cut-over status in keyset pages: streamed JSON equal to the collected status, lazy page reads, and freezes answered with the new epoch. */
import { createLogger } from '@opt2/platform/logging';
import { systemClock } from '@opt2/platform/service-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS_PAGE_SIZE } from '../../src/cutover/inflight.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import { createCutoverState, type CutoverState, type CutoverStatus, type CutoverStatusV2 } from '../../src/cutover/state.js';
import { collectStatus, statusJson, type CutoverStatusPages } from '../../src/cutover/status-pages.js';
import { createMemoryGatewayDb, type InflightRowRecord, type InstanceRow, type MemoryGatewayDb } from '../helpers/memory-store.js';
import { committedGroups, committedVariants, pagesOf } from '../helpers/versions.js';

const T0 = new Date('2026-06-30T12:00:00.000Z');
const LIVE = 'gw-live';
const ROUTE_TARGET = 'admin:cusers.update{type=2,action=add}';
const ROUTE_LEGACY = 'page:saverate';
/** Dead instances enough for three instance pages, each holding two in-flight groups. */
const DEAD_COUNT = 2 * STATUS_PAGE_SIZE + 1;
const DEAD_IDS = Array.from({ length: DEAD_COUNT }, (_, i) => `gw-${String(i).padStart(4, '0')}`);
const AT = '2026-06-30T12:00:00.000+00:00';
const silent = createLogger({ service: 'gateway', version: 'test', env: 'local', level: 'silent' });

const SMALL: CutoverStatus = {
  tableVersion: 'v0001',
  previous: null,
  epoch: 4,
  groupAuthority: { 'g-a': 'legacy', 'g-b': 'target' },
  frozen: [ROUTE_TARGET],
  instances: ['gw-1', 'gw-2', 'gw-3'].map((instanceId, i) => ({ instanceId, seenEpoch: 4, heartbeatAt: AT, live: i !== 2 })),
  acknowledgedEpoch: 4,
  inflight: ['gw-1', 'gw-3'].map((instanceId) => ({ instanceId, route: ROUTE_TARGET, side: 'target', count: 2, oldestStartedAt: AT })),
  sessionMode: 'target-primary',
};

const SMALL_V2: CutoverStatusV2 = { ...SMALL, inflight: SMALL.inflight.map((group, i) => ({ ...group, orphaned: i === 1 })) };

async function* listed<T>(...pages: T[][]): AsyncGenerator<T[]> {
  for (const page of pages) yield page;
}

async function text(chunks: AsyncIterable<string>): Promise<string> {
  let body = '';
  for await (const chunk of chunks) body += chunk;
  return body;
}

describe('statusJson', () => {
  const EMPTY: CutoverStatus = { ...SMALL, instances: [], inflight: [], acknowledgedEpoch: null };

  it.each<[string, CutoverStatus, () => CutoverStatusPages]>([
    ['one page per list', SMALL, () => pagesOf(SMALL)],
    ['one item per page', SMALL, () => pagesOf(SMALL, { instances: 1, inflight: 1 })],
    ['v2 in-flight groups, one item per page', SMALL_V2, () => pagesOf(SMALL_V2, { instances: 1, inflight: 1 })],
    ['empty lists', EMPTY, () => pagesOf(EMPTY)],
    [
      'empty pages among full ones',
      SMALL,
      () => {
        const { instances, inflight, ...head } = SMALL;
        return { head, instances: listed([], instances.slice(0, 2), [], instances.slice(2), []), inflight: listed([], [], inflight) };
      },
    ],
  ])('streams exactly the JSON of the collected status with %s', async (_label, expected, pages) => {
    expect(await collectStatus(pages())).toEqual(expected);
    expect(await text(statusJson(pages()))).toBe(JSON.stringify(expected));
  });
});

describe('cut-over state status pages', () => {
  let db: MemoryGatewayDb;
  let state: CutoverState;

  /** Statements reading an instance page (`LIMIT $2`), a v1 in-flight summary page (`LIMIT $4`) or a v2 one (`LIMIT $5`). */
  const pageReads = (limit: '$2' | '$4' | '$5'): unknown[][] =>
    db.queries.filter((query) => query.text.endsWith(`LIMIT ${limit}`)).map((query) => query.values);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const dead = new Date(T0.getTime() - 60_000);
    const instances: Partial<InstanceRow>[] = [
      ...DEAD_IDS.map((instance_id) => ({ instance_id, seen_epoch: '1', started_at: dead, heartbeat_at: dead })),
      { instance_id: LIVE, seen_epoch: '1' },
    ];
    const inflight: Partial<InflightRowRecord>[] = [
      ...DEAD_IDS.flatMap((instance_id) => [
        { instance_id, request_id: 't', route: ROUTE_TARGET, side: 'target' as const, started_at: dead },
        { instance_id, request_id: 'l', route: ROUTE_LEGACY, side: 'legacy' as const, started_at: dead },
      ]),
      { instance_id: LIVE, request_id: 'running', route: ROUTE_TARGET, side: 'target' },
      { instance_id: LIVE, request_id: 'abandoned', route: ROUTE_TARGET, side: 'target', abandoned_at: T0 },
    ];
    db = createMemoryGatewayDb({ activeVersion: { tableVersion: 'v0001' }, instances, inflight });
    state = createCutoverState({
      db,
      clock: systemClock,
      paths: resolveGatewayPaths({}),
      instanceId: LIVE,
      logger: silent,
      variants: committedVariants(),
      groups: await committedGroups(),
    });
  });

  afterEach(() => {
    state.stop();
    vi.useRealTimers();
  });

  const deadGroups = (): unknown[][] =>
    DEAD_IDS.flatMap((id) => [
      [id, ROUTE_TARGET, 'target', 1],
      [id, ROUTE_LEGACY, 'legacy', 1],
    ]);

  it('reports every instance and v1 in-flight group across keyset pages, in key order, reading each page once', async () => {
    const status = await state.status();

    expect(status.instances.map((instance) => [instance.instanceId, instance.live])).toEqual([
      ...DEAD_IDS.map((id) => [id, false]),
      [LIVE, true],
    ]);
    // The live instance's running and abandoned writes share one v1 group, which carries exactly the v1 keys.
    expect(status.inflight.map((group) => [group.instanceId, group.route, group.side, group.count])).toEqual([
      ...deadGroups(),
      [LIVE, ROUTE_TARGET, 'target', 2],
    ]);
    expect(Object.keys(status.inflight.at(-1) ?? {})).toEqual(['instanceId', 'route', 'side', 'count', 'oldestStartedAt']);
    expect(status).toMatchObject({ tableVersion: 'v0001', epoch: 1, acknowledgedEpoch: 1, frozen: [] });
    expect(pageReads('$2')).toEqual([
      [null, STATUS_PAGE_SIZE],
      [DEAD_IDS[STATUS_PAGE_SIZE - 1], STATUS_PAGE_SIZE],
      [DEAD_IDS[2 * STATUS_PAGE_SIZE - 1], STATUS_PAGE_SIZE],
    ]);
    const lastOfPage = (page: number): unknown[] => {
      const group = status.inflight[page * STATUS_PAGE_SIZE - 1];
      return [group?.instanceId, group?.route, group?.side, STATUS_PAGE_SIZE];
    };
    expect(pageReads('$4')).toEqual([[null, null, null, STATUS_PAGE_SIZE], lastOfPage(1), lastOfPage(2), lastOfPage(3), lastOfPage(4)]);
    expect(pageReads('$5')).toEqual([]);
  });

  it('reports every v2 in-flight group across keyset pages, split and marked by orphan state, reading each page once', async () => {
    const status = await collectStatus(await state.statusV2Pages());

    expect(status.instances).toEqual((await state.status()).instances);
    expect(status.inflight.map((group) => [group.instanceId, group.route, group.side, group.count, group.orphaned])).toEqual([
      ...deadGroups().map((group) => [...group, true]),
      [LIVE, ROUTE_TARGET, 'target', 1, false],
      [LIVE, ROUTE_TARGET, 'target', 1, true],
    ]);
    const lastOfPage = (page: number): unknown[] => {
      const group = status.inflight[page * STATUS_PAGE_SIZE - 1];
      return [group?.instanceId, group?.route, group?.side, group?.orphaned, STATUS_PAGE_SIZE];
    };
    expect(pageReads('$5')).toEqual([[null, null, null, null, STATUS_PAGE_SIZE], lastOfPage(1), lastOfPage(2), lastOfPage(3), lastOfPage(4)]);
  });

  it.each<[string, () => Promise<CutoverStatusPages>, '$4' | '$5', () => Promise<unknown>]>([
    ['v1', () => state.statusPages(), '$4', () => state.status()],
    ['v2', () => state.statusV2Pages(), '$5', async () => collectStatus(await state.statusV2Pages())],
  ])('reads no %s page before its list is iterated, and streams the same bytes the collected status serialises to', async (_label, pagesFn, limit, collected) => {
    const pages = await pagesFn();
    expect([pageReads('$2'), pageReads(limit)]).toEqual([[], []]);

    const body = await text(statusJson(pages));

    expect([pageReads('$2').length, pageReads(limit).length]).toEqual([3, 5]);
    expect(body).toBe(JSON.stringify(await collected()));
  });

  it('answers freeze and unfreeze with the v1 status at the epoch each committed', async () => {
    const frozen = await state.freezePages([ROUTE_TARGET], 'operator');
    expect(frozen.head).toMatchObject({ epoch: 2, frozen: [ROUTE_TARGET] });
    expect((await collectStatus(frozen)).instances).toHaveLength(DEAD_COUNT + 1);

    const unfrozen = await state.unfreeze([ROUTE_TARGET], 'operator');
    expect(unfrozen).toMatchObject({ epoch: 3, frozen: [] });
    expect(unfrozen.inflight).toHaveLength(2 * DEAD_COUNT + 1);
    expect(pageReads('$5')).toEqual([]);
  });
});
