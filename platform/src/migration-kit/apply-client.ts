/** Apply calls of `@opt2/platform/migration-kit`: one POST per batch, re-sent once when the owner left its committed events to the sweep. */
import { UNPUBLISHED_EVENTS_HEADER, type ServiceClient, type ServiceResponse } from '../service-kit/index.js';
import { MIGRATION_PATH_PREFIX, type ApplyRequest, type ApplyResponse } from './handlers.js';
import { WRITE_POSITION_HEADER_LC } from './write-position.js';

const APPLY_PATH = `${MIGRATION_PATH_PREFIX}/apply`;
const UNPUBLISHED_EVENTS_HEADER_LC = UNPUBLISHED_EVENTS_HEADER.toLowerCase();

/** Every value of the header `name` (lower-cased) in `headers`, whatever the case of its key. */
function headerValues(headers: ServiceResponse['headers'], name: string): string[] {
  return Object.entries(headers).flatMap(([key, value]) => (key.toLowerCase() === name ? [value].flat() : []));
}

function isPendingPublication(response: ServiceResponse): boolean {
  return response.status === 503 && headerValues(response.headers, UNPUBLISHED_EVENTS_HEADER_LC).length > 0;
}

/**
 * POSTs `body` to `service`'s apply endpoint without a user token. A 503 with {@link UNPUBLISHED_EVENTS_HEADER} means the batch committed and its
 * events await the outbox sweep: the batch is re-sent once and that answer returned with the first's write positions; all else passes unchanged.
 */
export async function postApply(
  client: Pick<ServiceClient, 'request'>,
  service: string,
  body: ApplyRequest,
): Promise<ServiceResponse<ApplyResponse>> {
  const send = (): Promise<ServiceResponse<ApplyResponse>> =>
    client.request<ApplyResponse>({ service, method: 'POST', path: APPLY_PATH, json: body, userToken: null });
  const first = await send();
  if (!isPendingPublication(first)) return first;
  const resent = await send();
  const committed = headerValues(first.headers, WRITE_POSITION_HEADER_LC);
  if (isPendingPublication(resent) || committed.length === 0) return resent;
  const headers = Object.fromEntries(Object.entries(resent.headers).filter(([key]) => key.toLowerCase() !== WRITE_POSITION_HEADER_LC));
  return { ...resent, headers: { ...headers, [WRITE_POSITION_HEADER_LC]: [...committed, ...headerValues(resent.headers, WRITE_POSITION_HEADER_LC)] } };
}
