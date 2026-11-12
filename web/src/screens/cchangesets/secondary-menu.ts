// Change-set secondary menu of `cchangesets/dsp_secondary_menu.cfm`, also the shell's `cchangesets` hook (server-only).
import { encodeHtml, encodeJs, html, join, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { relativeAdminUrl } from '@/lib/urls';
import type { ShellHooks } from '@/shell/types';

/** Change sets module id, which the Permissions link passes as both `contentid` and `moduleid`. */
const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';

// Whitespace ACF emits around the menu's anchors, by the nesting depth of the CFML line that holds them.
const INDENT_4 = raw('\n\t\t\t\t');
const INDENT_5 = raw('\n\t\t\t\t\t');
const INDENT_6 = raw('\n\t\t\t\t\t\t');

/** The change set a cChangesets view loaded (`rc.changeset`) and the preview URL its page data supplies. */
export interface ChangesetMenuState {
  readonly changesetId?: string;
  readonly published: boolean;
  readonly isNew: boolean;
  readonly previewLink?: string;
}

/**
 * Renders `div.nav-module-specific` for the current cChangesets action; labels and hrefs are emitted unencoded, as
 * legacy writes them. `previewLink` is the `rc.previewLink` the menu set, absent when it rendered no preview button.
 * Without `state` (the shell hook) the buttons that depend on the loaded change set are left out.
 */
export function renderChangesetsMenu(
  req: AdminRequest,
  rb: RbLookup,
  state?: ChangesetMenuState,
): { html: SafeHtml; previewLink?: string } {
  const siteid = req.rc.siteid ?? '';
  const label = (key: string): SafeHtml => raw(rb.rbKey(`changesets.${key}`));
  const titled = (key: string, icon: string, href: string): SafeHtml =>
    html`<a class="btn" title="${label(key)}" href="${raw(href)}"><i class="${icon}"></i> ${label(key)}</a>`;
  const preview = (link: string | undefined): SafeHtml =>
    html`<a class="btn" href="#" onclick="return preview('${raw(encodeJs(link))}','');"><i class="mi-globe"></i> ${label('previewchangeset')}</a>`;
  const back = titled(
    'backtochangesets',
    'mi-arrow-circle-left',
    relativeAdminUrl('cChangesets', 'list', [['siteid', siteid]]),
  );

  const parts: SafeHtml[] = [];
  let previewLink: string | undefined;
  switch (req.item.toLowerCase()) {
    case 'assignments': {
      // legacy quirk: the edit link HTML-encodes the rc changeset id instead of URL-encoding it.
      const editHref = relativeAdminUrl('cChangesets', 'edit', [
        ['siteid', siteid],
        ['changesetID', encodeHtml(req.rc.changesetID), 'raw'],
      ]);
      parts.push(INDENT_4, back, INDENT_4, titled('vieweditform', 'mi-pencil', editHref), INDENT_4);
      if (state !== undefined && !state.published) {
        previewLink = state.previewLink;
        parts.push(INDENT_5, preview(previewLink), INDENT_4);
      }
      break;
    }
    case 'list': {
      const addHref = relativeAdminUrl('cChangesets', 'edit', [
        ['changesetID', '', 'raw'],
        ['siteid', siteid],
      ]);
      parts.push(INDENT_4, titled('addchangeset', 'mi-plus-circle', addHref), INDENT_4);
      if (req.isSiteAdmin || req.isS2) {
        const permHref = raw(
          relativeAdminUrl('cPerm', 'module', [
            ['contentid', CHANGESETS_MODULE_ID, 'raw'],
            ['siteid', siteid],
            ['moduleid', CHANGESETS_MODULE_ID, 'raw'],
          ]),
        );
        // legacy quirk: the `active` test compares the fuseaction with `module` inside the `list` case, leaving `btn `.
        const permissions = html`<a class="btn " href="${permHref}"><i class="mi-group"></i> ${label('permissions')}</a>`;
        parts.push(INDENT_4, permissions, INDENT_4);
      }
      break;
    }
    case 'edit': {
      parts.push(INDENT_4, back, INDENT_4);
      if (state !== undefined && !state.isNew) {
        // Legacy interpolates the loaded change set's id here without encoding.
        const assignmentsHref = relativeAdminUrl('cChangesets', 'assignments', [
          ['siteid', siteid],
          ['changesetID', state.changesetId ?? '', 'raw'],
        ]);
        parts.push(INDENT_5, titled('viewassignments', 'mi-reorder', assignmentsHref), INDENT_5);
        if (!state.published) {
          previewLink = state.previewLink;
          parts.push(INDENT_6, preview(previewLink), INDENT_4);
        }
      }
      break;
    }
  }
  return {
    html: html`<div class="nav-module-specific btn-group">\n\t\t${join(parts)}\n\t</div>`,
    previewLink,
  };
}

/** The shell's `cchangesets` hook: the menu for the current action, labels looked up in `session.rb`. */
export const cchangesetsSecondaryMenu: NonNullable<ShellHooks['secondaryMenus']['cchangesets']> = (req) =>
  renderChangesetsMenu(req, rbFor(req.session.rb)).html;
