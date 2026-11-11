import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type Logger } from '@opt2/platform/logging';
import {
  MIGRATION_FILE_PATTERN,
  MigrationDirectoryError,
  MigrationFailedError,
  SchemaNotEmptyError,
  applyMigrations,
  assertSchemasEmpty,
  listMigrationFiles,
  nonEmptySchemas,
  resetLocalSchemas,
  type MigrationFile,
} from '../../src/db-bootstrap/migrations.js';
import { RESET_ROLE_SQL, setRoleSql } from '../../src/db-bootstrap/privileges.js';
import {
  CREATEROLE_SELF_GRANT_SQL,
  allRoleNames,
  createRolesSql,
  createSchemaSql,
  dropLocalSql,
  quoteIdent,
  roleChainSql,
  rolesFor,
  type RoleMode,
  type SchemaRoles,
  type SqlClient,
} from '../../src/db-bootstrap/roles.js';

interface Call {
  text: string;
  values: unknown[] | undefined;
}

/** A SqlClient that records every query, rejects the texts `failures` maps, and answers the rest with `rows(text)`. */
function fakeClient(options: { failures?: Map<string, unknown>; rows?: (text: string) => unknown[] } = {}): {
  client: SqlClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: SqlClient = {
    query(text, values) {
      calls.push({ text, values });
      const failure = options.failures?.get(text);
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve({ rows: options.rows?.(text) ?? [] });
    },
  };
  return { client, calls };
}

/** A real log-record.v1 logger whose lines are kept in `lines`. */
function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'migration',
    version: '1.0.0',
    env: 'local',
    destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) },
  });
  return { logger, lines };
}

/** A PostgreSQL driver error as `pg` raises it. */
function pgError(message: string, code: string, position?: string): Error {
  return Object.assign(new Error(message), { severity: 'ERROR', code, position });
}

const texts = (calls: Call[]): string[] => calls.map((call) => call.text);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-migrations-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeFiles(files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text, 'utf8');
}

describe('MIGRATION_FILE_PATTERN', () => {
  it.each(['0001_gateway.sql', '0002_accounts.sql', '0010_a.b-c_D.sql'])('accepts %s', (name) => {
    expect(MIGRATION_FILE_PATTERN.test(name)).toBe(true);
  });

  it.each(['README.sql', '001_short.sql', '0001-dash.sql', '0001_.sql', '0001_a b.sql', '0001_a.sql.bak'])(
    'rejects %s',
    (name) => {
      expect(MIGRATION_FILE_PATTERN.test(name)).toBe(false);
    },
  );
});

