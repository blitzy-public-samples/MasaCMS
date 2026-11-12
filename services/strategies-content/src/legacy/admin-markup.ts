/**
 * Pure markup primitives shared by the content admin renderers (`admin-render*.ts`): ESAPI encoders, resource-bundle
 * labels, the admin session and render context, and fragments several carch views print, as ACF 2023 renders them.
 */
import {
  LEGACY_ADMIN_SENTINEL_ID,
  adminUrl,
  cfEq,
  cfListToArray,
  cfLsDateFormat,
  cfNumberString,
  cfTimeFormat,
  cfToBoolean,
  esapiUrlEncode,
  renderCsrfFields,
  type CsrfTokens,
} from '@opt2/platform/legacy-compat';
import { cfHtmlEditFormat, type LegacySiteUrlConfig } from './content-urls.js';
import type { ContentRow, ExtendSubtypeRow, FileRow } from '../repo/tables.js';

export { cfHtmlEditFormat };

// --- Encoders ---
// web/src/lib/html.ts ports the same encoder; packages share code only through @opt2/platform, never another src/.

/** The `esapiEncode` contexts the admin views use. */
export type EsapiContext = 'html' | 'html_attr' | 'javascript' | 'url';

// HTMLEntityCodec's named entities in ESAPI 2.5.1.0 (the jar ACF 2023 ships): U+00A0..U+00FF in code point order,
// then `<hex>:<name>` pairs for the rest of the HTML 4 set.
const LATIN1_ENTITY_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute ' +
  'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig ' +
  'Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash ' +
  'Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ' +
  'ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc ' +
  'uuml yacute thorn yuml';
const OTHER_ENTITY_NAMES =
  '22:quot 26:amp 3c:lt 3e:gt 152:OElig 153:oelig 160:Scaron 161:scaron 178:Yuml 192:fnof 2c6:circ 2dc:tilde ' +
  '391:Alpha 392:Beta 393:Gamma 394:Delta 395:Epsilon 396:Zeta 397:Eta 398:Theta 399:Iota 39a:Kappa 39b:Lambda ' +
  '39c:Mu 39d:Nu 39e:Xi 39f:Omicron 3a0:Pi 3a1:Rho 3a3:Sigma 3a4:Tau 3a5:Upsilon 3a6:Phi 3a7:Chi 3a8:Psi 3a9:Omega ' +
  '3b1:alpha 3b2:beta 3b3:gamma 3b4:delta 3b5:epsilon 3b6:zeta 3b7:eta 3b8:theta 3b9:iota 3ba:kappa 3bb:lambda ' +
  '3bc:mu 3bd:nu 3be:xi 3bf:omicron 3c0:pi 3c1:rho 3c2:sigmaf 3c3:sigma 3c4:tau 3c5:upsilon 3c6:phi 3c7:chi 3c8:psi ' +
  '3c9:omega 3d1:thetasym 3d2:upsih 3d6:piv 2002:ensp 2003:emsp 2009:thinsp 200c:zwnj 200d:zwj 200e:lrm 200f:rlm ' +
  '2013:ndash 2014:mdash 2018:lsquo 2019:rsquo 201a:sbquo 201c:ldquo 201d:rdquo 201e:bdquo 2020:dagger 2021:Dagger ' +
  '2022:bull 2026:hellip 2030:permil 2032:prime 2033:Prime 2039:lsaquo 203a:rsaquo 203e:oline 2044:frasl 20ac:euro ' +
  '2111:image 2118:weierp 211c:real 2122:trade 2135:alefsym 2190:larr 2191:uarr 2192:rarr 2193:darr 2194:harr ' +
  '21b5:crarr 21d0:lArr 21d1:uArr 21d2:rArr 21d3:dArr 21d4:hArr 2200:forall 2202:part 2203:exist 2205:empty ' +
  '2207:nabla 2208:isin 2209:notin 220b:ni 220f:prod 2211:sum 2212:minus 2217:lowast 221a:radic 221d:prop ' +
  '221e:infin 2220:ang 2227:and 2228:or 2229:cap 222a:cup 222b:int 2234:there4 223c:sim 2245:cong 2248:asymp ' +
  '2260:ne 2261:equiv 2264:le 2265:ge 2282:sub 2283:sup 2284:nsub 2286:sube 2287:supe 2295:oplus 2297:otimes ' +
  '22a5:perp 22c5:sdot 2308:lceil 2309:rceil 230a:lfloor 230b:rfloor 2329:lang 232a:rang 25ca:loz 2660:spades ' +
  '2663:clubs 2665:hearts 2666:diams';

