// Inbound header stripping of @opt2/platform/auth: clients reach the gateway with credentials, never with invocation credentials or internal X-Opt2-* headers.
import { INVOCATION_HEADER } from './invocation.js';

/** Lower-cased name prefix of internal OPT-2 headers, which no client may send through the gateway. */
export const OPT2_HEADER_PREFIX = 'x-opt2-';

/** Request header map, assignable from Node `IncomingHttpHeaders` and Fastify `request.headers`. */
export type HeaderMap = Record<string, string | string[] | undefined>;

const AUTHORIZATION_HEADER = 'authorization';

/** New header map without the invocation credential, `X-Opt2-*` headers and, once exchanged for a user token, `Authorization`. */
export function stripInboundAuthHeaders(headers: HeaderMap, opts: { afterExchange: boolean }): HeaderMap {
  // Object.fromEntries defines own properties, so a client header named `__proto__` cannot reach the prototype.
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return !(
        lower === INVOCATION_HEADER ||
        lower.startsWith(OPT2_HEADER_PREFIX) ||
        (opts.afterExchange && lower === AUTHORIZATION_HEADER)
      );
    }),
  );
}
