/** Site-monitor step "Remote feed imports": the Cloud Tasks route that runs feedManager.doAutoImport for one registered site. */
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { StoragePort } from '@opt2/platform/storage';
import { registerTaskRoute, type TaskContext } from '@opt2/platform/tasks';
import { registryEntryForTenant, tenantForRegisteredSite, type TenantDb } from '@opt2/platform/tenancy';
import type { ContentConfig, SiteContentSettings } from '../domain/context.js';
import { defaultFetchRemote, doAutoImport, type AutoImportArgs, type FetchRemote } from '../domain/feeds.js';
import type { components } from '../generated/openapi.js';
import type { ContentRepository } from '../repo/repository.js';

type SiteMonitorStepPayload = components['schemas']['SiteMonitorStepPayload'];
type JobResult = components['schemas']['JobResult'];

/** Path of the step; the `content-feed-import` queue's target path. */
export const FEED_AUTO_IMPORT_PATH = '/internal/v1/jobs/feed-auto-import' as const;

/** What the step runs against; `fetchRemote` and `siteFor` replace the default fetch and the registry-derived site settings. */
export interface FeedAutoImportDeps {
  db: TenantDb;
  repository: ContentRepository;
  clock: Clock;
  config: ContentConfig;
  /** Part of the job-route wiring; feed imports store no upload. */
  storage: StoragePort;
  fetchRemote?: FetchRemote;
  siteFor?: AutoImportArgs['siteFor'];
}

/** The step's site: the `siteid` query parameter the dispatcher sends, else the payload's `siteId`. */
function stepSiteId(ctx: TaskContext): string {
  const query = ctx.request.query as Record<string, unknown>;
  const payload = ctx.payload as Partial<SiteMonitorStepPayload> | null;
  const siteId = query.siteid || payload?.siteId;
  if (typeof siteId !== 'string' || siteId === '') throw new LegacyApiError('badRequest');
  return siteId;
}

// strategies-content holds no tsettings projection: the registry supplies the site's identity, primary domain and file
// pool, and every other setting takes its empty value or the legacy default its type documents. Callers holding the
// real settings pass `siteFor`.
/** The settings content saves read for `siteId`, registered as `tenantId`. */
export async function registrySite(db: TenantDb, tenantId: string, siteId: string): Promise<SiteContentSettings> {
  const entry = await registryEntryForTenant(db, tenantId);
  const domain = entry?.domains[0] ?? '';
  return {
    siteId,
    site: '',
    locking: 'None',
    contentApprovalScript: '',
    contentRejectionScript: '',
    contentPendingScript: '',
    contentCanceledScript: '',
    contactEmail: '',
    urls: {
      siteId,
      scheme: 'http',
      domain,
      requestDomain: domain,
      previewDomain: '',
      serverPort: '',
      context: '',
      siteIdInUrls: false,
      indexFileInUrls: false,
      hashUrls: false,
      useSSL: false,
      // settingsBean getFilePoolID: the site itself when no pool is set.
      filePoolId: entry?.filePoolId || siteId,
      configFileAssetPath: '',
      assetPath: '',
      siteAssetPath: '',
      fileStore: 'fileDir',
      legacyIndexFileLocation: false,
      urlTitleDelim: '-',
      allowUnicodeInFilenames: false,
      placeholderImgId: '',
      placeholderImgExt: '',
      directImages: true,
    },
  };
}

/** Registers POST `FEED_AUTO_IMPORT_PATH`, answering only after every autoimport remote feed of the site is imported. */
export function registerFeedAutoImport(app: FastifyInstance, deps: FeedAutoImportDeps): void {
  registerTaskRoute(app, FEED_AUTO_IMPORT_PATH, {
    scope: 'system',
    handler: async (ctx): Promise<JobResult> => {
      const siteId = stepSiteId(ctx);
      // The tenant comes from the site registry, never from the task body.
      const tenantId = await tenantForRegisteredSite(deps.db, siteId);
      if (tenantId === null) throw new LegacyApiError('badRequest');
      // feedManager.doAutoImport
      const result = await doAutoImport({
        db: deps.db,
        repository: deps.repository,
        clock: deps.clock,
        config: deps.config,
        siteId,
        fetchRemote: deps.fetchRemote ?? defaultFetchRemote,
        siteFor: deps.siteFor ?? ((registered) => registrySite(deps.db, tenantId, registered)),
        requestId: ctx.request.id,
      });
      return { step: 'feedAutoImport', siteId: result.siteId, feeds: result.imports.length };
    },
  });
}
