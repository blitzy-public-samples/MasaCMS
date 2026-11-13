// The `cArch.draft` page: the session user's drafts, after `carch/draft.cfm` (server-only).
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { carchJs } from './partials/js';
import { dspZoom, type ZoomOptions } from './partials/zoom';
import { carchPageData, type CarchOutcome, type CarchPageModel } from './service';

const SERVICE = 'strategies-content';
const OPERATION = 'listDrafts';

/** Types the view links by title instead of printing their breadcrumb (its `cfcase` list, matched case-insensitively). */
const TITLE_LINK_TYPES: readonly string[] = Object.freeze(['form', 'component']);

/** Node verdicts that list a draft for a user who is neither a site admin nor S2. */
const LISTING_VERDICTS: readonly string[] = Object.freeze(['editor', 'author']);

/** A struct of the screen model: a query row or a crumb, keys matched case-insensitively as in CFML. */
type Struct = Readonly<CarchPageModel['rc']>;

/** `contentManager.getCrumbList(contentid, rc.siteid)`: the node first, the site root last. */
type Crumbs = ZoomOptions['crumbdata'];

/** One `getDraftList` row with the values strategies-content computed for it. */
export interface DraftRow {
  readonly contentId: string;
  readonly type: string;
  readonly parentId: string;
  readonly moduleId: string;
  readonly menuTitle: string;
  /** The module's title (`module.title AS module`). */
  readonly module: string;
  /** `permUtility.getnodePerm(crumbdata)`. */
  readonly verdict: string;
  /** The row's `crumbdata`; only a breadcrumb row reads it. */
  readonly crumbdata?: Crumbs;
}

/** What `cArch.draft` renders: the `rc.rslist` rows in list order. */
export interface DraftData {
  readonly rows: readonly DraftRow[];
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

const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The array of structs under `key`; undefined when absent, throws when it holds anything else. */
function structsOf(struct: Struct, key: string): readonly Struct[] | undefined {
  const value = field(struct, key);
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isStruct)) {
    throw new TypeError(`${OPERATION} returned ${key} that is not an array of structs`);
  }
  return value;
}

// The contract leaves the model open: `rc.rslist` is read as the getDraftList rows, each with its node `verdict` and
// its `crumbdata` (each crumb with renderIcon's `iconclass`), the names strategies-content's other row models use.
/** One draft row; throws when strategies-content left out its verdict. */
function draftRowOf(row: Struct): DraftRow {
  const verdict = field(row, 'verdict');
  if (typeof verdict !== 'string') throw new TypeError(`${OPERATION} returned a row without its verdict`);
  const crumbdata = structsOf(row, 'crumbdata');
  return {
    contentId: text(row, 'contentID'),
    type: text(row, 'type'),
    parentId: text(row, 'parentID'),
    moduleId: text(row, 'moduleID'),
    menuTitle: text(row, 'menuTitle'),
    module: text(row, 'module'),
    verdict,
    ...(crumbdata === undefined ? {} : { crumbdata }),
  };
}

/** The page data of one screen model; throws when it carries no `rslist`. */
function draftDataOf(model: CarchPageModel): DraftData {
  const rows = structsOf(model.rc, 'rslist');
  if (rows === undefined) throw new TypeError(`${OPERATION} returned no rslist`);
  return { rows: rows.map(draftRowOf) };
}

// ---- Controller ----

/** Each request's before() and `draft()` read, shared by the redirect step and `load` of the same context. */
const outcomes = new WeakMap<ScreenContext, Promise<CarchOutcome<CarchPageModel>>>();

/** carch before() applied to `ctx.req`, then `contentManager.getDraftList(rc.siteid)`, once per request. */
function draftOutcome(ctx: ScreenContext): Promise<CarchOutcome<CarchPageModel>> {
  const known = outcomes.get(ctx);
  if (known !== undefined) return known;
  ctx.req = applyCarchDefaults(ctx.req);
  const outcome = carchPageData(ctx, 'draft');
  outcomes.set(ctx, outcome);
  return outcome;
}

/** The controller `secure()` redirect when strategies-content denies the read; otherwise the view renders. */
async function draftRedirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const outcome = await draftOutcome(ctx);
  return outcome.kind === 'redirect' ? { kind: 'location', location: outcome.location } : undefined;
}

/** The drafts of the request's site; an outcome other than the model throws. */
async function loadDrafts(ctx: ScreenContext): Promise<DraftData> {
  const outcome = await draftOutcome(ctx);
  if (outcome.kind === 'rejected') throw new Error(`${SERVICE} rejected ${OPERATION} with HTTP ${outcome.status}`);
  if (outcome.kind === 'redirect') throw new Error(`${SERVICE} denied ${OPERATION}; the redirect step answers it`);
  return draftDataOf(outcome.data);
}

// ---- Markup ----

