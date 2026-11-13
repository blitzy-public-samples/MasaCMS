// Associated image panel of the content editor (`admin/core/views/carch/form/dsp_panel_assocfile.cfm`), server-only.
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { raw } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { cfListHas, type EditFormInput, type PanelResult } from './custom-tags';
import { renderFileSelector } from './file-selector';

/** The content types the include renders for (`ListFindNoCase`). */
const ASSOC_TYPES = 'Page,Folder,Calendar,Gallery,Link';

/** `listLast(label, ' ')`: the last space-delimited word of an admin label, `''` when it has none. */
function lastWord(rb: RbLookup, key: string): string {
  return cfListToArray(rb.rbKey(key), ' ').at(-1) ?? '';
}

/**
 * The panel from the newline after `<cfoutput>` through `</div> \n`, or `null` for types the include skips.
 * @throws TypeError When `rc.type` is undefined, as legacy's `ListFindNoCase` fails on it.
 */
export async function renderPanelAssocFile(input: EditFormInput): Promise<PanelResult | null> {
  const { ctx, req, state } = input;
  const rcType = req.rc.type;
  if (rcType === undefined) throw new TypeError('Element TYPE is undefined in RC.');
  if (!cfListHas(ASSOC_TYPES, rcType, { noCase: true })) return null;
  const imageBranch = cfEq(state.ptype, 'Gallery') || !cfEq(rcType, 'File');
  const label = lastWord(ctx.rb, `sitemanager.content.fields.${imageBranch ? 'selectimage' : 'selectfile'}`);
  const selector = await renderFileSelector(input);
  // ACF whitespace management prints the gap after the label as one space and drops the one before it.
  return {
    tabId: 'tabAssoc',
    tabLabel: label,
    html: raw(`
<div class="mura-panel panel">
\t<div class="mura-panel-heading" role="tab" id="heading-assoc">
\t\t<h4 class="mura-panel-title">
\t\t\t<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-assoc" aria-expanded="true" aria-controls="panel-assoc">
\t\t\t\t
\t\t\t\t${label} 
\t\t\t</a>
\t\t</h4>
\t</div>
\t<div id="panel-assoc" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-assoc" aria-expanded="false" style="height: 0px;">
\t\t<div class="mura-panel-body">
\t\t\t
\t\t\t\t<span id="extendset-container-tabassoctop" class="extendset-container"></span>

\t\t\t\t\t\t\t\t
\t\t\t\t${selector.value}

\t\t\t\t<span id="extendset-container-assoc" class="extendset-container"></span>

\t\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-image">
\t\t\t\t\t<div class="bigui" id="bigui__image" data-label="Manage Extended Attributes">
\t\t\t\t\t\t<div class="bigui__title">Manage Extended Attributes</div>
\t\t\t\t\t\t<div class="bigui__controls">
\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>
\t\t\t\t\t\t\t<span id="extendset-container-image" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-image"></span>
\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>
\t\t\t\t\t
\t\t\t\t</div>

\t\t\t\t<span id="extendset-container-tabassocbottom" class="extendset-container"></span>

\t\t</div>
\t</div>
</div> 
`),
  };
}
