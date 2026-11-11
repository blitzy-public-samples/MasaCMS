import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@opt2/platform/logging';
import { RESET_ROLE_SQL, setRoleSql } from './privileges.js';
import { allRoleNames, dropLocalSql, type SchemaRoles, type SqlClient } from './roles.js';

/** Name every file in a package's `db/migrations` must have: a four-digit sequence, `_`, a name, `.sql`. */
export const MIGRATION_FILE_PATTERN = /^\d{4}_[A-Za-z0-9_.-]+\.sql$/;

/** One migration file: its file name and absolute path. */
export interface MigrationFile {
  name: string;
  path: string;
}

/** A package's migration directory is missing, unreadable, empty, or holds a misnamed `.sql` file. */
export class MigrationDirectoryError extends Error {
  override readonly name = 'MigrationDirectoryError';
  readonly dir: string;
  readonly reason: string;

  constructor(dir: string, reason: string, options?: ErrorOptions) {
    super(`migration directory ${dir}: ${reason}`, options);
    this.dir = dir;
    this.reason = reason;
  }
}

/** A migration file could not be read, or failed and was rolled back; the message never holds the file's SQL. */
export class MigrationFailedError extends Error {
  override readonly name = 'MigrationFailedError';
  readonly schema: string;
  readonly file: string;
  /** SQLSTATE of the PostgreSQL error, when the database raised it. */
  readonly sqlState: string | undefined;
  /** 1-based character position of the error in the file, as PostgreSQL reports it. */
  readonly position: number | undefined;
  /** 1-based line of `position` in the file. */
  readonly line: number | undefined;

  constructor(schema: string, file: string, cause: unknown, line?: number) {
    const fromDatabase = isDatabaseError(cause);
    const sqlState = fromDatabase ? stringField(cause, 'code') : undefined;
    const position = fromDatabase ? positionOf(cause) : undefined;
    const located = position === undefined ? '' : ` at position ${position}${line === undefined ? '' : `, line ${line}`}`;
    const state = sqlState === undefined ? '' : ` (SQLSTATE ${sqlState})`;
    super(`migration ${schema}/${file} failed: ${messageOf(cause)}${state}${located}`, { cause });
    this.schema = schema;
    this.file = file;
    this.sqlState = sqlState;
    this.position = position;
    this.line = position === undefined ? undefined : line;
  }
}

/** Schemas the cloud bootstrap would migrate already hold tables. */
export class SchemaNotEmptyError extends Error {
  override readonly name = 'SchemaNotEmptyError';
  readonly schemas: readonly string[];

  constructor(schemas: readonly string[]) {
    super(`refusing to apply migrations: schemas already hold tables: ${schemas.join(', ')}`);
    this.schemas = [...schemas];
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** True for an error the server raised: `pg` sets `severity` on those, never on Node system errors, whose `code` is not a SQLSTATE. */
function isDatabaseError(cause: unknown): boolean {
  return stringField(cause, 'severity') !== undefined;
}

/** The 1-based `position` of a PostgreSQL error, which the driver reports as a decimal string. */
function positionOf(cause: unknown): number | undefined {
  const position = Number(stringField(cause, 'position'));
  return Number.isInteger(position) && position > 0 ? position : undefined;
}

/** Line of the 1-based character `position` in `text`, counting characters as PostgreSQL does (code points). */
function lineAt(text: string, position: number): number {
  let line = 1;
  let index = 1;
  for (const char of text) {
    if (index >= position) break;
    if (char === '\n') line += 1;
    index += 1;
  }
  return line;
}

function errorLine(cause: unknown, text: string): number | undefined {
  const position = isDatabaseError(cause) ? positionOf(cause) : undefined;
  return position === undefined ? undefined : lineAt(text, position);
}

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Lists the `.sql` migration files of `dir` in plain string order; throws `MigrationDirectoryError` if there are none or one is misnamed. */
export async function listMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const reason = stringField(error, 'code') === 'ENOENT' ? 'does not exist' : `cannot be read: ${messageOf(error)}`;
    throw new MigrationDirectoryError(dir, reason, { cause: error });
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort(compareNames);
  const misnamed = names.filter((name) => !MIGRATION_FILE_PATTERN.test(name));
  if (misnamed.length > 0) {
    throw new MigrationDirectoryError(dir, `SQL files not named NNNN_<name>.sql: ${misnamed.join(', ')}`);
  }
  if (names.length === 0) throw new MigrationDirectoryError(dir, 'holds no migration files');
  return names.map((name) => ({ name, path: path.join(dir, name) }));
}

async function applyFile(client: SqlClient, schema: string, file: MigrationFile): Promise<void> {
  let text: string;
  try {
    text = await readFile(file.path, 'utf8');
  } catch (error) {
    throw new MigrationFailedError(schema, file.name, error);
  }
  try {
    await client.query('BEGIN');
    // No parameters: the simple-query protocol accepts a multi-statement file as one query.
    await client.query(text);
    await client.query('COMMIT');
  } catch (error) {
    // A failed ROLLBACK must not replace the error that names the file.
    await client.query('ROLLBACK').catch(() => undefined);
    throw new MigrationFailedError(schema, file.name, error, errorLine(error, text));
  }
}

/**
 * Applies `files` in order as the schema owner, one transaction per file, and returns how many were applied.
 * The session is returned to its login role on success and on failure.
 */
export async function applyMigrations(
  client: SqlClient,
  roles: SchemaRoles,
  files: readonly MigrationFile[],
  logger: Logger,
): Promise<number> {
  await client.query(setRoleSql(roles.owner));
  let applied = 0;
  try {
    for (const file of files) {
      await applyFile(client, roles.schema, file);
      applied += 1;
      logger.info(`applied ${roles.schema}/${file.name}`);
    }
  } catch (error) {
    // A failed RESET ROLE (a lost connection) must not replace the error that names the file.
    await client.query(RESET_ROLE_SQL).catch(() => undefined);
    throw error;
  }
  await client.query(RESET_ROLE_SQL);
  return applied;
}

/** Drops every schema, object and role of `list`, in reverse bootstrap order; local target only. */
export async function resetLocalSchemas(client: SqlClient, list: readonly SchemaRoles[]): Promise<void> {
  const { rows } = await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [
    allRoleNames(list),
  ]);
  const existing = new Set(rows.map((row: { rolname: string }) => row.rolname));
  for (const roles of [...list].reverse()) {
    for (const statement of dropLocalSql(roles, existing)) {
      await client.query(statement);
    }
  }
}

/** The schemas of `schemas`, in input order, that hold at least one table or partitioned table. */
export async function nonEmptySchemas(client: SqlClient, schemas: readonly string[]): Promise<string[]> {
  const { rows } = await client.query(
    "SELECT n.nspname FROM pg_namespace n JOIN pg_class c ON c.relnamespace = n.oid WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p') GROUP BY n.nspname",
    [[...schemas]],
  );
  const populated = new Set(rows.map((row: { nspname: string }) => row.nspname));
  return schemas.filter((schema) => populated.has(schema));
}

/** Throws `SchemaNotEmptyError` naming every schema of `schemas` that already holds a table. */
export async function assertSchemasEmpty(client: SqlClient, schemas: readonly string[]): Promise<void> {
  const populated = await nonEmptySchemas(client, schemas);
  if (populated.length > 0) throw new SchemaNotEmptyError(populated);
}
