/**
 * Shared scaffolding of the strategies-content suites: environment, clock, in-memory database, storage, task and
 * service-client fakes, the app builders for `app.inject`, and the throwaway PostgreSQL schema helpers.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { INVOCATION_HEADER, LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import { registerConsumers } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import {
  closeGates,
  ensureUnitGates,
  openGates,
  registerMigrationHandlers,
  registerWritePositionHeader,
  sha256Hex,
  type GatePhase,
  type GateState,
  type UnitGate,
} from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  ServiceUnavailableError,
  createService,
  loadEnv,
  type Clock,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  SIGNED_URL_TTL_S,
  StorageObjectNotFoundError,
  UnknownBucketError,
  assertBucket,
  assertObjectKey,
  createLocalStorageAdapter,
  signLocalUrl,
  verifySignedUrl,
  type BucketName,
  type LocalStorageAdapter,
  type ObjectHead,
  type PutBody,
  type PutResult,
} from '@opt2/platform/storage';
import {
  assertCreateInput,
  resolvePageSize,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskInfo,
  type TaskPage,
  type TaskPageRequest,
  type TaskPort,
} from '@opt2/platform/tasks';
import { tenantDbFromPool, tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import {
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  registryPayloads,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type ThrowawaySchema,
  type ThrowawaySchemaOptions,
} from '@opt2/platform/testing';
import { buildApp, contentEnvSchema, type ContentEnv } from '../../src/app.js';
import { CONTENT_CONFIG_DEFAULTS } from '../../src/domain/context.js';
import { contentConsumers } from '../../src/events/consumers.js';
import { registerJobRoutes } from '../../src/jobs/index.js';
import type { SiteConfigFlags } from '../../src/legacy/sites-client.js';
import { mappings, units } from '../../src/migration/mappings/index.js';
import { CONTENT_FILES_BUCKET, createExportObjects } from '../../src/migration/objects.js';
import { OWNER, SCHEMA, createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS, type ContentUnit } from '../../src/repo/tables.js';
import { registerCommentsProxyRoutes } from '../../src/routes/comments-proxy.js';
import { registerRaterRoutes } from '../../src/routes/rater.js';
import { registerFileRoutes } from '../../src/routes/files.js';
import { registerContentLinksRoutes } from '../../src/routes/internal-content-links.js';
import { registerFileLookupRoutes } from '../../src/routes/internal-file-lookup.js';
import { registerMigrationObjectRoutes } from '../../src/routes/migration-objects.js';
import { registerHeaderPromptRoutes } from '../../src/routes/v1/header-prompts.js';
import { registerInterestGroupRoutes } from '../../src/routes/v1/interest-groups.js';
import { rawSurfaceOf } from '../../src/routes/v1/raw.js';
import { registerContentQueueControl } from '../../src/tasks/port.js';

/** Name of the service under test, the audience of every invocation credential sent to it. */
export const SERVICE = OWNER;

/** Clock of every test app: the shared business date at noon UTC. */
export const TEST_CLOCK: Clock = businessClock();

/** Transaction id every changelog write and snapshot horizon of the recording pool reports. */
export const FAKE_XID = '1000';

/** Storage HMAC key of the test apps' local adapter; not a secret. */
const STORAGE_HMAC_KEY = 'opt2-strategies-content-test-storage-key';

type Row = Record<string, unknown>;

/** One statement the recording pool answered, in the transaction it ran in. */
export interface RecordedStatement {
  /** The SQL with whitespace collapsed. */
  sql: string;
  params: readonly unknown[];
  /** The transaction's `app.tenant_id`; null in a metadata transaction or before `set_config`. */
  tenantId: string | null;
}

/** Rows of a statement computed from its parameters, SQL and transaction tenant; it may throw to fail the statement. */
export type Responder = (params: readonly unknown[], sql: string, ctx: { tenantId: string | null }) => readonly Row[];

/** Rows a responder answers, or the function building them. */
export type ResponderRows = readonly Row[] | Responder;

/** A responder pattern: a RegExp over the collapsed SQL, or a case-insensitive substring of it. */
export type ResponderPattern = RegExp | string;

/** Gate state of one unit of write authority. */
export interface FakeGate {
  state: GateState;
  phase: GatePhase;
  holder_id: string | null;
}

/** Gates and responders a {@link RecordingDb} starts with, and returns to on `reset`. */
export interface RecordingDbSeed {
  gates?: Partial<Record<ContentUnit, GateState | Partial<FakeGate>>>;
  responses?: ReadonlyArray<readonly [ResponderPattern, ResponderRows]>;
}

/** A TenantDb over an in-memory pool that records every statement and answers it from responders and built-in rules. */
export interface RecordingDb extends TenantDb {
  /** Every statement since the last `clear`, transaction control included. */
  readonly statements: readonly RecordedStatement[];
  /** Recorded statements that write: a leading INSERT, UPDATE or DELETE, or one inside a `WITH` query. */
  writes(): RecordedStatement[];
  /** Every content unit's gate, and any other unit set, ordered by unit. */
  gates(): Array<FakeGate & { unit: string }>;
  /** Answers statements matching `pattern` with `rows` until `reset`; the latest responder wins. */
  respond(pattern: ResponderPattern, rows: ResponderRows): void;
  /** Sets the gate a unit reads and writes as; a unit never set reads as open, quiet and unheld. */
  setGate(unit: string, gate: Partial<FakeGate>): void;
  setGate(unit: string, state: GateState, phase?: GatePhase): void;
  /** Forgets the recorded statements; responders and gates stay. */
  clear(): void;
  /** Returns to the created state: no statements, inbox receipts or staged object intents, and the seed's gates and responders only. */
  reset(): void;
}

