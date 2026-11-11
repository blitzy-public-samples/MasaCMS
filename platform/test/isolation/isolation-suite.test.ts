import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventsSql } from '../../src/events/index.js';
import { migrationKitSql } from '../../src/migration-kit/index.js';
import { outboxSql } from '../../src/outbox/index.js';
import { scheduledTaskQueueSql } from '../../src/tasks/index.js';
import { RLS_POLICY_NAME, TENANT_SETTING, rlsSql, tenantGrantSql, tenantRegistrySql, type TenantTx } from '../../src/tenancy/index.js';
import {
  PLATFORM_TABLE_GROUPS,
  checkCatalog,
  createThrowawaySchema,
  defineIsolationSuite,
  expectPlatformTables,
  pgAvailable,
  testPgConfig,
  type CatalogFinding,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const CLEAN = 'isosuite';
const BROKEN = 'isobrk';
const TENANT_OWNED = [
  'outbox',
  'inbox',
  'consumer_aggregate_version',
  'changelog',
  'migration_batch',
  'scheduled_task_queue',
  'scheduled_task_queue_state',
].sort();
const NON_TENANT = ['tenant_registry', 'tenant_grant', 'unit_gate', 'open_operation', 'migration_watermark'].sort();
const ALL_GROUPS: readonly PlatformTableGroup[] = ['outbox', 'events', 'migrationKit', 'tasks', 'tenancy'];
/** Tables of the default `tenancy` and `migrationKit` groups, none of which the broken schema has. */
const DEFAULT_GROUP_TABLES = ['tenant_registry', 'tenant_grant', 'changelog', 'migration_batch', 'unit_gate', 'open_operation', 'migration_watermark'];
const PREDICATE = `tenant_id = NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;

let clean: ThrowawaySchema | undefined;
let broken: ThrowawaySchema | undefined;
let bypassRole: string | undefined;

/** DDL of the tenant-owned `note` business table of `schema`, with its RLS policy. */
function noteSql(schema: string): string[] {
  return [
    `CREATE TABLE ${schema}.note (tenant_id uuid NOT NULL, id char(35) PRIMARY KEY, body text, row_version int NOT NULL DEFAULT 0)`,
    rlsSql(schema, 'note'),
  ];
}

/** Tenant tables of `schema` whose RLS lacks FORCE, or whose policy lacks WITH CHECK. */
function breakageSql(schema: string): string {
  return [
    `CREATE TABLE ${schema}.broken_noforce (tenant_id uuid NOT NULL, id char(35) PRIMARY KEY)`,
    `ALTER TABLE ${schema}.broken_noforce ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY ${RLS_POLICY_NAME} ON ${schema}.broken_noforce USING (${PREDICATE}) WITH CHECK (${PREDICATE})`,
    `CREATE TABLE ${schema}.broken_nocheck (tenant_id uuid NOT NULL, id char(35) PRIMARY KEY)`,
    `ALTER TABLE ${schema}.broken_nocheck ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${schema}.broken_nocheck FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${RLS_POLICY_NAME} ON ${schema}.broken_nocheck USING (${PREDICATE})`,
  ].join(';\n');
}

/** Throws naming the missing `PG_*` variables or the unreachable server. */
async function requirePostgres(): Promise<void> {
  const { host, port } = testPgConfig();
  if (!(await pgAvailable())) {
    throw new Error(`PostgreSQL at PG_HOST=${host} PG_PORT=${String(port)} accepted no connection within 2 s`);
  }
}

/** The schema beforeAll created; throws when its creation failed. */
function created(db: ThrowawaySchema | undefined): ThrowawaySchema {
  if (db === undefined) {
    throw new Error('The throwaway schema was not created; see the beforeAll failure');
  }
  return db;
}

/** A 35-character CF-format id, the shape of `note.id`. */
function cfId(): string {
  const hex = randomUUID().replace(/-/g, '').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16)}`;
}

/** Column values of a fresh note of `tenant`. */
function noteRow(_table: string, tenant: TenantFixture): { id: string; body: string } {
  return { id: cfId(), body: `note of tenant ${tenant.key}` };
}

/** Inserts one note of `tenant` in `tx`. */
async function writeNote(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const row = noteRow(table, tenant);
  await tx.query(`INSERT INTO ${tx.schema}.${table} (tenant_id, id, body) VALUES ($1, $2, $3)`, [tenant.tenantId, row.id, row.body]);
}

