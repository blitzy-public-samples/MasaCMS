import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertRoles, type Finding, type FindingKind, type RoleAssertionInput } from '../../src/db-bootstrap/assertions.js';
import {
  defaultPrivilegesSql,
  postMigrationGrantsSql,
  RESET_ROLE_SQL,
  setRoleSql,
} from '../../src/db-bootstrap/privileges.js';
import {
  CREATEROLE_SELF_GRANT_SQL,
  allRoleNames,
  createRolesSql,
  createSchemaSql,
  dropLocalSql,
  grantRoleToSql,
  quoteIdent,
  quoteLiteral,
  redactSql,
  roleChainSql,
  rolesFor,
  type RoleMode,
  type SchemaRoles,
  type SqlClient,
} from '../../src/db-bootstrap/roles.js';

const A = rolesFor('alpha');
const B = rolesFor('beta');
const IAM_A = 'alpha-sa@example-project.iam';
const IAM_B = 'beta-sa@example-project.iam';
const IAM_JOB = 'db-bootstrap@example-project.iam';
const IAM_USERS = [IAM_A, IAM_B, IAM_JOB];
const ROOT = 'root_role';
// Sample credentials are assembled at run time so no password literal sits in source.
const APP_SECRET = ['app', 'sample', 'value'].join('-');
const MIGRATOR_SECRET = ['migrator', 'sample', 'value'].join('-');
const LOCAL: RoleMode = { kind: 'local', appPassword: APP_SECRET, migratorPassword: MIGRATOR_SECRET };

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
}

