import type { components } from '@/generated/clients/strategies-content';
import type { GatewayResponse } from '@/lib/gateway-client';

type RawLegacyJson = components['schemas']['RawLegacyJson'];

export const SEARCH_SITE_DATA_QUERY = { searchString: 'tenant', siteid: 'default' } as const;

export const SEARCH_SITE_DATA_EMPTY_QUERY = { searchString: 'zzz-no-match', siteid: 'default' } as const;

// Content type as the contract declares it, which the relay also falls back to.
export const searchSiteDataMatchesRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': 'application/json' },
  body: '[{"id":"tenant-a","value":"Tenant A"},{"id":"tenant-b","value":"Tenant B"}]',
  setCookies: [],
} as const satisfies GatewayResponse<string>;

export const searchSiteDataEmptyRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': 'application/json' },
  body: '[]',
  setCookies: [],
} as const satisfies GatewayResponse<string>;

export const searchSiteDataMatchesDecoded = [
  { id: 'tenant-a', value: 'Tenant A' },
  { id: 'tenant-b', value: 'Tenant B' },
] as const satisfies RawLegacyJson;

export const searchSiteDataEmptyDecoded = [] as const satisfies RawLegacyJson;
