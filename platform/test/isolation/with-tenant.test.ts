import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  InvalidTenantIdError,
  OutsideTenantTransactionError,
  TransactionEndedError,
  currentTenantTx,
  requireTenantTx,
  rlsSql,
  tenantDbFromPool,
  tenantRegistrySql,
  withMetadata,
  withTenant,
  type Pool,
  type QueryConfig,
  type TenantDb,
  type TenantTx,
  type TxBase,
} from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  pgAvailable,
  runCleanup,
  seedRegistry,
  testPgConfig,
  type TenantFixture,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const SOURCE = 'isowt';
const REQUIRED_PG_ENV = ['PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'] as const;
const SET_TENANT_SQL = /^SELECT set_config\('app\.tenant_id', \$1, true\)$/;
const RLS_VIOLATION = '42501';
const BARRIER_MS = 5_000;

const SEED: readonly { tenant: TenantFixture; id: string }[] = [
  { tenant: TENANT_A, id: '0A000000-0000-0000-0000000000000001' },
  { tenant: TENANT_B, id: '0B000000-0000-0000-0000000000000001' },
  { tenant: TENANT_UMBRELLA, id: '0C000000-0000-0000-0000000000000001' },
];
const [SEED_A, SEED_B, SEED_UMBRELLA] = SEED.map((row) => row.id) as [string, string, string];

interface NoteView {
  setting: string;
  tenants: string[];
  ids: string[];
}

type QuerySpy = { mock: { calls: unknown[][] }; mockClear(): unknown };

let handle: ThrowawaySchema | undefined;
const extraPools: Pool[] = [];
let noteSeq = 0;

/** The throwaway schema handle created in beforeAll. */
function db(): ThrowawaySchema {
  if (handle === undefined) {
    throw new Error('The throwaway schema was not created');
  }
  return handle;
}

/** A fresh 35-character CF-format note id. */
function nextNoteId(): string {
  noteSeq += 1;
  return `0D000000-0000-0000-${noteSeq.toString(16).toUpperCase().padStart(16, '0')}`;
}

/** Inserts a `note` row for `tenantId` through `tx`. */
async function insertNote(tx: TxBase, tenantId: string, id: string): Promise<void> {
  await tx.query(`INSERT INTO ${tx.schema}.note (tenant_id, id, body) VALUES ($1, $2, $3)`, [tenantId, id, `note ${id}`]);
}

/** The `app.tenant_id` setting and the tenants and ids of the `note` rows visible in `tx`. */
async function noteView(tx: TxBase): Promise<NoteView> {
  const setting = await tx.query<{ value: string | null }>("SELECT current_setting('app.tenant_id', true) AS value");
  const rows = await tx.query<{ tenant_id: string; id: string }>(`SELECT tenant_id::text AS tenant_id, id FROM ${tx.schema}.note ORDER BY id`);
  return {
    setting: setting.rows[0]?.value ?? '',
    tenants: [...new Set(rows.rows.map((row) => row.tenant_id))].sort(),
    ids: rows.rows.map((row) => row.id),
  };
}

