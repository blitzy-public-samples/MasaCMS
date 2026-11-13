import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contentPoolTenants,
  hasGrant,
  poolTenantFor,
  registeredTenants,
  registryEntries,
  registryEntryForTenant,
  siteForTenant,
  tenantForRegisteredSite,
  tenantGrantSql,
  tenantIdForSite,
  tenantRegistryConsumer,
  tenantRegistrySql,
  userPoolFanoutTenants,
  withMetadata,
  withTenant,
  writeGrant,
  type GrantKey,
  type PoolKind,
  type SiteChangedEvent,
  type SiteChangedPayload,
  type TenantRegistryEntry,
} from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  pgAvailable,
  registryPayloads,
  seedRegistry,
  testPgConfig,
  userPoolFanoutExpectation,
  type TenantFixture,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const SERVICE = 'isoreg';
const A = TENANT_A.tenantId;
const B = TENANT_B.tenantId;
const UMBRELLA = TENANT_UMBRELLA.tenantId;
const UNREGISTERED_SITE = 'tenant-z';
const SITE_C = 'tenant-c';
const TENANT_C = tenantIdForSite(SITE_C);
const SURVEY_RESPONSE = 'survey-response';
const SURVEY_ID = '6E2C9A1B-4D7F-4A3E-8B5C0D1E2F3A4B5C';
const OTHER_SURVEY_ID = '0F1E2D3C-4B5A-4968-8776A5B4C3D2E1F0';

const POOLS = [
  { kind: 'publicUser', id: 'publicUserPoolId', tenant: 'publicUserPoolTenant' },
  { kind: 'privateUser', id: 'privateUserPoolId', tenant: 'privateUserPoolTenant' },
  { kind: 'category', id: 'categoryPoolId', tenant: 'categoryPoolTenant' },
  { kind: 'file', id: 'filePoolId', tenant: 'filePoolTenant' },
  { kind: 'display', id: 'displayPoolId', tenant: 'displayPoolTenant' },
] as const satisfies ReadonlyArray<{
  kind: PoolKind;
  id: keyof SiteChangedPayload & keyof TenantRegistryEntry;
  tenant: keyof TenantRegistryEntry;
}>;

const POOL_KINDS: readonly PoolKind[] = POOLS.map((pool) => pool.kind);

/** One expected pool resolution, flattened so the test title can name both sites. */
function poolCase(site: TenantFixture, kind: PoolKind, pool: TenantFixture) {
  return { site: site.siteId, tenantId: site.tenantId, kind, pool: pool.siteId, poolTenant: pool.tenantId };
}

const POOL_CASES = [
  ...POOL_KINDS.map((kind) => poolCase(TENANT_A, kind, kind === 'privateUser' ? TENANT_A : TENANT_UMBRELLA)),
  ...POOL_KINDS.map((kind) => poolCase(TENANT_B, kind, TENANT_B)),
  ...POOL_KINDS.map((kind) => poolCase(TENANT_UMBRELLA, kind, TENANT_UMBRELLA)),
];

/** A site id that registryPayloads always fills. */
function filled(value: string | null | undefined, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`registryPayloads left ${field} empty`);
  }
  return value;
}

/** The content pool site ids of a fixture payload, which registryPayloads always gives as a list. */
function contentIds(payload: SiteChangedPayload): string[] {
  if (!Array.isArray(payload.contentPoolIds)) {
    throw new TypeError(`registryPayloads gave ${payload.siteId} no content pool list`);
  }
  return payload.contentPoolIds;
}

/** The registry entry fields seedRegistry stores for `payload`. */
function expectedEntry(payload: SiteChangedPayload): Record<string, unknown> {
  const content = contentIds(payload);
  const expected: Record<string, unknown> = {
    siteId: payload.siteId,
    tenantId: tenantIdForSite(payload.siteId),
    contentPoolIds: content,
    contentPoolTenants: content.map((id) => tenantIdForSite(id)),
    domains: payload.domains,
    aggregateVersion: 1,
  };
  for (const pool of POOLS) {
    const id = filled(payload[pool.id], pool.id);
    expected[pool.id] = id;
    expected[pool.tenant] = tenantIdForSite(id);
  }
  return expected;
}

