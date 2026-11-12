// Authentication behaviour of the golden normaliser: Set-Cookie attributes and persistence, WWW-Authenticate, redirects.
import { parseDate } from 'tough-cookie';
import { LEGACY_SESSION_COOKIE_NAMES, parseSetCookie } from '@opt2/platform/legacy-compat';
import type { HttpHop } from '../../lib/http.js';
import type { RecordedResponse } from '../steps.js';
import type { NormaliseRules } from './rules.js';
import { normaliseUrl } from './values.js';

/** Persistence class of a Set-Cookie: no expiry, an expiry after the response, or one before it. */
export type CookiePersistence = 'session' | 'persistent' | 'expired';

/** A session cookie value against the scenario's previous one: none yet, the same value, or another. */
export type CookieRotation = 'first' | 'same' | 'changed';

/** One Set-Cookie as compared; the raw value never appears. */
export interface NormalisedCookie {
  /** Exact case, as written. */
  name: string;
  /** The `auth.cookies.value` placeholder for a non-empty value; '' for an empty (clearing) one. */
  value: string;
  path?: string;
  /** Lower-cased. */
  domain?: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
  persistence: CookiePersistence;
  /** Index of the hop that set it. */
  hop: number;
  /** Session cookies (`CFID`, `CFTOKEN`, `JSESSIONID`) only. */
  rotation?: CookieRotation;
}

/** Last raw value of each session cookie on one scenario side, keyed by lower-cased name. */
export type SessionCookieTracker = Map<string, string>;

/** Empty tracker for one scenario side. */
export function createSessionCookieTracker(): SessionCookieTracker {
  return new Map();
}

/** Options of {@link normaliseSetCookies}. */
export interface NormaliseSetCookiesOptions {
  hop: number;
  /** The response's `Date`; without it, an `Expires` before 1971-01-01 is expired. */
  referenceDate?: Date;
  tracker: SessionCookieTracker;
}

/** A followed redirect: its status and normalised `Location`. */
export interface NormalisedRedirect {
  status: number;
  location: string;
}

/** Cookies, `WWW-Authenticate` values and redirect targets of one response. */
export interface NormalisedAuth {
  cookies: NormalisedCookie[];
  wwwAuthenticate: string[];
  redirectTargets: NormalisedRedirect[];
}

/** The parts of a scenario side's normalise state this module reads and updates. */
export interface AuthNormaliseState {
  readonly ids: Parameters<typeof normaliseUrl>[1];
  readonly sessionCookies: SessionCookieTracker;
}

type Attributes = ReadonlyMap<string, string | true>;

/** One response of the exchange as this module reads it. */
interface Exchange {
  status: number;
  headers: Record<string, string | string[]>;
  setCookie: readonly string[];
  location: string | undefined;
}

// Reference for an `Expires` when the response carries no `Date`: deletion cookies are written for the epoch.
const NO_DATE_REFERENCE = new Date(Date.UTC(1971, 0, 1));
// RFC 6265 5.2.2: Max-Age is an optional '-' and digits; anything else is ignored.
const MAX_AGE = /^-?\d+$/;
const DATE_HEADER = 'date';
const LOCATION_HEADER = 'location';
const WWW_AUTHENTICATE_HEADER = 'www-authenticate';

const lowerCase = (value: string): string => value.toLowerCase();
const codeUnitOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function headerValues(headers: Record<string, string | string[]>, name: string): string[] {
  const value = headers[name];
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : [...value];
}

// Attribute names fold to lower case; a repeated attribute takes its last value (RFC 6265 5.3).
function attributeMap(attributes: readonly (readonly [string, string | true])[]): Attributes {
  return new Map(attributes.map(([name, value]) => [name.toLowerCase(), value]));
}

// A kept attribute's text as written; a bare attribute without '=' is ''.
function keptText(attrs: Attributes, kept: ReadonlySet<string>, name: string): string | undefined {
  if (!kept.has(name)) return undefined;
  const value = attrs.get(name);
  return value === undefined ? undefined : value === true ? '' : value;
}

// Max-Age takes precedence over Expires (RFC 6265 5.3 step 3); an unparseable one is ignored.
function persistenceOf(attrs: Attributes, from: ReadonlySet<string>, referenceDate: Date | undefined): CookiePersistence {
  const maxAge = from.has('max-age') ? attrs.get('max-age') : undefined;
  if (typeof maxAge === 'string' && MAX_AGE.test(maxAge)) return Number(maxAge) <= 0 ? 'expired' : 'persistent';
  const expiresText = from.has('expires') ? attrs.get('expires') : undefined;
  const expires = typeof expiresText === 'string' ? parseDate(expiresText) : undefined;
  if (expires === undefined) return 'session';
  return expires.getTime() < (referenceDate ?? NO_DATE_REFERENCE).getTime() ? 'expired' : 'persistent';
}

