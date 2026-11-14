/** Content comments: the ccomments admin actions, contentCommentManager, contentCommentBean and the commentsProxy data methods. */
import {
  LegacyApiError,
  LegacyServiceUnavailableError,
  cfDateAdd,
  cfEq,
  cfIsBoolean,
  cfIsDateText,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfLsDateFormat,
  cfNumberString,
  cfParseDateTimeText,
  cfTimestampParam,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import type { CommentFeedArgs, CommentFindRow, ContentRepository } from '../repo/repository.js';
import type { CommentRow } from '../repo/tables.js';
import {
  actorFromClaims,
  writeContextFor,
  type Actor,
  type DomainDeps,
  type DomainResult,
  type LegacyErrors,
  type MailNotice,
  type SiteContentSettings,
} from './context.js';
import { loadStats, setCommentStat, statsValues, type ContentStats } from './stats.js';
import { takeOut } from './trash.js';

/** The active content version `contentBean.loadBy(contentID, siteID)` finds. */
export type ActiveContent = Awaited<ReturnType<ContentRepository['content']['readActive']>>[number];

/** The site a comment belongs to, as the comment bean's settingsManager, mailer and content URLs read it. */
export interface CommentSite extends Pick<SiteContentSettings, 'siteId' | 'site' | 'contactEmail' | 'urls'> {
  /** settingsBean `getCommentApprovalDefault()`: the `isApproved` a save without comment-module access stores. */
  commentApprovalDefault: number;
  /** contentBean.getURL(complete=true, querystring) of the comment's content; `content` is null when none is active. */
  contentUrl(content: ActiveContent | null, querystring: string): string;
}

/** How a comment operation was reached, and where legacy's swallowed errors go. */
export interface CommentCallOptions {
  /** `request.muraapirequest`: true on JSON API routes, false on admin routes. */
  apiRequest?: boolean;
  requestId?: string;
  /** Receives each error legacy swallows (handleError, the notifySubscribers writeLog, the purge catch). */
  onSwallowedError?: (error: unknown, operation: string) => void;
}

/** The commenter's user photo the bean's `getQuery` joins (tusers.photoFileID to tfiles); people owns the user. */
export interface CommenterPhoto {
  fileId: string;
  fileExt: string;
}

/** Inputs of `getCommentValues` the comment row cannot supply. */
export interface CommentValuesView {
  /** settingsBean `getScheme()` of the comment's site, which setURL prefixes to a URL without one. */
  scheme: string;
  /** The photo of the user `userId` names, or null; absent leaves FILEID and FILEEXT empty. */
  commenterPhoto?: (userId: string) => Promise<CommenterPhoto | null>;
}

/**
 * contentCommentBean `getAllValues()`, keys spelled as legacy assigns them and ordered as ACF 2023 iterates the
 * instance struct (recorded from commentsProxy `get`); FILEID and FILEEXT exist only once a row was loaded.
 */
export interface CommentValues {
  path: string;
  flagCount: number;
  errors: LegacyErrors;
  comments: string;
  email: string;
  FILEID?: string;
  isApproved: number;
  url: string;
  kids: number;
  FILEEXT?: string;
  addObjects: unknown[];
  userID: string;
  instanceID: string;
  contentID: string;
  commentID: string;
  removeObjects: unknown[];
  siteID: string;
  subscribe: number;
  name: string;
  remoteID: string;
  parentID: string;
  isDeleted: number;
  fromMuraCache: boolean;
  isSpam: number;
  isNew: number;
  entered: Date;
}

/** The persistent values of a contentCommentBean; `url` holds the text setURL received, before its scheme prefix. */
interface CommentBean {
  isNew: number;
  instanceID: string;
  commentID: string;
  contentID: string;
  parentID: string;
  siteID: string;
  comments: string;
  url: string;
  name: string;
  email: string;
  entered: Date;
  subscribe: number;
  isApproved: number;
  isSpam: number;
  isDeleted: number;
  userID: string;
  path: string;
  kids: number;
  remoteID: string;
  flagCount: number;
  errors: LegacyErrors;
  /** Set once `set(rs)` ran: the FILEID and FILEEXT columns the query added. */
  photo?: CommenterPhoto;
}

type BeanString = 'commentID' | 'contentID' | 'parentID' | 'siteID' | 'comments' | 'url' | 'name' | 'email' | 'userID' | 'path' | 'remoteID';
type BeanNumber = 'subscribe' | 'isApproved' | 'isSpam' | 'isDeleted' | 'kids' | 'flagCount';

// Bean properties by lower-cased CFML name; struct keys and setters resolve case-insensitively.
const STRING_PROPERTIES: ReadonlyMap<string, BeanString> = new Map(
  (['commentID', 'contentID', 'parentID', 'siteID', 'comments', 'url', 'name', 'email', 'userID', 'path', 'remoteID'] as const).map(
    (name) => [name.toLowerCase(), name],
  ),
);
const NUMBER_PROPERTIES: ReadonlyMap<string, BeanNumber> = new Map(
  (['subscribe', 'isApproved', 'isSpam', 'isDeleted', 'kids', 'flagCount'] as const).map((name) => [name.toLowerCase(), name]),
);

const S2_ROLE = 's2';
const SITE_ADMIN_ROLE = 'site-admin';
/** Token role of a grant on the comments module (00000000000000000000000000000000015). */
const COMMENTS_MODULE_ROLE = 'm:015';
/** Token role of a grant on the site tree module (00000000000000000000000000000000000). */
const SITE_TREE_MODULE_ROLE = 'm:000';
const ANONYMOUS: Actor = actorFromClaims(undefined, '');

/** contentCommentBean `init()`: a new comment with the bean defaults, `entered` = `now`. */
function newBean(now: Date): CommentBean {
  return {
    isNew: 1,
    instanceID: cfUuid(),
    commentID: '',
    contentID: '',
    parentID: '',
    siteID: '',
    comments: '',
    url: '',
    name: '',
    email: '',
    entered: now,
    subscribe: 0,
    isApproved: 0,
    isSpam: 0,
    isDeleted: 0,
    userID: '',
    path: '',
    kids: 0,
    remoteID: '',
    flagCount: 0,
    errors: {},
  };
}

/** A simple CFML value as text (NULL as ''); undefined for a complex value. */
function simpleText(value: unknown): string | undefined {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

/** setURL (contentCommentBean.cfc:163-170): a URL whose first `/` item is not `http:` or `https:` gets `<scheme>://`. */
function schemeUrl(url: string, scheme: string): string {
  const first = (cfListToArray(url, '/')[0] ?? '').toLowerCase();
  return url !== '' && first !== 'http:' && first !== 'https:' ? `${scheme}://${url}` : url;
}

/** CFML `isDate` of a bean value, then parseDateArg; undefined when it is not a date. */
function beanDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== 'string' || !cfIsDateText(value)) return undefined;
  return cfParseDateTimeText(value);
}

