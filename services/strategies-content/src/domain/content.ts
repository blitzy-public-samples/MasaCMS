/**
 * Content version writes: contentManager.add, delete, deleteHistAll, deleteAll and multiFileUpload, contentUtility.copy,
 * and the carch.update, saveQuickEdit and updateObjectParams controllers, with the JSON API content save and delete.
 */
import {
  LEGACY_ADMIN_SENTINEL_ID,
  LegacyApiError,
  cfEq,
  cfIsBoolean,
  cfIsDateText,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfLsIsDate,
  cfLsParseDateTime,
  cfNumberString,
  cfParseDateTimeText,
  cfToBoolean,
  cfDateTimeFormat,
  cfToNumber,
  cfUuid,
  esapiUrlEncode,
  isCfUuid,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import type { StoragePort } from '@opt2/platform/storage';
import { poolTenantFor, type TenantTx } from '@opt2/platform/tenancy';
import { contentImageUrl, contentUrl, formatFilename, getUrlStem, isCfUrl, materializedPath, uniqueFilename, uniqueTitle, uniqueUrlTitle } from '../legacy/content-urls.js';
import type { CategoryAssignmentRow, ContentVersionRow, Crumb } from '../repo/content-queries.js';
import type { CategoryAssignmentInput, ContentObjectInput, ContentTagInput, ExtendDataInput, RelatedItemInput, VersionInput } from '../repo/repository.js';
import type { CategoryRow, ContentRow, ExtendAttributeRow } from '../repo/tables.js';
import { PENDING_STATUS, cancelRequest, loadRequest, requiresApproval, saveRequest, type ApprovalMemberships, type ApprovalRequestValues } from './approval-requests.js';
import { listPoolCategories, keepCategories, setCategoryAssignments } from './categories.js';
import { newChangesetBean, readChangesetInTx, saveChangesetInTx } from './changeset-store.js';
import { writeContextFor, type Actor, type DomainDeps, type LegacyErrors, type MailNotice, type SiteContentSettings } from './context.js';
import {
  deleteAllFiles,
  deleteFileVersion,
  deleteIfNotUsed,
  requestHasRestrictedFiles,
  saveFileMetaData,
  setFileContentId,
  storeUploadedFile,
  type FileMetaDataValues,
  type UploadedFile,
} from './files.js';
import { allowContentAction, getNodePerm, loadMemberships } from './permissions.js';
import { UnregisteredTenantError } from './pools.js';
import { StartupPredicateViolationError, applyFileBody, assertStartupSafe } from './startup-guard.js';
import { createTrashCounter, deleteMarkerAssignments, deleteMarkers, deletedParentId, takeOut, throwIn, trashObjectSubType, trashObjectType, type DeleteMarkers, type TrashRequestCounter } from './trash.js';
import { WddxDate, WddxNumber, cfStruct, wddxNumber, type WddxQuery, type WddxStruct, type WddxValue } from './wddx.js';
import { getCrumbList } from './content-tree.js';

export * from './content-tree.js';

const HOME_ID = LEGACY_ADMIN_SENTINEL_ID;
const SITE_TREE_MODULE_ID = '00000000000000000000000000000000000';
/** contentManager `ValidContentTypeList`; Portal is checked before its Folder rename, so it fails as legacy fails it. */
const VALID_CONTENT_TYPES = ['page', 'folder', 'calendar', 'link', 'file', 'gallery', 'component', 'form', 'variation'];
/** contentManager `TreeLevelList`. */
const TREE_LEVEL_TYPES = ['page', 'folder', 'calendar', 'link', 'file', 'gallery'];
/** contentManager `ExtendableList`. */
const EXTENDABLE_TYPES = [...TREE_LEVEL_TYPES, 'component', 'form'];
/** contentBean.setType's accepted types. */
const SETTABLE_TYPES = ['page', 'folder', 'calendar', 'gallery', 'file', 'link', 'form', 'component', 'variation', 'module'];
/** Types whose titles contentManager.add derives from the title. */
const TITLE_DERIVED_TYPES = ['variation', 'component', 'form', 'module'];
/** contentUtility.move's types. */
const MOVE_TYPES = ['Page', 'Calendar', 'Folder', 'Gallery', 'Link', 'File'];
/** contentUtility.movelink's types. */
const MOVELINK_TYPES = ['Page', 'Calendar', 'Folder', 'Component', 'Form', 'Gallery', 'Link', 'File'];
/** contentUtility.copy keeps filenames unique for these types and titles for the others. */
const FILENAME_COPY_TYPES = ['page', 'folder', 'gallery', 'calendar', 'link', 'file'];
/** Types whose approved versions archive their filename (contentManager.cfc:1661). */
const ARCHIVED_FILENAME_TYPES = ['file', 'link', 'page', 'folder', 'gallery', 'calendar'];
/** extendManager's types without `Base` set inheritance. */
const NO_BASE_EXTEND_TYPES = ['1', '2', 'user', 'group', 'address', 'site', 'component', 'form'];
/** The module and default parent contentBean.setType gives these types. */
const TYPE_MODULES: Readonly<Record<string, string>> = Object.freeze({
  form: '00000000000000000000000000000000004',
  component: '00000000000000000000000000000000003',
  variation: '00000000000000000000000000000000099',
});
/** settingsBean `columnCount` default. */
const DEFAULT_COLUMN_COUNT = 3;

/**
 * reminderManager.updateReminders and deleteReminders (contentManager.cfc:1261-1267) are not run: `tcontenteventreminders`
 * is a decision-list table with no target table, so a branch reaching them stays on legacy when withheld and shows as a
 * parity difference otherwise.
 */
export const REMINDER_UPDATES_UNBUILT = ['reminderManager.updateReminders', 'reminderManager.deleteReminders'] as const;

/** contentUtility.sendNotices' `tredirects` inserts are not run: identity owns `tredirects`, so the mail links name redirect ids no row holds. */
export const NOTIFY_REDIRECTS_UNBUILT = ['tredirects'] as const;

/** contentUtility.copy's `tpermissions` copy is not run: identity owns node permissions, so a copied node starts without its source's grants. */
export const COPY_PERMISSIONS_UNBUILT = ['tpermissions'] as const;

/** English resource-bundle values of the keys content saves report. */
const RB_EN: Readonly<Record<string, string>> = Object.freeze({
  'sitemanager.titlenotunique': "The 'Title' that you entered is already in use.",
  'sitemanager.displayconflict': 'Scheduling Conflict',
  'sitemanager.filemissing': "You must select a file when creating a new 'File' content type.",
  'sitemanager.content.filenamesiteidconflict': '"The filename associated with this content node conflicts with a siteid."',
  'sitemanager.requesthasrestrictedfiles': 'The posted request contained restricted file types',
  'params.errordate': '{1} must be a valid date.',
  'params.errornumeric': '{1} must be numeric.',
  'params.erroremail': '{1} must be a valid email.',
  'sitemanager.content.draft': 'Draft',
  'sitemanager.content.published': 'Published',
  'sitemanager.content.archived': 'Archived',
  'sitemanager.content.pending': 'Pending Approval',
  'sitemanager.content.rejected': 'Rejected',
  'sitemanager.content.canceled': 'Canceled',
  'sitemanager.content.approved': 'Approved',
});

/** A CFML simple value as the bean stores it. */
type CfSimple = string | number | boolean | Date;

/**
 * contentManager.add's `data` and carch's `rc`: the contentBean fields (contentBean.cfc:80-169) and request fields,
 * keyed as legacy keys them; key case is ignored, as CFML structs ignore it.
 */
export interface ContentInput {
  siteid?: string;
  contentid?: string;
  contenthistid?: string;
  parentid?: string;
  type?: string;
  subtype?: string;
  title?: string;
  menutitle?: string;
  urltitle?: string;
  htmltitle?: string;
  filename?: string;
  body?: string;
  summary?: string;
  display?: number | string;
  displaystart?: Date | string;
  displaystop?: Date | string;
  displayinterval?: unknown;
  isnav?: number | string;
  approved?: number | string | boolean;
  changesetid?: string;
  changesetname?: string;
  removepreviouschangeset?: boolean | string;
  cancelpendingapproval?: boolean | string;
  approvalchainoverride?: boolean | string;
  moduleid?: string;
  orderno?: number | string;
  toporbottom?: string;
  mode?: string;
  remoteid?: string;
  remotepubdate?: Date | string;
  /** Non-empty when the request posts a `newfile` part; the part itself travels in the save options' `files`. */
  newfile?: string;
  deletefile?: string;
  extendsetid?: string;
  categoryid?: string;
  relatedcontentid?: string;
  relatedcontentsetdata?: unknown;
  tags?: string;
  expiresnotify?: string;
  notify?: string;
  message?: string;
  objectparams?: unknown;
  filemetadataassign?: unknown;
  unlocknodewithpublish?: boolean | string;
  unlockfilewithnew?: boolean | string;
  versiontype?: string;
  muraurlreset?: string;
  [key: string]: unknown;
}

/** Collaborators of a content write; `storage` is needed only by saves that store an upload. */
export type ContentDeps = DomainDeps & { storage?: StoragePort };

/** Site values a content save reads beyond `SiteContentSettings`. */
export interface ContentSaveSite extends SiteContentSettings {
  /** settingsBean `columnCount`, default 3. */
  columnCount?: number;
  /** settingsBean `customTagGroups`, a `^`/`,` list. */
  customTagGroups?: string;
}

/** The legacy session user a content notification is addressed to, as identity resolves it. */
export interface NotifyRecipient {
  userId: string;
  email: string;
}

/** What sendNotices reads from identity, the request and configBean; the caller resolves it. */
export interface NotifyContext {
  /** `tusers` rows of the `notify` list, in lookup order. */
  recipients: readonly NotifyRecipient[];
  /** The session user's name and email (`rsemail`). */
  sender: { fname: string; lname: string; email: string };
  /** `listFirst(cgi.http_host, ":")`. */
  host: string;
  /** configBean `getNotifyWithVersionLink()`. */
  withVersionLink: boolean;
}

/** Options of a content save. */
export interface SaveContentOptions {
  /** The request's posted file parts (`newfile`, extend File attributes). */
  files?: readonly UploadedFile[];
  /** configBean `manageLinks`, legacy default true. */
  manageLinks?: boolean;
  /** configBean `saveEmptyExtendedValues`, legacy default true. */
  saveEmptyExtendedValues?: boolean;
  /** The ids of every registered site, for the filename/siteid conflict check. */
  siteIds?: readonly string[];
  /** The site renderer's resolved `siteIDInURLS`; defaults to the site URL settings. */
  siteIdInUrls?: boolean;
  /** Resource-bundle lookup of the site; English values when absent. */
  rbKey?: (key: string) => string;
  /** contentIntervalManager.findConflicts for a calendar that detects conflicts; without it such saves fail as unsupported. */
  findDisplayConflicts?: (bean: LegacyContentBean) => Promise<boolean>;
  notify?: NotifyContext;
  /** The actor's member group ids, read before the transaction; loaded when absent. */
  memberships?: ApprovalMemberships;
  /** Category-pool categories, read before the transaction; loaded when absent. */
  poolCategories?: readonly Pick<CategoryRow, 'categoryid'>[];
  /** contentBean `approvingChainRequest`, set by approval-chain activation. */
  approvingChainRequest?: boolean;
  requestId?: string;
}

/** contentManager.add's outcome: the saved (or refused, or invalid) bean, its errors and the mail it would send. */
export interface SaveContentResult {
  bean: LegacyContentBean;
  errors: LegacyErrors;
  notices: MailNotice[];
  refused: boolean;
  /** Every `content.content` row the save inserted or updated. */
  written: ContentRow[];
  /** An error legacy raises after its transaction committed: the caller commits the save's writes, then raises it. */
  afterCommitError?: Error;
}

// No JSON API catch block names `custom`, so legacy answers these with the 500 `server_error` envelope, not `invalidParameters`.
/** A required-data failure of contentManager.add (`cfthrow type="custom"`), answered with the legacy 500 on every surface. */
export class ContentSaveDataError extends Error {
  override readonly name: string = 'ContentSaveDataError';
}

/** A calendar save whose conflict detection the caller did not supply. */
export class DisplayConflictsUnsupportedError extends Error {
  override readonly name: string = 'DisplayConflictsUnsupportedError';

  constructor(readonly calendarId: string) {
    super(`Calendar ${calendarId} detects display conflicts, which needs contentIntervalManager.findConflicts`);
  }
}

/** ACF's error for a dereferenced key that legacy never set, raised after the writes before it committed. */
export class UndefinedLegacyElementError extends Error {
  override readonly name: string = 'UndefinedLegacyElementError';
}

/** Carries an error legacy raises once its writes are committed out of the steps that follow it. */
class ErrorAfterWrites extends Error {
  override readonly name: string = 'ErrorAfterWrites';

  constructor(readonly error: Error) {
    super(error.message);
  }
}

// ---- CFML value helpers ----

/** CF `trim`: drops leading and trailing characters at or below U+0020. */
function cfTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/** The text CFML gives a simple value; complex and missing values read as ''. */
function cfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}`;
  return '';
}

function isSimple(value: unknown): value is CfSimple {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date;
}

/** CFML `isBoolean(x) and x`. */
function cfBool(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** CFML numeric value of `value`, NaN when it is not numeric. */
function cfNum(value: unknown): number {
  return cfIsNumeric(value) ? cfToNumber(value) : Number.NaN;
}

/** CFML `listFindNoCase` over a lower-case list. */
function inList(list: readonly string[], value: string): boolean {
  return list.includes(value.toLowerCase());
}

/** SQL Server's equality key of an id or text: trailing spaces dropped, case ignored. */
function sqlKey(value: string | null | undefined): string {
  return (value ?? '').replace(/ +$/u, '').toLowerCase();
}

/** CFML `left(value, n)`. */
function left(value: string, n: number): string {
  return value.slice(0, Math.max(n, 0));
}

/** CFML `isJSON`. */
function isJson(value: unknown): value is string {
  if (typeof value !== 'string' || cfTrim(value) === '') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Case-insensitive member of a deserialized struct. */
function member(struct: Readonly<Record<string, unknown>>, key: string): unknown {
  const wanted = key.toLowerCase();
  const found = Object.keys(struct).find((name) => name.toLowerCase() === wanted);
  return found === undefined ? undefined : struct[found];
}

/** bean.parseDateArg (bean.cfc:278-301): a date, the unparsable text, or '' for a non-date. */
function parseDateArg(value: unknown): Date | string {
  if (value instanceof Date) return value;
  let text = cfText(value);
  if (/\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/u.test(text)) text = text.replace('T', ' ');
  if (!/\d\d\d\d-\d\d-\d\d\s\d\d:\d\d:\d\d/u.test(text) && cfLsIsDate(text)) {
    try {
      return cfLsParseDateTime(text);
    } catch {
      return text;
    }
  }
  if (cfIsDateText(text)) {
    try {
      return cfParseDateTimeText(text);
    } catch {
      return text;
    }
  }
  return '';
}

/** CFML `isDate` of a bean value. */
function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = cfText(value);
  return text !== '' && cfIsDateText(text) ? cfParseDateTimeText(text) : null;
}

/** CFML `createDateTime(year, month, day, hour, minute, 0)` of `day`; an hour or minute out of range fails as ACF does. */
function createDateTime(day: Date, hour: unknown, minute: unknown): Date {
  const h = cfNum(hour);
  const n = cfNum(minute);
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(n) || n < 0 || n > 59) {
    throw new Error(`Invalid time ${cfText(hour)}:${cfText(minute)} for createDateTime.`);
  }
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, n, 0, 0);
}

/** contentBean.set's hour of a date part: `PM` adds 12 (24 becomes 12), `AM` turns 12 into 0. */
function dayPartHour(hour: unknown, dayPart: unknown): unknown {
  if (cfEq(cfText(dayPart), 'PM')) {
    const pm = cfNum(hour) + 12;
    return pm === 24 ? 12 : pm;
  }
  if (cfEq(cfText(dayPart), 'AM')) return cfNum(hour) === 12 ? 0 : hour;
  return hour;
}

/** ACF `JSStringFormat`. */
function jsStringFormat(value: string): string {
  return value.replace(/[\\'"\n\r\t\b\f]/gu, (ch) => {
    switch (ch) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      default:
        return `\\${ch}`;
    }
  });
}

/** CFML `urlDecode`; a malformed escape fails as ACF fails it. */
function safeUrlDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/gu, ' '));
}

/** utility.textPreview (utility.cfc:981-1017): tags stripped, cut at `[break]` or after the first sentence end past `maxlen`. */
function textPreview(value: string, maxlen = 100): string {
  const text = value.replace(/<[^>]*>/gu, '');
  const breakAt = text.indexOf('[break]');
  if (breakAt >= 0) return text.slice(0, breakAt);
  const finishSymbols = ['.', '?', '!'];
  if (finishSymbols.includes(text.charAt(maxlen - 2))) return text.slice(0, maxlen);
  let finish = text.length;
  for (const symbol of finishSymbols) {
    const at = text.slice(maxlen - 1).search(new RegExp(`[${symbol}][\\s<]`, 'u'));
    const position = at < 0 ? 0 : at + maxlen;
    if (position > 0 && position < finish) finish = position;
  }
  return text.slice(0, finish);
}

// ---- contentBean ----

type InstanceEntry = { key: string; value: unknown };

/** One contentBean instance: values under case-insensitive keys in their first casing, as `variables.instance` holds them. */
export class LegacyContentBean {
  private readonly instance = new Map<string, InstanceEntry>();
  /** The `now()` of the request that made the bean. */
  private now: Date = new Date(0);

  /** contentBean.init over bean.cfc and beanExtendable.cfc init: the defaults and, for a logged-in actor, the audit name. */
  static init(actor: Actor, now: Date): LegacyContentBean {
    const bean = new LegacyContentBean();
    bean.now = now;
    const assign = (entries: ReadonlyArray<readonly [string, unknown]>): void => {
      for (const [key, value] of entries) bean.put(key, value);
    };
    assign([
      ['isNew', 1], ['errors', {}], ['fromMuraCache', false], ['instanceID', cfUuid()], ['addObjects', []], ['removeObjects', []],
      ['extendData', ''], ['extendSetID', ''], ['extendDataTable', 'tclassextenddata'], ['extendAutoComplete', true],
      ['frommuracache', false], ['type', 'Custom'], ['subType', 'Default'], ['siteiD', ''], ['sourceIterator', ''],
      ['ContentHistID', ''], ['Contentid', ''], ['Active', 0], ['OrderNo', 1], ['MetaDesc', ''], ['MetaKeyWords', ''], ['Approved', 0],
      ['DisplayStart', ''], ['Displaystop', ''], ['Body', ''], ['Title', ''], ['MenuTitle', ''], ['URLTitle', ''], ['HTMLTitle', ''],
      ['Filename', ''], ['OldFilename', ''], ['LastUpdate', now], ['Display', 1], ['ParentID', ''], ['newFile', ''], ['type', 'Page'],
      ['subType', 'Default'],
    ]);
    assign(
      actor.isLoggedIn
        ? [['LastUpdateBy', left(actor.fullName, 50)], ['LastUpdateByID', actor.userId]]
        : [['LastUpdateBy', ''], ['LastUpdateByID', '']],
    );
    assign([
      ['Summary', ''], ['SiteID', ''], ['ModuleID', SITE_TREE_MODULE_ID], ['IsNav', 1], ['Restricted', 0], ['Target', '_self'],
      ['RestrictGroups', ''], ['Template', ''], ['childTemplate', ''], ['ResponseMessage', ''], ['ResponseChart', 0], ['ResponseSendTo', ''],
      ['ResponseDisplayFields', ''], ['ModuleAssign', ''], ['notes', ''], ['inheritObjects', 'Inherit'], ['isFeature', 0], ['isNew', 1],
      ['releaseDate', ''], ['targetParams', ''], ['IsLocked', 0], ['nextN', 10], ['sortBy', 'orderno'], ['sortDirection', 'asc'],
      ['FeatureStart', ''], ['FeatureStop', ''], ['FileID', ''], ['FileSize', 0], ['FileExt', ''], ['ContentType', ''], ['ContentSubType', ''],
      ['forceSSL', 0], ['remoteURL', ''], ['remoteID', ''], ['remotePubDate', ''], ['remoteSource', ''], ['remoteSourceURL', ''],
      ['credits', ''], ['audience', ''], ['keyPoints', ''], ['searchExclude', 0], ['displayTitle', 1], ['Path', ''], ['tags', ''],
      ['doCache', 1], ['created', now], ['mobileExclude', 0], ['changesetID', ''], ['tcontent_id', 0], ['imageSize', 'small'],
      ['imageHeight', 'AUTO'], ['imageWidth', 'AUTO'], ['majorVersion', 0], ['minorVersion', 0], ['expires', ''], ['assocFilename', ''],
      ['displayInterval', 'Daily'], ['errors', {}], ['categoryID', ''], ['requestID', ''], ['approvalStatus', ''], ['approvalGroupID', ''],
      ['approvalChainOverride', false], ['approvingChainRequest', false], ['relatedContentSetData', ''], ['objectParams', {}],
    ]);
    return bean;
  }

  /** contentDAO's bean of a stored version: `set(rs)` over the init values, then `isNew` 0 and `preserveID`. */
  static fromVersion(row: ContentVersionRow, actor: Actor, now: Date): LegacyContentBean {
    const bean = LegacyContentBean.init(actor, now);
    for (const [column, value] of Object.entries(row)) {
      bean.setValue(column, value ?? '');
    }
    bean.isNew = 0;
    bean.put('preserveID', bean.text('contenthistid'));
    return bean;
  }

  /** contentDAO's bean when no version matched: active, of the site. */
  static notFound(actor: Actor, now: Date, siteId: string): LegacyContentBean {
    const bean = LegacyContentBean.init(actor, now);
    bean.isNew = 1;
    bean.put('active', 1);
    bean.put('siteid', siteId);
    return bean;
  }

  get isNew(): 0 | 1 {
    return cfNum(this.raw('isnew')) === 0 ? 0 : 1;
  }

  set isNew(value: 0 | 1) {
    this.put('isNew', value);
  }

  /** The bean's `errors` struct. */
  get errors(): LegacyErrors {
    const errors = this.raw('errors');
    if (isPlainObject(errors)) return errors as LegacyErrors;
    const fresh: LegacyErrors = {};
    this.put('errors', fresh);
    return fresh;
  }

  set errors(value: LegacyErrors) {
    this.put('errors', value);
  }

  has(key: string): boolean {
    return this.instance.has(key.toLowerCase());
  }

  /** `variables.instance[key]`, undefined when unset. */
  raw(key: string): unknown {
    return this.instance.get(key.toLowerCase())?.value;
  }

  /** `variables.instance[key] = value`: the first casing of a key is kept. */
  put(key: string, value: unknown): void {
    const lower = key.toLowerCase();
    const entry = this.instance.get(lower);
    if (entry === undefined) this.instance.set(lower, { key, value });
    else entry.value = value;
  }

  delete(key: string): void {
    this.instance.delete(key.toLowerCase());
  }

  /** contentBean.getContentID: creates the id on first read of an empty one. */
  contentId(): string {
    if (this.text('contentid') === '') this.put('contentid', cfUuid());
    return this.text('contentid');
  }

  /** contentBean.getContentHistID: creates the id on first read of an empty one. */
  contentHistId(): string {
    if (this.text('contenthistid') === '') this.put('contenthistid', cfUuid());
    return this.text('contenthistid');
  }

  /** bean.getValue with contentBean's getters. */
  get(key: string): unknown {
    const lower = key.toLowerCase();
    switch (lower) {
      case 'contentid':
        return this.contentId();
      case 'contenthistid':
        return this.contentHistId();
      case 'imagesize':
        return cfEq(this.rawText('imagesize'), 'Custom') && cfEq(this.rawText('imageheight'), 'AUTO') && cfEq(this.rawText('imagewidth'), 'AUTO')
          ? 'small'
          : this.raw('imagesize');
      case 'imageheight':
      case 'imagewidth':
        return cfEq(this.rawText('imagesize'), 'Custom') ? this.raw(lower) : 'AUTO';
      case 'htmltitle':
        return this.rawText('htmltitle') !== '' ? this.raw('htmltitle') : this.raw('menutitle');
      case 'metakeywords':
        return isCfUrl(this.rawText('metakeywords')) ? '' : this.raw('metakeywords');
      case 'canonicalurl':
        return isCfUrl(this.rawText('metakeywords')) ? this.raw('metakeywords') : '';
      case 'initjs':
        return this.raw('responsemessage');
      case 'ishome':
        return this.rawText('parentid').slice(-3).toLowerCase() === 'end';
      case 'depth':
        return cfListToArray(this.rawText('path')).length - 1;
      default:
        return this.raw(lower) ?? '';
    }
  }

  /** The CF text of `variables.instance[key]`. */
  private rawText(key: string): string {
    return cfText(this.raw(key));
  }

  /** The CF text of `get(key)`. */
  text(key: string): string {
    const lower = key.toLowerCase();
    return cfText(lower === 'contentid' || lower === 'contenthistid' ? this.raw(lower) : this.get(lower));
  }

  /** The CF number of `get(key)`, NaN when not numeric. */
  number(key: string): number {
    return cfNum(this.get(key));
  }

  /** bean.setValue with contentBean's setters (contentBean.cfc:568-1320). */
  setValue(key: string, value: unknown): void {
    const lower = key.toLowerCase();
    switch (lower) {
      case 'displaystart':
      case 'displaystop':
      case 'expires':
      case 'lastupdate':
      case 'releasedate':
      case 'featurestop':
      case 'featurestart':
      case 'remotepubdate':
      case 'created':
        this.put(key, parseDateArg(value));
        return;
      case 'type':
        this.setType(cfText(value));
        return;
      case 'title': {
        const title = cfTrim(cfText(value));
        if (title !== '') this.put(key, title);
        return;
      }
      case 'filename':
        this.put(key, left(cfText(value), 255));
        return;
      case 'lastupdateby':
        this.put(key, left(cfTrim(cfText(value)), 50));
        return;
      case 'nextn':
      case 'displaytitle':
      case 'majorversion':
      case 'minorversion':
      case 'docache':
      case 'mobileexclude':
      case 'imageheight':
      case 'imagewidth':
        if (cfIsNumeric(value)) this.put(key, value);
        return;
      case 'imagesize':
      case 'target':
        if (cfText(value) !== '') this.put(key, value);
        return;
      case 'initjs':
        this.put('responseMessage', value);
        return;
      case 'displaylist':
        this.put('responseDisplayFields', value);
        return;
      case 'displayinterval':
        this.setDisplayInterval(value);
        return;
      case 'body':
        this.setBody(value);
        return;
      case 'assocurl':
        if (cfEq(this.text('type'), 'Link')) this.put('body', value);
        return;
      case 'objectparams':
        this.setObjectParams(value);
        return;
      case 'canonicalurl':
        if (isCfUrl(cfText(value)) || cfText(value) === '') this.put('metakeywords', value);
        return;
      case 'isnew':
        this.put(key, value);
        return;
      default:
        this.put(key, typeof value === 'string' ? cfTrim(value) : value);
    }
  }

  /** contentBean.setType: a listed type other than the current one; Form, Component and Variation fix their module and default parent. */
  private setType(type: string): void {
    const trimmed = cfTrim(cfEq(type, 'Portal') ? 'Folder' : type);
    if (trimmed === '' || cfEq(this.text('type'), trimmed) || !inList(SETTABLE_TYPES, trimmed)) return;
    this.put('type', trimmed);
    const module = TYPE_MODULES[trimmed.toLowerCase()];
    if (module !== undefined) {
      this.put('moduleID', module);
      if (!isCfUuid(this.text('parentid'))) this.put('ParentID', module);
    }
  }

  /** contentBean.setBody: a Variation body is JSON, URL-decoded when needed, else `[]`. */
  private setBody(value: unknown): void {
    let body = value;
    if (cfEq(this.text('type'), 'Variation')) {
      if (!isSimple(body)) body = JSON.stringify(body);
      if (!isJson(body)) {
        const decoded = safeUrlDecode(cfText(body));
        body = isJson(decoded) ? decoded : '[]';
      }
    }
    this.put('body', body);
  }

  /** contentBean.setObjectParams: a JSON struct is parsed, a complex value stored, anything else ignored. */
  private setObjectParams(value: unknown): void {
    if (typeof value === 'string' && value !== '' && isJson(value)) {
      const parsed: unknown = JSON.parse(value);
      if (isPlainObject(parsed)) this.put('objectParams', parsed);
    } else if (!isSimple(value) && value !== null && value !== undefined) {
      this.put('objectParams', value);
    }
  }

  /** contentBean.setDisplayInterval: a JSON or complex interval moves `displayStop` to its end, then is stored serialized. */
  private setDisplayInterval(value: unknown): void {
    let interval: unknown = isJson(value) ? JSON.parse(value) : value;
    if (isPlainObject(interval)) {
      const settings: Record<string, unknown> = { ...interval };
      const endOnKey = Object.keys(settings).find((name) => name.toLowerCase() === 'endon');
      if (endOnKey !== undefined) settings[endOnKey] = parseDateArg(settings[endOnKey]);
      const end = cfText(member(settings, 'end'));
      const endOn = asDate(member(settings, 'endon'));
      if (member(settings, 'end') !== undefined) {
        const stop = asDate(this.raw('displaystop'));
        if (cfEq(end, 'on') && endOn !== null) {
          if (stop === null) this.setValue('displayStop', endOn);
          else if (cfDateTimeFormat(stop, 'yyyymmdd') !== cfDateTimeFormat(endOn, 'yyyymmdd')) this.setValue('displayStop', createDateTime(endOn, stop.getHours(), stop.getMinutes()));
        } else if ((cfEq(end, 'after') && cfIsNumeric(member(settings, 'endafter'))) || cfEq(end, 'never')) {
          const current = stop ?? this.now;
          const at = createDateTime(this.now, current.getHours(), current.getMinutes());
          this.setValue('displayStop', new Date(at.getFullYear() + 100, at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), 0, 0));
        }
        if (cfEq(end, 'on') && endOn === null) {
          const n = this.now;
          this.setValue('displayStop', new Date(n.getFullYear() + 100, n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds()));
          settings[endOnKey ?? 'endon'] = 'never';
        }
      }
      interval = JSON.stringify(settings, (_key, item: unknown) => (item instanceof Date ? cfText(item) : item));
    }
    this.put('displayInterval', interval);
  }

  /** contentBean.set(struct) (contentBean.cfc:294-456): every key through setValue, the date-part fields, then the session audit name; `applyStatus` follows. */
  set(data: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>, actor: Actor): this {
    const fields = data instanceof Map ? new Map(data) : new Map(Object.entries(data).map(([key, value]) => [key.toLowerCase(), value] as const));
    const given = (key: string): boolean => fields.get(key) !== undefined && fields.get(key) !== null;
    for (const [key, value] of data instanceof Map ? data : Object.entries(data)) {
      this.setValue(key, value);
    }
    const timed = (field: string, prefix: string): void => {
      const day = asDate(this.raw(field));
      if (day !== null && given(`${prefix}hour`) && given(`${prefix}minute`)) {
        const hour = dayPartHour(fields.get(`${prefix}hour`), given(`${prefix}daypart`) ? fields.get(`${prefix}daypart`) : '');
        this.setValue(field, createDateTime(day, hour, fields.get(`${prefix}minute`)));
      }
    };
    if (this.number('display') === 2 && asDate(this.raw('displaystart')) !== null) {
      timed('displayStart', 'start');
    } else if (this.number('display') === 2) {
      this.put('display', 1);
      this.put('displayStart', '');
      this.put('displayStop', '');
    }
    if (this.number('display') === 2) timed('displayStop', 'stop');
    if (this.number('isfeature') === 2) {
      timed('featureStart', 'featurestart');
      timed('featureStop', 'featurestop');
    }
    timed('releaseDate', 'release');
    timed('expires', 'expires');
    if (actor.isLoggedIn) {
      this.put('LastUpdateBy', left(actor.fullName, 50));
      this.put('LastUpdateByID', actor.userId);
    }
    return this;
  }

  /** The instance values keyed by lower-case name, as `getAllValues()` hands them to contentManager.add. */
  values(): Map<string, unknown> {
    return new Map([...this.instance].map(([lower, entry]) => [lower, entry.value] as const));
  }

  /** The instance entries in their first casing. */
  entries(): Array<[string, unknown]> {
    return [...this.instance.values()].map((entry) => [entry.key, entry.value]);
  }

  /** contentDAO.create's bound values (contentDAO.cfc:565-735); the repository applies its NULL, trim and minute rules. */
  toVersionInput(): VersionInput {
    const n = (key: string): number => {
      const value = this.get(key);
      if (typeof value === 'boolean') return value ? 1 : 0;
      const number = cfNum(value);
      if (Number.isNaN(number)) throw new Error(`Invalid data ${cfText(value)} for CFSQLTYPE CF_SQL_NUMERIC.`);
      return number;
    };
    const t = (key: string): string => this.text(key);
    const d = (key: string): Date | null => asDate(this.raw(key));
    const objectParams = this.raw('objectparams');
    return {
      contenthistid: this.contentHistId(),
      contentid: this.contentId(),
      active: n('active'),
      orderno: n('orderno'),
      approved: n('approved'),
      displaystart: d('displaystart'),
      displaystop: d('displaystop'),
      metadesc: t('metadesc'),
      metakeywords: cfText(this.raw('metakeywords')),
      body: t('body'),
      summary: t('summary'),
      path: t('path'),
      tags: t('tags'),
      responsemessage: t('responsemessage'),
      responsedisplayfields: t('responsedisplayfields'),
      title: cfTrim(t('title')),
      menutitle: t('menutitle'),
      filename: t('filename'),
      display: n('display'),
      parentid: cfTrim(t('parentid')),
      type: t('type'),
      subtype: t('subtype'),
      lastupdateby: cfTrim(t('lastupdateby')),
      lastupdatebyid: cfTrim(t('lastupdatebyid')),
      siteid: t('siteid'),
      moduleid: t('moduleid'),
      isnav: n('isnav'),
      restricted: n('restricted'),
      target: t('target'),
      restrictgroups: t('restrictgroups'),
      template: t('template'),
      responsechart: n('responsechart'),
      responsesendto: t('responsesendto'),
      moduleassign: t('moduleassign'),
      notes: t('notes'),
      inheritobjects: t('inheritobjects'),
      isfeature: n('isfeature'),
      releasedate: d('releasedate'),
      targetparams: t('targetparams'),
      islocked: n('islocked'),
      nextn: n('nextn'),
      sortby: t('sortby'),
      sortdirection: t('sortdirection'),
      featurestart: d('featurestart'),
      featurestop: d('featurestop'),
      fileid: t('fileid'),
      forcessl: n('forcessl'),
      remoteid: t('remoteid'),
      remoteurl: t('remoteurl'),
      remotepubdate: cfText(this.raw('remotepubdate')),
      remotesource: t('remotesource'),
      remotesourceurl: t('remotesourceurl'),
      credits: t('credits'),
      audience: t('audience'),
      keypoints: t('keypoints'),
      searchexclude: n('searchexclude'),
      displaytitle: n('displaytitle'),
      docache: n('docache'),
      created: d('created'),
      urltitle: t('urltitle'),
      htmltitle: t('htmltitle'),
      mobileexclude: n('mobileexclude'),
      changesetid: t('changesetid'),
      imagesize: t('imagesize'),
      imageheight: t('imageheight'),
      imagewidth: t('imagewidth'),
      childtemplate: t('childtemplate'),
      majorversion: n('majorversion'),
      minorversion: n('minorversion'),
      expires: d('expires'),
      displayinterval: cfText(this.raw('displayinterval')),
      objectparams: isSimple(objectParams) ? cfText(objectParams) : JSON.stringify(objectParams ?? {}),
    };
  }
}

// ---- reads and scope ----

/** A content write's transaction and collaborators. */
interface WriteScope {
  tx: TenantTx;
  deps: ContentDeps;
  actor: Actor;
  site: ContentSaveSite;
  write: WriteContext;
  now: Date;
  rb: (key: string) => string;
  /** The actor's member group ids, loaded on first use when the caller did not read them before the transaction. */
  memberships: ApprovalMemberships | undefined;
}

/** The scope of a write in `tx`. */
function scopeOf(tx: TenantTx, deps: ContentDeps, actor: Actor, site: ContentSaveSite, opts: Pick<SaveContentOptions, 'rbKey' | 'requestId' | 'memberships'>): WriteScope {
  return { tx, deps, actor, site, write: writeContextFor(actor, opts.requestId), now: deps.clock.now(), rb: rbOf(opts), memberships: opts.memberships };
}

/** `session.mura.membershipids`, read once per write. */
async function membershipsOf(scope: WriteScope): Promise<ApprovalMemberships> {
  scope.memberships ??= await loadMemberships(scope.deps, scope.actor);
  return scope.memberships;
}

/** contentBean.requiresApproval, which also stores the requiring chain on the bean. */
async function beanRequiresApproval(scope: WriteScope, bean: LegacyContentBean): Promise<{ required: boolean; chainId: string }> {
  const requirement = await requiresApproval(scope.tx, scope.deps.repository, scope.actor, await crumbsOf(scope, bean), await membershipsOf(scope));
  if (requirement.required) bean.put('chainID', requirement.chainId);
  return requirement;
}

/** contentBean.set's closing assignments (contentBean.cfc:458-461): `statusid`, `status`, `ishome` and `depth`. */
async function applyStatus(scope: WriteScope, bean: LegacyContentBean): Promise<void> {
  let statusId: number;
  if (bean.number('active') > 0 && bean.number('approved') > 0) statusId = 2;
  else if (bean.text('approvalstatus') !== '' && (await beanRequiresApproval(scope, bean)).required) statusId = 1;
  else if (bean.number('approved') < 1) statusId = 0;
  else statusId = 3;
  const status = ['draft', bean.text('approvalstatus'), 'published'][statusId] ?? 'archived';
  bean.put('statusid', statusId);
  bean.put('status', scope.rb(`sitemanager.content.${status}`));
  bean.put('ishome', bean.get('ishome'));
  bean.put('depth', bean.get('depth'));
}

/** The arguments of contentManager.read a save uses: a version, an item's active version, or an active version by remote id. */
interface BeanRef {
  siteId: string;
  contentHistId?: string;
  contentId?: string;
  remoteId?: string;
}

/** The items of settingsBean `customTagGroups` (`^` and `,` delimited), trimmed. */
function tagGroups(site: ContentSaveSite): string[] {
  return (site.customTagGroups ?? '')
    .split(/[\^,]/u)
    .map(cfTrim)
    .filter((group) => group !== '');
}

/** contentManager.read inside the write's transaction (contentDAO readVersion, readActive, readActiveByRemoteID, setCustomTagGroups). */
async function readBean(scope: WriteScope, ref: BeanRef): Promise<LegacyContentBean> {
  const { tx, actor, now } = scope;
  const repo = scope.deps.repository;
  let row: ContentVersionRow | undefined;
  if ((ref.contentHistId ?? '') !== '') {
    [row] = await repo.content.readVersion(tx, { contentHistId: ref.contentHistId ?? '' });
  } else if ((ref.remoteId ?? '') !== '') {
    row = (await repo.content.readActiveByRemoteId(tx, { siteId: ref.siteId, remoteId: ref.remoteId ?? '' })).at(-1);
  } else {
    [row] = await repo.content.readActive(tx, { contentId: ref.contentId ?? '', siteId: ref.siteId });
  }
  return row === undefined ? LegacyContentBean.notFound(actor, now, ref.siteId) : beanOf(scope, row);
}

/** contentDAO's bean of a stored version: `set(rs)` with its status values, then setCustomTagGroups. */
async function beanOf(scope: WriteScope, row: ContentVersionRow): Promise<LegacyContentBean> {
  const bean = LegacyContentBean.fromVersion(row, scope.actor, scope.now);
  await applyStatus(scope, bean);
  const repo = scope.deps.repository;
  const groups = tagGroups(scope.site);
  if (groups.length > 0) {
    const tags = await repo.content.tags(scope.tx, { contentHistId: bean.contentHistId() });
    for (const group of groups) {
      bean.setValue(`${group}tags`, tags.filter((tag) => tag.taggroup === group).map((tag) => tag.tag).join(','));
    }
  }
  return bean;
}

/** contentBean.getCrumbArray: the parent's crumbs for a new bean (other than the home page), else the item's by its path. */
function crumbsOf(scope: WriteScope, bean: LegacyContentBean): Promise<Crumb[]> {
  const siteId = bean.text('siteid');
  if (bean.isNew === 1 && !cfEq(bean.text('contentid'), HOME_ID)) {
    return scope.deps.repository.content.crumbPath(scope.tx, { contentId: bean.text('parentid'), siteId });
  }
  return scope.deps.repository.content.crumbPath(scope.tx, { contentId: bean.contentId(), siteId, path: bean.text('path') });
}

/** Runs `fn` in the transaction holding the site's `content.file` rows: the write's own, or one of the file pool tenant. */
async function inFilePool<T>(scope: WriteScope, fn: (fileTx: TenantTx) => Promise<T>): Promise<T> {
  const pool = await poolTenantFor(scope.tx, scope.tx.tenantId, 'file');
  if (pool === null) throw new UnregisteredTenantError(scope.tx.tenantId);
  return pool === scope.tx.tenantId ? fn(scope.tx) : withGatedTenant(scope.deps.db, pool, fn);
}

/** fileManager.deleteIfNotUsed of each file of `fileIds` outside versions `baseIds`. */
async function deleteFilesIfNotUsed(scope: WriteScope, fileIds: readonly string[], baseIds: readonly string[]): Promise<void> {
  for (const fileId of fileIds.filter((id) => id !== '')) {
    await inFilePool(scope, (fileTx) => deleteIfNotUsed(scope.tx, scope.deps.repository, [fileId], baseIds, { fileTx, write: scope.write }));
  }
}

/** Raised by a uniqueness predicate for a candidate not looked up yet. */
class ProbeNeeded {
  constructor(readonly candidate: string) {}
}

/** Runs a pure uniqueness rule whose `exists` predicate needs database lookups, probing each new candidate and re-running. */
async function resolveUnique<T>(compute: (exists: (candidate: string) => boolean) => T, probe: (candidate: string) => Promise<boolean>): Promise<T> {
  const known = new Map<string, boolean>();
  for (;;) {
    try {
      return compute((candidate) => {
        const found = known.get(candidate);
        if (found === undefined) throw new ProbeNeeded(candidate);
        return found;
      });
    } catch (err) {
      if (!(err instanceof ProbeNeeded)) throw err;
      known.set(err.candidate, await probe(err.candidate));
    }
  }
}

/** contentUtility.doesFileExist: an active Folder, Page, Calendar, Gallery, File or Link of the site other than `contentId` has `filename`. */
async function doesFileExist(scope: WriteScope, siteId: string, filename: string, contentId: string): Promise<boolean> {
  const rows = await scope.deps.repository.content.readActiveByFilename(scope.tx, { siteId, filename });
  return rows.some((row) => sqlKey(row.contentid) !== sqlKey(contentId));
}

/** contentUtility.doesLoadKeyExist for `title` or `urltitle`: an active version of the site and module other than the bean's has `value`. */
async function doesLoadKeyExist(scope: WriteScope, bean: LegacyContentBean, field: 'title' | 'urltitle', value: string): Promise<boolean> {
  const repo = scope.deps.repository;
  const siteId = bean.text('siteid');
  const rows =
    field === 'title'
      ? await repo.content.readActiveByTitle(scope.tx, { siteId, title: value })
      : await repo.content.readActiveByUrlTitle(scope.tx, { siteId, urlTitle: value });
  return rows.some((row) => sqlKey(row.moduleid) === sqlKey(bean.text('moduleid')) && sqlKey(row.contentid) !== sqlKey(bean.contentId()));
}

/** contentUtility.setUniqueFilename (contentUtility.cfc:728-770). */
async function setUniqueFilename(scope: WriteScope, bean: LegacyContentBean): Promise<void> {
  const siteId = bean.text('siteid');
  const [parent] = await scope.deps.repository.content.readActive(scope.tx, { contentId: bean.text('parentid'), siteId });
  const contentId = bean.contentId();
  const result = await resolveUnique(
    (exists) =>
      uniqueFilename({
        urlTitle: bean.text('urltitle'),
        contentId,
        parentId: bean.text('parentid'),
        parentFilename: parent?.filename ?? '',
        exists,
        ...filenameRules(scope.site),
      }),
    (candidate) => doesFileExist(scope, siteId, candidate, contentId),
  );
  bean.setValue('filename', result.filename);
  bean.put('urltitle', result.urlTitle);
}

/** contentUtility.setUniqueURLTitle (contentUtility.cfc:772-787). */
async function setUniqueUrlTitle(scope: WriteScope, bean: LegacyContentBean): Promise<void> {
  const urlTitle = await resolveUnique(
    (exists) => uniqueUrlTitle({ urlTitle: bean.text('urltitle'), exists }),
    (candidate) => doesLoadKeyExist(scope, bean, 'urltitle', candidate),
  );
  bean.put('urltitle', urlTitle);
}

/** contentUtility.setUniqueTitle (contentUtility.cfc:789-804). */
async function setUniqueTitle(scope: WriteScope, bean: LegacyContentBean): Promise<void> {
  const title = await resolveUnique(
    (exists) => uniqueTitle({ title: bean.text('title'), exists }),
    (candidate) => doesLoadKeyExist(scope, bean, 'title', candidate),
  );
  bean.setValue('title', title);
}

/** The configBean filename settings, carried in the site URL settings. */
function filenameRules(site: ContentSaveSite): { urlTitleDelim: string; allowUnicodeInFilenames: boolean } {
  return { urlTitleDelim: site.urls.urlTitleDelim, allowUnicodeInFilenames: site.urls.allowUnicodeInFilenames };
}

/** contentUtility.formatFilename with the site's filename settings. */
function formatName(site: ContentSaveSite, value: string): string {
  return formatFilename(value, filenameRules(site));
}

// ---- extended data autocomplete ----

/** A `[mura]` tag in a default value, which only the CFML renderer's setDynamicContent evaluates. */
const DYNAMIC_CONTENT = /\[mura\]/iu;

/** extendData.convertDataToStruct's value of a stored attribute (extendData.cfc:413-428): a date attribute's date, else its text. */
function storedExtendValue(validation: string, attributeValue: string | null, dateTimeValue: Date | null): unknown {
  const text = attributeValue ?? '';
  if (['date', 'datetime'].includes(validation.toLowerCase()) && (text !== '' || dateTimeValue !== null)) {
    if (dateTimeValue !== null) return dateTimeValue;
    return cfIsDateText(text) ? cfParseDateTimeText(text) : text;
  }
  return text;
}

/**
 * beanExtendable.getAllValues' autocomplete (beanExtendable.cfc:287-299): the values stored for the bean's version, else
 * its subtype's defaults, added where the bean has none, with their extend set ids appended to `extendSetID`.
 */
async function autocompleteExtendData(scope: WriteScope, bean: LegacyContentBean): Promise<void> {
  const repo = scope.deps.repository;
  const siteId = bean.text('siteid');
  const type = bean.text('type');
  const subType = bean.text('subtype');
  const stored = (await repo.extend.extendDataDetail(scope.tx, { baseId: bean.contentHistId() })).filter(
    (row) => siteId === '' || sqlKey(row.siteid) === sqlKey(siteId),
  );
  const rows: Array<{ extendSetId: string; name: string; value: () => unknown }> = [];
  const storedSets = [...new Set(stored.map((row) => row.extendsetid ?? '').filter((id) => id !== ''))];
  const storedAttributes = new Map(
    (storedSets.length === 0 ? [] : await repo.extend.attributesForSets(scope.tx, { extendSetIds: storedSets })).map((row) => [row.attributeid, row] as const),
  );
  for (const row of stored) {
    const validation = storedAttributes.get(row.attributeid)?.validation ?? '';
    rows.push({ extendSetId: row.extendsetid ?? '', name: row.name ?? '', value: () => storedExtendValue(validation, row.attributevalue, row.datetimevalue) });
  }
  if (type !== '' && subType !== '' && siteId !== '') {
    // Query-of-queries comparisons are case-sensitive.
    const subtypes = (await repo.extend.subtypes(scope.tx, { siteId })).filter(
      (row) =>
        row.siteid === siteId &&
        (row.type === type || (!inList(NO_BASE_EXTEND_TYPES, type) && row.type === 'Base')) &&
        ((subType !== 'Default' && row.subtype === subType) || row.subtype === 'Default'),
    );
    const storedIds = new Set(stored.map((row) => row.attributeid));
    for (const subtype of subtypes) {
      for (const set of await repo.extend.setsForSubtype(scope.tx, { subTypeId: subtype.subtypeid })) {
        const attributes = (await repo.extend.attributesForSets(scope.tx, { extendSetIds: [set.extendsetid] }))
          .filter((row) => !storedIds.has(row.attributeid))
          .sort((a, b) => (a.orderno ?? 0) - (b.orderno ?? 0));
        for (const attribute of attributes) {
          rows.push({
            extendSetId: set.extendsetid,
            name: attribute.name ?? '',
            value: () => {
              const fallback = attribute.defaultvalue ?? '';
              if (DYNAMIC_CONTENT.test(fallback)) throw new Error(`The default value of extend attribute ${attribute.name ?? ''} needs the CFML renderer`);
              return fallback;
            },
          });
        }
      }
    }
  }
  if (rows.length === 0) return;
  // `extData.data[name]`: a repeated name keeps its first casing and its last value.
  const values = new Map<string, { name: string; value: unknown }>();
  for (const row of rows) {
    const value = row.value();
    const entry = values.get(row.name.toLowerCase());
    if (entry === undefined) values.set(row.name.toLowerCase(), { name: row.name, value });
    else entry.value = value;
  }
  for (const { name, value } of values.values()) {
    if (name !== '' && !bean.has(name)) bean.put(name, value);
  }
  let setIds = bean.text('extendsetid');
  for (const row of rows) {
    // listFind: case-sensitive.
    if (!cfListToArray(setIds).includes(row.extendSetId)) setIds = cfListAppend(setIds, row.extendSetId);
  }
  bean.put('extendSetID', setIds);
}

// ---- validation ----

/** The site's resource-bundle lookup, English when none was supplied. */
function rbOf(opts: SaveContentOptions): (key: string) => string {
  return opts.rbKey ?? ((key) => RB_EN[key.toLowerCase()] ?? `${key}_missing`);
}

/** Errors as an ACF struct holds them: in its iteration order for the keys assigned in `assignments` order. */
function structErrors(assignments: ReadonlyArray<readonly [string, string]>): LegacyErrors {
  const errors: LegacyErrors = {};
  for (const [key, value] of cfStruct(assignments).entries) errors[key] = cfText(value);
  return errors;
}

const EXTEND_EMAIL = /^[a-zA-Z_0-9\-'+~]+(\.[a-zA-Z_0-9\-'+~]+)*@([a-zA-Z_0-9-]+\.)+[a-zA-Z]{2,7}$/u;

/** The extend attributes of the `extendSetID` list, split by whether they are File attributes. */
async function extendAttributes(scope: WriteScope, extendSetIds: string): Promise<{ values: ExtendAttributeRow[]; files: ExtendAttributeRow[] }> {
  const ids = cfListToArray(extendSetIds);
  if (ids.length === 0) return { values: [], files: [] };
  const rows = await scope.deps.repository.extend.attributesForSets(scope.tx, { extendSetIds: ids });
  const isFile = (row: ExtendAttributeRow): boolean => sqlKey(row.type) === 'file';
  return { values: rows.filter((row) => !isFile(row)), files: rows.filter(isFile) };
}

/** The value saveExtendedData and validateExtendedData read for an attribute: `ext<id>`, else its name, else ''. */
function attributeValue(data: ReadonlyMap<string, unknown>, row: ExtendAttributeRow): string | undefined {
  const byId = data.get(`ext${row.attributeid}`);
  const byName = data.get((row.name ?? '').toLowerCase());
  if (byId === undefined && byName === undefined) return undefined;
  if (cfText(byId) !== '') return cfText(byId);
  return cfText(byName);
}

/** extendManager.validateExtendedData (extendManager.cfc:362-437) with Masa's default `stricthtml` off. */
async function validateExtendedData(scope: WriteScope, data: ReadonlyMap<string, unknown>, rb: (key: string) => string): Promise<Array<[string, string]>> {
  const errors: Array<[string, string]> = [];
  const { values } = await extendAttributes(scope, cfText(data.get('extendsetid')));
  for (const row of values) {
    const value = attributeValue(data, row);
    if (value === undefined || value === '') continue;
    const name = row.name ?? '';
    const failed = (rbKey: string): void => {
      errors.push([name, (row.message ?? '') !== '' ? (row.message ?? '') : rb(rbKey).replace('{1}', name.toUpperCase())]);
    };
    const validation = (row.validation ?? '').toLowerCase();
    if (validation === 'date' || validation === 'datetime') {
      if (!(cfLsIsDate(value) || cfIsDateText(value))) failed('params.errordate');
    } else if (validation === 'numeric') {
      if (!cfIsNumeric(value)) failed('params.errornumeric');
    } else if (validation === 'email') {
      if (!EXTEND_EMAIL.test(cfTrim(value))) failed('params.erroremail');
    }
  }
  return errors;
}

/** contentIntervalManager.findConflicts' gate: only a scheduled item under a Calendar detecting conflicts over a span is checked. */
async function hasDisplayConflicts(scope: WriteScope, bean: LegacyContentBean, opts: SaveContentOptions): Promise<boolean> {
  if (bean.number('display') !== 2) return false;
  const [calendar] = await scope.deps.repository.content.readActive(scope.tx, { contentId: bean.text('parentid'), siteId: bean.text('siteid') });
  if (calendar === undefined || !cfEq(calendar.type ?? '', 'Calendar')) return false;
  const interval = isJson(calendar.displayinterval) ? (JSON.parse(calendar.displayinterval) as unknown) : {};
  const settings = isPlainObject(interval) ? interval : {};
  const span = cfNum(member(settings, 'detectspan'));
  if (!cfBool(member(settings, 'detectconflicts')) || !(span > 0)) return false;
  if (opts.findDisplayConflicts === undefined) throw new DisplayConflictsUnsupportedError(calendar.contentid ?? '');
  return opts.findDisplayConflicts(bean);
}

/** contentBean.validate (contentBean.cfc:420-488): the validator's `title` rule, extend values, title and display conflicts, file and template rules. */
async function validateBean(scope: WriteScope, bean: LegacyContentBean, opts: SaveContentOptions): Promise<LegacyErrors> {
  const rb = rbOf(opts);
  if (bean.text('siteid') !== '') await autocompleteExtendData(scope, bean);
  const extErrors = bean.text('siteid') !== '' ? await validateExtendedData(scope, bean.values(), rb) : [];
  const errors: Array<[string, string]> = [];
  if (bean.text('title') === '') errors.push(['title', "The property named 'title' is not valid"]);
  errors.push(...extErrors);
  const type = bean.text('type');
  if (inList(['form', 'component'], type) && (await doesLoadKeyExist(scope, bean, 'title', bean.text('title')))) {
    errors.push(['titleconflict', rb('sitemanager.titlenotunique')]);
  }
  if (bean.number('display') === 2 && (await hasDisplayConflicts(scope, bean, opts))) {
    errors.push(['displayconflict', rb('sitemanager.displayconflict')]);
  }
  if (bean.isNew === 1 && cfEq(type, 'File') && bean.text('newfile') === '' && bean.text('fileid') === '') {
    errors.push(['filemissing', rb('sitemanager.filemissing')]);
  }
  if (cfListToArray(bean.text('template').replaceAll('\\', '/'), '/').length > 1) errors.push(['template', 'invalid template']);
  const siteIdInUrls = opts.siteIdInUrls ?? scope.site.urls.siteIdInUrls;
  if (!siteIdInUrls && cfEq(bean.text('parentid'), HOME_ID)) {
    const firstEntry = formatName(scope.site, bean.text('urltitle')).toLowerCase();
    if ((opts.siteIds ?? []).some((siteId) => siteId.toLowerCase() === firstEntry)) {
      errors.push(['filename', rb('sitemanager.content.filenamesiteidconflict')]);
    }
  }
  const result = structErrors(errors);
  bean.errors = result;
  return result;
}

// ---- contentManager.add ----

type Data = Map<string, unknown>;

/** The save's data with keys lower-cased; a bean hands over its instance values (`getAllValues()`). */
function dataOf(input: ContentInput | LegacyContentBean | ReadonlyMap<string, unknown>): Data {
  if (input instanceof LegacyContentBean) return input.values();
  const entries = input instanceof Map ? [...(input as ReadonlyMap<string, unknown>)] : Object.entries(input as ContentInput);
  return new Map(entries.map(([key, value]) => [key.toLowerCase(), value] as const));
}

/** CFML `isDefined('arguments.data.<key>')`. */
function given(data: ReadonlyMap<string, unknown>, key: string): boolean {
  const value = data.get(key);
  return value !== undefined && value !== null;
}

function dataText(data: ReadonlyMap<string, unknown>, key: string): string {
  return cfText(data.get(key));
}

/** contentManager.add's required data and defaults (contentManager.cfc:1000-1031). */
function requireSaveData(data: Data): void {
  const missing = (key: string): boolean => dataText(data, key) === '';
  if (missing('siteid')) throw new ContentSaveDataError("The attribute 'SITEID' is required when saving content.");
  if (missing('parentid')) throw new ContentSaveDataError("The attribute 'PARENTID' is required when saving content.");
  if (!inList(VALID_CONTENT_TYPES, dataText(data, 'type'))) throw new ContentSaveDataError("A valid 'TYPE' is required when saving content.");
  if (missing('title') && missing('menutitle')) throw new ContentSaveDataError("The attribute 'TITLE' is required when saving content.");
  if (dataText(data, 'type') === 'Portal') data.set('type', 'Folder');
  if (!cfIsNumeric(data.get('display'))) data.set('display', 1);
  if (!cfIsNumeric(data.get('isnav'))) data.set('isnav', 1);
  if (!cfIsNumeric(data.get('approved'))) data.set('approved', 0);
}

/** The request's posted `newfile` part, when it has a file. */
function newFilePart(opts: SaveContentOptions): UploadedFile | undefined {
  return opts.files?.find((file) => cfEq(file.fieldName, 'newfile') && file.fileName !== '');
}

/** The version state contentManager.add carries between its steps. */
interface SaveState {
  scope: WriteScope;
  opts: SaveContentOptions;
  data: Data;
  bean: LegacyContentBean;
  /** The source version (`currentBean`); null for a new item. */
  current: LegacyContentBean | null;
  /** `activeBean`: the source when active, else legacy's read without a content id, a new bean. */
  active: LegacyContentBean | null;
  previousChangesetId: string;
  approvalRequest: ApprovalRequestValues | null;
  approvalRequestIsNew: boolean;
  doSaveApproval: boolean;
  /** `local.rsApprovalsCancel`: the requests to cancel after the save. */
  approvalsToCancel: string[];
  /** The stored upload's file name, for a File body. */
  uploadedFilename: string | undefined;
  /** The version as re-read after its insert. */
  saved: LegacyContentBean | undefined;
  /** `doDeleteDraftHistAll` and `doTrimVersionHistory`, run after the version insert. */
  deleteDraftHistAll: boolean;
  trimVersionHistory: boolean;
  notices: MailNotice[];
  written: ContentRow[];
}

/**
 * contentManager.add [contentManager.cfc:950-1761] inside `tx`, in legacy's order. Plugin events, cache purges, log lines
 * and cflocks are not reproduced: the unit gates and the transaction give the single-writer guarantee.
 */
export async function saveContentInTx(
  tx: TenantTx,
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: ContentInput | LegacyContentBean | ReadonlyMap<string, unknown>,
  opts: SaveContentOptions = {},
): Promise<SaveContentResult> {
  const scope = scopeOf(tx, deps, actor, site, opts);
  // A bean is unpacked with getAllValues(), which autocompletes its extended attributes.
  if (input instanceof LegacyContentBean) await autocompleteExtendData(scope, input);
  const data = dataOf(input);
  requireSaveData(data);
  const siteId = dataText(data, 'siteid');
  const upload = newFilePart(opts);
  if (upload !== undefined && dataText(data, 'newfile') === '') data.set('newfile', upload.fileName);

  let bean: LegacyContentBean;
  let refused = false;
  if (dataText(data, 'mode') === 'import' && dataText(data, 'remoteid') !== '') {
    bean = await readBean(scope, { siteId, remoteId: dataText(data, 'remoteid') });
    // Legacy compares the posted date with the bean it just failed to find, whose remotePubDate is ''.
    if (bean.isNew === 1 && given(data, 'remotepubdate') && cfEq(dataText(data, 'remotepubdate'), bean.text('remotepubdate'))) refused = true;
    else data.set('sourceid', bean.contentHistId());
  } else {
    const histId = dataText(data, 'contenthistid');
    bean = await readBean(scope, isCfUuid(histId) ? { siteId, contentHistId: histId } : { siteId, contentId: dataText(data, 'contentid') });
    data.set('sourceid', bean.contentHistId());
  }

  if (refused) return { bean, errors: {}, notices: [], refused: true, written: [] };

  const state: SaveState = {
    scope,
    opts,
    data,
    bean,
    current: null,
    active: null,
    previousChangesetId: bean.text('changesetid'),
    approvalRequest: null,
    approvalRequestIsNew: false,
    doSaveApproval: false,
    approvalsToCancel: [],
    uploadedFilename: undefined,
    saved: undefined,
    deleteDraftHistAll: false,
    trimVersionHistory: false,
    notices: [],
    written: [],
  };
  bean.set(data, actor);
  await applyStatus(scope, bean);
  if (given(data, 'relatedcontentid')) await applyRelatedContentId(scope, bean, dataText(data, 'relatedcontentid'));
  if (opts.approvingChainRequest === true) bean.put('approvingChainRequest', true);

  if (cfEq(bean.text('changesetid'), 'other') && bean.text('changesetname') !== '') {
    const changeset = newChangesetBean(actor, deps.clock, { name: bean.text('changesetname'), siteid: bean.text('siteid') });
    bean.put('changesetid', changeset.changesetid);
    data.set('changesetid', changeset.changesetid);
    await saveChangesetInTx(tx, deps.repository, changeset, actor, scope.write);
  }

  if (bean.isNew === 1) {
    bean.put('active', 1);
    bean.setValue('created', scope.now);
  } else {
    bean.put('active', 0);
    state.current = await readBean(scope, { siteId, contentHistId: dataText(data, 'sourceid') });
    state.active = state.current.number('active') ? state.current : LegacyContentBean.notFound(actor, scope.now, siteId);
  }
  bean.contentId();

  await decideApproval(state);
  bean.put('contenthistid', cfUuid());
  deriveTitles(state);
  const initJs = cfEq(bean.text('type'), 'Variation') ? bean.text('initjs') : '';

  const errors = await validateBean(scope, bean, opts);
  if (requestHasRestrictedFiles(opts.files ?? [], deps.config.fmAllowedExtensions)) {
    bean.errors = structErrors([...Object.entries(errors), ['requestHasRestrictedFiles', rbOf(opts)('sitemanager.requestHasRestrictedFiles')]]);
  }
  if (Object.keys(bean.errors).length > 0) {
    // contentManager.cfc:1752-1756: an invalid bean goes back under its source version id.
    const sourceId = dataText(data, 'sourceid') !== '' ? dataText(data, 'sourceid') : dataText(data, 'contenthistid');
    if (sourceId !== '') bean.put('contenthistid', sourceId);
    return { bean, errors: bean.errors, notices: [], refused: false, written: [] };
  }

  state.data = bean.values();
  convertDisplayTimeZone(bean, scope.now);
  await prepareApprovalRequest(state);
  await writeVersion(state);
  try {
    return await finishSave(state, initJs);
  } catch (err) {
    if (!(err instanceof ErrorAfterWrites)) throw err;
    assertStartupSafe(state.written);
    return { bean: state.saved ?? bean, errors: {}, notices: state.notices, refused: false, written: state.written, afterCommitError: err.error };
  }
}

/** contentManager.add's approval decision (contentManager.cfc:1084-1098): the chain of the parent (new) or the item, and the request to raise. */
async function decideApproval(state: SaveState): Promise<void> {
  const { scope, bean } = state;
  const { tx, deps } = scope;
  const subject = bean.isNew === 1 ? await readBean(scope, { siteId: bean.text('siteid'), contentId: bean.text('parentid') }) : bean;
  const requirement = await beanRequiresApproval(scope, subject);
  if (!cfBool(bean.get('approvalchainoverride')) && (cfBool(bean.get('approved')) || bean.text('changesetid') !== '') && requirement.required) {
    bean.put('chainID', requirement.chainId);
    // contentBean.getApprovalRequest reads by the version id the bean still holds: the source version's.
    const loaded = await loadRequest(tx, deps.repository, { contentHistId: bean.contentHistId(), chainId: requirement.chainId, siteId: bean.text('siteid') });
    state.approvalRequest = { ...loaded.values, status: PENDING_STATUS };
    state.approvalRequestIsNew = loaded.isNew;
  }
}

/** contentManager.add's title derivations (contentManager.cfc:1102-1118). */
function deriveTitles(state: SaveState): void {
  const { bean, scope } = state;
  if (bean.text('title') === '') bean.setValue('title', bean.text('menutitle'));
  const derived = inList(TITLE_DERIVED_TYPES, bean.text('type')) || !cfEq(bean.text('moduleid'), SITE_TREE_MODULE_ID);
  if (derived || bean.text('menutitle') === '') bean.setValue('menutitle', bean.text('title'));
  if (derived || bean.text('urltitle') === '') bean.setValue('urltitle', formatName(scope.site, bean.text('menutitle')));
  // getHTMLTitle() falls back to the menu title, so `text('htmltitle')` is '' only when both are.
  if (derived || bean.text('htmltitle') === '') bean.setValue('htmltitle', bean.text('title'));
}

/** java.util.TimeZone offset of `zone` at `at`, in seconds; an unknown zone is GMT, as `getTimeZone` makes it. */
function zoneOffsetSeconds(zone: string, at: Date): number {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return 0;
  }
  const parts = new Map(format.formatToParts(at).map((part) => [part.type, Number(part.value)] as const));
  const wall = Date.UTC(parts.get('year') ?? 1970, (parts.get('month') ?? 1) - 1, parts.get('day') ?? 1, parts.get('hour') ?? 0, parts.get('minute') ?? 0, parts.get('second') ?? 0);
  return Math.round((wall - (at.getTime() - at.getMilliseconds())) / 1000);
}

/** cfobject.convertTimezone (cfobject.cfc:368-407) into the server zone, with both offsets taken at the current time. */
function convertTimezone(datetime: Date, from: string, now: Date): Date {
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (from === serverZone) return datetime;
  const shift = zoneOffsetSeconds(serverZone, now) - zoneOffsetSeconds(from, now);
  return new Date(datetime.getTime() + shift * 1000);
}

/** contentManager.add's display time-zone conversion (contentManager.cfc:1150-1163), over contentIntervalManager.deserializeInterval's defaults. */
function convertDisplayTimeZone(bean: LegacyContentBean, now: Date): void {
  const flag = bean.get('convertdisplaytimezone');
  if (bean.number('display') !== 2 || !cfBool(flag)) return;
  const raw = bean.raw('displayinterval');
  const parsed: unknown = isJson(raw) ? JSON.parse(raw) : {};
  const interval = isPlainObject(parsed) ? parsed : {};
  const allDay = member(interval, 'allday') ?? 1;
  if (!cfIsBoolean(allDay)) throw new Error(`cannot convert the value "${cfText(allDay)}" to a boolean`);
  const zone = cfText(member(interval, 'timezone'));
  if (cfToBoolean(allDay) || zone === '') return;
  for (const field of ['displayStart', 'displayStop']) {
    const at = asDate(bean.raw(field));
    if (at !== null) bean.setValue(field, convertTimezone(at, zone, now));
  }
}

/** contentManager.add's approval request (contentManager.cfc:1166-1221): a new pending request replaces a missing or approved one. */
async function prepareApprovalRequest(state: SaveState): Promise<void> {
  const { scope, bean } = state;
  const request = state.approvalRequest;
  if (request === null) return;
  const replacing =
    state.approvalRequestIsNew ||
    (bean.isNew === 0 && state.current !== null && cfBool(state.current.get('active')) && cfBool(state.current.get('approved')));
  let values = request;
  if (!replacing) {
    if (cfBool(bean.get('approvingchainrequest'))) return;
    const sameChangeset = bean.text('changesetid') !== '' && cfEq(state.previousChangesetId, bean.text('changesetid'));
    if ((cfEq(values.status, PENDING_STATUS) && cfBool(bean.get('cancelpendingapproval'))) || sameChangeset) {
      values = await cancelRequest(scope.tx, scope.deps.repository, values, '', scope.actor, scope.site);
    }
  }
  // The re-issued request keeps the loaded bean's `created`, as its ORM insert does.
  state.approvalRequest = {
    ...values,
    ...(scope.actor.isLoggedIn ? { userid: scope.actor.userId } : {}),
    requestid: cfUuid(),
    contenthistid: bean.contentHistId(),
    status: PENDING_STATUS,
    groupid: '',
  };
  state.doSaveApproval = true;
  bean.put('approved', 0);
}

/** extendSubType.getRelatedContentSets(includeInheritedSets=true) (extendSubType.cfc:517-576): ID, Default, TYPE and BASE sets. */
async function relatedContentSets(scope: WriteScope, bean: LegacyContentBean): Promise<Array<{ relatedcontentsetid: string; name: string }>> {
  const repo = scope.deps.repository;
  const siteId = bean.text('siteid');
  const type = bean.text('type');
  const subType = bean.text('subtype');
  const setsOf = async (subtypes: ReadonlyArray<{ subtypeid: string }>): Promise<Array<{ relatedcontentsetid: string; name: string; orderno: number }>> => {
    const sets: Array<{ relatedcontentsetid: string; name: string; orderno: number }> = [];
    for (const subtype of subtypes) {
      for (const row of await repo.extend.rcsetsForSubtype(scope.tx, { subTypeId: subtype.subtypeid })) {
        if (sqlKey(row.siteid) === sqlKey(siteId)) sets.push({ relatedcontentsetid: row.relatedcontentsetid, name: row.name ?? '', orderno: row.orderno ?? 0 });
      }
    }
    // One `order by orderNo` across the matched subtypes; a stable sort keeps each subtype's own order on ties.
    return sets.sort((a, b) => a.orderno - b.orderno);
  };
  const own = (await repo.extend.subtypes(scope.tx, { siteId, type, subType })).slice(0, 1);
  const sets = [...(await setsOf(own)), { relatedcontentsetid: SITE_TREE_MODULE_ID, name: 'Default', orderno: 0 }];
  if (!cfEq(subType, 'Default')) sets.push(...(await setsOf(await repo.extend.subtypes(scope.tx, { siteId, type, subType: 'Default' }))));
  if (!inList(NO_BASE_EXTEND_TYPES, type)) sets.push(...(await setsOf(await repo.extend.subtypes(scope.tx, { siteId, type: 'Base', subType: 'Default' }))));
  return sets.map(({ relatedcontentsetid, name }) => ({ relatedcontentsetid, name }));
}

/** contentBean.setRelatedContentID (contentBean.cfc:1455-1491); each set keeps its row count of the first related id, as `q.contentID` reads it. */
async function applyRelatedContentId(scope: WriteScope, bean: LegacyContentBean, contentIds: string): Promise<void> {
  const data: Array<{ relatedContentSetID: string; items: string[] }> = [];
  for (const set of await relatedContentSets(scope, bean)) {
    // The bean's own tenant only: related items held in another content-pool tenant are not counted here.
    const rows = await scope.deps.repository.content.relatedContent(scope.tx, {
      siteId: bean.text('siteid'),
      contentHistId: bean.text('contenthistid'),
      liveOnly: false,
      today: scope.now,
      relatedContentSetId: set.relatedcontentsetid,
    });
    const first = rows[0]?.contentid ?? '';
    data.push({ relatedContentSetID: set.relatedcontentsetid, items: rows.map(() => first) });
  }
  const replacement = { relatedContentSetID: SITE_TREE_MODULE_ID, items: cfListToArray(contentIds) };
  bean.put('relatedContentSetData', data.map((set) => (cfEq(set.relatedContentSetID, replacement.relatedContentSetID) ? replacement : set)));
}

// ---- contentManager.add: the transaction block ----

/** CFML `replaceNoCase(value, find, replacement, 'ALL')`. */
function replaceNoCaseAll(value: string, find: string, replacement: string): string {
  if (find === '') return value;
  const lower = value.toLowerCase();
  const needle = find.toLowerCase();
  let out = '';
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    out += value.slice(from, at) + replacement;
    from = at + find.length;
  }
  return out + value.slice(from);
}

/** A query cell of `categoriesFromMuraTrash` as its column type reads it. */
function wddxCell(value: WddxValue | undefined): string | number | Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof WddxNumber) return Number(value.text);
  if (value instanceof WddxDate) return value.value;
  return null;
}

function isWddxQuery(value: unknown): value is WddxQuery {
  return isPlainObject(value) && value.kind === 'query' && Array.isArray(value.rows);
}

/** A stored category assignment as a version's assignment to write. */
function assignmentInput(row: Readonly<Record<string, unknown>>): CategoryAssignmentInput {
  const text = (key: string): string | null => {
    const value = member(row, key);
    return value === null || value === undefined ? null : cfText(value);
  };
  const number = (key: string): number | null => {
    const value = member(row, key);
    return cfIsNumeric(value) ? cfToNumber(value) : null;
  };
  const date = (key: string): Date | null => asDate(member(row, key));
  return {
    categoryid: text('categoryid') ?? '',
    contentid: text('contentid'),
    isfeature: number('isfeature'),
    orderno: number('orderno'),
    siteid: text('siteid'),
    featurestart: date('featurestart'),
    featurestop: date('featurestop'),
  };
}

/** contentGateway.getCategoriesByHistID: a version's assignments to categories that exist in the category pool. */
async function categoriesByHistId(state: SaveState, contentHistId: string, pool: ReadonlySet<string>): Promise<CategoryAssignmentInput[]> {
  if (contentHistId === '') return [];
  const rows = await state.scope.deps.repository.content.categoryAssignments(state.scope.tx, { contentHistId });
  return rows.filter((row) => pool.has(sqlKey(row.categoryid))).map((row) => assignmentInput(row));
}

/** contentManager.add's category persistence (contentManager.cfc:1227-1244). */
async function persistCategories(state: SaveState): Promise<void> {
  const { scope, bean, data } = state;
  const { tx, deps, actor } = scope;
  const poolCategories = state.opts.poolCategories ?? (await listPoolCategories(deps, actor));
  const pool = new Set(poolCategories.map((row) => sqlKey(row.categoryid)));
  const sourceHistId = state.current?.contentHistId() ?? '';
  if (bean.isNew === 0 && cfEq(dataText(data, 'mode'), 'import')) {
    await keepCategories(tx, deps.repository, bean.contentHistId(), await categoriesByHistId(state, sourceHistId, pool), scope.write);
    return;
  }
  const fromTrash = bean.raw('categoriesfrommuratrash');
  const current = isWddxQuery(fromTrash)
    ? fromTrash.rows.map((row) => assignmentInput(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, wddxCell(value)]))))
    : await categoriesByHistId(state, bean.isNew === 1 ? '' : sourceHistId, pool);
  await setCategoryAssignments(tx, deps.repository, {
    data: Object.fromEntries(data),
    contentId: bean.contentId(),
    contentHistId: bean.contentHistId(),
    siteId: dataText(data, 'siteid'),
    poolCategories,
    current,
    write: scope.write,
  });
}

/** contentManager.setMaterializedPath and updateMaterializedPath (contentManager.cfc:906-940). */
async function persistPath(state: SaveState): Promise<void> {
  const { scope, bean } = state;
  const crumbs = await scope.deps.repository.content.crumbPath(scope.tx, { contentId: bean.text('parentid'), siteId: bean.text('siteid') });
  bean.setValue('path', materializedPath(crumbs.map((crumb) => crumb.contentid ?? ''), bean.contentId()));
  const current = state.current;
  if (bean.isNew === 1 || current === null || cfEq(bean.text('parentid'), current.text('parentid'))) return;
  if (bean.text('path') === '') throw new ContentSaveDataError("The attribute 'PATH' is required when saving content.");
  if (current.text('path') === '') return;
  state.written.push(
    ...(await scope.deps.repository.content.replacePathPrefix(
      scope.tx,
      { siteId: bean.text('siteid'), currentPath: current.text('path'), newPath: bean.text('path') },
      scope.write,
    )),
  );
}

/** contentManager.add's expiration assignments (contentManager.cfc:1252-1262). */
async function persistExpiryAssignments(state: SaveState): Promise<void> {
  const { scope, bean, data } = state;
  const repo = scope.deps.repository;
  const assign = (userid: string): Promise<unknown> =>
    repo.content.insertContentAssignment(
      scope.tx,
      { contentid: bean.contentId(), contenthistid: bean.contentHistId(), siteid: bean.text('siteid'), userid, type: 'expire' },
      scope.write,
    );
  if (given(data, 'expiresnotify') && dataText(data, 'expiresnotify') !== '') {
    for (const userId of cfListToArray(dataText(data, 'expiresnotify'))) await assign(userId);
  } else if (bean.isNew === 0 && state.current !== null) {
    for (const row of await repo.content.expireAssignments(scope.tx, { contentHistId: state.current.contentHistId() })) await assign(row.userid ?? '');
  }
}

/** contentManager.add's change-set detachment (contentManager.cfc:1287-1320); the requests found are cancelled after the save. */
async function detachChangesets(state: SaveState): Promise<void> {
  const { scope, bean } = state;
  const repo = scope.deps.repository;
  const detach = async (changesetId: string): Promise<void> => {
    const args = { contentId: bean.contentId(), changesetId, siteId: bean.text('siteid') };
    state.approvalsToCancel = (await repo.approvals.requestsOfChangesetVersions(scope.tx, args)).map((row) => row.requestid);
    state.written.push(...(await repo.content.clearChangeset(scope.tx, args, scope.write)));
  };
  if (bean.isNew === 0 && cfBool(bean.get('removepreviouschangeset')) && isCfUuid(state.previousChangesetId)) await detach(state.previousChangesetId);
  if (bean.text('changesetid') !== '') await detach(bean.text('changesetid'));
}

/** contentUtility.move (contentUtility.cfc:461-488): the active descendants' filenames, then the item's own. */
async function moveFilenames(scope: WriteScope, siteId: string, filename: string, oldFilename: string): Promise<ContentRow[]> {
  const repo = scope.deps.repository;
  const moved = await repo.content.updateVersions(
    scope.tx,
    { siteId, filenameLike: `${oldFilename}/%`, active: 1, types: MOVE_TYPES },
    (row) => ({ filename: replaceNoCaseAll(row.filename ?? '', `${oldFilename}/`, `${filename}/`) }),
    scope.write,
  );
  const own = await repo.content.updateVersions(scope.tx, { siteId, filename: oldFilename, active: 1, types: MOVE_TYPES }, { filename }, scope.write);
  return [...moved, ...own];
}

/** contentUtility.movelink (contentUtility.cfc:490-545): links to the old URL stem in bodies and summaries, with configBean `manageLinks`. */
async function moveLinks(state: SaveState, siteId: string, filename: string, oldFilename: string): Promise<ContentRow[]> {
  const { scope, opts } = state;
  if (!(opts.manageLinks ?? true) || oldFilename === '/') return [];
  const urls = scope.site.urls;
  const newFile = `${urls.context}${getUrlStem(urls, siteId, filename)}`;
  const oldStem = `${urls.context}${getUrlStem(urls, siteId, oldFilename)}`;
  // rereplace takes the old stem as a regular expression, case-sensitive, while the LIKE that selects rows ignores case.
  const rewrite = (value: string | null): string => (value ?? '').replace(new RegExp(oldStem, 'gu'), () => newFile);
  const repo = scope.deps.repository;
  const bodies = await repo.content.updateVersions(scope.tx, { siteId, bodyLike: `%${oldStem}%`, types: MOVELINK_TYPES }, (row) => ({ body: rewrite(row.body) }), scope.write);
  const summaries = await repo.content.updateVersions(
    scope.tx,
    { siteId, summaryLike: `%${oldStem}%`, types: MOVELINK_TYPES },
    (row) => ({ summary: rewrite(row.summary) }),
    scope.write,
  );
  return [...bodies, ...summaries];
}

/** contentManager.add's filename and URL title (contentManager.cfc:1322-1389). */
async function persistFilename(state: SaveState): Promise<void> {
  const { scope, bean, data } = state;
  const current = state.current;
  const active = state.active;
  if (bean.isNew === 0 && current !== null) {
    bean.setValue('filename', current.text('filename'));
    bean.setValue('oldfilename', current.text('filename'));
  }
  const isNew = bean.isNew === 1;
  const moved =
    !isNew &&
    current !== null &&
    (!cfEq(current.text('parentid'), bean.text('parentid')) ||
      !cfEq(formatName(scope.site, active?.text('urltitle') ?? ''), formatName(scope.site, bean.text('urltitle'))));
  const locking = scope.site.locking;
  const renamed =
    ((cfBool(bean.get('approved')) || isNew) && !cfEq(bean.contentId(), HOME_ID) &&
      (isNew || moved) &&
      !(cfEq(bean.text('parentid'), HOME_ID) && cfEq(locking, 'top')) &&
      !cfEq(locking, 'all') &&
      !(!isNew && cfBool(bean.get('islocked')))) ||
    (inList(['link', 'file'], bean.text('type')) && cfEq(bean.text('muraurlreset'), 'true'));
  if (!renamed) return;
  if (scope.deps.config.loadContentBy === 'urltitle') await setUniqueUrlTitle(scope, bean);
  await setUniqueFilename(scope, bean);
  const oldFilename = bean.text('oldfilename');
  if (!isNew && current !== null && oldFilename !== bean.text('filename') && oldFilename !== '') {
    const siteId = bean.text('siteid');
    state.written.push(...(await moveLinks(state, siteId, bean.text('filename'), current.text('filename'))));
    state.written.push(...(await moveFilenames(scope, siteId, bean.text('filename'), oldFilename)));
  }
  if (given(data, 'unlocknodewithpublish') && cfBool(data.get('unlocknodewithpublish'))) {
    await scope.deps.repository.stats.clearLock(scope.tx, { contentId: bean.contentId(), siteId: bean.text('siteid') }, scope.write);
  }
}

/** contentDAO.createObjects (contentDAO.cfc:890-975): each region from `objectlist<n>` (JSON or `^`/`~` list), else the source version's. */
async function persistObjects(state: SaveState): Promise<void> {
  const { scope, bean, data } = state;
  const repo = scope.deps.repository;
  const rows: ContentObjectInput[] = [];
  const base = { contentid: bean.contentId(), siteid: bean.text('siteid') };
  const sourceHistId = bean.isNew === 1 ? '' : (state.current?.contentHistId() ?? '');
  const regions = scope.site.columnCount ?? DEFAULT_COLUMN_COUNT;
  for (let region = 1; region <= regions; region += 1) {
    const key = `objectlist${region}`;
    if (given(data, key)) {
      const list = data.get(key);
      if (isJson(list)) {
        const items: unknown = JSON.parse(list);
        if (!Array.isArray(items)) throw new Error(`The value of ${key} cannot be converted to an array.`);
        items.forEach((item: unknown, index) => {
          if (!Array.isArray(item)) throw new Error(`The value of ${key} item ${index + 1} cannot be converted to an array.`);
          const field = (n: number): string => {
            if (item.length < n) throw new Error(`The element at position ${n} cannot be found.`);
            return cfText(item[n - 1]);
          };
          const params: unknown = item.length > 3 ? item[3] : null;
          rows.push({
            ...base,
            object: field(1),
            name: field(2),
            objectid: field(3),
            orderno: index + 1,
            columnid: region,
            params: item.length > 3 ? (isJson(params) ? params : JSON.stringify(params)) : null,
          });
        });
      } else {
        cfListToArray(cfText(list), '^').forEach((entry, index) => {
          const parts = cfListToArray(entry, '~');
          const part = (n: number): string => {
            const value = parts[n - 1];
            if (value === undefined) throw new Error(`Invalid list index ${n}.`);
            return value;
          };
          rows.push({ ...base, object: part(1), name: part(2), objectid: part(3), orderno: index + 1, columnid: region, params: parts.length > 3 ? part(4) : null });
        });
      }
    } else if (sourceHistId !== '') {
      const old = await repo.content.regionObjects(scope.tx, { contentHistId: sourceHistId, columnId: region, siteId: bean.text('siteid') });
      old.forEach((row, index) => {
        rows.push({
          ...base,
          object: row.object,
          name: row.name,
          objectid: row.objectid,
          orderno: index + 1,
          columnid: row.columnid,
          params: (row.params ?? '') !== '' ? row.params : null,
        });
      });
    }
  }
  if (rows.length > 0) await repo.content.replaceObjects(scope.tx, bean.contentHistId(), rows, scope.write);
}

/** The upload deps of a save that stores a file. */
function uploadDeps(scope: WriteScope): ContentDeps & { storage: StoragePort } {
  const storage = scope.deps.storage;
  if (storage === undefined) throw new Error('A content save that stores an upload needs the storage port');
  return { ...scope.deps, storage };
}

/** The posted part of form field `field`, matched as CFML matches form keys. */
function postedPart(opts: SaveContentOptions, field: string): UploadedFile | undefined {
  return opts.files?.find((file) => cfEq(file.fieldName, field) && file.fileName !== '');
}

/** contentUtility.setVersionNumbers (contentUtility.cfc:1489-1552). */
async function setVersionNumbers(state: SaveState, versionType: string): Promise<void> {
  const { scope, bean } = state;
  const repo = scope.deps.repository;
  const key = { contentId: bean.contentId(), siteId: bean.text('siteid') };
  let major = 1;
  let minor = 0;
  if (bean.isNew === 0) {
    const stats = await repo.stats.readStats(scope.tx, key);
    const statsMajor = stats?.majorversion ?? 0;
    if (statsMajor === 0) {
      const versions = await repo.content.hist(scope.tx, key);
      const maxMajor = Math.max(0, ...versions.map((row) => row.majorversion ?? 0));
      const maxMinor = Math.max(0, ...versions.map((row) => row.minorversion ?? 0));
      if (versions.length > 0 && maxMajor !== 0) {
        major = cfEq(versionType, 'major') ? maxMajor + 1 : maxMajor;
        minor = cfEq(versionType, 'major') ? 0 : maxMinor + 1;
      }
    } else {
      major = cfEq(versionType, 'major') ? statsMajor + 1 : statsMajor;
      minor = cfEq(versionType, 'major') ? 0 : (stats?.minorversion ?? 0) + 1;
    }
  }
  bean.setValue('majorVersion', major);
  bean.setValue('minorVersion', minor);
  await repo.stats.setVersionNumbers(scope.tx, { ...key, majorVersion: major, minorVersion: minor }, scope.write);
}

/** contentManager.add's file handling (contentManager.cfc:1414-1497). */
async function persistFiles(state: SaveState): Promise<void> {
  const { scope, bean, data } = state;
  const repo = scope.deps.repository;
  if (!cfEq(bean.text('type'), 'File') && given(data, 'deletefile') && bean.text('fileid') !== '') {
    await deleteFilesIfNotUsed(scope, [bean.text('fileid')], [bean.contentHistId()]);
    bean.setValue('fileid', '');
  }
  if (given(data, 'newfile') && dataText(data, 'newfile') !== '') {
    const part = postedPart(state.opts, 'newfile');
    // fileBean.save would fetch a non-posted `newfile` value as a URL; only posted parts reach the target.
    if (part === undefined) throw new Error('newfile names no posted file part; remote file imports stay on legacy');
    const stored = await storeUploadedFile(uploadDeps(scope), scope.actor, {
      file: part,
      contentId: bean.contentId(),
      moduleId: bean.text('moduleid'),
      ...(state.opts.requestId === undefined ? {} : { requestId: state.opts.requestId }),
    });
    bean.setValue('fileid', stored.fileid);
    if (bean.isNew === 0 && given(data, 'unlockfilewithnew') && cfBool(data.get('unlockfilewithnew'))) {
      await repo.stats.clearLock(scope.tx, { contentId: bean.contentId(), siteId: bean.text('siteid') }, scope.write);
    }
    if (cfEq(bean.text('type'), 'File')) {
      const row = applyFileBody({ type: bean.text('type'), active: bean.number('active'), body: bean.text('body'), filename: bean.text('filename') }, stored.filename);
      bean.setValue('body', row.body);
      state.uploadedFilename = stored.filename;
      await setVersionNumbers(state, given(data, 'versiontype') ? dataText(data, 'versiontype') : 'minor');
    }
  }
  // The purge-drafts cleanup (contentManager.cfc:1460-1497) loops over `draftList`, which legacy never assigns,
  // so it deletes nothing; its reads have no effect and are not repeated.
}

/** The extend-data row of one non-File value, bound as saveExtendedData binds it (extendManager.cfc:520-560). */
function extendValueRow(row: ExtendAttributeRow, value: string | Date, siteId: string, remoteId: string): ExtendDataInput {
  const text = cfText(value);
  const validation = (row.validation ?? '').toLowerCase();
  const stored: ExtendDataInput = {
    attributeid: row.attributeid,
    siteid: siteId,
    stringvalue: left(text, 250),
    attributevalue: null,
    datetimevalue: null,
    numericvalue: null,
    remoteid: remoteId,
  };
  if (text === '') return stored;
  if (validation === 'date' || validation === 'datetime') {
    const date = value instanceof Date ? value : null;
    if (date === null) throw new Error(`The value ${text} cannot be converted to a date for CFSQLTYPE CF_SQL_TIMESTAMP.`);
    return { ...stored, attributevalue: text, datetimevalue: date };
  }
  if (validation === 'numeric') return { ...stored, attributevalue: text, numericvalue: cfToNumber(text) };
  return { ...stored, attributevalue: text };
}

/** saveExtendedData's value of a non-File attribute: dates parsed, a non-numeric Numeric value dropped (extendManager.cfc:487-512). */
function extendSaveValue(row: ExtendAttributeRow, text: string): string | Date {
  if (text === '') return text;
  const validation = (row.validation ?? '').toLowerCase();
  if (validation === 'date' || validation === 'datetime') {
    if (cfLsIsDate(text)) {
      try {
        return cfLsParseDateTime(text);
      } catch {
        return cfParseDateTimeText(text);
      }
    }
    return cfIsDateText(text) ? cfParseDateTimeText(text) : text;
  }
  if (validation === 'numeric' && !cfIsNumeric(text)) return '';
  return text;
}

/** `left(data.remoteID, 35)` when the data holds one, else ''. */
function extendRemoteId(data: ReadonlyMap<string, unknown>): string {
  return given(data, 'remoteid') ? left(dataText(data, 'remoteid'), 35) : '';
}

/** extendManager.saveExtendedData (extendManager.cfc:439-650) of the submitted extend sets onto version `baseId`. */
async function saveExtendedData(state: SaveState, baseId: string): Promise<void> {
  const { scope, data } = state;
  const repo = scope.deps.repository;
  const siteId = dataText(data, 'siteid');
  const remoteId = extendRemoteId(data);
  const moduleId = given(data, 'moduleid') ? dataText(data, 'moduleid') : '00000000000000000000000000000000004';
  const ofSite = (row: ExtendAttributeRow): boolean => sqlKey(row.siteid) === sqlKey(siteId);
  const { values, files } = await extendAttributes(scope, dataText(data, 'extendsetid'));
  const saveEmpty = state.opts.saveEmptyExtendedValues ?? true;
  const rows: ExtendDataInput[] = [];
  for (const row of values.filter(ofSite)) {
    const text = attributeValue(data, row);
    if (text === undefined) continue;
    const value = extendSaveValue(row, text);
    // Without a value and with saveEmptyExtendedValues off, legacy only deletes the attribute's rows of `baseId`,
    // which this save created a moment ago and so holds none.
    if (cfText(value) !== '' || saveEmpty) rows.push(extendValueRow(row, value, siteId, remoteId));
  }
  if (rows.length > 0) await repo.extend.replaceExtendData(scope.tx, baseId, rows, scope.write);

  const fileRows: ExtendDataInput[] = [];
  for (const row of files.filter(ofSite)) {
    const key = `ext${row.attributeid}`;
    const name = (row.name ?? '').toLowerCase();
    const byKey = given(data, key) && dataText(data, key) !== '';
    const byName = given(data, name) && dataText(data, name) !== '';
    const deleting = data.has(`extdelete${row.attributeid}`) || data.has(`extdelete${name}`);
    // A new upload or delete key first removes `baseId`'s stored file of the attribute; a new version has none yet.
    // Legacy's precedence: `byKey or (byName and not deleting)`.
    if (!(byKey || (byName && !deleting))) continue;
    const field = byKey ? key : name;
    const submitted = dataText(data, field);
    let fileId = submitted;
    if (!isCfUuid(submitted)) {
      const part = postedPart(state.opts, field);
      // fileManager.emulateUpload would fetch a non-posted value as a URL or path; only posted parts reach the target.
      if (part === undefined) throw new Error(`${field} names no posted file part; remote file imports stay on legacy`);
      const stored = await storeUploadedFile(uploadDeps(scope), scope.actor, {
        file: part,
        contentId: baseId,
        moduleId,
        ...(state.opts.requestId === undefined ? {} : { requestId: state.opts.requestId }),
      });
      fileId = stored.fileid;
    }
    if (fileId !== '') fileRows.push({ attributeid: row.attributeid, siteid: siteId, attributevalue: fileId, stringvalue: fileId, remoteid: remoteId });
  }
  if (fileRows.length > 0) await repo.extend.replaceExtendData(scope.tx, baseId, fileRows, scope.write);
}

/** extendManager.preserveExtendedData (extendManager.cfc:652-945): carries the source version's unsubmitted values to `baseId`. */
async function preserveExtendedData(state: SaveState, baseId: string, preserveId: string, type: string, subType: string): Promise<void> {
  const { scope, data } = state;
  const repo = scope.deps.repository;
  const remoteId = extendRemoteId(data);
  const siteId = dataText(data, 'siteid');
  const setIds = cfListToArray(dataText(data, 'extendsetid')).map(sqlKey);
  const hasSets = setIds.length > 0;
  const details = await repo.extend.extendDataDetail(scope.tx, { baseId: preserveId });
  const setIdsOfRows = [...new Set(details.map((row) => row.extendsetid ?? '').filter((id) => id !== ''))];
  const attributes = new Map(
    (setIdsOfRows.length === 0 ? [] : await repo.extend.attributesForSets(scope.tx, { extendSetIds: setIdsOfRows })).map((row) => [row.attributeid, row] as const),
  );
  const subtypeMatches = (row: (typeof details)[number]): boolean =>
    (cfEq(row.type ?? '', type) || (!inList(NO_BASE_EXTEND_TYPES, type) && cfEq(row.type ?? '', 'Base'))) &&
    ((!cfEq(subType, 'Default') && cfEq(row.subtype ?? '', subType)) || cfEq(row.subtype ?? '', 'Default'));
  const inSets = (row: (typeof details)[number]): boolean => row.extendsetid !== null && setIds.includes(sqlKey(row.extendsetid));
  const siteMatches = (attribute: ExtendAttributeRow | undefined): boolean => siteId === '' || sqlKey(attribute?.siteid) === sqlKey(siteId);
  const isFile = (attribute: ExtendAttributeRow | undefined): boolean => sqlKey(attribute?.type) === 'file';
  const present = (value: unknown): boolean => value !== null && value !== undefined && cfText(value) !== '';
  const rows: ExtendDataInput[] = [];

  // Values of the extend sets that were not submitted.
  for (const row of details) {
    const attribute = attributes.get(row.attributeid);
    if (!subtypeMatches(row) || (hasSets && (row.extendsetid === null || inSets(row))) || !siteMatches(attribute)) continue;
    rows.push({
      attributeid: row.attributeid,
      siteid: row.siteid,
      attributevalue: present(row.attributevalue) ? row.attributevalue : null,
      datetimevalue: present(row.datetimevalue) ? row.datetimevalue : null,
      numericvalue: present(row.numericvalue) ? row.numericvalue : null,
      stringvalue: present(row.stringvalue) ? left(row.stringvalue ?? '', 250) : null,
      remoteid: remoteId,
    });
  }
  // Unsubmitted non-File attributes of the submitted sets.
  for (const row of details) {
    const attribute = attributes.get(row.attributeid);
    if (!subtypeMatches(row) || (hasSets && !inSets(row)) || isFile(attribute) || attribute === undefined || !siteMatches(attribute)) continue;
    if (data.has(`ext${row.attributeid}`) || data.has((row.name ?? '').toLowerCase())) continue;
    rows.push({
      attributeid: row.attributeid,
      siteid: row.siteid,
      attributevalue: present(row.attributevalue) ? row.attributevalue : null,
      datetimevalue: present(row.datetimevalue) ? row.datetimevalue : null,
      numericvalue: present(row.numericvalue) ? row.numericvalue : null,
      stringvalue: present(row.stringvalue) ? row.stringvalue : null,
      remoteid: remoteId,
    });
  }
  // Stored files of the submitted sets that were neither replaced nor deleted.
  for (const row of details) {
    const attribute = attributes.get(row.attributeid);
    if (!subtypeMatches(row) || (hasSets && !inSets(row)) || !isFile(attribute)) continue;
    const name = (row.name ?? '').toLowerCase();
    const key = `ext${row.attributeid}`;
    const touched =
      (given(data, key) && dataText(data, key) !== '') ||
      (given(data, name) && dataText(data, name) !== '') ||
      data.has(`extdelete${row.attributeid}`) ||
      data.has(`extdelete${name}`);
    if (touched || !present(row.attributevalue)) continue;
    rows.push({
      attributeid: row.attributeid,
      siteid: row.siteid,
      attributevalue: row.attributevalue,
      stringvalue: present(row.stringvalue) ? row.stringvalue : null,
      remoteid: remoteId,
    });
  }
  if (rows.length > 0) await repo.extend.insertExtendData(scope.tx, baseId, rows, scope.write);
}

/** contentManager.add's order number (contentManager.cfc:1537-1577) for a new or moved item. */
async function persistOrderNo(state: SaveState): Promise<void> {
  const { scope, bean, data } = state;
  const repo = scope.deps.repository;
  const current = state.current;
  const isNew = bean.isNew === 1;
  const parentChanged = !isNew && current !== null && !cfEq(bean.text('parentid'), current.text('parentid'));
  if (!(isNew || (cfBool(bean.get('approved')) && parentChanged))) return;
  const siblings = { parentId: bean.text('parentid'), siteId: bean.text('siteid') };
  const placement = given(data, 'toporbottom') ? dataText(data, 'toporbottom') : 'Top';
  if (cfEq(placement, 'Top')) {
    state.written.push(...(await repo.content.shiftSiblingOrder(scope.tx, { ...siblings, delta: 1 }, scope.write)));
    bean.setValue('orderno', 1);
  } else if (cfEq(placement, 'bottom')) {
    if (!isNew && current !== null && !parentChanged) {
      state.written.push(
        ...(await repo.content.shiftSiblingOrder(scope.tx, { ...siblings, delta: -1, orderNoAbove: current.number('orderno') }, scope.write)),
      );
    }
    const bottom = await repo.content.maxSiblingOrderNo(scope.tx, siblings);
    bean.setValue('orderno', bottom === null ? 1 : bottom + 1);
  }
  if (parentChanged) {
    state.written.push(...(await repo.content.reparentInactive(scope.tx, { contentId: bean.contentId(), ...siblings }, scope.write)));
  }
}

/** `arguments.data.<key>`, raising ACF's error (the key as the source spells it) when the data lacks it. */
function requiredText(data: ReadonlyMap<string, unknown>, sourceKey: string): string {
  const key = sourceKey.toLowerCase();
  if (!given(data, key)) throw new UndefinedLegacyElementError(`Element DATA.${sourceKey} is undefined in ARGUMENTS.`);
  return dataText(data, key);
}

/** contentUtility.sendNotices (contentUtility.cfc:547-693): the draft assignments, and the review mail as notices (never sent). */
async function sendNotices(state: SaveState): Promise<void> {
  const { scope, bean, data } = state;
  const context = state.opts.notify;
  if (context === undefined) throw new Error('A save with `notify` needs the recipients identity resolves (SaveContentOptions.notify)');
  const repo = scope.deps.repository;
  const versionId = cfUuid();
  const historyId = cfUuid();
  let crumbStr = '';
  // listFind: case-sensitive.
  if (['Folder', 'Page', 'Calendar', 'Gallery', 'Link', 'File'].includes(bean.text('type')) && !cfEq(bean.contentId(), HOME_ID)) {
    const crumbs = await repo.content.crumbPath(scope.tx, { contentId: bean.text('parentid'), siteId: bean.text('siteid') });
    const root = crumbs.at(-1);
    if (root === undefined) throw new Error('The element at position 0 of dimension 1, of array variable "CRUMBDATA," cannot be found.');
    crumbStr = [...crumbs].reverse().map((crumb) => crumb.menutitle ?? '').join(' > ');
    crumbStr = `${crumbStr} > ${bean.text('menutitle')}`;
  } else if (cfEq(bean.contentId(), HOME_ID)) {
    crumbStr = bean.text('menutitle');
  }
  // The version and history links go to `tredirects` (identity's); the URL keys they need are still dereferenced.
  const compact = (given(data, 'compactdisplay') && cfEq(dataText(data, 'compactdisplay'), 'true')) || (given(data, 'closecompactdisplay') && cfEq(dataText(data, 'closecompactdisplay'), 'true'));
  const versionLinkKeys = compact ? ['siteID', 'siteid'] : ['siteID', 'parentid', 'topid', 'siteid', 'moduleid', 'type', 'ptype'];
  const historyLinkKeys = ['siteID', 'parentid', 'topid', 'siteid', 'moduleid', 'type'];
  for (const key of [...(context.withVersionLink ? versionLinkKeys : []), ...historyLinkKeys]) requiredText(data, key);

  const urls = scope.site.urls;
  const link = (redirectId: string): string => `${urls.scheme}://${context.host}${urls.serverPort}${urls.context}${getUrlStem(urls, bean.text('siteid'), redirectId)}`;
  const location = crumbStr !== '' ? `\nLOCATION: ${crumbStr}` : '';
  const subject = `Site Content Review for ${scope.site.urls.domain.toUpperCase()}`;
  for (const recipient of context.recipients) {
    await repo.content.insertContentAssignment(
      scope.tx,
      { contentid: bean.contentId(), contenthistid: bean.contentHistId(), siteid: bean.text('siteid'), userid: recipient.userId, type: 'draft' },
      scope.write,
    );
    if (recipient.email === '') continue;
    const [historyLabel, versionLabel] = scope.actor.isLoggedIn ? ['VIEW VERSION HISTORY:', 'VIEW EDITED VERSION:'] : ['HISTORY LINK:', 'VERSION LINK:'];
    const body =
      `\n${requiredText(data, 'message')}\n\nTITLE: ${bean.text('title')}\nTYPE: ${bean.text('type')} / ${bean.text('subtype')}${location}\n` +
      `AUTHOR: ${bean.text('lastupdateby')}\n\n${historyLabel}\n${link(historyId)}\n` +
      (context.withVersionLink ? `\n${versionLabel}\n${link(versionId)}\n` : '');
    state.notices.push({
      kind: 'content-notify',
      to: recipient.email,
      from: scope.actor.isLoggedIn ? `${context.sender.fname} ${context.sender.lname}` : (scope.site.mailServerUsernameEmail ?? ''),
      subject,
      body,
      siteId: bean.text('siteid'),
    });
  }
}

