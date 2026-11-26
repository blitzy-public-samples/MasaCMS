// SQL Server's in-memory Sort is not stable: rows of equal key leave it in an order set by its input order.

/**
 * `rows`, given in the Sort operator's input order, in the order SQL Server 2022's Sort returns them under `compare`:
 * maximal non-descending runs merged left to right, each merge taking from the side it last took from while that side's
 * next row is not greater, and starting on the right run when its length has more bits than the left's.
 * Measured exact for up to two runs, which an address list with at most one primary always is.
 */
export function sqlServerSortOrder<T>(rows: readonly T[], compare: (a: T, b: T) => number): T[] {
  const runs: T[][] = [];
  for (const row of rows) {
    const run = runs[runs.length - 1];
    if (run !== undefined && compare(run[run.length - 1] as T, row) <= 0) run.push(row);
    else runs.push([row]);
  }
  return runs.reduce<T[]>((merged, run) => mergeRuns(merged, run, compare), []);
}

/** One merge of adjacent runs `left` and `right`, as {@link sqlServerSortOrder} describes it. */
function mergeRuns<T>(left: readonly T[], right: readonly T[], compare: (a: T, b: T) => number): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  // Math.clz32 counts leading zero bits, so a smaller count means a longer bit length.
  let fromLeft = Math.clz32(left.length) <= Math.clz32(right.length);
  while (i < left.length && j < right.length) {
    const a = left[i] as T;
    const b = right[j] as T;
    if (fromLeft) {
      if (compare(a, b) <= 0) {
        out.push(a);
        i += 1;
      } else fromLeft = false;
    } else if (compare(b, a) <= 0) {
      out.push(b);
      j += 1;
    } else fromLeft = true;
  }
  return out.concat(left.slice(i), right.slice(j));
}
