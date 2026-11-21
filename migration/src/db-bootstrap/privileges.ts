import { quoteIdent, type SchemaRoles } from './roles.js';

/** Returns the statement that makes `role` the current role of the session. */
export function setRoleSql(role: string): string {
  return `SET ROLE ${quoteIdent(role)}`;
}

/** Returns the session to its login role. */
export const RESET_ROLE_SQL = 'RESET ROLE';

/**
 * Run as the schema owner: grants the app role DML on tables and use of sequences the owner creates later,
 * and USAGE on the schema. The app role gets no DDL right.
 */
export function defaultPrivilegesSql(roles: SchemaRoles): string[] {
  const schema = quoteIdent(roles.schema);
  const owner = quoteIdent(roles.owner);
  const app = quoteIdent(roles.app);
  return [
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${app}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${app}`,
  ];
}

/** Run as the schema owner after migrations: the same app grants on objects that already exist in the schema. */
export function postMigrationGrantsSql(roles: SchemaRoles): string[] {
  const schema = quoteIdent(roles.schema);
  const app = quoteIdent(roles.app);
  return [
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${app}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${app}`,
  ];
}
