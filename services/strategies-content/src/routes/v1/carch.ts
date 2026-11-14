/** carch admin routes: Site Manager page data, content writes and raw responses. */
import { existsSync, readFileSync } from 'node:fs';
import {
  LEGACY_ADMIN_SENTINEL_ID,
  LegacyServiceUnavailableError,
  accessControlOriginDomains,
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  cfDateAdd,
  cfDateTimeFormat,
  cfUuid,
  esapiUrlEncode,
  type CsrfTokens,
  type LegacyErrorSurface,
} from '@opt2/platform/legacy-compat';
import {
  IDENTITY_SERVICE,
  ServiceUnavailableError,
  legacyParamsOf,
  multipartFilesOf,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { poolTenantFor, registryEntries, registryEntryForTenant, tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import { loadRequest, requiresApproval } from '../../domain/approval-requests.js';
import { approvalAction } from '../../domain/approvals.js';
import { readChangeset } from '../../domain/changesets.js';
import { countCategories, listCategories, restrictGroups } from '../../domain/categories.js';
import {
  carchUpdate,
  getActiveContent,
  getApprovalsQuery,
  getAudit,
  getAuditTrail,
  getContentVersion,
  getCrumbList,
  getDraftList,
  getDraftPromptData,
  getHasDrafts,
  getHistory,
  getItemCount,
  getKidsCount,
  getMyApprovalsCount,
  getMyDraftsCount,
  getMyExpiresCount,
  getMyLockedContentCount,
  getMySubmissionsCount,
  getNest,
  getPageCount,
  getSubmissionsQuery,
  lockFile,
  parseDateArg,
  readContent,
  saveContent,
  saveCopyInfo,
  saveQuickEdit,
  siteManagerTab,
  unlockFile,
  unlockNode,
  updateObjectParams,
  type ContentBean,
  type ContentSaveSite,
  LegacyContentBean,
  UndefinedLegacyElementError,
} from '../../domain/content.js';
import type { Actor } from '../../domain/context.js';
import {
  dataManagerAction,
  downloadData,
  getActiveForm,
  getDownloadSelect,
  getFullFieldList,
  readResponse,
  responseList,
  responseValues,
  type AttachmentLinkParts,
} from '../../domain/forms.js';
import { FeedBean, feedContent, listFeeds } from '../../domain/feeds.js';
import type { UploadedFile } from '../../domain/files.js';
import { getModulePerm, getNodePerm, getPerm, loadMemberships, setRestriction, type UserMemberships } from '../../domain/permissions.js';
import { withPoolTenant } from '../../domain/pools.js';
import { PRIVATE_SEARCH_RECORDS_PER_PAGE, privateSearch } from '../../domain/search.js';
import { readVariationTargeting, saveVariationTargetingInTx } from '../../domain/variations.js';
import {
  ADMIN_VIEW_CONTENT_TYPE,
  DEFAULT_RELATED_CONTENT_SET,
  acfStructKeyOrder,
  createAdminLabels,
  displayIntervalValues,
  relatedItemsOf,
  normalizeSiteFlatEvent,
  siteFlatPage,
  renderApprovalActionJson,
  renderAssocFiles,
  renderAvailableChangesets,
  renderLoadCategoryAssignment,
  renderLoadCategoryFeatureStartStop,
  renderLoadClass,
  renderLoadExtendedAttributes,
  renderLoadFileMetadata,
  renderAuditTrailJson,
  renderDraftPromptData,
  renderImageSizeUrlJson,
  renderLoadDiff,
  renderLoadNewContentMenu,
  renderLoadQuickEdit,
  renderLoadRelatedContent,
  renderLoadSelectedRelatedContent,
  renderLoadSiteFlat,
  renderLoadSiteSection,
  renderRefreshSiteSection,
  renderSiteParents,
  renderStatusModal,
  renderSiteManagerJson,
  renderSiteManagerTab,
  renderTagArray,
  renderUpdateResponse,
  type AdminLabels,
  type AdminRenderContext,
  type AdminRenderResult,
  type AdminSession,
  type AssocFileRow,
  type AvailableChangesetsModel,
  type CategoryAssignmentModel,
  type CategoryFeatureModel,
  type CategoryNode,
  type DiffVersion,
  type DraftPromptModel,
  type DraftPromptVersion,
  type ExtendAttributeListRow,
  type ExtendSetModel,
  type ExtendedAttributesModel,
  type FileMetadataModel,
  type LoadClassModel,
  type LoadRelatedContentModel,
  type LoadSelectedRelatedContentModel,
  type LoadSiteFlatModel,
  type NestNode,
  type NewContentMenuModel,
  type ObjectClassData,
  type ObjectClassFeed,
  type ObjectClassSection,
  type PanelDelegation,
  type PanelRenderResult,
  type QuickEditModel,
  type RelatedContentItem,
  type RelatedContentSetView,
  type RelatedSearchItem,
  type SiteFlatCategory,
  type SiteFlatEvent,
  type SiteFlatRow,
  type SiteManagerFragmentResult,
  type SiteManagerModel,
  type SiteParentsModel,
  type SiteParentsRow,
  type SiteSectionModel,
  type StatusModalApproval,
  type StatusModalModel,
  type StatusModalUser,
  type UpdateResponseModel,
} from '../../legacy/admin-render.js';
import { buildCustomIconLookup, getNextN, type AdminSessionState, type CustomIconLookup, type NodePerm } from '../../legacy/admin-markup.js';
import { muraJsonEncode } from '../../legacy/cfjson.js';
import { contentUrl, imageUrl } from '../../legacy/content-urls.js';
import type { ContentRouteContext } from '../index.js';
import {
  SESSION_EFFECTS_HEADER,
  adminCsrf,
  adminRedirect,
  circuitRouteConfig,
  csrfRejected,
  requireCircuitAccess,
  type AdminRedirect,
  type AdminWriteResult,
  type SessionEffects,
} from './access.js';

// ---- module constants ----

const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const FORMS_MODULE = '00000000000000000000000000000000004';
const VARIATIONS_MODULE = '00000000000000000000000000000000099';
const CHANGESETS_MODULE = '00000000000000000000000000000000014';
/** before()'s `session.moduleid` whitelist (carch.cfc:79), including legacy's 36-character `…0099` id. */
const SESSION_MODULE_IDS = [SITE_MANAGER_MODULE, '000000000000000000000000000000000099', COMPONENTS_MODULE, FORMS_MODULE, VARIATIONS_MODULE];
/** list()'s and loadsitemanager()'s content modules, which page without getNextN (carch.cfc:225). */
const CONTENT_MODULES = [VARIATIONS_MODULE, COMPONENTS_MODULE, FORMS_MODULE, SITE_MANAGER_MODULE];
/** before()'s `session['m<moduleid>'].topid` defaults (carch.cfc:90-101). */
const MODULE_TOP_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  [`m${SITE_MANAGER_MODULE}`]: LEGACY_ADMIN_SENTINEL_ID,
  [`m${COMPONENTS_MODULE}`]: COMPONENTS_MODULE,
  [`m${FORMS_MODULE}`]: FORMS_MODULE,
  [`m${VARIATIONS_MODULE}`]: VARIATIONS_MODULE,
});
/** Rows per page of list() and search() outside the content modules (carch.cfc:226, 491). */
const LIST_NEXT_N = 30;
/** identity's admin session-scope store, keyed by the user token's session. */
const ADMIN_STATE_PATH = '/v1/sessions/current/admin-state';
/** identity's session struct of the token's session (`session.mura`). */
const CURRENT_SESSION_PATH = '/v1/sessions/current';
/**
 * The session user's `getContentTabAssignments()`: its groups' `tablist` is identity data the identity projections do
 * not carry, so every tab shows, as legacy shows them for a user whose groups restrict none.
 */
const TAB_ASSIGNMENTS = '';
/** identity's CSRF issuer for the token's session secret. */
const CSRF_TOKENS_PATH = '/v1/csrf/tokens';
/** downloaddata.cfm's `<cfcontent type="application/msexcel">`. */
const DOWNLOAD_CONTENT_TYPE = 'application/msexcel';
/** The content type of a JSON AdminWriteResult answer. */
const BARE_JSON_CONTENT_TYPE = 'application/json';
/** Types extendSubType reads no Base sets for (extendSubType.cfc:557). */
const NO_BASE_EXTEND_TYPES = '1,2,User,Group,Address,Site,Component,Form';

// ---- request values ----

/** A request context: legacy names, matched ignoring case as CFML scopes match them. */
type Rc = Record<string, unknown>;

/** A draft list row (`getDraftList`). */
type DraftListRow = Awaited<ReturnType<typeof getDraftList>>[number];
/** A pending approval row (`getApprovalsQuery`, `getSubmissionsQuery`). */
type ApprovalListRow = Awaited<ReturnType<typeof getApprovalsQuery>>[number];
/** A local feed's content row. */
type FeedContentRow = Awaited<ReturnType<typeof feedContent>>[number];

/** A `content.extend_subtype` row. */
type ExtendSubtypeRow = Awaited<ReturnType<ContentRouteContext['domain']['repository']['extend']['subtypes']>>[number];
/** A related-content set row of a subtype. */
type ExtendRcsetRow = Awaited<ReturnType<ContentRouteContext['domain']['repository']['extend']['rcsetsForSubtype']>>[number];
/** A crumb of contentManager.getCrumbList, leaf first. */
type Crumb = Awaited<ReturnType<typeof getCrumbList>>[number];
/** contentGateway.getRelatedContent arguments. */
type RelatedContentArgs = Parameters<ContentRouteContext['domain']['repository']['content']['relatedContent']>[1];
/** A contentGateway.getRelatedContent row. */
type RelatedContentRow = Awaited<ReturnType<ContentRouteContext['domain']['repository']['content']['relatedContent']>>[number];
/** One pool tenant's getRelatedContent row with its merge keys. */
type RelatedCandidate = Awaited<ReturnType<ContentRouteContext['domain']['repository']['content']['relatedCandidates']>>[number];

/** The key of `rc` that matches `name` ignoring case. */
function rcKey(rc: Rc, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(rc).find((key) => key.toLowerCase() === lower);
}

/** Whether `rc` holds `name` (CFML `structKeyExists`). */
function rcHas(rc: Rc, name: string): boolean {
  return rcKey(rc, name) !== undefined;
}

/** `rc[name]`, undefined when absent. */
function rcGet(rc: Rc, name: string): unknown {
  const key = rcKey(rc, name);
  return key === undefined ? undefined : rc[key];
}

/** `rc[name]` as CFML prints a simple value; '' when absent or complex. */
function rcText(rc: Rc, name: string): string {
  const value = rcGet(rc, name);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** Sets `rc[name]`, keeping the spelling a present key already has. */
function rcSet(rc: Rc, name: string, value: unknown): void {
  rc[rcKey(rc, name) ?? name] = value;
}

/** CFML `param`: sets `name` only when absent, and returns the value it then holds. */
function rcParam(rc: Rc, name: string, value: unknown): unknown {
  if (!rcHas(rc, name)) rc[name] = value;
  return rcGet(rc, name);
}

/** A CFML boolean test of `rc[name]`; a value CFML cannot read as a boolean fails as legacy fails. */
function rcFlag(rc: Rc, name: string): boolean {
  return cfToBoolean(rcGet(rc, name) ?? false);
}

/** `rc[name]` as a positive row number, 1 for a value that is no positive integer. */
function rcRow(rc: Rc, name: string): number {
  const value = cfIsNumeric(rcGet(rc, name)) ? Math.trunc(cfToNumber(rcGet(rc, name))) : 1;
  return value >= 1 ? value : 1;
}

/** The request's legacy params (url, then form or JSON body), as a fresh mutable rc. */
function paramsOf(request: FastifyRequest): Rc {
  return { ...legacyParamsOf(request) };
}

/** The request's spooled upload parts, read into memory for the domain's file writes. */
async function uploadsOf(request: FastifyRequest): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  for (const part of multipartFilesOf(request)) {
    const chunks: Buffer[] = [];
    for await (const chunk of part.stream()) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    files.push({ fieldName: part.field, fileName: part.filename, contentType: part.mimetype, bytes: Buffer.concat(chunks) });
  }
  return files;
}

// ---- verified admin session ----

/** The admin session-scope values identity keeps for the token's session, under their legacy names. */
interface StoredAdminState {
  siteid?: string;
  openSectionList?: string;
  moduleid?: string;
  keywords?: string;
  rb?: string;
  locale?: string;
  dateKeyFormat?: string;
  localeHasDayParts?: boolean;
  moduleTopIds?: Record<string, string>;
  mura?: Record<string, unknown>;
}

const storedStates = new WeakMap<FastifyRequest, Promise<StoredAdminState>>();

/** A non-2xx identity answer as the legacy 503 the service client raises for an unreachable callee. */
function identityUnavailable(status: number): ServiceUnavailableError {
  return new ServiceUnavailableError(IDENTITY_SERVICE, Object.assign(new Error(`${IDENTITY_SERVICE} answered HTTP ${status}`), { code: `HTTP_${status}` }));
}

/** The session values identity holds for the request's token, read once per request. */
function storedSession(request: FastifyRequest): Promise<StoredAdminState> {
  let found = storedStates.get(request);
  if (found === undefined) {
    found = (async () => {
      const res = await request.server.opt2.client.request<StoredAdminState | undefined>({ service: IDENTITY_SERVICE, method: 'GET', path: ADMIN_STATE_PATH });
      if (res.status < 200 || res.status > 299) throw identityUnavailable(res.status);
      return res.body ?? {};
    })();
    storedStates.set(request, found);
  }
  return found;
}

/** Stores admin session values in identity for a page response, which carries no session-effects header. */
async function saveSession(request: FastifyRequest, values: StoredAdminState): Promise<void> {
  const res = await request.server.opt2.client.request({ service: IDENTITY_SERVICE, method: 'POST', path: ADMIN_STATE_PATH, json: values });
  if (res.status < 200 || res.status > 299) throw identityUnavailable(res.status);
  storedStates.set(request, Promise.resolve({ ...(await storedSession(request)), ...values }));
}

/** `session.mura[name]` as stored, undefined when the session holds none. */
function muraValue(state: StoredAdminState, name: string): unknown {
  const mura = state.mura ?? {};
  const key = Object.keys(mura).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : mura[key];
}

/** A struct value, or {} for anything else. */
function structOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `session.flatViewArgs`, kept under `session.mura` in identity; {} by its `cfparam` default. */
function flatViewArgsOf(state: StoredAdminState): Record<string, Record<string, unknown>> {
  const stored = structOf(muraValue(state, 'flatViewArgs'));
  return Object.fromEntries(Object.entries(stored).map(([siteId, args]) => [siteId, { ...structOf(args) }]));
}

/** The Site Manager state the admin views read: open sections, flat view arguments and the copy clipboard. */
function sessionStateOf(state: StoredAdminState): AdminSessionState {
  const copyAll = muraValue(state, 'copyAll');
  return {
    openSectionList: state.openSectionList ?? '',
    flatViewArgs: flatViewArgsOf(state),
    copyContentId: String(muraValue(state, 'copyContentID') ?? ''),
    copySiteId: String(muraValue(state, 'copySiteID') ?? ''),
    copyAll: cfIsBoolean(copyAll) && cfToBoolean(copyAll),
  };
}

/** A renderer's or controller's session writes as the contract's session-effects header names them. */
function sessionEffectsOf(state: Partial<AdminSessionState> | undefined, mura: Record<string, unknown> = {}): SessionEffects | undefined {
  const effects: { openSectionList?: string; mura?: Record<string, unknown> } = {};
  const values: Record<string, unknown> = { ...mura };
  if (state?.openSectionList !== undefined) effects.openSectionList = state.openSectionList;
  if (state?.flatViewArgs !== undefined) values.flatViewArgs = state.flatViewArgs;
  if (state?.copyContentId !== undefined) values.copyContentID = state.copyContentId;
  if (state?.copySiteId !== undefined) values.copySiteID = state.copySiteId;
  if (state?.copyAll !== undefined) values.copyAll = state.copyAll;
  if (Object.keys(values).length > 0) effects.mura = values;
  return effects.openSectionList === undefined && effects.mura === undefined ? undefined : effects;
}

// ---- carch before() ----

/** The rc after carch `before()` and the module top id it leaves in `session['m<moduleid>']`. */
interface CarchRequest {
  rc: Rc;
  /** `session.moduleid` and its top id after the whitelist sync; null for an ajax request, which skips it. */
  moduleTop: { moduleId: string; topId: string } | null;
}

/** before()'s defaults of a non-ajax request, in legacy order (carch.cfc:24-77). */
function pageDefaults(): ReadonlyArray<readonly [string, unknown]> {
  return [
    ['return', ''],
    ['startrow', 1],
    ['contentid', ''],
    ['ptype', 'Page'],
    ['type', 'Page'],
    ['contentHistID', cfUuid()],
    ['parenthistid', ''],
    ['notify', ''],
    ['preview', 0],
    ['size', 20],
    ['action', ''],
    ['closeCompactDisplay', ''],
    ['compactDisplay', ''],
    ['returnURL', ''],
    ['homeID', ''],
    ['objectid', ''],
    ['locking', false],
    ['moduleAssign', ''],
    ['orderno', 0],
    ['cancelPendingApproval', false],
    ['date1', ''],
    ['date2', ''],
    ['ommitPublishingTab', false],
    ['ommitRelatedContentTab', false],
    ['ommitAdvancedTab', false],
    ['murakeepediting', false],
    ['locknode', false],
    ['frontend', false],
  ];
}

/**
 * carch `before()` (carch.cfc:20-108) over the request params: the rc defaults, the `session.moduleid` whitelist sync
 * and the module top id. The previous session values come only from identity's verified store, read when needed.
 */
async function carchContext(params: Rc, actor: Actor, session: () => Promise<StoredAdminState>): Promise<CarchRequest> {
  const rc: Rc = { ...params };
  // The site is the verified token's: a posted `siteid` never selects another site's rows.
  for (const key of Object.keys(rc)) if (key.toLowerCase() === 'siteid') delete rc[key];
  rc.siteid = actor.siteId;
  const ajaxRequest = cfToBoolean(rcParam(rc, 'ajaxrequest', false));
  rcParam(rc, 'moduleid', SITE_MANAGER_MODULE);
  rcParam(rc, 'instanceid', '');
  if (ajaxRequest) return { rc, moduleTop: null };
  for (const [name, value] of pageDefaults()) rcParam(rc, name, value);
  if (!rcFlag(rc, 'ommitPublishingTab')) {
    for (const [name, value] of [['isNav', 0], ['target', '_self'], ['searchExclude', 0], ['restricted', 0], ['mobileExclude', 0]] as const) rcParam(rc, name, value);
  }
  if (!rcFlag(rc, 'ommitAdvancedTab')) {
    for (const [name, value] of [['isLocked', 0], ['forceSSL', 0], ['doCache', 1], ['displayTitle', 0]] as const) rcParam(rc, name, value);
  }
  if (!rcFlag(rc, 'ommitRelatedContentTab')) rcParam(rc, 'relatedContentSetData', '');
  rcParam(rc, 'responseChart', 0);
  rcParam(rc, 'parentid', '');

  const requested = rcText(rc, 'moduleid');
  const topRequested = rcText(rc, 'topid');
  // The session is read only where legacy's values depend on it: a module id outside the whitelist, or no topid.
  const needsSession = requested === '' || !SESSION_MODULE_IDS.includes(requested) || topRequested === '';
  const state = needsSession ? await session() : {};
  let moduleId = state.moduleid !== undefined && SESSION_MODULE_IDS.includes(state.moduleid) ? state.moduleid : SITE_MANAGER_MODULE;
  if (requested !== '' && SESSION_MODULE_IDS.includes(requested)) moduleId = requested;
  if (requested === '' || moduleId !== requested) rcSet(rc, 'moduleid', moduleId);
  const tops = { ...MODULE_TOP_DEFAULTS, ...(state.moduleTopIds ?? {}) };
  const sessionTop = tops[`m${moduleId}`];
  if (topRequested === '' && sessionTop === undefined) {
    throw new UndefinedLegacyElementError(`Element M${moduleId} is undefined in a Java object of type class coldfusion.runtime.MemorySessionScope.`);
  }
  const topId = topRequested !== '' ? topRequested : (sessionTop ?? '');
  rcSet(rc, 'topid', topId);
  return { rc, moduleTop: { moduleId, topId } };
}

