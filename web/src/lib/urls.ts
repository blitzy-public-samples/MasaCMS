// Legacy admin, FW/1 and static asset URLs in the exact form Masa emits them (server-only).
import {
  ADMIN_HOME_ACTION,
  adminUrl,
  cfEq,
  esapiUrlEncode,
  javaTrim,
  type AdminParam,
} from '@opt2/platform/legacy-compat';
import { legacySettings } from './env';

/** FW/1 home action of the admin (`variables.framework.home`). */
export const FW1_HOME_ACTION = `core:${ADMIN_HOME_ACTION}` as const;

const ACTION_KEY = 'muraAction';
const DEFAULT_SUBSYSTEM = 'core';
const DEFAULT_SECTION = 'main';
const DEFAULT_ITEM = 'default';
const SUBSYSTEM_DELIMITER = ':';
const PRESERVE_KEY_URL_KEY = 'fw1pk';

/** CFML list elements split on any character of `delims`; empty elements are dropped. */
function listItems(list: string, delims: string): string[] {
  const items: string[] = [];
  let item = '';
  for (const ch of list) {
    if (!delims.includes(ch)) {
      item += ch;
    } else if (item !== '') {
      items.push(item);
      item = '';
    }
  }
  if (item !== '') items.push(item);
  return items;
}

/** CFML `listFirst`. */
const listFirst = (list: string, delims: string): string => listItems(list, delims)[0] ?? '';

/** CFML `listLast`. */
const listLast = (list: string, delims: string): string => listItems(list, delims).at(-1) ?? '';

/** CFML `listRest`: the text after the first element and the delimiters that follow it. */
function listRest(list: string, delims: string): string {
  const isDelim = (at: number): boolean => delims.includes(list.charAt(at));
  let at = 0;
  while (at < list.length && isDelim(at)) at += 1;
  while (at < list.length && !isDelim(at)) at += 1;
  while (at < list.length && isDelim(at)) at += 1;
  return list.slice(at);
}

/** CFML `listFindNoCase(list, value) > 0`. */
const listHasNoCase = (list: string, value: string): boolean =>
  listItems(list, ',').some((item) => item.toLowerCase() === value.toLowerCase());

/** FW/1 `actionSpecifiesSubsystem`. */
const specifiesSubsystem = (action: string): boolean =>
  listItems(action, SUBSYSTEM_DELIMITER).length > 1 || action.endsWith(SUBSYSTEM_DELIMITER);

/** FW/1 `getSectionAndItem`: `section.item`, defaults filled in. */
function sectionAndItem(action: string): string {
  let value = action;
  if (specifiesSubsystem(action)) {
    value = listItems(action, SUBSYSTEM_DELIMITER).length > 1 ? listLast(action, SUBSYSTEM_DELIMITER) : '';
  }
  if (value === '') return `${DEFAULT_SECTION}.${DEFAULT_ITEM}`;
  if (listItems(value, '.').length === 1) {
    return value.startsWith('.') ? `${DEFAULT_SECTION}.${listLast(value, '.')}` : `${listFirst(value, '.')}.${DEFAULT_ITEM}`;
  }
  return `${listFirst(value, '.')}.${listLast(value, '.')}`;
}

/** FW/1 `getSubsystem`; an admin request's subsystem is always `core`. */
const subsystemOf = (action: string): string =>
  specifiesSubsystem(action) ? listFirst(action, SUBSYSTEM_DELIMITER) : DEFAULT_SUBSYSTEM;

/** FW/1 `getFullyQualifiedAction`: `subsystem:section.item`, case kept. */
const fullyQualified = (action: string): string => `${subsystemOf(action)}${SUBSYSTEM_DELIMITER}${sectionAndItem(action)}`;

/** `CGI.SCRIPT_NAME` of an admin request: `<context><adminDir>/index.cfm`. */
export function adminScriptName(): string {
  const { context, adminDir } = legacySettings();
  return `${context}${adminDir}/index.cfm`;
}

/** Query parameters of {@link boundAdminUrl} and {@link relativeAdminUrl}: pairs in emitted order, or a record (JS key order). */
export type BoundAdminParams = ReadonlyArray<AdminParam> | Readonly<Record<string, string | number>>;

/** Options of {@link boundAdminUrl}; `encode` applies to every parameter that names no encoding itself. */
export interface BoundAdminUrlOptions {
  readonly html?: boolean;
  readonly encode?: 'url' | 'raw';
}

const isParamList = (params: BoundAdminParams): params is ReadonlyArray<AdminParam> => Array.isArray(params);

/** Ordered `[name, value, encoding]` pairs, `encode` filling in each pair that names no encoding. */
function adminParams(params: BoundAdminParams, encode: 'url' | 'raw'): AdminParam[] {
  const list: ReadonlyArray<AdminParam> = isParamList(params) ? params : Object.entries(params);
  return list.map(([name, value, encoding = encode]): AdminParam => [name, value, encoding]);
}

