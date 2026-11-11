/** Cut-over state against a throwaway `gateway` schema: activation chain and validation, epoch CAS, freezes, visibility and status. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createInflightStore } from '../../src/cutover/inflight.js';
import { loadGroups, loadVariants } from '../../src/cutover/loader.js';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import {
  ActivationRejected,
  CutoverConflict,
  createCutoverState,
  type CutoverState,
  type CutoverStateLogger,
} from '../../src/cutover/state.js';
import type { GroupsFile, VariantsFile } from '../../src/cutover/types.js';

const FROZEN_ROUTE = 'admin:cperm.update';
const OPERATOR = 'service:operator';

const available = await pgAvailable();

describe.skipIf(!available)('cut-over state against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let paths: GatewayPaths;
  let variants: VariantsFile;
  let groups: GroupsFile;
  let contract: object;
  const started: CutoverState[] = [];

  const silent: CutoverStateLogger = { info: () => undefined, error: () => undefined };

  const makeState = (
    instanceId: string,
    overrides: { clock?: Clock; db?: TenantDb; logger?: CutoverStateLogger; paths?: GatewayPaths; groups?: GroupsFile } = {},
  ): CutoverState => {
    const state = createCutoverState({
      db: overrides.db ?? handle.app,
      clock: overrides.clock ?? systemClock,
      paths: overrides.paths ?? paths,
      instanceId,
      logger: overrides.logger ?? silent,
      variants,
      groups: 'groups' in overrides ? overrides.groups : groups,
    });
    started.push(state);
    return state;
  };

  const sql = <R extends object = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<R[]> =>
    withMetadata(handle.app, async (tx) => (await tx.query<R & Record<string, unknown>>(text, values)).rows);

  /** Stores `tableVersion` as active at `epoch` without validation, as another instance's activation would. */
  const setActive = (tableVersion: string | null, previous: string | null, epoch: number): Promise<unknown> =>
    sql(`UPDATE ${handle.schema}.cutover_state SET table_version = $1, previous_version = $2, epoch = $3 WHERE id = 1`, [
      tableVersion,
      previous,
      epoch,
    ]);

  const storedEpoch = async (): Promise<number> =>
    Number((await sql<{ epoch: string }>(`SELECT epoch FROM ${handle.schema}.cutover_state WHERE id = 1`))[0]?.epoch);

  /** Records an instance at `seenEpoch` whose last heartbeat was `ageSeconds` ago by the database clock. */
  const heartbeat = (instanceId: string, seenEpoch: number, ageSeconds = 0): Promise<unknown> =>
    sql(
      `INSERT INTO ${handle.schema}.instance (instance_id, seen_epoch, started_at, heartbeat_at)
       VALUES ($1, $2, now(), now() - make_interval(secs => $3))
       ON CONFLICT (instance_id) DO UPDATE SET seen_epoch = EXCLUDED.seen_epoch, heartbeat_at = EXCLUDED.heartbeat_at`,
      [instanceId, seenEpoch, ageSeconds],
    );

  const expectContract = (method: string, path: string, status: number, body: unknown): void => {
    expect(() => assertResponseMatchesOpenApi(contract, { method, path, status, contentType: 'application/json', body })).not.toThrow();
  };

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'gateway',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    paths = resolveGatewayPaths({});
    [variants, groups] = await Promise.all([loadVariants(paths), loadGroups(paths)]);
    contract = parse(await readFile(join(paths.packageRoot, 'contracts', 'openapi.yaml'), 'utf8')) as object;
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, async (tx) => {
      await tx.query(
        `UPDATE ${handle.schema}.cutover_state SET table_version = NULL, previous_version = NULL, epoch = 0, activated_at = NULL, activated_by = NULL`,
      );
      await tx.query(`DELETE FROM ${handle.schema}.cutover_freeze`);
      await tx.query(`DELETE FROM ${handle.schema}.instance`);
      await tx.query(`DELETE FROM ${handle.schema}.inflight`);
    });
  });

  afterEach(() => {
    for (const state of started.splice(0)) state.stop();
  });

  it('activates v0001 from the seeded row as epoch 1 and serves its index', async () => {
    const state = makeState('gw-a');
    await state.start();
    expect(state.active()).toBeUndefined();
    await expect(state.readEpochForWrite()).rejects.toBeInstanceOf(LegacyServiceUnavailableError);

    const result = await state.activate({ tableVersion: 'v0001', actor: OPERATOR });

    expect(result).toEqual({ tableVersion: 'v0001', epoch: 1 });
    expectContract('POST', '/internal/v1/cutover/activate', 200, result);
    expect(state.epoch()).toBe(1);
    expect(state.active()?.table.tableVersion).toBe('v0001');
    const [row] = await sql<{ table_version: string; previous_version: string | null; activated_by: string }>(
      `SELECT table_version, previous_version, activated_by FROM ${handle.schema}.cutover_state WHERE id = 1`,
    );
    expect(row).toEqual({ table_version: 'v0001', previous_version: null, activated_by: OPERATOR });
  });

  it('refuses a version whose previous is not the active one as a previous-mismatch conflict', async () => {
    await setActive('v0001', null, 1);
    const state = makeState('gw-a');

    const error = await state.activate({ tableVersion: 'v0003', actor: OPERATOR }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CutoverConflict);
    expect((error as CutoverConflict).findings.map((f) => f.rule)).toEqual(['previous-mismatch']);
    expectContract('POST', '/internal/v1/cutover/activate', 409, { findings: (error as CutoverConflict).findings });
    expect(await storedEpoch()).toBe(1);
  });

  it('refuses unknown and schema-invalid version files without committing an epoch', async () => {
    const state = makeState('gw-a');
    const unknown = await state.activate({ tableVersion: 'v0099', actor: OPERATOR }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(ActivationRejected);
    expect((unknown as ActivationRejected).findings.map((f) => f.rule)).toEqual(['unknown-version']);
    expectContract('POST', '/internal/v1/cutover/activate', 400, { findings: (unknown as ActivationRejected).findings });

    const dir = await mkdtemp(join(tmpdir(), 'state-test-'));
    try {
      await writeFile(join(dir, 'v0009.json'), JSON.stringify({ tableVersion: 'v0009' }));
      const invalid = await makeState('gw-b', { paths: { ...paths, versionsDir: dir } })
        .activate({ tableVersion: 'v0009', actor: OPERATOR })
        .catch((e: unknown) => e);
      expect(invalid).toBeInstanceOf(ActivationRejected);
      expect((invalid as ActivationRejected).findings.map((f) => f.rule)).toEqual(['schema']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await storedEpoch()).toBe(0);
  });

  it('commits exactly one of two concurrent activations of v0002', async () => {
    await setActive('v0001', null, 1);
    const results = await Promise.allSettled([
      makeState('gw-a').activate({ tableVersion: 'v0002', actor: OPERATOR }),
      makeState('gw-b').activate({ tableVersion: 'v0002', actor: OPERATOR }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toEqual([{ status: 'fulfilled', value: { tableVersion: 'v0002', epoch: 2 } }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(CutoverConflict);
    expect(await storedEpoch()).toBe(2);
  });

  it('rejects v0003 in activation mode while rollback-before.json is pending-run', async () => {
    await setActive('v0002', 'v0001', 2);
    const state = makeState('gw-a');

    const error = await state.activate({ tableVersion: 'v0003', actor: OPERATOR }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActivationRejected);
    const findings = (error as ActivationRejected).findings;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.rule === 'rollback-evidence')).toBe(true);
    expect(await storedEpoch()).toBe(2);
  });

  it('reads the stored epoch for a write before the background refresh has applied it', async () => {
    await setActive('v0001', null, 1);
    const state = makeState('gw-a');
    await state.start();
    await setActive('v0002', 'v0001', 2);
    expect(state.active()?.table.tableVersion).toBe('v0001');

    const { epoch, index } = await state.readEpochForWrite();

    expect(epoch).toBe(2);
    expect(index.table.tableVersion).toBe('v0002');
    expect(state.active()?.table.tableVersion).toBe('v0002');
    const [instance] = await sql<{ seen_epoch: string }>(`SELECT seen_epoch FROM ${handle.schema}.instance WHERE instance_id = 'gw-a'`);
    expect(Number(instance?.seen_epoch)).toBe(2);
  });

  it('shows a freeze on a second instance within a second without changing where the entry routes', async () => {
    await setActive('v0001', null, 1);
    const a = makeState('gw-a');
    const b = makeState('gw-b');
    await Promise.all([a.start(), b.start()]);
    const before = b.active()?.entryFor(FROZEN_ROUTE);
    expect(before).toBeDefined();
    expect(b.isFrozen(FROZEN_ROUTE)).toBe(false);

    const status = await a.freeze([FROZEN_ROUTE.toUpperCase()], OPERATOR);

    expect(status.epoch).toBe(2);
    expect(status.frozen).toEqual([FROZEN_ROUTE]);
    expectContract('POST', '/internal/v1/cutover/freeze', 200, status);
    const [row] = await sql<{ epoch: string; frozen_by: string }>(`SELECT epoch, frozen_by FROM ${handle.schema}.cutover_freeze`);
    expect(row).toEqual({ epoch: '2', frozen_by: OPERATOR });
    expect(a.isFrozen(FROZEN_ROUTE)).toBe(true);
    await vi.waitFor(() => expect(b.isFrozen(FROZEN_ROUTE)).toBe(true), { timeout: 1100, interval: 25 });
    expect(b.epoch()).toBe(2);
    expect(b.active()?.entryFor(FROZEN_ROUTE)?.state).toBe(before?.state);
    expect(b.active()?.entryFor(FROZEN_ROUTE)?.owningService).toBe(before?.owningService);
    expect(await a.awaitVisible(2, 1500)).toBe(true);
  });

  it('refuses unknown routes, unfreezes known ones and unfreezes a route the active version no longer has', async () => {
    await setActive('v0001', null, 1);
    const state = makeState('gw-a');
    await state.start();

    const error = await state.freeze(['admin:no.such-action', FROZEN_ROUTE], OPERATOR).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivationRejected);
    expect((error as ActivationRejected).findings).toEqual([
      expect.objectContaining({ rule: 'unknown-route', route: 'admin:no.such-action' }),
    ]);
    expectContract('POST', '/internal/v1/cutover/freeze', 400, { findings: (error as ActivationRejected).findings });
    expect(await storedEpoch()).toBe(1);
    expect(await sql(`SELECT route FROM ${handle.schema}.cutover_freeze`)).toEqual([]);

    await state.freeze([FROZEN_ROUTE], OPERATOR);
    await sql(`INSERT INTO ${handle.schema}.cutover_freeze (route, epoch, frozen_at, frozen_by) VALUES ('admin:retired.route', 1, now(), 'op')`);
    const status = await state.unfreeze([FROZEN_ROUTE, 'admin:retired.route'], OPERATOR);

    expect(status.epoch).toBe(3);
    expect(status.frozen).toEqual([]);
    expect(state.isFrozen(FROZEN_ROUTE)).toBe(false);
    expectContract('POST', '/internal/v1/cutover/unfreeze', 200, status);
  });

  it('resolves waitUnfrozen when the route is released and returns false at its deadline with a fixed clock', async () => {
    await setActive('v0001', null, 1);
    const operator = makeState('gw-a');
    await operator.start();
    await operator.freeze([FROZEN_ROUTE], OPERATOR);
    const waiter = makeState('gw-b', { clock: fixedClock('2026-06-30T12:00:00Z') });
    await waiter.readEpochForWrite();
    expect(await waiter.waitUnfrozen('admin:carch.audit')).toBe(true);

    const startedAt = Date.now();
    expect(await waiter.waitUnfrozen(FROZEN_ROUTE, 600)).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(590);

    const released = waiter.waitUnfrozen(FROZEN_ROUTE, 5000);
    await sleep(300);
    await operator.unfreeze([FROZEN_ROUTE], OPERATOR);
    expect(await released).toBe(true);
  });

  it('waits for a live lagging instance and ignores one whose heartbeat is older than 3 s', async () => {
    await setActive('v0001', null, 1);
    const state = makeState('gw-a');
    await state.start();
    const { epoch } = await state.activate({ tableVersion: 'v0002', actor: OPERATOR });
    await heartbeat('gw-lagging', epoch - 1);

    expect(await state.awaitVisible(epoch, 600)).toBe(false);
    const pending = state.awaitVisible(epoch, 5000);
    await sleep(300);
    await heartbeat('gw-lagging', epoch);
    expect(await pending).toBe(true);

    await heartbeat('gw-lagging', epoch - 1, 4);
    expect(await state.awaitVisible(epoch, 600)).toBe(true);
    const status = await state.status();
    expect(status.instances).toEqual([
      expect.objectContaining({ instanceId: 'gw-a', seenEpoch: epoch, live: true }),
      expect.objectContaining({ instanceId: 'gw-lagging', seenEpoch: epoch - 1, live: false }),
    ]);
    expect(status.acknowledgedEpoch).toBe(epoch);
  });

  it('reports the contract status with group authority, in-flight writes and session mode', async () => {
    const idle = await makeState('gw-idle').status();
    expect(idle).toEqual({
      tableVersion: null,
      previous: null,
      epoch: 0,
      groupAuthority: {},
      frozen: [],
      instances: [],
      acknowledgedEpoch: null,
      inflight: [],
      sessionMode: 'legacy-primary',
    });
    expectContract('GET', '/internal/v1/cutover/status', 200, idle);

    await setActive('v0002', 'v0001', 2);
    const state = makeState('gw-a');
    await state.start();
    const inflight = createInflightStore({ db: handle.app, instanceId: 'gw-a', unitsOf: () => undefined });
    await inflight.register({ requestId: 'req-1', route: FROZEN_ROUTE, side: 'legacy' });

    const status = await state.status();

    expectContract('GET', '/internal/v1/cutover/status', 200, status);
    expect(status).toMatchObject({ tableVersion: 'v0002', previous: 'v0001', epoch: 2, acknowledgedEpoch: 2 });
    expect(status.groupAuthority).toEqual(state.active()?.table.groupAuthority);
    expect(status.inflight).toEqual([expect.objectContaining({ instanceId: 'gw-a', route: FROZEN_ROUTE, side: 'legacy', count: 1 })]);
    expect(status.sessionMode).toBe(state.active()?.loginGroupAuthority() === 'target' ? 'target-primary' : 'legacy-primary');
  });

  it('loads groups.json when no groups are passed', async () => {
    await setActive('v0001', null, 1);
    const state = makeState('gw-a', { groups: undefined });
    const { index } = await state.readEpochForWrite();
    expect(index.table.tableVersion).toBe('v0001');
  });

  it('logs a failed background refresh and recovers on the next tick', async () => {
    await setActive('v0001', null, 1);
    let failing = false;
    const flaky: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => (failing ? Promise.reject(new Error('database unavailable')) : handle.app.withMetadata(fn)),
      end: () => Promise.resolve(),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const state = makeState('gw-a', { db: flaky, logger });
    failing = true;
    await expect(state.start()).rejects.toThrow('database unavailable');
    failing = false;
    await state.start();
    await state.start();
    state.stop();
    await state.start();

    failing = true;
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'gw-a' }), expect.any(String)), {
      timeout: 2000,
      interval: 25,
    });
    failing = false;
    await setActive('v0002', 'v0001', 2);
    await vi.waitFor(() => expect(state.epoch()).toBe(2), { timeout: 2500, interval: 25 });
    state.stop();
  });
});
