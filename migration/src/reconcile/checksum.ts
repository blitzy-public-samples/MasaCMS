/** One side's reconciliation checksum: keyless rows hashed as they arrive, keyed rows sorted through bounded spill runs. */
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareChecksumEntries, TableChecksum } from '@opt2/platform/migration-kit';
import type { ChecksumEntry } from '@opt2/platform/migration-kit';

import { DEFAULT_SORT_RUN_BYTES, mergeRuns, writeRecords } from '../extract/index.js';

const SPILL_PREFIX = 'opt2-reconcile-';
const NUL = '\u0000';
const ESCAPED_NUL = '\u0000\u0001';
const KEY_END = '\u0000\u0000';
// Most spill runs one merge reads at once; each holds a read buffer and its head record.
const MERGE_FAN_IN = 16;

/** How one side is measured; `sortRunBytes` bounds the keyed entries held in memory, `spillDir` parents the spill directory. */
export interface SideChecksumOptions {
  keyed: boolean;
  sortRunBytes?: number | undefined;
  spillDir?: string | undefined;
}

// NUL is escaped in the key and a NUL pair ends it, so `compareEncodings` orders records as `compareChecksumEntries` orders entries.
function spillRecord(entry: ChecksumEntry): string {
  return `${(entry.key ?? '').replaceAll(NUL, ESCAPED_NUL)}${KEY_END}${entry.row}`;
}

function spilledEntry(record: string): ChecksumEntry {
  const end = record.indexOf(KEY_END);
  return { key: record.slice(0, end).replaceAll(ESCAPED_NUL, NUL), row: record.slice(end + KEY_END.length) };
}

function* spillRecords(run: readonly ChecksumEntry[]): Generator<string, void, undefined> {
  for (const entry of run) yield spillRecord(entry);
}

/** Row count and SHA-256 of one side, equal to `tableChecksum` over its entries, without holding every row. */
export class SideChecksum {
  private readonly checksum = new TableChecksum();
  private readonly runLimit: number;
  private files: string[] = [];
  private merges = 0;
  private dir: string | undefined;
  private run: ChecksumEntry[] = [];
  private runBytes = 0;

  constructor(private readonly options: SideChecksumOptions) {
    this.runLimit = options.sortRunBytes ?? DEFAULT_SORT_RUN_BYTES;
  }

  /** Records one entry: keyless entries must arrive in `compareChecksumEntries` order, keyed entries in any order. */
  async add(entry: ChecksumEntry): Promise<void> {
    if (!this.options.keyed) {
      this.checksum.add(entry);
      return;
    }
    this.run.push(entry);
    this.runBytes += Buffer.byteLength(entry.key ?? '', 'utf8') + Buffer.byteLength(entry.row, 'utf8');
    if (this.runBytes >= this.runLimit) await this.spill();
  }

  /** The side's count and SHA-256; called once, after the last `add`. */
  async result(): Promise<{ count: number; sha256: string }> {
    if (this.files.length === 0) {
      this.run.sort(compareChecksumEntries);
      for (const entry of this.run) this.checksum.add(entry);
      this.run = [];
    } else {
      if (this.run.length > 0) await this.spill();
      await this.reduceRuns();
      for await (const record of mergeRuns(this.files)) this.checksum.add(spilledEntry(record));
    }
    return this.checksum.result();
  }

  /** Removes the spill directory, if one was created. */
  async dispose(): Promise<void> {
    const dir = this.dir;
    this.dir = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }

  /** Sorts the in-memory run and writes it to a new spill file. */
  private async spill(): Promise<void> {
    const file = await this.spillFile(`run-${String(this.files.length)}`);
    this.run.sort(compareChecksumEntries);
    await writeRecords(file, spillRecords(this.run));
    this.files.push(file);
    this.run = [];
    this.runBytes = 0;
  }

  /** Merges consecutive groups of at most `MERGE_FAN_IN` runs into new runs until no more than that many remain. */
  private async reduceRuns(): Promise<void> {
    while (this.files.length > MERGE_FAN_IN) {
      const reduced: string[] = [];
      for (let start = 0; start < this.files.length; start += MERGE_FAN_IN) {
        const group = this.files.slice(start, start + MERGE_FAN_IN);
        if (group.length === 1) {
          reduced.push(...group);
          continue;
        }
        const file = await this.spillFile(`merge-${String(this.merges)}`);
        this.merges += 1;
        await writeRecords(file, mergeRuns(group));
        await Promise.all(group.map((run) => rm(run)));
        reduced.push(file);
      }
      this.files = reduced;
    }
  }

  /** The path of a new file named `name` in the spill directory, which is created on first use. */
  private async spillFile(name: string): Promise<string> {
    this.dir ??= await mkdtemp(join(this.options.spillDir ?? tmpdir(), SPILL_PREFIX));
    return join(this.dir, name);
  }
}
