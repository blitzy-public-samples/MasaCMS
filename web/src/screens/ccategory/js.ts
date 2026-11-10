// Category manager `request.ajax` block of `ccategory/js.cfm`: the category script and the add-subcategory menu.
import { CORE_VERSION } from '@/lib/env';
import { html, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Renders the category script tag and the hidden `#newContentMenu` add-subcategory menu. */
export function renderCategoryAjax(rb: RbLookup): SafeHtml {
  // The script path stays relative, as legacy emits it, so the browser resolves it against the admin URL.
  return html`<script src="assets/js/category.min.js?coreversion=${CORE_VERSION}" type="text/javascript">
</script>

<div id="newContentMenu" class="addNew hide">
  <ul id="newCategoryOptions">
    <li id="newPage"><a href="" id="newCategoryLink" ><i class="mi-plus"></i> ${rb.rbKey('categorymanager.addsubcategory')}</a></li>
 </ul>
</div>
`;
}
