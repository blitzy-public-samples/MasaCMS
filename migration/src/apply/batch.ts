/** Batching of backfill and feed applies: deterministic batch ids, per-tenant owner batchers, the applier-killed fault and tenant wiring. */
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { writeSync } from 'node:fs';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  MIGRATION_PATH_PREFIX,
  programTableName,
  sha256Hex,
  type ApplyRequest,
  type ChangeOrigin,
  type WatermarkRecord,
} from '@opt2/platform/migration-kit';
import { z } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';

import type { MigrationConfig } from '../config.js';
import type { MigrationContext } from '../context.js';
import { parseQualifiedName } from '../extract/index.js';
import type { ApplyResult, DataOwner, OwnersClient } from '../owners/index.js';
import { createTenantResolver, type TenantResolver } from '../reconcile/index.js';

export type { TenantResolver } from '../reconcile/index.js';

/**
 * What a batch belongs to: backfill pass 1, the backfill deferred-column patch pass, a snapshot-to-snapshot feed, the
 * feed catch-up of a restart, or a re-baseline diff named by its run id (its content depends on the current target state).
 */
export type BatchDirection = 'backfill' | 'backfill-patch' | 'feed' | 'catch-up' | `rebaseline:${string}`;

/** Parts a batch id is derived from; the owner is not one, since each owner records batches in its own schema. */
export interface BatchIdParts {
  direction: BatchDirection;
  snapshotSeq: number;
  legacyTable: string;
  tenantId: string;
  ordinal: number;
}

/** Batch id as SHA-256 hex of its parts: equal parts give equal ids in every process, so a resent batch is an owner-side duplicate. */
export function batchIdFor(parts: BatchIdParts): string {
  return sha256Hex(JSON.stringify([parts.direction, parts.snapshotSeq, parts.legacyTable, parts.tenantId, parts.ordinal]));
}

/** Rows per batch that the shipped configuration sets as `backfill.batchRows`. */
export const DEFAULT_BATCH_SIZE = 1000;

/** Rows per backfill and feed batch, from the required `backfill.batchRows`. */
export function batchSizeOf(config: Pick<MigrationConfig, 'backfill'>): number {
  return config.backfill.batchRows;
}

/** Where the applier-killed fault exits: once the owner acknowledged the batch, or while its apply is in flight. */
export type ApplyFaultPoint = 'acknowledged' | 'in-flight';

/** The applier-killed fault: the process exits with 137 at `point` of its `batch`-th apply, counted from 1. */
export interface ApplyFault {
  point: ApplyFaultPoint;
  batch: number;
}

/** An `apply:` entry of `OPT2_FAULT` is not `apply:kill-after:<n>` or `apply:kill-in-flight:<n>` for a positive integer n, or there are several. */
export class ApplyFaultConfigError extends Error {
  override readonly name = 'ApplyFaultConfigError';
}

/** The owner answered the armed apply before its request body was seen sent, so the in-flight kill point was missed. */
export class InFlightKillMissedError extends Error {
  override readonly name = 'InFlightKillMissedError';
}

const FAULT_PREFIX = 'apply:';
const FAULT_ENTRY = /^apply:kill-(after|in-flight):([1-9]\d{0,14})$/;
// The status of a SIGKILLed process, so the fault reads to supervisors as abrupt process loss.
const KILLED_EXIT_CODE = 137;
const APPLY_PATH = `${MIGRATION_PATH_PREFIX}/apply`;
// Diagnostics channels are process-wide by name, so these see the requests of whichever undici copy the service client loads.
const SEND_HEADERS_CHANNEL = 'undici:client:sendHeaders';
const BODY_SENT_CHANNEL = 'undici:request:bodySent';
const FLUSH_POLL_MS = 1;
const IN_FLIGHT_MARKER = 'apply:kill-in-flight';

