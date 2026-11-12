// The `csettings.list` (Global Settings) page: controller `list()` and the view `csettings/list.cfm` (server-only).
import { cfEq, cfLsDateFormat, javaTrim } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/programs-sites';
import { parseLegacyDate } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, encodeJs, html, join, raw, type SafeHtml } from '@/lib/html';
import { setSessionMuraValue } from '@/lib/request-context';
import type { PageScreen, Rc, ScreenContext } from '../registry';

type SiteListItem = components['schemas']['SiteListItem'];

/** The sites `load` read, in the order programs-sites returned them. */
export interface SiteListData {
  readonly sites: readonly SiteListItem[];
}

const UPDATE_SITES_CONTEXT = 'updatesites';
const UPDATE_CORE_CONTEXT = 'updatecore';
const NEW_PLUGIN_CONTEXT = 'newplugin';

// ACF whitespace management drops CFML comments and writes a whitespace-only text run between tags or expressions as
// one space, or as nothing when the output already ends in whitespace (char <= U+0020, as Java trim counts it).
/** What a whitespace-only run of the view adds after `output`. */
function cfSpace(output: string): string {
  return output === '' || output.charCodeAt(output.length - 1) <= 0x20 ? '' : ' ';
}

/** `markup` followed by what the whitespace-only run after it adds. */
const spaced = (markup: SafeHtml): SafeHtml => join([markup, raw(cfSpace(markup.value))]);

/** `rc[name]`, or `fallback` as the controller's and view's `param` default. */
const param = (rc: Rc, name: string, fallback = ''): string => rc[name] ?? fallback;

/** utility `displayErrors(errors)` inside the view's error alert: every message but `siteID`'s, raw. */
export function renderLegacyErrors(errors: Readonly<Record<string, string>>): SafeHtml {
  const keys = Object.keys(errors);
  // The function's leading whitespace follows the alert's `<span>`.
  let out = ' ';
  keys.forEach((key, index) => {
    if (key.toLowerCase() === 'siteid') return;
    out += errors[key] ?? '';
    out += cfSpace(out);
    if (keys.length > index + 1) out += `<br>${cfSpace('<br>')}`;
  });
  return raw(`<div class="alert alert-error"><span>${out}</span></div>`);
}

/** `getCurrentUser().getValue("errors")` when it is a non-empty struct. */
function sessionErrors(ctx: ScreenContext): Record<string, string> | undefined {
  const { mura } = ctx.req.session;
  const value = Object.entries(mura).find(([key]) => key.toLowerCase() === 'errors')?.[1];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).map(([key, message]): [string, string] => [key, String(message ?? '')]);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The toolbar's Update Core Files group, shown while auto-updates are allowed. */
function updateCoreGroup(ctx: ScreenContext): SafeHtml {
  const settings = legacySettings();
  if (!settings.allowAutoUpdates) return html``;
  const mssqlNote = cfEq(settings.dbType, 'mssql')
    ? raw(
        '\\n\\nIf your are using MSSQL you must uncheck Maintain Connections in your CF administrator datasource settings before proceeding. You may turn it back on after the update is complete.',
      )
    : null;
  return html`
\t\t\t\t<div class="btn-group">
\t\t\t\t\t
\t\t\t\t\t\t\t\t<a class="btn" href="#" onclick="confirmDialog('WARNING: Do not update your core files unless you have backed up your current Masa CMS install.${mssqlNote}',function(){actionModal('./?muraAction=cSettings.list&action=updateCore${ctx.csrf.render(UPDATE_CORE_CONTEXT, 'url')}')});return false;"><i class="mi-cloud-download"></i> Update Core Files</a>
\t\t\t\t\t
\t\t\t\t</div>
\t\t\t`;
}

/** The `mura-header` with its toolbar. */
function header(ctx: ScreenContext, byOrderNo: boolean): SafeHtml {
  const [sortBy, label] = byOrderNo ? ['site', 'Site Name'] : ['orderno', 'Bind Order'];
  return html`
<div class="mura-header">
\t<h1>Global Settings</h1>

\t<div class="nav-module-specific btn-toolbar">
\t\t${updateCoreGroup(ctx)}
\t\t\t<div class="btn-group">
\t\t\t\t
\t\t\t\t\t\t\t\t<a class="btn" href="./?muraAction=cSettings.list&siteSortBy=${raw(sortBy)}"><i class="mi-list-alt"></i> List Sites by ${raw(label)}</a>
\t\t\t\t
\t\t\t</div>
\t\t</div>

</div> <!-- /.mura-header -->

`;
}

