// The gateway relay that marks consumed CSRF tokens used in the mapped legacy session (sessionUserFacade.cfc:211-229).
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  ServiceUnavailableError,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeRelay, GATEWAY_SERVICE, type LegacyUsedToken } from '../../src/legacy/bridge-relay.js';

const TOKEN_A = 'A1'.repeat(16);
const TOKEN_B = 'B2'.repeat(16);
const ONE_TOKEN: readonly LegacyUsedToken[] = [{ token: TOKEN_A, usedAt: new Date(Date.UTC(2026, 5, 30, 12)) }];

/** A ServiceClient that records each request and answers every one with `status`, or with `answer` when given. */
function recordingClient(status: number, answer?: () => Promise<ServiceResponse>): {
  client: ServiceClient;
  requests: ServiceRequest[];
} {
  const requests: ServiceRequest[] = [];
  const request = vi.fn(async (req: ServiceRequest) => {
    requests.push(req);
    return answer === undefined ? { status, headers: {}, body: undefined } : answer();
  });
  return { client: { request, close: async () => {} } as ServiceClient, requests };
}

describe('createBridgeRelay', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('addresses the gateway by its OPT2_SERVICE_URLS key', () => {
    expect(GATEWAY_SERVICE).toBe('gateway');
  });

  it('posts the tokens to the encoded sid with usedAt in the legacy server zone', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const { client, requests } = recordingClient(204);
    const tokens: LegacyUsedToken[] = [
      { token: TOKEN_A, usedAt: new Date(Date.UTC(2026, 5, 30, 14, 8, 9, 456)) },
      { token: TOKEN_B, usedAt: new Date(Date.UTC(2026, 0, 3, 7, 59, 1)) },
    ];

    await createBridgeRelay(client).markUsed('CF/ID 1:2?#%', tokens);

    expect(requests).toEqual([
      {
        service: 'gateway',
        method: 'POST',
        path: '/internal/v1/legacy-sessions/CF%2FID%201%3A2%3F%23%25:mark-used',
        json: {
          tokens: [
            { token: TOKEN_A, usedAt: '2026-06-30T07:08:09' },
            { token: TOKEN_B, usedAt: '2026-01-02T23:59:01' },
          ],
        },
      },
    ]);
  });

  it('sets no user token and no Authorization header', async () => {
    const { client, requests } = recordingClient(204);
    await createBridgeRelay(client).markUsed('S-1', ONE_TOKEN);
    expect(requests[0]).not.toHaveProperty('userToken');
    expect(requests[0]?.headers?.authorization ?? requests[0]?.headers?.Authorization).toBeUndefined();
  });

  it.each([
    [200, true],
    [204, true],
    [404, false],
  ])('maps HTTP %i to applied=%s', async (status, applied) => {
    const { client } = recordingClient(status);
    await expect(createBridgeRelay(client).markUsed('S-1', ONE_TOKEN)).resolves.toEqual({ applied });
  });

  it.each([502, 503, 504])('rejects HTTP %i with the legacy-503 ServiceUnavailableError', async (status) => {
    const { client } = recordingClient(status);
    const failure = await createBridgeRelay(client).markUsed('S-1', ONE_TOKEN).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(failure).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(failure).toMatchObject({ service: 'gateway', message: `Service gateway unavailable (HTTP_${status})` });
  });

  it.each([400, 401, 403, 500])('fails fast on unexpected HTTP %i with a plain Error naming it', async (status) => {
    const { client } = recordingClient(status);
    const failure = await createBridgeRelay(client).markUsed('S-1', ONE_TOKEN).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(LegacyServiceUnavailableError);
    expect((failure as Error).message).toContain(`HTTP ${status}`);
  });

  it('propagates a ServiceUnavailableError raised by the client', async () => {
    const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const unreachable = new ServiceUnavailableError('gateway', refused);
    const { client, requests } = recordingClient(204, () => Promise.reject(unreachable));
    await expect(createBridgeRelay(client).markUsed('S-1', ONE_TOKEN)).rejects.toBe(unreachable);
    expect(requests).toHaveLength(1);
  });

  it('answers an empty token list as applied without calling the gateway', async () => {
    const { client, requests } = recordingClient(503);
    await expect(createBridgeRelay(client).markUsed('S-1', [])).resolves.toEqual({ applied: true });
    expect(requests).toHaveLength(0);
  });
});
