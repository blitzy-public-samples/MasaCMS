import { readFile } from 'node:fs/promises';
import { AuthTypes, Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { serviceAccountEmail } from '@opt2/platform/auth';
import type { Logger } from '@opt2/platform/logging';
import { iamDbUser } from '@opt2/platform/tenancy';
import pg from 'pg';
import type { MigrationConfig, OwnerName } from '../config.js';
import { migrationsDirFor, stateDirPath } from '../paths.js';
import { assertRoles, type Finding, type RoleAssertionInput } from './assertions.js';
import { missingForTarget, type BootstrapEnv, type BootstrapTarget } from './env.js';
import {
  applyMigrations,
  assertSchemasEmpty,
  listMigrationFiles,
  resetLocalSchemas,
  type MigrationFile,
} from './migrations.js';
import { defaultPrivilegesSql, postMigrationGrantsSql, RESET_ROLE_SQL, setRoleSql } from './privileges.js';
import {
  allRoleNames,
  CREATEROLE_SELF_GRANT_SQL,
  createRolesSql,
  createSchemaSql,
  grantRoleToSql,
  redactSql,
  roleChainSql,
  rolesFor,
  type SchemaRoles,
  type SqlClient,
} from './roles.js';

/** One OPT-2 schema owner: its configuration name, schema, repository-relative package and role names. */
export interface BootstrapOwner {
  name: string;
  schema: string;
  package: string;
  roles: SchemaRoles;
}

/** How `BootstrapDeps.connect` logs in: as the admin, as a local password role, or as a Cloud SQL IAM user. */
export type ConnectSpec = { kind: 'admin' } | { kind: 'role'; user: string; password: string } | { kind: 'iam'; user: string };

/** An open database session the bootstrap ends once it is done with it. */
export interface ConnectedClient extends SqlClient {
  end(): Promise<void>;
}

/** Side effects of the bootstrap; the defaults reach PostgreSQL or Cloud SQL, and tests inject fakes. */
export interface BootstrapDeps {
  connect(spec: ConnectSpec): Promise<ConnectedClient>;
  readSecret(path: string): Promise<string>;
  migrationsDir(packageRel: string): string;
  close?(): Promise<void>;
}

/** One migrated schema: its name, its owner's configuration name and the number of migration files applied. */
export interface SchemaSummary {
  schema: string;
  owner: string;
  migrations: number;
}

/** Outcome of `bootstrap`: `roles` counts the roles it created, and `ok` is false when the role assertions found a defect. */
export interface BootstrapSummary {
  command: 'bootstrap';
  target: BootstrapTarget;
  ok: boolean;
  schemas: SchemaSummary[];
  roles: number;
  iamGrants: number;
  findings: Finding[];
}

/** Options of `bootstrap`. */
export interface BootstrapOptions {
  target: BootstrapTarget;
  env: BootstrapEnv;
  config: Pick<MigrationConfig, 'owners' | 'cloud'>;
  logger: Logger;
  /** Replaces the connections, secret reads and migration directories built for `target`. */
  deps?: BootstrapDeps;
}

/** The environment lacks variables the target needs; the message names them, never their values. */
export class BootstrapEnvError extends Error {
  override readonly name = 'BootstrapEnvError';
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`db-bootstrap needs ${missing.join(', ')}`);
    this.missing = [...missing];
  }
}

/** Cloud SQL IAM database users the grants need do not exist; Terraform's `google_sql_user` creates them. */
export class MissingIamUserError extends Error {
  override readonly name = 'MissingIamUserError';
  readonly users: readonly string[];

  constructor(users: readonly string[]) {
    super(`Cloud SQL IAM database users do not exist: ${users.join(', ')}`);
    this.users = [...users];
  }
}

/** A role password file is missing, unreadable or empty; the message names the file, never its contents. */
export class SecretFileError extends Error {
  override readonly name = 'SecretFileError';
  readonly file: string;

  constructor(file: string, reason: string, options?: ErrorOptions) {
    super(`secret file ${file} ${reason}`, options);
    this.file = file;
  }
}

/** A bootstrap statement failed; `statement` and the message carry its text with every password masked. */
export class BootstrapStatementError extends Error {
  override readonly name = 'BootstrapStatementError';
  readonly statement: string;

  constructor(statement: string, cause: unknown) {
    const redacted = redactSql(statement);
    super(`bootstrap statement failed: ${redacted}: ${redactSql(messageOf(cause))}`, { cause });
    this.statement = redacted;
  }
}

