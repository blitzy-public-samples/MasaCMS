// Unit tests for the reverse projector's operation holdback: row dispositions, page splits, operation closures and absence proofs.
import {
  CURSOR_START,
  compareXid,
  formatCursor,
  type ChangeRow,
  type OperationStatus,
} from '@opt2/platform/migration-kit';
import { describe, expect, it } from 'vitest';

import {
  OperationTracker,
  ROSTER_PARTICIPANTS,
  SKIPPED_ORIGINS,
  classifyRow,
  cursorOf,
  splitAtHold,
  type ChangesPageView,
  type HeldStreamState,
  type PageSplit,
  type ParkedPart,
  type RowDisposition,
  type WaitingOperation,
} from '../../src/reverse/operations.js';

type Tracker = OperationTracker<HeldStreamState, ChangeRow>;
type Page = ChangesPageView<ChangeRow>;

const TENANT = '0b0c4f7e-3f7a-4c1e-9a55-1d2b3c4d5e6f';
const OTHER_TENANT = '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';
const OP_A = 'a0000000-0000-4000-8000-00000000000a';
const OP_B = 'b0000000-0000-4000-8000-00000000000b';
const ACCOUNT: Partial<ChangeRow> = { table: 'account', actorService: 'identity' };

/** A target changelog row of `person` at `(xid, seq)`. */
function change(xid: number, seq: number, operationId: string | null, extra: Partial<ChangeRow> = {}): ChangeRow {
  return {
    xid: String(xid),
    seq: String(seq),
    table: 'person',
    op: 'update',
    key: `{"UserID":"user-${seq}"}`,
    before: '{"Fname":"Ada"}',
    after: '{"Fname":"Grace"}',
    columns: ['Fname'],
    origin: 'target',
    actorUserId: null,
    actorService: 'people',
    at: '2026-03-01 10:00:00.000',
    requestId: null,
    operationId,
    ...extra,
  };
}

/** A changes page read after `after`; its cursor is the last row's, or `after` when empty. */
function page(rows: ChangeRow[], horizon: number, complete = true, after = CURSOR_START): Page {
  const last = rows.at(-1);
  return { rows, cursor: last === undefined ? after : cursorOf(last), horizon: String(horizon), complete };
}

const cursor = (xid: bigint, seq: bigint): string => formatCursor({ xid, seq });

const tracker = (): Tracker => new OperationTracker<HeldStreamState, ChangeRow>();

function classifier(t: Tracker, isTargetUnit: (row: ChangeRow) => boolean = () => true): (row: ChangeRow) => RowDisposition {
  return (row) => classifyRow(row, { isTargetUnit, statusOf: (id) => t.statusOf(id) });
}

/** Reads one page of a stream as the projector does: statuses, scan, split, then park at the held run. */
function read(
  t: Tracker,
  owner: string,
  tenantId: string,
  view: Page,
  after: string,
  operations: Record<string, OperationStatus> = {},
  isTargetUnit?: (row: ChangeRow) => boolean,
): PageSplit<ChangeRow> {
  t.noteStatuses(operations);
  const classify = classifier(t, isTargetUnit);
  t.noteScan(owner, tenantId, after, view, classify);
  const split = splitAtHold(view, classify, after);
  if (split.held !== undefined) t.park(owner, tenantId, split.held.operationId, split.held.rows, split.held);
  return split;
}

const PERSON_ROWS = [change(100, 1, OP_A), change(100, 2, OP_A), change(101, 3, null)];
const PERSON_A = PERSON_ROWS.slice(0, 2);

/** A person-only roster edit: people's stream parked at done operation A and fenced, identity wrote no row of it. */
function personOnly(): Tracker {
  const t = tracker();
  read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'done' });
  t.noteFence(OP_A, 'people', '101');
  return t;
}

const readyIds = (t: Tracker): string[] => t.ready().map((operation) => operation.operationId);

/** Notes `position` as every roster participant's fence of the operation. */
function fenceAll(t: Tracker, operationId: string, position: string): void {
  for (const owner of ROSTER_PARTICIPANTS) t.noteFence(operationId, owner, position);
}

/** A `waiting` entry whose gaps are empty unless given. */
function waitingOn(
  operationId: string,
  status: OperationStatus | undefined,
  gaps: Partial<Pick<WaitingOperation, 'missing' | 'incomplete' | 'unproven' | 'blockedBy'>> = {},
): WaitingOperation {
  return { operationId, status, missing: [], incomplete: [], unproven: [], blockedBy: [], ...gaps };
}

/** A released part's owner, tenant, rows and checkpoint. */
const checkpoint = ({ owner, tenantId, rows, streamState }: ParkedPart<HeldStreamState, ChangeRow>): unknown[] => [
  owner,
  tenantId,
  rows,
  streamState.endCursor,
  streamState.appliedHorizon,
  streamState.complete,
];

