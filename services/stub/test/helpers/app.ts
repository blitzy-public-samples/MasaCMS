/** Shared scaffolding of the stub suites: the app built for `app.inject` over in-memory database, task and publisher fakes, or over a throwaway schema. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import type { EventPublisher } from '@opt2/platform/events';
import { baseEnvSchema, loadEnv, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import type { CreateTaskInput, CreateTaskResult, DeleteTaskResult, QueueState, TaskInfo, TaskPage, TaskPort } from '@opt2/platform/tasks';
import {
  isNonTenantTable,
  tenantDbFromPool,
  tenantIdForSite,
  type Pool,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type SiteChangedPayload,
  type TenantDb,
} from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_LIST,
  authHeadersFor,
  businessClock,
  createCapturingPublisher,
  registryPayloads,
  testPgConfig,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type RoleSubject,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import type { NoteProjectionRow, NoteRow } from '../../src/domain/note.js';
import { STUB_OWNER, STUB_SCHEMA } from '../../src/repo/repository.js';
import { STUB_UNITS } from '../../src/repo/tables.js';

let stateDir: string | undefined;
const preparedStateDirs = new Map<string, Promise<void>>();

/** Removes `dir` when the process exits or is ended by SIGTERM or SIGINT. */
function removeAtExit(dir: string): void {
  const remove = (): void => rmSync(dir, { recursive: true, force: true });
  process.once('exit', remove);
  // Vitest's fork pool ends each worker with SIGTERM, which skips 'exit'; the signal is re-raised once the directory is gone.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      remove();
      process.kill(process.pid, signal);
    });
  }
}

/** The suite process's state directory under `os.tmpdir()`, created on first use and removed when the process ends. */
function lazyStateDir(): string {
  if (stateDir === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), 'opt2-stub-test-'));
    removeAtExit(dir);
    stateDir = dir;
  }
  return stateDir;
}

/** Writes the local test secrets into `dir` once per directory. */
function prepareStateDir(dir: string): Promise<void> {
  let prepared = preparedStateDirs.get(dir);
  if (prepared === undefined) {
    prepared = writeTestSecrets(dir);
    preparedStateDirs.set(dir, prepared);
  }
  return prepared;
}

/** Raw environment that `loadEnv(baseEnvSchema)` accepts for the stub in local mode; an override of `undefined` removes the variable. */
export function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    PORT: '8199',
    OPT2_SERVICE_NAME: STUB_OWNER,
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: process.env.PG_HOST || '127.0.0.1',
    PG_PORT: process.env.PG_PORT || '5432',
    PG_USER: process.env.PG_USER || 'stub_app',
    PG_PASSWORD: process.env.PG_PASSWORD || 'unused',
    PG_DATABASE: process.env.PG_DATABASE || 'opt2',
    PUBSUB_EMULATOR_HOST: process.env.PUBSUB_EMULATOR_HOST || undefined,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || 'opt2-local',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    // Never fetched: testVerifier() replaces JWKS verification.
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_SERVICE_URLS: JSON.stringify({ [STUB_OWNER]: 'http://127.0.0.1:8199' }),
    OPT2_STATE_DIR: 'OPT2_STATE_DIR' in overrides ? undefined : lazyStateDir(),
    OPT2_TASKS_ADAPTER: 'local',
    TZ: process.env.TZ || 'UTC',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Clock every suite shares: local `2026-06-30T12:00:00`, the seed's business date. */
export const TEST_CLOCK: Clock = businessClock();

/** Transaction id the recording database reports for every write, so write positions read `stub=1000`. */
export const FIXED_XID = '1000';

// currentPosition() reports xmax - 1, so the snapshot bounds sit one past FIXED_XID.
const NEXT_XID = String(Number(FIXED_XID) + 1);

/** In-memory `TaskPort` that records created tasks and never dispatches them. */
export interface FakeTaskPort extends TaskPort {
  readonly kind: 'local';
  /** Every task created, in creation order; a deleted task stays listed here. */
  readonly tasks: CreateTaskInput[];
  /** Makes every later `create` reject until called with `false`. */
  failCreate(on?: boolean): void;
}

/** Creates a {@link FakeTaskPort}; a name created once on a queue, live or deleted, answers `created: false` again, as Cloud Tasks tombstones do. */
export function createFakeTaskPort(): FakeTaskPort {
  const tasks: CreateTaskInput[] = [];
  const reserved = new Set<string>();
  const live = new Map<string, CreateTaskInput>();
  const paused = new Set<string>();
  let failing = false;
  const keyOf = (queue: string, name: string): string => `${queue}/${name}`;
  const infoOf = (input: CreateTaskInput): TaskInfo => ({
    queue: input.queue,
    name: input.name,
    scheduleTime: new Date(input.scheduleTime.getTime()),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    status: 'pending',
    attempts: 0,
  });

  return {
    kind: 'local',
    tasks,
    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      if (failing) throw new Error('fake task port: create failed');
      const key = keyOf(input.queue, input.name);
      if (reserved.has(key)) return { name: input.name, created: false };
      reserved.add(key);
      live.set(key, input);
      tasks.push(input);
      return { name: input.name, created: true };
    },
    async delete(queue: string, name: string): Promise<DeleteTaskResult> {
      return { name, deleted: live.delete(keyOf(queue, name)) };
    },
    // One page holds every live task of the queue.
    async list(queue: string): Promise<TaskPage> {
      return { tasks: [...live.values()].filter((input) => input.queue === queue).map(infoOf) };
    },
    async get(queue: string, name: string): Promise<TaskInfo | undefined> {
      const input = live.get(keyOf(queue, name));
      return input === undefined ? undefined : infoOf(input);
    },
    async pauseQueue(queue: string): Promise<void> {
      paused.add(queue);
    },
    async resumeQueue(queue: string): Promise<void> {
      paused.delete(queue);
    },
    async queueState(queue: string): Promise<QueueState> {
      return { queue, paused: paused.has(queue) };
    },
    close: (): Promise<void> => Promise.resolve(),
    failCreate(on = true): void {
      failing = on;
    },
  };
}

