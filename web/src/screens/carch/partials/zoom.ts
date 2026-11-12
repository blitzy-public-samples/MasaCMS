// The admin breadcrumb ("zoom") renderers carch views print through `$.dspZoom` and `$.dspZoomNoLinks` (server-only).
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { raw, type SafeHtml } from '@/lib/html';
import type { ScreenContext } from '../../registry';
import { CONTENT_MODULE_ID, structText, structValue, type CarchCrumb } from '../model';

/**
 * One `contentManager.getCrumbList` entry as the zoom renderers read it. Keys are read case-insensitively, as CFML
 * reads struct keys, so the open crumb structs strategies-content returns under `rc` pass unchanged.
 */
export interface ZoomCrumb extends CarchCrumb {
  readonly siteid: string;
  readonly contentid: string;
  /** Absent prints the Site Manager module id; present but null prints `''`. */
  readonly moduleid?: string | null;
  readonly type: string;
  /** The joined file's extension; a File crumb without the key renders the `page` icon. */
  readonly fileext?: string | null;
  readonly menutitle: string | null;
  /** `1` on an ancestor locks it and every crumb printed after it; the node's own flag is not read. */
  readonly restricted: number | string | null;
  /** The class-extension icon class strategies-content resolved for the crumb (`getIconClass`); absent reads as `''`. */
  readonly iconclass?: string | null;
}

/** Arguments of {@link dspZoom} and {@link dspZoomNoLinks}. */
export interface ZoomOptions {
  /** The node first, the site root last, as getCrumbList returns them; legacy fails on an empty list. */
  readonly crumbdata: readonly (ZoomCrumb | CarchCrumb)[];
  /** `breadcrumb` for dspZoom, `navZoom` for dspZoomNoLinks. */
  readonly class?: string;
  /** dspZoom only: links reload the Site Manager tab instead of opening `cArch.list`. */
  readonly ajax?: boolean;
  readonly charLimit?: number;
  readonly minLevels?: number;
  readonly maxLevels?: number;
}

type Crumb = ZoomCrumb | CarchCrumb;

/** The request whose `$` renderer the legacy views call; the markup itself reads only global settings. */
type ZoomContext = Pick<ScreenContext, 'req'>;

/** One rendered crumb with the lock class in force when it prints. */
interface ZoomItem {
  readonly crumb: Crumb;
  readonly locked: string;
}