/** contentDAO.createTags (contentDAO.cfc:1034-1082): the `tags` list, then each custom tag group's. */
async function persistTags(state: SaveState): Promise<void> {
  const { scope, bean } = state;
  const rows: ContentTagInput[] = [];
  const base = { contentid: bean.contentId(), siteid: bean.text('siteid') };
  for (const tag of cfListToArray(bean.text('tags'))) {
    if (cfTrim(tag) !== '') rows.push({ ...base, tag: cfTrim(tag), taggroup: null });
  }
  for (const group of tagGroups(scope.site)) {
    for (const tag of cfListToArray(bean.text(`${group}tags`))) {
      if (cfTrim(tag) !== '') rows.push({ ...base, tag: cfTrim(tag), taggroup: group });
    }
  }
  if (rows.length > 0) await scope.deps.repository.content.replaceTags(scope.tx, bean.contentHistId(), rows, scope.write);
}

/** contentManager.add's cftransaction block (contentManager.cfc:1223-1592), ending with the version insert. */
async function writeVersion(state: SaveState): Promise<void> {
  const { scope, bean } = state;
  const repo = scope.deps.repository;
  const config = scope.deps.config;
  const isNew = bean.isNew === 1;
  const type = bean.text('type');

  await persistCategories(state);
  await persistPath(state);
  if (!cfEq(type, 'Module')) {
    await persistExpiryAssignments(state);
    // REMINDER_UPDATES_UNBUILT: tcontenteventreminders is a decision-list table with no target table.
    if (isNew && given(state.data, 'email') && given(state.data, 'approvalqueue') && cfBool(state.data.get('approvalqueue'))) {
      try {
        await repo.approvalQueues.insertSubmissionApproval(scope.tx, { contentId: bean.contentId(), email: dataText(state.data, 'email'), siteId: bean.text('siteid') }, scope.write);
      } catch {
        // contentManager.cfc:1276-1280 swallows every setApprovalQue failure.
      }
    }
    // checkApprovalQue looks its queue rows up by the new version id, which no row holds, and its mail argument names
    // the undefined `rsemail` either way, so its cftry always ends without a write.
    await detachChangesets(state);
    await persistFilename(state);
    await persistObjects(state);
  }
  if (cfBool(bean.get('approved')) || isNew) {
    if (inList(TITLE_DERIVED_TYPES, type)) {
      bean.setValue('menutitle', bean.text('title'));
      bean.setValue('htmltitle', bean.text('title'));
      bean.setValue('urltitle', bean.text('title'));
      bean.setValue('isnav', 1);
    }
  }
  await persistFiles(state);
  if (inList(EXTENDABLE_TYPES, type)) {
    if (dataText(state.data, 'extendsetid') !== '') await saveExtendedData(state, bean.contentHistId());
    if (!isNew && state.current !== null) await preserveExtendedData(state, bean.contentHistId(), state.current.contentHistId(), type, bean.text('subtype'));
  }
  if (cfBool(bean.get('approved')) && !isNew) {
    bean.setValue('active', 1);
    state.written.push(...(await repo.content.archiveActive(scope.tx, { contentId: bean.contentId(), siteId: dataText(state.data, 'siteid') }, scope.write)));
    state.deleteDraftHistAll = config.purgeDrafts;
    state.trimVersionHistory = config.maxArchivedVersions > 0;
    await repo.content.deleteContentAssignments(scope.tx, { id: bean.contentId(), siteId: dataText(state.data, 'siteid'), type: 'draft' }, scope.write);
  }
  await persistOrderNo(state);
  if (given(state.data, 'notify') && dataText(state.data, 'notify') !== '') await sendNotices(state);
  await persistTags(state);
  state.written.push(await repo.content.insertVersion(scope.tx, bean.toVersionInput(), scope.write));
}

