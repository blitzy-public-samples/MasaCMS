// The `cArch.list` Site Manager page of `carch/list.cfm`: the content modules' tree and flat-view tabs, and the
// LEGACY module grid (server-only).
import { cfEq, cfIsNumeric, cfLsDateFormat, cfLsTimeFormat, cfToBoolean } from '@opt2/platform/legacy-compat';
import { parseLegacyDate } from '@/lib/dates';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, raw, type SafeHtml } from '@/lib/html';
import {
  ORIGINAL_URL_HEADER,
  sessionSiteModulePerm,
  setSessionMuraValue,
  type AdminRequest,
} from '@/lib/request-context';
import { adminAssetUrl } from '@/lib/urls';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import {
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
  isSiteAdminOrS2,
  structText,
  structValue,
  type CarchStruct,
} from './model';
import { categoriesNest, type CategoryNestNode } from './partials/categories-nest';
import { draftPromptJs } from './partials/draft-prompt-js';
import { carchJs } from './partials/js';
import { scaffold } from './partials/scaffold';
import { renderCarchSecondaryMenu } from './secondary-menu';
import { applySessionEffects, carchPageData, type CarchPageModel } from './service';

/** Custom Entities (scaffolder) module. */
const SCAFFOLD_MODULE_ID = '00000000000000000000000000000000016';

/** The `cfcase` of the content modules, in legacy order. */
const CONTENT_CASE = Object.freeze([VARIATION_MODULE_ID, COMPONENT_MODULE_ID, FORM_MODULE_ID, CONTENT_MODULE_ID]);

/** The `cfswitch rc.moduleid` branch a request takes; `none` renders nothing. */
type ListCase = 'legacy' | 'content' | 'none';

/** What one `cArch.list` request renders from. */
export interface ListData {
  readonly listCase: ListCase;
  /** The strategies-content model: `rc` as carch `list()` and the view's own logic leave it. */
  readonly model: CarchPageModel;
  /** URL-scope values by lower-cased name. */
  readonly url: ReadonlyMap<string, string>;
  /** Whether the content modules' `nextN` branch set `rc.startrow=1`. */
  readonly startRowReset: boolean;
}

/** A load outcome: the page data, or the `cflocation` legacy answers with instead. */
type ListOutcome =
  | { readonly kind: 'page'; readonly data: ListData }
  | { readonly kind: 'location'; readonly location: string };

// ---- CFML values ----

// Java Character.isWhitespace, which ACF whitespace management applies to the last character it wrote.
const ENDS_IN_WHITESPACE = /[\t-\r\u001c-\u001f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]$/;

/** One ACF output buffer under whitespace management. */
class CfOut {
  #body = '';

  /** Text holding a non-whitespace character, or expression values: written verbatim. */
  t(...parts: string[]): this {
    for (const part of parts) this.#body += part;
    return this;
  }