interface AncestorRow {
  subject: string;
  via?: string | null;
  ancestor: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

interface SchemaRow {
  nspname: string;
  owner: string;
  acl: string[] | null;
}

/** Scripted catalog rows the fake client returns; `create` maps an app role to its has_schema_privilege rows. */
interface Catalog {
  roles: RoleRow[];
  ancestors: AncestorRow[];
  schemas: SchemaRow[];
  create: Record<string, unknown[]>;
}

interface Call {
  text: string;
  values: unknown[] | undefined;
}

const finding = (kind: FindingKind, subject: string, detail: string): Finding => ({ kind, subject, detail });

const roleRow = (rolname: string, rolcanlogin: boolean): RoleRow => ({
  rolname,
  rolsuper: false,
  rolbypassrls: false,
  rolcanlogin,
});

/** A grant path from `subject` to `ancestor`; the first hop defaults to the ancestor itself (a direct grant). */
const ancestorRow = (subject: string, ancestor: string, extra: Partial<AncestorRow> = {}): AncestorRow => ({
  subject,
  via: ancestor,
  ancestor,
  rolsuper: false,
  rolbypassrls: false,
  ...extra,
});

/** Catalog rows of the alpha and beta role chains as a sound bootstrap leaves them for `target`. */
function soundCatalog(target: 'local' | 'cloud'): Catalog {
  const cloud = target === 'cloud';
  const chains = [A, B];
  return {
    roles: [
      ...chains.flatMap((r) => [roleRow(r.owner, false), roleRow(r.app, !cloud), roleRow(r.migrator, !cloud)]),
      ...(cloud ? IAM_USERS.map((user) => roleRow(user, true)) : []),
    ],
    ancestors: [
      ...chains.map((r) => ancestorRow(r.migrator, r.owner)),
      ...(cloud
        ? [
            ancestorRow(IAM_A, A.app),
            ancestorRow(IAM_B, B.app),
            ...chains.flatMap((r) => [
              ancestorRow(IAM_JOB, r.migrator),
              ancestorRow(IAM_JOB, r.owner, { via: r.migrator }),
            ]),
          ]
        : []),
    ],
    schemas: chains.map((r) => ({ nspname: r.schema, owner: r.owner, acl: [`${r.owner}=UC/${r.owner}`, `${r.app}=U/${r.owner}`] })),
    create: {},
  };
}

/** Rows `catalog` holds for one of the assertion queries; throws on any other query. */
function rowsFor(catalog: Catalog, text: string, values: unknown[] | undefined): unknown[] {
  if (text.includes('has_schema_privilege')) return catalog.create[String(values?.[0])] ?? [{ can_create: false }];
  if (text.includes('pg_auth_members')) return catalog.ancestors;
  if (text.includes('pg_namespace')) return catalog.schemas;
  if (text.includes('pg_roles')) return catalog.roles;
  throw new Error(`unexpected query: ${text}`);
}

/** A SqlClient that records every query and answers it from `catalog`. */
function fakeClient(catalog: Catalog): { client: SqlClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: SqlClient = {
    query(text, values) {
      calls.push({ text, values });
      return Promise.resolve().then(() => ({ rows: rowsFor(catalog, text, values) }));
    },
  };
  return { client, calls };
}

function input(target: 'local' | 'cloud', iamUsers?: readonly string[]): RoleAssertionInput {
  return { roles: [A, B], target, iamUsers };
}

function role(catalog: Catalog, name: string): RoleRow {
  const row = catalog.roles.find((r) => r.rolname === name);
  if (row === undefined) throw new Error(`no role row ${name}`);
  return row;
}

function schema(catalog: Catalog, name: string): SchemaRow {
  const row = catalog.schemas.find((s) => s.nspname === name);
  if (row === undefined) throw new Error(`no schema row ${name}`);
  return row;
}

describe('role names and quoting', () => {
  it('derives the owner, app and migrator roles of a schema', () => {
    expect(rolesFor('people')).toEqual({
      schema: 'people',
      owner: 'people_owner',
      app: 'people_app',
      migrator: 'people_migrator',
    });
  });

  it('lists owner, app and migrator of every schema in list order', () => {
    expect(allRoleNames([A, B])).toEqual([
      'alpha_owner',
      'alpha_app',
      'alpha_migrator',
      'beta_owner',
      'beta_app',
      'beta_migrator',
    ]);
    expect(allRoleNames([])).toEqual([]);
  });

  it.each([
    ['alpha_owner', '"alpha_owner"'],
    ['Mixed Case', '"Mixed Case"'],
    ['a"b""c', '"a""b""""c"'],
  ])('quotes identifier %j as %s', (name, expected) => {
    expect(quoteIdent(name)).toBe(expected);
  });

  it.each([
    ['', 'SQL identifier must not be empty'],
    ['a\0b', 'SQL identifier must not contain a NUL character'],
  ])('rejects identifier %j', (name, message) => {
    expect(() => quoteIdent(name)).toThrow(message);
  });

  it.each([
    ['plain', "'plain'"],
    ["o'brien", "'o''brien'"],
    ['', "''"],
  ])('quotes literal %j as %s', (value, expected) => {
    expect(quoteLiteral(value)).toBe(expected);
  });

  it('rejects a literal with a NUL character without echoing it', () => {
    expect(() => quoteLiteral(`${APP_SECRET}\0`)).toThrow(/^SQL literal must not contain a NUL character$/);
  });

  it.each([
    ['a CREATE ROLE password', `CREATE ROLE "x" LOGIN PASSWORD '${APP_SECRET}'`, `CREATE ROLE "x" LOGIN PASSWORD '***'`],
    ['an escaped quote', `PASSWORD 'a''${APP_SECRET}' VALID UNTIL 'infinity'`, `PASSWORD '***' VALID UNTIL 'infinity'`],
    [
      'several passwords in any case',
      `password '${APP_SECRET}'; ALTER ROLE y PASSWORD\n'${MIGRATOR_SECRET}'`,
      `PASSWORD '***'; ALTER ROLE y PASSWORD '***'`,
    ],
    ['an unterminated literal', `PASSWORD '${APP_SECRET}`, `PASSWORD '***'`],
    ['text without a password clause', "SELECT 'PASSWORD' AS word, passwords FROM t", "SELECT 'PASSWORD' AS word, passwords FROM t"],
  ])('redacts %s', (_label, sql, expected) => {
    expect(redactSql(sql)).toBe(expected);
  });

  it('sets createrole_self_grant to set, inherit', () => {
    expect(CREATEROLE_SELF_GRANT_SQL).toBe("SET createrole_self_grant = 'set, inherit'");
  });
});

describe('role and schema statements', () => {
  it('creates a NOLOGIN owner and LOGIN app and migrator roles with passwords locally', () => {
    const statements = createRolesSql(A, LOCAL);
    expect(statements).toEqual([
      'CREATE ROLE "alpha_owner" NOLOGIN NOSUPERUSER NOBYPASSRLS',
      `CREATE ROLE "alpha_app" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${APP_SECRET}'`,
      `CREATE ROLE "alpha_migrator" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${MIGRATOR_SECRET}'`,
    ]);
    expect(statements.map(redactSql).join('\n')).not.toContain('sample-value');
  });

  it('creates three NOLOGIN roles in the cloud', () => {
    expect(createRolesSql(B, { kind: 'cloud' })).toEqual([
      'CREATE ROLE "beta_owner" NOLOGIN NOSUPERUSER NOBYPASSRLS',
      'CREATE ROLE "beta_app" NOLOGIN NOSUPERUSER NOBYPASSRLS',
      'CREATE ROLE "beta_migrator" NOLOGIN NOSUPERUSER NOBYPASSRLS',
    ]);
  });

  it('escapes quotes in a generated password', () => {
    expect(createRolesSql(A, { kind: 'local', appPassword: "a'b", migratorPassword: 'c' })[1]).toBe(
      `CREATE ROLE "alpha_app" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'a''b'`,
    );
  });

  it.each([
    ['no role exists', [], ['alpha_owner', 'alpha_app', 'alpha_migrator']],
    ['the owner exists', ['alpha_owner'], ['alpha_app', 'alpha_migrator']],
    ['app and migrator exist', ['alpha_app', 'alpha_migrator', 'other_role'], ['alpha_owner']],
    ['every role exists', ['alpha_owner', 'alpha_app', 'alpha_migrator'], []],
  ])('creates only missing roles when %s', (_label, existing, created) => {
    const statements = createRolesSql(A, { kind: 'cloud' }, new Set(existing));
    expect(statements).toEqual(created.map((name) => `CREATE ROLE "${name}" NOLOGIN NOSUPERUSER NOBYPASSRLS`));
  });

  it.each([
    [false, 'CREATE SCHEMA "alpha" AUTHORIZATION "alpha_owner"'],
    [true, 'CREATE SCHEMA IF NOT EXISTS "alpha" AUTHORIZATION "alpha_owner"'],
  ])('creates the schema owned by its owner (ifNotExists %s)', (ifNotExists, expected) => {
    expect(createSchemaSql(A, { ifNotExists })).toEqual([expected]);
  });

  it('grants the owner to the migrator and revokes PUBLIC from the schema', () => {
    expect(roleChainSql(A)).toEqual(['GRANT "alpha_owner" TO "alpha_migrator"', 'REVOKE ALL ON SCHEMA "alpha" FROM PUBLIC']);
  });

  it('grants a role to an IAM user', () => {
    expect(grantRoleToSql(A.app, IAM_A)).toBe(`GRANT "alpha_app" TO "${IAM_A}"`);
  });

  it('refuses to grant cloudsqlsuperuser', () => {
    expect(() => grantRoleToSql('cloudsqlsuperuser', IAM_JOB)).toThrow('refusing to grant cloudsqlsuperuser');
  });

  it.each([
    ['every role exists', ['alpha_app', 'alpha_migrator', 'alpha_owner'], ['DROP OWNED BY "alpha_owner", "alpha_app", "alpha_migrator"']],
    ['only the app role exists', ['alpha_app', 'beta_app'], ['DROP OWNED BY "alpha_app"']],
    ['no role exists', [], []],
  ])('drops the schema, owned objects and roles when %s', (_label, existing, dropOwned) => {
    expect(dropLocalSql(A, new Set(existing))).toEqual([
      'DROP SCHEMA IF EXISTS "alpha" CASCADE',
      ...dropOwned,
      'DROP ROLE IF EXISTS "alpha_app"',
      'DROP ROLE IF EXISTS "alpha_migrator"',
      'DROP ROLE IF EXISTS "alpha_owner"',
    ]);
  });
});

describe('privilege statements', () => {
  it.each([
    ['alpha_owner', 'SET ROLE "alpha_owner"'],
    ['a"b', 'SET ROLE "a""b"'],
  ])('sets role %j', (name, expected) => {
    expect(setRoleSql(name)).toBe(expected);
  });

  it('resets the session role', () => {
    expect(RESET_ROLE_SQL).toBe('RESET ROLE');
  });

  it('grants the app role DML on future tables, sequence use and schema USAGE', () => {
    expect(defaultPrivilegesSql(A)).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE "alpha_owner" IN SCHEMA "alpha" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "alpha_app"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "alpha_owner" IN SCHEMA "alpha" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "alpha_app"',
      'GRANT USAGE ON SCHEMA "alpha" TO "alpha_app"',
    ]);
  });

