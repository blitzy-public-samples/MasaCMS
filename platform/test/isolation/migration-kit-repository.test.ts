import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '../../src/legacy-compat/index.js';
import { encodeKey, encodeRow, legacyRowHash, type CanonicalColumn } from '../../src/migration-kit/canonical.js';
import { migrationKitSql, type GatePhase, type GateState } from '../../src/migration-kit/ddl.js';
import {
  GateClosedError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  createMigrationAuthority,
  ensureUnitGates,
  withGatedTenant,
  type MigrationAuthority,
} from '../../src/migration-kit/gates.js';
import {
  RepositoryError,
  createRepository,
  type Repository,
  type RepositoryRow,
  type TableDefinition,
} from '../../src/migration-kit/repository.js';
import { localTimestamp } from '../../src/outbox/ddl.js';
import { fixedClock, newRequestContext, runWithRequestContext, type RequestContextStore } from '../../src/service-kit/index.js';
import {
  OutsideTenantTransactionError,
  rlsSql,
  tenantDbFromPool,
  tenantIdForSite,
  withMetadata,
  type Pool,
  type TenantDb,
  type TenantTx,
} from '../../src/tenancy/index.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';

const BASE = 'mk_repository';
const OWNER = 'mk-repository';
const ITEM_UNIT = 'item';
const TAG_UNIT = 'tag_member';
const TENANT = tenantIdForSite('tenant-a');
const OTHER_TENANT = tenantIdForSite('tenant-b');
const CLOCK = fixedClock('2026-06-30T12:34:56.789Z');

const ITEM_COLUMNS: CanonicalColumn[] = [
  { name: 'tenant_id', type: 's' },
  { name: 'item_id', type: 's' },
  { name: 'name', type: 's' },
  { name: 'qty', type: 'i' },
];
const TAG_DATA: CanonicalColumn[] = [
  { name: 'label', type: 's' },
  { name: 'weight', type: 'i' },
];
const TAG_COLUMNS: CanonicalColumn[] = [
  { name: 'tenant_id', type: 's' },
  ...TAG_DATA,
  { name: 'legacy_row_hash', type: 's' },
  { name: 'occurrence', type: 'i' },
];
const ITEM: TableDefinition = { table: 'item', columns: ITEM_COLUMNS, key: ['item_id'], unit: ITEM_UNIT };
const TAG: TableDefinition = { table: 'tag_member', columns: TAG_COLUMNS, key: null, unit: TAG_UNIT };

const TABLES_SQL = [
  `CREATE TABLE ${BASE}.item (tenant_id uuid NOT NULL, item_id text NOT NULL, name text, qty integer,`,
  '  PRIMARY KEY (tenant_id, item_id), UNIQUE (tenant_id, name));',
  rlsSql(BASE, 'item'),
  `CREATE TABLE ${BASE}.tag_member (tenant_id uuid NOT NULL, label text, weight integer,`,
  '  legacy_row_hash text NOT NULL, occurrence integer NOT NULL, PRIMARY KEY (tenant_id, legacy_row_hash, occurrence));',
  rlsSql(BASE, 'tag_member'),
].join('\n');

/** The error `fn` throws or rejects with; fails the test when it settles normally. */
async function failure(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

/** A TenantDb whose transactions record every statement and answer each with no rows. */
function recordingDb(schema: string): { db: TenantDb; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: (text: string) => {
      statements.push(text);
      return Promise.resolve({ command: text, rows: [] });
    },
    release: () => undefined,
  };
  const pool = { on: () => pool, connect: () => Promise.resolve(client) } as unknown as Pool;
  return { db: tenantDbFromPool(pool, { schema }), statements };
}

