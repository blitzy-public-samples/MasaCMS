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

/** The barrier's three statements, whitespace collapsed; the double answers only these. */
const UPSERT_SQL =
  `INSERT INTO ${SCHEMA}.session_barrier AS b (session_id, owner, xid, recorded_at) ` +
  'SELECT $1, p.owner, p.xid, now() FROM unnest($2::text[], $3::numeric[]) AS p(owner, xid) ' +
  'ON CONFLICT (session_id, owner) DO UPDATE SET xid = GREATEST(b.xid, EXCLUDED.xid), recorded_at = EXCLUDED.recorded_at';
const SELECT_SQL = `SELECT owner, xid::text AS xid FROM ${SCHEMA}.session_barrier WHERE session_id = $1`;
const DELETE_SQL =
  `DELETE FROM ${SCHEMA}.session_barrier AS b USING unnest($2::text[], $3::numeric[]) AS p(owner, xid) ` +
  'WHERE b.session_id = $1 AND b.owner = p.owner AND b.xid <= p.xid';

/** One statement as a metadata transaction received it. */
interface Statement {
  sql: string;
  values: unknown[];
}

/** TenantDb double holding session_barrier rows with numeric(20,0) xids as bigints. */
interface MemoryBarrierTable {
  db: TenantDb;
  statements: Statement[];
  transactions(): number;
  /** The session's rows as owner -> xid text. */
  rows(sessionId: string): Record<string, string>;
}

function memoryBarrierTable(): MemoryBarrierTable {
  const sessions = new Map<string, Map<string, bigint>>();
  const statements: Statement[] = [];
  let transactions = 0;

  /** The `unnest($2::text[], $3::numeric[])` pairs of an upsert or delete. */
  const pairs = (values: unknown[]): Array<[string, bigint]> => {
    const [, owners, xids] = values as [string, string[], string[]];
    return owners.map((owner, i) => [owner, BigInt(String(xids[i]))]);
  };

  function execute(sql: string, values: unknown[]): QueryResultRow[] {
    const sessionId = values[0] as string;
    const table = sessions.get(sessionId) ?? new Map<string, bigint>();
    switch (sql) {
      case UPSERT_SQL:
        for (const [owner, xid] of pairs(values)) {
          const stored = table.get(owner);
          table.set(owner, stored === undefined || xid > stored ? xid : stored);
        }
        sessions.set(sessionId, table);
        return [];
      case SELECT_SQL:
        return [...table].map(([owner, xid]) => ({ owner, xid: xid.toString() }));
      case DELETE_SQL:
        for (const [owner, xid] of pairs(values)) {
          const stored = table.get(owner);
          if (stored !== undefined && stored <= xid) table.delete(owner);
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
    rows: (sessionId) => Object.fromEntries([...(sessions.get(sessionId) ?? [])].map(([owner, xid]) => [owner, xid.toString()])),
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

describe('SessionBarrier failed projection awaits', () => {
  type Wait = (barrier: SessionBarrier) => Promise<void>;
  const WAITS: Array<[string, Wait, string]> = [
    ['awaitForSession', (barrier) => barrier.awaitForSession(SESSION), 'identity=7,people=42'],
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
