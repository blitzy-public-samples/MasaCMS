// Full outbox replay check: republishes every producer's outbox and compares consumer state taken before and after.
import { execFile } from 'node:child_process';
import path from 'node:path';

import { consumerOfSubscription } from '@opt2/platform/events';
import { MIGRATION_PATH_PREFIX, tableChecksum, type InboxCounts, type PositionResponse } from '@opt2/platform/migration-kit';
import { LOCAL_ONLY_PRODUCERS, OUTBOX_PRODUCERS } from '@opt2/platform/tasks';

import { createHarnessInvoker, type HarnessInvoker } from '../lib/invocation.js';
import { REPO_ROOT, type EnvLike } from '../lib/paths.js';
import { PACKAGE_NAMES, serviceUrls, type PackageName } from '../repro/ports.js';
import { deriveTopology } from '../repro/pubsub-topology.js';
import { readUpState, type UpState } from '../repro/up-state.js';
import { pollUntil, readOwnerExport, siteRegistry, type SeamDeps } from './seams.js';

// identity.person_contact, people.group_name and content's group, permission and membership projections are tables
// without a unit, which their owners' migration export rejects; those consumers are compared by inbox counts alone.
/** Units each consumer writes from events and exports to `platform.migration`, by consumer. */
export const CONSUMER_EFFECT_UNITS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  communications: Object.freeze(['communications.message', 'communications.scheduled_task']),
  stub: Object.freeze(['stub.note_projection']),
  timesheets: Object.freeze(['timesheets.blackout']),
});

/** Bounds of {@link waitForQuiescence}: the whole wait, the wait between polls and the consecutive equal polls needed. */
export interface DrainBounds {
  timeoutMs?: number;
  intervalMs?: number;
  stablePolls?: number;
}

/** Drain bounds used where {@link DrainBounds} leaves a value unset. */
export const DEFAULT_DRAIN: Readonly<Required<DrainBounds>> = Object.freeze({
  timeoutMs: 120_000,
  intervalMs: 2_000,
  stablePolls: 3,
});

/** Exit code and output of one command. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `file` with `args` in `cwd` under exactly `env`. */
export type ExecFn = (file: string, args: readonly string[], opts: { cwd: string; env: EnvLike }) => Promise<ExecResult>;

/** Services and units a check covers; unset lists default to the outbox producers and the local topology's consumers. */
export type ReplayScopeDeps = SeamDeps & {
  producers?: readonly string[];
  consumers?: readonly string[];
  /** Effect units by consumer, replacing {@link CONSUMER_EFFECT_UNITS}. */
  units?: Readonly<Record<string, readonly string[]>>;
  drain?: DrainBounds;
};

/** Collaborators of {@link runOutboxReplay}; `since` is the replay's lower bound, passed to every producer's bin. */
export type OutboxReplayDeps = ReplayScopeDeps & {
  since: string | Date;
  exec?: ExecFn;
};

/** Row count and canonical checksum of one consumer's effect unit in one tenant. */
export interface UnitChecksum {
  rows: number;
  checksum: string;
}

/** Inbox rows keyed `<service>/<subscription>` and effect checksums keyed `<service>/<unit>/<tenantId>`, keys sorted. */
export interface ConsumerSnapshot {
  inboxCounts: Record<string, number>;
  aggregateChecksums: Record<string, UnitChecksum>;
}

/** One producer's replay: the bin's exit code and its last stdout line parsed as JSON, null when that line is not JSON. */
export interface ReplayRun {
  service: string;
  exitCode: number;
  summary: unknown;
}

/** A snapshot key whose value changed; null marks the side it is absent from. */
export interface SnapshotDifference {
  key: string;
  before: number | UnitChecksum | null;
  after: number | UnitChecksum | null;
}

/** Outcome of {@link runOutboxReplay}; `unchanged` holds when no key differs and every replay exited 0. */
export interface OutboxReplayResult {
  since: string;
  before: ConsumerSnapshot;
  after: ConsumerSnapshot;
  unchanged: boolean;
  replays: ReplayRun[];
  differences: SnapshotDifference[];
}

/** Raised when outboxes or inbox counts do not settle within the drain bound; `pending` names what kept changing. */
export class QuiescenceTimeoutError extends Error {
  override name = 'QuiescenceTimeoutError';

  constructor(
    readonly elapsedMs: number,
    readonly pending: readonly string[],
  ) {
    super(`outbox replay quiescence timed out after ${elapsedMs} ms: ${pending.join('; ')}`);
  }
}

type Scope = Omit<ReplayScopeDeps, 'env' | 'invoker' | 'producers' | 'consumers'> & {
  env: EnvLike;
  invoker: HarnessInvoker;
  producers: PackageName[];
  consumers: PackageName[];
};

interface Reading {
  pending: string[];
  inbox: Record<string, number>;
}

interface ReplayTarget {
  service: PackageName;
  file: string;
  cwd: string;
  env: EnvLike;
}

