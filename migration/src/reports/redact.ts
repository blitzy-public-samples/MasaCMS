// Safe evidence projection of report output, default-deny by property name: credentials masked; personal, raw and
// unknown strings digested; identifiers kept only while redaction leaves them unchanged; free text and Markdown redacted.
import { createHash } from 'node:crypto';

import { REDACTED, redactText } from '@opt2/platform/logging';

/** How a value is rendered: by its property name, as row data, or as personal data. */
type Context = 'named' | 'raw' | 'personal';

const IDENTIFIER = /^[A-Za-z_$][\w$-]*$/;
const CREDENTIAL_WORD =
  /password|passwd|pwd|passphrase|secret|token|credential|authorization|cookie|sessionid|signature|hmac|salt|(?:api|access|private|signing|encryption|shared|push|bridge|master|client|auth)key/;
const PERSONAL_WORD =
  /fname|lname|firstname|lastname|middlename|fullname|displayname|username|email|phone|mobile|fax|address|street|city|postcode|postalcode|zip|birth|dob|ssn|nationalid|passport/;
const RAW_NAMES: ReadonlySet<string> = new Set([
  'key',
  'keyValues',
  'legacy',
  'target',
  'before',
  'after',
  'encoding',
  'row',
  'rows',
  'value',
  'values',
  'sample',
  'samples',
  'expected',
  'actual',
]);
/** Identifier-valued names, whose values are kept while redaction leaves them unchanged. */
const EVIDENCE_NAMES: ReadonlySet<string> = new Set([
  'generatedBy', 'generatedAt', 'status', 'point', 'expectedTableVersion', 'tableVersion', 'legacySource',
  'legacyDatabase', 'measures', 'unit', 'units', 'owner', 'legacyTable', 'table', 'schema', 'tenantId', 'tenantFrom',
  'kind', 'column', 'columns', 'excludedColumns', 'backReferenceColumn', 'parents', 'orphans', 'store', 'haltedUnits',
  'windowId', 'holderId', 'transitionId', 'id', 'relationId', 'siteid', 'siteId', 'userid', 'userId', 'contentid',
  'contentId', 'phase', 'at', 'outcome', 'from', 'to', 'startedAt', 'finishedAt', 'checkedAt', 'setT', 'steps',
  'provenance', 'path', 'golden', 'replay',
]);
const ROUTE_NAMES: ReadonlySet<string> = new Set([
  'routeKey', 'route', 'entriesChanged', 'legacyWriteEntries', 'writeEntries', 'entryPoints', 'appliesTo',
]);
/** Cut-over route key of a known family, `<family>:<body>[{variant}]`. */
const ROUTE_KEY =
  /^(?:admin|api|asset|cfc|cfm|feed|fixture|page|reload|render|rest|sitemonitor|trackopen|variation|widgets):[^\sA-Z]+$/;
