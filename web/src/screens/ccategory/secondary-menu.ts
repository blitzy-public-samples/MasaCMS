// Category manager secondary menu of `ccategory/dsp_secondary_menu.cfm`, placed by the list and edit screens (server-only).
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { ShellHooks } from '@/shell/types';

/** Category manager module id, which the Permissions link passes as both `contentid` and `moduleid`. */
const CATEGORY_MODULE_ID = '00000000000000000000000000000000010';

/** CFML `listLast(action, ".")`: the last non-empty `.`-delimited item, `''` when there is none. */
export function originalFuseactionOf(action: string): string {
  return action.split('.').filter((item) => item !== '').at(-1) ?? '';
}

/** Renders `div.nav-module-specific`: Add plus, for site admins and S2 users, Permissions on `list`; Back otherwise. */
export const ccategorySecondaryMenu: NonNullable<ShellHooks['secondaryMenus']['ccategory']> = (
  ctx: AdminRequest,
): SafeHtml => {
  const rb = rbFor(ctx.session.rb);
  // Labels and the URL-encoded site id are written unencoded, as legacy writes them.
  const label = (key: string): SafeHtml => raw(rb.rbKey(`categorymanager.${key}`));
  const siteid = raw(encodeUrl(ctx.rc.siteid ?? ''));
  const addLabel = label('addnewcategory');

  let links: SafeHtml[];
  if (originalFuseactionOf(ctx.action) === 'list') {
    links = [
      html`<a class="btn" title="${addLabel}" href="./?muraAction=cCategory.edit&categoryID=&parentID=&siteid=${siteid}"><i class="mi-plus-circle"></i> ${addLabel}</a>`,
    ];
    // `Admin;<private pool>;0` or `S2` membership; legacy's `active` class test cannot match here, leaving `btn `.
    if (ctx.isSiteAdmin || ctx.isS2) {
      links.push(
        html`<a class="btn " href="./?muraAction=cPerm.module&contentid=${CATEGORY_MODULE_ID}&siteid=${siteid}&moduleid=${CATEGORY_MODULE_ID}"><i class="mi-group"></i> ${label('permissions')}</a>`,
      );
    }
  } else {
    // Legacy titles the Back link with the Add label.
    links = [
      html`<a class="btn" title="${addLabel}" href="./?muraAction=cCategory.list&categoryID=&parentID=&siteid=${siteid}"><i class="mi-arrow-circle-left"></i> ${label('backtocategories')}</a>`,
    ];
  }
  return html`<div class="nav-module-specific btn-group">${links.map((link) => html`
				${link}`)}
</div>`;
};