describe('listMigrationFiles', () => {
  it('lists regular .sql files in plain string order with absolute paths', async () => {
    await writeFiles({ '0010_c.sql': '', '0002_b.sql': '', '0001_a.sql': '', '0001_B.sql': '', 'notes.md': '' });
    await mkdir(path.join(dir, '0003_folder.sql'));
    const files = await listMigrationFiles(dir);
    // Code-unit order puts uppercase B before lowercase a, unlike localeCompare.
    expect(files).toEqual<MigrationFile[]>(
      ['0001_B.sql', '0001_a.sql', '0002_b.sql', '0010_c.sql'].map((name) => ({ name, path: path.join(dir, name) })),
    );
  });

  it.each([
    {
      label: 'a misnamed .sql file',
      setup: () => writeFiles({ '0001_a.sql': '', 'README.sql': '' }),
      reason: 'SQL files not named NNNN_<name>.sql: README.sql',
    },
    { label: 'an empty directory', setup: () => writeFiles({ 'README.md': '' }), reason: 'holds no migration files' },
    { label: 'a missing directory', setup: () => rm(dir, { recursive: true }), reason: 'does not exist' },
  ])('throws MigrationDirectoryError for $label', async ({ setup, reason }) => {
    await setup();
    const error = await listMigrationFiles(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationDirectoryError);
    expect(error).toMatchObject({ name: 'MigrationDirectoryError', dir, reason, message: `migration directory ${dir}: ${reason}` });
  });

  it('reports a path that is not a directory as unreadable', async () => {
    const file = path.join(dir, 'plain.txt');
    await writeFile(file, '');
    const error = await listMigrationFiles(file).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationDirectoryError);
    expect((error as MigrationDirectoryError).reason).toMatch(/^cannot be read: ENOTDIR/);
    expect((error as MigrationDirectoryError).cause).toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('applyMigrations', () => {
  const roles = rolesFor('alpha');
  const FIRST = 'CREATE TABLE alpha.a (id int);\nCREATE INDEX a_idx ON alpha.a (id);';
  const SECOND = '-- ünïcødé 😀\nCREATE TABLE alpha.b (id int);\nSELECT * FROM alpha.missing;';

  async function files(): Promise<MigrationFile[]> {
    await writeFiles({ '0001_a.sql': FIRST, '0002_b.sql': SECOND });
    return listMigrationFiles(dir);
  }

  it('applies each file in its own transaction as the owner and returns the count', async () => {
    const { client, calls } = fakeClient();
    const { logger, lines } = capturingLogger();
    expect(await applyMigrations(client, roles, await files(), logger)).toBe(2);
    expect(calls).toEqual<Call[]>(
      [setRoleSql('alpha_owner'), 'BEGIN', FIRST, 'COMMIT', 'BEGIN', SECOND, 'COMMIT', RESET_ROLE_SQL].map((text) => ({
        text,
        values: undefined,
      })),
    );
    expect(calls[0]?.text).toBe('SET ROLE "alpha_owner"');
    expect(lines.map((line) => line.message)).toEqual(['applied alpha/0001_a.sql', 'applied alpha/0002_b.sql']);
    expect(lines.every((line) => line.severity === 'INFO')).toBe(true);
  });

  it('rolls back a failing file, resets the role and names schema, file, SQLSTATE and line', async () => {
    const position = Array.from(SECOND.slice(0, SECOND.indexOf('alpha.missing'))).length + 1;
    const cause = pgError('relation "alpha.missing" does not exist', '42P01', String(position));
    const { client, calls } = fakeClient({ failures: new Map([[SECOND, cause]]) });
    const { logger, lines } = capturingLogger();
    const error = await applyMigrations(client, roles, await files(), logger).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationFailedError);
    expect(error).toMatchObject({
      name: 'MigrationFailedError',
      schema: 'alpha',
      file: '0002_b.sql',
      sqlState: '42P01',
      position,
      line: 3,
      cause,
      message: `migration alpha/0002_b.sql failed: relation "alpha.missing" does not exist (SQLSTATE 42P01) at position ${position}, line 3`,
    });
    expect((error as Error).message).not.toContain('CREATE TABLE');
    expect(texts(calls)).toEqual([setRoleSql('alpha_owner'), 'BEGIN', FIRST, 'COMMIT', 'BEGIN', SECOND, 'ROLLBACK', RESET_ROLE_SQL]);
    expect(lines.map((line) => line.message)).toEqual(['applied alpha/0001_a.sql']);
  });

  it('keeps the original error when ROLLBACK and RESET ROLE also fail', async () => {
    const cause = pgError('syntax error at or near "CREAT"', '42601');
    const failures = new Map<string, unknown>([
      [FIRST, cause],
      ['ROLLBACK', new Error('connection terminated')],
      [RESET_ROLE_SQL, new Error('connection terminated')],
    ]);
    const { client, calls } = fakeClient({ failures });
    const error = await applyMigrations(client, roles, await files(), capturingLogger().logger).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ file: '0001_a.sql', cause, position: undefined, line: undefined });
    expect((error as Error).message).toBe('migration alpha/0001_a.sql failed: syntax error at or near "CREAT" (SQLSTATE 42601)');
    expect(texts(calls)).toEqual([setRoleSql('alpha_owner'), 'BEGIN', FIRST, 'ROLLBACK', RESET_ROLE_SQL]);
  });

  it('fails an unreadable file before opening its transaction', async () => {
    const { client, calls } = fakeClient();
    const missing: MigrationFile = { name: '0001_gone.sql', path: path.join(dir, '0001_gone.sql') };
    const error = await applyMigrations(client, roles, [missing], capturingLogger().logger).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationFailedError);
    expect(error).toMatchObject({ schema: 'alpha', file: '0001_gone.sql', sqlState: undefined, position: undefined });
    expect((error as Error).message).toMatch(/^migration alpha\/0001_gone\.sql failed: ENOENT/);
    expect(texts(calls)).toEqual([setRoleSql('alpha_owner'), RESET_ROLE_SQL]);
  });

  it('propagates a RESET ROLE failure after every file applied', async () => {
    const failure = new Error('connection terminated');
    const { client } = fakeClient({ failures: new Map([[RESET_ROLE_SQL, failure]]) });
    await expect(applyMigrations(client, roles, await files(), capturingLogger().logger)).rejects.toBe(failure);
  });

  it.each([
    { label: 'a non-Error cause', cause: 'boom', message: 'boom' },
    { label: 'a system error with a five-letter code', cause: Object.assign(new Error('EPERM: denied'), { code: 'EPERM' }), message: 'EPERM: denied' },
  ])('reports no SQLSTATE or position for $label', ({ cause, message }) => {
    const error = new MigrationFailedError('alpha', '0001_a.sql', cause, 4);
    expect(error).toMatchObject({ message: `migration alpha/0001_a.sql failed: ${message}`, sqlState: undefined, line: undefined });
  });
});

