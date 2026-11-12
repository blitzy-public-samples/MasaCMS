// Read-only PostgreSQL catalog checks of tenant RLS on the service schemas and of the service roles' privileges.
import { RLS_POLICY_NAME, TENANT_SETTING } from '@opt2/platform/tenancy';
import { PLATFORM_TABLE_GROUPS, type CatalogFinding } from '@opt2/platform/testing';
import type { CatalogClient } from '../lib/pg.js';
import { DB_SCHEMAS } from '../repro/secrets.js';

type DbSchema = (typeof DB_SCHEMAS)[number];

/** Service package folders under `services/` and the PostgreSQL schema each owns, in report order. */
export const SERVICE_SCHEMAS = Object.freeze([
  { service: 'identity', schema: 'identity' },
  { service: 'people', schema: 'people' },
  { service: 'programs-sites', schema: 'programs_sites' },
  { service: 'strategies-content', schema: 'content' },
  { service: 'communications', schema: 'communications' },
  { service: 'reporting', schema: 'reporting' },
  { service: 'surveys', schema: 'surveys' },
  { service: 'timesheets', schema: 'timesheets' },
  { service: 'finance', schema: 'finance' },
  { service: 'e-signature', schema: 'esignature' },
  { service: 'stub', schema: 'stub' },
] as const) satisfies readonly { service: string; schema: DbSchema }[];

/** Schemas of the gateway and migration coordination state: their roles are checked, their tables are not. */
export const COORDINATION_SCHEMAS = Object.freeze(['gateway', 'migration'] as const) satisfies readonly DbSchema[];

type AssertNever<T extends never> = T;
// Fails to compile when DB_SCHEMAS gains a schema that is neither a service nor a coordination schema.
type UnclassifiedDbSchema = AssertNever<
  Exclude<DbSchema, (typeof SERVICE_SCHEMAS)[number]['schema'] | (typeof COORDINATION_SCHEMAS)[number]>
>;

/** Role-name suffixes the database bootstrap creates for every schema. */
export const ROLE_SUFFIXES = Object.freeze(['owner', 'app', 'migrator'] as const);

/** The `<schema>_<suffix>` role names of every bootstrapped schema, schema-major in DB_SCHEMAS order. */
export function serviceRoleNames(): string[] {
  return DB_SCHEMAS.flatMap((schema) => ROLE_SUFFIXES.map((suffix) => `${schema}_${suffix}`));
}

/** Service-schema tables holding tenant metadata rather than tenant data, which RLS does not guard; sorted. */
export const NON_TENANT_TABLES: readonly string[] = Object.freeze(
  [...new Set(Object.values(PLATFORM_TABLE_GROUPS).flatMap((group) => group.nonTenant))].sort(),
);

/** RLS counts over the tenant-owned tables of one schema. */
export interface RlsCatalogSummary {
  tables: number;
  enabled: number;
  forced: number;
  usingAndWithCheck: number;
}

/** A service role that is a member of a SUPERUSER or BYPASSRLS role, directly or through the roles in `via`. */
export interface MembershipViolation {
  member: string;
  ancestor: string;
  via: string[];
}

/** Service roles that are, or can become, privileged; each list sorted. */
export interface RoleFindings {
  rolbypassrls: string[];
  rolsuper: string[];
  membershipViolations: MembershipViolation[];
}

/** Every catalog finding, the RLS counts per service schema and the privileged service roles. */
export interface CatalogRunResult {
  findings: CatalogFinding[];
  rlsCatalog: Record<string, RlsCatalogSummary>;
  roles: RoleFindings;
}

/** An ordinary or partitioned table of a service schema with its RLS flags and its `tenant_id` column. */
export interface CatalogTableRow {
  schema: string;
  table: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  tenantIdPresent: boolean;
  /** `format_type` of `tenant_id`; null when the column is absent. */
  tenantIdType: string | null;
  tenantIdNotNull: boolean;
}

