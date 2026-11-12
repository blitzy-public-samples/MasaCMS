/** Collects a scenario's side effects (mail, stored rows, scheduled tasks, stored file variants) on its origin for the normaliser. */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';
import { parse } from 'yaml';
import {
  MAX_EXPORT_LIMIT,
  MIGRATION_PATH_PREFIX,
  canonicalTypeForSqlServer,
  compareEncodings,
  decodeRow,
  encodeRow,
  formatCanonicalTimestamp,
  isApplied,
  sha256Hex,
  type CanonicalColumn,
  type CanonicalValue,
  type ExportResponse,
  type PositionResponse,
} from '@opt2/platform/migration-kit';
import { baseEnvSchema, envUrl, optionalEnvString, z } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  SERVICES,
  SETTLE_KINDS,
  type RowSpec,
  type Scenario,
  type SettleKind,
  type SettleSpec,
  type Step,
  type TaskSpec,
} from './catalogue.js';
import { resolvePlaceholders, session, type Origin, type ScenarioContext } from './session.js';
import { GoldenConfigError } from './errors.js';
import { createHttpSession, type FetchLike, type HttpResult, type HttpSession } from '../lib/http.js';
import { createReadOnlyMssql, type ReadOnlyMssql } from '../lib/mssql.js';
import { createHarnessInvoker, type HarnessInvoker } from '../lib/invocation.js';
import { opt2Path, repoPath, type EnvLike } from '../lib/paths.js';
import { CutoverRequestFailed, cutoverStatus } from '../repro/cutover.js';

export type { RowSpec, TaskSpec } from './catalogue.js';

/** Mailpit API base when `MAILPIT_API_URL` is unset. */
export const DEFAULT_MAILPIT_URL = 'http://127.0.0.1:8025';

/** Bound of a settle wait whose caller names none, and of the mail wait before collecting mail. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;

/** Quiet period that ends a mail wait: one ColdFusion mail-spool interval (15 s default), so a later spool run is not missed. */
export const MAIL_QUIET_MS = 15_000;

/** Quiet period that ends a scheduled-task wait. */
export const TASKS_QUIET_MS = 3_000;

/** Interval between the reads of a settle wait. */
export const SETTLE_POLL_MS = 1_000;

/** Stored file variants (fileDAO.cfc:153-199); `_source` has no render route, so `collectFiles` never yields it. */
export type FileVariantName = 'original' | '_source' | '_small' | '_medium';

/** Render routes per collected variant, in recording order (contentServer.cfc:655-668). */
export const RENDER_VARIANTS: ReadonlyArray<readonly [name: FileVariantName, size: string]> = [
  ['original', 'file'],
  ['_small', 'small'],
  ['_medium', 'medium'],
];

const MAILPIT_PAGE = 250;
const RECEIPT_CHUNK = 100;
const IN_LIST_CHUNK = 500;
const PUSH_PATH_PREFIX = '/internal/v1/events/';
const SURVEYS_PATH = '/legacy-fixtures/cfml/api.cfm/surveys/surveys/';
const SCHEDULE_PATH = /^\/legacy-fixtures\/cfml\/api\.cfm\/surveys\/surveys\/([^/]+)\/schedule\/?$/;
const LAUNCH_TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const MATRIX_PLACEHOLDER = /\$\{matrix\./;
const PROGRAM_TABLE = /^\[?Program_(\d+)\]?\.\[?([A-Za-z_]\w*)\]?$/i;
const FILE_ID_BINDING = 'fileid';
const SITE_COLUMN = 'siteid';

/** One Mailpit message as compared: addresses as `Name <address>` or the bare address, headers as Mailpit lists them. */
export interface MailMessage {
  to: string[];
  from: string;
  subject: string;
  text: string;
  /** Text content of the HTML body. */
  htmlText: string;
  headers: Record<string, string[]>;
}

/** Canonical rows of one target unit within a scenario's row scopes; `rows` are `encodeRow` encodings sorted bytewise. */
export interface RowSnapshot {
  unit: string;
  owner: string;
  /** The legacy table as `opt2/table-ownership.json` names it, e.g. `tusers` or `Program_N.blackout`. */
  legacyTable: string;
  columns: CanonicalColumn[];
  keyColumns: string[];
  keyless: boolean;
  rows: string[];
}

/** One scheduled task; `scheduledAt` and `base` are zone-less wall-clock `YYYY-MM-DDTHH:MM:SS`. */
export interface TaskRecord {
  name: string;
  kind: string;
  target: string;
  scheduledAt: string;
  /** The scheduling request's launch time, which offsets are taken from. */
  base: string;
}

/** One stored file variant that answered 200 on its render route. */
export interface FileVariant {
  fileId: string;
  name: FileVariantName;
  contentType: string;
  sha256: string;
  size: number;
}

/** Side effects of one scenario run; `rows` is the origin's own snapshot (target on the gateway). */
export interface SideEffects {
  mail: MailMessage[];
  rows: Record<string, RowSnapshot>;
  tasks: TaskRecord[];
  files: FileVariant[];
  /** Gateway origin only: legacy rows after replay, which the reverse projector writes once a unit cuts over. */
  legacyRows?: Record<string, RowSnapshot>;
}

/** Side-effect variables of the environment: the `OPT2_SERVICE_URLS` map and the Mailpit API base, blank counting as unset. */
export const sideEffectEnvSchema = z.object({
  OPT2_SERVICE_URLS: baseEnvSchema.shape.OPT2_SERVICE_URLS,
  MAILPIT_API_URL: optionalEnvString(envUrl()).transform((url) => url ?? DEFAULT_MAILPIT_URL),
});

/** Validated side-effect configuration; URLs carry no trailing slash. */
export interface SideEffectConfig {
  /** Service base URLs by service name. */
  serviceUrls: Readonly<Record<string, string>>;
  mailpitUrl: string;
}

/** Parses `env` into a {@link SideEffectConfig}; throws GoldenConfigError naming each invalid variable path. */
export function resolveSideEffectConfig(env: EnvLike = process.env): SideEffectConfig {
  const parsed = sideEffectEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new GoldenConfigError(`invalid side-effect configuration: ${issues.join('; ')}`);
  }
  return { serviceUrls: parsed.data.OPT2_SERVICE_URLS, mailpitUrl: parsed.data.MAILPIT_API_URL };
}

/** Injectable collaborators; absent ones are created from the scenario environment and released afterwards. */
export interface SideEffectDeps {
  /** Resolved configuration; else parsed from the scenario environment once per call or hook. */
  config?: SideEffectConfig;
  fetch?: FetchLike;
  /** Caller-owned legacy client; never closed here. */
  mssql?: ReadOnlyMssql;
  invoker?: HarnessInvoker;
  ownership?: TableOwnership;
  /** Cut-over groups; else `gateway/cutover/groups.json`. */
  groups?: CutoverGroups;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Bound of the mail wait `collectSideEffects` runs before reading Mailpit. */
  mailTimeoutMs?: number;
}

/** Waits for a declared side effect: `(spec, timeoutMs)`, where `spec` is a settle kind optionally followed by `:<target>`. */
export type SettleHook = (spec: SettleSpec, timeoutMs: number) => Promise<void>;

/** A remote answered a side-effect read unexpectedly; the message names the call and status, never a body. */
export class SideEffectError extends Error {
  override readonly name: string = 'SideEffectError';
}

/** A settle wait reached its bound with its condition unmet. */
export class SettleTimeoutError extends SideEffectError {
  override readonly name: string = 'SettleTimeoutError';
}

/** A row scope holds fewer legacy rows after capture than its `minRows`. */
export class MissingRowsError extends SideEffectError {
  override readonly name: string = 'MissingRowsError';
}

/** One target of a legacy table in `opt2/table-ownership.json`. */
export interface OwnershipTarget {
  unit: string;
  owner: string;
  rowPredicate: string | null;
  keyColumns: string[];
  ownedColumns: string[];
}

/** One `split.classMap` entry: classes owned directly (`owner`) or decided by stored data (`ownerBy`). */
export interface ClassMapEntry {
  classes: string[];
  owner?: string;
  ownerBy?: string;
}

/** How a shared table's rows are divided among its targets. */
export interface OwnershipSplit {
  by?: string;
  parent?: { table: string; join: string };
  addressJoin?: string;
  resolve?: string;
  classMap?: ClassMapEntry[];
}

