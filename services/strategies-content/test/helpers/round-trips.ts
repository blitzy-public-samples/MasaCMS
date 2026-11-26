/** Counts the transactions a TenantDb opens and the statements its pool runs, for round-trip assertions. */
import type { TenantDb } from '@opt2/platform/tenancy';
import type { ThrowawaySchema } from '@opt2/platform/testing';

/** Transactions opened through the counted TenantDb and statements its pool's connections ran, BEGIN and COMMIT included. */
export interface RoundTrips {
  transactions: number;
  statements: number;
}

/** A TenantDb over `handle.app` whose transactions and pool statements `measure` counts while `fn` runs. */
export interface RoundTripCounter {
  db: TenantDb;
  measure(fn: () => Promise<unknown>): Promise<RoundTrips>;
}

/** Wraps `handle`'s app TenantDb and pool once per suite; counts are taken only inside `measure`. */
export function roundTripCounter(handle: ThrowawaySchema): RoundTripCounter {
  const counts: RoundTrips = { transactions: 0, statements: 0 };
  const counted = new WeakSet<object>();
  handle.appPool.on('acquire', (client) => {
    if (counted.has(client)) return;
    counted.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    Object.defineProperty(client, 'query', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        counts.statements += 1;
        return query(...args);
      },
    });
  });
  const app = handle.app;
  const db: TenantDb = {
    ...app,
    withTenant: (tenantId, fn, options) => {
      counts.transactions += 1;
      return app.withTenant(tenantId, fn, options);
    },
    withMetadata: (fn, options) => {
      counts.transactions += 1;
      return app.withMetadata(fn, options);
    },
  };
  return {
    db,
    measure: async (fn) => {
      counts.transactions = 0;
      counts.statements = 0;
      await fn();
      return { ...counts };
    },
  };
}
