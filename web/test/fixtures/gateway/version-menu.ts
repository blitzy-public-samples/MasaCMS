import type { components } from '@/generated/clients/gateway';

type LegacyVersionMenu = components['schemas']['LegacyVersionMenu'];

/** `getLegacyVersionMenu` as the gateway answers it from the ACF 2023 oracle, which has no `server.java`. */
export const LEGACY_VERSION_MENU: Readonly<LegacyVersionMenu> = Object.freeze({
  appServerProductName: 'ColdFusion Server',
  appServerVersion: '2023,0,26,331018',
  dbProductName: 'Microsoft SQL Server',
  dbProductVersion: 'Microsoft SQL Server 2022 - 16.0.4305.5',
  javaVersion: null,
  osName: 'UNIX',
  osVersion: '6.12.105+',
});
