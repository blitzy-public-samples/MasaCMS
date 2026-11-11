/** The only write path of schema `programs_sites`: the platform repository plus the site, image-size and site extend helpers. */
import { createRepository, qualified, type Repository, type RepositoryRow, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
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

/** `programs_sites.site` columns `settingsDAO.update` sets, in SET order (settingsDAO.cfc:321-416). */
export const SITE_UPDATE_COLUMNS: readonly string[] = Object.freeze([
  'site', 'pagelimit', 'domain', 'domainalias', 'enforceprimarydomain', 'contact', 'locking', 'mailserverip',
  'mailserverusername', 'mailserverpassword', 'emailbroadcaster', 'emailbroadcasterlimit', 'extranet',
  'extranetpublicreg', 'extranetssl', 'cache', 'cachecapacity', 'cachefreememorythreshold', 'viewdepth', 'nextn',
  'datacollection', 'exportlocation', 'columncount', 'primarycolumn', 'publicsubmission', 'columnnames',
  'contactname', 'contactaddress', 'contactcity', 'contactstate', 'contactzip', 'contactemail', 'contactphone',
  'publicuserpoolid', 'privateuserpoolid', 'displaypoolid', 'filepoolid', 'categorypoolid', 'contentpoolid',
  'feedmanager', 'largeimageheight', 'largeimagewidth', 'smallimageheight', 'smallimagewidth', 'mediumimageheight',
  'mediumimagewidth', 'sendloginscript', 'sendauthcodescript', 'mailinglistconfirmscript',
  'publicsubmissionapprovalscript', 'reminderscript', 'extranetpublicregnotify', 'loginurl', 'editprofileurl',
  'commentapprovaldefault', 'accountactivationscript', 'googleapikey', 'usedefaultsmtpserver', 'sitelocale',
  'mailserversmtpport', 'mailserverpopport', 'mailservertls', 'mailserverssl', 'theme', 'tagline', 'haschangesets',
  'baseid', 'enforcechangesets', 'contentpendingscript', 'contentapprovalscript', 'contentrejectionscript',
  'contentcanceledscript', 'enablelockdown', 'customtaggroups', 'hascomments', 'haslockablenodes', 'recaptchasitekey',
  'recaptchasecret', 'recaptchalanguage', 'jsonapi', 'usessl', 'isremote', 'resourcessl', 'resourcedomain',
  'remotecontext', 'remoteport', 'showdashboard', 'placeholderimgid', 'placeholderimgext', 'scaffolding',
]);

/** An image size to save; without `sizeid` it is inserted under a new CF UUID. */
export type ImageSizeInput = Pick<ImageSizeRow, 'siteid' | 'name' | 'height' | 'width'> & { sizeid?: string };

/** Lookup of `settingsImageSizeBean.getQuery`: by `sizeId`, else by `name` within `siteId`. */
export type ImageSizeLookup = { sizeId: string } | { name: string; siteId: string };

/** The `baseTable = tsettings` extend definitions of one site, each list in legacy display order. */
export interface SiteExtendDefinitions {
  subtypes: ExtendSubtypeRow[];
  sets: ExtendSetRow[];
  attributes: ExtendAttributeRow[];
  rcsets: ExtendRcSetRow[];
}

/** Value columns of one `extend_data` row. */
export type ExtendDataValues = Pick<ExtendDataRow, 'attributevalue' | 'stringvalue' | 'datetimevalue' | 'numericvalue' | 'remoteid'>;

/** One attribute's stored value for `baseId`; `values: null` only deletes, otherwise the new row needs `dataId`, which has no column default. */
export type SiteExtendDataReplacement = { baseId: string; siteId: string; attributeId: number } & (
  | { values: null }
  | { values: ExtendDataValues; dataId: number }
);

/** The platform repository of schema `programs_sites` plus typed helpers; every helper runs in the caller's open tenant transaction. */
export interface ProgramsSitesRepository extends Repository {
  /** The site row with exactly `siteId`; null when absent. */
  readSite(tx: TenantTx, siteId: string): Promise<SiteRow | null>;
  /** Every site of the transaction tenant by `orderno` ascending, NULLs first, ties by `siteid`. */
  listSites(tx: TenantTx): Promise<SiteRow[]>;
  /** Sets `after`'s SITE_UPDATE_COLUMNS on the stored site `before.siteid`, leaves every other column, and adds 1 to `row_version`; null when the row is gone. */
  updateSiteRow(tx: TenantTx, before: SiteRow, after: Readonly<RepositoryRow>, ctx?: WriteContext): Promise<SiteRow | null>;
  /** Sets `orderno` and adds 1 to `row_version`; null when the site is absent. */
  updateOrderNo(tx: TenantTx, siteId: string, orderNo: number, ctx?: WriteContext): Promise<SiteRow | null>;
  /** Sets `deploy` and adds 1 to `row_version`; null when the site is absent. */
  updateDeploy(tx: TenantTx, siteId: string, deploy: number, ctx?: WriteContext): Promise<SiteRow | null>;
  /** The image sizes of `siteId`, by `sizeid`. */
  listImageSizes(tx: TenantTx, siteId: string): Promise<ImageSizeRow[]>;
  /** The first image size matching `by`; null when none does. */
  findImageSize(tx: TenantTx, by: ImageSizeLookup): Promise<ImageSizeRow | null>;
  /** Updates the stored size with `row.sizeid`, else inserts it, and returns the stored row. */
  saveImageSize(tx: TenantTx, row: ImageSizeInput, ctx?: WriteContext): Promise<ImageSizeRow>;
  /** Deletes the size with `sizeId`; false when absent. */
  deleteImageSize(tx: TenantTx, sizeId: string, ctx?: WriteContext): Promise<boolean>;
  /** The subtypes of `siteId` with their sets, the sets' attributes and the related-content sets. */
  readSiteExtendDefinitions(tx: TenantTx, siteId: string): Promise<SiteExtendDefinitions>;
  /** Every stored extend value of `baseId`, by `attributeid` then `dataid`. */
  readSiteExtendData(tx: TenantTx, baseId: string): Promise<ExtendDataRow[]>;
  /** Deletes every row of the replacement's base and attribute, then inserts its values; returns the inserted row, or null. */
  replaceSiteExtendData(tx: TenantTx, replacement: SiteExtendDataReplacement, ctx?: WriteContext): Promise<ExtendDataRow | null>;
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

  const listSitesSql = `SELECT * FROM ${site} WHERE tenant_id = $1 ORDER BY orderno ASC NULLS FIRST, siteid`;
  const lockSiteSql = `SELECT * FROM ${site} WHERE tenant_id = $1 AND siteid = $2 FOR UPDATE`;
  const imageSizesSql = `SELECT * FROM ${imageSize} WHERE tenant_id = $1 AND siteid = $2 ORDER BY sizeid`;
  const imageSizeByNameSql = `SELECT * FROM ${imageSize} WHERE tenant_id = $1 AND name = $2 AND siteid = $3 ORDER BY sizeid LIMIT 1`;
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
  const lockExtendDataSql = `SELECT dataid FROM ${data} WHERE tenant_id = $1 AND baseid = $2 AND attributeid = $3 ORDER BY dataid FOR UPDATE`;

  function readSite(tx: TenantTx, siteId: string): Promise<SiteRow | null> {
    return base.findByKey<SiteRow>(tx, SITE.table, { siteid: siteId });
  }

  function listSites(tx: TenantTx): Promise<SiteRow[]> {
    return base.read(tx, SITE.unit, async () => (await tx.query<SiteRow>(listSitesSql, [tx.tenantId])).rows);
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

  function updateSiteRow(tx: TenantTx, before: SiteRow, after: Readonly<RepositoryRow>, ctx: WriteContext = {}): Promise<SiteRow | null> {
    const patch: RepositoryRow = {};
    for (const column of SITE_UPDATE_COLUMNS) {
      patch[column] = after[column];
    }
    return writeSite(tx, before.siteid, patch, ctx);
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

  async function replaceSiteExtendData(
    tx: TenantTx,
    replacement: SiteExtendDataReplacement,
    ctx: WriteContext = {},
  ): Promise<ExtendDataRow | null> {
    const { baseId, siteId, attributeId } = replacement;
    const stale = await base.read(
      tx,
      EXTEND_DATA.unit,
      async () => (await tx.query<{ dataid: number }>(lockExtendDataSql, [tx.tenantId, baseId, attributeId])).rows,
    );
    for (const { dataid } of stale) {
      await base.delete(tx, EXTEND_DATA.table, { dataid }, ctx);
    }
    if (replacement.values === null) {
      return null;
    }
    const row: Omit<ExtendDataRow, 'tenant_id'> = {
      dataid: replacement.dataId,
      baseid: baseId,
      attributeid: attributeId,
      siteid: siteId,
      ...replacement.values,
    };
    return base.insert<ExtendDataRow>(tx, EXTEND_DATA.table, row, ctx);
  }

  return Object.freeze({
    ...base,
    readSite,
    listSites,
    updateSiteRow,
    updateOrderNo,
    updateDeploy,
    listImageSizes,
    findImageSize,
    saveImageSize,
    deleteImageSize,
    readSiteExtendDefinitions,
    readSiteExtendData,
    replaceSiteExtendData,
  });
}
