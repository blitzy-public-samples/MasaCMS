// Modules tab of the Site Settings editor (`csettings/editsite.cfm` lines 581-676).
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import { cfEq, checked, type EditSiteModel } from './model';

type StagedModule = 'hasChangesets' | 'enforceChangesets' | 'showDashboard' | 'scaffolding';

/** ` checked` on the Off radio: legacy `neq 1`. */
function off(value: string | number): SafeHtml {
  return checked(!cfEq(value, 1));
}

/** ` checked` on the On radio: legacy `eq 1`. */
function on(value: string | number): SafeHtml {
  return checked(cfEq(value, 1));
}

/** A multi-line Off/On group (Content Staging Manager onwards); `label` is a legacy literal emitted unencoded. */
function stagedGroup(m: EditSiteModel, label: string, name: StagedModule): SafeHtml {
  const value = m.bean[name];
  return html`\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${raw(label)}</label>
\t\t\t\t\t<label class="radio inline">
\t\t\t\t\t<input type="radio" name="${raw(name)}" value="0" ${off(value)}>
\t\t\t\t\tOff </label>
\t\t\t\t\t<label class="radio inline">
\t\t\t\t\t<input type="radio" name="${raw(name)}" value="1" ${on(value)}>
\t\t\t\t\tOn </label>
\t\t\t\t</div>`;
}

/** Renders the `#tabModules` pane as legacy emits it, every line LF-terminated. */
export function renderModulesTab(m: EditSiteModel): SafeHtml {
  const b = m.bean;
  const formsManager = m.config.dataCollection
    ? html`
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>Forms Manager</label>
\t\t\t\t\t\t\t\t\t<label class="radio inline">
\t\t\t\t\t\t\t\t\t<input type="radio" name="dataCollection" value="0" ${off(b.dataCollection)}>Off</label>
\t\t\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="dataCollection" value="1" ${on(b.dataCollection)}>On</label>
\t\t\t\t\t\t</div>
\t\t\t\t\t\t\x20`
    : null;
  const jsonApi = m.config.useLayoutManager
    ? null
    : html`
\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t\t<label>JSON API</label>
\t\t\t\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="JSONAPI" value="0" ${off(b.JSONApi)}>Off</label>
\t\t\t\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="JSONAPI" value="1" ${on(b.JSONApi)}>On</label>
\t\t\t\t\t\t</div>
\t\t\t\t\t`;
  const emailBroadcaster = m.config.emailBroadcaster
    ? html`
\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>Email Broadcaster</label>
\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="EmailBroadcaster" value="0" ${off(b.emailBroadcaster)}>Off</label>
\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="EmailBroadcaster" value="1" ${on(b.emailBroadcaster)}>On</label>
\t\t\t\t\t\t</div>
\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>Email Broadcaster Limit</label>
\t\t\t\t\t\t\t<input name="EmailBroadcasterLimit" type="text" class="mura-constrain mura-numeric" value="${raw(encodeHtmlAttr(String(b.emailBroadcasterLimit)))}" size="50" maxlength="50">
\t\t\t\t\t\t</div>
\t\t\t\t\t`
    : null;
  // `\x20` is a trailing space legacy leaves before a stripped CFML tag or comment. ACF drops whitespace-only text
  // between two CFML tags, so nothing separates the JSON API `</cfif>` from the Email Broadcaster `<cfif>`.
  return html`\t\t<div id="tabModules" class="tab-pane">
\t\t\t<div class="block block-bordered">
\t\t\t\t<!-- block header -->
\t\t\t  <div class="block-header">
\t\t\t\t\t<h3 class="block-title">Modules</h3>
\t\t\t\t</div>
\t\t\t  <!-- /block header -->
\t\t\t  <div class="block-content">
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>Extranet <span class="help-inline">(Password Protection)</span></label>
\t\t\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="extranet" value="0" ${off(b.extranet)}>Off</label>
\t\t\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="extranet" value="1" ${on(b.extranet)}>On</label>
\t\t\t\t\t</div>
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>Collections Manager</label>
\t\t\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="hasFeedManager" value="0" ${off(b.hasFeedManager)}>Off</label>
\t\t\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="hasFeedManager" value="1" ${on(b.hasFeedManager)}>On</label>
\t\t\t\t\t\t</div>
\t\t\t\t\t\t${formsManager}

\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>Comments Manager</label>
\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="hasComments" value="0" ${off(b.hasComments)}>Off</label>
\t\t\t\t\t\t\t<label class="radio inline"><input type="radio" name="hasComments" value="1" ${on(b.hasComments)}>On</label>
\t\t\t\t\t</div>

\t\t\t\t\t${jsonApi}${emailBroadcaster}


${stagedGroup(m, 'Content Staging Manager', 'hasChangesets')}

${stagedGroup(m, 'Publish via Change Sets Only', 'enforceChangesets')}

${stagedGroup(m, 'Dashboard', 'showDashboard')}

${stagedGroup(m, 'Masa CMS ORM Scaffolding (BETA)', 'scaffolding')}
\t\t\t</div>\x20
\t\t</div>\x20
\t</div>\x20
`;
}
