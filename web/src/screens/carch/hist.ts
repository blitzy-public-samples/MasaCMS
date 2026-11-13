// The `cArch.hist` page: a node's version history, after `carch/hist.cfm` (server-only).
import { cfEq, cfLsDateFormat, cfLsTimeFormat, cfToBoolean } from '@opt2/platform/legacy-compat';
import { isCompactDisplay } from '@/lib/cfml';
import { parseLegacyDate } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, encodeJs, raw, type SafeHtml } from '@/lib/html';
import { sessionSiteModulePerm, type AdminRequest, type RequestContext } from '@/lib/request-context';
import { relativeAdminUrl } from '@/lib/urls';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import {
  isSiteAdminOrS2,
  isSuperOrAdminUser,
  lockState,
  permOf,
  structText,
  structValue,
  type CarchCrumb,
  type CarchStats,
  type CarchStruct,
  type LockState,
  type NodePerm,
} from './model';
import { draftPromptJs } from './partials/draft-prompt-js';
import { carchJs } from './partials/js';
import { status, type StatusLockUser, type StatusModel } from './partials/status';
import { dspZoom } from './partials/zoom';
import {
  bindCarchSecondaryMenu,
  carchSecondaryMenuCsrfContexts,
  renderCarchSecondaryMenu,
  type CarchMenuContent,
  type CarchSecondaryMenuInput,
} from './secondary-menu';
import { carchPageData, type CarchOutcome, type CarchPageModel } from './service';

const OPERATION = 'strategies-content getContentHistory';

/** Change Sets module, whose access links each version's change set. */
const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';

/** The `cfcase` types whose versions get a Preview item. */
const PREVIEW_TYPES = Object.freeze(['Page', 'Folder', 'Calendar', 'Gallery', 'Link', 'File', 'Variation']);

/** Approval statuses whose bundle label names the version status (`listFindNoCase('Pending,Rejected', …)`). */
const LABELLED_APPROVALS = Object.freeze(['pending', 'rejected']);

// ---- Screen model ----

/** `rc.contentBean`, the node's active version, as the view, its menu and its status include read it. */
export interface HistContent extends CarchMenuContent {
  readonly contentId: string;
  readonly siteId: string;
  readonly approvalStatus: string;
  /** `getDisplay()`; 2 is a scheduled display window. */
  readonly display: number;
}

/** One `rc.items` row: a `contentManager.getHist` version, read through the iterator's nav bean. */
export interface HistVersion {
  readonly contentHistId: string;
  readonly contentId: string;
  readonly siteId: string;
  readonly type: string;
  /** `getparentID()`, which the nav bean reads from the version itself. */
  readonly parentId: string;
  readonly moduleId: string;
  readonly menuTitle: string;
  readonly active: boolean;
  readonly approved: boolean;
  /** `tapprovalrequests.status`; `''` without an approval request. */
  readonly approvalStatus: string;
  readonly changesetId: string;
  readonly changesetName: string;
  /** `tchangesets.publishDate` when `isDate`, else null. */
  readonly changesetPublishDate: Date | null;
  readonly notes: string;
  /** `majorVersion` and `minorVersion` as printed; read only on a File node whose stats carry a major version. */
  readonly majorVersion: string;
  readonly minorVersion: string;
  /** `lastUpdate`; null when NULL or blank. */
  readonly lastUpdate: Date | null;
  readonly lastUpdateBy: string;
  /** `rc.contentBean.getURL(complete=1, queryString='previewid=<contentHistID>')`, for non-variation previews. */
  readonly previewUrl?: string;
}

/** What `cArch.hist` renders: the controller's and view's values, with the site flags and the user's access. */
export interface HistData {
  readonly content: HistContent;
  readonly versions: readonly HistVersion[];
  /** `contentManager.getCrumbList(rc.contentid, rc.siteid)`. */
  readonly crumbs: readonly CarchCrumb[];
  /** `rc.perm`: `permUtility.getnodeperm(crumbdata)`. */
  readonly perm: NodePerm;
  /** `rc.deletable`, as the view computes it from the site's `locking` setting. */
  readonly deletable: boolean;
  /** `$.siteConfig('hasLockableNodes')`. */
  readonly hasLockableNodes: boolean;
  /** `getSite(rc.siteID).getHasChangesets()`. */
  readonly hasChangesets: boolean;
  /** `getModulePerm('…014', session.siteid)`. */
  readonly hasChangesetAccess: boolean;
  /** configBean `getJavaEnabled()`, which adds the compare columns. */
  readonly javaEnabled: boolean;
  /** configBean `getPurgeDrafts()`; the Components, Forms and Variations menus read it. */
  readonly purgeDrafts?: boolean;
  /** The lock holder `dsp_status.cfm` loads when someone else holds the node lock. */
  readonly lockedBy?: StatusLockUser;
}

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The struct under `key`; throws when the model omits it. */
function structAt(struct: CarchStruct, key: string): CarchStruct {
  const value = structValue(struct, key);
  if (!isStruct(value)) throw new TypeError(`${OPERATION} returned no ${key} struct`);
  return value;
}