// ---- contentManager.add: after the transaction block ----

/** The options a save made by a save (a related-content folder or link) inherits. */
function nestedOptions(opts: SaveContentOptions): SaveContentOptions {
  const { files: _files, notify: _notify, approvingChainRequest: _chain, ...inherited } = opts;
  return inherited;
}

/** A save made inside a save, its rows and mail added to the outer one's. */
async function nestedSave(state: SaveState, bean: LegacyContentBean): Promise<LegacyContentBean> {
  const { scope } = state;
  const result = await saveContentInTx(scope.tx, scope.deps, scope.actor, scope.site, bean, nestedOptions(state.opts));
  state.written.push(...result.written);
  state.notices.push(...result.notices);
  if (result.afterCommitError !== undefined) throw new ErrorAfterWrites(result.afterCommitError);
  return result.bean;
}

/** createRelatedItems' `<filename>/related-content` folder, created under the item when missing (contentDAO.cfc:1299-1313). */
async function relatedContentFolder(state: SaveState): Promise<LegacyContentBean> {
  const { scope, bean } = state;
  const siteId = bean.text('siteid');
  const [row] = await scope.deps.repository.content.readActiveByFilename(scope.tx, { siteId, filename: `${bean.text('filename')}/related-content` });
  if (row !== undefined) return beanOf(scope, row);
  const folder = LegacyContentBean.notFound(scope.actor, scope.now, siteId);
  folder.setValue('title', 'Related Content');
  folder.setValue('siteid', siteId);
  folder.setValue('parentid', bean.contentId());
  folder.setValue('type', 'Folder');
  folder.setValue('isnav', 0);
  folder.setValue('searchexclude', 1);
  folder.setValue('approved', 1);
  return nestedSave(state, folder);
}

