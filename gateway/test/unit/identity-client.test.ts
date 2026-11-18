// The identity client on the wire: the admin-site and admin-state reads' and the admin-state import's paths, credentials and status mapping.
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

/** The admin-state flat view arguments of one site, as strategies-content stores them under `mura`. */
const ADMIN_STATE = { siteid: 'tenant-a', mura: { flatViewArgs: { 'tenant-a': { tab: 1 } } } };

/** The values a legacy request changed, as the carry imports them. */
const IMPORTED = { siteid: 'tenant-b', mura: { nextN: '5' } };

describe.each<{
  op: 'adminSite' | 'adminState' | 'importAdminState';
  method: 'GET' | 'POST';
  segment: string;
  sent: unknown;
  answer: unknown;
  result: unknown;
}>([
  { op: 'adminSite', method: 'GET', segment: 'admin-site', sent: undefined, answer: { siteId: 'tenant-a' }, result: 'tenant-a' },
  { op: 'adminState', method: 'GET', segment: 'admin-state', sent: undefined, answer: ADMIN_STATE, result: ADMIN_STATE },
  { op: 'importAdminState', method: 'POST', segment: 'admin-state', sent: IMPORTED, answer: { ...ADMIN_STATE, ...IMPORTED }, result: { ...ADMIN_STATE, ...IMPORTED } },
])('createIdentityClient $op', ({ op, method, segment, sent, answer, result }) => {
  const invoke = (identity: IdentityClient, sessionId: string): Promise<unknown> =>
    op === 'importAdminState' ? identity.importAdminState(sessionId, IMPORTED) : identity[op](sessionId);

  it(`sends ${method} to the encoded session's ${segment} with the gateway credential and no user token`, async () => {
    const { identity, double: received } = await identityAnswering(200, answer);
    // The request in progress carries a user token, which identity must never receive.
    const context = { ...newRequestContext(), userToken: 'user-token-1' };

    const read = await runWithRequestContext(context, () => invoke(identity, 'masacms_1/2 x'));

    expect(read).toEqual(result);
    expect(received.requests).toHaveLength(1);
    const [request] = received.requests;
    expect(request?.method).toBe(method);
    expect(request?.path).toBe(`/internal/v1/sessions/masacms_1%2F2%20x/${segment}`);
    expect(request?.body.length === 0 ? undefined : JSON.parse(request?.body.toString('utf8') ?? '')).toEqual(sent);
    expect(request?.headers[INVOCATION_HEADER]).toBe(GATEWAY_CREDENTIAL);
    expect(request?.headers.authorization).toBeUndefined();
  });

  it.each([401, 403, 404, 500, 503])('maps an identity HTTP %i to the legacy-shaped ServiceUnavailableError', async (status) => {
    const { identity } = await identityAnswering(status, { error: { code: 'x' } });

    const failure = invoke(identity, 'S1');

    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject({ service: IDENTITY_SERVICE, cause: { code: `HTTP_${status}` } });
  });
});