/** The raw `rc.sitesUpdated` message when it holds more than whitespace. */
function sitesUpdatedMessage(rc: Rc): SafeHtml | null {
  const message = rc.sitesUpdated;
  if (message === undefined || javaTrim(message) === '') return null;
  // Legacy echoes the request value unencoded.
  return spaced(raw(message));
}

/** Column flags of the Current Sites table. */
interface TableView {
  /** `siteSortBy` is `orderno`: the Bind Order column and its button. */
  readonly byOrderNo: boolean;
  /** configBean mode `staging`: each row's Deploy action. */
  readonly staging: boolean;
  /** Staging while not sorting by bind order: the batch-deploy columns and their button. */
  readonly deployColumns: boolean;
}

// configBean has no deployMode default and the settings template sets none, so `getValue('deployMode')` is '' and
// the staging Deploy action always takes its non-bundle form.
/** The row's Deploy action of a staging install. */
function deployAction(item: SiteListItem): SafeHtml {
  return html`
\t\t\t\t\t\t\t\t\t\t\t<li class="deploy"><a href="?muraAction=cSettings.list&action=deploy&siteid=${raw(item.siteid)}" onclick="return confirmDialog('Deploy ${raw(encodeJs(item.site))} to production?',this.href);"><i class="mi-download"></i>Deploy</a></li>
\t\t\t\t\t\t\t\t\t\t`;
}

/** The row's Delete action, which legacy serves; every site but `default` has it. */
function deleteAction(ctx: ScreenContext, item: SiteListItem): SafeHtml {
  const warning = `WARNING: A deleted site and all of its files cannot be recovered. Are you sure that you want to delete the site named '${(item.site ?? '').toUpperCase()}'?`;
  return html`
\t\t\t\t\t\t\t\t\t\t<li class="delete"><a href="#" onclick="confirmDialog('${raw(encodeJs(warning))}',function(){actionModal('./?muraAction=cSettings.updateSite&action=delete&siteid=${raw(item.siteid)}${ctx.csrf.render(item.siteid, 'url')}')});return false;"><i class="mi-trash"></i>Delete</a></li>
\t
\t\t\t\t\t\t\t\t\t`;
}

/** The Bind Order cell: positions 1 to `count`, the row's own selected. */
function bindOrderCell(item: SiteListItem, row: number, count: number): SafeHtml {
  const options = Array.from(
    { length: count },
    (_, index) => html`
\t\t\t\t\t\t\t\t\t<option value="${index + 1}" ${index + 1 === row ? raw('selected') : null}>${index + 1}</option>
\t\t\t\t\t\t\t\t\t`,
  );
  return html`
\t\t\t\t\t\t\t<td><select name="orderno" class="dropdown">
\t\t\t\t\t\t\t\t\t${options}
\t\t\t\t\t\t\t\t</select>
\t\t\t\t\t\t\t\t<input type="hidden" value="${raw(item.siteid)}" name="orderid" />
\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t`;
}

/** The Batch Deploy select and the `LSDateFormat` of the last deployment, or `Never`. */
function deployCells(ctx: ScreenContext, item: SiteListItem): SafeHtml {
  const deployed = parseLegacyDate(item.lastDeployment);
  // Plain LSDateFormat: formatDateField's blanking of far-future dates belongs to date inputs, not this cell.
  const lastDeployment =
    deployed === null
      ? raw('\n\t\t\t\t\t\t\t\t\tNever\n\t\t\t\t\t\t\t\t')
      : spaced(raw(` ${cfLsDateFormat(deployed, ctx.req.session.dateKeyFormat)}`));
  const selected = (on: boolean): SafeHtml | null => (on ? raw('selected') : null);
  return html`
\t\t\t\t\t\t\t<td><select name="deploy" class="dropdown">
\t\t\t\t\t\t\t\t\t<option value="1" ${selected(item.deploy === 1)}>Yes</option>
\t\t\t\t\t\t\t\t\t<option value="0" ${selected(item.deploy !== 1)}>No</option>
\t\t\t\t\t\t\t\t</select></td>
\t\t\t\t\t\t\t<td>${lastDeployment}</td>
\t\t\t\t\t\t`;
}

