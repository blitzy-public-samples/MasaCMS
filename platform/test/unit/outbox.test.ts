import type { Pool, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnvelope, type TopicValidator } from '../../src/events/index.js';
import { createLogger } from '../../src/logging/index.js';
import { OUTBOX_KINDS, OUTBOX_TABLE, localTimestamp, outboxSql, outboxTable, rowFromDb } from '../../src/outbox/ddl.js';
import {
  OutboxNotConfiguredError,
  OutboxPayloadError,
  OutboxTransactionError,
  createOutbox,
  discardOperation,
  releaseOperation,
  resetOutboxRuntimes,
  writeOutbox,
  type OutboxWriteInput,
} from '../../src/outbox/index.js';
import { outboxDrainCounts, registryTenants } from '../../src/outbox/stats.js';
import { tenantDbFromPool, withTenant, type TenantTx } from '../../src/tenancy/index.js';
import { rlsSql } from '../../src/tenancy/rls.js';
import { tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import type { TenantDb } from '../../src/tenancy/transaction.js';
import { TENANT_A as TENANT_A_FIXTURE, businessClock, createCapturingPublisher } from '../../src/testing/index.js';

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const TENANT_C = tenantIdForSite('tenant-c');
const EVENT_ID = '0f7c6a52-0c8e-4d8e-9a43-6a3c1d2b5e70';
const REGISTRY_SQL = 'SELECT tenant_id, site_id FROM stub.tenant_registry ORDER BY site_id';
const COUNT_SQL =
  'SELECT (SELECT count(*) FROM "stub".outbox WHERE published_at IS NULL AND NOT held) AS unpublished,' +
  ' (SELECT count(*) FROM "stub".outbox WHERE held) AS held';

const INVALID_SCHEMAS: readonly (readonly [string, string])[] = [
  ['upper-case letters', 'Stub'],
  ['a double quote', 'stub"'],
  ['a statement separator', 'stub; DROP TABLE stub.outbox; --'],
  ['a schema-qualified name', 'stub.outbox'],
  ['a hyphen', 'programs-sites'],
  ['an empty string', ''],
  ['a non-string value', 42 as unknown as string],
];

describe('outbox names', () => {
  it('names the outbox table and its event kinds', () => {
    expect(OUTBOX_TABLE).toBe('outbox');
    expect(OUTBOX_KINDS).toEqual(['state', 'process']);
  });
});

describe('outboxTable', () => {
  it('quotes the schema of the outbox identifier', () => {
    expect(outboxTable('stub')).toBe('"stub".outbox');
  });

  it.each(INVALID_SCHEMAS)('throws a TypeError for a schema with %s', (_case, schema) => {
    expect(() => outboxTable(schema)).toThrow(new TypeError(`Invalid schema identifier: ${JSON.stringify(schema)}`));
  });
});

describe('outboxSql', () => {
  const sql = outboxSql('stub');

  it('creates stub.outbox with a tenant column, event id key and kind check', () => {
    expect(sql.split('\n').slice(0, 14)).toEqual([
      'CREATE TABLE stub.outbox (',
      '  seq bigint GENERATED ALWAYS AS IDENTITY,',
      '  tenant_id uuid NOT NULL,',
      '  event_id uuid PRIMARY KEY,',
      '  topic text NOT NULL,',
      "  kind text NOT NULL CHECK (kind IN ('state','process')),",
      '  ordering_key text NOT NULL,',
      '  envelope jsonb NOT NULL,',
      '  operation_id text NULL,',
      '  held boolean NOT NULL DEFAULT false,',
      '  created_at timestamp(3) without time zone NOT NULL,',
      '  published_at timestamp(3) without time zone NULL',
      ');',
      'CREATE INDEX outbox_unpublished_idx ON stub.outbox (tenant_id, seq) WHERE published_at IS NULL AND NOT held;',
    ]);
  });

  it('indexes held rows by operation and rows by creation time', () => {
    expect(sql.split('\n')).toEqual(
      expect.arrayContaining([
        'CREATE INDEX outbox_held_idx ON stub.outbox (tenant_id, operation_id) WHERE held;',
        'CREATE INDEX outbox_created_idx ON stub.outbox (tenant_id, created_at);',
      ]),
    );
  });

  it('ends with the tenant RLS of stub.outbox and a newline', () => {
    expect(sql.endsWith(`;\n${rlsSql('stub', 'outbox')}\n`)).toBe(true);
  });

  it('uses the given schema throughout', () => {
    expect(outboxSql('people')).toBe(sql.replaceAll('stub.', 'people.'));
  });

  it.each(INVALID_SCHEMAS)('throws a TypeError for a schema with %s', (_case, schema) => {
    expect(() => outboxSql(schema)).toThrow(new TypeError(`Invalid schema identifier: ${JSON.stringify(schema)}`));
  });
});

describe('localTimestamp', () => {
  it.each([
    { date: new Date(2026, 5, 30, 14, 5, 9, 123), text: '2026-06-30 14:05:09.123' },
    { date: new Date(2026, 0, 2, 3, 4, 5, 6), text: '2026-01-02 03:04:05.006' },
    { date: new Date(2026, 11, 31, 23, 59, 59, 999), text: '2026-12-31 23:59:59.999' },
  ])('formats $text in the process zone', ({ date, text }) => {
    expect(localTimestamp(date)).toBe(text);
  });
});

describe('rowFromDb', () => {
  const envelope = { eventId: EVENT_ID, tenantId: TENANT_A, payload: { widgetId: 'w-1' } };
  const DB_ROW: QueryResultRow = {
    seq: '42',
    tenant_id: TENANT_A,
    event_id: EVENT_ID,
    topic: 'stub.widget.changed.v1',
    kind: 'state',
    ordering_key: 'widget:w-1',
    envelope,
    operation_id: 'op-1',
    held: true,
    created_at: new Date(2026, 5, 30, 14, 5, 9, 123),
    published_at: new Date(2026, 5, 30, 14, 5, 10, 0),
  };
  const ROW = {
    seq: '42',
    tenantId: TENANT_A,
    eventId: EVENT_ID,
    topic: 'stub.widget.changed.v1',
    kind: 'state',
    orderingKey: 'widget:w-1',
    envelope,
    operationId: 'op-1',
    held: true,
    createdAt: '2026-06-30 14:05:09.123',
    publishedAt: '2026-06-30 14:05:10.000',
  };

  it('maps snake_case columns and formats Date timestamps as local text', () => {
    expect(rowFromDb(DB_ROW)).toStrictEqual(ROW);
  });

  it.each([
    { case: 'a numeric seq as text', db: { seq: 42 }, row: { seq: '42' } },
    { case: 'a bigint seq as text', db: { seq: 9007199254740993n }, row: { seq: '9007199254740993' } },
    { case: 'a null operation id as null', db: { operation_id: null }, row: { operationId: null } },
    { case: 'a missing operation id as null', db: { operation_id: undefined }, row: { operationId: null } },
    { case: 'a null published_at as null', db: { published_at: null }, row: { publishedAt: null } },
    { case: 'a missing published_at as null', db: { published_at: undefined }, row: { publishedAt: null } },
    {
      case: 'timestamps selected as text unchanged',
      db: { created_at: '2026-06-30 14:05:09.123', published_at: '2026-06-30 14:05:10.000' },
      row: { createdAt: '2026-06-30 14:05:09.123', publishedAt: '2026-06-30 14:05:10.000' },
    },
  ])('maps $case', ({ db, row }) => {
    expect(rowFromDb({ ...DB_ROW, ...db })).toStrictEqual({ ...ROW, ...row });
  });
});

interface Statement {
  tenantId: string | null;
  sql: string;
}

type Counts = Readonly<Record<string, { unpublished: string; held: string }>>;

/** A TenantDb whose metadata reads answer `registry` and whose tenant transactions answer that tenant's `counts` row. */
function fakeDb(registry: readonly { tenant_id: string; site_id: string }[], counts: Counts = {}, schema = 'stub') {
  const statements: Statement[] = [];
  const queryable = (tenantId: string | null) => ({
    schema,
    onCommit: vi.fn(),
    query<R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig): Promise<QueryResult<R>> {
      const sql = typeof text === 'string' ? text : text.text;
      statements.push({ tenantId, sql });
      const count = tenantId === null ? undefined : counts[tenantId];
      const rows: QueryResultRow[] = tenantId === null ? [...registry] : count === undefined ? [] : [count];
      return Promise.resolve({ command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows: rows as R[] });
    },
  });
  const db: TenantDb = {
    schema,
    withTenant: (tenantId, fn) => fn({ ...queryable(tenantId), kind: 'tenant', tenantId }),
    withMetadata: (fn) => fn({ ...queryable(null), kind: 'metadata' }),
    end: () => Promise.resolve(),
  };
  return { db, statements };
}