/** Environment of a target once `missingForTarget` has confirmed that its variables are set. */
type EnvWith<K extends keyof BootstrapEnv> = BootstrapEnv & { [P in K]-?: NonNullable<BootstrapEnv[P]> };
type LocalEnv = EnvWith<'PG_HOST' | 'PG_PORT' | 'PG_DATABASE' | 'PG_USER' | 'PG_PASSWORD' | 'OPT2_STATE_DIR'>;
type CloudEnv = EnvWith<'PG_DATABASE' | 'CLOUD_SQL_INSTANCE' | 'GOOGLE_CLOUD_PROJECT' | 'OPT2_CLOUDSQL_ADMIN_PASSWORD'>;

/** One owner together with the migration files it will apply. */
interface OwnerPlan {
  owner: BootstrapOwner;
  files: MigrationFile[];
}

// The stub is a local platform proof: it has no Cloud Run service, service account or Cloud SQL IAM user.
const NOT_DEPLOYED: ReadonlySet<string> = new Set<OwnerName>(['stub']);

const SERVER_VERSION_SQL = "SELECT current_setting('server_version_num')::int AS version";
// createrole_self_grant exists from PostgreSQL 16 on.
const SELF_GRANT_MIN_VERSION = 160000;
const ROLES_PRESENT_SQL = 'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])';
const TRAILING_NEWLINES = /(?:\r?\n)+$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  const code: unknown = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** The owners `target` bootstraps, in configuration order: every owner locally, the deployed ones in the cloud. */
export function bootstrapOwners(config: Pick<MigrationConfig, 'owners'>, target: BootstrapTarget): BootstrapOwner[] {
  return (Object.keys(config.owners) as OwnerName[])
    .filter((name) => target === 'local' || !NOT_DEPLOYED.has(name))
    .map((name) => {
      const { schema, package: packageRel } = config.owners[name];
      return { name, schema, package: packageRel, roles: rolesFor(schema) };
    });
}

/** Password files of a schema's app and migrator roles under `<stateDir>/secrets/`. */
export function secretPathsFor(stateDir: string, schema: string): { app: string; migrator: string } {
  return {
    app: stateDirPath(stateDir, 'secrets', `db-${schema}-app`),
    migrator: stateDirPath(stateDir, 'secrets', `db-${schema}-migrator`),
  };
}

/** Reads a password file without its trailing line breaks; throws `SecretFileError` when it is missing or empty. */
async function readSecretFile(file: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    const reason = code === 'ENOENT' ? 'does not exist' : `cannot be read (${code ?? messageOf(error)})`;
    throw new SecretFileError(file, reason, { cause: error });
  }
  const secret = text.replace(TRAILING_NEWLINES, '');
  if (secret.length === 0) throw new SecretFileError(file, 'is empty');
  return secret;
}

async function open(client: pg.Client): Promise<ConnectedClient> {
  await client.connect();
  return client;
}

function localDeps(env: LocalEnv): BootstrapDeps {
  const server = { host: env.PG_HOST, port: env.PG_PORT, database: env.PG_DATABASE };
  return {
    connect: async (spec) => {
      if (spec.kind === 'iam') throw new Error('IAM database logins need --target cloud');
      const login =
        spec.kind === 'admin'
          ? { user: env.PG_USER, password: env.PG_PASSWORD }
          : { user: spec.user, password: spec.password };
      return open(new pg.Client({ ...server, ...login }));
    },
    readSecret: readSecretFile,
    migrationsDir: migrationsDirFor,
  };
}

function cloudDeps(env: CloudEnv, adminUser: string): BootstrapDeps {
  const connector = new Connector();
  const instanceConnectionName = env.CLOUD_SQL_INSTANCE;
  return {
    connect: async (spec) => {
      if (spec.kind === 'role') throw new Error('password role logins need --target local');
      if (spec.kind === 'admin') {
        const options = await connector.getOptions({ instanceConnectionName, ipType: IpAddressTypes.PRIVATE });
        // Cloud SQL's built-in admin is a member of cloudsqlsuperuser, not a PostgreSQL superuser.
        return open(
          new pg.Client({ ...options, user: adminUser, password: env.OPT2_CLOUDSQL_ADMIN_PASSWORD, database: env.PG_DATABASE }),
        );
      }
      const options = await connector.getOptions({
        instanceConnectionName,
        ipType: IpAddressTypes.PRIVATE,
        authType: AuthTypes.IAM,
      });
      // No password: the connector authenticates the stream with short-lived IAM tokens of the job's service account.
      return open(new pg.Client({ ...options, user: spec.user, database: env.PG_DATABASE }));
    },
    readSecret: readSecretFile,
    migrationsDir: migrationsDirFor,
    close: async () => connector.close(),
  };
}

