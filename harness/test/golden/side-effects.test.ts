import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import {
  MAX_EXPORT_LIMIT,
  MIGRATION_PATH_PREFIX,
  compareEncodings,
  encodeKey,
  encodeRow,
  sha256Hex,
  type CanonicalColumn,
  type ExportTable,
  type PositionResponse,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICES,
  stepSchema,
  type CompareKind,
  type RowSpec,
  type Step,
  type TaskSpec,
} from '../../src/golden/catalogue.js';
import { GoldenConfigError } from '../../src/golden/errors.js';
import { createScenarioContext, session, type Origin, type ScenarioContext } from '../../src/golden/session.js';
import {
  DEFAULT_MAILPIT_URL,
  MAIL_QUIET_MS,
  MissingRowsError,
  RENDER_VARIANTS,
  SETTLE_POLL_MS,
  SettleTimeoutError,
  SideEffectError,
  TASKS_QUIET_MS,
  collectFiles,
  collectMail,
  collectSideEffects,
  collectTasks,
  legacyRows,
  loadCutoverGroups,
  loadTableOwnership,
  pushSubscriptions,
  resetMailpit,
  resolveSideEffectConfig,
  scheduledSurveys,
  serviceUrl,
  settleHook,
  sideEffectEnvSchema,
  targetRows,
  waitForMail,
  writtenFiles,
  type CutoverGroups,
  type OwnershipSplit,
  type OwnershipTable,
  type OwnershipTarget,
  type RowSnapshot,
  type SideEffectDeps,
  type TableOwnership,
  type TargetRowDeps,
} from '../../src/golden/side-effects.js';
import type { FetchLike } from '../../src/lib/http.js';
import { createHarnessInvoker, type HarnessInvoker, type MinterFactory } from '../../src/lib/invocation.js';
import {
  createReadOnlyMssql,
  type MssqlDriver,
  type MssqlPool,
  type MssqlRequest,
  type ReadOnlyMssql,
} from '../../src/lib/mssql.js';
import type { EnvLike } from '../../src/lib/paths.js';
import { CutoverRequestFailed, GatewayUnreachable } from '../../src/repro/cutover.js';

// Contract reads pass through; single tests replace one read to reach the contract error paths.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// Sleeps pass through; the default-clock waitForMail test drives the default sleep through this spy.
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

// Every request goes to a scripted fetch and every query to an in-memory SQL Server: nothing reaches Mailpit,
// SQL Server or a service.
const SCENARIO = 'GS-SE-01';
const LEGACY = 'http://legacy.fixture.test';
const GATEWAY = 'http://gateway.fixture.test';
const MAILPIT = 'http://mailpit.fixture.test:8025';
const TOKEN = 'Bearer FIXTURE-INVOCATION-TOKEN';
const CURSOR = 'FIXTURE-CURSOR-1';
const SURVEYS = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const NO_LOGIN = { login: 'none', via: 'admin' } as const;
const SQL_ENV: EnvLike = {
  MURA_DBHOST: 'sql.fixture.test',
  MURA_DATABASE: 'muradb_fixture',
  MURA_DBUSERNAME: 'fixture-user',
  MURA_DBPASSWORD: 'FIXTURE-DB-PASSWORD',
};
const TINY_PDF = readFileSync(new URL('../fixtures/exports/tiny.pdf', import.meta.url));

const serviceBase = (name: string): string => `http://${name}.fixture.test`;
const SERVICE_URLS = JSON.stringify(Object.fromEntries(SERVICES.map((name) => [name, `${serviceBase(name)}/`])));

// --- Fake HTTP ------------------------------------------------------------------------------------------------------

type Handler = (url: URL) => Response;

/** One request a scripted fetch received. */
interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
}

interface FakeHttp {
  fetch: FetchLike;
  calls: Call[];
  /** Scripts `<method> <origin><path>`; the handler reads the query itself. */
  route(method: string, url: string, handler: Handler): FakeHttp;
  /** Calls to `origin` as `<METHOD> <path><query>`. */
  to(origin: string): string[];
}

const unmatchedRequests: string[][] = [];

/** Fetch answering scripted routes; any other request is recorded and rejected. */
function fakeHttp(): FakeHttp {
  const routes = new Map<string, Handler>();
  const unmatched: string[] = [];
  unmatchedRequests.push(unmatched);
  const fake: FakeHttp = {
    calls: [],
    route(method, url, handler) {
      routes.set(`${method} ${url}`, handler);
      return fake;
    },
    to: (origin) =>
      fake.calls
        .filter((call) => call.url.origin === origin)
        .map((call) => `${call.method} ${call.url.pathname}${call.url.search}`),
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? 'GET';
      fake.calls.push({ method, url, headers: { ...(init.headers as Record<string, string>) } });
      const handler = routes.get(`${method} ${url.origin}${url.pathname}`);
      if (handler === undefined) {
        unmatched.push(`${method} ${input}`);
        throw new Error(`unscripted request ${method} ${input}`);
      }
      return handler(url);
    },
  };
  return fake;
}

/** Each request's path and query with the cookie it carried. */
function sentWithCookies(http: FakeHttp): string[] {
  return http.calls.map((call) => `${call.url.pathname}${call.url.search} ${call.headers.cookie}`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Handler answering `replies` in turn, the last one repeating. */
function inTurn(...replies: Handler[]): Handler {
  return (url) => (replies.length > 1 ? (replies.shift() as Handler) : (replies[0] as Handler))(url);
}

// --- Fake Mailpit ---------------------------------------------------------------------------------------------------

interface MailFixture {
  ID: string;
  message: Record<string, unknown>;
  headers: Record<string, string[]>;
}

/** Scripts Mailpit's message list, at most `pageSize` per page, and each message's detail and headers. */
function mailpit(
  http: FakeHttp,
  messages: readonly MailFixture[],
  opts: { base?: string; pageSize?: number; total?: () => number } = {},
): FakeHttp {
  const base = opts.base ?? MAILPIT;
  http.route('GET', `${base}/api/v1/messages`, (url) => {
    const start = Number(url.searchParams.get('start'));
    const limit = Math.min(Number(url.searchParams.get('limit')), opts.pageSize ?? Number.MAX_SAFE_INTEGER);
    const page = messages.slice(start, start + limit).map(({ ID }) => ({ ID }));
    return json({ total: opts.total?.() ?? messages.length, messages: page });
  });
  for (const m of messages) {
    const at = `${base}/api/v1/message/${m.ID}`;
    http.route('GET', at, () => json(m.message)).route('GET', `${at}/headers`, () => json(m.headers));
  }
  return http;
}

/** Mailpit whose list reports `counts` in turn, the last one repeating. */
function mailCounts(http: FakeHttp, ...counts: number[]): FakeHttp {
  return http.route(
    'GET',
    `${MAILPIT}/api/v1/messages`,
    inTurn(...counts.map((total) => () => json({ total, messages: total === 0 ? [] : [{ ID: 'FIXTURE-M1' }] }))),
  );
}

// --- Fake clock -----------------------------------------------------------------------------------------------------

interface FakeClock {
  sleep(ms: number): Promise<void>;
  now(): number;
  elapsed(): number;
}

/** Clock that advances only when slept on; `onSleep` sees the elapsed time after each sleep. */
function fakeClock(onSleep: (elapsed: number) => void = () => undefined): FakeClock {
  const start = Date.UTC(2026, 5, 30, 9, 0, 0);
  let now = start;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onSleep(now - start);
    },
    elapsed: () => now - start,
  };
}

// --- Fake SQL Server ------------------------------------------------------------------------------------------------

type CatalogEntry = readonly [name: string, dataType: string, scale?: number];

/** One legacy table: its INFORMATION_SCHEMA columns and its rows as the driver returns them. */
interface LegacyTable {
  columns?: readonly CatalogEntry[];
  rows: Record<string, unknown>[];
}

/** Legacy database keyed `<schema>.<table>`. */
type LegacyDb = Record<string, LegacyTable>;

interface SqlQuery {
  sql: string;
  params: Record<string, unknown>;
}

interface FakeSql {
  mssql: ReadOnlyMssql;
  queries: SqlQuery[];
}

const BATCH = /^SET XACT_ABORT ON;\nBEGIN TRANSACTION;\n([\s\S]*)\nIF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;$/;
const SELECT_FROM = /^SELECT (.+) FROM \[([^\]]+)\]\.\[([^\]]+)\](?: WHERE (.+))?$/s;
const WHERE_TERM = /^\[([^\]]+)\] (?:= @(\w+)|IN \((.+)\))$/;

/** A value as SQL Server's default collation compares it; null never matches. */
function comparable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value).replace(/ +$/, '').toLowerCase();
}

/** Column `name` of `row`, matched case-insensitively as SQL Server resolves identifiers. */
function field(row: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : row[key];
}

/** Select-list items split at commas outside parentheses. */
function selectItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) {
      items.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...items, list.slice(start).trim()];
}

/** Answers the catalog query and single-table SELECTs with `=` and `IN` terms over `db`. */
function evaluate(db: LegacyDb, sql: string, params: Record<string, unknown>): Record<string, unknown>[] {
  if (sql.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
    const columns = db[`${String(params.schema)}.${String(params.table)}`]?.columns ?? [];
    return columns.map(([COLUMN_NAME, DATA_TYPE, scale]) => ({ COLUMN_NAME, DATA_TYPE, NUMERIC_SCALE: scale ?? null }));
  }
  const m = SELECT_FROM.exec(sql);
  const table = m === null ? undefined : db[`${m[2]}.${m[3]}`];
  if (m === null || table === undefined) throw new Error(`fake SQL Server cannot answer: ${sql}`);
  const terms = (m[4] === undefined ? [] : m[4].split(' AND ')).map((term) => {
    const t = WHERE_TERM.exec(term);
    if (t === null) throw new Error(`fake SQL Server cannot read WHERE term: ${term}`);
    const names = t[2] !== undefined ? [t[2]] : (t[3] as string).split(', ').map((p) => p.slice(1));
    return { column: t[1] as string, values: names.map((name) => comparable(params[name])) };
  });
  const items = selectItems(m[1] as string).map((item) => {
    const source = /\[([^\]]+)\]/.exec(item)?.[1] ?? item;
    return { source, alias: /\bAS \[?(\w+)\]?$/.exec(item)?.[1] ?? source };
  });
  return table.rows
    .filter((row) =>
      terms.every((term) => {
        const value = comparable(field(row, term.column));
        return value !== null && term.values.includes(value);
      }),
    )
    .map((row) => Object.fromEntries(items.map((item) => [item.alias, field(row, item.source)])));
}

/** Read-only client over a driver whose pool answers from `db`, recording each statement inside its rollback batch. */
async function fakeSql(db: LegacyDb): Promise<FakeSql> {
  const queries: SqlQuery[] = [];
  class Pool implements MssqlPool {
    async connect(): Promise<MssqlPool> {
      return this;
    }

    request(): MssqlRequest {
      const params: Record<string, unknown> = {};
      const request: MssqlRequest = {
        input(name, value) {
          params[name] = value;
          return request;
        },
        async query<T>(batch: string): Promise<{ recordset: T[] }> {
          const sql = BATCH.exec(batch)?.[1];
          if (sql === undefined) throw new Error(`statement outside the rollback batch: ${batch}`);
          queries.push({ sql, params: { ...params } });
          return { recordset: evaluate(db, sql, params) as T[] };
        },
      };
      return request;
    }

    async close(): Promise<void> {}
  }
  const driver: MssqlDriver = { ConnectionPool: Pool };
  return { mssql: await createReadOnlyMssql(SQL_ENV, { driver }), queries };
}

// --- Ownership and rows ---------------------------------------------------------------------------------------------

function target(
  unit: string,
  owner: string,
  rowPredicate: string | null,
  keyColumns: string[],
  ownedColumns: string[],
): OwnershipTarget {
  return { unit, owner, rowPredicate, keyColumns, ownedColumns };
}

function table(entry: Pick<OwnershipTable, 'table' | 'targets'> & Partial<OwnershipTable>): OwnershipTable {
  return { schema: 'dbo', owner: entry.targets[0]?.owner ?? 'legacy', rowIdentity: 'key', split: null, ...entry };
}

function col(name: string, type: CanonicalColumn['type'], scale?: number): CanonicalColumn {
  return scale === undefined ? { name, type } : { name, type, scale };
}

/** `encodeRow` encodings of `rows`, sorted bytewise. */
function encoded(columns: readonly CanonicalColumn[], rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => encodeRow(columns, row)).sort(compareEncodings);
}

function snapshot(
  fields: Omit<RowSnapshot, 'rows' | 'keyless'> & { keyless?: boolean },
  rows: readonly Record<string, unknown>[],
): RowSnapshot {
  return { ...fields, keyless: fields.keyless ?? false, rows: encoded(fields.columns, rows) };
}

const TUSERS = table({
  table: 'tusers',
  owner: 'identity',
  split: { by: 'Type+column' },
  targets: [
    target('identity.user_account', 'identity', 'Type = 2', ['UserID'], ['UserID', 'UserName', 'Type']),
    target('people.person', 'people', 'Type = 2', ['UserID', 'SiteID'], ['Fname', 'Email']),
    // The units list names this unit's owner, which wins over the target's own field.
    target('identity.group_account', 'people', 'Type = 1', ['UserID'], ['GroupName']),
  ],
});
const EMAIL_STATS = table({
  table: 'temailstats',
  rowIdentity: 'multiset',
  targets: [target('communications.email_stat', 'communications', null, [], ['EmailID', 'Email', 'SiteID'])],
});
const FINANCE = table({
  table: 'Program_N.finance_record',
  schema: 'Program_N',
  targets: [
    target(
      'finance.record',
      'finance',
      null,
      ['record_id'],
      ['siteID', 'title', 'amount', 'fee', 'created', 'period', 'content', 'approved', 'ratio'],
    ),
  ],
});
const BLACKOUT = table({
  table: 'Program_N.blackout',
  schema: 'Program_N',
  targets: [target('timesheets.blackout', 'timesheets', null, ['blackout_id'], ['blackout_id', 'day_id', 'reason'])],
});
const SAMPLE = table({
  table: 'synthetic.sample',
  schema: 'synthetic',
  targets: [target('finance.sample', 'finance', null, ['id'], ['id', 'siteID', 'v'])],
});
const OWNERSHIP: TableOwnership = {
  tables: [
    table({ table: 'fb_*', pattern: true, targets: [] }),
    TUSERS,
    EMAIL_STATS,
    FINANCE,
    BLACKOUT,
    SAMPLE,
    table({ table: 'tclustercommands', targets: [] }),
  ],
  units: [
    { unit: 'identity.user_account', owner: 'identity' },
    { unit: 'identity.group_account', owner: 'identity' },
    { unit: 'communications.email_stat', owner: 'communications' },
  ],
};