/** One row of the Current Sites table; the site name is echoed unencoded, as legacy echoes it. */
function siteRow(ctx: ScreenContext, item: SiteListItem, row: number, count: number, view: TableView): SafeHtml {
  const siteid = raw(item.siteid);
  const domain = item.domain ?? '';
  const domainCell = domain === '' ? raw('\n\t\t\t\t\t\t\t\t-\n\t\t\t\t\t\t\t') : spaced(raw(encodeHtml(domain)));
  return html`
\t\t\t\t\t<tr>
\t\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t\t<li class="edit"><a href="./?muraAction=cSettings.editSite&siteid=${siteid}"><i class="mi-pencil"></i>Edit</a></li>
\t\t\t\t\t\t\t\t\t${view.staging ? deployAction(item) : null}${cfEq(item.siteid, 'default') ? null : deleteAction(ctx, item)}
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t</div>
\t\t\t\t\t\t</td>
\t\t\t\t\t\t${view.byOrderNo ? bindOrderCell(item, row, count) : null}
\t\t\t\t\t\t<td class="var-width"><a title="Edit" href="./?muraAction=cSettings.editSite&siteid=${siteid}">${raw(item.site ?? '')}</a></td>
\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t${domainCell}
\t\t\t\t\t\t</td>
\t\t\t\t\t\t${view.deployColumns ? deployCells(ctx, item) : null}
\t\t\t\t\t</tr>
\t\t\t\t\t`;
}

/** The Current Sites table with its form actions, hidden sort field and `updatesites` CSRF fields. */
function sitesForm(ctx: ScreenContext, sites: readonly SiteListItem[], siteSortBy: string, view: TableView): SafeHtml {
  const rows = sites.map((item, index) => siteRow(ctx, item, index + 1, sites.length, view));
  const bindOrderHeader = view.byOrderNo
    ? raw('\n\t\t\t\t\t\t\t<th>Bind Order</th>\n\t\t\t\t\t\t')
    : null;
  const deployHeaders = view.deployColumns
    ? raw('\n\t\t\t\t\t\t\t<th>Batch&nbsp;Deploy</th>\n\t\t\t\t\t\t\t<th>Last&nbsp;Deployment</th>\n\t\t\t\t\t\t')
    : null;
  const button = view.byOrderNo
    ? raw(
        '\n\t\t\t\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="document.form1.submit();"><i class="mi-check"></i> Update Bind Order</button>\n\t\t\t\t\t\t\t',
      )
    : raw(
        '\n\t\t\t\t\t\t\t\t<button type="button" class="btn" onclick="document.form1.submit();"><i class="mi-check"></i>Update Auto Deploy Settings</button>\n\t\t\t\t\t\t\t',
      );
  const actions =
    view.byOrderNo || view.deployColumns
      ? html`
\t\t\t\t\t<div class="mura-actions">
\t\t\t\t\t\t<div class="form-actions">
\t\t\t\t\t\t\t${button}
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>
\t\t\t\t`
      : null;
  return html`
\t\t\t<form novalidate="novalidate" name="form1" id="form1" action="./?muraAction=csettings.list" method="post">
\t\t\t\t<table class="mura-table-grid">
\t\t\t\t\t<tr>
\t\t\t\t\t\t<th class="actions"></th>
\t\t\t\t\t\t${bindOrderHeader}
\t\t\t\t\t\t<th class="var-width">Site</th>
\t\t\t\t\t\t<th>Domain</th>
\t\t\t\t\t\t${deployHeaders}
\t\t\t\t\t\t
\t\t\t\t\t</tr>
\t\t\t\t\t${rows}
\t\t\t\t</table>

\t\t\t\t${actions}
\t\t\t\t\t<input type="hidden" name="siteSortBy" value="${raw(encodeHtmlAttr(siteSortBy))}" />
\t\t\t\t\t${spaced(ctx.csrf.render(UPDATE_SITES_CONTEXT, 'form'))}
\t\t\t</form>`;
}

