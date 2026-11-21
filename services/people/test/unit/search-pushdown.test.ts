/** pageHold's bounded hold of a long stream, held to the page pageRows shows. */
import { describe, expect, it } from 'vitest';
import { pageHold, pageRows, type UsersPaging } from '../../src/domain/search.js';

describe('pageHold', () => {
  const values = Array.from({ length: 100_000 }, (_, index) => index);

  it.each<UsersPaging>([
    { startRow: 1000, recordsPerPage: 7 },
    { startRow: 14_286, recordsPerPage: 7 },
    { startRow: 14_287, recordsPerPage: 7 },
    { startRow: 90_000, recordsPerPage: 1 },
    { startRow: 200_000, recordsPerPage: 3 },
    { startRow: 0, recordsPerPage: 0 },
    { startRow: 2.5, recordsPerPage: 10 },
    { startRow: 1.5, recordsPerPage: 4.5 },
    {},
  ])('holds at most two pages of a long stream and shows the page pageRows shows for %o', (paging) => {
    const hold = pageHold<number>(paging);
    const perPage = paging.recordsPerPage !== undefined && paging.recordsPerPage >= 1 ? paging.recordsPerPage : 25;
    let most = 0;
    for (const value of values) {
      hold.offer(value);
      most = Math.max(most, hold.held);
    }
    expect(most).toBeLessThanOrEqual(2 * Math.ceil(perPage));
    expect(hold.count).toBe(values.length);
    expect(hold.page()).toEqual(pageRows(values, paging));
  });
});
