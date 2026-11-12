// Value rules of the golden normaliser: timestamps, tokens, URLs and origins, and the deep walker over JSON values.
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
} from '@opt2/platform/legacy-compat';
import { normaliseIdsInString, type IdOrdinals } from './ids.js';
import type { NormaliseRules, OriginRules, TimestampClassRule } from './rules.js';

/** Name of a timestamp format class declared in `timestamps.classes` of the rules, e.g. `serializer`, `http-date`. */
export type TimestampClass = TimestampClassRule['name'];

/** Token placeholder of the committed rules; output uses `rules.tokens.placeholder`. */
export const TOKEN_PLACEHOLDER = '<token>';

/** Signed and download URL placeholder of the committed rules; output uses `rules.urls.placeholder`. */
export const URL_PLACEHOLDER = '<url>';

// Format of the CSRF expiry class (sessionUserFacade.cfc:228); rules.ts identifies that class by it too.
const CSRF_EXPIRES_FORMAT = 'yyMMddHHnnsslll';
// Base for parsing relative URLs; never part of any output.
const DUMMY_BASE = 'http://normalise.invalid/';
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;
const ABSOLUTE_URL = /^https?:\/\/\S+$/i;
const RELATIVE_URL = /^(?:\/(?!\/)|\?|\.\.?\/)\S*$/;

interface CompiledClass {
  readonly name: string;
  readonly whole: RegExp;
  /** Key globs the class is bound to; undefined means any key or none. */
  readonly keys: readonly RegExp[] | undefined;
}

interface Compiled {
  readonly classes: readonly CompiledClass[];
  /** Classes found inside text, one named group `t<i>` per entry of `embeddedNames`. */
  readonly embedded: RegExp | undefined;
  readonly embeddedNames: readonly string[];
  readonly dateOnlyFields: ReadonlySet<string>;
  readonly tokenFields: ReadonlySet<string>;
  readonly tokenHeaders: ReadonlySet<string>;
  readonly tokenQueryParams: ReadonlySet<string>;
  readonly signedQueryParams: ReadonlySet<string>;
  readonly lowerCaseParams: ReadonlySet<string>;
  readonly foldField: Fold;
  readonly foldHeader: Fold;
  readonly foldQuery: Fold;
  readonly foldActionParam: Fold;
  readonly foldDownloadKey: Fold;
  readonly textQueryTokens: RegExp;
  readonly origins: RegExp;
}

type Fold = (value: string) => string;

const lowerCase: Fold = (value) => value.toLowerCase();
const exact: Fold = (value) => value;
const foldFor = (mode: 'case-insensitive' | 'exact'): Fold => (mode === 'case-insensitive' ? lowerCase : exact);
const foldDateOnly: Fold = (value) => value.replaceAll('_', '').toLowerCase();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`, 'i');
}

const longestFirst = (a: string, b: string): number => b.length - a.length;

// The CSRF expiry digits are only a timestamp under the CSRF expiry names; anywhere else 15 digits stay literal.
function classKeys(rule: TimestampClassRule): readonly RegExp[] | undefined {
  if (rule.keys !== undefined) return rule.keys.map(globRegExp);
  if (rule.format === CSRF_EXPIRES_FORMAT) return [CSRF_FIELD_EXPIRES, CSRF_HEADER_EXPIRES].map(globRegExp);
  return undefined;
}

// Each configured origin under each host alias, as scheme origin, host:port and percent-encoded host:port.
function originForms(origins: OriginRules): string[] {
  const forms = new Set<string>();
  for (const value of origins.values) {
    const url = new URL(value);
    const hosts = origins.hostAliases.includes(url.hostname) ? origins.hostAliases : [url.hostname];
    for (const host of hosts) {
      const hostPort = url.port === '' ? host : `${host}:${url.port}`;
      if (origins.match.includes('scheme-origin')) forms.add(`${url.protocol}//${hostPort}`);
      if (origins.match.includes('host-port')) forms.add(hostPort);
      if (origins.match.includes('percent-encoded-host-port')) forms.add(encodeURIComponent(hostPort));
    }
  }
  return [...forms].sort(longestFirst);
}

