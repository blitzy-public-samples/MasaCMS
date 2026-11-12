import { readFileSync } from 'node:fs';
import { rlsSql } from '@opt2/platform/tenancy';
import { PLATFORM_TABLE_GROUPS, type CatalogFinding } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import {
  COORDINATION_SCHEMAS,
  NON_TENANT_TABLES,
  ROLE_SUFFIXES,
  SERVICE_SCHEMAS,
  evaluateCatalog,
  runCatalogChecks,
  serviceRoleNames,
  type CatalogRunResult,
  type RlsCatalogSummary,
} from '../../src/isolation/catalog.js';
import type { CatalogClient } from '../../src/lib/pg.js';

type CatalogInput = Parameters<typeof evaluateCatalog>[0];
type EditableRows = { -readonly [K in keyof CatalogInput]: CatalogInput[K][number][] };
type TableRow = EditableRows['tables'][number];
type PolicyRow = EditableRows['policies'][number];
type RoleRow = EditableRows['roles'][number];
type MembershipRow = EditableRows['memberships'][number];

interface RecordedQuery {
  sql: string;
  params: readonly unknown[] | undefined;
}

const FIXTURE_TEXT = readFileSync(new URL('../fixtures/catalog/pg-catalog-rows.sample.json', import.meta.url), 'utf8');
const FIXTURE = JSON.parse(FIXTURE_TEXT) as CatalogInput;

const SCHEMAS = SERVICE_SCHEMAS.map(({ schema }) => schema);
const NO_TABLES: RlsCatalogSummary = { tables: 0, enabled: 0, forced: 0, usingAndWithCheck: 0 };
const NO_PRIVILEGED_ROLES: CatalogRunResult['roles'] = { rolbypassrls: [], rolsuper: [], membershipViolations: [] };
const FINDING_KINDS: Readonly<Record<CatalogFinding['kind'], true>> = {
  'rls-disabled': true,
  'rls-not-forced': true,
  'policy-missing-using': true,
  'policy-missing-check': true,
  'role-superuser': true,
  'role-bypassrls': true,
  'role-member-of-privileged': true,
};
const CATALOG_RELATIONS = ['pg_class', 'pg_namespace', 'pg_attribute', 'pg_policies', 'pg_roles', 'pg_auth_members'];
const WRITE_STATEMENT = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|SET\s+ROLE|TRUNCATE)\b/i;

/** A mutable copy of the committed fixture rows. */
function fixtureRows(): EditableRows {
  return structuredClone(FIXTURE) as EditableRows;
}

/** The fixture rows with its unforced table and its BYPASSRLS role repaired. */
function compliantRows(): EditableRows {
  const rows = fixtureRows();
  tableRow(rows, 'timesheets', 'blackout').relforcerowsecurity = true;
  roleRow(rows, 'finance_app').rolbypassrls = false;
  return rows;
}

/** The one element of `list` matching `predicate`; throws naming `label` when there is none. */
function only<T>(list: readonly T[], predicate: (item: T) => boolean, label: string): T {
  const found = list.find(predicate);
  if (found === undefined) throw new Error(`fixture has no ${label}`);
  return found;
}

function tableRow(rows: EditableRows, schema: string, table: string): TableRow {
  return only(rows.tables, (row) => row.schema === schema && row.table === table, `table ${schema}.${table}`);
}

function policyRow(rows: EditableRows, schema: string, table: string): PolicyRow {
  return only(rows.policies, (row) => row.schemaname === schema && row.tablename === table, `policy on ${schema}.${table}`);
}

function roleRow(rows: EditableRows, name: string): RoleRow {
  return only(rows.roles, (row) => row.rolname === name, `role ${name}`);
}

/** A table row of `schema` with RLS off and no `tenant_id` column. */
function unguardedTable(schema: string, table: string): TableRow {
  return {
    schema,
    table,
    relrowsecurity: false,
    relforcerowsecurity: false,
    tenantIdPresent: false,
    tenantIdType: null,
    tenantIdNotNull: false,
  };
}

