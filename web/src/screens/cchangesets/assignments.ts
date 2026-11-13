// The `cChangesets.assignments` page: a change set's assigned content per module, after `cchangesets/assignments.cfm` (server-only).
import { cfEq, cfLsDateFormat, cfToBoolean } from '@opt2/platform/legacy-compat';
import { parseLegacyDate } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, html, isSafeHtml, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { PageScreen, ScreenContext } from '../registry';
import { renderChangesetsMenu } from './secondary-menu';

const SERVICE = 'strategies-content';
const OPERATION = 'listChangesetAssignments';
const ASSIGNMENTS_PATH = '/v1/sites/{siteid}/changesets/{changesetid}/assignments';

/** Site Manager module, dspZoom's default for a crumb without `moduleid`. */
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';

/** A struct of the screen model: a bean's values or a query row, keys matched case-insensitively as in CFML. */
type Struct = Readonly<Record<string, unknown>>;

/** The shell view a page screen renders. */
type ShellView = Awaited<ReturnType<PageScreen['render']>>;

/** One `contentManager.getCrumbList` entry as dspZoom reads it; the item first, the site root last. */
export interface ChangesetAssignmentCrumb {
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

/** One assigned content version: its `getAssignmentsQuery` columns plus the values strategies-content computed for it. */
export interface ChangesetAssignmentRow {
  readonly contentHistId: string;
  readonly contentId: string;
  readonly changesetId: string;
  readonly type: string;
  readonly parentId: string;
  readonly moduleId: string;
  readonly menuTitle: string;
  /** `tapprovalrequests.status`; `''` without an approval request. */
  readonly approvalStatus: string;
  readonly approved: boolean;
  readonly active: boolean;
  /** `permUtility.getnodePerm(crumbdata)`. */
  readonly verdict: string;
  /** `item.getURL(complete=1, queryString="previewid=<contenthistid>")`; only site architecture rows print it. */
  readonly previewUrl: string;
  /** `tcontent.remoteurl`; only variation rows print it. */
  readonly remoteUrl?: string;
  /** `$.dspZoom(crumbdata)`: the markup strategies-content rendered, or the crumbs {@link renderZoom} renders. */
  readonly zoom: SafeHtml | readonly ChangesetAssignmentCrumb[];
}

/** What `cChangesets.assignments` renders: `rc.changeset`, `rc.previewLink` and the assignment lists per module. */
export interface ChangesetAssignmentsData {
  readonly changeset: {
    readonly changesetId: string;
    readonly name: string;
    readonly published: boolean;
    /** `rc.changeset.hasPendingApprovals()`; false for a published change set, which the view never asks. */
    readonly hasPendingApprovals: boolean;
    /** `getCloseDate()` as sent; null when empty. */
    readonly closeDate: string | null;
  };
  /** The home page's change-set preview URL the secondary menu sets; `''` for a published change set. */
  readonly previewLink: string;
  /** Module `…000`. */
  readonly site: readonly ChangesetAssignmentRow[];
  /** Module `…003`. */
  readonly components: readonly ChangesetAssignmentRow[];
  /** Module `…004`. */
  readonly forms: readonly ChangesetAssignmentRow[];
  /** Module `…099`, present only when the `variations` setting is on. */
  readonly variations?: readonly ChangesetAssignmentRow[];
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
  throw new TypeError(`${OPERATION} returned ${key} that is not a simple value`);
}

/** A value strategies-content computes for the view; throws when the model omits it. */
function computed(struct: Struct, key: string): string {
  const value = field(struct, key);
  if (value === undefined || value === null) throw new TypeError(`${OPERATION} returned no ${key}`);
  return text(struct, key);
}

/** A CFML boolean; an absent or NULL value reads as `''`, which CFML cannot convert either. */
const bool = (struct: Struct, key: string): boolean => cfToBoolean(text(struct, key));

const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The nested struct under `key`; throws when it is absent or not a struct. */
function structOf(struct: Struct, key: string): Struct {
  const value = field(struct, key);
  if (!isStruct(value)) throw new TypeError(`${OPERATION} returned no ${key} struct`);
  return value;
}

/** The query rows under `key`; undefined when absent, throws when it holds anything but structs. */
function rowsOf(struct: Struct, key: string): readonly Struct[] | undefined {
  const value = field(struct, key);
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${OPERATION} returned ${key} that is not rows`);
  return value;
}

/** The rows of a list the controller always sets. */
function requiredRowsOf(struct: Struct, key: string): readonly Struct[] {
  const rows = rowsOf(struct, key);
  if (rows === undefined) throw new TypeError(`${OPERATION} returned no ${key}`);
  return rows;
}

/** One `crumbdata` entry. */
function crumbOf(crumb: Struct): ChangesetAssignmentCrumb {
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

/** A row's rendered `zoom` markup, else its `crumbdata`; throws when it carries neither. */
function zoomOf(row: Struct): ChangesetAssignmentRow['zoom'] {
  const zoom = field(row, 'zoom');
  if (typeof zoom === 'string') return raw(zoom);
  const crumbs = rowsOf(row, 'crumbdata');
  if (crumbs === undefined) throw new TypeError(`${OPERATION} returned a row with neither zoom nor crumbdata`);
  return crumbs.map(crumbOf);
}

/** One assignment row. */
function rowOf(row: Struct): ChangesetAssignmentRow {
  return {
    contentHistId: text(row, 'contentHistID'),
    contentId: text(row, 'contentID'),
    changesetId: text(row, 'changesetID'),
    type: text(row, 'type'),
    parentId: text(row, 'parentID'),
    moduleId: text(row, 'moduleID'),
    menuTitle: text(row, 'menuTitle'),
    approvalStatus: text(row, 'approvalStatus'),
    approved: bool(row, 'approved'),
    active: bool(row, 'active'),
    verdict: computed(row, 'verdict'),
    previewUrl: text(row, 'previewURL'),
    remoteUrl: text(row, 'remoteURL'),
    zoom: zoomOf(row),
  };
}

// strategies-content reports the view's values under their legacy names: the `changeset` bean, `previewLink` and
// `hasPendingApprovals` (at rc level or on the bean) for an unpublished change set, and the `siteAssignments`,
// `componentAssignments`, `formAssignments` and, only when variations are on, `variationAssignments` query rows, each
// row carrying its `verdict`, `previewURL` and either its rendered `zoom` or its `crumbdata` (renderIcon applied).
/** The page data of one screen model. */
function assignmentsData(rc: Struct): ChangesetAssignmentsData {
  const bean = structOf(rc, 'changeset');
  const published = bool(bean, 'published');
  const pending = published ? false : (field(rc, 'hasPendingApprovals') ?? field(bean, 'hasPendingApprovals'));
  if (pending === undefined || pending === null) throw new TypeError(`${OPERATION} returned no hasPendingApprovals`);
  const closeDate = text(bean, 'closeDate');
  const variations = rowsOf(rc, 'variationAssignments');
  return {
    changeset: {
      changesetId: text(bean, 'changesetID'),
      name: text(bean, 'name'),
      published,
      hasPendingApprovals: cfToBoolean(pending),
      closeDate: closeDate === '' ? null : closeDate,
    },
    previewLink: published ? '' : computed(rc, 'previewLink'),
    site: requiredRowsOf(rc, 'siteAssignments').map(rowOf),
    components: requiredRowsOf(rc, 'componentAssignments').map(rowOf),
    forms: requiredRowsOf(rc, 'formAssignments').map(rowOf),
    ...(variations === undefined ? {} : { variations: variations.map(rowOf) }),
  };
}

/**
 * The change set `rc.changesetID` of site `rc.siteid` with its assignments filtered by `rc.keywords`, and the remove
 * links' CSRF tokens; gateway unavailability propagates.
 * @throws GatewayDenialError When strategies-content answers 401 or 403.
 */
export async function loadChangesetAssignments(ctx: ScreenContext): Promise<ChangesetAssignmentsData> {
  const { rc } = ctx.req;
  const changesetid = rc.changesetid;
  // Legacy's controller reads `rc.changesetID` unguarded, so a request without it errors before any lookup.
  if (changesetid === undefined) throw new TypeError('Element CHANGESETID is undefined in RC.');
  const [response] = await Promise.all([
    ctx.gateway.strategiesContent.call('get', ASSIGNMENTS_PATH, {
      params: { siteid: rc.siteid ?? '', changesetid },
      query: { keywords: rc.keywords ?? '' },
    }),
    ctx.csrf.prefetch([changesetid]),
  ]);
  return assignmentsData(okBody(response, SERVICE, OPERATION).rc);
}

// ---- Markup ----

/** What every row of the page shares, encoded as the view encodes it. */
interface RowView {
  readonly rb: RbLookup;
  /** `esapiEncode('url', rc.siteid)`. */
  readonly siteid: string;
  /** `esapiEncode('url', rc.startrow)`. */
  readonly startrow: string;
  /** `esapiEncode('html', rc.keywords)`. */
  readonly keywords: string;
  /** `renderCSRFTokens(context=rc.changesetid, format='url')`. */
  readonly csrf: SafeHtml;
}

/** A bundle label, unencoded as legacy writes it. */
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
function crumbItemTag(crumb: ChangesetAssignmentCrumb, locked: string): string {
  const iconPrefix = crumb.icon.split('-').find((part) => part !== '') ?? '';
  const isFileIcon = cfEq(crumb.type, 'File') && !cfEq(iconPrefix, 'mi');
  if (!isFileIcon) return `<li class="${locked}">`;
  return `<li class="${locked} file" data-filetype="${crumb.icon.slice(0, 4)}">`;
}

/** The Site Manager list URL of a crumb, its values unencoded. */
function crumbHref(crumb: ChangesetAssignmentCrumb): string {
  const { context, adminDir } = legacySettings();
  return (
    `${context}${adminDir}/?muraAction=cArch.list&siteid=${crumb.siteid}&topid=${crumb.contentid}` +
    `&moduleid=${crumb.moduleid ?? CONTENT_MODULE_ID}&activeTab=0`
  );
}

/** A crumb's icon and HTMLEditFormat-ed menu title. */
const crumbLabel = (crumb: ChangesetAssignmentCrumb): string =>
  `<i class="${crumb.icon}"></i>${htmlEditFormat(crumb.menutitle)}`;

/**
 * `$.dspZoom(crumbdata)` with its default arguments: root to item, the item in `<strong>`, whitespace as ACF emits it.
 * @throws RangeError For an empty crumb list, where legacy fails reading the item crumb.
 */
export function renderZoom(crumbs: readonly ChangesetAssignmentCrumb[]): SafeHtml {
  const item = crumbs[0];
  if (item === undefined) throw new RangeError('dspZoom needs at least the item crumb');
  let locked = '';
  let items = '';
  for (const crumb of crumbs.slice(1).reverse()) {
    // Never reset: every crumb after the first restricted ancestor, the item included, is marked locked.
    if (crumb.restricted) locked = 'locked';
    items += `\n\t\t\t${crumbItemTag(crumb, locked)}\n\t\t\t<a \n\t\t\t\thref="${crumbHref(crumb)}"\n\t\t\t>${crumbLabel(crumb)}</a></li>\n\t\t`;
  }
  const itemTag = `${crumbItemTag(item, locked)}<strong>\n\t\t<a \n\t\t\thref="${crumbHref(item)}"\n\t\t>${crumbLabel(item)}</a></strong></li>`;
  return raw(`<ul class="breadcrumb">\n\t\t${items}\n\t\t${itemTag}\n\t\t</ul>`);
}

/** A row's zoom markup: the service's as sent, else {@link renderZoom} of its crumbs. */
const zoomMarkup = (row: ChangesetAssignmentRow): SafeHtml => (isSafeHtml(row.zoom) ? row.zoom : renderZoom(row.zoom));

const isNone = (verdict: string): boolean => cfEq(verdict, 'none');

const NO_RESULTS = raw(`
      <tr>
        <td colspan="3" class="results">Your search returned no results.</td>
      </tr>`);

/** The status column: the approval status, else published, archived or queued. */
function statusLabel(row: ChangesetAssignmentRow, rb: RbLookup): SafeHtml {
  if (row.approvalStatus.length > 0) return label(rb, `sitemanager.content.${row.approvalStatus}`);
  if (row.approved && row.active) return label(rb, 'sitemanager.content.published');
  if (row.approved) return label(rb, 'sitemanager.content.archived');
  return label(rb, 'sitemanager.content.queued');
}

/** The remove item every row's actions end with. */
function deleteItem(row: ChangesetAssignmentRow, view: RowView): SafeHtml {
  // legacy quirk: `keywords` is HTML-encoded inside the URL instead of URL-encoded.
  const href = raw(
    `./?muraAction=cChangesets.removeItem&contentHistId=${row.contentHistId}&siteid=${view.siteid}` +
      `&changesetID=${encodeUrl(row.changesetId)}&keywords=${view.keywords}${view.csrf.value}`,
  );
  const confirm = raw(encodeJs(view.rb.messageFormat(view.rb.rbKey('changesets.removeitemconfirm'), row.menuTitle)));
  return html`
            \t\t<li class="delete"><a href="${href}" onclick="return confirmDialog('${confirm}',this.href)"><i class="mi-trash"></i>Delete</a></li>`;
}

/** The `editlink` of the component, form and variation rows; its values unencoded but for site and start row. */
const editLink = (row: ChangesetAssignmentRow, view: RowView): string =>
  `./?muraAction=cArch.edit&contenthistid=${row.contentHistId}&contentid=${row.contentId}&type=${row.type}` +
  `&parentid=${row.parentId}&siteid=${view.siteid}&moduleid=${row.moduleId}&startrow=${view.startrow}&return=changesets`;

/** The version history link of the component, form and variation rows; `beforeSiteid` is what precedes `siteid=`. */
const historyLink = (row: ChangesetAssignmentRow, view: RowView, beforeSiteid: '&' | '&&'): string =>
  `./?muraAction=cArch.hist&contentid=${row.contentId}&type=${encodeUrl(row.type)}&parentid=${row.parentId}` +
  `${beforeSiteid}siteid=${view.siteid}&moduleid=${row.moduleId}&startrow=${view.startrow}`;

/** Site architecture actions: edit, preview and history, or only the preview without a node permission. */
function siteActions(row: ChangesetAssignmentRow, view: RowView): SafeHtml {
  const preview = raw(`return preview('${row.previewUrl}');`);
  if (isNone(row.verdict)) {
    // legacy quirk: the disabled history item reads "Preview".
    return html`
                  <li class="preview"><a href="#" onclick="${preview}"><i class="mi-globe"></i></a></li>
                  <li class="version-history disabled"><i class="mi-history"></i>Preview</li>`;
  }
  const edit = raw(
    `./?muraAction=cArch.edit&contenthistid=${row.contentHistId}&contentid=${row.contentId}&type=${encodeJs(row.type)}` +
      `&parentid=${row.parentId}&topid=${encodeUrl(row.contentId)}&siteid=${view.siteid}&moduleid=${row.moduleId}` +
      `&startrow=${view.startrow}&return=changesets`,
  );
  const history = raw(
    `./?muraAction=cArch.hist&contentid=${row.contentId}&type=${row.type}&parentid=${row.parentId}` +
      `&topid=${row.contentId}&siteid=${view.siteid}&moduleid=${row.moduleId}&startrow=${view.startrow}`,
  );
  return html`
                  <li class="edit"><a href="${edit}"> <i class="mi-pencil"></i>Edit</a></li>
                \t <li class="preview"><a href="#" onclick="${preview}"><i class="mi-globe"></i>Preview</a></li>
                   <li class="version-history"><a href="${history}"><i class="mi-history"></i>Version History</a></li>`;
}

/** Component or form actions: edit and history with a node permission, otherwise none. */
function editHistoryActions(row: ChangesetAssignmentRow, view: RowView, beforeSiteid: '&' | '&&'): SafeHtml | null {
  if (isNone(row.verdict)) return null;
  return html`
                    <li class="edit"><a href="${raw(editLink(row, view))}"><i class="mi-pencil"></i>Edit</a></li>
              \t\t  <li class="version-history"><a href="${raw(historyLink(row, view, beforeSiteid))}"><i class="mi-history"></i>Version History</a></li>`;
}

/**
 * Variation actions: titled icon-only edit, history and remote preview.
 * @throws TypeError Without a node permission, where legacy reads the undefined `rc.rstop` and fails.
 */
function variationActions(row: ChangesetAssignmentRow, view: RowView): SafeHtml {
  // legacy quirk: the no-permission branch tests `rc.rstop.type`, which no controller sets.
  if (isNone(row.verdict)) throw new TypeError('Element RSTOP is undefined in RC.');
  const preview = raw(`return preview('${row.remoteUrl ?? ''}?previewid=${row.contentHistId}');`);
  return html`
                <li class="edit"><a title="Edit" href="${raw(editLink(row, view))}"><i class="mi-pencil"></i></a></li>
                <li class="version-history"><a title="Version History" href="${raw(historyLink(row, view, '&'))}"><i class="mi-history"></i></a></li>
                 <li class="preview"><a title="${label(view.rb, 'sitemanager.view')}" href="#" onclick="${preview}"><i class="mi-globe"></i></a></li>`;
}

/** One row: the actions menu, the title cell and the status. */
function assignmentRow(
  row: ChangesetAssignmentRow,
  view: RowView,
  actions: SafeHtml | null,
  titleCell: SafeHtml,
): SafeHtml {
  return html`
        <tr>
     \t\t  <td class="actions">
            <a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
            <div class="actions-menu hide">
          \t\t<ul class="actions-list">${actions}${deleteItem(row, view)}
        \t\t</ul>
         </div>
  \t\t  </td>
          ${titleCell}
           <td>
              ${statusLabel(row, view.rb)}
          </td>
  \t\t</tr>`;
}

/** `<td class="title var-width">` around the row's zoom. */
const zoomCell = (row: ChangesetAssignmentRow): SafeHtml => html`<td class="title var-width">${zoomMarkup(row)}</td>`;

/** One module's heading and table, its rows rendered by `rowMarkup`, or the no-results row. */
function section(
  heading: SafeHtml,
  rows: readonly ChangesetAssignmentRow[],
  view: RowView,
  rowMarkup: (row: ChangesetAssignmentRow) => SafeHtml,
): SafeHtml {
  return html`
      <h3>${heading}</h3>
 <table class="mura-table-grid">
    <tr>
      <th class="actions"></th>
      <th class="var-width"> ${label(view.rb, 'sitemanager.content.title')}</th>
      <th> ${label(view.rb, 'sitemanager.content.status')}</th>
    </tr>${rows.length > 0 ? rows.map(rowMarkup) : NO_RESULTS}
      </table>
`;
}

/** The four module sections in view order; variations only when the data carries them. */
function sections(data: ChangesetAssignmentsData, view: RowView): SafeHtml {
  const { rb } = view;
  const variations =
    data.variations === undefined
      ? null
      : section(label(rb, 'changesets.variations'), data.variations, view, (row) =>
          assignmentRow(
            row,
            view,
            variationActions(row, view),
            html`<td class="title var-width"><a href="${raw(editLink(row, view))}">${zoomMarkup(row)}</a></td>`,
          ),
        );
  return html`${section(label(rb, 'changesets.sitearchitecture'), data.site, view, (row) =>
    assignmentRow(row, view, siteActions(row, view), zoomCell(row)),
  )}
${section(label(rb, 'changesets.components'), data.components, view, (row) =>
  // legacy quirk: the component history link doubles the `&` before `siteid`.
  assignmentRow(row, view, editHistoryActions(row, view, '&&'), zoomCell(row)),
)}
${section(label(rb, 'changesets.forms'), data.forms, view, (row) =>
  assignmentRow(row, view, editHistoryActions(row, view, '&'), zoomCell(row)),
)}${variations}`;
}

/** The published, pending-approval and close-date alerts, in view order. */
function alerts(ctx: ScreenContext, changeset: ChangesetAssignmentsData['changeset']): SafeHtml {
  const { rb, req } = ctx;
  const parts: SafeHtml[] = [];
  if (changeset.published) {
    parts.push(html`
      <div class="alert alert-info"><span>${label(rb, 'changesets.publishednotice')}</span></div>`);
  } else if (changeset.hasPendingApprovals) {
    parts.push(html`
    <div class="alert alert-error"><span>${label(rb, 'changesets.haspendingapprovals')}</span></div>`);
  }
  const closeDate = changeset.published ? null : parseLegacyDate(changeset.closeDate);
  if (closeDate !== null) {
    // Plain LSDateFormat, so not formatDateField, whose datetimeselector rule blanks dates 50 years out.
    const formatted = cfLsDateFormat(closeDate, req.session.dateKeyFormat, req.session.locale);
    parts.push(html`
        <div class="alert alert-info"><span>${raw(rb.messageFormat(rb.rbKey('changesets.hasclosedate'), formatted))}</span></div>`);
  }
  return html`${parts}`;
}

/** The view body: header with the change-set menu, alerts, the preview link, the keyword filter and the sections. */
export function renderChangesetAssignments(ctx: ScreenContext, data: ChangesetAssignmentsData): ShellView {
  const { req, rb } = ctx;
  const { rc } = req;
  const { changeset } = data;
  const menu = renderChangesetsMenu(req, rb, {
    changesetId: changeset.changesetId,
    published: changeset.published,
    isNew: false,
    previewLink: data.previewLink,
  });
  const previewLink = menu.previewLink;
  const preview =
    previewLink === undefined
      ? null
      : html`
      <p><i class="mi-link"></i> <a title="${raw(encodeHtmlAttr(changeset.name))}" href="${raw(encodeHtmlAttr(previewLink))}" onclick="return preview('${raw(encodeJs(previewLink))}','');">${raw(encodeHtml(previewLink))}</a></p><br/>`;
  const view: RowView = {
    rb,
    siteid: encodeUrl(rc.siteid ?? ''),
    startrow: encodeUrl(rc.startrow ?? ''),
    keywords: encodeHtml(rc.keywords ?? ''),
    csrf: ctx.csrf.render(rc.changesetid ?? '', 'url'),
  };
  const body = html`

<div class="mura-header">
  <h1>Change Set Content List</h1>
  ${menu.html}
</div> <!-- /.mura-header -->

${alerts(ctx, changeset)}

      <div class="block-content">

      <div class="block block-constrain">
          <div class="block block-bordered">
      <h2>${raw(encodeHtml(changeset.name))}</h2>
${preview}

      <form class="form-inline separate" novalidate="novalidate" id="assignmentSearch" name="assignmentSearch" method="get">
    \t<input name="keywords" placeholder="Keywords" value="${raw(encodeHtmlAttr(rc.keywords))}" type="text" class="text" maxlength="50" />
    \t<input type="button" class="btn" onclick="return submitForm(document.forms.assignmentSearch);" value="${label(rb, 'changesets.filterview')}" />
    \t<input type="hidden" name="muraAction" value="cChangesets.assignments">
    \t<input type="hidden" name="siteid" value="${raw(encodeHtmlAttr(rc.siteid))}">
    \t<input type="hidden" name="changesetID" value="${raw(encodeHtmlAttr(rc.changesetID))}">
      </form>
      <br/>

${sections(data, view)}

    </div> <!-- /.block-content -->
  </div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->
`;
  return { body };
}

/** `cChangesets.assignments` without the circuit gate and `rc` defaults, which `./index.ts` adds. */
export const changesetAssignmentsScreen: Omit<PageScreen<ChangesetAssignmentsData>, 'gate'> = Object.freeze({
  circuit: 'cchangesets',
  action: 'assignments',
  mode: 'page',
  owner: SERVICE,
  secondaryMenu: 'cchangesets',
  load: loadChangesetAssignments,
  render: renderChangesetAssignments,
});
