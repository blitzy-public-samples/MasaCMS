/** Decides which changelog rows the reverse projector applies, passes over, or holds for a joint multi-participant apply. */
import {
  APPLY_ORIGINS,
  compareXid,
  formatCursor,
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
  const last: ChangeRow | undefined = page.rows.at(-1);
  return {
    applicable,
    skipped,
    endCursor: page.cursor,
    appliedHorizon: page.complete || last === undefined ? page.horizon : last.xid,
  };
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

/** One parked stream's rows of an operation and the state it resumes from. */
export interface ParkedPart<S extends HeldStreamState = HeldStreamState, R extends ChangeRow = ProjectedChangeRow> {
  owner: string;
  tenantId: string;
  rows: R[];
  streamState: S;
}

/** A tracked operation; `rows` merges every part's rows in `(xid, seq)` order. */
export interface TrackedOperation<S extends HeldStreamState = HeldStreamState, R extends ChangeRow = ProjectedChangeRow> {
  operationId: string;
  parts: ParkedPart<S, R>[];
  rows: R[];
}

/** A parked operation not yet ready: participants with no part, and owners whose part is not fully read. */
export interface WaitingOperation {
  operationId: string;
  status: OperationStatus | undefined;
  missing: string[];
  incomplete: string[];
}

/** Settings of `OperationTracker`; an `OperationStatus` names no participants, so they come from here, default `ROSTER_PARTICIPANTS`. */
export interface OperationTrackerOptions {
  participants?: readonly string[];
}

const STATUS_RANK: Readonly<Record<OperationStatus, number>> = { done: 0, open: 1, 'rolled-back': 2 };

/** Parks streams stopped at multi-participant operations and tells when their rows may be applied or passed over. */
export class OperationTracker<S extends HeldStreamState = HeldStreamState, R extends ChangeRow = ProjectedChangeRow> {
  readonly participants: readonly string[];
  readonly #statuses = new Map<string, OperationStatus>();
  readonly #parked = new Map<string, Map<string, ParkedPart<S, R>>>();

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
    const key = JSON.stringify([owner, tenantId]);
    const part = parts.get(key);
    if (part === undefined) {
      parts.set(key, { owner, tenantId, rows: [...rows], streamState });
    } else {
      part.rows.push(...rows);
      part.streamState = streamState;
    }
  }

  /** Records a reported status; rolled-back outranks open, which outranks done, so done needs every report to agree. */
  noteStatus(operationId: string, status: OperationStatus): void {
    const known = this.#statuses.get(operationId);
    if (known === undefined || STATUS_RANK[status] > STATUS_RANK[known]) this.#statuses.set(operationId, status);
  }

  /** Records every status of a changes page's `operations` map. */
  noteStatuses(operations: Readonly<Record<string, OperationStatus>>): void {
    for (const [operationId, status] of Object.entries(operations)) this.noteStatus(operationId, status);
  }

  /** Merged status of an operation; undefined when none was reported this cycle. */
  statusOf(operationId: string): OperationStatus | undefined {
    return this.#statuses.get(operationId);
  }

  /** Done operations whose every participant has a parked part and whose every part is fully read. */
  ready(): TrackedOperation<S, R>[] {
    return this.#tracked((operationId, parts) => {
      if (this.#statuses.get(operationId) !== 'done') return false;
      const { missing, incomplete } = this.#gaps(parts);
      return missing.length === 0 && incomplete.length === 0;
    });
  }

  /** Parked operations now rolled back; their streams advance past the rows without applying them. */
  rolledBack(): TrackedOperation<S, R>[] {
    return this.#tracked((operationId) => this.#statuses.get(operationId) === 'rolled-back');
  }

  /** Parked operations neither ready nor rolled back, with what each still waits for. */
  waiting(): WaitingOperation[] {
    const pending = new Set([...this.ready(), ...this.rolledBack()].map((operation) => operation.operationId));
    return [...this.#parked]
      .filter(([operationId]) => !pending.has(operationId))
      .map(([operationId, parts]) => ({ operationId, status: this.#statuses.get(operationId), ...this.#gaps(parts) }));
  }

  /** Forgets the parked parts of an operation once its streams moved past it; its status stays known for the cycle. */
  release(operationId: string): void {
    this.#parked.delete(operationId);
  }

  /** Forgets every part and status at the end of a cycle. */
  clear(): void {
    this.#parked.clear();
    this.#statuses.clear();
  }

  #gaps(parts: ReadonlyMap<string, ParkedPart<S, R>>): { missing: string[]; incomplete: string[] } {
    const owners = new Set<string>();
    const incomplete = new Set<string>();
    for (const part of parts.values()) {
      owners.add(part.owner);
      if (!part.streamState.complete) incomplete.add(part.owner);
    }
    return { missing: this.participants.filter((owner) => !owners.has(owner)), incomplete: [...incomplete] };
  }

  #tracked(select: (operationId: string, parts: ReadonlyMap<string, ParkedPart<S, R>>) => boolean): TrackedOperation<S, R>[] {
    return [...this.#parked]
      .filter(([operationId, parts]) => select(operationId, parts))
      .map(([operationId, parts]) => {
        const list = [...parts.values()];
        const rows = list.flatMap((part) => part.rows).sort(byPosition);
        return { operationId, parts: list, rows };
      });
  }
}

function byPosition(a: ChangeRow, b: ChangeRow): number {
  const xid = compareXid(a.xid, b.xid);
  if (xid !== 0) return xid;
  const left = BigInt(a.seq);
  const right = BigInt(b.seq);
  return left < right ? -1 : left > right ? 1 : 0;
}
