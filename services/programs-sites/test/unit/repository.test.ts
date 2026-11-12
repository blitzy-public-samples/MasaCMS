/** Programs-sites repository helpers against a throwaway `programs_sites` schema: column-scoped site writes, row versions, gates, image sizes, site extend data and tenant isolation. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GateClosedError,
  RepositoryError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  ensureUnitGates,
  withGatedTenant,
  type GatePhase,
  type GateState,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  OWNER,
  SCHEMA,
  SITE_UPDATE_COLUMNS,
  createProgramsSitesRepository,
  type ExtendDataValues,
  type ProgramsSitesRepository,
} from '../../src/repo/repository.js';
import { SITE, UNITS, type ExtendDataRow, type SiteRow } from '../../src/repo/tables.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const BUDGET_MS = 300;
const LAST_DEPLOYMENT = new Date(2026, 0, 2, 3, 4, 5, 6);
const SUBTYPE = 'S0000000-0000-0000-0000000000000001';
const OTHER_SUBTYPE = 'S0000000-0000-0000-0000000000000002';
const BASE_ID = 'B0000000-0000-0000-0000000000000001';
const SIZE_ID = 'ABCDEF00-AAAA-AAAA-AAAAAAAAAAAAAAAA';
const VALUES: ExtendDataValues = { attributevalue: '5', stringvalue: '5', datetimevalue: null, numericvalue: 5, remoteid: '' };
const IMPORTED_DATA_ID = 2147483000;

function siteRow(siteid: string, orderno: number | null): Record<string, unknown> {
  return { siteid, site: `Site ${siteid}`, emailbroadcasterlimit: 0, orderno, deploy: 0, lastdeployment: LAST_DEPLOYMENT };
}

describe('programs-sites repository identity', () => {
  it('extends the platform repository of the owned tables', () => {
    const repository = createProgramsSitesRepository({ clock: CLOCK });

    expect([OWNER, SCHEMA]).toEqual(['programs-sites', 'programs_sites']);
    expect(Object.isFrozen(repository)).toBe(true);
    expect(repository).toMatchObject({ owner: OWNER, schema: SCHEMA });
    expect(repository.units()).toEqual([...UNITS]);
  });

  it('lists exactly the settingsDAO.update SET columns, all declared on programs_sites.site', () => {
    const declared = new Set(SITE.columns.map((column) => column.name));

    expect(SITE_UPDATE_COLUMNS).toHaveLength(90);
    expect(SITE_UPDATE_COLUMNS.filter((column) => !declared.has(column))).toEqual([]);
    for (const column of ['siteid', 'orderno', 'deploy', 'lastdeployment', 'row_version', 'tenant_id']) {
      expect(SITE_UPDATE_COLUMNS).not.toContain(column);
    }
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('programs-sites repository against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repository: ProgramsSitesRepository;
  let tenants = 0;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'programs-sites',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    repository = createProgramsSitesRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    tenants += 1;
    tenantId = tenantIdForSite(`programs-sites-repository-${tenants}`);
    otherTenantId = tenantIdForSite(`programs-sites-repository-${tenants}-other`);
    await gated(async (tx) => {
      for (const [siteid, orderno] of [['zeta', 2], ['alpha', 2], ['nul', null], ['first', 1]] as const) {
        await repository.insert(tx, SITE.table, siteRow(siteid, orderno));
      }
    });
  });

  async function setGates(state: GateState, phase: GatePhase = 'quiet'): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $1, holder_id = $2, phase = $3`, [
        state,
        state === 'closed' ? 'test-holder' : null,
        phase,
      ]),
    );
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  function gated<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return withGatedTenant(handle.app, tenant, fn, { budgetMs: BUDGET_MS });
  }

  async function changelog(): Promise<{ table: string; op: string }[]> {
    return inTenant(async (tx) => (await tx.query<{ table: string; op: string }>(`SELECT "table", op FROM ${handle.schema}.changelog ORDER BY seq`)).rows);
  }

  it('lists the tenant sites by orderno with NULLs first and ties by siteid, and reads one by its exact siteid', async () => {
    expect((await inTenant((tx) => repository.listSites(tx))).map((row) => row.siteid)).toEqual(['nul', 'first', 'alpha', 'zeta']);
    expect(await inTenant((tx) => repository.readSite(tx, 'alpha'))).toMatchObject({ siteid: 'alpha', site: 'Site alpha', row_version: '0' });
    expect(await inTenant((tx) => repository.readSite(tx, 'ALPHA'))).toBeNull();
  });

  it('updates only the SET columns, adds 1 to row_version and writes one changelog row', async () => {
    const logged = (await changelog()).length;
    const stored = await gated(async (tx) => {
      const before = (await repository.readSite(tx, 'zeta')) as SiteRow;
      const after = { ...before, site: 'Renamed', domain: 'zeta.example', siteid: 'other', orderno: 99, deploy: 1, lastdeployment: null, filedir: 'x', row_version: '77' };
      return repository.updateSiteRow(tx, before, after);
    });

    expect(stored).toMatchObject({ siteid: 'zeta', site: 'Renamed', domain: 'zeta.example', orderno: 2, deploy: 0, filedir: null, row_version: '1' });
    expect(stored?.lastdeployment).toEqual(LAST_DEPLOYMENT);
    expect((await changelog()).slice(logged)).toEqual([{ table: 'site', op: 'update' }]);
  });

  it('rolls the site write and its changelog row back together', async () => {
    const logged = (await changelog()).length;
    const failed = gated(async (tx) => {
      const before = (await repository.readSite(tx, 'zeta')) as SiteRow;
      await repository.updateSiteRow(tx, before, { site: 'Lost' });
      throw new Error('abort');
    });

    await expect(failed).rejects.toThrow('abort');
    expect(await changelog()).toHaveLength(logged);
    expect(await inTenant((tx) => repository.readSite(tx, 'zeta'))).toMatchObject({ site: 'Site zeta', row_version: '0' });
  });

  it.each([
    ['updateOrderNo', 'orderno', 7, (tx: TenantTx, siteId: string) => repository.updateOrderNo(tx, siteId, 7)],
    ['updateDeploy', 'deploy', 1, (tx: TenantTx, siteId: string) => repository.updateDeploy(tx, siteId, 1)],
  ] as const)('%s sets only %s and adds 1 to row_version; null for an absent site', async (_name, column, value, write) => {
    const before = (await inTenant((tx) => repository.readSite(tx, 'zeta'))) as SiteRow;
    const stored = await gated((tx) => write(tx, 'zeta'));

    expect(stored).toEqual({ ...before, [column]: value, row_version: '1' });
    expect(await gated((tx) => write(tx, 'missing'))).toBeNull();
    expect(await gated((tx) => write(tx, 'zeta'), otherTenantId)).toBeNull();
  });

  it('returns null from updateSiteRow when the site is absent', async () => {
    const before = { ...siteRow('missing', 1), tenant_id: tenantId, row_version: '0' } as unknown as SiteRow;

    expect(await gated((tx) => repository.updateSiteRow(tx, before, { site: 'x' }))).toBeNull();
  });

  it('gives concurrent writers of one site distinct row versions', async () => {
    await Promise.all([1, 2, 3].map((orderNo) => gated((tx) => repository.updateOrderNo(tx, 'first', orderNo))));

    expect(await inTenant((tx) => repository.readSite(tx, 'first'))).toMatchObject({ row_version: '3' });
  });

  it('waits on a closed gate then fails with the legacy 503, and rejects writes of a legacy unit', async () => {
    await setGates('closed');
    const started = Date.now();
    await expect(gated((tx) => repository.updateDeploy(tx, 'zeta', 1))).rejects.toBeInstanceOf(GateClosedError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - 50);

    await setGates('legacy');
    await expect(gated((tx) => repository.updateDeploy(tx, 'zeta', 1))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
  });

  it.each(['executing', 'importing', 'import-pending'] as const)('blocks reads while a window is %s', async (phase) => {
    await setGates('closed', phase);

    await expect(gated((tx) => repository.listSites(tx))).rejects.toBeInstanceOf(UnitReadBlockedError);
    await expect(gated((tx) => repository.readSite(tx, 'zeta'))).rejects.toBeInstanceOf(UnitReadBlockedError);
    await expect(gated((tx) => repository.listImageSizes(tx, 'alpha'))).rejects.toBeInstanceOf(UnitReadBlockedError);
  });

  it('saves image sizes by sizeid or under a new CF UUID, finds, lists and deletes them', async () => {
    const inserted = await gated((tx) => repository.saveImageSize(tx, { siteid: 'alpha', name: 'w200', height: 'AUTO', width: '200' }));
    const fixedId = 'AAAAAAAA-AAAA-AAAA-AAAAAAAAAAAAAAAA';
    const updated = await gated((tx) =>
      repository.saveImageSize(tx, { sizeid: inserted.sizeid, siteid: 'alpha', name: 'w300', height: 'AUTO', width: '300' }),
    );
    await gated((tx) => repository.saveImageSize(tx, { sizeid: fixedId, siteid: 'alpha', name: 'h100', height: '100', width: 'AUTO' }));

    expect(inserted.sizeid).toMatch(CF_UUID);
    expect(updated).toEqual({ ...inserted, name: 'w300', width: '300' });
    await inTenant(async (tx) => {
      expect((await repository.listImageSizes(tx, 'alpha')).map((row) => row.sizeid)).toEqual([inserted.sizeid, fixedId].sort());
      expect(await repository.listImageSizes(tx, 'zeta')).toEqual([]);
      expect(await repository.findImageSize(tx, { sizeId: fixedId })).toMatchObject({ name: 'h100' });
      expect(await repository.findImageSize(tx, { name: 'w300', siteId: 'alpha' })).toMatchObject({ sizeid: inserted.sizeid });
      expect(await repository.findImageSize(tx, { name: 'w300', siteId: 'zeta' })).toBeNull();
    });
    expect(await gated((tx) => repository.deleteImageSize(tx, fixedId), otherTenantId)).toBe(false);
    expect(await gated((tx) => repository.deleteImageSize(tx, fixedId))).toBe(true);
    expect(await inTenant((tx) => repository.findImageSize(tx, { sizeId: fixedId }))).toBeNull();
  });

  it.each([
    ['a lower-cased sizeId', { sizeId: SIZE_ID.toLowerCase() }],
    ['a differently cased name with a trailing space in a differently cased siteId', { name: 'large ', siteId: 'ALPHA' }],
  ])('finds the stored image size by %s, as SQL Server equality does', async (_label, by) => {
    await gated((tx) => repository.saveImageSize(tx, { sizeid: SIZE_ID, siteid: 'alpha', name: 'Large', height: '100', width: 'AUTO' }));
    expect((await inTenant((tx) => repository.findImageSize(tx, by)))?.sizeid).toBe(SIZE_ID);
  });

  it.each([
    ['the expansion of a stored ß', 'Straße', 'STRASSE', true],
    ['a soft hyphen SQL Server does not ignore', 'large', 'lar\u00ADge', false],
  ])('finds an image size by a name differing by %s only as SQL Server nvarchar equality does', async (_label, stored, name, matches) => {
    await gated((tx) => repository.saveImageSize(tx, { sizeid: SIZE_ID, siteid: 'alpha', name: stored, height: '100', width: 'AUTO' }));
    expect((await inTenant((tx) => repository.findImageSize(tx, { name, siteId: 'alpha' })))?.name).toBe(matches ? stored : undefined);
  });

  it('saves, lists and deletes an image size by a lower-cased sizeid and differently cased siteid, keeping the stored case', async () => {
    await gated((tx) => repository.saveImageSize(tx, { sizeid: SIZE_ID, siteid: 'alpha', name: 'large', height: '100', width: 'AUTO' }));
    const updated = await gated((tx) =>
      repository.saveImageSize(tx, { sizeid: SIZE_ID.toLowerCase(), siteid: 'alpha', name: 'larger', height: '200', width: 'AUTO' }),
    );

    expect(updated).toMatchObject({ sizeid: SIZE_ID, name: 'larger', height: '200' });
    expect((await inTenant((tx) => repository.listImageSizes(tx, 'Alpha'))).map((row) => row.sizeid)).toEqual([SIZE_ID]);
    expect(await gated((tx) => repository.deleteImageSize(tx, SIZE_ID.toLowerCase()))).toBe(true);
    expect(await inTenant((tx) => repository.listImageSizes(tx, 'alpha'))).toEqual([]);
  });

  describe('site extend definitions and data', () => {
    beforeEach(async () => {
      await gated(async (tx) => {
        const insert = (table: string, row: Record<string, unknown>): Promise<unknown> => repository.insert(tx, table, row);
        await insert('extend_subtype', { subtypeid: SUBTYPE, siteid: 'alpha', basetable: 'tsettings', type: 'Site', subtype: 'Default' });
        await insert('extend_subtype', { subtypeid: OTHER_SUBTYPE, siteid: 'zeta', basetable: 'tsettings', type: 'Site', subtype: 'Default' });
        await insert('extend_set', { extendsetid: 'SET2', subtypeid: SUBTYPE, siteid: 'alpha', name: 'B', orderno: 2 });
        await insert('extend_set', { extendsetid: 'SET1', subtypeid: SUBTYPE, siteid: 'alpha', name: 'A', orderno: null });
        await insert('extend_set', { extendsetid: 'SETZ', subtypeid: OTHER_SUBTYPE, siteid: 'zeta', name: 'Z', orderno: 1 });
        await insert('extend_attribute', { attributeid: 11, extendsetid: 'SET1', siteid: 'alpha', name: 'b', orderno: 1 });
        await insert('extend_attribute', { attributeid: 10, extendsetid: 'SET1', siteid: 'alpha', name: 'a', orderno: 1 });
        await insert('extend_attribute', { attributeid: 12, extendsetid: 'SET2', siteid: 'alpha', name: 'c', orderno: null });
        await insert('extend_attribute', { attributeid: 13, extendsetid: 'SETZ', siteid: 'zeta', name: 'z', orderno: 1 });
        await insert('extend_rc_set', { relatedcontentsetid: 'RC1', subtypeid: SUBTYPE, siteid: 'alpha', name: 'rc', orderno: 1 });
        await insert('extend_data', { dataid: 1, baseid: BASE_ID, attributeid: 10, siteid: 'alpha', attributevalue: 'old1' });
        await insert('extend_data', { dataid: 2, baseid: BASE_ID, attributeid: 10, siteid: 'alpha', attributevalue: 'old2' });
        await insert('extend_data', { dataid: 3, baseid: BASE_ID, attributeid: 11, siteid: 'alpha', attributevalue: 'keep' });
      });
    });

    it('reads one site definitions in legacy order', async () => {
      const definitions = await inTenant((tx) => repository.readSiteExtendDefinitions(tx, 'alpha'));

      expect(definitions.subtypes.map((row) => row.subtypeid)).toEqual([SUBTYPE]);
      expect(definitions.sets.map((row) => row.extendsetid.trim())).toEqual(['SET1', 'SET2']);
      expect(definitions.attributes.map((row) => row.attributeid)).toEqual([12, 10, 11]);
      expect(definitions.rcsets.map((row) => row.relatedcontentsetid.trim())).toEqual(['RC1']);
      expect(await inTenant((tx) => repository.readSiteExtendDefinitions(tx, 'alpha'), otherTenantId)).toEqual({
        subtypes: [],
        sets: [],
        attributes: [],
        rcsets: [],
      });
    });

    it('replaces every row of one base and attribute under fresh ascending negative ids, one changelog row per write, and leaves other rows', async () => {
      await gated((tx) => repository.insert(tx, 'extend_data', { dataid: IMPORTED_DATA_ID, baseid: BASE_ID, attributeid: 12, siteid: 'alpha', attributevalue: 'imported' }));
      const logged = (await changelog()).length;
      const replace = (): Promise<ExtendDataRow | null> =>
        gated((tx) => repository.replaceSiteExtendData(tx, { baseId: BASE_ID, siteId: 'alpha', attributeId: 10, values: VALUES }));

      const first = await replace();
      const second = await replace();

      expect(first).toMatchObject({ dataid: -2147483648, baseid: BASE_ID, attributeid: 10, siteid: 'alpha', ...VALUES });
      expect(second).toMatchObject({ dataid: -2147483647 });
      expect(second?.dataid).toBeGreaterThan(first?.dataid ?? 0);
      expect((await changelog()).slice(logged).map((row) => row.op)).toEqual(['delete', 'delete', 'insert', 'delete', 'insert']);
      expect((await inTenant((tx) => repository.readSiteExtendData(tx, BASE_ID))).map((row) => [row.attributeid, row.dataid])).toEqual([
        [10, -2147483647],
        [11, 3],
        [12, IMPORTED_DATA_ID],
      ]);
    });

    it('fails with a RepositoryError and writes nothing when dataid has no sequence', async () => {
      const owned = async (target: string): Promise<void> => {
        const client = await handle.migratorPool.connect();
        try {
          await client.query(`SET ROLE ${handle.roles.owner}`);
          await client.query(`ALTER SEQUENCE ${handle.schema}.extend_data_dataid_seq OWNED BY ${target}`);
        } finally {
          await client.query('RESET ROLE');
          client.release();
        }
      };
      await owned('NONE');
      try {
        const failure = await gated((tx) =>
          repository.replaceSiteExtendData(tx, { baseId: BASE_ID, siteId: 'alpha', attributeId: 10, values: VALUES }),
        ).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(RepositoryError);
        expect(failure).toMatchObject({ message: 'extend_data: column dataid has no id sequence' });
        expect((await inTenant((tx) => repository.readSiteExtendData(tx, BASE_ID))).map((row) => row.dataid)).toEqual([1, 2, 3]);
      } finally {
        await owned(`${handle.schema}.extend_data.dataid`);
      }
    });

    it('only deletes when the values are null', async () => {
      expect(await gated((tx) => repository.replaceSiteExtendData(tx, { baseId: BASE_ID, siteId: 'alpha', attributeId: 11, values: null }))).toBeNull();
      expect((await inTenant((tx) => repository.readSiteExtendData(tx, BASE_ID))).map((row) => row.dataid)).toEqual([1, 2]);
      expect(await inTenant((tx) => repository.readSiteExtendData(tx, BASE_ID), otherTenantId)).toEqual([]);
    });
  });

  it('confines reads and writes to the transaction tenant, and a reused pooled connection sees no rows', async () => {
    expect(await inTenant((tx) => repository.listSites(tx), otherTenantId)).toEqual([]);
    expect(await inTenant((tx) => repository.readSite(tx, 'alpha'), otherTenantId)).toBeNull();
    await expect(gated((tx) => repository.insert(tx, SITE.table, { ...siteRow('evil', 1), tenant_id: tenantId }), otherTenantId)).rejects.toThrow();

    await inTenant((tx) => repository.listSites(tx));
    const { rows } = await handle.appPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${handle.schema}.site`);
    expect(rows[0]?.n).toBe(0);
  });
});
