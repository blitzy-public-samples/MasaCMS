// The `cchain.pending` page: an approval chain's pending requests per member group, after `cchain/pending.cfm`.
import {
  adminUrl,
  cfEq,
  cfListToArray,
  cfLsDateFormat,
  cfLsTimeFormat,
  cfToBoolean,
} from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/strategies-content';
import { parseLegacyDate } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtmlAttr, encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { SiteData } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { PageScreen, ScreenContext } from '../registry';
import { renderCchainSecondaryMenu } from './dsp_secondary_menu';

const SERVICE = 'strategies-content';
const OPERATION = 'listPendingApprovals';
const PENDING_PATH = '/v1/sites/{siteid}/approval-chains/{chainid}/pending';

/** Site Manager module, dspZoom's default for a crumb without `moduleid`. */
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';

/** Content types whose pending version the view offers a preview of (its `cfcase` list). */
const PREVIEW_TYPES = Object.freeze(['page', 'folder', 'calendar', 'gallery', 'link', 'file']);

/** The strategies-content screen model of `cchain.pending`. */
type PendingViewModel = components['schemas']['AdminViewModel'];

/** A struct of the screen model: a bean's values or a query row, keys matched case-insensitively as in CFML. */
type Struct = Readonly<PendingViewModel['rc']>;

/** The shell view a page screen renders. */
type ShellView = Awaited<ReturnType<PageScreen['render']>>;

/** One `getCrumbArray()` entry as dspZoom reads it; the node first, the site root last. */
export interface CchainPendingCrumb {
  readonly menutitle: string;
  readonly siteid: string;
  readonly contentid: string;
  /** Absent reads as the Site Manager module. */
  readonly moduleid?: string;
  readonly type: string;
  /** `restricted eq 1`. */
  readonly restricted: boolean;
  /** The class strategies-content's `renderIcon` gave the crumb. */
  readonly icon: string;
}

/** One `getPendingContentIterator()` row: the pending version, its change set and the request time. */
export interface CchainPendingRequest {
  readonly contentHistId: string;
  readonly contentId: string;
  readonly type: string;
  readonly parentId: string;
  readonly siteId: string;
  readonly moduleId: string;
  readonly changesetId: string;
  readonly changesetName: string;
  /** `''` when the change set is unscheduled or absent. */
  readonly changesetPublishDate: string;
  readonly lastUpdateBy: string;
  /** The request's `created`, as received. */
  readonly created: string;
  /** `getURL(complete=1, queryString="previewid=<contenthistid>")` as strategies-content builds it. */
  readonly previewUrl: string;
  readonly crumbs: readonly CchainPendingCrumb[];
}

/** One chain membership in `orderno` order, with its group's name and pending requests. */
export interface CchainPendingMember {
  readonly groupName: string;
  readonly requests: readonly CchainPendingRequest[];
}

/** What `cchain.pending` renders: the chain, the site's change-set flag and the memberships. */
export interface CchainPendingData {
  readonly chain: {
    readonly chainId: string;
    readonly name: string;
    readonly description: string;
    readonly isNew: boolean;
  };
  /** `settingsManager.getSite(rc.siteID).getHasChangesets()`. */
  readonly hasChangesets: boolean;
  readonly members: readonly CchainPendingMember[];
}

// ---- Screen model reads ----