/** A unit of write authority of schema `stub`. */
export type StubUnit = (typeof STUB_UNITS)[number];

/** Window or transition phase of a unit gate. */
export type GatePhase = 'quiet' | 'executing' | 'importing' | 'import-pending';

/** One statement the fake pool received; `sql` is the text as issued. */
export interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** `app.tenant_id` of the statement's transaction; null in a metadata transaction or outside one. */
  readonly tenantId: string | null;
  /** Ordinal of the statement's transaction, counted from 1 at each BEGIN; 0 outside a transaction. */
  readonly tx: number;
  readonly kind: 'tenant' | 'metadata';
  /** Whether a scripted response or a built-in handler answered it, rather than the defaults. */
  readonly matched: boolean;
}

/** One INSERT, UPDATE or DELETE the fake pool received; `outcome` follows its transaction's COMMIT or ROLLBACK. */
export interface RecordedWrite {
  readonly tx: number;
  readonly tenantId: string | null;
  readonly op: 'insert' | 'update' | 'delete';
  /** Unqualified table name, such as `note` or `outbox`. */
  readonly table: string;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly outcome: 'open' | 'committed' | 'rolled-back';
}

/** Rows a scripted response answers, or a function computing them from the statement. */
export type ResponderRows = readonly QueryResultRow[] | ((query: RecordedQuery) => QueryResultRow[]);

/** Committed state a {@link RecordingDb} starts with. */
export interface RecordingSeed {
  notes?: ReadonlyArray<{ tenantId: string; row: NoteRow }>;
  projections?: ReadonlyArray<{ tenantId: string; row: NoteProjectionRow }>;
  /** Fixtures registered in `tenant_registry`; defaults to TENANT_LIST, and `[]` registers none. */
  registry?: readonly TenantFixture[];
  /** Gate overrides; every stub unit otherwise starts `open`, phase `quiet`, without holder. */
  gates?: Partial<Record<StubUnit, { state: 'legacy' | 'open' | 'closed'; phase?: GatePhase; holderId?: string | null }>>;
}

/** Tables whose committed rows `RecordingDb.rows` returns. */
export type RecordedTable = 'note' | 'note_projection' | 'outbox' | 'inbox';

/** `TenantDb` of schema `stub` over an in-memory pool, running the platform's own transactions and recording every statement. */
export interface RecordingDb extends TenantDb {
  readonly queries: RecordedQuery[];
  readonly writes: RecordedWrite[];
  /**
   * Answers statements matching `pattern` with `rows`, ahead of the built-in handlers and earlier responses; transaction control
   * is never scripted. A string matches as a substring and a RegExp is tested, both against the SQL without double quotes,
   * whitespace collapsed and lower-cased.
   */
  respond(pattern: RegExp | string, rows: ResponderRows): void;
  /** Empties `queries` and `writes`; stored rows and scripted responses stay. */
  clear(): void;
  /** Committed rows of `table`, of `tenantId` when given, with their database column names. */
  rows(table: RecordedTable, tenantId?: string): QueryResultRow[];
}

type Row = QueryResultRow;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type StoreName = 'note' | 'note_projection' | 'outbox' | 'inbox' | 'consumer_aggregate_version' | 'changelog' | 'tenant_registry' | 'unit_gate';
type Overlay = Map<StoreName, Map<string, Row | null>>;

interface Answer {
  rows: Row[];
  rowCount: number | null;
}

interface ParsedInsert {
  rows: Row[];
  conflict: string | undefined;
  returning: string | undefined;
}

// Primary keys of the stores; `tenant_registry` conflicts on tenant_id, as its consumer's upsert does.
const STORE_KEYS: Readonly<Record<StoreName, readonly string[]>> = {
  note: ['tenant_id', 'note_id'],
  note_projection: ['tenant_id', 'note_id'],
  outbox: ['tenant_id', 'event_id'],
  inbox: ['tenant_id', 'event_id'],
  consumer_aggregate_version: ['tenant_id', 'subscription', 'aggregate_type', 'aggregate_id'],
  changelog: ['tenant_id', 'seq'],
  tenant_registry: ['tenant_id'],
  unit_gate: ['unit'],
};
const STORE_NAMES = Object.keys(STORE_KEYS) as StoreName[];
const TABLE_REF = new RegExp(`\\b${STUB_SCHEMA}\\.(\\w+)`);
const TRANSACTION_CONTROL: ReadonlySet<string> = new Set(['begin', 'commit', 'rollback', 'savepoint', 'release']);
const POOL_ENDED = 'Cannot use a pool after calling end on the pool';

