/** Bounded external sort of one unit table's canonical rows by tenant, then `compareCanonicalRows`, read tenant by tenant. */
import { Buffer } from 'node:buffer';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeRow, type CanonicalColumn } from '@opt2/platform/migration-kit';

import { DEFAULT_SORT_RUN_BYTES, compareCanonicalRows, writeRecords, type CanonicalRow, type KeyValue } from '../extract/index.js';
import { RunReader } from '../extract/stream.js';
import type { UnitTableShape } from './legacy-side.js';

const SPILL_PREFIX = 'opt2-reconcile-rows-';
// JSON never emits a raw line feed, so the first one ends a record's header.
const HEADER_END = '\n';
// Bounds of the spill runs one merge reads at once; each holds a read buffer and its head record.
const MIN_FAN_IN = 2;
const MAX_FAN_IN = 16;

/** Memory and spill location of a {@link UnitRowSorter}. */
export interface UnitRowSorterOptions {
  /** Bytes of framed row records sorted in memory before the run spills to disk; defaults to 64 MiB. */
  sortRunBytes?: number | undefined;
  /** Parent of the spill directory; defaults to the OS temporary directory. */
  spillDir?: string | undefined;
}

/** Rebuilds a row from its canonical encoding and program id, as the side that added it built it. */
export type UnitRowBuilder = (encoding: string, legacyProgramId: number | undefined) => CanonicalRow;

/** What the sorter keeps of a row: its tenant, what orders it, and its encoding. */
interface Entry {
  tenantId: string;
  legacyProgramId?: number;
  keyValues: readonly KeyValue[];
  encoding: string;
}

/** The head record of one spill run during a merge; `run` breaks ties, so merging keeps the input order of equal rows. */
interface Head {
  entry: Entry;
  record: string;
  reader: RunReader;
  run: number;
}