/** A struct value by case-insensitive key; undefined when absent. */
function field(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple value as CFML text; absent and SQL NULL read as `''`, complex values throw. */
function text(struct: Struct, key: string): string {
  const value = field(struct, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${key} is not a simple value`);
}

/** Whether `value` is a struct (a plain object). */
const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The nested struct under `key`; throws when it is absent or not a struct. */
function structOf(struct: Struct, key: string): Struct {
  const value = field(struct, key);
  if (!isStruct(value)) throw new TypeError(`${key} is not a struct`);
  return value;
}

/** The array of structs under `key`; throws when it is absent or holds anything else. */
function structsOf(struct: Struct, key: string): readonly Struct[] {
  const value = field(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${key} is not an array of structs`);
  return value;
}

/** A CFML boolean under `key`, or undefined when absent or NULL. */
function flag(struct: Struct, key: string): boolean | undefined {
  const value = field(struct, key);
  return value === undefined || value === null ? undefined : cfToBoolean(value);
}

/** One crumb of a request's `crumbArray`. */
function crumbOf(crumb: Struct): CchainPendingCrumb {
  // dspZoom tests `structKeyExists(crumb, 'moduleid')`, which a NULL value fails.
  const moduleid = field(crumb, 'moduleid');
  return {
    menutitle: text(crumb, 'menutitle'),
    siteid: text(crumb, 'siteid'),
    contentid: text(crumb, 'contentid'),
    ...(moduleid === undefined || moduleid === null ? {} : { moduleid: text(crumb, 'moduleid') }),
    type: text(crumb, 'type'),
    restricted: field(crumb, 'restricted') === true || cfEq(text(crumb, 'restricted'), '1'),
    icon: text(crumb, 'icon'),
  };
}

/** One row of a membership's `requests`. */
function requestOf(row: Struct): CchainPendingRequest {
  return {
    contentHistId: text(row, 'contentHistID'),
    contentId: text(row, 'contentID'),
    type: text(row, 'type'),
    parentId: text(row, 'parentID'),
    siteId: text(row, 'siteID'),
    moduleId: text(row, 'moduleID'),
    changesetId: text(row, 'changesetID'),
    changesetName: text(row, 'changesetName'),
    changesetPublishDate: text(row, 'changesetPublishDate'),
    lastUpdateBy: text(row, 'lastUpdateBy'),
    created: text(row, 'created'),
    previewUrl: text(row, 'previewURL'),
    crumbs: structsOf(row, 'crumbArray').map(crumbOf),
  };
}

/** The site's change-set flag from programs-sites; throws when the session site is not readable. */
function siteHasChangesets(site: SiteData | undefined): boolean {
  if (site === undefined) throw new Error('cchain.pending needs the site hasChangesets setting');
  return site.hasChangesets;
}

// strategies-content reports the view's own values under their legacy names: the `chain` bean, `hasChangesets` when
// it reads the site, and `members` in `orderno` order, each with `groupName` and its `requests` rows carrying
// `crumbArray` (renderIcon applied) and `previewURL`.
/** The page data of one screen model; `site` supplies `hasChangesets` when the model omits it. */
function pendingData(view: PendingViewModel, site: SiteData | undefined): CchainPendingData {
  const chain = structOf(view.rc, 'chain');
  return {
    chain: {
      chainId: text(chain, 'chainID'),
      name: text(chain, 'name'),
      description: text(chain, 'description'),
      // A chain loaded by id; the pending menu reads only its id.
      isNew: flag(chain, 'isNew') ?? false,
    },
    hasChangesets: flag(view.rc, 'hasChangesets') ?? siteHasChangesets(site),
    members: structsOf(view.rc, 'members').map((member) => ({
      groupName: text(member, 'groupName'),
      requests: structsOf(member, 'requests').map(requestOf),
    })),
  };
}

/**
 * The chain `rc.chainid` of site `rc.siteid` with its pending requests per group, from strategies-content; gateway
 * unavailability propagates.
 * @throws GatewayDenialError When strategies-content answers 401 or 403.
 */
export async function loadCchainPending(ctx: ScreenContext): Promise<CchainPendingData> {
  const params = { siteid: ctx.req.rc.siteid ?? '', chainid: ctx.req.rc.chainid ?? '' };
  const response = await ctx.gateway.strategiesContent.call('get', PENDING_PATH, { params });
  return pendingData(okBody(response, SERVICE, OPERATION), ctx.req.site);
}

// ---- Markup ----

/** The bundle labels the view writes, unencoded as legacy writes them. */
interface PendingLabels {
  readonly title: SafeHtml;
  readonly changeset: SafeHtml;
  readonly preview: SafeHtml;
  readonly versionHistory: SafeHtml;
}

/** What every request row of one page shares. */
interface RowView {
  readonly labels: PendingLabels;
  readonly hasChangesets: boolean;
  /** `rc.compactDisplay eq 'true'`. */
  readonly compact: boolean;
  /** `session.dateKeyFormat`. */
  readonly dateKeyFormat: string;
  /** The session's Java locale, which the admin sets for LSDateFormat and LSTimeFormat. */
  readonly locale: string;
}

/** A bundle label, unencoded. */
const label = (rb: RbLookup, key: string): SafeHtml => raw(rb.rbKey(key));

/** ColdFusion `HTMLEditFormat` as ACF 2023 applies it: carriage returns dropped, `&`, `<`, `>` and `"` as entities. */
function htmlEditFormat(s: string): string {
  return s
    .replaceAll('\r', '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A crumb's opening `<li>`: the lock class, plus the file class and type for a file crumb without an `mi-` icon. */
function crumbItemTag(crumb: CchainPendingCrumb, locked: string): string {
  const isFileIcon = cfEq(crumb.type, 'File') && !cfEq(cfListToArray(crumb.icon, '-')[0] ?? '', 'mi');
  if (!isFileIcon) return `<li class="${locked}">`;
  return `<li class="${locked} file" data-filetype="${crumb.icon.slice(0, 4)}">`;
}

/** The Site Manager list URL of a crumb, its values unencoded. */
function crumbHref(crumb: CchainPendingCrumb): string {
  const { context, adminDir } = legacySettings();
  return adminUrl({
    circuit: 'cArch',
    action: 'list',
    context,
    adminDir,
    params: [
      ['siteid', crumb.siteid, 'raw'],
      ['topid', crumb.contentid, 'raw'],
      ['moduleid', crumb.moduleid ?? CONTENT_MODULE_ID, 'raw'],
      ['activeTab', 0, 'raw'],
    ],
  });
}

/** A crumb's icon and HTMLEditFormat-ed menu title. */
const crumbLabel = (crumb: CchainPendingCrumb): string =>
  `<i class="${crumb.icon}"></i>${htmlEditFormat(crumb.menutitle)}`;

/**
 * `$.dspZoom(crumbArray)` with its default arguments: root to node, the node in `<strong>`, whitespace as ACF emits it.
 * @throws RangeError For an empty crumb array, where legacy fails reading the node crumb.
 */
function renderZoom(crumbs: readonly CchainPendingCrumb[]): SafeHtml {
  const node = crumbs[0];
  if (node === undefined) throw new RangeError('dspZoom needs at least the node crumb');
  let locked = '';
  let items = '';
  for (const crumb of crumbs.slice(1).reverse()) {
    // Never reset: every crumb after the first restricted ancestor, the node included, is marked locked.
    if (crumb.restricted) locked = 'locked';
    items += `\n\t\t\t${crumbItemTag(crumb, locked)}\n\t\t\t<a \n\t\t\t\thref="${crumbHref(crumb)}"\n\t\t\t>${crumbLabel(crumb)}</a></li>\n\t\t`;
  }
  const nodeItem = `${crumbItemTag(node, locked)}<strong>\n\t\t<a \n\t\t\thref="${crumbHref(node)}"\n\t\t>${crumbLabel(node)}</a></strong></li>`;
  return raw(`<ul class="breadcrumb">\n\t\t${items}\n\t\t${nodeItem}\n\t\t</ul>`);
}

/** The row's Preview item: the front-end proxy in compact display, else the admin `preview()` popup. */
function previewItem(request: CchainPendingRequest, view: RowView): SafeHtml {
  // Only the compact link JS-encodes the URL; the full layout's interpolates it as is.
  const onclick = view.compact
    ? raw(`frontEndProxy.post({cmd:'setLocation',location:encodeURIComponent('${encodeJs(request.previewUrl)}')});return false;`)
    : raw(`return preview('${request.previewUrl}','');`);
  return html`
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="preview">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" onclick="${onclick}">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-globe"></i> ${view.labels.preview}</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t`;
}

/** The change set's calendar tooltip and assignments link, or `NA` when the version has no change set. */
function changesetCell(request: CchainPendingRequest, view: RowView): SafeHtml {
  let inner: SafeHtml = raw('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tNA\n\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (request.changesetId.length > 0) {
    const publishDate = parseLegacyDate(request.changesetPublishDate);
    // The mask keeps its leading space, as the view passes it.
    const tooltip =
      publishDate === null
        ? null
        : html`
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" rel="tooltip" title="${raw(encodeHtmlAttr(cfLsDateFormat(publishDate, ' short', view.locale)))}">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-calendar"></i>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t`;
    const assignmentsHref = raw(
      `./?muraAction=cChangesets.assignments&siteID=${request.siteId}&changesetID=${request.changesetId}`,
    );
    inner = html`${tooltip}
\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="${assignmentsHref}">${request.changesetName}</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t`;
  }
  return html`
\t\t\t\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t\t\t\t${inner}
\t\t\t\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t\t\t`;
}

/**
 * `LSDateFormat(created, session.dateKeyFormat) LSTimeFormat(created, "medium")`, unguarded as the view leaves it.
 * @throws RangeError When `created` is not empty and not a date, as ACF fails.
 */
function requestDate(created: string, view: RowView): string {
  // Both functions print nothing for an empty string.
  if (created === '') return ' ';
  const date = parseLegacyDate(created);
  if (date === null) throw new RangeError(`The value ${created} cannot be converted to a date.`);
  return `${cfLsDateFormat(date, view.dateKeyFormat, view.locale)} ${cfLsTimeFormat(date, 'medium', view.locale)}`;
}

/** One pending request row: its actions menu, crumb zoom, change set, requester and request time. */
function requestRow(request: CchainPendingRequest, view: RowView): SafeHtml {
  const type = encodeUrl(request.type);
  const target =
    `&contentid=${request.contentId}&type=${type}&parentid=${request.parentId}` +
    `&siteid=${encodeUrl(request.siteId)}&moduleid=${request.moduleId}`;
  const editHref = raw(`./?muraAction=cArch.edit&contenthistid=${request.contentHistId}${target}&return=chain`);
  const historyHref = raw(`./?muraAction=cArch.hist${target}`);
  const preview = PREVIEW_TYPES.includes(type.toLowerCase()) ? previewItem(request, view) : null;
  return html`
\t\t\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);">
\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-ellipsis-v"></i>
\t\t\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="edit">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="${editHref}">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-pencil"></i> Edit
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t\t\t\t\t\t\t${preview}
\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="version-history">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="${historyHref}">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-history"></i> ${view.labels.versionHistory}</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t\t\t<td class="title var-width">${renderZoom(request.crumbs)}</td>
\t\t\t\t\t\t\t\t\t\t${view.hasChangesets ? changesetCell(request, view) : null}
\t\t\t\t\t\t\t\t\t\t<td>${request.lastUpdateBy}</td>
\t\t\t\t\t\t\t\t\t\t<td>${raw(requestDate(request.created, view))}</td>
\t\t\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t\t\t`;
}

/** A group's requests table, without `thead` or `tbody` as legacy writes it. */
function requestTable(requests: readonly CchainPendingRequest[], view: RowView): SafeHtml {
  const changesetHeader = view.hasChangesets
    ? html`
\t\t\t\t\t\t\t\t\t\t<th>${view.labels.changeset}</th>
\t\t\t\t\t\t\t\t\t`
    : null;
  return html`
\t\t\t\t\t\t\t<table class="mura-table-grid">
\t\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t\t<th class="actions"></th>
\t\t\t\t\t\t\t\t\t<th class="var-width">${view.labels.title}</th>
\t\t\t\t\t\t\t\t\t${changesetHeader}
\t\t\t\t\t\t\t\t\t<th>
\t\t\t\t\t\t\t\t\t\tRequest By</th>
\t\t\t\t\t\t\t\t\t<th>
\t\t\t\t\t\t\t\t\t\tRequest Date</th>
\t\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t\t\t${requests.map((request) => requestRow(request, view))}
\t\t\t\t\t\t\t</table>
\t\t\t\t\t\t`;
}

/** One membership: its 1-based position and group name, then its requests or the empty notice. */
function memberBlock(member: CchainPendingMember, position: number, view: RowView): SafeHtml {
  const requests =
    member.requests.length > 0
      ? requestTable(member.requests, view)
      : html`
\t\t\t\t\t\t\t<div class="help-block-empty">No pending requests exist for this group in the approval chain.</div>
\t\t\t\t\t\t`;
  return html`
\t\t\t\t\t\t<h4>${position}. ${member.groupName}</h4>
\t\t\t\t\t\t${requests}`;
}

/** The view body: header with the cchain menu, then the chain and each membership's pending requests. */
export function renderCchainPending(ctx: ScreenContext, data: CchainPendingData): ShellView {
  const { rb, req } = ctx;
  const view: RowView = {
    labels: {
      title: label(rb, 'sitemanager.content.title'),
      changeset: label(rb, 'approvalchains.changeset'),
      preview: label(rb, 'sitemanager.content.preview'),
      versionHistory: label(rb, 'sitemanager.content.versionhistory'),
    },
    hasChangesets: data.hasChangesets,
    // The platform's CFML `eq`: text compared case-insensitively, since `'true'` is not numeric.
    compact: cfEq(req.rc.compactDisplay ?? '', 'true'),
    dateKeyFormat: req.session.dateKeyFormat,
    locale: req.session.locale,
  };
  const { chain } = data;
  const menu = renderCchainSecondaryMenu(req, rb, { chainId: chain.chainId, isNew: chain.isNew });
  const description =
    chain.description.length > 0
      ? html`
\t\t\t\t\t<p>${chain.description}</p>
\t\t\t\t`
      : null;
  const members =
    data.members.length > 0
      ? html`
\t\t\t\t\t<hr />
\t\t\t\t\t${data.members.map((member, index) => memberBlock(member, index + 1, view))}`
      : html`
\t\t\t\t\t<div class="help-block-empty">No groups have been assigned to this approval chain yet.</div>
\t\t\t\t`;
  const body = html`
\t<div class="mura-header">
\t\t<h1>${label(rb, 'approvalchains')}</h1>
\t\t${menu}
\t</div>
\t<!-- /.mura-header -->
\t<div class="block block-constrain">
\t\t<div class="block block-bordered">
\t\t\t<div class="block-content">
\t\t\t\t<h2>${label(rb, 'approvalchains.pendingrequests')}</h2>
\t\t\t\t<h3>${chain.name}</h3>

\t\t\t\t${description}${members}

\t\t\t</div>
\t\t\t<!-- /.block-content -->
\t\t</div>
\t\t<!-- /.block-bordered -->
\t</div>
\t<!-- /.block-constrain -->
`;
  return { body };
}