describe('resetLocalSchemas', () => {
  it('looks roles up once, then drops schemas in reverse bootstrap order', async () => {
    const list = [rolesFor('identity'), rolesFor('people'), rolesFor('migration')];
    const existingRoles = ['identity_owner', 'identity_app', 'migration_migrator'];
    const { client, calls } = fakeClient({
      rows: (text) => (text.includes('pg_roles') ? existingRoles.map((rolname) => ({ rolname })) : []),
    });
    await resetLocalSchemas(client, list);
    const existing = new Set(existingRoles);
    expect(calls[0]).toEqual<Call>({
      text: 'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
      values: [allRoleNames(list)],
    });
    expect(texts(calls.slice(1))).toEqual([...list].reverse().flatMap((roles) => dropLocalSql(roles, existing)));
    const drops = texts(calls);
    expect(drops.indexOf('DROP SCHEMA IF EXISTS "migration" CASCADE')).toBeLessThan(
      drops.indexOf('DROP SCHEMA IF EXISTS "identity" CASCADE'),
    );
    expect(drops.filter((text) => text.startsWith('DROP OWNED BY'))).toEqual([
      'DROP OWNED BY "migration_migrator"',
      'DROP OWNED BY "identity_owner", "identity_app"',
    ]);
  });
});

describe('nonEmptySchemas and assertSchemasEmpty', () => {
  it('returns populated schemas in input order', async () => {
    const { client, calls } = fakeClient({ rows: () => [{ nspname: 'beta' }, { nspname: 'alpha' }] });
    expect(await nonEmptySchemas(client, ['alpha', 'gamma', 'beta'])).toEqual(['alpha', 'beta']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("c.relkind IN ('r','p')");
    expect(calls[0]?.values).toEqual([['alpha', 'gamma', 'beta']]);
  });

  it('passes when no schema holds a table', async () => {
    const { client } = fakeClient();
    await expect(assertSchemasEmpty(client, ['alpha', 'beta'])).resolves.toBeUndefined();
  });

  it('throws SchemaNotEmptyError naming every populated schema', async () => {
    const { client } = fakeClient({ rows: () => [{ nspname: 'gamma' }, { nspname: 'alpha' }] });
    const error = await assertSchemasEmpty(client, ['alpha', 'beta', 'gamma']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaNotEmptyError);
    expect(error).toMatchObject({
      name: 'SchemaNotEmptyError',
      schemas: ['alpha', 'gamma'],
      message: 'refusing to apply migrations: schemas already hold tables: alpha, gamma',
    });
  });
});

const PG_CONFIG: pg.ClientConfig = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  connectionTimeoutMillis: 2000,
};

/** True when every required `PG_*` variable is set and the server accepts a connection. */
async function pgReachable(): Promise<boolean> {
  if (!process.env.PG_HOST || !process.env.PG_USER || !process.env.PG_DATABASE) return false;
  const client = new pg.Client(PG_CONFIG);
  try {
    await client.connect();
  } catch {
    return false;
  }
  await client.end();
  return true;
}

const available = await pgReachable();
const RUN = `t_dbm_${randomBytes(4).toString('hex')}`;
const CHAINS = [rolesFor(`${RUN}_a`), rolesFor(`${RUN}_b`)];
const MODE: RoleMode = {
  kind: 'local',
  appPassword: randomBytes(18).toString('base64url'),
  migratorPassword: randomBytes(18).toString('base64url'),
};

async function withClient<T>(config: pg.ClientConfig, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const asMigrator = (roles: SchemaRoles): pg.ClientConfig => ({ ...PG_CONFIG, user: roles.migrator, password: MODE.migratorPassword });

/** Writes one schema's migrations into its own directory under `dir`. */
async function migrationsFor(roles: SchemaRoles, files: Record<string, string>): Promise<string> {
  const schemaDir = path.join(dir, roles.schema);
  await mkdir(schemaDir);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(schemaDir, name), text, 'utf8');
  return schemaDir;
}

