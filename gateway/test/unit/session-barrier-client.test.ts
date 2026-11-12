// Read-after-write session barrier over an in-memory gateway.session_barrier table and a stub migration client.
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { WritePositions } from '@opt2/platform/migration-kit';
import {
  ServiceUnavailableError,
  UnknownServiceError,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import type { MetadataTx, QueryConfig, QueryResult, QueryResultRow, TenantDb } from '@opt2/platform/tenancy';
import { describe, expect, it } from 'vitest';
import {
  BarrierTimeoutError,
  PROJECTION_AWAIT_TIMEOUT_MS,
  createSessionBarrier,
  type SessionBarrier,
} from '../../src/dispatcher/barrier.js';

const SCHEMA = 't_gateway_barrier';
const SESSION = 'identity-session-0001';
const OTHER_SESSION = 'identity-session-0002';
const AWAIT_PATH = '/internal/v1/projection/await';

/** The barrier's statements, whitespace collapsed; the double answers only these. */
const DECLARE_SQL =
  `INSERT INTO ${SCHEMA}.session_barrier AS b (session_id, owner, pending, recorded_at) VALUES ($1, $2, 1, now()) ` +
  'ON CONFLICT (session_id, owner) DO UPDATE SET pending = b.pending + 1';
const UPSERT_SQL =
  `INSERT INTO ${SCHEMA}.session_barrier AS b (session_id, owner, xid, recorded_at) ` +
  'SELECT $1, p.owner, p.xid, now() FROM unnest($2::text[], $3::numeric[]) AS p(owner, xid) ' +
  'ON CONFLICT (session_id, owner) DO UPDATE SET xid = GREATEST(b.xid, EXCLUDED.xid), recorded_at = EXCLUDED.recorded_at';
const END_SQL =
  `WITH gone AS ( DELETE FROM ${SCHEMA}.session_barrier ` +
  'WHERE session_id = $1 AND owner = $2 AND pending = 1 AND xid IS NULL RETURNING owner ) ' +
  `UPDATE ${SCHEMA}.session_barrier SET pending = pending - 1 ` +
  'WHERE session_id = $1 AND owner = $2 AND pending > 0 AND NOT EXISTS (SELECT 1 FROM gone)';
const SELECT_SQL = `SELECT owner, xid::text AS xid, pending FROM ${SCHEMA}.session_barrier WHERE session_id = $1`;
const DELETE_SQL =
  `DELETE FROM ${SCHEMA}.session_barrier AS b USING unnest($2::text[], $3::numeric[]) AS p(owner, xid) ` +
  'WHERE b.session_id = $1 AND b.owner = p.owner AND b.pending = 0 AND (b.xid IS NULL OR b.xid <= p.xid)';

/** One statement as a metadata transaction received it. */
interface Statement {
  sql: string;
  values: unknown[];
}

/** One session_barrier row: a numeric(20,0) xid as a bigint, or none, and the declared writes. */
interface BarrierRow {
  xid: bigint | null;
  pending: number;
}

/** TenantDb double holding session_barrier rows. */
interface MemoryBarrierTable {
  db: TenantDb;
  statements: Statement[];
  transactions(): number;
  /** The session's rows as owner -> xid text, or null for a row without a position. */
  rows(sessionId: string): Record<string, string | null>;
  /** The session's rows as owner -> xid text and declared writes. */
  full(sessionId: string): Record<string, { xid: string | null; pending: number }>;
}

function memoryBarrierTable(): MemoryBarrierTable {
  const sessions = new Map<string, Map<string, BarrierRow>>();
  const statements: Statement[] = [];
  let transactions = 0;

  /** The `unnest($2::text[], $3::numeric[])` pairs of an upsert or delete; a null xid stays null. */
  const pairs = (values: unknown[]): Array<[string, bigint | null]> => {
    const [, owners, xids] = values as [string, string[], Array<string | null>];
    return owners.map((owner, i) => [owner, xids[i] === null ? null : BigInt(String(xids[i]))]);
  };

  function execute(sql: string, values: unknown[]): QueryResultRow[] {
    const sessionId = values[0] as string;
    const table = sessions.get(sessionId) ?? new Map<string, BarrierRow>();
    sessions.set(sessionId, table);
    switch (sql) {
      case DECLARE_SQL: {
        const owner = values[1] as string;
        const stored = table.get(owner);
        table.set(owner, { xid: stored?.xid ?? null, pending: (stored?.pending ?? 0) + 1 });
        return [];
      }
      case UPSERT_SQL:
        for (const [owner, xid] of pairs(values)) {
          const stored = table.get(owner);
          const kept = stored?.xid ?? null;
          table.set(owner, { xid: kept === null || (xid !== null && xid > kept) ? xid : kept, pending: stored?.pending ?? 0 });
        }
        return [];
      case END_SQL: {
        const owner = values[1] as string;
        const stored = table.get(owner);
        if (stored === undefined || stored.pending === 0) return [];
        if (stored.pending === 1 && stored.xid === null) table.delete(owner);
        else stored.pending -= 1;
        return [];
      }
      case SELECT_SQL:
        return [...table].map(([owner, row]) => ({ owner, xid: row.xid?.toString() ?? null, pending: row.pending }));
      case DELETE_SQL:
        for (const [owner, xid] of pairs(values)) {
          const stored = table.get(owner);
          if (stored?.pending !== 0) continue;
          if (stored.xid === null || (xid !== null && stored.xid <= xid)) table.delete(owner);
        }
        return [];
      default:
        throw new Error(`unexpected statement: ${sql}`);
    }
  }

  const tx: MetadataTx = {
    kind: 'metadata',
    schema: SCHEMA,
    query: async <R extends QueryResultRow>(text: string | QueryConfig, values: unknown[] = []): Promise<QueryResult<R>> => {
      const sql = (typeof text === 'string' ? text : text.text).replace(/\s+/g, ' ').trim();
      statements.push({ sql, values });
      const rows = execute(sql, values);
      return { command: sql.slice(0, sql.indexOf(' ')), rowCount: rows.length, oid: 0, fields: [], rows } as unknown as QueryResult<R>;
    },
    onCommit: () => {
      throw new Error('the barrier registers no commit callbacks');
    },
  };
  const db: TenantDb = {
    schema: SCHEMA,
    withTenant: () => Promise.reject(new Error('the barrier never acts for a tenant')),
    withMetadata: (fn) => {
      transactions += 1;
      return fn(tx);
    },
    end: () => Promise.resolve(),
  };
  return {
    db,
    statements,
    transactions: () => transactions,
    rows: (sessionId) =>
      Object.fromEntries([...(sessions.get(sessionId) ?? [])].map(([owner, row]) => [owner, row.xid?.toString() ?? null])),
    full: (sessionId) =>
      Object.fromEntries(
        [...(sessions.get(sessionId) ?? [])].map(([owner, row]) => [owner, { xid: row.xid?.toString() ?? null, pending: row.pending }]),
      ),
  };
}

type Answer = (req: ServiceRequest) => Promise<ServiceResponse>;

/** A ServiceClient whose every call is recorded and answered by `answer`. */
function stubClient(answer: Answer): ServiceClient & { calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const request = async (req: ServiceRequest): Promise<ServiceResponse> => {
    calls.push(req);
    return answer(req);
  };
  return { calls, request: request as ServiceClient['request'], close: async () => undefined };
}

const answerStatus =
  (status: number): Answer =>
  async () => ({ status, headers: {}, body: {} });

function setup(answer: Answer = answerStatus(200)) {
  const table = memoryBarrierTable();
  const client = stubClient(answer);
  return { table, client, barrier: createSessionBarrier({ db: table.db, client }) };
}

const positions = (entries: Record<string, string>): WritePositions => new Map(Object.entries(entries));

/** The value `promise` rejects with; fails the test when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the await to reject');
}

describe('SessionBarrier.record', () => {
  it('upserts every owner position of the session in one metadata transaction', async () => {
    const { table, barrier } = setup();
    await barrier.record(SESSION, positions({ people: '42', identity: '7' }));
    expect(table.statements).toEqual([{ sql: UPSERT_SQL, values: [SESSION, ['people', 'identity'], ['42', '7']] }]);
    expect(table.transactions()).toBe(1);
    expect(table.rows(SESSION)).toEqual({ people: '42', identity: '7' });
  });

  it.each<[string, string[], string]>([
    ['a longer decimal outranks a lexically greater one', ['99', '100'], '100'],
    ['a lower xid recorded later is ignored', ['100', '99'], '100'],
    ['an equal xid leaves the position as it was', ['100', '100'], '100'],
    ['xid8 values beyond 2^53 compare exactly', ['18446744073709551615', '18446744073709551614'], '18446744073709551615'],
  ])('keeps the highest xid per owner: %s', async (_label, xids, highest) => {
    const { client, barrier } = setup();
    for (const xid of xids) await barrier.record(SESSION, positions({ people: xid, identity: '7' }));
    await barrier.awaitForSession(SESSION);
    expect(client.calls.map((call) => call.json)).toEqual([
      { positions: { people: highest, identity: '7' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
    ]);
  });

  it('keeps the positions of different sessions apart', async () => {
    const { table, client, barrier } = setup();
    await barrier.record(SESSION, positions({ people: '42' }));
    await barrier.record(OTHER_SESSION, positions({ people: '50', identity: '9' }));
    await barrier.awaitForSession(SESSION);
    expect(client.calls.map((call) => call.json)).toEqual([{ positions: { people: '42' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS }]);
    expect(table.rows(SESSION)).toEqual({});
    expect(table.rows(OTHER_SESSION)).toEqual({ people: '50', identity: '9' });
  });

  it('issues no statement for an empty position set', async () => {
    const { table, barrier } = setup();
    await barrier.record(SESSION, new Map());
    expect(table.transactions()).toBe(0);
    expect(table.statements).toEqual([]);
  });

  it('ends one declaration of the declared owner in the transaction that records the positions', async () => {
    const { table, barrier } = setup();
    await barrier.declare(SESSION, 'people');
    await barrier.declare(SESSION, 'people');
    await barrier.record(SESSION, positions({ people: '42', identity: '7' }), 'people');
    expect(table.statements.slice(2)).toEqual([
      { sql: UPSERT_SQL, values: [SESSION, ['people', 'identity'], ['42', '7']] },
      { sql: END_SQL, values: [SESSION, 'people'] },
    ]);
    expect(table.transactions()).toBe(3);
    expect(table.full(SESSION)).toEqual({ people: { xid: '42', pending: 1 }, identity: { xid: '7', pending: 0 } });
  });

  it.each<[string, WritePositions, Record<string, { xid: string | null; pending: number }>]>([
    ['positions of other owners only', positions({ identity: '7' }), { identity: { xid: '7', pending: 0 } }],
    ['no positions', new Map(), {}],
  ])('drops the declared row when the record carries %s', async (_label, recorded, expected) => {
    const { table, barrier } = setup();
    await barrier.declare(SESSION, 'strategies-content');
    await barrier.record(SESSION, recorded, 'strategies-content');
    expect(table.statements.at(-1)).toEqual({ sql: END_SQL, values: [SESSION, 'strategies-content'] });
    expect(table.full(SESSION)).toEqual(expected);
  });
});

describe('SessionBarrier.declare and release', () => {
  it('declares one pending write per call in its own transaction, with no position', async () => {
    const { table, barrier } = setup();
    await barrier.declare(SESSION, 'people');
    await barrier.declare(SESSION, 'people');
    expect(table.statements).toEqual([
      { sql: DECLARE_SQL, values: [SESSION, 'people'] },
      { sql: DECLARE_SQL, values: [SESSION, 'people'] },
    ]);
    expect(table.transactions()).toBe(2);
    expect(table.full(SESSION)).toEqual({ people: { xid: null, pending: 2 } });
    expect(table.full(OTHER_SESSION)).toEqual({});
  });

  it('ends one declaration per release, dropping the row once it holds neither a declaration nor a position', async () => {
    const { table, barrier } = setup();
    await barrier.declare(SESSION, 'people');
    await barrier.declare(SESSION, 'people');
    await barrier.release(SESSION, 'people');
    expect(table.statements.at(-1)).toEqual({ sql: END_SQL, values: [SESSION, 'people'] });
    expect(table.full(SESSION)).toEqual({ people: { xid: null, pending: 1 } });
    await barrier.release(SESSION, 'people');
    expect(table.full(SESSION)).toEqual({});
    await barrier.release(SESSION, 'people');
    expect(table.full(SESSION)).toEqual({});
  });

  it('keeps a recorded position when it ends the last declaration and never counts below zero', async () => {
    const { table, barrier } = setup();
    await barrier.declare(SESSION, 'people');
    await barrier.record(SESSION, positions({ people: '42' }));
    await barrier.release(SESSION, 'people');
    expect(table.full(SESSION)).toEqual({ people: { xid: '42', pending: 0 } });
    await barrier.release(SESSION, 'people');
    expect(table.full(SESSION)).toEqual({ people: { xid: '42', pending: 0 } });
  });
});

describe('SessionBarrier.awaitForSession', () => {
  it('posts the recorded positions with the 5 s bound to migration without the user token', async () => {
    const { client, barrier } = setup();
    await barrier.record(SESSION, positions({ people: '42', identity: '7' }));
    await barrier.awaitForSession(SESSION);
    expect(PROJECTION_AWAIT_TIMEOUT_MS).toBe(5000);
    expect(client.calls).toEqual([
      {
        service: 'migration',
        method: 'POST',
        path: AWAIT_PATH,
        json: { positions: { people: '42', identity: '7' }, timeoutMs: 5000 },
        userToken: null,
      },
    ]);
  });

  it('asks migration nothing for a session without recorded positions', async () => {
    const { table, client, barrier } = setup();
    await barrier.awaitForSession(SESSION);
    expect(client.calls).toEqual([]);
    expect(table.statements).toEqual([{ sql: SELECT_SQL, values: [SESSION] }]);
    expect(table.transactions()).toBe(1);
  });

  it.each([200, 204])('deletes the awaited positions once migration confirms them with HTTP %i', async (status) => {
    const { table, client, barrier } = setup(answerStatus(status));
    await barrier.record(SESSION, positions({ people: '42', identity: '7' }));
    await barrier.awaitForSession(SESSION);
    expect(table.statements.slice(1)).toEqual([
      { sql: SELECT_SQL, values: [SESSION] },
      { sql: DELETE_SQL, values: [SESSION, ['people', 'identity'], ['42', '7']] },
    ]);
    expect(table.rows(SESSION)).toEqual({});
    await barrier.awaitForSession(SESSION);
    expect(client.calls).toHaveLength(1);
  });

  it('keeps a newer position recorded while migration confirmed the older one', async () => {
    let meanwhile: (() => Promise<void>) | undefined;
    const { table, client, barrier } = setup(async () => {
      await meanwhile?.();
      meanwhile = undefined;
      return { status: 200, headers: {}, body: {} };
    });
    await barrier.record(SESSION, positions({ people: '99', identity: '7' }));
    meanwhile = () => barrier.record(SESSION, positions({ people: '100' }));
    await barrier.awaitForSession(SESSION);
    expect(table.rows(SESSION)).toEqual({ people: '100' });
    await barrier.awaitForSession(SESSION);
    expect(client.calls.map((call) => call.json)).toEqual([
      { positions: { people: '99', identity: '7' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
      { positions: { people: '100' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
    ]);
    expect(table.rows(SESSION)).toEqual({});
  });
});

describe('SessionBarrier.awaitForSession with declared writes', () => {
  it('awaits the declared owners and the other recorded positions, then removes only the confirmed positions', async () => {
    const { table, client, barrier } = setup();
    await barrier.record(SESSION, positions({ people: '42' }));
    await barrier.declare(SESSION, 'identity');
    await barrier.declare(SESSION, 'identity');
    const before = table.statements.length;
    await barrier.awaitForSession(SESSION);
    expect(client.calls.map((call) => call.json)).toEqual([
      { positions: { people: '42' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
      { owners: ['identity'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
    ]);
    expect(table.statements.slice(before)).toEqual([
      { sql: SELECT_SQL, values: [SESSION] },
      { sql: DELETE_SQL, values: [SESSION, ['people', 'identity'], ['42', null]] },
    ]);
    expect(table.full(SESSION)).toEqual({ identity: { xid: null, pending: 2 } });
    await barrier.awaitForSession(SESSION);
    expect(client.calls.slice(2).map((call) => call.json)).toEqual([{ owners: ['identity'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS }]);
    expect(table.full(SESSION)).toEqual({ identity: { xid: null, pending: 2 } });
  });

  it('awaits a declared owner with a recorded position by its current position alone and keeps its row', async () => {
    const { table, client, barrier } = setup();
    await barrier.declare(SESSION, 'people');
    await barrier.record(SESSION, positions({ people: '42' }));
    await barrier.awaitForSession(SESSION);
    expect(client.calls.map((call) => call.json)).toEqual([{ owners: ['people'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS }]);
    expect(table.full(SESSION)).toEqual({ people: { xid: '42', pending: 1 } });
  });

  it('leaves a declaration made before the read to its own exchange, so a later exchange keeps its own', async () => {
    const { table, client, barrier } = setup();
    await barrier.declare(SESSION, 'people');
    await barrier.awaitForSession(SESSION);
    expect(table.full(SESSION)).toEqual({ people: { xid: null, pending: 1 } });
    await barrier.declare(SESSION, 'people');
    await barrier.record(SESSION, positions({ people: '50' }), 'people');
    await barrier.awaitForSession(SESSION);
    expect(table.full(SESSION)).toEqual({ people: { xid: '50', pending: 1 } });
    await barrier.release(SESSION, 'people');
    await barrier.awaitForSession(SESSION);
    expect(client.calls.map((call) => call.json)).toEqual([
      { owners: ['people'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
      { owners: ['people'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
      { positions: { people: '50' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
    ]);
    expect(table.full(SESSION)).toEqual({});
  });

  it('keeps a declaration and a position added while migration confirmed the owner', async () => {
    let meanwhile: (() => Promise<void>) | undefined;
    const { table, client, barrier } = setup(async () => {
      await meanwhile?.();
      meanwhile = undefined;
      return { status: 200, headers: {}, body: {} };
    });
    await barrier.declare(SESSION, 'people');
    await barrier.declare(SESSION, 'identity');
    meanwhile = async () => {
      await barrier.record(SESSION, positions({ people: '50' }), 'people');
      await barrier.declare(SESSION, 'identity');
    };
    await barrier.awaitForSession(SESSION);
    expect(table.full(SESSION)).toEqual({ people: { xid: '50', pending: 0 }, identity: { xid: null, pending: 2 } });
    await barrier.awaitForSession(SESSION);
    expect(client.calls.map((call) => call.json)).toEqual([
      { owners: ['people', 'identity'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
      { positions: { people: '50' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
      { owners: ['identity'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
    ]);
    expect(table.full(SESSION)).toEqual({ identity: { xid: null, pending: 2 } });
  });

  it.each([503, 'unavailable'] as const)('keeps every declaration when migration answers %s', async (answer) => {
    const { table, barrier } = setup(
      answer === 503
        ? answerStatus(503)
        : () => Promise.reject(new ServiceUnavailableError('migration', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))),
    );
    await barrier.declare(SESSION, 'people');
    const error = await rejectionOf(barrier.awaitForSession(SESSION));
    expect(error).toBeInstanceOf(BarrierTimeoutError);
    expect(error).toMatchObject({ awaited: 'owners:people', reason: 'barrier-timeout' });
    expect(table.statements.map((statement) => statement.sql)).not.toContain(DELETE_SQL);
    expect(table.full(SESSION)).toEqual({ people: { xid: null, pending: 1 } });
  });
});

describe('SessionBarrier.awaitOwners', () => {
  it('posts the owners with the 5 s bound to migration without the user token or the session table', async () => {
    const { table, client, barrier } = setup();
    await barrier.awaitOwners(['identity', 'people']);
    expect(client.calls).toEqual([
      {
        service: 'migration',
        method: 'POST',
        path: AWAIT_PATH,
        json: { owners: ['identity', 'people'], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
        userToken: null,
      },
    ]);
    expect(table.transactions()).toBe(0);
  });
});

describe('SessionBarrier.awaitPositions', () => {
  it('posts the given positions with the 5 s bound to migration without the user token or the session table', async () => {
    const { table, client, barrier } = setup();
    await barrier.awaitPositions(positions({ people: '42', identity: '18446744073709551615' }));
    expect(client.calls).toEqual([
      {
        service: 'migration',
        method: 'POST',
        path: AWAIT_PATH,
        json: { positions: { people: '42', identity: '18446744073709551615' }, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS },
        userToken: null,
      },
    ]);
    expect(table.transactions()).toBe(0);
  });

  it('asks migration nothing for an empty position set', async () => {
    const { client, barrier } = setup();
    await barrier.awaitPositions(new Map());
    expect(client.calls).toEqual([]);
  });
});

describe('SessionBarrier failed projection awaits', () => {
  type Wait = (barrier: SessionBarrier) => Promise<void>;
  const WAITS: Array<[string, Wait, string]> = [
    ['awaitForSession', (barrier) => barrier.awaitForSession(SESSION), 'identity=7,people=42'],
    ['awaitPositions', (barrier) => barrier.awaitPositions(positions({ people: '43', identity: '8' })), 'identity=8,people=43'],
    ['awaitOwners', (barrier) => barrier.awaitOwners(['people', 'identity']), 'owners:people,identity'],
  ];
  const RECORDED = { people: '42', identity: '7' };

  async function recordedSetup(answer: Answer) {
    const context = setup(answer);
    await context.barrier.record(SESSION, positions(RECORDED));
    return context;
  }

  it.each(
    WAITS.flatMap(([method, wait, awaited]) =>
      [304, 400, 403, 404, 500, 503].map((status): [string, number, Wait, string] => [method, status, wait, awaited]),
    ),
  )('%s rejects an HTTP %i answer as BarrierTimeoutError and keeps the positions', async (_method, status, wait, awaited) => {
    const { table, barrier } = await recordedSetup(answerStatus(status));
    const error = await rejectionOf(wait(barrier));
    expect(error).toBeInstanceOf(BarrierTimeoutError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({
      name: 'BarrierTimeoutError',
      message: `Projection await for ${awaited} did not complete`,
      awaited,
      surface: 'auto',
      reason: 'barrier-timeout',
    });
    const { cause } = error as BarrierTimeoutError;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toMatchObject({ message: `migration answered HTTP ${String(status)}`, code: `HTTP_${String(status)}` });
    expect(table.statements.map((statement) => statement.sql)).not.toContain(DELETE_SQL);
    expect(table.rows(SESSION)).toEqual(RECORDED);
  });

  it.each(WAITS)('%s rejects an unavailable migration as BarrierTimeoutError carrying the cause', async (_method, wait, awaited) => {
    const unavailable = new ServiceUnavailableError('migration', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const { table, barrier } = await recordedSetup(() => Promise.reject(unavailable));
    const error = await rejectionOf(wait(barrier));
    expect(error).toBeInstanceOf(BarrierTimeoutError);
    expect(error).toMatchObject({ awaited, reason: 'barrier-timeout' });
    expect((error as BarrierTimeoutError).cause).toBe(unavailable);
    expect(table.rows(SESSION)).toEqual(RECORDED);
  });

  it.each(
    WAITS.flatMap(([method, wait]) =>
      (
        [
          ['an UnknownServiceError', new UnknownServiceError('migration')],
          ['an invalid-JSON error', new Error('migration answered with invalid JSON')],
        ] as const
      ).map(([label, thrown]): [string, string, Wait, Error] => [method, label, wait, thrown]),
    ),
  )('%s propagates %s unchanged', async (_method, _name, wait, thrown) => {
    const { table, barrier } = await recordedSetup(() => Promise.reject(thrown));
    const error = await rejectionOf(wait(barrier));
    expect(error).toBe(thrown);
    expect(error).not.toBeInstanceOf(BarrierTimeoutError);
    expect(table.rows(SESSION)).toEqual(RECORDED);
  });
});
