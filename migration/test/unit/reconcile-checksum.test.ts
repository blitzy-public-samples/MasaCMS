// Unit tests for one side's reconciliation checksum: tableChecksum equality in memory and through spill runs, and cleanup.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanonicalEncodingError, tableChecksum, type ChecksumEntry } from '@opt2/platform/migration-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SideChecksum } from '../../src/reconcile/checksum.js';

const fanIns = vi.hoisted((): number[] => []);

// The real merge, recording how many runs each call reads at once.
vi.mock('../../src/extract/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extract/index.js')>();
  return {
    ...actual,
    mergeRuns: (files: readonly string[]) => {
      fanIns.push(files.length);
      return actual.mergeRuns(files);
    },
  };
});

let spillDir: string;

beforeEach(async () => {
  fanIns.length = 0;
  spillDir = await mkdtemp(join(tmpdir(), 'reconcile-checksum-test-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(spillDir, { recursive: true, force: true });
});

async function measure(checksum: SideChecksum, entries: readonly ChecksumEntry[]): Promise<{ count: number; sha256: string }> {
  try {
    for (const entry of entries) await checksum.add(entry);
    return await checksum.result();
  } finally {
    await checksum.dispose();
  }
}

// Keys that are prefixes of one another or hold NUL and U+0001, rows that are prefixes of one another, and duplicates.
const KEYED: readonly ChecksumEntry[] = [
  { key: 'k1', row: 's1:a' },
  { key: 'k', row: 's1:b' },
  { key: 'k\u0000', row: 'x' },
  { key: 'k', row: 's1:a' },
  { key: 'k\u0000\u0001', row: 'y' },
  { key: '', row: 'z' },
  { key: 'k', row: 's1:ab' },
  { key: 'k\u0001', row: 'w' },
  { key: 'é', row: 'v' },
  { key: 'k', row: 's1:a' },
  { key: 'k\u0000\u0000', row: 'u' },
];

describe('SideChecksum', () => {
  it.each<{ label: string; sortRunBytes: number | undefined; runs: boolean }>([
    { label: 'in memory', sortRunBytes: undefined, runs: false },
    { label: 'with one entry per spill run', sortRunBytes: 1, runs: true },
    { label: 'with several entries per spill run', sortRunBytes: 16, runs: true },
  ])('equals tableChecksum over keyed entries in any order $label', async ({ sortRunBytes, runs }) => {
    const checksum = new SideChecksum({ keyed: true, sortRunBytes, spillDir });

    for (const entry of KEYED) await checksum.add(entry);
    const spilled = await readdir(spillDir);
    const result = await checksum.result();
    await checksum.dispose();

    expect(result).toStrictEqual(tableChecksum(KEYED));
    expect(result.count).toBe(KEYED.length);
    expect(spilled.length > 0).toBe(runs);
    expect(spilled.every((name) => name.startsWith('opt2-reconcile-'))).toBe(true);
    expect(await readdir(spillDir)).toEqual([]);
  });

  it.each<{ label: string; runs: number; fanIns: number[] }>([
    { label: 'exactly the fan-in in one merge', runs: 16, fanIns: [16] },
    { label: 'one over the fan-in, carrying the lone leftover run', runs: 17, fanIns: [16, 2] },
    { label: 'over the fan-in squared in two passes', runs: 300, fanIns: [...Array<number>(18).fill(16), 12, 16, 3, 2] },
  ])('merges $runs spill runs at most 16 at a time: $label', async ({ runs, fanIns: expected }) => {
    // Keys out of insertion and numeric order ('10' sorts before '9'); most entries occur twice.
    const entries = Array.from({ length: runs }, (_, i): ChecksumEntry => {
      const key = String(((i * 37) % runs) % Math.ceil(runs / 2));
      return { key, row: `r${key}` };
    });
    const checksum = new SideChecksum({ keyed: true, sortRunBytes: 1, spillDir });

    for (const entry of entries) await checksum.add(entry);
    const result = await checksum.result();
    const [side] = await readdir(spillDir);
    const remaining = await readdir(join(spillDir, side ?? ''));
    await checksum.dispose();

    expect(result).toStrictEqual(tableChecksum(entries));
    expect(fanIns).toEqual(expected);
    expect(remaining).toHaveLength(expected.at(-1) ?? 0);
    expect(await readdir(spillDir)).toEqual([]);
  });

  it.each<{ label: string; entries: ChecksumEntry[] }>([
    { label: 'no entries', entries: [] },
    { label: 'duplicates', entries: [{ row: 's1:a' }, { row: 's1:a' }, { row: 's1:b' }, { row: 's1:b' }, { row: 's1:b' }] },
  ])('hashes keyless $label as they arrive without spilling', async ({ entries }) => {
    const result = await measure(new SideChecksum({ keyed: false, sortRunBytes: 1, spillDir }), entries);

    expect(result).toStrictEqual(tableChecksum(entries));
    expect(await readdir(spillDir)).toEqual([]);
  });

  it('rejects keyless entries out of row order', async () => {
    const checksum = new SideChecksum({ keyed: false });

    await expect(measure(checksum, [{ row: 's1:b' }, { row: 's1:a' }])).rejects.toBeInstanceOf(CanonicalEncodingError);
  });

  it('spills under the OS temporary directory by default and removes it on every dispose', async () => {
    vi.stubEnv('TMPDIR', spillDir);
    const checksum = new SideChecksum({ keyed: true, sortRunBytes: 1 });

    await checksum.add({ key: 'k', row: 'r' });
    const created = await readdir(spillDir);
    await checksum.dispose();
    await checksum.dispose();

    expect(created).toHaveLength(1);
    expect(created[0]?.startsWith('opt2-reconcile-')).toBe(true);
    expect(await readdir(spillDir)).toEqual([]);
  });
});