// ---- resource-bundle labels ----

/** Masa's core bundles and the application-level overrides, relative to this module in `src` and `dist` alike. */
const CORE_BUNDLE_DIR = new URL('../../../../../core/mura/resourceBundle/resources/', import.meta.url);
const OVERRIDE_BUNDLE_DIR = new URL('../../../../../resource_bundles/', import.meta.url);

/** java.util.Properties: `key=value`, `key:value` or `key value` lines, `#`/`!` comments, continuations and escapes. */
function parseProperties(text: string): Record<string, string> {
  const bundle: Record<string, string> = {};
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = (lines[i] ?? '').replace(/^[ \t\f]+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    // An odd run of trailing backslashes continues the logical line.
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      i += 1;
      line = line.slice(0, -1) + (lines[i] ?? '').replace(/^[ \t\f]+/, '');
    }
    const separator = /^((?:\\.|[^\\:= \t\f])*)[ \t\f]*[:=]?[ \t\f]*/.exec(line);
    const key = separator?.[1] ?? line;
    bundle[unescapeProperty(key)] = unescapeProperty(line.slice(separator?.[0].length ?? line.length));
  }
  return bundle;
}

/** The value of a properties token with `\uXXXX`, `\t`, `\n`, `\r`, `\f` and `\<char>` escapes resolved. */
function unescapeProperty(token: string): string {
  return token.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    if (escape.length === 5) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[escape] ?? escape;
  });
}

const bundleCache = new Map<string, Record<string, string>>();

/** The keys of locale `rb`: the core bundle with the application overrides over it; {} for a locale without files. */
function bundleOf(rb: string): Record<string, string> {
  const cached = bundleCache.get(rb);
  if (cached !== undefined) return cached;
  const read = (dir: URL): Record<string, string> => {
    const file = new URL(`${rb}.properties`, dir);
    return existsSync(file) ? parseProperties(readFileSync(file, 'utf8')) : {};
  };
  const bundle = { ...read(CORE_BUNDLE_DIR), ...read(OVERRIDE_BUNDLE_DIR) };
  bundleCache.set(rb, bundle);
  return bundle;
}

/** `rbFactory` labels of the session's `rb`, falling back to `en` as resourceBundleFactory.cfc does. */
function labelsOf(rb: string, javaLocale: string): AdminLabels {
  // Only the file's base name is taken from the session value, so it can never name another directory.
  const name = /^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$/.test(rb) ? rb.toLowerCase().split('_')[0] ?? 'en' : 'en';
  return createAdminLabels(bundleOf(name), bundleOf('en'), javaLocale);
}

// ---- site settings ----

/**
 * The site's content settings from verified registry data: its identity, primary domain and file pool; every setting
 * `content.tenant_registry` does not hold takes the settingsBean default.
 */
async function siteOf(ctx: ContentRouteContext, actor: Actor): Promise<ContentSaveSite> {
  const entry = await registryEntryForTenant(ctx.domain.db, actor.tenantId);
  const siteId = entry?.siteId ?? actor.siteId;
  const domain = entry?.domains[0] ?? '';
  return {
    siteId,
    site: '',
    locking: 'none',
    contentApprovalScript: '',
    contentRejectionScript: '',
    contentPendingScript: '',
    contentCanceledScript: '',
    contactEmail: '',
    columnCount: 3,
    customTagGroups: '',
    urls: {
      siteId,
      scheme: 'http',
      domain,
      requestDomain: domain,
      previewDomain: '',
      serverPort: '',
      context: '',
      siteIdInUrls: false,
      indexFileInUrls: false,
      hashUrls: false,
      useSSL: false,
      filePoolId: entry?.filePoolId || siteId,
      configFileAssetPath: '',
      // configBean getSiteAssetPath() is `/<siteDir>` (siteDir `sites`), and an empty `assetPath` setting defaults to it.
      assetPath: '/sites',
      siteAssetPath: '/sites',
      fileStore: 'fileDir',
      legacyIndexFileLocation: false,
      urlTitleDelim: '-',
      allowUnicodeInFilenames: false,
      placeholderImgId: '',
      placeholderImgExt: '',
      directImages: true,
    },
  };
}

/** The settingsBean values the admin views read, at their defaults where the registry holds none. */
interface SiteFlags {
  hasLockableNodes: boolean;
  hasChangesets: boolean;
  dataCollection: boolean;
  hasComments: boolean;
  scaffolding: boolean;
}

/** settingsBean defaults (settingsBean.cfc:83-159). */
const SITE_FLAGS: Readonly<SiteFlags> = Object.freeze({
  hasLockableNodes: false,
  hasChangesets: true,
  dataCollection: true,
  hasComments: true,
  scaffolding: false,
});

// ---- render context ----

/** What a renderer reads besides its model, without the CSRF issuer the two-pass render supplies. */
type RenderBase = Omit<AdminRenderContext, 'csrf'>;

/** The render context of the request: labels, the verified session, the site and the configBean defaults. */
async function renderBaseOf(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor, site: ContentSaveSite): Promise<RenderBase> {
  const state = await storedSession(request);
  const pools = await registryEntryForTenant(ctx.domain.db, actor.tenantId);
  const locale = state.locale ?? 'en_US';
  const nextN = muraValue(state, 'nextN');
  const session: AdminSession = {
    ...sessionStateOf(state),
    userId: actor.userId,
    siteId: state.siteid ?? actor.siteId,
    memberships: await sessionMemberships(request, ctx, actor),
    nextN: cfIsNumeric(nextN) && cfToNumber(nextN) > 0 ? cfToNumber(nextN) : 20,
    dateKeyFormat: state.dateKeyFormat ?? 'MM/DD/YYYY',
    rb: state.rb ?? 'en',
    locale,
  };
  return {
    labels: labelsOf(session.rb, locale),
    session,
    site: site.urls,
    siteSettings: {
      locking: site.locking,
      hasComments: SITE_FLAGS.hasComments,
      hasLockableNodes: SITE_FLAGS.hasLockableNodes,
      privateUserPoolId: pools?.privateUserPoolId ?? site.siteId,
      extranet: false,
    },
    config: { sortPermission: '', adminDir: '/admin', context: site.urls.context },
  };
}

/** identity's tokens for `contexts`, in request order. */
async function issueTokens(request: FastifyRequest, contexts: readonly string[]): Promise<Map<string, CsrfTokens>> {
  const res = await request.server.opt2.client.request<{ tokens: Array<{ context: string; csrf_token: string; csrf_token_expires: string }> }>({
    service: IDENTITY_SERVICE,
    method: 'POST',
    path: CSRF_TOKENS_PATH,
    json: { contexts },
  });
  if (res.status < 200 || res.status > 299) throw identityUnavailable(res.status);
  return new Map(res.body.tokens.map((t) => [t.context, { token: t.csrf_token, expires: t.csrf_token_expires }]));
}

/**
 * Renders twice: the first pass records the CSRF contexts the view asks for, identity issues their tokens, and the
 * second pass prints them. Renderers are pure, so both passes read the same model.
 */
async function renderWithTokens<T>(request: FastifyRequest, base: RenderBase, render: (rctx: AdminRenderContext) => T): Promise<T> {
  const asked = new Set<string>();
  const first = render({ ...base, csrf: (context) => (asked.add(context), { token: '', expires: '' }) });
  if (asked.size === 0) return first;
  const tokens = await issueTokens(request, [...asked]);
  return render({
    ...base,
    csrf: (context) => {
      const found = tokens.get(context);
      if (found === undefined) throw new RangeError(`identity issued no CSRF token for context ${context}`);
      return found;
    },
  });
}

// ---- CSRF where legacy validates ----

/** A reply stand-in for raw entries: adminCsrf's hook reads only `sent`, after its onReject, which never sends. */
const UNSENT_REPLY = Object.freeze({ sent: false }) as unknown as FastifyReply;

/** `validateCSRFTokens(context)` at the point legacy calls it: identity consumes a valid token once. */
async function validateCsrf(request: FastifyRequest, context: string, reply: FastifyReply = UNSENT_REPLY): Promise<boolean> {
  await adminCsrf(() => context).call(request.server, request, reply);
  return !csrfRejected(request);
}

// ---- results ----

/** A raw entry's answer: the renderer's result with the response headers legacy sends besides the content type. */
export type CarchRawResult = AdminRenderResult & { headers?: Record<string, string> };

/** A raw answer with the session-effects header when `effects` names any value. */
function withEffects(result: AdminRenderResult, effects: SessionEffects | undefined, headers: Record<string, string> = {}): CarchRawResult {
  const all = { ...headers };
  if (effects !== undefined) all[SESSION_EFFECTS_HEADER] = JSON.stringify(effects);
  const { sessionEffects: _ignored, ...rest } = result;
  return Object.keys(all).length === 0 ? rest : { ...rest, headers: all };
}

/** A renderer's answer with its own session writes as the session-effects header. */
function rendered(result: AdminRenderResult, mura: Record<string, unknown> = {}): CarchRawResult {
  return withEffects(result, sessionEffectsOf(result.sessionEffects, mura));
}

/** The empty body of an action that ends in a bare `abort`. */
function aborted(mura: Record<string, unknown> = {}): CarchRawResult {
  return withEffects({ status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '' }, sessionEffectsOf(undefined, mura));
}

/** A `cflocation` answer: 302 with the target in `Location`. */
function located(location: string): CarchRawResult {
  return { status: 302, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '', redirect: location, headers: { location } };
}

/** A query or bean value as the page model carries it: dates as ISO text, everything else unchanged. */
function modelValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(modelValue);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, modelValue(v)]));
  return value;
}

/** A content bean as `getAllValues()` gives it: the stored version, or the new bean's values, with `isNew`. */
function beanValues(bean: ContentBean): Record<string, unknown> {
  return bean.isNew === 0 ? { ...bean.version, isNew: 0 } : { ...bean.values, isNew: 1 };
}

/** A view model: the rc values the controller and view compute, as the contract's AdminViewModel. */
function viewModel(rc: Rc): { rc: Record<string, unknown> } {
  return { rc: modelValue(rc) as Record<string, unknown> };
}

/** The ids of a content bean: the stored version's, or the new bean's site and content id. */
function bareBean(bean: ContentBean): { contentId: string; contentHistId: string; siteId: string; fileId: string } {
  if (bean.isNew === 0) {
    return { contentId: bean.version.contentid ?? '', contentHistId: bean.version.contenthistid ?? '', siteId: bean.version.siteid ?? '', fileId: bean.version.fileid ?? '' };
  }
  return { contentId: 'contentid' in bean.values ? bean.values.contentid : '', contentHistId: '', siteId: bean.values.siteid, fileId: '' };
}

/** Runs a read in the token's tenant. */
function inTenant<T>(ctx: ContentRouteContext, actor: Actor, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return ctx.domain.db.withTenant(actor.tenantId, fn);
}

/** contentBean `getEditURL(compactDisplay)` (contentBean.cfc:1325-1349) of a version's values. */
function editUrlOf(values: Rc, compactDisplay: boolean, context = ''): string {
  const v = (name: string): string => esapiUrlEncode(rcText(values, name));
  const topId = ['form', 'component'].includes(rcText(values, 'type').toLowerCase()) ? rcText(values, 'moduleid') : LEGACY_ADMIN_SENTINEL_ID;
  return (
    `${context}/admin/?muraAction=cArch.edit&contenthistid=${v('contenthistid')}&contentid=${v('contentid')}&type=${v('type')}` +
    `&siteid=${v('siteid')}&topid=${esapiUrlEncode(topId)}&parentid=${v('parentid')}&moduleid=${v('moduleid')}` +
    `&compactdisplay=${compactDisplay ? 'true' : 'false'}`
  );
}

// ---- page operations ----

/** The rc of a page request: its params, then the path parameters, under their legacy names. */
function pageParams(request: FastifyRequest, path: Readonly<Record<string, string>>): Rc {
  const rc = paramsOf(request);
  for (const [name, value] of Object.entries(path)) rcSet(rc, name, value);
  return rc;
}

/** list.cfm's `session.flatViewArgs[session.siteid]` defaults and request updates (list.cfm:494-584); returns the struct and whether it changed. */
function flatViewArgsFor(state: StoredAdminState, rc: Rc, url: Rc, sessionSiteId: string): { all: Record<string, Record<string, unknown>>; changed: boolean } {
  const all = flatViewArgsOf(state);
  const before = JSON.stringify(all);
  const args = (all[sessionSiteId] ??= {});
  if (rcHas(rc, 'refreshFlatview')) {
    args.report = rcGet(rc, 'report');
    if (rcHas(rc, 'reportSortBy')) args.sortby = rcGet(rc, 'reportSortBy');
    if (rcHas(rc, 'reportSortDirection')) args.direction = rcGet(rc, 'reportSortDirection');
  }
  const defaults: ReadonlyArray<readonly [string, unknown]> = [
    ['moduleid', rcGet(rc, 'moduleid')],
    ['sortby', 'lastupdate'],
    ['sortdirection', 'desc'],
    ['lockid', rcGet(rc, 'lockid')],
    ['assignments', rcGet(rc, 'assignments')],
    ['categoryid', rcGet(rc, 'categoryid')],
    ['tags', rcGet(rc, 'tags')],
    ['page', rcGet(rc, 'page')],
    ['type', ''],
    ['subtype', rcGet(rc, 'subtype')],
    ['report', ''],
    ['keywords', ''],
    ['tab', 0],
  ];
  for (const [name, value] of defaults) if (!rcHas(args, name)) args[name] = value;
  if (!rcHas(args, 'filtered') || !cfIsBoolean(rcGet(args, 'filtered'))) args.filtered = false;
  if (rcHas(url, 'keywords')) {
    if (rcText(args, 'keywords') !== rcText(url, 'keywords')) args.page = 1;
    args.keywords = rcGet(url, 'keywords');
    args.report = '';
  }
  return { all, changed: JSON.stringify(all) !== before };
}

/** carch.list (carch.cfc:214-228) with list.cfm's content-module reads; the rc the Site Manager screen renders from. */
async function siteManagerTree(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor, siteId: string): Promise<{ rc: Record<string, unknown> }> {
  const url = paramsOf(request);
  const { rc, moduleTop } = await carchContext(pageParams(request, { siteid: siteId }), actor, () => storedSession(request));
  const { topId, rows, reset } = await listTop(ctx, actor, rc);
  if (reset) await saveTreeReset(request, moduleTop?.moduleId ?? (await storedSession(request)).moduleid ?? SITE_MANAGER_MODULE, topId);
  rcSet(rc, 'topid', topId);
  rcSet(rc, 'rsTop', rows);
  const moduleId = rcText(rc, 'moduleid');
  const site = await siteOf(ctx, actor);
  rcSet(rc, 'siteConfig', {
    customTagGroups: site.customTagGroups ?? '',
    scaffolding: SITE_FLAGS.scaffolding,
    dataCollection: SITE_FLAGS.dataCollection,
    hasLockableNodes: SITE_FLAGS.hasLockableNodes,
  });
  if (!CONTENT_MODULES.includes(moduleId)) {
    rcSet(rc, 'nextN', getNextN(rows.length, LIST_NEXT_N, rcRow(rc, 'startrow')));
    return viewModel(rc);
  }
  const state = await storedSession(request);
  const sessionSiteId = state.siteid ?? actor.siteId;
  const saves: StoredAdminState = {};
  const mura: Record<string, unknown> = { ...(state.mura ?? {}) };
  let muraChanged = false;
  rcSet(rc, 'crumbdata', await getCrumbList(ctx.domain, actor, { contentId: topId, siteId }));
  if (cfIsNumeric(rcGet(rc, 'nextN')) && cfToNumber(rcGet(rc, 'nextN')) > 0) {
    mura.nextN = rcGet(rc, 'nextN');
    muraChanged = true;
    rcSet(rc, 'startrow', 1);
  }
  const first = rows[0];
  if (!rcHas(rc, 'saveSort')) {
    rcSet(rc, 'sortBy', first?.sortby ?? '');
    rcSet(rc, 'sortDirection', first?.sortdirection ?? '');
  }
  for (const [name, value] of [['sorted', false], ['lockid', ''], ['assignments', false], ['categoryid', ''], ['tags', ''], ['type', ''], ['page', 1], ['subtype', '']] as const) {
    rcParam(rc, name, value);
  }
  const flat = flatViewArgsFor(state, rc, url, sessionSiteId);
  if (flat.changed) {
    mura.flatViewArgs = flat.all;
    muraChanged = true;
  }
  if (rcHas(url, 'keywords')) saves.keywords = rcText(url, 'keywords');
  if (muraChanged) saves.mura = mura;
  if (Object.keys(saves).length > 0) await saveSession(request, saves);
  const clipboard = sessionStateOf(state);
  rcSet(rc, 'copyContentID', clipboard.copyContentId);
  rcSet(rc, 'copySiteID', clipboard.copySiteId);
  rcSet(rc, 'copyAll', clipboard.copyAll);
  const copyModuleId = muraValue(state, 'copyModuleID');
  if (copyModuleId !== undefined) rcSet(rc, 'copyModuleID', copyModuleId);
  rcSet(rc, 'flatViewArgs', flat.all[sessionSiteId] ?? {});
  rcSet(rc, 'modulePerms', {
    [COMPONENTS_MODULE]: await getPerm(ctx.domain, actor, COMPONENTS_MODULE, sessionSiteId),
    [FORMS_MODULE]: await getPerm(ctx.domain, actor, FORMS_MODULE, sessionSiteId),
  });
  rcSet(rc, 'variations', ctx.domain.config.variations);
  if (!rcHas(url, 'activeTab')) rcSet(rc, 'activeTab', rcGet(flat.all[sessionSiteId] ?? {}, 'tab'));
  return viewModel(rc);
}

