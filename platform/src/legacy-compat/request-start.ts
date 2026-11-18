// The cookies Masa's request start sets on every session-managed request: MXP_TRACKINGID and mobileFormat (onRequestStart_include.cfm:241-306).
import { cfcookieNeverCookie } from './acf-cookies.js';
import { cfUuid } from './ids.js';
import { portcullisInputsOf } from './request-scopes.js';
import { cfIsBoolean } from './serializer.js';

/** Request facts the request start reads; the url and form scopes are raw, since script protection runs after it. */
export interface RequestStartRequest {
  /** The `Cookie` header as sent. */
  cookieHeader?: string;
  /** `cgi.http_user_agent`. */
  userAgent?: string;
  /** Parsed query fields, as {@link portcullisInputsOf} takes them. */
  query?: unknown;
  /** Request target as sent; its query string orders the url values of names differing only in case. */
  url?: string;
  /** Parsed form fields, as {@link portcullisInputsOf} takes them. */
  form?: unknown;
  /** Whether legacy manages a session for the request; without one neither cookie is set. */
  sessionManaged: boolean;
}

/** Options of {@link requestStartSetCookies}. */
export interface RequestStartOptions {
  now: Date;
  /** A new session's `muraSessionID`; {@link cfUuid} by default. */
  newId?: () => string;
  /** configBean `secureCookies`. */
  secure?: boolean;
  /** configBean `cookieDomain`; blank sets no domain. */
  domain?: string;
}

/** Lower-cased names of the cookies the request start sets. */
export const REQUEST_START_COOKIE_NAMES: ReadonlySet<string> = new Set(['mxp_trackingid', 'mobileformat']);

const IPHONE_AGENT = /iphone/i;
const MOBILE_AGENT = /mobile/i;
const TABLET_AGENT = /tablet|ipad|xoom/i;

/** An unquoted cookie value as the servlet container reads it: up to a space, tab, comma or `=`. */
const UNQUOTED_VALUE = /^[^ \t,=]*/;

/** ACF `URLEncodedFormat`: every character but ASCII letters and digits as `%XX` of its UTF-8 bytes; a lone surrogate as `?`. */
export function cfUrlEncodedFormat(s: string): string {
  let out = '';
  for (const ch of s) {
    if (/^[A-Za-z0-9]$/.test(ch)) {
      out += ch;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    const bytes = cp >= 0xd800 && cp <= 0xdfff ? [0x3f] : [...Buffer.from(ch, 'utf8')];
    for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** A `Cookie` header as the servlet container parses it: raw values by lower-cased name, first occurrence kept. */
function containerCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const segment of header.split(';')) {
    const pair = segment.replace(/^[ \t]+/, '');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).toLowerCase();
    const rest = pair.slice(eq + 1);
    const close = rest.startsWith('"') ? rest.indexOf('"', 1) : 0;
    if (close === -1 || cookies.has(name)) continue;
    cookies.set(name, close > 0 ? rest.slice(1, close) : (UNQUOTED_VALUE.exec(rest)?.[0] ?? ''));
  }
  return cookies;
}

/** A cookie value as ACF's cookie scope reads it: `+` as a space, `%XX` runs as UTF-8 (invalid bytes as U+FFFD), any other `%` kept. */
function cookieScopeValue(raw: string): string {
  return raw
    .replaceAll('+', ' ')
    .replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replaceAll('%', ''), 'hex').toString('utf8'));
}

/** A raw url or form scope by lower-cased name, names differing only in case joined as ColdFusion builds it. */
function rawScope(fields: unknown, target?: string): Map<string, unknown> {
  return new Map(portcullisInputsOf(fields, target).map(([key, value]) => [key.toLowerCase(), value]));
}

/** The request start's user-agent test: an iPhone, or a mobile agent that is no tablet. */
function isMobileAgent(userAgent: string): boolean {
  return IPHONE_AGENT.test(userAgent) || (MOBILE_AGENT.test(userAgent) && !TABLET_AGENT.test(userAgent));
}

/** The request start's `Set-Cookie` values in order: MXP_TRACKINGID, then mobileFormat (none under `muraadminpreview`). */
export function requestStartSetCookies(req: RequestStartRequest, opts: RequestStartOptions): string[] {
  if (!req.sessionManaged) return [];
  const cookies = containerCookies(req.cookieHeader ?? '');
  // utility.setCookie is a <cfcookie expires="never" httpOnly=true preserveCase=true> under configBean's secure and
  // domain, which URL-encodes the value.
  const write = (name: string, value: string): string =>
    cfcookieNeverCookie(name, cfUrlEncodedFormat(value), opts.secure ?? false, opts.now, true, opts.domain ?? '');
  const out: string[] = [];
  if (!cookies.has('mxp_trackingid')) {
    const original = cookies.get('originalurltoken');
    out.push(write('MXP_TRACKINGID', original === undefined ? (opts.newId ?? cfUuid)() : cookieScopeValue(original)));
  }
  const url = rawScope(req.query, req.url);
  if (url.has('muraadminpreview')) return out;
  const chosen = [rawScope(req.form).get('mobileformat'), url.get('mobileformat')].find(
    (value) => value !== undefined && cfIsBoolean(value),
  );
  if (chosen !== undefined) out.push(write('mobileFormat', String(chosen)));
  else if (!cookies.has('mobileformat')) out.push(write('mobileFormat', String(isMobileAgent(req.userAgent ?? ''))));
  return out;
}