describe('registryTenants', () => {
  it('lists every registry tenant once, in registry order, from one metadata read', async () => {
    const { db, statements } = fakeDb([
      { tenant_id: TENANT_B, site_id: 'tenant-b' },
      { tenant_id: TENANT_A, site_id: 'tenant-c' },
      { tenant_id: TENANT_B, site_id: 'tenant-d' },
    ]);
    await expect(registryTenants(db)).resolves.toEqual([TENANT_B, TENANT_A]);
    expect(statements).toEqual([{ tenantId: null, sql: REGISTRY_SQL }]);
  });

  it('lists nothing for an empty registry', async () => {
    await expect(registryTenants(fakeDb([]).db)).resolves.toEqual([]);
  });
});

describe('outboxDrainCounts', () => {
  const [LOW, MID, HIGH] = [TENANT_A, TENANT_B, TENANT_C].sort() as [string, string, string];

  it('counts every registry tenant in its own tenant transaction, ordered by tenant id, with totals', async () => {
    const { db, statements } = fakeDb(
      [
        { tenant_id: MID, site_id: 'a-site' },
        { tenant_id: HIGH, site_id: 'b-site' },
        { tenant_id: LOW, site_id: 'c-site' },
      ],
      {
        [LOW]: { unpublished: '3', held: '1' },
        [MID]: { unpublished: '0', held: '2' },
        [HIGH]: { unpublished: '4', held: '0' },
      },
    );
    await expect(outboxDrainCounts(db)).resolves.toStrictEqual({
      tenants: [
        { tenantId: LOW, unpublished: 3, held: 1 },
        { tenantId: MID, unpublished: 0, held: 2 },
        { tenantId: HIGH, unpublished: 4, held: 0 },
      ],
      unpublished: 7,
      held: 3,
    });
    expect(statements).toEqual([
      { tenantId: null, sql: REGISTRY_SQL },
      { tenantId: MID, sql: COUNT_SQL },
      { tenantId: HIGH, sql: COUNT_SQL },
      { tenantId: LOW, sql: COUNT_SQL },
    ]);
  });

  it('counts the tenants tenantsOf lists instead of the registry, each case-folded tenant once', async () => {
    const { db, statements } = fakeDb([{ tenant_id: TENANT_A, site_id: 'tenant-a' }], {
      [TENANT_B]: { unpublished: '5', held: '0' },
    });
    const tenantsOf = vi.fn(() => Promise.resolve([TENANT_B.toUpperCase(), TENANT_B]));
    await expect(outboxDrainCounts(db, { tenantsOf })).resolves.toStrictEqual({
      tenants: [{ tenantId: TENANT_B, unpublished: 5, held: 0 }],
      unpublished: 5,
      held: 0,
    });
    expect(tenantsOf).toHaveBeenCalledWith(db);
    expect(statements).toEqual([{ tenantId: TENANT_B, sql: COUNT_SQL }]);
  });

  it('reports zero totals when no tenant is listed', async () => {
    const { db, statements } = fakeDb([]);
    await expect(outboxDrainCounts(db)).resolves.toStrictEqual({ tenants: [], unpublished: 0, held: 0 });
    expect(statements).toEqual([{ tenantId: null, sql: REGISTRY_SQL }]);
  });

  it('rejects an invalid service schema before reading any tenant', async () => {
    const { db, statements } = fakeDb([{ tenant_id: TENANT_A, site_id: 'tenant-a' }], {}, 'Stub');
    await expect(outboxDrainCounts(db)).rejects.toThrow(new TypeError('Invalid schema identifier: "Stub"'));
    expect(statements).toEqual([]);
  });
});