/** OWNERSHIP with `entries` looked up first. */
function withTables(...entries: OwnershipTable[]): TableOwnership {
  return { tables: [...entries, ...OWNERSHIP.tables], units: OWNERSHIP.units };
}

const TUSERS_COLUMNS: CatalogEntry[] = [
  ['UserID', 'char'],
  ['GroupName', 'nvarchar'],
  ['Fname', 'nvarchar'],
  ['UserName', 'nvarchar'],
  ['Email', 'nvarchar'],
  ['Type', 'int', 0],
  ['SiteID', 'varchar'],
  ['LastUpdate', 'datetime'],
];

function user(UserID: string, Type: number, fields: Record<string, unknown>): Record<string, unknown> {
  const blank = { GroupName: null, Fname: null, UserName: null, Email: null, SiteID: 'default' };
  return { UserID, ...blank, Type, LastUpdate: '2026-06-30 09:15:00.0000000', ...fields };
}

const G1 = user('FIXTURE-G1', 1, { GroupName: 'Editors' });
const U1 = user('FIXTURE-U1', 2, { Fname: 'Ada', UserName: 'fixture-ada', Email: 'ada@example.test' });
const U2 = user('FIXTURE-U2', 2, { UserName: 'fixture-null', Email: 'null@example.test' });
const U3 = user('FIXTURE-U3', 2, { Fname: '', UserName: 'fixture-empty', Email: 'empty@example.test' });
const U4 = user('FIXTURE-U4', 2, { Fname: 'Other', UserName: 'fixture-other', SiteID: 'tenant-a' });
const U5 = user('FIXTURE-U5', 2, { Fname: 'Ada', UserName: 'FIXTURE-ADA  ', Email: 'ada5@x.test', SiteID: 'tenant-a' });
const U1_TENANT_A = { ...U1, SiteID: 'tenant-a' };

const ACCOUNT_COLUMNS = [col('UserID', 's'), col('UserName', 's'), col('Type', 'i')];
const PERSON_COLUMNS = [col('UserID', 's'), col('Fname', 's'), col('Email', 's'), col('SiteID', 's')];
const GROUP_COLUMNS = [col('UserID', 's'), col('GroupName', 's')];
const STAT_COLUMNS = [col('EmailID', 's'), col('Email', 's'), col('SiteID', 's')];

const STAT = {
  EmailID: 'FIXTURE-E1',
  Email: 'ada@example.test',
  SiteID: 'default',
  Created: '2026-06-30 09:15:00.0000000',
};
const OTHER_STAT = { ...STAT, Email: 'bob@example.test' };

/** Legacy tables of the default fixtures, plus `extra`. */
function legacyDb(extra: LegacyDb = {}): LegacyDb {
  return {
    'dbo.tusers': { columns: TUSERS_COLUMNS, rows: [G1, U1, U2, U3, U4] },
    'dbo.temailstats': {
      columns: [['EmailID', 'char'], ['Email', 'nvarchar'], ['SiteID', 'varchar'], ['Created', 'datetime']],
      rows: [STAT, STAT, OTHER_STAT],
    },
    'dbo.tsettings': {
      columns: [['SiteID', 'varchar']],
      rows: [{ SiteID: 'default' }, { SiteID: 'tenant-a  ' }, { SiteID: 'default' }, { SiteID: '' }, { SiteID: null }],
    },
    ...extra,
  };
}

const BY_SITE = { table: 'tusers', where: { siteid: 'default' } } satisfies RowSpec;
const BY_USERNAME = { table: 'tusers', where: { username: 'Fixture-Ada' } } satisfies RowSpec;
/** Snapshots of the tusers units user_account, person and group_account, in target order. */
function userSnapshots(
  accounts: Record<string, unknown>[],
  persons: Record<string, unknown>[],
  groups: Record<string, unknown>[],
): RowSnapshot[] {
  const users = { legacyTable: 'tusers', keyColumns: ['UserID'] };
  return [
    snapshot({ ...users, unit: 'identity.user_account', owner: 'identity', columns: ACCOUNT_COLUMNS }, accounts),
    snapshot(
      { ...users, unit: 'people.person', owner: 'people', columns: PERSON_COLUMNS, keyColumns: ['UserID', 'SiteID'] },
      persons,
    ),
    snapshot({ ...users, unit: 'identity.group_account', owner: 'identity', columns: GROUP_COLUMNS }, groups),
  ];
}

const LEGACY_USERS = userSnapshots([U1, U2, U3], [U1, U2, U3], [G1]);

// --- Target exports and invocation ----------------------------------------------------------------------------------

function exportTable(
  unit: string,
  legacyTable: string,
  columns: CanonicalColumn[],
  keyColumns: string[],
  rows: readonly Record<string, unknown>[],
): ExportTable {
  return {
    unit,
    legacyTable,
    targetTable: unit.slice(unit.indexOf('.') + 1),
    keyless: keyColumns.length === 0,
    columns,
    rows: rows.map((row) => {
      const encoding = encodeRow(columns, row);
      const key = keyColumns.length === 0 ? encoding : encodeKey(columns, keyColumns, row);
      return { key, row: encoding, hash: sha256Hex(encoding) };
    }),
  };
}

interface ExportPage {
  unit: string;
  siteId: string;
  after?: string;
  programId?: string;
  tables: ExportTable[];
  next?: string;
}

/** Scripts `owner`'s migration export: the page whose unit, site, cursor and program the query names. */
function exportService(http: FakeHttp, owner: string, pages: readonly ExportPage[]): FakeHttp {
  return http.route('GET', `${serviceBase(owner)}${MIGRATION_PATH_PREFIX}/export`, (url) => {
    const q = url.searchParams;
    const page = pages.find(
      (p) =>
        p.unit === q.get('unit') &&
        p.siteId === q.get('siteId') &&
        (p.after ?? null) === q.get('after') &&
        (p.programId ?? null) === q.get('programId'),
    );
    if (page === undefined) throw new Error(`no export page for ${owner}${url.search}`);
    const tenantId = `FIXTURE-TENANT-${page.siteId}`;
    return json({ unit: page.unit, tenantId, tables: page.tables, next: page.next ?? null });
  });
}

const accounts = (legacyTable: string, rows: Record<string, unknown>[]): ExportTable =>
  exportTable('identity.user_account', legacyTable, ACCOUNT_COLUMNS, ['UserID'], rows);
const groups = (rows: Record<string, unknown>[]): ExportTable =>
  exportTable('identity.group_account', 'tusers', GROUP_COLUMNS, ['UserID'], rows);
const persons = (rows: Record<string, unknown>[]): ExportTable =>
  exportTable('people.person', 'tusers', PERSON_COLUMNS, ['UserID', 'SiteID'], rows);

/** Exports of the tusers units: user accounts over two default-site pages, groups and persons per site. */
function userExports(http: FakeHttp): FakeHttp {
  const membershipColumns = [col('UserID', 's'), col('GroupID', 's')];
  const memberships = exportTable('identity.user_account', 'tusersmemb', membershipColumns, [], [
    { UserID: 'FIXTURE-U1', GroupID: 'FIXTURE-G1' },
  ]);
  const credentials = exportTable('identity.credential', 'tusers', [col('UserID', 's')], ['UserID'], [U1]);
  const firstPage = [accounts('tusers', [U1]), memberships, credentials];
  exportService(http, 'identity', [
    { unit: 'identity.user_account', siteId: 'default', next: CURSOR, tables: firstPage },
    { unit: 'identity.user_account', siteId: 'default', after: CURSOR, tables: [accounts('dbo.tusers', [U2])] },
    { unit: 'identity.user_account', siteId: 'tenant-a', tables: [accounts('tusers', [U5])] },
    { unit: 'identity.group_account', siteId: 'default', tables: [groups([G1])] },
    { unit: 'identity.group_account', siteId: 'tenant-a', tables: [] },
  ]);
  return exportService(http, 'people', [
    { unit: 'people.person', siteId: 'default', tables: [persons([U1, U2])] },
    { unit: 'people.person', siteId: 'tenant-a', tables: [persons([U5, U1_TENANT_A])] },
  ]);
}

const TARGET_USERS = userSnapshots([U1, U5], [U1, U1_TENANT_A, U5], []);

let minted: { name: string; url: string | undefined }[] = [];

/** Harness invoker whose minter records each target and returns the fixture token. */
function fixtureInvoker(): Promise<HarnessInvoker> {
  const minterFactory: MinterFactory = () => ({
    async headersFor(t) {
      minted.push({ name: t.name, url: t.url });
      return { [INVOCATION_HEADER]: TOKEN };
    },
  });
  return createHarnessInvoker({ caller: 'migration', env: { OPT2_STATE_DIR: stateDir }, minterFactory });
}

// --- Scenario context -----------------------------------------------------------------------------------------------

let stateDir = '';

