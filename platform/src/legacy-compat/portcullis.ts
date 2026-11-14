// Masa's start-up script protection: Portcullis.scan of the url and form scopes (core/mura/Portcullis.cfc:88-231,345-458,597-622) with
// the tag and word filters and the settings Masa runs it with (core/appcfc/scriptProtect_include.cfm, core/mura/configBean.cfc:160-161).
import { readAcfJson, serializeAcfJson, UNREADABLE_JSON, type AcfJsonValue } from './acf-json.js';
import { cfIsBoolean, cfIsNumeric, javaTrim, jsonString } from './serializer.js';

/** What the filters put in place of a blocked tag or word. */
export const PORTCULLIS_INVALID_MARKER = '[INVALID]';

/** Fields the scan leaves unfiltered: configBean `scriptProtectExceptions`, which already lists `content`. */
export const PORTCULLIS_EXCEPTION_FIELDS: readonly string[] = Object.freeze([
  'body',
  'source',
  'params',
  'objectlist1',
  'objectlist2',
  'objectlist3',
  'objectlist4',
  'objectlist5',
  'objectlist6',
  'objectlist7',
  'contenteditfield',
  'content',
]);

/** Portcullis `tagFilter`, applied in this order. */
export const PORTCULLIS_TAG_FILTER: readonly string[] = Object.freeze([
  'script',
  'object',
  'applet',
  'embed',
  'form',
  'input',
  'layer',
  'ilayer',
  'frame',
  'iframe',
  'frameset',
  'param',
  'meta',
  'base',
  'style',
  'xss',
  'marquee',
]);

/** Portcullis `wordFilter`, a regular-expression alternation. */
const WORD_FILTER =
  /qss|onError|onEvent|onLoad|onClick|onDblClick|onKeyDown|onKeyPress|onKeyUp|onMouseDown|onMouseOut|onMouseUp|onMouseOver|onBlur|onChange|onFocus|onSelect|javascript:|vbscript:|\.cookie|\.toString|:expr|:expression|\.fromCharCode|String\./giu;

/** Longest text ACF 2023's regex functions process; a longer subject is returned unchanged and finds no match. */
const MAX_REGEX_SUBJECT = 100_000;

/** ColdFusion scopes a dotted name may not start with (Portcullis.isValidCFVariableName). */
const CF_SCOPES: ReadonlySet<string> = new Set(['session', 'form', 'url', 'server', 'cgi', 'cookie', 'application', 'local']);

// The u flag folds case as ACF's RE2 engine does: U+017F matches s and U+212A matches k.
const NAME_START = /^[A-Za-z]/iu;
const NON_NAME_CHARS = /[^a-zA-Z0-9_]/giu;

/** One url or form entry: its name, its value, and whether the scan keeps the value as sent, as for a file part's name. */
export type PortcullisInput = readonly [key: string, value: unknown, opaque?: boolean];

/** A scope as the scan leaves it. */
export interface PortcullisScope {
  /** Entries in scope order, then the entry each name holding characters outside [A-Za-z0-9_] adds under its stripped name. */
  entries: Array<[key: string, value: unknown]>;
  /** Whether legacy's scan throws on the scope, or may where `runtimeDecided`; `entries` then hold only its name and NUL fixes. */
  failed: boolean;
  /**
   * Set when ColdFusion's runtime, not the request, decides what the scan leaves: its scope hash order, where names renamed
   * or stripped onto one name differ in value or spelling, or its stack, where an array value nests too deeply.
   */
  runtimeDecided?: true;
}

/** Array nesting from which the ColdFusion stack decides whether the scan fails; the oracle's failed from 510 to 579 levels, varying between runs. */
const STACK_DECIDED_DEPTH = 256;

/** One assignment the scan makes to a name, in the scope's hash order. */
interface Assignment {
  key: string;
  value: unknown;
  opaque: boolean;
}

/** Whether two of `assignments` name one entry ignoring case and differ in value, or in spelling where no entry of `held` holds that name. */
function hashOrderDecides(assignments: readonly Assignment[], held: ReadonlyMap<string, unknown>): boolean {
  const first = new Map<string, Assignment>();
  return assignments.some((assignment) => {
    const name = assignment.key.toLowerCase();
    const earlier = first.get(name);
    if (earlier === undefined) first.set(name, assignment);
    return (
      earlier !== undefined &&
      (earlier.value !== assignment.value || earlier.opaque !== assignment.opaque || (!held.has(name) && earlier.key !== assignment.key))
    );
  });
}

/** `scope`, marked runtime-decided when `runtimeDecided` holds. */
function withRuntime(scope: PortcullisScope, runtimeDecided: boolean): PortcullisScope {
  return runtimeDecided ? { ...scope, runtimeDecided: true } : scope;
}

/** Thrown where legacy's scan throws: a JSON null stripMSWord reaches, or a name with no [A-Za-z0-9_] character. */
class ScanFault extends Error {}

