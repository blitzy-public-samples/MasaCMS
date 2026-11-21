import { CORE_VERSION } from '@/lib/env';
import { html, type SafeHtml } from '@/lib/html';

/** The `approvalchain.js` script element, with the admin-relative path and attribute spacing legacy emits. */
export function renderCchainJs(): SafeHtml {
  return html`<script src="assets/js/approvalchain.js?coreversion=${CORE_VERSION}" type="text/javascript" ></script>`;
}
