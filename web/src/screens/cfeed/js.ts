// Collection (feed) manager `request.ajax` block of `cfeed/js.cfm`: the scripts the edit and import screens load.
import { CORE_VERSION } from '@/lib/env';
import { html, type SafeHtml } from '@/lib/html';

/** The checkbox-tree, feed and search-params script elements, as the whole `request.ajax` value. */
export function cfeedAjaxScripts(): SafeHtml {
  // Paths stay relative, as legacy emits them, so the browser resolves them against the admin URL.
  return html`<script src="assets/js/jquery/jquery.collapsibleCheckboxTree.js?coreversion=${CORE_VERSION}" type="text/javascript" ></script>
<script src="assets/js/feed.min.js?coreversion=${CORE_VERSION}" type="text/javascript" language="javascript1.2" ></script>
<script src="assets/js/searchParams.js?coreversion=${CORE_VERSION}" type="text/javascript" ></script>
`;
}