/** Runs `statements` in order; a failure is rethrown as `BootstrapStatementError` with passwords masked. */
async function exec(client: SqlClient, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    try {
      await client.query(statement);
    } catch (error) {
      throw new BootstrapStatementError(statement, error);
    }
  }
}

async function presentRoles(client: SqlClient, names: readonly string[]): Promise<Set<string>> {
  const { rows } = await client.query(ROLES_PRESENT_SQL, [[...names]]);
  return new Set(rows.map((row: { rolname: string }) => row.rolname));
}

async function selfGrantCreatedRoles(admin: SqlClient): Promise<void> {
  const { rows } = await admin.query(SERVER_VERSION_SQL);
  const version = Number((rows[0] as { version?: unknown } | undefined)?.version);
  if (version >= SELF_GRANT_MIN_VERSION) await exec(admin, [CREATEROLE_SELF_GRANT_SQL]);
}

/** Adds each owner's migration files before any DDL runs, so a missing or misnamed directory changes nothing. */
async function withMigrationFiles<T extends { owner: BootstrapOwner }>(
  items: readonly T[],
  deps: BootstrapDeps,
): Promise<(T & OwnerPlan)[]> {
  const plans: (T & OwnerPlan)[] = [];
  for (const item of items) {
    plans.push({ ...item, files: await listMigrationFiles(deps.migrationsDir(item.owner.package)) });
  }
  return plans;
}

/** Creates the owner's roles, then its schema and role chain, on the admin session; returns the roles created. */
async function createOwnerObjects(
  admin: SqlClient,
  owner: BootstrapOwner,
  roleStatements: readonly string[],
  ifNotExists: boolean,
  logger: Logger,
): Promise<number> {
  await exec(admin, [...roleStatements, ...createSchemaSql(owner.roles, { ifNotExists }), ...roleChainSql(owner.roles)]);
  logger.info(`created roles for ${owner.schema}`);
  return roleStatements.length;
}

/** On a migrator session: default privileges, the owner's migrations and the app grants, each as the schema owner. */
async function migrateOwner(client: SqlClient, plan: OwnerPlan, logger: Logger): Promise<SchemaSummary> {
  const { owner, files } = plan;
  await exec(client, [setRoleSql(owner.roles.owner), ...defaultPrivilegesSql(owner.roles), RESET_ROLE_SQL]);
  const migrations = await applyMigrations(client, owner.roles, files, logger);
  await exec(client, [setRoleSql(owner.roles.owner), ...postMigrationGrantsSql(owner.roles), RESET_ROLE_SQL]);
  logger.info(`migrated ${owner.schema}: ${migrations} files`);
  return { schema: owner.schema, owner: owner.name, migrations };
}

async function finish(
  admin: SqlClient,
  assertion: RoleAssertionInput,
  result: { schemas: SchemaSummary[]; roles: number; iamGrants: number },
  logger: Logger,
): Promise<BootstrapSummary> {
  const findings = await assertRoles(admin, assertion);
  if (findings.length > 0) logger.warn(`role assertions found ${findings.length} defects`);
  logger.info(`bootstrap finished: ${result.schemas.length} schemas`);
  return { command: 'bootstrap', target: assertion.target, ok: findings.length === 0, ...result, findings };
}

