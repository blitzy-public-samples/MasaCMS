/** Decides which changelog rows the reverse projector applies, passes over, or holds for a joint multi-participant apply. */
import {
  APPLY_ORIGINS,
  compareXid,
  formatCursor,
  isApplied,
  parseCursor,
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
  /** Cursor of the last row of the held run. */
  endCursor: string;
  /** Applied horizon once the held run is consumed; never claims a transaction with unread rows. */
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

/**
 * Splits a page at its first held row: rows before it are applied or skipped, the run from it is held.
 * @param storedCursor checkpoint cursor the page was read after; the end cursor when nothing is consumed.
 */
export function splitAtHold<R extends ChangeRow>(
  page: ChangesPageView<R>,
  classify: (row: R) => RowDisposition,
  storedCursor: string,
): PageSplit<R> {
  const applicable: R[] = [];
  let skipped = 0;
  let consumed: R | undefined;
  for (const [index, row] of page.rows.entries()) {
    const disposition = classify(row);
    if (disposition === 'hold') {
      return {
        applicable,
        skipped,
        held: heldRun(page, index, classify),
        endCursor: consumed === undefined ? storedCursor : cursorOf(consumed),
        appliedHorizon: row.xid,
      };
    }
    if (disposition === 'apply') applicable.push(row);
    else skipped += 1;
    consumed = row;
  }
  return { applicable, skipped, endCursor: page.cursor, appliedHorizon: readHorizon(page) };
}

/** Horizon below which a page returned every row: its horizon when complete, else its last row's xid. */
function readHorizon(page: ChangesPageView<ChangeRow>): string {
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

/** Operations applied or passed over together; `operationIds` starts with `operationId`, `rows` merges parts' rows by `(xid, seq)`. */
export interface TrackedOperation<S extends HeldStreamState = HeldStreamState, R extends ChangeRow = ProjectedChangeRow> {
  operationId: string;
  operationIds: string[];
  parts: ParkedPart<S, R>[];
  rows: R[];
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

/** A scanned row with its disposition when read. */
interface ScannedRow<R extends ChangeRow> {
  row: R;
  disposition: RowDisposition;
}

/** A cycle's contiguous read of one tenant stream from its checkpoint; `rows` runs from the first held row, of operation `head`. */
interface StreamScan<R extends ChangeRow> {
  owner: string;
  tenantId: string;
  end: string;
  horizon: string;
  head: string | undefined;
  rows: ScannedRow<R>[];
}

/** A scan's rows through index `last` that one release applies, and the part parked at its `head` operation. */
interface Span<S extends HeldStreamState, R extends ChangeRow> {
  scan: StreamScan<R>;
  last: number;
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
 * Per cycle: `park` each stopped stream; `noteStatuses` and `noteScan` for every page read, read-ahead pages included;
 * until `fencesNeeded` is empty, `noteFence` each entry from its owner's `/position` and read that owner's streams ahead
 * past it; then apply each `ready` release's rows with every part's checkpoint in one legacy transaction and `release`
 * each of its `operationIds`; pass over and `release` each `rolledBack` operation; `clear`.
 */
export class OperationTracker<S extends HeldStreamState = HeldStreamState, R extends ChangeRow = ProjectedChangeRow> {
  readonly participants: readonly string[];
  readonly #statuses = new Map<string, OperationStatus>();
  readonly #parked = new Map<string, Map<string, ParkedPart<S, R>>>();
  readonly #fences = new Map<string, Map<string, string>>();
  readonly #scans = new Map<string, StreamScan<R>>();

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

  /** Records every status of a changes page's `operations` map. */
  noteStatuses(operations: Readonly<Record<string, OperationStatus>>): void {
    for (const [operationId, status] of Object.entries(operations)) this.noteStatus(operationId, status);
  }

  /** Merged status of an operation; undefined when none was reported this cycle. */
  statusOf(operationId: string): OperationStatus | undefined {
    return this.#statuses.get(operationId);
  }

  /**
   * Records a page read of the owner's tenant stream, keeping its rows from the first held one on: it extends the cycle's
   * scan when `after` is that scan's end cursor, otherwise it starts a fresh scan, whose `after` must be the stream's checkpoint cursor.
   */
  noteScan(owner: string, tenantId: string, after: string, page: ChangesPageView<R>, classify: (row: R) => RowDisposition): void {
    const key = streamKey(owner, tenantId);
    const previous = this.#scans.get(key);
    const extended = previous?.end === after ? previous : undefined;
    let head = extended?.head;
    const rows = extended?.rows ?? [];
    for (const row of page.rows) {
      const disposition = classify(row);
      if (head === undefined && disposition === 'hold' && row.operationId !== null) head = row.operationId;
      if (head !== undefined) rows.push({ row, disposition });
    }
    this.#scans.set(key, { owner, tenantId, end: page.cursor, horizon: readHorizon(page), head, rows });
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

  /**
   * One release per ready closure of a parked done operation: each part holds its stream's span rows to apply,
   * and its `streamState` checkpoints the span's last row with the next row's xid, or the scan horizon, as applied horizon.
   */
  ready(): TrackedOperation<S, R>[] {
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

  /** Forgets every part, status and scan at the end of a cycle; fences of done operations stay valid and are kept. */
  clear(): void {
    this.#parked.clear();
    this.#statuses.clear();
    this.#scans.clear();
  }

  /** Ready releases in parked order, each closure once and none sharing an operation, and the operations they release. */
  #evaluate(): { released: TrackedOperation<S, R>[]; emitted: Set<string> } {
    const released: TrackedOperation<S, R>[] = [];
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
   * Grows `seed` to a fixpoint: a scan holding an unrolled-back row of the closure spans from its first held row
   * through the closure's last such row, and the head operation and every other unrolled-back held operation of that span join.
   */
  #closure(seed: string): Closure<S, R> {
    const ids = new Set([seed]);
    const spans = new Map<string, Span<S, R>>();
    const inClosure = (entry: ScannedRow<R>): boolean => {
      const id = this.#liveHold(entry);
      return id !== undefined && ids.has(id);
    };
    for (let grown = true; grown; ) {
      grown = false;
      for (const [key, scan] of this.#scans) {
        if (scan.head === undefined) continue;
        const last = scan.rows.findLastIndex(inClosure);
        if (last < 0) continue;
        spans.set(key, { scan, last, head: scan.head, parked: this.#parked.get(scan.head)?.get(key) });
        const joining = [scan.head, ...scan.rows.slice(1, last + 1).map((entry) => this.#liveHold(entry))];
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

  /** The release of a ready closure: per span, its applicable and live held rows, checkpointed just past the span. */
  #releaseOf(seed: string, { ids, spans }: Closure<S, R>): TrackedOperation<S, R> {
    const parts = [...spans.values()].map(({ scan, last, parked }): ParkedPart<S, R> => {
      const span = scan.rows.slice(0, last + 1);
      // Every live held row of a span belongs to the closure, so the rows it skips are exactly those passed over.
      const rows = span.filter((entry) => entry.disposition === 'apply' || this.#liveHold(entry) !== undefined).map(({ row }) => row);
      const next = scan.rows[last + 1];
      const streamState = {
        ...(parked as ParkedPart<S, R>).streamState,
        endCursor: cursorOf((scan.rows[last] as ScannedRow<R>).row),
        appliedHorizon: next === undefined ? scan.horizon : next.row.xid,
        complete: true,
      };
      return { owner: scan.owner, tenantId: scan.tenantId, rows, streamState };
    });
    return { operationId: seed, operationIds: [...ids], parts, rows: parts.flatMap((part) => part.rows).sort(byPosition) };
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
      const scanned = new Set(this.#scans.get(key)?.rows.map(({ row }) => cursorOf(row)));
      if (!part.rows.every((row) => scanned.has(cursorOf(row)))) return false;
    }
    return true;
  }

  /** True when a scan of `owner` held a row of the operation. */
  #holds(owner: string, operationId: string): boolean {
    const holdsRow = ({ row, disposition }: ScannedRow<R>): boolean => disposition === 'hold' && row.operationId === operationId;
    return [...this.#scans.values()].some((scan) => scan.owner === owner && scan.rows.some(holdsRow));
  }

  /** The operation of a row held when scanned whose operation is not rolled back since. */
  #liveHold({ row, disposition }: ScannedRow<R>): string | undefined {
    const id = row.operationId;
    return disposition === 'hold' && id !== null && this.#statuses.get(id) !== 'rolled-back' ? id : undefined;
  }

  /** Parked operations, then operations held by a scanned row, in first-seen order. */
  #known(): Set<string> {
    const known = new Set(this.#parked.keys());
    for (const scan of this.#scans.values()) {
      for (const { row, disposition } of scan.rows) {
        if (disposition === 'hold' && row.operationId !== null) known.add(row.operationId);
      }
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