const TOPIC = 'stub.note.created.v1';
const WRITTEN_AT = '2026-06-30 12:00:00.000';
const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, true)";
const INSERT_SQL =
  'INSERT INTO "stub".outbox (tenant_id, event_id, topic, kind, ordering_key, envelope, operation_id, held, created_at)' +
  ' VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)';
const RELEASE_SQL = 'UPDATE "stub".outbox SET held = false WHERE operation_id = $1 AND held RETURNING event_id';
const DISCARD_SQL = 'DELETE FROM "stub".outbox WHERE operation_id = $1 AND held';
const STAMP_SQL = 'UPDATE "stub".outbox SET published_at = $1 WHERE event_id = ANY($2::uuid[]) AND published_at IS NULL';
// Flush SQL and publishLockedRows ordering are specified in outbox-flush.test.ts; here flush statements match by prefix.
const FLUSH_SELECT = /^SELECT o\.\* FROM "stub"\.outbox o JOIN /;
const FLUSH_BLOCKERS = /^SELECT ordering_key, min\(seq\)::text AS seq FROM "stub"\.outbox /;
const FLUSH_LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true)";

const NOTE: OutboxWriteInput<{ noteId: string; body: string }> = {
  topic: TOPIC,
  kind: 'state',
  aggregateType: 'note',
  aggregateId: 'N1',
  aggregateVersion: 1,
  payload: { noteId: 'N1', body: 'First note' },
};

