/** Interest and tag writes of a user save over the recording database: comma-list rules, delete scope, changelog rows and the unit gate. */
import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_TABLE,
  GateClosedError,
  encodeKey,
  encodeRow,
  qualified,
  withGatedTenant,
  type TableDefinition,
} from '@opt2/platform/migration-kit';
import { withTenant, type QueryResultRow } from '@opt2/platform/tenancy';
import { TENANT_A } from '@opt2/platform/testing';
import { interestRowsFor, tagRowsFor, writeInterests, writeTags, type InterestWriteOptions } from '../../src/domain/interests-tags.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import { INTEREST, TAG, type InterestRow, type TagRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, createRecordingDb, type RecordedStatement, type RecordingDb } from '../helpers/app.js';
import { interestRow, personRow, tagRow } from '../helpers/fixtures.js';

const SCHEMA = 'people';
const INTEREST_TABLE = `${SCHEMA}.${INTEREST.table}`;
const TAG_TABLE = `${SCHEMA}.${TAG.table}`;
const CHANGELOG = `${SCHEMA}.${CHANGELOG_TABLE}`;
/** First id the fake `user_tag` sequence issues. */
const FIRST_TAG_ID = 5001;
/** Gate wait budget of the closed-gate cases, far below the platform's 30 s default. */
const GATE_BUDGET_MS = 200;

const repo = createPeopleRepository({ clock: TEST_CLOCK });

type Op = 'insert' | 'update' | 'delete';
type Row = Record<string, unknown>;
type Predicate = (text: string, values: readonly unknown[]) => boolean;

