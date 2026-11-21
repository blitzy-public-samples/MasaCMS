// Remote branch of `cfeed/edit.cfm` (lines 883-1151): the remote feed form and its compact head script (server-only).
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { encodeHtmlAttr, encodeJs, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { selectLayout, type ShellView } from '@/shell/document';
import type { ScreenContext } from '../registry';
import { renderFeedCategoriesNest } from './categories-nest';
import { displayErrors } from './common';
import type { FeedEditModel, FeedView } from './edit-model';
import { renderCfeedSecondaryMenu } from './secondary-menu';
import { renderFeedUsageTab } from './tab-usage';

// The template literals below hold the bytes ACF 2023 emits for the view: CFML comments vanish, whitespace-only text
// between two CFML tags prints nothing, and every other text run prints as written.

/** Inputs of {@link renderRemoteFeedEdit}. */
export interface RemoteFeedEditOptions {
  /** `listLast(request.action, '.')`: `edit`, or `update` when a rejected save re-renders the form. */
  readonly fuseaction: string;
}

/** What the branch hands the shell: the view body and, in compact display, its `cfhtmlhead` text. */
export type RemoteFeedEditView = Pick<ShellView, 'body' | 'htmlHead'>;

const MAX_ITEMS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '25', '50', '100',
] as const;
/** The `ALL` option's value, which the remote branch labels in capitals. */
const ALL_ITEMS = '100000';
const VERSIONS = ['RSS 0.920', 'RSS 2.0', 'Atom'] as const;

const CHECKED = raw('checked');
const SELECTED = raw('selected');

// Legacy omits the `#` delimiters here, so the expression is printed as text rather than evaluated.
const IMPORT_LOCATION_TITLE = raw("application.rbFactory.getKeyValue(session.rb,'collections.importlocation')");

/** The `headerStr` script compact display hands `cfhtmlhead` (edit.cfm 1130-1149). */
const COMPACT_HEAD = raw(`
<script type="text/javascript">
jQuery(document).ready(function(){
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
});
</script>
`);

/** What every part of the form reads. */
interface Parts {
  readonly rc: AdminRequest['rc'];
  readonly rb: RbLookup;
  readonly model: FeedEditModel;
  readonly feed: FeedView;
  readonly compact: boolean;
}

/** `rc[name]`, `''` when the request does not hold it. */
const rcValue = (rc: AdminRequest['rc'], name: string): string => rc[name] ?? '';

/** An admin label, unencoded as legacy writes it. */
const label = (rb: RbLookup, key: string): SafeHtml => raw(rb.rbKey(key));

/** The Yes and No radios of `name`, each input line indented as the source indents it. */
function radioPair(p: Parts, name: string, on: boolean, firstIndent: string, secondIndent: string): SafeHtml {
  return html`${raw(firstIndent)}<input name="${name}" type="radio" value="1" ${on && CHECKED}>${label(p.rb, 'collections.yes')}
\t\t\t\t</label>
\t\t\t\t<label class="radio inline">
${raw(secondIndent)}<input name="${name}" type="radio" value="0" ${!on && CHECKED}>${label(p.rb, 'collections.no')}`;
}

/**
 * The cFeed menu at its include point. The Remote branch never sets `endpoint`, so a saved collection stored as Local
 * fails in the menu's View Feed link exactly as legacy does.
 * @throws Error When the menu would print the feed API endpoint.
 */
function secondaryMenu(req: AdminRequest, rb: RbLookup, feed: FeedView, fuseaction: string): SafeHtml {
  if (fuseaction.toLowerCase() !== 'list' && !feed.isNew && cfEq(feed.type, 'Local')) {
    throw new Error('Variable ENDPOINT is undefined.');
  }
  const menuFeed = { feedId: feed.feedID, type: feed.type, isNew: feed.isNew, channelLink: feed.channelLink };
  return renderCfeedSecondaryMenu(req, rb, { fuseaction, feed: menuFeed });
}

/** The `mura-header` block, the alerts and the plugin message span. */
function header(req: AdminRequest, p: Parts, fuseaction: string): SafeHtml {
  const title = label(p.rb, p.feed.isNew ? 'collections.createremotefeed' : 'collections.editremotefeed');
  const menu = p.compact ? '' : html`\n\t${secondaryMenu(req, p.rb, p.feed, fuseaction)}\n`;
  const errors =
    Object.keys(p.model.errors).length > 0
      ? html`\n\t<div class="alert alert-error"><span>${displayErrors(p.model.errors)}</span></div>\n`
      : '';
  const globalNotice = label(p.rb, 'sitemanager.content.globallyappliednotice');
  const notice = p.compact ? html`\n\t<div class="alert alert-info"><span>${globalNotice}</span></div>\n` : '';
  return html`

<div class="mura-header">
\t\t
\t\t\t<h1>${title}</h1>
\t\t${menu}

</div> <!-- /.mura-header -->

${errors}${notice}

<span id="msg">
${raw(p.model.pluginMessage)}
</span>
`;
}