const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const SET_CONFIG = /^SELECT set_config\('([a-z_.]+)', \$1, true\)/i;
const GATE_TABLE = /"?\w+"?\."?unit_gate"?/i;
const REGISTRY_TABLE = /"?\w+"?\."?tenant_registry"?/i;
const INBOX_INSERT = /^INSERT INTO "?\w+"?\."?inbox"?/i;
const CHANGELOG_INSERT = /^INSERT INTO "?\w+"?\."?changelog"?/i;
const STAGED_OBJECT_TABLE = /"?\w+"?\."?staged_object"?/i;
const CURRENT_XACT_ID = /^SELECT pg_current_xact_id\(\)(?:::\w+)?(?: AS "?(\w+)"?)?$/i;
const WRITE_STATEMENT = /^(?:INSERT|UPDATE|DELETE)\b/i;
const CTE_WRITE = /^WITH\b.*\b(?:INSERT INTO|DELETE FROM|UPDATE \S+ SET)\b/i;
const OPEN_GATE: FakeGate = Object.freeze({ state: 'open', phase: 'quiet', holder_id: null });
const DECLARE_CURSOR = /^DECLARE (\w+) NO SCROLL CURSOR FOR (.+)$/i;
const FETCH_CURSOR = /^FETCH FORWARD (\d+) FROM (\w+)$/i;
const CLOSE_CURSOR = /^CLOSE (\w+)$/i;
const TRANSACTION_END = /^(COMMIT|ROLLBACK)\b/i;

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The statement's leading keyword, upper-cased, which pg reports as its `command`. */
function verbOf(sql: string): string {
  return (/^(\w+)/.exec(sql)?.[1] ?? '').toUpperCase();
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

const unquote = (name: string): string => name.replace(/"/g, '');

/** The value an INSERT expression binds: a `$n` parameter, NULL, a literal or the clock's now; undefined for any other expression. */
function boundValue(expression: string, params: readonly unknown[]): unknown {
  const placeholder = /^\$(\d+)/.exec(expression);
  if (placeholder !== null) return params[Number(placeholder[1]) - 1] ?? null;
  if (/^null$/i.test(expression)) return null;
  const literal = /^'((?:[^']|'')*)'/.exec(expression);
  if (literal?.[1] !== undefined) return literal[1].replace(/''/g, "'");
  if (/^(true|false)$/i.test(expression)) return expression.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression);
  if (/^(LOCALTIMESTAMP|now\(\)|CURRENT_TIMESTAMP)/i.test(expression)) return TEST_CLOCK.now();
  return undefined;
}

