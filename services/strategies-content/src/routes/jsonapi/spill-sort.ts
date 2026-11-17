/** A sort of more items than a memory budget holds: items past the budget spill to temporary files and merge back in order. */
import { createReadStream } from 'node:fs';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** Settings of {@link SpillSort}. */
export interface SpillSortOptions<T> {
  /** The items' order; it may raise. */
  readonly compare: (a: T, b: T) => number;
  /** One line of text without a line break, which `decode` reads back as the item. */
  readonly encode: (item: T) => string;
  readonly decode: (line: string) => T;
  /** The bytes an item held in memory takes, estimated. */
  readonly size: (item: T) => number;
  /** The estimated bytes of items held before they spill. */
  readonly budget: number;
}

/** A sorted run: a spilled file's items, or the held ones. */
type Run<T> = AsyncIterator<T> | Iterator<T>;

/** A sorted run's next item and the rest of the run. */
interface RunHead<T> {
  value: T;
  readonly rest: Run<T>;
}

const PUSHED = 'pushed.jsonl';

/** Items in push order, held up to a budget and spilled past it, then sorted once as Array.prototype.sort sorts them. */
export class SpillSort<T> {
  #held: T[] = [];
  #bytes = 0;
  #dir: string | undefined;

  constructor(private readonly options: SpillSortOptions<T>) {}

  /** Adds `item` after every item pushed before it. */
  push(item: T): void {
    this.#held.push(item);
    this.#bytes += this.options.size(item);
  }

  /** Spills the held items once they pass the budget. */
  async settle(): Promise<void> {
    if (this.#bytes <= this.options.budget) return;
    await appendFile(await this.#file(PUSHED), this.#text(this.#held), 'utf8');
    this.#held = [];
    this.#bytes = 0;
  }

  /**
   * Items `from` to `to` (exclusive) of the order Array.prototype.sort gives every pushed item in push order, raising what
   * that sort raises. With a `consistent` comparator, a strict total order, every comparison sort orders the items and
   * raises alike, so spilled items merge from sorted runs; any other comparator sorts every item in memory.
   */
  async window(from: number, to: number, consistent: boolean): Promise<T[]> {
    if (this.#dir === undefined || !consistent) {
      const items = this.#dir === undefined ? this.#held : await this.#pushed();
      this.#held = [];
      return items.sort(this.options.compare).slice(from, to);
    }
    return this.#merge(await this.#runs(), from, to);
  }

  /** Removes every spilled file. */
  async dispose(): Promise<void> {
    const dir = this.#dir;
    this.#dir = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }

  /** `name`'s path in the sort's temporary directory, created on first use. */
  async #file(name: string): Promise<string> {
    this.#dir ??= await mkdtemp(path.join(tmpdir(), 'opt2-feed-sort-'));
    return path.join(this.#dir, name);
  }

  #text(items: readonly T[]): string {
    return `${items.map((item) => this.options.encode(item)).join('\n')}\n`;
  }

  /** The items of a spilled file, in file order. */
  async *#read(file: string): AsyncGenerator<T, void, undefined> {
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) yield this.options.decode(line);
    } finally {
      lines.close();
      input.destroy();
    }
  }

  /** Every pushed item in push order. */
  async #pushed(): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this.#read(await this.#file(PUSHED))) items.push(item);
    for (const item of this.#held) items.push(item);
    return items;
  }

  /** The pushed items as sorted runs: budget-sized runs of the spilled ones, then the held ones. */
  async #runs(): Promise<Run<T>[]> {
    const { compare, size, budget } = this.options;
    const files: string[] = [];
    let chunk: T[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      const file = await this.#file(`run-${String(files.length)}.jsonl`);
      await writeFile(file, this.#text(chunk.sort(compare)), 'utf8');
      files.push(file);
      chunk = [];
      bytes = 0;
    };
    for await (const item of this.#read(await this.#file(PUSHED))) {
      chunk.push(item);
      bytes += size(item);
      if (bytes > budget) await flush();
    }
    if (chunk.length > 0) await flush();
    const held = this.#held.sort(compare);
    this.#held = [];
    return [...files.map((file) => this.#read(file)), held.values()];
  }

  /** Items `from` to `to` of the k-way merge of sorted `runs`, merged to their end so every comparison runs. */
  async #merge(runs: readonly Run<T>[], from: number, to: number): Promise<T[]> {
    const heap: RunHead<T>[] = [];
    const window: T[] = [];
    try {
      for (const rest of runs) {
        const next = await rest.next();
        if (next.done !== true) this.#up(heap, heap.push({ value: next.value, rest }) - 1);
      }
      for (let index = 0; heap.length > 0; index += 1) {
        const top = heap[0] as RunHead<T>;
        if (index >= from && index < to) window.push(top.value);
        const next = await top.rest.next();
        if (next.done !== true) top.value = next.value;
        else {
          const last = heap.pop() as RunHead<T>;
          if (heap.length === 0) break;
          heap[0] = last;
        }
        this.#down(heap, 0);
      }
      return window;
    } finally {
      for (const rest of runs) await rest.return?.();
    }
  }

  #less(a: RunHead<T>, b: RunHead<T>): boolean {
    return this.options.compare(a.value, b.value) < 0;
  }

  #up(heap: RunHead<T>[], at: number): void {
    let index = at;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.#less(heap[index] as RunHead<T>, heap[parent] as RunHead<T>)) return;
      [heap[index], heap[parent]] = [heap[parent] as RunHead<T>, heap[index] as RunHead<T>];
      index = parent;
    }
  }

  #down(heap: RunHead<T>[], at: number): void {
    let index = at;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let least = index;
      if (left < heap.length && this.#less(heap[left] as RunHead<T>, heap[least] as RunHead<T>)) least = left;
      if (right < heap.length && this.#less(heap[right] as RunHead<T>, heap[least] as RunHead<T>)) least = right;
      if (least === index) return;
      [heap[index], heap[least]] = [heap[least] as RunHead<T>, heap[index] as RunHead<T>];
      index = least;
    }
  }
}
