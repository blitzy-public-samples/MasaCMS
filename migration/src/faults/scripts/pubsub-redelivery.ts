// Scripted fault pubsub-redelivery: republishes the state-event producers' stored outbox rows with their original eventIds, observes every replayed
// copy on witness subscriptions, pushes the held copies to their consumers until each observed copy is answered, and checks that nothing moves.
import { randomBytes } from 'node:crypto';

import { z } from '@opt2/platform/service-kit';

import { createApplyTenantResolver } from '../../apply/index.js';
import type { MigrationContext } from '../../context.js';
import type { DataOwner } from '../../owners/index.js';
import {
  DEFAULT_DRAIN_POLL_MS,
  DrainTimeoutError,
  awaitDrained,
  createPubSub,
  drainParticipants,
  listSubscriptionIds,
  witnessName,
  witnessPrefix,
  type DrainResult,
  type PubSubLike,
} from '../../quiesce/index.js';
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
  WitnessCleanupError,
  deleteWitnesses,
  deliverHeld,
  holdPushDelivery,
  observeReplay,
  pullModeSubscriptions,
  whileHeld,
  whileWitnessed,
  type DeliveryReport,
  type HeldSubscription,
  type PollOptions,
  type ReplayObservation,
} from '../redelivery-barrier.js';
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
const OBSERVED = 'observed';
const REDELIVERED = 'redelivered';
const INBOX_UNCHANGED = 'inbox-unchanged';
const DRAINED = 'drained';
const AGGREGATES_UNCHANGED = 'aggregates-unchanged';
const PROJECTIONS_UNCHANGED = 'projections-unchanged';
const RESUME_PUSH_RESTORED = 'resume-push-restored';
const RESUME_WITNESSES_DELETED = 'resume-witnesses-deleted';
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

/** Ports of {@link createPubsubRedelivery}. */
export interface PubsubRedeliveryDeps {
  /** Pub/Sub client of one run or resume, closed when it ends; `createPubSub` when absent. */
  pubsub?: (env: MigrationContext['env']) => PubSubLike;
  /** Posts the held copies to their push endpoints; the global `fetch` when absent. */
  fetch?: typeof fetch;
}

type Ports = Required<PubsubRedeliveryDeps>;

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