function originsRegExp(origins: OriginRules): RegExp {
  const forms = originForms(origins).map(escapeRegExp).join('|');
  // Not inside a longer host, port or encoded value; `%2F` may precede an encoded host (`http%3A%2F%2F…`).
  return new RegExp(`(?<=^|[^0-9A-Za-z.-]|%2F)(?:${forms})(?![0-9A-Za-z_-]|\\.[0-9A-Za-z]|:[0-9]|%3A[0-9])`, 'gi');
}

function compileClasses(rules: NormaliseRules): Pick<Compiled, 'classes' | 'embedded' | 'embeddedNames'> {
  const { boundary, classes: declared } = rules.timestamps;
  const classes = declared.map((rule) => ({
    name: rule.name,
    whole: new RegExp(`^(?:${rule.pattern})$`),
    keys: classKeys(rule),
  }));
  // Other classes are also found inside text, bounded by `timestamps.boundary`; whole-value and key-bound ones never.
  const inText = declared.filter((rule, index) => rule.scope !== 'whole-value' && classes[index]?.keys === undefined);
  const groups = inText.map((rule, index) => `(?<t${index}>${rule.pattern})`).join('|');
  return {
    classes,
    embedded: inText.length === 0 ? undefined : new RegExp(`(?<!${boundary})(?:${groups})(?!${boundary})`, 'g'),
    embeddedNames: inText.map((rule) => rule.name),
  };
}

const compiledRules = new WeakMap<NormaliseRules, Compiled>();

// Loaded rules are deep-frozen, and applyOverrides returns new objects, so each rules object compiles once.
function compile(rules: NormaliseRules): Compiled {
  const cached = compiledRules.get(rules);
  if (cached !== undefined) return cached;
  const { tokens, urls, dom } = rules;
  const foldField = foldFor(tokens.fieldMatch);
  const foldHeader = foldFor(tokens.headerMatch);
  const foldQuery = foldFor(tokens.queryParamMatch);
  const foldActionParam = foldFor(dom.actionUrl.paramNames);
  const queryNames = [...new Set([...tokens.queryParams, CSRF_FIELD_TOKEN, CSRF_FIELD_EXPIRES])];
  const compiled: Compiled = {
    ...compileClasses(rules),
    dateOnlyFields: new Set(rules.timestamps.dateOnlyFields.map(foldDateOnly)),
    tokenFields: new Set([...tokens.fields, CSRF_FIELD_TOKEN, CSRF_FIELD_EXPIRES].map(foldField)),
    tokenHeaders: new Set([...tokens.headers, CSRF_HEADER_TOKEN, CSRF_HEADER_EXPIRES].map(foldHeader)),
    tokenQueryParams: new Set(queryNames.map(foldQuery)),
    signedQueryParams: new Set(urls.signedQueryParams.map(foldQuery)),
    lowerCaseParams: new Set(dom.actionUrl.lowerCaseValuesOf.map(foldActionParam)),
    foldField,
    foldHeader,
    foldQuery,
    foldActionParam,
    foldDownloadKey: foldFor(urls.downloadFieldMatch),
    textQueryTokens: new RegExp(
      `(?<=[?&]|&amp;)(${[...queryNames].sort(longestFirst).map(escapeRegExp).join('|')})=([^&#\\s"'<>]*)`,
      tokens.queryParamMatch === 'case-insensitive' ? 'gi' : 'g',
    ),
    origins: originsRegExp(rules.origins),
  };
  compiledRules.set(rules, compiled);
  return compiled;
}

function classify(s: string, key: string | undefined, compiled: Compiled): TimestampClass | undefined {
  for (const cls of compiled.classes) {
    if (cls.keys !== undefined && (key === undefined || !cls.keys.some((glob) => glob.test(key)))) continue;
    if (cls.whole.test(s)) return cls.name;
  }
  return undefined;
}

