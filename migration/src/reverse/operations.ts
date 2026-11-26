/** Decides which changelog rows the reverse projector applies, passes over, or holds for a joint multi-participant apply. */
import {
  APPLY_ORIGINS,
  closedEndFrom,
  compareXid,
  formatCursor,
  isApplied,
  lastClosedEnd,
  parseCursor,
  predecessorEnds,
  type ChangeOrigin,
  type ChangeRow,
  type ChangesResponse,
  type OperationStatus,
  type ProjectedChangeRow,
} from '@opt2/platform/migration-kit';

export type { OperationStatus };

/** Origins of rows legacy already holds; the projector passes over them and still advances its cursor. */
export const SKIPPED_ORIGINS: ReadonlySet<ChangeOrigin> = new Set<ChangeOrigin>(APPLY_ORIGINS);

/** What the projector does with one changelog row. */
export type RowDisposition = 'apply' | 'skip-origin' | 'skip-unit' | 'skip-rolled-back' | 'hold';

/** Lookups of `classifyRow`; `isTargetUnit` is false for a row whose table resolves to no unit. */
export interface ClassifyDeps<R extends ChangeRow = ChangeRow> {
  isTargetUnit(row: R): boolean;
  statusOf(operationId: string): OperationStatus | undefined;
}

/** Classifies a row by origin, then unit authority, then operation membership. */
export function classifyRow<R extends ChangeRow>(row: R, deps: ClassifyDeps<R>): RowDisposition {
  if (SKIPPED_ORIGINS.has(row.origin)) return 'skip-origin';
  if (!deps.isTargetUnit(row)) return 'skip-unit';
  if (row.operationId === null) return 'apply';
  // A done operation is held as well: the tracker releases every participant's rows into one legacy transaction.
  return deps.statusOf(row.operationId) === 'rolled-back' ? 'skip-rolled-back' : 'hold';
}

/** Checkpoint a parked stream takes once its held rows are applied or passed over. */
export interface HeldStreamState {
  /** Cursor of the last row of the held run; the split's own when rows before the run wait for it. */
  endCursor: string;
  /** Applied horizon once the held run is consumed; never claims a transaction with unread or waiting rows. */
  appliedHorizon: string;
  /** True when the page showed the end of the held run, so none of its rows is unread. */
  complete: boolean;
}

/** The contiguous rows of one operation's transaction that stopped a stream. */
export interface HeldOperation<R extends ChangeRow = ProjectedChangeRow> extends HeldStreamState {
  operationId: string;
  xid: string;
  /** Held rows of the run, in `(xid, seq)` order. */
  rows: R[];
  /** Rows of the run passed over by origin or unit. */
  skipped: number;
}

/** Result of `splitAtHold`; `endCursor` and `appliedHorizon` are the checkpoint of the `applicable` batch. */
export interface PageSplit<R extends ChangeRow = ProjectedChangeRow> {
  applicable: R[];
  skipped: number;
  held?: HeldOperation<R>;
  endCursor: string;
  appliedHorizon: string;
}

/** The fields of a changes page `splitAtHold` reads; a `ChangesResponse` satisfies it. */
export type ChangesPageView<R extends ChangeRow = ProjectedChangeRow> = Pick<ChangesResponse, 'cursor' | 'horizon' | 'complete'> & {
  rows: readonly R[];
};

/** Cursor text of a changelog row. */
export function cursorOf(row: Pick<ChangeRow, 'xid' | 'seq'>): string {
  return formatCursor({ xid: BigInt(row.xid), seq: BigInt(row.seq) });
}

/** Orders cursor texts by `(xid, seq)`. */
export function compareCursors(a: string, b: string): -1 | 0 | 1 {
  const left = parseCursor(a);
  const right = parseCursor(b);
  if (left.xid !== right.xid) return left.xid < right.xid ? -1 : 1;
  return left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0;
}

/**
 * Index of the page's first held row, and of the first row that waits for it: that row, or an earlier one whose
 * same-row predecessor sits at or after it; both the page length when no row is held.
 */
function waitStart<R extends ChangeRow>(rows: readonly R[], classify: (row: R) => RowDisposition): { held: number; start: number } {
  const held = rows.findIndex((row) => classify(row) === 'hold');
  if (held < 0) return { held: rows.length, start: rows.length };
  return { held, start: lastClosedEnd(predecessorEnds(rows), held) + 1 };
}

