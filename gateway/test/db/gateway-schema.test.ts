// The gateway schema against PostgreSQL: its six coordination tables, the stores over them and the gateway's roles.
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@opt2/platform/logging';
import { parseWritePosition, type WritePositions } from '@opt2/platform/migration-kit';
import { createServiceClient, type Clock, type ServiceClient } from '@opt2/platform/service-kit';
import { withMetadata, type Pool } from '@opt2/platform/tenancy';
import {
  checkCatalog,
  createThrowawaySchema,
  pgAvailable,
  systemClock,
  testInvocationMinter,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  INSTANCE_LIVENESS_SECONDS,
  InflightEvidenceError,
  createInflightStore,
  type InflightStore,
  type OrphanEvidenceRecord,
} from '../../src/cutover/inflight.js';
import { buildRoutingIndex, loadGroups, loadVariants, loadVersion } from '../../src/cutover/loader.js';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import {
  ActivationRejected,
  CutoverConflict,
  INSTANCE_RETENTION_SECONDS,
  createCutoverState,
  type ActivationResult,
  type CutoverState,
} from '../../src/cutover/state.js';
import type { GroupsFile, RoutingIndex, VariantsFile } from '../../src/cutover/types.js';
import { BarrierTimeoutError, PROJECTION_AWAIT_TIMEOUT_MS, createSessionBarrier, type SessionBarrier } from '../../src/dispatcher/barrier.js';
import { createLegacyJar, type JarCookie, type JarCookies, type JarUpsert, type LegacyJar } from '../../src/session/jar.js';
import { LOGIN_ROUTE_KEY, sessionModeFor } from '../../src/session/mode.js';
import { startMigrationDouble, type MigrationDouble, type MigrationDoubleOptions } from '../helpers/migration-double.js';

const COORDINATION_TABLES = ['cutover_freeze', 'cutover_state', 'inflight', 'instance', 'legacy_jar', 'session_barrier'];
const ACTOR = 'test-operator';
const V0001 = { tableVersion: 'v0001', actor: ACTOR } as const;
const ROSTER_ADD = 'admin:cusers.update{type=2,action=add}';
const ROSTER_DELETE = 'admin:cusers.update{type=2,action=delete}';
const DEAD_AGE_SECONDS = INSTANCE_LIVENESS_SECONDS + 7;
const INSUFFICIENT_PRIVILEGE = { code: '42501' };
const PROJECTED_OWNERS: ReadonlySet<string> = new Set(['people', 'identity']);
const BEYOND_2_53 = '18446744073709551000';

const pgUp = await pgAvailable();