/** `contentManager.getList(rc)` (contentManager.cfc:147-243) with list()'s empty-result fallback to the module's top. */
async function listTop(ctx: ContentRouteContext, actor: Actor, rc: Rc) {
  const siteId = rcText(rc, 'siteid');
  const read = (topId: string) => inTenant(ctx, actor, (tx) => ctx.domain.repository.content.top(tx, { topId, siteId }));
  let topId = rcText(rc, 'topid') || LEGACY_ADMIN_SENTINEL_ID;
  let rows = await read(topId);
  if (rows.length > 0) return { topId, rows, reset: false };
  const moduleId = rcText(rc, 'moduleid');
  topId = moduleId === SITE_MANAGER_MODULE ? LEGACY_ADMIN_SENTINEL_ID : moduleId;
  rows = await read(topId);
  return { topId, rows, reset: true };
}

/** carch.edit and carch.editLive (carch.cfc:285-331): the edit screen's rc, or the node editLive opens. */
async function contentEditModel(
  request: FastifyRequest,
  ctx: ContentRouteContext,
  actor: Actor,
  path: { siteid: string; contentid: string },
): Promise<{ rc: Record<string, unknown> }> {
  const url = paramsOf(request);
  const { rc } = await carchContext(pageParams(request, path), actor, () => storedSession(request));
  const siteId = rcText(rc, 'siteid');
  const contentId = rcText(rc, 'contentid');
  const site = await siteOf(ctx, actor);
  if (!rcHas(url, 'contenthistid')) {
    // editLive: the node by title (typed for forms and components), else by id, then `setType(rc.type)` with before()'s default.
    const title = rcText(url, 'title');
    const type = rcText(rc, 'type');
    const typed = ['form', 'component'].includes(type.toLowerCase());
    const bean = await readContent(ctx.domain, actor, title !== '' ? { siteId, title, ...(typed ? { type } : {}) } : { siteId, contentId });
    const now = ctx.clock.now();
    const content = bean.isNew === 0 ? LegacyContentBean.fromVersion(bean.version, actor, now) : LegacyContentBean.notFound(actor, now, siteId);
    content.setValue('type', type);
    // getEditURL reads contenthistid, then contentid; a new bean mints each.
    content.contentHistId();
    content.contentId();
    const values = Object.fromEntries(content.entries());
    return viewModel({ ...rc, contentBean: { ...values, editUrl: editUrlOf(values, true, site.urls.context) } });
  }
  const version = await getContentVersion(ctx.domain, actor, { contentHistId: rcText(rc, 'contenthistid'), siteId });
  // fw.redirect to cArch.hist, which web takes from the model's new bean, runs before anything else the view reads.
  if (!cfEq(rcText(rc, 'type'), 'Variation') && contentId !== '' && rcText(rc, 'contenthistid') !== '' && version.isNew === 1 && rcText(rc, 'instanceid') === '') {
    return viewModel({ ...rc, contentBean: beanValues(version) });
  }
  // A page operation answers the contract's JSON 503; raw entries keep the admin error page.
  throw editFormHalted('edit', 'auto');
}

/**
 * The edit form (edit.cfm and its panels) prints data only other owners or the legacy web root hold, so carch.edit and
 * update.cfm's re-render of a rejected save are halted, before any write, rather than served with guessed values.
 */
function editFormHalted(action: string, surface: LegacyErrorSurface = 'admin'): CarchHaltedError {
  return new CarchHaltedError(
    action,
    "the edit form prints the node's notify recipients (people and identity data), the theme's templates and display-object registry (legacy web root) and site settings only programs-sites holds",
    surface,
  );
}

/** The attachment link parts the data manager writes, from the site's URL settings. */
function attachmentLink(site: ContentSaveSite): AttachmentLinkParts {
  return { scheme: site.urls.scheme, domain: site.urls.domain, serverPort: site.urls.serverPort, context: site.urls.context };
}

/** carch.datamanager (carch.cfc:472-475) and datamanager.cfm's reads, without the in-view writes the delete operation runs. */
async function formResponsesModel(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor, path: { siteid: string; contentid: string }): Promise<Rc> {
  const { rc } = await carchContext(pageParams(request, path), actor, () => storedSession(request));
  const siteId = rcText(rc, 'siteid');
  const contentId = rcText(rc, 'contentid');
  const state = await storedSession(request);
  const crumbData = await getCrumbList(ctx.domain, actor, { contentId, siteId });
  const bean = await getActiveForm(ctx.domain, actor, contentId, siteId);
  for (const [name, value] of [['keywords', ''], ['filterBy', ''], ['sortBy', bean.text('sortby')], ['sortDirection', bean.text('sortdirection')]] as const) {
    rcParam(rc, name, value);
  }
  const rsDataInfo = await getDownloadSelect(ctx.domain, actor, contentId, siteId);
  const locale = state.locale ?? 'en_US';
  const action = rcText(rc, 'action');
  const listing = await responseList(ctx.domain, actor, rc, bean, rsDataInfo, locale);
  const view: Rc = { ...listing.rc };
  if (cfEq(action, 'display')) rcSet(view, 'fieldnames', await getFullFieldList(ctx.domain, actor, contentId));
  let rsData: unknown = listing.rows?.map((row) => ({ responseID: row.responseid, entered: row.entered, data: safeValues(row) })) ?? [];
  if (cfEq(action, 'edit')) {
    const row = await readResponse(ctx.domain, actor, rcText(rc, 'responseid'));
    rsData = row === null ? [] : [{ responseID: row.responseid, entered: row.entered, data: safeValues(row) }];
  }
  const stats = await inTenant(ctx, actor, (tx) => ctx.domain.repository.stats.readStats(tx, { contentId, siteId }));
  const site = await siteOf(ctx, actor);
  return {
    ...view,
    crumbData,
    contentBean: { ...Object.fromEntries(bean.entries()), stats: stats ?? {} },
    perm: await getNodePerm(ctx.domain, actor, crumbData),
    hasLockableNodes: SITE_FLAGS.hasLockableNodes,
    useLayoutManager: false,
    rsDataInfo,
    rsData,
    ...attachmentLink(site),
  };
}

/** A packet's deserialised values, or null where `wddx2cfml` fails, as the data manager view treats it. */
function safeValues(row: Parameters<typeof responseValues>[0]): unknown {
  try {
    return responseValues(row);
  } catch {
    return null;
  }
}

/** The rc values the history and audit screens read: the screen model's beans and rows under their legacy names. */
function versionScreenRc(model: Awaited<ReturnType<typeof getHistory>> | Awaited<ReturnType<typeof getAudit>>): Rc {
  return {
    contentBean: beanValues(model.contentBean),
    rsCount: model.rsCount,
    crumbdata: model.crumbs,
    perm: model.perm,
    stats: model.stats ?? {},
  };
}

/** Registers the carch page and write operations the contract lists; raw responses are registered by `./raw.ts`. */
export async function registerCarchRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  const config = circuitRouteConfig('carch');
  type Site = { Params: { siteid: string } };
  type Item = { Params: { siteid: string; contentid: string } };
  type Version = { Params: { siteid: string; contenthistid: string } };

  /** carch.list: the Site Manager tree level under `topid`. */
  app.get<Site>('/v1/sites/:siteid/content/tree', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    return siteManagerTree(request, ctx, actor, request.params.siteid);
  });

  /** carch.search (carch.cfc:488-492): the private search and its pager. */
  app.get<Site>('/v1/sites/:siteid/content', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, { siteid: request.params.siteid }), actor, () => storedSession(request));
    if (!rcHas(rc, 'keywords')) throw new UndefinedLegacyElementError('Element KEYWORDS is undefined in RC.');
    const startRow = rcRow(rc, 'startrow');
    const result = await privateSearch(ctx.domain, actor, { siteId: rcText(rc, 'siteid'), keywords: rcText(rc, 'keywords'), startRow });
    await saveSession(request, { keywords: result.sessionEffect.keywords });
    const state = sessionStateOf(await storedSession(request));
    return viewModel({
      ...rc,
      rslist: result.rows,
      nextn: getNextN(result.rows.length, PRIVATE_SEARCH_RECORDS_PER_PAGE, startRow),
      copyContentID: state.copyContentId,
      copySiteID: state.copySiteId,
    });
  });

  /** carch.draft (carch.cfc:250-252): the session user's drafts. */
  app.get<Site>('/v1/sites/:siteid/content/drafts', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, { siteid: request.params.siteid }), actor, () => storedSession(request));
    return viewModel({ ...rc, rsList: await getDraftList(ctx.domain, actor, { siteId: rcText(rc, 'siteid') }) });
  });

  /** carch.edit and carch.editLive: the edit screen model, or the node editLive opens. */
  app.get<Item>('/v1/sites/:siteid/content/:contentid', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    return contentEditModel(request, ctx, actor, request.params);
  });

  /** carch.hist (carch.cfc:456-459): the node's versions. */
  app.get<Item>('/v1/sites/:siteid/content/:contentid/history', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const model = await getHistory(ctx.domain, actor, { contentId: request.params.contentid, siteId: rcText(rc, 'siteid') });
    return viewModel({ ...rc, ...versionScreenRc(model), items: model.items, historyTotal: model.historyTotal });
  });

  /** carch.audit (carch.cfc:464-467): one version's audit trail. */
  app.get<{ Params: { siteid: string; contentid: string; contenthistid: string } }>(
    '/v1/sites/:siteid/content/:contentid/versions/:contenthistid/audit',
    { config },
    async (request) => {
      const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
      const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
      const model = await getAudit(ctx.domain, actor, { contentId: request.params.contentid, siteId: rcText(rc, 'siteid'), contentHistId: request.params.contenthistid });
      return viewModel({ ...rc, ...versionScreenRc(model), items: model.trail.map((version) => ({ ...version })) });
    },
  );

  /** carch.multiFileUpload (carch.cfc:536-541): the upload screen for new children of `parentid`. */
  app.get<Item>('/v1/sites/:siteid/content/:contentid/multi-file-upload', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, { siteid: request.params.siteid, parentid: request.params.contentid }), actor, () =>
      storedSession(request),
    );
    const siteId = rcText(rc, 'siteid');
    const crumbdata = await getCrumbList(ctx.domain, actor, { contentId: rcText(rc, 'parentid'), siteId });
    return viewModel({
      ...rc,
      crumbdata,
      perm: await getNodePerm(ctx.domain, actor, crumbdata),
      rsCount: await getItemCount(ctx.domain, actor, { contentId: rcText(rc, 'contentid'), siteId }),
      rsPageCount: [{ counter: await getPageCount(ctx.domain, actor, siteId) }],
      rsRestrictGroups: await restrictGroups(ctx.domain, actor),
    });
  });

  /** carch.lockcheck and carch.relatedcontent: a version and its node stats; an unknown version reads as a new node. */
  app.get<Version>('/v1/sites/:siteid/content/versions/:contenthistid/summary', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const siteId = rcText(rc, 'siteid');
    const version = await getContentVersion(ctx.domain, actor, { contentHistId: request.params.contenthistid, siteId });
    const stats = await inTenant(ctx, actor, (tx) => ctx.domain.repository.stats.readStats(tx, { contentId: bareBean(version).contentId, siteId }));
    return viewModel({ ...rc, contentBean: { ...beanValues(version), stats: stats ?? {} }, stats: stats ?? {} });
  });

  /** carch.updateObjectParams (carch.cfc:546-573): a display object's params on a version; legacy checks no token. */
  app.post<Version>('/v1/sites/:siteid/content/versions/:contenthistid/object-params', { config }, async (request): Promise<AdminWriteResult> => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const saved = await updateObjectParams(ctx.domain, actor, await siteOf(ctx, actor), rc);
    if (saved === null) return { saved: false, errors: {}, redirect: null };
    return { saved: true, errors: saved.errors, redirect: null, data: modelValue({ versionBean: Object.fromEntries(saved.entries()) }) as Record<string, unknown> };
  });

  /** carch.datamanager (carch.cfc:472-475): a form's responses as datamanager.cfm lists them. */
  app.get<Item>('/v1/sites/:siteid/forms/:contentid/responses', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    return viewModel(await formResponsesModel(request, ctx, actor, request.params));
  });

  /** datamanager.cfm's in-view writes: Update and Delete of `responseid` with valid tokens, `setDisplay`, the filtered delete. */
  app.post<Item>('/v1/sites/:siteid/forms/:contentid/responses/delete', { config }, async (request, reply): Promise<AdminWriteResult> => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const state = await storedSession(request);
    const result = await dataManagerAction(ctx.domain, actor, rc, {
      validateCsrfTokens: (context) => validateCsrf(request, context, reply),
      files: await uploadsOf(request),
      locale: state.locale ?? 'en_US',
      requestId: request.id,
    });
    if (rcHas(rc, 'newSearch')) await saveSession(request, { mura: { ...(state.mura ?? {}), filterBy: rcGet(result.rc, 'filterBy'), datakeywords: rcGet(result.rc, 'keywords') } });
    return {
      saved: result.outcome !== 'none',
      errors: {},
      redirect: null,
      data: modelValue({ ...result.rc, outcome: result.outcome, view: result.view, rsDataInfo: result.rsDataInfo, filteredDeletions: result.filteredDeletions }) as Record<string, unknown>,
    };
  });

  registerCarchMediaRoutes(app, ctx);
}

/** feedBean `getAvailableDisplayList()` base fields (feedBean.cfc:740). */
const FEED_DISPLAY_FIELDS = 'Date,Title,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating';
/** feedBean's `displayList` default. */
const FEED_DISPLAY_DEFAULT = 'Date,Title,Image,Summary,Credits,Tags';
/** selectmedia.cfm's image extensions. */
const MEDIA_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg'];

/** `classExtensionManager.getExtendedAttributeList(siteid, 'tcontent')` names, distinct and sorted as the view's query sorts them. */
async function contentAttributeNames(ctx: ContentRouteContext, actor: Actor, siteId: string): Promise<string[]> {
  // feedBean.getAvailableDisplayList's query of queries: `group by attribute order by attribute`, case-sensitively.
  return [...new Set((await extendedAttributeList(ctx, actor, siteId)).map((row) => row.attribute))].sort();
}

/** The image picker, field picker and variation-targeting screens of carch. */
function registerCarchMediaRoutes(app: FastifyInstance, ctx: ContentRouteContext): void {
  const config = circuitRouteConfig('carch');
  type Site = { Params: { siteid: string } };

  /** carch.selectmedia (selectmedia.cfm:6-29): the png, jpg, jpeg and svg files of a node, its children and grandchildren. */
  app.get<Site>('/v1/sites/:siteid/content/images', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const siteId = rcText(rc, 'siteid');
    const contentId = rcText(rc, 'contentid');
    const site = await siteOf(ctx, actor);
    const node = await getActiveContent(ctx.domain, actor, { contentId, siteId });
    const children = (await getNest(ctx.domain, actor, { parentId: contentId, siteId })).rows;
    const grandchildren = [];
    for (const child of children) grandchildren.push(...(await getNest(ctx.domain, actor, { parentId: child.contentid ?? '', siteId })).rows);
    const candidates = [
      ...(node.isNew === 0 ? [{ fileid: node.version.fileid, title: node.version.title, contentid: node.version.contentid, fileext: node.version.fileext }] : []),
      ...[...children, ...grandchildren].map((row) => ({ fileid: row.fileid, title: row.title, contentid: row.contentid, fileext: row.fileext })),
    ];
    const seen = new Set<string>();
    const rsImages = candidates.flatMap((row) => {
      const key = `${row.fileid ?? ''}|${row.title ?? ''}|${row.contentid ?? ''}`;
      if (!row.fileid || !MEDIA_EXTENSIONS.includes((row.fileext ?? '').toLowerCase()) || seen.has(key)) return [];
      seen.add(key);
      return [{ fileid: row.fileid, title: row.title, contentid: row.contentid, imageURL: imageUrl(site.urls, { fileId: row.fileid, fileExt: row.fileext ?? '', size: 'small' }) }];
    });
    rcParam(rc, 'fileid', '');
    return viewModel({ ...rc, rsImages });
  });

  /** carch.imagedetails: the files' metadata and rendition URLs. */
  app.get<Site>('/v1/sites/:siteid/files/image-details', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const siteId = rcText(rc, 'siteid');
    rcParam(rc, 'fileid', '');
    rcParam(rc, 'imagesize', '');
    const site = await siteOf(ctx, actor);
    if (rcText(rc, 'contenthistid') !== '' && rcText(rc, 'fileid') === '') {
      const version = await getContentVersion(ctx.domain, actor, { contentHistId: rcText(rc, 'contenthistid'), siteId });
      rcSet(rc, 'contentBean', beanValues(version));
      rcSet(rc, 'fileid', bareBean(version).fileId);
    }
    const fileIds = cfListToArray(rcText(rc, 'fileid'));
    const files = await inTenant(ctx, actor, (tx) => ctx.domain.repository.content.fileJoinColumns(tx, fileIds));
    const images = fileIds.map((fileId) => {
      const file = files.find((row) => cfEq(row.fileid, fileId));
      const ext = file?.fileext ?? '';
      const url = (size: string): string => imageUrl(site.urls, { fileId, fileExt: ext, size });
      return { fileid: fileId, rsMeta: file ?? null, sourceImage: url('source'), small: url('small'), medium: url('medium'), large: url('large') };
    });
    return viewModel({ ...rc, images });
  });

  /** carch.selectfields (selectfields.cfm): a collection's selected and available display fields. */
  app.get<Site>('/v1/sites/:siteid/feeds/display-fields', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const url = paramsOf(request);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const displayList = rcHas(url, 'displayList') ? rcText(url, 'displayList') : FEED_DISPLAY_DEFAULT;
    const extended = await contentAttributeNames(ctx, actor, rcText(rc, 'siteid'));
    const available = [...cfListToArray(FEED_DISPLAY_FIELDS), ...extended];
    for (const field of cfListToArray(displayList)) if (!available.some((name) => cfEq(name, field))) available.push(field);
    return viewModel({ ...rc, displayList, availableList: available.join(',') });
  });

  /** carch.variationtargeting (variationtargeting.cfm:1-4): the variation node of `remoteid` with the request's values. */
  app.get<Site>('/v1/sites/:siteid/variation-targeting', { config }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const siteId = rcText(rc, 'siteid');
    const bean = await readContent(ctx.domain, actor, { siteId, remoteId: rcRequired(rc, 'remoteid') });
    const values = { ...beanValues(bean), ...rc, isNew: bean.isNew };
    const targeting = await readVariationTargeting(ctx.domain, actor, { contentId: rcText(values, 'contentid'), siteId });
    return viewModel({ ...rc, contentBean: { ...values, variationTargeting: targeting } });
  });

  /** carch.variationtargeting's save (variationtargeting.cfm:5-10): the new node, then its targeting's initialization JS. */
  app.post<Site>('/v1/sites/:siteid/variation-targeting', { config }, async (request): Promise<AdminWriteResult> => {
    const actor = await requireCircuitAccess(request, ctx, 'carch', request.params.siteid);
    const { rc } = await carchContext(pageParams(request, request.params), actor, () => storedSession(request));
    const siteId = rcText(rc, 'siteid');
    const site = await siteOf(ctx, actor);
    const found = await readContent(ctx.domain, actor, { siteId, remoteId: rcRequired(rc, 'remoteid') });
    let contentId = bareBean(found).contentId;
    let errors: Record<string, string> = {};
    let node: Record<string, unknown> = { ...beanValues(found), ...rc };
    if (found.isNew === 1) {
      const saved = await saveContent(ctx.domain, actor, site, { ...rc, siteid: siteId });
      contentId = saved.bean.contentId();
      errors = saved.errors;
      node = { ...Object.fromEntries(saved.bean.entries()), isNew: 0 };
    }
    const targeting = await withGatedTenant(ctx.domain.db, actor.tenantId, (tx) =>
      saveVariationTargetingInTx(tx, ctx.domain.repository, { contentid: contentId, siteid: siteId, initjs: rcRequired(rc, 'initjs') }, actor),
    );
    return { saved: Object.keys(errors).length === 0, errors, redirect: null, data: modelValue({ contentBean: node, variationTargeting: targeting, useLayoutManager: false }) as Record<string, unknown> };
  });
}