/** `findings` reduced to kind and object. */
function kindsAndObjects(findings: readonly CatalogFinding[]): Pick<CatalogFinding, 'kind' | 'object'>[] {
  return findings.map(({ kind, object }) => ({ kind, object }));
}

/** `sql` without its leading whitespace and comments. */
function withoutLeadingComments(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*|\/\*[\s\S]*?\*\/)+/, '');
}

/** Lower-cased relations named after FROM or JOIN in `sql`, without its CTE names and function calls. */
function relationsRead(sql: string): string[] {
  const ctes = new Set(
    [...sql.matchAll(/\b(\w+)\s*(?:\([^()]*\))?\s+AS\s*\(/gi)].map((match) => (match[1] ?? '').toLowerCase()),
  );
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+([\w.]+)(\s*\()?/gi)]
    .filter((match) => match[2] === undefined)
    .map((match) => (match[1] ?? '').toLowerCase())
    .filter((name) => !ctes.has(name));
}

/** A CatalogClient answering each query from `rows` by the catalog relation it reads, recording queries and closes. */
function fakeCatalogClient(
  rows: CatalogInput,
  failure?: Error,
): { client: CatalogClient; queries: RecordedQuery[]; closes: { count: number } } {
  const queries: RecordedQuery[] = [];
  const closes = { count: 0 };
  const client: CatalogClient = {
    query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (failure !== undefined) return Promise.reject(failure);
      const answer = /\bpg_auth_members\b/.test(sql)
        ? rows.memberships
        : /\bpg_policies\b/.test(sql)
          ? rows.policies
          : /\bpg_class\b/.test(sql)
            ? rows.tables
            : /\bpg_roles\b/.test(sql)
              ? rows.roles
              : undefined;
      if (answer === undefined) return Promise.reject(new Error(`unexpected catalog query: ${sql}`));
      return Promise.resolve(structuredClone(answer) as unknown as T[]);
    },
    close(): Promise<void> {
      closes.count += 1;
      return Promise.resolve();
    },
  };
  return { client, queries, closes };
}