/**
 * The apply fault among the comma-separated `OPT2_FAULT` entries; entries of other packages are ignored.
 * @returns null when no entry starts with `apply:`. @throws ApplyFaultConfigError for a malformed or repeated `apply:` entry.
 */
export function parseApplyFault(value: string | undefined): ApplyFault | null {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(FAULT_PREFIX));
  const [entry, ...rest] = entries;
  if (entry === undefined) return null;
  if (rest.length > 0) throw new ApplyFaultConfigError(`OPT2_FAULT holds ${String(entries.length)} apply entries; at most one is allowed`);
  const match = FAULT_ENTRY.exec(entry);
  if (match === null) {
    throw new ApplyFaultConfigError(
      `OPT2_FAULT entry "${entry}" is not apply:kill-after:<positive integer> or apply:kill-in-flight:<positive integer>`,
    );
  }
  const fault: ApplyFault = { point: match[1] === 'after' ? 'acknowledged' : 'in-flight', batch: Number(match[2]) };
  return Object.freeze(fault);
}

/** The apply fault of this process, read from `OPT2_FAULT` once at load. */
export const APPLY_FAULT: ApplyFault | null = parseApplyFault(process.env.OPT2_FAULT);

/** The apply an in-flight kill interrupted, as its stderr marker line names it; `batch` is the apply's ordinal in its run. */
export interface InFlightKill {
  owner: string;
  legacyTable: string;
  batchId: string;
  batch: number;
}

const inFlightKillSchema = z.object({
  fault: z.literal(IN_FLIGHT_MARKER),
  owner: z.string().min(1),
  legacyTable: z.string().min(1),
  batchId: z.string().min(1),
  batch: z.number().int().positive(),
});

/** The marker line an in-flight kill writes to stderr before exiting: one JSON object tagged `fault: apply:kill-in-flight`. */
export function inFlightKillLine(kill: InFlightKill): string {
  return `${JSON.stringify({ fault: IN_FLIGHT_MARKER, ...kill })}\n`;
}

/** The last in-flight kill marker in `text`, for example a killed child's stderr tail; null when it holds none. */
export function parseInFlightKill(text: string): InFlightKill | null {
  for (const line of text.split('\n').reverse()) {
    if (!line.includes(IN_FLIGHT_MARKER)) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = inFlightKillSchema.safeParse(value);
    if (parsed.success) {
      const { owner, legacyTable, batchId, batch } = parsed.data;
      return { owner, legacyTable, batchId, batch };
    }
  }
  return null;
}

/** Sends batches and watermarks to owners for one command run, counting the acknowledged applies. */
export interface BatchSender {
  apply(owner: DataOwner, request: ApplyRequest): Promise<ApplyResult>;
  putWatermark(owner: DataOwner, record: WatermarkRecord): Promise<void>;
  /** Applies the owners answered, duplicates included. */
  readonly acknowledged: number;
}

/** Inputs of {@link createBatchSender}; `fault` defaults to {@link APPLY_FAULT}, `exit` to `process.exit` and `writeMarker` to a synchronous stderr write. */
export interface BatchSenderOptions {
  owners: Pick<OwnersClient, 'apply' | 'putWatermark'>;
  fault?: ApplyFault | null;
  exit?: (code: number) => never;
  writeMarker?: (line: string) => void;
}

/** Whether an undici request is a `POST` to an owner's apply route, whatever its query. */
function isApplyPost(request: unknown): request is object {
  const { method, path } = (request ?? {}) as { method?: unknown; path?: unknown };
  return method === 'POST' && typeof path === 'string' && path.split('?', 1)[0]?.endsWith(APPLY_PATH) === true;
}

/** Resolves once `socket` has handed every queued byte to the kernel, so that exiting cannot truncate the request. */
async function flushed(socket: Writable): Promise<void> {
  while (socket.writableLength > 0 && !socket.destroyed) await sleep(FLUSH_POLL_MS);
}

