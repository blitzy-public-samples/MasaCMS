import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { OUTBOX_KINDS, OUTBOX_TABLE, localTimestamp, outboxSql, outboxTable, rowFromDb } from '../../src/outbox/ddl.js';
import { outboxDrainCounts, registryTenants } from '../../src/outbox/stats.js';
import { rlsSql } from '../../src/tenancy/rls.js';
import { tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import type { TenantDb } from '../../src/tenancy/transaction.js';

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const TENANT_C = tenantIdForSite('tenant-c');
const EVENT_ID = '0f7c6a52-0c8e-4d8e-9a43-6a3c1d2b5e70';
const REGISTRY_SQL = 'SELECT tenant_id, site_id FROM stub.tenant_registry ORDER BY site_id';
const COUNT_SQL =
  'SELECT count(*) FILTER (WHERE published_at IS NULL AND NOT held) AS unpublished,' +
  ' count(*) FILTER (WHERE held) AS held FROM "stub".outbox';

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
