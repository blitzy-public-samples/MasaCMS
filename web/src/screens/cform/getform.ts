// cform.getForm: strategies-content builds the form bean JSON; web relays its bytes unchanged (server-only).
import type { RawBody, ScreenContext } from '../registry';

/** Relays `cform.getForm`, forwarding `siteid` and, only when the request carries it, `formID`. */
export async function getForm(ctx: ScreenContext): Promise<RawBody> {
  const { siteid, formID } = ctx.req.rc;
  // The contract names the operation in lower case and takes the legacy fields as a form POST, as the form builder
  // sends them; the service applies the createUUID() default when formID is absent.
  const response = await ctx.gateway.strategiesContent.raw('post', '/v1/raw/cform/getform', {
    query: { siteid },
    form: formID === undefined ? {} : { formID },
  });
  const contentType = response.headers['content-type'];
  return {
    status: response.status,
    contentType: typeof contentType === 'string' ? contentType : (contentType?.[0] ?? ''),
    body: response.body,
  };
}
