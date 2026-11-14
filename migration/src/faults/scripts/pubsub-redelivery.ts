// Scripted fault pubsub-redelivery: republishes the state-event producers' stored outbox rows with their original eventIds and checks that nothing moves.
import { z } from '@opt2/platform/service-kit';

import { createApplyTenantResolver } from '../../apply/index.js';
import type { MigrationContext } from '../../context.js';
import type { DataOwner } from '../../owners/index.js';
import { DrainTimeoutError, awaitDrained, type DrainResult } from '../../quiesce/index.js';
import {
  compareRows,
  describeUnitTable,
  fixtureTables,
  readFixtureStatus,
  readTargetUnitRows,
  tableLookupKey,
  type UnitTableShape,
} from '../../reconcile/index.js';
import { getSnapshot, latestSnapshot, type SnapshotRecord } from '../../snapshot/index.js';
import { outboxCliPath, spawnChild, type ChildOutcome } from '../process-control.js';
import {
  fail,
  pass,
  skipped,
  type FaultAssertion,
  type FaultEnv,
  type FaultResumeOutput,
  type FaultRunOutput,
  type FaultScript,
} from './types.js';

const FAULT = 'pubsub-redelivery';
const REPLAYED = 'replayed';
const DRAINED = 'drained';
const AGGREGATES_UNCHANGED = 'aggregates-unchanged';
const PROJECTIONS_UNCHANGED = 'projections-unchanged';
const RESUME_DRAINED = 'resume-drained';

/** Most differing checksum keys an assertion lists; the total is always reported. */
const DIFFERING_KEYS_LIMIT = 50;

/** Producers of the state events migration applies emit: site, group, permission, membership and person changes. */
const STATE_EVENT_PRODUCERS = ['identity', 'people', 'programs-sites'] as const;

const paramsSchema = z
  .object({
    producers: z.array(z.enum(STATE_EVENT_PRODUCERS)).min(1).default([...STATE_EVENT_PRODUCERS]),
    since: z.iso.datetime({ offset: true }).optional(),
    drainTimeoutMs: z.number().int().positive().default(120_000),
  })
  .strict();

/** Parameters of {@link pubsubRedelivery}. */
export type PubsubRedeliveryParams = z.output<typeof paramsSchema>;

/** One owner unit table whose target rows are checksummed. */
interface ChecksumTable {
  owner: DataOwner;
  shape: UnitTableShape;
}

/** Tables and tenants checksummed before and after the replay, described once against the snapshot database. */
interface ChecksumPlan {
  tenants: string[];
  tables: ChecksumTable[];
  /** Fixture tables left out because the fixtures are unavailable, as reconciliation skips them. */
  skippedTables: string[];
}

/** Shapes of every migratable table of every data owner's units, and the site tenants reconciliation and backfill use. */
async function checksumPlan(ctx: MigrationContext, database: string): Promise<ChecksumPlan> {
  const tenants = (await createApplyTenantResolver(ctx, { database })).siteTenants();
  const fixtures = await fixtureTables(ctx.config.paths.tableOwnership);
  const fixturesAbsent = fixtures.size > 0 && !(await readFixtureStatus(ctx.env.OPT2_STATE_DIR, ctx.clock)).available;
  const tables: ChecksumTable[] = [];
  const skippedTables: string[] = [];
  for (const owner of ctx.config.dataOwners) {
    for (const unit of ctx.catalog.unitsOfOwner(owner)) {
      for (const legacyTable of ctx.catalog.legacyTablesOf(unit.id)) {
        if (!ctx.catalog.isMigratable(legacyTable)) continue;
        if (fixturesAbsent && fixtures.has(tableLookupKey(legacyTable))) {
          skippedTables.push(`${unit.id}|${legacyTable}`);
          continue;
        }
        tables.push({ owner, shape: await describeUnitTable(ctx, { unit: unit.id, legacyTable, database }) });
      }
    }
  }
  return { tenants, tables, skippedTables };
}

/** Target row count and SHA-256 per `<owner>|<unit>|<legacyTable>|<tenantId>`, read through the owners' exports as reconciliation reads them. */
async function captureChecksums(ctx: MigrationContext, plan: ChecksumPlan): Promise<Map<string, string>> {
  const checksums = new Map<string, string>();
  for (const { owner, shape } of plan.tables) {
    for (const tenantId of plan.tenants) {
      const target = await readTargetUnitRows(ctx, shape, tenantId, { includeObjects: false });
      try {
        // An empty legacy side and no kept differences leave only the target measures.
        const rows = await compareRows({ keyed: shape.keyed, columns: shape.columns, legacy: [], target: target.rows, limit: 0 });
        checksums.set(`${owner}|${shape.unit}|${shape.legacyTable}|${tenantId}`, `${String(rows.targetCount)}:${rows.targetSha256}`);
      } finally {
        await target.dispose();
      }
    }
  }
  return checksums;
}

/** The snapshot with the lowest sequence up to `latest`, whatever its state. */
async function earliestSnapshot(ctx: MigrationContext, latest: SnapshotRecord): Promise<SnapshotRecord> {
  for (let seq = 0; seq < latest.seq; seq++) {
    const snapshot = await getSnapshot(ctx, seq);
    if (snapshot !== null) return snapshot;
  }
  return latest;
}

