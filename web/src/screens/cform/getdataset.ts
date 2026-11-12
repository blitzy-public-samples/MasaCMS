// `cform.getDataset`: the form-builder dataset JSON, built by strategies-content and relayed unchanged (server-only).
import type { RawBody, ScreenContext } from '../registry';

const OPERATION = 'POST /v1/raw/cform/getdataset';

// The service applies legacy's `createUUID()` default to an absent or empty `datasetID`, so web forwards it as sent.
const FORWARDED_FIELDS = ['datasetID', 'fieldID'] as const;

/** The service's status, content type and JSON bytes for `cform.getdataset`, unparsed so legacy's key case survives. */
export async function getDataset(ctx: ScreenContext): Promise<RawBody> {
  const { rc } = ctx.req;
  const form = FORWARDED_FIELDS.flatMap((name): Array<[string, string]> => {
    const value = rc[name];
    return value === undefined ? [] : [[name, value]];
  });
  const response = await ctx.gateway.strategiesContent.raw('post', '/v1/raw/cform/getdataset', {
    query: { siteid: rc.siteid },
    form,
  });
  const contentType = [response.headers['content-type'] ?? []].flat()[0];
  if (contentType === undefined) {
    throw new Error(`${OPERATION} answered HTTP ${response.status} without a content type`);
  }
  return { status: response.status, contentType, body: response.body };
}
