// ColdFusion 2023 struct key order: a ConcurrentHashMap of upper-cased names, 16 bins, resized at 0.75 load.

/** One struct mutation in program order: a key assigned or `structDelete`d. */
export type StructOp = readonly ['set' | 'delete', string];

type Bin = Array<readonly [key: string, hash: number]>;

/** Java String.hashCode. */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** ConcurrentHashMap.transfer for one thread: each bin splits into its low and high halves. */
function transfer(bins: readonly Bin[], n: number): Bin[] {
  const next: Bin[] = Array.from({ length: n * 2 }, () => []);
  bins.forEach((bin, i) => {
    const first = bin[0];
    if (first === undefined) return;
    // The trailing run of nodes bound for one half moves as is; the nodes before it are prepended in turn.
    let runBit = first[1] & n;
    let lastRun = 0;
    bin.forEach(([, hash], p) => {
      if ((hash & n) !== runBit) {
        runBit = hash & n;
        lastRun = p;
      }
    });
    let low: Bin = runBit === 0 ? bin.slice(lastRun) : [];
    let high: Bin = runBit === 0 ? [] : bin.slice(lastRun);
    for (const node of bin.slice(0, lastRun)) {
      if ((node[1] & n) === 0) low = [node, ...low];
      else high = [node, ...high];
    }
    next[i] = low;
    next[i + n] = high;
  });
  return next;
}

/** Iteration order of the keys `ops` leaves, each spelled as first assigned; a re-assigned key keeps its place. */
export function acfKeyOrder(ops: readonly StructOp[]): string[] {
  let size = 16;
  let count = 0;
  let bins: Bin[] = Array.from({ length: size }, () => []);
  for (const [op, key] of ops) {
    const upper = key.toUpperCase();
    const h = javaHash(upper);
    const hash = (h ^ (h >>> 16)) & 0x7fffffff;
    const bin = bins[hash & (size - 1)] as Bin;
    const at = bin.findIndex(([name]) => name.toUpperCase() === upper);
    if (op === 'delete') {
      if (at >= 0) {
        bin.splice(at, 1);
        count -= 1;
      }
    } else if (at < 0) {
      bin.push([key, hash]);
      count += 1;
      if (count >= size - (size >>> 2)) {
        bins = transfer(bins, size);
        size *= 2;
      }
    }
  }
  return bins.flat().map(([key]) => key);
}
