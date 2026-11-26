/** Re-applying every content migration to a migrated schema succeeds and leaves its catalog and identity sequences as they were. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, pgAvailable, rewriteMigrationSql, type ThrowawaySchema } from '@opt2/platform/testing';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const MIGRATION_FILE = /^\d{4}_.+\.sql$/;
const ID = 'RERUN000-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const SITE = TENANT_A.siteId;

// Catalog of one schema, each query taking the schema name as $1.
const CATALOG = {
  relations: `SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 ORDER BY c.relname`,
  columns: `SELECT c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, a.attidentity, a.attgenerated,
      pg_get_expr(d.adbin, d.adrelid) AS default_expr, co.collname
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum LEFT JOIN pg_collation co ON co.oid = a.attcollation
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`,
  indexes: 'SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname',
  constraints: `SELECT c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 ORDER BY c.relname, k.conname`,
  policies: `SELECT tablename, policyname, permissive, roles::text AS roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname`,
  collations: `SELECT to_jsonb(co) - ARRAY['oid', 'collnamespace', 'collowner'] AS collation
    FROM pg_collation co JOIN pg_namespace n ON n.oid = co.collnamespace WHERE n.nspname = $1 ORDER BY co.collname`,
  sequences: `SELECT c.relname, format_type(s.seqtypid, NULL) AS type, s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 ORDER BY c.relname`,
} as const;

type Catalog = Record<keyof typeof CATALOG, unknown[]>;

// The identity columns 0008 moves to the negative range, with the other NOT NULL columns an insert needs.
const IDENTITY_COLUMNS = [
  { table: 'content', column: 'tcontent_id', values: {} },
  { table: 'content_related', column: 'relatedcontentid', values: { contenthistid: ID, relatedid: ID, contentid: ID, siteid: SITE } },
  { table: 'content_tag', column: 'tagid', values: { contenthistid: ID, contentid: ID, siteid: SITE, tag: 'rerun' } },
  { table: 'extend_attribute', column: 'attributeid', values: {} },
  { table: 'extend_data', column: 'dataid', values: { baseid: ID, attributeid: 1 } },
] as const;

type IdentityColumn = (typeof IDENTITY_COLUMNS)[number];

let handle: ThrowawaySchema;
let files: string[];
let failures: { file: string; message: string }[];
let before: Catalog;
let after: Catalog;
const firstIds = new Map<string, number>();

async function catalog(): Promise<Catalog> {
  const out = {} as Catalog;
  for (const [name, sql] of Object.entries(CATALOG) as [keyof typeof CATALOG, string][]) {
    out[name] = (await handle.adminPool.query(sql, [handle.schema])).rows;
  }
  return out;
}

async function insertRow({ table, column, values }: IdentityColumn): Promise<number> {
  const names = Object.keys(values);
  const placeholders = names.map((_, index) => `$${index + 2}`);
  return withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO ${handle.schema}.${table} (${['tenant_id', ...names].join(', ')}) VALUES (${['$1', ...placeholders].join(', ')}) RETURNING ${column} AS id`,
      [TENANT_A.tenantId, ...Object.values(values)],
    );
    return rows[0]!.id;
  });
}

// Applies one file as the schema owner in its own transaction, as createThrowawaySchema and opt2-db bootstrap do.
async function reapply(file: string): Promise<void> {
  const sql = rewriteMigrationSql(await readFile(join(MIGRATIONS_DIR, file), 'utf8'), 'content', handle.schema, handle.roles);
  const client = await handle.migratorPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE "${handle.roles.owner}"`);
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe.skipIf(!(await pgAvailable()))('db/migrations re-run', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'strategies-content', schemaName: 'content', migrationsDir: MIGRATIONS_DIR });
    files = (await readdir(MIGRATIONS_DIR)).filter((name) => MIGRATION_FILE.test(name)).sort();
    before = await catalog();
    for (const identity of IDENTITY_COLUMNS) {
      firstIds.set(identity.table, await insertRow(identity));
    }
    failures = [];
    for (const file of files) {
      try {
        await reapply(file);
      } catch (err) {
        failures.push({ file, message: err instanceof Error ? err.message : String(err) });
      }
    }
    after = await catalog();
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('re-applies every migration file in the directory as the schema owner without an error', () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
    expect(failures).toEqual([]);
  });

  it('leaves tables, columns, indexes, constraints, policies, RLS flags, collations and sequences unchanged', () => {
    for (const [name, rows] of Object.entries(before)) {
      expect(rows, name).not.toHaveLength(0);
    }
    expect(after).toEqual(before);
  });

  it.each(IDENTITY_COLUMNS)('continues the $column identity of $table after the value issued before the re-run', async (identity) => {
    expect(firstIds.get(identity.table)).toBe(-2147483648);
    expect(await insertRow(identity)).toBe(-2147483647);
  });
});
