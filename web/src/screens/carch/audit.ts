// The `cArch.audit` page of `carch/audit.cfm`: the audit trail of one content version's source chain (server-only).
import {
  cfEq,
  cfIsNumeric,
  cfLsDateFormat,
  cfLsTimeFormat,
  cfToBoolean,
  cfToNumber,
  javaTrim,
  type AdminParam,
} from '@opt2/platform/legacy-compat';
import { parseLegacyDate } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest, RequestContext } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { relativeAdminUrl } from '@/lib/urls';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import {
  carchViewState,
  permOf,
  structOf,
  structText,
  structValue,
  type CarchCrumb,
  type CarchStruct,
  type CarchViewState,
} from './model';
import { draftPromptJs } from './partials/draft-prompt-js';
import { carchJs } from './partials/js';
import { status, type StatusLockUser, type StatusModel } from './partials/status';
import { dspZoom } from './partials/zoom';
import { carchSecondaryMenuCsrfContexts, renderCarchSecondaryMenu, type CarchMenuContent } from './secondary-menu';
import { carchPageData, type CarchOutcome, type CarchPageModel } from './service';

const SERVICE = 'strategies-content';

/** Change Sets module, whose permission links each version's change set. */
const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';

/** Version types whose actions menu links the front-end preview (the view's `cfcase` list). */
const PREVIEW_TYPES: ReadonlySet<string> = new Set([
  'page',
  'folder',
  'calendar',
  'gallery',
  'link',
  'file',
  'variation',
]);

/** The request parameters, after the content id, that the version links carry in legacy order. */
const NODE_PARAMS = Object.freeze(['type', 'parentid', 'topid', 'siteid', 'startrow', 'moduleid']);

/** `rc.contentBean` as the view and its includes read it. */
export interface AuditContent extends CarchMenuContent {
  readonly contentId: string;
  readonly siteId: string;
  readonly approvalStatus: string;
  readonly display: number;
  /** The bean's `isLocked` value, which `rc.deletable` tests. */
  readonly isLocked: string;
}

/** One version of the source chain, as each loop pass reads `rc.item`. */
export interface AuditVersion {
  readonly contentHistId: string;
  readonly contentId: string;
  readonly siteId: string;
  readonly type: string;
  readonly menuTitle: string;
  readonly active: boolean;
  readonly approved: boolean;
  readonly approvalStatus: string;
  readonly changesetId: string;
  /** `getName()` of the change set `changesetId` loads; `''` for none. */
  readonly changesetName: string;
  /** `getPublishDate()` of that change set; `''` when it has none. */
  readonly changesetPublishDate: string;
  readonly notes: string;
  readonly majorVersion: string;
  readonly minorVersion: string;
  readonly lastUpdate: string;
  readonly lastUpdateBy: string;
  /** `rc.contentBean.getURL(complete=1, queryString='previewid=<contentHistId>')`; undefined when omitted. */
  readonly previewUrl: string | undefined;
}

/** What `cArch.audit` renders, parsed once from the strategies-content screen model. */
export interface AuditData {
  readonly content: AuditContent;
  /** `rc.item` from `rc.contenthistid` through each `getSource()`, until a version is new. */
  readonly versions: readonly AuditVersion[];
  /** `contentManager.getCrumbList(rc.contentid, rc.siteid)`, node first. */
  readonly crumbs: readonly CarchCrumb[];
  /** Lock, delete and membership state for the session user, with `rc.perm`. */
  readonly view: CarchViewState;
  /** `$.siteConfig('hasLockableNodes')`. */
  readonly hasLockableNodes: boolean;
  /** settingsBean `getHasChangesets()` of `rc.siteid`. */
  readonly hasChangesets: boolean;
  /** configBean `getPurgeDrafts()`. */
  readonly purgeDrafts: boolean;
  /** The user `stats.getLockID()` loads; undefined is the empty bean of an unknown id. */
  readonly lockedBy: StatusLockUser | undefined;
}

