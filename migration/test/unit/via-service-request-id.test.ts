// Unit tests for the request id openWindowViaService sends, using a recording service client.
import {
  newRequestContext,
  REQUEST_ID_HEADER,
  runWithRequestContext,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { openWindowViaService } from '../../src/windows/via-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function recordingContext(): { ctx: { clientAs: () => ServiceClient; config: ReturnType<typeof loadConfig> }; sent: ServiceRequest[] } {
  const sent: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      sent.push(req);
      return Promise.resolve({ status: 200, headers: {}, body: { windowId: 'w-1' } as T });
    },
    close: () => Promise.resolve(),
  };
  return { ctx: { clientAs: () => client, config: loadConfig() }, sent };
}

describe('openWindowViaService', () => {
  it.each<[string, string | undefined]>([
    ['the active request id', 'ctx-1'],
    ['one fresh id outside a request', undefined],
  ])('sends %s as both the body requestId and X-Request-Id', async (_label, active) => {
    const { ctx, sent } = recordingContext();
    const open = () => openWindowViaService(ctx, { units: ['people.person'] });
    await (active === undefined ? open() : runWithRequestContext(newRequestContext({ requestId: active }), open));
    expect(sent).toHaveLength(1);
    const requestId = (sent[0]?.json as { requestId?: unknown } | undefined)?.requestId;
    expect(requestId).toEqual(active ?? expect.stringMatching(UUID));
    expect(sent[0]?.headers).toEqual({ [REQUEST_ID_HEADER]: requestId });
  });
});