/** Watches undici for an apply `POST`; `sent` resolves once its whole body has left its socket. */
function watchApplySend(): { sent: Promise<void>; dispose(): void } {
  const sockets = new WeakMap<object, Writable>();
  let markSent: (flushing: Promise<void>) => void = () => undefined;
  const sent = new Promise<void>((resolve) => {
    markSent = resolve;
  });
  const onHeaders = (message: unknown): void => {
    const { request, socket } = message as { request?: unknown; socket?: unknown };
    if (isApplyPost(request) && socket instanceof Writable) sockets.set(request, socket);
  };
  const onBodySent = (message: unknown): void => {
    const { request } = message as { request?: unknown };
    if (!isApplyPost(request)) return;
    const socket = sockets.get(request);
    markSent(socket === undefined ? Promise.resolve() : flushed(socket));
  };
  subscribe(SEND_HEADERS_CHANNEL, onHeaders);
  subscribe(BODY_SENT_CHANNEL, onBodySent);
  return {
    sent,
    dispose() {
      unsubscribe(SEND_HEADERS_CHANNEL, onHeaders);
      unsubscribe(BODY_SENT_CHANNEL, onBodySent);
    },
  };
}

/** Creates a sender that calls each owner once per batch, without retries, and exits with 137 at the fault's point of its armed batch. */
export function createBatchSender(opts: BatchSenderOptions): BatchSender {
  const {
    owners,
    fault = APPLY_FAULT,
    exit = (code: number): never => process.exit(code),
    writeMarker = (line: string): void => {
      writeSync(2, line);
    },
  } = opts;
  let started = 0;
  let acknowledged = 0;

  /** Sends the armed apply and exits once its request body has been sent, before the owner answers it. */
  const applyInFlight = async (owner: DataOwner, request: ApplyRequest, batch: number): Promise<ApplyResult> => {
    const watch = watchApplySend();
    try {
      const answered = owners.apply(owner, request).then((result) => ({ result }));
      // Exits here, not in a channel subscriber, whose throw Node rethrows as an uncaught exception.
      if ((await Promise.race([watch.sent.then(() => null), answered])) !== null) {
        throw new InFlightKillMissedError(
          `${owner} answered apply ${String(batch)} (${request.batchId}) before undici reported its POST ${APPLY_PATH} body sent`,
        );
      }
      writeMarker(inFlightKillLine({ owner, legacyTable: request.legacyTable, batchId: request.batchId, batch }));
      return exit(KILLED_EXIT_CODE);
    } finally {
      watch.dispose();
    }
  };

  return {
    async apply(owner, request) {
      started += 1;
      if (fault?.point === 'in-flight' && started === fault.batch) return applyInFlight(owner, request, started);
      const result = await owners.apply(owner, request);
      acknowledged += 1;
      if (fault?.point === 'acknowledged' && acknowledged === fault.batch) exit(KILLED_EXIT_CODE);
      return result;
    },
    async putWatermark(owner, record) {
      await owners.putWatermark(owner, record);
    },
    get acknowledged() {
      return acknowledged;
    },
  };
}

/** One row of an apply batch. */
export type ApplyChange = ApplyRequest['rows'][number];

/** One column the rows of an apply batch are encoded over. */
export type ApplyColumn = ApplyRequest['columns'][number];

/** Inputs of {@link createOwnerBatcher}. */
export interface OwnerBatcherOptions {
  owner: DataOwner;
  /** Ownership-file name of the table; folded tables keep their `Program_N` name and pass program ids to `add`. */
  legacyTable: string;
  direction: BatchDirection;
  snapshotSeq: number;
  origin: Extract<ChangeOrigin, 'backfill' | 'migration-feed'>;
  /** Columns every change's `row` is encoded over. */
  columns: readonly ApplyColumn[];
  /** Units the owner may write; absent lets it write every unit it maps the table to. */
  units?: readonly string[];
  batchSize: number;
  sender: BatchSender;
  watermark: WatermarkRecord | null;
}

