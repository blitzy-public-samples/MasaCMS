import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CURSOR_START,
  InvalidCursorError,
  createRepository,
  currentPosition,
  decodeRow,
  encodeKey,
  encodeRow,
  formatCanonicalTimestamp,
  formatCursor,
  isApplied,
  legacyRowHash,
  migrationKitSql,
  parseCursor,
  readChanges,
  type CanonicalColumn,
  type ChangeRow,
  type ChangesPage,
  type Repository,
  type RepositoryRow,
  type TableDefinition,
  type WriteContext,
} from '../../src/migration-kit/index.js';
import { currentRequestContext, fixedClock, newRequestContext, runWithRequestContext } from '../../src/service-kit/index.js';
import { InvalidTenantIdError, rlsSql, tenantIdForSite, withTenant, type TenantDb, type TenantTx } from '../../src/tenancy/index.js';
import { TENANT_A, TENANT_B, createThrowawaySchema, pgAvailable, testPgConfig, type ThrowawaySchema } from '../../src/testing/index.js';

const OWNER = 'isochg';
const CLOCK = fixedClock('2026-06-30T12:00:00');
const STAMP = '2026-06-30 12:00:00.000';
const HORIZON_WAIT_MS = 30_000;
const PAGE_LIMIT = 100;

const NOTE_COLUMNS: CanonicalColumn[] = [
  { name: 'tenant_id', type: 's' },
  { name: 'id', type: 's' },
  { name: 'body', type: 's' },
  { name: 'row_version', type: 'i' },
];
const NOTE_DATA = ['id', 'body', 'row_version'];
const REMINDER_DATA: CanonicalColumn[] = [
  { name: 'content_id', type: 's' },
  { name: 'site_id', type: 's' },
  { name: 'email', type: 's' },
  { name: 'remind_date', type: 't' },
];
const REMINDER_COLUMNS: CanonicalColumn[] = [
  { name: 'tenant_id', type: 's' },
  ...REMINDER_DATA,
  { name: 'legacy_row_hash', type: 's' },
  { name: 'occurrence', type: 'i' },
];
const NOTE: TableDefinition = { table: 'note', columns: NOTE_COLUMNS, key: ['id'] };
const REMINDER: TableDefinition = { table: 'reminder', columns: REMINDER_COLUMNS, key: null };

const TABLES_SQL = [
  `CREATE TABLE ${OWNER}.note (tenant_id uuid NOT NULL, id char(35) PRIMARY KEY, body text, row_version int NOT NULL DEFAULT 0);`,
  rlsSql(OWNER, 'note'),
  `CREATE TABLE ${OWNER}.reminder (tenant_id uuid NOT NULL, content_id char(35) NOT NULL, site_id text NOT NULL, email text NOT NULL,`,
  '  remind_date timestamp(3), legacy_row_hash text NOT NULL, occurrence integer NOT NULL,',
  '  PRIMARY KEY (tenant_id, legacy_row_hash, occurrence));',
  rlsSql(OWNER, 'reminder'),
].join('\n');

