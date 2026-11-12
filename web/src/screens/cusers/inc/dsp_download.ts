// Users CSV of `cusers/inc/dsp_download.cfm`: the owning service builds the file; web relays its bytes (server-only).
import type { GatewayResponse } from '@/lib/gateway-client';
import { HTML_CONTENT_TYPE } from '@/lib/responses';
import type { RawBody } from '../../registry';

/** The service list a users CSV comes from; plain JSON, as it travels in the FW/1 flash context. */
export type UsersCsvSource =
  | { source: 'group-members'; groupId: string }
  | { source: 'advanced-search'; siteid: string; ispublic: string | number };

const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The service's users CSV answer as a bare body: status, content type, disposition, cookies and bytes as received. */
export function relayUsersCsv(serviceResponse: GatewayResponse<Buffer>): RawBody {
  const { status, headers, body, setCookies } = serviceResponse;
  const disposition = firstValue(headers['content-disposition']);
  return {
    status,
    // ACF labels every response with its HTML content type, so an answer without one reads as that.
    contentType: firstValue(headers['content-type']) ?? HTML_CONTENT_TYPE,
    body,
    ...(disposition === undefined ? {} : { headers: { 'content-disposition': disposition } }),
    ...(setCookies.length > 0 ? { setCookies: [...setCookies] } : {}),
  };
}