/** One `<option>` of a loop, selected by CFML `eq` against the stored value. */
function option(value: string, stored: string): SafeHtml {
  return html`\n\t\t\t\t\t<option value="${raw(value)}" ${cfEq(stored, value) && SELECTED}>${raw(value)}</option>\n\t\t\t\t\t`;
}

/** The authentication select, shown only when a proxy server or proxy user is configured. */
function authType(p: Parts): SafeHtml | '' {
  const { hasProxyServer, hasProxyUser } = p.model;
  if (!hasProxyServer && !hasProxyUser) return '';
  const stored = p.feed.authType;
  const choice = (value: string, indent: string): SafeHtml =>
    html`${raw(indent)}<option value="${value}" ${cfEq(stored, value) && SELECTED}>${value}</option>`;
  const proxy = hasProxyServer ? html`\n${choice('PROXY', '\t\t\t\t\t\t\t')}\n\t\t\t\t\t\t` : '';
  const ntlm = hasProxyUser ? html`\n${choice('NTLM', '\t\t\t\t\t\t\t')}\n\t\t\t\t\t\t` : '';
  return html`
\t\t\t\t\t<label>${label(p.rb, 'collections.authtype')}</label>
\t\t\t\t\t<select name="authtype">
\t\t\t\t\t\t<option value="DEFAULT">DEFAULT</option>
${choice('BASIC', '\t\t\t\t\t\t')}
\t\t\t\t\t\t${proxy}${ntlm}
\t\t\t\t\t</select>
\t\t\t\t`;
}

/** The Basic pane: name, URL, view-all link and label, active, public, max items, version, auth type, CSS class. */
function basicTab(p: Parts): SafeHtml {
  const { feed, rb } = p;
  const viewAll = p.model.useLayoutManager
    ? ''
    : html`
\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label(rb, 'collections.viewalllink')}</label>
\t\t\t\t<input name="viewalllink" type="text" value="${raw(encodeHtmlAttr(feed.viewAllLink))}" maxlength="255">
\t\t\t</div>
\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label(rb, 'collections.viewalllabel')}</label>
\t\t\t\t<input name="viewalllabel" type="text" value="${raw(encodeHtmlAttr(feed.viewAllLabel))}" maxlength="100">
\t\t\t</div>
\t\t\t`;
  const cssClass = p.model.useLayoutManager
    ? ''
    : html`
\t\t\t<div class="mura-control-group">
\t\t\t<label>${label(rb, 'collections.cssclass')}</label>
\t\t\t<input name="cssclass"  data-displayobjectparam="cssclass" type="text" value="${raw(encodeHtmlAttr(feed.cssClass))}" maxlength="255">
\t\t\t</div>
\t\t\t`;
  return html`
<div id="tabBasic" class="tab-pane active">
\t<div class="block block-bordered">
\t\t<!-- block header -->
\t\t<div class="block-header">
\t\t\t<h3 class="block-title">${label(rb, 'collections.basic')}</h3>
\t\t</div> <!-- /.block header -->
\t\t<div class="block-content">

\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${label(rb, 'collections.name')}</label>
\t\t\t\t\t<input name="name" type="text" required="true" message="${label(rb, 'collections.namerequired')}" value="${raw(encodeHtmlAttr(feed.name))}" maxlength="50" onchange="removePunctuation(this);">
\t\t\t</div>
\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${label(rb, 'collections.url')}</label>
\t\t\t\t\t<input name="channelLink" type="text" required="true" message="${label(rb, 'collections.urlrequired')}" value="${raw(encodeHtmlAttr(feed.channelLink))}">
\t\t\t</div>
\t\t\t${viewAll}
\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label(rb, 'collections.isactive')}</label>
\t\t\t\t<label class="radio inline">
${radioPair(p, 'isActive', feed.isActive, '\t\t\t\t\t', '\t\t\t\t')}
\t\t\t\t</label>
\t\t\t</div>

\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label(rb, 'collections.ispublic')}</label>
\t\t\t\t<label class="radio inline">
${radioPair(p, 'isPublic', feed.isPublic, '\t\t\t\t', '\t\t\t\t')}
\t\t\t\t</label>
\t\t\t</div>

\t\t\t

\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label(rb, 'collections.maxitems')}</label>
\t\t\t\t<select name="maxItems">
\t\t\t\t\t${MAX_ITEMS.map((m) => option(m, feed.maxItems))}
\t\t\t\t\t<option value="${ALL_ITEMS}" ${cfEq(feed.maxItems, ALL_ITEMS) && SELECTED}>ALL</option>
\t\t\t\t</select>
\t\t\t\t</div>
\t\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label(rb, 'collections.version')}</label>
\t\t\t\t<select name="version">
\t\t\t\t\t${VERSIONS.map((v) => option(v, feed.version))}
\t\t\t\t</select>

\t\t\t\t${authType(p)}
\t\t\t\t</div>
\t\t\t${cssClass}

\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.tab-pane -->

`;
}

