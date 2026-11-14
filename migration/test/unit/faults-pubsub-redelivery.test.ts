// Unit tests for the pubsub-redelivery fault script, with snapshots, tenants, shapes, owner exports, the replay child and the drain faked.
import { fixedClock } from '@opt2/platform/service-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyTenantResolver } from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { outboxCliPath, spawnChild, type ChildOutcome } from '../../src/faults/process-control.js';
import { pubsubRedelivery, type PubsubRedeliveryParams } from '../../src/faults/scripts/pubsub-redelivery.js';
import type { FaultEnv } from '../../src/faults/scripts/types.js';
import { DrainTimeoutError, awaitDrained, type DrainResult, type OwnerDrainCounts } from '../../src/quiesce/index.js';
import {
  describeUnitTable,
  fixtureTables,
  readFixtureStatus,
  readTargetUnitRows,
  toUnitRow,
  type UnitTableShape,
} from '../../src/reconcile/index.js';
import { getSnapshot, latestSnapshot, type SnapshotRecord } from '../../src/snapshot/index.js';

vi.mock('../../src/snapshot/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/snapshot/index.js')>()),
  latestSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
}));

vi.mock('../../src/apply/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apply/index.js')>()),
  createApplyTenantResolver: vi.fn(),
}));

vi.mock('../../src/reconcile/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reconcile/index.js')>()),
  describeUnitTable: vi.fn(),
  readTargetUnitRows: vi.fn(),
  fixtureTables: vi.fn(),
  readFixtureStatus: vi.fn(),
}));

vi.mock('../../src/quiesce/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/quiesce/index.js')>()),
  awaitDrained: vi.fn(),
}));

vi.mock('../../src/faults/process-control.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/faults/process-control.js')>()),
  spawnChild: vi.fn(),
  outboxCliPath: vi.fn(() => '/fake/platform/dist/outbox/cli.js'),
}));

const NOW = new Date('2026-06-30T12:00:00.000Z');
const S1_TAKEN = new Date('2026-06-30T08:00:00.000Z');
const SNAPSHOT_DB = 'muradb_opt2_snap_3';
const TENANT_A = '11111111-1111-5111-8111-111111111111';
const TENANT_B = '22222222-2222-5222-8222-222222222222';
const PRODUCERS = ['identity', 'people', 'programs-sites'] as const;

/** Unit tables of the fake catalog: owner, unit, legacy table and whether it migrates. */
const TABLES = [
  { owner: 'identity', unit: 'identity.user_account', legacyTable: 'dbo.tusers', migratable: true },
  { owner: 'people', unit: 'people.person', legacyTable: 'dbo.tusers', migratable: true },
  { owner: 'people', unit: 'people.person_archive', legacyTable: 'synthetic.person_archive', migratable: true },
  { owner: 'programs-sites', unit: 'programs_sites.site', legacyTable: 'dbo.tsettings', migratable: true },
  { owner: 'programs-sites', unit: 'programs_sites.site', legacyTable: 'dbo.tplugins', migratable: false },
] as const;

const KEYS_PER_CAPTURE = 4 * 2;

function shapeOf(unit: string, legacyTable: string, owner: string): UnitTableShape {
  return {
    unit,
    owner,
    legacyTable,
    keyed: true,
    keyColumns: ['ID'],
    columns: [
      { name: 'ID', type: 's' },
      { name: 'Name', type: 's' },
    ],
    excludedColumns: [],
    folded: false,
  };
}

function snapshot(seq: number, takenAt: Date): SnapshotRecord {
  return { seq, databaseName: `muradb_opt2_snap_${String(seq)}`, takenAt, state: 'ready' } as SnapshotRecord;
}

function outcome(exitCode: number | null, stdoutTail: string, stderrTail = ''): ChildOutcome {
  return { exitCode, signal: null, timedOut: false, stdoutTail, stderrTail };
}

function summaryLine(replayed: number): string {
  return `${JSON.stringify({ schema: 'identity', since: S1_TAKEN.toISOString(), replayed, failed: 0, skipped: 0, tenants: 2 })}\n`;
}

function counts(owner: string, pendingReceipts = 0): OwnerDrainCounts {
  return { owner, unpublished: 0, held: 0, pendingReceipts };
}

function drained(owners: OwnerDrainCounts[] = PRODUCERS.map((owner) => counts(owner))): DrainResult {
  return { owners, polls: 2, elapsedMs: 1004 };
}

