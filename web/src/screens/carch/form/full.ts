import { html, type SafeHtml } from '@/lib/html';

/** Page-limit notice shown instead of the content edit and upload forms (`form/dsp_full.cfm`), legacy English. */
export function renderSiteFull(): SafeHtml {
  return html`<div class="mura-header">
<h1>Edit Content</h1>
</div>
<div class="alert alert-error">
This site has reached it's maximum number of pages allowed. If you are a Super Admin, this can be changed in Site Settings.</div> 
`;
}