describe('classifyRow', () => {
  it('passes over exactly the origins legacy already holds', () => {
    expect([...SKIPPED_ORIGINS].sort()).toEqual(['backfill', 'legacy-window', 'migration-feed']);
  });

  it.each<[string, Partial<ChangeRow>, boolean, OperationStatus | undefined, RowDisposition]>([
    ['legacy-window row of a done operation', { origin: 'legacy-window', operationId: OP_A }, true, 'done', 'skip-origin'],
    ['migration-feed row', { origin: 'migration-feed' }, true, undefined, 'skip-origin'],
    ['backfill row outside target units', { origin: 'backfill' }, false, undefined, 'skip-origin'],
    ['row outside target units', { operationId: OP_A }, false, 'done', 'skip-unit'],
    ['row outside any operation', {}, true, undefined, 'apply'],
    ['row of a rolled-back operation', { operationId: OP_A }, true, 'rolled-back', 'skip-rolled-back'],
    // A done operation's rows still wait for the tracker's joint release of every participant's rows.
    ['row of a done operation', { operationId: OP_A }, true, 'done', 'hold'],
    ['row of an open operation', { operationId: OP_A }, true, 'open', 'hold'],
    ['row of an unreported operation', { operationId: OP_A }, true, undefined, 'hold'],
  ])('classifies a %s', (_label, extra, isTarget, status, expected) => {
    const row = change(100, 1, null, extra);
    expect(classifyRow(row, { isTargetUnit: () => isTarget, statusOf: () => status })).toBe(expected);
  });
});

describe('splitAtHold', () => {
  const classify = (row: ChangeRow): RowDisposition =>
    classifyRow(row, { isTargetUnit: (r) => r.table !== 'unmapped', statusOf: () => undefined });

  it.each<[string, Page, string, PageSplit<ChangeRow>]>([
    [
      'applies a page without held rows up to its horizon',
      page([change(100, 1, null), change(101, 2, null, { origin: 'legacy-window' })], 105),
      CURSOR_START,
      { applicable: [change(100, 1, null)], skipped: 1, endCursor: cursor(101n, 2n), appliedHorizon: '105' },
    ],
    [
      "stops an incomplete page's horizon at its last row's xid",
      page([change(100, 1, null), change(103, 2, null)], 120, false),
      CURSOR_START,
      { applicable: [change(100, 1, null), change(103, 2, null)], skipped: 0, endCursor: cursor(103n, 2n), appliedHorizon: '103' },
    ],
    [
      'keeps the stored cursor for an empty page',
      page([], 120, true, cursor(90n, 4n)),
      cursor(90n, 4n),
      { applicable: [], skipped: 0, endCursor: cursor(90n, 4n), appliedHorizon: '120' },
    ],
    [
      'consumes applied and skipped rows before the held row and nothing after it',
      page(
        [
          change(100, 1, null),
          change(101, 2, null, { origin: 'legacy-window' }),
          change(102, 3, null),
          change(103, 4, OP_A),
          change(104, 5, null),
        ],
        110,
      ),
      CURSOR_START,
      {
        applicable: [change(100, 1, null), change(102, 3, null)],
        skipped: 1,
        endCursor: cursor(102n, 3n),
        appliedHorizon: '103',
        held: {
          operationId: OP_A,
          xid: '103',
          rows: [change(103, 4, OP_A)],
          skipped: 0,
          complete: true,
          endCursor: cursor(103n, 4n),
          appliedHorizon: '104',
        },
      },
    ],
    [
      'holds from the first held row, keeping the stored cursor when nothing before it was consumed',
      page([change(100, 1, OP_A), change(100, 2, OP_A, { table: 'unmapped' }), change(100, 3, OP_A), change(101, 4, null)], 110),
      cursor(90n, 4n),
      {
        applicable: [],
        skipped: 0,
        endCursor: cursor(90n, 4n),
        appliedHorizon: '100',
        held: {
          operationId: OP_A,
          xid: '100',
          rows: [change(100, 1, OP_A), change(100, 3, OP_A)],
          skipped: 1,
          complete: true,
          endCursor: cursor(100n, 3n),
          appliedHorizon: '101',
        },
      },
    ],
    [
      'ends the held run at the next transaction of the same operation',
      page([change(99, 1, null), change(100, 2, OP_A), change(102, 3, OP_A)], 110),
      CURSOR_START,
      {
        applicable: [change(99, 1, null)],
        skipped: 0,
        endCursor: cursor(99n, 1n),
        appliedHorizon: '100',
        held: {
          operationId: OP_A,
          xid: '100',
          rows: [change(100, 2, OP_A)],
          skipped: 0,
          complete: true,
          endCursor: cursor(100n, 2n),
          appliedHorizon: '102',
        },
      },
    ],
    [
      'ends the held run at a row of another operation in the same transaction',
      page([change(100, 1, OP_A), change(100, 2, OP_B)], 110),
      CURSOR_START,
      {
        applicable: [],
        skipped: 0,
        endCursor: CURSOR_START,
        appliedHorizon: '100',
        held: {
          operationId: OP_A,
          xid: '100',
          rows: [change(100, 1, OP_A)],
          skipped: 0,
          complete: true,
          endCursor: cursor(100n, 1n),
          appliedHorizon: '100',
        },
      },
    ],
    [
      'completes a held run ending a complete page up to the horizon',
      page([change(100, 1, OP_A)], 110),
      CURSOR_START,
      {
        applicable: [],
        skipped: 0,
        endCursor: CURSOR_START,
        appliedHorizon: '100',
        held: {
          operationId: OP_A,
          xid: '100',
          rows: [change(100, 1, OP_A)],
          skipped: 0,
          complete: true,
          endCursor: cursor(100n, 1n),
          appliedHorizon: '110',
        },
      },
    ],
    [
      'leaves a held run ending an incomplete page incomplete',
      page([change(100, 1, OP_A)], 110, false),
      CURSOR_START,
      {
        applicable: [],
        skipped: 0,
        endCursor: CURSOR_START,
        appliedHorizon: '100',
        held: {
          operationId: OP_A,
          xid: '100',
          rows: [change(100, 1, OP_A)],
          skipped: 0,
          complete: false,
          endCursor: cursor(100n, 1n),
          appliedHorizon: '100',
        },
      },
    ],
  ])('%s', (_label, view, stored, expected) => {
    const split = splitAtHold(view, classify, stored);
    expect(split).toEqual(expected);
    if (split.held === undefined) return;
    // The batch checkpoint never claims the held transaction or any row from the held row on.
    expect(compareXid(split.appliedHorizon, split.held.xid)).toBeLessThanOrEqual(0);
    const firstHeld = view.rows.findIndex((row) => classify(row) === 'hold');
    expect(view.rows.findIndex((row) => cursorOf(row) === split.endCursor)).toBeLessThan(firstHeld);
  });

  it('rejects a held row that carries no operationId', () => {
    expect(() => splitAtHold(page([change(100, 1, null)], 110), () => 'hold', CURSOR_START)).toThrow(
      new TypeError(`Held changelog row ${cursor(100n, 1n)} carries no operationId`),
    );
  });
});