describe('createRepository table definitions', () => {
  it.each([
    ['a platform infrastructure table', [{ ...ITEM, table: 'changelog' }], 'changelog', 'is a platform table written only by platform internals'],
    ['a column listed twice', [{ ...ITEM, columns: [...ITEM_COLUMNS, { name: 'qty', type: 'i' }] }], 'item', 'lists a column twice'],
    ['a table without tenant_id', [{ ...ITEM, columns: ITEM_COLUMNS.slice(1) }], 'item', 'has no tenant_id column'],
    [
      'a keyless table without legacy_row_hash',
      [{ ...TAG, columns: TAG_COLUMNS.filter((column) => column.name !== 'legacy_row_hash') }],
      'tag_member',
      'is keyless but lacks legacy_row_hash or occurrence',
    ],
    [
      'a keyless table without occurrence',
      [{ ...TAG, columns: TAG_COLUMNS.filter((column) => column.name !== 'occurrence') }],
      'tag_member',
      'is keyless but lacks legacy_row_hash or occurrence',
    ],
    ['an empty key', [{ ...ITEM, key: [] }], 'item', 'key must name declared columns other than tenant_id'],
    ['a key on tenant_id', [{ ...ITEM, key: ['tenant_id', 'item_id'] }], 'item', 'key must name declared columns other than tenant_id'],
    ['a key on an undeclared column', [{ ...ITEM, key: ['sku'] }], 'item', 'key must name declared columns other than tenant_id'],
    ['a table declared twice', [ITEM, ITEM], 'item', 'is declared twice'],
  ] as [string, TableDefinition[], string, string][])('rejects %s', async (_label, tables, table, problem) => {
    const err = await failure(() => createRepository({ owner: OWNER, schema: BASE, tables }));
    expect(err).toBeInstanceOf(RepositoryError);
    expect(err).toMatchObject({ name: 'RepositoryError', table, message: `${table}: ${problem}` });
  });

  it('exposes frozen copies of the definitions and the distinct units in declaration order', async () => {
    const columns = ITEM_COLUMNS.map((column) => ({ ...column }));
    const repo = createRepository({
      owner: OWNER,
      schema: BASE,
      tables: [{ ...ITEM, columns }, TAG, { ...ITEM, table: 'item_archive' }, { ...ITEM, table: 'scratch', unit: undefined }],
    });
    columns[1] = { name: 'renamed', type: 's' };

    expect(Object.isFrozen(repo)).toBe(true);
    expect(repo).toMatchObject({ owner: OWNER, schema: BASE });
    const item = repo.definition('item');
    expect(item).toEqual(ITEM);
    expect(Object.isFrozen(item) && Object.isFrozen(item.columns) && Object.isFrozen(item.key)).toBe(true);
    expect(repo.definition('scratch')).not.toHaveProperty('unit');

    const units = repo.units();
    expect(units).toEqual([ITEM_UNIT, TAG_UNIT]);
    units.push('mutated');
    expect(repo.units()).toEqual([ITEM_UNIT, TAG_UNIT]);

    const err = await failure(() => repo.definition('missing'));
    expect(err).toMatchObject({ name: 'RepositoryError', table: 'missing', message: `missing: is not a declared table of schema ${BASE}` });
  });
});

