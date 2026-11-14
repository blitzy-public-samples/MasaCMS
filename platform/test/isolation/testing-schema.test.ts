import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rlsSql, tenantIdForSite } from '../../src/tenancy/index.js';
import { runCleanup } from '../../src/testing/cleanup.js';
import {
  createThrowawaySchema,
  dropThrowawaySchemas,
  pgAvailable,
  rewriteMigrationSql,
  testPgConfig,
  type ThrowawaySchema,
} from '../../src/testing/schema.js';

const ROLES = { owner: 'r_owner', app: 'r_app', migrator: 'r_migrator' };
const TENANT_A = tenantIdForSite('tenant-a');
const SYNTHETIC_PG = { PG_HOST: 'h', PG_USER: 'u', PG_PASSWORD: 'p', PG_DATABASE: 'd' };
const available = await pgAvailable();

const NOTE_DDL = 'CREATE TABLE tschema.note (tenant_id uuid NOT NULL, id serial PRIMARY KEY, body text)';

/** A loopback port that a listener held a moment ago and nothing listens on now. */
async function closedPort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await once(server.close(), 'close');
  return port;
}

/** Rows of `pg_roles` and `pg_namespace` whose names contain `stem`. */
async function residue(stem: string): Promise<string[]> {
  const client = new pg.Client(testPgConfig());
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      `SELECT rolname AS name FROM pg_roles WHERE strpos(rolname, $1) > 0
       UNION ALL SELECT nspname FROM pg_namespace WHERE strpos(nspname, $1) > 0`,
      [stem],
    );
    return rows.map((row) => row.name);
  } finally {
    await client.end();
  }
}

/** The `<base>_<suffix>` stem shared by a handle's schema and role names. */
function stemOf(handle: ThrowawaySchema): string {
  return handle.schema.slice(2);
}

describe('rewriteMigrationSql', () => {
  it.each([
    ['a qualified name', 'CREATE TABLE content.page (id int)', 'CREATE TABLE t_x.page (id int)'],
    ['quoted names', 'SELECT * FROM "content"."page"', 'SELECT * FROM "t_x"."page"'],
    ['an IN SCHEMA clause', 'ALTER DEFAULT PRIVILEGES IN SCHEMA content GRANT SELECT ON TABLES TO x', 'ALTER DEFAULT PRIVILEGES IN SCHEMA t_x GRANT SELECT ON TABLES TO x'],
    ['a quoted SCHEMA clause', 'GRANT USAGE ON SCHEMA "content" TO y', 'GRANT USAGE ON SCHEMA "t_x" TO y'],
    ['CREATE SCHEMA IF NOT EXISTS', 'create schema if not exists content;', 'create schema if not exists t_x;'],
    [
      'production role names',
      'GRANT SELECT ON content.page TO content_app; ALTER TABLE content.page OWNER TO "content_owner"; GRANT content_owner TO content_migrator',
      'GRANT SELECT ON t_x.page TO r_app; ALTER TABLE t_x.page OWNER TO "r_owner"; GRANT r_owner TO r_migrator',
    ],
    [
      'identifiers that only contain the schema name',
      'SELECT content, content_id, content_ids, p.content, mycontent.id, a.content.b, content_owners FROM content.page p',
      'SELECT content, content_id, content_ids, p.content, mycontent.id, a.content.b, content_owners FROM t_x.page p',
    ],
    ['a regclass literal', "SELECT 'content.page'::regclass", "SELECT 't_x.page'::regclass"],
  ])('rewrites %s', (_label, sql, expected) => {
    expect(rewriteMigrationSql(sql, 'content', 't_x', ROLES)).toBe(expected);
  });

  it('maps role names to <to>_owner, _app and _migrator without explicit roles', () => {
    expect(rewriteMigrationSql('GRANT people_owner TO people_migrator, people_app', 'people', 'p2')).toBe(
      'GRANT p2_owner TO p2_migrator, p2_app',
    );
  });

  it.each([
    ['source', 'Content', 't_x'],
    ['target', 'content', 't-x'],
  ])('rejects an invalid %s schema name', (_label, from, to) => {
    expect(() => rewriteMigrationSql('SELECT 1', from, to)).toThrow(TypeError);
  });
});