/** A `pg_policies` row of a service schema. */
export interface CatalogPolicyRow {
  schemaname: string;
  tablename: string;
  policyname: string;
  /** `PERMISSIVE` or `RESTRICTIVE`. */
  permissive: string;
  /** `ALL`, `SELECT`, `INSERT`, `UPDATE` or `DELETE`. */
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

/** A service role's own attributes from `pg_roles`. */
export interface CatalogRoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/** A role reached from service role `member` through `pg_auth_members`, with the intermediate roles of that path. */
export interface CatalogMembershipRow {
  member: string;
  ancestor: string;
  via: string[];
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/** Input of {@link evaluateCatalog}: the rows of the four catalog queries. */
export interface CatalogRows {
  tables: readonly CatalogTableRow[];
  policies: readonly CatalogPolicyRow[];
  roles: readonly CatalogRoleRow[];
  memberships: readonly CatalogMembershipRow[];
}

const TABLES_SQL = `
SELECT n.nspname::text AS "schema",
       c.relname::text AS "table",
       c.relrowsecurity AS "relrowsecurity",
       c.relforcerowsecurity AS "relforcerowsecurity",
       a.attnum IS NOT NULL AS "tenantIdPresent",
       format_type(a.atttypid, a.atttypmod) AS "tenantIdType",
       coalesce(a.attnotnull, false) AS "tenantIdNotNull"
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
 WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p')
 ORDER BY 1, 2`;

const POLICIES_SQL = `
SELECT schemaname::text AS "schemaname",
       tablename::text AS "tablename",
       policyname::text AS "policyname",
       permissive,
       cmd,
       qual,
       with_check
  FROM pg_policies
 WHERE schemaname = ANY($1::text[])
 ORDER BY 1, 2, 3`;

const ROLES_SQL = `
SELECT rolname::text AS "rolname", rolsuper, rolbypassrls
  FROM pg_roles
 WHERE rolname = ANY($1::text[])
 ORDER BY 1`;

// The path array is the cycle guard: a role already on the path is never followed again.
const MEMBERSHIPS_SQL = `
WITH RECURSIVE ancestry(member_oid, ancestor_oid, path) AS (
  SELECT r.oid, m.roleid, ARRAY[r.oid, m.roleid]
    FROM pg_roles r
    JOIN pg_auth_members m ON m.member = r.oid
   WHERE r.rolname = ANY($1::text[])
  UNION ALL
  SELECT a.member_oid, m.roleid, a.path || m.roleid
    FROM ancestry a
    JOIN pg_auth_members m ON m.member = a.ancestor_oid
   WHERE m.roleid <> ALL (a.path)
)
SELECT r.rolname::text AS "member",
       g.rolname::text AS "ancestor",
       ARRAY(SELECT x.rolname::text
               FROM unnest(a.path[2:cardinality(a.path) - 1]) WITH ORDINALITY AS hop(role_oid, ord)
               JOIN pg_roles x ON x.oid = hop.role_oid
              ORDER BY hop.ord) AS "via",
       g.rolsuper,
       g.rolbypassrls
  FROM ancestry a
  JOIN pg_roles r ON r.oid = a.member_oid
  JOIN pg_roles g ON g.oid = a.ancestor_oid
 WHERE g.rolsuper OR g.rolbypassrls
 ORDER BY 1, 2`;

const SQL_SPACE = /[ \t\n\r\f\v]+/g;
const TEXT_CAST = /^::text(?![a-z0-9_$])/;
const NON_TENANT: ReadonlySet<string> = new Set(NON_TENANT_TABLES);
// The tenant predicate as rlsSql emits it and as PostgreSQL deparses it into pg_policies, normalised.
const TENANT_PREDICATES: ReadonlySet<string> = new Set(
  [
    `tenant_id = NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`,
    `(tenant_id = (NULLIF(current_setting('${TENANT_SETTING}'::text, true), ''::text))::uuid)`,
  ].map(normalise),
);

/** Index just past the string literal opening at `start`; the end of `sql` when it is unterminated. */
function literalEnd(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== "'") index += 1;
    else if (sql[index + 1] === "'") index += 2;
    else return index + 1;
  }
  return sql.length;
}

/** Index of the parenthesis closing the one at `open`, skipping string literals; -1 when it is unclosed. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      index = literalEnd(text, index) - 1;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** `sql` lower-cased and without whitespace outside string literals, `::text` casts of literals and enclosing parentheses. */
function normalise(sql: string): string {
  let text = '';
  for (let index = 0; index < sql.length; ) {
    const quote = sql.indexOf("'", index);
    const plain = sql.slice(index, quote === -1 ? sql.length : quote).replace(SQL_SPACE, '').toLowerCase();
    // Plain text holds no quote, so `text` ends in one only when a literal precedes `plain`.
    text += text.endsWith("'") ? plain.replace(TEXT_CAST, '') : plain;
    if (quote === -1) break;
    index = literalEnd(sql, quote);
    text += sql.slice(quote, index);
  }
  while (text.startsWith('(') && closingParen(text, 0) === text.length - 1) text = text.slice(1, -1);
  return text;
}

