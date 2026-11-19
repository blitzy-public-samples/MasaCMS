// Unit tests for the Version menu facts read through the gateway's getLegacyVersionMenu.
import { describe, expect, it } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError, LEGACY_VERSION_MENU_PATH } from '@/lib/gateway-client';
import { loadLegacyServerInfo } from '@/shell/legacy-server';
import { LEGACY_VERSION_MENU } from '../fixtures/gateway/version-menu';
import { fakeGatewayClient, routeKey, type FakeReply } from '../helpers/fake-gateway';

const VERSION_MENU = routeKey('GET', 'gateway', LEGACY_VERSION_MENU_PATH);

describe('loadLegacyServerInfo', () => {
  it.each([
    { name: "the oracle's facts, an absent Java key as empty text", menu: LEGACY_VERSION_MENU, expected: { ...LEGACY_VERSION_MENU, javaVersion: '' } },
    {
      name: 'a Java version and absent OS keys as empty text',
      menu: { ...LEGACY_VERSION_MENU, javaVersion: '11.0.2', osName: null, osVersion: null },
      expected: { ...LEGACY_VERSION_MENU, javaVersion: '11.0.2', osName: '', osVersion: '' },
    },
  ])('reads $name from the gateway on each call', async ({ menu, expected }) => {
    const gateway = fakeGatewayClient({ [VERSION_MENU]: { status: 200, body: menu } }, { userToken: 'user-token', requestId: 'req-1' });
    expect(await loadLegacyServerInfo(gateway)).toEqual(expected);
    expect(await loadLegacyServerInfo(gateway)).toEqual(expected);
    // The gateway's own call acts for no user.
    const call = { service: 'gateway', method: 'GET', path: LEGACY_VERSION_MENU_PATH, requestId: 'req-1' };
    expect(gateway.calls).toEqual([call, call]);
  });

  it.each<{ name: string; reply: FakeReply; error: new (...args: never[]) => Error }>([
    { name: 'refuses web with 401', reply: { status: 401, body: {} }, error: GatewayDenialError },
    { name: 'refuses web with 403', reply: { status: 403, body: {} }, error: GatewayDenialError },
    { name: 'answers 503 for an unreachable bridge', reply: { status: 503, body: {} }, error: GatewayUnavailableError },
    { name: 'answers 500', reply: { status: 500, body: {} }, error: Error },
  ])('rejects when the gateway $name', async ({ reply, error }) => {
    const gateway = fakeGatewayClient({ [VERSION_MENU]: reply });
    await expect(loadLegacyServerInfo(gateway)).rejects.toBeInstanceOf(error);
  });

  it('lets an unreachable gateway propagate', async () => {
    const gateway = fakeGatewayClient({ [VERSION_MENU]: { status: 200, body: LEGACY_VERSION_MENU } });
    gateway.failWith();
    await expect(loadLegacyServerInfo(gateway)).rejects.toMatchObject({ name: 'GatewayUnavailableError', service: 'gateway' });
  });
});