const PACKAGES: ReadonlySet<string> = new Set(PACKAGE_NAMES);
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/;
// Bounds each owner call, so a hung owner cannot outlast the drain bound.
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([a], [b]) => compareKeys(a, b)));
}

/** `names` deduplicated in order; throws naming every entry that is not a local package. */
function packageNames(names: readonly string[], role: string): PackageName[] {
  const unknown = names.filter((name) => !PACKAGES.has(name));
  if (unknown.length > 0) {
    throw new Error(`${role} ${unknown.join(', ')} name no local package; expected one of ${PACKAGE_NAMES.join(', ')}`);
  }
  return [...new Set(names as readonly PackageName[])];
}

function topologyConsumers(): string[] {
  return Object.keys(deriveTopology('local', REPO_ROOT).subscriptions).map((name) => consumerOfSubscription(name));
}

async function resolveScope(deps: ReplayScopeDeps): Promise<Scope> {
  const env = deps.env ?? process.env;
  return {
    ...deps,
    env,
    invoker: deps.invoker ?? (await createHarnessInvoker({ caller: 'migration', env })),
    producers: packageNames(deps.producers ?? [...OUTBOX_PRODUCERS, ...LOCAL_ONLY_PRODUCERS], 'producers'),
    consumers: packageNames(deps.consumers ?? topologyConsumers(), 'consumers'),
  };
}

/** The owner's `GET /internal/v1/migration/position`, called as `platform.migration`; throws on a non-2xx answer. */
async function readPosition(service: PackageName, scope: Scope): Promise<PositionResponse> {
  const url = new URL(`${MIGRATION_PATH_PREFIX}/position`, scope.serviceUrls?.[service] ?? serviceUrls()[service]).href;
  const headers = await scope.invoker.headersFor({ callee: service, url });
  const response = await (scope.fetch ?? globalThis.fetch)(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${service} migration position answered ${response.status}: ${text}`);
  return JSON.parse(text) as PositionResponse;
}

// The owner sums its inbox over every registered tenant, so the position answer counts per subscription, not per tenant.
function addInboxCounts(service: string, inbox: InboxCounts | null | undefined, into: Map<string, number>): void {
  for (const [subscription, count] of Object.entries(inbox?.bySubscription ?? {})) {
    into.set(`${service}/${subscription}`, count);
  }
}

/** Every key of either record whose value differs under `same`, or that only one side holds, in key order. */
function diffRecords<T extends number | UnitChecksum>(
  before: Record<string, T>,
  after: Record<string, T>,
  same: (a: T, b: T) => boolean,
): SnapshotDifference[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareKeys);
  return keys.flatMap((key) => {
    const a = Object.hasOwn(before, key) ? before[key] : undefined;
    const b = Object.hasOwn(after, key) ? after[key] : undefined;
    return a !== undefined && b !== undefined && same(a, b) ? [] : [{ key, before: a ?? null, after: b ?? null }];
  });
}

function inboxDifferences(before: Record<string, number>, after: Record<string, number>): SnapshotDifference[] {
  return diffRecords(before, after, (a, b) => a === b);
}

/** Inbox counts and effect-unit checksums of every consumer, read through its migration endpoints as `platform.migration`. */
export async function snapshotConsumers(deps: ReplayScopeDeps = {}): Promise<ConsumerSnapshot> {
  const scope = await resolveScope(deps);
  const unitsOf = scope.units ?? CONSUMER_EFFECT_UNITS;
  const inbox = new Map<string, number>();
  for (const consumer of scope.consumers) addInboxCounts(consumer, (await readPosition(consumer, scope)).inbox, inbox);

  const checksums = new Map<string, UnitChecksum>();
  const withUnits = scope.consumers.filter((consumer) => (unitsOf[consumer] ?? []).length > 0);
  if (withUnits.length > 0) {
    const tenants = [...new Set((await siteRegistry(scope)).map((site) => site.tenantId))];
    for (const consumer of withUnits) {
      for (const unit of unitsOf[consumer] ?? []) {
        for (const tenantId of tenants) {
          const { entries } = await readOwnerExport({ service: consumer, unit, tenantId }, scope);
          const { count, sha256 } = tableChecksum(entries);
          checksums.set(`${consumer}/${unit}/${tenantId}`, { rows: count, checksum: sha256 });
        }
      }
    }
  }
  return { inboxCounts: sortedRecord(inbox), aggregateChecksums: sortedRecord(checksums) };
}

/** One poll: producers still holding unpublished or held outbox rows, and every consumer's inbox counts. */
async function readQuiescence(scope: Scope): Promise<Reading> {
  const producers: ReadonlySet<string> = new Set(scope.producers);
  const consumers: ReadonlySet<string> = new Set(scope.consumers);
  const pending: string[] = [];
  const inbox = new Map<string, number>();
  for (const service of new Set([...scope.producers, ...scope.consumers])) {
    const position = await readPosition(service, scope);
    const unpublished = position.outbox?.unpublished ?? 0;
    const held = position.outbox?.held ?? 0;
    if (producers.has(service) && (unpublished > 0 || held > 0)) {
      pending.push(`${service} outbox unpublished=${unpublished} held=${held}`);
    }
    if (consumers.has(service)) addInboxCounts(service, position.inbox, inbox);
  }
  return { pending, inbox: sortedRecord(inbox) };
}

/** Polls until producers' outboxes are drained and inbox counts hold for `drain.stablePolls` polls; throws {@link QuiescenceTimeoutError} at the bound. */
export async function waitForQuiescence(deps: ReplayScopeDeps = {}): Promise<void> {
  const scope = await resolveScope(deps);
  const timeoutMs = scope.drain?.timeoutMs ?? DEFAULT_DRAIN.timeoutMs;
  const intervalMs = scope.drain?.intervalMs ?? DEFAULT_DRAIN.intervalMs;
  const stablePolls = scope.drain?.stablePolls ?? DEFAULT_DRAIN.stablePolls;
  if (!Number.isInteger(stablePolls) || stablePolls < 1) {
    throw new RangeError(`drain.stablePolls must be a positive integer, got ${String(stablePolls)}`);
  }
  let last: Reading | undefined;
  let prior: Reading | undefined;
  let streak = 0;
  const outcome = await pollUntil(
    () => readQuiescence(scope),
    (reading) => {
      const drained = reading.pending.length === 0;
      // A streak above zero means the previous poll was drained too.
      const steady = streak > 0 && last !== undefined && inboxDifferences(last.inbox, reading.inbox).length === 0;
      streak = drained ? (steady ? streak + 1 : 1) : 0;
      prior = last;
      last = reading;
      return streak >= stablePolls;
    },
    { now: scope.now, sleep: scope.sleep, poll: { timeoutMs, intervalMs } },
  );
  if (!outcome.timedOut) return;
  const changing = (prior === undefined ? [] : inboxDifferences(prior.inbox, outcome.value.inbox)).map(
    ({ key, before, after }) => `${key} inbox ${before ?? 'absent'} -> ${after ?? 'absent'}`,
  );
  const pending = [...outcome.value.pending, ...changing];
  throw new QuiescenceTimeoutError(
    outcome.elapsedMs,
    pending.length > 0 ? pending : [`inbox counts steady for ${streak} of ${stablePolls} polls`],
  );
}

/** ISO-8601 UTC form of `since`; a string must carry its zone, as the replay bin requires. */
function sinceIso(since: string | Date): string {
  if (typeof since === 'string' && !ZONED.test(since)) {
    throw new RangeError(`since must carry a zone (Z or ±hh:mm), got ${JSON.stringify(since)}`);
  }
  const instant = typeof since === 'string' ? new Date(since) : since;
  if (Number.isNaN(instant.getTime())) throw new RangeError(`since is not a valid timestamp: ${String(since)}`);
  return instant.toISOString();
}

/** Each producer's `opt2-outbox` bin, run in its `up.json` directory with its recorded variables over `env`. */
function replayTargets(state: UpState, scope: Scope): ReplayTarget[] {
  return scope.producers.map((service) => {
    const entry = Object.hasOwn(state.processes, service) ? state.processes[service] : undefined;
    if (entry?.env === undefined) {
      throw new Error(
        `up.json records no ${entry === undefined ? 'process' : 'environment'} for producer ${service}; its replay runs only with the producer's own role`,
      );
    }
    return {
      service,
      file: path.join(entry.cwd, 'node_modules', '.bin', 'opt2-outbox'),
      cwd: entry.cwd,
      env: { ...scope.env, ...entry.env },
    };
  });
}