const unreachableDb: TenantDb = {
  schema: 'unreachable',
  withTenant: () => Promise.reject(new Error('the database must not be reached')),
  withMetadata: () => Promise.reject(new Error('the database must not be reached')),
  end: () => Promise.resolve(),
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A promise with its resolver exposed. */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A 35-character CF-format id ending in `n`. */
function cfId(n: number): string {
  return `00000000-0000-0000-${String(n).padStart(16, '0')}`;
}

/** The changelog key of the note with `id`. */
function noteKey(id: string): string {
  return encodeKey(NOTE_COLUMNS, ['id'], { id });
}

/** The transaction's own xid8 as a decimal string. */
async function txXid(tx: TenantTx): Promise<string> {
  const { rows } = await tx.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid');
  return (rows[0] as { xid: string }).xid;
}

function keysOf(page: ChangesPage): string[] {
  return page.rows.map((row) => row.key);
}

describe('changelog cursor text', () => {
  it('starts at 0:0 when the cursor is missing', () => {
    expect(parseCursor()).toEqual({ xid: 0n, seq: 0n });
    expect(parseCursor(CURSOR_START)).toEqual({ xid: 0n, seq: 0n });
  });

  it.each(['12:34', '0:7', '18446744073709551615:9223372036854775807'])('round-trips %s', (text) => {
    expect(formatCursor(parseCursor(text))).toBe(text);
  });

  it.each(['', 'a:b', '1', '1:2:3', '01:2', '1:02', '-1:2', ' 1:2', '1:2\n', '1.5:2', '18446744073709551616:0', '0:9223372036854775808'])(
    'rejects %j',
    (text) => {
      let caught: unknown;
      try {
        parseCursor(text);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidCursorError);
      expect(caught).toMatchObject({ name: 'InvalidCursorError', cursor: text });
    },
  );
});

describe('isApplied', () => {
  it.each([
    ['10', '11', true],
    ['10', '10', false],
    ['11', '10', false],
    ['99', '100', true],
    // Equal as Numbers, so only a BigInt comparison tells them apart.
    ['9007199254740992', '9007199254740993', true],
    ['9007199254740993', '9007199254740992', false],
  ] as const)('position %s under horizon %s is %s', (position, horizon, expected) => {
    expect(isApplied(position, horizon)).toBe(expected);
  });
});

describe('readChanges arguments', () => {
  it.each([0, -1, 10_001, 1.5, Number.NaN])('rejects limit %s before connecting', async (limit) => {
    await expect(readChanges(unreachableDb, { tenantId: TENANT_A.tenantId, limit })).rejects.toThrow(RangeError);
  });

  it('rejects a malformed cursor before connecting', async () => {
    await expect(readChanges(unreachableDb, { tenantId: TENANT_A.tenantId, after: 'x' })).rejects.toThrow(InvalidCursorError);
  });
});

describe('changelog hook and commit-safe cursor against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: Repository;
  let tenants = 0;
  let ids = 0;

  beforeAll(async () => {
    const config = testPgConfig();
    if (!(await pgAvailable())) {
      throw new Error(`PostgreSQL at PG_HOST=${config.host} PG_PORT=${config.port} is unreachable`);
    }
    handle = await createThrowawaySchema({ service: OWNER, extraSql: [migrationKitSql(OWNER), TABLES_SQL] });
    repo = createRepository({ owner: OWNER, schema: handle.schema, tables: [NOTE, REMINDER], clock: CLOCK });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  /** A tenant no other test writes. */
  function freshTenant(): string {
    tenants += 1;
    return tenantIdForSite(`isochg-${tenants}`);
  }

  function nextId(): string {
    ids += 1;
    return cfId(ids);
  }

  /** Commits one note in its own transaction; returns its key and the transaction's xid. */
  async function commitNote(tenantId: string, body: string): Promise<{ key: string; xid: string }> {
    const id = nextId();
    const xid = await withTenant(handle.app, tenantId, async (tx) => {
      await repo.insert(tx, 'note', { id, body });
      return txXid(tx);
    });
    return { key: noteKey(id), xid };
  }

  /** The tenant's first page once its horizon has passed `position`; any open transaction in the cluster holds the horizon back. */
  async function settled(tenantId: string, position: string): Promise<ChangesPage> {
    const deadline = Date.now() + HORIZON_WAIT_MS;
    for (;;) {
      const page = await readChanges(handle.app, { tenantId, after: CURSOR_START, limit: PAGE_LIMIT });
      if (page.complete && isApplied(position, page.horizon)) return page;
      if (Date.now() > deadline) {
        throw new Error(`changelog horizon ${page.horizon} did not pass ${position} within ${HORIZON_WAIT_MS} ms`);
      }
      await sleep(100);
    }
  }

  it('logs an insert as one changelog row of its own transaction, read back through the cursor', async () => {
    const tenant = freshTenant();
    const id = nextId();
    const ctx: WriteContext = { origin: 'target', actorUserId: 'user-7', actorService: 'people' };
    const { stored, xid, logged } = await runWithRequestContext(newRequestContext({ requestId: 'req-1' }), () =>
      withTenant(handle.app, tenant, async (tx) => {
        const row = await repo.insert(tx, 'note', { id, body: 'hello' }, ctx);
        const { rows } = await tx.query<{ xid: string }>(`SELECT xid::text AS xid FROM ${handle.schema}.changelog WHERE key = $1`, [
          noteKey(id),
        ]);
        return { stored: row, xid: await txXid(tx), logged: rows.map((r) => r.xid) };
      }),
    );
    expect(stored).toEqual({ tenant_id: tenant, id, body: 'hello', row_version: 0 });
    expect(logged).toEqual([xid]);

    const page = await settled(tenant, xid);
    expect(page.rows).toEqual([
      {
        xid,
        seq: expect.stringMatching(/^\d+$/),
        table: 'note',
        op: 'insert',
        key: encodeKey(NOTE_COLUMNS, ['id'], stored),
        before: null,
        after: encodeRow(NOTE_COLUMNS, stored),
        columns: NOTE_DATA,
        origin: 'target',
        actorUserId: 'user-7',
        actorService: 'people',
        at: STAMP,
        requestId: 'req-1',
        operationId: null,
      },
    ]);
  });

  it('logs an update with both images and only its changed columns, and a delete with its before image only', async () => {
    const tenant = freshTenant();
    const id = nextId();
    const { inserted, updated, removed, xid } = await withTenant(handle.app, tenant, async (tx) => ({
      inserted: await repo.insert(tx, 'note', { id, body: 'draft' }),
      updated: (await repo.update(tx, 'note', { id }, { body: 'final', row_version: 0 })) as RepositoryRow,
      removed: (await repo.delete(tx, 'note', { id })) as RepositoryRow,
      xid: await txXid(tx),
    }));
    expect(updated).toEqual({ ...inserted, body: 'final' });
    expect(removed).toEqual(updated);

    const { rows } = await settled(tenant, xid);
    expect(rows.map((row) => [row.op, row.xid, row.key])).toEqual([
      ['insert', xid, noteKey(id)],
      ['update', xid, noteKey(id)],
      ['delete', xid, noteKey(id)],
    ]);
    expect(rows[1]).toMatchObject({ before: encodeRow(NOTE_COLUMNS, inserted), after: encodeRow(NOTE_COLUMNS, updated), columns: ['body'] });
    expect(rows[2]).toMatchObject({ before: encodeRow(NOTE_COLUMNS, updated), after: null, columns: NOTE_DATA });
  });

  it('logs an upsert as the insert or update it resolved to', async () => {
    const tenant = freshTenant();
    const id = nextId();
    const xid = await withTenant(handle.app, tenant, async (tx) => {
      await repo.upsert(tx, 'note', { id, body: 'first' });
      await repo.upsert(tx, 'note', { id, body: 'second' });
      return txXid(tx);
    });
    const { rows } = await settled(tenant, xid);
    expect(rows.map((row) => [row.op, row.columns])).toEqual([
      ['insert', NOTE_DATA],
      ['update', ['body']],
    ]);
    expect(rows[1]?.after).toBe(encodeRow(NOTE_COLUMNS, { tenant_id: tenant, id, body: 'second', row_version: 0 }));
  });

  it('rolls back the row, its changelog row and its write position together', async () => {
    const tenant = freshTenant();
    const id = nextId();
    const store = newRequestContext({ requestId: 'req-rollback' });
    let lostXid = '';
    await expect(
      runWithRequestContext(store, () =>
        withTenant(handle.app, tenant, async (tx) => {
          await repo.insert(tx, 'note', { id, body: 'lost' });
          lostXid = await txXid(tx);
          throw new Error('abort');
        }),
      ),
    ).rejects.toThrow('abort');
    expect(store.writePositions.size).toBe(0);

    const kept = await commitNote(tenant, 'kept');
    const page = await settled(tenant, kept.xid);
    expect(isApplied(lostXid, page.horizon)).toBe(true);
    expect(keysOf(page)).toEqual([kept.key]);
    expect(await withTenant(handle.app, tenant, (tx) => repo.findByKey(tx, 'note', { id }))).toBeNull();
  });

  it('stores identical keyless rows as numbered occurrences and deletes exactly one with its full before image', async () => {
    const tenant = freshTenant();
    const reminder = { content_id: cfId(900_001), site_id: 'default', email: 'member@example.test', remind_date: '2026-07-01 09:30:00.000' };
    const { stored, removed, remaining, xid } = await withTenant(handle.app, tenant, async (tx) => {
      const first = await repo.insert(tx, 'reminder', reminder);
      const second = await repo.insert(tx, 'reminder', reminder);
      const deleted = await repo.deleteOne(tx, 'reminder', reminder);
      const { rows } = await tx.query<{ occurrence: number }>(`SELECT occurrence FROM ${handle.schema}.reminder`);
      return { stored: [first, second], removed: deleted, remaining: rows, xid: await txXid(tx) };
    });
    const hash = legacyRowHash(REMINDER_DATA, reminder);
    expect(stored.map((row) => [row.legacy_row_hash, row.occurrence])).toEqual([
      [hash, 1],
      [hash, 2],
    ]);
    expect(removed).toEqual(stored[1]);
    expect(remaining).toEqual([{ occurrence: 1 }]);

    const { rows } = await settled(tenant, xid);
    const content = encodeRow(REMINDER_DATA, reminder);
    expect(rows.map((row) => [row.op, row.key])).toEqual([
      ['insert', content],
      ['insert', content],
      ['delete', content],
    ]);
    const deletion = rows[2];
    expect(deletion).toMatchObject({
      before: encodeRow(REMINDER_COLUMNS, stored[1] as RepositoryRow),
      after: null,
      columns: REMINDER_DATA.map((column) => column.name),
    });
    expect(decodeRow(REMINDER_COLUMNS, deletion?.before ?? '')).toEqual({
      tenant_id: tenant,
      content_id: reminder.content_id,
      site_id: reminder.site_id,
      email: reminder.email,
      remind_date: formatCanonicalTimestamp(reminder.remind_date),
      legacy_row_hash: hash,
      occurrence: '2',
    });
  });

  it('withholds the rows of an open older transaction and of every newer one, then returns them in (xid, seq) order', async () => {
    const tenant = TENANT_A.tenantId;
    const oldId = nextId();
    const opened = deferred<string>();
    const proceed = deferred();
    const inserted = deferred();
    const held = deferred();
    const older = withTenant(handle.app, tenant, async (tx) => {
      opened.resolve(await txXid(tx));
      await proceed.promise;
      await repo.insert(tx, 'note', { id: oldId, body: 'old' });
      inserted.resolve();
      await held.promise;
    });
    /** Resolves with `step`, or rejects as soon as the older transaction settles first. */
    const whileOpen = <T>(step: Promise<T>): Promise<T> =>
      Promise.race([step, older.then(() => Promise.reject(new Error('the older transaction ended while held open')))]);

    let oldXid = '';
    let newer = { key: '', xid: '' };
    try {
      oldXid = await whileOpen(opened.promise);
      newer = await commitNote(tenant, 'new');
      expect(BigInt(newer.xid) > BigInt(oldXid)).toBe(true);
      proceed.resolve();
      await whileOpen(inserted.promise);

      const blocked = await readChanges(handle.app, { tenantId: tenant, after: CURSOR_START, limit: PAGE_LIMIT });
      expect(BigInt(blocked.horizon) <= BigInt(oldXid)).toBe(true);
      expect(blocked).toMatchObject({ rows: [], cursor: CURSOR_START, complete: true });
      expect(isApplied(newer.xid, blocked.horizon)).toBe(false);
    } finally {
      proceed.resolve();
      held.resolve();
      await older;
    }

    const page = await settled(tenant, newer.xid);
    expect(page.rows.map((row) => [row.key, row.xid])).toEqual([
      [noteKey(oldId), oldXid],
      [newer.key, newer.xid],
    ]);
    const [oldRow, newRow] = page.rows as [ChangeRow, ChangeRow];
    // The older transaction wrote after the newer one committed, so only the xid puts it first.
    expect(BigInt(oldRow.seq) > BigInt(newRow.seq)).toBe(true);
    expect(page.cursor).toBe(formatCursor({ xid: BigInt(newRow.xid), seq: BigInt(newRow.seq) }));
    expect(isApplied(oldXid, page.horizon)).toBe(true);

    const next = await readChanges(handle.app, { tenantId: tenant, after: page.cursor, limit: PAGE_LIMIT });
    expect(next).toMatchObject({ rows: [], cursor: page.cursor, complete: true });
  });

  it('never shows one tenant the changes of another', async () => {
    const written = await commitNote(TENANT_B.tenantId, 'b only');
    expect(keysOf(await settled(TENANT_B.tenantId, written.xid))).toContain(written.key);
    expect(keysOf(await settled(TENANT_A.tenantId, written.xid))).not.toContain(written.key);
  });

  it('reports a current position at or past the latest committed write, applied once a horizon passes it', async () => {
    const tenant = freshTenant();
    const written = await commitNote(tenant, 'positioned');
    const position = await currentPosition(handle.app);
    expect(position).toMatch(/^\d+$/);
    expect(BigInt(position) >= BigInt(written.xid)).toBe(true);

    const page = await settled(tenant, position);
    expect(isApplied(written.xid, page.horizon)).toBe(true);
    expect(keysOf(page)).toEqual([written.key]);
  });

  it('records the committed transaction xid as the request write position of its owner', async () => {
    const tenant = freshTenant();
    const { xid, position } = await runWithRequestContext(newRequestContext({ requestId: 'req-position' }), async () => {
      const committed = await commitNote(tenant, 'recorded');
      return { xid: committed.xid, position: currentRequestContext()?.writePositions.get(OWNER) };
    });
    expect(position).toBe(xid);
  });

  it.each([2, 5, 7])('pages every row exactly once with limit %i', async (limit) => {
    const tenant = freshTenant();
    const keys: string[] = [];
    let last = '0';
    for (let i = 0; i < 6; i += 1) {
      const written = await commitNote(tenant, `page-${i}`);
      keys.push(written.key);
      last = written.xid;
    }
    await settled(tenant, last);

    const seen: string[] = [];
    const completes: boolean[] = [];
    let cursor = CURSOR_START;
    for (;;) {
      const page = await readChanges(handle.app, { tenantId: tenant, after: cursor, limit });
      seen.push(...keysOf(page));
      completes.push(page.complete);
      cursor = page.cursor;
      if (page.complete) break;
    }
    expect(seen).toEqual(keys);
    expect(completes).toEqual([...Array<boolean>(Math.floor(keys.length / limit)).fill(false), true]);
  });

  it('orders rows numerically where seq crosses a decimal digit boundary', async () => {
    const tenant = freshTenant();
    const noteIds = [nextId(), nextId(), nextId()];
    const xid = await withTenant(handle.app, tenant, async (tx) => {
      await tx.query("SELECT setval(pg_get_serial_sequence($1, 'seq'), 9999999998)", [`${handle.schema}.changelog`]);
      for (const id of noteIds) await repo.insert(tx, 'note', { id, body: id });
      return txXid(tx);
    });
    const { rows } = await settled(tenant, xid);
    expect(rows.map((row) => [row.seq, row.key])).toEqual(noteIds.map((id, i) => [String(9_999_999_999 + i), noteKey(id)]));
  });

  it('rejects a tenant id that is not a UUID', async () => {
    await expect(readChanges(handle.app, { tenantId: 'tenant-a' })).rejects.toThrow(InvalidTenantIdError);
  });
});
