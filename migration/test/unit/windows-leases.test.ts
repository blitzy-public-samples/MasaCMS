// Unit tests for unit leases: atomic sorted acquisition, retry within a budget, release and holder lookups.
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LEASE_RETRY_INTERVAL_MS,
  LeaseUnavailableError,
  acquireLeases,
  holdersOf,
  leasesOf,
  releaseLeases,
  type LeaseKind,
} from '../../src/windows/leases.js';

// Fake timers do not reach the ESM binding of node:timers/promises, so it is routed through the faked global timer.
const timers = vi.hoisted(() => ({
  delay: vi.fn((ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms))),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: timers.delay }));

const T0 = Date.parse('2026-06-30T12:00:00.000Z');

interface StoredLease {
  unit: string;
  holder_id: string;
  kind: LeaseKind;
  acquired_at: Date;
}

/** In-memory `<schema>.unit_lease` with PostgreSQL's primary-key and rollback behaviour. */
class LeaseTable {
  rows = new Map<string, StoredLease>();
  readonly statements: string[] = [];
  readonly insertAttempts: string[][] = [];
  insertFailure: Error | undefined = undefined;

  constructor(readonly schema = 'migration') {}

  seed(unit: string, holderId: string, kind: LeaseKind, acquiredAt: number): void {
    this.rows.set(unit, { unit, holder_id: holderId, kind, acquired_at: new Date(acquiredAt) });
  }

  holderOf(unit: string): string | undefined {
    return this.rows.get(unit)?.holder_id;
  }

  db(): TenantDb {
    return {
      schema: this.schema,
      withTenant: () => Promise.reject(new Error('unit leases never run in a tenant transaction')),
      withMetadata: async <T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> => {
        const before = new Map(this.rows);
        const tx = {
          schema: this.schema,
          kind: 'metadata',
          onCommit: () => undefined,
          query: (text: unknown, values?: unknown[]) => Promise.resolve().then(() => this.run(String(text), values ?? [])),
        } as unknown as MetadataTx;
        try {
          return await fn(tx);
        } catch (error) {
          this.rows = before;
          throw error;
        }
      },
      end: () => Promise.resolve(),
    };
  }

