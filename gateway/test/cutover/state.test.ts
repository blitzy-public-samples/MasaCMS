/** Cut-over state against a throwaway `gateway` schema: activation chain and validation, epoch CAS, freezes, visibility and status. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { REDACTED, createLogger, validateLogRecord } from '@opt2/platform/logging';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import {
  tenantDbFromPool,
  withMetadata,
  type MetadataTx,
  type Pool,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
} from '@opt2/platform/tenancy';
import { MemorySpanExporter, activeSpanIds, shutdownTracing, startTracing } from '@opt2/platform/tracing';
import {
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  loadOpenApiDocument,
  pgAvailable,
  testPgConfig,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { INSTANCE_LIVENESS_SECONDS, STATUS_PAGE_SIZE, createInflightStore } from '../../src/cutover/inflight.js';
import { loadGroups, loadVariants } from '../../src/cutover/loader.js';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import {
  ActivationRejected,
  CutoverConflict,
  CutoverVersionInvalid,
  INSTANCE_RETENTION_SECONDS,
  REFRESH_INTERVAL_MS,
  SNAPSHOT_MAX_AGE_MS,
  createCutoverState,
  type CutoverState,
  type CutoverStateLogger,
  type CutoverStatus,
  type VersionCheck,
} from '../../src/cutover/state.js';
import { collectStatus, statusJson } from '../../src/cutover/status-pages.js';
import type { GroupsFile, VariantsFile } from '../../src/cutover/types.js';
import { main as validateMain } from '../../src/cutover/validate.js';
import { prepareTestStateDir, testEnv } from '../helpers/env.js';
import { acceptEveryVersion, committedTable, cutoverTable, rollbackReport, writeCutoverDir } from '../helpers/versions.js';

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
    overrides: {
      clock?: Clock;
      db?: TenantDb;
      logger?: CutoverStateLogger;
      paths?: GatewayPaths;
      groups?: GroupsFile;
      checkVersion?: VersionCheck;
    } = {},
  ): CutoverState => {
    const state = createCutoverState({
      db: overrides.db ?? handle.app,
      clock: overrides.clock ?? systemClock,
      paths: overrides.paths ?? paths,
      instanceId,
      logger: overrides.logger ?? silent,
      variants,
      groups: 'groups' in overrides ? overrides.groups : groups,
      checkVersion: overrides.checkVersion,
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

  /** The app pool, except that each statement matching `statement` after the first `passing` of them rejects with `error`. */
  const rejectingDb = (statement: RegExp, passing: number, error: Error): TenantDb => {
    let matched = 0;
    const rejects = (text: string | QueryConfig): boolean => {
      if (typeof text !== 'string' || !statement.test(text)) return false;
      matched += 1;
      return matched > passing;
    };
    return {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn, options) =>
        handle.app.withMetadata(
          (tx) =>
            fn({
              ...tx,
              query: <R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>> =>
                rejects(text) ? Promise.reject(error) : tx.query<R>(text, values),
            }),
          options,
        ),
      end: () => Promise.resolve(),
    };
  };

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
    contract = loadOpenApiDocument(join(paths.packageRoot, 'contracts', 'openapi.yaml'), parse) as object;
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
    const logged: string[] = [];
    const logger: CutoverStateLogger = { info: (_obj, msg) => logged.push(msg), error: () => undefined };
    const state = makeState('gw-a', { logger });
    const unknown = await state.activate({ tableVersion: 'v0099', actor: OPERATOR }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(ActivationRejected);
    expect((unknown as ActivationRejected).findings).toEqual([{ rule: 'unknown-version', message: 'no version file v0099.json' }]);
    expectContract('POST', '/internal/v1/cutover/activate', 400, { findings: (unknown as ActivationRejected).findings });
    expect(logged).toContainEqual(expect.stringContaining(`rule=unknown-version file=${join(paths.versionsDir, 'v0099.json')}`));

    const dir = await mkdtemp(join(tmpdir(), 'state-test-'));
    try {
      await writeFile(join(dir, 'v0009.json'), JSON.stringify({ tableVersion: 'v0009' }));
      const invalid = await makeState('gw-b', { logger, paths: { ...paths, versionsDir: dir } })
        .activate({ tableVersion: 'v0009', actor: OPERATOR })
        .catch((e: unknown) => e);
      expect(invalid).toBeInstanceOf(ActivationRejected);
      const findings = (invalid as ActivationRejected).findings;
      expect(findings.map((f) => f.rule)).toEqual(['schema']);
      expect(findings[0]?.message).toMatch(/^v0009\.json does not match its cut-over schema: \/ must have required property/);
      expect(findings[0]?.message).not.toContain(dir);
      expect(logged).toContainEqual(expect.stringContaining(`rule=schema error=${join(dir, 'v0009.json')} does not match its cut-over schema`));
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
    const dir = await mkdtemp(join(tmpdir(), 'state-test-'));
    try {
      await writeFile(join(dir, 'rollback-before.json'), JSON.stringify({ status: 'pending-run', result: 'pending-run' }));
      const state = makeState('gw-a', { paths: { ...paths, reconciliationDir: dir } });

      const error = await state.activate({ tableVersion: 'v0003', actor: OPERATOR }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ActivationRejected);
      const findings = (error as ActivationRejected).findings;
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.rule === 'rollback-evidence' && f.message === 'rollback-before.json has result pending-run')).toBe(true);
      expect(await storedEpoch()).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('reads instances and both versions of the in-flight groups in keyset pages, complete and in order, and streams the status as its JSON', async () => {
    await setActive('v0001', null, 1);
    const count = 2 * STATUS_PAGE_SIZE + 1;
    await sql(
      `INSERT INTO ${handle.schema}.instance (instance_id, seen_epoch, started_at, heartbeat_at)
       SELECT 'gw-' || lpad(n::text, 4, '0'), 1, now(), now() - interval '1 hour' FROM generate_series(1, $1) AS n`,
      [count],
    );
    await sql(
      `INSERT INTO ${handle.schema}.inflight (instance_id, request_id, route, side, window_id, started_at, abandoned_at)
       SELECT 'gw-' || lpad(n::text, 4, '0'), 'r-' || s.side, $2, s.side, NULL, now(), NULL
         FROM generate_series(1, $1) AS n CROSS JOIN (VALUES ('legacy'), ('target')) AS s(side)`,
      [count, FROZEN_ROUTE],
    );
    const state = makeState('gw-live');
    await state.start();
    const live = createInflightStore({ db: handle.app, instanceId: 'gw-live', unitsOf: () => undefined });
    await live.register({ requestId: 'running', route: FROZEN_ROUTE, side: 'target' });
    await live.register({ requestId: 'abandoned', route: FROZEN_ROUTE, side: 'target' });
    await live.abandon('abandoned');
    await heartbeat('gw-live', 1);

    const status = await state.status();
    const statusV2 = await collectStatus(await state.statusV2Pages());

    expectContract('GET', '/internal/v1/cutover/status', 200, status);
    expectContract('GET', '/internal/v2/cutover/status', 200, statusV2);
    const ids = Array.from({ length: count }, (_, i) => `gw-${String(i + 1).padStart(4, '0')}`);
    expect(status.instances.map((instance) => [instance.instanceId, instance.live])).toEqual([...ids.map((id) => [id, false]), ['gw-live', true]]);
    expect(statusV2.instances).toEqual(status.instances.map((instance) => ({ ...instance, heartbeatAt: expect.any(String) })));
    const deadGroups = ids.flatMap((id) => [
      [id, 'legacy', 1],
      [id, 'target', 1],
    ]);
    // v1 groups the live instance's running and abandoned writes as one; v2 splits them by orphan state.
    expect(status.inflight.map((group) => [group.instanceId, group.side, group.count])).toEqual([...deadGroups, ['gw-live', 'target', 2]]);
    expect(status.inflight.every((group) => !('orphaned' in group))).toBe(true);
    expect(statusV2.inflight.map((group) => [group.instanceId, group.side, group.count, group.orphaned])).toEqual([
      ...deadGroups.map((group) => [...group, true]),
      ['gw-live', 'target', 1, false],
      ['gw-live', 'target', 1, true],
    ]);
    expect([status.acknowledgedEpoch, statusV2.acknowledgedEpoch]).toEqual([1, 1]);
    await heartbeat('gw-live', 1);
    let body = '';
    for await (const chunk of statusJson(await state.statusPages())) body += chunk;
    expect(JSON.parse(body)).toEqual({ ...status, instances: expect.any(Array) });
    expect((JSON.parse(body) as CutoverStatus).instances.map((instance) => instance.instanceId)).toEqual([...ids, 'gw-live']);
  }, 60_000);

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
          { error: expect.objectContaining({ type: 'Error', message: REDACTED }) },
          'cut-over state refresh failed: instance=gw-a',
        ),
      { timeout: 2000, interval: 25 },
    );
    failing = false;
    await setActive('v0002', 'v0001', 2);
    await vi.waitFor(() => expect(state.epoch()).toBe(2), { timeout: 2500, interval: 25 });
    state.stop();
  });

  it.each<[string, RegExp, number, string]>([
    ['a background refresh', /^SELECT table_version\b/, 1, 'cut-over state refresh failed: instance=gw-log'],
    ['instance pruning at start', /^DELETE FROM \S+\.instance AS g\b/, 0, 'cut-over instance pruning failed: instance=gw-log'],
  ])('hands the logger a serialized error record when %s fails, and writes no probe text', async (_label, statement, passing, message) => {
    await setActive('v0001', null, 1);
    const secret = `probe-${randomUUID()}`;
    const probes = [secret, 'password=', '10.0.0.7', 'gateway_app'];
    const thrown = new Error(`password authentication failed for user "gateway_app" with password=${secret} from 10.0.0.7`);
    const written: string[] = [];
    const destination = { write: (chunk: string) => void written.push(chunk) };
    const logger = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination });
    const logError = vi.spyOn(logger, 'error');
    const state = makeState('gw-log', { db: rejectingDb(statement, passing, thrown), logger });

    await state.start();
    await vi.waitFor(() => expect(logError).toHaveBeenCalled(), { timeout: 2000, interval: 25 });
    state.stop();

    const record = { type: 'Error', message: REDACTED, stack: expect.stringMatching(/^Error: \[REDACTED\](?:\n {4}at \S.*)+$/) };
    expect(logError.mock.calls).toStrictEqual([[{ error: record }, message]]);
    expect((logError.mock.calls[0]?.[0] as unknown as { error: unknown }).error).not.toBeInstanceOf(Error);
    const lines = written
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.message === message);
    expect(lines).toStrictEqual([expect.objectContaining({ severity: 'ERROR', message, error: record })]);
    expect(validateLogRecord(lines[0])).toStrictEqual({ valid: true, errors: [] });
    for (const text of probes) {
      expect(inspect(logError.mock.calls, { depth: null })).not.toContain(text);
      expect(written.join('')).not.toContain(text);
    }
  });

  it('runs each background refresh in a fresh unsampled trace', async () => {
    await setActive('v0001', null, 1);
    await startTracing({ serviceName: 'cutover-state-test', version: '1.0.0', exporter: new MemorySpanExporter() });
    try {
      // The active span of each refresh transaction, from the start-up one on.
      const refreshes: ReturnType<typeof activeSpanIds>[] = [];
      const db: TenantDb = {
        schema: handle.app.schema,
        withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
        withMetadata: (fn, options) => {
          refreshes.push(activeSpanIds());
          return handle.app.withMetadata(fn, options);
        },
        end: () => Promise.resolve(),
      };
      const state = makeState('gw-a', { db });
      await state.start();
      const startup = refreshes.length;
      await vi.waitFor(() => expect(refreshes.length).toBeGreaterThanOrEqual(startup + 2), { timeout: 10_000, interval: 25 });
      state.stop();
      const background = refreshes.slice(startup);

      expect(refreshes.slice(0, startup)).toStrictEqual(refreshes.slice(0, startup).map(() => undefined));
      expect(background.map((ids) => ids?.traceSampled)).toStrictEqual(background.map(() => false));
      expect(new Set(background.map((ids) => ids?.traceId)).size).toBe(background.length);
    } finally {
      await shutdownTracing();
    }
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
    // The next tick is up to one interval away; a refresh outlasting the maximum age returns stale and the loop retries at once.
    await vi.waitFor(() => expect(state.active()?.table.tableVersion).toBe('v0001'), {
      timeout: REFRESH_INTERVAL_MS + 2 * SNAPSHOT_MAX_AGE_MS,
      interval: 25,
    });
    expect(state.epoch()).toBe(epoch);
    expect(state.isFrozen(FROZEN_ROUTE)).toBe(true);
    expect(state.isFrozen('admin:carch.audit')).toBe(false);
    expect(await state.waitUnfrozen('admin:carch.audit', 600)).toBe(true);
  });

  it.each([
    ['waitUnfrozen', 'cutover_state'],
    ['awaitVisible', 'instance'],
  ] as const)('ends %s at its budget while %s is locked, and the server ends its statement', async (operation, table) => {
    // Long enough to observe the in-flight check through the shared server's I/O stalls before the budget ends it.
    const budget = 3000;
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
      await vi.waitFor(async () => expect(await running()).toBe(1), { timeout: budget - 500, interval: 20 });

      expect(await outcome).toBe(false);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(budget - 10);
      expect(elapsed).toBeLessThan(budget + 250);
      // The lock is still held, so only statement_timeout ends the backend; its exit after the cancel can stall on server I/O.
      await vi.waitFor(async () => expect(await running()).toBe(0), { timeout: 3000, interval: 10 });
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

  describe('load-time validation', () => {
    // A withheld legacy-write variant of the people roster.
    const TAMPERED_ROUTE = 'admin:cusers.update{type=2,action=delete}';
    const REFUSED = 'cut-over version refused for routing: instance=gw-a cut-over version v0003 fails validation: ';
    const dirs: string[] = [];
    let tamperedEnv: { OPT2_CUTOVER_DIR: string; OPT2_REPORTS_DIR: string };
    let tamperedPaths: GatewayPaths;
    let orphanPaths: GatewayPaths;
    // Directories whose v0003.json claims another place in the chain than the stored row gives it.
    const forgedPaths = new Map<string, GatewayPaths>();
    // The groups committed v0003 returns to legacy, in v0002's order, and their units.
    let returning: string[];
    let returningUnits: string[];

    beforeAll(async () => {
      const [v0001, v0002, v0003] = await Promise.all([committedTable('v0001'), committedTable('v0002'), committedTable('v0003')]);
      const forgeries = { 'previous null': { previous: null }, 'previous v0001': { previous: 'v0001' }, 'tableVersion v0001': { tableVersion: 'v0001' } };
      for (const [label, fields] of Object.entries(forgeries)) {
        const dir = await writeCutoverDir(v0001, { groups, extraTables: [v0002] });
        dirs.push(dir);
        const forged = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
        await writeFile(join(forged.versionsDir, 'v0003.json'), JSON.stringify({ ...v0003, ...fields }));
        forgedPaths.set(label, forged);
      }
      const tampered = {
        ...v0003,
        entries: v0003.entries.map((item) => (item.route === TAMPERED_ROUTE ? { ...item, state: 'target' as const } : item)),
      };
      // v0003's routing as a successor of the tampered version, returning no group.
      const successor = cutoverTable({
        tableVersion: 'v0004',
        previous: 'v0003',
        groupAuthority: v0003.groupAuthority,
        createdAt: v0003.createdAt,
        entries: v0003.entries,
      });
      const cutoverDir = await writeCutoverDir(v0001, { groups, extraTables: [v0002, tampered, successor] });
      const orphanDir = await writeCutoverDir(v0002, { groups });
      const reportsDir = await mkdtemp(join(tmpdir(), 'state-test-'));
      dirs.push(cutoverDir, orphanDir, reportsDir);
      orphanPaths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: orphanDir });
      returning = Object.keys(v0002.groupAuthority).filter(
        (id) => v0002.groupAuthority[id] === 'target' && v0003.groupAuthority[id] === 'legacy',
      );
      returningUnits = groups.groups.filter((group) => returning.includes(group.id)).flatMap((group) => group.units);
      await mkdir(join(reportsDir, 'reconciliation'));
      await writeFile(join(reportsDir, 'reconciliation', 'rollback-before.json'), JSON.stringify(rollbackReport(returningUnits)));
      tamperedEnv = { OPT2_CUTOVER_DIR: cutoverDir, OPT2_REPORTS_DIR: reportsDir };
      tamperedPaths = resolveGatewayPaths(tamperedEnv);
    });

    afterAll(async () => {
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it.each([
      ['v0001', null, 1],
      ['v0002', 'v0001', 2],
      ['v0003', 'v0002', 3],
    ] as const)('starts on committed %s through the rule check and routes by it', async (tableVersion, previous, epoch) => {
      await setActive(tableVersion, previous, epoch);
      const state = makeState('gw-a');

      await state.start();

      expect(state.active()?.table.tableVersion).toBe(tableVersion);
      expect(state.active()?.entryFor(FROZEN_ROUTE)).toBeDefined();
      expect((await state.readEpochForWrite()).index.table.tableVersion).toBe(tableVersion);
    });

    it.each<{
      label: string;
      active: readonly [string, string, number];
      dir: () => GatewayPaths;
      findings: object[];
      detail: string;
      /** The unreadable version file a refusal's log line names. */
      file?: string;
      check?: VersionCheck;
    }>([
      {
        label: 'a withheld legacy-write entry set to target',
        active: ['v0003', 'v0002', 3] as const,
        dir: () => tamperedPaths,
        findings: [
          { rule: 'withheld-never-target', route: TAMPERED_ROUTE, message: 'withheld entry is target' },
          { rule: 'legacy-write-always-legacy', route: TAMPERED_ROUTE, message: 'legacy-write entry is target' },
        ],
        detail: `withheld-never-target ${TAMPERED_ROUTE} withheld entry is target; legacy-write-always-legacy ${TAMPERED_ROUTE} legacy-write entry is target`,
      },
      {
        label: 'no file for its previous version',
        active: ['v0002', 'v0001', 2] as const,
        dir: () => orphanPaths,
        findings: [{ rule: 'previous-chain', message: 'previous v0001 is not available' }],
        detail: 'previous-chain - previous v0001 is not available',
      },
      ...([['previous null'], ['previous v0001'], ['previous null', acceptEveryVersion]] as Array<[string, VersionCheck?]>).map(
        ([forgery, check]) => ({
          label: `a file claiming ${forgery}${check === undefined ? '' : ' under a check that accepts every version'}`,
          active: ['v0003', 'v0002', 3] as const,
          dir: () => forgedPaths.get(forgery) as GatewayPaths,
          findings: [{ rule: 'previous-chain', message: `${forgery} is not the stored previous version v0002` }],
          detail: `previous-chain - ${forgery} is not the stored previous version v0002`,
          check,
        }),
      ),
      {
        label: 'a file claiming tableVersion v0001',
        active: ['v0003', 'v0002', 3] as const,
        dir: () => forgedPaths.get('tableVersion v0001') as GatewayPaths,
        findings: [{ rule: 'schema', message: 'v0003.json does not match its cut-over schema: /tableVersion must equal the file name v0003' }],
        detail: 'schema - v0003.json does not match its cut-over schema: /tableVersion must equal the file name v0003',
        file: 'v0003.json',
      },
    ])('refuses at start a stored version with $label, routing nothing by it and committing nothing', async ({ active, dir, findings, detail, file, check }) => {
      const [tableVersion, previous, epoch] = active;
      await setActive(tableVersion, previous, epoch);
      const logger = { info: vi.fn(), error: vi.fn() };
      const state = makeState('gw-a', { paths: dir(), logger, checkVersion: check });

      const error = await state.start().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CutoverVersionInvalid);
      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      expect((error as CutoverVersionInvalid).tableVersion).toBe(tableVersion);
      expect((error as CutoverVersionInvalid).findings).toEqual(findings);
      const message = `cut-over version ${tableVersion} fails validation: ${detail}`;
      expect((error as CutoverVersionInvalid).message).toBe(message);
      expect(state.active()).toBeUndefined();
      await expect(state.readEpochForWrite()).rejects.toBeInstanceOf(CutoverVersionInvalid);
      await expect(state.status()).rejects.toBeInstanceOf(CutoverVersionInvalid);
      await expect(state.freeze([FROZEN_ROUTE], OPERATOR)).rejects.toBeInstanceOf(CutoverVersionInvalid);
      const located = file === undefined ? '' : ` file=${join(dir().versionsDir, file)}`;
      expect(logger.error.mock.calls).toEqual([[{}, `cut-over version refused for routing: instance=gw-a ${message}${located}`]]);
      expect(await storedEpoch()).toBe(epoch);
      expect(await sql(`SELECT route FROM ${handle.schema}.cutover_freeze`)).toEqual([]);
      expect(await sql(`SELECT instance_id FROM ${handle.schema}.instance`)).toEqual([]);
    });

    it('starts on an activated v0003 after a later reconcile replaced its rollback report, which CI and activation still reject', async () => {
      const reportsDir = await mkdtemp(join(tmpdir(), 'state-test-'));
      dirs.push(reportsDir);
      await mkdir(join(reportsDir, 'reconciliation'));
      const report = join(reportsDir, 'reconciliation', 'rollback-before.json');
      await writeFile(report, JSON.stringify(rollbackReport(returningUnits)));
      const reportPaths = resolveGatewayPaths({ OPT2_REPORTS_DIR: reportsDir });
      await setActive('v0002', 'v0001', 2);
      expect(await makeState('gw-op', { paths: reportPaths }).activate({ tableVersion: 'v0003', actor: OPERATOR })).toEqual({
        tableVersion: 'v0003',
        epoch: 3,
      });

      await writeFile(report, JSON.stringify(rollbackReport(returningUnits, { tableVersion: 'v0003', tableVersionMatches: false })));
      const state = makeState('gw-a', { paths: reportPaths });
      await state.start();

      expect(state.active()?.table.tableVersion).toBe('v0003');
      expect((await state.readEpochForWrite()).index.table.tableVersion).toBe('v0003');
      for (const mode of ['--ci', '--activation']) {
        const out: string[] = [];
        const write = (line: string): void => {
          out.push(line);
        };
        expect(await validateMain([mode, '--version', 'v0003'], { paths: reportPaths, stdout: write, stderr: write })).toBe(1);
        expect(out).toEqual(returning.map((group) => `v0003 rollback-evidence ${group} rollback-before.json was taken at v0003, not v0002`));
      }
    });

    it('refuses an index it built once the stored previous version of the same active version changes', async () => {
      await setActive('v0003', 'v0002', 3);
      const state = makeState('gw-a');
      await state.start();
      expect(state.active()?.table.tableVersion).toBe('v0003');

      await setActive('v0003', 'v0001', 4);
      const error = await state.readEpochForWrite().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CutoverVersionInvalid);
      expect((error as CutoverVersionInvalid).findings).toEqual([
        { rule: 'previous-chain', message: 'previous v0002 is not the stored previous version v0001' },
      ]);
      expect(state.epoch()).toBe(3);
    });

    it('fails closed once a background refresh meets a version that fails its rules, and recovers when a valid successor is activated', async () => {
      await setActive('v0002', 'v0001', 2);
      const logger = { info: vi.fn(), error: vi.fn() };
      const state = makeState('gw-a', { paths: tamperedPaths, logger });
      const check = vi.fn<VersionCheck>(() => Promise.resolve([]));
      const operator = makeState('gw-op', { paths: tamperedPaths, checkVersion: check });
      await state.start();
      expect(state.active()?.table.tableVersion).toBe('v0002');

      await setActive('v0003', 'v0002', 3);

      await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith({}, expect.stringContaining(REFUSED)), { timeout: 2000, interval: 25 });
      await vi.waitFor(() => expect(state.active()).toBeUndefined(), { timeout: SNAPSHOT_MAX_AGE_MS, interval: 25 });
      expect(state.epoch()).toBe(2);
      expect(state.isFrozen('admin:carch.audit')).toBe(true);
      await expect(state.readEpochForWrite()).rejects.toBeInstanceOf(CutoverVersionInvalid);
      expect(logger.error.mock.calls.filter(([, msg]) => String(msg).startsWith(REFUSED))).toHaveLength(1);

      expect(await operator.activate({ tableVersion: 'v0004', actor: OPERATOR })).toEqual({ tableVersion: 'v0004', epoch: 4 });
      expect(operator.active()?.table.tableVersion).toBe('v0004');
      expect(check).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(state.active()?.table.tableVersion).toBe('v0004'), {
        timeout: REFRESH_INTERVAL_MS + SNAPSHOT_MAX_AGE_MS,
        interval: 25,
      });
      expect(state.epoch()).toBe(4);
      expect((await state.readEpochForWrite()).index.entryFor(TAMPERED_ROUTE)?.state).toBe('legacy');
    });

    it.each<{ label: string; text?: (probe: string, v0002: object) => string; finding: RegExp; rule: string }>([
      { label: 'is missing', finding: /^no version file v0002\.json$/, rule: 'unknown-version' },
      {
        label: 'is cut off inside a string',
        text: (probe) => `{"tableVersion":"v0002","previous":"v0001","createdAt":"${probe}`,
        finding: /^v0002\.json does not match its cut-over schema: \/ is not valid JSON: Unterminated string in JSON at position \d+ \(line 1 column \d+\)$/,
        rule: 'schema',
      },
      {
        label: 'fails its schema',
        text: (probe, v0002) => JSON.stringify({ ...v0002, [probe]: true }),
        finding: /^v0002\.json does not match its cut-over schema: \/ must NOT have additional properties$/,
        rule: 'schema',
      },
    ])('refuses a stored version whose file $label as the legacy 503, logging it once, and routes by it once the file is readable', async ({
      text,
      finding,
      rule,
    }) => {
      const [v0002, v0003] = await Promise.all([committedTable('v0002'), committedTable('v0003')]);
      const probe = `probe-${randomUUID()}`;
      const dir = await writeCutoverDir(await committedTable('v0001'), { groups, extraTables: [v0003] });
      dirs.push(dir);
      const unreadable = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
      const file = join(unreadable.versionsDir, 'v0002.json');
      if (text !== undefined) await writeFile(file, text(probe, v0002));
      await setActive('v0002', 'v0001', 2);
      const logger = { info: vi.fn(), error: vi.fn() };
      const state = makeState('gw-a', { paths: unreadable, logger });

      const error = await state.start().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CutoverVersionInvalid);
      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      const { tableVersion, findings, message } = error as CutoverVersionInvalid;
      expect([tableVersion, findings]).toEqual(['v0002', [{ rule, message: expect.stringMatching(finding) }]]);
      expect(message).toBe(`cut-over version v0002 fails validation: ${rule} - ${findings[0]?.message ?? ''}`);
      for (const leaked of [dir, probe]) expect(message).not.toContain(leaked);
      expect(state.active()).toBeUndefined();
      const write = await state.readEpochForWrite().catch((e: unknown) => e);
      expect(write).toBeInstanceOf(CutoverVersionInvalid);
      expect(write).toBeInstanceOf(LegacyServiceUnavailableError);
      expect((write as CutoverVersionInvalid).message).toBe(message);
      await expect(state.status()).rejects.toBeInstanceOf(CutoverVersionInvalid);
      await expect(state.freeze([FROZEN_ROUTE], OPERATOR)).rejects.toBeInstanceOf(CutoverVersionInvalid);
      // A successor is validated against the version it follows, which is unreadable here.
      const successor = await state.activate({ tableVersion: 'v0003', actor: OPERATOR }).catch((e: unknown) => e);
      expect(successor).toBeInstanceOf(ActivationRejected);
      expect((successor as ActivationRejected).findings).toEqual([{ rule: 'previous-chain', message: 'previous v0002 is not available' }]);
      expect(logger.error.mock.calls).toEqual([[{}, `cut-over version refused for routing: instance=gw-a ${message} file=${file}`]]);
      expect(await storedEpoch()).toBe(2);
      expect(await sql(`SELECT route FROM ${handle.schema}.cutover_freeze`)).toEqual([]);

      await writeFile(file, JSON.stringify(v0002));
      await state.start();

      expect(state.active()?.table.tableVersion).toBe('v0002');
      expect((await state.readEpochForWrite()).index.table.tableVersion).toBe('v0002');
      expect(await state.activate({ tableVersion: 'v0003', actor: OPERATOR })).toEqual({ tableVersion: 'v0003', epoch: 3 });
      expect(state.active()?.table.tableVersion).toBe('v0003');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('rejects start with any other read failure of the stored version as it is, logging no refusal', async () => {
      const dir = await writeCutoverDir(await committedTable('v0001'), { groups });
      dirs.push(dir);
      const unreadable = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
      await mkdir(join(unreadable.versionsDir, 'v0002.json'));
      await setActive('v0002', 'v0001', 2);
      const logger = { info: vi.fn(), error: vi.fn() };

      const error = await makeState('gw-a', { paths: unreadable, logger })
        .start()
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(LegacyServiceUnavailableError);
      expect((error as NodeJS.ErrnoException).code).toBe('EISDIR');
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('fails the gateway start-up on a stored version that fails its rules', async () => {
      await setActive('v0003', 'v0002', 3);
      await prepareTestStateDir();
      const app = await buildApp({ env: testEnv(tamperedEnv), verifierOverride: testVerifier(), db: handle.app, instanceId: 'gw-app' });
      try {
        await expect(app.ready()).rejects.toBeInstanceOf(CutoverVersionInvalid);
      } finally {
        await app.close();
        await app.opt2.client.close();
      }
    });
  });
});

describe('CutoverVersionInvalid', () => {
  it('names the version and its first three findings, counts the rest, and is the legacy 503', () => {
    const error = new CutoverVersionInvalid('v0009', [
      { rule: 'route-once', route: 'admin:a.b', message: 'appears in 2 entries' },
      { rule: 'unprevented-writer', unit: 'people.person', group: 'grp:people.person', message: 'x writes it' },
      { rule: 'group-authority', group: 'grp:people.person', message: 'group has no authority' },
      { rule: 'source-sha', message: 'sourceSha a is not the pinned b' },
      { rule: 'previous-chain', message: 'previous v0008 is not available' },
    ]);

    expect(error.message).toBe(
      'cut-over version v0009 fails validation: route-once admin:a.b appears in 2 entries; unprevented-writer people.person x writes it; ' +
        'group-authority grp:people.person group has no authority; 2 more',
    );
    expect([error.name, error.reason, error.surface, error.findings.length]).toEqual(['CutoverVersionInvalid', 'invalid-cutover-version', 'auto', 5]);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
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