describe('evaluateCatalog', () => {
  it('reports only the unforced timesheets.blackout and the BYPASSRLS finance_app of the committed fixture', () => {
    const result = evaluateCatalog(FIXTURE);

    expect(result.findings).toEqual([
      { kind: 'rls-not-forced', object: 'timesheets.blackout', detail: expect.stringContaining('FORCE ROW LEVEL SECURITY') },
      { kind: 'role-bypassrls', object: 'finance_app', detail: expect.stringContaining('BYPASSRLS') },
    ]);
    expect(result.roles).toEqual({ ...NO_PRIVILEGED_ROLES, rolbypassrls: ['finance_app'] });
    expect(Object.keys(result.rlsCatalog)).toEqual(SCHEMAS);
    expect(result.rlsCatalog.people).toEqual({ tables: 2, enabled: 2, forced: 2, usingAndWithCheck: 2 });
    expect(result.rlsCatalog.timesheets).toEqual({ tables: 1, enabled: 1, forced: 0, usingAndWithCheck: 1 });
    for (const schema of SCHEMAS.filter((name) => name !== 'people' && name !== 'timesheets')) {
      expect(result.rlsCatalog[schema]).toEqual({ tables: 1, enabled: 1, forced: 1, usingAndWithCheck: 1 });
    }
    expect(FIXTURE).toEqual(JSON.parse(FIXTURE_TEXT));
  });

  it('yields no finding and no privileged role for a compliant catalog', () => {
    const result = evaluateCatalog(compliantRows());

    expect(result.findings).toEqual([]);
    expect(result.roles).toEqual(NO_PRIVILEGED_ROLES);
    for (const summary of Object.values(result.rlsCatalog)) {
      const { tables } = summary;
      expect(tables).toBeGreaterThan(0);
      expect(summary).toEqual({ tables, enabled: tables, forced: tables, usingAndWithCheck: tables });
    }
  });

  it.each([
    { flag: 'relforcerowsecurity', kind: 'rls-not-forced', counter: 'forced' },
    { flag: 'relrowsecurity', kind: 'rls-disabled', counter: 'enabled' },
  ] as const)('reports people.person with $flag cleared as $kind and lowers $counter', ({ flag, kind, counter }) => {
    const rows = compliantRows();
    tableRow(rows, 'people', 'person')[flag] = false;

    const result = evaluateCatalog(rows);

    expect(kindsAndObjects(result.findings)).toEqual([{ kind, object: 'people.person' }]);
    expect(result.rlsCatalog.people?.[counter]).toBe(1);
  });

  it.each<{ defect: string; kind: CatalogFinding['kind']; edit: (policy: PolicyRow, rows: EditableRows) => unknown }>([
    { defect: 'lacks WITH CHECK', kind: 'policy-missing-check', edit: (policy) => Object.assign(policy, { with_check: null }) },
    { defect: 'lacks USING', kind: 'policy-missing-using', edit: (policy) => Object.assign(policy, { qual: null }) },
    { defect: 'is RESTRICTIVE', kind: 'policy-missing-using', edit: (policy) => Object.assign(policy, { permissive: 'RESTRICTIVE' }) },
    { defect: 'covers only SELECT', kind: 'policy-missing-using', edit: (policy) => Object.assign(policy, { cmd: 'SELECT' }) },
    {
      defect: 'is absent',
      kind: 'policy-missing-using',
      edit: (policy, rows) => rows.policies.splice(rows.policies.indexOf(policy), 1),
    },
  ])('reports a tenant table whose tenant policy $defect', ({ kind, edit }) => {
    const rows = compliantRows();
    edit(policyRow(rows, 'people', 'person'), rows);

    const result = evaluateCatalog(rows);

    expect(kindsAndObjects(result.findings)).toEqual([{ kind, object: 'people.person' }]);
    expect(result.rlsCatalog.people).toEqual({ tables: 2, enabled: 2, forced: 2, usingAndWithCheck: 1 });
  });

  it.each([
    { cmd: 'SELECT', qual: 'true', with_check: null, kind: 'policy-missing-using' },
    { cmd: 'INSERT', qual: null, with_check: 'true', kind: 'policy-missing-check' },
  ] as const)(
    'reports an extra permissive FOR $cmd policy without the tenant predicate as widening access',
    ({ cmd, qual, with_check, kind }) => {
      const rows = compliantRows();
      rows.policies.push({
        schemaname: 'people',
        tablename: 'person',
        policyname: 'open_access',
        permissive: 'PERMISSIVE',
        cmd,
        qual,
        with_check,
      });

      const result = evaluateCatalog(rows);

      expect(result.findings).toEqual([
        { kind, object: 'people.person', detail: expect.stringContaining('open_access') },
      ]);
      expect(result.rlsCatalog.people?.usingAndWithCheck).toBe(1);
    },
  );

  it('ignores a RESTRICTIVE policy, which can only narrow access', () => {
    const rows = compliantRows();
    rows.policies.push({
      schemaname: 'people',
      tablename: 'person',
      policyname: 'active_only',
      permissive: 'RESTRICTIVE',
      cmd: 'ALL',
      qual: '(archived = false)',
      with_check: '(archived = false)',
    });

    const result = evaluateCatalog(rows);

    expect(result.findings).toEqual([]);
    expect(result.rlsCatalog.people?.usingAndWithCheck).toBe(2);
  });

  it('accepts the tenant predicate as rlsSql emits it, not only in its deparsed form', () => {
    const emitted = rlsSql('people', 'person');
    const using = /USING \((.+)\)\n/.exec(emitted)?.[1];
    const check = /WITH CHECK \((.+)\);/.exec(emitted)?.[1];
    expect(using).toBeTypeOf('string');
    expect(check).toBeTypeOf('string');
    const rows = compliantRows();
    const policy = policyRow(rows, 'people', 'person');
    policy.qual = using ?? null;
    policy.with_check = check ?? null;

    expect(evaluateCatalog(rows).findings).toEqual([]);
  });

  it.each([
    { label: 'quotes tenant_id inside a literal', expression: "(current_setting('app.tenant_id'::text, true) IS NOT NULL)" },
    { label: 'tests tenant_id without the setting', expression: '(tenant_id IS NOT NULL)' },
  ])('treats a policy that $label as lacking the tenant predicate', ({ expression }) => {
    const rows = compliantRows();
    const policy = policyRow(rows, 'people', 'person');
    policy.qual = expression;
    policy.with_check = expression;

    expect(kindsAndObjects(evaluateCatalog(rows).findings)).toEqual([
      { kind: 'policy-missing-check', object: 'people.person' },
      { kind: 'policy-missing-using', object: 'people.person' },
      { kind: 'policy-missing-using', object: 'people.person' },
    ]);
  });

  it.each([
    {
      defect: 'has no tenant_id column',
      column: { tenantIdPresent: false, tenantIdType: null, tenantIdNotNull: false },
      detail: 'no tenant_id column',
    },
    {
      defect: 'types tenant_id as text',
      column: { tenantIdPresent: true, tenantIdType: 'text', tenantIdNotNull: true },
      detail: 'tenant_id is text NOT NULL',
    },
    {
      defect: 'leaves tenant_id nullable',
      column: { tenantIdPresent: true, tenantIdType: 'uuid', tenantIdNotNull: false },
      detail: 'tenant_id is uuid nullable',
    },
    {
      defect: 'has a tenant_id of unknown type',
      column: { tenantIdPresent: true, tenantIdType: null, tenantIdNotNull: true },
      detail: 'tenant_id is of unknown type',
    },
  ])('reports a tenant table that $defect', ({ column, detail }) => {
    const rows = compliantRows();
    Object.assign(tableRow(rows, 'people', 'person'), column);

    expect(evaluateCatalog(rows).findings).toEqual([
      { kind: 'policy-missing-using', object: 'people.person', detail: expect.stringContaining(detail) },
    ]);
  });

  it('exempts the platform non-tenant tables from RLS in every service schema', () => {
    expect([...NON_TENANT_TABLES]).toEqual([
      'migration_watermark',
      'open_operation',
      'tenant_grant',
      'tenant_registry',
      'unit_gate',
    ]);
    expect(new Set(NON_TENANT_TABLES)).toEqual(
      new Set(Object.values(PLATFORM_TABLE_GROUPS).flatMap((group) => group.nonTenant)),
    );
    const rows = compliantRows();
    for (const { schema } of SERVICE_SCHEMAS) {
      for (const table of NON_TENANT_TABLES) rows.tables.push(unguardedTable(schema, table));
    }

    const result = evaluateCatalog(rows);

    expect(result.findings).toEqual([]);
    expect(result.rlsCatalog).toEqual(evaluateCatalog(compliantRows()).rlsCatalog);
  });

  it('reports a tenant table that is not exempt and has no RLS, tenant_id or policy', () => {
    const rows = compliantRows();
    rows.tables.push(unguardedTable('finance', 'tenant_registry_archive'));

    const result = evaluateCatalog(rows);

    expect(kindsAndObjects(result.findings)).toEqual([
      { kind: 'policy-missing-using', object: 'finance.tenant_registry_archive' },
      { kind: 'policy-missing-using', object: 'finance.tenant_registry_archive' },
      { kind: 'rls-disabled', object: 'finance.tenant_registry_archive' },
      { kind: 'rls-not-forced', object: 'finance.tenant_registry_archive' },
    ]);
    expect(result.rlsCatalog.finance).toEqual({ tables: 2, enabled: 1, forced: 1, usingAndWithCheck: 1 });
  });

  it('ignores tables of other schemas, roles that are not service roles and their memberships', () => {
    const rows = compliantRows();
    rows.tables.push(unguardedTable('gateway', 'inflight'), unguardedTable('public', 'scratch'));
    rows.policies.push({
      schemaname: 'public',
      tablename: 'scratch',
      policyname: 'open_access',
      permissive: 'PERMISSIVE',
      cmd: 'ALL',
      qual: 'true',
      with_check: 'true',
    });
    rows.roles.push({ rolname: 'postgres', rolsuper: true, rolbypassrls: true });
    rows.memberships.push({ member: 'report_reader', ancestor: 'postgres', via: [], rolsuper: true, rolbypassrls: true });

    expect(evaluateCatalog(rows)).toEqual(evaluateCatalog(compliantRows()));
  });

  it('reports every service schema without tenant tables and every service role missing from pg_roles', () => {
    const rows = compliantRows();
    const peopleOnly: CatalogInput = {
      tables: rows.tables.filter((row) => row.schema === 'people'),
      policies: rows.policies.filter((row) => row.schemaname === 'people'),
      roles: rows.roles.filter((row) => row.rolname.startsWith('people_')),
      memberships: rows.memberships.filter((row) => row.member.startsWith('people_')),
    };
    const emptySchemas = SCHEMAS.filter((schema) => schema !== 'people');
    const absentRoles = serviceRoleNames().filter((name) => !name.startsWith('people_'));

    const result = evaluateCatalog(peopleOnly);

    expect(result.findings).toEqual([
      ...emptySchemas.toSorted().map((schema) => ({
        kind: 'rls-disabled',
        object: schema,
        detail: expect.stringContaining('no tenant-owned tables'),
      })),
      ...absentRoles.toSorted().map((name) => ({
        kind: 'role-bypassrls',
        object: name,
        detail: expect.stringContaining('missing from pg_roles'),
      })),
    ]);
    expect(result.rlsCatalog.people).toEqual({ tables: 2, enabled: 2, forced: 2, usingAndWithCheck: 2 });
    for (const schema of emptySchemas) expect(result.rlsCatalog[schema]).toEqual(NO_TABLES);
    expect(result.roles).toEqual(NO_PRIVILEGED_ROLES);
  });

  it.each([
    {
      label: 'SUPERUSER',
      attributes: { rolsuper: true, rolbypassrls: false },
      lists: { rolsuper: ['content_app'], rolbypassrls: [] },
      kinds: ['role-superuser'],
    },
    {
      label: 'SUPERUSER and BYPASSRLS',
      attributes: { rolsuper: true, rolbypassrls: true },
      lists: { rolsuper: ['content_app'], rolbypassrls: ['content_app'] },
      kinds: ['role-bypassrls', 'role-superuser'],
    },
  ] as const)('lists a service role with $label under each attribute it holds', ({ attributes, lists, kinds }) => {
    const rows = compliantRows();
    Object.assign(roleRow(rows, 'content_app'), attributes);

    const result = evaluateCatalog(rows);

    expect(result.roles).toEqual({ ...NO_PRIVILEGED_ROLES, ...lists });
    expect(kindsAndObjects(result.findings)).toEqual(kinds.map((kind) => ({ kind, object: 'content_app' })));
  });

  it.each([
    {
      route: 'through an intermediate role',
      privileges: 'BYPASSRLS',
      member: 'people_app',
      via: ['bridge_role'],
      rolsuper: false,
      rolbypassrls: true,
      detail: 'member of elevated (BYPASSRLS) via bridge_role',
    },
    {
      route: 'directly',
      privileges: 'SUPERUSER',
      member: 'people_migrator',
      via: [],
      rolsuper: true,
      rolbypassrls: false,
      detail: 'member of elevated (SUPERUSER) directly',
    },
    {
      route: 'through two intermediate roles',
      privileges: 'SUPERUSER and BYPASSRLS',
      member: 'people_app',
      via: ['bridge_role', 'relay_role'],
      rolsuper: true,
      rolbypassrls: true,
      detail: 'member of elevated (SUPERUSER, BYPASSRLS) via bridge_role -> relay_role',
    },
  ])('reports a service role that is a member of a $privileges role $route', ({ member, via, rolsuper, rolbypassrls, detail }) => {
    const rows = compliantRows();
    rows.roles.push(
      { rolname: 'elevated', rolsuper, rolbypassrls },
      { rolname: 'bridge_role', rolsuper: false, rolbypassrls: false },
    );
    rows.memberships.push({ member, ancestor: 'elevated', via, rolsuper, rolbypassrls });

    const result = evaluateCatalog(rows);

    expect(result.roles).toEqual({ ...NO_PRIVILEGED_ROLES, membershipViolations: [{ member, ancestor: 'elevated', via }] });
    expect(result.findings).toEqual([{ kind: 'role-member-of-privileged', object: member, detail }]);
  });

  it('reports a member once per privileged ancestor however many paths, a membership cycle included, reach it', () => {
    const rows = compliantRows();
    const path = (via: string[]): MembershipRow => ({
      member: 'people_app',
      ancestor: 'elevated',
      via,
      rolsuper: false,
      rolbypassrls: true,
    });
    rows.memberships.push(
      path(['loop_role', 'bridge_role']),
      path(['zeta_role']),
      path(['bridge_role']),
      path(['bridge_role', 'loop_role']),
    );

    const result = evaluateCatalog(rows);

    expect(result.roles.membershipViolations).toEqual([{ member: 'people_app', ancestor: 'elevated', via: ['bridge_role'] }]);
    expect(kindsAndObjects(result.findings)).toEqual([{ kind: 'role-member-of-privileged', object: 'people_app' }]);
  });

  it('orders membership violations by member, then by privileged ancestor', () => {
    const rows = compliantRows();
    rows.memberships.push(
      { member: 'people_app', ancestor: 'elevated', via: [], rolsuper: false, rolbypassrls: true },
      { member: 'identity_app', ancestor: 'elevated', via: ['bridge_role'], rolsuper: true, rolbypassrls: false },
      { member: 'people_app', ancestor: 'admin_group', via: [], rolsuper: true, rolbypassrls: false },
    );

    const result = evaluateCatalog(rows);

    expect(result.roles.membershipViolations).toEqual([
      { member: 'identity_app', ancestor: 'elevated', via: ['bridge_role'] },
      { member: 'people_app', ancestor: 'admin_group', via: [] },
      { member: 'people_app', ancestor: 'elevated', via: [] },
    ]);
    expect(kindsAndObjects(result.findings)).toEqual([
      { kind: 'role-member-of-privileged', object: 'identity_app' },
      { kind: 'role-member-of-privileged', object: 'people_app' },
      { kind: 'role-member-of-privileged', object: 'people_app' },
    ]);
  });

  it('emits findings of the platform shape with a declared kind, an object and a detail', () => {
    const rows = fixtureRows();
    tableRow(rows, 'people', 'person').tenantIdPresent = false;
    policyRow(rows, 'people', 'person').with_check = null;
    rows.policies = rows.policies.filter((row) => !(row.schemaname === 'people' && row.tablename === 'outbox'));
    rows.tables = rows.tables.filter((row) => row.schema !== 'surveys');
    rows.roles = rows.roles.filter((row) => row.rolname !== 'stub_owner');
    roleRow(rows, 'content_app').rolsuper = true;
    rows.memberships.push({ member: 'people_app', ancestor: 'elevated', via: [], rolsuper: true, rolbypassrls: false });

    const { findings } = evaluateCatalog(rows);

    expect(new Set(findings.map((finding) => finding.kind))).toEqual(new Set(Object.keys(FINDING_KINDS)));
    for (const finding of findings) {
      expect(Object.keys(finding).toSorted()).toEqual(['detail', 'kind', 'object']);
      expect(FINDING_KINDS[finding.kind]).toBe(true);
      expect(finding.object).toMatch(/\S/);
      expect(finding.detail).toMatch(/\S/);
    }
  });
});