/** True when `expression` is exactly the tenant equality predicate, as rlsSql emits it or PostgreSQL deparses it. */
function isTenantPredicate(expression: string | null): boolean {
  return expression !== null && TENANT_PREDICATES.has(normalise(expression));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFindings(a: CatalogFinding, b: CatalogFinding): number {
  return compareText(a.object, b.object) || compareText(a.kind, b.kind) || compareText(a.detail ?? '', b.detail ?? '');
}

function emptySummary(): RlsCatalogSummary {
  return { tables: 0, enabled: 0, forced: 0, usingAndWithCheck: 0 };
}

/** Adds the findings of one tenant-owned table to `findings` and counts it into `summary`. */
function evaluateTable(
  table: CatalogTableRow,
  policies: readonly CatalogPolicyRow[],
  summary: RlsCatalogSummary,
  findings: CatalogFinding[],
): void {
  const object = `${table.schema}.${table.table}`;
  summary.tables += 1;

  // The platform's finding kinds have none for the tenant column; the tenant USING predicate is what it defeats.
  if (!table.tenantIdPresent) {
    findings.push({ kind: 'policy-missing-using', object, detail: 'no tenant_id column; expected tenant_id uuid NOT NULL' });
  } else if (table.tenantIdType !== 'uuid' || !table.tenantIdNotNull) {
    const nullability = table.tenantIdNotNull ? 'NOT NULL' : 'nullable';
    findings.push({
      kind: 'policy-missing-using',
      object,
      detail: `tenant_id is ${table.tenantIdType ?? 'of unknown type'} ${nullability}; expected uuid NOT NULL`,
    });
  }

  if (table.relrowsecurity) summary.enabled += 1;
  else findings.push({ kind: 'rls-disabled', object, detail: 'row level security is not enabled' });
  if (table.relforcerowsecurity) summary.forced += 1;
  else findings.push({ kind: 'rls-not-forced', object, detail: 'missing FORCE ROW LEVEL SECURITY' });

  // Restrictive policies can only narrow access, so only permissive ones grant or widen it.
  const permissive = policies.filter((policy) => policy.permissive === 'PERMISSIVE');
  const forAll = permissive.filter((policy) => policy.cmd === 'ALL');
  const covered = forAll.some((policy) => isTenantPredicate(policy.qual) && isTenantPredicate(policy.with_check));
  if (!covered) {
    if (forAll.some((policy) => isTenantPredicate(policy.qual))) {
      findings.push({
        kind: 'policy-missing-check',
        object,
        detail: `missing WITH CHECK: no permissive FOR ALL policy checks written rows against ${TENANT_SETTING}`,
      });
    } else {
      findings.push({
        kind: 'policy-missing-using',
        object,
        detail: `no permissive FOR ALL ${RLS_POLICY_NAME} policy with USING and WITH CHECK on tenant_id and ${TENANT_SETTING}`,
      });
    }
  }

  // Permissive policies are ORed, so any expression other than the tenant predicate widens access past the tenant.
  let widened = false;
  for (const policy of permissive) {
    if (policy.qual !== null && !isTenantPredicate(policy.qual)) {
      widened = true;
      findings.push({
        kind: 'policy-missing-using',
        object,
        detail: `permissive policy ${policy.policyname} FOR ${policy.cmd} USING (${policy.qual}) lacks the tenant predicate and widens access`,
      });
    }
    if (policy.with_check !== null && !isTenantPredicate(policy.with_check)) {
      widened = true;
      findings.push({
        kind: 'policy-missing-check',
        object,
        detail: `permissive policy ${policy.policyname} FOR ${policy.cmd} WITH CHECK (${policy.with_check}) lacks the tenant predicate and widens access`,
      });
    }
  }
  if (covered && !widened) summary.usingAndWithCheck += 1;
}

/** RLS findings and counts of the tenant-owned tables of every service schema; rows of other schemas are ignored. */
function evaluateTables(rows: CatalogRows): { findings: CatalogFinding[]; rlsCatalog: Record<string, RlsCatalogSummary> } {
  const rlsCatalog: Record<string, RlsCatalogSummary> = {};
  for (const { schema } of SERVICE_SCHEMAS) rlsCatalog[schema] = emptySummary();

  const policiesByTable = new Map<string, CatalogPolicyRow[]>();
  for (const policy of rows.policies) {
    const key = `${policy.schemaname}.${policy.tablename}`;
    policiesByTable.set(key, [...(policiesByTable.get(key) ?? []), policy]);
  }

  const findings: CatalogFinding[] = [];
  for (const table of rows.tables) {
    const summary = rlsCatalog[table.schema];
    if (summary === undefined || NON_TENANT.has(table.table)) continue;
    evaluateTable(table, policiesByTable.get(`${table.schema}.${table.table}`) ?? [], summary, findings);
  }

  for (const { schema } of SERVICE_SCHEMAS) {
    if (rlsCatalog[schema]?.tables === 0) {
      // The platform's finding kinds have none for an empty schema; RLS is then shown enabled on no table at all.
      findings.push({
        kind: 'rls-disabled',
        object: schema,
        detail: 'no tenant-owned tables; the schema is missing or its migrations have not run',
      });
    }
  }
  return { findings: findings.sort(compareFindings), rlsCatalog };
}

function privileges(row: { rolsuper: boolean; rolbypassrls: boolean }): string {
  return [row.rolsuper ? 'SUPERUSER' : undefined, row.rolbypassrls ? 'BYPASSRLS' : undefined].filter(Boolean).join(', ');
}

/** Shorter path first, then the path's role names, so one violation per member and ancestor is kept deterministically. */
function preferredPath(a: CatalogMembershipRow, b: CatalogMembershipRow): CatalogMembershipRow {
  if (a.via.length !== b.via.length) return a.via.length < b.via.length ? a : b;
  return compareText(a.via.join('\u0000'), b.via.join('\u0000')) <= 0 ? a : b;
}

/** Role findings over the service roles only; rows of other roles are ignored. */
function evaluateRoles(rows: CatalogRows): { findings: CatalogFinding[]; roles: RoleFindings } {
  const expected = serviceRoleNames();
  const isServiceRole = new Set(expected);
  const own = rows.roles.filter((row) => isServiceRole.has(row.rolname));
  const present = new Set(own.map((row) => row.rolname));
  const findings: CatalogFinding[] = [];

  for (const name of expected) {
    if (!present.has(name)) {
      // The platform's finding kinds have none for an absent role; a role never inspected is not shown unable to bypass RLS.
      findings.push({
        kind: 'role-bypassrls',
        object: name,
        detail: 'role missing from pg_roles; the database bootstrap has not created it',
      });
    }
  }

  const rolsuper = [...new Set(own.filter((row) => row.rolsuper).map((row) => row.rolname))].sort(compareText);
  const rolbypassrls = [...new Set(own.filter((row) => row.rolbypassrls).map((row) => row.rolname))].sort(compareText);
  for (const name of rolsuper) findings.push({ kind: 'role-superuser', object: name, detail: 'role has SUPERUSER' });
  for (const name of rolbypassrls) findings.push({ kind: 'role-bypassrls', object: name, detail: 'role has BYPASSRLS' });

  const strongest = new Map<string, CatalogMembershipRow>();
  for (const row of rows.memberships) {
    if (!isServiceRole.has(row.member) || !(row.rolsuper || row.rolbypassrls)) continue;
    const key = `${row.member}\u0000${row.ancestor}`;
    const kept = strongest.get(key);
    strongest.set(key, kept === undefined ? row : preferredPath(kept, row));
  }
  const memberships = [...strongest.values()].sort(
    (a, b) => compareText(a.member, b.member) || compareText(a.ancestor, b.ancestor),
  );
  for (const row of memberships) {
    const route = row.via.length === 0 ? 'directly' : `via ${row.via.join(' -> ')}`;
    findings.push({
      kind: 'role-member-of-privileged',
      object: row.member,
      detail: `member of ${row.ancestor} (${privileges(row)}) ${route}`,
    });
  }

  return {
    findings: findings.sort(compareFindings),
    roles: {
      rolbypassrls,
      rolsuper,
      membershipViolations: memberships.map((row) => ({ member: row.member, ancestor: row.ancestor, via: [...row.via] })),
    },
  };
}

/** Evaluates catalog rows without IO; table findings come first, then role findings, each sorted. */
export function evaluateCatalog(rows: CatalogRows): CatalogRunResult {
  const tables = evaluateTables(rows);
  const roles = evaluateRoles(rows);
  return { findings: [...tables.findings, ...roles.findings], rlsCatalog: tables.rlsCatalog, roles: roles.roles };
}

/** Reads the catalog rows of the service schemas and roles through `client` and evaluates them; the caller closes `client`. */
export async function runCatalogChecks(client: CatalogClient): Promise<CatalogRunResult> {
  const schemas = SERVICE_SCHEMAS.map(({ schema }) => schema);
  const roleNames = serviceRoleNames();
  const tables = await client.query<CatalogTableRow>(TABLES_SQL, [schemas]);
  const policies = await client.query<CatalogPolicyRow>(POLICIES_SQL, [schemas]);
  const roles = await client.query<CatalogRoleRow>(ROLES_SQL, [roleNames]);
  const memberships = await client.query<CatalogMembershipRow>(MEMBERSHIPS_SQL, [roleNames]);
  return evaluateCatalog({ tables, policies, roles, memberships });
}
