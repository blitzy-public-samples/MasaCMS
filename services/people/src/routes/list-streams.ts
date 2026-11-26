// JSON bodies of the `/v1` cUsers lists that answer every row, written batch by batch as the rows are read.
import { Readable } from 'node:stream';
import { serializeError } from '@opt2/platform/logging';
import { RequestAbortedError, throwIfRequestAborted, type FastifyReply } from '@opt2/platform/service-kit';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** `values` in order, in arrays of at most `size`; none is empty. */
export async function* batchesOf<T>(values: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let batch: T[] = [];
  for await (const value of values) {
    batch.push(value);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** The text of `{"items":[…],…}`: each batch's items as it is read, then the members `tail` gives for the item count. */
export async function* listBody(
  batches: AsyncIterable<readonly unknown[]>,
  tail: (count: number) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>,
): AsyncGenerator<string> {
  let count = 0;
  for await (const batch of batches) {
    // An empty batch writes nothing, so the first written item still opens the array.
    if (batch.length === 0) continue;
    const items = batch.map((item) => JSON.stringify(item)).join(',');
    yield count === 0 ? `{"items":[${items}` : `,${items}`;
    count += batch.length;
  }
  const members = Object.entries(await tail(count)).map(([key, value]) => `,${JSON.stringify(key)}:${JSON.stringify(value)}`);
  yield `${count === 0 ? '{"items":[' : ''}]${members.join('')}}`;
}

/** `first`, then the rest of `chunks`; a failure there is logged unless the client left, and cuts the body short. */
async function* sentChunks(reply: FastifyReply, first: IteratorResult<string, void>, chunks: AsyncGenerator<string>): AsyncGenerator<string> {
  if (first.done === true) return;
  yield first.value;
  try {
    yield* chunks;
  } catch (error) {
    if (!(error instanceof RequestAbortedError)) reply.log.error({ error: serializeError(error) }, 'list stream failed');
    throw error;
  }
}

/**
 * Answers 200 with the JSON text of `chunks`, read as the body is sent. The first chunk is read before the status line, so its
 * failure answers the error response and a client gone by then abandons the read; a later failure aborts the body.
 */
export async function sendJsonStream(reply: FastifyReply, chunks: AsyncGenerator<string>): Promise<FastifyReply> {
  const first = await chunks.next();
  try {
    throwIfRequestAborted();
  } catch (error) {
    await chunks.return(undefined);
    throw error;
  }
  // One chunk waits unread at most, so a slow client holds back the reads.
  const body = Readable.from(sentChunks(reply, first, chunks), { highWaterMark: 1 });
  return reply.code(200).type(JSON_CONTENT_TYPE).send(body);
}