/**
 * Splits a page at its first held row: rows before it are applied or skipped, the run from it is held, and rows before
 * it that need a row from it on wait with it.
 * @param storedCursor checkpoint cursor the page was read after; the end cursor when nothing is consumed.
 */
export function splitAtHold<R extends ChangeRow>(
  page: ChangesPageView<R>,
  classify: (row: R) => RowDisposition,
  storedCursor: string,
): PageSplit<R> {
  const { held, start } = waitStart(page.rows, classify);
  const applicable: R[] = [];
  let skipped = 0;
  let consumed: R | undefined;
  for (const row of page.rows.slice(0, start)) {
    if (classify(row) === 'apply') applicable.push(row);
    else skipped += 1;
    consumed = row;
  }
  const first = page.rows[start];
  if (first === undefined) return { applicable, skipped, endCursor: page.cursor, appliedHorizon: readHorizon(page) };
  const endCursor = consumed === undefined ? storedCursor : cursorOf(consumed);
  const run = heldRun(page, held, classify);
  // Passing over a run that earlier rows wait for leaves the stream at this split, so its re-run applies those rows.
  return { applicable, skipped, held: start < held ? { ...run, endCursor, appliedHorizon: first.xid } : run, endCursor, appliedHorizon: first.xid };
}

/** Horizon below which a page returned every row: its horizon when complete, else its last row's xid. */
export function readHorizon(page: ChangesPageView<ChangeRow>): string {
  const last = page.rows.at(-1);
  return page.complete || last === undefined ? page.horizon : last.xid;
}

/** Collects the run of rows sharing the held row's operation and transaction. */
function heldRun<R extends ChangeRow>(page: ChangesPageView<R>, start: number, classify: (row: R) => RowDisposition): HeldOperation<R> {
  const first = page.rows[start] as R;
  const operationId = first.operationId;
  if (operationId === null) throw new TypeError(`Held changelog row ${cursorOf(first)} carries no operationId`);
  const rows: R[] = [];
  let skipped = 0;
  let end = start;
  for (; end < page.rows.length; end += 1) {
    const row = page.rows[end] as R;
    if (row.operationId !== operationId || compareXid(row.xid, first.xid) !== 0) break;
    if (classify(row) === 'hold') rows.push(row);
    else skipped += 1;
  }
  const next: ChangeRow | undefined = page.rows[end];
  const complete = next !== undefined || page.complete;
  return {
    operationId,
    xid: first.xid,
    rows,
    skipped,
    complete,
    endCursor: cursorOf(page.rows[end - 1] as R),
    appliedHorizon: next !== undefined ? next.xid : complete ? page.horizon : first.xid,
  };
}

/** Owners whose rows of one roster operation reach legacy together: people coordinates, identity participates. */
export const ROSTER_PARTICIPANTS: readonly string[] = Object.freeze(['people', 'identity']);

/** One stream's rows to apply or pass over, and the checkpoint state the stream resumes from. */
export interface ParkedPart<S extends HeldStreamState = HeldStreamState, R extends ChangeRow = ProjectedChangeRow> {
  owner: string;
  tenantId: string;
  rows: R[];
  streamState: S;
}

/** A parked operation passed over; `operationIds` is `[operationId]`, `rows` merges parts' rows by `(xid, seq)`. */
export interface TrackedOperation<S extends HeldStreamState = HeldStreamState, R extends ChangeRow = ProjectedChangeRow> {
  operationId: string;
  operationIds: string[];
  parts: ParkedPart<S, R>[];
  rows: R[];
}

/** One stream's span of a ready release; re-read after its checkpoint through `streamState.endCursor`, it holds exactly `held`. */
export interface ReadyPart<S extends HeldStreamState = HeldStreamState> {
  owner: string;
  tenantId: string;
  streamState: S;
  held: ScanEntry[];
}

/** Operations applied together in one legacy transaction; `operationIds` starts with `operationId`. */
export interface ReadyOperation<S extends HeldStreamState = HeldStreamState> {
  operationId: string;
  operationIds: string[];
  parts: ReadyPart<S>[];
}

/**
 * A held row of a scan: its position, the cursor before it, its operation, the cursor `through` which its release
 * applies so that no row up to it needs a later same-row predecessor, and the xid of the row after `through` once read.
 */
export interface ScanEntry {
  cursor: string;
  previous: string;
  xid: string;
  operationId: string;
  through: string;
  next: string | undefined;
}

