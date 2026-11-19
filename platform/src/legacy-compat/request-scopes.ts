// A parsed request's url and form scopes as Masa's start-up script protection leaves them (core/appcfc/scriptProtect_include.cfm:4-20).
import { portcullisScan, type PortcullisInput, type PortcullisScope } from './portcullis.js';
import { javaTrim } from './serializer.js';

/** Parsed parts of a request that ColdFusion builds its url and form scopes from; a Fastify request is one. */
export interface ScopeSource {
  /** Parsed query string: each name's value, or its repeated values. */
  readonly query: unknown;
  /** Parsed body: form fields, multipart parts as `@fastify/multipart` attaches them, a JSON value or raw bytes. */
  readonly body: unknown;
  /** Request headers under lower-cased names; only `content-type` and {@link PATH_PAIRS_HEADER} are read. */
  readonly headers: { readonly [name: string]: unknown };
  /** Request target as sent; its query string orders the url values of names differing only in case. */
  readonly url?: string;
}

/** A request's url and form scopes as start-up leaves them, entries in scope order, and its JSON body as sent. */
export interface LegacyScopes {
  /** The scanned url scope, relayed path pairs first as sent; `failed` when legacy's scan throws on it. */
  url: PortcullisScope;
  /** The scanned form scope, relayed path pairs first as sent: empty beside a JSON body, and as posted after a failed url scan. */
  form: PortcullisScope;
  /** Whether the body is JSON, which ColdFusion neither scans nor reads into the form scope. */
  json: boolean;
  /** A JSON request's parsed body as sent; undefined for any other request. */
  jsonBody: unknown;
}

/** A multipart part as `@fastify/multipart` attaches it to the body. */
interface MultipartPart {
  type: 'file' | 'field';
  fieldname: string;
  filename?: unknown;
  value?: unknown;
}

/** A key-value object, including fast-querystring's null-rooted dictionaries; never arrays, buffers or streams. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Object.getPrototypeOf(proto) === null;
}

function isMultipartPart(value: unknown): value is MultipartPart {
  return isPlainObject(value) && (value.type === 'file' || value.type === 'field') && typeof value.fieldname === 'string';
}

/** Whether a `content-type` reads as JSON: legacy takes any type starting with `application/json`. */
export function isJsonContentType(contentType: unknown): boolean {
  return typeof contentType === 'string' && contentType.slice(0, 16).toLowerCase() === 'application/json';
}

/** One parsed value or multipart part as a CFML scope holds it: a file part by name, a field part by its text. */
function partValue(item: unknown): unknown {
  if (!isMultipartPart(item)) return item;
  return item.type === 'file' ? item.filename : scopeText(item.value);
}

/** A scope value as text: a string as it is, any other value, such as a field a JSON-parsing multipart parser attached, as its JSON. */
function scopeText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/** One parsed url, form or multipart value as a CFML scope holds it: repeated keys joined with `,`, file parts by name. */
export function legacyScopeValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(partValue).join(',') : partValue(value);
}

/**
 * A repeated form-scope name's value once ACF adds `value` to `joined`, its value so far (undefined before the first):
 * a value whose trim is empty is skipped, one after a value still `''` replaces it, any other is appended after `,`.
 */
export function appendFormScopeValue(joined: string | undefined, value: string): string {
  if (joined === undefined) return value;
  if (javaTrim(value) === '') return joined;
  return joined === '' ? value : `${joined},${value}`;
}

/** Values of one form-scope name joined as ACF joins them; `''` for none. */
function formScopeJoin(values: readonly string[]): string {
  let joined: string | undefined;
  for (const value of values) joined = appendFormScopeValue(joined, value);
  return joined ?? '';
}

/** The text of each parsed value or part of one name, file parts by name, undefined ones left out. */
function partTexts(items: readonly unknown[]): string[] {
  return items
    .map(partValue)
    .filter((item) => item !== undefined)
    .map(scopeText);
}

/** `items` grouped by lower-cased name, groups in first-seen order, each group's items in order. */
function byLowerName<T>(items: Iterable<T>, nameOf: (item: T) => string): Map<string, [T, ...T[]]> {
  const groups = new Map<string, [T, ...T[]]>();
  for (const item of items) {
    const group = groups.get(nameOf(item).toLowerCase());
    if (group === undefined) groups.set(nameOf(item).toLowerCase(), [item]);
    else group.push(item);
  }
  return groups;
}

/** Names of the query string of `target` in sent order, `+` and escapes decoded as Fastify's parser decodes them. */
function sentQueryNames(target: string): string[] {
  const at = target.indexOf('?');
  if (at === -1) return [];
  return target
    .slice(at + 1)
    .split('&')
    .flatMap((pair) => {
      if (pair === '') return [];
      const eq = pair.indexOf('=');
      const name = (eq === -1 ? pair : pair.slice(0, eq)).replaceAll('+', ' ');
      try {
        return [decodeURIComponent(name)];
      } catch {
        // The parser keeps a name it cannot decode as sent.
        return [name];
      }
    });
}

/** The parts of one name's spellings interleaved as `sent` orders them; undefined unless `sent` accounts for every part. */
function inSentOrder(spellings: ReadonlyArray<readonly [key: string, parts: readonly unknown[]]>, sent: readonly string[]): unknown[] | undefined {
  const queues = new Map(spellings.map(([key, parts]) => [key, [...parts]]));
  const ordered: unknown[] = [];
  for (const name of sent) {
    const queue = queues.get(name);
    if (queue === undefined || queue.length === 0) return undefined;
    ordered.push(queue.shift());
  }
  return [...queues.values()].every((queue) => queue.length === 0) ? ordered : undefined;
}

