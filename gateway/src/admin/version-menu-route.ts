// Internal route through which web reads the legacy server facts its admin nav Version menu prints.
import { serviceRole } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { components } from '../generated/openapi.js';
import type { VersionMenuClient } from '../session/bridge-client.js';

type LegacyVersionMenu = components['schemas']['LegacyVersionMenu'];

/** The signed bridge client the route reads through. */
export interface VersionMenuRouteDeps {
  versionMenu: VersionMenuClient;
}

const VERSION_MENU_URL = '/internal/v1/legacy-server/version-menu';

/** Registers `GET /internal/v1/legacy-server/version-menu` (`getLegacyVersionMenu`), callable by web only. */
export async function registerVersionMenuRoute(app: FastifyInstance, deps: VersionMenuRouteDeps): Promise<void> {
  app.get<{ Reply: LegacyVersionMenu }>(
    VERSION_MENU_URL,
    { config: { opt2: { transport: 'service', requires: [serviceRole('web')] } } },
    // A bridge failure propagates as the legacy 503 (fail closed).
    async () => deps.versionMenu.versionMenu(),
  );
}
