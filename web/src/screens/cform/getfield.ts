// cform.getField: the form-builder field bean JSON, relayed from strategies-content (server-only).
import { assertNotDenied } from '@/lib/gateway-client';
import { relayField } from '@/lib/request-context';
import type { RawBody, ScreenContext } from '../registry';

// Sent only when the request carries them, so the service applies the controller's StructKeyExists defaults.
const FIELD_PARAMS = ['fieldID', 'formID', 'fieldType'] as const;

/** `cform.getField`: the service's legacy JSON with its status and content type, bytes unchanged. */
export async function getField(ctx: ScreenContext): Promise<RawBody> {
  const { req } = ctx;
  const form = FIELD_PARAMS.flatMap((name) => Object.entries(relayField(req, name)));
  const response = await ctx.gateway.strategiesContent.raw('post', '/v1/raw/cform/getfield', {
    query: relayField(req, 'siteid'),
    form,
  });
  assertNotDenied(response, 'strategies-content', 'POST /v1/raw/cform/getfield');
  const contentType = response.headers['content-type'];
  return {
    status: response.status,
    // An answer without a content type is relayed with an empty one.
    contentType: (Array.isArray(contentType) ? contentType[0] : contentType) ?? '',
    body: response.body,
  };
}