const WRITE_TARGET = /^(INSERT INTO|UPDATE|DELETE FROM) "([^"]+)"\."([^"]+)"/;
const INSERT_COLUMNS = /^INSERT INTO \S+ \(([^)]*)\) VALUES/;
const OPS: Readonly<Record<string, Op>> = { 'INSERT INTO': 'insert', UPDATE: 'update', 'DELETE FROM': 'delete' };

/** Operation and `<schema>.<table>` a write statement targets; undefined for any other statement. */
function targetOf(text: string): { op: Op; table: string } | undefined {
  const match = WRITE_TARGET.exec(text);
  const op = OPS[match?.[1] ?? ''];
  return match === null || op === undefined ? undefined : { op, table: `${match[2] ?? ''}.${match[3] ?? ''}` };
}

/** The row a single-tuple INSERT binds, keyed by its column list. */
function insertedRow(text: string, values: readonly unknown[]): Row {
  const columns = (INSERT_COLUMNS.exec(text)?.[1] ?? '').split(',').map((column) => column.trim().replace(/"/g, ''));
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

const writeTo =
  (op: Op, table: string): Predicate =>
  (text) => {
    const target = targetOf(text);
    return target?.op === op && target.table === table;
  };

/** The row-locking select of `table` that `replaceInterests` and `replaceTags` delete from. */
const lockOf =
  (table: string): Predicate =>
  (text) =>
    text.startsWith('SELECT ') && text.includes(` FROM ${qualified(SCHEMA, table)} `) && text.endsWith(' FOR UPDATE');

const isInterestCandidates: Predicate = (text) => text.startsWith('SELECT ') && text.includes(' AS categoryid FROM unnest(');
const isNextIds: Predicate = (text) => text.startsWith('SELECT nextval(');

/** Answers the `user_interest` statements of `replaceInterests` as a table holding `stored`. */
function serveInterests(db: RecordingDb, stored: readonly InterestRow[]): void {
  const held = new Map(stored.map((row) => [row.categoryid, row]));
  db.respond(lockOf(INTEREST.table), (_text, values) => {
    const scope = values[2] as readonly string[] | null;
    return [...held.values()]
      .filter((row) => scope === null || scope.includes(row.categoryid))
      .map(({ userid, categoryid }) => ({ userid, categoryid }));
  });
  db.respond(writeTo('delete', INTEREST_TABLE), (_text, values) => {
    const row = held.get(String(values[2]));
    held.delete(String(values[2]));
    return row === undefined ? [] : [row];
  });
  db.respond(isInterestCandidates, (_text, values) => {
    const ids = values[2] as readonly string[];
    const storable = values[3] as readonly boolean[];
    return ids.filter((id, index) => storable[index] === true && !held.has(id)).map((categoryid) => ({ categoryid }));
  });
  db.respond(writeTo('insert', INTEREST_TABLE), (text, values) => [insertedRow(text, values)]);
}

/** Answers the `user_tag` statements of `replaceTags` as a table holding `stored`, with a sequence from {@link FIRST_TAG_ID}. */
function serveTags(db: RecordingDb, stored: readonly TagRow[]): void {
  const held = new Map(stored.map((row) => [row.tagid, row]));
  let nextId = FIRST_TAG_ID;
  db.respond(lockOf(TAG.table), () => [...held.keys()].sort((a, b) => a - b).map((tagid) => ({ tagid })));
  db.respond(writeTo('delete', TAG_TABLE), (_text, values) => {
    const row = held.get(Number(values[1]));
    held.delete(Number(values[1]));
    return row === undefined ? [] : [row];
  });
  db.respond(isNextIds, (_text, values): QueryResultRow[] => Array.from({ length: Number(values[2]) }, () => ({ id: String(nextId++) })));
  db.respond(writeTo('insert', TAG_TABLE), (text, values) => [insertedRow(text, values)]);
}

/** Every write in order as `[op, table]`; a changelog row reads `[op, 'changelog:<table>']` with the op and table it records. */
function writeTrail(db: RecordingDb): Array<[string, string]> {
  return db.writes().map(({ text, values }): [string, string] => {
    const target = targetOf(text);
    if (target?.table !== CHANGELOG) return [target?.op ?? text, target?.table ?? ''];
    const change = insertedRow(text, values);
    return [String(change.op), `changelog:${String(change.table)}`];
  });
}

/** `count` repetitions of a row write to `table` each followed by its changelog row. */
function loggedWrites(op: Op, table: { table: string }, count: number): Array<[string, string]> {
  return Array.from({ length: count }, (): Array<[string, string]> => [
    [op, `${SCHEMA}.${table.table}`],
    [op, `changelog:${table.table}`],
  ]).flat();
}

/** Changelog rows recorded for `table`, keyed by changelog column name. */
function changelogRows(db: RecordingDb, table: { table: string }): Row[] {
  return db
    .writes()
    .filter(({ text }) => targetOf(text)?.table === CHANGELOG)
    .map(({ text, values }) => insertedRow(text, values))
    .filter((change) => change.table === table.table);
}

function keyOf(def: Pick<TableDefinition, 'columns' | 'key'>, row: Row): string {
  return encodeKey(def.columns, def.key ?? [], row);
}

/** Bound values of the statements `predicate` selects. */
function valuesOf(db: RecordingDb, predicate: Predicate): Array<readonly unknown[]> {
  return db
    .statements()
    .filter(({ text, values }) => predicate(text, values))
    .map(({ values }) => values);
}

function writesTo(db: RecordingDb, op: Op, table: string): RecordedStatement[] {
  return db.writes().filter(({ text, values }) => writeTo(op, table)(text, values));
}

/** Rows the inserts into `table` bind. */
function insertedRows(db: RecordingDb, table: string): Row[] {
  return writesTo(db, 'insert', table).map(({ text, values }) => insertedRow(text, values));
}

/** Key values, tenant first, of the deletes from `table`. */
function deletedKeys(db: RecordingDb, table: string): Array<readonly unknown[]> {
  return writesTo(db, 'delete', table).map(({ values }) => values);
}

/** Asserts that one transaction, begun before the first write and committed after the last, held every write. */
function expectSingleTransaction(db: RecordingDb): void {
  const statements = db.statements();
  const writes = new Set(db.writes());
  const verbs = statements.map(({ text }) => text.split(' ', 1)[0]);
  const first = statements.findIndex((statement) => writes.has(statement));
  const last = statements.findLastIndex((statement) => writes.has(statement));
  expect(verbs.filter((verb) => verb === 'BEGIN')).toHaveLength(1);
  expect(verbs.filter((verb) => verb === 'COMMIT')).toHaveLength(1);
  expect(verbs.indexOf('BEGIN')).toBeLessThan(first);
  expect(verbs.indexOf('COMMIT')).toBeGreaterThan(last);
}

/** The `writeTags` input of a seeded person whose comma list is `tags`. */
function userWithTags(tags: string): { userid: string; siteid: string; tags: string } {
  const { userid, siteid } = personRow({ tags });
  return { userid, siteid: siteid ?? TENANT_A.siteId, tags };
}

describe('interestRowsFor', () => {
  it.each<[string, string, string[]]>([
    ['skips empty items and keeps the first of exact repeats', 'A,,B,A', ['A', 'B']],
    ['answers no rows for an empty list', '', []],
  ])('%s', (_label, list, expected) => {
    const { userid } = personRow();
    expect(interestRowsFor(userid, list)).toStrictEqual(expected.map((categoryid) => ({ userid, categoryid })));
  });
});

describe('tagRowsFor', () => {
  it('trims each item, skips blank ones and keeps duplicates in list order under the given site id', () => {
    const { userid } = personRow();
    expect(tagRowsFor(userid, 'umbrella', ' red , ,blue,red')).toStrictEqual(
      ['red', 'blue', 'red'].map((tag) => ({ userid, siteid: 'umbrella', tag })),
    );
  });
});

describe('writeInterests', () => {
  const STORED = ['KEPT', 'OLD'];
  const LIST = 'NEW,,OTHER,NEW';
  const NEW_IDS = ['NEW', 'OTHER'];

  /** A recording database whose `user_interest` table holds `STORED` for a fresh person. */
  function setup(): { db: RecordingDb; userId: string } {
    const db = createRecordingDb();
    const { userid } = personRow();
    serveInterests(
      db,
      STORED.map((categoryid) => interestRow({ userid, categoryid })),
    );
    return { db, userId: userid };
  }

  it('issues no people.user_interest statement when updateInterests is off', async () => {
    const { db, userId } = setup();

    const rows = await withTenant(db, TENANT_A.tenantId, (tx) =>
      writeInterests(repo, tx, userId, LIST, { updateInterests: false, originId: TENANT_A.siteId, originCategoryIds: ['OLD'] }, {}),
    );

    expect(rows).toStrictEqual([]);
    expect(db.writes()).toStrictEqual([]);
    expect(db.statements().filter(({ text }) => text.includes(qualified(SCHEMA, INTEREST.table)))).toStrictEqual([]);
  });

  it.each<[string, InterestWriteOptions, readonly string[] | null, readonly string[]]>([
    ['deletes every interest without an origin site', { updateInterests: true }, null, STORED],
    ['deletes every interest for an empty origin site id', { updateInterests: true, originId: '', originCategoryIds: ['OLD'] }, null, STORED],
    [
      'narrows the delete to the origin site categories',
      { updateInterests: true, originId: TENANT_A.siteId, originCategoryIds: ['OLD'] },
      ['OLD'],
      ['OLD'],
    ],
    ['deletes nothing for an origin site without categories', { updateInterests: true, originId: TENANT_A.siteId }, [], []],
  ])('%s, then inserts the new list, each write logged, in one transaction', async (_label, opts, scope, deleted) => {
    const { db, userId } = setup();

    const rows = await withTenant(db, TENANT_A.tenantId, (tx) => writeInterests(repo, tx, userId, LIST, opts, {}));

    const expectedRows = NEW_IDS.map((categoryid) => ({ tenant_id: TENANT_A.tenantId, userid: userId, categoryid }));
    expect(valuesOf(db, lockOf(INTEREST.table)).map((values) => values[2])).toStrictEqual([scope]);
    expect(deletedKeys(db, INTEREST_TABLE)).toStrictEqual(deleted.map((categoryid) => [TENANT_A.tenantId, userId, categoryid]));
    expect(insertedRows(db, INTEREST_TABLE)).toStrictEqual(expectedRows);
    expect(rows).toStrictEqual(expectedRows);
    expect(writeTrail(db)).toStrictEqual([
      ...loggedWrites('delete', INTEREST, deleted.length),
      ...loggedWrites('insert', INTEREST, NEW_IDS.length),
    ]);
    expect(changelogRows(db, INTEREST).map(({ op, key }) => [op, key])).toStrictEqual([
      ...deleted.map((categoryid) => ['delete', keyOf(INTEREST, { userid: userId, categoryid })]),
      ...NEW_IDS.map((categoryid) => ['insert', keyOf(INTEREST, { userid: userId, categoryid })]),
    ]);
    expectSingleTransaction(db);
  });

  it('logs each interest write with its row image and the write context', async () => {
    const { db, userId } = setup();
    const ctx = { requestId: 'request-1', actorUserId: 'actor-1', operationId: 'operation-1' };

    await withTenant(db, TENANT_A.tenantId, (tx) =>
      writeInterests(repo, tx, userId, 'NEW', { updateInterests: true, originId: TENANT_A.siteId, originCategoryIds: ['OLD'] }, ctx),
    );

    const image = (categoryid: string): string => encodeRow(INTEREST.columns, { tenant_id: TENANT_A.tenantId, userid: userId, categoryid });
    const provenance = { tenant_id: TENANT_A.tenantId, origin: 'target', request_id: 'request-1', actor_user_id: 'actor-1', operation_id: 'operation-1' };
    expect(changelogRows(db, INTEREST)).toMatchObject([
      { ...provenance, op: 'delete', before: image('OLD'), after: null },
      { ...provenance, op: 'insert', before: null, after: image('NEW') },
    ]);
  });
});

describe('writeTags', () => {
  it.each<[string, number]>([
    ['on create, with no stored tags', 0],
    ['on update, replacing the stored tags', 2],
  ])('deletes the user tags, then inserts the trimmed list, each write logged, %s', async (_label, storedCount) => {
    const db = createRecordingDb();
    const user = userWithTags(' red , ,blue,red');
    const stored = Array.from({ length: storedCount }, () => tagRow({ userid: user.userid, tag: 'old' }));
    serveTags(db, stored);

    const rows = await withTenant(db, TENANT_A.tenantId, (tx) => writeTags(repo, tx, user, {}));

    const expectedRows = ['red', 'blue', 'red'].map((tag, index) => ({
      tenant_id: TENANT_A.tenantId,
      tagid: FIRST_TAG_ID + index,
      userid: user.userid,
      siteid: user.siteid,
      tag,
    }));
    expect(valuesOf(db, lockOf(TAG.table))).toStrictEqual([[TENANT_A.tenantId, user.userid]]);
    expect(deletedKeys(db, TAG_TABLE)).toStrictEqual(stored.map(({ tagid }) => [TENANT_A.tenantId, tagid]));
    expect(insertedRows(db, TAG_TABLE)).toStrictEqual(expectedRows);
    expect(rows).toStrictEqual(expectedRows);
    expect(writeTrail(db)).toStrictEqual([...loggedWrites('delete', TAG, storedCount), ...loggedWrites('insert', TAG, expectedRows.length)]);
    expect(changelogRows(db, TAG).map(({ op, key }) => [op, key])).toStrictEqual([
      ...stored.map((row) => ['delete', keyOf(TAG, row)]),
      ...expectedRows.map((row) => ['insert', keyOf(TAG, row)]),
    ]);
    expectSingleTransaction(db);
  });

  it('deletes the stored tags and inserts none for an empty list', async () => {
    const db = createRecordingDb();
    const user = userWithTags('');
    const stored = [tagRow({ userid: user.userid, tag: 'old' })];
    serveTags(db, stored);

    const rows = await withTenant(db, TENANT_A.tenantId, (tx) => writeTags(repo, tx, user, {}));

    expect(rows).toStrictEqual([]);
    expect(deletedKeys(db, TAG_TABLE)).toStrictEqual(stored.map(({ tagid }) => [TENANT_A.tenantId, tagid]));
    expect(writeTrail(db)).toStrictEqual(loggedWrites('delete', TAG, stored.length));
    expect(valuesOf(db, isNextIds)).toStrictEqual([]);
  });
});

describe('writeInterests behind a closed people.user_interest gate', () => {
  it.each<[string, number]>([
    ['with a stored interest to delete', 1],
    ['with only interests to insert', 0],
  ])(
    'fails with GateClosedError and writes nothing %s',
    async (_label, storedCount) => {
      const db = createRecordingDb();
      const { userid } = personRow();
      serveInterests(
        db,
        Array.from({ length: storedCount }, () => interestRow({ userid, categoryid: 'OLD' })),
      );
      db.setGate(INTEREST.unit, 'closed');

      // As the roster protocol runs it: the gated runner bounds the wait and turns the fenced read's gate races into GateClosedError.
      const failure = await withGatedTenant(
        db,
        TENANT_A.tenantId,
        (tx) => writeInterests(repo, tx, userid, 'NEW', { updateInterests: true }, {}),
        { budgetMs: GATE_BUDGET_MS },
      ).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(GateClosedError);
      expect(failure).toMatchObject({ units: [INTEREST.unit], reason: 'unit-gate-closed' });
      expect(db.writes()).toStrictEqual([]);
      expect(db.statements().map(({ text }) => text)).not.toContain('COMMIT');
    },
    5_000,
  );
});