/** The `replayed` count of the CLI's summary line, the last non-empty line of its stdout; undefined when it printed none. */
function replayedCount(stdoutTail: string): number | undefined {
  const line = stdoutTail.split('\n').map((text) => text.trim()).filter((text) => text !== '').at(-1);
  if (line === undefined) return undefined;
  try {
    const { replayed } = JSON.parse(line) as { replayed?: unknown };
    return typeof replayed === 'number' ? replayed : undefined;
  } catch {
    return undefined;
  }
}

/** Assertion `replayed:<producer>` for one replay run. */
function replayAssertion(producer: string, since: string, outcome: ChildOutcome, republished: number | undefined): FaultAssertion {
  const name = `${REPLAYED}:${producer}`;
  if (outcome.exitCode === 0 && republished !== undefined && republished > 0) return pass(name, { republished, since });
  if (outcome.exitCode === 0 && republished === 0) {
    return fail(name, { republished, since }, `no outbox rows since ${since}; backfill emits state events — check \`since\``);
  }
  return fail(name, { exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, republished, stderrTail: outcome.stderrTail });
}

/** Assertion that every checksum key holds the same value after the replay as before it. */
function aggregatesAssertion(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): FaultAssertion {
  const differing = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();
  if (differing.length === 0) return pass(AGGREGATES_UNCHANGED, { keys: before.size });
  return fail(AGGREGATES_UNCHANGED, { differingCount: differing.length, differing: differing.slice(0, DIFFERING_KEYS_LIMIT) });
}

/** Assertion that every checked consumer holds a receipt for each republished event, so no redelivery is left to apply. */
function projectionsAssertion(drain: DrainResult): FaultAssertion {
  // Every checked owner carries a receipt count, so only a drain that checked no owner reports none.
  if (drain.owners.length === 0) return skipped(PROJECTIONS_UNCHANGED, 'position response reports no receipt counters');
  const pending = drain.owners.filter((counts) => counts.pendingReceipts !== 0);
  if (pending.length === 0) return pass(PROJECTIONS_UNCHANGED, { owners: drain.owners.length });
  return fail(PROJECTIONS_UNCHANGED, pending);
}

async function run(env: FaultEnv, params: PubsubRedeliveryParams): Promise<FaultRunOutput> {
  const { ctx } = env;
  const { producers, drainTimeoutMs } = params;
  const latest = await latestSnapshot(ctx);
  if (latest === null) return { assertions: [fail(REPLAYED, 'no snapshot', 'take S0 and backfill before this fault')], details: { producers } };
  const since = params.since ?? (await earliestSnapshot(ctx, latest)).takenAt.toISOString();
  const plan = await checksumPlan(ctx, latest.databaseName);
  const before = await captureChecksums(ctx, plan);

  const assertions: FaultAssertion[] = [];
  const republished: Record<string, number | null> = {};
  for (const producer of producers) {
    // Runs as the producer, with its own role and Pub/Sub project, never with migration's credentials.
    const outcome = await spawnChild(process.execPath, [outboxCliPath(), 'replay', '--since', since], {
      env: env.processControl.envOf(producer),
      timeoutMs: drainTimeoutMs,
    });
    const count = replayedCount(outcome.stdoutTail);
    republished[producer] = count ?? null;
    assertions.push(replayAssertion(producer, since, outcome, count));
  }

  const details = { since, producers, republished, checksumKeys: before.size, skippedTables: plan.skippedTables };
  let drain: DrainResult;
  try {
    drain = await awaitDrained(ctx, { timeoutMs: drainTimeoutMs });
  } catch (error) {
    if (!(error instanceof DrainTimeoutError)) throw error;
    assertions.push(
      fail(DRAINED, error.owners),
      skipped(AGGREGATES_UNCHANGED, 'drain did not complete'),
      skipped(PROJECTIONS_UNCHANGED, 'drain did not complete'),
    );
    return { assertions, details };
  }
  assertions.push(pass(DRAINED, { polls: drain.polls, elapsedMs: drain.elapsedMs }));

  const after = await captureChecksums(ctx, plan);
  assertions.push(aggregatesAssertion(before, after), projectionsAssertion(drain));
  return { assertions, details };
}

async function resume(env: FaultEnv, params: PubsubRedeliveryParams): Promise<FaultResumeOutput> {
  const steps = ['await-drained'];
  try {
    const drain = await awaitDrained(env.ctx, { timeoutMs: params.drainTimeoutMs });
    return { steps, assertions: [pass(RESUME_DRAINED, { polls: drain.polls, elapsedMs: drain.elapsedMs })] };
  } catch (error) {
    // Any other failure propagates, so the fault run records it as the resume error.
    if (!(error instanceof DrainTimeoutError)) throw error;
    return { steps, assertions: [fail(RESUME_DRAINED, error.owners)] };
  }
}

/** Replays the state-event producers' outboxes, then asserts every target aggregate checksum and consumer receipt is unchanged. */
export const pubsubRedelivery: FaultScript<PubsubRedeliveryParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,
  run,
  resume,
};