/** `<context><adminDir>/?muraAction=<circuit>.<action>&…` with the configured context and admin directory. */
export function boundAdminUrl(
  circuit: string,
  action: string,
  params: BoundAdminParams = [],
  { html = false, encode = 'url' }: BoundAdminUrlOptions = {},
): string {
  const { context, adminDir } = legacySettings();
  return adminUrl({
    circuit,
    action,
    context,
    adminDir,
    html,
    params: adminParams(params, encode),
  });
}

/** Text a legacy view writes before `muraAction=`: `./?` in most views, `?` or `./?&` in a few. */
export type RelativeAdminPrefix = './?' | '?' | './?&';

/** Options of {@link relativeAdminUrl}. */
export interface RelativeAdminUrlOptions extends BoundAdminUrlOptions {
  readonly prefix?: RelativeAdminPrefix;
}

const RELATIVE_ADMIN_BASE = './?';

/** `<prefix>muraAction=<circuit>.<action>&…`, the source-relative admin link legacy views write literally. */
export function relativeAdminUrl(
  circuit: string,
  action: string,
  params: BoundAdminParams = [],
  { html = false, encode = 'url', prefix = './?' }: RelativeAdminUrlOptions = {},
): string {
  const url = adminUrl({ circuit, action, context: '', adminDir: '.', html, params: adminParams(params, encode) });
  return prefix + url.slice(RELATIVE_ADMIN_BASE.length);
}

/** Request state FW/1 URL building depends on. */
export interface BuildUrlOptions {
  /** `request.generateSES`: the admin request carried path-info segments, so links use `/section/item/name/value`. */
  readonly ses?: boolean;
}

/**
 * FW/1 `buildURL` with the admin's framework settings.
 * `path` defaults to {@link adminScriptName}, which views and path-less redirects emit; callers reproducing
 * `path="./"` pass it explicitly.
 */
export function buildUrl(
  action: string,
  path: string = adminScriptName(),
  queryString = '',
  { ses = false }: BuildUrlOptions = {},
): string {
  let target = action;
  let query = queryString;
  if (target.includes('?') && query === '') {
    query = listRest(target, '?');
    target = listFirst(target, '?#');
  }
  let cosmetic = fullyQualified(target);
  const isHome = cfEq(cosmetic, FW1_HOME_ACTION);
  const isDefaultItem = cfEq(listLast(sectionAndItem(cosmetic), '.'), DEFAULT_ITEM);

  let initialDelim = '?';
  let varDelim = '&';
  const sesLinks = !path.includes('?') && ses;
  if (path.includes('?')) {
    initialDelim = path.endsWith('?') || path.endsWith('&') ? '' : '&';
  } else if (sesLinks) {
    initialDelim = '/';
    varDelim = '/';
  }
  let curDelim = varDelim;

  if (cfEq(subsystemOf(cosmetic), DEFAULT_SUBSYSTEM)) cosmetic = sectionAndItem(cosmetic);

  let extraArgs = '';
  let queryPart = '';
  let anchor = '';
  if (query !== '') {
    extraArgs = listFirst(query, '?#');
    if (query.includes('?')) queryPart = listRest(query, '?');
    if (query.includes('#')) anchor = listRest(query, '#');
    if (sesLinks) extraArgs = listItems(extraArgs, '&=').join('/');
  }

  let url: string;
  if (sesLinks) {
    if (isHome && extraArgs === '') url = path;
    else if (isDefaultItem && extraArgs === '') url = path + initialDelim + listFirst(cosmetic, '.');
    else url = path + initialDelim + cosmetic.replace('.', '/');
  } else if (isHome) {
    url = path;
    curDelim = '?';
  } else {
    url = `${path}${initialDelim}${ACTION_KEY}=${isDefaultItem ? listFirst(cosmetic, '.') : cosmetic}`;
  }

  if (extraArgs !== '') {
    url += curDelim + extraArgs;
    curDelim = varDelim;
  }
  if (queryPart !== '') url += (sesLinks ? '?' : curDelim) + queryPart;
  if (anchor !== '') url += `#${anchor}`;
  return url;
}

/** Inputs of {@link fw1RedirectTarget}. */
export interface Fw1RedirectOptions extends BuildUrlOptions {
  readonly action: string;
  /** The `append` keys present in `rc` with simple values, as `[key, value]` in `append` order. */
  readonly append?: ReadonlyArray<readonly [key: string, value: string]>;
  readonly queryString?: string;
  /** Defaults to {@link adminScriptName}, like {@link buildUrl}. */
  readonly path?: string;
  /** Flash-context key returned by saving `preserve`; emitted as `fw1pk`. */
  readonly preserveKey?: string | number;
}