/** Rows of `INSERT INTO t (cols) VALUES (…)[, (…)]`, keyed by unquoted column; undefined for any other shape. */
function insertedRows(sql: string, params: readonly unknown[]): Row[] | undefined {
  const head = /^INSERT INTO \S+(?: AS \w+)? \(/i.exec(sql);
  if (head === null) return undefined;
  const columnsEnd = closingParen(sql, head[0].length - 1);
  if (columnsEnd < 0) return undefined;
  const columns = splitTopLevel(sql.slice(head[0].length, columnsEnd)).map(unquote);
  const values = /^ VALUES /i.exec(sql.slice(columnsEnd + 1));
  if (values === null) return undefined;
  let rest = sql.slice(columnsEnd + 1 + values[0].length);
  const rows: Row[] = [];
  while (rest.startsWith('(')) {
    const end = closingParen(rest, 0);
    if (end < 0) return undefined;
    const expressions = splitTopLevel(rest.slice(1, end));
    rows.push(Object.fromEntries(columns.map((column, i) => [column, boundValue(expressions[i] ?? 'NULL', params) ?? null])));
    rest = rest.slice(end + 1).replace(/^\s*,\s*/, '');
  }
  return rows;
}

/** `row` through a RETURNING or SELECT list of columns, `*` and `expr AS alias` items. */
function project(list: string, row: Row): Row {
  const items = splitTopLevel(list);
  if (items.length === 1 && /^(?:\w+\.)?\*$/.test(items[0] ?? '')) return { ...row };
  return Object.fromEntries(
    items.map((item) => {
      const aliased = /^(.+?) AS "?(\w+)"?$/i.exec(item);
      const column = unquote((aliased?.[1] ?? item).split('::')[0] ?? item).replace(/^\w+\./, '');
      return [aliased?.[2] ?? column, row[column] ?? null];
    }),
  );
}

/** The registry row of a fixture site, as the site consumer stores it. */
function registryRow(payload: ReturnType<typeof registryPayloads>[number]): Row {
  const { siteId } = payload;
  const pool = (id: string | null | undefined): string => id ?? siteId;
  const content = Array.isArray(payload.contentPoolIds) ? payload.contentPoolIds : [siteId];
  return {
    site_id: siteId,
    tenant_id: tenantIdForSite(siteId),
    public_user_pool_id: pool(payload.publicUserPoolId),
    private_user_pool_id: pool(payload.privateUserPoolId),
    category_pool_id: pool(payload.categoryPoolId),
    file_pool_id: pool(payload.filePoolId),
    display_pool_id: pool(payload.displayPoolId),
    content_pool_ids: [...content],
    public_user_pool_tenant: tenantIdForSite(pool(payload.publicUserPoolId)),
    private_user_pool_tenant: tenantIdForSite(pool(payload.privateUserPoolId)),
    category_pool_tenant: tenantIdForSite(pool(payload.categoryPoolId)),
    file_pool_tenant: tenantIdForSite(pool(payload.filePoolId)),
    display_pool_tenant: tenantIdForSite(pool(payload.displayPoolId)),
    content_pool_tenants: content.map((id) => tenantIdForSite(id)),
    domains: [...(payload.domains ?? [])],
    aggregate_version: '1',
    updated_at: TEST_CLOCK.now(),
    deleted: false,
  };
}

const NOT_DELETED = /(?:^| AND )NOT deleted$/i;

/**
 * The registry rows a WHERE clause of `col = $n`, `lower(col) = lower($n)` terms joined by AND, alternatives by OR, selects; a
 * trailing `NOT deleted` term keeps only the rows not marked deleted.
 */
function registryMatches(sql: string, params: readonly unknown[], rows: readonly Row[]): Row[] {
  const clause = / WHERE (.+?)(?: ORDER BY | LIMIT | FOR |$)/i.exec(sql)?.[1];
  const live = clause !== undefined && NOT_DELETED.test(clause);
  const where = live ? clause.replace(NOT_DELETED, '') : clause;
  const candidates = live ? rows.filter((row) => row.deleted === false) : rows;
  if (where === undefined || where === '') return [...candidates].sort((a, b) => String(a.site_id).localeCompare(String(b.site_id)));
  const alternatives = where.split(/ OR /i).map((clause) =>
    [...clause.matchAll(/(lower\()?"?(\w+)"?\)? = (lower\()?\$(\d+)/gi)].map(([, lower, column = '', , index]) => {
      const wanted = String(params[Number(index) - 1]);
      return (row: Row): boolean =>
        lower === undefined ? String(row[column]) === wanted : String(row[column]).toLowerCase() === wanted.toLowerCase();
    }),
  );
  return candidates.filter((row) => alternatives.some((terms) => terms.length > 0 && terms.every((term) => term(row))));
}

/** Whether a responder `pattern` matches the collapsed `sql`. */
function patternMatches(pattern: ResponderPattern, sql: string): boolean {
  return typeof pattern === 'string' ? sql.toLowerCase().includes(collapse(pattern).toLowerCase()) : pattern.test(sql);
}

/** Creates a {@link RecordingDb} over schema `content`; nothing connects to PostgreSQL. */
export function createRecordingDb(seed: RecordingDbSeed = {}): RecordingDb {
  const statements: RecordedStatement[] = [];
  let responders: Array<{ pattern: ResponderPattern; rows: ResponderRows }> = [];
  const gateOverrides = new Map<string, FakeGate>();
  const receipts = new Set<string>();
  const registry = new Map<string, Row>(registryPayloads().map((payload) => [tenantIdForSite(payload.siteId), registryRow(payload)]));
  /** `content.staged_object` rows by `<tenant_id>/<stage_id>`. */
  const stagedObjects = new Map<string, Row>();
  let nextXactId = BigInt(FAKE_XID);

  const gateOf = (unit: string): FakeGate => gateOverrides.get(unit) ?? OPEN_GATE;
  const setGate = (unit: string, gate: GateState | Partial<FakeGate>, phase?: GatePhase): void => {
    const patch = typeof gate === 'string' ? { state: gate, ...(phase === undefined ? {} : { phase }) } : gate;
    gateOverrides.set(unit, { ...gateOf(unit), ...patch });
  };
  const applySeed = (): void => {
    responders = (seed.responses ?? []).map(([pattern, rows]) => ({ pattern, rows }));
    for (const [unit, gate] of Object.entries(seed.gates ?? {})) {
      if (gate !== undefined) setGate(unit, gate);
    }
  };
  applySeed();
  const answer = (rows: readonly Row[], rowCount: number | null = rows.length, command = 'SELECT') => ({
    command,
    rows: [...rows],
    rowCount,
    fields: [],
  });

  /**
   * The intent ledger's repository insert, update and delete by key and its claim by `stage_id`, each returning the rows
   * PostgreSQL would and visible only in its own tenant as forced RLS keeps it. Every intent settles within the request that
   * staged it, so recovery's stale reads find none.
   */
  function stagedObjectAnswer(sql: string, params: readonly unknown[], tenantId: string | null) {
    const verb = verbOf(sql);
    const keyOf = (stageId: unknown): string => `${String(tenantId)}/${String(stageId)}`;
    const returning = / RETURNING \*$/i.test(sql);
    if (verb === 'INSERT') {
      // bigint reads back as text; recorded_at takes its column default.
      const rows = (insertedRows(sql, params) ?? []).map((row): Row => ({ ...row, size: String(row.size), recorded_at: TEST_CLOCK.now() }));
      for (const row of rows) stagedObjects.set(keyOf(row.stage_id), row);
      return answer(returning ? rows.map((row) => ({ ...row })) : [], rows.length, verb);
    }
    const stageParam = / WHERE (?:"tenant_id" = \$\d+ AND "stage_id"|stage_id) = \$(\d+)\b/i.exec(sql)?.[1];
    const key = stageParam === undefined ? undefined : keyOf(params[Number(stageParam) - 1]);
    const row = key === undefined ? undefined : stagedObjects.get(key);
    const found = row === undefined ? [] : [row];
    if (verb === 'SELECT') return answer(found.map((stored) => ({ ...stored })));
    if (verb === 'UPDATE' && row !== undefined) {
      for (const [, column = '', index] of (/ SET (.+) WHERE /i.exec(sql)?.[1] ?? '').matchAll(/"(\w+)" = \$(\d+)/g)) {
        row[column] = params[Number(index) - 1];
      }
    }
    if (verb === 'DELETE' && key !== undefined) stagedObjects.delete(key);
    return answer(returning ? found.map((stored) => ({ ...stored })) : [], found.length, verb);
  }

  /** The answer PostgreSQL would give an unscripted statement of the platform tables and the staged object ledger; no rows for any other read. */
  function builtIn(sql: string, params: readonly unknown[], session: { tenantId: string | null }) {
    const verb = verbOf(sql);
    if (TRANSACTION_CONTROL.test(sql)) return answer([], null, verb);
    const setting = SET_CONFIG.exec(sql);
    if (setting !== null) {
      if (setting[1] === 'app.tenant_id') session.tenantId = params[0] === '' ? null : String(params[0]);
      return answer([{ set_config: params[0] }]);
    }
    const xactId = CURRENT_XACT_ID.exec(sql);
    if (xactId !== null) {
      const xid = String(nextXactId);
      nextXactId += 1n;
      return answer([{ [xactId[1] ?? 'pg_current_xact_id']: xid }]);
    }
    if (/current_setting\('lock_timeout'\)/i.test(sql)) return answer([{ value: '0' }]);
    if (/pg_snapshot_x(?:min|max)\(pg_current_snapshot\(\)\)/i.test(sql)) return answer([{ value: FAKE_XID }]);
    if (/to_regclass\(\$1\) IS NOT NULL AS outbox/i.test(sql)) return answer([{ outbox: true, inbox: true }]);
    // count(*) answers one bigint row, as text, even over an empty table.
    if (/^SELECT \(SELECT count\(\*\) FROM \S+outbox .*\) AS unpublished, \(SELECT count\(\*\) FROM \S+outbox .*\) AS held$/i.test(sql)) {
      return answer([{ unpublished: '0', held: '0' }]);
    }
    if (GATE_TABLE.test(sql) && verb === 'SELECT') {
      const wanted = Array.isArray(params[0]) ? (params[0] as string[]) : [...CONTENT_UNITS];
      return answer([...new Set(wanted)].sort().map((unit) => ({ unit, ...gateOf(unit) })));
    }
    if (GATE_TABLE.test(sql) && verb === 'INSERT') return answer([], Array.isArray(params[0]) ? params[0].length : 0, verb);
    if (REGISTRY_TABLE.test(sql) && verb === 'SELECT') {
      const list = /^SELECT (.+?) FROM /i.exec(sql)?.[1] ?? '*';
      return answer(registryMatches(sql, params, [...registry.values()]).map((row) => project(list, row)));
    }
    if (STAGED_OBJECT_TABLE.test(sql)) return stagedObjectAnswer(sql, params, session.tenantId);
    if (INBOX_INSERT.test(sql)) {
      const key = `${String(params[0])}/${String(params[1])}`;
      const fresh = !receipts.has(key);
      receipts.add(key);
      return answer([], fresh ? 1 : 0, verb);
    }
    if (verb === 'INSERT') {
      const rows = insertedRows(sql, params) ?? [];
      if (REGISTRY_TABLE.test(sql)) {
        for (const row of rows) registry.set(String(row.tenant_id), { ...registry.get(String(row.tenant_id)), ...row });
      }
      if (CHANGELOG_INSERT.test(sql)) return answer(rows.map(() => ({ xid: FAKE_XID })), rows.length, verb);
      const returning = / RETURNING (.+)$/i.exec(sql)?.[1];
      return answer(returning === undefined ? [] : rows.map((row) => project(returning, row)), rows.length, verb);
    }
    return answer([], 0, verb);
  }

  const pool = {
    on: () => pool,
    end: async (): Promise<void> => undefined,
    async connect() {
      const session = { tenantId: null as string | null };
      // A cursor holds the rows its query's responder answers, matched on the DECLARE or on its query; a FETCH takes the next ones.
      const cursors = new Map<string, Row[]>();
      return {
        async query(text: string | { text: string; values?: unknown[] }, values?: unknown[]) {
          const sql = collapse(typeof text === 'string' ? text : text.text);
          const params = (typeof text === 'string' ? values : (text.values ?? values)) ?? [];
          statements.push({ sql, params, tenantId: session.tenantId });
          const responderFor = (text: string) => responders.findLast((candidate) => patternMatches(candidate.pattern, text));
          const rowsOf = (found: { rows: ResponderRows }, text: string): readonly Row[] =>
            typeof found.rows === 'function' ? found.rows(params, text, { tenantId: session.tenantId }) : found.rows;
          const declared = DECLARE_CURSOR.exec(sql);
          if (declared !== null) {
            const [, cursor = '', query = ''] = declared;
            const text = responderFor(sql) === undefined ? query : sql;
            const found = responderFor(text);
            cursors.set(cursor, found === undefined ? [] : [...rowsOf(found, text)]);
            return answer([], null, 'DECLARE');
          }
          if (TRANSACTION_END.test(sql)) cursors.clear();
          const closed = CLOSE_CURSOR.exec(sql);
          if (closed !== null) cursors.delete(closed[1] ?? '');
          const responder = responderFor(sql);
          const fetched = responder === undefined ? FETCH_CURSOR.exec(sql) : null;
          if (fetched !== null) {
            const rows = (cursors.get(fetched[2] ?? '') ?? []).splice(0, Number(fetched[1]));
            return answer(rows, rows.length, 'FETCH');
          }
          if (responder !== undefined) {
            const rows = rowsOf(responder, sql);
            return answer(rows, rows.length, verbOf(sql));
          }
          return builtIn(sql, params, session);
        },
        release: (): void => undefined,
      };
    },
  };

  const db = tenantDbFromPool(pool as never, { schema: SCHEMA });
  return Object.freeze({
    schema: db.schema,
    withTenant: db.withTenant.bind(db),
    withMetadata: db.withMetadata.bind(db),
    end: db.end.bind(db),
    statements,
    writes: (): RecordedStatement[] => statements.filter((statement) => WRITE_STATEMENT.test(statement.sql) || CTE_WRITE.test(statement.sql)),
    gates: () =>
      [...new Set<string>([...CONTENT_UNITS, ...gateOverrides.keys()])].sort().map((unit) => ({ unit, ...gateOf(unit) })),
    respond(pattern: ResponderPattern, rows: ResponderRows): void {
      responders.push({ pattern, rows });
    },
    setGate,
    clear(): void {
      statements.length = 0;
    },
    reset(): void {
      statements.length = 0;
      gateOverrides.clear();
      receipts.clear();
      stagedObjects.clear();
      applySeed();
    },
  });
}

/** A TaskPort over in-memory queues that records each call and never dispatches. */
export interface FakeTaskPort extends TaskPort {
  readonly kind: 'local';
  /** Every call, as `<op> <queue>`. */
  readonly calls: string[];
  /** Input of every `create` call, repeats and injected failures included. */
  readonly created: CreateTaskInput[];
  /** Live tasks, neither done nor deleted, in creation order. */
  readonly tasks: readonly CreateTaskInput[];
  /** Makes the next `times` creates reject, with `error` when given, after their input is checked. */
  failCreate(times?: number, error?: Error): void;
  /** Marks the live task `name`, on `queue` when given, done, so it leaves `list` and `get`; throws when none matches. */
  markDone(name: string, queue?: string): void;
  /** Forgets every call, task, tombstone, paused queue and pending failure. */
  clear(): void;
}

/**
 * Creates a {@link FakeTaskPort}; inputs are checked as the adapters check them, and a name created once on a queue
 * answers `created: false` again, deleted or done, as Cloud Tasks tombstones do.
 */
export function createFakeTaskPort(): FakeTaskPort {
  const calls: string[] = [];
  const created: CreateTaskInput[] = [];
  const held = new Map<string, { input: CreateTaskInput; live: boolean }>();
  const paused = new Set<string>();
  let pendingFailures = 0;
  let failure: Error | undefined;
  const keyOf = (queue: string, name: string): string => `${queue}/${name}`;
  const liveTask = (queue: string, name: string) => {
    const task = held.get(keyOf(queue, name));
    return task?.live === true ? task : undefined;
  };
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
    calls,
    created,
    get tasks(): CreateTaskInput[] {
      return [...held.values()].filter((task) => task.live).map((task) => task.input);
    },
    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      calls.push(`create ${input.queue}`);
      created.push(input);
      assertCreateInput(input);
      if (pendingFailures > 0) {
        pendingFailures -= 1;
        throw failure ?? new Error(`fake task port: injected create failure on ${input.queue}/${input.name}`);
      }
      const key = keyOf(input.queue, input.name);
      if (held.has(key)) return { name: input.name, created: false };
      held.set(key, { input, live: true });
      return { name: input.name, created: true };
    },
    async delete(queue: string, name: string): Promise<DeleteTaskResult> {
      calls.push(`delete ${queue}`);
      const task = liveTask(queue, name);
      if (task !== undefined) task.live = false;
      return { name, deleted: task !== undefined };
    },
    async list(queue: string, page?: TaskPageRequest): Promise<TaskPage> {
      calls.push(`list ${queue}`);
      const pageSize = resolvePageSize(page?.pageSize);
      const live = [...held.values()].filter((task) => task.live && task.input.queue === queue);
      const start = page?.pageToken === undefined ? 0 : Number(page.pageToken);
      const end = start + pageSize;
      const tasks = live.slice(start, end).map((task) => infoOf(task.input));
      return end < live.length ? { tasks, nextPageToken: String(end) } : { tasks };
    },
    async get(queue: string, name: string): Promise<TaskInfo | undefined> {
      calls.push(`get ${queue}`);
      const task = liveTask(queue, name);
      return task === undefined ? undefined : infoOf(task.input);
    },
    async pauseQueue(queue: string): Promise<void> {
      calls.push(`pauseQueue ${queue}`);
      paused.add(queue);
    },
    async resumeQueue(queue: string): Promise<void> {
      calls.push(`resumeQueue ${queue}`);
      paused.delete(queue);
    },
    async queueState(queue: string): Promise<QueueState> {
      calls.push(`queueState ${queue}`);
      return { queue, paused: paused.has(queue) };
    },
    close: async (): Promise<void> => undefined,
    failCreate(times = 1, error?: Error): void {
      pendingFailures = times;
      failure = error;
    },
    markDone(name: string, queue?: string): void {
      const task = [...held.values()].find(
        (candidate) => candidate.live && candidate.input.name === name && (queue === undefined || candidate.input.queue === queue),
      );
      if (task === undefined) throw new Error(`fake task port holds no live task ${queue === undefined ? '' : `${queue}/`}${name}`);
      task.live = false;
    },
    clear(): void {
      calls.length = 0;
      created.length = 0;
      held.clear();
      paused.clear();
      pendingFailures = 0;
      failure = undefined;
    },
  };
}

