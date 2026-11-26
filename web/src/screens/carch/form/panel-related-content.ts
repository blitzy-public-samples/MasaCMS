// Related Content panel of the content edit form (`admin/core/views/carch/form/dsp_panel_related_content.cfm`).
import { encodeHtmlAttr, raw } from '@/lib/html';
import type { ScreenContext } from '../../registry';
import type { PanelResult } from './custom-tags';

/** The include's input; an `EditFormInput` satisfies it. */
export interface RelatedContentPanelInput {
  readonly ctx: Pick<ScreenContext, 'rb'>;
}

/** The include's output, from the newline after `<cfoutput>` through `</script>` and the file's two final newlines. */
export function renderPanelRelatedContent({ ctx }: RelatedContentPanelInput): PanelResult {
  const label = ctx.rb.rbKey('sitemanager.content.tabs.relatedcontent');
  const title = encodeHtmlAttr(label);
  // Legacy markup and script verbatim: the heading label is unencoded, as legacy outputs it, and the whitespace left by
  // the stripped CFML comments stays.
  const html = raw(`
	<div class="mura-panel panel">
		<div class="mura-panel-heading" role="tab" id="heading-relatedcontent">
			<h4 class="mura-panel-title">
				<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-relatedcontent" aria-expanded="false" aria-controls="panel-relatedcontent">${label}</a>
			</h4>
		</div>
		<div id="panel-relatedcontent" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-relatedcontent" aria-expanded="false" style="height: 0px;">
			<div class="mura-panel-body">

				<span id="extendset-container-tabrelatedcontenttop" class="extendset-container"></span>

				<div class="mura-control-group">
					<div id="relcontent__selected"></div>
					
					
					<div class="bigui" id="bigui__related" data-label="Manage Related Content">
						<div class="bigui__title">${title}</div>
						<div class="bigui__controls">
							<div id="selectRelatedContent"></div>
							<div id="selectedRelatedContent" class="mura-control-group"></div>
						</div>
					</div> 
				</div>


				<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-relatedcontent">
					<div class="bigui" id="bigui__relatedcontent" data-label="Manage Extended Attributes">
						<div class="bigui__title">Manage Extended Attributes</div>
						<div class="bigui__controls">
							<span id="extendset-container-tabextendedattributestop"></span>
							<span id="extendset-container-relatedcontent" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-relatedcontent"></span>
							<span id="extendset-container-tabextendedattributesbottom"></span>
						</div>
					</div>
					
				</div>
				<input id="relatedContentSetData" type="hidden" name="relatedContentSetData" value="" />	

				<span id="extendset-container-tabrelatedcontentbottom" class="extendset-container"></span>
			</div>
		</div>
	</div> 


<script type="text/javascript">
	$(document).ready(function(){

		// display selected related content in text format
		var showSelectedRC = function(){	
			var rcList = '';
					// create list of selected content
					$('#selectedRelatedContent .list-table').each(function(){
						rcText = $(this).find('.list-table-content-set').text();
						rcLen = $(this).find('.list-table-items li.item').not('.empty').not('.noShow').not('.ui-sortable-placeholder').length;
						if (rcLen > 0){
							rcList = rcList + '<li>' + rcText + ': ' + rcLen + '</li>';
						}
					})

					if (rcList.trim().length > 0){
					
						$('#relcontent__selected').html('<label>Selected</label><ul>' + rcList + '</ul>');
					} else {
						$('#relcontent__selected').html('<label>Selected</label><div>No related content selected</div>');
					}
				}

		// run on page load
		showSelectedRC();
		// run on click of heading
		$('#heading-relatedcontent').on('click',function(){
			showSelectedRC();
		})
		// run when bigui is opened, until closed
		$('a.bigui__launch').on('click',function(){
	    rcTimer = setInterval(function(){
		    showSelectedRC();
			}, 1000);
		});
		$('#bigui__related a.bigui__close').on('click',function(){
	    clearInterval(rcTimer);
		});

	});
</script>

`);
  return { html, tabId: 'tabRelatedcontent', tabLabel: label };
}
