import { html, raw, type SafeHtml } from '@/lib/html';
import { adminAssetUrl } from '@/lib/urls';

/** `html_foot.cfm`: the tag selector, tab-drop and slider scripts both layouts load last, URLs unencoded as legacy emits them. */
export function renderHtmlFoot(): SafeHtml {
  const src = (rel: string, coreversion = false): SafeHtml => raw(adminAssetUrl(rel, { coreversion }));
  return html`
\t<script src="${src('js/jquery/jquery-tagselector.js', true)}"></script>

\t<script src="${src('js/bootstrap-tabdrop.js')}"></script>

\t<script src="${src('js/bootstrap-slider/bootstrap-slider.min.js')}"></script>\t
`;
}