// The class travels in the placeholder, so two sides normalised apart still differ when their formats differ.
function timestampPlaceholder(cls: TimestampClass, rules: NormaliseRules): string {
  const { placeholder, assertSameFormatClass } = rules.timestamps;
  return assertSameFormatClass ? `${placeholder.slice(0, -1)}:${cls}>` : placeholder;
}

function isDateOnly(key: string | undefined, compiled: Compiled): boolean {
  return key !== undefined && compiled.dateOnlyFields.has(foldDateOnly(key));
}

/** Whether `name` is a date-only field (`asOf`, `due_date`, …), whose values are compared literally. */
export function isDateOnlyField(name: string, rules: NormaliseRules): boolean {
  return isDateOnly(name, compile(rules));
}

/**
 * Class of the first declared timestamp class matching the whole of `s`, or undefined.
 * @param key Field, column or parameter name `s` belongs to; key-bound classes (epoch milliseconds, CSRF expiry)
 *   match only under their keys.
 */
export function timestampClassOf(s: string, rules: NormaliseRules, key?: string): TimestampClass | undefined {
  return classify(s, key, compile(rules));
}

/** `<ts:<class>>` for a timestamp `value` (bare `<ts>` when the rules do not assert classes); others unchanged. */
export function normaliseTimestamp(value: string, rules: NormaliseRules, key?: string): string {
  const compiled = compile(rules);
  if (isDateOnly(key, compiled)) return value;
  const cls = classify(value, key, compiled);
  return cls === undefined ? value : timestampPlaceholder(cls, rules);
}

function replaceEmbeddedTimestamps(s: string, rules: NormaliseRules, compiled: Compiled): string {
  const { embedded, embeddedNames } = compiled;
  if (embedded === undefined) return s;
  return s.replace(embedded, (match: string, ...rest: unknown[]) => {
    // With named groups, the replacer's last argument is the groups object.
    const groups = rest.at(-1) as Record<string, string | undefined>;
    const name = embeddedNames.find((_name, i) => groups[`t${i}`] !== undefined);
    return name === undefined ? match : timestampPlaceholder(name, rules);
  });
}

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === '';

function isTokenKeyIn(key: string, compiled: Compiled): boolean {
  return compiled.tokenFields.has(compiled.foldField(key)) || compiled.tokenHeaders.has(compiled.foldHeader(key));
}

/** Whether `key` is a token field or token header name (`csrf_token`, `authtoken`, `X-csrf_token`, …). */
export function isTokenKey(key: string, rules: NormaliseRules): boolean {
  return isTokenKeyIn(key, compile(rules));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * New copy of `obj` with every non-empty token-key value replaced by the token placeholder, at any depth; empty
 * and null token values are kept, so a missing token stays visible. Key order and all other values are kept.
 */
export function normaliseTokens(obj: unknown, rules: NormaliseRules): unknown {
  const compiled = compile(rules);
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]): [string, unknown] => [
        key,
        isTokenKeyIn(key, compiled) && !isEmpty(child) ? rules.tokens.placeholder : visit(child),
      ]),
    );
  };
  return visit(obj);
}

function replaceOrigins(s: string, rules: NormaliseRules, compiled: Compiled): string {
  return s.replace(compiled.origins, () => rules.origins.placeholder);
}

// Token parameters anywhere in text, including `&amp;`-separated ones in HTML; an empty value stays visible.
function maskTextQueryTokens(s: string, rules: NormaliseRules, compiled: Compiled): string {
  return s.replace(compiled.textQueryTokens, (match: string, name: string, value: string) =>
    value === '' ? match : `${name}=${rules.tokens.placeholder}`,
  );
}

// Parameter name as a server reads it; `amp;` is left by an `&amp;` separator in markup.
function decodeParamName(raw: string): string {
  const name = raw.startsWith('amp;') ? raw.slice(4) : raw;
  try {
    return decodeURIComponent(name.replaceAll('+', ' '));
  } catch {
    return name;
  }
}

function urlRuleApplies(id: string, rules: NormaliseRules): boolean {
  return rules.urls.otherwise.apply.includes(id);
}

