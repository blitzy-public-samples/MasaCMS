// Header rules of the golden normaliser: dropped headers, the ETag check, Location and value comparison.
import { cfHash, type CfHashAlgorithm } from '@opt2/platform/legacy-compat';
import type { RecordedResponse } from '../steps.js';
import type { IdOrdinals } from './ids.js';
import type { HeaderRules, NormaliseRules } from './rules.js';
import { isTokenKey, normaliseText, normaliseUrl } from './values.js';

/** Volatile headers that are never compared; the rules' `headers.drop` extends this set. */
export const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  'date',
  'server',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'traceparent',
  'tracestate',
  'traceresponse',
  'x-request-id',
]);

/** ETag placeholder: the value is the legacy hash of its own body. */
export const ETAG_OK = '<etag:ok>';
/** ETag placeholder: legacy format, but not the hash of its own body. */
export const ETAG_MISMATCH = '<etag:mismatch>';
/** ETag placeholder: not in the legacy format. */
export const ETAG_INVALID = '<etag:invalid>';

/**
 * Headers whose values compare as exact strings: `Generator` and HSTS (onRequestStart_include.cfm:333-344),
 * the content type, `WWW-Authenticate` and `X-HTTP-Method-Override`.
 */
export const KEPT_BY_VALUE_HEADERS: ReadonlySet<string> = new Set([
  'generator',
  'strict-transport-security',
  'content-type',
  'www-authenticate',
  'x-http-method-override',
]);

/** Name prefixes of headers compared as exact strings: the CORS origin echo (jsonApiUtility.cfc:382-394). */
export const KEPT_BY_VALUE_PREFIXES: readonly string[] = ['access-control-'];

// Cookies are compared under `auth` by cookies.ts.
const SET_COOKIE = 'set-cookie';

/** Normalised response headers: lower-cased names in sorted order; repeated values keep their order. */
export type NormalisedHeaders = Record<string, string | string[]>;

/** The `headers.etag` rule. */
export type EtagRule = HeaderRules['etag'];

// Legacy's ETag is hash(result) with no algorithm (jsonApiUtility.cfc:1508); ACF 2023 hashes that with SHA-256,
// the platform cfHash default. The MD5 wording maps to the platform's only ColdFusion MD5 form, CFMX_COMPAT.
const SELF_CONSISTENCY_ALGORITHMS: Record<EtagRule['selfConsistency'], CfHashAlgorithm> = {
  'uppercase-sha256-of-raw-body': 'default',
  'uppercase-md5-of-raw-body': 'CFMX_COMPAT',
};

// Without a rule the format is uppercase hex as long as cfHash's own output, so it follows the legacy hash.
const DEFAULT_ETAG_FORMAT = new RegExp(`^[0-9A-F]{${cfHash('').length}}$`);

const exact = (value: string): string => value;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`, 'i');
}

function hasPrefix(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

function mediaType(contentType: string | string[] | undefined): string {
  const first = Array.isArray(contentType) ? contentType[0] : contentType;
  return first?.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Placeholder for ETag `value` checked against `rawBody`: {@link ETAG_OK} when it has the legacy format and equals
 * the legacy hash of the body, {@link ETAG_MISMATCH} when only the format holds, otherwise {@link ETAG_INVALID}.
 * A value in one pair of double quotes keeps them around the placeholder, so quoted and unquoted forms differ.
 * @param rawBody Exact body text the ETag covers, before any normalisation; absent counts as empty.
 * @param rule The rules' ETag rule (format, hash, placeholders); without it, the legacy hash form and the
 *   exported placeholders apply.
 */
export function normaliseEtag(value: string, rawBody: string | undefined, rule?: EtagRule): string {
  const quoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  const tag = quoted ? value.slice(1, -1) : value;
  const format = rule === undefined ? DEFAULT_ETAG_FORMAT : new RegExp(rule.format);
  const algorithm = rule === undefined ? 'default' : SELF_CONSISTENCY_ALGORITHMS[rule.selfConsistency];
  let outcome = ETAG_INVALID;
  if (format.test(tag)) {
    outcome =
      tag === cfHash(rawBody ?? '', algorithm)
        ? (rule?.placeholder ?? ETAG_OK)
        : (rule?.mismatchPlaceholder ?? ETAG_MISMATCH);
  }
  return quoted ? `"${outcome}"` : outcome;
}

// Names folded to lower case; a name present in several casings keeps every value, in input order.
function foldNames(headers: Readonly<RecordedResponse['headers']>): Map<string, string | string[]> {
  const folded = new Map<string, string | string[]>();
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    const seen = folded.get(name);
    folded.set(name, seen === undefined ? value : [seen, value].flat());
  }
  return folded;
}

/**
 * Response headers normalised for comparison: dropped headers and `Set-Cookie` removed, the ETag checked,
 * `Location` normalised as a body URL, kept-by-value headers exact, token headers masked, other values through
 * `normaliseText`. Names are visited sorted, so id ordinals ignore the recorded header order.
 * @param rawBody Exact response body text, used only for the ETag check.
 */
export function normaliseHeaders(
  headers: Readonly<RecordedResponse['headers']>,
  rawBody: string | undefined,
  state: IdOrdinals,
  rules: NormaliseRules,
): NormalisedHeaders {
  const { drop, etag, location, compare } = rules.headers;
  const ruleDropped = new Set(drop.map((name) => name.toLowerCase()));
  const alwaysCompared = compare.alwaysCompared.map(globRegExp);
  const keptByValue = new Set([...KEPT_BY_VALUE_HEADERS, ...rules.auth.compareHeaders.map((name) => name.toLowerCase())]);
  const etagContentTypes = new Set(etag.contentTypes.map((type) => type.toLowerCase()));
  const etagHeader = etag.header.toLowerCase();
  const locationHeader = location.header.toLowerCase();
  const folded = foldNames(headers);
  const etagChecked = etagContentTypes.has(mediaType(folded.get('content-type')));

  // A scenario's dropHeaders override never removes a header the rules declare always compared.
  const isDropped = (name: string): boolean =>
    name === SET_COOKIE ||
    ((DROPPED_HEADERS.has(name) || ruleDropped.has(name)) && !alwaysCompared.some((glob) => glob.test(name)));

  const valueRule = (name: string): ((value: string) => string) => {
    if (name === etagHeader) return etagChecked ? (value) => normaliseEtag(value, rawBody, etag) : exact;
    if (name === locationHeader) return (value) => normaliseUrl(value, state, rules);
    if (keptByValue.has(name) || hasPrefix(name, KEPT_BY_VALUE_PREFIXES)) return exact;
    if (isTokenKey(name, rules)) return (value) => (value === '' ? value : rules.tokens.placeholder);
    return (value) => normaliseText(value, state, rules);
  };

  const out: NormalisedHeaders = {};
  for (const name of [...folded.keys()].sort()) {
    const value = folded.get(name);
    if (value === undefined || isDropped(name)) continue;
    const rule = valueRule(name);
    out[name] = Array.isArray(value) ? value.map(rule) : rule(value);
  }
  return out;
}
