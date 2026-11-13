import { setTimeout as sleep } from 'node:timers/promises';
import type { DestinationStream } from 'pino';
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope, EventPublisher, TopicValidator } from '../../src/events/index.js';
import { REDACTED, createLogger } from '../../src/logging/index.js';
import { rowFromDb } from '../../src/outbox/ddl.js';
import {
  FLUSH_DEADLINE_MS,
  OutboxNotConfiguredError,
  createOutbox,
  dropBlockedRows,
  flushAfterCommit,
  outboxRuntimeFor,
  publishLockedRows,
  publishPass,
  resetOutboxRuntimes,
  selectPublishable,
} from '../../src/outbox/flush.js';
import { sweepOutbox, type RecoveryContext, type RecoveryHook } from '../../src/outbox/sweep.js';
import { fixedClock, systemClock } from '../../src/service-kit/index.js';
import { tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import type { TenantDb, TenantTx } from '../../src/tenancy/transaction.js';

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const STAMP = '2026-06-30 14:05:09.123';
const TOPIC = 'stub.note.created.v1';
const SELECT_ALL = 'SELECT * FROM "stub".outbox WHERE published_at IS NULL AND NOT held ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED';
const SELECT_AFTER =
  'SELECT * FROM "stub".outbox WHERE published_at IS NULL AND NOT held AND seq > $1::bigint ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED';
const SELECT_IDS =
  'SELECT o.* FROM "stub".outbox o JOIN (SELECT ordering_key, max(seq) AS upto FROM "stub".outbox' +
  ' WHERE event_id = ANY($1::uuid[]) AND published_at IS NULL AND NOT held GROUP BY ordering_key) named' +
  ' ON o.ordering_key = named.ordering_key AND o.seq <= named.upto' +
  ' WHERE o.published_at IS NULL AND NOT o.held ORDER BY o.seq FOR UPDATE OF o';
const BLOCKERS_SQL =
  'SELECT ordering_key, min(seq)::text AS seq FROM "stub".outbox' +
  ' WHERE ((published_at IS NULL AND NOT held) OR held) AND ordering_key = ANY($1::text[])' +
  ' AND seq < $2::bigint AND seq <> ALL($3::bigint[]) GROUP BY ordering_key';
const STAMP_SQL = 'UPDATE "stub".outbox SET published_at = $1 WHERE event_id = ANY($2::uuid[]) AND published_at IS NULL';
const LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true)";
/** The logged error of a publish a timeout signal ended. */
const TIMED_OUT = { type: 'TimeoutError', message: 'The operation was aborted due to timeout' };

type LogLine = Record<string, unknown>;

interface Statement {
  tenantId: string;
  sql: string;
  values: unknown[] | undefined;
}

/** A 36-character RFC 4122 event id ending in `n`. */
function eventId(n: number): string {
  return `0f7c6a52-0c8e-4d8e-9a43-${n.toString(16).padStart(12, '0')}`;
}

/** A snake_case outbox row as pg returns it. */
function dbRow(seq: string, orderingKey: string): QueryResultRow {
  const id = eventId(Number(BigInt(seq) % 1_000_000n));
  return {
    seq,
    tenant_id: TENANT_A,
    event_id: id,
    topic: TOPIC,
    kind: 'state',
    ordering_key: orderingKey,
    envelope: { eventId: id, tenantId: TENANT_A, aggregateId: orderingKey, payload: { seq } },
    operation_id: null,
    held: false,
    created_at: '2026-06-30 14:00:00.000',
    published_at: null,
  };
}

/**
 * A TenantDb whose locking SELECTs answer `rows` and whose blocker SELECT answers `blockers`, recording every statement;
 * `fail` rejects at connect, SELECT or UPDATE, and the lock_timeout setting always succeeds.
 */
