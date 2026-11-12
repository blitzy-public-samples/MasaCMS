// cform.getFieldType: the field-type JSON strategies-content builds, relayed unchanged (server-only).
import { assertNotDenied } from '@/lib/gateway-client';
import type { RawBody, ScreenContext } from '../registry';

/** The `fieldTypeBean.getAsJSON()` answer, forwarding only the `fieldTypeID` and `fieldType` the request carries. */
export async function getFieldType(ctx: ScreenContext): Promise<RawBody> {
  const { rc } = ctx.req;
  // An empty value is forwarded too: legacy defaults only absent keys (StructKeyExists), and the service applies them.
  const params: Record<string, string> = {};
  if (rc.fieldTypeID !== undefined) params.fieldTypeID = rc.fieldTypeID;
  if (rc.fieldType !== undefined) params.fieldType = rc.fieldType;
  const response = await ctx.gateway.strategiesContent.raw('get', '/v1/raw/cform/getfieldtype', {
    query: { siteid: rc.siteid, params },
  });
  assertNotDenied(response, 'strategies-content', 'GET /v1/raw/cform/getfieldtype');
  return {
    status: response.status,
    contentType: [response.headers['content-type'] ?? ''].flat().join(', '),
    body: response.body,
  };
}
