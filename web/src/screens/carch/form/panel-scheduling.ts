// Scheduling panel of the content editor (`admin/core/views/carch/form/dsp_panel_scheduling.cfm`), server-only.
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import { raw } from '@/lib/html';
import { ROOT_CONTENT_ID, structOf, structText, structValue } from '../model';
import type { EditFormInput, PanelResult } from './custom-tags';
import { renderDisplayContent } from './display-content';

/** The panel and the `rc.ptype` it leaves for the panels and hidden fields that follow. */
export interface SchedulingPanelResult extends PanelResult {
  /** The display content include's `rc.ptype` where it renders, else the request's. */
  readonly ptype: string;
}

const TAB_LABEL = 'Scheduling';

const PANEL_START = `
<div class="mura-panel panel">
\t<div class="mura-panel-heading" role="tab" id="heading-schedule">
\t\t<h4 class="mura-panel-title">
\t\t\t
\t\t\t<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-schedule" aria-expanded="true" aria-controls="panel-schedule">${TAB_LABEL}</a>
\t\t</h4>
\t</div>
\t<div id="panel-schedule" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-schedule" aria-expanded="false" style="height: 0px;">
\t\t<div class="mura-panel-body">

\t\t\t<span id="extendset-container-tabscheduletop" class="extendset-container"></span>

\t\t\t
\t\t\t`;

const PANEL_END = `
\t\t\t

\t\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-scheduling">
\t\t\t\t\t<div class="bigui" id="bigui__scheduling" data-label="Manage Extended Attributes">
\t\t\t\t\t\t<div class="bigui__title">Manage Extended Attributes</div>
\t\t\t\t\t\t<div class="bigui__controls">
\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>
\t\t\t\t\t\t\t<span id="extendset-container-scheduling" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-scheduling"></span>
\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>
\t\t\t\t\t
\t\t\t\t</div>
\t\t\t<span id="extendset-container-tabschedulebottom" class="extendset-container"></span>

\t\t</div>
\t</div>
</div>


`;

/** `rc[name]`; throws when absent, as CFML does for an undefined `rc` key. */
function rcText(rc: EditFormInput['req']['rc'], name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`rc.${name} is undefined for carch.edit`);
  return value;
}

/** The hidden display fields printed where the site's locking hides the schedule editor; `display` prints unencoded. */
function hiddenDisplayFields(type: string, display: string): string {
  if (!cfEq(type, 'Component') && !cfEq(type, 'Form')) {
    return (
      `\n\t\t\t\t\t<input type="hidden" name="display" value="${display}">` +
      `\n\t\t\t\t\t<input type="hidden" name="displayStart" value="">` +
      `\n\t\t\t\t\t<input type="hidden" name="displayStop" value="">\n\t\t\t\t`
    );
  }
  return '\n\t\t\t\t\t<input type="hidden" name="display" value="1">\n\t\t\t\t';
}

/**
 * The Scheduling panel include, from the newline after `<cfoutput>` through `</div>` and the two blank lines after it.
 * Reads `rc.parentid`, `rc.contentid` and `rc.type` from the request, and `rc.contentBean` (`isNew`, `parentID`,
 * `display`) and `rc.site.locking` from the edit model.
 * @throws TypeError When the request or the edit model lacks a value the include reads.
 */
export function renderSchedulingPanel(input: EditFormInput): SchedulingPanelResult {
  const { rc } = input.req;
  const model = input.data.rc;
  const bean = structOf(model, 'contentBean');
  // `settingsManager.getSite(rc.siteid).getLocking()`: the session site record carries no locking, the edit model does.
  const locking = structText(structOf(model, 'site'), 'locking');
  const rcParentId = rcText(rc, 'parentid');
  // edit.cfm fills a blank rc.parentID from a stored node before the panels read it.
  const parentId =
    rcParentId === '' && !cfToBoolean(structValue(bean, 'isNew')) ? structText(bean, 'parentID') : rcParentId;
  const underRoot = cfEq(parentId, ROOT_CONTENT_ID);
  const showsSchedule =
    ((!underRoot && !cfEq(locking, 'all')) || (underRoot && cfEq(locking, 'none'))) &&
    !cfEq(rcText(rc, 'contentid'), ROOT_CONTENT_ID);
  // The whitespace-only text between the include's CFML tags prints nothing: the output before each ends in whitespace.
  if (showsSchedule) {
    const display = renderDisplayContent(input);
    return {
      html: raw(PANEL_START + display.html.value + PANEL_END),
      tabId: 'tabSchedule',
      tabLabel: TAB_LABEL,
      ptype: display.ptype,
    };
  }
  return {
    html: raw(PANEL_START + hiddenDisplayFields(rcText(rc, 'type'), structText(bean, 'display')) + PANEL_END),
    tabId: 'tabSchedule',
    tabLabel: TAB_LABEL,
    ptype: input.state.ptype,
  };
}