  /** A whitespace-only template run: one space after non-whitespace output, else nothing. */
  ws(): this {
    if (this.#body !== '' && !ENDS_IN_WHITESPACE.test(this.#body)) this.#body += ' ';
    return this;
  }

  toString(): string {
    return this.#body;
  }
}

/** `rc[name]` by case-insensitive name, as a CFML scope reads it. */
function rcValue(rc: Rc, name: string): string | undefined {
  if (Object.hasOwn(rc, name)) return rc[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** `rc[name]`, failing as CFML does when the element is undefined. */
function rcText(rc: Rc, name: string): string {
  const value = rcValue(rc, name);
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** `struct[key]`, failing as CFML does when the element is undefined in `scope`. */
function required(struct: CarchStruct, key: string, scope: string): unknown {
  const value = structValue(struct, key);
  if (value === undefined) throw new TypeError(`Element ${key.toUpperCase()} is undefined in ${scope}.`);
  return value;
}

/** A simple `struct[key]` as CFML text, failing when it is undefined. */
function requiredText(struct: CarchStruct, key: string, scope: string): string {
  required(struct, key, scope);
  return structText(struct, key);
}

/** A nested struct of `struct`, failing when it is undefined or not a struct. */
function requiredStruct(struct: CarchStruct, key: string, scope: string): CarchStruct {
  const value = required(struct, key, scope);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${key} is not a struct`);
  return value as CarchStruct;
}

/** A query of `struct` as its rows. */
function requiredRows(struct: CarchStruct, key: string, scope: string): CarchStruct[] {
  const value = required(struct, key, scope);
  if (!Array.isArray(value)) throw new TypeError(`${key} is not a query`);
  return value as CarchStruct[];
}

/** CFML truthiness of `struct[key]`, failing when it is undefined. */
const requiredFlag = (struct: CarchStruct, key: string, scope: string): boolean =>
  cfToBoolean(required(struct, key, scope));

/** CFML list items over a set of single-character delimiters; empty items are skipped. */
function listItems(list: string, delimiters = ','): string[] {
  const items: string[] = [];
  let item = '';
  for (const ch of list) {
    if (!delimiters.includes(ch)) {
      item += ch;
      continue;
    }
    if (item !== '') items.push(item);
    item = '';
  }
  if (item !== '') items.push(item);
  return items;
}

/** CFML `listFindNoCase(list, value) > 0`. */
const listFindNoCase = (list: string, value: string): boolean =>
  listItems(list).some((item) => item.toLowerCase() === value.toLowerCase());

/** CFML `a gt b`: numeric when both are numbers, else `compareNoCase`. */
function cfGt(a: string, b: string): boolean {
  if (cfIsNumeric(a) && cfIsNumeric(b)) return Number(a) > Number(b);
  return a.toLowerCase() > b.toLowerCase();
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

// ACF 2023 serializeJSON leaves '/' and non-ASCII raw and writes the other C0 characters and DEL as lowercase \u00xx.
const JSON_SPECIALS = /["\\\u0000-\u001F\u007F]/g;

/** ACF `serializeJSON(listToArray(list, '^,'))`: the custom tag groups as a JSON array of strings. */
function tagGroupsJson(groups: readonly string[]): string {
  const escape = (item: string): string =>
    item.replace(JSON_SPECIALS, (c) => JSON_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `[${groups.map((group) => `"${escape(group)}"`).join(',')}]`;
}

/** A query date cell: null for SQL NULL and `''`, ACF's error for a value it cannot read as a date. */
function dateCell(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'string' || value instanceof Date ? parseLegacyDate(value) : null;
  if (date === null) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    throw new RangeError(`The value ${text} cannot be converted to a date.`);
  }
  return date;
}

/** `LSDateFormat(value, mask)` under the session locale; `''` for NULL. */
function lsDate(value: unknown, mask: string, locale: string): string {
  const date = dateCell(value);
  return date === null ? '' : cfLsDateFormat(date, mask, locale);
}

/** `LSTimeFormat(value, mask)` under the session locale; `''` for NULL. */
function lsTime(value: unknown, mask: string, locale: string): string {
  const date = dateCell(value);
  return date === null ? '' : cfLsTimeFormat(date, mask, locale);
}

/** The `cfswitch rc.moduleid` branch of `moduleId`, matched with CFML `eq` as `cfcase` matches. */
function listCaseOf(moduleId: string): ListCase {
  if (cfEq(moduleId, 'LEGACY')) return 'legacy';
  return CONTENT_CASE.some((id) => cfEq(moduleId, id)) ? 'content' : 'none';
}

// ---- Request scopes and session writes ----

/** URL-scope values by lower-cased name: the forwarded request target's query, else the names of `rc.currentURL`. */
function urlScope(req: AdminRequest): ReadonlyMap<string, string> {
  const scope = new Map<string, string>();
  const target = req.headers.get(ORIGINAL_URL_HEADER);
  if (target !== null) {
    const query = target.includes('?') ? target.slice(target.indexOf('?') + 1) : '';
    for (const [name, value] of new URLSearchParams(query)) {
      if (name === '') continue;
      const key = name.toLowerCase();
      const previous = scope.get(key);
      scope.set(key, previous === undefined ? value : `${previous},${value}`);
    }
    return scope;
  }
  // `rc.currentURL` lists each URL-scope entry once with its decoded value, which may itself hold `&`; rc holds the
  // same value wherever no form field of that name overrides it.
  for (const pair of req.currentUrl.replace(/^\.\/\??/, '').split('&')) {
    const at = pair.indexOf('=');
    const name = at < 0 ? pair : pair.slice(0, at);
    const key = name.toLowerCase();
    if (name === '' || scope.has(key)) continue;
    const value = rcValue(req.formScope, name) === undefined ? rcValue(req.rc, name) : undefined;
    scope.set(key, value ?? (at < 0 ? '' : pair.slice(at + 1)));
  }
  return scope;
}

// strategies-content keeps `flatViewArgs` and reads `url.keywords` only, so `keywords` travels only from the URL scope.
/** The rc the service runs the controller and view over: `keywords` as the URL scope holds it, or absent. */
function serviceRc(rc: Rc, url: ReadonlyMap<string, string>): Rc {
  const fields = Object.fromEntries(Object.entries(rc).filter(([name]) => name.toLowerCase() !== 'keywords'));
  const keywords = url.get('keywords');
  return keywords === undefined ? fields : { ...fields, keywords };
}

/** The view's web-held session writes (`mura.nextN`, `moduleid`, `keywords`); true when `nextN` reset `rc.startrow`. */
function applyContentSessionWrites(req: AdminRequest, url: ReadonlyMap<string, string>): boolean {
  const nextN = rcValue(req.rc, 'nextN');
  const reset = nextN !== undefined && cfGt(nextN, '0');
  if (reset) setSessionMuraValue(req, 'nextN', nextN);
  // An unset session.moduleid reads as ''; before() always sets it outside ajax requests.
  if (req.session.moduleid === '') applySessionEffects(req, { moduleid: encodeUrl(rcText(req.rc, 'moduleid')) });
  const keywords = url.get('keywords');
  if (keywords !== undefined) applySessionEffects(req, { keywords });
  return reset;
}

/** `./?muraAction=cArch.list&siteid=…` of the Site Manager root, the view's `cflocation` without crumbs. */
const rootListLocation = (siteId: string): string =>
  `./?muraAction=cArch.list&siteid=${encodeUrl(siteId)}&moduleid=${CONTENT_MODULE_ID}&topid=${ROOT_CONTENT_ID}`;

/** Whether `getCrumbList(rc.topid)` found no crumb with a site id (list.cfm 636). */
function lacksCrumbs(model: CarchPageModel): boolean {
  const crumbs = requiredRows(model.rc, 'crumbdata', 'RC');
  const first = crumbs[0];
  return first === undefined || requiredText(first, 'siteid', 'CRUMBDATA[1]') === '';
}

const LOADS = new WeakMap<ScreenContext, Promise<ListOutcome>>();

/** carch before() and `list()`, then the view's session writes and redirect test; run once per screen context. */
function loadList(ctx: ScreenContext): Promise<ListOutcome> {
  let pending = LOADS.get(ctx);
  if (pending === undefined) {
    pending = runList(ctx);
    LOADS.set(ctx, pending);
  }
  return pending;
}

async function runList(ctx: ScreenContext): Promise<ListOutcome> {
  ctx.req = applyCarchDefaults(ctx.req);
  const { req } = ctx;
  const url = urlScope(req);
  const listCase = listCaseOf(rcText(req.rc, 'moduleid'));
  const outcome = await carchPageData(ctx, 'list', serviceRc(req.rc, url));
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`strategies-content rejected the carch.list read with HTTP ${outcome.status}`);
  }
  const model = outcome.data;
  if (listCase !== 'content') {
    return { kind: 'page', data: { listCase, model, url, startRowReset: false } };
  }
  const startRowReset = applyContentSessionWrites(req, url);
  if (lacksCrumbs(model)) return { kind: 'location', location: rootListLocation(rcText(req.rc, 'siteid')) };
  return { kind: 'page', data: { listCase, model, url, startRowReset } };
}

// ---- LEGACY module (list.cfm 82-453) ----

/** One `rc.rsTop` row of the LEGACY grid with the verdict and lock state the view's `cfsilent` derives. */
interface LegacyRow {
  readonly row: CarchStruct;
  readonly verdict: string;
  readonly lockedBySomeoneElse: boolean;
  readonly deletable: boolean;
}

/** What the LEGACY grid reads from `rc`, the model and the session. */
interface LegacyScope {
  readonly ctx: ScreenContext;
  readonly label: (key: string) => string;
  readonly siteId: string;
  readonly topId: string;
  readonly moduleId: string;
  readonly locale: string;
}

/** A positive integer attribute of `cfoutput query` or `cfloop`, as ACF reads it. */
function integerAttribute(value: string, name: string): number {
  if (!cfIsNumeric(value)) throw new TypeError(`The value of the ${name} attribute, ${value}, is not an integer.`);
  return Math.trunc(Number(value.trim()));
}

/** The rows `cfoutput query="rc.rsTop" maxrows startrow` iterates, each with its `cfsilent` values. */
function legacyRows(model: CarchStruct, rc: Rc, perm: string, userId: string): LegacyRow[] {
  const rows = requiredRows(model, 'rsTop', 'RC');
  const nextN = requiredStruct(model, 'nextN', 'RC');
  const maxRows = integerAttribute(requiredText(nextN, 'recordsperpage', 'NEXTN'), 'maxrows');
  const startRow = integerAttribute(rcText(rc, 'startrow'), 'startrow');
  const siteConfig = requiredStruct(model, 'siteConfig', 'RC');
  const parentId = rcText(rc, 'parentid');
  const topId = requiredText(model, 'topid', 'RC');
  const first = Math.max(startRow, 1) - 1;
  return rows.slice(first, first + Math.max(maxRows, 0)).map((row) => {
    const lockedBySomeoneElse =
      requiredFlag(siteConfig, 'hasLockableNodes', 'siteConfig') &&
      requiredText(row, 'lockid', 'RSTOP') !== '' &&
      !cfEq(requiredText(row, 'lockid', 'RSTOP'), userId);
    let verdict = 'editor';
    if (!cfEq(perm, 'editor')) {
      // getPerm(rc.rstop.contentid, rc.siteid), as strategies-content computed it for the row.
      verdict = requiredText(row, 'perm', 'RSTOP');
      if (cfEq(verdict, 'deny')) verdict = 'none';
      else if (cfEq(verdict, 'none')) verdict = perm;
    }
    const locking = rcText(rc, 'locking');
    const deletable =
      (!cfEq(locking, 'all') || (cfEq(parentId, topId) && cfEq(locking, 'none'))) &&
      cfEq(verdict, 'editor') &&
      !cfEq(requiredText(row, 'isLocked', 'RSTOP'), '1') &&
      !lockedBySomeoneElse;
    return { row, verdict, lockedBySomeoneElse, deletable };
  });
}

/** The grid row of `entry` (list.cfm 176-306). */
function legacyRow(o: CfOut, s: LegacyScope, rc: Rc, entry: LegacyRow): void {
  const { label, siteId, topId, moduleId, locale } = s;
  const { row, verdict } = entry;
  const col = (name: string): string => requiredText(row, name, 'RSTOP');
  const parentId = rcText(rc, 'parentid');
  const menuTitle = col('menutitle').slice(0, 90);
  o.ws();
  o.t('\n\t\t\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t\t\t\n\t\t\t\t \t\t\t\t\t<td class="var-width">\n\t\t\t\t \t\t\t\t\t\t');
  if (!cfEq(verdict, 'none')) {
    o.t('\n\t\t\t\t \t\t\t\t\t\t\t<a class="draftprompt" data-siteid="', siteId, '" data-contentid="', col('contentid'));
    o.t('" data-contenthistid="', col('contenthistid'), '" title="', label('sitemanager.edit'));
    o.t('" href="./?muraAction=cArch.edit&contenthistid=', col('ContentHistID'), '&contentid=', col('ContentID'));
    o.t('&type=', col('type'), '&parentid=', col('parentID'), '&topid=', encodeUrl(topId));
    o.t('&siteid=', encodeUrl(siteId), '&moduleid=', encodeUrl(moduleId), '">\n\t\t\t\t \t\t\t\t\t\t\t\t', menuTitle);
    o.t('\n\t\t\t\t \t\t\t\t\t\t\t</a>\n\t\t\t\t \t\t\t\t\t\t');
  } else {
    o.ws().t(menuTitle).ws();
  }
  o.t('\n\t\t\t\t \t\t\t\t\t</td>\n\t\t\t\t \t\t\t\t\t\n\n\t\t\t\t  \t\t\t\t\t\n\t\t\t\t\t\t\t\t\t<td>\n\t\t\t\t\t\t\t\t\t\t');
  const display = col('Display');
  if (cfToBoolean(display) && cfEq(display, '1') && cfToBoolean(col('approved'))) {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-check" title="', label('sitemanager.yes'));
    o.t('"></i>\n\t\t\t\t\t\t\t\t\t\t\t<span>', label('sitemanager.yes'), '</span>\n\t\t\t\t\t\t\t\t\t\t');
  } else if (cfEq(display, '2') && cfToBoolean(col('approved'))) {
    o.ws().t(lsDate(required(row, 'displaystart', 'RSTOP'), 'short', locale), ' - ');
    o.t(lsDate(required(row, 'displaystop', 'RSTOP'), 'short', locale)).ws();
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-ban" title="', label('sitemanager.no'));
    o.t('"></i>\n\t\t\t\t\t\t\t\t\t\t\t<span>', label('sitemanager.no'), '</span>\n\t\t\t\t\t\t\t\t\t\t');
  }
  const lastUpdate = required(row, 'lastupdate', 'RSTOP');
  o.t('\n\t\t\t\t\t\t\t\t\t</td>\n\t\t\t\t\t\t\t\t\t\n\n\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t<td>\n\t\t\t\t\t\t\t\t\t\t');
  o.t(lsDate(lastUpdate, s.ctx.req.session.dateKeyFormat, locale)).ws().t(lsTime(lastUpdate, 'medium', locale));
  o.t('\n\t\t\t\t\t\t\t\t\t</td>\n\t\t\t\t\t\t\t\t\t\n\n\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t<td class="actions">\n\t\t\t\t\t\t\t\t\t\t<ul class="');
  o.t(col('type').toLowerCase(), '">\n\t\t\t\t\t\t\t\t\t\t\t');
  const isForms = cfEq(moduleId, FORM_MODULE_ID);
  if (!cfEq(verdict, 'none')) {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t<li class="edit', entry.lockedBySomeoneElse ? ' disabled' : '');
    o.t('">\n\t\t\t\t\t\t\t\t\t\t\t\t\t<a title="', label('sitemanager.content.edit'), '" class="draftprompt" data-siteid="');
    o.t(siteId, '" data-contentid="', col('contentid'), '" data-contenthistid="', col('contenthistid'));
    o.t('" href="./?muraAction=cArch.edit&contenthistid=', col('ContentHistID'), '&contentid=', col('ContentID'));
    o.t('&type=', col('type'), '&parentid=', col('parentID'), '&topid=', encodeUrl(topId));
    o.t('&siteid=', encodeUrl(siteId), '&moduleid=', encodeUrl(moduleId));
    o.t(
      '">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-pencil"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t',
    );
    if (cfEq(col('type'), 'Variation')) {
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="preview"><a title="', label('sitemanager.view'));
      o.t('" href="', encodeUrl(col('remoteurl')), '"><i class="mi-globe"></i></a></li>\n\t\t\t\t\t\t\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t<li class="version-history">\n\t\t\t\t\t\t\t\t\t\t\t\t\t<a title="');
    o.t(label('sitemanager.content.versionhistory'), '" href="./?muraAction=cArch.hist&contentid=', col('ContentID'));
    o.t('&type=', col('type'), '&parentid=', col('parentID'), '&topid=', encodeUrl(topId));
    o.t('&siteid=', encodeUrl(siteId), '&moduleid=', encodeUrl(moduleId));
    o.t(
      '">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-history"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t',
    );
    if (isForms) {
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="manage-data">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a title="');
      o.t(label('sitemanager.content.managedata'), '" href="./?muraAction=cArch.datamanager&contentid=', col('ContentID'));
      o.t('&siteid=', encodeUrl(siteId), '&moduleid=', encodeUrl(moduleId), '&contenthistid=', col('ContentHistID'));
      o.t('&topid=', encodeUrl(topId), '&parentid=', encodeUrl(parentId));
      o.t(
        '&type=Form">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-wrench"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t',
      );
    }
    o.ws();
    if (isSiteAdminOrS2(s.ctx.req)) {
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="permissions">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a title="');
      o.t(label('sitemanager.content.permissions'), '" href="./?muraAction=cPerm.main&contentid=', col('ContentID'));
      o.t('&type=', col('type'), '&parentid=', col('parentID'), '&topid=', encodeUrl(topId));
      o.t('&siteid=', encodeUrl(siteId), '&moduleid=', encodeUrl(moduleId), '&startrow=', rcText(rc, 'startrow'));
      o.t(
        '">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-group"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t',
      );
    }
    o.ws();
  } else {
    o.t(
      '\n\t\t\t\t\t\t\t\t\t\t\t\t<li class="edit disabled">\n\t\t\t\t\t\t\t\t\t\t\t\t\t<a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-pencil"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t<li class="version-history disabled">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-history"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t',
    );
    if (isForms) {
      o.t(
        '\n\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="manage-dataOff disabled">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-wrench"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t',
      );
    }
    o.t(
      '\n\t\t\t\t\t\t\t\t\t\t\t\t<li class="permissions disabled">\n\t\t\t\t\t\t\t\t\t\t\t\t\t<a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-group"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t',
    );
  }
  o.ws();
  if (entry.deletable) {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t<li class="delete">\n\t\t\t\t\t\t\t\t\t\t\t\t\t<a title="', label('sitemanager.content.delete'));
    o.t('" href="./?muraAction=cArch.update&contentid=', col('ContentID'), '&type=', col('type'));
    o.t('&action=deleteall&topid=', encodeUrl(topId), '&siteid=', encodeUrl(siteId), '&moduleid=', encodeUrl(moduleId));
    o.t('&parentid=', encodeUrl(parentId), s.ctx.csrf.render(`${col('contentid')}deleteall`, 'url').value);
    o.t('" onClick="return confirmDialog(\'', encodeJs(label('sitemanager.content.deletecontentconfirm')));
    o.t(
      '\',this.href)">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-trash"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t',
    );
  } else if (!cfEq(rcText(rc, 'locking'), 'all')) {
    o.t(
      '\n\t\t\t\t\t\t\t\t\t\t\t\t<li class="delete disabled">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-trash"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t',
    );
  }
  o.t('\n\t\t\t\t\t\t\t\t\t\t</ul>\n\t\t\t\t\t\t\t\t\t</td>\n\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t</tr>\n\t\t\t\t\t\t\t');
}

/** The tag-selector and filter script of the LEGACY sidebar, after `var customtaggroups=<json>`. */
const LEGACY_FILTER_SCRIPT =
  ";\n\n\t\t\t\t\t$(function(){\n\t\t\t\t\t\t$.ajax({\n\t\t\t\t\t\t\turl:'?muraAction=carch.loadtagarray&siteid=' + siteid,\n\t\t\t\t\t\t\tdataType: 'text',\n\t\t\t\t\t\t\tsuccess: function(data){\n\t\t\t\t\t\t\t\tvar tagArray=eval('(' + data + ')');\n\t\t\t\t\t\t\t\t$('#tags').tagSelector(tagArray, 'tags');\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t});\n\n\t\t\t\t\t\tif(customtaggroups.length){\n\t\t\t\t\t\t\tfor(var g=0;g < customtaggroups.length; g++){\n\n\t\t\t\t\t\t\t\tif(window[customtaggroups[g]]){\n\t\t\t\t\t\t\t\t\t$('#' + customtaggroups[g] + 'tags').tagSelector(window[customtaggroups[g]], customtaggroups[g] + 'tags');\n\t\t\t\t\t\t\t\t}else{\n\t\t\t\t\t\t\t\t\t$.ajax({url:'?muraAction=carch.loadtagarray&siteid=' + siteid + '&taggroup=' + customtaggroups[g],\n\t\t\t\t\t\t\t\t\t\t\tcontext:{taggroup:customtaggroups[g]},\n\t\t\t\t\t\t\t\t\t\t\tdataType: 'text',\n\t\t\t\t\t\t\t\t\t\t\tsuccess:function(data){\n\t\t\t\t\t\t\t\t\t\t\t\twindow[this.taggroup]=eval('(' + data + ')');\n\t\t\t\t\t\t\t\t\t\t\t\t$('#' + this.taggroup + 'tags').tagSelector(window[this.taggroup], this.taggroup + 'tags');\n\t\t\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\t\t}\n\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t}\n\t\t\t\t\t});\n\n\t\t\t\t\t$('#removeFilter').click(\n\t\t\t\t\t\tfunction(){\n\t\t\t\t\t\t\t$('span.tag').remove();\n\t\t\t\t\t\t\t$(\"input[name='tags']\").val('');\n\t\t\t\t\t\t\t$('#searchString').val('');\n\t\t\t\t\t\t\t$('input[name=categoryID]').attr('checked', false);\n\t\t\t\t\t\t\t";

/** The filter form's closing script and markup through the end of the block. */
const LEGACY_SIDEBAR_CLOSE =
  "\n\t\t\t\t\t\t\tdocument.getElementById('filterByTitle').submit();\n\n\t\t\t\t\t\t}\n\t\t\t\t\t );\n\n\t\t\t\t</script>\n\t\t\t\t\t\t\t</div> <!-- /.sidebar -->\n\n\t\t" +
  '\n\n\t\t\t\t\t\t<div class="clearfix"></div>\n\t\t\t\t\t</div> <!-- /.block-content -->\n\t\t\t\t</div> <!-- /.block-bordered -->\n\t\t\t</div> <!-- /.block-constrain -->\n\n\t\t';

/** `$.event(name)`: the rc value, `''` when undefined. */
const eventValue = (rc: Rc, name: string): string => rcValue(rc, name) ?? '';

/** The category tree of the model as the nest partial reads it. */
function categoryNodes(value: unknown): CategoryNestNode[] {
  if (!Array.isArray(value)) throw new TypeError('categories is not an array');
  return value.map((item: unknown): CategoryNestNode => {
    if (typeof item !== 'object' || item === null) throw new TypeError('A category is not a struct');
    const node = item as CarchStruct;
    const flag = (key: string): number | boolean => {
      const flagValue = required(node, key, 'CATEGORY');
      if (typeof flagValue === 'number' || typeof flagValue === 'boolean') return flagValue;
      return Number(flagValue);
    };
    const children = structValue(node, 'children');
    return {
      categoryID: requiredText(node, 'categoryID', 'CATEGORY'),
      name: requiredText(node, 'name', 'CATEGORY'),
      isOpen: flag('isOpen'),
      hasKids: flag('hasKids'),
      ...(children === undefined || children === null ? {} : { children: categoryNodes(children) }),
    };
  });
}

/** The tags of `list` as the filter's tag selector prints them (list.cfm 361-368, 375-382). */
function tagSpans(o: CfOut, list: string, inputName: string, indent: string): void {
  for (const tag of listItems(list)) {
    o.t(`\n${indent}\t<span class="tag">\n${indent}\t\t`, encodeHtml(tag), ' <a><i class="mi-times-circle"></i></a>\n');
    o.t(`${indent}\t\t<input name="${inputName}" type="hidden" value="`, encodeHtmlAttr(tag), `">\n${indent}\t</span>\n${indent}`);
  }
}

/** The pager of the LEGACY grid (list.cfm 324-351). */
function legacyPager(o: CfOut, s: LegacyScope, nextN: CarchStruct, sorting: string): void {
  const { siteId, topId, moduleId } = s;
  const field = (key: string): string => requiredText(nextN, key, 'NEXTN');
  const number = (key: string): number => integerAttribute(field(key), key);
  const pageUrl = (startRow: string): string =>
    `./?muraAction=cArch.list&siteid=${encodeUrl(siteId)}&moduleid=${encodeUrl(moduleId)}&topid=${encodeUrl(topId)}&startrow=${startRow}${sorting}`;
  const totalRecords = required(nextN, 'totalrecords', 'NEXTN');
  const meta = s.ctx.rb.messageFormat(s.label('sitemanager.paginationmeta'), [
    `${field('startrow')}-${field('through')}`,
    typeof totalRecords === 'number' ? totalRecords : field('totalrecords'),
  ]);
  o.ws();
  o.t('\n\n\t\t\t\t\t\t<div class="mura-results-wrapper">\n\t\t\t\t\t\t\t<p class="clearfix search-showing">\n\t\t\t\t\t\t\t\t');
  o.t(meta, '\n\t\t\t\t\t\t\t</p>\n\t\t\t\t\t\t\t\t<ul class="pagination">\n\t\t\t\t\t\t\t\t\t');
  const current = Number(field('currentpagenumber'));
  if (current > 1) {
    o.t('\n\n\t\t\t\t\t\t\t\t\t\t<li>\n\t\t\t\t\t\t\t\t\t\t\t<a href="', pageUrl(field('previous')));
    o.t('">\n\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-angle-right"></i>\n\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t ');
  }
  o.ws();
  const perPage = Number(field('recordsperpage'));
  for (let i = number('firstPage'); i <= number('lastPage'); i += 1) {
    o.ws();
    if (current === i) {
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t<li class="active"><a href="#">', String(i), '</a></li>\n\t\t\t\t\t\t\t\t\t\t');
    } else {
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t<li>\n\t\t\t\t\t\t\t\t\t\t\t\t<a href="', pageUrl(String(i * perPage - perPage + 1)));
      o.t('">\n\t\t\t\t\t\t\t\t\t\t\t\t\t', String(i), '\n\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t');
    }
    o.ws();
  }
  o.ws();
  if (current < Number(field('NumberOfPages'))) {
    o.t('\n\t\t\t\t\t\t\t<li>\n\t\t\t\t\t\t\t\t<a href="', pageUrl(field('next')));
    o.t('"><i class="mi-angle-right"></i></a>\n\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t</ul>\n\t\t\t\t\t</div>\n\t\t\t\t').ws();
}

/** The LEGACY module body (list.cfm 82-453). */
async function legacyBody(ctx: ScreenContext, data: ListData): Promise<string> {
  const { req, rb } = ctx;
  const { rc } = req;
  const model = data.model.rc;
  const label = (key: string): string => rb.rbKey(key);
  const siteId = rcText(rc, 'siteid');
  const moduleId = rcText(rc, 'moduleid');
  const topId = requiredText(model, 'topid', 'RC');
  // rc.perm = permUtility.getPerm(rc.moduleid, rc.siteid), as strategies-content computed it.
  const perm = requiredText(model, 'perm', 'RC');
  // contentManager.getList cfparams these on rc before the view's own cfparams.
  const sortBy = rcValue(rc, 'sortBy') ?? 'menutitle';
  const sortDirection = rcValue(rc, 'sortDirection') ?? 'asc';
  const searchString = rcValue(rc, 'searchString') ?? '';
  const s: LegacyScope = { ctx, label, siteId, topId, moduleId, locale: req.session.locale };

  let titleDirection = 'asc';
  let displayDirection = 'asc';
  let lastUpdatedDirection = 'desc';
  if (cfEq(sortBy, 'title')) {
    if (cfEq(sortDirection, 'asc')) titleDirection = 'desc';
  } else if (cfEq(sortBy, 'display')) {
    if (cfEq(sortDirection, 'asc')) displayDirection = 'desc';
  } else if (cfEq(sortBy, 'lastupdate')) {
    if (cfEq(sortDirection, 'desc')) lastUpdatedDirection = 'asc';
  }

  const o = new CfOut();
  o.t('\n\t\t\t<div class="mura-header">\n\t\t\t');
  const titleKey = cfEq(moduleId, FORM_MODULE_ID)
    ? 'sitemanager.formsmanager'
    : cfEq(moduleId, VARIATION_MODULE_ID)
      ? 'sitemanager.variationsmanager'
      : 'sitemanager.componentmanager';
  o.t('\n\t\t\t\t<h1>', label(titleKey), '</h1>\n\t\t\t').ws();
  const layoutManager = structValue(model, 'useLayoutManager');
  o.t(
    renderCarchSecondaryMenu(ctx, {
      rc,
      ...(layoutManager === undefined ? {} : { useLayoutManager: cfToBoolean(layoutManager) }),
    }).value,
  );
  o.t('\n\n\t\t\t</div> <!-- /.mura-header -->\n\t\t');
  o.t(
    '\n\n\t\t\t<div class="block block-constrain">\n\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t  <div class="block-content">\n\t\t\t\t\t\t\t<div id="main">\n\n\t\t\t\t',
  );

  const nextN = requiredStruct(model, 'nextN', 'RC');
  if (requiredRows(model, 'rsTop', 'RC').length > 0) {
    const parentId = rcText(rc, 'parentid');
    const sortUrl = (column: string, direction: string): string =>
      `./?muraAction=cArch.list&siteid=${encodeUrl(siteId)}&topid=${encodeUrl(topId)}&parentid=${encodeUrl(parentId)}&moduleid=${encodeUrl(moduleId)}&sortBy=${column}&sortDirection=${direction}`;
    o.t('\n\t\t\t\t<table class="mura-table-grid">\n\t\t\t\t\t');
    o.t('\n\t\t\t\t\t\t<thead>\n\t\t\t\t\t\t\t<tr>\n\t\t\t\t  \t\t\t\t<th class="var-width">\n\t\t\t\t  \t\t\t\t\t<a href="');
    o.t(sortUrl('title', titleDirection), '">\n\t\t\t\t  \t\t\t\t\t\t', label('sitemanager.title'));
    o.t('\n\t\t\t\t  \t\t\t\t\t</a>\n\t\t\t\t  \t\t\t\t</th>\n\n\t\t\t\t  \t\t\t\t<th>\n\t\t\t\t  \t\t\t\t\t<a href="');
    o.t(sortUrl('display', displayDirection), '">\n\t\t\t\t  \t\t\t\t\t\t', label('sitemanager.display'));
    o.t('\n\t\t\t\t  \t\t\t\t\t</a>\n\t\t\t\t  \t\t\t\t</th>\n\t\t\t\t  \t\t\t\t<th>\n\t\t\t\t  \t\t\t\t\t<a href="');
    o.t(sortUrl('lastUpdate', lastUpdatedDirection), '">\n\t\t\t\t  \t\t\t\t\t\t', label('sitemanager.lastupdated'));
    o.t(
      '\n\t\t\t\t  \t\t\t\t\t</a>\n\t\t\t\t  \t\t\t\t</th>\n\t\t\t\t  \t\t\t\t<th class="actions">&nbsp;</th>\n\t\t\t\t\t\t\t</tr>\n\t\t\t\t\t\t</thead>\n\t\t\t\t\t',
    );
    o.t('\n\n\t\t\t\t\t<tbody>\n\t\t\t\t\t\t\t');
    const rows = legacyRows(model, rc, perm, req.session.mura.userID);
    const deleteContexts = rows
      .filter((entry) => entry.deletable)
      .map((entry) => `${requiredText(entry.row, 'contentid', 'RSTOP')}deleteall`);
    if (deleteContexts.length > 0) await ctx.csrf.prefetch(deleteContexts);
    for (const entry of rows) legacyRow(o, s, rc, entry);
    o.t('\n\t\t\t\t\t</tbody>\n\t\t\t\t</table>\n\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t<div class="help-block-empty">\n\t\t\t\t\t\t');
    o.ws().t(label('sitemanager.noitemsinsection')).ws();
    o.t('\n\t\t\t\t\t</div>\n\t\t\t\t');
  }
  o.ws();
  if (Number(requiredText(nextN, 'numberofpages', 'NEXTN')) > 1) {
    legacyPager(o, s, nextN, `&sortBy=${sortBy}&sortDirection=${sortDirection}&searchString=${searchString}`);
  }

  o.t('\n\t\t</div>\n\n\t\t');
  o.t('\n\t\t\t<div class="sidebar">\n\t\t\t\t<h2>', label('sitemanager.filters'));
  o.t(
    '</h2>\n\t\t\t\t<form class="form-inline" novalidate="novalidate" id="filterByTitle" action="index.cfm" method="get">\n\t\t\t\t\t  <input type="hidden" name="siteid" value="',
  );
  o.t(encodeHtmlAttr(siteId), '" />\n\t\t\t\t\t  <input type="hidden" name="topid" value="', encodeUrl(topId));
  o.t('" />\n\t\t\t\t\t  <input type="hidden" name="parentid" value="', encodeUrl(rcText(rc, 'parentID')));
  o.t('" />\n\t\t\t\t\t  <input type="hidden" name="moduleid" value="', encodeUrl(moduleId));
  o.t(
    '" />\n\t\t\t\t\t  <input type="hidden" name="sortBy" value="" />\n\t\t\t\t\t  <input type="hidden" name="sortDirection" value="" />\n\t\t\t\t\t  <input type="hidden" name="muraAction" value="cArch.list" />\n\n\t\t\t\t\t<div id="filters" class="module well">\n\t\t\t\t\t<label>',
  );
  o.t(label('sitemanager.keywords'), '</label>\n\t\t\t\t\t <input type="text" name="searchString" id="searchString" value="');
  o.t(encodeHtmlAttr(searchString));
  o.t(
    '" class="text" size="20">\n\t\t\t\t\t</div>\n\n\t\t\t\t\t<div class="module mura-control-group mura-filter-tags">\n\t\t\t\t\t\t<label>',
  );
  o.t(label('sitemanager.tags'), '</label>\n\t\t\t\t\t\t<input type="text" name="tags">\n\t\t\t\t\t\t<div id="tags" class="tagSelector">\n\t\t\t\t\t\t\t');
  tagSpans(o, eventValue(rc, 'tags'), 'tags', '\t\t\t\t\t\t\t');
  o.t('\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\n\t\t\t\t\t');
  const siteConfig = requiredStruct(model, 'siteConfig', 'RC');
  const tagGroups = requiredText(siteConfig, 'customTagGroups', 'siteConfig');
  if (tagGroups !== '') {
    o.ws();
    for (const group of listItems(tagGroups, '^,')) {
      o.t('\n\t\t\t\t\t\t\t<div class="module mura-control-group mura-filter-tags">\n\t\t\t\t\t\t\t\t<label>', group);
      o.ws().t(label('sitemanager.tags'), '</label>\n\t\t\t\t\t\t\t\t<input type="text" name="', group);
      o.t('tags">\n\t\t\t\t\t\t\t\t<div id="', group, 'tags" class="tagSelector">\n\t\t\t\t\t\t\t\t\t');
      tagSpans(o, eventValue(rc, `${group}tags`), `${group}tags`, '\t\t\t\t\t\t\t\t\t');
      o.t('\n\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t');
    }
    o.ws();
  }
  o.ws();
  if (cfToBoolean(required(model, 'categoryCount', 'RC'))) {
    o.t('\n\t\t\t\t\t\t<div class="module well" id="mura-list-tree">\n\t\t\t\t\t\t\t<label>', label('sitemanager.categories'));
    o.t('</label>\n\t\t\t\t\t\t\t');
    o.t(
      categoriesNest(ctx, {
        siteId: eventValue(rc, 'siteID'),
        parentId: '',
        nestLevel: 0,
        categoryId: eventValue(rc, 'categoryid'),
        tree: categoryNodes(required(model, 'categories', 'RC')),
      }).value,
    );
    o.t('\n\t\t\t\t\t\t</div>\n\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t<div class="sidebar-buttons">\n\t\t\t\t\t\t<input type="submit" class="btn" name="filterList" value="');
  o.t(label('sitemanager.filter'), '"/>\n\t\t\t\t\t\t');
  if (`${eventValue(rc, 'categoryID')}${eventValue(rc, 'tags')}${eventValue(rc, 'searchString')}` !== '') {
    o.t('\n\t\t\t\t\t\t<input type="button" class="btn" name="removeFilter" id="removeFilter" value="');
    o.t(label('sitemanager.removefilter'), '" onclick=""/>\n\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t</div><!-- /.sidebar-buttons -->\n\n\t\t\t\t </form>\n\n\t\t\t\t <script>\n\t\t\t\t\tvar customtaggroups=');
  o.t(tagGroupsJson(listItems(tagGroups, '^,')), LEGACY_FILTER_SCRIPT);
  if (tagGroups !== '') {
    o.ws();
    for (const group of listItems(tagGroups, '^,')) o.t('\n\t\t\t\t\t\t\t$("input[name=\'', group, 'tags\']").val(\'\');\n\t\t\t\t\t\t\t');
    o.ws();
  }
  o.t(LEGACY_SIDEBAR_CLOSE, draftPromptJs(ctx).value).ws();
  return o.toString();
}

// ---- Content modules (list.cfm 455-851) ----

/** The module-button script and the grid container's opening tag, through `<div id="gridContainer"`. */
const ARCH_MOD_SCRIPT =
  '\n\n\t\t\t\t\t\t\t\t<script>\n\t\t\t\t\t\t\t\t\t$(function(){\n\t\t\t\t\t\t\t\t\t\t$("#arch-mod  a").click(function(){\n\t\t\t\t\t\t\t\t\t\t\t// persist content nav selection\n\t\t\t\t\t\t\t\t\t\t\tvar navSelection = jQuery(this).attr(\'data-moduleid\');\n\n\t\t\t\t\t\t\t\t\t\t\t$(".site-manager-mod").removeClass(\'active\');\n\t\t\t\t\t\t\t\t\t\t\t$(\'a[data-moduleid=\' + navSelection +\']\').removeClass(\'active\');\n\t\t\t\t\t\t\t\t\t\t\t$("#arch-mod  a.active").removeClass(\'active\');\n\t\t\t\t\t\t\t\t\t\t\t$(\'a[data-moduleid=\' + navSelection +\']\').addClass(\'active\');\n\t\t\t\t\t\t\t\t\t\t\tif(navSelection==\'00000000000000000000000000000000000\'){\n\t\t\t\t\t\t\t\t\t\t\t\t$(\'#gridContainer\').addClass(\'site-tree\');\n\t\t\t\t\t\t\t\t\t\t\t} else {\n\t\t\t\t\t\t\t\t\t\t\t\t$(\'#gridContainer\').removeClass(\'site-tree\');\n\t\t\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\t\t</script>\n\n\t\t\t  \t\t\n\t\t\t\t\t\t<div id="gridContainer"';

/** The tab script between `var newContentMenuTitle='…'` and the `loadSiteManager` arguments. */
const TAB_SCRIPT =
  '\';\n\t\t\t\tvar flatViewArgs=initFlatViewArgs();\n\n\t\t\t\tfunction initSiteManagerTabContent(index){\n\t\t\t\t\tjQuery.get("./index.cfm","muraAction=carch.siteManagerTab&tab=" + index);\n\n\t\t\t\t\tif(!tabsInited){\n\t\t\t\t\t\tjQuery("#viewTabs a[href=\'#tabArchitectural\']").click(function(e){\n\t\t\t\t\t\t\te.preventDefault();\n\t\t\t\t\t\t\tinitSiteManagerTabContent(0);\n\t\t\t\t\t\t});\n\t\t\t\t\t\tjQuery("#viewTabs a[href=\'#tabFlat\']").click(function(e){\n\t\t\t\t\t\t\te.preventDefault();\n\t\t\t\t\t\t\tinitSiteManagerTabContent(1);\n\t\t\t\t\t\t});\n\t\t\t\t\t\ttabsInited=true;\n\t\t\t\t\t}\n\n\t\t\t\t\tswitch(index){\n\t\t\t\t\t\tcase 0:\n\t\t\t\t\t\tif (!archViewLoaded) {\n\t\t\t\t\t\t\tjQuery(\'#viewTabs a[href="#tabArchitectural"]\').tab(\'show\');\n\t\t\t\t\t\t\tsiteManager.loadSiteManager(\'';

/** The tab script after the `loadSiteManager` arguments, through `jQuery(document).ready(function(){`. */
const TAB_SCRIPT_CLOSE =
  '\');\n\t\t\t\t\t\t\tarchViewLoaded = true;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tbreak;\n\t\t\t\t\t\tcase 1:\n\t\t\t\t\t\tif (!flatViewLoaded) {\n\t\t\t\t\t\t\tjQuery(\'#viewTabs a[href="#tabFlat"]\').tab(\'show\');\n\t\t\t\t\t\t\tsiteManager.loadSiteFlat(flatViewArgs);\n\t\t\t\t\t\t\tflatViewLoaded = true;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tbreak;\n\t\t\t\t\t\tcase 2:\n\t\t\t\t\t\t\tjQuery(\'#viewTabs a[href="#tabEntities"]\').tab(\'show\');\n\t\t\t\t\t\tbreak;\n\t\t\t\t\t}\n\t\t\t\t}\n\n\t\t\t\tjQuery(document).ready(function(){\n\t\t\t\t\t';

/** The `flatViewArgs` keys `initFlatViewArgs()` writes, in order, each after its own separator. */
const FLAT_VIEW_KEYS: ReadonlyArray<readonly [key: string, separator: string]> = [
  ['sortby', "',\n\t\t\t\t\t\tsortby:'"],
  ['sortdirection', "',\n\t\t\t\t\t\tsortdirection:'"],
  ['page', "',\n\t\t\t\t\t\tpage:'"],
  ['tags', "',\n\t\t\t\t\t\ttags:'"],
  ['categoryid', "',\n\t\t\t\t\t\tcategoryid:'"],
  ['lockid', "',\n\t\t\t\t\t\tlockid:'"],
  ['type', "',\n\t\t\t\t\t\ttype:'"],
  ['subtype', "',\n\t\t\t\t\t\tsubtype:'"],
  ['report', "',\n\t\t\t\t\t\treport:'"],
  ['keywords', "',\n\t\t\t\t\t\tkeywords:'"],
  ['filtered', "',\n\t\t\t\t\t\tfiltered: '"],
];

/** One Site Manager module button of `#arch-mod`. */
interface ModuleButton {
  readonly moduleId: string;
  readonly labelKey: string;
  readonly type: string;
  /** The text between the onclick attribute's `">` and the label: the icon and its indent. */
  readonly icon: string;
  /** The template text after the closing `</a>`. */
  readonly after: string;
}

const SITE_BUTTON: ModuleButton = {
  moduleId: CONTENT_MODULE_ID,
  labelKey: 'layout.sitetree',
  type: 'Page',
  icon: '\n  \t\t\t\t\t\t\t\t\t\t  <i class="mi-sitemap"></i> ',
  after: '\n  \t\t\t\t\t\t\t\t\t  </a>\n\n\n  \t\t\t\t\t\t\t\t  ',
};
const COMPONENTS_BUTTON: ModuleButton = {
  moduleId: COMPONENT_MODULE_ID,
  labelKey: 'layout.components',
  type: 'Component',
  icon: '\n  \t\t\t\t\t\t\t\t\t\t  <i class="mi-align-justify"></i> ',
  after: '\n  \t\t\t\t\t\t\t\t\t  </a>\n\n  \t\t\t\t\t\t\t\t  ',
};
const FORMS_BUTTON: ModuleButton = {
  moduleId: FORM_MODULE_ID,
  labelKey: 'layout.forms',
  type: 'Form',
  icon: '\n  \t\t\t\t\t\t\t\t\t\t<i class="mi-toggle-on"></i> ',
  after: '\n  \t\t\t\t\t\t\t\t\t  </a>\n\n  \t\t\t\t\t\t\t\t  ',
};
const VARIATIONS_BUTTON: ModuleButton = {
  moduleId: VARIATION_MODULE_ID,
  labelKey: 'layout.variations',
  type: 'Variation',
  icon: '\n  \t\t\t\t\t\t\t\t\t\t  <i class="mi-cloud"></i> ',
  after: '\n  \t\t\t\t\t\t\t\t\t  </a>\n\n  \t\t\t\t\t\t\t\t  ',
};

/** `button` as `#arch-mod` prints it, from the opening `<a` (`active` for the requested module). */
function moduleButton(o: CfOut, button: ModuleButton, moduleId: string, siteId: string, label: (key: string) => string): void {
  o.t('<a class="site-manager-mod btn', cfEq(moduleId, button.moduleId) ? ' active' : '');
  o.t('" data-moduleid="', button.moduleId, '" title="', encodeHtmlAttr(label(button.labelKey)));
  o.t('" href="#" onclick="return siteManager.loadSiteManagerInTab(function(){siteManager.loadSiteManager(\'');
  o.t(encodeJs(siteId), `','','${button.moduleId}','','','${button.type}',1)});">`, button.icon, label(button.labelKey));
  o.t(button.after);
}

/** The content modules' body (list.cfm 455-851). */
function contentBody(ctx: ScreenContext, data: ListData): string {
  const { req, rb } = ctx;
  const { rc } = req;
  const model = data.model.rc;
  const label = (key: string): string => rb.rbKey(key);
  const siteId = rcText(rc, 'siteid');
  const moduleId = rcText(rc, 'moduleid');
  const sessionSiteId = req.session.siteid;
  const siteConfig = requiredStruct(model, 'siteConfig', 'RC');
  const tagGroups = listItems(requiredText(siteConfig, 'customTagGroups', 'siteConfig'), '^,');
  const flatViewArgs = requiredStruct(model, 'flatViewArgs', 'RC');
  const flat = (key: string): string => requiredText(flatViewArgs, key, 'session.flatViewArgs');
  const modulePerms = (): CarchStruct => requiredStruct(model, 'modulePerms', 'RC');
  const dataCollection = (): boolean => requiredFlag(siteConfig, 'dataCollection', 'siteConfig');
  const variations = (): boolean => requiredFlag(model, 'variations', 'RC');
  const authorOrEditor = (module: string): boolean =>
    listFindNoCase('editor,author', requiredText(modulePerms(), module, 'modulePerms'));
  const modulePerm = (module: string): boolean => sessionSiteModulePerm(req, module);
  const scaffolding = (): boolean =>
    requiredFlag(siteConfig, 'scaffolding', 'siteConfig') && modulePerm(SCAFFOLD_MODULE_ID);
  const activeTab = data.url.has('activetab') ? rcText(rc, 'activeTab') : flat('tab');

  const o = new CfOut();
  o.t("\n\t\t\t<script>\n\t\t\t\tsiteID='", sessionSiteId, "';\n\t\t\t\t");
  const copyModuleId = structValue(model, 'copyModuleID');
  if (cfEq(requiredText(model, 'copySiteID', 'session'), siteId) && copyModuleId !== undefined) {
    o.t("\n\n\t\t\t\tsiteManager.copyContentID = '", encodeJs(requiredText(model, 'copyContentID', 'session')));
    o.t("';\n\t\t\t\tsiteManager.copySiteID = '", encodeJs(requiredText(model, 'copySiteID', 'session')));
    o.t("';\n\t\t\t\tsiteManager.copymoduleid = '", encodeJs(requiredText(model, 'copyModuleID', 'session')));
    o.t("';\n\t\t\t\tsiteManager.copyAll = '", encodeJs(requiredText(model, 'copyAll', 'session')), "';\n\t\t\t\t");
  } else {
    o.t("\n\t\t\t\tsiteManager.copyContentID = '';\n\t\t\t\tsiteManager.copySiteID = '';\n\t\t\t\tsiteManager.copyAll = 'false';\n\t\t\t\t");
  }
  o.t('\n\t\t\t</script>\n\n\t\t \t<div class="mura-header">\n\t\t\t\t<h1>', label('layout.contentmanager'));
  o.t(
    '</h1>\n\t\t\t</div> \n\n\t\t\t<div class="block block-constrain">\n\t\t\t\t<ul id="viewTabs" class="mura-tabs nav-tabs" data-toggle="tabs">\n\t\t\t\t\t<li><a href="#tabArchitectural" onclick="return false;"><span>',
  );
  o.t(label('sitemanager.view.architectural'), '</span></a></li>\n\t\t\t\t\t<li><a href="#tabFlat" onclick="return false;"><span>');
  o.t(label('sitemanager.view.flat'), '</span></a></li>\n\t\t\t\t\t');
  const entities = scaffolding();
  if (entities) o.t('\n\t\t\t\t\t\t<li><a href="#tabEntities"><span>', label('sitemanager.view.custom'), '</span></a></li>\n\t\t\t\t\t');
  o.t(
    '\n\t\t\t\t</ul>\n\t\t\t\t<div class="block-content tab-content">\n\n\t\t\t\t\t<div id="tabArchitectural" class="tab-pane">\n\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t<!-- block header -->\n\t\t\t\t\t\t  <div class="block-header">\n\t\t\t\t\t\t\t\t\t<h3 class="block-title pull-left">',
  );
  o.t(
    label('sitemanager.view.architectural'),
    '</h3>\n\t\t\t\t\t\t  </div>\n\t\t\t\t\t\t  <!-- /block header -->\n\t\t\t\t\t\t  <div class="block-content">\n\n\t\t\t  \t\t',
  );
  if (
    modulePerm(COMPONENT_MODULE_ID) ||
    (dataCollection() && modulePerm(FORM_MODULE_ID)) ||
    (variations() && modulePerm(VARIATION_MODULE_ID))
  ) {
    o.t('\n\n\t\t\t\t\t\t\t  <div id="arch-mod" class="mura-input-set">\n\n  \t\t\t\t\t\t\t\t\t  ');
    moduleButton(o, SITE_BUTTON, moduleId, siteId, label);
    if (authorOrEditor(COMPONENT_MODULE_ID)) {
      o.t('\n\n  \t\t\t\t\t\t\t\t\t  ');
      moduleButton(o, COMPONENTS_BUTTON, moduleId, siteId, label);
    }
    o.ws();
    if (dataCollection() && authorOrEditor(FORM_MODULE_ID)) {
      o.t('\n\n  \t\t\t\t\t\t\t\t\t  ');
      moduleButton(o, FORMS_BUTTON, moduleId, siteId, label);
    }
    o.ws();
    if (variations() && modulePerm(VARIATION_MODULE_ID)) {
      o.t('\n\n  \t\t\t\t\t\t\t\t\t  ');
      moduleButton(o, VARIATIONS_BUTTON, moduleId, siteId, label);
    }
    o.t('\n  \t\t\t\t\t\t\t  </div>\n\t\t\t\t  \t\t');
  }
  o.t(ARCH_MOD_SCRIPT, cfEq(moduleId, CONTENT_MODULE_ID) ? ' class="site-tree"' : '');
  o.t(
    '>\n\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\n\n\t\t\t\t\t<div id="tabFlat" class="tab-pane">\n\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t<!-- block header -->\n\t\t\t\t\t\t  <div class="block-header">\n\t\t\t\t\t\t\t\t<h3 class="block-title">',
  );
  o.t(
    label('sitemanager.view.flat'),
    '</h3>\n\t\t\t\t\t\t  </div>\n\t\t\t\t\t\t  <!-- /block header -->\n\t\t\t\t\t\t  <div class="block-content">\n\t\t\t\t\t\t  \t\n\t\t\t\t\t\t\t\t<div id="flatViewContainer">\n\n\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t\t',
  );
  if (scaffolding()) {
    o.t(
      '\n\t\t\t\t\t\t<div id="tabEntities" class="tab-pane">\n\t\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t\t<!-- block header -->\n\n\t\t\t\t\t\t\t  ',
    );
    o.t(scaffold(ctx, { siteId }).value, '\n\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t');
  }
  o.t(
    '\n\n\t\t\t\t</div> \n\t\t\t</div> \n\n\t\t\t<script type="text/javascript">\n\t\t\t\tvar archViewLoaded=false;\n\t\t\t\tvar flatViewLoaded=false;\n\t\t\t\tvar tabsInited=false;\n\t\t\t\tvar customtaggroups=',
  );
  o.t(tagGroupsJson(tagGroups), ";\n\n\t\t\t\tfunction initFlatViewArgs(){\n\t\t\t\t\treturn {\n\t\t\t\t\t\tsiteid:'");
  o.t(encodeJs(sessionSiteId), "',\n\t\t\t\t\t\tmoduleid:'", encodeJs(eventValue(rc, 'moduleid')));
  o.t("',\n\t\t\t\t\t\ttopid:'", encodeJs(sessionTopId(req, eventValue(rc, 'moduleid'))));
  for (const [key, separator] of FLAT_VIEW_KEYS) o.t(separator, encodeJs(flat(key)));
  o.t("'\n\t\t\t\t\t\t");
  if (tagGroups.length > 0) {
    o.ws();
    for (const group of tagGroups) {
      o.t('\n\t\t\t\t\t\t\t\t,"', group, 'tags":\'', encodeJs(flat(`${group}tags`)), "'\n\t\t\t\t\t\t\t");
    }
    o.ws();
  }
  o.t("\n\t\t\t\t\t};\n\t\t\t\t}\n\n\t\t\t\tvar newContentMenuTitle='", encodeJs(label('sitemanager.selectcontenttype')));
  o.t(TAB_SCRIPT, encodeJs(siteId), "', '", encodeJs(requiredText(model, 'topid', 'RC')));
  o.t("', '", encodeJs(moduleId), "', '", encodeJs(requiredText(model, 'sortBy', 'RC')));
  o.t("', '", encodeJs(requiredText(model, 'sortDirection', 'RC')), "', '", encodeJs(rcText(rc, 'ptype')));
  o.t("', '", encodeJs(data.startRowReset ? '1' : rcText(rc, 'startrow')), TAB_SCRIPT_CLOSE);
  if (data.url.has('moduleid') && !data.url.has('activetab')) {
    o.t('\n\t\t\t\t\t\tinitSiteManagerTabContent(0);\n\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\tinitSiteManagerTabContent(', encodeJs(activeTab), ');\n\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t});\n\t\t\t</script>\n\t\t').ws();
  o.t(draftPromptJs(ctx).value).ws();
  return o.toString();
}

/** `session["m<moduleid>"].topid`, failing as CFML does when the module has no session struct. */
function sessionTopId(req: AdminRequest, moduleId: string): string {
  const key = `m${moduleId}`.toLowerCase();
  const name = Object.keys(req.session.moduleTopIds).find((candidate) => candidate.toLowerCase() === key);
  const topId = name === undefined ? undefined : req.session.moduleTopIds[name];
  if (topId === undefined) {
    throw new TypeError(
      `Element ${key.toUpperCase()} is undefined in a Java object of type class coldfusion.runtime.MemorySessionScope.`,
    );
  }
  return topId;
}

// ---- Screen ----

/** The page's `cfhtmlhead` script; the shell writes its own line break before `</head>`. */
function pulseHead(): SafeHtml {
  return raw(`\n<script src="${adminAssetUrl('js/jquery/jquery-pulse.js', { coreversion: true })}" type="text/javascript"></script>`);
}

/** The page data, or the error for a request whose controller step answered with a redirect. */
async function listData(ctx: ScreenContext): Promise<ListData> {
  const outcome = await loadList(ctx);
  if (outcome.kind === 'location') throw new Error(`carch.list redirects to ${outcome.location}; it has no view data`);
  return outcome.data;
}

/** `js.cfm`, then the `cfswitch rc.moduleid` branch; a module outside both cases renders an empty body. */
async function renderList(ctx: ScreenContext, data: ListData): Promise<ShellView> {
  const ajax = carchJs(ctx, 'list');
  if (data.listCase === 'legacy') return { body: raw(await legacyBody(ctx, data)), ajax };
  if (data.listCase === 'content') return { body: raw(contentBody(ctx, data)), ajax, htmlHead: pulseHead() };
  return { body: raw(''), ajax };
}

/** `cArch.list`: the Site Manager of the content modules and the LEGACY module grid. */
export const listScreen: PageScreen<ListData> = Object.freeze({
  circuit: 'carch',
  action: 'list',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  secondaryMenu: 'carch',
  async redirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
    const outcome = await loadList(ctx);
    return outcome.kind === 'location' ? { kind: 'location', location: outcome.location } : undefined;
  },
  load: listData,
  render: renderList,
} satisfies PageScreen<ListData>);