/** The Install Plugin forms, which post to legacy-served plugin actions. */
function installPluginForms(ctx: ScreenContext): SafeHtml {
  const csrf = ctx.csrf.render(NEW_PLUGIN_CONTEXT, 'form');
  return html`
\t\t<div class="mura-file-selector">
\t\t\t<div class="mura-control-group">
\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t<div class="mura-input-set" data-toggle="buttons-radio">
\t\t\t\t\t  <button type="button" class="btn btn-default active" data-toggle="button" name="installType" value="Upload" id="apptypefile"><i class="mi-upload"></i> Via Upload</button>
\t\t\t\t\t  <button type="button" class="btn btn-default" name="installType" value="URL" id="apptypeurl"><i class="mi-globe"></i> Via URL</button>
\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t</div>

\t\t\t<div id="appzip" class="fileTypeOption">
\t\t\t\t<form novalidate="novalidate" name="frmNewPlugin" action="./?muraAction=cSettings.deployPlugin" enctype="multipart/form-data" method="post" onsubmit="return validateForm(this);">
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t  <label>Plugin File</label>
\t\t\t\t\t\t\t<input name="newPlugin" type="file" data-required="true" message="Please select a plugin file.">
\t\t\t\t\t</div>
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t\t\t\t<button type="submit" class="btn" /><i class="mi-bolt"></i> Deploy</button>
\t\t\t\t\t\t\t\t${csrf}
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>
\t\t\t\t</form>
\t\t\t</div>
\t\t\t<div id="appurl" class="fileTypeOption" style="display:none;">
\t\t\t\t<form name="frmNewPluginFROMURL" action="./?muraAction=cSettings.deployPlugin" method="post" onsubmit="return validateForm(this);">
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>Plugin URL</label>
\t\t\t\t\t\t\t<input type="text" name="newPlugin"  type="url" data-required="true" placeholder="http://www.domain.com/plugin.zip" message="Please enter the url for your plugin file" value="">
\t\t\t\t\t</div>
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t\t\t<button type="submit" class="btn" /><i class="mi-bolt"></i> Deploy</button>
\t\t\t\t\t\t\t${csrf}
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>
\t\t\t\t</form>
\t\t\t\t</div>
\t\t\t</div>
\t\t<script>
\t\t\t$(function(){
\t\t\t\t$("#apptypefile").click(
\t\t\t\t\tfunction(){
\t\t\t\t\t\t\t$(this).addClass("active").removeClass("focus").siblings().removeClass("active").removeClass("focus");
\t\t\t\t\t\t\t$("#appurl").hide()
\t\t\t\t\t\t\t$("#appzip").show()
\t\t\t\t\t}
\t\t\t\t);
\t\t\t\t$("#apptypeurl").click(
\t\t\t\t\tfunction(){
\t\t\t\t\t\t\t$(this).addClass("active").removeClass("focus").siblings().removeClass("active").removeClass("focus");
\t\t\t\t\t\t\t$("#appurl").show()
\t\t\t\t\t\t\t$("#appzip").hide()
\t\t\t\t\t}
\t\t\t\t);
\t\t\t})
\t\t</script>

\t   `;
}

const JAVA_DISABLED = raw(
  '\n\n    <div class="help-block-empty">\n      Java is disabled. Plugin installation is unavailable.\n    </div>\n\n      ',
);

// Installed plugins live in `tplugins`, which stays with the legacy plugin runtime and has no target store, so the
// tab always takes its no-plugins branch.
const NO_PLUGINS = raw(
  '\n\t\t\t\t<div class="help-block-empty">\n\t\t\t\t\tThere are currently no installed plugins.\n\t\t\t\t</div>\n\t\t\t',
);

