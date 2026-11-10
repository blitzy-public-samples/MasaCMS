/** Minimal query surface the bootstrap steps use; `pg.Client` satisfies it. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** The three role names that own, use and migrate one OPT-2 schema. */
export interface SchemaRoles {
  schema: string;
  owner: string;
  app: string;
  migrator: string;
}

/** Login form of the app and migrator roles: password logins locally, IAM group roles in the cloud. */
export type RoleMode = { kind: 'local'; appPassword: string; migratorPassword: string } | { kind: 'cloud' };

/**
 * Run on the admin session before any CREATE ROLE. PostgreSQL 16 gives a non-superuser CREATEROLE creator only
 * ADMIN on roles it creates: SET lets it run CREATE SCHEMA … AUTHORIZATION <owner>, and INHERIT lets a later local
 * reset drop that owner's schema and objects (DROP SCHEMA and DROP OWNED BY need the owner's privileges).
 */
export const CREATEROLE_SELF_GRANT_SQL = "SET createrole_self_grant = 'set, inherit'";

const NO_PRIVILEGE = 'NOSUPERUSER NOBYPASSRLS';
const PASSWORD_LITERAL = /\bPASSWORD\s+'(?:[^']|'')*(?:'|$)/gi;

/** Derives the owner, app and migrator role names of a schema. */
export function rolesFor(schema: string): SchemaRoles {
  return { schema, owner: `${schema}_owner`, app: `${schema}_app`, migrator: `${schema}_migrator` };
}

/** Lists owner, app and migrator of every schema, in list order. */
export function allRoleNames(list: readonly SchemaRoles[]): string[] {
  return list.flatMap((roles) => [roles.owner, roles.app, roles.migrator]);
}

/** Quotes a PostgreSQL identifier; throws on an empty name or a NUL character. */
export function quoteIdent(name: string): string {
  if (name.length === 0) throw new Error('SQL identifier must not be empty');
  if (name.includes('\0')) throw new Error('SQL identifier must not contain a NUL character');
  return `"${name.replaceAll('"', '""')}"`;
}

/** Quotes a standard-conforming string literal; throws on a NUL character without echoing the value. */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('SQL literal must not contain a NUL character');
  return `'${value.replaceAll("'", "''")}'`;
}

/** Masks every `PASSWORD '…'` literal, so SQL text can reach logs and error messages. */
export function redactSql(text: string): string {
  return text.replace(PASSWORD_LITERAL, "PASSWORD '***'");
}

function createRoleSql(name: string, password: string | undefined): string {
  return password === undefined
    ? `CREATE ROLE ${quoteIdent(name)} NOLOGIN ${NO_PRIVILEGE}`
    : `CREATE ROLE ${quoteIdent(name)} LOGIN ${NO_PRIVILEGE} PASSWORD ${quoteLiteral(password)}`;
}

/** CREATE ROLE statements for the schema's roles not in `existing`; existing roles are left unaltered. */
export function createRolesSql(
  roles: SchemaRoles,
  mode: RoleMode,
  existing: ReadonlySet<string> = new Set(),
): string[] {
  const wanted: [string, string | undefined][] = [
    [roles.owner, undefined],
    [roles.app, mode.kind === 'local' ? mode.appPassword : undefined],
    [roles.migrator, mode.kind === 'local' ? mode.migratorPassword : undefined],
  ];
  return wanted.filter(([name]) => !existing.has(name)).map(([name, password]) => createRoleSql(name, password));
}

/** Creates the schema owned by its owner role. */
export function createSchemaSql(roles: SchemaRoles, opts: { ifNotExists: boolean }): string[] {
  const ifNotExists = opts.ifNotExists ? 'IF NOT EXISTS ' : '';
  return [`CREATE SCHEMA ${ifNotExists}${quoteIdent(roles.schema)} AUTHORIZATION ${quoteIdent(roles.owner)}`];
}

/** Lets the migrator become the owner and removes PUBLIC's rights on the schema. */
export function roleChainSql(roles: SchemaRoles): string[] {
  return [
    `GRANT ${quoteIdent(roles.owner)} TO ${quoteIdent(roles.migrator)}`,
    `REVOKE ALL ON SCHEMA ${quoteIdent(roles.schema)} FROM PUBLIC`,
  ];
}

/** Grants membership of `role` to `grantee`, such as a Cloud SQL IAM user; refuses to grant cloudsqlsuperuser. */
export function grantRoleToSql(role: string, grantee: string): string {
  if (role === 'cloudsqlsuperuser') throw new Error('refusing to grant cloudsqlsuperuser');
  return `GRANT ${quoteIdent(role)} TO ${quoteIdent(grantee)}`;
}

/** Drops the schema, then the objects and the roles of the schema's role set; local reset only. */
export function dropLocalSql(roles: SchemaRoles, existing: ReadonlySet<string>): string[] {
  const present = [roles.owner, roles.app, roles.migrator].filter((name) => existing.has(name));
  return [
    `DROP SCHEMA IF EXISTS ${quoteIdent(roles.schema)} CASCADE`,
    ...(present.length > 0 ? [`DROP OWNED BY ${present.map((name) => quoteIdent(name)).join(', ')}`] : []),
    ...[roles.app, roles.migrator, roles.owner].map((name) => `DROP ROLE IF EXISTS ${quoteIdent(name)}`),
  ];
}
