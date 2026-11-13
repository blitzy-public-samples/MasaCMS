/** Port of the values Masa's JSON API returns for the `site` entity, before serialization (jsonApiUtility.cfc). */
import { Roles } from '@opt2/platform/auth';
import { LegacyApiError, cfEq, cfIsBoolean, cfListToArray, cfToBoolean, isValidVariableName } from '@opt2/platform/legacy-compat';
import { acfKeyOrder, acfStruct, type StructOp } from './acf-struct.js';
import { cfUrlDecode, unavailable } from './json-api-site-feed.js';
import { applySet, getSiteText, getSiteValue, newSiteBean, type SiteBean, type SiteStoredValue } from './site-fields.js';
import { validateSite } from './validation.js';

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:69-73,2097,2126-2128
/** Registered `site` fields plus the appended `isnew`; field selection is off, so a request `fields` is ignored. */
export const JSON_API_SITE_FIELDS = ['links', 'links', 'domain', 'siteid', 'isnew'] as const;

/** `request.muraAPIRequestMode`. */
export type JsonApiMode = 'json' | 'rest' | 'ajax';

/** Request and configBean values getEndPoint reads. */
export interface JsonApiEndpointInput {
  /** `utility.getRequestProtocol()`, without the colon, e.g. `http`. */
  readonly requestProtocol: string;
  /** `configBean.getAdminSSL()`. */
  readonly adminSSL: boolean;
  /** `cgi.server_name`. */
  readonly serverName: string;
  /** `configBean.getServerPort()`, e.g. `''` or `':8080'`. */
  readonly serverPort: string;
  /** `configBean.getContext()`, e.g. `''` or `'/masa'`. */
  readonly context: string;
  readonly mode: JsonApiMode;
  /** The request's site id. */
  readonly siteId: string;
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:3337-3364 ("Rigged to always have index.cfm")
/** The JSON API endpoint URL legacy builds for an API request. */
export function jsonApiBaseUrl({
  requestProtocol,
  adminSSL,
  serverName,
  serverPort,
  context,
  mode,
  siteId,
}: JsonApiEndpointInput): string {
  const protocol = adminSSL ? 'https:' : `${requestProtocol}:`;
  return `${protocol}//${serverName}${serverPort}${context}/index.cfm/_api/${mode}/v1/${siteId}`;
}

/** The `links` getLinks builds for a site bean. */
export interface JsonApiSiteLinks {
  readonly entities: string;
  readonly all: string;
  readonly properties: string;
  readonly self: string;
  readonly permissions: string;
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:3374-3470
// No `edit` (the site bean has no edit URL) and no has-one/has-many links (site registers none);
// golden capture GS-CO-05/GS-PS is the evidence.
/** Links of the site entity `siteId` under `baseUrl`, in ColdFusion struct order. */
export function jsonApiSiteLinks(baseUrl: string, siteId: string): JsonApiSiteLinks {
  return ordered<JsonApiSiteLinks>({
    entities: baseUrl,
    all: `${baseUrl}/site`,
    properties: `${baseUrl}/site/properties`,
    self: `${baseUrl}/site`,
    permissions: `${baseUrl}/site/${siteId}/permissions`,
  });
}

/** A site's JSON API values; `domain` is the stored value, so it keeps a non-string value as legacy does. */
export interface JsonApiSiteValues {
  readonly links: JsonApiSiteLinks | { readonly entities: string };
  readonly domain: SiteStoredValue;
  readonly siteid: string;
  readonly isnew: 0 | 1;
  readonly id: string;
  /** The entity name findOne was called with, as spelled; `site` for every other operation. */
  readonly entityname: string;
}

/** `values` as the struct legacy builds by `ops`, typed as built. */
function ordered<T extends object>(values: T, ops?: readonly StructOp[]): T {
  return acfStruct(values as unknown as Record<string, unknown>, ops) as unknown as T;
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:2136-2160,2191-2221 (the config fields, `links` twice, then id, links, entityname)
const VALUE_OPS: readonly StructOp[] = Object.freeze(
  ['links', 'links', 'domain', 'siteid', 'isnew', 'id', 'links', 'entityname'].map((key): StructOp => ['set', key]),
);

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:2137-2166,2192-2198,2221
// legacy: core/mura/settings/settingsBean.cfc:376-387 (domain)
/** The values getFilteredValues returns for a site bean: the fixed field list, `id`, `links` and `entityname`. */
export function jsonApiSiteValues(bean: SiteBean, baseUrl: string, entityName = 'site'): JsonApiSiteValues {
  const siteid = getSiteText(bean, 'siteid');
  return ordered<JsonApiSiteValues>(
    {
      links: jsonApiSiteLinks(baseUrl, siteid),
      domain: getSiteValue(bean, 'domain'),
      siteid,
      isnew: bean.isNew,
      id: siteid,
      entityname: entityName,
    },
    VALUE_OPS,
  );
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:2062-2065 (saveErrors and errors after the filtered values)
/** A saved site's values: the site values, then `saveErrors` and `errors`. */
export function jsonApiSaveValues(bean: SiteBean, baseUrl: string, saveErrors: unknown, errors: unknown): Record<string, unknown> {
  const values = { ...jsonApiSiteValues(bean, baseUrl), saveErrors, errors };
  return acfStruct(values, [...VALUE_OPS, ['set', 'saveErrors'], ['set', 'errors']]);
}

// legacy: core/mura/bean/beanIterator.cfc:98-101 and jsonApiUtility.cfc:3374-3381 (a distinct feed's generic bean links only `entities`)
/** The values of a generic bean a distinct feed iterates, read as the site entity's fields. */
export function jsonApiGenericValues(row: Readonly<Record<string, unknown>>, baseUrl: string): JsonApiSiteValues {
  const siteid = String(row.siteid ?? '');
  return ordered<JsonApiSiteValues>(
    {
      links: { entities: baseUrl },
      domain: (row.domain ?? '') as SiteStoredValue,
      siteid,
      isnew: 0,
      id: siteid,
      entityname: 'site',
    },
    VALUE_OPS,
  );
}

/** serializeResponse's struct in ColdFusion order: params dropped, and data's keys in its place when `useDataNamespace` is false (jsonApiUtility.cfc:1471-1511). */
export function jsonApiEnvelope(method: string, data: unknown, useDataNamespace: string | undefined): Record<string, unknown> {
  const ops: StructOp[] = [['set', 'apiversion'], ['set', 'method'], ['set', 'params'], ['set', 'data'], ['delete', 'params']];
  const struct = typeof data === 'object' && data !== null && !Array.isArray(data);
  const flatten = struct && useDataNamespace !== undefined && cfIsBoolean(useDataNamespace) && !cfToBoolean(useDataNamespace);
  if (!flatten) return acfStruct({ apiversion: 'v1', method, data }, ops);
  const values: Record<string, unknown> = { apiversion: 'v1', method };
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    // structAppend overwrites a key of the same name, ignoring case, in place.
    const existing = Object.keys(values).find((name) => name.toLowerCase() === key.toLowerCase()) ?? key;
    values[existing] = value;
    ops.push(['set', existing]);
  }
  ops.push(['delete', 'data']);
  return acfStruct(values, ops);
}

// legacy: oracle findProperties output of the site entity (settingsBean property metadata after applyPropertyFormat)
const SITE_PROPERTIES: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map([
  ['domain', { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'domain', datatype: 'varchar', default: '' }],
  ['siteid', { fieldtype: 'id', length: '35', required: 'true', nullable: false, html: 'false', name: 'siteid', datatype: 'char', default: '' }],
]);

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:69-73 (registerEntity('site', {fields: 'links,links,domain,siteid'}))
const SITE_CONFIG_FIELDS: readonly string[] = Object.freeze(['links', 'domain', 'siteid']);

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:1585-1598 (the structAppend literal, in its own struct order)
const PROPERTY_LITERAL_KEYS: readonly string[] = Object.freeze(
  acfKeyOrder(
    ['entityname', 'bundleable', 'orderby', 'historical', 'dynamic', 'scaffold', 'displayname', 'primarykey', 'public', 'links'].map(
      (key): StructOp => ['set', key],
    ),
  ),
);

/** findProperties(entityname, properties) of the site entity (jsonApiUtility.cfc:1548-1622); `showTable` for an admin or super user. */
export function jsonApiSiteProperties(a: {
  properties: string | undefined;
  entityName: string;
  baseUrl: string;
  showTable: boolean;
}): Record<string, unknown> {
  const listed = cfListToArray(a.properties ?? '');
  const names = listed.length > 0 ? listed.map((name) => name.toLowerCase()) : [...SITE_PROPERTIES.keys()];
  const properties: Array<Record<string, unknown>> = [];
  for (const name of names) {
    if (!SITE_CONFIG_FIELDS.includes(name)) continue;
    const property = SITE_PROPERTIES.get(name);
    // props[p] of a configured field the bean has no property for (`links`) raises.
    if (property === undefined) throw new LegacyApiError('server_error');
    properties.push({ ...property });
  }
  const base = a.baseUrl;
  const linkValues = {
    entities: base,
    endpoint: `${base}/${a.entityName}`,
    swagger_json: `${base}/swagger?mode=json&entities=${a.entityName}`,
    swagger_rest: `${base}/swagger?mode=rest&entities=${a.entityName}`,
    self: `${base}/${a.entityName}/properties`,
  };
  const values: Record<string, unknown> = {
    entityname: 'site',
    bundleable: false,
    orderby: '',
    historical: false,
    dynamic: false,
    scaffold: false,
    displayname: 'site',
    primarykey: 'siteid',
    public: true,
    links: acfStruct(linkValues),
    properties,
  };
  const ops: StructOp[] = [['set', 'items'], ...PROPERTY_LITERAL_KEYS.map((key): StructOp => ['set', key])];
  if (a.showTable) {
    values.table = 'tsettings';
    ops.push(['set', 'table']);
  }
  ops.push(['set', 'properties'], ['delete', 'items']);
  return acfStruct(values, ops);
}

/** findPermissions of a site (jsonApiUtility.cfc:2240-2266; bean.cfc:1499-1521): public read, save and delete for a super user. */
export function jsonApiSitePermissions(superUser: boolean): Record<string, boolean> {
  return { read: true, delete: superUser, save: superUser };
}

// legacy: core/mura/bean/bean.cfc and core/mura/cfobject.cfc getter functions, which lockdownValidations keeps a generic bean's rules off
const GENERIC_BEAN_GETTERS: ReadonlySet<string> = new Set(
  [
    'get', 'getAll', 'getAllValues', 'getBundleable', 'getDbUtility', 'getDynamic', 'getEntityDisplayName', 'getEntityName', 'getErrors',
    'getFeed', 'getHasManyPropArray', 'getHasOnePropArray', 'getInstanceName', 'getIsHistorical', 'getListViewProps', 'getOrderBy',
    'getPermissions', 'getPrimaryKey', 'getProperties', 'getPublicAPI', 'getRegisteredEntity', 'getScaffold', 'getSearchableProps',
    'getSynthedFunctions', 'getTable', 'getValidations', 'getValue', 'getAsJSON', 'getAsStruct', 'getBean', 'getConfigBean',
    'getCurrentUser', 'getEntity', 'getEventManager', 'getHTTPAttrs', 'getHTTPService', 'getJavaTimezone', 'getPlugin',
    'getPluginManager', 'getQueryAttrs', 'getQueryService', 'getServiceFactory', 'getSession',
  ].map((name) => name.toLowerCase()),
);

function isStruct(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A struct member as CFML `isDefined` sees it, ignoring case: a JSON null is undefined. */
function member(struct: Readonly<Record<string, unknown>>, name: string): unknown {
  const key = Object.keys(struct).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : (struct[key] ?? undefined);
}

/** A simple member as CFML text; a complex one fails the comparison legacy makes with it. */
function memberText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new LegacyApiError('server_error');
}

/** A `validate` argument: text is `urlDecode`d and `deserializeJSON`ed, else `invalidParameters`; a JSON body's struct stays as sent. */
function jsonArgument(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) return value;
  try {
    return JSON.parse(cfUrlDecode(String(value))) as unknown;
  } catch {
    throw new LegacyApiError('invalidParameters');
  }
}

/** Whether lockdownValidations leaves a generic bean any rule (jsonApiUtility.cfc:3657-3700). */
function keepsRules(rules: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(rules).some((key) => isValidVariableName(key) && !GENERIC_BEAN_GETTERS.has(`get${key}`.toLowerCase()));
}

/** validate(data, validations, siteid) as a `site.validate` call reaches it (jsonApiUtility.cfc:3703-3808). */
export function jsonApiValidate(a: { data: unknown; validations: unknown; siteId: string }): Record<string, string> {
  const data = jsonArgument(a.data ?? '{}');
  const validations = jsonArgument(a.validations ?? '{}');
  if (!isStruct(data) || !isStruct(validations)) return { invalid: 'Invalid validation request' };
  const siteIdValue = member(data, 'siteid');
  // getBean('Mura').init(data.siteid) and settingsManager.read take the site id as text.
  const siteId = siteIdValue === undefined ? a.siteId : memberText(siteIdValue);
  const entityName = member(data, 'entityname');
  if (entityName !== undefined && !cfEq(memberText(entityName), 'bean')) {
    if (!cfEq(memberText(entityName), 'site')) {
      throw unavailable(`Validating a ${memberText(entityName)} entity belongs to its owner`, 'validate-entity');
    }
    // loadBy and set leave the request's site id unless the data names one; only the site id has rules.
    const seeded = applySet(newSiteBean(), { siteid: a.siteId });
    return validateSite(applySet(seeded, { siteid: siteId }));
  }
  const properties = member(validations, 'properties');
  if (isStruct(properties) && keepsRules(properties)) {
    throw unavailable('Ad hoc validation rules are not reproduced', 'validate-rules');
  }
  const conditions = member(validations, 'conditions');
  if (isStruct(conditions)) {
    const kept = Object.values(conditions).some((rules) => isStruct(rules) && keepsRules(rules));
    if (kept) throw unavailable('Ad hoc validation rules are not reproduced', 'validate-rules');
    // The sanitized rules then hold conditions without properties, which bean.validate dereferences.
    throw new LegacyApiError('server_error');
  }
  const bean = member(data, 'bean');
  const loadBy = member(data, 'loadby');
  if (bean !== undefined && loadBy !== undefined && !cfEq(memberText(bean), 'bean')) {
    if (['orderby', 'returnformat', 'cachedwithin'].includes(memberText(loadBy).toLowerCase())) throw new LegacyApiError('invalidParameters');
    if (!cfEq(memberText(bean), 'site')) throw unavailable(`A loadby validation reads the ${memberText(bean)} entity`, 'validate-loadby');
    if (member(data, memberText(loadBy)) === undefined) throw new LegacyApiError('server_error');
    // settingsBean.loadBy reads the site by its site id alone, which is either stored or the request's: no rule fails.
  }
  return {};
}

/** Verified user-token claims canWriteSite and isSiteAdmin read; declared structurally. */
export interface SiteWriteClaims {
  readonly s2?: boolean;
  readonly roles?: readonly string[];
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:1801-1806 (allowAction 'site': isSuperUser)
/** Whether the caller may save or delete a site through the JSON API. */
export function canWriteSite(claims: SiteWriteClaims): boolean {
  return claims.s2 === true;
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:1614 (isAdminUser: the site's Admin group)
/** Whether the caller is the site's admin user, whom findProperties shows the table. */
export function isSiteAdmin(claims: SiteWriteClaims): boolean {
  return claims.roles?.includes(Roles.siteAdmin) === true;
}