/** Thrown where an array nests {@link STACK_DECIDED_DEPTH} levels, at which legacy's scan may or may not throw. */
class StackDecided extends ScanFault {}

/** Portcullis.isValidCFVariableName: non-empty, no space, no scope prefix, starting with a letter. */
function isValidCfVariableName(name: string): boolean {
  if (name === '' || name.includes(' ') || !NAME_START.test(name)) return false;
  const first = name.split('.').find((part) => part !== '');
  return !(name.includes('.') && first !== undefined && CF_SCOPES.has(first.toLowerCase()));
}

/** A name kept by the scan's first pass with its `&amp;` and `amp;` removed; undefined for a dropped one. */
export function portcullisName(name: string): string | undefined {
  return isValidCfVariableName(name) ? name.replace(/&amp;/gi, '').replace(/amp;/gi, '') : undefined;
}

/** ListContainsNoCase over the exception fields, comparing upper-cased: whether `name` is part of any of them. */
export function isPortcullisException(name: string): boolean {
  const upper = name.toUpperCase();
  return upper !== '' && PORTCULLIS_EXCEPTION_FIELDS.some((field) => field.toUpperCase().includes(upper));
}

/** `text.replace` unless ACF's regex gate skips a subject this long. */
function gatedReplace(text: string, pattern: RegExp, replacement: string): string {
  return text.length > MAX_REGEX_SUBJECT ? text : text.replace(pattern, replacement);
}

/** stripMSWordFromSimpleValue: MS Word quotes, dashes and ellipsis to ASCII, then trim. */
function stripSimple(text: string): string {
  return javaTrim(
    text
      .replaceAll('\u2018', "'")
      .replaceAll('\u2019', "'")
      .replaceAll('\u201C', '"')
      .replaceAll('\u201D', '"')
      .replaceAll('\u2014', '--')
      .replaceAll('\u2015', '--')
      .replaceAll('\u2026', '...'),
  );
}

/** stripMSWordFromArray: each element stripped; struct elements are kept, and a null throws. `depth` counts the arrays the call is in. */
function stripArray(items: readonly AcfJsonValue[], depth: number): AcfJsonValue[] {
  if (depth >= STACK_DECIDED_DEPTH) throw new StackDecided('array nesting');
  return items.map((item) => {
    if (item === null) throw new ScanFault('null array element');
    if (typeof item === 'string') return stripMSWord(item, depth);
    return Array.isArray(item) ? stripArray(item, depth + 1) : item;
  });
}

/** Portcullis.stripMSWord of a simple value: JSON text is round-tripped through deserializeJSON and serializeJSON. */
function stripMSWord(text: string, depth = 0): string {
  if (text === '' || cfIsNumeric(text) || cfIsBoolean(text)) return text;
  const json = text === '-' ? undefined : readAcfJson(text);
  if (json === undefined) return stripSimple(text);
  if (json === UNREADABLE_JSON) return jsonString(stripSimple(text));
  if (json === null) throw new ScanFault('null value');
  if (typeof json === 'string') return jsonString(stripSimple(json));
  if (typeof json === 'boolean') return jsonString(json ? 'YES' : 'NO');
  // stripMSWordFromStruct tests isArray, so a struct is serialized as it was read.
  return serializeAcfJson(Array.isArray(json) ? stripArray(json, depth + 1) : json);
}

/** Lower-cases ASCII letters and folds U+017F and U+212A, as ACF's RE2 matches a letter ignoring case. */
function foldCase(text: string): string {
  return text.replace(/[A-Z\u017F\u212A]/g, (ch) => (ch === '\u017F' ? 's' : ch === '\u212A' ? 'k' : ch.toLowerCase()));
}

/** Per index, the first index from it where `found` holds before a line feed (which `.` never matches); -1 if none. */
function nextOnLine(text: string, found: (at: number) => boolean): Int32Array {
  const next = new Int32Array(text.length + 1).fill(-1);
  for (let at = text.length - 1; at >= 0; at--) {
    if (found(at)) next[at] = at;
    else if (text.charAt(at) !== '\n') next[at] = next[at + 1] as number;
  }
  return next;
}

