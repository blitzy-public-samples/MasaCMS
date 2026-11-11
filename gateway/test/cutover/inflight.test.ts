/** In-flight write registry against a throwaway `gateway` schema: ownership of rows, survival without heartbeats and evidence-backed clearing. */
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withMetadata } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  INSTANCE_LIVENESS_SECONDS,
  InflightEvidenceError,
  createInflightStore,
  type InflightClearInput,
  type InflightStore,
} from '../../src/cutover/inflight.js';
import type { components } from '../../src/generated/openapi.js';

type ClearRequest = components['schemas']['InflightClearRequest'];
type ClearResponse = components['schemas']['InflightClearResponse'];

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const ROUTE_LEGACY = 'admin:csettings.updatesite{action=add}';
const ROUTE_GATED = 'admin:cusers.update{type=2,action=add}';
const ROUTE_PARTLY_GATED = 'admin:cusers.update{type=1}';
const ROUTE_UNKNOWN = 'api:user.save';
const ROUTE_NO_UNITS = 'api:content.save';
const UNITS: Readonly<Record<string, readonly string[]>> = {
  [ROUTE_GATED]: ['identity.user_account', 'people.person'],
  [ROUTE_PARTLY_GATED]: ['identity.group_account', 'identity.membership'],
  [ROUTE_NO_UNITS]: [],
};

const available = await pgAvailable();