function byHopNamePath(a: NormalisedCookie, b: NormalisedCookie): number {
  return a.hop - b.hop || codeUnitOrder(a.name, b.name) || codeUnitOrder(a.path ?? '', b.path ?? '');
}

/**
 * Set-Cookie lines of one hop, normalised and sorted by `(hop, name, path)`. Session cookies get a `rotation`
 * against `opts.tracker`, which is then updated in recorded order.
 * @param setCookies Raw Set-Cookie lines, in the order they were received.
 */
export function normaliseSetCookies(
  setCookies: readonly string[],
  opts: NormaliseSetCookiesOptions,
  rules: NormaliseRules,
): NormalisedCookie[] {
  const rule = rules.auth.cookies;
  const kept = new Set(rule.keepAttributes.map(lowerCase));
  const from = new Set(rule.persistence.from.map(lowerCase));
  const sessionNames = new Set([...LEGACY_SESSION_COOKIE_NAMES, ...rule.sessionNames].map(lowerCase));
  const cookies = setCookies.map((line): NormalisedCookie => {
    const { name, value, attributes } = parseSetCookie(line);
    const attrs = attributeMap(attributes);
    const path = keptText(attrs, kept, 'path');
    const domain = keptText(attrs, kept, 'domain');
    const sameSite = keptText(attrs, kept, 'samesite');
    const key = name.toLowerCase();
    let rotation: CookieRotation | undefined;
    if (sessionNames.has(key)) {
      const tracked = opts.tracker.get(key);
      rotation = tracked === undefined ? 'first' : tracked === value ? 'same' : 'changed';
      opts.tracker.set(key, value);
    }
    return {
      name,
      value: value === '' ? '' : rule.value,
      ...(path === undefined ? {} : { path }),
      ...(domain === undefined ? {} : { domain: domain.toLowerCase() }),
      httpOnly: kept.has('httponly') && attrs.has('httponly'),
      secure: kept.has('secure') && attrs.has('secure'),
      ...(sameSite === undefined ? {} : { sameSite }),
      persistence: persistenceOf(attrs, from, opts.referenceDate),
      hop: opts.hop,
      ...(rotation === undefined ? {} : { rotation }),
    };
  });
  return cookies.sort(byHopNamePath);
}

function fromHop(hop: HttpHop): Exchange {
  return { status: hop.status, headers: hop.responseHeaders, setCookie: hop.setCookie, location: hop.location };
}

// `hops` ends with the final response (lib/http.ts), so the final response is read on its own only without hops.
function exchangesOf(response: RecordedResponse, setCookieHeader: string): Exchange[] {
  if (response.hops.length > 0) return response.hops.map(fromHop);
  return [
    {
      status: response.status,
      headers: response.headers,
      setCookie: headerValues(response.headers, setCookieHeader),
      location: headerValues(response.headers, LOCATION_HEADER)[0],
    },
  ];
}

/**
 * Authentication view of a recorded response: every hop's cookies in hop order, the final `WWW-Authenticate`
 * values verbatim, and each redirect hop's `Location` through {@link normaliseUrl}. Updates `state`.
 */
export function normaliseAuth(
  response: RecordedResponse,
  state: AuthNormaliseState,
  rules: NormaliseRules,
): NormalisedAuth {
  const exchanges = exchangesOf(response, rules.auth.cookies.header.toLowerCase());
  const cookies = exchanges.flatMap((exchange, hop) => {
    const dateHeader = headerValues(exchange.headers, DATE_HEADER)[0];
    const referenceDate = dateHeader === undefined ? undefined : parseDate(dateHeader);
    return normaliseSetCookies(
      exchange.setCookie,
      { hop, tracker: state.sessionCookies, ...(referenceDate === undefined ? {} : { referenceDate }) },
      rules,
    );
  });
  const statuses = rules.auth.redirects.statuses;
  const redirectTargets = exchanges.flatMap(({ status, location }): NormalisedRedirect[] =>
    location !== undefined && statuses.includes(status)
      ? [{ status, location: normaliseUrl(location, state.ids, rules) }]
      : [],
  );
  return {
    cookies,
    wwwAuthenticate: headerValues(response.headers, WWW_AUTHENTICATE_HEADER),
    redirectTargets,
  };
}
