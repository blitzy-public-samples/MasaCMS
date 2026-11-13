/** In-process strategies-content app for the contract and security suites: every implemented route over a recording pool, no PostgreSQL. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { registerConsumers } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import type {
  CreateTaskInput,
  CreateTaskResult,
  DeleteTaskResult,
  QueueState,
  TaskInfo,
  TaskPort,
} from '@opt2/platform/tasks';
import { tenantDbFromPool, tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import {
  businessClock,
  createCapturingPublisher,
  mintServiceToken,
  mintUserToken,
  registryPayloads,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
} from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS } from '../../src/domain/context.js';
import { contentConsumers } from '../../src/events/consumers.js';
import { mappings, units } from '../../src/migration/mappings/index.js';
import { exportObjects } from '../../src/migration/objects.js';
import { OWNER, SCHEMA, createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { registerCommentsProxyRoutes } from '../../src/routes/comments-proxy.js';
import { registerFileRoutes } from '../../src/routes/files.js';
import { registerFileLookupRoutes } from '../../src/routes/internal-file-lookup.js';
import { registerMigrationObjectRoutes } from '../../src/routes/migration-objects.js';
import { registerHeaderPromptRoutes } from '../../src/routes/v1/header-prompts.js';
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

/** Rows a responder answers, or a function of the statement's parameters building them. */
export type ResponderRows = readonly Row[] | ((params: readonly unknown[], sql: string) => readonly Row[]);

/** Gate state of one unit of write authority. */
export interface FakeGate {
  state: 'legacy' | 'open' | 'closed';
  phase: 'quiet' | 'executing' | 'importing' | 'import-pending';
  holder_id: string | null;
}

/** A TenantDb over an in-memory pool that records every statement and answers it from responders and built-in rules. */
export interface RecordingDb extends TenantDb {
  /** Every statement since the last `clear`, transaction control included. */
  readonly statements: readonly RecordedStatement[];
  /** Answers statements whose collapsed SQL matches `pattern` with `rows` until `reset`; the latest responder wins. */
  respond(pattern: RegExp, rows: ResponderRows): void;
  /** Sets the gate a unit reads and writes as. */
  setGate(unit: string, gate: Partial<FakeGate>): void;
  /** Forgets the recorded statements. */
  clear(): void;
  /** Forgets the statements, responders, gate overrides, inbox receipts and staged object intents. */
  reset(): void;
}

const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const SET_CONFIG = /^SELECT set_config\('([a-z_.]+)', \$1, true\)/i;
const GATE_TABLE = /"?\w+"?\."?unit_gate"?/i;
const REGISTRY_TABLE = /"?\w+"?\."?tenant_registry"?/i;
const INBOX_INSERT = /^INSERT INTO "?\w+"?\."?inbox"?/i;
const CHANGELOG_INSERT = /^INSERT INTO "?\w+"?\."?changelog"?/i;
const STAGED_OBJECT_TABLE = /"?\w+"?\."?staged_object"?/i;
const OPEN_GATE: FakeGate = Object.freeze({ state: 'open', phase: 'quiet', holder_id: null });

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
  };
}