  it('grants the app role the same rights on existing tables and sequences', () => {
    expect(postMigrationGrantsSql(B)).toEqual([
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "beta" TO "beta_app"',
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "beta" TO "beta_app"',
    ]);
  });
});

describe('assertRoles', () => {
  it('finds nothing in a sound local chain and only reads the catalog', async () => {
    const { client, calls } = fakeClient(soundCatalog('local'));
    expect(await assertRoles(client, input('local'))).toEqual([]);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => /^(SELECT|WITH)\b/.test(call.text))).toBe(true);
    expect(calls[0]?.values).toEqual([allRoleNames([A, B])]);
    expect(calls[1]?.values).toEqual([allRoleNames([A, B])]);
    expect(calls[2]?.values).toEqual([['alpha', 'beta']]);
    expect(calls.slice(3).map((call) => call.values)).toEqual([
      ['alpha_app', 'alpha'],
      ['beta_app', 'beta'],
    ]);
  });

  it('finds nothing in a sound cloud chain and checks each IAM user once', async () => {
    const { client, calls } = fakeClient(soundCatalog('cloud'));
    expect(await assertRoles(client, input('cloud', [IAM_A, IAM_A, IAM_B, IAM_JOB]))).toEqual([]);
    expect(calls[0]?.values).toEqual([[...allRoleNames([A, B]), ...IAM_USERS]]);
  });

  it('checks only the role sets of a cloud target without IAM users', async () => {
    const { client, calls } = fakeClient(soundCatalog('cloud'));
    expect(await assertRoles(client, input('cloud'))).toEqual([]);
    expect(calls[0]?.values).toEqual([allRoleNames([A, B])]);
  });

  it('ignores IAM users on a local target', async () => {
    const { client, calls } = fakeClient(soundCatalog('local'));
    expect(await assertRoles(client, input('local', IAM_USERS))).toEqual([]);
    expect(calls[0]?.values).toEqual([allRoleNames([A, B])]);
  });

  it('keeps the NOLOGIN check of a role also passed as an IAM user', async () => {
    const catalog = soundCatalog('cloud');
    role(catalog, A.app).rolcanlogin = true;
    const { client } = fakeClient(catalog);
    expect(await assertRoles(client, input('cloud', [...IAM_USERS, A.app]))).toEqual([
      finding('login-attribute', 'alpha_app', 'is LOGIN, expected NOLOGIN'),
    ]);
  });

  interface CatalogCase {
    name: string;
    target: 'local' | 'cloud';
    change: (catalog: Catalog) => void;
    expected: Finding[];
  }

  it.each<CatalogCase>([
    {
      name: 'a missing role',
      target: 'local',
      change: (c) => {
        c.roles = c.roles.filter((r) => r.rolname !== A.app);
      },
      expected: [finding('missing-role', 'alpha_app', 'role does not exist')],
    },
    {
      name: 'a missing IAM user',
      target: 'cloud',
      change: (c) => {
        c.roles = c.roles.filter((r) => r.rolname !== IAM_B);
      },
      expected: [finding('missing-role', IAM_B, 'IAM database user does not exist')],
    },
    {
      name: 'a SUPERUSER role',
      target: 'local',
      change: (c) => {
        role(c, A.owner).rolsuper = true;
      },
      expected: [finding('superuser', 'alpha_owner', 'has SUPERUSER')],
    },
    {
      name: 'a BYPASSRLS role',
      target: 'cloud',
      change: (c) => {
        role(c, B.migrator).rolbypassrls = true;
      },
      expected: [finding('bypassrls', 'beta_migrator', 'has BYPASSRLS')],
    },
    {
      name: 'an owner role with LOGIN',
      target: 'local',
      change: (c) => {
        role(c, A.owner).rolcanlogin = true;
      },
      expected: [finding('login-attribute', 'alpha_owner', 'is LOGIN, expected NOLOGIN')],
    },
    {
      name: 'a local app role without LOGIN',
      target: 'local',
      change: (c) => {
        role(c, A.app).rolcanlogin = false;
      },
      expected: [finding('login-attribute', 'alpha_app', 'is NOLOGIN, expected LOGIN')],
    },
    {
      name: 'a cloud migrator role with LOGIN',
      target: 'cloud',
      change: (c) => {
        role(c, B.migrator).rolcanlogin = true;
      },
      expected: [finding('login-attribute', 'beta_migrator', 'is LOGIN, expected NOLOGIN')],
    },
    {
      name: 'an IAM user without LOGIN, whose login attribute is not checked',
      target: 'cloud',
      change: (c) => {
        role(c, IAM_A).rolcanlogin = false;
      },
      expected: [],
    },
    {
      name: 'direct membership of a SUPERUSER role',
      target: 'local',
      change: (c) => {
        c.ancestors.push(ancestorRow(A.app, ROOT, { rolsuper: true }));
      },
      expected: [finding('privileged-membership', 'alpha_app', `member of ${ROOT}, which has SUPERUSER`)],
    },
    {
      name: 'indirect membership of a SUPERUSER and BYPASSRLS role',
      target: 'local',
      change: (c) => {
        c.ancestors.push(ancestorRow(A.migrator, ROOT, { via: A.owner, rolsuper: true, rolbypassrls: true }));
      },
      expected: [
        finding('privileged-membership', 'alpha_migrator', `member of ${ROOT} via alpha_owner, which has SUPERUSER and BYPASSRLS`),
      ],
    },
    {
      name: 'membership of a BYPASSRLS role reported without a first hop',
      target: 'local',
      change: (c) => {
        c.ancestors.push(ancestorRow(B.app, ROOT, { via: null, rolbypassrls: true }));
      },
      expected: [finding('privileged-membership', 'beta_app', `member of ${ROOT}, which has BYPASSRLS`)],
    },
    {
      name: 'one membership per ancestor, preferring a direct grant listed last',
      target: 'local',
      change: (c) => {
        c.ancestors.push(ancestorRow(A.app, ROOT, { via: 'hop_z', rolsuper: true }), ancestorRow(A.app, ROOT, { rolsuper: true }));
      },
      expected: [finding('privileged-membership', 'alpha_app', `member of ${ROOT}, which has SUPERUSER`)],
    },
    {
      name: 'one membership per ancestor, keeping a direct grant listed first',
      target: 'local',
      change: (c) => {
        c.ancestors.push(ancestorRow(A.app, ROOT, { rolsuper: true }), ancestorRow(A.app, ROOT, { via: 'hop_a', rolsuper: true }));
      },
      expected: [finding('privileged-membership', 'alpha_app', `member of ${ROOT}, which has SUPERUSER`)],
    },
    {
      name: 'one membership per ancestor, through the lowest first hop',
      target: 'local',
      change: (c) => {
        c.ancestors.push(
          ancestorRow(A.app, ROOT, { via: 'hop_b', rolsuper: true }),
          ancestorRow(A.app, ROOT, { via: 'hop_a', rolsuper: true }),
          ancestorRow(A.app, ROOT, { via: 'hop_c', rolsuper: true }),
        );
      },
      expected: [finding('privileged-membership', 'alpha_app', `member of ${ROOT} via hop_a, which has SUPERUSER`)],
    },
    {
      name: 'ancestors of roles outside the checked set, which are ignored',
      target: 'local',
      change: (c) => {
        c.ancestors.push(ancestorRow('bootstrap_admin', ROOT, { rolsuper: true }));
      },
      expected: [],
    },
    {
      name: 'cloudsqlsuperuser membership of an IAM user',
      target: 'cloud',
      change: (c) => {
        c.ancestors.push(ancestorRow(IAM_A, 'cloudsqlsuperuser'));
      },
      expected: [finding('cloudsqlsuperuser-membership', IAM_A, 'member of cloudsqlsuperuser')],
    },
    {
      name: 'indirect cloudsqlsuperuser membership',
      target: 'cloud',
      change: (c) => {
        c.ancestors.push(ancestorRow(IAM_JOB, 'cloudsqlsuperuser', { via: A.migrator }));
      },
      expected: [finding('cloudsqlsuperuser-membership', IAM_JOB, 'member of cloudsqlsuperuser via alpha_migrator')],
    },
    {
      name: 'cloudsqlsuperuser membership on a local target, which is not checked',
      target: 'local',
      change: (c) => {
        c.ancestors.push(ancestorRow(A.app, 'cloudsqlsuperuser'));
      },
      expected: [],
    },
    {
      name: 'an app role that is a member of its owner',
      target: 'local',
      change: (c) => {
        c.ancestors.push(ancestorRow(A.app, A.owner));
      },
      expected: [finding('app-owner-membership', 'alpha_app', 'member of alpha_owner')],
    },
    {
      name: 'an app role that reaches its owner through the migrator',
      target: 'cloud',
      change: (c) => {
        c.ancestors.push(ancestorRow(B.app, B.migrator), ancestorRow(B.app, B.owner, { via: B.migrator }));
      },
      expected: [finding('app-owner-membership', 'beta_app', 'member of beta_owner via beta_migrator')],
    },
    {
      name: 'an app role with CREATE on its schema',
      target: 'local',
      change: (c) => {
        c.create[A.app] = [{ can_create: true }];
      },
      expected: [finding('app-create-privilege', 'alpha_app', 'can CREATE in schema alpha')],
    },
    {
      name: 'an empty has_schema_privilege result',
      target: 'local',
      change: (c) => {
        c.create[B.app] = [];
      },
      expected: [],
    },
    {
      name: 'a missing schema',
      target: 'local',
      change: (c) => {
        c.schemas = c.schemas.filter((s) => s.nspname !== B.schema);
      },
      expected: [finding('missing-schema', 'beta', 'schema does not exist')],
    },
    {
      name: 'a schema owned by another role',
      target: 'local',
      change: (c) => {
        schema(c, A.schema).owner = A.migrator;
      },
      expected: [finding('schema-owner', 'alpha', 'owned by alpha_migrator, expected alpha_owner')],
    },
    {
      name: 'a PUBLIC privilege on a schema',
      target: 'cloud',
      change: (c) => {
        schema(c, B.schema).acl?.push('=U/beta_owner');
      },
      expected: [finding('schema-public-privilege', 'beta', 'PUBLIC holds =U/beta_owner')],
    },
    {
      name: 'a schema with the default ACL',
      target: 'local',
      change: (c) => {
        schema(c, A.schema).acl = null;
      },
      expected: [],
    },
  ])('reports exactly the defects of $name', async ({ target, change, expected }) => {
    const catalog = soundCatalog(target);
    change(catalog);
    const { client } = fakeClient(catalog);
    expect(await assertRoles(client, input(target, target === 'cloud' ? IAM_USERS : undefined))).toEqual(expected);
  });

  it('skips the CREATE check of a missing app role and of a missing schema', async () => {
    const catalog = soundCatalog('local');
    catalog.roles = catalog.roles.filter((r) => r.rolname !== A.app);
    catalog.schemas = catalog.schemas.filter((s) => s.nspname !== B.schema);
    const { client, calls } = fakeClient(catalog);
    await assertRoles(client, input('local'));
    expect(calls.filter((call) => call.text.includes('has_schema_privilege'))).toEqual([]);
  });

  it('sorts findings by subject, then kind, then detail', async () => {
    const catalog = soundCatalog('local');
    Object.assign(role(catalog, B.app), { rolsuper: true, rolbypassrls: true, rolcanlogin: false });
    role(catalog, A.owner).rolsuper = true;
    schema(catalog, A.schema).acl = ['=U/alpha_owner', '=C/alpha_owner'];
    const { client } = fakeClient(catalog);
    expect(await assertRoles(client, input('local'))).toEqual([
      finding('schema-public-privilege', 'alpha', 'PUBLIC holds =C/alpha_owner'),
      finding('schema-public-privilege', 'alpha', 'PUBLIC holds =U/alpha_owner'),
      finding('superuser', 'alpha_owner', 'has SUPERUSER'),
      finding('bypassrls', 'beta_app', 'has BYPASSRLS'),
      finding('login-attribute', 'beta_app', 'is NOLOGIN, expected LOGIN'),
      finding('superuser', 'beta_app', 'has SUPERUSER'),
    ]);
  });

  it('propagates a catalog query failure', async () => {
    const failure = new Error('permission denied for table pg_authid');
    const client: SqlClient = { query: () => Promise.reject(failure) };
    await expect(assertRoles(client, input('local'))).rejects.toBe(failure);
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
const created: SchemaRoles[] = [];

/** Runs `work` on a fresh randomly named role set inside one transaction that is always rolled back. */
async function inRolledBackTransaction(work: (client: pg.Client, roles: SchemaRoles) => Promise<void>): Promise<void> {
  const roles = rolesFor(`t_dbb_${randomBytes(4).toString('hex')}`);
  created.push(roles);
  const client = new pg.Client(PG_CONFIG);
  await client.connect();
  try {
    await client.query('BEGIN');
    await work(client, roles);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
}

/** Creates the local role chain, a migrated table and its grants, in bootstrap order. */
async function bootstrapChain(client: pg.Client, roles: SchemaRoles): Promise<void> {
  const mode: RoleMode = {
    kind: 'local',
    appPassword: randomBytes(18).toString('base64url'),
    migratorPassword: randomBytes(18).toString('base64url'),
  };
  for (const statement of [
    CREATEROLE_SELF_GRANT_SQL,
    ...createRolesSql(roles, mode),
    ...createSchemaSql(roles, { ifNotExists: false }),
    ...roleChainSql(roles),
    setRoleSql(roles.owner),
    ...defaultPrivilegesSql(roles),
    `CREATE TABLE ${quoteIdent(roles.schema)}.note (id serial PRIMARY KEY)`,
    ...postMigrationGrantsSql(roles),
    RESET_ROLE_SQL,
  ]) {
    await client.query(statement);
  }
}

describe.skipIf(!available)('db-bootstrap against PostgreSQL', () => {
  it('builds a local role chain in which assertRoles finds nothing', async () => {
    await inRolledBackTransaction(async (client, roles) => {
      await bootstrapChain(client, roles);
      expect(await assertRoles(client, { roles: [roles], target: 'local' })).toEqual([]);
    });
  });

  it('reports defects injected into a real chain', async () => {
    await inRolledBackTransaction(async (client, roles) => {
      await bootstrapChain(client, roles);
      for (const statement of [
        `GRANT USAGE ON SCHEMA ${quoteIdent(roles.schema)} TO PUBLIC`,
        `GRANT CREATE ON SCHEMA ${quoteIdent(roles.schema)} TO ${quoteIdent(roles.app)}`,
        grantRoleToSql(roles.migrator, roles.app),
        `ALTER ROLE ${quoteIdent(roles.owner)} LOGIN`,
      ]) {
        await client.query(statement);
      }
      expect(await assertRoles(client, { roles: [roles], target: 'local' })).toEqual([
        finding('schema-public-privilege', roles.schema, `PUBLIC holds =U/${roles.owner}`),
        finding('app-create-privilege', roles.app, `can CREATE in schema ${roles.schema}`),
        finding('app-owner-membership', roles.app, `member of ${roles.owner} via ${roles.migrator}`),
        finding('login-attribute', roles.owner, 'is LOGIN, expected NOLOGIN'),
      ]);
    });
  });

  it('drops the schema and every role of a local chain', async () => {
    await inRolledBackTransaction(async (client, roles) => {
      await bootstrapChain(client, roles);
      const { rows } = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [
        allRoleNames([roles]),
      ]);
      for (const statement of dropLocalSql(roles, new Set(rows.map((row) => row.rolname)))) {
        await client.query(statement);
      }
      expect(await assertRoles(client, { roles: [roles], target: 'local' })).toEqual([
        finding('missing-schema', roles.schema, 'schema does not exist'),
        finding('missing-role', roles.app, 'role does not exist'),
        finding('missing-role', roles.migrator, 'role does not exist'),
        finding('missing-role', roles.owner, 'role does not exist'),
      ]);
    });
  });

  it('leaves no role or schema of this run behind', async () => {
    const client = new pg.Client(PG_CONFIG);
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string }>(
        'SELECT rolname AS name FROM pg_roles WHERE rolname = ANY($1::text[]) UNION ALL SELECT nspname FROM pg_namespace WHERE nspname = ANY($2::text[])',
        [allRoleNames(created), created.map((roles) => roles.schema)],
      );
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