const isStore = (name: string): name is StoreName => Object.hasOwn(STORE_KEYS, name);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const many = (rows: Row[], rowCount: number | null = rows.length): Answer => ({ rows, rowCount });
const one = (row: Row): Answer => many([row]);

function normalise(sql: string): string {
  return sql.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sameValue(stored: unknown, wanted: unknown): boolean {
  return stored === null || stored === undefined ? wanted === null || wanted === undefined : String(stored) === String(wanted);
}

/** Index of the `)` closing the `(` at `open`, skipping quoted text; -1 when unbalanced. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `text` split at commas outside parentheses and quotes, each part trimmed. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** Value an expression binds: a `$n` parameter (jsonb text parsed), NULL, a literal or LOCALTIMESTAMP; undefined for any other expression. */
function boundValue(expression: string, params: readonly unknown[]): unknown {
  const placeholder = /^\$(\d+)(?:::(\w+))?/.exec(expression);
  if (placeholder !== null) {
    const value = params[Number(placeholder[1]) - 1] ?? null;
    return placeholder[2] === 'jsonb' && typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  }
  if (expression === 'null') return null;
  const literal = /^'((?:[^']|'')*)'/.exec(expression);
  if (literal?.[1] !== undefined) return literal[1].replace(/''/g, "'");
  if (expression === 'true' || expression === 'false') return expression === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression);
  if (expression.startsWith('localtimestamp')) return TEST_CLOCK.now();
  return undefined;
}

/** Rows of an `INSERT INTO t [AS a] (cols) VALUES (…)[, (…)]`, with its conflict and returning clauses; undefined for any other shape. */
function parseInsert(sql: string, params: readonly unknown[]): ParsedInsert | undefined {
  const head = /^insert into \S+(?: as \w+)? \(/.exec(sql);
  if (head === null) return undefined;
  const columnsEnd = closingParen(sql, head[0].length - 1);
  if (columnsEnd < 0) return undefined;
  const columns = splitTopLevel(sql.slice(head[0].length, columnsEnd));
  const values = /^ values /.exec(sql.slice(columnsEnd + 1));
  if (values === null) return undefined;
  let rest = sql.slice(columnsEnd + 1 + values[0].length);
  const rows: Row[] = [];
  while (rest.startsWith('(')) {
    const end = closingParen(rest, 0);
    if (end < 0) return undefined;
    const expressions = splitTopLevel(rest.slice(1, end));
    rows.push(
      Object.fromEntries(
        columns.flatMap((column, i) => {
          const value = boundValue(expressions[i] ?? 'null', params);
          return value === undefined ? [] : [[column, value]];
        }),
      ),
    );
    rest = rest.slice(end + 1).replace(/^\s*,\s*/, '');
  }
  const tail = rest.trim();
  return {
    rows,
    conflict: /^on conflict(.*?)(?: returning .+)?$/.exec(tail)?.[1],
    returning: /(?:^| )returning (.+)$/.exec(tail)?.[1],
  };
}

/** `row` projected through a SELECT or RETURNING list of columns, `alias.*`, `*` and `expr AS alias` items. */
function project(list: string, row: Row): Row {
  const items = splitTopLevel(list);
  if (items.length === 1 && /^(?:\w+\.)?\*$/.test(items[0] ?? '')) return { ...row };
  return Object.fromEntries(
    items.map((item) => {
      const aliased = /^(.+?) as (\w+)$/.exec(item);
      const column = (aliased?.[1] ?? item).split('::')[0]?.replace(/^\w+\./, '') ?? item;
      return [aliased?.[2] ?? column, row[column] ?? null];
    }),
  );
}

function selectList(sql: string): string {
  return /^select (.+?) from /.exec(sql)?.[1] ?? '*';
}

function returningOf(sql: string, rows: Row[]): Row[] {
  const list = / returning (.+)$/.exec(sql)?.[1];
  return list === undefined ? [] : rows.map((row) => project(list, row));
}

/** Assignments of an `UPDATE … SET` list whose value an expression binds; other assignments keep the stored value. */
function parseSet(sql: string, params: readonly unknown[]): Row {
  const list = /^update \S+ set (.+?)(?: where | returning |$)/.exec(sql)?.[1] ?? '';
  const set: Row = {};
  for (const assignment of splitTopLevel(list)) {
    const parts = /^(\w+) = (.+)$/.exec(assignment);
    const value = parts?.[2] === undefined ? undefined : boundValue(parts[2], params);
    if (parts?.[1] !== undefined && value !== undefined) set[parts[1]] = value;
  }
  return set;
}

/** Predicate of a WHERE clause of `col = $n`, `col = any($n)` and `lower(col) = lower($n)` terms joined by AND, alternatives by OR. */
function wherePredicate(sql: string, params: readonly unknown[]): (row: Row) => boolean {
  const where = / where (.+?)(?: group by | order by | limit | for update| for share| returning |$)/.exec(sql)?.[1];
  if (where === undefined) return () => true;
  const alternatives = where.split(' or ').map((clause) =>
    [...clause.matchAll(/(lower\()?(?:\w+\.)?(\w+)\)? = (any\(|lower\()?\$(\d+)/g)].map((match): ((row: Row) => boolean) => {
      const [, lower, column = '', fn, index] = match;
      const value = params[Number(index) - 1];
      if (fn === 'any(') {
        const wanted = asArray(value).map(String);
        return (row) => wanted.includes(String(row[column]));
      }
      if (lower !== undefined) return (row) => String(row[column]).toLowerCase() === String(value).toLowerCase();
      return (row) => sameValue(row[column], value);
    }),
  );
  return (row) => alternatives.some((terms) => terms.every((term) => term(row)));
}

function timeOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value).replace(' ', 'T'));
}