const HTML_ENTITIES: ReadonlyMap<number, string> = new Map([
  ...LATIN1_ENTITY_NAMES.split(' ').map((name, i): [number, string] => [0xa0 + i, name]),
  ...OTHER_ENTITY_NAMES.split(' ').map((pair): [number, string] => {
    const [hex = '', name = ''] = pair.split(':');
    return [Number.parseInt(hex, 16), name];
  }),
]);

// DefaultEncoder's IMMUNE_HTML, IMMUNE_HTMLATTR and IMMUNE_JAVASCRIPT sets; ASCII letters and digits are never encoded.
const IMMUNE: Readonly<Record<Exclude<EsapiContext, 'url'>, string>> = { html: ',.-_ ', html_attr: ',.-_', javascript: ',._' };

function isAsciiAlphanumeric(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

/** HTMLEntityCodec.encodeCharacter of one code point; a lone surrogate arrives as its code unit. */
function htmlEntity(cp: number): string {
  // C0 controls other than tab, LF and CR, and DEL through the C1 range, are replaced by U+FFFD.
  if ((cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) return '&#xfffd;';
  const name = HTML_ENTITIES.get(cp);
  return name === undefined ? `&#x${cp.toString(16)};` : `&${name};`;
}

/** JavaScriptCodec.encodeCharacter: `\xHH` below 256, `\uHHHH` in the BMP; ESAPI 2.5 returns other code points as is. */
function javascriptEscape(ch: string, cp: number): string {
  if (cp > 0xffff) return ch;
  const hex = cp.toString(16).toUpperCase();
  return cp < 0x100 ? `\\x${hex.padStart(2, '0')}` : `\\u${hex.padStart(4, '0')}`;
}

/**
 * ACF `esapiEncode(kind, s)`: ESAPI DefaultEncoder encodeForHTML, encodeForHTMLAttribute, encodeForJavaScript or
 * encodeForURL. A NULL column encodes as '' and a number as ACF prints it.
 */
export function esapiEncode(kind: EsapiContext, s: string | number | null): string {
  const text = s === null ? '' : typeof s === 'number' ? cfNumberString(s) : s;
  if (kind === 'url') return esapiUrlEncode(text);
  const immune = IMMUNE[kind];
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    // ESAPI tests immunity on the code point cast to a char, so U+1002C passes wherever ',' is immune.
    if (isAsciiAlphanumeric(cp) || immune.includes(String.fromCharCode(cp & 0xffff))) out += ch;
    else out += kind === 'javascript' ? javascriptEscape(ch, cp) : htmlEntity(cp);
  }
  return out;
}

/** CF `YesNoFormat`: `Yes` for a true value, `No` for false or an empty value; throws for a non-boolean string. */
export function yesNoFormat(v: boolean | number | string | null): 'Yes' | 'No' {
  if (v === null || v === '') return 'No';
  return cfToBoolean(v) ? 'Yes' : 'No';
}

// --- Labels ---

/** Resource-bundle labels of one admin locale. */
export interface AdminLabels {
  /** `rbFactory.getKeyValue(session.rb, key)`. */
  key(k: string): string;
  /** `rbFactory.getResourceBundle(session.rb).messageFormat(pattern, args)`; a string argument is split as a CF list. */
  messageFormat(pattern: string, args: unknown[] | string): string;
}

/** CF struct semantics for bundle keys: case-insensitive, a later key overwriting an earlier one. */
function noCaseMap(bundle: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(bundle).map(([k, v]): [string, string] => [k.toLowerCase(), v]));
}

/** Index of the `}` closing the format element opened before `from`, counting nested braces; -1 when unmatched. */
function closingBrace(pattern: string, from: number): number {
  let depth = 0;
  for (let i = from; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}' && depth-- === 0) return i;
  }
  return -1;
}

/** Java MessageFormat's rendering of an untyped argument. */
function formatArgument(v: unknown, formatNumber: (n: number) => string): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return String(v);
  throw new TypeError(`Unsupported MessageFormat argument ${String(v)}`);
}