/** createRelatedItems' Link for a `{url, title}` item, reusing the folder's active Link of that body (contentDAO.cfc:1315-1337). */
async function saveRelatedLink(state: SaveState, folder: LegacyContentBean, item: Readonly<Record<string, unknown>>): Promise<string> {
  const { scope, bean } = state;
  const url = member(item, 'url');
  if (url === undefined) throw new UndefinedLegacyElementError('Element URL is undefined in a CFML structure referenced as part of an expression.');
  const [found] = await scope.deps.repository.content.activeLinksByBody(scope.tx, {
    parentId: folder.contentId(),
    siteId: folder.text('siteid'),
    bodyLike: cfText(url),
  });
  const link = found === undefined ? LegacyContentBean.init(scope.actor, scope.now) : await readBean(scope, { siteId: found.siteid ?? '', contentHistId: found.contenthistid });
  link.setValue('body', url);
  link.setValue('title', member(item, 'title') ?? '');
  link.setValue('type', 'Link');
  link.setValue('isnav', 0);
  link.setValue('parentid', folder.contentId());
  link.setValue('searchexclude', 1);
  link.setValue('siteid', bean.text('siteid'));
  link.setValue('approved', 1);
  return (await nestedSave(state, link)).contentId();
}

/** contentDAO.createRelatedItems (contentDAO.cfc:1244-1376): submitted sets from `relatedContentSetData`, the others copied from the source. */
async function persistRelatedItems(state: SaveState, sourceHistId: string): Promise<void> {
  const { scope, bean, data } = state;
  const repo = scope.deps.repository;
  const raw = data.get('relatedcontentsetdata');
  let submitted: unknown[] = [];
  if (given(data, 'relatedcontentsetdata') && ((Array.isArray(raw) && raw.length >= 1) || isJson(raw))) {
    const parsed: unknown = isJson(raw) ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) throw new Error('Object of type class coldfusion.runtime.Struct cannot be used as an array');
    submitted = parsed;
  }
  const rows: RelatedItemInput[] = [];
  let folder: LegacyContentBean | undefined;
  for (const set of await relatedContentSets(scope, bean)) {
    const rcs = submitted.find((entry) => {
      if (!isPlainObject(entry) || member(entry, 'relatedcontentsetid') === undefined) {
        throw new UndefinedLegacyElementError('Element RELATEDCONTENTSETID is undefined in a CFML structure referenced as part of an expression.');
      }
      return cfEq(set.relatedcontentsetid, cfText(member(entry, 'relatedcontentsetid')));
    });
    if (rcs !== undefined && isPlainObject(rcs)) {
      const setId = cfText(member(rcs, 'relatedcontentsetid'));
      const items = member(rcs, 'items');
      if (!Array.isArray(items)) throw new Error('Object of type class java.lang.String cannot be used as an array');
      const listed: string[] = [];
      for (const [index, item] of items.entries()) {
        let relatedId: string;
        if (isPlainObject(item)) {
          folder ??= await relatedContentFolder(state);
          relatedId = await saveRelatedLink(state, folder, item);
        } else {
          relatedId = cfText(item);
        }
        if (listed.some((id) => cfEq(id, relatedId))) continue;
        rows.push({ contentid: bean.contentId(), relatedid: relatedId, relatedcontentsetid: setId, orderno: index + 1 });
        listed.push(relatedId);
      }
    } else if (sourceHistId !== '') {
      const old = await repo.content.relatedItems(scope.tx, { contentHistId: sourceHistId, siteId: bean.text('siteid'), relatedContentSetId: set.relatedcontentsetid });
      rows.push(...old.map((row) => ({ contentid: bean.contentId(), relatedid: row.relatedid, relatedcontentsetid: row.relatedcontentsetid, orderno: row.orderno })));
    }
  }
  if (rows.length > 0) await repo.content.replaceRelatedItems(scope.tx, bean.contentHistId(), bean.text('siteid'), rows, scope.write);
}

