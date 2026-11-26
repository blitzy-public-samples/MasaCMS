// Usage Report panel of the content edit form (`admin/core/views/carch/form/dsp_panel_usage.cfm`), server-only.
import { cfEq, cfLsDateFormat, cfToBoolean } from '@opt2/platform/legacy-compat';
import { parseLegacyDate } from '@/lib/dates';
import { raw } from '@/lib/html';
import { structOf, structText, structValue, type CarchStruct } from '../model';
import { dspZoom } from '../partials/zoom';
import type { EditFormInput, PanelResult } from './custom-tags';

// The markup is the include's bytes as ACF 2023 emits them: CFML comments are dropped and the text around them joins,
// and the whitespace-only text between the loop's opening tags prints nothing, since the output before it ends in
// whitespace. Labels, row values and dates are written unencoded, as legacy writes them.

/** What the panel reads for each row: its label lookup, the request for dspZoom and the session date format. */
interface UsageScope {
  readonly ctx: EditFormInput['ctx'];
  readonly dateKeyFormat: string;
  readonly locale: string;
}

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The struct array under `key`; throws unless the edit model holds one. */
function structsAt(struct: CarchStruct, key: string): readonly CarchStruct[] {
  const value = structValue(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`The content edit model holds no ${key} rows`);
  return value;
}

/** An admin label, unencoded. */
const label = (scope: UsageScope, key: string): string => scope.ctx.rb.rbKey(key);

/** `LSDateFormat(row[key], session.dateKeyFormat)` under the session locale: `''` for NULL or blank text. */
function lsDate(scope: UsageScope, row: CarchStruct, key: string): string {
  const text = structText(row, key);
  if (text.trim() === '') return '';
  const date = parseLegacyDate(text);
  if (date === null) throw new RangeError(`The value ${text} cannot be converted to a date.`);
  // session.dateKeyFormat's `DD` prints the day of the year (10/302/2026), as legacy shows it.
  return cfLsDateFormat(date, scope.dateKeyFormat, scope.locale);
}

/** Display cell: Yes when displayed and approved, the display window when scheduled and approved, otherwise No. */
function displayCell(scope: UsageScope, row: CarchStruct): string {
  const display = structText(row, 'display');
  // CFML `and` short-circuits, so `approved` is read only where legacy reads it.
  const approved = (): boolean => cfToBoolean(structText(row, 'approved'));
  if (cfToBoolean(display) && cfEq(display, '1') && approved()) return label(scope, 'sitemanager.yes');
  if (cfEq(display, '2') && approved()) {
    return `${lsDate(scope, row, 'displaystart')} - ${lsDate(scope, row, 'displaystop')}`;
  }
  return label(scope, 'sitemanager.no');
}

/** Edit and version-history links, or their disabled items when the node verdict is `none`. */
function actionItems(scope: UsageScope, row: CarchStruct, verdict: string): string {
  const history = label(scope, 'sitemanager.versionhistory');
  if (cfEq(verdict, 'none')) {
    return `<li class="edit disabled">${label(scope, 'sitemanager.edit')}</li><li class="version-history disabled">${history}</li>`;
  }
  const value = (key: string): string => structText(row, key);
  const target =
    `&contentid=${value('contentid')}&type=${value('type')}&parentid=${value('parentid')}` +
    `&topid=${value('contentid')}&siteid=${value('siteid')}&moduleid=${value('moduleid')}`;
  return (
    `<li class="edit"><a title="${label(scope, 'sitemanager.content.fields.edit')}" ` +
    `href="./?muraAction=cArch.edit&contenthistid=${value('contenthistid')}${target}"><i class="mi-pencil"></i></a></li>` +
    `<li class="version-history"><a title="${history}" href="./?muraAction=cArch.hist${target}">` +
    '<i class="mi-history"></i></a></li>'
  );
}