describe('testPgConfig', () => {
  it('names every missing required variable', () => {
    expect(() => testPgConfig({ PG_PORT: '5432' })).toThrow('PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE');
  });

  it.each([undefined, ''])('rejects PG_PASSWORD %j', (password) => {
    expect(() => testPgConfig({ ...SYNTHETIC_PG, PG_PASSWORD: password })).toThrow('need PG_PASSWORD in the environment');
  });

  it.each(['abc', '54.32', '0', '65536'])('rejects PG_PORT %j', (port) => {
    expect(() => testPgConfig({ ...SYNTHETIC_PG, PG_PORT: port })).toThrow(`PG_PORT to be an integer from 1 to 65535, got "${port}"`);
  });

  it.each([
    [undefined, 5432],
    ['', 5432],
    ['6543', 6543],
  ])('reads PG_PORT %j as port %d', (port, expected) => {
    const config = testPgConfig({ ...SYNTHETIC_PG, PG_PORT: port });
    expect(config).toEqual({ host: 'h', port: expected, user: 'u', password: 'p', database: 'd' });
  });
});

describe('pgAvailable', () => {
  it.each([
    ['PG_HOST is unset', { ...SYNTHETIC_PG, PG_HOST: undefined }],
    ['PG_HOST is empty', { ...SYNTHETIC_PG, PG_HOST: '' }],
    ['no PG_* variable is set', {}],
  ])('resolves false when %s', async (_label, env) => {
    await expect(pgAvailable(env)).resolves.toBe(false);
  });

  it.each([
    ['PG_PASSWORD is unset', { ...SYNTHETIC_PG, PG_PASSWORD: undefined }, 'need PG_PASSWORD in the environment'],
    ['PG_PORT is invalid', { ...SYNTHETIC_PG, PG_PORT: 'abc' }, 'need PG_PORT to be an integer from 1 to 65535, got "abc"'],
  ])('rejects naming the variable when %s', async (_label, env, message) => {
    await expect(pgAvailable(env)).rejects.toThrow(message);
  });

  it('resolves false when nothing listens on the port', async () => {
    const port = await closedPort();
    await expect(pgAvailable({ ...SYNTHETIC_PG, PG_HOST: '127.0.0.1', PG_PORT: String(port) })).resolves.toBe(false);
  });

  it.skipIf(!available)('rejects with the server error on a wrong PG_PASSWORD', async () => {
    const wrong = randomBytes(12).toString('hex');
    await expect(pgAvailable({ ...process.env, PG_PASSWORD: wrong })).rejects.toMatchObject({ code: '28P01' });
  });
});