interface PoolStatement {
  connection: number;
  tenantId: string | undefined;
  sql: string;
  values: unknown[] | undefined;
}

/** Rows answering one statement; the result's `rowCount` is their number. */
type Responder = (sql: string, values: readonly unknown[]) => QueryResultRow[];

/** A pg Pool double: each connect yields a client recording its statements under the tenant it set, answered by `respond`. */
function fakePool(respond: Responder) {
  const statements: PoolStatement[] = [];
  let connections = 0;
  const connect = () => {
    connections += 1;
    const connection = connections;
    let tenantId: string | undefined;
    return Promise.resolve({
      query(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
        const sql = typeof text === 'string' ? text : text.text;
        if (sql === SET_TENANT_SQL) tenantId = String(values?.[0]);
        statements.push({ connection, tenantId, sql, values });
        const rows = respond(sql, values ?? []);
        return Promise.resolve({ command: sql.split(' ', 1)[0] ?? '', rowCount: rows.length, oid: 0, fields: [], rows });
      },
      release: vi.fn(),
    });
  };
  const pool = { on: vi.fn(), connect, end: () => Promise.resolve() } as unknown as Pool;
  return { db: tenantDbFromPool(pool, { schema: 'stub' }), statements };
}

/** The SQL each connection issued, in connect order. */
function sqlByConnection(statements: readonly PoolStatement[]): string[][] {
  const byConnection = new Map<number, string[]>();
  for (const { connection, sql } of statements) byConnection.set(connection, [...(byConnection.get(connection) ?? []), sql]);
  return [...byConnection.values()];
}