/**
 * A contiguous read of one tenant stream after `start` through `end`, below `horizon`, keeping only its held rows;
 * rows before the first held one that wait for it are re-read from `start`, the stream's checkpoint.
 */
export interface StreamScan {
  owner: string;
  tenantId: string;
  start: string;
  end: string;
  horizon: string;
  entries: ScanEntry[];
}

/** A one-row read after `after` reporting `operationId`'s status as `owner` sees it. */
export interface StatusRead {
  owner: string;
  tenantId: string;
  after: string;
  operationId: string;
}

/** Thrown when re-reading a ready span does not end at its end cursor or holds other rows than its scan held. */
export class HeldSpanChangedError extends Error {
  override readonly name = 'HeldSpanChangedError';

  constructor(
    readonly owner: string,
    readonly tenantId: string,
    readonly endCursor: string,
  ) {
    super(`Re-reading the held span of ${owner} for tenant ${tenantId} through ${endCursor} returned other rows than its scan held`);
  }
}

/** A ready part's re-read span rows to apply; throws HeldSpanChangedError unless they end at its end and hold exactly its held rows. */
export function releasedRows<R extends ChangeRow>(part: ReadyPart, rows: readonly R[], classify: (row: R) => RowDisposition): R[] {
  const classified = rows.map((row) => ({ row, disposition: classify(row) }));
  const held = classified.filter(({ disposition }) => disposition === 'hold');
  const found = held.map(({ row }) => `${cursorOf(row)} ${String(row.operationId)}`).join();
  const last = rows.at(-1);
  const matches = found === part.held.map((entry) => `${entry.cursor} ${entry.operationId}`).join();
  if (last === undefined || cursorOf(last) !== part.streamState.endCursor || !matches) {
    throw new HeldSpanChangedError(part.owner, part.tenantId, part.streamState.endCursor);
  }
  return classified.filter(({ disposition }) => disposition === 'apply' || disposition === 'hold').map(({ row }) => row);
}

/**
 * A parked operation not yet ready: participants with no part, owners with a part not proven fully read,
 * owners without one not proven to hold no unread rows of it, and the other operations of its closure holding it back.
 */
export interface WaitingOperation {
  operationId: string;
  status: OperationStatus | undefined;
  missing: string[];
  incomplete: string[];
  unproven: string[];
  blockedBy: string[];
}

/** A done operation and an owner whose `/position` the projector must read for `noteFence`. */
export interface FenceRequest {
  operationId: string;
  owner: string;
}

/**
 * A scan's entries through index `last` that one release applies, the entry `end` whose `through` and `next` checkpoint
 * it, and the part parked at its `head`, its first entry's operation.
 */
interface Span<S extends HeldStreamState, R extends ChangeRow> {
  scan: StreamScan;
  last: number;
  end: ScanEntry;
  head: string;
  parked: ParkedPart<S, R> | undefined;
}

/** Operations whose rows reach legacy in one transaction, the tenants and owners proving them read, and each stream's span. */
interface Closure<S extends HeldStreamState, R extends ChangeRow> {
  ids: Set<string>;
  tenants: Set<string>;
  owners: Set<string>;
  spans: Map<string, Span<S, R>>;
}

/** Settings of `OperationTracker`; an `OperationStatus` names no participants, so they come from here, default `ROSTER_PARTICIPANTS`. */
export interface OperationTrackerOptions {
  participants?: readonly string[];
}

const STATUS_RANK: Readonly<Record<OperationStatus, number>> = { done: 0, open: 1, 'rolled-back': 2 };

/**
 * Parks streams stopped at multi-participant operations and releases each closure of done operations sharing a stream
 * once every owner's scans in the closure's tenants have passed that owner's fence of each of them.
 * Per cycle: `restoreScan` the scans an earlier cycle saved; `park` each stopped stream; `noteStatuses` and `noteScan`
 * for every page read, read-ahead pages included, and `rebase` each committed checkpoint; read each `statusReads` entry;
 * until `fencesNeeded` is empty, `noteFence` each entry from its owner's `/position` and read that owner's streams ahead
 * past its `fenceBound`; then re-read each `ready` release's spans, apply their `releasedRows` with every part's checkpoint
 * in one legacy transaction and `release` each of its `operationIds`; pass over and `release` each `rolledBack` operation;
 * keep each `savedScan`; `clear`.
 */