/** What every listed row shares, encoded as the view encodes it. */
interface RowView {
  readonly ctx: ScreenContext;
  /** `sitemanager.versionhistory`, unencoded. */
  readonly versionHistory: SafeHtml;
  /** `&topid=…&siteid=…` of the history links, each `esapiEncode('url', …)`. */
  readonly topAndSite: string;
}

/** A bundle label, unencoded as legacy writes it. */
const label = (rb: RbLookup, key: string): SafeHtml => raw(rb.rbKey(key));

/** `rc[name]` by case-insensitive name; throws as ACF does when it is undefined. */
function rcText(rc: Rc, name: string): string {
  const lower = name.toLowerCase();
  const key = Object.hasOwn(rc, name) ? name : Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  const value = key === undefined ? undefined : rc[key];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** The shared row values; `rc.topid` is read only once a row is listed, as the view first reads it there. */
function rowViewOf(ctx: ScreenContext): RowView {
  const { rc } = ctx.req;
  return {
    ctx,
    versionHistory: label(ctx.rb, 'sitemanager.versionhistory'),
    topAndSite: `&topid=${encodeUrl(rcText(rc, 'topid'))}&siteid=${encodeUrl(rcText(rc, 'siteid'))}`,
  };
}

/** A row's `cArch.hist` link; row values are written unencoded, as legacy writes them. */
function historyHref(row: DraftRow, view: RowView): SafeHtml {
  return raw(
    `./?muraAction=cArch.hist&contentid=${row.contentId}&type=${row.type}&parentid=${row.parentId}` +
      `${view.topAndSite}&moduleid=${row.moduleId}`,
  );
}

/** The title cell: a history link for forms and components, else `$.dspZoom(itemcrumbdata)`. */
function titleCell(row: DraftRow, view: RowView, href: SafeHtml): SafeHtml {
  if (TITLE_LINK_TYPES.includes(row.type.toLowerCase())) {
    return html`
<a title="${view.versionHistory}" href="${href}">${raw(row.menuTitle)}</a>
`;
  }
  if (row.crumbdata === undefined) throw new TypeError(`${OPERATION} returned a breadcrumb row without crumbdata`);
  return dspZoom(view.ctx, { crumbdata: row.crumbdata });
}

/** One listed draft: its actions menu, title cell and module title. */
function draftRow(row: DraftRow, view: RowView): SafeHtml {
  const href = historyHref(row, view);
  // The double space is what the CFML comment between href and onclick leaves behind.
  return html`

\t\t<tr>
        <td class="actions">
          <a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
          <div class="actions-menu hide">
            <ul class="drafts actions-list">
              <li class="version-history">
                <a href="${href}"><i class="mi-history"></i>${view.versionHistory}</a>
              </li>
           </ul>
        </div>
      </td>
      <td class="var-width">
${titleCell(row, view, href)}</td>
      <td>${raw(row.module)}</td>
        </tr>
\t\t`;
}

/** The row shown when no draft is listed. */
function noDraftsRow(rb: RbLookup): SafeHtml {
  return html`
      <tr>
        <td colspan="3" class="noResults">
\t${label(rb, 'sitemanager.drafts.nodrafts')}
        </td>
      </tr>
\t  `;
}

/** The drafts the session user may see: all for a site admin or S2, else those with an editor or author verdict. */
function listedRows(ctx: ScreenContext, rows: readonly DraftRow[]): SafeHtml {
  // The view's listFind of `Admin;<privateUserPoolID>;0` and of `S2` in `session.mura.memberships`.
  const siteAdminOrS2 = ctx.req.isSiteAdmin || ctx.req.isS2;
  const listed = rows.filter((row) => siteAdminOrS2 || LISTING_VERDICTS.includes(row.verdict.toLowerCase()));
  if (listed.length === 0) return noDraftsRow(ctx.rb);
  const view = rowViewOf(ctx);
  return html`${listed.map((row) => draftRow(row, view))}`;
}

/** The view body, whitespace as ACF emits it: the space after the header row is legacy's. */
function draftBody(ctx: ScreenContext, data: DraftData): SafeHtml {
  const { rb } = ctx;
  return html`
\t<h1>${label(rb, 'sitemanager.drafts')}</h1>
\t<table class="mura-table-grid">
    <tr>
      <th class="actions"></th>
      <th class="var-width">${label(rb, 'sitemanager.drafts.title')}</th>
    <th>${label(rb, 'sitemanager.drafts.contenttype')}</th>
    </tr> ${listedRows(ctx, data.rows)}
</table>
`;
}

/** The drafts table inside the shell, with the Site Manager script of `js.cfm`. */
function renderDrafts(ctx: ScreenContext, data: DraftData): ShellView {
  return { body: draftBody(ctx, data), ajax: carchJs(ctx, ctx.req.item) };
}

/** The `cArch.draft` admin page. */
export const draftScreen: PageScreen<DraftData> = Object.freeze({
  circuit: 'carch',
  action: 'draft',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  redirect: draftRedirect,
  load: loadDrafts,
  render: renderDrafts,
});
