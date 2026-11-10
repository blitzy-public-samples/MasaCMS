// Legacy Set-Cookie writer and cookie parsing (utility.cfc:683-861).
import { cfDateAdd, formatCookieExpires } from './dates.js';
import { cfIsNumeric, cfToNumber } from './serializer.js';

/** Session cookie names ACF issues and the gateway jar maps. */
export const LEGACY_SESSION_COOKIE_NAMES = ['CFID', 'CFTOKEN', 'JSESSIONID'] as const;

/** configBean cookie settings (utility.cfc:711-733,805-817); unset fields take configBean defaults (configBean.cfc:213-216). */
export interface LegacyCookieConfig {
  secureCookies?: boolean;
  cookieDomain?: string;
  cookiePath?: string;
  sessionCookiesExpires?: string;
}

/** setCookieLegacy arguments (utility.cfc:794-801). */
export interface LegacyCookieOptions {
  name: string;
  value: string;
  /** ''|'now'|'never'|Date|days, as a number or numeric string. */
  expires?: '' | 'now' | 'never' | Date | number | string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** CFML argument spelling; arguments are case-insensitive in legacy. */
  httponly?: boolean;
  maintainCase?: boolean;
}

/** A parsed Set-Cookie header; `raw` is the input, re-emitted unchanged. */
export interface ParsedSetCookie {
  name: string;
  value: string;
  attributes: Array<[string, string | true]>;
  raw: string;
}

const CONFIG_DEFAULT_SESSION_EXPIRES = 'never';

/** Expiry instant for the expires argument (utility.cfc:827-843); cfswitch matches case-insensitively. */
function expiryDate(expires: Date | number | string, now: Date): Date | undefined {
  if (expires instanceof Date) return expires;
  if (typeof expires === 'number') return cfDateAdd('d', expires, now);
  switch (expires.toLowerCase()) {
    case '':
      return undefined;
    case 'now':
      return cfDateAdd('d', -1, now);
    case 'never':
      return cfDateAdd('yyyy', 30, now);
  }
  // Date strings are not parsed: callers pass Date objects, and configBean holds only keywords or day counts.
  return cfIsNumeric(expires) ? cfDateAdd('d', cfToNumber(expires), now) : undefined;
}

/** Set-Cookie header value legacy writes, header name SET-COOKIE (utility.cfc:793-861). */
export function setCookieLegacy(
  o: LegacyCookieOptions,
  cfg: LegacyCookieConfig = {},
  now: Date = new Date(),
): string {
  const cookieDomain = cfg.cookieDomain ?? '';
  const cookiePath = cfg.cookiePath ?? '';
  const secure = cfg.secureCookies === true || (o.secure ?? false);
  const domain = cookieDomain !== '' ? cookieDomain : (o.domain ?? '');
  let path = o.path ?? '/';
  if (cookiePath !== '' && cookieDomain !== '') path = cookiePath;
  else if (cookieDomain !== '') path = '/';
  const httpOnly = o.httpOnly ?? o.httponly ?? true;

  let c = `${o.maintainCase === true ? o.name : o.name.toUpperCase()}=${o.value};`;
  const expDate = expiryDate(o.expires ?? '', now);
  if (expDate !== undefined) c += `expires=${formatCookieExpires(expDate)};`;
  if (domain !== '') c += `domain=${domain};`;
  if (path !== '') c += `path=${path};`;
  if (secure) c += 'secure;';
  if (httpOnly) c += 'HttpOnly;';
  return c;
}

/** Expiring Set-Cookie value legacy deleteCookie writes: case kept, empty value, expires now (utility.cfc:741-749). */
export function deleteCookieLegacy(name: string, cfg?: LegacyCookieConfig, now?: Date): string {
  return setCookieLegacy({ name, value: '', expires: '0', maintainCase: true }, cfg, now);
}

const isSessionOnly = (expires: string, keywords: readonly string[]): boolean =>
  keywords.includes(expires.toLowerCase());

/** Set-Cookie values setSessionCookies writes on ACF, in order (utility.cfc:708-735); the reset/absent-cookie test (line 708) is the caller's. */
export function sessionCookieStrings(
  tokens: { CFID?: string; CFTOKEN?: string; jsessionid?: string },
  cfg: LegacyCookieConfig,
  now?: Date,
): string[] {
  const configured = cfg.sessionCookiesExpires ?? CONFIG_DEFAULT_SESSION_EXPIRES;
  const out: string[] = [];
  if (tokens.CFID !== undefined) {
    // Legacy reads sessionTokens.CFTOKEN unguarded once CFID exists (utility.cfc:720-724).
    if (tokens.CFTOKEN === undefined) throw new TypeError('CFTOKEN is required with CFID');
    const expires = isSessionOnly(configured, ['', 'session', 'session only']) ? '' : configured;
    out.push(setCookieLegacy({ name: 'CFID', value: tokens.CFID, expires }, cfg, now));
    out.push(setCookieLegacy({ name: 'CFTOKEN', value: tokens.CFTOKEN, expires }, cfg, now));
  }
  if (tokens.jsessionid !== undefined) {
    const expires = isSessionOnly(configured, ['', 'session']) ? '' : configured;
    out.push(setCookieLegacy({ name: 'JSESSIONID', value: tokens.jsessionid, expires }, cfg, now));
  }
  return out;
}

/** Splits at the first '=': [name, value], or [segment, undefined] when there is none. */
function splitPair(segment: string): [string, string | undefined] {
  const eq = segment.indexOf('=');
  return eq < 0 ? [segment, undefined] : [segment.slice(0, eq), segment.slice(eq + 1)];
}

/** Parses a Set-Cookie header in legacy (`a=b;path=/;`) or standard (`a=b; Path=/`) form, keeping attribute order and case. */
export function parseSetCookie(header: string): ParsedSetCookie {
  const [pair = '', ...rest] = header.split(';');
  const [rawName, rawValue] = splitPair(pair);
  // RFC 6265bis: a pair without '=' is a value with an empty name.
  const name = rawValue === undefined ? '' : rawName.trim();
  const value = (rawValue ?? rawName).trim();
  const attributes: Array<[string, string | true]> = [];
  for (const segment of rest) {
    if (segment.trim() === '') continue;
    const [attrName, attrValue] = splitPair(segment);
    attributes.push([attrName.trim(), attrValue === undefined ? true : attrValue.trim()]);
  }
  return { name, value, attributes, raw: header };
}

/** Map keyed by lower-cased cookie name; get/has/set/delete take any case, as the CFML cookie scope does. */
class CookieNameMap extends Map<string, string> {
  override get(name: string): string | undefined {
    return super.get(name.toLowerCase());
  }

  override has(name: string): boolean {
    return super.has(name.toLowerCase());
  }

  override set(name: string, value: string): this {
    return super.set(name.toLowerCase(), value);
  }

  override delete(name: string): boolean {
    return super.delete(name.toLowerCase());
  }
}

/** Request Cookie header as a map with lower-cased keys and case-insensitive lookup; values are not decoded. */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new CookieNameMap();
  for (const segment of (header ?? '').split(';')) {
    const [rawName, rawValue] = splitPair(segment);
    const name = rawName.trim();
    // First occurrence wins: browsers send the most specific path first (RFC 6265 5.4).
    if (name !== '' && !cookies.has(name)) cookies.set(name, (rawValue ?? '').trim());
  }
  return cookies;
}

/** True for CFID, CFTOKEN and JSESSIONID in any case. */
export function isLegacySessionCookie(name: string): boolean {
  const upper = name.toUpperCase();
  return LEGACY_SESSION_COOKIE_NAMES.some((n) => n === upper);
}