const unscriptedGlobalFetches: string[] = [];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'opt2-side-effects-'));
  minted = [];
  // A collaborator created without the scripted fetch fails here instead of reaching a real host.
  vi.stubGlobal('fetch', async (input: unknown) => {
    unscriptedGlobalFetches.push(String(input));
    throw new Error(`global fetch called for ${String(input)}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(stateDir, { recursive: true, force: true });
  for (const unmatched of unmatchedRequests.splice(0)) expect(unmatched).toStrictEqual([]);
  expect(unscriptedGlobalFetches.splice(0)).toStrictEqual([]);
});

function scenarioEnv(extra: EnvLike = {}): EnvLike {
  return {
    LEGACY_ORIGIN: LEGACY,
    OPT2_GATEWAY_URL: GATEWAY,
    MAILPIT_API_URL: `${MAILPIT}/`,
    OPT2_STATE_DIR: stateDir,
    OPT2_SERVICE_URLS: SERVICE_URLS,
    ...extra,
  };
}

/** Context with the sessions `default` and `editor`, each carrying a cookie naming it. */
async function context(
  http: FakeHttp,
  origin: Origin = 'legacy',
  env: EnvLike = scenarioEnv(),
): Promise<ScenarioContext> {
  const ctx = createScenarioContext(
    { id: SCENARIO, sessions: { default: NO_LOGIN, editor: NO_LOGIN } },
    { origin, env, fetch: http.fetch },
  );
  for (const name of ['default', 'editor']) {
    await session(ctx, name).jar.setCookie(`CFID=FIXTURE-${name}; Path=/`, ctx.baseUrl);
  }
  return ctx;
}

function step(fields: Record<string, unknown>): Step {
  return stepSchema.parse(fields);
}

function scheduleStep(name: string, surveyId: string, fields: Record<string, unknown>): Step {
  return step({ name, method: 'POST', route: `${SURVEYS}/${surveyId}/schedule`, ...fields });
}

function tasksReply(items: unknown[], totalpages = 1): Handler {
  return () => json({ apiversion: 'v1', method: 'GET', data: { items, totalpages } });
}

const TASKS: TaskSpec = { source: 'scheduled-tasks', prefix: 'opt2-survey-' };

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(outcome instanceof Error)) throw new Error('expected the promise to reject with an Error');
  return outcome;
}

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('resolveSideEffectConfig', () => {
  it.each([
    {
      label: 'trims trailing slashes',
      env: { OPT2_SERVICE_URLS: '{"people":"http://people.fixture.test//"}', MAILPIT_API_URL: `${MAILPIT}/` },
      config: { serviceUrls: { people: 'http://people.fixture.test' }, mailpitUrl: MAILPIT },
    },
    { label: 'defaults unset variables', env: {}, config: { serviceUrls: {}, mailpitUrl: DEFAULT_MAILPIT_URL } },
    {
      label: 'reads blank variables as unset',
      env: { OPT2_SERVICE_URLS: ' ', MAILPIT_API_URL: '' },
      config: { serviceUrls: {}, mailpitUrl: DEFAULT_MAILPIT_URL },
    },
  ])('$label', ({ env, config }) => {
    expect(resolveSideEffectConfig(env)).toStrictEqual(config);
  });

  it.each([
    {
      label: 'a service URL that is not a URL',
      env: { OPT2_SERVICE_URLS: '{"identity":"not-a-url"}' },
      path: 'OPT2_SERVICE_URLS.identity',
    },
    { label: 'an empty service URL', env: { OPT2_SERVICE_URLS: '{"people":""}' }, path: 'OPT2_SERVICE_URLS.people' },
    { label: 'a map that is a JSON array', env: { OPT2_SERVICE_URLS: '["people"]' }, path: 'OPT2_SERVICE_URLS' },
    { label: 'a map that is not JSON', env: { OPT2_SERVICE_URLS: '{people' }, path: 'OPT2_SERVICE_URLS' },
    { label: 'a Mailpit URL that is not a URL', env: { MAILPIT_API_URL: 'mailpit:8025' }, path: 'MAILPIT_API_URL' },
    { label: 'a Mailpit URL that is not HTTP', env: { MAILPIT_API_URL: 'ftp://mail.test' }, path: 'MAILPIT_API_URL' },
  ])('throws GoldenConfigError naming the variable path of $label', ({ env, path: key }) => {
    expect(() => resolveSideEffectConfig(env)).toThrow(GoldenConfigError);
    const message = new RegExp(`^invalid side-effect configuration: ${key.replaceAll('.', '\\.')}: \\S`);
    expect(() => resolveSideEffectConfig(env)).toThrow(message);
  });
});

describe('serviceUrl', () => {
  it('returns the resolved OPT2_SERVICE_URLS entry', () => {
    const config = resolveSideEffectConfig({ OPT2_SERVICE_URLS: '{"people":"http://people.fixture.test//"}' });

    expect(serviceUrl(config, 'people')).toBe('http://people.fixture.test');
  });

  it.each([
    { label: 'the map is unset', map: undefined },
    { label: 'the map lacks the service', map: '{"identity":"http://x.test"}' },
  ])('throws GoldenConfigError when $label', ({ map }) => {
    const config = resolveSideEffectConfig({ OPT2_SERVICE_URLS: map });

    expect(() => serviceUrl(config, 'people')).toThrow(GoldenConfigError);
    expect(() => serviceUrl(config, 'people')).toThrow(/^OPT2_SERVICE_URLS has no URL for people; /);
  });
});

describe('resetMailpit', () => {
  it.each([
    { label: 'MAILPIT_API_URL', env: { MAILPIT_API_URL: `${MAILPIT}/` }, origin: MAILPIT },
    { label: 'the default Mailpit URL', env: {}, origin: new URL(DEFAULT_MAILPIT_URL).origin },
  ])('deletes every message at $label, then requires the list to report none', async ({ env, origin }) => {
    const http = fakeHttp()
      .route('DELETE', `${origin}/api/v1/messages`, () => new Response('ok'))
      .route('GET', `${origin}/api/v1/messages`, () => json({ total: 0, messages: [] }));

    await resetMailpit(env, { fetch: http.fetch });

    expect(http.to(origin)).toStrictEqual(['DELETE /api/v1/messages', 'GET /api/v1/messages?start=0&limit=1']);
  });

  it.each([
    {
      label: 'DELETE answers 500',
      deleted: 500,
      list: () => json({ total: 0, messages: [] }),
      error: /Mailpit DELETE \/api\/v1\/messages answered 500/,
    },
    {
      label: 'messages remain',
      deleted: 200,
      list: () => json({ total: 2, messages: [] }),
      error: /Mailpit still holds 2 messages after DELETE/,
    },
    { label: 'the list answers 503', deleted: 200, list: () => json({}, 503), error: /message list answered 503/ },
    { label: 'the list has no total', deleted: 200, list: () => json({ messages: [] }), error: /carries no total/ },
  ])('rejects with SideEffectError when $label', async ({ deleted, list, error }) => {
    const http = fakeHttp()
      .route('DELETE', `${MAILPIT}/api/v1/messages`, () => new Response('', { status: deleted }))
      .route('GET', `${MAILPIT}/api/v1/messages`, list);

    const err = await failure(resetMailpit(scenarioEnv(), { fetch: http.fetch }));

    expect(err).toBeInstanceOf(SideEffectError);
    expect(err.message).toMatch(error);
  });
});

describe('collectMail', () => {
  const MESSAGES: MailFixture[] = [
    {
      ID: 'FIXTURE-M1',
      message: {
        From: { Name: 'Masa CMS', Address: 'admin@example.com' },
        To: [{ Name: '', Address: 'zed@example.test' }],
        Subject: 'Password reset',
        Text: 'Reset link',
        HTML: '<html><head><title>Ignored</title></head><body><p>Reset <b>link</b></p></body></html>',
      },
      headers: { 'Message-ID': ['<FIXTURE-1@example.test>'], Subject: ['Password reset'] },
    },
    {
      ID: 'FIXTURE-M2',
      message: {
        From: { Name: null, Address: 'noreply@example.test' },
        To: [{ Name: 'Amy', Address: 'amy@example.test' }, { Address: 'bob@example.test' }],
        Subject: 'Password reset',
        Text: null,
        HTML: '<p>Fragment &amp; <i>text</i></p>',
      },
      headers: { Date: ['Tue, 30 Jun 2026 09:00:00 +0000'] },
    },
    { ID: 'FIXTURE-M3', message: { From: null, To: null, Subject: null, Text: 'plain', HTML: null }, headers: {} },
  ];

  it('pages the list and maps each message, HTML body as text, sorted by subject then first recipient', async () => {
    const http = mailpit(fakeHttp(), MESSAGES, { pageSize: 2 });

    const mail = await collectMail(scenarioEnv(), { fetch: http.fetch });

    expect(mail).toStrictEqual([
      { to: [], from: '', subject: '', text: 'plain', htmlText: '', headers: {} },
      {
        to: ['Amy <amy@example.test>', 'bob@example.test'],
        from: 'noreply@example.test',
        subject: 'Password reset',
        text: '',
        htmlText: 'Fragment & text',
        headers: { Date: ['Tue, 30 Jun 2026 09:00:00 +0000'] },
      },
      {
        to: ['zed@example.test'],
        from: 'Masa CMS <admin@example.com>',
        subject: 'Password reset',
        text: 'Reset link',
        htmlText: 'Reset link',
        headers: { 'Message-ID': ['<FIXTURE-1@example.test>'], Subject: ['Password reset'] },
      },
    ]);
    expect(http.to(MAILPIT).filter((call) => call.startsWith('GET /api/v1/messages'))).toStrictEqual([
      'GET /api/v1/messages?start=0&limit=250',
      'GET /api/v1/messages?start=2&limit=250',
    ]);
  });

  it('maps the recorded forgot-password message with its headers, beside a recorded template send', async () => {
    const fixture = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(new URL(`../fixtures/mail/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
    const list = fixture('mailpit-list.json');
    const forgot = fixture('mailpit-message.json') as { Text: string; HTML: string; Headers: Record<string, string[]> };
    const send = {
      From: { Name: 'Tenant A Communications', Address: 'communications@example.test' },
      To: [{ Name: 'Blake Recipient', Address: 'blake.recipient@example.test' }],
      Subject: 'June programme update',
      Text: 'Hello Blake,',
      HTML: '<p>Hello <b>Blake</b>,</p>',
    };
    const at = (id: string): string => `${MAILPIT}/api/v1/message/${id}`;
    const http = fakeHttp()
      .route('GET', `${MAILPIT}/api/v1/messages`, () => json(list))
      .route('GET', at('mpForgotMail0000000001'), () => json(forgot))
      .route('GET', `${at('mpForgotMail0000000001')}/headers`, () => json(forgot.Headers))
      .route('GET', at('mpTemplateSend00000002'), () => json(send))
      .route('GET', `${at('mpTemplateSend00000002')}/headers`, () => json({}));

    const mail = await collectMail(scenarioEnv(), { fetch: http.fetch });

    const link = 'http://127.0.0.1:8080/index.cfm/22222222-2222-2222-2222222222222222/?userID=33333333-3333-3333-3333333333333333';
    expect(mail).toStrictEqual([
      {
        to: ['Blake Recipient <blake.recipient@example.test>'],
        from: 'Tenant A Communications <communications@example.test>',
        subject: 'June programme update',
        text: 'Hello Blake,',
        htmlText: 'Hello Blake,',
        headers: {},
      },
      {
        to: ['avery.member@example.test'],
        from: 'Masa CMS <no-reply@example.test>',
        subject: 'Masa CMS Account Information',
        text: forgot.Text,
        // HTML parsing reads CRLF as LF.
        htmlText: forgot.HTML.replaceAll(/<[^>]+>/g, '').replaceAll('\r\n', '\n'),
        headers: forgot.Headers,
      },
    ]);
    const [, reset] = mail;
    expect(reset?.text).toContain(link);
    expect(reset?.htmlText).toContain(link);
    expect(reset?.htmlText).not.toMatch(/<\/?[a-z]/i);
    expect(reset?.headers.Subject).toStrictEqual(['Masa CMS Account Information']);
    expect(http.to(MAILPIT)).toStrictEqual([
      'GET /api/v1/messages?start=0&limit=250',
      'GET /api/v1/message/mpForgotMail0000000001',
      'GET /api/v1/message/mpForgotMail0000000001/headers',
      'GET /api/v1/message/mpTemplateSend00000002',
      'GET /api/v1/message/mpTemplateSend00000002/headers',
    ]);
  });

  it('stops listing at an empty page even when the total claims more', async () => {
    const http = mailpit(fakeHttp(), MESSAGES.slice(0, 1), { total: () => 5 });

    const mail = await collectMail(scenarioEnv(), { fetch: http.fetch });

    expect(mail.map((m) => m.subject)).toStrictEqual(['Password reset']);
    expect(http.to(MAILPIT).filter((call) => call.startsWith('GET /api/v1/messages'))).toHaveLength(2);
  });

  it.each([
    { label: 'its detail', path: '', error: /Mailpit message FIXTURE-M1 answered 404/ },
    { label: 'its headers', path: '/headers', error: /Mailpit headers of FIXTURE-M1 answered 404/ },
  ])('rejects with SideEffectError when a message cannot be read: $label', async ({ path: suffix, error }) => {
    const http = mailpit(fakeHttp(), MESSAGES.slice(0, 1));
    http.route('GET', `${MAILPIT}/api/v1/message/FIXTURE-M1${suffix}`, () => json({}, 404));

    const err = await failure(collectMail(scenarioEnv(), { fetch: http.fetch }));

    expect(err).toBeInstanceOf(SideEffectError);
    expect(err.message).toMatch(error);
  });
});