/** The metadata columns contentFileMetaDataBean.set takes from a `fileMetaDataAssign` entry. */
function fileMetaValues(entry: Readonly<Record<string, unknown>>): FileMetaDataValues {
  const values: FileMetaDataValues = {};
  const text = (key: string): string | undefined => {
    const value = member(entry, key);
    return value === undefined ? undefined : cfText(value);
  };
  for (const key of ['alttext', 'caption', 'credits', 'remoteid', 'remoteurl', 'remotesource', 'remotesourceurl'] as const) {
    const value = text(key);
    if (value !== undefined) values[key] = value;
  }
  const pubDate = member(entry, 'remotepubdate');
  if (pubDate !== undefined) values.remotepubdate = asDate(pubDate);
  const exif = member(entry, 'exif');
  if (exif !== undefined) values.exif = isSimple(exif) ? cfText(exif) : JSON.stringify(exif);
  return values;
}

/** contentManager.add's fileMetaDataAssign loop (contentManager.cfc:1630-1646); returns the file ids it handled. */
async function persistFileMetaData(state: SaveState, saved: LegacyContentBean): Promise<Set<string>> {
  const { scope } = state;
  const handled = new Set<string>();
  let assign: unknown = state.data.get('filemetadataassign') ?? '';
  if (isJson(assign)) assign = JSON.parse(assign);
  if (!isPlainObject(assign)) return handled;
  for (const [property, entry] of Object.entries(assign)) {
    const values = isPlainObject(entry) ? entry : {};
    const fileId = saved.text(property);
    await inFilePool(scope, (fileTx) =>
      saveFileMetaData(
        scope.tx,
        scope.deps.repository,
        {
          contentId: saved.contentId(),
          contentHistId: saved.contentHistId(),
          siteId: saved.text('siteid'),
          fileId,
          values: fileMetaValues(values),
          setAsDefault: cfBool(member(values, 'setasdefault') ?? false),
        },
        { fileTx, write: scope.write },
      ),
    );
    handled.add(sqlKey(fileId));
  }
  return handled;
}

