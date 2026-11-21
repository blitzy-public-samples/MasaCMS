// Legacy runtime facts of the nav Version menu, read through the gateway (server-only).
import { okBody, type GatewayClient } from '@/lib/gateway-client';
import type { LegacyServerInfo } from './types';

/**
 * The Version menu facts of the legacy server, read on each call through the gateway's `getLegacyVersionMenu`; an absent
 * Java or OS key reads as `''`. Gateway unavailability propagates.
 * @throws GatewayDenialError When the gateway refuses the read (401 or 403).
 * @throws Error For any other non-2xx answer.
 */
export async function loadLegacyServerInfo(gateway: GatewayClient): Promise<LegacyServerInfo> {
  const menu = okBody(await gateway.legacyVersionMenu(), 'gateway', 'getLegacyVersionMenu');
  return { ...menu, javaVersion: menu.javaVersion ?? '', osName: menu.osName ?? '', osVersion: menu.osVersion ?? '' };
}