describe('waitForMail', () => {
  it('returns the count once Mailpit holds mail that has not grown for MAIL_QUIET_MS', async () => {
    const http = mailCounts(fakeHttp(), 0, 1, 2);
    const clock = fakeClock();

    const count = await waitForMail(scenarioEnv(), 60_000, { fetch: http.fetch, sleep: clock.sleep, now: clock.now });

    expect(count).toBe(2);
    expect(clock.elapsed()).toBe(2 * SETTLE_POLL_MS + MAIL_QUIET_MS);
  });

  it('returns the last count at its bound when no mail arrives', async () => {
    const http = mailCounts(fakeHttp(), 0);
    const clock = fakeClock();

    expect(await waitForMail(scenarioEnv(), 5_000, { fetch: http.fetch, sleep: clock.sleep, now: clock.now })).toBe(0);
    expect(clock.elapsed()).toBe(5_000);
  });

  it('sleeps through node:timers/promises and reads Date.now when no clock is injected', async () => {
    const http = mailCounts(fakeHttp(), 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(delay)
      .mockClear()
      .mockImplementation(async (ms) => {
        vi.advanceTimersByTime(ms ?? 0);
      });
    try {
      expect(await waitForMail(scenarioEnv(), 5_000, { fetch: http.fetch })).toBe(0);
      expect(vi.mocked(delay).mock.calls).toStrictEqual(Array.from({ length: 5 }, () => [SETTLE_POLL_MS]));
      expect(http.to(MAILPIT)).toStrictEqual(Array.from({ length: 6 }, () => 'GET /api/v1/messages?start=0&limit=1'));
    } finally {
      vi.mocked(delay).mockReset();
      vi.useRealTimers();
    }
  });
});

describe('loadTableOwnership', () => {
  it('returns the tables and units of the file', async () => {
    const file = path.join(stateDir, 'ownership.json');
    writeFileSync(file, JSON.stringify({ sourceSha: 'fixture', tables: [TUSERS], units: OWNERSHIP.units }));

    expect(await loadTableOwnership(file)).toStrictEqual({ tables: [TUSERS], units: OWNERSHIP.units });
  });

  it.each([
    { label: 'is missing', text: undefined, error: /cannot be read: ENOENT/ },
    { label: 'is not JSON', text: '{tables', error: /cannot be read: / },
    { label: 'has no units array', text: '{"tables":[]}', error: /has no tables and units arrays/ },
    { label: 'is a JSON array', text: '[]', error: /has no tables and units arrays/ },
  ])('throws GoldenConfigError naming the file when it $label', async ({ text, error }) => {
    const file = path.join(stateDir, 'ownership.json');
    if (text !== undefined) writeFileSync(file, text);

    const err = await failure(loadTableOwnership(file));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toMatch(error);
    expect((err as GoldenConfigError).path).toBe(file);
  });
});

describe('legacyRows', () => {
  it('encodes one snapshot per target unit over its key and owned columns, rows chosen by its predicate', async () => {
    const sql = await fakeSql(legacyDb());

    const snapshots = await legacyRows(BY_SITE, { mssql: sql.mssql, ownership: OWNERSHIP });

    expect(snapshots).toStrictEqual(LEGACY_USERS);
    expect(sql.queries).toStrictEqual([
      {
        sql:
          'SELECT COLUMN_NAME, DATA_TYPE, NUMERIC_SCALE FROM INFORMATION_SCHEMA.COLUMNS ' +
          'WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION',
        params: { schema: 'dbo', table: 'tusers' },
      },
      {
        sql:
          'SELECT [UserID], [GroupName], [Fname], [UserName], [Email], [Type], [SiteID] ' +
          'FROM [dbo].[tusers] WHERE [SiteID] = @w0',
        params: { w0: 'default' },
      },
    ]);
    expect(sql.queries.every((q) => /^(SELECT|WITH)\b/.test(q.sql))).toBe(true);
  });

  it('keeps a NULL column distinct from an empty string', async () => {
    const sql = await fakeSql(legacyDb());

    const [, person] = await legacyRows(BY_SITE, { mssql: sql.mssql, ownership: OWNERSHIP });
    const nullName = encodeRow(PERSON_COLUMNS, U2);
    const emptyName = encodeRow(PERSON_COLUMNS, U3);

    expect(nullName).not.toBe(emptyName);
    expect(person?.rows).toContain(nullName);
    expect(person?.rows).toContain(emptyName);
  });

  it('keeps duplicate rows of a keyless table', async () => {
    const sql = await fakeSql(legacyDb());

    const snapshots = await legacyRows(
      { table: 'temailstats', where: { EmailID: 'FIXTURE-E1' } },
      { mssql: sql.mssql, ownership: OWNERSHIP },
    );

    expect(snapshots).toStrictEqual([
      snapshot(
        {
          unit: 'communications.email_stat',
          owner: 'communications',
          legacyTable: 'temailstats',
          columns: STAT_COLUMNS,
          keyColumns: [],
          keyless: true,
        },
        [STAT, STAT, OTHER_STAT],
      ),
    ]);
  });

  it('reads a Program_<n> table from its schema, selecting each type through an exact-value expression', async () => {
    const row = {
      record_id: 'FIXTURE-R1',
      siteID: 'tenant-b',
      title: 'Quarterly close',
      amount: '1234.50',
      fee: '12.3400',
      created: '2026-06-30 09:15:00.1230000',
      period: '2026-06-30 00:00:00.0000000',
      content: Buffer.from('FIXTURE-bytes'),
      approved: true,
      ratio: 0.25,
    };
    const sql = await fakeSql({
      'Program_2.finance_record': {
        columns: [
          ['record_id', 'uniqueidentifier'],
          ['siteID', 'varchar'],
          ['title', 'ntext'],
          ['amount', 'decimal', 2],
          ['fee', 'money', 4],
          ['created', 'datetime'],
          ['period', 'date'],
          ['content', 'image'],
          ['approved', 'bit'],
          ['ratio', 'float'],
        ],
        rows: [row],
      },
    });
    const columns = [
      col('record_id', 's'),
      col('siteID', 's'),
      col('title', 's'),
      col('amount', 'd', 2),
      col('fee', 'd', 4),
      col('created', 't'),
      col('period', 't'),
      col('content', 'b'),
      col('approved', 'i'),
      col('ratio', 'f'),
    ];

    const snapshots = await legacyRows(
      { table: 'Program_2.finance_record', where: { record_id: 'FIXTURE-R1' } },
      { mssql: sql.mssql, ownership: OWNERSHIP },
    );

    const record = { unit: 'finance.record', owner: 'finance', legacyTable: 'Program_N.finance_record' };
    expect(snapshots).toStrictEqual([snapshot({ ...record, columns, keyColumns: ['record_id'] }, [row])]);
    expect(sql.queries[0]?.params).toStrictEqual({ schema: 'Program_2', table: 'finance_record' });
    expect(sql.queries[1]?.sql).toBe(
      'SELECT [record_id], [siteID], CAST([title] AS nvarchar(max)) AS [title], ' +
        'CONVERT(varchar(64), [amount]) AS [amount], CONVERT(varchar(64), [fee], 2) AS [fee], ' +
        'CONVERT(varchar(27), CAST([created] AS datetime2(7)), 121) AS [created], ' +
        'CONVERT(varchar(27), CAST([period] AS datetime2(7)), 121) AS [period], ' +
        'CAST([content] AS varbinary(max)) AS [content], [approved], [ratio] ' +
        'FROM [Program_2].[finance_record] WHERE [record_id] = @w0',
    );
  });

  interface SplitCase {
    label: string;
    entry: OwnershipTable;
    db: LegacyDb;
    idColumn: string;
    columns: CanonicalColumn[];
    expected: Record<string, string[]>;
    lookups: string[];
  }

  const addressTargets = [
    target('identity.user_address', 'identity', 'owner Type = 1', ['addressID'], ['userID', 'address1']),
    target('people.user_address', 'people', 'owner Type = 2', ['addressID'], ['userID', 'address1']),
  ];
  const ownerTypes = { rows: [{ UserID: 'FIXTURE-U1', Type: 1 }, { UserID: 'FIXTURE-U2', Type: 2 }] };
  const baseTableTargets = (unit: string, key: string, owned: string[]): OwnershipTarget[] => [
    target(`content.${unit}`, 'strategies-content', "baseTable = 'tcontent'", [key], owned),
    target(`people.${unit}`, 'people', "baseTable in ('tusers', 'tusersaddresses')", [key], owned),
  ];
  const CONTENT = 'strategies-content';
  const TRASH_OWNED = ['objectClass', 'objectLabel'];
  const ACTIVITY = 'tclassextenddatauseractivity';
  const ACTIVITY_UNIT = 'extend_data_user_activity';
  const SPLIT_CASES: SplitCase[] = [
    {
      label: "the owning user's Type through the parent join",
      entry: table({
        table: 'tuseraddresses',
        split: { by: 'ownerType', parent: { table: 'tusers', join: 'tuseraddresses.userID = tusers.UserID' } },
        targets: addressTargets,
      }),
      db: {
        'dbo.tuseraddresses': {
          columns: [['addressID', 'char'], ['userID', 'char'], ['siteID', 'varchar'], ['address1', 'nvarchar']],
          rows: [
            { addressID: 'FIXTURE-A1', userID: 'FIXTURE-U1', siteID: 'default', address1: '1 Main St' },
            { addressID: 'FIXTURE-A2', userID: 'FIXTURE-U2', siteID: 'default', address1: '2 Main St' },
            { addressID: 'FIXTURE-A3', userID: 'FIXTURE-U9', siteID: 'default', address1: '3 Main St' },
          ],
        },
        'dbo.tusers': ownerTypes,
      },
      idColumn: 'addressID',
      columns: [col('addressID', 's'), col('userID', 's'), col('address1', 's')],
      expected: { 'identity.user_address': ['FIXTURE-A1'], 'people.user_address': ['FIXTURE-A2'] },
      lookups: ['SELECT [UserID] AS k, [Type] AS v FROM [dbo].[tusers] WHERE [UserID] IN (@k0, @k1, @k2)'],
    },
    {
      label: "the owning user's Type through the parent join, then the address join",
      entry: table({
        table: ACTIVITY,
        split: {
          by: 'ownerType',
          parent: { table: 'tusers', join: `${ACTIVITY}.baseID = tusers.UserID` },
          addressJoin: `${ACTIVITY}.baseID = tuseraddresses.addressID, then tuseraddresses.userID = tusers.UserID`,
        },
        targets: [
          target(`identity.${ACTIVITY_UNIT}`, 'identity', 'owner Type = 1', ['dataID'], ['baseID', 'attributeValue']),
          target(`people.${ACTIVITY_UNIT}`, 'people', 'owner Type = 2', ['dataID'], ['baseID', 'attributeValue']),
        ],
      }),
      db: {
        [`dbo.${ACTIVITY}`]: {
          columns: [['dataID', 'char'], ['baseID', 'char'], ['siteID', 'varchar'], ['attributeValue', 'ntext']],
          rows: [
            { dataID: 'FIXTURE-D1', baseID: 'FIXTURE-U1', siteID: 'default', attributeValue: 'one' },
            { dataID: 'FIXTURE-D2', baseID: 'FIXTURE-A2', siteID: 'default', attributeValue: 'two' },
            { dataID: 'FIXTURE-D3', baseID: 'FIXTURE-NONE', siteID: 'default', attributeValue: 'three' },
          ],
        },
        'dbo.tusers': ownerTypes,
        'dbo.tuseraddresses': { rows: [{ addressID: 'FIXTURE-A2', userID: 'FIXTURE-U2' }] },
      },
      idColumn: 'dataID',
      columns: [col('dataID', 's'), col('baseID', 's'), col('attributeValue', 's')],
      expected: { [`identity.${ACTIVITY_UNIT}`]: ['FIXTURE-D1'], [`people.${ACTIVITY_UNIT}`]: ['FIXTURE-D2'] },
      lookups: [
        'SELECT [UserID] AS k, [Type] AS v FROM [dbo].[tusers] WHERE [UserID] IN (@k0, @k1, @k2)',
        'SELECT [addressID] AS k, [userID] AS v FROM [dbo].[tuseraddresses] WHERE [addressID] IN (@k0, @k1)',
        'SELECT [UserID] AS k, [Type] AS v FROM [dbo].[tusers] WHERE [UserID] IN (@k0)',
      ],
    },
    {
      label: 'a baseTable list reached through split.resolve',
      entry: table({
        table: 'tclassextendsets',
        split: { by: 'baseTable', resolve: 'tclassextendsets.subTypeID = tclassextend.subTypeID' },
        targets: baseTableTargets('extend_set', 'extendSetID', ['subTypeID', 'name']),
      }),
      db: {
        'dbo.tclassextendsets': {
          columns: [['extendSetID', 'char'], ['subTypeID', 'char'], ['siteID', 'varchar'], ['name', 'nvarchar']],
          rows: ['S1', 'S2', 'S3'].map((n) => ({
            extendSetID: `FIXTURE-E${n}`,
            subTypeID: `FIXTURE-${n}`,
            siteID: 'default',
            name: n,
          })),
        },
        'dbo.tclassextend': {
          rows: [
            { subTypeID: 'FIXTURE-S1', baseTable: 'tcontent' },
            { subTypeID: 'FIXTURE-S2', baseTable: 'TUsers' },
            { subTypeID: 'FIXTURE-S3', baseTable: 'tsettings' },
          ],
        },
      },
      idColumn: 'extendSetID',
      columns: [col('extendSetID', 's'), col('subTypeID', 's'), col('name', 's')],
      expected: { 'content.extend_set': ['FIXTURE-ES1'], 'people.extend_set': ['FIXTURE-ES2'] },
      lookups: [
        'SELECT [subTypeID] AS k, [baseTable] AS v FROM [dbo].[tclassextend] WHERE [subTypeID] IN (@k0, @k1, @k2)',
      ],
    },
    {
      label: 'a baseTable column of the row itself',
      entry: table({
        table: 'tclassextend',
        split: { by: 'baseTable', resolve: 'tclassextend.baseTable' },
        targets: baseTableTargets('extend_subtype', 'subTypeID', ['baseTable', 'subType']),
      }),
      db: {
        'dbo.tclassextend': {
          columns: [['subTypeID', 'char'], ['siteID', 'varchar'], ['baseTable', 'varchar'], ['subType', 'varchar']],
          rows: [
            { subTypeID: 'FIXTURE-S1', siteID: 'default', baseTable: 'tcontent', subType: 'Page' },
            { subTypeID: 'FIXTURE-S2', siteID: 'default', baseTable: 'TUSERSADDRESSES  ', subType: 'Home' },
            { subTypeID: 'FIXTURE-S3', siteID: 'default', baseTable: 'tsettings', subType: 'Site' },
          ],
        },
      },
      idColumn: 'subTypeID',
      columns: [col('subTypeID', 's'), col('baseTable', 's'), col('subType', 's')],
      expected: { 'content.extend_subtype': ['FIXTURE-S1'], 'people.extend_subtype': ['FIXTURE-S2'] },
      lookups: [],
    },
    {
      label: 'a bit column the driver reads as a boolean',
      entry: table({
        table: 'synthetic.flag',
        schema: 'synthetic',
        targets: [
          target('finance.active_flag', 'finance', 'active = 1', ['flagID'], ['active']),
          target('finance.inactive_flag', 'finance', 'active = 0', ['flagID'], ['active']),
        ],
      }),
      db: {
        'synthetic.flag': {
          columns: [['flagID', 'char'], ['siteID', 'varchar'], ['active', 'bit']],
          rows: [
            { flagID: 'FIXTURE-F1', siteID: 'default', active: true },
            { flagID: 'FIXTURE-F2', siteID: 'default', active: false },
            { flagID: 'FIXTURE-F3', siteID: 'default', active: null },
          ],
        },
      },
      idColumn: 'flagID',
      columns: [col('flagID', 's'), col('active', 'i')],
      expected: { 'finance.active_flag': ['FIXTURE-F1'], 'finance.inactive_flag': ['FIXTURE-F2'] },
      lookups: [],
    },
    {
      label: 'the classMap owner of the object class',
      entry: table({
        table: 'ttrash',
        split: {
          by: 'objectClass',
          classMap: [
            { classes: ['content', 'feed'], owner: 'strategies-content' },
            { classes: ['group'], owner: 'identity' },
            { classes: ['user'], ownerBy: 'stored Type' },
          ],
        },
        targets: [
          target('content.trash', CONTENT, `classMap owner = ${CONTENT}`, ['objectID'], TRASH_OWNED),
          target('identity.trash', 'identity', 'classMap owner = identity', ['objectID'], TRASH_OWNED),
        ],
      }),
      db: {
        'dbo.ttrash': {
          columns: [
            ['objectID', 'char'],
            ['siteID', 'varchar'],
            ['objectClass', 'varchar'],
            ['objectLabel', 'nvarchar'],
          ],
          rows: [
            { objectID: 'FIXTURE-T1', siteID: 'default', objectClass: 'content', objectLabel: 'Home' },
            { objectID: 'FIXTURE-T2', siteID: 'default', objectClass: 'Feed', objectLabel: 'News' },
            { objectID: 'FIXTURE-T3', siteID: 'default', objectClass: 'group', objectLabel: 'Editors' },
          ],
        },
      },
      idColumn: 'objectID',
      columns: [col('objectID', 's'), col('objectClass', 's'), col('objectLabel', 's')],
      expected: { 'content.trash': ['FIXTURE-T1', 'FIXTURE-T2'], 'identity.trash': ['FIXTURE-T3'] },
      lookups: [],
    },
  ];

  it.each(SPLIT_CASES)('assigns rows to units by $label', async (c) => {
    const { entry, db, idColumn, columns, expected, lookups } = c;
    const sql = await fakeSql(db);
    const rows = Object.values(db)[0]?.rows ?? [];
    const rowsOf = (ids: string[]): Record<string, unknown>[] =>
      rows.filter((row) => ids.includes(row[idColumn] as string));

    const snapshots = await legacyRows(
      { table: entry.table, where: { siteID: 'default' } },
      { mssql: sql.mssql, ownership: withTables(entry) },
    );

    expect(Object.fromEntries(snapshots.map((s) => [s.unit, s.rows]))).toStrictEqual(
      Object.fromEntries(Object.entries(expected).map(([unit, ids]) => [unit, encoded(columns, rowsOf(ids))])),
    );
    for (const s of snapshots) expect(s.columns).toStrictEqual(columns);
    expect([...new Set(sql.queries.slice(2).map((q) => q.sql))]).toStrictEqual(lookups);
  });

  interface RowsErrorCase {
    label: string;
    tables?: OwnershipTable[];
    db?: LegacyDb;
    spec: { table: string; where: Record<string, unknown> };
    error: RegExp;
  }

  const addresses = (split: OwnershipSplit): OwnershipTable =>
    table({ table: 'tuseraddresses', split, targets: addressTargets });
  const addressDb = (users: Record<string, unknown>[]): LegacyDb =>
    legacyDb({
      'dbo.tuseraddresses': {
        columns: [['addressID', 'char'], ['userID', 'char'], ['siteID', 'varchar'], ['address1', 'nvarchar']],
        rows: [{ addressID: 'FIXTURE-A1', userID: 'FIXTURE-U1', siteID: 'default', address1: '1 Main St' }],
      },
      'dbo.tusers': { rows: users },
    });
  const trash = table({
    table: 'ttrash',
    split: {
      classMap: [
        { classes: ['content'], owner: CONTENT },
        { classes: ['user'], ownerBy: 'stored Type' },
      ],
    },
    targets: [target('content.trash', CONTENT, `classMap owner = ${CONTENT}`, ['objectID'], ['objectClass'])],
  });
  const trashDb = (objectClass: string): LegacyDb => ({
    'dbo.ttrash': {
      columns: [['objectID', 'char'], ['siteID', 'varchar'], ['objectClass', 'varchar']],
      rows: [
        { objectID: 'FIXTURE-T1', siteID: 'default', objectClass: 'content' },
        { objectID: 'FIXTURE-T9', siteID: 'default', objectClass },
      ],
    },
  });
  const addressesBySite = { table: 'tuseraddresses', where: { siteID: 'default' } };
  const trashBySite = { table: 'ttrash', where: { siteID: 'default' } };

  const OWNER_JOIN = 'tuseraddresses.userID = tusers.UserID';
  const BACKWARD_JOIN = 'tusers.UserID = tuseraddresses.userID';
  const accountsOnly = (rowPredicate: string | null, owned: string[]): OwnershipTable =>
    table({ table: 'tusers', targets: [target('identity.user_account', 'identity', rowPredicate, ['UserID'], owned)] });

  const ROWS_ERRORS: RowsErrorCase[] = [
    {
      label: 'a table the ownership file does not list',
      spec: { table: 'tfixture_absent', where: { siteid: 'default' } },
      error: /rows: tfixture_absent is not a table of opt2\/table-ownership\.json/,
    },
    {
      label: 'a table owned by no target unit',
      spec: { table: 'tclustercommands', where: { siteid: 'default' } },
      error: /tclustercommands maps to no target unit \(owner legacy\)/,
    },
    {
      label: 'a table the live catalog lacks',
      tables: [table({ table: 'tfixture_gone', targets: [target('identity.gone', 'identity', null, ['id'], ['id'])] })],
      spec: { table: 'tfixture_gone', where: { id: 'x' } },
      error: /dbo\.tfixture_gone has no columns in the live catalog/,
    },
    {
      label: 'a where column the catalog lacks',
      spec: { table: 'tusers', where: { nosuch: 'x' } },
      error: /nosuch is not a live column of dbo\.tusers/,
    },
    {
      label: 'an owned column the catalog lacks',
      tables: [accountsOnly(null, ['Ghost'])],
      spec: BY_SITE,
      error: /Ghost is not a live column of dbo\.tusers/,
    },
    { label: 'an empty where', spec: { table: 'tusers', where: {} }, error: /dbo\.tusers needs at least one where/ },
    {
      label: 'a where value that is not a scalar',
      spec: { table: 'tusers', where: { UserID: { id: 1 } } },
      error: /where UserID on dbo\.tusers does not resolve to a scalar/,
    },
    {
      label: 'a row predicate capture cannot read',
      tables: [accountsOnly('Type > 2', ['UserName'])],
      spec: BY_SITE,
      error: /unit identity\.user_account has a row predicate golden capture cannot read: Type > 2/,
    },
    {
      label: 'a join chain that does not start at the table',
      tables: [addresses({ by: 'ownerType', parent: { table: 'tusers', join: BACKWARD_JOIN } })],
      db: addressDb([]),
      spec: addressesBySite,
      error: /join chain 'tusers\.UserID = tuseraddresses\.userID' does not start at tuseraddresses/,
    },
    {
      label: 'an owner predicate without a join',
      tables: [addresses({ by: 'ownerType' })],
      db: addressDb([]),
      spec: addressesBySite,
      error: /tuseraddresses has no join in table-ownership\.json that reaches Type/,
    },
    {
      label: 'a join key naming rows with different values',
      tables: [addresses({ by: 'ownerType', parent: { table: 'tusers', join: OWNER_JOIN } })],
      db: addressDb([{ UserID: 'FIXTURE-U1', Type: 1 }, { UserID: 'fixture-u1', Type: 2 }]),
      spec: addressesBySite,
      error: /tusers\.UserID fixture-u1 names rows with different Type/,
    },
    {
      label: 'a class without a classMap entry',
      tables: [trash],
      db: trashDb('widget'),
      spec: trashBySite,
      error: /ttrash class widget has no classMap entry/,
    },
    {
      label: 'a class whose owner stored data decides',
      tables: [trash],
      db: trashDb('user'),
      spec: trashBySite,
      error: /ttrash class user is owned by stored Type, which row capture does not decide/,
    },
  ];

  it.each(ROWS_ERRORS)('throws GoldenConfigError for $label', async ({ tables = [], db = legacyDb(), spec, error }) => {
    const sql = await fakeSql(db);

    const err = await failure(legacyRows(spec as RowSpec, { mssql: sql.mssql, ownership: withTables(...tables) }));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toMatch(error);
  });
});

describe('targetRows', () => {
  /** Collaborators over the fixture ownership, scenario environment and fixture invoker. */
  async function rowDeps(http: FakeHttp, sql: FakeSql, env: EnvLike = {}): Promise<TargetRowDeps> {
    const invoker = await fixtureInvoker();
    return { env: scenarioEnv(env), mssql: sql.mssql, ownership: OWNERSHIP, invoker, fetch: http.fetch };
  }

  it("reads each unit's export from its owner, bounding a unit without the where column by sibling keys", async () => {
    const http = userExports(fakeHttp());
    const sql = await fakeSql(legacyDb());

    const snapshots = await targetRows(BY_USERNAME, await rowDeps(http, sql));

    expect(snapshots).toStrictEqual(TARGET_USERS);
    expect(sql.queries.map((q) => q.sql)).toStrictEqual(['SELECT [SiteID] AS siteId FROM [dbo].[tsettings]']);
    const pages = (owner: string): string[] =>
      http.calls
        .filter((call) => call.url.origin === serviceBase(owner))
        .map((call) => ['unit', 'siteId', 'after'].map((name) => call.url.searchParams.get(name)).join('|'));
    expect(pages('identity')).toStrictEqual([
      'identity.user_account|default|',
      `identity.user_account|default|${CURSOR}`,
      'identity.user_account|tenant-a|',
      'identity.group_account|default|',
      'identity.group_account|tenant-a|',
    ]);
    expect(pages('people')).toStrictEqual(['people.person|default|', 'people.person|tenant-a|']);
    for (const call of http.calls) {
      expect(call.method).toBe('GET');
      expect(call.url.pathname).toBe('/internal/v1/migration/export');
      expect(call.url.searchParams.get('limit')).toBe(String(MAX_EXPORT_LIMIT));
      expect(call.url.searchParams.has('programId')).toBe(false);
      expect(call.headers[INVOCATION_HEADER]).toBe(TOKEN);
    }
    expect(new Set(minted.map((m) => `${m.name} ${m.url}`))).toStrictEqual(
      new Set([`identity ${serviceBase('identity')}`, `people ${serviceBase('people')}`]),
    );
  });

  it("reads a Program_<n> table's export in the program's site with its programId", async () => {
    const columns = [col('blackout_id', 's'), col('day_id', 's'), col('reason', 's')];
    const blackouts = [
      { blackout_id: 'FIXTURE-B1', day_id: 'FIXTURE-D1', reason: 'Holiday' },
      { blackout_id: 'FIXTURE-B2', day_id: 'FIXTURE-D2', reason: 'Closure' },
    ];
    const http = exportService(fakeHttp(), 'timesheets', [
      {
        unit: 'timesheets.blackout',
        siteId: 'tenant-b',
        programId: '2',
        tables: [exportTable('timesheets.blackout', 'Program_2.blackout', columns, ['blackout_id'], blackouts)],
      },
    ]);
    const sql = await fakeSql({
      'synthetic.program_site': {
        rows: [
          { program_id: 1, siteID: 'tenant-a' },
          { program_id: 2, siteID: 'tenant-b  ' },
        ],
      },
    });

    const snapshots = await targetRows(
      { table: 'Program_2.blackout', where: { day_id: 'FIXTURE-D1' } },
      await rowDeps(http, sql),
    );

    const blackout = { unit: 'timesheets.blackout', owner: 'timesheets', legacyTable: 'Program_N.blackout' };
    const [first] = blackouts;
    expect(snapshots).toStrictEqual([snapshot({ ...blackout, columns, keyColumns: ['blackout_id'] }, [first ?? {}])]);
    expect(sql.queries).toStrictEqual([
      {
        sql: 'SELECT [siteID] AS siteId FROM [synthetic].[program_site] WHERE [program_id] = @programId',
        params: { programId: 2 },
      },
    ]);
  });

  /** Export of synthetic.sample per site, holding one row per `values` entry of column `v`. */
  function sampleWorld(v: CanonicalColumn, values: unknown[], sites: string[] = ['default', 'tenant-a']): FakeHttp {
    const columns = [col('id', 's'), col('siteID', 's'), v];
    const rowsOf = (siteId: string): Record<string, unknown>[] =>
      values.map((value, i) => ({ id: `FIXTURE-${siteId}-${i}`, siteID: siteId, v: value }));
    return exportService(
      fakeHttp(),
      'finance',
      sites.map((siteId) => ({
        unit: 'finance.sample',
        siteId,
        tables: [exportTable('finance.sample', 'synthetic.sample', columns, ['id'], rowsOf(siteId))],
      })),
    );
  }

  const STAMP = '2026-06-30T09:15:00.000';
  const [S, I, D, F, T] = [col('v', 's'), col('v', 'i'), col('v', 'd', 2), col('v', 'f'), col('v', 't')];

  it.each([
    { label: 'text ignoring case and trailing spaces', v: S, stored: 'Tenant-A  ', wanted: 'tenant-a', kept: 1 },
    { label: 'different text', v: S, stored: 'tenant-b', wanted: 'tenant-a', kept: 0 },
    { label: 'an integer against a boolean', v: I, stored: 1, wanted: true, kept: 1 },
    { label: 'an integer against its text', v: I, stored: 2, wanted: '2', kept: 1 },
    { label: 'a decimal against a number', v: D, stored: '12.50', wanted: 12.5, kept: 1 },
    { label: 'a float against its text', v: F, stored: 0.25, wanted: '0.25', kept: 1 },
    { label: 'a timestamp against wall-clock text', v: T, stored: STAMP, wanted: '2026-06-30 09:15:00', kept: 1 },
    { label: 'a timestamp against text that is no time', v: T, stored: STAMP, wanted: 'FIXTURE-noon', kept: 0 },
    { label: 'NULL against any value', v: S, stored: null, wanted: 'tenant-a', kept: 0 },
  ])('compares a where value as SQL Server does: $label', async ({ v, stored, wanted, kept }) => {
    const http = sampleWorld(v, [stored]);
    const sql = await fakeSql(legacyDb({ 'dbo.tsettings': { rows: [{ SiteID: 'default' }] } }));

    const [sample] = await targetRows({ table: 'synthetic.sample', where: { v: wanted } }, await rowDeps(http, sql));

    expect(sample?.rows).toHaveLength(kept);
  });

  it('reads only the tenant of the site the where names', async () => {
    const http = sampleWorld(col('v', 's'), ['x'], ['tenant-a']);
    const sql = await fakeSql(legacyDb());

    const spec = { table: 'synthetic.sample', where: { siteid: 'TENANT-A' } };
    const [sample] = await targetRows(spec, await rowDeps(http, sql));

    expect(sample?.rows).toHaveLength(1);
    expect(http.calls.map((call) => call.url.searchParams.get('siteId'))).toStrictEqual(['tenant-a']);
  });

  it('keeps each duplicate row of a keyless export, across tenants', async () => {
    const stats = (rows: Record<string, unknown>[]): ExportTable[] => [
      exportTable('communications.email_stat', 'temailstats', STAT_COLUMNS, [], rows),
    ];
    const http = exportService(fakeHttp(), 'communications', [
      { unit: 'communications.email_stat', siteId: 'default', tables: stats([STAT, STAT, OTHER_STAT]) },
      { unit: 'communications.email_stat', siteId: 'tenant-a', tables: stats([STAT]) },
    ]);
    const sql = await fakeSql(legacyDb());

    const snapshots = await targetRows(
      { table: 'temailstats', where: { EmailID: 'FIXTURE-E1' } },
      await rowDeps(http, sql),
    );

    const stat = { unit: 'communications.email_stat', owner: 'communications', legacyTable: 'temailstats' };
    expect(snapshots).toStrictEqual([
      snapshot({ ...stat, columns: STAT_COLUMNS, keyColumns: [], keyless: true }, [STAT, STAT, OTHER_STAT, STAT]),
    ]);
    expect(snapshots[0]?.rows.filter((row) => row === encodeRow(STAT_COLUMNS, STAT))).toHaveLength(3);
  });

  interface TargetErrorCase {
    label: string;
    env?: EnvLike;
    http: () => FakeHttp;
    spec: RowSpec;
    type: typeof GoldenConfigError | typeof SideEffectError;
    error: RegExp;
  }

  const identityAnswer = (reply: () => Response): (() => FakeHttp) => () =>
    fakeHttp().route('GET', `${serviceBase('identity')}${MIGRATION_PATH_PREFIX}/export`, reply);
  const accountPage = (tables: ExportTable[]): Response =>
    json({ unit: 'identity.user_account', tenantId: 'FIXTURE-TENANT', tables, next: null });
  const noUserName = [col('UserID', 's'), col('Type', 'i')];

  const TARGET_ERRORS: TargetErrorCase[] = [
    {
      label: 'an owner OPT2_SERVICE_URLS does not list',
      env: { OPT2_SERVICE_URLS: JSON.stringify({ people: serviceBase('people') }) },
      http: fakeHttp,
      spec: BY_USERNAME,
      type: GoldenConfigError,
      error: /OPT2_SERVICE_URLS has no URL for identity/,
    },
    {
      label: 'an export that answers 503',
      http: identityAnswer(() => json({ detail: 'FIXTURE-BODY-DETAIL' }, 503)),
      spec: BY_USERNAME,
      type: SideEffectError,
      error: /^identity export of identity\.user_account for site default answered 503$/,
    },
    {
      label: 'an export without the legacy table',
      http: identityAnswer(() => accountPage([])),
      spec: BY_USERNAME,
      type: SideEffectError,
      error: /identity export of identity\.user_account carries no tusers table/,
    },
    {
      label: 'an export without the where column',
      http: identityAnswer(() =>
        accountPage([exportTable('identity.user_account', 'tusers', noUserName, ['UserID'], [U1])]),
      ),
      spec: BY_USERNAME,
      type: SideEffectError,
      error: /export of identity\.user_account carries no column username/,
    },
    {
      label: 'a unit that owns no where column and shares no key with one that does',
      http: () => userExports(fakeHttp()),
      spec: { table: 'tusers', where: { email: 'ada@example.test' } },
      type: GoldenConfigError,
      error: /unit identity\.user_account does not own every where column of tusers, and no sibling unit that does/,
    },
    {
      label: 'a program no site maps to',
      http: fakeHttp,
      spec: { table: 'Program_3.blackout', where: { day_id: 'FIXTURE-D1' } },
      type: GoldenConfigError,
      error: /synthetic\.program_site maps no site to program 3/,
    },
    {
      label: 'a where on a binary column',
      http: () => sampleWorld(col('v', 'b'), [Buffer.from('FIXTURE')]),
      spec: { table: 'synthetic.sample', where: { v: 'ab' } },
      type: GoldenConfigError,
      error: /where on binary column v is not supported/,
    },
  ];

  it.each(TARGET_ERRORS)('rejects $label', async ({ env = {}, http: world, spec, type, error }) => {
    const http = world();
    const sql = await fakeSql(legacyDb({ 'synthetic.program_site': { rows: [] } }));

    const err = await failure(targetRows(spec, await rowDeps(http, sql, env)));

    expect(err).toBeInstanceOf(type);
    expect(err.message).toMatch(error);
    expect(err.message).not.toContain('FIXTURE-BODY-DETAIL');
  });
});

describe('scheduled tasks', () => {
  const steps = [
    step({ name: 'create', method: 'POST', route: `${SURVEYS}/`, body: { title: 'Pulse' } }),
    scheduleStep('first', '${create.surveyid}', { as: 'editor', body: { launchAt: '2026-07-01T09:00:00' } }),
    step({
      name: 'again',
      method: 'POST',
      route: `${SURVEYS}/\${create.surveyid}/schedule?SiteID=tenant-a`,
      as: 'editor',
      body: { LaunchAt: '2026-07-01T23:30:00' },
    }),
    step({
      name: 'second',
      method: 'POST',
      route: `${SURVEYS}/FIXTURE-SV-2/schedule/`,
      form: { launchAt: '2026-08-15T08:00:00' },
    }),
    step({ name: 'read', route: `${SURVEYS}/FIXTURE-SV-2/schedule` }),
  ];

  /** Context on `origin` with the survey id binding `create.surveyid`. */
  async function surveyContext(http: FakeHttp, origin: Origin = 'legacy'): Promise<ScenarioContext> {
    const ctx = await context(http, origin);
    ctx.bindings.set('create.surveyid', 'FIXTURE SV 1');
    return ctx;
  }

  it('lists each scheduled survey once, from its last scheduling request', async () => {
    const ctx = await surveyContext(fakeHttp());

    expect(scheduledSurveys(steps, ctx)).toStrictEqual([
      { surveyId: 'FIXTURE SV 1', siteId: 'tenant-a', launchAt: '2026-07-01T23:30:00', session: 'editor' },
      { surveyId: 'FIXTURE-SV-2', siteId: undefined, launchAt: '2026-08-15T08:00:00', session: undefined },
    ]);
  });

  it('skips a schedule step whose route resolves to no schedule path', async () => {
    const ctx = await surveyContext(fakeHttp());
    ctx.bindings.set('create.surveyid', 'FIXTURE/SV');

    expect(scheduledSurveys(steps.slice(0, 3), ctx)).toStrictEqual([]);
  });

  it.each([
    {
      label: 'a schedule step over a matrix',
      step: step({
        name: 'each',
        method: 'POST',
        route: `${SURVEYS}/FIXTURE-SV-2/schedule?siteid=\${matrix.site}`,
        matrix: { site: ['a', 'b'] },
        body: { launchAt: '2026-07-01T09:00:00' },
      }),
      error: /GS-SE-01: step each schedules surveys over a matrix/,
    },
    {
      label: 'a launchAt without seconds',
      step: scheduleStep('late', 'FIXTURE-SV-2', { body: { launchAt: '2026-07-01 09:00' } }),
      error: /step late schedules a survey without a YYYY-MM-DDTHH:MM:SS launchAt/,
    },
    {
      label: 'no launchAt',
      step: scheduleStep('late', 'FIXTURE-SV-2', {}),
      error: /step late schedules a survey without a YYYY-MM-DDTHH:MM:SS launchAt/,
    },
  ])('throws GoldenConfigError for $label', async ({ step: bad, error }) => {
    const ctx = await surveyContext(fakeHttp());

    expect(() => scheduledSurveys([bad], ctx)).toThrow(GoldenConfigError);
    expect(() => scheduledSurveys([bad], ctx)).toThrow(error);
  });

  const task = (taskname: string, kind: string, route: string, offsetminutes: number): Record<string, unknown> => ({
    taskname,
    kind,
    route,
    offsetminutes,
  });

  it.each<Origin>(['legacy', 'gateway'])(
    'reads the prefixed tasks of each survey on the %s origin in its scheduling session, offset from the launch',
    async (origin) => {
      const base = origin === 'legacy' ? LEGACY : GATEWAY;
      const http = fakeHttp()
        .route(
          'GET',
          `${base}${SURVEYS}/FIXTURE%20SV%201/tasks`,
          tasksReply([
            task('opt2-survey-sv1-launch', 'launch', '/surveys/sv1/launch', 0),
            task('opt2-survey-sv1-reminder', 'reminder', '/surveys/sv1/remind', 45),
            task('manual-task', 'other', '/elsewhere', 5),
          ]),
        )
        .route(
          'GET',
          `${base}${SURVEYS}/FIXTURE-SV-2/tasks`,
          tasksReply([task('opt2-survey-sv2-close', 'close', '/surveys/sv2/close', 14 * 24 * 60)]),
        );
      const ctx = await surveyContext(http, origin);

      const tasks = await collectTasks(TASKS, ctx, steps);

      const launch = '2026-07-01T23:30:00';
      expect(tasks).toStrictEqual([
        {
          name: 'opt2-survey-sv1-launch',
          kind: 'launch',
          target: '/surveys/sv1/launch',
          scheduledAt: launch,
          base: launch,
        },
        {
          name: 'opt2-survey-sv1-reminder',
          kind: 'reminder',
          target: '/surveys/sv1/remind',
          scheduledAt: '2026-07-02T00:15:00',
          base: launch,
        },
        {
          name: 'opt2-survey-sv2-close',
          kind: 'close',
          target: '/surveys/sv2/close',
          scheduledAt: '2026-08-29T08:00:00',
          base: '2026-08-15T08:00:00',
        },
      ]);
      expect(sentWithCookies(http)).toStrictEqual([
        `${SURVEYS}/FIXTURE%20SV%201/tasks?siteid=tenant-a CFID=FIXTURE-editor`,
        `${SURVEYS}/FIXTURE-SV-2/tasks CFID=FIXTURE-default`,
      ]);
    },
  );

  it.each([
    { label: 'answers 500', reply: () => json({}, 500), error: /tasks of survey FIXTURE-SV-2 answered 500/ },
    { label: 'answers without data.items', reply: () => json({ data: {} }), error: /answered without data\.items/ },
    { label: 'spans several pages', reply: tasksReply([], 2), error: /tasks of survey FIXTURE-SV-2 span 2 pages/ },
    {
      label: 'lists a task without its offset',
      reply: tasksReply([{ taskname: 'opt2-survey-x', kind: 'launch', route: '/r' }]),
      error: /a task of survey FIXTURE-SV-2 lacks taskname, kind, route or offsetminutes/,
    },
  ])('rejects with SideEffectError when the task list $label', async ({ reply, error }) => {
    const http = fakeHttp().route('GET', `${LEGACY}${SURVEYS}/FIXTURE-SV-2/tasks`, reply);
    const ctx = await surveyContext(http);

    const err = await failure(collectTasks(TASKS, ctx, [steps[3] as Step]));

    expect(err).toBeInstanceOf(SideEffectError);
    expect(err.message).toMatch(error);
  });
});

describe('stored files', () => {
  const steps = [
    step({ name: 'upload', method: 'POST', route: '/admin/upload', as: 'editor' }),
    step({ name: 'replace', method: 'POST', route: '/admin/upload' }),
    step({
      name: 'each',
      method: 'POST',
      route: '/admin/upload',
      as: '${matrix.who}',
      matrix: { who: ['default', 'editor'] },
    }),
  ];

  it("lists each step's non-empty fileid binding once, with the session of the step that bound it first", async () => {
    const ctx = await context(fakeHttp());
    const bindings: [string, unknown][] = [
      ['upload.fileid', 'FIXTURE-F1'],
      ['replace.FileID', 'fixture-f1'],
      ['replace.fileId', 'FIXTURE-F2'],
      ['each.fileid', 'FIXTURE-F3'],
      ['each.contentid', 'FIXTURE-C1'],
      ['gone.fileid', 'FIXTURE-F9'],
      ['fileid', 'FIXTURE-F8'],
      ['upload.FILEID', ''],
      ['replace.fileid', 7],
    ];
    for (const [key, value] of bindings) ctx.bindings.set(key, value);

    expect(writtenFiles(steps, ctx)).toStrictEqual([
      { fileId: 'FIXTURE-F1', session: 'editor' },
      { fileId: 'FIXTURE-F2', session: undefined },
      { fileId: 'FIXTURE-F3', session: undefined },
    ]);
  });

  it('records each render variant that answers 200 by content type, SHA-256 of its bytes and size', async () => {
    const medium = Buffer.from('FIXTURE-medium-rendition');
    const note = Buffer.from('FIXTURE plain note');
    const text = 'text/plain; charset=utf-8';
    const renders: Record<string, Record<string, Response>> = {
      'FIXTURE-F1': {
        file: new Response(TINY_PDF, { headers: { 'content-type': 'application/pdf' } }),
        small: new Response('', { status: 404 }),
        medium: new Response(medium, { headers: { 'content-type': 'image/jpeg' } }),
      },
      'FIXTURE F2': { file: new Response(note, { headers: { 'content-type': text } }) },
    };
    const http = fakeHttp();
    for (const [, size] of RENDER_VARIANTS) {
      http.route('GET', `${LEGACY}/_api/render/${size}/`, (url) => {
        const reply = renders[url.searchParams.get('fileID') ?? '']?.[size];
        return reply ?? new Response('', { status: 404 });
      });
    }
    const ctx = await context(http);

    const files = await collectFiles(
      [
        { fileId: 'FIXTURE-F1', session: 'editor' },
        { fileId: 'FIXTURE F2', session: undefined },
      ],
      ctx,
    );

    const pdf = { contentType: 'application/pdf', sha256: sha256Hex(TINY_PDF), size: TINY_PDF.length };
    expect(files).toStrictEqual([
      { fileId: 'FIXTURE-F1', name: 'original', ...pdf },
      { fileId: 'FIXTURE-F1', name: '_medium', contentType: 'image/jpeg', sha256: sha256Hex(medium), size: 24 },
      { fileId: 'FIXTURE F2', name: 'original', contentType: text, sha256: sha256Hex(note), size: note.length },
    ]);
    expect(sentWithCookies(http)).toStrictEqual([
      '/_api/render/file/?fileID=FIXTURE-F1 CFID=FIXTURE-editor',
      '/_api/render/small/?fileID=FIXTURE-F1 CFID=FIXTURE-editor',
      '/_api/render/medium/?fileID=FIXTURE-F1 CFID=FIXTURE-editor',
      '/_api/render/file/?fileID=FIXTURE+F2 CFID=FIXTURE-default',
      '/_api/render/small/?fileID=FIXTURE+F2 CFID=FIXTURE-default',
      '/_api/render/medium/?fileID=FIXTURE+F2 CFID=FIXTURE-default',
    ]);
  });
});

describe('pushSubscriptions', () => {
  it("lists every push path of the service contracts as the consuming service and its topic", async () => {
    const subscriptions = await pushSubscriptions();

    expect(subscriptions).toContainEqual({ consumer: 'timesheets', topic: 'people.person.archived.v1' });
    expect(subscriptions).toContainEqual({ consumer: 'communications', topic: 'identity.login-mail.requested.v1' });
    for (const { consumer, topic } of subscriptions) {
      expect(SERVICES).toContain(consumer);
      expect(topic).toMatch(/^[a-z-]+\.[\w.-]+\.v\d+$/);
    }
  });

  it('throws GoldenConfigError naming a contract that cannot be read', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT: FIXTURE missing contract'));

    const err = await failure(pushSubscriptions());

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toMatch(/contract .*services\/identity\/contracts\/openapi\.yaml cannot be read: ENOENT/);
  });

  it.each(['/internal/v1/events/people.identity.group.changed.v1', '/internal/v1/events/identity'])(
    'throws GoldenConfigError for the push path %s that is not a subscription of its own service',
    async (route) => {
      vi.mocked(readFile).mockResolvedValueOnce(`openapi: 3.1.0\npaths:\n  ${route}:\n    post: {}\n`);

      const err = await failure(pushSubscriptions());

      expect(err).toBeInstanceOf(GoldenConfigError);
      expect(err.message).toContain(`push path ${route} is not a subscription of identity`);
    },
  );
});

