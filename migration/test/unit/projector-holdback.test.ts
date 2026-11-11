// Unit tests for the reverse projector's operation holdback: row dispositions, page splits, joint release and absence proofs.
import {
  APPLY_ORIGINS,
  CURSOR_START,
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
  type RowDisposition,
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

/** A person-only roster edit: people's stream parked at done operation A, identity wrote no row of it. */
function personOnly(): Tracker {
  const t = tracker();
  read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'done' });
  return t;
}

const readyIds = (t: Tracker): string[] => t.ready().map((operation) => operation.operationId);

describe('classifyRow', () => {
  it('passes over exactly the origins legacy already holds', () => {
    expect([...SKIPPED_ORIGINS].sort()).toEqual([...APPLY_ORIGINS].sort());
    expect(SKIPPED_ORIGINS.has('target')).toBe(false);
  });

  it.each<[string, Partial<ChangeRow>, boolean, OperationStatus | undefined, RowDisposition]>([
    ['legacy-window row of a done operation', { origin: 'legacy-window', operationId: OP_A }, true, 'done', 'skip-origin'],
    ['migration-feed row', { origin: 'migration-feed' }, true, undefined, 'skip-origin'],
    ['backfill row outside target units', { origin: 'backfill' }, false, undefined, 'skip-origin'],
    ['row outside target units', { operationId: OP_A }, false, 'done', 'skip-unit'],
    ['row outside any operation', {}, true, undefined, 'apply'],
    ['row of a rolled-back operation', { operationId: OP_A }, true, 'rolled-back', 'skip-rolled-back'],
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
    expect(splitAtHold(view, classify, stored)).toEqual(expected);
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

  it('releases an operation once both participants parked fully read parts, merging rows in (xid, seq) order', () => {
    const t = tracker();
    const account = change(101, 2, OP_A, ACCOUNT);
    read(t, 'identity', TENANT, page([account, change(105, 9, null, ACCOUNT)], 106), CURSOR_START, { [OP_A]: 'done' });
    const head = page([change(100, 1, OP_A)], 106, false);
    read(t, 'people', TENANT, head, CURSOR_START, { [OP_A]: 'done' });
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([{ operationId: OP_A, status: 'done', missing: [], incomplete: ['people'], unproven: [] }]);
    expect(t.fencesNeeded()).toEqual([]);

    const rest = page([change(100, 3, OP_A), change(107, 10, null)], 108, false, head.cursor);
    read(t, 'people', TENANT, rest, head.cursor, { [OP_A]: 'done' });
    const [operation, ...others] = t.ready();
    expect(others).toEqual([]);
    expect(operation?.operationId).toBe(OP_A);
    expect(operation?.parts.map((part) => [part.owner, part.tenantId, part.streamState.complete])).toEqual([
      ['identity', TENANT, true],
      ['people', TENANT, true],
    ]);
    expect(operation?.rows).toEqual([change(100, 1, OP_A), change(100, 3, OP_A), account]);
    expect(t.waiting()).toEqual([]);
  });

  it('keeps an open operation waiting', () => {
    const t = tracker();
    read(t, 'people', TENANT, page(PERSON_ROWS, 102), CURSOR_START, { [OP_A]: 'open' });
    read(t, 'identity', TENANT, page([change(100, 4, OP_A, ACCOUNT)], 102), CURSOR_START, { [OP_A]: 'done' });
    expect(t.ready()).toEqual([]);
    expect(t.rolledBack()).toEqual([]);
    expect(t.waiting()).toEqual([{ operationId: OP_A, status: 'open', missing: [], incomplete: [], unproven: [] }]);
  });

  it('lists a parked rolled-back operation for passing over, never as ready or waiting', () => {
    const t = personOnly();
    t.noteStatus(OP_A, 'rolled-back');
    expect(t.rolledBack().map((operation) => [operation.operationId, operation.rows])).toEqual([[OP_A, PERSON_A]]);
    expect(t.ready()).toEqual([]);
    expect(t.waiting()).toEqual([]);
    expect(t.fencesNeeded()).toEqual([]);
  });
});

describe('OperationTracker absence proofs', () => {
  it('asks for a fence of the partless participant of a person-only edit', () => {
    const t = personOnly();
    expect(t.fencesNeeded()).toEqual([{ operationId: OP_A, owner: 'identity' }]);
    expect(t.waiting()).toEqual([{ operationId: OP_A, status: 'done', missing: ['identity'], incomplete: [], unproven: ['identity'] }]);
    t.noteFence(OP_A, 'identity', '150');
    expect(t.fencesNeeded()).toEqual([]);
    expect(t.waiting()).toEqual([{ operationId: OP_A, status: 'done', missing: ['identity'], incomplete: [], unproven: ['identity'] }]);
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
    expect(t.fencesNeeded()).toEqual([{ operationId: OP_A, owner: 'identity' }]);
  });

  it.each<OperationStatus>(['open', 'rolled-back'])('drops the fence when a later report raises the status to %s', (raised) => {
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
    expect(t.fencesNeeded()).toEqual([{ operationId: OP_A, owner: 'identity' }]);
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
    expect(t.waiting()).toEqual([{ operationId: OP_A, status: 'done', missing: ['identity'], incomplete: [], unproven: ['identity'] }]);
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
    expect(t.fencesNeeded()).toEqual([{ operationId: OP_A, owner: 'identity' }]);
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

  it('extends a contiguous scan, keeping its holds, and restarts a scan read from elsewhere', () => {
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
      { operationId: OP_A, owner: 'identity' },
      { operationId: OP_B, owner: 'people' },
    ]);
    t.noteFence(OP_A, 'identity', '106');
    t.noteFence(OP_B, 'people', '106');
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