/** HMAC key of the memory storage's signed URLs; not a secret. */
export const MEMORY_STORAGE_HMAC_KEY: Buffer = Buffer.from('opt2-strategies-content-test-memory-storage-key', 'utf8');

/** One stored object of the memory storage. */
export interface MemoryObject {
  bytes: Buffer;
  contentType: string;
  size: number;
  sha256: string;
}

/** Member of the storage port, as {@link MemoryStorage.calls} records it. */
export type StorageOp = 'put' | 'get' | 'stream' | 'open' | 'delete' | 'head' | 'signedUrl';

/** One storage call; `size`, `sha256` and `contentType` are those a `put` stored. */
export interface StorageCall {
  op: StorageOp;
  bucket: string;
  key: string;
  size?: number;
  sha256?: string;
  contentType?: string;
}

/** A local storage port over an in-memory `content-files` bucket that records each call and every URL it signs. */
export interface MemoryStorage extends LocalStorageAdapter {
  /** Stored objects by key. */
  readonly objects: Map<string, MemoryObject>;
  readonly calls: StorageCall[];
  readonly signedUrls: string[];
  /** Stores an object without recording a call, as staged test data. */
  preload(key: string, bytes: Buffer | Uint8Array | string, contentType: string): PutResult;
  /** Forgets the recorded calls and signed URLs; the objects stay. */
  clear(): void;
}