/** The registry rows a WHERE clause of `col = $n`, `lower(col) = lower($n)` terms joined by AND, alternatives by OR, selects. */
function registryMatches(sql: string, params: readonly unknown[], rows: readonly Row[]): Row[] {
  const where = / WHERE (.+?)(?: ORDER BY | LIMIT | FOR |$)/i.exec(sql)?.[1];
  if (where === undefined) return [...rows].sort((a, b) => String(a.site_id).localeCompare(String(b.site_id)));
  const alternatives = where.split(/ OR /i).map((clause) =>
    [...clause.matchAll(/(lower\()?"?(\w+)"?\)? = (lower\()?\$(\d+)/gi)].map(([, lower, column = '', , index]) => {
      const wanted = String(params[Number(index) - 1]);
      return (row: Row): boolean =>
        lower === undefined ? String(row[column]) === wanted : String(row[column]).toLowerCase() === wanted.toLowerCase();
    }),
  );
  return rows.filter((row) => alternatives.some((terms) => terms.length > 0 && terms.every((term) => term(row))));
}

/** Creates a {@link RecordingDb} over schema `content`; nothing connects to PostgreSQL. */
export function createRecordingDb(): RecordingDb {
  const statements: RecordedStatement[] = [];
  let responders: Array<{ pattern: RegExp; rows: ResponderRows }> = [];
  const gates = new Map<string, FakeGate>();
  const receipts = new Set<string>();
  const registry = new Map<string, Row>(registryPayloads().map((payload) => [tenantIdForSite(payload.siteId), registryRow(payload)]));
  /** `content.staged_object` rows by `<tenant_id>/<stage_id>`. */
  const stagedObjects = new Map<string, Row>();

  const gateOf = (unit: string): FakeGate => gates.get(unit) ?? OPEN_GATE;
  const answer = (rows: readonly Row[], rowCount: number | null = rows.length, command = 'SELECT') => ({
    command,
    rows: [...rows],
    rowCount,
    fields: [],
  });

  /**
   * The intent ledger's insert, claim by `stage_id`, state change and delete, each visible only in its own tenant as forced RLS
   * keeps it. Every intent settles within the request that staged it, so recovery's stale reads find none.
   */
  function stagedObjectAnswer(sql: string, params: readonly unknown[], tenantId: string | null) {
    const verb = verbOf(sql);
    const keyOf = (stageId: unknown): string => `${String(tenantId)}/${String(stageId)}`;
    if (verb === 'INSERT') {
      const rows = insertedRows(sql, params) ?? [];
      // bigint reads back as text; recorded_at defaults to clock_timestamp().
      for (const row of rows) stagedObjects.set(keyOf(row.stage_id), { ...row, size: String(row.size), recorded_at: new Date() });
      return answer([], rows.length, verb);
    }
    const key = / WHERE stage_id = \$1\b/i.test(sql) ? keyOf(params[0]) : undefined;
    const row = key === undefined ? undefined : stagedObjects.get(key);
    if (verb === 'SELECT') return answer(row === undefined ? [] : [{ ...row }]);
    if (verb === 'UPDATE') {
      const state = / SET state = '(\w+)'/i.exec(sql)?.[1];
      if (row !== undefined && state !== undefined) row.state = state;
      return answer([], row === undefined ? 0 : 1, verb);
    }
    return answer([], key !== undefined && verb === 'DELETE' && stagedObjects.delete(key) ? 1 : 0, verb);
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
      return {
        async query(text: string | { text: string; values?: unknown[] }, values?: unknown[]) {
          const sql = collapse(typeof text === 'string' ? text : text.text);
          const params = (typeof text === 'string' ? values : (text.values ?? values)) ?? [];
          statements.push({ sql, params, tenantId: session.tenantId });
          for (let i = responders.length - 1; i >= 0; i -= 1) {
            const responder = responders[i];
            if (responder !== undefined && responder.pattern.test(sql)) {
              const rows = typeof responder.rows === 'function' ? responder.rows(params, sql) : responder.rows;
              return answer(rows, rows.length, verbOf(sql));
            }
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
    respond(pattern: RegExp, rows: ResponderRows): void {
      responders.push({ pattern, rows });
    },
    setGate(unit: string, gate: Partial<FakeGate>): void {
      gates.set(unit, { ...gateOf(unit), ...gate });
    },
    clear(): void {
      statements.length = 0;
    },
    reset(): void {
      statements.length = 0;
      responders = [];
      gates.clear();
      receipts.clear();
      stagedObjects.clear();
    },
  });
}

/** A TaskPort over in-memory queues that records each call. */
export interface FakeTaskPort extends TaskPort {
  readonly kind: 'local';
  /** Every call, as `<op> <queue>`. */
  readonly calls: string[];
}

/** Creates a {@link FakeTaskPort}; a name created once on a queue answers `created: false` again, as Cloud Tasks tombstones do. */
export function createFakeTaskPort(): FakeTaskPort {
  const calls: string[] = [];
  const live = new Map<string, CreateTaskInput>();
  const paused = new Set<string>();
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
    calls,
    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      calls.push(`create ${input.queue}`);
      const key = keyOf(input.queue, input.name);
      if (live.has(key)) return { name: input.name, created: false };
      live.set(key, input);
      return { name: input.name, created: true };
    },
    async delete(queue: string, name: string): Promise<DeleteTaskResult> {
      calls.push(`delete ${queue}`);
      return { name, deleted: live.delete(keyOf(queue, name)) };
    },
    async list(queue: string) {
      calls.push(`list ${queue}`);
      return { tasks: [...live.values()].filter((input) => input.queue === queue).map(infoOf) };
    },
    async get(queue: string, name: string): Promise<TaskInfo | undefined> {
      calls.push(`get ${queue}`);
      const input = live.get(keyOf(queue, name));
      return input === undefined ? undefined : infoOf(input);
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
  };
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

/** Environment of a test app; the JWKS URL is never fetched, as the test verifier replaces the remote key set. */
export function testEnv(stateDir: string): Record<string, string> {
  return {
    PORT: '8114',
    OPT2_SERVICE_NAME: SERVICE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: stateDir,
    OPT2_SERVICE_URLS: JSON.stringify({ [SERVICE]: 'http://127.0.0.1:8114', 'programs-sites': 'http://127.0.0.1:8113' }),
    TZ: 'UTC',
  };
}

/**
 * Builds strategies-content with every route its source registers: the header prompts, the people file lookup, the migration
 * object transfer, the signed file downloads, the comments proxy, the platform migration handlers over the content mappings,
 * the four push consumers and queue control.
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
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    const repository = createContentRepository({ clock: TEST_CLOCK, schema: db.schema });
    registerWritePositionHeader(app);
    await registerHeaderPromptRoutes(app, { domain: { db, repository, clock: TEST_CLOCK } });
    await registerFileLookupRoutes(app, { db });
    registerMigrationObjectRoutes(app, { domain: { db, repository }, storage, clock: TEST_CLOCK });
    registerFileRoutes(app, { domain: { db, repository }, storage, clock: TEST_CLOCK });
    registerCommentsProxyRoutes(app, { domain: { db, repository, clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS } });
    registerMigrationHandlers(app, { owner: OWNER, repository: repository.platform, mappings, units, db, exportObjects });
    registerConsumers(app, { service: SERVICE, consumers: contentConsumers(repository), publisher, db });
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
