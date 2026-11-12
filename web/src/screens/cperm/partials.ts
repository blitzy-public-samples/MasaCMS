// The cperm controller's `before()` gate and rc defaults, and the markup the permission views share (server-only).
import type { ScreenGate } from '@/lib/access-gate';
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import type { RequestContext } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { boundAdminUrl } from '@/lib/urls';

/** The site's home node. */
export const TOP_NODE_ID = '00000000000000000000000000000000001';

/** Site Manager module. */
export const CONTENT_MODULE_ID = '00000000000000000000000000000000000';

/** cperm `before()`: site admins and S2 users pass; everyone else gets the controller's `secure()`. */
export const cpermGate: ScreenGate = (req, { secure }) => (req.isSiteAdmin || req.isS2 ? { kind: 'allow' } : secure());

/** The `param` statements of `before()` in source order; a name already present keeps its value. */
const CPERM_RC_DEFAULTS: ReadonlyArray<readonly [name: string, value: string]> = Object.freeze([
  ['parentid', ''],
  ['topid', ''],
  ['contentid', ''],
  ['body', ''],
  ['Contentid', ''],
  ['groupid', ''],
  ['url', ''],
  ['type', ''],
  ['startrow', '1'],
  ['siteid', ''],
  ['approvalExempt', ''],
  ['chainID', ''],
  ['exemptID', ''],
  // The empty `topid` default above is applied first, so this one never takes effect and an absent `topid` stays ''.
  ['topid', TOP_NODE_ID],
]);