/** Creates a {@link MemoryStorage}; any bucket but `content-files` throws UnknownBucketError, and URLs expire on `clock`. */
export function createMemoryStorage(opts: { clock?: Clock } = {}): MemoryStorage {
  const clock = opts.clock ?? TEST_CLOCK;
  const objects = new Map<string, MemoryObject>();
  const calls: StorageCall[] = [];
  const signedUrls: string[] = [];
  const checked = (bucket: string, key: string): string => {
    if (assertBucket(bucket) !== CONTENT_FILES_BUCKET) throw new UnknownBucketError(bucket);
    return assertObjectKey(key);
  };
  const store = (key: string, bytes: Buffer, contentType: string): MemoryObject => {
    const object = { bytes, contentType, size: bytes.length, sha256: sha256Hex(bytes) };
    objects.set(key, object);
    return object;
  };
  const stored = (op: StorageOp, bucket: BucketName, key: string): MemoryObject => {
    calls.push({ op, bucket, key: checked(bucket, key) });
    const object = objects.get(key);
    if (object === undefined) throw new StorageObjectNotFoundError(bucket, key);
    return object;
  };
  const headOf = ({ size, sha256, contentType }: MemoryObject): ObjectHead => ({ size, sha256, contentType });
  const bytesOf = async (body: PutBody): Promise<Buffer> => (body instanceof Readable ? buffer(body) : Buffer.from(body));

  return {
    kind: 'local',
    objects,
    calls,
    signedUrls,
    async put(bucket, key, body, putOpts) {
      checked(bucket, key);
      const { size, sha256, contentType } = store(key, await bytesOf(body), putOpts.contentType);
      calls.push({ op: 'put', bucket, key, size, sha256, contentType });
      return { size, sha256 };
    },
    async get(bucket, key) {
      return Buffer.from(stored('get', bucket, key).bytes);
    },
    async stream(bucket, key) {
      return Readable.from([stored('stream', bucket, key).bytes]);
    },
    async open(bucket, key) {
      const object = stored('open', bucket, key);
      return { head: headOf(object), body: Readable.from([object.bytes]) };
    },
    async delete(bucket, key) {
      calls.push({ op: 'delete', bucket, key: checked(bucket, key) });
      objects.delete(key);
    },
    async head(bucket, key) {
      calls.push({ op: 'head', bucket, key: checked(bucket, key) });
      const object = objects.get(key);
      return object === undefined ? null : headOf(object);
    },
    async signedUrl(bucket, key, signOpts = {}) {
      calls.push({ op: 'signedUrl', bucket, key: checked(bucket, key) });
      const expires = Math.floor(clock.now().getTime() / 1000) + (signOpts.expiresS ?? SIGNED_URL_TTL_S);
      const url = signLocalUrl({ bucket, key, expires, disposition: signOpts.disposition }, MEMORY_STORAGE_HMAC_KEY);
      signedUrls.push(url);
      return url;
    },
    verifySignedUrl: (url, at = clock.now().getTime()) => verifySignedUrl(url, at, MEMORY_STORAGE_HMAC_KEY),
    preload(key, bytes, contentType) {
      const { size, sha256 } = store(checked(CONTENT_FILES_BUCKET, key), Buffer.from(bytes), contentType);
      return { size, sha256 };
    },
    clear(): void {
      calls.length = 0;
      signedUrls.length = 0;
    },
  };
}

