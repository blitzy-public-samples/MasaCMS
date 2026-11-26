// The shell's alert dialog include, `admin/common/layouts/includes/dialog.cfm` (server-only).
import { html, type SafeHtml } from '@/lib/html';

/** The hidden `#alertDialog` container legacy admin scripts fill and open. */
export function renderDialog(): SafeHtml {
  // The Razuna stylesheet and scripts are never emitted: the target holds no Razuna settings.
  return html`<div id="alertDialog" title="Alert" class="hide">
\t<span id="alertDialogMessage"></span>
</div>`;
}