// ---- raw responses ----

/** A carried case whose legacy answer prints data this service can neither read nor project; answered as the legacy 503 instead of diverging. */
class CarchHaltedError extends LegacyServiceUnavailableError {
  override readonly name: string = 'CarchHaltedError';

  constructor(action: string, reason: string, surface: LegacyErrorSurface = 'admin') {
    super(`carch.${action}: ${reason}`, surface, `carch-${action}-halted`);
  }
}

/** `rc[name]` as text, raising ACF's error where the request lacks the element legacy dereferences. */
function rcRequired(rc: Rc, name: string): string {
  if (!rcHas(rc, name)) throw new UndefinedLegacyElementError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return rcText(rc, name);
}

/** A raw entry's rc: carch before() over the request params. */
async function rawRc(request: FastifyRequest, actor: Actor): Promise<Rc> {
  return (await carchContext(paramsOf(request), actor, () => storedSession(request))).rc;
}

/** Renders with the request's render context and identity's tokens for the contexts the view prints. */
async function renderRaw<T>(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor, render: (rctx: AdminRenderContext) => T): Promise<T> {
  const site = await siteOf(ctx, actor);
  return renderWithTokens(request, await renderBaseOf(request, ctx, actor, site), render);
}

/** A panel renderer's answer with its `session.mura` writes as session effects. */
function panelResult(result: PanelRenderResult): CarchRawResult {
  const mura: Record<string, unknown> = {};
  if (result.muraSessionEffects?.clearEditBean === true) mura.editBean = null;
  if (result.muraSessionEffects?.objectInstanceId !== undefined) mura.objectInstanceId = result.muraSessionEffects.objectInstanceId;
  return withEffects({ status: result.status, contentType: result.contentType, body: result.body }, sessionEffectsOf(undefined, mura));
}

/** A panel answer, where a branch only CFML renders is halted. */
function panelOrHalt(action: string, result: PanelRenderResult | PanelDelegation): CarchRawResult {
  if ('delegate' in result) throw new CarchHaltedError(action, result.reason);
  return panelResult(result);
}

/** A version as contentBean `loadBy(contenthistid)` leaves it: the stored row, or the new bean of a missing one. */
async function legacyVersion(ctx: ContentRouteContext, actor: Actor, contentHistId: string, siteId: string): Promise<LegacyContentBean> {
  const bean = await getContentVersion(ctx.domain, actor, { contentHistId, siteId });
  return bean.isNew === 0 ? LegacyContentBean.fromVersion(bean.version, actor, ctx.clock.now()) : LegacyContentBean.notFound(actor, ctx.clock.now(), siteId);
}

/** A bean's `getLastUpdate()`: its date, or the request's `now()` a new bean holds. */
function lastUpdateOf(bean: LegacyContentBean, now: Date): Date {
  const value = bean.raw('lastupdate');
  return value instanceof Date ? value : now;
}

/** `bean.getAllValues()` as the diff reads it: each member in ACF struct order with its value. */
function diffVersionOf(bean: LegacyContentBean, now: Date): DiffVersion {
  const entries = new Map(bean.entries().map(([name, value]) => [name, value] as const));
  return { lastUpdate: lastUpdateOf(bean, now), values: acfStructKeyOrder([...entries.keys()]).map((name) => [name, entries.get(name)] as const) };
}

/** A version as the draft prompt prints it. */
function promptVersionOf(bean: LegacyContentBean, now: Date): DraftPromptVersion {
  return { approved: bean.number('approved'), menutitle: bean.text('menutitle'), lastupdate: lastUpdateOf(bean, now), lastupdateby: bean.text('lastupdateby') };
}

/** carch.saveQuickEdit (carch.cfc:254-283): one attribute of an Editor's node without drafts; always an empty body. */
async function runSaveQuickEdit(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  await saveQuickEdit(ctx.domain, actor, await siteOf(ctx, actor), { rc, csrfValid: !csrfRejected(request) });
  return aborted();
}

/** carch.lockFile (carch.cfc:578-590): the file lock, then the download; an empty body where legacy aborts. */
async function runLockFile(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  if (csrfRejected(request)) return aborted();
  const site = await siteOf(ctx, actor);
  const outcome = await lockFile(ctx.domain, actor, { contentId: rcRequired(rc, 'contentid'), siteId: rcText(rc, 'siteid'), context: site.urls.context, requestId: request.id });
  return outcome.locked ? located(outcome.location) : aborted();
}

/** carch.unlockFile and carch.unlockNode (carch.cfc:595-628): the actor's or an S2's lock cleared; an empty body. */
function runUnlock(unlock: typeof unlockFile): (request: FastifyRequest, ctx: ContentRouteContext, actor: Actor) => Promise<CarchRawResult> {
  return async (request, ctx, actor) => {
    const rc = await rawRc(request, actor);
    if (!csrfRejected(request)) await unlock(ctx.domain, actor, { contentId: rcRequired(rc, 'contentid'), siteId: rcText(rc, 'siteid'), requestId: request.id });
    return aborted();
  };
}

/** carch.saveCopyInfo (carch.cfc:528-531): the Site Manager clipboard; legacy checks no token. */
async function runSaveCopyInfo(request: FastifyRequest, _ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const effect = saveCopyInfo({ siteId: rcText(rc, 'siteid'), contentId: rcRequired(rc, 'contentID'), moduleId: rcText(rc, 'moduleid'), copyAll: rcRequired(rc, 'copyAll') });
  if (effect.kind !== 'copyInfo') throw new TypeError('saveCopyInfo answered no clipboard');
  return aborted({ copySiteID: effect.copySiteID, copyContentID: effect.copyContentID, copyModuleID: effect.copyModuleID, copyAll: effect.copyAll });
}

/** carch.siteManagerTab (carch.cfc:516-523): the Site Manager tab of the session's site; legacy checks no token. */
async function runSiteManagerTab(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const state = await storedSession(request);
  const effect = siteManagerTab({ siteId: state.siteid ?? actor.siteId, tab: rcRequired(rc, 'tab') });
  if (effect.kind !== 'flatViewArgs') throw new TypeError('siteManagerTab answered no tab');
  const base = await renderBaseOf(request, ctx, actor, await siteOf(ctx, actor));
  return rendered(renderSiteManagerTab(effect.tab, { session: { ...base.session, siteId: effect.siteId } }));
}

/** approvalaction.cfm: approve, cancel or reject a request; legacy's CSRF test is `true or …`, a reported defect reproduced by consuming no token. */
async function runApprovalAction(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const input = { requestId: rcRequired(rc, 'requestID'), action: rcRequired(rc, 'action'), comment: rcRequired(rc, 'comment') };
  const result = await approvalAction(ctx.domain, actor, await siteOf(ctx, actor), input);
  return rendered(renderApprovalActionJson({ contenthistid: result.value.contenthistid, previewUrl: result.value.previewurl }));
}

/** carch.getAuditTrail (carch.cfc:630-643): the version and its sources' ids. */
async function runGetAuditTrail(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  return rendered(renderAuditTrailJson(await getAuditTrail(ctx.domain, actor, rcRequired(rc, 'contenthistid'))));
}

/** carch.getImageSizeURL (carch.cfc:645-649): `getURLForImage(fileid, size)`, the extension read from the file. */
async function runGetImageSizeUrl(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const fileId = rcRequired(rc, 'fileid');
  const size = rcRequired(rc, 'size');
  const site = await siteOf(ctx, actor);
  // The file sits where the site's `filePoolID` places it.
  const [file] = fileId === '' ? [] : await withPoolTenant(ctx.domain.db, actor.tenantId, 'file', (tx) => ctx.domain.repository.content.fileJoinColumns(tx, [fileId]));
  return rendered(renderImageSizeUrlJson(imageUrl(site.urls, { fileId, size, fileExtOf: () => file?.fileext ?? '' })));
}

/** carch.downloaddata (downloaddata.cfm): a form's responses as the CSV download legacy sends. */
async function runDownloadData(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const state = await storedSession(request);
  const site = await siteOf(ctx, actor);
  const csv = await downloadData(ctx.domain, actor, rc, { link: attachmentLink(site), locale: state.locale ?? 'en_US' });
  return { status: 200, contentType: DOWNLOAD_CONTENT_TYPE, body: csv.body, headers: { 'content-disposition': `attachment;filename=${csv.fileName}`, expires: '0' } };
}

/** loaddiff.cfm: the older of two versions diffed against the newer. */
async function runLoadDiff(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const siteId = rcText(rc, 'siteid');
  const now = ctx.clock.now();
  const v1 = diffVersionOf(await legacyVersion(ctx, actor, rcRequired(rc, 'contenthistid1'), siteId), now);
  const v2 = diffVersionOf(await legacyVersion(ctx, actor, rcRequired(rc, 'contenthistid2'), siteId), now);
  const base = await renderBaseOf(request, ctx, actor, await siteOf(ctx, actor));
  return rendered(renderLoadDiff(v1, v2, base));
}

/** draftpromptdata.cfm: the draft, lock and approval prompt of a node (or of `homeid` when no node is named). */
async function runDraftPromptData(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const siteId = rcText(rc, 'siteid');
  const now = ctx.clock.now();
  rcParam(rc, 'targetversion', 'false');
  if (!cfIsBoolean(rcGet(rc, 'targetversion'))) rcSet(rc, 'targetversion', false);
  const contentId = rcRequired(rc, 'contentid');
  const promptOf = contentId === '' && rcText(rc, 'homeid') !== '' ? rcText(rc, 'homeid') : contentId;
  const data = await getDraftPromptData(ctx.domain, actor, promptOf, siteId);
  const targetVersion = rcFlag(rc, 'targetversion');
  const published = await legacyVersion(ctx, actor, targetVersion ? rcRequired(rc, 'contenthistid') : data.publishedHistoryId, siteId);
  const draft = data.hasDraft ? await legacyVersion(ctx, actor, data.historyId, siteId) : undefined;
  const active = await getActiveContent(ctx.domain, actor, { contentId, siteId });
  // The locked-by notice prints only on sites with lockable nodes, for a node lock.
  const lockedBy = SITE_FLAGS.hasLockableNodes && cfEq(data.lockType, 'node') ? await userNamed(request, actor, 'draftpromptdata', data.lockId) : undefined;
  const model: DraftPromptModel = {
    data,
    targetVersion: rcText(rc, 'targetversion'),
    publishedVersion: promptVersionOf(published, now),
    ...(draft === undefined ? {} : { draftVersion: promptVersionOf(draft, now) }),
    ...(lockedBy === undefined ? {} : { lockedBy }),
    content: { filename: active.isNew === 0 ? active.version.filename : null },
  };
  return rendered(await renderRaw(request, ctx, actor, (rctx) => renderDraftPromptData(model, rctx)));
}

/** carch.loadNotify and loadexpirenotify.cfm list `contentUtility.getNotify` recipients: identity's members, people's names and email. */
function notifyHalted(action: string): () => Promise<never> {
  return async () => {
    throw new CarchHaltedError(action, "the recipients' names and email are people data and their group memberships identity's, which strategies-content cannot read");
  };
}

/** A Site Manager fragment's answer; a body legacy wraps in the admin layout is halted, as a raw fragment cannot carry it. */
function siteManagerFragment(action: string, result: SiteManagerFragmentResult): CarchRawResult {
  if (result.layout === true) throw new CarchHaltedError(action, 'legacy renders this branch inside the admin layout, which a raw fragment does not carry');
  return rendered({ status: result.status, contentType: result.contentType, body: result.body, ...(result.sessionEffects === undefined ? {} : { sessionEffects: result.sessionEffects }) });
}

/** The session user's struct as identity keeps it (`session.mura`): names, email and the login-time memberships. */
interface SessionUser {
  userID: string;
  fname?: string;
  lname?: string;
  email?: string;
  memberships?: string;
  membershipids?: string;
}

const sessionUsers = new WeakMap<FastifyRequest, Promise<SessionUser>>();

/** `session.mura` of the request's token, read once per request. */
function sessionUser(request: FastifyRequest): Promise<SessionUser> {
  let found = sessionUsers.get(request);
  if (found === undefined) {
    found = (async () => {
      const res = await request.server.opt2.client.request<{ user: SessionUser }>({ service: IDENTITY_SERVICE, method: 'GET', path: CURRENT_SESSION_PATH });
      if (res.status < 200 || res.status > 299) throw identityUnavailable(res.status);
      return res.body.user;
    })();
    sessionUsers.set(request, found);
  }
  return found;
}

/**
 * `user.loadBy(userid)` names a view prints: '' reads as the new bean, the session user's own as its session struct;
 * any other user's are people data this service cannot read, so the case is halted.
 */
async function userNamed(request: FastifyRequest, actor: Actor, action: string, userId: string): Promise<{ fname: string; lname: string; email: string } | undefined> {
  if (userId === '') return undefined;
  if (!cfEq(userId, actor.userId)) throw new CarchHaltedError(action, "another user's name and email are people data, which strategies-content cannot read");
  const user = await sessionUser(request);
  return { fname: user.fname ?? '', lname: user.lname ?? '', email: user.email ?? '' };
}

const membershipsCache = new WeakMap<FastifyRequest, Promise<UserMemberships>>();