/** bean.setValue of one value: strings trimmed, the numeric setters taking numeric values only, setEntered dates only. */
function setBeanValue(bean: CommentBean, key: string, value: unknown): void {
  const lowered = key.toLowerCase();
  const stringProperty = STRING_PROPERTIES.get(lowered);
  if (stringProperty !== undefined) {
    const text = simpleText(value);
    if (text !== undefined) bean[stringProperty] = javaTrim(text);
    return;
  }
  const numberProperty = NUMBER_PROPERTIES.get(lowered);
  if (numberProperty !== undefined) {
    if (cfIsNumeric(value)) bean[numberProperty] = cfToNumber(value);
    return;
  }
  if (lowered === 'entered') {
    const date = beanDate(value);
    if (date !== undefined) bean.entered = date;
  }
}

/** bean.set(rs) of a `getQuery` row: NULL cells arrive as '' and leave the numeric and date fields at their defaults. */
function applyRow(bean: CommentBean, row: CommentFindRow, photo: CommenterPhoto | null): void {
  for (const [column, value] of Object.entries(row)) {
    setBeanValue(bean, column, value);
  }
  bean.isNew = 0;
  bean.photo = photo ?? { fileId: '', fileExt: '' };
}

/** bean.set(struct) of request values: the comment id is skipped when empty, keys match case-insensitively. */
function applyValues(bean: CommentBean, values: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (key.toLowerCase() === 'commentid' && simpleText(value) === '') continue;
    setBeanValue(bean, key, value);
  }
}

/** getCommentID(): the bean's id, a new createUUID() stored on it when empty. */
function commentIdOf(bean: CommentBean): string {
  if (bean.commentID === '') bean.commentID = cfUuid();
  return bean.commentID;
}

/** `getBean('comment').setCommentID(id).load()`: the stored comment, or a new bean holding the trimmed id. */
async function loadBean(
  tx: TenantTx,
  deps: DomainDeps,
  commentId: string,
  commenterPhoto?: (userId: string) => Promise<CommenterPhoto | null>,
): Promise<CommentBean> {
  const bean = newBean(deps.clock.now());
  bean.commentID = javaTrim(commentId);
  const row = await deps.repository.comments.findComment(tx, { commentId: commentIdOf(bean) });
  if (row !== null) {
    const userId = javaTrim(row.userid ?? '');
    applyRow(bean, row, commenterPhoto === undefined ? null : await commenterPhoto(userId));
  }
  return bean;
}

/** The bean's getAllValues() struct in ACF iteration order; `url` carries the setURL prefix. */
function beanValues(bean: CommentBean, scheme: string): CommentValues {
  return {
    path: bean.path,
    flagCount: bean.flagCount,
    errors: { ...bean.errors },
    comments: bean.comments,
    email: bean.email,
    ...(bean.photo === undefined ? {} : { FILEID: bean.photo.fileId }),
    isApproved: bean.isApproved,
    url: schemeUrl(bean.url, scheme),
    kids: bean.kids,
    ...(bean.photo === undefined ? {} : { FILEEXT: bean.photo.fileExt }),
    addObjects: [],
    userID: bean.userID,
    instanceID: bean.instanceID,
    contentID: bean.contentID,
    commentID: bean.commentID,
    removeObjects: [],
    siteID: bean.siteID,
    subscribe: bean.subscribe,
    name: bean.name,
    remoteID: bean.remoteID,
    parentID: bean.parentID,
    isDeleted: bean.isDeleted,
    fromMuraCache: false,
    isSpam: bean.isSpam,
    isNew: bean.isNew,
    entered: bean.entered,
  };
}

/** permUtility.getModulePerm: S2 and the site's private-pool Admin group hold every module, others need the module's grant. */
function hasModulePerm(actor: Actor, moduleRole: string): boolean {
  return actor.s2 || actor.roles.includes(S2_ROLE) || actor.roles.includes(SITE_ADMIN_ROLE) || actor.roles.includes(moduleRole);
}

/** contentCommentBean.allowModuleAccess (757-767): every non-API request, else comment and site tree module access. */
function allowModuleAccess(actor: Actor, apiRequest: boolean): boolean {
  return !apiRequest || (hasModulePerm(actor, COMMENTS_MODULE_ROLE) && hasModulePerm(actor, SITE_TREE_MODULE_ROLE));
}

/** Rethrows the fail-closed errors (gates, unavailable services) and hands every other error to `onSwallowedError`. */
function swallow(error: unknown, operation: string, options: CommentCallOptions): void {
  if (error instanceof LegacyServiceUnavailableError) throw error;
  options.onSwallowedError?.(error, operation);
}

/** beanValidator over the bean's rules: `comments` and `email` are required; every other rule passes for bean values. */
function validateBean(bean: CommentBean): LegacyErrors {
  const errors: LegacyErrors = {};
  // ACF iterates both the validation rules and the errors struct as comments, then email.
  for (const property of ['comments', 'email'] as const) {
    if (bean[property] === '') errors[property] = `The property named '${property}' is not valid`;
  }
  return errors;
}

