// The `Set-Cookie` values ACF 2023 writes itself for `expires="never"`: cookie-scope struct assignments and <cfcookie>.
import { formatCookieExpires } from './dates.js';

/** The `Max-Age` ACF writes for `expires="never"`: 30 years of 365 days, in seconds. */
const NEVER_MAX_AGE = 946_080_000;

/** `Max-Age` and GMT `Expires` of a `never` cookie set at `now`; the cookie scope prints the hour as 01-12 without AM/PM. */
function neverLifetime(now: Date, twelveHour: boolean): string {
  const at = new Date(now.getTime() + NEVER_MAX_AGE * 1000);
  const expires = formatCookieExpires(at);
  const hour = String(at.getUTCHours() % 12 || 12).padStart(2, '0');
  return `Max-Age=${NEVER_MAX_AGE}; Expires=${twelveHour ? expires.replace(/ \d{2}:/, ` ${hour}:`) : expires}`;
}

/** `cookie[name]={value, expires='never', httponly=true, secure}` as ACF writes it; `value` is already URL-encoded. */
export function cookieScopeNeverCookie(name: string, value: string, secure: boolean, now: Date): string {
  return `${name}=${value}; ${neverLifetime(now, true)}; Path=/; ${secure ? 'Secure; ' : ''}HttpOnly; SameSite=Lax`;
}

/** `<cfcookie expires="never" httponly=httpOnly domain=domain>` as ACF writes it, a blank domain left out; `value` is already URL-encoded. */
export function cfcookieNeverCookie(name: string, value: string, secure: boolean, now: Date, httpOnly = false, domain = ''): string {
  const attributes = `${domain === '' ? '' : `domain=${domain}; `}${secure ? 'secure; ' : ''}${httpOnly ? 'HttpOnly; ' : ''}`;
  return `${name}=${value}; path=/; ${attributes}${neverLifetime(now, false)}`;
}