/** contentManager.delete inside a write (contentManager.cfc:1956-2005): the version's file unless another version uses it, then its rows. */
async function deleteVersionInTx(scope: WriteScope, contentHistId: string, siteId: string): Promise<void> {
  const repo = scope.deps.repository;
  const [version] = await repo.content.readVersion(scope.tx, { contentHistId });
  const fileId = version?.fileid ?? '';
  if (version !== undefined && fileId !== '') {
    const others = (await repo.content.hist(scope.tx, { contentId: version.contentid ?? '', siteId }))
      .filter((row) => (row.fileid ?? '') !== '' && sqlKey(row.contenthistid) !== sqlKey(contentHistId))
      .map((row) => row.fileid ?? '');
    // listFind: exact match within the `^` list.
    if (!others.includes(fileId)) await inFilePool(scope, (fileTx) => deleteFileVersion(fileTx, repo, fileId, scope.write));
  }
  const removed = await repo.content.deleteVersion(scope.tx, { contentHistId, siteId }, scope.write);
  await deleteFilesIfNotUsed(scope, removed.extendFileIds, [contentHistId]);
}

/** contentManager.trimArchiveHistory (contentManager.cfc:2986-3007): archived versions past `maxArchivedVersions` are deleted. */
async function trimArchiveHistory(scope: WriteScope, contentId: string, siteId: string): Promise<void> {
  const limit = scope.deps.config.maxArchivedVersions;
  const archived = (await scope.deps.repository.content.hist(scope.tx, { contentId, siteId })).filter((row) => row.approved === 1 && row.active !== null && row.active !== 1);
  for (const row of archived.slice(limit)) await deleteVersionInTx(scope, row.contenthistid ?? '', siteId);
}

/** contentManager.add after its cftransaction (contentManager.cfc:1594-1747), in the same target transaction. */
async function finishSave(state: SaveState, initJs: string): Promise<SaveContentResult> {
  const { scope, bean, data } = state;
  const { tx, deps, actor } = scope;
  const repo = deps.repository;
  const siteId = bean.text('siteid');
  const isNew = bean.isNew === 1;
  const sourceHistId = isNew ? '' : (state.current?.contentHistId() ?? '');

  await persistRelatedItems(state, sourceHistId);
  if (state.doSaveApproval && state.approvalRequest !== null) {
    state.approvalRequest = await saveRequest(tx, repo, state.approvalRequest, actor, scope.site);
  }
  await repo.content.insertSourceMap(
    tx,
    { contenthistid: bean.contentHistId(), sourceid: dataText(data, 'sourceid'), siteid: siteId, contentid: bean.contentId(), created: scope.now },
    scope.write,
  );
  const fromMuraTrash = bean.has('frommuratrash');
  const saved = await readBean(scope, { siteId, contentHistId: bean.contentHistId() });
  if (fromMuraTrash) saved.put('fromMuraTrash', true);
  state.saved = saved;
  const handled = await persistFileMetaData(state, saved);
  if (!isNew && state.current !== null) {
    // persistToVersion keeps a metadata row whose file a simple value of the new version names and the loop above did not handle.
    const fileIds = saved
      .entries()
      .map(([, value]) => value)
      .filter((value): value is string => typeof value === 'string' && value !== '' && !handled.has(sqlKey(value)));
    await repo.content.persistVersionedObjects(tx, state.current.contentHistId(), saved.contentHistId(), { fileIds }, scope.write);
  }
  if (state.deleteDraftHistAll) {
    const removed = await repo.content.deleteDraftHistAll(tx, { contentId: saved.contentId(), siteId }, scope.write);
    await deleteFilesIfNotUsed(scope, removed.extendFileIds, removed.versions.map((row) => row.contenthistid ?? ''));
  }
  if (state.trimVersionHistory) await trimArchiveHistory(scope, saved.contentId(), siteId);
  for (const changesetId of [state.previousChangesetId, ...(cfEq(saved.text('changesetid'), state.previousChangesetId) ? [] : [saved.text('changesetid')])]) {
    if (changesetId === '') continue;
    const changeset = await readChangesetInTx(tx, repo, { changesetId, siteId }, actor, deps.clock);
    await saveChangesetInTx(tx, repo, changeset, actor, scope.write);
  }
  for (const requestId of state.approvalsToCancel) {
    const request = await loadRequest(tx, repo, { requestId });
    // approvalRequestBean.cancel(comments) is called without its argument, so a Pending request fails reading it.
    if (cfEq(request.values.status, PENDING_STATUS)) {
      throw new ErrorAfterWrites(new UndefinedLegacyElementError('Element COMMENTS is undefined in ARGUMENTS.'));
    }
  }
  if (cfBool(saved.get('approved')) && inList(ARCHIVED_FILENAME_TYPES, saved.text('type'))) {
    await repo.content.saveFilenameArchive(tx, { filename: saved.text('filename'), siteId, contentId: saved.contentId() }, scope.write);
  }
  takeOut(Object.fromEntries(saved.entries()));
  saved.isNew = 0;
  if (initJs !== '') {
    const stored = await repo.variation.targetingFor(tx, { contentId: saved.contentId(), siteId });
    await repo.variation.upsertTargeting(
      tx,
      {
        targetingid: stored?.targetingid ?? cfUuid(),
        contentid: stored?.contentid ?? saved.contentId(),
        siteid: stored?.siteid ?? siteId,
        initjs: initJs,
        targetingjs: stored?.targetingjs ?? '',
      },
      scope.write,
    );
  }
  assertStartupSafe(state.written);
  return { bean: saved, errors: {}, notices: state.notices, refused: false, written: state.written };
}

// ---- wrappers ----

/** `input` with `key` set, replacing any other casing of it (CFML struct keys ignore case). */
function withValue(input: ContentInput | LegacyContentBean, key: string, value: unknown): ContentInput | LegacyContentBean {
  if (input instanceof LegacyContentBean) {
    input.setValue(key, value);
    return input;
  }
  const copy: ContentInput = {};
  for (const [name, item] of Object.entries(input)) {
    if (name.toLowerCase() !== key.toLowerCase()) copy[name] = item;
  }
  copy[key] = value;
  return copy;
}

/** The reads a save makes outside its transaction: the actor's memberships and the category pool. */
async function preparedOptions(deps: ContentDeps, actor: Actor, opts: SaveContentOptions): Promise<SaveContentOptions> {
  return {
    ...opts,
    memberships: opts.memberships ?? (await loadMemberships(deps, actor)),
    poolCategories: opts.poolCategories ?? (await listPoolCategories(deps, actor)),
  };
}

/** Raises the error legacy raised after committing the writes the result holds. */
function settle<T extends { afterCommitError?: Error }>(result: T): T {
  if (result.afterCommitError !== undefined) throw result.afterCommitError;
  return result;
}

/** contentManager.add in one gated transaction of the token's tenant; an error legacy raises after its commit is raised after this one's. */
export async function saveContent(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: ContentInput | LegacyContentBean,
  opts: SaveContentOptions = {},
): Promise<SaveContentResult> {
  const prepared = await preparedOptions(deps, actor, opts);
  return settle(await withGatedTenant(deps.db, actor.tenantId, (tx) => saveContentInTx(tx, deps, actor, site, input, prepared)));
}

/** A save as a draft (`approved = 0`). */
export function saveDraft(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: ContentInput | LegacyContentBean,
  opts: SaveContentOptions = {},
): Promise<SaveContentResult> {
  return saveContent(deps, actor, site, withValue(input, 'approved', 0), opts);
}

/** A save as published (`approved = 1`). */
export function publish(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: ContentInput | LegacyContentBean,
  opts: SaveContentOptions = {},
): Promise<SaveContentResult> {
  return saveContent(deps, actor, site, withValue(input, 'approved', 1), opts);
}

/** How a version is activated: by an approval chain's last approval, or by a change set's publish. */
export interface ApproveVersionOptions extends SaveContentOptions {
  /** changesetManager.publish's `setApprovalChainOverride(true)`. */
  approvalChainOverride?: boolean;
}

/** Activates version `contentHistId` in `tx` (`approved = 1`), as an approval-chain approval or a change-set publish saves it. */
export async function approveVersion(
  tx: TenantTx,
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  contentHistId: string,
  opts: ApproveVersionOptions = {},
): Promise<SaveContentResult> {
  const { approvalChainOverride, ...saveOpts } = opts;
  const scope = scopeOf(tx, deps, actor, site, saveOpts);
  const version = await readBean(scope, { siteId: site.siteId, contentHistId });
  version.setValue('approved', 1);
  if (approvalChainOverride === true) version.setValue('approvalChainOverride', true);
  if (saveOpts.approvingChainRequest === true) version.setValue('approvingChainRequest', true);
  return saveContentInTx(tx, deps, actor, site, version, saveOpts);
}

// ---- version deletes ----

/** contentManager.delete (contentManager.cfc:1956-2005) of one version, in one gated transaction. */
export function deleteVersion(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  args: { contentHistId: string; siteId: string },
  opts: Pick<SaveContentOptions, 'requestId'> = {},
): Promise<void> {
  return withGatedTenant(deps.db, actor.tenantId, (tx) => deleteVersionInTx(scopeOf(tx, deps, actor, site, opts), args.contentHistId, args.siteId));
}

/**
 * contentManager.deleteHistAll (contentManager.cfc:1874-1954): the version history except the active, pending-approval
 * and pending-change-set versions; files only removed versions use are deleted.
 */
export function deleteHistAll(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  args: { contentId: string; siteId: string },
  opts: Pick<SaveContentOptions, 'requestId'> = {},
): Promise<void> {
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const scope = scopeOf(tx, deps, actor, site, opts);
    const repo = deps.repository;
    const current = await readBean(scope, { siteId: args.siteId, contentId: args.contentId });
    const hist = await repo.content.hist(tx, args);
    const pending = await repo.content.pendingChangesets(tx, args);
    // listFind: exact matches in a list whose empty elements are skipped.
    const kept = [current.text('fileid'), ...pending.map((row) => row.fileid ?? '')].filter((id) => id !== '');
    const deletedFiles: string[] = [];
    const deletedVersions: string[] = [];
    for (const row of hist) {
      const fileId = row.fileid ?? '';
      const keep = cfEq(row.approvalstatus ?? '', PENDING_STATUS) || row.active === 1 || (row.approved === 0 && (row.changesetid ?? '') !== '');
      if (keep || fileId === '' || kept.includes(fileId)) continue;
      await inFilePool(scope, (fileTx) => deleteFileVersion(fileTx, repo, fileId, scope.write));
      kept.push(fileId);
      deletedFiles.push(fileId);
      deletedVersions.push(row.contenthistid ?? '');
    }
    await deleteFilesIfNotUsed(scope, deletedFiles, deletedVersions);
    const removed = await repo.content.deleteHistAll(tx, args, scope.write);
    await deleteFilesIfNotUsed(scope, removed.extendFileIds, removed.versions.map((row) => row.contenthistid ?? ''));
  });
}

// ---- deleteAll ----

/** ACF serializeJSON of a string: `/` and control characters escaped as well as quotes and backslashes. */
function acfJsonString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === '\\' || ch === '/') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** contentManager.formatRegionObjectsString (contentManager.cfc:894-903): a region's `[object, name, objectid, params]` rows as JSON. */
function regionObjectsString(rows: ReadonlyArray<{ object: string | null; name: string | null; objectid: string | null; params: string | null }>): string {
  return `[${rows.map((row) => `[${[row.object, row.name, row.objectid, row.params].map((cell) => acfJsonString(cell ?? '')).join(',')}]`).join(',')}]`;
}

/** A bean value as cfwddx writes it. */
function toWddx(value: unknown): WddxValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return wddxNumber(value);
  if (value instanceof Date) return new WddxDate(value);
  if (value instanceof WddxNumber || value instanceof WddxDate) return value;
  if (Array.isArray(value)) return value.map((item) => toWddx(item));
  if (isWddxQuery(value)) return value;
  if (isPlainObject(value)) {
    if (value.kind === 'struct' && Array.isArray(value.entries)) return value as unknown as WddxValue;
    return cfStruct(Object.entries(value).map(([key, item]) => [key, toWddx(item)] as const));
  }
  return cfText(value);
}

/** CategoryRow columns getCategoriesByHistID joins onto each assignment. */
type PoolCategory = Pick<CategoryRow, 'categoryid' | 'name' | 'filename' | 'parentid' | 'path'>;

/** contentGateway.getCategoriesByHistID (contentGatewayAdobe.cfc:2139-2152) as the query trashManager stores. */
async function categoriesQuery(scope: WriteScope, contentHistId: string, pool: readonly PoolCategory[]): Promise<WddxQuery> {
  const byId = new Map(pool.map((row) => [sqlKey(row.categoryid), row] as const));
  const assigned = (await scope.deps.repository.content.categoryAssignments(scope.tx, { contentHistId }))
    .map((row) => ({ row, category: byId.get(sqlKey(row.categoryid)) }))
    .filter((pair): pair is { row: CategoryAssignmentRow; category: PoolCategory } => pair.category !== undefined)
    .sort((a, b) => (a.category.filename ?? '').toLowerCase().localeCompare((b.category.filename ?? '').toLowerCase()));
  const text = (value: string | null): WddxValue => value;
  const number = (value: number | null): WddxValue => (value === null ? null : wddxNumber(value));
  const date = (value: Date | null): WddxValue => (value === null ? null : new WddxDate(value));
  return {
    kind: 'query',
    columns: ['contentHistID', 'categoryID', 'contentID', 'isFeature', 'orderno', 'siteID', 'featureStart', 'featureStop', 'name', 'filename', 'parentid', 'path'],
    rows: assigned.map(({ row, category }) => ({
      contentHistID: text(row.contenthistid),
      categoryID: text(row.categoryid),
      contentID: text(row.contentid),
      isFeature: number(row.isfeature),
      orderno: number(row.orderno),
      siteID: text(row.siteid),
      featureStart: date(row.featurestart),
      featureStop: date(row.featurestop),
      name: text(category.name),
      filename: text(category.filename),
      parentid: text(category.parentid),
      path: text(category.path),
    })),
  };
}

/** trashManager.throwIn's content values (trashManager.cfc:193-221): regions 1-8, live related ids and categories, then getAllValues(). */
async function contentTrashValues(scope: WriteScope, bean: LegacyContentBean, pool: readonly PoolCategory[]): Promise<WddxStruct> {
  const repo = scope.deps.repository;
  const histId = bean.contentHistId();
  const regions: string[] = [];
  for (let region = 1; region <= 8; region += 1) {
    regions.push(regionObjectsString(await repo.content.regionObjects(scope.tx, { contentHistId: histId, columnId: region, siteId: bean.text('siteid') })));
  }
  const related = await repo.content.relatedContent(scope.tx, { siteId: bean.text('siteid'), contentHistId: histId, today: scope.now });
  if (related.length > 0) bean.setValue('relatedContentID', related.map((row) => row.contentid ?? '').join(','));
  bean.setValue('categoriesFromMuraTrash', await categoriesQuery(scope, histId, pool));
  await autocompleteExtendData(scope, bean);
  regions.forEach((json, index) => bean.put(`objectlist${index + 1}`, json));
  return cfStruct(bean.entries().map(([key, value]) => [key, toWddx(value)] as const));
}

/** The outcome of contentManager.deleteAll: legacy's `cfabort` for the home page, else the `topid` to redirect to. */
export type DeleteAllResult = { aborted: true } | { aborted: false; topId: string };

/** contentManager.deleteAll arguments; `markers` are a parent call's muraDeleteDateTime and muraDeleteID. */
export interface DeleteAllArgs {
  contentId: string;
  siteId: string;
  topId?: string;
  markers?: Partial<DeleteMarkers>;
}

/** One deleteAll call of the recursion, sharing the request's markers and trash counter. */
async function deleteAllInTx(scope: WriteScope, args: DeleteAllArgs, markers: DeleteMarkers, counter: TrashRequestCounter, pool: readonly PoolCategory[]): Promise<DeleteAllResult> {
  const repo = scope.deps.repository;
  if (cfEq(args.contentId, HOME_ID)) return { aborted: true };
  for (const childId of await repo.content.activeChildIds(scope.tx, { parentId: args.contentId })) {
    await deleteAllInTx(scope, { contentId: childId, siteId: args.siteId }, markers, counter, pool);
  }
  const current = await readBean(scope, { siteId: args.siteId, contentId: args.contentId });
  for (const [key, value] of deleteMarkerAssignments(markers)) current.setValue(key, value);
  if (cfEq(current.contentId(), HOME_ID)) return { aborted: false, topId: current.contentId() };
  if (current.number('islocked') !== 1) {
    const values = await contentTrashValues(scope, current, pool);
    await throwIn(
      scope.tx,
      repo,
      {
        objectClass: 'content',
        objectId: current.contentId(),
        parentId: deletedParentId(values),
        siteId: current.text('siteid') !== '' ? current.text('siteid') : scope.actor.siteId,
        label: current.text('title'),
        objectType: trashObjectType(values, 'content'),
        objectSubType: trashObjectSubType(values),
        values,
        deletedDate: markers.deletedDate,
        deleteId: markers.deleteId,
      },
      scope.actor,
      counter,
      scope.write,
    );
    if (current.text('fileid') !== '' || cfEq(current.text('type'), 'Form')) {
      await inFilePool(scope, (fileTx) => deleteAllFiles(scope.tx, repo, current.contentId(), { fileTx, write: scope.write }));
    }
    const removed = await repo.content.deleteContent(
      scope.tx,
      { contentId: current.contentId(), siteId: current.text('siteid'), parentId: current.text('parentid'), type: current.text('type') },
      scope.write,
    );
    await deleteFilesIfNotUsed(scope, removed.extendFileIds, removed.versions.map((row) => row.contenthistid ?? ''));
  }
  if (args.topId !== undefined) return { aborted: false, topId: cfEq(args.topId, current.contentId()) ? current.text('parentid') : args.topId };
  return { aborted: false, topId: current.text('parentid') };
}

/**
 * contentManager.deleteAll (contentManager.cfc:1763-1872) in one gated transaction: the active children first, each
 * unlocked item thrown in the trash under one delete id and counter, then its files and rows.
 */
export async function deleteAll(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  args: DeleteAllArgs,
  opts: Pick<SaveContentOptions, 'requestId' | 'rbKey' | 'memberships'> = {},
): Promise<DeleteAllResult> {
  if (cfEq(args.contentId, HOME_ID)) return { aborted: true };
  const pool = await listPoolCategories(deps, actor);
  const memberships = opts.memberships ?? (await loadMemberships(deps, actor));
  return withGatedTenant(deps.db, actor.tenantId, (tx) => {
    const scope = scopeOf(tx, deps, actor, site, { ...opts, memberships });
    return deleteAllInTx(scope, args, deleteMarkers(scope.now, args.markers), createTrashCounter(), pool);
  });
}

// ---- copy ----