describe('repository calls rejected before any statement', () => {
  const repo = createRepository({ owner: OWNER, schema: BASE, tables: [ITEM, TAG] });
  const elsewhere = createRepository({ owner: OWNER, schema: 'other_schema', tables: [ITEM] });

  it.each([
    ['an undeclared table', (tx: TenantTx) => repo.insert(tx, 'missing', { item_id: 'a' }), 'missing', `is not a declared table of schema ${BASE}`],
    ['an undeclared column', (tx: TenantTx) => repo.insert(tx, 'item', { item_id: 'a', colour: 'red' }), 'item', 'has no column colour'],
    [
      'a row of another tenant',
      (tx: TenantTx) => repo.insert(tx, 'item', { tenant_id: OTHER_TENANT, item_id: 'a' }),
      'item',
      `row tenant ${OTHER_TENANT} is not the transaction tenant ${TENANT}`,
    ],
    ['an update key without its key column', (tx: TenantTx) => repo.update(tx, 'item', {}, { qty: 1 }), 'item', 'key has no value for item_id'],
    ['a delete key with a null key column', (tx: TenantTx) => repo.delete(tx, 'item', { item_id: null }), 'item', 'key has no value for item_id'],
    ['an upsert row without its key column', (tx: TenantTx) => repo.upsert(tx, 'item', { name: 'n' }), 'item', 'key has no value for item_id'],
    ['a findByKey key without its key column', (tx: TenantTx) => repo.findByKey(tx, 'item', { name: 'n' }), 'item', 'key has no value for item_id'],
    [
      'an update patch that sets no column',
      (tx: TenantTx) => repo.update(tx, 'item', { item_id: 'a' }, { tenant_id: TENANT, qty: undefined }),
      'item',
      'update patch sets no column',
    ],
    [
      'an update of a keyless table',
      (tx: TenantTx) => repo.update(tx, 'tag_member', { label: 'a' }, { weight: 1 }),
      'tag_member',
      'has no primary key; write it with insert, deleteOne or replaceOne',
    ],
    [
      'a deleteOne of a keyed table',
      (tx: TenantTx) => repo.deleteOne(tx, 'item', { item_id: 'a' }),
      'item',
      'has a primary key; write it with insert, update, upsert or delete',
    ],
    [
      'a replaceOne after-row with an undeclared column',
      (tx: TenantTx) => repo.replaceOne(tx, 'tag_member', { label: 'a', weight: 1 }, { label: 'b', shade: 'x' }),
      'tag_member',
      'has no column shade',
    ],
    [
      'a transaction on another schema',
      (tx: TenantTx) => elsewhere.insert(tx, 'item', { item_id: 'a' }),
      undefined,
      'needs a tenant transaction on schema other_schema',
    ],
    [
      'a handle that is not a tenant transaction',
      () => repo.read({ kind: 'metadata', schema: BASE } as unknown as TenantTx, ITEM_UNIT, () => Promise.resolve(1)),
      undefined,
      `needs a tenant transaction on schema ${BASE}`,
    ],
  ] as [string, (tx: TenantTx) => Promise<unknown>, string | undefined, string][])(
    'rejects %s with RepositoryError',
    async (_label, call, table, problem) => {
      const { db, statements } = recordingDb(BASE);
      const err = await failure(() => db.withTenant(TENANT, call));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err).toMatchObject({ name: 'RepositoryError', table, message: table === undefined ? problem : `${table}: ${problem}` });
      expect(statements).toEqual(['BEGIN', expect.stringContaining("set_config('app.tenant_id'"), 'ROLLBACK']);
    },
  );

  it.each([
    ['insert', (tx: TenantTx) => repo.insert(tx, 'item', { item_id: 'a' })],
    ['update', (tx: TenantTx) => repo.update(tx, 'item', { item_id: 'a' }, { qty: 1 })],
    ['upsert', (tx: TenantTx) => repo.upsert(tx, 'item', { item_id: 'a' })],
    ['delete', (tx: TenantTx) => repo.delete(tx, 'item', { item_id: 'a' })],
    ['deleteOne', (tx: TenantTx) => repo.deleteOne(tx, 'tag_member', { label: 'a', weight: 1 })],
    ['replaceOne', (tx: TenantTx) => repo.replaceOne(tx, 'tag_member', { label: 'a', weight: 1 }, { label: 'b', weight: 1 })],
    ['read', (tx: TenantTx) => repo.read(tx, ITEM_UNIT, () => Promise.resolve(1))],
    ['findByKey', (tx: TenantTx) => repo.findByKey(tx, 'item', { item_id: 'a' })],
  ] as [string, (tx: TenantTx) => Promise<unknown>][])(
    '%s rejects a transaction handle kept after its transaction ended',
    async (_method, call) => {
      const { db, statements } = recordingDb(BASE);
      const kept = await db.withTenant(TENANT, (tx) => Promise.resolve(tx));
      await expect(call(kept)).rejects.toBeInstanceOf(OutsideTenantTransactionError);
      expect(statements).toEqual(['BEGIN', expect.stringContaining("set_config('app.tenant_id'"), 'COMMIT']);
    },
  );
});

interface LoggedChange {
  xid: string;
  table: string;
  op: string;
  key: string;
  before: string | null;
  after: string | null;
  columns: string[];
  origin: string;
  actor_user_id: string | null;
  actor_service: string | null;
  at: string;
  request_id: string | null;
  operation_id: string | null;
}

/** A request context with a verified user and calling service. */
function requestStore(requestId: string): RequestContextStore {
  const store = newRequestContext({ requestId });
  store.user = { sub: 'user-1' } as RequestContextStore['user'];
  store.service = { name: 'people', roles: [] };
  return store;
}

const available = await pgAvailable();