/**
 * java.text.MessageFormat for a pattern whose quotes were all doubled first, so `''` is a literal quote and no text is
 * quoted. Typed elements (`{1,number}`) fail fast: no Masa bundle uses them.
 */
function javaMessageFormat(pattern: string, args: readonly unknown[], formatNumber: (n: number) => string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    const end = closingBrace(pattern, i + 1);
    if (end < 0) throw new RangeError('Unmatched braces in the pattern.');
    const [indexText = '', type = ''] = pattern.slice(i + 1, end).split(',');
    if (type.trim() !== '') throw new RangeError(`Unsupported MessageFormat element ${pattern.slice(i, end + 1)}`);
    const index = Number(indexText);
    // Integer.parseInt: optional sign, ASCII digits, int range.
    if (!/^[+-]?[0-9]+$/.test(indexText) || index > 2_147_483_647 || index < -2_147_483_648) {
      throw new RangeError(`can't parse argument number: ${indexText}`);
    }
    if (index < 0) throw new RangeError(`negative argument number: ${index}`);
    out += index >= args.length ? `{${index}}` : formatArgument(args[index], formatNumber);
    i = end + 1;
  }
  return out;
}

/**
 * Labels over `bundle` (the locale's keys, site overrides over core) and `enUsBundle` (the en_US fallback, consulted
 * as resourceBundleFactory.cfc:120-147 does: core keys before site keys); a key in neither prints `<key>_missing`.
 * `javaLocale` (the bundle locale, e.g. `en_US`) groups numeric messageFormat arguments as Java NumberFormat does.
 */
export function createAdminLabels(
  bundle: Readonly<Record<string, string>>,
  enUsBundle: Readonly<Record<string, string>> = {},
  javaLocale = 'en_US',
): AdminLabels {
  const primary = noCaseMap(bundle);
  const fallback = noCaseMap(enUsBundle);
  const numberFormat = new Intl.NumberFormat(javaLocale.split('_').slice(0, 2).join('-'), {
    maximumFractionDigits: 3,
    roundingMode: 'halfEven',
  });
  return {
    key(k: string): string {
      const value = primary.get(k.toLowerCase()) ?? fallback.get(k.toLowerCase());
      // resourceBundle.cfc:212 un-doubles quotes on every read.
      return value === undefined ? `${k}_missing` : value.replaceAll("''", "'");
    },
    messageFormat(pattern: string, args: unknown[] | string): string {
      const list = typeof args === 'string' ? cfListToArray(args) : args;
      // resourceBundle.cfc:177-193 doubles every quote and prepends a dummy argument, so `{1}` is the first value.
      return javaMessageFormat(pattern.replaceAll("'", "''"), ['', ...list], (n) => numberFormat.format(n));
    },
  };
}

// --- Session and render context ---

/** Site Manager state the legacy session keeps between requests; renderers return changes to it as session effects. */
export interface AdminSessionState {
  /** `session.openSectionList`: CF list of the expanded content ids. */
  openSectionList: string;
  /** `session.flatViewArgs`, keyed by site id. */
  flatViewArgs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** `session.copyContentID`, '' when nothing is copied. */
  copyContentId: string;
  /** `session.copySiteID`. */
  copySiteId: string;
  /** `session.copyAll`. */
  copyAll: boolean;
}

/** The session values the admin views read: `session.mura.*` from the identity login snapshot plus the admin state. */
export interface AdminSession extends AdminSessionState {
  /** `session.mura.userID`. */
  userId: string;
  /** `session.siteid`: the site the admin is working in. */
  siteId: string;
  /** `session.mura.memberships`: CF list such as `S2IsPrivate;<poolId>,S2,Admin;<poolId>;0`. */
  memberships: string;
  /** `session.mura.nextN`: Site Manager rows per page. */
  nextN: number;
  /** `session.dateKeyFormat`; en_US `MM/DD/YYYY` prints the day of the year (the known `10/302/2026` mask). */
  dateKeyFormat: string;
  /** `session.rb`: the admin resource-bundle locale. */
  rb: string;
}

/** settingsBean values the views read for the request's site. */
export interface AdminSiteSettings {
  /** `getLocking()`: `none`, `top`, `all`, or '' as stored. */
  locking: string;
  /** `getHasComments()` as the views test it (`isBoolean(v) and v`). */
  hasComments: boolean;
  /** `siteConfig('hasLockableNodes')`. */
  hasLockableNodes: boolean;
  /** `getPrivateUserPoolID()`. */
  privateUserPoolId: string;
  /** `getExtranet()`. */
  extranet: boolean;
}