describe('settleHook', () => {
  const TOPIC = 'people.person.archived.v1';
  const EVENT = '0F1E2D3C-0000-4000-8000-00000000A001';

  /** Scripts `service`'s migration position, answering each query through `answer`. */
  function position(
    http: FakeHttp,
    service: string,
    answer: (query: URLSearchParams) => Partial<PositionResponse>,
  ): FakeHttp {
    return http.route('GET', `${serviceBase(service)}${MIGRATION_PATH_PREFIX}/position`, (url) =>
      json({ owner: service, position: '1', outbox: null, inbox: null, ...answer(url.searchParams) }),
    );
  }

  /** Hook collaborators: the scripted fetch, the fixture invoker and, when given, the fake clock. */
  async function hookDeps(http: FakeHttp, clock?: FakeClock, extra: SideEffectDeps = {}): Promise<SideEffectDeps> {
    const timing = clock === undefined ? {} : { sleep: clock.sleep, now: clock.now };
    return { fetch: http.fetch, invoker: await fixtureInvoker(), ...timing, ...extra };
  }

  /** Consumers the service contracts subscribe to `topic`. */
  async function consumersOf(topic: string): Promise<string[]> {
    return (await pushSubscriptions()).filter((s) => s.topic === topic).map((s) => s.consumer);
  }

  const drained = { tenants: [], unpublished: 0, held: 0 };
  const receipts = (tenant: string): Partial<PositionResponse> => ({
    inbox: { total: 1, bySubscription: {}, receipts: { [EVENT]: [tenant] } },
  });

  it('waits for mail until Mailpit has been quiet for MAIL_QUIET_MS', async () => {
    const http = mailCounts(fakeHttp(), 0, 1);
    const clock = fakeClock();
    const ctx = await context(http);

    await settleHook(ctx, undefined, { fetch: http.fetch, sleep: clock.sleep, now: clock.now })('mail', 60_000);

    expect(clock.elapsed()).toBe(SETTLE_POLL_MS + MAIL_QUIET_MS);
  });

  it("waits for tasks until the scenario's task list is non-empty and unchanged for TASKS_QUIET_MS", async () => {
    const task = { taskname: 'opt2-survey-sv2-launch', kind: 'launch', route: '/surveys/sv2/launch', offsetminutes: 0 };
    const tasks = inTurn(tasksReply([]), tasksReply([task]));
    const http = fakeHttp().route('GET', `${LEGACY}${SURVEYS}/FIXTURE-SV-2/tasks`, tasks);
    const clock = fakeClock();
    const ctx = await context(http);
    const schedule = scheduleStep('schedule', 'FIXTURE-SV-2', { body: { launchAt: '2026-07-01T09:00:00' } });
    const scenario = { steps: [schedule], tasks: TASKS };

    await settleHook(ctx, scenario, { sleep: clock.sleep, now: clock.now })('tasks', 60_000);

    expect(clock.elapsed()).toBe(SETTLE_POLL_MS + TASKS_QUIET_MS);
  });

  it.each([
    { label: 'no scenario', scenario: undefined },
    { label: 'a scenario without tasks', scenario: { steps: [] } },
  ])('rejects a tasks settle given $label', async ({ scenario }) => {
    const ctx = await context(fakeHttp());

    const err = await failure(settleHook(ctx, scenario)('tasks', 1_000));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toBe('GS-SE-01: settle tasks needs the scenario and its tasks declaration');
  });

  it.each(['bogus', 'seam:', 'mail:'])('rejects the settle %s', async (spec) => {
    const ctx = await context(fakeHttp());

    const err = await failure(settleHook(ctx)(spec as 'seam', 1_000));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toMatch(/^unknown settle /);
  });

  it.each(['seam', `seam:${TOPIC}`, 'projection', 'projection:people'] as const)(
    'resolves %s on legacy without a request or query',
    async (spec) => {
      const http = fakeHttp();
      const sql = await fakeSql({});
      const ctx = await context(http);

      await settleHook(ctx, undefined, await hookDeps(http, undefined, { mssql: sql.mssql }))(spec, 1_000);

      expect(http.calls).toStrictEqual([]);
      expect(sql.queries).toStrictEqual([]);
    },
  );

  it('waits for a seam until the producer outbox drains and each consumer has a receipt in its tenant', async () => {
    const consumers = await consumersOf(TOPIC);
    let unpublished = 1;
    const http = position(fakeHttp(), 'people', (q) => {
      expect(q.get('publishedTopics')).toBe(TOPIC);
      const published = [{ eventId: EVENT, topic: TOPIC, tenantId: 'Tenant-A' }];
      const answer = { outbox: { ...drained, unpublished }, published };
      unpublished = 0;
      return answer;
    });
    for (const consumer of consumers) {
      position(http, consumer, (q) => {
        expect(q.get('eventIds')).toBe(EVENT.toLowerCase());
        return receipts('TENANT-A');
      });
    }
    const clock = fakeClock();
    const ctx = await context(http, 'gateway');

    await settleHook(ctx, undefined, await hookDeps(http, clock))(`seam:${TOPIC}`, 5_000);

    expect(consumers).toContain('timesheets');
    expect(http.to(serviceBase('people'))).toHaveLength(2);
    for (const call of http.calls) expect(call.headers[INVOCATION_HEADER]).toBe(TOKEN);
    expect(clock.elapsed()).toBe(0);
  });

  it('waits for every topic when the seam names none', async () => {
    const subscriptions = await pushSubscriptions();
    const producers = [...new Set(subscriptions.map((s) => s.topic.slice(0, s.topic.indexOf('.'))))];
    const http = fakeHttp();
    for (const producer of producers) position(http, producer, () => ({ outbox: drained, published: [] }));
    const ctx = await context(http, 'gateway');

    await settleHook(ctx, undefined, await hookDeps(http))('seam', 5_000);

    expect(new Set(http.calls.map((call) => call.url.origin))).toStrictEqual(new Set(producers.map(serviceBase)));
  });

  it('rejects a seam with SettleTimeoutError naming the deliveries that lack a receipt at its bound', async () => {
    const published = [{ eventId: EVENT, topic: TOPIC, tenantId: 'tenant-a' }];
    const http = position(fakeHttp(), 'people', () => ({ outbox: drained, published }));
    for (const consumer of await consumersOf(TOPIC)) position(http, consumer, () => receipts('tenant-b'));
    const clock = fakeClock();
    const ctx = await context(http, 'gateway');

    const err = await failure(settleHook(ctx, undefined, await hookDeps(http, clock))(`seam:${TOPIC}`, 3_000));

    expect(err).toBeInstanceOf(SettleTimeoutError);
    expect(err).toBeInstanceOf(SideEffectError);
    expect(err.message).toContain(
      `settle seam ${TOPIC}: after 3000 ms 0 outbox rows are unpublished or held and 1 deliveries lack a receipt`,
    );
    expect(err.message).toContain(`timesheets:${EVENT.toLowerCase()}`);
    expect(clock.elapsed()).toBe(3_000);
  });

  interface SeamErrorCase {
    label: string;
    spec: `seam:${string}`;
    status: number;
    answer: Partial<PositionResponse>;
    type: typeof GoldenConfigError | typeof SideEffectError;
    error: RegExp;
  }

  it.each<SeamErrorCase>([
    {
      label: 'a topic no contract subscribes to',
      spec: 'seam:fixture.nothing.changed.v1',
      status: 200,
      answer: {},
      type: GoldenConfigError,
      error: /no service contract subscribes to fixture\.nothing\.changed\.v1/,
    },
    {
      label: 'a producer position without published events',
      spec: `seam:${TOPIC}`,
      status: 200,
      answer: { outbox: drained },
      type: SideEffectError,
      error: /people answered position without its published events/,
    },
    {
      label: 'a producer position that answers 500',
      spec: `seam:${TOPIC}`,
      status: 500,
      answer: {},
      type: SideEffectError,
      error: /people migration position answered 500/,
    },
  ])('rejects a seam on $label', async ({ spec, status, answer, type, error }) => {
    const http = fakeHttp().route('GET', `${serviceBase('people')}${MIGRATION_PATH_PREFIX}/position`, () =>
      json({ owner: 'people', position: '1', outbox: null, inbox: null, ...answer }, status),
    );
    const ctx = await context(http, 'gateway');

    const err = await failure(settleHook(ctx, undefined, await hookDeps(http))(spec, 1_000));

    expect(err).toBeInstanceOf(type);
    expect(err.message).toMatch(error);
  });

  const CHECKPOINTS = 'opt2_sync.projector_checkpoint';
  const CHECKPOINT_SQL =
    'SELECT [owner] AS owner, [tenant_id] AS tenantId, CONVERT(varchar(20), [applied_horizon]) AS horizon ' +
    'FROM [opt2_sync].[projector_checkpoint]';
  const LIVE_SITES_SQL = 'SELECT [SiteID] AS siteId FROM [dbo].[tsettings]';
  const STATUS_PATH = '/internal/v1/cutover/status';
  // The live sites of legacyDb(): `default` and `tenant-a  `, whose trailing spaces the projector drops.
  const DEFAULT_TENANT = tenantIdForSite('default');
  const TENANT_A = tenantIdForSite('tenant-a');
  const TENANTS = [DEFAULT_TENANT, TENANT_A].sort();
  const TWO_OWNERS = {
    OPT2_SERVICE_URLS: JSON.stringify({ identity: serviceBase('identity'), people: serviceBase('people') }),
  };
  const GROUPS: CutoverGroups = {
    groups: [
      { id: 'grp:identity', units: ['identity.user_account', 'identity.group_account'] },
      { id: 'grp:people', units: ['people.person'] },
      { id: 'grp:communications', units: ['communications.email_stat'] },
    ],
  };
  const PROJECTION_OWNERSHIP: TableOwnership = {
    tables: OWNERSHIP.tables,
    units: [...OWNERSHIP.units, { unit: 'people.person', owner: 'people' }],
  };
  const IDENTITY_AND_PEOPLE = { 'grp:identity': 'target', 'grp:people': 'target', 'grp:communications': 'legacy' };

  /** The reverse projector's checkpoint table holding `rows` of `owner`, `tenant_id`, `applied_horizon`. */
  function checkpoints(...rows: [owner: string, tenant: string, horizon: string][]): LegacyTable {
    return { rows: rows.map(([owner, tenant_id, applied_horizon]) => ({ owner, tenant_id, applied_horizon })) };
  }

  /** Scripts the gateway's cut-over status reporting `groupAuthority`. */
  function cutover(http: FakeHttp, groupAuthority: Record<string, string>): FakeHttp {
    return http.route('GET', `${GATEWAY}${STATUS_PATH}`, () =>
      json({ tableVersion: 'v0002', previous: 'v0001', epoch: 2, groupAuthority, instances: [] }),
    );
  }

  /** Gateway reporting `authority`, positions people 120 and identity 50, legacy sites and `rows` as checkpoints. */
  async function projectionWorld(authority: Record<string, string>, rows: LegacyTable, clock = fakeClock()) {
    const db = legacyDb({ [CHECKPOINTS]: rows });
    const http = position(cutover(fakeHttp(), authority), 'people', () => ({ position: '120' }));
    position(http, 'identity', () => ({ position: '50' }));
    const sql = await fakeSql(db);
    const ctx = await context(http, 'gateway', scenarioEnv(TWO_OWNERS));
    const deps = await hookDeps(http, clock, { mssql: sql.mssql, ownership: PROJECTION_OWNERSHIP, groups: GROUPS });
    return { db, http, sql, clock, hook: settleHook(ctx, undefined, deps) };
  }

  it.each([
    { spec: 'projection' as const, asked: ['gateway', 'identity', 'people'] },
    { spec: 'projection:people' as const, asked: ['gateway', 'people'] },
  ])(
    "waits for $spec until each target-authoritative owner's checkpoint in every live tenant passes its position",
    async ({ spec, asked }) => {
      const world = await projectionWorld(
        IDENTITY_AND_PEOPLE,
        checkpoints(['people', `${DEFAULT_TENANT.toUpperCase()} `, '100']),
        fakeClock(() => {
          world.db[CHECKPOINTS] = checkpoints(
            ['people', DEFAULT_TENANT, '121'],
            ['people', TENANT_A, '130'],
            ['identity', DEFAULT_TENANT, '60'],
            ['identity', TENANT_A, '51'],
          );
        }),
      );

      await world.hook(spec, 10_000);

      expect(world.http.calls.map((call) => call.url.hostname.split('.')[0])).toStrictEqual(asked);
      expect(world.http.calls[0]?.headers[INVOCATION_HEADER]).toBe(TOKEN);
      expect(world.clock.elapsed()).toBe(SETTLE_POLL_MS);
      expect(world.sql.queries.map((q) => q.sql)).toStrictEqual(Array(2).fill([LIVE_SITES_SQL, CHECKPOINT_SQL]).flat());
    },
  );

  it.each([
    {
      label: 'the checkpoint table is empty',
      spec: 'projection' as const,
      rows: checkpoints(),
      lagging: [...TENANTS.map((t) => `identity/${t}`), ...TENANTS.map((t) => `people/${t}`)],
    },
    {
      label: 'an awaited owner has no checkpoint',
      spec: 'projection' as const,
      rows: checkpoints(['identity', DEFAULT_TENANT, '51'], ['identity', TENANT_A, '51']),
      lagging: TENANTS.map((t) => `people/${t}`),
    },
    {
      label: 'a live tenant has no checkpoint',
      spec: 'projection:people' as const,
      rows: checkpoints(['people', DEFAULT_TENANT, '200']),
      lagging: [`people/${TENANT_A}`],
    },
    {
      label: 'a horizon equals the position',
      spec: 'projection:people' as const,
      rows: checkpoints(['people', DEFAULT_TENANT, '120'], ['people', TENANT_A, '121']),
      lagging: [`people/${DEFAULT_TENANT}`],
    },
  ])(
    'rejects a projection with SettleTimeoutError naming each pair still behind when $label',
    async ({ spec, rows, lagging }) => {
      const { hook, clock } = await projectionWorld(IDENTITY_AND_PEOPLE, rows);

      const err = await failure(hook(spec, 2_500));

      expect(err).toBeInstanceOf(SettleTimeoutError);
      expect(err.message).toBe(`settle projection: after 2500 ms the projector lags ${lagging.join(', ')}`);
      expect(clock.elapsed()).toBe(2_500);
    },
  );

  it.each<{ label: string; spec: 'projection' | 'projection:people'; authority: Record<string, string> }>([
    { label: 'no version is active', spec: 'projection', authority: {} },
    {
      label: 'every group is legacy-authoritative',
      spec: 'projection',
      authority: { 'grp:identity': 'legacy', 'grp:people': 'legacy', 'grp:communications': 'legacy' },
    },
    {
      label: 'the named owner is legacy-authoritative',
      spec: 'projection:people',
      authority: { 'grp:identity': 'target' },
    },
  ])('resolves a projection with neither a position read nor a query when $label', async ({ spec, authority }) => {
    const { hook, http, sql } = await projectionWorld(authority, checkpoints());

    await hook(spec, 1_000);

    expect(http.to(GATEWAY)).toStrictEqual([`GET ${STATUS_PATH}`]);
    expect(http.calls).toHaveLength(1);
    expect(sql.queries).toStrictEqual([]);
  });

  interface ProjectionErrorCase {
    label: string;
    spec: 'projection' | `projection:${string}`;
    status?: Handler;
    groups?: CutoverGroups;
    env?: EnvLike;
    type: new (...args: never[]) => Error;
    error: RegExp;
  }

  it.each<ProjectionErrorCase>([
    {
      label: 'an owner that owns no unit',
      spec: 'projection:peeple',
      type: GoldenConfigError,
      error: /^settle projection: peeple owns no unit of opt2\/table-ownership\.json$/,
    },
    {
      label: 'a target unit outside the ownership units',
      spec: 'projection',
      groups: { groups: [{ id: 'grp:people', units: ['people.person', 'fixture.unknown'] }] },
      type: GoldenConfigError,
      error: /^settle projection: unit fixture\.unknown of group grp:people is not in opt2\/table-ownership\.json$/,
    },
    {
      label: 'a cut-over status without groupAuthority',
      spec: 'projection',
      status: () => json({ tableVersion: null, epoch: 0, instances: [] }),
      type: SideEffectError,
      error: /^gateway cut-over status carries no groupAuthority/,
    },
    {
      label: 'a gateway that refuses the connection',
      spec: 'projection',
      status: () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
      type: GatewayUnreachable,
      error: /^gateway at http:\/\/gateway\.fixture\.test refused the connection; /,
    },
    {
      label: 'an awaited owner OPT2_SERVICE_URLS does not list',
      spec: 'projection:people',
      env: { OPT2_SERVICE_URLS: JSON.stringify({ identity: serviceBase('identity') }) },
      type: GoldenConfigError,
      error: /^OPT2_SERVICE_URLS has no URL for people; /,
    },
  ])('rejects a projection on $label', async ({ spec, status, groups = GROUPS, env = TWO_OWNERS, type, error }) => {
    const http = cutover(fakeHttp(), IDENTITY_AND_PEOPLE);
    if (status !== undefined) http.route('GET', `${GATEWAY}${STATUS_PATH}`, status);
    const sql = await fakeSql(legacyDb());
    const ctx = await context(http, 'gateway', scenarioEnv(env));
    const deps = await hookDeps(http, undefined, { mssql: sql.mssql, ownership: PROJECTION_OWNERSHIP, groups });

    const err = await failure(settleHook(ctx, undefined, deps)(spec, 1_000));

    expect(err).toBeInstanceOf(type);
    expect(err.message).toMatch(error);
    expect(sql.queries).toStrictEqual([]);
  });

  it.each([
    { label: 'answers 403', status: 403, body: { error: 'forbidden-body-text' } },
    { label: 'answers 200 with a body that is not CutoverStatus', status: 200, body: { error: 'not-status-body-text' } },
  ])('rejects a projection whose cut-over status $label, naming the status and never the body', async ({ status, body }) => {
    const http = fakeHttp().route('GET', `${GATEWAY}${STATUS_PATH}`, () => json(body, status));
    const sql = await fakeSql(legacyDb());
    const ctx = await context(http, 'gateway', scenarioEnv(TWO_OWNERS));
    const deps = await hookDeps(http, undefined, { mssql: sql.mssql, ownership: PROJECTION_OWNERSHIP, groups: GROUPS });

    const err = await failure(settleHook(ctx, undefined, deps)('projection', 1_000));

    expect(err).toBeInstanceOf(SideEffectError);
    expect(err.message).toBe(`gateway cut-over status answered ${status}`);
    expect(err.message).not.toContain(body.error);
    expect(err.cause).toBeInstanceOf(CutoverRequestFailed);
    expect(sql.queries).toStrictEqual([]);
  });

  it('rejects a projection whose own invoker finds no local signing keys', async () => {
    const ctx = await context(fakeHttp(), 'gateway');

    const err = await failure(settleHook(ctx)('projection:people', 1_000));

    expect(err.message).toMatch(/^Local secrets missing: /);
  });

  it('rejects a projection whose own SQL client has no connection settings, over the committed groups', async () => {
    const committed = await loadCutoverGroups();
    const group = committed.groups.find((g) => g.units.includes('people.person'));
    if (group === undefined) throw new Error('gateway/cutover/groups.json has no group holding people.person');
    const http = position(cutover(fakeHttp(), { [group.id]: 'target' }), 'people', () => ({ position: '120' }));
    const ctx = await context(http, 'gateway');

    const err = await failure(settleHook(ctx, undefined, await hookDeps(http))('projection:people', 1_000));

    expect(err.message).toBe(
      'SQL Server connection settings missing: MURA_DBHOST, MURA_DATABASE, MURA_DBUSERNAME, MURA_DBPASSWORD',
    );
    expect(http.to(serviceBase('people'))).toStrictEqual([`GET ${MIGRATION_PATH_PREFIX}/position`]);
  });
});