/** CFML URLEncodedFormat (ACF): every character but ASCII letters and digits as `%XX` of its UTF-8 bytes. */
function cfUrlEncodedFormat(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) {
    const alnum = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    out += alnum ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Mail text and subject a notifySubscribers call is given; '' selects the bean's own. */
interface NotifyArgs {
  script: string;
  subject: string;
}

/**
 * contentCommentBean.notifySubscribers (632-675) with `notifyAdmin`: one notice per subscribed email of the content,
 * then the site contact's copy, which carries the unsubscribe link of the first subscriber as legacy's does.
 */
async function notifySubscribers(tx: TenantTx, deps: DomainDeps, bean: CommentBean, site: CommentSite, args: NotifyArgs): Promise<MailNotice[]> {
  const subscribers = await deps.repository.comments.commentSubscribers(tx, { contentId: bean.contentID, siteId: bean.siteID });
  const [content] = await deps.repository.content.readActive(tx, { contentId: bean.contentID, siteId: bean.siteID });
  const active = content ?? null;
  const title = active?.title ?? '';
  const subject = args.subject !== '' ? args.subject : `New Comment on '${title}'`;
  const text =
    args.script !== ''
      ? args.script
      : `\nA comment has been posted to "${title}" by ${bean.name}.\n\nCOMMENT:\n${bean.comments}\n\n` +
        `View\n${site.contentUrl(active, '')}\n\nTo Unsubscribe Click Here:\n`;
  const notice = (to: string, unsubscribe: string): MailNotice => ({
    kind: 'comment-subscriber',
    to,
    from: site.site,
    subject,
    body: text + site.contentUrl(active, `commentUnsubscribe=${cfUrlEncodedFormat(unsubscribe)}`),
    siteId: bean.siteID,
  });
  const notices = subscribers.map((email) => notice(email, email));
  if (site.contactEmail !== '') notices.push(notice(site.contactEmail, subscribers[0] ?? ''));
  return notices;
}

/**
 * standardSetCommenterHandler: a loaded comment updates the commenter its userID names (created under that id when
 * missing); a new one reuses the commenter of the user id, or of the e-mail when anonymous. Sets the comment's userID.
 */
async function setCommenter(tx: TenantTx, deps: DomainDeps, actor: Actor, bean: CommentBean, write: WriteContext): Promise<void> {
  const comments = deps.repository.comments;
  if (bean.isNew === 0) {
    const commenterid = bean.userID !== '' ? bean.userID : cfUuid();
    const saved = await comments.upsertCommenter(tx, { commenterid, name: bean.name, email: bean.email }, write);
    bean.userID = javaTrim(saved.commenterid);
    return;
  }
  const remoteid = actor.isLoggedIn ? actor.userId : bean.email;
  const existing = await comments.findCommenter(tx, { remoteId: remoteid });
  const commenterid = existing === null ? cfUuid() : existing.commenterid;
  const saved = await comments.upsertCommenter(tx, { commenterid, remoteid, name: bean.name, email: bean.email }, write);
  bean.userID = javaTrim(saved.commenterid);
}

/** The site values a save reads; only a notifying save also builds content URLs. */
export type CommentSaveSite = Omit<CommentSite, 'contentUrl'>;

/** Settings of one contentCommentBean.save call. */
interface SaveArgs extends NotifyArgs {
  /** The site notifySubscribers mails for; a save without it does not notify. */
  notifySite?: CommentSite;
  apiRequest: boolean;
  /** `request.remoteAddr`, else `CGI.REMOTE_ADDR`: the `ip` a new comment stores. */
  remoteAddr: string;
}

/**
 * contentCommentBean.save (432-550) in the caller's gated transaction: the approval default, the recomputed path,
 * validation (nothing is written when it fails), the commenter, the update or insert, the subscription, the notices
 * and the comment stat. Returns the validation errors and the notices.
 */
async function saveBean(
  tx: TenantTx,
  deps: DomainDeps,
  actor: Actor,
  bean: CommentBean,
  site: CommentSaveSite,
  args: SaveArgs,
  write: WriteContext,
): Promise<{ errors: LegacyErrors; notices: MailNotice[] }> {
  if (!allowModuleAccess(actor, args.apiRequest)) {
    bean.isApproved = site.commentApprovalDefault;
  } else if (bean.isNew !== 0) {
    bean.isApproved = 1;
  }
  let path = '';
  if (bean.parentID !== '') {
    path = (await loadBean(tx, deps, bean.parentID)).path;
  }
  const commentid = commentIdOf(bean);
  path = cfListAppend(path, commentid);
  bean.errors = validateBean(bean);
  if (Object.keys(bean.errors).length > 0) {
    return { errors: bean.errors, notices: [] };
  }
  await setCommenter(tx, deps, actor, bean, write);
  const stored = {
    contentid: bean.contentID,
    name: bean.name,
    email: bean.email,
    url: schemeUrl(bean.url, site.urls.scheme),
    comments: bean.comments,
    entered: bean.entered,
    siteid: bean.siteID,
    isapproved: bean.isApproved,
    subscribe: bean.subscribe,
    userid: bean.userID,
    parentid: bean.parentID,
    path,
    remoteid: bean.remoteID,
    isspam: bean.isSpam,
    isdeleted: bean.isDeleted,
    flagcount: bean.flagCount,
  };
  const comments = deps.repository.comments;
  if ((await comments.findComment(tx, { commentId: commentid })) !== null) {
    await comments.updateComment(tx, commentid, stored, write);
  } else {
    await comments.insertComment(tx, { ...stored, commentid, ip: args.remoteAddr }, write);
    bean.isNew = 0;
    takeOut({ ...beanValues(bean, site.urls.scheme) });
  }
  const notices: MailNotice[] = [];
  if (bean.isApproved !== 0) {
    await comments.setSubscribe(tx, { contentId: bean.contentID, siteId: bean.siteID, email: bean.email, subscribe: bean.subscribe }, write);
    if (args.notifySite !== undefined) notices.push(...(await notifySubscribers(tx, deps, bean, args.notifySite, args)));
  }
  await setCommentStat(tx, deps.repository, bean.contentID, bean.siteID, write);
  return { errors: {}, notices };
}

// ---- listing ----

/** The session values the ccomments list reads. */
export interface CommentsSession {
  /** `session.siteid`; undefined only where the session holds none, which legacy answers with `default`. */
  sessionSiteId?: string;
  /** `session.dateKeyFormat`, the mask of the default date range. */
  dateKeyFormat: string;
  /** The session's Java locale (setLocale); en_US when omitted. */
  javaLocale?: string;
}

/** One comment of the current page and the active content `loadBy(contentID, siteID)` finds for it (null when none). */
export interface LoadCommentsRow {
  comment: CommentRow;
  content: ActiveContent | null;
}

/** The `rc` values loadcomments.cfm reads after ccomments.cfc:204-282, and the rows of the current page in query order. */
export interface LoadCommentsPage {
  /** `rc.siteid`: the session site, never the request's. */
  siteId: string;
  keywords: string;
  commentStatus: string;
  startDate: string;
  endDate: string;
  categoryId: string;
  sortBy: string;
  sortDirection: string;
  sortDirLink: string;
  /** `Val(rc.nextn)`, 25 when below 1. */
  nextN: number;
  /** `Val(rc.pageno)`, 1 when outside the page range. */
  pageNo: number;
  totalPages: number;
  startPage: number;
  endPage: number;
  /** Every matched comment, not just this page. */
  recordCount: number;
  rows: LoadCommentsRow[];
  /** Request time: the `entered` a NULL cell leaves on the comment bean. */
  now: Date;
}

/** One comment of a content item with what loadcommentspage.cfm loads for it. */
export interface CommentsPageRow {
  comment: CommentRow;
  /** `getCommenter().getRemoteID()`; resolved only for rows between `startRow` and `endRow`, '' elsewhere. */
  commenterRemoteId: string;
  /** `getParent().getName()`, null when no comment has the parent id; resolved only between `startRow` and `endRow`. */
  parentName: string | null;
}

/** The `rc` values of ccomments.loadCommentsPage (284-352) and every comment of the content in `getComments` order. */
export interface CommentsPage {
  siteId: string;
  contentId: string;
  commentId: string;
  upperId: string;
  lowerId: string;
  /** `rc.sort`: the sort direction, `asc` unless `asc` or `desc`. */
  sort: string;
  /** `rc.p.startRow` and `rc.p.endRow`, 1-based. */
  startRow: number;
  endRow: number;
  rows: CommentsPageRow[];
  now: Date;
}

/** A CFML struct over request values: keys match ignoring case. */
class CfScope {
  private readonly values = new Map<string, unknown>();

  constructor(values: Readonly<Record<string, unknown>>) {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) this.values.set(key.toLowerCase(), value);
    }
  }

  has(key: string): boolean {
    return this.values.has(key.toLowerCase());
  }

  get(key: string): unknown {
    return this.values.get(key.toLowerCase());
  }

  set(key: string, value: unknown): void {
    this.values.set(key.toLowerCase(), value);
  }

  /** `param name=key default=value`. */
  param(key: string, value: unknown): void {
    if (!this.has(key)) this.set(key, value);
  }

  /** The value as text; a complex or missing value reads as ''. */
  text(key: string): string {
    return simpleText(this.get(key)) ?? '';
  }
}