// ---- Model ----

/** `rc[name]` by case-insensitive name; throws as CFML does for an undefined element. */
function rcText(rc: RequestContext, name: string): string {
  const lower = name.toLowerCase();
  const key = Object.hasOwn(rc, name) ? name : Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  const value = key === undefined ? undefined : rc[key];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** A model value as CFML text; throws when the struct lacks it. */
function requiredText(struct: CarchStruct, key: string): string {
  if (structValue(struct, key) === undefined) throw new TypeError(`${SERVICE} carch.audit model has no ${key}`);
  return structText(struct, key);
}

/** A struct value as a CFML boolean; throws when it is missing or not boolean. */
const booleanOf = (struct: CarchStruct, key: string): boolean => cfToBoolean(structValue(struct, key));

/** A struct value as a CFML number; throws when it is missing or not numeric. */
const numberOf = (struct: CarchStruct, key: string): number => cfToNumber(structValue(struct, key));

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `struct[key]` as an array of structs (a query's rows); throws when it is not one. */
function structsOf(struct: CarchStruct, key: string): readonly CarchStruct[] {
  const value = structValue(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) {
    throw new TypeError(`${SERVICE} carch.audit model ${key} is not an array of structs`);
  }
  return value;
}

/** `rc.contentBean`'s values, with its `getStats()` struct under `stats`. */
function contentOf(bean: CarchStruct): AuditContent {
  return {
    isNew: booleanOf(bean, 'isNew'),
    contentId: structText(bean, 'contentID'),
    siteId: structText(bean, 'siteID'),
    contentHistId: structText(bean, 'contentHistID'),
    parentId: structText(bean, 'parentID'),
    type: structText(bean, 'type'),
    subType: structText(bean, 'subType'),
    active: numberOf(bean, 'active'),
    filename: structText(bean, 'filename'),
    menuTitle: structText(bean, 'menuTitle'),
    remoteUrl: structText(bean, 'remoteURL'),
    fileId: structText(bean, 'fileID'),
    approvalStatus: structText(bean, 'approvalStatus'),
    display: numberOf(bean, 'display'),
    isLocked: structText(bean, 'isLocked'),
    stats: structOf(bean, 'stats'),
  };
}

/** One `rc.items` row as the loop reads `rc.item`. */
function versionOf(item: CarchStruct): AuditVersion {
  return {
    contentHistId: structText(item, 'contentHistID'),
    contentId: structText(item, 'contentID'),
    siteId: structText(item, 'siteID'),
    type: structText(item, 'type'),
    menuTitle: structText(item, 'menuTitle'),
    active: booleanOf(item, 'active'),
    approved: booleanOf(item, 'approved'),
    approvalStatus: structText(item, 'approvalStatus'),
    changesetId: structText(item, 'changesetID'),
    changesetName: structText(item, 'changesetName'),
    changesetPublishDate: structText(item, 'changesetPublishDate'),
    notes: structText(item, 'notes'),
    majorVersion: structText(item, 'majorVersion'),
    minorVersion: structText(item, 'minorVersion'),
    lastUpdate: structText(item, 'lastUpdate'),
    lastUpdateBy: structText(item, 'lastUpdateBy'),
    previewUrl: structValue(item, 'previewURL') === undefined ? undefined : structText(item, 'previewURL'),
  };
}

/** `rc.lockedBy`, the lock holder's user values, when the model carries one. */
function lockedByOf(rc: CarchStruct): StatusLockUser | undefined {
  if (structValue(rc, 'lockedBy') === undefined) return undefined;
  const user = structOf(rc, 'lockedBy');
  return { fname: structText(user, 'fname'), lname: structText(user, 'lname'), email: structText(user, 'email') };
}

/**
 * The view data of the audit model, whose `rc` carries `contentBean` (with `stats`), `crumbdata`, `perm`, `items`,
 * `hasLockableNodes`, `hasChangesets`, `purgeDrafts`, `siteLocking` and, for a node someone else locked, `lockedBy`.
 * @throws TypeError When a value the view reads is missing or of the wrong CFML type.
 */
export function auditData(req: AdminRequest, model: CarchPageModel): AuditData {
  const { rc } = model;
  const content = contentOf(structOf(rc, 'contentBean'));
  const hasLockableNodes = booleanOf(rc, 'hasLockableNodes');
  const view = carchViewState(req, {
    stats: content.stats,
    hasLockableNodes,
    parentId: rcText(req.rc, 'parentid'),
    contentId: rcText(req.rc, 'contentid'),
    siteLocking: requiredText(rc, 'siteLocking'),
    perm: permOf(model),
    isLocked: content.isLocked,
  });
  return {
    content,
    versions: structsOf(rc, 'items').map(versionOf),
    crumbs: structsOf(rc, 'crumbdata'),
    view,
    hasLockableNodes,
    hasChangesets: booleanOf(rc, 'hasChangesets'),
    purgeDrafts: booleanOf(rc, 'purgeDrafts'),
    lockedBy: lockedByOf(rc),
  };
}

// ---- View rules ----

/** ACF `rc.compactDisplay eq 'true'`: `true` in any case, or `yes` or a numeric 1 after Java trimming. */
function isCompact(value: string): boolean {
  const trimmed = javaTrim(value);
  return (
    value.toLowerCase() === 'true' ||
    trimmed.toLowerCase() === 'yes' ||
    (cfIsNumeric(trimmed) && !trimmed.endsWith('.') && Number(trimmed) === 1)
  );
}

/** `not isLockedBySomeoneElse or poweruser`: the version's edit links are shown. */
const canEdit = (data: AuditData): boolean => !data.view.isLockedBySomeoneElse || data.view.siteAdminOrS2;

/** `audit.cfm` line 192: the Delete item, its membership tests read from the verified request flags. */
function canDelete(data: AuditData, version: AuditVersion): boolean {
  const { perm, siteAdminOrS2, isLockedBySomeoneElse } = data.view;
  return !version.active && ((!cfEq(perm, 'none') && data.purgeDrafts) || siteAdminOrS2) && !isLockedBySomeoneElse;
}

/** `rc.contentBean.getType() eq "file" and stats.getMajorVersion()`: the File Version column is shown. */
const showsFileVersion = (content: AuditContent): boolean =>
  cfEq(content.type, 'file') && cfToBoolean(structValue(content.stats, 'majorVersion'));

/** The version's status label, as the loop's `cfsilent` block chooses it. */
function versionStatus(rb: RbLookup, version: AuditVersion): string {
  const label = (key: string): string => rb.rbKey(`sitemanager.content.${key}`);
  const approval = version.approvalStatus.toLowerCase();
  if (version.active && version.approved) return label('published');
  if (approval === 'pending' || approval === 'rejected') return label(version.approvalStatus);
  if (!version.approved && version.changesetId.length > 0) return label('queued');
  if (!version.approved) return label(cfEq(version.approvalStatus, 'Cancelled') ? 'canceled' : 'draft');
  return label('archived');
}

/** A legacy date value as a date; null for `''`, and ACF's error for text it cannot read. */
function dateOf(value: string): Date | null {
  if (value === '') return null;
  const date = parseLegacyDate(value);
  if (date === null) throw new RangeError(`The value ${value} cannot be converted to a date.`);
  return date;
}

/** `LSDateFormat(value, mask)` under the session locale; `''` for an empty value. */
function lsDate(req: AdminRequest, value: string, mask: string): string {
  const date = dateOf(value);
  return date === null ? '' : cfLsDateFormat(date, mask, req.session.locale);
}

/** `LSTimeFormat(value, "short")` under the session locale; `''` for an empty value. */
function lsShortTime(req: AdminRequest, value: string): string {
  const date = dateOf(value);
  return date === null ? '' : cfLsTimeFormat(date, 'short', req.session.locale);
}

/** `type` to `moduleid` from `rc`, each `esapiEncode('url')`-encoded by the builder. */
const nodeParams = (rc: RequestContext): AdminParam[] => NODE_PARAMS.map((name) => [name, rcText(rc, name)]);

/** The version's `cArch.edit` link, ids unencoded as legacy writes them. */
function editUrl(rc: RequestContext, version: AuditVersion): string {
  return relativeAdminUrl('cArch', 'edit', [
    ['contenthistid', version.contentHistId, 'raw'],
    ['contentid', version.contentId, 'raw'],
    ...nodeParams(rc),
    ['return', 'hist', 'raw'],
    ['compactDisplay', rcText(rc, 'compactDisplay')],
  ]);
}

/** The version's Delete link with its `<contenthistid>delete` CSRF tokens, which the load step fetched. */
function deleteUrl(ctx: ScreenContext, version: AuditVersion): string {
  const { rc } = ctx.req;
  const url = relativeAdminUrl('cArch', 'update', [
    ['contenthistid', version.contentHistId, 'raw'],
    ['action', 'delete', 'raw'],
    ['contentid', rcText(rc, 'contentid')],
    ...nodeParams(rc),
    ['compactDisplay', rcText(rc, 'compactDisplay')],
  ]);
  return url + ctx.csrf.render(`${version.contentHistId}delete`, 'url').value;
}

/** `previewURL`: the bean's remote URL for a Variation, else the content URL the model built for the version. */
function previewUrl(content: AuditContent, version: AuditVersion): string {
  if (cfEq(version.type, 'Variation')) return `${content.remoteUrl}?previewid=${version.contentHistId}`;
  if (version.previewUrl === undefined) {
    throw new TypeError(`${SERVICE} carch.audit model has no previewURL for version ${version.contentHistId}`);
  }
  return version.previewUrl;
}

/** The `dsp_status.cfm` input of this view, which defines no `showApprovalStatus`. */
function statusModel(data: AuditData): StatusModel {
  const { content } = data;
  return {
    hasLockableNodes: data.hasLockableNodes,
    stats: content.stats,
    lockedBy: data.lockedBy,
    content: {
      contentId: content.contentId,
      siteId: content.siteId,
      contentHistId: content.contentHistId,
      approvalStatus: content.approvalStatus,
      display: content.display,
      // The display interval, conflicts and parent type are read only by the approval block, which this view omits.
      displayIntervalDesc: '',
      conflicts: [],
    },
    parentType: '',
  };
}

/** The CSRF contexts the page renders url tokens for: the secondary menu's and each shown Delete link's. */
function csrfContexts(req: AdminRequest, data: AuditData): string[] {
  const deletes = data.versions.filter((version) => canDelete(data, version)).map((v) => `${v.contentHistId}delete`);
  if (isCompact(rcText(req.rc, 'compactDisplay'))) return deletes;
  return [...carchSecondaryMenuCsrfContexts(req.rc), ...deletes];
}

// ---- Markup ----

const NO_BREAK_SPACES = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one character. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

/**
 * View output as ACF whitespace management writes it: template text holding any non-whitespace prints verbatim, and
 * whitespace-only text prints one space after non-whitespace output and nothing after whitespace or at the start.
 */
class ViewOutput {
  #out = '';

  /** One run of template text between two tags or expressions; CFML comments are already stripped from it. */
  text(run: string): void {
    if (![...run].every(isJavaWhitespace)) this.#out += run;
    else if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
  }

  /** An expression's or an include's output, verbatim. */
  value(output: string | SafeHtml): void {
    this.#out += String(output);
  }

  get markup(): string {
    return this.#out;
  }
}

// Whitespace-only runs are written only where they can follow non-whitespace output; elsewhere they print nothing.

/** Lines 100-112: the header with the secondary menu and breadcrumb, then the lock notice of `dsp_status.cfm`. */
async function header(ctx: ScreenContext, data: AuditData, compact: boolean, out: ViewOutput): Promise<void> {
  out.text('\n\n\n<div class="mura-header">\n\t<h1>');
  out.value(ctx.rb.rbKey('sitemanager.content.audittrail'));
  out.text('</h1>\n\n\t');
  if (!compact) {
    out.value(
      renderCarchSecondaryMenu(ctx, {
        content: data.content,
        perm: data.view.perm,
        deletable: data.view.deletable,
        hasLockableNodes: data.hasLockableNodes,
        purgeDrafts: data.purgeDrafts,
      }),
    );
    out.value(dspZoom(ctx, { crumbdata: data.crumbs, class: 'breadcrumb' }));
    out.text('\n\t');
  }
  out.text('\n</div> <!-- /.mura-header -->\n\n');
  out.value(await status(ctx, statusModel(data)));
}

/** Lines 114-142: the table up to `<tbody>`, with the compare, file version and change set columns as configured. */
function tableHead(rb: RbLookup, data: AuditData, layout: RowLayout, out: ViewOutput): void {
  const label = (key: string): string => rb.rbKey(`sitemanager.content.${key}`);
  out.text(
    '\n\n<div class="block block-constrain">\n\t<div class="block block-bordered">\n' +
      '\t  <div class="block-content">\n\n\t\t\t<table class="mura-table-grid">\n\t\t\t<thead>\n\t\t\t<tr>\n' +
      '\t\t\t\t<th nowrap class="actions"></th>\n\t\t\t\t',
  );
  if (layout.javaEnabled) {
    out.text('\n\t\t\t\t<th colspan="2"><a class="btn" id="viewDiff">');
    out.value(label('compare'));
    out.text('</a></th>\n\t\t\t\t');
  }
  out.text('\n\t\t\t\t<th class="var-width">');
  out.value(label('title'));
  out.text('</th>\n\t\t\t\t');
  if (layout.fileVersion) {
    out.text('<th>');
    out.value(label('version.file'));
    out.text('</th>');
  }
  out.text('\n\t\t\t\t<th class="notes">');
  out.value(label('notes'));
  out.text('</th>\n\t\t\t\t');
  if (data.hasChangesets) {
    out.text('<th>');
    out.value(label('changeset'));
    out.text('</th>');
  }
  out.text('\n\t\t\t\t<th>');
  out.value(label('status'));
  out.text('</th>\n\t\t\t\t\n\t\t\t\t<th>');
  out.value(label('update'));
  out.text('</th>\n\t\t\t\t<th>');
  out.value(label('time'));
  out.text('</th>\n\t\t\t\t<th>');
  out.value(label('authoreditor'));
  out.text('</th>\n\t\t\t\t');
  out.text('\n\t\t\t</tr>\n\t\t\t</thead>\n\t\t\t<tbody>\n\t\t\t');
}

/** Lines 165-200: the actions menu cell with the Edit, Preview and Delete items the version allows. */
function actionsCell(
  ctx: ScreenContext,
  data: AuditData,
  version: AuditVersion,
  compact: boolean,
  out: ViewOutput,
): void {
  const label = (key: string): string => ctx.rb.rbKey(`sitemanager.content.${key}`);
  out.text(
    '\n\t\t\t\t<td class="actions">\n' +
      '\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);">' +
      '<i class="mi-ellipsis-v"></i></a>\n' +
      '\t\t\t\t\t<div class="actions-menu hide">\n\t\t\t\t\t\t<ul class="actions-list">\n\t\t\t\t\t\t\t',
  );
  if (canEdit(data)) {
    out.text('\n\t\t\t\t\t\t\t\t<li class="edit"><a href="');
    out.value(editUrl(ctx.req.rc, version));
    out.text('" class="draftprompt" data-targetversion="true" data-siteid="');
    out.value(version.siteId);
    out.text('" data-contentid="');
    out.value(version.contentId);
    out.text('" data-contenthistid="');
    out.value(version.contentHistId);
    out.text('" ><i class="mi-pencil"></i>');
    out.value(label('edit'));
    out.text('</a>\n\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\n\t \t\t\t\t\t\t');
  }
  if (PREVIEW_TYPES.has(version.type.toLowerCase())) {
    const url = previewUrl(data.content, version);
    if (compact) {
      out.text(
        '\n\t\t\t\t\t\t\t\t\t\t<li class="preview"><a href="#" onclick="frontEndProxy.post(' +
          "{cmd:'setLocation',location:encodeURIComponent('",
      );
      out.value(encodeJs(url));
      out.text('\')});return false;"><i class="mi-globe"></i>');
    } else {
      out.text('\n\t\t\t\t\t\t\t\t\t\t<li class="preview"><a href="');
      out.value(url);
      out.text('"><i class="mi-globe"></i>');
    }
    out.value(label('preview'));
    out.text('</a></li>\n\t\t\t\t\t\t\t\t\t');
  }
  if (canDelete(data, version)) {
    out.text('<li class="delete"><a href="');
    out.value(deleteUrl(ctx, version));
    out.text('" onclick="return confirmDialog(\'');
    out.value(encodeJs(label('deleteversionconfirm')));
    out.text('\',this.href)"><i class="mi-trash"></i>');
    out.value(label('delete'));
    out.text('</a>\n\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t');
  }
  out.text('\n\t\t\t\t\t\t</ul>\n\t\t\t\t\t</div>\n\t\t\t\t</td>\n\t\t\t\t');
}

/** Lines 201-208: the two diff radios, checked on the first version only. */
function compareCells(version: AuditVersion, first: boolean, out: ViewOutput): void {
  const radio = (name: string): void => {
    out.text(`<input type="radio" name="${name}" value="`);
    out.value(version.contentHistId);
    out.text('"');
    if (first) out.text(' checked');
  };
  out.text('\n\t\t\t\t\t<td>\n\t\t\t\t\t\t');
  radio('compare1');
  out.text('/>\n\t\t\t\t\t</td>\n\t\t\t\t\t<td>\n\t\t\t\t\t\t');
  radio('compare2');
  out.text('/>\n\t\t\t\t\t</td>\n\t\t\t\t');
}

/** Lines 209-217: the menu title, linked to the version's edit screen when the version's edit links are shown. */
function titleCell(ctx: ScreenContext, data: AuditData, version: AuditVersion, out: ViewOutput): void {
  const editable = canEdit(data);
  out.text('\n\t\t\t\t<td class="title var-width">\n\t\t\t\t\t');
  if (editable) {
    out.text('\n\t\t\t\t\t<a title="Edit" href="');
    out.value(editUrl(ctx.req.rc, version));
    out.text('" class="draftprompt"  data-targetversion="true" data-siteid="');
    out.value(version.siteId);
    out.text('" data-contentid="');
    out.value(version.contentId);
    out.text('" data-contenthistid="');
    out.value(version.contentHistId);
    out.text('">\n\t\t\t\t\t');
  }
  // `left(menutitle, 90)` counts UTF-16 units, as JavaScript slices.
  out.value(encodeHtml(version.menuTitle.slice(0, 90)));
  out.text('\n\t\t\t\t\t');
  if (editable) out.text('\n\t\t\t\t\t</a>\n\t\t\t\t\t');
  out.text('\n\t\t\t\t</td>\n\t\t\t\t');
}

/** Lines 218-225: the version's `major.minor` file version, or a non-breaking space for none. */
function fileVersionCell(version: AuditVersion, out: ViewOutput): void {
  out.text('\n\t\t\t\t\t<td>\n\t\t\t\t\t');
  if (cfToBoolean(version.majorVersion)) {
    out.value(version.majorVersion);
    out.text('.');
    out.value(version.minorVersion);
    out.text('\n\t\t\t\t\t\t');
  } else {
    out.text('&nbsp;\n\t\t\t\t\t');
  }
  out.text('\n\t\t\t\t\t</td>\n\t\t\t\t');
}

/** Lines 226-228: the notes popover of a version with notes. */
function notesCell(version: AuditVersion, out: ViewOutput): void {
  out.text('\n\t\t\t\t<td class="notes">');
  if (version.notes !== '') {
    out.text('\n\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right" data-content="');
    out.value(encodeHtmlAttr(version.notes));
    out.text('" data-original-title="Notes">View&nbsp;Notes</span>\n\t\t\t\t');
  }
  out.text('</td>\n\t\t\t\t');
}

/** Lines 229-245: the version's change set, its publish date popover and, with Change Sets access, its link. */
function changesetCell(ctx: ScreenContext, version: AuditVersion, out: ViewOutput): void {
  out.text('\n\t\t\t\t\t<td class="changeset">\n\t\t\t\t\t\t');
  if (version.changesetId.length > 0) {
    if (parseLegacyDate(version.changesetPublishDate) !== null) {
      out.text('\n\t\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right" data-content="');
      out.value(encodeHtmlAttr(lsDate(ctx.req, version.changesetPublishDate, 'short')));
      out.text('" data-original-title=""><i class="mi-calendar"></i></span>\n\t\t\t\t\t\t');
    }
    const name = encodeHtml(version.changesetName);
    if (ctx.req.modulePerm(CHANGESETS_MODULE_ID)) {
      out.text('\n\t\t\t\t\t\t\t<a href="');
      out.value(
        relativeAdminUrl('cChangesets', 'assignments', [
          ['siteID', version.siteId, 'raw'],
          ['changesetID', version.changesetId, 'raw'],
        ]),
      );
      out.text('">\t\t');
      out.value(name);
      out.text('\n\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t');
    } else {
      out.value(name);
      out.text('\n\t\t\t\t\t\t');
    }
  }
  out.text('\n\t\t\t\t\t</td>\n\t\t\t\t');
}

/** Lines 246-290: the status label, the last update's date (session mask) and short time, and the editor. */
function updateCells(ctx: ScreenContext, version: AuditVersion, out: ViewOutput): void {
  const { req } = ctx;
  out.text('\n\t\t\t\t<td class="status">');
  out.value(versionStatus(ctx.rb, version));
  // The session mask is the locale's dateKeyFormat (e.g. `MM/DD/YYYY`), so legacy's day-of-year dates are kept.
  out.text('</td>\n\t\t\t\t\n\t\t\t\t<td class="last-updated">');
  out.value(lsDate(req, version.lastUpdate, req.session.dateKeyFormat));
  out.text('</td>\n\t\t\t\t<td class="time">');
  out.value(lsShortTime(req, version.lastUpdate));
  out.text('</td>\n\t\t\t\t<td class="user">');
  out.value(encodeHtml(version.lastUpdateBy));
  out.text('</td>\n\t\t\t</tr>');
  out.text('\n\t\t\t');
}

/** Values the view computes once and every row reads. */
interface RowLayout {
  readonly compact: boolean;
  readonly javaEnabled: boolean;
  readonly fileVersion: boolean;
}

/** Lines 164-290: one pass of the source-chain loop. */
function versionRow(
  ctx: ScreenContext,
  data: AuditData,
  version: AuditVersion,
  first: boolean,
  layout: RowLayout,
  out: ViewOutput,
): void {
  out.text('\n\t\t\t<tr>');
  actionsCell(ctx, data, version, layout.compact, out);
  if (layout.javaEnabled) compareCells(version, first, out);
  titleCell(ctx, data, version, out);
  if (layout.fileVersion) fileVersionCell(version, out);
  notesCell(version, out);
  if (data.hasChangesets) changesetCell(ctx, version, out);
  updateCells(ctx, version, out);
}

/** Lines 294-300: the table's close and the opening of the diff script. */
const TABLE_CLOSE =
  '\n\t\t\t</tbody></table>\n\n\t\t</div> <!-- /.block-content -->\n\t</div> <!-- /.block-bordered -->\n' +
  '</div> <!-- /.block-constrain -->\n\n<script type="text/javascript">\njQuery(document).ready(function(){\n\t';

/** Lines 303-314: the compact display's width request to the front-end proxy. */
const COMPACT_WIDTH_SCRIPT = `
\tif (top.location != self.location) {
\t\tif(jQuery("#ProxyIFrame").length){
\t\t\tjQuery("#ProxyIFrame").load(
\t\t\t\tfunction(){
\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t\t}
\t\t\t);
\t\t} else {
\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t}
\t}
\t`;

/** Lines 315-321: the Compare button's handler and the script's close. */
const DIFF_SCRIPT = `

\t$('#viewDiff').click(function(e){
\t\te.preventDefault();
\t\tsiteManager.openContentDiff($('input[name="compare1"]:checked').val(),$('input[name="compare2"]:checked').val(),siteid);
\t});
});
</script>
`;

/** The FW/1 view body of `audit.cfm`. */
async function auditBody(ctx: ScreenContext, data: AuditData): Promise<SafeHtml> {
  const compact = isCompact(rcText(ctx.req.rc, 'compactDisplay'));
  const out = new ViewOutput();
  await header(ctx, data, compact, out);
  const layout: RowLayout = {
    compact,
    javaEnabled: legacySettings().javaEnabled,
    fileVersion: showsFileVersion(data.content),
  };
  tableHead(ctx.rb, data, layout, out);
  data.versions.forEach((version, index) => versionRow(ctx, data, version, index === 0, layout, out));
  out.text(TABLE_CLOSE);
  if (compact) out.text(COMPACT_WIDTH_SCRIPT);
  out.text(DIFF_SCRIPT);
  if (data.hasLockableNodes) out.value(draftPromptJs(ctx));
  return raw(out.markup);
}

// ---- Screen ----

/** The audit screen model of each request, fetched once by whichever page step needs it first. */
const MODELS = new WeakMap<ScreenContext, Promise<CarchOutcome<CarchPageModel>>>();

/** carch `before()` then `audit()`: the request with the carch defaults, and the version's audit model. */
function auditModel(ctx: ScreenContext): Promise<CarchOutcome<CarchPageModel>> {
  const memo = MODELS.get(ctx);
  if (memo !== undefined) return memo;
  ctx.req = applyCarchDefaults(ctx.req);
  const model = carchPageData(ctx, 'audit');
  MODELS.set(ctx, model);
  return model;
}

/** The controller step: a strategies-content 401 or 403 answers with the controller's `secure()` redirect. */
async function deniedRedirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const outcome = await auditModel(ctx);
  return outcome.kind === 'redirect' ? { kind: 'location', location: outcome.location } : undefined;
}

/**
 * The view data, with every CSRF pair the render prints fetched.
 * @throws Error When strategies-content rejects the read, or answered a denial the redirect step did not handle.
 */
async function loadAudit(ctx: ScreenContext): Promise<AuditData> {
  const outcome = await auditModel(ctx);
  if (outcome.kind !== 'ok') {
    const answer = outcome.kind === 'rejected' ? `HTTP ${outcome.status}` : `a redirect to ${outcome.location}`;
    throw new Error(`${SERVICE} answered the carch.audit read with ${answer}`);
  }
  const data = auditData(ctx.req, outcome.data);
  await ctx.csrf.prefetch(csrfContexts(ctx.req, data));
  return data;
}

/** The view inside the shell, with the Site Manager script of `carch/js.cfm` as `request.ajax`. */
async function renderAudit(ctx: ScreenContext, data: AuditData): Promise<ShellView> {
  return { body: await auditBody(ctx, data), ajax: carchJs(ctx, 'audit') };
}

/** The `cArch.audit` admin page. */
export const auditScreen: PageScreen<AuditData> = Object.freeze({
  circuit: 'carch',
  action: 'audit',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  secondaryMenu: 'carch',
  redirect: deniedRedirect,
  load: loadAudit,
  render: renderAudit,
});