/** Every note visible in `tx`, with its tenant id. */
async function readNotes(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT tenant_id::text AS tenant_id, id, body, row_version FROM ${tx.schema}.${table}`)).rows;
}

/** A finding as `<kind> <object>`. */
function summary(finding: CatalogFinding): string {
  return `${finding.kind} ${finding.object}`;
}

/** True for findings about roles rather than tables. */
function isRoleFinding(finding: CatalogFinding): boolean {
  return finding.kind.startsWith('role-');
}

/** The cluster's bootstrap superuser, which always holds SUPERUSER and BYPASSRLS. */
async function bootstrapSuperuser(db: ThrowawaySchema): Promise<string> {
  const { rows } = await db.adminPool.query<{ rolname: string }>('SELECT rolname::text AS rolname FROM pg_roles WHERE oid = 10');
  const name = rows[0]?.rolname;
  if (name === undefined) {
    throw new Error('pg_roles has no bootstrap superuser (oid 10)');
  }
  return name;
}

describe('isolation suite and catalog checks on PostgreSQL', () => {
  beforeAll(async () => {
    await requirePostgres();
    clean = await createThrowawaySchema({
      service: CLEAN,
      extraSql: [
        tenantRegistrySql(CLEAN),
        tenantGrantSql(CLEAN),
        outboxSql(CLEAN),
        eventsSql(CLEAN),
        migrationKitSql(CLEAN),
        scheduledTaskQueueSql(CLEAN),
        ...noteSql(CLEAN),
      ],
    });
    broken = await createThrowawaySchema({ service: BROKEN, extraSql: noteSql(BROKEN) });
    await broken.adminPool.query(breakageSql(broken.schema));
    const { rows } = await broken.adminPool.query<{ able: boolean }>(
      'SELECT rolsuper OR rolbypassrls AS able FROM pg_roles WHERE rolname = current_user',
    );
    if (rows[0]?.able === true) {
      const name = `iso_bypass_${randomBytes(4).toString('hex')}`;
      await broken.adminPool.query(`CREATE ROLE ${name} NOLOGIN BYPASSRLS`);
      bypassRole = name;
      // The owner grant makes the migrator a member through the owner, not directly.
      await broken.adminPool.query(`GRANT ${name} TO ${broken.roles.app}, ${broken.roles.owner}`);
    }
  });

  afterAll(async () => {
    try {
      if (bypassRole !== undefined && broken !== undefined) {
        try {
          await broken.adminPool.query(`REVOKE ${bypassRole} FROM ${broken.roles.app}, ${broken.roles.owner}`);
        } finally {
          await broken.adminPool.query(`DROP ROLE IF EXISTS ${bypassRole}`);
        }
      }
    } finally {
      try {
        await clean?.drop();
      } finally {
        await broken?.drop();
      }
    }
  });

  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    { db: () => clean, name: 'platform tables and note', tables: ['note'], writeAs: writeNote, readAs: readNotes, rowFor: noteRow },
  );

  describe('checkCatalog', () => {
    it('reports nothing for a schema built from the platform DDL helpers and its own roles', async () => {
      const db = created(clean);
      expect(await checkCatalog(db, { roles: [db.roles.owner, db.roles.app, db.roles.migrator] })).toEqual([]);
    });

    it('reports the unforced table and the table without WITH CHECK, and nothing for the correct one', async () => {
      const db = created(broken);
      const tableFindings = (await checkCatalog(db)).filter((finding) => !isRoleFinding(finding));
      expect(tableFindings.map(summary).sort()).toEqual([
        `policy-missing-check ${db.schema}.broken_nocheck`,
        `rls-not-forced ${db.schema}.broken_noforce`,
      ]);
    });

    it('reports a role that holds SUPERUSER and BYPASSRLS itself', async () => {
      const db = created(broken);
      const superuser = await bootstrapSuperuser(db);
      expect(await checkCatalog(db, { roles: [superuser] })).toEqual(
        expect.arrayContaining([
          { kind: 'role-superuser', object: superuser },
          { kind: 'role-bypassrls', object: superuser },
        ]),
      );
    });

    it('reports a BYPASSRLS role and the roles that are its direct or transitive members', async (ctx) => {
      // PostgreSQL 16 lets only SUPERUSER or BYPASSRLS roles create a BYPASSRLS role; the case above still covers both attributes.
      ctx.skip(bypassRole === undefined, 'PG_USER holds neither SUPERUSER nor BYPASSRLS, so it cannot create a BYPASSRLS role');
      const db = created(broken);
      const bypass = bypassRole as string;
      const detail = `member of ${bypass} (BYPASSRLS)`;
      const findings = (await checkCatalog(db, { roles: [bypass, db.roles.app, db.roles.migrator] })).filter(isRoleFinding);
      expect(findings.map((finding) => `${summary(finding)} ${finding.detail ?? ''}`.trim()).sort()).toEqual(
        [
          `role-bypassrls ${bypass}`,
          `role-member-of-privileged ${db.roles.app} ${detail}`,
          `role-member-of-privileged ${db.roles.migrator} ${detail}`,
        ].sort(),
      );
    });
  });

  describe('PLATFORM_TABLE_GROUPS', () => {
    it('splits the platform tables into the tenant-owned and the non-tenant lists', () => {
      const groups = Object.values(PLATFORM_TABLE_GROUPS);
      expect(groups.flatMap((group) => group.tenantOwned).sort()).toEqual(TENANT_OWNED);
      expect(groups.flatMap((group) => group.nonTenant).sort()).toEqual(NON_TENANT);
    });

    it('names exactly the tables the platform DDL helpers create, with RLS on the tenant-owned ones only', async () => {
      const db = created(clean);
      const { rows } = await db.adminPool.query<{ tablename: string; rowsecurity: boolean }>(
        'SELECT tablename::text AS tablename, rowsecurity FROM pg_tables WHERE schemaname = $1 AND tablename <> $2',
        [db.schema, 'note'],
      );
      expect(rows.map((row) => row.tablename).sort()).toEqual([...TENANT_OWNED, ...NON_TENANT].sort());
      expect(rows.filter((row) => row.rowsecurity).map((row) => row.tablename).sort()).toEqual(TENANT_OWNED);
    });
  });

  describe('expectPlatformTables', () => {
    it('accepts the clean schema for the default groups and for every group', async () => {
      const db = created(clean);
      await expect(expectPlatformTables(db)).resolves.toBeUndefined();
      await expect(expectPlatformTables(db, { groups: ALL_GROUPS })).resolves.toBeUndefined();
    });

    it('rejects the broken schema naming each missing platform table', async () => {
      const db = created(broken);
      const failure = await expectPlatformTables(db).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(Error);
      const lines = (failure as Error).message.split('\n').slice(1).sort();
      expect(lines).toEqual(DEFAULT_GROUP_TABLES.map((table) => `missing ${db.schema}.${table}`).sort());
    });
  });
});
