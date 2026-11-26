// Table inventory: bootstrap DDL, schema updates, ORM declarations and the live catalog, with each table's owner and legacy writers.
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';
import type { ReadOnlyMssql } from '../lib/mssql.js';
import { repoPath } from '../lib/paths.js';
import { pinnedSha } from '../lib/pin.js';
import { readJson } from '../lib/report.js';
import {
  lineOf,
  parseAttributes,
  parseCfmlComponent,
  resolveComponentPath,
  stripComments,
  type CfmlComponent,
  type SourceTree,
  type WriteClosure,
} from './closure.js';
import { ENTITY_SCAN_ROOT } from './entities.js';
import type { PreventedBy, SessionEffects, SourceRef, Trigger, WriterOp, WriterOverride, WriterOverrides } from './overrides.js';
import { normaliseInventoryKey } from './route-keys.js';
import { blankSqlComments, FIXTURE_SQL_DIR, PROGRAM_SCHEMA_FOLD, PROGRAM_SCHEMA_VAR } from './routes.js';

/** Archive path of the SQL Server bootstrap DDL. */
export const BOOTSTRAP_DDL_PATH = 'core/setup/db/mssql.sql';

/** Archive folder of the schema updates; only its `.cfm` files are updates. */
export const DB_UPDATES_DIR = 'core/mura/dbUpdates';

/** Default location of the table ownership file. */
export const TABLE_OWNERSHIP_PATH: string = repoPath('opt2/table-ownership.json');

/** Locator of a table or column known only from the live catalog. */
export const LIVE_TABLE_SOURCE: SourceRef = Object.freeze({ path: 'live:INFORMATION_SCHEMA.TABLES', lines: [1, 1] }) as SourceRef;

/** Method recorded for a writer in a `.cfm` template, or an override that names no method. */
export const TEMPLATE_METHOD = '(template)';

/** keyScope of a writer whose rows no request value bounds; recorded as `['table']`, since keyScope is always a list. */
export const TABLE_SCOPE = 'table';

/** Serialized-document columns the migration plan names, compared with the computed ones. */
export const EXPECTED_SERIALIZED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tcontentobjects: ['params'],
  tformresponsepackets: ['Data'],
  toauthtokens: ['data'],
  ttrash: ['objectstring'],
});

const BOOTSTRAP_DIR = 'core/setup/db';
const LIB_DIR = 'core/mura/lib/';
// configBean.cfc:936 sets the SQL Server large-object type the schema updates interpolate as #MSSQLlob#.
const MSSQL_LOB = { type: 'nvarchar', length: 'max' } as const;
const FIXTURE_SCHEMA = /^(?:synthetic|program_\d+)$/i;
const PROGRAM_SCHEMA = /^program_\d+$/i;
// OPT-2's own coordination schema in the legacy database; it holds no legacy table.
const COORDINATION_SCHEMAS: ReadonlySet<string> = new Set(['opt2_sync']);
const DECLARED_ENTITY_PATTERN = 'tentity-declared:*';
const DOCUMENT_TYPES: ReadonlySet<string> = new Set(['ntext', 'text', 'longtext', 'mediumtext', 'clob']);
const CFML_SCOPES: ReadonlySet<string> = new Set([
  'arguments',
  'local',
  'variables',
  'this',
  'form',
  'url',
  'attributes',
  'request',
  'session',
  'application',
]);

// Types

/** Where a table's entry comes from; bootstrap outranks orm, which outranks migration. */
export type TableOrigin = 'bootstrap' | 'migration' | 'orm' | 'dynamic' | 'fixture' | 'live-only';

/** One column with its declared type; `length` is null when undeclared. */
export interface TableColumn {
  name: string;
  type: string | null;
  length: number | 'max' | null;
  nullable: boolean | null;
  source: SourceRef;
}

/** A statement that creates the table in one SQL dialect (`any` outside a dialect branch, `orm` for an entity). */
export interface DialectSource {
  dialect: string;
  path: string;
  lines: [number, number];
}

/** The ORM entity that maps a table. */
export interface OrmEntityRef {
  path: string;
  entityName: string | null;
}

/** Live catalog facts merged into an entry; `instances` lists the schema-qualified live tables folded into it. */
export interface LiveTableState {
  present: boolean;
  instances: string[];
  columns: string[];
  primaryKey: string[];
  hasPrimaryKey: boolean | null;
  hasSiteId: boolean | null;
}

/** One legacy writer of a table, keyed by component, method, source lines, op and trigger. */
export interface WriterEntry {
  component: string;
  method: string;
  source: SourceRef;
  op: WriterOp;
  routeKeys: string[];
  keyScope: string[];
  trigger: Trigger;
  sessionEffects: SessionEffects;
  condition: string | null;
  override: string | null;
  columns?: string[];
  preventedBy?: PreventedBy;
  noGroupJoin?: boolean;
  dynamic?: boolean;
}

/** One `tables[]` entry: facts, owner and writers of a legacy table. */
export interface TableEntry {
  id: string;
  table: string;
  schema: string;
  origin: TableOrigin;
  source: SourceRef;
  createdBy: DialectSource[];
  otherDialects: DialectSource[];
  retired: boolean;
  droppedBy: SourceRef | null;
  /** Governing columns, key and siteID facts: the live catalog's for a table it holds, else the static ones. */
  columns: TableColumn[];
  hasSiteId: boolean;
  siteIdColumn: string | null;
  siteIdSource: SourceRef | null;
  hasPrimaryKey: boolean | null;
  /** Whether the bootstrap DDL itself declares a key; null for tables it does not create. */
  bootstrapHasPrimaryKey: boolean | null;
  primaryKey: string[];
  /** Statement that set the current key, when it lies outside the file that creates the table. */
  primaryKeySource: SourceRef | null;
  /** The static facts the governing ones replace; empty or null for a table only the live catalog shows. */
  staticColumns: TableColumn[];
  staticHasSiteId: boolean | null;
  staticSiteIdColumn: string | null;
  staticSiteIdSource: SourceRef | null;
  staticHasPrimaryKey: boolean | null;
  staticPrimaryKey: string[];
  staticPrimaryKeySource: SourceRef | null;
  serializedColumns: string[];
  expectedSerializedColumns?: string[];
  ormEntity: OrmEntityRef | null;
  owningService: string | null;
  ownershipRuleStep: number[];
  targetUnits: string[];
  split: Record<string, unknown> | null;
  decisionListRef: string | null;
  writers: WriterEntry[];
  live: LiveTableState | null;
  liveStatus: 'live' | 'pending-run';
}

/** A computed figure that differs from the figure the migration plan states. */
export interface TableCorrection {
  measure: string;
  expected: string[];
  computed: string[];
}

/** Static table counts; the origin and siteID counts include `retired` tables, `staticTotal` leaves them out. */
export interface TableCounts {
  bootstrap: number;
  migration: number;
  orm: number;
  staticTotal: number;
  retired: number;
  liveStatic: number;
  withSiteId: number;
  withoutPrimaryKeyBootstrap: number;
  withoutPrimaryKey: number;
}

/** Result of {@link extractTables}. */
export interface TableExtraction {
  tables: TableEntry[];
  counts: TableCounts;
  /** Bootstrap tables whose DDL declares no primary key. */
  noPrimaryKeyBootstrap: string[];
  /** Static tables still without a primary key after every schema update. */
  noPrimaryKey: string[];
  corrections: TableCorrection[];
}

/** The writes one inventoried entry point reaches, with its route key (null for the start-up root) and trigger. */
export interface WriteEvidence {
  entryRouteKey: string | null;
  trigger: Trigger;
  closure: WriteClosure;
}

/** Scheduled jobs whose step tables `tablesFrom.job` overrides expand to. */
export interface WriterEntryPoints {
  jobs: readonly { id: string; steps: readonly { tables: readonly string[] }[] }[];
}

/** A write whose table has no inventory entry. */
export interface UnmatchedWrite {
  table: string;
  component: string;
  method: string;
  source: SourceRef;
  override: string | null;
}

/** Result of {@link attachWriters}. */
export interface AttachedWriters {
  tables: TableEntry[];
  unmatched: UnmatchedWrite[];
}

/** One live column. */
export interface LiveColumn {
  name: string;
  type: string;
  length: number | 'max' | null;
  nullable: boolean;
}

/** One base table of the live catalog. */
export interface LiveCatalogTable {
  schema: string;
  name: string;
  columns: LiveColumn[];
  primaryKey: string[];
  hasPrimaryKey: boolean;
  hasSiteId: boolean;
}

// Names and lexing

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ref(p: string, from: number, to: number): SourceRef {
  return { path: p, lines: [from, Math.max(from, to)] };
}

/** Inventory name of a table: lower-cased for `dbo`, `Program_N.<table>` for a program schema, else `<schema>.<table>`. */
function tableName(schema: string, name: string): string {
  const table = name.toLowerCase();
  if (schema.toLowerCase() === 'dbo') return table;
  return PROGRAM_SCHEMA.test(schema) ? `Program_N.${table}` : `${schema}.${table}`;
}

/** Lookup key of a table name as a write, override or live row spells it. */
export function tableKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^dbo\./, '')
    .replace(/^program_\d+\./, 'program_n.');
}

function schemaOf(name: string): string {
  const dot = name.indexOf('.');
  return dot < 0 ? 'dbo' : name.slice(0, dot);
}