// Raw `name=value` pairs are edited in place, so encoding, order and repeats stay as each side sent them.
function normaliseQuery(query: string, rules: NormaliseRules, compiled: Compiled): string {
  const maskTokens = urlRuleApplies(rules.tokens.id, rules);
  const params = query.split('&').map((param) => {
    const eq = param.indexOf('=');
    const rawName = eq < 0 ? param : param.slice(0, eq);
    const name = decodeParamName(rawName);
    const value = eq < 0 ? '' : param.slice(eq + 1);
    if (maskTokens && value !== '' && compiled.tokenQueryParams.has(compiled.foldQuery(name))) {
      return { name, text: `${rawName}=${rules.tokens.placeholder}` };
    }
    // FW/1 lower-cases the action (admin/framework.cfc:602-626), so its case is not observable.
    if (value !== '' && compiled.lowerCaseParams.has(compiled.foldActionParam(name))) {
      return { name, text: `${rawName}=${value.toLowerCase()}` };
    }
    return { name, text: param };
  });
  if (rules.urls.otherwise.sortQuery) params.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return params.map((param) => param.text).join('&');
}

function isSignedUrl(url: string, rules: NormaliseRules, compiled: Compiled): boolean {
  const parsed = new URL(url, DUMMY_BASE);
  if (rules.urls.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) return true;
  return [...parsed.searchParams.keys()].some((name) => compiled.signedQueryParams.has(compiled.foldQuery(name)));
}

// Undefined when `url` does not parse even against a base.
function normaliseParsedUrl(
  url: string,
  state: IdOrdinals,
  rules: NormaliseRules,
  compiled: Compiled,
): string | undefined {
  if (!URL.canParse(url, DUMMY_BASE)) return undefined;
  if (isSignedUrl(url, rules, compiled)) return rules.urls.placeholder;
  const hash = url.indexOf('#');
  const beforeFragment = hash < 0 ? url : url.slice(0, hash);
  const q = beforeFragment.indexOf('?');
  let out =
    q < 0
      ? beforeFragment
      : `${beforeFragment.slice(0, q + 1)}${normaliseQuery(beforeFragment.slice(q + 1), rules, compiled)}`;
  out += hash < 0 ? '' : url.slice(hash);
  if (urlRuleApplies(rules.origins.id, rules)) out = replaceOrigins(out, rules, compiled);
  const ids = urlRuleApplies(rules.ids.id, rules) || urlRuleApplies(rules.ids.rfc4122.id, rules);
  return ids ? normaliseIdsInString(out, state, rules.ids) : out;
}

function textSegment(
  s: string,
  timestamps: boolean,
  state: IdOrdinals,
  rules: NormaliseRules,
  compiled: Compiled,
): string {
  if (s === '') return s;
  let out = replaceOrigins(maskTextQueryTokens(s, rules, compiled), rules, compiled);
  if (timestamps) out = replaceEmbeddedTimestamps(out, rules, compiled);
  return normaliseIdsInString(out, state, rules.ids);
}

// Left to right, so id ordinals follow their position in the text.
function textOf(
  s: string,
  key: string | undefined,
  state: IdOrdinals,
  rules: NormaliseRules,
  compiled: Compiled,
): string {
  const timestamps = !isDateOnly(key, compiled);
  if (timestamps) {
    const cls = classify(s, key, compiled);
    if (cls !== undefined) return timestampPlaceholder(cls, rules);
  }
  let out = '';
  let last = 0;
  for (const match of s.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    out += textSegment(s.slice(last, match.index), timestamps, state, rules, compiled);
    out += normaliseParsedUrl(url, state, rules, compiled) ?? textSegment(url, timestamps, state, rules, compiled);
    last = match.index + url.length;
  }
  return out + textSegment(s.slice(last), timestamps, state, rules, compiled);
}