/** configBean values the views read. */
export interface AdminConfig {
  /** `getSortPermission()`: `author` lets authors sort, '' leaves sorting to editors. */
  sortPermission: string;
  /** `getAdminDir()`, Masa default `/admin`. */
  adminDir: string;
  /** `getContext()`. */
  context: string;
}

/** Everything a renderer reads besides its model; CSRF tokens are minted by identity for the session. */
export interface AdminRenderContext {
  labels: AdminLabels;
  session: AdminSession;
  site: LegacySiteUrlConfig;
  siteSettings: AdminSiteSettings;
  config: AdminConfig;
  /** `generateCSRFTokens(context=…)` for this session. */
  csrf: (context: string) => CsrfTokens;
}

/** `listFind(session.mura.memberships, 'S2')`. */
export function isS2(session: Pick<AdminSession, 'memberships'>): boolean {
  return cfListToArray(session.memberships).includes('S2');
}

/** `listFind(session.mura.memberships, 'Admin;<privateUserPoolID>;0')`: membership of the site's Admin group. */
export function isSiteAdmin(session: Pick<AdminSession, 'memberships'>, privatePoolId: string): boolean {
  return cfListToArray(session.memberships).includes(`Admin;${privatePoolId};0`);
}

// --- Shared fragments ---

/** `$.renderCSRFTokens(context, format='url')`: `&csrf_token=…&csrf_token_expires=…`. */
export function renderCsrfTokensUrl(tokens: CsrfTokens): string {
  return renderCsrfFields(tokens, 'url');
}

/** `$.renderCSRFTokens(context, format='form')`: the two hidden inputs. */
export function renderCsrfTokensForm(tokens: CsrfTokens): string {
  return renderCsrfFields(tokens, 'form');
}

/** CF `LSDateFormat(date, mask)` for en_US (`short`, `long`, `session.dateKeyFormat`); a NULL column prints ''. */
export function lsDateFormat(date: Date | null, mask: string): string {
  return date === null ? '' : cfLsDateFormat(date, mask);
}

/** CF `LSTimeFormat(date, mask)` for en_US (`short` prints `9:06 AM`); a NULL column prints ''. */
export function lsTimeFormat(date: Date | null, mask: string): string {
  return date === null ? '' : cfTimeFormat(date, mask);
}

/** The paging struct of `utility.getNextN`. */
export interface NextN {
  totalRecords: number;
  recordsPerPage: number;
  numberOfPages: number;
  currentPageNumber: number;
  firstPage: number;
  lastPage: number;
  /** Start row of the next page; 1 when there is none. */
  next: number;
  /** Start row of the previous page (1 on the first page). */
  previous: number;
  /** Last row shown on the current page. */
  through: number;
  startRow: number;
}

/** `utility.getNextN(recordCount, recordsPerPage, startRow, pageBuffer)` (utility.cfc:126-180). */
export function getNextN(recordCount: number, recordsPerPage: number, startRow: number, pageBuffer = 5): NextN {
  if (recordsPerPage === 0) throw new RangeError('Division by zero is not allowed.');
  const numberOfPages = Math.ceil(recordCount / recordsPerPage);
  const currentPageNumber = Math.ceil(startRow / recordsPerPage);
  let firstPage = currentPageNumber > pageBuffer ? currentPageNumber - pageBuffer : 1;
  const lastPage = Math.min(firstPage + 2 * pageBuffer, numberOfPages);
  if (lastPage - firstPage < 2 * pageBuffer) firstPage = Math.max(1, lastPage - 2 * pageBuffer);
  const next = (currentPageNumber + 1) * recordsPerPage - recordsPerPage + 1;
  const previous = Math.max(currentPageNumber - 1, 1) * recordsPerPage - recordsPerPage + 1;
  return {
    totalRecords: recordCount,
    recordsPerPage,
    numberOfPages,
    currentPageNumber,
    firstPage,
    lastPage,
    next: next > recordCount ? 1 : next,
    previous,
    through: recordCount < next ? recordCount : next - 1,
    startRow,
  };
}

/** `extendManager.getCustomIconClass(siteid, type, subtype)`: '' when no subtype of that site sets an icon class. */
export type CustomIconLookup = (siteId: string, type: string, subtype: string) => string;