// Service names carry no clone prefix: the random suffix keeps concurrent runs apart, and the lifecycle cases check drop() leaves no role.
describe.skipIf(!available)('createThrowawaySchema', () => {
  let handle: ThrowawaySchema;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'testing-schema', schemaName: 'tschema', extraSql: [NOTE_DDL, rlsSql('tschema', 'note')] });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('names the schema t_<base>_<suffix> and the roles <base>_<suffix>_<role>', () => {
    expect(handle.schema).toMatch(/^t_testing_schema_[0-9a-f]{8}$/);
    const stem = stemOf(handle);
    expect(handle.roles).toEqual({ owner: `${stem}_owner`, app: `${stem}_app`, migrator: `${stem}_migrator` });
  });

  it('lets the app role run DML through the TenantDb', async () => {
    const bodies = await handle.app.withTenant(TENANT_A, async (tx) => {
      await tx.query(`INSERT INTO ${handle.schema}.note (tenant_id, body) VALUES ($1, 'a')`, [TENANT_A]);
      await tx.query(`UPDATE ${handle.schema}.note SET body = 'b'`);
      const { rows } = await tx.query<{ body: string }>(`SELECT body FROM ${handle.schema}.note`);
      await tx.query(`DELETE FROM ${handle.schema}.note`);
      return rows.map((row) => row.body);
    });
    expect(bodies).toEqual(['b']);
  });

  it('grants the app role USAGE, SELECT and UPDATE on sequences the owner creates', async () => {
    const { rows } = await handle.adminPool.query<{ usage: boolean; select: boolean; update: boolean }>(
      `SELECT has_sequence_privilege($1, s, 'USAGE') AS usage, has_sequence_privilege($1, s, 'SELECT') AS select,
              has_sequence_privilege($1, s, 'UPDATE') AS update
         FROM pg_get_serial_sequence($2, 'id') AS s`,
      [handle.roles.app, `${handle.schema}.note`],
    );
    expect(rows).toEqual([{ usage: true, select: true, update: true }]);
  });

  it('refuses DDL to the app role', async () => {
    await expect(handle.appPool.query(`CREATE TABLE ${handle.schema}.x (id int)`)).rejects.toMatchObject({ code: '42501' });
  });

  it('creates roles without SUPERUSER or BYPASSRLS, the owner without LOGIN', async () => {
    const { rows } = await handle.adminPool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      'SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
      [Object.values(handle.roles)],
    );
    expect(rows).toEqual([
      { rolname: handle.roles.app, rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: handle.roles.migrator, rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: handle.roles.owner, rolsuper: false, rolbypassrls: false, rolcanlogin: false },
    ]);
  });

  it('makes the owner own the schema and the objects SQL creates, with RLS forced', async () => {
    const { rows } = await handle.adminPool.query<{ relname: string; owner: string; forced: boolean }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'note'`,
      [handle.schema],
    );
    expect(rows).toEqual([{ relname: 'note', owner: handle.roles.owner, forced: true }]);
    const schemaOwner = await handle.adminPool.query<{ owner: string }>(
      'SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1',
      [handle.schema],
    );
    expect(schemaOwner.rows).toEqual([{ owner: handle.roles.owner }]);
  });

  it('opens further tracked pools per role', async () => {
    const pool = handle.connect('migrator', { max: 1 });
    const { rows } = await pool.query<{ who: string }>('SELECT current_user AS who');
    expect(rows).toEqual([{ who: handle.roles.migrator }]);
  });
});

describe.skipIf(!available)('createThrowawaySchema lifecycle', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opt2-testing-schema-'));
    await writeFile(join(dir, '0002_body.sql'), 'ALTER TABLE tschema.item ADD COLUMN body text;');
    await writeFile(join(dir, '0001_item.sql'), 'CREATE TABLE tschema.item (id int); GRANT SELECT ON tschema.item TO tschema_app;');
    await writeFile(join(dir, 'README.md'), 'not sql');
    await writeFile(join(dir, '1_skipped.sql'), 'SELECT broken syntax here;');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('applies matching migration files in name order and drops everything afterwards', async () => {
    const handle = await createThrowawaySchema({ service: 'testing-schema', schemaName: 'tschema', migrationsDir: dir });
    const { rows } = await handle.adminPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'item' ORDER BY ordinal_position`,
      [handle.schema],
    );
    expect(rows.map((row) => row.column_name)).toEqual(['id', 'body']);

    await handle.drop();
    await handle.drop();
    expect(await residue(stemOf(handle))).toEqual([]);
    expect(() => handle.connect('app')).toThrow('has been dropped');
  });

  it('still drops the schema and roles through runCleanup when an earlier step rejects', async () => {
    const handle = await createThrowawaySchema({ service: 'testing-schema' });
    const closeFailure = new Error('close failed');

    const failure = await runCleanup('lifecycle', [() => Promise.reject(closeFailure), () => handle.drop()]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([closeFailure]);
    expect(await residue(stemOf(handle))).toEqual([]);
  });

  it('closes tracked connections, ending pools included, before terminating the untracked backends of its roles', async () => {
    const handle = await createThrowawaySchema({ service: 'testing-schema' });
    const extra = handle.connect('app', { max: 2 });
    const ending = handle.connect('migrator');
    const tracked = [handle.appPool, handle.migratorPool, extra, ending];
    const errors: string[] = [];
    for (const pool of tracked) {
      pool.on('error', (err) => errors.push(err.message));
      // A deferred end() keeps the socket open after pool.end() resolves, as a slow Terminate does under load.
      pool.on('connect', (client) => {
        const end = client.end.bind(client) as (cb: () => void) => void;
        Object.assign(client, { end: (cb: () => void) => void setTimeout(() => end(cb), 250) });
      });
    }
    await Promise.all([...tracked.map((pool) => pool.query('SELECT 1')), extra.query('SELECT 1')]);
    const untracked = new pg.Client({ ...testPgConfig(), user: handle.roles.app, password: handle.appPool.options.password });
    const untrackedErrors: Error[] = [];
    untracked.on('error', (err) => untrackedErrors.push(err));
    const untrackedEnded = new Promise((resolve) => untracked.once('end', resolve));
    await untracked.connect();

    const ended = ending.end();
    await handle.drop();
    await Promise.all([ended, untrackedEnded]);

    expect(errors).toEqual([]);
    expect(untrackedErrors[0]).toMatchObject({ code: '57P01' });
    expect(await residue(stemOf(handle))).toEqual([]);
  });

  it('gives concurrent calls distinct names within the identifier limit', async () => {
    const service = `x-${'long'.repeat(20)}`;
    const handles = await Promise.all([createThrowawaySchema({ service }), createThrowawaySchema({ service })]);
    try {
      const [first, second] = handles;
      expect(first?.schema).not.toBe(second?.schema);
      for (const name of handles.flatMap((h) => [h.schema, ...Object.values(h.roles)])) {
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
      }
    } finally {
      await Promise.all(handles.map((h) => h.drop()));
    }
    for (const handle of handles) {
      expect(await residue(stemOf(handle))).toEqual([]);
    }
  });

  it('drops everything and names the failing file when a migration fails', async () => {
    const service = `fail-${randomBytes(3).toString('hex')}`;
    const failing = await mkdtemp(join(tmpdir(), 'opt2-testing-schema-fail-'));
    try {
      await writeFile(join(failing, '0001_bad.sql'), 'CREATE TABLE tschema.bad (id int REFERENCES nowhere);');
      await expect(createThrowawaySchema({ service, schemaName: 'tschema', migrationsDir: failing })).rejects.toThrow(/0001_bad\.sql failed/);
      expect(await residue(service.replace('-', '_'))).toEqual([]);
    } finally {
      await rm(failing, { recursive: true, force: true });
    }
  });

  it('names extraSql entries that fail', async () => {
    await expect(createThrowawaySchema({ service: 'testing-schema', extraSql: ['SELECT 1', 'SELECT * FROM missing_table'] })).rejects.toThrow(
      /extraSql\[1\] failed/,
    );
  });

  it('sweeps a creation that has not taken the bootstrap lock yet, and the creation rejects', async () => {
    const service = `sweep-${randomBytes(3).toString('hex')}`;
    const outcome = createThrowawaySchema({ service }).then(
      () => undefined,
      (error: unknown) => error,
    );

    await dropThrowawaySchemas();

    expect(await outcome).toMatchObject({ message: expect.stringMatching(/bootstrap failed: drop\(\) was called before the schema was created/) });
    expect(await residue(service.replace('-', '_'))).toEqual([]);
  });

  it('sweeps a creation blocked inside a migration step, and the creation names the step it could not run', async () => {
    const service = `sweep-${randomBytes(3).toString('hex')}`;
    const key = randomBytes(4).readUInt32BE() >>> 1;
    const holder = new pg.Client(testPgConfig());
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [key]);
      const outcome = createThrowawaySchema({ service, extraSql: [`SELECT pg_advisory_xact_lock(${key})`, 'SELECT 1'] }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const waiting = `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = $1 AND objsubid = 1
                          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      await expect.poll(async () => (await holder.query(waiting, [key])).rowCount, { timeout: 30_000, interval: 20 }).toBe(1);

      const sweeping = dropThrowawaySchemas();
      await holder.query('SELECT pg_advisory_unlock($1)', [key]);
      await sweeping;

      expect(await outcome).toMatchObject({ message: expect.stringMatching(/extraSql\[1\] failed: Cannot use a pool after calling end on the pool/) });
    } finally {
      await holder.end();
    }
    expect(await residue(service.replace('-', '_'))).toEqual([]);
  });

  it.each([
    ['nobody dropped', async (): Promise<void> => undefined],
    [
      'whose drop() already rejected',
      async (handle: ThrowawaySchema): Promise<void> => {
        const end = handle.adminPool.end.bind(handle.adminPool) as () => Promise<void>;
        Object.assign(handle.adminPool, { end: () => end().then(() => Promise.reject(new Error('end failed'))) });
        await expect(handle.drop()).rejects.toThrow('end failed');
      },
    ],
  ])('sweeps a completed handle %s without an error', async (_label, before) => {
    const handle = await createThrowawaySchema({ service: 'testing-schema' });
    await before(handle);

    await expect(dropThrowawaySchemas()).resolves.toBeUndefined();

    expect(await residue(stemOf(handle))).toEqual([]);
    expect(() => handle.connect('app')).toThrow('has been dropped');
  });
});