describe('service schemas and roles', () => {
  it('maps the eleven service folders to their schemas in report order', () => {
    expect(SERVICE_SCHEMAS).toHaveLength(11);
    expect(SCHEMAS).toEqual([
      'identity',
      'people',
      'programs_sites',
      'content',
      'communications',
      'reporting',
      'surveys',
      'timesheets',
      'finance',
      'esignature',
      'stub',
    ]);
    expect(SERVICE_SCHEMAS.filter(({ service, schema }) => service !== schema)).toEqual([
      { service: 'programs-sites', schema: 'programs_sites' },
      { service: 'strategies-content', schema: 'content' },
      { service: 'e-signature', schema: 'esignature' },
    ]);
  });

  it('names the coordination schemas and the role suffixes the bootstrap creates', () => {
    expect(COORDINATION_SCHEMAS).toEqual(['gateway', 'migration']);
    expect(ROLE_SUFFIXES).toEqual(['owner', 'app', 'migrator']);
  });

  it('names the owner, app and migrator role of every service and coordination schema once', () => {
    const names = serviceRoleNames();

    expect(names).toEqual(
      [...SCHEMAS, ...COORDINATION_SCHEMAS].flatMap((schema) => ROLE_SUFFIXES.map((suffix) => `${schema}_${suffix}`)),
    );
    expect(names).toHaveLength(39);
    expect(names).toContain('gateway_app');
    expect(names).toContain('migration_migrator');
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name.includes('-'))).toEqual([]);
    expect(FIXTURE.roles.map(({ rolname }) => rolname).toSorted()).toEqual(names.toSorted());
  });
});

