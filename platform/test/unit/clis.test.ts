import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DestinationStream } from 'pino';
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles, rolesForService, verifyLocalServiceToken } from '../../src/auth/index.js';
import type { EventPublisher } from '../../src/events/index.js';
import { createLogger, setDiagnosticLogger } from '../../src/logging/index.js';
import { UsageError, main, parseArgs, runReplay, serviceSchema } from '../../src/outbox/cli.js';
import { localTimestamp } from '../../src/outbox/ddl.js';
import { resetOutboxRuntimes, type OutboxRuntime } from '../../src/outbox/flush.js';
import {
  baseEnvSchema,
  fixedClock,
  type ServiceClientOptions,
  type ServiceRequest,
  type ServiceResponse,
} from '../../src/service-kit/index.js';
import { main as tasksMain } from '../../src/tasks/cli.js';
import type { MetadataTx, TenantDb, TenantTx } from '../../src/tenancy/index.js';
import { tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import { testSigningKeys, writeTestSecrets } from '../../src/testing/tokens.js';

type WriteCallback = (err?: Error | null) => void;

type LogLine = Record<string, unknown>;

/** One outbox row as the fake table stores it; `seq` is unique across tenants, as the identity column is. */
interface StoredRow {
  seq: number;
  tenantId: string;
  orderingKey: string;
  publishedAt?: string;
  held?: boolean;
  /** Defaults to CREATED_AT, after SINCE. */
  createdAt?: string;
}

interface Statement {
  tenantId: string | null;
  sql: string;
  values: unknown[] | undefined;
}

const state = vi.hoisted(() => ({ createPool: vi.fn(), createPublisher: vi.fn(), createServiceClient: vi.fn() }));

vi.mock('../../src/tenancy/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tenancy/index.js')>()),
  createPool: state.createPool,
}));

vi.mock('../../src/events/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/events/index.js')>()),
  createPublisher: state.createPublisher,
}));

vi.mock('../../src/service-kit/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/service-kit/index.js')>()),
  createServiceClient: state.createServiceClient,
}));

const USAGE = 'usage: opt2-outbox replay --since <ISO-8601 timestamp> [--tenant <uuid>] [--schema <name>]';
const SINCE_FORMAT = '--since must be an ISO-8601 timestamp with a date, time and zone, such as 2026-06-30T00:00:00Z';
/** Every variable opt2-outbox reads, as its help lists them. */
const REPLAY_VARIABLES = [
  'OPT2_SERVICE_NAME',
  'OPT2_ENV',
  'TZ',
  'OPT2_DB_AUTH',
  'PG_DATABASE',
  'PG_USER',
  'PG_HOST',
  'PG_PORT',
  'PG_PASSWORD',
  'CLOUD_SQL_INSTANCE',
  'GOOGLE_CLOUD_PROJECT',
  'PUBSUB_EMULATOR_HOST',
];
const ALL_UNSET: Record<string, undefined> = Object.fromEntries(Object.keys(baseEnvSchema.shape).map((key) => [key, undefined]));
const IAM_INSTANCE = 'opt2-unit:europe-west2:main';
const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const SINCE_ISO = '2026-06-01T09:30:00.000Z';
const SINCE = new Date(SINCE_ISO);
const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const CREATED_AT = '2026-06-15 10:00:00.000';
const TOPIC = 'people.person.archived.v1';
/** The logged error of a publish a timeout signal ended. */
const TIMED_OUT = { type: 'TimeoutError', message: 'The operation was aborted due to timeout' };

const ENV: Record<string, string> = {
  PORT: '8112',
  OPT2_SERVICE_NAME: 'people',
  OPT2_ENV: 'local',
  OPT2_DB_AUTH: 'password',
  PG_HOST: '127.0.0.1',
  PG_PORT: '5432',
  PG_DATABASE: 'masa_services_unit',
  PG_USER: 'people_app',
  PG_PASSWORD: 'unused',
  PUBSUB_EMULATOR_HOST: 'localhost:8085',
  GOOGLE_CLOUD_PROJECT: 'opt2-unit',
  OPT2_JWKS_URL: 'http://127.0.0.1:8111/internal/v1/jwks',
  OPT2_TOKEN_ISSUER: 'opt2-local-identity',
  OPT2_TOKEN_AUDIENCE: 'opt2-local',
};

let stdout: string;
let stderr: string;

/** The replay SELECT of a tenant's last seq created since `$1` against `schema`. */
function boundSql(schema: string): string {
  return `SELECT max(seq)::text AS bound FROM "${schema}".outbox WHERE created_at >= $1`;
}

/** The replay page SELECT against `schema`. */
function selectSql(schema: string): string {
  return (
    `SELECT * FROM "${schema}".outbox WHERE NOT held AND created_at >= $1 AND seq > $2::bigint AND seq <= $3::bigint` +
    ' ORDER BY seq LIMIT $4 FOR UPDATE'
  );
}

/** The SELECT of each ordering key's first unlocked unpublished or held row against `schema`. */
function blockerSql(schema: string): string {
  return (
    `SELECT ordering_key, min(seq)::text AS seq FROM "${schema}".outbox` +
    ' WHERE ((published_at IS NULL AND NOT held) OR held) AND ordering_key = ANY($1::text[])' +
    ' AND seq < $2::bigint AND seq <> ALL($3::bigint[]) GROUP BY ordering_key'
  );
}

/** The stamp UPDATE against `schema`. */
function stampSql(schema: string): string {
  return `UPDATE "${schema}".outbox SET published_at = $1 WHERE event_id = ANY($2::uuid[]) AND published_at IS NULL`;
}

/** A 36-character RFC 4122 event id ending in `seq`. */
function eventId(seq: number): string {
  return `0f7c6a52-0c8e-4d8e-9a43-${seq.toString(16).padStart(12, '0')}`;
}

/** The envelope stored with `row`. */
function envelope(row: StoredRow): Record<string, unknown> {
  return { eventId: eventId(row.seq), tenantId: row.tenantId, aggregateId: row.orderingKey, payload: { seq: row.seq } };
}

/** A snake_case outbox row as pg returns it, `seq` as text. */
function dbRow(row: StoredRow): QueryResultRow {
  return {
    seq: String(row.seq),
    tenant_id: row.tenantId,
    event_id: eventId(row.seq),
    topic: TOPIC,
    kind: 'state',
    ordering_key: row.orderingKey,
    envelope: envelope(row),
    operation_id: null,
    held: row.held ?? false,
    created_at: row.createdAt ?? CREATED_AT,
    published_at: row.publishedAt ?? null,
  };
}

function rows(tenantId: string, seqs: readonly number[], key = (seq: number) => `key-${String(seq)}`): StoredRow[] {
  return seqs.map((seq) => ({ seq, tenantId, orderingKey: key(seq) }));
}

function result<R extends QueryResultRow>(command: string, found: QueryResultRow[]): QueryResult<R> {
  return { command, rowCount: found.length, oid: 0, fields: [], rows: found as R[] };
}

