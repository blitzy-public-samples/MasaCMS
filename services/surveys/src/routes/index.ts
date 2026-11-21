// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Registry of the surveys route modules: fixture, `/v1/surveys` and reminder-sent routes. */
import type { BaseEnv, Clock, FastifyInstance } from '@opt2/platform/service-kit';
import { siteForTenant, tenantForRegisteredSite, type TenantDb } from '@opt2/platform/tenancy';
import type { FixtureSiteLookup } from '../legacy/fixture-auth.js';
import type { SurveysRepository } from '../repo/repository.js';
import { registerFixtureRoutes } from './fixture.js';
import { registerRemindRoutes } from './remind.js';
import { registerV1Routes } from './v1.js';

/** Runtime dependencies shared by every surveys route module; assignable to the domain's `DomainDeps`. */
export type RouteDeps = { db: TenantDb; repository: SurveysRepository; clock: Clock; env: BaseEnv };

/** Registers the surveys fixture, `/v1/surveys` and reminder-sent routes; `app.ts` registers the platform and launch task routes. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const siteLookup: FixtureSiteLookup = {
    // Masa's siteExists then getSite(siteid).getSiteID(): the stored id of the registered site matching ignoring case,
    // read from surveys.tenant_registry in one transaction so both lookups see the same registry row.
    registeredSite: (siteId) =>
      deps.db.withMetadata(async (tx) => {
        const tenantId = await tenantForRegisteredSite(tx, siteId);
        return tenantId === null ? undefined : ((await siteForTenant(tx, tenantId)) ?? undefined);
      }),
  };
  await registerFixtureRoutes(app, { ...deps, siteLookup });
  await registerV1Routes(app, deps);
  await registerRemindRoutes(app, { ...deps, siteLookup });
}