describe('OperationTracker parts and statuses', () => {
  it('defaults to the roster participants and de-duplicates configured ones', () => {
    expect(ROSTER_PARTICIPANTS).toEqual(['people', 'identity']);
    expect(tracker().participants).toEqual(ROSTER_PARTICIPANTS);
    expect(new OperationTracker({ participants: ['people', 'identity', 'people', 'strategies-content'] }).participants).toEqual([
      'people',
      'identity',
      'strategies-content',
    ]);
  });

  it.each<[OperationStatus[], OperationStatus]>([
    [['done'], 'done'],
    [['done', 'open'], 'open'],
    [['open', 'done'], 'open'],
    [['done', 'rolled-back', 'open'], 'rolled-back'],
    [['rolled-back', 'done'], 'rolled-back'],
  ])('merges reports %j into %s', (reports, merged) => {
    const t = tracker();
    for (const status of reports) t.noteStatus(OP_A, status);
    expect(t.statusOf(OP_A)).toBe(merged);
  });

  it('releases an operation once both participants are read past their fences, merging rows in (xid, seq) order', () => {
    const t = tracker();
    const account = change(101, 2, OP_A, ACCOUNT);
    read(t, 'identity', TENANT, page([account, change(105, 9, null, ACCOUNT)], 106), CURSOR_START, { [OP_A]: 'done' });
    const head = page([change(100, 1, OP_A)], 106, false);
    read(t, 'people', TENANT, head, CURSOR_START, { [OP_A]: 'done' });
    expect(t.ready()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
    ]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { incomplete: ['people', 'identity'] })]);

    t.noteFence(OP_A, 'people', '106');
    t.noteFence(OP_A, 'identity', '105');
    expect(t.fencesNeeded()).toEqual([]);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { incomplete: ['people'] })]);

    const rest = page([change(100, 3, OP_A), change(107, 10, null)], 108, false, head.cursor);
    read(t, 'people', TENANT, rest, head.cursor, { [OP_A]: 'done' });
    const [operation, ...others] = t.ready();
    expect(others).toEqual([]);
    expect(operation?.operationIds).toEqual([OP_A]);
    expect(operation?.parts.map(checkpoint)).toEqual([
      ['identity', TENANT, [account], cursorOf(account), '105', true],
      ['people', TENANT, [change(100, 1, OP_A), change(100, 3, OP_A)], cursor(100n, 3n), '107', true],
    ]);
    expect(operation?.rows).toEqual([change(100, 1, OP_A), change(100, 3, OP_A), account]);
    expect(t.waiting()).toEqual([]);
  });

  it('holds an unreported operation, then a done one missing a participant, and forgets it once released', () => {
    const t = tracker();
    const account = change(102, 1, OP_A, ACCOUNT);
    read(t, 'identity', TENANT, page([account], 103), CURSOR_START);
    expect(t.ready()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, undefined, { missing: ['people'], incomplete: ['identity'], unproven: ['people'] })]);

    t.noteStatus(OP_A, 'done');
    expect(t.ready()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
    ]);

    read(t, 'people', TENANT, page(PERSON_ROWS, 103), CURSOR_START, { [OP_A]: 'done' });
    fenceAll(t, OP_A, '102');
    expect(t.ready().map((operation) => [operation.operationId, operation.rows])).toEqual([[OP_A, [...PERSON_A, account]]]);

    t.release(OP_A);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([]);
  });

  it('keeps an open operation waiting', () => {
    const t = tracker();
    read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'open' });
    read(t, 'identity', TENANT, page([change(100, 4, OP_A, ACCOUNT)], 102), CURSOR_START, { [OP_A]: 'done' });
    expect(t.ready()).toEqual([]);
    expect(t.rolledBack()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'open', { incomplete: ['people', 'identity'] })]);
  });

  it('lists a parked rolled-back operation for passing over, never as ready or waiting', () => {
    const t = personOnly();
    t.noteStatus(OP_A, 'rolled-back');
    expect(t.rolledBack().map((operation) => [operation.operationId, operation.operationIds, operation.rows])).toEqual([
      [OP_A, [OP_A], PERSON_A],
    ]);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([]);
  });

  it('releases interleaved operations of different tenants independently', () => {
    const t = tracker();
    const personA = change(100, 1, OP_A);
    const personB = change(101, 1, OP_B);
    const accountA = change(102, 1, OP_A, ACCOUNT);
    const accountB = change(103, 1, OP_B, ACCOUNT);
    const reports: Record<string, OperationStatus> = { [OP_A]: 'done', [OP_B]: 'open' };
    read(t, 'people', TENANT, page([personA], 104), CURSOR_START, reports);
    read(t, 'people', OTHER_TENANT, page([personB], 104), CURSOR_START, reports);
    read(t, 'identity', TENANT, page([accountA], 104), CURSOR_START, reports);
    read(t, 'identity', OTHER_TENANT, page([accountB], 104), CURSOR_START, reports);
    fenceAll(t, OP_A, '103');
    expect(t.ready().map((operation) => [operation.operationId, operation.rows])).toEqual([[OP_A, [personA, accountA]]]);

    t.release(OP_A);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_B, 'open', { incomplete: ['people', 'identity'] })]);

    t.clear();
    read(t, 'people', OTHER_TENANT, page([personB], 104), CURSOR_START, { [OP_B]: 'done' });
    read(t, 'identity', OTHER_TENANT, page([accountB], 104), CURSOR_START, { [OP_B]: 'done' });
    fenceAll(t, OP_B, '103');
    expect(t.ready().map((operation) => [operation.operationId, operation.rows])).toEqual([[OP_B, [personB, accountB]]]);
  });

  it('waits while a parked run is missing from its stream scan, which a read from elsewhere replaced', () => {
    const t = personOnly();
    t.noteFence(OP_A, 'identity', '150');
    read(t, 'identity', TENANT, page([], 200), CURSOR_START);
    expect(readyIds(t)).toEqual([OP_A]);

    const elsewhere = page([change(101, 3, null)], 200, true, cursor(100n, 2n));
    t.noteScan('people', TENANT, cursor(100n, 2n), elsewhere, classifier(t));
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { missing: ['identity'], incomplete: ['people'] })]);

    t.noteScan('people', TENANT, CURSOR_START, page(PERSON_ROWS, 102), classifier(t));
    expect(readyIds(t)).toEqual([OP_A]);
  });
});