/** Target rows per `<unit>|<legacyTable>|<tenant>`, read by the faked owner export at call time. */
let targetData: Map<string, Record<string, string>[]>;
let disposed: number;

function ctxWith(): MigrationContext {
  return {
    config: { dataOwners: ['identity', 'people', 'programs-sites'], paths: { tableOwnership: '/fake/opt2/table-ownership.json' } },
    env: { OPT2_STATE_DIR: '/fake/state' },
    clock: fixedClock(NOW),
    catalog: {
      unitsOfOwner: (owner: string) =>
        [...new Set(TABLES.filter((entry) => entry.owner === owner).map((entry) => entry.unit))].map((id) => ({ id, owner })),
      legacyTablesOf: (unit: string) => TABLES.filter((entry) => entry.unit === unit).map((entry) => entry.legacyTable),
      isMigratable: (table: string) => TABLES.some((entry) => entry.legacyTable === table && entry.migratable),
    },
  } as unknown as MigrationContext;
}

function envWith(ctx: MigrationContext = ctxWith()) {
  const envOf = vi.fn((name: string) => ({ OPT2_SERVICE_NAME: name, PG_USER: `${name.replaceAll('-', '_')}_app` }));
  return { env: { ctx, processControl: { envOf } } as unknown as FaultEnv, envOf, ctx };
}

function params(overrides: Partial<PubsubRedeliveryParams> = {}): PubsubRedeliveryParams {
  return pubsubRedelivery.paramsSchema.parse(overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
  disposed = 0;
  targetData = new Map([
    [`identity.user_account|dbo.tusers|${TENANT_A}`, [{ ID: 'u1', Name: 'admin' }]],
    [`people.person|dbo.tusers|${TENANT_A}`, [{ ID: 'u1', Name: 'Ada' }, { ID: 'u2', Name: 'Grace' }]],
    [`programs_sites.site|dbo.tsettings|${TENANT_B}`, [{ ID: 'tenant-b', Name: 'Tenant B' }]],
  ]);
  vi.mocked(latestSnapshot).mockResolvedValue(snapshot(3, NOW));
  vi.mocked(getSnapshot).mockImplementation(async (_ctx, seq) => (seq === 0 ? null : snapshot(seq, seq === 1 ? S1_TAKEN : NOW)));
  vi.mocked(createApplyTenantResolver).mockResolvedValue({ resolve: vi.fn(), siteTenants: () => [TENANT_A, TENANT_B] });
  vi.mocked(fixtureTables).mockResolvedValue(new Set(['synthetic.person_archive']));
  vi.mocked(readFixtureStatus).mockResolvedValue({ available: true, reason: null, checkedAt: NOW.toISOString() });
  vi.mocked(describeUnitTable).mockImplementation(async (_deps, { unit, legacyTable }) =>
    shapeOf(unit, legacyTable, TABLES.find((entry) => entry.unit === unit)?.owner ?? 'unknown'),
  );
  vi.mocked(readTargetUnitRows).mockImplementation(async (_deps, shape, tenantId) => {
    const values = targetData.get(`${shape.unit}|${shape.legacyTable}|${tenantId}`) ?? [];
    return {
      rows: values.map((row) => toUnitRow(shape, row)),
      count: values.length,
      objects: null,
      dispose: async () => {
        disposed += 1;
      },
    };
  });
  vi.mocked(spawnChild).mockResolvedValue(outcome(0, `opt2-outbox starting\n${summaryLine(3)}\n`));
  vi.mocked(awaitDrained).mockResolvedValue(drained());
});

