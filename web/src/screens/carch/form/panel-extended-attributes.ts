// Extended Attributes panel of the content editor (`admin/core/views/carch/form/dsp_panel_extended_attributes.cfm`).
import { raw } from '@/lib/html';
import type { ScreenContext } from '../../registry';
import type { PanelResult } from './custom-tags';

/** The include's output, from the newline after `<cfoutput>` through `</div> ` and its newline. */
export function renderPanelExtendedAttributes(input: { readonly ctx: Pick<ScreenContext, 'rb'> }): PanelResult {
  const tabLabel = input.ctx.rb.rbKey('sitemanager.content.tabs.extendedattributes');
  // Legacy verbatim, label unencoded; the extend sets load client-side (`siteManager.loadExtendedAttributes`). The
  // repeated span ids, the blank line, the indent left by the stripped `/.bigui` comment and `</div> ` are legacy's.
  return {
    html: raw(`
	<div class="mura-panel panel">
		<div class="mura-panel-heading" role="tab" id="heading-extendedattributes">
			<h4 class="mura-panel-title">
				<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-extendedattributes" aria-expanded="false" aria-controls="panel-extendedattributes">${tabLabel}</a>
			</h4>
		</div>
		<div id="panel-extendedattributes" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-extendedattributes" aria-expanded="false" style="height: 0px;">
			<div class="mura-panel-body">
				<span id="extendset-container-tabextendedattributestop" class="extendset-container"></span>

				<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-default">
					<div class="bigui" id="bigui__extended" data-label="Manage Extended Attributes">
						<div class="bigui__title">Manage Extended Attributes</div>
						<div class="bigui__controls">
							<span id="extendset-container-tabextendedattributestop"></span>
							<span id="extendset-container-default" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-default"></span>
							<span id="extendset-container-tabextendedattributesbottom"></span>
						</div>
					</div>
					 
				</div>
				<span id="extendset-container-tabextendedattributesbottom" class="extendset-container"></span>
			</div>
		</div>
	</div> 
`),
    tabId: 'tabExtendedAttributes',
    tabLabel,
  };
}
