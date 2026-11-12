/** Registry of the programs-sites route modules; the site-monitor routes are re-exported for `app.ts` to register. */
import type { BaseEnv, Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { createImageSizesDomain } from '../domain/image-sizes.js';
import { createSitesDomain } from '../domain/sites.js';
import type { ProgramsSitesRepository } from '../repo/repository.js';
import { registerImageSizeRoutes } from './image-sizes.js';
import { registerJsonApiSiteRoutes } from './json-api-site.js';
import { registerSiteRoutes } from './sites.js';

export { registerSiteMonitorRoutes } from './sitemonitor.js';
export type { SiteMonitorRouteDeps } from './sitemonitor.js';
export type { ImageSizeRouteDeps } from './image-sizes.js';
export type { JsonApiSiteRouteDeps } from './json-api-site.js';
export type { SiteRouteDeps } from './sites.js';

/** Runtime dependencies shared by every programs-sites route module. */
export interface RouteDeps {
  db: TenantDb;
  repository: ProgramsSitesRepository;
  port: TaskPort;
  clock: Clock;
  serviceUrls: Record<string, string>;
  env: BaseEnv;
}

/** Registers the carried site, image size and JSON API `site` routes; `app.ts` registers the site-monitor routes after the outbox sweep. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const sites = createSitesDomain({ repo: deps.repository });
  const imageSizes = createImageSizesDomain({ repo: deps.repository });
  await registerSiteRoutes(app, { db: deps.db, sites });
  await registerImageSizeRoutes(app, { db: deps.db, imageSizes });
  await registerJsonApiSiteRoutes(app, { db: deps.db, repository: deps.repository, sites });
}
