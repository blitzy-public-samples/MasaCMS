// Category manager secondary menu of `ccategory/dsp_secondary_menu.cfm`, placed by the list and edit screens (server-only).
import { html, raw, type SafeHtml } from '@/lib/html';
import { tokenServesSite, type AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { relativeAdminUrl } from '@/lib/urls';
import type { ShellHooks } from '@/shell/types';

/** Category manager module id, which the Permissions link passes as both `contentid` and `moduleid`. */
const CATEGORY_MODULE_ID = '00000000000000000000000000000000010';

/** CFML `listLast(action, ".")`: the last non-empty `.`-delimited item, `''` when there is none. */
export function originalFuseactionOf(action: string): string {
  return action.split('.').filter((item) => item !== '').at(-1) ?? '';
}

// identity mints site-admin for the token's site, while legacy checks getSite(rc.siteid), which answers `default` for
// an empty id; so the role counts only when the token serves that site. S2 is global.
/** Membership `Admin;<privateUserPoolID of getSite(rc.siteid)>;0` or `S2`, read from the verified claims. */
function seesPermissions(ctx: AdminRequest): boolean {
  return (
    ctx.isS2 || (ctx.isSiteAdmin && ctx.user !== undefined && tokenServesSite(ctx.user, ctx.rc.siteid || 'default'))
  );
}

/** Renders `div.nav-module-specific`: Add, plus Permissions if {@link seesPermissions}, on `list`; Back otherwise. */
export const ccategorySecondaryMenu: NonNullable<ShellHooks['secondaryMenus']['ccategory']> = (
  ctx: AdminRequest,
): SafeHtml => {
  const rb = rbFor(ctx.session.rb);
  // Labels and hrefs are written unencoded, as legacy writes them.
  const label = (key: string): SafeHtml => raw(rb.rbKey(`categorymanager.${key}`));
  const siteid = ctx.rc.siteid ?? '';
  const addLabel = label('addnewcategory');
  const categoryHref = (action: string): SafeHtml =>
    raw(
      relativeAdminUrl('cCategory', action, [
        ['categoryID', '', 'raw'],
        ['parentID', '', 'raw'],
        ['siteid', siteid],
      ]),
    );

  // Each link carries the whitespace ACF prints around it; whitespace-only template lines after whitespace print nothing.
  let links: SafeHtml[];
  if (originalFuseactionOf(ctx.action) === 'list') {
    links = [
      html`\n\t\t\t\t<a class="btn" title="${addLabel}" href="${categoryHref('edit')}"><i class="mi-plus-circle"></i> ${addLabel}</a>\n\t\t\t`,
    ];
    // `Admin;<private pool>;0` or `S2` membership; legacy's `active` class test cannot match here, leaving `btn `.
    if (seesPermissions(ctx)) {
      const permHref = raw(
        relativeAdminUrl('cPerm', 'module', [
          ['contentid', CATEGORY_MODULE_ID, 'raw'],
          ['siteid', siteid],
          ['moduleid', CATEGORY_MODULE_ID, 'raw'],
        ]),
      );
      links.push(
        html`\n\t\t\t\t<a class="btn " href="${permHref}"><i class="mi-group"></i> ${label('permissions')}</a>\n\t\t\t`,
      );
    }
  } else {
    // Legacy titles the Back link with the Add label.
    links = [
      html`\n\t\t\t<a class="btn" title="${addLabel}" href="${categoryHref('list')}"><i class="mi-arrow-circle-left"></i> ${label('backtocategories')}</a>\n\t\t`,
    ];
  }
  return html`<div class="nav-module-specific btn-group">\n\t${links}\n</div>`;
};