/**
 * Parsed url or form fields as ColdFusion builds the scope, as scan inputs: names differing only in case joined under the
 * first spelling, values `,`-joined in field order, or in the order `target`'s query string sent them; a name holding a
 * file part passes unscanned. None unless `fields` is a plain object.
 */
export function portcullisInputsOf(fields: unknown, target?: string): PortcullisInput[] {
  return scopeInputsOf(fields, target, false);
}

/** Parsed form fields as ColdFusion builds the form scope, as scan inputs: {@link portcullisInputsOf}'s, joined by {@link appendFormScopeValue}. */
export function formScopeInputsOf(fields: unknown): PortcullisInput[] {
  return scopeInputsOf(fields, undefined, true);
}

/** Scan inputs of {@link portcullisInputsOf}, a repeated name's values joined as the form scope joins them when `form`. */
function scopeInputsOf(fields: unknown, target: string | undefined, form: boolean): PortcullisInput[] {
  if (!isPlainObject(fields)) return [];
  let sent: Map<string, string[]> | undefined;
  return [...byLowerName(Object.entries(fields), ([key]) => key)].map(([lower, spellings]): PortcullisInput => {
    const parts = spellings.map(([key, value]): [string, unknown[]] => [key, Array.isArray(value) ? value : [value]]);
    const opaque = parts.some(([, items]) => items.some((part) => isMultipartPart(part) && part.type === 'file'));
    const [[key, value], ...others] = spellings;
    if (others.length === 0) return [key, form && Array.isArray(value) ? formScopeJoin(partTexts(value)) : legacyScopeValue(value), opaque];
    sent ??= byLowerName(target === undefined ? [] : sentQueryNames(target), (name) => name);
    const ordered = inSentOrder(parts, sent.get(lower) ?? []) ?? parts.flatMap(([, items]) => items);
    const texts = partTexts(ordered);
    return [key, form ? formScopeJoin(texts) : texts.join(','), opaque];
  });
}

/** Header in which web's relay names the FW/1 path pairs its rc holds, which no start-up scan reads, as a urlencoded query string. */
export const PATH_PAIRS_HEADER = 'X-Opt2-Path-Pairs';

/** The {@link PATH_PAIRS_HEADER} value naming `pairs`; undefined for none. */
export function pathPairsHeaderValue(pairs: Iterable<readonly [string, string]>): string | undefined {
  const value = new URLSearchParams([...pairs].map(([name, item]): [string, string] => [name, item])).toString();
  return value === '' ? undefined : value;
}

/** The path pairs `headers` name, lower-cased name to value; none without the header. */
function pathPairsOf(headers: ScopeSource['headers']): ReadonlyMap<string, string> {
  const value = headers[PATH_PAIRS_HEADER.toLowerCase()];
  if (typeof value !== 'string') return new Map();
  return new Map([...new URLSearchParams(value)].map(([name, item]) => [name.toLowerCase(), item] as const));
}

/**
 * `inputs` scanned, except each relaying a path pair of `pairs` (its text under the pair's name), which is kept as sent
 * and ahead of the rest, as FW/1 merges path pairs before the url and form scopes (admin/framework.cfc:602-618).
 */
function scanBesidePathPairs(inputs: readonly PortcullisInput[], pairs: ReadonlyMap<string, string>): PortcullisScope {
  const isPair = ([key, value, opaque]: PortcullisInput): boolean => opaque !== true && typeof value === 'string' && pairs.get(key.toLowerCase()) === value;
  const kept = inputs.filter(isPair);
  if (kept.length === 0) return portcullisScan(inputs);
  const scope = portcullisScan(inputs.filter((input) => !isPair(input)));
  return { ...scope, entries: [...kept.map(([key, value]): [string, unknown] => [key, value]), ...scope.entries] };
}

/** The url and form scopes of `source` after the start-up scan, relayed path pairs kept as sent, and its JSON body as sent. */
export function legacyScopesFrom(source: ScopeSource): LegacyScopes {
  const pairs = pathPairsOf(source.headers);
  const url = scanBesidePathPairs(portcullisInputsOf(source.query, source.url), pairs);
  if (isJsonContentType(source.headers['content-type'])) {
    return { url, form: { entries: [], failed: false }, json: true, jsonBody: source.body };
  }
  // Admin start-up scans the form inside the url scan's guard, so a failed url scan leaves the form as posted.
  const form = url.failed
    ? { entries: formScopeInputsOf(source.body).map(([key, value]): [string, unknown] => [key, value]), failed: false }
    : scanBesidePathPairs(formScopeInputsOf(source.body), pairs);
  return { url, form, json: false, jsonBody: undefined };
}

/** A scope's entries as name to text, as a route-key request takes them: a later name replaces an earlier one ignoring case, under its own spelling. */
export function legacyScopeParams(scope: PortcullisScope): Record<string, string> {
  const params = Object.create(null) as Record<string, string>;
  const spelling = new Map<string, string>();
  for (const [key, value] of scope.entries) {
    const previous = spelling.get(key.toLowerCase());
    if (previous !== undefined) delete params[previous];
    spelling.set(key.toLowerCase(), key);
    params[key] = scopeText(value);
  }
  return params;
}
