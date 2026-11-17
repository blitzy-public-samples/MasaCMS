import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

/** The content type Fastify gives a JSON object reply, for a reply that streams its JSON body. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

type Resume = ReturnType<typeof AsyncLocalStorage.snapshot>;

/** The chunks of the shell `prefix` + `[` + every batch's items + `]` + `suffix`, each batch pulled in the context `resume` restores. */
async function* jsonListChunks(
  prefix: string,
  suffix: string,
  batches: AsyncIterable<readonly unknown[]>,
  resume: Resume,
): AsyncGenerator<string> {
  const iterator = batches[Symbol.asyncIterator]();
  let drained = false;
  try {
    yield `${prefix}[`;
    let separator = '';
    for (;;) {
      const step = await resume(() => iterator.next());
      if (step.done === true) break;
      // A batch serialized as an array keeps JSON.stringify's element rules, such as undefined written as null.
      const items = JSON.stringify(step.value).slice(1, -1);
      if (items !== '') {
        yield `${separator}${items}`;
        separator = ',';
      }
    }
    drained = true;
    yield `]${suffix}`;
  } finally {
    if (!drained) await resume(() => iterator.return?.());
  }
}

/** Streams the bytes of `JSON.stringify({ ...head, [key]: items, ...tail })`, pulling each batch of `items` only when wanted, in the creating async context. */
export function jsonListStream(
  head: Readonly<Record<string, unknown>>,
  key: string,
  batches: AsyncIterable<readonly unknown[]>,
  tail: Readonly<Record<string, unknown>> = {},
): Readable {
  const slot: unknown[] = [];
  const marker = `opt2-json-list-${randomUUID()}`;
  const shell = JSON.stringify({ ...head, [key]: slot, ...tail }, (_name, value: unknown) => (value === slot ? marker : value));
  const parts = shell.split(JSON.stringify(marker));
  if (parts.length !== 2) {
    throw new TypeError(`The list member ${JSON.stringify(key)} is replaced by tail`);
  }
  const [prefix = '', suffix = ''] = parts;
  return Readable.from(jsonListChunks(prefix, suffix, batches, AsyncLocalStorage.snapshot()), { objectMode: false });
}