/** CFML `Val`: the number the text starts with, else 0. */
function cfVal(value: unknown): number {
  const number = Number.parseFloat(simpleText(value) ?? '');
  return Number.isFinite(number) ? number : 0;
}

/** CFML `ListFindNoCase(options, value)` as a filter: `value` when it equals an option ignoring case, else `fallback`. */
function listOption(value: string, options: readonly string[], fallback: string): string {
  return options.includes(value.toLowerCase()) ? value : fallback;
}

/** A typed `getComments` argument as ACF converts it on the call; throws ACF's argument-type error. */
function typedArgument<T>(scope: CfScope, name: string, type: string, is: (v: unknown) => boolean, to: (v: unknown) => T): T | undefined {
  if (!scope.has(name)) return undefined;
  const value = scope.get(name);
  if (!is(value)) throw new TypeError(`The ${name.toUpperCase()} argument passed to the getComments function is not of type ${type}.`);
  return to(value);
}

const isSimple = (value: unknown): boolean => simpleText(value) !== undefined;
const toText = (value: unknown): string => simpleText(value) ?? '';

/** The `isDate` check and `cf_sql_date`/`createDateTime` conversion of a getComments date argument. */
function dateArgument(scope: CfScope, name: string): Date | undefined {
  const value = scope.get(name);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  return typeof value === 'string' && cfIsDateText(value) ? cfTimestampParam(value) : undefined;
}

/** contentCommentManager.getComments' arguments from an argument collection: each filter applies only when present. */
function feedArgs(scope: CfScope): CommentFeedArgs {
  const text = (name: string): string | undefined => typedArgument(scope, name, 'string', isSimple, toText);
  const flag = (name: string): boolean | undefined => typedArgument(scope, name, 'boolean', cfIsBoolean, cfToBoolean);
  const categoryId = text('categoryid') ?? '';
  return {
    siteId: text('siteid') ?? 'default',
    commentId: text('commentid'),
    keywords: text('keywords'),
    contentId: text('contentid'),
    parentId: text('parentid'),
    remoteId: text('remoteid'),
    ip: text('ip'),
    email: text('email'),
    name: text('name'),
    isApproved: flag('isapproved'),
    isSpam: flag('isspam'),
    isDeleted: flag('isdeleted'),
    startDate: dateArgument(scope, 'startdate'),
    endDate: dateArgument(scope, 'enddate'),
    categoryIds: categoryId === '' ? undefined : cfListToArray(categoryId),
    sortBy: text('sortby') ?? 'entered',
    sortDirection: text('sortdirection') ?? 'asc',
    maxItems: typedArgument(scope, 'maxitems', 'numeric', cfIsNumeric, cfToNumber) ?? 1000,
  };
}

/** contentCommentManager.getComments (100-254): the site's comments filtered, sorted and limited as the arguments say. */
export function getComments(deps: DomainDeps, actor: Actor, filters: CommentFeedArgs): Promise<CommentRow[]> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.comments.commentFeed(tx, filters));
}

/** queryIterator paging of ccomments.cfc:247-282: the page range, its buffer, and the zero-based rows of the page. */
function pageWindow(recordCount: number, nextN: number, requestedPage: number) {
  const totalPages = Math.ceil(recordCount / nextN);
  const pageNo = requestedPage < 1 || requestedPage > totalPages ? 1 : requestedPage;
  // setPageIndex resets to the first page when the page starts beyond the last record.
  let pageIndex = pageNo;
  let recordIndex = (pageIndex - 1) * nextN;
  if (recordIndex > recordCount) {
    recordIndex = 0;
    pageIndex = 1;
  }
  const buffer = 3;
  let startPage = 1;
  let endPage = totalPages;
  if (buffer < totalPages) {
    startPage = pageNo - buffer;
    endPage = pageNo + buffer;
    if (startPage < 1) {
      endPage = endPage + Math.abs(startPage) + 1;
      startPage = 1;
    }
    if (endPage > totalPages) {
      const x = startPage - (endPage - totalPages);
      startPage = x < 1 ? 1 : x;
      endPage = totalPages;
    }
  }
  const indexes: number[] = [];
  for (let index = recordIndex; index < recordCount && index < pageIndex * nextN; index += 1) {
    indexes.push(Math.trunc(index));
  }
  return { totalPages, pageNo, startPage, endPage, indexes };
}

