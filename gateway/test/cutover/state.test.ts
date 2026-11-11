/** Cut-over state against a throwaway `gateway` schema: activation chain and validation, epoch CAS, freezes, visibility and status. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { tenantDbFromPool, withMetadata, type MetadataTx, type Pool, type TenantDb } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  testPgConfig,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { INSTANCE_LIVENESS_SECONDS, createInflightStore } from '../../src/cutover/inflight.js';
import { loadGroups, loadVariants } from '../../src/cutover/loader.js';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import {
  ActivationRejected,
  CutoverConflict,
  INSTANCE_RETENTION_SECONDS,
  SNAPSHOT_MAX_AGE_MS,
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

  /** The app pool, except that `withMetadata` rejects while `failing()` holds, as a lost coordination database would. */
  const flakyDb = (failing: () => boolean): TenantDb => ({
    schema: handle.app.schema,
    withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
    withMetadata: (fn) => (failing() ? Promise.reject(new Error('database unavailable')) : handle.app.withMetadata(fn)),
    end: () => Promise.resolve(),
  });

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

  it('prunes at start the instances dead past the retention window that hold no in-flight write, and still reports the contract status', async () => {
    await setActive('v0001', null, 1);
    await heartbeat('gw-old', 1, INSTANCE_RETENTION_SECONDS + 60);
    await heartbeat('gw-ancient', 1, INSTANCE_RETENTION_SECONDS * 24);
    await heartbeat('gw-old-busy', 1, INSTANCE_RETENTION_SECONDS + 60);
    await heartbeat('gw-recent', 1, INSTANCE_RETENTION_SECONDS - 60);
    const busy = createInflightStore({ db: handle.app, instanceId: 'gw-old-busy', unitsOf: () => undefined });
    await busy.register({ requestId: 'req-old', route: FROZEN_ROUTE, side: 'target' });
    const state = makeState('gw-a');

    await state.start();

    const status = await state.status();
    expectContract('GET', '/internal/v1/cutover/status', 200, status);
    expect(status.instances.map((instance) => [instance.instanceId, instance.live])).toEqual([
      ['gw-a', true],
      ['gw-old-busy', false],
      ['gw-recent', false],
    ]);
    expect(status.acknowledgedEpoch).toBe(1);
    expect(status.inflight).toEqual([expect.objectContaining({ instanceId: 'gw-old-busy', route: FROZEN_ROUTE, side: 'target', count: 1 })]);
    expect(await sql(`SELECT instance_id, request_id FROM ${handle.schema}.inflight`)).toEqual([
      { instance_id: 'gw-old-busy', request_id: 'req-old' },
    ]);
  });

  it.each([
    ['live-instance', `heartbeat_at >= now() - interval '${String(INSTANCE_LIVENESS_SECONDS)} seconds' AND seen_epoch < 2`],
    ['retention', `heartbeat_at < now() - make_interval(secs => ${String(INSTANCE_RETENTION_SECONDS)})`],
  ])('answers the %s predicate from the heartbeat index', async (_name, predicate) => {
    const plan = await withMetadata(handle.app, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const { rows } = await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) SELECT count(*) FROM ${handle.schema}.instance WHERE ${predicate}`);
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('instance_heartbeat_idx');
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
    const logger = { info: vi.fn(), error: vi.fn() };
    const state = makeState('gw-a', { db: flakyDb(() => failing), logger });
    failing = true;
    await expect(state.start()).rejects.toThrow('database unavailable');
    failing = false;
    await state.start();
    await state.start();
    state.stop();
    await state.start();

    failing = true;
    await vi.waitFor(
      () =>
        expect(logger.error).toHaveBeenCalledWith(
          { err: expect.objectContaining({ message: 'database unavailable' }) },
          'cut-over state refresh failed: instance=gw-a',
        ),
      { timeout: 2000, interval: 25 },
    );
    failing = false;
    await setActive('v0002', 'v0001', 2);
    await vi.waitFor(() => expect(state.epoch()).toBe(2), { timeout: 2500, interval: 25 });
    state.stop();
  });

  it('fails closed on a snapshot older than its maximum age while refreshes fail, and recovers on the next successful refresh', async () => {
    await setActive('v0001', null, 1);
    let failing = false;
    const logger = { info: vi.fn(), error: vi.fn() };
    const state = makeState('gw-a', { db: flakyDb(() => failing), logger });
    const operator = makeState('gw-op');
    const startedAt = Date.now();
    await Promise.all([state.start(), operator.start()]);
    expect(state.isFrozen(FROZEN_ROUTE)).toBe(false);
    failing = true;

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled(), { timeout: 1500, interval: 25 });
    expect(state.active()?.table.tableVersion).toBe('v0001');

    await vi.waitFor(() => expect(state.active()).toBeUndefined(), { timeout: SNAPSHOT_MAX_AGE_MS, interval: 25 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SNAPSHOT_MAX_AGE_MS);
    expect(state.isFrozen(FROZEN_ROUTE)).toBe(true);
    expect(state.isFrozen('admin:carch.audit')).toBe(true);
    await expect(state.waitUnfrozen('admin:carch.audit', 600)).rejects.toThrow('database unavailable');

    // The stale instance's heartbeat lapses only after it stopped serving, so the freeze is visible without it.
    const { epoch } = await operator.freeze([FROZEN_ROUTE], OPERATOR);
    expect(await operator.awaitVisible(epoch, 3000)).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2900);
    expect(state.active()).toBeUndefined();

    failing = false;
    await vi.waitFor(() => expect(state.active()?.table.tableVersion).toBe('v0001'), { timeout: 1500, interval: 25 });
    expect(state.epoch()).toBe(epoch);
    expect(state.isFrozen(FROZEN_ROUTE)).toBe(true);
    expect(state.isFrozen('admin:carch.audit')).toBe(false);
    expect(await state.waitUnfrozen('admin:carch.audit', 600)).toBe(true);
  });

  it.each([
    ['waitUnfrozen', 'cutover_state'],
    ['awaitVisible', 'instance'],
  ] as const)('ends %s at its budget while %s is locked, and the server ends its statement', async (operation, table) => {
    const budget = 1000;
    await setActive('v0001', null, 1);
    const operator = makeState('gw-a');
    const { epoch } = await operator.freeze([FROZEN_ROUTE], OPERATOR);
    const running = async (): Promise<number> =>
      (
        await handle.adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND state <> 'idle'`, [
          handle.roles.app,
        ])
      ).rows[0]?.n ?? -1;
    const locker = await handle.adminPool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`LOCK TABLE ${handle.schema}.${table} IN ACCESS EXCLUSIVE MODE`);
      const startedAt = Date.now();
      const outcome = operation === 'waitUnfrozen' ? operator.waitUnfrozen(FROZEN_ROUTE, budget) : operator.awaitVisible(epoch, budget);
      await vi.waitFor(async () => expect(await running()).toBe(1), { timeout: budget / 2, interval: 20 });

      expect(await outcome).toBe(false);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(budget - 10);
      expect(elapsed).toBeLessThan(budget + 250);
      await vi.waitFor(async () => expect(await running()).toBe(0), { timeout: 250, interval: 10 });
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(await operator.awaitVisible(epoch, budget)).toBe(true);
  });

  it('keeps a frozen entry waiting through 29 999 ms of fake time and answers false at 30 000 ms', async () => {
    const tx = {
      kind: 'metadata',
      schema: handle.schema,
      onCommit: () => undefined,
      query: (text: string) =>
        Promise.resolve({
          rows: text.includes('cutover_state')
            ? [{ table_version: 'v0001', previous_version: null, epoch: '2' }]
            : text.includes('cutover_freeze')
              ? [{ route: FROZEN_ROUTE }]
              : [],
        }),
    } as unknown as MetadataTx;
    const memory: TenantDb = {
      schema: handle.schema,
      withTenant: () => Promise.reject(new Error('no tenant work in the cut-over state')),
      withMetadata: (fn) => fn(tx),
      end: () => Promise.resolve(),
    };
    const waiter = makeState('gw-b', { db: memory });
    await waiter.readEpochForWrite();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let settled: boolean | undefined;
      void waiter.waitUnfrozen(FROZEN_ROUTE).then((value) => {
        settled = value;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a wait whose connection arrives after its budget, without querying or an unhandled rejection', async () => {
    await setActive('v0001', null, 1);
    await makeState('gw-a').freeze([FROZEN_ROUTE], OPERATOR);
    let lateConnect = false;
    let statements = 0;
    const counted = (tx: MetadataTx): MetadataTx => ({
      ...tx,
      query: ((text: string, values?: unknown[]) => {
        statements += 1;
        return tx.query(text, values);
      }) as MetadataTx['query'],
    });
    const slow: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      end: () => Promise.resolve(),
      withMetadata: (fn) =>
        lateConnect ? sleep(900).then(() => handle.app.withMetadata((tx) => fn(counted(tx)))) : handle.app.withMetadata(fn),
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const waiter = makeState('gw-b', { db: slow });
      await waiter.readEpochForWrite();
      lateConnect = true;

      const startedAt = Date.now();
      expect(await waiter.waitUnfrozen(FROZEN_ROUTE, 600)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(600 + 150);
      await sleep(600);
      expect(statements).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  /** A private one-connection app pool named `name` in pg_stat_activity, reached through 127.0.0.1:`port` when given. */
  const privatePool = (name: string, port?: number): { pool: Pool; db: TenantDb; checkedOut: () => number } => {
    const pool = handle.connect('app', { max: 1 });
    Object.assign(pool.options, { application_name: name }, port === undefined ? {} : { host: '127.0.0.1', port });
    let out = 0;
    pool.on('acquire', () => {
      out += 1;
    });
    pool.on('release', () => {
      out -= 1;
    });
    return { pool, db: tenantDbFromPool(pool, { schema: handle.schema }), checkedOut: () => out };
  };

  /** Server backends whose application_name is `name`, oldest first. */
  const backends = async (name: string): Promise<{ pid: number; state: string; query: string; in_transaction: boolean }[]> =>
    (
      await handle.adminPool.query<{ pid: number; state: string; query: string; in_transaction: boolean }>(
        `SELECT pid, state, query, xact_start IS NOT NULL AS in_transaction FROM pg_stat_activity WHERE application_name = $1 ORDER BY backend_start`,
        [name],
      )
    ).rows;

  it('destroys the connection of a check whose replies stall past its budget, and checks that expire later never query', async () => {
    const budget = 300;
    await setActive('v0001', null, 1);
    const proxy = await stallingProxy();
    const name = `gw-stall-${randomUUID().slice(0, 8)}`;
    const { pool, db, checkedOut } = privatePool(name, proxy.port);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const state = makeState('gw-stall', { db });
      (await pool.connect()).release();
      const [warm] = await backends(name);
      proxy.stall();

      let startedAt = Date.now();
      expect(await state.awaitVisible(1, budget)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(budget + 150);
      expect(pool.totalCount - pool.idleCount).toBe(0);
      expect(checkedOut()).toBe(0);
      await vi.waitFor(async () => expect((await backends(name)).map((backend) => backend.pid)).not.toContain(warm?.pid), {
        timeout: 3000,
        interval: 20,
      });

      startedAt = Date.now();
      expect(await Promise.all([0, 1, 2].map(() => state.awaitVisible(1, budget)))).toEqual([false, false, false]);
      expect(Date.now() - startedAt).toBeLessThan(budget + 150);
      expect(checkedOut()).toBe(0);

      proxy.resume();
      await vi.waitFor(() => expect([pool.waitingCount, pool.totalCount, pool.idleCount]).toEqual([0, 1, 1]), {
        timeout: 3000,
        interval: 10,
      });
      expect(checkedOut()).toBe(0);
      expect(await backends(name)).toEqual([expect.objectContaining({ state: 'idle', query: '', in_transaction: false })]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      proxy.resume();
      await db.end();
      await proxy.close();
    }
  });

  it('drops the queued checkouts of checks that expire behind a busy connection, so none sends a statement', async () => {
    const budget = 300;
    await setActive('v0001', null, 1);
    const name = `gw-queue-${randomUUID().slice(0, 8)}`;
    const { pool, db, checkedOut } = privatePool(name);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const held = await pool.connect();
    let holding = true;
    try {
      const state = makeState('gw-queue', { db });
      await held.query("SELECT 'held' AS marker");

      const startedAt = Date.now();
      expect(await Promise.all(Array.from({ length: 5 }, () => state.awaitVisible(1, budget)))).toEqual(Array(5).fill(false));
      expect(Date.now() - startedAt).toBeLessThan(budget + 150);
      expect(pool.waitingCount).toBe(5);

      held.release();
      holding = false;
      await vi.waitFor(() => expect([pool.waitingCount, pool.totalCount, pool.idleCount]).toEqual([0, 1, 1]), {
        timeout: 1000,
        interval: 5,
      });
      expect(checkedOut()).toBe(0);
      expect(await backends(name)).toEqual([expect.objectContaining({ state: 'idle', query: "SELECT 'held' AS marker", in_transaction: false })]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      if (holding) held.release();
      await db.end();
    }
  });
});

/** A TCP proxy to the PG_* server whose server-to-client bytes are held back from `stall()` until `resume()`. */
async function stallingProxy(): Promise<{ port: number; stall(): void; resume(): void; close(): Promise<void> }> {
  const target = testPgConfig();
  const sockets = new Set<Socket>();
  const held: (() => void)[] = [];
  let stalled = false;
  const server = createServer((client) => {
    const upstream = connect({ host: target.host, port: target.port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.on('data', (chunk: Buffer) => {
      if (stalled) held.push(() => client.write(chunk));
      else client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    stall: () => {
      stalled = true;
    },
    resume: () => {
      stalled = false;
      for (const flush of held.splice(0)) flush();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