/** Answers one service call. */
export type ClientHandler = (req: ServiceRequest) => ServiceResponse | Promise<ServiceResponse>;

/** Handlers by callee, each keyed `'<METHOD> <path>'`; a `{name}` path segment matches any one segment. */
export type ClientHandlers = Readonly<Record<string, Readonly<Record<string, ClientHandler>>>>;

/** Names of the user struct identity's current session answers. */
export interface SessionUserNames {
  fname: string;
  lname: string;
}

/**
 * Fake service client: records each call, then answers from handlers, else from identity's CSRF consume and current
 * session defaults, programs-sites' empty custom image size list and its seeded site flags; an unmatched call throws
 * after it is recorded.
 */
export interface ClientRecorder extends ServiceClient {
  readonly requests: ServiceRequest[];
  /** Bodies of the default CSRF consume calls, in order. */
  readonly csrfConsumes: CsrfConsumeRequest[];
  /** `valid` the default CSRF consume answers; initially true. */
  csrfValid: boolean;
  /** Names the default `GET /v1/sessions/current` answers, which become the actor's audit name. */
  sessionUser: SessionUserNames;
  /** Adds a handler of one method and path above every earlier one and the defaults. */
  on(service: string, method: ServiceRequest['method'], path: string, handler: ClientHandler): void;
  /** Makes the next call to `service` throw `error`, by default the ServiceUnavailableError of an unreachable callee. */
  failNext(service: string, error?: Error): void;
  /** Replaces `request` on the app's own service client, which the CSRF hook and the routes call. */
  install(app: FastifyInstance): void;
  /** Empties `requests` and `csrfConsumes`; handlers, defaults and pending failures stay. */
  clear(): void;
}

interface ClientRoute {
  service: string;
  method: ServiceRequest['method'];
  pattern: RegExp;
  handler: ClientHandler;
}

const CLIENT_ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
const CURRENT_SESSION_PATH = '/v1/sessions/current';

/** programs-sites' `lookupSiteConfigFlags` path. */
export const SITE_CONFIG_FLAGS_PATH = '/internal/v1/sites/config-flags:lookup';

/** A site's `$.siteConfig` flags as programs-sites answers them, without the site id. */
export type SiteConfigFlagValues = Omit<SiteConfigFlags, 'siteID'>;

/** The flags of a tenant-a site row as the seed stores it: scaffolding on, lockable nodes off. */
export const SEEDED_SITE_FLAGS: Readonly<SiteConfigFlagValues> = Object.freeze({
  hasLockableNodes: 0,
  hasChangesets: 1,
  dataCollection: 1,
  hasComments: 1,
  scaffolding: 1,
});

/** programs-sites' answer to the config-flags lookup: `flags` for every listed site, under its id. */
export function siteConfigFlagsAnswer(flags: Readonly<SiteConfigFlagValues> = SEEDED_SITE_FLAGS): ClientHandler {
  return (req) => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: { items: (req.json as { siteIds: string[] }).siteIds.map((siteID) => ({ siteID, ...flags })) },
  });
}