/** contentUtility.copy arguments; `appendTitle` defaults to true, `recurse` and `setNotOnDisplay` to false. */
export interface CopyContentArgs {
  siteId: string;
  contentId: string;
  parentId: string;
  recurse?: boolean;
  appendTitle?: boolean;
  setNotOnDisplay?: boolean;
}

/** contentUtility.copy (contentUtility.cfc:957-1096) in `scope`'s transaction; `path` is the copied parent's. */
async function copyInTx(scope: WriteScope, opts: SaveContentOptions, args: CopyContentArgs, path: string): Promise<LegacyContentBean> {
  const repo = scope.deps.repository;
  const { siteId, contentId, parentId } = args;
  const source = await readBean(scope, { siteId, contentId });
  if (cfEq(contentId, parentId)) return source;
  await autocompleteExtendData(scope, source);
  const sourceHistId = source.contentHistId();
  source.isNew = 1;
  source.setValue('contentID', '');
  source.setValue('contentHistID', '');
  source.setValue('parentID', parentId);
  source.setValue('menuTitle', args.appendTitle ?? true ? `${source.text('menutitle')} - Copy` : source.text('menutitle'));
  if (args.setNotOnDisplay === true) source.setValue('display', 0);
  if (inList(FILENAME_COPY_TYPES, source.text('type'))) await setUniqueFilename(scope, source);
  else await setUniqueTitle(scope, source);
  source.setValue('path', cfListAppend(path, source.contentId()));
  source.setValue('created', scope.now);
  const result = await saveContentInTx(scope.tx, scope.deps, scope.actor, scope.site, source, nestedOptions(opts));
  if (result.afterCommitError !== undefined) throw new ErrorAfterWrites(result.afterCommitError);
  const copied = result.bean;
  const newHistId = copied.contentHistId();
  const newId = copied.contentId();
  const ofSource = (row: { siteid?: string | null; contentid?: string | null }): boolean =>
    sqlKey(row.siteid) === sqlKey(siteId) && sqlKey(row.contentid) === sqlKey(contentId);

  // The insert-selects append to whatever the save wrote for the new version.
  const assignments = [
    ...(await repo.content.categoryAssignments(scope.tx, { contentHistId: newHistId })),
    ...(await repo.content.categoryAssignments(scope.tx, { contentHistId: sourceHistId })).filter(ofSource).map((row) => ({ ...row, contentid: newId })),
  ].map((row) => assignmentInput(row));
  if (assignments.length > 0) await repo.content.replaceCategoryAssignments(scope.tx, newHistId, assignments, scope.write);
  const sourceRelated = await repo.content.relatedItems(scope.tx, { contentHistId: sourceHistId, siteId });
  if (sourceRelated.length > 0) {
    const related = [
      ...(await repo.content.relatedItems(scope.tx, { contentHistId: newHistId, siteId })).map((row) => ({ contentid: newId, ...row })),
      ...sourceRelated.map((row) => ({ contentid: newId, relatedid: row.relatedid, relatedcontentsetid: row.relatedcontentsetid, orderno: row.orderno })),
    ];
    await repo.content.replaceRelatedItems(scope.tx, newHistId, siteId, related, scope.write);
  }
  const sourceObjects = (await repo.content.contentObjects(scope.tx, { contentHistId: sourceHistId, siteId })).filter(ofSource);
  if (sourceObjects.length > 0) {
    const objectInput = (row: (typeof sourceObjects)[number]): ContentObjectInput => ({
      contentid: newId,
      siteid: row.siteid,
      object: row.object,
      name: row.name,
      objectid: row.objectid,
      orderno: row.orderno,
      columnid: row.columnid,
      params: row.params,
    });
    const objects = [...(await repo.content.contentObjects(scope.tx, { contentHistId: newHistId, siteId })), ...sourceObjects].map(objectInput);
    await repo.content.replaceObjects(scope.tx, newHistId, objects, scope.write);
  }
  // COPY_PERMISSIONS_UNBUILT: the tpermissions copy belongs to identity.
  const fileIds = copied
    .entries()
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string' && value !== '');
  await repo.content.persistVersionedObjects(scope.tx, sourceHistId, newHistId, { fileIds }, scope.write);

  if (args.recurse === true) {
    const sortBy = copied.text('sortby');
    const sortDirection = cfEq(sortBy, 'orderno') ? (cfEq(copied.text('sortdirection'), 'asc') ? 'desc' : copied.text('sortdirection')) : 'asc';
    for (const kid of await repo.content.nest(scope.tx, { parentId: contentId, siteId, sortBy, sortDirection })) {
      await copyInTx(
        scope,
        opts,
        { siteId, contentId: kid.contentid ?? '', parentId: newId, recurse: (kid.haskids ?? 0) !== 0, appendTitle: false, setNotOnDisplay: args.setNotOnDisplay ?? false },
        copied.text('path'),
      );
    }
  }
  return copied;
}

/** contentManager.copy (contentManager.cfc:2288-2298) in one gated transaction; returns the copy. */
export async function copy(deps: ContentDeps, actor: Actor, site: ContentSaveSite, args: CopyContentArgs, opts: SaveContentOptions = {}): Promise<LegacyContentBean> {
  const prepared = await preparedOptions(deps, actor, opts);
  const outcome = await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    try {
      return { bean: await copyInTx(scopeOf(tx, deps, actor, site, prepared), prepared, args, ''), afterCommitError: undefined };
    } catch (err) {
      if (err instanceof ErrorAfterWrites) return { bean: undefined, afterCommitError: err.error };
      throw err;
    }
  });
  if (outcome.afterCommitError !== undefined) throw outcome.afterCommitError;
  return outcome.bean;
}

// ---- carch quick edit and object params ----

/** `arguments.rc.<key>` in a controller, raising ACF's error (the key as the source spells it) when the request lacks it. */
function rcValue(rc: ReadonlyMap<string, unknown>, sourceKey: string): unknown {
  const key = sourceKey.toLowerCase();
  if (!given(rc, key)) throw new UndefinedLegacyElementError(`Element RC.${sourceKey} is undefined in ARGUMENTS.`);
  return rc.get(key);
}

/** A declared argument of a bean method called with `argumentCollection=rc`, raising ACF's error when it was not passed. */
function argValue(rc: ReadonlyMap<string, unknown>, name: string): unknown {
  const key = name.toLowerCase();
  if (!given(rc, key)) throw new UndefinedLegacyElementError(`Element ${name.toUpperCase()} is undefined in ARGUMENTS.`);
  return rc.get(key);
}

/** The attributes carch.saveQuickEdit sets for each `attribute` value (CF `==`, case-insensitive). */
const QUICK_EDIT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  isnav: ['isnav'],
  display: ['display', 'displayStop', 'displayStart', 'displayInterval'],
  template: ['template', 'childTemplate'],
  inheritobjects: ['inheritObjects'],
});

/**
 * carch.saveQuickEdit (carch.cfc:254-283): an Editor's approved save of one attribute of an item without drafts.
 * @returns the save, or null where legacy aborts without one.
 */
export async function saveQuickEdit(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: { rc: ContentInput; csrfValid: boolean },
  opts: SaveContentOptions = {},
): Promise<SaveContentResult | null> {
  if (!input.csrfValid) return null;
  const rc = dataOf(input.rc);
  const contentId = cfText(rcValue(rc, 'contentID'));
  const siteId = cfText(rcValue(rc, 'siteid'));
  const crumbs = await getCrumbList(deps, actor, { contentId, siteId });
  const perm = await getNodePerm(deps, actor, crumbs);
  const fields = QUICK_EDIT_FIELDS[cfText(rcValue(rc, 'attribute')).toLowerCase()];
  if (fields === undefined) return null;
  const args: Record<string, unknown> = { approved: 1 };
  for (const field of fields) args[field] = rcValue(rc, field);
  const prepared = await preparedOptions(deps, actor, opts);
  const result = await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const scope = scopeOf(tx, deps, actor, site, prepared);
    const bean = await readBean(scope, { siteId, contentId });
    const drafts = await deps.repository.content.draftHist(tx, { contentId: bean.contentId(), siteId: bean.text('siteid') });
    if (perm !== 'editor' || drafts.length > 0) return null;
    bean.set(args, actor);
    await applyStatus(scope, bean);
    return saveContentInTx(tx, deps, actor, site, bean, prepared);
  });
  return result === null ? null : settle(result);
}

/** contentBean.addDisplayObject (contentBean.cfc:1143-1176) on one region of the version, as `objectlist<region>`. */
async function addDisplayObject(scope: WriteScope, bean: LegacyContentBean, rc: ReadonlyMap<string, unknown>): Promise<void> {
  const regionId = argValue(rc, 'regionID');
  if (!cfIsNumeric(regionId)) throw new Error('The REGIONID argument passed to the readRegionObjects function is not of type numeric.');
  const objectId = cfText(argValue(rc, 'objectID'));
  const object = cfText(argValue(rc, 'object'));
  const name = cfText(argValue(rc, 'name'));
  const params = given(rc, 'params') ? cfText(rc.get('params')) : '';
  const orderNo = given(rc, 'orderno') ? rc.get('orderno') : '';
  const stored = await scope.deps.repository.content.regionObjects(scope.tx, { contentHistId: bean.contentHistId(), columnId: cfToNumber(regionId), siteId: bean.text('siteid') });
  const region: Array<{ object: string | null; name: string | null; objectid: string | null; params: string | null; orderno: number | null }> = stored.map((row) => ({
    object: row.object,
    name: row.name,
    objectid: row.objectid,
    params: row.params,
    orderno: row.orderno,
  }));
  // The loop reads the query's current row, its first, on every pass.
  const [first] = region;
  if (cfIsNumeric(orderNo) && first !== undefined && cfEq(first.objectid ?? '', objectId) && cfEq(first.object ?? '', object) && first.orderno === cfToNumber(orderNo)) {
    first.name = name;
    first.params = params;
  } else if (!region.some((row) => row.objectid === objectId && row.object === object)) {
    // hasDisplayObject is a query of queries, whose comparisons are case-sensitive.
    region.push({ object, name, objectid: objectId, params, orderno: null });
  }
  bean.put(`objectlist${cfText(regionId)}`, regionObjectsString(region));
}

/**
 * carch.updateObjectParams (carch.cfc:546-576): one display object's params on a version, saved when `params` is JSON.
 * @returns the version as the view reads it, or null where legacy aborts.
 */
export async function updateObjectParams(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: ContentInput,
  opts: SaveContentOptions = {},
): Promise<LegacyContentBean | null> {
  const rc = dataOf(input);
  const prepared = await preparedOptions(deps, actor, opts);
  const outcome = await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const scope = scopeOf(tx, deps, actor, site, prepared);
    const version = await readBean(scope, { siteId: cfText(rcValue(rc, 'siteid')), contentHistId: cfText(rcValue(rc, 'contentHistID')) });
    if (version.isNew === 1) return null;
    const crumbs = await deps.repository.content.crumbPath(tx, { contentId: version.contentId(), siteId: dataText(rc, 'siteid') });
    const perm = await getNodePerm(deps, actor, crumbs);
    if (rc.has('changesetid')) version.setValue('changesetID', rc.get('changesetid'));
    if (rc.has('removepreviouschangeset')) version.setValue('removePreviousChangeset', rc.get('removepreviouschangeset'));
    if (perm === 'author') version.setValue('approved', 0);
    else if (perm === 'editor') version.setValue('approved', rcValue(rc, 'approved'));
    else return null;
    if (!isJson(rcValue(rc, 'params'))) return { bean: version, result: undefined };
    await addDisplayObject(scope, version, rc);
    return { bean: version, result: await saveContentInTx(tx, deps, actor, site, version, prepared) };
  });
  if (outcome === null) return null;
  if (outcome.result === undefined) return outcome.bean;
  return settle(outcome.result).bean;
}

// ---- multiFileUpload ----

/** contentManager.multiFileUpload arguments: the request data and its posted parts. */
export interface MultiFileUploadArgs {
  siteId: string;
  parentId: string;
  subType: string;
  approved: unknown;
  /** The `extraParams` form field (JSON), merged over each item and its response. */
  extraParams?: string;
  files: readonly UploadedFile[];
  /** configBean `getAdminPath()`; defaults to the site context plus `/admin`. */
  adminPath?: string;
}

/** One file's response struct, encoded by the route inside `{"files":[...]}`. */
export type MultiFileUploadItem = Record<string, unknown>;

/**
 * contentManager.multiFileUpload's ACF branch (contentManager.cfc:2606-2690): the posted `files` part stored, a File item
 * added for it and its response struct; null without a part. Legacy leaves the item's body empty, which the start-up
 * guard refuses before anything is stored unless `extraParams` supplies a body.
 */
export async function multiFileUpload(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  args: MultiFileUploadArgs,
  opts: SaveContentOptions = {},
): Promise<MultiFileUploadItem | null> {
  // `form.files` is one simple value on ACF; the per-file loop is commented out there.
  const part = args.files.find((file) => cfEq(file.fieldName, 'files') && file.fileName !== '');
  if (part === undefined) return null;
  const extraParams: Record<string, unknown> = {};
  if ((args.extraParams ?? '') !== '') {
    const parsed: unknown = JSON.parse(args.extraParams ?? '');
    if (isPlainObject(parsed)) Object.assign(extraParams, parsed);
  }
  const item = new Map<string, unknown>([
    ['siteid', args.siteId],
    ['parentid', args.parentId],
    ['type', 'File'],
    ['subtype', args.subType],
    ['display', 1],
    ['isnav', 1],
    ['contentid', ''],
    ['approved', args.approved],
  ]);
  // structAppend(fileItem, extraParams) overwrites.
  for (const [key, value] of Object.entries(extraParams)) item.set(key.toLowerCase(), value);
  if (inList(['file', 'link'], cfText(item.get('type'))) && cfText(item.get('body')) === '') throw new StartupPredicateViolationError(null);

  const text = (key: string): string | null => (item.has(key) ? cfText(item.get(key)) : null);
  if (deps.storage === undefined) throw new Error('multiFileUpload needs the storage port');
  const stored = await storeUploadedFile(
    { ...deps, storage: deps.storage },
    actor,
    {
      file: part,
      contentId: text('contentid'),
      ...(item.has('moduleid') ? { moduleId: cfText(item.get('moduleid')) } : {}),
      caption: item.has('summary') ? cfText(item.get('summary')) : text('caption'),
      credits: text('credits'),
      alttext: text('alttext'),
      remoteId: text('remoteid'),
      remoteUrl: text('remoteurl'),
      remotePubDate: item.has('remotepubdate') ? asDate(item.get('remotepubdate')) : null,
      remoteSource: text('remotesource'),
      remoteSourceUrl: text('remotesourceurl'),
      ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }),
    },
  );
  item.set('filename', stored.filename);
  item.set('fileid', stored.fileid);
  if (!item.has('title')) item.set('title', stored.filename);
  item.set('credits', textPreview(stored.kind === 'stored' ? (stored.file.credits ?? '') : cfText(item.get('credits')), 255));

  let response: MultiFileUploadItem;
  if (stored.kind === 'stored') {
    const prepared = await preparedOptions(deps, actor, opts);
    const result = settle(
      await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
        const saved = await saveContentInTx(tx, deps, actor, site, new Map(item), prepared);
        if (saved.afterCommitError !== undefined) return { ...saved, meta: null };
        const scope = scopeOf(tx, deps, actor, site, prepared);
        await inFilePool(scope, (fileTx) => setFileContentId(fileTx, deps.repository, stored.fileid, saved.bean.contentId(), scope.write));
        const bean = await readBean(scope, { siteId: args.siteId, contentHistId: saved.bean.contentHistId() });
        const metas = await deps.repository.files.listFileMetadata(tx, { siteId: bean.text('siteid'), fileId: stored.fileid, contentHistId: bean.contentHistId() });
        const meta = metas.find((row) => sqlKey(row.contentid) === sqlKey(bean.contentId())) ?? stored.file;
        return { ...saved, bean, meta };
      }),
    );
    const bean = result.bean;
    const imageRow = { type: bean.text('type'), fileid: stored.fileid, fileext: stored.file.fileext };
    const topId = inList(['form', 'component'], bean.text('type')) ? bean.text('moduleid') : HOME_ID;
    const adminPath = args.adminPath ?? `${site.urls.context}/admin`;
    const editUrl =
      `${adminPath}/?muraAction=cArch.edit&contenthistid=${esapiUrlEncode(bean.contentHistId())}&contentid=${esapiUrlEncode(bean.contentId())}` +
      `&type=${esapiUrlEncode(bean.text('type'))}&siteid=${esapiUrlEncode(bean.text('siteid'))}&topid=${esapiUrlEncode(topId)}` +
      `&parentid=${esapiUrlEncode(bean.text('parentid'))}&moduleid=${esapiUrlEncode(bean.text('moduleid'))}&compactdisplay=false`;
    response = {
      filename: jsStringFormat(stored.filename),
      title: jsStringFormat(bean.text('title')),
      summary: cfEq(bean.text('summary'), '<p></p>') ? '' : jsStringFormat(bean.text('summary')),
      altext: jsStringFormat(result.meta?.alttext ?? ''),
      credits: jsStringFormat(result.meta?.credits ?? ''),
      size: stored.file.filesize,
      url: jsStringFormat(contentImageUrl(site.urls, imageRow, { size: 'source' })),
      edit_url: jsStringFormat(editUrl),
      thumbnail_url: jsStringFormat(contentImageUrl(site.urls, imageRow, { size: 'small' })),
      delete_url: '',
      delete_type: 'DELETE',
    };
  } else {
    response = {
      filename: jsStringFormat(stored.filename),
      title: jsStringFormat(stored.filename),
      summary: '',
      altext: '',
      credits: '',
      size: '',
      url: '',
      edit_url: '',
      thumbnail_url: '',
      delete_url: '',
      delete_type: 'DELETE',
    };
  }
  return { ...response, ...extraParams };
}

// ---- carch.update ----

/** carch.before's request defaults for a non-ajax request (carch.cfc:24-72); session-held module and top ids are the route's. */
const CARCH_RC_DEFAULTS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['return', () => ''],
  ['startrow', () => 1],
  ['contentid', () => ''],
  ['ptype', () => 'Page'],
  ['type', () => 'Page'],
  ['contenthistid', () => cfUuid()],
  ['parenthistid', () => ''],
  ['notify', () => ''],
  ['preview', () => 0],
  ['size', () => 20],
  ['action', () => ''],
  ['closecompactdisplay', () => ''],
  ['compactdisplay', () => ''],
  ['returnurl', () => ''],
  ['homeid', () => ''],
  ['objectid', () => ''],
  ['locking', () => false],
  ['moduleassign', () => ''],
  ['orderno', () => 0],
  ['cancelpendingapproval', () => false],
  ['date1', () => ''],
  ['date2', () => ''],
  ['ommitpublishingtab', () => false],
  ['ommitrelatedcontenttab', () => false],
  ['ommitadvancedtab', () => false],
  ['murakeepediting', () => false],
  ['locknode', () => false],
  ['frontend', () => false],
];

/** carch.before's `param` defaults (carch.cfc:20-74), applied where the request has no value. */
function carchDefaults(rc: Data): void {
  const param = (key: string, value: () => unknown): void => {
    if (!given(rc, key)) rc.set(key, value());
  };
  param('ajaxrequest', () => false);
  param('moduleid', () => SITE_TREE_MODULE_ID);
  param('instanceid', () => '');
  if (cfBool(rc.get('ajaxrequest'))) return;
  for (const [key, value] of CARCH_RC_DEFAULTS) param(key, value);
  if (!cfBool(rc.get('ommitpublishingtab'))) {
    for (const [key, value] of [['isnav', 0], ['target', '_self'], ['searchexclude', 0], ['restricted', 0], ['mobileexclude', 0]] as const) param(key, () => value);
  }
  if (!cfBool(rc.get('ommitadvancedtab'))) {
    for (const [key, value] of [['islocked', 0], ['forcessl', 0], ['docache', 1], ['displaytitle', 0]] as const) param(key, () => value);
  }
  if (!cfBool(rc.get('ommitrelatedcontenttab'))) param('relatedcontentsetdata', () => '');
  param('responsechart', () => 0);
  param('parentid', () => '');
}

/** utility.removeLeadingDoubleSlash (utility.cfc:1443-1468). */
function removeLeadingDoubleSlash(url: string): string {
  let clean = cfTrim(url);
  if (clean.length > 1 && clean.startsWith('//') && !(clean.startsWith('http://') || clean.startsWith('https://'))) {
    clean = clean.length > 2 ? clean.slice(2) : '';
    if (clean === '' || !clean.startsWith('/')) clean = `/${clean}`;
  }
  return clean;
}

/** utility.sanitizeHref (utility.cfc:1364-1441) with the settingsManager origin-domain list and the site's domain. */
function sanitizeHref(href: string, originDomains: string, siteDomain: string): string {
  if (cfTrim(href) === '') return href;
  let clean = cfTrim(href);
  if (clean.length > 1 && clean.startsWith('//')) {
    if (clean.length === 2) return '/';
    clean = clean.slice(2);
    return clean.startsWith('/') ? clean : `/${clean}`;
  }
  const scheme = cfListToArray(clean, ':')[0] ?? '';
  if (!inList(['http', 'https'], scheme)) return clean;
  const protocolEnd = clean.indexOf('://');
  if (protocolEnd >= 0) {
    const afterProtocol = clean.slice(protocolEnd + 3);
    const firstSlash = afterProtocol.indexOf('/');
    if (firstSlash >= 0) {
      const domainPart = afterProtocol.slice(0, firstSlash);
      const pathPart = afterProtocol.slice(firstSlash).replace(/\/\/[^/]+/gu, '');
      clean = `${scheme}://${domainPart}${pathPart}`;
    }
  }
  let urlDomain = clean.replace(/^\w+:\/\/([^/:]+)[\w\W]*$/u, '$1');
  if (urlDomain.length > 1 && urlDomain.startsWith('//')) urlDomain = cfListToArray(urlDomain.slice(2), '/')[0] ?? '';
  if (urlDomain !== '' && !cfListToArray(originDomains).some((domain) => cfEq(domain, urlDomain))) {
    // CFML `replace`: the first occurrence, case-sensitive.
    clean = clean.replace(urlDomain, () => siteDomain);
  }
  return clean;
}

/** A carch.update session write the route applies. */
export type CarchSessionEffect =
  | { kind: 'openSectionList'; value: string }
  | { kind: 'multiFileUpload'; value: boolean }
  | { kind: 'editBean'; bean: LegacyContentBean | null };