/**
 * ccomments.loadComments (204-283): the request defaults and normalisation, the status filter, `getComments` over the
 * whole argument collection in the session site, and the current page with each comment's active content.
 */
export async function loadComments(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  session: CommentsSession,
): Promise<LoadCommentsPage> {
  const now = deps.clock.now();
  const scope = new CfScope(rc);
  const locale = session.javaLocale ?? 'en_US';
  // CFML evaluates a param's default whether or not the variable exists.
  const startDefault = cfLsDateFormat(cfDateAdd('d', -7, now), session.dateKeyFormat, locale);
  const endDefault = cfLsDateFormat(now, session.dateKeyFormat, locale);
  scope.param('sortby', 'entered');
  scope.param('sortdirection', 'asc');
  scope.param('pageno', 1);
  scope.param('nextn', 25);
  scope.param('commentStatus', '');
  scope.param('startdate', startDefault);
  scope.param('enddate', endDefault);
  scope.param('categoryID', '');
  const siteId = session.sessionSiteId ?? 'default';
  scope.set('siteid', siteId);
  const sortDirection = listOption(scope.text('sortdirection'), ['asc', 'desc'], 'asc');
  scope.set('sortdirection', sortDirection);
  const sortDirLink = cfEq(sortDirection, 'asc') ? 'desc' : 'asc';
  const sortBy = listOption(scope.text('sortby'), ['entered', 'name', 'flagcount'], 'entered');
  scope.set('sortby', sortBy);
  switch (scope.text('commentStatus').toLowerCase()) {
    case 'approved':
      scope.set('isapproved', 1);
      scope.set('isDeleted', 0);
      scope.set('isSpam', 0);
      break;
    case 'unapproved':
      scope.set('isapproved', 0);
      scope.set('isDeleted', 0);
      scope.set('isSpam', 0);
      break;
    case 'spam':
      scope.set('isspam', 1);
      scope.set('isDeleted', 0);
      break;
    case 'deleted':
      scope.set('isdeleted', 1);
      break;
    default:
      break;
  }
  scope.param('maxItems', '1000');
  const args = feedArgs(scope);
  let nextN = cfVal(scope.get('nextn'));
  const requestedPage = cfVal(scope.get('pageno'));
  if (nextN < 1) nextN = 25;
  return withTenant(deps.db, actor.tenantId, async (tx) => {
    const recordCount = await deps.repository.comments.commentFeedCount(tx, args);
    const window = pageWindow(recordCount, nextN, requestedPage);
    // The page's indexes are consecutive, so the page is one LIMIT/OFFSET read in the feed's total order.
    const [first] = window.indexes;
    const page = first === undefined ? [] : await deps.repository.comments.commentFeedPage(tx, args, { offset: first, limit: window.indexes.length });
    const keyed = page.map((comment) => ({ comment, contentId: javaTrim(comment.contentid ?? ''), contentSiteId: javaTrim(comment.siteid ?? '') }));
    const contentIdsBySite = new Map<string, string[]>();
    for (const { contentId, contentSiteId } of keyed) {
      const contentIds = contentIdsBySite.get(contentSiteId) ?? [];
      contentIds.push(contentId);
      contentIdsBySite.set(contentSiteId, contentIds);
    }
    const activeBySite = new Map<string, Map<string, ActiveContent>>();
    for (const [contentSiteId, contentIds] of contentIdsBySite) {
      activeBySite.set(contentSiteId, await deps.repository.content.readActiveIn(tx, { siteId: contentSiteId, contentIds }));
    }
    const rows: LoadCommentsRow[] = keyed.map(({ comment, contentId, contentSiteId }) => ({
      comment,
      content: activeBySite.get(contentSiteId)?.get(contentId) ?? null,
    }));
    return {
      siteId,
      keywords: scope.text('keywords'),
      commentStatus: scope.text('commentStatus'),
      startDate: scope.text('startdate'),
      endDate: scope.text('enddate'),
      categoryId: scope.text('categoryID'),
      sortBy,
      sortDirection,
      sortDirLink,
      nextN,
      pageNo: window.pageNo,
      totalPages: window.totalPages,
      startPage: window.startPage,
      endPage: window.endPage,
      recordCount,
      rows,
      now,
    };
  });
}

/** The `rc.p` rows of ccomments.cfc:303-351: the requested comment, or three rows above or below a neighbour. */
function commentsPageRows(rows: readonly CommentRow[], commentId: string, upperId: string, lowerId: string): { startRow: number; endRow: number } {
  const position = (id: string): number => rows.findIndex((row) => cfEq(row.commentid, id)) + 1;
  let startRow = 1;
  let endRow = 1;
  const commentPos = position(commentId);
  if (commentPos > 0) {
    startRow = commentPos;
    endRow = commentPos;
  }
  if (upperId !== '') {
    const upperPos = position(upperId);
    if (upperPos > 0) {
      startRow = Math.max(upperPos - 2, 1);
      endRow = upperPos;
    }
  }
  if (lowerId !== '') {
    const lowerPos = position(lowerId);
    if (lowerPos > 0) {
      startRow = lowerPos;
      endRow = lowerPos + 2;
    }
    if (endRow > rows.length) endRow = rows.length;
  }
  return { startRow, endRow };
}

/**
 * ccomments.loadCommentsPage (284-352): every comment of the content in `siteId` (the event site) in the requested
 * direction, the rows the view shows, and for those rows the commenter's remote id and the parent comment's name.
 */