function fakeDb(
  rows: readonly QueryResultRow[] = [],
  fail: { connect?: Error; select?: Error; update?: Error } = {},
  blockers: readonly QueryResultRow[] = [],
) {
  const statements: Statement[] = [];
  const tenants: string[] = [];
  const tx = (tenantId: string): TenantTx => ({
    schema: 'stub',
    kind: 'tenant',
    tenantId,
    onCommit: vi.fn(),
    query<R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>> {
      const sql = typeof text === 'string' ? text : text.text;
      statements.push({ tenantId, sql, values });
      if (sql === LOCK_TIMEOUT_SQL) {
        return Promise.resolve({ command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [{ set_config: values?.[0] }] as unknown as R[] });
      }
      const failure = sql.startsWith('SELECT') ? fail.select : fail.update;
      if (failure !== undefined) return Promise.reject(failure);
      const result = sql === BLOCKERS_SQL ? [...blockers] : sql.startsWith('SELECT') ? [...rows] : [];
      return Promise.resolve({ command: 'SELECT', rowCount: result.length, oid: 0, fields: [], rows: result as R[] });
    },
  });
  const db: TenantDb = {
    schema: 'stub',
    withTenant: (tenantId, fn) => {
      tenants.push(tenantId);
      return fail.connect === undefined ? fn(tx(tenantId)) : Promise.reject(fail.connect);
    },
    withMetadata: () => Promise.reject(new Error('the outbox flush never opens a metadata transaction')),
    end: () => Promise.resolve(),
  };
  return { db, statements, tenants, tx: tx(TENANT_A) };
}

/** A TenantDb whose sweep page SELECTs answer each tenant's `stored` rows after `$1` up to the limit, recording every statement and transaction. */
function pagedDb(stored: Readonly<Record<string, readonly QueryResultRow[]>>) {
  const statements: Statement[] = [];
  const tenants: string[] = [];
  const db: TenantDb = {
    schema: 'stub',
    withTenant: (tenantId, fn) => {
      tenants.push(tenantId);
      return fn({
        schema: 'stub',
        kind: 'tenant',
        tenantId,
        onCommit: vi.fn(),
        query<R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>> {
          const sql = typeof text === 'string' ? text : text.text;
          statements.push({ tenantId, sql, values });
          const [after, limit] = sql === SELECT_AFTER ? (values as [string, number]) : ['0', Number(values?.[0])];
          const page =
            sql === SELECT_ALL || sql === SELECT_AFTER
              ? (stored[tenantId] ?? []).filter((row) => BigInt(String(row.seq)) > BigInt(after)).slice(0, limit)
              : [];
          return Promise.resolve({ command: 'SELECT', rowCount: page.length, oid: 0, fields: [], rows: page as R[] });
        },
      });
    },
    withMetadata: () => Promise.reject(new Error('these sweeps list their tenants through tenantsOf')),
    end: () => Promise.resolve(),
  };
  return { db, statements, tenants };
}

/** A publisher whose publish rejects for the `failing` event ids, never settles for the `pending` ones and resolves a message id otherwise. */
function fakePublisher(failing: readonly string[] = [], pending: readonly string[] = []) {
  const publish = vi.fn((_topic: string, envelope: { eventId: string }) =>
    failing.includes(envelope.eventId)
      ? Promise.reject(new Error(`publish rejected ${envelope.eventId}`))
      : pending.includes(envelope.eventId)
        ? new Promise<string>(() => undefined)
        : Promise.resolve(`msg-${envelope.eventId}`),
  );
  const publisher = { publish, publishRaw: vi.fn(), close: vi.fn() } as unknown as EventPublisher;
  return { publisher, publish };
}

function runtimeWith(db: TenantDb, failing: readonly string[] = [], pending: readonly string[] = []) {
  const lines: LogLine[] = [];
  const destination: DestinationStream = { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) };
  const logger = createLogger({ service: 'stub', version: '1.0.0', env: 'local', destination });
  const { publisher, publish } = fakePublisher(failing, pending);
  const runtime = createOutbox({ service: 'stub', db, publisher, logger, clock: fixedClock(NOW) });
  return { runtime, publish, lines };
}