/** One legacy table of `opt2/table-ownership.json`. */
export interface OwnershipTable {
  table: string;
  schema: string;
  owner: string;
  rowIdentity: 'key' | 'multiset' | null;
  pattern?: boolean;
  split?: OwnershipSplit | null;
  targets: OwnershipTarget[];
}

/** One unit of write authority and its owner. */
export interface OwnershipUnit {
  unit: string;
  owner: string;
}

/** The parts of `opt2/table-ownership.json` this module reads. */
export interface TableOwnership {
  tables: OwnershipTable[];
  units: OwnershipUnit[];
}

/** One group of `gateway/cutover/groups.json`: the units sharing one write authority. */
export interface CutoverGroup {
  id: string;
  units: string[];
}

/** The parts of `gateway/cutover/groups.json` this module reads. */
export interface CutoverGroups {
  groups: CutoverGroup[];
}

/** A row scope with its placeholders resolved. */
export type ResolvedRowSpec = RowSpec;

type Scalar = string | number | boolean;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function headerText(result: HttpResult, name: string): string {
  const value = result.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** JSON body of a 200 answer; anything else is a SideEffectError naming `what`. */
function okJson<T>(result: HttpResult, what: string): T {
  if (result.status !== 200) throw new SideEffectError(`${what} answered ${result.status}`);
  return result.json<T>();
}

/** Base URL of service `name` from the resolved `OPT2_SERVICE_URLS` map. */
export function serviceUrl(config: SideEffectConfig, name: string): string {
  const url = Object.hasOwn(config.serviceUrls, name) ? config.serviceUrls[name] : undefined;
  if (url === undefined) {
    throw new GoldenConfigError(
      `OPT2_SERVICE_URLS has no URL for ${name}; harness/src/repro/ports.ts --service-urls prints the local map`,
    );
  }
  return url;
}

interface Clock {
  sleep(ms: number): Promise<void>;
  now(): number;
}

function clockOf(deps: Pick<SideEffectDeps, 'sleep' | 'now'>): Clock {
  return { sleep: deps.sleep ?? ((ms) => delay(ms)), now: deps.now ?? Date.now };
}

/**
 * Reads until `ready` holds and the value has not changed for `quietMs`, or until `timeoutMs` has passed;
 * returns the last value either way.
 */
async function waitUntilQuiet<T>(
  read: () => Promise<T>,
  opts: { timeoutMs: number; quietMs: number; ready: (value: T) => boolean; key: (value: T) => string; clock: Clock },
): Promise<T> {
  const { clock } = opts;
  const deadline = clock.now() + opts.timeoutMs;
  let last = await read();
  let since = clock.now();
  for (;;) {
    const now = clock.now();
    if ((opts.ready(last) && now - since >= opts.quietMs) || now >= deadline) return last;
    await clock.sleep(Math.min(SETTLE_POLL_MS, deadline - now));
    const next = await read();
    if (opts.key(next) !== opts.key(last)) {
      last = next;
      since = clock.now();
    }
  }
}

// --- Mail ---------------------------------------------------------------------------------------------------------

interface MailpitAddress {
  Name?: string | null;
  Address?: string | null;
}

interface MailpitList {
  total: number;
  messages: { ID: string }[];
}

interface MailpitMessage {
  From?: MailpitAddress | null;
  To?: MailpitAddress[] | null;
  Subject?: string | null;
  Text?: string | null;
  HTML?: string | null;
}

type MailDeps = Pick<SideEffectDeps, 'fetch' | 'config'>;

function mailpit(env: EnvLike, deps: MailDeps): HttpSession {
  return createHttpSession({ baseUrl: (deps.config ?? resolveSideEffectConfig(env)).mailpitUrl, fetch: deps.fetch });
}

async function mailPage(s: HttpSession, start: number, limit: number): Promise<MailpitList> {
  const query = { start: String(start), limit: String(limit) };
  const list = okJson<Partial<MailpitList>>(await s.get('/api/v1/messages', { query }), 'Mailpit message list');
  if (typeof list.total !== 'number' || !Array.isArray(list.messages)) {
    throw new SideEffectError('Mailpit message list carries no total or messages');
  }
  return { total: list.total, messages: list.messages };
}

/** Messages Mailpit holds. */
export async function mailCount(env: EnvLike = process.env, deps: MailDeps = {}): Promise<number> {
  return (await mailPage(mailpit(env, deps), 0, 1)).total;
}

/** Deletes every Mailpit message, then requires the list to report 0; run before capture, before replay and between scenarios. */
export async function resetMailpit(env: EnvLike = process.env, deps: MailDeps = {}): Promise<void> {
  const s = mailpit(env, deps);
  const deleted = await s.request({ method: 'DELETE', path: '/api/v1/messages' });
  if (deleted.status !== 200) throw new SideEffectError(`Mailpit DELETE /api/v1/messages answered ${deleted.status}`);
  const { total } = await mailPage(s, 0, 1);
  if (total !== 0) throw new SideEffectError(`Mailpit still holds ${total} messages after DELETE /api/v1/messages`);
}

function address(entry: MailpitAddress | null | undefined): string {
  const addr = entry?.Address ?? '';
  const name = entry?.Name ?? '';
  return name === '' ? addr : `${name} <${addr}>`;
}

/** Text content of an HTML body; a fragment is read as a body. */
function htmlBodyText(html: string): string {
  return html === '' ? '' : load(html)('body').text();
}

/** Every Mailpit message with its headers, sorted by subject, then first recipient; header dropping is the normaliser's. */
export async function collectMail(env: EnvLike = process.env, deps: MailDeps = {}): Promise<MailMessage[]> {
  const s = mailpit(env, deps);
  const ids: string[] = [];
  for (let start = 0; ; ) {
    const page = await mailPage(s, start, MAILPIT_PAGE);
    ids.push(...page.messages.map((m) => m.ID));
    start += page.messages.length;
    if (page.messages.length === 0 || start >= page.total) break;
  }
  const messages: MailMessage[] = [];
  for (const id of ids) {
    const path = `/api/v1/message/${encodeURIComponent(id)}`;
    const message = okJson<MailpitMessage>(await s.get(path), `Mailpit message ${id}`);
    const headers = okJson<Record<string, string[]>>(await s.get(`${path}/headers`), `Mailpit headers of ${id}`);
    messages.push({
      to: (message.To ?? []).map(address),
      from: address(message.From),
      subject: message.Subject ?? '',
      text: message.Text ?? '',
      htmlText: htmlBodyText(message.HTML ?? ''),
      headers,
    });
  }
  const order = (m: MailMessage): [string, string] => [m.subject, m.to[0] ?? ''];
  return messages.sort((a, b) => {
    const [sa, ra] = order(a);
    const [sb, rb] = order(b);
    return sa < sb ? -1 : sa > sb ? 1 : ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

/** Waits until Mailpit holds mail and its count has not grown for {@link MAIL_QUIET_MS}, or `timeoutMs`; returns the count. */
export async function waitForMail(
  env: EnvLike,
  timeoutMs: number,
  deps: Pick<SideEffectDeps, 'fetch' | 'config' | 'sleep' | 'now'> = {},
): Promise<number> {
  const mail: MailDeps = { fetch: deps.fetch, config: deps.config ?? resolveSideEffectConfig(env) };
  return waitUntilQuiet(() => mailCount(env, mail), {
    timeoutMs,
    quietMs: MAIL_QUIET_MS,
    ready: (count) => count > 0,
    key: String,
    clock: clockOf(deps),
  });
}

// --- Table ownership ------------------------------------------------------------------------------------------------

/** Reads `opt2/table-ownership.json`; throws GoldenConfigError when it cannot be read or lacks `tables` and `units`. */
export async function loadTableOwnership(path: string = opt2Path('table-ownership.json')): Promise<TableOwnership> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    throw new GoldenConfigError(`table ownership ${path} cannot be read: ${(err as Error).message}`, { path, cause: err });
  }
  const record = asRecord(doc);
  if (!Array.isArray(record?.tables) || !Array.isArray(record?.units)) {
    throw new GoldenConfigError(`table ownership ${path} has no tables and units arrays`, { path });
  }
  return { tables: record.tables as OwnershipTable[], units: record.units as OwnershipUnit[] };
}

const cutoverGroupsSchema = z.object({ groups: z.array(z.object({ id: z.string(), units: z.array(z.string()) })) });

/** Reads `gateway/cutover/groups.json`; throws GoldenConfigError when it cannot be read or lacks groups of ids and units. */
export async function loadCutoverGroups(path: string = repoPath('gateway', 'cutover', 'groups.json')): Promise<CutoverGroups> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    throw new GoldenConfigError(`cut-over groups ${path} cannot be read: ${(err as Error).message}`, { path, cause: err });
  }
  const parsed = cutoverGroupsSchema.safeParse(doc);
  if (!parsed.success) throw new GoldenConfigError(`cut-over groups ${path} has no groups of ids and units`, { path });
  return parsed.data;
}