/** Outcome of one owner batcher; `watermark` says whether it rode on the last batch, was put alone, or there was none. */
export interface OwnerBatchStats {
  owner: DataOwner;
  legacyTable: string;
  batches: number;
  changes: number;
  /** Changes per tenant id. */
  perTenant: Record<string, number>;
  watermark: 'batch' | 'putWatermark' | 'none';
}

/** Buffers one owner's changes of one table per tenant (and program) and sends them as batches. */
export interface OwnerBatcher {
  /** Adds one change; await each call. `legacyProgramId` is required for the rows of a folded table and absent otherwise. */
  add(tenantId: string, change: ApplyChange, legacyProgramId?: number): Promise<void>;
  /** Sends what is buffered, then the watermark; the batcher takes no change afterwards. */
  finish(): Promise<OwnerBatchStats>;
}

/** Changes of one tenant and program; `table` is the legacy table its requests name. */
interface Partition {
  readonly tenantId: string;
  readonly legacyProgramId: number | undefined;
  readonly table: string;
  rows: ApplyChange[];
  nextOrdinal: number;
}

interface ReadyBatch {
  readonly partition: Partition;
  readonly ordinal: number;
  readonly rows: ApplyChange[];
}

/** The `POST /apply` form of a watermark: no table, which is the batch's own, and an unknown sequence or LSN absent rather than null. */
function carriedWatermark(record: WatermarkRecord): NonNullable<ApplyRequest['watermark']> {
  return {
    direction: record.direction,
    finishedAt: record.finishedAt,
    ...(record.snapshotSeq === null ? {} : { snapshotSeq: record.snapshotSeq }),
    ...(record.backupLsn === null ? {} : { backupLsn: record.backupLsn }),
  };
}

function comparePartitions(a: Partition, b: Partition): number {
  if (a.tenantId !== b.tenantId) return a.tenantId < b.tenantId ? -1 : 1;
  return (a.legacyProgramId ?? -1) - (b.legacyProgramId ?? -1);
}

/** Batches' worth of rows an owner batcher buffers across its partitions, besides the held batch. */
export const BUFFERED_BATCHES = 4;

/**
 * Creates a batcher that forms a batch whenever a partition reaches `batchSize`, or from its least recently fed partition
 * once more than `batchSize * BUFFERED_BATCHES` rows are buffered. It holds the newest ready batch back so that the final
 * batch sent can carry the watermark and the owner writes it in that batch's transaction.
 */