export class OperationTracker<S extends HeldStreamState = HeldStreamState, R extends ChangeRow = ProjectedChangeRow> {
  readonly participants: readonly string[];
  readonly #statuses = new Map<string, OperationStatus>();
  /** Operations each owner reported this cycle. */
  readonly #reported = new Map<string, Set<string>>();
  readonly #parked = new Map<string, Map<string, ParkedPart<S, R>>>();
  readonly #fences = new Map<string, Map<string, string>>();
  readonly #scans = new Map<string, StreamScan>();

  constructor({ participants = ROSTER_PARTICIPANTS }: OperationTrackerOptions = {}) {
    this.participants = Object.freeze([...new Set(participants)]);
  }

  /** Records the owner's tenant stream stopped at `operationId`; parking the same stream again appends its rows. */
  park(owner: string, tenantId: string, operationId: string, rows: readonly R[], streamState: S): void {
    let parts = this.#parked.get(operationId);
    if (parts === undefined) {
      parts = new Map();
      this.#parked.set(operationId, parts);
    }
    const key = streamKey(owner, tenantId);
    const part = parts.get(key);
    if (part === undefined) {
      parts.set(key, { owner, tenantId, rows: [...rows], streamState });
    } else {
      part.rows.push(...rows);
      part.streamState = streamState;
    }
  }

