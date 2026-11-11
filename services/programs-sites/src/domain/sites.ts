/** Business operations of the carried `csettings` site actions and the JSON API `site` entity (core/mura/settings). */
import { createHash } from 'node:crypto';
import { AuthDenial, assertSiteMatches, type UserClaims } from '@opt2/platform/auth';
import {
  LegacyServiceUnavailableError,
  cfDateTimeFormat,
  cfIsDate,
  cfIsNumeric,
  cfNumberString,
  cfToNumber,
  cfUuid,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant, type MigrationHandlerOptions, type WriteContext } from '@opt2/platform/migration-kit';
import { localTimestamp, type OutboxOrigin } from '@opt2/platform/outbox';
import { registeredTenants, tenantForRegisteredSite, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { writeSiteChanged } from '../events/site-changed.js';
import type { components } from '../generated/openapi.js';
import {
  LEGACY_GLOBAL_CONFIG_DEFAULTS,
  SITE_COLUMNS,
  applySet,
  effectiveEmailBroadcaster,
  getSiteText,
  getSiteValue,
  newSiteBean,
  readBean,
  sortSites,
  updateColumnValues,
  type LegacyGlobalConfig,
  type SiteBean,
  type SiteData,
  type SiteStoredValue,
} from '../legacy/site-fields.js';
import { assertNoForeignBranches } from '../legacy/update-branches.js';
import { hasSiteErrors, validateSite, type SiteErrors } from '../legacy/validation.js';
import type { ExtendDataValues, ProgramsSitesRepository, SiteExtendDefinitions } from '../repo/repository.js';
import { SITE, type ExtendAttributeRow, type ExtendDataRow, type ImageSizeRow, type SiteRow } from '../repo/tables.js';
import { siteChangedPayload } from './pools.js';

type Schemas = components['schemas'];
type Site = Schemas['Site'];
type SiteListItem = Schemas['SiteListItem'];
type SiteDetail = Schemas['SiteDetail'];
type ShellSite = Schemas['ShellSite'];
type ShellSiteDetail = Schemas['ShellSiteDetail'];
type SiteExtendSet = Schemas['SiteExtendSet'];
type SiteExtendAttribute = Schemas['SiteExtendAttribute'];
type SiteUpdateResult = Schemas['SiteUpdateResult'];
type SiteOrderResult = Schemas['SiteOrderResult'];
type ImageSize = Schemas['ImageSize'];

/** Sort of the site list as `settingsGateway.getList` takes it; unknown values fall back to `orderno` / `asc`. */
export interface SiteListOptions {
  sortBy?: string;
  sortDirection?: string;
}

/** The Sites screen order form: comma lists in row order, plus the sort of the list returned. */
export interface SiteOrderInput extends SiteListOptions {
  orderno?: string;
  orderID?: string;
  deploy?: string;
}

/** Provenance of an update's writes; the request context supplies the actor and request id otherwise. */
export interface SiteUpdateContext {
  write?: WriteContext;
}

/** Dependencies of `createSitesDomain`. */
export interface SitesDomainDeps {
  repo: ProgramsSitesRepository;
  /** Global settings of the effective getters; `LEGACY_GLOBAL_CONFIG_DEFAULTS` when omitted. */
  config?: LegacyGlobalConfig;
  /** configBean `saveEmptyExtendedValues` (configBean.cfc:221); true when omitted. */
  saveEmptyExtendedValues?: boolean;
}

/** Options of `extendDataRows`. */
export interface ExtendDataOptions {
  saveEmptyExtendedValues: boolean;
}

/** One attribute's extended-data replacement: delete its rows for `baseId`, then insert `values` unless null. */
export interface ExtendDataWrite {
  baseId: string;
  siteId: string;
  attributeId: number;
  values: ExtendDataValues | null;
}

/** Site operations behind `csettings.list`, `editSite`, `updateSite{action=Update}`, the admin layout and the JSON API `site` entity. */
export interface SitesDomain {
  /**
   * The Sites screen rows: every registered site for an S2 token, else the token's own. Always read fresh; legacy's
   * per-sort list cache can show stale order numbers after an order save, a golden-comparison parity point.
   */
  listSites(db: TenantDb, claims: UserClaims, options?: SiteListOptions): Promise<SiteListItem[]>;
  /** The Edit Site data of `siteId`; an unknown id yields the defaulted new site with `isNew = 1`. */
  readSite(db: TenantDb, claims: UserClaims, siteId: string): Promise<SiteDetail>;
  /** The admin layout's settings of `siteId`, EmailBroadcaster effective; an unknown id yields the new site, `isNew = 1`. */
  readShellSite(db: TenantDb, claims: UserClaims, siteId: string): Promise<ShellSiteDetail>;
  /** Port of `settingsManager.update`: validation errors are returned, never thrown, and leave everything unwritten. */
  updateSite(
    db: TenantDb,
    claims: UserClaims,
    siteId: string,
    data: SiteData,
    ctx?: SiteUpdateContext,
  ): Promise<SiteUpdateResult>;
  /** Port of `settingsManager.saveOrder` and `saveDeploy` (S2 only), then the site list. */
  saveOrderAndDeploy(db: TenantDb, claims: UserClaims, input: SiteOrderInput): Promise<SiteOrderResult>;
  /** Writes `programs-sites.site.changed.v1` for each applied site insert or update of a migration apply. */
  emitStateEvents: NonNullable<MigrationHandlerOptions['emitStateEvents']>;
}

const DATE_VALIDATIONS: ReadonlySet<string> = new Set(['date', 'datetime']);

// legacy: core/mura/content/contentRenderer.cfc:2704, the tags setDynamicContent evaluates as CFML.
const DYNAMIC_CONTENT = /(\[sava\]|\[mura\]|\[m\]).+?(\[\/sava\]|\[\/mura\]|\[\/m\])/i;

// Legacy dataID is a global IDENTITY that starts at 1; ids generated here stay above that range (int4 max is 2^31-1).
const GENERATED_DATA_ID_BASE = 2 ** 30;

const COLUMN_TYPES: ReadonlyMap<string, string> = new Map(SITE.columns.map((column) => [column.name, column.type]));

/** CFML list items: comma-split with empty elements dropped and no trimming. */
function cfList(list: string): string[] {
  return list.split(',').filter((item) => item !== '');
}

/** `data[key]` as a CFML struct reads it: case-insensitive, the last matching key winning; undefined when absent or null. */
function lookup(data: Readonly<Record<string, unknown>>, key: string): unknown {
  const lower = key.toLowerCase();
  let found: unknown;
  for (const [name, value] of Object.entries(data)) {
    if (name.toLowerCase() === lower) found = value;
  }
  return found ?? undefined;
}

/** CFML `len(v) > 0`; an absent value is empty and a date or complex value is not. */
function cfLen(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** A simple value as CFML renders it as text, dates as `{ts 'yyyy-MM-dd HH:mm:ss'}`; throws for a complex value. */
function cfString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}`;
  throw new TypeError('A complex value cannot be used as text.');
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

// validateSite yields only the two `siteid` messages the contract enumerates.
function contractErrors(errors: SiteErrors): Schemas['SiteErrors'] {
  return errors as Schemas['SiteErrors'];
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

/** A stored value as convertDataToStruct reads it (extendData.cfc:413-429): a date attribute's timestamp, else its text. */
function storedValue(row: ExtendDataRow, attribute: ExtendAttributeRow): SiteStoredValue {
  const isDate = DATE_VALIDATIONS.has((attribute.validation ?? '').toLowerCase());
  if (isDate && row.datetimevalue !== null) return row.datetimevalue;
  return row.attributevalue ?? '';
}

/** contentRenderer.setDynamicContent of an attribute default; CFML-evaluated tags need the legacy runtime. */
function dynamicDefault(defaultValue: string | null): string {
  const value = defaultValue ?? '';
  if (DYNAMIC_CONTENT.test(value)) {
    throw new LegacyServiceUnavailableError(
      'An extended attribute default holds Mura tags only the legacy renderer evaluates',
      'auto',
      'extend-dynamic-default',
    );
  }
  return value;
}

/**
 * beanExtendable.getAllValues() with extendAutoComplete (beanExtendable.cfc:284-302): the bean's values plus, under
 * keys it lacks, the stored extended values of its baseID and the defaults of its subtype's unstored attributes
 * (extendData.cfc:218-360), with their sets appended to `extendSetID`. QoQ filters compare case-sensitively.
 */
function autocompletedValues(
  bean: SiteBean,
  defs: SiteExtendDefinitions,
  stored: readonly ExtendDataRow[],
  saveEmptyExtendedValues: boolean,
): Record<string, SiteStoredValue> {
  const siteId = getSiteText(bean, 'siteID');
  const type = getSiteText(bean, 'type');
  const subtype = getSiteText(bean, 'subtype');
  const attributes = new Map(defs.attributes.map((attribute) => [attribute.attributeid, attribute]));
  const rows: { name: string; extendSetId: string; value: SiteStoredValue }[] = [];
  const storedIds = new Set<number>();
  for (const row of stored) {
    const attribute = attributes.get(row.attributeid);
    if (attribute === undefined || (siteId !== '' && !sqlEq(attribute.siteid, siteId))) continue;
    if (!saveEmptyExtendedValues && row.attributevalue === null) continue;
    storedIds.add(row.attributeid);
    rows.push({ name: attribute.name ?? '', extendSetId: attribute.extendsetid ?? '', value: storedValue(row, attribute) });
  }
  if (siteId !== '' && type !== '' && subtype !== '') {
    for (const sub of defs.subtypes) {
      if (sub.siteid !== siteId || sub.type !== type || (sub.subtype !== subtype && sub.subtype !== 'Default')) continue;
      for (const set of defs.sets.filter((row) => row.subtypeid === sub.subtypeid)) {
        for (const attribute of defs.attributes) {
          if (attribute.extendsetid !== set.extendsetid || storedIds.has(attribute.attributeid)) continue;
          rows.push({ name: attribute.name ?? '', extendSetId: set.extendsetid, value: dynamicDefault(attribute.defaultvalue) });
        }
      }
    }
  }
  const values: Record<string, SiteStoredValue> = Object.assign(Object.create(null) as Record<string, SiteStoredValue>, bean.values);
  if (rows.length === 0) return values;
  const extended = new Map(rows.map((row) => [row.name.toLowerCase(), row.value]));
  for (const [key, value] of extended) {
    if (!Object.hasOwn(values, key)) values[key] = value;
  }
  let setIds = getSiteText({ values, isNew: bean.isNew }, 'extendSetID');
  for (const id of cfList(rows.map((row) => row.extendSetId).join(','))) {
    if (!cfList(setIds).includes(id)) setIds = setIds === '' ? id : `${setIds},${id}`;
  }
  values.extendsetid = setIds;
  return values;
}


/** saveExtendedData's coercion of a found value by attribute validation (extendManager.cfc:507-523). */
function coerceExtendValue(value: unknown, validation: string): unknown {
  if (!cfLen(value)) return value;
  if (DATE_VALIDATIONS.has(validation)) {
    if (cfIsDate(value)) return value;
    // Legacy reads date text with lsParseDateTime, which has no port; failing closed keeps the stored value intact.
    throw new LegacyServiceUnavailableError(
      'Date text of an extended attribute needs the legacy date parser',
      'auto',
      'extend-date-text',
    );
  }
  return validation === 'numeric' && !cfIsNumeric(value) ? '' : value;
}

/** The value columns saveExtendedData inserts (extendManager.cfc:527-556); NULL value columns for an empty value. */
function extendValues(value: unknown, validation: string, remoteId: string): ExtendDataValues {
  const text = cfString(value);
  const common = { stringvalue: text.slice(0, 250), remoteid: remoteId };
  if (text === '') return { ...common, attributevalue: null, datetimevalue: null, numericvalue: null };
  return {
    ...common,
    attributevalue: text,
    datetimevalue: DATE_VALIDATIONS.has(validation) && value instanceof Date ? value : null,
    numericvalue: validation === 'numeric' ? cfToNumber(value) : null,
  };
}

/**
 * Port of the non-File part of `extendManager.saveExtendedData` (extendManager.cfc:479-560): one replacement per
 * attribute found under `ext<attributeID>` or its name; attributes found under neither are left untouched.
 */
export function extendDataRows(
  baseId: string,
  attributes: readonly ExtendAttributeRow[],
  data: Readonly<Record<string, unknown>>,
  { saveEmptyExtendedValues }: ExtendDataOptions,
): ExtendDataWrite[] {
  const siteId = cfString(lookup(data, 'siteID') ?? '');
  const remote = lookup(data, 'remoteID');
  const remoteId = remote === undefined ? '' : cfString(remote).slice(0, 35);
  const writes: ExtendDataWrite[] = [];
  for (const attribute of attributes) {
    const byId = lookup(data, `ext${attribute.attributeid}`);
    const byName = lookup(data, attribute.name ?? '');
    if (byId === undefined && byName === undefined) continue;
    const validation = (attribute.validation ?? '').toLowerCase();
    const value = coerceExtendValue(cfLen(byId) ? byId : cfLen(byName) ? byName : '', validation);
    const values = cfLen(value) || saveEmptyExtendedValues ? extendValues(value, validation, remoteId) : null;
    writes.push({ baseId, siteId, attributeId: attribute.attributeid, values });
  }
  return writes;
}

/** File attributes whose saveExtendedData branch would run (extendManager.cfc:572-581), writing `tfiles` and the file store. */
export function fileAttributeBranches(
  fileAttributes: readonly ExtendAttributeRow[],
  data: Readonly<Record<string, unknown>>,
): ExtendAttributeRow[] {
  return fileAttributes.filter(
    ({ attributeid, name }) =>
      cfLen(lookup(data, `ext${attributeid}`)) ||
      cfLen(lookup(data, name ?? '')) ||
      lookup(data, `extDelete${attributeid}`) !== undefined ||
      lookup(data, `extDelete${name ?? ''}`) !== undefined,
  );
}

/** The attributes of `setIds` saveExtendedData's two queries select for `siteId` (extendManager.cfc:483-490,563-570). */
function savedAttributes(
  defs: SiteExtendDefinitions,
  setIds: readonly string[],
  siteId: string,
): { plain: ExtendAttributeRow[]; files: ExtendAttributeRow[] } {
  const selected = defs.attributes.filter(
    (attribute) =>
      setIds.some((id) => sqlEq(attribute.extendsetid, id)) && sqlEq(attribute.siteid, siteId) && attribute.type !== null,
  );
  return {
    plain: selected.filter((attribute) => !sqlEq(attribute.type, 'File')),
    files: selected.filter((attribute) => sqlEq(attribute.type, 'File')),
  };
}

/**
 * The `dataid` of a new extend value row, which legacy draws from its IDENTITY: the replaced row's lowest id, else a
 * stable id in [2^30, 2^31) derived from base and attribute, so a re-run of the unit of work picks the same id.
 */
function newDataId(baseId: string, attributeId: number, stored: readonly ExtendDataRow[]): number {
  const replaced = stored.filter((row) => row.attributeid === attributeId).map((row) => row.dataid);
  if (replaced.length > 0) return Math.min(...replaced);
  const digest = createHash('sha256').update(`${baseId}:${attributeId}`).digest();
  return GENERATED_DATA_ID_BASE + (digest.readUInt32BE(0) % GENERATED_DATA_ID_BASE);
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
export function createSitesDomain({
  repo,
  config = LEGACY_GLOBAL_CONFIG_DEFAULTS,
  saveEmptyExtendedValues = true,
}: SitesDomainDeps): SitesDomain {
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

  /** settingsManager.update's `saveExtendedData(bean.getBaseID(), bean.getAllValues())` (settingsManager.cfc:267-269). */
  async function saveExtendedData(tx: TenantTx, bean: SiteBean, write: WriteContext | undefined): Promise<void> {
    const siteId = getSiteText(bean, 'siteID');
    const baseId = getSiteText(bean, 'baseID');
    const defs = await repo.readSiteExtendDefinitions(tx, siteId);
    const stored = await repo.readSiteExtendData(tx, baseId);
    const values = autocompletedValues(bean, defs, stored, saveEmptyExtendedValues);
    const { plain, files } = savedAttributes(defs, cfList(getSiteText({ values, isNew: bean.isNew }, 'extendSetID')), siteId);
    if (fileAttributeBranches(files, values).length > 0) {
      throw new LegacyServiceUnavailableError(
        'Site update saves a File extended attribute through the strategies-content file manager',
        'auto',
        'foreign-branch',
      );
    }
    for (const row of extendDataRows(baseId, plain, values, { saveEmptyExtendedValues })) {
      const replacement =
        row.values === null
          ? { ...row, values: null }
          : { ...row, values: row.values, dataId: newDataId(baseId, row.attributeId, stored) };
      await repo.replaceSiteExtendData(tx, replacement, write);
    }
  }

  async function listSites(db: TenantDb, claims: UserClaims, options: SiteListOptions = {}): Promise<SiteListItem[]> {
    const tenants = claims.s2 ? [...new Set((await registeredTenants(db)).map(({ tenantId }) => tenantId))] : [claims.tid];
    const rows: SiteRow[] = [];
    for (const tenantId of tenants) {
      rows.push(...(await withTenant(db, tenantId, (tx) => repo.listSites(tx))));
    }
    return sortSites(rows, options.sortBy ?? 'orderno', options.sortDirection ?? 'asc').map(listItem);
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

  async function updateSite(
    db: TenantDb,
    claims: UserClaims,
    siteId: string,
    data: SiteData,
    ctx: SiteUpdateContext = {},
  ): Promise<SiteUpdateResult> {
    // settingsManager.update reads the site the posted `siteid` names (settingsManager.cfc:252).
    const requested = cfString(lookup(data, 'siteid') ?? '');
    assertSiteMatches(siteId, claims);
    assertSiteMatches(requested, claims);
    return withGatedTenant(db, claims.tid, async (tx) => {
      const row = await findSite(tx, requested);
      if (row === null) {
        // Legacy's UPDATE of a missing site matches no row.
        const bean = applySet(newSiteBean(cfUuid()), data);
        return { written: true, errors: contractErrors(validateSite(bean)), site: toSite(bean, null) };
      }
      // An empty stored baseID keeps init's createUUID(), which the update then stores (settingsDAO.cfc:103).
      const storedBean = readBean(row, cfUuid());
      const bean = applySet(storedBean, data);
      const errors = validateSite(bean);
      assertNoForeignBranches(storedBean, data);
      if (hasSiteErrors(errors)) {
        return { written: true, errors: contractErrors(errors), site: toSite(bean, row) };
      }
      if (cfLen(lookup(data, 'extendSetID'))) {
        await saveExtendedData(tx, bean, ctx.write);
      }
      const updated = await repo.updateSiteRow(tx, row, updateColumnValues(bean, config), ctx.write);
      if (updated === null) {
        throw new Error(`Site ${row.siteid} disappeared inside its own update transaction`);
      }
      await announce(tx, updated);
      return { written: true, errors: {}, site: toSite(readBean(updated), updated) };
    });
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

  return Object.freeze({ listSites, readSite, readShellSite, updateSite, saveOrderAndDeploy, emitStateEvents });
}