/** ACF `HTMLEditFormat`: carriage returns dropped, `&`, `<`, `>` and `"` as entities, everything else kept. */
export function htmlEditFormat(s: string): string {
  return s
    .replaceAll('\r', '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const isFileCrumb = (crumb: Crumb): boolean => cfEq(structText(crumb, 'type'), 'File');

/** contentRenderer `renderIcon`: the extension icon class, else the file extension (`page` without one) or the type. */
export function renderIcon(crumb: Crumb): string {
  const iconClass = structText(crumb, 'iconclass');
  if (iconClass !== '') return iconClass;
  if (!isFileCrumb(crumb)) return structText(crumb, 'type').toLowerCase();
  return structValue(crumb, 'fileext') === undefined ? 'page' : structText(crumb, 'fileext').toLowerCase();
}

/** `crumbdata[i]`, 1-based; throws where ACF reports a missing array element. */
function crumbAt(crumbs: ZoomOptions['crumbdata'], i: number): Crumb {
  const crumb = crumbs[i - 1];
  if (crumb === undefined) throw new RangeError(`The element at position ${i} of the crumb array cannot be found.`);
  return crumb;
}

/** How many crumbs, counted from the node, print after the charLimit, minLevels and maxLevels rules. */
function crumbLength({ crumbdata, charLimit = 0, minLevels = 0, maxLevels = 0 }: ZoomOptions): number {
  let crumbLen = crumbdata.length;
  if (charLimit) {
    let charCount = 0;
    for (let i = 1; i <= crumbdata.length; i += 1) {
      // Legacy adds 3 per crumb for its icon width.
      charCount += structText(crumbAt(crumbdata, i), 'menutitle').length + 3;
      if (charCount >= charLimit) {
        crumbLen = i - 1;
        break;
      }
    }
  }
  if (minLevels && crumbLen < minLevels && minLevels <= crumbdata.length) crumbLen = minLevels;
  if (maxLevels && crumbLen > maxLevels && maxLevels <= crumbdata.length) crumbLen = maxLevels;
  return crumbLen;
}

/** The ancestors from the highest shown down to the parent, then the node, with the sticky lock each prints. */
function zoomItems(opts: ZoomOptions): { readonly ancestors: readonly ZoomItem[]; readonly node: ZoomItem } {
  const ancestors: ZoomItem[] = [];
  let locked = '';
  for (let i = crumbLength(opts); i >= 2; i -= 1) {
    const crumb = crumbAt(opts.crumbdata, i);
    // Never reset, and the node's own flag is not read: legacy computes it into an unused `lastlocked`.
    if (cfEq(structText(crumb, 'restricted'), '1')) locked = 'locked';
    ancestors.push({ crumb, locked });
  }
  return { ancestors, node: { crumb: crumbAt(opts.crumbdata, 1), locked } };
}

/** A crumb's opening `<li>` with `classes` first, plus the file class and type of a File crumb without an `mi-` icon. */
function itemTag(crumb: Crumb, icon: string, classes: string): string {
  const isFileIcon = isFileCrumb(crumb) && !cfEq(cfListToArray(icon, '-')[0] ?? '', 'mi');
  return isFileIcon ? `<li class="${classes} file" data-filetype="${icon.slice(0, 4)}">` : `<li class="${classes}">`;
}

/** A crumb's `href` (and, for ajax, `onclick`) attribute text, values unencoded as legacy writes them. */
function zoomHref(crumb: Crumb, ajax: boolean): string {
  const siteid = structText(crumb, 'siteid');
  const contentid = structText(crumb, 'contentid');
  const moduleid = structValue(crumb, 'moduleid') === undefined ? CONTENT_MODULE_ID : structText(crumb, 'moduleid');
  if (ajax) {
    const type = structText(crumb, 'type');
    return (
      'href="" onclick="return siteManager.loadSiteManagerInTab(function(){siteManager.loadSiteManager(' +
      `'${siteid}','${contentid}','${moduleid}','','','${type}',1)});"`
    );
  }
  const { context, adminDir } = legacySettings();
  return `href="${context}${adminDir}/?muraAction=cArch.list&siteid=${siteid}&topid=${contentid}&moduleid=${moduleid}&activeTab=0"`;
}

const menuTitle = (crumb: Crumb): string => htmlEditFormat(structText(crumb, 'menutitle'));

/** A dspZoom item: its `<li>`, then its anchor at the template's tab depth `indent`, `<strong>` around the node's. */
function linkedItem({ crumb, locked }: ZoomItem, ajax: boolean, indent: string, isNode: boolean): string {
  const icon = renderIcon(crumb);
  const [open, close] = isNode ? ['<strong>', '</strong>'] : ['', ''];
  const anchor = `${indent}<a \n${indent}\t${zoomHref(crumb, ajax)}\n${indent}><i class="${icon}"></i>${menuTitle(crumb)}</a>`;
  return `\n${indent}${itemTag(crumb, icon, locked)}${open}\n${anchor}${close}</li>`;
}

/** A dspZoomNoLinks item: the icon and lock classes, then the menu title, `<strong>` for the node. */
function plainItem({ crumb, locked }: ZoomItem, indent: string, isNode: boolean): string {
  const icon = renderIcon(crumb);
  const title = isNode ? `<strong>${menuTitle(crumb)}</strong>` : menuTitle(crumb);
  return `\n${indent}${itemTag(crumb, icon, `${icon} ${locked}`)} ${title}</li>`;
}

// Both templates print their tab-indented line breaks except whitespace-only text between two CFML tags, as ACF does.

/** contentRenderer `dspZoom`: the linked breadcrumb `<ul>`, root first, the node in `<strong>`. */
export function dspZoom(_ctx: ZoomContext, opts: ZoomOptions): SafeHtml {
  const ajax = opts.ajax ?? false;
  const { ancestors, node } = zoomItems(opts);
  const items = ancestors.map((ancestor) => `${linkedItem(ancestor, ajax, '\t\t\t', false)}\n\t\t`).join('');
  // Ids, module, type and class are written unencoded, as legacy writes them; only menu titles are escaped.
  return raw(`<ul class="${opts.class ?? 'breadcrumb'}">\n\t\t${items}${linkedItem(node, ajax, '\t\t', true)}\n\t\t</ul>`);
}

/** contentRenderer `dspZoomNoLinks`: the unlinked breadcrumb `<ul>`, root first, the node in `<strong>`. */
export function dspZoomNoLinks(_ctx: ZoomContext, opts: ZoomOptions): SafeHtml {
  const { ancestors, node } = zoomItems(opts);
  const items = ancestors.map((ancestor) => `${plainItem(ancestor, '\t\t\t', false)}\n\t\t`).join('');
  return raw(`\n\t\t<ul class="${opts.class ?? 'navZoom'}">\n\t\t${items}${plainItem(node, '\t\t', true)}\n\t\t</ul>`);
}