// `created`, then `note_id` in code-unit order, as `COLLATE "C"` sorts it.
function compareNoteOrder(a: Row, b: Row): number {
  const byTime = timeOf(a.created) - timeOf(b.created);
  if (byTime !== 0) return byTime;
  const [x, y] = [String(a.note_id), String(b.note_id)];
  return x < y ? -1 : x > y ? 1 : 0;
}

function registryRow(payload: SiteChangedPayload): Row {
  const { siteId } = payload;
  const pools = [payload.publicUserPoolId, payload.privateUserPoolId, payload.categoryPoolId, payload.filePoolId, payload.displayPoolId].map(
    (pool) => pool ?? siteId,
  );
  const content = Array.isArray(payload.contentPoolIds) ? payload.contentPoolIds : [siteId];
  const [publicUser, privateUser, category, file, display] = pools;
  return {
    site_id: siteId,
    tenant_id: tenantIdForSite(siteId),
    public_user_pool_id: publicUser,
    private_user_pool_id: privateUser,
    category_pool_id: category,
    file_pool_id: file,
    display_pool_id: display,
    content_pool_ids: [...content],
    public_user_pool_tenant: tenantIdForSite(publicUser ?? siteId),
    private_user_pool_tenant: tenantIdForSite(privateUser ?? siteId),
    category_pool_tenant: tenantIdForSite(category ?? siteId),
    file_pool_tenant: tenantIdForSite(file ?? siteId),
    display_pool_tenant: tenantIdForSite(display ?? siteId),
    content_pool_tenants: content.map((id) => tenantIdForSite(id)),
    domains: [...(payload.domains ?? [])],
    aggregate_version: '1',
    updated_at: TEST_CLOCK.now(),
  };
}


/** One transaction of a fake connection: its staged rows stay invisible to other transactions until COMMIT. */
interface FakeTx {
  readonly ordinal: number;
  tenantId: string | null;
  kind: 'tenant' | 'metadata';
  readonly overlay: Overlay;
  readonly savepoints: Map<string, { overlay: Overlay; writes: number }>;
  readonly writes: Mutable<RecordedWrite>[];
  begin?: Mutable<RecordedQuery>;
}

interface FakeConnection {
  tx: FakeTx | undefined;
}

function cloneOverlay(overlay: Overlay): Overlay {
  return new Map([...overlay].map(([store, rows]) => [store, new Map(rows)]));
}

/**
 * Creates a {@link RecordingDb}; nothing connects to PostgreSQL. Tenant-table statements see only the transaction's `app.tenant_id`,
 * as forced RLS does. Unscripted statements on the stub tables run on in-memory stores with every xid FIXED_XID; any other SELECT
 * answers no rows and any other write one row, an INSERT's RETURNING bound from its values.
 */
