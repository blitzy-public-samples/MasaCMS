// Site Manager context menu and new-content dialog of `carch/dsp_content_nav.cfm`, the shell's content nav (server-only).
import { html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { ShellHooks } from '@/shell/types';

/** Renders `#newContentMenu` and `#newContentDialog`, ending with the line break legacy emits before `</cfoutput>`. */
export const carchContentNav: NonNullable<ShellHooks['contentNav']> = (ctx: AdminRequest): SafeHtml => {
  const rb = rbFor(ctx.session.rb);
  // `getKeyValue` output is written unencoded, as legacy writes it.
  const label = (key: string): SafeHtml => raw(rb.rbKey(`sitemanager.${key}`));
  // Legacy's bytes, empty hrefs and inline style included, since architecture.js binds to them; the `\x20\x20` line is
  // the indent the stripped CFML comment leaves.
  return html`<div id="newContentMenu" class="addNew hide">
  <ul id="newContentOptions">
\x20\x20
    <li id="newZoom"><a href="" id="newZoomLink"><i class="mi-search-plus"></i>${label('zoom')}</a></li>
    <li id="newContent"><a href="" id="newContentLink"><i class="mi-plus"></i>${label('addcontent')}</a></li>
    <li id="newCopy"><a href="" id="newCopyLink"><i class="mi-copy"></i>${label('copy')}</a></li>
    <li id="newCopyAll"><a href="" id="newCopyAllLink"><i class="mi-sitemap"></i>${label('copyall')}</a></li>
\t  <li id="newPaste"><a href="" id="newPasteLink"><i class="mi-paste"></i>${label('paste')}</a></li>
  </ul>
</div>

<div id="newContentDialog" title="Add New Content" class="hide">
  <p>
  \t<span class="ui-icon ui-icon-alert" style="float:left; margin:0 7px 20px 0;"></span>
  \t<span id="newContentContainer"></span>
  </p>
</div>
`;
};