describe('OperationTracker operation closures', () => {
  it('waits for every transaction of the operation in both participants, then releases them with the rows between at once', () => {
    const t = tracker();
    const done: Record<string, OperationStatus> = { [OP_A]: 'done' };
    const p1Head = change(101, 1, OP_A);
    const p1Tail = change(101, 2, OP_A);
    const personBetween = change(103, 3, null);
    const p2 = change(105, 4, OP_A);
    const i1 = change(100, 1, OP_A, ACCOUNT);
    const accountBetween = change(102, 2, null, ACCOUNT);
    const i2 = change(104, 3, OP_A, ACCOUNT);
    const accountAfter = change(107, 4, null, ACCOUNT);

    const peopleHead = page([p1Head], 108, false);
    expect(read(t, 'people', TENANT, peopleHead, CURSOR_START, done).held?.complete).toBe(false);
    read(t, 'people', TENANT, page([p1Tail, personBetween, p2], 108, true, peopleHead.cursor), peopleHead.cursor, done);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { missing: ['identity'], incomplete: ['people'], unproven: ['identity'] })]);

    const identityHead = page([i1, accountBetween], 108, false);
    expect(read(t, 'identity', TENANT, identityHead, CURSOR_START, done).held?.complete).toBe(true);
    expect(t.ready()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
    ]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { incomplete: ['people', 'identity'] })]);

    fenceAll(t, OP_A, '106');
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { incomplete: ['identity'] })]);

    const ahead = page([i2], 108, false, identityHead.cursor);
    t.noteScan('identity', TENANT, identityHead.cursor, ahead, classifier(t));
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { incomplete: ['identity'] })]);

    t.noteScan('identity', TENANT, ahead.cursor, page([accountAfter], 109, true, ahead.cursor), classifier(t));
    const released = t.ready();
    expect(released.map((operation) => [operation.operationId, operation.operationIds, operation.rows])).toEqual([
      [OP_A, [OP_A], [i1, p1Head, p1Tail, accountBetween, personBetween, i2, p2]],
    ]);
    expect(released[0]?.parts.map(checkpoint)).toEqual([
      ['people', TENANT, [p1Head, p1Tail, personBetween, p2], cursorOf(p2), '108', true],
      ['identity', TENANT, [i1, accountBetween, i2], cursorOf(i2), '107', true],
    ]);
    expect(t.waiting()).toEqual([]);

    for (const id of released[0]?.operationIds ?? []) t.release(id);
    expect(t.ready()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([]);
  });

  it('holds interleaved operations sharing both streams until both are done and fenced, then releases them together', () => {
    const t = tracker();
    const i1A = change(100, 1, OP_A, ACCOUNT);
    const i1B = change(101, 2, OP_B, ACCOUNT);
    const personA = change(102, 1, OP_A);
    const personB = change(103, 2, OP_B);
    const i2A = change(104, 3, OP_A, ACCOUNT);
    const i2B = change(105, 4, OP_B, ACCOUNT);
    const readBoth = (reports: Record<string, OperationStatus>): void => {
      read(t, 'people', TENANT, page([personA, personB], 110), CURSOR_START, reports);
      read(t, 'identity', TENANT, page([i1A, i1B, i2A, i2B], 110), CURSOR_START, reports);
    };

    readBoth({ [OP_A]: 'done', [OP_B]: 'open' });
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
    ]);
    fenceAll(t, OP_A, '106');
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { blockedBy: [OP_B] })]);

    t.clear();
    readBoth({ [OP_A]: 'done', [OP_B]: 'done' });
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_B, owner: 'people' },
      { operationId: OP_B, owner: 'identity' },
    ]);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { blockedBy: [OP_B] })]);

    fenceAll(t, OP_B, '106');
    const released = t.ready();
    expect(released.map((operation) => [operation.operationId, operation.operationIds, operation.rows])).toEqual([
      [OP_A, [OP_A, OP_B], [i1A, i1B, personA, personB, i2A, i2B]],
    ]);
    expect(released[0]?.parts.map(checkpoint)).toEqual([
      ['people', TENANT, [personA, personB], cursorOf(personB), '110', true],
      ['identity', TENANT, [i1A, i1B, i2A, i2B], cursorOf(i2B), '110', true],
    ]);
    expect(t.waiting()).toEqual([]);

    for (const id of released[0]?.operationIds ?? []) t.release(id);
    expect(t.ready()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([]);
  });

  it.each<[string, Record<string, OperationStatus>, Record<string, OperationStatus>]>([
    ['rolled back before the scan', { [OP_A]: 'done', [OP_B]: 'rolled-back' }, {}],
    ['rolled back after the scan', { [OP_A]: 'done', [OP_B]: 'open' }, { [OP_B]: 'rolled-back' }],
  ])('leaves the rows of an operation %s out of a release spanning them', (_label, reports, later) => {
    const t = tracker();
    const i1 = change(100, 1, OP_A, ACCOUNT);
    const rolledBack = change(101, 2, OP_B, ACCOUNT);
    const i2 = change(103, 3, OP_A, ACCOUNT);
    const person = change(102, 1, OP_A);
    read(t, 'people', TENANT, page([person], 105), CURSOR_START, reports);
    read(t, 'identity', TENANT, page([i1, rolledBack, i2], 105), CURSOR_START, reports);
    t.noteStatuses(later);
    fenceAll(t, OP_A, '104');
    expect(t.fencesNeeded()).toEqual([]);
    const released = t.ready();
    expect(released.map((operation) => [operation.operationIds, operation.rows])).toEqual([[[OP_A], [i1, person, i2]]]);
    expect(released[0]?.parts.map(checkpoint)).toEqual([
      ['people', TENANT, [person], cursorOf(person), '105', true],
      ['identity', TENANT, [i1, i2], cursorOf(i2), '105', true],
    ]);
    expect(t.rolledBack()).toEqual([]);
  });

  it('waits behind a stream parked at a rolled-back operation until the projector passes over it', () => {
    const t = tracker();
    const rolledBack = change(100, 1, OP_B, ACCOUNT);
    const person = change(101, 1, OP_A);
    const account = change(102, 2, OP_A, ACCOUNT);
    const reports: Record<string, OperationStatus> = { [OP_A]: 'done', [OP_B]: 'open' };
    read(t, 'people', TENANT, page([person], 104), CURSOR_START, reports);
    read(t, 'identity', TENANT, page([rolledBack, account], 104), CURSOR_START, reports);
    t.noteStatus(OP_B, 'rolled-back');
    fenceAll(t, OP_A, '103');
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { missing: ['identity'], unproven: ['identity'], blockedBy: [OP_B] })]);
    expect(t.rolledBack().map((operation) => [operation.operationId, operation.operationIds, operation.rows])).toEqual([
      [OP_B, [OP_B], [rolledBack]],
    ]);

    t.release(OP_B);
    read(t, 'identity', TENANT, page([account], 104, true, cursorOf(rolledBack)), cursorOf(rolledBack), { [OP_A]: 'done' });
    expect(t.ready().map((operation) => [operation.operationIds, operation.rows])).toEqual([[[OP_A], [person, account]]]);
  });

  it('releases a closure once per call, leaving a closure sharing its stream until that stream is read again', () => {
    const t = tracker();
    const accountA = change(100, 1, OP_A, ACCOUNT);
    const personB = change(101, 1, OP_B);
    const accountB = change(103, 2, OP_B, ACCOUNT);
    const reports: Record<string, OperationStatus> = { [OP_A]: 'done', [OP_B]: 'done' };
    read(t, 'identity', TENANT, page([accountA, accountB], 104), CURSOR_START, reports);
    read(t, 'people', TENANT, page([personB], 104), CURSOR_START, reports);
    fenceAll(t, OP_A, '103');
    fenceAll(t, OP_B, '103');
    const released = t.ready();
    expect(released.map((operation) => [operation.operationIds, operation.rows])).toEqual([[[OP_A], [accountA]]]);
    expect(released[0]?.parts.map(checkpoint)).toEqual([['identity', TENANT, [accountA], cursorOf(accountA), '103', true]]);
    expect(t.waiting()).toEqual([waitingOn(OP_B, 'done', { missing: ['identity'], unproven: ['identity'], blockedBy: [OP_A] })]);

    t.release(OP_A);
    read(t, 'identity', TENANT, page([accountB], 104, true, cursorOf(accountA)), cursorOf(accountA), reports);
    expect(t.ready().map((operation) => [operation.operationIds, operation.rows])).toEqual([[[OP_B], [personB, accountB]]]);
  });

  it('waits for the park of a stream whose first held operation only a read-ahead scan reached, then releases both', () => {
    const t = personOnly();
    const accountB = change(120, 8, OP_B, ACCOUNT);
    const accountA = change(130, 9, OP_A, ACCOUNT);
    const view = page([accountB, accountA], 200);
    t.noteStatuses({ [OP_B]: 'done' });
    t.noteScan('identity', TENANT, CURSOR_START, view, classifier(t));
    t.noteFence(OP_A, 'identity', '150');
    t.noteFence(OP_B, 'people', '101');
    t.noteFence(OP_B, 'identity', '150');
    expect(t.fencesNeeded()).toEqual([]);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { missing: ['identity'], unproven: ['identity'], blockedBy: [OP_B] })]);

    read(t, 'identity', TENANT, view, CURSOR_START);
    const released = t.ready();
    expect(released.map((operation) => [operation.operationIds, operation.rows])).toEqual([
      [[OP_A, OP_B], [...PERSON_A, accountB, accountA]],
    ]);
    expect(released[0]?.parts.map(checkpoint)).toEqual([
      ['people', TENANT, PERSON_A, cursor(100n, 2n), '101', true],
      ['identity', TENANT, [accountB, accountA], cursorOf(accountA), '200', true],
    ]);
  });
});

