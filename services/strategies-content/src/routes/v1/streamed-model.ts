/** Admin view models sent as the JSON a returned object serialises to, their long lists written batch by batch. */
import { randomUUID } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { writeDrained } from '../../domain/forms.js';

/** The content type Fastify sends with a returned view model. */
export const VIEW_MODEL_CONTENT_TYPE = 'application/json; charset=utf-8';

/** The writer a streamed model's producer fills: the model once, then each list's batches in list order. */
export interface ModelStream<K extends string> {
  /** Sets the model, each list's slot value standing where its array prints; call once, before any batch. */
  head(build: (slots: Readonly<Record<K, string>>) => unknown): void;
  /** Writes one batch of `list`'s values, lists in their declared order; false once the reader has gone. */
  batch(list: K, values: readonly unknown[]): Promise<boolean>;
  /** Writes JSON text into `list`'s array as given, the producer separating its elements; otherwise as `batch`. */
  text(list: K, json: string): Promise<boolean>;
}

/** The JSON text of a pre-order walk's nodes, each node's last key holding the nodes one level below it. */
export interface NestedJson {
  /** The text closing the open nodes at `depth` or deeper, then opening `node`, whose own keys print first. */
  node(depth: number, node: object): string;
  /** The text closing every open node. */
  end(): string;
}

/** A {@link NestedJson} whose nodes hold the level below them under `key`, as `JSON.stringify` prints that key last. */
export function nestedJson(key: string): NestedJson {
  const below = `${JSON.stringify(key)}:[`;
  let open = 0;
  return {
    node(depth, node) {
      if (!Number.isSafeInteger(depth) || depth < 0 || depth > open) throw new RangeError(`A node at depth ${depth} cannot follow ${open} open nodes`);
      const json = JSON.stringify(node);
      const text = `${']}'.repeat(open - depth)}${depth < open ? ',' : ''}${json.slice(0, -1)}${json.length > 2 ? ',' : ''}${below}`;
      open = depth + 1;
      return text;
    },
    end() {
      const text = ']}'.repeat(open);
      open = 0;
      return text;
    },
  };
}

/** The model's JSON around each slot's quoted value: the text before the first list, between lists, and after the last. */
function jsonParts(json: string, markers: readonly string[]): string[] {
  const parts: string[] = [];
  let rest = json;
  for (const marker of markers) {
    const at = rest.indexOf(marker);
    if (at < 0 || rest.includes(marker, at + marker.length)) throw new Error('A streamed model must print each list slot once, in list order');
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + marker.length);
  }
  return [...parts, rest];
}

/** The `JSON.stringify` body of the model `produce` sets, resolved at its first batch; a later `produce` failure destroys it. */
export function streamModel<K extends string>(lists: readonly K[], produce: (out: ModelStream<K>) => Promise<void>): Promise<Readable> {
  const id = randomUUID();
  const slots = Object.fromEntries(lists.map((list, at) => [list, `opt2-streamed-list:${id}:${at}`])) as Record<K, string>;
  const body = new PassThrough({ highWaterMark: 0 });
  return new Promise<Readable>((resolve, reject) => {
    let parts: string[] | undefined;
    let pending = '';
    let current = 0;
    let open = false;
    let started = false;
    const start = (): void => {
      if (!started) {
        started = true;
        resolve(body);
      }
    };
    /** Closes every list before `target`, an unopened one as `[]`. */
    const advance = (target: number): void => {
      for (; current < target; current += 1) {
        pending += `${open ? ']' : '[]'}${parts?.[current + 1] ?? ''}`;
        open = false;
      }
    };
    /** Writes `json` into `list`'s array, opening it or putting `separator` after what it holds; nothing for no text. */
    const write = (list: K, json: string, separator: string): Promise<boolean> => {
      const target = lists.indexOf(list);
      if (parts === undefined || target < current) throw new Error('A streamed model writes its head, then its lists in order');
      advance(target);
      if (json === '') return Promise.resolve(!body.destroyed);
      const chunk = `${pending}${open ? separator : '['}${json}`;
      pending = '';
      open = true;
      const sent = writeDrained(body, chunk);
      start();
      return sent;
    };
    const out: ModelStream<K> = {
      head(build) {
        if (parts !== undefined) throw new Error('A streamed model has one head');
        parts = jsonParts(JSON.stringify(build(slots)), lists.map((list) => JSON.stringify(slots[list])));
        pending = parts[0] ?? '';
      },
      // An array prints an element that JSON cannot represent as null.
      batch: (list, values) => write(list, values.map((value) => JSON.stringify(value) ?? 'null').join(','), ','),
      text: (list, json) => write(list, json, ''),
    };
    produce(out)
      .then(() => {
        if (parts === undefined) throw new Error('A streamed model needs a head');
        advance(lists.length);
        if (!body.destroyed) body.end(pending);
        start();
      })
      .catch((error: Error) => {
        if (started) body.destroy(error);
        else reject(error);
      });
  });
}

/** Awaits `read` before a producer opens its cursor; the answer gives its value, or throws its error where the producer first needs it. */
export async function settled<T>(read: Promise<T>): Promise<() => T> {
  try {
    const value = await read;
    return () => value;
  } catch (error) {
    return () => {
      throw error;
    };
  }
}
