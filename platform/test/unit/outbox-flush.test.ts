import type { DestinationStream } from 'pino';
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventPublisher, TopicValidator } from '../../src/events/index.js';
import { REDACTED, createLogger } from '../../src/logging/index.js';
import { rowFromDb } from '../../src/outbox/ddl.js';
import {
  OutboxNotConfiguredError,
  createOutbox,
  flushAfterCommit,
  outboxRuntimeFor,
  publishLockedRows,
  resetOutboxRuntimes,
  selectPublishable,
} from '../../src/outbox/flush.js';
import { fixedClock, systemClock } from '../../src/service-kit/index.js';
import { tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import type { TenantDb, TenantTx } from '../../src/tenancy/transaction.js';

const TENANT_A = tenantIdForSite('tenant-a');
const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const STAMP = '2026-06-30 14:05:09.123';
const TOPIC = 'stub.note.created.v1';
const SELECT_ALL = 'SELECT * FROM "stub".outbox WHERE published_at IS NULL AND NOT held ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED';
const SELECT_IDS =
  'SELECT * FROM "stub".outbox WHERE published_at IS NULL AND NOT held AND event_id = ANY($1::uuid[])' +
  ' ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED';
const STAMP_SQL = 'UPDATE "stub".outbox SET published_at = $1 WHERE event_id = ANY($2::uuid[]) AND published_at IS NULL';

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

/** A TenantDb whose SELECTs answer `rows`, recording every statement; `fail` rejects at connect, SELECT or UPDATE. */
function fakeDb(rows: readonly QueryResultRow[] = [], fail: { connect?: Error; select?: Error; update?: Error } = {}) {
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
      const failure = sql.startsWith('SELECT') ? fail.select : fail.update;
      if (failure !== undefined) return Promise.reject(failure);
      const result = sql.startsWith('SELECT') ? [...rows] : [];
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

/** A publisher whose publish rejects for the listed event ids and resolves a message id otherwise. */
function fakePublisher(failing: readonly string[] = []) {
  const publish = vi.fn((_topic: string, envelope: { eventId: string }) =>
    failing.includes(envelope.eventId)
      ? Promise.reject(new Error(`publish rejected ${envelope.eventId}`))
      : Promise.resolve(`msg-${envelope.eventId}`),
  );
  const publisher = { publish, publishRaw: vi.fn(), close: vi.fn() } as unknown as EventPublisher;
  return { publisher, publish };
}

function runtimeWith(db: TenantDb, failing: readonly string[] = []) {
  const lines: LogLine[] = [];
  const destination: DestinationStream = { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) };
  const logger = createLogger({ service: 'stub', version: '1.0.0', env: 'local', destination });
  const { publisher, publish } = fakePublisher(failing);
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
    { case: 'every unpublished row', opts: { limit: 500 }, sql: SELECT_ALL, values: [500] },
    {
      case: 'the named rows',
      opts: { eventIds: [eventId(1), eventId(2)], limit: 2 },
      sql: SELECT_IDS,
      values: [[eventId(1), eventId(2)], 2],
    },
  ])('locks $case in seq order, skipping locked rows, and maps them', async ({ opts, sql, values }) => {
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

  it('selects, publishes and stamps the named rows in one tenant transaction', async () => {
    const { db, statements, tenants } = fakeDb([dbRow('1', 'K'), dbRow('2', 'L')]);
    const { runtime, publish, lines } = runtimeWith(db);

    await expect(flushAfterCommit(runtime, TENANT_A, ids)).resolves.toStrictEqual({ published: 2, failed: 0, skipped: 0 });

    expect(tenants).toEqual([TENANT_A]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(statements).toEqual([
      { tenantId: TENANT_A, sql: SELECT_IDS, values: [ids, 2] },
      { tenantId: TENANT_A, sql: STAMP_SQL, values: [STAMP, ids] },
    ]);
    expect(lines).toEqual([]);
  });

  it('resolves with the failures counted when the publisher rejects', async () => {
    const { db, statements } = fakeDb([dbRow('1', 'K'), dbRow('2', 'K')]);
    const { runtime } = runtimeWith(db, [eventId(1)]);
    await expect(flushAfterCommit(runtime, TENANT_A, ids)).resolves.toStrictEqual({ published: 0, failed: 1, skipped: 1 });
    expect(statements.map((s) => s.sql)).toEqual([SELECT_IDS]);
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
