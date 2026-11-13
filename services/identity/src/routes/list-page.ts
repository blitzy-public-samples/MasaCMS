/** The `ListOffset` and `ListLimit` query parameters of the paged `/v1` listings, and the continuation each page answers. */
import type { ListPage } from '../repo/repository.js';

/** The largest `limit`, which is also its default. */
export const LIST_LIMIT = 1000;

/** `ListOffset` and `ListLimit` as the contract declares them; Fastify coerces, bounds and defaults them before the handler. */
export const LIST_PAGE_PROPERTIES = {
  offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
  limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT, default: LIST_LIMIT },
} as const;

/** The querystring of a listing that takes only the page parameters, beside the legacy `rc` fields it reads itself. */
export const LIST_PAGE_QUERY = { type: 'object', properties: LIST_PAGE_PROPERTIES } as const;

/** The `total` and `nextOffset` of a window of `returned` items at `page.offset` in a listing of `total`; `nextOffset` is null once the window ends the listing. */
export function continuation(page: ListPage, returned: number, total: number): { total: number; nextOffset: number | null } {
  const next = page.offset + returned;
  return { total, nextOffset: next < total ? next : null };
}