/** Resets, then creates the role chain and schema of every chain, as a local bootstrap does before migrating. */
async function resetAndCreateChains(admin: pg.Client): Promise<void> {
  await resetLocalSchemas(admin, CHAINS);
  for (const roles of CHAINS) {
    for (const statement of [CREATEROLE_SELF_GRANT_SQL, ...createRolesSql(roles, MODE), ...createSchemaSql(roles, { ifNotExists: false }), ...roleChainSql(roles)]) {
      await admin.query(statement);
    }
  }
}

/** Applies the sample migrations of every chain as its migrator; returns the applied counts. */
async function migrateChains(): Promise<number[]> {
  const counts: number[] = [];
  for (const roles of CHAINS) {
    const s = quoteIdent(roles.schema);
    const schemaDir = await migrationsFor(roles, {
      '0001_note.sql': `CREATE TABLE ${s}.note (id serial PRIMARY KEY, body text NOT NULL);\nCREATE INDEX note_body_idx ON ${s}.note (body);`,
      '0002_event.sql': `CREATE TABLE ${s}.event (at date NOT NULL) PARTITION BY RANGE (at);\nCREATE TABLE ${s}.event_2026 PARTITION OF ${s}.event FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`,
    });
    const files = await listMigrationFiles(schemaDir);
    counts.push(await withClient(asMigrator(roles), (client) => applyMigrations(client, roles, files, capturingLogger().logger)));
    await rm(schemaDir, { recursive: true });
  }
  return counts;
}

describe.skipIf(!available)('migrations against PostgreSQL', () => {
  afterAll(async () => {
    await withClient(PG_CONFIG, (admin) => resetLocalSchemas(admin, CHAINS));
  });

  it('migrates as the owner, refuses populated schemas and resets for a second run', async () => {
    await withClient(PG_CONFIG, async (admin) => {
      const schemas = CHAINS.map((roles) => roles.schema);
      await resetAndCreateChains(admin);
      await expect(assertSchemasEmpty(admin, schemas)).resolves.toBeUndefined();

      expect(await migrateChains()).toEqual([2, 2]);
      const { rows } = await admin.query<{ schema: string; relname: string; owner: string }>(
        `SELECT n.nspname AS schema, c.relname, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1::text[]) ORDER BY 1, 2`,
        [schemas],
      );
      expect(rows.length).toBeGreaterThanOrEqual(12);
      for (const row of rows) expect(row.owner).toBe(`${row.schema}_owner`);

      const refusal = await assertSchemasEmpty(admin, [...schemas, `${RUN}_absent`]).catch((caught: unknown) => caught);
      expect(refusal).toBeInstanceOf(SchemaNotEmptyError);
      expect((refusal as SchemaNotEmptyError).schemas).toEqual(schemas);

      await resetAndCreateChains(admin);
      expect(await nonEmptySchemas(admin, schemas)).toEqual([]);
      expect(await migrateChains()).toEqual([2, 2]);
    });
  });

  it('rolls back a failing file, locates the error and leaves the migrator in its login role', async () => {
    const [roles] = CHAINS as [SchemaRoles];
    const s = quoteIdent(roles.schema);
    await withClient(PG_CONFIG, resetAndCreateChains);
    const schemaDir = await migrationsFor(roles, {
      '0001_broken.sql': `CREATE TABLE ${s}.kept (id int);\nSELECT no_such_column FROM ${s}.kept;`,
    });
    const files = await listMigrationFiles(schemaDir);
    await withClient(asMigrator(roles), async (client) => {
      const error = await applyMigrations(client, roles, files, capturingLogger().logger).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: 'MigrationFailedError',
        schema: roles.schema,
        file: '0001_broken.sql',
        sqlState: '42703',
        line: 2,
      });
      expect((error as Error).message).not.toContain('SELECT');
      const { rows } = await client.query<{ who: string; kept: string | null }>(
        'SELECT current_user AS who, to_regclass($1)::text AS kept',
        [`${s}.kept`],
      );
      expect(rows).toEqual([{ who: roles.migrator, kept: null }]);
    });
  });

  it('leaves no role or schema of this run behind after a reset', async () => {
    await withClient(PG_CONFIG, async (admin) => {
      await resetLocalSchemas(admin, CHAINS);
      const { rows } = await admin.query<{ name: string }>(
        'SELECT rolname AS name FROM pg_roles WHERE rolname = ANY($1::text[]) UNION ALL SELECT nspname FROM pg_namespace WHERE nspname = ANY($2::text[])',
        [allRoleNames(CHAINS), CHAINS.map((roles) => roles.schema)],
      );
      expect(rows).toEqual([]);
    });
  });
});