export function createOwnerBatcher(opts: OwnerBatcherOptions): OwnerBatcher {
  const { owner, legacyTable, direction, snapshotSeq, origin, batchSize, sender, watermark } = opts;
  const columns = [...opts.columns];
  const units = opts.units === undefined ? undefined : [...opts.units];
  const partitions = new Map<string, Partition>();
  // Partitions holding rows, least recently fed first.
  const buffered = new Set<Partition>();
  const budget = batchSize * BUFFERED_BATCHES;
  let bufferedRows = 0;
  const perTenant: Record<string, number> = {};
  let held: ReadyBatch | null = null;
  let batches = 0;
  let changes = 0;
  let finished = false;

  // A folded table's rows go to the owner per `Program_<id>` table, whose name the owner records batches and watermarks under.
  const tableFor = (legacyProgramId: number | undefined): string =>
    legacyProgramId === undefined ? legacyTable : programTableName(legacyProgramId, parseQualifiedName(legacyTable).table);

  const partitionFor = (tenantId: string, legacyProgramId: number | undefined): Partition => {
    const key = JSON.stringify([tenantId, legacyProgramId ?? null]);
    let partition = partitions.get(key);
    if (partition === undefined) {
      partition = { tenantId, legacyProgramId, table: tableFor(legacyProgramId), rows: [], nextOrdinal: 0 };
      partitions.set(key, partition);
    }
    return partition;
  };

  const take = (partition: Partition): ReadyBatch => {
    const batch: ReadyBatch = { partition, ordinal: partition.nextOrdinal, rows: partition.rows };
    partition.nextOrdinal += 1;
    partition.rows = [];
    return batch;
  };

  const send = async (batch: ReadyBatch, mark: WatermarkRecord | null): Promise<void> => {
    const { tenantId, legacyProgramId, table } = batch.partition;
    const request: ApplyRequest = {
      batchId: batchIdFor({ direction, snapshotSeq, legacyTable: table, tenantId, ordinal: batch.ordinal }),
      origin,
      legacyTable: table,
      tenantId,
      ...(legacyProgramId === undefined ? {} : { legacyProgramId }),
      columns,
      ...(units === undefined ? {} : { units }),
      rows: batch.rows,
      ...(mark === null ? {} : { watermark: carriedWatermark(mark) }),
    };
    await sender.apply(owner, request);
    batches += 1;
  };

  // Makes the partition's rows the held batch and sends the batch held before it.
  const emit = async (partition: Partition): Promise<void> => {
    buffered.delete(partition);
    bufferedRows -= partition.rows.length;
    const previous = held;
    held = take(partition);
    if (previous !== null) await send(previous, null);
  };

  const assertOpen = (): void => {
    if (finished) throw new Error(`The ${owner} batcher of ${legacyTable} has finished`);
  };

  return {
    async add(tenantId, change, legacyProgramId) {
      assertOpen();
      const partition = partitionFor(tenantId, legacyProgramId);
      partition.rows.push(change);
      changes += 1;
      perTenant[tenantId] = (perTenant[tenantId] ?? 0) + 1;
      bufferedRows += 1;
      buffered.delete(partition);
      buffered.add(partition);
      if (partition.rows.length >= batchSize) {
        await emit(partition);
        return;
      }
      if (bufferedRows <= budget) return;
      const [oldest] = buffered;
      if (oldest !== undefined) await emit(oldest);
    },

    async finish() {
      assertOpen();
      finished = true;
      const remaining = [...partitions.values()].filter((partition) => partition.rows.length > 0).sort(comparePartitions).map(take);
      const pending = held === null ? remaining : [held, ...remaining];
      held = null;
      const last = pending.at(-1);
      // The owner stores a carried watermark under the batch's table, so it rides only on a batch of the watermark's own table.
      const carries = watermark !== null && last !== undefined && last.partition.table === watermark.legacyTable;
      for (const batch of pending) await send(batch, carries && batch === last ? watermark : null);
      let stored: OwnerBatchStats['watermark'] = carries ? 'batch' : 'none';
      if (watermark !== null && !carries) {
        await sender.putWatermark(owner, watermark);
        stored = 'putWatermark';
      }
      return { owner, legacyTable, batches, changes, perTenant: { ...perTenant }, watermark: stored };
    },
  };
}

/** Adds one change to every owner's batcher in map order; each owner of a split table takes its own rows and columns. */
export async function fanOut(
  batchers: ReadonlyMap<DataOwner, OwnerBatcher>,
  tenantId: string,
  change: ApplyChange,
  legacyProgramId?: number,
): Promise<void> {
  for (const batcher of batchers.values()) await batcher.add(tenantId, change, legacyProgramId);
}

/** Tenant id of the umbrella (pool) site, where pooled and orphaned rows land. */
export function umbrellaTenantId(config: Pick<MigrationConfig, 'umbrellaSiteId'>): string {
  return tenantIdForSite(config.umbrellaSiteId);
}

/** Tenant resolver over `opts.database`, the one reconciliation uses, so backfill, feed and reconciliation place rows alike. */
export function createApplyTenantResolver(
  ctx: Pick<MigrationContext, 'legacy' | 'catalog' | 'config'>,
  opts: { database: string },
): Promise<TenantResolver> {
  return createTenantResolver(ctx, { database: opts.database });
}