/** An in-memory `"stub".outbox` kept by the writer's INSERT, release and discard; the flush SELECT gets the named unheld rows. */
function outboxStore() {
  const rows: QueryResultRow[] = [];
  const respond: Responder = (sql, values) => {
    if (sql === INSERT_SQL) {
      const [tenant_id, event_id, topic, kind, ordering_key, envelope, operation_id, held, created_at] = values;
      const stored = { tenant_id, event_id, topic, kind, ordering_key, operation_id, held, created_at, published_at: null };
      rows.push({ seq: String(rows.length + 1), ...stored, envelope: JSON.parse(String(envelope)) });
      return [];
    }
    if (FLUSH_SELECT.test(sql)) {
      const ids = values[0] as string[];
      return rows.filter((row) => ids.includes(row.event_id) && !row.held);
    }
    if (sql !== RELEASE_SQL && sql !== DISCARD_SQL) {
      return [];
    }
    const ofOperation = rows.filter((row) => row.operation_id === values[0] && row.held);
    if (sql === DISCARD_SQL) {
      rows.splice(0, rows.length, ...rows.filter((row) => !ofOperation.includes(row)));
      return ofOperation;
    }
    for (const row of ofOperation) row.held = false;
    return ofOperation.map((row) => ({ event_id: row.event_id }));
  };
  return { rows, respond };
}

/** A pool double with the stub outbox runtime registered on a capturing publisher, the business clock and a recorded logger. */
function stubOutbox(respond: Responder = () => [], payloadValidators?: Record<string, TopicValidator>) {
  const { db, statements } = fakePool(respond);
  const publisher = createCapturingPublisher();
  const lines: unknown[] = [];
  const logger = createLogger({
    service: 'stub',
    version: '1.0.0',
    env: 'local',
    destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk)) },
  });
  const runtime = createOutbox({ service: 'stub', db, publisher, logger, clock: businessClock(), payloadValidators });
  return { db, statements, publisher, lines, runtime };
}