function unquoteIdent(raw: string): string {
  return raw.trim().replace(/^[[`"]|[\]`"]$/g, '');
}

/** Schema and name of a possibly qualified, bracketed, back-ticked or quoted table reference. */
function parseTableRef(raw: string): { schema: string; name: string } {
  const parts = raw.split('.').map(unquoteIdent);
  const name = parts[parts.length - 1] ?? '';
  return { schema: parts.length > 1 ? (parts[parts.length - 2] ?? 'dbo') : 'dbo', name };
}

const TABLE_REF = String.raw`((?:(?:\[[^\]]+\]|\x60[^\x60]+\x60|"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)?(?:\[[^\]]+\]|\x60[^\x60]+\x60|"[^"]+"|[A-Za-z_][\w$]*))`;

/** Index after the quoted string, bracketed or back-ticked identifier opening at `at`. */
function skipQuoted(text: string, at: number): number {
  const open = text.charAt(at);
  const close = open === '[' ? ']' : open;
  let j = at + 1;
  while (j < text.length) {
    if (text.charAt(j) === close) {
      if (close !== ']' && text.charAt(j + 1) === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

const QUOTES = new Set(["'", '"', '`', '[']);

/** Index of the `)` closing the `(` at `open`, skipping quoted text; -1 when unbalanced. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let j = open;
  while (j < text.length) {
    const c = text.charAt(j);
    if (QUOTES.has(c)) {
      j = skipQuoted(text, j);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
    j++;
  }
  return -1;
}

/** Top-level pieces of `text` split on commas, skipping quotes, parentheses and `<…>` tags; each with its start offset. */
function splitTopLevel(text: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let start = 0;
  let j = 0;
  while (j < text.length) {
    const c = text.charAt(j);
    if (QUOTES.has(c)) {
      j = skipQuoted(text, j);
      continue;
    }
    if (c === '<') {
      const end = text.indexOf('>', j);
      j = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push({ text: text.slice(start, j), at: start });
      start = j + 1;
    }
    j++;
  }
  out.push({ text: text.slice(start), at: start });
  return out;
}

/** `text` with CFML tags blanked to spaces, keeping newlines and offsets. */
function blankCfmlTags(text: string): string {
  return text.replace(/<\/?cf[a-z][^>]*>/gi, (tag) => tag.replace(/[^\r\n]/g, ' '));
}

function wordPattern(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// SQL schema statements

interface ParsedColumn {
  name: string;
  type: string | null;
  length: number | 'max' | null;
  nullable: boolean | null;
  line: number;
}

interface TableName {
  schema: string;
  name: string;
  key: string;
}

/** A schema change in file order; `dialects` null means every dialect. */
type SchemaEvent = { at: number; table: TableName; dialects: string[] | null } & (
  | { kind: 'create'; line: number; endLine: number; columns: ParsedColumn[]; primaryKey: string[] | null }
  | { kind: 'addColumn'; column: ParsedColumn; creates: { line: number; endLine: number } | null }
  | { kind: 'alterColumn'; column: ParsedColumn }
  | { kind: 'dropColumn'; name: string }
  | { kind: 'renameColumn'; from: string; to: string }
  | { kind: 'setPrimaryKey'; columns: string[]; line: number; endLine: number; ifMissing: boolean }
  | { kind: 'dropPrimaryKey' }
  | { kind: 'dropTable'; line: number }
);

const IDENT = String.raw`(?:\[([^\]]+)\]|\x60([^\x60]+)\x60|"([^"]+)"|([A-Za-z_][\w$]*))`;
const COLUMN_DEF = new RegExp(
  String.raw`^\s*${IDENT}\s+(?:\[([^\]]+)\]|"([^"]+)"|#(\w+)#|([A-Za-z_]\w*))\s*(?:\(\s*(\d+|max)\s*(?:,\s*\d+\s*)?\))?`,
  'i',
);
const CONSTRAINT_WORDS: ReadonlySet<string> = new Set(['constraint', 'primary', 'unique', 'index', 'key', 'foreign', 'check']);

function firstDefined(m: RegExpExecArray, from: number, to: number): string | undefined {
  for (let i = from; i <= to; i++) if (m[i] !== undefined) return m[i];
  return undefined;
}

/** Name, type, length and nullability of a column definition; null for a constraint or an unparsable piece. */
function parseColumnDef(def: string): Omit<ParsedColumn, 'line'> | null {
  const m = COLUMN_DEF.exec(def);
  if (m === null) return null;
  const name = firstDefined(m, 1, 4);
  if (name === undefined || CONSTRAINT_WORDS.has(name.toLowerCase())) return null;
  const variable = m[7]?.toLowerCase();
  let type = (firstDefined(m, 5, 8) ?? '').toLowerCase();
  let length: number | 'max' | null = m[9] === undefined ? null : m[9].toLowerCase() === 'max' ? 'max' : Number(m[9]);
  if (variable === 'mssqllob') {
    type = MSSQL_LOB.type;
    length = MSSQL_LOB.length;
  }
  const rest = def.slice(m[0].length);
  const nullable = /\bNOT\s+NULL\b/i.test(rest) ? false : /\bNULL\b/i.test(rest) ? true : null;
  return { name, type: type === '' ? null : type, length, nullable };
}

/** Column names of a `( … )` key column list. */
function keyColumns(list: string): string[] {
  return list
    .split(',')
    .map((c) => unquoteIdent(c.replace(/\s+(?:ASC|DESC)\s*$/i, '')))
    .filter((c) => c !== '');
}

const PRIMARY_KEY_CLAUSE = /\bPRIMARY\s+KEY\s*(?:NONCLUSTERED|CLUSTERED)?\s*\(/i;
const SQL_STATEMENT = /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|EXEC(?:UTE)?\s+sp_rename)\b/gi;

/** Schema events of one GO batch or `<cfquery>` body starting at `base` in `fileText`; a statement ends at the next keyword. */
function sqlSchemaEvents(segment: string, base: number, fileText: string, dialects: (at: number) => string[] | null): SchemaEvent[] {
  const events: SchemaEvent[] = [];
  const starts = [...segment.matchAll(SQL_STATEMENT)];
  starts.forEach((m, idx) => {
    const kw = (m[1] ?? '').replace(/\s+/g, ' ').toUpperCase();
    const at = base + m.index;
    const end = starts[idx + 1]?.index ?? segment.length;
    const stmt = segment.slice(m.index + m[0].length, end);
    const lineAt = (offset: number): number => lineOf(fileText, base + m.index + m[0].length + offset);
    const line = lineOf(fileText, at);
    const d = dialects(at);
    if (kw.startsWith('EXEC')) {
      const r = /^\s*N?'([^'.]+)\.\[?([\w$]+)\]?'\s*,\s*N?'([\w$]+)'\s*,\s*N?'COLUMN'/i.exec(stmt);
      if (r?.[1] !== undefined && r[2] !== undefined && r[3] !== undefined) {
        const t = parseTableRef(r[1]);
        events.push({ kind: 'renameColumn', at, table: named(t), dialects: d, from: r[2], to: r[3] });
      }
      return;
    }
    const refMatch = new RegExp(String.raw`^\s*(?:IF\s+NOT\s+EXISTS\s+)?${TABLE_REF}`, 'i').exec(stmt);
    if (refMatch?.[1] === undefined) return;
    const table = named(parseTableRef(refMatch[1]));
    const rest = stmt.slice(refMatch[0].length);
    const restAt = refMatch[0].length;
    if (kw === 'DROP TABLE') {
      events.push({ kind: 'dropTable', at, table, dialects: d, line });
    } else if (kw === 'CREATE TABLE') {
      const open = rest.indexOf('(');
      if (open < 0 || rest.slice(0, open).trim() !== '') return;
      const close = closeParen(rest, open);
      if (close < 0) return;
      const columns: ParsedColumn[] = [];
      let primaryKey: string[] | null = null;
      for (const piece of splitTopLevel(rest.slice(open + 1, close))) {
        const pk = PRIMARY_KEY_CLAUSE.exec(piece.text);
        if (pk !== null && /^\s*(?:CONSTRAINT\b|PRIMARY\b)/i.test(piece.text)) {
          const listOpen = pk.index + pk[0].length - 1;
          const listClose = closeParen(piece.text, listOpen);
          primaryKey = keyColumns(piece.text.slice(listOpen + 1, listClose < 0 ? piece.text.length : listClose));
          continue;
        }
        const col = parseColumnDef(piece.text);
        if (col === null) continue;
        const lead = piece.text.length - piece.text.trimStart().length;
        columns.push({ ...col, line: lineAt(restAt + open + 1 + piece.at + lead) });
        if (/\bPRIMARY\s+KEY\b/i.test(piece.text)) primaryKey = [col.name];
      }
      events.push({ kind: 'create', at, table, dialects: d, line, endLine: lineAt(restAt + close), columns, primaryKey });
    } else {
      events.push(...alterEvents(rest, restAt, at, table, d, line, lineAt));
    }
  });
  return events;
}

function named(t: { schema: string; name: string }): TableName {
  const name = tableName(t.schema, t.name);
  return { schema: t.schema.toLowerCase() === 'dbo' ? 'dbo' : schemaOf(name), name, key: tableKey(name) };
}

/** Events of one `ALTER TABLE` body: key, column and drop clauses. */
function alterEvents(
  rest: string,
  restAt: number,
  at: number,
  table: TableName,
  dialects: string[] | null,
  line: number,
  lineAt: (offset: number) => number,
): SchemaEvent[] {
  const pk = PRIMARY_KEY_CLAUSE.exec(rest);
  if (pk !== null && /\bADD\b/i.test(rest.slice(0, pk.index))) {
    const listOpen = pk.index + pk[0].length - 1;
    const listClose = closeParen(rest, listOpen);
    const columns = keyColumns(rest.slice(listOpen + 1, listClose < 0 ? rest.length : listClose));
    const endLine = lineAt(restAt + (listClose < 0 ? listOpen : listClose));
    return [{ kind: 'setPrimaryKey', at, table, dialects, columns, line, endLine, ifMissing: false }];
  }
  if (/\bDROP\s+(?:CONSTRAINT\s+[[`"]?pk|PRIMARY\s+KEY\b)/i.test(rest)) return [{ kind: 'dropPrimaryKey', at, table, dialects }];
  const drop = new RegExp(String.raw`\bDROP\s+COLUMN\s+${IDENT}`, 'i').exec(rest);
  if (drop !== null) {
    const name = firstDefined(drop, 1, 4);
    return name === undefined ? [] : [{ kind: 'dropColumn', at, table, dialects, name }];
  }
  const alter = /\bALTER\s+COLUMN\b/i.exec(rest);
  if (alter !== null) {
    const col = parseColumnDef(rest.slice(alter.index + alter[0].length));
    return col === null ? [] : [{ kind: 'alterColumn', at, table, dialects, column: { ...col, line } }];
  }
  const add = /^\s*(?:WITH\s+(?:NO)?CHECK\s+)?ADD\s+(?:COLUMN\s+)?/i.exec(rest);
  if (add !== null) {
    const col = parseColumnDef(rest.slice(add[0].length));
    if (col !== null) return [{ kind: 'addColumn', at, table, dialects, column: { ...col, line: lineAt(restAt + add[0].length) }, creates: null }];
  }
  return [];
}

// CFML schema updates: dialect branches and dbUtility calls

interface DialectSpan {
  start: number;
  end: number;
  dialects: string[];
}

function dbTypeCondition(attrs: string): string[] | null {
  const m = /getDbType\(\)\s*(?:eq|is|==)\s*["']([\w,]+)["']/i.exec(attrs);
  return m?.[1] === undefined ? null : m[1].toLowerCase().split(',');
}

/** Spans of `<cfcase>` branches of `getDbType()` switches and of `<cfif getDbType() eq …>` branches. */
function dialectSpans(text: string): DialectSpan[] {
  type Frame =
    | { kind: 'switch'; db: boolean }
    | { kind: 'case'; start: number; dialects: string[] | null }
    | { kind: 'if'; start: number; dialects: string[] | null };
  const spans: DialectSpan[] = [];
  const stack: Frame[] = [];
  const close = (frame: Frame | undefined, end: number): void => {
    if (frame !== undefined && frame.kind !== 'switch' && frame.dialects !== null) {
      spans.push({ start: frame.start, end, dialects: frame.dialects });
    }
  };
  const popTo = (kind: Frame['kind']): Frame | undefined => {
    const idx = stack.map((f) => f.kind).lastIndexOf(kind);
    return idx < 0 ? undefined : stack.splice(idx)[0];
  };
  for (const m of text.matchAll(/<(\/?)(cfswitch|cfcase|cfif|cfelseif|cfelse)\b([^>]*)>/gi)) {
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    const attrs = m[3] ?? '';
    const tagStart = m.index;
    const tagEnd = m.index + m[0].length;
    if (tag === 'cfswitch') {
      if (closing) popTo('switch');
      else stack.push({ kind: 'switch', db: /getDbType\(\)/i.test(attrs) });
    } else if (tag === 'cfcase') {
      if (closing) {
        close(popTo('case'), tagStart);
      } else {
        const sw = stack[stack.length - 1];
        const value = parseAttributes(attrs).value;
        const db = sw?.kind === 'switch' && sw.db && value !== undefined;
        stack.push({ kind: 'case', start: tagEnd, dialects: db ? value.toLowerCase().split(',').map((v) => v.trim()) : null });
      }
    } else if (tag === 'cfif') {
      if (closing) close(popTo('if'), tagStart);
      else stack.push({ kind: 'if', start: tagEnd, dialects: dbTypeCondition(attrs) });
    } else {
      const frame = stack[stack.length - 1];
      if (frame?.kind !== 'if') continue;
      close(frame, tagStart);
      frame.start = tagEnd;
      frame.dialects = tag === 'cfelseif' ? dbTypeCondition(attrs) : null;
    }
  }
  return spans;
}

/** Innermost dialect list at `offset`, or null outside every dialect branch. */
function dialectAt(spans: readonly DialectSpan[], offset: number): string[] | null {
  let inner: DialectSpan | undefined;
  for (const s of spans) if (s.start <= offset && offset < s.end && (inner === undefined || s.start >= inner.start)) inner = s;
  return inner?.dialects ?? null;
}

interface CallSite {
  name: string;
  args: string;
  at: number;
  end: number;
}

/** The call chain starting at the method name at `at`: `name(args)` then each `.name(args)` that follows. */
function readChain(text: string, at: number): CallSite[] {
  const calls: CallSite[] = [];
  let j = at;
  for (;;) {
    const m = /^([A-Za-z_]\w*)\s*\(/.exec(text.slice(j, j + 80));
    if (m?.[1] === undefined) break;
    const open = j + m[0].length - 1;
    const close = closeParen(text, open);
    if (close < 0) break;
    calls.push({ name: m[1], args: text.slice(open + 1, close), at: j, end: close + 1 });
    let k = close + 1;
    while (k < text.length && /\s/.test(text.charAt(k))) k++;
    if (text.charAt(k) !== '.') break;
    k++;
    while (k < text.length && /\s/.test(text.charAt(k))) k++;
    j = k;
  }
  return calls;
}

function firstLiteral(args: string): string | undefined {
  return /^\s*(["'])(.*?)\1/.exec(args)?.[2];
}

/** Schema events of the `dbUtility` calls in a schema update; a `setTable` sets the table later calls act on. */
function dbUtilityEvents(text: string, spans: readonly DialectSpan[]): SchemaEvent[] {
  const events: SchemaEvent[] = [];
  let current: TableName | null = null;
  let chainLine = 0;
  for (const m of text.matchAll(/\b(?:dbUtility|getBean\(\s*["']dbUtility["']\s*\))\s*\.\s*(?=[A-Za-z_]\w*\s*\()/gi)) {
    const chain = readChain(text, m.index + m[0].length);
    const chainEnd = chain[chain.length - 1]?.end ?? m.index;
    for (const call of chain) {
      const method = call.name.toLowerCase();
      const attrs = parseAttributes(call.args);
      const dialects = dialectAt(spans, call.at);
      const line = lineOf(text, call.at);
      if (method === 'settable') {
        const name = attrs.table ?? firstLiteral(call.args);
        current = name === undefined || name === '' ? null : named(parseTableRef(name));
        chainLine = line;
        continue;
      }
      const table = attrs.table === undefined || attrs.table === '' ? current : named(parseTableRef(attrs.table));
      if (table === null) continue;
      const base = { at: call.at, table, dialects };
      const column = attrs.column ?? firstLiteral(call.args);
      const typed = (): ParsedColumn => ({
        name: column ?? '',
        type: (attrs.datatype ?? '').toLowerCase() || null,
        length: attrs.length === undefined || attrs.length === '' ? null : attrs.length.toLowerCase() === 'max' ? 'max' : Number(attrs.length),
        nullable: attrs.nullable === undefined ? null : attrs.nullable.toLowerCase() !== 'false',
        line,
      });
      if (method === 'addcolumn' && column !== undefined && column !== '') {
        events.push({ ...base, kind: 'addColumn', column: typed(), creates: { line: chainLine || line, endLine: lineOf(text, chainEnd) } });
      } else if (method === 'altercolumn' && column !== undefined && column !== '') {
        events.push({ ...base, kind: 'alterColumn', column: typed() });
      } else if (method === 'renamecolumn' && column !== undefined && attrs.newcolumn !== undefined) {
        events.push({ ...base, kind: 'renameColumn', from: column, to: attrs.newcolumn });
      } else if (method === 'addprimarykey' && column !== undefined && column !== '') {
        events.push({ ...base, kind: 'setPrimaryKey', columns: keyColumns(column), line: chainLine || line, endLine: line, ifMissing: true });
      } else if (method === 'dropprimarykey') {
        events.push({ ...base, kind: 'dropPrimaryKey' });
      } else if (method === 'droptable') {
        events.push({ ...base, kind: 'dropTable', line });
      }
    }
  }
  return events;
}

/** Schema events of one update file in file order: `<cfquery>` SQL (query-of-queries excluded) and `dbUtility` calls. */
function updateEvents(text: string): SchemaEvent[] {
  const stripped = stripComments(text, 'auto');
  const spans = dialectSpans(stripped);
  const events: SchemaEvent[] = [];
  for (const q of stripped.matchAll(/<cfquery\b([^>]*)>([\s\S]*?)<\/cfquery\s*>/gi)) {
    if (/\bdbtype\s*=\s*["']?query/i.test(q[1] ?? '')) continue;
    const base = q.index + q[0].length - (q[2] ?? '').length - (/<\/cfquery\s*>$/i.exec(q[0])?.[0].length ?? 0);
    events.push(...sqlSchemaEvents(blankCfmlTags(q[2] ?? ''), base, text, (at) => dialectAt(spans, at)));
  }
  events.push(...dbUtilityEvents(stripped, spans));
  return events.sort((a, b) => a.at - b.at);
}


// Static extraction

type StaticOrigin = 'bootstrap' | 'migration' | 'orm';

const STATIC_ORIGINS: ReadonlySet<TableOrigin> = new Set<StaticOrigin>(['bootstrap', 'migration', 'orm']);

/** Origin of a table some DDL or entity declaration creates: the archive's, or the working-tree fixture SQL's. */
type DraftOrigin = StaticOrigin | 'fixture';

interface Draft {
  table: string;
  schema: string;
  key: string;
  origin: DraftOrigin;
  source: SourceRef;
  createdBy: DialectSource[];
  otherDialects: DialectSource[];
  columns: TableColumn[];
  primaryKey: { columns: string[]; source: SourceRef } | null;
  bootstrapHasPrimaryKey: boolean | null;
  droppedBy: SourceRef | null;
  ormEntity: OrmEntityRef | null;
}

function newDraft(t: TableName, origin: DraftOrigin, source: SourceRef, createdBy: DialectSource): Draft {
  return {
    table: t.name,
    schema: t.schema,
    key: t.key,
    origin,
    source,
    createdBy: [createdBy],
    otherDialects: [],
    columns: [],
    primaryKey: null,
    bootstrapHasPrimaryKey: null,
    droppedBy: null,
    ormEntity: null,
  };
}

function findColumn(d: Draft, name: string): TableColumn | undefined {
  const lower = name.toLowerCase();
  return d.columns.find((c) => c.name.toLowerCase() === lower);
}

function addColumn(d: Draft, col: Omit<TableColumn, 'source'>, source: SourceRef): void {
  if (col.name !== '' && findColumn(d, col.name) === undefined) {
    d.columns.push({ name: col.name, type: col.type, length: col.length, nullable: col.nullable, source });
  }
}

/** Key columns in the declared case of the table's columns. */
function declaredCase(d: Draft, columns: readonly string[]): string[] {
  return columns.map((c) => findColumn(d, c)?.name ?? c);
}

function dialectLabel(dialects: string[] | null): string {
  return dialects === null ? 'any' : dialects.join(',');
}

function appliesToMssql(dialects: string[] | null): boolean {
  return dialects === null || dialects.includes('mssql');
}

interface OtherDialectCreate {
  key: string;
  record: DialectSource;
}

/** Applies one SQL Server schema event: creation for unknown tables, changes to known ones; other dialects' creates go to `others`. */
function applyEvent(drafts: Map<string, Draft>, e: SchemaEvent, file: string, origin: DraftOrigin, others: OtherDialectCreate[]): void {
  const draft = drafts.get(e.table.key);
  if (e.kind === 'create') {
    const record: DialectSource = { dialect: dialectLabel(e.dialects), path: file, lines: [e.line, e.line] };
    if (!appliesToMssql(e.dialects)) {
      others.push({ key: e.table.key, record });
      return;
    }
    const target = draft ?? newDraft(e.table, origin, ref(file, e.line, e.endLine), record);
    if (draft === undefined) drafts.set(e.table.key, target);
    else target.otherDialects.push(record);
    for (const c of e.columns) addColumn(target, c, ref(file, c.line, c.line));
    if (e.primaryKey !== null && target.primaryKey === null) {
      target.primaryKey = { columns: declaredCase(target, e.primaryKey), source: ref(file, e.line, e.endLine) };
    }
    return;
  }
  if (!appliesToMssql(e.dialects)) return;
  if (draft === undefined) {
    if (e.kind === 'addColumn' && e.creates !== null) {
      const created = newDraft(e.table, origin, ref(file, e.creates.line, e.creates.endLine), {
        dialect: dialectLabel(e.dialects),
        path: file,
        lines: [e.creates.line, e.creates.line],
      });
      drafts.set(e.table.key, created);
      addColumn(created, e.column, ref(file, e.column.line, e.column.line));
    }
    return;
  }
  switch (e.kind) {
    case 'addColumn':
      addColumn(draft, e.column, ref(file, e.column.line, e.column.line));
      break;
    case 'alterColumn': {
      const col = findColumn(draft, e.column.name);
      if (col !== undefined) {
        col.type = e.column.type ?? col.type;
        col.length = e.column.length;
      }
      break;
    }
    case 'dropColumn':
      draft.columns = draft.columns.filter((c) => c.name.toLowerCase() !== e.name.toLowerCase());
      break;
    case 'renameColumn': {
      const col = findColumn(draft, e.from);
      if (col !== undefined && findColumn(draft, e.to) === undefined) col.name = e.to;
      break;
    }
    case 'setPrimaryKey':
      if (!e.ifMissing || draft.primaryKey === null) {
        draft.primaryKey = { columns: declaredCase(draft, e.columns), source: ref(file, e.line, e.endLine) };
      }
      break;
    case 'dropPrimaryKey':
      draft.primaryKey = null;
      break;
    case 'dropTable':
      draft.droppedBy = ref(file, e.line, e.line);
      break;
  }
}

/** Tables of the bootstrap DDL, with their GO-batch `ALTER TABLE` keys and the other dialects' DDL lines. */
function bootstrapDrafts(tree: SourceTree): Map<string, Draft> {
  const drafts = new Map<string, Draft>();
  const text = tree.readText(BOOTSTRAP_DDL_PATH);
  const mssql = (): string[] => ['mssql'];
  let start = 0;
  const batches = [...text.matchAll(/^[ \t]*GO[ \t]*\r?$/gim)].map((m) => m.index);
  for (const end of [...batches, text.length]) {
    for (const e of sqlSchemaEvents(text.slice(start, end), start, text, mssql)) applyEvent(drafts, e, BOOTSTRAP_DDL_PATH, 'bootstrap', []);
    start = end;
  }
  for (const d of drafts.values()) d.bootstrapHasPrimaryKey = d.primaryKey !== null;
  for (const file of tree.list(BOOTSTRAP_DIR, { ext: ['sql'] })) {
    if (file === BOOTSTRAP_DDL_PATH) continue;
    const dialect = path.posix.basename(file, '.sql').toLowerCase();
    const other = tree.readText(file);
    for (const m of other.matchAll(new RegExp(String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE_REF}`, 'gi'))) {
      const draft = drafts.get(named(parseTableRef(m[1] ?? '')).key);
      const line = lineOf(other, m.index);
      draft?.otherDialects.push({ dialect, path: file, lines: [line, line] });
    }
  }
  return drafts;
}

/** The first component under the entity scan root, in path order, whose declaration maps each of `ormTables`. */
function ormDeclarations(tree: SourceTree, ormTables: readonly string[]): Map<string, CfmlComponent> {
  const wanted = new Set(ormTables.map((t) => t.toLowerCase()));
  const found = new Map<string, CfmlComponent>();
  for (const file of tree.list(ENTITY_SCAN_ROOT, { ext: ['cfc'], recursive: true })) {
    const text = tree.readText(file);
    const declares = [...text.matchAll(/\btable\s*=\s*["']?([A-Za-z_][\w$]*)/gi)].some((m) => wanted.has((m[1] ?? '').toLowerCase()));
    if (!declares) continue;
    const comp = parseCfmlComponent(file, text);
    const table = comp?.declaration.attrs.table?.toLowerCase();
    if (comp === null || table === undefined || !wanted.has(table) || found.has(table)) continue;
    if ((comp.declaration.attrs.extends ?? '') !== '') found.set(table, comp);
  }
  return found;
}

interface OrmColumns {
  columns: Array<Omit<TableColumn, 'source'> & { source: SourceRef }>;
  primaryKey: { columns: string[]; source: SourceRef } | null;
}

/** Persistent columns and key of an ORM entity as `bean.cfc` builds them from its own and inherited properties. */
function ormColumns(comp: CfmlComponent, tree: SourceTree, parsed: Map<string, CfmlComponent | null>): OrmColumns {
  const props: Array<{ attrs: Record<string, string>; name: string; line: number; path: string }> = [];
  const names = new Set<string>();
  const seen = new Set<string>();
  let cur: CfmlComponent | null = comp;
  while (cur !== null && !seen.has(cur.path)) {
    seen.add(cur.path);
    for (const p of cur.properties) {
      if (names.has(p.name.toLowerCase())) continue;
      names.add(p.name.toLowerCase());
      props.push({ attrs: p.attrs, name: p.name, line: p.line, path: cur.path });
    }
    const ext: string = cur.declaration.attrs.extends ?? '';
    const parent: string | null = ext === '' ? null : resolveComponentPath(ext, cur.path, tree);
    if (parent === null) break;
    if (!parsed.has(parent)) parsed.set(parent, parseCfmlComponent(parent, tree.readText(parent)));
    cur = parsed.get(parent) ?? null;
  }
  const historical = props.some((p) => (p.attrs.historical ?? '').toLowerCase() === 'true');
  const columns: OrmColumns['columns'] = [];
  let primaryKey: OrmColumns['primaryKey'] = null;
  for (const p of props) {
    if ((p.attrs.persistent ?? '').toLowerCase() === 'false') continue;
    const related = p.attrs.cfc ?? p.attrs.relatesto;
    const column = related !== undefined ? (p.attrs.fkcolumn ?? 'primaryKey') : (p.attrs.column ?? p.name);
    if (column === '' || column.toLowerCase() === 'primarykey') continue;
    const length = p.attrs.length;
    const source = ref(p.path, p.line, p.line);
    columns.push({
      name: column,
      type: (p.attrs.datatype ?? p.attrs.ormtype ?? p.attrs.type ?? 'varchar').toLowerCase(),
      length: length === undefined || length === '' ? null : length.toLowerCase() === 'max' ? 'max' : Number(length),
      nullable: p.attrs.nullable === undefined ? null : p.attrs.nullable.toLowerCase() !== 'false',
      source,
    });
    const isKey = (p.attrs.fieldtype ?? '').toLowerCase() === 'id' && (!historical || p.name.toLowerCase() === 'histid');
    if (isKey && primaryKey === null) primaryKey = { columns: [column], source };
  }
  return { columns, primaryKey };
}

interface OrmTable {
  table: string;
  declared: { entity: OrmEntityRef; span: SourceRef; mapping: OrmColumns } | null;
}

/** Entity declaration and persistent columns of each of `ormTables`; `declared` is null when no component declares it. */
function ormTablesOf(tree: SourceTree, ormTables: readonly string[]): OrmTable[] {
  const declarations = ormDeclarations(tree, ormTables);
  const parsed = new Map<string, CfmlComponent | null>();
  return [...new Set(ormTables.map((t) => t.toLowerCase()))].sort(compareText).map((table) => {
    const comp = declarations.get(table);
    if (comp === undefined) return { table, declared: null };
    return {
      table,
      declared: {
        entity: { path: comp.path, entityName: comp.declaration.attrs.entityname ?? null },
        span: ref(comp.path, comp.declaration.line, comp.declaration.endLine),
        mapping: ormColumns(comp, tree, parsed),
      },
    };
  });
}

/** Records each entity on its table and creates the tables only an entity declares, before the schema updates run. */
// A bootstrap table an entity also maps keeps the DDL's columns: no schema update runs that entity's checkSchema().
function addOrmTables(orm: readonly OrmTable[], drafts: Map<string, Draft>): void {
  for (const { table, declared } of orm) {
    let draft = drafts.get(table);
    if (draft === undefined) {
      if (declared === null) throw new Error(`ORM table ${table} has no entity declaration under ${ENTITY_SCAN_ROOT}`);
      const { span, mapping } = declared;
      draft = newDraft({ schema: 'dbo', name: table, key: table }, 'orm', span, { dialect: 'orm', path: span.path, lines: span.lines });
      draft.primaryKey = mapping.primaryKey;
      for (const { source, ...col } of mapping.columns) addColumn(draft, col, source);
      drafts.set(table, draft);
    }
    draft.ormEntity = declared?.entity ?? null;
  }
}

/** Applies every schema update in name order, as `configBean.cfc` includes them, then their other-dialect creates. */
function applyUpdates(tree: SourceTree, drafts: Map<string, Draft>): void {
  const others: OtherDialectCreate[] = [];
  for (const file of tree.list(DB_UPDATES_DIR, { ext: ['cfm'] })) {
    for (const e of updateEvents(tree.readText(file))) applyEvent(drafts, e, file, 'migration', others);
  }
  for (const { key, record } of others) drafts.get(key)?.otherDialects.push(record);
}


// Serialized-document columns

const SERIALIZER_HINT = /deserializeJSON|serializeJSON|wddx|isJSON|serialize\s*=\s*true/i;
const DESERIALIZE_CALL =
  /\b(?:deserializeJSON|_deserializeWDDX|isWDDX|isJSON)\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*(?:\s*\(\s*\))?|\s*\[\s*["'][\w$]+["']\s*\])+)\s*\)/gi;

function isDocumentColumn(c: TableColumn): boolean {
  const type = c.type ?? '';
  return DOCUMENT_TYPES.has(type) || (c.length === 'max' && type.endsWith('char'));
}

/** Column a member expression such as `rs.objectstring` or `token.getData()` reads; null for a bare scope variable. */
function memberColumn(expr: string): string | null {
  const segments = [...expr.matchAll(/\[\s*["']([\w$]+)["']\s*\]|([A-Za-z_$][\w$]*)(\s*\(\s*\))?/g)].map((m) => {
    if (m[1] !== undefined) return m[1];
    const name = m[2] ?? '';
    return m[3] !== undefined && /^get./i.test(name) ? name.slice(3) : name;
  });
  const [head = '', last] = [segments[0], segments[segments.length - 1]];
  if (last === undefined || segments.length < 2 || (segments.length === 2 && CFML_SCOPES.has(head.toLowerCase()))) return null;
  return last.toLowerCase();
}

/** Whether a written SQL value is serialized: a serializer call, or a variable a serializer produced in the file. */
function isSerializedValue(value: string, serializedVars: ReadonlySet<string>): boolean {
  if (/serializeJSON\s*\(|serialize\s*=\s*true/i.test(value)) return true;
  return [...value.matchAll(/#\s*(?:variables\.|local\.)?([A-Za-z_]\w*)\s*#/g)].some((m) => serializedVars.has((m[1] ?? '').toLowerCase()));
}

/** Document-typed columns a file naming their table deserializes, or a SQL write of their table fills with a serialized value. */
function serializedColumnsOf(tree: SourceTree, drafts: ReadonlyMap<string, Draft>): Map<string, Set<string>> {
  const candidates = new Map<string, Set<string>>();
  for (const d of drafts.values()) {
    const cols = d.columns.filter(isDocumentColumn).map((c) => c.name.toLowerCase());
    if (cols.length > 0) candidates.set(d.key, new Set(cols));
  }
  const found = new Map<string, Set<string>>();
  if (candidates.size === 0) return found;
  const mark = (key: string, column: string): void => {
    if (candidates.get(key)?.has(column) !== true) return;
    const set = found.get(key) ?? new Set<string>();
    set.add(column);
    found.set(key, set);
  };
  const byEntity = new Map<string, string>();
  const byEntityPath = new Map<string, string>();
  for (const d of drafts.values()) {
    if (d.ormEntity === null) continue;
    byEntityPath.set(d.ormEntity.path, d.key);
    if (d.ormEntity.entityName !== null) byEntity.set(d.ormEntity.entityName.toLowerCase(), d.key);
  }
  const mention = new RegExp(String.raw`\b(${[...candidates.keys()].map(wordPattern).join('|')})\b`, 'gi');
  for (const file of tree.list(ENTITY_SCAN_ROOT, { ext: ['cfc', 'cfm'], recursive: true })) {
    if (file.startsWith(LIB_DIR)) continue;
    const raw = tree.readText(file);
    if (!SERIALIZER_HINT.test(raw)) continue;
    const text = stripComments(raw, 'auto');
    const mentioned = new Set<string>([...text.matchAll(mention)].map((m) => (m[1] ?? '').toLowerCase()));
    for (const m of text.matchAll(/getBean\(\s*["']([A-Za-z_]\w*)["']/gi)) {
      const key = byEntity.get((m[1] ?? '').toLowerCase());
      if (key !== undefined) mentioned.add(key);
    }
    const own = byEntityPath.get(file);
    if (own !== undefined) mentioned.add(own);

    const reads: string[] = [...text.matchAll(DESERIALIZE_CALL)].map((m) => m[1] ?? '');
    for (const m of text.matchAll(/<cfwddx\b([^>]*)>/gi)) {
      const attrs = parseAttributes(m[1] ?? '');
      if ((attrs.action ?? '').toLowerCase() === 'wddx2cfml' && attrs.input !== undefined) reads.push(attrs.input.replace(/#/g, ''));
    }
    for (const expr of reads) {
      const column = memberColumn(expr);
      if (column !== null) for (const key of mentioned) mark(key, column);
    }

    const serializedVars = new Set<string>();
    for (const m of text.matchAll(/<cfwddx\b([^>]*)>/gi)) {
      const attrs = parseAttributes(m[1] ?? '');
      if ((attrs.action ?? '').toLowerCase() === 'cfml2wddx' && attrs.output !== undefined) serializedVars.add(attrs.output.toLowerCase());
    }
    for (const m of text.matchAll(/(?:\bvar\s+)?\b([A-Za-z_]\w*)\s*=\s*serializeJSON\s*\(/gi)) serializedVars.add((m[1] ?? '').toLowerCase());

    for (const m of text.matchAll(new RegExp(String.raw`\bINSERT\s+INTO\s+${TABLE_REF}\s*\(`, 'gi'))) {
      const key = named(parseTableRef(m[1] ?? '')).key;
      if (!candidates.has(key)) continue;
      const colOpen = m.index + m[0].length - 1;
      const colClose = closeParen(text, colOpen);
      if (colClose < 0) continue;
      const values = /^\s*VALUES\s*\(/i.exec(text.slice(colClose + 1, colClose + 64));
      if (values === null) continue;
      const valOpen = colClose + values[0].length;
      const valClose = closeParen(text, valOpen);
      if (valClose < 0) continue;
      const cols = splitTopLevel(text.slice(colOpen + 1, colClose)).map((c) => unquoteIdent(c.text).toLowerCase());
      const vals = splitTopLevel(text.slice(valOpen + 1, valClose));
      cols.forEach((col, i) => {
        const value = vals[i]?.text;
        if (value !== undefined && isSerializedValue(value, serializedVars)) mark(key, col);
      });
    }
    for (const m of text.matchAll(new RegExp(String.raw`\bUPDATE\s+${TABLE_REF}\s+SET\s+`, 'gi'))) {
      const key = named(parseTableRef(m[1] ?? '')).key;
      if (!candidates.has(key)) continue;
      const from = m.index + m[0].length;
      const stop = /\bWHERE\b|<\/cfquery/i.exec(text.slice(from));
      for (const piece of splitTopLevel(text.slice(from, stop === null ? text.length : from + stop.index))) {
        const assign = /^\s*([[`"]?[A-Za-z_][\w$]*[\]`"]?)\s*=([\s\S]*)$/.exec(piece.text);
        if (assign?.[1] !== undefined && isSerializedValue(assign[2] ?? '', serializedVars)) mark(key, unquoteIdent(assign[1]).toLowerCase());
      }
    }
  }
  return found;
}

// extractTables

function liveDefaults(): Pick<TableEntry, 'live' | 'liveStatus'> {
  return { live: null, liveStatus: 'pending-run' };
}

function ownerDefaults(): Pick<TableEntry, 'owningService' | 'ownershipRuleStep' | 'targetUnits' | 'split' | 'decisionListRef'> {
  return { owningService: null, ownershipRuleStep: [], targetUnits: [], split: null, decisionListRef: null };
}

/** The column, key and siteID facts the live catalog governs once merged. */
type GoverningFacts = Pick<TableEntry, 'columns' | 'hasSiteId' | 'siteIdColumn' | 'siteIdSource' | 'hasPrimaryKey' | 'primaryKey' | 'primaryKeySource'>;

/** `facts` recorded as the static provenance a live merge keeps. */
function staticOf(facts: GoverningFacts): Pick<TableEntry, `static${Capitalize<keyof GoverningFacts>}`> {
  return {
    staticColumns: [...facts.columns],
    staticHasSiteId: facts.hasSiteId,
    staticSiteIdColumn: facts.siteIdColumn,
    staticSiteIdSource: facts.siteIdSource,
    staticHasPrimaryKey: facts.hasPrimaryKey,
    staticPrimaryKey: [...facts.primaryKey],
    staticPrimaryKeySource: facts.primaryKeySource,
  };
}

/** The governing facts restored from an entry's static provenance. */
function staticFacts(t: TableEntry): GoverningFacts {
  return {
    columns: [...t.staticColumns],
    hasSiteId: t.staticHasSiteId === true,
    siteIdColumn: t.staticSiteIdColumn,
    siteIdSource: t.staticSiteIdSource,
    hasPrimaryKey: t.staticHasPrimaryKey,
    primaryKey: [...t.staticPrimaryKey],
    primaryKeySource: t.staticPrimaryKeySource,
  };
}

function entryOf(d: Draft, serialized: ReadonlySet<string>): TableEntry {
  const siteId = d.columns.find((c) => c.name.toLowerCase() === 'siteid');
  const pk = d.primaryKey;
  const facts: GoverningFacts = {
    columns: d.columns,
    hasSiteId: siteId !== undefined,
    siteIdColumn: siteId?.name ?? null,
    siteIdSource: siteId?.source ?? null,
    hasPrimaryKey: pk !== null,
    primaryKey: pk?.columns ?? [],
    primaryKeySource: pk !== null && pk.source.path !== d.source.path ? pk.source : null,
  };
  return {
    id: `tbl:${d.table}`,
    table: d.table,
    schema: d.schema,
    origin: d.origin,
    source: d.source,
    createdBy: d.createdBy,
    otherDialects: [...d.otherDialects].sort(
      (a, b) => compareText(a.dialect, b.dialect) || compareText(a.path, b.path) || a.lines[0] - b.lines[0],
    ),
    retired: d.droppedBy !== null,
    droppedBy: d.droppedBy,
    ...facts,
    ...staticOf(facts),
    bootstrapHasPrimaryKey: d.bootstrapHasPrimaryKey,
    serializedColumns: d.columns.filter((c) => serialized.has(c.name.toLowerCase())).map((c) => c.name),
    ormEntity: d.ormEntity,
    ...ownerDefaults(),
    writers: [],
    ...liveDefaults(),
  };
}

function byId(a: TableEntry, b: TableEntry): number {
  return compareText(a.id, b.id);
}

/** Compares the computed serialized columns with the expected ones; differing tables get `expectedSerializedColumns`. */
function serializedCorrection(entries: TableEntry[]): TableCorrection | null {
  const qualified = (table: string, cols: readonly string[]): string[] => cols.map((c) => `${table}.${c}`);
  const byKey = new Map(entries.map((e) => [tableKey(e.table), e]));
  const expectedFor = (key: string): string[] => {
    const entry = byKey.get(key);
    const names = EXPECTED_SERIALIZED_COLUMNS[key] ?? [];
    return names.map((n) => entry?.columns.find((c) => c.name.toLowerCase() === n.toLowerCase())?.name ?? n);
  };
  const lower = (cols: readonly string[]): string => cols.map((c) => c.toLowerCase()).sort(compareText).join(',');
  const keys = new Set([...Object.keys(EXPECTED_SERIALIZED_COLUMNS), ...entries.filter((e) => e.serializedColumns.length > 0).map((e) => tableKey(e.table))]);
  const expected: string[] = [];
  const computed: string[] = [];
  let differs = false;
  for (const key of [...keys].sort(compareText)) {
    const entry = byKey.get(key);
    const exp = expectedFor(key);
    const got = entry?.serializedColumns ?? [];
    expected.push(...qualified(entry?.table ?? key, exp));
    computed.push(...qualified(entry?.table ?? key, got));
    if (lower(exp) !== lower(got)) {
      differs = true;
      if (entry !== undefined) entry.expectedSerializedColumns = exp;
    }
  }
  return differs ? { measure: 'serializedColumns', expected, computed } : null;
}

/** Static `tables[]` from the bootstrap DDL, the ORM-only tables of `ormTables` and every schema update, with counts. */
export function extractTables(tree: SourceTree, ormTables: readonly string[]): TableExtraction {
  const drafts = bootstrapDrafts(tree);
  addOrmTables(ormTablesOf(tree, ormTables), drafts);
  applyUpdates(tree, drafts);
  const serialized = serializedColumnsOf(tree, drafts);
  const tables = [...drafts.values()].map((d) => entryOf(d, serialized.get(d.key) ?? new Set())).sort(byId);
  const correction = serializedCorrection(tables);
  const count = (test: (t: TableEntry) => boolean): number => tables.filter(test).length;
  const noPrimaryKeyBootstrap = tables.filter((t) => t.bootstrapHasPrimaryKey === false).map((t) => t.table);
  const noPrimaryKey = tables.filter((t) => !t.retired && t.hasPrimaryKey === false).map((t) => t.table);
  return {
    tables,
    counts: {
      bootstrap: count((t) => t.origin === 'bootstrap'),
      migration: count((t) => t.origin === 'migration'),
      orm: count((t) => t.origin === 'orm'),
      staticTotal: count((t) => !t.retired),
      retired: count((t) => t.retired),
      liveStatic: count((t) => !t.retired),
      withSiteId: count((t) => t.hasSiteId),
      withoutPrimaryKeyBootstrap: noPrimaryKeyBootstrap.length,
      withoutPrimaryKey: noPrimaryKey.length,
    },
    noPrimaryKeyBootstrap,
    noPrimaryKey,
    corrections: correction === null ? [] : [correction],
  };
}

/**
 * `tables[]` entries of the tables the fixture SQL scripts in `tree` create, each sourced at its `CREATE TABLE` line;
 * a per-program script's tables fold to one `Program_N` entry.
 */
export function extractFixtureTables(tree: SourceTree): TableEntry[] {
  const drafts = new Map<string, Draft>();
  const mssql = (): string[] => ['mssql'];
  for (const file of tree.list(FIXTURE_SQL_DIR, { ext: ['sql'], recursive: true })) {
    const text = blankSqlComments(tree.readText(file)).replaceAll(PROGRAM_SCHEMA_VAR, PROGRAM_SCHEMA_FOLD);
    let start = 0;
    for (const end of [...[...text.matchAll(/^[ \t]*GO[ \t]*\r?$/gim)].map((m) => m.index), text.length]) {
      for (const e of sqlSchemaEvents(text.slice(start, end), start, text, mssql)) applyEvent(drafts, e, file, 'fixture', []);
      start = end;
    }
  }
  return [...drafts.values()]
    .map((d) => ({ ...entryOf(d, new Set()), source: ref(d.source.path, d.source.lines[0], d.source.lines[0]) }))
    .sort(byId);
}


// Ownership

const keySpan = z.tuple([z.int().min(1), z.int().min(1)]);
const ownershipTarget = z.looseObject({ unit: z.string().min(1), owner: z.string().min(1) });

/** The parts of `opt2/table-ownership.json` the table inventory reads; other keys pass through. */
export const tableOwnershipSchema = z
  .looseObject({
    sourceSha: z.string(),
    units: z.array(z.looseObject({ unit: z.string().min(1), owner: z.string().min(1) })),
    tables: z.array(
      z.looseObject({
        table: z.string().min(1),
        owner: z.string().min(1),
        ruleSteps: z.array(z.int().min(1).max(5)),
        split: z.looseObject({ by: z.string().min(1) }).optional(),
        targets: z.array(ownershipTarget),
        decisionRef: z.string().min(1).optional(),
        source: z.looseObject({ path: z.string().min(1), lines: keySpan.nullable() }).optional(),
      }),
    ),
  })
  .superRefine((doc, ctx) => {
    const units = new Set(doc.units.map((u) => u.unit));
    const seen = new Set<string>();
    doc.tables.forEach((t, i) => {
      const key = tableKey(t.table);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate table ${t.table}`, path: ['tables', i, 'table'] });
      seen.add(key);
      t.targets.forEach((target, j) => {
        if (!units.has(target.unit)) {
          ctx.addIssue({ code: 'custom', message: `unit ${target.unit} is not listed in units`, path: ['tables', i, 'targets', j, 'unit'] });
        }
      });
    });
  });

/** A validated ownership file. */
export type TableOwnership = z.infer<typeof tableOwnershipSchema>;

/** Reads and validates the ownership file and checks its `sourceSha` against the source pin. */
export async function loadTableOwnership(path: string = TABLE_OWNERSHIP_PATH): Promise<TableOwnership> {
  const doc = await readJson(path, tableOwnershipSchema);
  const sha = pinnedSha();
  if (doc.sourceSha !== sha) {
    throw new Error(`${repoPath(path)}: sourceSha ${JSON.stringify(doc.sourceSha)} differs from the pinned SHA ${sha}`);
  }
  return doc;
}

/** Sets each table's owner, rule steps and target units from the ownership file; throws naming every table it does not assign. */
export function assignOwners(tables: readonly TableEntry[], ownership: TableOwnership): TableEntry[] {
  const exact = new Map(ownership.tables.map((t) => [tableKey(t.table), t]));
  const patterns = ownership.tables
    .filter((t) => t.table.endsWith('*'))
    .map((t) => ({ prefix: tableKey(t.table.slice(0, -1)), entry: t }));
  const declared = exact.get(tableKey(DECLARED_ENTITY_PATTERN));
  const missing: string[] = [];
  const out = tables.map((t): TableEntry => {
    const key = tableKey(t.table);
    const entry =
      exact.get(key) ?? patterns.find((p) => key.startsWith(p.prefix))?.entry ?? (t.origin === 'dynamic' ? declared : undefined);
    if (entry === undefined) {
      missing.push(t.table);
      return t;
    }
    const lines = entry.source?.lines;
    const source = t.source.path === LIVE_TABLE_SOURCE.path && entry.source !== undefined && lines ? ref(entry.source.path, lines[0], lines[1]) : t.source;
    return {
      ...t,
      source,
      owningService: entry.owner,
      ownershipRuleStep: [...entry.ruleSteps],
      targetUnits: entry.targets.map((target) => target.unit),
      split: entry.split ?? null,
      decisionListRef: entry.decisionRef ?? null,
    };
  });
  if (missing.length > 0) throw new Error(`table ownership assigns no owner to ${missing.sort(compareText).join(', ')}`);
  return out;
}

// Writers

interface WriterAcc {
  entry: WriterEntry;
  unconditional: boolean;
  conditions: Set<string>;
  overrideCondition: string | null;
}

function sameLines(a: SourceRef, b: SourceRef): boolean {
  return a.lines[0] === b.lines[0] && a.lines[1] === b.lines[1];
}

function writerKey(w: Pick<WriterEntry, 'component' | 'method' | 'source' | 'op' | 'trigger'>): string {
  return JSON.stringify([w.component, w.method, w.source.path, w.source.lines[0], w.source.lines[1], w.op, w.trigger]);
}

function methodName(method: string | null): string {
  return method === null || method === '' ? TEMPLATE_METHOD : method;
}

function scopeOf(keyScope: WriterOverride['keyScope']): string[] {
  return keyScope === TABLE_SCOPE ? [TABLE_SCOPE] : keyScope.map((k) => k.toLowerCase());
}

function conditionOf(acc: WriterAcc): string | null {
  if (acc.overrideCondition !== null) return acc.overrideCondition;
  if (acc.unconditional || acc.conditions.size === 0) return null;
  return [...acc.conditions].sort(compareText).join(' || ');
}

/** Replaces an extracted writer's reviewable fields with the override's; a `request` override keeps the reached trigger. */
function applyOverride(acc: WriterAcc, o: WriterOverride, routeKeys: readonly string[]): void {
  const e = acc.entry;
  e.op = o.op;
  e.keyScope = scopeOf(o.keyScope);
  if (o.trigger !== 'request') e.trigger = o.trigger;
  e.sessionEffects = o.sessionEffects;
  e.override = o.id;
  e.routeKeys = [...new Set([...e.routeKeys, ...routeKeys])];
  if (o.condition !== undefined) acc.overrideCondition = o.condition;
  if (o.columns !== undefined) e.columns = [...o.columns];
  if (o.preventedBy !== undefined) e.preventedBy = o.preventedBy;
  if (o.noGroupJoin !== undefined) e.noGroupJoin = o.noGroupJoin;
  if (o.dynamic !== undefined) e.dynamic = o.dynamic;
}

function overrideWriter(o: WriterOverride, routeKeys: readonly string[]): WriterAcc {
  const acc: WriterAcc = {
    entry: {
      component: o.component,
      method: methodName(o.method),
      source: o.source,
      op: o.op,
      routeKeys: [],
      keyScope: [],
      trigger: o.trigger,
      sessionEffects: o.sessionEffects,
      condition: null,
      override: null,
    },
    unconditional: true,
    conditions: new Set(),
    overrideCondition: null,
  };
  applyOverride(acc, o, routeKeys);
  return acc;
}

/** Folds writers that became equal under overrides: route keys and conditions union, a set override wins. */
function regroup(accs: Iterable<WriterAcc>): WriterAcc[] {
  const merged = new Map<string, WriterAcc>();
  for (const acc of accs) {
    const key = writerKey(acc.entry);
    const prev = merged.get(key);
    if (prev === undefined) {
      merged.set(key, acc);
      continue;
    }
    prev.entry.routeKeys = [...new Set([...prev.entry.routeKeys, ...acc.entry.routeKeys])];
    prev.unconditional ||= acc.unconditional;
    for (const c of acc.conditions) prev.conditions.add(c);
    if (prev.entry.override === null && acc.entry.override !== null) {
      prev.entry = { ...acc.entry, routeKeys: prev.entry.routeKeys };
      prev.overrideCondition = acc.overrideCondition;
    }
  }
  return [...merged.values()];
}

function compareWriters(a: WriterEntry, b: WriterEntry): number {
  return (
    compareText(a.component, b.component) ||
    compareText(a.method, b.method) ||
    compareText(a.source.path, b.source.path) ||
    a.source.lines[0] - b.source.lines[0] ||
    compareText(a.op, b.op) ||
    a.source.lines[1] - b.source.lines[1] ||
    compareText(a.trigger, b.trigger) ||
    compareText(a.override ?? '', b.override ?? '')
  );
}

/** Sets every table's `writers[]` from the entry points' write closures and the writer overrides; returns writes of unknown tables. */
export function attachWriters(
  tables: readonly TableEntry[],
  writeEvidence: readonly WriteEvidence[],
  overrides: WriterOverrides,
  entryPoints: WriterEntryPoints = { jobs: [] },
): AttachedWriters {
  const known = new Set(tables.map((t) => tableKey(t.table)));
  const byTable = new Map<string, Map<string, WriterAcc>>();
  const unmatched = new Map<string, UnmatchedWrite>();
  const miss = (u: UnmatchedWrite): void => {
    unmatched.set(JSON.stringify([tableKey(u.table), u.component, u.method, u.source, u.override]), u);
  };
  const writersOf = (key: string): Map<string, WriterAcc> => {
    let writers = byTable.get(key);
    if (writers === undefined) {
      writers = new Map();
      byTable.set(key, writers);
    }
    return writers;
  };

  for (const ev of writeEvidence) {
    for (const w of ev.closure.writes) {
      if (w.table === null) continue;
      const key = tableKey(w.table);
      const method = methodName(w.method);
      if (!known.has(key)) {
        miss({ table: w.table, component: w.component, method, source: w.source, override: w.override ?? null });
        continue;
      }
      const trigger = w.trigger === 'request' ? ev.trigger : w.trigger;
      const draft: WriterEntry = {
        component: w.component,
        method,
        source: w.source,
        op: w.op,
        routeKeys: [],
        keyScope: trigger === 'request' && w.whereParams.length > 0 ? [...w.whereParams] : [TABLE_SCOPE],
        trigger,
        // A closure's session effect belongs to its entry point, which records it itself; the gateway unions writer
        // effects over every route key a writer carries, so only a reviewed override sets a writer's effect.
        sessionEffects: 'none',
        condition: null,
        override: w.override ?? null,
      };
      const writers = writersOf(key);
      const id = writerKey(draft);
      const acc = writers.get(id) ?? { entry: draft, unconditional: false, conditions: new Set<string>(), overrideCondition: null };
      writers.set(id, acc);
      if (ev.entryRouteKey !== null) acc.entry.routeKeys.push(ev.entryRouteKey);
      if (acc.entry.override === null && w.override !== undefined) acc.entry.override = w.override;
      if (!w.conditional) {
        acc.unconditional = true;
      } else {
        const guard = ev.closure.conditionalWrites.find(
          (c) => tableKey(c.table) === key && c.source.path === w.source.path && sameLines(c.source, w.source),
        );
        if (guard !== undefined) acc.conditions.add(guard.condition);
      }
    }
  }

  const jobTables = new Map(entryPoints.jobs.map((j) => [j.id, [...new Set(j.steps.flatMap((s) => s.tables))].sort(compareText)]));
  for (const o of overrides.writers) {
    let targets: readonly string[];
    if (o.tables !== undefined) {
      targets = o.tables;
    } else {
      const fromJob = jobTables.get(o.tablesFrom.job);
      if (fromJob === undefined) throw new Error(`writer override ${o.id} takes its tables from ${o.tablesFrom.job}, which no entry point lists`);
      targets = fromJob;
    }
    const routeKeys = o.routeKeys.map(normaliseInventoryKey);
    const method = methodName(o.method);
    for (const table of targets) {
      const key = tableKey(table);
      if (!known.has(key)) {
        miss({ table, component: o.component, method, source: o.source, override: o.id });
        continue;
      }
      const writers = writersOf(key);
      const matched = [...writers.values()].filter(
        (a) => a.entry.override === o.id || (a.entry.component === o.component && a.entry.method === method && sameLines(a.entry.source, o.source)),
      );
      if (matched.length === 0) {
        const acc = overrideWriter(o, routeKeys);
        writers.set(`${o.id}\n${writerKey(acc.entry)}`, acc);
      } else {
        for (const acc of matched) applyOverride(acc, o, routeKeys);
      }
    }
  }

  const out = tables.map((t): TableEntry => {
    const accs = regroup(byTable.get(tableKey(t.table))?.values() ?? []);
    const writers = accs
      .map((acc) => ({ ...acc.entry, routeKeys: [...new Set(acc.entry.routeKeys)].sort(compareText), condition: conditionOf(acc) }))
      .sort(compareWriters);
    return { ...t, writers };
  });
  const misses = [...unmatched.values()].sort(
    (a, b) =>
      compareText(tableKey(a.table), tableKey(b.table)) ||
      compareText(a.component, b.component) ||
      compareText(a.method, b.method) ||
      compareText(a.source.path, b.source.path) ||
      a.source.lines[0] - b.source.lines[0] ||
      compareText(a.override ?? '', b.override ?? ''),
  );
  return { tables: out, unmatched: misses };
}

// Live catalog

const LIVE_TABLES_SQL = `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`;
const LIVE_COLUMNS_SQL =
  'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, ORDINAL_POSITION ' +
  'FROM INFORMATION_SCHEMA.COLUMNS';
const LIVE_KEYS_SQL =
  'SELECT tc.TABLE_SCHEMA, tc.TABLE_NAME, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION ' +
  'FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc ' +
  'JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS kcu ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA ' +
  'AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA AND kcu.TABLE_NAME = tc.TABLE_NAME ' +
  `WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`;

const liveName = { TABLE_SCHEMA: z.string().min(1), TABLE_NAME: z.string().min(1) };
const liveTableRows = z.array(z.looseObject(liveName));
const liveColumnRows = z.array(
  z.looseObject({
    ...liveName,
    COLUMN_NAME: z.string().min(1),
    DATA_TYPE: z.string().min(1),
    CHARACTER_MAXIMUM_LENGTH: z.int().nullable(),
    IS_NULLABLE: z.enum(['YES', 'NO']),
    ORDINAL_POSITION: z.int(),
  }),
);
const liveKeyRows = z.array(z.looseObject({ ...liveName, COLUMN_NAME: z.string().min(1), ORDINAL_POSITION: z.int() }));

async function liveRows<T>(db: ReadOnlyMssql, sql: string, schema: z.ZodType<T>, label: string): Promise<T> {
  const parsed = schema.safeParse(await db.readOnlyQuery(sql));
  if (!parsed.success) throw new Error(`live catalog ${label} rows are malformed:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Base tables of the legacy database with their columns and primary keys, outside OPT-2's coordination schema. */
export async function fetchLiveCatalog(db: ReadOnlyMssql): Promise<LiveCatalogTable[]> {
  const tables = await liveRows(db, LIVE_TABLES_SQL, liveTableRows, 'table');
  const columns = await liveRows(db, LIVE_COLUMNS_SQL, liveColumnRows, 'column');
  const keys = await liveRows(db, LIVE_KEYS_SQL, liveKeyRows, 'primary-key');
  const id = (r: { TABLE_SCHEMA: string; TABLE_NAME: string }): string => `${r.TABLE_SCHEMA}\n${r.TABLE_NAME}`;
  const byId = new Map<string, LiveCatalogTable>();
  for (const r of tables) {
    if (COORDINATION_SCHEMAS.has(r.TABLE_SCHEMA.toLowerCase())) continue;
    byId.set(id(r), { schema: r.TABLE_SCHEMA, name: r.TABLE_NAME, columns: [], primaryKey: [], hasPrimaryKey: false, hasSiteId: false });
  }
  for (const r of [...columns].sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION)) {
    const length = r.CHARACTER_MAXIMUM_LENGTH;
    byId.get(id(r))?.columns.push({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE.toLowerCase(),
      length: length === null ? null : length === -1 ? 'max' : length,
      nullable: r.IS_NULLABLE === 'YES',
    });
  }
  for (const r of [...keys].sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION)) byId.get(id(r))?.primaryKey.push(r.COLUMN_NAME);
  return [...byId.values()]
    .map((t) => ({
      ...t,
      hasPrimaryKey: t.primaryKey.length > 0,
      hasSiteId: t.columns.some((c) => c.name.toLowerCase() === 'siteid'),
    }))
    .sort((a, b) => compareText(a.schema, b.schema) || compareText(a.name, b.name));
}

function liveState(instances: readonly LiveCatalogTable[]): LiveTableState {
  const present = instances.length > 0;
  const columns: string[] = [];
  for (const i of instances) for (const c of i.columns) if (!columns.some((n) => n.toLowerCase() === c.name.toLowerCase())) columns.push(c.name);
  return {
    present,
    instances: instances.map((i) => `${i.schema}.${i.name}`).sort(compareText),
    columns,
    primaryKey: instances[0]?.primaryKey ?? [],
    hasPrimaryKey: present ? instances.every((i) => i.hasPrimaryKey) : null,
    hasSiteId: present ? instances.every((i) => i.hasSiteId) : null,
  };
}

function liveOrigin(schema: string, key: string, declared: ReadonlySet<string>): TableOrigin {
  if (FIXTURE_SCHEMA.test(schema)) return 'fixture';
  return key.startsWith('fb_') || declared.has(key) ? 'dynamic' : 'live-only';
}

/**
 * Governing facts of a table the live catalog holds: the union of its instances' columns in catalog order, each
 * sourced at its static declaration when `base` has one; the key when every instance has one; the siteID column when
 * every instance has one. A key differing from `base`'s is sourced at the catalog unless `ownSource` already is.
 */
function liveFacts(instances: readonly LiveCatalogTable[], state: LiveTableState, base: GoverningFacts, ownSource: SourceRef): GoverningFacts {
  const lower = (name: string): string => name.toLowerCase();
  const columns: TableColumn[] = [];
  for (const i of instances) {
    for (const c of i.columns) {
      if (columns.some((n) => lower(n.name) === lower(c.name))) continue;
      columns.push({ ...c, source: base.columns.find((s) => lower(s.name) === lower(c.name))?.source ?? LIVE_TABLE_SOURCE });
    }
  }
  const siteId = state.hasSiteId === true ? columns.find((c) => lower(c.name) === 'siteid') : undefined;
  const primaryKey = state.hasPrimaryKey === true ? [...state.primaryKey] : [];
  const sameKey = primaryKey.length === base.primaryKey.length && primaryKey.every((c, n) => lower(c) === lower(base.primaryKey[n] ?? ''));
  return {
    columns,
    hasSiteId: siteId !== undefined,
    siteIdColumn: siteId?.name ?? null,
    siteIdSource: siteId?.source ?? null,
    hasPrimaryKey: state.hasPrimaryKey,
    primaryKey,
    primaryKeySource: sameKey ? base.primaryKeySource : primaryKey.length > 0 && ownSource.path !== LIVE_TABLE_SOURCE.path ? LIVE_TABLE_SOURCE : null,
  };
}

/** Static facts of a table no static source declares. */
const NO_STATIC_FACTS: GoverningFacts = Object.freeze({
  columns: [],
  hasSiteId: false,
  siteIdColumn: null,
  siteIdSource: null,
  hasPrimaryKey: null,
  primaryKey: [],
  primaryKeySource: null,
}) as GoverningFacts;

/** An entry for a table the live catalog alone shows; `Program_<id>` instances fold into one `Program_N` entry. */
function liveOnlyEntry(key: string, instances: readonly LiveCatalogTable[], declared: ReadonlySet<string>): TableEntry {
  const first = instances[0] as LiveCatalogTable;
  const table = tableName(first.schema, first.name);
  const state = liveState(instances);
  return {
    id: `tbl:${table}`,
    table,
    schema: schemaOf(table),
    origin: liveOrigin(first.schema, key, declared),
    source: LIVE_TABLE_SOURCE,
    createdBy: [],
    otherDialects: [],
    retired: false,
    droppedBy: null,
    ...liveFacts(instances, state, NO_STATIC_FACTS, LIVE_TABLE_SOURCE),
    ...staticOf(NO_STATIC_FACTS),
    staticHasSiteId: null,
    bootstrapHasPrimaryKey: null,
    serializedColumns: [],
    ormEntity: null,
    ...ownerDefaults(),
    writers: [],
    live: state,
    liveStatus: 'live',
  };
}

/**
 * Merges the live catalog, whose columns, key and siteID facts govern each table it holds, and adds live-only tables;
 * `null` restores the static facts pending a live run. Merge before {@link attachWriters} and {@link assignOwners},
 * so live-only tables get writers and owners.
 */
export function mergeLiveCatalog(
  tables: readonly TableEntry[],
  live: readonly LiveCatalogTable[] | null,
  opts: { declaredEntityTables?: readonly string[] } = {},
): TableEntry[] {
  if (live === null) {
    return tables
      // Fixture SQL creates a fixture entry; the live catalog alone creates one with no createdBy.
      .filter((t) => STATIC_ORIGINS.has(t.origin) || (t.origin === 'fixture' && t.createdBy.length > 0))
      .map((t) => ({ ...t, ...staticFacts(t), ...liveDefaults() }))
      .sort(byId);
  }
  const declared = new Set((opts.declaredEntityTables ?? []).map(tableKey));
  const instances = new Map<string, LiveCatalogTable[]>();
  for (const l of live) {
    const key = tableKey(tableName(l.schema, l.name));
    instances.set(key, [...(instances.get(key) ?? []), l]);
  }
  const known = new Set<string>();
  const merged = tables.map((t): TableEntry => {
    const key = tableKey(t.table);
    known.add(key);
    const group = instances.get(key) ?? [];
    const state = liveState(group);
    const facts = state.present ? liveFacts(group, state, staticFacts(t), t.source) : staticFacts(t);
    return { ...t, ...facts, live: state, liveStatus: 'live' };
  });
  for (const [key, group] of instances) if (!known.has(key)) merged.push(liveOnlyEntry(key, group, declared));
  return merged.sort(byId);
}

