import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSUMER_AGGREGATE_VERSION_TABLE, INBOX_TABLE, eventsSql } from '../../src/events/index.js';
import { CHANGELOG_TABLE, MIGRATION_BATCH_TABLE, migrationKitSql } from '../../src/migration-kit/index.js';
import { OUTBOX_TABLE, outboxSql } from '../../src/outbox/index.js';
import { SCHEDULED_TASK_QUEUE_STATE_TABLE, SCHEDULED_TASK_QUEUE_TABLE, scheduledTaskQueueSql } from '../../src/tasks/index.js';
import {
  NON_TENANT_TABLES,
  RLS_POLICY_NAME,
  TENANT_SETTING,
  isNonTenantTable,
  rlsSql,
  tenantDbFromPool,
  tenantGrantSql,
  tenantRegistrySql,
  withMetadata,
  withTenant,
  type PoolClient,
  type TxBase,
} from '../../src/tenancy/index.js';
import {
  PLATFORM_TABLE_GROUPS,
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  checkCatalog,
  createThrowawaySchema,
  expectPlatformTables,
  pgAvailable,
  seedRegistry,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const REQUIRED_ENV = ['PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'] as const;
const SOURCE = 'isorls';
const NOTE = 'note';

const TENANT_OWNED_PLATFORM_TABLES = [
  OUTBOX_TABLE,
  INBOX_TABLE,
  CONSUMER_AGGREGATE_VERSION_TABLE,
  CHANGELOG_TABLE,
  MIGRATION_BATCH_TABLE,
  SCHEDULED_TASK_QUEUE_TABLE,
  SCHEDULED_TASK_QUEUE_STATE_TABLE,
] as const;

type TenantOwnedPlatformTable = (typeof TENANT_OWNED_PLATFORM_TABLES)[number];

/** Column list and VALUES text of one valid row per platform tenant table; `$1` is the row's tenant id. */
const PLATFORM_ROWS: Readonly<Record<TenantOwnedPlatformTable, { columns: string; values: string }>> = {
  [OUTBOX_TABLE]: {
    columns: 'tenant_id, event_id, topic, kind, ordering_key, envelope, created_at',
    values: "$1, gen_random_uuid(), 'isorls.note.created.v1', 'state', 'note-1', '{}'::jsonb, LOCALTIMESTAMP(3)",
  },
  [INBOX_TABLE]: {
    columns: 'tenant_id, event_id, subscription, status',
    values: "$1, gen_random_uuid(), 'isorls-note', 'applied'",
  },
  [CONSUMER_AGGREGATE_VERSION_TABLE]: {
    columns: 'tenant_id, subscription, aggregate_type, aggregate_id, last_version',
    values: "$1, 'isorls-note', 'note', 'note-1', 1",
  },
  [CHANGELOG_TABLE]: {
    columns: 'tenant_id, "table", op, key, after, origin',
    values: "$1, 'note', 'insert', 'note-1', 'after-image', 'target'",
  },
  [MIGRATION_BATCH_TABLE]: {
    columns: 'tenant_id, batch_id, legacy_table, origin, row_count',
    values: "$1, gen_random_uuid()::text, 'tnote', 'backfill', 1",
  },
  [SCHEDULED_TASK_QUEUE_TABLE]: {
    columns: 'tenant_id, queue, name, schedule_time, url, body, deadline_s, created_at, updated_at',
    values:
      "$1, 'isorls-queue', gen_random_uuid()::text, LOCALTIMESTAMP(3), 'http://127.0.0.1/internal/v1/tasks/note', '{}'::jsonb, 60, LOCALTIMESTAMP(3), LOCALTIMESTAMP(3)",
  },
  [SCHEDULED_TASK_QUEUE_STATE_TABLE]: {
    columns: 'tenant_id, queue, updated_at',
    values: "$1, 'isorls-queue', LOCALTIMESTAMP(3)",
  },
};

const EXTRA_SQL = [
  tenantRegistrySql(SOURCE),
  tenantGrantSql(SOURCE),
  outboxSql(SOURCE),
  eventsSql(SOURCE),
  migrationKitSql(SOURCE),
  scheduledTaskQueueSql(SOURCE),
  `CREATE TABLE ${SOURCE}.${NOTE} (tenant_id uuid NOT NULL, id char(35) PRIMARY KEY, body text, row_version int NOT NULL DEFAULT 0)`,
  rlsSql(SOURCE, NOTE),
];

const SCHEMA_TABLES_SQL = `
SELECT c.relname::text AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`;

const TABLE_SQL = `
SELECT c.relrowsecurity AS enabled,
       c.relforcerowsecurity AS forced,
       pg_get_userbyid(c.relowner)::text AS owner,
       format_type(a.atttypid, a.atttypmod) AS tenant_type,
       a.attnotnull AS tenant_not_null
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`;

const POLICIES_SQL = `
SELECT policyname::text AS name, permissive, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname = $1 AND tablename = $2
 ORDER BY policyname`;

interface Note {
  id: string;
  body: string;
}

interface TableRow {
  enabled: boolean;
  forced: boolean;
  owner: string;
  tenant_type: string | null;
  tenant_not_null: boolean | null;
}

interface PolicyRow {
  name: string;
  permissive: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

let handle: ThrowawaySchema | undefined;
const seeded = new Map<TenantFixture['key'], readonly Note[]>();

/** The throwaway schema beforeAll created. */
function db(): ThrowawaySchema {
  if (handle === undefined) {
    throw new Error('beforeAll did not create the throwaway schema');
  }
  return handle;
}

/** A fresh id in the 35-character ColdFusion createUUID() format. */
function cfId(): string {
  const hex = randomUUID().replace(/-/g, '').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16)}`;
}

/** The first note seeded for `tenant`. */
function firstNote(tenant: TenantFixture): Note {
  const [note] = seeded.get(tenant.key) ?? [];
  if (note === undefined) {
    throw new Error(`No note was seeded for tenant ${tenant.key}`);
  }
  return note;
}

/** Number of rows of `table` visible in `tx`. */
async function countRows(tx: TxBase, table: string): Promise<number> {
  const [row] = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tx.schema}.${table}`)).rows;
  if (row === undefined) {
    throw new Error(`count(*) on ${tx.schema}.${table} returned no row`);
  }
  return row.n;
}