export function createRecordingDb(seed: RecordingSeed = {}): RecordingDb {
  const committed = Object.fromEntries(STORE_NAMES.map((store) => [store, new Map<string, Row>()])) as Record<StoreName, Map<string, Row>>;
  const queries: RecordedQuery[] = [];
  const writes: RecordedWrite[] = [];
  const responders: Array<{ pattern: RegExp | string; rows: ResponderRows }> = [];
  let transactions = 0;
  let outboxSeq = 0;
  let changelogSeq = 0;
  let ended = false;

  const keyOf = (store: StoreName, row: Row): string => JSON.stringify(STORE_KEYS[store].map((column) => row[column] ?? null));
  const seedRow = (store: StoreName, row: Row): void => {
    committed[store].set(keyOf(store, row), row);
  };
  for (const unit of STUB_UNITS) {
    const gate = seed.gates?.[unit];
    seedRow('unit_gate', { unit, state: gate?.state ?? 'open', holder_id: gate?.holderId ?? null, phase: gate?.phase ?? 'quiet' });
  }
  const registered = new Set((seed.registry ?? TENANT_LIST).map((fixture) => fixture.siteId));
  for (const payload of registryPayloads()) {
    if (registered.has(payload.siteId)) seedRow('tenant_registry', registryRow(payload));
  }
  for (const { tenantId, row } of seed.notes ?? []) seedRow('note', { ...row, tenant_id: tenantId.toLowerCase() });
  for (const { tenantId, row } of seed.projections ?? []) seedRow('note_projection', { ...row, tenant_id: tenantId.toLowerCase() });

  const newTx = (ordinal: number): FakeTx => ({
    ordinal,
    tenantId: null,
    kind: 'metadata',
    overlay: new Map(),
    savepoints: new Map(),
    writes: [],
  });

  /** Rows of `store` the transaction sees: committed rows under its staged changes, tenant tables filtered to its tenant. */
  function view(tx: FakeTx, store: StoreName): Row[] {
    const merged = new Map(committed[store]);
    for (const [key, row] of tx.overlay.get(store) ?? []) {
      if (row === null) merged.delete(key);
      else merged.set(key, row);
    }
    const rows = [...merged.values()];
    return isNonTenantTable(store) ? rows : rows.filter((row) => tx.tenantId !== null && row.tenant_id === tx.tenantId);
  }

  /** The row stored under `key` in any tenant, as a unique index sees it. */
  function lookup(tx: FakeTx, store: StoreName, key: string): Row | undefined {
    const staged = tx.overlay.get(store);
    return staged?.has(key) === true ? (staged.get(key) ?? undefined) : committed[store].get(key);
  }

  function stage(tx: FakeTx, store: StoreName, row: Row | null, key: string): void {
    let staged = tx.overlay.get(store);
    if (staged === undefined) {
      staged = new Map();
      tx.overlay.set(store, staged);
    }
    staged.set(key, row);
  }

  function finish(tx: FakeTx, outcome: 'committed' | 'rolled-back'): void {
    if (outcome === 'committed') {
      for (const [store, rows] of tx.overlay) {
        for (const [key, row] of rows) {
          if (row === null) committed[store].delete(key);
          else committed[store].set(key, row);
        }
      }
    }
    for (const write of tx.writes) {
      if (write.outcome === 'open') write.outcome = outcome;
    }
  }

  function control(connection: FakeConnection, tx: FakeTx, sql: string): void {
    const savepoint = /^(savepoint|release savepoint|rollback to savepoint) (\w+)/.exec(sql);
    if (savepoint?.[2] !== undefined) {
      const [, command, name] = savepoint;
      const mark = tx.savepoints.get(name);
      if (command === 'savepoint') tx.savepoints.set(name, { overlay: cloneOverlay(tx.overlay), writes: tx.writes.length });
      else if (command === 'release savepoint') tx.savepoints.delete(name);
      else if (mark !== undefined) {
        tx.overlay.clear();
        for (const [store, rows] of cloneOverlay(mark.overlay)) tx.overlay.set(store, rows);
        for (const write of tx.writes.slice(mark.writes)) write.outcome = 'rolled-back';
      }
      return;
    }
    if (sql.startsWith('commit') || sql.startsWith('rollback')) {
      finish(tx, sql.startsWith('commit') ? 'committed' : 'rolled-back');
      connection.tx = undefined;
    }
  }

  function withDefaults(store: StoreName, values: Row): Row {
    switch (store) {
      case 'outbox':
        outboxSeq += 1;
        return { seq: String(outboxSeq), operation_id: null, held: false, published_at: null, ...values };
      case 'changelog':
        changelogSeq += 1;
        return { xid: FIXED_XID, seq: String(changelogSeq), ...values };
      case 'unit_gate':
        return { state: 'legacy', holder_id: null, phase: 'quiet', ...values };
      default:
        return { ...values };
    }
  }

  /** INSERT … VALUES into a store, honouring ON CONFLICT DO NOTHING, DO UPDATE with an aggregate-version guard, and RETURNING. */
  function insertInto(tx: FakeTx, store: StoreName, sql: string, params: readonly unknown[]): Answer | undefined {
    const parsed = parseInsert(sql, params);
    if (parsed === undefined) return undefined;
    const stored: Row[] = [];
    for (const values of parsed.rows) {
      const row = withDefaults(store, values);
      if (!isNonTenantTable(store) && row.tenant_id !== tx.tenantId) {
        throw pgError('42501', `new row violates row-level security policy for table "${store}"`);
      }
      const key = keyOf(store, row);
      const existing = lookup(tx, store, key);
      if (existing === undefined) {
        stage(tx, store, row, key);
        stored.push(row);
        continue;
      }
      if (parsed.conflict === undefined) throw pgError('23505', `duplicate key value violates unique constraint "${store}_pkey"`);
      if (!/ do update /.test(`${parsed.conflict} `)) continue;
      const versioned = /\.aggregate_version < excluded\.aggregate_version/.test(parsed.conflict);
      if (versioned && !(Number(existing.aggregate_version) < Number(row.aggregate_version))) continue;
      const next = { ...existing, ...row };
      stage(tx, store, next, key);
      stored.push(next);
    }
    const list = parsed.returning;
    return many(list === undefined ? [] : stored.map((row) => project(list, row)), stored.length);
  }

  /** SELECT, UPDATE and DELETE by WHERE terms on `note`, `note_projection`, `inbox` and `consumer_aggregate_version`. */
  function keyedStatement(tx: FakeTx, store: StoreName, sql: string, params: readonly unknown[]): Answer | undefined {
    if (sql.startsWith('insert')) return insertInto(tx, store, sql, params);
    let rows = view(tx, store).filter(wherePredicate(sql, params));
    if (sql.startsWith('select')) {
      const groupBy = / group by (\w+)$/.exec(sql)?.[1];
      if (groupBy !== undefined) {
        const counts = new Map<unknown, number>();
        for (const row of rows) counts.set(row[groupBy], (counts.get(row[groupBy]) ?? 0) + 1);
        return many([...counts].map(([value, count]) => ({ [groupBy]: value, count: String(count) })));
      }
      const keyset = /\(created, note_id collate c\) > \(\$(\d+)[^,]*, \$(\d+)/.exec(sql);
      if (keyset !== null) {
        const after = { created: params[Number(keyset[1]) - 1], note_id: params[Number(keyset[2]) - 1] };
        rows = rows.filter((row) => compareNoteOrder(row, after) > 0);
      }
      if (/ order by created, note_id/.test(sql)) rows.sort(compareNoteOrder);
      const limit = / limit \$(\d+)/.exec(sql)?.[1];
      if (limit !== undefined) rows = rows.slice(0, Number(params[Number(limit) - 1]));
      const list = selectList(sql);
      return many(rows.map((row) => project(list, row)));
    }
    if (sql.startsWith('update')) {
      const set = parseSet(sql, params);
      rows = rows.map((row) => {
        const next = { ...row, ...set };
        stage(tx, store, next, keyOf(store, row));
        return next;
      });
      return many(returningOf(sql, rows), rows.length);
    }
    if (sql.startsWith('delete')) {
      for (const row of rows) stage(tx, store, null, keyOf(store, row));
      return many(returningOf(sql, rows), rows.length);
    }
    return undefined;
  }

  /** The outbox writer, publishable-row selections, blocker query, publish stamp and drain counts. */
  function outboxStatement(tx: FakeTx, sql: string, params: readonly unknown[]): Answer | undefined {
    if (sql.startsWith('insert')) return insertInto(tx, 'outbox', sql, params);
    const rows = view(tx, 'outbox').sort((a, b) => Number(a.seq) - Number(b.seq));
    const pending = (row: Row): boolean => row.published_at === null && row.held !== true;
    if (sql.startsWith('select (select count(*)')) {
      return one({ unpublished: String(rows.filter(pending).length), held: String(rows.filter((row) => row.held === true).length) });
    }
    if (/^select o\.\* from \S+ o join \(select ordering_key, max\(seq\) as upto /.test(sql)) {
      const named = new Set(asArray(params[0]).map(String));
      const upto = new Map<string, number>();
      for (const row of rows.filter((candidate) => pending(candidate) && named.has(String(candidate.event_id)))) {
        upto.set(String(row.ordering_key), Number(row.seq));
      }
      return many(rows.filter((row) => pending(row) && Number(row.seq) <= (upto.get(String(row.ordering_key)) ?? -1)));
    }
    if (sql.startsWith('select ordering_key, min(seq)')) {
      const keys = new Set(asArray(params[0]).map(String));
      const excluded = new Set(asArray(params[2]).map(String));
      const first = new Map<string, string>();
      for (const row of rows) {
        const blocking = pending(row) || row.held === true;
        const key = String(row.ordering_key);
        if (blocking && keys.has(key) && Number(row.seq) < Number(params[1]) && !excluded.has(String(row.seq)) && !first.has(key)) {
          first.set(key, String(row.seq));
        }
      }
      return many([...first].map(([orderingKey, seq]) => ({ ordering_key: orderingKey, seq })));
    }
    if (/^select \* from \S+ where published_at is null and not held/.test(sql)) {
      const paged = / and seq > \$1/.test(sql);
      const after = paged ? Number(params[0]) : Number.NEGATIVE_INFINITY;
      return many(rows.filter((row) => pending(row) && Number(row.seq) > after).slice(0, Number(params[paged ? 1 : 0])));
    }
    if (/^update \S+ set published_at = \$1 where event_id = any\(\$2/.test(sql)) {
      const ids = new Set(asArray(params[1]).map(String));
      const stamped = rows.filter((row) => ids.has(String(row.event_id)) && row.published_at === null);
      for (const row of stamped) stage(tx, 'outbox', { ...row, published_at: params[0] }, keyOf('outbox', row));
      return many([], stamped.length);
    }
    return undefined;
  }

  /** Gate ensure, reads and compare-and-set updates; a gate update applies only where its WHERE holds. */
  function gateStatement(tx: FakeTx, sql: string, params: readonly unknown[]): Answer | undefined {
    const units = Array.isArray(params[0]) ? params[0].map(String) : undefined;
    if (/^insert into \S+ \(unit\) select unnest\(\$1/.test(sql)) {
      const added = (units ?? []).filter((unit) => lookup(tx, 'unit_gate', keyOf('unit_gate', { unit })) === undefined);
      for (const unit of added) stage(tx, 'unit_gate', withDefaults('unit_gate', { unit }), keyOf('unit_gate', { unit }));
      return many([], added.length);
    }
    const gates = view(tx, 'unit_gate')
      .filter((gate) => units === undefined || units.includes(String(gate.unit)))
      .sort((a, b) => (String(a.unit) < String(b.unit) ? -1 : 1));
    if (sql.startsWith('select')) {
      const list = selectList(sql);
      return many(gates.map((gate) => project(list, gate)));
    }
    if (!sql.startsWith('update')) return undefined;
    const holder = params[1] ?? null;
    const closable = /\bstate = any\(\$4/.test(sql) ? asArray(params[3]).map(String) : [];
    const set = parseSet(sql, params);
    const changed = gates
      .filter((gate) => closable.includes(String(gate.state)) || (holder !== null && gate.holder_id === holder))
      .map((gate) => {
        const next = { ...gate, ...set };
        stage(tx, 'unit_gate', next, keyOf('unit_gate', next));
        return next;
      });
    return many(returningOf(sql, changed), changed.length);
  }

  /** Registry reads and the site-registry consumer's upsert. */
  function registryStatement(tx: FakeTx, sql: string, params: readonly unknown[]): Answer | undefined {
    if (sql.startsWith('insert')) return insertInto(tx, 'tenant_registry', sql, params);
    if (!sql.startsWith('select')) return undefined;
    const rows = view(tx, 'tenant_registry').filter(wherePredicate(sql, params));
    if (/ order by site_id/.test(sql)) rows.sort((a, b) => (String(a.site_id) < String(b.site_id) ? -1 : 1));
    const list = selectList(sql);
    return many(rows.map((row) => project(list, row)));
  }

  function builtIn(tx: FakeTx, sql: string, params: readonly unknown[]): Answer | undefined {
    const alias = (fallback: string): string => / as (\w+)$/.exec(sql)?.[1] ?? fallback;
    if (/^select set_config\(/.test(sql)) return one({ set_config: params[0] ?? null });
    if (/^select current_setting\('lock_timeout'\)/.test(sql)) return one({ [alias('current_setting')]: '0' });
    if (/^select pg_snapshot_xm(?:in|ax)\(pg_current_snapshot\(\)\)/.test(sql)) return one({ [alias('value')]: NEXT_XID });
    if (/^select pg_current_xact_id\(\)/.test(sql)) return one({ [alias('pg_current_xact_id')]: FIXED_XID });
    if (/^select to_regclass\(/.test(sql)) return one(Object.fromEntries([...sql.matchAll(/ as (\w+)/g)].map((match) => [match[1], true])));
    const store = TABLE_REF.exec(sql)?.[1];
    if (store === undefined || !isStore(store)) return undefined;
    switch (store) {
      case 'unit_gate':
        return gateStatement(tx, sql, params);
      case 'tenant_registry':
        return registryStatement(tx, sql, params);
      case 'outbox':
        return outboxStatement(tx, sql, params);
      // Changelog reads answer by default: no row is ever below the fixed horizon.
      case 'changelog':
        return sql.startsWith('insert') ? insertInto(tx, store, sql, params) : undefined;
      default:
        return keyedStatement(tx, store, sql, params);
    }
  }

  function defaults(sql: string, verb: string, params: readonly unknown[]): Answer {
    if (verb === 'select' || verb === 'with') return many([], 0);
    const parsed = verb === 'insert' ? parseInsert(sql, params) : undefined;
    const list = parsed?.returning;
    if (parsed !== undefined && list !== undefined) return many(parsed.rows.map((row) => project(list, row)));
    return many([], verb === 'insert' || verb === 'update' || verb === 'delete' ? 1 : null);
  }


  async function run(connection: FakeConnection, input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    if (ended) throw new Error(POOL_ENDED);
    const text = typeof input === 'string' ? input : input.text;
    const params: unknown[] = [...((typeof input === 'string' ? undefined : input.values) ?? values ?? [])];
    const sql = normalise(text);
    const verb = /^\w+/.exec(sql)?.[0] ?? '';
    if (verb === 'begin') {
      transactions += 1;
      connection.tx = newTx(transactions);
    }
    // A statement outside BEGIN … COMMIT runs in its own committed transaction.
    const autocommit = connection.tx === undefined;
    const tx = connection.tx ?? newTx(0);
    if (/^select set_config\('app\.tenant_id'/.test(sql)) {
      tx.tenantId = typeof params[0] === 'string' && params[0] !== '' ? params[0] : null;
      tx.kind = tx.tenantId === null ? 'metadata' : 'tenant';
      if (tx.begin !== undefined) Object.assign(tx.begin, { tenantId: tx.tenantId, kind: tx.kind });
    }
    const query: Mutable<RecordedQuery> = { sql: text, params, tenantId: tx.tenantId, tx: tx.ordinal, kind: tx.kind, matched: false };
    queries.push(query);
    if (verb === 'begin') tx.begin = query;
    if (verb === 'insert' || verb === 'update' || verb === 'delete') {
      const table = /^(?:insert into|update|delete from) (\S+)/.exec(sql)?.[1]?.split('.').pop() ?? '';
      const write: Mutable<RecordedWrite> = { tx: tx.ordinal, tenantId: tx.tenantId, op: verb, table, sql: text, params, outcome: 'open' };
      writes.push(write);
      tx.writes.push(write);
    }

    let answer: Answer;
    if (TRANSACTION_CONTROL.has(verb)) {
      control(connection, tx, sql);
      query.matched = true;
      answer = many([], null);
    } else {
      const responder = responders.findLast(({ pattern }) =>
        typeof pattern === 'string' ? sql.includes(normalise(pattern)) : sql.search(pattern) !== -1,
      );
      try {
        if (responder === undefined) {
          const handled = builtIn(tx, sql, params);
          query.matched = handled !== undefined;
          answer = handled ?? defaults(sql, verb, params);
        } else {
          const rows = typeof responder.rows === 'function' ? responder.rows(query) : responder.rows;
          query.matched = true;
          answer = many(rows.map((row) => ({ ...row })));
        }
      } catch (err) {
        if (autocommit) finish(tx, 'rolled-back');
        throw err;
      }
      if (autocommit) finish(tx, 'committed');
    }
    return { command: verb.toUpperCase(), rowCount: answer.rowCount, oid: 0, fields: [], rows: answer.rows };
  }

  // Structurally the pg.Pool members tenantDbFromPool and runTransaction call.
  const fakePool = {
    async connect() {
      if (ended) throw new Error(POOL_ENDED);
      const connection: FakeConnection = { tx: undefined };
      return {
        query: (input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> => run(connection, input, values),
        release: (): void => undefined,
      };
    },
    query: (input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> => run({ tx: undefined }, input, values),
    async end(): Promise<void> {
      ended = true;
    },
    on: (): void => undefined,
  };
  const base = tenantDbFromPool(fakePool as unknown as Pool, { schema: STUB_SCHEMA });

  // tenantDbFromPool freezes its TenantDb, so the recording members sit on an object that delegates to it.
  return {
    schema: base.schema,
    withTenant: (tenantId, fn) => base.withTenant(tenantId, fn),
    withMetadata: (fn, options) => base.withMetadata(fn, options),
    end: () => base.end(),
    queries,
    writes,
    respond(pattern, rows) {
      responders.push({ pattern, rows });
    },
    clear() {
      queries.length = 0;
      writes.length = 0;
    },
    rows(table, tenantId) {
      const wanted = tenantId?.toLowerCase();
      return [...committed[table].values()].filter((row) => wanted === undefined || row.tenant_id === wanted).map((row) => ({ ...row }));
    },
  };
}

/** Options of {@link buildTestApp}; it creates every fake it is not given. */
export interface TestAppOptions<P extends EventPublisher = CapturingPublisher> {
  /** Merged over {@link testEnv}. */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  db?: RecordingDb;
  publisher?: P;
  taskPort?: FakeTaskPort;
}

/** A ready stub app and the fakes behind it. */
export interface TestApp<D extends TenantDb = RecordingDb, P extends EventPublisher = CapturingPublisher> {
  app: FastifyInstance;
  publisher: P;
  taskPort: FakeTaskPort;
  db: D;
  clock: Clock;
  /** Raw environment the app was built from. */
  env: Record<string, string>;
}

/** Builds the stub app over `db` and awaits `ready`; a failed `ready` closes the app before rethrowing. */
async function buildReadyApp<D extends TenantDb, P extends EventPublisher>(
  db: D,
  envOverrides: Readonly<Record<string, string | undefined>>,
  opts: Omit<TestAppOptions<P>, 'db' | 'env'>,
): Promise<TestApp<D, P>> {
  const env = testEnv(envOverrides);
  const parsed = loadEnv(baseEnvSchema, env);
  await prepareStateDir(parsed.OPT2_STATE_DIR);
  const clock = opts.clock ?? TEST_CLOCK;
  // P defaults to CapturingPublisher, which is what is created when no publisher is given.
  const publisher = (opts.publisher ?? createCapturingPublisher()) as P;
  const taskPort = opts.taskPort ?? createFakeTaskPort();
  const app = await buildApp({ env: parsed, clock, verifierOverride: testVerifier(), db, publisher, taskPort });
  try {
    await app.ready();
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }
  return { app, publisher, taskPort, db, clock, env };
}

/** Builds the stub app over a {@link RecordingDb} and fakes, ready for `app.inject`; needs no PostgreSQL, emulator or network. */
export function buildTestApp<P extends EventPublisher = CapturingPublisher>(opts: TestAppOptions<P> = {}): Promise<TestApp<RecordingDb, P>> {
  const { db = createRecordingDb(), env = {}, ...rest } = opts;
  return buildReadyApp(db, env, rest);
}

/** Builds the stub app over the throwaway schema's app pool, with `PG_*` from `testPgConfig()` under `opts.env`. */
export function buildDbApp<P extends EventPublisher = CapturingPublisher>(
  schema: ThrowawaySchema,
  opts: Omit<TestAppOptions<P>, 'db'> = {},
): Promise<TestApp<TenantDb, P>> {
  const pg = testPgConfig();
  const { env = {}, ...rest } = opts;
  const pgEnv = { PG_HOST: pg.host, PG_PORT: String(pg.port), PG_USER: pg.user, PG_PASSWORD: pg.password, PG_DATABASE: pg.database };
  return buildReadyApp(schema.app, { ...pgEnv, ...env }, rest);
}

/** The `ROLE_SET` subject named `name`; throws TypeError when there is none. */
function roleSubjectNamed(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return found;
}

/** `app.inject` headers presenting `subject`, or the `ROLE_SET` subject of that name, to the stub; user tokens are minted for `site`, tenant-a by default. */
export function headersFor(subject: RoleSubject | string, { site }: { site?: string } = {}): Promise<Record<string, string>> {
  const resolved = typeof subject === 'string' ? roleSubjectNamed(subject) : subject;
  return authHeadersFor(resolved, { site: site ?? TENANT_A.siteId, audience: STUB_OWNER });
}