const NO_CUSTOM_ICONS: CustomIconLookup = () => '';
const ICON_LOOKUP_TYPES: readonly string[] = ['page', 'folder', 'calendar', 'gallery', 'file', 'link', 'portal'];

/** CF nested-struct key `iconlookup[siteid][type & subtype]`, case-insensitive. */
function iconLookupKey(siteId: string, type: string, subtype: string): string {
  return `${siteId.toLowerCase()}\u0000${(type + subtype).toLowerCase()}`;
}

/** extendManager's icon lookup (extendManager.cfc:154-180) over `content.extend_subtype` rows in query order. */
export function buildCustomIconLookup(
  rows: ReadonlyArray<Pick<ExtendSubtypeRow, 'siteid' | 'type' | 'subtype' | 'iconclass'>>,
): CustomIconLookup {
  const lookup = new Map<string, string>();
  for (const row of rows) {
    const type = row.type ?? '';
    if (!ICON_LOOKUP_TYPES.includes(type.toLowerCase())) continue;
    lookup.set(iconLookupKey(row.siteid ?? '', type, row.subtype ?? ''), (row.iconclass ?? '').replace('icon-', 'mi-'));
  }
  return (siteId, type, subtype) => lookup.get(iconLookupKey(siteId, type, subtype)) ?? '';
}

// extendManager.getIconClass defaults, matched case-insensitively as cfswitch matches.
const DEFAULT_ICON_CLASSES: ReadonlyMap<string, string> = new Map([
  ['page', 'mi-file'],
  ['folder', 'mi-folder-open-o'],
  ['file', 'mi-file-text-o'],
  ['link', 'mi-link'],
  ['calendar', 'mi-calendar'],
  ['gallery', 'mi-th'],
  ['form', 'mi-toggle-on'],
  ['component', 'mi-align-justify'],
  ['variation', 'mi-cloud'],
  ['1', 'mi-group'],
  ['2', 'mi-user'],
]);

/** `contentRenderer.renderIcon(data)`, i.e. extendManager.getIconClass: the custom class, else the type's default. */
export function iconClass(
  customIcons: CustomIconLookup,
  row: Pick<ContentRow, 'siteid' | 'type' | 'subtype'>,
): string {
  const custom = customIcons(row.siteid ?? '', row.type ?? '', row.subtype ?? '');
  if (custom !== '') return custom;
  return DEFAULT_ICON_CLASSES.get((row.type ?? '').toLowerCase()) ?? 'mi-cog';
}

/** The crumb fields dspZoom reads (contentGateway.buildCrumblist); an absent `moduleid` prints the Site Manager module. */
export type ZoomCrumb = Pick<ContentRow, 'siteid' | 'contentid' | 'type' | 'subtype' | 'menutitle' | 'restricted'> &
  Partial<Pick<ContentRow, 'moduleid'>>;

/** Options of {@link renderZoom}; `context` and `adminDir` are the configBean values non-ajax links start with. */
export interface ZoomOptions {
  ajax?: boolean;
  class?: string;
  customIcons?: CustomIconLookup;
  context?: string;
  adminDir?: string;
}

const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

/** One crumb's `<li>`; `indent` is the template's tab depth, `last` adds the `<strong>` wrapper of the current node. */
function zoomItem(crumb: ZoomCrumb, locked: string, indent: string, last: boolean, opts: ZoomOptions): string {
  const siteId = crumb.siteid ?? '';
  const contentId = crumb.contentid ?? '';
  const moduleId = crumb.moduleid === undefined ? SITE_MANAGER_MODULE_ID : (crumb.moduleid ?? '');
  const type = crumb.type ?? '';
  const icon = iconClass(opts.customIcons ?? NO_CUSTOM_ICONS, crumb);
  const fileIcon = cfEq(type, 'File') && !cfEq(cfListToArray(icon, '-')[0] ?? '', 'mi');
  const href = opts.ajax
    ? 'href="" onclick="return siteManager.loadSiteManagerInTab(function(){siteManager.loadSiteManager(' +
      `'${siteId}','${contentId}','${moduleId}','','','${type}',1)});"`
    : `href="${adminUrl({
        circuit: 'cArch',
        action: 'list',
        params: [
          ['siteid', siteId, 'raw'],
          ['topid', contentId, 'raw'],
          ['moduleid', moduleId, 'raw'],
          ['activeTab', 0, 'raw'],
        ],
        context: opts.context,
        adminDir: opts.adminDir,
      })}"`;
  const [open, close] = last ? ['<strong>', '</strong>'] : ['', ''];
  return (
    `\n${indent}<li class="${locked}${fileIcon ? ' file' : ''}"${fileIcon ? ` data-filetype="${icon.slice(0, 4)}"` : ''}>` +
    `${open}\n${indent}<a \n${indent}\t${href}\n${indent}><i class="${icon}"></i>` +
    `${cfHtmlEditFormat(crumb.menutitle ?? '')}</a>${close}</li>`
  );
}

