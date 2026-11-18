// Legacy site registry for route keys and request-host binding: the ids and domains Masa's settingsManager holds, as the legacy bridge lists them.
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import { withUnsampledTrace } from '@opt2/platform/tracing';
import { REFRESH_INTERVAL_MS } from '../cutover/state.js';
import type { SiteBinding, SiteListing } from '../session/bridge-client.js';

/** Logger method the registry uses; Fastify's `app.log` satisfies it. */
export interface SiteRegistryLogger {
  error(obj: object, msg: string): void;
}

/** Collaborators of {@link createSiteRegistry}. */
export interface SiteRegistryDeps {
  /** Registered site ids and domain bindings, read from legacy (`site.cfm?op=list`). */
  list: () => Promise<SiteListing>;
  logger: SiteRegistryLogger;
}

/** The bindToDomain rule that bound a host: a domain or alias equal to it, one containing it, or the first-site fallback. */
export type SiteMatch = 'complete' | 'partial' | 'first';

/** A request host's site and the rule that bound it. */
export interface HostBinding {
  siteId: string;
  match: SiteMatch;
}

/** The last loaded legacy site registry and its refresh loop. */
export interface SiteRegistry {
  /** `settingsManager.siteExists` over the snapshot: ids match without case, as struct keys do; `''` never exists. */
  siteExists(siteId: string): boolean;
  /** contentServer `bindToDomain(isAdmin=true)` of utility `getRequestHost()` over the snapshot; undefined for `--none--` or no site. */
  bindToDomain(requestHost: string): HostBinding | undefined;
  /** Loads the snapshot, rejecting when that fails, then refreshes it, untraced, every `REFRESH_INTERVAL_MS` until `stop`. */
  start(): Promise<void>;
  stop(): void;
  /** Reloads the snapshot now; a failure rejects and keeps the previous snapshot. */
  refresh(): Promise<void>;
}

/** One loaded listing: the lower-cased site ids, the bindings in bind order and the admin domain. */
interface Snapshot {
  sites: ReadonlySet<string>;
  bindings: readonly SiteBinding[];
  adminDomain: string;
}

/** contentServer.bindToDomain(isAdmin=true) over `snapshot` (core/mura/content/contentServer.cfc:170-220); an empty host matches no domain. */
function bindHost(snapshot: Snapshot, requestHost: string): HostBinding | undefined {
  const checkDomain = cfListToArray(requestHost, ':')[0] ?? '';
  const { bindings } = snapshot;
  if (checkDomain !== '') {
    const domainsOf = (binding: SiteBinding): string[] => [binding.domain, ...binding.aliases];
    // settingsBean.isValidDomain: `complete` compares with CFML `==`, `partial` is a case-sensitive `find`.
    const complete = bindings.find((binding) => domainsOf(binding).some((domain) => cfEq(checkDomain, domain)));
    if (complete !== undefined) return { siteId: complete.siteId, match: 'complete' };
    const partial = bindings.find((binding) => domainsOf(binding).some((domain) => domain.includes(checkDomain)));
    if (partial !== undefined) return { siteId: partial.siteId, match: 'partial' };
  }
  // The admin domain binds `--none--`; any other host falls to the first site in bind order.
  if (cfEq(checkDomain, snapshot.adminDomain)) return undefined;
  const first = bindings[0];
  return first === undefined ? undefined : { siteId: first.siteId, match: 'first' };
}

/** Creates an empty registry; {@link SiteRegistry.start} loads it. */
export function createSiteRegistry(deps: SiteRegistryDeps): SiteRegistry {
  let snapshot: Snapshot = { sites: new Set(), bindings: [], adminDomain: '' };
  // A load started earlier never replaces the snapshot of one started later.
  let loadsStarted = 0;
  let appliedLoad = 0;
  let running = false;
  let loops = 0;
  let timer: NodeJS.Timeout | undefined;

  const refresh = async (): Promise<void> => {
    const load = ++loadsStarted;
    const listing = await deps.list();
    if (load < appliedLoad) return;
    appliedLoad = load;
    snapshot = {
      sites: new Set(listing.sites.map((id) => id.toLowerCase()).filter((id) => id !== '')),
      bindings: listing.bindings,
      adminDomain: listing.adminDomain,
    };
  };

  // A tick still running across stop() and start() belongs to the old loop and must not reschedule beside the new one.
  const scheduleRefresh = (loop: number): void => {
    timer = setTimeout(() => {
      void withUnsampledTrace(refresh)
        .catch((error: unknown) => {
          deps.logger.error({ error: serializeError(error) }, 'legacy site registry refresh failed; keeping the last snapshot');
        })
        .finally(() => {
          if (running && loop === loops) scheduleRefresh(loop);
        });
    }, REFRESH_INTERVAL_MS);
    timer.unref();
  };

  return {
    siteExists: (siteId) => snapshot.sites.has(siteId.toLowerCase()),

    bindToDomain: (requestHost) => bindHost(snapshot, requestHost),

    async start() {
      if (running) return;
      running = true;
      loops += 1;
      const loop = loops;
      try {
        await refresh();
      } catch (error) {
        if (loop === loops) running = false;
        throw error;
      }
      if (running && loop === loops) scheduleRefresh(loop);
    },

    stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },

    refresh,
  };
}