describe('pubsub-redelivery fault script', () => {
  it('is the config fault pubsub-redelivery and reconciles afterwards', () => {
    expect(pubsubRedelivery.name).toBe('pubsub-redelivery');
    expect(pubsubRedelivery.reconciles).toBe(true);
    expect(loadConfig().faults.map((fault) => fault.name)).toContain(pubsubRedelivery.name);
  });

  it.each([
    [{}, { producers: [...PRODUCERS], drainTimeoutMs: 120_000 }],
    [
      { producers: ['people'], since: '2026-06-30T08:00:00+02:00', drainTimeoutMs: 5000 },
      { producers: ['people'], since: '2026-06-30T08:00:00+02:00', drainTimeoutMs: 5000 },
    ],
  ])('parses %j as %j', (input, expected) => {
    expect(pubsubRedelivery.paramsSchema.parse(input)).toStrictEqual(expected);
  });

  it.each([
    { producers: [] },
    { producers: ['finance'] },
    { since: '2026-06-30' },
    { since: '2026-06-30T08:00:00' },
    { drainTimeoutMs: 0 },
    { drainTimeoutMs: 1.5 },
    { tenant: TENANT_A },
  ])('rejects %j', (input) => {
    expect(pubsubRedelivery.paramsSchema.safeParse(input).success).toBe(false);
  });

  it('replays every producer as itself from the earliest snapshot and finds every checksum and receipt unchanged', async () => {
    const { env, envOf, ctx } = envWith();
    const output = await pubsubRedelivery.run(env, params());
    const since = S1_TAKEN.toISOString();

    expect(output.assertions).toStrictEqual([
      ...PRODUCERS.map((producer) => ({ name: `replayed:${producer}`, status: 'pass', detail: { republished: 3, since } })),
      { name: 'drained', status: 'pass', detail: { polls: 2, elapsedMs: 1004 } },
      { name: 'aggregates-unchanged', status: 'pass', detail: { keys: KEYS_PER_CAPTURE } },
      { name: 'projections-unchanged', status: 'pass', detail: { owners: 3 } },
    ]);
    expect(output.details).toStrictEqual({
      since,
      producers: [...PRODUCERS],
      republished: { identity: 3, people: 3, 'programs-sites': 3 },
      checksumKeys: KEYS_PER_CAPTURE,
      skippedTables: [],
    });
    expect(envOf.mock.calls.map(([name]) => name)).toStrictEqual([...PRODUCERS]);
    expect(vi.mocked(spawnChild).mock.calls).toStrictEqual(
      PRODUCERS.map((producer) => [
        process.execPath,
        [outboxCliPath(), 'replay', '--since', since],
        { env: envOf.mock.results[PRODUCERS.indexOf(producer)]?.value, timeoutMs: 120_000 },
      ]),
    );
    expect(awaitDrained).toHaveBeenCalledExactlyOnceWith(ctx, { timeoutMs: 120_000 });
    expect(createApplyTenantResolver).toHaveBeenCalledExactlyOnceWith(ctx, { database: SNAPSHOT_DB });
    expect(vi.mocked(describeUnitTable).mock.calls.map(([, options]) => options)).toStrictEqual(
      TABLES.filter((entry) => entry.migratable).map(({ unit, legacyTable }) => ({ unit, legacyTable, database: SNAPSHOT_DB })),
    );
    expect(vi.mocked(readTargetUnitRows).mock.calls.every(([, , , options]) => options?.includeObjects === false)).toBe(true);
    expect(disposed).toBe(2 * KEYS_PER_CAPTURE);
  });

  it('uses the given since and producers', async () => {
    const { env, envOf } = envWith();
    const since = '2026-06-30T09:30:00+02:00';
    const output = await pubsubRedelivery.run(env, params({ producers: ['people'], since, drainTimeoutMs: 5000 }));

    expect(getSnapshot).not.toHaveBeenCalled();
    expect(envOf).toHaveBeenCalledExactlyOnceWith('people');
    expect(vi.mocked(spawnChild).mock.calls[0]?.[1]).toStrictEqual([outboxCliPath(), 'replay', '--since', since]);
    expect(vi.mocked(spawnChild).mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 5000 });
    expect(output.assertions[0]).toStrictEqual({ name: 'replayed:people', status: 'pass', detail: { republished: 3, since } });
    expect(awaitDrained).toHaveBeenCalledWith(env.ctx, { timeoutMs: 5000 });
  });

  it('takes the latest snapshot itself as the earliest when no lower sequence exists', async () => {
    vi.mocked(getSnapshot).mockResolvedValue(null);
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params({ producers: ['identity'] }));

    expect(vi.mocked(getSnapshot).mock.calls.map(([, seq]) => seq)).toStrictEqual([0, 1, 2]);
    expect(output.details).toMatchObject({ since: NOW.toISOString() });
  });

  it('fails without a snapshot before replaying or reading anything', async () => {
    vi.mocked(latestSnapshot).mockResolvedValue(null);
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params());

    expect(output.assertions).toStrictEqual([
      { name: 'replayed', status: 'fail', detail: 'no snapshot', reason: 'take S0 and backfill before this fault' },
    ]);
    expect(spawnChild).not.toHaveBeenCalled();
    expect(readTargetUnitRows).not.toHaveBeenCalled();
    expect(awaitDrained).not.toHaveBeenCalled();
  });

  it.each([
    {
      title: 'a zero count',
      child: outcome(0, summaryLine(0)),
      expected: {
        status: 'fail',
        detail: { republished: 0, since: S1_TAKEN.toISOString() },
        reason: `no outbox rows since ${S1_TAKEN.toISOString()}; backfill emits state events — check \`since\``,
      },
      republished: 0,
    },
    {
      title: 'a non-zero exit',
      child: outcome(1, summaryLine(2), 'row failed'),
      expected: { status: 'fail', detail: { exitCode: 1, signal: null, timedOut: false, republished: 2, stderrTail: 'row failed' } },
      republished: 2,
    },
    {
      title: 'an exit 0 without a summary line',
      child: outcome(0, 'not json\n'),
      expected: { status: 'fail', detail: { exitCode: 0, signal: null, timedOut: false, republished: undefined, stderrTail: '' } },
      republished: null,
    },
    {
      title: 'a timed-out child',
      child: { exitCode: null, signal: 'SIGTERM' as const, timedOut: true, stdoutTail: '', stderrTail: 'stalled' },
      expected: { status: 'fail', detail: { exitCode: null, signal: 'SIGTERM', timedOut: true, republished: undefined, stderrTail: 'stalled' } },
      republished: null,
    },
  ])('fails replayed:<producer> on $title and still checks the rest', async ({ child, expected, republished }) => {
    vi.mocked(spawnChild).mockResolvedValueOnce(child);
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params());

    expect(output.assertions[0]).toStrictEqual({ name: 'replayed:identity', ...expected });
    expect(output.assertions.slice(1, 3).map((assertion) => assertion.status)).toStrictEqual(['pass', 'pass']);
    expect(output.assertions.map((assertion) => assertion.name).slice(3)).toStrictEqual([
      'drained',
      'aggregates-unchanged',
      'projections-unchanged',
    ]);
    expect(output.details).toMatchObject({ republished: { identity: republished, people: 3, 'programs-sites': 3 } });
  });

  it('fails drained on a drain timeout and skips the after-checks', async () => {
    const undrained = { counts: counts('timesheets', 4), role: { producer: true, consumer: true } };
    vi.mocked(awaitDrained).mockRejectedValue(new DrainTimeoutError(120_000, [undrained]));
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params());

    expect(output.assertions.slice(3)).toStrictEqual([
      { name: 'drained', status: 'fail', detail: [counts('timesheets', 4)] },
      { name: 'aggregates-unchanged', status: 'skipped', reason: 'drain did not complete' },
      { name: 'projections-unchanged', status: 'skipped', reason: 'drain did not complete' },
    ]);
    expect(readTargetUnitRows).toHaveBeenCalledTimes(KEYS_PER_CAPTURE);
  });

  it('propagates a drain failure other than a timeout', async () => {
    vi.mocked(awaitDrained).mockRejectedValue(new Error('pubsub unavailable'));
    const { env } = envWith();
    await expect(pubsubRedelivery.run(env, params())).rejects.toThrow('pubsub unavailable');
  });

  it.each([
    {
      title: 'a changed row',
      mutate: () => targetData.set(`people.person|dbo.tusers|${TENANT_A}`, [{ ID: 'u1', Name: 'Ada' }, { ID: 'u2', Name: 'Hopper' }]),
      differing: [`people|people.person|dbo.tusers|${TENANT_A}`],
    },
    {
      title: 'a row appearing in an empty tenant',
      mutate: () => targetData.set(`identity.user_account|dbo.tusers|${TENANT_B}`, [{ ID: 'u9', Name: 'late' }]),
      differing: [`identity|identity.user_account|dbo.tusers|${TENANT_B}`],
    },
  ])('fails aggregates-unchanged on $title during the replay', async ({ mutate, differing }) => {
    vi.mocked(spawnChild).mockImplementationOnce(async () => {
      mutate();
      return outcome(0, summaryLine(3));
    });
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params());

    expect(output.assertions.find((assertion) => assertion.name === 'aggregates-unchanged')).toStrictEqual({
      name: 'aggregates-unchanged',
      status: 'fail',
      detail: { differingCount: 1, differing },
    });
  });

  it('caps the listed differing keys at 50 and counts them all', async () => {
    const many = Array.from({ length: 60 }, (_, index) => `00000000-0000-5000-8000-${String(index).padStart(12, '0')}`);
    vi.mocked(createApplyTenantResolver).mockResolvedValue({ resolve: vi.fn(), siteTenants: () => many });
    vi.mocked(spawnChild).mockImplementationOnce(async () => {
      for (const tenant of many) targetData.set(`programs_sites.site|dbo.tsettings|${tenant}`, [{ ID: tenant, Name: 'new' }]);
      return outcome(0, summaryLine(3));
    });
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params());
    const assertion = output.assertions.find((entry) => entry.name === 'aggregates-unchanged');

    expect(assertion?.status).toBe('fail');
    expect(assertion?.detail).toMatchObject({ differingCount: 60 });
    expect((assertion?.detail as { differing: string[] }).differing).toHaveLength(50);
  });

  it('fails projections-unchanged for owners with pending receipts', async () => {
    vi.mocked(awaitDrained).mockResolvedValue(drained([counts('identity'), counts('timesheets', 2)]));
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params());

    expect(output.assertions.at(-1)).toStrictEqual({ name: 'projections-unchanged', status: 'fail', detail: [counts('timesheets', 2)] });
  });

  it('skips projections-unchanged when the drain checked no owner', async () => {
    vi.mocked(awaitDrained).mockResolvedValue(drained([]));
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params());

    expect(output.assertions.at(-1)).toStrictEqual({
      name: 'projections-unchanged',
      status: 'skipped',
      reason: 'position response reports no receipt counters',
    });
  });

  it('leaves fixture tables out of the checksums while the fixtures are unavailable', async () => {
    vi.mocked(readFixtureStatus).mockResolvedValue({ available: false, reason: 'no CREATE SCHEMA', checkedAt: NOW.toISOString() });
    const { env } = envWith();
    const output = await pubsubRedelivery.run(env, params());

    expect(vi.mocked(describeUnitTable).mock.calls.map(([, options]) => options.legacyTable)).not.toContain('synthetic.person_archive');
    expect(output.details).toMatchObject({ skippedTables: ['people.person_archive|synthetic.person_archive'], checksumKeys: 6 });
  });

  it('skips reading the fixture status when the ownership file lists no fixture table', async () => {
    vi.mocked(fixtureTables).mockResolvedValue(new Set());
    const { env } = envWith();
    await pubsubRedelivery.run(env, params());

    expect(readFixtureStatus).not.toHaveBeenCalled();
  });

  it('propagates a failed checksum read after disposing the rows', async () => {
    const shape = shapeOf('identity.user_account', 'dbo.tusers', 'identity');
    vi.mocked(readTargetUnitRows).mockResolvedValueOnce({
      // Out of key order, which the checksum's diff rejects.
      rows: [toUnitRow(shape, { ID: 'u1', Name: 'x' }), toUnitRow(shape, { ID: 'u0', Name: 'y' })],
      count: 2,
      objects: null,
      dispose: async () => {
        disposed += 1;
      },
    });
    const { env } = envWith();

    await expect(pubsubRedelivery.run(env, params())).rejects.toThrow();
    expect(disposed).toBe(1);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  describe('resume', () => {
    it('passes once the consumers have drained', async () => {
      const { env } = envWith();
      await expect(pubsubRedelivery.resume(env, params({ drainTimeoutMs: 9000 }))).resolves.toStrictEqual({
        steps: ['await-drained'],
        assertions: [{ name: 'resume-drained', status: 'pass', detail: { polls: 2, elapsedMs: 1004 } }],
      });
      expect(awaitDrained).toHaveBeenCalledExactlyOnceWith(env.ctx, { timeoutMs: 9000 });
    });

    it('fails resume-drained on a drain timeout without throwing', async () => {
      const undrained = { counts: counts('people', 1), role: { producer: true, consumer: true } };
      vi.mocked(awaitDrained).mockRejectedValue(new DrainTimeoutError(120_000, [undrained]));
      const { env } = envWith();

      await expect(pubsubRedelivery.resume(env, params())).resolves.toStrictEqual({
        steps: ['await-drained'],
        assertions: [{ name: 'resume-drained', status: 'fail', detail: [counts('people', 1)] }],
      });
    });

    it('propagates any other drain failure', async () => {
      vi.mocked(awaitDrained).mockRejectedValue(new Error('subscription missing'));
      const { env } = envWith();
      await expect(pubsubRedelivery.resume(env, params())).rejects.toThrow('subscription missing');
    });
  });
});
