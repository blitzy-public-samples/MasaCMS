/** Transaction-local PostgreSQL setting that carries the current tenant id. */
export const TENANT_SETTING = 'app.tenant_id';

/** Name of the single row-level security policy on every tenant-owned table. */
export const RLS_POLICY_NAME = 'tenant_isolation';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// Identifiers are emitted unquoted, so only lower-case snake identifiers are accepted.
function ident(name: string, label: string): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new TypeError(`Invalid ${label} identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Returns the statements that enable and force RLS on `<schema>.<table>` and create its tenant policy. */
export function rlsSql(schema: string, table: string): string {
  const target = `${ident(schema, 'schema')}.${ident(table, 'table')}`;
  const predicate = `tenant_id = NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;
  return [
    `ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${target} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY ${RLS_POLICY_NAME} ON ${target}`,
    `  USING (${predicate})`,
    `  WITH CHECK (${predicate});`,
  ].join('\n');
}

/** Returns the DDL of the non-tenant `<schema>.tenant_registry` site projection. */
export function tenantRegistrySql(schema: string): string {
  return [
    `CREATE TABLE ${ident(schema, 'schema')}.tenant_registry (`,
    `  site_id text PRIMARY KEY,`,
    `  tenant_id uuid NOT NULL UNIQUE,`,
    `  public_user_pool_id text,`,
    `  private_user_pool_id text,`,
    `  category_pool_id text,`,
    `  file_pool_id text,`,
    `  display_pool_id text,`,
    `  content_pool_ids text[],`,
    `  public_user_pool_tenant uuid,`,
    `  private_user_pool_tenant uuid,`,
    `  category_pool_tenant uuid,`,
    `  file_pool_tenant uuid,`,
    `  display_pool_tenant uuid,`,
    `  content_pool_tenants uuid[],`,
    `  domains text[],`,
    `  aggregate_version bigint NOT NULL,`,
    `  updated_at timestamp(3) without time zone NOT NULL`,
    `);`,
  ].join('\n');
}

/** Returns the DDL of the non-tenant `<schema>.tenant_grant` table of data-created cross-tenant grants. */
export function tenantGrantSql(schema: string): string {
  return [
    `CREATE TABLE ${ident(schema, 'schema')}.tenant_grant (`,
    `  grantor_tenant uuid NOT NULL,`,
    `  grantee_tenant uuid NOT NULL,`,
    `  kind text NOT NULL,`,
    `  resource_id text NOT NULL,`,
    `  created_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),`,
    `  PRIMARY KEY (grantor_tenant, grantee_tenant, kind, resource_id)`,
    `);`,
  ].join('\n');
}