/** Tenant ids of the notes `tenant` sees. */
function noteTenants(tenant: TenantFixture): Promise<string[]> {
  return withTenant(db().app, tenant.tenantId, async (tx) =>
    (await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${tx.schema}.${NOTE}`)).rows.map((row) => row.tenant_id),
  );
}

/** The catalog row of `table` in the throwaway schema. */
async function tableRow(table: string): Promise<TableRow | undefined> {
  const { adminPool, schema } = db();
  return (await adminPool.query<TableRow>(TABLE_SQL, [schema, table])).rows[0];
}

/** The `pg_policies` rows of `table` in the throwaway schema. */
async function policies(table: string): Promise<PolicyRow[]> {
  const { adminPool, schema } = db();
  return (await adminPool.query<PolicyRow>(POLICIES_SQL, [schema, table])).rows;
}

/** Runs `fn` on a migrator connection switched to the owner role, in a transaction that is always rolled back. */
async function asOwner(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const { migratorPool, roles } = db();
  const client = await migratorPool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE "${roles.owner}"`);
    await fn(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch (err) {
      broken = err instanceof Error ? err : new Error(String(err));
    }
    client.release(broken);
  }
}

beforeAll(async () => {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`The RLS isolation suite needs ${missing.join(', ')} in the environment`);
  }
  if (!(await pgAvailable())) {
    throw new Error(`The RLS isolation suite cannot reach PostgreSQL at PG_HOST:PG_PORT ${process.env.PG_HOST}:${process.env.PG_PORT}`);
  }
  handle = await createThrowawaySchema({ service: SOURCE, extraSql: EXTRA_SQL });
  for (const tenant of TENANT_LIST) {
    const notes = [1, 2].map((n) => ({ id: cfId(), body: `note ${String(n)} of ${tenant.key}` }));
    await withTenant(handle.app, tenant.tenantId, async (tx) => {
      for (const note of notes) {
        await tx.query(`INSERT INTO ${tx.schema}.${NOTE} (tenant_id, id, body) VALUES ($1, $2, $3)`, [tenant.tenantId, note.id, note.body]);
      }
    });
    seeded.set(tenant.key, notes);
  }
});

afterAll(async () => {
  await handle?.drop();
});