/** A `programs-sites.site.changed.v1` event for site tenant-c, whose other pools default to itself. */
function siteChangedC(aggregateVersion: number, filePoolId: string): SiteChangedEvent {
  return { tenantId: TENANT_C, aggregateId: SITE_C, aggregateVersion, payload: { siteId: SITE_C, filePoolId } };
}

describe('tenant registry and grants against PostgreSQL', () => {
  let handle: ThrowawaySchema;

  beforeAll(async () => {
    const config = testPgConfig();
    if (!(await pgAvailable())) {
      throw new Error(`PostgreSQL at ${config.host}:${String(config.port)} (PG_HOST, PG_PORT) is unreachable`);
    }
    handle = await createThrowawaySchema({
      service: SERVICE,
      extraSql: [tenantRegistrySql(SERVICE), tenantGrantSql(SERVICE)],
    });
    await seedRegistry(handle.app);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('registers exactly the three fixture sites', async () => {
    expect(await registeredTenants(handle.app)).toEqual(
      TENANT_LIST.map(({ siteId, tenantId }) => ({ tenantId, siteId })),
    );
  });

  it.each(registryPayloads())('stores $siteId with every pool id and its tenant', async (payload) => {
    const entry = await registryEntryForTenant(handle.app, tenantIdForSite(payload.siteId));
    expect(entry).toMatchObject(expectedEntry(payload));
  });

  it('reads every entry in one call, equal in site order to the entry of each registered tenant', async () => {
    const perTenant: Array<TenantRegistryEntry | null> = [];
    for (const { tenantId } of await registeredTenants(handle.app)) {
      perTenant.push(await registryEntryForTenant(handle.app, tenantId));
    }
    expect(perTenant).toHaveLength(TENANT_LIST.length);
    expect(await registryEntries(handle.app)).toStrictEqual(perTenant);
  });

  it.each(POOL_CASES)("resolves $site's $kind pool to $pool", async ({ tenantId, kind, poolTenant }) => {
    expect(await poolTenantFor(handle.app, tenantId, kind)).toBe(poolTenant);
  });

  it.each(registryPayloads())('resolves the content pool of $siteId to its own tenant', async (payload) => {
    const tenantId = tenantIdForSite(payload.siteId);
    const tenants = await contentPoolTenants(handle.app, tenantId);
    expect(tenants).toEqual(contentIds(payload).map((id) => tenantIdForSite(id)));
    expect(tenants).toEqual([tenantId]);
  });

  it('fans an umbrella user-pool event out to umbrella and the sites pooling their users there', async () => {
    const tenants = await userPoolFanoutTenants(handle.app, UMBRELLA);
    expect(tenants).toEqual([UMBRELLA, A]);
    expect(tenants).not.toContain(B);
    expect(new Set(tenants)).toEqual(userPoolFanoutExpectation(TENANT_UMBRELLA));
  });

  it.each([TENANT_A, TENANT_B])('keeps a user-pool fan-out from $siteId within that site', async (fixture) => {
    const tenants = await userPoolFanoutTenants(handle.app, fixture.tenantId);
    expect(tenants).toEqual([fixture.tenantId]);
    expect(new Set(tenants)).toEqual(userPoolFanoutExpectation(fixture));
  });

  it('resolves registered sites to tenants case-insensitively and tenants back to sites', async () => {
    expect(await tenantForRegisteredSite(handle.app, 'tenant-a')).toBe(A);
    expect(await tenantForRegisteredSite(handle.app, 'TENANT-A')).toBe(A);
    expect(await siteForTenant(handle.app, B)).toBe('tenant-b');
  });

  it('answers null, an empty content pool and a self-only fan-out for an unregistered site', async () => {
    const unregistered = tenantIdForSite(UNREGISTERED_SITE);
    expect(await tenantForRegisteredSite(handle.app, UNREGISTERED_SITE)).toBeNull();
    expect(await siteForTenant(handle.app, unregistered)).toBeNull();
    expect(await registryEntryForTenant(handle.app, unregistered)).toBeNull();
    expect(await poolTenantFor(handle.app, unregistered, 'publicUser')).toBeNull();
    expect(await contentPoolTenants(handle.app, unregistered)).toEqual([]);
    expect(await userPoolFanoutTenants(handle.app, unregistered)).toEqual([unregistered]);
  });

  it('reads the registry inside an open tenant transaction', async () => {
    const resolved = await withTenant(handle.app, A, async (tx) => ({
      pool: await poolTenantFor(tx, A, 'publicUser'),
      fanout: await userPoolFanoutTenants(tx, UMBRELLA),
    }));
    expect(resolved).toEqual({ pool: UMBRELLA, fanout: [UMBRELLA, A] });
  });

  describe('survey-response grants', () => {
    const granted: GrantKey = { grantor: A, grantee: B, kind: SURVEY_RESPONSE, resourceId: SURVEY_ID };

    beforeAll(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await withTenant(handle.app, A, (tx) => writeGrant(tx, { grantee: B, kind: SURVEY_RESPONSE, resourceId: SURVEY_ID }));
      }
    });

    it('stores a repeated grant once, with the writing tenant as grantor', async () => {
      const { rows } = await withMetadata(handle.app, (tx) =>
        tx.query(`SELECT grantor_tenant, grantee_tenant, kind, resource_id FROM ${tx.schema}.tenant_grant`),
      );
      expect(rows).toEqual([{ grantor_tenant: A, grantee_tenant: B, kind: SURVEY_RESPONSE, resource_id: SURVEY_ID }]);
    });

    it.each([
      { label: 'the granted kind and resource', key: granted, expected: true },
      { label: 'another kind', key: { ...granted, kind: 'survey-admin' }, expected: false },
      { label: 'another resource', key: { ...granted, resourceId: OTHER_SURVEY_ID }, expected: false },
      { label: 'the swapped grantor and grantee', key: { ...granted, grantor: B, grantee: A }, expected: false },
      { label: 'the umbrella grantee', key: { ...granted, grantee: UMBRELLA }, expected: false },
    ])('hasGrant is $expected for $label', async ({ key, expected }) => {
      expect(await hasGrant(handle.app, key)).toBe(expected);
    });

    it("finds the grant inside the grantee's tenant transaction", async () => {
      expect(await withTenant(handle.app, B, (tx) => hasGrant(tx, granted))).toBe(true);
    });
  });

  // Own seeded registry, so the site it registers never reaches the fixture-only assertions.
  describe('site.changed consumer', () => {
    let registry: ThrowawaySchema | undefined;

    /** The consumer case's registry database, created in beforeAll. */
    function db(): ThrowawaySchema['app'] {
      if (registry === undefined) {
        throw new Error('beforeAll did not create the consumer registry schema');
      }
      return registry.app;
    }

    beforeAll(async () => {
      registry = await createThrowawaySchema({ service: SERVICE, extraSql: [tenantRegistrySql(SERVICE)] });
      await seedRegistry(registry.app);
    });

    afterAll(async () => {
      await registry?.drop();
    });

    /** Applies `event` in the tenant transaction of the site it describes. */
    function apply(event: SiteChangedEvent): Promise<void> {
      return withTenant(db(), TENANT_C, (tx) => tenantRegistryConsumer.apply(tx, event));
    }

    it('inserts a new site, applies its newer version and ignores a stale one', async () => {
      await apply(siteChangedC(1, SITE_C));
      expect(await registryEntryForTenant(db(), TENANT_C)).toMatchObject({
        siteId: SITE_C,
        tenantId: TENANT_C,
        publicUserPoolTenant: TENANT_C,
        filePoolId: SITE_C,
        filePoolTenant: TENANT_C,
        contentPoolTenants: [TENANT_C],
        aggregateVersion: 1,
      });

      const newer = { filePoolId: TENANT_UMBRELLA.siteId, filePoolTenant: UMBRELLA, aggregateVersion: 2 };
      await apply(siteChangedC(2, TENANT_UMBRELLA.siteId));
      expect(await registryEntryForTenant(db(), TENANT_C)).toMatchObject(newer);

      await apply(siteChangedC(1, SITE_C));
      expect(await registryEntryForTenant(db(), TENANT_C)).toMatchObject(newer);
      const { rows } = await withMetadata(db(), (tx) =>
        tx.query(`SELECT file_pool_id, aggregate_version FROM ${tx.schema}.tenant_registry WHERE site_id = $1`, [SITE_C]),
      );
      expect(rows).toEqual([{ file_pool_id: TENANT_UMBRELLA.siteId, aggregate_version: '2' }]);
      expect(await siteForTenant(db(), TENANT_C)).toBe(SITE_C);
    });
  });
});
