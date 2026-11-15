// Read-after-write barrier: awaitProjection against a real owner changelog and the projector's legacy checkpoints, and its route on the migration app.
import { readFileSync } from 'node:fs';

import { LegacyServiceUnavailableError, apiUnavailableResponse, legacyErrorResponse } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER, isApplied, parseWritePosition, type RepositoryRow } from '@opt2/platform/migration-kit';
import { ROLE_SET, TENANT_A, assertResponseMatchesOpenApi, authHeadersFor, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { ResolvedPaths } from '../src/config.js';
import { upsertCheckpoint } from '../src/reverse/apply-legacy.js';
import {
  CHECKPOINT_TABLE,
  ProjectionTimeoutError,
  createProjector,
  readCheckpoints,
  type AwaitProjectionResult,
  type CheckpointRow,
  type Projector,
  type StartupGuardRunner,
} from '../src/reverse/index.js';
import { buildApp } from '../src/server.js';

import { buildTestContext, type TestContext } from './helpers/context.js';
import type { MutableClock } from './helpers/env.js';
import { createFakeLegacyDb, type FakeLegacyDb, type Row } from './helpers/fake-legacy-db.js';
import {
  FIXTURE_GROUP_IDS,
  TABLES,
  TIMAGESIZES_MAPPING,
  V0001,
  VB,
  defineFixtureTables,
  fixtureVersion,
  imageSizeRow,
  siteRow,
  type FixtureTableName,
} from './helpers/fixtures.js';
import { PG_AVAILABLE, PG_OWNER_ROWS_PATH, PG_SKIP_REASON, startPgOwner, type PgOwner } from './helpers/pg-owner.js';

// buildApp reads the committed cut-over directory and ownership file, where no programs-sites unit is target-authoritative;
// the route suite points the app's configuration at its fixture world while the app is built, and nothing else is overridden.
const configPaths = vi.hoisted(() => ({ current: undefined as Partial<ResolvedPaths> | undefined }));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  const loadConfig: typeof actual.loadConfig = (opts) => {
    const config = actual.loadConfig(opts);
    const paths = configPaths.current;
    return paths === undefined ? config : { ...config, paths: { ...config.paths, ...paths } };
  };
  return { ...actual, loadConfig };
});

const OWNER = 'programs-sites';
const TARGET_TABLE = 'image_size';
const AWAIT_PATH = '/internal/v1/projection/await';
const SYNC_SQL = readFileSync(new URL('../sql/005_opt2_sync.sql', import.meta.url), 'utf8');
const OPENAPI = parse(readFileSync(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

/** The programs-sites group (`image_size`, `site`) `target`-authoritative, every other group `legacy`. */
const PROGRAMS_SITES_TARGET = fixtureVersion('v0201', { [FIXTURE_GROUP_IDS.programsSites]: 'target' });

/** No batch of these suites touches `tcontent`, so the guard is never entered; were it, it would commit directly. */
const DIRECT_COMMIT: StartupGuardRunner = { run: (commit) => commit() };

/** Short budgets the awaiter must exhaust in real time; well under a second. */
const SHORT_BUDGET_MS = 300;

/** Projector cycles driven until a write is projected; foreign transactions on a shared cluster can hold the horizon a few cycles. */
const MAX_CYCLES = 100;

const ROW_HELD = imageSizeRow({ name: 'held-open' });
const ROW_NEWER = imageSizeRow({ name: 'newer-commit' });
const ROW_DELAYED = imageSizeRow({ name: 'delayed-batch' });

/** A clock on real time: the awaiter measures its budget with the context clock and sleeps on real timers. */
function realTimeClock(): MutableClock {
  let offsetMs = 0;
  return {
    now: () => new Date(Date.now() + offsetMs),
    advance(ms) {
      offsetMs += ms;
    },
    set(date) {
      offsetMs = new Date(date).getTime() - Date.now();
    },
  };
}

/** A legacy database holding `tables`, the `tenant-a` site and the checkpoint table the shipped batch creates. */
async function legacyDb(tables: readonly FixtureTableName[]): Promise<FakeLegacyDb> {
  const legacy = createFakeLegacyDb();
  defineFixtureTables(legacy, tables);
  legacy.seed(TABLES.tsettings.qualified, [siteRow(TENANT_A.siteId)]);
  await (await legacy.live()).request().batch(SYNC_SQL);
  legacy.clearLogs();
  return legacy;
}

/** A legacy `timagesizes` row in the owner's target column names. */
function targetRow(row: Row): RepositoryRow {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column.toLowerCase(), value]));
}

function legacySizeIds(legacy: FakeLegacyDb): unknown[] {
  return legacy.rows(TABLES.timagesizes.qualified).map((row) => row.sizeID);
}