function lastJsonLine(stdout: string): unknown {
  const line = stdout.trimEnd().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

/** Default {@link ExecFn}: `execFile` without a shell; an exit status resolves, a spawn failure or a signal rejects. */
const execBin: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd: opts.cwd, env: opts.env, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr });
        else reject(error);
      },
    );
  });

/** Replays each producer's outbox from `since` under its own environment and diffs consumer snapshots taken at quiescence before and after. */
export async function runOutboxReplay(deps: OutboxReplayDeps): Promise<OutboxReplayResult> {
  const since = sinceIso(deps.since);
  const scope = await resolveScope(deps);
  const targets = replayTargets(readUpState({ env: scope.env }), scope);
  const exec = deps.exec ?? execBin;

  await waitForQuiescence(scope);
  const before = await snapshotConsumers(scope);
  const replays: ReplayRun[] = [];
  for (const target of targets) {
    const { code, stdout } = await exec(target.file, ['replay', '--since', since], { cwd: target.cwd, env: target.env });
    replays.push({ service: target.service, exitCode: code, summary: lastJsonLine(stdout) });
  }
  await waitForQuiescence(scope);
  const after = await snapshotConsumers(scope);

  const differences = [
    ...inboxDifferences(before.inboxCounts, after.inboxCounts),
    ...diffRecords(before.aggregateChecksums, after.aggregateChecksums, (a, b) => a.rows === b.rows && a.checksum === b.checksum),
  ];
  const unchanged = differences.length === 0 && replays.every((run) => run.exitCode === 0);
  return { since, before, after, unchanged, replays, differences };
}