export async function loadCommentsPage(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  siteId: string,
): Promise<CommentsPage> {
  const now = deps.clock.now();
  const scope = new CfScope(rc);
  for (const key of ['contentID', 'commentID', 'upperID', 'lowerID', 'parentID']) scope.param(key, '');
  scope.param('sortDirection', 'asc');
  const contentId = scope.text('contentID');
  const sort = listOption(scope.text('sortDirection'), ['asc', 'desc'], 'asc');
  const commentId = scope.text('commentID');
  const upperId = scope.text('upperID');
  const lowerId = scope.text('lowerID');
  return withTenant(deps.db, actor.tenantId, async (tx) => {
    const comments = deps.repository.comments;
    const all = await comments.commentFeed(tx, { contentId, siteId, sortDirection: sort });
    const { startRow, endRow } = commentsPageRows(all, commentId, upperId, lowerId);
    const isShown = (index: number): boolean => index + 1 >= startRow && index + 1 <= endRow;
    const shown = all.filter((_, index) => isShown(index));
    const commenters = await comments.findCommenters(tx, shown.map((comment) => javaTrim(comment.userid ?? '')));
    const parents = await comments.commentNames(tx, shown.map((comment) => javaTrim(comment.parentid ?? '')).filter((parentId) => parentId !== ''));
    const rows: CommentsPageRow[] = all.map((comment, index) => {
      if (!isShown(index)) return { comment, commenterRemoteId: '', parentName: null };
      const parentId = javaTrim(comment.parentid ?? '');
      const parent = parentId === '' ? undefined : parents.get(parentId);
      return {
        comment,
        commenterRemoteId: javaTrim(commenters.get(javaTrim(comment.userid ?? ''))?.remoteid ?? ''),
        parentName: parent === undefined ? null : javaTrim(parent.name ?? ''),
      };
    });
    return { siteId, contentId, commentId, upperId, lowerId, sort, startRow, endRow, rows, now };
  });
}

// ---- state changes ----

/** One single-column change of a loaded comment (contentCommentBean delete, undelete, markAsSpam, unMarkAsSpam). */
type CommentChange = (repository: ContentRepository, tx: TenantTx, commentId: string, write: WriteContext) => Promise<unknown>;

/** contentManager's load-then-change calls: the change runs only with module access, then the content's comment stat. */
async function changeComment(deps: DomainDeps, actor: Actor, commentId: string, change: CommentChange, options: CommentCallOptions): Promise<void> {
  const write = writeContextFor(actor, options.requestId);
  await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const bean = await loadBean(tx, deps, commentId);
    if (!allowModuleAccess(actor, options.apiRequest === true)) return;
    await change(deps.repository, tx, commentIdOf(bean), write);
    await setCommentStat(tx, deps.repository, bean.contentID, bean.siteID, write);
  });
}

/** A manager call legacy wraps in try/catch to handleError (341-348) before answering true. */
async function managerCall(operation: string, options: CommentCallOptions, call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
  } catch (error) {
    swallow(error, operation, options);
  }
  return true;
}

const setDeleted =
  (isDeleted: number): CommentChange =>
  (repository, tx, commentId, write) =>
    repository.comments.setDeleted(tx, { commentId, isDeleted }, write);

const setSpam =
  (isSpam: number): CommentChange =>
  (repository, tx, commentId, write) =>
    repository.comments.setSpam(tx, { commentId, isSpam }, write);

/** contentCommentManager.delete (323-330): sets `isDeleted = 1` (no trash row) and recounts the content's comments; true. */
export function deleteComment(deps: DomainDeps, actor: Actor, commentId: string, options: CommentCallOptions = {}): Promise<boolean> {
  return managerCall('delete', options, () => changeComment(deps, actor, commentId, setDeleted(1), options));
}

/** contentCommentManager.undelete (332-339): sets `isDeleted = 0` and recounts; true. */
export function undeleteComment(deps: DomainDeps, actor: Actor, commentId: string, options: CommentCallOptions = {}): Promise<boolean> {
  return managerCall('undelete', options, () => changeComment(deps, actor, commentId, setDeleted(0), options));
}

/** contentCommentManager.markAsSpam (283-294): loads the comment outside the try, then sets `isSpam = 1` and recounts; true. */
export async function markAsSpam(deps: DomainDeps, actor: Actor, commentId: string, options: CommentCallOptions = {}): Promise<boolean> {
  await withTenant(deps.db, actor.tenantId, (tx) => loadBean(tx, deps, commentId));
  return managerCall('markAsSpam', options, () => changeComment(deps, actor, commentId, setSpam(1), options));
}

/** contentCommentManager.unmarkAsSpam (296-306): loads the comment outside the try, then sets `isSpam = 0` and recounts; true. */
export async function unmarkAsSpam(deps: DomainDeps, actor: Actor, commentId: string, options: CommentCallOptions = {}): Promise<boolean> {
  await withTenant(deps.db, actor.tenantId, (tx) => loadBean(tx, deps, commentId));
  return managerCall('unmarkAsSpam', options, () => changeComment(deps, actor, commentId, setSpam(0), options));
}

/**
 * contentCommentManager.approve (265-281): loads the comment, approves and saves it with notification when it exists
 * (contentManager.approveComment), then runs notifySubscribers on the first load again. Never sends: the mails legacy
 * would send are the result's notices.
 */
export async function approveComment(
  deps: DomainDeps,
  actor: Actor,
  commentId: string,
  site: CommentSite,
  options: CommentCallOptions = {},
): Promise<DomainResult<boolean>> {
  const before = await withTenant(deps.db, actor.tenantId, (tx) => loadBean(tx, deps, commentId));
  const write = writeContextFor(actor, options.requestId);
  const notices: MailNotice[] = [];
  try {
    const saved = await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
      const bean = await loadBean(tx, deps, commentId);
      if (bean.isNew !== 0) return [];
      bean.isApproved = 1;
      const args = { script: '', subject: '', notifySite: site, apiRequest: options.apiRequest === true, remoteAddr: '' };
      return (await saveBean(tx, deps, actor, bean, site, args, write)).notices;
    });
    notices.push(...saved);
  } catch (error) {
    swallow(error, 'approve', options);
  }
  try {
    notices.push(...(await withTenant(deps.db, actor.tenantId, (tx) => notifySubscribers(tx, deps, before, site, { script: '', subject: '' }))));
  } catch (error) {
    swallow(error, 'notifySubscribers', options);
  }
  return { value: true, errors: {}, notices };
}

/** contentCommentManager.unapprove (313-321): `isApproved = 0` and a save without notification (a no-op when invalid); true. */
export function unapproveComment(
  deps: DomainDeps,
  actor: Actor,
  commentId: string,
  site: CommentSite,
  options: CommentCallOptions = {},
): Promise<boolean> {
  const write = writeContextFor(actor, options.requestId);
  return managerCall('unapprove', options, () =>
    withGatedTenant(deps.db, actor.tenantId, async (tx) => {
      const bean = await loadBean(tx, deps, commentId);
      bean.isApproved = 0;
      const args = { script: '', subject: '', apiRequest: options.apiRequest === true, remoteAddr: '' };
      await saveBean(tx, deps, actor, bean, site, args, write);
    }),
  );
}

