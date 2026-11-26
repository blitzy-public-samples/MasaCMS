/** Reads a JSON API feed source's scope whole, as tests compare it with the in-memory evaluator's rows. */
import type { BeanFeedSource } from '../../src/repo/bean-feed-sql.js';

/** Every row of `source`'s scope in scan order, holding the columns its rows return. */
export async function scopeRows<R>(source: BeanFeedSource<R>): Promise<R[]> {
  const rows: R[] = [];
  await source.scan({ columns: [], rows: true }, (batch) => {
    for (const row of batch) rows.push(row);
    return true;
  });
  return rows;
}