/** The tabbed Current Sites and Plugins block. */
function tabs(ctx: ScreenContext, sites: readonly SiteListItem[], siteSortBy: string, view: TableView): SafeHtml {
  const install = legacySettings().javaEnabled ? installPluginForms(ctx) : JAVA_DISABLED;
  return html`

\t<div class="block block-constrain">
\t\t<ul class="mura-tabs nav-tabs" data-toggle="tabs">
\t\t\t<li class="active"><a href="#tabCurrentsites" onclick="return false;"><span>Current Sites</span></a></li>
\t\t\t<li><a href="#tabPlugins" onclick="return false;"><span>Plugins</span></a></li>
\t\t</ul>
\t<div class="tab-content block-content">
\t\t<div id="tabCurrentsites" class="tab-pane active">

\t\t\t\t\t<!-- start tab -->
\t\t\t\t\t\t<div class="block block-bordered">
\t\t\t\t\t\t\t<!-- block header -->
\t\t\t\t\t\t\t<div class="block-header">
\t\t\t\t\t\t\t\t<h3 class="block-title">Current Sites</h3>
\t\t\t\t\t\t\t</div> <!-- /.block header -->
\t\t\t\t\t\t\t<div class="block-content">
${sitesForm(ctx, sites, siteSortBy, view)}

\t\t\t\t</div> <!-- /.block-content -->
\t\t\t</div> <!-- /.block-bordered -->
\t\t</div> <!-- /.tab-pane -->

\t\t<div id="tabPlugins" class="tab-pane">

\t\t<div class="block block-bordered">
\t\t\t<!-- block header -->
\t\t<div class="block-header">
\t\t\t<h3 class="block-title">Plugins</h3>
\t\t\t</div> <!-- /.block header -->
\t\t\t<div class="block-content">

\t\t<h2>Install Plugin</h2>
\t\t${install}${NO_PLUGINS}
\t\t\t</div> <!-- /.block-content -->
\t\t</div> <!-- /.block-bordered -->
\t</div> <!-- /.tab-pane -->
\t\t<div class="load-inline tab-preloader"></div>
\t\t<script>$('.tab-preloader').spin(spinnerArgs2);</script>
\t\t</div> <!-- /.block-content.tab-content -->
</div> <!-- /.block-constrain -->

`;
}

/** The CSRF contexts the view renders: the sites form, Update Core, the plugin forms and each deletable site. */
function csrfContexts(sites: readonly SiteListItem[]): string[] {
  const { allowAutoUpdates, javaEnabled } = legacySettings();
  return [
    UPDATE_SITES_CONTEXT,
    ...(allowAutoUpdates ? [UPDATE_CORE_CONTEXT] : []),
    ...(javaEnabled ? [NEW_PLUGIN_CONTEXT] : []),
    ...sites.filter((item) => !cfEq(item.siteid, 'default')).map((item) => item.siteid),
  ];
}

// `action=updateCore` runs the legacy auto-updater; the registry's not-built variants keep it from reaching here.
/** The `csettings.list` page without the registry fields `index.ts` adds. */
export const listScreen: Omit<
  PageScreen<SiteListData>,
  'gate' | 'owner' | 'circuit' | 'action' | 'mode' | 'variant'
> = Object.freeze({
  redirect: (ctx: ScreenContext) =>
    'refresh' in ctx.req.rc ? ({ kind: 'redirect', action: 'cSettings.list', path: './' } as const) : undefined,

  async load(ctx: ScreenContext): Promise<SiteListData> {
    const { rc } = ctx.req;
    const sortBy = param(rc, 'siteSortBy', 'site');
    // Legacy validates `updatesites` tokens on every request; without a token the check fails and nothing is saved.
    if (param(rc, 'csrf_token') !== '') {
      const json = {
        orderno: param(rc, 'orderno'),
        orderID: param(rc, 'orderID'),
        deploy: param(rc, 'deploy'),
        csrf_token: param(rc, 'csrf_token'),
        csrf_token_expires: param(rc, 'csrf_token_expires'),
        sortBy,
        sortDirection: 'asc',
      };
      okBody(await ctx.gateway.programsSites.call('post', '/v1/sites/order', { json }), 'programs-sites', 'saveSiteOrder');
    }
    const listed = await ctx.gateway.programsSites.listSites({ sortBy });
    return { sites: okBody(listed, 'programs-sites', 'listSites') };
  },

  async render(ctx: ScreenContext, { sites }: SiteListData) {
    const siteSortBy = param(ctx.req.rc, 'siteSortBy', 'site');
    const byOrderNo = cfEq(siteSortBy, 'orderno');
    const staging = cfEq(legacySettings().mode, 'staging');
    const view: TableView = { byOrderNo, staging, deployColumns: staging && !byOrderNo };
    await ctx.csrf.prefetch(csrfContexts(sites));
    const errors = sessionErrors(ctx);
    // The view clears the errors it read on every render: `getCurrentUser().setValue("errors", "")`.
    setSessionMuraValue(ctx.req, 'errors', '');
    const alert = errors === undefined ? null : html`
\t\t${renderLegacyErrors(errors)}
\t\t`;
    return {
      body: html`${header(ctx, byOrderNo)}${sitesUpdatedMessage(ctx.req.rc)}${alert}${tabs(ctx, sites, siteSortBy, view)}`,
    };
  },
});