/** Outcome of a ccomments ajax edit: `rc.processed` (unset where legacy leaves it unset) and the mails it would send. */
export interface CommentEditResult {
  processed?: boolean;
  notices: MailNotice[];
}

/** Where the redirecting ccomments actions send the browser (`getFW().redirect`). */
export interface CommentsRedirect {
  action: string;
  preserve: readonly string[];
  path: string;
}

/** `redirect(action='cComments.default', preserve='processed,isapproved,siteid', path="./")`. */
export const COMMENTS_DEFAULT_REDIRECT: Readonly<CommentsRedirect> = Object.freeze({
  action: 'cComments.default',
  preserve: Object.freeze(['processed', 'isapproved', 'siteid']),
  path: './',
});

/** Outcome of a redirecting ccomments action. */
export interface CommentRedirectResult {
  processed: boolean;
  notices: MailNotice[];
  redirect: Readonly<CommentsRedirect>;
}

/** A CF list request value: a string, or the values of a repeated form field joined by commas. */
function listValue(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => simpleText(item) ?? '').join(',') : (simpleText(value) ?? '');
}

/**
 * ccomments.bulkEdit (107-139): applies `bulkedit` to every id of `ckupdate`; the first error ends the loop with
 * `processed = false`. `delete` deletes, `spam` marks spam then undeletes, `approve` unmarks spam, undeletes, approves.
 */
export async function bulkEdit(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  site: CommentSite,
  options: CommentCallOptions = {},
): Promise<CommentEditResult> {
  const scope = new CfScope(rc);
  const ids = cfListToArray(listValue(scope.get('ckupdate')));
  const notices: MailNotice[] = [];
  if (ids.length === 0) return { processed: true, notices };
  try {
    const action = scope.has('bulkedit') ? simpleText(scope.get('bulkedit')) : undefined;
    if (action === undefined) throw new Error('Element BULKEDIT is undefined in RC.');
    for (const id of ids) {
      switch (action.toLowerCase()) {
        case 'delete':
          await deleteComment(deps, actor, id, options);
          break;
        case 'spam':
          await markAsSpam(deps, actor, id, options);
          await undeleteComment(deps, actor, id, options);
          break;
        case 'approve':
          await unmarkAsSpam(deps, actor, id, options);
          await undeleteComment(deps, actor, id, options);
          notices.push(...(await approveComment(deps, actor, id, site, options)).notices);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    swallow(error, 'bulkEdit', options);
    return { processed: false, notices };
  }
  return { processed: true, notices };
}

/** ccomments.singleEdit (141-168): one `updateAction` on `commentid`; an error sets `processed = false`, success leaves it unset. */
export async function singleEdit(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  site: CommentSite,
  options: CommentCallOptions = {},
): Promise<CommentEditResult> {
  const scope = new CfScope(rc);
  scope.param('commentid', '');
  scope.param('updateAction', '');
  const commentId = scope.text('commentid');
  const notices: MailNotice[] = [];
  try {
    switch (scope.text('updateAction').toLowerCase()) {
      case 'approve':
        notices.push(...(await approveComment(deps, actor, commentId, site, options)).notices);
        break;
      case 'unapprove':
        await unapproveComment(deps, actor, commentId, site, options);
        break;
      case 'delete':
        await deleteComment(deps, actor, commentId, options);
        break;
      case 'spam':
        await markAsSpam(deps, actor, commentId, options);
        break;
      case 'undelete':
        await undeleteComment(deps, actor, commentId, options);
        break;
      case 'unspam':
        await unmarkAsSpam(deps, actor, commentId, options);
        break;
      default:
        break;
    }
  } catch (error) {
    swallow(error, 'singleEdit', options);
    return { processed: false, notices };
  }
  return { notices };
}

/** A redirecting action: `processed` is false without a `commentid`, else the manager's answer. */
async function redirectAction(
  rc: Readonly<Record<string, unknown>>,
  call: (commentId: string) => Promise<{ processed: boolean; notices: MailNotice[] }>,
): Promise<CommentRedirectResult> {
  const scope = new CfScope(rc);
  const result = scope.has('commentid') ? await call(scope.text('commentid')) : { processed: false, notices: [] };
  return { ...result, redirect: COMMENTS_DEFAULT_REDIRECT };
}

/** ccomments.approve (170-176). */
export function approveCommentAction(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  site: CommentSite,
  options: CommentCallOptions = {},
): Promise<CommentRedirectResult> {
  return redirectAction(rc, async (id) => {
    const result = await approveComment(deps, actor, id, site, options);
    return { processed: result.value, notices: result.notices };
  });
}

/** ccomments.unapprove (179-185). */
export function unapproveCommentAction(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  site: CommentSite,
  options: CommentCallOptions = {},
): Promise<CommentRedirectResult> {
  return redirectAction(rc, async (id) => ({ processed: await unapproveComment(deps, actor, id, site, options), notices: [] }));
}

/** ccomments.delete (188-194). */
export function deleteCommentAction(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  options: CommentCallOptions = {},
): Promise<CommentRedirectResult> {
  return redirectAction(rc, async (id) => ({ processed: await deleteComment(deps, actor, id, options), notices: [] }));
}

/** ccomments.markAsSpam (196-202). */
export function markAsSpamAction(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  options: CommentCallOptions = {},
): Promise<CommentRedirectResult> {
  return redirectAction(rc, async (id) => ({ processed: await markAsSpam(deps, actor, id, options), notices: [] }));
}

/** The environment-dependent legacy outcome of purgeDeletedComments, for the parity process; the target has one datasource and answers true. */
export const PURGE_READONLY_DATASOURCE_NOTE =
  'contentCommentManager.purgeDeletedComments deletes through the read-only datasource; legacy answers false only where ' +
  'that datasource cannot DELETE. The reused environment configures none, so it uses the main datasource and answers true.';

/** contentCommentManager.purgeDeletedComments (390-417): removes the deleted comments, of `siteId` when given; false when the delete fails. */
export async function purgeDeletedComments(
  deps: DomainDeps,
  actor: Actor,
  siteId?: string,
  options: CommentCallOptions = {},
): Promise<boolean> {
  const write = writeContextFor(actor, options.requestId);
  try {
    await withGatedTenant(deps.db, actor.tenantId, (tx) =>
      deps.repository.comments.purgeDeleted(tx, siteId === undefined ? {} : { siteId }, write),
    );
    return true;
  } catch (error) {
    swallow(error, 'purgeDeletedComments', options);
    return false;
  }
}

/** ccomments.purgeDeletedComments (354-357): purges the deleted comments of `rc.siteid`, then redirects. */
export async function purgeDeletedCommentsAction(
  deps: DomainDeps,
  actor: Actor,
  rc: Readonly<Record<string, unknown>>,
  options: CommentCallOptions = {},
): Promise<CommentRedirectResult> {
  const processed = await purgeDeletedComments(deps, actor, new CfScope(rc).text('siteid'), options);
  return { processed, notices: [], redirect: COMMENTS_DEFAULT_REDIRECT };
}

/** A JSON API `comment` save. */
export interface SaveCommentInput {
  /** The id jsonApiUtility.save resolved: the request's `commentid` when a CF UUID, else a new createUUID(). */
  commentId: string;
  /** `$.event().getAllValues()`, applied over the loaded comment as `entity.set` applies them. */
  values: Readonly<Record<string, unknown>>;
  site: CommentSaveSite;
  /** `request.remoteAddr`, else `CGI.REMOTE_ADDR`: the `ip` a new comment stores. */
  remoteAddr: string;
  requestId?: string;
}

/**
 * JSON API `comment` save (jsonApiUtility.cfc:1903-2068): loads the comment, applies the request values, refuses with
 * `authorization` unless allowSave (module access, or a new comment) or the comments module allows the actor, then saves
 * without notification.
 * @returns the bean values after the save and its validation errors; nothing is written when validation fails.
 */
export function saveComment(deps: DomainDeps, actor: Actor, input: SaveCommentInput): Promise<DomainResult<CommentValues>> {
  const write = writeContextFor(actor, input.requestId);
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const bean = await loadBean(tx, deps, input.commentId);
    applyValues(bean, input.values);
    const allowSave = allowModuleAccess(actor, true) || bean.isNew !== 0;
    if (!(allowSave || hasModulePerm(actor, COMMENTS_MODULE_ROLE))) {
      throw new LegacyApiError('authorization');
    }
    const args = { script: '', subject: '', apiRequest: true, remoteAddr: input.remoteAddr };
    const saved = await saveBean(tx, deps, actor, bean, input.site, args, write);
    return { value: beanValues(bean, input.site.urls.scheme), errors: saved.errors, notices: saved.notices };
  });
}