  private run(text: string, values: unknown[]): QueryResult {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.statements.push(sql);
    const table = `${this.schema}.unit_lease`;
    const all = [...this.rows.values()];
    if (sql === `SELECT unit, holder_id, kind, acquired_at FROM ${table} WHERE holder_id = $1 AND unit = ANY($2::text[])`) {
      const [holder, units] = values as [string, string[]];
      return result(all.filter((row) => row.holder_id === holder && units.includes(row.unit)));
    }
    if (sql.startsWith(`INSERT INTO ${table} (unit, holder_id, kind, acquired_at) SELECT u.unit, $1::text, $2::text, $3::timestamp(3)`)) {
      const [holder, kind, at, units] = values as [string, LeaseKind, Date, string[]];
      this.insertAttempts.push([...units]);
      if (this.insertFailure !== undefined) throw this.insertFailure;
      const inserted = units.map((unit) => {
        if (this.rows.has(unit)) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "unit_lease_pkey"'), { code: '23505' });
        }
        const row = { unit, holder_id: holder, kind, acquired_at: new Date(at) };
        this.rows.set(unit, row);
        return row;
      });
      return result(inserted);
    }
    if (sql === `SELECT DISTINCT holder_id FROM ${table} WHERE unit = ANY($1::text[]) AND holder_id <> $2`) {
      const [units, holder] = values as [string[], string];
      const holders = new Set(all.filter((row) => units.includes(row.unit) && row.holder_id !== holder).map((row) => row.holder_id));
      return result([...holders].map((holder_id) => ({ holder_id })));
    }
    if (sql === `DELETE FROM ${table} WHERE holder_id = $1`) {
      const removed = all.filter((row) => row.holder_id === values[0]);
      for (const row of removed) this.rows.delete(row.unit);
      return result([], removed.length);
    }
    if (sql === `SELECT unit, holder_id, kind, acquired_at FROM ${table} WHERE holder_id = $1`) {
      return result(all.filter((row) => row.holder_id === values[0]));
    }
    if (sql === `SELECT unit, holder_id FROM ${table} WHERE unit = ANY($1::text[])`) {
      const units = values[0] as string[];
      return result(all.filter((row) => units.includes(row.unit)).map(({ unit, holder_id }) => ({ unit, holder_id })));
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

function result(rows: QueryResultRow[], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

/** Clock that moves only when a test sleeps. */
function manualClock(start = T0): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

function sleeper(clock: ReturnType<typeof manualClock>, onSleep: (call: number) => void = () => undefined) {
  let calls = 0;
  return vi.fn((ms: number) => {
    clock.advance(ms);
    calls += 1;
    onSleep(calls);
    return Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  timers.delay.mockClear();
});

describe('acquireLeases', () => {
  it('leases every requested unit in one sorted, deduplicated insert stamped with the clock', async () => {
    const table = new LeaseTable();
    const clock = manualClock();

    const leases = await acquireLeases(
      { db: table.db(), clock },
      { units: ['people.person', 'identity.account', 'people.person'], holderId: 'win-1', kind: 'window', budgetMs: 1000 },
    );

    expect(leases).toEqual([
      { unit: 'identity.account', holderId: 'win-1', kind: 'window', acquiredAt: new Date(T0) },
      { unit: 'people.person', holderId: 'win-1', kind: 'window', acquiredAt: new Date(T0) },
    ]);
    expect(table.insertAttempts).toEqual([['identity.account', 'people.person']]);
    expect(table.holderOf('identity.account')).toBe('win-1');
  });

  it('qualifies the lease table with the handle schema', async () => {
    const table = new LeaseTable('c64_run1');

    await acquireLeases({ db: table.db(), clock: manualClock() }, { units: ['content.file'], holderId: 'tr-1', kind: 'transition', budgetMs: 0 });

    expect(table.statements.length).toBeGreaterThan(0);
    expect(table.statements.every((sql) => sql.includes('c64_run1.unit_lease'))).toBe(true);
    expect(table.rows.get('content.file')?.kind).toBe('transition');
  });

  it('keeps leases the holder already has and inserts only the missing units', async () => {
    const table = new LeaseTable();
    table.seed('people.person', 'win-1', 'window', T0 - 60_000);

    const leases = await acquireLeases(
      { db: table.db(), clock: manualClock() },
      { units: ['people.person', 'identity.account'], holderId: 'win-1', kind: 'window', budgetMs: 0 },
    );

    expect(leases.map((lease) => [lease.unit, lease.acquiredAt.getTime()])).toEqual([
      ['identity.account', T0],
      ['people.person', T0 - 60_000],
    ]);
    expect(table.insertAttempts).toEqual([['identity.account']]);
  });

  it('returns the existing leases without inserting when the holder already has every unit', async () => {
    const table = new LeaseTable();
    table.seed('people.person', 'win-1', 'window', T0 - 5_000);
    table.seed('identity.account', 'win-1', 'window', T0 - 5_000);

    const leases = await acquireLeases(
      { db: table.db(), clock: manualClock() },
      { units: ['people.person', 'identity.account'], holderId: 'win-1', kind: 'window', budgetMs: 0 },
    );

    expect(leases.map((lease) => lease.unit)).toEqual(['identity.account', 'people.person']);
    expect(leases.every((lease) => lease.acquiredAt.getTime() === T0 - 5_000)).toBe(true);
    expect(table.insertAttempts).toEqual([]);
  });

  it('fails the whole insert when another holder owns one unit, leaving no partial lease', async () => {
    const table = new LeaseTable();
    table.seed('identity.account', 'tr-1', 'transition', T0);
    const clock = manualClock();
    const sleep = sleeper(clock);

    const error = await acquireLeases(
      { db: table.db(), clock },
      { units: ['people.person', 'identity.account', 'content.file'], holderId: 'win-1', kind: 'window', budgetMs: 0, sleep },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LeaseUnavailableError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({
      name: 'LeaseUnavailableError',
      message: 'Units content.file, identity.account, people.person are leased by tr-1; win-1 could not acquire them',
      units: ['content.file', 'identity.account', 'people.person'],
      holderId: 'win-1',
      conflictingHolders: ['tr-1'],
      surface: 'auto',
      reason: 'lease-unavailable',
    });
    expect(sleep).not.toHaveBeenCalled();
    expect([...table.rows.keys()]).toEqual(['identity.account']);
    expect(table.holderOf('identity.account')).toBe('tr-1');
  });

  it('lets windows on disjoint units hold leases concurrently while shared units exclude a transition', async () => {
    const table = new LeaseTable();
    const ctx = { db: table.db(), clock: manualClock() };
    await acquireLeases(ctx, { units: ['people.person'], holderId: 'win-1', kind: 'window', budgetMs: 0 });
    await acquireLeases(ctx, { units: ['content.file'], holderId: 'win-2', kind: 'window', budgetMs: 0 });

    await expect(
      acquireLeases(ctx, { units: ['people.person', 'identity.account'], holderId: 'tr-1', kind: 'transition', budgetMs: 0 }),
    ).rejects.toMatchObject({ conflictingHolders: ['win-1'] });

    expect(Object.fromEntries(await holdersOf(ctx, ['people.person', 'content.file', 'identity.account']))).toEqual({
      'people.person': 'win-1',
      'content.file': 'win-2',
    });
  });

  it('waits and retries until the other holder releases the unit', async () => {
    const table = new LeaseTable();
    table.seed('people.person', 'tr-1', 'transition', T0 - 1_000);
    const clock = manualClock();
    const sleep = sleeper(clock, (call) => {
      if (call === 2) table.rows.delete('people.person');
    });

    const leases = await acquireLeases(
      { db: table.db(), clock },
      { units: ['people.person'], holderId: 'win-1', kind: 'window', budgetMs: 1_000, sleep },
    );

    expect(sleep.mock.calls).toEqual([[LEASE_RETRY_INTERVAL_MS], [LEASE_RETRY_INTERVAL_MS]]);
    expect(table.insertAttempts).toHaveLength(3);
    expect(leases).toEqual([{ unit: 'people.person', holderId: 'win-1', kind: 'window', acquiredAt: new Date(T0 + 400) }]);
  });

  it('bounds each wait by the remaining budget, then reports every other holder sorted', async () => {
    const table = new LeaseTable();
    table.seed('people.person', 'win-9', 'window', T0);
    table.seed('content.file', 'win-9', 'window', T0);
    table.seed('identity.account', 'tr-2', 'transition', T0);
    const clock = manualClock();
    const sleep = sleeper(clock);

    await expect(
      acquireLeases(
        { db: table.db(), clock },
        { units: ['people.person', 'content.file', 'identity.account'], holderId: 'tr-3', kind: 'transition', budgetMs: 450, sleep },
      ),
    ).rejects.toMatchObject({ conflictingHolders: ['tr-2', 'win-9'], holderId: 'tr-3' });

    expect(LEASE_RETRY_INTERVAL_MS).toBe(200);
    expect(sleep.mock.calls).toEqual([[200], [200], [50]]);
    expect(table.insertAttempts).toHaveLength(4);
  });

  it('never lapses a lease with time; only its release frees the unit', async () => {
    const table = new LeaseTable();
    table.seed('people.person', 'win-old', 'window', T0 - 86_400_000);
    const ctx = { db: table.db(), clock: manualClock() };

    await expect(
      acquireLeases(ctx, { units: ['people.person'], holderId: 'win-new', kind: 'window', budgetMs: 0 }),
    ).rejects.toMatchObject({ conflictingHolders: ['win-old'] });
    expect(await releaseLeases(ctx, 'win-old')).toBe(1);

    await expect(
      acquireLeases(ctx, { units: ['people.person'], holderId: 'win-new', kind: 'window', budgetMs: 0 }),
    ).resolves.toEqual([{ unit: 'people.person', holderId: 'win-new', kind: 'window', acquiredAt: new Date(T0) }]);
  });

  it('propagates a database error other than a unique violation without retrying', async () => {
    const table = new LeaseTable();
    const failure = Object.assign(new Error('could not serialize access'), { code: '40001' });
    table.insertFailure = failure;
    const clock = manualClock();
    const sleep = sleeper(clock);

    await expect(
      acquireLeases({ db: table.db(), clock }, { units: ['people.person'], holderId: 'win-1', kind: 'window', budgetMs: 1_000, sleep }),
    ).rejects.toBe(failure);

    expect(sleep).not.toHaveBeenCalled();
    expect(table.rows.size).toBe(0);
  });

  it('waits on the timer between attempts when no sleep is injected', async () => {
    vi.useFakeTimers({ now: T0 });
    const table = new LeaseTable();
    table.seed('people.person', 'tr-1', 'transition', T0);
    let settled = false;

    const pending = acquireLeases(
      { db: table.db(), clock: systemClock },
      { units: ['people.person'], holderId: 'win-1', kind: 'window', budgetMs: 1_000 },
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(LEASE_RETRY_INTERVAL_MS - 1);
    expect(settled).toBe(false);
    expect(timers.delay.mock.calls).toEqual([[LEASE_RETRY_INTERVAL_MS]]);
    table.rows.delete('people.person');
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([
      { unit: 'people.person', holderId: 'win-1', kind: 'window', acquiredAt: new Date(T0 + LEASE_RETRY_INTERVAL_MS) },
    ]);
  });
});

describe('LeaseUnavailableError', () => {
  it('names another holder when no conflicting holder is known', () => {
    const error = new LeaseUnavailableError(['people.person'], 'win-1', []);

    expect(error.message).toBe('Units people.person are leased by another holder; win-1 could not acquire them');
    expect(error.conflictingHolders).toEqual([]);
  });
});

describe('releaseLeases', () => {
  it('deletes every lease of the holder and no other', async () => {
    const table = new LeaseTable();
    table.seed('people.person', 'win-1', 'window', T0);
    table.seed('identity.account', 'win-1', 'window', T0);
    table.seed('content.file', 'win-2', 'window', T0);

    expect(await releaseLeases({ db: table.db() }, 'win-1')).toBe(2);
    expect([...table.rows.keys()]).toEqual(['content.file']);
  });

  it('returns 0 when the holder has no lease', async () => {
    const table = new LeaseTable();
    table.seed('content.file', 'win-2', 'window', T0);

    expect(await releaseLeases({ db: table.db() }, 'win-1')).toBe(0);
    expect(table.holderOf('content.file')).toBe('win-2');
  });
});

describe('leasesOf', () => {
  it('lists the holder leases sorted by unit', async () => {
    const table = new LeaseTable();
    table.seed('people.person', 'tr-1', 'transition', T0);
    table.seed('content.file', 'win-2', 'window', T0);
    table.seed('identity.account', 'tr-1', 'transition', T0 - 1);

    expect(await leasesOf({ db: table.db() }, 'tr-1')).toEqual([
      { unit: 'identity.account', holderId: 'tr-1', kind: 'transition', acquiredAt: new Date(T0 - 1) },
      { unit: 'people.person', holderId: 'tr-1', kind: 'transition', acquiredAt: new Date(T0) },
    ]);
    expect(await leasesOf({ db: table.db() }, 'nobody')).toEqual([]);
  });
});

describe('holdersOf', () => {
  it('maps each leased unit to its holder and omits unleased units', async () => {
    const table = new LeaseTable();
    table.seed('people.person', 'tr-1', 'transition', T0);
    table.seed('content.file', 'win-2', 'window', T0);

    const holders = await holdersOf({ db: table.db() }, ['people.person', 'identity.account']);

    expect([...holders]).toEqual([['people.person', 'tr-1']]);
  });
});