async function bootstrapLocal(
  env: LocalEnv,
  owners: readonly BootstrapOwner[],
  deps: BootstrapDeps,
  logger: Logger,
): Promise<BootstrapSummary> {
  const secrets: { owner: BootstrapOwner; appPassword: string; migratorPassword: string }[] = [];
  for (const owner of owners) {
    const files = secretPathsFor(env.OPT2_STATE_DIR, owner.schema);
    secrets.push({ owner, appPassword: await deps.readSecret(files.app), migratorPassword: await deps.readSecret(files.migrator) });
  }
  const plans = await withMigrationFiles(secrets, deps);
  const roles = owners.map((owner) => owner.roles);
  const admin = await deps.connect({ kind: 'admin' });
  try {
    await selfGrantCreatedRoles(admin);
    await resetLocalSchemas(admin, roles);
    logger.info(`reset ${owners.length} schemas and their roles`);
    let created = 0;
    for (const { owner, appPassword, migratorPassword } of plans) {
      const statements = createRolesSql(owner.roles, { kind: 'local', appPassword, migratorPassword });
      created += await createOwnerObjects(admin, owner, statements, false, logger);
    }
    const schemas: SchemaSummary[] = [];
    for (const plan of plans) {
      const migrator = await deps.connect({ kind: 'role', user: plan.owner.roles.migrator, password: plan.migratorPassword });
      try {
        schemas.push(await migrateOwner(migrator, plan, logger));
      } finally {
        await migrator.end();
      }
    }
    return await finish(admin, { roles, target: 'local' }, { schemas, roles: created, iamGrants: 0 }, logger);
  } finally {
    await admin.end();
  }
}

async function bootstrapCloud(
  env: CloudEnv,
  bootstrapAccount: string,
  owners: readonly BootstrapOwner[],
  deps: BootstrapDeps,
  logger: Logger,
): Promise<BootstrapSummary> {
  const project = env.GOOGLE_CLOUD_PROJECT;
  const deployed = owners.map((owner) => ({ owner, iamUser: iamDbUser(serviceAccountEmail(owner.name, project)) }));
  const plans = await withMigrationFiles(deployed, deps);
  const bootstrapUser = iamDbUser(serviceAccountEmail(bootstrapAccount, project));
  const iamUsers = [...deployed.map(({ iamUser }) => iamUser), bootstrapUser];
  const roles = owners.map((owner) => owner.roles);
  const admin = await deps.connect({ kind: 'admin' });
  try {
    await assertSchemasEmpty(admin, owners.map((owner) => owner.schema));
    const presentIam = await presentRoles(admin, iamUsers);
    const absent = iamUsers.filter((user) => !presentIam.has(user));
    if (absent.length > 0) throw new MissingIamUserError(absent);
    await selfGrantCreatedRoles(admin);
    const existing = await presentRoles(admin, allRoleNames(roles));
    let created = 0;
    for (const owner of owners) {
      created += await createOwnerObjects(admin, owner, createRolesSql(owner.roles, { kind: 'cloud' }, existing), true, logger);
    }
    const grants = plans.flatMap(({ owner, iamUser }) => [
      grantRoleToSql(owner.roles.app, iamUser),
      grantRoleToSql(owner.roles.migrator, bootstrapUser),
    ]);
    await exec(admin, grants);
    logger.info(`granted ${grants.length} roles to Cloud SQL IAM users`);
    const schemas: SchemaSummary[] = [];
    const migrator = await deps.connect({ kind: 'iam', user: bootstrapUser });
    try {
      for (const plan of plans) schemas.push(await migrateOwner(migrator, plan, logger));
    } finally {
      await migrator.end();
    }
    return await finish(admin, { roles, target: 'cloud', iamUsers }, { schemas, roles: created, iamGrants: grants.length }, logger);
  } finally {
    await admin.end();
  }
}

/**
 * Creates every OPT-2 schema with its owner, app and migrator roles and role chain, applies each package's
 * migrations as the schema owner, and checks the result with the role assertions.
 * Locally it first drops every OPT-2 schema and role; in the cloud it refuses schemas that already hold tables.
 * @param opts.target `local` (PostgreSQL with password roles) or `cloud` (Cloud SQL with IAM users).
 * @param opts.deps replaces the connections built for `target`.
 * @throws BootstrapEnvError, SecretFileError, SchemaNotEmptyError, MissingIamUserError, BootstrapStatementError,
 *   MigrationDirectoryError, MigrationFailedError or a connection error.
 */
export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapSummary> {
  const { target, env, config, logger } = opts;
  const missing = missingForTarget(env, target);
  if (missing.length > 0) throw new BootstrapEnvError(missing);
  const owners = bootstrapOwners(config, target);
  const deps =
    opts.deps ?? (target === 'local' ? localDeps(env as LocalEnv) : cloudDeps(env as CloudEnv, config.cloud.adminUser));
  try {
    return target === 'local'
      ? await bootstrapLocal(env as LocalEnv, owners, deps, logger)
      : await bootstrapCloud(env as CloudEnv, config.cloud.bootstrapAccount, owners, deps, logger);
  } finally {
    await deps.close?.();
  }
}