describe.skipIf(!pgUp)('gateway schema', () => {
  let schema: ThrowawaySchema;
  let seedRows: Record<string, unknown>[];
  let paths: GatewayPaths;
  let variants: VariantsFile;
  let groups: GroupsFile;
  let v0001: RoutingIndex;
  const clock: Clock = systemClock;
  const logger = createLogger({ service: 'gateway', version: 'test', env: 'local', level: 'silent' });

  /** `table` qualified by the quoted throwaway schema. */
  const t = (table: string): string => `"${schema.schema}".${table}`;

  /** Runs `text` as the app role in one metadata transaction and returns its rows. */
  async function q<R extends object = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<R[]> {
    const { rows } = await withMetadata(schema.app, (tx) => tx.query<R & Record<string, unknown>>(text, values));
    return rows;
  }

  /** Ordinary and partitioned tables of the schema, read from the catalog whatever the role's table privileges. */
  async function tableNames(): Promise<string[]> {
    const rows = await q<{ relname: string }>(
      `SELECT c.relname::text AS relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
      [schema.schema],
    );
    return rows.map((row) => row.relname);
  }

  async function storedEpoch(): Promise<number> {
    const [row] = await q<{ epoch: string }>(`SELECT epoch FROM ${t('cutover_state')} WHERE id = 1`);
    return Number(row?.epoch);
  }

  /** Upserts an instance row at `seenEpoch` whose heartbeat is `ageSeconds` old by the database clock. */
  async function heartbeat(instanceId: string, seenEpoch: number, ageSeconds = 0): Promise<void> {
    await q(
      `INSERT INTO ${t('instance')} (instance_id, seen_epoch, started_at, heartbeat_at)
       VALUES ($1, $2, now(), now() - make_interval(secs => $3))
       ON CONFLICT (instance_id) DO UPDATE SET seen_epoch = EXCLUDED.seen_epoch, heartbeat_at = EXCLUDED.heartbeat_at`,
      [instanceId, seenEpoch, ageSeconds],
    );
  }

  /** Polls `check` every 50 ms; resolves whether it passed before `timeoutMs`. */
  async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await sleep(50);
    }
    return false;
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({
      service: 'gateway',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    seedRows = await q(
      `SELECT id, table_version, previous_version, epoch::text AS epoch, activated_at, activated_by FROM ${t('cutover_state')}`,
    );
    paths = resolveGatewayPaths({});
    [variants, groups] = await Promise.all([loadVariants(paths), loadGroups(paths)]);
    v0001 = buildRoutingIndex(await loadVersion(paths, 'v0001'), variants, groups);
  }, 60_000);

  afterAll(async () => {
    await schema?.drop();
  });

  beforeEach(async () => {
    await withMetadata(schema.app, async (tx) => {
      await tx.query(
        `UPDATE ${t('cutover_state')} SET table_version = NULL, previous_version = NULL, epoch = 0, activated_at = NULL, activated_by = NULL WHERE id = 1`,
      );
      for (const table of COORDINATION_TABLES.filter((name) => name !== 'cutover_state')) {
        await tx.query(`DELETE FROM ${t(table)}`);
      }
    });
  });

  describe('schema shape', () => {
    it('holds exactly the six coordination tables', async () => {
      expect(await tableNames()).toEqual(COORDINATION_TABLES);
    });

    it('gives no table a tenant_id column', async () => {
      const rows = await q(
        `SELECT c.relname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND a.attname = 'tenant_id' AND NOT a.attisdropped`,
        [schema.schema],
      );
      expect(rows).toEqual([]);
    });

    it('seeds the single cut-over row at epoch 0 with no version', () => {
      expect(seedRows).toEqual([
        { id: 1, table_version: null, previous_version: null, epoch: '0', activated_at: null, activated_by: null },
      ]);
    });
  });

  describe('cut-over state', () => {
    const started: CutoverState[] = [];
    let run = 0;

    /** An instance id unique to this test, so a refresh still in flight from an earlier test never writes its row. */
    const idOf = (name: string): string => `gw-test-${name}-${run}`;

    const makeState = (instanceId: string): CutoverState => {
      const state = createCutoverState({ db: schema.app, clock, paths, instanceId, logger, variants, groups });
      started.push(state);
      return state;
    };

    async function seenEpoch(instanceId: string): Promise<number | undefined> {
      const [row] = await q<{ seen_epoch: string }>(`SELECT seen_epoch FROM ${t('instance')} WHERE instance_id = $1`, [instanceId]);
      return row === undefined ? undefined : Number(row.seen_epoch);
    }

    async function casWaiters(watch: Pool): Promise<number> {
      const { rows } = await watch.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE usename = $1 AND wait_event_type = 'Lock' AND query LIKE 'UPDATE %cutover_state%'`,
        [schema.roles.app],
      );
      return rows[0]?.waiting ?? 0;
    }

    beforeEach(() => {
      run += 1;
    });

    afterEach(() => {
      for (const state of started.splice(0)) state.stop();
    });

    it('starts from the seeded state with epoch 0 and no active version', async () => {
      const state = makeState(idOf('a'));
      await state.start();

      expect(state.epoch()).toBe(0);
      expect(state.active()).toBeUndefined();
      const status = await state.status();
      expect(status).toMatchObject({ tableVersion: null, previous: null, epoch: 0, frozen: [], sessionMode: 'legacy-primary' });
      expect(status.instances).toContainEqual(expect.objectContaining({ instanceId: idOf('a'), seenEpoch: 0, live: true }));
    });

    it('activates v0001 by compare-and-set as epoch 1 and serves its routing index', async () => {
      const state = makeState(idOf('a'));
      await state.start();

      await expect(state.activate(V0001)).resolves.toEqual({ tableVersion: 'v0001', epoch: 1 });

      const rows = await q(
        `SELECT table_version, previous_version, epoch::text AS epoch, activated_by, activated_at IS NOT NULL AS activated
           FROM ${t('cutover_state')} WHERE id = 1`,
      );
      expect(rows).toEqual([{ table_version: 'v0001', previous_version: null, epoch: '1', activated_by: ACTOR, activated: true }]);
      expect(state.epoch()).toBe(1);
      const index = state.active();
      expect(index?.table.tableVersion).toBe('v0001');
      expect(index?.entryFor(LOGIN_ROUTE_KEY)).toMatchObject({ route: LOGIN_ROUTE_KEY, owningService: 'identity', state: 'legacy', kind: 'write' });
      expect(sessionModeFor(index)).toBe('legacy-primary');
    });

    it('commits exactly one of two concurrent activations and refuses the other as a CutoverConflict', async () => {
      const racers = [makeState(idOf('a')), makeState(idOf('b'))];
      const lockPool = schema.connect('app', { max: 1 });
      const watchPool = schema.connect('app', { max: 1 });
      let outcomes: PromiseSettledResult<ActivationResult>[];
      try {
        const holder = await lockPool.connect();
        try {
          await holder.query('BEGIN');
          // The held row lock parks both compare-and-set updates, so each has read epoch 0 before either commits.
          await holder.query(`SELECT epoch FROM ${t('cutover_state')} WHERE id = 1 FOR UPDATE`);
          const racing = Promise.allSettled(racers.map((state) => state.activate(V0001)));
          const parked = await until(async () => (await casWaiters(watchPool)) === 2, 20_000);
          await holder.query('COMMIT');
          expect(parked).toBe(true);
          outcomes = await racing;
        } finally {
          holder.release();
        }
      } finally {
        await Promise.all([lockPool.end(), watchPool.end()]);
      }

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toEqual([
        { status: 'fulfilled', value: { tableVersion: 'v0001', epoch: 1 } },
      ]);
      const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(CutoverConflict);
      expect((rejected[0]?.reason as CutoverConflict).findings.map((finding) => finding.rule)).toEqual(['previous-mismatch']);
      expect(await storedEpoch()).toBe(1);
    }, 60_000);

    it('refuses v0002 while no version is active as a previous-mismatch conflict and keeps epoch 0', async () => {
      const error = await makeState(idOf('a'))
        .activate({ tableVersion: 'v0002', actor: ACTOR })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CutoverConflict);
      expect((error as CutoverConflict).findings.map((finding) => finding.rule)).toEqual(['previous-mismatch']);
      expect(await storedEpoch()).toBe(0);
      expect(await q(`SELECT table_version FROM ${t('cutover_state')}`)).toEqual([{ table_version: null }]);
    });

    it('freezes and unfreezes a route with one epoch each and leaves its routing unchanged', async () => {
      const state = makeState(idOf('a'));
      await state.start();
      await state.activate(V0001);
      const before = state.active()?.entryFor(LOGIN_ROUTE_KEY);

      const frozen = await state.freeze([LOGIN_ROUTE_KEY], ACTOR);

      expect(frozen).toMatchObject({ tableVersion: 'v0001', epoch: 2, frozen: [LOGIN_ROUTE_KEY] });
      expect(
        await q(`SELECT route, epoch::text AS epoch, frozen_by, frozen_at IS NOT NULL AS stamped FROM ${t('cutover_freeze')}`),
      ).toEqual([{ route: LOGIN_ROUTE_KEY, epoch: '2', frozen_by: ACTOR, stamped: true }]);
      expect(state.epoch()).toBe(2);
      expect(state.isFrozen(LOGIN_ROUTE_KEY)).toBe(true);
      const during = state.active()?.entryFor(LOGIN_ROUTE_KEY);
      expect(during).toBeDefined();
      expect({ state: during?.state, owningService: during?.owningService }).toEqual({
        state: before?.state,
        owningService: before?.owningService,
      });

      const thawed = await state.unfreeze([LOGIN_ROUTE_KEY], ACTOR);

      expect(thawed).toMatchObject({ tableVersion: 'v0001', epoch: 3, frozen: [] });
      expect(await q(`SELECT route FROM ${t('cutover_freeze')}`)).toEqual([]);
      expect(await storedEpoch()).toBe(3);
      expect(state.isFrozen(LOGIN_ROUTE_KEY)).toBe(false);
    });

    it('refuses to freeze a route the active version lacks and rolls back its epoch increment', async () => {
      const state = makeState(idOf('a'));
      await state.activate(V0001);

      const error = await state.freeze(['admin:opt2.nosuchaction'], ACTOR).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ActivationRejected);
      expect((error as ActivationRejected).findings.map((finding) => finding.rule)).toEqual(['unknown-route']);
      expect(await storedEpoch()).toBe(1);
      expect(await q(`SELECT route FROM ${t('cutover_freeze')}`)).toEqual([]);
    });

    it('heartbeats the epoch it has seen and follows a newer epoch through its refresh loop', async () => {
      const follower = makeState(idOf('a'));
      await follower.start();
      expect(
        await q(
          `SELECT seen_epoch::text AS seen_epoch, heartbeat_at >= now() - make_interval(secs => $2) AS fresh
             FROM ${t('instance')} WHERE instance_id = $1`,
          [idOf('a'), INSTANCE_LIVENESS_SECONDS],
        ),
      ).toEqual([{ seen_epoch: '0', fresh: true }]);

      await makeState(idOf('b')).activate(V0001);

      await expect.poll(() => seenEpoch(idOf('a')), { timeout: 10_000, interval: 100 }).toBe(1);
      expect(follower.epoch()).toBe(1);
    }, 20_000);

    it('reports an epoch visible only once every live instance has seen it', async () => {
      const state = makeState(idOf('a'));
      await state.start();
      await state.activate(V0001);
      await heartbeat('gw-ghost', 0);

      await expect(state.awaitVisible(1, 500)).resolves.toBe(false);

      await heartbeat('gw-ghost', 1);
      await expect(state.awaitVisible(1, 10_000)).resolves.toBe(true);
    }, 20_000);

    it('does not wait for an instance whose heartbeat is older than the liveness window', async () => {
      const state = makeState(idOf('a'));
      await state.start();
      await state.activate(V0001);
      await heartbeat('gw-ghost', 0, DEAD_AGE_SECONDS);

      await expect(state.awaitVisible(1, 5_000)).resolves.toBe(true);
    }, 20_000);
  });

  describe('in-flight writes', () => {
    const store = (instanceId: string): InflightStore =>
      createInflightStore({ db: schema.app, instanceId, unitsOf: (route) => v0001.entryFor(route)?.units });

    async function inflightKeys(): Promise<string[]> {
      const rows = await q<{ key: string }>(
        `SELECT instance_id || '/' || request_id AS key FROM ${t('inflight')} ORDER BY instance_id, request_id`,
      );
      return rows.map((row) => row.key);
    }

    /** Evidence time strictly after every row registered so far. */
    async function evidenceTime(): Promise<string> {
      await sleep(50);
      return new Date().toISOString();
    }

    const rosterUnits = (): string[] => v0001.entryFor(ROSTER_ADD)?.units ?? [];

    it('registers a forwarded write with its instance, route and side, lists it and removes it', async () => {
      const a = store('gw-a');
      await a.register({ requestId: 'r1', route: ROSTER_ADD, side: 'target' });
      await a.register({ requestId: 'r2', route: LOGIN_ROUTE_KEY, side: 'legacy', windowId: 'win-0001' });

      expect(
        await q(
          `SELECT instance_id, request_id, route, side, window_id, started_at IS NOT NULL AS started
             FROM ${t('inflight')} ORDER BY request_id`,
        ),
      ).toEqual([
        { instance_id: 'gw-a', request_id: 'r1', route: ROSTER_ADD, side: 'target', window_id: null, started: true },
        { instance_id: 'gw-a', request_id: 'r2', route: LOGIN_ROUTE_KEY, side: 'legacy', window_id: 'win-0001', started: true },
      ]);
      const [listed] = await a.list({ side: 'target' });
      expect(listed).toMatchObject({ instanceId: 'gw-a', requestId: 'r1', route: ROSTER_ADD, side: 'target', windowId: null });
      expect(listed?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      expect((await a.list({ routes: [ROSTER_ADD] })).map((row) => row.requestId)).toEqual(['r1']);
      expect(await a.list({ instanceIds: ['gw-other'] })).toEqual([]);

      await expect(a.remove('r1')).resolves.toBe(true);
      await expect(a.remove('r1')).resolves.toBe(false);
      expect(await inflightKeys()).toEqual(['gw-a/r2']);
    });

    it("leaves another instance's row in place when that instance removes the same request id", async () => {
      await store('gw-a').register({ requestId: 'r1', route: ROSTER_ADD, side: 'target' });

      await expect(store('gw-b').remove('r1')).resolves.toBe(false);

      expect(await inflightKeys()).toEqual(['gw-a/r1']);
    });

    it('clears orphaned writes only with evidence matching their side, and only those of dead instances', async () => {
      await heartbeat('gw-dead', 0, DEAD_AGE_SECONDS);
      for (const instanceId of ['gw-dead', 'gw-live']) {
        await store(instanceId).register({ requestId: 'legacy-1', route: ROSTER_DELETE, side: 'legacy' });
        await store(instanceId).register({ requestId: 'target-1', route: ROSTER_ADD, side: 'target' });
      }
      const at = await evidenceTime();
      const restart: OrphanEvidenceRecord = { kind: 'legacy-restart', holderId: 'transition-1', at };
      const gates: OrphanEvidenceRecord = { kind: 'gates-closed', holderId: 'transition-1', at, units: rosterUnits() };
      const partialGates: OrphanEvidenceRecord = { ...gates, units: ['people.person'] };
      const caller = store('gw-live');
      const all = ['gw-dead/legacy-1', 'gw-dead/target-1', 'gw-live/legacy-1', 'gw-live/target-1'];

      await heartbeat('gw-live', 0);
      await expect(caller.clearOrphans({ side: 'legacy', evidence: gates })).rejects.toBeInstanceOf(InflightEvidenceError);
      await expect(caller.clearOrphans({ side: 'target', evidence: restart })).rejects.toBeInstanceOf(InflightEvidenceError);
      await expect(caller.clearOrphans({ side: 'target', evidence: partialGates })).resolves.toEqual({ cleared: 0, rows: [] });
      expect(await inflightKeys()).toEqual(all);

      await heartbeat('gw-live', 0);
      const legacy = await caller.clearOrphans({ side: 'legacy', evidence: restart });
      expect(legacy.cleared).toBe(1);
      expect(legacy.rows).toEqual([expect.objectContaining({ instanceId: 'gw-dead', requestId: 'legacy-1', side: 'legacy' })]);

      await heartbeat('gw-live', 0);
      const target = await caller.clearOrphans({ side: 'target', evidence: gates });
      expect(target.cleared).toBe(1);
      expect(target.rows).toEqual([expect.objectContaining({ instanceId: 'gw-dead', requestId: 'target-1', side: 'target' })]);

      expect(await inflightKeys()).toEqual(['gw-live/legacy-1', 'gw-live/target-1']);
    });

    it("keeps a dead instance's rows, and its instance row, while instance pruning and heartbeats run", async () => {
      const longGone = INSTANCE_RETENTION_SECONDS + 60;
      await heartbeat('gw-dead', 0, longGone);
      await heartbeat('gw-gone', 0, longGone);
      await store('gw-dead').register({ requestId: 'r1', route: ROSTER_ADD, side: 'target' });
      const state = createCutoverState({ db: schema.app, clock, paths, instanceId: 'gw-pruner', logger, variants, groups });
      try {
        await state.start();
        const instances = await q<{ instance_id: string }>(`SELECT instance_id FROM ${t('instance')} ORDER BY instance_id`);
        expect(instances.map((row) => row.instance_id)).toEqual(['gw-dead', 'gw-pruner']);
      } finally {
        state.stop();
      }
      expect(await inflightKeys()).toEqual(['gw-dead/r1']);
    });

    it('clears orphans only within the given instance ids and routes', async () => {
      await heartbeat('gw-dead-1', 0, DEAD_AGE_SECONDS);
      await heartbeat('gw-dead-2', 0, DEAD_AGE_SECONDS);
      await store('gw-dead-1').register({ requestId: 'r1', route: ROSTER_DELETE, side: 'legacy' });
      await store('gw-dead-1').register({ requestId: 'r2', route: LOGIN_ROUTE_KEY, side: 'legacy' });
      await store('gw-dead-2').register({ requestId: 'r1', route: ROSTER_DELETE, side: 'legacy' });
      const evidence: OrphanEvidenceRecord = { kind: 'legacy-restart', holderId: 'restart-1', at: await evidenceTime() };
      const caller = store('gw-caller');

      const byInstance = await caller.clearOrphans({ side: 'legacy', evidence, instanceIds: ['gw-dead-2'] });
      expect(byInstance.rows.map((row) => `${row.instanceId}/${row.requestId}`)).toEqual(['gw-dead-2/r1']);

      const byRoute = await caller.clearOrphans({ side: 'legacy', evidence, routes: [LOGIN_ROUTE_KEY] });
      expect(byRoute.rows.map((row) => `${row.instanceId}/${row.requestId}`)).toEqual(['gw-dead-1/r2']);

      expect(await inflightKeys()).toEqual(['gw-dead-1/r1']);
    });
  });

  describe('legacy cookie jar', () => {
    const CFID: JarCookie = { name: 'CFID', value: '1001', attributes: ' Path=/; HttpOnly; SameSite=Lax' };
    const CFTOKEN: JarCookie = { name: 'CFTOKEN', value: '12345678', attributes: ' Path=/; HttpOnly; SameSite=Lax' };
    const JSESSIONID: JarCookie = { name: 'JSESSIONID', value: 'node01opt2test', attributes: ' Path=/; Secure; HttpOnly; SameSite=Lax' };
    const COOKIES: JarCookies = { CFID, CFTOKEN, JSESSIONID };
    const S1: JarUpsert = { sessionId: 's1', legacySessionId: 'L1', cookies: COOKIES, mode: 'target-primary', hydratedEpoch: 0 };
    let jar: LegacyJar;

    async function jarCount(): Promise<number> {
      const [row] = await q<{ count: number }>(`SELECT count(*)::int AS count FROM ${t('legacy_jar')}`);
      return row?.count ?? 0;
    }

    beforeEach(() => {
      jar = createLegacyJar(schema.app);
    });

    it('stores a jar and reads back its cookies byte for byte', async () => {
      const written = await jar.upsert(S1);

      const read = await jar.get('s1');
      expect(read).toEqual(written);
      expect(read).toMatchObject({ sessionId: 's1', legacySessionId: 'L1', mode: 'target-primary', hydratedEpoch: 0 });
      expect(read?.cookies).toStrictEqual(COOKIES);
      expect(read?.updatedAt).toBeInstanceOf(Date);
      await expect(jar.get('missing')).resolves.toBeUndefined();
    });

    it('replaces the columns and cookie values on a repeated upsert and keeps cookies it was not given', async () => {
      await jar.upsert(S1);
      const renewed: JarCookies = {
        CFID: { ...CFID, value: '1002' },
        CFTOKEN: { ...CFTOKEN, value: '87654321' },
        JSESSIONID: { ...JSESSIONID, value: 'node02opt2test' },
      };

      const replaced = await jar.upsert({ ...S1, cookies: renewed, mode: 'legacy-primary', hydratedEpoch: 2 });
      expect(replaced).toMatchObject({ cookies: renewed, mode: 'legacy-primary', hydratedEpoch: 2 });
      expect(await jarCount()).toBe(1);

      const cfid: JarCookie = { ...CFID, value: '1003' };
      const merged = await jar.upsert({ ...S1, cookies: { CFID: cfid }, mode: 'legacy-primary', hydratedEpoch: 2 });
      expect(merged.cookies).toStrictEqual({ ...renewed, CFID: cfid });
      expect(await jarCount()).toBe(1);
    });

    it('finds a jar by its ColdFusion session id', async () => {
      const written = await jar.upsert(S1);

      await expect(jar.findByLegacySessionId('L1')).resolves.toEqual(written);
      await expect(jar.findByLegacySessionId('L-unknown')).resolves.toBeUndefined();
    });

    it('refuses a second session holding the same ColdFusion session id and allows any number without one', async () => {
      const written = await jar.upsert(S1);

      await expect(jar.upsert({ ...S1, sessionId: 's2' })).rejects.toMatchObject({
        code: '23505',
        constraint: 'legacy_jar_legacy_session_uidx',
      });
      await expect(jar.get('s1')).resolves.toEqual(written);
      await expect(jar.get('s2')).resolves.toBeUndefined();

      await jar.upsert({ ...S1, sessionId: 's3', legacySessionId: null });
      await jar.upsert({ ...S1, sessionId: 's4', legacySessionId: null });
      expect(await q(`SELECT session_id FROM ${t('legacy_jar')} WHERE legacy_session_id IS NULL ORDER BY session_id`)).toEqual([
        { session_id: 's3' },
        { session_id: 's4' },
      ]);
    });

    it('records the hydrated epoch and advances updated_at', async () => {
      const written = await jar.upsert(S1);
      await sleep(20);

      await expect(jar.setHydratedEpoch('s1', 7)).resolves.toBe(true);

      const read = await jar.get('s1');
      expect(read?.hydratedEpoch).toBe(7);
      expect(read?.updatedAt.getTime()).toBeGreaterThan(written.updatedAt.getTime());
      await expect(jar.setHydratedEpoch('missing', 7)).resolves.toBe(false);
    });

    it('drops a jar so neither lookup finds it, and dropping an absent jar is harmless', async () => {
      await jar.upsert(S1);

      await expect(jar.drop('s1')).resolves.toBe(true);

      await expect(jar.get('s1')).resolves.toBeUndefined();
      await expect(jar.findByLegacySessionId('L1')).resolves.toBeUndefined();
      await expect(jar.drop('s1')).resolves.toBe(false);
    });
  });

  describe('session barrier', () => {
    const closers: Array<() => Promise<void>> = [];

    /** A barrier over the throwaway schema whose projection awaits reach a fresh migration double. */
    async function connectBarrier(opts?: MigrationDoubleOptions): Promise<{ double: MigrationDouble; barrier: SessionBarrier }> {
      const double = await startMigrationDouble(opts);
      closers.push(() => double.close());
      const client: ServiceClient = createServiceClient({
        serviceUrls: { migration: double.url },
        self: 'gateway',
        credentials: testInvocationMinter({ caller: 'gateway' }),
      });
      closers.push(() => client.close());
      return { double, barrier: createSessionBarrier({ db: schema.app, client, projectedOwners: () => PROJECTED_OWNERS }) };
    }

    async function barrierRows(): Promise<Array<{ session_id: string; owner: string; xid: string | null }>> {
      return q(`SELECT session_id, owner, xid::text AS xid FROM ${t('session_barrier')} ORDER BY session_id, owner`);
    }

    afterEach(async () => {
      for (const close of closers.splice(0).reverse()) await close();
    });

    it('keeps the higher xid per owner, compared as numbers beyond 2^53, and stores no unprojected owner', async () => {
      const { barrier } = await connectBarrier();
      const first: WritePositions = parseWritePosition('people=1000,identity=5');

      await barrier.record('s1', first);
      await barrier.record('s1', parseWritePosition('people=900'));
      await barrier.record('s1', parseWritePosition(`identity=${BEYOND_2_53}`));
      await barrier.record('s1', parseWritePosition('content=42'));
      await barrier.record('s2', parseWritePosition('people=7'));

      expect(await barrierRows()).toEqual([
        { session_id: 's1', owner: 'identity', xid: BEYOND_2_53 },
        { session_id: 's1', owner: 'people', xid: '1000' },
        { session_id: 's2', owner: 'people', xid: '7' },
      ]);
    });

    it('drops only the positions migration confirmed and keeps one raised while the await was pending', async () => {
      const { double, barrier } = await connectBarrier();
      await barrier.record('s1', parseWritePosition('people=1000,identity=5'));
      await barrier.record('s2', parseWritePosition('people=3'));
      // A horizon below every position holds the await open until both owners are applied.
      double.applied('people', '0');

      const awaiting = barrier.awaitForSession('s1');
      await expect.poll(() => double.awaits.length, { timeout: 5_000, interval: 20 }).toBe(1);
      await barrier.record('s1', parseWritePosition(`identity=${BEYOND_2_53}`));
      double.applied('people', '1001');
      double.applied('identity', '6');
      await awaiting;

      expect(double.awaits.map((call) => call.body)).toEqual([
        { positions: { people: '1000', identity: '5' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
      ]);
      expect(await barrierRows()).toEqual([
        { session_id: 's1', owner: 'identity', xid: BEYOND_2_53 },
        { session_id: 's2', owner: 'people', xid: '3' },
      ]);
    });

    it('keeps every position and raises BarrierTimeoutError when migration confirms only some of them', async () => {
      const { double, barrier } = await connectBarrier({ neverAnswerAfterMs: 200 });
      await barrier.record('s1', parseWritePosition('people=1000,identity=5'));
      double.applied('people', '1001');

      await expect(barrier.awaitForSession('s1')).rejects.toBeInstanceOf(BarrierTimeoutError);

      expect(double.awaits).toHaveLength(1);
      expect(await barrierRows()).toEqual([
        { session_id: 's1', owner: 'identity', xid: '5' },
        { session_id: 's1', owner: 'people', xid: '1000' },
      ]);
    });
  });

  describe('gateway roles', () => {
    const roleNames = (): string[] => [schema.roles.owner, schema.roles.app, schema.roles.migrator];

    it('creates the owner, app and migrator roles without SUPERUSER or BYPASSRLS, and the owner without LOGIN', async () => {
      const rows = await q<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
        'SELECT rolname::text AS rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])',
        [roleNames()],
      );

      expect(rows.map((row) => row.rolname).sort()).toEqual(roleNames().sort());
      expect(rows.filter((row) => row.rolsuper || row.rolbypassrls)).toEqual([]);
      expect(rows.find((row) => row.rolname === schema.roles.owner)?.rolcanlogin).toBe(false);
    });

    it('gives no gateway role a SUPERUSER or BYPASSRLS ancestor', async () => {
      const rows = await q<{ member: string; ancestor: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `WITH RECURSIVE ancestry(member, ancestor) AS (
           SELECT r.rolname::text, m.roleid FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid WHERE r.rolname = ANY($1::text[])
           UNION
           SELECT a.member, m.roleid FROM ancestry a JOIN pg_auth_members m ON m.member = a.ancestor
         )
         SELECT DISTINCT a.member, g.rolname::text AS ancestor, g.rolsuper, g.rolbypassrls
           FROM ancestry a JOIN pg_roles g ON g.oid = a.ancestor ORDER BY 1, 2`,
        [roleNames()],
      );

      expect(rows.filter((row) => row.rolsuper || row.rolbypassrls)).toEqual([]);
      expect(rows).toEqual([{ member: schema.roles.migrator, ancestor: schema.roles.owner, rolsuper: false, rolbypassrls: false }]);
    });

    it('reports no role finding, and table findings only on the coordination tables, which hold no tenant data', async () => {
      const findings = await checkCatalog(schema, { roles: roleNames() });

      expect(findings.filter((finding) => finding.kind.startsWith('role-'))).toEqual([]);
      // checkCatalog expects RLS on every table outside the platform's non-tenant list; the gateway schema carries none by design.
      const coordination = new Set(COORDINATION_TABLES.map((table) => `${schema.schema}.${table}`));
      expect(findings.filter((finding) => !finding.kind.startsWith('role-') && !coordination.has(finding.object))).toEqual([]);
    });

    it.each([
      ['create a table', (s: string) => `CREATE TABLE ${s}.opt2_probe (x int)`],
      ['alter cutover_state', (s: string) => `ALTER TABLE ${s}.cutover_state ADD COLUMN probe int`],
      ['drop inflight', (s: string) => `DROP TABLE ${s}.inflight`],
    ])('refuses the app role permission to %s', async (_label, sql) => {
      await expect(schema.appPool.query(sql(`"${schema.schema}"`))).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
    });

    it('keeps the app role out of the owner role and leaves every table in place', async () => {
      expect(
        await q("SELECT pg_has_role($1::name, $2::name, 'MEMBER') AS member", [schema.roles.app, schema.roles.owner]),
      ).toEqual([{ member: false }]);
      const pool = schema.connect('app', { max: 1 });
      try {
        await expect(pool.query(`SET ROLE "${schema.roles.owner}"`)).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
      } finally {
        await pool.end();
      }
      expect(await tableNames()).toEqual(COORDINATION_TABLES);
    });
  });
});
