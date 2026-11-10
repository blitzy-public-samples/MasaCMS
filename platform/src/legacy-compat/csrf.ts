import { cfDateAdd, formatCsrfExpires } from './dates.js';
import { cfHash } from './headers.js';

/** Form fields legacy reads the token from (sessionUserFacade.cfc:217,228). */
export const CSRF_FIELD_TOKEN = 'csrf_token';
export const CSRF_FIELD_EXPIRES = 'csrf_token_expires';
/** Request headers the JSON API copies into those fields (jsonApiUtility.cfc:837-843). */
export const CSRF_HEADER_TOKEN = 'X-csrf_token';
export const CSRF_HEADER_EXPIRES = 'X-csrf_token_expires';
/** Token lifetime and used-ledger retention, in hours (sessionUserFacade.cfc:212,237). */
export const CSRF_TOKEN_LIFETIME_HOURS = 3;

/** A token and its `yyMMddHHnnsslll` expiry. */
export interface CsrfTokens {
  token: string;
  expires: string;
}

/** Used-token ledger: token to the time it was consumed (session.mura.csrfusedtokens). */
export type CsrfUsedLedger = ReadonlyMap<string, Date> | Record<string, Date>;

const CF_NUMERIC = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/** CFML `a > b` on strings: numeric when both are numeric, otherwise case-insensitive string order. */
function cfmlGreaterThan(a: string, b: string): boolean {
  if (CF_NUMERIC.test(a) && CF_NUMERIC.test(b)) return Number(a) > Number(b);
  return a.toLowerCase() > b.toLowerCase();
}

const isMap = (used: CsrfUsedLedger): used is ReadonlyMap<string, Date> => used instanceof Map;

/** structKeyExists on the ledger; CFML struct keys are case-insensitive. */
function hasTokenNoCase(used: ReadonlyMap<string, Date>, token: string): boolean {
  const wanted = token.toLowerCase();
  for (const key of used.keys()) {
    if (key.toLowerCase() === wanted) return true;
  }
  return false;
}

/** Copy of the ledger without entries consumed more than three hours before `now` (sessionUserFacade.cfc:211-215). */
export function purgeUsedTokens(used: CsrfUsedLedger, now: Date = new Date()): Map<string, Date> {
  const cutoff = cfDateAdd('h', -CSRF_TOKEN_LIFETIME_HOURS, now).getTime();
  const entries = isMap(used) ? [...used.entries()] : Object.entries(used);
  // Legacy deletes only entries strictly older than the cutoff.
  return new Map(entries.filter(([, at]) => !(at.getTime() < cutoff)));
}

/** Token and expiry for `context` as generateCSRFTokens issues them on ACF 10+ (sessionUserFacade.cfc:243-251). */
export function generateCsrfToken(a: { context?: string; secret: string; now?: Date }): CsrfTokens {
  const now = a.now ?? new Date();
  const ms = now.getMilliseconds();
  // Legacy's `currentDateTime + timespan` drops the milliseconds that dateAdd('l') then adds back once, so expiry is
  // exactly now + 3 h, as tokens captured from the ACF 2023 oracle show; the milliseconds are not counted twice.
  const wholeSecond = new Date(now.getTime() - ms);
  const expires = formatCsrfExpires(cfDateAdd('l', ms, cfDateAdd('h', CSRF_TOKEN_LIFETIME_HOURS, wholeSecond)));
  return { token: cfHash((a.context ?? '') + a.secret + expires), expires };
}

/**
 * validateCSRFTokens on ACF 10+ (sessionUserFacade.cfc:206-235): purges the ledger, then accepts an unused,
 * unexpired token equal (case-insensitively) to the hash and records it used. Returns a new ledger either way.
 */
export function validateCsrfToken(a: {
  token?: string;
  expires?: string;
  context?: string;
  secret: string;
  used: CsrfUsedLedger;
  now?: Date;
}): { valid: boolean; used: Map<string, Date> } {
  const now = a.now ?? new Date();
  const used = purgeUsedTokens(a.used, now);
  const token = a.token ?? '';
  if (token === '' || hasTokenNoCase(used, token)) return { valid: false, used };
  const expires = a.expires ?? '';
  const valid =
    cfmlGreaterThan(expires, formatCsrfExpires(now)) &&
    token.toLowerCase() === cfHash((a.context ?? '') + a.secret + expires).toLowerCase();
  if (valid) used.set(token, now);
  return { valid, used };
}

/** renderCSRFTokens output; formats other than url and json render hidden fields (sessionUserFacade.cfc:254-270). */
export function renderCsrfFields(t: CsrfTokens, format: 'form' | 'url' | 'json' = 'form'): string {
  switch (format) {
    case 'url':
      return `&${CSRF_FIELD_TOKEN}=${t.token}&${CSRF_FIELD_EXPIRES}=${t.expires}`;
    case 'json':
      return `{${CSRF_FIELD_TOKEN}:'${t.token}',${CSRF_FIELD_EXPIRES}:'${t.expires}'}`;
    default:
      return (
        `<input type="hidden" name="${CSRF_FIELD_TOKEN}" value="${t.token}" />` +
        `<input type="hidden" name="${CSRF_FIELD_EXPIRES}" value="${t.expires}" />`
      );
  }
}