function clientRoute(service: string, method: ServiceRequest['method'], routePath: string, handler: ClientHandler): ClientRoute {
  const source = routePath
    .split(/(\{[^}/]+\})/)
    .map((part) => (/^\{[^}/]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return { service, method, pattern: new RegExp(`^${source}$`), handler };
}

/** Creates a {@link ClientRecorder} with `handlers` above its defaults. */
export function createClientRecorder(handlers: ClientHandlers = {}): ClientRecorder {
  const requests: ServiceRequest[] = [];
  const csrfConsumes: CsrfConsumeRequest[] = [];
  const routes: ClientRoute[] = [];
  const failures = new Map<string, Error[]>();
  for (const [service, keyed] of Object.entries(handlers)) {
    for (const [key, handler] of Object.entries(keyed)) {
      const parsed = CLIENT_ROUTE_KEY.exec(key);
      if (parsed?.[1] === undefined || parsed[2] === undefined) throw new TypeError(`client handler key must be '<METHOD> <path>': ${key}`);
      routes.push(clientRoute(service, parsed[1] as ServiceRequest['method'], parsed[2], handler));
    }
  }

  const recorder: ClientRecorder = {
    requests,
    csrfConsumes,
    csrfValid: true,
    sessionUser: { fname: 'Test', lname: 'User' },
    async request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      requests.push(req);
      const failure = failures.get(req.service)?.shift();
      if (failure !== undefined) throw failure;
      const requestPath = req.path.split('?')[0] ?? req.path;
      const route = [...defaults, ...routes].findLast(
        (candidate) => candidate.service === req.service && candidate.method === req.method && candidate.pattern.test(requestPath),
      );
      if (route === undefined) throw new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`);
      return (await route.handler(req)) as ServiceResponse<T>;
    },
    close: async (): Promise<void> => undefined,
    on(service, method, routePath, handler) {
      routes.push(clientRoute(service, method, routePath, handler));
    },
    failNext(service, error = new ServiceUnavailableError(service, Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))) {
      failures.set(service, [...(failures.get(service) ?? []), error]);
    },
    install(app) {
      Object.defineProperty(app.opt2.client, 'request', { value: recorder.request, writable: true, configurable: true, enumerable: true });
    },
    clear() {
      requests.length = 0;
      csrfConsumes.length = 0;
    },
  };
  const defaults: readonly ClientRoute[] = [
    clientRoute(IDENTITY_SERVICE, 'POST', CSRF_CONSUME_PATH, (req) => {
      csrfConsumes.push(req.json as CsrfConsumeRequest);
      return { status: 200, headers: {}, body: { valid: recorder.csrfValid } };
    }),
    clientRoute(IDENTITY_SERVICE, 'GET', CURRENT_SESSION_PATH, () => ({ status: 200, headers: {}, body: { user: { ...recorder.sessionUser } } })),
    clientRoute('programs-sites', 'GET', '/internal/v1/sites/{siteId}/image-sizes', () => ({ status: 200, headers: {}, body: [] })),
    clientRoute('programs-sites', 'POST', SITE_CONFIG_FLAGS_PATH, siteConfigFlagsAnswer()),
  ];
  return recorder;
}

/** The app under test and the recordings its routes write to. */
export interface ContentTestApp {
  app: FastifyInstance;
  db: RecordingDb;
  publisher: CapturingPublisher;
  taskPort: FakeTaskPort;
  storage: LocalStorageAdapter;
  /** Closes the app and removes its state directory. */
  close(): Promise<void>;
}

/** Options of buildContentApp. */
export interface ContentTestAppOptions {
  /** Adds routes after the service's own and before `ready`, as a later registration would. */
  declare?: (app: FastifyInstance) => unknown;
}

/** Local base URL of each service the suites address, at its `harness/repro/ports.env` port. */
const LOCAL_SERVICE_URLS: Readonly<Record<string, string>> = Object.freeze({
  identity: 'http://127.0.0.1:8111',
  people: 'http://127.0.0.1:8112',
  'programs-sites': 'http://127.0.0.1:8113',
  [SERVICE]: 'http://127.0.0.1:8114',
  gateway: 'http://127.0.0.1:8100',
  migration: 'http://127.0.0.1:8102',
});

/** A fresh state directory under the OS temp directory holding the platform test key pair and push key. */
export async function createTestStateDir(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-content-test-'));
  try {
    await writeTestSecrets(stateDir);
  } catch (err) {
    await rm(stateDir, { recursive: true, force: true });
    throw err;
  }
  return stateDir;
}

/**
 * Raw local environment over `stateDir` that `loadEnv(contentEnvSchema)` accepts; `overrides` merge last, an `undefined`
 * value removing the variable. The JWKS URL is never fetched and `PG_*` never connect, as suites inject the verifier and database.
 */
export function testEnv(stateDir: string, overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    PORT: '8114',
    OPT2_SERVICE_NAME: SERVICE,
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: process.env.PG_HOST || '127.0.0.1',
    PG_PORT: process.env.PG_PORT || '5432',
    PG_DATABASE: process.env.PG_DATABASE || 'opt2',
    PG_USER: process.env.PG_USER || 'content_app',
    // loadEnv reads a blank password as missing, which OPT2_DB_AUTH=password rejects.
    PG_PASSWORD: process.env.PG_PASSWORD || 'unused',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_GATEWAY_URL: 'http://127.0.0.1:8100',
    OPT2_MIGRATION_URL: 'http://127.0.0.1:8102',
    OPT2_SERVICE_URLS: JSON.stringify(LOCAL_SERVICE_URLS),
    OPT2_STATE_DIR: stateDir,
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    GOOGLE_CLOUD_PROJECT: 'opt2-local',
    TZ: process.env.TZ || 'UTC',
    MURA_VARIATIONS: 'false',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * Builds strategies-content with every route its source registers: the header prompts, the Edit Profile interest groups, the
 * people file and content-link lookups, the migration object transfer, the signed file downloads, the comments proxy, the
 * rater save, the platform migration handlers over the content mappings, the four push consumers, the site-monitor job
 * routes and queue control.
 */
export async function buildContentApp(options: ContentTestAppOptions = {}): Promise<ContentTestApp> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-gates-'));
  let app: FastifyInstance | undefined;
  try {
    await writeTestSecrets(stateDir);
    const env = loadEnv(undefined, testEnv(stateDir));
    const db = createRecordingDb();
    const publisher = createCapturingPublisher();
    const taskPort = createFakeTaskPort();
    const storage = await createLocalStorageAdapter({ stateDir, hmacKey: STORAGE_HMAC_KEY, now: () => TEST_CLOCK.now().getTime() });
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env,
      clock: TEST_CLOCK,
      verifierOverride: testVerifier(SERVICE),
      surfaceOf: rawSurfaceOf,
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    const repository = createContentRepository({ clock: TEST_CLOCK, schema: db.schema });
    registerWritePositionHeader(app);
    await registerHeaderPromptRoutes(app, { domain: { db, repository, clock: TEST_CLOCK } });
    await registerInterestGroupRoutes(app, { domain: { db, repository } });
    await registerFileLookupRoutes(app, { db });
    registerContentLinksRoutes(app, { db, env: testEnv(stateDir) });
    registerMigrationObjectRoutes(app, { domain: { db, repository }, storage, clock: TEST_CLOCK });
    registerFileRoutes(app, { domain: { db, repository }, storage, clock: TEST_CLOCK });
    registerCommentsProxyRoutes(app, { domain: { db, repository, clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS } });
    registerRaterRoutes(app, { domain: { db, repository, clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS } });
    registerMigrationHandlers(app, { owner: OWNER, repository: repository.platform, mappings, units, db, exportObjects: createExportObjects({ storage }) });
    registerConsumers(app, { service: SERVICE, consumers: contentConsumers(repository), publisher, db });
    registerJobRoutes(app, { repository, clock: TEST_CLOCK, storage });
    registerContentQueueControl(app, { port: taskPort, serviceUrls: env.OPT2_SERVICE_URLS, clock: TEST_CLOCK });
    options.declare?.(app);
    await app.ready();
    db.reset();
    const built = app;
    return {
      app: built,
      db,
      publisher,
      taskPort,
      storage,
      async close() {
        try {
          await built.close();
        } finally {
          await rm(stateDir, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    await app?.close().catch(() => undefined);
    await rm(stateDir, { recursive: true, force: true });
    throw err;
  }
}

/** Options of {@link buildTestApp}; it creates every fake it is not given. */
export interface TestAppOptions<D extends TenantDb = RecordingDb> {
  /** Merged into {@link testEnv}; an `OPT2_STATE_DIR` here is the caller's and is never removed. */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  /** Replaces the recording database, for example with a throwaway schema's `app`. */
  db?: D;
  storage?: MemoryStorage;
  taskPort?: FakeTaskPort;
  client?: ClientRecorder;
  /** Handlers of the client recorder created when `client` is absent. */
  clientHandlers?: ClientHandlers;
  publisher?: CapturingPublisher;
  /** Adds hooks or routes after the service's own and before `ready`. */
  declare?: (app: FastifyInstance) => unknown;
}

/** The service's own composition root over fakes, and the fakes behind it. */
export interface TestApp<D extends TenantDb = RecordingDb> {
  app: FastifyInstance;
  env: ContentEnv;
  storage: MemoryStorage;
  taskPort: FakeTaskPort;
  client: ClientRecorder;
  db: D;
  clock: Clock;
  publisher: CapturingPublisher;
  stateDir: string;
  /** Closes the app, then removes the state directory unless the caller supplied it; repeated calls share the first outcome. */
  close(): Promise<void>;
}

/**
 * Builds strategies-content through `buildApp` over the fakes, installs the client recorder and awaits `ready`; it never
 * listens. A failed build closes what it built and removes its state directory, then rethrows.
 */
export function buildTestApp<D extends TenantDb = RecordingDb>(opts?: TestAppOptions<D>): Promise<TestApp<D>>;
export async function buildTestApp(opts: TestAppOptions<TenantDb> = {}): Promise<TestApp<TenantDb>> {
  const callerStateDir = opts.env?.OPT2_STATE_DIR;
  const stateDir = callerStateDir ?? (await createTestStateDir());
  const removeStateDir = async (): Promise<void> => {
    if (callerStateDir === undefined) await rm(stateDir, { recursive: true, force: true });
  };
  let app: FastifyInstance | undefined;
  try {
    const env = loadEnv(contentEnvSchema, testEnv(stateDir, opts.env));
    const clock = opts.clock ?? TEST_CLOCK;
    let recording: RecordingDb | undefined;
    const db = opts.db ?? (recording = createRecordingDb());
    const storage = opts.storage ?? createMemoryStorage({ clock });
    const taskPort = opts.taskPort ?? createFakeTaskPort();
    const client = opts.client ?? createClientRecorder(opts.clientHandlers);
    const publisher = opts.publisher ?? createCapturingPublisher();
    app = await buildApp({ env, clock, verifierOverride: testVerifier(SERVICE), db, storage, taskPort, publisher });
    client.install(app);
    opts.declare?.(app);
    await app.ready();
    recording?.clear();
    const built = app;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        try {
          await built.close();
        } finally {
          await removeStateDir();
        }
      })());
    return { app: built, env, storage, taskPort, client, db, clock, publisher, stateDir, close };
  } catch (err) {
    // The build error is the one reported; a failure closing the partial app must not replace it.
    await app?.close().catch(() => undefined);
    await removeStateDir();
    throw err;
  }
}

/** Alias of {@link buildTestApp}. */
export const testApp = buildTestApp;

/** A user token of `site` and the gateway's invocation credential, as the gateway relays a browser call. */
export async function userHeaders(opts: { sub: string; site: string; roles: readonly string[]; s2?: boolean }): Promise<Record<string, string>> {
  const [user, invocation] = await Promise.all([
    mintUserToken({ sub: opts.sub, site: opts.site, roles: [...opts.roles], ...(opts.s2 === undefined ? {} : { s2: opts.s2 }) }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

/** `caller`'s invocation credential, with a forwarded user token of `user` when given, as a service client sends them. */
export async function serviceHeaders(
  caller: string,
  user?: { sub: string; site: string; roles: readonly string[] },
): Promise<Record<string, string>> {
  const invocation = `Bearer ${await mintServiceToken({ caller, audience: SERVICE })}`;
  if (user === undefined) return { [INVOCATION_HEADER]: invocation };
  return { authorization: `Bearer ${await mintUserToken({ sub: user.sub, site: user.site, roles: [...user.roles] })}`, [INVOCATION_HEADER]: invocation };
}

export { pgAvailable } from '@opt2/platform/testing';

/** The service's migrations, applied in file-name order. */
export const CONTENT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

/** Holder under which {@link openContentGates} closes and reopens the gates. */
const OPEN_GATES_HOLDER = 'strategies-content-test-setup';

/** A throwaway copy of schema `content` with every migration applied; drop it in `afterAll`. Needs a reachable `PG_*` server. */
export function withPgSchema(opts: Pick<ThrowawaySchemaOptions, 'schemaName' | 'extraSql'> = {}): Promise<ThrowawaySchema> {
  return createThrowawaySchema({ service: OWNER, schemaName: SCHEMA, migrationsDir: CONTENT_MIGRATIONS_DIR, ...opts });
}

/** Creates any missing content unit gate and opens every one, as test setup; idempotent, and only the handle's schema is touched. */
export async function openContentGates(handle: Pick<ThrowawaySchema, 'app'>): Promise<UnitGate[]> {
  await ensureUnitGates(handle.app, CONTENT_UNITS);
  // Through the platform's compare-and-set, as a window's holder reopens them, rather than writing gate rows by hand.
  await closeGates(handle.app, { units: CONTENT_UNITS, holderId: OPEN_GATES_HOLDER, allowLegacy: true });
  return openGates(handle.app, { units: CONTENT_UNITS, holderId: OPEN_GATES_HOLDER, state: 'open' });
}