/** The first unpublished or held row of each of `keys` before seq `last` and outside `seqs`, as the blocker SELECT answers. */
function blockers(tenantRows: readonly StoredRow[], [keys, last, seqs]: [string[], string, string[]]): QueryResultRow[] {
  const first = new Map<string, number>();
  for (const row of tenantRows) {
    const open = row.publishedAt === undefined || row.held === true;
    if (open && keys.includes(row.orderingKey) && row.seq < Number(last) && !seqs.includes(String(row.seq))) {
      first.set(row.orderingKey, Math.min(first.get(row.orderingKey) ?? Number.POSITIVE_INFINITY, row.seq));
    }
  }
  return [...first].map(([key, seq]) => ({ ordering_key: key, seq: String(seq) }));
}

/**
 * A TenantDb over `stored`, answering as PostgreSQL would: the bound SELECT with the tenant's last seq since `$1`, the page
 * SELECT with its unheld rows since `$1` after `$2` up to `$3`, at most `$4`, in seq order, the blocker SELECT from the
 * stored rows and the registry SELECT with `registry`; the stamp UPDATE marks rows published. `beforePage` runs ahead of
 * each page with its `after`. Records every statement and every tenant transaction.
 */
function fakeDb(
  stored: readonly StoredRow[],
  opts: { schema?: string; registry?: readonly string[]; beforePage?: (after: string) => void } = {},
) {
  const schema = opts.schema ?? 'people';
  const statements: Statement[] = [];
  const tenants: string[] = [];
  const end = vi.fn(() => Promise.resolve());
  const withMetadata = vi.fn();
  const registry = (opts.registry ?? []).map((id, n) => ({ tenant_id: id, site_id: `site-${String(n)}` }));
  const query = (tenantId: string | null) =>
    function <R extends QueryResultRow = QueryResultRow>(
      text: string | QueryConfig,
      values?: unknown[],
    ): Promise<QueryResult<R>> {
      const sql = typeof text === 'string' ? text : text.text;
      statements.push({ tenantId, sql, values });
      if (tenantId === null) {
        return Promise.resolve(result<R>('SELECT', registry));
      }
      if (sql === selectSql(schema)) {
        opts.beforePage?.((values as [string, string])[1]);
      }
      const tenantRows = stored.filter((row) => row.tenantId === tenantId);
      if (sql.startsWith('UPDATE')) {
        const [stamp, ids] = values as [string, string[]];
        for (const row of tenantRows) {
          if (row.publishedAt === undefined && ids.includes(eventId(row.seq))) row.publishedAt = stamp;
        }
        return Promise.resolve(result<R>('UPDATE', []));
      }
      if (sql === blockerSql(schema)) {
        return Promise.resolve(result<R>('SELECT', blockers(tenantRows, values as [string[], string, string[]])));
      }
      const since = (values as [string])[0];
      const inRange = tenantRows.filter((row) => (row.createdAt ?? CREATED_AT) >= since);
      if (sql === boundSql(schema)) {
        const bound = inRange.length === 0 ? null : String(Math.max(...inRange.map((row) => row.seq)));
        return Promise.resolve(result<R>('SELECT', [{ bound }]));
      }
      const [, after, bound, limit] = values as [string, string, string, number];
      const page = inRange
        .filter((row) => row.held !== true && row.seq > Number(after) && row.seq <= Number(bound))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map(dbRow);
      return Promise.resolve(result<R>('SELECT', page));
    };
  withMetadata.mockImplementation((fn: (tx: MetadataTx) => Promise<unknown>) =>
    fn({ schema, kind: 'metadata', onCommit: vi.fn(), query: query(null) }),
  );
  const db: TenantDb = {
    schema,
    withTenant: (tenantId, fn) => {
      tenants.push(tenantId);
      const tx: TenantTx = { schema, kind: 'tenant', tenantId, onCommit: vi.fn(), query: query(tenantId) };
      return fn(tx);
    },
    withMetadata: withMetadata as TenantDb['withMetadata'],
    end,
  };
  const bounds = () => statements.filter((s) => s.sql === boundSql(schema));
  const pages = () => statements.filter((s) => s.sql === selectSql(schema));
  const updates = () => statements.filter((s) => s.sql.startsWith('UPDATE'));
  return { db, statements, tenants, end, withMetadata, bounds, pages, updates };
}

/** A publisher whose publish rejects for the `failing` event ids and never settles for the `pending` ones; `order` records close calls. */
function fakePublisher(failing: readonly string[] = [], order: string[] = [], pending: readonly string[] = []) {
  const publish = vi.fn((_topic: string, sent: { eventId: string }) =>
    failing.includes(sent.eventId)
      ? Promise.reject(new Error(`publish rejected ${sent.eventId}`))
      : pending.includes(sent.eventId)
        ? new Promise<string>(() => undefined)
        : Promise.resolve(`msg-${sent.eventId}`),
  );
  const close = vi.fn(() => {
    order.push('publisher.close');
    return Promise.resolve();
  });
  const publisher = { publish, publishRaw: vi.fn(), close } as unknown as EventPublisher;
  return { publisher, publish, close };
}

function runtimeWith(db: TenantDb, failing: readonly string[] = [], pending: readonly string[] = []) {
  const lines: LogLine[] = [];
  const destination: DestinationStream = { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) };
  const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination });
  const { publisher, publish } = fakePublisher(failing, [], pending);
  const runtime: OutboxRuntime = { service: 'people', db, publisher, logger, clock: fixedClock(NOW) };
  return { runtime, publish, lines };
}

function publishedIds(publish: ReturnType<typeof fakePublisher>['publish']): string[] {
  return publish.mock.calls.map(([, sent]) => sent.eventId);
}

/** A `write` replacement that appends each chunk to `sink` and answers the callback with `error`. */
function capture(sink: (chunk: string) => void, error: Error | null = null) {
  return (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(error);
    return error === null;
  };
}

/** Sets every base variable from ENV and `overrides`, with TZ as the zone this process already applies. */
function stubEnv(overrides: Record<string, string | undefined> = {}): void {
  const env: Record<string, string | undefined> = { ...ENV, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, ...overrides };
  for (const key of Object.keys(baseEnvSchema.shape)) vi.stubEnv(key, env[key]);
}