/** What carch.update answers: an FW/1 redirect, a location, a rendered view, the upload response or legacy's bare abort. */
export type CarchUpdateOutcome =
  | { kind: 'redirect'; action: string; append: string[]; params: Record<string, string>; path?: string }
  | { kind: 'location'; url: string }
  /** update.cfm's edit form for a save with errors; `compactDisplay` is its forced `rc.compactDisplay=true`. */
  | { kind: 'rerender'; bean: LegacyContentBean; compactDisplay: boolean }
  /** The ajax literal: `location` is the bean's getURL (unencoded), null for errors with a fresh `contenthistid&'add'` token. */
  | { kind: 'ajax'; bean: LegacyContentBean; location: string | null }
  | { kind: 'closeCompactDisplay'; bean: LegacyContentBean }
  | { kind: 'text'; body: string }
  /** `{"files":[item]}`, or only legacy's `{"files":[` where its `cftry` caught a failure after that output. */
  | { kind: 'multiFileUpload'; item: MultiFileUploadItem | null }
  | { kind: 'abort' };

/** The session values carch.update reads. */
export interface CarchUpdateSession {
  openSectionList: string;
  /** `session.mura.multifileupload`. */
  multiFileUpload: boolean;
  /** `session[<moduleID>].topID` where the session holds such a key. */
  topIdsByModule?: Readonly<Record<string, string>>;
}

/** One carch.update request. */
export interface CarchUpdateInput {
  rc: ContentInput;
  files?: readonly UploadedFile[];
  /** `$.validateCSRFTokens(context)`, which consumes the token it accepts. */
  validateCsrf: (context: string) => boolean | Promise<boolean>;
  session: CarchUpdateSession;
  /** `isDefined("url.qqfile")`. */
  qqfile?: boolean;
  /** The `extraParams` form field of a multi-file upload. */
  extraParams?: string;
  /** settingsManager.getAccessControlOriginDomainList(), the domains a return URL may keep. */
  accessControlOriginDomains: string;
  /** configBean `getAdminPath()`. */
  adminPath?: string;
}

/** carch.update's outcome with the session writes it made. */
export interface CarchUpdateResult {
  outcome: CarchUpdateOutcome;
  sessionEffects: CarchSessionEffect[];
}

/** FW/1 redirect: `append` names the request values the URL carries, where the request holds them. */
function redirectTo(rc: ReadonlyMap<string, unknown>, action: string, append: string, path?: string): CarchUpdateOutcome {
  const keys = append.split(',');
  const params: Record<string, string> = {};
  for (const key of keys) {
    const value = rc.get(key.toLowerCase());
    if (value !== undefined && value !== null && isSimple(value)) params[key] = cfText(value);
  }
  return { kind: 'redirect', action, append: keys, params, ...(path === undefined ? {} : { path }) };
}

/** CFML `x == 0`: a numeric zero, or a false boolean string ('false', 'no'). */
function cfIsZero(value: unknown): boolean {
  if (cfIsNumeric(value)) return cfToNumber(value) === 0;
  return cfIsBoolean(value) && !cfToBoolean(value);
}

/** CFML `listFindNoCase(list, value)`; empty elements are skipped, so '' is never found. */
function listFindNoCase(list: string, value: string): boolean {
  return value !== '' && cfListToArray(list).some((item) => cfEq(item, value));
}

/** contentBean.getIsOnDisplay (contentBean.cfc:1355-1376) at `now`. */
function isOnDisplay(bean: LegacyContentBean, now: Date): boolean {
  const display = bean.number('display');
  if (display === 1) return true;
  if (display !== 2) return false;
  const start = asDate(bean.raw('displaystart'));
  if (start === null || start > now) return false;
  if (cfText(bean.raw('displaystop')) === '') return true;
  const stop = asDate(bean.raw('displaystop'));
  return stop !== null && stop >= now;
}

/** `rc.<key>` read through the `rc` argument itself, raising ACF's error for a key the request lacks. */
function rcScopeValue(rc: ReadonlyMap<string, unknown>, key: string): unknown {
  if (!given(rc, key)) throw new UndefinedLegacyElementError(`Element ${key.toUpperCase()} is undefined in RC.`);
  return rc.get(key);
}

/** `session[moduleID].topID`, where the session holds that key (CFML keys ignore case). */
function moduleTopId(session: CarchUpdateSession, moduleId: string): string | undefined {
  const entry = Object.entries(session.topIdsByModule ?? {}).find(([key]) => cfEq(key, moduleId));
  return entry?.[1];
}

/**
 * carch.update's `add` (carch.cfc:372-392): the version by `sourceid`, `contenthistid` (when CF UUIDs) or the active
 * one, set from the request; saved with a valid `contenthistid&"add"` token, else validated and given the token error.
 */
async function carchAdd(deps: ContentDeps, actor: Actor, site: ContentSaveSite, rc: Data, input: CarchUpdateInput, opts: SaveContentOptions): Promise<LegacyContentBean> {
  const siteId = dataText(rc, 'siteid');
  const uuidOf = (key: string): string | null => (given(rc, key) && isCfUuid(dataText(rc, key)) ? dataText(rc, key) : null);
  const sourceId = uuidOf('sourceid');
  const histId = uuidOf('contenthistid');
  const ref: BeanRef = sourceId !== null ? { siteId, contentHistId: sourceId } : histId !== null ? { siteId, contentHistId: histId } : { siteId, contentId: dataText(rc, 'contentid') };
  const bean = await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const scope = scopeOf(tx, deps, actor, site, opts);
    const loaded = await readBean(scope, ref);
    loaded.set(rc, actor);
    await applyStatus(scope, loaded);
    return loaded;
  });
  if (await input.validateCsrf(`${bean.contentHistId()}add`)) return (await saveContent(deps, actor, site, bean, opts)).bean;
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const errors = await validateBean(scopeOf(tx, deps, actor, site, opts), bean, opts);
    bean.errors = structErrors([...Object.entries(errors), ['csrf', 'Your request contained invalid tokens']]);
    return bean;
  });
}

/**
 * carch.update's multi-file upload. Legacy's `cftry` turns a failure after its `{"files":[` output into that partial
 * body; only failures legacy itself raises are caught, so gate, guard and storage errors still fail closed.
 */
async function carchMultiFileUpload(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  rc: Data,
  input: CarchUpdateInput,
  opts: SaveContentOptions,
): Promise<CarchUpdateOutcome> {
  const siteId = requiredText(rc, 'siteid');
  const parentId = requiredText(rc, 'parentID');
  const subType = requiredText(rc, 'subType');
  requiredText(rc, 'approved');
  const args: MultiFileUploadArgs = {
    siteId,
    parentId,
    subType,
    approved: rc.get('approved'),
    files: input.files ?? [],
    ...(input.extraParams === undefined ? {} : { extraParams: input.extraParams }),
    ...(input.adminPath === undefined ? {} : { adminPath: input.adminPath }),
  };
  try {
    const item = await multiFileUpload(deps, actor, site, args, opts);
    return item === null ? { kind: 'abort' } : { kind: 'multiFileUpload', item };
  } catch (err) {
    if (err instanceof ContentSaveDataError || err instanceof UndefinedLegacyElementError || err instanceof SyntaxError) return { kind: 'multiFileUpload', item: null };
    throw err;
  }
}

/**
 * carch.update (carch.cfc:336-450) and its update.cfm view: the branch's writes, then legacy's outcome and session writes.
 * Writes commit as they happen, so an error legacy raises afterwards (`rc.contentBean` after a delete) follows them.
 */
export async function carchUpdate(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: CarchUpdateInput,
  opts: SaveContentOptions = {},
): Promise<CarchUpdateResult> {
  const rc = dataOf(input.rc);
  carchDefaults(rc);
  const sessionEffects: CarchSessionEffect[] = [];
  const answer = (outcome: CarchUpdateOutcome): CarchUpdateResult => ({ outcome, sessionEffects });
  if (given(rc, 'orderno') && !cfIsNumeric(rc.get('orderno'))) rc.set('orderno', 0);
  const objectParams = rc.get('objectparams');
  if (typeof objectParams === 'string' && objectParams !== '' && !isJson(objectParams)) rc.set('objectparams', safeUrlDecode(objectParams));

  const contentId = cfText(rcValue(rc, 'contentID'));
  const siteId = cfText(rcValue(rc, 'siteid'));
  const prepared = await preparedOptions(deps, actor, input.files === undefined ? opts : { ...opts, files: input.files });
  const own = await getCrumbList(deps, actor, { contentId, siteId });
  let perm: unknown;
  if (own.length > 0) perm = await getNodePerm(deps, actor, own);
  if (own.length === 0) {
    const parentId = cfText(rcValue(rc, 'parentID'));
    if (parentId !== '') perm = await getNodePerm(deps, actor, await getCrumbList(deps, actor, { contentId: parentId, siteId }));
  }
  // Where neither branch computes it, legacy reads `rc.perm` as the request supplied it; reproduced as legacy reads it.
  perm ??= rcValue(rc, 'perm');
  const allowAction = inList(['author', 'editor'], cfText(perm));
  const isAction = (name: string): boolean => allowAction && cfEq(cfText(rcValue(rc, 'action')), name);

  if (isAction('deleteall') && (await input.validateCsrf(`${contentId}deleteall`))) {
    const deleted = await deleteAll(deps, actor, site, { contentId, siteId, ...(given(rc, 'topid') ? { topId: dataText(rc, 'topid') } : {}) }, prepared);
    if (deleted.aborted) return answer({ kind: 'abort' });
    rc.set('topid', deleted.topId);
  }
  if (isAction('deletehistall') && (await input.validateCsrf(`${contentId}deletehistall`))) {
    await deleteHistAll(deps, actor, site, { contentId, siteId }, prepared);
  }
  if (isAction('delete') && (await input.validateCsrf(`${cfText(rcScopeValue(rc, 'contenthistid'))}delete`))) {
    await deleteVersion(deps, actor, site, { contentHistId: dataText(rc, 'contenthistid'), siteId }, prepared);
  }
  let bean: LegacyContentBean | undefined;
  if (isAction('add')) bean = await carchAdd(deps, actor, site, rc, input, prepared);
  const contentBean = (): LegacyContentBean => {
    if (bean === undefined) throw new UndefinedLegacyElementError('Element RC.contentBean is undefined in ARGUMENTS.');
    return bean;
  };
  const hasErrors = (): boolean => Object.keys(contentBean().errors).length > 0;

  if (!cfBool(rc.get('ajaxrequest'))) {
    if (isAction('multifileupload')) {
      const tokenValid = await input.validateCsrf(`${dataText(rc, 'parentid')}multifileupload`);
      const allowed = tokenValid || input.session.multiFileUpload;
      sessionEffects.push({ kind: 'multiFileUpload', value: allowed });
      if (allowed) return answer(await carchMultiFileUpload(deps, actor, site, rc, input, prepared));
    }
    if (isAction('add') && !cfEq(contentId, HOME_ID)) {
      const saved = contentBean();
      const parentId = saved.text('parentid');
      const path = saved.text('path');
      const topId = moduleTopId(input.session, saved.text('moduleid'));
      const inOpenSection = listFindNoCase(input.session.openSectionList, parentId) && topId !== undefined && listFindNoCase(path, topId);
      if (!inOpenSection || path === '') {
        rc.set('topid', parentId);
        sessionEffects.push({ kind: 'openSectionList', value: cfListAppend(input.session.openSectionList, parentId) });
      }
    }
    let keepEditing = cfBool(rc.get('murakeepediting'));
    if (!keepEditing) {
      const target = contentBean();
      keepEditing = await withGatedTenant(deps.db, actor.tenantId, (tx) => hasDisplayConflicts(scopeOf(tx, deps, actor, site, prepared), target, prepared));
      rc.set('murakeepediting', keepEditing);
    }
    const action = dataText(rc, 'action');
    if ((!cfEq(dataText(rc, 'closecompactdisplay'), 'true') || keepEditing) && !cfEq(action, 'multiFileUpload')) {
      const deleting = cfEq(action, 'delete') || cfEq(action, 'deletehistall');
      const preview = cfIsZero(rc.get('preview'));
      const returnUrl = dataText(rc, 'returnurl');
      if (returnUrl !== '' && (deleting || (preview && !keepEditing))) {
        return answer({ kind: 'location', url: sanitizeHref(removeLeadingDoubleSlash(returnUrl), input.accessControlOriginDomains, site.urls.domain) });
      }
      if (deleting || (cfEq(dataText(rc, 'return'), 'hist') && preview && !keepEditing && !hasErrors())) {
        return answer(redirectTo(rc, 'cArch.hist', 'contentid,siteid,startrow,moduleid,parentid,type,compactDisplay'));
      }
      if (cfEq(dataText(rc, 'return'), 'changesets') && contentBean().text('changesetid') !== '' && !keepEditing) {
        return answer(redirectTo(rc, 'cChangesets.assignments', 'changesetID,siteid', './'));
      }
      if (!hasErrors()) {
        sessionEffects.push({ kind: 'editBean', bean: null });
        const saved = contentBean();
        if (preview && !keepEditing) {
          if (cfBool(rc.get('frontend'))) {
            return answer({ kind: 'location', url: contentUrl(site.urls, { filename: saved.text('filename') }, { complete: true, secure: site.urls.useSSL }) });
          }
          return answer(redirectTo(rc, 'cArch.list', 'topid,siteid,startrow,moduleid', './'));
        }
        rc.set('parentid', saved.text('parentid'));
        rc.set('type', saved.text('type'));
        rc.set('contentid', saved.contentId());
        rc.set('contenthistid', saved.contentHistId());
        return answer(redirectTo(rc, 'cArch.edit', 'contenthistid,contentid,type,parentid,topid,siteid,moduleid,preview,startrow,return,compactDisplay', './'));
      }
    }
  }

  // update.cfm
  if (input.qqfile === true) return answer({ kind: 'text', body: '{success:true}' });
  if (cfBool(rc.get('ajaxrequest'))) {
    const saved = contentBean();
    if (hasErrors()) return answer({ kind: 'ajax', bean: saved, location: null });
    const live = saved.number('active') !== 0 && isOnDisplay(saved, deps.clock.now());
    const query = live ? {} : { querystring: `previewid=${saved.contentHistId()}` };
    return answer({ kind: 'ajax', bean: saved, location: contentUrl(site.urls, { filename: saved.text('filename') }, query) });
  }
  if (cfEq(dataText(rc, 'action'), 'multiFileUpload')) return answer({ kind: 'text', body: 'success' });
  const saved = contentBean();
  if (hasErrors()) {
    if (asDate(saved.raw('lastupdate')) === null) saved.setValue('lastUpdate', deps.clock.now());
    sessionEffects.push({ kind: 'editBean', bean: saved });
    return answer({ kind: 'rerender', bean: saved, compactDisplay: cfEq(dataText(rc, 'closecompactdisplay'), 'true') });
  }
  sessionEffects.push({ kind: 'editBean', bean: null });
  return answer({ kind: 'closeCompactDisplay', bean: saved });
}

// ---- JSON API content save and delete ----

/** contentBean.removeCategory (contentBean.cfc:905-930): `categoryAssign<id>` cleared and the id dropped from `categoryID`. */
function removeCategory(bean: LegacyContentBean, categoryId: string): void {
  bean.put(`categoryAssign${categoryId.replaceAll('-', '')}`, '');
  const ids = cfListToArray(bean.text('categoryid'));
  // listFind is case-sensitive.
  const at = ids.indexOf(categoryId);
  if (at >= 0) {
    ids.splice(at, 1);
    bean.put('categoryID', ids.join(','));
  }
}

/** JSON API AllowAction for a content bean: `authorization` unless the actor is the node's author or editor; authors save unapproved. */
async function authorizeContentAction(deps: ContentDeps, actor: Actor, bean: LegacyContentBean, event: ReadonlyMap<string, unknown>): Promise<void> {
  const eventType = dataText(event, 'type');
  if (inList(['form', 'component', 'variation'], eventType)) bean.setValue('type', eventType);
  const verdict = await allowContentAction(deps, actor, { type: bean.text('type'), contentId: bean.contentId(), siteId: bean.text('siteid'), parentId: bean.text('parentid') });
  if (!verdict.allowed) throw new LegacyApiError('authorization');
  if (verdict.forceUnapproved) bean.setValue('approved', 0);
}

/** The JSON API content save request; the route validates its CSRF token (context: the path id) first, as legacy does. */
export interface SaveContentEntityInput {
  /** `$.event()` values. */
  event: ContentInput;
  /** The path id; 'new' when absent. */
  id?: string;
}

/** The JSON API content save's outcome: the reloaded entity, the save's errors and the pk its response is keyed by. */
export interface SaveContentEntityResult {
  bean: LegacyContentBean;
  errors: LegacyErrors;
  pk: 'contentid' | 'contenthistid';
}

/**
 * JSON API `save` of a content entity (jsonApiUtility.cfc:1903-2058): load, `removecategories`, set, authorize, save,
 * reload; a new Variation in a change set saves its empty default first.
 */
export async function saveContentEntity(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: SaveContentEntityInput,
  opts: SaveContentOptions = {},
): Promise<SaveContentEntityResult> {
  const event = dataOf(input.event);
  const pk = dataText(event, 'contenthistid') === '' && dataText(event, 'contentid') !== '' ? 'contentid' : 'contenthistid';
  let id = input.id ?? 'new';
  const pkValue = dataText(event, pk);
  if (pkValue !== '' && (isCfUuid(pkValue) || pkValue === HOME_ID)) id = pkValue;
  if (cfEq(id, 'new')) {
    id = cfUuid();
    event.set('id', id);
    event.set(pk, id);
  }
  const siteId = dataText(event, 'siteid');
  const variation = cfEq(dataText(event, 'type'), 'Variation');
  let ref: BeanRef;
  if (dataText(event, 'contenthistid') !== '') {
    ref = { siteId, contentHistId: dataText(event, 'contenthistid') };
    if (variation) {
      try {
        event.set('body', safeUrlDecode(dataText(event, 'body')));
      } catch {
        event.set('body', '');
      }
    }
  } else {
    ref = pk === 'contentid' ? { siteId, contentId: id } : { siteId, contentHistId: id };
  }

  const prepared = await preparedOptions(deps, actor, opts);
  const pool = new Set((prepared.poolCategories ?? []).map((row) => sqlKey(row.categoryid)));
  const entity = await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const scope = scopeOf(tx, deps, actor, site, prepared);
    const loaded = await readBean(scope, ref);
    if (cfBool(event.get('removecategories'))) {
      for (const row of await deps.repository.content.categoryAssignments(tx, { contentHistId: loaded.contentHistId() })) {
        if (pool.has(sqlKey(row.categoryid))) removeCategory(loaded, row.categoryid ?? '');
      }
    }
    loaded.set(event, actor);
    await applyStatus(scope, loaded);
    return loaded;
  });
  // contentBean has no allowSave of its own, so AllowAction decides.
  await authorizeContentAction(deps, actor, entity, event);

  let saved: LegacyContentBean;
  if (variation && entity.isNew === 1 && entity.text('changesetid') !== '') {
    entity.setValue('body', '[]');
    entity.setValue('changesetID', '');
    entity.setValue('approved', 1);
    const draft = (await saveContent(deps, actor, site, entity, prepared)).bean;
    draft.setValue('body', event.get('body') ?? '');
    draft.setValue('changesetID', event.get('changesetid') ?? '');
    draft.setValue('approved', 0);
    saved = (await saveContent(deps, actor, site, draft, prepared)).bean;
  } else {
    saved = (await saveContent(deps, actor, site, entity, prepared)).bean;
  }

  const errors = saved.errors;
  const reloaded = await withGatedTenant(deps.db, actor.tenantId, (tx) =>
    readBean(scopeOf(tx, deps, actor, site, prepared), { siteId: saved.text('siteid'), contentHistId: saved.contentHistId() }),
  );
  if (Object.keys(errors).length > 0) {
    for (const [key, value] of event) {
      if (reloaded.has(key)) reloaded.setValue(key, value);
    }
  }
  return { bean: reloaded, errors, pk };
}

/** The JSON API content delete request. */
export interface DeleteContentEntityInput {
  /** `$.event()` values: `contenthistid`, `contentid`, `id`, `type`, `siteid`. */
  event: ContentInput;
  /** `$.validateCSRFTokens(context=<path id>)`, or true where the request has no session management. */
  validateCsrf: () => boolean | Promise<boolean>;
  /**
   * The `pk` in jsonApiUtility's component scope, which a `contentid` delete reads before declaring its own; only a
   * `stats` findOne since application start sets it. Absent, the delete fails as on a freshly started application.
   */
  componentPk?: string;
}

/**
 * JSON API `delete` of a content entity (jsonApiUtility.cfc:3261-3303): an inactive version by `contenthistid`, else the
 * item by deleteAll. @returns `aborted` for deleteAll's home-page abort.
 */
export async function deleteContentEntity(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: DeleteContentEntityInput,
  opts: Pick<SaveContentOptions, 'requestId' | 'rbKey' | 'memberships'> = {},
): Promise<{ aborted: boolean }> {
  const event = dataOf(input.event);
  const read = (ref: BeanRef): Promise<LegacyContentBean> =>
    withGatedTenant(deps.db, actor.tenantId, (tx) => readBean(scopeOf(tx, deps, actor, site, opts), ref));
  if (dataText(event, 'contenthistid') !== '') {
    const version = await read({ siteId: dataText(event, 'siteid'), contentHistId: dataText(event, 'contenthistid') });
    if (version.isNew === 1) return { aborted: false };
    await authorizeContentAction(deps, actor, version, event);
    if ((await input.validateCsrf()) && version.number('active') === 0) {
      await deleteVersion(deps, actor, site, { contentHistId: version.contentHistId(), siteId: version.text('siteid') }, opts);
    }
    return { aborted: false };
  }
  if (dataText(event, 'contentid') !== '' && isCfUuid(dataText(event, 'contentid'))) {
    if (input.componentPk === undefined) throw new UndefinedLegacyElementError('Variable PK is undefined.');
    event.set('id', event.get(input.componentPk.toLowerCase()) ?? '');
  }
  const item = await read({ siteId: dataText(event, 'siteid'), contentId: dataText(event, 'id') });
  if (item.isNew === 1) return { aborted: false };
  await authorizeContentAction(deps, actor, item, event);
  if (!(await input.validateCsrf())) throw new LegacyApiError('invalidTokens');
  const deleted = await deleteAll(deps, actor, site, { contentId: item.contentId(), siteId: item.text('siteid') }, opts);
  return { aborted: deleted.aborted };
}
