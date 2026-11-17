// `CutoverStatus` and `CutoverStatusV2` read in keyset pages: collected whole for in-process callers, or streamed as JSON text in bounded memory.
import type { components } from '../generated/openapi.js';

type CutoverStatus = components['schemas']['CutoverStatus'];

/** One in-flight item of `CutoverStatus`; a `CutoverStatusV2` item adds `orphaned`. */
type InflightItem = CutoverStatus['inflight'][number];

/** `CutoverStatus` whose in-flight items are `I`; `CutoverStatusV2` when they carry `orphaned`. */
export type CutoverStatusOf<I extends InflightItem> = Omit<CutoverStatus, 'inflight'> & { inflight: I[] };

/** Media type of a streamed status, as Fastify answers a JSON object. */
export const STATUS_CONTENT_TYPE = 'application/json; charset=utf-8';

/** A status with its two unbounded lists read a page at a time as they are iterated; each list is iterated once. */
export interface CutoverStatusPages<I extends InflightItem = InflightItem> {
  head: Omit<CutoverStatus, 'instances' | 'inflight'>;
  instances: AsyncIterable<CutoverStatus['instances']>;
  inflight: AsyncIterable<I[]>;
}

async function collect<T>(pages: AsyncIterable<readonly T[]>): Promise<T[]> {
  const items: T[] = [];
  for await (const page of pages) items.push(...page);
  return items;
}

/** Every page of `pages` as one status, in the contract's field order. */
export async function collectStatus<I extends InflightItem>({
  head,
  instances,
  inflight,
}: CutoverStatusPages<I>): Promise<CutoverStatusOf<I>> {
  const { tableVersion, previous, epoch, groupAuthority, frozen, acknowledgedEpoch, sessionMode } = head;
  return {
    tableVersion,
    previous,
    epoch,
    groupAuthority,
    frozen,
    instances: await collect(instances),
    acknowledgedEpoch,
    inflight: await collect(inflight),
    sessionMode,
  };
}

/** A JSON array's items, one chunk per non-empty page. */
async function* jsonItems(pages: AsyncIterable<readonly unknown[]>): AsyncGenerator<string> {
  let first = true;
  for await (const page of pages) {
    if (page.length === 0) continue;
    yield `${first ? '' : ','}${page.map((item) => JSON.stringify(item)).join(',')}`;
    first = false;
  }
}

/** `JSON.stringify(await collectStatus(pages))` as text chunks, holding at most one page at a time. */
export async function* statusJson({ head, instances, inflight }: CutoverStatusPages): AsyncGenerator<string> {
  const { tableVersion, previous, epoch, groupAuthority, frozen, acknowledgedEpoch, sessionMode } = head;
  const opening = JSON.stringify({ tableVersion, previous, epoch, groupAuthority, frozen });
  yield `${opening.slice(0, -1)},"instances":[`;
  yield* jsonItems(instances);
  yield `],"acknowledgedEpoch":${JSON.stringify(acknowledgedEpoch)},"inflight":[`;
  yield* jsonItems(inflight);
  yield `],"sessionMode":${JSON.stringify(sessionMode)}}`;
}