describe('writeOutbox', () => {
  const tenant = TENANT_A_FIXTURE.tenantId;

  beforeEach(() => {
    resetOutboxRuntimes();
  });

  it('writes one row in the transaction tenant and returns a contract-valid stub envelope', async () => {
    const { db, statements } = stubOutbox();
    let txTenant: string | undefined;
    const envelope = await withTenant(db, tenant, (tx) => {
      txTenant = tx.tenantId;
      return writeOutbox(tx, NOTE);
    });

    expect(validateEnvelope(envelope)).toMatchObject({ ok: true });
    expect(envelope).toMatchObject({
      tenantId: txTenant,
      producer: 'stub',
      eventType: 'stub.note.created',
      schemaVersion: '1.0.0',
      occurredAt: businessClock().now().toISOString(),
      aggregateType: 'note',
      aggregateId: 'N1',
      aggregateVersion: 1,
      payload: NOTE.payload,
    });
    expect(txTenant).toBe(tenant);
    expect(statements.filter((s) => s.sql === INSERT_SQL)).toEqual([
      {
        connection: 1,
        tenantId: tenant,
        sql: INSERT_SQL,
        values: [tenant, envelope?.eventId, TOPIC, 'state', 'N1', JSON.stringify(envelope), null, false, WRITTEN_AT],
      },
    ]);
  });

  it.each([
    { origin: 'backfill', kind: 'process', outcome: 'suppresses' },
    { origin: 'migration-feed', kind: 'process', outcome: 'suppresses' },
    { origin: 'backfill', kind: 'state', outcome: 'writes' },
    { origin: 'migration-feed', kind: 'state', outcome: 'writes' },
    { origin: 'legacy-window', kind: 'process', outcome: 'writes' },
  ] as const)('$outcome a $kind event from origin $origin', async ({ origin, kind, outcome }) => {
    const { db, statements } = stubOutbox();
    const envelope = await withTenant(db, tenant, (tx) => writeOutbox(tx, { ...NOTE, kind, origin }));

    if (outcome === 'suppresses') {
      expect(envelope).toBeNull();
      expect(sqlByConnection(statements)).toEqual([['BEGIN', SET_TENANT_SQL, 'COMMIT']]);
    } else {
      expect(envelope).toMatchObject({ tenantId: tenant, aggregateId: 'N1' });
      expect(sqlByConnection(statements)).toEqual([
        ['BEGIN', SET_TENANT_SQL, INSERT_SQL, 'COMMIT'],
        ['BEGIN', SET_TENANT_SQL, FLUSH_LOCK_TIMEOUT_SQL, expect.stringMatching(FLUSH_SELECT), 'COMMIT'],
      ]);
    }
  });

  it('flushes two writes of one transaction in a single tenant transaction after COMMIT', async () => {
    const { db, statements, publisher, lines } = stubOutbox(outboxStore().respond);
    const written = await withTenant(db, tenant, async (tx) => {
      const envelopes = [await writeOutbox(tx, NOTE), await writeOutbox(tx, { ...NOTE, aggregateVersion: 2 })];
      expect(publisher.published).toEqual([]);
      return envelopes;
    });
    const ids = written.map((envelope) => envelope?.eventId);

    expect(publisher.published).toEqual(written.map((envelope) => ({ topic: TOPIC, envelope })));
    expect(sqlByConnection(statements)).toEqual([
      ['BEGIN', SET_TENANT_SQL, INSERT_SQL, INSERT_SQL, 'COMMIT'],
      ['BEGIN', SET_TENANT_SQL, FLUSH_LOCK_TIMEOUT_SQL, expect.stringMatching(FLUSH_SELECT), expect.stringMatching(FLUSH_BLOCKERS), STAMP_SQL, 'COMMIT'],
    ]);
    expect(statements.find((s) => FLUSH_SELECT.test(s.sql))).toMatchObject({ tenantId: tenant, values: [ids] });
    expect(statements.find((s) => s.sql === STAMP_SQL)).toMatchObject({ tenantId: tenant, values: [WRITTEN_AT, ids] });
    expect(lines).toEqual([]);
  });

  it('holds a row written under an open operation and schedules no publish', async () => {
    const { db, statements, publisher } = stubOutbox(outboxStore().respond);
    const envelope = await withTenant(db, tenant, (tx) => writeOutbox(tx, { ...NOTE, operationId: 'op-1' }));

    expect(statements.find((s) => s.sql === INSERT_SQL)?.values).toEqual([
      tenant,
      envelope?.eventId,
      TOPIC,
      'state',
      'N1',
      JSON.stringify(envelope),
      'op-1',
      true,
      WRITTEN_AT,
    ]);
    expect(sqlByConnection(statements)).toEqual([['BEGIN', SET_TENANT_SQL, INSERT_SQL, 'COMMIT']]);
    expect(publisher.published).toEqual([]);
  });

  it('rejects with OutboxNotConfiguredError and rolls back when no runtime is registered for the schema', async () => {
    const { db, statements } = fakePool(() => []);
    await expect(withTenant(db, tenant, (tx) => writeOutbox(tx, NOTE))).rejects.toThrow(new OutboxNotConfiguredError('stub'));
    expect(sqlByConnection(statements)).toEqual([['BEGIN', SET_TENANT_SQL, 'ROLLBACK']]);
  });

  it('uses the runtime it is given instead of the registry', async () => {
    const { db, statements, runtime } = stubOutbox();
    resetOutboxRuntimes();
    await withTenant(db, tenant, (tx) => writeOutbox(tx, NOTE, runtime));
    expect(statements.filter((s) => s.sql === INSERT_SQL)).toHaveLength(1);
  });

  const rejectingNoteId: TopicValidator = {
    meta: { kind: 'state' },
    validatePayload: () => ({ ok: false, errors: ['/noteId must be string'], schemaPaths: ['#/properties/noteId/type'] }),
  };

  it.each<{
    subject: 'payload' | 'envelope';
    validators?: Record<string, TopicValidator>;
    input: OutboxWriteInput;
    errors: string[];
  }>([
    { subject: 'payload', validators: { [TOPIC]: rejectingNoteId }, input: NOTE, errors: ['/noteId must be string'] },
    { subject: 'envelope', input: { ...NOTE, aggregateVersion: 0 }, errors: ['/aggregateVersion must be >= 1'] },
  ])('rejects a $subject that fails its contract with OutboxPayloadError and writes nothing', async (failure) => {
    const { db, statements } = stubOutbox(() => [], failure.validators);
    await expect(withTenant(db, tenant, (tx) => writeOutbox(tx, failure.input))).rejects.toThrow(
      new OutboxPayloadError(TOPIC, failure.errors, failure.subject),
    );
    expect(sqlByConnection(statements)).toEqual([['BEGIN', SET_TENANT_SQL, 'ROLLBACK']]);
  });
});