function usageErrorOf(argv: string[]): UsageError {
  try {
    parseArgs(argv);
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error(`expected parseArgs to reject ${JSON.stringify(argv)}`);
}

function stderrLines(): LogLine[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogLine);
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  state.createPool.mockReset();
  state.createPublisher.mockReset();
  vi.spyOn(process.stdout, 'write').mockImplementation(capture((chunk) => (stdout += chunk)));
  vi.spyOn(process.stderr, 'write').mockImplementation(capture((chunk) => (stderr += chunk)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetOutboxRuntimes();
});

describe('opt2-outbox parseArgs', () => {
  it.each([
    { argv: ['replay', '--since', SINCE_ISO], expected: { since: SINCE } },
    {
      argv: ['replay', '--since', SINCE_ISO, '--tenant', TENANT_A, '--schema', 'programs_sites'],
      expected: { since: SINCE, tenant: TENANT_A, schema: 'programs_sites' },
    },
    {
      argv: ['--since=2026-06-01T00:00:00Z', 'replay', '--tenant', TENANT_B.toUpperCase()],
      expected: { since: new Date(Date.UTC(2026, 5, 1)), tenant: TENANT_B.toUpperCase() },
    },
    { argv: ['replay', '--since', '2026-06-30T12:00:00+05:30'], expected: { since: new Date(Date.UTC(2026, 5, 30, 6, 30)) } },
    { argv: ['replay', '--since', '2026-06-30T23:30-04:00'], expected: { since: new Date(Date.UTC(2026, 6, 1, 3, 30)) } },
    { argv: ['replay', '--since', '2026-06-30T12:00:00.25Z'], expected: { since: new Date(Date.UTC(2026, 5, 30, 12, 0, 0, 250)) } },
    { argv: ['replay', '--since', '2028-02-29T23:59:59-00:00'], expected: { since: new Date(Date.UTC(2028, 1, 29, 23, 59, 59)) } },
  ])('parses $argv', ({ argv, expected }) => {
    expect(parseArgs(argv)).toStrictEqual(expected);
  });

  it.each([[['--help']], [['-h']], [['replay', '--since', 'soon', '-h']], [['sweep', '--help']]])(
    'returns help for %j ahead of every other check',
    (argv) => {
      expect(parseArgs(argv)).toBe('help');
    },
  );

  it.each([
    'yesterday',
    '1',
    'March 7',
    '2026-02-30',
    '99999',
    '2026-06-30 12:00',
    '2026-06-01',
    '2026-06-30T12:00:00',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-06-30T24:00:00Z',
    '2026-06-30T12:00:60Z',
    '2026-06-30T12:00:00+24:00',
  ])('rejects --since %j, which is not an ISO-8601 date-time with a zone that exists', (since) => {
    expect(usageErrorOf(['replay', '--since', since]).message).toBe(`${SINCE_FORMAT}, got ${JSON.stringify(since)}`);
  });

  it.each([
    { argv: [], message: /^missing subcommand$/ },
    { argv: ['--since', SINCE_ISO], message: /^missing subcommand$/ },
    { argv: ['sweep', '--since', SINCE_ISO], message: /^unknown subcommand "sweep"$/ },
    { argv: ['replay', 'extra', '--since', SINCE_ISO], message: /^unknown subcommand "replay extra"$/ },
    { argv: ['replay', '--since', SINCE_ISO, '--verbose'], message: /^Unknown option '--verbose'/ },
    { argv: ['replay', '--since'], message: /^Option '--since <value>' argument missing/ },
    { argv: ['replay'], message: /^missing --since$/ },
    {
      argv: ['replay', '--since', SINCE_ISO, '--tenant', 'tenant-a'],
      message: /^--tenant must be a tenant UUID, got "tenant-a"$/,
    },
    {
      argv: ['replay', '--since', SINCE_ISO, '--schema', 'Programs-Sites'],
      message: /^--schema: Invalid schema identifier: "Programs-Sites"$/,
    },
    { argv: ['replay', '--since', SINCE_ISO, '--schema', 'x".outbox'], message: /^--schema: Invalid schema identifier: / },
  ])('rejects $argv with a UsageError', ({ argv, message }) => {
    expect(usageErrorOf(argv).message).toMatch(message);
  });
});

describe('opt2-outbox serviceSchema', () => {
  it.each([
    ['programs-sites', 'programs_sites'],
    ['strategies-content', 'content'],
    ['e-signature', 'esignature'],
    ['people', 'people'],
    ['surveys', 'surveys'],
  ])('maps service %s to schema %s', (service, schema) => {
    expect(serviceSchema(service)).toBe(schema);
  });
});

describe('opt2-outbox runReplay', () => {
  it('republishes each stored envelope since the cut-off with its original eventId, stamping only unpublished rows', async () => {
    const stored = rows(TENANT_A, [1, 2, 3, 4, 5]);
    (stored[1] as StoredRow).publishedAt = '2026-06-20 08:00:00.000';
    const { db, bounds, pages, updates, tenants } = fakeDb(stored);
    const { runtime, publish } = runtimeWith(db);

    const summary = await runReplay({ runtime, since: SINCE, tenantsOf: () => Promise.resolve([TENANT_A]), batchSize: 2 });

    expect(summary).toEqual({ replayed: 5, failed: 0, skipped: 0, tenants: 1 });
    expect(publish.mock.calls).toEqual(stored.map((row) => [TOPIC, envelope(row)]));
    expect(bounds()).toEqual([{ tenantId: TENANT_A, sql: boundSql('people'), values: [localTimestamp(SINCE)] }]);
    expect(pages().map((s) => s.sql)).toEqual([selectSql('people'), selectSql('people'), selectSql('people')]);
    expect(pages().every((s) => s.values?.[0] === localTimestamp(SINCE))).toBe(true);
    expect(updates()).toEqual([
      { tenantId: TENANT_A, sql: stampSql('people'), values: [localTimestamp(NOW), [eventId(1), eventId(2)]] },
      { tenantId: TENANT_A, sql: stampSql('people'), values: [localTimestamp(NOW), [eventId(3), eventId(4)]] },
      { tenantId: TENANT_A, sql: stampSql('people'), values: [localTimestamp(NOW), [eventId(5)]] },
    ]);
    expect(tenants).toEqual([TENANT_A, TENANT_A, TENANT_A, TENANT_A]);
  });

  it.each([
    { count: 5, batchSize: 2, batch: '2', pages: [['0', '5', 2], ['2', '5', 2], ['4', '5', 2]] },
    { count: 4, batchSize: 2, batch: '2', pages: [['0', '4', 2], ['2', '4', 2]] },
    { count: 3, batchSize: undefined, batch: 'the default 500', pages: [['0', '3', 500]] },
    { count: 0, batchSize: 1, batch: '1', pages: [] },
  ])('pages $count rows by seq in batches of $batch up to the bound read first', async ({ count, batchSize, pages: expected }) => {
    const { db, pages } = fakeDb(rows(TENANT_A, Array.from({ length: count }, (_, n) => n + 1)));
    const { runtime, publish } = runtimeWith(db);

    const summary = await runReplay({ runtime, since: SINCE, tenant: TENANT_A, batchSize });

    expect(summary).toEqual({ replayed: count, failed: 0, skipped: 0, tenants: 1 });
    expect(pages().map((s) => s.values?.slice(1))).toEqual(expected);
    expect(publish).toHaveBeenCalledTimes(count);
  });

  it('never pages past the bound read first while rows keep arriving', async () => {
    const stored = rows(TENANT_A, [1, 2]);
    const { db, pages } = fakeDb(stored, { beforePage: () => stored.push(...rows(TENANT_A, [stored.length + 1])) });
    const { runtime, publish } = runtimeWith(db);

    const summary = await runReplay({ runtime, since: SINCE, tenant: TENANT_A, batchSize: 1 });

    expect(summary).toEqual({ replayed: 2, failed: 0, skipped: 0, tenants: 1 });
    expect(publishedIds(publish)).toEqual([eventId(1), eventId(2)]);
    expect(pages().map((s) => s.values?.slice(1))).toEqual([['0', '2', 1], ['1', '2', 1]]);
  });

  it('skips rows behind an earlier unpublished or held row of their key, and the key on later pages', async () => {
    const stored: StoredRow[] = [
      { seq: 1, tenantId: TENANT_A, orderingKey: 'key-a', createdAt: '2026-05-01 00:00:00.000' },
      { seq: 2, tenantId: TENANT_A, orderingKey: 'key-a', publishedAt: CREATED_AT },
      { seq: 3, tenantId: TENANT_A, orderingKey: 'key-b' },
      { seq: 4, tenantId: TENANT_A, orderingKey: 'key-c', held: true },
      { seq: 5, tenantId: TENANT_A, orderingKey: 'key-c' },
      { seq: 6, tenantId: TENANT_A, orderingKey: 'key-a', publishedAt: CREATED_AT },
    ];
    // A concurrent publisher sends row 1 before the second page, so only the stopped key keeps row 6 back.
    const beforePage = (after: string) => {
      if (after !== '0') (stored[0] as StoredRow).publishedAt = CREATED_AT;
    };
    const { db, statements } = fakeDb(stored, { beforePage });
    const { runtime, publish } = runtimeWith(db);

    const summary = await runReplay({ runtime, since: SINCE, tenant: TENANT_A, batchSize: 3 });

    expect(summary).toEqual({ replayed: 1, failed: 0, skipped: 3, tenants: 1 });
    expect(publishedIds(publish)).toEqual([eventId(3)]);
    expect(statements.filter((s) => s.sql === blockerSql('people')).map((s) => s.values)).toEqual([
      [['key-a', 'key-b', 'key-c'], '5', ['2', '3', '5']],
      [['key-a'], '6', ['6']],
    ]);
  });

  it('counts a failed row and skips later rows with its ordering key on the same and on later pages', async () => {
    const keys: Record<number, string> = { 1: 'key-a', 2: 'key-a', 3: 'key-b', 4: 'key-a', 5: 'key-b' };
    const { db, updates } = fakeDb(rows(TENANT_A, [1, 2, 3, 4, 5], (seq) => keys[seq] as string));
    const { runtime, publish, lines } = runtimeWith(db, [eventId(1)]);

    const summary = await runReplay({ runtime, since: SINCE, tenant: TENANT_A, batchSize: 3 });

    expect(summary).toEqual({ replayed: 2, failed: 1, skipped: 2, tenants: 1 });
    expect(publishedIds(publish)).toEqual([eventId(1), eventId(3), eventId(5)]);
    expect(updates().map((s) => s.values?.[1])).toEqual([[eventId(3)], [eventId(5)]]);
    expect(lines).toEqual([
      expect.objectContaining({ severity: 'ERROR', message: 'outbox publish failed', eventId: eventId(1) }),
    ]);
  });

  it('ends at the first publish stalled for publishStallMs, counting it failed and replaying no later page or tenant', async () => {
    const { db, updates, tenants } = fakeDb([...rows(TENANT_A, [1, 2, 3]), ...rows(TENANT_B, [4])]);
    const { runtime, publish, lines } = runtimeWith(db, [], [eventId(2)]);
    const tenantsOf = () => Promise.resolve([TENANT_A, TENANT_B]);
    const started = performance.now();

    const summary = await runReplay({ runtime, since: SINCE, tenantsOf, batchSize: 2, publishStallMs: 50 });

    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1_050);
    expect(summary).toEqual({ replayed: 1, failed: 1, skipped: 0, tenants: 2 });
    expect(publishedIds(publish)).toEqual([eventId(1), eventId(2)]);
    expect(updates().map((s) => s.values?.[1])).toEqual([[eventId(1)]]);
    // The bound read, then the one page whose publish stalled.
    expect(tenants).toEqual([TENANT_A, TENANT_A]);
    expect(lines).toMatchObject([
      { severity: 'ERROR', message: 'outbox publish failed', eventId: eventId(2), error: TIMED_OUT },
      {
        severity: 'WARNING',
        message: 'outbox replay ended early after a publish stalled for 50 ms',
        tenantId: TENANT_A,
        error: TIMED_OUT,
      },
    ]);
  });

  it.each([
    {
      stopped: 'failed',
      stored: [
        { seq: 1, tenantId: TENANT_A, orderingKey: 'key-k', publishedAt: CREATED_AT },
        { seq: 2, tenantId: TENANT_B, orderingKey: 'key-k', publishedAt: CREATED_AT },
        { seq: 3, tenantId: TENANT_A, orderingKey: 'key-k', publishedAt: CREATED_AT },
      ],
      failing: [eventId(1)],
      summary: { replayed: 1, failed: 1, skipped: 1, tenants: 2 },
      sent: [eventId(1), eventId(2)],
    },
    {
      stopped: 'blocked',
      stored: [
        { seq: 1, tenantId: TENANT_A, orderingKey: 'key-k', held: true },
        { seq: 2, tenantId: TENANT_B, orderingKey: 'key-k', publishedAt: CREATED_AT },
        { seq: 3, tenantId: TENANT_A, orderingKey: 'key-k' },
      ],
      failing: [],
      summary: { replayed: 1, failed: 0, skipped: 1, tenants: 2 },
      sent: [eventId(2)],
    },
  ])('stops a $stopped key in its own tenant only, still replaying that key in the next tenant', async ({ stored, failing, summary, sent }) => {
    const { db } = fakeDb(stored);
    const { runtime, publish } = runtimeWith(db, failing);

    const result = await runReplay({ runtime, since: SINCE, tenantsOf: () => Promise.resolve([TENANT_A, TENANT_B]), batchSize: 1 });

    expect(result).toEqual(summary);
    expect(publishedIds(publish)).toEqual(sent);
  });

  it('replays each listed tenant once when ids differ only in case', async () => {
    const { db, tenants } = fakeDb([...rows(TENANT_A, [1, 3]), ...rows(TENANT_B, [2])]);
    const { runtime, publish } = runtimeWith(db);
    const tenantsOf = () => Promise.resolve([TENANT_A.toUpperCase(), TENANT_A, TENANT_B]);

    const summary = await runReplay({ runtime, since: SINCE, tenantsOf });

    expect(summary).toEqual({ replayed: 3, failed: 0, skipped: 0, tenants: 2 });
    // Each tenant's bound read, then its one page.
    expect(tenants).toEqual([TENANT_A, TENANT_A, TENANT_B, TENANT_B]);
    expect(publishedIds(publish)).toEqual([eventId(1), eventId(3), eventId(2)]);
  });

  it('lists the tenants of the service tenant_registry when neither --tenant nor tenantsOf is given', async () => {
    const { db, tenants, statements } = fakeDb([...rows(TENANT_A, [1]), ...rows(TENANT_B, [2])], {
      registry: [TENANT_B, TENANT_A, TENANT_B],
    });
    const { runtime } = runtimeWith(db);

    const summary = await runReplay({ runtime, since: SINCE });

    expect(summary).toEqual({ replayed: 2, failed: 0, skipped: 0, tenants: 2 });
    expect(statements[0]).toEqual({
      tenantId: null,
      sql: 'SELECT tenant_id, site_id FROM people.tenant_registry ORDER BY site_id',
      values: undefined,
    });
    expect(tenants).toEqual([TENANT_B, TENANT_B, TENANT_A, TENANT_A]);
  });

  it('replays only the given --tenant, case-folded, without listing tenants', async () => {
    const { db, tenants, withMetadata } = fakeDb([...rows(TENANT_A, [1]), ...rows(TENANT_B, [2])], {
      registry: [TENANT_A, TENANT_B],
    });
    const { runtime, publish } = runtimeWith(db);
    const tenantsOf = vi.fn(() => Promise.resolve([TENANT_B]));

    const summary = await runReplay({ runtime, since: SINCE, tenant: TENANT_A.toUpperCase(), tenantsOf });

    expect(summary).toEqual({ replayed: 1, failed: 0, skipped: 0, tenants: 1 });
    expect(tenants).toEqual([TENANT_A, TENANT_A]);
    expect(publishedIds(publish)).toEqual([eventId(1)]);
    expect(tenantsOf).not.toHaveBeenCalled();
    expect(withMetadata).not.toHaveBeenCalled();
  });

  it.each([0, -1, 2.5, Number.NaN])('rejects batchSize %s before listing tenants or opening a transaction', async (batchSize) => {
    const { db, tenants } = fakeDb(rows(TENANT_A, [1]));
    const { runtime } = runtimeWith(db);
    const tenantsOf = vi.fn(() => Promise.resolve([TENANT_A]));

    await expect(runReplay({ runtime, since: SINCE, tenantsOf, batchSize })).rejects.toThrow(
      new RangeError(`batchSize must be a positive integer, got ${String(batchSize)}`),
    );
    expect(tenantsOf).not.toHaveBeenCalled();
    expect(tenants).toEqual([]);
  });
});