/**
 * URL `url` normalised: a signed URL (signed query parameter or `urls.pathPrefixes` path) becomes the URL
 * placeholder; otherwise token parameters become the token placeholder, `muraAction`/`fuseaction` values are
 * lower-cased, configured origins become the origin placeholder and ids become ordinals. Path, parameter order and
 * fragment are kept; unparseable input is normalised as text.
 */
export function normaliseUrl(url: string, state: IdOrdinals, rules: NormaliseRules): string {
  const compiled = compile(rules);
  return normaliseParsedUrl(url, state, rules, compiled) ?? textOf(url, undefined, state, rules, compiled);
}

/**
 * Free text normalised: a whole-value timestamp becomes its class placeholder; otherwise URLs in it are
 * normalised as by {@link normaliseUrl}, and in the rest origins, token parameters, embedded timestamps and ids.
 */
export function normaliseText(s: string, state: IdOrdinals, rules: NormaliseRules): string {
  return textOf(s, undefined, state, rules, compile(rules));
}

function isDownloadUrl(s: string, key: string, rules: NormaliseRules, compiled: Compiled): boolean {
  const folded = compiled.foldDownloadKey(key);
  return rules.urls.downloadFields.some(
    (field) =>
      compiled.foldDownloadKey(field.key) === folded &&
      (field.whenContains === undefined || field.whenContains.some((part) => s.includes(part))),
  );
}

function isUrlLike(s: string, rules: NormaliseRules): boolean {
  if (ABSOLUTE_URL.test(s)) return true;
  if (!RELATIVE_URL.test(s)) return false;
  return s.includes('?') || s.includes('/_api/') || rules.urls.pathPrefixes.some((prefix) => s.startsWith(prefix));
}

function normaliseString(
  s: string,
  key: string | undefined,
  state: IdOrdinals,
  rules: NormaliseRules,
  compiled: Compiled,
): string {
  if (key !== undefined && s !== '' && isDownloadUrl(s, key, rules, compiled)) return rules.urls.placeholder;
  if (isUrlLike(s, rules)) {
    return normaliseParsedUrl(s, state, rules, compiled) ?? textOf(s, key, state, rules, compiled);
  }
  return textOf(s, key, state, rules, compiled);
}

// Integers are classified too: epoch milliseconds under their bound keys are JSON numbers.
function normaliseNumber(
  n: number,
  key: string | undefined,
  rules: NormaliseRules,
  compiled: Compiled,
): number | string {
  if (key === undefined || !Number.isInteger(n) || isDateOnly(key, compiled)) return n;
  const cls = classify(String(n), key, compiled);
  return cls === undefined ? n : timestampPlaceholder(cls, rules);
}

function walk(
  value: unknown,
  key: string | undefined,
  state: IdOrdinals,
  rules: NormaliseRules,
  compiled: Compiled,
): unknown {
  if (key !== undefined && isTokenKeyIn(key, compiled) && !isEmpty(value)) return rules.tokens.placeholder;
  if (typeof value === 'string') return normaliseString(value, key, state, rules, compiled);
  if (typeof value === 'number') return normaliseNumber(value, key, rules, compiled);
  // Array elements take the key of the array.
  if (Array.isArray(value)) return value.map((item: unknown) => walk(item, key, state, rules, compiled));
  if (!isPlainObject(value)) return value;
  // Sorted keys: CFML struct key order differs from the target's, and ordinals follow first sight.
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((name): [string, unknown] => [
        normaliseIdsInString(name, state, rules.ids),
        walk(value[name], name, state, rules, compiled),
      ]),
  );
}

/**
 * New copy of `value` with every rule of this module applied at any depth: token keys become the token
 * placeholder, URL-like strings go through {@link normaliseUrl}, other strings through {@link normaliseText}
 * (date-only fields keep their dates), object keys are visited sorted with their ids replaced. Booleans and null
 * are kept; numbers are kept unless a key-bound timestamp class matches them.
 * @param key Name `value` is stored under, when the caller knows it.
 */
export function normaliseValue(value: unknown, state: IdOrdinals, rules: NormaliseRules, key?: string): unknown {
  return walk(value, key, state, rules, compile(rules));
}
