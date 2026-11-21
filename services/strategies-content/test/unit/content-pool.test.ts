/** domain/pools content-pool reads over PostgreSQL: registry-resolved pool sites, one RLS-scoped transaction per pool tenant, merged in registered order. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TENANT_SETTING, tenantRegistryConsumer, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, registryPayloads, type TenantFixture, type ThrowawaySchema } from '@opt2/platform/testing';
import { contentPoolSites, feedPoolSites, readAcrossContentPool, type PoolSite } from '../../src/domain/pools.js';
import { CONTENT } from '../../src/repo/tables.js';
import { pgAvailable, withPgSchema } from '../helpers/app.js';
import { contentRow, seedRows, seedTenantRegistry } from '../helpers/seed.js';

/** Masa `contentPoolID` text of tenant-a: itself, tenant-b and the unregistered site `ghost`. */
const TENANT_A_CONTENT_POOL = 'tenant-a,tenant-b,ghost';

/** Titles seeded per tenant in insertion order, which no tenant's title order matches; `Tie` is shared by tenant-a and tenant-b. */
const SEEDED_TITLES: ReadonlyArray<readonly [TenantFixture, readonly string[]]> = [
  [TENANT_A, ['Delta', 'Tie', 'Alpha']],
  [TENANT_B, ['Charlie', 'Tie', 'Bravo']],
  [TENANT_UMBRELLA, ['Umbrella Only', 'Aardvark']],
];

const SITE_A: PoolSite = { siteId: TENANT_A.siteId, tenantId: TENANT_A.tenantId };
const SITE_B: PoolSite = { siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId };
const SITE_UMBRELLA: PoolSite = { siteId: TENANT_UMBRELLA.siteId, tenantId: TENANT_UMBRELLA.tenantId };

/** A merged row: the pool site that read it and its title. */
interface PoolRow {
  siteId: string;
  title: string;
}

/** What one `fn` call saw inside its transaction. */
interface PoolRead {
  site: PoolSite;
  tenantSetting: string;
  rows: Array<{ tenant_id: string; title: string }>;
}

/** Legacy `ORDER BY title`. */
const byTitle = (a: PoolRow, b: PoolRow): number => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

/** A read of every `content` row visible in `tx`, in insertion order, recording each call into `calls`. */
function recordingRead(calls: PoolRead[]): (tx: TenantTx, site: PoolSite) => Promise<PoolRow[]> {
  return async (tx, site) => {
    const setting = await tx.query<{ tenant: string }>(`SELECT current_setting('${TENANT_SETTING}', true) AS tenant`);
    const { rows } = await tx.query<{ tenant_id: string; title: string }>(`SELECT tenant_id, title FROM ${tx.schema}.content ORDER BY tcontent_id`);
    calls.push({ site, tenantSetting: setting.rows[0]?.tenant ?? '', rows });
    return rows.map((row) => ({ siteId: site.siteId, title: row.title }));
  };
}

/** The rows `site` contributes, in insertion order. */
function seededRows(site: PoolSite): PoolRow[] {
  const titles = SEEDED_TITLES.find(([fixture]) => fixture.tenantId === site.tenantId)?.[1] ?? [];
  return titles.map((title) => ({ siteId: site.siteId, title }));
}