/**
 * `$.dspZoom(crumbdata, ajax, class)` (contentRendererUtility.cfc:696-766): the breadcrumb `<ul>`, ancestors first,
 * with the whitespace ACF prints. `crumbs` is leaf first, as getCrumbList returns it; no admin view passes charLimit,
 * minLevels or maxLevels, so they are not ported.
 */
export function renderZoom(crumbs: readonly ZoomCrumb[], opts: ZoomOptions = {}): string {
  const current = crumbs[0];
  if (current === undefined) throw new RangeError('dspZoom needs at least one crumb');
  let locked = '';
  let out = `<ul class="${opts.class ?? 'breadcrumb'}">\n\t\t`;
  for (let i = crumbs.length - 1; i >= 1; i--) {
    const crumb = crumbs[i] as ZoomCrumb;
    // Once an ancestor is restricted, every later item, the current node included, is marked locked.
    if (crumb.restricted === 1) locked = 'locked';
    out += `${zoomItem(crumb, locked, '\t\t\t', false, opts)}\n\t\t`;
  }
  return `${out}${zoomItem(current, locked, '\t\t', true, opts)}\n\t\t</ul>`;
}

/** The fields of a Site Manager row its icon is chosen from: type, subtype and the joined file's extension and name. */
export type NodeIconRow = Pick<ContentRow, 'type' | 'subtype'> &
  Pick<FileRow, 'fileext'> & { assocfilename: FileRow['filename'] };

/**
 * Site Manager node icon class (loadsitemanager.cfm:125-144, dsp_nest.cfm:160-180) before the views print it through
 * `lcase`; `customIconClass` is the row's {@link CustomIconLookup} value, `restricted` the node's restriction.
 */
export function nodeIconClass(
  row: Pick<NodeIconRow, 'type' | 'subtype' | 'fileext'>,
  opts: { customIconClass: string; restricted: boolean },
): string {
  const locked = opts.restricted ? ' locked' : '';
  if (cfEq(row.type ?? '', 'File')) return `${opts.customIconClass || (row.fileext ?? '').toLowerCase()}${locked}`;
  return `${opts.customIconClass || `icon-mura-${(row.type ?? '').toLowerCase()}`}${locked} ${row.subtype ?? ''}`;
}

const PREVIEW_IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'gif'];

/** `isFileIcon` of loadsitemanager.cfm:145 and dsp_nest.cfm:181: a non-image File row whose icon is not `icon-…`. */
export function isFileIcon(row: Pick<NodeIconRow, 'type' | 'assocfilename'>, icon: string): boolean {
  const extension = cfListToArray(row.assocfilename ?? '', '.').at(-1) ?? '';
  return (
    cfEq(row.type ?? '', 'File') &&
    !cfEq(cfListToArray(icon, '-')[0] ?? '', 'icon') &&
    !PREVIEW_IMAGE_EXTENSIONS.includes(extension.toLowerCase())
  );
}

/** A `permUtility` node verdict as the views compare it. */
export type NodePerm = 'editor' | 'author' | 'read' | 'none' | 'deny';

/**
 * The `newcontent` permission handed to `siteManager.showMenu`: loadsitemanager.cfm:117-123 for the top node
 * `topId`; with `topId` undefined, the dsp_nest.cfm:144-150 and loadsiteflat.cfm:600-606 rule for listed rows.
 */
export function newContentPerm(topId: string | undefined, perm: NodePerm, locking: string): NodePerm {
  const isHome = topId !== undefined && cfEq(topId, LEGACY_ADMIN_SENTINEL_ID);
  if (!cfEq(locking, 'all') && (!isHome || cfEq(locking, 'none'))) return perm;
  return perm !== 'none' ? 'read' : 'none';
}