/** The actor's group memberships from the identity projections, read once per request. */
function membershipsOf(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<UserMemberships> {
  let found = membershipsCache.get(request);
  if (found === undefined) {
    found = loadMemberships(ctx.domain, actor);
    membershipsCache.set(request, found);
  }
  return found;
}

/** `$.currentUser().isSuperUser() or isAdminUser()`: S2, or the `Admin` group of the site's private user pool. */
async function isPowerUser(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<boolean> {
  if (actor.s2) return true;
  const entry = await registryEntryForTenant(ctx.domain.db, actor.tenantId);
  return listFindNoCaseOf(await sessionMemberships(request, ctx, actor), `Admin;${entry?.privateUserPoolId ?? actor.siteId};0`);
}

/** `session.mura.memberships`: the login-time list identity keeps, else the list loginByQuery builds from the projections. */
async function sessionMemberships(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<string> {
  const user = await sessionUser(request);
  if (user.memberships !== undefined) return user.memberships;
  return [...(actor.s2 ? ['S2IsPrivate', 'S2'] : []), ...(await membershipsOf(request, ctx, actor)).names].join(',');
}

/** The site's subtypes as `getSubTypes(siteid, activeOnly)` orders them: by type, then subtype. */
async function subtypesOf(ctx: ContentRouteContext, actor: Actor, siteId: string, activeOnly: boolean): Promise<ExtendSubtypeRow[]> {
  const rows = await inTenant(ctx, actor, (tx) => ctx.domain.repository.extend.subtypes(tx, { siteId }));
  const ordered = [...rows].sort((a, b) => noCaseCompare(a.type ?? '', b.type ?? '') || noCaseCompare(a.subtype ?? '', b.subtype ?? ''));
  return activeOnly ? ordered.filter((row) => cfToNumber(row.isactive ?? 0) === 1) : ordered;
}

/** SQL Server's case-insensitive collation order of two texts. */
function noCaseCompare(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** extendManager's custom icon lookup over the site's subtypes. */
async function customIconsOf(ctx: ContentRouteContext, actor: Actor, siteId: string): Promise<CustomIconLookup> {
  return buildCustomIconLookup(await inTenant(ctx, actor, (tx) => ctx.domain.repository.extend.subtypes(tx, { siteId })));
}

/** `getExtendedAttributeList(siteid)` (extendManager.cfc:1092-1143): the non-admin attributes of `tcontent` subtypes by type, subtype and name. */
async function extendedAttributeList(ctx: ContentRouteContext, actor: Actor, siteId: string): Promise<ExtendAttributeListRow[]> {
  const rows = await inTenant(ctx, actor, async (tx) => {
    const found: ExtendAttributeListRow[] = [];
    for (const subtype of await ctx.domain.repository.extend.subtypes(tx, { siteId })) {
      if (!cfEq(subtype.basetable ?? '', 'tcontent') || cfToNumber(subtype.adminonly ?? 0) === 1) continue;
      const sets = await ctx.domain.repository.extend.setsForSubtype(tx, { subTypeId: subtype.subtypeid });
      const attributes = await ctx.domain.repository.extend.attributesForSets(tx, { extendSetIds: sets.map((set) => set.extendsetid) });
      for (const attribute of attributes) {
        if (cfToNumber(attribute.adminonly ?? 0) === 1) continue;
        found.push({ type: subtype.type ?? '', subtype: subtype.subtype ?? '', attribute: attribute.name ?? '' });
      }
    }
    return found;
  });
  return rows.sort((a, b) => noCaseCompare(a.type, b.type) || noCaseCompare(a.subtype, b.subtype) || noCaseCompare(a.attribute, b.attribute));
}

/** What every dsp_nest.cfm level reads besides its rows. */
interface NestScope {
  ctx: ContentRouteContext;
  actor: Actor;
  siteId: string;
  memberships: UserMemberships;
  /** `session.openSectionList` as the view sees it. */
  openSections: string;
  nextN: number;
}

/**
 * dsp_nest.cfm's rows under `parentId` through the last row its `startRow`/`nextN` window shows, each with its verdict,
 * child count and, for an open section with children, the rows of the level below.
 */
async function nestNodes(scope: NestScope, parentId: string, sort: { sortBy: string; sortDirection: string }, startRow: number, ancestors: ReadonlySet<string> = new Set()): Promise<NestNode[]> {
  const { ctx, actor, siteId } = scope;
  const page = await getNest(ctx.domain, actor, { parentId, siteId, sortBy: sort.sortBy, sortDirection: sort.sortDirection, startRow: 1, maxRows: startRow - 1 + scope.nextN });
  const level = new Set([...ancestors, parentId.toLowerCase()]);
  const nodes: NestNode[] = [];
  for (const row of page.rows) {
    const contentId = row.contentid ?? '';
    const kidsCount = await getKidsCount(ctx.domain, actor, { parentId: contentId, siteId: row.siteid ?? siteId, liveOnly: false });
    const verdict = await getPerm(ctx.domain, actor, contentId, siteId, scope.memberships);
    const open = kidsCount > 0 && cfListToArray(scope.openSections).includes(contentId) && !level.has(contentId.toLowerCase());
    const kids = open ? await nestNodes(scope, contentId, { sortBy: row.sortby ?? '', sortDirection: row.sortdirection ?? '' }, 1, level) : undefined;
    nodes.push({ ...row, verdict, kidsCount, ...(kids === undefined ? {} : { kids }) });
  }
  return nodes;
}

/** list() and loadsitemanager()'s empty-tree reset `session[session.moduleid] = {topid}` (carch.cfc:216-221), which carch.update reads back. */
async function saveTreeReset(request: FastifyRequest, moduleId: string, topId: string): Promise<void> {
  const state = await storedSession(request);
  await saveSession(request, { moduleTopIds: { ...(state.moduleTopIds ?? {}), [moduleId]: topId } });
}

/** carch.loadsitemanager (carch.cfc:230-244, loadsitemanager.cfm): the tree under `topid` as `{html, perm, sortby}`. */
async function runLoadSiteManager(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const { rc, moduleTop } = await carchContext(paramsOf(request), actor, () => storedSession(request));
  const siteId = rcText(rc, 'siteid');
  const { topId, rows, reset } = await listTop(ctx, actor, rc);
  if (reset) await saveTreeReset(request, moduleTop?.moduleId ?? (await storedSession(request)).moduleid ?? SITE_MANAGER_MODULE, topId);
  rcSet(rc, 'topid', topId);
  const rsTop = rows[0];
  if (rsTop === undefined) throw new UndefinedLegacyElementError(`The tree of ${topId} has no root`);
  const site = await siteOf(ctx, actor);
  const base = await renderBaseOf(request, ctx, actor, site);
  const memberships = await membershipsOf(request, ctx, actor);
  const crumbs = await getCrumbList(ctx.domain, actor, { contentId: topId, siteId });
  const sortBy = rcText(rc, 'sortby') || (rsTop.sortby ?? '') || 'orderno';
  const sortDirection = rcText(rc, 'sortdirection') || (rsTop.sortdirection ?? '');
  const scope: NestScope = { ctx, actor, siteId, memberships, openSections: base.session.openSectionList, nextN: base.session.nextN };
  const model: SiteManagerModel = {
    siteId,
    topId,
    moduleId: rcText(rc, 'moduleid'),
    type: rcText(rc, 'type'),
    ptype: rcText(rc, 'ptype'),
    sortBy: rcText(rc, 'sortby'),
    sortDirection: rcText(rc, 'sortdirection'),
    startRow: rcText(rc, 'startrow'),
    rsTop,
    crumbs,
    perm: await getNodePerm(ctx.domain, actor, crumbs, memberships),
    restricted: (await setRestriction(ctx.domain, actor, crumbs)).restrict,
    hasKids: await getKidsCount(ctx.domain, actor, { parentId: rsTop.contentid ?? '', siteId: rsTop.siteid ?? siteId, liveOnly: false }),
    tabAssignments: TAB_ASSIGNMENTS,
    extendAttributes: await extendedAttributeList(ctx, actor, siteId),
    hasMarketingManager: false,
    nest: await nestNodes(scope, topId, { sortBy, sortDirection }, rcRow(rc, 'startrow')),
    customIcons: await customIconsOf(ctx, actor, siteId),
  };
  return rendered(await renderWithTokens(request, base, (rctx) => renderSiteManagerJson(model, rctx)));
}

/** loadsitesection.cfm and refreshsitesection.cfm: a section's rows, opened (or closed) in `session.openSectionList`. */
function runSiteSection(refresh: boolean): (request: FastifyRequest, ctx: ContentRouteContext, actor: Actor) => Promise<CarchRawResult> {
  return async (request, ctx, actor) => {
    const rc = await rawRc(request, actor);
    rcParam(rc, 'sorted', false);
    const siteId = rcText(rc, 'siteid');
    const sectionId = rcRequired(rc, 'contentid');
    const site = await siteOf(ctx, actor);
    const base = await renderBaseOf(request, ctx, actor, site);
    const closing = !refresh && cfListToArray(base.session.openSectionList).includes(sectionId);
    const sortBy = rcText(rc, 'sortby');
    const sortDirection = rcText(rc, 'sortdirection');
    // Neither view defines `rc.rstop`, so a section without both sort values fails; closing reads neither.
    const sorted = sortBy !== '' && sortDirection !== '';
    const crumbs = closing ? [] : await getCrumbList(ctx.domain, actor, { contentId: sectionId, siteId });
    const memberships = await membershipsOf(request, ctx, actor);
    const openSections = refresh ? base.session.openSectionList : cfListAppend(base.session.openSectionList, sectionId);
    const scope: NestScope = { ctx, actor, siteId, memberships, openSections, nextN: base.session.nextN };
    const model: SiteSectionModel = {
      siteId,
      sectionId,
      moduleId: rcText(rc, 'moduleid'),
      sortBy,
      sortDirection,
      startRow: rcText(rc, 'startrow'),
      perm: closing ? 'none' : await getNodePerm(ctx.domain, actor, crumbs, memberships),
      restricted: closing ? false : (await setRestriction(ctx.domain, actor, crumbs)).restrict,
      tabAssignments: TAB_ASSIGNMENTS,
      nest: closing || !sorted ? [] : await nestNodes(scope, sectionId, { sortBy, sortDirection }, rcRow(rc, 'startrow')),
      customIcons: await customIconsOf(ctx, actor, siteId),
    };
    const render = refresh ? renderRefreshSiteSection : renderLoadSiteSection;
    return rendered(await renderWithTokens(request, base, (rctx) => render(model, rctx)));
  };
}

/** siteparents.cfm: the parent picker's search over the parent's module tree. */
async function runSiteParents(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const siteId = rcText(rc, 'siteid');
  const keywords = String(rcParam(rc, 'keywords', ''));
  const isNew = cfToBoolean(rcParam(rc, 'isNew', 1));
  const parentId = rcRequired(rc, 'parentid');
  const contentId = rcRequired(rc, 'contentid');
  const model: SiteParentsModel = { siteId, contentId, parentId, keywords: rcText(rc, 'keywords'), isNew, rows: [], customIcons: await customIconsOf(ctx, actor, siteId) };
  if (!isNew) {
    const parent = await readContent(ctx.domain, actor, { siteId, contentId: parentId });
    const parentModule = parent.isNew === 0 ? (parent.version.moduleid ?? '') : '';
    const memberships = await membershipsOf(request, ctx, actor);
    const search = await privateSearch(ctx.domain, actor, { siteId, keywords, moduleId: parentModule, startRow: 1 });
    const rows: SiteParentsRow[] = [];
    for (const row of search.rows) {
      const crumbs = await getCrumbList(ctx.domain, actor, { contentId: row.contentid ?? '', siteId });
      rows.push({ contentid: row.contentid ?? '', crumbs, verdict: await getNodePerm(ctx.domain, actor, crumbs, memberships) });
    }
    model.rows = rows;
    if (parent.isNew === 0) model.parent = { moduleId: parentModule, crumbs: await getCrumbList(ctx.domain, actor, { contentId: parentId, siteId }) };
    if ([COMPONENTS_MODULE, FORMS_MODULE, VARIATIONS_MODULE].includes(parentModule)) {
      const [top] = await inTenant(ctx, actor, (tx) => ctx.domain.repository.content.top(tx, { topId: parentModule, siteId }));
      model.moduleTopTitle = top?.title ?? '';
    }
  }
  return siteManagerFragment('siteparents', await renderRaw(request, ctx, actor, (rctx) => renderSiteParents(model, rctx)));
}

/** loadnewcontentmenu.cfm: the add-content menu of a node; the front-end toolbar's menu, which keeps the layout, is halted. */
async function runLoadNewContentMenu(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const siteId = rcText(rc, 'siteid');
  const contentId = rcRequired(rc, 'contentid');
  const parent = await readContent(ctx.domain, actor, { siteId, contentId });
  const parentType = parent.isNew === 0 ? (parent.version.type ?? '') : '';
  const parentSubtype = parent.isNew === 0 ? (parent.version.subtype ?? '') : '';
  const parentSiteId = parent.isNew === 0 ? (parent.version.siteid ?? siteId) : siteId;
  const all = await subtypesOf(ctx, actor, parentSiteId, false);
  const own = all.find((row) => cfEq(row.type ?? '', parentType) && cfEq(row.subtype ?? '', parentSubtype));
  const model: NewContentMenuModel = {
    siteId,
    contentId,
    contentHistId: rcText(rc, 'contenthistid'),
    topId: rcText(rc, 'topid'),
    moduleId: rcText(rc, 'moduleid'),
    ptype: rcText(rc, 'ptype'),
    compactDisplay: rcText(rc, 'compactDisplay') || 'false',
    frontEndProxyLoc: rcHas(rc, 'frontEndProxyLoc'),
    powerUser: await isPowerUser(request, ctx, actor),
    primaryContentTypes: '',
    availableSubTypes: (own?.availablesubtypes ?? '').trim(),
    subtypes: await subtypesOf(ctx, actor, siteId, true),
    allowSimpleHtmlForms: false,
    allowMultiUpload: true,
    customIcons: await customIconsOf(ctx, actor, siteId),
  };
  return siteManagerFragment('loadnewcontentmenu', await renderRaw(request, ctx, actor, (rctx) => renderLoadNewContentMenu(model, rctx)));
}

/** The flat view's `$.event()` values: the rc's simple values, a CFML boolean as the text it prints. */
function siteFlatEventOf(rc: Rc): SiteFlatEvent {
  const event: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(rc)) {
    if (typeof value === 'string' || typeof value === 'number') event[name] = value;
    else if (typeof value === 'boolean') event[name] = String(value);
  }
  return event;
}

/** `$.event(name)`: the event value ignoring case, '' when absent. */
function eventText(event: SiteFlatEvent, name: string): string {
  const key = Object.keys(event).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : event[key];
  return value === undefined ? '' : typeof value === 'number' ? cfNumberString(value) : value;
}

/** A date feed criteria as the feed engine reads a CFML date argument. */
function criteriaText(date: Date): string {
  return cfDateTimeFormat(date, 'yyyy-mm-dd HH:nn:ss');
}

/** `feed.addParam(…)` with feedBean's argument defaults (feedBean.cfc:531). */
function addFeedParam(feed: FeedBean, param: { field?: string; relationship?: string; criteria?: string; condition?: string; datatype?: string }): void {
  feed.addParam({ field: param.field ?? '', relationship: param.relationship ?? 'and', criteria: param.criteria ?? '', condition: param.condition ?? 'EQUALS', datatype: param.datatype ?? '' });
}

/** CFML `valueList(query.contentid)`. */
function contentIdList(rows: ReadonlyArray<{ contentid: string | null }>): string {
  return rows.map((row) => row.contentid ?? '').join(',');
}

/** The rows a pending-report or draft query holds for one item (query-of-queries `where contentid = …`, case-sensitive). */
function rowsOfItem<R extends { contentid: string | null }>(rows: readonly R[], contentId: string | null): R[] {
  return rows.filter((row) => row.contentid === contentId);
}

/** Query-of-queries `max(column)` over dates: the latest, null for no dates. */
function maxDate(values: ReadonlyArray<Date | null>): Date | null {
  return values.reduce<Date | null>((max, value) => (value !== null && (max === null || value > max) ? value : max), null);
}

/** Query-of-queries `order by` over dates in `direction`; NULLs lowest, ties keep their order. */
function byDates<R>(rows: readonly R[], direction: string, ...keys: Array<(row: R) => Date | null>): R[] {
  const sign = direction.toLowerCase() === 'asc' ? 1 : -1;
  const time = (value: Date | null): number => value?.getTime() ?? Number.NEGATIVE_INFINITY;
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const diff = time(key(a)) - time(key(b));
      if (diff !== 0) return sign * diff;
    }
    return 0;
  });
}

/** A flat-view feed row with the report columns loadsiteflat.cfm:249-303 adds. */
type FlatFeedRow = FeedContentRow & { approvalstatus?: string | null; duedate?: Date | null };

/** loadsiteflat.cfm:62-213: the flat view's feed over the request's filters and report. */
async function siteFlatFeed(ctx: ContentRouteContext, actor: Actor, event: SiteFlatEvent, adminOnly: readonly ExtendSubtypeRow[], customTagGroups: string): Promise<{ feed: FeedBean; rows: FlatFeedRow[]; drafts: ApprovalListRow[] | DraftListRow[] }> {
  const ev = (name: string): string => eventText(event, name);
  const siteId = ev('siteid');
  const now = ctx.clock.now();
  const feed = FeedBean.init(ctx.clock);
  for (const [name, value] of [['siteid', siteId], ['type', '*'], ['showExcludeSearch', 1], ['maxItems', 500], ['nextN', 10], ['liveOnly', 0], ['showNavOnly', 0], ['includeHomePage', 1]] as const) {
    feed.setValue(name, value);
  }
  let tagStarted = false;
  if (ev('tags') !== '') {
    tagStarted = true;
    addFeedParam(feed, { relationship: 'and (' });
    addFeedParam(feed, { field: 'tcontenttags.tag', criteria: ev('tags'), condition: 'in' });
  }
  if (customTagGroups !== '') {
    for (const group of customTagGroups.split(/[\^,]/).filter((name) => name !== '')) {
      const tags = ev(`${group}tags`);
      if (tags === '') continue;
      if (!tagStarted) {
        tagStarted = true;
        addFeedParam(feed, { relationship: 'and (' });
        addFeedParam(feed, { relationship: '(', field: 'tcontenttags.tag', criteria: tags, condition: 'in' });
      } else {
        addFeedParam(feed, { relationship: 'or (', field: 'tcontenttags.tag', criteria: tags, condition: 'in' });
      }
      addFeedParam(feed, { relationship: 'and', field: 'tcontenttags.taggroup', criteria: group });
      addFeedParam(feed, { relationship: ')' });
    }
  }
  if (tagStarted) addFeedParam(feed, { relationship: ')' });
  if (ev('type') !== '') {
    addFeedParam(feed, { field: 'tcontent.type', criteria: ev('type'), condition: 'in' });
  }
  if (ev('subtype') !== '') {
    addFeedParam(feed, { field: 'tcontent.subtype', criteria: ev('subtype') });
  }
  if (ev('categoryID') !== '') {
    feed.setValue('categoryID', ev('categoryID'));
  }
  const report = ev('report');
  if (!(listFindNoCaseOf('myapprovals,mysubmissions', report) && cfEq(ev('sortby'), 'duedate'))) {
    feed.setValue('sortBy', ev('sortBy'));
  } else {
    // Legacy sets the sort column twice, the second time to the direction.
    feed.setValue('sortBy', 'lastupdate');
    feed.setValue('sortBy', 'desc');
  }
  if (ev('sortDirection') !== '') feed.setValue('sortDirection', ev('sortDirection'));
  let drafts: ApprovalListRow[] | DraftListRow[] = [];
  if (cfEq(report, 'lockedfiles')) {
    addFeedParam(feed, { field: 'tcontentstats.lockid', condition: '>', criteria: '' });
  } else if (cfEq(report, 'mylockedcontent')) {
    addFeedParam(feed, { field: 'tcontentstats.lockid', condition: '=', criteria: actor.userId });
  } else if (cfEq(report, 'expires')) {
    addFeedParam(feed, { field: 'tcontent.expires', datatype: 'date', condition: '<=', criteria: criteriaText(cfDateAdd('m', 1, now)) });
    addFeedParam(feed, { field: 'tcontent.expires', datatype: 'date', condition: '>', criteria: criteriaText(cfDateAdd('m', -12, now)) });
  } else if (cfEq(report, 'myexpires')) {
    const expiring = await inTenant(ctx, actor, (tx) => ctx.domain.repository.content.expiringContent(tx, { siteId, userId: actor.userId, today: now }));
    addFeedParam(feed, { field: 'tcontent.contentID', datatype: 'varchar', condition: 'in', criteria: contentIdList(expiring) });
  } else if (cfEq(report, 'mydrafts')) {
    drafts = await getDraftList(ctx.domain, actor, { siteId, startDate: cfDateAdd('m', -3, now) });
    addFeedParam(feed, { field: 'tcontent.contentid', datatype: 'varchar', condition: 'in', criteria: contentIdList(drafts) });
  } else if (cfEq(report, 'myapprovals') || cfEq(report, 'mysubmissions')) {
    drafts = cfEq(report, 'myapprovals') ? await getApprovalsQuery(ctx.domain, actor, { siteId }) : await getSubmissionsQuery(ctx.domain, actor, { siteId });
    addFeedParam(feed, { field: 'tcontent.contentid', datatype: 'varchar', condition: 'in', criteria: contentIdList(drafts) });
  }
  if (ev('keywords') !== '') {
    if (ev('moduleid') === SITE_MANAGER_MODULE) {
      const found = await privateSearch(ctx.domain, actor, { siteId, keywords: ev('keywords'), startRow: 1 });
      addFeedParam(feed, { field: 'tcontent.contentID', datatype: 'varchar', condition: 'in', criteria: contentIdList(found.rows) });
    } else {
      addFeedParam(feed, { relationship: 'andOpenGrouping' });
      addFeedParam(feed, { field: 'tcontent.title', datatype: 'varchar', condition: 'contains', criteria: ev('keywords') });
      addFeedParam(feed, { relationship: 'or', datatype: 'varchar', field: 'tcontent.summary', condition: 'contains', criteria: ev('keywords') });
      addFeedParam(feed, { relationship: 'or', datatype: 'varchar', field: 'tcontent.body', condition: 'contains', criteria: ev('keywords') });
      addFeedParam(feed, { relationship: 'closeGrouping' });
    }
  }
  // With no filter, legacy adds the configBean `defaultflatviewrange` and `defaultflatviewtable` filters, whose defaults (0 and '') add none.
  for (const row of adminOnly) {
    addFeedParam(feed, { relationship: 'and not (' });
    addFeedParam(feed, { field: 'tcontent.type', datatype: 'varchar', criteria: row.type ?? '' });
    addFeedParam(feed, { field: 'tcontent.subtype', datatype: 'varchar', criteria: row.subtype ?? '' });
    addFeedParam(feed, { relationship: ')' });
  }
  return { feed, rows: await feedContent(ctx.domain, actor, feed), drafts };
}

/** CFML `listFindNoCase(list, value) > 0`. */
function listFindNoCaseOf(list: string, value: string): boolean {
  return cfListToArray(list).some((item) => cfEq(item, value));
}

/** loadsiteflat.cfm:249-303: a pending report's rows with their latest draft dates, or the draft report's with its latest draft. */
function withReportColumns(rows: FlatFeedRow[], report: string, sortBy: string, direction: string, drafts: ReadonlyArray<ApprovalListRow | DraftListRow>): FlatFeedRow[] {
  if (rows.length === 0) return rows;
  if (listFindNoCaseOf('mysubmissions,myapprovals', report)) {
    const pending = drafts as readonly ApprovalListRow[];
    const updated = rows.map((row): FlatFeedRow => {
      const own = rowsOfItem(pending, row.contentid);
      const publish = maxDate(own.map((draft) => draft.publishdate));
      const display = maxDate(own.map((draft) => draft.displaystart));
      return { ...row, lastupdate: maxDate(own.map((draft) => draft.lastupdate)), approvalstatus: 'Pending', duedate: publish ?? display };
    });
    if (cfEq(sortBy, 'lastupdate')) return byDates(updated, direction, (row) => row.lastupdate);
    if (cfEq(sortBy, 'duedate')) return byDates(updated, direction, (row) => row.duedate ?? null, (row) => row.lastupdate);
    return updated;
  }
  if (cfEq(report, 'mydrafts')) {
    const updated = rows.map((row): FlatFeedRow => ({ ...row, lastupdate: maxDate(rowsOfItem(drafts, row.contentid).map((draft) => draft.lastupdate)) }));
    return cfEq(sortBy, 'lastupdate') ? byDates(updated, direction, (row) => row.lastupdate) : updated;
  }
  return rows;
}

