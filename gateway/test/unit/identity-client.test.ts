// The identity client on the wire: the admin-site read's path, credentials and status mapping.
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import {
  IDENTITY_SERVICE,
  ServiceUnavailableError,
  createServiceClient,
  newRequestContext,
  runWithRequestContext,
  type ServiceClient,
} from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { createIdentityClient, type IdentityClient } from '../../src/session/identity-client.js';
import { sendJson, startHttpDouble, type HttpDouble } from '../helpers/http-double.js';

const GATEWAY_CREDENTIAL = 'Bearer gateway-invocation-credential';

let double: HttpDouble | undefined;
let service: ServiceClient | undefined;

afterEach(async () => {
  await service?.close();
  await double?.close();
  service = undefined;
  double = undefined;
});

/** An identity client whose identity is a double answering `status` with `body`, called with the gateway's credential. */
async function identityAnswering(status: number, body: unknown): Promise<{ identity: IdentityClient; double: HttpDouble }> {
  const started = await startHttpDouble((_req, res) => sendJson(res, status, body));
  double = started;
  service = createServiceClient({
    serviceUrls: { [IDENTITY_SERVICE]: started.url },
    self: 'gateway',
    credentials: { headersFor: async () => ({ [INVOCATION_HEADER]: GATEWAY_CREDENTIAL }) },
  });
  return { identity: createIdentityClient(service), double: started };
}

describe('createIdentityClient adminSite', () => {
  it('reads the encoded session admin site with the gateway credential and no user token', async () => {
    const { identity, double: received } = await identityAnswering(200, { siteId: 'tenant-a' });
    // The request in progress carries a user token, which identity must never receive.
    const context = { ...newRequestContext(), userToken: 'user-token-1' };

    const siteId = await runWithRequestContext(context, () => identity.adminSite('masacms_1/2 x'));

    expect(siteId).toBe('tenant-a');
    expect(received.requests).toHaveLength(1);
    const [request] = received.requests;
    expect(request?.method).toBe('GET');
    expect(request?.path).toBe('/internal/v1/sessions/masacms_1%2F2%20x/admin-site');
    expect(request?.headers[INVOCATION_HEADER]).toBe(GATEWAY_CREDENTIAL);
    expect(request?.headers.authorization).toBeUndefined();
  });

  it.each([401, 403, 404, 500, 503])('maps an identity HTTP %i to the legacy-shaped ServiceUnavailableError', async (status) => {
    const { identity } = await identityAnswering(status, { error: { code: 'x' } });

    const failure = identity.adminSite('S1');

    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject({ service: IDENTITY_SERVICE, cause: { code: `HTTP_${status}` } });
  });
});
