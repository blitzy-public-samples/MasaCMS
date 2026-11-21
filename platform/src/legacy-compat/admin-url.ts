/** Legacy admin URL builder, parser and site fallback (admin/Application.cfc, admin/common/layouts/includes/nav.cfm). */

/** Query parameter as `[name, value, encoding]`; `'url'` (default) applies `esapiEncode('url')`, `'raw'` interpolates as is. */
export type AdminParam = [name: string, value: string | number, encoding?: 'url' | 'raw'];

/** Inputs of {@link adminUrl}; `adminDir` and `context` mirror configBean `adminDir` and `context`. */
export interface AdminUrlOptions {
  circuit: string;
  action: string;
  params?: AdminParam[];
  adminDir?: string;
  context?: string;
  html?: boolean;
}

/** Result of {@link parseAdminUrl}; parameter values are URL-decoded. */
export interface ParsedAdminUrl {
  circuit: string;
  action: string;
  params: Array<[string, string]>;
}

/** FW/1 home action `core:home.redirect` without the subsystem (admin/Application.cfc:151). */
export const ADMIN_HOME_ACTION = 'home.redirect';

/** Access-gate target for users without site access; Application.cfc:445 writes the circuit lower-case. */
export const ADMIN_LOGIN_REDIRECT = Object.freeze({ circuit: 'clogin', action: 'logout' } as const);

/** Access-gate target for unauthorised users (admin/Application.cfc:451). */
export const ADMIN_NOACCESS = Object.freeze({ circuit: 'cMessage', action: 'noaccess' } as const);

/** `muraAction` value of {@link ADMIN_LOGIN_REDIRECT}. */
export const ADMIN_LOGIN_REDIRECT_ACTION = `${ADMIN_LOGIN_REDIRECT.circuit}.${ADMIN_LOGIN_REDIRECT.action}` as const;

/** `muraAction` value of {@link ADMIN_NOACCESS}. */
export const ADMIN_NOACCESS_ACTION = `${ADMIN_NOACCESS.circuit}.${ADMIN_NOACCESS.action}` as const;

/** True for the characters Java `URLEncoder` leaves unchanged: `A-Z a-z 0-9 . - * _`. */
function isUrlSafe(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2e ||
    code === 0x2d ||
    code === 0x2a ||
    code === 0x5f
  );
}

/** UTF-8 bytes of one code point; a lone surrogate becomes `?`, as Java `String.getBytes(UTF_8)` does. */
function utf8Bytes(cp: number): number[] {
  if (cp >= 0xd800 && cp <= 0xdfff) return [0x3f];
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

/** ESAPI `encodeForURL`, i.e. Java `URLEncoder.encode(s, 'UTF-8')`: space as `+`, other bytes as uppercase `%XX`. */
export function esapiUrlEncode(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (isUrlSafe(cp)) {
      out += ch;
    } else if (cp === 0x20) {
      out += '+';
    } else {
      for (const b of utf8Bytes(cp)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Escapes `&` as `&amp;` and nothing else, for parameter separators inside HTML attributes. */
export function htmlAttr(s: string): string {
  return s.replaceAll('&', '&amp;');
}

/** `<context><adminDir>/?muraAction=<circuit>.<action>` then `&name=value` per param in order; case kept, `html` joins with `&amp;`. */
export function adminUrl(a: AdminUrlOptions): string {
  const { circuit, action, params = [], adminDir = '/admin', context = '', html = false } = a;
  const separator = html ? htmlAttr('&') : '&';
  let url = `${context}${adminDir}/?muraAction=${circuit}.${action}`;
  for (const [name, value, encoding = 'url'] of params) {
    const text = String(value);
    url += `${separator}${name}=${encoding === 'raw' ? text : esapiUrlEncode(text)}`;
  }
  return url;
}

const ACTION_PARAM_NAMES: ReadonlySet<string> = new Set(['muraaction', 'fuseaction']);

/** Decodes a form-encoded value (`+` as space); a malformed `%` sequence is kept as written. */
function formDecode(value: string): string {
  const spaced = value.replaceAll('+', ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * Inverse of {@link adminUrl}; `fuseaction` overrides `muraAction` (admin/Application.cfc:161-166), names match as in the
 * CF URL scope (case-insensitive, repeats joined by `,`), the subsystem is dropped. Undefined when no action is named.
 */
export function parseAdminUrl(href: string): ParsedAdminUrl | undefined {
  const hashAt = href.indexOf('#');
  const withoutHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  if (queryAt < 0) return undefined;

  const pairs = withoutHash
    .slice(queryAt + 1)
    .replaceAll('&amp;', '&')
    .split('&')
    .filter((segment) => segment !== '')
    .map((segment): [string, string] => {
      const eqAt = segment.indexOf('=');
      return eqAt < 0 ? [segment, ''] : [segment.slice(0, eqAt), formDecode(segment.slice(eqAt + 1))];
    });

  const valuesOf = (name: string): string[] =>
    pairs.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  const fuseaction = valuesOf('fuseaction');
  const actionValue = (fuseaction.length > 0 ? fuseaction : valuesOf('muraaction')).join(',');

  const sectionAndItem = actionValue.slice(actionValue.lastIndexOf(':') + 1);
  const [circuit, ...rest] = sectionAndItem.split('.').filter((part) => part !== '');
  if (circuit === undefined) return undefined;

  return {
    circuit,
    action: rest.at(-1) ?? 'default',
    params: pairs.filter(([key]) => !ACTION_PARAM_NAMES.has(key.toLowerCase())),
  };
}

/** Site id the JSON/REST API resolves: `siteid` when non-empty and known, else `default` (contentServer.cfc:610-622). */
export function fallbackSiteId(siteid: string | undefined, siteExists: (id: string) => boolean): string {
  return siteid && siteExists(siteid) ? siteid : 'default';
}