/** `item.getCategoriesIterator()` names: the version's categories, joined in its category pool, by filename. */
async function categoryNamesOf(ctx: ContentRouteContext, actor: Actor, contentHistId: string): Promise<string[]> {
  const assigned = await inTenant(ctx, actor, (tx) => ctx.domain.repository.content.categoryAssignments(tx, { contentHistId }));
  if (assigned.length === 0) return [];
  const pool = (await poolTenantFor(ctx.domain.db, actor.tenantId, 'category')) ?? actor.tenantId;
  const categories = await ctx.domain.db.withTenant(pool, async (tx) => {
    const found = [];
    for (const assignment of assigned) {
      const [category] = await ctx.domain.repository.categories.readCategory(tx, { categoryId: assignment.categoryid });
      if (category !== undefined) found.push(category);
    }
    return found;
  });
  return categories.sort((a, b) => noCaseCompare(a.filename ?? '', b.filename ?? '')).map((category) => category.name ?? '');
}

/** dsp_categories_nest.cfm's tree: each pool level by name, with the levels under rows that have children. */
async function categoryTreeOf(ctx: ContentRouteContext, actor: Actor, parentId = '', ancestors: ReadonlySet<string> = new Set()): Promise<SiteFlatCategory[]> {
  const nodes: SiteFlatCategory[] = [];
  for (const row of await listCategories(ctx.domain, actor, { parentId })) {
    const id = row.categoryid.toLowerCase();
    const kids = row.haskids > 0 && !ancestors.has(id) ? await categoryTreeOf(ctx, actor, row.categoryid, new Set([...ancestors, id])) : [];
    nodes.push({ categoryid: row.categoryid, name: row.name, isopen: row.isopen, kids });
  }
  return nodes;
}

/** loadsiteflat.cfm: the Site Manager flat list of the request's filters and report, with its `flatViewArgs` write. */
async function runLoadSiteFlat(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const event = normalizeSiteFlatEvent(siteFlatEventOf(rc));
  const siteId = eventText(event, 'siteid');
  const site = await siteOf(ctx, actor);
  const base = await renderBaseOf(request, ctx, actor, site);
  const powerUser = await isPowerUser(request, ctx, actor);
  const subtypes = await subtypesOf(ctx, actor, base.session.siteId, true);
  const adminOnly = powerUser ? [] : subtypes.filter((row) => cfToNumber(row.adminonly ?? 0) === 1);
  const shownTypes = powerUser ? subtypes : subtypes.filter((row) => cfToNumber(row.adminonly ?? 0) !== 1);
  const customTagGroups = site.customTagGroups ?? '';
  const { feed, rows, drafts } = await siteFlatFeed(ctx, actor, event, adminOnly, customTagGroups);
  const report = eventText(event, 'report');
  const ordered = withReportColumns(rows, report, eventText(event, 'sortby'), feed.text('sortdirection'), drafts);
  const page = siteFlatPage(ordered.length, cfToNumber(eventText(event, 'page')));
  const memberships = await membershipsOf(request, ctx, actor);
  const pageRows: SiteFlatRow[] = [];
  for (const row of ordered.slice(page.offset, page.offset + page.count)) {
    const contentId = row.contentid ?? '';
    const rowSite = row.siteid ?? siteId;
    const crumbs = await getCrumbList(ctx.domain, actor, { contentId, siteId: rowSite });
    const version = await getContentVersion(ctx.domain, actor, { contentHistId: row.contenthistid ?? '', siteId: rowSite });
    const stored = version.isNew === 0 ? version.version : null;
    const lockedBy = await userNamed(request, actor, 'loadsiteflat', row.lockid ?? '');
    pageRows.push({
      ...row,
      moduleid: stored?.moduleid ?? null,
      sortby: stored?.sortby ?? null,
      sortdirection: stored?.sortdirection ?? null,
      lastupdateby: stored?.lastupdateby ?? null,
      crumbs,
      verdict: await getNodePerm(ctx.domain, actor, crumbs, memberships),
      categories: await categoryNamesOf(ctx, actor, row.contenthistid ?? ''),
      ...(lockedBy === undefined ? {} : { lockedBy: { fname: lockedBy.fname, lname: lockedBy.lname } }),
    });
  }
  const sessionSite = base.session.siteId;
  const model: LoadSiteFlatModel = {
    event,
    powerUser,
    customTagGroups,
    subtypes: shownTypes,
    totalRecords: ordered.length,
    rows: pageRows,
    reportCounts: {
      mydrafts: await getMyDraftsCount(ctx.domain, actor, { siteId: sessionSite, startDate: cfDateAdd('m', -3, ctx.clock.now()) }),
      mysubmissions: await getMySubmissionsCount(ctx.domain, actor, { siteId: sessionSite }),
      myapprovals: await getMyApprovalsCount(ctx.domain, actor, { siteId: sessionSite }),
      myexpires: await getMyExpiresCount(ctx.domain, actor, { siteId: sessionSite }),
      mylockedcontent: await getMyLockedContentCount(ctx.domain, actor, { siteId: sessionSite }),
    },
    categoryCount: await countCategories(ctx.domain, actor),
    categories: await categoryTreeOf(ctx, actor),
    customIcons: await customIconsOf(ctx, actor, siteId),
  };
  return siteManagerFragment('loadsiteflat', await renderWithTokens(request, base, (rctx) => renderLoadSiteFlat(model, rctx)));
}

/** availablechangesets.cfm: the edit form's change-set picker of the site's open, unpublished change sets. */
async function runAvailableChangesets(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const changesetId = rcRequired(rc, 'changesetID');
  const current = await readChangeset(ctx.domain, actor, changesetId);
  const changesets = await inTenant(ctx, actor, (tx) =>
    ctx.domain.repository.changesets.changesetQuery(tx, { siteId: rcRequired(rc, 'siteID'), published: 0, publishDate: ctx.clock.now(), publishDateOnly: false, openOnly: true }),
  );
  const model: AvailableChangesetsModel = {
    changesetId,
    currentChangesetName: current.name,
    changesets: changesets.map((row) => ({ changesetid: row.changesetid, name: row.name })),
    hasChangesetModulePerm: getModulePerm(actor, CHANGESETS_MODULE),
  };
  return panelResult(await renderRaw(request, ctx, actor, (rctx) => renderAvailableChangesets(model, rctx)));
}

/** assocfiles.cfm: the associated-file search; matches carry the node verdict of their crumbs, which the picker filters on. */
async function runAssocFiles(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  rcParam(rc, 'keywords', '');
  rcParam(rc, 'isNew', '1');
  const siteId = rcText(rc, 'siteid');
  const keywords = rcText(rc, 'keywords');
  const type = rcRequired(rc, 'type');
  const property = rcRequired(rc, 'property');
  const rows: AssocFileRow[] = [];
  // The matches print only for keywords, so the verdicts are read only then.
  if (keywords !== '') {
    const found = await privateSearch(ctx.domain, actor, { siteId, keywords, searchType: type, startRow: 1 });
    const memberships = await membershipsOf(request, ctx, actor);
    const verdicts = new Map<string, NodePerm>();
    for (const row of found.rows) {
      const contentId = row.contentid ?? '';
      let perm = verdicts.get(contentId.toLowerCase());
      if (perm === undefined) {
        perm = await getNodePerm(ctx.domain, actor, await getCrumbList(ctx.domain, actor, { contentId, siteId }), memberships);
        verdicts.set(contentId.toLowerCase(), perm);
      }
      rows.push({ fileid: row.fileid, contentid: contentId, fileext: row.fileext, assocfilename: row.assocfilename, perm });
    }
  }
  return panelResult(await renderRaw(request, ctx, actor, (rctx) => renderAssocFiles({ keywords, type, property, rows }, rctx)));
}

/** loadfilemetadata.cfm: a version's metadata of a file, or the file's own values when the version has none. */
async function runLoadFileMetadata(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const fileId = rcRequired(rc, 'fileid');
  const contentHistId = rcRequired(rc, 'contenthistid');
  const siteId = rcText(rc, 'siteid');
  const stored = await inTenant(ctx, actor, (tx) => ctx.domain.repository.files.listFileMetadata(tx, { siteId, fileId, contentHistId }));
  // The bean's load SQL inner-joins tfiles, which `filePoolID` places, so a row without its file loads as new.
  const file = fileId === '' ? null : await withPoolTenant(ctx.domain.db, actor.tenantId, 'file', (tx) => ctx.domain.repository.files.readFileAll(tx, fileId));
  const [row] = file === null ? [] : stored;
  const source = row ?? file;
  const model: FileMetadataModel = {
    meta: {
      fileid: row?.fileid ?? (file === null ? fileId : file.fileid),
      caption: source?.caption ?? null,
      credits: source?.credits ?? null,
      alttext: source?.alttext ?? null,
      remoteid: source?.remoteid ?? null,
      remoteurl: source?.remoteurl ?? null,
      remotesource: source?.remotesource ?? null,
      remotesourceurl: source?.remotesourceurl ?? null,
      exif: source?.exif ?? null,
    },
    fileExt: file?.fileext ?? null,
  };
  return panelResult(await renderRaw(request, ctx, actor, (rctx) => renderLoadFileMetadata(model, rctx)));
}

/** The feature-schedule values both category panels print: `rc.categoryAssignment` (0 when not numeric) and the dates and times. */
function categoryFeatureOf(rc: Rc, dayParts: boolean): CategoryFeatureModel {
  if (!cfIsNumeric(rcRequired(rc, 'categoryAssignment'))) rcSet(rc, 'categoryAssignment', 0);
  const scheduled = cfEq(rcText(rc, 'categoryAssignment'), '2');
  // Each panel dereferences the schedule fields it prints; a missing one raises ACF's error there.
  const field = (name: string, read: boolean): string => (read ? rcRequired(rc, name) : rcText(rc, name));
  return {
    categoryAssignment: rcText(rc, 'categoryAssignment'),
    catTrim: rcRequired(rc, 'cattrim'),
    featureStart: field('featurestart', scheduled),
    featureStop: field('featureStop', scheduled),
    startHour: field('startHour', scheduled),
    startMinute: field('startMinute', scheduled),
    startDayPart: field('startDayPart', scheduled && dayParts),
    stopHour: field('stopHour', scheduled),
    stopMinute: field('stopMinute', scheduled),
    stopDayPart: field('stopDayPart', scheduled && dayParts),
  };
}

/** loadcategoryassignment.cfm: the feature-schedule editor of one category assignment. */
async function runLoadCategoryAssignment(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const localeHasDayParts = (await storedSession(request)).localeHasDayParts ?? true;
  // The editor prints every schedule field whatever the assignment, so each is read.
  for (const name of ['categoryAssignment', 'cattrim', 'featurestart', 'featureStop', 'startHour', 'startMinute', 'stopHour', 'stopMinute']) rcRequired(rc, name);
  if (localeHasDayParts) for (const name of ['startDayPart', 'stopDayPart']) rcRequired(rc, name);
  const model: CategoryAssignmentModel = { ...categoryFeatureOf(rc, localeHasDayParts), localeHasDayParts };
  return panelResult(await renderRaw(request, ctx, actor, (rctx) => renderLoadCategoryAssignment(model, rctx)));
}

/** loadcategoryfeaturestartstop.cfm: an assignment's feature state and the hidden fields of its schedule. */
async function runLoadCategoryFeatureStartStop(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const model = categoryFeatureOf(rc, true);
  return panelResult(await renderRaw(request, ctx, actor, (rctx) => renderLoadCategoryFeatureStartStop(model, rctx)));
}

/** loadtagarray.cfm: the site's live tag cloud of a tag group as a JavaScript array literal. */
async function runLoadTagArray(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const tags = await inTenant(ctx, actor, (tx) =>
    ctx.domain.repository.content.tagCloud(tx, { siteId: rcText(rc, 'siteid'), tagGroup: rcText(rc, 'taggroup'), today: ctx.clock.now() }),
  );
  return panelResult(renderTagArray(tags.map((row) => row.tag), 'carch'));
}

/** contentManager.read's bean of a node's active version: the stored row, or the new bean of a missing one. */
async function activeLegacyBean(ctx: ContentRouteContext, actor: Actor, contentId: string, siteId: string): Promise<LegacyContentBean> {
  const bean = await getActiveContent(ctx.domain, actor, { contentId, siteId });
  return bean.isNew === 0 ? LegacyContentBean.fromVersion(bean.version, actor, ctx.clock.now()) : LegacyContentBean.notFound(actor, ctx.clock.now(), siteId);
}

/** `java.util.TimeZone.getDefault().getID()` of the legacy server, whose zone every process shares (TZ). */
function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** java.util.TimeZone offset of `zone` at `at` in seconds; an unknown zone is GMT, as `getTimeZone` makes it. */
function zoneOffsetSeconds(zone: string, at: Date): number {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch {
    return 0;
  }
  const parts = new Map(format.formatToParts(at).map((part) => [part.type, Number(part.value)] as const));
  const wall = Date.UTC(parts.get('year') ?? 1970, (parts.get('month') ?? 1) - 1, parts.get('day') ?? 1, parts.get('hour') ?? 0, parts.get('minute') ?? 0, parts.get('second') ?? 0);
  return Math.round((wall - (at.getTime() - at.getMilliseconds())) / 1000);
}

/** contentBean `getDisplayStart(timezone)` / `getDisplayStop(timezone)`: cfobject.convertTimezone from the server zone, offsets taken now. */
function inTimeZone(value: unknown, zone: string, now: Date): Date | null {
  if (!(value instanceof Date)) return null;
  const from = serverTimeZone();
  if (zone === '' || zone === from) return value;
  return new Date(value.getTime() + (zoneOffsetSeconds(zone, now) - zoneOffsetSeconds(from, now)) * 1000);
}

/** loadquickedit.cfm: the Site Manager quick editor of one attribute of a node without drafts. */
async function runLoadQuickEdit(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const siteId = rcText(rc, 'siteid');
  const contentId = rcRequired(rc, 'contentID');
  const now = ctx.clock.now();
  const content = await activeLegacyBean(ctx, actor, contentId, siteId);
  const hasDrafts = (await getHasDrafts(ctx.domain, actor, { contentId: content.contentId() || contentId, siteId })) > 0;
  const attribute = hasDrafts ? rcText(rc, 'attribute') : rcRequired(rc, 'attribute');
  // `contentUtility.getTemplates` lists the site theme's templates directory on the legacy web root.
  if (!hasDrafts && cfEq(attribute, 'template')) throw new CarchHaltedError('loadquickedit', "the theme's template list is a directory on the legacy web root");
  const state = await storedSession(request);
  const display = !hasDrafts && cfEq(attribute, 'display');
  const interval = displayIntervalValues(display ? content.text('displayinterval') : null, content.raw('displaystart') as Date | null, content.raw('displaystop') as Date | null, serverTimeZone(), state.locale ?? 'en_US');
  const isHome = cfEq(contentId, LEGACY_ADMIN_SENTINEL_ID);
  const parentType = display && !isHome ? (await activeLegacyBean(ctx, actor, content.text('parentid'), siteId)).text('type') : '';
  const model: QuickEditModel = {
    attribute,
    contentId,
    hasDrafts,
    content: {
      isnav: content.number('isnav'),
      inheritobjects: content.text('inheritobjects'),
      template: content.text('template'),
      childtemplate: content.text('childtemplate'),
      display: content.number('display'),
      displayinterval: content.text('displayinterval'),
    },
    displayStart: inTimeZone(content.raw('displaystart'), interval.timezone, now),
    displayStop: inTimeZone(content.raw('displaystop'), interval.timezone, now),
    displayInterval: interval,
    parentType,
    requestPtype: rcText(rc, 'ptype'),
    templates: [],
    localeHasDayParts: state.localeHasDayParts ?? true,
    // configBean holds no `tzRegex`, so `globalConfig('tzRegex')` is '' and no zone list is read.
    tzRegex: '',
    defaultTimeZone: serverTimeZone(),
    availableTimeZones: [],
    now,
  };
  return rendered(await renderRaw(request, ctx, actor, (rctx) => renderLoadQuickEdit(model, rctx)));
}

/** A related-content set as extendRelatedContentSetBean holds a stored row. */
function relatedSetView(row: ExtendRcsetRow): RelatedContentSetView {
  return { relatedcontentsetid: row.relatedcontentsetid, name: row.name, entitytype: row.entitytype || 'content', availablesubtypes: row.availablesubtypes ?? '', displayName: '' };
}

/** extendSubType.getRelatedContentSets() of `type`/`subtype` (extendSubType.cfc:517-576): ID sets, Default, TYPE then BASE sets. */
async function relatedContentSetsOf(ctx: ContentRouteContext, actor: Actor, action: string, siteId: string, type: string, subtype: string): Promise<RelatedContentSetView[]> {
  const sameSite = (row: ExtendRcsetRow): boolean => (row.siteid ?? '').trimEnd().toLowerCase() === siteId.trimEnd().toLowerCase();
  const sets = await inTenant(ctx, actor, async (tx) => {
    const repo = ctx.domain.repository.extend;
    const setsOf = async (subtypes: ReadonlyArray<{ subtypeid: string }>): Promise<RelatedContentSetView[]> => {
      const rows: ExtendRcsetRow[] = [];
      for (const st of subtypes) rows.push(...(await repo.rcsetsForSubtype(tx, { subTypeId: st.subtypeid })).filter(sameSite));
      // One `order by orderNo` across the matched subtypes; the stable sort keeps each subtype's order on ties.
      return rows.sort((a, b) => (a.orderno ?? 0) - (b.orderno ?? 0)).map(relatedSetView);
    };
    const own = (await repo.subtypes(tx, { siteId, type, subType: subtype })).slice(0, 1);
    const all = [...(await setsOf(own)), { ...DEFAULT_RELATED_CONTENT_SET }];
    if (!cfEq(subtype, 'Default')) all.push(...(await setsOf(await repo.subtypes(tx, { siteId, type, subType: 'Default' }))));
    if (!listFindNoCaseOf(NO_BASE_EXTEND_TYPES, type)) all.push(...(await setsOf(await repo.subtypes(tx, { siteId, type: 'Base', subType: 'Default' }))));
    return all;
  });
  // A set of another entity type prints its entity's display name, which only the CFML entity registry holds.
  if (sets.some((set) => !cfEq(set.entitytype ?? '', 'content'))) {
    throw new CarchHaltedError(action, "a related-content set of another entity type names that entity's display name, which only the CFML entity registry holds");
  }
  return sets;
}

/** contentManager.getCrumbList(contentid, siteid) in the tenant holding `siteId`. */
async function crumbsAt(ctx: ContentRouteContext, actor: Actor, contentId: string, siteId: string): Promise<Crumb[]> {
  if (cfEq(siteId, actor.siteId)) return getCrumbList(ctx.domain, actor, { contentId, siteId });
  return ctx.domain.db.withTenant(tenantIdForSite(siteId), (tx) => ctx.domain.repository.content.crumbPath(tx, { contentId, siteId }));
}