describe('loadCutoverGroups', () => {
  it('reads the committed groups, every unit of which is a unit of opt2/table-ownership.json', async () => {
    const [{ groups }, ownership] = await Promise.all([loadCutoverGroups(), loadTableOwnership()]);
    const units = new Set(ownership.units.map((u) => u.unit));

    expect(groups.length).toBeGreaterThan(0);
    expect(groups.flatMap((g) => g.units).filter((unit) => !units.has(unit))).toStrictEqual([]);
  });

  it.each([
    {
      label: 'cannot be read',
      read: () => vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT: FIXTURE')),
      error: /cannot be read: ENOENT/,
    },
    {
      label: 'lacks units',
      read: () => vi.mocked(readFile).mockResolvedValueOnce('{"groups":[{"id":"grp:x"}]}'),
      error: /has no groups of ids and units/,
    },
  ])('throws GoldenConfigError naming a groups file that $label', async ({ read, error }) => {
    read();

    const err = await failure(loadCutoverGroups('/fixture/groups.json'));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toMatch(/^cut-over groups \/fixture\/groups\.json /);
    expect(err.message).toMatch(error);
  });
});

describe('collectSideEffects', () => {
  const MAIL: MailFixture = {
    ID: 'FIXTURE-M1',
    message: {
      From: { Address: 'admin@example.com' },
      To: [{ Address: 'ada@example.test' }],
      Subject: 'Welcome',
      Text: 'Hi',
      HTML: '',
    },
    headers: {},
  };
  const upload = step({ name: 'upload', method: 'POST', route: '/admin/upload' });
  const launch = '2026-07-01T09:00:00';
  const schedule = scheduleStep('schedule', 'FIXTURE-SV-2', { body: { launchAt: launch } });
  const task = { taskname: 'opt2-survey-sv2-launch', kind: 'launch', route: '/surveys/sv2/launch', offsetminutes: 0 };
  const pdf = (): Response => new Response(TINY_PDF, { headers: { 'content-type': 'application/pdf' } });

  /** Mailpit, render and task routes on legacy, with the legacy fixtures and a scenario reaching every collector. */
  async function world(compare: CompareKind[], rows: RowSpec[] = [BY_SITE]) {
    const http = mailpit(fakeHttp(), [MAIL])
      .route('GET', `${LEGACY}${SURVEYS}/FIXTURE-SV-2/tasks`, tasksReply([task]))
      .route('GET', `${LEGACY}/_api/render/file/`, pdf)
      .route('GET', `${LEGACY}/_api/render/small/`, () => new Response('', { status: 404 }))
      .route('GET', `${LEGACY}/_api/render/medium/`, () => new Response('', { status: 404 }));
    const sql = await fakeSql(legacyDb());
    const clock = fakeClock();
    const ctx = await context(http);
    ctx.bindings.set('upload.fileid', 'FIXTURE-F1');
    ctx.bindings.set('signup.username', 'fixture-ada');
    const scenario = { compare, rows, tasks: TASKS, steps: [schedule, upload] };
    const deps: SideEffectDeps = {
      fetch: http.fetch,
      mssql: sql.mssql,
      ownership: OWNERSHIP,
      sleep: clock.sleep,
      now: clock.now,
      mailTimeoutMs: 30_000,
    };
    return { http, sql, ctx, scenario, deps };
  }

  /** What a run read: `mailpit`, `tasks` and `files` requests, `sql` queries. */
  function channels(http: FakeHttp, sql: FakeSql): string[] {
    const read = new Set<string>();
    for (const call of http.calls) {
      if (call.url.origin === MAILPIT) read.add('mailpit');
      else if (call.url.pathname.startsWith(SURVEYS)) read.add('tasks');
      else if (call.url.pathname.startsWith('/_api/render/')) read.add('files');
      else read.add(`${call.url.origin}${call.url.pathname}`);
    }
    if (sql.queries.length > 0) read.add('sql');
    return [...read].sort();
  }

  it.each<{ compare: CompareKind[]; read: string[] }>([
    { compare: ['status', 'envelope', 'dom'], read: [] },
    { compare: ['mail'], read: ['mailpit'] },
    { compare: ['rows'], read: ['sql'] },
    { compare: ['tasks'], read: ['tasks'] },
    { compare: ['files'], read: ['files'] },
    { compare: ['status', 'mail', 'rows', 'tasks', 'files'], read: ['files', 'mailpit', 'sql', 'tasks'] },
  ])('collects only the side effects $compare asks for', async ({ compare, read }) => {
    const { http, sql, ctx, scenario, deps } = await world(compare);

    const effects = await collectSideEffects(ctx, scenario, 'legacy', deps);

    expect(channels(http, sql)).toStrictEqual(read);
    expect(http.calls.filter((call) => call.method !== 'GET')).toStrictEqual([]);
    expect(sql.queries.filter((q) => !/^(SELECT|WITH)\b/.test(q.sql))).toStrictEqual([]);
    expect(effects.mail.length > 0).toBe(compare.includes('mail'));
    expect(Object.keys(effects.rows).length > 0).toBe(compare.includes('rows'));
    expect(effects.tasks.length > 0).toBe(compare.includes('tasks'));
    expect(effects.files.length > 0).toBe(compare.includes('files'));
    expect('legacyRows' in effects).toBe(false);
  });

  it('collects every kind on legacy, leaving the injected SQL client open', async () => {
    const { ctx, scenario, sql, deps } = await world(['mail', 'rows', 'tasks', 'files']);
    const close = vi.spyOn(sql.mssql, 'close');

    const effects = await collectSideEffects(ctx, scenario, undefined, deps);

    const welcome = { to: ['ada@example.test'], from: 'admin@example.com', subject: 'Welcome', text: 'Hi' };
    expect(effects).toStrictEqual({
      mail: [{ ...welcome, htmlText: '', headers: {} }],
      rows: {
        'identity.group_account': LEGACY_USERS[2],
        'identity.user_account': LEGACY_USERS[0],
        'people.person': LEGACY_USERS[1],
      },
      tasks: [{ name: task.taskname, kind: 'launch', target: task.route, scheduledAt: launch, base: launch }],
      files: [
        {
          fileId: 'FIXTURE-F1',
          name: 'original',
          contentType: 'application/pdf',
          sha256: sha256Hex(TINY_PDF),
          size: TINY_PDF.length,
        },
      ],
    });
    expect(close).not.toHaveBeenCalled();
  });

  it('merges row scopes by unit, keeping a keyed row once and keyless rows per scope', async () => {
    const scopes: RowSpec[] = [
      BY_SITE,
      { table: 'tusers', where: { UserName: '${signup.username}' } },
      { table: 'temailstats', where: { EmailID: 'FIXTURE-E1' } },
      { table: 'temailstats', where: { EmailID: 'FIXTURE-E1' } },
    ];
    const { ctx, scenario, deps } = await world(['rows'], scopes);

    const { rows } = await collectSideEffects(ctx, scenario, 'legacy', deps);

    expect(Object.keys(rows)).toStrictEqual([
      'communications.email_stat',
      'identity.group_account',
      'identity.user_account',
      'people.person',
    ]);
    expect(rows['identity.user_account']?.rows).toStrictEqual(encoded(ACCOUNT_COLUMNS, [U1, U2, U3]));
    const perScope = [STAT, STAT, OTHER_STAT];
    expect(rows['communications.email_stat']?.rows).toStrictEqual(encoded(STAT_COLUMNS, [...perScope, ...perScope]));
  });

  it.each([
    { minRows: 4, error: undefined },
    { minRows: 5, error: 'GS-SE-01: rows: tusers holds 4 legacy rows within {"siteid":"default"}, fewer than its minRows 5' },
  ])('holds a scope of four legacy rows, split over three units, to minRows $minRows', async ({ minRows, error }) => {
    const { ctx, scenario, deps } = await world(['rows'], [{ ...BY_SITE, minRows }]);

    const run = collectSideEffects(ctx, scenario, 'legacy', deps);

    if (error === undefined) {
      expect((await run).rows).toStrictEqual({
        'identity.group_account': LEGACY_USERS[2],
        'identity.user_account': LEGACY_USERS[0],
        'people.person': LEGACY_USERS[1],
      });
    } else {
      const err = await failure(run);
      expect(err).toBeInstanceOf(MissingRowsError);
      expect(err.message).toBe(error);
    }
  });

  it('leaves minRows to capture, so legacy rows after a gateway replay are not held to it', async () => {
    const http = userExports(fakeHttp());
    const sql = await fakeSql(legacyDb());
    const ctx = await context(http, 'gateway');
    const rows = [{ table: 'tusers', where: { username: 'Fixture-Ada' }, minRows: 2 }];

    const effects = await collectSideEffects(ctx, { compare: ['rows'], rows, steps: [] }, 'gateway', {
      fetch: http.fetch,
      mssql: sql.mssql,
      ownership: OWNERSHIP,
      invoker: await fixtureInvoker(),
    });

    expect(effects.legacyRows?.['identity.user_account']?.rows).toStrictEqual(encoded(ACCOUNT_COLUMNS, [U1]));
  });

  it('collects target export rows on the gateway, with the legacy rows after replay beside them', async () => {
    const http = userExports(fakeHttp());
    const sql = await fakeSql(legacyDb());
    const ctx = await context(http, 'gateway');
    ctx.bindings.set('signup.username', 'Fixture-Ada');
    const rows = [{ table: 'tusers', where: { username: '${signup.username}' } }];
    const scenario = { compare: ['rows'] as CompareKind[], rows, steps: [] };

    const effects = await collectSideEffects(ctx, scenario, 'gateway', {
      fetch: http.fetch,
      mssql: sql.mssql,
      ownership: OWNERSHIP,
      invoker: await fixtureInvoker(),
    });

    expect(effects.rows).toStrictEqual({
      'identity.group_account': TARGET_USERS[2],
      'identity.user_account': TARGET_USERS[0],
      'people.person': TARGET_USERS[1],
    });
    expect(effects.legacyRows?.['identity.user_account']?.rows).toStrictEqual(encoded(ACCOUNT_COLUMNS, [U1]));
    expect(effects.legacyRows?.['people.person']?.rows).toStrictEqual(encoded(PERSON_COLUMNS, [U1]));
  });

  it('rejects side effects of an origin other than the context', async () => {
    const { ctx, scenario, deps } = await world(['status']);

    const err = await failure(collectSideEffects(ctx, scenario, 'gateway', deps));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toBe('GS-SE-01: side effects of origin gateway asked of a legacy context');
  });

  it('rejects compare tasks without a tasks declaration', async () => {
    const { ctx, scenario, deps } = await world(['tasks']);

    const err = await failure(collectSideEffects(ctx, { ...scenario, tasks: undefined }, 'legacy', deps));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toBe('GS-SE-01: compare tasks needs a tasks declaration');
  });

  it('reads opt2/table-ownership.json when no ownership is injected', async () => {
    const { ctx, scenario, deps } = await world(['rows'], [{ table: 'tfixture_absent', where: { siteid: 'default' } }]);

    const err = await failure(collectSideEffects(ctx, scenario, 'legacy', { ...deps, ownership: undefined }));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toBe('rows: tfixture_absent is not a table of opt2/table-ownership.json');
  });

  it('rejects rows when the SQL client it creates has no connection settings', async () => {
    const { ctx, scenario, deps } = await world(['rows']);

    const err = await failure(collectSideEffects(ctx, scenario, 'legacy', { ...deps, mssql: undefined }));

    expect(err.message).toMatch(/^SQL Server connection settings missing: MURA_DBHOST/);
  });

  it('rejects gateway rows when the invoker it creates finds no local signing keys', async () => {
    const sql = await fakeSql(legacyDb());
    const ctx = await context(fakeHttp(), 'gateway');

    const scenario = { compare: ['rows'] as CompareKind[], rows: [BY_SITE], steps: [] };

    const err = await failure(collectSideEffects(ctx, scenario, 'gateway', { mssql: sql.mssql, ownership: OWNERSHIP }));

    expect(err.message).toMatch(/^Local secrets missing: /);
  });
});