/** A legacy table as read: its physical schema and name, its `Program_<n>` id, and its ownership entry. */
interface LegacyTableRef {
  schema: string;
  table: string;
  programId?: number;
  entry: OwnershipTable;
}

function lower(text: string): string {
  return text.toLowerCase();
}

/** Ownership entry and physical location of `name` (`tusers`, `synthetic.survey`, `Program_1.blackout`). */
function resolveLegacyTable(ownership: TableOwnership, name: string): LegacyTableRef {
  const program = PROGRAM_TABLE.exec(name);
  const dot = name.indexOf('.');
  const schema = program !== null ? `Program_${program[1]}` : dot < 0 ? 'dbo' : name.slice(0, dot);
  const table = program !== null ? (program[2] as string) : name.slice(dot + 1);
  const key = lower(program !== null ? `Program_N.${table}` : name);
  const entry = ownership.tables.find(
    (t) => t.pattern !== true && (lower(t.table) === key || (lower(t.schema) === lower(schema) && lower(t.table) === lower(table))),
  );
  if (entry === undefined) throw new GoldenConfigError(`rows: ${name} is not a table of opt2/table-ownership.json`);
  if (entry.targets.length === 0) {
    throw new GoldenConfigError(`rows: ${name} maps to no target unit (owner ${entry.owner}), so its rows cannot be compared`);
  }
  return program !== null ? { schema, table, programId: Number(program[1]), entry } : { schema, table, entry };
}

/** Owner of `unit` from `units[]`, falling back to the target's own owner field. */
function unitOwner(ownership: TableOwnership, target: OwnershipTarget): string {
  return ownership.units.find((u) => u.unit === target.unit)?.owner ?? target.owner;
}

/** Ownership name without `dbo.` or a `Program_<n>.` schema, lower-cased, as export tables name folded mappings. */
function legacyNameKey(name: string): string {
  return lower(name.replaceAll(/[[\]]/g, ''))
    .replace(/^dbo\./, '')
    .replace(/^program_(?:\d+|n)\./, '');
}

// --- Legacy rows --------------------------------------------------------------------------------------------------

interface CatalogColumn {
  name: string;
  dataType: string;
  scale: number | undefined;
}

function quoteIdent(name: string): string {
  return `[${name.replaceAll(']', ']]')}]`;
}

function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

async function readCatalog(mssql: ReadOnlyMssql, schema: string, table: string): Promise<CatalogColumn[]> {
  const rows = await mssql.readOnlyQuery<{ COLUMN_NAME: string; DATA_TYPE: string; NUMERIC_SCALE: number | null }>(
    'SELECT COLUMN_NAME, DATA_TYPE, NUMERIC_SCALE FROM INFORMATION_SCHEMA.COLUMNS ' +
      'WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION',
    { schema, table },
  );
  if (rows.length === 0) throw new GoldenConfigError(`rows: ${schema}.${table} has no columns in the live catalog`);
  return rows.map((row) => ({ name: row.COLUMN_NAME, dataType: lower(row.DATA_TYPE), scale: row.NUMERIC_SCALE ?? undefined }));
}

function catalogColumn(catalog: readonly CatalogColumn[], name: string, table: string): CatalogColumn {
  const found = catalog.find((column) => lower(column.name) === lower(name));
  if (found === undefined) throw new GoldenConfigError(`rows: ${name} is not a live column of ${table}`);
  return found;
}

function canonicalColumn(column: CatalogColumn): CanonicalColumn {
  return { name: column.name, ...canonicalTypeForSqlServer(column.dataType, { scale: column.scale }) };
}

/** SELECT expression carrying a column's exact value: the driver would read decimals as doubles and datetimes as UTC. */
function selectExpression(column: CatalogColumn): string {
  const id = quoteIdent(column.name);
  switch (column.dataType) {
    case 'text':
    case 'ntext':
      return `CAST(${id} AS nvarchar(max)) AS ${id}`;
    case 'image':
      return `CAST(${id} AS varbinary(max)) AS ${id}`;
    case 'money':
    case 'smallmoney':
      return `CONVERT(varchar(64), ${id}, 2) AS ${id}`;
    case 'decimal':
    case 'numeric':
      return `CONVERT(varchar(64), ${id}) AS ${id}`;
    case 'datetime':
    case 'smalldatetime':
    case 'datetime2':
    case 'date':
      return `CONVERT(varchar(27), CAST(${id} AS datetime2(7)), 121) AS ${id}`;
    default:
      return id;
  }
}

/** One resolved `where` term: the live column and the value it must equal. */
interface WhereTerm {
  column: string;
  value: Scalar;
}

/** The `where` terms of a row scope, column names as written; throws unless there is one and every value is a scalar. */
function scalarTerms(where: Readonly<Record<string, unknown>>, table: string): WhereTerm[] {
  const entries = Object.entries(where);
  if (entries.length === 0) throw new GoldenConfigError(`rows: ${table} needs at least one where column`);
  return entries.map(([column, value]) => {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new GoldenConfigError(`rows: where ${column} on ${table} does not resolve to a scalar`);
    }
    return { column, value };
  });
}

function whereTerms(where: Readonly<Record<string, unknown>>, catalog: readonly CatalogColumn[], table: string): WhereTerm[] {
  return scalarTerms(where, table).map((term) => ({ ...term, column: catalogColumn(catalog, term.column, table).name }));
}

/** SQL Server comparison form of a value: text without trailing spaces, case-folded; null stays null. */
function matchKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return lower(String(value).replace(/ +$/, ''));
}

/** One hop of an ownership join chain: `<from>.<fromColumn> = <toSchema>.<toTable>.<toColumn>`. */
interface Hop {
  fromColumn: string;
  toSchema: string;
  toTable: string;
  toColumn: string;
}

const HOP_TEXT = /^(.+)\.(\w+)\s*=\s*(.+)\.(\w+)$/;

function tableParts(name: string): [schema: string, table: string] {
  const dot = name.indexOf('.');
  return dot < 0 ? ['dbo', name] : [name.slice(0, dot), name.slice(dot + 1)];
}

/** Hops of a chain such as `a.x = b.x, then b.y = c.y`, starting at `table`. */
function parseChain(text: string, table: string): Hop[] {
  let from = lower(table);
  return text.split(/,\s*then\s+/i).map((part) => {
    const m = HOP_TEXT.exec(part.trim());
    if (m === null || lower(m[1] as string) !== from) {
      throw new GoldenConfigError(`rows: join chain '${text}' does not start at ${table} and continue hop by hop`);
    }
    const [toSchema, toTable] = tableParts(m[3] as string);
    from = lower(m[3] as string);
    return { fromColumn: m[2] as string, toSchema, toTable, toColumn: m[4] as string };
  });
}

/** `keys` mapped to `valueColumn` of the rows of `schema.table` whose `keyColumn` equals them. */
async function lookupColumn(
  mssql: ReadOnlyMssql,
  hop: Pick<Hop, 'toSchema' | 'toTable' | 'toColumn'>,
  valueColumn: string,
  keys: readonly string[],
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  for (const chunk of chunks(keys, IN_LIST_CHUNK)) {
    const params = Object.fromEntries(chunk.map((key, i) => [`k${i}`, key]));
    const rows = await mssql.readOnlyQuery<{ k: unknown; v: unknown }>(
      `SELECT ${quoteIdent(hop.toColumn)} AS k, ${quoteIdent(valueColumn)} AS v FROM ${qualifiedTable(hop.toSchema, hop.toTable)} ` +
        `WHERE ${quoteIdent(hop.toColumn)} IN (${chunk.map((_, i) => `@k${i}`).join(', ')})`,
      params,
    );
    for (const row of rows) {
      const key = matchKey(row.k);
      const value = matchKey(row.v);
      if (key === null) continue;
      if (found.has(key) && found.get(key) !== value) {
        throw new GoldenConfigError(`rows: ${hop.toTable}.${hop.toColumn} ${key} names rows with different ${valueColumn}`);
      }
      found.set(key, value);
    }
  }
  return found;
}

