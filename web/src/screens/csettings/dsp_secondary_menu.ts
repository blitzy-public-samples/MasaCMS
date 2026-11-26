// Site settings secondary menu of `csettings/dsp_secondary_menu.cfm`; no legacy view or layout includes it.
import { html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';

// Legacy's `cSettings.edit` is not an action and its `&` is unencoded; both are emitted verbatim.
const ADD_SITE_ITEM = raw('\n<li><a href="./?muraAction=cSettings.edit&siteid=">Add New Site</a></li>\n');

/** Renders the `nav-pills` list, with the Add New Site link when the original action item is `list`. */
export function renderCsettingsSecondaryMenu(req: AdminRequest): SafeHtml {
  // The layouts' `cfparam` defaults `rc.originalfuseaction` to the action's item.
  const originalFuseaction = req.rc.originalfuseaction ?? req.item;
  return html`<ul class="nav nav-pills">
${originalFuseaction.toLowerCase() === 'list' ? ADD_SITE_ITEM : null}
</ul>`;
}