  /**
   * Records a reported status; rolled-back outranks open, which outranks done, so done needs every report to agree.
   * A merged status other than done drops the operation's fences.
   */
  noteStatus(operationId: string, status: OperationStatus): void {
    const known = this.#statuses.get(operationId);
    if (known === undefined || STATUS_RANK[status] > STATUS_RANK[known]) this.#statuses.set(operationId, status);
    if (this.#statuses.get(operationId) !== 'done') this.#fences.delete(operationId);
  }

  /** Records every status of a changes page's `operations` map, as reported by `owner` when given. */
  noteStatuses(operations: Readonly<Record<string, OperationStatus>>, owner?: string): void {
    for (const [operationId, status] of Object.entries(operations)) this.noteStatus(operationId, status);
    if (owner === undefined) return;
    const reported = this.#reported.get(owner) ?? new Set<string>();
    for (const operationId of Object.keys(operations)) reported.add(operationId);
    this.#reported.set(owner, reported);
  }

  /** Merged status of an operation; undefined when none was reported this cycle. */
  statusOf(operationId: string): OperationStatus | undefined {
    return this.#statuses.get(operationId);
  }

  /**
   * Records a page of the owner's tenant stream, keeping its held rows: it extends the scan read on from its end, leaves it
   * for a re-read from its start ending within it, else starts a fresh scan, whose `after` must be the stream's checkpoint.
   * Each held row's `through` stays within its page, since the changes feed closes every page over same-row predecessors.
   */
  noteScan(owner: string, tenantId: string, after: string, page: ChangesPageView<R>, classify: (row: R) => RowDisposition): void {
    const key = streamKey(owner, tenantId);
    const known = this.#scans.get(key);
    if (known?.start === after && known.end !== after && compareCursors(page.cursor, known.end) <= 0) return;
    const fresh = (): StreamScan => ({ owner, tenantId, start: after, end: after, horizon: page.horizon, entries: [] });
    const scan = known?.end === after ? known : fresh();
    const firstXid = page.rows[0]?.xid;
    for (let index = scan.entries.length - 1; firstXid !== undefined && index >= 0; index -= 1) {
      const entry = scan.entries[index] as ScanEntry;
      if (entry.next !== undefined) break;
      entry.next = firstXid;
    }
    let ends: number[] | undefined;
    let previous = after;
    for (const [index, row] of page.rows.entries()) {
      const cursor = cursorOf(row);
      if (classify(row) === 'hold' && row.operationId !== null) {
        ends ??= predecessorEnds(page.rows);
        const end = closedEndFrom(ends, index);
        const through = cursorOf(page.rows[end] as R);
        scan.entries.push({ cursor, previous, xid: row.xid, operationId: row.operationId, through, next: page.rows[end + 1]?.xid });
      }
      previous = cursor;
    }
    scan.end = page.cursor;
    scan.horizon = readHorizon(page);
    this.#scans.set(key, scan);
  }

  /** Moves a scan's start to its stream's new checkpoint, dropping the held rows it passed; forgets a scan the checkpoint passed. */
  rebase(owner: string, tenantId: string, checkpoint: string): void {
    const key = streamKey(owner, tenantId);
    const scan = this.#scans.get(key);
    if (scan === undefined) return;
    if (compareCursors(checkpoint, scan.end) > 0) {
      this.#scans.delete(key);
      return;
    }
    const kept = scan.entries.findIndex((entry) => compareCursors(entry.cursor, checkpoint) > 0);
    scan.entries.splice(0, kept < 0 ? scan.entries.length : kept);
    scan.start = checkpoint;
  }

  /** The owner's tenant stream scan as far as it is read; undefined when none is kept. */
  scanOf(owner: string, tenantId: string): Readonly<StreamScan> | undefined {
    return this.#scans.get(streamKey(owner, tenantId));
  }

  /** Takes over a scan an earlier cycle saved, read after its stream's current checkpoint. */
  restoreScan(scan: StreamScan): void {
    this.#scans.set(streamKey(scan.owner, scan.tenantId), { ...scan, entries: scan.entries.map((entry) => ({ ...entry })) });
  }

  /** A copy of the stream's scan for a later cycle, without the held rows of operations now rolled back. */
  savedScan(owner: string, tenantId: string): StreamScan | undefined {
    const scan = this.#scans.get(streamKey(owner, tenantId));
    if (scan === undefined) return undefined;
    return { ...scan, entries: scan.entries.filter((entry) => this.#liveHold(entry) !== undefined).map((entry) => ({ ...entry })) };
  }

  /** Forgets the stream's scan. */
  dropScan(owner: string, tenantId: string): void {
    this.#scans.delete(streamKey(owner, tenantId));
  }

  /** One read per owner and operation of a kept, not rolled-back held row whose status that owner has not reported this cycle. */
  statusReads(): StatusRead[] {
    const reads = new Map<string, StatusRead>();
    for (const scan of this.#scans.values()) {
      for (const { operationId, previous } of scan.entries) {
        const key = streamKey(scan.owner, operationId);
        const known = reads.has(key) || this.#reported.get(scan.owner)?.has(operationId) === true;
        if (known || this.#statuses.get(operationId) === 'rolled-back') continue;
        reads.set(key, { owner: scan.owner, tenantId: scan.tenantId, after: previous, operationId });
      }
    }
    return [...reads.values()];
  }

  /** Owners without a fence of each done operation, for every closure of the parked and scanned operations. */
  fencesNeeded(): FenceRequest[] {
    const needed = new Map<string, FenceRequest>();
    for (const seed of this.#known()) {
      const { ids, owners } = this.#closure(seed);
      for (const operationId of ids) {
        if (this.#statuses.get(operationId) !== 'done') continue;
        for (const owner of owners) {
          if (this.#fences.get(operationId)?.has(owner) !== true) needed.set(streamKey(operationId, owner), { operationId, owner });
        }
      }
    }
    return [...needed.values()];
  }

  /**
   * Records `owner`'s `/position`, read after `operationId` was reported done, as the bound of that owner's xids for it;
   * ignored unless the merged status is done; the lowest fence is kept.
   * @throws TypeError when `position` is not a canonical decimal xid8.
   */
  noteFence(operationId: string, owner: string, position: string): void {
    const xid = canonicalXid(position);
    if (this.#statuses.get(operationId) !== 'done') return;
    let fences = this.#fences.get(operationId);
    if (fences === undefined) {
      fences = new Map();
      this.#fences.set(operationId, fences);
    }
    const known = fences.get(owner);
    if (known === undefined || compareXid(xid, known) < 0) fences.set(owner, xid);
  }

  /** Highest fence of `owner` among the done operations of parked closures, which its scans must pass; undefined when none is noted. */
  fenceBound(owner: string): string | undefined {
    let bound: string | undefined;
    for (const seed of this.#parked.keys()) {
      const { ids, owners } = this.#closure(seed);
      if (!owners.has(owner)) continue;
      for (const id of ids) {
        const fence = this.#statuses.get(id) === 'done' ? this.#fences.get(id)?.get(owner) : undefined;
        if (fence !== undefined && (bound === undefined || compareXid(fence, bound) > 0)) bound = fence;
      }
    }
    return bound;
  }

  /**
   * One release per ready closure of a parked done operation: each part holds its stream span's live held rows,
   * and its `streamState` checkpoints the span's last row with the next row's xid, or the scan horizon, as applied horizon.
   */
  ready(): ReadyOperation<S>[] {
    return this.#evaluate().released;
  }

  /** Parked operations now rolled back; their streams advance past the rows without applying them. */
  rolledBack(): TrackedOperation<S, R>[] {
    return [...this.#parked]
      .filter(([operationId]) => this.#statuses.get(operationId) === 'rolled-back')
      .map(([operationId, parts]) => {
        const list = [...parts.values()];
        const rows = list.flatMap((part) => part.rows).sort(byPosition);
        return { operationId, operationIds: [operationId], parts: list, rows };
      });
  }

  /** Parked operations neither ready nor rolled back, with what each still waits for. */
  waiting(): WaitingOperation[] {
    const { emitted } = this.#evaluate();
    return [...this.#parked]
      .filter(([operationId]) => !emitted.has(operationId) && this.#statuses.get(operationId) !== 'rolled-back')
      .map(([operationId, parts]) => {
        const closure = this.#closure(operationId);
        const blocked = this.#blockers(closure, emitted);
        const blockedBy = [...closure.ids].filter((id) => id !== operationId && blocked.has(id));
        return { operationId, status: this.#statuses.get(operationId), ...this.#gaps(operationId, parts, closure), blockedBy };
      });
  }

  /**
   * Forgets the parked parts and fences of an operation, and the scans of the streams parked at it, once those streams
   * moved past it; its status stays known for the cycle.
   */
  release(operationId: string): void {
    for (const key of this.#parked.get(operationId)?.keys() ?? []) this.#scans.delete(key);
    this.#parked.delete(operationId);
    this.#fences.delete(operationId);
  }

  /** Forgets every part, status, report and scan at the end of a cycle; fences of done operations stay valid and are kept. */
  clear(): void {
    this.#parked.clear();
    this.#statuses.clear();
    this.#reported.clear();
    this.#scans.clear();
  }

  /** Ready releases in parked order, each closure once and none sharing an operation, and the operations they release. */
  #evaluate(): { released: ReadyOperation<S>[]; emitted: Set<string> } {
    const released: ReadyOperation<S>[] = [];
    const emitted = new Set<string>();
    for (const seed of this.#parked.keys()) {
      if (emitted.has(seed) || this.#statuses.get(seed) !== 'done') continue;
      const closure = this.#closure(seed);
      if (this.#blockers(closure, emitted).size > 0) continue;
      for (const id of closure.ids) emitted.add(id);
      released.push(this.#releaseOf(seed, closure));
    }
    return { released, emitted };
  }

  /**
   * Grows `seed` to a fixpoint: a scan holding an unrolled-back row of the closure spans from its first waiting row
   * through the `through` of the closure's last such entry, so no row of the span needs a later same-row predecessor,
   * and the head operation and every other unrolled-back held operation of that span join.
   */
  #closure(seed: string): Closure<S, R> {
    const ids = new Set([seed]);
    const spans = new Map<string, Span<S, R>>();
    const inClosure = (entry: ScanEntry): boolean => {
      const id = this.#liveHold(entry);
      return id !== undefined && ids.has(id);
    };
    for (let grown = true; grown; ) {
      grown = false;
      for (const [key, scan] of this.#scans) {
        const head = scan.entries[0]?.operationId;
        const end = scan.entries.findLast(inClosure);
        if (head === undefined || end === undefined) continue;
        // `through` never decreases along a scan, so the closure's last entry ends the span.
        const last = scan.entries.findLastIndex((entry) => compareCursors(entry.cursor, end.through) <= 0);
        spans.set(key, { scan, last, end, head, parked: this.#parked.get(head)?.get(key) });
        const joining = [head, ...scan.entries.slice(1, last + 1).map((entry) => this.#liveHold(entry))];
        for (const id of joining) {
          if (id === undefined || ids.has(id)) continue;
          ids.add(id);
          grown = true;
        }
      }
    }
    const tenants = new Set<string>();
    const owners = new Set(this.participants);
    for (const id of ids) {
      for (const part of this.#parked.get(id)?.values() ?? []) {
        tenants.add(part.tenantId);
        owners.add(part.owner);
      }
    }
    for (const { scan } of spans.values()) {
      tenants.add(scan.tenantId);
      owners.add(scan.owner);
    }
    return { ids, tenants, owners, spans };
  }

  /** Operations of a closure keeping it from release: not done, already released, not read through, or heading a span with no park. */
  #blockers({ ids, tenants, owners, spans }: Closure<S, R>, emitted: ReadonlySet<string>): Set<string> {
    const blockers = new Set<string>();
    for (const id of ids) {
      const readThrough = [...owners].every((owner) => this.#readThrough(id, owner, tenants));
      if (emitted.has(id) || this.#statuses.get(id) !== 'done' || !readThrough) blockers.add(id);
    }
    for (const span of spans.values()) {
      if (span.parked === undefined) blockers.add(span.head);
    }
    return blockers;
  }

  /** The release of a ready closure: per span, its live held rows, all of the closure, checkpointed just past the span. */
  #releaseOf(seed: string, { ids, spans }: Closure<S, R>): ReadyOperation<S> {
    const parts = [...spans.values()].map(({ scan, last, end, parked }): ReadyPart<S> => {
      // A span without a park blocks its closure.
      const streamState = {
        ...(parked as ParkedPart<S, R>).streamState,
        endCursor: end.through,
        appliedHorizon: end.next ?? scan.horizon,
        complete: true,
      };
      const held = scan.entries.slice(0, last + 1).filter((entry) => this.#liveHold(entry) !== undefined);
      return { owner: scan.owner, tenantId: scan.tenantId, streamState, held };
    });
    return { operationId: seed, operationIds: [...ids], parts };
  }

  /**
   * Gaps of a waiting operation over its closure's owners and tenants: owners with a part not read through,
   * and owners without one not read through or whose scans hold a row of it.
   */
  #gaps(
    operationId: string,
    parts: ReadonlyMap<string, ParkedPart<S, R>>,
    { owners, tenants }: Closure<S, R>,
  ): Pick<WaitingOperation, 'missing' | 'incomplete' | 'unproven'> {
    const parked = new Set([...parts.values()].map((part) => part.owner));
    const unread = [...owners].filter((owner) => !this.#readThrough(operationId, owner, tenants));
    return {
      missing: this.participants.filter((owner) => !parked.has(owner)),
      incomplete: unread.filter((owner) => parked.has(owner)),
      unproven: [...owners].filter((owner) => !parked.has(owner) && (unread.includes(owner) || this.#holds(owner, operationId))),
    };
  }

  /** True when `owner` has a fence of the operation, its scan in every tenant is past it, and those scans hold every row it parked. */
  #readThrough(operationId: string, owner: string, tenants: ReadonlySet<string>): boolean {
    const fence = this.#fences.get(operationId)?.get(owner);
    if (fence === undefined) return false;
    for (const tenantId of tenants) {
      const scan = this.#scans.get(streamKey(owner, tenantId));
      if (scan === undefined || !isApplied(fence, scan.horizon)) return false;
    }
    for (const [key, part] of this.#parked.get(operationId) ?? []) {
      if (part.owner !== owner) continue;
      const scanned = new Set(this.#scans.get(key)?.entries.map((entry) => entry.cursor));
      if (!part.rows.every((row) => scanned.has(cursorOf(row)))) return false;
    }
    return true;
  }

  /** True when a scan of `owner` held a row of the operation. */
  #holds(owner: string, operationId: string): boolean {
    const holds = (scan: StreamScan): boolean => scan.owner === owner && scan.entries.some((entry) => entry.operationId === operationId);
    return [...this.#scans.values()].some(holds);
  }

  /** The operation of a held row unless it is rolled back since. */
  #liveHold({ operationId }: ScanEntry): string | undefined {
    return this.#statuses.get(operationId) !== 'rolled-back' ? operationId : undefined;
  }

  /** Parked operations, then operations held by a scanned row, in first-seen order. */
  #known(): Set<string> {
    const known = new Set(this.#parked.keys());
    for (const scan of this.#scans.values()) {
      for (const { operationId } of scan.entries) known.add(operationId);
    }
    return known;
  }
}

function streamKey(owner: string, tenantId: string): string {
  return JSON.stringify([owner, tenantId]);
}

/** Returns `text` as a canonical decimal xid8; throws TypeError otherwise. */
function canonicalXid(text: string): string {
  try {
    return parseCursor(`${text}:0`).xid.toString();
  } catch (error) {
    throw new TypeError(`Invalid xid ${JSON.stringify(text)}`, { cause: error });
  }
}

function byPosition(a: ChangeRow, b: ChangeRow): number {
  const xid = compareXid(a.xid, b.xid);
  if (xid !== 0) return xid;
  const left = BigInt(a.seq);
  const right = BigInt(b.seq);
  return left < right ? -1 : left > right ? 1 : 0;
}