describe('tenant_isolation on a business table', () => {
  it.each(TENANT_LIST)('tenant $key reads exactly its own two notes', async (tenant) => {
    const rows = await withTenant(db().app, tenant.tenantId, async (tx) =>
      (await tx.query<{ tenant_id: string; id: string }>(`SELECT tenant_id, id FROM ${tx.schema}.${NOTE}`)).rows,
    );
    expect(rows.map((row) => row.tenant_id)).toEqual([tenant.tenantId, tenant.tenantId]);
    expect(rows.map((row) => row.id).sort()).toEqual((seeded.get(tenant.key) ?? []).map((note) => note.id).sort());
  });

  it("tenant A's update and delete of a tenant B note touch no row and leave it unchanged", async () => {
    const victim = firstNote(TENANT_B);
    const counts = await withTenant(db().app, TENANT_A.tenantId, async (tx) => {
      const updated = await tx.query(`UPDATE ${tx.schema}.${NOTE} SET body = 'x' WHERE id = $1`, [victim.id]);
      const deleted = await tx.query(`DELETE FROM ${tx.schema}.${NOTE} WHERE id = $1`, [victim.id]);
      return [updated.rowCount, deleted.rowCount];
    });
    expect(counts).toEqual([0, 0]);
    const stored = await withTenant(db().app, TENANT_B.tenantId, async (tx) =>
      (await tx.query(`SELECT tenant_id, body, row_version FROM ${tx.schema}.${NOTE} WHERE id = $1`, [victim.id])).rows,
    );
    expect(stored).toEqual([{ tenant_id: TENANT_B.tenantId, body: victim.body, row_version: 0 }]);
  });

  it.each([
    {
      action: 'inserting a note for tenant B',
      sql: (schema: string) => `INSERT INTO ${schema}.${NOTE} (tenant_id, id, body) VALUES ($1, $2, 'smuggled')`,
      values: () => [TENANT_B.tenantId, cfId()],
    },
    {
      action: 'moving one of its notes to tenant B',
      sql: (schema: string) => `UPDATE ${schema}.${NOTE} SET tenant_id = $1 WHERE id = $2`,
      values: () => [TENANT_B.tenantId, firstNote(TENANT_A).id],
    },
  ])('tenant A $action fails with SQLSTATE 42501 and changes nothing', async ({ sql, values }) => {
    await expect(withTenant(db().app, TENANT_A.tenantId, (tx) => tx.query(sql(tx.schema), values()))).rejects.toMatchObject({
      code: '42501',
    });
    expect(await noteTenants(TENANT_A)).toEqual([TENANT_A.tenantId, TENANT_A.tenantId]);
    expect(await noteTenants(TENANT_B)).toEqual([TENANT_B.tenantId, TENANT_B.tenantId]);
  });

  it('a pooled connection reused after a tenant transaction sees no notes and cannot insert one', async () => {
    const { schema } = db();
    const pool = db().connect('app', { max: 1 });
    const single = tenantDbFromPool(pool, { schema });
    try {
      const pid = await withTenant(single, TENANT_A.tenantId, async (tx) => {
        expect(await countRows(tx, NOTE)).toBe(2);
        return (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      });
      const reused = await pool.query(
        `SELECT pg_backend_pid() AS pid, current_setting($1, true) AS setting, (SELECT count(*)::int FROM ${schema}.${NOTE}) AS notes`,
        [TENANT_SETTING],
      );
      expect(reused.rows).toEqual([{ pid, setting: '', notes: 0 }]);
      await expect(
        pool.query(`INSERT INTO ${schema}.${NOTE} (tenant_id, id) VALUES ($1, $2)`, [TENANT_A.tenantId, cfId()]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await single.end();
    }
  });
});

describe('FORCE ROW LEVEL SECURITY', () => {
  it("holds the owning role to the policy: no notes without a tenant setting, only that tenant's notes with one", async () => {
    const { roles, schema } = db();
    expect((await tableRow(NOTE))?.owner).toBe(roles.owner);
    await asOwner(async (client) => {
      const unset = await client.query(`SELECT current_user::text AS role, (SELECT count(*)::int FROM ${schema}.${NOTE}) AS notes`);
      expect(unset.rows).toEqual([{ role: roles.owner, notes: 0 }]);
      await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, TENANT_A.tenantId]);
      const scoped = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${schema}.${NOTE}`);
      expect(scoped.rows.map((row) => row.tenant_id)).toEqual([TENANT_A.tenantId, TENANT_A.tenantId]);
      await expect(
        client.query(`INSERT INTO ${schema}.${NOTE} (tenant_id, id) VALUES ($1, $2)`, [TENANT_B.tenantId, cfId()]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('platform tenant tables', () => {
  it.each(TENANT_OWNED_PLATFORM_TABLES)(
    '%s keeps a tenant A row from tenant B, the umbrella and metadata transactions, and rejects a row for B under A',
    async (table) => {
      const { app } = db();
      const { columns, values } = PLATFORM_ROWS[table];
      const insert = (tx: TxBase, tenantId: string) =>
        tx.query(`INSERT INTO ${tx.schema}.${table} (${columns}) VALUES (${values})`, [tenantId]);
      const count = (tx: TxBase) => countRows(tx, table);
      await withTenant(app, TENANT_A.tenantId, (tx) => insert(tx, TENANT_A.tenantId));
      expect(await withTenant(app, TENANT_A.tenantId, count)).toBe(1);
      expect(await withTenant(app, TENANT_B.tenantId, count)).toBe(0);
      expect(await withTenant(app, TENANT_UMBRELLA.tenantId, count)).toBe(0);
      expect(await withMetadata(app, count)).toBe(0);
      await expect(withTenant(app, TENANT_A.tenantId, (tx) => insert(tx, TENANT_B.tenantId))).rejects.toMatchObject({ code: '42501' });
    },
  );
});

describe('catalog', () => {
  const allGroups = Object.keys(PLATFORM_TABLE_GROUPS) as PlatformTableGroup[];

  it('PLATFORM_TABLE_GROUPS splits the platform tables into exactly the tenant-owned tables and NON_TENANT_TABLES, once each', () => {
    const groups = Object.values(PLATFORM_TABLE_GROUPS);
    const tenantOwned = groups.flatMap((group) => group.tenantOwned);
    const nonTenant = groups.flatMap((group) => group.nonTenant);
    expect([...tenantOwned].sort()).toEqual([...TENANT_OWNED_PLATFORM_TABLES].sort());
    expect([...nonTenant].sort()).toEqual([...NON_TENANT_TABLES].sort());
  });

  it('the schema holds exactly the platform tables and note', async () => {
    const { adminPool, schema } = db();
    const { rows } = await adminPool.query<{ name: string }>(SCHEMA_TABLES_SQL, [schema]);
    expect(rows.map((row) => row.name).sort()).toEqual([...TENANT_OWNED_PLATFORM_TABLES, ...NON_TENANT_TABLES, NOTE].sort());
  });

  it('expectPlatformTables finds the default and every group complete with no RLS finding', async () => {
    await expect(expectPlatformTables(db())).resolves.toBeUndefined();
    await expect(expectPlatformTables(db(), { groups: allGroups })).resolves.toBeUndefined();
  });

  it('checkCatalog reports no table or role finding', async () => {
    expect(await checkCatalog(db())).toEqual([]);
  });

  it.each([...TENANT_OWNED_PLATFORM_TABLES, NOTE])(
    '%s has enabled and forced RLS, one tenant_isolation policy on app.tenant_id, and tenant_id uuid NOT NULL',
    async (table) => {
      expect(isNonTenantTable(table)).toBe(false);
      expect(await tableRow(table)).toMatchObject({ enabled: true, forced: true, tenant_type: 'uuid', tenant_not_null: true });
      const [policy, ...others] = await policies(table);
      expect(others).toEqual([]);
      expect(policy).toMatchObject({ name: RLS_POLICY_NAME, permissive: 'PERMISSIVE', cmd: 'ALL' });
      expect(policy?.qual).toContain(`'${TENANT_SETTING}'`);
      expect(policy?.with_check).toContain(`'${TENANT_SETTING}'`);
      expect(policy?.with_check).toBe(policy?.qual);
    },
  );

  it.each(NON_TENANT_TABLES)('%s exists as a non-tenant table without row-level security or policies', async (table) => {
    expect(isNonTenantTable(table)).toBe(true);
    expect(await tableRow(table)).toMatchObject({ enabled: false, forced: false });
    expect(await policies(table)).toEqual([]);
  });

  it('tenant_registry rows written without a tenant are visible to metadata and every tenant transaction', async () => {
    const { app } = db();
    await seedRegistry(app);
    const count = (tx: TxBase) => countRows(tx, 'tenant_registry');
    expect(await withMetadata(app, count)).toBe(TENANT_LIST.length);
    for (const tenant of TENANT_LIST) {
      expect(await withTenant(app, tenant.tenantId, count)).toBe(TENANT_LIST.length);
    }
  });
});
