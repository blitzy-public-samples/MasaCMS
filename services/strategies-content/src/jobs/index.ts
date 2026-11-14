/** Registration entry of the strategies-content site-monitor step routes, which the programs-sites orchestrator invokes. */
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { StoragePort } from '@opt2/platform/storage';
import type { TenantDb } from '@opt2/platform/tenancy';
import { CONTENT_CONFIG_DEFAULTS, type ContentConfig } from '../domain/context.js';
import type { FetchRemote } from '../domain/feeds.js';
import type { ContentRepository } from '../repo/repository.js';
import { FEED_AUTO_IMPORT_PATH, registerFeedAutoImport, registrySite, type FeedAutoImportDeps } from './feed-auto-import.js';
import {
  PUBLISH_SCHEDULED_CHANGESETS_PATH,
  registerPublishScheduledChangesets,
  type PublishScheduledChangesetsDeps,
} from './publish-scheduled-changesets.js';

export { FEED_AUTO_IMPORT_PATH, PUBLISH_SCHEDULED_CHANGESETS_PATH, registerFeedAutoImport, registerPublishScheduledChangesets };
export type { FeedAutoImportDeps, PublishScheduledChangesetsDeps };

/** What the job routes run against; the optional fields replace the app's pool, the configBean defaults, the remote fetch and the site settings. */
export interface JobRouteDeps {
  repository: ContentRepository;
  clock: Clock;
  storage: StoragePort;
  db?: TenantDb;
  config?: ContentConfig;
  fetchRemote?: FetchRemote;
  siteFor?: FeedAutoImportDeps['siteFor'];
}

/** Registers POST `PUBLISH_SCHEDULED_CHANGESETS_PATH` and POST `FEED_AUTO_IMPORT_PATH`; throws at start-up when neither `deps` nor the app holds a database. */
export function registerJobRoutes(app: FastifyInstance, deps: JobRouteDeps): void {
  const db = deps.db ?? app.opt2.db;
  if (db === undefined) throw new Error('strategies-content job routes need a database');
  const config = deps.config ?? CONTENT_CONFIG_DEFAULTS;
  const { repository, clock, siteFor } = deps;
  // strategies-content holds no tsettings projection, so both steps read one source of site settings: the caller's
  // siteFor, else the registry-derived settings the feed step builds.
  const publishSiteFor: PublishScheduledChangesetsDeps['siteFor'] =
    siteFor === undefined ? (tenantId, siteId) => registrySite(db, tenantId, siteId) : (_tenantId, siteId) => siteFor(siteId);
  registerPublishScheduledChangesets(app, { db, repository, clock, config, siteFor: publishSiteFor });
  registerFeedAutoImport(app, { db, repository, clock, config, storage: deps.storage, fetchRemote: deps.fetchRemote, siteFor });
}