describe.skipIf(!available)('inflight store against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  const stores = new Map<string, InflightStore>();

  const store = (instanceId: string): InflightStore => {
    let found = stores.get(instanceId);
    if (found === undefined) {
      found = createInflightStore({ db: handle.app, instanceId, unitsOf: (route) => UNITS[route] });
      stores.set(instanceId, found);
    }
    return found;
  };

  /** Records an instance whose last heartbeat was `ageSeconds` ago by the database clock. */
  const heartbeat = (instanceId: string, ageSeconds: number): Promise<unknown> =>
    withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.instance (instance_id, seen_epoch, started_at, heartbeat_at)
         VALUES ($1, 0, now(), now() - make_interval(secs => $2))
         ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
        [instanceId, ageSeconds],
      ),
    );

  /** Evidence time `offsetMs` from now, as the contract's ISO-8601 string. */
  const evidenceAt = (offsetMs = 1000): string => new Date(Date.now() + offsetMs).toISOString();

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'gateway',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, async (tx) => {
      await tx.query(`DELETE FROM ${handle.schema}.inflight`);
      await tx.query(`DELETE FROM ${handle.schema}.instance`);
    });
  });

  it('registers, lists by filter and removes its own rows', async () => {
    const a = store('gw-a');
    await a.register({ requestId: 'req-1', route: ROUTE_LEGACY, side: 'legacy' });
    await a.register({ requestId: 'req-2', route: ROUTE_GATED, side: 'target', windowId: 'win-7' });
    await store('gw-b').register({ requestId: 'req-1', route: ROUTE_GATED, side: 'target' });

    const all = await a.list();
    expect(all.map((row) => [row.instanceId, row.requestId])).toEqual([
      ['gw-a', 'req-1'],
      ['gw-a', 'req-2'],
      ['gw-b', 'req-1'],
    ]);
    expect(all[1]).toEqual({
      instanceId: 'gw-a',
      requestId: 'req-2',
      route: ROUTE_GATED,
      side: 'target',
      windowId: 'win-7',
      startedAt: expect.stringMatching(ISO_WITH_OFFSET),
    });
    expect(all[0]?.windowId).toBeNull();
    expect((await a.list({ side: 'legacy' })).map((row) => row.requestId)).toEqual(['req-1']);
    expect((await a.list({ routes: [ROUTE_GATED], instanceIds: ['gw-b'] })).map((row) => row.instanceId)).toEqual(['gw-b']);
    expect(await a.list({ routes: [] })).toEqual([]);

    expect(await a.summary()).toEqual([
      { instanceId: 'gw-a', route: ROUTE_LEGACY, side: 'legacy', count: 1, oldestStartedAt: expect.stringMatching(ISO_WITH_OFFSET) },
      { instanceId: 'gw-a', route: ROUTE_GATED, side: 'target', count: 1, oldestStartedAt: expect.stringMatching(ISO_WITH_OFFSET) },
      { instanceId: 'gw-b', route: ROUTE_GATED, side: 'target', count: 1, oldestStartedAt: expect.stringMatching(ISO_WITH_OFFSET) },
    ]);

    expect(await a.remove('req-1')).toBe(true);
    expect(await a.remove('req-1')).toBe(false);
    expect(await a.remove('req-2')).toBe(true);
    expect((await a.list()).map((row) => row.instanceId)).toEqual(['gw-b']);
  });

  it('rejects a duplicate registration of one request', async () => {
    await store('gw-a').register({ requestId: 'req-dup', route: ROUTE_LEGACY, side: 'legacy' });
    await expect(store('gw-a').register({ requestId: 'req-dup', route: ROUTE_LEGACY, side: 'legacy' })).rejects.toMatchObject({
      code: '23505',
    });
  });

  it("never removes another instance's row", async () => {
    await store('gw-a').register({ requestId: 'req-shared', route: ROUTE_LEGACY, side: 'legacy' });
    expect(await store('gw-b').remove('req-shared')).toBe(false);
    expect((await store('gw-b').list()).map((row) => [row.instanceId, row.requestId])).toEqual([['gw-a', 'req-shared']]);
  });

  it('keeps the row of an instance that stopped heartbeating', async () => {
    await heartbeat('gw-stopped', 0);
    await store('gw-stopped').register({ requestId: 'req-stale', route: ROUTE_LEGACY, side: 'legacy' });
    await sleep(5_100);
    const rows = await store('gw-other').list();
    expect(rows.map((row) => row.requestId)).toEqual(['req-stale']);
    expect(await store('gw-other').list({ instanceIds: ['gw-stopped'] })).toHaveLength(1);
  }, 15_000);

  it.each([
    { side: 'target', kind: 'legacy-restart', units: undefined },
    { side: 'legacy', kind: 'gates-closed', units: ['people.person'] },
    { side: 'target', kind: 'gates-closed', units: [] },
    { side: 'target', kind: 'gates-closed', units: undefined },
  ] as const)('rejects $kind evidence on the $side side with units $units', async ({ side, kind, units }) => {
    await heartbeat('gw-dead', 60);
    await store('gw-dead').register({ requestId: 'req-x', route: ROUTE_GATED, side });
    const input: InflightClearInput = { side, evidence: { kind, holderId: 'trn-1', at: evidenceAt(), units } };
    await expect(store('gw-live').clearOrphans(input)).rejects.toBeInstanceOf(InflightEvidenceError);
    expect(await store('gw-live').list()).toHaveLength(1);
  });

  it('clears only legacy-side rows of dead or unknown instances that started before the evidence', async () => {
    await heartbeat('gw-live', 0);
    await heartbeat('gw-dead', INSTANCE_LIVENESS_SECONDS + 7);
    await store('gw-live').register({ requestId: 'live-legacy', route: ROUTE_LEGACY, side: 'legacy' });
    await store('gw-dead').register({ requestId: 'dead-legacy', route: ROUTE_LEGACY, side: 'legacy', windowId: 'win-1' });
    await store('gw-dead').register({ requestId: 'dead-target', route: ROUTE_GATED, side: 'target' });
    await store('gw-gone').register({ requestId: 'gone-legacy', route: ROUTE_LEGACY, side: 'legacy' });
    const at = evidenceAt();
    await sleep(1_100);
    await store('gw-dead').register({ requestId: 'dead-late', route: ROUTE_LEGACY, side: 'legacy' });

    const request: ClearRequest = { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'restart-1', at } };
    const result = await store('gw-live').clearOrphans(request);
    const response: ClearResponse = { cleared: result.cleared };

    expect(response).toEqual({ cleared: 2 });
    expect(result.rows.map((row) => [row.instanceId, row.requestId, row.windowId]).sort()).toEqual([
      ['gw-dead', 'dead-legacy', 'win-1'],
      ['gw-gone', 'gone-legacy', null],
    ]);
    expect(result.rows.every((row) => row.side === 'legacy' && ISO_WITH_OFFSET.test(row.startedAt))).toBe(true);
    expect((await store('gw-live').list()).map((row) => row.requestId).sort()).toEqual(['dead-late', 'dead-target', 'live-legacy']);
  });

  it('narrows legacy clearing to the named instances and routes', async () => {
    await store('gw-gone-1').register({ requestId: 'r1', route: ROUTE_LEGACY, side: 'legacy' });
    await store('gw-gone-2').register({ requestId: 'r2', route: ROUTE_LEGACY, side: 'legacy' });
    await store('gw-gone-2').register({ requestId: 'r3', route: ROUTE_GATED, side: 'legacy' });
    const evidence = { kind: 'legacy-restart', holderId: 'restart-2', at: evidenceAt() } as const;

    const byInstance = await store('gw-live').clearOrphans({ side: 'legacy', evidence, instanceIds: ['gw-gone-1'] });
    expect(byInstance.rows.map((row) => row.requestId)).toEqual(['r1']);
    const byRoute = await store('gw-live').clearOrphans({ side: 'legacy', evidence, routes: [ROUTE_GATED] });
    expect(byRoute.rows.map((row) => row.requestId)).toEqual(['r3']);
    expect((await store('gw-live').list()).map((row) => row.requestId)).toEqual(['r2']);
  });

  it('clears dead target-side rows only where every unit of the route had its gate closed', async () => {
    await heartbeat('gw-live', 0);
    await store('gw-live').register({ requestId: 'live-gated', route: ROUTE_GATED, side: 'target' });
    for (const route of [ROUTE_GATED, ROUTE_PARTLY_GATED, ROUTE_UNKNOWN, ROUTE_NO_UNITS]) {
      await store('gw-gone').register({ requestId: `gone ${route}`, route, side: 'target' });
    }
    await store('gw-gone').register({ requestId: 'gone-legacy', route: ROUTE_GATED, side: 'legacy' });
    const units = ['identity.user_account', 'people.person', 'identity.group_account'];
    const request: ClearRequest = { side: 'target', evidence: { kind: 'gates-closed', holderId: 'trn-2', at: evidenceAt(), units } };

    const result = await store('gw-live').clearOrphans(request);
    expect(result.cleared).toBe(1);
    expect(result.rows.map((row) => row.requestId)).toEqual([`gone ${ROUTE_GATED}`]);
    expect((await store('gw-live').list()).map((row) => row.requestId).sort()).toEqual(
      ['gone-legacy', `gone ${ROUTE_NO_UNITS}`, `gone ${ROUTE_PARTLY_GATED}`, `gone ${ROUTE_UNKNOWN}`, 'live-gated'].sort(),
    );

    const none = await store('gw-live').clearOrphans({ ...request, routes: [ROUTE_PARTLY_GATED] });
    expect(none).toEqual({ cleared: 0, rows: [] });
  });
});
