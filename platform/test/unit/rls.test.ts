import { describe, expect, it } from 'vitest';
import { RLS_POLICY_NAME, TENANT_SETTING, rlsSql, tenantGrantSql, tenantRegistrySql } from '../../src/tenancy/rls.js';

const PEOPLE_PERSON_RLS = `ALTER TABLE people.person ENABLE ROW LEVEL SECURITY; ALTER TABLE people.person FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.person
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);`;

const INVALID_IDENTIFIERS: readonly (readonly [string, string])[] = [
  ['upper-case letters', 'People'],
  ['a double quote', 'people"'],
  ['a statement separator', 'people; DROP TABLE people.person; --'],
  ['a schema-qualified name', 'people.person'],
  ['whitespace', 'people person'],
  ['a hyphen', 'programs-sites'],
  ['a leading digit', '1people'],
  ['an empty string', ''],
  ['a non-string value', 42 as unknown as string],
];

const IDENTIFIER_SLOTS: readonly (readonly [string, string, (name: string) => string])[] = [
  ['rlsSql', 'schema', (name) => rlsSql(name, 'person')],
  ['rlsSql', 'table', (name) => rlsSql('people', name)],
  ['tenantRegistrySql', 'schema', (name) => tenantRegistrySql(name)],
  ['tenantGrantSql', 'schema', (name) => tenantGrantSql(name)],
];

const NO_RLS = /POLICY|ROW LEVEL SECURITY/i;

describe('rls constants', () => {
  it('names the transaction-local tenant setting and the policy', () => {
    expect(TENANT_SETTING).toBe('app.tenant_id');
    expect(RLS_POLICY_NAME).toBe('tenant_isolation');
  });
});

describe('rlsSql', () => {
  it('enables and forces RLS and creates the tenant policy on the table', () => {
    expect(rlsSql('people', 'person').trimEnd()).toBe(PEOPLE_PERSON_RLS);
  });

  it.each(['programs_sites', '_private', 'site2'])('accepts the lower-case snake identifier %s', (name) => {
    expect(rlsSql(name, name)).toContain(`ALTER TABLE ${name}.${name} ENABLE ROW LEVEL SECURITY;`);
  });
});

describe('tenantRegistrySql', () => {
  it('creates the non-tenant site projection keyed by site id with a unique tenant id', () => {
    const lines = tenantRegistrySql('people').split('\n');
    expect(lines[0]).toBe('CREATE TABLE people.tenant_registry (');
    expect(lines).toContain('  site_id text PRIMARY KEY,');
    expect(lines).toContain('  tenant_id uuid NOT NULL UNIQUE,');
    expect(lines.at(-1)).toBe(');');
    expect(tenantRegistrySql('people')).not.toMatch(NO_RLS);
  });

  it.each([
    'public_user_pool_id text',
    'private_user_pool_id text',
    'category_pool_id text',
    'file_pool_id text',
    'display_pool_id text',
    'content_pool_ids text[]',
    'public_user_pool_tenant uuid',
    'private_user_pool_tenant uuid',
    'category_pool_tenant uuid',
    'file_pool_tenant uuid',
    'display_pool_tenant uuid',
    'content_pool_tenants uuid[]',
  ])('declares the pool column %s', (column) => {
    expect(tenantRegistrySql('people').split('\n')).toContain(`  ${column},`);
  });
});

describe('tenantGrantSql', () => {
  it('creates the non-tenant grant table keyed by grantor, grantee, kind and resource', () => {
    const lines = tenantGrantSql('people').split('\n');
    expect(lines[0]).toBe('CREATE TABLE people.tenant_grant (');
    expect(lines).toEqual(
      expect.arrayContaining([
        '  grantor_tenant uuid NOT NULL,',
        '  grantee_tenant uuid NOT NULL,',
        '  kind text NOT NULL,',
        '  resource_id text NOT NULL,',
        '  PRIMARY KEY (grantor_tenant, grantee_tenant, kind, resource_id)',
      ]),
    );
    expect(lines.at(-1)).toBe(');');
    expect(tenantGrantSql('people')).not.toMatch(NO_RLS);
  });
});

describe.each(IDENTIFIER_SLOTS)('%s %s identifier', (_builder, label, build) => {
  it.each(INVALID_IDENTIFIERS)('throws a TypeError for %s', (_case, name) => {
    expect(() => build(name)).toThrow(TypeError);
    expect(() => build(name)).toThrow(`Invalid ${label} identifier: `);
  });
});