/** `finalColumn` reached from each start value through `hops`; null where a hop finds no row. */
async function followChain(
  mssql: ReadOnlyMssql,
  hops: readonly Hop[],
  start: readonly unknown[],
  finalColumn: string,
): Promise<(string | null)[]> {
  let current = start.map(matchKey);
  for (const [i, hop] of hops.entries()) {
    const next = i < hops.length - 1 ? (hops[i + 1] as Hop).fromColumn : finalColumn;
    const keys = [...new Set(current.filter((key): key is string => key !== null))];
    const found = keys.length === 0 ? new Map<string, string | null>() : await lookupColumn(mssql, hop, next, keys);
    current = current.map((key) => (key === null ? null : (found.get(key) ?? null)));
  }
  return current;
}

/** A target's `rowPredicate` in evaluable form. */
type Predicate =
  | { kind: 'all' }
  | { kind: 'values'; column: string; values: string[]; owner: boolean }
  | { kind: 'class-owner'; owner: string };

const EQUALS_PREDICATE = /^(owner\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/i;
const IN_PREDICATE = /^(owner\s+)?([A-Za-z_]\w*)\s+in\s*\((.*)\)$/i;
const CLASS_OWNER_PREDICATE = /^classMap\s+owner\s*=\s*(\S+)$/i;

function literalValues(text: string): string[] {
  return text.split(',').map((part) => {
    const value = part.trim();
    return lower(value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value);
  });
}

function parsePredicate(text: string | null, unit: string): Predicate {
  if (text === null) return { kind: 'all' };
  const classOwner = CLASS_OWNER_PREDICATE.exec(text);
  if (classOwner !== null) return { kind: 'class-owner', owner: classOwner[1] as string };
  const list = IN_PREDICATE.exec(text) ?? EQUALS_PREDICATE.exec(text);
  if (list === null) throw new GoldenConfigError(`rows: unit ${unit} has a row predicate golden capture cannot read: ${text}`);
  return { kind: 'values', column: list[2] as string, values: literalValues(list[3] as string), owner: list[1] !== undefined };
}

/** Columns the predicate reads from the row itself: the compared column, or the start of its join chain. */
function predicateSourceColumns(predicate: Predicate, ref: LegacyTableRef, catalog: readonly CatalogColumn[]): string[] {
  const split = ref.entry.split ?? undefined;
  const label = ref.entry.table;
  if (predicate.kind === 'all') return [];
  if (predicate.kind === 'class-owner') return [catalogColumn(catalog, split?.by ?? 'objectClass', label).name];
  if (!predicate.owner && catalog.some((c) => lower(c.name) === lower(predicate.column))) {
    return [catalogColumn(catalog, predicate.column, label).name];
  }
  return predicateChains(predicate, ref).map((hops) => catalogColumn(catalog, (hops[0] as Hop).fromColumn, label).name);
}

/** Join chains that reach a predicate column held by another table: the owner join (then the address join), or `split.resolve`. */
function predicateChains(predicate: Extract<Predicate, { kind: 'values' }>, ref: LegacyTableRef): Hop[][] {
  const split = ref.entry.split ?? undefined;
  const table = ref.entry.table;
  const texts = predicate.owner ? [split?.parent?.join, split?.addressJoin] : [split?.resolve];
  const chains = texts.filter((text): text is string => text !== undefined).map((text) => parseChain(text, table));
  if (chains.length === 0) {
    throw new GoldenConfigError(`rows: ${table} has no join in table-ownership.json that reaches ${predicate.column}`);
  }
  return chains;
}

/** Per row, whether it belongs to the target the predicate describes. */
async function predicateMask(
  mssql: ReadOnlyMssql,
  predicate: Predicate,
  ref: LegacyTableRef,
  catalog: readonly CatalogColumn[],
  rows: readonly Record<string, unknown>[],
): Promise<boolean[]> {
  if (predicate.kind === 'all') return rows.map(() => true);
  const label = ref.entry.table;
  if (predicate.kind === 'class-owner') {
    const column = catalogColumn(catalog, ref.entry.split?.by ?? 'objectClass', label).name;
    return rows.map((row) => lower(classOwner(ref.entry, matchKey(row[column]))) === lower(predicate.owner));
  }
  let values: (string | null)[];
  if (!predicate.owner && catalog.some((c) => lower(c.name) === lower(predicate.column))) {
    const column = catalogColumn(catalog, predicate.column, label).name;
    values = rows.map((row) => matchKey(row[column]));
  } else {
    values = rows.map(() => null);
    for (const hops of predicateChains(predicate, ref)) {
      const start = catalogColumn(catalog, (hops[0] as Hop).fromColumn, label).name;
      const open = rows.map((row, i) => (values[i] === null ? row[start] : null));
      const reached = await followChain(mssql, hops, open, predicate.column);
      values = values.map((value, i) => value ?? reached[i] ?? null);
    }
  }
  return values.map((value) => value !== null && predicate.values.includes(value));
}

/** Owner of a row of class `objectClass` under the table's `split.classMap`. */
function classOwner(entry: OwnershipTable, objectClass: string | null): string {
  const mapping = entry.split?.classMap?.find((m) => m.classes.some((c) => lower(c) === objectClass));
  if (mapping === undefined) throw new GoldenConfigError(`rows: ${entry.table} class ${objectClass ?? 'null'} has no classMap entry`);
  if (mapping.owner === undefined) {
    throw new GoldenConfigError(
      `rows: ${entry.table} class ${objectClass ?? 'null'} is owned by ${mapping.ownerBy ?? 'stored data'}, which row capture does not decide`,
    );
  }
  return mapping.owner;
}

/** Every column a unit's mapping encodes: its owned columns plus the key columns a split copies as the join key. */
function encodedColumnNames(target: OwnershipTarget): string[] {
  return [...target.keyColumns, ...target.ownedColumns];
}

/** Encoded columns of `target` in live catalog order; throws when one is not live. */
function ownedColumns(catalog: readonly CatalogColumn[], target: OwnershipTarget, table: string): CatalogColumn[] {
  const owned = new Set(encodedColumnNames(target).map((name) => lower(catalogColumn(catalog, name, table).name)));
  return catalog.filter((column) => owned.has(lower(column.name)));
}

function snapshotOf(
  ownership: TableOwnership,
  ref: LegacyTableRef,
  target: OwnershipTarget,
  columns: CanonicalColumn[],
  rows: string[],
): RowSnapshot {
  return {
    unit: target.unit,
    owner: unitOwner(ownership, target),
    legacyTable: ref.entry.table,
    columns,
    keyColumns: [...target.keyColumns],
    keyless: ref.entry.rowIdentity === 'multiset',
    rows: rows.sort(compareEncodings),
  };
}

/**
 * One snapshot per target unit of `spec.table`: a parameterised SELECT within `spec.where`, each unit's rows chosen
 * by its row predicate and encoded over its key and owned columns in catalog order, as its mapping encodes them.
 * `Program_<n>.<table>` reads that schema.
 */
export async function legacyRows(
  spec: ResolvedRowSpec,
  deps: { mssql: ReadOnlyMssql; ownership: TableOwnership },
): Promise<RowSnapshot[]> {
  return (await scanLegacyRows(spec, deps)).snapshots;
}

/** {@link legacyRows} with `matched`, the number of legacy rows within `spec.where` before any unit predicate. */
async function scanLegacyRows(
  spec: ResolvedRowSpec,
  deps: { mssql: ReadOnlyMssql; ownership: TableOwnership },
): Promise<{ snapshots: RowSnapshot[]; matched: number }> {
  const { mssql, ownership } = deps;
  const ref = resolveLegacyTable(ownership, spec.table);
  const catalog = await readCatalog(mssql, ref.schema, ref.table);
  const label = `${ref.schema}.${ref.table}`;
  const terms = whereTerms(spec.where, catalog, label);
  const plans = ref.entry.targets.map((target) => ({
    target,
    owned: ownedColumns(catalog, target, label),
    predicate: parsePredicate(target.rowPredicate, target.unit),
  }));
  const selected = new Set<string>(terms.map((term) => lower(term.column)));
  for (const plan of plans) {
    for (const column of plan.owned) selected.add(lower(column.name));
    for (const name of predicateSourceColumns(plan.predicate, ref, catalog)) selected.add(lower(name));
  }
  const select = catalog.filter((column) => selected.has(lower(column.name))).map(selectExpression);
  const params = Object.fromEntries(terms.map((term, i) => [`w${i}`, term.value]));
  const where = terms.map((term, i) => `${quoteIdent(term.column)} = @w${i}`).join(' AND ');
  const rows = await mssql.readOnlyQuery<Record<string, unknown>>(
    `SELECT ${select.join(', ')} FROM ${qualifiedTable(ref.schema, ref.table)} WHERE ${where}`,
    params,
  );
  const snapshots: RowSnapshot[] = [];
  for (const plan of plans) {
    const columns = plan.owned.map(canonicalColumn);
    const mask = await predicateMask(mssql, plan.predicate, ref, catalog, rows);
    const encodings = rows.filter((_, i) => mask[i]).map((row) => encodeRow(columns, row));
    snapshots.push(snapshotOf(ownership, ref, plan.target, columns, encodings));
  }
  return { snapshots, matched: rows.length };
}


// --- Target rows --------------------------------------------------------------------------------------------------

/** Collaborators of {@link targetRows}; the legacy client only reads the site registry and `synthetic.program_site`. */
export interface TargetRowDeps {
  env: EnvLike;
  /** Resolved configuration; else parsed from `env` once per call. */
  config?: SideEffectConfig;
  mssql: ReadOnlyMssql;
  ownership: TableOwnership;
  invoker: HarnessInvoker;
  fetch?: FetchLike;
}

interface DecodedRow {
  encoding: string;
  values: Record<string, CanonicalValue>;
}

interface UnitExport {
  columns: CanonicalColumn[];
  rows: DecodedRow[];
}

function columnNamed(columns: readonly CanonicalColumn[], name: string, unit: string): CanonicalColumn {
  const column = columns.find((c) => lower(c.name) === lower(name));
  if (column === undefined) throw new SideEffectError(`export of ${unit} carries no column ${name}`);
  return column;
}

/** Whether a decoded value equals a `where` value as SQL Server compares them. */
function sameValue(column: CanonicalColumn, value: CanonicalValue, wanted: Scalar): boolean {
  if (value === null) return false;
  switch (column.type) {
    case 's':
      return matchKey(value) === matchKey(wanted);
    case 'i':
    case 'f':
    case 'd':
      return Number(value) === Number(typeof wanted === 'boolean' ? Number(wanted) : wanted);
    case 't':
      return value === canonicalTimestamp(String(wanted));
    case 'b':
      throw new GoldenConfigError(`rows: where on binary column ${column.name} is not supported`);
  }
}

function canonicalTimestamp(text: string): string | null {
  try {
    return formatCanonicalTimestamp(text);
  } catch {
    return null;
  }
}

function matchesWhere(data: UnitExport, row: DecodedRow, terms: readonly WhereTerm[], unit: string): boolean {
  return terms.every((term) => {
    const column = columnNamed(data.columns, term.column, unit);
    return sameValue(column, row.values[column.name] ?? null, term.value);
  });
}

function keyTuple(data: UnitExport, row: DecodedRow, keyColumns: readonly string[], unit: string): string {
  return keyColumns.map((name) => matchKey(row.values[columnNamed(data.columns, name, unit).name]) ?? '\u0001').join('\u0000');
}

function owns(target: OwnershipTarget, column: string): boolean {
  return encodedColumnNames(target).some((name) => lower(name) === lower(column));
}

/** Tenants a unit's export is read in: the program's site for `Program_<n>` tables, the `where` site, else every site. */
async function exportSites(mssql: ReadOnlyMssql, ref: LegacyTableRef, terms: readonly WhereTerm[]): Promise<string[]> {
  if (ref.programId !== undefined) {
    const rows = await mssql.readOnlyQuery<{ siteId: unknown }>(
      'SELECT [siteID] AS siteId FROM [synthetic].[program_site] WHERE [program_id] = @programId',
      { programId: ref.programId },
    );
    const site = typeof rows[0]?.siteId === 'string' ? rows[0].siteId.trim() : '';
    if (site === '') throw new GoldenConfigError(`rows: synthetic.program_site maps no site to program ${ref.programId}`);
    return [site];
  }
  const sites = (await mssql.readOnlyQuery<{ siteId: unknown }>('SELECT [SiteID] AS siteId FROM [dbo].[tsettings]'))
    .map((row) => String(row.siteId ?? '').trim())
    .filter((site) => site !== '');
  const named = terms.find((term) => lower(term.column) === SITE_COLUMN);
  const site = named === undefined ? undefined : sites.find((s) => matchKey(s) === matchKey(named.value));
  return site === undefined ? [...new Set(sites)] : [site];
}

/** Every export page of `target.unit` in each site's tenant, keeping the tables of this legacy table. */
async function fetchUnitExport(
  deps: TargetRowDeps,
  config: SideEffectConfig,
  ref: LegacyTableRef,
  target: OwnershipTarget,
  sites: readonly string[],
): Promise<UnitExport> {
  const owner = unitOwner(deps.ownership, target);
  const base = serviceUrl(config, owner);
  const s = createHttpSession({ baseUrl: base, fetch: deps.fetch });
  const nameKey = legacyNameKey(ref.entry.table);
  let columns: CanonicalColumn[] | undefined;
  const rows: DecodedRow[] = [];
  for (const siteId of sites) {
    let after: string | null = null;
    do {
      const query: Record<string, string> = { unit: target.unit, siteId, limit: String(MAX_EXPORT_LIMIT) };
      if (ref.programId !== undefined) query.programId = String(ref.programId);
      if (after !== null) query.after = after;
      const headers = await deps.invoker.headersFor({ callee: owner, url: base });
      const result = await s.get(`${MIGRATION_PATH_PREFIX}/export`, { query, headers });
      const page = okJson<ExportResponse>(result, `${owner} export of ${target.unit} for site ${siteId}`);
      for (const table of page.tables) {
        if (table.unit !== target.unit || legacyNameKey(table.legacyTable) !== nameKey) continue;
        columns ??= table.columns;
        for (const row of table.rows) rows.push({ encoding: row.row, values: decodeRow(table.columns, row.row) });
      }
      after = page.next;
    } while (after !== null);
  }
  if (columns === undefined) throw new SideEffectError(`${owner} export of ${target.unit} carries no ${ref.entry.table} table`);
  return { columns, rows };
}

/**
 * One snapshot per target unit of `spec.table` from its owner's `GET /internal/v1/migration/export`, encodings as
 * returned and kept within `spec.where`. A unit that does not own a `where` column is bounded by the keys of a sibling
 * unit that does (people.person by identity.user_account's `UserID` for a `username` scope).
 */
export async function targetRows(spec: ResolvedRowSpec, deps: TargetRowDeps): Promise<RowSnapshot[]> {
  const config = deps.config ?? resolveSideEffectConfig(deps.env);
  const ref = resolveLegacyTable(deps.ownership, spec.table);
  const terms = scalarTerms(spec.where, ref.entry.table);
  const sites = await exportSites(deps.mssql, ref, terms);
  const exports = new Map<string, Promise<UnitExport>>();
  const exportOf = (target: OwnershipTarget): Promise<UnitExport> => {
    let pending = exports.get(target.unit);
    if (pending === undefined) {
      pending = fetchUnitExport(deps, config, ref, target, sites);
      exports.set(target.unit, pending);
    }
    return pending;
  };
  const ownsTerms = (target: OwnershipTarget): boolean => terms.every((term) => owns(target, term.column));

  const snapshots: RowSnapshot[] = [];
  for (const target of ref.entry.targets) {
    const data = await exportOf(target);
    let kept: DecodedRow[];
    if (ownsTerms(target)) {
      kept = data.rows.filter((row) => matchesWhere(data, row, terms, target.unit));
    } else {
      const anchor = ref.entry.targets.find(
        (t) => t !== target && ownsTerms(t) && t.keyColumns.length > 0 && t.keyColumns.every((key) => owns(target, key)),
      );
      if (anchor === undefined) {
        throw new GoldenConfigError(
          `rows: unit ${target.unit} does not own every where column of ${ref.entry.table}, and no sibling unit that does shares a key with it`,
        );
      }
      const anchorData = await exportOf(anchor);
      const keys = new Set(
        anchorData.rows
          .filter((row) => matchesWhere(anchorData, row, terms, anchor.unit))
          .map((row) => keyTuple(anchorData, row, anchor.keyColumns, anchor.unit)),
      );
      kept = data.rows.filter((row) => keys.has(keyTuple(data, row, anchor.keyColumns, target.unit)));
    }
    snapshots.push(snapshotOf(deps.ownership, ref, target, [...data.columns], kept.map((row) => row.encoding)));
  }
  return snapshots;
}


// --- Scheduled tasks ----------------------------------------------------------------------------------------------

/** A survey the scenario scheduled through the fixture route: its last scheduling request's site, launch time and session. */
export interface SurveySchedule {
  surveyId: string;
  siteId: string | undefined;
  launchAt: string;
  session: string | undefined;
}

/** The step's session name, or undefined (the scenario's default) when it is chosen per matrix value. */
function stepSession(step: Step): string | undefined {
  return step.as === undefined || MATRIX_PLACEHOLDER.test(step.as) ? undefined : step.as;
}

function launchField(value: unknown, step: string): string {
  const record = asRecord(value) ?? {};
  const key = Object.keys(record).find((name) => lower(name) === 'launchat');
  const text = key === undefined ? undefined : record[key];
  if (typeof text !== 'string' || !LAUNCH_TEXT.test(text)) {
    throw new GoldenConfigError(`step ${step} schedules a survey without a YYYY-MM-DDTHH:MM:SS launchAt`);
  }
  return text;
}

/** Surveys the steps schedule with `POST …/surveys/surveys/<id>/schedule`; a later request for a survey replaces an earlier one. */
export function scheduledSurveys(steps: readonly Step[], ctx: ScenarioContext): SurveySchedule[] {
  const byId = new Map<string, SurveySchedule>();
  for (const step of steps) {
    if (step.method !== 'POST' || !SCHEDULE_PATH.test(step.route.split('?')[0] as string)) continue;
    if (step.matrix !== undefined) {
      throw new GoldenConfigError(`${ctx.scenarioId}: step ${step.name} schedules surveys over a matrix, which tasks cannot follow`);
    }
    const url = new URL(String(resolvePlaceholders(step.route, ctx)), 'http://scenario.invalid');
    const id = SCHEDULE_PATH.exec(url.pathname)?.[1];
    if (id === undefined) continue;
    const surveyId = decodeURIComponent(id);
    byId.set(surveyId, {
      surveyId,
      siteId: [...url.searchParams].find(([name]) => lower(name) === SITE_COLUMN)?.[1],
      launchAt: launchField(resolvePlaceholders(step.body ?? step.form, ctx), step.name),
      session: stepSession(step),
    });
  }
  return [...byId.values()];
}

/** `launchAt` plus `minutes`, in the same zone-less form. */
function addMinutes(launchAt: string, minutes: number): string {
  const m = LAUNCH_TEXT.exec(launchAt) as RegExpExecArray;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return new Date(start + minutes * 60_000).toISOString().slice(0, 19);
}

/**
 * Tasks named `spec.prefix…` of every survey the steps schedule, read from `GET …/surveys/surveys/<id>/tasks` in the
 * scheduling session on the context's origin (the gateway serves it from surveys once cut over).
 */
export async function collectTasks(spec: TaskSpec, ctx: ScenarioContext, steps: readonly Step[]): Promise<TaskRecord[]> {
  const tasks: TaskRecord[] = [];
  for (const survey of scheduledSurveys(steps, ctx)) {
    const what = `tasks of survey ${survey.surveyId}`;
    const path = `${SURVEYS_PATH}${encodeURIComponent(survey.surveyId)}/tasks`;
    const query = survey.siteId === undefined ? {} : { query: { siteid: survey.siteId } };
    const data = asRecord(asRecord(okJson<unknown>(await session(ctx, survey.session).get(path, query), what))?.data);
    if (!Array.isArray(data?.items)) throw new SideEffectError(`${what} answered without data.items`);
    if (typeof data.totalpages === 'number' && data.totalpages > 1) {
      throw new SideEffectError(`${what} span ${data.totalpages} pages`);
    }
    for (const item of data.items as unknown[]) {
      const { taskname, kind, route, offsetminutes } = asRecord(item) ?? {};
      if (typeof taskname !== 'string' || typeof kind !== 'string' || typeof route !== 'string' || typeof offsetminutes !== 'number') {
        throw new SideEffectError(`a task of survey ${survey.surveyId} lacks taskname, kind, route or offsetminutes`);
      }
      if (!taskname.startsWith(spec.prefix)) continue;
      const scheduledAt = addMinutes(survey.launchAt, offsetminutes);
      tasks.push({ name: taskname, kind, target: route, scheduledAt, base: survey.launchAt });
    }
  }
  return tasks;
}

// --- Stored files -------------------------------------------------------------------------------------------------

/** A file id a scenario bound, with the session of the step that bound it. */
export interface FileRef {
  fileId: string;
  session: string | undefined;
}

/** Files the scenario wrote: every non-empty `<step>.fileid` binding, first binding per id. */
export function writtenFiles(steps: readonly Step[], ctx: ScenarioContext): FileRef[] {
  const sessions = new Map(steps.map((step) => [step.name, stepSession(step)]));
  const refs = new Map<string, FileRef>();
  for (const [key, value] of ctx.bindings) {
    const dot = key.indexOf('.');
    const step = key.slice(0, dot);
    if (dot < 0 || lower(key.slice(dot + 1)) !== FILE_ID_BINDING || !sessions.has(step)) continue;
    if (typeof value !== 'string' || value === '' || refs.has(lower(value))) continue;
    refs.set(lower(value), { fileId: value, session: sessions.get(step) });
  }
  return [...refs.values()];
}

/** Each render variant of each file that answers 200 on the context's origin, by content type, SHA-256 and size. */
export async function collectFiles(refs: readonly FileRef[], ctx: ScenarioContext): Promise<FileVariant[]> {
  const variants: FileVariant[] = [];
  for (const ref of refs) {
    const s = session(ctx, ref.session);
    for (const [name, size] of RENDER_VARIANTS) {
      const result = await s.get(`/_api/render/${size}/`, { query: { fileID: ref.fileId } });
      if (result.status !== 200) continue;
      const bytes = Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
      const contentType = headerText(result, 'content-type');
      variants.push({ fileId: ref.fileId, name, contentType, sha256: sha256Hex(bytes), size: bytes.length });
    }
  }
  return variants;
}

// --- Settle waits -------------------------------------------------------------------------------------------------

/** Collaborators shared by the waits and the collection of one call; `close` releases only what it created. */
interface Runtime extends Clock {
  env: EnvLike;
  config: SideEffectConfig;
  fetch: FetchLike | undefined;
  invoker(): Promise<HarnessInvoker>;
  mssql(): Promise<ReadOnlyMssql>;
  ownership(): Promise<TableOwnership>;
  groups(): Promise<CutoverGroups>;
  close(): Promise<void>;
}

function runtime(env: EnvLike, config: SideEffectConfig, deps: SideEffectDeps): Runtime {
  const clock = clockOf(deps);
  let invoker: Promise<HarnessInvoker> | undefined;
  let mssql: Promise<ReadOnlyMssql> | undefined;
  let ownership: Promise<TableOwnership> | undefined;
  let groups: Promise<CutoverGroups> | undefined;
  return {
    sleep: clock.sleep,
    now: clock.now,
    env,
    config,
    fetch: deps.fetch,
    invoker: () => (invoker ??= deps.invoker === undefined ? createHarnessInvoker({ caller: 'migration', env }) : Promise.resolve(deps.invoker)),
    mssql: () => (mssql ??= deps.mssql === undefined ? createReadOnlyMssql(env) : Promise.resolve(deps.mssql)),
    ownership: () => (ownership ??= deps.ownership === undefined ? loadTableOwnership() : Promise.resolve(deps.ownership)),
    groups: () => (groups ??= deps.groups === undefined ? loadCutoverGroups() : Promise.resolve(deps.groups)),
    async close() {
      if (mssql === undefined || deps.mssql !== undefined) return;
      // A client that never connected has nothing to close, and its error already reached the caller.
      const client = await mssql.catch(() => undefined);
      await client?.close();
    },
  };
}

async function ownerPosition(rt: Runtime, owner: string, query: Record<string, string>): Promise<PositionResponse> {
  const base = serviceUrl(rt.config, owner);
  const headers = await (await rt.invoker()).headersFor({ callee: owner, url: base });
  const result = await createHttpSession({ baseUrl: base, fetch: rt.fetch }).get(`${MIGRATION_PATH_PREFIX}/position`, {
    query,
    headers,
  });
  return okJson<PositionResponse>(result, `${owner} migration position`);
}

/** A push subscription: the consuming service and its topic. */
export interface PushSubscription {
  consumer: string;
  topic: string;
}

/** Subscriptions each catalogue service declares as `/internal/v1/events/<service>.<topic>` paths in its contract. */
export async function pushSubscriptions(): Promise<PushSubscription[]> {
  const subscriptions: PushSubscription[] = [];
  for (const service of SERVICES) {
    const file = repoPath('services', service, 'contracts', 'openapi.yaml');
    let paths: Record<string, unknown>;
    try {
      paths = asRecord(asRecord(parse(await readFile(file, 'utf8')))?.paths) ?? {};
    } catch (err) {
      throw new GoldenConfigError(`contract ${file} cannot be read: ${(err as Error).message}`, { path: file, cause: err });
    }
    for (const route of Object.keys(paths)) {
      if (!route.startsWith(PUSH_PATH_PREFIX)) continue;
      const name = route.slice(PUSH_PATH_PREFIX.length);
      const dot = name.indexOf('.');
      if (dot < 0 || name.slice(0, dot) !== service) {
        throw new GoldenConfigError(`contract ${file}: push path ${route} is not a subscription of ${service}`, { path: file });
      }
      subscriptions.push({ consumer: service, topic: name.slice(dot + 1) });
    }
  }
  return subscriptions;
}

/** Drops from `events` (event id → envelope tenant) every event `consumer` has an inbox receipt for in that tenant. */
async function proveReceipts(rt: Runtime, consumer: string, events: Map<string, string>): Promise<void> {
  for (const chunk of chunks([...events.keys()], RECEIPT_CHUNK)) {
    const receipts = (await ownerPosition(rt, consumer, { eventIds: chunk.join(',') })).inbox?.receipts ?? {};
    const tenantsOf = new Map(Object.entries(receipts).map(([id, tenants]) => [lower(id), tenants.map(lower)]));
    for (const id of chunk) {
      if (tenantsOf.get(id)?.includes(events.get(id) as string) === true) events.delete(id);
    }
  }
}

/** Sleeps one poll interval, never past `deadline`. */
async function pause(rt: Clock, deadline: number): Promise<void> {
  await rt.sleep(Math.max(0, Math.min(SETTLE_POLL_MS, deadline - rt.now())));
}

/**
 * Waits until the producers of `topic` (every subscribed topic when absent) hold no unpublished or held outbox row and
 * every event they published on it has each subscribed consumer's inbox receipt in its envelope tenant, which a fan-out
 * applies last. Throws SettleTimeoutError naming what is still pending at `timeoutMs`.
 */
async function awaitSeam(rt: Runtime, topic: string | undefined, timeoutMs: number): Promise<void> {
  const subscriptions = (await pushSubscriptions()).filter((s) => topic === undefined || s.topic === topic);
  if (subscriptions.length === 0) throw new GoldenConfigError(`settle seam: no service contract subscribes to ${topic ?? 'any topic'}`);
  const consumersOf = new Map<string, string[]>();
  const topicsOf = new Map<string, string[]>();
  for (const subscription of subscriptions) {
    consumersOf.set(subscription.topic, [...(consumersOf.get(subscription.topic) ?? []), subscription.consumer]);
    const producer = subscription.topic.slice(0, subscription.topic.indexOf('.'));
    const topics = topicsOf.get(producer) ?? [];
    if (!topics.includes(subscription.topic)) topicsOf.set(producer, [...topics, subscription.topic]);
  }
  const known = new Set<string>();
  const pending = new Map<string, Map<string, string>>();
  const deadline = rt.now() + timeoutMs;
  for (;;) {
    // Receipts are read before the listing, so an event published as the effect of a proven one is listed after it.
    for (const [consumer, events] of pending) await proveReceipts(rt, consumer, events);
    let unpublished = 0;
    let listed = false;
    for (const [producer, topics] of topicsOf) {
      const position = await ownerPosition(rt, producer, { publishedTopics: topics.join(',') });
      unpublished += (position.outbox?.unpublished ?? 0) + (position.outbox?.held ?? 0);
      if (position.published === undefined) throw new SideEffectError(`${producer} answered position without its published events`);
      for (const event of position.published) {
        const id = lower(event.eventId);
        if (known.has(id)) continue;
        known.add(id);
        listed = true;
        for (const consumer of consumersOf.get(event.topic) ?? []) {
          pending.set(consumer, (pending.get(consumer) ?? new Map<string, string>()).set(id, lower(event.tenantId)));
        }
      }
    }
    const waiting = [...pending].flatMap(([consumer, events]) => [...events.keys()].map((id) => `${consumer}:${id}`));
    if (unpublished === 0 && waiting.length === 0) return;
    if (rt.now() >= deadline) {
      throw new SettleTimeoutError(
        `settle seam ${topic ?? '(every topic)'}: after ${timeoutMs} ms ${unpublished} outbox rows are unpublished or held ` +
          `and ${waiting.length} deliveries lack a receipt (${waiting.slice(0, 10).join(', ')})`,
      );
    }
    if (!listed) await pause(rt, deadline);
  }
}

const groupAuthoritySchema = z.object({ groupAuthority: z.record(z.string(), z.enum(['legacy', 'target'])) });

/** Owners of the units in the groups the gateway's active cut-over version makes `target`-authoritative. */
async function projectedOwners(rt: Runtime, gatewayUrl: string): Promise<Set<string>> {
  const invoker = await rt.invoker();
  const status = await cutoverStatus({ gatewayUrl, env: rt.env, invoker, fetch: rt.fetch }).catch((err: unknown) => {
    if (err instanceof CutoverRequestFailed) {
      throw new SideEffectError(`gateway cut-over status answered ${err.status}`, { cause: err });
    }
    throw err;
  });
  const parsed = groupAuthoritySchema.safeParse(status);
  if (!parsed.success) throw new SideEffectError('gateway cut-over status carries no groupAuthority of legacy or target');
  const targetGroups = new Set(
    Object.entries(parsed.data.groupAuthority)
      .filter(([, authority]) => authority === 'target')
      .map(([id]) => id),
  );
  const owners = new Set<string>();
  if (targetGroups.size === 0) return owners;
  const [groups, ownership] = await Promise.all([rt.groups(), rt.ownership()]);
  for (const group of groups.groups) {
    if (!targetGroups.has(group.id)) continue;
    for (const unit of group.units) {
      const owner = ownership.units.find((u) => u.unit === unit)?.owner;
      if (owner === undefined) {
        throw new GoldenConfigError(`settle projection: unit ${unit} of group ${group.id} is not in opt2/table-ownership.json`);
      }
      owners.add(owner);
    }
  }
  return owners;
}

/** Tenants the projector streams: `tenantIdForSite` of each live `tsettings` site without trailing spaces, sorted. */
async function liveTenants(mssql: ReadOnlyMssql): Promise<string[]> {
  const rows = await mssql.readOnlyQuery<{ siteId: unknown }>('SELECT [SiteID] AS siteId FROM [dbo].[tsettings]');
  const sites = rows
    .map((row) => (typeof row.siteId === 'string' ? row.siteId.replace(/ +$/, '') : ''))
    .filter((site) => site !== '');
  return [...new Set(sites.map(tenantIdForSite))].sort();
}

/**
 * Waits until `opt2_sync.projector_checkpoint` holds, for each awaited owner in every live tenant, an applied horizon
 * above the owner's write position at the call; a missing checkpoint is behind. Awaited: `owner`, else every owner of a
 * `target`-authoritative unit. The checkpoints are read here because migration's `projectionAwait` admits only the gateway.
 */
async function awaitProjection(rt: Runtime, gatewayUrl: string, owner: string | undefined, timeoutMs: number): Promise<void> {
  if (owner !== undefined && !(await rt.ownership()).units.some((unit) => unit.owner === owner)) {
    throw new GoldenConfigError(`settle projection: ${owner} owns no unit of opt2/table-ownership.json`);
  }
  const owners = [...(await projectedOwners(rt, gatewayUrl))].filter((name) => owner === undefined || name === owner).sort();
  if (owners.length === 0) return;
  const positions = new Map<string, string>();
  for (const name of owners) positions.set(name, (await ownerPosition(rt, name, {})).position);
  const mssql = await rt.mssql();
  const deadline = rt.now() + timeoutMs;
  for (;;) {
    const tenants = await liveTenants(mssql);
    const rows = await mssql.readOnlyQuery<{ owner: string; tenantId: string; horizon: string }>(
      'SELECT [owner] AS owner, [tenant_id] AS tenantId, CONVERT(varchar(20), [applied_horizon]) AS horizon ' +
        'FROM [opt2_sync].[projector_checkpoint]',
    );
    const horizons = new Map(rows.map((row) => [`${row.owner}\u0000${lower(row.tenantId.trim())}`, row.horizon]));
    const lagging: string[] = [];
    for (const [name, position] of positions) {
      for (const tenant of tenants) {
        const horizon = horizons.get(`${name}\u0000${tenant}`);
        if (horizon === undefined || !isApplied(position, horizon)) lagging.push(`${name}/${tenant}`);
      }
    }
    if (lagging.length === 0) return;
    if (rt.now() >= deadline) {
      throw new SettleTimeoutError(`settle projection: after ${timeoutMs} ms the projector lags ${lagging.join(', ')}`);
    }
    await pause(rt, deadline);
  }
}

function splitSettle(spec: string): [kind: SettleKind, target: string | undefined] {
  const colon = spec.indexOf(':');
  const kind = colon < 0 ? spec : spec.slice(0, colon);
  const target = colon < 0 ? undefined : spec.slice(colon + 1);
  if (!(SETTLE_KINDS as readonly string[]).includes(kind) || target === '') {
    throw new GoldenConfigError(`unknown settle ${spec}; expected seam, projection, mail or tasks, optionally :<target>`);
  }
  return [kind as SettleKind, target];
}

/**
 * The step runner's settle hook. `mail` waits until Mailpit's count stops growing; `tasks` until the scenario's task
 * list is non-empty and stable (it needs `scenario`); `seam[:<topic>]` and `projection[:<owner>]` wait for event
 * delivery and reverse projection on the gateway and are no-ops on legacy, which applies both inside its requests.
 */
export function settleHook(
  ctx: ScenarioContext,
  scenario?: Pick<Scenario, 'steps' | 'tasks'>,
  deps: SideEffectDeps = {},
): SettleHook {
  const config = deps.config ?? resolveSideEffectConfig(ctx.env);
  return async (spec, timeoutMs) => {
    const [kind, target] = splitSettle(spec);
    if (kind === 'mail') {
      await waitForMail(ctx.env, timeoutMs, { ...deps, config });
      return;
    }
    if (kind === 'tasks') {
      const tasks = scenario?.tasks;
      if (tasks === undefined) throw new GoldenConfigError(`${ctx.scenarioId}: settle tasks needs the scenario and its tasks declaration`);
      const steps = scenario?.steps ?? [];
      await waitUntilQuiet(() => collectTasks(tasks, ctx, steps), {
        timeoutMs,
        quietMs: TASKS_QUIET_MS,
        ready: (list) => list.length > 0,
        key: (list) => JSON.stringify(list),
        clock: clockOf(deps),
      });
      return;
    }
    if (ctx.origin === 'legacy') return;
    const rt = runtime(ctx.env, config, deps);
    try {
      await (kind === 'seam' ? awaitSeam(rt, target, timeoutMs) : awaitProjection(rt, ctx.baseUrl, target, timeoutMs));
    } finally {
      await rt.close();
    }
  };
}

// --- Aggregation --------------------------------------------------------------------------------------------------

function resolveRowSpec(spec: RowSpec, ctx: ScenarioContext): ResolvedRowSpec {
  const resolved: ResolvedRowSpec = { table: spec.table, where: resolvePlaceholders(spec.where, ctx) };
  if (spec.minRows !== undefined) resolved.minRows = spec.minRows;
  return resolved;
}

/** Snapshots keyed by unit in sorted order; a unit several scopes reach holds each keyed row once, keyless rows per scope. */
function mergeSnapshots(snapshots: readonly RowSnapshot[]): Record<string, RowSnapshot> {
  const merged = new Map<string, RowSnapshot>();
  for (const snapshot of snapshots) {
    const seen = merged.get(snapshot.unit);
    if (seen === undefined) {
      merged.set(snapshot.unit, { ...snapshot, rows: [...snapshot.rows] });
      continue;
    }
    const rows = seen.keyless ? [...seen.rows, ...snapshot.rows] : [...new Set([...seen.rows, ...snapshot.rows])];
    seen.rows = rows.sort(compareEncodings);
  }
  return Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Side effects of a finished scenario run on `origin`, computing only the kinds in `scenario.compare`. Rows are the
 * legacy snapshot on legacy; on the gateway they are the target export, with the legacy rows after replay in `legacyRows`.
 * On legacy, a row scope holding fewer rows than its `minRows` throws MissingRowsError.
 */
export async function collectSideEffects(
  ctx: ScenarioContext,
  scenario: Pick<Scenario, 'compare' | 'rows' | 'tasks' | 'steps'>,
  origin: Origin = ctx.origin,
  deps: SideEffectDeps = {},
): Promise<SideEffects> {
  if (origin !== ctx.origin) {
    throw new GoldenConfigError(`${ctx.scenarioId}: side effects of origin ${origin} asked of a ${ctx.origin} context`);
  }
  const kinds = new Set<string>(scenario.compare);
  const effects: SideEffects = { mail: [], rows: {}, tasks: [], files: [] };
  const config = deps.config ?? resolveSideEffectConfig(ctx.env);
  const rt = runtime(ctx.env, config, deps);
  try {
    if (kinds.has('mail')) {
      // ColdFusion spools mail asynchronously and a scenario comparing mail need not declare a settle, so mail is read
      // only once Mailpit has gone quiet.
      await waitForMail(ctx.env, deps.mailTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS, { ...deps, config });
      effects.mail = await collectMail(ctx.env, { fetch: deps.fetch, config });
    }
    if (kinds.has('rows')) {
      const specs = (scenario.rows ?? []).map((spec) => resolveRowSpec(spec, ctx));
      const mssql = await rt.mssql();
      const ownership = await rt.ownership();
      const legacy: RowSnapshot[] = [];
      for (const spec of specs) {
        const { snapshots, matched } = await scanLegacyRows(spec, { mssql, ownership });
        if (origin === 'legacy' && spec.minRows !== undefined && matched < spec.minRows) {
          throw new MissingRowsError(
            `${ctx.scenarioId}: rows: ${spec.table} holds ${matched} legacy rows within ${JSON.stringify(spec.where)}, ` +
              `fewer than its minRows ${spec.minRows}`,
          );
        }
        legacy.push(...snapshots);
      }
      if (origin === 'legacy') {
        effects.rows = mergeSnapshots(legacy);
      } else {
        const rowDeps: TargetRowDeps = { env: ctx.env, config, mssql, ownership, invoker: await rt.invoker(), fetch: deps.fetch };
        const target: RowSnapshot[] = [];
        for (const spec of specs) target.push(...(await targetRows(spec, rowDeps)));
        effects.rows = mergeSnapshots(target);
        effects.legacyRows = mergeSnapshots(legacy);
      }
    }
    if (kinds.has('tasks')) {
      if (scenario.tasks === undefined) throw new GoldenConfigError(`${ctx.scenarioId}: compare tasks needs a tasks declaration`);
      effects.tasks = await collectTasks(scenario.tasks, ctx, scenario.steps);
    }
    if (kinds.has('files')) effects.files = await collectFiles(writtenFiles(scenario.steps, ctx), ctx);
  } finally {
    await rt.close();
  }
  return effects;
}

