import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CURSOR_START,
  InvalidCursorError,
  currentPosition,
  formatCursor,
  isApplied,
  parseCursor,
  readChanges,
  type ChangesPage,
} from '../../src/migration-kit/cursor.js';
import { changelogSql } from '../../src/migration-kit/ddl.js';
import { InvalidTenantIdError, tenantIdForSite, type TenantDb } from '../../src/tenancy/index.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const HORIZON_WAIT_MS = 30_000;

const unreachableDb: TenantDb = {
  schema: 'unreachable',
  withTenant: () => Promise.reject(new Error('the database must not be reached')),
  withMetadata: () => Promise.reject(new Error('the database must not be reached')),
  end: () => Promise.resolve(),
};

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
    ['5', '6', true],
    ['6', '6', false],
    ['7', '6', false],
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
    await expect(readChanges(unreachableDb, { tenantId: TENANT_A, limit })).rejects.toThrow(RangeError);
  });

  it('rejects a malformed cursor before connecting', async () => {
    await expect(readChanges(unreachableDb, { tenantId: TENANT_A, after: 'x' })).rejects.toThrow(InvalidCursorError);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('readChanges and currentPosition against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let table: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'changelog-cursor', extraSql: [changelogSql('changelog_cursor')] });
    table = `${handle.schema}.changelog`;
  });

  afterAll(async () => {
    await handle?.drop();
  });

  async function insertCommitted(tenantId: string, key: string): Promise<{ xid: string; seq: string }> {
    return handle.app.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query<{ xid: string; seq: string }>(
        `INSERT INTO ${table} (tenant_id, "table", op, key, after, columns, origin)
         VALUES ($1::uuid, 'tusers', 'insert', $2, 'after', '{c1,c2}', 'target') RETURNING xid::text AS xid, seq::text AS seq`,
        [tenantId, key],
      );
      return rows[0] as { xid: string; seq: string };
    });
  }

  // The horizon is cluster-wide, so an unrelated open transaction can hold it back for a while.
  async function readUntil(read: () => Promise<ChangesPage>, done: (page: ChangesPage) => boolean): Promise<ChangesPage> {
    const deadline = Date.now() + HORIZON_WAIT_MS;
    let page = await read();
    while (!done(page) && Date.now() < deadline) {
      await sleep(100);
      page = await read();
    }
    return page;
  }

  it('never reads past an open older transaction and returns rows in (xid, seq) order', async () => {
    const older = await handle.appPool.connect();
    try {
      await older.query('BEGIN');
      await older.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]);
      const { rows: xidRows } = await older.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid');
      const olderXid = (xidRows[0] as { xid: string }).xid;

      const newer = await insertCommitted(TENANT_A, 'newer');
      expect(BigInt(newer.xid) > BigInt(olderXid)).toBe(true);

      const { rows: seqRows } = await older.query<{ seq: string }>(
        `INSERT INTO ${table} (tenant_id, "table", op, key, before, after, origin, actor_user_id, request_id, operation_id)
         VALUES ($1::uuid, 'tusers', 'update', 'older', 'b', 'a', 'target', 'u1', 'r1', 'op1') RETURNING seq::text AS seq`,
        [TENANT_A],
      );
      const olderSeq = (seqRows[0] as { seq: string }).seq;
      expect(BigInt(olderSeq) > BigInt(newer.seq)).toBe(true);

      const blocked = await readChanges(handle.app, { tenantId: TENANT_A });
      expect(blocked).toMatchObject({ rows: [], cursor: CURSOR_START, complete: true });
      expect(BigInt(blocked.horizon) <= BigInt(olderXid)).toBe(true);
      expect(isApplied(newer.xid, blocked.horizon)).toBe(false);
      expect(BigInt(await currentPosition(handle.app)) >= BigInt(newer.xid)).toBe(true);

      await older.query('COMMIT');

      const page = await readUntil(
        () => readChanges(handle.app, { tenantId: TENANT_A }),
        (p) => p.rows.length === 2 && isApplied(newer.xid, p.horizon),
      );
      expect(page.rows.map((row) => row.key)).toEqual(['older', 'newer']);
      expect(page.rows[0]).toEqual({
        xid: olderXid,
        seq: olderSeq,
        table: 'tusers',
        op: 'update',
        key: 'older',
        before: 'b',
        after: 'a',
        columns: [],
        origin: 'target',
        actorUserId: 'u1',
        actorService: null,
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/),
        requestId: 'r1',
        operationId: 'op1',
      });
      expect(page.rows[1]).toMatchObject({ op: 'insert', before: null, columns: ['c1', 'c2'], actorUserId: null, operationId: null });
      expect(page.cursor).toBe(`${newer.xid}:${newer.seq}`);
      expect(isApplied(olderXid, page.horizon)).toBe(true);

      const next = await readChanges(handle.app, { tenantId: TENANT_A, after: page.cursor });
      expect(next).toMatchObject({ rows: [], cursor: page.cursor, complete: true });
    } finally {
      await older.query('ROLLBACK').catch(() => undefined);
      older.release();
    }
  });

  it('never shows one tenant the rows of another', async () => {
    const written = await insertCommitted(TENANT_B, 'b-only');
    const pageB = await readUntil(
      () => readChanges(handle.app, { tenantId: TENANT_B }),
      (p) => isApplied(written.xid, p.horizon),
    );
    expect(pageB.rows.map((row) => row.key)).toEqual(['b-only']);
    const pageA = await readChanges(handle.app, { tenantId: TENANT_A });
    expect(pageA.rows.map((row) => row.key)).not.toContain('b-only');
  });

  it.each([2, 5, 7])('pages every row exactly once with limit %i', async (limit) => {
    const tenant = tenantIdForSite(`paging-${limit}`);
    const keys = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
    let last = { xid: '0', seq: '0' };
    for (const key of keys) last = await insertCommitted(tenant, key);
    await readUntil(
      () => readChanges(handle.app, { tenantId: tenant, limit: 1 }),
      (p) => isApplied(last.xid, p.horizon),
    );

    const seen: string[] = [];
    const completes: boolean[] = [];
    let cursor = CURSOR_START;
    for (;;) {
      const page = await readChanges(handle.app, { tenantId: tenant, after: cursor, limit });
      seen.push(...page.rows.map((row) => row.key));
      completes.push(page.complete);
      cursor = page.cursor;
      if (page.complete) break;
    }
    expect(seen).toEqual(keys);
    expect(completes).toEqual([...Array<boolean>(Math.floor(keys.length / limit)).fill(false), true]);
  });

  it('rejects a tenant id that is not a UUID', async () => {
    await expect(readChanges(handle.app, { tenantId: 'tenant-a' })).rejects.toThrow(InvalidTenantIdError);
  });
});