/** The `Location` FW/1 `redirect()` sends; flash-context storage is the caller's. */
export function fw1RedirectTarget({
  action,
  append = [],
  queryString = '',
  path = adminScriptName(),
  preserveKey,
  ses,
}: Fw1RedirectOptions): string {
  let query = append.map(([key, value]) => `${key}=${esapiUrlEncode(value)}`).join('&');
  if (query === '') query = queryString;
  else if (queryString !== '') query += /^[?#]/.test(queryString) ? queryString : `&${queryString}`;

  const target = buildUrl(action, path, query, { ses });
  const key = preserveKey === undefined ? '' : String(preserveKey);
  if (key === '') return target;
  const param = `${target.includes('?') ? '&' : '?'}${PRESERVE_KEY_URL_KEY}=${key}`;
  return target.includes('#') ? `${listFirst(target, '#')}${param}#${listRest(target, '#')}` : target + param;
}

/** Inputs of {@link adminPath}. */
export interface AdminPathOptions {
  readonly useProtocol?: boolean;
  /** Defaults to the `admindomain` setting; `''` yields the relative `<context><adminDir>`. */
  readonly domain?: string;
  /** The request is HTTPS (`X-Forwarded-Proto`). */
  readonly https: boolean;
  /** `cgi.http_host`, read only when `domain` equals the `admindomain` setting; defaults to `domain`. */
  readonly httpHost?: string;
}

/** configBean `getAdminPath`: `[<scheme>:]//<domain><port><context><adminDir>`, or `<context><adminDir>` without a domain. */
export function adminPath({ useProtocol = true, domain, https, httpHost }: AdminPathOptions): string {
  const { context, adminDir, adminDomain, adminSSL, serverPort } = legacySettings();
  const requested = domain ?? adminDomain;
  if (requested === '') return context + adminDir;
  let host = requested;
  if (cfEq(requested, adminDomain)) {
    const currentHost = httpHost ?? requested;
    const hostName = listFirst(currentHost, ':');
    host = listHasNoCase(adminDomain, hostName) ? hostName : currentHost;
  }
  const scheme = useProtocol ? `${adminSSL || https ? 'https' : 'http'}:` : '';
  return `${scheme}//${host}${serverPort}${context}${adminDir}`;
}

/** Site-registry data, supplied by the caller, that {@link sanitizeHref} checks absolute URLs against. */
export interface HrefDomains {
  /** settingsManager `getAccessControlOriginDomainList()` entries. */
  readonly allowedDomains: readonly string[];
  /** Domain of the site the href is sanitized for (the session's site unless one is named). */
  readonly siteDomain: string;
}

const URL_DOMAIN = /^\w+:\/\/([^/:]+)[\s\S]*$/;

/**
 * utility `sanitizeHref`: scheme-relative hrefs become root-relative, `//host` runs are cut from absolute http(s)
 * paths, and an absolute http(s) host outside `allowedDomains` is replaced by `siteDomain`; anything else passes.
 * Throws `RangeError` for an absolute URL whose path starts right after `://`, where legacy fails.
 */
export function sanitizeHref(href: string, { allowedDomains, siteDomain }: HrefDomains): string {
  let clean = javaTrim(href);
  if (clean === '') return href;

  if (clean.startsWith('//')) {
    if (clean.length === 2) return '/';
    clean = clean.slice(2);
    return clean.startsWith('/') ? clean : `/${clean}`;
  }

  const scheme = listFirst(clean, ':');
  if (!listHasNoCase('http,https', scheme)) return clean;

  const protocolEnd = clean.indexOf('://');
  if (protocolEnd >= 0) {
    const afterProtocol = clean.slice(protocolEnd + 3);
    const slashAt = afterProtocol.indexOf('/');
    // ACF raises here: left(afterProtocol, 0) rejects a zero length.
    if (slashAt === 0) throw new RangeError(`sanitizeHref: no host before the path of ${clean}`);
    if (slashAt > 0) {
      const pathPart = afterProtocol.slice(slashAt).replace(/\/\/[^/]+/g, '');
      clean = `${scheme}://${afterProtocol.slice(0, slashAt)}${pathPart}`;
    }
  }

  // utility.parseDomain; its `//` branch cannot apply, since scheme-relative hrefs returned above.
  const urlDomain = URL_DOMAIN.exec(clean)?.[1] ?? clean;
  if (urlDomain !== '' && !listHasNoCase(allowedDomains.join(','), urlDomain)) {
    clean = clean.replace(urlDomain, () => siteDomain);
  }
  return clean;
}

/** Options of {@link assetUrl}. */
export interface AssetUrlOptions {
  /** Append `?coreversion=<application.coreversion>`, as the legacy tag does. */
  readonly coreversion?: boolean;
}

/** Legacy static asset URL `<context><path>`, served in place by legacy. */
export function assetUrl(path: string, { coreversion = false }: AssetUrlOptions = {}): string {
  const { context, version } = legacySettings();
  return coreversion ? `${context}${path}?coreversion=${version}` : `${context}${path}`;
}

/** Admin asset URL `<context><adminDir>/assets/<rel>`. */
export function adminAssetUrl(rel: string, options?: AssetUrlOptions): string {
  return assetUrl(`${legacySettings().adminDir}/assets/${rel}`, options);
}
