// Internal route through which web reads the installed plugins its Global Settings Plugins tab lists.
import { serviceRole } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { components } from '../generated/openapi.js';
import type { PluginListClient } from '../session/bridge-client.js';

type LegacyPlugins = components['schemas']['LegacyPlugins'];

/** The signed bridge client the route reads through. */
export interface PluginsRouteDeps {
  plugins: PluginListClient;
}

const PLUGINS_URL = '/internal/v1/legacy-server/plugins';

/** Registers `GET /internal/v1/legacy-server/plugins` (`getLegacyPlugins`), callable by web only. */
export async function registerPluginsRoute(app: FastifyInstance, deps: PluginsRouteDeps): Promise<void> {
  app.get<{ Reply: LegacyPlugins }>(
    PLUGINS_URL,
    { config: { opt2: { transport: 'service', requires: [serviceRole('web')] } } },
    // A bridge failure propagates as the legacy 503 (fail closed).
    async () => ({ plugins: await deps.plugins.plugins() }),
  );
}