/** The Categories pane with the `dsp_categories_nest` tree of the site's categories. */
function categorizationTab(p: Parts): SafeHtml {
  const nest = renderFeedCategoriesNest({
    nodes: p.model.categories,
    nestLevel: 0,
    feedCategoryIds: p.feed.categoryID,
    categoryIds: '',
  });
  return html`<div id="tabCategorization" class="tab-pane">
\t<div class="block block-bordered">
\t\t<!-- block header -->
\t\t<div class="block-header">
\t\t\t<h3 class="block-title">${label(p.rb, 'collections.categorization')}</h3>
\t\t</div> <!-- /.block header -->
\t\t<div class="block-content">
\t\t\t<div  class="mura-control-group">
\t\t\t\t<label>${label(p.rb, 'collections.categoryassignments')}</label>
\t\t\t\t<div id="mura-list-tree" class="mura-control">
\t\t\t\t${nest}
\t\t\t\t</div>
\t\t\t</div>
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.tab-pane -->

`;
}

/** The S2-only Import Location pane: the parent the import files under and the auto-import radios. */
function importLocationTab(p: Parts): SafeHtml {
  const { feed, rb } = p;
  // The menu title, the site id and the parent id are written unencoded, as legacy writes them.
  const location = feed.parentID === '' ? label(rb, 'collections.noneselected') : raw(p.model.parentMenuTitle);
  const siteid = raw(rcValue(p.rc, 'siteid'));
  const parentID = raw(feed.parentID);
  return html`
\t<div id="tabImportlocation" class="tab-pane">

\t\t<div class="block block-bordered">
\t\t\t<!-- block header -->
\t\t<div class="block-header">
\t\t\t<h3 class="block-title">${IMPORT_LOCATION_TITLE}</h3>
\t\t\t</div> <!-- /.block header -->
\t\t\t<div class="block-content">

\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<label>${label(rb, 'collections.importlocation')}:</label>
\t\t\t\t\t<span id="move" class="text">
\t\t\t\t\t\t\t\t"${location}"
\t\t\t\t\t\t\t&nbsp;&nbsp;<a class="btn btn-small"href="javascript:#;" onclick="javascript: feedManager.loadSiteParents('${siteid}','${parentID}','',1);return false;">${label(rb, 'collections.selectnewlocation')}</a>
\t\t\t\t\t\t\t<input type="hidden" name="parentid" value="${parentID}">
\t\t\t\t\t</span>
\t\t\t\t</div>

\t\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label(rb, 'collections.autoimport')}</label>
\t\t\t\t<label class="radio inline">
${radioPair(p, 'autoImport', feed.autoImport, '\t\t\t\t\t', '\t\t\t\t\t')}
\t\t\t\t</label>
\t\t\t\t</div>

\t\t\t</div> <!-- /.block-content -->
\t\t</div> <!-- /.block-bordered -->
\t</div> <!-- /.tab-pane -->

`;
}

/** The tab strip, labels read by `listGetAt` of the comma list, so a label holding a comma shifts the rest. */
function tabStrip(ids: readonly string[], labels: readonly string[]): SafeHtml {
  const labelList = cfListToArray(labels.join(','));
  return join(ids.map((id, index) => {
    const text = labelList[index];
    if (text === undefined) throw new RangeError(`Invalid list index ${String(index + 1)}.`);
    return html`\n\t\t<li${index === 0 && raw(' class="active"')}><a href="#${raw(id)}" onclick="return false;"><span>${raw(text)}</span></a></li>\n\t`;
  }));
}

