import { encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { ScreenContext } from '../../registry';

/** `carch/draftpromptjs.cfm`: the inline script that opens the `carch.draftpromptdata` prompt from `a.draftprompt`. */
export function draftPromptJs(ctx: Pick<ScreenContext, 'rb'>): SafeHtml {
  const title = encodeJs(ctx.rb.rbKey('sitemanager.draftprompt.title'));
  return raw(`
<script type="text/javascript">
$(function(){
	initDraftPrompt();
});

function draftprompt(e){
	e.preventDefault(); // stop the link's normal clicking behavior
	e.stopPropagation();

	if(typeof $(this).attr('data-contenthistid') != 'undefined'){
		var node =$(this);
	} else {
		var node = jQuery(this).parents(".mura-node-data:first");
	}

	var a = jQuery(this);
	var locknode=false;

	$.ajax({
		  url: "./index.cfm?muraAction=carch.draftpromptdata&contentid=" + node.attr('data-contentid') + "&siteid=" + node.attr('data-siteid') + "&targetversion=" + node.attr('data-targetversion') + "&contenthistid=" + node.attr('data-contenthistid'),
		  context: this,
		  success: function(resp){

			  if (resp.showdialog !== undefined && resp.showdialog === "true"){
				var dialog=jQuery(resp.message).dialog({
					dialogClass: "dialog-info",
					title:"${title}",
					modal:true,
					resizable:false,
					width:600
				});

				$(".draft-prompt-option").click(function(e){
					e.preventDefault();

					if(a.attr('href')){
						var href=a.attr('href').replace(node.attr('data-contenthistid'),$(this).attr('data-contenthistid') + "&locknode=" + locknode );
					} else {
						var href=a.data('href').replace(node.attr('data-contenthistid'),$(this).attr('data-contenthistid') + "&locknode=" + locknode );
					}

					actionModal(href);
				});

				$(".draft-prompt-approval").click(function(e){
					e.preventDefault();
					preview($(this).attr('href'));
					jQuery(dialog).dialog('close');
					return false;
				});

				$("#locknodetoggle").on("change",function(){
					locknode=$(this).is(":checked");
				});

			} else {
				if(a.attr('href')){
					actionModal(a.attr('href'));
				} else {
					actionModal(a.data('href'));
				}

			}
		}
	});

}
function initDraftPrompt(){
	$('a.draftprompt').click(draftprompt);
}
</script>
`);
}
