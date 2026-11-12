// cform.export: the form's zip download, built by strategies-content and relayed byte for byte (server-only).
import { assertNotDenied } from '@/lib/gateway-client';
import type { RawBody, ScreenContext } from '../registry';

const OPERATION = 'GET /v1/raw/cform/export';

// The handler sends these from `contentType` and `setCookies`; every other header goes through `headers`.
const OWN_FIELDS: ReadonlySet<string> = new Set(['content-type', 'set-cookie']);

/** The service's `cform.export` answer: status, zip bytes and headers as received; `contentid` sent when present. */
export async function exportForm(ctx: ScreenContext): Promise<RawBody> {
  const { siteid, contentid } = ctx.req.rc;
  // An absent contentid stays absent, so the service answers legacy's undefined-element error itself.
  const response = await ctx.gateway.strategiesContent.raw('get', '/v1/raw/cform/export', {
    query: { siteid, params: contentid === undefined ? {} : { contentid } },
  });
  assertNotDenied(response, 'strategies-content', OPERATION);
  // Names arrive lower-cased as undici reports them; a repeated header is joined as Fetch `Headers` joins it.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (!OWN_FIELDS.has(name)) headers[name] = [value].flat().join(', ');
  }
  return {
    status: response.status,
    contentType: [response.headers['content-type'] ?? []].flat()[0] ?? '',
    body: response.body,
    headers,
    ...(response.setCookies.length > 0 ? { setCookies: [...response.setCookies] } : {}),
  };
}
