// Collections (cFeed) secondary menu of `cfeed/dsp_secondary_menu.cfm`, also the shell's `cfeed` hook (server-only).
import { html, raw, type SafeHtml } from '@/lib/html';
import { administersRequestedSite, type AdminRequest } from '@/lib/request-context';
import { adminRbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { relativeAdminUrl } from '@/lib/urls';
import type { ShellHooks } from '@/shell/document';
import { MODULE_IDS } from '@/shell/nav';

/** The collection a cFeed view loaded (`rc.feedBean`). */
export interface CfeedMenuFeed {
  readonly feedId: string;
  readonly type: string;
  readonly isNew: boolean;
  readonly channelLink: string;
}

/** Inputs of {@link renderCfeedSecondaryMenu}. */
export interface CfeedMenuOptions {
  /** `listLast(request.action, '.')`. */
  readonly fuseaction: string;
  /** `rc.feedBean`; absent where legacy leaves it undefined. */
  readonly feed?: CfeedMenuFeed;
  /** The view's `endpoint`, which a saved Local feed's View Feed link prints; absent where legacy leaves it undefined. */
  readonly endpoint?: string;
}

/**
 * Renders the `nav-module-specific` button group; labels and hrefs are emitted unencoded, as legacy writes them.
 * @throws Error When a saved Local feed's link needs `endpoint` and none is given, as legacy's undefined variable throws.
 */
export function renderCfeedSecondaryMenu(
  req: AdminRequest,
  rb: RbLookup,
  { fuseaction, feed, endpoint }: CfeedMenuOptions,
): SafeHtml {
  const siteid = req.rc.siteid ?? '';
  const label = (key: string): SafeHtml => raw(rb.rbKey(key));
  const content = (icon: string, key: string): SafeHtml => html`<i class="${icon}"></i> ${label(key)}`;
  // Each item carries the whitespace ACF prints around it; whitespace-only template lines after whitespace print nothing.
  const links: SafeHtml[] = [];
  if (fuseaction.toLowerCase() === 'list') {
    for (const [key, type] of [
      ['collections.addlocalindex', 'Local'],
      ['collections.addremotefeed', 'Remote'],
    ] as const) {
      const href = raw(
        relativeAdminUrl('cFeed', 'edit', [
          ['feedID', '', 'raw'],
          ['siteid', siteid],
          ['type', type, 'raw'],
        ]),
      );
      links.push(html`\n\t\t\t<a class="btn" title="${label(key)}" href="${href}">${content('mi-plus-circle', key)}</a>`);
    }
    links.push(raw('\n\t\t\t'));
    if (administersRequestedSite(req)) {
      const moduleId = MODULE_IDS.collections;
      const href = raw(
        relativeAdminUrl('cPerm', 'module', [
          ['contentid', moduleId, 'raw'],
          ['siteid', siteid],
          ['moduleid', moduleId, 'raw'],
        ]),
      );
      // Legacy's `active` test compares the fuseaction with `module` inside the `list` case, so only the space remains.
      links.push(html`\n\t\t\t<a class="btn " href="${href}">${content('mi-group', 'collections.permissions')}</a>\n\t\t\t`);
    }
  } else {
    const backHref = raw(relativeAdminUrl('cFeed', 'list', [['siteid', siteid]]));
    links.push(
      html`\n\t\t\t<a class="btn" href="${backHref}">${content('mi-arrow-circle-left', 'collections.backtocollections')}</a>\n\t\t\t`,
    );
    if (feed !== undefined && !feed.isNew) {
      const local = feed.type.toLowerCase() === 'local';
      if (local && endpoint === undefined) throw new Error('Variable ENDPOINT is undefined.');
      const href = raw(local ? `${endpoint}/?feedID=${feed.feedId}` : feed.channelLink);
      links.push(
        html`\n\t\t\t\t\t<a class="btn" title="${label('collections.view')}" href="${href}" target="_blank">${content('mi-rss', 'collections.viewfeed')}</a>\n\t\t\t\t`,
      );
    }
  }
  return html`<div class="nav-module-specific btn-group">\n\t${links}\n\t</div>`;
}

// The hook receives only the request, so it looks labels up in `session.rb` through the admin chain under the
// `resource_bundles/` overrides, as the views do; no collection is loaded outside the cFeed views.
/** The shell's `cfeed` secondary-menu hook for the current action. */
export const cfeedSecondaryMenu: NonNullable<ShellHooks['secondaryMenus']['cfeed']> = (req) =>
  renderCfeedSecondaryMenu(req, adminRbFor(req.session.rb), { fuseaction: req.item });