describe('releaseOperation and discardOperation', () => {
  const tenant = TENANT_A_FIXTURE.tenantId;

  beforeEach(() => {
    resetOutboxRuntimes();
  });

  /** Writes two held rows of `op-1` and one of `op-2` in one committed transaction. */
  async function heldRows() {
    const store = outboxStore();
    const outbox = stubOutbox(store.respond);
    const envelopes = await withTenant(outbox.db, tenant, async (tx) => [
      await writeOutbox(tx, { ...NOTE, operationId: 'op-1' }),
      await writeOutbox(tx, { ...NOTE, aggregateVersion: 2, operationId: 'op-1' }),
      await writeOutbox(tx, { ...NOTE, aggregateId: 'N2', operationId: 'op-2' }),
    ]);
    outbox.statements.length = 0;
    return { ...outbox, store, envelopes };
  }

  it("releases an operation's held rows and publishes them after COMMIT", async () => {
    const { db, statements, publisher, envelopes } = await heldRows();
    await expect(withTenant(db, tenant, (tx) => releaseOperation(tx, 'op-1'))).resolves.toBe(2);

    expect(publisher.published.map((event) => event.envelope)).toEqual(envelopes.slice(0, 2));
    expect(sqlByConnection(statements)).toEqual([
      ['BEGIN', SET_TENANT_SQL, RELEASE_SQL, 'COMMIT'],
      ['BEGIN', SET_TENANT_SQL, FLUSH_LOCK_TIMEOUT_SQL, expect.stringMatching(FLUSH_SELECT), expect.stringMatching(FLUSH_BLOCKERS), STAMP_SQL, 'COMMIT'],
    ]);
    expect(statements.find((s) => s.sql === RELEASE_SQL)).toMatchObject({ tenantId: tenant, values: ['op-1'] });
  });

  it('releases nothing and schedules no flush for an operation without held rows', async () => {
    const { db, statements, publisher } = await heldRows();
    await expect(withTenant(db, tenant, (tx) => releaseOperation(tx, 'op-3'))).resolves.toBe(0);
    expect(sqlByConnection(statements)).toEqual([['BEGIN', SET_TENANT_SQL, RELEASE_SQL, 'COMMIT']]);
    expect(publisher.published).toEqual([]);
  });

  it("deletes a rolled-back operation's held rows so they never publish", async () => {
    const { db, statements, publisher, store } = await heldRows();
    await expect(withTenant(db, tenant, (tx) => discardOperation(tx, 'op-1'))).resolves.toBe(2);

    expect(store.rows.map((row) => row.operation_id)).toEqual(['op-2']);
    expect(sqlByConnection(statements)).toEqual([['BEGIN', SET_TENANT_SQL, DISCARD_SQL, 'COMMIT']]);
    expect(publisher.published).toEqual([]);
  });

  it.each<{ name: string; run: (tx: TenantTx) => Promise<unknown> }>([
    { name: 'writeOutbox', run: (tx) => writeOutbox(tx, NOTE) },
    { name: 'releaseOperation', run: (tx) => releaseOperation(tx, 'op-1') },
    { name: 'discardOperation', run: (tx) => discardOperation(tx, 'op-1') },
  ])('$name rejects a metadata transaction with OutboxTransactionError before any outbox statement', async ({ run }) => {
    const { db, statements } = stubOutbox();
    await expect(db.withMetadata((tx) => run(tx as unknown as TenantTx))).rejects.toThrow(new OutboxTransactionError('metadata'));
    expect(sqlByConnection(statements)).toEqual([['BEGIN', SET_TENANT_SQL, 'ROLLBACK']]);
  });
});

