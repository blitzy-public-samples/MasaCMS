/** Person-domain resolveUserSite against a seeded people.tenant_registry in a throwaway schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { tenantIdForSite, withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { normaliseParams, resolveUserSite, type UserSite, type UserValues } from '../../src/domain/person.js';
import { bean } from '../helpers/user-values.js';

const available = await pgAvailable();

describe.skipIf(!available)('resolveUserSite against a seeded tenant registry', () => {
  // A registered site whose pool ids and pool tenants are NULL.
  const OWN_POOL_SITE = 'tenant-c';
  const OWN_POOL_TENANT = tenantIdForSite(OWN_POOL_SITE);
  let handle: ThrowawaySchema | undefined;
  let registry: TenantDb;

  beforeAll(async () => {
    const created = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    handle = created;
    registry = created.app;
    await seedRegistry(registry);
    await withMetadata(registry, (tx) =>
      tx.query(`INSERT INTO ${created.schema}.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, LOCALTIMESTAMP(3))`, [
        OWN_POOL_SITE,
        OWN_POOL_TENANT,
      ]),
    );
  });

  afterAll(async () => {
    await handle?.drop();
  });

  const A = TENANT_A.tenantId;
  it.each<[string, string, Record<string, unknown>, Partial<UserValues>, UserSite]>([
    ['a public user lands in the public user pool', A, { siteid: 'tenant-a' }, { siteid: 'tenant-a', ispublic: 1 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: null }],
    ['a private user lands in the private user pool', A, { siteid: 'tenant-a' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'tenant-a', poolTenantId: A, isPublic: 0, poolSwitch: null }],
    ['numeric ispublic text 0 reads as private', A, { siteid: 'tenant-a' }, { siteid: 'tenant-a', ispublic: ' 0 ' },
      { siteId: 'tenant-a', poolTenantId: A, isPublic: 0, poolSwitch: null }],
    ['non-numeric ispublic reads as public and stays text', A, { siteid: 'tenant-a' }, { siteid: 'tenant-a', ispublic: 'x' },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 'x', poolSwitch: null }],
    ['switchToPublic 1 moves a private user to the public pool', A, { siteid: 'tenant-a', switchtopublic: ' 1 ' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: 'public' }],
    ['a switch CFML reads as the number 1', A, { siteid: 'tenant-a', switchtopublic: '1.0' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: 'public' }],
    ['switchToPrivate 1 moves a public user to the private pool', A, { siteid: 'tenant-a', switchtoprivate: '1' }, { siteid: 'umbrella', ispublic: 1 },
      { siteId: 'tenant-a', poolTenantId: A, isPublic: 0, poolSwitch: 'private' }],
    ['switchToPublic wins over switchToPrivate', A, { siteid: 'tenant-a', switchtopublic: '1', switchtoprivate: '1' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: 'public' }],
    ['a switch flag other than 1 is ignored', A, { siteid: 'tenant-a', switchtopublic: '0', switchtoprivate: 'yes' }, { siteid: 'tenant-a', ispublic: 0 },
      { siteId: 'tenant-a', poolTenantId: A, isPublic: 0, poolSwitch: null }],
    ['a pool id differing only in case keeps the current site id', A, { siteid: 'tenant-a' }, { siteid: 'UMBRELLA', ispublic: 1 },
      { siteId: 'UMBRELLA', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: null }],
    ['a switch takes the pool id as registered', A, { siteid: 'tenant-a', switchtopublic: '1' }, { siteid: 'UMBRELLA', ispublic: 1 },
      { siteId: 'umbrella', poolTenantId: TENANT_UMBRELLA.tenantId, isPublic: 1, poolSwitch: 'public' }],
    ['a site that is its own user pool keeps its site', TENANT_B.tenantId, { siteid: 'tenant-b' }, { siteid: 'tenant-b', ispublic: 1 },
      { siteId: 'tenant-b', poolTenantId: TENANT_B.tenantId, isPublic: 1, poolSwitch: null }],
    ['a NULL public pool defaults to the site and its tenant', OWN_POOL_TENANT, { siteid: OWN_POOL_SITE }, { siteid: OWN_POOL_SITE, ispublic: 1 },
      { siteId: OWN_POOL_SITE, poolTenantId: OWN_POOL_TENANT, isPublic: 1, poolSwitch: null }],
    ['a NULL private pool defaults to the site and its tenant', OWN_POOL_TENANT, { siteid: OWN_POOL_SITE, switchtoprivate: '1' }, { siteid: OWN_POOL_SITE, ispublic: 1 },
      { siteId: OWN_POOL_SITE, poolTenantId: OWN_POOL_TENANT, isPublic: 0, poolSwitch: 'private' }],
  ])('%s', async (_label, tid, params, current, expected) => {
    await expect(resolveUserSite(registry, tid, normaliseParams(params), bean(current))).resolves.toEqual(expected);
  });

  it('answers service unavailable for a tenant without a registry entry', async () => {
    const unregistered = tenantIdForSite('tenant-unregistered');
    const outcome = resolveUserSite(registry, unregistered, normaliseParams({ siteid: 'tenant-a' }), bean({ siteid: 'tenant-a' }));
    await expect(outcome).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(outcome).rejects.toMatchObject({
      message: `Tenant ${unregistered} has no site registry entry`,
      surface: 'auto',
      reason: 'tenant-unregistered',
    });
  });
});