const QUERY_NAME = /[?&]([^=&#?\s]*)=/g;
const FREE_TEXT_NAMES: ReadonlySet<string> = new Set([
  'abortReason', 'reason', 'result', 'purpose', 'cyclePolicy', 'relations', 'kinds', 'tables', 'unitIds', 'message',
  'error', 'detail', 'details', 'note', 'notes', 'description', 'summaryText',
]);
/** Hash-valued names; a generic `*Hash` name is not one. */
const HASH_NAME = /^(?:sha256|checksum|rowHash|sourceSha|[a-z]\w*(?:Sha256|RowHash))$/;
const HASH_VALUE = /^[0-9a-f]{40,128}$/i;
/** Transition step or fault name, the only form of `name` value kept. */
const STEP_NAME = /^[a-z][a-z0-9-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64} \(\d+ (?:chars|bytes)\)$/;
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const MARKDOWN_LABEL = /^[A-Za-z][\w-]*(?: [\w-]+)*$/;
const TABLE_PIPE = /(?<!\\)\|/;
const DELIMITER_CELL = /^:?-+:?$/;

// Each echo keeps its prefix and masks the value up to the last closing delimiter on its line, or to the line end when
// unterminated; every match consumes what it scanned, so the patterns run in linear time. The out-of-range value has a
// fixed terminator and no quote inside, so a failed attempt never rescans its value.
const SQL_VALUE_ECHOES: readonly RegExp[] = [
  /(\bduplicate key value is \()(?:[^\r\n]*(?=\))|[^\r\n]*)/gi,
  /(\bTruncated value: ')(?:[^\r\n]*(?=')|[^\r\n]*)/gi,
  /(\b(?:converting|conversion of) the [a-z]\w{0,63} value ')(?:[^\r\n]*(?=')|[^\r\n]*)/gi,
  /(\bKey \([^\r\n]{0,512}?\)=\()(?:[^\r\n]*(?=\))|[^\r\n]*)/gi,
  /(\bFailing row contains \()(?:[^\r\n]*(?=\))|[^\r\n]*)/gi,
  /(\binvalid input syntax for(?: type)? [^\r\n:"]{1,64}: ")(?:[^\r\n]*(?=")|[^\r\n]*)/gi,
  /(\binvalid input value for enum [^\r\n:"]{1,128}: ")(?:[^\r\n]*(?=")|[^\r\n]*)/gi,
  /(\bout of range: ")(?:[^\r\n]*(?=")|[^\r\n]*)/gi,
  /(\bmalformed [^\r\n:"]{1,64} literal: ")(?:[^\r\n]*(?=")|[^\r\n]*)/gi,
  /(\bvalue ")[^"\r\n]*(?=" is out of range\b)/gi,
  /(\binvalid value ")(?:[^\r\n]*(?=" for\b)|[^\r\n]*)/gi,
  /(\bat or near ")(?:[^\r\n]*(?=")|[^\r\n]*)/gi,
  /(\bnear ')(?:[^\r\n]*(?=')|[^\r\n]*)/gi,
  /(\bUnclosed quotation mark after the character string ')(?:[^\r\n]*(?=')|[^\r\n]*)/gi,
];

/** Lower-cased `name` without `_`, `-` and spaces. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

/** True when the normalised `name` contains a credential or personal-data word. */
function isSensitiveWord(name: string): boolean {
  const normalised = normalise(name);
  return CREDENTIAL_WORD.test(normalised) || PERSONAL_WORD.test(normalised);
}

/** True when `name` is an identifier containing a credential word; dotted map keys never are. */
function isCredentialName(name: string): boolean {
  return IDENTIFIER.test(name) && CREDENTIAL_WORD.test(normalise(name));
}

/** True when `name` is an identifier containing a personal-data word; dotted map keys never are. */
function isPersonalName(name: string): boolean {
  return IDENTIFIER.test(name) && PERSONAL_WORD.test(normalise(name));
}

/** Number of code points in `text`. */
function charCount(text: string): number {
  return text.length - (text.match(SURROGATE_PAIR)?.length ?? 0);
}

/** `sha256:<hex> (<n> chars|bytes)` of the UTF-8 form of `data`. */
function digest(data: string | Uint8Array): string {
  const hex = createHash('sha256').update(data).digest('hex');
  return typeof data === 'string' ? `sha256:${hex} (${charCount(data)} chars)` : `sha256:${hex} (${data.byteLength} bytes)`;
}

/** Masks database error echoes of rejected values, then credentials, tokens and email addresses; idempotent. */
export function redactReportText(text: string): string {
  return redactText(SQL_VALUE_ECHOES.reduce((masked, pattern) => masked.replace(pattern, `$1${REDACTED}`), text));
}

/** True for a digest or the placeholder, which a second projection leaves as they are. */
function isMasked(text: string): boolean {
  return text === REDACTED || DIGEST.test(text);
}

/** Digest of `text`, unless it is already masked. */
function digestText(text: string): string {
  return isMasked(text) ? text : digest(text);
}

/** `text` while redaction leaves it unchanged, else its digest, so distinct identifiers stay distinct. */
function evidenceText(text: string): string {
  return redactReportText(text) === text ? text : digest(text);
}

/** True for a route key of a known family without a credential- or personal-named query parameter. */
function isRouteKey(text: string): boolean {
  if (!ROUTE_KEY.test(text)) return false;
  for (const match of text.matchAll(QUERY_NAME)) if (isSensitiveWord(match[1] ?? '')) return false;
  return true;
}

/** `text` as written under property `name` in `context`. */
function renderString(text: string, name: string, context: Context): string {
  if (context === 'personal') return digestText(text);
  if (HASH_NAME.test(name) && (HASH_VALUE.test(text) || isMasked(text))) return text;
  if (context === 'raw') return digestText(text);
  if (ROUTE_NAMES.has(name) && isRouteKey(text)) return text;
  if (ROUTE_NAMES.has(name) || EVIDENCE_NAMES.has(name)) return evidenceText(text);
  if (name === 'name') return STEP_NAME.test(text) ? text : digestText(text);
  if (FREE_TEXT_NAMES.has(name)) return redactReportText(text);
  return digestText(text);
}

/** The value JSON.stringify would serialise for `input` under `key`: `toJSON` applied, primitive wrappers unwrapped. */
function jsonValueOf(input: unknown, key: string): unknown {
  let value = input;
  // Buffer's toJSON would spell out its bytes, so byte arrays are digested as they stand.
  if (!(value instanceof Uint8Array) && ((typeof value === 'object' && value !== null) || typeof value === 'bigint')) {
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') value = toJSON.call(value, key);
  }
  if (value instanceof Number) return Number(value);
  if (value instanceof String) return String(value);
  if (value instanceof Boolean || value instanceof BigInt) return value.valueOf();
  return value;
}

/** Projection of the JSON value `value` held under property `name`; array items are judged by the array's name. */
function projectValue(value: unknown, name: string, context: Context, ancestors: Set<object>): unknown {
  if (value instanceof Uint8Array) return digest(value);
  switch (typeof value) {
    case 'string':
      return renderString(value, name, context);
    case 'number':
      if (!Number.isFinite(value)) return null;
      return context === 'personal' ? digest(String(value)) : value;
    case 'boolean':
      return context === 'personal' ? digest(String(value)) : value;
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt');
    case 'object':
      if (value === null) return null;
      if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return Array.from({ length: value.length }, (_, index) => {
            const item = projectValue(jsonValueOf((value as unknown[])[index], String(index)), name, context, ancestors);
            return item === undefined ? null : item;
          });
        }
        const child: Context = context === 'named' ? 'named' : 'raw';
        const entries: [string, unknown][] = [];
        for (const key of Object.keys(value)) {
          const item = projectProperty((value as Record<string, unknown>)[key], key, child, ancestors);
          if (item !== undefined) entries.push([key, item]);
        }
        // fromEntries defines own properties, so a `__proto__` data key stays data.
        return Object.fromEntries(entries);
      } finally {
        ancestors.delete(value);
      }
    default:
      return undefined;
  }
}

/** Projection of property `name` of an object rendered in `parent`. */
function projectProperty(input: unknown, name: string, parent: Context, ancestors: Set<object>): unknown {
  const value = jsonValueOf(input, name);
  if (isCredentialName(name)) {
    // Walked first, so a credential value fails exactly where JSON.stringify would.
    const projected = projectValue(value, name, 'raw', ancestors);
    return projected === null || projected === undefined ? projected : REDACTED;
  }
  if (isPersonalName(name)) return projectValue(value, name, 'personal', ancestors);
  return projectValue(value, name, parent === 'raw' || RAW_NAMES.has(name) ? 'raw' : 'named', ancestors);
}

/**
 * Idempotent JSON-ready copy of `value` held under property `key`: credentials masked, personal, raw and unknown strings
 * digested, identifiers kept while redaction leaves them unchanged, free text redacted.
 * @returns `undefined` where JSON.stringify would omit the value.
 * @throws TypeError on a BigInt or a circular structure, as JSON.stringify does.
 */
export function projectReportValue(value: unknown, key = ''): unknown {
  return projectProperty(value, key, 'named', new Set());
}

/** Pipe-table row: its segments between unescaped pipes and the index range holding its cells. */
interface TableRow {
  segments: string[];
  first: number;
  end: number;
}

/** `line` as a pipe-table row, or `undefined` when it has no unescaped pipe. */
function tableRow(line: string): TableRow | undefined {
  const segments = line.split(TABLE_PIPE);
  if (segments.length < 2) return undefined;
  const first = segments[0]?.trim() === '' ? 1 : 0;
  const end = segments.at(-1)?.trim() === '' ? segments.length - 1 : segments.length;
  return { segments, first, end };
}

/** True for a GitHub table delimiter row such as `| --- | :-: |`. */
function isDelimiterRow(row: TableRow): boolean {
  const cells = row.segments.slice(row.first, row.end);
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell.trim()));
}

/** True for a cell whose label, backticks and emphasis removed, is credential- or personal-named. */
function isSensitiveCell(cell: string): boolean {
  const text = cell.trim();
  if (text.length > 64) return false;
  const label = text.replace(/`/g, '').replace(/^[*_]+|[*_]+$/g, '').trim();
  return MARKDOWN_LABEL.test(label) && isSensitiveWord(label);
}

/** `cell` with its content replaced by the placeholder and its padding kept; an empty cell stays empty. */
function maskCell(cell: string): string {
  const content = cell.trim();
  if (content === '') return cell;
  const start = cell.length - cell.trimStart().length;
  return `${cell.slice(0, start)}${REDACTED}${cell.slice(start + content.length)}`;
}

/** Masks each table body cell under a sensitive header cell or after a sensitive cell of its row; header kept. */
function maskTables(markdown: string): string {
  const lines = markdown.split('\n');
  let index = 0;
  while (index + 1 < lines.length) {
    const header = tableRow(lines[index] ?? '');
    const delimiter = tableRow(lines[index + 1] ?? '');
    if (header === undefined || delimiter === undefined || !isDelimiterRow(delimiter)) {
      index += 1;
      continue;
    }
    const columns = header.segments.slice(header.first, header.end).map(isSensitiveCell);
    for (index += 2; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const row = line.trim() === '' ? undefined : tableRow(line);
      if (row === undefined) break;
      let afterLabel = false;
      for (let at = row.first; at < row.end; at += 1) {
        const cell = row.segments[at] ?? '';
        if (afterLabel || columns[at - row.first] === true) row.segments[at] = maskCell(cell);
        afterLabel ||= isSensitiveCell(cell);
      }
      lines[index] = row.segments.join('|');
    }
  }
  return lines.join('\n');
}

/** Masks pipe-table values under or beside credential- and personal-named cells, then applies {@link redactReportText}. */
export function redactReportMarkdown(markdown: string): string {
  return redactReportText(maskTables(markdown));
}