/** contentGateway.getRelatedContent over the site's content pool: links of this tenant's version, rows of each pool tenant, merged. */
async function relatedRowsOf(ctx: ContentRouteContext, actor: Actor, args: RelatedContentArgs): Promise<RelatedContentRow[]> {
  const entry = await registryEntryForTenant(ctx.domain.db, actor.tenantId);
  const full: RelatedContentArgs = { ...args, contentPoolSiteIds: entry?.contentPoolIds ?? [args.siteId] };
  const tenants = entry?.contentPoolTenants ?? [actor.tenantId];
  const repo = ctx.domain.repository.content;
  if (tenants.every((tenantId) => tenantId === actor.tenantId)) return inTenant(ctx, actor, (tx) => repo.relatedContent(tx, full));
  return inTenant(ctx, actor, async (tx) => {
    const links = await repo.relatedLinks(tx, full);
    const candidates: RelatedCandidate[][] = [];
    for (const tenantId of tenants) {
      candidates.push(tenantId === actor.tenantId ? await repo.relatedCandidates(tx, { ...full, links }) : await ctx.domain.db.withTenant(tenantId, (poolTx) => repo.relatedCandidates(poolTx, { ...full, links })));
    }
    return repo.mergeRelatedContent(tx, full, candidates);
  });
}

/** A related-content row with the crumbs of its own site. */
async function relatedItemOf(ctx: ContentRouteContext, actor: Actor, row: { contentid: string; siteid: string; type: string; subtype: string }): Promise<RelatedContentItem> {
  return { ...row, crumbs: await crumbsAt(ctx, actor, row.contentid, row.siteid) };
}

/** `parseDateArg(value)` as a date, raising ACF's error where `dateAdd` meets a value that is no date. */
function dateArg(value: string): Date {
  const parsed = parseDateArg(value);
  if (!(parsed instanceof Date)) throw new TypeError(`The value ${value} cannot be converted to a date.`);
  return parsed;
}

/** loadrelatedcontent.cfm:322-411: the related-content search feed of the request site. */
async function relatedSearchRows(ctx: ContentRouteContext, actor: Actor, rc: Rc, contentPoolId: string): Promise<FeedContentRow[]> {
  const siteId = rcText(rc, 'siteid');
  const feed = FeedBean.init(ctx.clock);
  for (const [name, value] of [['siteid', siteId], ['maxItems', 100], ['nextN', 100], ['liveOnly', 0], ['showNavOnly', 0], ['showExcludeSearch', 1], ['sortBy', 'lastupdate'], ['sortDirection', 'desc'], ['contentPoolID', contentPoolId]] as const) {
    feed.setValue(name, value);
  }
  addFeedParam(feed, { field: 'active', criteria: '1', condition: 'eq' });
  addFeedParam(feed, { field: 'contentid', criteria: rcText(rc, 'contentid'), condition: 'neq' });
  const typeSelector = rcText(rc, 'searchTypeSelector');
  if (cfEq(rcText(rc, 'relatedcontentsetid'), 'calendar')) {
    addFeedParam(feed, { field: 'tcontent.type', criteria: 'Calendar', condition: 'eq' });
  } else if (typeSelector !== '') {
    const parts = cfListToArray(typeSelector, '^');
    addFeedParam(feed, { field: 'tcontent.type', criteria: parts[0] ?? '', condition: 'eq' });
    addFeedParam(feed, { field: 'tcontent.subtype', criteria: parts.at(-1) ?? '', condition: 'eq' });
  }
  const start = rcText(rc, 'rcStartDate');
  const end = rcText(rc, 'rcEndDate');
  if (start !== '' || end !== '') {
    addFeedParam(feed, { relationship: 'and (' });
    ['releaseDate', 'displayStart', 'featureStart'].forEach((field, index) => {
      addFeedParam(feed, { relationship: index === 0 ? '(' : 'or (' });
      if (start !== '') addFeedParam(feed, { field: `tcontent.${field}`, datatype: 'date', condition: 'gte', criteria: start });
      if (end !== '') addFeedParam(feed, { field: `tcontent.${field}`, datatype: 'date', condition: 'lt', criteria: criteriaText(cfDateAdd('d', 1, dateArg(end))) });
      addFeedParam(feed, { relationship: ')' });
    });
    addFeedParam(feed, { relationship: ')' });
  }
  if (rcText(rc, 'rcCategoryID') !== '') feed.setValue('categoryID', rcText(rc, 'rcCategoryID'));
  const keywords = rcText(rc, 'keywords');
  if (keywords !== '') {
    const found = await privateSearch(ctx.domain, actor, { siteId, keywords, startRow: 1 });
    addFeedParam(feed, { field: 'tcontent.contentID', datatype: 'varchar', condition: 'in', criteria: contentIdList(found.rows) });
  }
  return feedContent(ctx.domain, actor, feed);
}

/** The category pool tree as the related-content views nest it. */
function categoryNodesOf(tree: readonly SiteFlatCategory[]): CategoryNode[] {
  return tree.map((node) => ({ categoryid: node.categoryid, name: node.name, isopen: node.isopen, children: categoryNodesOf(node.kids) }));
}

/** loadrelatedcontent.cfm: the related-content search form and, when not new, the search results. */
async function runLoadRelatedContent(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  for (const [name, value] of [['isNew', '1'], ['keywords', ''], ['searchTypeSelector', ''], ['relatedcontentsetid', ''], ['rcStartDate', ''], ['rcEndDate', ''], ['rcCategoryID', ''], ['external', 'true'], ['entitytype', 'content']] as const) {
    rcParam(rc, name, value);
  }
  const siteId = rcText(rc, 'siteid');
  const entry = await registryEntryForTenant(ctx.domain.db, actor.tenantId);
  const contentPoolId = (entry?.contentPoolIds ?? [siteId]).join(',');
  const bean = await legacyVersion(ctx, actor, rcRequired(rc, 'contenthistid'), siteId);
  const relatedContentSets = await relatedContentSetsOf(ctx, actor, 'loadrelatedcontent', siteId, bean.text('type'), bean.text('subtype'));
  const isNew = rcFlag(rc, 'isNew');
  const entityType = rcText(rc, 'entitytype');
  let results: RelatedSearchItem[] | undefined;
  if (!isNew) {
    if (!cfEq(entityType, 'content')) throw new CarchHaltedError('loadrelatedcontent', "a search of another entity type reads that entity's feed and list properties from the CFML entity registry");
    const poolIds = cfListToArray(contentPoolId);
    const own = poolIds.indexOf(siteId);
    if (own >= 0) poolIds.splice(own, 1);
    // `getSite().getSite()`: site names are programs-sites settings the registry does not hold.
    if (poolIds.length > 0) throw new CarchHaltedError('loadrelatedcontent', "results over a content pool print each pool site's name, a programs-sites setting the registry does not hold");
    const memberships = await membershipsOf(request, ctx, actor);
    results = [];
    for (const row of (await relatedSearchRows(ctx, actor, rc, contentPoolId)).slice(0, 100)) {
      const itemSite = row.siteid ?? siteId;
      const crumbs = await crumbsAt(ctx, actor, row.contentid ?? '', itemSite);
      const verdict = await getNodePerm(ctx.domain, actor, crumbs, memberships);
      results.push({ contentid: row.contentid ?? '', siteid: itemSite, type: row.type ?? '', subtype: row.subtype ?? '', crumbs, verdict });
    }
  }
  const model: LoadRelatedContentModel = {
    siteId,
    isNew,
    keywords: rcText(rc, 'keywords'),
    searchTypeSelector: rcText(rc, 'searchTypeSelector'),
    relatedContentSetId: rcText(rc, 'relatedcontentsetid'),
    rcStartDate: rcText(rc, 'rcStartDate'),
    rcEndDate: rcText(rc, 'rcEndDate'),
    rcCategoryId: rcText(rc, 'rcCategoryID'),
    external: rcFlag(rc, 'external'),
    entityType,
    relatedContentSets,
    subTypes: (await subtypesOf(ctx, actor, siteId, true)).map((row) => ({ type: row.type, subtype: row.subtype, iconclass: row.iconclass, adminonly: row.adminonly })),
    categories: categoryNodesOf(await categoryTreeOf(ctx, actor)),
    contentPoolId,
    siteNames: {},
    ...(results === undefined ? {} : { results }),
    customIcons: await customIconsOf(ctx, actor, siteId),
  };
  return rendered(await renderRaw(request, ctx, actor, (rctx) => renderLoadRelatedContent(model, rctx)));
}

/** The ad-hoc set's rows: each listed id whose node exists, or each row the client sent, with their crumbs. */
async function relatedItemsFor(ctx: ContentRouteContext, actor: Actor, raw: string, siteId: string): Promise<RelatedContentItem[]> {
  const items: RelatedContentItem[] = [];
  for (const ref of relatedItemsOf(raw)) {
    if ('contentId' in ref) {
      const found = await getActiveContent(ctx.domain, actor, { contentId: ref.contentId, siteId });
      if (found.isNew === 1) continue;
      const v = found.version;
      items.push(await relatedItemOf(ctx, actor, { contentid: v.contentid ?? '', siteid: v.siteid ?? siteId, type: v.type ?? '', subtype: v.subtype ?? '' }));
    } else {
      const cell = (name: string): string => {
        if (!(name in ref.row)) throw new UndefinedLegacyElementError(`Element ${name.toUpperCase()} is undefined in ITEM.`);
        const value = ref.row[name];
        return typeof value === 'number' ? cfNumberString(value) : value === null || value === undefined ? '' : String(value);
      };
      const row = { contentid: cell('contentid'), siteid: cell('siteid'), type: cell('type'), subtype: cell('subtype') };
      cell('url');
      cell('title');
      items.push(await relatedItemOf(ctx, actor, row));
    }
  }
  return items;
}

/** loadselectedrelatedcontent.cfm: the related content of each set the request selects. */
async function runLoadSelectedRelatedContent(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  for (const [name, value] of [['relatedcontentsetid', ''], ['entitytype', 'content'], ['relateditems', '[]']] as const) rcParam(rc, name, value);
  const siteId = rcText(rc, 'siteid');
  const bean = await legacyVersion(ctx, actor, rcRequired(rc, 'contenthistid'), siteId);
  const setId = rcText(rc, 'relatedcontentsetid');
  const adHoc = cfEq(setId, 'custom') || cfEq(setId, 'calendar');
  const all = await relatedContentSetsOf(ctx, actor, 'loadselectedrelatedcontent', siteId, rcRequired(rc, 'type'), rcRequired(rc, 'subtype'));
  const match = setId === '' || adHoc ? undefined : all.find((set) => cfEq(set.relatedcontentsetid, setId));
  const printed = adHoc ? [] : match === undefined ? all : [match];
  const relatedContent: Record<string, RelatedContentItem[]> = {};
  for (const set of printed) {
    const rows = await relatedRowsOf(ctx, actor, { siteId, contentHistId: bean.contentHistId(), relatedContentSetId: set.relatedcontentsetid, liveOnly: false, today: ctx.clock.now() });
    const items: RelatedContentItem[] = [];
    for (const row of rows) items.push(await relatedItemOf(ctx, actor, { contentid: row.contentid ?? '', siteid: row.siteid ?? siteId, type: row.type ?? '', subtype: row.subtype ?? '' }));
    relatedContent[set.relatedcontentsetid] = items;
  }
  const model: LoadSelectedRelatedContentModel = {
    relatedContentSetId: setId,
    relatedContentSets: all,
    contentId: bean.isNew === 0 ? bean.contentId() : '',
    relatedContent,
    relatedItems: adHoc ? await relatedItemsFor(ctx, actor, rcText(rc, 'relateditems'), siteId) : [],
    relatedEntities: {},
    subTypes: (await subtypesOf(ctx, actor, siteId, false)).map((row) => ({ type: row.type, subtype: row.subtype, iconclass: row.iconclass, adminonly: row.adminonly })),
    customIcons: await customIconsOf(ctx, actor, siteId),
  };
  return rendered(await renderRaw(request, ctx, actor, (rctx) => renderLoadSelectedRelatedContent(model, rctx)));
}

/** contentRenderer.dspZoomText (contentRendererUtility.cfc:678-693): menu titles from the root, `>`-separated, trimmed. */
function zoomText(crumbs: readonly Crumb[]): string {
  const [leaf] = crumbs;
  if (leaf === undefined) throw new RangeError('The element at position 1 cannot be found.');
  let text = '';
  for (let i = crumbs.length - 1; i >= 1; i -= 1) text += ` ${crumbs[i]?.menutitle ?? ''}  >`;
  return `${text} ${leaf.menutitle ?? ''}`.trim();
}

/** dsp_folders.cfm, dsp_calendars.cfm and dsp_galleries.cfm: the live sections of `type`, each with its crumb path, by path. */
async function sectionsOf(ctx: ContentRouteContext, actor: Actor, siteId: string, type: string): Promise<ObjectClassSection[]> {
  const rows = await inTenant(ctx, actor, async (tx) => {
    const sections = await ctx.domain.repository.content.sections(tx, { siteId, type });
    const found: ObjectClassSection[] = [];
    for (const row of sections) {
      const crumbs = await ctx.domain.repository.content.crumbPath(tx, { contentId: row.contentid ?? '', siteId: row.siteid ?? siteId, path: row.path ?? '' });
      found.push({ contentid: row.contentid ?? '', pathString: zoomText(crumbs) });
    }
    return found;
  });
  // A query of queries orders text case-sensitively; the stable sort keeps ties in query order.
  return rows.sort((a, b) => (a.pathString < b.pathString ? -1 : a.pathString > b.pathString ? 1 : 0));
}

/** The query loadclass.cfm's include for `classid` reads, halted where its table is another service's. */
async function objectClassData(ctx: ContentRouteContext, actor: Actor, classid: string, siteId: string): Promise<ObjectClassData> {
  const feedsOf = async (kind: 'rsLocal' | 'rsRemote'): Promise<ObjectClassFeed[]> => (await listFeeds(ctx.domain, actor, siteId))[kind].map((row) => ({ feedid: row.feedid, name: row.name }));
  switch (classid.toLowerCase()) {
    case 'component':
      return { components: await inTenant(ctx, actor, (tx) => ctx.domain.repository.content.components(tx, { moduleId: SITE_MANAGER_MODULE, siteId })) };
    case 'form':
      return { forms: await inTenant(ctx, actor, (tx) => ctx.domain.repository.content.componentType(tx, { siteId, type: 'Form' })) };
    case 'folder':
    case 'calendar':
    case 'gallery':
      return { sections: await sectionsOf(ctx, actor, siteId, classid.toLowerCase() === 'folder' ? 'Folder' : classid.toLowerCase() === 'calendar' ? 'Calendar' : 'Gallery') };
    case 'localfeed':
    case 'slideshow':
      return { localFeeds: await feedsOf('rsLocal') };
    case 'remotefeed':
      return { remoteFeeds: await feedsOf('rsRemote') };
    case 'mailinglist':
      throw new CarchHaltedError('loadclass', "mailing lists are communications' tmailinglist rows");
    case 'system':
    case 'navigation':
      throw new CarchHaltedError('loadclass', "system objects are programs-sites' tsystemobjects rows");
    default:
      return {};
  }
}

/** loadclass.cfm: the legacy display-object picker of one object class. */
async function runLoadClass(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  for (const [name, value] of [['layoutmanager', 'false'], ['contentid', ''], ['parentid', ''], ['contenthistid', ''], ['objectid', '']] as const) rcParam(rc, name, value);
  const siteId = rcText(rc, 'siteid');
  const classid = rcRequired(rc, 'classid');
  const site = await siteOf(ctx, actor);
  const model: LoadClassModel = {
    classid,
    subclassid: rcText(rc, 'subclassid'),
    layoutManager: rcFlag(rc, 'layoutmanager'),
    siteId,
    contentId: rcText(rc, 'contentid'),
    parentId: rcText(rc, 'parentid'),
    contentHistId: rcText(rc, 'contenthistid'),
    columnCount: site.columnCount ?? 3,
    // `<webroot>/<siteid>/includes/display_objects/custom/admin/dsp_objectClass.cfm`: Masa 7.6.1 creates no such site
    // directory under the web root, and no seeded site adds one, so the include never exists in this deployment.
    customObjectClassInclude: false,
    data: ['plugins', 'plugin'].includes(classid.toLowerCase()) ? {} : await objectClassData(ctx, actor, classid, siteId),
  };
  return panelOrHalt('loadclass', await renderRaw(request, ctx, actor, (rctx) => renderLoadClass(model, rctx)));
}

/** loadclassconfigurator.cfm reads the site's display-object registry and configurator files, which only the legacy runtime holds. */
async function runLoadClassConfigurator(): Promise<never> {
  throw new CarchHaltedError('loadclassconfigurator', "the display-object registry and configurator lookups read the theme, site and module CFML on the legacy web root");
}

