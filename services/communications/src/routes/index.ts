// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Registry of the communications route modules: fixture, `/v1/`, scheduled-task listing and scheduler hand-off routes. */
import type { BaseEnv, Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import { siteForTenant, tenantForRegisteredSite, type TenantDb } from '@opt2/platform/tenancy';
import type { DeliveryStatusSource } from '../domain/delivery-status.js';
import type { DomainDeps, MailDeps } from '../domain/delivery.js';
import type { MailTransport } from '../domain/mail-transport.js';
import type { SenderAddressSource } from '../domain/sender-address.js';
import type { SurveyScheduleDeps } from '../domain/survey-schedule.js';
import type { FixtureSiteLookup } from '../legacy/fixture-auth.js';
import type { CommunicationsRepository } from '../repo/repository.js';
import { registerAdoptionRoutes } from './adoption.js';
import { registerFixtureRoutes } from './fixture.js';
import { registerScheduledTaskRoutes } from './scheduled-tasks.js';
import { registerV1Routes } from './v1.js';

/** Runtime dependencies `app.ts` passes to the route registry: database, repository, clock, environment, mail ports and task port. */
export type RouteDeps = {
  db: TenantDb;
  repository: CommunicationsRepository;
  clock: Clock;
  env: BaseEnv;
  mail: MailTransport;
  deliveryStatus: DeliveryStatusSource;
  senderAddress: SenderAddressSource;
  taskPort: TaskPort;
};

/** The one context every communications route module receives: the runtime dependencies plus the prepared site lookup and domain deps. */
export type RouteContext = RouteDeps & {
  siteLookup: FixtureSiteLookup;
  domain: DomainDeps;
  mailDeps: MailDeps;
  scheduleDeps: SurveyScheduleDeps;
};

/** Registers the fixture, `/v1/`, scheduled-task and adoption routes; `app.ts` registers the platform, migration, event, sweep, reminder-task and queue routes. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const siteLookup: FixtureSiteLookup = {
    // Masa's siteExists then getSite(siteid).getSiteID(): the stored id of the registered site matching ignoring case,
    // read from communications.tenant_registry in one transaction so both lookups see the same registry row.
    registeredSite: (siteId) =>
      deps.db.withMetadata(async (tx) => {
        const tenantId = await tenantForRegisteredSite(tx, siteId);
        return tenantId === null ? undefined : ((await siteForTenant(tx, tenantId)) ?? undefined);
      }),
  };
  const domain: DomainDeps = { db: deps.db, repository: deps.repository, clock: deps.clock, logger: app.opt2.logger };
  const mailDeps: MailDeps = {
    ...domain,
    transport: deps.mail,
    deliveryStatus: deps.deliveryStatus,
    senderAddress: deps.senderAddress,
  };
  const scheduleDeps: SurveyScheduleDeps = { ...domain, taskPort: deps.taskPort, serviceUrls: deps.env.OPT2_SERVICE_URLS };
  const ctx: RouteContext = { ...deps, siteLookup, domain, mailDeps, scheduleDeps };

  await registerFixtureRoutes(app, ctx);
  await registerV1Routes(app, ctx);
  await registerScheduledTaskRoutes(app, ctx);
  await registerAdoptionRoutes(app, ctx);
}