describe('opt2-outbox main', () => {
  /** Answers createPool with `db` and createPublisher with `publisher`, recording pool end after publisher close. */
  function serve(db: ReturnType<typeof fakeDb>, publisher: ReturnType<typeof fakePublisher>, order: string[]): void {
    db.end.mockImplementation(() => {
      order.push('db.end');
      return Promise.resolve();
    });
    state.createPool.mockResolvedValue(db.db);
    state.createPublisher.mockReturnValue(publisher.publisher);
  }

  it('replays each registry tenant of the service schema, prints the summary, then closes publisher and pool', async () => {
    stubEnv({ OPT2_SERVICE_NAME: 'programs-sites' });
    const order: string[] = [];
    const db = fakeDb([...rows(TENANT_A, [1]), ...rows(TENANT_B, [2])], {
      schema: 'programs_sites',
      registry: [TENANT_A, TENANT_B],
    });
    const publisher = fakePublisher([], order);
    serve(db, publisher, order);

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(0);

    expect(stdout).toBe(`{"schema":"programs_sites","since":"${SINCE_ISO}","replayed":2,"failed":0,"skipped":0,"tenants":2}\n`);
    expect(stderr).toBe('');
    expect(state.createPool).toHaveBeenCalledTimes(1);
    const [options] = state.createPool.mock.calls[0] as [{ env: object; schema: string; onError: unknown }];
    expect(options.env).toMatchObject({ OPT2_DB_AUTH: 'password', PG_DATABASE: 'masa_services_unit', PG_USER: 'people_app' });
    expect(options.schema).toBe('programs_sites');
    expect(options.onError).toBeTypeOf('function');
    expect(state.createPublisher).toHaveBeenCalledWith({ projectId: 'opt2-unit', emulatorHost: 'localhost:8085' });
    expect(publishedIds(publisher.publish)).toEqual([eventId(1), eventId(2)]);
    expect(order).toEqual(['publisher.close', 'db.end']);
  });

  it('replays only --tenant in --schema and echoes the tenant in the summary line', async () => {
    stubEnv();
    const order: string[] = [];
    const db = fakeDb([...rows(TENANT_A, [1]), ...rows(TENANT_B, [2])], { schema: 'stub' });
    const publisher = fakePublisher([], order);
    serve(db, publisher, order);

    expect(await main(['replay', '--since', SINCE_ISO, '--tenant', TENANT_B, '--schema', 'stub'])).toBe(0);

    expect(stdout).toBe(
      `{"schema":"stub","since":"${SINCE_ISO}","tenant":"${TENANT_B}","replayed":1,"failed":0,"skipped":0,"tenants":1}\n`,
    );
    expect(state.createPool).toHaveBeenCalledWith(expect.objectContaining({ schema: 'stub' }));
    expect(db.withMetadata).not.toHaveBeenCalled();
    expect(db.tenants).toEqual([TENANT_B, TENANT_B]);
  });

  it('exits 1 when a row is skipped behind a held row of its key, though none failed', async () => {
    stubEnv();
    const order: string[] = [];
    const db = fakeDb(
      [
        { seq: 1, tenantId: TENANT_A, orderingKey: 'key-a', held: true },
        { seq: 2, tenantId: TENANT_A, orderingKey: 'key-a' },
      ],
      { registry: [TENANT_A] },
    );
    const publisher = fakePublisher([], order);
    serve(db, publisher, order);

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(1);

    expect(JSON.parse(stdout)).toEqual({ schema: 'people', since: SINCE_ISO, replayed: 0, failed: 0, skipped: 1, tenants: 1 });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(order).toEqual(['publisher.close', 'db.end']);
  });

  it('exits 1 and logs the failure on stderr when a row fails to republish', async () => {
    stubEnv();
    const order: string[] = [];
    const db = fakeDb(rows(TENANT_A, [1, 2]), { registry: [TENANT_A] });
    const publisher = fakePublisher([eventId(1)], order);
    serve(db, publisher, order);

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(1);

    expect(JSON.parse(stdout)).toEqual({ schema: 'people', since: SINCE_ISO, replayed: 1, failed: 1, skipped: 0, tenants: 1 });
    expect(stderrLines()).toEqual([
      expect.objectContaining({ severity: 'ERROR', service: 'people', message: 'outbox publish failed', eventId: eventId(1) }),
    ]);
    expect(order).toEqual(['publisher.close', 'db.end']);
  });

  it('logs pool errors on stderr, never on stdout', async () => {
    stubEnv();
    const order: string[] = [];
    serve(fakeDb([], { registry: [] }), fakePublisher([], order), order);

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(0);
    const [{ onError }] = state.createPool.mock.calls[0] as [{ onError: (err: unknown) => void }];
    onError(new Error('idle client terminated'));

    expect(stdout).toBe(`{"schema":"people","since":"${SINCE_ISO}","replayed":0,"failed":0,"skipped":0,"tenants":0}\n`);
    expect(stderrLines()).toMatchObject([{ severity: 'ERROR', message: 'database pool error', error: { type: 'Error' } }]);
  });

  it('exits 1 without a publisher when the pool cannot open', async () => {
    stubEnv();
    state.createPool.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(1);

    expect(stderr).toBe('opt2-outbox: connect ECONNREFUSED 127.0.0.1:5432\n');
    expect(stdout).toBe('');
    expect(state.createPublisher).not.toHaveBeenCalled();
  });

  it('ends the pool and exits 1 when the publisher cannot be created', async () => {
    stubEnv();
    const order: string[] = [];
    const db = fakeDb([], { registry: [TENANT_A] });
    serve(db, fakePublisher([], order), order);
    state.createPublisher.mockImplementation(() => {
      throw new Error('invalid project');
    });

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(1);

    expect(stderr).toBe('opt2-outbox: invalid project\n');
    expect(order).toEqual(['db.end']);
    expect(db.tenants).toEqual([]);
  });

  it('still ends the pool and exits 1 when closing the publisher fails', async () => {
    stubEnv();
    const order: string[] = [];
    const db = fakeDb(rows(TENANT_A, [1]), { registry: [TENANT_A] });
    const publisher = fakePublisher([], order);
    publisher.close.mockImplementation(() => {
      order.push('publisher.close');
      return Promise.reject(new Error('close timed out'));
    });
    serve(db, publisher, order);

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(1);

    expect(stderr).toBe('opt2-outbox: close timed out\n');
    expect(stdout).toBe('');
    expect(order).toEqual(['publisher.close', 'db.end']);
  });

  it('exits 1 when stdout cannot take the summary line', async () => {
    stubEnv();
    const order: string[] = [];
    serve(fakeDb([], { registry: [] }), fakePublisher([], order), order);
    vi.spyOn(process.stdout, 'write').mockImplementation(capture((chunk) => (stdout += chunk), new Error('write EPIPE')));

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(1);

    expect(stderr).toBe('opt2-outbox: write EPIPE\n');
  });

  it.each([
    { argv: [], message: 'missing subcommand' },
    { argv: ['replay'], message: 'missing --since' },
    { argv: ['replay', '--since', 'soon'], message: `${SINCE_FORMAT}, got "soon"` },
    { argv: ['replay', '--since', SINCE_ISO, '--tenant', 'default'], message: '--tenant must be a tenant UUID, got "default"' },
  ])('exits 2 with the usage line on stderr for $argv before reading the environment', async ({ argv, message }) => {
    stubEnv({ OPT2_SERVICE_NAME: undefined });

    expect(await main(argv)).toBe(2);

    expect(stderr).toBe(`opt2-outbox: ${message}; ${USAGE}\n`);
    expect(stdout).toBe('');
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it.each([[['--help']], [['-h']], [['replay', '--since', 'soon', '--help']]])(
    'prints the help on stdout and exits 0 for %j without reading the environment',
    async (argv) => {
      stubEnv(ALL_UNSET);

      expect(await main(argv)).toBe(0);

      expect(stdout.startsWith(`${USAGE}\n\n`)).toBe(true);
      for (const flag of ['--since <timestamp>', '--tenant <uuid>', '--schema <name>', '-h, --help']) {
        expect(stdout).toContain(`\n  ${flag} `);
      }
      const environment = stdout.slice(stdout.indexOf('\nEnvironment:\n'));
      for (const key of REPLAY_VARIABLES) expect(environment).toContain(`\n  ${key} `);
      expect(environment).toMatch(/\nExit codes: 0 [^\n]+, 1 [^\n]+, 2 [^\n]+\n$/);
      expect(stderr).toBe('');
      expect(state.createPool).not.toHaveBeenCalled();
      expect(state.createPublisher).not.toHaveBeenCalled();
    },
  );

  const required = (keys: string[]) => keys.map((key) => `${key}: is required`);
  const requiredWhen = (when: string, keys: string[]) => keys.map((key) => `${key}: is required when ${when}`);

  it.each([
    {
      label: 'every variable is unset',
      env: ALL_UNSET,
      issues: required(['OPT2_SERVICE_NAME', 'OPT2_ENV', 'PG_DATABASE', 'OPT2_DB_AUTH', 'GOOGLE_CLOUD_PROJECT', 'TZ']),
    },
    {
      label: 'only OPT2_DB_AUTH=password is set',
      env: { ...ALL_UNSET, OPT2_DB_AUTH: 'password' },
      issues: [
        ...required(['OPT2_SERVICE_NAME', 'OPT2_ENV', 'PG_DATABASE', 'GOOGLE_CLOUD_PROJECT', 'TZ']),
        ...requiredWhen('OPT2_DB_AUTH=password', ['PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD']),
      ],
    },
    { label: 'OPT2_DB_AUTH is unset', env: { OPT2_DB_AUTH: undefined }, issues: required(['OPT2_DB_AUTH']) },
    { label: 'GOOGLE_CLOUD_PROJECT is unset', env: { GOOGLE_CLOUD_PROJECT: undefined }, issues: required(['GOOGLE_CLOUD_PROJECT']) },
    {
      label: 'OPT2_DB_AUTH, PG_DATABASE and GOOGLE_CLOUD_PROJECT are unset',
      env: { OPT2_DB_AUTH: undefined, PG_DATABASE: undefined, GOOGLE_CLOUD_PROJECT: undefined },
      issues: required(['PG_DATABASE', 'OPT2_DB_AUTH', 'GOOGLE_CLOUD_PROJECT']),
    },
    {
      label: 'OPT2_DB_AUTH is invalid, which leaves its rules unchecked',
      env: { OPT2_DB_AUTH: 'Password', PG_HOST: undefined },
      issues: ['OPT2_DB_AUTH: Invalid option: expected one of "password"|"iam"'],
    },
    {
      label: 'OPT2_DB_AUTH=password runs in the cloud with the emulator',
      env: { OPT2_ENV: 'cloud' },
      issues: ['OPT2_ENV: must be local when OPT2_DB_AUTH=password', 'PUBSUB_EMULATOR_HOST: must be unset when OPT2_ENV=cloud'],
    },
    {
      label: 'OPT2_DB_AUTH=iam runs locally with a password and no instance',
      env: { OPT2_DB_AUTH: 'iam' },
      issues: [
        'CLOUD_SQL_INSTANCE: is required when OPT2_DB_AUTH=iam',
        'PG_PASSWORD: must be unset when OPT2_DB_AUTH=iam',
        'OPT2_ENV: must be cloud when OPT2_DB_AUTH=iam',
      ],
    },
    {
      label: 'OPT2_DB_AUTH=iam runs in the cloud without PG_USER, with the emulator',
      env: { OPT2_ENV: 'cloud', OPT2_DB_AUTH: 'iam', CLOUD_SQL_INSTANCE: IAM_INSTANCE, PG_PASSWORD: undefined, PG_USER: undefined },
      issues: ['PG_USER: is required when OPT2_DB_AUTH=iam', 'PUBSUB_EMULATOR_HOST: must be unset when OPT2_ENV=cloud'],
    },
    {
      label: 'an invalid PUBSUB_EMULATOR_HOST is set in the cloud, which is reported once',
      env: { OPT2_ENV: 'cloud', OPT2_DB_AUTH: 'iam', CLOUD_SQL_INSTANCE: IAM_INSTANCE, PG_PASSWORD: undefined, PUBSUB_EMULATOR_HOST: 'localhost:99999' },
      issues: ['PUBSUB_EMULATOR_HOST: port must be from 1 to 65535'],
    },
  ])('exits 2 with one error listing every issue when $label', async ({ env, issues }) => {
    stubEnv(env);

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(2);

    expect(stderr).toBe(`opt2-outbox: invalid environment\n${issues.map((issue) => `  ${issue}\n`).join('')}`);
    expect(stdout).toBe('');
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'PORT, OPT2_TOKEN_ISSUER, OPT2_TOKEN_AUDIENCE and OPT2_JWKS_URL unset',
      env: { PORT: undefined, OPT2_TOKEN_ISSUER: undefined, OPT2_TOKEN_AUDIENCE: undefined, OPT2_JWKS_URL: undefined },
      pool: { OPT2_DB_AUTH: 'password', PG_HOST: '127.0.0.1', PG_PORT: 5432, PG_PASSWORD: 'unused' },
      emulatorHost: 'localhost:8085',
    },
    {
      label: 'OPT2_DB_AUTH=iam in the cloud',
      env: { OPT2_ENV: 'cloud', OPT2_DB_AUTH: 'iam', CLOUD_SQL_INSTANCE: IAM_INSTANCE, PG_PASSWORD: undefined, PUBSUB_EMULATOR_HOST: undefined },
      pool: { OPT2_DB_AUTH: 'iam', CLOUD_SQL_INSTANCE: IAM_INSTANCE },
      emulatorHost: undefined,
    },
  ])('replays with $label', async ({ env, pool, emulatorHost }) => {
    stubEnv(env);
    const order: string[] = [];
    serve(fakeDb([], { registry: [] }), fakePublisher([], order), order);

    expect(await main(['replay', '--since', SINCE_ISO])).toBe(0);

    expect(stdout).toBe(`{"schema":"people","since":"${SINCE_ISO}","replayed":0,"failed":0,"skipped":0,"tenants":0}\n`);
    expect(stderr).toBe('');
    expect(state.createPool).toHaveBeenCalledWith(
      expect.objectContaining({ env: expect.objectContaining({ ...pool, PG_DATABASE: 'masa_services_unit', PG_USER: 'people_app' }) }),
    );
    expect(state.createPublisher).toHaveBeenCalledWith({ projectId: 'opt2-unit', emulatorHost });
  });

  it('exits with the code of main when loaded as the opt2-outbox bin', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const argv = process.argv;
    process.argv = [argv[0] as string, fileURLToPath(new URL('../../src/outbox/cli.ts', import.meta.url)), 'replay'];
    try {
      vi.resetModules();
      await import('../../src/outbox/cli.js');
    } finally {
      process.argv = argv;
    }

    expect(exit).toHaveBeenCalledWith(2);
    expect(stderr).toBe(`opt2-outbox: missing --since; ${USAGE}\n`);
  });
});

