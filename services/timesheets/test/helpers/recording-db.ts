// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** A TenantDb that records the statements its tenant transactions run. */
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';

/** `db` with the text of each statement run in its tenant transactions appended to `seen`. */
export function recordingDb(db: TenantDb, seen: string[]): TenantDb {
  return {
    schema: db.schema,
    withTenant: (tenantId, fn) =>
      db.withTenant(tenantId, (tx) => {
        const query = ((text, values) => {
          seen.push(typeof text === 'string' ? text : text.text);
          return tx.query(text, values);
        }) as TenantTx['query'];
        return fn({ ...tx, query });
      }),
    withMetadata: (fn, options) => db.withMetadata(fn, options),
    end: () => db.end(),
  };
}

/** How many of `seen` read or write table `table` of any schema. */
export function statementsOn(seen: readonly string[], table: string): number {
  return seen.filter((text) => text.includes(`."${table}"`)).length;
}
