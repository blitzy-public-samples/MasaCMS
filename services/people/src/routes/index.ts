/** Registry of the people route modules; `app.ts` registers the migration, push, outbox-sweep and task-queue routes. */
import type { Logger } from '@opt2/platform/logging';
import type { BaseEnv, Clock, FastifyInstance, ServiceClient } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { AddressDeps } from '../domain/addresses.js';
import type { ArchiveDeps } from '../domain/archive.js';
import type { FaultHooks } from '../domain/faults.js';
import { personFence, type RosterDeps } from '../domain/roster-protocol.js';
import type { SearchDeps } from '../domain/search.js';
import type { PeopleEvents } from '../events/publish.js';
import { createContentClient } from '../legacy/content-client.js';
import type { IdentityClient } from '../legacy/identity-client.js';
import type { PeopleRepository } from '../repo/repository.js';
import { registerAdminDownloadRoutes, type SearchCriteriaReader } from './admin-downloads.js';
import { registerAdminProfileRoutes } from './admin-profile.js';
import { registerAdminRosterRoutes } from './admin-roster.js';
import { registerAdminUserRoutes, storedCriteria } from './admin-users.js';
import { registerFixtureArchiveRoutes } from './fixture-archive.js';
import { registerLegacyApiRoutes } from './legacy-api.js';

// `logger` and `env` complete the shape `app.ts` passes; no route module or domain operation reads them yet.
/** Runtime dependencies `app.ts` passes to the route registry. */
export type RouteDeps = {
  repository: PeopleRepository;
  events: PeopleEvents;
  db: TenantDb;
  clock: Clock;
  logger: Logger;
  client: ServiceClient;
  identity: IdentityClient;
  env: BaseEnv;
  faults: FaultHooks;
};

/** Builds people's domain dependencies once and registers every people route module on `app`. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { repository: repo, events, db, clock, identity, faults } = deps;
  // userDAO.read joins the photo's tfiles row; strategies-content owns tfiles, so the lookup is its API.
  const { photoFileExts } = createContentClient(deps.client);

  const search: SearchDeps = { db, repo, identity, clock, photoFileExts };
  const roster: RosterDeps = { db, repo, identity, events, clock, faults };
  const addresses: AddressDeps = { db, repo, clock, fence: personFence };
  const archive: ArchiveDeps = { db, repo, events, clock, fence: personFence };
  // getAdvancedSearch(session, …) reads the criteria the cUsers advanced search stored in the forwarded token's session.
  const searchCriteria: SearchCriteriaReader = { read: async () => storedCriteria(await identity.adminSessionState()) };

  await registerAdminUserRoutes(app, { db, repository: repo, identity, clock, photoFileExts });
  await registerAdminDownloadRoutes(app, { search, searchCriteria });
  await registerAdminRosterRoutes(app, { roster });
  await registerAdminProfileRoutes(app, { roster });
  await registerLegacyApiRoutes(app, { db, repository: repo, identity, clock, roster, search, addresses });
  await registerFixtureArchiveRoutes(app, { archive, identity });
}
