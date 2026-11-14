/** Business operations of the carried `csettings` site actions (core/mura/settings). */
import { AuthDenial, assertSiteMatches, type UserClaims } from '@opt2/platform/auth';
import { cfIsNumeric, cfToNumber, cfUuid } from '@opt2/platform/legacy-compat';
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
import { writeSiteChanged } from '../events/site-changed.js';
import type { components } from '../generated/openapi.js';
import {
  LEGACY_GLOBAL_CONFIG_DEFAULTS,
  SITE_COLUMNS,
  effectiveEmailBroadcaster,
  getSiteText,
  getSiteValue,
  newSiteBean,
  readBean,
  sortSites,
  type LegacyGlobalConfig,
  type SiteBean,
  type SiteStoredValue,
} from '../legacy/site-fields.js';
import type { ProgramsSitesRepository, SiteExtendDefinitions } from '../repo/repository.js';
import { SITE, type ExtendAttributeRow, type ExtendDataRow, type ImageSizeRow, type SiteRow } from '../repo/tables.js';
import { createHrefDomainsReader } from './href-domains.js';
import { siteChangedPayload } from './pools.js';

type Schemas = components['schemas'];
type Site = Schemas['Site'];
type SiteListItem = Schemas['SiteListItem'];
type SiteDetail = Schemas['SiteDetail'];
type ShellSite = Schemas['ShellSite'];
type ShellSiteDetail = Schemas['ShellSiteDetail'];
type UserPoolSites = Schemas['UserPoolSites'];
type SiteExtendSet = Schemas['SiteExtendSet'];
type SiteExtendAttribute = Schemas['SiteExtendAttribute'];
type SiteOrderResult = Schemas['SiteOrderResult'];
type ImageSize = Schemas['ImageSize'];
type HrefDomains = Schemas['HrefDomains'];

/** Sort of the site list as `settingsGateway.getList` takes it; unknown values fall back to `orderno` / `asc`. */
export interface SiteListOptions {
  sortBy?: string;
  sortDirection?: string;
  /** Ends the list's reads when it aborts, e.g. when the client disconnects. */
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

/** Site operations behind `csettings.list`, `editSite`, the admin layout and `sanitizeHref`. */
export interface SitesDomain {
  /**
   * The Sites screen rows: every registered site for an S2 token, else the token's own, one transaction per tenant and
   * at most SITE_LIST_CONCURRENCY at once. Always read fresh; legacy's per-sort list cache can show stale order numbers
   * after an order save, a golden-comparison parity point. An abort of `options.signal` rejects with its reason.
   */
  listSites(db: TenantDb, claims: UserClaims, options?: SiteListOptions): Promise<SiteListItem[]>;
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
  /** Writes `programs-sites.site.changed.v1` for each applied site insert or update of a migration apply. */
  emitStateEvents: NonNullable<MigrationHandlerOptions['emitStateEvents']>;
}

const COLUMN_TYPES: ReadonlyMap<string, string> = new Map(SITE.columns.map((column) => [column.name, column.type]));

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
function listItem(row: SiteRow): SiteListItem {
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

/** The next `row_version` of a stored row; pg returns int8 as a decimal string. */
function nextRowVersion(rowVersion: unknown): string {
  return String(BigInt(String(rowVersion)) + 1n);
}

/** Builds the site operations over the injected repository; it holds no state of its own. */
export function createSitesDomain({ repo, config = LEGACY_GLOBAL_CONFIG_DEFAULTS }: SitesDomainDeps): SitesDomain {
  /** The tenant's site row `siteId` names under SQL Server's `siteid = ?` matching; null when none does. */
  async function findSite(tx: TenantTx, siteId: string): Promise<SiteRow | null> {
    const exact = await repo.readSite(tx, siteId);
    if (exact !== null) return exact;
    return (await repo.listSites(tx)).find((row) => sqlEq(row.siteid, siteId)) ?? null;
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

  const emitStateEvents: SitesDomain['emitStateEvents'] = async (tx, change, write) => {
    if (change.unit !== SITE.unit || (change.op !== 'insert' && change.op !== 'update') || change.after === undefined) {
      return;
    }
    // The platform update reads the applied row under the apply's authority, with no window-phase read wait.
    const row = await repo.update<SiteRow>(
      tx,
      SITE.table,
      { siteid: change.after.siteid },
      { row_version: nextRowVersion(change.after.row_version) },
      write,
    );
    if (row === null) {
      throw new Error(`Applied site ${String(change.after.siteid)} is missing from its apply transaction`);
    }
    await announce(tx, row, change.origin);
  };

  const hrefDomains = createHrefDomainsReader(repo);

  return Object.freeze({
    listSites,
    readSite,
    readShellSite,
    readUserPoolSites,
    saveOrderAndDeploy,
    hrefDomains,
    emitStateEvents,
  });
}