/** Stand-alone checkpoint reads sent to legacy, as the awaiter polls them. */
function checkpointReads(legacy: FakeLegacyDb): number {
  return legacy.statements.filter((statement) => statement.sql.startsWith('SELECT owner, tenant_id,') && statement.sql.includes(CHECKPOINT_TABLE))
    .length;
}

async function tenantCheckpoint(legacy: FakeLegacyDb, owner: string = OWNER): Promise<CheckpointRow | undefined> {
  const rows = await readCheckpoints(await legacy.live(), { owners: [owner] });
  return rows.find((row) => row.tenantId.toLowerCase() === TENANT_A.tenantId);
}

/** Commits a `tenant-a` checkpoint of `owner` through the projector's own upsert, whose applied horizon only moves forward. */
async function storeCheckpoint(legacy: FakeLegacyDb, owner: string, appliedHorizon: string): Promise<void> {
  await upsertCheckpoint(await legacy.live(), {
    owner,
    tenantId: TENANT_A.tenantId,
    cursorXid: '0',
    cursorSeq: '0',
    appliedHorizon,
    batchId: `seeded-${appliedHorizon}`,
    rowsApplied: 0,
    pendingEffects: [],
  });
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Holds the projector's `beforeBatch` hook while closed, standing for a delayed projector. */
function createBatchGate() {
  let release: () => void = () => undefined;
  let passage = Promise.resolve();
  let onArrival: (() => void) | undefined;
  return {
    close(): void {
      passage = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open(): void {
      release();
      passage = Promise.resolve();
    },
    /** Resolves when the next batch reaches the gate. */
    nextArrival(): Promise<void> {
      return new Promise<void>((resolve) => {
        onArrival = resolve;
      });
    },
    beforeBatch(): Promise<void> {
      onArrival?.();
      onArrival = undefined;
      return passage;
    },
  };
}

/** An await whose settlement is observable, with legacy state captured at the moment it resolved. */
function track(promise: Promise<AwaitProjectionResult>, legacy: FakeLegacyDb) {
  const tracked = {
    state: 'pending' as 'pending' | 'resolved' | 'rejected',
    atResolution: undefined as { commits: number; sizeIds: unknown[] } | undefined,
    result: promise.then(
      (result) => {
        tracked.state = 'resolved';
        tracked.atResolution = { commits: legacy.commits.length, sizeIds: legacySizeIds(legacy) };
        return result;
      },
      (error: unknown) => {
        tracked.state = 'rejected';
        throw error;
      },
    ),
  };
  // Awaited by the test; a failure before that point must not surface as an unhandled rejection.
  tracked.result.catch(() => undefined);
  return tracked;
}

describe.skipIf(!PG_AVAILABLE)(`awaitProjection over a PostgreSQL owner and the reverse projector${PG_AVAILABLE ? '' : ` (${PG_SKIP_REASON})`}`, () => {
  const gate = createBatchGate();
  let owner: PgOwner;
  let tc: TestContext;
  let projector: Projector;

  /** Runs projector cycles until the tenant checkpoint has passed `xid`, and returns that checkpoint. */
  async function cycleUntilProjected(xid: string): Promise<CheckpointRow> {
    let checkpoint: CheckpointRow | undefined;
    for (let cycle = 1; cycle <= MAX_CYCLES; cycle += 1) {
      const result = await projector.runOnce();
      expect(result.errors).toEqual([]);
      checkpoint = await tenantCheckpoint(tc.legacy);
      if (checkpoint !== undefined && isApplied(xid, checkpoint.appliedHorizon)) return checkpoint;
    }
    throw new Error(`Position ${xid} not projected after ${String(MAX_CYCLES)} cycles; applied horizon ${checkpoint?.appliedHorizon ?? 'none'}`);
  }

  function rowsUrl(): string {
    return `${owner.url}${PG_OWNER_ROWS_PATH}/${TARGET_TABLE}?tenantId=${TENANT_A.tenantId}`;
  }

  beforeAll(async () => {
    owner = await startPgOwner({ owner: OWNER, mappings: [TIMAGESIZES_MAPPING], tenants: [TENANT_A] });
    await owner.openGates();
    tc = await buildTestContext({
      legacy: await legacyDb(['tsettings', 'timagesizes']),
      owners: owner.ownersClient,
      gateway: { active: PROGRAMS_SITES_TARGET.tableVersion },
      cutover: { versions: [V0001, PROGRAMS_SITES_TARGET] },
      migrationDb: true,
      bridge: false,
      clock: realTimeClock(),
    });
    projector = createProjector(tc.ctx, { hooks: { beforeBatch: () => gate.beforeBatch() }, startupGuard: DIRECT_COMMIT });
  });

  afterAll(async () => {
    gate.open();
    await projector?.stop();
    await tc?.close();
    await owner?.close();
  });

  it('does not resolve while an older transaction is open, and resolves only after the newer write is committed in legacy', async () => {
    const held = await owner.openTransaction();
    await held.write(TARGET_TABLE, targetRow(ROW_HELD));

    const response = await fetch(rowsUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(targetRow(ROW_NEWER)),
    });
    expect(response.status).toBe(200);
    const written = parseWritePosition(response.headers.get(WRITE_POSITION_HEADER) ?? undefined);
    const newerXid = written.get(OWNER);
    if (newerXid === undefined) throw new Error(`The owner's write answered no ${WRITE_POSITION_HEADER} for ${OWNER}`);
    expect([...written.keys()]).toEqual([OWNER]);
    expect(BigInt(newerXid)).toBeGreaterThan(BigInt(held.xid));

    const positions = new Map([[OWNER, newerXid]]);
    const awaited = track(projector.awaitProjection({ positions, timeoutMs: 10_000 }), tc.legacy);

    await expect(projector.runOnce()).resolves.toMatchObject({ leader: true, ran: true, errors: [] });
    const behind = await tenantCheckpoint(tc.legacy);
    expect(behind).toBeDefined();
    expect(BigInt(behind?.appliedHorizon ?? '0')).toBeLessThanOrEqual(BigInt(held.xid));
    expect(legacySizeIds(tc.legacy)).not.toContain(ROW_NEWER.sizeID);
    expect(legacySizeIds(tc.legacy)).not.toContain(ROW_HELD.sizeID);
    // A fresh await polls the checkpoint the cycle committed and finds the newer write still behind it.
    const pollAfterCycle = await rejectionOf(projector.awaitProjection({ positions, timeoutMs: SHORT_BUDGET_MS }));
    expect(pollAfterCycle).toBeInstanceOf(ProjectionTimeoutError);
    expect(pollAfterCycle).toMatchObject({ pending: [{ owner: OWNER, xid: newerXid, tenantsBehind: [TENANT_A.tenantId] }] });
    expect(awaited.state).toBe('pending');

    await held.commit();
    const applied = await cycleUntilProjected(newerXid);
    expect(BigInt(applied.appliedHorizon)).toBeGreaterThan(BigInt(newerXid));
    expect(legacySizeIds(tc.legacy)).toEqual(expect.arrayContaining([ROW_HELD.sizeID, ROW_NEWER.sizeID]));

    const result = await awaited.result;
    expect(result.positions).toEqual(positions);
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
    const newerCommit = tc.legacy.commits.findIndex((commit) =>
      commit.statements.some((statement) => /timagesizes/i.test(statement.sql) && JSON.stringify(statement.params).includes(String(ROW_NEWER.sizeID))),
    );
    expect(newerCommit).toBeGreaterThanOrEqual(0);
    expect(awaited.atResolution?.commits).toBeGreaterThan(newerCommit);
    expect(awaited.atResolution?.sizeIds).toContain(ROW_NEWER.sizeID);
  });

  it('times out with the legacy-shaped unavailable error while the projector is delayed, then resolves once it is released', async () => {
    gate.close();
    const delayed = await owner.write((tx, repo) => repo.upsert(tx, TARGET_TABLE, targetRow(ROW_DELAYED)));
    const positions = new Map([[OWNER, delayed.xid]]);
    const arrived = gate.nextArrival();
    const cycle = projector.runOnce();
    await arrived;

    const timedOut = await rejectionOf(projector.awaitProjection({ positions, timeoutMs: SHORT_BUDGET_MS }));
    expect(timedOut).toBeInstanceOf(ProjectionTimeoutError);
    expect(timedOut).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(timedOut).toMatchObject({ timeoutMs: SHORT_BUDGET_MS, pending: [{ owner: OWNER, xid: delayed.xid, tenantsBehind: [TENANT_A.tenantId] }] });
    expect(legacySizeIds(tc.legacy)).not.toContain(ROW_DELAYED.sizeID);

    gate.open();
    await expect(cycle).resolves.toMatchObject({ leader: true, ran: true, errors: [] });
    await cycleUntilProjected(delayed.xid);
    await expect(projector.awaitProjection({ positions, timeoutMs: 5_000 })).resolves.toMatchObject({ positions });
    expect(legacySizeIds(tc.legacy)).toContain(ROW_DELAYED.sizeID);
  });
});

describe('awaitProjection of owners whose positions are read at call time', () => {
  const POSITION = '500';
  let tc: TestContext;
  let projector: Projector;

  beforeAll(async () => {
    tc = await buildTestContext({ legacy: await legacyDb(['tsettings']), gateway: { active: VB.tableVersion }, bridge: false, clock: realTimeClock() });
    projector = createProjector(tc.ctx, { startupGuard: DIRECT_COMMIT });
  });

  afterAll(async () => {
    await tc?.close();
  });

  function ownerDouble(name: string) {
    if (tc.owners === null) throw new Error('The context was built without owner doubles');
    return tc.owners.owner(name);
  }

  it('reads the owner position once before any checkpoint and times out while the checkpoint is below it', async () => {
    const programsSites = ownerDouble(OWNER);
    const readsBeforePosition: number[] = [];
    programsSites.positionScript = () => {
      readsBeforePosition.push(checkpointReads(tc.legacy));
      return { position: POSITION };
    };
    await storeCheckpoint(tc.legacy, OWNER, '400');

    const timedOut = await rejectionOf(projector.awaitProjection({ owners: [OWNER], timeoutMs: SHORT_BUDGET_MS }));

    expect(timedOut).toBeInstanceOf(ProjectionTimeoutError);
    expect(timedOut).toMatchObject({ pending: [{ owner: OWNER, xid: POSITION, tenantsBehind: [TENANT_A.tenantId] }] });
    expect(programsSites.positionCalls).toBe(1);
    expect(readsBeforePosition).toEqual([0]);
    expect(checkpointReads(tc.legacy)).toBeGreaterThan(0);
  });

  it('resolves with the position read once the checkpoint has passed it', async () => {
    await storeCheckpoint(tc.legacy, OWNER, '501');

    const result = await projector.awaitProjection({ owners: [OWNER], timeoutMs: SHORT_BUDGET_MS });

    expect(result.positions).toEqual(new Map([[OWNER, POSITION]]));
  });

  it('counts an owner without checkpoint rows for its registered tenants as not applied', async () => {
    const content = 'strategies-content';
    ownerDouble(content).positionScript = { position: '42' };
    expect(await tenantCheckpoint(tc.legacy, content)).toBeUndefined();

    const timedOut = await rejectionOf(projector.awaitProjection({ owners: [content], timeoutMs: SHORT_BUDGET_MS }));

    expect(timedOut).toBeInstanceOf(ProjectionTimeoutError);
    expect(timedOut).toMatchObject({ pending: [{ owner: content, xid: '42', tenantsBehind: [TENANT_A.tenantId] }] });
  });
});

describe(`POST ${AWAIT_PATH} on the migration app`, () => {
  const POSITION = '500';
  let tc: TestContext;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    tc = await buildTestContext({
      legacy: await legacyDb(['tsettings']),
      gateway: { active: PROGRAMS_SITES_TARGET.tableVersion },
      cutover: { versions: [V0001, PROGRAMS_SITES_TARGET] },
      bridge: false,
      env: { LOG_LEVEL: 'fatal' },
    });
    configPaths.current = tc.ctx.config.paths;
    try {
      app = await buildApp({
        env: tc.ctx.env,
        verifierOverride: testVerifier('migration'),
        legacy: tc.legacy,
        owners: tc.ctx.owners,
        gateway: tc.gateway,
        startBackground: false,
      });
    } finally {
      configPaths.current = undefined;
    }
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await tc?.close();
  });

  /** Posts `payload` as the gateway and checks the answer against the contract. */
  async function postAwait(payload: unknown) {
    const gateway = ROLE_SET.find((subject) => subject.kind === 'service' && subject.caller === 'gateway');
    if (gateway === undefined) throw new Error('ROLE_SET has no gateway subject');
    const headers = await authHeadersFor(gateway, { audience: 'migration' });
    const res = await app.inject({
      method: 'POST',
      url: AWAIT_PATH,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: AWAIT_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  it('answers the legacy 503 while the checkpoint is below the position', async () => {
    await storeCheckpoint(tc.legacy, OWNER, '400');

    const res = await postAwait({ positions: { [OWNER]: POSITION }, timeoutMs: 200 });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(JSON.parse(apiUnavailableResponse().body));
  });

  it('answers 200 with the awaited positions once the checkpoint has passed them', async () => {
    await storeCheckpoint(tc.legacy, OWNER, '501');

    const res = await postAwait({ positions: { [OWNER]: POSITION }, timeoutMs: 200 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true, positions: { [OWNER]: POSITION } });
  });

  it('answers a position that is not an xid with the legacy 400 invalidParameters', async () => {
    const res = await postAwait({ positions: { [OWNER]: 'x500' }, timeoutMs: 200 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(JSON.parse(legacyErrorResponse('invalidParameters').body));
  });
});
