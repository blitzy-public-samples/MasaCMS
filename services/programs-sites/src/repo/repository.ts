/** The only write path of schema `programs_sites`: the platform repository plus the site, image-size and site extend helpers. */
import {
  createRepository,
  qualified,
  type Repository,
  type RepositoryRow,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import type { MetadataTx, QueryResultRow, TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_RC_SET,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  IMAGE_SIZE,
  OWNED_TABLES,
  SITE,
  SITE_MONITOR_STATE,
  type ExtendAttributeRow,
  type ExtendDataRow,
  type ExtendRcSetRow,
  type ExtendSetRow,
  type ExtendSubtypeRow,
  type ImageSizeRow,
  type SiteRow,
} from './tables.js';

/** Service name the programs-sites write positions carry. */
export const OWNER = 'programs-sites';

/** Schema the programs-sites service owns. */
export const SCHEMA = 'programs_sites';

/** An image size to save; without `sizeid` it is inserted under a new CF UUID. */
export type ImageSizeInput = Pick<ImageSizeRow, 'siteid' | 'name' | 'height' | 'width'> & { sizeid?: string };

/** Lookup of `settingsImageSizeBean.getQuery`: by `sizeId`, else by `name` within `siteId`, compared with SQL Server's equality, trailing spaces of `sizeId` and `name` ignored. */
export type ImageSizeLookup = { sizeId: string } | { name: string; siteId: string };

const SITE_LIST_COLUMNS = ['siteid', 'site', 'domain', 'orderno', 'deploy', 'lastdeployment'] as const;
const SITE_SELECTOR_COLUMNS = ['siteid', 'site', 'orderno', 'domain', 'domainalias', 'showdashboard'] as const;
const SITE_DOMAIN_COLUMNS = ['siteid', 'domain', 'domainalias', 'isremote', 'resourcedomain'] as const;

/** The site columns of a Sites screen row. */
export type SiteListRow = Pick<SiteRow, (typeof SITE_LIST_COLUMNS)[number]>;

/** The site columns `getUserSites` and `bindToDomain` read. */
export type SiteSelectorRow = Pick<SiteRow, (typeof SITE_SELECTOR_COLUMNS)[number]>;

/** The site columns `getAccessControlOriginDomainList` and `getSite(siteId).getDomain()` read. */
export type SiteDomainRow = Pick<SiteRow, (typeof SITE_DOMAIN_COLUMNS)[number]>;

/** One `tenant_registry` site and its tenant. */
export interface RegisteredSite {
  siteId: string;
  tenantId: string;
}

/** A keyset page request: at most `limit` entries after the key `after`, from the first when null. */
export interface KeysetPage {
  after: string | null;
  limit: number;
}

/** The programs-sites extend definitions of one site, each list in legacy display order. */
export interface SiteExtendDefinitions {
  subtypes: ExtendSubtypeRow[];
  sets: ExtendSetRow[];
  attributes: ExtendAttributeRow[];
  rcsets: ExtendRcSetRow[];
}

/** The platform repository of schema `programs_sites` plus typed helpers; every helper runs in the caller's open tenant transaction, the registry page in its metadata one. */
export interface ProgramsSitesRepository extends Repository {
  /** The site row with exactly `siteId`; null when absent. */
  readSite(tx: TenantTx, siteId: string): Promise<SiteRow | null>;
  /** The Sites screen columns of every site of the transaction tenant by `orderno` ascending, NULLs first, ties by `siteid`. */
  listSites(tx: TenantTx): Promise<SiteListRow[]>;
  /** The site selector columns of every site of the transaction tenant, in `listSites` order. */
  listSiteSelectorRows(tx: TenantTx): Promise<SiteSelectorRow[]>;
  /** The origin-domain columns of every site of the transaction tenant, in `listSites` order. */
  listSiteDomains(tx: TenantTx): Promise<SiteDomainRow[]>;
  /** The first site in `listSites` order whose siteid SQL Server's `siteid = ?` matches: case-insensitive, trailing spaces ignored; null when none does. */
  matchSite(tx: TenantTx, siteId: string): Promise<SiteRow | null>;
  /** Sets `orderno` and adds 1 to `row_version`; null when the site is absent. */
  updateOrderNo(tx: TenantTx, siteId: string, orderNo: number, ctx?: WriteContext): Promise<SiteRow | null>;
  /** Sets `deploy` and adds 1 to `row_version`; null when the site is absent. */
  updateDeploy(tx: TenantTx, siteId: string, deploy: number, ctx?: WriteContext): Promise<SiteRow | null>;
  /** The image sizes of `siteId`, by `sizeid`. */
  listImageSizes(tx: TenantTx, siteId: string): Promise<ImageSizeRow[]>;
  /** One keyset page of the image sizes of `siteId`, by `sizeid`. */
  listImageSizePage(tx: TenantTx, siteId: string, page: KeysetPage): Promise<ImageSizeRow[]>;
  /** One keyset page of the registered sites by site id, read from the non-tenant `tenant_registry` in `tx`. */
  listRegisteredSitePage(tx: MetadataTx, page: KeysetPage): Promise<RegisteredSite[]>;
  /** The first image size matching `by` under SQL Server equality; null when none does. */
  findImageSize(tx: TenantTx, by: ImageSizeLookup): Promise<ImageSizeRow | null>;
  /** Updates the stored size with `row.sizeid`, else inserts it, and returns the stored row. */
  saveImageSize(tx: TenantTx, row: ImageSizeInput, ctx?: WriteContext): Promise<ImageSizeRow>;
  /** Deletes the size with `sizeId`; false when absent. */
  deleteImageSize(tx: TenantTx, sizeId: string, ctx?: WriteContext): Promise<boolean>;
  /** The subtypes of `siteId` with their sets, the sets' attributes and the related-content sets. */
  readSiteExtendDefinitions(tx: TenantTx, siteId: string): Promise<SiteExtendDefinitions>;
  /** Every stored extend value of `baseId`, by `attributeid` then `dataid`. */
  readSiteExtendData(tx: TenantTx, baseId: string): Promise<ExtendDataRow[]>;
}

/** Settings of `createProgramsSitesRepository`; `schema` differs from `programs_sites` only for throwaway test schemas. */
export interface ProgramsSitesRepositoryOptions {
  clock: Clock;
  schema?: string;
}

/** The next `row_version` of `row`; pg returns int8 as a decimal string. */
function nextRowVersion(row: SiteRow): string {
  return String(BigInt(row.row_version) + 1n);
}

/** Builds the programs-sites repository over the platform repository of `OWNED_TABLES` and the unit-less `SITE_MONITOR_STATE`. */
export function createProgramsSitesRepository({ clock, schema = SCHEMA }: ProgramsSitesRepositoryOptions): ProgramsSitesRepository {
  const base = createRepository({ owner: OWNER, schema, tables: [...OWNED_TABLES, SITE_MONITOR_STATE], clock });
  const site = qualified(schema, SITE.table);
  const imageSize = qualified(schema, IMAGE_SIZE.table);
  const subtype = qualified(schema, EXTEND_SUBTYPE.table);
  const set = qualified(schema, EXTEND_SET.table);
  const attribute = qualified(schema, EXTEND_ATTRIBUTE.table);
  const rcSet = qualified(schema, EXTEND_RC_SET.table);
  const data = qualified(schema, EXTEND_DATA.table);

  const siteOrder = 'ORDER BY orderno ASC NULLS FIRST, siteid';
  const siteColumnsSql = (columns: readonly string[]): string =>
    `SELECT ${columns.join(', ')} FROM ${site} WHERE tenant_id = $1 ${siteOrder}`;
  const listSitesSql = siteColumnsSql(SITE_LIST_COLUMNS);
  const siteSelectorSql = siteColumnsSql(SITE_SELECTOR_COLUMNS);
  const siteDomainsSql = siteColumnsSql(SITE_DOMAIN_COLUMNS);
  // The imageSizeByNameSql equality on siteid, so one row answers where the exact key read found none.
  const matchSiteSql =
    `SELECT * FROM ${site} WHERE tenant_id = $1 AND (siteid::bpchar COLLATE ${qualified(schema, 'legacy_ci')}) = $2::bpchar` +
    ` ${siteOrder} LIMIT 1`;
  const lockSiteSql = `SELECT * FROM ${site} WHERE tenant_id = $1 AND siteid = $2 FOR UPDATE`;
  const imageSizesSql = `SELECT * FROM ${imageSize} WHERE tenant_id = $1 AND siteid = $2 ORDER BY sizeid`;
  const imageSizePageSql = `SELECT * FROM ${imageSize} WHERE tenant_id = $1 AND siteid = $2 ORDER BY sizeid LIMIT $3`;
  const imageSizePageAfterSql = `SELECT * FROM ${imageSize} WHERE tenant_id = $1 AND siteid = $2 AND sizeid > $3 ORDER BY sizeid LIMIT $4`;
  const registry = qualified(schema, 'tenant_registry');
  const registryPageSql = `SELECT site_id, tenant_id FROM ${registry} WHERE NOT deleted ORDER BY site_id LIMIT $1`;
  const registryPageAfterSql = `SELECT site_id, tenant_id FROM ${registry} WHERE site_id > $1 AND NOT deleted ORDER BY site_id LIMIT $2`;
  // SQL Server's nvarchar equality, leakproof and so indexable under forced RLS: bpchar ignores trailing spaces, legacy_ci compares the rest.
  const imageSizeByNameSql =
    `SELECT * FROM ${imageSize} WHERE tenant_id = $1 AND (name::bpchar COLLATE ${qualified(schema, 'legacy_ci')}) = $2::bpchar` +
    ' AND siteid = $3 ORDER BY sizeid LIMIT 1';
  // Legacy orders: subtypes by type and subtype (extendSubType.cfc:141), sets by orderno (extendSubType.cfc:882),
  // attributes by orderno and name (extendSet.cfc:272), related-content sets by orderno (extendSubType.cfc:536).
  const subtypesSql =
    `SELECT * FROM ${subtype} WHERE tenant_id = $1 AND siteid = $2` +
    ' ORDER BY lower(type) ASC NULLS FIRST, lower(subtype) ASC NULLS FIRST, subtypeid';
  const setsSql =
    `SELECT s.* FROM ${set} s JOIN ${subtype} t ON t.tenant_id = s.tenant_id AND t.subtypeid = s.subtypeid` +
    ' WHERE s.tenant_id = $1 AND s.siteid = $2 ORDER BY s.orderno ASC NULLS FIRST, s.extendsetid';
  const attributesSql =
    `SELECT a.* FROM ${attribute} a JOIN ${set} s ON s.tenant_id = a.tenant_id AND s.extendsetid = a.extendsetid` +
    ` JOIN ${subtype} t ON t.tenant_id = s.tenant_id AND t.subtypeid = s.subtypeid` +
    ' WHERE a.tenant_id = $1 AND s.siteid = $2 ORDER BY a.orderno ASC NULLS FIRST, lower(a.name) ASC NULLS FIRST, a.attributeid';
  const rcSetsSql =
    `SELECT r.* FROM ${rcSet} r JOIN ${subtype} t ON t.tenant_id = r.tenant_id AND t.subtypeid = r.subtypeid` +
    ' WHERE r.tenant_id = $1 AND r.siteid = $2 ORDER BY r.orderno ASC NULLS FIRST, r.relatedcontentsetid';
  const extendDataSql = `SELECT * FROM ${data} WHERE tenant_id = $1 AND baseid = $2 ORDER BY attributeid, dataid`;

  function readSite(tx: TenantTx, siteId: string): Promise<SiteRow | null> {
    return base.findByKey<SiteRow>(tx, SITE.table, { siteid: siteId });
  }

  /** The rows of `sql` over the transaction tenant's sites, read behind the site unit's read fence. */
  function siteRows<R extends QueryResultRow>(tx: TenantTx, sql: string): Promise<R[]> {
    return base.read(tx, SITE.unit, async () => (await tx.query<R>(sql, [tx.tenantId])).rows);
  }

  function listSites(tx: TenantTx): Promise<SiteListRow[]> {
    return siteRows<SiteListRow>(tx, listSitesSql);
  }

  function listSiteSelectorRows(tx: TenantTx): Promise<SiteSelectorRow[]> {
    return siteRows<SiteSelectorRow>(tx, siteSelectorSql);
  }

  function listSiteDomains(tx: TenantTx): Promise<SiteDomainRow[]> {
    return siteRows<SiteDomainRow>(tx, siteDomainsSql);
  }

  function matchSite(tx: TenantTx, siteId: string): Promise<SiteRow | null> {
    return base.read(tx, SITE.unit, async () => (await tx.query<SiteRow>(matchSiteSql, [tx.tenantId, siteId])).rows[0] ?? null);
  }

  /** Sets `patch` and the next `row_version` on site `siteId`, read under a row lock so concurrent writers never share a version. */
  async function writeSite(tx: TenantTx, siteId: string, patch: RepositoryRow, ctx: WriteContext): Promise<SiteRow | null> {
    const current = await base.read(
      tx,
      SITE.unit,
      async () => (await tx.query<SiteRow>(lockSiteSql, [tx.tenantId, siteId])).rows[0] ?? null,
    );
    if (current === null) {
      return null;
    }
    return base.update<SiteRow>(tx, SITE.table, { siteid: current.siteid }, { ...patch, row_version: nextRowVersion(current) }, ctx);
  }

  function updateOrderNo(tx: TenantTx, siteId: string, orderNo: number, ctx: WriteContext = {}): Promise<SiteRow | null> {
    return writeSite(tx, siteId, { orderno: orderNo }, ctx);
  }

  function updateDeploy(tx: TenantTx, siteId: string, deploy: number, ctx: WriteContext = {}): Promise<SiteRow | null> {
    return writeSite(tx, siteId, { deploy }, ctx);
  }

  function listImageSizes(tx: TenantTx, siteId: string): Promise<ImageSizeRow[]> {
    return base.read(tx, IMAGE_SIZE.unit, async () => (await tx.query<ImageSizeRow>(imageSizesSql, [tx.tenantId, siteId])).rows);
  }

  function listImageSizePage(tx: TenantTx, siteId: string, { after, limit }: KeysetPage): Promise<ImageSizeRow[]> {
    const [sql, params] =
      after === null
        ? [imageSizePageSql, [tx.tenantId, siteId, limit]]
        : [imageSizePageAfterSql, [tx.tenantId, siteId, after, limit]];
    return base.read(tx, IMAGE_SIZE.unit, async () => (await tx.query<ImageSizeRow>(sql, params)).rows);
  }

  async function listRegisteredSitePage(tx: MetadataTx, { after, limit }: KeysetPage): Promise<RegisteredSite[]> {
    const [sql, params] = after === null ? [registryPageSql, [limit]] : [registryPageAfterSql, [after, limit]];
    const { rows } = await tx.query<{ site_id: string; tenant_id: string }>(sql, params);
    return rows.map((row) => ({ siteId: row.site_id, tenantId: row.tenant_id }));
  }

  function findImageSize(tx: TenantTx, by: ImageSizeLookup): Promise<ImageSizeRow | null> {
    if ('sizeId' in by) {
      return base.findByKey<ImageSizeRow>(tx, IMAGE_SIZE.table, { sizeid: by.sizeId });
    }
    return base.read(
      tx,
      IMAGE_SIZE.unit,
      async () => (await tx.query<ImageSizeRow>(imageSizeByNameSql, [tx.tenantId, by.name, by.siteId])).rows[0] ?? null,
    );
  }

  function saveImageSize(tx: TenantTx, row: ImageSizeInput, ctx: WriteContext = {}): Promise<ImageSizeRow> {
    const stored: Omit<ImageSizeRow, 'tenant_id'> = {
      sizeid: row.sizeid ?? cfUuid(),
      siteid: row.siteid,
      name: row.name,
      height: row.height,
      width: row.width,
    };
    return base.upsert<ImageSizeRow>(tx, IMAGE_SIZE.table, stored, ctx);
  }

  async function deleteImageSize(tx: TenantTx, sizeId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await base.delete(tx, IMAGE_SIZE.table, { sizeid: sizeId }, ctx)) !== null;
  }

  function readSiteExtendDefinitions(tx: TenantTx, siteId: string): Promise<SiteExtendDefinitions> {
    const units = [EXTEND_SUBTYPE.unit, EXTEND_SET.unit, EXTEND_ATTRIBUTE.unit, EXTEND_RC_SET.unit];
    return base.read(tx, units, async () => {
      const params = [tx.tenantId, siteId];
      return {
        subtypes: (await tx.query<ExtendSubtypeRow>(subtypesSql, params)).rows,
        sets: (await tx.query<ExtendSetRow>(setsSql, params)).rows,
        attributes: (await tx.query<ExtendAttributeRow>(attributesSql, params)).rows,
        rcsets: (await tx.query<ExtendRcSetRow>(rcSetsSql, params)).rows,
      };
    });
  }

  function readSiteExtendData(tx: TenantTx, baseId: string): Promise<ExtendDataRow[]> {
    return base.read(tx, EXTEND_DATA.unit, async () => (await tx.query<ExtendDataRow>(extendDataSql, [tx.tenantId, baseId])).rows);
  }

  return Object.freeze({
    ...base,
    readSite,
    listSites,
    listSiteSelectorRows,
    listSiteDomains,
    matchSite,
    updateOrderNo,
    updateDeploy,
    listImageSizes,
    listImageSizePage,
    listRegisteredSitePage,
    findImageSize,
    saveImageSize,
    deleteImageSize,
    readSiteExtendDefinitions,
    readSiteExtendData,
  });
}