/** Case-insensitive global replace of `<tag.*?>.*?</tag.*?>|<tag.*?/>|</tag.*?>` (`withBody`) or `<tag.*?>|<tag.*?/>|</tag.*?>`. */
function replaceTag(text: string, tag: string, withBody: boolean): string {
  const folded = foldCase(text);
  const open = `<${tag}`;
  const close = `</${tag}`;
  const gt = nextOnLine(text, (at) => text.charAt(at) === '>');
  const slashGt = withBody ? nextOnLine(text, (at) => text.startsWith('/>', at)) : gt;
  const closeTag = withBody ? nextOnLine(text, (at) => folded.startsWith(close, at)) : gt;
  let out = '';
  let last = 0;
  let at = 0;
  while (at < text.length) {
    let end = -1;
    if (folded.startsWith(open, at)) {
      const head = gt[at + open.length] as number;
      if (!withBody) {
        end = head;
      } else {
        const closeAt = head === -1 ? -1 : (closeTag[head + 1] as number);
        end = closeAt === -1 ? -1 : (gt[closeAt + close.length] as number);
        if (end === -1) {
          const selfClose = slashGt[at + open.length] as number;
          end = selfClose === -1 ? -1 : selfClose + 1;
        }
      }
    } else if (folded.startsWith(close, at)) {
      end = gt[at + close.length] as number;
    }
    if (end === -1) {
      at += 1;
      continue;
    }
    out += text.slice(last, at) + PORTCULLIS_INVALID_MARKER;
    at = end + 1;
    last = at;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Portcullis.filterTags without its stripMSWord: each listed tag found replaced, element first, then any leftover tag. */
function filterTags(text: string): string {
  let clean = text;
  for (const tag of PORTCULLIS_TAG_FILTER) {
    if (clean.length > MAX_REGEX_SUBJECT || replaceTag(clean, tag, false) === clean) continue;
    clean = replaceTag(clean, tag, true);
    if (clean.length <= MAX_REGEX_SUBJECT) clean = replaceTag(clean, tag, false);
  }
  return clean;
}

/** The word pass's trim of a value whose U+FFFD characters (Portcullis' unreadable smart quotes) read as `'`. */
function trimReplacementChars(text: string): string {
  return javaTrim(gatedReplace(text, /\uFFFD/g, "'"));
}

/** Portcullis.scan(useTagFilter, useWordFilter, fixValues) of one url or form scope as Masa's onRequestStart runs it. */
export function portcullisScan(inputs: Iterable<PortcullisInput>): PortcullisScope {
  const scope = new Map<string, Assignment>();
  const renamed: Assignment[] = [];
  for (const [key, value, opaque = false] of inputs) {
    const name = portcullisName(key);
    if (name === undefined) continue;
    const kept = opaque || typeof value !== 'string';
    const slot: Assignment = { key: name, value: kept ? value : value.replaceAll('\0', ''), opaque: kept };
    if (name === key) {
      // A later spelling replaces an earlier one, as the params merge does.
      scope.delete(name.toLowerCase());
      scope.set(name.toLowerCase(), slot);
    } else {
      renamed.push(slot);
    }
  }
  // Renamed entries land in hash order, so the last one there wins; a plain entry of the name never does.
  const renamesDecided = hashOrderDecides(renamed, scope);
  // A renamed entry overwrites the entry of its new name, which keeps its spelling.
  for (const slot of renamed) {
    const existing = scope.get(slot.key.toLowerCase());
    if (existing === undefined) scope.set(slot.key.toLowerCase(), slot);
    else Object.assign(existing, { value: slot.value, opaque: slot.opaque });
  }
  const fixed = [...scope.values()];
  try {
    const entries: Array<[string, unknown]> = [];
    const stripped: Assignment[] = [];
    for (const { key, value, opaque } of fixed) {
      if (isPortcullisException(key)) {
        entries.push([key, value]);
        continue;
      }
      const itemName = key.replace(NON_NAME_CHARS, '');
      if (itemName === '') throw new ScanFault('empty variable name');
      if (opaque) {
        entries.push([key, value]);
        if (itemName !== key) stripped.push({ key: itemName, value, opaque });
        continue;
      }
      const text = value as string;
      if (itemName === key) {
        entries.push([key, gatedReplace(trimReplacementChars(filterTags(stripMSWord(text))), WORD_FILTER, PORTCULLIS_INVALID_MARKER)]);
        continue;
      }
      // The tag pass writes under the stripped name, which the word pass then overwrites; only its fault remains.
      stripMSWord(text);
      const trimmed = trimReplacementChars(text);
      entries.push([key, trimmed]);
      stripped.push({ key: itemName, value: gatedReplace(trimmed, WORD_FILTER, PORTCULLIS_INVALID_MARKER), opaque: false });
    }
    // A stripped name's assignment replaces the value of an entry of that name and keeps its spelling.
    for (const { key: name, value } of stripped) entries.push([scope.get(name.toLowerCase())?.key ?? name, value]);
    // Word-pass writes to one stripped name land in hash order, the last winning over any entry of that name.
    return withRuntime({ entries, failed: false }, renamesDecided || hashOrderDecides(stripped, scope));
  } catch (err) {
    // A JSON nesting deep enough to exhaust the target's stack is far past the depths at which legacy's scan fails.
    if (!(err instanceof ScanFault) && !(err instanceof RangeError)) throw err;
    const runtimeDecided = renamesDecided || err instanceof StackDecided;
    return withRuntime({ entries: fixed.map(({ key, value }) => [key, value]), failed: true }, runtimeDecided);
  }
}