describe('OperationTracker absence proofs', () => {
  it('asks for a fence of every participant of a person-only edit, with or without a part', () => {
    const t = tracker();
    read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'done' });
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
    ]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { missing: ['identity'], incomplete: ['people'], unproven: ['identity'] })]);
    t.noteFence(OP_A, 'people', '101');
    t.noteFence(OP_A, 'identity', '150');
    expect(t.fencesNeeded()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { missing: ['identity'], unproven: ['identity'] })]);
  });

  it.each<[string, string | undefined, Array<[string, Page]>, boolean]>([
    ['without a fence', undefined, [[TENANT, page([], 200)]], false],
    ['with a scan horizon at the fence', '150', [[TENANT, page([], 150)]], false],
    [
      'with an incomplete scan whose last row is below the fence',
      '150',
      [[TENANT, page([change(120, 9, null, ACCOUNT)], 200, false)]],
      false,
    ],
    [
      "with identity's scan holding a row of the operation behind another held operation",
      '150',
      [[TENANT, page([change(120, 8, OP_B, ACCOUNT), change(130, 9, OP_A, ACCOUNT)], 200)]],
      false,
    ],
    [
      "with identity's scan of another tenant holding a row of the operation",
      '150',
      [
        [TENANT, page([], 200)],
        [OTHER_TENANT, page([change(120, 8, OP_B, ACCOUNT), change(130, 9, OP_A, ACCOUNT)], 200)],
      ],
      false,
    ],
    ['with a passing scan only in another tenant', '150', [[OTHER_TENANT, page([], 200)]], false],
    ['with a scan past the fence holding no row of the operation', '150', [[TENANT, page([change(140, 9, OP_B, ACCOUNT)], 151)]], true],
  ])('decides a person-only edit %s', (_label, fence, scans, ready) => {
    const t = personOnly();
    for (const [tenantId, view] of scans) read(t, 'identity', tenantId, view, CURSOR_START);
    if (fence !== undefined) t.noteFence(OP_A, 'identity', fence);
    const released = t.ready().filter((operation) => operation.operationId === OP_A);
    expect(released.length === 1).toBe(ready);
    if (ready) {
      expect(released[0]?.rows).toEqual(PERSON_A);
      expect(released[0]?.parts.map((part) => part.owner)).toEqual(['people']);
    } else {
      expect(t.waiting().find((operation) => operation.operationId === OP_A)?.unproven).toEqual(['identity']);
    }
  });

  it.each<[string, Record<string, OperationStatus>]>([
    ['open', { [OP_A]: 'open' }],
    ['unreported', {}],
  ])('ignores a fence noted while the operation is %s', (_label, operations) => {
    const t = tracker();
    read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, operations);
    t.noteFence(OP_A, 'identity', '150');
    t.clear();
    read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'done' });
    read(t, 'identity', TENANT, page([], 200), CURSOR_START);
    expect(t.ready()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
    ]);
  });

  it.each<OperationStatus>(['open', 'rolled-back'])('drops the fences when a later report raises the status to %s', (raised) => {
    const t = personOnly();
    t.noteFence(OP_A, 'identity', '150');
    read(t, 'identity', TENANT, page([], 200), CURSOR_START);
    expect(readyIds(t)).toEqual([OP_A]);
    t.noteStatus(OP_A, raised);
    expect(t.ready()).toEqual([]);
    t.clear();
    read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'done' });
    read(t, 'identity', TENANT, page([], 200), CURSOR_START);
    expect(t.ready()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
    ]);
  });

  it('keeps fences across clear() but forgets scans', () => {
    const t = personOnly();
    t.noteFence(OP_A, 'identity', '150');
    read(t, 'identity', TENANT, page([], 200), CURSOR_START);
    expect(readyIds(t)).toEqual([OP_A]);
    t.clear();
    expect(t.statusOf(OP_A)).toBeUndefined();
    expect(t.waiting()).toEqual([]);
    read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'done' });
    expect(t.fencesNeeded()).toEqual([]);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([waitingOn(OP_A, 'done', { missing: ['identity'], unproven: ['identity'] })]);
    read(t, 'identity', TENANT, page([], 210), CURSOR_START);
    expect(readyIds(t)).toEqual([OP_A]);
  });

  it('forgets the fences of a released operation', () => {
    const t = personOnly();
    t.noteFence(OP_A, 'identity', '150');
    read(t, 'identity', TENANT, page([], 200), CURSOR_START);
    expect(readyIds(t)).toEqual([OP_A]);
    t.release(OP_A);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([]);
    expect(t.statusOf(OP_A)).toBe('done');
    read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'done' });
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
    ]);
    expect(t.ready()).toEqual([]);
  });

  it.each([[['150', '180']], [['180', '150']]])('keeps the lowest of fences %j', (positions) => {
    const t = personOnly();
    for (const position of positions) t.noteFence(OP_A, 'identity', position);
    read(t, 'identity', TENANT, page([], 160), CURSOR_START);
    expect(readyIds(t)).toEqual([OP_A]);
  });

  it.each(['', '-1', '012', '1.5', '0x10', ' 7', '1:2', '18446744073709551616'])('rejects fence position %j', (position) => {
    const t = personOnly();
    expect(() => t.noteFence(OP_A, 'identity', position)).toThrow(new TypeError(`Invalid xid ${JSON.stringify(position)}`));
    expect(t.fencesNeeded()).toEqual([{ operationId: OP_A, owner: 'identity' }]);
  });

  it('accepts the largest xid8 as a fence', () => {
    const t = personOnly();
    t.noteFence(OP_A, 'identity', '18446744073709551615');
    expect(t.fencesNeeded()).toEqual([]);
  });

  it('proves absent a participant whose rows of the operation are all outside target units', () => {
    const t = personOnly();
    const account = change(101, 4, OP_A, ACCOUNT);
    const split = read(t, 'identity', TENANT, page([account], 104), CURSOR_START, {}, (row) => row.table !== 'account');
    expect(split).toEqual({ applicable: [], skipped: 1, endCursor: cursorOf(account), appliedHorizon: '104' });
    expect(t.fencesNeeded()).toEqual([{ operationId: OP_A, owner: 'identity' }]);
    t.noteFence(OP_A, 'identity', '103');
    expect(t.ready().map((operation) => operation.rows)).toEqual([PERSON_A]);
  });

  it('needs a passing scan in every tenant the operation parked in', () => {
    const t = personOnly();
    const elsewhere = change(100, 7, OP_A);
    read(t, 'people', OTHER_TENANT, page([elsewhere], 102), CURSOR_START, { [OP_A]: 'done' });
    t.noteFence(OP_A, 'identity', '150');
    read(t, 'identity', TENANT, page([], 200), CURSOR_START);
    expect(t.ready()).toEqual([]);
    read(t, 'identity', OTHER_TENANT, page([], 200), CURSOR_START);
    expect(t.ready().map((operation) => operation.rows)).toEqual([[...PERSON_A, elsewhere]]);
  });

  it('extends a contiguous scan, keeping its held rows, and restarts a scan read from elsewhere', () => {
    const t = personOnly();
    t.noteFence(OP_A, 'identity', '150');
    const blocked = page([change(120, 8, OP_B, ACCOUNT), change(130, 9, OP_A, ACCOUNT)], 140, false);
    read(t, 'identity', TENANT, blocked, CURSOR_START);
    t.noteScan('identity', TENANT, blocked.cursor, page([], 300, true, blocked.cursor), classifier(t));
    expect(t.ready()).toEqual([]);

    t.noteScan('identity', TENANT, CURSOR_START, page([], 300), classifier(t));
    expect(readyIds(t)).toEqual([OP_A]);
    t.noteScan('identity', TENANT, CURSOR_START, page([change(120, 8, null, ACCOUNT)], 300, false), classifier(t));
    expect(t.ready()).toEqual([]);
  });

  it('releases a person-only and an account-only operation parking each other once read-ahead scans pass both fences', () => {
    const t = tracker();
    const personA = change(100, 1, OP_A);
    const accountB = change(102, 2, OP_B, ACCOUNT);
    const peopleHead = page([personA, change(104, 3, null)], 110, false);
    const identityHead = page([accountB, change(105, 4, null, ACCOUNT)], 110, false);
    read(t, 'people', TENANT, peopleHead, CURSOR_START, { [OP_A]: 'done' });
    read(t, 'identity', TENANT, identityHead, CURSOR_START, { [OP_B]: 'done' });
    expect(t.fencesNeeded()).toEqual([
      { operationId: OP_A, owner: 'people' },
      { operationId: OP_A, owner: 'identity' },
      { operationId: OP_B, owner: 'people' },
      { operationId: OP_B, owner: 'identity' },
    ]);
    fenceAll(t, OP_A, '106');
    fenceAll(t, OP_B, '106');
    expect(t.ready()).toEqual([]);
    expect(t.waiting().map((operation) => [operation.operationId, operation.unproven])).toEqual([
      [OP_A, ['identity']],
      [OP_B, ['people']],
    ]);

    t.noteScan('people', TENANT, peopleHead.cursor, page([], 110, true, peopleHead.cursor), classifier(t));
    t.noteScan('identity', TENANT, identityHead.cursor, page([], 110, true, identityHead.cursor), classifier(t));
    expect(t.ready().map((operation) => [operation.operationId, operation.rows])).toEqual([
      [OP_A, [personA]],
      [OP_B, [accountB]],
    ]);
    expect(t.waiting()).toEqual([]);
  });
});