/** Tenant order of `sortedUnion`: UTF-16 code units. */
function compareTenants(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEntries(a: Entry, b: Entry): number {
  return compareTenants(a.tenantId, b.tenantId) || compareCanonicalRows(a, b);
}

function compareHeads(a: Head, b: Head): number {
  return compareEntries(a.entry, b.entry) || a.run - b.run;
}

function headerOf(entry: Entry): string {
  return `${JSON.stringify([entry.tenantId, entry.legacyProgramId ?? null])}${HEADER_END}`;
}

function recordOf(entry: Entry): string {
  return `${headerOf(entry)}${entry.encoding}`;
}

function* recordsOf(entries: readonly Entry[]): Generator<string, void, undefined> {
  for (const entry of entries) yield recordOf(entry);
}

/** K-way merge of sorted spill runs in entry order, each run read sequentially. */
class RunMerge {
  private readonly heap: Head[] = [];
  private closed = false;

  private constructor(
    private readonly readers: readonly RunReader[],
    private readonly parse: (record: string) => Entry,
  ) {}

  /** Opens every run of `files` and reads its first record; handles opened before a failure are closed. */
  static async open(files: readonly string[], parse: (record: string) => Entry): Promise<RunMerge> {
    const readers: RunReader[] = [];
    try {
      for (const file of files) readers.push(new RunReader(file, await open(file, 'r')));
      const merge = new RunMerge(readers, parse);
      for (const [run, reader] of readers.entries()) await merge.refill(reader, run);
      return merge;
    } catch (error) {
      await Promise.allSettled(readers.map((reader) => reader.close()));
      throw error;
    }
  }

  /** The least head of all runs, or undefined once every run is read. */
  async next(): Promise<Head | undefined> {
    const top = this.pop();
    if (top !== undefined) await this.refill(top.reader, top.run);
    return top;
  }

  /** Closes every run; later calls do nothing. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.readers.map((reader) => reader.close()));
  }

  private async refill(reader: RunReader, run: number): Promise<void> {
    const record = await reader.next();
    if (record !== undefined) this.push({ entry: this.parse(record), record, reader, run });
  }

  private push(head: Head): void {
    const heap = this.heap;
    let index = heap.length;
    heap.push(head);
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = heap[parentIndex] as Head;
      if (compareHeads(parent, head) <= 0) break;
      heap[index] = parent;
      index = parentIndex;
    }
    heap[index] = head;
  }

  private pop(): Head | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined || heap.length === 0) return top;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && compareHeads(heap[right] as Head, heap[left] as Head) < 0 ? right : left;
      const candidate = heap[child] as Head;
      if (compareHeads(last, candidate) <= 0) break;
      heap[index] = candidate;
      index = child;
    }
    heap[index] = last;
    return top;
  }
}

async function* mergedRecords(merge: RunMerge): AsyncGenerator<string, void, undefined> {
  for (let head = await merge.next(); head !== undefined; head = await merge.next()) yield head.record;
}

/** Sorts unit rows by tenant and canonical key through byte-bounded runs and a 2–16-way merge. */
export class UnitRowSorter {
  private readonly runLimit: number;
  private readonly keyNames: readonly string[];
  private readonly columns: readonly CanonicalColumn[];
  private readonly counts = new Map<string, number>();
  private state: 'adding' | 'sorted' | 'disposed' = 'adding';
  private run: Entry[] = [];
  private runBytes = 0;
  private largestRow = 0;
  private files: string[] = [];
  private merges = 0;
  private dir: string | undefined;
  private sorted: (Entry | undefined)[] = [];
  private next = 0;
  private merge: RunMerge | undefined;
  private head: Entry | undefined;
  private exhausted = false;
  private lastTenant: string | undefined;

  /** @throws Error when a key column of `shape` is not among its columns. */
  constructor(
    shape: Pick<UnitTableShape, 'keyed' | 'keyColumns' | 'columns'>,
    private readonly build: UnitRowBuilder,
    private readonly options: UnitRowSorterOptions = {},
  ) {
    this.runLimit = options.sortRunBytes ?? DEFAULT_SORT_RUN_BYTES;
    this.keyNames = shape.keyed ? [...shape.keyColumns] : [];
    this.columns = shape.columns;
    for (const name of this.keyNames) {
      if (!this.columns.some((column) => column.name === name)) throw new Error(`key column ${name} is not among the columns of the shape`);
    }
  }

  /** Adds `row` under `tenantId`; awaited before the next call, as a full run is spilled first. */
  async add(tenantId: string, row: CanonicalRow): Promise<void> {
    if (this.state !== 'adding') throw new Error(`rows cannot be added to a ${this.state} sorter`);
    const entry: Entry = { tenantId, keyValues: row.keyValues, encoding: row.encoding };
    if (row.legacyProgramId !== undefined) entry.legacyProgramId = row.legacyProgramId;
    this.run.push(entry);
    this.counts.set(tenantId, (this.counts.get(tenantId) ?? 0) + 1);
    const bytes = Buffer.byteLength(headerOf(entry), 'utf8') + Buffer.byteLength(row.encoding, 'utf8');
    this.runBytes += bytes;
    this.largestRow = Math.max(this.largestRow, bytes);
    if (this.runBytes >= this.runLimit) await this.spill();
  }

  /** Ends the input: sorts the rows held in memory, or spills them and merges the runs down to one merge's fan-in. */
  async sort(): Promise<void> {
    if (this.state !== 'adding') throw new Error(`a ${this.state} sorter cannot be sorted`);
    this.state = 'sorted';
    if (this.files.length === 0) {
      this.sorted = this.run.sort(compareEntries);
      this.run = [];
      return;
    }
    if (this.run.length > 0) await this.spill();
    await this.reduceRuns();
  }

  /** Tenants holding rows, in reading order. */
  tenants(): string[] {
    return [...this.counts.keys()].sort(compareTenants);
  }

  /** Rows added under `tenantId`. */
  count(tenantId: string): number {
    return this.counts.get(tenantId) ?? 0;
  }

  /** Reads one tenant in canonical order; ascending tenant requests retain later rows, but errors or early returns dispose them. */
  async *rows(tenantId: string): AsyncGenerator<CanonicalRow, void, undefined> {
    if (this.state !== 'sorted') throw new Error(`rows cannot be read from ${this.state === 'adding' ? 'an unsorted' : 'a disposed'} sorter`);
    let completed = false;
    try {
      if (this.lastTenant !== undefined && compareTenants(tenantId, this.lastTenant) < 0) {
        throw new Error(`tenant ${tenantId} is read after tenant ${this.lastTenant}`);
      }
      this.lastTenant = tenantId;
      for (let entry = await this.peek(); entry !== undefined && compareTenants(entry.tenantId, tenantId) <= 0; entry = await this.peek()) {
        this.head = undefined;
        if (entry.tenantId === tenantId) yield this.build(entry.encoding, entry.legacyProgramId);
      }
      completed = true;
    } finally {
      if (!completed) await this.dispose();
    }
  }

  /** Drops every row and removes the spill directory, whether or not the rows were read; later calls do nothing. */
  async dispose(): Promise<void> {
    this.state = 'disposed';
    await this.release();
  }

  /** The next entry in reading order without consuming it; the merge opens on first use and is released when it ends. */
  private async peek(): Promise<Entry | undefined> {
    if (this.head !== undefined || this.exhausted) return this.head;
    if (this.files.length === 0) {
      this.head = this.sorted[this.next];
      this.sorted[this.next] = undefined;
      this.next += 1;
    } else {
      try {
        this.merge ??= await RunMerge.open(this.files, (record) => this.parse(record));
        this.head = (await this.merge.next())?.entry;
      } catch (error) {
        await this.dispose();
        throw error;
      }
    }
    if (this.head === undefined) {
      this.exhausted = true;
      await this.release();
    }
    return this.head;
  }

  private async release(): Promise<void> {
    this.run = [];
    this.sorted = [];
    this.head = undefined;
    const merge = this.merge;
    const dir = this.dir;
    this.merge = undefined;
    this.dir = undefined;
    try {
      await merge?.close();
    } finally {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  }

  private parse(record: string): Entry {
    const end = record.indexOf(HEADER_END);
    const [tenantId, legacyProgramId] = JSON.parse(record.slice(0, end)) as [string, number | null];
    const encoding = record.slice(end + HEADER_END.length);
    const entry: Entry = { tenantId, keyValues: this.keyNames.length === 0 ? [] : this.keyValuesOf(encoding), encoding };
    if (legacyProgramId !== null) entry.legacyProgramId = legacyProgramId;
    return entry;
  }

  /** Key values decoded from the row in key order, as `toUnitRow` takes them. */
  private keyValuesOf(encoding: string): KeyValue[] {
    const values = decodeRow(this.columns, encoding);
    return this.keyNames.map((name) => values[name] ?? null);
  }

  /** Sorts the in-memory run and writes it to a new spill file. */
  private async spill(): Promise<void> {
    const file = await this.spillFile(`run-${String(this.files.length)}`);
    this.run.sort(compareEntries);
    await writeRecords(file, recordsOf(this.run));
    this.files.push(file);
    this.run = [];
    this.runBytes = 0;
  }

  /** Merges consecutive groups of at most the fan-in's runs into new runs until no more than that many remain. */
  private async reduceRuns(): Promise<void> {
    // As many runs as `sortRunBytes` holds head rows of the largest size, within the fan-in bounds.
    const fanIn = Math.max(MIN_FAN_IN, Math.min(MAX_FAN_IN, Math.floor(this.runLimit / Math.max(this.largestRow, 1))));
    while (this.files.length > fanIn) {
      const reduced: string[] = [];
      for (let start = 0; start < this.files.length; start += fanIn) {
        const group = this.files.slice(start, start + fanIn);
        if (group.length === 1) {
          reduced.push(...group);
          continue;
        }
        const file = await this.spillFile(`merge-${String(this.merges)}`);
        this.merges += 1;
        const merge = await RunMerge.open(group, (record) => this.parse(record));
        try {
          await writeRecords(file, mergedRecords(merge));
        } finally {
          await merge.close();
        }
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