/** Add for a new collection; otherwise Delete (full layout only), Update and, in compact display, `homeID`. */
function actionButtons(p: Parts): SafeHtml {
  const { rb } = p;
  if (rcValue(p.rc, 'feedID') === '') {
    return html`
\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="submitForm(document.forms.form1,'add');"><i class="mi-check-circle"></i>${label(rb, 'collections.add')}</button>
\t\t\t\t\t<input type=hidden name="feedID" value="">
\t\t\t\t\t<input type="hidden" name="action" value="add">
\t\t\t\t`;
  }
  const confirm = raw(encodeJs(rb.rbKey('collections.deleteremoteconfirm')));
  const remove = p.compact
    ? ''
    : html`
\t\t\t\t\t\t<button type="button" class="btn" onclick="submitForm(document.forms.form1,'delete','${confirm}');"><i class="mi-trash"></i>${label(rb, 'collections.delete')}</button>
\t\t\t\t\t`;
  const homeID = p.compact
    ? html`
\t\t\t\t\t\t<input type="hidden" name="homeID" value="${raw(encodeHtmlAttr(rcValue(p.rc, 'homeID')))}" />
\t\t\t\t\t`
    : '';
  return html`${remove}
\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="submitForm(document.forms.form1,'update');"><i class="mi-check-circle"></i>${label(rb, 'collections.update')}</button>
\t\t\t\t\t${homeID}
\t\t\t\t\t<input type=hidden name="feedID" value="${raw(p.feed.feedID)}">
\t\t\t\t\t<input type="hidden" name="action" value="update">
\t\t\t\t`;
}

/**
 * Renders the Remote branch of `cfeed/edit.cfm` for `req` (the request after the cfeed defaults) and fetches the CSRF
 * pair of the collection's id first.
 * @throws Error When legacy fails rendering it (see {@link secondaryMenu}).
 */
export async function renderRemoteFeedEdit(
  req: AdminRequest,
  ctx: ScreenContext,
  model: FeedEditModel,
  { fuseaction }: RemoteFeedEditOptions,
): Promise<RemoteFeedEditView> {
  const { rb } = ctx;
  const { rc } = req;
  const { feed } = model;
  // `selectLayout` is exactly the view's `rc.compactDisplay eq 'true'`.
  const compact = selectLayout(rc) === 'compact';
  const p: Parts = { rc, rb, model, feed, compact };
  const saved = rcValue(rc, 'feedID') !== '';
  await ctx.csrf.prefetch([feed.feedID]);

  const ids = ['tabBasic', 'tabCategorization'];
  const labels = [rb.rbKey('collections.basic'), rb.rbKey('collections.categorization')];
  let tabContent = html`${basicTab(p)}${categorizationTab(p)}`;
  if (req.isS2) {
    ids.push('tabImportlocation');
    labels.push(rb.rbKey('collections.importlocation'));
    tabContent = html`${tabContent}${importLocationTab(p)}`;
  }
  if (model.showUsageTabs && saved) {
    const usage = renderFeedUsageTab(req, rb, { feedType: feed.type, rows: model.usage });
    ids.push(usage.tabId);
    labels.push(usage.label);
    // The include prints a newline before the pane, which the partial leaves to its caller.
    tabContent = html`${tabContent}\n${usage.html}`;
  }

  const navTask = saved
    ? html`
\t\t<ul class="navTask nav nav-pills">
\t\t${compact && html`\n\t\t\t<li><a onclick="history.go(-1);">${label(rb, 'collections.back')}</a></li>\n\t\t`}
\t\t
\t\t</ul>
\t`
    : '';
  const body = html`${header(req, p, fuseaction)}
<form novalidate="novalidate" action="./?muraAction=cFeed.update&siteid=${raw(encodeUrl(rcValue(rc, 'siteid')))}" method="post" name="form1" onsubmit="return validate(this);">

<div class="block block-constrain">
\t${navTask}

<ul class="mura-tabs nav-tabs" data-toggle="tabs">
\t${tabStrip(ids, labels)}
</ul>
\t<div class="tab-content block-content">
\t\t${tabContent}
\t<div class="load-inline tab-preloader"></div>
\t<script>$('.tab-preloader').spin(spinnerArgs2);</script>

\t\t<div class="mura-actions">
\t\t\t<div class="form-actions">
\t\t\t\t${actionButtons(p)}
\t\t\t\t<input type=hidden name="instanceid" value="${raw(encodeHtmlAttr(rcValue(rc, 'instanceid')))}">
\t\t\t\t<input type="hidden" name="closeCompactDisplay" value="${raw(encodeHtmlAttr(rcValue(rc, 'compactDisplay')))}" />
\t\t\t\t<input type="hidden" name="type" value="Remote">
\t\t\t\t${ctx.csrf.render(feed.feedID, 'form')}
\t\t\t\t</div>
\t\t\t</div>

\t\t</div> <!-- /.block-content.tab-content -->
\t</div> <!-- /.block-constrain -->
</form>
`;
  return compact ? { body, htmlHead: COMPACT_HEAD } : { body };
}