/** Assertion `observed:<producer>`: its witnesses received exactly the replay's published count of distinct event ids; `observation` is undefined when the replay gave no count. */
function observedAssertion(producer: string, observation: ReplayObservation | undefined): FaultAssertion {
  const name = `${OBSERVED}:${producer}`;
  if (observation === undefined) {
    return fail(name, { replayed: null }, 'the replay did not exit 0 with its published count, so its replayed set cannot be bounded');
  }
  const { replayed, eventIds, unidentified, outcome } = observation;
  const topics = Object.fromEntries(Object.entries(eventIds).map(([topic, ids]) => [topic, ids.length]));
  const observed = Object.values(topics).reduce((sum, count) => sum + count, 0);
  if (outcome === 'complete') return pass(name, { replayed, topics });
  if (outcome === 'short') {
    return fail(name, { replayed, observed, topics }, 'replayed set not fully observed: the witnesses received fewer distinct event ids than the replay published');
  }
  return fail(
    name,
    { replayed, observed, unidentified, topics },
    'the producer published events besides the replay during the fault; it is not quiesced',
  );
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

/** Assertion `redelivered:<subscription>`: every replayed copy of its topic answered 2xx and the queue found empty within the budget. */
function deliveryAssertion(report: DeliveryReport): FaultAssertion {
  const { subscription, endpoint, expected, delivered, statuses, unproven } = report;
  const name = `${REDELIVERED}:${subscription}`;
  if (report.complete) return pass(name, { endpoint, expected, delivered, statuses });
  return fail(
    name,
    { endpoint, expected, delivered, statuses, unprovenCount: unproven.length, unproven: unproven.slice(0, DIFFERING_KEYS_LIMIT) },
    'the budget ran out before every replayed copy was answered 2xx and the queue was empty',
  );
}

/** Inbox receipt total of each consumer, from its position answer; null when it reports no inbox. */
async function inboxTotals(ctx: MigrationContext, consumers: readonly DataOwner[]): Promise<Record<string, number | null>> {
  const totals = await Promise.all(consumers.map(async (owner) => [owner, (await ctx.owners.position(owner)).inbox?.total ?? null] as const));
  return Object.fromEntries(totals);
}

/** Assertion that every consumer of a held subscription reports the same inbox total after the barrier as before the replay. */
function inboxAssertion(
  before: Readonly<Record<string, number | null>>,
  after: Readonly<Record<string, number | null>>,
  unchecked: readonly string[],
): FaultAssertion {
  const differing = Object.keys(before)
    .filter((owner) => before[owner] === null || before[owner] !== after[owner])
    .map((owner) => ({ owner, before: before[owner] ?? null, after: after[owner] ?? null }));
  if (differing.length === 0 && unchecked.length === 0) return pass(INBOX_UNCHANGED, { totals: before });
  return fail(INBOX_UNCHANGED, { differing, unchecked });
}

/** The checks that wait for the redelivery barrier, skipped for `reason`. */
function barrierSkips(reason: string): FaultAssertion[] {
  return [INBOX_UNCHANGED, DRAINED, AGGREGATES_UNCHANGED, PROJECTIONS_UNCHANGED].map((name) => skipped(name, reason));
}

/** Outcome of the held phase: a replayed set not observed exactly, no replayed copy on a held topic, or the deliveries with the inbox totals around them. */
type BarrierOutcome =
  | { kind: 'unestablished' }
  | { kind: 'unexercised' }
  | {
      kind: 'delivered';
      deliveries: DeliveryReport[];
      inboxBefore: Record<string, number | null>;
      /** Read only once every delivery completed. */
      inboxAfter?: Record<string, number | null>;
    };

async function run(env: FaultEnv, params: PubsubRedeliveryParams, ports: Ports): Promise<FaultRunOutput> {
  const { ctx } = env;
  const { producers, drainTimeoutMs } = params;
  const latest = await latestSnapshot(ctx);
  if (latest === null) return { assertions: [fail(REPLAYED, 'no snapshot', 'take S0 and backfill before this fault')], details: { producers } };
  const since = params.since ?? (await earliestSnapshot(ctx, latest)).takenAt.toISOString();
  const plan = await checksumPlan(ctx, latest.databaseName);
  const before = await captureChecksums(ctx, plan);

  const pubsub = ports.pubsub(ctx.env);
  try {
    const hold = await holdPushDelivery(pubsub, producers);
    if ('inPullMode' in hold) {
      const reason = 'push delivery of the replayed topics is suspended; run `opt2-ops resume` before this fault';
      return { assertions: [fail(REDELIVERED, { inPullMode: hold.inPullMode }, reason)], details: { since, producers } };
    }
    if (hold.held.length === 0) {
      const reason = 'no consumer subscribes to a topic of the replayed producers';
      return { assertions: [fail(REDELIVERED, { subscriptions: 0 }, reason)], details: { since, producers } };
    }
    return await redeliver(env, params, { since, plan, before, pubsub, held: hold.held, fetch: ports.fetch });
  } finally {
    await pubsub.close();
  }
}

/** State of a run once its subscriptions are held. */
interface HeldRun {
  since: string;
  plan: ChecksumPlan;
  before: ReadonlyMap<string, string>;
  pubsub: PubSubLike;
  held: HeldSubscription[];
  fetch: typeof fetch;
}

/** Replays while `held` pulls and witnesses watch the producers' topics, pushes each witnessed copy to its consumers, restores push delivery, then drains and compares. */
async function redeliver(env: FaultEnv, params: PubsubRedeliveryParams, state: HeldRun): Promise<FaultRunOutput> {
  const { ctx } = env;
  const { producers, drainTimeoutMs } = params;
  const { since, plan, before, pubsub, held } = state;
  const participants = drainParticipants(ctx);
  const consumers = new Set(held.map((entry) => entry.consumer));
  const checked = participants.filter((owner) => consumers.has(owner));
  const unchecked = [...consumers].filter((consumer) => !new Set<string>(participants).has(consumer)).sort();
  const runId = randomBytes(4).toString('hex');
  /** A fresh budget of `drainTimeoutMs` from now. */
  const polling = (): PollOptions => ({
    deadline: env.clock.now().getTime() + drainTimeoutMs,
    clock: env.clock,
    sleep: env.sleep,
    pollIntervalMs: DEFAULT_DRAIN_POLL_MS,
  });

  const assertions: FaultAssertion[] = [];
  const republished: Record<string, number | null> = {};
  const witnessed = (topic: string): string => witnessName(FAULT, runId, topic);
  const barrier = await whileHeld(held, async (): Promise<BarrierOutcome> => {
    const inboxBefore = await inboxTotals(ctx, checked);
    return whileWitnessed(pubsub, producers, witnessed, async (witnesses): Promise<BarrierOutcome> => {
      const replayedIds = new Map<string, string[]>();
      let established = true;
      for (const producer of producers) {
        // Runs as the producer, with its own role and Pub/Sub project, never with migration's credentials.
        const outcome = await spawnChild(process.execPath, [outboxCliPath(), 'replay', '--since', since], {
          env: env.processControl.envOf(producer),
          timeoutMs: drainTimeoutMs,
        });
        const count = replayedCount(outcome.stdoutTail);
        republished[producer] = count ?? null;
        assertions.push(replayAssertion(producer, since, outcome, count));
        const ownWitnesses = witnesses.filter((witness) => witness.producer === producer);
        const observation =
          outcome.exitCode === 0 && count !== undefined ? await observeReplay(pubsub, producer, ownWitnesses, count, polling()) : undefined;
        assertions.push(observedAssertion(producer, observation));
        if (observation?.outcome !== 'complete') established = false;
        for (const [topic, eventIds] of Object.entries(observation?.eventIds ?? {})) replayedIds.set(topic, eventIds);
      }
      if (!established) return { kind: 'unestablished' };
      const expected = new Map(held.map((entry) => [entry.name, replayedIds.get(entry.topic) ?? []] as const));
      if ([...expected.values()].every((eventIds) => eventIds.length === 0)) return { kind: 'unexercised' };
      const deliveries = await deliverHeld(pubsub, held, expected, { ...polling(), fetch: state.fetch });
      if (!deliveries.every((report) => report.complete)) return { kind: 'delivered', deliveries, inboxBefore };
      return { kind: 'delivered', deliveries, inboxBefore, inboxAfter: await inboxTotals(ctx, checked) };
    });
  });

  const details = {
    since,
    producers,
    republished,
    subscriptions: held.map((entry) => entry.name),
    checksumKeys: before.size,
    skippedTables: plan.skippedTables,
  };
  if (barrier.kind === 'unestablished') {
    const reason = 'replayed set not established';
    assertions.push(skipped(REDELIVERED, reason), ...barrierSkips(reason));
    return { assertions, details };
  }
  if (barrier.kind === 'unexercised') {
    const reason = 'no replayed copy reached a consumer subscription of the replayed topics';
    assertions.push(fail(REDELIVERED, { subscriptions: held.length, expected: 0 }, reason), ...barrierSkips('redelivery not exercised'));
    return { assertions, details };
  }
  assertions.push(...barrier.deliveries.map(deliveryAssertion));
  if (barrier.inboxAfter === undefined) {
    assertions.push(...barrierSkips('replayed copies not confirmed processed'));
    return { assertions, details };
  }
  assertions.push(inboxAssertion(barrier.inboxBefore, barrier.inboxAfter, unchecked));

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

/** Assertion that no subscription on a topic of the replayed producers was left in pull mode. */
async function pushRestoredAssertion(pubsub: PubSubLike, params: PubsubRedeliveryParams): Promise<FaultAssertion> {
  const inPullMode = await pullModeSubscriptions(pubsub, params.producers);
  if (inPullMode.length === 0) return pass(RESUME_PUSH_RESTORED);
  return fail(RESUME_PUSH_RESTORED, { inPullMode }, 'push delivery is not restored; re-apply it with `npm run topology -- --target local` in harness');
}

/** Deletes every witness subscription a run of this fault left behind; the assertion names those deleted, or those left on a failure. */
async function witnessesDeletedAssertion(pubsub: PubSubLike): Promise<FaultAssertion> {
  const leftover = await listSubscriptionIds(pubsub, witnessPrefix(FAULT));
  try {
    await deleteWitnesses(pubsub, leftover);
  } catch (error) {
    if (!(error instanceof WitnessCleanupError)) throw error;
    return fail(RESUME_WITNESSES_DELETED, { left: error.subscriptions }, error.message);
  }
  return pass(RESUME_WITNESSES_DELETED, { deleted: leftover });
}

async function resume(env: FaultEnv, params: PubsubRedeliveryParams, ports: Ports): Promise<FaultResumeOutput> {
  const steps = ['delete-witnesses', 'await-drained'];
  const pubsub = ports.pubsub(env.ctx.env);
  let pushRestored: FaultAssertion;
  let witnessesDeleted: FaultAssertion;
  try {
    pushRestored = await pushRestoredAssertion(pubsub, params);
    witnessesDeleted = await witnessesDeletedAssertion(pubsub);
  } finally {
    await pubsub.close();
  }
  try {
    const drain = await awaitDrained(env.ctx, { timeoutMs: params.drainTimeoutMs });
    return { steps, assertions: [pushRestored, witnessesDeleted, pass(RESUME_DRAINED, { polls: drain.polls, elapsedMs: drain.elapsedMs })] };
  } catch (error) {
    // Any other failure propagates, so the fault run records it as the resume error.
    if (!(error instanceof DrainTimeoutError)) throw error;
    return { steps, assertions: [pushRestored, witnessesDeleted, fail(RESUME_DRAINED, error.owners)] };
  }
}

/** The pubsub-redelivery script over the given Pub/Sub client and push transport. */
export function createPubsubRedelivery(deps: PubsubRedeliveryDeps = {}): FaultScript<PubsubRedeliveryParams> {
  const ports: Ports = { pubsub: deps.pubsub ?? createPubSub, fetch: deps.fetch ?? ((input, init) => fetch(input, init)) };
  return {
    name: FAULT,
    reconciles: true,
    paramsSchema,
    run: (env, params) => run(env, params, ports),
    resume: (env, params) => resume(env, params, ports),
  };
}

/** Replays the state-event producers' outboxes, pushes every observed replayed copy to its consumer, then asserts inbox totals, aggregate checksums and receipts unchanged. */
export const pubsubRedelivery: FaultScript<PubsubRedeliveryParams> = createPubsubRedelivery();