// opt2-auth and opt2-events are covered in auth-cli.test.ts and events-cli.test.ts, and the environment and HTTP paths of
// opt2-tasks in tasks-cli.test.ts; this suite covers how opt2-tasks turns its flags into ensure calls.
const TASKS_USAGE =
  'usage: opt2-tasks reconcile [--queue <name>]... [--with-sitemonitor] [--include-local-only] [--as operator|migration]';
const SITEMONITOR = 'programs-sites-sitemonitor';
const SLOT = 1782820800;
const PRODUCERS = ['identity', 'people', 'programs-sites', 'surveys', 'communications'] as const;
const SERVICE_URLS: Record<string, string> = Object.fromEntries(
  [...PRODUCERS, 'stub'].map((service) => [service, `http://${service}.invalid`]),
);

/** A recurring queue and the creator asked to ensure its chain. */
type Chain = readonly [queue: string, service: string];

const sweep = (service: string): Chain => [`${service}-outbox-sweep`, service];
const DEPLOYED_SWEEPS: Chain[] = PRODUCERS.map(sweep);
const STUB_SWEEP = sweep('stub');
const MONITOR: Chain = [SITEMONITOR, 'programs-sites'];

/** The queue-control call opt2-tasks sends to ensure `chain`. */
function ensureRequest([queue, service]: Chain): ServiceRequest {
  return { service, method: 'POST', path: `/internal/v1/task-queues/${queue}/ensure`, json: {}, userToken: null };
}