/** Number of `note` rows with `id` visible to `tenantId` in a separate transaction. */
async function countNote(tenantDb: TenantDb, tenantId: string, id: string): Promise<number> {
  return withTenant(tenantDb, tenantId, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tx.schema}.note WHERE id = $1`, [id]);
    return rows[0]?.n ?? 0;
  });
}

/** An arrival function that resolves once `parties` callers have arrived, rejecting after BARRIER_MS. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) {
      open();
    }
    const timeout = new AbortController();
    try {
      await Promise.race([
        opened,
        sleep(BARRIER_MS, undefined, { signal: timeout.signal }).then(() => {
          throw new Error(`barrier of ${String(parties)} not reached within ${String(BARRIER_MS)} ms`);
        }),
      ]);
    } finally {
      timeout.abort();
    }
  };
}

/** Statement text and bound values of a recorded `client.query` call, string or config-object shape. */
function statementOf(call: unknown[]): { text: string; values: unknown } {
  const [first, second] = call;
  if (typeof first === 'string') {
    return { text: first, values: second };
  }
  const config = first as QueryConfig;
  return { text: config.text, values: second ?? config.values };
}

describe('withTenant against PostgreSQL', () => {
  beforeAll(async () => {
    const missing = REQUIRED_PG_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`The withTenant isolation suite needs ${missing.join(', ')} in the environment`);
    }
    if (!(await pgAvailable())) {
      const { host, port } = testPgConfig();
      throw new Error(`The withTenant isolation suite cannot reach PostgreSQL at ${host}:${String(port)}`);
    }
    handle = await createThrowawaySchema({
      service: SOURCE,
      extraSql: [
        tenantRegistrySql(SOURCE),
        `CREATE TABLE ${SOURCE}.note (tenant_id uuid NOT NULL, id char(35) PRIMARY KEY, body text, row_version int NOT NULL DEFAULT 0)`,
        rlsSql(SOURCE, 'note'),
      ],
    });
    for (const { tenant, id } of SEED) {
      await withTenant(handle.app, tenant.tenantId, (tx) => insertNote(tx, tenant.tenantId, id));
    }
    await seedRegistry(handle.app);
  });

  afterAll(async () => {
    await runCleanup('with-tenant suite', [...extraPools.map((pool) => () => pool.end()), () => handle?.drop()]);
  });

  it('sets app.tenant_id to the tenant inside the transaction', async () => {
    const view = await withTenant(db().app, TENANT_A.tenantId, noteView);
    expect(view.setting).toBe(TENANT_A.tenantId);
    expect(view.tenants).toEqual([TENANT_A.tenantId]);
    expect(view.ids).toContain(SEED_A);
  });

  describe('on a single-connection app pool', () => {
    let pool: Pool;
    let single: TenantDb;
    const spies: QuerySpy[] = [];

    beforeAll(() => {
      pool = db().connect('app', { max: 1 });
      extraPools.push(pool);
      pool.on('connect', (client) => {
        spies.push(vi.spyOn(client, 'query'));
      });
      single = tenantDbFromPool(pool, { schema: db().schema });
    });

    it('opens the transaction with BEGIN and then sets app.tenant_id transaction-locally', async () => {
      spies.forEach((spy) => spy.mockClear());
      await withTenant(single, TENANT_A.tenantId, (tx) => tx.query('SELECT 1'));
      const statements = spies.flatMap((spy) => spy.mock.calls).map(statementOf);
      expect(statements[0]?.text).toBe('BEGIN');
      expect(statements[1]?.text).toMatch(SET_TENANT_SQL);
      expect(statements[1]?.values).toEqual([TENANT_A.tenantId]);
      expect(statements.at(-1)?.text).toBe('COMMIT');
    });

    it('leaves the reused connection without a tenant, rows or write access after COMMIT', async () => {
      const pid = await withTenant(single, TENANT_A.tenantId, async (tx) => {
        const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return rows[0]?.pid;
      });
      const client = await pool.connect();
      try {
        const reused = await client.query<{ pid: number; value: string | null; n: number }>(
          `SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id', true) AS value,
                  (SELECT count(*)::int FROM ${db().schema}.note) AS n`,
        );
        expect(reused.rows[0]?.pid).toBe(pid);
        expect(reused.rows[0]?.value ?? '').toBe('');
        expect(reused.rows[0]?.n).toBe(0);
        await expect(
          client.query(`INSERT INTO ${db().schema}.note (tenant_id, id, body) VALUES ($1, $2, $3)`, [
            TENANT_A.tenantId,
            nextNoteId(),
            'leaked write',
          ]),
        ).rejects.toMatchObject({ code: RLS_VIOLATION });
      } finally {
        client.release();
      }
    });

    it('rejects with the reason of an already aborted signal without checking out a connection', async () => {
      const connect = vi.spyOn(pool, 'connect');
      const reason = new Error('client closed');
      const fn = vi.fn(() => Promise.resolve());
      try {
        await expect(withTenant(single, TENANT_A.tenantId, fn, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
        expect(connect).not.toHaveBeenCalled();
        expect(fn).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    });

    it('destroys the held connection and drops the uncommitted write when the signal aborts mid-transaction', async () => {
      const controller = new AbortController();
      const reason = new Error('client closed');
      const id = nextNoteId();
      let reached!: (pid: number) => void;
      const started = new Promise<number>((resolve) => {
        reached = resolve;
      });
      let resume!: () => void;
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });

      const run = withTenant(
        single,
        TENANT_A.tenantId,
        async (tx) => {
          const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          await insertNote(tx, TENANT_A.tenantId, id);
          reached(rows[0]?.pid ?? -1);
          await held;
        },
        { signal: controller.signal },
      );
      const pid = await started;
      controller.abort(reason);
      await expect(run).rejects.toBe(reason);
      resume();

      const next = await withTenant(single, TENANT_A.tenantId, async (tx) => {
        const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return rows[0]?.pid;
      });
      expect(next).not.toBe(pid);
      await vi.waitFor(async () => {
        const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid]);
        expect(rows[0]?.n).toBe(0);
      });
      expect(await countNote(db().app, TENANT_A.tenantId, id)).toBe(0);
    });
  });

  it('runs withMetadata with an empty tenant that sees no tenant rows but reads tenant_registry', async () => {
    const seen = await withMetadata(db().app, async (tx) => {
      const view = await noteView(tx);
      const registry = await tx.query<{ site_id: string }>(`SELECT site_id FROM ${tx.schema}.tenant_registry ORDER BY site_id`);
      return { view, sites: registry.rows.map((row) => row.site_id) };
    });
    expect(seen.view).toEqual({ setting: '', tenants: [], ids: [] });
    expect(seen.sites.length).toBeGreaterThanOrEqual(3);
    expect(seen.sites).toContain(TENANT_A.siteId);
  });

  it('keeps concurrently open transactions of different tenants apart', async () => {
    const arrive = barrier(2);
    const readAs = (tenant: TenantFixture) =>
      withTenant(db().app, tenant.tenantId, async (tx) => {
        await arrive();
        return { view: await noteView(tx), current: currentTenantTx()?.tenantId };
      });
    const [a, b] = await Promise.all([readAs(TENANT_A), readAs(TENANT_B)]);
    expect(a.view.setting).toBe(TENANT_A.tenantId);
    expect(a.view.tenants).toEqual([TENANT_A.tenantId]);
    expect(a.view.ids).toContain(SEED_A);
    expect(a.current).toBe(TENANT_A.tenantId);
    expect(b.view).toEqual({ setting: TENANT_B.tenantId, tenants: [TENANT_B.tenantId], ids: [SEED_B] });
    expect(b.current).toBe(TENANT_B.tenantId);
  });

  it('runs a nested withTenant as its own transaction and restores the outer tenant afterwards', async () => {
    const { inner, outer, outerTx } = await withTenant(db().app, TENANT_A.tenantId, async (tx) => {
      const nested = await withTenant(db().app, TENANT_B.tenantId, async (innerTx) => ({
        view: await noteView(innerTx),
        current: currentTenantTx()?.tenantId,
      }));
      return { inner: nested, outer: { view: await noteView(tx), current: currentTenantTx() }, outerTx: tx };
    });
    expect(inner.view).toEqual({ setting: TENANT_B.tenantId, tenants: [TENANT_B.tenantId], ids: [SEED_B] });
    expect(inner.current).toBe(TENANT_B.tenantId);
    expect(outer.view.setting).toBe(TENANT_A.tenantId);
    expect(outer.view.tenants).toEqual([TENANT_A.tenantId]);
    expect(outer.view.ids).not.toContain(SEED_B);
    expect(outer.current).toBe(outerTx);
  });

  it('rolls back the write and skips commit callbacks when the callback throws', async () => {
    const committed = vi.fn();
    const failure = new Error('abort after insert');
    const id = nextNoteId();
    await expect(
      withTenant(db().app, TENANT_A.tenantId, async (tx) => {
        tx.onCommit(committed);
        await insertNote(tx, TENANT_A.tenantId, id);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(committed).not.toHaveBeenCalled();
    expect(await countNote(db().app, TENANT_A.tenantId, id)).toBe(0);
  });

  it('awaits commit callbacks in registration order after COMMIT', async () => {
    const order: number[] = [];
    const id = nextNoteId();
    let visibleAfterCommit: number | undefined;
    await withTenant(db().app, TENANT_A.tenantId, async (tx) => {
      await insertNote(tx, TENANT_A.tenantId, id);
      tx.onCommit(async () => {
        await sleep(25);
        order.push(1);
        visibleAfterCommit = await countNote(db().app, TENANT_A.tenantId, id);
      });
      tx.onCommit(() => {
        order.push(2);
      });
    });
    expect(order).toEqual([1, 2]);
    expect(visibleAfterCommit).toBe(1);
  });

  it('exposes the active tenant transaction only inside withTenant', async () => {
    expect(() => requireTenantTx()).toThrow(OutsideTenantTransactionError);
    expect(currentTenantTx()).toBeUndefined();
    const seen = await withTenant(db().app, TENANT_A.tenantId, (tx) => Promise.resolve({ tx, required: requireTenantTx() }));
    expect(seen.required).toBe(seen.tx);
    expect(seen.required.tenantId).toBe(TENANT_A.tenantId);
    expect(currentTenantTx()).toBeUndefined();
  });

  it('rejects statements and commit callbacks on a transaction captured past its end', async () => {
    let captured: TenantTx | undefined;
    await withTenant(db().app, TENANT_A.tenantId, (tx) => {
      captured = tx;
      return Promise.resolve();
    });
    if (captured === undefined) {
      throw new Error('withTenant did not run its callback');
    }
    await expect(captured.query('SELECT 1')).rejects.toBeInstanceOf(TransactionEndedError);
    expect(() => captured?.onCommit(() => undefined)).toThrow(TransactionEndedError);
  });

  it.each([
    ['a legacy site id', TENANT_A.siteId],
    ['a CF-format id', SEED_UMBRELLA],
    ['an empty string', ''],
  ])('rejects %s as tenant id with InvalidTenantIdError before running the callback', async (_label, tenantId) => {
    const fn = vi.fn(() => Promise.resolve());
    await expect(withTenant(db().app, tenantId, fn)).rejects.toBeInstanceOf(InvalidTenantIdError);
    expect(fn).not.toHaveBeenCalled();
  });
});