describe.skipIf(!available)('repository writes against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: Repository;
  let ungated: Repository;
  let tenants = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'mk-repository', extraSql: [migrationKitSql(BASE), TABLES_SQL] });
    repo = createRepository({ owner: OWNER, schema: handle.schema, tables: [ITEM, TAG], clock: CLOCK });
    ungated = createRepository({ owner: OWNER, schema: handle.schema, tables: [{ ...ITEM, unit: undefined }] });
    await ensureUnitGates(handle.app, [ITEM_UNIT, TAG_UNIT]);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGate(ITEM_UNIT, 'open');
    await setGate(TAG_UNIT, 'open');
  });

  /** A tenant no earlier test has written. */
  function freshTenant(): string {
    tenants += 1;
    return tenantIdForSite(`repository-${tenants}`);
  }

  /** Sets a unit gate's state and phase; a closed gate gets the holder the table requires. */
  async function setGate(unit: string, state: GateState, phase: GatePhase = 'quiet'): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `UPDATE ${handle.schema}.unit_gate SET state = $2::text, holder_id = CASE WHEN $2::text = 'closed' THEN 'test-window' END, phase = $3
          WHERE unit = $1`,
        [unit, state, phase],
      ),
    );
  }

  /** The tenant's committed changelog rows in write order. */
  function changelog(tenantId: string): Promise<LoggedChange[]> {
    return handle.app.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query<LoggedChange>(
        `SELECT xid::text AS xid, "table", op, key, before, after, columns, origin, actor_user_id, actor_service,
                to_char(at, 'YYYY-MM-DD HH24:MI:SS.MS') AS at, request_id, operation_id
           FROM ${handle.schema}.changelog ORDER BY seq`,
      );
      return rows;
    });
  }

  /** The tenant's keyless rows as label, weight and occurrence, in a stable order. */
  function tagRows(tenantId: string): Promise<[string, number, number][]> {
    return handle.app.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query<{ label: string; weight: number; occurrence: number }>(
        `SELECT label, weight, occurrence FROM ${handle.schema}.tag_member ORDER BY label, occurrence`,
      );
      return rows.map((row): [string, number, number] => [row.label, row.weight, row.occurrence]);
    });
  }

  /** Resolves once a session of the app role waits on a row lock. */
  async function untilLockWait(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await handle.appPool.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE usename = current_user AND wait_event_type = 'Lock'",
      );
      if ((rows[0]?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('no app session started waiting on a lock');
      await sleep(25);
    }
  }

  /** The canonical image of an item row. */
  function keyedImage(row: RepositoryRow): string {
    return encodeRow(ITEM_COLUMNS, row);
  }

  it('commits an insert with one changelog row carrying the request actor, clock time and target origin', async () => {
    const tenant = freshTenant();
    const store = requestStore('req-insert');
    const stored = await runWithRequestContext(store, () =>
      handle.app.withTenant(tenant, (tx) => repo.insert(tx, 'item', { tenant_id: tenant.toUpperCase(), item_id: 'i1', name: 'Widget', qty: 2 })),
    );
    expect(stored).toEqual({ tenant_id: tenant, item_id: 'i1', name: 'Widget', qty: 2 });

    const log = await changelog(tenant);
    expect(log).toEqual([
      {
        xid: expect.stringMatching(/^\d+$/),
        table: 'item',
        op: 'insert',
        key: encodeKey(ITEM_COLUMNS, ['item_id'], stored),
        before: null,
        after: keyedImage(stored),
        columns: ['item_id', 'name', 'qty'],
        origin: 'target',
        actor_user_id: 'user-1',
        actor_service: 'people',
        at: localTimestamp(CLOCK.now()),
        request_id: 'req-insert',
        operation_id: null,
      },
    ]);
    expect(store.writePositions).toEqual(new Map([[OWNER, log[0]?.xid]]));
  });

  it('rolls the row, its changelog row and the write position back together', async () => {
    const tenant = freshTenant();
    const store = requestStore('req-rollback');
    let loggedInside: number | undefined;
    const err = await failure(() =>
      runWithRequestContext(store, () =>
        handle.app.withTenant(tenant, async (tx) => {
          await repo.insert(tx, 'item', { item_id: 'r1', name: 'Lost', qty: 1 });
          const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${handle.schema}.changelog`);
          loggedInside = rows[0]?.n;
          throw new Error('abort');
        }),
      ),
    );
    expect(err).toMatchObject({ message: 'abort' });
    expect(loggedInside).toBe(1);
    expect(await handle.app.withTenant(tenant, (tx) => repo.findByKey(tx, 'item', { item_id: 'r1' }))).toBeNull();
    expect(await changelog(tenant)).toEqual([]);
    expect(store.writePositions.size).toBe(0);
  });

  it('logs an update with before and after images, only the changed columns and the caller provenance', async () => {
    const tenant = freshTenant();
    const { before, after } = await handle.app.withTenant(tenant, async (tx) => ({
      before: await repo.insert(tx, 'item', { item_id: 'u1', name: 'Old', qty: 1 }),
      after: await repo.update(
        tx,
        'item',
        { item_id: 'u1' },
        { name: 'Old', qty: 5 },
        { origin: 'legacy-window', operationId: 'op-7', actorUserId: 'actor-x', actorService: 'migration', requestId: 'req-x' },
      ),
    }));
    expect(after).toEqual({ ...before, qty: 5 });

    const [insertLog, updateLog] = await changelog(tenant);
    expect(insertLog).toMatchObject({ op: 'insert', actor_user_id: null, actor_service: null, request_id: null });
    expect(updateLog).toMatchObject({
      op: 'update',
      key: encodeKey(ITEM_COLUMNS, ['item_id'], before),
      before: keyedImage(before),
      after: keyedImage(after as RepositoryRow),
      columns: ['qty'],
      origin: 'legacy-window',
      operation_id: 'op-7',
      actor_user_id: 'actor-x',
      actor_service: 'migration',
      request_id: 'req-x',
    });
  });

  it('deletes a keyed row and logs its before image without an after image', async () => {
    const tenant = freshTenant();
    const { stored, removed, gone } = await handle.app.withTenant(tenant, async (tx) => ({
      stored: await repo.insert(tx, 'item', { item_id: 'd1', name: 'Doomed', qty: 3 }),
      removed: await repo.delete(tx, 'item', { item_id: 'd1' }),
      gone: await repo.findByKey(tx, 'item', { item_id: 'd1' }),
    }));
    expect(removed).toEqual(stored);
    expect(gone).toBeNull();
    const [, deleteLog] = await changelog(tenant);
    expect(deleteLog).toMatchObject({
      op: 'delete',
      key: encodeKey(ITEM_COLUMNS, ['item_id'], stored),
      before: keyedImage(stored),
      after: null,
      columns: ['item_id', 'name', 'qty'],
    });
  });

  it('answers null from update, delete and findByKey for a missing key and logs nothing', async () => {
    const tenant = freshTenant();
    const results = await handle.app.withTenant(tenant, async (tx) => [
      await repo.update(tx, 'item', { item_id: 'none' }, { qty: 1 }),
      await repo.delete(tx, 'item', { item_id: 'none' }),
      await repo.findByKey(tx, 'item', { item_id: 'none' }),
    ]);
    expect(results).toEqual([null, null, null]);
    expect(await changelog(tenant)).toEqual([]);
  });

  it("hides one tenant's rows from another tenant's findByKey", async () => {
    const owner = freshTenant();
    await handle.app.withTenant(owner, (tx) => repo.insert(tx, 'item', { item_id: 'shared', name: 'Mine', qty: 1 }));
    expect(await handle.app.withTenant(freshTenant(), (tx) => repo.findByKey(tx, 'item', { item_id: 'shared' }))).toBeNull();
  });

  it('upserts a new key as an insert, then updates only the changed non-key columns, and skips a row with nothing to set', async () => {
    const tenant = freshTenant();
    const [inserted, updated, unchanged] = await handle.app.withTenant(tenant, async (tx) => [
      await repo.upsert(tx, 'item', { item_id: 'p1', name: 'First', qty: 1 }),
      await repo.upsert(tx, 'item', { item_id: 'p1', name: 'Second', qty: 1 }),
      await repo.upsert(tx, 'item', { item_id: 'p1' }),
    ]);
    expect(inserted).toEqual({ tenant_id: tenant, item_id: 'p1', name: 'First', qty: 1 });
    expect(updated).toEqual({ ...inserted, name: 'Second' });
    expect(unchanged).toEqual(updated);
    const log = await changelog(tenant);
    expect(log.map((change) => [change.op, change.columns])).toEqual([
      ['insert', ['item_id', 'name', 'qty']],
      ['update', ['name']],
    ]);
  });

  it('upsert updates the row a concurrent transaction committed for the same key after its first read', async () => {
    const tenant = freshTenant();
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalInserted = (): void => undefined;
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    const rival = handle.app.withTenant(tenant, async (tx) => {
      await repo.insert(tx, 'item', { item_id: 'race', name: 'Rival', qty: 1 });
      signalInserted();
      await released;
    });
    await inserted;
    const upsert = handle.app.withTenant(tenant, (tx) => repo.upsert(tx, 'item', { item_id: 'race', name: 'Mine', qty: 2 }));
    try {
      await untilLockWait();
    } finally {
      release();
    }
    await rival;

    expect(await upsert).toEqual({ tenant_id: tenant, item_id: 'race', name: 'Mine', qty: 2 });
    const log = await changelog(tenant);
    expect(log.map((change) => change.op)).toEqual(['insert', 'update']);
    expect(log[1]).toMatchObject({
      before: keyedImage({ tenant_id: tenant, item_id: 'race', name: 'Rival', qty: 1 }),
      after: keyedImage({ tenant_id: tenant, item_id: 'race', name: 'Mine', qty: 2 }),
      columns: ['name', 'qty'],
    });
  });

  it('upsert rejects a row whose insert collides with another key on a unique column', async () => {
    const tenant = freshTenant();
    const err = await failure(() =>
      handle.app.withTenant(tenant, async (tx) => {
        await repo.insert(tx, 'item', { item_id: 'a', name: 'Same', qty: 1 });
        return repo.upsert(tx, 'item', { item_id: 'b', name: 'Same', qty: 2 });
      }),
    );
    expect(err).toBeInstanceOf(RepositoryError);
    expect(err).toMatchObject({ table: 'item', message: 'item: insert conflicts with a row outside this key or tenant' });
    expect(await changelog(tenant)).toEqual([]);
  });

  it('numbers identical keyless rows as occurrences of one row hash and keys their changelog rows by content', async () => {
    const tenant = freshTenant();
    const duplicate = { label: 'dup', weight: 3 };
    const single = { label: 'other', weight: null };
    const stored = await handle.app.withTenant(tenant, async (tx) => [
      await repo.insert(tx, 'tag_member', duplicate),
      await repo.insert(tx, 'tag_member', { tenant_id: tenant, ...duplicate }),
      await repo.insert(tx, 'tag_member', single),
    ]);
    expect(stored.map((row) => [row.legacy_row_hash, row.occurrence])).toEqual([
      [legacyRowHash(TAG_DATA, duplicate), 1],
      [legacyRowHash(TAG_DATA, duplicate), 2],
      [legacyRowHash(TAG_DATA, single), 1],
    ]);
    const log = await changelog(tenant);
    expect(log.map((change) => change.key)).toEqual([encodeRow(TAG_DATA, duplicate), encodeRow(TAG_DATA, duplicate), encodeRow(TAG_DATA, single)]);
    expect(log[1]).toMatchObject({
      op: 'insert',
      before: null,
      after: encodeRow(TAG_COLUMNS, stored[1] as RepositoryRow),
      columns: ['label', 'weight'],
    });
  });

  it('deleteOne removes the highest occurrence of a duplicate and keeps the multiplicity of the rest', async () => {
    const tenant = freshTenant();
    const duplicate = { label: 'dup', weight: 1 };
    const { removed, absent } = await handle.app.withTenant(tenant, async (tx) => {
      for (const row of [duplicate, duplicate, duplicate, { label: 'kept', weight: 1 }]) {
        await repo.insert(tx, 'tag_member', row);
      }
      return {
        removed: await repo.deleteOne(tx, 'tag_member', duplicate),
        absent: await repo.deleteOne(tx, 'tag_member', { label: 'none', weight: 0 }),
      };
    });
    const hash = legacyRowHash(TAG_DATA, duplicate);
    expect(removed).toEqual({ tenant_id: tenant, ...duplicate, legacy_row_hash: hash, occurrence: 3 });
    expect(absent).toBeNull();
    expect(await tagRows(tenant)).toEqual([
      ['dup', 1, 1],
      ['dup', 1, 2],
      ['kept', 1, 1],
    ]);
    const log = await changelog(tenant);
    expect(log).toHaveLength(5);
    expect(log[4]).toMatchObject({
      op: 'delete',
      key: encodeRow(TAG_DATA, duplicate),
      before: encodeRow(TAG_COLUMNS, removed as RepositoryRow),
      after: null,
      columns: ['label', 'weight'],
    });
  });

  it('replaceOne turns one duplicate into the next occurrence of the new content', async () => {
    const tenant = freshTenant();
    const from = { label: 'a', weight: 1 };
    const to = { label: 'b', weight: 1 };
    const { replaced, absent } = await handle.app.withTenant(tenant, async (tx) => {
      for (const row of [from, from, to]) {
        await repo.insert(tx, 'tag_member', row);
      }
      return {
        replaced: await repo.replaceOne(tx, 'tag_member', from, to),
        absent: await repo.replaceOne(tx, 'tag_member', { label: 'none', weight: 0 }, to),
      };
    });
    const toHash = legacyRowHash(TAG_DATA, to);
    expect(replaced).toEqual({ tenant_id: tenant, ...to, legacy_row_hash: toHash, occurrence: 2 });
    expect(absent).toBeNull();
    expect(await tagRows(tenant)).toEqual([
      ['a', 1, 1],
      ['b', 1, 1],
      ['b', 1, 2],
    ]);
    const log = await changelog(tenant);
    expect(log).toHaveLength(4);
    expect(log[3]).toMatchObject({
      op: 'update',
      key: encodeRow(TAG_DATA, from),
      before: encodeRow(TAG_COLUMNS, { tenant_id: tenant, ...from, legacy_row_hash: legacyRowHash(TAG_DATA, from), occurrence: 2 }),
      after: encodeRow(TAG_COLUMNS, replaced as RepositoryRow),
      columns: ['label'],
    });
  });

  it('records the changelog xid of each committed transaction as the owner write position, once per transaction', async () => {
    const tenant = freshTenant();
    const store = requestStore('req-position');
    const insideFirst: (string | undefined)[] = [];
    await runWithRequestContext(store, async () => {
      await handle.app.withTenant(tenant, async (tx) => {
        await repo.insert(tx, 'item', { item_id: 'w1', name: 'W', qty: 1 });
        await repo.insert(tx, 'tag_member', { label: 'w', weight: 1 });
        insideFirst.push(store.writePositions.get(OWNER));
      });
      await handle.app.withTenant(tenant, (tx) => repo.update(tx, 'item', { item_id: 'w1' }, { qty: 2 }));
    });
    const [first, second, third] = (await changelog(tenant)).map((change) => change.xid);
    expect(insideFirst).toEqual([undefined]);
    expect(second).toBe(first);
    expect(BigInt(third as string) > BigInt(first as string)).toBe(true);
    expect(store.writePositions).toEqual(new Map([[OWNER, third]]));
  });

  it('fails a write to a closed unit with the 503-shaped GateClosedError once the gate budget runs out', async () => {
    const tenant = freshTenant();
    await setGate(ITEM_UNIT, 'closed');
    const started = Date.now();
    const err = await failure(() =>
      withGatedTenant(handle.app, tenant, (tx) => repo.insert(tx, 'item', { item_id: 'g1', name: 'G', qty: 1 }), { budgetMs: 200 }),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(err).toBeInstanceOf(GateClosedError);
    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ units: [ITEM_UNIT], reason: 'unit-gate-closed' });
    expect(await changelog(tenant)).toEqual([]);
  });

  it('lets a write waiting on a closed unit proceed once the gate reopens', async () => {
    const tenant = freshTenant();
    await setGate(TAG_UNIT, 'closed');
    const write = withGatedTenant(handle.app, tenant, (tx) => repo.insert(tx, 'tag_member', { label: 'late', weight: 1 }), { budgetMs: 10_000 });
    await sleep(200);
    await setGate(TAG_UNIT, 'open');
    expect(await write).toMatchObject({ label: 'late', occurrence: 1 });
    expect(await changelog(tenant)).toHaveLength(1);
  });

  it('rejects a write to a legacy unit at once with UnitNotAuthoritativeError', async () => {
    const tenant = freshTenant();
    await setGate(ITEM_UNIT, 'legacy');
    const err = await failure(() => handle.app.withTenant(tenant, (tx) => repo.upsert(tx, 'item', { item_id: 'l1', name: 'L', qty: 1 })));
    expect(err).toBeInstanceOf(UnitNotAuthoritativeError);
    expect(err).toMatchObject({ units: [ITEM_UNIT], reason: 'unit-not-authoritative' });
  });

  it('gates a write whose authority was never issued by createMigrationAuthority', async () => {
    const tenant = freshTenant();
    await setGate(ITEM_UNIT, 'legacy');
    const forged = { ...createMigrationAuthority({ batchId: 'b-forged' }) } as MigrationAuthority;
    const err = await failure(() =>
      handle.app.withTenant(tenant, (tx) => repo.insert(tx, 'item', { item_id: 'f1', name: 'F', qty: 1 }, { authority: forged })),
    );
    expect(err).toBeInstanceOf(UnitNotAuthoritativeError);
  });

  it.each(['closed', 'legacy'] as const)('lets a migration-authority write pass a %s gate', async (state) => {
    const tenant = freshTenant();
    await setGate(ITEM_UNIT, state);
    await setGate(TAG_UNIT, state);
    const authority = createMigrationAuthority({ batchId: `batch-${state}` });
    await handle.app.withTenant(tenant, async (tx) => {
      await repo.upsert(tx, 'item', { item_id: 'm1', name: 'M', qty: 1 }, { authority, origin: 'backfill' });
      await repo.insert(tx, 'tag_member', { label: 'm', weight: 1 }, { authority, origin: 'migration-feed' });
    });
    expect((await changelog(tenant)).map((change) => [change.table, change.origin])).toEqual([
      ['item', 'backfill'],
      ['tag_member', 'migration-feed'],
    ]);
  });

  it.each(
    (['executing', 'importing', 'import-pending'] as const).flatMap((phase) => [
      [phase, 'findByKey', (tx: TenantTx) => repo.findByKey(tx, 'item', { item_id: 'b1' })],
      [phase, 'read', (tx: TenantTx) => repo.read(tx, [ITEM_UNIT, TAG_UNIT], () => Promise.resolve('read'))],
    ]) as [GatePhase, string, (tx: TenantTx) => Promise<unknown>][],
  )('fails a gated read during a window in phase %s with UnitReadBlockedError (%s)', async (phase, _reader, readFn) => {
    const tenant = freshTenant();
    await handle.app.withTenant(tenant, (tx) => repo.insert(tx, 'item', { item_id: 'b1', name: 'B', qty: 1 }));
    await setGate(ITEM_UNIT, 'closed', phase);
    const err = await failure(() => withGatedTenant(handle.app, tenant, readFn, { budgetMs: 150 }));
    expect(err).toBeInstanceOf(UnitReadBlockedError);
    expect(err).toMatchObject({ units: [ITEM_UNIT], reason: 'unit-read-blocked' });
  });

  it.each(['closed', 'legacy'] as const)('serves gated reads under a quiet %s gate', async (state) => {
    const tenant = freshTenant();
    const stored = await handle.app.withTenant(tenant, (tx) => repo.insert(tx, 'item', { item_id: 'q1', name: 'Q', qty: 1 }));
    await setGate(ITEM_UNIT, state);
    const [found, read] = await handle.app.withTenant(tenant, async (tx) => [
      await repo.findByKey(tx, 'item', { item_id: 'q1' }),
      await repo.read(tx, ITEM_UNIT, () => Promise.resolve('read')),
    ]);
    expect(found).toEqual(stored);
    expect(read).toBe('read');
  });

  it('reads a table without a unit without consulting any gate', async () => {
    const tenant = freshTenant();
    const stored = await handle.app.withTenant(tenant, (tx) => repo.insert(tx, 'item', { item_id: 'n1', name: 'N', qty: 1 }));
    await setGate(ITEM_UNIT, 'closed', 'executing');
    expect(ungated.units()).toEqual([]);
    expect(await withGatedTenant(handle.app, tenant, (tx) => ungated.findByKey(tx, 'item', { item_id: 'n1' }), { budgetMs: 150 })).toEqual(stored);
  });
});
