import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rlsSql, withTenant, type PoolClient } from '../../src/tenancy/index.js';
import {
  TENANT_A,
  checkCatalog,
  createThrowawaySchema,
  pgAvailable,
  testPgConfig,
  type ThrowawayRole,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

// No clone or run prefix: createThrowawaySchema's random suffix keeps concurrent runs apart and drop() removes the roles.
const SOURCE = 'isorole';
const NOTE_ID = 'A1B2C3D4-0000-0000-0000000000000001';
const INSUFFICIENT_PRIVILEGE = { code: '42501' };

const ANCESTRY_SQL = `
WITH RECURSIVE ancestry(member, ancestor) AS (
  SELECT r.rolname::text, m.roleid
    FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
   WHERE r.rolname = ANY($1::text[])
  UNION
  SELECT a.member, m.roleid FROM ancestry a JOIN pg_auth_members m ON m.member = a.ancestor
)
SELECT DISTINCT a.member, g.rolname::text AS ancestor, g.rolsuper, g.rolbypassrls
  FROM ancestry a JOIN pg_roles g ON g.oid = a.ancestor
 ORDER BY 1, 2`;

interface RoleFlags {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
}

interface Ancestor {
  member: string;
  ancestor: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

let handle: ThrowawaySchema;

/** Runs `fn` on a dedicated connection as `role`, so a session-level SET ROLE never reaches the shared pools. */
async function onConnection<T>(role: ThrowawayRole, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = handle.connect(role, { max: 1 });
  try {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

describe('database role chain', () => {
  beforeAll(async () => {
    if (!(await pgAvailable())) {
      const { host, port } = testPgConfig();
      throw new Error(`The role-chain suite needs a PostgreSQL server at PG_HOST:PG_PORT ${host}:${port}, which is unreachable`);
    }
    handle = await createThrowawaySchema({
      service: SOURCE,
      extraSql: [
        `CREATE TABLE ${SOURCE}.note (tenant_id uuid NOT NULL, id char(35) PRIMARY KEY, body text, row_version int NOT NULL DEFAULT 0)`,
        rlsSql(SOURCE, 'note'),
      ],
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('reports no catalog findings for the owner, app and migrator roles', async () => {
    const { owner, app, migrator } = handle.roles;
    expect(await checkCatalog(handle, { roles: [owner, app, migrator] })).toEqual([]);
  });

  it('creates no role with SUPERUSER or BYPASSRLS and gives LOGIN only to the app and migrator roles', async () => {
    const { owner, app, migrator } = handle.roles;
    const { rows } = await handle.adminPool.query<RoleFlags>(
      'SELECT rolname::text, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])',
      [[owner, app, migrator]],
    );
    const flags = Object.fromEntries(rows.map(({ rolname, ...rest }) => [rolname, rest]));
    expect(flags).toEqual({
      [owner]: { rolsuper: false, rolbypassrls: false, rolcanlogin: false },
      [app]: { rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      [migrator]: { rolsuper: false, rolbypassrls: false, rolcanlogin: true },
    });
  });

  it('makes the migrator a member of the owner only, with no SUPERUSER or BYPASSRLS ancestor for any role', async () => {
    const { owner, app, migrator } = handle.roles;
    const { rows } = await handle.adminPool.query<Ancestor>(ANCESTRY_SQL, [[owner, app, migrator]]);
    expect(rows.filter((row) => row.rolsuper || row.rolbypassrls)).toEqual([]);
    expect(rows).toEqual([{ member: migrator, ancestor: owner, rolsuper: false, rolbypassrls: false }]);
  });

  it('lets the app role insert, select, update and delete notes through default privileges', async () => {
    const outcome = await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      const note = `${tx.schema}.note`;
      const inserted = await tx.query(`INSERT INTO ${note} (tenant_id, id, body) VALUES ($1, $2, 'first')`, [TENANT_A.tenantId, NOTE_ID]);
      const selected = await tx.query<{ body: string }>(`SELECT body FROM ${note} WHERE id = $1`, [NOTE_ID]);
      const updated = await tx.query<{ body: string; row_version: number }>(
        `UPDATE ${note} SET body = 'second', row_version = row_version + 1 WHERE id = $1 RETURNING body, row_version`,
        [NOTE_ID],
      );
      const deleted = await tx.query(`DELETE FROM ${note} WHERE id = $1`, [NOTE_ID]);
      return { inserted: inserted.rowCount, selected: selected.rows, updated: updated.rows, deleted: deleted.rowCount };
    });
    expect(outcome).toEqual({
      inserted: 1,
      selected: [{ body: 'first' }],
      updated: [{ body: 'second', row_version: 1 }],
      deleted: 1,
    });
  });

  it.each([
    ['create a table', (schema: string) => `CREATE TABLE ${schema}.x (id int)`],
    ['alter the note table', (schema: string) => `ALTER TABLE ${schema}.note ADD COLUMN y int`],
  ])('refuses the app role permission to %s', async (_label, sql) => {
    await expect(handle.appPool.query(sql(handle.schema))).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
  });

  it('keeps the app role out of the owner role', async () => {
    const { owner, app } = handle.roles;
    const { rows } = await handle.adminPool.query<{ member: boolean }>("SELECT pg_has_role($1::name, $2::name, 'MEMBER') AS member", [
      app,
      owner,
    ]);
    expect(rows).toEqual([{ member: false }]);
    await onConnection('app', async (client) => {
      await expect(client.query(`SET ROLE ${owner}`)).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
    });
  });

  it('lets the migrator create a table as the owner that the app role uses without an explicit grant', async () => {
    const { owner } = handle.roles;
    const later = `${handle.schema}.later`;
    const actor = await onConnection('migrator', async (client) => {
      await client.query(`SET ROLE ${owner}`);
      try {
        await client.query(`CREATE TABLE ${later} (id int)`);
        return (await client.query<{ who: string }>('SELECT current_user::text AS who')).rows;
      } finally {
        await client.query('RESET ROLE');
      }
    });
    expect(actor).toEqual([{ who: owner }]);

    const owners = await handle.adminPool.query<{ tableowner: string }>(
      "SELECT tableowner::text FROM pg_tables WHERE schemaname = $1 AND tablename = 'later'",
      [handle.schema],
    );
    expect(owners.rows).toEqual([{ tableowner: owner }]);

    await handle.appPool.query(`INSERT INTO ${later} (id) VALUES (7)`);
    const { rows } = await handle.appPool.query<{ id: number }>(`SELECT id FROM ${later}`);
    expect(rows).toEqual([{ id: 7 }]);
  });

  it('grants PUBLIC nothing on the schema or its tables', async () => {
    const { adminPool, schema } = handle;
    const namespace = await adminPool.query<{ public_entries: number; usage: boolean }>(
      `SELECT (SELECT count(*)::int FROM aclexplode(n.nspacl) a WHERE a.grantee = 0) AS public_entries,
              has_schema_privilege('public'::name, n.nspname::text, 'USAGE') AS usage
         FROM pg_namespace n WHERE n.nspname = $1`,
      [schema],
    );
    expect(namespace.rows).toEqual([{ public_entries: 0, usage: false }]);

    const tables = await adminPool.query<{ relname: string; public_entries: number }>(
      `SELECT c.relname::text AS relname, (SELECT count(*)::int FROM aclexplode(c.relacl) a WHERE a.grantee = 0) AS public_entries
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname IN ('note', 'later')
        ORDER BY c.relname`,
      [schema],
    );
    expect(tables.rows).toEqual([
      { relname: 'later', public_entries: 0 },
      { relname: 'note', public_entries: 0 },
    ]);
  });
});