/** A bean value as CFML text; complex values print nothing here, as no attribute input reads one. */
function cfValueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}`;
  if (value === null || value === undefined) return '';
  return undefined;
}

/** extendSubType.getExtendSets(inherit=true, container, activeOnly=true) (extendSubType.cfc:474-886), with each set's attributes. */
async function extendSetsOf(ctx: ContentRouteContext, actor: Actor, siteId: string, type: string, subtype: string, container: string): Promise<ExtendSetModel[]> {
  return inTenant(ctx, actor, async (tx) => {
    const repo = ctx.domain.repository.extend;
    const levels: Array<{ level: number; subtypes: ExtendSubtypeRow[] }> = [];
    const own = (await repo.subtypes(tx, { siteId, type, subType: subtype })).slice(0, 1).filter((row) => row.isactive === 1);
    levels.push({ level: 0, subtypes: own });
    if (!cfEq(subtype, 'Default')) levels.push({ level: 1, subtypes: await repo.subtypes(tx, { siteId, type, subType: 'Default' }) });
    if (!listFindNoCaseOf(NO_BASE_EXTEND_TYPES, type)) {
      const base = await repo.subtypes(tx, { siteId, type: 'Base' });
      levels.push({ level: 2, subtypes: base.filter((row) => cfEq(row.subtype ?? '', subtype) || cfEq(row.subtype ?? '', 'Default')) });
    }
    const sets: Array<{ level: number; row: Awaited<ReturnType<typeof repo.setsForSubtype>>[number] }> = [];
    for (const { level, subtypes } of levels) {
      for (const st of subtypes) {
        for (const row of await repo.setsForSubtype(tx, { subTypeId: st.subtypeid })) {
          if ((row.siteid ?? '').trimEnd().toLowerCase() === siteId.trimEnd().toLowerCase() && cfEq(row.container ?? '', container)) sets.push({ level, row });
        }
      }
    }
    // `order by setlevel desc, orderno`, a stable query-of-queries sort.
    sets.sort((a, b) => b.level - a.level || (a.row.orderno ?? 0) - (b.row.orderno ?? 0));
    const attributes = await repo.attributesForSets(tx, { extendSetIds: sets.map((set) => set.row.extendsetid) });
    return sets.map(({ row }) => ({
      extendsetid: row.extendsetid,
      categoryid: row.categoryid,
      name: row.name,
      attributes: attributes
        .filter((attribute) => cfEq(attribute.extendsetid ?? '', row.extendsetid))
        .sort((a, b) => (a.orderno ?? 0) - (b.orderno ?? 0) || noCaseCompare(a.name ?? '', b.name ?? '')),
    }));
  });
}

/** The extended-attribute containers of a content bean (contentManager.getTabList, `Extended Attributes` as `Default`). */
const EXTEND_CONTAINERS = ['Basic', 'SEO', 'Summary', 'Image', 'Publishing', 'Scheduling', 'Layout & Objects', 'Categorization', 'Tags', 'Related Content', 'Default', 'Remote'];

/** loadextendedattributes.cfm: each tab container's extend sets for the edit form, as one JSON struct. */
async function runLoadExtendedAttributes(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  const siteId = rcText(rc, 'siteid');
  const contentHistId = rcRequired(rc, 'contentHistID');
  const type = rcRequired(rc, 'type');
  const subtype = rcRequired(rc, 'subtype');
  const state = await storedSession(request);
  // session.mura.editBean, the bean a rejected save kept, when it is this version.
  const kept = structOf(muraValue(state, 'editBean'));
  const keptHistId = Object.entries(kept).find(([key]) => key.toLowerCase() === 'contenthistid')?.[1];
  const values: Record<string, string> = {};
  const put = (name: string, value: unknown): void => {
    const text = cfValueText(value);
    if (text !== undefined && !Object.keys(values).some((key) => key.toLowerCase() === name.toLowerCase())) values[name] = text;
  };
  const setsByContainer: Record<string, ExtendSetModel[]> = {};
  for (const container of EXTEND_CONTAINERS) setsByContainer[container] = await extendSetsOf(ctx, actor, siteId, type, subtype, container);
  if (typeof keptHistId === 'string' && cfEq(keptHistId, contentHistId)) {
    for (const [name, value] of Object.entries(kept)) put(name, value);
  } else {
    const bean = await legacyVersion(ctx, actor, contentHistId, siteId);
    if (bean.isNew === 1) {
      bean.setValue('type', type);
      bean.setValue('subtype', subtype);
    }
    for (const [name, value] of bean.entries()) put(name, value);
    if (bean.isNew === 0) {
      const names = new Map(Object.values(setsByContainer).flat().flatMap((set) => set.attributes).map((attribute) => [String(attribute.attributeid), attribute.name ?? ''] as const));
      for (const row of await inTenant(ctx, actor, (tx) => ctx.domain.repository.extend.extendDataFor(tx, { baseId: contentHistId }))) {
        const name = names.get(String(row.attributeid));
        if (name !== undefined) put(name, row.attributevalue);
      }
    }
  }
  const [own] = await inTenant(ctx, actor, (tx) => ctx.domain.repository.extend.subtypes(tx, { siteId, type, subType: subtype }));
  const model: ExtendedAttributesModel = {
    setsByContainer,
    values,
    subtype: { hassummary: own?.hassummary ?? 1, hasbody: own?.hasbody ?? 1, hasassocfile: own?.hasassocfile ?? 1, hasconfigurator: own?.hasconfigurator ?? 0 },
    ...(rcHas(rc, 'tablist') ? { tablist: rcText(rc, 'tablist') } : {}),
    // trazunasettings stays legacy (decision list) and no seeded site configures a Razuna hostname.
    razunaEnabled: false,
  };
  return panelOrHalt('loadextendedattributes', await renderRaw(request, ctx, actor, (rctx) => renderLoadExtendedAttributes(model, rctx)));
}

/** A user bean's `getIsNew()` and `getFullName()` for a type-2 user, where this service can name it. */
async function statusUser(request: FastifyRequest, actor: Actor, userId: string): Promise<StatusModalUser> {
  const named = await userNamed(request, actor, 'statusmodal', userId);
  return named === undefined ? { isNew: true, fullName: '' } : { isNew: false, fullName: `${named.fname} ${named.lname}`.trim() };
}

/** approvalRequest.getGroup(): the projected group in the user pools, the empty bean of a deleted or unset one, else a user. */
async function approvalGroupOf(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor, groupId: string): Promise<StatusModalApproval['group']> {
  if (groupId === '') return { type: 2, groupName: '', fullName: '' };
  let found: Awaited<ReturnType<typeof ctx.domain.repository.projections.groupNames>>[number] | undefined;
  for (const kind of ['publicUser', 'privateUser'] as const) {
    const rows = await withPoolTenant(ctx.domain.db, actor.tenantId, kind, (tx) => ctx.domain.repository.projections.groupNames(tx, [groupId]));
    for (const row of rows) if (found === undefined || (found.deleted && !row.deleted)) found = row;
  }
  if (found !== undefined) return found.deleted ? { type: 2, groupName: '', fullName: '' } : { type: 1, groupName: found.group_name ?? '', fullName: found.group_name ?? '' };
  const user = await statusUser(request, actor, groupId);
  return { type: 2, groupName: '', fullName: user.fullName };
}

/** statusmodal.cfm: a version's author, date, status, change set and pending approval with its action form. */
async function runStatusModal(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const rc = await rawRc(request, actor);
  rcParam(rc, 'mode', '');
  const siteId = rcText(rc, 'siteid');
  const now = ctx.clock.now();
  if (cfEq(rcText(rc, 'mode'), 'frontend')) throw new CarchHaltedError('statusmodal', 'the front-end status modal renders inside the admin layout, which a raw fragment does not carry');
  const content = await legacyVersion(ctx, actor, rcRequired(rc, 'contenthistid'), siteId);
  const crumbs = await getCrumbList(ctx.domain, actor, { contentId: content.contentId(), siteId: content.text('siteid') || siteId, path: content.text('path') });
  const memberships = await membershipsOf(request, ctx, actor);
  const approval = await inTenant(ctx, actor, async (tx) => {
    const required = (await requiresApproval(tx, ctx.domain.repository, actor, crumbs, memberships)).required;
    // requiresApproval() keeps the chain it finds as the bean's chainID, which getApprovalRequest() loads by.
    const shown = await requiresApproval(tx, ctx.domain.repository, actor, crumbs, memberships, false);
    return { required, shown: shown.required, chainId: shown.chainId };
  });
  let user = await statusUser(request, actor, content.text('lastupdatebyid'));
  let pending: StatusModalApproval | undefined;
  if (approval.required || approval.shown) {
    const loaded = await inTenant(ctx, actor, (tx) => loadRequest(tx, ctx.domain.repository, { contentHistId: content.contentHistId(), chainId: approval.chainId, siteId: content.text('siteid') || siteId }));
    const rows = loaded.isNew ? [] : await inTenant(ctx, actor, (tx) => ctx.domain.repository.approvals.actionsForRequest(tx, { requestId: loaded.values.requestid }));
    const actions: Array<StatusModalApproval['actions'][number]> = [];
    for (const row of rows) actions.push({ actiontype: row.actiontype, comments: row.comments, created: row.created, userFullName: (await statusUser(request, actor, row.userid ?? '')).fullName });
    pending = {
      request: { status: loaded.values.status, groupid: loaded.values.groupid, userid: loaded.values.userid, requestid: loaded.values.requestid, siteid: loaded.values.siteid },
      group: await approvalGroupOf(request, ctx, actor, loaded.values.groupid),
      actions,
    };
    if (user.isNew) user = await statusUser(request, actor, loaded.values.userid);
  }
  const changesetId = content.text('changesetid');
  const changeset = SITE_FLAGS.hasChangesets ? await readChangeset(ctx.domain, actor, changesetId) : undefined;
  const stats = await inTenant(ctx, actor, (tx) => ctx.domain.repository.stats.readStats(tx, { contentId: content.contentId(), siteId }));
  const model: StatusModalModel = {
    mode: rcText(rc, 'mode'),
    content: { active: content.number('active'), approved: content.number('approved'), lastupdate: lastUpdateOf(content, now), changesetid: changesetId, approvalStatus: content.text('approvalstatus') },
    user,
    requiresApproval: approval.required,
    showApprovalStatus: approval.shown,
    ...(pending === undefined ? {} : { approval: pending }),
    lockType: stats?.locktype ?? '',
    hasChangesets: SITE_FLAGS.hasChangesets,
    changesetName: changeset === undefined || changeset.isnew === 1 ? undefined : changeset.name,
    membershipIds: (await sessionUser(request)).membershipids ?? '',
    resourcePath: '',
  };
  const result = await renderRaw(request, ctx, actor, (rctx) => renderStatusModal(model, rctx));
  if ('layout' in result) throw new CarchHaltedError('statusmodal', 'the front-end status modal renders inside the admin layout, which a raw fragment does not carry');
  return panelResult(result);
}

/** FW/1 `redirect()` (framework.cfc:735-781): `<path>?muraAction=<action>` then the append pairs; path-less redirects use the admin script. */
function fw1Location(redirect: AdminRedirect, path: string | undefined, site: ContentSaveSite): string {
  const base = path ?? `${site.urls.context}/admin/index.cfm`;
  const query = redirect.params.map(([name, value]) => `&${name}=${esapiUrlEncode(value)}`).join('');
  return `${base}?muraAction=${redirect.circuit}.${redirect.action}${query}`;
}

/** contentBean.getIsOnDisplay (contentBean.cfc:1355-1376) at `now`. */
function isOnDisplayAt(bean: LegacyContentBean, now: Date): boolean {
  const display = bean.number('display');
  if (display === 1) return true;
  if (display !== 2) return false;
  const start = bean.raw('displaystart');
  if (!(start instanceof Date) || start > now) return false;
  const stop = bean.raw('displaystop');
  if (stop === '' || stop === null || stop === undefined) return true;
  return stop instanceof Date && stop >= now;
}

/** A bean as dsp_close_compact_display.cfm reads it, with its URL and the URL previewing its own version. */
function closeBean(bean: LegacyContentBean, site: ContentSaveSite, now: Date): Rc {
  const url = (querystring?: string): string => contentUrl(site.urls, { filename: bean.text('filename') }, querystring === undefined ? {} : { querystring });
  return {
    active: bean.number('active'),
    isOnDisplay: isOnDisplayAt(bean, now),
    type: bean.text('type'),
    contentID: bean.contentId(),
    contentHistID: bean.contentHistId(),
    url: url(),
    previewURL: url(`previewid=${bean.contentHistId()}`),
  };
}

/** dsp_close_compact_display.cfm's reads for a save without errors: the saved, current, parent and home beans. */
async function closeData(ctx: ContentRouteContext, actor: Actor, site: ContentSaveSite, rc: Rc, saved: LegacyContentBean): Promise<Rc> {
  const now = ctx.clock.now();
  const siteId = rcText(rc, 'siteid');
  const data: Rc = {
    contentBean: { type: saved.text('type'), contentID: saved.contentId(), remoteURL: saved.text('remoteurl'), active: saved.number('active') },
    useLayoutManager: false,
  };
  const homeId = rcText(rc, 'homeID');
  if (homeId !== '') data.homeURL = contentUrl(site.urls, { filename: (await activeLegacyBean(ctx, actor, homeId, siteId)).text('filename') });
  if (cfEq(rcText(rc, 'action'), 'add')) {
    const current = saved.number('active') !== 0 ? await activeLegacyBean(ctx, actor, saved.contentId(), saved.text('siteid')) : saved;
    data.currentBean = { ...closeBean(current, site, now), editedPreviewURL: contentUrl(site.urls, { filename: current.text('filename') }, { querystring: `previewID=${saved.contentHistId()}` }) };
    if (['file', 'link'].includes(saved.text('type').toLowerCase())) {
      const parent = await activeLegacyBean(ctx, actor, current.text('parentid'), current.text('siteid'));
      const parentHistId = rcText(rc, 'parenthistid');
      data.parentBean = {
        ...closeBean(parent, site, now),
        ...(parentHistId === ''
          ? {}
          : {
              parentHistPreviewURL: contentUrl(site.urls, { filename: parent.text('filename') }, { querystring: `previewid=${parentHistId}` }),
              parentHistExists: (await getContentVersion(ctx.domain, actor, { contentHistId: parentHistId, siteId })).isNew === 0,
            }),
      };
    }
  } else {
    data.parentContentBean = closeBean(await activeLegacyBean(ctx, actor, rcText(rc, 'parentid'), siteId), site, now);
  }
  return data;
}

/** The domains a return URL may keep: settingsManager.getAccessControlOriginDomainList over the registered sites. */
async function originDomains(ctx: ContentRouteContext): Promise<string> {
  const entries = await registryEntries(ctx.domain.db);
  return accessControlOriginDomains(entries.map((entry) => ({ domain: entry.domains.join(',') })), {}).join(',');
}

/** update.cfm's `{"files":[…]}` answer, typed by the request's Accept header as contentManager.multiFileUpload types it. */
function multiFileUploadResult(request: FastifyRequest, item: Record<string, unknown> | null): AdminRenderResult {
  const json = (request.headers.accept ?? '').includes('application/json');
  return { status: 200, contentType: json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', body: item === null ? '{"files":[' : `{"files":[${muraJsonEncode(item)}]}` };
}

/** carch.update (carch.cfc:336-451) and update.cfm: content deletes, saves and uploads; each CSRF context is checked only where legacy validates. */
async function runUpdate(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CarchRawResult> {
  const { rc } = await carchContext(paramsOf(request), actor, () => storedSession(request));
  const state = await storedSession(request);
  const site = await siteOf(ctx, actor);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const qqfile = Object.keys(query).some((key) => key.toLowerCase() === 'qqfile');
  const multiFileUpload = muraValue(state, 'multifileupload');
  // `session[<moduleID>]` (no `m`), which the Site Manager reset writes; `session['m<moduleID>']` is before()'s.
  const topIdsByModule = Object.fromEntries(Object.entries(state.moduleTopIds ?? {}).filter(([key]) => !/^m/i.test(key)));
  const result = await carchUpdate({ ...ctx.domain, storage: ctx.storage }, actor, site, {
    rc,
    files: await uploadsOf(request),
    validateCsrf: (context) => validateCsrf(request, context),
    session: { openSectionList: state.openSectionList ?? '', multiFileUpload: cfIsBoolean(multiFileUpload) && cfToBoolean(multiFileUpload), topIdsByModule },
    qqfile,
    ...(rcHas(rc, 'extraParams') ? { extraParams: rcText(rc, 'extraParams') } : {}),
    accessControlOriginDomains: await originDomains(ctx),
  });
  const mura: Record<string, unknown> = {};
  let openSectionList: string | undefined;
  for (const effect of result.sessionEffects) {
    if (effect.kind === 'openSectionList') openSectionList = effect.value;
    else if (effect.kind === 'multiFileUpload') mura.multifileupload = effect.value;
    // A kept bean travels as the rejected save's `data.contentBean`, which web stores as `session.mura.editBean`.
    else if (effect.bean === null) mura.editBean = null;
  }
  const effects = sessionEffectsOf(openSectionList === undefined ? undefined : { openSectionList }, mura);
  const answer = (out: AdminRenderResult, headers: Record<string, string> = {}): CarchRawResult => withEffects(out, effects, headers);
  const written = (write: AdminWriteResult): CarchRawResult => answer({ status: 200, contentType: BARE_JSON_CONTENT_TYPE, body: JSON.stringify(modelValue(write)) });
  const outcome = result.outcome;
  const now = ctx.clock.now();
  switch (outcome.kind) {
    case 'redirect': {
      const location = fw1Location(adminRedirect(outcome.action as `${string}.${string}`, outcome.params, outcome.append), outcome.path, site);
      return answer({ status: 302, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '', redirect: location }, { location });
    }
    case 'location':
      return answer({ status: 302, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '', redirect: outcome.url }, { location: outcome.url });
    case 'abort':
      return answer({ status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '' });
    case 'multiFileUpload':
      return answer(multiFileUploadResult(request, outcome.item));
    case 'text':
    case 'ajax': {
      const bean = outcome.kind === 'ajax' ? outcome.bean : undefined;
      const model: UpdateResponseModel = {
        qqfile: outcome.kind === 'text' && outcome.body === '{success:true}',
        ajaxRequest: outcome.kind === 'ajax',
        action: outcome.kind === 'text' && outcome.body !== '{success:true}' ? 'multiFileUpload' : rcText(rc, 'action'),
        content: { filename: bean?.text('filename') ?? '', contenthistid: bean?.contentHistId() ?? '', active: bean?.number('active') ?? 0, isOnDisplay: bean === undefined ? false : isOnDisplayAt(bean, now) },
        errors: bean?.errors ?? {},
      };
      const out = await renderRaw(request, ctx, actor, (rctx) => renderUpdateResponse(model, rctx));
      if ('delegate' in out) throw new TypeError(`update.cfm answered ${outcome.kind} with the edit page`);
      return answer({ status: out.status, contentType: out.contentType, body: out.body });
    }
    case 'rerender':
      throw editFormHalted('update');
    case 'closeCompactDisplay':
      return written({ saved: true, errors: {}, redirect: null, data: await closeData(ctx, actor, site, rc, outcome.bean) });
  }
}

/** The CSRF context of a raw action whose legacy handler validates `rc.contentid & suffix` before anything else. */
function contentIdContext(suffix: string): (request: FastifyRequest) => string {
  return (request) => `${rcText(paramsOf(request), 'contentid')}${suffix}`;
}

/** carch raw actions (`/v1/raw/carch/<action>`), each answering as the legacy fragment, JSON, download or redirect does. */
export const carchRawActions = {
  approvalaction: { run: runApprovalAction },
  assocfiles: { run: runAssocFiles },
  availablechangesets: { run: runAvailableChangesets },
  downloaddata: { run: runDownloadData },
  draftpromptdata: { run: runDraftPromptData },
  getaudittrail: { run: runGetAuditTrail },
  getimagesizeurl: { run: runGetImageSizeUrl },
  loadcategoryassignment: { run: runLoadCategoryAssignment },
  loadcategoryfeaturestartstop: { run: runLoadCategoryFeatureStartStop },
  loadclass: { run: runLoadClass },
  loadclassconfigurator: { run: runLoadClassConfigurator },
  loaddiff: { run: runLoadDiff },
  loadexpirenotify: { run: notifyHalted('loadexpirenotify') },
  loadextendedattributes: { run: runLoadExtendedAttributes },
  loadfilemetadata: { run: runLoadFileMetadata },
  loadnewcontentmenu: { run: runLoadNewContentMenu },
  loadnotify: { run: notifyHalted('loadnotify') },
  loadquickedit: { run: runLoadQuickEdit },
  loadrelatedcontent: { run: runLoadRelatedContent },
  loadselectedrelatedcontent: { run: runLoadSelectedRelatedContent },
  loadsiteflat: { run: runLoadSiteFlat },
  loadsitemanager: { run: runLoadSiteManager },
  loadsitesection: { run: runSiteSection(false) },
  loadtagarray: { run: runLoadTagArray },
  lockfile: { run: runLockFile, csrfContext: contentIdContext('lockfile') },
  refreshsitesection: { run: runSiteSection(true) },
  savecopyinfo: { run: runSaveCopyInfo },
  savequickedit: { run: runSaveQuickEdit, csrfContext: contentIdContext('quickedit') },
  sitemanagertab: { run: runSiteManagerTab },
  siteparents: { run: runSiteParents },
  statusmodal: { run: runStatusModal },
  unlockfile: { run: runUnlock(unlockFile), csrfContext: contentIdContext('unlockfile') },
  unlocknode: { run: runUnlock(unlockNode), csrfContext: contentIdContext('unlocknode') },
  update: { run: runUpdate },
};
