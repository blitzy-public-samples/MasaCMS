// Collections (cFeed) secondary menu of `cfeed/dsp_secondary_menu.cfm`, also the shell's `cfeed` hook (server-only).
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import type { ShellHooks } from '@/shell/document';
import { MODULE_IDS } from '@/shell/nav';
import { feedApiEndpoint } from './common';

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
  /** The feed API endpoint; built from the session site when a saved Local feed needs it and none is given. */
  readonly endpoint?: string;
}

/** Renders the `nav-module-specific` button group; labels and hrefs are emitted unencoded, as legacy writes them. */
export function renderCfeedSecondaryMenu(
  req: AdminRequest,
  rb: RbLookup,
  { fuseaction, feed, endpoint }: CfeedMenuOptions,
): SafeHtml {
  const siteid = encodeUrl(req.rc.siteid ?? '');
  const label = (key: string): SafeHtml => raw(rb.rbKey(key));
  const content = (icon: string, key: string): SafeHtml => html`<i class="${icon}"></i> ${label(key)}`;
  const links: SafeHtml[] = [];
  if (fuseaction.toLowerCase() === 'list') {
    for (const [key, type] of [
      ['collections.addlocalindex', 'Local'],
      ['collections.addremotefeed', 'Remote'],
    ] as const) {
      const href = raw(`./?muraAction=cFeed.edit&feedID=&siteid=${siteid}&type=${type}`);
      links.push(html`<a class="btn" title="${label(key)}" href="${href}">${content('mi-plus-circle', key)}</a>`);
    }
    if (req.isSiteAdmin || req.isS2) {
      const moduleId = MODULE_IDS.collections;
      const href = raw(`./?muraAction=cPerm.module&contentid=${moduleId}&siteid=${siteid}&moduleid=${moduleId}`);
      // Legacy's `active` test compares the fuseaction with `module` inside the `list` case, so only the space remains.
      links.push(html`<a class="btn " href="${href}">${content('mi-group', 'collections.permissions')}</a>`);
    }
  } else {
    const backHref = raw(`./?muraAction=cFeed.list&siteid=${siteid}`);
    links.push(html`<a class="btn" href="${backHref}">${content('mi-arrow-circle-left', 'collections.backtocollections')}</a>`);
    if (feed !== undefined && !feed.isNew) {
      const local = feed.type.toLowerCase() === 'local';
      const href = raw(local ? `${feedApiEndpoint(req, endpoint)}/?feedID=${feed.feedId}` : feed.channelLink);
      links.push(
        html`<a class="btn" title="${label('collections.view')}" href="${href}" target="_blank">${content('mi-rss', 'collections.viewfeed')}</a>`,
      );
    }
  }
  return html`<div class="nav-module-specific btn-group">${links}</div>`;
}

// The hook receives only the request, so it looks labels up in `session.rb` through the admin chain, as legacy's
// `application.rbFactory.getKeyValue(session.rb, …)` does; no collection is loaded outside the cFeed views.
/** The shell's `cfeed` secondary-menu hook for the current action. */
export const cfeedSecondaryMenu: NonNullable<ShellHooks['secondaryMenus']['cfeed']> = (req) =>
  renderCfeedSecondaryMenu(req, rbFor(req.session.rb), { fuseaction: req.item });