describe('runCatalogChecks', () => {
  it('evaluates the rows it reads exactly as evaluateCatalog does', async () => {
    const { client } = fakeCatalogClient(FIXTURE);

    await expect(runCatalogChecks(client)).resolves.toEqual(evaluateCatalog(FIXTURE));
  });

  it('scopes table and policy queries to the service schemas and role queries to the service roles', async () => {
    const { client, queries } = fakeCatalogClient(FIXTURE);

    await runCatalogChecks(client);

    expect(queries).toHaveLength(4);
    for (const { sql, params } of queries) {
      expect(params).toEqual([/\bpg_(?:class|policies)\b/.test(sql) ? SCHEMAS : serviceRoleNames()]);
    }
  });

  it('issues only read-only statements over PostgreSQL catalog relations', async () => {
    const { client, queries } = fakeCatalogClient(FIXTURE);
    const qualifiedSchemaTable = new RegExp(`\\b(?:${[...SCHEMAS, ...COORDINATION_SCHEMAS].join('|')})\\.\\w`, 'i');

    await runCatalogChecks(client);

    for (const { sql } of queries) {
      expect(withoutLeadingComments(sql)).toMatch(/^(?:SELECT|WITH)\b/i);
      expect(sql).not.toMatch(WRITE_STATEMENT);
      expect(sql).not.toMatch(qualifiedSchemaTable);
      const relations = relationsRead(sql);
      expect(relations.length).toBeGreaterThan(0);
      for (const relation of relations) expect(CATALOG_RELATIONS).toContain(relation.replace(/^pg_catalog\./, ''));
    }
  });

  it('stops the recursive membership walk at roles already on its path', async () => {
    const { client, queries } = fakeCatalogClient(FIXTURE);

    await runCatalogChecks(client);

    const walk = queries.find(({ sql }) => /\bpg_auth_members\b/.test(sql))?.sql;
    expect(walk).toMatch(/\bWITH\s+RECURSIVE\b/i);
    expect(walk).toMatch(/<>\s*ALL\s*\(/i);
  });

  it('leaves closing the client to its caller', async () => {
    const { client, closes } = fakeCatalogClient(FIXTURE);

    await runCatalogChecks(client);

    expect(closes.count).toBe(0);
  });

  it('rejects with the error of a failing catalog query', async () => {
    const { client } = fakeCatalogClient(FIXTURE, new Error('connection terminated unexpectedly'));

    await expect(runCatalogChecks(client)).rejects.toThrow('connection terminated unexpectedly');
  });
});
