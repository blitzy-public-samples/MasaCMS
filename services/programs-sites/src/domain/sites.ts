/** Business operations of the carried `csettings` site actions (core/mura/settings). */
import { AuthDenial, assertSiteMatches, type UserClaims } from '@opt2/platform/auth';
import { cfIsNumeric, cfToBoolean, cfToNumber, cfUuid, masaCf2Java } from '@opt2/platform/legacy-compat';
import { awaitReadable, withGatedTenant, type MigrationHandlerOptions } from '@opt2/platform/migration-kit';
import { localTimestamp, type OutboxOrigin } from '@opt2/platform/outbox';
import {
  registeredTenants,
  registryEntryForTenant,
  tenantForRegisteredSite,
  withMetadata,
  withTenant,
  type MetadataTx,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import { lastAnnouncedVersion, writeSiteChanged } from '../events/site-changed.js';
import type { components } from '../generated/openapi.js';
import {
  LEGACY_GLOBAL_CONFIG_DEFAULTS,
  SITE_COLUMNS,
  effectiveDataCollection,
  effectiveEditProfileURL,
  effectiveEmailBroadcaster,
  effectiveUseSSL,
  getSiteText,
  getSiteValue,
  newSiteBean,
  readBean,
  sortSites,
  type LegacyGlobalConfig,
  type SiteBean,
  type SiteStoredValue,
} from '../legacy/site-fields.js';
import { jsonApiSiteBean, jsonApiSiteValues, type JsonApiSiteValues } from '../legacy/json-api-site.js';
import type { ProgramsSitesRepository, SiteExtendDefinitions, SiteListRow } from '../repo/repository.js';
import { SITE, type ExtendAttributeRow, type ExtendDataRow, type ImageSizeRow, type SiteRow } from '../repo/tables.js';
import { createHrefDomainsReader } from './href-domains.js';
import { LINE_BREAKS, siteChangedPayload } from './pools.js';

type Schemas = components['schemas'];
type Site = Schemas['Site'];
type SiteListItem = Schemas['SiteListItem'];
type SiteListPage = Schemas['SiteListPage'];
type SiteDetail = Schemas['SiteDetail'];
type ShellSite = Schemas['ShellSite'];
type ShellSiteDetail = Schemas['ShellSiteDetail'];
type UserPoolSites = Schemas['UserPoolSites'];
type SiteExtendSet = Schemas['SiteExtendSet'];
type SiteExtendAttribute = Schemas['SiteExtendAttribute'];
type SiteOrderResult = Schemas['SiteOrderResult'];
type ImageSize = Schemas['ImageSize'];
type HrefDomains = Schemas['HrefDomains'];
type SiteMailSettings = Schemas['SiteMailSettings'];
type SiteMailRemote = Schemas['SiteMailRemote'];
type SiteFeedSettings = Schemas['SiteFeedSettings'];
type SiteConfigFlags = Schemas['SiteConfigFlags'];

/** Sort of the site list as `settingsGateway.getList` takes it; unknown values fall back to `orderno` / `asc`. */
export interface SiteListOptions {
  sortBy?: string;
  sortDirection?: string;
  /** Ends the list's reads when it aborts, e.g. when the client disconnects. */
  signal?: AbortSignal;
}

/** One page of the registered sites: at most `limit` after the site id `after`. */
export interface SiteListPageOptions {
  after?: string;
  limit: number;
  /** Ends the page's reads when it aborts, e.g. when the client disconnects. */
  signal?: AbortSignal;
}

/** The Sites screen order form: comma lists in row order, plus the sort of the list returned. */
export interface SiteOrderInput extends SiteListOptions {
  orderno?: string;
  orderID?: string;
  deploy?: string;
}

/** Dependencies of `createSitesDomain`. */
export interface SitesDomainDeps {
  repo: ProgramsSitesRepository;
  /** Global settings of the effective getters; `LEGACY_GLOBAL_CONFIG_DEFAULTS` when omitted. */
  config?: LegacyGlobalConfig;
}

/**
 * Site operations behind `csettings.list`, `editSite`, the admin layout, `sanitizeHref`, identity's login mail, and
 * strategies-content's RSS feeds, Site Manager flags and JSON API `site` relations.
 */
export interface SitesDomain {
  /**
   * The Sites screen rows: every registered site for an S2 token, else the token's own, one transaction per tenant and
   * at most SITE_LIST_CONCURRENCY at once. Always read fresh; legacy's per-sort list cache can show stale order numbers
   * after an order save, a golden-comparison parity point. An abort of `options.signal` rejects with its reason.
   */
  listSites(db: TenantDb, claims: UserClaims, options?: SiteListOptions): Promise<SiteListItem[]>;
  /**
   * One page of the Sites screen rows for an S2 token, in registry site-id order: only the page's tenants are read, one
   * transaction each and at most SITE_LIST_CONCURRENCY at once. An abort of `options.signal` rejects with its reason.
   */
  listSitePage(db: TenantDb, claims: UserClaims, options: SiteListPageOptions): Promise<SiteListPage>;
  /** The Edit Site data of `siteId`; an unknown id yields the defaulted new site with `isNew = 1`. */
  readSite(db: TenantDb, claims: UserClaims, siteId: string): Promise<SiteDetail>;
  /** The admin layout's settings of `siteId`, EmailBroadcaster effective; an unknown id yields the new site, `isNew = 1`. */
  readShellSite(db: TenantDb, claims: UserClaims, siteId: string): Promise<ShellSiteDetail>;
  /** The layout settings of `siteId`'s private, then public, user pool site, each once; unregistered or unstored ones left out. */
  readUserPoolSites(db: TenantDb, claims: UserClaims, siteId: string): Promise<UserPoolSites>;
  /** Port of `settingsManager.saveOrder` and `saveDeploy` (S2 only), then the site list. */
  saveOrderAndDeploy(db: TenantDb, claims: UserClaims, input: SiteOrderInput): Promise<SiteOrderResult>;
  /** The registered domains and site domain `utility.sanitizeHref` checks against; `siteId` is the session site. */
  hrefDomains(db: TenantDb, siteId: string): Promise<HrefDomains>;
  /**
   * The login-mail settings `settingsManager.getSite` resolves for each id, in order (settingsManager.cfc:537-567).
   * @throws Error when neither the named site nor `default` is stored, where legacy's getSite fails.
   */
  readMailSettings(db: TenantDb, siteIds: readonly string[]): Promise<SiteMailSettings[]>;
  /**
   * The settings the RSS writers read through `settingsManager.getSite` for each id, in order (feedApiUtility.cfc:257-446).
   * @throws Error when neither the named site nor `default` is stored, where legacy's getSite fails.
   */
  readFeedSettings(db: TenantDb, siteIds: readonly string[]): Promise<SiteFeedSettings[]>;
  /**
   * The `$.siteConfig` flags strategies-content's Site Manager views test, of the site `settingsManager.getSite` resolves
   * for each id, in order.
   * @throws Error when neither the named site nor `default` is stored, where legacy's getSite fails.
   */
  readConfigFlags(db: TenantDb, siteIds: readonly string[]): Promise<SiteConfigFlags[]>;
  /**
   * The values findOne(entityName='site') answers for each id under the JSON API endpoint `baseUrl`, in order
   * (jsonApiUtility.cfc:2292-2384): the registered site's bean holding the id as spelled, else the new bean.
   */
  readJsonApiValues(db: TenantDb, baseUrl: string, siteIds: readonly string[]): Promise<JsonApiSiteValues[]>;
  /** Writes `programs-sites.site.changed.v1` for each applied site insert, update or delete of a migration apply. */
  emitStateEvents: NonNullable<MigrationHandlerOptions['emitStateEvents']>;
  /** The `row_version` a migration-applied site insert or change writes with its row: one past the stored one, 1 for a new site. */
  targetOnlyColumns: NonNullable<MigrationHandlerOptions['targetOnlyColumns']>;
}

// legacy: core/mura/content/contentRenderer.cfc:2704, the tags setDynamicContent evaluates as CFML.
const DYNAMIC_CONTENT = /(\[sava\]|\[mura\]|\[m\]).+?(\[\/sava\]|\[\/mura\]|\[\/m\])/i;

const COLUMN_TYPES: ReadonlyMap<string, string> = new Map(SITE.columns.map((column) => [column.name, column.type]));

/** settingsManager `getSite`'s fallback for an empty or unknown site id. */
const DEFAULT_SITE_ID = 'default';

/** configBean's `locale` when the settings name none (configBean.cfc:138). */
const DEFAULT_LOCALE = 'Server';

/** Ports getServerPort leaves out of a remote site's URL (settingsBean.cfc:1406). */
const DEFAULT_PORTS: readonly string[] = ['80', '443'];

/** Most tenant transactions one site list holds at once: below pg's default pool of 10, so one list never takes the pool. */
const SITE_LIST_CONCURRENCY = 4;

/** Every registered tenant once, in registry order, after waiting out a window on the site unit once for the whole list. */
async function siteListTenants(tx: MetadataTx): Promise<string[]> {
  await awaitReadable(tx, [SITE.unit]);
  return [...new Set((await registeredTenants(tx)).map(({ tenantId }) => tenantId))];
}

/**
 * `read` of each tenant, at most SITE_LIST_CONCURRENCY at a time, in tenant order. No read starts once `signal` has
 * aborted or a read has failed; the first failure is rethrown once the running reads settle.
 */
async function readEachTenant<T>(
  tenants: readonly string[],
  signal: AbortSignal | undefined,
  read: (tenantId: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  const failures: unknown[] = [];
  const queue = tenants.entries();
  const worker = async (): Promise<void> => {
    for (const [index, tenantId] of queue) {
      if (failures.length > 0) return;
      try {
        signal?.throwIfAborted();
        results[index] = await read(tenantId);
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SITE_LIST_CONCURRENCY, tenants.length) }, worker));
  if (failures.length > 0) throw failures[0];
  return results;
}

/** CFML list items: comma-split with empty elements dropped and no trimming. */
function cfList(list: string): string[] {
  return list.split(',').filter((item) => item !== '');
}

/** SQL Server `=` on text under its case-insensitive collation, trailing spaces ignored; NULL matches nothing. */
function sqlEq(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.replace(/ +$/, '').toLowerCase() === b.replace(/ +$/, '').toLowerCase();
}

/** The contract's wall-clock timestamp, `yyyy-MM-ddTHH:mm:ss.SSS` in the process zone. */
function wireTimestamp(date: Date): string {
  return localTimestamp(date).replace(' ', 'T');
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** One Sites screen row from the stored row, which the legacy list reads as its raw query (list.cfm). */
function listItem(row: SiteListRow): SiteListItem {
  return {
    siteid: row.siteid,
    site: nullableText(row.site),
    domain: nullableText(row.domain),
    orderno: row.orderno,
    deploy: row.deploy,
    lastDeployment: row.lastdeployment === null ? null : wireTimestamp(row.lastdeployment),
  };
}

/** A bean field in its column's wire type: dates as timestamps, integers as numbers, '' as null for both. */
function beanColumnValue(value: SiteStoredValue, type: string | undefined): unknown {
  if (value instanceof Date) return wireTimestamp(value);
  if (typeof value !== 'string') return null;
  if (type === 'i') return cfIsNumeric(value) ? cfToNumber(value) : null;
  return type === 't' ? null : value;
}

/** The contract `Site`: every bean-held field as the bean holds it (pools defaulted), every other column as stored. */
function toSite(bean: SiteBean, row: SiteRow | null): Site {
  const site: Record<string, unknown> = {};
  for (const { legacyName, targetName } of SITE_COLUMNS) {
    const stored: unknown = row?.[targetName] ?? null;
    site[legacyName] = Object.hasOwn(bean.values, targetName)
      ? beanColumnValue(getSiteValue(bean, targetName), COLUMN_TYPES.get(targetName))
      : stored instanceof Date
        ? wireTimestamp(stored)
        : stored;
  }
  return { ...site, SiteID: getSiteText(bean, 'siteID') };
}

/** Fields of the contract `ShellSite`. */
const SHELL_SITE_FIELDS = Object.freeze([
  'SiteID', 'Site', 'Domain', 'domainAlias', 'enforcePrimaryDomain', 'siteLocale', 'theme', 'publicUserPoolID',
  'privateUserPoolID', 'displayPoolID', 'contentPoolID', 'categoryPoolID', 'filePoolID', 'hasChangesets', 'hasComments',
  'feedManager', 'EmailBroadcaster', 'Extranet', 'ExtranetSSL', 'Cache', 'enableLockdown', 'lastDeployment',
  'showDashboard', 'exportLocation', 'useSSL', 'isremote', 'resourceSSL', 'resourceDomain', 'remoteport', 'remotecontext',
] as const satisfies ReadonlyArray<keyof ShellSite>);

/** The contract `ShellSite`: those fields of `toSite`, with getEmailBroadcaster() (settingsBean.cfc:435-441). */
function toShellSite(bean: SiteBean, row: SiteRow | null, config: LegacyGlobalConfig): ShellSite {
  const site = toSite(bean, row);
  const shell: Record<string, unknown> = {};
  for (const field of SHELL_SITE_FIELDS) shell[field] = site[field];
  const emailBroadcaster = effectiveEmailBroadcaster(bean, config);
  return {
    ...shell,
    SiteID: site.SiteID,
    EmailBroadcaster: cfIsNumeric(emailBroadcaster) ? cfToNumber(emailBroadcaster) : null,
  };
}

/** getServerPort() and getContext() of a remote site (settingsBean.cfc:1395-1414); null for a local one, which reads configBean's. */
function mailRemote(bean: SiteBean): SiteMailRemote | null {
  if (!cfToBoolean(getSiteText(bean, 'isRemote'))) return null;
  const port = getSiteText(bean, 'RemotePort');
  return {
    serverPort: cfIsNumeric(port) && !DEFAULT_PORTS.includes(port) ? `:${port}` : '',
    context: getSiteText(bean, 'RemoteContext'),
  };
}

/** The bean values sendLogin reads (userUtility.cfc:518-540); an edit-profile URL with Mura tags is null, as only CFML evaluates them. */
function toMailSettings(bean: SiteBean, config: LegacyGlobalConfig): SiteMailSettings {
  const editProfileURL = effectiveEditProfileURL(bean, config);
  return {
    siteID: getSiteText(bean, 'siteID'),
    site: getSiteText(bean, 'site'),
    contact: getSiteText(bean, 'contact'),
    sendLoginScript: getSiteText(bean, 'sendLoginScript'),
    editProfileURL: DYNAMIC_CONTENT.test(editProfileURL) ? null : editProfileURL,
    extranetSSL: cfToBoolean(getSiteText(bean, 'extranetSSL')),
    useSSL: effectiveUseSSL(bean) === '1',
    extranetPublicRegNotify: getSiteText(bean, 'ExtranetPublicRegNotify'),
    remote: mailRemote(bean),
  };
}

/**
 * The bean values rss20, rss092 and getURL read (feedApiUtility.cfc:257-446): getContact, getJavaLocale
 * (settingsBean.cfc:647-654), and what getScheme and getWebPath read (settingsBean.cfc:1189-1221,1298-1300,1395-1467).
 */
function toFeedSettings(bean: SiteBean, config: LegacyGlobalConfig): SiteFeedSettings {
  const siteLocale = getSiteText(bean, 'siteLocale');
  return {
    siteID: getSiteText(bean, 'siteID'),
    contact: getSiteText(bean, 'contact'),
    javaLocale: masaCf2Java(siteLocale !== '' ? siteLocale : (config.defaultLocale ?? DEFAULT_LOCALE)),
    domain: getSiteText(bean, 'domain'),
    domainAliases: getSiteText(bean, 'domainAlias')
      .split(LINE_BREAKS)
      .filter((alias) => alias !== ''),
    enforcePrimaryDomain: cfToBoolean(getSiteText(bean, 'enforcePrimaryDomain')),
    useSSL: effectiveUseSSL(bean) === '1',
    remote: mailRemote(bean),
  };
}

/** A bean flag as the contract's integer; null for the '' a NULL column leaves where no setter keeps the default. */
function flagNumber(value: SiteStoredValue): number | null {
  return typeof value === 'string' && cfIsNumeric(value) ? cfToNumber(value) : null;
}

/**
 * The `getValue(<flag>)` answers the admin views test (settingsBean.cfc:360-364,427-433,576-581,1336-1341) and the
 * cfeed gate's getHasFeedManager() (settingsBean.cfc:126,411-418): the numeric setters keep their defaults over a NULL
 * column, so only hasChangesets, dataCollection and hasFeedManager, which has no such setter, can be null.
 */
function toConfigFlags(bean: SiteBean, config: LegacyGlobalConfig): SiteConfigFlags {
  return {
    siteID: getSiteText(bean, 'siteID'),
    hasLockableNodes: cfToNumber(getSiteText(bean, 'hasLockableNodes')),
    hasChangesets: flagNumber(getSiteValue(bean, 'hasChangesets')),
    dataCollection: flagNumber(effectiveDataCollection(bean, config)),
    hasComments: cfToNumber(getSiteText(bean, 'hasComments')),
    scaffolding: cfToNumber(getSiteText(bean, 'scaffolding')),
    hasFeedManager: flagNumber(getSiteValue(bean, 'feedManager')),
  };
}

/** A stored custom image size; a NULL height or width reads as the bean's `AUTO` default. */
function imageSize(row: ImageSizeRow): ImageSize {
  return {
    sizeID: row.sizeid,
    siteID: row.siteid ?? '',
    name: row.name ?? '',
    height: row.height ?? 'AUTO',
    width: row.width ?? 'AUTO',
    isNew: 0,
  };
}

function attributeView(attribute: ExtendAttributeRow, values: ReadonlyMap<number, string | null>): SiteExtendAttribute {
  return {
    attributeID: attribute.attributeid,
    extendSetID: attribute.extendsetid,
    siteID: attribute.siteid,
    name: attribute.name,
    label: attribute.label,
    hint: attribute.hint,
    type: attribute.type,
    orderno: attribute.orderno,
    isActive: attribute.isactive,
    required: attribute.required,
    validation: attribute.validation,
    regex: attribute.regex,
    message: attribute.message,
    defaultValue: attribute.defaultvalue,
    optionList: attribute.optionlist,
    optionLabelList: attribute.optionlabellist,
    adminonly: attribute.adminonly,
    value: values.get(attribute.attributeid) ?? null,
  };
}

/**
 * `getSubTypeByName('Site','Default',siteid).getExtendSets(inherit=true,container='Default',activeOnly=true)`
 * (extendSubType.cfc:791-886): the sets of the site's active Site/Default subtype, each with its attributes.
 * Site types inherit no Default or Base sets, so only the subtype's own sets apply.
 */
function siteExtendSets(defs: SiteExtendDefinitions, stored: readonly ExtendDataRow[]): SiteExtendSet[] {
  const subtype = defs.subtypes.find((row) => sqlEq(row.type, 'Site') && sqlEq(row.subtype, 'Default'));
  if (subtype === undefined || subtype.isactive !== 1) return [];
  // extendData.loadData indexes every stored row in order, so the last one of an attribute is the value read.
  const values = new Map(stored.map((row) => [row.attributeid, row.attributevalue]));
  return defs.sets
    .filter((set) => sqlEq(set.subtypeid, subtype.subtypeid) && sqlEq(set.container, 'Default'))
    .map((set) => ({
      extendSetID: set.extendsetid,
      subTypeID: set.subtypeid,
      categoryID: set.categoryid,
      siteID: set.siteid,
      name: set.name,
      orderno: set.orderno,
      isActive: set.isactive,
      container: set.container,
      attributes: defs.attributes
        .filter((attribute) => sqlEq(attribute.extendsetid, set.extendsetid))
        .map((attribute) => attributeView(attribute, values)),
    }));
}

/** An integer element of a CFML list, as `listGetAt` and the SQL `int` column read it; throws like legacy's 500. */
function listInteger(list: readonly string[], index: number, name: string): number {
  const value = list[index];
  if (value === undefined || !cfIsNumeric(value)) {
    throw new Error(`Invalid ${name} list: element ${index + 1} is not a number`);
  }
  return Math.trunc(cfToNumber(value));
}

/** The next `row_version` of a stored row, above `floor`; pg returns int8 as a decimal string. */
function nextRowVersion(rowVersion: unknown, floor = 0n): bigint {
  const stored = BigInt(String(rowVersion));
  return (stored > floor ? stored : floor) + 1n;
}

/** Builds the site operations over the injected repository; it holds no state of its own. */
export function createSitesDomain({ repo, config = LEGACY_GLOBAL_CONFIG_DEFAULTS }: SitesDomainDeps): SitesDomain {
  /** The tenant's site row `siteId` names under SQL Server's `siteid = ?` matching; null when none does. */
  async function findSite(tx: TenantTx, siteId: string): Promise<SiteRow | null> {
    return (await repo.readSite(tx, siteId)) ?? repo.matchSite(tx, siteId);
  }

  /** Writes the site's state event for its stored row in `tx`. */
  async function announce(tx: TenantTx, row: SiteRow, origin?: OutboxOrigin): Promise<void> {
    const rowVersion = BigInt(row.row_version);
    await writeSiteChanged(tx, { siteId: row.siteid, rowVersion, payload: siteChangedPayload(row), origin });
  }

  async function listSites(db: TenantDb, claims: UserClaims, options: SiteListOptions = {}): Promise<SiteListItem[]> {
    const { signal } = options;
    const call = signal === undefined ? undefined : { signal };
    const tenants = claims.s2 ? await withMetadata(db, siteListTenants, call) : [claims.tid];
    const rows = await readEachTenant(tenants, signal, (tenantId) => withTenant(db, tenantId, (tx) => repo.listSites(tx), call));
    return sortSites(rows.flat(), options.sortBy ?? 'orderno', options.sortDirection ?? 'asc').map(listItem);
  }

  async function listSitePage(db: TenantDb, claims: UserClaims, options: SiteListPageOptions): Promise<SiteListPage> {
    if (!claims.s2) throw AuthDenial.forbidden();
    const { signal, limit } = options;
    const call = signal === undefined ? undefined : { signal };
    // One entry past the page tells whether another page follows.
    const entries = await withMetadata(
      db,
      async (tx) => {
        await awaitReadable(tx, [SITE.unit]);
        return repo.listRegisteredSitePage(tx, { after: options.after ?? null, limit: limit + 1 });
      },
      call,
    );
    const page = entries.slice(0, limit);
    const tenants = [...new Set(page.map(({ tenantId }) => tenantId))];
    const rows = await readEachTenant(tenants, signal, (tenantId) => withTenant(db, tenantId, (tx) => repo.listSites(tx), call));
    return { items: rows.flat().map(listItem), next: entries.length > limit ? (page.at(-1)?.siteId ?? null) : null };
  }

  async function readSite(db: TenantDb, claims: UserClaims, siteId: string): Promise<SiteDetail> {
    assertSiteMatches(siteId, claims);
    return withTenant(db, claims.tid, async (tx) => {
      const row = await findSite(tx, siteId);
      const bean = row === null ? newSiteBean(cfUuid()) : readBean(row);
      const baseId = getSiteText(bean, 'baseID');
      const defs = await repo.readSiteExtendDefinitions(tx, row?.siteid ?? siteId);
      const stored = row === null || baseId === '' ? [] : await repo.readSiteExtendData(tx, baseId);
      const imageSizes = row === null ? [] : await repo.listImageSizes(tx, row.siteid);
      return {
        site: toSite(bean, row),
        isNew: bean.isNew,
        extendSets: siteExtendSets(defs, stored),
        imageSizes: imageSizes.map(imageSize),
      };
    });
  }

  async function readShellSite(db: TenantDb, claims: UserClaims, siteId: string): Promise<ShellSiteDetail> {
    assertSiteMatches(siteId, claims);
    return withTenant(db, claims.tid, async (tx) => {
      const row = await findSite(tx, siteId);
      const bean = row === null ? newSiteBean(cfUuid()) : readBean(row);
      return { isNew: bean.isNew, site: toShellSite(bean, row, config) };
    });
  }

  async function readUserPoolSites(db: TenantDb, claims: UserClaims, siteId: string): Promise<UserPoolSites> {
    assertSiteMatches(siteId, claims);
    const entry = await registryEntryForTenant(db, claims.tid);
    const poolIds = [entry?.privateUserPoolId, entry?.publicUserPoolId].filter((id) => typeof id === 'string');
    const read = new Set<string>();
    const sites: ShellSite[] = [];
    for (const poolId of poolIds) {
      const tenantId = await tenantForRegisteredSite(db, poolId);
      if (tenantId === null || read.has(tenantId)) continue;
      read.add(tenantId);
      const row = await withTenant(db, tenantId, (tx) => findSite(tx, poolId));
      if (row !== null) sites.push(toShellSite(readBean(row), row, config));
    }
    return { sites };
  }

  /** The stored row getSite resolves `siteId` to: the registered site ignoring case, else `default`; null when neither is stored. */
  async function mailSite(db: TenantDb, siteId: string): Promise<SiteRow | null> {
    for (const id of new Set([siteId === '' ? DEFAULT_SITE_ID : siteId, DEFAULT_SITE_ID])) {
      const tenantId = await tenantForRegisteredSite(db, id);
      const row = tenantId === null ? null : await withTenant(db, tenantId, (tx) => findSite(tx, id));
      if (row !== null) return row;
    }
    return null;
  }

  /** `toSettings` of the bean getSite resolves each id to, in order; throws where neither the site nor `default` is stored. */
  async function readResolvedSites<T>(db: TenantDb, siteIds: readonly string[], toSettings: (bean: SiteBean) => T): Promise<T[]> {
    const settings: T[] = [];
    for (const siteId of siteIds) {
      const row = await mailSite(db, siteId);
      if (row === null) throw new Error(`Neither site '${siteId}' nor the default site is registered`);
      settings.push(toSettings(readBean(row)));
    }
    return settings;
  }

  async function readMailSettings(db: TenantDb, siteIds: readonly string[]): Promise<SiteMailSettings[]> {
    return readResolvedSites(db, siteIds, (bean) => toMailSettings(bean, config));
  }

  async function readFeedSettings(db: TenantDb, siteIds: readonly string[]): Promise<SiteFeedSettings[]> {
    return readResolvedSites(db, siteIds, (bean) => toFeedSettings(bean, config));
  }

  async function readConfigFlags(db: TenantDb, siteIds: readonly string[]): Promise<SiteConfigFlags[]> {
    return readResolvedSites(db, siteIds, (bean) => toConfigFlags(bean, config));
  }

  async function readJsonApiValues(db: TenantDb, baseUrl: string, siteIds: readonly string[]): Promise<JsonApiSiteValues[]> {
    const items: JsonApiSiteValues[] = [];
    for (const siteId of siteIds) {
      const tenantId = await tenantForRegisteredSite(db, siteId);
      const row = tenantId === null ? null : await withTenant(db, tenantId, (tx) => findSite(tx, siteId));
      items.push(jsonApiSiteValues(jsonApiSiteBean(row, siteId), baseUrl));
    }
    return items;
  }

  async function saveOrderAndDeploy(db: TenantDb, claims: UserClaims, input: SiteOrderInput): Promise<SiteOrderResult> {
    if (!claims.s2) throw AuthDenial.forbidden();
    const orderIds = cfList(input.orderID ?? '');
    const ordernos = cfList(input.orderno ?? '');
    const deploys = cfList(input.deploy ?? '');
    // saveDeploy runs only when both raw lists are non-empty (settingsManager.cfc:233).
    const saveDeploy = (input.deploy ?? '') !== '';
    for (const [index, orderId] of orderIds.entries()) {
      const tenantId = await tenantForRegisteredSite(db, orderId);
      if (tenantId === null) continue;
      // Each site commits on its own, as legacy's untransacted update loop does.
      await withGatedTenant(db, tenantId, async (tx) => {
        const row = await findSite(tx, orderId);
        if (row === null) return;
        let updated = await repo.updateOrderNo(tx, row.siteid, listInteger(ordernos, index, 'orderno'));
        if (saveDeploy) updated = await repo.updateDeploy(tx, row.siteid, listInteger(deploys, index, 'deploy'));
        if (updated === null) throw new Error(`Site ${row.siteid} disappeared inside its own order transaction`);
        await announce(tx, updated);
      });
    }
    return { written: true, sites: await listSites(db, claims, input) };
  }

  /** Writes the `deleted` state event of a site row an apply removed, above every version announced for the site. */
  async function announceDeletion(tx: TenantTx, row: SiteRow, origin: OutboxOrigin): Promise<void> {
    const rowVersion = nextRowVersion(row.row_version, await lastAnnouncedVersion(tx, row.siteid));
    await writeSiteChanged(tx, { siteId: row.siteid, rowVersion, payload: { ...siteChangedPayload(row), deleted: true }, origin });
  }

  const emitStateEvents: SitesDomain['emitStateEvents'] = async (tx, change) => {
    if (change.unit !== SITE.unit) return;
    if (change.op === 'delete') {
      if (change.before !== undefined) await announceDeletion(tx, change.before as SiteRow, change.origin);
      return;
    }
    if (change.after === undefined) return;
    // The applied row carries the row_version targetOnlyColumns gave it.
    await announce(tx, change.after as SiteRow, change.origin);
  };

  const targetOnlyColumns: SitesDomain['targetOnlyColumns'] = async (tx, change) => {
    if (change.unit !== SITE.unit) return {};
    // A site created again after its deletion continues above the deletion's version, which consumers already hold.
    const floor = change.before === undefined ? await lastAnnouncedVersion(tx, String(change.row.siteid)) : 0n;
    return { row_version: String(nextRowVersion(change.before?.row_version ?? 0, floor)) };
  };

  const hrefDomains = createHrefDomainsReader(repo);

  return Object.freeze({
    listSites,
    listSitePage,
    readSite,
    readShellSite,
    readUserPoolSites,
    saveOrderAndDeploy,
    hrefDomains,
    readMailSettings,
    readFeedSettings,
    readConfigFlags,
    readJsonApiValues,
    emitStateEvents,
    targetOnlyColumns,
  });
}