// ---- commentsProxy data methods ----

/** commentsProxy `get` (88-95): `getAllValues()` of the comment `load()` finds, or of a new bean holding the requested id. */
export function getCommentValues(deps: DomainDeps, tenantId: string, commentId: string, view: CommentValuesView): Promise<CommentValues> {
  return withTenant(deps.db, tenantId, async (tx) => beanValues(await loadBean(tx, deps, commentId, view.commenterPhoto), view.scheme));
}

// ---- JSON API bean reads ----

/**
 * JSON API `loadBy(commentID=id)` (jsonApiUtility.cfc:2363-2364): unlike `load()`, a miss keeps no id, so getCommentID()
 * creates one. `overlay` values are then set over the bean, as save does after validation errors (2049-2057).
 */
export function findCommentValues(
  deps: DomainDeps,
  tenantId: string,
  commentId: string,
  view: CommentValuesView,
  overlay: Readonly<Record<string, unknown>> = {},
): Promise<CommentValues> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const bean = await loadBean(tx, deps, commentId, view.commenterPhoto);
    if (bean.isNew !== 0) bean.commentID = '';
    for (const [key, value] of Object.entries(overlay)) {
      if (value !== undefined && value !== null) setBeanValue(bean, key, value);
    }
    commentIdOf(bean);
    return beanValues(bean, view.scheme);
  });
}

/**
 * A feed iterator's bean (beanIterator.cfc:98-101), `getBean('comment').set(row).setIsNew(0)`; columns without a bean
 * property (`ip`, `contenthistid`) follow, trimmed, with NULL as ''.
 */
export function feedCommentValues(row: Readonly<Record<string, unknown>>, scheme: string, now: Date): Record<string, unknown> {
  const bean = newBean(now);
  applyValues(bean, row);
  bean.isNew = 0;
  const columns: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    const lowered = column.toLowerCase();
    if (lowered === 'tenant_id' || lowered === 'entered' || STRING_PROPERTIES.has(lowered) || NUMBER_PROPERTIES.has(lowered)) continue;
    const text = simpleText(value);
    columns[column] = text === undefined ? value : javaTrim(text);
  }
  return { ...beanValues(bean, scheme), ...columns };
}

/** Who a proxy write is changelogged for; anonymous when omitted. */
export interface ProxyWriteOptions {
  actor?: Actor;
  requestId?: string;
}

/** commentsProxy `flag` (97-102) and contentCommentBean.flag: `flagCount + 1`, then the content's comment stat; no access check, as legacy. */
export async function flagComment(deps: DomainDeps, tenantId: string, commentId: string, options: ProxyWriteOptions = {}): Promise<void> {
  const write = writeContextFor(options.actor ?? ANONYMOUS, options.requestId);
  await withGatedTenant(deps.db, tenantId, async (tx) => {
    const bean = await loadBean(tx, deps, commentId);
    await deps.repository.comments.incrementFlagCount(tx, { commentId: commentIdOf(bean) }, write);
    await setCommentStat(tx, deps.repository, bean.contentID, bean.siteID, write);
  });
}

/**
 * commentsProxy `getContentStats` (104-111): `getStats().getAllValues()` of the content active in `siteId`. A missing
 * content's bean holds no id, so getContentID() creates one and the stats are the defaults under it.
 */
export function getContentStatsValues(deps: DomainDeps, tenantId: string, contentId: string, siteId: string): Promise<ContentStats> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const [content] = await deps.repository.content.readActive(tx, { contentId, siteId });
    const id = content === undefined ? '' : javaTrim(content.contentid ?? '');
    const site = content === undefined ? siteId : javaTrim(content.siteid ?? '');
    return statsValues(await loadStats(tx, deps.repository, id === '' ? cfUuid() : id, site));
  });
}