describe.skipIf(!(await pgAvailable()))('domain/pools content-pool reads over the registry and RLS', () => {
  let handle: ThrowawaySchema;

  beforeAll(async () => {
    handle = await withPgSchema();
    await seedTenantRegistry(handle);
    const payload = registryPayloads().find((candidate) => candidate.siteId === TENANT_A.siteId);
    if (payload === undefined) throw new Error('registryPayloads() has no tenant-a entry');
    await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      tenantRegistryConsumer.apply(tx, {
        tenantId: TENANT_A.tenantId,
        aggregateVersion: 2,
        payload: { ...payload, contentPoolIds: TENANT_A_CONTENT_POOL },
      }),
    );
    for (const [tenant, titles] of SEEDED_TITLES) {
      await seedRows(
        handle,
        tenant,
        titles.map((title) => ({ table: CONTENT, row: contentRow({ tenant_id: tenant.tenantId, siteid: tenant.siteId, title }) })),
      );
    }
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('contentPoolSites resolves tenant-a pool sites in registered order and drops the unregistered ghost site', async () => {
    expect(await contentPoolSites(handle.app, TENANT_A.tenantId)).toEqual([SITE_A, SITE_B]);
  });

  it('contentPoolSites resolves an own-only pool to the site itself', async () => {
    expect(await contentPoolSites(handle.app, TENANT_B.tenantId)).toEqual([SITE_B]);
  });

  it.each<[string, string, PoolSite[]]>([
    ["'' (own site)", '', [SITE_A]],
    ["'*' (registered content pool)", '*', [SITE_A, SITE_B]],
    ["'tenant-b'", 'tenant-b', [SITE_B]],
    ["'tenant-b,tenant-a' (list order)", 'tenant-b,tenant-a', [SITE_B, SITE_A]],
    ["'tenant-b,ghost,umbrella' (unregistered and out-of-pool sites dropped)", 'tenant-b,ghost,umbrella', [SITE_B]],
  ])('feedPoolSites %s', async (_label, feedContentPoolId, expected) => {
    expect(await feedPoolSites(handle.app, TENANT_A.tenantId, feedContentPoolId)).toEqual(expected);
  });

  it("feedPoolSites '*' equals contentPoolSites", async () => {
    expect(await feedPoolSites(handle.app, TENANT_A.tenantId, '*')).toEqual(await contentPoolSites(handle.app, TENANT_A.tenantId));
  });

  it('readAcrossContentPool runs fn once per pool site, in registered order, each in its own tenant with only its own rows', async () => {
    const sites = await contentPoolSites(handle.app, TENANT_A.tenantId);
    const calls: PoolRead[] = [];
    await readAcrossContentPool(handle.app, sites, recordingRead(calls));
    expect(calls.map((call) => call.site)).toEqual([SITE_A, SITE_B]);
    for (const call of calls) {
      expect(call.tenantSetting).toBe(call.site.tenantId);
      expect(call.rows.map((row) => row.tenant_id)).toEqual(call.rows.map(() => call.site.tenantId));
      expect(call.rows.map((row) => row.title)).toEqual(seededRows(call.site).map((row) => row.title));
    }
  });

  it('readAcrossContentPool without compare concatenates per-tenant rows in registered order', async () => {
    const sites = await contentPoolSites(handle.app, TENANT_A.tenantId);
    expect(await readAcrossContentPool(handle.app, sites, recordingRead([]))).toEqual([...seededRows(SITE_A), ...seededRows(SITE_B)]);
  });

  it('readAcrossContentPool with compare sorts the merged rows and keeps registered order on a cross-tenant tie', async () => {
    const sites = await contentPoolSites(handle.app, TENANT_A.tenantId);
    expect(await readAcrossContentPool(handle.app, sites, recordingRead([]), byTitle)).toEqual([
      { siteId: TENANT_A.siteId, title: 'Alpha' },
      { siteId: TENANT_B.siteId, title: 'Bravo' },
      { siteId: TENANT_B.siteId, title: 'Charlie' },
      { siteId: TENANT_A.siteId, title: 'Delta' },
      { siteId: TENANT_A.siteId, title: 'Tie' },
      { siteId: TENANT_B.siteId, title: 'Tie' },
    ]);
  });

  it('readAcrossContentPool never reads a registered tenant outside the pool', async () => {
    const calls: PoolRead[] = [];
    const merged = await readAcrossContentPool(handle.app, await contentPoolSites(handle.app, TENANT_A.tenantId), recordingRead(calls), byTitle);
    const umbrellaTitles = seededRows(SITE_UMBRELLA).map((row) => row.title);
    expect(calls.map((call) => call.tenantSetting)).not.toContain(TENANT_UMBRELLA.tenantId);
    expect(merged.map((row) => row.siteId)).not.toContain(TENANT_UMBRELLA.siteId);
    expect(merged.filter((row) => umbrellaTitles.includes(row.title))).toEqual([]);
    const umbrella = await readAcrossContentPool(handle.app, await contentPoolSites(handle.app, TENANT_UMBRELLA.tenantId), recordingRead([]));
    expect(umbrella).toEqual(seededRows(SITE_UMBRELLA));
  });

  it('readAcrossContentPool over an empty site list returns [] without calling fn', async () => {
    const fn = vi.fn(recordingRead([]));
    expect(await readAcrossContentPool(handle.app, [], fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
