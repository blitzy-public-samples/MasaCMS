// Change-set assignment dialog of the content editor (`admin/core/views/carch/form/dsp_changesets.cfm`).
import { encodeHtmlAttr, encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { ScreenContext } from '../../registry';

/** The edit view's values the include reads, resolved by the caller from the strategies-content edit model. */
export interface ChangesetsDialogInput {
  /** `changesetManager.read(contentBean.getChangesetID()).getIsNew()`: no stored change set has that id. */
  readonly currentChangesetIsNew: boolean;
  /** Content bean `approved`. */
  readonly approved: boolean;
  /** Content bean `changesetID`; empty when the version is in no change set. */
  readonly changesetId: string;
}

/** The include's output, from the newline after `<cfoutput>` through `</div>` and its newline. */
export function renderChangesetsDialog(ctx: Pick<ScreenContext, 'rb'>, input: ChangesetsDialogInput): SafeHtml {
  // Preselected only while the version waits in its change set: the set exists and the version is not approved.
  const selection = !input.currentChangesetIsNew && !input.approved ? input.changesetId : '';
  const publishPrompt = encodeJs(ctx.rb.rbKey('sitemanager.content.publishitemfromchangeset'));
  const save = encodeJs(ctx.rb.rbKey('sitemanager.content.save'));
  const title = encodeHtmlAttr(ctx.rb.rbKey('sitemanager.content.assigntochangeset'));
  // Legacy script verbatim: the unquoted button key, the commented-out submit and the trailing whitespace are
  // legacy's, and the change set id is unencoded, as legacy outputs it.
  return raw(`
<script>

var currentChangesetSelection="${selection}";
var currentChangesetID="${selection}";


var publishitemfromchangeset="${publishPrompt}"
function removeChangesetPrompt(changesetID){
	
	if(currentChangesetID!="" && changesetID!=currentChangesetID){
		jQuery("#removeChangesetContainer").show();
	} else {
		jQuery("#removeChangesetContainer").hide();
		document.getElementById("_removePreviousChangeset").checked=false;
	}
	
	currentChangesetSelection=changesetID;
}

var assigningChangeset=false;

function saveToChangeset(changesetid,siteid,keywords){
	
	var url = 'index.cfm';
	var pars = 'muraAction=cArch.availablechangesets&compactDisplay=true&siteid=' + siteid  + '&keywords=' + keywords + '&changesetid=' + changesetid +'&cacheid=' + Math.random();
	var d = jQuery('#changesetContainer');
	d.html('<div class="load-inline"></div>');
	$('#changesetContainer .load-inline').spin(spinnerArgs2);
	jQuery.get(url + "?" + pars, 
			function(data) {
			$('#changesetContainer .load-inline').spin(false);
			jQuery('#changesetContainer').html(data);
			stripe('stripe');
			});

		jQuery("#changesetContainer").dialog({
			resizable: false,
			modal: true,
			close: function( event, ui ) { siteManager.assigningChangeset=false;},
			buttons: {
				${save}: 
					{click: function() {
							jQuery(this).dialog('close');
						if(siteManager.configuratorMode == 'backEnd') {
							siteManager.assigningChangeset=true;
							if(siteManager.ckContent()){
								//submitForm(document.contentForm, 'add');
							}
						} else {
							siteManager.saveConfiguratorToChangeset(currentChangesetSelection,document.getElementById("_removePreviousChangeset").checked);
						}
							
							return false;						
						}
					, text: '${save}'
					, class: 'mura-primary'
					} // /Save
			}
		});
	
	
	return false;	
}
</script>
<div style="display:none" title="${title}" id="changesetContainer">

</div>
`);
}
