// Razuna tab of the Site Settings editor (`admin/core/views/csettings/editsite.cfm` lines 1294-1342).
import { html, raw, type SafeHtml } from '@/lib/html';
import type { EditSiteModel } from './model';

const NOTHING = raw('');

// Legacy's added bytes when the flag is on, from the `<cfif>` line break to the `</cfif>` indent; stripped CFML
// comments leave the space after `</div>`. Values are empty: Razuna settings (`trazunasettings`) stay on legacy.
const RAZUNA_PANE = html`
		<div id="tabRazuna" class="tab-pane">
			<div class="block block-bordered">
				<!-- block header -->
			  <div class="block-header">
					<h3 class="block-title">Razuna Settings</h3>
			  </div>
			  <!-- /block header -->
			  <div class="block-content">
			
			<input type="hidden" name="servertype" value="local">
			<div class="mura-control-group">
				<label for="razuna_hostname">Hostname <span class="help-block">Example: yourcompany.razuna.com or localhost:8080/razuna</span></label>
					<input type="text" value="" id="razuna_hostname" name="hostname">

				</div>

			<div class="mura-control-group">
				<label for="hostid">Host ID <span class="help-block">Example: 496</span></label>
					<input type="text" value="" id="razuna_hostid" name="hostid">
			</div>

			<div class="mura-control-group">
				<label for="dampath">DAM Path <span class="help-block">Example: /demo/dam</span></label>
					<input type="text" value="" id="razuna_dampath" name="damPath">
			</div>

			<div class="mura-control-group">
				<label for="razuna_api_key">API Key</label>
					<input type="text" value="" id="razuna_api_key" name="apikey">
			</div>

			</div> 
		</div> 
	</div> 
	`;

/** Renders the Razuna Settings pane when the global `razuna` flag is on, else nothing. */
export function renderRazunaTab(m: EditSiteModel): SafeHtml {
  return m.config.razuna ? RAZUNA_PANE : NOTHING;
}