afterEach(() => {
  resetOutboxRuntimes();
});

describe('outbox runtime registry', () => {
  it('registers the runtime under its schema with the system clock by default', () => {
    const { db } = fakeDb();
    const { publisher } = fakePublisher();
    const logger = createLogger({ service: 'stub', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    const runtime = createOutbox({ service: 'stub', db, publisher, logger });
    expect(runtime).toStrictEqual({ service: 'stub', db, publisher, logger, clock: systemClock, payloadValidators: undefined });
    expect(outboxRuntimeFor('stub')).toBe(runtime);
  });

  it('lets the last registration for a schema win', () => {
    const { db } = fakeDb();
    const first = runtimeWith(db).runtime;
    const second = runtimeWith(db).runtime;
    expect(first).not.toBe(second);
    expect(outboxRuntimeFor('stub')).toBe(second);
  });

  it('throws OutboxNotConfiguredError naming the schema once the registry is reset', () => {
    runtimeWith(fakeDb().db);
    resetOutboxRuntimes();
    let caught: unknown;
    try {
      outboxRuntimeFor('stub');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboxNotConfiguredError);
    expect(caught).toMatchObject({
      name: 'OutboxNotConfiguredError',
      schema: 'stub',
      message: 'No outbox runtime is registered for schema "stub"; call createOutbox at start-up',
    });
  });

  const validator: TopicValidator = { meta: { kind: 'state' }, validatePayload: (payload) => ({ ok: true, value: payload }) };

  it.each([
    { case: 'a record', given: { [TOPIC]: validator } },
    { case: 'a map', given: new Map([[TOPIC, validator]]) },
  ])('keys payload validators given as $case by topic', ({ given }) => {
    const { publisher } = fakePublisher();
    const logger = createLogger({ service: 'stub', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    const runtime = createOutbox({ service: 'stub', db: fakeDb().db, publisher, logger, payloadValidators: given });
    expect(runtime.payloadValidators).toBeInstanceOf(Map);
    expect([...(runtime.payloadValidators?.entries() ?? [])]).toEqual([[TOPIC, validator]]);
  });
});

describe('selectPublishable', () => {
  const rows = [dbRow('1', 'note:a'), dbRow('2', 'note:b')];

  it.each([
    { case: 'a page of unpublished rows, skipping locked ones', opts: { limit: 500 }, sql: SELECT_ALL, values: [500] },
    {
      case: 'a page after a seq beyond 2^53, skipping locked ones',
      opts: { limit: 2, after: '9007199254740993' },
      sql: SELECT_AFTER,
      values: ['9007199254740993', 2],
    },
    {
      case: "the named rows' ordering keys up to each key's latest named row, waiting for locked ones",
      opts: { eventIds: [eventId(1), eventId(2)] },
      sql: SELECT_IDS,
      values: [[eventId(1), eventId(2)]],
    },
  ])('locks $case in seq order and maps them', async ({ opts, sql, values }) => {
    const { tx, statements } = fakeDb(rows);
    await expect(selectPublishable(tx, 'stub', opts)).resolves.toStrictEqual(rows.map(rowFromDb));
    expect(statements).toEqual([{ tenantId: TENANT_A, sql, values }]);
  });

  it('rejects an invalid schema before querying', async () => {
    const { tx, statements } = fakeDb(rows);
    await expect(selectPublishable(tx, 'Stub', { limit: 1 })).rejects.toThrow(new TypeError('Invalid schema identifier: "Stub"'));
    expect(statements).toEqual([]);
  });
});

describe('dropBlockedRows', () => {
  it("drops the rows after their key's first unlocked unpublished or held row, comparing seqs beyond 2^53 exactly", async () => {
    const locked = [dbRow('3', 'L'), dbRow('9007199254740992', 'K'), dbRow('9007199254740994', 'K')].map(rowFromDb);
    const { tx, statements } = fakeDb([], {}, [{ ordering_key: 'K', seq: '9007199254740993' }]);

    await expect(dropBlockedRows(tx, 'stub', locked)).resolves.toStrictEqual({ rows: locked.slice(0, 2), blocked: 1 });

    expect(statements).toEqual([
      {
        tenantId: TENANT_A,
        sql: BLOCKERS_SQL,
        values: [['L', 'K'], '9007199254740994', ['3', '9007199254740992', '9007199254740994']],
      },
    ]);
  });

  it('keeps every row when no key has an earlier unlocked unpublished or held row', async () => {
    const locked = [dbRow('1', 'K'), dbRow('2', 'K')].map(rowFromDb);
    const { tx } = fakeDb();
    await expect(dropBlockedRows(tx, 'stub', locked)).resolves.toStrictEqual({ rows: locked, blocked: 0 });
  });

  it('issues no query for no rows', async () => {
    const { tx, statements } = fakeDb();
    await expect(dropBlockedRows(tx, 'stub', [])).resolves.toStrictEqual({ rows: [], blocked: 0 });
    expect(statements).toEqual([]);
  });
});

describe('publishLockedRows', () => {
  it('skips later rows of a failed ordering key, publishes other keys and stamps only the published rows', async () => {
    const { db, tx, statements } = fakeDb();
    const rows = [dbRow('1', 'K'), dbRow('2', 'K'), dbRow('3', 'L')].map(rowFromDb);
    const { runtime, publish, lines } = runtimeWith(db, [eventId(1)]);

    await expect(publishLockedRows(tx, runtime, rows)).resolves.toStrictEqual({ published: 1, failed: 1, skipped: 1 });

    expect(publish.mock.calls).toEqual([
      [TOPIC, rows[0]?.envelope],
      [TOPIC, rows[2]?.envelope],
    ]);
    expect(statements).toEqual([{ tenantId: TENANT_A, sql: STAMP_SQL, values: [STAMP, [eventId(3)]] }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: 'ERROR',
      message: 'outbox publish failed',
      eventId: eventId(1),
      tenantId: TENANT_A,
      // An error without a diagnostic code logs only its type; its free-text message is redacted.
      error: { type: 'Error', message: REDACTED },
    });
  });

  it('publishes the stored envelopes unchanged in seq order, whatever order the rows are given in', async () => {
    const { db, tx } = fakeDb();
    const rows = [dbRow('9007199254740993', 'K'), dbRow('10', 'K'), dbRow('9007199254740992', 'L')].map(rowFromDb);
    const { runtime, publish } = runtimeWith(db);

    await expect(publishLockedRows(tx, runtime, rows)).resolves.toStrictEqual({ published: 3, failed: 0, skipped: 0 });

    expect(publish.mock.calls.map(([, envelope]) => envelope)).toEqual([rows[1], rows[2], rows[0]].map((row) => row?.envelope));
    expect(publish.mock.calls[0]?.[1]).toBe(rows[1]?.envelope);
  });

  it.each([
    { case: 'nothing was published', failing: [eventId(1)], opts: {}, summary: { published: 0, failed: 1, skipped: 0 } },
    { case: 'stamping is off', failing: [], opts: { stamp: 'none' as const }, summary: { published: 1, failed: 0, skipped: 0 } },
  ])('issues no UPDATE when $case', async ({ failing, opts, summary }) => {
    const { db, tx, statements } = fakeDb();
    const { runtime } = runtimeWith(db, failing);
    await expect(publishLockedRows(tx, runtime, [rowFromDb(dbRow('1', 'K'))], opts)).resolves.toStrictEqual(summary);
    expect(statements).toEqual([]);
  });

  it('fails the publish pending at the abort, skips every row after it and stamps only the rows published before it', async () => {
    const { db, tx, statements } = fakeDb();
    const rows = [dbRow('1', 'L'), dbRow('2', 'K'), dbRow('3', 'K'), dbRow('4', 'M')].map(rowFromDb);
    const { runtime, publish, lines } = runtimeWith(db, [], [eventId(2)]);
    const controller = new AbortController();

    const pass = publishLockedRows(tx, runtime, rows, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledTimes(2);
    });
    controller.abort();

    await expect(pass).resolves.toStrictEqual({ published: 1, failed: 1, skipped: 2 });
    expect(publish.mock.calls).toEqual([
      [TOPIC, rows[0]?.envelope],
      [TOPIC, rows[1]?.envelope],
    ]);
    expect(statements).toEqual([{ tenantId: TENANT_A, sql: STAMP_SQL, values: [STAMP, [eventId(1)]] }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: 'ERROR',
      message: 'outbox publish failed',
      eventId: eventId(2),
      tenantId: TENANT_A,
      error: { type: 'AbortError', message: 'This operation was aborted' },
    });
  });

  class GoogleError extends Error {}
  const RESOURCE = 'projects/opt2-unit/topics/stub.note.created.v1';

  it.each([
    {
      client: 'google-gax',
      error: Object.assign(new GoogleError(`Total timeout of API google.pubsub.v1.Publisher exceeded 60000 milliseconds for ${RESOURCE}`), { code: 4 }),
      logged: { type: 'GoogleError', message: 'gRPC status 4 DEADLINE_EXCEEDED' },
    },
    {
      client: 'grpc-js',
      error: Object.assign(new Error(`5 NOT_FOUND: Resource not found (resource=${RESOURCE}).`), {
        code: 5,
        details: `Resource not found (resource=${RESOURCE}).`,
        metadata: {},
      }),
      logged: { type: 'Error', message: 'gRPC status 5 NOT_FOUND' },
    },
  ])('logs the gRPC status of a publish the $client client rejected, never its message or details', async ({ error, logged }) => {
    const { db, tx } = fakeDb();
    const { runtime, publish, lines } = runtimeWith(db);
    publish.mockRejectedValueOnce(error);

    await expect(publishLockedRows(tx, runtime, [rowFromDb(dbRow('1', 'K'))])).resolves.toStrictEqual({ published: 0, failed: 1, skipped: 0 });

    expect(lines).toMatchObject([{ severity: 'ERROR', message: 'outbox publish failed', eventId: eventId(1), error: logged }]);
    expect((lines[0]?.error as { stack?: string } | undefined)?.stack?.split('\n')[0]).toBe(`${logged.type}: ${logged.message}`);
    expect(JSON.stringify(lines)).not.toContain(RESOURCE);
  });

  it('does nothing for no rows', async () => {
    const { db, tx, statements } = fakeDb();
    const { runtime, publish } = runtimeWith(db);
    await expect(publishLockedRows(tx, runtime, [])).resolves.toStrictEqual({ published: 0, failed: 0, skipped: 0 });
    expect(publish).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });
});

describe('flushAfterCommit', () => {
  const ids = [eventId(1), eventId(2)];

  it('locks, checks for blockers, publishes and stamps the named rows in one tenant transaction', async () => {
    const { db, statements, tenants } = fakeDb([dbRow('1', 'K'), dbRow('2', 'L')]);
    const { runtime, publish, lines } = runtimeWith(db);

    await expect(flushAfterCommit(runtime, TENANT_A, ids)).resolves.toStrictEqual({ published: 2, failed: 0, skipped: 0 });

    expect(tenants).toEqual([TENANT_A]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(statements).toEqual([
      { tenantId: TENANT_A, sql: LOCK_TIMEOUT_SQL, values: ['2000ms'] },
      { tenantId: TENANT_A, sql: SELECT_IDS, values: [ids] },
      { tenantId: TENANT_A, sql: BLOCKERS_SQL, values: [['K', 'L'], '2', ['1', '2']] },
      { tenantId: TENANT_A, sql: STAMP_SQL, values: [STAMP, ids] },
    ]);
    expect(lines).toEqual([]);
  });

  it('leaves a row behind an earlier held or unpublished row of its key unpublished and counts it as skipped', async () => {
    const { db, statements } = fakeDb([dbRow('1', 'K'), dbRow('2', 'L')], {}, [{ ordering_key: 'K', seq: '0' }]);
    const { runtime, publish } = runtimeWith(db);

    await expect(flushAfterCommit(runtime, TENANT_A, ids)).resolves.toStrictEqual({ published: 1, failed: 0, skipped: 1 });

    expect(publish.mock.calls.map(([, envelope]) => envelope)).toEqual([rowFromDb(dbRow('2', 'L')).envelope]);
    expect(statements.at(-1)).toEqual({ tenantId: TENANT_A, sql: STAMP_SQL, values: [STAMP, [eventId(2)]] });
  });

  it('resolves with the failures counted when the publisher rejects', async () => {
    const { db, statements } = fakeDb([dbRow('1', 'K'), dbRow('2', 'K')]);
    const { runtime } = runtimeWith(db, [eventId(1)]);
    await expect(flushAfterCommit(runtime, TENANT_A, ids)).resolves.toStrictEqual({ published: 0, failed: 1, skipped: 1 });
    expect(statements.map((s) => s.sql)).toEqual([LOCK_TIMEOUT_SQL, SELECT_IDS, BLOCKERS_SQL]);
  });

  it('resolves once FLUSH_DEADLINE_MS passes while a publish never settles, leaving every row unstamped', async () => {
    const { db, statements } = fakeDb([dbRow('1', 'K'), dbRow('2', 'L')]);
    const { runtime, publish, lines } = runtimeWith(db, [], ids);
    const started = performance.now();

    await expect(flushAfterCommit(runtime, TENANT_A, ids)).resolves.toStrictEqual({ published: 0, failed: 1, skipped: 1 });

    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(FLUSH_DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(FLUSH_DEADLINE_MS + 500);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(statements.map((s) => s.sql)).toEqual([LOCK_TIMEOUT_SQL, SELECT_IDS, BLOCKERS_SQL]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      message: 'outbox publish failed',
      eventId: eventId(1),
      error: TIMED_OUT,
    });
  });

  it('opens no transaction for an empty id list', async () => {
    const { db, tenants } = fakeDb();
    const { runtime } = runtimeWith(db);
    await expect(flushAfterCommit(runtime, TENANT_A, [])).resolves.toStrictEqual({ published: 0, failed: 0, skipped: 0 });
    expect(tenants).toEqual([]);
  });

  const pgError = (message: string, code: string): Error => Object.assign(new Error(message), { code, severity: 'ERROR' });

  it.each([
    {
      case: 'the connection is lost',
      fail: { connect: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED', syscall: 'connect' }) },
      logged: 'connect ECONNREFUSED',
    },
    {
      case: 'the SELECT fails',
      fail: { select: pgError('canceling statement due to statement timeout', '57014') },
      logged: 'PostgreSQL error 57014',
    },
    {
      case: 'a row lock is not granted within lock_timeout',
      fail: { select: pgError('canceling statement due to lock timeout', '55P03') },
      logged: 'PostgreSQL error 55P03',
    },
    {
      case: 'the stamp fails',
      fail: { update: pgError('could not serialize access due to concurrent update', '40001') },
      logged: 'PostgreSQL error 40001',
    },
  ])('never throws when $case: it logs once and leaves every row to the sweep', async ({ fail, logged }) => {
    const { db } = fakeDb([dbRow('1', 'K'), dbRow('2', 'L')], fail);
    const { runtime, lines } = runtimeWith(db);

    await expect(flushAfterCommit(runtime, TENANT_A, ids)).resolves.toStrictEqual({ published: 0, failed: 2, skipped: 0 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: 'ERROR',
      message: `outbox flush failed for events ${ids.join(',')}`,
      tenantId: TENANT_A,
      error: { type: 'Error', message: logged },
    });
  });
});

describe('publishPass', () => {
  const envelope = rowFromDb(dbRow('1', 'K')).envelope as unknown as EventEnvelope;

  it.each([
    { outcome: 'resolves', failing: [] },
    { outcome: 'rejects', failing: [eventId(1)] },
  ])('leaves its pass open after a publish that $outcome within the stall time, once that time has passed', async ({ failing }) => {
    const { runtime, publish } = runtimeWith(fakeDb().db, failing);
    const pass = publishPass(runtime, 20);

    await pass.runtime.publisher.publish(TOPIC, envelope).catch(() => undefined);
    await sleep(60);

    expect(publish).toHaveBeenCalledOnce();
    expect(pass.signal.aborted).toBe(false);
    expect(pass.stalled()).toBe(false);
  });

  it('keeps the rest of the runtime and hands publishRaw and close to its publisher unchanged', async () => {
    const publishRaw = vi.fn(() => Promise.resolve('raw-1'));
    const close = vi.fn(() => Promise.resolve());
    const publisher = { publish: vi.fn(), publishRaw, close } as unknown as EventPublisher;
    const logger = createLogger({ service: 'stub', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    const runtime = createOutbox({ service: 'stub', db: fakeDb().db, publisher, logger, clock: fixedClock(NOW) });
    const message = { data: Buffer.from('{}'), attributes: { eventId: eventId(1) } };
    const pass = publishPass(runtime, 20);

    await expect(pass.runtime.publisher.publishRaw(TOPIC, message)).resolves.toBe('raw-1');
    await pass.runtime.publisher.close();

    expect(pass.runtime.publisher).not.toBe(publisher);
    expect({ ...pass.runtime, publisher }).toStrictEqual(runtime);
    expect(publishRaw).toHaveBeenCalledWith(TOPIC, message);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('sweepOutbox publish bounds', () => {
  const rowsA = [dbRow('1', 'K1'), dbRow('2', 'K2'), dbRow('3', 'K3'), dbRow('4', 'K4')];
  const rowsB = [dbRow('5', 'K5'), dbRow('6', 'K6')].map((row) => ({ ...row, tenant_id: TENANT_B }));
  const stored = { [TENANT_A]: rowsA, [TENANT_B]: rowsB };
  const tenantsOf = () => Promise.resolve([TENANT_A, TENANT_B]);
  const pages = (statements: readonly Statement[]) =>
    statements.filter((s) => s.sql === SELECT_ALL || s.sql === SELECT_AFTER).map((s) => [s.tenantId, ...(s.values ?? [])]);

  it.each([
    {
      ended: 'a publish stalls',
      bounds: { publishStallMs: 50, publishDeadlineMs: 60_000 },
      waitedMs: 50,
      warning: 'outbox sweep ended early after a publish stalled for 50 ms',
    },
    {
      ended: 'its publish deadline passes',
      bounds: { publishStallMs: 60_000, publishDeadlineMs: 80 },
      waitedMs: 80,
      warning: 'outbox sweep ended early at its 80 ms publish deadline',
    },
  ])('ends when $ended: stamps what it published, opens no later page or tenant, warns once and still runs its hooks', async ({ bounds, waitedMs, warning }) => {
    const { db, statements, tenants } = pagedDb(stored);
    const { runtime, publish, lines } = runtimeWith(db, [], [eventId(2)]);
    const contexts: RecoveryContext[] = [];
    const probe: RecoveryHook = {
      name: 'probe',
      run: (ctx) => {
        contexts.push(ctx);
        return Promise.resolve();
      },
    };
    const started = performance.now();

    const result = await sweepOutbox(runtime, { service: 'stub', clock: fixedClock(NOW), tenantsOf, batchSize: 2, recoveryHooks: [probe], ...bounds });

    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(waitedMs - 10);
    expect(elapsed).toBeLessThan(waitedMs + 1_000);
    expect(result).toStrictEqual({ published: 1, failed: 1, skipped: 0, tenants: 0, hooks: [{ name: 'probe', ok: true }] });
    expect(publish.mock.calls.map(([, sent]) => sent)).toEqual(rowsA.slice(0, 2).map((row) => rowFromDb(row).envelope));
    expect(tenants).toEqual([TENANT_A]);
    expect(pages(statements)).toEqual([[TENANT_A, 2]]);
    expect(statements.filter((s) => s.sql === STAMP_SQL)).toEqual([{ tenantId: TENANT_A, sql: STAMP_SQL, values: [STAMP, [eventId(1)]] }]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.runtime).toBe(runtime);
    expect(lines).toMatchObject([
      { severity: 'ERROR', message: 'outbox publish failed', eventId: eventId(2), error: TIMED_OUT },
      { severity: 'WARNING', message: warning, tenantId: TENANT_A, error: TIMED_OUT },
    ]);
  });

  it('ends a slow sweep at its publish deadline though no single publish stalls, failing only the publish it cut short', async () => {
    const slowRows = Array.from({ length: 20 }, (_, n) => dbRow(String(n + 1), `K${String(n + 1)}`));
    const { db, statements } = pagedDb({ [TENANT_A]: slowRows, [TENANT_B]: rowsB });
    const { runtime, publish, lines } = runtimeWith(db);
    publish.mockImplementation((_topic, sent) => sleep(20).then(() => `msg-${sent.eventId}`));
    const started = performance.now();

    const result = await sweepOutbox(runtime, {
      service: 'stub',
      clock: fixedClock(NOW),
      tenantsOf,
      batchSize: 2,
      publishStallMs: 10_000,
      publishDeadlineMs: 200,
    });

    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(1_200);
    expect(result).toMatchObject({ failed: 1, skipped: 0, tenants: 0 });
    expect(result.published).toBeLessThan(slowRows.length - 1);
    expect(publish).toHaveBeenCalledTimes(result.published + 1);
    expect(statements.filter((s) => s.tenantId === TENANT_B)).toEqual([]);
    expect(lines.filter((line) => line.severity === 'WARNING')).toMatchObject([
      { message: 'outbox sweep ended early at its 200 ms publish deadline', tenantId: TENANT_A, error: TIMED_OUT },
    ]);
  });

  it.each([
    { outcome: 'every publish succeeds', failing: [], summary: { published: 6, failed: 0, skipped: 0 }, logged: [] },
    { outcome: 'a publish is rejected', failing: [eventId(3)], summary: { published: 5, failed: 1, skipped: 0 }, logged: ['outbox publish failed'] },
  ])('sweeps every page of every tenant without a warning when $outcome', async ({ failing, summary, logged }) => {
    const { db, statements, tenants } = pagedDb(stored);
    const { runtime, publish, lines } = runtimeWith(db, failing);

    const result = await sweepOutbox(runtime, { service: 'stub', clock: fixedClock(NOW), tenantsOf, batchSize: 2 });

    expect(result).toStrictEqual({ ...summary, tenants: 2, hooks: [] });
    expect(publish).toHaveBeenCalledTimes(6);
    expect(tenants).toEqual([TENANT_A, TENANT_A, TENANT_A, TENANT_B, TENANT_B]);
    expect(pages(statements)).toEqual([
      [TENANT_A, 2],
      [TENANT_A, '2', 2],
      [TENANT_A, '4', 2],
      [TENANT_B, 2],
      [TENANT_B, '6', 2],
    ]);
    expect(lines.map((line) => line.message)).toEqual(logged);
  });
});