/** The stdout line of a chain whose creator created the current slot's task. */
function ensuredLine([queue, service]: Chain): Record<string, unknown> {
  return { queue, service, ok: true, created: true, name: `${queue}-${String(SLOT)}`, reason: 'created-current' };
}

/** A creator's 200 answer to an ensure call: the current slot's task, created. */
function ensuredAnswer(req: ServiceRequest): Promise<ServiceResponse> {
  const queue = decodeURIComponent(req.path.split('/')[4] ?? '');
  const ensured = { queue, name: `${queue}-${String(SLOT)}`, created: true, reason: 'created-current' };
  return Promise.resolve({ status: 200, headers: {}, body: { queue, service: req.service, ensured } });
}

/** Answers createServiceClient with a client whose calls `answer` handles with the client's options. */
function fakeServiceClient(
  answer: (req: ServiceRequest, options: ServiceClientOptions) => Promise<ServiceResponse> = ensuredAnswer,
) {
  const request = vi.fn<(req: ServiceRequest) => Promise<ServiceResponse>>();
  const close = vi.fn(() => Promise.resolve());
  state.createServiceClient.mockImplementation((options: ServiceClientOptions) => {
    request.mockImplementation((req) => answer(req, options));
    return { request, close };
  });
  const sent = (): ServiceRequest[] => request.mock.calls.map(([req]) => req);
  return { request, close, sent };
}