/** The query rows under `key`; throws unless they are an array of structs. */
function rowsAt(struct: CarchStruct, key: string): readonly CarchStruct[] {
  const value = structValue(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${OPERATION} returned no ${key} rows`);
  return value;
}

/** A CFML boolean under `key`; throws when absent or NULL, which CFML cannot test either. */
function flagAt(struct: CarchStruct, key: string, owner: string): boolean {
  const value = structValue(struct, key);
  if (value === undefined || value === null) throw new TypeError(`${OPERATION} returned no ${owner}.${key}`);
  return cfToBoolean(value);
}

/** A date column, null when NULL or blank; throws for text LSDateFormat could not read. */
function dateAt(row: CarchStruct, key: string): Date | null {
  const text = structText(row, key);
  if (text.trim() === '') return null;
  const date = parseLegacyDate(text);
  if (date === null) throw new RangeError(`${OPERATION} returned ${key} '${text}', which is not a date`);
  return date;
}

/** `rc.contentBean` with its stats. */
function contentOf(bean: CarchStruct, stats: CarchStats): HistContent {
  return {
    isNew: flagAt(bean, 'isNew', 'contentBean'),
    type: structText(bean, 'type'),
    subType: structText(bean, 'subType'),
    active: Number(structText(bean, 'active')),
    filename: structText(bean, 'filename'),
    contentHistId: structText(bean, 'contentHistID'),
    parentId: structText(bean, 'parentID'),
    menuTitle: structText(bean, 'menuTitle'),
    remoteUrl: structText(bean, 'remoteURL'),
    fileId: structText(bean, 'fileID'),
    stats,
    contentId: structText(bean, 'contentID'),
    siteId: structText(bean, 'siteID'),
    approvalStatus: structText(bean, 'approvalStatus'),
    display: Number(structText(bean, 'display')),
  };
}

/** One `rc.items` row. */
function versionOf(row: CarchStruct): HistVersion {
  const previewUrl = structValue(row, 'previewURL');
  return {
    contentHistId: structText(row, 'contentHistID'),
    contentId: structText(row, 'contentID'),
    siteId: structText(row, 'siteID'),
    type: structText(row, 'type'),
    parentId: structText(row, 'parentID'),
    moduleId: structText(row, 'moduleID'),
    menuTitle: structText(row, 'menuTitle'),
    active: flagAt(row, 'active', 'items'),
    approved: flagAt(row, 'approved', 'items'),
    approvalStatus: structText(row, 'approvalStatus'),
    changesetId: structText(row, 'changesetID'),
    changesetName: structText(row, 'changesetName'),
    changesetPublishDate: parseLegacyDate(structText(row, 'changesetPublishDate')),
    notes: structText(row, 'notes'),
    majorVersion: structText(row, 'majorVersion'),
    minorVersion: structText(row, 'minorVersion'),
    lastUpdate: dateAt(row, 'lastUpdate'),
    lastUpdateBy: structText(row, 'lastUpdateBy'),
    ...(typeof previewUrl === 'string' ? { previewUrl } : {}),
  };
}

/** `$.getBean('user').loadBy(stats.getLockID())`, when the model carries it. */
function lockedByOf(rc: CarchStruct): StatusLockUser | undefined {
  const user = structValue(rc, 'lockedBy');
  if (user === undefined || user === null) return undefined;
  if (!isStruct(user)) throw new TypeError(`${OPERATION} returned lockedBy that is not a struct`);
  return { fname: structText(user, 'fname'), lname: structText(user, 'lname'), email: structText(user, 'email') };
}

/** The session site's `hasChangesets`; throws when programs-sites served the user no session site. */
function hasChangesetsOf(req: AdminRequest): boolean {
  if (req.site === undefined) throw new TypeError(`programs-sites served no site ${req.session.siteid} for carch.hist`);
  return req.site.hasChangesets;
}

/**
 * The history model as the view reads it: `rc.contentBean`, `rc.items`, `crumbdata`, `rc.perm`, `rc.deletable`,
 * `hasLockableNodes` (a site setting programs-sites does not serve web), `stats` (`rc.stats`, else nested in the
 * content bean), and the optional `lockedBy` and `purgeDrafts`.
 * @throws TypeError When the model omits a value the view reads.
 */
export function histDataOf(req: AdminRequest, model: CarchPageModel): HistData {
  const { rc } = model;
  const bean = structAt(rc, 'contentBean');
  const stats = isStruct(structValue(rc, 'stats')) ? structAt(rc, 'stats') : structAt(bean, 'stats');
  const purgeDrafts = structValue(rc, 'purgeDrafts');
  const lockedBy = lockedByOf(rc);
  return {
    content: contentOf(bean, stats),
    versions: rowsAt(rc, 'items').map(versionOf),
    crumbs: rowsAt(rc, 'crumbdata'),
    perm: permOf(model),
    deletable: flagAt(rc, 'deletable', 'rc'),
    hasLockableNodes: flagAt(rc, 'hasLockableNodes', 'rc'),
    hasChangesets: hasChangesetsOf(req),
    hasChangesetAccess: sessionSiteModulePerm(req, CHANGESETS_MODULE_ID),
    javaEnabled: legacySettings().javaEnabled,
    ...(purgeDrafts === undefined || purgeDrafts === null ? {} : { purgeDrafts: cfToBoolean(purgeDrafts) }),
    ...(lockedBy === undefined ? {} : { lockedBy }),
  };
}

// ---- Controller ----

const CONTROLLER_OUTCOMES = new WeakMap<ScreenContext, Promise<CarchOutcome<CarchPageModel>>>();

/** carch `before()` then `hist()`, once per request: the carch defaults on `ctx.req` and the history read. */
function histOutcome(ctx: ScreenContext): Promise<CarchOutcome<CarchPageModel>> {
  let outcome = CONTROLLER_OUTCOMES.get(ctx);
  if (outcome === undefined) {
    ctx.req = applyCarchDefaults(ctx.req);
    outcome = carchPageData(ctx, 'hist');
    CONTROLLER_OUTCOMES.set(ctx, outcome);
  }
  return outcome;
}

/** The controller step: a strategies-content denial answers with carch's `secure()` redirect. */
async function histRedirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const outcome = await histOutcome(ctx);
  return outcome.kind === 'redirect' ? { kind: 'location', location: outcome.location } : undefined;
}

// ---- View state ----

/** Lock and access flags the view derives once: `isLockedBySomeoneElse` and `poweruser`. */
interface HistAccess {
  readonly lock: LockState;
  /** `$.currentUser().isSuperUser() or $.currentUser().isAdminUser()`. */
  readonly poweruser: boolean;
}

/** The node lock flags for the session user and the user's super or admin standing. */
function accessOf(req: AdminRequest, data: HistData): HistAccess {
  return { lock: lockState(data.content.stats, data, req.session.mura.userID), poweruser: isSuperOrAdminUser(req) };
}

/** The Delete item's test: an inactive version, not locked by someone else, for an editor, site admin or S2. */
const canDelete = (req: AdminRequest, data: HistData, access: HistAccess, version: HistVersion): boolean =>
  !version.active &&
  !access.lock.isLockedBySomeoneElse &&
  (cfEq(data.perm, 'editor') || isSiteAdminOrS2(req));

/** Edit links render unless someone else holds the node lock, which super and admin users override. */
const canEdit = (access: HistAccess): boolean => !access.lock.isLockedBySomeoneElse || access.poweruser;

/** `rc[name]` after the carch defaults; throws as CFML does for an undefined element. */
function rcText(rc: RequestContext, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

const isCompact = (rc: RequestContext): boolean => isCompactDisplay(rcText(rc, 'compactDisplay'));

// ---- Load ----

/**
 * The history model of `rc.contentid` with the CSRF tokens the view renders: the secondary menu's and each Delete
 * link's `<contenthistid>delete`; gateway unavailability propagates.
 * @throws Error When strategies-content rejects the read with another 4xx, as legacy fails on a missing node.
 */
async function loadHist(ctx: ScreenContext): Promise<HistData> {
  const outcome = await histOutcome(ctx);
  if (outcome.kind === 'redirect') throw new Error(`${OPERATION} was denied; the controller step redirects first`);
  if (outcome.kind === 'rejected') throw new Error(`${OPERATION} rejected carch.hist with HTTP ${outcome.status}`);
  const { req } = ctx;
  const data = histDataOf(req, outcome.data);
  const access = accessOf(req, data);
  await ctx.csrf.prefetch([
    ...(isCompact(req.rc) ? [] : carchSecondaryMenuCsrfContexts(req.rc)),
    ...data.versions
      .filter((version) => canDelete(req, data, access, version))
      .map((version) => `${version.contentHistId}delete`),
  ]);
  return data;
}

// ---- Markup ----

const NO_BREAK_SPACES = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one character. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

/**
 * View output as ACF whitespace management writes it, CFML comments already removed from the template text: text
 * holding any non-whitespace prints verbatim, whitespace-only text prints one space after non-whitespace output and
 * nothing after whitespace or at the start.
 */
class CfOutput {
  #out = '';

  /** One run of template text between two tags or expressions. */
  text(run: string): void {
    if ([...run].every(isJavaWhitespace)) this.gap();
    else this.#out += run;
  }

  /** Whitespace-only template text, or several such runs in a row. */
  gap(): void {
    if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
  }

  /** An expression's or include's output, verbatim. */
  value(output: string | SafeHtml): void {
    this.#out += String(output);
  }

  get markup(): string {
    return this.#out;
  }
}

/** What one render reads besides the version. */
interface RowScope {
  readonly ctx: ScreenContext;
  readonly data: HistData;
  readonly access: HistAccess;
  readonly compact: boolean;
  readonly locale: string;
  readonly dateKeyFormat: string;
  label(key: string): string;
  /** `[name, rc[name]]`, URL-encoded as `esapiEncode('url', rc[name])`. */
  rcParam(name: string): [string, string];
}

/** The version's edit link, `rc` values URL-encoded and the version's ids as printed. */
function editUrl(m: RowScope, version: HistVersion): string {
  return relativeAdminUrl('cArch', 'edit', [
    ['contenthistid', version.contentHistId, 'raw'],
    ['contentid', version.contentId, 'raw'],
    m.rcParam('type'),
    m.rcParam('parentid'),
    m.rcParam('topid'),
    m.rcParam('siteid'),
    m.rcParam('startrow'),
    m.rcParam('moduleid'),
    ['return', 'hist', 'raw'],
    m.rcParam('compactDisplay'),
  ]);
}

/** The attributes after the edit link's `href`, which open the draft prompt. */
function draftPromptAttrs(out: CfOutput, version: HistVersion): void {
  out.text('" class="draftprompt" data-targetversion="true" data-siteid="');
  out.value(version.siteId);
  out.text('" data-contentid="');
  out.value(version.contentId);
  out.text('" data-contenthistid="');
  out.value(version.contentHistId);
}

/** The Preview URL: the variation's remote URL, else the content URL strategies-content built for the version. */
function previewUrlOf(m: RowScope, version: HistVersion): string {
  if (cfEq(version.type, 'Variation')) return `${m.data.content.remoteUrl}?previewid=${version.contentHistId}`;
  if (version.previewUrl === undefined) throw new TypeError(`${OPERATION} returned no items.previewURL`);
  return version.previewUrl;
}

/** The Delete Version link and its CSRF tokens, parameters separated by `&amp;`. */
function deleteUrl(m: RowScope, version: HistVersion): string {
  const href = relativeAdminUrl(
    'cArch',
    'update',
    [
      ['contenthistid', version.contentHistId, 'raw'],
      ['action', 'delete', 'raw'],
      m.rcParam('contentid'),
      m.rcParam('type'),
      m.rcParam('parentid'),
      m.rcParam('topid'),
      m.rcParam('siteid'),
      m.rcParam('startrow'),
      m.rcParam('moduleid'),
      m.rcParam('compactDisplay'),
    ],
    { html: true },
  );
  return href + m.ctx.csrf.render(`${version.contentHistId}delete`, 'url').value;
}

/** The version's status label, by the view's `cfif` chain. */
function versionStatus(m: RowScope, version: HistVersion): string {
  if (version.active && version.approved) return m.label('sitemanager.content.published');
  if (LABELLED_APPROVALS.includes(version.approvalStatus.toLowerCase())) {
    return m.label(`sitemanager.content.${version.approvalStatus}`);
  }
  if (!version.approved && version.changesetId.length > 0) return m.label('sitemanager.content.queued');
  if (!version.approved) {
    return m.label(cfEq(version.approvalStatus, 'Cancelled') ? 'sitemanager.content.canceled' : 'sitemanager.content.draft');
  }
  return m.label('sitemanager.content.archived');
}

/** `hist.cfm` lines 163-208: the row's actions menu. */
function actionsCell(m: RowScope, version: HistVersion, out: CfOutput): void {
  const { ctx, data, access } = m;
  out.text(
    '">\n\t\t\t\t<td class="actions">\n\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>\n\t\t\t\t\t<div class="actions-menu hide">\n\t\t\t\t\t\t<ul class="actions-list">\n\t\t\t\t\t\t',
  );
  if (canEdit(access)) {
    out.text('\n\t\t\t\t\t\t\t<li class="edit">\n\t\t\t\t\t\t\t<a href="');
    out.value(editUrl(m, version));
    draftPromptAttrs(out, version);
    out.text('"><i class="mi-pencil"></i>');
    out.value(m.label('sitemanager.content.edit'));
    out.text('</a>\n\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\n\t\t\t\t\t\t');
  }
  // The `cfswitch`, `cfcase` and preview `cfset` lines print only whitespace.
  out.gap();
  if (PREVIEW_TYPES.some((type) => cfEq(version.type, type))) {
    const previewUrl = previewUrlOf(m, version);
    if (m.compact) {
      out.text(
        "\n\t\t\t\t\t\t\t<li class=\"preview\"><a href=\"#\" onclick=\"frontEndProxy.post({cmd:'setLocation',location:encodeURIComponent('",
      );
      out.value(encodeJs(previewUrl));
      out.text("')});return false;\"><i class=\"mi-globe\"></i>");
    } else {
      out.text('\n\t\t\t\t\t\t\t<li class="preview"><a href="');
      out.value(previewUrl);
      out.text('"><i class="mi-globe"></i>');
    }
    out.value(m.label('sitemanager.content.preview'));
    out.text('</a></li>\n\t\t\t\t\t\t');
    out.gap();
  }
  const audit = relativeAdminUrl('cArch', 'audit', [
    ['contentid', version.contentId, 'raw'],
    ['contenthistid', version.contentHistId, 'raw'],
    ['type', version.type, 'raw'],
    ['parentid', version.parentId, 'raw'],
    m.rcParam('topid'),
    ['siteid', version.siteId],
    ['moduleid', version.moduleId, 'raw'],
    m.rcParam('compactDisplay'),
  ]);
  out.text('\n\n\t\t\t\t\t <li class="audit-trail"><a href="');
  out.value(audit);
  out.text('"><i class="mi-sitemap"></i>');
  out.value(m.label('sitemanager.content.audittrail'));
  out.text('</a></li>\n\n\t\t\t\t\t\t\n\t\t\t\t\t\t');
  if (canDelete(ctx.req, data, access, version)) {
    out.text('\n\t\t\t\t\t\t\t<li class="delete">\n\t\t\t\t\t\t\t\t<a href="');
    out.value(deleteUrl(m, version));
    out.text(`" onclick="return confirmDialog('`);
    out.value(encodeJs(m.label('sitemanager.content.deleteversionconfirm')));
    out.text(`',this.href)">\n\t\t\t\t\t\t\t\t\t<i class="mi-trash"></i>`);
    out.value(m.label('sitemanager.content.delete'));
    out.text('\n\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\n\t\t\t\t\t\t');
  }
  out.text('\n\t\t\t\t\t\t\n\t\t\t\t\t</ul>\n\t\t\t\t</div>\n\t\t\t</td>\n\t\t\t');
}

/** `hist.cfm` lines 209-216: the compare radios, the first version checked. */
function compareCells(version: HistVersion, first: boolean, out: CfOutput): void {
  for (const name of ['compare1', 'compare2']) {
    out.text(
      name === 'compare1'
        ? `\n\t\t\t\t<td>\n\t\t\t\t\t<input type="radio" name="${name}" value="`
        : `/>\n\t\t\t\t</td>\n\t\t\t\t<td>\n\t\t\t\t\t<input type="radio" name="${name}" value="`,
    );
    out.value(version.contentHistId);
    out.text('"');
    if (first) out.text(' checked');
  }
  out.text('/>\n\t\t\t\t</td>\n\t\t\t\t');
}

/** `hist.cfm` lines 217-233: the title, linked unless locked, and the file version of a versioned File node. */
function titleCells(m: RowScope, version: HistVersion, fileVersions: boolean, out: CfOutput): void {
  const linked = canEdit(m.access);
  out.text('\n\t\t\t\t<td class="title var-width">\n\t\t\t\t\t');
  if (linked) {
    out.text('\n\t\t\t\t\t<a title="Edit" href="');
    out.value(editUrl(m, version));
    draftPromptAttrs(out, version);
    out.text('">\n\t\t\t\t\t');
  }
  out.gap();
  out.value(encodeHtml(version.menuTitle));
  out.gap();
  if (linked) out.text('\n\t\t\t\t\t</a>\n\t\t\t\t\t');
  out.text('\n\t\t\t\t</td>\n\t\t\t\t');
  if (!fileVersions) return;
  out.text('\n\t\t\t\t\t<td>\n\t\t\t\t\t');
  if (cfToBoolean(version.majorVersion)) {
    out.gap();
    out.value(version.majorVersion);
    out.text('.');
    out.value(version.minorVersion);
    out.gap();
  } else {
    out.text('&nbsp;\n\t\t\t\t\t');
  }
  out.text('\n\t\t\t\t\t</td>\n\t\t\t\t');
}

/** `hist.cfm` lines 234-251: the notes popover and, with change sets, the version's change set. */
function notesCells(m: RowScope, version: HistVersion, out: CfOutput): void {
  out.text('\n\t\t\t\t<td class="notes">\n\t\t\t\t\t');
  if (!cfEq(version.notes, '')) {
    out.text('\n\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right" data-content="');
    out.value(encodeHtmlAttr(version.notes));
    out.text('" data-original-title="Notes">View&nbsp;Notes</span>\n\t\t\t\t\t');
  }
  out.text('\n\t\t\t\t</td>\n\t\t\t\t');
  if (!m.data.hasChangesets) return;
  out.text('\n\t\t\t\t\t<td class="changeset">\n\t\t\t\t\t\t');
  if (version.changesetPublishDate !== null) {
    out.text('\n\t\t\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right" data-content="');
    out.value(encodeHtmlAttr(cfLsDateFormat(version.changesetPublishDate, 'short', m.locale)));
    out.text('" data-original-title=""><i class="mi-calendar"></i></span>\n\t\t\t\t\t\t\t');
  }
  out.gap();
  if (m.data.hasChangesetAccess) {
    const href = relativeAdminUrl('cChangesets', 'assignments', [
      ['siteID', version.siteId, 'raw'],
      ['changesetID', version.changesetId, 'raw'],
    ]);
    out.text('\n\t\t\t\t\t\t\t<a href="');
    out.value(href);
    out.text('">\t\t');
    out.value(encodeHtml(version.changesetName));
    out.text('\n\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t');
  } else {
    out.gap();
    out.value(encodeHtml(version.changesetName));
    out.gap();
  }
  out.text('\n\t\t\t\t\t</td>\n\t\t\t\t');
}

/** `hist.cfm` lines 141-298: one `<tr>` per version, in `getHist` order. */
function versionRow(m: RowScope, version: HistVersion, first: boolean, fileVersions: boolean, out: CfOutput): void {
  // The `cfloop`, `cfoutput` and `cfsilent` lines print only whitespace.
  out.gap();
  out.text('\n\t\t\t<tr data-contenthistid="');
  out.value(version.contentHistId);
  out.text('" data-siteid="');
  out.value(version.siteId);
  actionsCell(m, version, out);
  if (m.data.javaEnabled) compareCells(version, first, out);
  titleCells(m, version, fileVersions, out);
  notesCells(m, version, out);
  out.text('\n\t\t\t\t<td class="status">');
  out.value(versionStatus(m, version));
  out.text('</td>\n\t\t\t\t\n\t\t\t\t<td class="last-updated">');
  const { lastUpdate } = version;
  out.value(lastUpdate === null ? '' : cfLsDateFormat(lastUpdate, m.dateKeyFormat, m.locale));
  out.text('</td>\n\t\t\t\t<td class="time">');
  out.value(lastUpdate === null ? '' : cfLsTimeFormat(lastUpdate, 'short', m.locale));
  out.text('</td>\n\t\t\t\t<td class="user">');
  out.value(encodeHtml(version.lastUpdateBy));
  out.text('</td>\n\t\t\t</tr>');
  out.gap();
}

/** `hist.cfm` lines 304-316: the compact display's frame width call, printed between its `cfif` tags. */
const COMPACT_WIDTH_SCRIPT = `
\t\t\t\tif (top.location != self.location) {
\t\t\t\t\tif(jQuery("#ProxyIFrame").length){
\t\t\t\t\t\tjQuery("#ProxyIFrame").load(
\t\t\t\t\t\t\tfunction(){
\t\t\t\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t\t\t\t\t}
\t\t\t\t\t\t);
\t\t\t\t\t} else {
\t\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\t`;

/** `hist.cfm` lines 316-365: the audit-trail highlight (`carch.getaudittrail`) and the compare (`carch.loaddiff`). */
const AUDIT_SCRIPT = `

\t\t\t \tvar currentAudit='';

\t\t\t\t$('.audit-trail').on('mouseover',function(){

\t\t\t\t\tvar contenthistid=$(this).parents('tr').attr('data-contenthistid');
\t\t\t\t\tcurrentAudit=contenthistid;

\t\t\t\t\t$.ajax({
\t\t\t\t\t  url: 'index.cfm',
\t\t\t\t\t  data: {
\t\t\t\t\t  \t\tmuraAction: 'carch.getaudittrail',
\t\t\t\t\t  \t\tcontenthistid:$(this).parents('tr').attr('data-contenthistid'),
\t\t\t\t\t  \t\tsiteid:$(this).parents('tr').attr('data-siteid')
\t\t\t\t\t  \t\t}
\t\t\t\t\t  ,
\t\t\t\t\t  success: function(data){
\t\t\t\t\t  \t\t$('tr.info').removeClass('info');
\t\t\t\t\t  \t\tif(currentAudit==contenthistid){
\t\t\t\t\t  \t\t\tfor(var i=0;i < data.length;i++){
\t\t\t\t\t  \t\t\t\t$("tr[data-contenthistid='" + data[i] + "']").addClass('info');
\t\t\t\t\t  \t\t\t}
\t\t\t\t\t  \t\t}
\t\t\t\t\t  \t},
\t\t\t\t\t  error: function(data){
\t\t\t\t\t  \t\t$('tr.info').removeClass('info');
\t\t\t\t\t  \t\t//alert(data.responseText);
\t\t\t\t\t  \t}
\t\t\t\t\t  \t,
\t\t\t\t\t  dataType: "json"
\t\t\t\t\t});

\t\t\t\t})

\t\t\t\t$('.audit-trail').on('mouseout',function(){
\t\t\t\t\t$('tr.info').removeClass('info');
\t\t\t\t\tcurrentAudit='';
\t\t\t\t});

\t\t\t\t$('#viewDiff').click(function(e){
\t\t\t\t\te.preventDefault();
\t\t\t\t\tsiteManager.openContentDiff($('input[name="compare1"]:checked').val(),$('input[name="compare2"]:checked').val(),siteid);
\t\t\t\t});



\t\t\t});
\t\t\t</script>
\t\t\t`;

// The view's closing `</div>` tags sit inside its `hasLockableNodes` block, so legacy prints them only with it.
/** `hist.cfm` lines 366-374: the text after the draft prompt include. */
const LOCKABLE_BLOCK_CLOSE = `



\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->


`;

/** `hist.cfm` lines 112-140: the table head; the file version and change set columns only where the rows print them. */
function tableHead(m: RowScope, fileVersions: boolean, out: CfOutput): void {
  out.text(
    '\n\n<div class="block block-constrain">\n\t<div class="block block-bordered">\n\t  <div class="block-content">\n\n\t\t\t<table class="mura-table-grid">\n\t\t\t<thead>\n\t\t\t<tr>\n\t\t\t\t<th nowrap class="actions"></th>\n\t\t\t\t',
  );
  if (m.data.javaEnabled) {
    out.text('\n\t\t\t\t<th colspan="2"><a class="btn " id="viewDiff"><i class="mi-code-fork"></i> ');
    out.value(m.label('sitemanager.content.compare'));
    out.text('</a></th>\n\t\t\t\t');
  }
  out.text('\n\t\t\t\t<th class="var-width">');
  out.value(m.label('sitemanager.content.title'));
  out.text('</th>\n\t\t\t\t');
  if (fileVersions) {
    out.text('<th>');
    out.value(m.label('sitemanager.content.version.file'));
    out.text('</th>');
  }
  out.text('\n\t\t\t\t<th class="notes">');
  out.value(m.label('sitemanager.content.notes'));
  out.text('</th>\n\t\t\t\t');
  if (m.data.hasChangesets) {
    out.text('<th>');
    out.value(m.label('sitemanager.content.changeset'));
    out.text('</th>');
  }
  out.text('\n\t\t\t\t<th>');
  out.value(m.label('sitemanager.content.status'));
  out.text('</th>\n\t\t\t\t\n\t\t\t\t<th>');
  out.value(m.label('sitemanager.content.update'));
  out.text('</th>\n\t\t\t\t<th>');
  out.value(m.label('sitemanager.content.time'));
  out.text('</th>\n\t\t\t\t<th>');
  out.value(m.label('sitemanager.content.authoreditor'));
  out.text('</th>\n\t\t\t\t');
  out.text('\n\t\t\t</tr>\n\t\t\t</thead>\n\t\t\t<tbody>\n\t\t\t');
}

/** The status include's model; hist defines no `showApprovalStatus`, so only the node lock notice reads it. */
function statusModelOf(data: HistData): StatusModel {
  const { content } = data;
  return {
    hasLockableNodes: data.hasLockableNodes,
    stats: content.stats,
    ...(data.lockedBy === undefined ? {} : { lockedBy: data.lockedBy }),
    content: {
      contentId: content.contentId,
      siteId: content.siteId,
      contentHistId: content.contentHistId,
      approvalStatus: content.approvalStatus,
      display: content.display,
      // Read only by the approval block, which this view omits.
      displayIntervalDesc: '',
      conflicts: [],
    },
    parentType: '',
  };
}

/** `carch/hist.cfm`: the header with menu and breadcrumb, the status notices, the version table and its scripts. */
async function renderHist(ctx: ScreenContext, data: HistData): Promise<ShellView> {
  const { req, rb } = ctx;
  const { rc } = req;
  const compact = isCompact(rc);
  const m: RowScope = {
    ctx,
    data,
    access: accessOf(req, data),
    compact,
    locale: req.session.locale,
    dateKeyFormat: req.session.dateKeyFormat,
    label: (key) => rb.rbKey(key),
    rcParam: (name) => [name, rcText(rc, name)],
  };
  const { content } = data;
  // `rc.contentBean.getType() eq "file" and stats.getMajorVersion()`, which reads the stats only for a File node.
  const fileVersions = cfEq(content.type, 'file') && cfToBoolean(structText(content.stats, 'majorVersion'));
  const out = new CfOutput();
  out.text('\n<div class="mura-header">\n\t<h1>');
  out.value(m.label('sitemanager.content.versionhistory'));
  out.text('</h1>\n\n\t');
  if (!compact) {
    const menu: CarchSecondaryMenuInput = {
      content,
      perm: data.perm,
      deletable: data.deletable,
      hasLockableNodes: data.hasLockableNodes,
      ...(data.purgeDrafts === undefined ? {} : { purgeDrafts: data.purgeDrafts }),
    };
    bindCarchSecondaryMenu(ctx, menu);
    out.gap();
    out.value(renderCarchSecondaryMenu(ctx, menu));
    out.gap();
  }
  out.gap();
  if (!compact) {
    out.gap();
    out.value(dspZoom(ctx, { crumbdata: data.crumbs, class: 'breadcrumb' }));
    out.gap();
  }
  out.text('\n</div> <!-- /.mura-header -->\n\n');
  out.value(await status(ctx, statusModelOf(data)));
  tableHead(m, fileVersions, out);
  data.versions.forEach((version, index) => versionRow(m, version, index === 0, fileVersions, out));
  out.text(
    '\n\t\t\t</tbody></table>\n\t\t\t<script type="text/javascript">\n\n\n\t\t\tjQuery(document).ready(function(){\n\t\t\t\t',
  );
  if (compact) out.text(COMPACT_WIDTH_SCRIPT);
  out.text(AUDIT_SCRIPT);
  if (data.hasLockableNodes) {
    out.gap();
    out.value(draftPromptJs(ctx));
    out.text(LOCKABLE_BLOCK_CLOSE);
  }
  out.gap();
  return { body: raw(out.markup), ajax: carchJs(ctx, 'hist') };
}

/** The `cArch.hist` admin page. */
export const histScreen: PageScreen<HistData> = Object.freeze({
  circuit: 'carch',
  action: 'hist',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  secondaryMenu: 'carch',
  redirect: histRedirect,
  load: loadHist,
  render: renderHist,
});