describe('side-effect configuration', () => {
  const MAIL: MailFixture = {
    ID: 'FIXTURE-M1',
    message: { From: { Address: 'admin@example.com' }, To: [{ Address: 'ada@example.test' }], Subject: 'Hi' },
    headers: {},
  };

  /** One public entry point run against `ctx`: two mail settles of one hook, or one mail collection. */
  const ENTRY_POINTS: { entry: string; run: (ctx: ScenarioContext, deps: SideEffectDeps) => Promise<unknown> }[] = [
    {
      entry: 'settleHook',
      run: async (ctx, deps) => {
        const hook = settleHook(ctx, undefined, deps);
        await hook('mail', 60_000);
        await hook('mail', 60_000);
      },
    },
    {
      entry: 'collectSideEffects',
      run: (ctx, deps) => collectSideEffects(ctx, { compare: ['mail'], steps: [] }, 'legacy', deps),
    },
  ];

  /** Mailpit holding one message, a fake clock and a legacy context over `env`. */
  async function world(env: EnvLike) {
    const http = mailpit(fakeHttp(), [MAIL]);
    const clock = fakeClock();
    const ctx = await context(http, 'legacy', env);
    return { http, ctx, deps: { fetch: http.fetch, sleep: clock.sleep, now: clock.now } satisfies SideEffectDeps };
  }

  it.each(ENTRY_POINTS)('$entry parses the environment once', async ({ run }) => {
    const { http, ctx, deps } = await world(scenarioEnv());
    const parse = vi.spyOn(sideEffectEnvSchema, 'safeParse');

    await run(ctx, deps);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(http.to(MAILPIT).length).toBeGreaterThan(1);
    parse.mockRestore();
  });

  it.each(ENTRY_POINTS)('$entry uses an injected configuration as-is', async ({ run }) => {
    const { http, ctx, deps } = await world(scenarioEnv({ MAILPIT_API_URL: 'not-a-url' }));
    const parse = vi.spyOn(sideEffectEnvSchema, 'safeParse');

    await run(ctx, { ...deps, config: { serviceUrls: {}, mailpitUrl: MAILPIT } });

    expect(parse).not.toHaveBeenCalled();
    expect(http.calls.length).toBeGreaterThan(1);
    expect(http.to(MAILPIT)).toHaveLength(http.calls.length);
    parse.mockRestore();
  });

  it.each(ENTRY_POINTS)('$entry rejects an invalid environment before any request', async ({ run }) => {
    const { http, ctx, deps } = await world(scenarioEnv({ MAILPIT_API_URL: 'not-a-url' }));

    const err = await failure(Promise.resolve().then(() => run(ctx, deps)));

    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err.message).toMatch(/^invalid side-effect configuration: MAILPIT_API_URL: /);
    expect(http.calls).toStrictEqual([]);
  });
});