function stdoutLines(): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/** The message of a usage error on stderr, between its `opt2-tasks: ` prefix and usage suffix. */
function tasksUsageMessage(text: string): string {
  const prefix = 'opt2-tasks: ';
  const suffix = `; ${TASKS_USAGE}\n`;
  expect(text.startsWith(prefix) && text.endsWith(suffix)).toBe(true);
  return text.slice(prefix.length, -suffix.length);
}

describe('opt2-tasks reconcile', () => {
  let stateDir: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'opt2-clis-tasks-'));
    await writeTestSecrets(stateDir);
  });

  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.createServiceClient.mockReset();
  });

  afterEach(() => {
    setDiagnosticLogger(undefined);
  });

  /** Sets the variables opt2-tasks reads; `urls: null` leaves OPT2_SERVICE_URLS unset. */
  function stubTasksEnv({
    mode = 'local',
    urls = SERVICE_URLS,
  }: { mode?: 'local' | 'cloud'; urls?: Record<string, string> | null } = {}): void {
    vi.stubEnv('OPT2_ENV', mode);
    vi.stubEnv('OPT2_STATE_DIR', stateDir);
    vi.stubEnv('OPT2_SERVICE_URLS', urls === null ? undefined : JSON.stringify(urls));
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', mode === 'cloud' ? 'opt2-unit' : undefined);
  }

  it.each([
    { argv: [], message: /^missing subcommand$/ },
    { argv: ['sync'], message: /^unknown subcommand "sync"$/ },
    { argv: ['reconcile', 'all'], message: /^unknown subcommand "reconcile all"$/ },
    { argv: ['reconcile', '--as', 'admin'], message: /^--as must be one of operator, migration, got "admin"$/ },
    { argv: ['reconcile', '--queue'], message: /^Option '--queue <value>' argument missing/ },
    { argv: ['reconcile', '--dry-run'], message: /^Unknown option '--dry-run'/ },
  ])('exits 2 with the usage line for $argv before reading the environment or creating a client', async ({ argv, message }) => {
    stubTasksEnv({ urls: null });

    expect(await tasksMain(argv)).toBe(2);

    expect(tasksUsageMessage(stderr)).toMatch(message);
    expect(stdout).toBe('');
    expect(state.createServiceClient).not.toHaveBeenCalled();
  });

  it.each([[['--help']], [['-h']], [['reconcile', '--as', 'root', '--help']]])(
    'prints the help on stdout and exits 0 for %j without reading the environment or creating a client',
    async (argv) => {
      stubTasksEnv({ urls: null });
      vi.stubEnv('OPT2_ENV', undefined);

      expect(await tasksMain(argv)).toBe(0);

      expect(stdout.startsWith(`${TASKS_USAGE}\n\n`)).toBe(true);
      for (const flag of ['--queue <name>', '--with-sitemonitor', '--include-local-only', '--as operator|migration', '-h, --help']) {
        expect(stdout).toContain(`\n  ${flag} `);
      }
      const environment = stdout.slice(stdout.indexOf('\nEnvironment:\n'));
      for (const key of ['OPT2_ENV', 'OPT2_SERVICE_URLS', 'OPT2_STATE_DIR', 'GOOGLE_CLOUD_PROJECT']) {
        expect(environment).toContain(`\n  ${key} `);
      }
      expect(environment).toMatch(/\nExit codes: 0 [^\n]+, 1 [^\n]+, 2 [^\n]+\n$/);
      expect(stderr).toBe('');
      expect(state.createServiceClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    { queues: ['surveys-launch'], message: 'Not a recurring task queue: surveys-launch' },
    { queues: ['people-outbox-sweep', 'nope'], message: 'Not a recurring task queue: nope' },
    { queues: [SITEMONITOR], message: `${SITEMONITOR} is reconciled only with withSiteMonitor` },
  ])('exits 2 with the usage line and closes the client without a call when --queue names $queues', async ({ queues, message }) => {
    stubTasksEnv();
    const { request, close } = fakeServiceClient();

    expect(await tasksMain(['reconcile', ...queues.flatMap((queue) => ['--queue', queue])])).toBe(2);

    expect(stderr).toBe(`opt2-tasks: ${message}; ${TASKS_USAGE}\n`);
    expect(stdout).toBe('');
    expect(request).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each<{ mode: 'local' | 'cloud'; flags: string[]; chains: Chain[] }>([
    { mode: 'local', flags: [], chains: [...DEPLOYED_SWEEPS, STUB_SWEEP] },
    { mode: 'local', flags: ['--with-sitemonitor'], chains: [MONITOR, ...DEPLOYED_SWEEPS, STUB_SWEEP] },
    { mode: 'cloud', flags: [], chains: DEPLOYED_SWEEPS },
    { mode: 'cloud', flags: ['--include-local-only'], chains: [...DEPLOYED_SWEEPS, STUB_SWEEP] },
    { mode: 'cloud', flags: ['--with-sitemonitor'], chains: [MONITOR, ...DEPLOYED_SWEEPS] },
  ])('ensures each chain in registry order, one line each, in $mode mode with $flags', async ({ mode, flags, chains }) => {
    stubTasksEnv({ mode });
    const { close, sent } = fakeServiceClient();

    expect(await tasksMain(['reconcile', ...flags])).toBe(0);

    expect(sent()).toEqual(chains.map(ensureRequest));
    expect(stdoutLines()).toEqual(chains.map(ensuredLine));
    expect(stderr).toBe('');
    expect(state.createServiceClient).toHaveBeenCalledExactlyOnceWith({
      serviceUrls: SERVICE_URLS,
      self: 'operator',
      credentials: expect.objectContaining({ headersFor: expect.any(Function) }),
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('ensures only the repeated --queue chains, once each in registry order', async () => {
    stubTasksEnv();
    const { sent } = fakeServiceClient();
    const named = ['people-outbox-sweep', 'identity-outbox-sweep', SITEMONITOR, 'people-outbox-sweep'];

    expect(await tasksMain(['reconcile', '--with-sitemonitor', ...named.flatMap((queue) => ['--queue', queue])])).toBe(0);

    const chains = [MONITOR, sweep('identity'), sweep('people')];
    expect(sent()).toEqual(chains.map(ensureRequest));
    expect(stdoutLines()).toEqual(chains.map(ensuredLine));
  });

  it('exits 1 with a not-deployed line for a named queue whose creator OPT2_SERVICE_URLS lacks', async () => {
    stubTasksEnv({ urls: Object.fromEntries(Object.entries(SERVICE_URLS).filter(([service]) => service !== 'surveys')) });
    const { sent } = fakeServiceClient();

    expect(await tasksMain(['reconcile', '--queue', 'surveys-outbox-sweep', '--queue', 'identity-outbox-sweep'])).toBe(1);

    expect(sent()).toEqual([ensureRequest(sweep('identity'))]);
    expect(stdoutLines()).toEqual([
      ensuredLine(sweep('identity')),
      { queue: 'surveys-outbox-sweep', service: 'surveys', ok: false, error: 'not deployed' },
    ]);
    expect(stderr).toBe('');
  });

  it('reports a failed ensure on its own line, still asks the later creators and exits 1', async () => {
    stubTasksEnv();
    const failure = 'Service people unavailable (ECONNREFUSED)';
    const { sent } = fakeServiceClient((req) =>
      req.service === 'people' ? Promise.reject(new Error(failure)) : ensuredAnswer(req),
    );

    expect(await tasksMain(['reconcile'])).toBe(1);

    const chains = [...DEPLOYED_SWEEPS, STUB_SWEEP];
    expect(sent()).toEqual(chains.map(ensureRequest));
    expect(stdoutLines()).toEqual(
      chains.map((chain) =>
        chain[1] === 'people' ? { queue: chain[0], service: 'people', ok: false, error: failure } : ensuredLine(chain),
      ),
    );
    expect(stderr).toBe('');
  });

  it.each([
    { flags: [], caller: 'operator', role: Roles.platformOperator },
    { flags: ['--as', 'operator'], caller: 'operator', role: Roles.platformOperator },
    { flags: ['--as', 'migration'], caller: 'migration', role: Roles.platformMigration },
  ])('calls as $caller with a local service token granting $role for $flags', async ({ flags, caller, role }) => {
    stubTasksEnv();
    const minted: Array<Record<string, string>> = [];
    fakeServiceClient(async (req, options) => {
      minted.push(await options.credentials.headersFor({ name: req.service }));
      return ensuredAnswer(req);
    });

    expect(await tasksMain(['reconcile', '--queue', 'identity-outbox-sweep', ...flags])).toBe(0);

    expect(state.createServiceClient).toHaveBeenCalledWith(expect.objectContaining({ self: caller }));
    expect(minted).toHaveLength(1);
    const token = /^Bearer (\S+)$/.exec(minted[0]?.[INVOCATION_HEADER] ?? '')?.[1] ?? '';
    const { publicKey } = await testSigningKeys();
    const identity = await verifyLocalServiceToken(token, { publicKey, audience: 'identity' });
    expect(identity).toEqual({ name: caller, roles: rolesForService(caller) });
    expect(identity.roles).toContain(role);
  });
});