// request-context keeps its case-insensitive scope view private and its exported builders add only the admin-wide
// defaults, so the cperm params get their own view of the same shape.
/** A read-only rc over `entries` (keyed by lower-cased name) whose lookups ignore case, as a CFML scope's do. */
function caseInsensitiveRc(entries: ReadonlyMap<string, readonly [name: string, value: string]>): RequestContext {
  const valueOf = (name: string | symbol): string | undefined =>
    typeof name === 'string' ? entries.get(name.toLowerCase())?.[1] : undefined;
  return new Proxy(Object.create(null) as Record<string, string>, {
    get: (_target, name) => valueOf(name),
    has: (_target, name) => valueOf(name) !== undefined,
    ownKeys: () => Array.from(entries.values(), ([name]) => name),
    getOwnPropertyDescriptor: (_target, name) => {
      const value = valueOf(name);
      return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

/** A new rc holding `rc` plus each cperm `before()` default whose name `rc` lacks, compared case-insensitively. */
export function cpermDefaults(rc: RequestContext): RequestContext {
  const entries = new Map<string, readonly [string, string]>();
  for (const [name, value] of Object.entries(rc)) entries.set(name.toLowerCase(), [name, value]);
  for (const [name, value] of CPERM_RC_DEFAULTS) {
    if (!entries.has(name.toLowerCase())) entries.set(name.toLowerCase(), [name, value]);
  }
  return caseInsensitiveRc(entries);
}

/** The views' Back button group. */
export function renderBackNav(rb: Pick<RbLookup, 'rbKey'>): SafeHtml {
  const back = rb.rbKey('sitemanager.back');
  return html`<div class="nav-module-specific btn-group">
    <a class="btn" href="#" title="${raw(encodeHtmlAttr(back))}" onclick="window.history.back(); return false;"><i class="mi-arrow-circle-left"></i> ${back}</a>
  </div>`;
}

/** The empty group-list notice; `leadingSpace` reproduces the member-groups block of `cperm.main`. */
export function renderNoGroups(
  rb: Pick<RbLookup, 'rbKey'>,
  { leadingSpace = false }: { readonly leadingSpace?: boolean } = {},
): SafeHtml {
  const label = raw(rb.rbKey('permissions.nogroups'));
  return html`<div class="help-block-empty">${raw(leadingSpace ? ' ' : '')}${label}</div>`;
}

/** ColdFusion `HTMLEditFormat` as ACF 2023 applies it: carriage returns dropped, `&`, `<`, `>` and `"` as entities. */
export function htmlEditFormat(s: string): string {
  return s
    .replaceAll('\r', '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** One `contentManager.getCrumbList` entry as `dspZoom` reads it; the node first, the site root last. */
export interface ZoomCrumb {
  readonly menutitle: string;
  readonly siteid: string;
  readonly contentid: string;
  /** Absent reads as {@link CONTENT_MODULE_ID}. */
  readonly moduleid?: string;
  readonly type: string;
  readonly restricted: number;
  /** The class {@link renderIcon} yields for the crumb. */
  readonly icon: string;
}

/** The fields contentRenderer `renderIcon` reads; `iconClass` is the subtype's extension icon class, `''` if none. */
export interface ZoomIconSource {
  readonly iconClass: string;
  readonly type: string;
  /** Absent when the crumb carries no `fileExt` key. */
  readonly fileExt?: string;
}

/** contentRenderer `renderIcon`: the extension icon class, else the file extension or `page` for files, else type. */
export function renderIcon({ iconClass, type, fileExt }: ZoomIconSource): string {
  if (iconClass !== '') return iconClass;
  if (type.toLowerCase() !== 'file') return type.toLowerCase();
  return fileExt === undefined ? 'page' : fileExt.toLowerCase();
}

/** A crumb's opening `<li>`: the lock class, plus the file class and type for a file crumb without an `mi-` icon. */
function crumbItemTag(crumb: ZoomCrumb, locked: string): string {
  const iconPrefix = crumb.icon.split('-').find((part) => part !== '') ?? '';
  const isFileIcon = crumb.type.toLowerCase() === 'file' && iconPrefix.toLowerCase() !== 'mi';
  if (!isFileIcon) return `<li class="${locked}">`;
  return `<li class="${locked} file" data-filetype="${crumb.icon.slice(0, 4)}">`;
}

/** The Site Manager list URL of a crumb, with its values unencoded and `&` separators. */
function crumbLink(crumb: ZoomCrumb): string {
  const moduleid = crumb.moduleid ?? CONTENT_MODULE_ID;
  const params = { siteid: crumb.siteid, topid: crumb.contentid, moduleid, activeTab: 0 };
  return boundAdminUrl('cArch', 'list', params, { encode: 'raw' });
}

/** A crumb's anchor: its link, icon and HTMLEditFormat-ed menu title; `indent` is the template's tab depth. */
function crumbAnchor(crumb: ZoomCrumb, indent: string): string {
  const label = `<i class="${crumb.icon}"></i>${htmlEditFormat(crumb.menutitle)}`;
  return `${indent}<a \n${indent}\thref="${crumbLink(crumb)}"\n${indent}>${label}</a>`;
}

/**
 * Non-ajax `dspZoom`: the crumbs from the root down to the node, the node in `<strong>`, whitespace as ACF emits it.
 * @throws RangeError For an empty crumb list, where legacy fails reading the node crumb.
 */
export function renderZoom(
  crumbs: readonly ZoomCrumb[],
  { className = 'breadcrumb' }: { readonly className?: string } = {},
): SafeHtml {
  const node = crumbs[0];
  if (node === undefined) throw new RangeError('dspZoom needs at least the node crumb');
  let locked = '';
  let items = '';
  for (const crumb of crumbs.slice(1).reverse()) {
    // Never reset: every crumb after the first restricted ancestor, the node included, is marked locked.
    if (crumb.restricted === 1) locked = 'locked';
    items += `\n\t\t\t${crumbItemTag(crumb, locked)}\n${crumbAnchor(crumb, '\t\t\t')}</li>\n\t\t`;
  }
  const nodeItem = `${crumbItemTag(node, locked)}<strong>\n${crumbAnchor(node, '\t\t')}</strong></li>`;
  // Legacy writes the class, ids and icon classes unencoded; only the menu titles are escaped.
  return raw(`<ul class="${className}">\n\t\t${items}\n\t\t${nodeItem}\n\t\t</ul>`);
}