/** One table row: the crumb zoom, display, last update and actions, through the whitespace before `</cfloop>`. */
function usageRow(scope: UsageScope, row: CarchStruct): string {
  const crumbdata = structsAt(row, 'crumbdata');
  const verdict = structText(row, 'verdict');
  return `
                  <tr>
                  <td class="var-width">${dspZoom(scope.ctx, { crumbdata })}</td>
          \t\t<td>
          \t    ${displayCell(scope, row)}</td>
          \t\t<td>${lsDate(scope, row, 'lastupdate')}</td>
                  <td nowrap class="actions"><ul>${actionItems(scope, row, verdict)}</ul></td>
                  </tr>
             \x20`;
}

/** The usage label and table, from the `cfif` body through the whitespace before `<cfelse>`. */
function usageTable(scope: UsageScope, rows: readonly CarchStruct[]): string {
  return `
              <label>${label(scope, 'sitemanager.content.fields.usagedescription')}:</label>
              <table class="mura-table-grid" id="table__usage__report">
              <tr>
                <th class="var-width">${label(scope, 'sitemanager.content.fields.title')}</th>
                <th>${label(scope, 'sitemanager.content.fields.display')}</th>
                <th>${label(scope, 'sitemanager.content.fields.update')}</th>
                <th class="actions">&nbsp;</th>
              </tr>
              \x20${rows.map((row) => usageRow(scope, row)).join('')}
             </table>
          \x20`;
}

/** The not-used notice naming the content type in lower case, through the whitespace before `</cfif>`. */
function emptyUsage(scope: UsageScope, contentType: string): string {
  const { rb } = scope.ctx;
  const typeLabel = rb.rbKey(`sitemanager.content.type.${contentType}`).toLowerCase();
  const message = rb.messageFormat(rb.rbKey('sitemanager.content.fields.nousage'), typeLabel);
  return `
               <div class="help-block-empty">${message}</div>
         \x20`;
}

/**
 * Renders the Usage Report panel of a saved Component or Form from the edit model's `rc.rsUsage` (`getUsage` rows,
 * each with its `crumbdata` and node `verdict`) and `rc.contentBean`. The markup runs from the newline after the
 * include's `<cfoutput>` through its closing `</script> `.
 */
export function renderPanelUsage(input: EditFormInput): PanelResult {
  const { ctx, req, data } = input;
  const scope: UsageScope = { ctx, dateKeyFormat: req.session.dateKeyFormat, locale: req.session.locale };
  const rows = structsAt(data.rc, 'rsUsage');
  const tabLabel = label(scope, 'sitemanager.content.tabs.usagereport');
  const controls =
    rows.length > 0 ? usageTable(scope, rows) : emptyUsage(scope, structText(structOf(data.rc, 'contentBean'), 'type'));
  const markup = `
<div class="mura-panel panel">
  <div class="mura-panel-heading" role="tab" id="heading-usagereport">
    <h4 class="mura-panel-title">
      <a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-usagereport" aria-expanded="false" aria-controls="panel-usagereport">${tabLabel}</a>
    </h4>
  </div>
    <div id="panel-usagereport" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-usagereport" aria-expanded="false" style="height: 0px;">
      <div class="mura-panel-body">
    <span id="extendset-container-tabusagereporttop" class="extendset-container"></span>

    <div class="mura-control-group">


      <div id="usage__totals"></div>
     \x20
     \x20
      <div class="bigui" id="bigui__usage" data-label="${rows.length > 0 ? 'See Usage Details' : ''}">
        <div class="bigui__title">${tabLabel}</div>
        <div class="bigui__controls">

          <div class="mura-control-group">
         \x20${controls}

          </div>\x20


        </div>
      </div>\x20
    </div>\x20

    <span id="extendset-container-usagereport" class="extendset-usagereport"></span>
    <span id="extendset-container-tabusagereportbottom" class="extendset-container"></span>

    </div>
  </div>
</div>\x20


<script type="text/javascript">
  var showUsageTotal = function(){
    var usageStr = 'Not used';
    var usageTotal = ${rows.length};
    if (usageTotal == 1){
      usageStr = "Used in 1 location";
    } else if (usageTotal > 1) {
      usageStr = "Used in " + usageTotal + " locations";
    }
    $('#usage__totals').html(usageStr);
  }

  showUsageTotal();
</script>\x20`;
  return { html: raw(markup), tabId: 'tabUsagereport', tabLabel };
}
